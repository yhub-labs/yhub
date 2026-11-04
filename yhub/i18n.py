"""Central translation catalog for backend/CLI user-facing messages.

Catalogs live in ``yhub/locales/*.py``; each module exports flat ``EN`` and ``ZH`` maps.
Keys are namespaced by area (``capsules.…``, ``settings.…``, ``cli.…``).

Language resolution order:
  1. ``YHUB_LANG`` environment variable
  2. ``ui_language`` in settings.json
  3. English

Logs are developer-facing and intentionally not translated.
"""

from __future__ import annotations

import importlib
import os
import pkgutil
import re
from typing import Any

_EN: dict[str, str] = {}
_ZH: dict[str, str] = {}
_TEXT_EN: dict[str, str] = {}
_loaded = False
_override: str | None = None

_PARAM_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _load_catalogs() -> None:
    global _loaded
    if _loaded:
        return
    from . import locales

    for info in pkgutil.iter_modules(locales.__path__):
        if info.name.startswith("_"):
            continue
        mod = importlib.import_module(f"{locales.__name__}.{info.name}")
        en = getattr(mod, "EN", {})
        zh = getattr(mod, "ZH", {})
        text_en = getattr(mod, "TEXT_EN", {})
        if isinstance(text_en, dict):
            _TEXT_EN.update({str(k): str(v) for k, v in text_en.items()})
        if isinstance(en, dict):
            _EN.update({str(k): str(v) for k, v in en.items()})
        if isinstance(zh, dict):
            _ZH.update({str(k): str(v) for k, v in zh.items()})
    _loaded = True


def normalize_lang(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if value.lower().startswith("zh"):
        return "zh-CN"
    if value.lower().startswith("en"):
        return "en"
    return None


def current_lang() -> str:
    global _override
    if _override:
        return _override
    env = normalize_lang(os.environ.get("YHUB_LANG"))
    if env:
        return env
    try:
        from .server.adapters.settings import read_settings

        settings, _warnings = read_settings()
        configured = normalize_lang(settings.get("ui_language"))
        if configured:
            return configured
    except Exception:  # noqa: BLE001 - config failures must not break messages
        pass
    return "en"


def set_lang(lang: str | None) -> None:
    """Force a locale for this process (CLI --lang / tests). ``None`` clears the override."""
    global _override
    _override = normalize_lang(lang)


def tr_text(text: str) -> str:
    """Translate legacy Chinese metadata while keeping the source declaration unchanged."""
    _load_catalogs()
    if current_lang() == "zh-CN":
        return text
    return _TEXT_EN.get(text, text)


def register_plugin_catalog(plugin_id: str, catalogs: dict[str, dict[str, str]]) -> None:
    """Register a plugin's own translations under the ``plugins.<id>.`` namespace.

    ``catalogs`` maps a language tag to a flat key/value map, e.g.
    ``{"en": {"name": "Zdic"}, "zh-CN": {"name": "汉典"}}`` read from
    ``<plugin>/locales/en.json`` and ``locales/zh-CN.json``. Plugins own their
    strings: the host catalog only ever holds the core's own keys.
    """
    _load_catalogs()
    prefix = f"plugins.{plugin_id}."
    for lang, mapping in catalogs.items():
        if not isinstance(mapping, dict):
            continue
        target = _ZH if normalize_lang(lang) == "zh-CN" else _EN
        for key, value in mapping.items():
            target[f"{prefix}{key}"] = str(value)


def plugin_text(plugin_id: str, value: str) -> str:
    """Resolve one manifest/declaration string for a plugin.

    ``@key`` → the plugin's own catalog (``plugins.<id>.key``); anything else is a
    legacy literal and goes through :func:`tr_text` (the core adapters' model).
    A missing key returns the source string unchanged, so a typo stays visible in
    the UI instead of turning into an empty label.
    """
    if not isinstance(value, str) or not value.startswith("@"):
        return tr_text(value) if isinstance(value, str) else value
    _load_catalogs()
    key = f"plugins.{plugin_id}.{value[1:]}"
    table = _ZH if current_lang() == "zh-CN" else _EN
    return table.get(key, value)



def tr(key: str, **params: Any) -> str:
    _load_catalogs()
    lang = current_lang()
    template = (_ZH if lang == "zh-CN" else _EN).get(key)
    if template is None:
        template = _EN.get(key, key)
    if not params:
        return template

    def repl(match: re.Match[str]) -> str:
        name = match.group(1)
        return str(params[name]) if name in params else match.group(0)

    return _PARAM_RE.sub(repl, template)
