"""Read/write capability for the settings file (`~/.config/yhub/settings.json`): CLI and web can write too.

The desktop shell, the web UI and the CLI all read and write this file; read/write semantics live
here and the UIs only display.

Contract (dotted paths, the **same scheme** as `tauri/src/config.rs`):

  * GET  /api/settings        all settings (defaults filled in) + key catalog schema + file path + warnings
  * PUT  /api/settings        `{"key": "…", "value": …}` changes one key; `{"keys": {…}}` changes several;
                              `null` restores that key's default; any other invalid value → 400 and
                              **not a single byte is written**
  * POST /api/settings/reset  `{"key": "…"}` restores one key; without `key` everything goes back to defaults

Split with the Rust side (**same file, same paths, same validation** — change one, change both):

  * Rust writes the whole struct back on every save (`serde_json::to_value(&Settings)`), so keys only
    Python knows about are wiped when the shell saves. Adding a field means adding it on both sides.
  * Python is the opposite: it reads the raw JSON, touches only the target keys and writes the rest back
    verbatim, so it never drops anything it does not know (even fields written by a newer shell). The
    direction is safe, but not a reason to be lazy the other way.
  * Key catalog / enum parity is guarded by `tauri/scripts/verify-settings-parity.sh` (compares the
    constants on both sides).

Read leniently, write strictly (same rule as Rust): a broken field only falls back for itself and adds a
warning; a file that is not valid JSON is copied to `settings.json.corrupt-<timestamp>.bak` and defaults
are used; writes are atomic (temp file + `os.replace`) and a rejected write writes nothing. **No
in-memory cache** — the file is read every time, so "takes effect immediately" holds by construction
and no other place can hold a stale value.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import Request, Response  # noqa: F401  (Response is used for type annotations and future extension)

from yhub.i18n import tr

from yhub.i18n import tr_text

from . import ToolError

# ----------------------------------------------------------------- constants
# This group must match the same-named constants in tauri/src/config.rs verbatim
# (verify-settings-parity.sh compares them)

SETTINGS_VERSION = 1
SETTINGS_FILE = "settings.json"
ENV_SETTINGS_FILE = "YHUB_SETTINGS_FILE"
ENV_CONFIG_DIR = "YHUB_CONFIG_DIR"

DEFAULT_HOTKEY = "Option+Space"

# Bindable hotkey actions: id / UI name / default combo (empty = unbound by default)
HOTKEY_ACTIONS: list[dict[str, str]] = [
    {"id": "toggle_panel", "name": "呼出 / 收起面板", "default_combo": DEFAULT_HOTKEY},
    {"id": "show_panel", "name": "只呼出面板", "default_combo": ""},
    {"id": "hide_panel", "name": "只收起面板", "default_combo": ""},
]
HOTKEY_IDS = [a["id"] for a in HOTKEY_ACTIONS]

TRAY_FIELDS = ["close_behavior", "left_click", "double_click", "show_on_start", "show_notifications"]
TRAY_DEFAULTS: dict[str, Any] = {
    "close_behavior": "hide",
    "left_click": "toggle_panel",
    "double_click": "none",
    "show_on_start": False,
    "show_notifications": False,
}
CLOSE_BEHAVIORS = ["hide", "quit"]
CLICK_BEHAVIORS = ["toggle_panel", "show_menu", "none"]

# Top-level (non-section) keys (version is program-maintained; capsules_dir is the "capsules in your library"
# directory scanned by yhub/server/adapters/capsules.py)
TOP_DEFAULTS: dict[str, Any] = {
    "version": SETTINGS_VERSION,
    "capsules_dir": "",
    "capsules_disabled": [],
    # Per-capsule origin (<slug>.localhost:8790): off by default, keeping the current 127.0.0.1 addresses.
    "capsules_subdomains": False,
    # Per-capsule overrides {scope: bool}; scope = relative directory of a directory capsule / single filename.
    # Effective value = overrides[scope] ?? capsules_subdomains.
    "capsules_subdomains_overrides": {},
    # UI / error language: en | zh-CN.
    "ui_language": "en",
    # Plugin marketplace index (registry JSON URL / file:// / local path); empty = not configured
    "plugins_registry_url": "",
}

# Combos: modifier alias → canonical name. Super/Meta/Command all mean ⌘, Alt means ⌥ (same as Tauri's parser)
_MODIFIER_ALIASES = {
    "cmd": "cmd",
    "command": "cmd",
    "super": "cmd",
    "meta": "cmd",
    "ctrl": "ctrl",
    "control": "ctrl",
    "shift": "shift",
    "cmdorctrl": "cmd",
    "alt": "option",
    "option": "option",
    "opt": "option",
}
# Fixed order of canonical modifiers (used when comparing for conflicts, so a different spelling order
# does not turn one key into two)
_MODIFIER_ORDER = ["cmd", "ctrl", "option", "shift"]

# Legal spellings for a non-modifier key (Tauri's Shortcut uses W3C key names; this is the common subset)
_NAMED_KEYS = {
    "space",
    "tab",
    "enter",
    "return",
    "escape",
    "esc",
    "backspace",
    "delete",
    "up",
    "down",
    "left",
    "right",
    "arrowup",
    "arrowdown",
    "arrowleft",
    "arrowright",
    "home",
    "end",
    "pageup",
    "pagedown",
    "insert",
    "minus",
    "equal",
    "comma",
    "period",
    "slash",
    "backslash",
    "semicolon",
    "quote",
    "bracketleft",
    "bracketright",
    "backquote",
}


# --------------------------------------------------------- config dir and file


def config_dir() -> Path:
    """Same fallbacks as the shell: parent of `YHUB_SETTINGS_FILE` > `YHUB_CONFIG_DIR` > ~/.config/yhub"""
    explicit = os.environ.get(ENV_SETTINGS_FILE, "").strip()
    if explicit:
        parent = Path(explicit).expanduser().parent
        if str(parent):
            return parent
    raw = os.environ.get(ENV_CONFIG_DIR, "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".config" / "yhub"


def settings_path() -> Path:
    """Absolute path of `settings.json` (`YHUB_SETTINGS_FILE` names the file itself, for tests)"""
    explicit = os.environ.get(ENV_SETTINGS_FILE, "").strip()
    if explicit:
        return Path(explicit).expanduser()
    return config_dir() / SETTINGS_FILE


# ------------------------------------------------------- key catalog and defaults


def hotkey_default(action: str) -> str | None:
    for item in HOTKEY_ACTIONS:
        if item["id"] == action:
            return item["default_combo"]
    return None


def known_keys() -> list[str]:
    """Dotted paths available (the same list as Rust's `known_keys()`)"""
    keys = ["version", "hotkeys"]
    keys += [f"hotkeys.{a['id']}" for a in HOTKEY_ACTIONS]
    keys.append("tray")
    keys += [f"tray.{f}" for f in TRAY_FIELDS]
    keys.append("capsules_dir")
    keys.append("capsules_disabled")
    keys.append("capsules_subdomains")
    keys.append("capsules_subdomains_overrides")
    keys.append("plugins_registry_url")
    keys.append("ui_language")
    # Open section: only the section name goes in. Plugin-internal keys (plugins.<id>.<key>) are **not**
    # in the catalog — they are declared by the manifest's config section and validated against it
    # (see _config_decls / _check_declared_field)
    keys.append("plugins")
    return keys


def defaults() -> dict[str, Any]:
    """All defaults (the same structure as Rust's `Settings::defaults()`)"""
    return {
        "version": SETTINGS_VERSION,
        "hotkeys": {a["id"]: a["default_combo"] for a in HOTKEY_ACTIONS},
        "tray": dict(TRAY_DEFAULTS),
        "capsules_dir": "",
        "capsules_disabled": [],
        "capsules_subdomains": False,
        "capsules_subdomains_overrides": {},
        "plugins_registry_url": "",
        "ui_language": "en",
        # plugins is an open map: empty by default (key = plugin id, value = that plugin's own config object)
        "plugins": {},
    }


def default_value(key: str) -> Any:
    """Default value for one path; an unknown path → ToolError (which lists every available path)"""
    base = defaults()
    if key == "version":
        raise ToolError(
            tr("settings.version_managed"),
            hint=tr("settings.version_managed_hint"),
        )
    if key in base:
        return base[key]
    for prefix in ("hotkeys", "tray"):
        if key.startswith(prefix + "."):
            field = key.split(".", 1)[1]
            section = base[prefix]
            if field in section:
                return section[field]
    if key.startswith("plugins."):
        # Open section: a plugin section defaults to an empty object; a single key defaults to the
        # **default declared in the manifest** (the host holds no defaults of its own — they live in
        # plugin.json's config section, the source of truth is the plugin)
        plugin_id, field = _split_plugin_path(key)
        if field is None:
            return {}
        decl = _config_decls(plugin_id).get(field)
        if decl is not None and "default" in decl:
            return decl["default"]
        raise ToolError(
            tr("settings.plugin_field_no_default", plugin=plugin_id, field=repr(field)),
            hint=tr("settings.plugin_field_no_default_hint"),
        )
    raise ToolError(
        tr("settings.unknown_key", name=repr(key)),
        hint=tr("settings.unknown_key_hint", paths=" / ".join(known_keys())),
    )


def _split_plugin_path(key: str) -> tuple[str, str | None]:
    """`plugins.<plugin id>[.<key>]` → `(plugin id, key or None)`.

    The key is everything after the first dot (the same split as Rust's `split_once('.')`, so both sides
    always read one path identically; read the whole `plugins.<id>` for nested values).
    """
    rest = key[len("plugins."):]
    plugin_id, sep, field = rest.partition(".")
    return plugin_id, (field if sep else None)


def read_value(settings: dict[str, Any], key: str) -> Any:
    """Read one dotted path from **defaults-filled** settings; an unknown path → ToolError.

    Same semantics as Rust's `get_path()`: a section name (`hotkeys`/`tray`) returns the whole object,
    a leaf path returns one value. The CLI `get` and the web UI both go through it, so neither splits
    strings on its own.
    """
    if key == "version":
        return settings["version"]
    if key == "capsules_dir":
        return settings[key]
    if key == "capsules_disabled":
        val = settings.get("capsules_disabled")
        return list(val) if isinstance(val, list) else []
    if key == "capsules_subdomains":
        return bool(settings.get("capsules_subdomains"))
    if key == "capsules_subdomains_overrides":
        return dict(settings.get("capsules_subdomains_overrides", {}))
    if key == "plugins_registry_url":
        return str(settings.get("plugins_registry_url") or "")
    if key == "ui_language":
        return str(settings.get("ui_language") or "en")
    for prefix in ("hotkeys", "tray"):
        if key == prefix:
            return settings[prefix]
        if key.startswith(prefix + "."):
            field = key.split(".", 1)[1]
            section = settings[prefix]
            if field in section:
                return section[field]
    if key == "plugins":
        return settings["plugins"]
    if key.startswith("plugins."):
        # Open section reads leniently: not installed / never configured → None (same as Rust get_path's null)
        plugin_id, field = _split_plugin_path(key)
        section = settings["plugins"].get(plugin_id)
        if field is None:
            return section
        if not isinstance(section, dict):
            return None
        return section.get(field)
    raise ToolError(
        tr("settings.unknown_key", name=repr(key)),
        hint=tr("settings.unknown_key_hint", paths=" / ".join(known_keys())),
    )


def schema() -> dict[str, Any]:
    """Key catalog for the UI: enums, defaults, bindable actions (the UI must not hardcode its own copy)"""
    return {
        "version": SETTINGS_VERSION,
        "keys": known_keys(),
        "hotkey_actions": [
            {**action, "name": tr_text(action["name"])} for action in HOTKEY_ACTIONS
        ],
        "tray_fields": TRAY_FIELDS,
        "close_behaviors": CLOSE_BEHAVIORS,
        "click_behaviors": CLICK_BEHAVIORS,
        "defaults": defaults(),
    }


# ------------------------------------------------------------------ read (lenient)


def read_raw() -> tuple[dict[str, Any], list[str]]:
    """Read the raw JSON. Returns `(dict, warnings)`; a broken file is backed up first and treated as
    an empty dict (the same handling as Rust)"""
    path = settings_path()
    warnings: list[str] = []
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}, warnings
    except OSError as exc:
        warnings.append(tr("settings.read_failed", path=path, error=exc))
        return {}, warnings
    try:
        data = json.loads(text)
    except ValueError as exc:
        warnings.append(
            _quarantine(path, "corrupt", tr("settings.invalid_json_reason", error=exc))
        )
        return {}, warnings
    if not isinstance(data, dict):
        warnings.append(_quarantine(path, "corrupt", tr("settings.top_level_not_object")))
        return {}, warnings
    return data, warnings


_reading = False


def _probe_language() -> dict[str, Any]:
    """Minimal settings read for yhub.i18n's language lookup (which runs while a full read is in flight).

    It must not build warnings: those are translated with tr(), which resolves the language through
    this module again — that is exactly the call we are answering here.
    """
    base = defaults()
    try:
        data = json.loads(settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return base
    lang = data.get("ui_language") if isinstance(data, dict) else None
    if lang in ("en", "zh-CN"):
        base["ui_language"] = lang
    return base


def read_settings() -> tuple[dict[str, Any], list[str]]:
    """Read settings with defaults filled in. A broken field only falls back for itself, the rest still
    reads (never raises)"""
    global _reading
    if _reading:
        # Re-entrant call (yhub.i18n resolves the language via read_settings): answer the language
        # question only, otherwise the translated warnings below would recurse forever.
        return _probe_language(), []
    _reading = True
    try:
        return _read_settings()
    finally:
        _reading = False


def _read_settings() -> tuple[dict[str, Any], list[str]]:
    raw, warnings = read_raw()
    out = defaults()
    out["version"] = SETTINGS_VERSION  # the version is program-maintained; never read back a user-edited value

    hotkeys = raw.get("hotkeys")
    if isinstance(hotkeys, dict):
        for action in HOTKEY_IDS:
            value = hotkeys.get(action)
            if isinstance(value, str):
                out["hotkeys"][action] = value.strip()
            elif value is not None:
                warnings.append(tr("settings.hotkeys_action_not_string", action=action))
    elif hotkeys is not None:
        warnings.append(tr("settings.hotkeys_not_object"))

    tray = raw.get("tray")
    if isinstance(tray, dict):
        for field in TRAY_FIELDS:
            if field not in tray:
                continue
            value = tray[field]
            expected = TRAY_DEFAULTS[field]
            if isinstance(value, type(expected)):
                out["tray"][field] = value
            else:
                warnings.append(
                    tr(
                        "settings.tray_field_wrong_type",
                        field=field,
                        expected=type(expected).__name__,
                    )
                )
    elif tray is not None:
        warnings.append(tr("settings.tray_not_object"))

    capsules_dir = raw.get("capsules_dir")
    if isinstance(capsules_dir, str):
        out["capsules_dir"] = capsules_dir.strip()
    elif capsules_dir is not None:
        warnings.append(tr("settings.capsules_dir_not_string"))

    capsules_disabled = raw.get("capsules_disabled")
    if isinstance(capsules_disabled, list) and all(isinstance(x, str) for x in capsules_disabled):
        out["capsules_disabled"] = [x.strip() for x in capsules_disabled if x.strip()]
    elif capsules_disabled is not None:
        warnings.append(tr("settings.capsules_disabled_not_string_list"))

    subdomains = raw.get("capsules_subdomains")
    if isinstance(subdomains, bool):
        out["capsules_subdomains"] = subdomains
    elif subdomains is not None:
        warnings.append(tr("settings.capsules_subdomains_not_bool"))

    ui_language = raw.get("ui_language")
    if ui_language in ("en", "zh-CN"):
        out["ui_language"] = ui_language
    elif ui_language is not None:
        warnings.append("ui_language must be en or zh-CN; using the default")

    registry_url = raw.get("plugins_registry_url")
    if isinstance(registry_url, str):
        out["plugins_registry_url"] = registry_url.strip()
    elif registry_url is not None:
        warnings.append(tr("settings.registry_url_not_string"))

    overrides = raw.get("capsules_subdomains_overrides")
    if isinstance(overrides, dict):
        clean = {k: v for k, v in overrides.items() if isinstance(k, str) and k.strip() and isinstance(v, bool)}
        if len(clean) != len(overrides):
            warnings.append(tr("settings.overrides_invalid_entries"))
        out["capsules_subdomains_overrides"] = clean
    elif overrides is not None:
        warnings.append(tr("settings.overrides_not_object"))

    # plugins: open namespace, **read leniently** — only the shape (object) is enforced; a broken
    # single plugin section is skipped with a warning while the rest still reads (one bad plugin must
    # not drag the others down); the write side is strict (apply_value only accepts objects).
    plugins = raw.get("plugins")
    if isinstance(plugins, dict):
        for plugin_id, section in plugins.items():
            if isinstance(section, dict):
                out["plugins"][plugin_id] = section
            else:
                warnings.append(
                    tr("settings.plugin_section_not_object_warning", plugin=plugin_id)
                )
    elif plugins is not None:
        warnings.append(tr("settings.plugins_not_object"))

    return out, warnings


def _quarantine(path: Path, tag: str, why: str) -> str:
    """Move a broken file aside (the user can still recover it); return a human-readable warning"""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    bak = path.with_name(f"{path.name}.{tag}-{stamp}.bak")
    try:
        os.replace(path, bak)
        return tr("settings.quarantine_backed_up", path=path, why=why, backup=bak.name)
    except OSError as exc:
        return tr("settings.quarantine_backup_failed", path=path, why=why, error=exc)


# --------------------------------------------------------------- validate (strict)


def _dir_path(label: str, value: Any) -> str:
    """Directory settings: absolute or `~/` prefixed; empty string disables the feature; trailing slashes stripped"""
    if not isinstance(value, str):
        raise ToolError(
            tr("settings.dir_requires_string", label=label),
            hint=tr("settings.dir_requires_string_hint"),
        )
    trimmed = value.strip()
    if not trimmed:
        return ""
    if not (trimmed.startswith("/") or trimmed.startswith("~/")):
        raise ToolError(
            tr("settings.dir_requires_absolute", label=label, value=repr(trimmed)),
            hint=tr("settings.dir_requires_absolute_hint"),
        )
    return trimmed.rstrip("/")


def _check_bool(label: str, value: Any) -> bool:
    if not isinstance(value, bool):
        raise ToolError(
            tr("settings.bool_required", label=label),
            hint=tr("settings.current_value", value=repr(value)),
        )
    return value


def _check_enum(label: str, value: Any, allowed: list[str]) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise ToolError(
            tr("settings.enum_required", label=label, allowed=" / ".join(allowed)),
            hint=tr("settings.current_value", value=repr(value)),
        )
    return value


def _normalize_combo(combo: str) -> str:
    """Normalize a combo into "modifiers in fixed order + one lowercase key name", for deciding whether
    two spellings are the same key"""
    parts = [p.strip().lower() for p in combo.split("+") if p.strip()]
    mods, keys = [], []
    for part in parts:
        if part in _MODIFIER_ALIASES:
            mods.append(_MODIFIER_ALIASES[part])
        else:
            keys.append(part)
    mods = [m for m in _MODIFIER_ORDER if m in mods]
    return "+".join(mods + keys)


def _check_hotkey(action: str, value: Any, current: dict[str, str]) -> str:
    """Validate a combo: only recognizable spellings, and it must not collide with another action
    (a collision names the owner)"""
    if not isinstance(value, str):
        raise ToolError(
            tr("settings.hotkey_requires_string", action=action),
            hint=tr("settings.hotkey_requires_string_hint"),
        )
    combo = value.strip()
    if not combo:
        return ""  # empty = the action is unbound; allowed

    parts = [p.strip() for p in combo.split("+") if p.strip()]
    named = [p for p in parts if p.lower() not in _MODIFIER_ALIASES]
    mods = [p for p in parts if p.lower() in _MODIFIER_ALIASES]
    if not mods or len(named) != 1:
        raise ToolError(
            tr("settings.hotkey_invalid", combo=repr(combo)),
            hint=tr("settings.hotkey_invalid_hint"),
        )
    key = named[0]
    if (
        len(key) != 1
        or not (key.isalnum() or key in "-=,./\\;'[]`")
    ) and key.lower() not in _NAMED_KEYS and not re.fullmatch(r"f([1-9]|1\d|2[0-4])", key.lower()):
        raise ToolError(
            tr("settings.hotkey_unknown_key", combo=repr(combo), name=repr(key)),
            hint=tr("settings.hotkey_unknown_key_hint"),
        )

    mine = _normalize_combo(combo)
    for other in HOTKEY_IDS:
        if other == action:
            continue
        theirs = current.get(other, "")
        if theirs and _normalize_combo(theirs) == mine:
            label = next(a["name"] for a in HOTKEY_ACTIONS if a["id"] == other)
            raise ToolError(
                tr("settings.hotkey_conflict", combo=combo, label=label),
                hint=tr("settings.hotkey_conflict_hint"),
            )
    return combo


def apply_value(settings: dict[str, Any], key: str, value: Any) -> dict[str, Any]:
    """Apply one change to the in-memory settings (**validate everything before writing: any rejection
    writes nothing**)"""
    if key == "version":
        raise ToolError(
            tr("settings.version_managed"),
            hint=tr("settings.version_managed_hint"),
        )

    if key == "capsules_subdomains":
        if not isinstance(value, bool):
            raise ToolError(tr("settings.capsules_subdomains_must_be_bool"), hint="true / false")
        settings["capsules_subdomains"] = value
        return settings
    if key == "capsules_subdomains_overrides":
        settings["capsules_subdomains_overrides"] = _check_overrides(value)
        return settings
    if key == "plugins_registry_url":
        if not isinstance(value, str):
            raise ToolError(
                tr("settings.registry_url_must_be_string"),
                hint=tr("settings.registry_url_must_be_string_hint"),
            )
        settings["plugins_registry_url"] = value.strip()
        return settings
    if key == "ui_language":
        if value not in ("en", "zh-CN"):
            raise ToolError("ui_language must be en or zh-CN", hint="en / zh-CN")
        settings["ui_language"] = value
        return settings
    if key == "capsules_dir":
        settings["capsules_dir"] = _dir_path("capsules_dir", value)
        return settings
    if key == "capsules_disabled":
        if value is None:
            settings["capsules_disabled"] = []
        elif isinstance(value, list) and all(isinstance(x, str) for x in value):
            settings["capsules_disabled"] = [x.strip() for x in value if x.strip()]
        else:
            raise ToolError(
                tr("settings.capsules_disabled_must_be_list"),
                hint=tr("settings.capsules_disabled_must_be_list_hint"),
            )
        return settings
    if key == "hotkeys":
        if not isinstance(value, dict):
            raise ToolError(
                tr("settings.hotkeys_must_be_object"),
                hint=tr("settings.hotkeys_must_be_object_hint"),
            )
        for action, combo in value.items():
            if action not in HOTKEY_IDS:
                raise ToolError(
                    tr("settings.unknown_hotkey_action", action=repr(action)),
                    hint=tr("settings.unknown_hotkey_action_hint", actions=" / ".join(HOTKEY_IDS)),
                )
            settings["hotkeys"][action] = _check_hotkey(action, combo, {**settings["hotkeys"], **value})
        return settings
    if key == "tray":
        if not isinstance(value, dict):
            raise ToolError(
                tr("settings.tray_must_be_object"),
                hint=tr("settings.tray_must_be_object_hint"),
            )
        for field, field_value in value.items():
            if field not in TRAY_FIELDS:
                raise ToolError(
                    tr("settings.unknown_tray_field", field=repr(field)),
                    hint=tr("settings.unknown_tray_field_hint", fields=" / ".join(TRAY_FIELDS)),
                )
            settings["tray"][field] = _apply_tray_field(field, field_value)
        return settings
    if key == "plugins":
        # Open section written whole: the host enforces the shape (an object whose per-plugin values are
        # objects too) and validates declared fields by type along the way
        if not isinstance(value, dict):
            raise ToolError(
                tr("settings.plugins_must_be_object"),
                hint=tr("settings.plugins_must_be_object_hint"),
            )
        settings["plugins"] = {
            plugin_id: _check_plugin_section(plugin_id, section)
            for plugin_id, section in value.items()
        }
        return settings

    if key.startswith("plugins."):
        plugin_id, field = _split_plugin_path(key)
        if not plugin_id:
            raise ToolError(
                tr("settings.unknown_key", name=repr(key)),
                hint=tr("settings.unknown_key_hint", paths=" / ".join(known_keys())),
            )
        if field is None:
            settings["plugins"][plugin_id] = _check_plugin_section(plugin_id, value)
            return settings
        # Single key: declared fields are validated by the manifest's type; undeclared ones are accepted
        # openly (the host only enforces shape — a plugin's own state flags and not-yet-declared keys go
        # this way, the same lenient rule as the Rust side)
        decl = _config_decls(plugin_id).get(field)
        if decl is not None:
            value = _check_declared_field(plugin_id, field, value, decl)
        section = settings["plugins"].get(plugin_id)
        if not isinstance(section, dict):
            section = {}
        section[field] = value
        settings["plugins"][plugin_id] = section
        return settings

    if key.startswith("hotkeys."):
        action = key.split(".", 1)[1]
        if action not in HOTKEY_IDS:
            raise ToolError(
                tr("settings.unknown_hotkey_action", action=repr(action)),
                hint=tr("settings.unknown_hotkey_action_hint", actions=" / ".join(HOTKEY_IDS)),
            )
        settings["hotkeys"][action] = _check_hotkey(action, value, settings["hotkeys"])
        return settings
    if key.startswith("tray."):
        field = key.split(".", 1)[1]
        if field not in TRAY_FIELDS:
            raise ToolError(
                tr("settings.unknown_tray_field", field=repr(field)),
                hint=tr("settings.unknown_tray_field_hint", fields=" / ".join(TRAY_FIELDS)),
            )
        settings["tray"][field] = _apply_tray_field(field, value)
        return settings

    raise ToolError(
        tr("settings.unknown_key", name=repr(key)),
        hint=tr("settings.unknown_key_hint", paths=" / ".join(known_keys())),
    )


def _apply_tray_field(field: str, value: Any) -> Any:
    if field == "close_behavior":
        return _check_enum("tray.close_behavior", value, CLOSE_BEHAVIORS)
    if field in ("left_click", "double_click"):
        return _check_enum(f"tray.{field}", value, CLICK_BEHAVIORS)
    return _check_bool(f"tray.{field}", value)


# ---------------------------------------------- plugins open section (phase E)
#
# Split of duties: the host (both sides) only enforces **shape** (top-level object, each plugin's value
# an object); field-level validation aggregates **plugin declarations** — they live in plugin.json's
# `config` section and are read here on demand (plugin code is never imported).
# Undeclared plugins/fields stay open (any JSON value): a key the host does not recognize must not be
# rejected for that reason — that is the point of an open namespace. Declared keys are strict (a type
# mismatch → 400 and not a single byte is written).


def _config_decls(plugin_id: str) -> dict[str, dict]:
    """Config fields this plugin declares (`key` → declaration); `{}` when it declares none (open).

    External plugins only have their plugin.json read (the loader's `manifest_config()`), **plugin code
    is never exec'd**: config read/write must not be dragged down by one plugin's import failure. Core
    plugins (`yhub/server/adapters/<id>.py`) have no plugin.json; their declaration lives in the module's
    `TOOL_META["config"]` — also read statically, without running fetches or probes.
    """
    from ._plugin_loader import manifest_config

    items = manifest_config(plugin_id)
    if not items:
        items = _builtin_config_decl(plugin_id)
    return {
        item["key"]: item
        for item in items
        if isinstance(item, dict) and isinstance(item.get("key"), str) and item["key"]
    }


def _builtin_config_decl(plugin_id: str) -> list[dict]:
    """A core plugin's `TOOL_META["config"]` declaration (core modules only; `[]` when absent)."""
    try:
        from . import _iter_modules

        for mod in _iter_modules():
            meta = getattr(mod, "TOOL_META", None)
            if isinstance(meta, dict) and str(meta.get("id", "")) == plugin_id:
                cfg = meta.get("config")
                return cfg if isinstance(cfg, list) else []
    except Exception:  # noqa: BLE001 — reading a declaration must not crash config read/write (fallback: open keys)
        return []
    return []


def _check_declared_field(plugin_id: str, field: str, value: Any, decl: dict) -> Any:
    """Validate one declared field against the manifest's `type` (vocabulary in docs/plugins.md: str/bool/int)"""
    where = f"plugins.{plugin_id}.{field}"
    declared_type = decl.get("type", "str")
    if declared_type == "bool":
        if not isinstance(value, bool):
            raise ToolError(
                tr("settings.declared_bool", where=where),
                hint=tr("settings.current_value", value=repr(value)),
            )
        return value
    if declared_type == "int":
        if not isinstance(value, int) or isinstance(value, bool):
            raise ToolError(
                tr("settings.declared_int", where=where),
                hint=tr("settings.current_value", value=repr(value)),
            )
        return value
    if not isinstance(value, str):
        raise ToolError(
            tr("settings.declared_str", where=where, type=declared_type),
            hint=tr("settings.current_value", value=repr(value)),
        )
    return value


def _check_overrides(value: Any) -> dict[str, bool]:
    if not isinstance(value, dict):
        raise ToolError(
            tr("settings.overrides_must_be_object"),
            hint=tr("settings.overrides_must_be_object_hint"),
        )
    out: dict[str, bool] = {}
    for scope, flag in value.items():
        if not isinstance(scope, str) or not scope.strip():
            raise ToolError(
                tr("settings.overrides_key_must_be_path"),
                hint=tr("settings.overrides_key_must_be_path_hint"),
            )
        if not isinstance(flag, bool):
            raise ToolError(
                tr("settings.overrides_value_must_be_bool", scope=scope),
                hint="true / false",
            )
        out[scope.strip()] = flag
    return out


def _check_plugin_section(plugin_id: str, section: Any) -> dict:
    """The whole `plugins.<plugin id>` section: the shape must be an object, and declared fields are
    type-checked too (validate everything before writing)"""
    if not isinstance(section, dict):
        raise ToolError(
            tr("settings.plugin_section_must_be_object", plugin=plugin_id),
            hint=tr(
                "settings.plugin_section_must_be_object_hint",
                type=type(section).__name__,
            ),
        )
    decls = _config_decls(plugin_id)
    for field, value in section.items():
        decl = decls.get(field)
        if decl is not None:
            _check_declared_field(plugin_id, field, value, decl)
    return dict(section)


# ------------------------------------------------------- write (strict + atomic)


def write_settings(settings: dict[str, Any], raw: dict[str, Any] | None = None) -> Path:
    """Write the settings back: **only known keys are touched, every other field is preserved verbatim**
    (Rust may have written fields we do not know yet).

    `settings` is the defaults-filled structure; `raw` is the raw JSON just read (used to preserve
    fields written by the shell). `plugins` is a **known key**: the validated copy is written
    (bad sections read leniently get tightened
    here), while the keys inside a section are the plugin's own open space and are preserved byte for byte.
    """
    path = settings_path()
    merged: dict[str, Any] = dict(raw or {})
    merged["version"] = SETTINGS_VERSION
    merged["hotkeys"] = dict(settings["hotkeys"])
    merged["tray"] = dict(settings["tray"])
    merged["capsules_dir"] = settings["capsules_dir"]
    merged["capsules_disabled"] = list(settings.get("capsules_disabled", []))
    merged["capsules_subdomains"] = bool(settings.get("capsules_subdomains", False))
    merged["capsules_subdomains_overrides"] = dict(settings.get("capsules_subdomains_overrides", {}))
    merged["plugins_registry_url"] = str(settings.get("plugins_registry_url") or "")
    merged["ui_language"] = str(settings.get("ui_language") or "en")
    merged["plugins"] = dict(settings["plugins"])

    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(merged, ensure_ascii=False, indent=2) + "\n"
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
    return path


def set_values(pairs: dict[str, Any]) -> tuple[dict[str, Any], Path]:
    """Change several keys: validate everything first (including mutual conflicts), then write once.
    Any rejected item → not a single byte is written."""
    if not pairs:
        raise ToolError(
            tr("settings.nothing_to_change"),
            hint=tr("settings.nothing_to_change_hint"),
        )
    current, _warnings = read_settings()
    raw, _raw_warnings = read_raw()
    working = {
        "version": SETTINGS_VERSION,
        "hotkeys": dict(current["hotkeys"]),
        "tray": dict(current["tray"]),
        "capsules_dir": current["capsules_dir"],
        "capsules_disabled": list(current.get("capsules_disabled", [])),
        "capsules_subdomains": bool(current.get("capsules_subdomains", False)),
        "capsules_subdomains_overrides": dict(current.get("capsules_subdomains_overrides", {})),
        "plugins_registry_url": str(current.get("plugins_registry_url") or ""),
        "ui_language": str(current.get("ui_language") or "en"),
        "plugins": dict(current["plugins"]),
    }
    for key, value in pairs.items():
        # null = restore this key's default (the same convention as Rust's set_in)
        resolved = default_value(key) if value is None else value
        working = apply_value(working, key, resolved)
    path = write_settings(working, raw)
    return working, path


def reset_values(key: str | None = None) -> tuple[dict[str, Any], Path]:
    """Restore defaults: a key restores only that one, no key restores the whole file (unknown fields go too)"""
    if key is None:
        fresh = defaults()
        path = write_settings(fresh, {})
        return fresh, path
    value = default_value(key)
    if isinstance(value, dict) and value:
        # Section: expand into per-field changes (same validation path, which also keeps "validate all,
        # then write"). An empty dict (the default of the open `plugins` section) is not expanded —
        # expanding it would mean "change nothing", which looks like a missing argument; writing the
        # empty object back is exactly "restore the default" here.
        return set_values(
            {f"{key}.{field}": field_default for field, field_default in value.items()}
        )
    return set_values({key: value})


# ------------------------------------------------------------------- HTTP API


def _read_response(request: Request) -> dict[str, Any]:
    settings, warnings = read_settings()
    return {
        "ok": True,
        "path": str(settings_path()),
        "settings": settings,
        "schema": schema(),
        "warnings": warnings,
    }


def api_get_settings(request: Request) -> dict[str, Any]:
    """All settings + key catalog + file path (`warnings` explains in plain words which items broke and
    fell back to defaults)"""
    return _read_response(request)


async def _body(request: Request) -> dict[str, Any]:
    """The request body must be a JSON object (empty body = empty object, so callers can POST blindly)"""
    raw = await request.body()
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except ValueError as exc:
        raise ToolError(
            tr("settings.request_body_invalid_json", error=exc),
            hint=tr("settings.request_body_example_hint"),
        )
    if not isinstance(payload, dict):
        raise ToolError(
            tr("settings.request_body_must_be_object"),
            hint=tr("settings.request_body_example_hint"),
        )
    return payload


async def api_put_settings(request: Request) -> dict[str, Any]:
    """Change settings: `{"key":…,"value":…}` or `{"keys":{…}}`; `null` restores the default.

    Validate everything before writing: any invalid item → 400 (`ToolError` is normalized into
    `{ok:false,error,hint}` by main.py) and the file on disk still holds the previous valid content —
    never a half-written one.
    """
    payload = await _body(request)
    pairs: dict[str, Any] = {}
    if "keys" in payload:
        group = payload["keys"]
        if not isinstance(group, dict):
            raise ToolError(
                tr("settings.keys_must_be_object"),
                hint=tr("settings.keys_must_be_object_hint"),
            )
        pairs.update(group)
    if "key" in payload:
        key = payload["key"]
        if not isinstance(key, str):
            raise ToolError(
                tr("settings.key_must_be_string"),
                hint=tr("settings.key_must_be_string_hint"),
            )
        pairs[key] = payload.get("value")
    settings, path = set_values(pairs)
    return {
        "ok": True,
        "path": str(path),
        "settings": settings,
        "changed": sorted(pairs),
        "warnings": [],
    }


async def api_reset_settings(request: Request) -> dict[str, Any]:
    """Restore defaults: `{"key": "…"}` restores one key; without `key` the whole file"""
    payload = await _body(request)
    key = payload.get("key")
    if key is not None and not isinstance(key, str):
        raise ToolError(
            tr("settings.key_must_be_string"),
            hint=tr("settings.reset_key_must_be_string_hint"),
        )
    settings, path = reset_values(key)
    return {"ok": True, "path": str(path), "settings": settings, "reset": key or "*"}




# Capability routes: collected by adapters.discover_routes and mounted by main.py (no launcher entry).
ROUTES = [
    {"method": "GET", "path": "/api/settings", "endpoint": api_get_settings},
    {"method": "PUT", "path": "/api/settings", "endpoint": api_put_settings},
    {"method": "POST", "path": "/api/settings/reset", "endpoint": api_reset_settings},
]
