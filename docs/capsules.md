# Capsules in the library (`/capsules/<path>`)

> `settings.json: capsules_dir` points at a directory in your library, and **every `.html` / `.htm` in it is a capsule** — drop one in and it appears, delete it and it disappears. No import, no id, no manifest, no allowlist.

This is the **hosting contract**. Implementation: `yhub/server/adapters/capsules.py` (a capability-only module: it declares `ROUTES` and takes no launcher entry). Config keys are owned by `yhub/server/adapters/settings.py`; see [config.md](config.md).

## 1. Layers and config keys

| Layer | Location | Writable |
| --- | --- | --- |
| user | `capsules_dir` (`~/…` expanded) | yes — PUT / DELETE / sandbox files land here |
| system | bundled `capsules/` (repo root; `yhub/_data/capsules` in the wheel; `YHUB_SYSTEM_CAPSULES_DIR` overrides) | no |

* The same relative path resolves **user first**; the system-layer file is shadowed, so upgrades never overwrite user edits.
* `PUT` on a system-layer entry → **403**. Sandbox data always writes to the user layer (auto-creating `~/Y-Hub/capsules` when unset); reads prefer user data, then the shipped default.
* `capsules_dir = ""` (or a directory that does not exist) turns the user layer off — `/capsules/*` then serves only built-in capsules. `GET /api/capsules` reports the tri-state via `configured` / `problem` (`unset` / `missing` / `not_dir` / `unwritable` / `null`) plus `recommended_dir`. `POST /api/capsules/ensure` with `{path?}` mkdirs (default `~/Y-Hub/capsules`) and writes the key through `set_values`.
* Listing items: `relpath` / `name` / `path` / `url_path` / `url` / `bytes` / `mtime` / `source` / `writable` / `enabled` / `title` / `icon` / `description`, alongside `capsule_roots`, `max_capsules` (200), `max_bytes` (32 MiB). `POST /api/capsules/toggle` writes `capsules_disabled` (entries match `layer:relpath`, `relpath`, the top-level directory, or the bare name).

## 2. Address resolution and short URLs

`_resolve_in()` is pure resolution (no config reads); **the first existing candidate wins**:

| Requested | Tried in order |
| --- | --- |
| `/capsules/pinyin` | `pinyin.html` → `pinyin.htm` → `pinyin/index.html` → `pinyin/pinyin.html` |
| `/capsules/pinyin/` | `pinyin/index.html` → `pinyin/pinyin.html` |
| `/capsules/a/b.html` | verbatim (an explicit path always works) |

Short addresses come from `_url_path()` and are **re-resolved before being emitted** (falling back to the explicit path):

* `<dir>/index.html` → `<dir>/` — the trailing slash is **required**
* `<dir>/<dir>.html` → `<dir>`
* `a/b.html` → `a/b`; a top-level `index.html` has no shorter form

The slash is not cosmetic: a relative `./data/` resolves against the current URL, so `…/capsules/chat` would drift to `…/capsules/data`. GET/HEAD on a slashed-less directory short URL therefore **302**s to the slashed one. When two files compete for one short address, only the one that resolves back to itself keeps it (ties go to the first in listing order); the rest fall back to their explicit path. Renaming changes the URL; old references 404.

## 3. Methods

| Method | Semantics |
| --- | --- |
| `GET` | entry html verbatim (`text/html; charset=utf-8`, `no-store`, `ETag`, hosted-page CSP); with no entry, a sandbox data file (`Content-Type` from the suffix) |
| `HEAD` | same headers plus `Content-Length`, no body (the `ETag` probe) |
| `OPTIONS` | `200` + `DAV: 1`, `Allow: GET, HEAD, OPTIONS, PUT, DELETE`, `MS-Author-Via: DAV`; 404 when neither an entry nor a sandbox path resolves |
| `PUT` | entry: overwrite only, **never create** → `204` + new `ETag`. Sandbox: create or overwrite, parents auto-created |
| `DELETE` | one sandbox data file (`204`); the entry html is always `405` |

The rig exists because single-file capsules (TiddlyWiki's `put.js`) only enable saving when `OPTIONS` answers 2xx **with** a `DAV` header, then `HEAD`s for the `ETag` and sends `If-Match`; without the 412 two editors silently clobber each other.

`PUT` / `DELETE` gates: `If-Match` mismatch → **412** (body carries the current `ETag`; a missing `If-Match` and `*` are allowed) · body over 32 MiB → **413** · sandbox folder at 2000 files or a capsule over 512 MiB → **413** · non-local `Origin` → **403** · nothing resolves → **404**. Writes are atomic (temp file + `os.replace`) and keep the original permission bits.

## 4. Sandbox (a folder per little app)

The sandbox root is **the first directory along the path that directly contains an entry html**; a loose top-level file has no sandbox (its directory is the capsules root).

```text
capsules/chat/index.html            entry — sandbox root capsules/chat/
capsules/chat/data/x.json           GET / HEAD / OPTIONS / PUT / DELETE all work
capsules/chat/.appdata/a.json       dot-dirs allowed after the first segment
capsules/pinyin.html                loose file: no sandbox
```

The path needs at least two segments; `.` / `..` are rejected anywhere and a dot-leading **first** segment is rejected. A `.html`/`.htm` written into a sandbox becomes a capsule, while other data files never appear in the listing. Data lives in the library, so it travels with its git.

## 5. Boundaries and isolation

* Entries are only `.html` / `.htm`; any dot-leading segment is rejected (`.git/config`, `.env`), and symlinks must resolve inside the root (otherwise they are neither listed nor fetchable).
* The loopback server has no auth, so writes rely on the middleware's Host gate (loopback / `*.localhost` only) plus an Origin allowlist (any `127.0.0.1` / `localhost` / `tauri` origin; a missing `Origin` is allowed for `curl` and the shell).
* **CSP** (`page_csp`, per capsule): `default-src 'none'`, the capsule's own `/capsules/<its path>` prefixes only (**never `'self'`**), `'unsafe-inline' 'unsafe-eval'`, `https:` for script/connect/img/font/media, `object-src` / `form-action` / `base-uri 'none'`. Sandbox data files get no CSP — except `.html` / `.htm` / `.xhtml` / `.svg` / `.xml`, which get the same page CSP so a capsule cannot write a page into its own folder and iframe around isolation.
* **Server-side layer**: browser requests (those carrying `Sec-Fetch-*`) must present a `Referer` from the same capsule (identity = capsule-relative path, shared across layers), otherwise **403**; `/api/*` returns **403** to anything whose Referer is under `/capsules/`. `curl` and tests carry no `Sec-Fetch-*` and are unaffected.
* `capsules_subdomains = true` (per-capsule override: `capsules_subdomains_overrides = {"chat": true}`) moves each capsule to `http://<slug>.localhost:8790/capsules/…` (slug = lowercase path + first 8 hex of sha1), isolating `localStorage` / IndexedDB / window handles by origin. On capsule hosts `/api/*` is 403 and the main UI 404; GET/HEAD on the main host 302 to the subdomain and writes there are 403. Default off.

## 6. Bookmark-style metadata

`title` (`<title>` → `og:title` → `application-name`), `icon` (largest `<link rel=icon sizes>`; `data:` / `https:` as-is, relative or root paths inlined as `data:` when ≤ 64 KiB per file and ≤ 96 KiB after encoding), `description` (`meta description` → `og:description`). Only the first 64 KiB of the file is read, decoded as utf-8 with a gb18030 retry, and cached by `(mtime_ns, size)`. Empty strings are honest: the display layer falls back to the file name / 💊.

## 7. Verify

```bash
uv run yhub gui --no-open &
curl -s --noproxy '*' http://127.0.0.1:8790/api/capsules | python3 -m json.tool   # listing, short URLs, limits
curl -sI --noproxy '*' http://127.0.0.1:8790/capsules/<name>                     # no-store + ETag + per-capsule CSP
curl -s -X OPTIONS -D - -o /dev/null --noproxy '*' http://127.0.0.1:8790/capsules/<name> | grep -i dav
# PUT only against a throwaway library (YHUB_CONFIG_DIR + YHUB_SYSTEM_CAPSULES_DIR): it really rewrites the file
make verify-backend                      # capsule listing, metadata, resolution, PUT codes, isolation, sandbox, lifecycle
cd web && npm run build && npm run smoke  # launcher + settings UI; verify-settings-ui.mjs covers the shell side
```
