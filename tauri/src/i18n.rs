//! Shell UI language for tray/menu/notification text.
//!
//! The backend owns `ui_language` in settings.json; this reads the same key plus `YHUB_LANG`.
//! Only shell-visible copy lives here — logs stay English/unchanged.

use std::path::Path;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    ZhCn,
}

pub fn lang() -> Lang {
    if let Ok(raw) = std::env::var("YHUB_LANG") {
        let lower = raw.trim().to_ascii_lowercase();
        if lower.starts_with("en") {
            return Lang::En;
        }
        if lower.starts_with("zh") {
            return Lang::ZhCn;
        }
    }
    let path = crate::config::settings_path();
    if let Some(value) = read_ui_language(&path) {
        if value.starts_with("en") {
            return Lang::En;
        }
    }
    Lang::En
}

fn read_ui_language(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("ui_language")
        .and_then(|v| v.as_str())
        .map(|s| s.to_ascii_lowercase())
}

pub fn tr(key: &'static str) -> &'static str {
    match (lang(), key) {
        (Lang::En, "tray.show") => "Show panel",
        (Lang::En, "tray.hide") => "Hide panel",
        (Lang::En, "tray.dashboard") => "Open desktop page",
        (Lang::En, "tray.settings") => "Settings…",
        (Lang::En, "tray.quit") => "Quit Y-Hub",
        (Lang::En, "notify.dashboard_failed") => "Could not open the desktop page",
        (Lang::En, "notify.quit") => "Y-Hub has quit",
        (Lang::En, "notify.hidden") => "Hidden to the menu bar. Click the icon or press the hotkey to reopen.",
        (_, "tray.show") => "显示面板",
        (_, "tray.hide") => "隐藏面板",
        (_, "tray.dashboard") => "打开桌面网页",
        (_, "tray.settings") => "设置…",
        (_, "tray.quit") => "退出 Y-Hub",
        (_, "notify.dashboard_failed") => "打不开桌面网页",
        (_, "notify.quit") => "Y-Hub 已退出",
        (_, "notify.hidden") => "已收起到菜单栏，点图标或按热键可以再打开",

        // Backend status / launch errors — these are rendered by the settings page (General → backend),
        // so they go through the same catalog as the tray copy.
        (Lang::En, "backend.not_running") => "The backend is not running",
        (Lang::En, "backend.health_failed") => "/api/health call failed: {error}",
        (Lang::En, "backend.version_too_old") => {
            "Backend is too old ({version} < {min}): upgrade `yhub`, then press “Re-check”"
        }
        (Lang::En, "backend.upgrade_hint") => {
            "Upgrade: uv tool install --upgrade yhub (or make install-backend)"
        }
        (Lang::En, "backend.start_failed") => "Could not start the backend ({bin}): {error}",
        (Lang::En, "backend.not_installed_hint") => {
            "No installed `yhub` found (PATH / ~/.local/bin / Homebrew) and no uv. Install the backend: \
             `uv tool install yhub` or `make install-backend`. {log}"
        }
        (Lang::En, "backend.not_ready") => "The backend was not ready within {ms} ms: {error}",
        (Lang::En, "backend.cleanup_hint") => "Cleaned up the process just started ({how}). {log}",
        (Lang::En, "backend.log_hint") => {
            "Check the log: {path} (backend stdout/stderr and Python tracebacks live there)"
        }
        (Lang::En, "backend.bin_missing") => "{env} points at a file that does not exist: {path}",
        (Lang::En, "backend.bin_missing_hint") => {
            "Point it at an executable `yhub`, or delete the variable and let the app find the installed one"
        }
        (Lang::En, "backend.bin_not_executable") => "{env} points at a file that is not executable: {path}",
        (Lang::En, "backend.bin_not_executable_hint") => "Make it executable (chmod +x {path}), or pick another file",

        (_, "backend.not_running") => "后端没有运行",
        (_, "backend.health_failed") => "/api/health 调用失败：{error}",
        (_, "backend.version_too_old") => "后端版本过旧（{version} < {min}）：升级 `yhub` 后点「重新检测」",
        (_, "backend.upgrade_hint") => "升级：uv tool install --upgrade yhub（或 make install-backend）",
        (_, "backend.start_failed") => "拉起后端失败（{bin}）：{error}",
        (_, "backend.not_installed_hint") => {
            "本机没有已安装的 yhub（PATH / ~/.local/bin / Homebrew），也没有 uv；装后端：\
             `uv tool install yhub` 或 `make install-backend`。{log}"
        }
        (_, "backend.not_ready") => "后端没能在 {ms} ms 内就绪：{error}",
        (_, "backend.cleanup_hint") => "已清理刚拉起的进程（{how}）。{log}",
        (_, "backend.log_hint") => "看日志定位：{path}（后端 stdout/stderr 与 Python 堆栈都在里面）",
        (_, "backend.bin_missing") => "{env} 指向的文件不存在：{path}",
        (_, "backend.bin_missing_hint") => {
            "改成一个可执行的 yhub（或删掉这个环境变量，让程序自己找已安装的 yhub）"
        }
        (_, "backend.bin_not_executable") => "{env} 指向的文件不可执行：{path}",
        (_, "backend.bin_not_executable_hint") => "给它执行权限（chmod +x {path}），或换一个文件",

        _ => key,
    }
}

/// Translate `key`, then fill `{name}` placeholders. Unknown placeholders are left verbatim
/// (a missing argument shows up in the UI instead of silently disappearing).
pub fn trf(key: &'static str, args: &[(&str, &str)]) -> String {
    let mut out = tr(key).to_string();
    for (name, value) in args {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}
