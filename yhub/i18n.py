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
