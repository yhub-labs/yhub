"""English text for legacy Chinese metadata (TOOL_META / tile titles / hotkey names).

Kept as source-text keys so existing adapters do not need to change their declarations.
"""

TEXT_EN = {
    # core plugin display names
    "Rclone 磁盘": "Rclone disks",
    "RSS 订阅": "RSS feeds",
    "定时任务": "Scheduler",
    "信息墙": "Dashboard",
    # core descriptions
    "挂载 rclone 配置里的远端（含加密盘），并盯着挂载本身": "Mount rclone remotes (encrypted or plain) and watch the mounts",
    "多个 RSS/Atom 源，一个源一个格子；地址在面板 / CLI / rss.json 里改": "Multiple RSS/Atom feeds, one cell per feed; edit sources in the panel, CLI or rss.json",
    "多个 RSS/Atom 源，一个源一格；地址在面板或 rss.json 里改": "Multiple RSS/Atom feeds, one cell per feed; edit sources in the panel or rss.json",
    "cron 式调度库内脚本，运行状态上信息墙": "Schedule library scripts with cron syntax and show runs on the dashboard",
    "cron 式调度：到点跑库内脚本，状态上信息墙": "Run library scripts on a cron schedule and show their status on the dashboard",
    # common tool statuses
    "就绪": "Ready",
    "未安装": "Not installed",
    "未安装 rclone": "rclone is not installed",
    "未挂载": "No mounts",
    "未配置": "Not configured",
    "运行中": "Running",
    "空闲": "Idle",
    "已挂载": "Mounted",
    # hotkey actions
    "呼出 / 收起面板": "Show / hide panel",
    "只呼出面板": "Show panel only",
    "只收起面板": "Hide panel only",
    # tile titles
    "rclone 挂载": "rclone mounts",
    "今日待办": "Today",
    "项目到期": "Projects due",
    "异常总览": "Alerts",
    # host summaries
    "一切正常": "All good",

    # RSS / scheduler CLI and route param help
    "true（默认）会联网抓一次；false 只读缓存": "true (default) fetches live; false reads the cache",
    "订阅地址（http/https）": "Feed URL (http/https)",
    "订阅 id（= 格子 id 的后半段）；不填按主机名起一个，填已有的就是改它": "Feed id (= second half of the cell id); omit to derive it from the host, or pass an existing id to update it",
    "显示名，不填用主机名": "Display name (defaults to the host name)",
    "这个源最多取几条（1~20）；不填沿用原值": "Max items for this feed (1-20); omit to keep the current value",
    "上不上墙；不填沿用原值": "Show on the dashboard; omit to keep the current value",
    "订阅 id，见 GET /api/rss": "Feed id (see GET /api/rss)",
    "最多几条（1~20）": "Max items (1-20)",
    "订阅 id（不填按主机名自动起；填已有的就是改它）": "Feed id (derive from the host, or pass an existing id to update it)",
    "显示名": "Display name",
    "最多取几条（1~20）": "Max items (1-20)",
    "订阅 id，见 rss_list": "Feed id (see rss_list)",
    "按任务 id 过滤": "Filter by job id",
    "1~200，默认 20": "1-200, default 20",

    # rclone: route / MCP parameter help and MCP tool descriptions
    "远端名，如 vault": "Remote name, e.g. vault",
    "远端名": "Remote name",
    "挂载点，空 = ~/<name>": "Mount point; empty = ~/<name>",
    "明文密码，只交给 rclone 这一次（不落盘不进 argv）": (
        "Cleartext password, handed to rclone once (never on disk, never in argv)"
    ),
    "只读挂载": "Mount read-only",
    "允许非空挂载点": "Allow a non-empty mount point",
    "透传的额外 rclone 开关": "Extra rclone flags, passed through as-is",
    "看 rclone 配置里的远端与当前挂载情况（挂载点、进程、最近探测）": (
        "List the remotes in the rclone config and what is mounted right now "
        "(mount point, process, latest probe)"
    ),
    "读一次某个已挂载远端（根目录条目与容量；带超时，不会卡住）": (
        "Read a mounted remote once (top-level entries and capacity; timed out, never hangs)"
    ),
    "卸载某个 rclone 挂载（不碰密码，只卸）": "Unmount an rclone mount (no password involved)",

    # rss: MCP tool descriptions
    "列出所有 RSS/Atom 订阅及其状态（条目数、最近抓取、读不到的原因）": (
        "List every RSS/Atom feed and its state (item count, last fetch, why it failed)"
    ),
    "添加或修改一条 RSS/Atom 订阅（同一个 id 再调一次 = 改它的地址/名称/开关）": (
        "Add or update an RSS/Atom feed (same id = update its URL, name or switch)"
    ),
    "删除一条 RSS 订阅（它的信息墙格子随之消失）": (
        "Remove an RSS feed (its dashboard cell disappears with it)"
    ),
    "读某个订阅的最新条目（标题、链接、发布时间）": (
        "Read the latest items of one feed (title, link, published time)"
    ),
}
