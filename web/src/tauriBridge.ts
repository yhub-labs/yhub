import { invoke } from '@tauri-apps/api/core'

import { t } from './i18n'

export type MacApp = {
  id: string
  name: string
  display_name: string
  path: string
  icon?: string | null
  bundle_id?: string | null
}

export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

/**
 * Settings (stored in ~/.config/yhub/settings.json, read/written by tauri/src/config.rs).
 *
 * The UI only uses the surface exposed here, addressed by dotted paths (e.g. `tray.close_behavior`),
 * so adding a key never changes the IPC signature. Allowed values, the hotkey action table and the
 * defaults must come from `getSettingsSchema()` — never hardcode a second copy in the frontend
 * (the backend is the single source of truth).
 */
export type TraySettings = {
  /** On closing the main window: hide = hide only (process stays in the menu bar), quit = exit */
  close_behavior: string
  /** Tray icon left click: toggle_panel | show_menu | none */
  left_click: string
  /** Tray icon left double-click: toggle_panel | show_menu | none */
  double_click: string
  show_on_start: boolean
  show_notifications: boolean
}

export type Settings = {
  version: number
  /** action id → combo; an empty string means the action is unbound */
  hotkeys: Record<string, string>
  tray: TraySettings
  /** "Capsules in your library" directory: each .html inside it is one capsule (see docs/config.md) */
  capsules_dir: string
  /** per-capsule isolated origin (backend-owned; the shell does not read it) */
  capsules_subdomains?: boolean
  /** per-capsule overrides (backend-owned; the shell does not read it) */
  capsules_subdomains_overrides?: Record<string, boolean>
  /** plugin marketplace registry URL (backend-owned; the shell does not read it) */
  plugins_registry_url?: string
  /** plugin config section (open namespace) */
  plugins?: Record<string, Record<string, unknown>>
}

export type HotkeyActionDef = {
  id: string
  name: string
  default_combo: string
}

export type SettingsSchema = {
  version: number
  keys: string[]
  hotkey_actions: HotkeyActionDef[]
  tray_fields: string[]
  close_behaviors: string[]
  click_behaviors: string[]
  defaults: Settings
}

/**
 * Backend bridge status (returned by `backend_status` / `backend_ensure`; contract in
 * `tauri/src/backend.rs`). `source` says where the backend came from: reused (an existing
 * service) / external (YHUB_BACKEND_BIN) / installed (the installed yhub) / uv_run (source tree) /
 * none (not running).
 */
export type BackendStatus = {
  port: number
  running: boolean
  healthy: boolean
  source: string
  /** started by this app (gracefully shut down on exit); always false for a reused backend */
  owned: boolean
  pid: number | null
  bin: string | null
  version: string | null
  latency_ms: number | null
  started_at: number | null
  /** human-readable error (null when there is none) */
  error: string | null
  /** what to do about it */
  hint: string | null
  log_path: string
}

/** Result of the minimal connectivity check (`backend_health`): really calls /api/health and /api/tools */
export type BridgeHealth = {
  ok: boolean
  port: number
  source: string
  version: string | null
  /** tool count from /api/tools (proves the bridge carries real business data) */
  tools: number | null
  latency_ms: number
  log_path: string
  error: string | null
  hint: string | null
}

/** Hotkey string → macOS symbol form, e.g. "Option+Space" → "⌥ Space" */
export function formatHotkey(hotkey: string): string {
  const map: Record<string, string> = {
    option: '⌥',
    alt: '⌥',
    cmd: '⌘',
    command: '⌘',
    meta: '⌘',
    ctrl: '⌃',
    control: '⌃',
    shift: '⇧',
    space: 'Space',
    enter: '↩',
    return: '↩',
    esc: 'ESC',
    escape: 'ESC',
    tab: '⇥',
    backspace: '⌫',
  }
  return hotkey
    .split('+')
    .map((p) => map[p.trim().toLowerCase()] ?? p.trim())
    .join(' ')
}

export const tauriBridge = {
  getApps: async (): Promise<MacApp[]> => {
    if (!isTauri()) return []
    try {
      return await invoke<MacApp[]>('get_apps')
    } catch (e) {
      console.warn('failed to load Mac apps:', e)
      return []
    }
  },

  launchApp: async (path: string): Promise<void> => {
    if (!isTauri()) {
      alert(t('bridge.launchApp.desktopOnly'))
      return
    }
    await invoke('launch_app', { path })
  },

  setWindowMode: async (mode: 'search' | 'tool'): Promise<void> => {
    if (!isTauri()) return
    try {
      await invoke('set_window_mode', { mode })
    } catch (e) {
      console.warn('failed to set window mode:', e)
    }
  },

  setPinned: async (pinned: boolean): Promise<boolean> => {
    if (!isTauri()) return pinned
    try {
      return await invoke<boolean>('set_pinned', { pinned })
    } catch (e) {
      console.warn('failed to set pinned state:', e)
      return pinned
    }
  },

  hideWindow: async (): Promise<void> => {
    if (!isTauri()) return
    try {
      await invoke('hide_window')
    } catch (e) {
      console.warn('failed to hide window:', e)
    }
  },

  /** read the current global hotkey (default Option+Space) */
  getHotkey: async (): Promise<string> => {
    if (!isTauri()) return 'Option+Space'
    try {
      return await invoke<string>('get_hotkey')
    } catch (e) {
      console.warn('failed to read hotkey:', e)
      return 'Option+Space'
    }
  },

  /** update the global hotkey; throws on failure (including "already taken") and leaves the old hotkey in place */
  setHotkey: async (hotkey: string): Promise<string> => {
    if (!isTauri()) return hotkey
    return await invoke<string>('set_hotkey', { hotkey })
  },

  // ------------------------------------------------------------ settings (dotted paths)

  /** read all settings */
  getSettings: async (): Promise<Settings | null> => {
    if (!isTauri()) return null
    return await invoke<Settings>('get_settings')
  },

  /**
   * Write one setting: validate → persist → return the full settings after the write.
   * Passing `null` resets that key to its default; hotkeys are re-registered automatically (the
   * old value stays if that fails).
   */
  setSetting: async (key: string, value: unknown): Promise<Settings> => {
    if (!isTauri()) throw new Error(t('bridge.settings.desktopOnly'))
    return await invoke<Settings>('set_setting', { key, value })
  },

  /** reset to defaults: with a key only that key, without one everything */
  resetSettings: async (key?: string): Promise<Settings> => {
    if (!isTauri()) throw new Error(t('bridge.settings.desktopOnly'))
    return await invoke<Settings>('reset_settings', { key: key ?? null })
  },

  /**
   * Catalog for the settings UI: available keys, hotkey action table, tray options, defaults.
   * Forms and dropdowns render from it — never hardcode constants in the frontend.
   */
  getSettingsSchema: async (): Promise<SettingsSchema | null> => {
    if (!isTauri()) return null
    return await invoke<SettingsSchema>('get_settings_schema')
  },

  /** config file path (shown in the settings UI as "where the config lives"; also handy when debugging) */
  getSettingsPath: async (): Promise<string> => {
    if (!isTauri()) return ''
    return await invoke<string>('get_settings_path')
  },

  /**
   * Re-label shell-owned copy (the tray menu) after the UI language changed.
   *
   * `ui_language` is a backend-owned key: the settings page persists it through `/api/settings`, and the
   * shell refuses non-shell keys in `setSetting`, so the shell has to be told here. Returns the shell
   * language it now uses (`En` / `ZhCn`); `null` in browser mode (there is no tray to re-label).
   */
  refreshShellLanguage: async (): Promise<string | null> => {
    if (!isTauri()) return null
    return await invoke<string>('refresh_shell_language')
  },

  // ------------------------------------------------------------ library capsules (opened in the system browser)

  /**
   * Open a library capsule in the **system browser** (the bundled backend serves the original file,
   * relative assets work, and a PUT to the same address saves it back to disk). Returns the URL
   * handed to the browser so the UI can show / copy it.
   *
   * The argument is the full `url` from the `/api/capsules` list (e.g.
   * `http://127.0.0.1:8790/capsules/pinyin`) — the Rust command takes `url` and only allows
   * `/capsules/` addresses on the local backend; **do not pass `url_path`** (Tauri's invoke
   * resolves argument names in camelCase, so a wrong name fails as a missing key).
   * In the browser preview this throws: there is no system browser to open and we do not fake
   * success (the caller switches to window.open).
   */
  openCapsule: async (url: string): Promise<string> => {
    if (!isTauri()) throw new Error(t('bridge.openCapsule.desktopOnly'))
    return await invoke<string>('open_capsule', { url })
  },

  /**
   * Native directory picker (macOS "choose folder").
   * Returns an absolute path, or null if the user cancelled. The browser preview has no such
   * capability and returns null (the caller should disable the button).
   */
  pickDirectory: async (prompt?: string): Promise<string | null> => {
    if (!isTauri()) return null
    return await invoke<string | null>('pick_directory', { prompt: prompt ?? null })
  },

  /** reveal a directory in Finder (used only for "open folder"; no reads or writes) */
  revealPath: async (path: string): Promise<void> => {
    if (!isTauri()) throw new Error(t('bridge.reveal.desktopOnly'))
    await invoke('open_in_finder', { path })
  },

  // ------------------------------------------------------------ backend bridge (Python backend)

  /**
   * Backend bridge status: **probe only, never spawn** (glancing at settings should not start a
   * process). Failures do not throw (null is returned) and the UI renders as usual.
   */
  backendStatus: async (): Promise<BackendStatus | null> => {
    if (!isTauri()) return null
    try {
      return await invoke<BackendStatus>('backend_status')
    } catch (e) {
      console.warn('failed to read backend status:', e)
      return null
    }
  },

  /**
   * Bring the backend up on demand (reuse it if it is already running) and probe it.
   * A crashed backend does not require restarting the app: on failure api.ts calls this once and
   * retries the request. Spawning waits at most 20 seconds, so no timeout is set here — the UI
   * reports "checking…" honestly.
   */
  backendEnsure: async (): Promise<BackendStatus | null> => {
    if (!isTauri()) return null
    try {
      return await invoke<BackendStatus>('backend_ensure')
    } catch (e) {
      console.warn('failed to start backend:', e)
      return null
    }
  },

  /**
   * Minimal connectivity check: ensure the backend is running, then really call `/api/health` and
   * `/api/tools`. When ok=false, error/hint are the human-readable cause and remedy (nothing is
   * thrown).
   */
  backendHealth: async (): Promise<BridgeHealth | null> => {
    if (!isTauri()) return null
    try {
      return await invoke<BridgeHealth>('backend_health')
    } catch (e) {
      console.warn('backend health check failed:', e)
      return null
    }
  },

  /**
   * Open the wall web page in the default system browser
   * (`http://127.0.0.1:8790/?view=wall`, which serves only the standalone wall page).
   * Desktop: the Rust side first ensures the backend is running before handing off to the browser
   * (so it opens even if the backend crashed or was stopped); failures throw a human-readable
   * error. Browser preview: this page already is that page, so open a same-origin new tab.
   * Returns the URL actually opened.
   */
  openDashboardWeb: async (): Promise<string> => {
    if (!isTauri()) {
      const url = `${window.location.origin}/?view=wall`
      window.open(url, '_blank', 'noopener,noreferrer')
      return url
    }
    return await invoke<string>('open_dashboard_web')
  },

  /** read the log tail: kind = 'backend' (Python tracebacks live here) | 'desktop' */
  backendLogTail: async (kind: 'backend' | 'desktop' = 'backend', lines = 80): Promise<string> => {
    if (!isTauri()) return ''
    try {
      return await invoke<string>('backend_log_tail', { kind, lines })
    } catch (e) {
      console.warn('failed to read logs:', e)
      return ''
    }
  },
}
