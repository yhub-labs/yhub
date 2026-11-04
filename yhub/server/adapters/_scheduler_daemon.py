"""Cross-platform management of the OS-level scheduling daemon (macOS launchd / Linux systemd or
crontab / Windows schtasks).

Goals:
  * **Jobs keep running after the app quits**.
  * A single heartbeat bus: the OS scheduler wakes ``yhub schedule tick`` on a fixed cadence (once
    a minute).
  * The cross-process file lock in ``_scheduler.py`` keeps it mutually exclusive with the
    foreground GUI scheduler thread and prevents re-entry.
"""

from __future__ import annotations

import logging
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from yhub.i18n import tr

from . import _scheduler as sched

LOG = logging.getLogger("yhub.scheduler.daemon")

TASK_NAME = "YHubScheduler"
LAUNCHD_LABEL = "com.yhub.scheduler"


def resolve_target_command(override: list[str] | None = None) -> list[str]:
    """Determine the absolute command the OS scheduler should execute."""
    if override:
        return list(override)

    env_cmd = os.environ.get("YHUB_DAEMON_CMD", "").strip()
    if env_cmd:
        return shlex.split(env_cmd)

    # 1. A yhub command already on PATH
    yhub_bin = shutil.which("yhub")
    if yhub_bin:
        # make sure it is absolute
        return [str(Path(yhub_bin).resolve()), "schedule", "tick"]

    # 2. Source-tree mode: Python interpreter + module run
    py_bin = str(Path(sys.executable).resolve())
    return [py_bin, "-m", "yhub.cli.main", "schedule", "tick"]


def _run_cmd(cmd: list[str], timeout: float = 5.0) -> subprocess.CompletedProcess[str]:
    """Run an OS command, capturing exceptions as a result."""
    try:
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except Exception as exc:
        return subprocess.CompletedProcess(
            args=cmd,
            returncode=1,
            stdout="",
            stderr=str(exc),
        )


# --------------------------------------------------------------------- macOS (launchd)


class _DarwinDaemon:
    @staticmethod
    def plist_path() -> Path:
        raw = os.environ.get("YHUB_LAUNCHD_DIR", "").strip()
        base = Path(raw).expanduser() if raw else Path.home() / "Library" / "LaunchAgents"
        return base / f"{LAUNCHD_LABEL}.plist"

    @classmethod
    def status(cls) -> dict[str, Any]:
        path = cls.plist_path()
        installed = path.is_file()
        active = False
        target: list[str] = []

        if installed:
            # try to read the target back out
            try:
                content = path.read_text(encoding="utf-8")
                # simple ProgramArguments parse
                import xml.etree.ElementTree as ET

                root = ET.fromstring(content)
                dict_el = root.find("dict")
                if dict_el is not None:
                    children = list(dict_el)
                    for i, child in enumerate(children):
                        if child.tag == "key" and child.text == "ProgramArguments":
                            arr = children[i + 1]
                            target = [s.text or "" for s in arr.findall("string")]
                            break
            except Exception:
                pass

            # check launchctl
            res = _run_cmd(["launchctl", "list", LAUNCHD_LABEL])
            if res.returncode == 0:
                active = True
            else:
                # try print gui/<uid>/label
                uid = os.getuid() if hasattr(os, "getuid") else 0
                res2 = _run_cmd(["launchctl", "print", f"gui/{uid}/{LAUNCHD_LABEL}"])
                active = res2.returncode == 0

        msg = tr("scheduler.daemon.not_installed")
        if installed:
            msg = tr("scheduler.daemon.launchd_active") if active else tr("scheduler.daemon.launchd_inactive")

        return {
            "ok": True,
            "platform": "darwin",
            "backend": "launchd",
            "installed": installed,
            "active": active,
            "target": target or resolve_target_command(),
            "config_path": str(path),
            "message": msg,
        }

    @classmethod
    def install(cls, target_cmd: list[str]) -> dict[str, Any]:
        path = cls.plist_path()
        path.parent.mkdir(parents=True, exist_ok=True)

        log_dir = sched.base_dir() / "schedule"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "daemon.log"
        err_path = log_dir / "daemon.err"

        # unregister an existing task with the same name first
        cls.uninstall()

        args_xml = "\n".join(f"        <string>{arg}</string>" for arg in target_cmd)
        plist_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
{args_xml}
    </array>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>{log_path}</string>
    <key>StandardErrorPath</key>
    <string>{err_path}</string>
</dict>
</plist>
"""
        try:
            path.write_text(plist_content, encoding="utf-8")
        except OSError as exc:
            return {
                "ok": False,
                "platform": "darwin",
                "backend": "launchd",
                "error": tr("scheduler.daemon.plist_write_failed", error=exc),
                "hint": tr("scheduler.daemon.plist_write_failed_hint", path=path.parent),
            }

        uid = os.getuid() if hasattr(os, "getuid") else 0
        boot_res = _run_cmd(["launchctl", "bootstrap", f"gui/{uid}", str(path)])
        if boot_res.returncode != 0:
            load_res = _run_cmd(["launchctl", "load", "-w", str(path)])
            if load_res.returncode != 0:
                err_msg = load_res.stderr.strip() or boot_res.stderr.strip() or tr("scheduler.daemon.launchctl_failed")
                return {
                    "ok": False,
                    "platform": "darwin",
                    "backend": "launchd",
                    "error": tr("scheduler.daemon.load_failed", error=err_msg),
                    "hint": tr("scheduler.daemon.load_failed_hint", path=path),
                }

        return {
            "ok": True,
            "platform": "darwin",
            "backend": "launchd",
            "installed": True,
            "active": True,
            "target": target_cmd,
            "config_path": str(path),
            "message": tr("scheduler.daemon.launchd_installed"),
        }

    @classmethod
    def uninstall(cls) -> dict[str, Any]:
        path = cls.plist_path()
        uid = os.getuid() if hasattr(os, "getuid") else 0
        _run_cmd(["launchctl", "bootout", f"gui/{uid}/{LAUNCHD_LABEL}"])
        _run_cmd(["launchctl", "unload", "-w", str(path)])

        if path.is_file():
            try:
                path.unlink()
            except OSError as exc:
                return {
                    "ok": False,
                    "platform": "darwin",
                    "backend": "launchd",
                    "error": tr("scheduler.daemon.remove_failed", error=exc),
                }

        return {
            "ok": True,
            "platform": "darwin",
            "backend": "launchd",
            "installed": False,
            "active": False,
            "message": tr("scheduler.daemon.launchd_removed"),
        }


# --------------------------------------------------------------------- Linux (systemd / cron)


class _LinuxDaemon:
    CRON_TAG = "# yhub-scheduler"

    @classmethod
    def has_systemd_user(cls) -> bool:
        if not shutil.which("systemctl"):
            return False
        res = _run_cmd(["systemctl", "--user", "is-system-running"])
        # running, degraded, starting all count as available; a dead or session-less one errors
        return res.returncode == 0 or "degraded" in res.stdout or "running" in res.stdout

    @classmethod
    def service_path(cls) -> Path:
        raw = os.environ.get("YHUB_SYSTEMD_DIR", "").strip()
        base = Path(raw).expanduser() if raw else Path.home() / ".config" / "systemd" / "user"
        return base / "yhub-scheduler.service"

    @classmethod
    def timer_path(cls) -> Path:
        raw = os.environ.get("YHUB_SYSTEMD_DIR", "").strip()
        base = Path(raw).expanduser() if raw else Path.home() / ".config" / "systemd" / "user"
        return base / "yhub-scheduler.timer"

    @classmethod
    def status(cls) -> dict[str, Any]:
        if cls.has_systemd_user():
            t_path = cls.timer_path()
            installed = t_path.is_file()
            res = _run_cmd(["systemctl", "--user", "is-active", "yhub-scheduler.timer"])
            active = res.returncode == 0 and "active" in res.stdout
            return {
                "ok": True,
                "platform": "linux",
                "backend": "systemd",
                "installed": installed,
                "active": active,
                "target": resolve_target_command(),
                "config_path": str(t_path),
                "message": tr("scheduler.daemon.systemd_active") if active else (
                    tr("scheduler.daemon.systemd_written") if installed else tr("scheduler.daemon.not_installed")),
            }

        # fallback crontab
        res = _run_cmd(["crontab", "-l"])
        installed = cls.CRON_TAG in res.stdout
        return {
            "ok": True,
            "platform": "linux",
            "backend": "crontab",
            "installed": installed,
            "active": installed,
            "target": resolve_target_command(),
            "config_path": "crontab",
            "message": tr("scheduler.daemon.crontab_registered") if installed else tr("scheduler.daemon.crontab_missing"),
        }

    @classmethod
    def install(cls, target_cmd: list[str]) -> dict[str, Any]:
        if cls.has_systemd_user():
            return cls._install_systemd(target_cmd)
        return cls._install_crontab(target_cmd)

    @classmethod
    def _install_systemd(cls, target_cmd: list[str]) -> dict[str, Any]:
        s_path = cls.service_path()
        t_path = cls.timer_path()
        s_path.parent.mkdir(parents=True, exist_ok=True)

        cmd_str = " ".join(shlex.quote(c) for c in target_cmd)
        log_dir = sched.base_dir() / "schedule"
        log_dir.mkdir(parents=True, exist_ok=True)

        service_text = f"""[Unit]
Description=Y-Hub Scheduler Tick Runner

[Service]
Type=oneshot
ExecStart={cmd_str}
StandardOutput=append:{log_dir / 'daemon.log'}
StandardError=append:{log_dir / 'daemon.err'}
"""
        timer_text = """[Unit]
Description=Y-Hub Scheduler 1-minute Tick Timer

[Timer]
OnBootSec=1m
OnUnitActiveSec=1m
AccuracySec=1s
Unit=yhub-scheduler.service

[Install]
WantedBy=timers.target
"""
        try:
            s_path.write_text(service_text, encoding="utf-8")
            t_path.write_text(timer_text, encoding="utf-8")
        except OSError as exc:
            return {"ok": False, "platform": "linux", "backend": "systemd",
                    "error": tr("scheduler.daemon.unit_write_failed", error=exc)}

        _run_cmd(["systemctl", "--user", "daemon-reload"])
        res = _run_cmd(["systemctl", "--user", "enable", "--now", "yhub-scheduler.timer"])
        if res.returncode != 0:
            return {"ok": False, "platform": "linux", "backend": "systemd",
                    "error": tr("scheduler.daemon.timer_start_failed", error=res.stderr.strip())}

        return {
            "ok": True,
            "platform": "linux",
            "backend": "systemd",
            "installed": True,
            "active": True,
            "target": target_cmd,
            "config_path": str(t_path),
            "message": tr("scheduler.daemon.systemd_installed"),
        }

    @classmethod
    def _install_crontab(cls, target_cmd: list[str]) -> dict[str, Any]:
        cmd_str = " ".join(shlex.quote(c) for c in target_cmd)
        line = f"* * * * * {cmd_str} >/dev/null 2>&1 {cls.CRON_TAG}\n"

        cur = _run_cmd(["crontab", "-l"]).stdout
        lines = [ln for ln in cur.splitlines() if cls.CRON_TAG not in ln]
        lines.append(line.strip())
        new_content = "\n".join(lines).strip() + "\n"

        proc = subprocess.run(["crontab", "-"], input=new_content, text=True, capture_output=True)
        if proc.returncode != 0:
            return {"ok": False, "platform": "linux", "backend": "crontab",
                    "error": tr("scheduler.daemon.crontab_write_failed", error=proc.stderr.strip())}

        return {
            "ok": True,
            "platform": "linux",
            "backend": "crontab",
            "installed": True,
            "active": True,
            "target": target_cmd,
            "config_path": "crontab",
            "message": tr("scheduler.daemon.crontab_installed"),
        }

    @classmethod
    def uninstall(cls) -> dict[str, Any]:
        s_path = cls.service_path()
        t_path = cls.timer_path()

        if cls.has_systemd_user():
            _run_cmd(["systemctl", "--user", "disable", "--now", "yhub-scheduler.timer"])
            if s_path.is_file():
                s_path.unlink()
            if t_path.is_file():
                t_path.unlink()
            _run_cmd(["systemctl", "--user", "daemon-reload"])

        # clear leftover tags in crontab
        cur = _run_cmd(["crontab", "-l"]).stdout
        if cls.CRON_TAG in cur:
            lines = [ln for ln in cur.splitlines() if cls.CRON_TAG not in ln]
            new_content = "\n".join(lines).strip() + "\n" if lines else ""
            if new_content:
                subprocess.run(["crontab", "-"], input=new_content, text=True, capture_output=True)
            else:
                _run_cmd(["crontab", "-r"])

        return {
            "ok": True,
            "platform": "linux",
            "backend": "systemd" if cls.has_systemd_user() else "crontab",
            "installed": False,
            "active": False,
            "message": tr("scheduler.daemon.linux_removed"),
        }


# --------------------------------------------------------------------- Windows (schtasks)


class _WindowsDaemon:
    @classmethod
    def status(cls) -> dict[str, Any]:
        res = _run_cmd(["schtasks", "/query", "/tn", TASK_NAME, "/fo", "CSV"])
        installed = res.returncode == 0
        return {
            "ok": True,
            "platform": "win32",
            "backend": "schtasks",
            "installed": installed,
            "active": installed,
            "target": resolve_target_command(),
            "config_path": TASK_NAME,
            "message": tr("scheduler.daemon.schtasks_registered", task=TASK_NAME) if installed
            else tr("scheduler.daemon.schtasks_missing"),
        }

    @classmethod
    def install(cls, target_cmd: list[str]) -> dict[str, Any]:
        # Windows' schtasks /tr wants the whole command string wrapped in quotes
        cmd_str = subprocess.list2cmdline(target_cmd)
        res = _run_cmd([
            "schtasks", "/create",
            "/tn", TASK_NAME,
            "/tr", cmd_str,
            "/sc", "minute",
            "/mo", "1",
            "/f",
        ])
        if res.returncode != 0:
            return {
                "ok": False,
                "platform": "win32",
                "backend": "schtasks",
                "error": tr("scheduler.daemon.schtasks_create_failed", error=res.stderr.strip() or res.stdout.strip()),
            }
        return {
            "ok": True,
            "platform": "win32",
            "backend": "schtasks",
            "installed": True,
            "active": True,
            "target": target_cmd,
            "config_path": TASK_NAME,
            "message": tr("scheduler.daemon.schtasks_installed", task=TASK_NAME),
        }

    @classmethod
    def uninstall(cls) -> dict[str, Any]:
        res = _run_cmd(["schtasks", "/delete", "/tn", TASK_NAME, "/f"])
        if res.returncode != 0 and "ERROR: The system cannot find the file specified" not in res.stderr:
            # a missing task counts as a successful uninstall
            pass
        return {
            "ok": True,
            "platform": "win32",
            "backend": "schtasks",
            "installed": False,
            "active": False,
            "message": tr("scheduler.daemon.schtasks_removed", task=TASK_NAME),
        }


# --------------------------------------------------------------------- unified entry point


def _get_platform_impl() -> type[_DarwinDaemon | _LinuxDaemon | _WindowsDaemon] | None:
    plat = sys.platform
    if plat == "darwin":
        return _DarwinDaemon
    elif plat.startswith("linux"):
        return _LinuxDaemon
    elif plat == "win32":
        return _WindowsDaemon
    return None


def daemon_status() -> dict[str, Any]:
    impl = _get_platform_impl()
    if impl is None:
        return {
            "ok": False,
            "platform": sys.platform,
            "backend": "unsupported",
            "installed": False,
            "active": False,
            "error": tr("scheduler.daemon.unsupported", platform=sys.platform),
        }
    return impl.status()


def daemon_install(target_cmd: list[str] | None = None) -> dict[str, Any]:
    impl = _get_platform_impl()
    if impl is None:
        return {
            "ok": False,
            "platform": sys.platform,
            "backend": "unsupported",
            "installed": False,
            "active": False,
            "error": tr("scheduler.daemon.unsupported", platform=sys.platform),
        }
    cmd = resolve_target_command(target_cmd)
    return impl.install(cmd)


def daemon_uninstall() -> dict[str, Any]:
    impl = _get_platform_impl()
    if impl is None:
        return {
            "ok": False,
            "platform": sys.platform,
            "backend": "unsupported",
            "installed": False,
            "active": False,
            "error": tr("scheduler.daemon.unsupported_uninstall", platform=sys.platform),
        }
    return impl.uninstall()
