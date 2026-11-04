// Global hotkeys: action catalog → runtime registration → event dispatch
//
// This module does exactly one thing: **translate "a combo was pressed" into "run an action"**.
//   - Startup registration: `register_from_settings()` registers each configured combo from
//     `config::HOTKEY_ACTIONS` (empty string = user chose not to bind, skip; on registration
//     failure fall back to the action's default combo and log).
//   - Event dispatch: `dispatch()` receives the plugin callback → resolves the action → `run()`.
//   - Adding an action = one line in `config.rs`'s `HOTKEY_ACTIONS` + one branch in `run()`.
//
// The write path (register first, then persist; conflict and format validation) lives in
// `commands.rs`'s `apply_hotkey`. This module never touches disk and never interprets settings:
// it only registers and dispatches according to "what the settings say right now".
//
// Self-test: `YHUB_DEBUG_HOTKEY_SELFTEST=1`, see `spawn_selftest` (requires `YHUB_CONFIG_DIR` /
// `YHUB_SETTINGS_FILE`, otherwise it refuses to run against the real user config).

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::commands::{self, AppState};
use crate::config::{self, Settings};
use crate::tray;

/// Plugin callback entry point (the plugin delivers both press and release; only "pressed" acts)
pub fn dispatch(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state() != ShortcutState::Pressed {
        return;
    }
    match action_for(shortcut) {
        Some(action) => {
            eprintln!("[hotkey] pressed {shortcut} -> action {action}");
            crate::backend::log(&format!("热键 {shortcut} -> {action}"));
            run(app, action);
        }
        // Possible when settings were just changed and the runtime has not caught up: log only,
        // leave the panel alone. This line **must** go to disk: stderr is a black hole when the app
        // is launched from the Dock, and it is the only clue when a user reports "hotkey does nothing".
        None => {
            eprintln!("[hotkey] pressed {shortcut}：当前设置里没有动作绑到它，忽略");
            crate::backend::log(&format!("热键 {shortcut}：设置里没有动作绑到它，忽略（面板不会动）"));
        }
    }
}

/// Shortcut → action id (reads the settings file every time, so UI edits take effect immediately)
fn action_for(shortcut: &Shortcut) -> Option<&'static str> {
    let settings = config::load();
    config::HOTKEY_ACTIONS
        .iter()
        .find(|action| combo_matches(settings.hotkey(action.id).as_deref(), shortcut))
        .map(|action| action.id)
}

/// Is the configured combo string exactly the pressed shortcut? (parse failure = no match)
fn combo_matches(combo: Option<&str>, shortcut: &Shortcut) -> bool {
    match combo.map(Shortcut::from_str) {
        Some(Ok(parsed)) => &parsed == shortcut,
        _ => false,
    }
}

/// Action implementation: **adding an action means adding one branch here** (catalog lives in
/// `config.rs`'s `HOTKEY_ACTIONS`)
fn run(app: &AppHandle, action: &str) {
    if action == config::ACTION_TOGGLE_PANEL {
        tray::toggle_panel(app);
    } else if action == config::ACTION_SHOW_PANEL {
        tray::show_panel(app);
    } else if action == config::ACTION_HIDE_PANEL {
        tray::hide_panel(app);
    } else {
        eprintln!("[hotkey] 动作 {action} 没有实现，忽略");
    }
}

/// Register every configured action with the system at startup.
///
/// All three cases only log and never abort startup: unbound (skip), taken (fall back to the
/// default combo), default combo taken too (this action has no hotkey this run; the user can
/// change it in settings).
pub fn register_from_settings(app: &AppHandle, settings: &Settings) {
    let manager = app.global_shortcut();
    for action in config::HOTKEY_ACTIONS {
        let combo = settings.hotkey(action.id).unwrap_or_default();
        let combo = combo.trim();
        if combo.is_empty() {
            eprintln!("[hotkey] {} 未绑定，跳过注册", action.id);
            continue;
        }
        if manager.is_registered(combo) {
            // The settings layer already guarantees one combo cannot bind two actions; this only
            // guards against double registration
            eprintln!("[hotkey] registered: {combo} (action={})", action.id);
            continue;
        }
        match manager.register(combo) {
            Ok(()) => eprintln!("[hotkey] registered: {combo} (action={})", action.id),
            Err(e) => {
                eprintln!(
                    "[hotkey] register {combo} FAILED: {e} (action={})",
                    action.id
                );
                let fallback = action.default_combo.trim();
                if fallback.is_empty() || fallback == combo {
                    continue;
                }
                match manager.register(fallback) {
                    Ok(()) => eprintln!(
                        "[hotkey] registered fallback: {fallback} (action={})",
                        action.id
                    ),
                    Err(e2) => eprintln!(
                        "[hotkey] register {fallback} FAILED: {e2} (action={})",
                        action.id
                    ),
                }
            }
        }
    }
}

// ---------------------------------------------------------------- self-test

/// The two combos used by the self-test (disjoint from the Option+Space default, so verification
/// scripts never treat them as defaults)
const SELFTEST_SHOW: &str = "Ctrl+Cmd+Shift+F8";
const SELFTEST_HIDE: &str = "Ctrl+Cmd+Shift+F7";

/// Self-test: with `YHUB_DEBUG_HOTKEY_SELFTEST=1`, run unattended through "invalid combo rejected /
/// binding takes effect / conflict rejected / unbind / dispatch triggers", using exactly the same
/// functions as the settings UI IPC (`commands::apply_hotkey` and `dispatch`).
///
/// Why it exists: macOS has no usable webview WebDriver, so the UI cannot be clicked; and "a key
/// actually delivered by the system" can only be exercised with externally synthesized keys (see
/// `tauri/scripts/verify-hotkeys.sh`, which uses System Events to deliver F9). This self-test covers
/// the earlier half of that chain: register → disk → dispatch → action.
pub fn spawn_selftest(app: AppHandle) {
    if std::env::var("YHUB_CONFIG_DIR").is_err() && std::env::var("YHUB_SETTINGS_FILE").is_err() {
        eprintln!(
            "[selftest] 拒绝在真实用户配置上跑热键自检（请用 YHUB_CONFIG_DIR 指向临时目录）"
        );
        return;
    }

    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));

        let mut failures: Vec<String> = Vec::new();
        let check = |failures: &mut Vec<String>, name: &str, got: bool, want: bool| {
            let verdict = if got == want { "OK" } else { "FAIL" };
            eprintln!("[selftest] {name}: got={got} want={want} {verdict}");
            if got != want {
                failures.push(name.to_string());
            }
        };
        let registered = |combo: &str| app.global_shortcut().is_registered(combo);
        let visible = || {
            app.get_webview_window(tray::MAIN_WINDOW)
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false)
        };

        eprintln!("[selftest] start");

        // 1) Invalid combo: fails parsing, rejected outright (old value untouched)
        let invalid = commands::apply_hotkey(config::ACTION_SHOW_PANEL, "NotAKey", &app);
        check(
            &mut failures,
            "invalid combo rejected",
            invalid.as_ref().err().map(|e| e.contains("无法解析")).unwrap_or(false),
            true,
        );

        // 2) Bind: registers successfully first, then persists; the return value carries the new
        //    value
        let bound = commands::apply_hotkey(config::ACTION_SHOW_PANEL, SELFTEST_SHOW, &app);
        let bound_ok = bound
            .as_ref()
            .ok()
            .and_then(|s| s.hotkey(config::ACTION_SHOW_PANEL))
            .map(|c| c == SELFTEST_SHOW)
            .unwrap_or(false);
        check(&mut failures, "bind writes settings", bound_ok, true);
        check(&mut failures, "bind registers in system", registered(SELFTEST_SHOW), true);

        // 3) Conflict: the same combo is already bound to "show panel only"; binding it to another
        //    action must be rejected, and the existing registration must not be stolen
        let conflict = commands::apply_hotkey(config::ACTION_HIDE_PANEL, SELFTEST_SHOW, &app);
        check(
            &mut failures,
            "conflict rejected with holder name",
            conflict
                .as_ref()
                .err()
                .map(|e| e.contains("已经绑定给"))
                .unwrap_or(false),
            true,
        );
        check(
            &mut failures,
            "conflict keeps runtime untouched",
            registered(SELFTEST_SHOW),
            true,
        );

        // 4) Unbind: empty string = not bound (unregister at runtime and persist an empty value)
        let unbound = commands::apply_hotkey(config::ACTION_SHOW_PANEL, "", &app);
        let unbound_ok = unbound
            .as_ref()
            .ok()
            .map(|s| s.hotkey(config::ACTION_SHOW_PANEL).is_none())
            .unwrap_or(false);
        check(&mut failures, "unbind clears settings", unbound_ok, true);
        check(
            &mut failures,
            "unbind unregisters in system",
            registered(SELFTEST_SHOW),
            false,
        );

        // 5) Dispatch: bind all three actions, fire them one by one through dispatch, and check the
        //    panel really moves
        let _ = commands::apply_hotkey(config::ACTION_SHOW_PANEL, SELFTEST_SHOW, &app);
        let _ = commands::apply_hotkey(config::ACTION_HIDE_PANEL, SELFTEST_HIDE, &app);
        let toggle_combo = config::load()
            .hotkey(config::ACTION_TOGGLE_PANEL)
            .unwrap_or_default();

        // 5.0) The block below asserts "the panel is still visible after being summoned". When run
        //      unattended, macOS hands the foreground back to the previous app → the panel loses
        //      focus → the blur auto-hide in `main.rs` hides it → 350ms later `visible()` reads
        //      "already hidden" → false FAIL (correct product behavior, the assertion racing the
        //      environment). Trigger (reproducible): repeatedly `open -a TextEdit` (or anything that
        //      activates another app) while the self-test runs; measured 3/3 reproductions on this
        //      machine (4 FAILs each). With an idle desktop it almost never happens, hence "flaky".
        //      Fix: pin the window for the duration of the self-test — blur auto-hide honors only
        //      this flag (`main.rs:144`), pinning does not change the show/hide assertion semantics
        //      (hide_panel/toggle_panel still hide), and the original value is restored afterwards.
        //      Do not use YHUB_DEBUG_NO_HIDE: that flag also shows+centers on startup (a "visual
        //      debugging window" mode).
        let pinned_before = commands::get_pinned(app.state::<Arc<AppState>>());
        if let Some(window) = app.get_webview_window(tray::MAIN_WINDOW) {
            let now = commands::set_pinned(true, app.state::<Arc<AppState>>(), window);
            eprintln!(
                "[selftest] 自检期间钉住窗口（pinned {pinned_before} -> {now}）：失焦自动收起不再干扰显隐断言"
            );
        } else {
            eprintln!("[selftest] 主窗口不在，无法钉住：显隐断言可能被失焦自动收起干扰");
        }

        let fire = |combo: &str| {
            if let Ok(shortcut) = Shortcut::from_str(combo) {
                let event = ShortcutEvent {
                    id: shortcut.id(),
                    state: ShortcutState::Pressed,
                };
                dispatch(&app, &shortcut, event);
            }
            std::thread::sleep(Duration::from_millis(350));
        };

        tray::hide_panel(&app);
        std::thread::sleep(Duration::from_millis(200));
        fire(SELFTEST_HIDE);
        check(&mut failures, "dispatch hide_panel -> hidden", visible(), false);
        fire(SELFTEST_SHOW);
        check(&mut failures, "dispatch show_panel -> visible", visible(), true);
        fire(SELFTEST_HIDE);
        check(&mut failures, "dispatch hide_panel again -> hidden", visible(), false);
        if toggle_combo.is_empty() {
            failures.push("toggle_panel 没有绑定组合键，无法验证切换动作".into());
        } else {
            let toggle = toggle_combo.clone();
            fire(&toggle);
            check(&mut failures, "dispatch toggle_panel（收起态）-> 呼出", visible(), true);
            // Whether a visible panel collapses depends on whether the window has focus (see
            // tray::toggle_panel: collapse only when visible && focused). Unattended runs usually
            // never get focus, so assert both branches per the real semantics instead of assuming
            // focus was obtained — otherwise this tests the environment, not the code.
            let focused = app
                .get_webview_window(tray::MAIN_WINDOW)
                .and_then(|w| w.is_focused().ok())
                .unwrap_or(false);
            fire(&toggle);
            if focused {
                check(
                    &mut failures,
                    "dispatch toggle_panel（可见 + 有焦点）-> 收起",
                    visible(),
                    false,
                );
            } else {
                eprintln!(
                    "[selftest] 窗口可见但没拿到焦点：按既定语义 toggle 只重新呼出、不收起（这是托盘左键同款行为）"
                );
                check(
                    &mut failures,
                    "dispatch toggle_panel（可见但无焦点）-> 保持呼出",
                    visible(),
                    true,
                );
            }
        }

        // 6) Unbound combo: dispatch must not move the panel
        let _ = commands::apply_hotkey(config::ACTION_SHOW_PANEL, "", &app);
        let _ = commands::apply_hotkey(config::ACTION_HIDE_PANEL, "", &app);
        tray::show_panel(&app);
        std::thread::sleep(Duration::from_millis(200));
        fire(SELFTEST_SHOW);
        check(
            &mut failures,
            "dispatch unbound combo -> no action",
            visible(),
            true,
        );

        // Restore the pinned state: this process exits right after, so this mainly keeps the
        // "self-test leaves no side effects" promise when other self-tests (e.g. the tray one) run
        // later in the same process.
        if let Some(window) = app.get_webview_window(tray::MAIN_WINDOW) {
            let now = commands::set_pinned(pinned_before, app.state::<Arc<AppState>>(), window);
            eprintln!("[selftest] 恢复窗口固定状态 pinned={now}");
        }

        if failures.is_empty() {
            eprintln!("[selftest] PASS");
        } else {
            eprintln!("[selftest] FAIL: {}", failures.join(", "));
        }
        app.exit(if failures.is_empty() { 0 } else { 1 });
    });
}
