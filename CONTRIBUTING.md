# Contributing

The architecture and working rules are in [`AGENTS.md`](AGENTS.md). Read it before changing code;
the short version is:

- Capabilities live in `yhub/server/adapters/`; the UI only renders what an adapter declares.
- Add a tool by adding a file; do not change existing tools or `yhub/server/main.py`.
- Keep the HTTP / MCP / CLI faces generated from the same declaration.

## Setup

```bash
uv sync
uv run yhub --help
cd web && npm install
```

## Before opening a pull request

```bash
./scripts/check-versions.sh
cd web && npm run build
cd tauri && cargo test
make verify-backend
make verify-plugins
node scripts/verify-i18n.mjs
```

Use `YHUB_CONFIG_DIR` / `YHUB_SETTINGS_FILE` with a temporary directory when testing; never modify
a real user config. Do not commit `.env`, tokens, build output, or generated capsule files.

## Style

- User-facing text is translated through the centralized catalogs (`web/src/i18n/`,
  `yhub/locales/`); English is the default.
- Comments explain why a constraint exists, not what the next line does.
- Keep documentation current: no historical or migration notes in user-facing docs.

By contributing you agree that your contribution is licensed under the MIT license in
[`LICENSE`](LICENSE).
