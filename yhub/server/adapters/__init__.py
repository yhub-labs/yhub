"""Adapters: one file per tool; exporting TOOL_META registers it automatically.

Two ways to add a tool (discovery uses the **same** function, ``discover_adapters()``):
  1. Built-in: add a .py file under yhub/server/adapters/ exporting a TOOL_META dict
     (id/name/icon/description/ready/status + the three faces) -- yhub/server/main.py
     discovers and registers routes automatically; see AGENTS.md for the steps.
  2. External: drop ``plugin.json`` + ``plugin.py`` into ``~/.config/yhub/plugins/<id>/``
     (directory conventions, schema fields and the three rules are in docs/plugins.md).
     plugin.json is a JSON superset of TOOL_META (plus trust/enable sections); plugin.py
     only holds code hooks.

Load semantics: built-ins go through pkgutil (wheel and source tree alike -- adapters are
real .py files on disk); externals are loaded from file paths with importlib. An import
failure skips the plugin and logs a warning (honest degradation, no blank page); a bad
declaration raises ValueError with a location (red at startup, never silent). A
``disabled`` file in the directory means that plugin is not loaded.
"""

from __future__ import annotations

import importlib
import pkgutil
from pathlib import Path
from typing import Any, Callable

from yhub.i18n import tr

from ._plugin_loader import check_tiles, iter_external_modules, plugins_dir  # noqa: F401 (used by docs)


# ------------------------------------------- Registry change hooks (plugin set changed at runtime)
#
# The GUI registers its routes **once** when the process starts, but a third-party plugin can be
# installed, removed, enabled or disabled while it runs. Adapters must not import `yhub.server.main`
# (main imports adapters: that is a cycle), so the host leaves a callback here and every code path that
# changes the plugin set calls `notify_registry_change()`: the tool list and the routes then follow the
# plugin set without a backend restart.
_registry_hooks: list[Callable[[], Any]] = []


def on_registry_change(hook: Callable[[], Any]) -> None:
    """Register a callback run whenever the plugin set / enable state changes (GUI: rebuild routes)."""
    if hook not in _registry_hooks:
        _registry_hooks.append(hook)


def notify_registry_change() -> bool:
    """Tell the host the plugin set changed (install / remove / enable / disable / config write).

    Returns True when a live host rebuilt its registry (so the change is already in effect — no
    restart needed) and False with no hook (CLI process: the running GUI keeps its old registry) or
    when the hook refused (a broken declaration; the host logged it).

    The hook owns its error handling; this function never raises, because losing a settings write over
    a broken plugin declaration would be worse than serving a stale tool list.
    """
    rebuilt = bool(_registry_hooks)
    for hook in list(_registry_hooks):
        try:
            if not hook():
                rebuilt = False
        except Exception:  # noqa: BLE001 — the host logs the reason; never break the caller
            rebuilt = False
    return rebuilt


class ToolError(Exception):
    """User-facing error, normalized to {ok: false, error: "..."} for the frontend."""

    def __init__(self, message: str, *, hint: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint


_HTTP_METHODS = ("GET", "POST", "PUT", "HEAD", "OPTIONS", "DELETE")


def _iter_modules():
    pkg_path = str(Path(__file__).resolve().parent)
    for info in pkgutil.iter_modules([pkg_path]):
        if info.name.startswith("_"):
            continue
        yield importlib.import_module(f".{info.name}", package=__package__)


def _collect_meta(module, adapters: list[dict[str, Any]]) -> None:
    """Collect TOOL_META / TOOL_METAS from one module (shared by built-in and external loading).

    TOOL_META: a single dict (old convention, one tool per module).
    TOOL_METAS: a list of dicts (new convention, several tools per module).
    Both are collected when present; empty lists and non-dict entries are ignored.
    """
    meta = getattr(module, "TOOL_META", None)
    if meta and isinstance(meta, dict):
        adapters.append({"module": module, "meta": meta})
    metas = getattr(module, "TOOL_METAS", None)
    if isinstance(metas, list):
        for item in metas:
            if item and isinstance(item, dict):
                adapters.append({"module": module, "meta": item})


def _check_face_clashes(adapters: list[dict[str, Any]]) -> None:
    """Cross-plugin name/route clash check (fail loud: ValueError at startup, naming both ids)."""
    seen_mcp: dict[str, str] = {}
    seen_cli: dict[str, str] = {}
    seen_route: dict[tuple[str, str], str] = {}
    for entry in adapters:
        meta = entry["meta"]
        plugin_id = str(meta.get("id", "?"))
        faces = meta.get("faces") or {}
        if not isinstance(faces, dict):
            raise ValueError(tr("plugins.err.faces_not_dict",
                                plugin=plugin_id, type=type(faces).__name__))
        for tool in faces.get("mcp") or []:
            name = str(tool.get("name", ""))
            if name in seen_mcp:
                raise ValueError(tr("plugins.err.mcp_name_clash", plugin=plugin_id,
                                    name=repr(name), other=seen_mcp[name]))
            seen_mcp[name] = plugin_id
        cli = faces.get("cli")
        if isinstance(cli, dict) and cli.get("command"):
            command = str(cli["command"])
            if command in seen_cli:
                raise ValueError(tr("plugins.err.cli_command_clash", plugin=plugin_id,
                                    command=repr(command), other=seen_cli[command]))
            seen_cli[command] = plugin_id
        for route in faces.get("routes") or []:
            key = (str(route.get("method", "")).upper(), str(route.get("path", "")))
            if key in seen_route:
                raise ValueError(tr("plugins.err.route_clash", plugin=plugin_id,
                                    method=key[0], path=key[1], other=seen_route[key]))
            seen_route[key] = plugin_id


def _declared_tiles(meta: dict[str, Any]) -> list | None:
    """A tool's declared ``presentation.tiles`` (built-ins may pass a **callable** producing them
    dynamically, e.g. cron.<job>)."""
    presentation = meta.get("presentation")
    if not isinstance(presentation, dict):
        return None
    declared = presentation.get("tiles")
    if callable(declared):
        declared = declared()
    return declared if isinstance(declared, list) else None


def _check_tiles(adapters: list[dict[str, Any]]) -> None:
    """Validate wall cell producer declarations: field table + cross-plugin duplicate ids.

    ``presentation.tiles`` is a **first-class producer** of wall cells -- a bad declaration
    fails loud (ValueError at startup pointing at ``<id>.presentation.tiles[i]``); cells
    must never be dropped silently.
    """
    owners: dict[str, str] = {}
    for entry in adapters:
        meta = entry["meta"]
        plugin_id = str(meta.get("id", "?"))
        declared = _declared_tiles(meta)
        if declared is None:
            continue
        check_tiles(declared, where=f"{plugin_id}.presentation")
        for tile in declared:
            cid = tile["id"]
            if cid in owners:
                raise ValueError(tr("plugins.err.tile_id_clash", plugin=plugin_id,
                                    cell=cid, other=owners[cid]))
            owners[cid] = plugin_id


def discover_adapters() -> list[dict[str, Any]]:
    """Collect every tool: built-ins (pkgutil scan) and externals (plugins directory) share
    one collection routine.

    The built-in scan keeps the original "real directory + pkgutil" behavior; a broken
    external plugin degrades only itself (import failure skips it, a ``disabled`` marker
    keeps it unloaded), while a bad declaration raises ValueError at startup.

    **The enable switch treats both plugin kinds alike** (``plugins.<id>._enabled=false``):
    disabling a core plugin removes its three faces (routes / MCP / CLI) and its cells along
    with it -- that is what "core is disableable but not removable" means in practice.
    Built-ins are not installed into the plugins directory, so ``plugin remove`` cannot
    reach them.
    """
    from ._plugin_loader import is_enabled, read_enabled_map

    enabled_map = read_enabled_map()
    adapters: list[dict[str, Any]] = []
    for mod in _iter_modules():          # built-in: real directory scan (plain files in the wheel too)
        _collect_meta(mod, adapters)
    adapters = [e for e in adapters if is_enabled(str(e["meta"].get("id", "")), enabled_map)]
    for mod in iter_external_modules():  # external: ~/.config/yhub/plugins/<id>/
        _collect_meta(mod, adapters)
    _check_face_clashes(adapters)
    _check_tiles(adapters)
    return adapters


def plugin_tiles() -> list[tuple[str, dict]]:
    """The ``presentation.tiles`` declared by every loaded tool = **the single source of wall
    cells** (the registry).

    Each item is ``(producer id, full tile declaration)``; ``fetch`` is resolved to a
    callable here (externals declare a function name from plugin.py; an unresolvable one is
    a bad declaration and fails loud). Returns an empty list when nothing is declared.
    """
    tiles: list[tuple[str, dict]] = []
    for entry in discover_adapters():
        meta = entry["meta"]
        module = entry["module"]
        declared = _declared_tiles(meta)
        if declared is None:
            continue
        plugin_id = str(meta.get("id", "?"))
        for index, tile in enumerate(declared):
            if not isinstance(tile, dict):
                continue
            resolved = dict(tile)
            fetch = resolved.get("fetch")
            if isinstance(fetch, str):
                fn = getattr(module, fetch, None)
                if not callable(fn):
                    raise ValueError(tr("plugins.err.fetch_unresolved", plugin=plugin_id,
                                        index=index, fetch=repr(fetch)))
                resolved["fetch"] = fn
            tiles.append((plugin_id, resolved))
    return tiles


def discover_routes() -> list[dict[str, Any]]:
    """Collect module-level ROUTES: **capability-style modules** contribute routes only and do
    not occupy a launcher tool entry.

    Each item is ``{"method": "GET|POST|PUT", "path": "/api/…", "endpoint": fn}``.
    Invalid items (unknown method / missing path / non-callable endpoint) are skipped so one
    bad module cannot take down startup. Typical users: `capsules.py` (capsule hosting in
    the library) and `settings.py` (config read/write). Capability ROUTES are a built-in
    convention only; external plugins declare routes in ``faces.routes`` of plugin.json.
    """
    routes: list[dict[str, Any]] = []
    for mod in _iter_modules():
        for route in getattr(mod, "ROUTES", None) or []:
            if not isinstance(route, dict):
                continue
            method = str(route.get("method", "")).upper()
            path = route.get("path")
            endpoint = route.get("endpoint")
            if method in _HTTP_METHODS and isinstance(path, str) and callable(endpoint):
                routes.append({"method": method, "path": path, "endpoint": endpoint})
    return routes
