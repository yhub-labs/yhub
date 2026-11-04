"""Scheduled jobs (cron-style) adapter: job list / run now / run history / report reading.

Placement follows the repository rules (AGENTS.md):
  * only add this file, **never touch ``yhub/server/main.py``** -- ``TOOL_META['routes']``
    registers automatically.
  * The scheduling core lives in ``_scheduler.py`` (leading underscore -> no extra launcher
    tool): job-list parsing, due checks, running subprocesses, history persistence, status views.
  * This file only does parameter validation, response wrapping and thread startup; the UI only
    displays.

Write-endpoint boundary: "run now" is the only POST, and it **does not change config** -- the
job list is File over app (``~/.config/yhub/schedule.json``); add jobs or change times by
editing that file, and the edit takes effect on the next tick.
"""

from __future__ import annotations

import functools
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from fastapi.responses import HTMLResponse, JSONResponse

from yhub.i18n import tr

from . import ToolError
from . import _scheduler as sched
from . import _scheduler_daemon as daemon
from ._cell_fetch import DETAIL_LIMIT, err, ok

LOG = logging.getLogger("yhub.scheduler")

REPORT_LIMIT = 2 * 1024 * 1024  # cap of 2 MiB per report (same rule as HTML tools)


def _guard(fn):
    """A 500 also returns the standard error body, without leaking the traceback to the frontend
    (same scheme as the dashboard)."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except ToolError:
            raise
        except Exception:
            LOG.exception("[cron] %s 出了未预期的异常", fn.__name__)
            return JSONResponse(
                status_code=500,
                content={
                    "ok": False,
                    "error": tr("scheduler.backend_error"),
                    "hint": tr("scheduler.backend_error_hint"),
                },
            )

    return wrapper


def _require_job(job_id: str) -> dict:
    job = sched.find_job(job_id)
    if job is None:
        raise ToolError(
            tr("scheduler.job_not_found", job_id=job_id),
            hint=tr("scheduler.job_not_found_hint"),
        )
    return job


@_guard
def _jobs_route():
    """Job list plus each job's current state (panel and dashboard both read this one)."""
    sched.ensure_started_from_wall()
    return {"ok": True, **sched.overview()}


@_guard
def _runs_route(job: str | None = None, limit: str | None = None):
    """Run history (newest first). ``limit`` is 1~200, default 20."""
    limit_value = 20
    if limit is not None:
        try:
            limit_value = int(str(limit).strip())
        except ValueError:
            raise ToolError(tr("scheduler.limit_invalid", limit=limit), hint=tr("scheduler.limit_hint"))
        if not 1 <= limit_value <= 200:
            raise ToolError(tr("scheduler.limit_invalid", limit=limit), hint=tr("scheduler.limit_hint"))
    if job:
        _require_job(job)
    return {"ok": True, "runs": sched.recent_runs(job, limit_value)}


@_guard
def _run_route(job_id: str):
    """Run once now (synchronously, waiting at most the job's own timeout)."""
    job = _require_job(job_id)
    ready, reason = sched.job_ready(job)
    if not ready:
        raise ToolError(reason, hint=tr("scheduler.not_ready_hint"))
    try:
        record = sched.run_job(job_id, trigger="manual")
    except RuntimeError as exc:  # e.g. the previous run is still going
        raise ToolError(str(exc), hint=tr("scheduler.busy_hint"))
    except Exception as exc:
        raise ToolError(tr("scheduler.start_failed", title=job["title"], error=exc),
                        hint=tr("scheduler.start_failed_hint"))
    if record["status"] != "ok":
        # A failing job is not an HTTP error: return the record with 200 so the UI can show the
        # truth (same source as dashboard rule R2)
        LOG.warning("[cron] 手动运行 %s 失败：%s", job_id, record.get("error") or record.get("exit_code"))
    return {"ok": True, "run": record, "job": sched.job_view(job)}


@_guard
def _report_route(job_id: str):
    """Read the self-contained HTML report a job produced (rendered in a sandboxed panel, or opened
    in a new tab)."""
    job = _require_job(job_id)
    raw = str(job.get("report_path") or "").strip()
    if not raw:
        raise ToolError(tr("scheduler.no_report_path", title=job["title"]),
                        hint=tr("scheduler.no_report_path_hint"))
    path = Path(raw).expanduser()
    if not path.is_file():
        raise ToolError(tr("scheduler.report_missing", path=path),
                        hint=tr("scheduler.report_missing_hint", job_id=job_id))
    if path.suffix.lower() not in (".html", ".htm"):
        raise ToolError(tr("scheduler.report_not_html", name=path.name), hint=tr("scheduler.report_not_html_hint"))
    size = path.stat().st_size
    if size > REPORT_LIMIT:
        raise ToolError(tr("scheduler.report_too_large", kb=size // 1024), hint=tr("scheduler.report_too_large_hint"))
    try:
        html = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise ToolError(tr("scheduler.report_unreadable", error=exc.strerror or exc),
                        hint=tr("scheduler.report_unreadable_hint"))
    return HTMLResponse(content=html)


@_guard
def _daemon_status_route():
    """Registration and activation state of the OS-level background scheduler."""
    return daemon.daemon_status()


@_guard
def _daemon_install_route():
    """Register and activate the OS-level background scheduler (launchd / systemd / schtasks)."""
    return daemon.daemon_install()


@_guard
def _daemon_uninstall_route():
    """Unregister and clean up the OS-level background scheduler."""
    return daemon.daemon_uninstall()


def _status_text() -> str:
    """One-line status for the tool entry: also starts the scheduler thread (a live backend should
    be scheduling)."""
    if not sched.scheduler_enabled():
        return tr("scheduler.status_off")
    sched.ensure_started_from_wall()
    return tr("scheduler.status_on", seconds=sched.tick_seconds())


# ---- CLI face (yhub schedule …) ----------------------------------------------
# Implemented in yhub/cli/schedule.py; --json matches the HTTP face (GET /api/scheduler/jobs),
# differing from the old --json only by the envelope key "ok" (A5: --json = the API body).


def _cli_list(json_out: bool = False):
    if json_out:
        sched.ensure_started_from_wall()  # same precondition as _jobs_route so the started field matches
        return {"ok": True, **sched.overview()}
    from yhub.cli.schedule import cmd_list

    return cmd_list(False)


def _cli_run(job_id: str = None, json_out: bool = False) -> int:
    from yhub.cli.schedule import cmd_run

    return cmd_run(job_id or "", json_out)


def _cli_tick(json_out: bool = False) -> int:
    from yhub.cli.schedule import cmd_tick

    return cmd_tick(json_out)


def _cli_daemon(action: str = None, json_out: bool = False):
    from yhub.cli.schedule import cmd_daemon

    return cmd_daemon(action or "status", json_out)


# ------------------------- wall cell cron.<job> (phase F4 ownership)


def _cron_stale_after(job: dict) -> int:
    """Staleness threshold for a cron cell: derived from the job's own period (a daily period uses
    the 26 h ruler of the sync sources)."""
    period = sched.period_seconds(job)
    if not period:
        return 93600
    if period >= 43200:  # 12 h or more is treated as a daily period
        return 93600
    return max(600, int(period * 2.6))


def fetch_cron(specs: list[dict]) -> dict:
    """One cell per scheduled job: state comes straight from the scheduler's own view (ran or not /
succeeded or not / next run).

    The three states are not recomputed here -- ``job_view()`` already turns "never ran / run
    failed / scheduling off" into plain text that means the same as the cell's ok|warn|alert
    (so the two never disagree).
    """
    sched.ensure_started_from_wall()  # fetching cells also starts the scheduler thread

    def one(spec: dict) -> dict:
        job_id = str(spec["params"].get("job_id") or "")
        job = sched.find_job(job_id)
        if job is None:
            return err(
                tr("scheduler.cell_job_gone", job_id=job_id),
                tr("scheduler.cell_job_gone_hint"),
            )
        view = sched.job_view(job)
        detail = [
            {"text": item["text"], "href": item.get("href")}
            for item in view["detail"] if str(item.get("text", "")).strip()
        ]
        hint = (view.get("source_error") or {}).get("hint")
        if hint:
            detail.append({"text": hint})
        stamp = None
        if view.get("updated_at"):
            try:
                stamp = datetime.fromisoformat(view["updated_at"]).timestamp()
            except ValueError:
                stamp = None
        return ok(view["summary"], status=view["status"],
                  detail=detail[:DETAIL_LIMIT], updated_at=stamp)

    with ThreadPoolExecutor(max_workers=min(4, max(1, len(specs)))) as pool:
        results = list(pool.map(one, specs))
    return {spec["id"]: outcome for spec, outcome in zip(specs, results)}


def _cron_tiles() -> list[dict]:
    """**Dynamic producer declaration**: one cell per job (follows ``schedule.json``; a new job adds
    a cell automatically).

    ``presentation.tiles`` may be a callable (a built-in plugin privilege): it is recomputed on
    every discovery, so editing ``schedule.json`` gains/loses a cell on the next
    ``/api/dashboard/cells`` fetch. Deep links default to the backend's own report route
    (``/api/scheduler/jobs/<id>/report``): wall and API share one origin, and a root-relative
    path is more robust than a hardcoded port (see README "scheduled jobs").
    """
    tiles: list[dict] = []
    for index, job in enumerate(sched.resolve_jobs()):
        cell_id = f"cron.{job['id']}"
        if not re.match(r"^[a-z0-9][a-z0-9._-]{0,63}$", cell_id):
            LOG.warning("任务 %s 推不出合法格子 id，跳过", job["id"])
            continue
        tiles.append({
            "id": cell_id,
            "zone": "status",
            "order": 60 + index,
            "title": job["title"][:12],
            "source": f"cron:{job['id']}",
            "stale_after": _cron_stale_after(job),
            "refresh": 30,
            "href": job.get("href") or "#",
            "group": "cron",
            "critical": bool(job.get("critical")),
            "enabled": bool(job.get("enabled")),
            "params": {"job_id": job["id"]},
            "fetch": fetch_cron,
            "span": "md",
            "page": 1,
        })
    return tiles


TOOL_META = {
    "id": "scheduler",
    "name": "定时任务",
    "icon": "scheduler",
    "description": "cron 式调度：到点跑库内脚本，状态上信息墙",
    "keywords": "cron schedule 定时 调度 任务 计划 ding shi ren wu diao du jihua",
    # Phase F4: **dynamic** producer declaration for cron.<job> (callable = recomputed on discovery)
    "presentation": {"tiles": _cron_tiles},
    "ready": lambda: True,
    "status": _status_text,
    "faces": {
        "routes": [
            {"method": "GET", "path": "/api/scheduler/jobs", "endpoint": _jobs_route, "params": []},
            {
                "method": "GET",
                "path": "/api/scheduler/runs",
                "endpoint": _runs_route,
                "params": [
                    {"name": "job", "type": "str", "default": None, "help": "按任务 id 过滤"},
                    {"name": "limit", "type": "str", "default": None, "help": "1~200，默认 20"},
                ],
            },
            # job_id is a path parameter: extracted from the path template, no declaration needed
            {"method": "POST", "path": "/api/scheduler/jobs/{job_id}/run", "endpoint": _run_route, "params": []},
            {"method": "GET", "path": "/api/scheduler/jobs/{job_id}/report", "endpoint": _report_route, "params": []},
            {"method": "GET", "path": "/api/scheduler/daemon", "endpoint": _daemon_status_route, "params": []},
            {"method": "POST", "path": "/api/scheduler/daemon/install", "endpoint": _daemon_install_route, "params": []},
            {"method": "POST", "path": "/api/scheduler/daemon/uninstall", "endpoint": _daemon_uninstall_route, "params": []},
        ],
        "cli": {
            "command": "schedule",
            "help": "Timed jobs (cron-like scheduler)",
            "subcommands": [
                {"name": "list", "help": "List jobs and their current state", "params": [],
                 "handler": _cli_list},
                {"name": "run", "help": "Run one job now",
                 "params": [{"name": "job_id", "type": "str", "nargs": "?", "positional": True,
                             "help": "Job id (see `yhub schedule list`)"}],
                 "handler": _cli_run},
                {"name": "tick", "help": "Run every job that is due (for launchd/cron; exits when done)",
                 "params": [], "handler": _cli_tick},
                {"name": "daemon", "help": "Manage OS-level background timer (launchd/systemd/schtasks)",
                 "params": [{"name": "action", "type": "str", "nargs": "?", "positional": True,
                             "help": "status (default) | install | uninstall"}],
                 "handler": _cli_daemon},
            ],
        },
    },
}
