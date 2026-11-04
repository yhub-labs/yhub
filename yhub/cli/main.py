"""yhub CLI entry point.

Two kinds of commands:
  * **host commands** (completion / gui / mcp) — always hand-written here, never declared (plan §8);
  * **declared commands** (rclone / rss / schedule, plus every installed plugin's) — come from each
    adapter's ``faces.cli``; yhub/cli/generate.py turns them into argparse subcommands and dispatches them.

Adding a tool does **not** touch this file: once the adapter has faces.cli, the command, its params,
--json and shell completion (top level / subcommands / options / choices, all rendered from the parse
tree) appear automatically.
"""

from __future__ import annotations

import argparse
import os
import sys

from yhub.i18n import tr

from . import env as _env  # noqa: F401


def _version() -> str:
    """Single source of truth for the version: ``__version__`` in ``yhub/__init__.py``."""
    from yhub import __version__

    return __version__


def _build_parser() -> argparse.ArgumentParser:
    """Host commands (hand-written) + declared commands (generated from faces.cli)."""
    from . import generate

    parser = argparse.ArgumentParser(prog="yhub", description="Y-Hub CLI (yhub)")
    parser.add_argument(
        "-v", "--version", action="version", version=_version(), help="Show version and exit"
    )
    subparsers = parser.add_subparsers(dest="command")

    # ---- host commands (hand-written) ----------------------------------------------------
    completion_parser = subparsers.add_parser(
        "completion", help="Print shell completion setup snippet"
    )
    completion_parser.add_argument("shell", choices=["zsh", "bash"])

    gui_parser = subparsers.add_parser("gui", help="Launch the local GUI (web UI)")
    gui_parser.add_argument("--port", type=int, default=8790, help="Port for the local GUI")
    gui_parser.add_argument(
        "--no-open", action="store_true", help="Do not open the browser automatically"
    )
    gui_parser.add_argument(
        "--dev",
        action="store_true",
        help="API only (no web/dist; run the frontend with `npm run dev`)",
    )

    subparsers.add_parser("mcp", help="Start MCP (Model Context Protocol) server for AI agents")

    plugin_parser = subparsers.add_parser(
        "plugin", help="Install / remove / enable / disable plugins (core vs third-party)"
    )
    plugin_sub = plugin_parser.add_subparsers(dest="plugin_command")
    list_parser = plugin_sub.add_parser("list", help="List core + installed + installable plugins")
    list_parser.add_argument("--json", action="store_true", help="JSON output")
    list_parser.add_argument("--updates", action="store_true", help="Also check registry/GitHub for updates")
    search_parser = plugin_sub.add_parser("search", help="Search the plugin registry")
    search_parser.add_argument("query", nargs="?", default="", help="Keyword (id/name/description/author)")
    info_parser = plugin_sub.add_parser("info", help="Show a plugin's registry/installed details")
    info_parser.add_argument("spec", metavar="id|owner/repo")
    install_parser = plugin_sub.add_parser("install", help="Install by registry id / GitHub owner/repo / local dir")
    install_parser.add_argument("spec", metavar="id|owner/repo|path")
    install_parser.add_argument("--force", action="store_true", help="Overwrite if already installed")
    install_parser.add_argument("--ref", default="", help="GitHub tag/branch/commit")
    install_parser.add_argument("--yes", action="store_true", help="Skip the third-party trust prompt")
    install_parser.add_argument(
        "--id", default="", metavar="plugin-id",
        help="Local directory only: install under this id instead of the directory name"
             " (a single-plugin repo's folder is named after the repo, not the plugin)")
    rm_parser = plugin_sub.add_parser("remove", help="Uninstall a third-party plugin")
    rm_parser.add_argument("plugin_id", metavar="id")
    rm_parser.add_argument("--purge", action="store_true",
                           help="Also delete this plugin's config section (plugins.<id>)")
    update_parser = plugin_sub.add_parser("update", help="Update registry/GitHub plugins")
    update_parser.add_argument("plugin_id", nargs="?", metavar="id", help="Omit with --all to update every available update")
    update_parser.add_argument("--all", action="store_true", help="Update all plugins with available updates")
    for _name, _help in (("enable", "Enable a plugin"), ("disable", "Disable a plugin")):
        _p = plugin_sub.add_parser(_name, help=_help)
        _p.add_argument("plugin_id", metavar="id")
    registry_parser = plugin_sub.add_parser("registry", help="Show/set the plugin registry URL")
    registry_sub = registry_parser.add_subparsers(dest="registry_command")
    registry_sub.add_parser("get", help="Print the current registry URL")
    registry_set = registry_sub.add_parser("set", help="Set the registry URL (JSON registry file)")
    registry_set.add_argument("url")
    registry_sub.add_parser("clear", help="Clear the registry URL")

    # ---- declared commands (adapter faces.cli) -------------------------------------------
    faces = generate.discover_cli_faces()
    generate.add_faces(subparsers, faces)

    return parser


# --------------------------------------------------------------------------- completion


def _sub_action(parser: argparse.ArgumentParser) -> argparse._SubParsersAction | None:
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            return action
    return None


def _flag_pairs(parser: argparse.ArgumentParser) -> list[tuple[str, str]]:
    """(option string, help) pairs for completion's _values / compgen."""
    pairs: list[tuple[str, str]] = []
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            continue
        if action.option_strings:
            help_text = (action.help or "").replace("[", "(").replace("]", ")")
            for opt in action.option_strings:
                pairs.append((opt, help_text))
    return pairs


def _choice_map(parser: argparse.ArgumentParser) -> dict[str, list[str]]:
    """Positional choices: {dest: values} (e.g. completion's shell)."""
    out: dict[str, list[str]] = {}
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            continue
        if not action.option_strings and action.choices:
            out[action.dest] = list(action.choices)
    return out


def _parse_tree(parser: argparse.ArgumentParser) -> dict:
    """Extract everything completion needs from the parse tree (help/subcommands/options/choices).

    Shape: {command: {"help", "flags": [(opt, help)], "choices": {...},
                     "subs": {sub: {"help", "flags", "choices"}}}}
    """
    tree: dict = {}
    top = _sub_action(parser)
    if top is None:
        return tree
    top_helps = {a.dest: a.help or "" for a in top._choices_actions}
    for name, cmd_parser in top.choices.items():
        entry: dict = {
            "help": top_helps.get(name, ""),
            "flags": _flag_pairs(cmd_parser),
            "choices": _choice_map(cmd_parser),
            "subs": {},
        }
        nested = _sub_action(cmd_parser)
        if nested is not None:
            nested_helps = {a.dest: a.help or "" for a in nested._choices_actions}
            for sub_name, sub_parser in nested.choices.items():
                entry["subs"][sub_name] = {
                    "help": nested_helps.get(sub_name, ""),
                    "flags": _flag_pairs(sub_parser),
                    "choices": _choice_map(sub_parser),
                }
        tree[name] = entry
    return tree


def _zsh_script(tree: dict) -> str:
    """zsh completion: structure rendered from the parse tree; the rclone remote-name hook exists
    only in the bash version (the old zsh script never had one either)."""
    locals_: list[str] = ["    local -a command_specs"]
    assigns: list[str] = []
    cmd_specs = [f"        '{cmd}:{entry['help']}'" for cmd, entry in tree.items()]
    branches: list[str] = []

    for cmd, entry in tree.items():
        safe = cmd.replace("-", "_")
        subs = entry["subs"]
        if subs:
            locals_.append(f"    local -a {safe}_specs")
            sub_specs = [f"        '{name}:{info['help']}'" for name, info in subs.items()]
            assigns.append(f"    {safe}_specs=(\n" + "\n".join(sub_specs) + "\n    )")
            case_sub: list[str] = []
            for sub_name, info in subs.items():
                flags_zsh = " ".join(f"'{opt}[{help}]'" for opt, help in info["flags"])
                choices = info["choices"]
                if choices:
                    for dest, values in choices.items():
                        arr = f"{safe}_{sub_name.replace('-', '_')}_specs"
                        locals_.append(f"    local -a {arr}")
                        assigns.append(f"    {arr}=({' '.join(repr(v) for v in values)})")
                        case_sub.append(f"""            {sub_name})
                if (( CURRENT == 4 )); then
                    if [[ "$words[CURRENT]" == -* ]]; then
                        _values '{cmd} {sub_name} options' {flags_zsh}
                    else
                        _describe -V '{dest}' {arr}
                    fi
                    return
                fi
                ;;""")
                else:
                    case_sub.append(f"""            {sub_name})
                if (( CURRENT == 4 )); then
                    _values '{cmd} {sub_name} options' {flags_zsh}
                    return
                fi
                ;;""")
            inner = "        case \"$words[3]\" in\n" + "\n".join(case_sub) + "\n        esac"
            branches.append(
                f"""        {cmd})
            if (( CURRENT == 3 )); then
                _describe -V '{cmd} commands' {safe}_specs
                return
            fi
{inner}
            ;;"""
            )
        else:
            # Direct command: options from CURRENT==3 on; positional choices (completion's shell)
            # offer their values first
            flags_zsh = " ".join(f"'{opt}[{help}]'" for opt, help in entry["flags"])
            choices = entry["choices"]
            if choices:
                dest, values = next(iter(choices.items()))
                arr = f"{safe}_{dest}_specs"
                locals_.append(f"    local -a {arr}")
                assigns.append(f"    {arr}=({' '.join(repr(v) for v in values)})")
                branches.append(f"""        {cmd})
            if (( CURRENT == 3 )); then
                if [[ "$words[CURRENT]" == -* ]]; then
                    _values '{cmd} options' {flags_zsh}
                else
                    _describe -V '{dest}' {arr}
                fi
                return
            fi
            ;;""")
            else:
                branches.append(f"""        {cmd})
            if (( CURRENT == 3 )); then
                _values '{cmd} options' {flags_zsh}
                return
            fi
            ;;""")

    return f"""#compdef yhub
_yhub_completion() {{
{chr(10).join(locals_)}
    command_specs=(
{chr(10).join(cmd_specs)}
    )
{chr(10).join(assigns)}
    if (( CURRENT == 2 )); then
        _describe -V 'yhub commands' command_specs
        return
    fi
    case "$words[2]" in
{chr(10).join(branches)}
    esac
}}
compdef _yhub_completion yhub
"""


def _bash_script(tree: dict) -> str:
    """bash completion: also rendered from the parse tree; the rclone remote-name hook is kept."""
    cmds = " ".join(tree)
    cmd_blocks: list[str] = []
    for cmd, entry in tree.items():
        subs = entry["subs"]
        if subs:
            sub_names = " ".join(subs)
            case_lines = []
            for sub_name, info in subs.items():
                flags = " ".join(opt for opt, _ in info["flags"])
                choices_vals = " ".join(v for vals in info["choices"].values() for v in vals)
                case_lines.append(
                    f"""        {sub_name})
            if [[ $cur == -* ]]; then
                COMPREPLY=( $(compgen -W "{flags}" -- "$cur") )
            else
                COMPREPLY=( $(compgen -W "{choices_vals}" -- "$cur") )
            fi
            return 0
            ;;"""
                )
            cmd_blocks.append(
                f"""    if [[ $COMP_CWORD -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "{sub_names}" -- "$cur") )
        return 0
    fi
    if [[ $COMP_CWORD -ge 3 ]]; then
        case "$sub" in
""" + "\n".join(case_lines) + """
        esac
    fi"""
            )
        else:
            flags = " ".join(opt for opt, _ in entry["flags"])
            cmd_blocks.append(
                f"""    if [[ $COMP_CWORD -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "{flags}" -- "$cur") )
        return 0
    fi"""
            )
    # Top-level command choices (yhub completion <TAB> → shell)
    top_choices = []
    for cmd, entry in tree.items():
        if not entry["subs"] and entry["choices"]:
            vals = " ".join(v for vs in entry["choices"].values() for v in vs)
            top_choices.append(
                f"""    if [[ $cmd == "{cmd}" && $COMP_CWORD -eq 2 && $cur != -* ]]; then
        COMPREPLY=( $(compgen -W "{vals}" -- "$cur") )
        return 0
    fi"""
            )
    case_body = "\n".join(
        f'''    if [[ $cmd == "{cmd}" ]]; then
{block}
    fi'''
        for (cmd, _), block in zip(tree.items(), cmd_blocks)
    )
    # The bash script below is printed verbatim: its regexes (\\( \\) \\1) are not Python
    # escapes, so this must be a raw string — otherwise every start emits a SyntaxWarning
    # (measured 2026-09-29). Hooks bind by command name.
    return r"""_yhub_completion() {
    local cur cmd sub
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    if [[ $COMP_CWORD -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "__CMDS__" -- "$cur") )
        return 0
    fi
    cmd="${COMP_WORDS[1]}"; sub="${COMP_WORDS[2]:-}"
    # Dynamic hook 1: rclone remote names (not derivable from declarations; ask yhub).
    if [[ $cmd == "rclone" && ( $sub == mount || $sub == umount || $sub == probe ) && $COMP_CWORD -eq 3 && $cur != -* ]]; then
        COMPREPLY=( $(compgen -W "$(yhub rclone list --json 2>/dev/null | sed -n 's/.*"name": "\([^"]*\)".*/\1/p')" -- "$cur") )
        return 0
    fi
__TOP_CHOICES__
__CASES__
}
complete -F _yhub_completion yhub
""".replace("__CMDS__", cmds).replace(
        "__TOP_CHOICES__", "\n".join(top_choices)
    ).replace("__CASES__", case_body)


def _completion_script(shell: str, parser: argparse.ArgumentParser) -> str:
    tree = _parse_tree(parser)
    if shell == "zsh":
        return _zsh_script(tree)
    return _bash_script(tree)


# --------------------------------------------------------------------------- dispatch


def main(argv: list[str] | None = None) -> int:
    args_list = list(sys.argv[1:] if argv is None else argv)
    # --version takes a fast path: printing a version number must not import every adapter
    # (all other commands and help do need the full inventory)
    if args_list in (["-v"], ["--version"]):
        print(_version())
        return 0

    parser = _build_parser()
    args = parser.parse_args(args_list)

    if args.command == "completion":
        print(_completion_script(args.shell, parser))
        return 0

    if args.command == "gui":
        if args.dev:
            os.environ["YHUB_GUI_NO_FRONTEND"] = "1"
        from yhub.server.main import run_gui

        return run_gui(port=args.port, open_browser=not args.no_open, dev=args.dev)

    if args.command == "mcp":
        from yhub.server.mcp_server import run_mcp

        return run_mcp()

    if args.command == "plugin":
        return _run_plugin(args, parser)

    if args.command is not None:
        from . import generate

        code = generate.dispatch(args)
        if code >= 0:
            return code
        # Command given but no subcommand (`yhub rclone`): print that command's help
        top = _sub_action(parser)
        if top is not None and args.command in top.choices:
            top.choices[args.command].print_help()
        return 0

    parser.print_help()
    return 0


# --------------------------------------------------------------------------- plugin management


def _run_plugin(args, parser) -> int:
    """`yhub plugin …` — install/remove/enable/disable (all of it lives in
    yhub/server/adapters/plugin_manager.py).

    Deliberately **not** declared via `faces.cli`: declared commands are provided by plugins, and this
    is exactly the command needed to bring disabled/broken plugins back. So it is a host command,
    always present.
    """
    from yhub.server.adapters import plugin_manager as pm

    sub = getattr(args, "plugin_command", None)
    if not sub:
        top = _sub_action(parser)
        if top is not None and "plugin" in top.choices:
            top.choices["plugin"].print_help()
        return 0

    def _fail(exc: Exception) -> int:
        message = getattr(exc, "message", str(exc))
        hint = getattr(exc, "hint", "")
        print(f"× {message}", file=sys.stderr)
        if hint:
            print(f"  {hint}", file=sys.stderr)
        return 1

    try:
        if sub == "list":
            rows = pm.list_plugins()
            if args.updates:
                try:
                    updates = {u["id"]: u for u in pm.check_updates()}
                except pm.PluginError:
                    updates = {}
                for row in rows:
                    row.update(updates.get(row["id"], {}))
            if args.json:
                import json as _json

                print(_json.dumps(rows, ensure_ascii=False, indent=2))
            else:
                _print_plugin_table(rows)
            return 0
        if sub == "registry":
            action = getattr(args, "registry_command", None) or "get"
            if action == "get":
                print(pm.registry_url())
                return 0
            from yhub.server.adapters.settings import set_values

            url = "" if action == "clear" else args.url.strip()
            set_values({"plugins_registry_url": url})
            print(url or tr("cli.plugin.registry_cleared"))
            return 0
        if sub == "search":
            rows = pm.catalog(getattr(args, "query", ""))
            if not rows:
                print(tr("cli.plugin.no_matches"))
                return 0
            for row in rows:
                mark = (
                    tr("cli.plugin.mark.installed") if row.get("installed") else tr("cli.plugin.mark.available")
                )
                ver = row.get("version") or "—"
                print(f"{row['id']:26s} {row.get('name', ''):20s} {ver:10s} {mark:4s} {row.get('description', '')}")
            return 0
        if sub == "info":
            spec = args.spec.strip()
            installed = pm._installed_ids()  # noqa: SLF001
            if spec in installed:
                manifest = pm._manifest_of(installed[spec])  # noqa: SLF001
                lock = (pm.read_lock().get("plugins") or {}).get(spec) or {}
                import json as _json

                print(_json.dumps({**manifest, "lock": lock}, ensure_ascii=False, indent=2))
                return 0
            entry = pm.registry_entry(spec)
            import json as _json

            print(_json.dumps(entry, ensure_ascii=False, indent=2))
            return 0
        if sub == "install":
            source = args.spec
            if not getattr(args, "yes", False) and sys.stdin.isatty() and ("/" in source or source.startswith(("http://", "https://"))):
                print(tr("cli.plugin.third_party_prompt", source=source))
                if input(tr("cli.plugin.confirm_prompt")).strip().lower() not in ("y", "yes"):
                    print(tr("cli.plugin.cancelled"))
                    return 1
            result = pm.install_spec(
                source,
                force=args.force,
                ref=getattr(args, "ref", ""),
                plugin_id=(getattr(args, "id", "") or None),
            )
            extra = tr("cli.plugin.restart_required") if result.get("restart_required") else ""
            print(tr("cli.plugin.installed", id=result["id"], version=result.get("version") or "",
                      source=result.get("source"), extra=extra))
            return 0
        if sub == "update":
            if not args.all and not args.plugin_id:
                print(tr("cli.plugin.update_need_id"), file=sys.stderr)
                return 2
            result = pm.update_plugins(None if args.all else [args.plugin_id])
            for row in result["updated"]:
                print(tr("cli.plugin.updated", id=row["id"], version=row.get("version") or ""))
            for row in result["skipped"]:
                print(tr("cli.plugin.skipped", id=row["id"], reason=row["reason"]))
            if not result["updated"] and not result["skipped"]:
                print(tr("cli.plugin.nothing_to_update"))
            return 0
        if sub == "remove":
            result = pm.remove_plugin(args.plugin_id, purge=args.purge)
            extra = (
                tr("cli.plugin.removed_purged") if result["purged_config"] else tr("cli.plugin.removed_kept")
            )
            print(tr("cli.plugin.removed", id=result["id"], extra=extra))
            return 0
        if sub in ("enable", "disable"):
            result = pm.set_enabled(args.plugin_id, sub == "enable")
            key = "cli.plugin.enabled" if result["enabled"] else "cli.plugin.disabled"
            print(tr(key, id=result["id"]))
            return 0

    except pm.PluginError as exc:
        return _fail(exc)
    except ValueError as exc:  # bad declaration (the loader fails loudly)
        return _fail(exc)

    print(tr("cli.plugin.unknown_subcommand", sub=sub), file=sys.stderr)
    return 2


def _print_plugin_table(rows: list[dict]) -> None:
    """Human table: core vs third-party, installed, enabled, removable."""
    core = [r for r in rows if r.get("kind") == "core"]
    other = [r for r in rows if r.get("kind") != "core"]
    print(tr("cli.plugin.core_header", count=len(core)))
    for row in core:
        mark = tr("cli.plugin.mark_enabled") if row["enabled"] else tr("cli.plugin.mark_disabled")
        print(f"  {row.get('icon', '')} {row['id']:22s} {mark}")
    print()
    print(tr("cli.plugin.third_party_header", count=len(other)))
    if not other:
        print(tr("cli.plugin.no_third_party"))
    for row in other:
        if not row["installed"]:
            print(f"  {row.get('icon', '')} {row['id']:22s} " + tr("cli.plugin.not_installed"))
            continue
        if row.get("broken"):
            print(f"  ⚠️ {row['id']:21s} " + tr("cli.plugin.broken", broken=row["broken"]))
            continue
        mark = tr("cli.plugin.mark_enabled") if row["enabled"] else tr("cli.plugin.mark_disabled")
        note = tr("cli.plugin.disabled_file_note") if row.get("disabled_file") else ""
        ver = f" v{row['version']}" if row.get("version") else ""
        src = f" [{row.get('source')}]" if row.get("source") else ""
        upd = tr("cli.plugin.update_available") if row.get("update_available") else ""
        print(f"  {row.get('icon', '')} {row['id']:22s} {mark}{ver}{src}{upd}{note}")


if __name__ == "__main__":
    raise SystemExit(main())
