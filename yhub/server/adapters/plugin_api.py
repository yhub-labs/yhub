"""Stable plugin API: the only host module external plugins should import.

External plugins must not import host internals (``_cell_fetch`` / ``_dashboard_sources`` /
``_scheduler``); those are implementation details. This module is the stable public surface.
"""

from __future__ import annotations

# Fetch envelope: fetch hooks return a plain dict (the host normalizes it internally).
from ._cell_fetch import err, ok

# Probe and display helpers.
from ._cell_fetch import http_probe, when_text

# URL sanitizing: run before responses/logs (contract R7: never leak credentials).
from ._cell_fetch import safe_url, strip_userinfo

# Display limits (summary clipped to 80 chars, at most 5 detail rows).
from ._cell_fetch import DETAIL_LIMIT, SUMMARY_LIMIT

# Clip helper: plugins produce cell summaries, so they must clip the same way the host does.
from ._cell_fetch import clip

# Timezone: user-facing time text follows the machine (TZ env overrides it).
from ._cell_fetch import TZ

__all__ = [
    "ok", "err", "clip",
    "http_probe", "when_text",
    "safe_url", "strip_userinfo",
    "DETAIL_LIMIT", "SUMMARY_LIMIT",
    "TZ",
]
