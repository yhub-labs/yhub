// Settings: ~/.yhub/settings.json — versioned, defaulted local persistence
//
// Design conventions (the settings UI and the runtime both follow them)
//
// 1. **One file, split ownership**: the shell owns only the startup-essential `hotkeys` and `tray`
//    (plus `version`). All other keys (`capsules_*` / `plugins` / future UI keys) belong to the Python
//    backend (`yhub/server/adapters/settings.py`); Rust's `save_to` **merges only shell keys** and
//    preserves the other top-level keys verbatim, so nothing the backend wrote is wiped.
// 2. **Version number**: the document's top-level `version` = `SETTINGS_VERSION`. It is written by the
//    program and not user-editable; this codebase does not carry migrations for older shapes.
// 3. **Missing fields have defaults**: missing → default; a field with the wrong type / invalid value →
//    fall back for that item only and record a warning while the rest reads normally, **never panic**;
//    when the whole file is not valid JSON, save `settings.json.corrupt-<timestamp>.bak` and start from
//    defaults.
// 4. **Writes are atomic**: write `settings.json.tmp` in the same directory, then rename, so a crash
//    never leaves half a JSON file.
// 5. **The stable UI/runtime interface is the "dotted path"**: `get()` / `set()`, so adding a setting
//    does not change the IPC signature. Available paths are listed by `known_keys()`; each path is
//    validated (enum whitelist / type / whether the hotkey parses). Explicit writes are strict (an
//    error surfaces UI bugs early); reads from disk are lenient (one bad field does not drag down the
//    others).
//
// The runtime **does not cache in memory**: every read goes straight to the file (it is tiny), so
// "settings take effect immediately after an edit" holds naturally, and there is never "the UI changed
// it but another place still holds the old value".

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Settings document version, written by the program.
pub const SETTINGS_VERSION: u32 = 1;

/// Default global show hotkey (used when the user never configured one, or the field is corrupt)
pub const DEFAULT_HOTKEY: &str = "Option+Space";

/// Settings file name (inside the config directory)
const SETTINGS_FILE: &str = "settings.json";

/// The whole user-data root (`~/.yhub`): settings, state files, plugins, logs and the default capsule
/// library. Hidden on purpose, and the only place Y-Hub writes outside `capsules_dir`.
const CONFIG_DIR_NAME: &str = ".yhub";
/// Config directory override (lower priority than SETTINGS_FILE; tests / multiple configs only)
const ENV_CONFIG_DIR: &str = "YHUB_CONFIG_DIR";
/// Settings file override (highest priority; verification scripts use it to avoid touching the real
/// user config)
const ENV_SETTINGS_FILE: &str = "YHUB_SETTINGS_FILE";

/// Hotkey action id: toggle the panel (shares the behavior with the tray left click)
pub const ACTION_TOGGLE_PANEL: &str = "toggle_panel";
/// Hotkey action id: show the panel only (does not hide it when already visible)
pub const ACTION_SHOW_PANEL: &str = "show_panel";
/// Hotkey action id: hide the panel only
pub const ACTION_HIDE_PANEL: &str = "hide_panel";

/// Tray behavior field names (their order is the display order in the UI)
pub const TRAY_FIELDS: &[&str] = &[
    "close_behavior",
    "left_click",
    "double_click",
    "show_on_start",
    "show_notifications",
];

/// Allowed window-close behaviors: hide the panel (process stays in the menu bar) / quit
pub const CLOSE_BEHAVIORS: &[&str] = &["hide", "quit"];
/// Allowed tray behaviors: toggle the panel / pop the menu / do nothing
pub const CLICK_BEHAVIORS: &[&str] = &["toggle_panel", "show_menu", "none"];

/// A bindable global shortcut action (the UI builds its action list from this instead of hardcoding a copy)
#[derive(Debug, Clone, Serialize)]
pub struct HotkeyAction {
    pub id: &'static str,
    pub name: &'static str,
    pub default_combo: &'static str,
}

/// Catalog of bindable shortcut actions. Adding an action is one line here (the UI lists it automatically;
/// runtime dispatch by id lives in `hotkeys.rs`'s `run()`).
///
/// An empty `default_combo` = unbound by default (users upgrading from older versions are not given a
/// global key they never asked for).
pub const HOTKEY_ACTIONS: &[HotkeyAction] = &[
    HotkeyAction {
        id: ACTION_TOGGLE_PANEL,
        name: "呼出 / 收起面板",
        default_combo: DEFAULT_HOTKEY,
    },
    HotkeyAction {
        id: ACTION_SHOW_PANEL,
        name: "只呼出面板",
        default_combo: "",
    },
    HotkeyAction {
        id: ACTION_HIDE_PANEL,
        name: "只收起面板",
        default_combo: "",
    },
];

/// Tray behavior settings
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraySettings {
    /// When the main window is closed: hide = only hide (process stays in the menu bar), quit = exit the app
    pub close_behavior: String,
    /// Tray icon left click
    pub left_click: String,
    /// Tray icon left double click
    pub double_click: String,
    /// Whether to show the main window directly at startup
    pub show_on_start: bool,
    /// Whether to post a system notification on tray state changes (collapsed to the menu bar / quit);
    /// sent by tray.rs's `notify()` via osascript, failures are only logged
    pub show_notifications: bool,
}

impl Default for TraySettings {
    fn default() -> Self {
        TraySettings {
            // Matches the behavior currently implemented: closing only hides, left click toggles the panel
            close_behavior: "hide".into(),
            left_click: "toggle_panel".into(),
            double_click: "none".into(),
            show_on_start: false,
            show_notifications: false,
        }
    }
}

/// All settings. Missing fields always fall back to defaults (see `defaults()`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Settings {
    pub version: u32,
    /// Action id → combo. An empty string means "this action has no shortcut".
    pub hotkeys: BTreeMap<String, String>,
    pub tray: TraySettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self::defaults()
    }
}

impl Settings {
    /// All defaults
    pub fn defaults() -> Self {
        let mut hotkeys = BTreeMap::new();
        for action in HOTKEY_ACTIONS {
            hotkeys.insert(action.id.to_string(), action.default_combo.to_string());
        }
        Settings {
            version: SETTINGS_VERSION,
            hotkeys,
            tray: TraySettings::default(),
        }
    }

    /// Combo for one action: field missing → that action's default; explicitly empty → `None` (the user
    /// chose not to bind it)
    pub fn hotkey(&self, action: &str) -> Option<String> {
        match self.hotkeys.get(action) {
            Some(combo) if combo.trim().is_empty() => None,
            Some(combo) => Some(combo.trim().to_string()),
            None => hotkey_default(action).map(str::to_string),
        }
    }

    /// Toggle-panel combo (`None` = unbound)
    pub fn toggle_panel_hotkey(&self) -> Option<String> {
        self.hotkey(ACTION_TOGGLE_PANEL)
    }

    /// Fill in missing fields: every known action must have a value (missing ones get the default), so the
    /// persisted file is always complete
    fn normalize(&mut self) {
        for action in HOTKEY_ACTIONS {
            self.hotkeys
                .entry(action.id.to_string())
                .or_insert_with(|| action.default_combo.to_string());
        }
        if self.version < SETTINGS_VERSION {
            self.version = SETTINGS_VERSION;
        }
    }

    /// Dotted-path read. Unknown paths return a human-readable error (with the list of available paths).
    pub fn get_path(&self, key: &str) -> Result<Value, String> {
        match key {
            "version" => Ok(json!(self.version)),
            "hotkeys" => to_value(&self.hotkeys),
            "tray" => to_value(&self.tray),
            _ => {
                if let Some(action) = key.strip_prefix("hotkeys.") {
                    if hotkey_default(action).is_none() {
                        return Err(unknown_key_error(key));
                    }
                    return Ok(json!(self.hotkeys.get(action).cloned().unwrap_or_default()));
                }
                if let Some(field) = key.strip_prefix("tray.") {
                    return match field {
                        "close_behavior" => Ok(json!(self.tray.close_behavior)),
                        "left_click" => Ok(json!(self.tray.left_click)),
                        "double_click" => Ok(json!(self.tray.double_click)),
                        "show_on_start" => Ok(json!(self.tray.show_on_start)),
                        "show_notifications" => Ok(json!(self.tray.show_notifications)),
                        _ => Err(unknown_key_error(key)),
                    };
                }
                Err(unknown_key_error(key))
            }
        }
    }

    /// Dotted-path write (validates, then changes memory only; `set()` / `save()` handle persistence)
    pub fn set_path(&mut self, key: &str, value: &Value) -> Result<(), String> {
        match key {
            // The version is maintained by the program and is read-only.
            "version" => Err("version 由程序维护，不能直接设置".into()),
            "hotkeys" => {
                let map = value.as_object().ok_or_else(|| {
                    "hotkeys 必须是对象，例如 {\"toggle_panel\":\"Option+Space\"}".to_string()
                })?;
                let mut next: BTreeMap<String, String> = BTreeMap::new();
                for (action, combo) in map {
                    if hotkey_default(action).is_none() {
                        return Err(format!(
                            "未知热键动作 \"{action}\"；可用：{}",
                            action_ids().join(", ")
                        ));
                    }
                    let combo = combo
                        .as_str()
                        .ok_or_else(|| format!("hotkeys.{action} 必须是字符串"))?;
                    check_hotkey(action, combo)?;
                    next.insert(action.to_string(), combo.trim().to_string());
                }
                // Fill in missing actions + check duplicates (a filled-in default can collide with an
                // explicit value too), then replace wholesale
                let mut probe = self.clone();
                probe.hotkeys = next;
                probe.normalize();
                check_hotkeys_unique(&probe)?;
                *self = probe;
                Ok(())
            }
            "tray" => {
                let map = value
                    .as_object()
                    .ok_or_else(|| "tray 必须是对象，例如 {\"close_behavior\":\"hide\"}".to_string())?;
                for (field, v) in map {
                    let path = format!("tray.{field}");
                    if !TRAY_FIELDS.contains(&field.as_str()) {
                        return Err(unknown_key_error(&path));
                    }
                    self.set_path(&path, v)?;
                }
                Ok(())
            }
            _ => {
                if let Some(action) = key.strip_prefix("hotkeys.") {
                    if hotkey_default(action).is_none() {
                        return Err(unknown_key_error(key));
                    }
                    let combo = value
                        .as_str()
                        .ok_or_else(|| format!("{key} 必须是字符串（留空字符串表示不绑定）"))?;
                    check_hotkey(action, combo)?;
                    check_hotkey_conflict(self, action, combo)?;
                    self.hotkeys
                        .insert(action.to_string(), combo.trim().to_string());
                    return Ok(());
                }
                if let Some(field) = key.strip_prefix("tray.") {
                    match field {
                        "close_behavior" => {
                            self.tray.close_behavior = pick_one(field, value, CLOSE_BEHAVIORS)?;
                            return Ok(());
                        }
                        "left_click" | "double_click" => {
                            let v = pick_one(field, value, CLICK_BEHAVIORS)?;
                            if field == "left_click" {
                                self.tray.left_click = v;
                            } else {
                                self.tray.double_click = v;
                            }
                            return Ok(());
                        }
                        "show_on_start" => {
                            self.tray.show_on_start = pick_bool(field, value)?;
                            return Ok(());
                        }
                        "show_notifications" => {
                            self.tray.show_notifications = pick_bool(field, value)?;
                            return Ok(());
                        }
                        _ => return Err(unknown_key_error(key)),
                    }
                }
                Err(unknown_key_error(key))
            }
        }
    }
}

// ---------------------------------------------------------------- paths and files

/// Config directory: parent of `YHUB_SETTINGS_FILE` > `YHUB_CONFIG_DIR` > ~/.yhub
///
/// The log directory also hangs off it (`backend.rs`'s `log_dir()`), so verification scripts using a
/// temporary config directory also get their logs there and never touch the real user directory.
///
/// No migration of the old `~/.config/yhub` root: the project has no users to carry over yet, so a
/// second code path that copies directories around on first start would be pure risk. Python's
/// `config_dir()` has the same three fallbacks and the same (absent) migration.
pub fn config_dir() -> PathBuf {
    if let Some(file) = env_path(ENV_SETTINGS_FILE) {
        if let Some(parent) = file.parent() {
            if !parent.as_os_str().is_empty() {
                return parent.to_path_buf();
            }
        }
    }
    if let Some(dir) = env_path(ENV_CONFIG_DIR) {
        return dir;
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    default_config_dir(&home)
}

/// The default user-data root (`~/.yhub`); pure — no environment, no I/O.
fn default_config_dir(home: &Path) -> PathBuf {
    home.join(CONFIG_DIR_NAME)
}

/// Settings file path: `YHUB_SETTINGS_FILE` > `YHUB_CONFIG_DIR`/settings.json > ~/.yhub/settings.json
pub fn settings_path() -> PathBuf {
    if let Some(file) = env_path(ENV_SETTINGS_FILE) {
        return file;
    }
    config_dir().join(SETTINGS_FILE)
}

fn env_path(name: &str) -> Option<PathBuf> {
    let raw = std::env::var(name).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// Load settings (from the default path). File missing = brand-new user: return defaults without writing.
pub fn load() -> Settings {
    load_from(&settings_path())
}

/// Load settings + warnings (corruption / ignored fields all show up as warnings, so
/// "config did not take effect" problems are traceable)
pub fn load_with_warnings() -> (Settings, Vec<String>) {
    load_with_warnings_from(&settings_path())
}

/// Save the whole settings document to the default path (atomic write: tmp + rename).
/// Available for future "import / bulk edit"; single-item changes go through `set()`, so the runtime
/// does not call this yet.
#[allow(dead_code)]
pub fn save(settings: &Settings) -> Result<(), String> {
    save_to(&settings_path(), settings)
}

/// Write a single setting: read → validate → persist → return the full settings after the write.
/// `value = null` restores the item to its default ("reset this item" in the UI).
pub fn set(key: &str, value: Value) -> Result<Settings, String> {
    set_in(&settings_path(), key, value)
}

/// Restore defaults: with a key only that item, without a key everything
pub fn reset(key: Option<&str>) -> Result<Settings, String> {
    reset_in(&settings_path(), key)
}

/// Default value of an item (the UI shows "default is X")
pub fn default_value(key: &str) -> Result<Value, String> {
    Settings::defaults().get_path(key)
}

/// All known setting paths (dotted paths / section names can both be fed to get() / set())
pub fn known_keys() -> Vec<String> {
    let mut keys = vec!["version".to_string(), "hotkeys".to_string()];
    for action in HOTKEY_ACTIONS {
        keys.push(format!("hotkeys.{}", action.id));
    }
    keys.push("tray".to_string());
    for field in TRAY_FIELDS {
        keys.push(format!("tray.{field}"));
    }
    // The remaining keys (capsules_* / plugins / ui_language / …) **belong to the backend**: the shell
    // keeps only the startup-essential hotkeys and tray; the settings UI routes the rest through
    // /api/settings.
    keys
}

/// Is this dotted path owned by the shell (startup-essential, read/written by Rust)?
/// Other keys are owned by the Python backend; the shell's `save` merges only its own keys and never
/// overwrites the whole file.
pub fn is_shell_key(key: &str) -> bool {
    key == "version"
        || key == "hotkeys"
        || key.starts_with("hotkeys.")
        || key == "tray"
        || key.starts_with("tray.")
}

/// Catalog for rendering the settings form: allowed values, action table, defaults snapshot (do not
/// hardcode another copy in the frontend)
pub fn schema() -> Value {
    // defaults only covers shell-owned keys: defaults for the other keys come from the backend's
    // /api/settings schema.
    let d = Settings::defaults();
    json!({
        "version": SETTINGS_VERSION,
        "keys": known_keys(),
        "hotkey_actions": HOTKEY_ACTIONS,
        "tray_fields": TRAY_FIELDS,
        "close_behaviors": CLOSE_BEHAVIORS,
        "click_behaviors": CLICK_BEHAVIORS,
        "defaults": {
            "version": d.version,
            "hotkeys": d.hotkeys,
            "tray": d.tray,
        },
    })
}

/// Default combo for an action (`None` = not a known action)
pub fn hotkey_default(action: &str) -> Option<&'static str> {
    HOTKEY_ACTIONS
        .iter()
        .find(|a| a.id == action)
        .map(|a| a.default_combo)
}

// ---------------------------------------------------------------- read/write implementation (internal versions take a path, for testing)

fn load_from(path: &Path) -> Settings {
    load_with_warnings_from(path).0
}

fn load_with_warnings_from(path: &Path) -> (Settings, Vec<String>) {
    let mut warnings: Vec<String> = Vec::new();

    let raw = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (Settings::defaults(), warnings),
        Err(e) => {
            warnings.push(format!(
                "读取 {} 失败（{e}），本次按默认值运行",
                path.display()
            ));
            return (Settings::defaults(), warnings);
        }
    };

    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(e) => {
            warnings.push(quarantine(path, "corrupt", &format!("不是合法 JSON（{e}）")));
            return (Settings::defaults(), warnings);
        }
    };
    if !parsed.is_object() {
        warnings.push(quarantine(path, "corrupt", "顶层不是 JSON 对象"));
        return (Settings::defaults(), warnings);
    }

    let mut settings = Settings::defaults();
    for key in overlay_keys() {
        let Some(value) = value_at(&parsed, &key) else {
            continue;
        };
        if let Err(e) = settings.set_path(&key, value) {
            warnings.push(format!("{key} 取值非法：{e}（已改用默认值）"));
        }
    }

    let unknown = unknown_keys(&parsed);
    if !unknown.is_empty() {
        warnings.push(format!("已忽略未知设置项：{}", unknown.join(", ")));
    }

    settings.normalize();
    (settings, warnings)
}

fn save_to(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建配置目录 {} 失败：{e}", parent.display()))?;
    }
    let mut normalized = settings.clone();
    normalized.normalize();

    // Merge only the shell's own keys (version / hotkeys / tray) and **preserve the other top-level
    // keys verbatim**: capsules_* / plugins / … are owned by the Python backend (/api/settings).
    // Writing the whole structure back used to silently erase keys the backend had just written — the
    // trap AGENTS.md calls out by name.
    let mut root: Value = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
    let obj = root.as_object_mut().expect("root 已是对象");
    obj.insert("version".into(), json!(normalized.version));
    obj.insert("hotkeys".into(), serde_json::to_value(&normalized.hotkeys)
        .map_err(|e| format!("序列化 hotkeys 失败：{e}"))?);
    obj.insert("tray".into(), serde_json::to_value(&normalized.tray)
        .map_err(|e| format!("序列化 tray 失败：{e}"))?);

    let json = serde_json::to_string_pretty(&root).map_err(|e| format!("序列化失败：{e}"))?;

    // Atomic write: write a temp file in the same directory, then rename over the target, so no
    // half-written file is left behind
    let tmp = tmp_path(path);
    fs::write(&tmp, json).map_err(|e| format!("写入 {} 失败：{e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("替换 {} 失败：{e}", path.display())
    })?;
    Ok(())
}

fn set_in(path: &Path, key: &str, value: Value) -> Result<Settings, String> {
    let (mut settings, _warnings) = load_with_warnings_from(path);
    // null = restore this item's default
    let value = if value.is_null() {
        default_value(key)?
    } else {
        value
    };
    settings.set_path(key, &value)?;
    settings.normalize();
    save_to(path, &settings)?;
    Ok(settings)
}

fn reset_in(path: &Path, key: Option<&str>) -> Result<Settings, String> {
    let settings = match key {
        None => Settings::defaults(),
        Some(key) => {
            let (mut settings, _warnings) = load_with_warnings_from(path);
            let default = default_value(key)?;
            settings.set_path(key, &default)?;
            settings
        }
    };
    let mut settings = settings;
    settings.normalize();
    save_to(path, &settings)?;
    Ok(settings)
}

// ---------------------------------------------------------------- small helpers

fn tmp_path(path: &Path) -> PathBuf {
    match path.file_name() {
        Some(name) => path.with_file_name(format!("{}.tmp", name.to_string_lossy())),
        None => path.with_extension("tmp"),
    }
}

/// Move a bad file to `<name>.<tag>.bak` in the same directory (rename, does not copy contents).
/// Returns the backup path; `Ok(None)` when the original file does not exist.
fn backup_file(path: &Path, tag: &str) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let Some(name) = path.file_name() else {
        return Err(format!("{} 没有文件名", path.display()));
    };
    let bak = path.with_file_name(format!("{}.{tag}.bak", name.to_string_lossy()));
    fs::rename(path, &bak).map_err(|e| format!("备份 {} → {} 失败：{e}", path.display(), bak.display()))?;
    Ok(Some(bak))
}

fn quarantine(path: &Path, tag: &str, why: &str) -> String {
    let tagged = format!("{tag}-{}", now_secs());
    match backup_file(path, &tagged) {
        Ok(Some(bak)) => format!(
            "{} {why}，已备份为 {}，本次按默认值运行",
            path.display(),
            bak.display()
        ),
        Ok(None) => format!("{} {why}，本次按默认值运行", path.display()),
        Err(e) => format!("{} {why}，且备份失败（{e}），本次按默认值运行", path.display()),
    }
}

fn value_at<'a>(root: &'a Value, key: &str) -> Option<&'a Value> {
    let mut cursor = root;
    for part in key.split('.') {
        cursor = cursor.get(part)?;
    }
    Some(cursor)
}

/// Paths read when overlaying item by item from disk (`version` is program-managed, section names are
/// just containers)
fn overlay_keys() -> Vec<String> {
    let mut keys: Vec<String> = HOTKEY_ACTIONS
        .iter()
        .map(|a| format!("hotkeys.{}", a.id))
        .collect();
    keys.extend(TRAY_FIELDS.iter().map(|f| format!("tray.{f}")));
    keys
}

/// Fields present in the file but unknown (a hint only, does not affect reading)
fn unknown_keys(root: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Some(obj) = root.as_object() else {
        return out;
    };
    for (key, value) in obj {
        match key.as_str() {
            // Backend-owned keys are ignored by the shell, not treated as unknown.
            "version" | "capsules_dir" | "capsules_disabled"
            | "capsules_subdomains" | "capsules_subdomains_overrides" | "plugins_registry_url" | "ui_language"
            | "plugins" => {}
            "hotkeys" => {
                if let Some(map) = value.as_object() {
                    for action in map.keys() {
                        if hotkey_default(action).is_none() {
                            out.push(format!("hotkeys.{action}"));
                        }
                    }
                }
            }
            "tray" => {
                if let Some(map) = value.as_object() {
                    for field in map.keys() {
                        if !TRAY_FIELDS.contains(&field.as_str()) {
                            out.push(format!("tray.{field}"));
                        }
                    }
                }
            }
            other => out.push(other.to_string()),
        }
    }
    out
}

fn action_ids() -> Vec<&'static str> {
    HOTKEY_ACTIONS.iter().map(|a| a.id).collect()
}

fn unknown_key_error(key: &str) -> String {
    format!(
        "未知设置项 \"{key}\"；可用路径：{}",
        known_keys().join(" / ")
    )
}

/// Validate that the system can parse a combo (call it before registering at runtime; an empty string =
/// unbound, allowed)
pub fn validate_hotkey(combo: &str) -> Result<(), String> {
    let trimmed = combo.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    // Borrow the plugin's own parser, so what the UI stores is exactly what the runtime can register
    tauri_plugin_global_shortcut::Shortcut::from_str(trimmed)
        .map(|_| ())
        .map_err(|e| {
            format!(
                "组合键 \"{combo}\" 无法解析（{e}）：形如 Option+Space、Cmd+Shift+K、Ctrl+Cmd+Shift+F9"
            )
        })
}

fn check_hotkey(action: &str, combo: &str) -> Result<(), String> {
    validate_hotkey(combo).map_err(|e| format!("hotkeys.{action}：{e}"))
}

/// Are two combo strings the same hotkey? Compares **parsed values**, independent of modifier order /
/// aliases / case: `Cmd+Shift+K`, `Shift+Cmd+K`, `meta+shift+k` are the same key at the system level and
/// must count as the same key in config too; otherwise two actions could use different spellings, no
/// conflict would be detected, and only one of them could register.
fn same_combo(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() || b.is_empty() {
        return false; // empty = unbound, does not count as taken
    }
    if a == b {
        return true;
    }
    match (
        tauri_plugin_global_shortcut::Shortcut::from_str(a),
        tauri_plugin_global_shortcut::Shortcut::from_str(b),
    ) {
        (Ok(a), Ok(b)) => a == b,
        // Values that fail to parse are already blocked at the write entry by validate_hotkey; fall back
        // to literal comparison here
        _ => false,
    }
}

/// Is combo `combo` already taken by **another** action? Returns the occupying action's name.
///
/// An empty string = unbound, not counted as taken. Pre-write conflict detection relies on it: give a
/// human-readable hint first (say which action holds it) instead of waiting for a system registration
/// failure — which can only say "taken" in general terms.
pub fn hotkey_holder<'a>(
    settings: &'a Settings,
    action: &str,
    combo: &str,
) -> Option<&'a str> {
    if combo.trim().is_empty() {
        return None;
    }
    HOTKEY_ACTIONS
        .iter()
        .find(|a| {
            a.id != action
                && settings
                    .hotkey(a.id)
                    .is_some_and(|current| same_combo(&current, combo))
        })
        .map(|a| a.name)
}

/// One combo must not be bound to two actions ("two actions fighting over one key" in the UI is an
/// explicit error)
fn check_hotkey_conflict(settings: &Settings, action: &str, combo: &str) -> Result<(), String> {
    match hotkey_holder(settings, action, combo) {
        Some(holder) => Err(format!(
            "组合键 \"{}\" 已经绑定给「{holder}」，同一个组合键不能绑两个动作（先改掉那一项，或换一个组合键）",
            combo.trim()
        )),
        None => Ok(()),
    }
}

/// Duplicate check for the whole hotkey map (used by "write the hotkeys section whole"; single writes go
/// through `check_hotkey_conflict`)
fn check_hotkeys_unique(settings: &Settings) -> Result<(), String> {
    for (i, action) in HOTKEY_ACTIONS.iter().enumerate() {
        let Some(current) = settings.hotkey(action.id) else {
            continue;
        };
        if let Some(twin) = HOTKEY_ACTIONS[i + 1..].iter().find(|other| {
            settings
                .hotkey(other.id)
                .is_some_and(|combo| same_combo(&combo, &current))
        }) {
            return Err(format!(
                "组合键 \"{current}\" 同时绑给了「{}」和「{}」，同一个组合键只能绑一个动作",
                action.name, twin.name
            ));
        }
    }
    Ok(())
}

fn check_enum(field: &str, value: &Value, allowed: &[&str]) -> Result<String, String> {
    let raw = value
        .as_str()
        .ok_or_else(|| format!("{field} 必须是字符串（可选：{}）", allowed.join(" / ")))?;
    let trimmed = raw.trim();
    if allowed.contains(&trimmed) {
        Ok(trimmed.to_string())
    } else {
        Err(format!(
            "{field} 取值 \"{raw}\" 不合法（可选：{}）",
            allowed.join(" / ")
        ))
    }
}

fn pick_one(field: &str, value: &Value, allowed: &[&str]) -> Result<String, String> {
    check_enum(&format!("tray.{field}"), value, allowed)
}

fn pick_bool(field: &str, value: &Value) -> Result<bool, String> {
    value
        .as_bool()
        .ok_or_else(|| format!("tray.{field} 必须是布尔值 true / false"))
}

fn to_value<T: Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| format!("序列化设置失败：{e}"))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    /// One exclusive directory per test (never touches the real user config)
    struct Scratch {
        dir: PathBuf,
    }

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "yhub-settings-test-{}-{tag}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("建测试目录");
            Scratch { dir }
        }

        fn file(&self) -> PathBuf {
            self.dir.join(SETTINGS_FILE)
        }

        fn write(&self, text: &str) {
            fs::write(self.file(), text).expect("写测试配置");
        }

        fn read(&self) -> Value {
            let text = fs::read_to_string(self.file()).expect("读测试配置");
            serde_json::from_str(&text).expect("测试配置应是合法 JSON")
        }

        fn siblings(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&self.dir)
                .expect("列目录")
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            names.sort();
            names
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn defaults_when_file_missing() {
        let s = Scratch::new("missing");
        let (settings, warnings) = load_with_warnings_from(&s.file());
        assert!(warnings.is_empty(), "全新用户不该有警告：{warnings:?}");
        assert_eq!(settings, Settings::defaults());
        assert_eq!(settings.version, SETTINGS_VERSION);
        assert_eq!(
            settings.toggle_panel_hotkey().as_deref(),
            Some(DEFAULT_HOTKEY)
        );
        assert_eq!(settings.tray.close_behavior, "hide");
        assert_eq!(settings.tray.left_click, "toggle_panel");
        assert_eq!(settings.tray.double_click, "none");
        assert!(!settings.tray.show_on_start);
        // Read-only: nothing is created out of thin air when the file is missing
        assert!(!s.file().exists(), "缺失字段不该触发写盘");
    }

    #[test]
    fn save_then_load_roundtrip_survives_restart() {
        let s = Scratch::new("roundtrip");
        let mut settings = Settings::defaults();
        settings.set_path("hotkeys.toggle_panel", &json!("Cmd+Shift+K")).unwrap();
        settings.set_path("tray.close_behavior", &json!("quit")).unwrap();
        settings.set_path("tray.left_click", &json!("show_menu")).unwrap();
        settings.set_path("tray.double_click", &json!("none")).unwrap();
        settings.set_path("tray.show_on_start", &json!(true)).unwrap();
        // The file already holds backend-owned keys: the shell's save must not wipe them
        s.write(
            r#"{"version":1,"capsules_dir":"~/Y-Hub/capsules","plugins":{"demo":{"x":1}}}"#,
        );
        save_to(&s.file(), &settings).unwrap();

        // Simulate a restart: shell keys read back from disk, backend keys preserved verbatim
        let (reloaded, warnings) = load_with_warnings_from(&s.file());
        assert!(warnings.is_empty(), "重启读回不该有警告：{warnings:?}");
        assert_eq!(reloaded.hotkeys, settings.hotkeys);
        assert_eq!(reloaded.tray, settings.tray);
        assert_eq!(reloaded.toggle_panel_hotkey().as_deref(), Some("Cmd+Shift+K"));
        assert_eq!(s.read()["capsules_dir"], json!("~/Y-Hub/capsules"));
        assert_eq!(s.read()["plugins"]["demo"]["x"], json!(1));

        // Persistence is atomic: no tmp file left behind
        assert_eq!(s.siblings(), vec![SETTINGS_FILE.to_string()]);
        assert_eq!(s.read()["version"], json!(SETTINGS_VERSION));
    }

    #[test]
    fn missing_and_broken_fields_fall_back_to_defaults() {
        let s = Scratch::new("partial");
        s.write(
            r#"{
                "version": 1,
                "hotkeys": {"toggle_panel": 42},
                "tray": {"show_on_start": true, "close_behavior": "explode", "nope": 1},
                "future_section": {"x": 1}
            }"#,
        );
        let (settings, warnings) = load_with_warnings_from(&s.file());

        assert!(settings.tray.show_on_start, "合法字段要保留");
        assert_eq!(settings.tray.close_behavior, "hide", "非法枚举回退默认");
        assert_eq!(settings.tray.left_click, "toggle_panel", "缺失字段回退默认");
        assert_eq!(settings.tray.double_click, "none");
        assert_eq!(
            settings.toggle_panel_hotkey().as_deref(),
            Some(DEFAULT_HOTKEY),
            "坏热键回退默认"
        );
        let joined = warnings.join(" | ");
        assert!(joined.contains("hotkeys.toggle_panel"), "{joined}");
        assert!(joined.contains("tray.close_behavior"), "{joined}");
        assert!(joined.contains("future_section"), "{joined}");
        assert!(joined.contains("tray.nope"), "{joined}");
    }

    #[test]
    fn corrupt_file_is_quarantined_and_defaults_apply() {
        let s = Scratch::new("corrupt");
        s.write("{ 这不是 JSON");
        let (settings, warnings) = load_with_warnings_from(&s.file());

        assert_eq!(settings, Settings::defaults());
        assert!(warnings.iter().any(|w| w.contains("已备份")));
        // The original file was moved away (user data is not deleted); there is no settings.json right now
        assert!(!s.file().exists());
        assert!(s
            .siblings()
            .iter()
            .any(|n| n.contains(".corrupt-") && n.ends_with(".bak")));

        // A corrupt file must still be usable: one write restores a complete v1 file
        save_to(&s.file(), &Settings::defaults()).unwrap();
        assert_eq!(s.read()["version"], json!(SETTINGS_VERSION));
    }

    #[test]
    fn set_is_validated_and_other_keys_untouched() {
        let s = Scratch::new("validate");
        set_in(&s.file(), "tray.close_behavior", json!("quit")).unwrap();

        // Valid: hotkeys / enums / booleans / lists
        let after = set_in(&s.file(), "hotkeys.toggle_panel", json!(" Ctrl+Cmd+Shift+F9 ")).unwrap();
        assert_eq!(after.toggle_panel_hotkey().as_deref(), Some("Ctrl+Cmd+Shift+F9"));
        set_in(&s.file(), "tray.show_notifications", json!(true)).unwrap();
        let after = set_in(&s.file(), "tray.left_click", json!("show_menu")).unwrap();
        assert_eq!(after.tray.left_click, "show_menu");
        // Previously written items are still there (a dotted-path write does not overwrite other items)
        assert_eq!(after.tray.close_behavior, "quit");

        // Invalid: unknown path / unknown action / unknown enum / wrong type / read-only version / a
        // non-directory for a directory key
        for (key, value) in [
            ("nope", json!(1)),
            ("tray.nope", json!(1)),
            ("hotkeys.nope", json!("Cmd+K")),
            ("tray.close_behavior", json!("explode")),
            ("tray.show_on_start", json!("yes")),
            ("version", json!(9)),
            ("tray.left_click", json!(true)),
        ] {
            assert!(
                set_in(&s.file(), key, value.clone()).is_err(),
                "{key} = {value} 应该被拒绝"
            );
        }
        assert!(set_in(&s.file(), "hotkeys.toggle_panel", json!("NotAKey")).is_err());
        assert!(set_in(&s.file(), "hotkeys.toggle_panel", json!("Ctrl")).is_err(), "纯修饰键不是组合键");

        // Failure does not corrupt the file: disk still holds the last valid content
        let (disk, warnings) = load_with_warnings_from(&s.file());
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(disk.tray.left_click, "show_menu");
        assert_eq!(disk.tray.close_behavior, "quit");
    }

    #[test]
    fn null_value_and_reset_restore_defaults() {
        let s = Scratch::new("reset");
        set_in(&s.file(), "tray.left_click", json!("none")).unwrap();
        set_in(&s.file(), "hotkeys.toggle_panel", json!("Cmd+Shift+K")).unwrap();

        // null = restore this item's default value
        let after = set_in(&s.file(), "tray.left_click", Value::Null).unwrap();
        assert_eq!(after.tray.left_click, "toggle_panel");
        assert_eq!(
            after.toggle_panel_hotkey().as_deref(),
            Some("Cmd+Shift+K"),
            "别的项不受影响"
        );

        // Whole-section restore: only tray falls back
        set_in(&s.file(), "tray.show_on_start", json!(true)).unwrap();
        let after = reset_in(&s.file(), Some("tray")).unwrap();
        assert_eq!(after.tray, TraySettings::default());
        assert_eq!(after.toggle_panel_hotkey().as_deref(), Some("Cmd+Shift+K"));

        // Restore everything
        let after = reset_in(&s.file(), None).unwrap();
        assert_eq!(after, Settings::defaults());
        assert_eq!(load_from(&s.file()), Settings::defaults(), "恢复默认要落盘");
    }

    #[test]
    fn unbound_hotkey_is_representable() {
        let s = Scratch::new("unbound");
        // An explicit empty string = unbound (distinct from "field missing = use default")
        let after = set_in(&s.file(), "hotkeys.toggle_panel", json!("")).unwrap();
        assert_eq!(after.toggle_panel_hotkey(), None);
        let reloaded = load_from(&s.file());
        assert_eq!(reloaded.toggle_panel_hotkey(), None);
        assert!(
            reloaded.hotkeys.contains_key(ACTION_TOGGLE_PANEL),
            "空值要写进文件，不能被默认值填回来"
        );
        // Restoring defaults makes it bindable again
        let after = reset_in(&s.file(), Some("hotkeys.toggle_panel")).unwrap();
        assert_eq!(after.toggle_panel_hotkey().as_deref(), Some(DEFAULT_HOTKEY));
    }

    #[test]
    fn hotkey_conflict_is_rejected_on_write_and_tolerated_on_read() {
        let s = Scratch::new("conflict");
        // Write: one combo cannot bind two actions, and the error must say who holds it
        set_in(&s.file(), "hotkeys.show_panel", json!("Ctrl+Cmd+Shift+F9")).unwrap();
        let err = set_in(&s.file(), "hotkeys.hide_panel", json!("Ctrl+Cmd+Shift+F9")).unwrap_err();
        assert!(err.contains("已经绑定给") && err.contains("只呼出面板"), "{err}");

        // After rejection the disk still holds the last valid content: hide_panel stays unbound
        let disk = load_from(&s.file());
        assert_eq!(disk.hotkey(ACTION_HIDE_PANEL), None);
        assert_eq!(
            disk.hotkey(ACTION_SHOW_PANEL).as_deref(),
            Some("Ctrl+Cmd+Shift+F9")
        );
        // A non-conflicting combo goes through
        set_in(&s.file(), "hotkeys.hide_panel", json!("Ctrl+Cmd+Shift+F8")).unwrap();

        // Read: a hand-edited file with duplicate bindings → only one warning, no duplicates in memory (the
        // later one falls back to default)
        s.write(
            r#"{"version":1,"hotkeys":{"toggle_panel":"Ctrl+Cmd+Shift+F9","show_panel":"Ctrl+Cmd+Shift+F9"}}"#,
        );
        let (settings, warnings) = load_with_warnings_from(&s.file());
        assert_eq!(
            settings.toggle_panel_hotkey().as_deref(),
            Some("Ctrl+Cmd+Shift+F9")
        );
        assert_eq!(
            settings.hotkey(ACTION_SHOW_PANEL),
            None,
            "重复的那项回退默认（= 不绑定）"
        );
        assert!(
            warnings.iter().any(|w| w.contains("show_panel")),
            "{warnings:?}"
        );
    }

    #[test]
    fn hotkey_conflict_ignores_modifier_order_and_aliases() {
        let s = Scratch::new("conflict-order");
        set_in(&s.file(), "hotkeys.show_panel", json!("Cmd+Shift+K")).unwrap();
        // Different spellings but the same hotkey at the system level: must still be a conflict (otherwise
        // two actions would fight over one key)
        for alias in ["Shift+Cmd+K", "shift+cmd+k", "Shift+Super+K", "shift+command+k"] {
            let err = set_in(&s.file(), "hotkeys.hide_panel", json!(alias)).unwrap_err();
            assert!(err.contains("已经绑定给"), "{alias} 应判为冲突：{err}");
            assert!(err.contains("只呼出面板"), "{alias}：{err}");
            assert_eq!(load_from(&s.file()).hotkey(ACTION_HIDE_PANEL), None);
        }
        // The parser knows a limited set of aliases: only tokens in its table count as modifiers ("meta"
        // does not)
        assert!(set_in(&s.file(), "hotkeys.hide_panel", json!("meta+shift+k")).is_err());

        let settings = load_from(&s.file());
        assert_eq!(
            hotkey_holder(&settings, ACTION_SHOW_PANEL, "Shift+Cmd+K"),
            None,
            "同一个动作自己不算冲突"
        );
        assert!(
            hotkey_holder(&settings, ACTION_HIDE_PANEL, "Cmd+Option+K").is_none(),
            "修饰键不同就不是同一个热键"
        );
        assert_eq!(
            hotkey_holder(&settings, ACTION_HIDE_PANEL, "command+shift+k"),
            Some("只呼出面板")
        );
        assert_eq!(
            hotkey_holder(&settings, ACTION_HIDE_PANEL, "Shift+Cmd+J"),
            None,
            "普通键不同就不是同一个热键"
        );

        // Different regular keys are not the same hotkey
        set_in(&s.file(), "hotkeys.hide_panel", json!("Shift+Cmd+J")).unwrap();
        assert_eq!(
            load_from(&s.file()).hotkey(ACTION_HIDE_PANEL).as_deref(),
            Some("Shift+Cmd+J")
        );
        // A whole-section hotkey map is also deduplicated by parsed value
        let err = set_in(
            &s.file(),
            "hotkeys",
            json!({"toggle_panel": "Shift+Cmd+K", "show_panel": "Cmd+Shift+K"}),
        )
        .unwrap_err();
        assert!(err.contains("只能绑一个动作"), "{err}");
    }

    #[test]
    fn extra_actions_default_to_unbound() {
        let settings = Settings::defaults();
        assert_eq!(settings.hotkey(ACTION_SHOW_PANEL), None, "默认不绑定");
        assert_eq!(settings.hotkey(ACTION_HIDE_PANEL), None, "默认不绑定");
        assert_eq!(
            settings.hotkey(ACTION_TOGGLE_PANEL).as_deref(),
            Some(DEFAULT_HOTKEY)
        );
        // Writing an empty string = explicit unbind (distinct from "field missing = default")
        let s = Scratch::new("extra-unbound");
        let after = set_in(&s.file(), "hotkeys.show_panel", json!("")).unwrap();
        assert_eq!(after.hotkey(ACTION_SHOW_PANEL), None);
        assert!(load_from(&s.file()).hotkeys.contains_key(ACTION_SHOW_PANEL));
        // Restore defaults: an action that is unbound by default stays unbound
        let after = reset_in(&s.file(), Some("hotkeys.show_panel")).unwrap();
        assert_eq!(after.hotkey(ACTION_SHOW_PANEL), None);
    }

    #[test]
    fn schema_exposes_actions_options_and_defaults() {
        let schema = schema();
        assert_eq!(schema["version"], json!(SETTINGS_VERSION));
        assert_eq!(schema["hotkey_actions"][0]["id"], json!(ACTION_TOGGLE_PANEL));
        assert_eq!(
            schema["hotkey_actions"][0]["default_combo"],
            json!(DEFAULT_HOTKEY)
        );
        assert_eq!(schema["close_behaviors"], json!(["hide", "quit"]));
        assert_eq!(
            schema["click_behaviors"],
            json!(["toggle_panel", "show_menu", "none"])
        );
        assert_eq!(schema["defaults"]["version"], json!(SETTINGS_VERSION));

        // Every known path resolves to a default value (the UI's "reset this item" uses it directly)
        for key in known_keys() {
            assert!(default_value(&key).is_ok(), "{key} 取不到默认值");
        }
        assert_eq!(default_value("hotkeys.toggle_panel").unwrap(), json!(DEFAULT_HOTKEY));
        assert_eq!(default_value("tray.close_behavior").unwrap(), json!("hide"));
        assert!(default_value("nope").is_err());
    }

    #[test]
    fn settings_path_honours_env_overrides() {
        // Only this test changes environment variables; other tests use the path-taking internal versions,
        // so they do not interfere
        let dir = std::env::temp_dir().join(format!("yhub-settings-env-{}", std::process::id()));
        std::env::set_var(ENV_CONFIG_DIR, &dir);
        assert_eq!(settings_path(), dir.join(SETTINGS_FILE));

        let file = dir.join("custom.json");
        std::env::set_var(ENV_SETTINGS_FILE, &file);
        assert_eq!(settings_path(), file, "YHUB_SETTINGS_FILE 优先级更高");

        std::env::remove_var(ENV_SETTINGS_FILE);
        std::env::remove_var(ENV_CONFIG_DIR);
        // Default root name — asserted through the pure helper so a test never touches the
        // developer's home directory.
        assert_eq!(
            default_config_dir(Path::new("/Users/example")),
            PathBuf::from("/Users/example/.yhub")
        );
    }

    // ------------------------------------------------------------ capsules_dir
    #[test]
    fn shell_owns_only_hotkeys_and_tray() {
        assert!(is_shell_key("hotkeys"));
        assert!(is_shell_key("hotkeys.toggle_panel"));
        assert!(is_shell_key("tray"));
        assert!(is_shell_key("tray.close_behavior"));
        assert!(is_shell_key("version"));
        assert!(!is_shell_key("capsules_dir"));
        assert!(!is_shell_key("capsules_disabled"));
        assert!(!is_shell_key("plugins"));
        assert!(!is_shell_key("plugins.demo.base_url"));
    }
    #[test]
    fn schema_only_exposes_shell_keys() {
        let schema = schema();
        let keys: Vec<String> = schema["keys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap().to_string())
            .collect();
        assert!(keys.contains(&"hotkeys".to_string()));
        assert!(keys.contains(&"tray".to_string()));
        assert!(!keys.iter().any(|k| k.starts_with("capsules") || k.starts_with("plugins")));
        // The defaults snapshot only covers the shell's own part
        assert!(schema["defaults"].get("capsules_dir").is_none());
    }
    // ------------------------------------------------------------ plugins open section (stage E)

    #[test]
    fn shell_save_preserves_backend_owned_keys() {
        let s = Scratch::new("preserve-backend");
        s.write(
            r#"{
                "version": 1,
                "hotkeys": {"toggle_panel": "Option+Space"},
                "tray": {"close_behavior": "hide"},
                "capsules_dir": "~/Y-Hub/capsules",
                "capsules_isolation": true,
                "plugins": {"demo": {"base_url": "http://127.0.0.1:3876"}}
            }"#,
        );
        let mut settings = load_from(&s.file());
        settings.set_path("tray.close_behavior", &json!("quit")).unwrap();
        save_to(&s.file(), &settings).unwrap();
        let on_disk = s.read();
        assert_eq!(on_disk["tray"]["close_behavior"], json!("quit"));
        assert_eq!(on_disk["capsules_dir"], json!("~/Y-Hub/capsules"));
        assert_eq!(on_disk["capsules_isolation"], json!(true));
        assert_eq!(on_disk["plugins"]["demo"]["base_url"], json!("http://127.0.0.1:3876"));
    }
}
