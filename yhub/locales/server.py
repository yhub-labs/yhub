"""GUI server (`yhub/server/main.py`) — middleware rejections and startup guidance.

Keys are ``server.<name>``; placeholders are plain ``{name}`` parameters passed to ``tr()``.
The ``ZH`` values are the historical literals verbatim, so the default zh-CN UI/API is unchanged.
"""

EN = {
    # Host gate (DNS rebinding)
    "server.host_not_allowed": "Host not accepted: {host}",
    "server.host_not_allowed_hint": "Only the local loopback is served; use 127.0.0.1 / localhost",
    # Capsule isolation: a capsule subdomain / capsule page may not reach the host API
    "server.capsule_host_api_forbidden": "A capsule may not call the host API",
    "server.capsule_host_api_forbidden_hint": (
        "A capsule should only access files in its own folder"
    ),
    "server.capsule_host_api_forbidden_hint_external": (
        "A capsule should only access files in its own folder; for external data call the https API directly"
    ),
    "server.capsule_subdomain_only_capsules": "A capsule subdomain only serves /capsules/*",
    # Cross-origin writes
    "server.cross_origin_write_denied": "Cross-origin writes are rejected",
    "server.cross_origin_write_denied_hint": (
        "Write endpoints only accept local pages / the desktop shell"
    ),
    # Startup guidance (CLI output)
    "server.frontend_not_built": "Note: the frontend has not been built yet. Run:",
    "server.frontend_dev_mode_hint": (
        "or use dev mode: yhub gui --dev  together with  cd web && npm run dev"
    ),
}

ZH = {
    "server.host_not_allowed": "不接受的 Host：{host}",
    "server.host_not_allowed_hint": "只监听本机回环，请用 127.0.0.1 / localhost",
    "server.capsule_host_api_forbidden": "胶囊不能调用宿主接口",
    "server.capsule_host_api_forbidden_hint": "胶囊只应访问自己文件夹里的文件",
    "server.capsule_host_api_forbidden_hint_external": (
        "胶囊只应访问自己文件夹里的文件；需要外部数据请直接访问 https 接口"
    ),
    "server.capsule_subdomain_only_capsules": "胶囊的子域只提供 /capsules/*",
    "server.cross_origin_write_denied": "跨源写入被拒",
    "server.cross_origin_write_denied_hint": "写接口只接受本机页面 / 桌面壳",
    "server.frontend_not_built": "提示：还没构建前端。先执行：",
    "server.frontend_dev_mode_hint": "或者用开发模式：yhub gui --dev  配合  cd web && npm run dev",
}
