"""RSS / Atom core: config I/O, fetching and parsing, in-process cache.

Same split as ``_scheduler.py``: this file (leading underscore -> not in the launcher) holds the
implementation **without faces**; ``rss.py`` only does parameter validation, response wrapping
and the three-face declaration. That way "how one feed is read" has exactly one implementation,
shared by the panel, CLI, MCP and wall cells.

Three design choices (read before changing anything here):

1. **Standard library parsing only** (``xml.etree.ElementTree``). RSS 2.0 / RDF(RSS 1.0) / Atom
differ only in tag names and where the link sits, which a few hundred lines cover; pulling in
a feedparser dependency would complicate both install size and "does it run offline".
2. **Config is File over app** (``~/.config/yhub/rss.json``): adding feeds and changing addresses
   can be done by editing the file; the API/CLI are just another entry point to it (writes go
   through tmp + ``os.replace`` for an atomic swap).
3. **Fetching is bounded**: 2 MiB body, 6 second timeout, capped item count. One broken 500 MB
   feed must not stall the wall.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from xml.etree import ElementTree as ET

from yhub.i18n import tr

from ._cell_fetch import safe_url, session

#: Display timezone: the machine's local zone (see _cell_fetch.local_tz).
from ._cell_fetch import TZ  # noqa: E402  (re-export: one definition for the whole backend)
LOG = logging.getLogger("yhub.rss")

#: Response body cap for one fetch (enough for thousands of items; more is probably not a feed)
MAX_BYTES = 2 * 1024 * 1024
#: Default refresh interval in seconds: RSS is not second-level data, 15 minutes is plenty
DEFAULT_REFRESH = 900
#: Items kept per feed (wall cells show the first 5, the panel can browse a few more)
MAX_ITEMS = 20
DEFAULT_ITEMS = 5
#: Minimum cache TTL: fetching faster would hammer the upstream feed
CACHE_FLOOR = 120
#: Shape of a feed id inside a cell id (same ruler as ``_TILE_ID_RE``)
FEED_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,47}$")


# --------------------------------------------------------------- paths and config


def base_dir() -> Path:
    """Config root: ``YHUB_RSS_DIR`` (tests) → the shared root from ``settings.config_dir()``.

    The shared root is what ``YHUB_CONFIG_DIR`` / ``YHUB_SETTINGS_FILE`` control; falling back to
    ``~/.config/yhub`` here would read the developer's real ``rss.json`` during acceptance runs.
    """
    raw = os.environ.get("YHUB_RSS_DIR", "").strip()
    if raw:
        return Path(raw).expanduser()
    from .settings import config_dir

    return config_dir()


def config_file() -> Path:
    return base_dir() / "rss.json"


def _blank_config() -> dict[str, Any]:
    return {"refresh": DEFAULT_REFRESH, "feeds": []}


def load_config() -> dict[str, Any]:
    """Read ``rss.json``: missing = empty list; unparsable = run with an empty list and log
    one line (never a 500)."""
    path = config_file()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return _blank_config()
    except Exception as exc:  # broken JSON must not make the whole wall unopenable
        LOG.warning("[rss] 配置读不懂（%s：%s），本次按空清单运行", path, exc)
        return _blank_config()
    return _normalize_config(raw)


def _normalize_config(raw: Any) -> dict[str, Any]:
    """Tighten whatever is in the file into something usable: drop bad feeds one by one without
    affecting the others."""
    config = _blank_config()
    if not isinstance(raw, dict):
        return config
    refresh = raw.get("refresh")
    if isinstance(refresh, int) and not isinstance(refresh, bool) and 60 <= refresh <= 86400:
        config["refresh"] = refresh
    feeds = raw.get("feeds")
    if isinstance(feeds, list):
        seen: set[str] = set()
        for index, item in enumerate(feeds):
            feed = _normalize_feed(item, index)
            if feed is None:
                continue
            if feed["id"] in seen:
                LOG.warning("[rss] 重复的订阅 id=%s（第 %d 条），跳过", feed["id"], index)
                continue
            seen.add(feed["id"])
            config["feeds"].append(feed)
    return config


def _normalize_feed(raw: Any, index: int) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        LOG.warning("[rss] feeds[%d] 不是对象，跳过", index)
        return None
    url = str(raw.get("url") or "").strip()
    if not _valid_url(url):
        LOG.warning("[rss] feeds[%d] 的 url 不像 http(s) 地址：%r，跳过", index, url)
        return None
    feed_id = str(raw.get("id") or "").strip().lower()
    if not FEED_ID_RE.match(feed_id):
        feed_id = slugify(url, taken=set())
    title = str(raw.get("title") or "").strip() or _host(url)
    limit = raw.get("limit")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_ITEMS:
        limit = DEFAULT_ITEMS
    return {
        "id": feed_id,
        "title": title[:24],
        "url": url,
        "enabled": bool(raw.get("enabled", True)),
        "limit": limit,
    }


def write_config(config: dict[str, Any]) -> Path:
    """Atomic write-back (tmp + ``os.replace``): an editor reading the file never sees half a JSON."""
    path = config_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(config, ensure_ascii=False, indent=2) + "\n"
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
    return path


def save_feed(feed: dict[str, Any]) -> dict[str, Any]:
    """Add a feed, or **overwrite the entry with the same id in place** (this is the upsert used
    when editing). Returns the entry as written.

    In-place overwrite rather than delete-then-append: feed order decides cell order on the
    wall, so changing an address must not move that cell to the end behind every other feed.
    """
    config = load_config()
    feeds = list(config["feeds"])
    for index, existing in enumerate(feeds):
        if existing["id"] == feed["id"]:
            feeds[index] = feed
            break
    else:
        feeds.append(feed)
    config["feeds"] = feeds
    write_config(config)
    return feed


def drop_feed(feed_id: str) -> dict[str, Any]:
    config = load_config()
    kept = [f for f in config["feeds"] if f["id"] != feed_id]
    if len(kept) == len(config["feeds"]):
        return {"removed": False, "feeds": config["feeds"]}
    config["feeds"] = kept
    write_config(config)
    _CACHE.pop(feed_id, None)
    return {"removed": True, "feeds": kept}


def find_feed(feed_id: str) -> dict[str, Any] | None:
    return next((f for f in load_config()["feeds"] if f["id"] == feed_id), None)


# -------------------------------------------------------------- addresses and naming


def _valid_url(url: str) -> bool:
    parts = urlsplit(url)
    return parts.scheme in ("http", "https") and bool(parts.hostname)


def _host(url: str) -> str:
    return (urlsplit(url).hostname or url).removeprefix("www.")


# The two public helpers (used by rss.py; the underscore versions stay private to this file)
def valid_url(url: str) -> bool:
    return _valid_url(url)


def host(url: str) -> str:
    return _host(url)


def slugify(url: str, taken: set[str]) -> str:
    """Derive a stable id for a feed that has none: ``<hostname>``, with ``-2`` / ``-3`` on collision.

    Stability matters: the cell id is ``rss.<id>``, and changing an address must **not** change
    the id (that would lose its place on the wall), so upsert keeps the caller's id and only
    new feeds get a freshly derived one.
    """
    base = re.sub(r"[^a-z0-9]+", "-", _host(url).lower()).strip("-") or "feed"
    base = base[:40]
    candidate = base
    n = 2
    while candidate in taken:
        candidate = f"{base}-{n}"
        n += 1
    return candidate


# ------------------------------------------------------------- fetch and parse


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _text(el: ET.Element | None) -> str:
    return "".join(el.itertext()).strip() if el is not None else ""


def _child(el: ET.Element, *names: str) -> ET.Element | None:
    for kid in el:
        if _local(kid.tag) in names:
            return kid
    return None


def _child_text(el: ET.Element, *names: str) -> str:
    return _text(_child(el, *names))


def _atom_link(el: ET.Element) -> str:
    """Atom links live in attributes and there are often several (alternate / self / enclosure)."""
    fallback = ""
    for kid in el:
        if _local(kid.tag) != "link":
            continue
        href = (kid.get("href") or "").strip()
        if not href:
            continue
        rel = (kid.get("rel") or "alternate").lower()
        if rel == "alternate":
            return href
        fallback = fallback or href
    return fallback


def _item_link(el: ET.Element) -> str:
    link = _child_text(el, "link")
    if link:
        return link
    atom = _atom_link(el)
    if atom:
        return atom
    guid = _child(el, "guid", "id")
    if guid is not None and (guid.get("isPermaLink") or "").lower() != "false":
        return _text(guid)
    return ""


def _parse_date(raw: str) -> float | None:
    """RSS uses RFC 822 (``Wed, 02 Oct 2002 13:00:00 GMT``), Atom uses ISO-8601."""
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        dt = parsedate_to_datetime(raw)
        if dt is not None:
            return dt.timestamp()
    except (TypeError, ValueError, IndexError):
        pass
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        return None


def _plain(text: str, limit: int = 0) -> str:
    """Titles occasionally carry HTML (``<b>`` / entities); flatten everything before it hits the wall."""
    flat = unescape(re.sub(r"<[^>]+>", "", text or "")).strip()
    flat = re.sub(r"\s+", " ", flat)
    if limit and len(flat) > limit:
        return flat[: max(0, limit - 1)] + "…"
    return flat


def parse_feed(raw: bytes) -> dict[str, Any]:
    """Parse one XML document into ``{title, site, items}``. Dialect differences are smoothed over here."""
    root = ET.fromstring(raw)  # a parse failure is turned into "not a feed" by the caller
    # channel (RSS 2.0) / feed (Atom 1.0) / channel again inside RDF
    channel = next((el for el in root.iter() if _local(el.tag) in ("channel", "feed")), root)
    title = _plain(_child_text(channel, "title"), 60) or ""
    site = _child_text(channel, "link")
    if not site:
        site = _atom_link(channel)

    items: list[dict[str, Any]] = []
    for el in root.iter():
        if _local(el.tag) not in ("item", "entry"):
            continue
        title_text = _plain(_child_text(el, "title"), 120)
        link = _item_link(el).strip()
        published = _parse_date(
            _child_text(el, "pubdate", "published", "updated", "date", "created")
        )
        if not (title_text or link):
            continue
        items.append({"title": title_text or tr("rss.item_untitled"), "href": link, "published_at": published})

    # Sort by time when available (RSS order is **not** guaranteed newest-first); otherwise keep
    # the order used by the feed
    if any(item["published_at"] for item in items):
        items.sort(key=lambda item: item["published_at"] or 0, reverse=True)
    return {"title": title, "site": site.strip(), "items": items}


def fetch(url: str, timeout: float = 6.0) -> dict[str, Any]:
    """Fetch once and parse. Returns ``{ok, title, site, items, fetched_at}`` or
    ``{ok: False, error}``.

    ``ok`` here means **fetching** succeeded (unrelated to the cell's three states): a failure
    always carries a human-readable ``error``, and the caller decides whether to raise it as a
    400 (adding a feed in the panel) or treat it as a cell failure (dashboard).
    """
    if not _valid_url(url):
        return _fail(tr("rss.fetch_invalid_url"), tr("rss.fetch_invalid_url_hint"))
    started = time.time()
    try:
        resp = session().get(
            url,
            timeout=(4.0, timeout),
            stream=True,
            headers={
                "User-Agent": "Y-Hub/0.1 (local RSS reader)",
                "Accept": "application/rss+xml, application/atom+xml, application/xml, "
                          "text/xml;q=0.9, */*;q=0.1",
            },
            allow_redirects=True,
        )
    except Exception as exc:  # connect / timeout / TLS all count as "could not get it"
        return _fail(_net_reason(exc), tr("rss.fetch_network_hint"))
    try:
        if resp.status_code >= 400:
            return _fail(
                tr("rss.fetch_http_status", status=resp.status_code),
                tr("rss.fetch_http_status_hint"),
            )
        chunks: list[bytes] = []
        size = 0
        for chunk in resp.iter_content(64 * 1024):
            size += len(chunk)
            if size > MAX_BYTES:
                return _fail(
                    tr("rss.fetch_too_large", mb=MAX_BYTES // 1024 // 1024),
                    tr("rss.fetch_too_large_hint"),
                )
            chunks.append(chunk)
        body = b"".join(chunks)
    except Exception as exc:
        return _fail(_net_reason(exc), tr("rss.fetch_broken_hint"))
    finally:
        resp.close()

    if not body.strip():
        return _fail(tr("rss.fetch_empty"), tr("rss.fetch_empty_hint"))
    try:
        parsed = parse_feed(body)
    except ET.ParseError as exc:
        return _fail(
            tr("rss.fetch_not_feed", error=exc),
            tr("rss.fetch_not_feed_hint"),
        )
    except Exception:
        LOG.exception("[rss] 解析 %s 出了未预期的异常", safe_url(url))
        return _fail(tr("rss.fetch_unparsable"), tr("rss.fetch_unparsable_hint"))

    if not parsed["items"]:
        return _fail(
            tr("rss.fetch_no_entries"),
            tr("rss.fetch_no_entries_hint"),
        )
    return {
        "ok": True,
        "title": parsed["title"],
        "site": parsed["site"],
        "items": parsed["items"],
        "fetched_at": started,
    }


def _fail(message: str, hint: str) -> dict[str, Any]:
    return {"ok": False, "error": {"message": message, "hint": hint}}


def _net_reason(exc: Exception) -> str:
    name = type(exc).__name__
    text = str(exc)
    if "Timeout" in name or "timeout" in text.lower():
        return tr("rss.net_timeout")
    if "SSL" in name or "SSL" in text:
        return tr("rss.net_tls")
    if "Connection" in name:
        return tr("rss.net_connect")
    return tr("rss.net_failed")


# -------------------------------------------------------------------- cache


_CACHE: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()


def cached(feed: dict[str, Any], *, force: bool = False) -> dict[str, Any]:
    """Cache one fetch per feed (TTL = global refresh interval, at least 120s).

    Why cache at all: the panel (``/api/rss``) and the wall cells are two independent fetch
    paths; without a cache, opening the panel and refreshing the wall once would hit the same
    feed twice.
    """
    ttl = max(CACHE_FLOOR, int(load_config().get("refresh") or DEFAULT_REFRESH))
    now = time.time()
    with _LOCK:
        hit = _CACHE.get(feed["id"])
    if hit and not force and now - hit["at"] < ttl:
        return hit["result"]
    result = fetch(feed["url"])
    with _LOCK:
        _CACHE[feed["id"]] = {"at": now, "result": result}
    return result


def peek(feed_id: str) -> dict[str, Any] | None:
    """Read the cache only, **never online** (wall cell declarations and tool status both use this)."""
    with _LOCK:
        hit = _CACHE.get(feed_id)
    return None if hit is None else hit["result"]


def cache_age(feed_id: str) -> float | None:
    with _LOCK:
        hit = _CACHE.get(feed_id)
    return None if hit is None else time.time() - hit["at"]
