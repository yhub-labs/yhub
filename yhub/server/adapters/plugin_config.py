"""Aggregated read of plugin config sections: `GET /api/plugins` — the config panel renders from it.

Why a separate endpoint (instead of folding it into `/api/settings`): the `GET /api/settings` body is the
single settings contract (locked by `web/verify-cli.mjs`), produced by `yhub/server/adapters/settings.py`. The manifest's `config` declaration is **not data in the
config file** (it lives in plugin.json and is read on demand), so mixing it in would entangle
reconciliation with config semantics — declarations go through this non-reconciled endpoint, while values
still flow through the `settings.plugins.<id>.<key>` dotted paths.

Capability-style module: only `ROUTES`, no `TOOL_META` — no launcher entry (same as settings/capsules, which
main.py discovers automatically). Writes always go through the existing `PUT /api/settings`; this is
read-only.
"""

from __future__ import annotations

from typing import Any

from fastapi import Request  # noqa: F401  (endpoint signatures stay consistent with the other routes in settings.py)

from yhub.i18n import tr

from . import ToolError, discover_adapters, plugin_tiles
from . import plugin_manager
from yhub.i18n import tr_text


def api_get_plugins(request: Request) -> dict[str, Any]:  # noqa: ARG001
    """Declarations of every tool's plugin surface: `[{id, name, icon, config: [...], tiles: [cell ids…]}]`

    `config` comes from the manifest / TOOL_META declaration (defaults and help text live there); current
    values are read from `settings.plugins.<id>` of `GET /api/settings` and assembled by the panel — the
    two sources of truth stay separate. Tools without a config declaration are still listed (as
    `config: []`) and the panel skips empty arrays.

    `tiles` = the ids of the cells this plugin **produces** on the wall
    (`presentation.tiles`), for QA to reconcile per plugin: every cell in `/api/dashboard/cells` except
    the host notification tile must appear in some plugin's declaration. Ids only — fetch functions are
    not JSON.
    """
    tiles_by_plugin: dict[str, list[str]] = {}
    for plugin_id, tile in plugin_tiles():
        cid = tile.get("id")
        if isinstance(cid, str):
            tiles_by_plugin.setdefault(plugin_id, []).append(cid)

    out: list[dict[str, Any]] = []
    for entry in discover_adapters():
        meta = entry["meta"]
        plugin_id = str(meta.get("id", ""))
        declared = meta.get("config")
        out.append(
            {
                "id": meta["id"],
                "name": tr_text(meta["name"]),
                "icon": meta["icon"],
                "config": declared if isinstance(declared, list) else [],
                "tiles": tiles_by_plugin.get(plugin_id, []),
            }
        )
    return {"ok": True, "plugins": out}


def api_plugin_inventory(request: Request) -> dict[str, Any]:  # noqa: ARG001
    """Plugin inventory (management view): **core + installed external + pending in the repo**, with enable
    state and removable flags.

    Split from `GET /api/plugins`: that one serves the **config panel** (which are installed, what keys
    each has), this one serves the **plugin management UI** (see uninstalled entries, core vs third-party,
    removable or not). Both are computed on demand.
    """
    plugins = plugin_manager.list_plugins()
    return {
        "ok": True,
        "plugins": plugins,
        "config_dir": str(plugin_manager.L.plugins_dir()),
        "registry_url": plugin_manager.registry_url(),
    }


async def _body(request: Request) -> dict[str, Any]:
    """Request body JSON (bad JSON becomes ToolError, the same rule as settings.py)."""
    try:
        payload = await request.json()
    except Exception as exc:  # noqa: BLE001 — a bad body is a common source of human-readable errors
        raise ToolError(tr("common.invalid_json"), hint=tr("plugins.err.hint_json_content_type")) from exc
    if not isinstance(payload, dict):
        raise ToolError(tr("common.json_object_required"),
                        hint=tr("plugins.err.hint_json_object_example"))
    return payload


async def api_plugin_install(request: Request) -> dict[str, Any]:
    """Install a plugin: `{"id": "<plugin id in the repo>"}` (or `{"path": "…"}` for any directory).

    The UI only sends an id / path — **all disk work happens in the backend** (iron rule: no path
    resolution or file operations inside the UI). The backend is not restarted automatically; the new
    plugin's code is exec'd on the next start.
    """
    payload = await _body(request)
    source = payload.get("spec") or payload.get("path") or payload.get("id")
    if not isinstance(source, str) or not source.strip():
        raise ToolError(tr("plugins.err.source_required"), hint=tr("plugins.err.hint_id_example_zdic"))
    try:
        result = plugin_manager.install_spec(
            source.strip(),
            force=bool(payload.get("force")),
            ref=str(payload.get("ref") or ""),
        )
    except plugin_manager.PluginError as exc:
        raise ToolError(exc.message, hint=exc.hint) from exc
    return {"ok": True, **result}


async def api_plugin_remove(request: Request) -> dict[str, Any]:
    """Remove a **non-core** plugin; core plugins are refused here (disable-able, not removable)."""
    payload = await _body(request)
    plugin_id = payload.get("id")
    if not isinstance(plugin_id, str) or not plugin_id.strip():
        raise ToolError(tr("plugins.err.id_required"), hint=tr("plugins.err.hint_id_example_sp"))
    try:
        result = plugin_manager.remove_plugin(plugin_id.strip(), purge=bool(payload.get("purge")))
    except plugin_manager.PluginError as exc:
        raise ToolError(exc.message, hint=exc.hint) from exc
    return {"ok": True, **result}


def api_plugin_catalog(q: str = "", refresh: bool = False) -> dict[str, Any]:
    """Plugin marketplace: registry entries + local install state."""
    try:
        entries = plugin_manager.catalog(q, refresh=refresh)
    except plugin_manager.PluginError as exc:
        raise ToolError(exc.message, hint=exc.hint) from exc
    return {"ok": True, "plugins": entries, "registry_url": plugin_manager.registry_url()}


def api_plugin_updates(request: Request) -> dict[str, Any]:  # noqa: ARG001
    try:
        return {"ok": True, "updates": plugin_manager.check_updates()}
    except plugin_manager.PluginError as exc:
        raise ToolError(exc.message, hint=exc.hint) from exc


async def api_plugin_update(request: Request) -> dict[str, Any]:
    payload = await _body(request)
    if payload.get("all"):
        ids = None
    else:
        pid = payload.get("id")
        if not isinstance(pid, str) or not pid.strip():
            raise ToolError(tr("plugins.err.id_or_all_required"))
        ids = [pid.strip()]
    try:
        result = plugin_manager.update_plugins(ids)
    except plugin_manager.PluginError as exc:
        raise ToolError(exc.message, hint=exc.hint) from exc
    return {"ok": True, **result}


# Capability-style routes: collected by adapters.discover_routes, registered by main.py (no launcher tool entry)
ROUTES = [
    {"method": "GET", "path": "/api/plugins", "endpoint": api_get_plugins},
    {"method": "GET", "path": "/api/plugin-inventory", "endpoint": api_plugin_inventory},
    {"method": "POST", "path": "/api/plugin-install", "endpoint": api_plugin_install},
    {"method": "POST", "path": "/api/plugin-remove", "endpoint": api_plugin_remove},
    {"method": "GET", "path": "/api/plugin-catalog", "endpoint": api_plugin_catalog},
    {"method": "GET", "path": "/api/plugin-updates", "endpoint": api_plugin_updates},
    {"method": "POST", "path": "/api/plugin-update", "endpoint": api_plugin_update},
]
