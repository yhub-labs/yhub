# AGENTS.md

The working handbook for agents and newcomers. Product overview: [`README.md`](README.md); module and data-flow details: [`docs/architecture.md`](docs/architecture.md).

## Naming (authoritative)

- **Project `yhub`** / **product `Y-Hub`**: project name for the repository, PyPI distribution, the single top-level package `yhub/`, CLI command, config root `~/.yhub`, environment prefix `YHUB_`; product name for UI copy and prose, `Y-Hub.app`, the signing identity `Y-Hub Local Dev`.
- Keep real service hosts verbatim in code and config; use `example.com` in docs, logs and commits.

## Repository map

| To change… | Go to |
| --- | --- |
| A tool's capability (routes / MCP / CLI / data) | `yhub/server/adapters/<id>.py` |
| Backend startup, adapter discovery, the MCP server, serving the frontend | `yhub/server/main.py`, `yhub/server/adapters/__init__.py`, `yhub/server/mcp_server.py` |
| CLI commands and `--json` output | `yhub/cli/<name>.py`, `yhub/cli/generate.py` |
| Wall cell aggregation and the registry | `yhub/server/adapters/_dashboard_sources.py`, `_cell_fetch.py` |
| Plugin install/remove/registry/update, public plugin API | `yhub/server/adapters/plugin_manager.py`, `plugin_config.py`, `plugin_api.py` |
| Capsule hosting (`/capsules/*`) | `yhub/server/adapters/capsules.py` |
| Config read/write | `yhub/server/adapters/settings.py` (backend), `tauri/src/config.rs` (shell) |
| Frontend UI / API calls / shell bridge | `web/src/App.tsx`, `web/src/components/`, `web/src/api.ts`, `web/src/tauriBridge.ts` |
| Tray, hotkeys, launching the backend | `tauri/src/tray.rs`, `hotkeys.rs`, `backend.rs`, `main.rs` |
| Packaging and acceptance | `pyproject.toml`, `Makefile`, `packaging/`, `web/*.mjs`, `tauri/scripts/verify-*.sh` |

## Two iron rules

1. **Capabilities live in `yhub/server/adapters/`; the UI only renders them.** A shell command, HTTP request or path resolution inside the UI is a bug.
2. **Add tools without touching old tools.** Only new files, plus one rendering line in the content area of `web/src/App.tsx`. `yhub/server/main.py` does not change: adapters are discovered automatically.

## Adding a tool

1. `yhub/server/adapters/<id>.py` exports `TOOL_META`: `id` / `name` / `icon` / `description` / `ready` / `status`, plus `faces` (`routes`, `mcp`, `cli`) and `presentation.tiles` when it produces wall cells.
2. `web/src/api.ts`: add types and the calling function.
3. `web/src/components/<Id>.tsx` + one rendering line in `App.tsx`.
4. Raise failures as `ToolError("human-readable error", hint="what to do")`; to reuse CLI logic import it (`from yhub.cli.xxx import …`), never copy it. Parameters use the shared format in `yhub/server/adapters/params.py`; the three faces are locked by `cd web && node verify-cli.mjs` (`--json` body ≡ HTTP body). A module may also declare only `ROUTES` (capability-style, no launcher entry).

## Wall cells

Declare one entry in the adapter's `presentation.tiles`: `id` / `zone` / `order` / `title` / `href` / `stale_after` / `source` / `group` / `refresh` / `fetch`. The producer declares its own cells; `_dashboard_sources.py` only registers and aggregates. `overview.alerts` is the host notification tile (always on page 1) — declaring the same id is a collision and fails loudly. A failed fetch must surface `source_error` + `hint`, never fake green.

## Plugins

**Core** plugins are the built-in adapters that declare `TOOL_META` (`rclone`, `rss`, `scheduler`): shipped with the software, disable-able, never removable. **Third-party** plugins live in the separate repository `yhub-labs/yhub-plugins` and are installed into the config root with `yhub plugin install <id | owner/repo | path>`. The authoritative classification is whatever `yhub plugin list` prints. Cell counts and tool counts vary with what is installed — never hardcode them.

**Panels for third-party tools live with the plugins** (`yhub-labs/yhub-plugins/<id>/panel/`), not here: the host has no dynamic panel loader, so an installed plugin tool shows the "no panel yet" placeholder. `presentation.panel` is accepted by the loader and read by nothing — adding a loader is a roadmap item (`docs/roadmap.md` P1), not a per-tool change.

## Capsules

Point `settings.json: capsules_dir` at a directory of single-file HTML apps: they are served verbatim at `/capsules/<path>` and a `PUT` saves back to disk. The scan is the only truth about *which* capsules exist; `POST /api/capsules/import` (front door, creates the library on demand) and `capsules.json` (declared name/icon/description/order, data layer in `_capsules_import.py`) only add and decorate — never gate. Isolation has two layers: per-capsule CSP (`capsules.page_csp()`) and the `Referer`-based `_scope_denied()` check; `/api/*` returns 403 for capsule referers. Keep both when changing `/capsules/*` (asserted in `packaging/verify-backend.sh`). Contract: [`docs/capsules.md`](docs/capsules.md).

## Data root

Everything lives in `~/.yhub` (settings, state, plugins, logs, default `capsules/`) — one folder to back
up or carry to another machine. It is only ever changed through `config_dir()` on both sides
(`tauri/src/config.rs` and `yhub/server/adapters/settings.py`, which must keep the same fallbacks:
`YHUB_SETTINGS_FILE` > `YHUB_CONFIG_DIR` > `~/.yhub`). There is deliberately **no migration** of the
old `~/.config/yhub` root (no users to carry), and the env overrides must keep bypassing any default
so tests never touch the real home.

## Config keys: decide ownership first

Both entry points write `~/.yhub/settings.json` through `/api/settings`: the desktop settings page and the web settings page (`/?view=settings`).

- **Shell-owned** (needed at startup): `version` / `hotkeys.*` / `tray.*` → change `tauri/src/config.rs` **and** `yhub/server/adapters/settings.py`, then run `./tauri/scripts/verify-settings-parity.sh` and `cd tauri && cargo test config::`.
- **Backend-owned**: everything else → change `settings.py` only (`defaults` / `known_keys` / validation); the shell's save merges only its own keys and preserves the rest.

Catalog in [`docs/config.md`](docs/config.md). Always go through `settings.py`.

## Acceptance (don't just run the build)

```bash
uv run yhub gui --no-open &      # backend for the checks below
cd web && npm run build          # type check + build
cd web && npm run smoke          # headless Chrome end-to-end (asserts read <main> only)
cd web && node verify-cli.mjs    # MCP tools/list + CLI --json ≡ HTTP body
cd web && node verify-bento-grid.mjs && node verify-bento-qa.mjs && node verify-contrast.mjs
cd web && node verify-settings-ui.mjs && node verify-edit-mode.mjs
cd web && node verify-tiddlywiki-save.mjs   # 随包 TiddlyWiki 自动保存（自起测试后端）
cd tauri && cargo build          # after changing tauri/ (build the frontend first)
./scripts/check-versions.sh
make verify-backend verify-plugins verify-settings
make wheel install-backend       # wheel, then the `yhub` the shell launches
make install verify-app          # /Applications/Y-Hub.app, then installed-build e2e
```

New tools add 2–3 assertions to `web/smoke.mjs`.

## Hard constraints and pitfalls

- `~/.yhub/.env` holds secrets: values never appear in output, logs, docs or commits. The server listens on `127.0.0.1` only and has no authentication.
- The backend is **not** inside the `.app`: the shell tries "reuse 8790 → `YHUB_BACKEND_BIN` → PATH/`~/.local/bin/yhub` → `uv run yhub`". Python changes need `make install-backend` (it clears the uv cache first, otherwise the cached wheel is reused silently).
- Installing only via `make install` (`packaging/install-app.sh`); manual `rm -rf` + `ditto` skips archiving, signature verification and cleanup.
- Run tests with `YHUB_CONFIG_DIR` / `YHUB_SETTINGS_FILE` pointed at a temporary directory — never touch the real user config.
- Port 8790 is hardcoded in four places (CSP / `SECURITY_CSP` / `FALLBACK_BASE_URL` / `DEFAULT_PORT`); another backend holding 8790 hijacks both the UI and the shell.
- Scripts that launch the App share `/tmp/yhub-app-test.lock`: never bypass it or run them concurrently. macOS has no `timeout`; don't add it to scripts.
- Never add a `plugins` block to `tauri.conf.json` (it panics at startup). Keep the single top-level Python package `yhub/`.

## Docs index

[`docs/architecture.md`](docs/architecture.md) · [`api-contract.md`](api-contract.md) · [`docs/config.md`](docs/config.md) · [`docs/plugins.md`](docs/plugins.md) · [`docs/capsules.md`](docs/capsules.md) · [`docs/rclone.md`](docs/rclone.md) · [`docs/gui-development.md`](docs/gui-development.md) · [`docs/i18n.md`](docs/i18n.md) · [`docs/packaging.md`](docs/packaging.md) · [`docs/roadmap.md`](docs/roadmap.md) · [`THIRD-PARTY.md`](THIRD-PARTY.md)
