"""Capsule hosting (``yhub/server/adapters/capsules.py``) — errors, hints and status details.

Keys are ``capsules.<name>``; placeholders are plain ``{name}`` parameters passed to ``tr()``.
The ``ZH`` values are the historical literals verbatim, so the default zh-CN UI/API is unchanged.
"""

EN = {
    # dir_state() → "detail" shown next to a configured capsules_dir
    "capsules.dir_detail_missing": "Directory does not exist",
    "capsules.dir_detail_not_dir": "This path is not a directory",
    "capsules.dir_detail_unwritable": "Directory is not writable",
    "capsules.dir_detail_disabled": "Your own capsule library is turned off (built-in examples only)",
    # ensure_capsules_dir(): validation
    "capsules.dir_absolute_required": "Use an absolute path (or one starting with ~/); got {path}",
    "capsules.dir_absolute_required_hint": (
        'for example "~/Capsules" or "~/Y-Hub/capsules"; leave it empty to use the default location '
        "(<data folder>/capsules)"
    ),
    "capsules.dir_exists_not_dir": "This path already exists but is not a directory: {path}",
    "capsules.dir_exists_not_dir_hint": "Choose another path, or move that file away first",
    "capsules.dir_create_failed": "Could not create this directory: {error}",
    "capsules.dir_create_failed_hint": (
        "Check the parent directory's permissions, or pick another location (such as your home folder)"
    ),
    "capsules.dir_not_writable": "The directory was created but is not writable: {path}",
    "capsules.dir_not_writable_hint": (
        "Pick a location you can write to (such as a folder in your home directory)"
    ),
    # Per-capsule subdomain: the main host no longer accepts writes
    "capsules.subdomain_write_forbidden": (
        "Per-capsule subdomains are on: writes must go through the capsule's own address"
    ),
    "capsules.subdomain_write_forbidden_hint": (
        "Use http://{host}:<port>/capsules/{path}; the main address only redirects (302) "
        "and no longer accepts writes"
    ),
    # Cross-capsule access
    "capsules.other_capsule_forbidden": "This capsule can only access its own folder",
    "capsules.other_capsule_forbidden_hint": (
        "The requested {path} does not belong to the current capsule ({scope}); "
        "keep data inside the capsule's own folder (e.g. <capsule>/data/…)"
    ),
    "capsules.scope_unknown": "unrecognized",
    # If-Match gate (412)
    "capsules.stale_conflict": (
        "{path} was changed elsewhere (on disk it is {current}, yours is {if_match})"
    ),
    "capsules.stale_conflict_hint": (
        "Reload the page to read the latest content before saving, "
        "so you do not overwrite what was just written"
    ),
    # 404
    "capsules.not_found_no_roots_hint": (
        "Your own capsule library is turned off and the bundled system layer (capsules/) is missing: "
        "turn the library on (Settings → capsules), or point capsules_dir at the folder that holds "
        "your .html files"
    ),
    "capsules.not_found_layers_hint": (
        "Check these layers in order for this file: {roots}; without a suffix the lookup tries "
        "<name>.html / <name>.htm / <name>/index.html / <name>/<name>.html in turn; data files must "
        "live inside some capsule's own folder (e.g. <capsule>/data/…, where the capsule may create "
        "files freely — the entry html itself is never created)"
    ),
    "capsules.not_found": "No such capsule: {path}",
    # Write gates
    "capsules.write_origin_forbidden": (
        "Writing back to files in the library is not allowed from this origin"
    ),
    "capsules.delete_origin_forbidden": (
        "Changing files in the library is not allowed from this origin"
    ),
    "capsules.system_layer_read_only": (
        "Saving a bundled capsule failed: the software-owned copy cannot be written and your library "
        "could not be created"
    ),
    "capsules.system_layer_read_only_hint": (
        "Check that capsules_dir points at a writable directory (Settings → capsules), then save again"
    ),
    # Size / count limits (413)
    "capsules.file_too_large": "Content exceeds the per-file limit of {limit} MiB",
    "capsules.sandbox_file_too_large_hint": (
        "Sandbox files are stored one file at a time; if it is too big, split it up or store it differently"
    ),
    "capsules.entry_file_too_large_hint": (
        "A single-file capsule is saved as one whole file; if it really is bigger, split it up or "
        "store it differently"
    ),
    "capsules.capsule_quota_exceeded": "The capsule folder exceeds the total quota of {limit} MiB",
    "capsules.capsule_quota_exceeded_hint": (
        "Delete snapshots/data files you no longer need; the limit is MAX_CAPSULE_BYTES in "
        "yhub/server/adapters/capsules.py"
    ),
    "capsules.too_many_files": (
        "The capsule folder holds too many files ({count} ≥ limit {limit})"
    ),
    "capsules.too_many_files_hint": (
        "Delete data files you no longer need before writing; the limit is MAX_SANDBOX_FILES in "
        "yhub/server/adapters/capsules.py"
    ),
    # DELETE
    "capsules.entry_delete_forbidden": "The capsule itself (its entry html) does not support DELETE",
    "capsules.entry_delete_forbidden_hint": (
        "Deleting a capsule means deleting that file in your library; only sandbox data files may be "
        "deleted by the capsule itself"
    ),
    "capsules.delete_failed": "Delete failed: {error}",
    "capsules.delete_failed_hint": (
        "Check that the file is not open elsewhere and that the capsule folder is writable"
    ),
    # import / declared metadata / library delete
    "capsules.import_suffix": "Only .html / .htm files are capsules; got {name}",
    "capsules.import_suffix_hint": (
        "A capsule is one HTML page (or a folder with index.html); export or rename the file to "
        ".html and try again"
    ),
    "capsules.import_too_large_hint": (
        "A capsule is one whole file; if it really is bigger, split it up or store it differently"
    ),
    "capsules.import_empty": "The file is empty",
    "capsules.import_empty_hint": "Pick a file that actually contains a page",
    "capsules.import_failed": "Import failed: {error}",
    "capsules.import_failed_hint": (
        "Check that the capsule library is writable, then try again (Settings → capsules)"
    ),
    "capsules.import_path_missing": "No such file to import: {path}",
    "capsules.import_path_missing_hint": "Pick the file again — it may have been moved or renamed",
    "capsules.import_name_taken": "A capsule with this name already exists: {name}",
    "capsules.import_name_taken_hint": (
        "Rename the file, or import it again with replace to overwrite the existing capsule"
    ),
    "capsules.import_body_missing": "Nothing to import: provide path, or filename + content",
    "capsules.import_body_missing_hint": (
        'for example {"path": "/Users/you/Downloads/thing.html"}'
    ),
    "capsules.import_content_invalid": "The uploaded content is not valid base64: {error}",
    "capsules.import_content_invalid_hint": "Pick the file again; it may have been truncated in transit",
    "capsules.too_many_capsules": "The library already holds {limit} capsules",
    "capsules.too_many_capsules_hint": (
        "Delete capsules you no longer need first; the limit is MAX_APPS in "
        "yhub/server/adapters/capsules.py"
    ),
    "capsules.meta_body_invalid": "The meta section must be a JSON object",
    "capsules.meta_body_invalid_hint": 'for example {"title": "My capsule", "order": 10}',
    "capsules.library_disabled": "Your own capsule library is turned off",
    "capsules.library_disabled_hint": (
        "Turn it on in Settings → capsules (the default location is created automatically)"
    ),
    "capsules.meta_missing_relpath": "Missing the capsule identifier (relpath) to act on",
    "capsules.meta_missing_relpath_hint": 'for example {"relpath": "hello/index.html"}',
    "capsules.meta_order_invalid": "Order must be an integer",
    "capsules.meta_order_invalid_hint": "Use a small integer like 10 or 20 (range ±{limit}); lower shows first",
    "capsules.meta_icon_too_large": "The icon is larger than {limit} KB",
    "capsules.meta_icon_too_large_hint": (
        "Use an emoji, a short label, an https:// URL or a small data: image"
    ),
    "capsules.meta_icon_invalid": "This icon value is not allowed: {value}",
    "capsules.meta_icon_invalid_hint": (
        "Use an emoji, a short label, an https:// URL or a data:image/… value"
    ),
    "capsules.delete_no_library": "No capsule library is configured, so there is nothing to delete",
    "capsules.delete_no_library_hint": (
        "Turn your capsule library on first (Settings → capsules); an empty path already means the "
        "default location"
    ),
    "capsules.delete_system_entry": "{path} is a bundled capsule shipped with the software",
    "capsules.delete_system_entry_hint": (
        "Disable it instead (that is what the enable/disable switch is for); the software owns the "
        "file and an upgrade replaces it"
    ),
    # toggle
    "capsules.body_must_be_object": "Request body must be a JSON object",
    "capsules.body_must_be_object_hint": 'for example {"id": "system:hello/index.html", "enabled": false}',
    "capsules.toggle_missing_id": "Missing the capsule identifier to act on",
    "capsules.toggle_missing_id_hint": "Provide id or relpath",
}

ZH = {
    "capsules.dir_detail_missing": "目录不存在",
    "capsules.dir_detail_not_dir": "这个路径不是目录",
    "capsules.dir_detail_unwritable": "目录不可写",
    "capsules.dir_detail_disabled": "用户胶囊库已关闭（只看内置示例）",
    "capsules.dir_absolute_required": "要用绝对路径（或 ~/ 开头），现在是 {path}",
    "capsules.dir_absolute_required_hint": (
        '比如 "~/胶囊" 或 "~/Y-Hub/capsules"；留空 = 用默认位置（数据目录下的 capsules）'
    ),
    "capsules.dir_exists_not_dir": "这个路径已经存在，但不是目录：{path}",
    "capsules.dir_exists_not_dir_hint": "换一个路径，或者先把那个文件挪走",
    "capsules.dir_create_failed": "建不了这个目录：{error}",
    "capsules.dir_create_failed_hint": "检查父目录权限，或换一个位置（比如主目录下）",
    "capsules.dir_not_writable": "目录建好了但不可写：{path}",
    "capsules.dir_not_writable_hint": "换一个有写权限的位置（比如主目录下的文件夹）",
    "capsules.subdomain_write_forbidden": "开启了每胶囊子域：写入必须走胶囊自己的地址",
    "capsules.subdomain_write_forbidden_hint": (
        "请用 http://{host}:<port>/capsules/{path}；主地址只做 302 跳转，不再接受写入"
    ),
    "capsules.other_capsule_forbidden": "这个胶囊只能访问自己的文件夹",
    "capsules.other_capsule_forbidden_hint": (
        "请求的 {path} 不属于当前胶囊（{scope}）；数据请放在胶囊自己的文件夹里（如 <胶囊>/data/…）"
    ),
    "capsules.scope_unknown": "未识别",
    "capsules.stale_conflict": "{path} 在别处被改过了（现在是 {current}，你手上是 {if_match}）",
    "capsules.stale_conflict_hint": "刷新页面重新读取最新内容再保存，避免覆盖掉刚写进去的东西",
    "capsules.not_found_no_roots_hint": (
        "用户胶囊库关着、也找不到内置系统层（capsules/）：在「配置」→「胶囊」里把它打开，"
        "或把 capsules_dir 指向库里放 .html 的目录"
    ),
    "capsules.not_found_layers_hint": (
        "依次检查这些层里有没有这个文件：{roots}；不带后缀会依次找 <名>.html / <名>.htm / "
        "<名>/index.html / <名>/<名>.html；数据文件要住在某个胶囊自己的文件夹里"
        "（如 <胶囊>/data/…，胶囊可在那里自由建文件，入口 html 本身不新建）"
    ),
    "capsules.not_found": "没有这个胶囊：{path}",
    "capsules.write_origin_forbidden": "不允许的来源写回库里的文件",
    "capsules.delete_origin_forbidden": "不允许的来源改动库里的文件",
    "capsules.system_layer_read_only": "内置胶囊保存失败：随包文件不能改，用户库也没能建出来",
    "capsules.system_layer_read_only_hint": (
        "检查「配置」里的 capsules_dir 是否指向一个可写目录，然后重试保存"
    ),
    "capsules.file_too_large": "内容超出单文件上限 {limit} MiB",
    "capsules.sandbox_file_too_large_hint": "沙盒文件按单文件保存；太大就该拆开或者换个存法",
    "capsules.entry_file_too_large_hint": "单文件胶囊按整份文件保存；确实更大就得拆开或者换个存法",
    "capsules.capsule_quota_exceeded": "胶囊文件夹超出总容量 {limit} MiB",
    "capsules.capsule_quota_exceeded_hint": (
        "清理不再需要的快照/数据文件；上限在 yhub/server/adapters/capsules.py 的 MAX_CAPSULE_BYTES"
    ),
    "capsules.too_many_files": "胶囊文件夹里的文件太多了（{count} ≥ 上限 {limit}）",
    "capsules.too_many_files_hint": (
        "清理不再需要的数据文件后再写；上限在 yhub/server/adapters/capsules.py 的 MAX_SANDBOX_FILES"
    ),
    "capsules.entry_delete_forbidden": "胶囊本体（入口 html）不支持 DELETE",
    "capsules.entry_delete_forbidden_hint": "删胶囊 = 去库里删那个文件；沙盒里的数据文件才归胶囊自己删",
    "capsules.delete_failed": "删除失败：{error}",
    "capsules.delete_failed_hint": "检查文件是否被别处占用，以及胶囊文件夹是否可写",
    "capsules.import_suffix": "只有 .html / .htm 才算胶囊，现在是 {name}",
    "capsules.import_suffix_hint": "胶囊就是一个 HTML 页面（或含 index.html 的文件夹）；先导出或改名成 .html 再试",
    "capsules.import_too_large_hint": "胶囊按整份文件保存；确实更大就得拆开或者换个存法",
    "capsules.import_empty": "这个文件是空的",
    "capsules.import_empty_hint": "换一个真的含页面内容的文件",
    "capsules.import_failed": "导入失败：{error}",
    "capsules.import_failed_hint": "检查胶囊库是否可写，然后重试（「配置」→ 胶囊）",
    "capsules.import_path_missing": "找不到要导入的文件：{path}",
    "capsules.import_path_missing_hint": "重新选一次文件——它可能已经被移动或改名",
    "capsules.import_name_taken": "库里已有同名胶囊：{name}",
    "capsules.import_name_taken_hint": "先把文件改个名，或用 replace 重新导入以覆盖已有胶囊",
    "capsules.import_body_missing": "没有可导入的内容：要给 path，或者 filename + content",
    "capsules.import_body_missing_hint": '比如 {"path": "/Users/you/Downloads/thing.html"}',
    "capsules.import_content_invalid": "上传内容的 base64 不合法：{error}",
    "capsules.import_content_invalid_hint": "重新选一次文件；内容可能在传输中被截断了",
    "capsules.too_many_capsules": "库里已经有 {limit} 个胶囊了",
    "capsules.too_many_capsules_hint": "先删掉不再需要的胶囊；上限在 yhub/server/adapters/capsules.py 的 MAX_APPS",
    "capsules.meta_body_invalid": "meta 这一段必须是 JSON 对象",
    "capsules.meta_body_invalid_hint": '比如 {"title": "我的胶囊", "order": 10}',
    "capsules.library_disabled": "用户胶囊库已关闭",
    "capsules.library_disabled_hint": "在「配置」→「胶囊」里打开它（默认位置会自动创建）",
    "capsules.meta_missing_relpath": "缺少要操作的胶囊标识（relpath）",
    "capsules.meta_missing_relpath_hint": '比如 {"relpath": "hello/index.html"}',
    "capsules.meta_order_invalid": "排序值必须是整数",
    "capsules.meta_order_invalid_hint": "用小整数，比如 10 或 20（范围 ±{limit}）；越小越靠前",
    "capsules.meta_icon_too_large": "图标超过 {limit} KB",
    "capsules.meta_icon_too_large_hint": "用 emoji、短文字、https:// 地址，或一张小的 data: 图片",
    "capsules.meta_icon_invalid": "这个图标值不允许：{value}",
    "capsules.meta_icon_invalid_hint": "用 emoji、短文字、https:// 地址，或 data:image/… 形式",
    "capsules.delete_no_library": "还没配胶囊库，没有东西可删",
    "capsules.delete_no_library_hint": "先在「配置」→「胶囊」里把用户胶囊库打开；路径留空就是默认位置",
    "capsules.delete_system_entry": "{path} 是随软件发布的内置胶囊",
    "capsules.delete_system_entry_hint": (
        "请改用它旁边的启用/禁用开关；随包文件归软件所有，升级会整体替换"
    ),
    "capsules.body_must_be_object": "请求体必须是 JSON 对象",
    "capsules.body_must_be_object_hint": '比如 {"id": "system:hello/index.html", "enabled": false}',
    "capsules.toggle_missing_id": "缺少要操作的胶囊标识",
    "capsules.toggle_missing_id_hint": "需提供 id 或 relpath",
}
