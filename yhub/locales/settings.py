"""Settings (`yhub/server/adapters/settings.py`) — validation errors, hints, read warnings, API errors.

Keys are ``settings.<name>``; placeholders are plain ``{name}`` parameters passed to ``tr()``.
``ZH`` carries the Simplified Chinese catalog.
"""

EN = {
    # version is program-maintained
    "settings.version_managed": "version is maintained by the program and cannot be set directly",
    "settings.version_managed_hint": (
        "It is the settings document version and must not be edited by hand"
    ),
    # plugins.<id>.<key> without a declared default
    "settings.plugin_field_no_default": (
        "Plugin {plugin} declares no default for {field}"
    ),
    "settings.plugin_field_no_default_hint": (
        "Defaults live in that plugin's plugin.json config section (key/default); just write a value instead"
    ),
    # unknown dotted path
    "settings.unknown_key": "Unknown setting {name}",
    "settings.unknown_key_hint": "Available paths: {paths}",
    # read warnings
    "settings.read_failed": "Failed to read {path} ({error}); running on defaults this time",
    "settings.invalid_json_reason": "not valid JSON ({error})",
    "settings.top_level_not_object": "the top level is not an object",
    "settings.hotkeys_action_not_string": "hotkeys.{action} is not a string; using the default",
    "settings.hotkeys_not_object": "hotkeys is not an object; using the default",
    "settings.tray_field_wrong_type": (
        "tray.{field} has the wrong type (expected {expected}); using the default"
    ),
    "settings.tray_not_object": "tray is not an object; using the default",
    "settings.capsules_dir_not_string": "capsules_dir is not a string; using the default",
    "settings.capsules_disabled_not_string_list": (
        "capsules_disabled is not a list of strings; using the default"
    ),
    "settings.capsules_subdomains_not_bool": "capsules_subdomains is not a boolean; using the default",
    "settings.registry_url_not_string": "plugins_registry_url is not a string; using the default",
    "settings.overrides_invalid_entries": "capsules_subdomains_overrides has invalid entries; ignored",
    "settings.overrides_not_object": "capsules_subdomains_overrides is not an object; using the default",
    "settings.plugin_section_not_object_warning": (
        "plugins.{plugin} is not an object; ignored (other plugin configs still read)"
    ),
    "settings.plugins_not_object": (
        'plugins is not an object; ignored (expected an object whose keys are plugin ids)'
    ),
    "settings.quarantine_backed_up": (
        "{path} {why}; backed up as {backup} and running on defaults this time"
    ),
    "settings.quarantine_backup_failed": (
        "{path} {why}, and the backup failed ({error}); running on defaults this time"
    ),
    # _dir_path / _check_bool / _check_enum
    "settings.dir_requires_string": "{label} must be a string path",
    "settings.dir_requires_string_hint": (
        "for example /Users/you/Y-Hub/capsules or ~/Y-Hub/capsules; empty = disabled"
    ),
    "settings.dir_requires_absolute": (
        "{label} must be an absolute path (or start with ~/); got {value}"
    ),
    "settings.dir_requires_absolute_hint": (
        "A relative path cannot say what it is relative to — the backend process's working directory "
        "is not the one you expect"
    ),
    "settings.bool_required": "{label} must be true / false",
    "settings.current_value": "the current value is {value}",
    "settings.enum_required": "{label} must be one of {allowed}",
    # hotkeys
    "settings.hotkey_requires_string": "hotkeys.{action} must be a string combo",
    "settings.hotkey_requires_string_hint": (
        'for example "Option+Space"; an empty string = unbound'
    ),
    "settings.hotkey_invalid": "The combo {combo} is not valid",
    "settings.hotkey_invalid_hint": (
        "Write it as “modifiers+a key”, e.g. Option+Space, Ctrl+Cmd+Shift+F9; modifiers alone do not work"
    ),
    "settings.hotkey_unknown_key": "The key name in combo {combo} is not recognized: {name}",
    "settings.hotkey_unknown_key_hint": (
        "Use a single letter or digit (K, 1), F1–F24, or a name like Space / Tab / Enter / Escape / Left"
    ),
    "settings.hotkey_conflict": "{combo} is already bound to “{label}”",
    "settings.hotkey_conflict_hint": (
        "One combo can only bind one action; give that action a different combo first, or clear it"
    ),
    # apply_value / declared fields / overrides / plugin sections
    "settings.capsules_subdomains_must_be_bool": "capsules_subdomains must be a boolean",
    "settings.registry_url_must_be_string": "plugins_registry_url must be a string",
    "settings.registry_url_must_be_string_hint": (
        "http(s) URL, file:// or a local path; empty = not configured"
    ),
    "settings.capsules_disabled_must_be_list": "capsules_disabled must be a list of strings",
    "settings.capsules_disabled_must_be_list_hint": 'for example ["system:hello/index.html"]',
    "settings.hotkeys_must_be_object": "hotkeys must be an object",
    "settings.hotkeys_must_be_object_hint": 'for example {"toggle_panel":"Option+Space"}',
    "settings.unknown_hotkey_action": "Unknown hotkey action {action}",
    "settings.unknown_hotkey_action_hint": "Bindable actions: {actions}",
    "settings.tray_must_be_object": "tray must be an object",
    "settings.tray_must_be_object_hint": 'for example {"close_behavior":"hide"}',
    "settings.unknown_tray_field": "Unknown tray field {field}",
    "settings.unknown_tray_field_hint": "Available fields: {fields}",
    "settings.plugins_must_be_object": "plugins must be an object (keys = plugin ids)",
    "settings.plugins_must_be_object_hint": (
        'for example {"super-productivity": {"base_url": "http://127.0.0.1:3876"}}'
    ),
    "settings.declared_bool": "{where} must be true / false (declared type=bool)",
    "settings.declared_int": "{where} must be an integer (declared type=int)",
    "settings.declared_str": "{where} must be a string (declared type={type})",
    "settings.overrides_must_be_object": "capsules_subdomains_overrides must be an object",
    "settings.overrides_must_be_object_hint": 'for example {"chat": true, "panel.html": false}',
    "settings.overrides_key_must_be_path": (
        "The keys of capsules_subdomains_overrides must be capsule paths"
    ),
    "settings.overrides_key_must_be_path_hint": 'for example "chat" or "panel.html"',
    "settings.overrides_value_must_be_bool": (
        "capsules_subdomains_overrides.{scope} must be a boolean"
    ),
    "settings.plugin_section_must_be_object": (
        "plugins.{plugin} must be an object (that plugin's own config)"
    ),
    "settings.plugin_section_must_be_object_hint": (
        "the current value is {type}; write {} to clear this section"
    ),
    # write / API
    "settings.nothing_to_change": "No settings to change",
    "settings.nothing_to_change_hint": 'pass {"key": "…", "value": …} or {"keys": {…}}',
    "settings.request_body_invalid_json": "Request body is not valid JSON ({error})",
    "settings.request_body_example_hint": (
        'for example {"key": "capsules_dir", "value": "~/Y-Hub/capsules"}'
    ),
    "settings.request_body_must_be_object": "Request body must be a JSON object",
    "settings.keys_must_be_object": '"keys" must be an object',
    "settings.keys_must_be_object_hint": (
        'for example {"keys": {"capsules_dir": "~/Y-Hub/capsules"}}'
    ),
    "settings.key_must_be_string": '"key" must be a string',
    "settings.key_must_be_string_hint": "a dotted path, e.g. capsules_dir",
    "settings.reset_key_must_be_string_hint": "no key = restore everything to defaults",
}

ZH = {
    "settings.version_managed": "version 由程序维护，不能直接设置",
    "settings.version_managed_hint": "它是设置文档的版本号，请勿手改",
    "settings.plugin_field_no_default": "插件 {plugin} 没有为 {field} 声明默认值",
    "settings.plugin_field_no_default_hint": (
        "默认值住该插件 plugin.json 的 config 段（key/default）；直接写一个值即可"
    ),
    "settings.unknown_key": "未知设置项 {name}",
    "settings.unknown_key_hint": "可用路径：{paths}",
    "settings.read_failed": "读取 {path} 失败（{error}），本次按默认值运行",
    "settings.invalid_json_reason": "不是合法 JSON（{error}）",
    "settings.top_level_not_object": "顶层不是对象",
    "settings.hotkeys_action_not_string": "hotkeys.{action} 不是字符串，已用默认值",
    "settings.hotkeys_not_object": "hotkeys 不是对象，已用默认值",
    "settings.tray_field_wrong_type": "tray.{field} 类型不对（要 {expected}），已用默认值",
    "settings.tray_not_object": "tray 不是对象，已用默认值",
    "settings.capsules_dir_not_string": "capsules_dir 不是字符串，已用默认值",
    "settings.capsules_disabled_not_string_list": "capsules_disabled 不是字符串列表，已用默认值",
    "settings.capsules_subdomains_not_bool": "capsules_subdomains 不是布尔值，已用默认值",
    "settings.registry_url_not_string": "plugins_registry_url 不是字符串，已用默认值",
    "settings.overrides_invalid_entries": "capsules_subdomains_overrides 有非法项，已忽略",
    "settings.overrides_not_object": "capsules_subdomains_overrides 不是对象，已用默认值",
    "settings.plugin_section_not_object_warning": (
        "plugins.{plugin} 不是对象，已忽略（其余插件配置照常读取）"
    ),
    "settings.plugins_not_object": "plugins 不是对象，已忽略（要「键 = 插件 id」的对象）",
    "settings.quarantine_backed_up": "{path} {why}，已备份为 {backup}，本次按默认值运行",
    "settings.quarantine_backup_failed": "{path} {why}，且备份失败（{error}），本次按默认值运行",
    "settings.dir_requires_string": "{label} 要填字符串路径",
    "settings.dir_requires_string_hint": "比如 /Users/you/Y-Hub/capsules 或 ~/Y-Hub/capsules；留空 = 关闭",
    "settings.dir_requires_absolute": "{label} 要用绝对路径（或 ~/ 开头），现在是 {value}",
    "settings.dir_requires_absolute_hint": "相对路径说不清是相对谁——后端进程的工作目录不是你能预期的那个",
    "settings.bool_required": "{label} 要填 true / false",
    "settings.current_value": "现在给的是 {value}",
    "settings.enum_required": "{label} 只能是 {allowed} 之一",
    "settings.hotkey_requires_string": "hotkeys.{action} 要填字符串组合键",
    "settings.hotkey_requires_string_hint": '比如 "Option+Space"；空字符串 = 不绑定',
    "settings.hotkey_invalid": "组合键 {combo} 不合法",
    "settings.hotkey_invalid_hint": (
        "要写成「修饰键+一个键」，比如 Option+Space、Ctrl+Cmd+Shift+F9；只按修饰键不行"
    ),
    "settings.hotkey_unknown_key": "组合键 {combo} 里的键名认不出来：{name}",
    "settings.hotkey_unknown_key_hint": (
        "用单个字母数字（K、1）、F1–F24，或 Space / Tab / Enter / Escape / Left 这类名字"
    ),
    "settings.hotkey_conflict": "{combo} 已经绑定给「{label}」了",
    "settings.hotkey_conflict_hint": "同一个组合键只能绑一个动作；先给那个动作换一个，或把它的清空",
    "settings.capsules_subdomains_must_be_bool": "capsules_subdomains 要是布尔值",
    "settings.registry_url_must_be_string": "plugins_registry_url 要是字符串",
    "settings.registry_url_must_be_string_hint": (
        "http(s) URL、file:// 或本地路径；留空 = 未配置"
    ),
    "settings.capsules_disabled_must_be_list": "capsules_disabled 要是字符串列表",
    "settings.capsules_disabled_must_be_list_hint": '比如 ["system:hello/index.html"]',
    "settings.hotkeys_must_be_object": "hotkeys 要填对象",
    "settings.hotkeys_must_be_object_hint": '比如 {"toggle_panel":"Option+Space"}',
    "settings.unknown_hotkey_action": "未知热键动作 {action}",
    "settings.unknown_hotkey_action_hint": "可绑定的是：{actions}",
    "settings.tray_must_be_object": "tray 要填对象",
    "settings.tray_must_be_object_hint": '比如 {"close_behavior":"hide"}',
    "settings.unknown_tray_field": "未知托盘字段 {field}",
    "settings.unknown_tray_field_hint": "可用的是：{fields}",
    "settings.plugins_must_be_object": "plugins 要填对象（键 = 插件 id）",
    "settings.plugins_must_be_object_hint": (
        '比如 {"super-productivity": {"base_url": "http://127.0.0.1:3876"}}'
    ),
    "settings.declared_bool": "{where} 要是 true / false（声明 type=bool）",
    "settings.declared_int": "{where} 要是整数（声明 type=int）",
    "settings.declared_str": "{where} 要是字符串（声明 type={type}）",
    "settings.overrides_must_be_object": "capsules_subdomains_overrides 要是对象",
    "settings.overrides_must_be_object_hint": '比如 {"chat": true, "panel.html": false}',
    "settings.overrides_key_must_be_path": "capsules_subdomains_overrides 的键要是胶囊路径",
    "settings.overrides_key_must_be_path_hint": '比如 "chat" 或 "panel.html"',
    "settings.overrides_value_must_be_bool": "capsules_subdomains_overrides.{scope} 要是布尔值",
    "settings.plugin_section_must_be_object": "plugins.{plugin} 要填对象（该插件自己的配置）",
    "settings.plugin_section_must_be_object_hint": "现在给的是 {type}；写 {} 表示清空这一段",
    "settings.nothing_to_change": "没有要改的设置项",
    "settings.nothing_to_change_hint": '要带 {"key": "…", "value": …} 或 {"keys": {…}}',
    "settings.request_body_invalid_json": "请求体不是合法 JSON（{error}）",
    "settings.request_body_example_hint": '比如 {"key": "capsules_dir", "value": "~/Y-Hub/capsules"}',
    "settings.request_body_must_be_object": "请求体要是 JSON 对象",
    "settings.keys_must_be_object": '"keys" 要是对象',
    "settings.keys_must_be_object_hint": '比如 {"keys": {"capsules_dir": "~/Y-Hub/capsules"}}',
    "settings.key_must_be_string": '"key" 要是字符串',
    "settings.key_must_be_string_hint": "点号路径，比如 capsules_dir",
    "settings.reset_key_must_be_string_hint": "不带 key = 整份恢复默认",
}
