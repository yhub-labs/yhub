use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{Manager, State, WebviewWindow};

use crate::app_scanner::{scan_applications, AppItem};
use crate::backend;
use crate::config::{self, Settings};

#[derive(Default)]
pub struct AppState {
    pub is_pinned: AtomicBool,
    pub cached_apps: Mutex<Option<Vec<AppItem>>>,
    /// Time of the most recent "blur auto-hide" (tray clicks use it to avoid the aftermath of the
    /// same click, see tray.rs)
    pub last_blur_hide: Mutex<Option<Instant>>,
    /// Time of the most recent "panel shown": blurs within this short window after showing are
    /// **ignored**. Why: `set_focus()`'s activation is asynchronous (the system refuses activation
    /// before the window is ordered front), after which macOS hands the foreground back to the
    /// previously frontmost app → we receive `Focused(false)` → "blur auto-hide" hides the panel on
    /// the spot, so the user sees "the panel flashes and disappears". The grace period lives in
    /// tray.rs's SHOW_GRACE.
    pub last_show: Mutex<Option<Instant>>,
    /// Did this show **ever get focus**? `show_panel` sets it to false, `Focused(true)` sets it to
    /// true. Blur checks it: a blur that never had focus means macOS refused activation (activation
    /// is asynchronous), **not** that the user wanted to close the panel — hiding then is exactly
    /// "the panel flashes and disappears". A real user clicking outside always focuses the panel
    /// first, so this predicate does not block normal hiding.
    pub focus_seen: AtomicBool,
    /// A system dialog is open: do **not** blur-auto-hide during this time (hiding the panel takes
    /// the dialog with it, while the plugin's sheet is still attached — buttons then do nothing).
    /// No command in the shell opens a dialog right now (the file picker went away with the import
    /// tool), so nobody sets this flag; it is kept because every "hide the panel" path must keep
    /// asking it: if a command ever shows a dialog again, setting this flag is all that is needed
    /// (see the blur handling in main.rs and hide_panel in tray.rs).
    pub dialog_open: AtomicBool,
}

/// Is a system dialog open?
pub fn dialog_open(app: &tauri::AppHandle) -> bool {
    app.try_state::<Arc<AppState>>()
        .map(|s| s.dialog_open.load(Ordering::SeqCst))
        .unwrap_or(false)
}

#[tauri::command]
pub fn get_apps(state: State<'_, Arc<AppState>>) -> Vec<AppItem> {
    let mut cache = state.cached_apps.lock().unwrap();
    if let Some(ref apps) = *cache {
        return apps.clone();
    }
    let apps = scan_applications();
    *cache = Some(apps.clone());
    apps
}

#[tauri::command]
pub fn launch_app(
    path: String,
    state: State<'_, Arc<AppState>>,
    window: WebviewWindow,
) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("启动失败: {e}"))?;

    // If not pinned, hide the launcher window after launching
    if !state.is_pinned.load(Ordering::SeqCst) {
        let _ = window.hide();
    }
    Ok(())
}

#[tauri::command]
pub fn set_window_mode(mode: String, window: WebviewWindow) -> Result<(), String> {
    let (width, height) = match mode.as_str() {
        "tool" => (960.0, 650.0),
        _ => (720.0, 480.0),
    };

    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
    let _ = window.center();
    Ok(())
}

#[tauri::command]
pub fn set_pinned(
    pinned: bool,
    state: State<'_, Arc<AppState>>,
    window: WebviewWindow,
) -> bool {
    state.is_pinned.store(pinned, Ordering::SeqCst);
    let _ = window.set_always_on_top(pinned);
    pinned
}

/// Not exposed over IPC: the UI keeps its own pin state, the hotkey/tray self-tests call it directly.
pub fn get_pinned(state: State<'_, Arc<AppState>>) -> bool {
    state.is_pinned.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn hide_window(window: WebviewWindow) {
    let _ = window.hide();
}

/// Read the current global hotkey (empty string when unbound)
#[tauri::command]
pub fn get_hotkey() -> String {
    config::load().toggle_panel_hotkey().unwrap_or_default()
}

/// Update the global hotkey: try to register first, persist only on success; on failure keep the
/// old hotkey. An empty string = unbind (unregister at runtime and persist an empty value).
#[tauri::command]
pub fn set_hotkey(hotkey: String, app: tauri::AppHandle) -> Result<String, String> {
    let settings = apply_hotkey(config::ACTION_TOGGLE_PANEL, &hotkey, &app)?;
    Ok(settings.toggle_panel_hotkey().unwrap_or_default())
}

// ---------------------------------------------------------------- settings (config read/write)
//
// Convention: every setting lives in ~/.config/yhub/settings.json (see config.rs); the UI goes
// through the dotted-path interface below, so adding a setting does not change the IPC signature.
// Hotkeys are the only item needing a runtime action in addition to persisting, hence
// apply_hotkey: register successfully first, then write; on failure keep the old value — disk and
// runtime stay consistent.

/// Read all settings (used by the UI's first screen and by runtime readers)
#[tauri::command]
pub fn get_settings() -> Settings {
    config::load()
}

/// Write a single setting: validate → persist → return the full settings after the write.
/// `value = null` resets the item to its default value.
#[tauri::command]
pub fn set_setting(
    key: String,
    value: serde_json::Value,
    app: tauri::AppHandle,
) -> Result<Settings, String> {
    // Non-shell keys (capsules_* / plugins / future backend keys) are owned by the Python backend:
    // the UI goes through /api/settings, and the shell runs no second validation and never rewrites
    // the whole file.
    if !config::is_shell_key(&key) {
        return Err(format!(
            "{key} 由后端管理，请走 /api/settings（壳只保留 hotkeys.* 与 tray.*）"
        ));
    }
    // Hotkeys must take the "register first, then persist" path, otherwise a UI edit would not take
    // effect
    if let Some(action) = key.strip_prefix("hotkeys.") {
        let combo = value
            .as_str()
            .ok_or_else(|| format!("{key} 必须是字符串（留空字符串表示不绑定）"))?;
        return apply_hotkey(action, combo, &app);
    }
    let settings = config::set(&key, value)?;
    // In tray settings, "left click pops the menu" maps to the native macOS switch (other tray items
    // are read at runtime, no sync needed)
    if key.starts_with("tray.") || key == "tray" {
        crate::tray::apply_settings(&app, &settings.tray);
    }
    Ok(settings)
}

/// Restore defaults: with a key, only that item (hotkeys are re-registered); without a key, everything
#[tauri::command]
pub fn reset_settings(
    key: Option<String>,
    app: tauri::AppHandle,
) -> Result<Settings, String> {
    match key.as_deref() {
        Some(k) if k.starts_with("hotkeys.") => {
            let action = k.trim_start_matches("hotkeys.").to_string();
            let combo = config::hotkey_default(&action)
                .ok_or_else(|| format!("未知热键动作 \"{action}\""))?
                .to_string();
            apply_hotkey(&action, &combo, &app)
        }
        // reset("hotkeys") / reset(None): write defaults to disk first, then sync the runtime hotkeys
        // to the defaults
        other => {
            let before = config::load();
            let settings = config::reset(other)?;
            sync_hotkeys(&before, &settings, &app);
            // When the tray section was reset (or everything was), the runtime switch follows too
            if matches!(other, None | Some("tray")) {
                crate::tray::apply_settings(&app, &settings.tray);
            }
            Ok(settings)
        }
    }
}

/// Catalog for rendering the settings form: allowed values, action table, per-item defaults.
/// The UI builds selects and the action list from this — do not hardcode another copy in the frontend.
#[tauri::command]
pub fn get_settings_schema() -> serde_json::Value {
    config::schema()
}

/// Settings file path (the UI shows "where config lives"; also handy for troubleshooting)
#[tauri::command]
pub fn get_settings_path() -> String {
    config::settings_path().display().to_string()
}

// ---------------------------------------------------------------- backend bridge (Python backend)
//
// Division of labor: launching / probing / logging / graceful shutdown all live in `backend.rs`
// (rationale in docs/packaging.md); this is only IPC wrapping. The two commands have distinct
// semantics:
//   * `backend_status`: probe only, **never launch** (used when the settings UI opens; looking at
//     status must never spawn a process)
//   * `backend_ensure`: launch on demand (reuse if already running) — used by the UI's "re-check"
//     button and by post-failure self-healing in the frontend
//   * `backend_health`: minimal connectivity case: make sure it runs + really call /api/health and
//     /api/tools
//
// All three use `spawn_blocking`: launching waits for readiness (up to 20 s) and must not occupy the
// main thread and freeze the UI.

/// Backend bridge status (does not launch)
#[tauri::command]
pub fn backend_status(app: tauri::AppHandle) -> backend::BackendStatus {
    backend::status(Some(&app))
}

/// Launch the backend on demand and probe it (reuse if already running; failures return a
/// human-readable error + hint instead of throwing)
#[tauri::command]
pub async fn backend_ensure(app: tauri::AppHandle) -> Result<backend::BackendStatus, String> {
    tauri::async_runtime::spawn_blocking(move || backend::ensure_running(Some(&app)))
        .await
        .map_err(|e| format!("后端桥接任务异常：{e}"))
}

/// Minimal connectivity case: make sure the backend runs, then really call `/api/health` and `/api/tools`
#[tauri::command]
pub async fn backend_health(app: tauri::AppHandle) -> Result<backend::BridgeHealth, String> {
    tauri::async_runtime::spawn_blocking(move || backend::health(Some(&app)))
        .await
        .map_err(|e| format!("后端桥接任务异常：{e}"))
}

/// Open the dashboard web page: ensure the backend is running → open
/// `http://127.0.0.1:<port>/?view=wall` in the system default browser (the secondary-screen wall
/// wants exactly this URL, and it can go full screen in a browser).
/// `?view=wall` is a **standalone page**: one wall and nothing else — no sidebar, no bento cells,
/// no other tools (the old `?tool=dashboard` landed on the workbench, with a full row of tool cards).
///
/// Why `ensure_running` first: the web service is normally started by the desktop app at boot
/// (main.rs setup), but if the backend crashed or was stopped, this entry point would get
/// "connection refused" — ensure the service is running before handing over to the browser, so the
/// entry does not occasionally fail to open. When it is already running, ensure_running only probes
/// and returns instantly.
///
/// The panel header's "open in browser" button and the tray menu's "open dashboard web" share this
/// path, so "build URL + start browser" is not written twice. Returns the URL actually opened.
pub(crate) fn open_dashboard_web_blocking(app: &tauri::AppHandle) -> Result<String, String> {
    let status = backend::ensure_running(Some(app));
    if !status.running {
        let mut msg = status.error.unwrap_or_else(|| "后端没有运行".to_string());
        if let Some(hint) = status.hint {
            msg.push_str(&format!("；{hint}"));
        }
        return Err(msg);
    }
    let url = format!("http://127.0.0.1:{}/", backend::port());
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("打开浏览器失败：{e}"))?;
    backend::log(&format!("桌面网页已交给系统浏览器：{url}"));
    Ok(url)
}

/// Open the page URL of an app "in the library" (the UI button goes through here).
///
/// Each `.html` in one library directory is served as-is by the built-in backend
/// (`yhub/server/adapters/capsules.py`): opening it in the system browser is the real source —
/// relative references resolve against that address, and a capsule can PUT to the same address to
/// save the whole file back to disk (that is how TiddlyWiki's put saver stores). The address is
/// produced by the **backend** (`url` in the `/api/capsules` list); this only validates its shape
/// before handing it to the system browser, so the UI never assembles ports and routes.
///
/// Three checks: it must be a loopback address of our own backend
/// (`http://127.0.0.1:<port>/capsules/…`), no whitespace or control characters, and a bounded
/// length — this command should only be able to open "a capsule in the library", not "any URL".
///
/// Runs on `spawn_blocking` for the same reason as the wall: worst case it waits for backend
/// readiness and must not occupy the main thread.
#[tauri::command]
pub async fn open_capsule(app: tauri::AppHandle, url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || open_capsule_blocking(&app, &url))
        .await
        .map_err(|e| format!("打开库里胶囊的任务异常：{e}"))?
}

/// Native directory picker: returns an absolute path; None if the user cancels.
///
/// Uses `osascript`'s choose folder (no new crate, so the dependency tree and signed artifacts are
/// untouched). It must be an **async command**: a synchronous command runs on the main thread and
/// parks the UI while the user picks (see AGENTS.md "Tauri's synchronous commands run on the main
/// thread"). The actual blocking call goes into spawn_blocking.
#[tauri::command]
pub async fn pick_directory(prompt: Option<String>) -> Result<Option<String>, String> {
    let prompt = prompt.unwrap_or_else(|| "选择胶囊目录".to_string());
    // Minimal escaping only: the prompt is our own fixed copy, not user-controlled; still block
    // quotes and backslashes.
    let escaped = prompt.replace('\\', "\\\\").replace('"', "\\\"");
    tauri::async_runtime::spawn_blocking(move || {
        let script = format!("POSIX path of (choose folder with prompt \"{escaped}\")");
        let out = std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| format!("调不动 osascript：{e}"))?;
        if !out.status.success() {
            // User pressed cancel: osascript exits with -128 — not an error, so return None
            let err = String::from_utf8_lossy(&out.stderr);
            let lower = err.to_lowercase();
            if err.contains("-128") || lower.contains("cancel") {
                return Ok(None);
            }
            return Err(format!("选择目录失败：{}", err.trim()));
        }
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Ok(if path.is_empty() { None } else { Some(path) })
    })
    .await
    .map_err(|e| format!("目录选择器异常：{e}"))?
}

/// Reveal a directory in Finder ("open folder"). Only accepts an existing directory; does nothing else.
#[tauri::command]
pub fn open_in_finder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.is_absolute() {
        return Err("要传绝对路径".to_string());
    }
    if !p.is_dir() {
        return Err(format!("目录不存在：{path}"));
    }
    std::process::Command::new("open")
        .arg(&path)
        .status()
        .map_err(|e| format!("打不开 Finder：{e}"))?;
    Ok(())
}

/// Capsule URL shape check: only "local backend + `/capsules/`" page addresses are accepted.
/// Extracted so it can be unit-tested (the command itself needs an AppHandle and cannot).
pub(crate) fn valid_capsule_url(url: &str, port: u16) -> bool {
    if url.is_empty() || url.len() > 2048 {
        return false;
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let Some(rest) = url.strip_prefix("http://") else { return false };
    let Some((authority, path)) = rest.split_once('/') else { return false };
    if !path.starts_with("capsules/") || path == "capsules/" || path.contains("..") {
        return false;
    }
    // Host must be local loopback, or a capsule subdomain <slug>.localhost (used when
    // `capsules_subdomains` is enabled)
    let Some((host, port_part)) = authority.rsplit_once(':') else { return false };
    if port_part.parse::<u16>().ok() != Some(port) {
        return false;
    }
    let host = host.to_ascii_lowercase();
    host == "127.0.0.1"
        || host == "localhost"
        || (host.ends_with(".localhost") && host.len() > ".localhost".len())
}

pub(crate) fn open_capsule_blocking(app: &tauri::AppHandle, url: &str) -> Result<String, String> {
    let port = backend::port();
    if !valid_capsule_url(url, port) {
        return Err(format!(
            "不是本机后端的胶囊地址：{url}（只接受 http://127.0.0.1:{port}/capsules/… 这样的地址）"
        ));
    }
    let status = backend::ensure_running(Some(app));
    if !status.running {
        let mut msg = status.error.unwrap_or_else(|| "后端没有运行".to_string());
        if let Some(hint) = status.hint {
            msg.push_str(&format!("；{hint}"));
        }
        return Err(msg);
    }
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|e| format!("打开浏览器失败：{e}"))?;
    backend::log(&format!("库里的胶囊已交给系统浏览器：{url}"));
    Ok(url.to_string())
}

/// Open the desktop web page (the UI button goes through here).
/// Runs on `spawn_blocking`: worst case it waits for backend readiness (20 s) and must not occupy the
/// main thread and freeze the UI.
#[tauri::command]
pub async fn open_dashboard_web(app: tauri::AppHandle) -> Result<String, String> {
    // The outer ? only unwraps "the task itself failed" (JoinError); the inner Result is the
    // human-readable result to hand back to the UI
    tauri::async_runtime::spawn_blocking(move || open_dashboard_web_blocking(&app))
        .await
        .map_err(|e| format!("打开桌面网页任务异常：{e}"))?
}

/// Read the log tail: `kind` = `backend` (backend stdout/stderr, Python stack traces live here) |
/// `desktop` (bridge-layer events)
#[tauri::command]
pub fn backend_log_tail(kind: Option<String>, lines: Option<usize>) -> String {
    backend::tail_log(kind.as_deref().unwrap_or("backend"), lines.unwrap_or(80))
}

/// Write one hotkey action into the runtime: register successfully first, then persist; if
/// persisting fails, roll back the registration. An empty combo = unbind. Returns the full settings
/// after the write (the UI refreshes from the return value).
///
/// `pub(crate)`: the hotkey self-test (`hotkeys::spawn_selftest`) uses the same entry point, so what
/// it covers is the path the settings UI hits, not a separate copy.
pub(crate) fn apply_hotkey(
    action: &str,
    combo: &str,
    app: &tauri::AppHandle,
) -> Result<Settings, String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    if config::hotkey_default(action).is_none() {
        return Err(format!("未知热键动作 \"{action}\""));
    }
    // Validate the format first: the error message is clearer than a registration failure, and it
    // avoids a pointless registration attempt
    let before = config::load();
    let old = before.hotkey(action).unwrap_or_default();
    let trimmed = combo.trim().to_string();
    if trimmed == old {
        return Ok(before); // unchanged: touch neither the runtime nor the disk
    }
    config::validate_hotkey(&trimmed)?;

    // Conflict detection (inside this program): say which action already holds the combo instead of
    // waiting for a system registration failure — that can only say "taken", with no idea who took it
    if let Some(holder) = config::hotkey_holder(&before, action, &trimmed) {
        return Err(format!(
            "组合键 {trimmed} 已经绑定给「{holder}」，同一个组合键不能绑两个动作（先改掉那一项，或换一个组合键）"
        ));
    }

    let manager = app.global_shortcut();
    let key = format!("hotkeys.{action}");

    if trimmed.is_empty() {
        // Unbind: unregister the old hotkey, then persist an empty value
        if !old.is_empty() {
            let _ = manager.unregister(old.as_str());
        }
        return config::set(&key, serde_json::json!(""));
    }

    manager
        .register(trimmed.as_str())
        .map_err(|e| format!("热键 {trimmed} 无效或被系统占用：{e}"))?;
    if !old.is_empty() {
        let _ = manager.unregister(old.as_str());
    }

    match config::set(&key, serde_json::json!(trimmed)) {
        Ok(settings) => Ok(settings),
        Err(e) => {
            // Took effect but was not saved: roll back the runtime to keep "disk = runtime"
            let _ = manager.unregister(trimmed.as_str());
            if !old.is_empty() {
                let _ = manager.register(old.as_str());
            }
            Err(e)
        }
    }
}

/// Sync the configured hotkeys into the runtime (called after restoring defaults / a whole section).
///
/// Compares each action's `before` and `settings`: unchanged values are left alone; changed ones
/// unregister the old value first and then register the new one (without unregistering first, a combo
/// "moving" between two actions would fail to register); an empty new value = unbind. Failures only
/// log: the settings are already persisted and the next startup will register them again.
fn sync_hotkeys(before: &Settings, settings: &Settings, app: &tauri::AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let manager = app.global_shortcut();
    for action in config::HOTKEY_ACTIONS {
        let old = before.hotkey(action.id);
        let new = settings.hotkey(action.id);
        if old == new {
            continue;
        }
        if let Some(old) = old.as_deref() {
            let _ = manager.unregister(old);
        }
        let Some(new) = new else {
            eprintln!("[settings] 热键 {} 已解绑", action.id);
            continue;
        };
        match manager.register(new.as_str()) {
            Ok(()) => eprintln!("[settings] 已重新注册热键 {} = {new}", action.id),
            Err(e) => eprintln!("[settings] 热键 {} = {new} 注册失败：{e}", action.id),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Capsule URL shape check: only `/capsules/` page addresses of our own backend; do not let this
    /// command become "open any URL" (the UI passes the backend-provided `url`, but the entry point
    /// itself must have a gate).
    #[test]
    fn capsule_url_is_loopback_capsules_only() {
        assert!(valid_capsule_url(
            "http://127.0.0.1:8790/capsules/pinyin",
            8790
        ));
        assert!(valid_capsule_url(
            "http://127.0.0.1:8790/capsules/%E5%AD%90%E7%9B%AE%E5%BD%95/%E7%9C%8B%E6%9D%BF",
            8790
        ));
        assert!(valid_capsule_url(
            "http://localhost:8790/capsules/foo/index.html",
            8790
        ));
        assert!(valid_capsule_url(
            "http://foo-1234abcd.localhost:8790/capsules/foo/",
            8790
        ));

        assert!(
            !valid_capsule_url("http://127.0.0.1:8791/capsules/pinyin", 8790),
            "别的端口不是我们的后端"
        );
        assert!(!valid_capsule_url("https://evil.example/capsules/x", 8790));
        assert!(
            !valid_capsule_url("http://127.0.0.1:8790/capsules/", 8790),
            "空路径没有对应的胶囊"
        );
        assert!(
            !valid_capsule_url("http://127.0.0.1:8790/api/capsules", 8790),
            "接口地址不是页面地址"
        );
        assert!(
            !valid_capsule_url("http://127.0.0.1:8790/capsules/a/../b", 8790),
            "不许带 .. 走回头路"
        );
        assert!(!valid_capsule_url("http://127.0.0.1:8790/capsules/a b", 8790));
        assert!(!valid_capsule_url("", 8790));
    }
}
