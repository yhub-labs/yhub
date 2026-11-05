"""RSS subscriptions: many feeds, one tile each; addresses are edited in the panel / CLI / config file.

Placement follows the repository rules (AGENTS.md):
  * only add this file + ``_rss.py``, **never touch ``yhub/server/main.py``** -- ``TOOL_META['routes']``
    registers automatically;
  * fetching, parsing and config I/O all live in ``_rss.py`` (leading underscore -> not in the
    launcher); this file only does parameter validation, response wrapping and face declarations.

Why the wall cells are a **dynamic producer** (``presentation.tiles`` as a callable): one
subscription means one cell, so N subscriptions means N cells. Add an entry to ``rss.json``
and the next ``/api/dashboard/cells`` fetch gains a cell -- no restart, no frontend change.

Config follows File over app: ``~/.yhub/rss.json``. API and CLI write the same file
(tmp + ``os.replace`` atomic swap), so hand edits and panel edits do not conflict.
"""

from __future__ import annotations

import functools
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any

from fastapi.responses import JSONResponse

from yhub.i18n import tr

from . import ToolError
from . import _rss as rss
from ._cell_fetch import DETAIL_LIMIT, clip, err, ok, when_text

LOG = logging.getLogger("yhub.rss")

#: Max cell title length (same ruler as ``_plugin_loader.TITLE_LIMIT``)
TITLE_LIMIT = 16


def _guard(fn):
    """A 500 also returns the standard error body, without leaking the traceback to the frontend
    (same scheme as the dashboard / scheduler)."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except ToolError:
            raise
        except Exception:
            LOG.exception("[rss] %s 出了未预期的异常", fn.__name__)
            return JSONResponse(
                status_code=500,
                content={
                    "ok": False,
                    "error": tr("rss.backend_error"),
                    "hint": tr("rss.backend_error_hint"),
                },
            )

    return wrapper


# --------------------------------------------------------------- view assembly


def _iso(ts: float | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")


def _feed_view(feed: dict[str, Any], *, live: bool) -> dict[str, Any]:
    """Full state of one feed: config fields plus this fetch's result (may carry an error).

    ``url`` is returned verbatim: the panel must edit it, and this endpoint only serves the
    same-machine, same-origin frontend. The copy that reaches the **dashboard** (cell
    ``source`` / ``href``) always goes through ``safe_url`` / ``strip_userinfo``, matching
    rule R7 -- the two differ on purpose, do not copy one into the other.
    """
    result = rss.cached(feed, force=False) if live else (rss.peek(feed["id"]) or {})
    view: dict[str, Any] = {
        "id": feed["id"],
        "title": feed["title"],
        "url": feed["url"],
        "enabled": feed["enabled"],
        "limit": feed["limit"],
        "items": 0,
        "site": "",
        "fetched_at": None,
        "error": None,
    }
    if result and result.get("ok"):
        view["items"] = len(result.get("items") or [])
        view["site"] = result.get("site") or ""
        view["fetched_at"] = _iso(result.get("fetched_at"))
        if not feed["title"] and result.get("title"):
            view["title"] = result["title"]
    elif result and result.get("error"):
        view["error"] = dict(result["error"])
    return view


def _views(feeds: list[dict[str, Any]], *, live: bool) -> list[dict[str, Any]]:
    if not live or not feeds:
        return [_feed_view(feed, live=False) for feed in feeds]
    with ThreadPoolExecutor(max_workers=min(4, max(1, len(feeds)))) as pool:
        return list(pool.map(lambda f: _feed_view(f, live=True), feeds))


def _require_feed(feed_id: str) -> dict[str, Any]:
    feed = rss.find_feed(feed_id)
    if feed is None:
        raise ToolError(
            tr("rss.feed_not_found", feed_id=feed_id),
            hint=tr("rss.feed_not_found_hint"),
        )
    return feed


def _field(body: Any, name: str, default: Any = None) -> Any:
    """Read one body field: a pydantic model attribute on the HTTP face, a plain dict elsewhere."""
    if isinstance(body, dict):
        return body.get(name, default)
    return getattr(body, name, default)


def _as_bool(raw: Any, default: bool) -> bool:
    if isinstance(raw, bool):
        return raw
    if raw is None or raw == "":
        return default
    return str(raw).strip().lower() not in ("0", "false", "no", "off")


# -------------------------------------------------------------------- routes


@_guard
def _route_index(live: str | None = "true"):
    """Feed list plus each feed's current state (panel, CLI and MCP all read this).

    ``live=false`` reads the cache without going online -- for batch scripts or offline use.
    """
    config = rss.load_config()
    do_live = _as_bool(live, True)
    feeds = _views(config["feeds"], live=do_live)
    return {
        "ok": True,
        "feeds": feeds,
        "total": len(feeds),
        "refresh": config["refresh"],
        "config_path": str(rss.config_file()),
        "live": do_live,
    }


@_guard
def _route_save(payload: dict | None = None):
    """Add a feed, or **overwrite the one with the same id** (this upsert is also how you edit it).

    Without ``id`` a stable id is derived from the hostname; POSTing an existing id updates that
    feed and **the cell position stays put** (cell id is ``rss.<id>``, so a changed id loses
    its place on the wall).

    An unreachable URL is still persisted, with ``error`` reported: a broken feed should show up
    as broken on the wall, not let the user fill the form, hit save, and see "saved" while
    nothing actually happened.
    """
    body = payload or {}
    url = str(_field(body, "url") or "").strip()
    if not rss.valid_url(url):
        raise ToolError(
            tr("rss.url_invalid", url=url or tr("rss.empty_input")),
            hint=tr("rss.url_invalid_hint"),
        )
    config = rss.load_config()
    taken = {f["id"] for f in config["feeds"]}
    feed_id = str(_field(body, "id") or "").strip().lower()
    if feed_id:
        if not rss.FEED_ID_RE.match(feed_id):
            raise ToolError(
                tr("rss.feed_id_invalid", feed_id=feed_id),
                hint=tr("rss.feed_id_invalid_hint"),
            )
    else:
        feed_id = rss.slugify(url, taken)
    existing = next((f for f in config["feeds"] if f["id"] == feed_id), None)

    title = str(_field(body, "title") or "").strip() or (existing or {}).get("title") or ""
    limit_raw = _field(body, "limit")
    limit = existing["limit"] if existing else rss.DEFAULT_ITEMS
    if limit_raw not in (None, ""):
        try:
            limit = int(str(limit_raw).strip())
        except ValueError:
            raise ToolError(tr("rss.limit_not_integer", limit=limit_raw), hint=tr("rss.limit_not_integer_hint"))
        if not 1 <= limit <= rss.MAX_ITEMS:
            raise ToolError(tr("rss.limit_out_of_range", limit=limit),
                            hint=tr("rss.limit_out_of_range_hint", max=rss.MAX_ITEMS))

    feed = {
        "id": feed_id,
        "title": (title or rss.host(url))[:24],
        "url": url,
        "enabled": _as_bool(_field(body, "enabled"), existing["enabled"] if existing else True),
        "limit": limit,
    }
    rss.save_feed(feed)  # overwrite on disk, keeping the existing order
    # Fetch right away so the panel can immediately show "read N items" or "unreadable: HTTP 404"
    rss.cached(feed, force=True)
    return {"ok": True, "saved": True, "feed": _feed_view(feed, live=False)}


@_guard
def _route_remove(feed_id: str):
    """Delete a feed (its cell disappears on the next cell fetch)."""
    _require_feed(feed_id)
    result = rss.drop_feed(feed_id)
    return {"ok": True, "removed": bool(result["removed"]), "total": len(result["feeds"])}


@_guard
def _route_refresh(feed_id: str):
    """Re-fetch this feed now (bypassing the cache) and return the latest state.

    Note this refreshes the copy the **panel/MCP** reads; the wall cell is fetched by the host
    on its own ``refresh`` cadence, so it lags by at most one cycle.
    """
    feed = _require_feed(feed_id)
    rss.cached(feed, force=True)
    return {"ok": True, "feed": _feed_view(feed, live=False)}


@_guard
def _route_items(feed_id: str | None = None, limit: str | None = None):
    """Show the items of one feed (panel preview / CLI ``yhub rss items <id>``)."""
    if not feed_id:
        raise ToolError(tr("rss.feed_required"), hint=tr("rss.feed_required_hint"))
    feed = _require_feed(feed_id)
    count = feed["limit"]
    if limit not in (None, ""):
        try:
            count = int(str(limit).strip())
        except ValueError:
            raise ToolError(tr("rss.limit_not_integer", limit=limit),
                            hint=tr("rss.limit_out_of_range_hint", max=rss.MAX_ITEMS))
        if not 1 <= count <= rss.MAX_ITEMS:
            raise ToolError(tr("rss.limit_out_of_range", limit=count),
                            hint=tr("rss.limit_out_of_range_hint", max=rss.MAX_ITEMS))
    result = rss.cached(feed)
    if not result.get("ok"):
        error = result.get("error") or {}
        raise ToolError(error.get("message") or tr("rss.unreadable_now"), hint=error.get("hint") or "")
    items = (result.get("items") or [])[:count]
    return {
        "ok": True,
        "feed": feed["id"],
        "title": result.get("title") or feed["title"],
        "site": result.get("site") or "",
        "fetched_at": _iso(result.get("fetched_at")),
        "items": [
            {
                "title": item["title"],
                "href": item["href"],
                "published_at": _iso(item["published_at"]),
                "published_text": when_text(item["published_at"]) if item["published_at"] else "",
            }
            for item in items
        ],
    }


def _status_text() -> str:
    """One-line status for the tool entry. **Cache only, never online** (/api/tools is polled often)."""
    config = rss.load_config()
    total = len(config["feeds"])
    if not total:
        return tr("rss.status_empty")
    bad = 0
    for feed in config["feeds"]:
        cached = rss.peek(feed["id"])
        if cached and not cached.get("ok"):
            bad += 1
    if bad:
        return tr("rss.status_some_bad", total=total, bad=bad)
    return tr("rss.status_count", total=total)


# ------------------------------------------------ wall cell rss.<feed> (first-class producer)


def fetch_rss(specs: list[dict]) -> dict:
    """One cell per feed: title = newest item in the feed, detail = the latest few (with links).

    The three-state handling is not invented here: on failure return ``err()`` and let the host
    decide (R2: repeated failures escalate to an alert on their own).
    """

    def one(spec: dict) -> dict:
        feed_id = str((spec.get("params") or {}).get("feed_id") or "")
        feed = rss.find_feed(feed_id)
        if feed is None:
            return err(
                tr("rss.cell_feed_gone", feed_id=feed_id),
                tr("rss.cell_feed_gone_hint"),
            )
        result = rss.cached(feed)
        if not result.get("ok"):
            error = result.get("error") or {}
            return err(error.get("message") or tr("rss.unreadable"),
                       error.get("hint") or tr("rss.retry_later"))
        items = result.get("items") or []
        limit = int((spec.get("params") or {}).get("limit") or rss.DEFAULT_ITEMS)
        detail = []
        for item in items[:limit]:
            when = when_text(item["published_at"]) if item.get("published_at") else ""
            text = f"{when} · {clip(item['title'], 46)}" if when else clip(item["title"], 52)
            detail.append({"text": text, "href": item.get("href") or None})
        summary = (tr("rss.cell_summary", count=len(items), title=clip(items[0]["title"], 36))
                   if items else tr("rss.cell_no_items"))
        return ok(summary, detail=detail[:DETAIL_LIMIT], updated_at=result.get("fetched_at"))

    if not specs:
        return {}
    with ThreadPoolExecutor(max_workers=min(4, max(1, len(specs)))) as pool:
        results = list(pool.map(one, specs))
    return {spec["id"]: outcome for spec, outcome in zip(specs, results)}


def _rss_tiles() -> list[dict]:
    """**Dynamic producer declaration**: one cell per feed (follows ``rss.json``; a new feed adds
    a cell automatically).

    ``presentation.tiles`` as a callable means it is recomputed on every discovery (a built-in
    plugin privilege). This **only reads config and the cache**, never goes online -- it runs on
    every cell fetch.
    """
    config = rss.load_config()
    refresh = int(config.get("refresh") or rss.DEFAULT_REFRESH)
    tiles: list[dict] = []
    for index, feed in enumerate(config["feeds"]):
        cached = rss.peek(feed["id"]) or {}
        tiles.append({
            "id": f"rss.{feed['id']}",
            "zone": "status",
            "order": 100 + index,
            "title": feed["title"][:TITLE_LIMIT],
            "source": f"rss:{rss.safe_url(feed['url'])}",
            "stale_after": max(1800, refresh * 2),
            "refresh": refresh,
            # Deep link prefers the site home page (only known after one fetch), else the feed itself
            "href": cached.get("site") or rss.safe_url(feed["url"]),
            "group": "rss",
            "critical": False,
            "enabled": bool(feed["enabled"]),
            "params": {"feed_id": feed["id"], "limit": feed["limit"]},
            "fetch": fetch_rss,
        })
    return tiles


# ----------------------------------------------------------------- CLI face


def _human(feeds: list[dict[str, Any]], *, total: int) -> None:
    print(tr("rss.cli_list_header", total=total, path=rss.config_file()))
    for feed in feeds:
        mark = "·" if feed["enabled"] else "×"
        if feed["error"]:
            tail = tr("rss.cli_unreadable", message=feed["error"].get("message", ""))
        else:
            tail = tr("rss.cli_items_line", count=feed["items"],
                      when=feed["fetched_at"] or tr("rss.cli_never_fetched"))
        print(f"  {mark} {feed['id']:<24} {feed['title']:<20} {tail}")


def _cli_list(json_out: bool = False):
    if json_out:
        return _route_index("true")
    payload = _route_index("true")
    _human(payload["feeds"], total=payload["total"])
    return 0


def _cli_add(url: str = None, id: str = None, title: str = None, limit: int = None,
             json_out: bool = False):
    payload: dict[str, Any] = {"url": url or ""}
    if id:
        payload["id"] = id
    if title:
        payload["title"] = title
    if limit is not None:
        payload["limit"] = limit
    result = _route_save(payload)
    if json_out:
        return result
    feed = result["feed"]
    if feed["error"]:
        print(tr("rss.cli_saved_unreadable", title=feed["title"], id=feed["id"],
                 message=feed["error"].get("message")))
        print(f"  {feed['error'].get('hint') or tr('rss.cli_fix_url')}")
        return 1
    print(tr("rss.cli_saved", title=feed["title"], id=feed["id"], count=feed["items"]))
    return 0


def _cli_remove(feed_id: str = None, json_out: bool = False):
    result = _route_remove(feed_id or "")
    if json_out:
        return result
    print(tr("rss.cli_removed", feed_id=feed_id))
    return 0


def _cli_refresh(feed_id: str = None, json_out: bool = False):
    result = _route_refresh(feed_id or "")
    if json_out:
        return result
    feed = result["feed"]
    if feed["error"]:
        print(tr("rss.cli_unreadable_short", title=feed["title"],
                 message=feed["error"].get("message")))
        return 1
    print(tr("rss.cli_refreshed", title=feed["title"], count=feed["items"]))
    return 0


def _cli_items(feed_id: str = None, limit: int = None, json_out: bool = False):
    result = _route_items(feed_id, None if limit is None else str(limit))
    if json_out:
        return result
    print(tr("rss.cli_items_header", title=result["title"], count=len(result["items"]),
             site=result["site"] or result["feed"]))
    for item in result["items"]:
        when = item["published_text"] or ""
        print(f"  {when:<12} {item['title']}")
        if item["href"]:
            print(f"               {item['href']}")
    return 0


TOOL_META = {
    "id": "rss",
    "name": "RSS 订阅",
    "icon": "rss",
    "description": "多个 RSS/Atom 源，一个源一格；地址在面板或 rss.json 里改",
    "keywords": "rss atom feed 订阅 信息源 聚合 ding yue xin xi yuan",
    # Phase F3: one cell per subscription (dynamic producer, follows rss.json)
    "presentation": {"tiles": _rss_tiles},
    "ready": lambda: True,
    "status": _status_text,
    "faces": {
        "routes": [
            {
                "method": "GET",
                "path": "/api/rss",
                "endpoint": _route_index,
                "params": [
                    {"name": "live", "type": "str", "default": "true",
                     "help": "true（默认）会联网抓一次；false 只读缓存"},
                ],
            },
            {
                "method": "POST",
                "path": "/api/rss/feeds",
                "endpoint": _route_save,
                "params": [
                    {"name": "payload", "in": "body", "fields": [
                        {"name": "url", "type": "str", "help": "订阅地址（http/https）"},
                        {"name": "id", "type": "str", "default": "",
                         "help": "订阅 id（= 格子 id 的后半段）；不填按主机名起一个，填已有的就是改它"},
                        {"name": "title", "type": "str", "default": "", "help": "显示名，不填用主机名"},
                        {"name": "limit", "type": "int", "nullable": True, "default": None,
                         "ge": 1, "le": 20, "help": "这个源最多取几条（1~20）；不填沿用原值"},
                        {"name": "enabled", "type": "bool", "nullable": True, "default": None,
                         "help": "上不上墙；不填沿用原值"},
                    ]},
                ],
            },
            # feed_id is a path parameter: extracted from the path template, no declaration needed
            {"method": "DELETE", "path": "/api/rss/feeds/{feed_id}", "endpoint": _route_remove, "params": []},
            {"method": "POST", "path": "/api/rss/feeds/{feed_id}/refresh", "endpoint": _route_refresh, "params": []},
            {
                "method": "GET",
                "path": "/api/rss/items",
                "endpoint": _route_items,
                "params": [
                    {"name": "feed_id", "type": "str", "help": "订阅 id，见 GET /api/rss"},
                    {"name": "limit", "type": "str", "default": None, "help": "最多几条（1~20）"},
                ],
            },
        ],
        "mcp": [
            {
                "name": "rss_list",
                "description": "列出所有 RSS/Atom 订阅及其状态（条目数、最近抓取、读不到的原因）",
                "params": [],
                "handler": lambda: _route_index("true"),
            },
            {
                "name": "rss_add",
                "description": "添加或修改一条 RSS/Atom 订阅（同一个 id 再调一次 = 改它的地址/名称/开关）",
                "params": [
                    {"name": "url", "type": "str", "help": "订阅地址（http/https）"},
                    {"name": "id", "type": "str", "default": "",
                     "help": "订阅 id（不填按主机名自动起；填已有的就是改它）"},
                    {"name": "title", "type": "str", "default": "", "help": "显示名"},
                    {"name": "limit", "type": "int", "default": 5, "help": "最多取几条（1~20）"},
                ],
                "handler": lambda url, id="", title="", limit=5: _route_save(
                    {"url": url, "id": id, "title": title, "limit": limit}),
            },
            {
                "name": "rss_remove",
                "description": "删除一条 RSS 订阅（它的信息墙格子随之消失）",
                "params": [{"name": "feed_id", "type": "str", "help": "订阅 id，见 rss_list"}],
                "handler": lambda feed_id: _route_remove(feed_id),
            },
            {
                "name": "rss_items",
                "description": "读某个订阅的最新条目（标题、链接、发布时间）",
                "params": [
                    {"name": "feed_id", "type": "str", "help": "订阅 id，见 rss_list"},
                    {"name": "limit", "type": "int", "default": 5, "help": "最多几条（1~20）"},
                ],
                "handler": lambda feed_id, limit=5: _route_items(feed_id, str(limit)),
            },
        ],
        "cli": {
            "command": "rss",
            "help": "RSS/Atom subscriptions (one dashboard tile per feed)",
            "subcommands": [
                {"name": "list", "help": "List feeds and their current state", "params": [],
                 "handler": _cli_list},
                {"name": "add", "help": "Add a feed, or update it when --id already exists",
                 "params": [
                     {"name": "url", "type": "str", "positional": True, "help": "Feed URL"},
                     {"name": "id", "type": "str", "default": "", "short": "i",
                      "help": "Feed id (default: derived from the host; an existing id updates it)"},
                     {"name": "title", "type": "str", "default": "", "short": "t",
                      "help": "Display name"},
                     {"name": "limit", "type": "int", "default": None, "short": "n",
                      "help": "Max items per feed (1~20)"},
                 ],
                 "handler": _cli_add},
                {"name": "remove", "help": "Remove a feed",
                 "params": [{"name": "feed_id", "type": "str", "positional": True, "help": "Feed id"}],
                 "handler": _cli_remove},
                {"name": "refresh", "help": "Re-fetch one feed now (bypasses the cache)",
                 "params": [{"name": "feed_id", "type": "str", "positional": True, "help": "Feed id"}],
                 "handler": _cli_refresh},
                {"name": "items", "help": "Show the latest items of a feed",
                 "params": [
                     {"name": "feed_id", "type": "str", "positional": True, "help": "Feed id"},
                     {"name": "limit", "type": "int", "default": None, "short": "n",
                      "help": "How many items (1~20)"},
                 ],
                 "handler": _cli_items},
            ],
        },
    },
}
