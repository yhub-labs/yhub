# Plugins

A plugin = one directory + `plugin.json` (declaration) + `plugin.py` (code). The **three faces** (HTTP routes / MCP tools / CLI commands) and the **dashboard tiles** are generated from the declaration; no host file has to change. Built-in adapters are loaded by the same discovery function, so "core" is just "the plugin lives in the package".

## 1. Kinds and location

| Kind | Where | Install / remove | Notes |
| --- | --- | --- | --- |
| **core** | `yhub/server/adapters/<id>.py` (in the wheel) | never installable/removable; **disable only** (`plugins.<id>._enabled=false`) | `rclone`, `rss`, `scheduler` (the wall `dashboard` is a host capability, not a plugin) |
| **non-core** | source: `yhub-labs/yhub-plugins`; effective copy: `<config>/plugins/<id>/` | `yhub plugin install/remove` | not shipped in this repo or the wheel |

The config root is `YHUB_CONFIG_DIR` (default `~/.config/yhub`).

```text
<config>/plugins/<id>/
├── plugin.json     # declaration: id/name/icon/description/trust/enable/kind/faces/presentation/config
├── plugin.py       # code: TOOL_META hooks (ready/status) + handlers + fetch functions
└── disabled        # optional: present = not loaded (escape hatch, outranks the config switch)
```

Load semantics: `plugin.json` is re-read on every discovery (edit → next request picks it up); `plugin.py` is exec'd once per process (code changes need a backend restart; a failed import is cached and warned once). Directory name must match `^[a-z0-9][a-z0-9-]{0,63}$`, equal `id`, and not start with `.`/`_`.

## 2. `plugin.json` (schema 2)

| Key | Type | Semantics |
| --- | --- | --- |
| `schema` | `2` | only schema 2 is accepted; `version`/`min_yhub`/`api` are part of it |
| `version` | `x.y[.z]` | **required at schema 2**; used for update comparison |
| `min_yhub` / `api` | string / int | below host version, or `api` > `1`: not loaded |
| `author` / `homepage` / `license` | string | metadata for the marketplace |
| `id` | string | `^[a-z0-9][a-z0-9-]{0,63}$`, **must equal the directory name** |
| `name` | string | display name, ≤30 chars |
| `icon` | string | icon name from `web/src/components/icons/Icon.tsx` (a single emoji/glyph is also accepted), ≤32 |
| `description` | string | one line, ≤120 chars, shown in `/api/tools` |
| `keywords` | string | launcher search words, **one space-separated string** |
| `trust` | `"full"` \| `"sandbox"` | **required**; label only — no isolation either way |
| `enable` | `{"default": bool}` | default enabled; config switch and `disabled` file outrank it |
| `kind` | `"core"` \| `"third-party"` | default `third-party`; `core` makes `plugin remove` refuse |
| `faces` | object | `routes` / `mcp` / `cli`, each optional (§3) |
| `presentation` | object | `launcher` (bool, type-checked only), `icon`, `tiles` (§4), `panel` (accepted, **not read** — see §4.1) |
| `config` | array | `[{key, type, default, help}]` for `plugins.<id>.*` (§5) |

Any key not in this table is an error (`ValueError` naming `<id>/plugin.json.<field>`) — typos are never ignored. One directory = one tool: `TOOL_METAS` (batch) is rejected.

## 3. The three faces

`faces.*.handler` and `tiles[].fetch` are **function names in `plugin.py`**, resolved to callables at load; unresolved = `ValueError` with the location.

**params** (shared by all faces, `yhub/server/adapters/params.py`), `list[dict]`:

| Key | Faces | Notes |
| --- | --- | --- |
| `name` / `type` | all | identifier, unique per face; `str`/`int`/`float`/`bool`/`list[str]` |
| `default` / `required` / `help` | all | optional params need a `default` (CLI positionals excepted); `required: true` + `default` is an error |
| `ge` / `le` / `nullable` | all | bounds (HTTP validation only), Optional wrap |
| `in` / `fields` | HTTP | `query` (default) or `body`; a `body` item carries `fields` instead of `type` |
| `positional` / `nargs` / `choices` / `short` | CLI | positional args, `*`/`+`/`?`, enum, short flags |

**routes** — `{"method", "path", "handler", "params"}`; method in GET/POST/PUT/DELETE/HEAD/OPTIONS, path starts with `/`. Path params (`{id}`) are extracted from the template automatically — don't declare them. The endpoint's `__signature__` is rewritten from `params` (FastAPI binds/validates from it). Two plugins on the same method+path = startup `ValueError`.

**mcp** — `{"name", "description", "handler", "params"}`; name `^[a-z0-9][a-z0-9_-]{0,63}$`, description required (goes into `tools/list`), unique across plugins. With `params`, the signature is generated; without, the function's own signature is used.

**cli** — `{"command", "help", "handler", "params", "subcommands"}`; either a face-level `handler` or `subcommands`, each subcommand with its own `handler`. Every leaf gets `-j/--json` automatically, and shell completion words are generated from these declarations. Handler convention: returning `int` = exit code (you printed the text); returning `dict`/`list` = the generator prints JSON; if the signature has `json_out`, `--json` is passed in. **`--json` output must equal the HTTP body** (feed one shared view function to both faces).

Raise `ToolError("plain language", hint="what to do")` — it is translated per face (HTTP 400 `{ok:false,error,hint}`, CLI stderr + exit 1, MCP error result). Anything else becomes a 500; funnelling low-level exceptions is the plugin's job.

## 4. Dashboard tiles: `presentation.tiles`

Tiles are the **first-class producers** of wall cells; the center only does registry + TTL cache + aggregation.

| Field | Req | Semantics |
| --- | --- | --- |
| `id` | ✅ | `^[a-z0-9][a-z0-9._-]{0,63}$`, unique across all plugins |
| `zone` | ✅ | `todo` \| `status` (primary sort key) |
| `order` | ✅ | int ≥0, sort within the zone |
| `title` | ✅ | ≤16 chars |
| `href` | ✅ | deep link (userinfo stripped) |
| `stale_after` | ✅ | seconds |
| `source` | ✅ | source id = `?source=` filter key |
| `group` | ✅ | fetch set: one TTL cache + single flight per group |
| `refresh` | ✅ | group refresh interval / cache TTL (first spec in the group wins) |
| `fetch` | ✅ | function name in `plugin.py` (built-ins may pass a callable) |
| `critical` | ❌ | one failure → `alert` (otherwise ≥2 in a row) |
| `enabled` / `span` / `page` / `params` | ❌ | off-screen flag, `sm/md/lg/full`, default page, fetch params |

### 4.1 `presentation.panel` — declared but not loaded

The loader accepts the key and the host ignores it: a third-party tool page renders the "no panel yet"
placeholder. Panels for `zdic` / `memos` / `gemini` used to ship here and now live with the plugins
(`yhub-labs/yhub-plugins/<id>/panel/`, contract in that repo's `docs/panels.md`). The host needs a panel
registry (or an iframe contract like capsules) before a plugin can supply its own page.

`cells.<id>.*` in `dashboard.json` always wins last (`enabled/zone/order/title/href/stale_after/critical` + same-named `params` keys).

**fetch contract** — plain dict keyed by tile id (`specs` = the tiles of this group sharing this fetcher):

```python
def fetch_x(specs):
    cid = specs[0]["id"]
    return {cid: {"ok": True, "status": "ok",            # ok | warn | alert
                  "summary": "3 open · 1 due",            # clipped to 80 chars
                  "detail": [{"text": "…", "href": "…"}], # ≤5 rows on screen
                  "updated_at": 1727770000.0}}            # optional epoch seconds
    # failure: {cid: {"ok": False, "error": {"message": "…", "hint": "…"}}}
```

* A tile id missing from the result = that cell failed. Bad shape / illegal `status` / non-numeric `updated_at` degrades **only that cell** (human `source_error` + one log line).
* `fetch` raising fails **the whole group** ("source unreachable"); the endpoint still returns 200. Convert network errors into a dict/ToolError.
* Staleness: `age < stale_after` fresh, `< 3×` stale, beyond expired (summary gets "(data is stale)", status ≤ `warn`). A missing `updated_at` means "just read"; on failure the last success is kept.
* `group == "probe"` with `params.probe_url`: `source` becomes `probe:<url>` and `href` follows it.
* `overview.alerts` is the host notification tile (page 1, aggregates worst upstream) — declaring it = `ValueError`.

## 5. `plugin.py` and config

```python
from yhub.plugin_api import ToolError   # only public host module for external plugins

def fetch_x(specs): ...                 # tiles[].fetch / faces.mcp[].handler / faces.cli leaf
TOOL_META = {"ready": _ready, "status": _status}   # code hooks only — nothing else
```

* `TOOL_META` knows only `ready` / `status` (callable or str/bool; anything else = `ValueError`); write `TOOL_META = {}` when you have no hooks (falls back to ready/ready). They must not raise (that would 400 `/api/tools`) — return `(False, "plain language — what to do")` instead.
* Dependencies: stdlib + what the host already ships (`fastapi`, `pydantic`, `uvicorn`, `mcp`, `requests`). Plugins run in the host interpreter — never `pip install` from a plugin.
* Config values live at `plugins.<id>.*` in `settings.json`; read with `read_value(read_settings()[0], "plugins.<id>.<key>")`. Declarations come from `plugin.json` (`config`, external) or `TOOL_META["config"]` (core) and are served by `GET /api/plugins`; values go through `GET/PUT /api/settings` (`value: null` restores the declared default). Undeclared keys under `plugins.<id>.*` are accepted (open namespace); declared ones are type-checked (`str`/`bool`/`int`).

## 6. Installing, lock file, registry

```bash
yhub plugin list [--updates] [--json]     # core + installed + installable
yhub plugin search <kw> | info <id|owner/repo>
yhub plugin install zdic                  # registry id
yhub plugin install owner/repo[@ref][#subdir] | https://github.com/owner/repo   # flags: --ref, --force, --yes
yhub plugin install /path/to/plugin       # local dir
yhub plugin update <id> | --all ; remove|uninstall <id> [--purge] ; enable|disable <id>
yhub plugin registry get|set <url>|clear
```

`--force` overwrites an existing (or pinned) install; `remove` keeps the plugin's config section, `--purge` deletes it. `update` covers registry + unpinned GitHub sources; a pinned `@ref` is skipped, and local installs never auto-upgrade. The UI's plugin manager (`/api/plugin-inventory`, `/api/plugin-catalog`, `/api/plugin-install`, `/api/plugin-remove`, `/api/plugin-update`) uses the same backend functions; the enable toggle writes `plugins.<id>._enabled`.

Install records live in `<config>/plugins.lock.json`:

```jsonc
{"schema": 1, "plugins": {"zdic": {"source": "registry",   // registry | github | local
  "spec": "zdic", "version": "1.2.0", "repo": "owner/yhub-plugin-zdic", "ref": "v1.2.0",
  "registry_id": "zdic", "sha256": "…", "pinned": false, "installed_at": 1760000000}}}
```

Registry (marketplace index) is a static JSON at `plugins_registry_url` — `{"schema": 1, "plugins": [{id, name, description, author, version, repo|archive, subdir, ref, min_yhub}]}` (sample: `examples/registry.example.json`). Each entry needs `id` plus one of `repo`/`archive`/`pypi`; **`pypi` entries and `pypi:` specs are rejected — PyPI is not a supported plugin source**. Cached 5 minutes; network failures fall back to the last cache.

## 7. Failure semantics and trust

| Situation | Behavior |
| --- | --- |
| `disabled` file | not loaded (checked before everything else) |
| bad directory name / no `plugin.json` | skip + warning (not a plugin directory) |
| `enable.default = false` | skip + one log line |
| bad `plugin.json` (JSON, unknown key, field) / no `plugin.py` | `ValueError` locating `<id>/plugin.json.<field>` — startup red, never silent |
| `plugin.py` import raises | that plugin skipped + warning once; the rest keeps running (restart to retry) |
| declaration field in `TOOL_META` | `ValueError` → `<id>/plugin.py.TOOL_META` |
| unresolved `handler`/`fetch` name, colliding MCP name / CLI command / route / tile id, reserved `overview.alerts` | `ValueError` naming the location and both ids |

`trust: full` vs `sandbox`: identical privileges — Python plugins are arbitrary code in the host interpreter. `full` = "installing means trusting"; `sandbox` is an honest label only (**the host does no isolation**). `plugin.json` is read before any import, so gating fields (`id`/`trust`/`enable`) can't be bypassed by broken code. Downloads (registry/GitHub) are validated first: temp extraction rejecting `..`/symlinks/device files, capped at 32 MiB / 5000 files, then atomically swapped in.

## 8. Verifying

`make verify-plugins` runs `scripts/verify-plugin-install.py` (offline: manifest v2, registry, archive, lock) and then `web/verify-plugins.mjs`, which picks a free port, starts its own backend and an isolated config root, installs `web/fixtures/example-plugin/`, then asserts: the launcher entry, both tiles (one always-green, one always-failing → `source_error` with message + hint), MCP tool, CLI subcommand + `--json`, the config declaration; the `disabled` escape hatch removes all of them; a bad import is skipped while a bad declaration raises with a location; and `git status --porcelain` is unchanged afterwards. Plugins are installed only under the config root — the repo stays clean.
