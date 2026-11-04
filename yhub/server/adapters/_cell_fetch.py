"""Shared cell-fetch helpers: state and utilities the built-in plugins' ``fetch`` use.

Why a separate file: once fetching is owned per cell the **producers** are spread across plugin
``presentation.tiles``, but "how to probe an endpoint, how to sanitize a URL, how to write one human
sentence" should not be duplicated in every plugin. This module holds **stateless fetch helpers only**,
never a concrete cell declaration (those live in their plugins).

The contract returned to the host is a **plain dict** (``ok()`` / ``err()``), not the center's
``Outcome`` class: external plugins must not import center internals, and built-in plugins follow the
same convention — one rule set, see docs/plugins.md "fetch contract".
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta
from urllib.parse import urlsplit, urlunsplit

import requests

from yhub.i18n import tr

def local_tz():
    """Display timezone: **the machine's** zone, not a fixed one.

    It used to be `ZoneInfo("Asia/Shanghai")`, which is right for exactly one user. On POSIX,
    `datetime.now().astimezone()` honours the `TZ` environment variable, so acceptance runs can pin a
    zone without another config key.
    """
    return datetime.now().astimezone().tzinfo


TZ = local_tz()
LOG = logging.getLogger("yhub.cellfetch")

#: summary cap (always clipped to 80 chars before it reaches the response, contract §3.1)
SUMMARY_LIMIT = 80
#: detail item cap (the aggregate cell ignores it, see _dashboard_sources._build_overview)
DETAIL_LIMIT = 5


# --------------------------------------------------------------- result envelope


def ok(summary: str, status: str = "ok", detail: list[dict] | None = None,
       updated_at: float | None = None) -> dict:
    """Success result of the fetch contract. ``updated_at`` is epoch seconds (sync cells = the moment of the
    last successful sync)."""
    return {"ok": True, "status": status, "summary": summary,
            "detail": detail or [], "updated_at": updated_at}


def err(message: str, hint: str) -> dict:
    """Failure result of the fetch contract: the host turns it into a ``source_error`` cell (R2, never fake green)."""
    return {"ok": False, "error": {"message": message, "hint": hint}}


# ---------------------------------------------------------------- text helpers


def clip(text: str, limit: int = SUMMARY_LIMIT) -> str:
    return text if len(text) <= limit else text[: max(0, limit - 1)] + "…"


def when_text(ts: float) -> str:
    """``02:14`` / ``昨天 02:14`` / ``09-23 17:37`` (Asia/Shanghai, 24-hour)."""
    dt = datetime.fromtimestamp(ts, TZ)
    now = datetime.now(TZ)
    if dt.date() == now.date():
        return dt.strftime("%H:%M")
    if dt.date() == now.date() - timedelta(days=1):
        return tr("dashboard.time.yesterday") + dt.strftime("%H:%M")
    return dt.strftime("%m-%d %H:%M")


# ------------------------------------------------------------------ URL sanitizing


def _split(url: str):
    try:
        return urlsplit(url)
    except ValueError:
        return None


def strip_userinfo(url: str) -> str:
    """Drop ``user:pass@`` (used for ``href``; the query string is kept because deep links need it)."""
    parts = _split(url)
    if parts is None or not (parts.username or parts.password):
        return url
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    return urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))


def safe_url(url: str) -> str:
    """Drop userinfo and the query string (used for ``source`` / error text, R7: credentials never appear in a
    response)."""
    parts = _split(url)
    if parts is None:
        return url
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    return urlunsplit((parts.scheme, host, parts.path, "", ""))


# ---------------------------------------------------------------------- HTTP


_local = threading.local()


def session() -> requests.Session:
    """Reuse one session per thread. ``trust_env=False``: no proxy/`.netrc`, so local tokens are never taken
    (contract §11)."""
    sess = getattr(_local, "sess", None)
    if sess is None:
        sess = requests.Session()
        sess.trust_env = False
        _local.sess = sess
    return sess


def http_probe(url: str, timeout: float = 3.0) -> tuple[int | None, int | None, str | None]:
    """Probe an endpoint. Returns ``(status code, milliseconds, failure reason)``; ``allow_redirects=False``
    keeps "the source answered itself" states like ``307 · 143 ms`` on the wall as-is (contract §6.3).
    """
    started = time.monotonic()
    try:
        resp = session().get(url, timeout=timeout, stream=True, allow_redirects=False)
        code = resp.status_code
        resp.close()
        return code, int((time.monotonic() - started) * 1000), None
    except requests.exceptions.Timeout:
        return None, None, tr("dashboard.probe.timeout")
    except requests.exceptions.SSLError:
        return None, None, tr("dashboard.probe.tls")
    except requests.exceptions.ConnectionError:
        return None, None, tr("dashboard.probe.connection")
    except requests.exceptions.RequestException:
        return None, None, tr("dashboard.probe.request")
    except Exception:  # noqa: BLE001 — probing is a degraded path; any surprise only makes this one cell speak up
        return None, None, tr("dashboard.probe.unexpected")
