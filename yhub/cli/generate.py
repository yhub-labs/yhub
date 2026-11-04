"""CLI generator: turns a ``TOOL_META["faces"]["cli"]`` declaration into argparse subcommands + dispatch.

Declaration shape (the params format shared by all three faces, yhub/server/adapters/params.py):

    "faces": {
        "cli": {
            "command": "rclone",          # top-level command name (yhub rclone …)
            "help": "…",
            "params": [...]               # no subcommands: the command takes params itself
            # or
            "subcommands": [
                {"name": "list", "help": "…", "params": [...], "handler": fn},
            ],
        },
    }

Contract (isomorphic across the three faces, see api-contract.md):
  * every leaf gets ``-j/--json`` automatically, with **the same body** as the matching HTTP endpoint;
  * a handler is called with ``**declared param names``; if its signature has ``json_out`` the
    --json flag is passed in;
  * handler returns int = exit code (it printed already); returns dict/list = printed here as JSON;
  * ``ToolError`` is translated in one place: plain mode prints ``× message``, --json prints
    ``{ok:false,error,hint}``, both exit 1.
"""

from __future__ import annotations

import argparse

from yhub.i18n import tr_text
import inspect
import json
from typing import Any

from yhub.i18n import tr

JSON_HELP = "Output JSON (same body as the HTTP API)"

#: Host commands: always hand-written in yhub/cli/main.py, never declared.
#: `plugin` must live here — a declared command disappears when its plugin is disabled, and this is
#: exactly the command that re-enables it.
HOST_COMMANDS = ("completion", "gui", "mcp", "plugin")


def discover_cli_faces() -> list[dict]:
    """Collect the CLI faces declared by every adapter (with a `where` locator; a bad declaration fails loudly at startup)."""
    from yhub.server.adapters import discover_adapters

    faces: list[dict] = []
    for entry in discover_adapters():
        meta = entry["meta"]
        cli = (meta.get("faces") or {}).get("cli")
        if not cli:
            continue
        from yhub.server.adapters.params import normalize_params

        if not isinstance(cli, dict) or "command" not in cli:
            raise ValueError(tr("cli.generate.cli_face_not_dict", id=meta["id"], cli=repr(cli)))
        if "handler" not in cli and not cli.get("subcommands"):
            raise ValueError(tr("cli.generate.cli_face_no_handler", id=meta["id"]))
        where = f"{meta['id']}.cli:{cli['command']}"
        for sub in cli.get("subcommands") or []:
            if "name" not in sub or "handler" not in sub:
                raise ValueError(
                    tr("cli.generate.subcommand_no_name_handler", where=where, sub=repr(sub))
                )
            sub["params"] = normalize_params(sub.get("params"), where=f"{where}.{sub['name']}")
        if cli.get("params") is not None:
            cli["params"] = normalize_params(cli["params"], where=where)
        faces.append({"where": where, **cli})
    return faces


def _add_param(parser: argparse.ArgumentParser, param: dict) -> None:
    """Translate one declared param into an argparse argument."""
    name = param["name"]
    raw_help = param.get("help")
    help_text = tr_text(raw_help) if raw_help else argparse.SUPPRESS

    if param.get("positional"):
        # nargs="*" gives [] and "?" gives None in argparse — same as the old hand-written
        # declarations, so no extra default is set here
        kwargs: dict[str, Any] = {"help": help_text}
        if "nargs" in param:
            kwargs["nargs"] = param["nargs"]
        if "choices" in param:
            kwargs["choices"] = param["choices"]
        parser.add_argument(name, **kwargs)
        return

    flag = "--" + name.replace("_", "-")
    opts = [flag]
    if param.get("short"):
        # Short option first: argparse then renders usage/help as `-t, --traditional`
        # (matching the old hand-written declarations)
        opts = ["-" + param["short"], flag]
    if param.get("type") == "bool":
        # bool = switch (the declaration must give default False; a True-by-default bool belongs
        # to the HTTP/MCP faces, not the CLI)
        if param.get("default") is not False:
            raise ValueError(tr("cli.generate.switch_default_false", name=repr(name)))
        parser.add_argument(*opts, action="store_true", help=help_text)
        return
    type_map = {"str": str, "int": int, "float": float}
    parser.add_argument(*opts, type=type_map.get(param.get("type") or "", str),
                        default=param.get("default"), help=help_text)


def add_faces(subparsers: argparse._SubParsersAction, faces: list[dict]) -> None:
    """Register the declared CLI faces as subcommands."""
    for face in faces:
        subs = face.get("subcommands") or []
        if subs:
            cmd = subparsers.add_parser(face["command"], help=tr_text(face.get("help") or "") or None)
            # --json is accepted at both levels (`yhub x --json list` and `yhub x list --json`):
            # the parent defaults to False while the leaf default is SUPPRESS — an absent leaf flag
            # leaves args.json alone, so the parent's parse result is not overwritten by a default.
            cmd.add_argument("-j", "--json", action="store_true", help=JSON_HELP)
            cmd_subparsers = cmd.add_subparsers(dest=f"{face['command']}_command")
            for sub in subs:
                leaf = cmd_subparsers.add_parser(sub["name"], help=tr_text(sub.get("help") or "") or None)
                for param in sub.get("params") or []:
                    _add_param(leaf, param)
                leaf.add_argument("-j", "--json", action="store_true",
                                  default=argparse.SUPPRESS, help=JSON_HELP)
                leaf.set_defaults(_cli_spec={"handler": sub["handler"], "params": sub.get("params") or [],
                                             "where": f"{face['where']}.{sub['name']}"})
        else:
            cmd = subparsers.add_parser(face["command"], help=tr_text(face.get("help") or "") or None)
            for param in face.get("params") or []:
                _add_param(cmd, param)
            cmd.add_argument("-j", "--json", action="store_true", help=JSON_HELP)
            cmd.set_defaults(_cli_spec={"handler": face["handler"], "params": face.get("params") or [],
                                        "where": face["where"]})


def dispatch(args: argparse.Namespace) -> int:
    """Run a leaf handler (contract in the module docstring)."""
    spec = getattr(args, "_cli_spec", None)
    if spec is None:
        return -1  # no declared face (host command): yhub/cli/main.py handles it
    handler = spec["handler"]
    params = spec["params"]
    kwargs = {p["name"]: getattr(args, p["name"]) for p in params}
    as_json = bool(getattr(args, "json", False))
    if "json_out" in inspect.signature(handler).parameters:
        kwargs["json_out"] = as_json
    try:
        result = handler(**kwargs)
    except Exception as exc:  # noqa: BLE001 — per-type translation happens in the branches below
        from yhub.server.adapters import ToolError

        if isinstance(exc, ToolError):
            if as_json:
                print(json.dumps({"ok": False, "error": exc.message, "hint": exc.hint},
                                 ensure_ascii=False, indent=2))
            else:
                print(f"× {exc.message}")
                if exc.hint:
                    print(f"  {exc.hint}")
            return 1
        raise
    if result is None:
        return 0
    if isinstance(result, int):
        return result
    # Data came back: print it here (--json body == the HTTP body; a human rendering must print
    # itself and return an int instead)
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return 0


def command_tree() -> dict[str, dict]:
    """Lightweight inventory for the completion scripts: {command: {"help", "subs": {sub: help}}}."""
    tree: dict[str, dict] = {}
    for face in discover_cli_faces():
        subs = {s["name"]: s.get("help", "") for s in face.get("subcommands") or []}
        tree[face["command"]] = {"help": face.get("help", ""), "subs": subs}
    return tree
