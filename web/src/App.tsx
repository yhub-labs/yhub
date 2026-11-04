import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { api, ApiError, pluginConfigs, type PluginConfigTool, type Tool } from './api'
import { tauriBridge, formatHotkey, isTauri } from './tauriBridge'
import Launcher, { type BuiltinToolItem } from './components/Launcher'
import Rclone from './components/Rclone'
import Dashboard from './components/Dashboard'
import Scheduler from './components/Scheduler'
import Rss from './components/Rss'
import Settings from './components/Settings'
import { CardState } from './components/Card'
import { cardSpec, statusTone } from './components/cardRegistry'
import { Icon } from './components/icons/Icon'
import { ToolIcon } from './components/icons/ToolIcon'
import { StatusDot } from './components/icons/status'
import type { WallCustomize } from './components/Dashboard'
import {
  DEFAULT_PREFS,
  loadPrefs,
  savePrefs,
  type CardSize,
  type PanelPrefs,
  type ThemeMode,
} from './panelPrefs'
import { t, useI18n } from './i18n'

// The host has three views: search launcher / tool workbench / settings
type ViewMode = 'launcher' | 'workbench' | 'settings'

// The workbench is "sidebar = tabs, one tool per page": only the current tool is mounted, so
// switching in the sidebar is a real page change (not scrolling a long page).
// The bento layout does not live here — it belongs to the wall module (cells laid out as a grid,
// see components/Dashboard.tsx).

// Tools with a dedicated panel; the rest (a tool entry but no panel) get a one-line explanation
// in the content area — a panel is a frontend component, and while the backend auto-discovers new
// adapters, someone still has to write that screen.
const PANEL_TOOLS = ['rclone', 'dashboard', 'scheduler', 'rss']

// Each tool's title/icon is registered in components/cardRegistry.ts (that list doubles as the
// panel-component inventory) — the tool page header and the deep-link fallback both read it.
// Order = the /api/tools return order (adapters are scanned in directory-entry order, **not**
// alphabetical; measured: dashboard → rclone → rss → scheduler).

// Launcher search keywords per tool id. Resolved through t() at render time (never frozen at
// module scope), so a language switch is picked up on the next render.
function toolKeywords(id: string): string | undefined {
  switch (id) {
    case 'rclone':
      return t('app.keywords.rclone')
    case 'dashboard':
      return t('app.keywords.dashboard')
    case 'scheduler':
      return t('app.keywords.scheduler')
    default:
      return undefined
  }
}

export default function App() {
  const { t } = useI18n()
  const pathname = window.location.pathname
  const appMatch = pathname.match(/^\/apps\/([a-zA-Z0-9_-]+)/)
  const isSettingsPath = pathname === '/settings'

  const params = new URLSearchParams(window.location.search)
  const queryTool = appMatch ? appMatch[1] : params.get('tool')
  const initialView = isSettingsPath ? 'settings' : params.get('view')
  const initialSection = params.get('section') ?? undefined

  // In the Tauri desktop shell, no arguments means the launcher search state; on a plain web page
  // the default is the workbench. Path routing: /apps/<id>, /settings, plus
  // /?tool=rclone&q=…, /?view=settings&section=hotkeys and /?view=wall.
  const [viewMode, setViewMode] = useState<ViewMode>(
    initialView === 'settings'
      ? 'settings'
      : queryTool
        ? 'workbench'
        : isTauri()
          ? 'launcher'
          : 'workbench',
  )
  const [settingsSection, setSettingsSection] = useState(initialSection ?? 'general')
  // Remember which view the settings page was entered from so "back" returns there
  // (launcher ↔ workbench ↔ settings)
  const settingsReturnView = useRef<'launcher' | 'workbench'>('workbench')

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (initialView === 'wall') return true
    try {
      return localStorage.getItem('yhub_sidebar_collapsed') === 'true'
    } catch {
      return false
    }
  })

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem('yhub_sidebar_collapsed', String(next))
      } catch {
        // ignore storage error
      }
      return next
    })
  }, [])

  const [tools, setTools] = useState<Tool[]>([])
  /** Plugin declarations (/api/plugins): the desktop widget library uses them to attribute "which cell belongs to which app" (the tiles field) */
  const [plugins, setPlugins] = useState<PluginConfigTool[]>([])
  // Default landing spot without a deep link = the desktop. Deep links
  // like /apps/<id> still go straight to their target.
  const [active, setActive] = useState(queryTool ?? 'dashboard')
  const [error, setError] = useState('')
  /** The error's "what to do" (ApiError.hint): the next step suggested when the backend is down or stuck */
  const [errorHint, setErrorHint] = useState('')
  const [isPinned, setIsPinned] = useState(false)
  const [hotkey, setHotkey] = useState('Option+Space')
  const [hotkeyError, setHotkeyError] = useState('')
  // Panel customizations (theme / card sizes / visibility): read back from localStorage before the
  // first render. Unreadable or corrupt data falls back to the factory defaults — which are the
  // bento baseline layout, not a pixel off.
  const [prefs, setPrefs] = useState<PanelPrefs>(() => loadPrefs())
  const [customizeOpen, setCustomizeOpen] = useState(false)
  /**
   * Desktop edit mode (like "edit home screen" on a phone) — deliberately **separate** from the
   * "customize" popover:
   *   * edit mode = items can be dragged, added and removed (handles and the widget library appear
   *     on the wall), and no popover blocks the wall;
   *   * customize popover = settings panel for appearance and per-cell size, an overlay.
   * Merging the two into one switch was tried earlier: the popover covered the wall and swallowed
   * every click on the handles (measured).
   */
  const [editMode, setEditMode] = useState(false)

  // Theme goes on <html>: the light-mode tokens and the "dark utility → light surface" bridge both
  // live in theme-light.css. useLayoutEffect keeps it in place before paint, so a light preference
  // never flashes dark first.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = prefs.theme
  }, [prefs.theme])

  // Persist prefs to localStorage (also on first mount: turns "no storage" into explicit defaults)
  useEffect(() => {
    savePrefs(prefs)
  }, [prefs])

  // Load the current hotkey from the shell
  useEffect(() => {
    let active = true
    void tauriBridge.getHotkey().then((hk) => {
      if (active) setHotkey(hk)
    })
    return () => {
      active = false
    }
  }, [])

  // Change the hotkey: prompt for input → ask the Rust side to register it (on failure the old
  // hotkey stays and the user is told)
  const editHotkey = async () => {
    const next = window.prompt(
      t('app.hotkeyPrompt'),
      hotkey,
    )
    if (!next || next.trim() === hotkey) return
    try {
      const saved = await tauriBridge.setHotkey(next.trim())
      setHotkey(saved)
      setHotkeyError('')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setHotkeyError(msg)
      window.alert(t('app.hotkeySetFailed', { message: msg, hotkey }))
    }
  }

  const refresh = useCallback(async () => {
    try {
      const res = await api.tools()
      setTools(res.tools)
      // Plugin declarations (which plugin produces which cells): only used for widget-library
      // grouping. best-effort — if it cannot be read, group by id prefix instead; that must not
      // fail the tool list too.
      try {
        setPlugins((await pluginConfigs.list()).plugins)
      } catch {
        /* widget-library grouping degrades; other views are unaffected */
      }
      setError('')
      setErrorHint('')
      return true
    } catch (e) {
      // ApiError's hint is the "what to do" (the next step when the backend is down or stuck);
      // show it next to the message
      setError(e instanceof Error ? e.message : String(e))
      setErrorHint(e instanceof ApiError ? e.hint : '')
      return false
    }
  }, [])

  // The desktop shell has a cold-start race: Rust spawns the backend on a background thread
  // (uvicorn needs 2–4s to listen) while the webview loads immediately → the first request is
  // refused. Retry a few times in the background instead of reporting "backend still starting" as
  // an error. The browser build has no such race (the backend is started externally), so no retry.
  useEffect(() => {
    let cancelled = false
    const attempt = async (left: number) => {
      if (cancelled) return
      const ok = await refresh()
      if (!ok && !cancelled && left > 0) {
        setTimeout(() => void attempt(left - 1), 700)
      }
    }
    void attempt(isTauri() ? 8 : 0)
    return () => {
      cancelled = true
    }
  }, [refresh])

  // Sync the window mode on view changes (the settings view keeps workbench dimensions)
  useEffect(() => {
    if (isTauri()) {
      if (viewMode === 'launcher') {
        void tauriBridge.setWindowMode('search')
      } else {
        void tauriBridge.setWindowMode('tool')
      }
    }
  }, [viewMode])

  // View ↔ URL: the settings page is addressable (?view=settings&section=hotkeys) and a standalone
  // page's view parameter must survive (otherwise a browser refresh drops back to the workbench —
  // fatal for the second-screen page); other views clear these params.
  // If the URL cannot be changed (custom protocol), skip silently; view state still works.
  useEffect(() => {
    try {
      const url = new URL(window.location.href)
      if (viewMode === 'settings') {
        url.searchParams.set('view', 'settings')
        url.searchParams.set('section', settingsSection)
      } else {
        url.searchParams.delete('view')
        url.searchParams.delete('section')
      }
      window.history.replaceState(null, '', url.toString())
    } catch {
      /* ignore */
    }
  }, [viewMode, settingsSection])

  const togglePin = async () => {
    const next = !isPinned
    setIsPinned(next)
    await tauriBridge.setPinned(next)
  }

  // —— Panel customization: theme / cell size / cell visibility (all localStorage only; the backend
  // knows nothing about it) ——
  // Size and visibility keys are **wall cell ids** (the bento layout only serves that wall); theme
  // is global.
  const setTheme = (theme: ThemeMode) => setPrefs((p) => ({ ...p, theme }))

  /**
   * Record a size preference for one cell. `null` = clear it (back to "height follows content").
   * Presence of the entry is the test for "the user has chosen a size": present = respect it,
   * absent = auto height.
   */
  const setCardSize = (id: string, size: CardSize | null) =>
    setPrefs((p) => {
      const sizes = { ...p.sizes }
      if (size) sizes[id] = size
      else delete sizes[id]
      return { ...p, sizes }
    })

  /**
   * Toggle whether a widget is on the desktop (`hidden`).
   *
   * **This must use a functional update**: `removeToLibrary` / `addFromLibrary` write `layout` and
   * then `hidden` within the same frame. Reading the closed-over `prefs` and calling
   * `setPrefs({...prefs, hidden})` would overwrite the layout written just before with the **old
   * snapshot** (measured: layout keys became 0, removing one widget reflowed the whole wall).
   */
  const toggleCardHidden = (id: string) =>
    setPrefs((p) => ({
      ...p,
      hidden: p.hidden.includes(id)
        ? p.hidden.filter((x) => x !== id)
        : [...p.hidden, id],
    }))

  const resetPrefs = () => {
    setPrefs(DEFAULT_PREFS)
    setCustomizeOpen(false)
  }

  /** Handed to the wall header's controls (App owns the state: the theme must land on <html data-theme>, so it has to live at the outermost level) */
  const wallCustomize: WallCustomize = {
    prefs,
    editMode,
    setEditMode,
    open: customizeOpen,
    setOpen: setCustomizeOpen,
    onTheme: setTheme,
    onSize: setCardSize,
    onToggleHidden: toggleCardHidden,
    onReset: resetPrefs,
    // Phase C: layout and folders go through the same prefs pipeline (localStorage; the backend
    // knows nothing about it)
    onLayout: (layout) => setPrefs((p) => ({ ...p, layout })),
    onFolders: (folders) => setPrefs((p) => ({ ...p, folders })),
    // P2: packing mode (compact/free) — same lifecycle as layout, "reset" returns to compact too
    onPacking: (packing) => setPrefs((p) => ({ ...p, packing })),
  }

  const handleSelectTool = (toolId: string, queryArg?: string) => {
    setActive(toolId)
    setViewMode('workbench')
    if (toolId !== 'dashboard') {
      window.history.pushState({}, '', `/apps/${toolId}${queryArg ? `?q=${encodeURIComponent(queryArg)}` : ''}`)
    } else {
      window.history.pushState({}, '', '/')
    }
    if (isTauri()) {
      void tauriBridge.setWindowMode('tool')
    }
  }

  const handleBackToLauncher = () => {
    setViewMode('launcher')
    window.history.pushState({}, '', '/')
    if (isTauri()) {
      void tauriBridge.setWindowMode('search')
    }
  }

  // Open settings (remembering the source view so "back" returns there); passing a section jumps
  // straight to it
  const openSettings = useCallback((section?: string) => {
    if (section) setSettingsSection(section)
    setViewMode((current) => {
      if (current !== 'settings') {
        settingsReturnView.current = current === 'launcher' ? 'launcher' : 'workbench'
      }
      return 'settings'
    })
    window.history.pushState({}, '', section ? `/settings?section=${encodeURIComponent(section)}` : '/settings')
  }, [])

  // Return from settings to the source view (window sizing is synced by the viewMode effect above)
  const closeSettings = useCallback(() => {
    setViewMode(settingsReturnView.current)
    window.history.pushState({}, '', '/')
    // The settings page can install / remove / enable / disable plugins, and the sidebar + launcher
    // render `/api/tools`: re-read it on the way back, otherwise the workbench still lists a plugin
    // that is no longer there (the backend has already rebuilt its registry).
    void refresh()
  }, [refresh])

  // "Settings…" in the tray menu: the Rust side emits 'yhub:open-settings' with a section id after
  // show_panel, and this switches the panel to the settings view (the ?view=settings deep link is
  // the other path, meant for external scripts).
  // The event payload is the section id; unknown ids fall back to the first section in the Settings
  // shell.
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    void listen<string>('yhub:open-settings', (event) => {
      openSettings(event.payload || undefined)
    })
      .then((stop) => {
        if (cancelled) stop()
        else unlisten = stop
      })
      .catch((e) => console.warn('failed to subscribe to tray settings events:', e))
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [openSettings])

  // Keyboard shortcuts: Cmd+P toggles pin, Cmd+K brings up search, Cmd+, opens settings, ESC goes
  // back / exits.
  //
  // Input controls inside a settings section (e.g. hotkey recording) can claim a key by calling
  // preventDefault() on the event — this handler skips an already-handled ESC so it does not get in
  // the way.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        void togglePin()
      } else if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        toggleSidebar()
      } else if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        openSettings()
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (viewMode === 'launcher') {
          handleBackToLauncher()
        } else {
          setViewMode('launcher')
        }
      } else if (e.key === 'Escape') {
        // While edit mode is on, ESC only leaves edit mode — don't also drop the workbench back to
        // the launcher
        if (editMode) {
          e.preventDefault()
          setEditMode(false)
        } else if (customizeOpen) {
          e.preventDefault()
          setCustomizeOpen(false)
        } else if (viewMode === 'settings') {
          const target = e.target as HTMLElement | null
          const editing =
            !!target &&
            (target.tagName === 'INPUT' ||
              target.tagName === 'TEXTAREA' ||
              target.isContentEditable)
          if (!e.defaultPrevented && !editing) {
            e.preventDefault()
            closeSettings()
          }
        } else if (viewMode === 'workbench') {
          e.preventDefault()
          handleBackToLauncher()
        } else if (viewMode === 'launcher' && isTauri()) {
          e.preventDefault()
          void tauriBridge.hideWindow()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [viewMode, isPinned, customizeOpen, editMode, openSettings, closeSettings, toggleSidebar])

  // The bento overview form has moved entirely into the wall module (see components/Dashboard.tsx):
  // there is no grid branch here anymore; the workbench is always "one tool per page".

  const builtinToolItems: BuiltinToolItem[] = tools
    // §9-2 / D2: dashboard is retired from the visible list — the desktop is reached via the
    // sidebar's "🏠 Desktop" and the launcher's "open desktop" entry
    .filter((tool) => tool.id !== 'dashboard')
    .map((tool) => ({
    id: tool.id,
    name: tool.name,
    icon: tool.icon,
    description: tool.description,
    keywords: toolKeywords(tool.id) ?? tool.keywords ?? tool.name,
    ready: tool.ready,
    status: tool.status,
  }))

  const current = tools.find((t) => t.id === active)

  // Deep-linking to a panel that is not in /api/tools (the wall) leaves current undefined — fall
  // back to the card registry for the header title/icon so the h1 is never empty (same copy as the
  // card header).
  const activeSpec = cardSpec(active)

  // Launcher search view
  if (viewMode === 'launcher') {
    return (
      <div className="w-full h-full p-2 bg-transparent">
        <Launcher
          builtinTools={builtinToolItems}
          onSelectTool={handleSelectTool}
          onClose={() => {
            if (isTauri()) {
              void tauriBridge.hideWindow()
            } else {
              // §9-1: the default landing spot when ESC exits the launcher = the desktop
              setActive('dashboard')
              setViewMode('workbench')
            }
          }}
          isPinned={isPinned}
          onTogglePin={togglePin}
          apiError={error || hotkeyError}
          hotkey={hotkey}
          onEditHotkey={() => void editHotkey()}
          onOpenSettings={openSettings}
          theme={prefs.theme}
          onToggleTheme={() => setTheme(prefs.theme === 'dark' ? 'light' : 'dark')}
        />
      </div>
    )
  }

  // Settings view: category nav on the left, section content area on the right (ESC or the
  // top-left "back" button returns to the previous screen)
  if (viewMode === 'settings') {
    return (
      <Settings
        initialSection={settingsSection}
        onSectionChange={setSettingsSection}
        onBack={closeSettings}
        backLabel={
          settingsReturnView.current === 'launcher'
            ? t('app.backToLauncher')
            : t('app.backToWorkbench')
        }
      />
    )
  }

  // Tool workbench mode (desktop by default: the wall's bento grid; the sidebar can be collapsed
  // for the full-screen wall)
  return (
    <div
      className={`ui-shell ${sidebarCollapsed ? 'ui-shell--collapsed-sidebar' : ''}`}
      data-workbench
    >
      {/* Sidebar: brand / quick entries / tool nav / status footer. Not mounted when collapsed — the whole page goes to the wall. */}
      {!sidebarCollapsed && (
        <aside className="ui-sidebar" aria-label={t('app.navMain')}>
        <div className="ui-sidebar__brand flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <img src="/favicon.svg" alt="" className="ui-sidebar__mark shrink-0" />
            <span className="ui-sidebar__name truncate">Y-Hub</span>
          </div>
          <button
            type="button"
            onClick={toggleSidebar}
            className="ui-btn ui-btn--ghost ui-btn--icon text-[var(--ink-text-3)] hover:text-[var(--ink-text)] shrink-0"
            title={t('app.collapseSidebarTooltip')}
            aria-label={t('app.collapseSidebar')}
          >
            <Icon name="sidebar" size={15} />
          </button>
        </div>

        <div className="ui-sidebar__body">
          <div className="space-y-0.5 pb-2">
            <button
              onClick={handleBackToLauncher}
              className="ui-nav__item"
              title={t('app.searchTooltip')}
            >
              <Icon name="search" className="ui-nav__icon" />
              <span className="ui-nav__label">{t('app.search')}</span>
              <kbd className="ui-kbd ui-nav__kbd">Esc</kbd>
            </button>
            <button
              onClick={() => openSettings()}
              className="ui-nav__item"
              title={t('app.settingsTooltip')}
            >
              <Icon name="settings" className="ui-nav__icon" />
              <span className="ui-nav__label">{t('app.settings')}</span>
              <kbd className="ui-kbd ui-nav__kbd">⌘,</kbd>
            </button>
          </div>

          <div className="border-t border-[var(--ink-line)] pt-2 space-y-0.5">
            <button
              data-nav-desktop
              onClick={() => setActive('dashboard')}
              aria-current={active === 'dashboard' ? 'page' : undefined}
              title={t('app.desktopTooltip')}
              className="ui-nav__item"
            >
              <Icon name="home" className="ui-nav__icon" />
              <span className="ui-nav__label">{t('app.desktop')}</span>
            </button>
          </div>

          <nav className="pt-2" aria-label={t('app.tools')}>
            <div className="ui-nav__group">{t('app.tools')}</div>
            <div className="space-y-0.5">
              {tools
                .filter((tool) => tool.id !== 'dashboard')
                .map((tool) => {
                  const tone = statusTone(tool.ready, tool.status)
                  return (
                    <button
                      key={tool.id}
                      onClick={() => setActive(tool.id)}
                      aria-current={active === tool.id ? 'page' : undefined}
                      title={`${tool.name} · ${tool.status}`}
                      className="ui-nav__item"
                    >
                      <ToolIcon icon={tool.icon} fallback="plugin" size={16} />
                      <span className="ui-nav__label">{tool.name}</span>
                      <StatusDot tone={tone === 'ok' ? 'ok' : 'warn'} title={tool.status} />
                    </button>
                  )
                })}
              {tools.length === 0 && !error && (
                <div className="ui-meta px-2 py-2 hidden md:block">{t('app.connecting')}</div>
              )}
            </div>
          </nav>
        </div>

        <div className="ui-sidebar__foot">
          {error ? (
            <span className="text-[var(--ink-warn-text)]">{t('app.backendDisconnected')}</span>
          ) : (
            <span className="ui-mono">127.0.0.1:8790</span>
          )}
          <span className="ui-mono" title={t('app.hotkeyTooltip')}>
            {formatHotkey(hotkey)}
          </span>
        </div>
      </aside>
      )}

      <main
        className="ui-main"
        data-wall-page={sidebarCollapsed && active === 'dashboard' ? '' : undefined}
      >
        <header className="ui-pagehead">
          {sidebarCollapsed && (
            <button
              type="button"
              onClick={toggleSidebar}
              className="ui-btn ui-btn--ghost ui-btn--icon -ml-1 mr-2 shrink-0 text-[var(--ink-text-3)] hover:text-[var(--ink-text)]"
              title={t('app.expandSidebarTooltip')}
              aria-label={t('app.expandSidebar')}
            >
              <Icon name="sidebar" size={16} />
            </button>
          )}
          <h1 className="ui-pagehead__title">
            <ToolIcon
              icon={current ? current.icon : undefined}
              fallback="plugin"
              size={16}
              className="ui-pagehead__icon"
            />
            <span>{activeSpec.title ?? current?.name ?? t('app.workbench')}</span>
          </h1>
          <span className="ui-pagehead__desc hidden md:block">
            {current?.description ?? (active === 'dashboard' ? t('app.dashboardDescription') : '')}
          </span>
          {current && (
            <span
              className={`ui-badge shrink-0 ui-badge--${statusTone(current.ready, current.status) === 'ok' ? 'ok' : 'warn'}`}
              title={current.status}
            >
              <StatusDot tone={statusTone(current.ready, current.status) === 'ok' ? 'ok' : 'warn'} />
              <span className="max-w-[14em] truncate">{current.status}</span>
            </span>
          )}

          <div className="ui-pagehead__actions">
            {/* Theme toggle: day / night */}
            <button
              onClick={() => setTheme(prefs.theme === 'dark' ? 'light' : 'dark')}
              className="ui-btn ui-btn--ghost ui-btn--icon"
              title={prefs.theme === 'dark' ? t('app.themeToLight') : t('app.themeToDark')}
              aria-label={t('app.toggleTheme')}
            >
              <Icon name={prefs.theme === 'dark' ? 'sun' : 'moon'} size={15} />
            </button>

            {/* Pin: a pinned window does not hide on focus loss ("stick to the desktop" in the shell) */}
            <button
              onClick={togglePin}
              aria-pressed={isPinned}
              title={isPinned ? t('app.pinnedTooltip') : t('app.pinTooltip')}
              className={`ui-btn ui-btn--ghost hidden md:inline-flex ${isPinned ? 'ui-btn--on' : ''}`}
            >
              <Icon name={isPinned ? 'pin' : 'pinOff'} />
              <span>{isPinned ? t('app.pinned') : t('app.pin')}</span>
            </button>

            <button
              onClick={handleBackToLauncher}
              className="ui-btn ui-btn--ghost"
              title={t('app.backToLauncherTooltip')}
            >
              <Icon name="search" />
              <span>{t('app.launcher')}</span>
            </button>

            {isTauri() && (
              <button
                onClick={() => tauriBridge.hideWindow()}
                className="ui-btn ui-btn--ghost ui-btn--icon"
                title={t('app.hideWindow')}
                aria-label={t('app.hideWindow')}
              >
                <Icon name="close" />
              </button>
            )}
          </div>
        </header>

        {error && (
          <div className="px-4 md:px-6 pt-4 md:pt-5">
            <CardState
              kind="error"
              hint={
                errorHint || (
                  <>
                    {t('app.backendHint')}
                    <code className="font-mono">uv run yhub gui</code>
                  </>
                )
              }
            >
              {error}
            </CardState>
          </div>
        )}

        {/* Tool page: the sidebar is tabs and only the current tool is mounted — changing pages is a
            page change, not scrolling to another spot on one long page. Show a placeholder until the
            tool list arrives (the desktop shell's cold start has not listened yet; don't make the
            tool panel hit that race itself). The bento grid only exists on the wall page (Dashboard
            lays it out). */}
        <section className="tool-page" data-tool-page={active}>
          {tools.length === 0 && !error ? (
            <CardState kind="loading">{t('app.connectingLong')}</CardState>
          ) : (
            <>
              {active === 'rclone' && <Rclone onStatusChange={refresh} />}
              {active === 'dashboard' && (
                <Dashboard
                  customize={wallCustomize}
                  tools={tools}
                  plugins={plugins}
                  onOpenTool={handleSelectTool}
                />
              )}
              {active === 'scheduler' && <Scheduler />}
              {active === 'rss' && <Rss />}
              {/* The backend auto-discovers new adapters, but someone must write each screen: tools without a panel say so here */}
              {!PANEL_TOOLS.includes(active) && <CardState kind="empty">{t('app.noPanel')}</CardState>}
            </>
          )}
        </section>
      </main>
    </div>
  )
}
