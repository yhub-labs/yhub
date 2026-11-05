English | [简体中文](https://github.com/yhub-labs/yhub/blob/main/README.zh-CN.md)

# Y-Hub

Y-Hub (project name `yhub`, CLI command `yhub`) is a local-first personal information hub. One local backend plus a set of adapters: every capability is declared once and exposed on three faces at the same time — **HTTP API, MCP tool, CLI command** — and usable through a web workbench, an information wall, and a macOS desktop shell.

## Architecture at a glance

```text
yhub/server/adapters/      one file per tool: export TOOL_META and routes + MCP + CLI appear
yhub/server/main.py        FastAPI app: discover adapters → register them → serve the frontend
yhub/server/mcp_server.py  the same adapters over MCP (stdio)
yhub/cli/                  host commands + CLI generated from adapter declarations
web/                       Vite + React + TS UI: launcher, workbench, settings, wall
tauri/                     macOS shell: tray, global hotkey, frameless window (no Python inside)
capsules/                  single-file HTML capsules shipped with the package (built + TiddlyWiki)
```

- Capabilities live in `yhub/server/adapters/`; the UI only renders them.
- The three faces are locked together: `yhub <cmd> --json` returns the same body as the matching HTTP endpoint.
- Wall cells are declared by the plugin that produces them; the center only keeps the registry and aggregation.

Details in [`docs/architecture.md`](https://github.com/yhub-labs/yhub/blob/main/docs/architecture.md) and [`api-contract.md`](https://github.com/yhub-labs/yhub/blob/main/api-contract.md).

## Quick start

```bash
uv sync                      # Python 3.10+, uv installed
uv run yhub --help
uv run yhub gui              # backend + web workbench → http://127.0.0.1:8790
uv run yhub gui --no-open    # server only (--dev: API only, --port N: another port)

uv tool install . --force    # optional: `yhub` on PATH from any directory
```

MCP client setup:

```json
{ "mcpServers": { "yhub": { "command": "yhub", "args": ["mcp"] } } }
```

Frontend development: run `uv run yhub gui --dev` in one terminal and `cd web && npm install && npm run dev` in another (Vite proxies `/api` to 8790). After UI changes run `cd web && npm run build`; the backend serves `web/dist`, and packaging bundles it into the wheel.

## Main commands

| Entry | What it does |
| --- | --- |
| `yhub gui` | backend plus the web workbench on `127.0.0.1:8790` |
| `yhub mcp` | MCP server over stdio |
| `yhub plugin list\|install\|remove\|enable\|disable` | core plugins (shipped, disable-only) and third-party plugins |
| `yhub completion zsh` | shell completion, rendered from the parsed command tree |

Commands declared by core plugins (`rclone`, `rss`, `schedule`) and by whatever third-party plugins are installed on this machine appear in `yhub --help` automatically. The desktop shell binds `Option+Space` to summon the launcher; `make install` places `/Applications/Y-Hub.app`. Config is one file, `~/.yhub/settings.json`, written through the web settings page (`/?view=settings`) or the desktop settings — see [`docs/config.md`](https://github.com/yhub-labs/yhub/blob/main/docs/config.md).

## Extension points

1. **Adapters** — add `yhub/server/adapters/<id>.py` exporting `TOOL_META` (`faces.routes` / `faces.mcp` / `faces.cli`, plus `presentation.tiles` for wall cells). No other file changes.
2. **Capsules** — single-file HTML apps served at `/capsules/<path>` and saved back with `PUT`. TiddlyWiki (downloaded from its official site at build time) ships with the package; a bundled capsule's first save is copied into your writable library, so upgrades never overwrite your edits. See [`docs/capsules.md`](https://github.com/yhub-labs/yhub/blob/main/docs/capsules.md).
3. **Plugins** — third-party adapters installed into the config root with `yhub plugin install <id | owner/repo | path>`; they are not distributed with this repository. Registry format: [`examples/registry.example.json`](https://github.com/yhub-labs/yhub/blob/main/examples/registry.example.json); conventions: [`docs/plugins.md`](https://github.com/yhub-labs/yhub/blob/main/docs/plugins.md).

## Verification

```bash
uv run yhub gui --no-open &          # several checks need a running backend
cd web && npm run build              # type check + build
cd web && npm run smoke              # headless Chrome end-to-end
cd web && node verify-cli.mjs        # MCP tools/list + CLI --json ≡ HTTP body
cd web && node verify-settings-ui.mjs && node verify-edit-mode.mjs
./scripts/check-versions.sh          # Python / frontend / Tauri / Cargo agree
cd tauri && cargo test config::      # config read/write/validation
./tauri/scripts/verify-settings-parity.sh
make verify-backend verify-plugins   # backend endpoints + plugin mechanism
make verify-app                      # installed build end-to-end
```

The backend is not inside the `.app`: the shell launches the installed `yhub`, so after changing Python code run `make install-backend` (or restart the source-mode backend). Packaging, signing and installing: [`docs/packaging.md`](https://github.com/yhub-labs/yhub/blob/main/docs/packaging.md). Next steps: [`docs/roadmap.md`](https://github.com/yhub-labs/yhub/blob/main/docs/roadmap.md).

## License

MIT — see [`LICENSE`](https://github.com/yhub-labs/yhub/blob/main/LICENSE); third-party notices are in [`THIRD-PARTY.md`](https://github.com/yhub-labs/yhub/blob/main/THIRD-PARTY.md).
Contributions: [`CONTRIBUTING.md`](https://github.com/yhub-labs/yhub/blob/main/CONTRIBUTING.md). Security reports: [`SECURITY.md`](https://github.com/yhub-labs/yhub/blob/main/SECURITY.md).

## Documentation

[`AGENTS.md`](https://github.com/yhub-labs/yhub/blob/main/AGENTS.md) · [`CONTRIBUTING.md`](https://github.com/yhub-labs/yhub/blob/main/CONTRIBUTING.md) · [`SECURITY.md`](https://github.com/yhub-labs/yhub/blob/main/SECURITY.md) · [`docs/architecture.md`](https://github.com/yhub-labs/yhub/blob/main/docs/architecture.md) · [`api-contract.md`](https://github.com/yhub-labs/yhub/blob/main/api-contract.md) · [`docs/config.md`](https://github.com/yhub-labs/yhub/blob/main/docs/config.md) · [`docs/plugins.md`](https://github.com/yhub-labs/yhub/blob/main/docs/plugins.md) · [`docs/capsules.md`](https://github.com/yhub-labs/yhub/blob/main/docs/capsules.md) · [`docs/rclone.md`](https://github.com/yhub-labs/yhub/blob/main/docs/rclone.md) · [`docs/gui-development.md`](https://github.com/yhub-labs/yhub/blob/main/docs/gui-development.md) · [`docs/i18n.md`](https://github.com/yhub-labs/yhub/blob/main/docs/i18n.md) · [`docs/packaging.md`](https://github.com/yhub-labs/yhub/blob/main/docs/packaging.md) · [`docs/roadmap.md`](https://github.com/yhub-labs/yhub/blob/main/docs/roadmap.md)
