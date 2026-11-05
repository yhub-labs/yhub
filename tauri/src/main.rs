// Y-Hub desktop client (Tauri host)
//
// Responsibilities:
//   1. Register global hotkeys (Option+Space by default, editable in the UI, stored in ~/.yhub/settings.json)
//   2. Keep a persistent menu bar status item (tray): left click toggles the panel, right click opens
//      a menu (show/hide/quit) — see tray.rs
//   3. Auto-hide on blur (unless pinned); closing the window only hides it, never quits
//   4. Scan local Mac apps and launch them instantly
//   5. Adapt the window size dynamically (compact search mode ↔ tool workbench mode)
//   6. Silently manage the Python backend (probe 8790; if not running call global `yhub`, fall back to
//      `uv run`)
//   7. Self-test / verification switches: YHUB_SELFTEST_HIDDEN=1 starts silently (no panel, no global hotkeys)

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod macos_panel;
mod app_scanner;
mod backend;
mod commands;
mod config;
mod hotkeys;
mod i18n;
mod tray;

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;
use tauri::Manager;

use commands::AppState;

/// Read a boolean "switch" environment variable: 1 / true / yes / on (case-insensitive, including
/// values such as "1 ") means on; 0 / false / no / off / empty string means off, and unset also
/// means off. Unrecognized values count as "on" (prefer silent over popping a panel).
fn env_flag(name: &str) -> bool {
    match std::env::var(name) {
        Err(_) => false,
        Ok(raw) => !matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "" | "0" | "false" | "no" | "off"
        ),
    }
}

/// macOS GUI apps (launched by launchd / Finder) get a PATH of only /usr/bin:/bin:/usr/sbin:/sbin.
/// Add Homebrew, user bin dirs and /etc/paths(.d) entries so rclone / opencli / uv can be located.
#[cfg(target_os = "macos")]
fn ensure_macos_path() {
    let current = std::env::var("PATH").unwrap_or_default();
    let existing: std::collections::HashSet<std::path::PathBuf> =
        std::env::split_paths(&current).collect();
    let mut to_prepend: Vec<std::path::PathBuf> = Vec::new();
    let mut to_append: Vec<std::path::PathBuf> = Vec::new();

    let mut priority = Vec::new();
    if let Some(home) = dirs::home_dir() {
        priority.push(home.join(".local/bin"));
        priority.push(home.join(".cargo/bin"));
    }
    priority.push(std::path::PathBuf::from("/opt/homebrew/bin"));
    priority.push(std::path::PathBuf::from("/opt/homebrew/sbin"));
    priority.push(std::path::PathBuf::from("/usr/local/bin"));
    priority.push(std::path::PathBuf::from("/usr/local/sbin"));

    for p in priority {
        if p.is_dir() && !existing.contains(&p) && !to_prepend.contains(&p) {
            to_prepend.push(p);
        }
    }

    let mut system_paths = Vec::new();
    if let Ok(content) = std::fs::read_to_string("/etc/paths") {
        for line in content.lines() {
            let line = line.trim();
            if !line.is_empty() {
                system_paths.push(std::path::PathBuf::from(line));
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir("/etc/paths.d") {
        let mut files: Vec<std::path::PathBuf> =
            entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
        files.sort();
        for file in files {
            if let Ok(content) = std::fs::read_to_string(&file) {
                for line in content.lines() {
                    let line = line.trim();
                    if !line.is_empty() {
                        system_paths.push(std::path::PathBuf::from(line));
                    }
                }
            }
        }
    }
    for p in system_paths {
        if p.is_dir() && !existing.contains(&p) && !to_prepend.contains(&p) && !to_append.contains(&p) {
            to_append.push(p);
        }
    }

    if !to_prepend.is_empty() || !to_append.is_empty() {
        let mut all_paths = to_prepend;
        all_paths.extend(std::env::split_paths(&current));
        all_paths.extend(to_append);
        if let Ok(new_path) = std::env::join_paths(all_paths) {
            std::env::set_var("PATH", &new_path);
        }
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    ensure_macos_path();

    let app_state = Arc::new(AppState::default());
    let state_for_event = app_state.clone();

    // The exit code must be handed out by us: `Builder::run()` is only shorthand for
    // `build()?.run(|_, _| {})`, while `App::run()` throws away the runtime's exit code —
    // `app.exit(code)` is just `request_exit(code)` and the code itself returns to the caller via
    // `RunEvent::ExitRequested`; only `App::run_return()` hands it back as a value (the tauri 2.11
    // doc example is likewise `std::process::exit(app.run_return(…))`).
    // The old `.run(ctx).expect(…)` let a failed self-test exit 0, so `verify-hotkeys.sh`'s
    // "self-test process exits with its verdict" was an empty assertion.
    let builder = tauri::Builder::default()
        .manage(Arc::clone(&app_state))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    // Every combo registered through the plugin calls back here; which key maps to
                    // which action is decided by hotkeys.rs (action implementations are shared with
                    // the tray left click, see tray.rs)
                    hotkeys::dispatch(app, shortcut, event);
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::get_apps,
            commands::launch_app,
            commands::set_window_mode,
            commands::set_pinned,
            commands::hide_window,
            commands::get_hotkey,
            commands::set_hotkey,
            commands::get_settings,
            commands::set_setting,
            commands::reset_settings,
            commands::get_settings_schema,
            commands::get_settings_path,
            commands::refresh_shell_language,
            commands::backend_status,
            commands::backend_ensure,
            commands::backend_health,
            commands::backend_log_tail,
            commands::open_dashboard_web,
            commands::open_capsule,
            commands::pick_directory,
            commands::open_in_finder,
        ])
        .setup(move |app| {
            // macOS: switch to accessory (equivalent to LSUIElement=YES in Info.plist) — no Dock icon,
            // invisible in Cmd+Tab, matching Raycast; only the menu bar/tray entry and global hotkeys
            // remain. Accessory apps can still be activated and their windows can still become key
            // windows, so focus and keyboard input are unaffected. The packaged Info.plist also carries
            // LSUIElement (see tauri/Info.plist) to avoid a Dock icon flash at launch.
            #[cfg(target_os = "macos")]
            match app
                .handle()
                .set_activation_policy(tauri::ActivationPolicy::Accessory)
            {
                Ok(()) => eprintln!("[activation] accessory (dock hidden)"),
                Err(e) => eprintln!("[activation] set accessory FAILED: {e}"),
            }

            // Debug switch: YHUB_DEBUG_NO_HIDE=1 disables auto-hide and shows on startup (for
            // screenshot debugging)
            let debug_no_hide = std::env::var("YHUB_DEBUG_NO_HIDE").is_ok();

            // Silent startup switch (for self-tests / verification scripts): YHUB_SELFTEST_HIDDEN=1
            // shows no panel and registers no global hotkeys — it only affects "started for
            // self-test/verification" launches; normal use (Finder double-click, open -a) is unaffected.
            //
            // Why it is needed: verification scripts relaunch the real app repeatedly (verify-packed-app.sh
            // does 8 launches per round) and each launch used to pop the panel, making the screen show
            // "an app being opened frantically" — measured once at 107 launches in 27 minutes.
            // Only the cases that specifically test "panel show/hide / hotkeys" pass
            // YHUB_SELFTEST_HIDDEN=0 explicitly (see tauri/scripts/).
            let selftest_hidden = env_flag("YHUB_SELFTEST_HIDDEN");
            if selftest_hidden {
                eprintln!(
                    "[selftest] hidden=1（YHUB_SELFTEST_HIDDEN）：启动不显示面板、不注册全局热键"
                );
            }

            // Debug switch: YHUB_DEBUG_LAN_PROBE=host:port makes the app's own process do one TCP
            // connect and print the result. Purpose: macOS 15+ grants the "Local Network" privacy
            // permission per app identity; when the child process (python backend) reports
            // EHOSTUNREACH, this probe distinguishes "the app itself is blocked" from "only the child
            // it spawned is blocked". Note: the app must be signed with a stable identity (see
            // bundle.macOS.signingIdentity in tauri.conf.json), otherwise the ad-hoc cdhash identity
            // changes on every rebuild and the system setting never takes effect.
            if let Ok(target) = std::env::var("YHUB_DEBUG_LAN_PROBE") {
                std::thread::spawn(move || {
                    // Delay until the panel is shown and the app is active: macOS only prompts for
                    // local network access while the app is active, so the backend's "connect once in
                    // the background at startup" timing never even sees the prompt and is silently
                    // denied.
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    use std::net::{TcpStream, ToSocketAddrs};
                    use std::time::Duration;
                    let line = match target.to_socket_addrs().map(|mut a| a.next()) {
                        Ok(Some(addr)) => {
                            match TcpStream::connect_timeout(&addr, Duration::from_secs(5)) {
                                Ok(_) => format!("{target} -> 连接成功（app 身份有本地网络权限）"),
                                Err(e) => format!("{target} -> 失败: {e}（app 身份被拦或目标不可达）"),
                            }
                        }
                        _ => format!("无法解析 {target}"),
                    };
                    eprintln!("[lan-probe] {line}");
                    // stderr is not capturable when launched via open/launchd; also write a file for
                    // forensics
                    let _ = std::fs::write("/tmp/yhub-lan-probe.txt", format!("{line}\n"));
                });
            }

            // Menu bar status item (tray): the persistent entry point; failure only logs and does not
            // affect the main flow
            if let Err(e) = tray::build(app.handle()) {
                eprintln!("[tray] build FAILED: {e}");
            }

            // Load settings: warnings go to stderr so "config did not take
            // effect" problems are traceable
            let (settings, warnings) = config::load_with_warnings();
            for warning in &warnings {
                eprintln!("[settings] {warning}");
            }
            eprintln!("[settings] file={}", config::settings_path().display());

            // Tray runtime switches (left-click "pop menu" is delegated to the native macOS switch): apply
            // after settings are loaded, so warnings are not preceded
            tray::apply_settings(app.handle(), &settings.tray);

            // Register global hotkeys: one by one per the configured action table (only toggle_panel =
            // Option+Space by default; an explicit empty value = the user chose not to bind, skip).
            // Failures only log, see hotkeys.rs. Skipped in hidden mode: global hotkeys are exclusive
            // system-wide, so concurrent verification scripts would fight over registrations; and
            // self-tests/verification do not need them (self-tests use apply_hotkey + dispatch directly).
            if selftest_hidden {
                eprintln!("[selftest] hidden=1：跳过全局热键注册（动作表里 {} 项都不注册）", config::HOTKEY_ACTIONS.len());
            } else {
                hotkeys::register_from_settings(app.handle(), &settings);
            }

            // Debug switch: YHUB_DEBUG_HOTKEY_SELFTEST=1 runs the unattended hotkey self-test (see hotkeys.rs)
            if std::env::var("YHUB_DEBUG_HOTKEY_SELFTEST").is_ok() {
                hotkeys::spawn_selftest(app.handle().clone());
            }

            // Grab the main window and listen to window events
            if let Some(window) = app.get_webview_window(tray::MAIN_WINDOW) {
                let win_clone = window.clone();
                let state_blur = state_for_event.clone();
                let app_for_events = app.handle().clone();
                window.on_window_event(move |event| match event {
                    // Auto-hide on blur (except when pinned); remember the moment for tray click checks
                    tauri::WindowEvent::Focused(focused) => {
                        let pinned = state_blur.is_pinned.load(Ordering::SeqCst);
                        let dialog_open = state_blur.dialog_open.load(Ordering::SeqCst);
                        eprintln!(
                            "[window] focused={focused} pinned={pinned} dialog_open={dialog_open}"
                        );
                        // A blur in the first moments after popping up must **not** hide the panel: that
                        // is the aftermath of macOS handing the foreground back (activation is
                        // asynchronous, see SHOW_GRACE in tray.rs), not the user closing the panel.
                        if *focused {
                            state_blur.focus_seen.store(true, Ordering::SeqCst);
                        }
                        let seen = state_blur.focus_seen.load(Ordering::SeqCst);
                        let in_grace = state_blur
                            .last_show
                            .lock()
                            .ok()
                            .and_then(|stamp| *stamp)
                            .map(|t| t.elapsed() < tray::SHOW_GRACE)
                            .unwrap_or(false);
                        let pending_activation = !seen; // never got focus since showing: activation has not landed
                        if !focused && !pinned && !debug_no_hide && (in_grace || pending_activation) {
                            let why = if pending_activation { "还没拿到过焦点，激活没落地" } else { "刚弹出，等激活回执" };
                            eprintln!("[window] blur -> 跳过收起（{why}）");
                            backend::log(&format!("面板失焦 -> 跳过收起（{why}）"));
                        } else if !focused && !pinned && !debug_no_hide {
                            if dialog_open {
                                // A system dialog such as the file picker always blurs the panel window.
                                // Hiding now would take the dialog with it (the sheet is still attached and
                                // buttons become unresponsive afterwards).
                                eprintln!("[window] blur -> 跳过收起（系统对话框开着）");
                            } else {
                                if let Ok(mut stamp) = state_blur.last_blur_hide.lock() {
                                    *stamp = Some(Instant::now());
                                }
                                let r = win_clone.hide();
                                eprintln!("[window] blur -> hide {r:?}");
                                backend::log(&format!("面板失焦 -> 收起（{r:?}）"));
                            }
                        }
                    }
                    // Window close behavior is dictated by settings (tray.close_behavior, re-read every
                    // time → edits take effect immediately):
                    //   hide = collapse the panel without quitting the process (quit via the tray menu's
                    //          Quit item)
                    //   quit = exit the process directly
                    tauri::WindowEvent::Destroyed => {
                        // The window was destroyed (not the "close means hide" path, which calls
                        // prevent_close). Leave a trace: hotkeys/tray afterwards rely on ensure_window to
                        // rebuild (see tray.rs), so the logs line up.
                        eprintln!("[window] destroyed");
                        backend::log("面板窗口被销毁（Destroyed）—— 下次弹出会重建");
                    }
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        let close_behavior = config::load().tray.close_behavior;
                        if close_behavior == "quit" {
                            eprintln!(
                                "[window] close requested -> quit (close_behavior=quit, 进程退出)"
                            );
                            tray::notify(i18n::tr("notify.quit"), true);
                            app_for_events.exit(0);
                            return;
                        }
                        api.prevent_close();
                        let r = win_clone.hide();
                        eprintln!(
                            "[window] close requested -> hide {r:?} (close_behavior={close_behavior}, process stays alive)"
                        );
                        tray::notify(i18n::tr("notify.hidden"), false);
                    }
                    _ => {}
                });

                if selftest_hidden {
                    // Call nothing: the window is visible:false in tauri.conf.json, so without show()
                    // it never appears. This log line is the auditable evidence that "the panel really did
                    // not pop up" (6 cases in verify-packed-app.sh go through here).
                    eprintln!(
                        "[selftest] hidden=1：不显示面板 is_visible={:?}（窗口只存在于进程内，屏幕上不会有东西）",
                        window.is_visible().map_err(|e| e.to_string())
                    );
                } else if debug_no_hide {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.center();
                    let pos = window.outer_position().map(|p| (p.x, p.y));
                    let size = window.outer_size().map(|s| (s.width, s.height));
                    let scale = window.scale_factor();
                    let focused = window.is_focused().unwrap_or(false);
                    eprintln!("[debug] window shown at startup (no-hide mode) pos={pos:?} size={size:?} scale={scale:?} focused={focused}");
                    // Activation is asynchronous; wait briefly and confirm once more whether the window
                    // can still become the key window under an accessory app
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    eprintln!(
                        "[debug] focused after settle = {}",
                        window.is_focused().unwrap_or(false)
                    );
                } else {
                    // Whether the panel shows at startup is dictated by settings (tray.show_on_start;
                    // default false = menu bar resident)
                    tray::apply_startup_visibility(app.handle());
                }
            }

            // Debug switch: YHUB_DEBUG_TRAY_SELFTEST=1 runs the unattended tray interaction self-test (see tray.rs)
            if std::env::var("YHUB_DEBUG_TRAY_SELFTEST").is_ok() {
                tray::spawn_selftest(app.handle().clone());
            }

            // Silently start the Python backend service in the background (on demand; reused if already running)
            //
            // Launch order, timeouts, logging and failure handling all live in backend.rs (rationale in
            // docs/packaging.md):
            //   reuse 8790 → installed yhub (PATH / ~/.local/bin / Homebrew) → uv run (source tree)
            // This is a **background thread**: waiting for readiness takes up to 20 s and must not block
            // the window or tray; failures only log (the UI shows status separately).
            // Debug switch: YHUB_DEBUG_BACKEND_SELFTEST=1|timeout|badbin runs the bridge self-test (see backend.rs)
            let backend_handle = app.handle().clone();
            std::thread::spawn(move || {
                let status = backend::ensure_running(Some(&backend_handle));
                eprintln!(
                    "[backend] ensure_running: running={} healthy={} source={} owned={} pid={:?} version={:?}",
                    status.running,
                    status.healthy,
                    status.source,
                    status.owned,
                    status.pid,
                    status.version
                );
                if let Some(error) = status.error {
                    eprintln!("[backend] {error}｜{}", status.hint.unwrap_or_default());
                }
            });

            if std::env::var("YHUB_DEBUG_BACKEND_SELFTEST").is_ok() {
                backend::spawn_selftest(app.handle().clone());
            }

            // Pre-warm the Mac app list asynchronously
            let state_prewarm = app_state.clone();
            std::thread::spawn(move || {
                let apps = app_scanner::scan_applications();
                if let Ok(mut lock) = state_prewarm.cached_apps.lock() {
                    *lock = Some(apps);
                }
            });

            Ok(())
        });

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(e) => {
            eprintln!("运行 Y-Hub 桌面客户端异常：{e}");
            std::process::exit(1);
        }
    };

    // The exit path must also stop the Python backend this process launched (a reused backend stays
    // untouched): without this, `yhub-backend` survives with PPID=1 and keeps holding 8790 after the
    // installed build quits (seen in practice: the exit hook does not always run when the app is
    // killed). This chain and the exit-code chain below were added together; both
    // live in this callback, so do not split them when editing the end of `main.rs`.
    // The exit code must be handed out by us (measured):
    //   - `app.exit(code)` is just `request_exit(code)`; the code returns to the caller via
    //     `RunEvent::ExitRequested`;
    //   - `Builder::run()` = `build()?.run(|_, _| {})` with an empty callback and `()` return value —
    //     the code is lost here, so a failed self-test exited 0 and `verify-hotkeys.sh`'s "self-test
    //     process exits with its verdict" became an assertion that always passes;
    //   - `run_return()` does not help either: when the tauri 2.11 runtime receives request_exit it sets
    //     control flow to `ControlFlow::Exit` (not `ExitWithCode`), so tao's `run_return` always returns
    //     0 (measured locally: even on self-test FAIL the log still says exit code 0).
    // The only place that can see the code is the ExitRequested event itself, so record it in the
    // callback and use it to exit after the loop ends.
    // User-interaction exits (⌘Q, close with quit) carry None, treated as 0.
    let requested_exit_code = Arc::new(std::sync::atomic::AtomicI32::new(0));
    let exit_code_cb = Arc::clone(&requested_exit_code);
    let loop_code = app.run_return(move |_app, event| {
        match &event {
            tauri::RunEvent::ExitRequested { code, .. } => {
                backend::shutdown("app exit");
                if let Some(code) = code {
                    exit_code_cb.store(*code, Ordering::SeqCst);
                }
            }
            tauri::RunEvent::Exit => {
                backend::shutdown("app exit");
            }
            _ => {}
        }
    });
    let remembered = requested_exit_code.load(Ordering::SeqCst);
    let code = if remembered != 0 {
        remembered
    } else {
        loop_code
    };
    eprintln!("[app] 事件循环结束，退出码 {code}");
    std::process::exit(code);
}
