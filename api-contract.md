# The Y-Hub three-face contract (HTTP / MCP / CLI)

Every external interface comes from one declaration: `TOOL_META` in `yhub/server/adapters/<id>.py`
(built-in) or `~/.config/yhub/plugins/<id>/plugin.json` (third-party). Routes, MCP tools, CLI
commands and dashboard cells are generated from it; adding a tool never edits `yhub/server/main.py`.

## 1. Three faces, one declaration

```text
TOOL_META.faces.routes        → FastAPI routes    (/api/…, registered by main.py)
TOOL_META.faces.mcp           → MCP tools         (yhub mcp, stdio, tools/list)
TOOL_META.faces.cli           → CLI commands      (yhub <cmd>, -j/--json, completion)
TOOL_META.presentation.tiles  → dashboard cells   (provenance + fetch)
```

All faces take parameters from one `params` list (`yhub/server/adapters/params.py`), and a CLI leaf's
`--json` output **is** the HTTP body of its route (locked by `web/verify-cli.mjs`).

## 2. Baseline

| Item | Value |
|---|---|
| Base URL | `http://127.0.0.1:8790` (`yhub gui --port` changes it; Vite proxies `/api` in `--dev`) |
| Listener | `127.0.0.1` only, no auth: same machine + same origin is the trust boundary |
| Host gate | `Host` must be loopback or `*.localhost`, else `400` (DNS-rebinding guard) |
| CORS | `localhost:5173`, `127.0.0.1:5173`, `tauri://localhost`, `http://tauri.localhost` |
| Headers | `/api/*` → `Cache-Control: no-store`; all → `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`; `text/html` → CSP |
| Time zone | ISO-8601 with the machine's local offset (POSIX `TZ` honoured), second precision |
| Docs | `GET /api/docs` (Swagger), `GET /api/openapi.json`; on conflict this document wins |
| Frontend | `web/dist` mounted at `/` when built; `/settings` and unknown `/apps/*` fall back to `index.html` |

## 3. Errors

`ToolError("message", hint="what to do")` on every face:

| Face | Behaviour |
|---|---|
| HTTP | `400` + `{"ok":false,"error":"…","hint":"…"}` (`main.py` exception handler) |
| CLI `--json` | exit `1` + the same JSON on stdout |
| CLI human | exit `1`, `× <message>` + `  <hint>` |
| MCP | the tool's return value `{"error":"…","hint":"…"}` |

| Code | When |
|---|---|
| `200` | normal, including "source unreachable / data stale" (that is cell content, not an error) |
| `204` | `PUT`/`DELETE /capsules/*` succeeded |
| `400` | invalid parameters or business validation (`ToolError`) — also for missing jobs/feeds/remotes |
| `403` | cross-origin write; `/api/*` reached from a capsule; capsule subdomain calling the host API |
| `404` / `405` | unknown dashboard cell/snapshot or capsule path; write method on a read-only path, or deleting a capsule entry html |
| `412` / `413` | `If-Match` mismatch on `PUT /capsules/*`; capsule page over 32 MiB or the sandbox file cap |
| `500` | unexpected exception (standard body, never a stack trace) |

## 4. Declaration anatomy

`params` — `{"name","type","default","required","help","ge","le"}`; `type` is
`str|int|float|bool|list[str]`, `in: "body"` entries carry `fields`, CLI adds `positional|nargs|choices|short`.
Path parameters (`{cell_id}`, `{relpath:path}`) come from the route template; unknown keys fail loudly.

`TOOL_META` — required `id` (`^[a-z0-9][a-z0-9-]{0,63}$`), `name`, `icon`, `description`, `ready`,
`status`; optional `keywords`, `faces`, `presentation`, `config` (values at
`settings.plugins.<id>.<key>`). Third-party manifests also need `trust` (`full|sandbox`),
`enable.default` and `schema: 2`.

`presentation.tiles` — one entry per wall cell; `id`, `zone` (`todo|status`), `order`, `title`
(≤16 chars), `href`, `stale_after`, `source`, `group`, `refresh`, `fetch` are required; `critical`,
`enabled`, `params`, `span`, `page` are optional. `overview.alerts` is host-reserved; built-ins may
pass a callable (`scheduler` produces one cell per job).

## 5. Host endpoints

`GET /api/health` → `{"ok":true,"version":"0.1.0","service":"Y-Hub GUI"}`. `GET /api/tools` →
`{"ok":true,"tools":[{"id","name","icon","description","ready","status","keywords"?}]}`; the
declaration's `ready`/`status` resolve per request.

## 6. Settings (`settings.py`)

File `~/.config/yhub/settings.json` (`YHUB_CONFIG_DIR` / `YHUB_SETTINGS_FILE` override for tests). Keys:
`version`, `hotkeys.{toggle_panel,show_panel,hide_panel}`,
`tray.{close_behavior,left_click,double_click,show_on_start,show_notifications}`, `capsules_dir`,
`capsules_disabled`, `capsules_subdomains`, `capsules_subdomains_overrides`, `plugins_registry_url`, `plugins_marketplace`,
`ui_language`, `plugins` — the dotted paths `tauri/src/config.rs` uses.

| Method | Path | Input | Response |
|---|---|---|---|
| GET | `/api/settings` | — | `{"ok","path","settings","schema","warnings"}` |
| PUT | `/api/settings` | `{"key","value"}`, `{"keys":{…}}`, or `value:null` = default | `{"ok","path","settings","changed":[keys],"warnings":[]}` |
| POST | `/api/settings/reset` | `{"key": "…"}`, `{}` = everything | `{"ok","path","settings","reset":"<key or *>"}` |

`schema` = `{version, keys:[dotted…], hotkey_actions, tray_fields, close_behaviors, click_behaviors,
defaults}`. Reads are lenient (a broken value falls back per key into `warnings`); writes validate
everything first and write atomically — one bad item writes nothing.

## 7. Plugins (`plugin_config.py`)

Core plugins are the built-in adapters (`rclone`, `rss`, `scheduler`); everything else lives in
`~/.config/yhub/plugins/<id>/`. Counts always follow what is installed.

| Method | Path | Input | Response |
|---|---|---|---|
| GET | `/api/plugins` | — | `{"ok","plugins":[{"id","name","icon","config":[…],"tiles":[cell ids]}]}` |
| GET | `/api/plugin-inventory` | — | `{"ok","plugins":[{"id","name","icon","description","kind","version","installed","enabled","uninstallable","source"}],"config_dir","registry_url"}` |
| GET | `/api/plugin-catalog` | `q`, `refresh` | `{"ok","plugins":[entry + installed, installed_version, update_available, source],"registry_url"}` |
| GET | `/api/plugin-updates` | — | `{"ok","updates":[{"id","source","installed_version","latest_version","update_available"}]}`; `POST /api/plugin-update` with `{"id"}` or `{"all":true}` → `{"ok","updated":[…],"skipped":[{id,reason}]}` |
| POST | `/api/plugin-install` | `{"spec"\|"id"\|"path", force?, ref?}` | `{"ok","id","version","source","restart_required"}` |
| POST | `/api/plugin-remove` | `{"id", purge?}` | `{"ok","id","installed":false,"purged_config","path"}` |

`config` is the declaration only (defaults + help); current values come from `GET /api/settings`.
Install / remove / enable / disable apply **immediately** in the serving process: the backend rebuilds
its routes and `/api/tools` in place, so `restart_required` is `true` only when no live registry was
rebuilt (a CLI install while the GUI runs; also on a broken declaration, which keeps the previous
registry and logs). Core plugins are disable-able but not removable, `plugin-catalog` is 400 without a
registry, and `enable`/`disable` use `plugins.<id>._enabled` (`yhub plugin enable|disable <id>`).

## 8. Dashboard (`dashboard.py` → `_dashboard_sources.py`)

| Method | Path | Input | Response |
|---|---|---|---|
| GET | `/api/dashboard/cells` | `zone`, `status`, `staleness`, `enabled`, `source`, `ids` (≤50, comma), `limit` (1–200, def 200), `offset` (≥0) | `{"ok","generated_at","next_refresh_in","total","count","cells":[Cell]}` |
| GET | `/api/dashboard/cells/{cell_id}` | — | `{"ok","generated_at","cell":Cell}`; unknown → 404 |
| GET | `/api/dashboard/snapshots` | `limit` (1–200, def 30), `before` (cursor id), `flagged` | `{"ok","snapshots":[{"id","captured_at","cell_count","totals":{ok,warn,alert},"flagged"}],"has_more"}` |
| GET | `/api/dashboard/snapshots/{snapshot_id}` | — | `{"ok","snapshot":{…, "cells":[Cell]}}`; unknown → 404 |

Ordering is fixed: `zone` (`todo` first) → `order` → `id`. Snapshots are `sn_YYYYMMDDTHHMMSS`, written
only by the list route (`snapshot_interval`, 60–3600 s, default 300), keeping 14 days / 2000 entries.

`Cell` required fields (a missing one raises `ToolError`, never a half cell): `id`, `zone`, `order`,
`enabled`, `title`, `status` (`ok|warn|alert`), `summary` (clipped to 80 chars), `detail`
(`[{text,href?}]`, ≤5; `overview.alerts` uncapped), `updated_at`, `href`, `stale_after`, `source`.
Server-computed: `staleness` (`fresh` < T, `stale` < 3T, `expired` ≥ 3T), `age_seconds`, `source_error`
(`{message,hint}` or null), `last_attempt_at` (absent until a fetch was attempted).

Rules: a failed fetch is never `ok` (`warn`, then `alert` on ≥2 failures or `critical: true`) and must
set `source_error`; `updated_at` advances only on success; `staleness` is server-side and non-fresh
cells are never better than `warn`; `overview.alerts` takes the most severe upstream state and lists
every non-`ok`/non-fresh cell; credentials never reach a response (userinfo stripped from `href`, query
strings from `source`). A `fetch(specs) -> {cell_id: result}` returns
`{"ok":true,"status","summary","detail","updated_at"}` or `{"ok":false,"error":{"message","hint"}}`;
a malformed result downgrades only that cell. Groups share one cache entry (TTL = `refresh`,
single-flight, serve-stale-on-error). `~/.config/yhub/dashboard.json` overrides `enabled`, `zone`,
`order`, `title`, `href`, `stale_after`, `critical` and any declared `params` key per cell; invalid
values fall back.

## 9. Capsules (`capsules.py`)

`settings.json: capsules_dir` holds single-file HTML apps (plus the bundled read-only `system` layer).
Every `.html`/`.htm` is a capsule; no manifest, no import step.

| Method | Path | Input | Response |
|---|---|---|---|
| GET | `/api/capsules` | — | `{"ok","capsules":[{"id","relpath","name","path","source","writable","enabled","url_path","bytes","mtime","title","icon","description","scope","subdomains","url"}],"capsules_dir","system_capsules_dir","capsule_roots","max_capsules","max_bytes","configured","problem","problem_detail","configured_path","recommended_dir"}` |
| POST | `/api/capsules/ensure` | `{"path"?}` (absolute or `~/…`, default `~/Y-Hub/capsules`) | `{"ok","capsules_dir","stored","created","recommended"}` (mkdir -p + writes the key) |
| POST | `/api/capsules/toggle` | `{"id"}` or `{"source","relpath"}`, `enabled` | `{"ok","id","enabled","capsules_disabled"}` |
| GET/HEAD/OPTIONS/PUT/DELETE | `/capsules/{relpath:path}` | — | page or sandbox data file (see below) |

Pages: `GET` returns the entry html verbatim (`no-store`, `ETag`, capsule CSP with `'unsafe-eval'`);
`HEAD` gives headers only; `OPTIONS` returns 200 + `DAV: 1`; `PUT` overwrites the entry file (**never
creates**) or writes a sandbox data file (creates, parents included) → 204 + new `ETag`; `DELETE`
removes sandbox data files only (entry html → 405). `/capsules/pinyin` resolves to `pinyin.html` →
`pinyin.htm` → `pinyin/index.html` → `pinyin/pinyin.html` (trailing slash = directory index; an
explicit path always works).

Boundaries: dot-prefixed entry segments and `..` are rejected, symlinks leaving the root count as
missing, `MAX_APPS = 200`, `MAX_BYTES = 32 MiB`, `MAX_SANDBOX_FILES = 2000`, writes are atomic and keep
permission bits. Isolation has two layers: the per-capsule CSP and the `Referer`/`Sec-Fetch` check —
`/api/*` from a capsule is 403, and `<scope>.localhost` reaches only its own `/capsules/*`.

## 10. Scheduler (`scheduler.py`)

Jobs live in `~/.config/yhub/schedule.json` (hand-edited: `{"enabled","tick_seconds","jobs":[…]}`,
`command` as an argv array, `schedule` = `{"every","at"}` or `{"cron"}`, `timeout_seconds` ≤ 3600).

| Method | Path | Input | Response |
|---|---|---|---|
| GET | `/api/scheduler/jobs` | — | `{"ok","enabled","tick_seconds","started","config_path","runs_path","now","jobs":[JobView]}` |
| GET | `/api/scheduler/runs` | `job`, `limit` (1–200, def 20) | `{"ok","runs":[RunRecord]}` |
| POST | `/api/scheduler/jobs/{job_id}/run` | — | `{"ok","run":RunRecord,"job":JobView}` (a failed job is still 200) |
| GET | `/api/scheduler/jobs/{job_id}/report` | — | the job's HTML (`text/html`); missing/not `.html`/over 2 MiB → 400 |
| GET | `/api/scheduler/daemon` | — | `{"ok","platform","backend","installed","active","target","config_path","message"}`; `POST …/daemon/install` and `…/daemon/uninstall` return the same shape (`launchd` / `systemd` / `schtasks`) |

`JobView`: `id`, `title`, `description`, `schedule`, `enabled`, `critical`, `ready`, `ready_reason`,
`status`, `summary`, `detail`, `updated_at`, `next_due`, `last_run`, `fail_streak`, `href`, `report`,
`source_error`. `RunRecord`: `job`, `trigger` (`schedule|manual|cli`), `status` (`ok|fail|timeout|error`),
`started_at`, `finished_at`, `duration_ms`, `exit_code`, `timed_out`, `error`, `out_tail` (failure only).
Each job also produces the cell `cron.<id>`.

## 11. RSS (`rss.py`)

Feeds live in `~/.config/yhub/rss.json`; one feed = one cell `rss.<id>`.

| Method | Path | Input | Response |
|---|---|---|---|
| GET | `/api/rss` | `live` (`true` default; `false` = cache only) | `{"ok","feeds":[Feed],"total","refresh","config_path","live"}` |
| POST | `/api/rss/feeds` | `{"url", id?, title?, limit? (1–20), enabled?}` | `{"ok","saved":true,"feed":Feed}` |
| DELETE | `/api/rss/feeds/{feed_id}` | — | `{"ok","removed","total"}` |
| POST | `/api/rss/feeds/{feed_id}/refresh` | — | `{"ok","feed":Feed}` (bypasses the cache) |
| GET | `/api/rss/items` | `feed_id` (required), `limit` (1–20) | `{"ok","feed","title","site","fetched_at","items":[{"title","href","published_at","published_text"}]}` |

`Feed`: `id`, `title`, `url`, `enabled`, `limit`, `items`, `site`, `fetched_at`, `error` (`{message,hint}`
or null). Posting an existing `id` updates that feed in place (cell position kept); an unreadable feed
is still saved and shows as a `warn` cell with `source_error` — only a parameter error is 400.

## 12. Rclone (`rclone.py`)

| Method | Path | Input | Response |
|---|---|---|---|
| GET | `/api/rclone` | — | `{"ok","rclone":{installed,path,version,config,config_exists},"mount_root","state_path","vfs_cache_mode","remotes":[Remote],"mounts":[MountRecord],"untracked","watcher","checked_at","mount_table"}` |
| POST | `/api/rclone/mount` | `{"name", mountpoint?, password?, read_only?, allow_non_empty?, extra?}` | `{"ok","mounted":MountRecord,"status":{…}}` |
| POST | `/api/rclone/umount` | `{"name"}` | `{"ok","name","mountpoint","steps","mounted":false,"status":{…}}` |
| POST | `/api/rclone/probe` | `{"name"}` | `{"ok","probe":{ok,names,files,dirs,total,free,error,at,took_ms,running,stuck_seconds?},"status":{…}}` |

A password travels only in the body and reaches rclone once — never in argv, on disk, or in a response
(`stored_secret` only reports whether the config has one); MCP deliberately exposes no
mount-with-password action. Unmounting/probing something not mounted → 400 `no mount record for <name>`.

## 13. MCP and CLI faces

`uv run yhub mcp` (stdio) exposes core tools `rclone_status`, `rclone_probe`, `rclone_umount`,
`rss_list`, `rss_add`, `rss_remove`, `rss_items`; installed third-party plugins append theirs
(`memos_list`, `zdic_lookup`, `sp_tasks_today`, …). Tool names are unique process-wide (duplicates
fail at startup); `tools/list` is authoritative.

| Command | Source | Leaves |
|---|---|---|
| `gui`, `mcp`, `completion`, `plugin` | hand-written (`yhub/cli/main.py`) | `gui --port --no-open --dev`; `completion zsh\|bash`; `plugin list\|search\|info\|install\|remove\|update\|enable\|disable\|registry` |
| `rclone` / `rss` / `schedule` | `faces.cli` of the matching adapter | `list\|status\|mount\|umount\|probe` / `list\|add\|remove\|refresh\|items` / `list\|run\|tick\|daemon` |

Every declared leaf has `-j/--json` (before or after the leaf). Exit codes: `0` success, `1`
`ToolError`, `2` argparse usage error. Completion scripts are rendered from the parse tree.
`zdic`, `memos`, `sp` and `chrome-doctor` come from third-party plugins when installed; they are not part of the core contract.
A third-party tool has no host panel: the page shows the "no panel yet" placeholder until the host grows a
dynamic panel loader (panels live with the plugins, see `yhub-labs/yhub-plugins` `docs/panels.md`).

## 14. Verification

```bash
uv run yhub gui --no-open &                 # backend for the checks below
cd web && node verify-cli.mjs               # MCP tools/list + CLI --json ≡ HTTP body
cd web && npm run build && npm run smoke    # type check, build, headless end-to-end
make verify-backend verify-plugins verify-settings
```

Point `YHUB_CONFIG_DIR` at a temporary directory whenever settings are written; use `--noproxy '*'`
on every curl and `curl -G --data-urlencode` for non-ASCII query parameters.
