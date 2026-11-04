# Third-party components

This file lists the third-party components currently referenced by Y-Hub. It is an inventory, not
a copy of every license text: the authoritative versions and full texts live in the lockfiles and
the installed packages.

## Runtime dependencies (Python backend)

| Package | Declared in | License | Usage |
| --- | --- | --- | --- |
| [FastAPI](https://fastapi.tiangolo.com/) | `pyproject.toml` | MIT | HTTP API |
| [Starlette](https://www.starlette.io/) | transitive | BSD-3-Clause | ASGI toolkit used by FastAPI |
| [Pydantic](https://docs.pydantic.dev/) | transitive | MIT | request/response models |
| [Uvicorn](https://www.uvicorn.org/) | `pyproject.toml` | BSD-3-Clause | ASGI server |
| [uvloop](https://github.com/MagicStack/uvloop) | transitive (`uvicorn[standard]`) | MIT | event loop |
| [httptools](https://github.com/MagicStack/httptools) | transitive (`uvicorn[standard]`) | MIT | HTTP parser |
| [websockets](https://github.com/python-websockets/websockets) | transitive (`uvicorn[standard]`) | BSD-3-Clause | WebSocket support |
| [watchfiles](https://github.com/samuelcolvin/watchfiles) | transitive (`uvicorn[standard]`) | MIT | file watching |
| [Requests](https://requests.readthedocs.io/) | `pyproject.toml` | Apache-2.0 | outbound HTTP in adapters |
| [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) | `pyproject.toml` | MIT | MCP server/client |
| [HTTPX](https://www.python-httpx.org/) | transitive (`mcp`) | BSD-3-Clause | MCP HTTP client |
| [Typer](https://typer.tiangolo.com/) / [Rich](https://rich.readthedocs.io/) | transitive (`mcp[cli]`) | MIT | MCP CLI helpers |
| [jsonschema](https://github.com/python-jsonschema/jsonschema) | transitive (`mcp`) | MIT | schema validation |

The complete resolved set and versions are in [`uv.lock`](uv.lock). Each installed distribution
carries its own license metadata; `pip`/`uv` place those files in the environment's `dist-info`.

## Runtime dependencies (web bundle)

These are bundled into `web/dist` and therefore shipped with the GUI. All are MIT-licensed.

| Package | License | Usage |
| --- | --- | --- |
| [React](https://react.dev/) / React DOM | MIT | UI runtime |
| [react-grid-layout](https://github.com/react-grid-layout/react-grid-layout) | MIT | bento grid layout |
| [@tauri-apps/api](https://github.com/tauri-apps/tauri) | MIT OR Apache-2.0 | desktop IPC bridge |

No web fonts, icon fonts, analytics, or remote UI assets are loaded.

## Bundled capsules

The read-only system capsule layer ships single-file HTML apps. `hello` is built in this repository;
`tiddlywiki.html` is fetched from the upstream official site at build time
(`scripts/build-capsules.sh`, `https://tiddlywiki.com/empty.html`) and is not modified.

| Capsule | Upstream | License | Usage |
| --- | --- | --- | --- |
| [TiddlyWiki](https://tiddlywiki.com/) | official `empty.html` release | BSD-3-Clause | bundled personal wiki capsule (saves copy-on-write into the user library) |

TiddlyWiki's copyright and license text is embedded in the shipped file itself
(`$:/core/copyright.txt`), so the attribution travels with the artifact.

## Runtime dependencies (desktop shell)

The Rust dependencies are compiled into the `.app`; versions are pinned in
[`tauri/Cargo.lock`](tauri/Cargo.lock).

| Crate | License | Usage |
| --- | --- | --- |
| [tauri](https://tauri.app/) | MIT OR Apache-2.0 | desktop shell |
| [tauri-plugin-global-shortcut](https://github.com/tauri-apps/plugins-workspace) | MIT OR Apache-2.0 | global hotkeys |
| [serde](https://serde.rs/) / serde_json | MIT OR Apache-2.0 | IPC and config serialization |
| [plist](https://github.com/ebarnard/rust-plist) | MIT | macOS property lists |
| [dirs](https://github.com/dirs-dev/dirs-rs) | MIT OR Apache-2.0 | config/log directories |
| [base64](https://github.com/marshallpierce/rust-base64) | MIT OR Apache-2.0 | capsule data URLs |
| [objc2](https://github.com/madsmtm/objc2) / objc2-app-kit | MIT | macOS native window integration |
| [tauri-build](https://crates.io/crates/tauri-build) | MIT OR Apache-2.0 | build script |

## Build-time tools (not distributed as code)

| Tool | License | Usage |
| --- | --- | --- |
| [Vite](https://vite.dev/) | MIT | frontend and sample-capsule bundling |
| [vite-plugin-singlefile](https://github.com/richardtallent/vite-plugin-singlefile) | MIT | single-file capsule output |
| [Tailwind CSS](https://tailwindcss.com/) | MIT | generated styles |
| [TypeScript](https://www.typescriptlang.org/) | Apache-2.0 | type checking |
| [Playwright](https://playwright.dev/) | Apache-2.0 | end-to-end tests |

## Artwork

The app icon, menu-bar template image and favicon are original artwork drawn in this repository
(`tauri/icons/source/yhub/`). No third-party icon set is used.

## How license texts are shipped

- Python: the wheel records `License-File`; installed dependencies keep their licenses under
  `site-packages/*.dist-info/licenses/`.
- Rust: full texts are available from each crate in `Cargo.lock`; release builds should include a
  generated notice bundle if required by the distributor.
- The web bundle includes the MIT-licensed React/react-grid-layout code; their copyright notices are
  preserved in the dependency packages and can be regenerated with the frontend lockfile.
