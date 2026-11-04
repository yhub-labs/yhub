"""`yhub schedule` — CLI entry point for scheduled jobs (thin shell; all logic in
yhub/server/adapters/_scheduler.py).

Four actions:
  * ``list``    show the job table and current state (same source as the workbench "scheduled jobs"
                panel and the wall cell)
  * ``run``     run one job right now (synchronously, waits for it)
  * ``tick``    run every due job once — **meant for an OS scheduler** (launchd / cron can call it),
                so jobs still run on a machine without a GUI; the scheduler itself never stays resident
  * ``daemon``  manage the machine-level offline background service (launchd / systemd / schtasks),
                which keeps running due jobs on a 1-minute heartbeat after the app quits

Exit code: 0 = the command itself succeeded (a failing job still exits 0, its status is in the output);
1 = the command failed (no such job, etc.).
"""

from __future__ import annotations

import json
import sys

from yhub.i18n import tr
from yhub.server.adapters import _scheduler as sched


def _print_jobs(as_json: bool) -> int:
    data = sched.overview()
    if as_json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0
    state = tr("cli.schedule.on") if data["enabled"] else tr("cli.schedule.off")
    thread = tr("cli.schedule.thread_running") if data["started"] else tr("cli.schedule.thread_stopped")
    print(tr("cli.schedule.header", state=state, tick=data["tick_seconds"], thread=thread))
    print(tr("cli.schedule.jobs_path", path=data["config_path"]))
    print(tr("cli.schedule.runs_path", path=data["runs_path"]))
    for job in data["jobs"]:
        mark = {"ok": "✅", "warn": "⚠️ ", "alert": "❌"}[job["status"]]
        job_state = tr("cli.schedule.mark_enabled") if job["enabled"] else tr("cli.schedule.mark_disabled")
        print(tr("cli.schedule.job_line", mark=mark, id=job["id"], title=job["title"],
                  schedule=job["schedule"], state=job_state))
        print(f"     {job['summary']}")
        last = job.get("last_run")
        if last:
            print(tr("cli.schedule.last_run", at=last["started_at"], status=last["status"],
                      code=last.get("exit_code"), duration=last["duration_ms"]))
        if job.get("next_due"):
            print(tr("cli.schedule.next_due", due=job["next_due"]))
    return 0


def cmd_list(as_json: bool = False) -> int:
    return _print_jobs(as_json)


def cmd_run(job_id: str, as_json: bool = False) -> int:
    if not job_id:
        print(tr("cli.schedule.need_job_id"))
        return 1
    try:
        record = sched.run_job(job_id, trigger="cli")
    except LookupError as exc:
        print(str(exc))
        return 1
    except RuntimeError as exc:
        print(tr("cli.schedule.did_not_run", error=exc))
        return 1
    if as_json:
        print(json.dumps(record, ensure_ascii=False, indent=2))
    else:
        mark = "✅" if record["status"] == "ok" else "❌"
        print(f"{mark} {job_id} {record['status']} · exit {record.get('exit_code')} · {record['duration_ms']} ms")
        if record.get("error"):
            print(f"   {record['error']}")
        if record.get("out_tail"):
            print(tr("cli.schedule.output_tail"))
            for line in record["out_tail"].splitlines()[-8:]:
                print(f"     {line}")
    return 0


def cmd_tick(as_json: bool = False) -> int:
    """Run every due job once (for launchd / cron: one command, then exit)."""
    records = sched.tick(trigger="cli")
    if as_json:
        print(json.dumps({"ran": records}, ensure_ascii=False, indent=2))
        return 0
    if not records:
        print(tr("cli.schedule.nothing_due"))
        return 0
    for record in records:
        mark = "✅" if record["status"] == "ok" else "❌"
        print(f"{mark} {record['job']} {record['status']} · exit {record.get('exit_code')} · {record['duration_ms']} ms")
    return 0


def cmd_daemon(action: str = "status", as_json: bool = False) -> int:
    """Manage the machine-level offline service (launchd / systemd / crontab / schtasks)."""
    from yhub.server.adapters import _scheduler_daemon as daemon

    act = (action or "status").strip().lower()
    if act == "status":
        res = daemon.daemon_status()
    elif act == "install":
        res = daemon.daemon_install()
    elif act == "uninstall":
        res = daemon.daemon_uninstall()
    else:
        print(tr("cli.schedule.unknown_daemon_action", action=action))
        return 1

    if as_json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0 if res.get("ok", True) else 1

    if not res.get("ok"):
        print(tr("cli.schedule.daemon_failed",
                  error=res.get("error", tr("cli.schedule.unknown_error"))))
        if res.get("hint"):
            print(tr("cli.schedule.daemon_hint", hint=res["hint"]))
        return 1

    mark = "✅" if res.get("installed") else "⚪"
    status_text = (
        tr("cli.schedule.daemon_installed") if res.get("installed")
        else tr("cli.schedule.daemon_not_installed")
    )
    print(tr("cli.schedule.daemon_status_line", mark=mark, status=status_text,
              platform=res.get("platform"), backend=res.get("backend")))
    print(tr("cli.schedule.daemon_message", message=res.get("message")))
    if res.get("config_path"):
        print(tr("cli.schedule.daemon_config", path=res["config_path"]))
    if res.get("target"):
        target_str = " ".join(res["target"]) if isinstance(res["target"], list) else str(res["target"])
        print(tr("cli.schedule.daemon_target", target=target_str))
    return 0


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    as_json = "--json" in args
    args = [a for a in args if a != "--json"]
    action = args[0] if args else "list"
    if action == "list":
        return cmd_list(as_json)
    if action == "run":
        return cmd_run(args[1] if len(args) > 1 else "", as_json)
    if action == "tick":
        return cmd_tick(as_json)
    if action == "daemon":
        subaction = args[1] if len(args) > 1 else "status"
        return cmd_daemon(subaction, as_json)
    print(tr("cli.schedule.unknown_subcommand", action=action))
    return 1
