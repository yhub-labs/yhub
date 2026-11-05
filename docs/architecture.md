# Architecture

Module split, request flow, contracts. See also [`../README.md`](../README.md), [`../api-contract.md`](../api-contract.md), [`plugins.md`](plugins.md), [`config.md`](config.md).

## Module map

| Path | Role |
| --- | --- |
| `yhub/server/main.py`, `yhub/server/mcp_server.py`, `yhub/cli/` | FastAPI app: mounts routes from declarations and serves `/api/*` + the built frontend; MCP (stdio) and CLI faces generated from the same declarations |
| `yhub/server/adapters/` | one module per capability (the built-ins are the core plugins): `__init__.py` discovery, `params.py` shared parameter format, `_plugin_loader.py` manifests, `_dashboard_sources.py` wall registry, `_cell_fetch.py` fetch helpers, `plugin_api.py` public plugin API |
| `web/`, `yhub/web/dist` | Vite + React + TS frontend; its build output is packed into the package |
| `tauri/`, `packaging/` | macOS shell (tray, hotkeys, backend launcher); wheel / .app build and verification |

**The one hard boundary**: capabilities live in `yhub/server/adapters/`; the UI only renders them. No shell commands,
hand-built URLs or path parsing in `web/`, and the backend knows nothing about layout — cells and panels are declared.

## Request flow

`GET http://127.0.0.1:8790/api/<…>` → `main.py` routes it to a `faces.routes` endpoint (or a `ROUTES`-only
capability module) → the adapter validates params, does the work, returns a plain dict or raises
`ToolError`. The CLI face (`yhub <cmd> --json`) returns the identical body, enforced by `web/verify-cli.mjs`; the
MCP face calls the same handlers declared in `faces.mcp`. `main.py` also serves `/api/health`, `/api/tools` and
the SPA fallback (`/apps/*`, `/settings`). Its middleware accepts loopback / `*.localhost` Hosts only,
allowlists Origin on writes, rejects `/api/*` requests carrying a capsule Referer (403), and sets the CSP on
HTML plus `no-store` on `/api/*`. Port `8790` is hardcoded here and in `tauri/tauri.conf.json`.

## Adapter contract

`discover_adapters()` is the only discovery entry point: built-ins via `pkgutil` (real files in both source tree and
wheel), external plugins by file path; `_`-prefixed modules are internals. A module registers by exporting
`TOOL_META` (one tool) / `TOOL_METAS` (several), or only `ROUTES` when it is capability-style (no launcher entry).

```python
TOOL_META = {
    "id": ..., "name": ..., "icon": ..., "description": ..., "ready": bool, "status": str,  # callables allowed
    "faces": {
        "routes": [{"method": "GET", "path": "/api/x", "endpoint": api_x, "params": [...]}],
        "mcp":    [{"name": "x_get", "description": ..., "params": [...], "handler": mcp_x}],
        "cli":    {"command": "x", "help": ..., "subcommands": [...]},
    },
    "presentation": {"tiles": [...]},        # only for adapters declaring wall cells
}
```

Registration reads declarations only, so `main.py` and `yhub/cli/main.py` are never edited to add a tool.
Duplicate MCP names, CLI commands or routes fail at startup with `ValueError`, as does a malformed `params`
declaration; an external plugin that fails to import is skipped with a logged warning. `params.py` defines
the single format (`list[dict]`): `name`, `type` (`str|int|float|bool|list[str]`,
`nullable`), `default`, `required`, `help`, `ge`/`le` (HTTP only), plus face hints — HTTP `in`
(`query`/`body`) and `fields`, CLI `positional`/`nargs`/`choices`/`short`. Failures raise
`ToolError("plain-language error", hint="what to do")`, normalized per face: HTTP `400`
`{ok:false,error,hint}`, CLI exit 1 with the same JSON in `--json` mode, MCP an error result.

## Information wall

`_dashboard_sources.py` is a **registry + aggregator**, not a fetcher:

- **Provenance**: every cell is declared by the plugin that owns it in `presentation.tiles`, and the host
  adds its own aggregate tile. `resolve_specs()` = host tiles ⊕ plugin tiles, then `dashboard.json`
  overrides (applied last, they always win).
- **Fetching** belongs to the declaring plugin: the spec carries a `fetch` name, and the center only batches
  calls and normalizes the returned plain dict.
- **The center keeps** the TTL + single-flight + serve-stale-on-error cache, the tri-state and staleness
  rules, the host tile, and snapshot persistence.

Response: `{ok, generated_at, next_refresh_in, total, count, cells}`; a cell carries `id/zone/order/enabled/
title/status/summary/detail/updated_at/href/stale_after/staleness/age_seconds/source/source_error/
last_attempt_at`. An unreachable source is never `ok` (it degrades to `warn`, then `alert`, with a non-null
`source_error`); `updated_at` advances only on success; credentials are stripped before the response is built.
The host tile `overview.alerts` aggregates across plugins, so a plugin declaring that id collides and fails
loudly. Cell count follows the installed plugins and the scheduler's task table.

## Plugins, shell, data, verification

Core (built-in, shipped, disable-only) and non-core (separate repository, installed into the config root)
plugins share one shape: `plugin.json` holds the declarations, `plugin.py` the code hooks. A bad declaration
raises `ValueError` naming `<id>/plugin.json.<field>`; a `disabled` file in the directory means "not loaded";
non-core plugins may import only the stdlib, what the host ships, or `plugin_api` (see [`plugins.md`](plugins.md)).

`tauri/src/backend.rs` resolves the backend as: reuse one already serving the port → `YHUB_BACKEND_BIN` →
installed `yhub` (PATH, `~/.local/bin`, Homebrew) → `uv run yhub gui`, and only shuts down a backend it
started. The bundle carries no Python: install it with `make install-backend` or `pip install yhub`.

```text
~/.yhub/                    the config root (overrides: config.md)
  settings.json                    settings, written by both sides
  .env                             secrets (YHUB_* prefix; never printed)
  plugins/<id>/, plugins.lock.json, plugins-registry-cache.json   installed plugins, sources, registry index
  logs/                            desktop.log (shell), backend.log (Python)
  dashboard.json, dashboard/snapshots.jsonl   wall overrides and history
  schedule.json, schedule/runs.jsonl          scheduled tasks and run history
  rclone.state.json, rss.json      plugin state
```

```bash
make verify-backend                 # endpoints, cell-producer registry, /api/settings assertions
cd web && node verify-cli.mjs       # three faces agree: MCP tools/list + CLI --json ≡ HTTP body
./tauri/scripts/verify-settings-parity.sh && cd tauri && cargo test config::   # config contract
make verify-plugins && make verify-app                                        # plugin install, installed .app
```
