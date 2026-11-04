"""Plugin-owned translations.

A plugin ships its own strings: ``locales/en.json`` and ``locales/zh-CN.json``
(flat ``{"key": "text"}`` maps, dots allowed in the key). The host registers them
under the ``plugins.<id>.`` namespace and resolves every ``@key`` in the manifest
through them, so a third-party plugin can be fully translated without the core
catalog knowing it exists — the core's ``TEXT_EN`` model only works for adapters
that live in this repository.

Manifest fields that accept ``@key``: ``name``, ``description``, tile ``title``,
config ``help``, and every ``help``/``description`` on the route / MCP / CLI
faces (params and subcommands included).

A key that is not in the catalog is left as ``@key`` and reported, never
silently dropped: a typo has to be visible.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from yhub.i18n import normalize_lang, plugin_text, register_plugin_catalog, tr

LOCALES_DIR = "locales"
#: Languages a plugin may ship. `zh` is accepted as an alias of `zh-CN`.
_LANG_FILES = {"en": "en.json", "zh-CN": "zh-CN.json", "zh": "zh-CN.json"}


def _bad(where: str, msg: str) -> ValueError:
    return ValueError(f"{where}: {msg}")


def load_catalogs(dir_path: Path, plugin_id: str) -> dict[str, dict[str, str]]:
    """Read ``<plugin>/locales/*.json``; a missing directory means "no translations"."""
    root = dir_path / LOCALES_DIR
    if not root.is_dir():
        return {}
    out: dict[str, dict[str, str]] = {}
    for name, filename in _LANG_FILES.items():
        path = root / filename
        if not path.is_file():
            continue
        where = f"{dir_path.name}/{LOCALES_DIR}/{filename}"
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise _bad(where, tr("plugins.err.locales_parse", line=exc.lineno, message=exc.msg)) from exc
        except OSError as exc:
            raise _bad(where, tr("plugins.err.unreadable", reason=exc.strerror or exc)) from exc
        if not isinstance(raw, dict):
            raise _bad(where, tr("plugins.err.locales_not_object", type=type(raw).__name__))
        bad = sorted(k for k, v in raw.items() if not isinstance(k, str) or not isinstance(v, str))
        if bad:
            raise _bad(where, tr("plugins.err.locales_bad_entry", keys=bad[:3]))
        lang = normalize_lang(name) or "en"
        merged = out.setdefault(lang, {})
        merged.update({str(k): str(v) for k, v in raw.items()})
    return out


def _resolve(plugin_id: str, value: Any, missing: list[str]) -> Any:
    if not isinstance(value, str) or not value.startswith("@"):
        return plugin_text(plugin_id, value) if isinstance(value, str) else value
    resolved = plugin_text(plugin_id, value)
    if resolved == value:
        missing.append(value[1:])
    return resolved


def _params(params: Any, plugin_id: str, missing: list[str]) -> None:
    if not isinstance(params, list):
        return
    for item in params:
        if not isinstance(item, dict):
            continue
        if "help" in item:
            item["help"] = _resolve(plugin_id, item["help"], missing)
        # body containers carry their own `fields`; each field has its own help
        if isinstance(item.get("fields"), list):
            _params(item["fields"], plugin_id, missing)


def localize(manifest: dict, plugin_id: str) -> list[str]:
    """Translate every localizable string of ``manifest`` **in place**; returns unresolved keys."""
    missing: list[str] = []
    for key in ("name", "description"):
        if key in manifest:
            manifest[key] = _resolve(plugin_id, manifest[key], missing)

    presentation = manifest.get("presentation")
    if isinstance(presentation, dict):
        for tile in presentation.get("tiles") or []:
            if isinstance(tile, dict) and "title" in tile:
                tile["title"] = _resolve(plugin_id, tile["title"], missing)

    for item in manifest.get("config") or []:
        if isinstance(item, dict) and "help" in item:
            item["help"] = _resolve(plugin_id, item["help"], missing)

    faces = manifest.get("faces")
    if not isinstance(faces, dict):
        return missing
    for route in faces.get("routes") or []:
        if isinstance(route, dict):
            _params(route.get("params"), plugin_id, missing)
    for tool in faces.get("mcp") or []:
        if not isinstance(tool, dict):
            continue
        if "description" in tool:
            tool["description"] = _resolve(plugin_id, tool["description"], missing)
        _params(tool.get("params"), plugin_id, missing)
    cli = faces.get("cli")
    if isinstance(cli, dict):
        if "help" in cli:
            cli["help"] = _resolve(plugin_id, cli["help"], missing)
        _params(cli.get("params"), plugin_id, missing)
        for sub in cli.get("subcommands") or []:
            if isinstance(sub, dict):
                if "help" in sub:
                    sub["help"] = _resolve(plugin_id, sub["help"], missing)
                _params(sub.get("params"), plugin_id, missing)
    return missing


def prepare(manifest: dict, dir_path: Path) -> list[str]:
    """Register a plugin's catalogs, then resolve its manifest. Returns unresolved ``@keys``."""
    plugin_id = str(manifest.get("id") or dir_path.name)
    catalogs = load_catalogs(dir_path, plugin_id)
    if catalogs:
        register_plugin_catalog(plugin_id, catalogs)
    return localize(manifest, plugin_id)
