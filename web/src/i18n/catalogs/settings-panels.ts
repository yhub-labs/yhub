// Settings panels: hotkeys / tray / capsules / plugins / per-app config
//
// Section names and blurbs (registry.tsx) live in `settings.ts`; this file only carries the copy
// rendered inside each panel. Backend-provided names, descriptions and help texts are never
// translated here — they come from the backend verbatim.

export const en = {
  // ---- HotkeySection
  // Hotkey action labels are keyed by the shell's action id (schema.hotkey_actions[].id), not by
  // the label the shell carries: Rust declares those names in Chinese only, the UI is bilingual.
  'settings.hotkeys.action.toggle_panel': 'Show / hide panel',
  'settings.hotkeys.action.show_panel': 'Show panel only',
  'settings.hotkeys.action.hide_panel': 'Hide panel only',
  'settings.hotkeys.title': 'Global hotkeys',
  'settings.hotkeys.description':
    'Combos that work in any app. Changes are registered with the system right away and restored from the config file after a restart.',
  'settings.hotkeys.previewFooter':
    'The action table (get_settings_schema) and the current bindings (get_settings) both come from the desktop shell; the browser preview cannot read them, so no fake values are shown here.',
  'settings.hotkeys.previewBody':
    'The action table and the current bindings are only readable on the desktop: open Settings inside the Y-Hub desktop shell to view and change them.',
  'settings.hotkeys.footer':
    '{bound} of {total} actions are bound. A combo can only belong to one action; when the system or another app owns it you get a clear message and the old binding stays.',
  'settings.hotkeys.empty': 'The backend offers no bindable actions (schema.hotkey_actions is empty).',
  'settings.hotkeys.unbound': 'Unbound',
  'settings.hotkeys.defaultCombo': 'Default: {combo}',
  'settings.hotkeys.noDefault': 'Unbound',
  'settings.hotkeys.duplicate': ' · duplicated in the config file with “{names}”',
  'settings.hotkeys.duplicateSeparator': ', ',
  'settings.hotkeys.recording': 'Press a combo…',
  'settings.hotkeys.record': 'Record',
  'settings.hotkeys.rerecord': 'Re-record',
  'settings.hotkeys.stop': 'Cancel',
  'settings.hotkeys.record.title': 'Record a combo (Esc to cancel)',
  'settings.hotkeys.stop.title': 'Stop recording (Esc)',
  'settings.hotkeys.clear': 'Clear',
  'settings.hotkeys.clear.title': 'Clear the binding (writes an empty value = unbound)',
  'settings.hotkeys.restore': 'Restore default',
  'settings.hotkeys.restore.title': 'Restore this action’s default combo',
  'settings.hotkeys.recordingHint':
    'Pressing a combo binds it right away (at least one ⌃ / ⌥ / ⌘); press Esc to cancel.',
  'settings.hotkeys.notify.bound': 'Bound: {name} → {combo}',
  'settings.hotkeys.notify.cleared': 'Binding cleared: {name}',
  'settings.hotkeys.notify.restored': 'Default restored: {name} → {combo}',
  'settings.hotkeys.notify.restoredUnbound': 'Default restored: {name} (unbound by default)',
  'settings.hotkeys.notify.cancelled': 'Recording cancelled',
  'settings.hotkeys.problem.unsupported':
    'Key {code} cannot be bound, please pick another one (letter / digit / F1-F24 / arrow keys, …)',
  'settings.hotkeys.problem.modifier':
    'At least one ⌃ / ⌥ / ⌘ modifier is required: Shift alone or a bare key would steal normal typing',
  'settings.hotkeys.problem.taken':
    'Combo {combo} is already bound to “{name}”, please change that one first',
  'settings.hotkeys.rules.title': 'What counts as valid',
  'settings.hotkeys.rules.description':
    'A recorded key is first checked for duplicates inside this app, then handed to the system to register; only a successful registration is written to the config file.',
  'settings.hotkeys.rules.invalid':
    '· Invalid combos: modifier-only keys (just ⌃ / ⌥ / ⇧ / ⌘) and unrecognized keys are rejected with a message.',
  'settings.hotkeys.rules.occupied':
    '· Taken by the system: registering a combo owned by another app fails, the error shows in place and the old hotkey stays.',
  'settings.hotkeys.rules.clear':
    '· Clearing a binding = the action binds no key at all (different from “restore default”).',
  'settings.hotkeys.rules.persist':
    '· Empty strings and defaults are persisted as-is; what the UI shows is what the config file holds.',

  // ---- TraySection
  'settings.tray.hint.close_behavior':
    'On the window close button / Cmd+W: hide panel = the process stays in the menu bar; quit = terminate the process',
  'settings.tray.hint.left_click': 'Left click on the menu bar icon (right click always opens the menu)',
  'settings.tray.hint.double_click':
    'Two left clicks within 320ms count as a double click; without a double-click action the single click applies at once, otherwise the app waits that long to tell them apart',
  'settings.tray.hint.show_on_start':
    'Whether the panel is shown right away when the app opens (off = only sit in the menu bar, wait for the hotkey or an icon click)',
  'settings.tray.hint.show_notifications':
    'Send a macOS system notification when hiding to the menu bar / quitting (subject to the system Notifications permission)',
  'settings.tray.notify.saved': 'Saved: {field}',
  'settings.tray.notify.restored': 'Default restored: tray behavior',
  'settings.tray.error.write': '{field}: {error}',
  'settings.tray.error.title': 'Write failed: {error}',
  'settings.tray.toggle.on': 'Click to turn on',
  'settings.tray.toggle.off': 'Click to turn off',
  'settings.tray.saving': 'Saving…',
  'settings.tray.window.title': 'Window and menu bar',
  'settings.tray.window.description':
    'Close behavior, whether the panel pops up at launch, whether to send system notifications. Applies immediately — the config is re-read on every runtime event, no restart needed.',
  'settings.tray.window.footer':
    'Settings live in the tray section of ~/.yhub/settings.json (see the General section). Illegal values are rejected by the backend together with the allowed ones, so the UI never writes a half-broken state.',
  'settings.tray.preview.body':
    'Browser preview: only the current values are visible; change them on the desktop (the desktop App or',
  'settings.tray.preview.tail': ').',
  'settings.tray.click.title': 'Icon click behavior',
  'settings.tray.click.description':
    'What a left single click / double click on the menu bar icon does. Right click always opens the menu (show panel / hide panel / open desktop page / Settings… / Quit) and is not affected here.',
  'settings.tray.click.footer':
    'macOS does not deliver a separate double-click event: the runtime judges it from the gap between two clicks (320ms). Without a double-click action the single click applies immediately and a double click only toggles once.',
  'settings.tray.menu.title': 'Tray menu entries',
  'settings.tray.menu.description':
    'The menu behind a right click on the menu bar icon; the entries are always there and do not follow the settings above.',
  'settings.tray.menu.toggle': 'Show / hide panel',
  'settings.tray.menu.toggleHint':
    'Same as the hotkey and left-click toggle (the panel pops up on the screen with the mouse)',
  'settings.tray.menu.web': 'Open desktop web page',
  'settings.tray.menu.webHint':
    'Open http://127.0.0.1:8790/ in the system default browser (large desktop view, full screen on a second display); the backend is started first if needed',
  'settings.tray.menu.settings': 'Settings…',
  'settings.tray.menu.settingsHint': 'Show the panel and jump straight to this page (tray section)',
  'settings.tray.menu.quit': 'Quit Y-Hub',
  'settings.tray.menu.quitHint': 'No Dock icon, so this is the main way out (⌘Q works too)',
  'settings.tray.current.title': 'Effective values',
  'settings.tray.current.description':
    'Live values read from the Rust side, the same source as the controls above; this simply lists all five fields for a quick check.',
  'settings.tray.current.footer':
    'Restore defaults hands the whole tray section back to the factory values (hide on close, toggle panel on left click, ignore double click, no panel at launch, no notifications).',
  'settings.tray.current.empty': 'Tray fields',
  'settings.tray.restore.hint': 'Only resets the tray section, leaving hotkeys and widgets alone',
  'settings.tray.restore': 'Restore defaults',

  // ---- CapsulesSection
  'settings.capsules.title': 'Capsule library',
  'settings.capsules.description':
    'Holds your own HTML capsules: one file is one capsule, it shows up when you drop it in and disappears when you delete it. It is just a normal folder — back it up, put it in git, carry it to another machine.',
  'settings.capsules.footer':
    'Served at /capsules/<relative path>. A single file supports overwrite write-back (WebDAV PUT); a directory-style capsule has a writable data area in its own folder.',
  'settings.capsules.loading': 'Reading the capsule list…',
  'settings.capsules.notify.created': 'Capsule library created: {path}',
  'settings.capsules.notify.enabled': 'Capsule library enabled: {path}',
  'settings.capsules.notify.dirUpdated': 'Capsule directory updated (a missing directory counts as not configured)',
  'settings.capsules.notify.dirReset': 'Your own capsule library is off, only the built-in samples are shown',
  'settings.capsules.notify.toggleOn': 'Capsule “{name}” enabled',
  'settings.capsules.notify.toggleOff': 'Capsule “{name}” disabled',
  'settings.capsules.pickTitle': 'Choose your capsule library folder',
  'settings.capsules.path.aria': 'Capsule directory path',
  'settings.capsules.path.placeholder':
    'Leave empty for the default location (or an absolute / ~/… path to override it)',
  'settings.capsules.path.save': 'Save',
  'settings.capsules.path.hint':
    'Leave it empty and the library lives at the default location under the data folder (created on first use). An override must be absolute or start with ~/; a missing override shows up as “not configured”.',
  'settings.capsules.disabled.title': 'Your own capsule library is turned off',
  'settings.capsules.disabled.description':
    'Only the built-in samples are listed right now. Turning it back on uses the default location (created on the first import) — no path to type, no folder to pick.',
  'settings.capsules.disabled.enable': 'Turn it on (default location)',
  'settings.capsules.defaultLocation': 'Default location: ',
  'settings.capsules.defaultBadge': 'Default location',
  'settings.capsules.defaultBadgeTitle':
    'No override is set: the library follows the data folder, so it moves with your data and needs no configuration',
  'settings.capsules.useDefault': 'Use default location',
  'settings.capsules.createdOnFirstUse': ' · created on the first import or save',
  'settings.capsules.notify.libraryOn': 'Capsule library on: {path} (created on the first import)',
  'settings.capsules.pick': 'Choose folder…',
  'settings.capsules.manual': 'Enter a path manually',
  'settings.capsules.unset.recommended': 'Recommended location: ',
  'settings.capsules.problem.title': 'Capsule library unavailable',
  'settings.capsules.problem.readOnly': ' (readable, but saving will fail)',
  'settings.capsules.createDir': 'Create this directory',
  'settings.capsules.repick': 'Choose again…',
  'settings.capsules.manualShort': 'Enter manually',
  'settings.capsules.disableSamples': 'Disable (built-in samples only)',
  'settings.capsules.enabledBadge': 'Enabled',
  'settings.capsules.openFolder': 'Open folder',
  'settings.capsules.change': 'Change…',
  'settings.capsules.disable': 'Disable',
  'settings.capsules.enable': 'Enable',
  'settings.capsules.indexed':
    '{count} capsules indexed · drop a .html into this folder and it shows up automatically',
  'settings.capsules.list.title': 'Indexed capsules ({count})',
  'settings.capsules.list.description':
    'Every HTML capsule found in the currently visible layers (built-in samples + your own library). “Open in browser” runs it in an isolated context.',
  'settings.capsules.list.disabledBadge': 'Disabled',
  'settings.capsules.list.systemTitle':
    'The code updates with Y-Hub upgrades; app data is persisted automatically to the user directory',
  'settings.capsules.list.system': 'Built-in · data writable',
  'settings.capsules.list.userTitle': 'Lives in the user capsule directory, code and data are writable',
  'settings.capsules.list.user': 'User library',
  'settings.capsules.list.custom': 'Customized',
  'settings.capsules.list.customTitle':
    'Name / icon / description / order are set in the capsule library; the page itself is unchanged',
  'settings.capsules.import': 'Import capsule…',
  'settings.capsules.importHint':
    'Pick a .html / .htm file (or a folder with index.html) — it is copied into the library above and appears in the list. Dropping files into the folder by hand still works.',
  'settings.capsules.importTooBig': 'That file is larger than the {limit} MiB limit for one capsule',
  'settings.capsules.notify.imported': 'Imported “{name}”',
  'settings.capsules.notify.importedReplaced': 'Replaced “{name}”',
  'settings.capsules.notify.importedUnchanged':
    '“{name}” was already in the library — only its details were saved',
  'settings.capsules.notify.metaSaved': 'Saved details for “{name}”',
  'settings.capsules.notify.metaReset': 'Details reset to what the page says for “{name}”',
  'settings.capsules.notify.deleted': 'Deleted “{name}”',
  'settings.capsules.notify.deletedKeptData':
    'Deleted the entry for “{name}”; its data files are still in the folder',
  'settings.capsules.stale':
    '{count} saved capsule detail entries no longer match a file (the file was removed by hand?) — they are cleaned up on the next save.',
  'settings.capsules.edit': 'Details',
  'settings.capsules.editSave': 'Save',
  'settings.capsules.editCancel': 'Cancel',
  'settings.capsules.editReset': 'Reset to page values',
  'settings.capsules.field.title': 'Display name',
  'settings.capsules.field.titlePlaceholder': 'Empty = the page <title>, then the file name',
  'settings.capsules.field.icon': 'Icon',
  'settings.capsules.field.iconPlaceholder': '📄 or an https:// / data: image',
  'settings.capsules.field.description': 'Description',
  'settings.capsules.field.descriptionPlaceholder': 'One line shown under the name',
  'settings.capsules.field.order': 'Order',
  'settings.capsules.field.orderPlaceholder': 'e.g. 10',
  'settings.capsules.field.orderInvalid': 'Order must be a whole number',
  'settings.capsules.field.hint':
    'These details live in the capsule library, not in the page: clearing a field falls back to what the page itself declares.',
  'settings.capsules.delete': 'Delete…',
  'settings.capsules.deleteConfirm': 'Delete capsule',
  'settings.capsules.deleteConfirmHint': 'Removes the entry file from your library. Cannot be undone.',
  'settings.capsules.deleteData': 'Also delete its data files',
  'settings.capsules.subdomain.label': 'Isolated origin',
  'settings.capsules.subdomain.title':
    'Isolated origin: this capsule uses <slug>.localhost, so its browser localStorage / window handles are separated from the main UI',
  'settings.capsules.subdomain.followGlobal': 'Follow global',
  'settings.capsules.open': 'Open in browser',
  'settings.capsules.empty.unset':
    'No capsules yet: create a writable directory with “Use the recommended location” above, then drop .html files into it',
  'settings.capsules.empty.none': 'No .html files found in this directory yet',
  'settings.capsules.isolation.title': 'Isolation mode',
  'settings.capsules.isolation.description':
    'By default every capsule shares the origin of the main UI (127.0.0.1). Once enabled, each capsule gets its own <slug>.localhost origin, so the browser isolates localStorage / IndexedDB / window handles per origin.',
  'settings.capsules.isolation.footer':
    'Capsule addresses become http://<slug>.localhost:8790/capsules/… (old addresses 302 there); the system must be able to resolve *.localhost.',
  'settings.capsules.isolation.rowTitle': 'Per-capsule origin (experimental)',
  'settings.capsules.isolation.rowHint':
    'This is currently the only way to block “a capsule reads the main app’s localStorage / window.open reads the main app’s DOM”. Once enabled, /api/* returns 403 for all capsule subdomains.',

  // ---- PluginsSection
  'settings.plugins.title': 'Plugins',
  'settings.plugins.description':
    'Core plugins ship with the software and can be disabled but never removed; third-party plugins live in the config directory and can be installed and removed. Disabling one removes its routes, CLI commands and wall cells together.',
  'settings.plugins.footer':
    'Enable/disable is written to plugins.<id>._enabled in settings.json (same semantics as the shell settings page and yhub plugin enable/disable). Command-line equivalents: yhub plugin list / add / remove / enable / disable.',
  'settings.plugins.kind.core': 'Core',
  'settings.plugins.kind.third': 'Third-party',
  'settings.plugins.kind.coreTitle': 'Ships with the software: can be disabled, cannot be uninstalled',
  'settings.plugins.kind.thirdTitle': 'Can be installed and removed freely',
  'settings.plugins.badge.broken': 'Broken: {error}',
  'settings.plugins.badge.notInstalled': 'Not installed',
  'settings.plugins.badge.enabled': 'Enabled',
  'settings.plugins.badge.disabled': 'Disabled',
  'settings.plugins.badge.disabledFile': 'Escape hatch marker',
  'settings.plugins.badge.disabledFileTitle':
    'There is a disabled file in the directory; it takes precedence over the config switch (escape hatch for a broken plugin)',
  'settings.plugins.toggle.disable': 'Disable',
  'settings.plugins.toggle.enable': 'Enable',
  'settings.plugins.toggle.disableTitle': 'Disable it (routes, CLI and wall cells disappear too)',
  'settings.plugins.toggle.enableTitle': 'Enable it again',
  'settings.plugins.install': 'Install',
  'settings.plugins.installing': 'Installing…',
  'settings.plugins.remove': 'Uninstall',
  'settings.plugins.notify.failed': 'Failed: {error}',
  'settings.plugins.notify.enabled': '{name} enabled',
  'settings.plugins.notify.disabled': '{name} disabled',
  'settings.plugins.notify.installed': 'Installed {name}',
  'settings.plugins.notify.installedVersion': 'Installed {name} {version}',
  // Only appended when the backend says `restart_required`: the GUI backend rebuilds its registry
  // in place, so install/remove/disable show up immediately (the CLI is what needs a restart).
  'settings.plugins.notify.restartSuffix': ' (takes effect after restarting the backend)',
  'settings.plugins.notify.removed': 'Uninstalled {name}',
  'settings.plugins.notify.noUpdates': 'No updates available',
  'settings.plugins.notify.checkFailed': 'Update check failed: {error}',
  'settings.plugins.notify.updated': 'Updated {id}',
  'settings.plugins.notify.noUpdateFor': 'No update for {id}',
  'settings.plugins.notify.updateFailed': 'Update failed: {error}',
  'settings.plugins.notify.updatedAll': 'Updated {count} plugins',
  'settings.plugins.notify.saveFailed': 'Save failed: {error}',
  'settings.plugins.notify.registrySaved': 'Plugin source saved',
  'settings.plugins.confirm.github':
    'This downloads and runs third-party Python code from {spec}. Continue only if you trust this repository.',
  'settings.plugins.error.load': 'Cannot read the plugin inventory: {error}',
  'settings.plugins.error.hintSeparator': '. ',
  'settings.plugins.retry': 'Retry',
  'settings.plugins.loading': 'Reading the plugin inventory…',
  'settings.plugins.stats.label': 'Statistics',
  'settings.plugins.stats.hint':
    'Core plugins ship with the package; third-party ones come from the plugins/ directory in the repository or from a directory you provide',
  'settings.plugins.stats.value':
    '{core} core · {installed} of {third} third-party installed',
  'settings.plugins.reload': 'Read again',
  'settings.plugins.core.title': 'Core plugins',
  'settings.plugins.third.title':
    'Third-party plugins (the ones in the repository just need “Install”; committed changes sync automatically via the git hook)',
  'settings.plugins.third.empty': 'No third-party plugins yet.',
  'settings.plugins.market.title': 'Plugin marketplace',
  'settings.plugins.market.description':
    'Install third-party plugins from the registry index. The list only renders; downloading, verifying and writing to disk all happen in the backend, which then reloads its registry — the tool appears right away.',
  'settings.plugins.market.footer':
    'The registry is a static JSON (id / name / repo / archive / version). Command-line equivalents: yhub plugin search / install / update.',
  'settings.plugins.market.registryAria': 'Plugin source URL',
  'settings.plugins.market.registryPlaceholder': 'https://…/registry.json (empty = marketplace off)',
  'settings.plugins.saving': 'Saving…',
  'settings.plugins.market.saveRegistry': 'Save plugin source',
  'settings.plugins.market.refresh': 'Refresh',
  'settings.plugins.market.searchAria': 'Search plugins',
  'settings.plugins.market.searchPlaceholder': 'Search id / name / description / author',
  'settings.plugins.market.search': 'Search',
  'settings.plugins.market.noRegistryHint':
    'Configure a plugin source first (or on the command line: yhub plugin registry set …)',
  'settings.plugins.market.loading': 'Reading the plugin marketplace…',
  'settings.plugins.market.noRegistry': 'The marketplace is off: nothing is fetched, and installing by id is unavailable.',
  'settings.plugins.market.useDefault': 'Use the official source',
  'settings.plugins.market.switchOff': 'Turn the marketplace off',
  'settings.plugins.market.switchOn': 'Turn the marketplace on',
  'settings.plugins.market.empty': 'No matching plugins.',
  'settings.plugins.market.installed': 'Installed{suffix}',
  'settings.plugins.market.updateAvailable': 'Update available',
  'settings.plugins.update': 'Update',
  'settings.plugins.updating': 'Updating…',
  'settings.plugins.github.title': 'Install from GitHub',
  'settings.plugins.github.description':
    'Supports owner/repo, owner/repo@tag and https://github.com/owner/repo#subdir. The repository archive is downloaded and its Python code is executed — only install projects you trust.',
  'settings.plugins.github.footer': 'Command-line equivalent: yhub plugin install owner/repo@v1.2.0',
  'settings.plugins.github.aria': 'GitHub plugin address',
  'settings.plugins.github.placeholder': 'owner/repo or https://github.com/owner/repo',
  'settings.plugins.updates.title': 'Updates',
  'settings.plugins.updates.description':
    'Registry plugins compare the index version; GitHub plugins compare the repository plugin.json. A pinned tag/ref is never upgraded automatically.',
  'settings.plugins.updates.footer': 'Command-line equivalent: yhub plugin update --all',
  'settings.plugins.checkUpdates': 'Check for updates',
  'settings.plugins.checking': 'Checking…',
  'settings.plugins.updateAll': 'Update all',
  'settings.plugins.updates.none':
    'No sources to check (only registry/GitHub plugins carry update information).',
  'settings.plugins.updates.latest': 'Up to date',

  // ---- AppConfigSection
  'settings.apps.updated': '{name} configuration updated',
  'settings.apps.blurb': 'Configure options specific to {name}',
  'settings.apps.footer': 'Options are stored in plugins.{id} in settings.json.',
  'settings.apps.toggle': ' · Click to toggle',
}

export const zhCN = {
  // ---- HotkeySection
  'settings.hotkeys.action.toggle_panel': '呼出 / 收起面板',
  'settings.hotkeys.action.show_panel': '只呼出面板',
  'settings.hotkeys.action.hide_panel': '只收起面板',
  'settings.hotkeys.title': '全局快捷键',
  'settings.hotkeys.description':
    '在任意应用里都能触发的组合键。改完立刻在系统里注册生效，重启后按配置文件恢复。',
  'settings.hotkeys.previewFooter':
    '动作表（get_settings_schema）与当前绑定（get_settings）都来自桌面端；浏览器预览态读不到，所以这里不显示任何模拟值。',
  'settings.hotkeys.previewBody':
    '动作表与当前绑定只能在桌面端读取：请在 Y-Hub 桌面壳里打开设置查看与修改。',
  'settings.hotkeys.footer':
    '已绑定 {bound} / {total} 个动作。同一个组合键只能绑一个动作；被系统或其他程序占用时会明确提示，并且保留原来的绑定。',
  'settings.hotkeys.empty': '后端没有提供可绑定的动作（schema.hotkey_actions 为空）。',
  'settings.hotkeys.unbound': '未绑定',
  'settings.hotkeys.defaultCombo': '默认：{combo}',
  'settings.hotkeys.noDefault': '不绑定',
  'settings.hotkeys.duplicate': ' · 配置文件里与「{names}」重复',
  'settings.hotkeys.duplicateSeparator': '、',
  'settings.hotkeys.recording': '按下组合键…',
  'settings.hotkeys.record': '录制',
  'settings.hotkeys.rerecord': '重录',
  'settings.hotkeys.stop': '取消',
  'settings.hotkeys.record.title': '录制组合键（ESC 取消）',
  'settings.hotkeys.stop.title': '取消录制（ESC）',
  'settings.hotkeys.clear': '清除',
  'settings.hotkeys.clear.title': '清除绑定（写入空值 = 不绑定）',
  'settings.hotkeys.restore': '恢复默认',
  'settings.hotkeys.restore.title': '恢复该动作的默认组合键',
  'settings.hotkeys.recordingHint': '按下组合键即绑定（至少一个 ⌃ / ⌥ / ⌘）；按 ESC 取消。',
  'settings.hotkeys.notify.bound': '已绑定：{name} → {combo}',
  'settings.hotkeys.notify.cleared': '已清除绑定：{name}',
  'settings.hotkeys.notify.restored': '已恢复默认：{name} → {combo}',
  'settings.hotkeys.notify.restoredUnbound': '已恢复默认：{name}（默认不绑定）',
  'settings.hotkeys.notify.cancelled': '已取消录制',
  'settings.hotkeys.problem.unsupported':
    '按键 {code} 不支持绑定，请换一个（字母 / 数字 / F1-F24 / 方向键等）',
  'settings.hotkeys.problem.modifier':
    '至少要有一个 ⌃ / ⌥ / ⌘ 修饰键：只按 ⇧ 或单键会把普通输入抢走',
  'settings.hotkeys.problem.taken': '组合键 {combo} 已经绑定给「{name}」，请先改掉那一项',
  'settings.hotkeys.rules.title': '怎么算有效',
  'settings.hotkeys.rules.description':
    '录制的按键会先在本程序内部查重，再交给系统注册；只有真的注册成功才会写进配置文件。',
  'settings.hotkeys.rules.invalid':
    '· 无效组合键：纯修饰键（只按 ⌃ / ⌥ / ⇧ / ⌘）、无法识别的键会被拒绝并提示。',
  'settings.hotkeys.rules.occupied':
    '· 系统占用：被别的程序占用的组合键注册会失败，错误会就地显示，旧热键保持不变。',
  'settings.hotkeys.rules.clear': '· 清除绑定 = 该动作不绑定任何键（区别于"恢复默认"）。',
  'settings.hotkeys.rules.persist': '· 空字符串与默认值都如实落盘，界面显示的就是配置文件里的值。',

  // ---- TraySection
  'settings.tray.hint.close_behavior':
    '点窗口的关闭按钮 / Cmd+W 时：隐藏面板 = 进程继续常驻菜单栏；退出程序 = 直接结束进程',
  'settings.tray.hint.left_click': '菜单栏图标左键单击（右键始终弹出菜单）',
  'settings.tray.hint.double_click':
    '两次左键点击落在 320ms 内算双击；没配双击动作时单击立即生效，配了就会等这一小段以区分',
  'settings.tray.hint.show_on_start':
    '打开程序时是否直接把面板显示出来（关掉则只常驻菜单栏，等热键或点图标）',
  'settings.tray.hint.show_notifications':
    '收起到菜单栏 / 退出程序时发一条 macOS 系统通知（受系统「通知」权限影响）',
  'settings.tray.notify.saved': '已保存：{field}',
  'settings.tray.notify.restored': '已恢复默认：托盘行为',
  'settings.tray.error.write': '{field}：{error}',
  'settings.tray.error.title': '写入失败：{error}',
  'settings.tray.toggle.on': '点击打开',
  'settings.tray.toggle.off': '点击关闭',
  'settings.tray.saving': '保存中…',
  'settings.tray.window.title': '窗口与菜单栏',
  'settings.tray.window.description':
    '关窗行为、启动是否弹面板、要不要发系统通知。改完立刻生效——运行时每次事件都重新读配置，不用重启程序。',
  'settings.tray.window.footer':
    '配置写在 ~/.yhub/settings.json 的 tray 段（见「通用」分区）。非法取值会被后端拒绝并提示可用值，界面不会写入半截状态。',
  'settings.tray.preview.body':
    '当前是浏览器预览态：只能看到当前值，改动要在桌面端保存（桌面 App 或',
  'settings.tray.preview.tail': '）。',
  'settings.tray.click.title': '图标点击行为',
  'settings.tray.click.description':
    '菜单栏图标的左键单击 / 双击各自要做什么。右键始终弹出菜单（显示面板 / 隐藏面板 / 打开桌面网页 / 设置… / 退出），不受这里影响。',
  'settings.tray.click.footer':
    'macOS 不派发独立双击事件，双击是运行时按两次点击的间隔（320ms）自己判定的：没配双击动作时单击立即生效、一次双击只切换一回。',
  'settings.tray.menu.title': '托盘菜单入口',
  'settings.tray.menu.description':
    '菜单栏图标右键的菜单，入口固定保留，不随上面的设置变化。',
  'settings.tray.menu.toggle': '显示面板 / 隐藏面板',
  'settings.tray.menu.toggleHint': '等价于热键与左键的切换行为（面板会弹到鼠标所在屏幕）',
  'settings.tray.menu.web': '打开桌面网页',
  'settings.tray.menu.webHint':
    '用系统默认浏览器打开 http://127.0.0.1:8790/（桌面大屏视图，副屏可全屏）；打开前会先确保后端在跑',
  'settings.tray.menu.settings': '设置…',
  'settings.tray.menu.settingsHint': '弹出面板并直接跳到本页（托盘分区）',
  'settings.tray.menu.quit': '退出 Y-Hub',
  'settings.tray.menu.quitHint': '无程序坞图标，这是主要退出入口（另可按 ⌘Q）',
  'settings.tray.current.title': '当前生效值',
  'settings.tray.current.description':
    '读自 Rust 侧的实时值，与上面的控件同源；这里只是把五个字段一起列出来方便核对。',
  'settings.tray.current.footer':
    '恢复默认会把 tray 这一段全部交回出厂值（关窗隐藏、左键切换面板、双击不响应、启动不弹窗、不发通知）。',
  'settings.tray.current.empty': '托盘字段',
  'settings.tray.restore.hint': '只重置 tray 这一段，不动热键与小工具',
  'settings.tray.restore': '恢复默认',

  // ---- CapsulesSection
  'settings.capsules.title': '胶囊库',
  'settings.capsules.description':
    '放你自己的 HTML 胶囊：一个文件就是一个胶囊，放进目录就出现、删掉就消失。它就是一个普通文件夹——可以备份、可以做 git、换机器能带走。',
  'settings.capsules.footer':
    '地址按 /capsules/<相对路径> 托管。单文件支持覆盖写回（WebDAV PUT）；目录型胶囊在自己的文件夹里有一块可写数据区。',
  'settings.capsules.loading': '读取胶囊列表…',
  'settings.capsules.notify.created': '已创建胶囊库：{path}',
  'settings.capsules.notify.enabled': '已启用胶囊库：{path}',
  'settings.capsules.notify.dirUpdated': '胶囊目录已更新（目录不存在时按未配置处理）',
  'settings.capsules.notify.dirReset': '已停用自己的胶囊库，只显示内置示例',
  'settings.capsules.notify.toggleOn': '胶囊「{name}」已启用',
  'settings.capsules.notify.toggleOff': '胶囊「{name}」已停用',
  'settings.capsules.pickTitle': '选择你的胶囊库目录',
  'settings.capsules.path.aria': '胶囊目录路径',
  'settings.capsules.path.placeholder': '留空 = 默认位置（或填绝对路径 / ~/ 开头的覆盖路径）',
  'settings.capsules.path.save': '保存',
  'settings.capsules.path.hint':
    '留空时胶囊库在数据目录下的默认位置（首次使用自动创建）；覆盖路径必须是绝对路径或 ~/ 开头。覆盖路径不存在会按「未配置」处理。',
  'settings.capsules.disabled.title': '用户胶囊库已关闭',
  'settings.capsules.disabled.description':
    '现在只列内置示例。重新打开会用默认位置（首次导入时自动创建）——不用填路径，也不用选文件夹。',
  'settings.capsules.disabled.enable': '打开（默认位置）',
  'settings.capsules.defaultLocation': '默认位置：',
  'settings.capsules.defaultBadge': '默认位置',
  'settings.capsules.defaultBadgeTitle': '没有设置覆盖路径：胶囊库跟着数据目录走，不需要配置',
  'settings.capsules.useDefault': '用默认位置',
  'settings.capsules.createdOnFirstUse': ' · 首次导入或保存时创建',
  'settings.capsules.notify.libraryOn': '胶囊库已打开：{path}（首次导入时自动创建）',
  'settings.capsules.pick': '选择文件夹…',
  'settings.capsules.manual': '手动填写路径',
  'settings.capsules.unset.recommended': '推荐位置：',
  'settings.capsules.problem.title': '胶囊库不可用',
  'settings.capsules.problem.readOnly': '（能读，但保存会失败）',
  'settings.capsules.createDir': '创建这个目录',
  'settings.capsules.repick': '重新选择…',
  'settings.capsules.manualShort': '手动填写',
  'settings.capsules.disableSamples': '停用（只用内置示例）',
  'settings.capsules.enabledBadge': '已启用',
  'settings.capsules.openFolder': '打开文件夹',
  'settings.capsules.change': '更换…',
  'settings.capsules.disable': '停用',
  'settings.capsules.enable': '启用',
  'settings.capsules.indexed': '已索引 {count} 个胶囊 · 把 .html 放进这个文件夹就会自动出现',
  'settings.capsules.list.title': '已索引胶囊 ({count})',
  'settings.capsules.list.description':
    '当前所有可见层里扫到的 HTML 胶囊（内置示例 + 你自己的库）。点「在浏览器打开」在独立环境中运行。',
  'settings.capsules.list.disabledBadge': '已停用',
  'settings.capsules.list.systemTitle':
    '代码随 Y-Hub 升级自动更新；应用数据自动持久化到用户目录',
  'settings.capsules.list.system': '内置 · 数据可写',
  'settings.capsules.list.userTitle': '位于用户胶囊目录，代码与数据皆可写',
  'settings.capsules.list.user': '用户库',
  'settings.capsules.list.custom': '已自定义',
  'settings.capsules.list.customTitle': '名称/图标/描述/排序来自胶囊库，页面本身没有被改动',
  'settings.capsules.import': '导入胶囊…',
  'settings.capsules.importHint':
    '选一个 .html / .htm（或含 index.html 的文件夹），它会被复制进上面的胶囊库并出现在列表里；直接往文件夹里拖文件照样有效。',
  'settings.capsules.importTooBig': '这个文件超过单个胶囊 {limit} MiB 的上限',
  'settings.capsules.notify.imported': '已导入「{name}」',
  'settings.capsules.notify.importedReplaced': '已替换「{name}」',
  'settings.capsules.notify.importedUnchanged': '「{name}」本来就在库里，只保存了它的信息',
  'settings.capsules.notify.metaSaved': '已保存「{name}」的信息',
  'settings.capsules.notify.metaReset': '「{name}」的信息已恢复成页面自己声明的值',
  'settings.capsules.notify.deleted': '已删除「{name}」',
  'settings.capsules.notify.deletedKeptData': '已删除「{name}」的入口文件，它的数据文件还留在文件夹里',
  'settings.capsules.stale':
    '有 {count} 条保存过的胶囊信息已经对不上任何文件（可能是手动删了文件）——下次保存时会自动清理。',
  'settings.capsules.edit': '信息',
  'settings.capsules.editSave': '保存',
  'settings.capsules.editCancel': '取消',
  'settings.capsules.editReset': '恢复成页面值',
  'settings.capsules.field.title': '显示名',
  'settings.capsules.field.titlePlaceholder': '留空 = 用页面 <title>，再没有就用文件名',
  'settings.capsules.field.icon': '图标',
  'settings.capsules.field.iconPlaceholder': '📄 或 https:// / data: 图片',
  'settings.capsules.field.description': '描述',
  'settings.capsules.field.descriptionPlaceholder': '名字下面那一行说明',
  'settings.capsules.field.order': '排序',
  'settings.capsules.field.orderPlaceholder': '比如 10',
  'settings.capsules.field.orderInvalid': '排序值必须是整数',
  'settings.capsules.field.hint':
    '这些信息存在胶囊库里，不写进页面：某个字段留空就回落到页面自己声明的值。',
  'settings.capsules.delete': '删除…',
  'settings.capsules.deleteConfirm': '确认删除',
  'settings.capsules.deleteConfirmHint': '会从胶囊库里删掉入口文件，且不可撤销。',
  'settings.capsules.deleteData': '连数据文件一起删',
  'settings.capsules.subdomain.label': '独立 origin',
  'settings.capsules.subdomain.title':
    '独立 origin：这个胶囊用 <slug>.localhost，浏览器 localStorage / 窗口句柄与主界面隔离',
  'settings.capsules.subdomain.followGlobal': '跟随全局',
  'settings.capsules.open': '在浏览器打开',
  'settings.capsules.empty.unset':
    '还没有胶囊：用上面的「使用推荐位置」建一个可写目录，再把 .html 放进去',
  'settings.capsules.empty.none': '目录内暂未扫描到 .html 文件',
  'settings.capsules.isolation.title': '隔离模式',
  'settings.capsules.isolation.description':
    '默认所有胶囊与主界面同源（127.0.0.1）。开启后每个胶囊用自己的 <slug>.localhost origin，浏览器会按 origin 隔离 localStorage / IndexedDB / 窗口句柄。',
  'settings.capsules.isolation.footer':
    '开启后胶囊地址会变成 http://<slug>.localhost:8790/capsules/…（旧地址会 302 过去）；需要系统能解析 *.localhost。',
  'settings.capsules.isolation.rowTitle': '每胶囊独立 origin（实验）',
  'settings.capsules.isolation.rowHint':
    '这是目前唯一能挡住「胶囊读主应用 localStorage / window.open 读主应用 DOM」的方式。开启后 /api/* 对胶囊子域一律 403。',

  // ---- PluginsSection
  'settings.plugins.title': '插件',
  'settings.plugins.description':
    '核心插件随软件分发，可以禁用但不能卸载；第三方插件住在配置目录里，可装可卸。禁用后它的接口、CLI 命令与信息墙格子会一起消失。',
  'settings.plugins.footer':
    '启停写在 settings.json 的 plugins.<id>._enabled（与壳设置页、yhub plugin enable/disable 同一份语义）。命令行等价：yhub plugin list / add / remove / enable / disable。',
  'settings.plugins.kind.core': '核心',
  'settings.plugins.kind.third': '第三方',
  'settings.plugins.kind.coreTitle': '随软件分发：可禁用、不可卸载',
  'settings.plugins.kind.thirdTitle': '可自由装卸',
  'settings.plugins.badge.broken': '装坏了：{error}',
  'settings.plugins.badge.notInstalled': '未安装',
  'settings.plugins.badge.enabled': '已启用',
  'settings.plugins.badge.disabled': '已禁用',
  'settings.plugins.badge.disabledFile': '逃生舱标记',
  'settings.plugins.badge.disabledFileTitle':
    '目录里有 disabled 文件，优先级高于配置开关（坏插件的逃生舱）',
  'settings.plugins.toggle.disable': '禁用',
  'settings.plugins.toggle.enable': '启用',
  'settings.plugins.toggle.disableTitle': '禁用它（三面与信息墙格子一起消失）',
  'settings.plugins.toggle.enableTitle': '重新启用',
  'settings.plugins.install': '安装',
  'settings.plugins.installing': '安装中…',
  'settings.plugins.remove': '卸载',
  'settings.plugins.notify.failed': '失败：{error}',
  'settings.plugins.notify.enabled': '{name} 已启用',
  'settings.plugins.notify.disabled': '{name} 已禁用',
  'settings.plugins.notify.installed': '已安装 {name}',
  'settings.plugins.notify.installedVersion': '已安装 {name} {version}',
  'settings.plugins.notify.restartSuffix': '（重启后端后生效）',
  'settings.plugins.notify.removed': '已卸载 {name}',
  'settings.plugins.notify.noUpdates': '没有可用更新',
  'settings.plugins.notify.checkFailed': '检查更新失败：{error}',
  'settings.plugins.notify.updated': '已更新 {id}',
  'settings.plugins.notify.noUpdateFor': '没有更新 {id}',
  'settings.plugins.notify.updateFailed': '更新失败：{error}',
  'settings.plugins.notify.updatedAll': '已更新 {count} 个插件',
  'settings.plugins.notify.saveFailed': '保存失败：{error}',
  'settings.plugins.notify.registrySaved': '插件源已保存',
  'settings.plugins.confirm.github':
    '将从 {spec} 下载并执行第三方 Python 代码。只继续如果你信任这个仓库。',
  'settings.plugins.error.load': '读不到插件清单：{error}',
  'settings.plugins.error.hintSeparator': '。',
  'settings.plugins.retry': '重试',
  'settings.plugins.loading': '正在读取插件清单…',
  'settings.plugins.stats.label': '统计',
  'settings.plugins.stats.hint': '核心随包分发；第三方来自仓库 plugins/ 或你自己放的目录',
  'settings.plugins.stats.value': '核心 {core} 个 · 第三方 {installed} 已装 / {third} 可用',
  'settings.plugins.reload': '重新读取',
  'settings.plugins.core.title': '核心插件',
  'settings.plugins.third.title':
    '第三方插件（仓库里带的点「安装」即可；改完提交后由 git 钩子自动同步）',
  'settings.plugins.third.empty': '还没有第三方插件。',
  'settings.plugins.market.title': '插件市场',
  'settings.plugins.market.description':
    '从 registry 索引安装第三方插件。列表只负责展示，下载/校验/落盘全在后端，装完后端会立即重建工具表——工具马上出现。',
  'settings.plugins.market.footer':
    'registry 是一个静态 JSON（id / name / repo / archive / version）。命令行等价：yhub plugin search / install / update。',
  'settings.plugins.market.registryAria': '插件源地址',
  'settings.plugins.market.registryPlaceholder': 'https://…/registry.json（留空 = 关闭插件市场）',
  'settings.plugins.saving': '保存中…',
  'settings.plugins.market.saveRegistry': '保存插件源',
  'settings.plugins.market.refresh': '刷新',
  'settings.plugins.market.searchAria': '搜索插件',
  'settings.plugins.market.searchPlaceholder': '搜索 id / 名称 / 描述 / 作者',
  'settings.plugins.market.search': '搜索',
  'settings.plugins.market.noRegistryHint':
    '先配置插件源（或命令行：yhub plugin registry set …）',
  'settings.plugins.market.loading': '读取插件市场…',
  'settings.plugins.market.noRegistry': '插件市场已关闭：不访问网络，按 id 安装也不可用。',
  'settings.plugins.market.useDefault': '恢复官方插件源',
  'settings.plugins.market.switchOff': '关闭插件市场',
  'settings.plugins.market.switchOn': '开启插件市场',
  'settings.plugins.market.empty': '没有匹配的插件。',
  'settings.plugins.market.installed': '已装{suffix}',
  'settings.plugins.market.updateAvailable': '有更新',
  'settings.plugins.update': '更新',
  'settings.plugins.updating': '更新中…',
  'settings.plugins.github.title': '从 GitHub 安装',
  'settings.plugins.github.description':
    '支持 owner/repo、owner/repo@tag、https://github.com/owner/repo#subdir。会下载仓库归档并执行其中的 Python 代码——只装你信任的项目。',
  'settings.plugins.github.footer': '命令行等价：yhub plugin install owner/repo@v1.2.0',
  'settings.plugins.github.aria': 'GitHub 插件地址',
  'settings.plugins.github.placeholder': 'owner/repo 或 https://github.com/owner/repo',
  'settings.plugins.updates.title': '更新',
  'settings.plugins.updates.description':
    'registry 插件比较索引版本；GitHub 插件比较仓库 plugin.json。固定的 tag/ref 不会自动升级。',
  'settings.plugins.updates.footer': '命令行等价：yhub plugin update --all',
  'settings.plugins.checkUpdates': '检查更新',
  'settings.plugins.checking': '检查中…',
  'settings.plugins.updateAll': '全部更新',
  'settings.plugins.updates.none': '没有可检查的来源（registry/GitHub 插件才有更新信息）。',
  'settings.plugins.updates.latest': '已最新',

  // ---- AppConfigSection
  'settings.apps.updated': '{name} 配置已更新',
  'settings.apps.blurb': '配置 {name} 专属参数',
  'settings.apps.footer': '配置项存储在 settings.json 中的 plugins.{id}。',
  'settings.apps.toggle': ' · 点击切换',
}
