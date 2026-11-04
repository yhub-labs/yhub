//! macOS panel presentation: drive AppKit directly to get the menu bar popup behavior of
//! "floats on top even when the app is not active".
//!
//! Why this module exists (measured 2026-09-29): when an accessory app (`LSUIElement`) is
//! summoned by a global hotkey, Tauri's `set_focus()` often fails to activate it (tao calls the
//! deprecated `activateIgnoringOtherApps:`), and **windows of a non-active app are buried behind
//! the active app's windows** — the shell reports `is_visible() == Ok(true)`, yet the window is
//! `onscreen=0` in `CGWindowListCopyWindowInfo` (screenshots capture nothing). The user sees
//! "the panel will not come up / flashes and disappears".
//!
//! The fix is the one menu bar popup tools (Raycast / Alfred) use:
//!   1. raise the window to a floating level (`set_always_on_top` already does that; the collection
//!      behavior below adds "visible on every desktop");
//!   2. `setCollectionBehavior(canJoinAllSpaces | fullScreenAuxiliary | stationary)` — visible on
//!      whichever desktop / full-screen app the user is on;
//!   3. `orderFrontRegardless()` — its very semantics are "order the window to the front whether or
//!      not the app is active", which is exactly this case (Tauri does not expose it);
//!   4. `NSApplication::activate()` (the modern activation API on macOS 14+, replacing the ignored
//!      `activateIgnoringOtherApps`); the implementation below still calls
//!      `activateIgnoringOtherApps(true)` under `#[allow(deprecated)]` to grab keyboard focus, so
//!      the search/input field accepts typing right away.
//!
//! Must be called on the **main thread** (a hard AppKit requirement): callers use
//! `WebviewWindow::run_on_main_thread`.

#[cfg(target_os = "macos")]
pub fn raise(window: &tauri::WebviewWindow) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSWindow, NSWindowCollectionBehavior};

    let Ok(ptr) = window.ns_window() else {
        eprintln!("[tray] raise: 取不到 ns_window");
        return;
    };
    if ptr.is_null() {
        return;
    }
    unsafe {
        // SAFETY: called from `run_on_main_thread`, and ptr comes from a window of this process
        let ns_window: &NSWindow = &*(ptr as *const NSWindow);
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary,
        );
        ns_window.orderFrontRegardless();
    }
    if let Some(mtm) = MainThreadMarker::new() {
        let app = NSApplication::sharedApplication(mtm);
        #[allow(deprecated)]
        app.activateIgnoringOtherApps(true);
    }
    eprintln!("[tray] raise: orderFrontRegardless + 集合行为已设（主线程）");
}

/// Non-macOS: no AppKit behavior available, so this is a no-op.
#[cfg(not(target_os = "macos"))]
pub fn raise(_window: &tauri::WebviewWindow) {
    crate::backend::log("raise: 非 macOS 平台，无操作");
}

/// Is the panel **actually visible to the user**? Reads `NSWindow.occlusionState`.
///
/// Why a separate function (2026-09-29): `WebviewWindow::is_visible()` lies — it returns `Ok(true)`
/// while the window is `onscreen=0` in `CGWindowListCopyWindowInfo` (buried behind another app's
/// windows) and not capturable by screenshot. `occlusionState` is AppKit's own answer to "is this
/// window occluded / on screen", which makes it a good monitoring point: read it after showing the
/// panel — if the `Visible` bit is absent, the panel came up but the user cannot see it.
#[cfg(target_os = "macos")]
pub fn is_occluded_or_hidden(window: &tauri::WebviewWindow) -> Option<bool> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSWindow, NSWindowOcclusionState};
    let _mtm = MainThreadMarker::new()?; // None off the main thread (reading it requires it)
    let ptr = window.ns_window().ok()?;
    if ptr.is_null() {
        return None;
    }
    let visible = unsafe {
        let ns_window: &NSWindow = &*(ptr as *const NSWindow);
        ns_window.occlusionState().contains(NSWindowOcclusionState::Visible)
    };
    Some(!visible)
}

#[cfg(not(target_os = "macos"))]
pub fn is_occluded_or_hidden(_window: &tauri::WebviewWindow) -> Option<bool> {
    None
}
