"""Rclone mount adapter: mount remotes from the rclone config (including encrypted crypt
remotes) as local directories.

Endpoints:
  - GET  /api/rclone          overview: rclone itself, remotes in the config, ours, untracked mounts
  - POST /api/rclone/mount    mount a remote (a password-protected one takes the password here)
  - POST /api/rclone/umount   unmount
  - POST /api/rclone/probe    read the mount point once (root entries + capacity)

The logic all lives in ``yhub/cli/rclone.py`` (the panel and ``yhub rclone`` share it); this file
is only the HTTP facade. **A password only passes through once**: it arrives in the request,
goes into the rclone process environment, and is dropped immediately; never written to disk,
logged, echoed or stored in the state file (see the three rules atop yhub/cli/rclone.py).
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from yhub.cli import rclone as rc
from yhub.i18n import tr

from . import ToolError
from ._cell_fetch import ok


def _Args(**kwargs) -> Any:
    """The old run(command, args) takes an argparse.Namespace; build an equivalent object
    (only read via getattr, so it need not be a real Namespace)."""
    import argparse

    return argparse.Namespace(**kwargs)


def _call(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Translate the cli layer's RcloneError into the UI's ToolError (plain message + what to do)."""
    try:
        return fn(*args, **kwargs)
    except rc.RcloneError as exc:
        raise ToolError(exc.message, hint=exc.hint) from exc


def status() -> dict[str, Any]:
    rc.ensure_started()
    return _call(rc.status)


def mount(payload) -> dict[str, Any]:
    # payload is the body model assembled from faces.routes (same fields as the old MountIn).
    # The "extra args" gate runs first (splits the string + rejects dangerous flags); it also
    # raises RcloneError, so it must go through _call -- otherwise the error escapes as a 500
    # instead of a 400 with a readable message.
    extra_args = _call(rc.split_extra_args, payload.extra)
    record = _call(
        rc.mount,
        payload.name.strip(),
        mountpoint=(payload.mountpoint or "").strip() or None,
        password=payload.password or None,
        read_only=payload.read_only,
        allow_non_empty=payload.allow_non_empty,
        extra_args=extra_args,
    )
    return {"ok": True, "mounted": record, "status": status()}


def umount(name: str) -> dict[str, Any]:
    result = _call(rc.umount, name.strip())
    return {"ok": True, **result, "status": status()}


def probe(name: str) -> dict[str, Any]:
    result = _call(rc.probe, name.strip())
    return {"ok": True, "probe": result, "status": status()}


def _route_status() -> dict[str, Any]:
    return {"ok": True, **status()}


def _route_mount(payload) -> dict[str, Any]:
    return mount(payload)


def _route_umount(payload) -> dict[str, Any]:
    return umount(payload.name)


def _route_probe(payload) -> dict[str, Any]:
    return probe(payload.name)


# ---- CLI face (yhub rclone …) -----------------------------------------------
# Still implemented in yhub/cli/rclone.py (the run dispatcher); this only declares the argparse
# shapes. status --json returns the same body as GET /api/rclone (contract A5).


def _cli_status(json_out: bool = False):
    if json_out:
        return {"ok": True, **status()}
    return rc.run("status", _Args(json=json_out))


def _cli_list(json_out: bool = False) -> int:
    return rc.run("list", _Args(json=json_out))


def _cli_mount(name: str, dir: str = None, read_only: bool = False,
               allow_non_empty: bool = False, password_stdin: bool = False,
               extra: str = None) -> int:
    return rc.run("mount", _Args(name=name, dir=dir, read_only=read_only,
                                 allow_non_empty=allow_non_empty,
                                 password_stdin=password_stdin, extra=extra))


def _cli_umount(name: str, json_out: bool = False) -> int:
    return rc.run("umount", _Args(name=name, json=json_out))


def _cli_probe(name: str, json_out: bool = False) -> int:
    return rc.run("probe", _Args(name=name, json=json_out))


def ensure_started() -> bool:
    """Lazily start the rclone watcher thread: it lives with the backend process.

    A dashboard fetch starts it as a side effect ("opening the wall" means "Y-Hub is running",
    which is exactly when mounts should be watched).
    """
    return rc.ensure_started()


def cell() -> dict[str, Any]:
    """The dashboard cell (logic in ``cli/rclone.cell``).

    Do not rename it with a leading underscore: the fetch in ``_dashboard_sources.py`` calls the
    **adapter's** ``cell()``. It used to be called ``_cell`` while the fetch called ``rc.cell()``,
    so that cell always reported "fetch failed" (hit in practice on 2026-09-29).
    """
    return _call(rc.cell)


LOG = logging.getLogger("yhub.rclone.mounts")


# ----------------------------------- wall cell rclone.mounts (phase F4 ownership)


def fetch_rclone(specs: list[dict]) -> dict:
    """Fetch for the ``rclone.mounts`` cell: state comes from this module's ``cell()`` (its three
    states mean the same as the dashboard's).

    Fetching cells also starts the watcher thread -- "opening the wall" = "Y-Hub is running",
    which is when mounts should be watched.
    """
    try:
        ensure_started()
    except Exception as exc:  # noqa: BLE001 -- failing to start it must not take down the whole wall
        LOG.warning("rclone 监视线程没起来：%s", exc)

    def one(spec: dict) -> dict:
        view = cell()
        detail: list[dict] = []
        if view.get("detail"):
            detail.append({"text": str(view["detail"])})
        return ok(view["summary"], status=view["status"], detail=detail, updated_at=time.time())

    with ThreadPoolExecutor(max_workers=1) as pool:
        results = list(pool.map(one, specs))
    return {spec["id"]: outcome for spec, outcome in zip(specs, results)}


#: The rclone.mounts producer declaration (placement + producer; field table in docs/plugins.md)
CELL_TILE = {
    "id": "rclone.mounts",
    "zone": "status",
    "order": 52,
    "title": "rclone 挂载",
    "source": "rclone:watch",
    "stale_after": 1800,
    "refresh": 60,
    "href": "/?tool=rclone",
    "group": "rclone",
    "critical": False,
    "enabled": True,
    "params": {},
    "fetch": fetch_rclone,
    "span": "md",
    "page": 1,
}


TOOL_META = {
    "id": "rclone",
    "name": "Rclone 磁盘",
    "icon": "rclone",
    "description": "挂载 rclone 配置里的远端（含加密盘），并盯着挂载本身",
    "keywords": "rclone 磁盘 挂载 mount 加密盘 crypt vault 网盘 webdav smb 远端",
    # Phase F4: the rclone.mounts producer declaration lives here (the central
    # _dashboard_sources keeps only registration and aggregation)
    "presentation": {"tiles": [CELL_TILE]},
    "ready": lambda: rc.rclone_bin() is not None,
    "status": lambda: (
        tr("rclone.status.not_installed")
        if rc.rclone_bin() is None
        else (
            tr("rclone.status.mounted",
               count=len([row for row in status()["mounts"] if row["mounted"]]))
            if status()["mounts"]
            else tr("rclone.status.none")
        )
    ),
    "faces": {
        "routes": [
            {"method": "GET", "path": "/api/rclone", "endpoint": _route_status, "params": []},
            {
                "method": "POST",
                "path": "/api/rclone/mount",
                "endpoint": _route_mount,
                "params": [
                    {"name": "payload", "in": "body", "fields": [
                        {"name": "name", "type": "str", "help": "远端名，如 vault"},
                        {"name": "mountpoint", "type": "str", "default": "", "help": "挂载点，空 = ~/<name>"},
                        {"name": "password", "type": "str", "default": "",
                         "help": "明文密码，只交给 rclone 这一次（不落盘不进 argv）"},
                        {"name": "read_only", "type": "bool", "default": False, "help": "只读挂载"},
                        {"name": "allow_non_empty", "type": "bool", "default": False, "help": "允许非空挂载点"},
                        # "extra args": a string of rclone flags, split by shell quoting rules and
                        # passed through to the command line (gate: cli/rclone.split_extra_args).
                        # Never put a plaintext password here -- it would enter argv.
                        {"name": "extra", "type": "str", "default": "", "help": "透传的额外 rclone 开关"},
                    ]},
                ],
            },
            {
                "method": "POST",
                "path": "/api/rclone/umount",
                "endpoint": _route_umount,
                "params": [
                    {"name": "payload", "in": "body", "fields": [
                        {"name": "name", "type": "str", "help": "远端名"},
                    ]},
                ],
            },
            {
                "method": "POST",
                "path": "/api/rclone/probe",
                "endpoint": _route_probe,
                "params": [
                    {"name": "payload", "in": "body", "fields": [
                        {"name": "name", "type": "str", "help": "远端名"},
                    ]},
                ],
            },
        ],
        # MCP gets only the actions that never touch a password: mounting with a password has to be
        # done by a human in the panel or a terminal. Going through an agent would write the
        # password into the conversation log -- which is just storing it somewhere else.
        "mcp": [
            {
                "name": "rclone_status",
                "description": "看 rclone 配置里的远端与当前挂载情况（挂载点、进程、最近探测）",
                "params": [],
                "handler": status,
            },
            {
                "name": "rclone_probe",
                "description": "读一次某个已挂载远端（根目录条目与容量；带超时，不会卡住）",
                "params": [{"name": "name", "type": "str", "help": "远端名"}],
                "handler": probe,
            },
            {
                "name": "rclone_umount",
                "description": "卸载某个 rclone 挂载（不碰密码，只卸）",
                "params": [{"name": "name", "type": "str", "help": "远端名"}],
                "handler": umount,
            },
        ],
        "cli": {
            "command": "rclone",
            "help": "Mount rclone remotes (encrypted or plain) and watch them",
            "subcommands": [
                {"name": "list", "help": "List remotes in the rclone config", "params": [],
                 "handler": _cli_list},
                {"name": "status", "help": "Show mounts, their rclone process and the latest probe",
                 "params": [], "handler": _cli_status},
                {"name": "mount", "help": "Mount a remote (asks for the password if the config has none)",
                 "params": [
                     {"name": "name", "type": "str", "positional": True, "help": "Remote name, e.g. vault"},
                     {"name": "dir", "type": "str", "help": "Mount point (default ~/<name>)"},
                     {"name": "read_only", "type": "bool", "default": False, "help": "Mount read-only"},
                     {"name": "allow_non_empty", "type": "bool", "default": False,
                      "help": "Allow a non-empty mount point"},
                     {"name": "password_stdin", "type": "bool", "default": False,
                      "help": "Read the password from stdin (never from argv; pipes like `pass show ... |`)"},
                     {"name": "extra", "type": "str",
                      "help": "Extra rclone flags, passed through as-is: space separated; "
                              "quote values that contain spaces (e.g. --extra \"--dir-cache-time 10s\"). "
                              "Never put a password here — argv is visible in ps"},
                 ],
                 "handler": _cli_mount},
                {"name": "umount", "help": "Unmount a remote",
                 "params": [{"name": "name", "type": "str", "positional": True, "help": "Remote name"}],
                 "handler": _cli_umount},
                {"name": "probe", "help": "Read the mount point once (entries + capacity; timed out, never hangs)",
                 "params": [{"name": "name", "type": "str", "positional": True, "help": "Remote name"}],
                 "handler": _cli_probe},
            ],
        },
    },
}
