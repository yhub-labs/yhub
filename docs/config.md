# Config: `~/.config/yhub/settings.json`

## File and config root

`YHUB_SETTINGS_FILE` names the file (its parent is then the config root) → `YHUB_CONFIG_DIR` → `~/.config/yhub`,
identically on both sides. A missing file reads as defaults and is not created until the first write; writes are atomic
(temp + rename), nothing is cached in memory, and secrets live only in `.env` (`YHUB_*`, Python-side, never echoed).

## Ownership and entry points

- **Shell owns** `version`, `hotkeys.*`, `tray.*` (needed at startup); Rust's `save` merges only those and preserves
  every other top-level key verbatim. **Backend owns** the rest (`capsules_*`, `ui_language`, `plugins_registry_url`,
  `plugins`); Python writes only known keys and preserves unknown ones.

| Entry point | How |
| --- | --- |
| Desktop settings page | shell keys via Tauri IPC, all others via `GET/PUT /api/settings` |
| Web settings page (`/?view=settings`), scripts | `GET/PUT /api/settings`, `POST /api/settings/reset` |

Reads are **lenient** (a broken item falls back alone and adds one warning); writes are **strict** (any invalid item → `400`, nothing written).

| Method | Path | Semantics |
| --- | --- | --- |
| `GET` | `/api/settings` | `{ok, path, settings, schema, warnings}`; defaults filled in |
| `PUT` | `/api/settings` | `{"key","value"}` or `{"keys":{…}}`; `null` restores that item's default |
| `POST` | `/api/settings/reset` | `{"key"}` restores one item, no `key` restores the document |

`schema` (`keys`, `hotkey_actions`, `tray_fields`, `close_behaviors`, `click_behaviors`, `defaults`) is what the UI reads.

## Key catalog

Section names (`hotkeys`, `tray`, `plugins`) read and write as a whole; action ids and tray fields are enumerated.

| Path | Type | Default | Validation |
| --- | --- | --- | --- |
| `version` | int | `SETTINGS_VERSION` | program-maintained: `set` errors, reads ignore the on-disk value |
| `hotkeys.toggle_panel` | string | `Option+Space` | combo: ≥1 modifier + exactly 1 key (char, named key, `F1–F24`), unique across actions; `""` = unbound |
| `hotkeys.show_panel`, `hotkeys.hide_panel` | string | `""` | as above |
| `tray.close_behavior` | enum | `hide` | `hide` / `quit` |
| `tray.left_click` | enum | `toggle_panel` | `toggle_panel` / `show_menu` / `none` |
| `tray.double_click` | enum | `none` | same three literals |
| `tray.show_on_start` | bool | `false` | boolean |
| `tray.show_notifications` | bool | `false` | boolean |
| `capsules_dir` | string | `""` | absolute or `~/…`, trailing `/` stripped; empty = no capsule scan |
| `capsules_disabled` | list[str] | `[]` | strings; matched as `source:relpath`, `relpath`, top-level directory or bare name |
| `capsules_subdomains` | bool | `false` | boolean; effective per capsule = `overrides[scope] ?? this` |
| `capsules_subdomains_overrides` | object | `{}` | non-empty string keys, boolean values; written whole |
| `ui_language` | string | `en` | `en` / `zh-CN`; drives UI and error language |
| `plugins_registry_url` | string | `https://raw.githubusercontent.com/yhub-labs/yhub-plugins/main/registry.json` | string; backend-only (marketplace index). The default is the official index; store a different URL to use your own, or an empty string to turn the marketplace off (nothing is fetched, no install by id) |
| `plugins` | object | `{}` | open map: the section and each `plugins.<id>` must be objects |

`capsules_dir` is the library directory scanned by `capsules.py`; `~/Y-Hub/capsules` is created by `POST /api/capsules/ensure` ([`capsules.md`](capsules.md)).

## `plugins.*`: open namespace

The host enforces shape only — `plugins` is an object and each `plugins.<id>` is an object; a broken section is
skipped with a warning on read. Inner keys are outside the catalog: declared fields (the `config` section of
`plugin.json`, or `TOOL_META["config"]` for core plugins) are type-checked (`str`/`bool`/`int`), undeclared keys
accept any JSON value. `plugins.<id>._enabled = false` disables that plugin (a `disabled` file in its directory wins);
a section written as `null` becomes `{}`, a single key as `null` becomes the manifest default. Declarations come from
`GET /api/plugins`, values from `settings.plugins.<id>.<key>`.

## Changing a key

- **Shell key**: add it to `tauri/src/config.rs` (`Settings`, `defaults()`, `get_path`/`set_path`, `known_keys()`,
  `overlay_keys()`, `unknown_keys()`, tests) **and** to `settings.py` (`defaults`/`known_keys`/`default_value`/
  `read_value`/`apply_value`), then run `./tauri/scripts/verify-settings-parity.sh` and `cd tauri && cargo test config::`.
- **Backend key**: change `settings.py` only; the shell's merge-write preserves it. `SETTINGS_VERSION` is
  program-maintained; this codebase carries no migrations for older shapes.

## Broken files and versions

| Case | Behavior |
| --- | --- |
| Not valid JSON / top level not an object | renamed to `settings.json.corrupt-<stamp>.bak`, this run uses defaults |
| One broken item | that item falls back, `warnings` names it |
| Any other `version` | `version` is program-maintained: it is corrected on the next write, and known fields read normally |

## Verification

```bash
./tauri/scripts/verify-settings-parity.sh        # version / enums / hotkey actions / catalog, both sides
cd tauri && cargo test config::                  # defaults, validation, conflicts, env overrides
make verify-backend                              # /api/settings assertions on an isolated config root
cd web && node verify-settings-ui.mjs            # settings page ↔ IPC + /api/settings, end to end
# tests and scripts always use a temporary config root (YHUB_CONFIG_DIR / YHUB_SETTINGS_FILE)
```
