import React, { useEffect, useMemo, useRef, useState } from 'react'
import { tauriBridge, formatHotkey, isTauri, type MacApp } from '../tauriBridge'
import { capsules as vaultCapsulesApi, type VaultCapsule } from '../api'
import { fuzzyMatch } from '../searchUtils'
import { Icon } from './icons/Icon'
import { ToolIcon } from './icons/ToolIcon'
import { useI18n } from '../i18n'

export interface BuiltinToolItem {
  id: string
  name: string
  icon: string
  description: string
  keywords: string
  ready?: boolean
  status?: string
}

interface LauncherProps {
  builtinTools: BuiltinToolItem[]
  onSelectTool: (toolId: string, initialQuery?: string) => void
  onClose?: () => void
  isPinned: boolean
  onTogglePin: () => void
  apiError?: string
  /** Current global hotkey, e.g. "Option+Space" */
  hotkey: string
  /** Clicking the hotkey hint starts rebinding */
  onEditHotkey: () => void
  /** Open settings (gear button / searching "settings" / Cmd+,) */
  onOpenSettings: () => void
  /** Current light/dark appearance */
  theme?: string
  /** Toggle light/dark */
  onToggleTheme?: () => void
}

/** All of these jump straight to settings (Chinese, pinyin initials, English) */
const SETTINGS_QUERIES = ['设置', '设置面板', '偏好', '首选项', 'settings', 'preferences', 'shezhi', 'sz']

/** These jump to the desktop (dashboard is no longer in the tool list, so this row is its search entry) */
const DESKTOP_QUERIES = ['桌面', 'zhuomian', '主屏', 'desktop', 'home', '信息墙', 'wall']

type SearchItem =
  | {
      type: 'quick_action'
      id: string
      title: string
      subtitle: string
      icon: string
      action: () => void
    }
  | {
      type: 'builtin_tool'
      id: string
      title: string
      subtitle: string
      icon: string
      tool: BuiltinToolItem
      queryArg?: string
    }
  | {
      /** Library HTML capsule (.html found in capsules_dir; no manifest, see docs/vault-apps.md) */
      type: 'vault_capsule'
      id: string
      title: string
      subtitle: string
      /** Fallback icon name (capsule); draw `iconSrc` when available and fall back to this if it fails */
      icon: string
      /** Bookmark-style icon (data: / https: from the backend); nothing is drawn when absent */
      iconSrc?: string
      capsule: VaultCapsule
    }
  | {
      type: 'mac_app'
      id: string
      title: string
      subtitle: string
      icon?: string | null
      app: MacApp
    }

/**
 * Display name of an HTML capsule, same rule as a bookmark: use the file's `<title>`
 * when present (that is what a browser bookmark shows), else the filename without its
 * extension; `index.html` (one directory per capsule) uses the directory name so the list
 * does not fill up with rows all called "index". Display only — URLs always come from `url`.
 */
export function vaultCapsuleTitle(capsule: VaultCapsule): string {
  const named = (capsule.title || '').trim()
  if (named) return named
  const stem = capsule.name.replace(/\.(html|htm)$/i, '')
  if (stem.toLowerCase() === 'index') {
    const dir = capsule.relpath.split('/').slice(0, -1).pop()
    if (dir) return dir
  }
  return stem
}

export default function Launcher({
  builtinTools,
  onSelectTool,
  onClose,
  isPinned,
  onTogglePin,
  apiError,
  hotkey,
  onEditHotkey,
  onOpenSettings,
  theme,
  onToggleTheme,
}: LauncherProps) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [apps, setApps] = useState<MacApp[]>([])
  /** Library HTML capsules (`/api/capsules`, capsules_dir is auto-scanned: no manifest, just drop files in) */
  const [vaultCapsules, setVaultCapsules] = useState<VaultCapsule[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loadingApps, setLoadingApps] = useState(true)
  /** Human-readable error when opening a capsule fails (shown in the footer, list is kept) */
  const [openError, setOpenError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const list = await tauriBridge.getApps()
        if (active) {
          setApps(list)
          setLoadingApps(false)
        }
      } catch (e) {
        console.warn('failed to load Mac apps', e)
        if (active) setLoadingApps(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [])

  // Library HTML capsules: fetched once on mount, and re-scanned whenever the window regains
  // focus (= the hotkey re-activates the panel), so newly dropped files are searchable without
  // a restart. On failure (backend down / no capsules_dir) show "none" honestly: never block
  // search and never spam errors; the next focus tries again.
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await vaultCapsulesApi.list()
        if (alive) setVaultCapsules(res.capsules.filter((c) => c.enabled !== false))
      } catch (e) {
        console.warn('failed to load library capsules', e)
      }
    }
    void load()
    window.addEventListener('focus', load)
    return () => {
      alive = false
      window.removeEventListener('focus', load)
    }
  }, [])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // Build the result list from the query
  const { matchedItems } = useMemo(() => {
    const q = query.trim()
    const items: SearchItem[] = []

    // 0. Settings shortcut: settings / preferences / sz all hit it.
    if (q && SETTINGS_QUERIES.some((keyword) => keyword.includes(q.toLowerCase()))) {
      items.push({
        type: 'quick_action',
        id: 'action_settings',
        title: t('launcher.actionOpenSettings'),
        subtitle: t('launcher.actionOpenSettingsSubtitle'),
        icon: 'settings',
        action: () => onOpenSettings(),
      })
    }

    // 0.5 Desktop shortcut: dashboard left the visible tool list, so desktop is reached from here.
    if (q && DESKTOP_QUERIES.some((keyword) => keyword.includes(q.toLowerCase()))) {
      items.push({
        type: 'quick_action',
        id: 'action_desktop',
        title: t('launcher.actionOpenDesktop'),
        subtitle: t('launcher.actionOpenDesktopSubtitle'),
        icon: 'home',
        action: () => onSelectTool('dashboard'),
      })
    }

    // Built-in tools
    for (const tool of builtinTools) {
      if (fuzzyMatch(tool.name, q, tool.keywords + ' ' + tool.description)) {
        items.push({
          type: 'builtin_tool',
          id: `tool_${tool.id}`,
          title: tool.name,
          subtitle: `${tool.description} · ${tool.status ?? t('launcher.ready')}`,
          icon: tool.icon,
          tool,
        })
      }
    }

    // 3. Library HTML capsules (capsules_dir is auto-scanned: dropped in = appears, deleted = gone)
    for (const capsule of vaultCapsules) {
      const title = vaultCapsuleTitle(capsule)
      // Keywords = filename + path + bookmark title + page description (description words can match too).
      const keywords = `${capsule.name} ${capsule.relpath} ${capsule.url_path} ${capsule.title ?? ''} ${capsule.description ?? ''} html htm 胶囊 capsule`
      if (fuzzyMatch(title, q, keywords)) {
        items.push({
          type: 'vault_capsule',
          id: `vault_${capsule.relpath}`,
          title,
          subtitle: capsule.relpath,
          icon: 'capsule',
          iconSrc: capsule.icon || undefined,
          capsule,
        })
      }
    }

    // 4. Mac applications
    for (const app of apps) {
      const matchName = fuzzyMatch(app.display_name, q, app.name + ' ' + (app.bundle_id ?? ''))
      if (matchName) {
        items.push({
          type: 'mac_app',
          id: `app_${app.id}`,
          title: app.display_name,
          subtitle: app.path,
          icon: app.icon,
          app,
        })
      }
    }

    return { matchedItems: items }
  }, [query, builtinTools, vaultCapsules, apps, onSelectTool, onOpenSettings, t])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Keep the highlighted row inside the visible area
  useEffect(() => {
    if (!listRef.current) return
    const activeEl = listRef.current.querySelector<HTMLElement>('[data-selected="true"]')
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => (matchedItems.length ? (prev + 1) % matchedItems.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) =>
        matchedItems.length ? (prev - 1 + matchedItems.length) % matchedItems.length : 0,
      )
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = matchedItems[selectedIndex]
      if (item) {
        executeItem(item)
      } else {
        // No match + Enter lands on the desktop
        onSelectTool('dashboard')
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (query) {
        setQuery('')
      } else {
        onClose?.()
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
      e.preventDefault()
      onTogglePin()
    }
  }

  const executeItem = async (item: SearchItem) => {
    if (item.type === 'quick_action') {
      item.action()
    } else if (item.type === 'builtin_tool') {
      onSelectTool(item.tool.id, item.queryArg)
    } else if (item.type === 'mac_app') {
      await tauriBridge.launchApp(item.app.path)
    } else if (item.type === 'vault_capsule') {
      // Jump to the web page: on desktop the shell hands it to the **system browser** (only the
      // local backend's /capsules/ URL is allowed, since relative assets and PUT saves resolve
      // against it); in browser mode this already is a page, so open a same-origin new tab.
      try {
        if (isTauri()) {
          await tauriBridge.openCapsule(item.capsule.url)
        } else {
          window.open(item.capsule.url, '_blank', 'noopener,noreferrer')
        }
        setOpenError('')
      } catch (e) {
        setOpenError(e instanceof Error ? e.message : String(e))
      }
    }
  }

  return (
    <div
      className="ui-launcher flex flex-col h-full select-none overflow-hidden"
      data-launcher
    >
      {/* Top search bar: icon + input + actions. The whole strip is one input control, not a toolbar */}
      <div className="ui-launcher__bar">
        <Icon name="search" size={17} className="text-[var(--ink-text-3)] shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('launcher.searchPlaceholder')}
          aria-label={t('launcher.search')}
          className="ui-launcher__input"
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="ui-btn ui-btn--ghost ui-btn--sm"
            tabIndex={-1}
            aria-label={t('launcher.clearSearch')}
          >
            <Icon name="close" size={12} />
            {t('launcher.clear')}
          </button>
        )}
        <div className="flex items-center gap-1 border-l border-[var(--ink-line)] pl-2 ml-1">
          <button
            onClick={() => onSelectTool('dashboard')}
            title={t('launcher.backToWorkbench')}
            className="ui-btn ui-btn--ghost"
          >
            <Icon name="home" />
            <span>{t('launcher.workbench')}</span>
          </button>
          <button
            onClick={onTogglePin}
            aria-pressed={isPinned}
            title={isPinned ? t('launcher.pinnedTooltip') : t('launcher.pinTooltip')}
            className={`ui-btn ui-btn--ghost ${isPinned ? 'ui-btn--on' : ''}`}
          >
            <Icon name={isPinned ? 'pin' : 'pinOff'} />
            <span>{isPinned ? t('launcher.pinned') : t('launcher.pin')}</span>
          </button>
          {onToggleTheme && (
            <button
              onClick={onToggleTheme}
              title={theme === 'light' ? t('launcher.themeToDark') : t('launcher.themeToLight')}
              className="ui-btn ui-btn--ghost ui-btn--icon"
              aria-label={t('launcher.toggleTheme')}
            >
              <Icon name={theme === 'light' ? 'moon' : 'sun'} size={15} />
            </button>
          )}
          <button
            onClick={onOpenSettings}
            title={t('launcher.openSettingsTooltip')}
            className="ui-btn ui-btn--ghost ui-btn--icon"
            aria-label={t('launcher.openSettings')}
          >
            <Icon name="settings" />
          </button>
        </div>
      </div>

      <div ref={listRef} className="ui-launcher__list flex-1 overflow-y-auto p-2 space-y-0.5 min-h-[300px] max-h-[400px]">
        {matchedItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-[var(--ink-text-3)] text-sm gap-1">
            <Icon name="search" size={20} className="mb-1 opacity-60" />
            <span className="text-[var(--ink-text-2)]">
              {t('launcher.noResults', { query })}
            </span>
            <span className="ui-meta">{t('launcher.noResultsHint')}</span>
          </div>
        ) : (
          matchedItems.map((item, index) => {
            const isSelected = index === selectedIndex
            return (
              <div
                key={item.id}
                data-selected={isSelected}
                data-item-type={item.type}
                onClick={() => executeItem(item)}
                onMouseEnter={() => setSelectedIndex(index)}
                className={`ui-launcher__row ${isSelected ? 'is-selected' : ''}`}
              >
                <div className="ui-launcher__icon">
                  {item.type === 'mac_app' && item.icon ? (
                    <img src={item.icon} alt="" className="w-8 h-8 object-contain" />
                  ) : item.type === 'mac_app' ? (
                    <span className="text-sm font-semibold text-neutral-400">
                      {item.title.slice(0, 1).toUpperCase()}
                    </span>
                  ) : item.type === 'vault_capsule' ? (
                    // Bookmark-style icon (data: / https:) or a declared emoji label; ToolIcon draws
                    // both and falls back to the capsule glyph when an image fails to load.
                    <ToolIcon icon={item.iconSrc || item.icon} fallback="capsule" size={16} />
                  ) : (
                    <ToolIcon icon={item.icon} fallback="plugin" size={16} />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate text-[var(--ink-text)]">
                      {item.title}
                    </span>
                    {item.type === 'builtin_tool' && <span className="ui-badge">{t('launcher.badgeTool')}</span>}
                    {item.type === 'vault_capsule' && (
                      <span className="ui-badge ui-badge--identity">{t('launcher.badgeCapsule')}</span>
                    )}
                    {item.type === 'quick_action' && <span className="ui-badge">{t('launcher.badgeAction')}</span>}
                    {item.type === 'mac_app' && <span className="ui-badge">{t('launcher.badgeApp')}</span>}
                  </div>
                  <div className="ui-meta truncate mt-0.5">{item.subtitle}</div>
                </div>

                {isSelected && (
                  <div className="shrink-0 flex items-center gap-1.5 ui-meta">
                    <kbd className="ui-kbd">↵</kbd>
                    <span>{item.type === 'mac_app' ? t('launcher.launch') : t('launcher.open')}</span>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      <div className="ui-launcher__foot">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <kbd className="ui-kbd">↑↓</kbd> {t('launcher.navigate')}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="ui-kbd">↵</kbd> {t('launcher.open')}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="ui-kbd">Esc</kbd> {t('launcher.exit')}
          </span>
          <button
            onClick={() => onSelectTool('dashboard')}
            title={t('launcher.backToWorkbench')}
            className="flex items-center gap-1 hover:text-[var(--ink-text)] transition-colors"
          >
            <Icon name="home" size={12} />
            <span>{t('launcher.workbench')}</span>
          </button>
          <button
            onClick={onEditHotkey}
            title={t('launcher.editHotkeyTooltip')}
            className="flex items-center gap-1 hover:text-[var(--ink-text)] transition-colors"
          >
            <kbd className="ui-kbd">{formatHotkey(hotkey)}</kbd> {t('launcher.globalWake')}
          </button>
          <button
            onClick={onOpenSettings}
            title={t('launcher.openSettingsTooltip')}
            className="flex items-center gap-1 hover:text-[var(--ink-text)] transition-colors"
          >
            <kbd className="ui-kbd">⌘,</kbd> {t('launcher.settings')}
          </button>
        </div>
        <div className="flex items-center gap-3 min-w-0">
          {(apiError || openError) && (
            <span
              className="text-[var(--ink-warn-text)] truncate max-w-[300px] flex items-center gap-1"
              title={apiError || openError}
            >
              <Icon name="warning" size={12} />
              {apiError || openError}
            </span>
          )}
          <span className="truncate">
            {t('launcher.footerCounts', {
              tools: builtinTools.length,
              capsules: vaultCapsules.length,
            })}
            {loadingApps
              ? t('launcher.scanningApps')
              : t('launcher.macApps', { count: apps.length })}
          </span>
        </div>
      </div>
    </div>
  )
}
