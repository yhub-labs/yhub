"""Stable plugin API: the only host module external plugins should import.

Usage:

    from yhub.plugin_api import ToolError, ok, err, http_probe, safe_url, TZ

`PLUGIN_API_VERSION` corresponds to the `api` field in `plugin.json`; the host
only loads plugins whose api is <= the version it supports. This module only
re-exports; the real implementation stays in `yhub.server.adapters._cell_fetch`
(internal and subject to change).
"""

from __future__ import annotations

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
    when_text,
)

__all__ = [
    "PLUGIN_API_VERSION",
    "ToolError",
    "ok", "err",
    "http_probe", "when_text",
    "safe_url", "strip_userinfo",
    "DETAIL_LIMIT", "SUMMARY_LIMIT",
    "TZ",
]

PLUGIN_API_VERSION = 1
