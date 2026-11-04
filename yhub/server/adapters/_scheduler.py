"""Y-Hub scheduled-jobs core (cron-style scheduling).

In one sentence: **read the job list in `~/.config/yhub/schedule.json`, keep a tick thread alive
inside the backend process, run scripts as subprocesses when they are due, append every run to
`runs.jsonl`, and expose state for the dashboard and the panel.**

The contract the dashboard chain relies on (three fields) is in ``job_view()``: ``status`` /
``summary`` / ``detail`` with the same meaning as dashboard cells (ok / warn / alert), so a job's
verdict flows straight onto the wall.

Three design choices:
  * **Lives with the Y-Hub backend process**: scheduling only happens while the backend runs
    (`yhub gui` or the embedded backend launched by the desktop shell). Not scheduling when the
    backend is down is deliberate (no launchd daemon, so two schedulers never fight). For headless
    timing use `yhub schedule tick` and hand it to the OS scheduler, see README.
  * **Config is data** (File over app): hand edits to the job list take effect on the next tick;
    there is no write endpoint, and "run now" in the UI only triggers a run, never a config change.
  * **Never invent state**: never ran means never ran; a failure reports the exit code and the
    tail, never a glib "all good".

Secret rule: a job's stdout/stderr keeps only the last 400 characters, and **only on failure**
(`out_tail`). Job scripts must not print their own credentials -- that is spelled out in the
"writing a job" section of the README.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import shlex
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from yhub.i18n import tr

LOG = logging.getLogger("yhub.scheduler")

#: Display timezone: the machine's local zone (see _cell_fetch.local_tz).
from ._cell_fetch import TZ  # noqa: E402  (re-export: one definition for the whole backend)
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
CELL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")

DEFAULT_TIMEOUT = 300
MAX_TIMEOUT = 3600
DEFAULT_TICK_SECONDS = 30
MIN_TICK_SECONDS = 10
OUT_TAIL_LIMIT = 400
RUN_RETENTION_DAYS = 14
RUN_RETENTION_COUNT = 500

# Default job list (starts empty; the user configures jobs freely in schedule.json)
def _default_jobs() -> list[dict[str, Any]]:
    return []


# --------------------------------------------------------------- paths and config


def base_dir() -> Path:
    """Config root: ``YHUB_SCHEDULE_DIR`` (tests) → the shared root from ``settings.config_dir()``.

    Following ``YHUB_CONFIG_DIR`` matters beyond tidiness: acceptance runs must never read (or run
    jobs from) the developer's real ``schedule.json``.
    """
    raw = os.environ.get("YHUB_SCHEDULE_DIR", "").strip()
    if raw:
        return Path(raw).expanduser()
    from .settings import config_dir

    return config_dir()


def config_file() -> Path:
    return base_dir() / "schedule.json"


def runs_file() -> Path:
    return base_dir() / "schedule" / "runs.jsonl"


def load_config() -> dict[str, Any]:
    """Read ``schedule.json``. Missing = default jobs; unparsable = run defaults and log one line."""
    path = config_file()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception as exc:  # broken JSON must not kill scheduling entirely
        LOG.warning("[cron] 任务表读不懂（%s：%s），本次按默认任务跑", path, exc)
        return {}
    if not isinstance(data, dict):
        LOG.warning("[cron] 任务表顶层不是对象（%s），本次按默认任务跑", path)
        return {}
    return data


def scheduler_enabled() -> bool:
    """Master switch: ``enabled: false`` stops scheduling only, not "run now" / history."""
    return load_config().get("enabled") is not False


def tick_seconds() -> int:
    raw = load_config().get("tick_seconds")
    if isinstance(raw, int) and not isinstance(raw, bool) and raw >= MIN_TICK_SECONDS:
        return min(raw, 3600)
    return DEFAULT_TICK_SECONDS


def _expand(path: str) -> str:
    return os.path.expanduser(str(path))


def _parse_every(text: Any) -> int | None:
    """``"30m"`` / ``"6h"`` / ``"1d"`` -> seconds. Returns None when unrecognized (never guess on a typo)."""
    if not isinstance(text, str):
        return None
    match = re.match(r"^\s*(\d+)\s*(s|m|h|d)\s*$", text)
    if not match:
        return None
    amount = int(match.group(1))
    if amount <= 0:
        return None
    return amount * {"s": 1, "m": 60, "h": 3600, "d": 86400}[match.group(2)]


def _parse_clock(text: Any) -> tuple[int, int] | None:
    if not isinstance(text, str):
        return None
    match = re.match(r"^\s*(\d{1,2}):(\d{2})\s*$", text)
    if not match:
        return None
    hour, minute = int(match.group(1)), int(match.group(2))
    if hour > 23 or minute > 59:
        return None
    return hour, minute


# --------------------------------------------------------------------- cron expressions

_CRON_FIELD_RE = re.compile(r"^(\*|\d{1,2})(?:-(\d{1,2}))?(?:/(\d{1,2}))?$")


def _cron_field(expr: str, low: int, high: int) -> set[int] | None:
    """Parse one cron field: ``*`` / ``a`` / ``a-b`` / ``a-b/n`` / ``*/n`` / comma unions."""
    values: set[int] = set()
    for part in expr.split(","):
        part = part.strip()
        if not part:
            return None
        match = _CRON_FIELD_RE.match(part)
        if not match:
            return None
        start_s, end_s, step_s = match.group(1), match.group(2), match.group(3)
        step = int(step_s) if step_s else 1
        if step <= 0:
            return None
        if start_s == "*":
            start, end = low, high
        else:
            start = int(start_s)
            end = int(end_s) if end_s else start
        if end_s and start > end:
            return None
        if start < low or end > high:
            return None
        values.update(range(start, end + 1, step))
    return values or None


def parse_cron(expr: str) -> dict[str, set[int]] | None:
    """Standard 5 fields: minute hour day month weekday (0/7 = Sunday). Extensions like
    ``L``/``W``/``?`` are not supported."""
    if not isinstance(expr, str):
        return None
    parts = expr.split()
    if len(parts) != 5:
        return None
    minutes = _cron_field(parts[0], 0, 59)
    hours = _cron_field(parts[1], 0, 23)
    days = _cron_field(parts[2], 1, 31)
    months = _cron_field(parts[3], 1, 12)
    weekdays = _cron_field(parts[4].replace("7", "0"), 0, 6)
    if minutes is None or hours is None or days is None or months is None or weekdays is None:
        return None
    return {"minute": minutes, "hour": hours, "day": days, "month": months, "weekday": weekdays}


def _cron_matches(parsed: dict[str, set[int]], moment: datetime) -> bool:
    """Day-of-month and day-of-week are **OR**ed (as in cron): both count only when both are ``*``."""
    if moment.minute not in parsed["minute"] or moment.hour not in parsed["hour"]:
        return False
    if moment.month not in parsed["month"]:
        return False
    dom_restricted = parsed["day"] != set(range(1, 32))
    dow_restricted = parsed["weekday"] != set(range(0, 7))
    dom_ok = moment.day in parsed["day"]
    # Python: Monday=0 … Sunday=6; cron: Sunday=0
    dow_ok = ((moment.weekday() + 1) % 7) in parsed["weekday"]
    if dom_restricted and dow_restricted:
        return dom_ok or dow_ok
    return dom_ok and dow_ok


def cron_after(parsed: dict[str, set[int]], after: datetime) -> datetime | None:
    """Next hit (minute granularity, starting at the minute after `after`; None if nothing within
    366 days)."""
    moment = (after + timedelta(minutes=1)).replace(second=0, microsecond=0)
    limit = moment + timedelta(days=366)
    while moment < limit:
        if _cron_matches(parsed, moment):
            return moment
        moment += timedelta(minutes=1)
    return None


# -------------------------------------------------------------------- job list


def resolve_jobs() -> list[dict[str, Any]]:
    """Default jobs plus config-file overrides/additions; illegal fields fall back to defaults with
    a log line and **never crash**."""
    raw = load_config()
    configured = raw.get("jobs")
    configured = configured if isinstance(configured, list) else []

    specs: dict[str, dict[str, Any]] = {job["id"]: dict(job) for job in _default_jobs()}
    order: list[str] = [job["id"] for job in _default_jobs()]

    for entry in configured:
        if not isinstance(entry, dict):
            continue
        job_id = str(entry.get("id") or "").strip()
        if not ID_RE.match(job_id):
            LOG.warning("[cron] 任务 id 不合法（%r），跳过这条", entry.get("id"))
            continue
        base = specs.get(job_id, {"id": job_id})
        merged = dict(base)
        merged.update({k: v for k, v in entry.items() if v is not None})
        merged["id"] = job_id
        if job_id not in order:
            order.append(job_id)
        specs[job_id] = merged

    jobs = []
    for job_id in order:
        job = _normalize_job(specs[job_id])
        if job is not None:
            jobs.append(job)
    return jobs


def _normalize_job(raw: dict[str, Any]) -> dict[str, Any] | None:
    job_id = str(raw.get("id") or "").strip()
    if not ID_RE.match(job_id):
        return None

    command = raw.get("command")
    if isinstance(command, str):
        command = shlex.split(command)
    if isinstance(command, list):
        command = [str(part) for part in command if str(part).strip() != ""]
    else:
        command = []
    # `~/…` is expanded here (subprocesses do not understand a tilde -- a script path passed
    # through verbatim made python exit 2)
    command = [(_expand(part) if part.startswith("~") else part) for part in command]
    if not command:
        LOG.warning("[cron] 任务 %s 没有 command，跳过", job_id)
        return None

    cron_expr = str(raw.get("cron") or "").strip()
    parsed_cron = parse_cron(cron_expr) if cron_expr else None
    every = _parse_every(raw.get("every"))
    at = _parse_clock(raw.get("at"))
    if parsed_cron is None and every is None:
        LOG.warning("[cron] 任务 %s 的 schedule 认不出来（cron=%r every=%r），跳过",
                    job_id, cron_expr, raw.get("every"))
        return None

    timeout = raw.get("timeout")
    if not (isinstance(timeout, int) and not isinstance(timeout, bool) and timeout > 0):
        timeout = DEFAULT_TIMEOUT
    timeout = min(timeout, MAX_TIMEOUT)

    result_path = str(raw.get("result_path") or "").strip()
    report_path = str(raw.get("report_path") or "").strip()
    href = str(raw.get("href") or "").strip()
    if not href and report_path:
        href = f"/api/scheduler/jobs/{job_id}/report"

    return {
        "id": job_id,
        "title": str(raw.get("title") or job_id)[:24],
        "description": str(raw.get("description") or ""),
        "command": command,
        "cwd": _expand(raw.get("cwd") or "~"),
        "cron": cron_expr,
        "cron_parsed": parsed_cron,
        "every": every,
        "at": at,
        "timeout": timeout,
        "enabled": raw.get("enabled") is not False,
        "critical": raw.get("critical") is True,
        "result_path": result_path,
        "report_path": report_path,
        "href": href,
    }


def find_job(job_id: str) -> dict[str, Any] | None:
    for job in resolve_jobs():
        if job["id"] == job_id:
            return job
    return None


def schedule_text(job: dict[str, Any]) -> str:
    """Human-readable schedule description (used by both the UI and the dashboard -- never write a
    second copy)."""
    if job.get("cron"):
        return f"cron {job['cron']}"
    every = job.get("every") or 0
    at = job.get("at")
    if every >= 86400 and at:
        days = every // 86400
        at_text = f"{at[0]:02d}:{at[1]:02d}"
        if days == 1:
            return tr("scheduler.schedule.daily", at=at_text)
        return tr("scheduler.schedule.every_days", days=days, at=at_text)
    anchor = tr("scheduler.schedule.anchor", at=f"{at[0]:02d}:{at[1]:02d}") if at else ""
    if every and every % 3600 == 0:
        return tr("scheduler.schedule.every_hours", hours=every // 3600, anchor=anchor)
    if every and every % 60 == 0:
        return tr("scheduler.schedule.every_minutes", minutes=every // 60, anchor=anchor)
    return tr("scheduler.schedule.every_seconds", seconds=every)


def period_seconds(job: dict[str, Any]) -> int | None:
    """Nominal interval between two runs (used by the dashboard to derive staleness thresholds)."""
    if job.get("every"):
        return int(job["every"])
    parsed = job.get("cron_parsed")
    if not parsed:
        return None
    now = datetime.now(TZ)
    first = cron_after(parsed, now)
    if first is None:
        return None
    second = cron_after(parsed, first)
    if second is None:
        return None
    return int((second - first).total_seconds())


def next_due(job: dict[str, Any], after_epoch: float | None) -> datetime | None:
    """Next moment this job should run. ``after_epoch`` = last run time (None when never ran).

    The semantics are "**the first slot after the last run**" -- so it may lie in the past
    (= overdue, the next tick catches up immediately); callers (tick / job_view) must read it
    that way and not assume it is always in the future.
    """
    if job.get("cron"):
        parsed = job.get("cron_parsed")
        if not parsed:
            return None
        base = datetime.fromtimestamp(after_epoch, TZ) if after_epoch else datetime.now(TZ)
        return cron_after(parsed, base)
    every = job.get("every")
    if not every:
        return None
    base = datetime.fromtimestamp(after_epoch, TZ) if after_epoch else datetime.now(TZ)
    step = timedelta(seconds=every)
    at = job.get("at")
    if at:
        anchor = base.replace(hour=at[0], minute=at[1], second=0, microsecond=0)
    else:
        anchor = base.replace(hour=0, minute=0, second=0, microsecond=0)
    # Count forward from the anchor in `every` steps and take the first slot **strictly after**
    # base. This must use timedelta floor division: an earlier version computed
    # int((base-anchor).total_seconds()/every), which truncates toward zero and, when base fell
    # before the anchor, pushed the next slot a whole step too late (a missed run).
    steps = (base - anchor) // step + 1
    return anchor + step * steps


def job_ready(job: dict[str, Any]) -> tuple[bool, str]:
    """Whether the job can run: the first command argument is an executable / existing script
    (nothing else is guessed)."""
    program = job["command"][0]
    if os.path.sep in program:
        if not Path(_expand(program)).exists():
            return False, tr("scheduler.ready.no_binary", program=program)
    else:
        if not _which(program):
            return False, tr("scheduler.ready.not_in_path", program=program)
    for part in job["command"][1:]:
        if part.startswith("-"):
            continue
        if os.path.sep in part or part.endswith(".py"):
            if not Path(_expand(part)).exists():
                return False, tr("scheduler.ready.no_script", path=part)
    cwd = Path(job["cwd"])
    if not cwd.is_dir():
        return False, tr("scheduler.ready.no_cwd", path=job["cwd"])
    return True, tr("scheduler.ready.ok")


def _which(program: str) -> str | None:
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        candidate = Path(directory) / program
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


# -------------------------------------------------------------------- run history

_STATE_LOCK = threading.Lock()
_started_lock = threading.Lock()
_TICK_THREAD_LOCK = threading.Lock()
_thread: threading.Thread | None = None
_stop = threading.Event()


@contextlib.contextmanager
def _tick_lock():
    """Cross-thread and cross-process non-blocking mutex, so only one tick runs machine-wide at a time."""
    acquired_thread = _TICK_THREAD_LOCK.acquire(blocking=False)
    if not acquired_thread:
        yield False
        return

    lock_file = None
    acquired_file = False
    lock_path = base_dir() / "schedule" / ".tick.lock"
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_file = open(lock_path, "a+", encoding="utf-8")
        if sys.platform == "win32":
            import msvcrt

            lock_file.seek(0)
            try:
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                acquired_file = True
            except OSError:
                acquired_file = False
        else:
            import fcntl

            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired_file = True
            except (OSError, BlockingIOError):
                acquired_file = False

        yield acquired_file
    finally:
        if acquired_file and lock_file is not None:
            try:
                if sys.platform == "win32":
                    import msvcrt

                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            except Exception:
                pass
        if lock_file is not None:
            try:
                lock_file.close()
            except Exception:
                pass
        _TICK_THREAD_LOCK.release()


# One run lock per job (a single job never runs two instances at once)
_job_locks: dict[str, threading.Lock] = {}
_history_loaded = False
# job_id -> {"last": record|None, "fail_streak": int, "next_due": float|None}
_state: dict[str, dict[str, Any]] = {}


def _state_of(job_id: str) -> dict[str, Any]:
    state = _state.get(job_id)
    if state is None:
        state = _state[job_id] = {"last": None, "fail_streak": 0, "next_due": None}
    return state


def _read_runs() -> list[dict]:
    path = runs_file()
    if not path.is_file():
        return []
    records: list[dict] = []
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        LOG.warning("[cron] 运行历史读不了：%s", exc)
        return []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue  # skip a corrupt line; one bad line must not destroy the whole history
        if isinstance(record, dict) and record.get("job"):
            records.append(record)
    return records


def _load_history() -> None:
    """Load history at startup: after a restart "last run / consecutive failures" survive
    (read once, never re-read in full)."""
    global _history_loaded
    with _STATE_LOCK:
        if _history_loaded:
            return
        by_job: dict[str, list[dict]] = {}
        for record in _read_runs():
            by_job.setdefault(record["job"], []).append(record)
            _state_of(record["job"])["last"] = record  # the file appends in time order; last line wins
        for job_id, items in by_job.items():
            streak = 0
            for record in reversed(items):
                if record.get("status") == "ok":
                    break
                streak += 1
            _state_of(job_id)["fail_streak"] = streak
        _history_loaded = True


def _append_run(record: dict) -> None:
    path = runs_file()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as exc:
        LOG.warning("[cron] 运行历史写不进去（%s）", exc)


def _prune_runs() -> None:
    """14 days / 500 records, oldest dropped first (same retention scheme as dashboard snapshots)."""
    records = _read_runs()
    if not records:
        return
    cutoff = time.time() - RUN_RETENTION_DAYS * 86400
    kept = []
    for record in records:
        try:
            stamp = datetime.fromisoformat(str(record.get("started_at"))).timestamp()
        except Exception:
            stamp = time.time()
        if stamp >= cutoff:
            kept.append(record)
    kept = kept[-RUN_RETENTION_COUNT:]
    if len(kept) == len(records):
        return
    path = runs_file()
    try:
        tmp = path.with_name(f".{path.name}.tmp")
        tmp.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in kept), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as exc:
        LOG.warning("[cron] 历史修剪失败（%s）", exc)


def recent_runs(job_id: str | None = None, limit: int = 20) -> list[dict]:
    records = _read_runs()
    if job_id:
        records = [r for r in records if r["job"] == job_id]
    return list(reversed(records))[: max(1, min(limit, 200))]


# -------------------------------------------------------------------------- runs


def _out_tail(text: str) -> str:
    text = (text or "").strip()
    if len(text) > OUT_TAIL_LIMIT:
        text = "…" + text[-OUT_TAIL_LIMIT:]
    return text


def run_job(job_id: str, trigger: str = "manual") -> dict:
    """Run a job once (synchronously). If the previous run of the same job is still going, refuse
    rather than queue."""
    job = find_job(job_id)
    if job is None:
        raise LookupError(tr("scheduler.job_not_found", job_id=job_id))

    ready, reason = job_ready(job)
    if not ready:
        raise RuntimeError(reason)

    lock = _job_locks.setdefault(job_id, threading.Lock())
    if not lock.acquire(blocking=False):
        raise RuntimeError(tr("scheduler.run.still_running", title=job["title"]))

    started = datetime.now(TZ)
    started_mono = time.monotonic()
    status = "ok"
    exit_code: int | None = None
    tail = ""
    timed_out = False
    error = ""
    try:
        env = os.environ.copy()
        env.update({
            "YHUB_JOB_ID": job_id,
            "YHUB_JOB_TRIGGER": trigger,
            "YHUB_JOB_NAME": job["title"],
        })
        try:
            proc = subprocess.run(
                job["command"],
                cwd=job["cwd"],
                env=env,
                capture_output=True,
                text=True,
                timeout=job["timeout"],
            )
        except subprocess.TimeoutExpired:
            timed_out = True
            status = "timeout"
            error = tr("scheduler.run.timeout", seconds=job["timeout"])
        except FileNotFoundError as exc:
            status = "error"
            error = tr("scheduler.run.spawn_failed", error=exc)
        except OSError as exc:
            status = "error"
            error = tr("scheduler.run.start_failed", error=exc.strerror or exc)
        else:
            exit_code = proc.returncode
            if proc.returncode != 0:
                status = "fail"
            tail = _out_tail((proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else ""))
    finally:
        lock.release()

    finished = datetime.now(TZ)
    record = {
        "job": job_id,
        "trigger": trigger,
        "status": status,
        "started_at": started.isoformat(timespec="seconds"),
        "finished_at": finished.isoformat(timespec="seconds"),
        "duration_ms": int((time.monotonic() - started_mono) * 1000),
        "exit_code": exit_code,
        "timed_out": timed_out,
        "error": error,
        # Keep the tail only on failure (saves space; job scripts must not print credentials)
        "out_tail": tail if status != "ok" else "",
    }
    LOG.info("[cron] %s 跑完 status=%s exit=%s 用时 %sms（%s）",
             job_id, status, exit_code, record["duration_ms"], trigger)

    with _STATE_LOCK:
        state = _state_of(job_id)
        state["last"] = record
        state["fail_streak"] = 0 if status == "ok" else state.get("fail_streak", 0) + 1
        state["running"] = False
    _append_run(record)
    _prune_runs()
    return record


def tick(trigger: str = "schedule") -> list[dict]:
    """Run every "due" job once (serially). Returns the records of the runs that actually happened."""
    if not scheduler_enabled():
        return []
    with _tick_lock() as acquired:
        if not acquired:
            LOG.info("[cron] tick: 另一个调度实例正在执行，跳过本次 tick")
            return []
        _load_history()
        now = datetime.now(TZ)
        ran: list[dict] = []
        for job in resolve_jobs():
            if not job["enabled"]:
                continue
            due = due_at(job)
            if due is None or due > now:
                continue
            ready, reason = job_ready(job)
            if not ready:
                # Not ready: leave the last run record alone (the job can run on the next tick once
                # the script shows up), but record a skip at most once an hour so "why did this never
                # run" stays answerable.
                LOG.warning("[cron] %s 没就绪（%s），这次跳过", job["id"], reason)
                _record_skip(job, reason, trigger)
                continue
            try:
                ran.append(run_job(job["id"], trigger=trigger))
            except Exception as exc:  # one failing job must not drag the others down
                LOG.warning("[cron] %s 运行失败：%s", job["id"], exc)
        return ran


_skip_stamps: dict[str, float] = {}


def _record_skip(job: dict, reason: str, trigger: str) -> None:
    """Record a "did not start" entry (leaves last / fail_streak alone besides the stated case, see
    the note in tick)."""
    now_mono = time.monotonic()
    last_stamp = _skip_stamps.get(job["id"], 0.0)
    if now_mono - last_stamp < 3600 and trigger == "schedule":
        return
    _skip_stamps[job["id"]] = now_mono
    now = datetime.now(TZ)
    record = {
        "job": job["id"], "trigger": trigger, "status": "error",
        "started_at": now.isoformat(timespec="seconds"),
        "finished_at": now.isoformat(timespec="seconds"),
        "duration_ms": 0, "exit_code": None, "timed_out": False,
        "error": reason, "out_tail": "",
    }
    _append_run(record)


def due_at(job: dict) -> datetime | None:
    """When this job should run next (cached, invalidated after a run)."""
    state = _state_of(job["id"])
    cached = state.get("next_due_epoch")
    last = state.get("last") or {}
    stamp = last.get("started_at")
    if cached is not None and state.get("next_due_for") == stamp:
        return datetime.fromtimestamp(cached, TZ)
    after_epoch = None
    if stamp:
        try:
            after_epoch = datetime.fromisoformat(stamp).timestamp()
        except ValueError:
            after_epoch = None
    nxt = next_due(job, after_epoch)
    with _STATE_LOCK:
        state["next_due_for"] = stamp
        state["next_due_epoch"] = nxt.timestamp() if nxt else None
    return nxt


# ---------------------------------------------------------------- thread scheduling


def ensure_started() -> bool:
    """Start the tick thread (idempotent). Not started when the master switch is off."""
    global _thread
    if not scheduler_enabled():
        return False
    with _started_lock:
        if _thread is not None and _thread.is_alive():
            return False
        _stop.clear()
        _thread = threading.Thread(target=_loop, name="yhub-scheduler", daemon=True)
        _thread.start()
        LOG.info("[cron] 调度线程已起：tick=%ss 任务=%d", tick_seconds(), len(resolve_jobs()))
        return True


def stop() -> None:
    """Stop the tick thread (for tests; on a normal exit the daemon thread goes by itself)."""
    _stop.set()


def _loop() -> None:
    _load_history()
    while not _stop.wait(tick_seconds()):
        try:
            tick()
        except Exception as exc:  # the scheduler thread must never die on one exception
            LOG.warning("[cron] tick 出错（已忽略，下一轮继续）：%s", exc)


def started() -> bool:
    return _thread is not None and _thread.is_alive()


# ------------------------------------------------------------ views (wall / UI)


def _read_result(job: dict) -> dict | None:
    """The verdict a job wrote itself (JSON at ``result_path``); a broken file counts as absent."""
    path_text = job.get("result_path")
    if not path_text:
        return None
    path = Path(_expand(path_text))
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except Exception as exc:
        LOG.warning("[cron] %s 的结果文件读不懂（%s：%s）", job["id"], path, exc)
        return None
    return data if isinstance(data, dict) else None


def _result_is_fresh(result: dict | None, last: dict | None) -> bool:
    """Was the result file written after this run? (Without timestamps, trust it -- better than
    inventing state.)"""
    if not result:
        return False
    if not last:
        return True
    written = result.get("generated_at") or result.get("captured_at")
    started = last.get("started_at")
    if not written or not started:
        return True
    try:
        return datetime.fromisoformat(str(written)).timestamp() >= (
            datetime.fromisoformat(str(started)).timestamp() - 60
        )
    except ValueError:
        return True


def job_view(job: dict) -> dict[str, Any]:
    """Current view of one job: three-state status + one-line summary + detail + timestamps (wall
    cells use this directly).

    ``status`` rules:
      * scheduling off / job disabled / script missing -> warn (no fake green)
      * never ran -> warn
      * last run succeeded -> ok (lateness is judged by the wall via stale_after, see R5)
      * last run failed: >= 2 in a row or critical -> alert, otherwise warn
    """
    _load_history()
    state = _state_of(job["id"])
    last = state.get("last")
    streak = state.get("fail_streak", 0)
    result = _read_result(job)
    due = due_at(job)
    schedule_label = schedule_text(job)
    ready, reason = job_ready(job)
    # A result file counts only when it is newer than this run (otherwise it may be the previous
    # round's stale verdict)
    fresh_result = result if _result_is_fresh(result, last) else None

    updated_epoch = None
    if last:
        try:
            updated_epoch = datetime.fromisoformat(str(last.get("started_at"))).timestamp()
        except ValueError:
            updated_epoch = None

    detail: list[dict] = []
    source_error = None
    if not scheduler_enabled():
        status = "warn"
        summary = tr("scheduler.cell.schedule_off")
        source_error = {"message": summary, "hint": tr("scheduler.cell.schedule_off_hint")}
    elif not job["enabled"]:
        status = "warn"
        summary = tr("scheduler.cell.job_disabled", schedule=schedule_label)
    elif not ready:
        status = "warn"
        summary = reason
        source_error = {"message": reason, "hint": tr("scheduler.not_ready_hint")}
    elif last is None:
        status = "warn"
        when = due.strftime("%m-%d %H:%M") if due else tr("scheduler.unknown")
        summary = tr("scheduler.cell.never_ran", schedule=schedule_label, when=when)
    elif last.get("status") == "ok":
        adopted = fresh_result or {}
        status = str(adopted.get("status") or "ok")
        if status not in ("ok", "warn", "alert"):
            status = "ok"
        verb = {
            "schedule": tr("scheduler.trigger.schedule"),
            "manual": tr("scheduler.trigger.manual"),
            "cli": tr("scheduler.trigger.cli"),
        }.get(str(last.get("trigger")), "")
        summary = str(adopted.get("summary") or tr(
            "scheduler.cell.run_ok", verb=verb, duration=_ms(last.get("duration_ms"))))
        for item in (adopted.get("detail") or [])[:5]:
            if isinstance(item, dict) and str(item.get("text", "")).strip():
                entry = {"text": str(item["text"])[:80]}
                if item.get("href"):
                    entry["href"] = str(item["href"])
                detail.append(entry)
    else:
        status = "alert" if (streak >= 2 or job["critical"]) else "warn"
        last_state = str(last.get("status"))
        kind = tr("scheduler.state.timeout" if last_state == "timeout" else
                  "scheduler.state.fail" if last_state == "fail" else
                  "scheduler.state.error" if last_state == "error" else
                  "scheduler.state.failed")
        detail_text = str(last.get("error") or tr("scheduler.cell.exit_code", code=last.get("exit_code")))
        summary = tr("scheduler.cell.failed", kind=kind, detail=detail_text)
        if streak >= 2:
            summary += tr("scheduler.cell.streak", count=streak)
        source_error = {"message": summary, "hint": tr("scheduler.cell.failed_hint")}

    if due:
        overdue = due <= datetime.now(TZ)
        detail.append({
            "text": tr("scheduler.detail.next_overdue") if overdue
            else tr("scheduler.detail.next", when=due.strftime("%m-%d %H:%M"))
        })
    if last:
        detail.append({
            "text": tr("scheduler.detail.last", when=_when(updated_epoch),
                       duration=_ms(last.get("duration_ms")))
                    + (f" · exit {last.get('exit_code')}" if last.get("exit_code") is not None else ""),
        })

    return {
        "id": job["id"],
        "title": job["title"],
        "description": job["description"],
        "schedule": schedule_label,
        "enabled": job["enabled"],
        "critical": job["critical"],
        "ready": ready,
        "ready_reason": reason,
        "status": status,
        "summary": summary,
        "detail": detail[:5],
        "updated_at": datetime.fromtimestamp(updated_epoch, TZ).isoformat(timespec="seconds") if updated_epoch else None,
        "next_due": due.isoformat(timespec="seconds") if due else None,
        "last_run": last,
        "fail_streak": streak,
        "href": _job_href(job),
        "report": bool(job.get("report_path")),
        "source_error": source_error,
    }


def _job_href(job: dict) -> str:
    href = str(job.get("href") or "")
    if href.startswith("/"):
        # A path relative to the backend itself: for the UI; the dashboard expands it to an absolute URL
        return href
    return href or "#"


def _ms(value: Any) -> str:
    try:
        ms = int(value)
    except (TypeError, ValueError):
        return "—"
    if ms < 1000:
        return f"{ms} ms"
    if ms < 60_000:
        return f"{ms / 1000:.1f} s"
    return tr("scheduler.duration.minutes_seconds", minutes=ms // 60000,
              seconds=round((ms % 60000) / 1000))


def _when(epoch: float | None) -> str:
    if not epoch:
        return "—"
    moment = datetime.fromtimestamp(epoch, TZ)
    now = datetime.now(TZ)
    if moment.date() == now.date():
        return moment.strftime("%H:%M")
    if moment.date() == now.date() - timedelta(days=1):
        return tr("scheduler.when.yesterday", time=moment.strftime("%H:%M"))
    return moment.strftime("%m-%d %H:%M")


def overview() -> dict[str, Any]:
    """Overview of the whole scheduler (shared by the panel and the CLI)."""
    _load_history()
    jobs = resolve_jobs()
    return {
        "enabled": scheduler_enabled(),
        "tick_seconds": tick_seconds(),
        "started": started(),
        "config_path": str(config_file()),
        "runs_path": str(runs_file()),
        "now": datetime.now(TZ).isoformat(timespec="seconds"),
        "jobs": [job_view(job) for job in jobs],
    }


def ensure_started_from_wall() -> None:
    """Ensure the scheduler thread runs whenever the dashboard fetches (scheduling starts as soon
    as the backend is opened, without waiting for the UI)."""
    try:
        ensure_started()
    except Exception as exc:  # failing to start the thread must not make the whole wall unopenable
        LOG.warning("[cron] 调度线程没起来：%s", exc)
