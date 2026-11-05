# Rclone disks (`yhub rclone`)

Mount remotes that already exist in the rclone config (crypt included) as local directories, and watch **the mount itself**: is it still in the mount table, is the process alive, can the root be read. `~/.config/rclone/rclone.conf` (or `$RCLONE_CONFIG`) is the only credential source and is **read-only, never written**.

Code: `yhub/cli/rclone.py` (all logic + CLI), `yhub/cli/rclone_obscure.py` (obscuring), `yhub/server/adapters/rclone.py` (HTTP / MCP / CLI faces + the `rclone.mounts` wall cell), `web/src/components/Rclone.tsx` (panel). Our state lives in `<config root>/rclone.state.json` (config root = parent of `YHUB_SETTINGS_FILE` > `YHUB_CONFIG_DIR` > `~/.yhub`) and contains **no password**. Mount points default to `~/<remote>` and can be overridden per mount; one remote mounts to one point at a time.

## Actions

| Action | HTTP | CLI | `--json` / MCP |
| --- | --- | --- | --- |
| status | `GET /api/rclone` | `yhub rclone status` | `-j` ≡ the same body (`web/verify-cli.mjs` strips timestamps) · MCP `rclone_status` |
| list | `remotes[]` of the same GET | `yhub rclone list` | `[{name,type,encrypted,needs_password,target,stored_secret,mounted}]` |
| mount | `POST /api/rclone/mount` | `yhub rclone mount <name> [--dir D] [--read-only] [--allow-non-empty] [--password-stdin] [--extra '…']` | `-j` accepted, no effect (plain text only) · **not on MCP** (a password would enter the transcript) |
| umount | `POST /api/rclone/umount` `{name}` | `yhub rclone umount <name>` | `{name,mountpoint,steps,mounted}` (HTTP wraps it in `ok`/`status`) · MCP `rclone_umount` |
| probe | `POST /api/rclone/probe` `{name}` | `yhub rclone probe <name>` | the probe result itself (HTTP puts it under `probe`) · MCP `rclone_probe` |

Mount body: `{name, mountpoint, password, read_only, allow_non_empty, extra}`. Status body: `rclone{installed,path,version,config,config_exists}`, `mount_root`, `state_path`, `vfs_cache_mode` (`writes`, fixed — display only), `remotes`, `mounts`, `untracked`, `watcher{tick_seconds:15, probe_every:60}`, `checked_at`, `mount_table`. Errors: HTTP 400 `{ok:false,error,hint}`; CLI `× message` + an indented hint, exit 1; MCP an error result.

## mount and umount

* **Preflight before mounting** (`rclone lsf <name>: --max-depth 1`, same password env, 60 s): rclone mounts happily with a wrong password and then only prints `Skipping undecryptable file name`. Block only on hard evidence — some names decrypted → pass; nothing decrypted **and** a failure other than `illegal base32` (foreign names, e.g. `.DS_Store`) → "wrong password"; empty or foreign-only top level → pass. The note is stored in the record's `preflight`.
* Guards, all 400 with a way out: unknown remote, missing password, relative mount point, point is a file / non-empty (without `allow_non_empty`) / already mounted / taken by another mount / orphan rclone process. The destination directory is created.
* `--vfs-cache-mode writes` is always ours; extra args are appended **last**, so `--extra '--vfs-cache-mode off'` wins and the record's `cache` says so. `--read-only` inside extra args also sets `read_only` (state must not lie).
* Readiness: wait ≤ 12 s for the mount table, then ≤ 60 s for the first successful read; still unreadable → clean up the mount point and fail, so no half mount is left. Within 60 s after mounting a mount is `warming` (auto-probes are skipped).
* `umount` (`_detach`): `umount` (≤ 10 s) → `SIGTERM` to the recorded pid (≤ 10 s) → `diskutil unmount force` on macOS; still mounted → 400. Success removes the record and the in-flight probe slot. Nothing inside a mount point is ever touched. Records keep `mountpoint` and `mountpoint_resolved` (`realpath`: `/tmp` → `/private/tmp`, which is what the mount table shows).

## Probing and state

Request paths (`GET /api/rclone`, `status`, the dashboard cell) **never read the mount point and never wait**: that read is uninterruptible on a wedged mount and used to drain backend threads. Only a background thread probes — at most one in flight per remote, 15 s per read, auto-probe every 60 s, watcher tick 15 s. In-flight longer than 30 s is reported as `probe_stuck_seconds`. An explicit probe waits at most 5 s and then returns `running:true` plus a `note`. The probe subprocess is `/bin/sh` + `ls -A -p` + `df -k`, not `sys.executable` (in the installed build that interpreter always times out).

Per-mount live fields: `mounted` (in the table), `pid_alive`, `dropped` (record but table lost it), `stale` (in table, process gone), `degraded` (3 consecutive probe failures, not warming), `warming`, `readable` / `warmup_ms`, `probe` / `probe_error` / `probe_running` / `probe_stuck_seconds` / `probe_fails`. `untracked` lists rclone/FUSE mounts with no record. The watcher thread starts lazily (first `/api/rclone` / a backend start); the `rclone.mounts` wall cell reads cached state and reports `ok` / `warn` / `alert` for unreadable, stuck, dropped or degraded mounts.

## Password hygiene

* Cleartext only, for one `mount()` call. It is obscured **in this process** (`yhub/cli/rclone_obscure.py`: AES-256-CTR + base64url with rclone's constant key) — never via `rclone obscure`, whose argv would show in `ps`. An already-obscured value is not accepted; the CLI warns once and still treats it as cleartext (the preflight then reports a wrong password).
* Handed to rclone only through `RCLONE_CONFIG_<REMOTE>_<KEY>` (non-alphanumerics → `_`, uppercased). Key, in order: `password` if the section has `password` / `password2`, else `pass` if it has `pass`, else `password` for `type = crypt`, else `pass`. The env copy is popped in `finally`.
* Never in argv, on disk, in logs, or echoed; the state file has no password field (asserted by acceptance). The panel keeps the password in component state only, clears it after submit, and never writes it to localStorage.

## Extra arguments (`--extra`)

`shlex`-split, then gated: `--password*`, `--config*`, `--daemon*`, `--volname*`, `--rc*`, positional arguments, more than 32 items, an item over 200 chars, or unbalanced quotes are all rejected (argv is world-readable; positions would displace the remote or mount point). Quote values with spaces: `--dir-cache-time "10s"`.

## Verify

```bash
# fully local: temp rclone config + temp config root — never write into the real ~/.config
export RCLONE_CONFIG=/tmp/rc.conf YHUB_CONFIG_DIR=/tmp/rc-cfg
printf '[plaindir]\ntype = local\nremote = /tmp\n' > /tmp/rc.conf
yhub rclone list && yhub rclone status -j | python3 -m json.tool   # ≡ GET /api/rclone
yhub rclone mount plaindir --dir /tmp/rc-mnt --read-only && yhub rclone probe plaindir
yhub rclone umount plaindir && mount | grep -i rc-mnt              # nothing left behind
curl -s 127.0.0.1:8790/api/rclone | python3 -m json.tool
make verify-backend                  # 3/5 real mount/read/unmount + error paths; 3.5/5 password hygiene + stuck regression
cd web && node verify-cli.mjs        # status -j ≡ GET /api/rclone
cd web && npm run smoke              # panel renders; "Rclone leaks no password fields"
```

Known limits: macOS needs macFUSE or fuse-t (`--network-mode` is not wired as an automatic fallback); probe counts and capacity are a read of the mount point, not authoritative remote values; `needs_password` is only detected for `type = crypt`; when rclone is not installed the tool still appears with `ready=false`.
