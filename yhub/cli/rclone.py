"""rclone mounts: mount remotes from the rclone config as local directories, and watch the mounts themselves.

Three design rules (all trade-offs, written down so nobody reverts them):

1. **Never store the password.** A remote that needs one (typically a crypt node: the config has only
   ``remote`` and no ``password``) gets it from the user **at mount time**, passed to rclone through
   the **process environment** ``RCLONE_CONFIG_<REMOTE>_PASSWORD`` only — not on disk, not in argv
   (argv is world-readable in ``ps``), not in logs, not in the state file. Once mounted we no longer
   hold it.
2. **Never guess past the password.** With no password in hand, watching looks at the mount itself
   only: the mount table, whether the process is still alive, and (via a subprocess with a timeout)
   one read of the root dir and capacity. **Never re-ask the remote** — that would require the
   password again, which amounts to keeping it in the backend.
3. **Generic.** Any remote (crypt / smb / s3 / a local path / anything else) can be mounted; the
   mount point defaults to ``~/<name>`` and can be set per remote; one remote mounts at one point at a
   time (umount first to move it).
"""

from __future__ import annotations

import configparser
import getpass
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import shlex

from yhub.i18n import tr

from .env import ensure_path
from .rclone_obscure import looks_obscured, obscure

ensure_path()

LOG = logging.getLogger("yhub.rclone")


def _config_dir() -> Path:
    """Config root: same fallbacks as the shell / settings.py.

    Parent of `YHUB_SETTINGS_FILE` > `YHUB_CONFIG_DIR` > `~/.config/yhub`.
    The acceptance script (packaging/verify-backend.sh) uses `YHUB_CONFIG_DIR` to move state files
    into a temp dir under build/ — ignoring these two env vars would make it write to the user's real
    `~/.config/yhub/rclone.state.json`.
    """
    explicit = os.environ.get("YHUB_SETTINGS_FILE", "").strip()
    if explicit:
        parent = Path(explicit).expanduser().parent
        if str(parent):
            return parent
    raw = os.environ.get("YHUB_CONFIG_DIR", "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".config" / "yhub"


def state_path() -> Path:
    """State file path: **computed on every call** (follows the env vars), not a constant fixed at import.

    Fixing it at import burned us once (2026-09-29): setting `YHUB_CONFIG_DIR` after the import
    (acceptance scripts and throwaway harnesses love doing that) still wrote the **user's real**
    `~/.config/yhub/rclone.state.json` — a repro script of mine wrote a `c1` record into the user's
    state file and left a real mount behind. Rule: temp environments set the env vars **before**
    importing.
    """
    return _config_dir() / "rclone.state.json"
RCLONE_CONFIG_PATH = Path.home() / ".config" / "rclone" / "rclone.conf"
DEFAULT_MOUNT_ROOT = Path.home()
TICK_SECONDS = 15
MOUNT_TABLE_TTL_SECONDS = 1.0
PROBE_EVERY_SECONDS = 60
# The first minute after mounting: rclone's SMB/VFS session is still warming up and reading the mount
# point blocks (measured: 8s before it works). So (1) a mount only counts as ready once it can be
# read, and (2) probe failures during warmup do not count as "wedged".
WARMUP_SECONDS = 60
READY_READ_TIMEOUT_SECONDS = 60
PROBE_TIMEOUT_SECONDS = 15
# How long a user-triggered "probe" waits; if it takes longer, say "still running". Request paths never wait.
PROBE_WAIT_SECONDS = 5.0
# An in-flight probe older than this counts as "stuck" (a normal read takes tens of ms; warmup ~10s)
PROBE_STUCK_SECONDS = PROBE_TIMEOUT_SECONDS * 2
MOUNT_READY_TIMEOUT_SECONDS = 12
DAEMON_WAIT = "3s"  # only wait for rclone to mount; "can it be read" is the readiness read below
#: The VFS cache mode is a **fixed setting**, not a user choice: picking wrong only buys hard-to-
#: diagnose weirdness (e.g. `off` truncating large reads halfway and failing writes outright), while
#: `writes` is the most stable spot between "reads, writes, no memory blow-up". To change it, put it
#: in the extra args (`--vfs-cache-mode off`) — that is the escape hatch.
VFS_CACHE_MODE = "writes"

#: The extra-args gate: flags only (no positionals), with caps on length and count, and it **rejects
#: the switches that would put a password into argv** (hard rule: a password must appear nowhere).
MOUNT_EXTRA_MAX_ARGS = 32
MOUNT_EXTRA_MAX_LEN = 200
MOUNT_EXTRA_DENY = (
    "--password",  # covers --password-command: the password may only travel via the environment
    "--config",  # swapping the config desyncs "remote" from the state file
    "--daemon",  # we own daemonisation and the wait
    "--volname",  # we use the volume name to label the remote
    "--rc",  # would open a local HTTP control port for no reason
)
MAX_NAMES = 12

_MOUNT_LINE_RE = re.compile(r"^(?P<source>.+?) on (?P<point>.+?) \((?P<opts>[^)]*)\)\s*$")


class RcloneError(Exception):
    """Plain-words error: ``message`` is for the user, ``hint`` says what to do (the adapter turns it into a ToolError)."""

    def __init__(self, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint


# ---------------------------------------------------------------- config and its remotes


def config_path() -> Path:
    """rclone config file: honours ``RCLONE_CONFIG`` like rclone itself."""
    env = os.environ.get("RCLONE_CONFIG")
    return Path(env).expanduser() if env else RCLONE_CONFIG_PATH


def rclone_bin() -> str | None:
    env_bin = (
        os.environ.get("YHUB_RCLONE_PATH")
        or os.environ.get("RCLONE_BIN")
        or os.environ.get("RCLONE_PATH")
    )
    if env_bin and os.path.isfile(env_bin) and os.access(env_bin, os.X_OK):
        return env_bin
    found = shutil.which("rclone")
    if found:
        return found
    # Candidate fallbacks (in case PATH missed them for some reason)
    for candidate in [
        "/opt/homebrew/bin/rclone",
        "/usr/local/bin/rclone",
        str(Path.home() / ".local" / "bin" / "rclone"),
        str(Path.home() / ".cargo" / "bin" / "rclone"),
    ]:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            parent_str = str(Path(candidate).parent)
            current_path = os.environ.get("PATH", "")
            if parent_str not in current_path.split(os.pathsep):
                os.environ["PATH"] = f"{parent_str}{os.pathsep}{current_path}"
            return candidate
    return None


def _sep() -> str:
    """Separator for joining name lists in one line ("、" in Chinese, ", " in English)."""
    return tr("cli.rclone.name_sep")


def _require_rclone() -> str:
    path = rclone_bin()
    if path is None:
        raise RcloneError(
            tr("cli.rclone.not_installed"),
            hint=tr("cli.rclone.not_installed_hint"),
        )
    return path


def rclone_version() -> str:
    path = rclone_bin()
    if path is None:
        return ""
    result = _run([path, "version"])
    first = (result.stdout or "").splitlines()
    return first[0].strip() if first else ""


def _parser() -> configparser.ConfigParser:
    path = config_path()
    parser = configparser.ConfigParser()
    if not path.is_file():
        return parser
    try:
        parser.read(path, encoding="utf-8")
    except (configparser.Error, OSError) as exc:
        raise RcloneError(
            tr("cli.rclone.config_unreadable", error=exc),
            hint=tr("cli.rclone.config_unreadable_hint", path=path),
        ) from exc
    return parser


def _section(name: str) -> dict[str, str]:
    parser = _parser()
    if not parser.has_section(name):
        raise RcloneError(
            tr("cli.rclone.no_such_remote", name=name),
            hint=tr("cli.rclone.no_such_remote_hint"),
        )
    return {key: (parser[name].get(key) or "").strip() for key in parser[name].keys()}


def read_remotes() -> list[dict[str, Any]]:
    """One row per remote: type, encrypted or not, and whether it needs a password at mount time."""
    parser = _parser()
    rows: list[dict[str, Any]] = []
    for name in parser.sections():
        section = {key: (parser[name].get(key) or "").strip() for key in parser[name].keys()}
        kind = section.get("type", "")
        keys = set(section)
        needs_password = kind == "crypt" and not section.get("password")
        rows.append(
            {
                "name": name,
                "type": kind or tr("cli.rclone.no_type"),
                "encrypted": kind == "crypt",
                "needs_password": needs_password,
                "target": section.get("remote") or section.get("host") or section.get("provider") or "",
                "stored_secret": bool(keys & {"password", "pass", "secret_access_key", "key_file"}),
            }
        )
    return rows


def password_key(name: str) -> str:
    """Which config key a one-off password overrides (rclone's env override replaces the whole key)."""
    section = _section(name)
    if "password" in section or "password2" in section:
        return "password"
    if "pass" in section:
        return "pass"
    if section.get("type") == "crypt":
        return "password"
    return "pass"


def password_env_name(name: str, key: str) -> str:
    """``RCLONE_CONFIG_<REMOTE>_<KEY>`` (non-alphanumerics become underscores, same rule as rclone)."""
    safe = re.sub(r"[^A-Za-z0-9]", "_", name).upper()
    return f"RCLONE_CONFIG_{safe}_{key.upper()}"


# ---------------------------------------------------------------- state file (ours, not settings.json)

_LOCK = threading.RLock()
# In-flight probes: remote name → {"started": perf_counter, "at": human time, "done": Event}
# Why this table exists: on a wedged mount point that read is **uninterruptible** (`ls` stuck in `U`
# state, SIGKILL does not reap it, so `subprocess.run(timeout=15)` **never returns**) — measured
# 2026-09-29: each 5-second panel poll wedged one more request thread, and within minutes the whole
# backend (the workbench cell, even /api/health) stopped answering and the UI never opened again.
# Now every probe runs in a **background thread**, at most one in flight per remote, and request
# paths only read the previous result.
_PROBING: dict[str, dict[str, Any]] = {}
_PROBING_LOCK = threading.Lock()
_STATE: dict[str, Any] | None = None
_STATE_STAMP: tuple[int, int] | None = None
_THREAD: threading.Thread | None = None
_STARTED = False
_MOUNTS: dict[str, dict[str, str]] = {}
_MOUNTS_AT = 0.0


def _empty_state() -> dict[str, Any]:
    return {"version": 1, "mounts": {}}


def load_state() -> dict[str, Any]:
    """Read the state file, **re-reading whenever the file on disk changed**.

    The cache only saves a read; it is not the source of truth (see docs/rclone.md).
    """
    global _STATE, _STATE_STAMP
    if _STATE is not None and _STATE_STAMP == _state_stamp():
        return _STATE
    try:
        data = json.loads(state_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = _empty_state()
    if not isinstance(data, dict) or not isinstance(data.get("mounts"), dict):
        data = _empty_state()
    _STATE = data
    _STATE_STAMP = _state_stamp()
    return _STATE


def _state_stamp() -> tuple[int, int] | None:
    try:
        info = state_path().stat()
    except OSError:
        return None
    return (info.st_mtime_ns, info.st_size)


def save_state() -> None:
    global _STATE_STAMP
    state = load_state()
    state_path().parent.mkdir(parents=True, exist_ok=True)
    state_path().write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _STATE_STAMP = _state_stamp()


# ---------------------------------------------------------------- mount table / processes / probing


def _run(command: list[str], *, timeout: float = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=timeout
    )


def mount_table(*, force: bool = False) -> dict[str, dict[str, str]]:
    """Current mount table: ``{mountpoint: {source, opts}}``.

    For watching; **never touches a remote** (reads the local mount table only).

    With ``force=False`` a snapshot at most 1 second old is reused (one watch tick asks several times,
    no reason to spawn a process each time); **request paths (mount/umount/probe/status) always use
    ``force=True``** — the 15-second cache made "probe right after mounting" read the pre-mount table
    and report "not mounted" (measured 2026-09-29, see docs/rclone.md).
    """
    global _MOUNTS, _MOUNTS_AT
    if not force and _MOUNTS and (time.time() - _MOUNTS_AT) < MOUNT_TABLE_TTL_SECONDS:
        return _MOUNTS
    table: dict[str, dict[str, str]] = {}
    try:
        result = _run(["mount"], timeout=10)
    except (OSError, subprocess.SubprocessError):
        return _MOUNTS
    for line in (result.stdout or "").splitlines():
        match = _MOUNT_LINE_RE.match(line.strip())
        if not match:
            continue
        point = match.group("point").rstrip("/") or "/"
        table[point] = {"source": match.group("source"), "opts": match.group("opts")}
    _MOUNTS, _MOUNTS_AT = table, time.time()
    return table


def is_mounted(point: str, *, table: dict[str, dict[str, str]] | None = None) -> bool:
    """Whether the mount point is still there (reads the table live when none is passed — see above)."""
    table = mount_table(force=True) if table is None else table
    return _norm_point(point) in table


def _norm_point(point: str | Path) -> str:
    text = str(point).rstrip("/") or "/"
    return text


def _resolve_dir(path: Path) -> str:
    """Canonical form of a mount point (the form the table uses, e.g. /tmp/x → /private/tmp/x). Only call while healthy."""
    try:
        return str(path.resolve())
    except OSError:
        return _norm_point(path)


def _pid_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _rclone_mount_pids(remote: str, point: str | None = None) -> list[int]:
    """Find ``rclone mount <remote>:`` processes in ``ps`` (or ``pgrep`` under a sandbox / restricted env).

    **Matched by remote name, not by literal mount point**: the convention is one mount point per
    remote, so the name is enough; and rclone's argv usually carries the **unresolved** mount point
    (we pass `/tmp/x`, ps shows `/tmp/x`, while the mount table says `/private/tmp/x`), so comparing
    the resolved path matches nothing — pid stays None and the "process alive" dimension is useless
    (measured 2026-09-29: `pid=—`, `pid_alive=False` in the state while the process was alive and
    well). When `point` is given, lines that mention it are preferred.
    """
    lines: list[str] = []
    try:
        result = _run(["ps", "-axo", "pid=,command="], timeout=10)
        if result.returncode == 0 and result.stdout:
            lines = (result.stdout or "").splitlines()
    except (OSError, subprocess.SubprocessError):
        pass

    if not lines:
        try:
            result = _run(["pgrep", "-fl", "rclone"], timeout=10)
            if result.returncode == 0 and result.stdout:
                lines = (result.stdout or "").splitlines()
        except (OSError, subprocess.SubprocessError):
            pass

    pattern = re.compile(rf"(?:^|[/\s])rclone\s+mount\s+{re.escape(remote)}:")
    matched: list[int] = []
    exact: list[int] = []
    for raw in lines:
        line = raw.strip()
        pid_text, _, command = line.partition(" ")
        if not command or not pattern.search(command):
            continue
        try:
            pid = int(pid_text)
        except ValueError:
            continue
        matched.append(pid)
        if point and point in command:
            exact.append(pid)
    return exact or matched


_PROBE_SCRIPT = r'''
ls -A -p "$1" | head -n "$2"
printf '%s\n' '===yhub-counts'
ls -A -p "$1" | awk '{ if (substr($0, length($0), 1) == "/") d++; else f++ } END { printf "%d %d\n", d+0, f+0 }'
printf '%s\n' '===yhub-df'
df -k "$1" 2>&1 | tail -n 1
'''


def _read_dir_bounded(point: str, *, per_read_timeout: float, budget: float) -> tuple[dict[str, Any] | None, bool]:
    """Read the mount point in a **background thread**, waiting at most ``budget`` seconds; returns (result, over budget).

    Why a second layer on top of `_read_dir`: `_read_dir`'s timeout kills the child process, but a
    read on a wedged mount is **uninterruptible** (measured: `ls` stuck in `U` state, SIGKILL does not
    reap it, `subprocess.run` never returns). So every read on a **request path** goes through here:
    when the budget runs out we give up and abandon the thread (at most one leak per mount point),
    while the request still returns and the UI still opens.
    """
    box: dict[str, Any] = {}
    done = threading.Event()

    def worker() -> None:
        try:
            box["value"] = _read_dir(point, per_read_timeout)
        except Exception as exc:  # noqa: BLE001
            box["value"] = {"ok": False, "names": [], "files": 0, "dirs": 0, "total": None, "free": None,
                            "error": tr("cli.rclone.read_error", error=exc)}
        finally:
            done.set()

    threading.Thread(target=worker, name="rclone-read", daemon=True).start()
    if not done.wait(budget):
        return None, True
    return box.get("value"), False


def _read_dir(point: str, timeout: float) -> dict[str, Any] | None:
    """Read the mount point once with a timeout; **on timeout** returns None.

    None means the remote is not ready or the mount is wedged — the caller tells them apart.

    Why `/bin/sh` + `ls`/`df` instead of a Python subprocess: the backend may be installed by
    `uv tool` / pip, where `sys.executable` is **that binary itself**, not an interpreter —
    `[sys.executable, "-c", ...]` would start the backend server, so probing always timed out
    (measured in verify-backend 2026-09-29: readable=False, warmup pinned at the 45s cap). The system
    sh/ls/df behave the same in dev mode and in an installed build.
    """
    try:
        result = subprocess.run(
            ["/bin/sh", "-c", _PROBE_SCRIPT, "yhub-probe", point, str(MAX_NAMES)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=timeout,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None

    out = result.stdout or ""
    if "===yhub-counts" not in out:
        tail = ((result.stderr or "").strip().splitlines() or [""])[-1]
        return {"ok": False, "names": [], "files": 0, "dirs": 0, "total": None, "free": None,
                "error": tail or tr("cli.rclone.read_no_result")}

    listing, _, rest = out.partition("===yhub-counts")
    counts, _, df_part = rest.partition("===yhub-df")
    names = [line for line in listing.splitlines() if line.strip()]
    dirs = files = 0
    count_line = (counts.strip().splitlines() or [""])[-1].split()
    if len(count_line) >= 2:
        try:
            dirs, files = int(count_line[0]), int(count_line[1])
        except ValueError:
            dirs = files = 0
    total = free = None
    fields = (df_part.strip().splitlines() or [""])[-1].split()
    # df -k: Filesystem 1024-blocks Used Available ... (1K blocks on both macOS and Linux)
    if len(fields) >= 4:
        try:
            total, free = int(fields[1]) * 1024, int(fields[3]) * 1024
        except ValueError:
            total = free = None
    return {
        "ok": True,
        "names": [name.rstrip("/") for name in names[:MAX_NAMES]],
        "files": files,
        "dirs": dirs,
        "total": total,
        "free": free,
    }


def _record_point(record: dict[str, Any]) -> str:
    """Canonical form of this record's mount point (the form the table uses, e.g. /tmp/x → /private/tmp/x).

    Always compare the mount table through it: comparing the record's `mountpoint` directly never
    matches **symlinked paths** like `/tmp` (measured 2026-09-29: after mounting at /tmp/xxx from the
    CLI, `probe` reported "not mounted" although the table clearly had `/private/tmp/xxx`).
    """
    return record.get("mountpoint_resolved") or record["mountpoint"]


def _age_seconds(record: dict[str, Any]) -> float:
    """How long this mount has been up (seconds); a broken timestamp counts as a very long time."""
    return _seconds_since(record.get("started_at"))


def _write_probe_result(name: str, payload: dict[str, Any], *, warming: bool) -> None:
    """Store one probe result in the record (the cross-process source of truth)."""
    with _LOCK:
        state = load_state()
        item = state["mounts"].get(name)
        if item is None:
            return
        item["probed_at"] = payload["at"]
        item["probe"] = payload
        if payload.get("ok"):
            item["probe_fails"] = 0
        elif not warming:
            item["probe_fails"] = int(item.get("probe_fails") or 0) + 1
        save_state()


def probe_runtime(name: str) -> dict[str, Any] | None:
    """How long the current probe has run and whether it counts as "stuck". None when idle.

    Request paths and the UI use it to say something honest ("stuck, no answer for N seconds"); it is
    **not** something to wait on.
    """
    with _PROBING_LOCK:
        entry = _PROBING.get(name)
        if entry is None or entry["done"].is_set():
            return None
        seconds = time.perf_counter() - entry["started"]
        return {
            "running": True,
            "seconds": round(seconds, 1),
            "stuck": seconds > PROBE_STUCK_SECONDS,
            "started": entry["at"],
        }


def _probe_body(name: str) -> dict[str, Any]:
    """Actually read the mount point once (**background threads only**). Returns the payload stored in the record."""
    record = tracked(name)
    point = _record_point(record)
    warming = _age_seconds(record) < WARMUP_SECONDS
    if not is_mounted(point):
        payload = {"ok": False, "names": [], "files": 0, "dirs": 0, "total": None, "free": None,
                   "error": tr("cli.rclone.not_mounted_before_probe", name=name), "at": _now(), "took_ms": 0}
        _write_probe_result(name, payload, warming=warming)
        return payload
    started = time.perf_counter()
    payload = _read_dir(point, PROBE_TIMEOUT_SECONDS)
    if payload is None:
        # Read **timed out** (reachable while the child process is still alive); a true wedge never
        # gets here — that thread stays blocked forever and probe_runtime() reports it as "stuck",
        # with request paths unaffected.
        payload = {
            "ok": False, "names": [], "files": 0, "dirs": 0, "total": None, "free": None,
            "error": tr("cli.rclone.read_timeout", point=point, seconds=PROBE_TIMEOUT_SECONDS),
            "at": _now(),
            "took_ms": int((time.perf_counter() - started) * 1000),
            "warming": warming,
            "hint": (
                tr("cli.rclone.warmup_hint", seconds=int(_age_seconds(record)))
                if warming
                else tr("cli.rclone.unreadable_hint")
            ),
        }
    else:
        payload["took_ms"] = int((time.perf_counter() - started) * 1000)
        payload["at"] = _now()
        payload.setdefault("warming", warming)
    _write_probe_result(name, payload, warming=warming)
    return payload


def _probe_worker(name: str, entry: dict[str, Any]) -> None:
    """Background probe thread: if it blocks, it blocks alone — never the request path."""
    try:
        _probe_body(name)
    except RcloneError as exc:
        _write_probe_result(
            name,
            {"ok": False, "names": [], "files": 0, "dirs": 0, "total": None, "free": None,
             "error": exc.message, "at": _now(), "took_ms": 0},
            warming=False,
        )
    except Exception:  # noqa: BLE001 - a thread must not drop the result and skip cleanup
        LOG.exception("[rclone] 探测 %s 出错", name)
    finally:
        entry["done"].set()


def start_probe(name: str) -> dict[str, Any]:
    """Start a background probe (idempotent): at most one in flight per remote."""
    with _PROBING_LOCK:
        entry = _PROBING.get(name)
        if entry is not None and not entry["done"].is_set():
            # Careful: **must not** call probe_runtime() here — it also takes _PROBING_LOCK (a plain,
            # non-reentrant lock), which deadlocks on itself (measured 2026-09-29: once the watch
            # thread blocked, every following /api/rclone blocked with it).
            seconds = time.perf_counter() - entry["started"]
            return {"running": True, "seconds": round(seconds, 1),
                    "stuck": seconds > PROBE_STUCK_SECONDS, "started": entry["at"]}
        entry = {"started": time.perf_counter(), "at": _now(), "done": threading.Event()}
        _PROBING[name] = entry
        thread = threading.Thread(target=_probe_worker, args=(name, entry),
                                  name=f"rclone-probe-{name}", daemon=True)
        entry["thread"] = thread
        thread.start()
    return {"running": True, "seconds": 0.0, "stuck": False, "started": entry["at"]}


def _forget_probe(name: str) -> None:
    """Forget this remote's in-flight probe (a wedged thread cannot be reclaimed, but it must not keep the slot).

    Otherwise, after wedge → umount → remount, `start_probe` forever sees "still running" and this
    remote is never probed again.
    """
    with _PROBING_LOCK:
        _PROBING.pop(name, None)


def cached_probe(name: str) -> dict[str, Any] | None:
    """The previous probe result from the record; never starts a new probe."""
    record = load_state()["mounts"].get(name)
    if not record:
        return None
    payload = record.get("probe")
    if not payload:
        return None
    return {**payload, "at": payload.get("at") or record.get("probed_at")}


def probe(name: str, *, wait_seconds: float = PROBE_WAIT_SECONDS) -> dict[str, Any]:
    """Read the mount point's root dir and capacity once (**in a background thread**), waiting at most ``wait_seconds`` here.

    Why not read on the caller's thread (blood lesson, 2026-09-29): that read is **uninterruptible**
    on a wedged mount, `subprocess.run(timeout=15)` cannot kill it and never returns — so whoever
    calls it hangs forever. Doing that on a request path (the workbench cell, the panel's 5-second
    poll) drains the backend's threads within minutes and the UI never opens again. Now the probe
    thread may block (the UI honestly says "stuck for N seconds") while request paths never wait.
    """
    tracked(name)  # raises when there is no record (keeps the original error semantics)
    start_probe(name)
    entry = _PROBING.get(name)
    if entry is not None and wait_seconds > 0:
        entry["done"].wait(wait_seconds)
    runtime = probe_runtime(name)
    payload = cached_probe(name)
    if runtime is not None:
        note = (
            tr("cli.rclone.probe_running", seconds=runtime["seconds"])
            + (tr("cli.rclone.probe_running_stuck") if runtime["stuck"] else "")
        )
        if payload is None:
            return {"ok": False, "names": [], "files": 0, "dirs": 0, "total": None, "free": None,
                    "error": note, "at": _now(), "took_ms": 0, "running": True,
                    "stuck_seconds": runtime["seconds"]}
        return {**payload, "running": True, "stuck_seconds": runtime["seconds"], "note": note}
    if payload is None:
        return {"ok": False, "names": [], "files": 0, "dirs": 0, "total": None, "free": None,
                "error": tr("cli.rclone.not_probed_yet"), "at": _now(), "took_ms": 0}
    return payload


# ---------------------------------------------------------------- mount / umount


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def tracked(name: str) -> dict[str, Any]:
    with _LOCK:
        item = load_state()["mounts"].get(name)
    if item is None:
        raise RcloneError(tr("cli.rclone.no_record", name=name), hint=tr("cli.rclone.no_record_hint"))
    return item


def default_mountpoint(name: str) -> str:
    return str(DEFAULT_MOUNT_ROOT / name)


def _preflight(name: str, env: dict[str, str]) -> tuple[bool, str]:
    """Before mounting, read the remote's top level once with the **same password environment** (`rclone lsf --max-depth 1`).

    Why the extra second pays off: with a wrong password rclone **still mounts fine**, it just prints
    "Skipping undecryptable file name" on every listing — the panel says "mounted" while the names
    inside are garbage.

    **The signal is stdout (names that decrypt), not whether stderr mentions undecryptable**
    (measured 2026-09-29): crypt reports `Skipping undecryptable file name: illegal base32 data at
    input byte 0` for any name **not written through it** (macOS `.DS_Store` / `._*` dropped in the
    upstream root, or plain names copied in) — even with a perfectly correct password. Hence:

    | case | stdout | stderr |
    | --- | --- | --- |
    | right password (junk upstream) | decrypted names | only `illegal base32 data` |
    | wrong password | **empty** | valid base32 names → `bad PKCS#7 padding` / undecryptable dir name |
    | no password given | empty | `password not set in config file` (exit code 1) |

    Block only on **hard evidence** (base32 names came back and none decrypt); an empty upstream, or
    only non-crypt names, passes — better to mount and let watching report honestly than to block a
    good mount. Returns ``(proceed?, one plain sentence)``.
    """
    path = _require_rclone()
    result = subprocess.run(
        [path, "lsf", f"{name}:", "--max-depth", "1"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=60,
        env=env,
    )
    names = [line for line in (result.stdout or "").splitlines() if line.strip()]
    warned = (result.stderr or "").strip()
    lowered = warned.lower()
    if "not set in config" in lowered:
        raise RcloneError(
            tr("cli.rclone.password_required", name=name),
            hint=tr("cli.rclone.password_required_hint", name=name),
        )
    if "is it obscured" in lowered or "failed to decrypt password" in lowered:
        raise RcloneError(
            tr("cli.rclone.password_already_obscured", name=name),
            hint=tr("cli.rclone.password_already_obscured_hint"),
        )
    if result.returncode != 0:
        tail = (warned or (result.stdout or "").strip())[-400:]
        raise RcloneError(
            tr("cli.rclone.connect_failed", name=name, code=result.returncode),
            hint=tail or tr("cli.rclone.connect_failed_hint", name=name),
        )
    if names:
        # Names decrypted = correct password. Explain the unreadable names in the upstream root so the
        # user does not think something is broken.
        skipped = sum(1 for line in warned.splitlines() if "undecryptable" in line.lower())
        note = (
            tr("cli.rclone.skipped_names", count=skipped)
            if skipped
            else ""
        )
        return True, tr("cli.rclone.readable_names", name=name, count=len(names), note=note)
    # Nothing decrypted: **any failure that is not "the name is not base32 at all" (a foreign name)**
    # means the password/salt is wrong — the rule is not "block only when there is no foreign name"
    # (the first version said that, and a wrong password slipped through).
    undecryptable = [line for line in warned.splitlines() if "undecryptable" in line.lower()]
    real_failures = [line for line in undecryptable if "illegal base32" not in line.lower()]
    if real_failures:
        raise RcloneError(
            tr("cli.rclone.wrong_password", name=name),
            hint=tr("cli.rclone.wrong_password_hint",
                    detail=real_failures[0].split("NOTICE:")[-1].strip()[:90]),
        )
    if not undecryptable:
        return True, tr("cli.rclone.top_empty", name=name)
    return True, tr("cli.rclone.top_foreign_only", name=name, count=len(undecryptable))


def split_extra_args(text: str | None) -> list[str]:
    """Split the extra-args string into argv pieces (the panel has one input box, the CLI has `--extra`).

    Split with shell quoting rules (`shlex`), so values with spaces work: `--dir-cache-time "10s"` or
    `--header "X: y"`.
    """
    text = (text or "").strip()
    if not text:
        return []
    try:
        parts = shlex.split(text)
    except ValueError as exc:  # unbalanced quotes
        raise RcloneError(tr("cli.rclone.extra_unparsable", error=exc),
                          hint=tr("cli.rclone.extra_unparsable_hint")) from None
    return _check_extra_args(parts)


def _check_extra_args(args: list[str]) -> list[str]:
    """The gate: flags only; rejects switches that would put a password into argv or break the mount contract."""
    if len(args) > MOUNT_EXTRA_MAX_ARGS:
        raise RcloneError(
            tr("cli.rclone.extra_too_many", count=len(args), max=MOUNT_EXTRA_MAX_ARGS),
            hint=tr("cli.rclone.extra_too_many_hint"),
        )
    for i, arg in enumerate(args):
        if len(arg) > MOUNT_EXTRA_MAX_LEN:
            raise RcloneError(
                tr("cli.rclone.extra_too_long", count=len(arg), arg=arg[:40]),
                hint=tr("cli.rclone.extra_too_long_hint"),
            )
        if not arg.startswith("-"):
            # A non-dash argument can only be **the value of the previous flag** (`--dir-cache-time 10s`).
            # One at the start, or two in a row, is a real positional (it would displace the remote or
            # mount point) — the first version required "starts with -" flatly and blocked values too
            # (caught by self-test 2026-09-29).
            if i == 0 or not args[i - 1].startswith("-"):
                raise RcloneError(
                    tr("cli.rclone.extra_positional", arg=arg),
                    hint=tr("cli.rclone.extra_positional_hint"),
                )
            continue
        for bad in MOUNT_EXTRA_DENY:
            if arg == bad or arg.startswith(bad + "=") or arg.startswith(bad + "-"):
                raise RcloneError(
                    tr("cli.rclone.extra_denied", flag=bad, arg=arg),
                    hint=tr("cli.rclone.extra_denied_hint"),
                )
    return args


def _extra_value(args: list[str], flag: str) -> str | None:
    """Read one flag's value out of the extra args (`--flag v` or `--flag=v`)."""
    for i, arg in enumerate(args):
        if arg == flag and i + 1 < len(args):
            return args[i + 1]
        if arg.startswith(flag + "="):
            return arg[len(flag) + 1 :]
    return None


def mount(
    name: str,
    *,
    mountpoint: str | None = None,
    password: str | None = None,
    read_only: bool = False,
    allow_non_empty: bool = False,
    extra_args: list[str] | None = None,
) -> dict[str, Any]:
    """Mount a remote. ``password`` exists only for this call and is dropped once rclone has it.

    The password is **plaintext only**: the rclone config stores the obscured form, and `rclone
    obscure` takes it on argv (where `ps` would show it), so this process computes the obscured form
    itself (cli/rclone_obscure.py). An already-obscured value is rejected — impractical, and it
    leaves the user unsure which form they typed.

    The cache mode is the fixed ``VFS_CACHE_MODE`` (writes); override it through ``extra_args``.
    """
    _require_rclone()
    remotes = {row["name"]: row for row in read_remotes()}
    if name not in remotes:
        raise RcloneError(
            tr("cli.rclone.no_such_remote", name=name),
            hint=tr("cli.rclone.no_such_remote_mount_hint"),
        )
    remote = remotes[name]
    extras = _check_extra_args(list(extra_args or []))
    # `--vfs-cache-mode` / `--read-only` from the extra args must be reflected in the record (state must not lie)
    cache_mode = _extra_value(extras, "--vfs-cache-mode") or VFS_CACHE_MODE
    read_only = read_only or "--read-only" in extras

    if name in load_state()["mounts"] and is_mounted(_record_point(tracked(name)), table=mount_table(force=True)):
        raise RcloneError(
            tr("cli.rclone.already_mounted", name=name),
            hint=tr("cli.rclone.already_mounted_hint", mountpoint=tracked(name)["mountpoint"], name=name),
        )

    target_text = (mountpoint or default_mountpoint(name)).strip()
    target = Path(target_text).expanduser()
    if not target.is_absolute():
        raise RcloneError(tr("cli.rclone.absolute_required", path=target_text),
                          hint=tr("cli.rclone.absolute_required_hint"))

    if target.exists() and not target.is_dir():
        raise RcloneError(tr("cli.rclone.not_a_dir", path=target),
                          hint=tr("cli.rclone.not_a_dir_hint"))
    if target.is_dir() and any(target.iterdir()) and not allow_non_empty:
        raise RcloneError(
            tr("cli.rclone.not_empty", path=target),
            hint=tr("cli.rclone.not_empty_hint"),
        )
    if is_mounted(_resolve_dir(target), table=mount_table(force=True)):
        raise RcloneError(
            tr("cli.rclone.point_taken", path=target),
            hint=tr("cli.rclone.point_taken_hint", path=target),
        )
    key = password_key(name)
    if remote["needs_password"] and not password:
        raise RcloneError(
            tr("cli.rclone.password_required_mount", name=name),
            hint=tr("cli.rclone.password_required_mount_hint", name=name),
        )

    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise RcloneError(
            tr("cli.rclone.mkdir_failed", path=target, error=exc),
            hint=tr("cli.rclone.mkdir_failed_hint"),
        ) from exc

    # An rclone process already mounting this remote: leave no orphans
    for pid in _rclone_mount_pids(name, _resolve_dir(target)):
        raise RcloneError(
            tr("cli.rclone.process_exists", pid=pid),
            hint=tr("cli.rclone.process_exists_hint", name=name),
        )

    bin_path = _require_rclone()
    args = [
        bin_path,
        "mount",
        f"{name}:",
        str(target),
        "--vfs-cache-mode",
        VFS_CACHE_MODE,
        "--volname",
        name,
        "--daemon",
        "--daemon-wait",
        DAEMON_WAIT,
    ]
    if read_only:
        args.append("--read-only")
    if allow_non_empty:
        args.append("--allow-non-empty")
    # Extra args go last: the user's explicit choice beats our defaults (rclone takes the last of a repeated flag)
    args.extend(extras)

    env = dict(os.environ)
    env_key = password_env_name(name, key)
    if password:
        # Hand it to rclone through the environment only: not argv (ps sees it), not on disk, not in
        # logs. The plaintext must first become the obscured form (rclone only accepts that), and that
        # step also happens in this process, never through a command line.
        env[env_key] = obscure(password)

    preflight_note = ""
    try:
        # Preflight first: a wrong password / unreachable remote is explained here
        # (rclone mounts happily even with a bad password)
        _, preflight_note = _preflight(name, env)
        result = subprocess.run(
            args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=90, env=env
        )
    except subprocess.TimeoutExpired:
        raise RcloneError(tr("cli.rclone.mount_timeout", name=name),
                          hint=tr("cli.rclone.mount_timeout_hint", name=name)) from None
    finally:
        env.pop(env_key, None)

    output = ((result.stdout or "") + (result.stderr or "")).strip()
    if result.returncode != 0:
        raise RcloneError(
            tr("cli.rclone.mount_failed", code=result.returncode),
            hint=output[-500:] or tr("cli.rclone.mount_failed_hint"),
        )

    point = _resolve_dir(target)
    started_at = _now()
    _forget_probe(name)  # a wedged probe thread cannot be reclaimed, but a fresh mount must be able to probe again
    deadline = time.time() + MOUNT_READY_TIMEOUT_SECONDS
    while time.time() < deadline and not is_mounted(point, table=mount_table(force=True)):
        time.sleep(0.5)
    table = mount_table(force=True)
    if not is_mounted(point, table=table):
        raise RcloneError(
            tr("cli.rclone.not_in_table", point=point),
            hint=tr("cli.rclone.not_in_table_hint", name=name),
        )

    # Being in the mount table ≠ usable: a fresh mount still has rclone's session warming up and reads
    # block (measured: 8s before it works). So wait for "readable for the first time" — then the panel
    # saying "mounted" really means usable.
    warm_started = time.perf_counter()
    readable = False
    warm_error = ""
    while time.perf_counter() - warm_started < READY_READ_TIMEOUT_SECONDS:
        first_read, over_budget = _read_dir_bounded(point, per_read_timeout=6, budget=6)
        if over_budget:
            warm_error = tr("cli.rclone.read_budget_exceeded", point=point, seconds=6)
            break
        if first_read is not None and first_read.get("ok"):
            readable = True
            break
        if first_read is not None:
            warm_error = str(first_read.get("error") or "")
        time.sleep(1)
    warmup_ms = int((time.perf_counter() - warm_started) * 1000)

    pids = _rclone_mount_pids(name, point)
    if not readable:
        # Mounted and in the table, but unreadable: useless to the user and it ties up the mount point.
        # Clean up before raising, so nobody is left guessing about a half mount (fall back to _detach
        # when the rclone path is unusable).
        try:
            _detach(point, pids[-1] if pids else None)
        except RcloneError:
            LOG.warning("[rclone] %s 挂上了但读不出内容，且收不干净：%s", name, point)
        raise RcloneError(
            tr("cli.rclone.mounted_unreadable", name=name, seconds=READY_READ_TIMEOUT_SECONDS),
            hint=warm_error or tr("cli.rclone.mounted_unreadable_hint", name=name),
        )

    record = {
        "name": name,
        "remote": f"{name}:",
        "type": remote["type"],
        "encrypted": remote["encrypted"],
        "mountpoint": str(target),
        "mountpoint_resolved": point,
        "source": table[point]["source"],
        "pid": pids[-1] if pids else None,
        "read_only": read_only,
        "cache": cache_mode,
        "extra_args": extras,
        "started_at": started_at,
        "readable": readable,
        "readable_at": _now(),
        "warmup_ms": warmup_ms,
        "warmup_error": warm_error,
        "probed_at": None,
        "probe": None,
        "probe_fails": 0,
        "preflight": preflight_note,
    }
    with _LOCK:
        state = load_state()
        state["mounts"][name] = record
        save_state()
    ensure_started()
    return record


def _detach(point: str, pid: int | None = None) -> list[str]:
    """Clean up a mount point: a polite `umount`, then SIGTERM that rclone, finally (macOS) `diskutil force`.

    Both `umount()` and the "mounted but unreadable" path go through it — both must hand the mount
    point back. Raises RcloneError when it cannot detach (never leave a half mount behind).
    """
    steps: list[str] = []
    if is_mounted(point, table=mount_table(force=True)):
        result = _run(["umount", point], timeout=30)
        steps.append(f"umount {point} → {result.returncode}")
        deadline = time.time() + 10
        while time.time() < deadline and is_mounted(point, table=mount_table(force=True)):
            time.sleep(0.5)

    pid_int = int(pid) if pid else 0
    if is_mounted(point, table=mount_table(force=True)) and _pid_alive(pid_int):
        try:
            os.kill(pid_int, signal.SIGTERM)
            steps.append(f"SIGTERM {pid}")
        except OSError:
            pass
        deadline = time.time() + 10
        while time.time() < deadline and is_mounted(point, table=mount_table(force=True)):
            time.sleep(0.5)

    if is_mounted(point, table=mount_table(force=True)) and shutil.which("diskutil"):
        result = _run(["diskutil", "unmount", "force", point], timeout=30)
        steps.append(f"diskutil unmount force → {result.returncode}")
        time.sleep(1)

    if is_mounted(point, table=mount_table(force=True)):
        raise RcloneError(
            tr("cli.rclone.cannot_umount", point=point),
            hint=tr("cli.rclone.cannot_umount_hint", point=point),
        )
    return steps


def umount(name: str) -> dict[str, Any]:
    """Umount a remote: clean up the mount point, then drop the record."""
    record = tracked(name)
    point = _record_point(record)
    steps = _detach(point, record.get("pid"))

    with _LOCK:
        state = load_state()
        state["mounts"].pop(name, None)
        save_state()
    # A wedged probe thread cannot be reclaimed, but it must not keep the slot
    # (otherwise a remount is never probed again).
    _forget_probe(name)
    return {"name": name, "mountpoint": point, "steps": steps, "mounted": False}


# ---------------------------------------------------------------- watching


def _live(record: dict[str, Any], table: dict[str, dict[str, str]]) -> dict[str, Any]:
    """Current facts for one mount record (local only: mount table + process)."""
    point = _record_point(record)
    row = table.get(point)
    pid = record.get("pid")
    alive = _pid_alive(pid)
    mounted = row is not None
    probe = record.get("probe") or {}
    warming = _age_seconds(record) < WARMUP_SECONDS
    runtime = probe_runtime(record.get("name") or "")
    return {
        **record,
        "mounted": mounted,
        # Probe facts: in flight / running for how long / stuck or not. Request paths only read these.
        "probe_running": bool(runtime),
        "probe_stuck_seconds": (runtime or {}).get("seconds") if (runtime or {}).get("stuck") else None,
        # The last probe's own error ("read X, nothing back in 15s"): request paths read it to explain
        "probe_error": str(probe.get("error") or "") if probe else "",
        "probe": probe or None,
        "pid_alive": alive,
        "source_now": row["source"] if row else None,
        "probe_ok": bool(probe.get("ok")) if probe else None,
        "probe_fails": int(record.get("probe_fails") or 0),
        "warming": warming,
        # Three unhealthy states: the record says mounted but the table lost it (dropped), the process
        # is gone, or probes keep failing (wedged) — warmup does not count, a fresh mount may be
        # unreadable for a while.
        "dropped": bool(not mounted),
        "stale": bool(mounted and not alive),
        "degraded": bool(mounted and not warming and int(record.get("probe_fails") or 0) >= 3),
    }


def mounts(*, auto_probe: bool = True) -> list[dict[str, Any]]:
    table = mount_table(force=True)
    with _LOCK:
        records = list(load_state()["mounts"].values())
    rows = [_live(record, table) for record in records]
    if auto_probe:
        for row in rows:
            if not row["mounted"] or row["warming"]:
                # No auto probe during warmup: reading the mount point then blocks for ~10s — a
                # wasted wait that may even count as a failure
                continue
            last = row.get("probed_at")
            if last and _seconds_since(last) < PROBE_EVERY_SECONDS:
                continue
            # **Start a background probe only, never read the mount point here**: reading a wedged
            # mount blocks forever, and this function sits on a request path (the panel polls every
            # 5s) — inlining the probe drains backend threads one at a time.
            try:
                start_probe(row["name"])
            except Exception as exc:  # noqa: BLE001
                LOG.debug("[rclone] 起探测 %s 失败：%s", row["name"], exc)
            else:
                refreshed = _live(load_state()["mounts"].get(row["name"]) or row, table)
                row.clear()
                row.update(refreshed)
    return rows


def _seconds_since(stamp: str | None) -> float:
    if not stamp:
        return 1e9
    try:
        return max(0.0, (datetime.now() - datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S")).total_seconds())
    except ValueError:
        return 1e9


def untracked() -> list[dict[str, str]]:
    """Mounts that look like rclone / FUSE but have no record (mounted by hand, or the state was deleted)."""
    table = mount_table()
    known = {_norm_point(r.get("mountpoint_resolved") or r["mountpoint"]) for r in load_state()["mounts"].values()}
    rows = []
    for point, info in table.items():
        if point in known:
            continue
        source = info["source"].lower()
        if "rclone" in source or "fuse" in source:
            rows.append({"mountpoint": point, "source": info["source"]})
    return rows


def status(*, auto_probe: bool = False) -> dict[str, Any]:
    """The whole picture for the panel: rclone itself + remotes in the config + ours + untracked mounts."""
    installed = rclone_bin()
    table = mount_table(force=True)
    live = {row["name"]: row for row in mounts(auto_probe=auto_probe)}
    remotes = []
    for row in read_remotes():
        record = live.get(row["name"])
        remotes.append(
            {
                **row,
                "tracked": record is not None,
                "mounted": bool(record and record["mounted"]),
                "readable": bool(record and record.get("readable")),
                "warming": bool(record and record.get("warming")),
                "warmup_ms": (record or {}).get("warmup_ms"),
                "mountpoint": (record or {}).get("mountpoint") or default_mountpoint(row["name"]),
                "pid": (record or {}).get("pid"),
                "pid_alive": bool(record and record["pid_alive"]),
                "uptime": (record or {}).get("started_at"),
                "cache": (record or {}).get("cache"),
                "extra_args": list((record or {}).get("extra_args") or []),
                "read_only": bool((record or {}).get("read_only")),
            }
        )
    return {
        "rclone": {
            "installed": installed is not None,
            "path": installed,
            "version": rclone_version() if installed else "",
            "config": str(config_path()),
            "config_exists": config_path().is_file(),
        },
        "mount_root": str(DEFAULT_MOUNT_ROOT),
        "state_path": str(state_path()),
        "vfs_cache_mode": VFS_CACHE_MODE,  # fixed value (the panel only displays it, no choice)
        "remotes": remotes,
        "mounts": list(live.values()),
        "untracked": untracked(),
        "watcher": {"started": started(), "tick_seconds": TICK_SECONDS, "probe_every": PROBE_EVERY_SECONDS},
        "checked_at": _now(),
        "mount_table": {point: info["source"] for point, info in table.items() if "fuse" in info["opts"] or "rclone" in info["source"]},
    }


def cell() -> dict[str, Any]:
    """The wall cell: how many mounts, and whether any of them dropped."""
    if rclone_bin() is None:
        return {"status": "warn", "summary": tr("cli.rclone.cell_not_installed"), "detail": "brew install rclone"}
    if not config_path().is_file():
        return {
            "status": "warn",
            "summary": tr("cli.rclone.cell_no_config"),
            "detail": tr("cli.rclone.cell_no_config_detail", path=config_path()),
        }
    # **Do not trigger a probe here**: this cell is fetched on a request path (workbench and wall both
    # pull it) and an inlined probe on a wedged mount hangs that request forever — after which the UI
    # never opens again (measured 2026-09-29). Probing belongs to the watch thread; read the last
    # result here.
    rows = mounts(auto_probe=False)
    if not rows:
        return {
            "status": "ok",
            "summary": tr("cli.rclone.cell_idle"),
            "detail": tr("cli.rclone.cell_idle_detail", count=len(read_remotes())),
        }
    dropped = [r["name"] for r in rows if r["dropped"]]
    degraded = [r["name"] for r in rows if r["degraded"]]
    stuck = [tr("cli.rclone.stuck_item", name=r["name"], seconds=r["probe_stuck_seconds"])
             for r in rows if r.get("probe_stuck_seconds")]
    unreadable = [r["name"] for r in rows
                  if r.get("probe_error") and not r.get("warming") and r.get("mounted")]
    if unreadable and not stuck:
        # The probe **came back but cannot read** (timeout/wedge): say so now, no need to wait for three strikes
        detail = next((r.get("probe_error") for r in rows if r["name"] == unreadable[0]), "")
        return {
            "status": "warn",
            "summary": tr("cli.rclone.cell_unreadable_summary", names=_sep().join(unreadable)),
            "detail": tr("cli.rclone.cell_unreadable_detail", detail=detail),
        }
    alive = [r for r in rows if r["mounted"]]
    if stuck:
        return {
            "status": "alert",
            "summary": tr("cli.rclone.cell_unreadable_summary", names=_sep().join(stuck)),
            "detail": tr("cli.rclone.cell_stuck_detail"),
        }
    if dropped:
        return {
            "status": "alert",
            "summary": tr("cli.rclone.cell_dropped_summary", count=len(dropped),
                             names=_sep().join(dropped)),
            "detail": tr("cli.rclone.cell_dropped_detail"),
        }
    if degraded:
        return {
            "status": "warn",
            "summary": tr("cli.rclone.cell_degraded_summary", names=_sep().join(degraded)),
            "detail": tr("cli.rclone.cell_degraded_detail"),
        }
    names = _sep().join(r["name"] for r in alive)
    return {
        "status": "ok",
        "summary": tr("cli.rclone.cell_mounted_summary", count=len(alive), names=names),
        "detail": _sep().join(f"{r['name']} → {r['mountpoint']}" for r in alive),
    }


# ---------------------------------------------------------------- watcher thread


def started() -> bool:
    return bool(_THREAD and _THREAD.is_alive())


def ensure_started() -> bool:
    """Start the watch thread (idempotent): reads the local mount table + processes, plus low-frequency probes."""
    global _THREAD
    with _LOCK:
        if started():
            return True
        thread = threading.Thread(target=_loop, name="rclone-watch", daemon=True)
        thread.start()
        _THREAD = thread
    return True


def _loop() -> None:
    LOG.info("[rclone] 监视线程启动（每 %ss 一轮，探测每 %ss 一次）", TICK_SECONDS, PROBE_EVERY_SECONDS)
    while True:
        try:
            mount_table(force=True)
            mounts(auto_probe=True)
        except Exception:  # noqa: BLE001 - a thread must not die
            LOG.exception("[rclone] 监视这一轮出错")
        time.sleep(TICK_SECONDS)


# ---------------------------------------------------------------- CLI


def _read_password_from_stdin() -> str:
    value = sys.stdin.readline()
    return value.rstrip("\r\n")


def run(command: str | None, args: Any) -> int:
    """``yhub rclone <command>``: same logic as the panel (both go through this module)."""
    as_json = bool(getattr(args, "json", False))
    try:
        if command in (None, "status"):
            return _cli_status(as_json)
        if command == "list":
            return _cli_list(as_json)
        if command == "mount":
            return _cli_mount(args)
        if command == "umount":
            return _cli_umount(args, as_json)
        if command == "probe":
            return _cli_probe(args, as_json)
    except RcloneError as exc:
        print(f"× {exc.message}")
        if exc.hint:
            print(f"  {exc.hint}")
        return 1
    print(tr("cli.rclone.unknown_action", command=command))
    return 2


def _cli_status(as_json: bool) -> int:
    # Probing is the background watch thread's job; read the cache here — the CLI must not hang
    # either when a mount point is wedged
    view = status(auto_probe=False)
    if as_json:
        print(json.dumps(view, ensure_ascii=False, indent=2))
        return 0
    rc = view["rclone"]
    print(tr("cli.rclone.status_rclone_version",
              version=rc['version'] or tr("cli.rclone.not_installed_short")))
    print(tr("cli.rclone.status_config", path=rc['config'],
              note="" if rc['config_exists'] else tr("cli.rclone.config_missing")))
    if not view["mounts"]:
        print(tr("cli.rclone.no_mounts"))
    for row in view["mounts"]:
        flag = tr("cli.rclone.state_mounted") if row["mounted"] else tr("cli.rclone.state_dropped")
        warm = tr("cli.rclone.warmup_note", ms=row.get('warmup_ms')) if row.get("warming") else ""
        print(tr("cli.rclone.mount_line", flag=flag, name=row['name'], mountpoint=row['mountpoint'],
                  pid=row['pid'] or '—', cache=row['cache'], started=row['started_at'], warm=warm))
        if row.get("extra_args"):
            print(tr("cli.rclone.extra_args_line", args=' '.join(row['extra_args'])))
        if row.get("preflight"):
            print(tr("cli.rclone.preflight_line", note=row['preflight']))
        if row.get("probe_stuck_seconds"):
            print(tr("cli.rclone.probe_stuck_line", seconds=row['probe_stuck_seconds']))
        if row.get("probe"):
            probe_row = row["probe"]
            size = _human(probe_row.get("total"))
            print(tr("cli.rclone.probe_line", at=row.get('probed_at'), dirs=probe_row.get('dirs', 0),
                      files=probe_row.get('files', 0), total=size or '—', ms=probe_row.get('took_ms')))
    for row in view["untracked"]:
        print(tr("cli.rclone.untracked_line", point=row['mountpoint'], source=row['source']))
    return 0


def _human(size: Any) -> str:
    try:
        value = float(size)
    except (TypeError, ValueError):
        return ""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.1f}{unit}" if unit != "B" else f"{int(value)}B"
        value /= 1024
    return ""


def _cli_list(as_json: bool) -> int:
    remotes = read_remotes()
    live = {row["name"]: row for row in mounts()}
    rows = [{**row, "mounted": bool(live.get(row["name"], {}).get("mounted"))} for row in remotes]
    if as_json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0
    if not rows:
        print(tr("cli.rclone.no_remotes", path=config_path()))
        return 0
    for row in rows:
        tags = []
        if row["encrypted"]:
            tags.append(tr("cli.rclone.tag_encrypted"))
        if row["needs_password"]:
            tags.append(tr("cli.rclone.tag_needs_password"))
        if row["mounted"]:
            tags.append(tr("cli.rclone.state_mounted"))
        print(f"  {row['name']:<16} {row['type']:<8} {' '.join(tags) or '—'}  {row['target']}")
    return 0


def _cli_mount(args: Any) -> int:
    name = args.name
    password = None
    if getattr(args, "password_stdin", False):
        password = _read_password_from_stdin()
    elif any(row["name"] == name and row["needs_password"] for row in read_remotes()):
        if sys.stdin.isatty():
            password = getpass.getpass(tr("cli.rclone.password_prompt"))
        else:
            print(tr("cli.rclone.no_tty", name=name))
            print(tr("cli.rclone.no_tty_hint"))
            return 1
    if password and looks_obscured(password):
        print(tr("cli.rclone.obscure_warning_1"))
        print(tr("cli.rclone.obscure_warning_2"))
    record = mount(
        name,
        mountpoint=getattr(args, "dir", None),
        password=password,
        extra_args=split_extra_args(getattr(args, "extra", None)),
        read_only=bool(getattr(args, "read_only", False)),
        allow_non_empty=bool(getattr(args, "allow_non_empty", False)),
    )
    password = None
    print(tr("cli.rclone.mounted_ok", name=record['name'], mountpoint=record['mountpoint'],
              pid=record['pid'] or '—', cache=record['cache']))
    print(tr("cli.rclone.umount_command", name=record["name"]))
    return 0


def _cli_umount(args: Any, as_json: bool) -> int:
    result = umount(args.name)
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    print(tr("cli.rclone.umounted_ok", name=result['name'], mountpoint=result['mountpoint']))
    return 0


def _cli_probe(args: Any, as_json: bool) -> int:
    payload = probe(args.name, wait_seconds=PROBE_WAIT_SECONDS)
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    if payload.get("running"):
        print(tr("cli.rclone.probe_running_line", note=payload.get('note') or ''))
    if not payload.get("ok"):
        print(tr("cli.rclone.probe_failed", error=payload.get('error')))
        return 1
    print(tr("cli.rclone.probe_ok", name=args.name, dirs=payload.get('dirs', 0),
              files=payload.get('files', 0), total=_human(payload.get('total')) or '—',
              free=_human(payload.get('free')) or '—', ms=payload.get('took_ms')))
    names = payload.get("names") or []
    if names:
        print(tr("cli.rclone.probe_names", names=_sep().join(names[:5])))
    return 0
