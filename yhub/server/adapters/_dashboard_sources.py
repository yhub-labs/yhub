"""Dashboard fetching and cell assembly.

The contract is ``api-contract.md`` (v1) at the repo root. Because the name starts with ``_``,
``adapters.discover_adapters()`` skips it — it does not become a second launcher tool; the HTTP shell is
``dashboard.py`` (parameter validation and response envelope only).

Split (phase F: the center shrank from "fetch center" to "registry + aggregation", see plan §5F):
  * this file = **cell producer registry** (``resolve_specs``: host factory definitions ⊕ each plugin's
    ``presentation.tiles``), in-process cache (TTL + single-flight + serve-stale-on-error), the tri-state
    and staleness rules, the host aggregate tile, snapshot persistence;
  * fetching (``fetch``) belongs to each plugin per cell: specs carry ``fetch`` and this file only
    batches the calls and normalizes results into ``Outcome`` (``_outcome_from``); plugins just return
    plain dicts;
  * ``dashboard.py`` = the 4 GET routes + query parameter validation + envelope.

Three rules that must be honored (contract §3.3 R1–R7):
  * **R2 an unreachable source is not ok**: failures degrade to ``warn`` (first) / ``alert`` (2+ in a
    row, or ``critical``), ``source_error`` is non-null, ``summary`` is human text;
  * **R3 ``updated_at`` only advances on a successful fetch**; never succeeded → the cell's first
    computation time;
  * **R7 credentials never appear in a response**: URL userinfo and query strings are stripped first.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from yhub.i18n import tr, tr_text

from . import ToolError, plugin_tiles
from ._plugin_loader import OVERVIEW_ID, TITLE_LIMIT
from ._cell_fetch import (
    DETAIL_LIMIT,
    SUMMARY_LIMIT,
    clip as _clip,
    safe_url,
    strip_userinfo,
)

#: Display timezone: the machine's local zone (see _cell_fetch.local_tz).
from ._cell_fetch import TZ  # noqa: E402  (re-export: one definition for the whole backend)
LOG = logging.getLogger("yhub.dashboard")

_SEVERITY = {"ok": 0, "warn": 1, "alert": 2}
_STALE_RANK = {"fresh": 0, "stale": 1, "expired": 2}
_STATUSES = ("ok", "warn", "alert")
_ZONES = ("todo", "status")
_STALENESSES = ("fresh", "stale", "expired")

# The 11 gate fields (contract §3.1: five required + six layout); a cell missing any of them should not exist
GATE_FIELDS = (
    "id", "title", "status", "summary", "updated_at", "href",
    "zone", "order", "enabled", "stale_after", "source",
)

def _expired_suffix() -> str:
    """Stale suffix (the text limits live in _cell_fetch, one copy repo-wide)."""
    return tr("dashboard.cell.expired_suffix")


def _list_separator() -> str:
    return tr("dashboard.list_separator")


_SNAP_RETENTION_SECONDS = 14 * 86400
_SNAP_RETENTION_COUNT = 2000
_SNAP_ID_RE = re.compile(r"^sn_\d{8}T\d{6}$")


# ------------------------------------------------------------ paths and config


def base_dir() -> Path:
    """Config root: ``YHUB_DASHBOARD_DIR`` (tests) → the shared root from ``settings.config_dir()``."""
    raw = os.environ.get("YHUB_DASHBOARD_DIR", "").strip()
    if raw:
        return Path(raw).expanduser()
    from .settings import config_dir

    return config_dir()


def config_file() -> Path:
    return base_dir() / "dashboard.json"


def snapshot_file() -> Path:
    return base_dir() / "dashboard" / "snapshots.jsonl"


def load_config() -> dict[str, Any]:
    """Read ``dashboard.json``. Missing file = factory defaults (contract §8); unreadable = run on defaults
    with one log line."""
    path = config_file()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception as exc:  # bad JSON must not make the whole wall unopenable
        LOG.warning("[dashboard] 配置文件读不懂（%s：%s），本次按默认值运行", path, exc)
        return {}
    return data if isinstance(data, dict) else {}


# ------------------------------------------------- URL sanitizing and text helpers
# (implemented in ``_cell_fetch.py`` and imported by name: one implementation, one rule set for the
# center and for plugins)


# ------------------------------------------------------------- host tiles


def _host_tiles() -> list[dict[str, Any]]:
    """Host notification tile (phase F5): ``overview.alerts`` — cross-plugin alert aggregation owned by
    nobody.

    * always provided by the host (a plugin declaring this id fails at discovery, see ``check_tiles``);
    * **always on page 1**: the frontend's default layout puts it first and ``smoke.mjs`` pins that;
    * no external fetch (``group=None``); ``stale_after`` takes the minimum of its upstream values (§6.5,
      see ``resolve_specs``);
    * the config file may change layout/thresholds/deep links, never the schema (contract §8).
    """
    return [
        {
            "id": OVERVIEW_ID, "zone": "status", "order": 0, "title": tr_text("异常总览"),
            "source": "derived", "stale_after": None, "refresh": 0,
            "href": "#", "group": None, "critical": False, "enabled": True, "params": {},
        },
    ]


def _apply_override(spec: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    """Apply this cell's overrides from ``dashboard.json`` (invalid values fall back to the defaults, so a
    typo cannot break the whole wall)."""
    out = dict(spec)
    params = dict(spec["params"])
    if isinstance(over.get("enabled"), bool):
        out["enabled"] = over["enabled"]
    if over.get("zone") in _ZONES:
        out["zone"] = over["zone"]
    order = over.get("order")
    if isinstance(order, int) and not isinstance(order, bool) and order >= 0:
        out["order"] = order
    title = over.get("title")
    if isinstance(title, str) and title.strip():
        out["title"] = title.strip()[:TITLE_LIMIT]  # same limit as the declaration (_plugin_loader.TITLE_LIMIT)
    href = over.get("href")
    if isinstance(href, str) and href.strip():
        out["href"] = strip_userinfo(href.strip())
    stale_after = over.get("stale_after")
    if isinstance(stale_after, int) and not isinstance(stale_after, bool) and stale_after > 0:
        out["stale_after"] = stale_after
    if isinstance(over.get("critical"), bool):
        out["critical"] = over["critical"]
    for key in params:
        value = over.get(key)
        if isinstance(value, str) and value.strip():
            params[key] = value.strip()
    out["params"] = params
    return out


def _spec_from_tile(plugin_id: str, tile: dict[str, Any]) -> dict[str, Any]:
    """Turn one ``presentation.tiles`` declaration into a center spec (phase F1: **the declaration is the
    producer**).

    Field validation lives in ``adapters.check_tiles`` (red at discovery time); this only assembles, and
    runs href through ``strip_userinfo`` (R7: credentials never appear in a response).
    """
    return {
        "id": tile["id"],
        "zone": tile["zone"],
        "order": tile["order"],
        "title": tr_text(tile["title"]),
        "source": tile["source"],
        "stale_after": tile["stale_after"],
        "refresh": tile["refresh"],
        "href": strip_userinfo(tile["href"]),
        "group": tile["group"],
        "critical": tile.get("critical", False),
        "enabled": tile.get("enabled", True),
        "params": dict(tile.get("params") or {}),
        "fetch": tile["fetch"],
    }


def _registry() -> dict[str, dict[str, Any]]:
    """Cell producer registry (phase F6): ① host notification tile ⊕ ② every plugin's ``presentation.tiles``.

    * the center no longer produces cells of its own — besides the host tile, every id must come from
      some plugin's tiles declaration;
    * a plugin declaration is a **first-class producer**: a same id replaces the whole cell (F1 reversed
      phase D's "layout override") and ids unknown to the center simply enter the table (no ValueError);
    * duplicate ids / missing producer fields / declarations of the host-reserved id all fail loud in
      ``adapters._check_tiles`` at discovery, so nothing is re-checked here.
    """
    registry: dict[str, dict[str, Any]] = {}
    for spec in _host_tiles():          # ① host aggregate tile
        registry[spec["id"]] = spec
    for plugin_id, tile in plugin_tiles():   # ② plugin cell registry
        spec = _spec_from_tile(plugin_id, tile)
        registry[spec["id"]] = spec
    return registry


def resolve_specs() -> list[dict[str, Any]]:
    """Producer registry + ``dashboard.json`` overrides (re-read on every request: user overrides always
    come last and always win)."""
    raw = load_config()
    cells_cfg = raw.get("cells")
    cells_cfg = cells_cfg if isinstance(cells_cfg, dict) else {}

    specs: list[dict[str, Any]] = []
    for cid, spec in _registry().items():
        over = cells_cfg.get(cid)
        if isinstance(over, dict):
            spec = _apply_override(spec, over)
        if spec["group"] == "probe":
            # contract §6.3: ``source`` and ``href`` both follow the probe URL by default, so a changed
            # ``probe_url`` carries over
            probe = spec["params"].get("probe_url")
            if probe:
                spec["source"] = f"probe:{safe_url(probe)}"
                href_given = isinstance(over, dict) and isinstance(over.get("href"), str) \
                    and bool(over["href"].strip())
                if not href_given:
                    spec["href"] = strip_userinfo(probe)
        specs.append(spec)

    overview = next((s for s in specs if s["id"] == OVERVIEW_ID), None)
    if overview is not None and overview["stale_after"] is None:
        others = [s["stale_after"] for s in specs if s["stale_after"]]
        overview["stale_after"] = min(others) if others else 120
    return specs


def snapshot_interval() -> int:
    """Snapshot write interval (default 300 s, configurable 60–3600 s, contract §8)."""
    raw = load_config().get("snapshot_interval")
    if isinstance(raw, int) and not isinstance(raw, bool) and 60 <= raw <= 3600:
        return raw
    return 300


# ------------------------------------------------------------- fetch results


class Outcome:
    """Result of one fetch. When ``ok=False``, ``error`` is the human text used for ``source_error``."""

    __slots__ = ("ok", "status", "summary", "detail", "updated_at", "error")

    def __init__(
        self,
        ok: bool,
        status: str = "ok",
        summary: str = "",
        detail: list[dict] | None = None,
        updated_at: float | None = None,
        error: dict | None = None,
    ) -> None:
        self.ok = ok
        self.status = status
        self.summary = summary
        self.detail = detail or []
        self.updated_at = updated_at
        self.error = error


def _err(message: str, hint: str) -> Outcome:
    """Failure result for degradation (R2: an unreachable source is not ok, ``source_error`` is non-null)."""
    return Outcome(False, error={"message": message, "hint": hint})


def _outcome_from(cid: str, value: Any) -> Outcome:
    """Normalize the fetch result a producer hands back (phase F fetch contract, docs/plugins.md).

    fetch always returns a **plain dict**: ``{"ok": True, "status", "summary", "detail",
    "updated_at"}`` or ``{"ok": False, "error": {"message", "hint"}}`` — plugins do not need to (and
    should not) import the center's ``Outcome`` class; the dict is the boundary (since phase F6 the
    center produces no fetch results itself, every fetch lives in a plugin).

    Wrong shape / illegal status / non-numeric updated_at degrades into this cell's source_error text
    (only this cell, never the whole wall — same R2 rule) plus one log line.
    """
    if not isinstance(value, dict):
        LOG.warning("[dashboard] 格子 %s 的取数结果不是 dict（%s）", cid, type(value).__name__)
        return _err(tr("dashboard.err.fetch_shape", cell=cid),
                    tr("dashboard.err.fetch_shape_hint"))
    if value.get("ok"):
        status = value.get("status", "ok")
        if status not in _STATUSES:
            LOG.warning("[dashboard] 格子 %s 的取数结果 status 非法：%r", cid, status)
            return _err(tr("dashboard.err.fetch_status_invalid", cell=cid, status=repr(status)),
                        tr("dashboard.err.status_hint"))
        updated = value.get("updated_at")
        if isinstance(updated, bool) or not isinstance(updated, (int, float)):
            updated = None  # updated_at only accepts epoch seconds; absent = "the moment we just read it" (R3)
        detail = [d for d in (value.get("detail") or []) if isinstance(d, dict)]
        return Outcome(True, status=status, summary=str(value.get("summary") or ""),
                       detail=detail, updated_at=updated)
    error = value.get("error")
    error = error if isinstance(error, dict) else {}
    return _err(str(error.get("message") or tr("dashboard.err.cell_unavailable", title=cid)),
                str(error.get("hint") or tr("dashboard.err.default_hint")))


def _fetch_group(specs: list[dict]) -> dict[str, Outcome]:
    """Batch fetching per producer: each fetcher only receives the cells it owns, results merge into one table.

    A fetcher raising means that whole batch failed (degraded to "source unreachable"); it never turns
    the endpoint into a non-200.
    """
    batches: dict[int, tuple[Any, list[dict]]] = {}
    for spec in specs:
        batches.setdefault(id(spec["fetch"]), (spec["fetch"], []))[1].append(spec)
    outcomes: dict[str, Outcome] = {}
    for fetch, batch in batches.values():
        try:
            if not callable(fetch):
                raise TypeError(f"取数组 {batch[0]['group']} 没有可调用的 fetch 声明")
            raw = fetch(batch)
        except Exception as exc:
            LOG.warning("[dashboard] 取数组 %s 整组失败：%s", batch[0]["group"], exc)
            continue
        for cid, value in (raw or {}).items():
            outcomes[cid] = _outcome_from(cid, value)
    return outcomes


# ------------------------------------------------------------ cache and refresh


class _GroupState:
    """In-process cache for one data-source group: per-source TTL + single-flight + serve-stale-on-error."""

    __slots__ = ("lock", "ttl", "outcomes", "errors", "fail", "last_success",
                 "last_attempt", "first_seen", "next_refresh")

    def __init__(self, ttl: float) -> None:
        self.lock = threading.Lock()
        self.ttl = ttl
        self.outcomes: dict[str, Outcome] = {}   # last **successful** result per cell
        self.errors: dict[str, dict] = {}         # most recent failure text per cell
        self.fail: dict[str, int] = {}            # consecutive failure count
        self.last_success: dict[str, float] = {}  # basis for updated_at (R3)
        self.last_attempt: dict[str, float] = {}
        self.first_seen: dict[str, float] = {}    # updated_at when never successful (R3)
        self.next_refresh = 0.0


_GROUPS: dict[str, _GroupState] = {}


def _state_for(group: str, ttl: float) -> _GroupState:
    state = _GROUPS.get(group)
    if state is None:
        state = _GROUPS[group] = _GroupState(ttl)
    state.ttl = ttl
    return state


def _refresh(state: _GroupState, specs: list[dict]) -> None:
    """Actually hit the source once. Exceptions are degraded to "source unreachable" and never turn the
    endpoint into a non-200."""
    now = time.time()
    for spec in specs:
        state.first_seen.setdefault(spec["id"], now)

    outcomes = _fetch_group(specs)

    now = time.time()
    for spec in specs:
        cid = spec["id"]
        state.last_attempt[cid] = now
        outcome = outcomes.get(cid) or _err(
            tr("dashboard.err.fetch_failed_cell"), tr("dashboard.err.default_hint"),
        )
        if outcome.ok:
            state.outcomes[cid] = outcome
            state.errors.pop(cid, None)
            state.fail[cid] = 0
            # a sync cell's updated_at is "last successful sync", not "just read it"
            state.last_success[cid] = outcome.updated_at if outcome.updated_at else now
        else:
            state.fail[cid] = state.fail.get(cid, 0) + 1
            state.errors[cid] = outcome.error or {"message": tr("dashboard.err.fetch_failed"),
                                                   "hint": tr("dashboard.err.short_hint")}
    state.next_refresh = time.time() + state.ttl


def _ensure(state: _GroupState, specs: list[dict]) -> None:
    """Refresh only when the TTL expires; at most one refresh per source at a time and later requests use
    the old cache. A group that has never fetched must wait (otherwise the first screen is empty)."""
    now = time.time()
    for spec in specs:
        state.first_seen.setdefault(spec["id"], now)
    if now < state.next_refresh:
        return
    blocking = not state.last_attempt
    if not state.lock.acquire(blocking=blocking):
        return  # someone else is refreshing: don't queue, don't hit the source twice, use the old cache
    try:
        if time.time() >= state.next_refresh:
            _refresh(state, specs)
    finally:
        state.lock.release()


# ---------------------------------------------------------- cell assembly


def _sort_key(cell: dict) -> tuple:
    return (0 if cell["zone"] == "todo" else 1, cell["order"], cell["id"])


def _gate_check(cell: dict) -> None:
    """R1: missing any of the 11 gate fields raises immediately — never emit half a cell."""
    missing = []
    for field in GATE_FIELDS:
        if field not in cell or cell[field] is None:
            missing.append(field)
        elif isinstance(cell[field], str) and not cell[field].strip():
            missing.append(field)
    if missing:
        raise ToolError(
            tr("dashboard.err.cell_gate_missing", cell=cell.get('id', '?'),
               fields=_list_separator().join(missing)),
            hint=tr("dashboard.err.cell_gate_hint"),
        )
    if cell["status"] not in _STATUSES:
        raise ToolError(tr("dashboard.err.cell_status_invalid", cell=cell['id'],
                           status=cell['status']),
                        hint=tr("dashboard.err.status_hint"))
    if cell["zone"] not in _ZONES:
        raise ToolError(tr("dashboard.err.cell_zone_invalid", cell=cell['id'], zone=cell['zone']),
                        hint=tr("dashboard.err.zone_hint_cell"))


def _build_cell(spec: dict, state: _GroupState, generated_at: datetime) -> dict:
    cid = spec["id"]
    stale_after = spec["stale_after"]
    now = generated_at.timestamp()
    attempt = state.last_attempt.get(cid)
    fails = state.fail.get(cid, 0)
    outcome = state.outcomes.get(cid)

    detail: list[dict] = []
    source_error: dict | None = None

    if outcome is not None and fails == 0:
        # ---- success path ----
        status = outcome.status
        summary = outcome.summary
        detail = [d for d in outcome.detail if isinstance(d, dict) and str(d.get("text", "")).strip()][:DETAIL_LIMIT]
        updated_epoch = state.last_success.get(cid, now)
    else:
        # ---- failure path (R2) ----
        if outcome is None and attempt is None:
            error = {"message": tr("dashboard.err.cell_not_ready", title=spec['title']),
                     "hint": tr("dashboard.err.cell_not_ready_hint")}
        else:
            error = state.errors.get(cid) or {
                "message": tr("dashboard.err.cell_unavailable", title=spec['title']),
                "hint": tr("dashboard.err.default_hint"),
            }
        status = "alert" if (fails >= 2 or spec["critical"]) else "warn"
        summary = error["message"]
        source_error = {"message": error["message"], "hint": error.get("hint", "")}
        # R3: on failure updated_at keeps the last success; never successful → the cell's first computation time
        updated_epoch = state.last_success.get(cid, state.first_seen.get(cid, now))

    delta = max(0.0, now - updated_epoch)
    if delta < stale_after:
        staleness = "fresh"
    elif delta < 3 * stale_after:
        staleness = "stale"
    else:
        staleness = "expired"

    # R5: stale data may not rank below warn, and expired must say so (dashboard.cell.expired_suffix)
    if staleness != "fresh" and _SEVERITY[status] < _SEVERITY["warn"]:
        status = "warn"
    if staleness == "expired" and tr("dashboard.cell.expired_word") not in summary:
        suffix = _expired_suffix()
        summary = _clip(summary, SUMMARY_LIMIT - len(suffix)) + suffix
    summary = _clip(summary)

    cell = {
        "id": cid,
        "zone": spec["zone"],
        "order": spec["order"],
        "enabled": spec["enabled"],
        "title": tr_text(spec["title"]),
        "status": status,
        "summary": summary,
        "detail": detail,
        "updated_at": datetime.fromtimestamp(updated_epoch, TZ).isoformat(timespec="seconds"),
        "href": spec["href"],
        "stale_after": stale_after,
        "staleness": staleness,
        "age_seconds": int(round(delta)),
        "source": spec["source"],
        "source_error": source_error,
    }
    if attempt is not None:
        cell["last_attempt_at"] = datetime.fromtimestamp(attempt, TZ).isoformat(timespec="seconds")
    _gate_check(cell)
    return cell


def _build_overview(spec: dict, cells: list[dict], generated_at: datetime) -> dict:
    """M5 aggregate cell (R6): the worst upstream state; any non-fresh upstream keeps it at or above warn."""
    upstream = [c for c in cells if c["id"] != spec["id"] and c["enabled"]]
    flagged = [c for c in upstream if c["status"] != "ok" or c["staleness"] != "fresh"]
    ordered = sorted(
        flagged,
        key=lambda c: (
            -_SEVERITY[c["status"]],
            -_STALE_RANK[c["staleness"]],
            0 if c["zone"] == "todo" else 1,
            c["order"],
            c["id"],
        ),
    )

    status = "ok"
    if upstream:
        status = max((c["status"] for c in upstream), key=lambda s: _SEVERITY[s])
        if status == "ok" and any(c["staleness"] != "fresh" for c in upstream):
            status = "warn"
    if not flagged:
        status = "ok"
        summary = tr("dashboard.overview.all_ok", count=len(upstream))
        detail: list[dict] = []
        href = "#"
    else:
        titles = sorted((c for c in flagged), key=_sort_key)
        summary = _clip(tr("dashboard.overview.flagged", count=len(flagged),
                           titles=_list_separator().join(c["title"] for c in titles)))
        # §6.5: detail must have one item per non-ok / non-fresh cell — the aggregate does not apply
        # DETAIL_LIMIT, otherwise the summary claims 6 problem cells while detail lists 5 (at most a dozen
        # upstream cells exist, so truncation buys nothing).
        detail = [
            {
                "text": c["title"] + (_expired_suffix() if c["staleness"] == "expired" else ""),
                "href": c["href"],
            }
            for c in ordered
        ]
        href = ordered[0]["href"] if ordered else "#"

    stale_after = spec["stale_after"] or min(
        [c["stale_after"] for c in upstream] or [120]
    )
    cell = {
        "id": spec["id"],
        "zone": spec["zone"],
        "order": spec["order"],
        "enabled": spec["enabled"],
        "title": tr_text(spec["title"]),
        "status": status,
        "summary": summary,
        "detail": detail,
        "updated_at": generated_at.isoformat(timespec="seconds"),  # the aggregation moment is updated_at
        "href": href,
        "stale_after": stale_after,
        "staleness": "fresh",
        "age_seconds": 0,
        "source": "derived",
        "source_error": None,
    }
    _gate_check(cell)
    return cell


def _next_refresh_in() -> int:
    if not _GROUPS:
        return 0
    remaining = min(state.next_refresh - time.time() for state in _GROUPS.values())
    return max(0, int(remaining))


def _any_source_data() -> bool:
    return any(state.last_success for state in _GROUPS.values())


def build_cells(generated_at: datetime | None = None) -> dict[str, Any]:
    """Compute the whole wall at this moment: ``{generated_at, next_refresh_in, cells}`` (phase F6).

    ① producers come from the registry (``resolve_specs`` = host notification tile ⊕ each plugin's
       ``presentation.tiles`` ⊕ ``dashboard.json`` overrides) — the center owns no cell producer;
    ② group by ``group`` through the TTL cache (single-flight + serve-stale-on-error); each group is
       fetched by the ``fetch`` its producer declares and normalized into ``Outcome`` by ``_outcome_from``;
    ③ assemble each cell (tri-state / staleness / R1–R5) plus the host aggregate ``overview.alerts``, then sort.
    Snapshot persistence and history queries live at the end of this file, unchanged from before phase F.
    """
    specs = resolve_specs()

    groups: dict[str, list[dict]] = {}
    overview_spec: dict[str, Any] | None = None
    for spec in specs:
        if spec["group"] is None:
            overview_spec = spec
            continue
        groups.setdefault(spec["group"], []).append(spec)

    for group, group_specs in groups.items():
        state = _state_for(group, group_specs[0]["refresh"])
        _ensure(state, group_specs)

    # Freeze the "computation time" only after all refreshes finished, otherwise a slow source would push
    # updated_at past generated_at
    now = generated_at or datetime.now(TZ)

    cells: list[dict] = []
    for spec in specs:
        if spec["group"] is None:
            continue
        state = _GROUPS[spec["group"]]
        cells.append(_build_cell(spec, state, now))
    if overview_spec is not None:
        cells.append(_build_overview(overview_spec, cells, now))
    cells.sort(key=_sort_key)

    return {
        "generated_at": now,
        "next_refresh_in": _next_refresh_in(),
        "cells": cells,
    }


# ------------------------------------------------------------ history snapshots


_SNAP_LOCK = threading.Lock()
_snap_state: dict[str, Any] = {"last_epoch": None}


def _parse_epoch(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        return None


def _read_snapshots() -> tuple[list[dict], int]:
    """One snapshot per line. Bad lines are **skipped and counted** so one rotten line cannot ruin the whole
    list (contract §8)."""
    path = snapshot_file()
    items: list[dict] = []
    bad = 0
    if not path.is_file():
        return items, bad
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        LOG.warning("[dashboard] 快照文件读不了：%s", exc)
        return items, 1
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except Exception:
            bad += 1
            continue
        if isinstance(record, dict) and isinstance(record.get("id"), str):
            items.append(record)
        else:
            bad += 1
    if bad:
        LOG.warning("[dashboard] 跳过 %d 行坏快照（%s）", bad, path)
    items.sort(key=lambda r: r["id"], reverse=True)
    return items, bad


def _prune(items: list[dict]) -> list[dict]:
    cutoff = time.time() - _SNAP_RETENTION_SECONDS
    kept = []
    for record in items:
        epoch = _parse_epoch(record.get("captured_at"))
        if epoch is None or epoch >= cutoff:
            kept.append(record)
    return kept[:_SNAP_RETENTION_COUNT]


def _write_snapshots(items: list[dict]) -> None:
    path = snapshot_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "\n".join(json.dumps(r, ensure_ascii=False) for r in items) + ("\n" if items else "")
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(body, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def maybe_write_snapshot(cells: list[dict], generated_at: datetime) -> None:
    """One snapshot per 300 s by default; nothing is written while the server has no data yet (contract §8)."""
    enabled = [c for c in cells if c.get("enabled")]
    if not enabled or not _any_source_data():
        return
    interval = snapshot_interval()
    with _SNAP_LOCK:
        now = time.time()
        items: list[dict] | None = None
        last = _snap_state["last_epoch"]
        if last is None:
            items, _bad = _read_snapshots()
            if items:
                last = _parse_epoch(items[0].get("captured_at"))
                _snap_state["last_epoch"] = last
        if last is not None and now - last < interval:
            return
        if items is None:
            items, _bad = _read_snapshots()

        snapshot_id = "sn_" + generated_at.strftime("%Y%m%dT%H%M%S")
        if items and items[0].get("id") == snapshot_id:
            _snap_state["last_epoch"] = now
            return

        totals = {"ok": 0, "warn": 0, "alert": 0}
        for cell in enabled:
            totals[cell["status"]] = totals.get(cell["status"], 0) + 1
        record = {
            "id": snapshot_id,
            "captured_at": generated_at.isoformat(timespec="seconds"),
            "cell_count": len(enabled),
            "totals": totals,
            "flagged": any(c["status"] != "ok" or c["staleness"] == "expired" for c in enabled),
            "cells": enabled,
        }
        items.insert(0, record)
        try:
            _write_snapshots(_prune(items))
            _snap_state["last_epoch"] = now
        except OSError as exc:
            LOG.warning("[dashboard] 快照写不进去（%s）", exc)


def list_snapshots(limit: int, before: str | None, flagged: bool | None) -> tuple[list[dict], bool]:
    items, _bad = _read_snapshots()
    if before:
        items = [r for r in items if r["id"] < before]
    if flagged is not None:
        items = [r for r in items if bool(r.get("flagged")) is flagged]
    has_more = len(items) > limit
    return [_snapshot_row(r) for r in items[:limit]], has_more


def _snapshot_row(record: dict) -> dict:
    """The list returns metadata only; the full cell array lives in the detail view (contract §4.3/§4.4)."""
    return {key: record.get(key) for key in
            ("id", "captured_at", "cell_count", "totals", "flagged")}


def get_snapshot(snapshot_id: str) -> dict | None:
    items, _bad = _read_snapshots()
    for record in items:
        if record.get("id") == snapshot_id:
            return record
    return None
