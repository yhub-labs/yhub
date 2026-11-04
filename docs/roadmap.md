# Roadmap

Open work only; finished items are deleted. Order: blockers → not wired up → quality → distribution.

## P0 · blockers
1. **Orphan backend after SIGTERM/SIGINT** (`make verify-app` KNOWN F1): the exit hook does not always run,
   so the spawned backend keeps port 8790. Handle the signal, or let the backend exit when its parent goes.
2. **`make verify-app` intermittent race FAILs** ("packaged artifact older than the source binary", one
   dropped sample. Re-running passes, but it costs trust in the result.

## P1 · declared but not wired up
3. **Disabling a core plugin can remove your way back** (disable `settings`-adjacent capabilities and
   their routes are gone, leaving only the config file): needs a minimum viable set / escape hatch.
4. **Plugin install/remove needs a backend restart** (`plugin.py` is exec'd once per process) → hot reload.
5. **`trust: sandbox` is only a label** — plugins are not isolated: implement it or drop the value.
6. **Snapshot panel**: `/api/dashboard/snapshots` and `api.dashboardSnapshots()` exist, nothing renders them.
7. **Plugin panels have no loader**: `presentation.panel` is accepted by the loader and read by nothing,
   so an installed third-party tool shows the "no panel yet" placeholder. The three panels that used to
   live in `web/src/components/` are archived in `yhub-labs/yhub-plugins/<id>/panel/` together with the
   contract (`docs/panels.md`): either a panel registry compiled against the host, or single-file HTML in
   an iframe (the capsule path, no bundler coupling).
8. **Installed-build assertions**: `make verify-app` covers backend/bridge/hotkey/tray, not panel rendering.
9. **Core-plugin inventory is an exact hardcoded set** in `packaging/verify-backend.sh` and
   `tauri/scripts/verify-packed-app.sh`: assert "key tools present + a lower bound".

## P2 · quality
10. Dashboard cold first paint is ~5s (parallel source probe): paint skeletons first, refresh slow sources
   in the background.
11. Plugin versioning: registry/GitHub installs track a version and lock file; add backup/rollback
    protection for a locally edited plugin.

## P3 · distribution
12. Launch at login.
13. Developer ID signing + notarization (only the local `Y-Hub Local Dev` identity exists).
14. Windows / Linux: `web/` and `yhub/server/` are largely portable, the desktop shell is macOS-only.

## Open decisions
- Secondary screen: extension of this machine (127.0.0.1 only) or a standalone device (needs auth and a
  reverse proxy designed first)?
- Launcher phase two: add Spotlight/`mdfind` full-text search?
- Dashboard page capacity: one screen per page, or in-page scrolling?

## Out of scope
- CLI over HTTP by default; plugins sharing the host's React instance; capsules back as widgets.
  (The plugin registry, `yhub plugin install` and `update` are implemented — see `docs/plugins.md` §6.)
