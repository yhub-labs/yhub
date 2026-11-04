# Packaging and installation

The Python backend is the product: **the PyPI wheel is the single source of truth, and `Y-Hub.app` is a thin macOS shell with no Python runtime**. At launch the shell reuses or starts the `yhub` installed on the machine.

```text
make wheel ──▶ dist/yhub-<ver>-py3-none-any.whl   (yhub/ + yhub/web/dist + yhub/_data/capsules)
   │ uv tool install / pip install             ──▶  ~/.local/bin/yhub  ◀── launched by the shell
make app   ──▶ Y-Hub.app   (Rust shell + frontend embedded at compile time, no Python)
```

Keeping the backend out of the bundle makes the app ~10 MB instead of ~40, lets plugins use the host's installed dependencies, and decouples backend upgrades from app reinstalls — PyPI and the installed build are the same code. The price: the machine needs a usable `yhub` (or `uv` + a source tree); `tauri/src/backend.rs` holds the lookup order and the error text.

## Artifacts

| Path | What |
| --- | --- |
| `pyproject.toml` | single package definition: `packages = ["yhub"]`, version source, `force-include` |
| `yhub/__init__.py` | `__version__` — the only version number |
| `yhub/web/dist`, `yhub/_data/capsules` | frontend + sample capsules placed at build time (`capsules/` is the gitignored build output) |
| `packaging/build-app-assets.sh` | Tauri `beforeBuildCommand`: frontend + capsules |
| `packaging/install-app.sh`, `packaging/verify-backend.sh` | one-command install / full backend API assertions |
| `tauri/target/release/bundle/macos/Y-Hub.app` | build output |

Non-core plugins are not in this repo or the wheel: they come from `yhub-labs/yhub-plugins` via `yhub plugin install` (see [`plugins.md`](plugins.md)).

## Building and publishing the wheel

```bash
make verify-versions   # Python / frontend / Tauri / Cargo versions must match
make wheel             # verify-versions + web + capsules + uv build --wheel
make publish           # uploads dist/*.whl only (needs UV_PUBLISH_TOKEN)
```

* **`web/dist` and `capsules/` must exist first**: a missing `force-include` source fails the build outright (`Forced include not found`). `make wheel` handles the order.
* Ship the **wheel**; the sdist also builds (with `include`/`artifacts`) but needs a Node toolchain on the release machine. Version lives only in `yhub/__init__.py` (`[tool.hatch.version]`); `web/package.json`, `tauri/Cargo.toml` and `tauri/tauri.conf.json` are bumped together and `make verify-versions` blocks mismatches.
* CI: `.github/workflows/ci.yml` (wheel + backend/plugin/i18n verification + `cargo test`), `release.yml` (publishing a GitHub Release → wheel built, self-checked, then uploaded to PyPI through Trusted Publishing — no token, see the next section).

## Publishing from GitHub (Trusted Publishing)

`.github/workflows/release.yml` uploads to PyPI without any stored token: GitHub mints a short-lived OIDC token that PyPI checks against the trusted publisher registered for this repository. The token never exists as a secret, so there is nothing to rotate or leak.

**One-time setup, on PyPI (only the project owner can do this)** — `https://pypi.org/manage/project/yhub/settings/publishing/` → *Add a new publisher*:

| Field | Value |
| --- | --- |
| Owner | `yhub-labs` |
| Repository | `yhub` |
| Workflow name | `release.yml` |
| Environment | `pypi` |

These four must match the workflow exactly, or PyPI rejects the token exchange (`invalid-publisher`). `environment: pypi` in the workflow is not decoration: the environment name is part of what PyPI verifies, and an environment with required reviewers also gates the upload behind a manual approval.

**Cutting a release:**

1. Bump the version in all five manifests (`make verify-versions` fails on a mismatch; single source is `yhub/__init__.py`).
2. Commit, push, wait for `ci` to go green — the release workflow does not re-run the acceptance suite.
3. GitHub → *Releases* → *Draft a new release* → tag `v0.1.0` (create it) → publish. Publishing the release is what triggers the upload; pushing a tag alone does nothing.

The workflow refuses to publish when the tag and `__version__` disagree, then runs these checks on the exact artifact it is about to upload: `twine check`, `web/dist` + bundled capsule present in the wheel, no relative links in the long description, and a real install-and-boot (`/api/health` and the workbench asset URL). A dry run is `Actions → release → Run workflow`, which builds and self-checks but skips the upload.

A PyPI version number can never be reused: a bad upload is fixed by yanking it and publishing the next patch version, not by re-uploading.

## Installing the backend

```bash
make install-backend   # uv cache clean yhub && uv tool install . --force
uv tool install yhub   # from PyPI (or: pip install yhub)
yhub --version ; yhub gui --no-open
```

`uv tool install . --force` silently reuses the cached wheel when the version did not change — hence the `uv cache clean`. Browser mode uses same-origin relative paths (`--port` works); the desktop shell is pinned to `8790` (matching the CSP and `DEFAULT_PORT`).

## Building the `.app`

`make app` runs `tauri build --bundles app`; its `beforeBuildCommand` = `packaging/build-app-assets.sh`, which does `cd web && npm run build` and `./scripts/build-capsules.sh`. The frontend is embedded **at compile time**, so frontend changes require `make app`; the backend is not in the bundle, so nothing Python is built here.

Backend lookup order (`tauri/src/backend.rs`): port 8790 already serving → `YHUB_BACKEND_BIN` → installed `yhub` (PATH / `~/.local/bin` / Homebrew) → `uv run yhub` from a source tree.

## Installing into `/Applications`

```bash
make install                     # rebuild only if build inputs changed
make install ARGS="--force"      # ignore the fingerprint
make install ARGS="--no-build"   # install the existing .app
make install ARGS="--no-restart"
```

`packaging/install-app.sh` (never hand-roll `rm -rf` + `ditto`):

1. **Input fingerprint** over `web/`, `yhub/`, `packaging/`, `scripts/`, `capsule-src/`, `tauri/src`, `tauri/icons`, `pyproject.toml`, `Cargo.*`, `tauri.conf.json`, `Info.plist`; unchanged + last verification OK = no-op.
2. **Build** the `.app`; **install the backend** (`uv cache clean yhub && uv tool install . --force`, after the build so the wheel carries this round's frontend and capsules).
3. **Quit** the running App (SIGTERM → SIGKILL after 5 s) and sweep an orphan backend still holding 8790; **archive → install** (old bundle to `~/Applications-Archive`, last 5 kept, new one via `ditto`).
4. **Verify**: `Contents/MacOS/yhub` exists; `codesign --verify --deep --strict` passes; the signature is a certificate (not ad-hoc `cdhash`); no `com.apple.quarantine`; `Resources/THIRD-PARTY.md` + `Resources/LICENSE` present; `LSUIElement` set; **no `Resources/backend`**.
5. **Record + restart**: `build/installed-app.json` (commit, fingerprint, shell sha, backend path/version, embedded JS name, archive, result), then `open`.

## Signing and "local network"

`bundle.macOS.signingIdentity = "Y-Hub Local Dev"` (self-signed cert in the login keychain). An ad-hoc signature changes identity on every rebuild and invalidates the macOS local-network permission, so it must stay `certificate root`. `NSLocalNetworkUsageDescription` in `tauri/Info.plist` only declares eligibility — tick Y-Hub under System Settings → Privacy → Local Network after installing; changing the bundle id or certificate restarts that grant. Shipping to others needs Developer ID + notarization (every embedded Mach-O re-signed; today only the shell).

## Verification

| Command | Verifies |
| --- | --- |
| `make verify-backend` / `./packaging/verify-backend.sh <yhub>` | backend API: core tool inventory, cell producers, real data, `/api/settings`, `/api/capsules` (optionally against a given executable). The rclone mount/read/unmount block needs rclone + macFUSE/FUSE-T; without them it prints a `SKIP` line and the summary counts the skip instead of claiming a silent pass — CI runs without either, so that block is covered by `make verify-app` on a real machine |
| `make verify-app` | the installed `.app`: destination/signature/size/no embedded Python/cold start/real data/bridge/background-network/exit (builds a `uv run yhub` wrapper via `YHUB_BACKEND_BIN` so it tests this tree) |
| `./tauri/scripts/verify-backend-bridge.sh` | bridge logic with fake backends (launch/liveness/self-heal/bounded failure) |
| `./tauri/scripts/verify-settings-parity.sh`, `cd tauri && cargo test config::` | shared config keys / config unit tests |
| `cd web && npm run smoke` | real Chrome end to end |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| App up, UI says "backend not ready" | `source=…` line in `~/.config/yhub/logs/desktop.log`, child output in `backend.log` |
| `source=installed` but stale version | `command -v yhub`, `yhub --version`; run `make install-backend` after code changes |
| Backend not found / port 8790 held | install `yhub` or set `YHUB_BACKEND_BIN`; `lsof -nP -iTCP:8790 -sTCP:LISTEN` (`make install` sweeps it) |
| Frontend changes invisible / `Forced include not found` | rebuild with `make app` (embedded at compile time); run `make web` and `make capsules` |
| Local-network permission lost | `codesign -dr - /Applications/Y-Hub.app` must show `certificate root` |

Platforms: only macOS has a desktop shell; the backend itself is cross-platform (`pip install yhub` then `yhub gui`), without Windows/Linux install or acceptance scripts yet.
