"""Y-Hub local GUI server.

Start everything with `uv run yhub gui`:
  * backend: FastAPI exposing /api/*
  * frontend: the React app in web/, served directly once built
  * dev mode: `yhub gui --dev` starts only the API; run the frontend with
    `npm run dev` (Vite proxies /api)

Tools register themselves: modules under yhub/server/adapters/ that export
TOOL_META (one tool) or TOOL_METAS (several) are discovered automatically.
Adding a tool does not require touching this file.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import webbrowser
from pathlib import Path
from urllib.parse import urlsplit

import yhub.cli.env  # noqa: F401

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .adapters import ToolError, discover_adapters, discover_routes, on_registry_change
from .adapters.params import apply_route_params
from yhub.i18n import tr_text

from yhub import __version__
from yhub._data import frontend_dist
from yhub.i18n import tr

ROOT = Path(__file__).resolve().parent.parent  # = yhub/ (same layout in source tree and wheel)
DIST = frontend_dist() or (ROOT / "web" / "dist")
VERSION = __version__
LOG = logging.getLogger("yhub.server")

app = FastAPI(
    title="Y-Hub",
    version=VERSION,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        # Tauri desktop native WebView origin
        "tauri://localhost",
        "http://tauri.localhost",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Security response headers for the main app. The CSP mirrors tauri/tauri.conf.json:
#   * script-src needs 'unsafe-inline': srcdoc iframes inherit the parent CSP, so
#     without it the editor/sample tools lose their inline scripts (run web/smoke.mjs
#     before changing this).
#   * connect-src is limited to the local machine so page scripts cannot call out.
SECURITY_CSP = (
    "default-src 'self'; connect-src 'self' http://127.0.0.1:8790; "
    "img-src 'self' data: https:; script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'"
)


def _request_from_capsule(request) -> bool:
    """Whether the request came from a capsule in the library: the Referer is under
    /capsules/, or it is a same-origin browser request without a Referer.

    The second case covers Service Workers and `referrerPolicy: 'no-referrer'`:
    they still look same-origin in `Sec-Fetch-*` but send no Referer. The main
    app's own fetches always carry a Referer, and Tauri (cross-origin) plus
    curl/scripts (no `Sec-Fetch-*`) are unaffected.
    """
    raw = request.headers.get("referer", "")
    if raw:
        try:
            return urlsplit(raw).path.startswith("/capsules/")
        except ValueError:
            return False
    site = (request.headers.get("sec-fetch-site") or "").lower()
    mode = (request.headers.get("sec-fetch-mode") or "").lower()
    return site == "same-origin" and mode in ("cors", "no-cors", "same-origin")


_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "tauri.localhost"}
_TAURI_ORIGINS = {"tauri://localhost", "http://tauri.localhost"}
_WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

def _host_allowed(host: str) -> bool:
    """Accept only loopback / *.localhost (capsule subdomains) -- blocks DNS rebinding."""
    host = (host or "").lower()
    if host in _LOCAL_HOSTS:
        return True
    return host.endswith(".localhost") and len(host) > len(".localhost")


def _origin_allowed(origin: str | None, host: str) -> bool:
    """Origin allowlist for write methods: local http(s), capsule subdomains, native Tauri.

    - No Origin (curl, native Tauri requests, some same-origin requests) -> allow;
      Host/Sec-Fetch gate it instead.
    - If present it must be local; `Origin: https://evil.example` is always rejected.
    """
    if not origin:
        return True
    if origin in _TAURI_ORIGINS:
        return True
    from urllib.parse import urlsplit

    try:
        parts = urlsplit(origin)
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return False
    h = parts.hostname.lower()
    if h in _LOCAL_HOSTS or (h.endswith(".localhost") and len(h) > len(".localhost")):
        return True
    return h == host  # fallback: same Host (unreachable normally, unless custom hosts)


@app.middleware("http")
async def _security_headers(request, call_next):
    raw_host = request.headers.get("host", "")
    host = (request.url.hostname or "").lower()
    if not raw_host or not _host_allowed(host):
        return JSONResponse(
            status_code=400,
            content={
                "ok": False,
                "error": tr("server.host_not_allowed", host=repr(raw_host)),
                "hint": tr("server.host_not_allowed_hint"),
            },
        )

    capsule_host = host.endswith(".localhost") and host != "localhost"
    if capsule_host:
        # A subdomain origin may only reach its own /capsules/*; host API and main UI stay closed
        if request.url.path.startswith("/api/"):
            return JSONResponse(
                status_code=403,
                content={
                    "ok": False,
                    "error": tr("server.capsule_host_api_forbidden"),
                    "hint": tr("server.capsule_host_api_forbidden_hint"),
                },
            )
        if not request.url.path.startswith("/capsules/"):
            return JSONResponse(
                status_code=404,
                content={"ok": False, "error": tr("server.capsule_subdomain_only_capsules")},
            )

    if request.method in _WRITE_METHODS:
        origin = request.headers.get("origin")
        # Origin only: browsers send it for forms/POST/beacon; native Tauri requests may
        # omit it, so we must not blanket-reject on Sec-Fetch-Site (that would block the
        # desktop shell itself). DNS rebinding is stopped by the Host gate.
        if not _origin_allowed(origin, host):
            return JSONResponse(
                status_code=403,
                content={
                    "ok": False,
                    "error": tr("server.cross_origin_write_denied"),
                    "hint": tr("server.cross_origin_write_denied_hint"),
                },
            )

    # Capsule pages may only reach their own folder: the host /api/* is never open to a
    # capsule. The browser-side CSP connect-src already blocks one layer; this is the
    # server-side backstop (forged non-browser requests are not bound by CSP anyway, but
    # they carry no Referer and so do not conflict with this check).
    if request.url.path.startswith("/api/") and _request_from_capsule(request):
        return JSONResponse(
            status_code=403,
            content={
                "ok": False,
                "error": tr("server.capsule_host_api_forbidden"),
                "hint": tr("server.capsule_host_api_forbidden_hint_external"),
            },
        )
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    # Same-origin requests must carry a Referer: capsule isolation relies on it to tell
    # which capsule a request came from. Cross-origin still leaks nothing (`same-origin`
    # means the full URL is only sent same-origin).
    response.headers.setdefault("Referrer-Policy", "same-origin")
    # Keep API responses (including editor HTML) out of the HTTP cache: bodies never
    # cross the network, and tool code should not linger on disk either.
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    if "text/html" in response.headers.get("content-type", ""):
        response.headers.setdefault("Content-Security-Policy", SECURITY_CSP)
    return response


@app.exception_handler(ToolError)
async def _tool_error(_request, exc: ToolError):
    return JSONResponse(
        status_code=400, content={"ok": False, "error": exc.message, "hint": exc.hint}
    )


_registered_adapters: list[dict] = []

# Marks the endpoint functions a route was registered from. Adapter routes are **rebuilt** while the
# server runs (a plugin can be installed / removed / disabled from the settings page), so they have to
# be findable in `app.router.routes`; capability ROUTES and the hand-written API never carry the mark and
# are therefore left alone.
_ADAPTER_ROUTE_MARK = "__yhub_adapter_route__"

# Route method table, shared by adapters and capability-style modules (ROUTES).
# HEAD / OPTIONS / PUT exist for capsules in the library (/capsules/*): single-file apps
# (TiddlyWiki and friends) probe OPTIONS + DAV headers to decide the server can save,
# fetch an ETag with HEAD, and save the whole file back with PUT. DELETE backs deleting
# data files inside a capsule sandbox (a chat capsule removes its sessions through it).
# See yhub/server/adapters/capsules.py.
_HTTP_METHODS = {
    "GET": app.get,
    "POST": app.post,
    "PUT": app.put,
    "HEAD": app.head,
    "OPTIONS": app.options,
    "DELETE": app.delete,
}


def _build_adapter_routes(metas: list[dict]) -> list:
    """Register every adapter's ``faces.routes`` on a **scratch** router and return the routes.

    Building them aside keeps the splice in `_splice_adapter_routes` in charge of where the block
    goes, so a rebuild does not move adapter routes behind later-registered paths and change which
    route wins a matching contest.

    Routes live in ``meta["faces"]["routes"]`` (declarative params in ``adapters/params.py``): routes
    that declare ``params`` get their endpoint signature rewritten by ``apply_route_params`` so
    HTTP/MCP/CLI share one params spec; those that do not keep their own signature.
    """
    scratch = APIRouter()
    verbs = {
        "GET": scratch.get,
        "POST": scratch.post,
        "PUT": scratch.put,
        "HEAD": scratch.head,
        "OPTIONS": scratch.options,
        "DELETE": scratch.delete,
    }
    for meta in metas:
        faces = meta.get("faces") or {}
        for route in faces.get("routes", []):
            register = verbs.get(str(route["method"]).upper())
            if register is None:
                continue
            if route.get("params") is not None:
                where = f"{meta['id']}:{route['path']}"
                apply_route_params(route["endpoint"], route, where=where)
            endpoint = route["endpoint"]
            try:
                setattr(endpoint, _ADAPTER_ROUTE_MARK, True)
            except (AttributeError, TypeError):
                pass  # a builtin / slot wrapper: then the route simply cannot be rebuilt
            register(route["path"])(endpoint)
    return list(scratch.routes)


def _splice_adapter_routes(routes: list) -> None:
    """Swap the adapter route block in `app.router.routes`, **in place** (same match-order slot)."""
    kept = []
    start: int | None = None
    for route in app.router.routes:
        if getattr(getattr(route, "endpoint", None), _ADAPTER_ROUTE_MARK, False):
            if start is None:
                start = len(kept)
            continue
        kept.append(route)
    if start is None:
        start = len(kept)
    kept[start:start] = routes
    app.router.routes[:] = kept


def _register_adapters() -> None:
    """(Re)build the adapter registry: routes + the tool metadata behind ``/api/tools``.

    Called once at import and again by `refresh_adapters` whenever the plugin set changes, so this
    must stay **idempotent**: it replaces the previous adapter routes instead of adding a second copy.
    """
    metas = [entry["meta"] for entry in discover_adapters()]
    _splice_adapter_routes(_build_adapter_routes(metas))
    _registered_adapters[:] = metas
    app.openapi_schema = None  # /api/docs must describe the routes that exist now


def refresh_adapters() -> bool:
    """Rebuild the registry after the plugin set changed (install / remove / enable / disable).

    Why it exists: the settings page can install and uninstall plugins **while the backend runs**. A
    removed plugin whose tool stayed in `/api/tools` showed up in the sidebar as "this tool has no
    panel yet", and a fresh install had no working routes at all — both are the same frozen snapshot.

    A bad declaration makes `discover_adapters` raise ValueError (red at startup, by design). Here it
    must not take a working server down: keep the previous registry, log loudly, and report failure to
    the caller (the plugin endpoints pass it on as `restart_required`).
    """
    try:
        _register_adapters()
    except ValueError as exc:
        LOG.error("[adapters] 插件声明有问题，沿用上一份工具表（下次启动会直接报错）：%s", exc)
        return False
    return True


on_registry_change(refresh_adapters)


def _register_capability_routes() -> None:
    """Capability-style modules (e.g. capsule hosting in yhub/server/adapters/capsules.py): routes
    only, no launcher tool entry. Registered once — they ship with the software and never change."""
    for route in discover_routes():
        _HTTP_METHODS[route["method"]](route["path"])(route["endpoint"])


_register_adapters()
_register_capability_routes()


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "version": VERSION, "service": "Y-Hub GUI"}


#: Panels are trusted plugin code (a plugin already runs Python in this process), so this CSP is
#: hygiene rather than a sandbox: no cross-origin navigations, inline styles/scripts allowed because
#: the panel is one self-contained file.
PANEL_CSP = (
    "default-src 'self' https: data: blob:; "
    "script-src 'self' 'unsafe-inline' https:; "
    "style-src 'self' 'unsafe-inline' https:; "
    "img-src 'self' data: https:; "
    "connect-src 'self' https:; "
    "form-action 'none'; "
    "base-uri 'none'"
)


@app.get("/api/plugins/{plugin_id}/panel")
def plugin_panel(plugin_id: str):
    """Serve a plugin's own screen (`presentation.panel`) as one HTML file.

    The workbench shows it in an iframe, so a plugin ships its UI with no build step in this repo and
    no shared component tree. Missing plugin / no declaration / file gone after install → 404 with a
    plain message; the workbench falls back to its placeholder.
    """
    from fastapi.responses import FileResponse
    from .adapters import _plugin_loader as L

    dir_path = L.plugins_dir() / plugin_id
    manifest_path = dir_path / "plugin.json"
    if not manifest_path.is_file():
        raise ToolError(tr("plugins.err.unknown_id", id=plugin_id))
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ToolError(tr("plugins.err.manifest_not_json", path=f"{plugin_id}/plugin.json",
                           line=0, message="unreadable"))
    entry = ((manifest.get("presentation") or {}) if isinstance(manifest, dict) else {}).get("panel")
    if not entry:
        raise ToolError(tr("plugins.err.panel_undeclared", id=plugin_id))
    target = (dir_path / str(entry)).resolve()
    if dir_path.resolve() not in target.parents or not target.is_file():
        raise ToolError(tr("plugins.err.panel_missing", entry=repr(entry)))
    response = FileResponse(target, media_type="text/html")
    response.headers["Content-Security-Policy"] = PANEL_CSP
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/tools")
def tools() -> dict:
    """The tool list behind the sidebar / launcher (`_registered_adapters` is rebuilt live, so a
    plugin installed or removed while the server runs appears / disappears without a restart)."""
    tool_list = []
    for meta in list(_registered_adapters):  # copy: a rebuild may replace the list from the event loop
        ready_fn = meta.get("ready")
        status_fn = meta.get("status")
        ready = ready_fn() if callable(ready_fn) else bool(ready_fn)
        status_val = status_fn() if callable(status_fn) else str(status_fn)
        tool_list.append({
            "id": meta["id"],
            "name": tr_text(meta["name"]),
            "icon": meta["icon"],
            "description": tr_text(meta["description"]),
            "ready": ready,
            "status": tr_text(status_val),
            # Optional: launcher search keywords declared by the adapter (omitted when absent)
            **({"keywords": meta["keywords"]} if meta.get("keywords") else {}),
            # Optional: a plugin that ships its own screen (`presentation.panel`) — the workbench
            # renders it in an iframe instead of the "no panel yet" placeholder.
            **({"panel": f"/api/plugins/{meta['id']}/panel"}
               if (meta.get("presentation") or {}).get("panel") else {}),
        })
    return {"ok": True, "tools": tool_list}


def _mount_frontend() -> bool:
    # `yhub gui --dev` starts the API only: the frontend runs under Vite, dist is not served here.
    if os.environ.get("YHUB_GUI_NO_FRONTEND") == "1":
        return False
    if not DIST.is_dir():
        return False
    # SPA path-routing fallback: return index.html for /apps/{app_id}, /settings, etc.
    @app.get("/apps/{app_id:path}")
    @app.get("/settings")
    async def _spa_fallback():
        return FileResponse(DIST / "index.html")

    app.mount("/", StaticFiles(directory=str(DIST), html=True), name="web")
    return True


_mount_frontend()


def run_gui(port: int = 8790, open_browser: bool = True, dev: bool = False) -> int:
    import uvicorn

    url = f"http://127.0.0.1:{port}/"
    if not dev and not DIST.is_dir():
        print(tr("server.frontend_not_built"))
        print("    cd web && npm install && npm run build")
        print(tr("server.frontend_dev_mode_hint"))
    print(f"Y-Hub GUI  →  {url}")

    if open_browser and not dev:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
    return 0
