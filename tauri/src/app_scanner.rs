use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppItem {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub path: String,
    pub icon: Option<String>,
    pub bundle_id: Option<String>,
}

pub fn get_cache_dir() -> PathBuf {
    let base = dirs::cache_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    let dir = base.join("yhub").join("app_icons");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn read_localized_name(app_path: &Path) -> Option<String> {
    let resources = app_path.join("Contents").join("Resources");
    let lang_dirs = ["zh_CN.lproj", "zh-Hans.lproj", "zh.lproj"];
    for lproj in &lang_dirs {
        let strings_file = resources.join(lproj).join("InfoPlist.strings");
        if strings_file.exists() {
            if let Ok(content) = fs::read_to_string(&strings_file) {
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with("\"CFBundleDisplayName\"")
                        || trimmed.starts_with("CFBundleDisplayName")
                    {
                        if let Some(pos) = trimmed.find('=') {
                            let val = trimmed[pos + 1..]
                                .trim()
                                .trim_matches(';')
                                .trim()
                                .trim_matches('"');
                            if !val.is_empty() {
                                return Some(val.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

fn extract_icon_base64(app_path: &Path, icon_file_name: &str, app_id: &str) -> Option<String> {
    let cache_dir = get_cache_dir();
    let safe_id = app_id.replace(['/', ':', ' '], "_");
    let cache_file = cache_dir.join(format!("{safe_id}.png"));

    if cache_file.exists() {
        if let Ok(bytes) = fs::read(&cache_file) {
            use base64::Engine;
            return Some(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ));
        }
    }

    let resources = app_path.join("Contents").join("Resources");
    let mut candidate_icns = None;

    if !icon_file_name.is_empty() {
        let p1 = resources.join(icon_file_name);
        if p1.exists() {
            candidate_icns = Some(p1);
        } else {
            let p2 = resources.join(format!("{icon_file_name}.icns"));
            if p2.exists() {
                candidate_icns = Some(p2);
            }
        }
    }

    if candidate_icns.is_none() {
        if let Ok(entries) = fs::read_dir(&resources) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) == Some("icns") {
                    candidate_icns = Some(path);
                    break;
                }
            }
        }
    }

    if let Some(icns_path) = candidate_icns {
        let status = std::process::Command::new("sips")
            .arg("-s")
            .arg("format")
            .arg("png")
            .arg(&icns_path)
            .arg("-z")
            .arg("64")
            .arg("64")
            .arg("--out")
            .arg(&cache_file)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();

        if let Ok(s) = status {
            if s.success() && cache_file.exists() {
                if let Ok(bytes) = fs::read(&cache_file) {
                    use base64::Engine;
                    return Some(format!(
                        "data:image/png;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(bytes)
                    ));
                }
            }
        }
    }

    None
}

pub fn scan_applications() -> Vec<AppItem> {
    let mut apps = Vec::new();
    let mut seen_paths = std::collections::HashSet::new();

    let mut scan_dirs = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = dirs::home_dir() {
        scan_dirs.push(home.join("Applications"));
    }

    for dir in scan_dirs {
        if !dir.is_dir() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) == Some("app") {
                    if !seen_paths.insert(path.clone()) {
                        continue;
                    }
                    let filename = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("App")
                        .to_string();

                    let info_plist = path.join("Contents").join("Info.plist");
                    let mut bundle_name = None;
                    let mut display_name = None;
                    let mut bundle_id = None;
                    let mut icon_name = String::new();

                    if info_plist.exists() {
                        if let Ok(val) = plist::Value::from_file(&info_plist) {
                            if let Some(dict) = val.as_dictionary() {
                                if let Some(n) = dict.get("CFBundleDisplayName").and_then(|v| v.as_string()) {
                                    display_name = Some(n.to_string());
                                }
                                if let Some(n) = dict.get("CFBundleName").and_then(|v| v.as_string()) {
                                    bundle_name = Some(n.to_string());
                                }
                                if let Some(id) = dict.get("CFBundleIdentifier").and_then(|v| v.as_string()) {
                                    bundle_id = Some(id.to_string());
                                }
                                if let Some(ic) = dict.get("CFBundleIconFile").and_then(|v| v.as_string()) {
                                    icon_name = ic.to_string();
                                }
                            }
                        }
                    }

                    let localized = read_localized_name(&path);
                    let pick = |v: Option<String>| v.filter(|s| !s.trim().is_empty());
                    let final_display = pick(localized)
                        .or_else(|| pick(display_name))
                        .or_else(|| pick(bundle_name.clone()))
                        .unwrap_or_else(|| filename.clone());

                    let final_name = pick(bundle_name).unwrap_or_else(|| filename.clone());
                    let icon_b64 = extract_icon_base64(&path, &icon_name, &final_name);

                    apps.push(AppItem {
                        id: path.to_string_lossy().to_string(),
                        name: final_name,
                        display_name: final_display,
                        path: path.to_string_lossy().to_string(),
                        icon: icon_b64,
                        bundle_id,
                    });
                }
            }
        }
    }

    apps.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    apps
}
