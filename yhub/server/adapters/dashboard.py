"""Dashboard adapter: 4 read-only GET routes, contract in ``api-contract.md`` at the repo root.

Placement follows contract §10.1:
  * only add this file, **never touch ``yhub/server/main.py``** -- ``TOOL_META['routes']`` is
    registered automatically.
  * Fetching, caching, the three states and snapshots all live in ``_dashboard_sources.py``
    (leading underscore, so ``discover_adapters()`` skips it and the launcher gains no tool).
  * Endpoints validate their own parameters: ``raise ToolError('message', hint='what to do')``
    -> standard 400 body, not FastAPI's 422 (contract §2.2).
  * This file has **no write endpoint**; changing the layout means editing
    ``~/.config/yhub/dashboard.json`` (File over app).
"""

from __future__ import annotations

import functools
import logging
from typing import Callable, Optional

from fastapi.responses import JSONResponse

from yhub.i18n import tr

from . import ToolError
from ._dashboard_sources import (
    _SNAP_ID_RE,
    build_cells,
    get_snapshot,
    list_snapshots,
    maybe_write_snapshot,
)

LOG = logging.getLogger("yhub.dashboard")

_ZONES = ("todo", "status")
_STATUSES = ("ok", "warn", "alert")
_STALENESSES = ("fresh", "stale", "expired")
_BOOLEANS = ("true", "false")


def _guard(fn: Callable) -> Callable:
    """A 500 also returns the standard error body (contract §2.2) without leaking the traceback to
    the frontend (R7)."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except ToolError:
            raise
        except Exception:
            LOG.exception("[dashboard] %s 出了未预期的异常", fn.__name__)
            return JSONResponse(
                status_code=500,
                content={
                    "ok": False,
                    "error": tr("dashboard.err.internal"),
                    "hint": tr("dashboard.err.internal_hint"),
                },
            )

    return wrapper


# --------------------------------------------------------- parameter validation (400)


def _enum_param(name: str, value: str | None, choices: tuple[str, ...]) -> str | None:
    if value is None:
        return None
    if value not in choices:
        if name == "zone":
            hint = tr("dashboard.err.zone_hint")
        elif name == "status":
            hint = tr("dashboard.err.status_hint")
        elif name == "staleness":
            hint = tr("dashboard.err.staleness_hint")
        else:
            hint = tr("dashboard.err.enum_hint",
                       name=name, choices=tr("dashboard.list_separator").join(choices))
        raise ToolError(tr("dashboard.err.unsupported", name=name, value=value), hint=hint)
    return value


def _int_param(name: str, value: str | None, low: int, high: int, default: int) -> int:
    if value is None:
        return default
    try:
        number = int(value.strip())
    except (ValueError, AttributeError):
        raise ToolError(tr("dashboard.err.unsupported", name=name, value=value),
                        hint=tr("dashboard.err.int_hint", name=name, low=low, high=high))
    if number < low or number > high:
        raise ToolError(tr("dashboard.err.unsupported", name=name, value=value),
                        hint=tr("dashboard.err.int_hint", name=name, low=low, high=high))
    return number


def _bool_param(name: str, value: str | None) -> bool | None:
    if value is None:
        return None
    if value not in _BOOLEANS:
        raise ToolError(tr("dashboard.err.unsupported", name=name, value=value),
                        hint=tr("dashboard.err.bool_hint", name=name))
    return value == "true"


def _not_found(error: str, hint: str) -> JSONResponse:
    return JSONResponse(status_code=404, content={"ok": False, "error": error, "hint": hint})


# ----------------------------------------------------------- the 4 GET routes


@_guard
def _cells_route(
    zone: Optional[str] = None,
    status: Optional[str] = None,
    staleness: Optional[str] = None,
    enabled: Optional[str] = None,
    source: Optional[str] = None,
    ids: Optional[str] = None,
    limit: Optional[str] = None,
    offset: Optional[str] = None,
):
    """Cell list (M1~M6 all live here, contract §4.1). The wall's normal use is one call with no
    parameters that returns everything."""
    zone = _enum_param("zone", zone, _ZONES)
    status = _enum_param("status", status, _STATUSES)
    staleness = _enum_param("staleness", staleness, _STALENESSES)
    enabled_flag = _bool_param("enabled", enabled)
    limit_value = _int_param("limit", limit, 1, 200, 200)
    offset_value = _int_param("offset", offset, 0, 10**9, 0)

    wanted: set[str] | None = None
    if ids is not None:
        wanted = {part.strip() for part in ids.split(",") if part.strip()}
        if len(wanted) > 50:
            raise ToolError(tr("dashboard.err.ids_too_many"),
                            hint=tr("dashboard.err.ids_too_many_hint"))

    payload = build_cells()
    cells = payload["cells"]
    filtered = []
    for cell in cells:
        if zone is not None and cell["zone"] != zone:
            continue
        if status is not None and cell["status"] != status:
            continue
        if staleness is not None and cell["staleness"] != staleness:
            continue
        if enabled_flag is not None and cell["enabled"] is not enabled_flag:
            continue
        if source is not None and cell["source"] != source:
            continue
        if wanted is not None and cell["id"] not in wanted:
            continue
        filtered.append(cell)

    page = filtered[offset_value: offset_value + limit_value]
    maybe_write_snapshot(cells, payload["generated_at"])
    return {
        "ok": True,
        "generated_at": payload["generated_at"].isoformat(timespec="seconds"),
        "next_refresh_in": payload["next_refresh_in"],
        "total": len(filtered),
        "count": len(page),
        "cells": page,
    }


@_guard
def _cell_route(cell_id: str):
    """A single cell (contract §4.2): for manual refresh, troubleshooting and contract smoke
    tests -- not for frontend polling."""
    payload = build_cells()
    for cell in payload["cells"]:
        if cell["id"] == cell_id:
            return {
                "ok": True,
                "generated_at": payload["generated_at"].isoformat(timespec="seconds"),
                "cell": cell,
            }
    return _not_found(
        tr("dashboard.err.cell_not_found", cell=cell_id),
        tr("dashboard.err.cell_not_found_hint"),
    )


@_guard
def _snapshots_route(
    limit: Optional[str] = None,
    before: Optional[str] = None,
    flagged: Optional[str] = None,
):
    """Historical snapshot list (contract §4.3): newest first, cursor paging."""
    limit_value = _int_param("limit", limit, 1, 200, 30)
    flagged_flag = _bool_param("flagged", flagged)
    if before is not None and not _SNAP_ID_RE.match(before):
        raise ToolError(tr("dashboard.err.before_invalid", before=before),
                        hint=tr("dashboard.err.before_hint"))

    items, has_more = list_snapshots(limit_value, before, flagged_flag)
    return {"ok": True, "snapshots": items, "has_more": has_more}


@_guard
def _snapshot_route(snapshot_id: str):
    """One snapshot in detail (contract §4.4): the full cell array of that moment; to compare with
    the previous period, fetch two snapshots and diff them."""
    record = get_snapshot(snapshot_id)
    if record is None:
        return _not_found(
            tr("dashboard.err.snapshot_not_found", id=snapshot_id),
            tr("dashboard.err.snapshot_not_found_hint"),
        )
    return {"ok": True, "snapshot": record}


ROUTES = [
    {
        "method": "GET",
        "path": "/api/dashboard/cells",
        "endpoint": _cells_route,
    },
    {"method": "GET", "path": "/api/dashboard/cells/{cell_id}", "endpoint": _cell_route},
    {
        "method": "GET",
        "path": "/api/dashboard/snapshots",
        "endpoint": _snapshots_route,
    },
    {"method": "GET", "path": "/api/dashboard/snapshots/{snapshot_id}", "endpoint": _snapshot_route},
]
