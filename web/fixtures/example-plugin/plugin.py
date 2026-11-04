"""示例外置插件（``web/fixtures/example-plugin/``）：`web/verify-plugins.mjs` 的验收样例。

为什么住 web/fixtures 而不是仓库 ``plugins/``：那个目录是**分发源**——提交钩子的
``yhub plugin sync`` 会把里面每个插件装进本机配置根，验收样例不该混进日常装机；
本目录只有验收脚本会 ``cpSync`` 进配置根，跑完即清理。

它故意覆盖外置插件机制的每条通道，且结果**确定**（不依赖本机有没有开某个服务）：
  * ``fetch_ok``    —— 常绿格，成功信封（``{ok: true, status, summary, detail}``）；
  * ``fetch_down``  —— 必败格，失败信封（``{ok: false, error: {message, hint}}``），
                       宿主必须把它变成人话 ``source_error``（R2，绝不假绿）；
  * ``cli_hello``   —— CLI 面（``yhub exdemo hello [--json]``）；
  * ``mcp_hello``   —— MCP 面（``example_hello``）；
  * ``config.greeting`` —— 配置声明（``GET /api/plugins`` 的 config 段）。

三条铁律照旧：纯标准库；失败一律 ``ToolError("人话", hint="怎么办")``；不碰沙盒世界。
"""

from __future__ import annotations

from yhub.plugin_api import ToolError

# 声明（id/name/icon/faces/presentation/config）全在同目录 plugin.json；这里只有代码钩子。


def fetch_ok(specs: list[dict]) -> dict:
    """常绿格：固定成功值（验证「装入即出格、取数成功信封」这条路）。"""
    spec = specs[0]
    return {
        spec["id"]: {
            "ok": True,
            "status": "ok",
            "summary": "示例常绿：固定成功值",
            "detail": [{"text": "这条 detail 来自示例插件", "href": spec.get("href")}],
        }
    }


def fetch_down(specs: list[dict]) -> dict:
    """必败格：永远失败（验证宿主把失败翻成人话 source_error，绝不假绿）。"""
    spec = specs[0]
    return {
        spec["id"]: {
            "ok": False,
            "error": {
                "message": "示例必败：这是验收样例的失败路径",
                "hint": "故意的——用来断言 source_error 的 message 与 hint 都非空",
            },
        }
    }


def mcp_hello() -> dict:
    """MCP 面：固定成功信封。"""
    return {"ok": True, "summary": "hello from example-plugin"}


def cli_hello(json_out: bool = False):
    """CLI 面：``yhub exdemo hello [--json]``。"""
    view = mcp_hello()
    if json_out:
        return view
    print(view["summary"])
    return 0


TOOL_META = {}  # 外置插件的 TOOL_META 只放代码钩子；声明字段住 plugin.json
