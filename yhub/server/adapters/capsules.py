"""Hosts "capsules in your library": one directory of single-file HTML served verbatim on loopback.

Capability-style module: it declares only `ROUTES` and takes no launcher tool entry.

In one line: `settings.json: capsules_dir` points at a directory in your library and **every
`.html` / `.htm` file inside is a capsule** — drop one in and it appears, delete it and it is gone.
No id, no allowlist, no manifest gating what counts.

**Import is an optional front door, not a gate** (2026-11): `POST /api/capsules/import` copies one
file into the same library (zero configuration — it creates the directory and stores `capsules_dir`)
and `capsules.json` in the config root carries a *declared* name / icon / description / order per
capsule. The file stays the truth: the overlay only decorates what the scan found, a capsule whose
file is gone simply stops being listed, and dropping a file in by hand keeps working exactly as
before (see `_capsules_import`).

Contract

  * `GET     /api/capsules`           list scanned capsules as JSON; each item carries an openable
    `url`, the user-facing tri-state `configured` / `problem`, `recommended_dir` (UI guidance) and
    the bookmark-style trio `title` / `icon` / `description` scraped from the file head like a
    browser bookmark — empty string when the file does not define them (see "Bookmark metadata").
    A declared overlay wins over the scraped value; the raw declared fields are echoed in `meta`
    and `stale_metadata` counts overlay entries whose file disappeared
  * `POST    /api/capsules/import`    copy one `.html`/`.htm` into the user library (`{"path"}` from
    the desktop picker, `{"filename", "content"}` from a plain browser, optional `{"meta"}`);
    creates the library on first use, never requires configuration
  * `POST    /api/capsules/meta`      declare name / icon / description / order for one capsule
    (stored in `capsules.json`, keyed by relpath); `null` clears a field, `{"reset": true}` the entry
  * `POST    /api/capsules/delete`    remove one **user-layer** capsule (`{"relpath", "remove_data"?}`);
    a bundled capsule is refused with a hint to disable it instead
  * `GET     /capsules/<path>`        serve the entry html verbatim (`text/html; charset=utf-8`,
    `no-store` + `ETag`); when no entry resolves, read **sandbox** data files from the capsule's own
    folder (Content-Type guessed from the suffix, no CSP — that is not a page)
  * `HEAD    /capsules/<path>`        same headers as GET, no body (to fetch `ETag`)
  * `OPTIONS /capsules/<path>`        200 + `DAV: 1` (tells single-file capsules this server takes
    PUT; sandbox paths are answered too, even before the file exists)
  * `PUT     /capsules/<path>`        entry html: full overwrite of the file that was served (**never
    creates** a new capsule); a **built-in** (system layer) entry is materialized into the writable
    user library under the same relative path on its first save (copy-on-write: the software owns
    the shipped file and upgrades replace it, the user's edits shadow it from then on); sandbox
    path: create/store a data file (**may create**, parents auto-created); 204 + new `ETag`
  * `DELETE  /capsules/<path>`        delete one sandbox data file (204); the entry html is always 405
  * `POST    /api/capsules/ensure`    prepare a writable capsule library: mkdir -p + write `capsules_dir`
  * `If-Match` mismatch → 412 (someone else just saved; never overwrite silently) · over 32 MiB →
    413 · cross-origin → 403 · missing → 404 · sandbox creation also hits a per-folder file cap
    (`MAX_SANDBOX_FILES`) → 413

**Capsule sandbox** (one folder per small capsule): the sandbox root is the folder holding the entry
html; a top-level loose file has no sandbox (its directory is the capsules root). Paths such as
`chat/data/index.json` that resolve to no entry html land inside `capsules/chat/` — that is the data
layer for multi-file capsules (e.g. a chat app's `data/chat/*.json`): read/write/delete all work, parents
are created, and data travels with the library's git. Rules in `_sandbox`.

**Why pages live at `/capsules/*` and not `/api/capsules/*`**: these URLs are **pages for humans and
browsers**, not JSON APIs for programs. `/api/*` stays machine-only (including the JSON list above);
pages get their own namespace, so "this is a capsule" vs "this is an API" is obvious at a glance.
One side effect: the middleware in `yhub/server/main.py` only adds `no-store` to `/api/`, so these
pages **send `no-store` themselves** (as they should — cache policy is part of this contract, not a
global path rule).

**Path resolution** (first existing candidate wins; mirrored in docs/config.md):

  | requested             | tried                                                                     |
  | --------------------- | ------------------------------------------------------------------------- |
  | `/capsules/pinyin`    | `pinyin.html` → `pinyin.htm` → `pinyin/index.html` → `pinyin/pinyin.html`  |
  | `/capsules/pinyin/`   | `pinyin/index.html` (trailing slash = the directory index is wanted)       |
  | `/capsules/a/b.html`  | verbatim (an explicit path always works)                                  |

So both "one directory per capsule" and "one file per capsule" open through a short URL. The `url`
in the listing is the **shortest** form, re-validated through the resolver before being emitted
(falling back to the explicit path); when two paths collide on one short URL, the one that resolves
back to itself keeps it (traversal order in `_url_path`) and the rest fall back.

**Why HEAD / OPTIONS / ETag exist** (reverse-engineered from TiddlyWiki, not WebDAV pedantry):
`$:/core/modules/savers/put.js` probes with `OPTIONS` on instantiation and only treats the server as
PUT-capable when it answers 2xx **and** carries a `DAV` header; otherwise `save()` returns false and
the user only ever gets a downloaded copy. It then `HEAD`s for an `ETag`, sends `If-Match` on save,
and reads the new `ETag` from the response (HEADing again when absent). Hence: no `DAV` = cannot
save; no `ETag` = one extra HEAD per save; no 412 = two side-by-side editors silently clobber each
other. FastAPI's `app.get` does not auto-answer HEAD, so HEAD is registered separately.

**CSP**: `page_csp` emits its own policy (the middleware uses `setdefault`, so it overrides the main
app's). The main app CSP lacks `'unsafe-eval'` while single-file capsules commonly bootstrap their
kernel via `eval` — the typical symptom is a TiddlyWiki page that opens but half-dies
(`Internal JavaScript Error: … 'unsafe-eval' is not an allowed source`). Hosted pages are **files you
put in your own library**, on loopback only, equivalent to opening a local HTML file in your browser
(`file://` has no CSP at all), so the policy is relaxed to that standard.

**Boundaries** (all asserted in `packaging/verify-backend.sh`)

  * only `.html` / `.htm`; any dot-prefixed segment of an **entry path** is rejected — that blocks
    `.git/config`, `.env` and friends living in the library, i.e. "**only what the list shows is
    fetchable**". Sandbox data files are the exception: dot-dirs after the first segment belong to
    the capsule itself (`.appdata`), a dot-prefixed first segment is still rejected
  * `..` is always rejected; a symlink pointing outside the root is neither a capsule nor writable
    (the real path must stay inside)
  * `MAX_APPS` entries per directory; `MAX_BYTES` per file
  * writes are atomic (temp file + `os.replace`) and preserve the original permission bits
  * the loopback server has **no auth**, so writes are gated by an Origin allowlist (local pages /
    the desktop shell's native origin); hence `capsules_dir` should only point inside your library
  * renaming changes the URL and old references 404 — the price of zero registration

Users: `web/src/components/settings/CapsulesSection.tsx` (the "capsules in your library" section lists
them, offers "open in browser", imports/edits/deletes through the `/api/capsules/*` endpoints above;
the desktop shell goes through the `open_capsule` command for the browser preview).
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import html as html_lib
import json
import mimetypes
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlsplit

from fastapi import Request, Response
from fastapi.responses import RedirectResponse

from yhub._data import bundled_capsules_dir
from yhub.i18n import tr

from . import ToolError
from .settings import read_settings, set_values

# Suffixes accepted inside a capsule root.
_APP_SUFFIXES = (".html", ".htm")
# Listing cap per root, so pointing capsules_dir at the home directory by accident cannot list 100k files.
MAX_APPS = 200
# Per-file cap: PUT rewrites the whole file, so larger content needs a different storage route.
MAX_BYTES = 32 * 1024 * 1024

# Origin allowlist for PUT: any local port + the Tauri shell's native origin.
_ORIGIN_LOCAL = re.compile(r"^https?://([a-z0-9-]+\.)?(127\.0\.0\.1|localhost)(:\d+)?$")
_TAURI_ORIGINS = {"tauri://localhost", "http://tauri.localhost"}

# CSP of a hosted page (overrides the main app's in yhub/server/main.py; middleware uses setdefault).
# Differences from the main policy: 'unsafe-eval' / blob: (single-file apps bootstrap via eval and
# use Workers), https: in connect-src (apps legitimately call external APIs), and https: in
# script-src as well so CDN scripts load (e.g. `marked` from jsdelivr). A missing https: there
# fails in a very quiet way: the script is blocked → global undefined → the page looks fine while
# sending throws silently at the render step. style/img/font/media/connect already allowed https:;
# script-src is aligned with them. Run web/smoke.mjs before changing this.
def _scope_prefixes(scope: str | None) -> list[str]:
    """A capsule's own folder in URL space (used by the CSP).

    Directory capsules allow `/capsules/<dir>/` plus their short form `/capsules/<dir>`;
    single-file capsules allow only themselves (`/capsules/x.html` and short `/capsules/x`).
    """
    if not scope:
        return ["/capsules/"]
    base = f"/capsules/{quote(scope, safe='/')}"
    if scope.lower().endswith(_APP_SUFFIXES):
        return [base, base.rsplit(".", 1)[0]]
    return [base.rstrip("/"), base.rstrip("/") + "/"]


def page_csp(request: Request, scope: str | None) -> str:
    """Build the CSP for a capsule's folder scope: **only its own folder**, never the whole `'self'`.

    - `connect-src` / `script-src` / `img-src` / `frame-src` are pinned to this capsule's URL prefixes;
    - `https:` stays allowed (CDN scripts and external AI endpoints are the capsule's own business);
    - `form-action 'none'` blocks forms aimed straight at the host `/api`;
    - `'self'` is never emitted: other capsules on the same origin and `/api/*` stay out of the set.

    The browser side is layer one; the server also validates the Referer (see `_scope_denied`).
    Both layers have to fail before isolation is actually broken.
    """
    scheme, port = _request_scheme_port(request)
    host = _host_of(request)
    if subdomains_enabled(scope) and _is_capsule_host(host):
        hosts = [host]  # subdomain mode: trust only this capsule's own origin
    else:
        hosts = ["127.0.0.1", "localhost"]
        if host and host not in hosts:
            hosts.append(host)
    own = " ".join(
        f"{scheme}://{h}:{port}{prefix}"
        for h in hosts
        for prefix in _scope_prefixes(scope)
    )
    return (
        "default-src 'none'; "
        f"script-src {own} 'unsafe-inline' 'unsafe-eval' blob: data: https:; "
        f"style-src {own} 'unsafe-inline' blob: data: https:; "
        f"img-src {own} data: blob: https:; "
        f"font-src {own} data: https:; "
        f"media-src {own} data: blob: https:; "
        f"connect-src {own} https:; "
        f"frame-src {own} data: blob:; "
        f"worker-src {own} blob: data:; "
        "object-src 'none'; form-action 'none'; base-uri 'none'"
    )


# Conservative default for callers that do not have a request or capsule scope.
APP_CSP = (
    "default-src 'none'; "
    "script-src 'unsafe-inline' 'unsafe-eval' blob: data: https:; "
    "style-src 'unsafe-inline' blob: data: https:; "
    "img-src data: blob: https:; "
    "font-src data: https:; "
    "media-src data: blob: https:; "
    "connect-src https:; "
    "frame-src data: blob:; "
    "worker-src blob: data:; "
    "object-src 'none'; form-action 'none'; base-uri 'none'"
)


# -------------------------------------------------- Bookmark-style metadata (icon + name)
#
# Scrape the display name and icon from the file head like a browser bookmark, so the list shows the
# real name and icon:
#   name  <title> → og:title → application-name → empty (the UI falls back to the filename; the
#         backend does not guess)
#   icon  the largest declared size among <link rel*icon*>:
#         `data:image/` and `https://` are returned as-is (the main app CSP only allows
#         self/data:/ https:); relative or root paths (e.g. /favicon.ico) get **inlined as `data:`** —
#         /capsules/ only serves .html, so icons get no route of their own: zero new routes, no
#         change to the security boundary.
#   desc  <meta name=description> → og:description (search text only, not the subtitle — the
#         subtitle is a library path, which is an existing contract).
# Only the first 64 KiB are read (these tags all live in <head>) and results are cached by
# (mtime, size), so rescanning a directory does not re-parse everything.
_HEAD_BYTES = 64 * 1024
# Inlined-icon file cap / final data: URI cap (base64 costs 4/3): favicons are KB-sized, this is roomy
_MAX_ICON_FILE = 64 * 1024
_MAX_DATA_ICON = 96 * 1024
_ICON_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml", ".ico": "image/x-icon", ".gif": "image/gif",
    ".webp": "image/webp", ".avif": "image/avif",
}
_ATTR_RE = re.compile(r"([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(\"([^\"]*)\"|'([^']*)'|([^\s>]+))")
_META_CACHE: dict[str, tuple[int, int, dict[str, str]]] = {}


def _read_head(path: Path) -> str:
    """Read the file head (title/icon live in <head>). Non-UTF-8 pages fall back to gb18030 by
    replacement-char ratio."""
    with path.open("rb") as fh:
        raw = fh.read(_HEAD_BYTES)
    text = raw.decode("utf-8", errors="ignore")
    if text.count("�") > max(4, len(text) // 200):
        text = raw.decode("gb18030", errors="ignore")
    return text


def _attrs(tag: str) -> dict[str, str]:
    """Lowercase the tag's attribute names (order-independent: `content` before `name` also counts)"""
    out: dict[str, str] = {}
    for m in _ATTR_RE.finditer(tag):
        out[m.group(1).lower()] = m.group(3) or m.group(4) or m.group(5) or ""
    return out


def _clean_text(value: str, cap: int) -> str:
    """Strip inline tags → unescape entities → collapse whitespace → truncate (names may span lines)"""
    value = re.sub(r"<[^>]*>", "", value)
    value = html_lib.unescape(value)
    return re.sub(r"\s+", " ", value).strip()[:cap]


def _icon_rank(sizes: str) -> int:
    """`sizes` attribute → pick weight (bigger is better; svg / any = infinitely scalable, the largest)"""
    sizes = (sizes or "").strip().lower()
    if sizes in ("any", "svg"):
        return 10**9
    m = re.match(r"(\d+)", sizes)
    return int(m.group(1)) if m else 0


def _resolve_icon(href: str, html_path: Path, root: Path) -> str:
    """Icon href → a value usable directly in `<img src>` (`data:` / `https:`); empty when not allowed."""
    href = (href or "").strip()
    if href.startswith("data:image/"):
        return href if len(href) <= _MAX_DATA_ICON else ""
    if href.startswith("https://"):
        return href
    if not href or href.startswith(("http://", "//", "javascript:", "blob:", "file:")):
        return ""  # CSP forbids http:; protocol-relative and script-ish URLs are refused (better missing than wrong)
    # Relative (favicon.svg) or root (/favicon.ico) path → read the file and inline it as data:
    clean = href.split("#", 1)[0].split("?", 1)[0]
    if not clean:
        return ""
    target = root / clean.lstrip("/") if clean.startswith("/") else html_path.parent / clean
    try:
        target = target.resolve()
        if not _inside(root, target) or not target.is_file():
            return ""
        mime = _ICON_MIME.get(target.suffix.lower())
        if not mime or target.stat().st_size > _MAX_ICON_FILE:
            return ""
        uri = f"data:{mime};base64,{base64.b64encode(target.read_bytes()).decode('ascii')}"
    except OSError:
        return ""
    return uri if len(uri) <= _MAX_DATA_ICON else ""


def _extract_meta(path: Path, root: Path, mtime_ns: int, size: int) -> dict[str, str]:
    """Bookmark trio {title, icon, description}; cached by (mtime, size), invalidated when the file changes."""
    key = str(path)
    cached = _META_CACHE.get(key)
    if cached is not None and cached[0] == mtime_ns and cached[1] == size:
        return cached[2]
    if len(_META_CACHE) > 1024:
        _META_CACHE.clear()  # wholesale directory swap: just start over, no LRU bookkeeping
    meta = {"title": "", "icon": "", "description": ""}
    try:
        head = _read_head(path)
    except OSError:
        return meta

    og_title = app_name = og_desc = ""
    tm = re.search(r"<title[^>]*>(.*?)</title>", head, re.I | re.S)
    if tm:
        meta["title"] = _clean_text(tm.group(1), 80)
    for m in re.finditer(r"<meta\b[^>]*>", head, re.I):
        at = _attrs(m.group(0))
        ident = (at.get("name") or at.get("property") or "").strip().lower()
        content = at.get("content", "")
        if ident in ("description", "og:description") and not meta["description"]:
            if ident == "description":
                meta["description"] = _clean_text(content, 300)
            else:
                og_desc = _clean_text(content, 300)
        elif ident == "og:title" and not og_title:
            og_title = _clean_text(content, 80)
        elif ident == "application-name" and not app_name:
            app_name = _clean_text(content, 80)
    if not meta["title"]:
        meta["title"] = og_title or app_name
    if not meta["description"]:
        meta["description"] = og_desc

    # Icon: among <link> tags whose rel mentions icon, take the largest sizes (ties → the first one, like browsers)
    candidates: list[tuple[int, str]] = []
    for m in re.finditer(r"<link\b[^>]*>", head, re.I):
        at = _attrs(m.group(0))
        if "icon" not in (at.get("rel") or "").lower():
            continue
        if at.get("href"):
            candidates.append((_icon_rank(at.get("sizes", "")), at["href"]))
    if candidates:
        meta["icon"] = _resolve_icon(max(candidates, key=lambda c: c[0])[1], path, root)

    _META_CACHE[key] = (mtime_ns, size, meta)
    return meta


#: Name of the default user library inside the config root (`<config root>/capsules`).
#: Why inside the config root: it is a directory the app owns, it follows `YHUB_CONFIG_DIR` (tests,
#: power users) and it moves together with the rest of the data root, so nothing about it has to be
#: configured or migrated by hand. A user who wants the library elsewhere sets `capsules_dir`.
DEFAULT_LIBRARY_NAME = "capsules"


def default_capsules_dir() -> Path:
    """Where the user library lives unless `capsules_dir` overrides it (created on first import/save)."""
    from .settings import config_dir  # lazy: avoid a cycle during package init

    return config_dir() / DEFAULT_LIBRARY_NAME


def capsules_enabled() -> bool:
    """`settings.json: capsules_enabled` — the explicit on/off switch for the user layer (default on)."""
    settings, _warnings = read_settings()
    return bool(settings.get("capsules_enabled", True))


def configured_capsules_dir() -> tuple[str, Path]:
    """`(raw value, effective path)`: a raw `""` means "the default location", not "off"."""
    settings, _warnings = read_settings()
    raw = str(settings.get("capsules_dir") or "").strip()
    return raw, (Path(raw).expanduser() if raw else default_capsules_dir())


def capsules_dir() -> Path | None:
    """The "capsules in your library" directory, `~/` expanded. None when the layer is off or absent.

    Reads through the **single** config entry point (`yhub/server/adapters/settings.py`), so shell, web
    and CLI edits take effect immediately without a restart. An empty `capsules_dir` means the default
    location; a missing directory lists nothing (and `dir_state()` says why).
    """
    if not capsules_enabled():
        return None
    _raw, base = configured_capsules_dir()
    return base if base.is_dir() else None


def dir_state() -> dict[str, Any]:
    """User-facing guide state: `disabled` / `ok` / `missing` / `not_dir` / `unwritable` (+ extras).

    Why a separate function: `capsules_dir()` folds "off", "missing" and "not a directory" into None,
    so the UI could not tell "you turned it off" from "the path is wrong" — and those two need
    completely different guidance. The default location not existing yet is **not** a problem: it is
    created on the first import or save, so a fresh install is already in the "ok" state.
    """
    raw, base = configured_capsules_dir()
    using_default = not raw
    exists = base.is_dir()
    common = {"path": str(base), "using_default": using_default, "exists": exists}
    if not capsules_enabled():
        return {**common, "configured": False, "problem": "disabled",
                "detail": tr("capsules.dir_detail_disabled")}
    if not base.exists():
        if using_default:
            return {**common, "configured": True, "problem": None, "detail": ""}
        return {**common, "configured": False, "problem": "missing",
                "detail": tr("capsules.dir_detail_missing")}
    if not exists:
        return {**common, "configured": False, "problem": "not_dir",
                "detail": tr("capsules.dir_detail_not_dir")}
    if not os.access(base, os.W_OK):
        # Directory exists but is not writable: still list its content, only saving will fail
        return {**common, "configured": True, "problem": "unwritable",
                "detail": tr("capsules.dir_detail_unwritable")}
    return {**common, "configured": True, "problem": None, "detail": ""}


def _display_path(base: Path) -> str:
    """Prefer writing `~/…` into the config (it follows the user's home; no edits needed on a new machine)."""
    try:
        rel = base.resolve().relative_to(Path.home().resolve())
        return "~/" + rel.as_posix()
    except (ValueError, OSError):
        return str(base)


async def ensure_capsules_dir(request: Request) -> dict[str, Any]:
    """Prepare a writable capsule library: mkdir -p (+ turn the layer on), returning the effective value.

    With no `path` this prepares the **default location** and clears any override (`capsules_dir: ""`)
    instead of pinning today's absolute path — the library then follows the data root. With a `path`
    it becomes the explicit override. Filesystem work stays host-side (the UI never touches fs) and the
    config write reuses `settings.set_values` (the single entry point).
    """
    payload: dict[str, Any] = {}
    try:
        body = await request.body()
        if body:
            parsed = json.loads(body)
            if isinstance(parsed, dict):
                payload = parsed
    except (ValueError, UnicodeDecodeError):
        payload = {}

    wanted = str(payload.get("path") or "").strip()
    base = Path(wanted).expanduser() if wanted else default_capsules_dir()
    if not (wanted.startswith("/") or wanted.startswith("~/")):
        raise ToolError(
            tr("capsules.dir_absolute_required", path=repr(wanted)),
            hint=tr("capsules.dir_absolute_required_hint"),
        )

    created = False
    if base.exists() and not base.is_dir():
        raise ToolError(
            tr("capsules.dir_exists_not_dir", path=base),
            hint=tr("capsules.dir_exists_not_dir_hint"),
        )
    if not base.exists():
        try:
            base.mkdir(parents=True, exist_ok=True)
            created = True
        except OSError as exc:
            raise ToolError(
                tr("capsules.dir_create_failed", error=exc),
                hint=tr("capsules.dir_create_failed_hint"),
            ) from exc
    if not os.access(base, os.W_OK):
        raise ToolError(
            tr("capsules.dir_not_writable", path=base),
            hint=tr("capsules.dir_not_writable_hint"),
        )

    try:
        using_default = base.resolve() == default_capsules_dir().resolve()
    except OSError:
        using_default = False
    stored = "" if using_default else _display_path(base)
    set_values({"capsules_dir": stored, "capsules_enabled": True})
    return {"ok": True, "capsules_dir": str(base), "stored": stored, "created": created,
            "recommended": using_default, "using_default": using_default}


def system_capsules_dir() -> Path | None:
    """The read-only layer shipped with the software (`capsule-src/` build output → `capsules/`).

    Priority:
      1. env `YHUB_SYSTEM_CAPSULES_DIR` (tests: point it at a missing path to switch this layer off)
      2. the bundled `capsules/` (repo root in a source tree, `yhub/_data/capsules` in a wheel)

    It never reads the config file — this is the example layer installed with the software and
    updated with it; the user layer always wins.
    """
    env = os.environ.get("YHUB_SYSTEM_CAPSULES_DIR", "").strip()
    if env:
        base = Path(env).expanduser()
        return base if base.is_dir() else None
    # source tree = <repo>/capsules; wheel = yhub/_data/capsules (see yhub/_data.py)
    return bundled_capsules_dir()


def capsule_roots() -> list[tuple[str, Path, bool]]:
    """All capsule roots at runtime, **user layer first**.

    Returns `(layer name, real root, writable)`; missing roots are omitted and duplicate paths collapsed.
    """
    out: list[tuple[str, Path, bool]] = []
    seen: set[str] = set()
    user = capsules_dir()
    if user is not None:
        root = user.resolve()
        out.append(("user", root, True))
        seen.add(str(root))
    system = system_capsules_dir()
    if system is not None:
        root = system.resolve()
        if str(root) not in seen:
            out.append(("system", root, False))
            seen.add(str(root))
    return out


# --------------------------------------------------- Per-capsule origin (optional)
#
# On one origin (127.0.0.1) CSP/Referer checks stop cross-capsule requests but not same-origin
# storage or window.open DOM reads. With `capsules_subdomains` enabled each capsule gets its own
# `<slug>.localhost` origin: the browser isolates localStorage / IndexedDB / window handles per
# origin, and the server additionally validates the Host header. Off by default, keeping today's
# 127.0.0.1 addresses unchanged.
_MAIN_HOSTS = {"127.0.0.1", "localhost", "::1"}


def subdomains_enabled(scope: str | None = None) -> bool:
    """Effective value = per-capsule override ?? global default. With no scope, only the global default."""
    try:
        from .settings import read_settings

        settings, _warnings = read_settings()
        if scope:
            overrides = settings.get("capsules_subdomains_overrides") or {}
            if isinstance(overrides, dict) and scope in overrides:
                return bool(overrides[scope])
        return bool(settings.get("capsules_subdomains"))
    except Exception:  # noqa: BLE001 — an unreadable config must not 500 a capsule page
        return False


def capsule_slug(scope: str) -> str:
    """Turn a capsule identity into a stable DNS label (lowercase letters/digits/hyphens + a path hash)."""
    ascii_part = re.sub(r"[^a-z0-9]+", "-", scope.lower()).strip("-")[:32] or "capsule"
    digest = hashlib.sha1(scope.encode("utf-8")).hexdigest()[:8]
    return f"{ascii_part}-{digest}"


def capsule_host(scope: str) -> str:
    return f"{capsule_slug(scope)}.localhost"


def _host_of(request: Request) -> str:
    return (request.url.hostname or "").lower()


def _is_main_host(host: str) -> bool:
    return host in _MAIN_HOSTS


def _is_capsule_host(host: str) -> bool:
    return host.endswith(".localhost") and host != "localhost"


def _request_scheme_port(request: Request) -> tuple[str, int]:
    scheme = request.url.scheme or "http"
    port = request.url.port or (443 if scheme == "https" else 80)
    return scheme, port


def _subdomain_url(request: Request, scope: str, url_path: str) -> str:
    scheme, port = _request_scheme_port(request)
    return f"{scheme}://{capsule_host(scope)}:{port}/capsules/{quote(url_path)}"


def _canonical_url_path(relpath: str) -> str:
    """Rewrite any resolvable path to the shortest canonical URL (directory capsules keep the trailing
    slash so relative data paths don't drift)."""
    file = _resolve(relpath)
    located = _capsule_root_of(file) if file is not None else None
    if located is None:
        return relpath
    root, rel = located
    return _url_path(root, rel)


def _inside(root: Path, candidate: Path) -> bool:
    """Is the real path still inside the hosted root (blocks symlinks pointing outside)?

    Both sides are resolved: comparing a resolved candidate against an unresolved root is a silent
    "no" on macOS, where `/tmp` is a symlink to `/private/tmp` (callers normally pass an already
    resolved root, so this only fixes the latent asymmetry).
    """
    try:
        candidate.resolve().relative_to(root.resolve())
    except (OSError, ValueError):
        return False
    return True


def _resolve_in(root: Path, relpath: str) -> Path | None:
    """Resolve a URL path to a real file **inside the root** (with the completion rules; pure: no config reads).

    Completion rules are the table at the top of the module; any dot-prefixed segment of `relpath`
    (including `.` / `..`) is rejected — i.e. "only what the list shows is fetchable".
    """
    trailing_slash = relpath.endswith("/")
    parts = [p for p in relpath.split("/") if p]
    if not parts:
        return None
    if any(p in (".", "..") or p.startswith(".") for p in parts):
        return None

    last = parts[-1]
    head = parts[:-1]
    if trailing_slash:
        # Trailing slash = explicitly the directory index: index.html first, then a file named after
        # the directory (pinyin/ → pinyin/pinyin.html). Without the second rule a redirect to the
        # short form would 404.
        candidates = [head + [last, "index.html"], head + [last, last + ".html"]]
    elif Path(last).suffix.lower() in _APP_SUFFIXES:
        candidates = [parts]  # fully explicit: verbatim
    else:
        candidates = [
            head + [last + suffix] for suffix in _APP_SUFFIXES
        ] + [
            head + [last, "index.html"],  # directory index
            head + [last, last + ".html"],  # a file named after the directory (app/pinyin/pinyin.html)
        ]

    for candidate in candidates:
        path = root.joinpath(*candidate)
        if path.suffix.lower() not in _APP_SUFFIXES:
            continue
        if not _inside(root, path):
            continue  # symlink pointing outside
        if path.is_file():
            return path
    return None


def disabled_keys() -> set[str]:
    """Disabled capsule identifiers (from `capsules_disabled` in settings.json)."""
    try:
        from .settings import read_settings, read_value

        val = read_value(read_settings()[0], "capsules_disabled")
        if isinstance(val, list):
            return {str(x).strip() for x in val if str(x).strip()}
    except Exception:
        pass
    return set()


def is_capsule_disabled(layer: str, path: Path, root: Path) -> bool:
    """Whether a capsule is disabled. Matches `source:relpath`, `relpath`, the top-level directory, the bare name."""
    dis = disabled_keys()
    if not dis:
        return False
    try:
        rel = path.relative_to(root).as_posix()
    except Exception:
        rel = path.name
    candidates = {
        f"{layer}:{rel}",
        f"{layer}:{path.name}",
        rel,
        path.name,
    }
    if "/" in rel:
        top = rel.split("/")[0]
        candidates.add(f"{layer}:{top}")
        candidates.add(top)
    return any(c in dis for c in candidates)


def _resolve(relpath: str) -> Path | None:
    """Find across layers in priority order (user layer first); disabled capsules are not resolved."""
    for label, root, _writable in capsule_roots():
        found = _resolve_in(root, relpath)
        if found is not None:
            if is_capsule_disabled(label, found, root):
                continue
            return found
    return None


# ---------------------------------------------------- Capsule sandbox (create files in its own folder)
#
# "One folder per small app, so it can create files inside it" — the proper data layer for
# multi-file apps (index.json / chat/*.json / blobs). Rules:
#   * sandbox root = the folder holding the entry html; a top-level loose file has none (its
#     directory is the apps root)
#   * GET/HEAD/OPTIONS/PUT/DELETE all work inside the sandbox: PUT creates parent dirs (a chat app's
#     contract asks for a pre-created data/chat/, and we create it faster than it asks, so it never
#     sees a 409)
#   * the entry html itself is unchanged: PUT only writes back, never creates (TiddlyWiki semantics)
#   * same discipline as entry resolution: any dot-prefixed segment / `..` rejected, real path inside
#     the root, 32 MiB per file, Origin allowlist, plus a **per-sandbox file cap** (so no local page can
#     fill the disk)
MAX_SANDBOX_FILES = 2000
#: Total byte cap per capsule folder (keeps one capsule from filling the disk; the per-file cap is above)
MAX_CAPSULE_BYTES = 512 * 1024 * 1024


def _has_entry(dirpath: Path) -> bool:
    """Does the directory directly contain an app entry (.html/.htm)? Only such directories own a sandbox."""
    try:
        return any(
            p.is_file() and p.suffix.lower() in _APP_SUFFIXES for p in dirpath.iterdir()
        )
    except OSError:
        return False


def _sandbox(root: Path, relpath: str) -> tuple[Path, Path] | None:
    """Sandbox path → (sandbox root, target file); None when it is not a sandbox path.

    Walks the path looking for the **first directory that directly contains an app entry**; the rest is
    a file inside it: `chat/.appdata/index.json` lands in `apps/chat/`, while `data/index.json` (no
    entry in the first segment) is not a sandbox — only apps that own a folder can be written into.

    Dot rule (deliberately different from `_resolve`):
      * a dot-prefixed first segment (the app folder name) → still rejected: top-level dot dirs never
        take part in scanning or resolution;
      * a dot-prefixed segment inside the sandbox (after the first) → **allowed**: hidden dirs like
        `.appdata` belong to the app itself;
      * `.` / `..` anywhere → rejected (escape surface).
    """
    parts = [p for p in relpath.split("/") if p]
    if len(parts) < 2:  # at least one directory segment + one filename
        return None
    if any(p in (".", "..") for p in parts):
        return None  # escape segments are rejected anywhere
    if parts[0].startswith("."):
        return None  # top-level dot prefix always rejected (same rule as scan/resolve)
    for i in range(len(parts) - 1):
        candidate = root.joinpath(*parts[: i + 1])
        if not candidate.is_dir() or not _has_entry(candidate):
            continue
        file = candidate.joinpath(*parts[i + 1 :])
        if not _inside(root, candidate) or not _inside(root, file):
            return None
        return candidate, file
    return None


def _user_capsules_dir_auto() -> Path:
    """The writable user library, created on demand (this is the zero-configuration path).

    Deliberately does **not** write the resulting path into `capsules_dir`: `""` already means "the
    default location", and pinning today's absolute path into the config would freeze it — a later
    relocation of the data root would leave the library behind. Only an explicit override is stored.
    """
    user = capsules_dir()
    if user is not None and user.is_dir():
        return user.resolve()
    if not capsules_enabled():
        raise ToolError(
            tr("capsules.library_disabled"),
            hint=tr("capsules.library_disabled_hint"),
        )
    _raw, base = configured_capsules_dir()
    try:
        base.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ToolError(
            tr("capsules.dir_create_failed", error=exc),
            hint=tr("capsules.dir_create_failed_hint"),
        ) from exc
    return base.resolve()


def _sandbox_resolve(relpath: str, *, write: bool = False) -> tuple[Path, Path] | None:
    """Locate a sandbox path (data files inside a capsule's own folder).

    Reads (`write=False`) prefer data the user has written and fall back to the shipped default;
    **writes always land in the user library** (`write=True`), so a read-only layer is never touched.
    Both layers are always searched: a built-in capsule's *entry* may have been copied into the user
    library by its first save, and then the user folder owns the capsule while data files it never
    wrote still read from the shipped defaults.
    """
    user_root: Path | None = None
    user = capsules_dir()
    if user is not None and user.is_dir():
        user_root = user.resolve()
    sys_root = system_capsules_dir()
    sys_hit = _sandbox(sys_root.resolve(), relpath) if sys_root is not None and sys_root.is_dir() else None

    user_hit = _sandbox(user_root, relpath) if user_root is not None else None
    if user_hit is not None:
        # Writes, or a data file the user already wrote: the user copy is the answer.
        if write or user_hit[1].is_file() or sys_hit is None:
            return user_hit
        # The user folder owns this capsule but this data file was never written: keep reading the
        # shipped default instead of pretending the file vanished.
        if sys_hit[1].is_file():
            return sys_hit
        return user_hit

    if sys_hit is None:
        return None
    # Built-in capsule: data is mapped into the user directory (code stays read-only and upgrades
    # with the software; data persists in the user library).
    user_root = _user_capsules_dir_auto()
    user_cand = user_root / sys_hit[0].name
    user_file = user_root.joinpath(*Path(relpath).parts)
    if write or user_file.is_file():
        return user_cand, user_file
    if sys_hit[1].is_file():
        return sys_hit
    return user_cand, user_file



# --------------------------------------------------- Capsule isolation (own folder only)
#
# Under the same-origin policy a capsule page could fetch any `/capsules/...` and even call the host
# `/api/*` directly. Two layers:
#   1) **Server**: a request coming from a browser must carry a Referer from the same capsule,
#      otherwise 403. The Referer is set by the browser and cannot be changed by the page (the
#      Referrer-Policy header is emitted by the host too); `Sec-Fetch-*` tells browsers apart from
#      curl/scripts, which stay unaffected (local ops and acceptance rely on that).
#   2) **CSP**: `connect-src` / `frame-src` … list only this capsule's URL prefixes (see `page_csp`).
# Identity is the first segment relative to the capsule root, not an absolute path: identically named
# capsules in the system and user layers are the same capsule (the data directory falls back from
# system to user anyway).
_BROWSER_HEADERS = ("sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest")
# Navigation destinations that embed another document **inside** the current page (an iframe can be
# scripted by its parent). Those never pass without a same-capsule Referer; a top-level document
# navigation may, because it replaces the page instead of handing its DOM to someone else.
_FRAME_DESTS = {"iframe", "frame", "embed", "object"}


def _browser_request(request: Request) -> bool:
    """Browser requests always carry Sec-Fetch-* (curl / urllib / test clients do not)."""
    return any(request.headers.get(h) is not None for h in _BROWSER_HEADERS)


def _capsule_root_of(file: Path) -> tuple[Path, str] | None:
    """Which capsule root owns the file → (root, relative path)."""
    for _label, root, _writable in capsule_roots():
        try:
            rel = file.relative_to(root)
        except ValueError:
            continue
        return root, rel.as_posix()
    return None


def _scope_key(relpath: str) -> str | None:
    """URL path → capsule identity (directory capsules = the relative directory; single files = the filename).

    Identities must be computable for data files that do not exist yet (OPTIONS / PUT arrive before
    creation): it goes through `_sandbox_resolve`'s root, so identically named capsules in the system
    and user layers yield the same key.
    """
    file = _resolve(relpath)
    if file is not None:
        located = _capsule_root_of(file)
        if located is None:
            return None
        root, rel = located
        sandbox = _sandbox(root, rel)
        if sandbox is not None:
            return sandbox[0].relative_to(root).as_posix()
        return rel

    hit = _sandbox_resolve(relpath)
    if hit is None:
        return None
    target_root = hit[0]
    for _label, root, _writable in capsule_roots():
        try:
            return target_root.relative_to(root).as_posix()
        except ValueError:
            continue
    return None


def _referer_relpath(request: Request) -> str | None:
    """If the Referer points at `/capsules/...`, return its relative path; otherwise None."""
    raw = request.headers.get("referer", "")
    if not raw:
        return None
    try:
        path = urlsplit(raw).path
    except ValueError:
        return None
    prefix = "/capsules/"
    if not path.startswith(prefix):
        return None
    return unquote(path[len(prefix):])


def _scope_denied(request: Request, relpath: str, scope: str | None) -> bool:
    """Is this browser request reaching another capsule (or reading without a source)?

    - non-browser (curl / scripts / tests) → allowed: local ops and acceptance keep working;
    - Referer under `/capsules/...` → must name the same capsule as this request;
    - Referer is `/` / `/?view=settings` / any non-capsule page → allowed: that is the main UI (or
      another site) sending the user to a capsule with a normal link click. The Referer is **present**
      here, so it says nothing about another capsule;
    - **no Referer at all** → the Referer was stripped (`rel=noreferrer`, a `window.open(...,
      'noreferrer')` from the launcher, an external link, the address bar). Then only a **document**
      navigation passes: a capsule's `fetch(..., {referrerPolicy:'no-referrer'})` is `mode=cors` /
      `same-origin`, and an `<iframe>` navigation is `dest=iframe`, so both stay refused.

    Why the referer-present / referer-absent split matters: the launcher opens a capsule with
    `window.open(url, '_blank', 'noopener,noreferrer')` → no Referer **and** `sec-fetch-site:
    same-origin` (Chrome derives it from the initiator, not from the header). Keying the fallback off
    `sec-fetch-site` therefore 403'd the launcher's own "open capsule" click; keying it off
    `sec-fetch-dest` keeps the no-referrer fetch/iframe bypass closed and does not depend on whether a
    Referer happens to survive.
    """
    if scope is None:
        return False
    host = _host_of(request)
    if _is_capsule_host(host):
        # In subdomain mode the Host itself is the identity; another capsule's slug host must not be accepted either
        if not subdomains_enabled(scope) or host != capsule_host(scope):
            return True
    if not _browser_request(request):
        return False
    if request.headers.get("referer", ""):
        ref_rel = _referer_relpath(request)
        if ref_rel is None:
            return False  # main UI / another site: an ordinary navigation into the capsule
        ref_scope = _scope_key(ref_rel)
        # A Referer under /capsules/ that resolves to nothing (the capsule was deleted or renamed, or
        # the lookup raced a layer change) is not evidence of *another* capsule: only a different
        # *resolved* capsule is refused. Treating None as a mismatch made a capsule's own HEAD /
        # OPTIONS intermittently 403 right after its first save landed in the user layer.
        return ref_scope is not None and ref_scope != scope
    mode = (request.headers.get("sec-fetch-mode") or "").lower()
    dest = (request.headers.get("sec-fetch-dest") or "").lower()
    if mode != "navigate":
        return True  # fetch / XHR / script / image …: no source capsule, no access
    return dest in _FRAME_DESTS


def _main_host_write_forbidden(relpath: str, scope: str | None) -> Response:
    if scope is None:
        return _not_found(relpath)
    return Response(
        status_code=403,
        content=json.dumps(
            {
                "ok": False,
                "error": tr("capsules.subdomain_write_forbidden"),
                "hint": tr(
                    "capsules.subdomain_write_forbidden_hint",
                    host=capsule_host(scope),
                    path=quote(relpath),
                ),
            },
            ensure_ascii=False,
        ),
        media_type="application/json",
    )


def _forbidden(relpath: str, scope: str | None) -> Response:
    return Response(
        status_code=403,
        content=json.dumps(
            {
                "ok": False,
                "error": tr("capsules.other_capsule_forbidden"),
                "hint": tr(
                    "capsules.other_capsule_forbidden_hint",
                    path=repr(relpath),
                    scope=scope or tr("capsules.scope_unknown"),
                ),
            },
            ensure_ascii=False,
        ),
        media_type="application/json",
    )

def _url_path(root: Path, relpath: str) -> str:
    """The shortest readable URL for this file (**re-validated before emitting**: fall back to the
    explicit path).

    An explicit path always works, so a missing short form is not an error, just less pretty.
    Directory capsules (`<dir>/index.html`) keep a **trailing slash** (`chat/`): that is not cosmetic —
    a relative `./data/` in the page resolves against the current URL (`…/capsules/chat` drifts to
    `…/capsules/data`, observed with a chat capsule); the slash keeps the capsule's data root inside its
    own folder.
    """
    parts = relpath.split("/")
    last = parts[-1]
    if last == "index.html":
        if len(parts) < 2:
            return relpath  # a top-level index.html has no shorter form
        short = "/".join(parts[:-1]) + "/"
    elif len(parts) >= 2 and last == parts[-2] + Path(last).suffix:
        short = "/".join(parts[:-1])  # pinyin/pinyin.html → pinyin
    else:
        short = "/".join(parts[:-1] + [Path(last).stem])  # a/b.html → a/b
    target = root.joinpath(*parts)
    return short if _resolve_in(root, short) == target else relpath


def scan_capsules() -> list[dict[str, Any]]:
    """Recursively scan `.html` / `.htm` under the capsule roots, one entry per file (dot dirs/files skipped).

    **Why scan the directory instead of maintaining an import list**: a list has to be maintained by
    the UI — an import dialog, IPC, an allowlist, an id→file derivation — just to answer "which files
    count". "Every `.html` in the directory is a capsule" needs no registration at all: the file goes
    in and appears, gets deleted and disappears. The import endpoint added in 2026-11 does not change
    that: it writes a file into the same tree, and the overlay in `capsules.json` only *decorates*
    what this scan found (see `_capsules_import`).

    Each entry carries `url_path`: the shortest readable URL (the explicit path on collision), and
    `meta`: the declared overlay fields (empty when the capsule was never imported/edited).
    """
    roots = capsule_roots()
    if not roots:
        return []
    out: list[dict[str, Any]] = []
    seen_relpaths: set[str] = set()
    for layer, base, writable in roots:
        if len(out) >= MAX_APPS:
            break
        root = base.resolve()
        for path in sorted(root.rglob("*")):
            if len(out) >= MAX_APPS:
                break
            try:
                if not path.is_file() or path.suffix.lower() not in _APP_SUFFIXES:
                    continue
                rel_parts = path.relative_to(root).parts
            except OSError:
                continue
            if any(part.startswith(".") for part in rel_parts):
                continue  # dot prefix = editor temp files / hidden dirs, not capsules
            if not _inside(root, path):
                continue  # symlink pointing outside: listing it would open a back door
            relpath = path.relative_to(root).as_posix()
            # The same relative path in several layers keeps the higher layer (user > system), so an
            # upgrade cannot shadow user edits
            if relpath in seen_relpaths:
                continue
            seen_relpaths.add(relpath)
            stat = path.stat()
            capsule_id = f"{layer}:{relpath}"
            enabled = not is_capsule_disabled(layer, path, root)
            out.append(
                {
                    "id": capsule_id,
                    "relpath": relpath,
                    "name": path.name,
                    "path": str(path),
                    "source": layer,                 # user | system
                    "writable": writable,
                    "data_writable": True,           # both built-in and user capsules support sandbox data writes
                    "enabled": enabled,
                    "url_path": _url_path(root, relpath),
                    "bytes": stat.st_size,
                    "mtime": int(stat.st_mtime),
                    # bookmark trio (title/icon/description): empty when the file has none, the UI falls back
                    **_extract_meta(path, root, stat.st_mtime_ns, stat.st_size),
                }
            )
    # Two paths can collide on one short URL (pinyin.html vs pinyin/index.html): the lexicographically
    # first keeps it and the rest fall back to the explicit path — an ugly URL beats a link that
    # resolves to someone else's file.
    taken: dict[str, str] = {}
    for item in out:
        short = item["url_path"]
        if short == item["relpath"]:
            continue
        if short in taken:
            item["url_path"] = item["relpath"]
        else:
            taken[short] = item["relpath"]
    # Declared metadata wins over the scraped trio, and `order` decides the list order (the launcher
    # and the wall both render this array as-is). A missing overlay leaves the scraped values alone.
    from . import _capsules_import as meta_store

    meta_store.apply_overlay(out)
    out.sort(key=meta_store.sort_key)
    return out


def read_settings_safe() -> dict[str, Any]:
    try:
        from .settings import read_settings

        return read_settings()[0]
    except Exception:  # noqa: BLE001
        return {}


def list_capsules(request: Request) -> dict[str, Any]:
    """List scanned capsules as JSON: each item carries an absolute, directly openable `url`.

    `url` is built from the request's host (the server only listens on loopback), so whichever address
    you reached it through is the one you get back.
    """
    base_url = str(request.base_url).rstrip("/")
    settings = read_settings_safe()
    global_sub = bool(settings.get("capsules_subdomains"))
    overrides = settings.get("capsules_subdomains_overrides") or {}
    if not isinstance(overrides, dict):
        overrides = {}
    from . import _capsules_import as meta_store

    scanned = scan_capsules()
    stale = max(0, len(meta_store.read_meta()) - sum(1 for app in scanned if app.get("meta")))
    items = []
    for app in scanned:
        scope = _scope_key(app["relpath"]) or app["relpath"]
        isolated = bool(overrides[scope]) if scope in overrides else global_sub
        url = (
            _subdomain_url(request, scope, app["url_path"])
            if isolated and _is_main_host(_host_of(request))
            else f"{base_url}/capsules/{quote(app['url_path'])}"
        )
        items.append({**app, "scope": scope, "subdomains": isolated, "url": url})
    user = capsules_dir()
    system = system_capsules_dir()
    roots = [{"name": name, "path": str(path), "writable": writable} for name, path, writable in capsule_roots()]
    state = dir_state()
    return {
        "ok": True,
        "capsules": items,
        "capsules_dir": str(user) if user else "",
        "system_capsules_dir": str(system) if system else "",
        "capsule_roots": roots,
        "max_capsules": MAX_APPS,
        "max_bytes": MAX_BYTES,
        # How many declared overlay entries no longer decorate anything (their file is gone). The
        # manifest is pruned on the next metadata write; the UI only needs to say so.
        "stale_metadata": stale,
        "capsules_subdomains": global_sub,
        "capsules_subdomains_overrides": dict(overrides),
        # Guide state: disabled / ok / missing / not_dir / unwritable, plus where the library lives.
        # `capsules_enabled` is the explicit on/off switch; an empty `capsules_dir` means the default
        # location (created on first import/save), which is why a fresh install is already usable.
        "configured": state["configured"],
        "problem": state["problem"],
        "problem_detail": state["detail"],
        "configured_path": state["path"],
        "capsules_enabled": capsules_enabled(),
        "capsules_dir_exists": bool(state.get("exists")),
        "using_default": bool(state.get("using_default")),
        "default_capsules_dir": _display_path(default_capsules_dir()),
        # kept for older clients: the default location is the recommended one
        "recommended_dir": _display_path(default_capsules_dir()),
    }


def _etag(data: bytes) -> str:
    """Content fingerprint for strong validation (first 16 hex chars). Single-file apps use it as `If-Match`."""
    return f'"{hashlib.sha256(data).hexdigest()[:16]}"'


def _refuse(relpath: str, if_match: str | None, current: str) -> Response | None:
    """`If-Match` gate: 412 when it does not match (someone else just saved) — never overwrite silently.
    No `If-Match` → allowed."""
    if if_match and if_match != "*" and if_match.strip() != current:
        return Response(
            status_code=412,
            content=json.dumps(
                {
                    "ok": False,
                    "error": tr(
                        "capsules.stale_conflict", path=relpath, current=current, if_match=if_match
                    ),
                    "hint": tr("capsules.stale_conflict_hint"),
                },
                ensure_ascii=False,
            ),
            media_type="application/json",
            headers={"ETag": current},
        )
    return None


def _origin_allowed(request: Request) -> bool:
    """Second PUT gate: only local pages / the desktop shell (the loopback server has no auth, so this stays)"""
    origin = request.headers.get("origin")
    return origin is None or bool(_ORIGIN_LOCAL.match(origin)) or origin in _TAURI_ORIGINS


def _write_atomic(file: Path, body: bytes) -> None:
    """Full overwrite: write a temp file in the same directory, then `os.replace`, carrying over the
    original permission bits.

    A half-written file when saving fails is the worst outcome; and an original file that is 600
    turning into 644 on rewrite would silently widen its permissions.
    """
    tmp = file.with_name(f".{file.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        tmp.write_bytes(body)
        try:
            os.chmod(tmp, file.stat().st_mode & 0o7777)
        except OSError:
            pass  # permission bits unavailable on some filesystems: don't fail the save over it
        os.replace(tmp, file)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def _directory_redirect_url(relpath: str, file: Path, request: Request) -> str | None:
    """Add a redirect when a directory capsule's short URL lacks the trailing slash.

    Why it is required: `new URL("data/x.json", location.href)` in the page uses the **current URL** as
    its base. `…/capsules/hello` is treated as a file, so `data/` drifts to `…/capsules/data/` (outside
    the capsule folder); with the slash it is `…/capsules/hello/data/`. That is not just cosmetics — it
    decides where data lands, and which segment the CSP treats as "own folder".

    Only for GET/HEAD (PUT/OPTIONS must not be swallowed by a redirect), and only when the short URL
    really resolves to a directory-named entry (an explicit `a/b.html` is untouched).
    """
    if relpath.endswith("/"):
        return None
    parts = [p for p in relpath.split("/") if p]
    if not parts or Path(parts[-1]).suffix:
        return None
    if file.parent.name != parts[-1]:
        return None
    target = request.url.path
    if not target.endswith("/"):
        target += "/"
    if request.url.query:
        target += "?" + request.url.query
    return target


def _not_found(relpath: str) -> Response:
    roots = capsule_roots()
    if not roots:
        hint = tr("capsules.not_found_no_roots_hint")
    else:
        hint = tr(
            "capsules.not_found_layers_hint",
            roots="、".join(str(path) for _name, path, _w in roots),
        )
    return Response(
        status_code=404,
        content=json.dumps(
            {"ok": False, "error": tr("capsules.not_found", path=relpath), "hint": hint},
            ensure_ascii=False,
        ),
        media_type="application/json",
    )


#: These suffixes are rendered as a **document** by the browser in the sandbox (and may execute
#: script), so they must get the page CSP as well; otherwise a capsule could write a .html/.svg into
#: its own folder and iframe it to bypass isolation.
_PAGE_LIKE_SUFFIXES = (".html", ".htm", ".xhtml", ".svg", ".xml")


def _page_like(file: Path) -> bool:
    return file.suffix.lower() in _PAGE_LIKE_SUFFIXES


def _media_type(file: Path) -> str:
    """Content-Type of a sandbox data file (the entry html always takes the text/html branch)"""
    if file.suffix.lower() in _APP_SUFFIXES:
        return "text/html; charset=utf-8"
    return mimetypes.guess_type(file.name)[0] or "application/octet-stream"


def get_capsule(relpath: str, request: Request) -> Response:
    """Serve one capsule verbatim (`no-store`: a reload after saving must see the new content).

    When no entry html resolves, fall back to the **sandbox**: data files inside the capsule folder
    (index.json, `chat/*.json`, blobs).

    A browser request must come from the **same capsule** (see `_scope_denied`); the CSP also only
    allows its own folder.
    """
    scope = _scope_key(relpath)
    if _scope_denied(request, relpath, scope):
        return _forbidden(relpath, scope)
    if scope is not None and subdomains_enabled(scope) and _is_main_host(_host_of(request)):
        return RedirectResponse(_subdomain_url(request, scope, _canonical_url_path(relpath)), status_code=302)
    file = _resolve(relpath)
    sandboxed = False
    if file is None:
        hit = _sandbox_resolve(relpath)
        if hit is None or not hit[1].is_file():
            return _not_found(relpath)
        file = hit[1]
        sandboxed = True
    else:
        redirect = _directory_redirect_url(relpath, file, request)
        if redirect is not None:
            return RedirectResponse(redirect, status_code=302)
    data = file.read_bytes()
    headers = {
        "Cache-Control": "no-store",
        "ETag": _etag(data),
    }
    if not sandboxed or _page_like(file):
        headers["Content-Security-Policy"] = page_csp(request, scope)
        headers["Referrer-Policy"] = "same-origin"
    return Response(
        content=data,
        media_type=_media_type(file),
        headers=headers,
    )


def head_capsule(relpath: str, request: Request) -> Response:
    """Same headers as GET, no body (single-file capsules read `ETag` from it; FastAPI's get does not
    auto-answer HEAD)"""
    scope = _scope_key(relpath)
    if _scope_denied(request, relpath, scope):
        return _forbidden(relpath, scope)
    if scope is not None and subdomains_enabled(scope) and _is_main_host(_host_of(request)):
        return RedirectResponse(_subdomain_url(request, scope, _canonical_url_path(relpath)), status_code=302)
    file = _resolve(relpath)
    sandboxed = False
    if file is None:
        hit = _sandbox_resolve(relpath)
        if hit is None or not hit[1].is_file():
            return _not_found(relpath)
        file = hit[1]
        sandboxed = True
    else:
        redirect = _directory_redirect_url(relpath, file, request)
        if redirect is not None:
            return RedirectResponse(redirect, status_code=302)
    data = file.read_bytes()
    headers = {
        "Cache-Control": "no-store",
        "ETag": _etag(data),
        "Content-Length": str(len(data)),
    }
    if not sandboxed or _page_like(file):
        headers["Content-Security-Policy"] = page_csp(request, scope)
        headers["Referrer-Policy"] = "same-origin"
    return Response(
        status_code=200,
        media_type=_media_type(file),
        headers=headers,
    )


def options_capsule(relpath: str, request: Request) -> Response:
    """`DAV: 1` + `Allow`: tells single-file capsules (TiddlyWiki et al.) that this server accepts PUT.
    Sandbox paths answer too (even before the file exists — PUT creates it, so probing must answer first)."""
    scope = _scope_key(relpath)
    if _scope_denied(request, relpath, scope):
        return _forbidden(relpath, scope)
    if _resolve(relpath) is None and _sandbox_resolve(relpath) is None:
        return _not_found(relpath)
    return Response(
        status_code=200,
        headers={"DAV": "1", "Allow": "GET, HEAD, OPTIONS, PUT, DELETE", "MS-Author-Via": "DAV"},
    )


async def put_capsule(relpath: str, request: Request) -> Response:
    """Overwrite one capsule in place (idempotent): 204 / 404 unknown / 412 stale / 413 too big / 403 cross-origin.

    Two paths with deliberately different semantics:
      * **entry html** (`_resolve` hit): write back only, never create a new capsule — the TiddlyWiki
        semantics, untouched. A built-in (system layer) entry is read-only on disk, so the save is
        **materialized into the writable user library** under the same relative path and shadows the
        shipped file from then on (the same copy-on-write rule `_sandbox_resolve` already applies to
        built-in capsules' data). That is what makes a bundled TiddlyWiki actually save: upgrading the
        software replaces the shipped copy, never the user's edits. Only when the user library cannot
        be created (permissions) does the save fail with 403 `system_layer_read_only`.
      * **sandbox path** (inside a capsule folder): may **create**, auto-creates parent dirs, and a
        per-sandbox file cap applies. Multi-file capsules (e.g. `data/chat/*.json`) persist
        their data through this path.
    """
    if not _origin_allowed(request):
        return Response(
            status_code=403,
            content=json.dumps(
                {"ok": False, "error": tr("capsules.write_origin_forbidden")},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            media_type="application/json",
        )
    scope = _scope_key(relpath)
    if _scope_denied(request, relpath, scope):
        return _forbidden(relpath, scope)
    if scope is not None and subdomains_enabled(scope) and _is_main_host(_host_of(request)):
        return _main_host_write_forbidden(relpath, scope)
    file = _resolve(relpath)

    if file is not None:
        # How is this entry resolved, and may we write it in place? An entry in a read-only layer
        # (the bundled capsules that ship with the software) is copied into the user library on its
        # first save instead of being refused: `ETag` stays the served content's (the client's
        # `If-Match` is checked against what it actually read), while the bytes land in the user layer.
        source = file
        writable = False
        layer_root: Path | None = None
        for _name, root, is_writable in capsule_roots():
            try:
                file.relative_to(root)
            except ValueError:
                continue
            layer_root, writable = root, is_writable
            break
        if not writable:
            # No owning layer (cannot happen for a resolved file) or the built-in layer: copy-on-write.
            read_only = Response(
                status_code=403,
                content=json.dumps(
                    {
                        "ok": False,
                        "error": tr("capsules.system_layer_read_only"),
                        "hint": tr("capsules.system_layer_read_only_hint"),
                    },
                    ensure_ascii=False,
                ),
                media_type="application/json",
            )
            try:
                if layer_root is None:
                    raise OSError("no owning capsule root")
                user_root = _user_capsules_dir_auto()
                file = user_root / file.relative_to(layer_root)
                if not _inside(user_root, file):
                    return _not_found(relpath)
                # A directory capsule's entry lives one level down: the copy needs that folder.
                file.parent.mkdir(parents=True, exist_ok=True)
            except OSError:
                return read_only

    if file is None:
        # ---- Sandbox write: create/store a data file inside the capsule's own folder ----
        hit = _sandbox_resolve(relpath, write=True)
        if hit is None:
            return _not_found(relpath)
        sandbox_root, target = hit
        # Validate before mkdir (`resolve` follows existing symlinks: if an intermediate segment was
        # swapped for a link pointing outside the library, this catches it instead of first creating
        # a directory outside and asking questions later)
        if not _inside(sandbox_root, target):
            return _not_found(relpath)
        exists = target.is_file()
        current = _etag(target.read_bytes()) if exists else _etag(b"")
        conflict = _refuse(relpath, request.headers.get("if-match"), current)
        if conflict is not None:
            return conflict
        body = await request.body()
        if len(body) > MAX_BYTES:
            return Response(
                status_code=413,
                content=json.dumps(
                    {
                        "ok": False,
                        "error": tr("capsules.file_too_large", limit=MAX_BYTES // (1024 * 1024)),
                        "hint": tr("capsules.sandbox_file_too_large_hint"),
                    },
                    ensure_ascii=False,
                ),
                media_type="application/json",
                headers={"ETag": current},
            )
        # Total quota: one capsule may hold at most MAX_CAPSULE_BYTES (computed before writing,
        # subtracting the old size when an existing file is replaced)
        try:
            used = sum(p.stat().st_size for p in sandbox_root.rglob("*") if p.is_file())
            old_size = target.stat().st_size if exists else 0
        except OSError:
            used, old_size = 0, 0
        if used - old_size + len(body) > MAX_CAPSULE_BYTES:
            return Response(
                status_code=413,
                content=json.dumps(
                    {
                        "ok": False,
                        "error": tr(
                            "capsules.capsule_quota_exceeded",
                            limit=MAX_CAPSULE_BYTES // (1024 * 1024),
                        ),
                        "hint": tr("capsules.capsule_quota_exceeded_hint"),
                    },
                    ensure_ascii=False,
                ),
                media_type="application/json",
                headers={"ETag": current},
            )
        if not exists:
            # Check the file cap before creating: stops any local page from stuffing the library with fragments
            try:
                count = sum(1 for p in sandbox_root.rglob("*") if p.is_file())
            except OSError:
                count = 0
            if count >= MAX_SANDBOX_FILES:
                return Response(
                    status_code=413,
                    content=json.dumps(
                        {
                            "ok": False,
                            "error": tr(
                                "capsules.too_many_files", count=count, limit=MAX_SANDBOX_FILES
                            ),
                            "hint": tr("capsules.too_many_files_hint"),
                        },
                        ensure_ascii=False,
                    ),
                    media_type="application/json",
                )
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            return _not_found(relpath)
        if not _inside(sandbox_root, target):  # re-check after mkdir (symlink race)
            return _not_found(relpath)
        _write_atomic(target, body)
        return Response(status_code=204, headers={"ETag": _etag(body)})

    # ---- Entry html: write back (never create a new capsule) ----
    current = _etag(source.read_bytes())
    conflict = _refuse(relpath, request.headers.get("if-match"), current)
    if conflict is not None:
        return conflict

    body = await request.body()
    if len(body) > MAX_BYTES:
        return Response(
            status_code=413,
            content=json.dumps(
                {
                    "ok": False,
                    "error": tr("capsules.file_too_large", limit=MAX_BYTES // (1024 * 1024)),
                    "hint": tr("capsules.entry_file_too_large_hint"),
                },
                ensure_ascii=False,
            ),
            media_type="application/json",
            headers={"ETag": current},
        )

    _write_atomic(file, body)
    return Response(status_code=204, headers={"ETag": _etag(body)})


def delete_capsule(relpath: str, request: Request) -> Response:
    """Delete one sandbox data file (a chat capsule deletes sessions through it).

    The entry html itself is **not deletable** (405): deleting a capsule means deleting the file in your
    library, not letting the capsule decide — the mirror image of "write is not upload": writes can
    create, deletes cannot remove the body.
    """
    if not _origin_allowed(request):
        return Response(
            status_code=403,
            content=json.dumps(
                {"ok": False, "error": tr("capsules.delete_origin_forbidden")},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            media_type="application/json",
        )
    scope = _scope_key(relpath)
    if _scope_denied(request, relpath, scope):
        return _forbidden(relpath, scope)
    if scope is not None and subdomains_enabled(scope) and _is_main_host(_host_of(request)):
        return _main_host_write_forbidden(relpath, scope)
    if _resolve(relpath) is not None:
        return Response(
            status_code=405,
            content=json.dumps(
                {
                    "ok": False,
                    "error": tr("capsules.entry_delete_forbidden"),
                    "hint": tr("capsules.entry_delete_forbidden_hint"),
                },
                ensure_ascii=False,
            ),
            media_type="application/json",
        )
    hit = _sandbox_resolve(relpath, write=True)
    if hit is None or not hit[1].is_file():
        return _not_found(relpath)
    try:
        hit[1].unlink()
    except OSError as exc:
        return Response(
            status_code=500,
            content=json.dumps(
                {"ok": False, "error": tr("capsules.delete_failed", error=exc)}, ensure_ascii=False
            ),
            media_type="application/json",
        )
    return Response(status_code=204)


async def toggle_capsule(request: Request) -> dict[str, Any]:
    """Toggle a capsule's enabled state."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        raise ToolError(
            tr("capsules.body_must_be_object"),
            hint=tr("capsules.body_must_be_object_hint"),
        )

    target_id = str(body.get("id") or "").strip()
    relpath = str(body.get("relpath") or "").strip()
    source = str(body.get("source") or "").strip()
    enabled = bool(body.get("enabled", True))

    if not target_id:
        if source and relpath:
            target_id = f"{source}:{relpath}"
        elif relpath:
            target_id = relpath
        else:
            raise ToolError(
                tr("capsules.toggle_missing_id"),
                hint=tr("capsules.toggle_missing_id_hint"),
            )

    dis = list(disabled_keys())
    # Drop any existing form of this capsule from the list
    dis = [x for x in dis if x != target_id and x != relpath and (not relpath or x != f"{source}:{relpath}")]
    if not enabled:
        dis.append(target_id)

    set_values({"capsules_disabled": dis})
    return {"ok": True, "id": target_id, "enabled": enabled, "capsules_disabled": dis}


# ----------------------------------------- Import / declared metadata / library delete
#
# The optional front door. `scan_capsules()` still decides what exists (a file in the library), so
# these three endpoints write a file, decorate one, or remove one — none of them can make a capsule
# appear that is not on disk, and none of them is required for a capsule to work.


def _origin_forbidden(message: str) -> Response:
    """403 in the same JSON envelope every other write uses (the loopback server has no auth)."""
    return Response(
        status_code=403,
        content=json.dumps({"ok": False, "error": message}, ensure_ascii=False),
        media_type="application/json",
    )


async def _json_object(request: Request) -> dict[str, Any]:
    """Request body → object; empty body = {}; anything else → the shared readable error."""
    raw = await request.body()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ToolError(
            tr("capsules.body_must_be_object"),
            hint=tr("capsules.body_must_be_object_hint"),
        ) from exc
    if not isinstance(parsed, dict):
        raise ToolError(
            tr("capsules.body_must_be_object"),
            hint=tr("capsules.body_must_be_object_hint"),
        )
    return parsed


async def import_capsule(request: Request) -> dict[str, Any]:
    """`POST /api/capsules/import` — copy one capsule into the user library (the import front door).

    Two transports, one writer: the desktop shell hands over `{"path"}`, a plain browser hands over
    `{"filename", "content"}` (no filesystem access there). Either way the bytes land in the library
    as one `.html`/`.htm` file, and the next `GET /api/capsules` sees it through the normal scan —
    import is a convenience in front of "drop the file in", never a replacement for it.

    The library is created on demand, so this is also the zero-configuration path: a machine that
    never configured `capsules_dir` can import right away.
    """
    if not _origin_allowed(request):
        return _origin_forbidden(tr("capsules.write_origin_forbidden"))
    from . import _capsules_import as importer

    payload = await _json_object(request)
    meta = payload.get("meta")
    if meta is not None and not isinstance(meta, dict):
        raise ToolError(tr("capsules.meta_body_invalid"), hint=tr("capsules.meta_body_invalid_hint"))
    replace = bool(payload.get("replace"))
    path = str(payload.get("path") or "").strip()
    if path:
        result = importer.import_from_path(path, replace=replace, meta=meta)
    else:
        content_b64 = payload.get("content_base64")
        content = payload.get("content")
        if isinstance(content_b64, str) and content_b64:
            # A browser reads the picked file as bytes (`<input type=file>` → ArrayBuffer → base64):
            # the page may be gb18030 or have a BOM, and re-encoding it as JSON text would damage it.
            try:
                body = base64.b64decode(content_b64, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ToolError(
                    tr("capsules.import_content_invalid", error=exc),
                    hint=tr("capsules.import_content_invalid_hint"),
                ) from exc
        elif isinstance(content, str):
            body = content.encode("utf-8")
        else:
            raise ToolError(
                tr("capsules.import_body_missing"),
                hint=tr("capsules.import_body_missing_hint"),
            )
        result = importer.import_entry(
            filename=str(payload.get("filename") or "capsule.html"),
            content=body,
            replace=replace,
            meta=meta,
        )
    entry = next((c for c in scan_capsules() if c["relpath"] == result["relpath"]), None)
    return {**result, "capsule": entry}


async def set_capsule_meta(request: Request) -> dict[str, Any]:
    """`POST /api/capsules/meta` — declare name / icon / description / order for one capsule.

    Stored in `capsules.json` (config root, keyed by relpath) and applied on top of whatever the file
    head says. `{"field": null}` clears one field, `{"reset": true}` the whole entry; every field is
    optional, so a capsule that was never imported keeps showing its scraped `<title>`.
    """
    if not _origin_allowed(request):
        return _origin_forbidden(tr("capsules.write_origin_forbidden"))
    from . import _capsules_import as meta_store

    payload = await _json_object(request)
    relpath = str(payload.get("relpath") or "").strip().strip("/")
    if not relpath:
        raise ToolError(tr("capsules.meta_missing_relpath"), hint=tr("capsules.meta_missing_relpath_hint"))
    if _resolve(relpath) is None:
        raise ToolError(
            tr("capsules.not_found", path=relpath),
            hint=tr("capsules.not_found_layers_hint", roots=", ".join(str(p) for _n, p, _w in capsule_roots())),
        )
    # Prune orphans in the same write: valid = everything the scan found, plus the target itself
    # (a bundled capsule can be decorated too, and its relpath is exactly what the scan reports)
    valid = {entry["relpath"] for entry in scan_capsules()}
    valid.add(relpath)
    stored = meta_store.set_meta(relpath, payload, valid=valid)
    return {"ok": True, "relpath": relpath, "meta": stored}


async def remove_capsule(request: Request) -> dict[str, Any]:
    """`POST /api/capsules/delete` — delete one capsule from the user library.

    The library owner's delete, distinct from the entry-path `DELETE` gate (a capsule may never
    delete itself). A bundled (system-layer) capsule is refused with a hint to disable it: the
    software owns that file and an upgrade replaces it. Directory capsules keep their data files
    unless `remove_data` says otherwise.
    """
    if not _origin_allowed(request):
        return _origin_forbidden(tr("capsules.delete_origin_forbidden"))
    from . import _capsules_import as importer

    payload = await _json_object(request)
    relpath = str(payload.get("relpath") or "").strip()
    if not relpath:
        raise ToolError(tr("capsules.meta_missing_relpath"), hint=tr("capsules.meta_missing_relpath_hint"))
    return importer.delete_entry(relpath, remove_data=bool(payload.get("remove_data")))


# Capability-style routes: collected by adapters.discover_routes, registered by main.py (no launcher tool entry)
ROUTES = [
    # JSON list (machine) — pages live at /capsules/* (humans / browsers); the split is deliberate
    {"method": "GET", "path": "/api/capsules", "endpoint": list_capsules},
    # Prepare a writable capsule library (mkdir + config write); the UI never touches fs, all fs work stays host-side
    {"method": "POST", "path": "/api/capsules/ensure", "endpoint": ensure_capsules_dir},
    {"method": "POST", "path": "/api/capsules/toggle", "endpoint": toggle_capsule},
    # Import + declared metadata + library delete (all optional: the scan alone still works)
    {"method": "POST", "path": "/api/capsules/import", "endpoint": import_capsule},
    {"method": "POST", "path": "/api/capsules/meta", "endpoint": set_capsule_meta},
    {"method": "POST", "path": "/api/capsules/delete", "endpoint": remove_capsule},
    # Pages: the URL path is the path relative to capsules_dir (with the completion rules above);
    # unresolvable paths fall through to the sandbox (data files inside a capsule folder)
    {"method": "GET", "path": "/capsules/{relpath:path}", "endpoint": get_capsule},
    {"method": "HEAD", "path": "/capsules/{relpath:path}", "endpoint": head_capsule},
    {"method": "OPTIONS", "path": "/capsules/{relpath:path}", "endpoint": options_capsule},
    {"method": "PUT", "path": "/capsules/{relpath:path}", "endpoint": put_capsule},
    {"method": "DELETE", "path": "/capsules/{relpath:path}", "endpoint": delete_capsule},
]
