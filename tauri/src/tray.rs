// Menu bar status item (tray) — Raycast-style interaction, behavior fully driven by the
// `~/.config/yhub/settings.json` `tray.*` settings (see TraySettings in config.rs):
//
//   close_behavior     on window close: hide = only hide (process stays in the menu bar) / quit = exit
//   left_click         left single click: toggle_panel / show_menu / none
//   double_click       left double click: same (macOS does not dispatch a DoubleClick event, so this
//                      file synthesizes it)
//   show_on_start      whether to show the panel directly at startup (apply_startup_visibility)
//   show_notifications whether to post a system notification on tray state changes (collapsed to the
//                      menu bar / quit)
//
// Three fixed things:
//   1. the persistent menu bar icon (template image, inverts automatically with the system light/dark mode)
//   2. the right-click menu: show panel / hide panel / open dashboard web / settings… / quit Y-Hub
//   3. toggle_panel / show_panel / hide_panel, reused by hotkeys and window events
//
// Settings are **never cached**: every click/close re-reads config::load(), so "settings take effect
// immediately after an edit" holds naturally (no change subscription needed). Conventions are in
// docs/gui-development.md, sections "menu bar tray" and "tray behavior settings".

use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};

use crate::backend;
use crate::commands::{self, AppState};
use crate::config;

/// Main window label (matches windows[0] in tauri.conf.json)
pub const MAIN_WINDOW: &str = "main";

/// Grace period right after the panel pops up: blurs during this window do **not** hide it.
///
/// Why it is needed (measured 2026-09-29): the `activateIgnoringOtherApps` inside `set_focus()` is
/// **asynchronous** — while the window is not yet ordered front, the system refuses the activation,
/// then macOS hands the foreground back to the previously frontmost app, so we receive one
/// `Focused(false)` and "blur auto-hide" hides the panel on the spot. The log looks like:
/// `show -> visible=Ok(true) focused=Ok(false)` → `focused=true` → `focused=false` → `blur -> hide`,
/// and what the user sees is **the panel flashing and disappearing** (1 in 2–4 synthesized hotkeys;
/// the tray menu path has an even older record, see known issue 4 in docs/gui-development.md). The
/// grace period plus the refocus loop below cover this race.
/// Measured (2026-09-29): the blur often arrives **~1 second** after showing (after the system rejects
/// that `activateIgnoringOtherApps` activation, macOS hands the foreground back to the previous app),
/// so the grace period must cover it:
pub const SHOW_GRACE: Duration = Duration::from_millis(1500);
/// Refocusing after showing: attempts / interval (covers the window in which "activation is
/// asynchronous"). Measured: the blur often arrives ~1s after showing (known issue 4 in
/// docs/gui-development.md is also ~1s), so refocusing must live for ~1.2s — do not give up early just
/// because "there is no focus yet".
const FOCUS_RETRIES: usize = 8;
const FOCUS_RETRY_EVERY: Duration = Duration::from_millis(200);
/// How many proactive refocus attempts at most (each only acts while "no focus right now"; keeps trying
/// until focus arrives, with headroom so it does not fight real clicks)
const FOCUS_ATTEMPTS: usize = 3;
/// Tray id (used to fetch the tray handle again, see show_menu)
const TRAY_ID: &str = "yhub-tray";

const MENU_SHOW: &str = "tray-show";
const MENU_HIDE: &str = "tray-hide";
const MENU_DASHBOARD: &str = "tray-dashboard";
const MENU_SETTINGS: &str = "tray-settings";
const MENU_QUIT: &str = "tray-quit";

/// Event name emitted by the tray menu's "settings…": the UI listens (in App.tsx) and switches to the
/// settings view. Event names only allow alphanumerics and `-` / `/` / `:` / `_`, hence a colon instead
/// of a dot.
pub const EVENT_OPEN_SETTINGS: &str = "yhub:open-settings";
/// Event payload: the section id to open (all tray-related settings live in this section)
const OPEN_SETTINGS_SECTION: &str = "tray";

/// Vertical position of the panel inside the screen work area (Raycast feel: near the top, not centered)
const PANEL_TOP_RATIO: f64 = 0.18;

/// After a blur auto-hide, tray clicks within this window are treated as the aftermath of the *same*
/// click and do not expand the panel again.
///
/// Why this window: when the menu bar icon is clicked, the main window may lose focus first (triggering
/// blur auto-hide) while the tray event arrives afterwards. Without this check, "one click to collapse"
/// would become "collapse then immediately expand".
const BLUR_GRACE: Duration = Duration::from_millis(400);

/// Double-click detection window: two left-button ups closer than this count as one double click.
///
/// On macOS `TrayIconEvent::DoubleClick` is only dispatched on Windows, so double clicks must be
/// synthesized: record the time of the first click and treat a second one within the window as the
/// double_click behavior.
const DOUBLE_CLICK_WINDOW: Duration = Duration::from_millis(320);

/// Click state machine for the status item (kept across events): last left-click time + generation.
///
/// `generation` cancels a "pending single click": when double_click has an action, a single click must
/// wait DOUBLE_CLICK_WINDOW to be sure it is not a double click, and the generation tells whether that
/// moment was superseded by a double click.
struct ClickState {
    last: Option<Instant>,
    generation: u64,
}

static CLICK_STATE: Mutex<ClickState> = Mutex::new(ClickState {
    last: None,
    generation: 0,
});

/// Build the menu bar status item. Failures only log and do not affect the main flow (window and hotkeys
/// keep working).
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, MENU_SHOW, crate::i18n::tr("tray.show"), true, None::<&str>)?;
    let hide = MenuItem::with_id(app, MENU_HIDE, crate::i18n::tr("tray.hide"), true, None::<&str>)?;
    let dashboard = MenuItem::with_id(app, MENU_DASHBOARD, crate::i18n::tr("tray.dashboard"), true, None::<&str>)?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, crate::i18n::tr("tray.settings"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, crate::i18n::tr("tray.quit"), true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&show, &hide, &dashboard, &separator, &settings, &quit],
    )?;

    // Template image (pure alpha; 36px corresponds to 18pt @2x): macOS inverts it automatically for
    // light/dark mode
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray/tray-template.png"))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Y-Hub")
        .menu(&menu)
        .show_menu_on_left_click(false) // 左键交给我们自己按 left_click 设置处理，右键才弹菜单
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => {
                eprintln!("[tray] menu: show");
                show_panel_from_menu(app);
            }
            MENU_HIDE => {
                eprintln!("[tray] menu: hide");
                hide_panel(app);
            }
            MENU_DASHBOARD => {
                eprintln!("[tray] menu: open dashboard web");
                // Ensuring the backend runs + starting the browser can both block (up to 20 s), so the
                // menu event callback must spawn a thread: NSMenu's tracking loop is modal, and blocking
                // here freezes the whole menu / main thread
                let app = app.clone();
                std::thread::spawn(move || {
                    match commands::open_dashboard_web_blocking(&app) {
                        Ok(url) => eprintln!("[tray] dashboard web -> 已打开 {url}"),
                        Err(e) => {
                            eprintln!("[tray] dashboard web FAILED: {e}");
                            notify(&format!("{}：{e}", crate::i18n::tr("notify.dashboard_failed")), false);
                        }
                    }
                });
            }
            MENU_SETTINGS => {
                eprintln!("[tray] menu: settings");
                show_panel_from_menu(app);
                match app.emit(EVENT_OPEN_SETTINGS, OPEN_SETTINGS_SECTION) {
                    Ok(()) => eprintln!(
                        "[tray] settings -> emit {EVENT_OPEN_SETTINGS} (section={OPEN_SETTINGS_SECTION})"
                    ),
                    Err(e) => eprintln!("[tray] settings -> emit FAILED: {e}"),
                }
            }
            MENU_QUIT => {
                eprintln!("[tray] quit from menu");
                notify(crate::i18n::tr("notify.quit"), true);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Debug switch: YHUB_DEBUG_TRAY_EVENTS=1 prints every tray event (including Enter/Move/Leave
            // with physical coordinates / icon rect) to stderr. Acceptance tests with synthesized mouse
            // events need it to distinguish "the click missed the icon" from "it hit but Click was not
            // delivered".
            if std::env::var("YHUB_DEBUG_TRAY_EVENTS").is_ok() {
                eprintln!("[tray] event: {event:?}");
            }
            // macOS sends one Click on press and one on release; act only on "up", otherwise one click
            // would toggle twice. macOS does not dispatch DoubleClick (see DOUBLE_CLICK_WINDOW), so double
            // clicks are synthesized in handle_left_click.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                handle_left_click(tray.app_handle());
            }
        })
        .build(app)?;

    eprintln!("[tray] built id={TRAY_ID}");
    Ok(())
}

/// Align tray-related runtime state with the settings. Currently one item: whether the left click is
/// delegated to the native macOS menu.
///
/// Why not make programmatic popping (`inner.show_menu()`) the main path: that call is **modal** (the
/// NSMenu tracking loop holds the main thread until the menu closes; measured: it does not return for
/// 40s), while macOS's native "left click pops the menu" switch is non-blocking and behaves most
/// authentically. Programmatic popping is only used as a fallback where the native switch cannot express
/// the behavior (e.g. "pop the menu on double click", see dispatch).
///
/// When it is called: after main.rs finishes reading settings (warnings already printed) and after every
/// write to a `tray.*` setting (commands.rs). It deliberately **does not read the config file here**: the
/// settings layer emits warnings on corruption, and whoever reads first "eats" them
/// (`load_with_warnings` reports once), so the startup path must have main.rs read first and pass the
/// settings in.
pub fn apply_settings(app: &AppHandle, tray_settings: &config::TraySettings) {
    let native = native_left_menu(tray_settings);
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        eprintln!("[tray] apply_settings: 托盘未找到");
        return;
    };
    match tray.set_show_menu_on_left_click(native) {
        Ok(()) => eprintln!(
            "[tray] apply: 左键弹菜单 native={native}（left_click={} double_click={}）",
            tray_settings.left_click, tray_settings.double_click
        ),
        Err(e) => eprintln!("[tray] apply: set_show_menu_on_left_click({native}) FAILED: {e}"),
    }
}

/// Should the left click be delegated to the native macOS menu? Only when "single click = pop menu and no
/// double-click action", otherwise the system would pop the menu on every single click and double-click
/// detection would never get a chance.
fn native_left_menu(tray_settings: &config::TraySettings) -> bool {
    tray_settings.left_click == "show_menu" && tray_settings.double_click == "none"
}

/// Handle one left single click (tray events and the self-test share this path).
///
/// Double-click synthesis rules:
///   - `double_click = none` (default): the single click runs left_click **immediately**, and the second
///     click within the window is treated as "double click = no response", so one double click toggles
///     only once and adds no latency at all;
///   - `double_click` has an action: the single click is held for DOUBLE_CLICK_WINDOW and runs only if no
///     second click arrives; an arriving second click is treated as a double click (cancelling the
///     pending single click).
pub fn handle_left_click(app: &AppHandle) {
    let tray_settings = config::load().tray;
    let left = tray_settings.left_click.clone();
    let double = tray_settings.double_click.clone();

    let (is_double, generation) = {
        let mut state = match CLICK_STATE.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        let now = Instant::now();
        let is_double = state
            .last
            .map(|last| now.duration_since(last) < DOUBLE_CLICK_WINDOW)
            .unwrap_or(false);
        state.last = Some(now);
        state.generation += 1;
        (is_double, state.generation)
    };

    if is_double {
        eprintln!("[tray] double click detected -> double_click={double}");
        dispatch(app, &double, "double_click", &tray_settings);
        return;
    }

    if double == "none" {
        dispatch(app, &left, "left_click", &tray_settings);
        return;
    }

    // Hold the single click first: if a second click arrives within the window, the generation check drops
    // this task
    let app = app.clone();
    eprintln!(
        "[tray] single click pending {}ms (double_click={double})",
        DOUBLE_CLICK_WINDOW.as_millis()
    );
    std::thread::spawn(move || {
        std::thread::sleep(DOUBLE_CLICK_WINDOW);
        let still_pending = {
            let state = match CLICK_STATE.lock() {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
            state.generation == generation
        };
        if still_pending {
            dispatch(&app, &left, "left_click", &tray_settings);
        } else {
            eprintln!("[tray] pending single click cancelled by double click");
        }
    });
}

/// Execute one tray click behavior (allowed values match config::CLICK_BEHAVIORS)
fn dispatch(app: &AppHandle, action: &str, source: &str, tray_settings: &config::TraySettings) {
    eprintln!("[tray] action={action} source={source}");
    match action {
        "toggle_panel" => {
            if hidden_by_blur_just_now(app) {
                eprintln!("[tray] click right after blur-hide -> keep hidden");
                return;
            }
            toggle_panel(app);
        }
        "show_menu" => {
            if native_left_menu(tray_settings) {
                // Delegated to the native macOS switch (already enabled by apply_settings): non-blocking,
                // and does not pop twice
                eprintln!("[tray] show_menu -> 交给 macOS 原生弹出（非阻塞）");
            } else {
                // The native switch cannot express this (e.g. "pop the menu on double click"): fall back to
                // programmatic popping. Note: this call is modal — the main thread stays in the menu
                // tracking loop until the menu closes (same as the right-click menu).
                show_menu(app);
            }
        }
        "none" => eprintln!("[tray] action=none：按设置不响应"),
        other => eprintln!("[tray] 未知点击行为 \"{other}\"（按不响应处理）"),
    }
}

/// Decide whether to show the panel at startup from settings (`tray.show_on_start`).
/// The window is `visible:false` in tauri.conf.json, so "show" must be called explicitly from here.
pub fn apply_startup_visibility(app: &AppHandle) {
    if config::load().tray.show_on_start {
        eprintln!("[tray] show_on_start=true -> 启动即显示面板");
        show_panel(app);
    } else {
        eprintln!("[tray] show_on_start=false -> 启动不显示（常驻菜单栏，等热键或托盘点击）");
    }
}

/// Toggle panel visibility (the tray left click and global hotkeys share this behavior)
pub fn toggle_panel(app: &AppHandle) {
    let Some(window) = ensure_window(app) else {
        backend::log("面板 toggle：窗口不存在且重建失败（面板打不开）");
        eprintln!("[tray] main window not found");
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    eprintln!("[tray] toggle: visible={visible} focused={focused}");
    backend::log(&format!("面板 toggle：visible={visible} focused={focused}"));
    // **Only treat this press as "collapse" when the panel has actually had focus.**
    // Why (measured 2026-09-29, with screenshot evidence): when activation fails the panel is
    // `is_visible()=true` but **buried behind another app's windows** (the system does not raise windows
    // of a non-active app), so the user cannot see it at all — treating "visible" as "collapse" would
    // hide it on one press, and the next press would only pop it behind other windows again, so it can
    // never be summoned. Hence: visible but unfocused = raise it again.
    if visible && focused {
        hide_panel(app);
    } else {
        show_panel(app);
    }
}

/// Show the panel on the screen under the mouse and focus it
pub fn show_panel(app: &AppHandle) {
    let Some(window) = ensure_window(app) else {
        backend::log("面板弹出：窗口不存在且重建失败（面板打不开）");
        eprintln!("[tray] main window not found");
        return;
    };
    place_on_cursor_screen(app, &window);
    // Floating level + visible on all spaces: floats above other apps' windows **without depending on
    // activation**. Why this is required (screenshot evidence 2026-09-29): an accessory app often fails to
    // activate when summoned by a global hotkey, and windows of a non-active app are buried behind the
    // active app's windows — the shell sees `visible=Ok(true)` while the screen shows nothing (the
    // screenshot has no panel), so the user thinks "the panel did not come up / crashed". Menu bar popup
    // tools (Raycast / Alfred) all rely on raising the window level to stay visible without activation.
    let _ = window.unminimize();
    let _ = window.show();
    // The level/collection behavior must be set after the window is "ordered in", and it only really
    // takes effect after ordering **once more**. Measured (2026-09-29, reading the system window table via
    // `tauri/scripts/win-probe.swift`): with only one level set, the panel often stays `onscreen=0` after
    // the first show (buried behind other apps' windows, invisible); showing once more immediately after
    // turns it into `onscreen=1`. So order it twice in a row here.
    let _ = window.set_always_on_top(true);
    let _ = window.set_visible_on_all_workspaces(true);
    let _ = window.show();
    // Add the AppKit-level handling too (orderFrontRegardless + canJoinAllSpaces): Tauri does not expose
    // those two APIs, and they are exactly what makes "float on top without activation, visible on every
    // desktop" work — see the notes in macos_panel.rs.
    raise_panel(&window);
    // `set_focus` internally calls activateIgnoringOtherApps — but that activation is **asynchronous** and
    // is refused by the system while the window is not yet ordered front (see the SHOW_GRACE note). So:
    // record the show time (no hiding on blur during the grace period), then start a loop that retries
    // focus to win back the "activation receipt".
    let shown_at = Instant::now();
    if let Some(st) = app.try_state::<std::sync::Arc<AppState>>() {
        if let Ok(mut stamp) = st.last_show.lock() {
            *stamp = Some(shown_at);
        }
        st.focus_seen.store(false, Ordering::SeqCst);
    }
    // Record the level state (some versions have no all_workspaces getter, so do not read it)
    backend::log(&format!("面板层级已抬高：always_on_top={:?}", window.is_always_on_top()));
    let _ = window.set_focus();
    eprintln!(
        "[tray] show -> visible={:?} focused={:?} pos={:?}",
        window.is_visible(),
        window.is_focused(),
        window.outer_position().map(|p| (p.x, p.y))
    );
    backend::log(&format!(
        "面板弹出 -> visible={:?} focused={:?}（拿不到焦点会自动补，见 SHOW_GRACE）",
        window.is_visible(),
        window.is_focused()
    ));
    log_panel_visibility(&window, "弹出时");
    keeper(shown_at, window);
}

/// Guard focus after showing: for the whole window (~1.6s), look every 200ms and refocus only when
/// **there is no focus right now**.
///
/// Key point (a pitfall we hit): do not exit on "focus seen" — right after showing, `is_focused()` is
/// often true, but **about 1 second later** the system hands the foreground back (that is when
/// `Focused(false)` arrives). So this does not exit early; it stays for the full window. If the user
/// really clicks elsewhere, `blur -> hide` collapses the panel after the grace period and this function
/// exits because the window is no longer visible, without fighting the user.
fn keeper(shown_at: Instant, window: WebviewWindow) {
    std::thread::spawn(move || {
        let mut attempts = 0usize;
        let mut refocused = false;
        for _ in 0..FOCUS_RETRIES {
            std::thread::sleep(FOCUS_RETRY_EVERY);
            if shown_at.elapsed() > SHOW_GRACE + FOCUS_RETRY_EVERY {
                break;
            }
            if !window.is_visible().unwrap_or(false) {
                break; // already collapsed (user clicked outside / pressed the hotkey again)
            }
            if window.is_focused().unwrap_or(false) {
                continue; // focus right now, but **do not exit** — the system may take it back after ~1s
            }
            if attempts >= FOCUS_ATTEMPTS {
                break;
            }
            attempts += 1;
            let _ = window.show(); // order again: measured, this is what actually puts an "already visible but not raised" panel on screen
            raise_panel(&window);
            let _ = window.set_focus();
            let mut now = window.is_focused().unwrap_or(false);
            eprintln!("[tray] 补聚焦 #{attempts} -> focused={now:?}");
            backend::log(&format!("面板补聚焦 #{attempts} -> focused={now:?}"));
            if !now {
                // When set_focus cannot get focus, use LaunchServices as a fallback to raise the foreground
                // (see the notes on activate_via_launchservices)
                if let Some(bundle) = activate_via_launchservices() {
                    std::thread::sleep(Duration::from_millis(150));
                    let _ = window.set_focus();
                    now = window.is_focused().unwrap_or(false);
                    eprintln!("[tray] LaunchServices 抬前台（{bundle}）-> focused={now:?}");
                    backend::log(&format!("面板拿不到焦点 —— 用 LaunchServices 抬前台后 focused={now:?}"));
                }
            }
            if now {
                refocused = true;
            }
        }
        if refocused {
            backend::log("面板焦点稳住了（弹出后一度被系统收走，已补回）");
        }
        log_panel_visibility(&window, "守焦点结束时");
    });
}

/// Collapse the panel (does not exit the process)
pub fn hide_panel(app: &AppHandle) {
    if commands::dialog_open(app) {
        // A system dialog is open (file picker): collapsing takes the dialog with it, while the plugin's
        // sheet is still attached, and buttons then do nothing. Better not to hide yet.
        eprintln!("[tray] hide -> 跳过（系统对话框开着）");
        return;
    }
    match main_window(app) {
        Some(window) => {
            let _ = window.hide();
            eprintln!("[tray] hide -> visible={:?}", window.is_visible());
            backend::log(&format!("面板收起 -> visible={:?}", window.is_visible()));
        }
        // The window is gone, nothing to collapse; but leave a trace (otherwise "pressed it, nothing
        // happened" cannot be investigated)
        None => backend::log("面板收起：窗口不存在（无需收起）"),
    }
}

/// Summon the panel from the menu: after the menu interaction macOS may hand the foreground back to the
/// previous app, and the panel gets blur-auto-hidden after ~1 second (known issue 4 in
/// docs/gui-development.md). This used to refocus once after 350ms (only while the panel was still
/// visible and unfocused).
fn show_panel_from_menu(app: &AppHandle) {
    // Refocusing is done uniformly in show_panel() (retried 4 times × 200ms within the grace period), so do
    // not refocus separately here: if both paths were missing and both retried, they would fight over
    // focus. The grace period covers the foreground hand-back after the menu closes.
    show_panel(app);
}

/// Pop the tray menu (used when left_click / double_click = show_menu; the menu appears at the mouse)
fn show_menu(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        eprintln!("[tray] show_menu: 托盘未找到");
        return;
    };
    match tray.with_inner_tray_icon(|inner| inner.show_menu()) {
        Ok(()) => eprintln!("[tray] show_menu -> 已请求在鼠标位置弹出菜单"),
        Err(e) => eprintln!("[tray] show_menu FAILED: {e}"),
    }
}

/// System notification (collapsed to the menu bar / quit), controlled only by `tray.show_notifications`.
///
/// Uses `osascript -e 'display notification …'` rather than a notification plugin: no new dependency, and
/// failures are only logged. Whether the notification actually appears also depends on the system
/// "Notifications" permission, so this only guarantees "a request is sent according to the setting" and
/// records the outcome honestly. `block = true` waits for osascript to exit (at most 1.5s) — used before
/// quitting, otherwise the process is gone along with the logs.
pub fn notify(body: &str, block: bool) {
    if !config::load().tray.show_notifications {
        eprintln!("[notify] skipped (show_notifications=false): {body}");
        return;
    }
    let script = format!(
        "display notification \"{}\" with title \"Y-Hub\"",
        body.replace('\\', "\\\\").replace('"', "\\\"")
    );
    eprintln!("[notify] posting: {body}");
    let child = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn();

    match child {
        Err(e) => eprintln!("[notify] osascript 启动失败：{e}"),
        Ok(mut child) => {
            if block {
                let deadline = Instant::now() + Duration::from_millis(1500);
                loop {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            eprintln!("[notify] osascript exit: {status}");
                            break;
                        }
                        Ok(None) if Instant::now() < deadline => {
                            std::thread::sleep(Duration::from_millis(50));
                        }
                        Ok(None) => {
                            eprintln!("[notify] osascript 未在 1.5s 内退出，不再等待");
                            break;
                        }
                        Err(e) => {
                            eprintln!("[notify] osascript 等待失败：{e}");
                            break;
                        }
                    }
                }
            } else {
                std::thread::spawn(move || match child.wait() {
                    Ok(status) => eprintln!("[notify] osascript exit: {status}"),
                    Err(e) => eprintln!("[notify] osascript 等待失败：{e}"),
                });
            }
        }
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

/// Fetch the main window; when it is gone, **leave an honest trace**.
///
/// Why these few lines matter (2026-09-29): when `get_webview_window()` returned None, the old code only
/// printed one line to stderr and returned — launched from the Dock / `open -a`, stderr goes nowhere, so
/// the user saw "hotkeys and the tray menu both do nothing, and not a single log line", impossible to
/// investigate (the user's report, verbatim: "the panel cannot be summoned via hotkey, and the tray menu
/// does not work either").
/// The "rebuild the window" fallback is **no longer done**: measured, Tauri exits the whole shell when the
/// window is destroyed (`[window] destroyed` → backend shutdown → exit code 0, see
/// `WindowEvent::Destroyed` in `main.rs`), so there is nothing recoverable on this path — and if it really
/// happened the menu bar icon would vanish too, which is a different symptom.
fn ensure_window(app: &AppHandle) -> Option<WebviewWindow> {
    match main_window(app) {
        Some(w) => Some(w),
        None => {
            backend::log("面板操作：主窗口不存在（壳可能正在退出/重启）");
            eprintln!("[tray] main window missing");
            None
        }
    }
}

/// Was it just collapsed by "blur auto-hide"? See the BLUR_GRACE notes.
fn hidden_by_blur_just_now(app: &AppHandle) -> bool {
    let state = app.state::<std::sync::Arc<AppState>>();
    state
        .last_blur_hide
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .map(|at| at.elapsed() < BLUR_GRACE)
        .unwrap_or(false)
}

/// Place the window on the screen under the mouse: horizontally centered, near the top (18% of the work
/// area height), clamped inside the work area. Uses work_area (menu bar and Dock already excluded) rather
/// than the full screen so the panel does not end up under the menu bar.
fn place_on_cursor_screen(app: &AppHandle, window: &WebviewWindow) {
    let Ok(size) = window.outer_size() else {
        return;
    };
    let (win_w, win_h) = (size.width as f64, size.height as f64);

    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        // Without screen information, fall back to system centering — do not leave the panel off screen
        let _ = window.center();
        return;
    };

    let area = monitor.work_area();
    let (ax, ay) = (area.position.x as f64, area.position.y as f64);
    let (aw, ah) = (area.size.width as f64, area.size.height as f64);

    let x = ax + ((aw - win_w) / 2.0).max(0.0);
    let y = ay + ((ah - win_h) * PANEL_TOP_RATIO).max(0.0);

    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    eprintln!(
        "[tray] place on monitor {:?} work_area=({ax},{ay},{aw}x{ah}) -> ({},{})",
        monitor.name(),
        x.round() as i32,
        y.round() as i32
    );
}

// ---------------------------------------------------------------- self-test

/// Self-test: with YHUB_DEBUG_TRAY_SELFTEST=1, run through tray interaction along the real call paths and
/// print results.
///
/// Why it is needed: on this machine, synthesized clicks delivered with CGEvent never reach a third-party
/// status item (only Enter/Move/Leave tracking events arrive), so "a real mouse clicking the icon" cannot
/// be automated; this is the only way to verify "click → panel show/hide → close only hides or quits"
/// end to end. It uses exactly the same functions as tray events (handle_left_click / show_panel /
/// hide_panel), and **all expectations are derived from the settings**, so the same self-test works for
/// multiple configurations (that is how tauri/scripts/verify-tray-behavior.sh runs it).
pub fn spawn_selftest(app: AppHandle) {
    // Pin the window (Pinned) for the duration of the self-test: unattended runs let macOS hand the
    // foreground back to another app → the panel blurs → blur auto-hide at `main.rs:144` hides it → the
    // `visible()` read below says "already hidden" → false FAIL (correct product behavior, the assertion
    // racing the environment). Reproducible trigger: repeatedly `open -a TextEdit` to steal focus while the
    // self-test runs; before the fix this reproduced 3/3 times on this machine (3 FAILs each); with a quiet
    // desktop it almost never happened, hence the earlier "flaky" appearance.
    // Pinning goes through the settings UI's command path (commands::set_pinned); blur auto-hide honors only
    // this flag, and the original value is restored afterwards; hide_panel / toggle_panel collapse semantics
    // are unaffected.
    //
    // Pinning must happen **synchronously** here, not after entering the thread: with `show_on_start=true`
    // the panel is already shown in setup, and blur auto-hide is only dispatched once the event loop turns —
    // pinning synchronously during this setup pass just wins the race (measured: moving the pin into the
    // thread still fails case C's "panel shown at startup" assertion, because the panel was hidden before the
    // thread woke up). Do not use YHUB_DEBUG_NO_HIDE either: that flag also shows+centers at startup and
    // changes the scenario under test.
    let pinned_before = pin_window(&app);

    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        let tray = config::load().tray;
        let mut failures: Vec<String> = Vec::new();

        eprintln!(
            "[selftest] start close_behavior={} left_click={} double_click={} show_on_start={} show_notifications={} native_left_menu={}",
            tray.close_behavior, tray.left_click, tray.double_click, tray.show_on_start, tray.show_notifications,
            native_left_menu(&tray)
        );

        // Programmatic menu popping is modal (the main thread cannot leave until the menu closes); when the
        // config really takes that path, skip the click phases and verify only startup and close — otherwise
        // the self-test gets stuck in the menu tracking loop (the script side would time out).
        let programmatic_menu = !native_left_menu(&tray)
            && (tray.left_click == "show_menu" || tray.double_click == "show_menu");
        if programmatic_menu {
            eprintln!(
                "[selftest] 配置会走程序化弹菜单（模态）：跳过点击相位，只验启动可见性与关窗行为"
            );
        }

        // 0) Startup visibility follows show_on_start
        expect_visible(
            &mut failures,
            "startup visibility = show_on_start",
            visible(&app),
            tray.show_on_start,
        );
        settle(&app);

        if !programmatic_menu {
            // 1) Single click (keep it away from the next click so it is not taken as a double click)
            let expect_single = expected_from_hidden(&tray.left_click);
            handle_left_click(&app);
            std::thread::sleep(detect_window(&tray) + Duration::from_millis(400));
            expect_visible(
                &mut failures,
                &format!("single click left_click={}", tray.left_click),
                visible(&app),
                expect_single,
            );
            hide_panel(&app);
            settle(&app);

            // 2) Double click: two clicks inside the double-click window → only the double_click action
            //    applies; both "the single click already ran once" (double_click=none) and "the pending
            //    single click was cancelled" (anything else) pass
            let expect_double = if tray.double_click == "none" {
                expected_from_hidden(&tray.left_click)
            } else {
                expected_from_hidden(&tray.double_click)
            };
            handle_left_click(&app);
            std::thread::sleep(Duration::from_millis(60));
            handle_left_click(&app);
            std::thread::sleep(detect_window(&tray) + Duration::from_millis(500));
            expect_visible(
                &mut failures,
                &format!(
                    "double click left_click={} double_click={}",
                    tray.left_click, tray.double_click
                ),
                visible(&app),
                expect_double,
            );
            hide_panel(&app);
            settle(&app);
        }

        // 3) Close behavior
        show_panel(&app);
        std::thread::sleep(Duration::from_millis(300));
        if tray.close_behavior == "quit" {
            eprintln!("[selftest] close_behavior=quit：关窗后进程应当自行退出");
            if let Some(window) = main_window(&app) {
                let _ = window.close();
            }
            std::thread::sleep(Duration::from_millis(1500));
            eprintln!("[selftest] FAIL: close 之后进程仍在（close_behavior=quit 未生效）");
            app.exit(1);
            return;
        }

        if let Some(window) = main_window(&app) {
            let _ = window.close();
            std::thread::sleep(Duration::from_millis(600));
            expect_visible(&mut failures, "close -> hidden", visible(&app), false);
            expect_visible(
                &mut failures,
                "close -> window still alive",
                main_window(&app).is_some(),
                true,
            );
        } else {
            failures.push("close: main window missing".into());
        }

        // 4) After closing, the tray can still bring the panel back (per the left_click setting)
        if !programmatic_menu {
            settle(&app);
            handle_left_click(&app);
            std::thread::sleep(detect_window(&tray) + Duration::from_millis(400));
            expect_visible(
                &mut failures,
                "click after close",
                visible(&app),
                expected_from_hidden(&tray.left_click),
            );
        }

        // 5) Edits take effect immediately (YHUB_DEBUG_TRAY_LIVE_RELOAD=1):
        //    the program changes settings through the same IPC path (config::set + apply_settings), and the
        //    next click must follow the new value; restoring the old value must be picked up just as
        //    quickly — proving the runtime caches no settings.
        if std::env::var("YHUB_DEBUG_TRAY_LIVE_RELOAD").is_ok() && !programmatic_menu {
            let original = tray.left_click.clone();
            let flipped = if original == "none" {
                "toggle_panel"
            } else {
                "none"
            };
            match config::set("tray.left_click", serde_json::json!(flipped)) {
                Ok(updated) => {
                    apply_settings(&app, &updated.tray);
                    eprintln!(
                        "[selftest] live reload: left_click {original} -> {}",
                        updated.tray.left_click
                    );
                    settle(&app);
                    handle_left_click(&app);
                    std::thread::sleep(detect_window(&updated.tray) + Duration::from_millis(400));
                    expect_visible(
                        &mut failures,
                        "live reload: 新值立刻生效",
                        visible(&app),
                        expected_from_hidden(&updated.tray.left_click),
                    );

                    // Restore the original value and click again: this is not "took effect once", it re-reads
                    // every time
                    match config::set("tray.left_click", serde_json::json!(original)) {
                        Ok(restored) => {
                            apply_settings(&app, &restored.tray);
                            eprintln!(
                                "[selftest] live reload: left_click 改回 {}",
                                restored.tray.left_click
                            );
                            settle(&app);
                            handle_left_click(&app);
                            std::thread::sleep(
                                detect_window(&restored.tray) + Duration::from_millis(400),
                            );
                            expect_visible(
                                &mut failures,
                                "live reload: 改回原值也立刻生效",
                                visible(&app),
                                expected_from_hidden(&restored.tray.left_click),
                            );
                        }
                        Err(e) => failures.push(format!("live reload: 改回原值失败 {e}")),
                    }
                }
                Err(e) => failures.push(format!("live reload: 写设置失败 {e}")),
            }
        }

        // While a system dialog (file picker) is open, collapsing must be blocked: collapsing the panel takes
        // the dialog with it while the plugin's sheet is still attached — the user then clicks buttons and
        // nothing happens (measured 2026-09-28).
        // Note `settle()` is "collapse + wait" (not a plain wait), so it cannot be used as "wait until the
        // panel is shown"; sleep here explicitly (BLUR_GRACE is the blur-auto-hide grace constant).
        {
            let state = app.state::<std::sync::Arc<AppState>>();
            state.dialog_open.store(true, Ordering::SeqCst);
            show_panel(&app);
            std::thread::sleep(BLUR_GRACE + Duration::from_millis(300));
            expect_visible(
                &mut failures,
                "对话框开着时面板能正常弹出（前提）",
                visible(&app),
                true,
            );
            hide_panel(&app);
            std::thread::sleep(Duration::from_millis(250));
            expect_visible(
                &mut failures,
                "对话框开着时 hide_panel 不收面板",
                visible(&app),
                true,
            );
            state.dialog_open.store(false, Ordering::SeqCst);
            hide_panel(&app);
            std::thread::sleep(Duration::from_millis(250));
            expect_visible(
                &mut failures,
                "对话框关掉后 hide_panel 照旧收起",
                visible(&app),
                false,
            );
        }

        // Restore the pinned state: this process then exits with its verdict, so this mainly keeps the
        // "self-test leaves no side effects" promise when other phases (e.g. live reload) run later in the
        // same process.
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            let now = commands::set_pinned(
                pinned_before,
                app.state::<std::sync::Arc<AppState>>(),
                window,
            );
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

/// Pin the main window (Pinned) for the self-test: blur auto-hide honors only this flag (`main.rs:144`).
/// Returns the value before pinning; the caller restores it. Goes through the same command path as the
/// settings UI (`commands::set_pinned`).
fn pin_window(app: &AppHandle) -> bool {
    let before = commands::get_pinned(app.state::<std::sync::Arc<AppState>>());
    match app.get_webview_window(MAIN_WINDOW) {
        Some(window) => {
            let now = commands::set_pinned(true, app.state::<std::sync::Arc<AppState>>(), window);
            eprintln!(
                "[selftest] 自检期间钉住窗口（pinned {before} -> {now}）：失焦自动收起不再干扰显隐断言"
            );
        }
        None => eprintln!("[selftest] 主窗口不在，无法钉住：显隐断言可能被失焦自动收起干扰"),
    }
    before
}

/// Raise the panel to the front on the main thread (AppKit calls must be on the main thread)
fn raise_panel(window: &WebviewWindow) {
    let w = window.clone();
    let _ = window.run_on_main_thread(move || crate::macos_panel::raise(&w));
}

/// Record "is the panel actually visible to the user" (AppKit's occlusionState, the authoritative signal).
/// `is_visible()` lies: it can be Ok(true) while the screen is empty (measured 2026-09-29), so log this line
/// separately after showing.
fn log_panel_visibility(window: &WebviewWindow, when: &str) {
    let w = window.clone();
    let when = when.to_string();
    let _ = window.run_on_main_thread(move || {
        match crate::macos_panel::is_occluded_or_hidden(&w) {
            Some(true) => backend::log(&format!(
                "面板可见性[{when}]：**被遮挡/不在屏上**（用户看不到 —— is_visible 却可能是 true）"
            )),
            Some(false) => backend::log(&format!("面板可见性[{when}]：在屏可见")),
            None => {}
        }
    });
}

/// Raise this app to the foreground via LaunchServices (fallback activation); returns which bundle was raised.
///
/// Why it is needed (measured 2026-09-29, macOS 26): when an accessory app (LSUIElement) is summoned by a
/// global hotkey while in the background, the activation inside `set_focus()` is **ignored** by the system
/// (tao calls the deprecated `activateIgnoringOtherApps:`, which new systems no longer guarantee) → the
/// window gets no keyboard focus (`focused=Ok(false)`) → after ~2 seconds the system hands the foreground
/// back to the previous app → "blur auto-hide" hides the panel on the spot → the user sees "the UI flashes
/// and disappears / the panel cannot be opened". LaunchServices activation requests, however, are honored:
/// measured, after `open -a /Applications/Y-Hub.app` the next popup reports `focused=Ok(true)`.
///
/// Only done when "we really run inside an .app bundle" (a bare development binary has no .app to raise);
/// at most once every 3 seconds, so it does not repeatedly steal the user's foreground.
fn activate_via_launchservices() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    // .../Y-Hub.app/Contents/MacOS/yhub -> .../Y-Hub.app
    let bundle = exe.parent()?.parent()?.parent()?;
    if bundle.extension().and_then(|e| e.to_str()) != Some("app") {
        backend::log("拿不到焦点，但当前不是从 .app 里运行（开发期裸二进制），不做 LaunchServices 抬前台");
        return None;
    }
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    if let Ok(mut last) = LAST.lock() {
        if let Some(t) = *last {
            if t.elapsed() < Duration::from_secs(3) {
                return None; // raised it just now, do not steal repeatedly
            }
        }
        *last = Some(Instant::now());
    }
    let bundle = bundle.to_path_buf();
    std::process::Command::new("/usr/bin/open")
        .arg("-a")
        .arg(&bundle)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    Some(bundle.display().to_string())
}

/// After one left click on a panel that is "currently hidden", should the panel be visible afterwards?
/// toggle_panel from hidden always pops it up; popping the menu / no response do not change visibility.
fn expected_from_hidden(action: &str) -> bool {
    match action {
        "toggle_panel" => true,
        _ => false,
    }
}

/// Under this configuration, how long must a click wait before "the single-click action ran / was cancelled"
/// is observable?
fn detect_window(tray: &config::TraySettings) -> Duration {
    if tray.double_click == "none" {
        Duration::from_millis(0)
    } else {
        DOUBLE_CLICK_WINDOW
    }
}

/// Normalize to "hidden + past the blur aftermath window"; every phase starts from here
fn settle(app: &AppHandle) {
    hide_panel(app);
    std::thread::sleep(BLUR_GRACE + Duration::from_millis(300));
}

fn visible(app: &AppHandle) -> bool {
    main_window(app)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

fn expect_visible(failures: &mut Vec<String>, name: &str, got: bool, want: bool) {
    let verdict = if got == want { "OK" } else { "FAIL" };
    eprintln!("[selftest] {name}: got={got} want={want} {verdict}");
    if got != want {
        failures.push(name.to_string());
    }
}
