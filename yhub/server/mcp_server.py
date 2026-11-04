"""yhub MCP server -- lets AI agents call every tool over the Model Context Protocol.

Start it with `uv run yhub mcp` (stdio transport, works with any MCP client).

Requires mcp[cli]>=1.9.0 (an optional dependency in pyproject.toml; run `uv sync` first).
"""

from __future__ import annotations

import inspect
import sys

from yhub import __version__
from yhub.i18n import tr, tr_text


def run_mcp() -> int:
    """Run the MCP server over stdio."""
    from mcp.server.mcpserver import MCPServer

    from .adapters import ToolError, discover_adapters
    from .adapters.params import mcp_signature

    mcp = MCPServer(
        "yhub",
        version=__version__,
        instructions=tr("mcp.instructions"),
    )

    for entry in discover_adapters():
        meta = entry["meta"]
        faces = meta.get("faces") or {}
        for tool_def in faces.get("mcp", []):
            handler = tool_def["handler"]
            name = tool_def["name"]
            description = tr_text(tool_def["description"])

            # A declared params list drives the generated signature (shared with the
            # HTTP/CLI faces); without one, fall back to the handler's own signature.
            if tool_def.get("params") is not None:
                sig = mcp_signature(
                    tool_def["params"], where=f"mcp:{name}"
                )
                pnames = list(sig.parameters.keys())
            else:
                sig = inspect.signature(handler)
                pnames = list(sig.parameters.keys())

            def _make_wrapper(fn, pnames):
                async def wrapper(**kwargs):
                    call_args = {k: v for k, v in kwargs.items() if k in pnames}
                    try:
                        result = fn(**call_args)
                        return result
                    except ToolError as exc:
                        return {"error": exc.message, "hint": exc.hint}
                return wrapper

            wrapper = _make_wrapper(handler, pnames)
            wrapper.__name__ = name
            wrapper.__doc__ = description
            wrapper.__signature__ = sig

            mcp.tool(name=name, description=description)(wrapper)

    mcp.run(transport="stdio")
    return 0
