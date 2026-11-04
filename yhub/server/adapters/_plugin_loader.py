"""External plugin loader: scans ``~/.config/yhub/plugins/<id>/`` (``plugin.json`` + ``plugin.py``).

Three hard rules (details in docs/plugins.md):
  1. pure Python — plugins run in the host's interpreter and may only use the stdlib / dependencies the
     host already has;
  2. trust tiers — ``plugin.json`` is read before any code (``trust`` is a declaration; installing means
     full trust);
  3. HTML capsules never come through here — they are only served under ``/capsules/``, with no widgets
     and no three-face declarations.

Load semantics:
  * a ``disabled`` file in the directory = not loaded (escape hatch: drop one in to recover when a
    plugin breaks startup);
  * a bad ``plugin.json`` declaration = ``ValueError`` locating ``<id>/plugin.json.<field>``, red at
    startup, **never silently degraded**;
  * a failing ``plugin.py`` import = skip + one log warning, never crashing startup;
  * imports go through ``importlib`` by file path, exec'd once per process (the failure reason is logged
    once too).

Split of sources (single source of truth, no drift between two declarations):
  * ``plugin.json`` = declaration source (a JSON superset of TOOL_META): id/name/icon/description/
    keywords/trust/enable/faces (handlers referenced by function name)/presentation/config;
  * ``plugin.py`` = code source: it exports ``TOOL_META`` holding **only code hooks** (``ready`` /
    ``status``); face ``handler`` names are resolved from the module namespace into callables.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import re
from pathlib import Path
from typing import Any, Iterator

from yhub.i18n import tr

LOG = logging.getLogger("yhub.plugins")

#: Only schema 2 is accepted; it carries version / min_yhub / api.
SUPPORTED_SCHEMAS = (2,)
#: Plugin API version the host provides; a manifest `api` above it means "not loaded"
PLUGIN_API_VERSION = 1

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_TILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_MCP_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_COMMAND_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

_HTTP_METHODS = ("GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS")
_ZONES = ("todo", "status")
_SPANS = ("sm", "md", "lg", "full")
_TRUST = ("full", "sandbox")

#: Keys allowed at the manifest top level (a typo'd key is an error, never silently ignored)
_MANIFEST_KEYS = {
    "schema", "id", "name", "icon", "description", "keywords",
    "trust", "enable", "kind", "faces", "presentation", "config",
    # schema 2: version and compatibility declarations
    "version", "min_yhub", "api", "author", "homepage", "license",
}
#: Plugin kind: ``core`` ships with the software (disable-able, not removable); ``third-party`` is
#: freely installable and removable. Built-in adapters (yhub/server/adapters/*.py) are core by
#: construction and may not declare this key — only external plugin directories use it to tell
#: "shipped with the repo" from "installed by the user".
_KINDS = ("core", "third-party")
DEFAULT_KIND = "third-party"
_FACE_KEYS = ("routes", "cli", "mcp")
_ROUTE_KEYS = {"method", "path", "handler", "params"}
_CLI_KEYS = {"command", "help", "handler", "params", "subcommands"}
_CLI_SUB_KEYS = {"name", "help", "handler", "params"}
_MCP_KEYS = {"name", "description", "handler", "params"}
_PRESENTATION_KEYS = {"launcher", "icon", "tiles", "panel"}
#: tiles are the **first-class producers** of cells (phase F): layout (zone/order/title/href/span/page)
#: + production (source/group/refresh/params/fetch). Field names match the center's spec (plan §3.2:
#: zone/order keep their names).
_TILE_KEYS = {"id", "zone", "order", "title", "href", "stale_after", "critical", "enabled",
              "span", "page", "source", "group", "refresh", "params", "fetch"}
#: Required producer fields (missing one means the cell should not exist; critical/enabled/params default)
_TILE_REQUIRED = ("id", "zone", "order", "title", "href", "stale_after",
                  "source", "group", "refresh", "fetch")
#: Host-reserved cell id (phase F5): the notification tile aggregates across plugins and belongs to no
#: plugin, so no plugin may declare it
OVERVIEW_ID = "overview.alerts"

#: Cell title limit: the 12 chars set by phase D (overlay) widened to 16 when producers moved into
#: plugins — the longest shipped title measures 13 chars (`example note`), and the declaration limit has to
#: cover the factory set from the center era (the card truncates by width)
TITLE_LIMIT = 16
#: Keys allowed per config item + the declaration type vocabulary (phase E: the panel picks a widget by
#: type and settings.py validates by type)
_CONFIG_KEYS = {"key", "type", "default", "help"}
_CONFIG_TYPES = ("str", "bool", "int")
#: plugin.py's TOOL_META may only hold code hooks (all other fields live in plugin.json)
_CODE_META_KEYS = {"ready", "status"}


def _bad(where: str, msg: str) -> ValueError:
    return ValueError(f"[{where}] {msg}")


def plugins_dir() -> Path:
    """External plugin root: ``plugins/`` under the config root (follows ``YHUB_CONFIG_DIR``, which acceptance
    isolation relies on)."""
    from .settings import config_dir  # lazy import: avoids a cycle during package init

    return config_dir() / "plugins"


#: Enable switch key in the config (``plugins.<id>._enabled``). The leading underscore separates it from
#: the plugin's own keys: ``plugins.<id>.base_url`` is the plugin's, ``_enabled`` is the host's. Because
#: ``plugins`` is an open namespace this key needs no known_keys change on either side and no
#: SETTINGS_VERSION bump.
ENABLED_KEY = "_enabled"


def read_enabled_map() -> dict[str, bool]:
    """Read ``plugins.<id>._enabled`` from ``settings.json`` (absent = enabled).

    Any config read failure (broken file / not created yet) counts as "all enabled": plugin
    enable/disable is an **add-on capability** and must not take the whole backend down with it.
    """
    try:
        from .settings import read_settings

        settings, _warnings = read_settings()
        plugins = settings.get("plugins") or {}
    except Exception:  # noqa: BLE001 — an unreadable config must not drag plugin discovery down
        return {}
    out: dict[str, bool] = {}
    for plugin_id, section in plugins.items():
        if isinstance(section, dict) and isinstance(section.get(ENABLED_KEY), bool):
            out[str(plugin_id)] = section[ENABLED_KEY]
    return out


def is_enabled(plugin_id: str, enabled_map: dict[str, bool] | None = None) -> bool:
    """Whether a plugin is currently enabled (only an **explicit** ``_enabled: false`` disables it)."""
    if enabled_map is None:
        enabled_map = read_enabled_map()
    return enabled_map.get(plugin_id, True)


# --------------------------------------------------------------------- manifest


def _require_str(manifest: dict, key: str, where: str, *, max_len: int = 0) -> str:
    value = manifest.get(key)
    if not isinstance(value, str) or not value.strip():
        raise _bad(where, tr("plugins.err.missing_field", field=repr(key)))
    if max_len and len(value) > max_len:
        raise _bad(where, tr("plugins.err.too_long", field=key, length=len(value), limit=max_len))
    return value


def _validate_params(params: Any, where: str) -> list[dict]:
    """params use the schema shared by all three faces (yhub/server/adapters/params.py); a bad declaration
    carries its location."""
    from .params import normalize_params

    return normalize_params(params, where=where)


def check_tiles(tiles: Any, where: str) -> None:
    """Structure + **producer completeness** validation for ``presentation.tiles``.

    External manifests (read by ``_validate_manifest``) and built-in TOOL_META (``discover_adapters``
    every discovery round) share these rules — one field table, one error style, so the two cannot
    drift. A bad declaration is always a ``ValueError`` locating ``<where>.tiles[i]`` (red at startup,
    never a silently dropped cell).
    """
    if tiles is None:
        return
    if not isinstance(tiles, list):
        raise _bad(where, tr("plugins.err.tiles_not_list", type=type(tiles).__name__))
    seen: set[str] = set()
    for i, tile in enumerate(tiles):
        t_where = f"{where}.tiles[{i}]"
        if not isinstance(tile, dict):
            raise _bad(t_where, tr("plugins.err.dict_required", type=type(tile).__name__))
        unknown = set(tile) - _TILE_KEYS
        if unknown:
            raise _bad(t_where, tr("plugins.err.unknown_keys_available",
                                   keys=sorted(unknown), allowed=sorted(_TILE_KEYS)))
        cid = tile.get("id")
        if not isinstance(cid, str) or not _TILE_ID_RE.match(cid):
            raise _bad(t_where, tr("plugins.err.tile_id_invalid", cell=repr(cid)))
        if cid in seen:
            raise _bad(where, tr("plugins.err.tile_id_duplicate", cell=repr(cid)))
        seen.add(cid)
        if cid == OVERVIEW_ID:
            raise _bad(t_where, tr("plugins.err.tile_id_reserved", cell=repr(cid)))
        # Producer fields are required (since phase F tiles carry their own fetch instead of overriding a
        # center id)
        missing = [key for key in _TILE_REQUIRED if key not in tile or tile[key] in (None, "")]
        if missing:
            raise _bad(t_where, tr("plugins.err.tile_producer_missing", cell=repr(cid), missing=missing))
        if "zone" in tile and tile["zone"] not in _ZONES:
            raise _bad(t_where, tr("plugins.err.zone_unknown", zone=repr(tile['zone']),
                                   allowed='/'.join(_ZONES)))
        if "order" in tile and (not isinstance(tile["order"], int) or isinstance(tile["order"], bool)
                                or tile["order"] < 0):
            raise _bad(t_where, tr("plugins.err.order_invalid", order=repr(tile['order'])))
        if "title" in tile and (not isinstance(tile["title"], str) or not tile["title"].strip()
                                or len(tile["title"]) > TITLE_LIMIT):
            raise _bad(t_where, tr("plugins.err.title_invalid", title=repr(tile['title']),
                                   limit=TITLE_LIMIT))
        if "href" in tile and not isinstance(tile["href"], str):
            raise _bad(t_where, tr("plugins.err.href_invalid", href=repr(tile['href'])))
        if "stale_after" in tile and (not isinstance(tile["stale_after"], int)
                                      or isinstance(tile["stale_after"], bool) or tile["stale_after"] <= 0):
            raise _bad(t_where, tr("plugins.err.stale_after_invalid", value=repr(tile['stale_after'])))
        if not isinstance(tile.get("source"), str) or not tile["source"].strip():
            raise _bad(t_where, tr("plugins.err.source_invalid", value=repr(tile.get('source'))))
        if not isinstance(tile.get("group"), str) or not tile["group"].strip():
            raise _bad(t_where, tr("plugins.err.group_invalid", value=repr(tile.get('group'))))
        if (not isinstance(tile.get("refresh"), int) or isinstance(tile["refresh"], bool)
                or tile["refresh"] <= 0):
            raise _bad(t_where, tr("plugins.err.refresh_invalid", value=repr(tile.get('refresh'))))
        # fetch: a function name in plugin.py (string) for external plugins; built-ins may pass a callable
        fetch = tile.get("fetch")
        if not (callable(fetch) or (isinstance(fetch, str) and fetch.strip())):
            raise _bad(t_where, tr("plugins.err.fetch_invalid", fetch=repr(fetch)))
        if "params" in tile and not isinstance(tile["params"], dict):
            raise _bad(t_where, tr("plugins.err.params_invalid", value=repr(tile['params'])))
        for flag in ("critical", "enabled"):
            if flag in tile and not isinstance(tile[flag], bool):
                raise _bad(t_where, tr("plugins.err.flag_not_bool", flag=flag,
                                       value=repr(tile[flag])))
        if "span" in tile and tile["span"] not in _SPANS:
            raise _bad(t_where, tr("plugins.err.span_unknown", span=repr(tile['span']),
                                   allowed='/'.join(_SPANS)))
        if "page" in tile and (not isinstance(tile["page"], int) or isinstance(tile["page"], bool)
                               or tile["page"] < 1):
            raise _bad(t_where, tr("plugins.err.page_invalid", page=repr(tile['page'])))


def _validate_faces(faces: Any, where: str) -> dict:
    """Structure only (a handler is checked to be a non-empty string; resolving it to a callable happens in
    the merge step)."""
    if not isinstance(faces, dict):
        raise _bad(where, tr("plugins.err.faces_required", type=type(faces).__name__))
    unknown = set(faces) - set(_FACE_KEYS)
    if unknown:
        raise _bad(where, tr("plugins.err.faces_unknown", keys=sorted(unknown),
                             allowed='/'.join(_FACE_KEYS)))
    out: dict = {}

    routes = faces.get("routes")
    if routes is not None:
        if not isinstance(routes, list):
            raise _bad(f"{where}.routes", tr("plugins.err.list_required", type=type(routes).__name__))
        checked = []
        for i, route in enumerate(routes):
            r_where = f"{where}.routes[{i}]"
            if not isinstance(route, dict):
                raise _bad(r_where, tr("plugins.err.dict_required", type=type(route).__name__))
            bad = set(route) - _ROUTE_KEYS
            if bad:
                raise _bad(r_where, tr("plugins.err.unknown_keys_only", keys=sorted(bad),
                                       allowed=sorted(_ROUTE_KEYS)))
            method = route.get("method")
            if not isinstance(method, str) or method.upper() not in _HTTP_METHODS:
                raise _bad(r_where, tr("plugins.err.method_unknown", method=repr(method),
                                       allowed='/'.join(_HTTP_METHODS)))
            path = route.get("path")
            if not isinstance(path, str) or not path.startswith("/"):
                raise _bad(r_where, tr("plugins.err.path_invalid", path=repr(path)))
            if not isinstance(route.get("handler"), str) or not route["handler"].strip():
                raise _bad(r_where, tr("plugins.err.handler_not_name"))
            item: dict[str, Any] = dict(route)
            item["method"] = method.upper()
            if "params" in item:
                item["params"] = _validate_params(item["params"], where=f"{r_where}.params")
            checked.append(item)
        out["routes"] = checked

    cli = faces.get("cli")
    if cli is not None:
        c_where = f"{where}.cli"
        if not isinstance(cli, dict):
            raise _bad(c_where, tr("plugins.err.dict_required", type=type(cli).__name__))
        bad = set(cli) - _CLI_KEYS
        if bad:
            raise _bad(c_where, tr("plugins.err.unknown_keys_only", keys=sorted(bad),
                                   allowed=sorted(_CLI_KEYS)))
        command = cli.get("command")
        if not isinstance(command, str) or not _COMMAND_RE.match(command):
            raise _bad(c_where, tr("plugins.err.command_invalid", command=repr(command)))
        item = dict(cli)
        subs = item.get("subcommands")
        if subs is not None:
            if not isinstance(subs, list) or not subs:
                raise _bad(c_where, tr("plugins.err.subcommands_invalid", value=repr(subs)))
            checked_subs = []
            for sub in subs:
                s_where = f"{c_where}.{sub.get('name', '?')}" if isinstance(sub, dict) else c_where
                if not isinstance(sub, dict):
                    raise _bad(c_where, tr("plugins.err.subcommand_not_dict", type=type(sub).__name__))
                bad = set(sub) - _CLI_SUB_KEYS
                if bad:
                    raise _bad(s_where, tr("plugins.err.unknown_keys_only", keys=sorted(bad),
                                           allowed=sorted(_CLI_SUB_KEYS)))
                if not isinstance(sub.get("name"), str) or not _COMMAND_RE.match(sub["name"]):
                    raise _bad(s_where, tr("plugins.err.subcommand_name_invalid",
                                           name=repr(sub.get('name'))))
                if not isinstance(sub.get("handler"), str) or not sub["handler"].strip():
                    raise _bad(s_where, tr("plugins.err.handler_not_name"))
                sub_item = dict(sub)
                if "params" in sub_item:
                    sub_item["params"] = _validate_params(sub_item["params"], where=f"{s_where}.params")
                checked_subs.append(sub_item)
            item["subcommands"] = checked_subs
        if "params" in item:
            item["params"] = _validate_params(item["params"], where=f"{c_where}.params")
        if not item.get("subcommands") and not item.get("handler"):
            raise _bad(c_where, tr("plugins.err.cli_handler_missing"))
        out["cli"] = item

    mcp = faces.get("mcp")
    if mcp is not None:
        if not isinstance(mcp, list):
            raise _bad(f"{where}.mcp", tr("plugins.err.list_required", type=type(mcp).__name__))
        checked = []
        for i, tool in enumerate(mcp):
            t_where = f"{where}.mcp[{i}]"
            if not isinstance(tool, dict):
                raise _bad(t_where, tr("plugins.err.dict_required", type=type(tool).__name__))
            bad = set(tool) - _MCP_KEYS
            if bad:
                raise _bad(t_where, tr("plugins.err.unknown_keys_only", keys=sorted(bad),
                                       allowed=sorted(_MCP_KEYS)))
            name = tool.get("name")
            if not isinstance(name, str) or not _MCP_NAME_RE.match(name):
                raise _bad(t_where, tr("plugins.err.mcp_name_invalid", name=repr(name)))
            if not isinstance(tool.get("description"), str) or not tool["description"].strip():
                raise _bad(t_where, tr("plugins.err.mcp_description_missing"))
            if not isinstance(tool.get("handler"), str) or not tool["handler"].strip():
                raise _bad(t_where, tr("plugins.err.handler_not_name"))
            item = dict(tool)
            if "params" in item:
                item["params"] = _validate_params(item["params"], where=f"{t_where}.params")
            checked.append(item)
        out["mcp"] = checked

    return out


def _validate_manifest(raw: Any, dir_path: Path, *, allow_dir_mismatch: bool = False) -> dict:
    """Anything unreadable / misdeclared is a ValueError locating ``<id>/plugin.json.<field>``, never a silent
    degradation."""
    where = f"{dir_path.name}/plugin.json"
    if not isinstance(raw, dict):
        raise _bad(where, tr("plugins.err.manifest_not_object", type=type(raw).__name__))
    unknown = set(raw) - _MANIFEST_KEYS
    if unknown:
        raise _bad(where, tr("plugins.err.unknown_keys_docs", keys=sorted(unknown)))
    schema = raw.get("schema")
    if schema not in SUPPORTED_SCHEMAS:
        raise _bad(f"{where}.schema", tr("plugins.err.schema_invalid",
                                         allowed='/'.join(map(str, SUPPORTED_SCHEMAS)),
                                         schema=repr(schema)))
    version = raw.get("version")
    if not isinstance(version, str) or not version.strip():
        raise _bad(f"{where}.version", tr("plugins.err.version_required"))
    if not re.match(r"^\d+\.\d+(\.\d+)?([-+][0-9A-Za-z.-]+)?$", version.strip()):
        raise _bad(f"{where}.version", tr("plugins.err.version_invalid", version=repr(version)))
    for key in ("min_yhub", "author", "homepage", "license"):
        if key in raw and (not isinstance(raw[key], str) or not raw[key].strip()):
            raise _bad(f"{where}.{key}", tr("plugins.err.non_empty_string", field=key))
    if "api" in raw and (not isinstance(raw["api"], int) or isinstance(raw["api"], bool) or raw["api"] < 1):
        raise _bad(f"{where}.api", tr("plugins.err.api_invalid", api=repr(raw['api'])))
    plugin_id = _require_str(raw, "id", where)
    if allow_dir_mismatch:
        where = f"{plugin_id}/plugin.json"
    if not _ID_RE.match(plugin_id):
        raise _bad(f"{where}.id", tr("plugins.err.id_invalid", id=repr(plugin_id)))
    # A single-plugin repository's checkout is named after the repository (`yhub-plugin-zdic`), not
    # after the plugin; installers pass the id explicitly in that case, and this check has to yield.
    if plugin_id != dir_path.name and not allow_dir_mismatch:
        raise _bad(f"{where}.id", tr("plugins.err.id_dir_mismatch", id=repr(plugin_id),
                                     dir=repr(dir_path.name)))
    _require_str(raw, "name", where, max_len=30)
    # icon is an icon name from the new set (a name in the frontend's components/icons, e.g. "memos",
    # "dashboard"); a single-char emoji from older plugins is still accepted (the frontend resolves
    # name → emoji → glyph). The length cap keeps the launcher from being blown out.
    _require_str(raw, "icon", where, max_len=32)
    _require_str(raw, "description", where, max_len=120)
    if "keywords" in raw and not isinstance(raw["keywords"], str):
        raise _bad(f"{where}.keywords", tr("plugins.err.string_required",
                                           type=type(raw['keywords']).__name__))
    if raw.get("trust") not in _TRUST:
        raise _bad(f"{where}.trust", tr("plugins.err.explicit_declaration",
                                        allowed='/'.join(_TRUST), value=repr(raw.get('trust'))))
    enable = raw.get("enable", {"default": True})
    if not isinstance(enable, dict) or set(enable) - {"default"} \
            or not isinstance(enable.get("default", True), bool):
        raise _bad(f"{where}.enable", tr("plugins.err.enable_invalid", value=repr(enable)))
    if "kind" in raw and raw["kind"] not in _KINDS:
        raise _bad(f"{where}.kind", tr("plugins.err.explicit_declaration",
                                       allowed='/'.join(_KINDS), value=repr(raw.get('kind'))))
    if "faces" in raw:
        raw["faces"] = _validate_faces(raw["faces"], where=f"{where}.faces")
    presentation = raw.get("presentation")
    if presentation is not None:
        p_where = f"{where}.presentation"
        if not isinstance(presentation, dict):
            raise _bad(p_where, tr("plugins.err.dict_required", type=type(presentation).__name__))
        bad = set(presentation) - _PRESENTATION_KEYS
        if bad:
            raise _bad(p_where, tr("plugins.err.unknown_keys_only", keys=sorted(bad),
                                   allowed=sorted(_PRESENTATION_KEYS)))
        if "launcher" in presentation and not isinstance(presentation["launcher"], bool):
            raise _bad(f"{p_where}.launcher",
                       tr("plugins.err.launcher_not_bool", value=repr(presentation['launcher'])))
        check_tiles(presentation.get("tiles"), where=p_where)
    if "config" in raw:
        cfg = raw["config"]
        if not isinstance(cfg, list):
            raise _bad(f"{where}.config", tr("plugins.err.list_required", type=type(cfg).__name__))
        seen_cfg: set[str] = set()
        for i, item in enumerate(cfg):
            c_where = f"{where}.config[{i}]"
            if not isinstance(item, dict):
                raise _bad(c_where, tr("plugins.err.dict_required", type=type(item).__name__))
            bad_cfg = set(item) - _CONFIG_KEYS
            if bad_cfg:
                raise _bad(c_where, tr("plugins.err.unknown_keys_only", keys=sorted(bad_cfg),
                                       allowed=sorted(_CONFIG_KEYS)))
            cfg_key = item.get("key")
            if not isinstance(cfg_key, str) or not cfg_key:
                raise _bad(c_where, tr("plugins.err.config_key_missing"))
            if cfg_key in seen_cfg:
                raise _bad(c_where, tr("plugins.err.config_key_duplicate", name=repr(cfg_key)))
            seen_cfg.add(cfg_key)
            cfg_type = item.get("type", "str")
            if cfg_type not in _CONFIG_TYPES:
                raise _bad(
                    f"{c_where}.type",
                    tr("plugins.err.config_type_unknown", type=repr(cfg_type),
                       allowed='/'.join(_CONFIG_TYPES)),
                )
            if "help" in item and not isinstance(item["help"], str):
                raise _bad(f"{c_where}.help", tr("plugins.err.string_required",
                                                 type=type(item['help']).__name__))
            if "default" in item and not _config_type_ok(item["default"], cfg_type):
                raise _bad(f"{c_where}.default", tr("plugins.err.config_default_mismatch",
                                                    value=repr(item['default']), type=cfg_type))
    return raw


def _config_type_ok(value: Any, declared_type: str) -> bool:
    """Whether the manifest default matches the declared type (bool is not int: in JSON, True and 1 are two
    different things)"""
    if declared_type == "bool":
        return isinstance(value, bool)
    if declared_type == "int":
        return isinstance(value, int) and not isinstance(value, bool)
    return isinstance(value, str)


def version_tuple(version: str | None) -> tuple[int, ...]:
    if not version:
        return (0,)
    parts = re.split(r"[.+-]", str(version).strip())
    out: list[int] = []
    for part in parts:
        if part.isdigit():
            out.append(int(part))
        else:
            break
    return tuple(out or [0])


def version_lt(left: str | None, right: str | None) -> bool:
    a, b = version_tuple(left), version_tuple(right)
    width = max(len(a), len(b))
    return a + (0,) * (width - len(a)) < b + (0,) * (width - len(b))


def manifest_config(plugin_id: str) -> list[dict]:
    """Read one external plugin's `plugin.json` `config` declaration on demand (**never imports code**).

    Used by config read/write to validate against declarations / resolve defaults
    (`yhub/server/adapters/settings.py`) and by the config panel's aggregation. Everything unreadable
    returns `[]` (= no declaration, this plugin's keys stay open): plugin not installed, no config
    section, broken JSON, missing directory — config read/write must not die because one plugin is broken.
    """
    path = plugins_dir() / plugin_id / "plugin.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(raw, dict):
        return []
    cfg = raw.get("config")
    if not isinstance(cfg, list):
        return []
    from ._plugin_i18n import prepare as _prepare_i18n

    # `help` may be `@key`; resolve through the plugin's own locales so the settings page is translated.
    _prepare_i18n({"id": plugin_id, "config": cfg}, path.parent)
    return [
        item for item in cfg
        if isinstance(item, dict) and isinstance(item.get("key"), str) and item["key"]
    ]


# ------------------------------------------------------------------- plugin.py


def _import_plugin(code_path: Path) -> Any | None:
    """Import plugin.py by file path. A failing import = skip + warn once (startup never crashes)."""
    key = _code_key(code_path)
    if key in _loaded:
        return _loaded[key]
    if key in _failed:
        return None  # the reason was already warned about once; don't flood the log
    name = "yhub_plugin_" + re.sub(r"\W", "_", code_path.parent.name)
    try:
        spec = importlib.util.spec_from_file_location(name, code_path)
        if spec is None or spec.loader is None:
            raise ImportError(f"建不出 import 规格：{code_path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except Exception as exc:  # noqa: BLE001 — any import-time exception only degrades this one plugin
        _failed[key] = f"{type(exc).__name__}: {exc}"
        LOG.warning(
            "[plugins] %s 导入失败，已跳过（其余插件与内置工具照常）：%s",
            code_path.parent.name, _failed[key],
        )
        return None
    _loaded[key] = module
    _code_meta[key] = getattr(module, "TOOL_META", None)  # archived: only truth after the merge overwrites it
    return module


def _resolve_handler(module: Any, handler_name: str, where: str):
    """Resolve a face handler by name from the plugin.py namespace (not found = bad declaration)."""
    fn = getattr(module, handler_name, None)
    if not callable(fn):
        raise _bad(where, tr("plugins.err.handler_unresolved", handler=repr(handler_name)))
    return fn


def _merge(manifest: dict, module: Any, dir_path: Path, code_meta: Any) -> dict:
    """plugin.json (declaration) ⊕ plugin.py's TOOL_META (code hooks) → runtime meta.

    ``code_meta`` is the raw TOOL_META **archived at import time**: ``module.TOOL_META`` is overwritten
    with the merged result, so a second discovery round (the manifest is re-read on every request) must
    merge from the archive — never from the already merged value.
    """
    where = dir_path.name
    if hasattr(module, "TOOL_METAS"):
        raise _bad(where, tr("plugins.err.tool_metas_external"))
    if not isinstance(code_meta, dict):
        raise _bad(f"{where}/plugin.py", tr("plugins.err.tool_meta_required"))
    bad = set(code_meta) - _CODE_META_KEYS
    if bad:
        raise _bad(f"{where}/plugin.py.TOOL_META",
                   tr("plugins.err.code_meta_unknown", allowed=sorted(_CODE_META_KEYS), bad=sorted(bad)))
    for key in ("ready", "status"):
        if key in code_meta and not callable(code_meta[key]) and not isinstance(code_meta[key], (str, bool)):
            raise _bad(f"{where}/plugin.py.TOOL_META.{key}", tr("plugins.err.code_meta_value"))

    meta: dict[str, Any] = {
        "id": manifest["id"],
        "name": manifest["name"],
        "icon": manifest["icon"],
        "description": manifest["description"],
        # /api/tools fallback: without a probe the plugin simply says "ready" — don't show None
        "ready": code_meta.get("ready", True),
        "status": code_meta.get("status", "就绪"),
        "trust": manifest["trust"],
        "enable": manifest.get("enable", {"default": True}),
        "plugin_dir": str(dir_path),
        "version": manifest.get("version"),
    }
    if manifest.get("keywords"):
        meta["keywords"] = manifest["keywords"]
    if manifest.get("config"):
        meta["config"] = manifest["config"]
    if manifest.get("presentation"):
        meta["presentation"] = manifest["presentation"]

    faces_src = manifest.get("faces")
    if faces_src:
        faces: dict[str, Any] = {}
        routes = faces_src.get("routes")
        if routes is not None:
            faces["routes"] = [
                {**route, "endpoint": _resolve_handler(
                    module, route["handler"], f"{where}.faces.routes[{i}].handler")}
                for i, route in enumerate(routes)
            ]
        cli = faces_src.get("cli")
        if cli is not None:
            cli_out = dict(cli)
            if cli_out.get("handler"):
                cli_out["handler"] = _resolve_handler(
                    module, cli_out["handler"], f"{where}.faces.cli.handler")
            if cli_out.get("subcommands"):
                cli_out["subcommands"] = [
                    {**sub, "handler": _resolve_handler(
                        module, sub["handler"], f"{where}.faces.cli.{sub['name']}.handler")}
                    for sub in cli_out["subcommands"]
                ]
            faces["cli"] = cli_out
        mcp = faces_src.get("mcp")
        if mcp is not None:
            faces["mcp"] = [
                {**tool, "handler": _resolve_handler(
                    module, tool["handler"], f"{where}.faces.mcp[{i}].handler")}
                for i, tool in enumerate(mcp)
            ]
        meta["faces"] = faces
    return meta


# -------------------------------------------------------------- discovery entry


#: External modules exec'd once per file version (key = plugin.py path + inode + mtime + size)
_loaded: dict[tuple, Any] = {}
#: Raw TOOL_META archived at import time (module.TOOL_META is overwritten by the merge; remerging needs this)
_code_meta: dict[tuple, Any] = {}
#: Import failures (same key → first failure reason, warned only once)
_failed: dict[tuple, str] = {}


def _code_key(code_path: Path) -> tuple:
    """Cache key of one plugin.py: path + inode + mtime + size.

    Why the stat and not just the path: a plugin can be uninstalled and reinstalled (or updated in
    place) **while the process runs** — the registry rebuild then has to load the new code, not the
    module object from the previous version. `st_ino` catches the one case mtime misses: installs copy
    the tree with `copytree` (which preserves mtime), so a same-size edit can land on an identical
    (mtime, size) pair — a fresh file is a new inode, though. A reinstall of the very same file still
    hits the cache.
    """
    try:
        path = code_path.resolve()
        st = path.stat()
    except OSError:
        return (code_path.resolve(), 0, 0, 0)
    return (path, st.st_ino, st.st_mtime_ns, st.st_size)


def iter_external_modules() -> Iterator[Any]:
    """Scan the external plugin directory, yielding modules **with a merged manifest** (disabled / failed
    imports skipped).

    ``plugin.json`` is re-read every round (declaration edits apply on the next request); ``plugin.py``
    is exec'd only once **per file version** (a reinstall or update replaces the cached module, so a
    live registry rebuild serves the new code). A bad declaration raises ``ValueError`` here (red at
    startup); an import error degrades here (warn + skip).
    """
    root = plugins_dir()
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return  # directory missing / unreadable = no plugins installed yet, a normal state
    enabled_map = read_enabled_map()
    for dir_path in entries:
        if not dir_path.is_dir() or dir_path.name.startswith((".", "_")):
            continue
        # Escape hatch: a `disabled` file outranks every other check — when a plugin breaks startup,
        # dropping one in restores it (it does not depend on the config still being readable).
        if (dir_path / "disabled").exists():
            LOG.info("[plugins] %s 带 disabled 标记，本次不加载", dir_path.name)
            continue
        # Normal switch: `plugins.<id>._enabled = false` in the config (all three entry points can set it)
        if not is_enabled(dir_path.name, enabled_map):
            LOG.info("[plugins] %s 在配置里被禁用（plugins.%s._enabled=false），本次不加载",
                     dir_path.name, dir_path.name)
            continue
        # The directory name is not even a valid plugin id (e.g. a hand-renamed leftover like
        # super-productivity.bak): it **cannot** be a plugin directory, so warn + skip. When the directory
        # name is valid but the id does not match, startup is still red.
        if not _ID_RE.match(dir_path.name):
            LOG.warning("[plugins] 目录名 %s 不是合法插件 id，不是插件目录，跳过", dir_path.name)
            continue
        manifest_path = dir_path / "plugin.json"
        if not manifest_path.is_file():
            LOG.warning("[plugins] %s 里没有 plugin.json，不是插件目录，跳过", dir_path.name)
            continue
        try:
            raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise _bad(f"{dir_path.name}/plugin.json",
                       tr("plugins.err.json_parse", line=exc.lineno, message=exc.msg))
        except OSError as exc:
            raise _bad(f"{dir_path.name}/plugin.json", tr("plugins.err.unreadable", reason=exc.strerror or exc))
        # Translate **before** validating: the length/format limits must apply to the text the user
        # actually sees, not to the `@key` placeholder (`@tile.tasks.title` is longer than TITLE_LIMIT).
        from ._plugin_i18n import LOCALES_DIR as _LOCALES_DIR, prepare as _prepare_i18n

        unresolved = _prepare_i18n(raw, dir_path)
        if unresolved:
            raise _bad(f"{dir_path.name}/{_LOCALES_DIR}", tr(
                "plugins.err.locales_missing_keys", keys=", ".join(sorted(unresolved)[:6])))
        manifest = _validate_manifest(raw, dir_path)
        from yhub import __version__

        if manifest.get("min_yhub") and version_lt(__version__, manifest["min_yhub"]):
            LOG.warning(
                "[plugins] %s 需要 yhub >= %s（当前 %s），本次不加载",
                dir_path.name, manifest["min_yhub"], __version__,
            )
            continue
        if int(manifest.get("api", 1)) > PLUGIN_API_VERSION:
            LOG.warning(
                "[plugins] %s 声明的插件 API v%s 高于宿主支持的 v%s，本次不加载",
                dir_path.name, manifest.get("api"), PLUGIN_API_VERSION,
            )
            continue
        if not manifest.get("enable", {"default": True}).get("default", True):
            LOG.info("[plugins] %s 的 enable.default=false，本次不加载", dir_path.name)
            continue
        code_path = dir_path / "plugin.py"
        if not code_path.is_file():
            raise _bad(f"{dir_path.name}", tr("plugins.err.plugin_py_missing"))
        module = _import_plugin(code_path)
        if module is None:
            continue  # the import failure was already warned about: degrade honestly, no blank screen
        key = _code_key(code_path)
        module.TOOL_META = _merge(manifest, module, dir_path, _code_meta.get(key))
        yield module
