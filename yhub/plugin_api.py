"""Stable plugin API: the only host module external plugins should import.

Usage:

    from yhub.plugin_api import ToolError, ok, err, http_probe, safe_url, TZ

`PLUGIN_API_VERSION` corresponds to the `api` field in `plugin.json`; the host
only loads plugins whose api is <= the version it supports. This module only
re-exports; the real implementation stays in `yhub.server.adapters._cell_fetch`
(internal and subject to change).
"""

from __future__ import annotations

from yhub.i18n import current_lang, tr as _tr
from yhub.server.adapters import ToolError
from yhub.server.adapters.plugin_api import (
    DETAIL_LIMIT,
    SUMMARY_LIMIT,
    TZ,
    err,
    http_probe,
    ok,
    safe_url,
    strip_userinfo,
    clip,
    when_text,
)

__all__ = [
    "PLUGIN_API_VERSION",
    "translator", "lang",
    "ToolError",
    "ok", "err", "clip",
    "http_probe", "when_text",
    "safe_url", "strip_userinfo",
    "DETAIL_LIMIT", "SUMMARY_LIMIT",
    "TZ",
]

PLUGIN_API_VERSION = 1


def lang() -> str:
    """Current UI language: ``"en"`` or ``"zh-CN"`` (settings `ui_language`, then ``YHUB_LANG``)."""
    return current_lang()


def translator(plugin_id: str):
    """Return a ``t("key", **params)`` bound to this plugin's own catalog.

    Strings live in ``<plugin>/locales/en.json`` and ``zh-CN.json``; the host registers
    them under ``plugins.<id>.`` when the plugin loads. A missing key returns the key
    itself so a typo is visible instead of rendering as an empty string::

        from yhub.plugin_api import translator
        t = translator("zdic")
        raise ToolError(t("err.no_word", word=word))
    """
    prefix = f"plugins.{plugin_id}."

    def t(key: str, **params) -> str:
        return _tr(prefix + key, **params)

    return t
