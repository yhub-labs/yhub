"""Y-Hub local server.

Design rules:
  * Tool capabilities live in yhub/server/adapters/; exporting TOOL_META registers a tool.
  * The frontend talks only to /api/* and never touches a shell.
  * The MCP server reuses the same adapters so AI agents can call them too.
"""

__all__ = ["main", "mcp_server"]
