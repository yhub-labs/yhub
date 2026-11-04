//! Shell UI language for tray/menu/notification text.
//!
//! The backend owns `ui_language` in settings.json; this reads the same key plus `YHUB_LANG`.
//! Only shell-visible copy lives here — logs stay English/unchanged.

use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    En,
    ZhCn,
}

pub fn lang() -> Lang {
    if let Ok(raw) = std::env::var("YHUB_LANG") {
        if let Some(lang) = parse_lang(&raw) {
            return lang;
        }
    }
    lang_from_settings(&crate::config::settings_path())
}

/// Language tag → shell language (`en*` → En, `zh*` → ZhCn); None = not a language we ship.
fn parse_lang(raw: &str) -> Option<Lang> {
    let lower = raw.trim().to_ascii_lowercase();
    if lower.starts_with("en") {
        Some(Lang::En)
    } else if lower.starts_with("zh") {
        Some(Lang::ZhCn)
    } else {
        None
    }
}

/// Resolve the language from one settings file (default En).
///
/// Why this is a function of its own: the earlier version only mapped `en*` explicitly and used
/// `Lang::En` as the catch-all, so the value the backend actually stores — `"zh-CN"` — fell through to
/// English. The tray menu then stayed English no matter what the UI said. Keep the mapping total: every
/// value the backend accepts (`en` / `zh-CN`) must resolve here, and an unknown value falls back to En.
fn lang_from_settings(path: &Path) -> Lang {
    read_ui_language(path)
        .as_deref()
        .and_then(parse_lang)
        .unwrap_or(Lang::En)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Every value the backend accepts must resolve to a shell language. `zh-CN` is the one that used to
    /// fall through to English (the tray showed English after switching the UI language).
    #[test]
    fn parse_lang_covers_the_values_the_backend_accepts() {
        assert_eq!(parse_lang("en"), Some(Lang::En));
        assert_eq!(parse_lang("zh-CN"), Some(Lang::ZhCn));
        // Hand-edited / future variants: prefix match, case-insensitive, surrounding blanks ignored
        assert_eq!(parse_lang("  zh-cn "), Some(Lang::ZhCn));
        assert_eq!(parse_lang("zh"), Some(Lang::ZhCn));
        assert_eq!(parse_lang("en-US"), Some(Lang::En));
        assert_eq!(parse_lang("EN"), Some(Lang::En));
        // Anything else is not a language we ship: the caller falls back to English
        assert_eq!(parse_lang("fr"), None);
        assert_eq!(parse_lang(""), None);
    }

    /// Read the key from a real settings file: the reported bug was exactly this path.
    #[test]
    fn settings_file_language_resolves() {
        let dir = std::env::temp_dir().join(format!("yhub-i18n-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        for (stored, want) in [("zh-CN", Lang::ZhCn), ("en", Lang::En)] {
            let mut file = std::fs::File::create(&path).unwrap();
            write!(file, "{{\"ui_language\": \"{stored}\"}}").unwrap();
            assert_eq!(lang_from_settings(&path), want, "ui_language={stored}");
        }

        // Missing key / unreadable file / broken JSON → English, never a panic
        std::fs::write(&path, "{}").unwrap();
        assert_eq!(lang_from_settings(&path), Lang::En);
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(lang_from_settings(&path), Lang::En);
        assert_eq!(lang_from_settings(&dir.join("nope.json")), Lang::En);

        std::fs::remove_dir_all(&dir).ok();
    }
}
