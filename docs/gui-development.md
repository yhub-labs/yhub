# Y-Hub frontend (GUI) development

`web/` is a Vite + React 19 + TS app: `web/dist` is served by the backend and embedded in the Tauri
shell at build time. **The code is authoritative** — this page is the map, not the contract. Module
map/data flow: `docs/architecture.md`; tool inventory: `README.md`.

## Structure

```text
web/
├── vite.config.ts            react + tailwind v4; dev 5173 proxies /api → 127.0.0.1:8790
└── src/
    ├── main.tsx App.tsx      StrictMode → I18nProvider → ErrorBoundary → App (owns URL/view/prefs)
    ├── api.ts tauriBridge.ts /api/* via request(); ApiError{message,hint,kind}; shell IPC behind isTauri()
    ├── panelPrefs.ts wallLayout.ts localStorage prefs; pure bento math (paging, clamping, tiers)
    ├── design.css            design tokens + .ui-* blocks; bento.css aliases them for the grid and
    │                         card shell; theme-light.css overrides tokens + dark-utility bridges
    ├── i18n/                 index.tsx (provider, t) + catalogs/*.ts
    └── components/
        ├── icons/            Icon.tsx (IconName union), ToolIcon.tsx, status.tsx
        ├── cardRegistry.ts Card.tsx  panel inventory + statusTone(); the only card shell
        ├── Launcher.tsx Dashboard.tsx PanelCustomize.tsx ComponentLibrary.tsx
        └── settings/ (registry.tsx, *Section.tsx) and <Tool>.tsx panels
```

## Views and routing

Three views — `launcher`, `workbench`, `settings`; with no deep link the desktop shell lands on the
launcher and a browser on `dashboard`.

| Route | Enters |
| --- | --- |
| `/` | launcher (desktop) / workbench with `dashboard` (browser) |
| `/apps/<id>` (+ `?q=`) | workbench on that tool |
| `/settings?section=<id>` (+ `?view=settings`) | settings, at that section |
| `?view=wall` | full-page wall: workbench with the sidebar collapsed ("open in browser") |

- `App.tsx` is the only writer of the URL (`pushState`); `?tool=` is accepted alongside `/apps/<id>`,
  and deep links open in a new tab instead of navigating the host webview.
- Keys: `Cmd/Ctrl+P` pin, `Cmd/Ctrl+,` settings, `Cmd/Ctrl+K` launcher, `Cmd/Ctrl+\` collapse sidebar;
  `ESC` order: leave edit mode → close customize popover → leave settings → workbench → hide. The
  tray's "Settings…" arrives as the `yhub:open-settings` event carrying a section id.

Menu labels are translated once when the tray is built. Because `ui_language` is a **backend-owned** key
(the settings page persists it through `/api/settings`, and `set_setting` refuses non-shell keys), the
shell never sees the change by itself: the language selector calls the `refresh_shell_language` command,
which re-reads `settings.json` and rebuilds the tray menu in the new language (no restart). The same
resolver, `i18n::lang`, is a total mapping — `en*` → En, `zh*` → ZhCn — so every value the backend accepts
is handled.
- Sidebar = `/api/tools` order (adapter scan order, never re-sort); `dashboard` renders as the fixed
  "Desktop" entry. Ids in `PANEL_TOOLS` render a panel, anything else says "no panel yet". The
  outermost `ErrorBoundary` keeps a render crash visible (text + reload), never a blank page.

## Adding a tool panel

1. `yhub/server/adapters/<id>.py`: `TOOL_META` plus routes/MCP/CLI (contract: `docs/plugins.md`).
2. `api.ts`: types + call function (always through `request()`).
3. `components/<Id>.tsx`, one render line inside the `tool-page` section of `App.tsx`, the id in
   `PANEL_TOOLS`, title/icon keys in `cardRegistry.ts`; add 2–3 assertions to `smoke.mjs`.

Panels only call `api` / `tauriBridge` — no `fetch`, shell commands, `fs`, or hand-built
`127.0.0.1:8790` URLs. Icons are `IconName`s (backend `TOOL_META.icon` too); `ToolIcon` also accepts a single emoji
glyph as a fallback, but new tools should use icon names. A settings section is `settings/<Xxx>Section.tsx` + one entry in
`settings/registry.tsx`; options come from `schema` and writes go through `setKey` / `resetKey`
(never `invoke` directly, never fake a save in browser mode).

## Bento grid (dashboard only)

The grid lives only in `components/Dashboard.tsx`; the workbench is one tool per page, tools have no
size. One paged `react-grid-layout` grid holds cells, icons and folders; `kind` decides their behavior:

- **Cells** — information cards with body text, resizable and content-adaptive.
- **Icons / folders** — app and capsule launchers; freely draggable to any grid slot/page, but locked
  to exactly 1×1 (no size menu or resize handle). New plugins land after existing icons in the
  default shelf packing.

| Item | Value |
| --- | --- |
| Columns | ≥1024px → 12, 640–1023 → 6, <640 → 3 (`wallLayout.ts`, by viewport) |
| Row height / gap | fixed 80px / 12px (`ROW_PX`, `GRID_GAP` = `--bento-gap`); 8px radius |
| Rows per page | `clamp(4..12, (availableH + gap) / (ROW_PX + gap))` |
| Size tiers | cells: `md` 6×2 · `lg` 6×4 · `full` 12×2 (minimum 3×2); icons/folders: fixed `sm` 1×1 |

- Coordinates are stored at the 12-column base and clamped to 6/3 columns when rendering. Default
  placement: `overview.alerts` first (full width), then icons and folders, then `zone: todo`, then
  `zone: status` by `order`; `prefs.layout` entries win. `zone`/`order` no longer render section headers.
  `prefs.dock` was retired together with the old icon strip; icon order is now purely grid placement.
- Paging: `packPages` shelf packing skips the full shelf height; dots appear for >1 page and get a red
  dot when that page holds an alert; swipe ≥60px or drag to the page edge.
- Adaptive height: unsized cells measure content (`Range`) and only grow down, capped at
  `rowsPerPage - y`; a cell with `prefs.sizes[id]` stops adapting — and since `prefs.layout` wins at
  render time, a size change must write both. Fixed 1×1 items are normalized on read and write, so
  stale size/layout values cannot enlarge them.
- Folders hold icons only (`folder:<id>`), members keep their layout entries; dragging an icon onto
  another icon/folder and hovering 600ms merges them into a folder tile. **Edit mode** (drag, remove,
  add, resize, pack) and the **customize popover** (theme, packing, reset) are deliberately separate:
  operations live on the wall, global settings in the popover.
- One `GET /api/dashboard/cells` feeds everything; the next interval comes from `next_refresh_in`
  (15–300s, paused while hidden). Loading state = 5 skeletons (`SKELETON_SPANS`).

## Design system and theme

- Colors, radii, spacing and shadows exist only in `:root` of `design.css`; `bento.css` aliases them.
  The light theme overrides tokens only, plus bridges for dark-only Tailwind utilities — prefer
  `.ui-*` and variables so both themes stay correct. A brand change touches `design.css`,
  `theme-light.css`, `gen_app_icons.py` and `web/verify-favicon-scheme.mjs`.
- Dark by default: `prefs.theme` lands on `<html data-theme>` in a `useLayoutEffect` (no flash).
  Keep it plain: radius ≤8px, no gradients or glows, one primary button per screen, status never by
  color alone. Prefs are browser-local (`yhub.panel.prefs`); the backend knows nothing about them and
  "restore defaults" means `DEFAULT_PREFS`.

## Verification

```bash
uv run yhub gui --no-open &      # serves web/dist — build first
cd web && npm run build && npm run smoke   # tsc --noEmit + vite build, headless Chrome e2e (<main> only)
cd web && node verify-bento-grid.mjs && node verify-bento-qa.mjs && node verify-contrast.mjs
cd web && node verify-edit-mode.mjs && node verify-settings-ui.mjs && node verify-rss.mjs
cd web && node verify-cli.mjs              # MCP tools/list + CLI --json ≡ HTTP body
```

- Env: `YHUB_GUI_URL` (default `http://127.0.0.1:8790/`), `YHUB_CHROME` (local Chrome), `OUT_DIR`
  (bento scripts: screenshots).
- `verify-contrast.mjs` prints a report and sets no exit code: the target is 0 failing spots in all
  10 states (dark/light × wall / tool page / settings / launcher, plus the customize popover) at a
  threshold of 4.5 (3.0 for large text).
- Layout checks assert no page or card-body horizontal overflow, nothing outside the viewport, no real
  clipping, 8px radius, sidebar 256/56px, no console errors. `verify-settings-ui.mjs` stubs
  `__TAURI_INTERNALS__` and asserts IPC command names/argument shapes — extend it with every new
  section or write path. Smoke selects semantic `data-*` hooks, not layout classes.

## Pitfalls

- A fresh worktree has no `web/node_modules` (symlink the main repo's, remove later) and no `web/dist`,
  which `pyproject.toml` force-includes: build before `uv run`, and rebuild before the shell can see a
  frontend change (`web/dist` is embedded at compile time).
- `getBaseUrl()` is same-origin only from `tauri:`/`file:`/5173/1420; other origins fall back to
  `127.0.0.1:8790` and hit CORS — run acceptance on 8790, or `--port 5173` + `YHUB_GUI_URL`. macOS
  ships no `timeout`: bound scripts with playwright/node timeouts.
- `~/.config/yhub/.env` holds secrets (never print); the server is `127.0.0.1`-only, no auth.
