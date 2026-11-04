"""Capsule hosting (``yhub/server/adapters/capsules.py``) — errors, hints and status details.

Keys are ``capsules.<name>``; placeholders are plain ``{name}`` parameters passed to ``tr()``.
The ``ZH`` values are the historical literals verbatim, so the default zh-CN UI/API is unchanged.
"""

EN = {
    # dir_state() → "detail" shown next to a configured capsules_dir
    "capsules.dir_detail_missing": "Directory does not exist",
    "capsules.dir_detail_not_dir": "This path is not a directory",
    "capsules.dir_detail_unwritable": "Directory is not writable",
    # ensure_capsules_dir(): validation
    "capsules.dir_absolute_required": "Use an absolute path (or one starting with ~/); got {path}",
    "capsules.dir_absolute_required_hint": 'for example "~/Y-Hub/capsules"',
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
        "No user capsule directory is configured and the bundled system layer (capsules/) is "
        "missing: point capsules_dir at the folder that holds your .html files"
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
        "This is the bundled example that ships with the software; it is read-only"
    ),
    "capsules.system_layer_read_only_hint": (
        "Point capsules_dir at a writable directory in Settings; or copy this capsule into your "
        "library and you can save in place"
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
    "capsules.dir_absolute_required": "要用绝对路径（或 ~/ 开头），现在是 {path}",
    "capsules.dir_absolute_required_hint": '比如 "~/Y-Hub/capsules"',
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
        "既没配用户胶囊目录、也找不到内置系统层（capsules/）：在「配置」里把 capsules_dir 指向库里放 .html 的目录"
    ),
    "capsules.not_found_layers_hint": (
        "依次检查这些层里有没有这个文件：{roots}；不带后缀会依次找 <名>.html / <名>.htm / "
        "<名>/index.html / <名>/<名>.html；数据文件要住在某个胶囊自己的文件夹里"
        "（如 <胶囊>/data/…，胶囊可在那里自由建文件，入口 html 本身不新建）"
    ),
    "capsules.not_found": "没有这个胶囊：{path}",
    "capsules.write_origin_forbidden": "不允许的来源写回库里的文件",
    "capsules.delete_origin_forbidden": "不允许的来源改动库里的文件",
    "capsules.system_layer_read_only": "这是随软件分发的内置示例，只读",
    "capsules.system_layer_read_only_hint": (
        "在「配置」里把 capsules_dir 指向一个可写目录；或把该胶囊复制到你的库后就能就地保存"
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
    "capsules.body_must_be_object": "请求体必须是 JSON 对象",
    "capsules.body_must_be_object_hint": '比如 {"id": "system:hello/index.html", "enabled": false}',
    "capsules.toggle_missing_id": "缺少要操作的胶囊标识",
    "capsules.toggle_missing_id_hint": "需提供 id 或 relpath",
}
