// Settings shell: category nav on the left, content container on the right (Obsidian-style groups:
// core settings / extensions / app config).
//
// Responsibilities:
//   - The shell owns "read settings / write settings / notifications / routing"; a section only owns
//     its own rows of UI (see settings/shared.tsx).
//   - Two channels: the desktop app goes through tauriBridge IPC, the plain web build goes through
//     the backend HTTP API (/api/settings) — both behave the same.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  isTauri,
  tauriBridge,
  type BackendStatus,
  type BridgeHealth,
  type Settings as SettingsDoc,
  type SettingsSchema,
} from '../tauriBridge'
import {
  pluginConfigs,
  settings as apiSettings,
  type PluginConfigTool,
} from '../api'
import { BASE_SETTINGS_SECTIONS } from './settings/registry'
import { useI18n } from '../i18n'
import { Icon } from './icons/Icon'
import { ToolIcon } from './icons/ToolIcon'
import AppConfigSection from './settings/AppConfigSection'
import type { BackendBridge, SettingsSection, SettingsSectionProps, WriteResult } from './settings/shared'

type Props = {
  /** Initial section (for the ?section= deep link) */
  initialSection?: string
  /** Go back to the previous view (workbench / launcher) */
  onBack: () => void
  /** Back button label, follows the source view */
  backLabel?: string
  /** Notify the host on section change (the host writes it into the URL so deep links work) */
  onSectionChange?: (id: string) => void
}

type Toast = { message: string; kind: 'info' | 'error' }

// The shell owns only the startup-critical hotkeys and tray; every other key (capsules_* / plugins /
// …) is owned by the backend's /api/settings.
const isShellKey = (key?: string): boolean =>
  !!key && (key === 'hotkeys' || key.startsWith('hotkeys.') || key === 'tray' || key.startsWith('tray.'))

/** Backend settings + the shell's hotkeys/tray (shell values win) */
function mergeShell(backend: SettingsDoc, shell: SettingsDoc | null): SettingsDoc {
  return {
    ...backend,
    hotkeys: shell?.hotkeys ?? backend.hotkeys,
    tray: shell?.tray ?? backend.tray,
  }
}

export default function Settings({
  initialSection,
  onBack,
  backLabel,
  onSectionChange,
}: Props) {
  const { t } = useI18n()
  const backText = backLabel ?? t('settings.back')
  const [activeId, setActiveId] = useState(initialSection || 'general')
  const [settings, setSettings] = useState<SettingsDoc | null>(null)
  const [schema, setSchema] = useState<SettingsSchema | null>(null)
  const [settingsPath, setSettingsPath] = useState('')
  const [pluginTools, setPluginTools] = useState<PluginConfigTool[]>([])
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  // Backend bridge (Python backend): the shell does the invoke, sections only render (see hard rule 3
  // in settings/shared.tsx)
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null)
  const [backendHealth, setBackendHealth] = useState<BridgeHealth | null>(null)
  const [backendBusy, setBackendBusy] = useState(false)
  const [backendError, setBackendError] = useState('')

  const desktop = isTauri()

  const notify = useCallback((message: string, kind: 'info' | 'error' = 'info') => {
    setToast({ message, kind })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), kind === 'error' ? 6000 : 2600)
  }, [])

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  /** Re-read all settings (opening settings, an external config edit and the "re-read" button all go through it) — dual-channel aware */
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      if (isTauri()) {
        // The shell only reads its own keys; everything else comes from the backend's /api/settings
        // (single source of truth).
        const [shell, path] = await Promise.all([
          tauriBridge.getSettings(),
          tauriBridge.getSettingsPath(),
        ])
        setSettingsPath(path)
        try {
          const httpRes = await apiSettings.read()
          setSettings(mergeShell(httpRes.settings as unknown as SettingsDoc, shell))
          setSchema(httpRes.schema as unknown as SettingsSchema)
        } catch (e) {
          // If the backend is down, still show the shell's own hotkey/tray settings (and keep the
          // error visible)
          setSettings(shell)
          setSchema(await tauriBridge.getSettingsSchema())
          throw e
        }
      } else {
        const httpRes = await apiSettings.read()
        setSettings(httpRes.settings as unknown as SettingsDoc)
        setSchema(httpRes.schema as unknown as SettingsSchema)
        setSettingsPath(httpRes.path)
      }

      // Apps/plugins that declare config fields
      try {
        const pList = await pluginConfigs.list()
        setPluginTools(pList.plugins)
      } catch {
        // failing to load plugin configs does not affect core settings
      }

      setLoadError('')
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  /** Backend bridge status: probe only when settings opens (backend_status, never spawn a process) */
  const refreshBackendStatus = useCallback(async () => {
    if (!isTauri()) return
    const status = await tauriBridge.backendStatus()
    setBackendStatus(status)
  }, [])

  const refreshBackendHealth = useCallback(async () => {
    if (!isTauri()) return
    setBackendBusy(true)
    try {
      const health = await tauriBridge.backendHealth()
      setBackendHealth(health)
      setBackendError(health ? '' : t('settings.backend.ipcError'))
      if (health && !health.ok) notify(health.error ?? t('settings.backend.checkFailed'), 'error')
    } finally {
      setBackendBusy(false)
      void refreshBackendStatus()
    }
  }, [notify, refreshBackendStatus, t])

  useEffect(() => {
    void refreshBackendStatus()
  }, [refreshBackendStatus])

  /** Write one key: two channels (desktop via IPC, web via HTTP PUT /api/settings) */
  const setKey = useCallback(
    async (key: string, value: unknown): Promise<WriteResult> => {
      try {
        if (isTauri()) {
          if (isShellKey(key)) {
            const shell = await tauriBridge.setSetting(key, value)
            const next = mergeShell(settings ?? shell, shell)
            setSettings(next)
            setLoadError('')
            return { ok: true, settings: next }
          }
          const res = await apiSettings.update(key, value)
          const next = mergeShell(res.settings as unknown as SettingsDoc, settings)
          setSettings(next)
          setLoadError('')
          return { ok: true, settings: next }
        } else {
          const res = await apiSettings.update(key, value)
          const next = res.settings as unknown as SettingsDoc
          setSettings(next)
          setLoadError('')
          return { ok: true, settings: next }
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        notify(error, 'error')
        return { ok: false, error }
      }
    },
    [notify],
  )

  /** Reset to defaults: two channels (desktop via IPC, web via POST /api/settings/reset) */
  const resetKey = useCallback(
    async (key?: string): Promise<WriteResult> => {
      try {
        if (isTauri()) {
          if (key === undefined) {
            const shell = await tauriBridge.resetSettings()
            const res = await apiSettings.reset()
            const next = mergeShell(res.settings as unknown as SettingsDoc, shell)
            setSettings(next)
            setLoadError('')
            return { ok: true, settings: next }
          }
          if (isShellKey(key)) {
            const shell = await tauriBridge.resetSettings(key)
            const next = mergeShell(settings ?? shell, shell)
            setSettings(next)
            setLoadError('')
            return { ok: true, settings: next }
          }
          const res = await apiSettings.reset(key)
          const next = mergeShell(res.settings as unknown as SettingsDoc, settings)
          setSettings(next)
          setLoadError('')
          return { ok: true, settings: next }
        } else {
          const res = await apiSettings.reset(key)
          const next = res.settings as unknown as SettingsDoc
          setSettings(next)
          setLoadError('')
          return { ok: true, settings: next }
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        notify(error, 'error')
        return { ok: false, error }
      }
    },
    [notify],
  )

  const selectSection = useCallback(
    (id: string) => {
      setActiveId(id)
      onSectionChange?.(id)
    },
    [onSectionChange],
  )

  // Obsidian-style dynamic section assembly: base sections + app sections that declare config
  const allSections = useMemo<SettingsSection[]>(() => {
    const sections: SettingsSection[] = BASE_SETTINGS_SECTIONS.map((section) => ({
      ...section,
      name: t(`settings.${section.id}.name`),
      blurb: t(`settings.${section.id}.blurb`),
    }))
    for (const tool of pluginTools) {
      if (Array.isArray(tool.config) && tool.config.length > 0) {
        sections.push({
          id: `app-${tool.id}`,
          name: tool.name,
          icon: tool.icon || 'plugin',
          group: 'apps',
          blurb: t('settings.app.blurb', { name: tool.name }),
          render: (props) => <AppConfigSection {...props} tool={tool} />,
        })
      }
    }
    return sections
  }, [pluginTools, t])

  const active = allSections.find((s) => s.id === activeId) ?? allSections[0]

  const backend: BackendBridge = {
    status: backendStatus,
    health: backendHealth,
    busy: backendBusy,
    error: backendError,
    refresh: refreshBackendHealth,
    tail: (kind, lines) => tauriBridge.backendLogTail(kind, lines),
  }

  const sectionProps: SettingsSectionProps = {
    settings,
    schema,
    settingsPath,
    desktop,
    setKey,
    resetKey,
    reload,
    notify,
    backend,
  }

  const coreSections = allSections.filter((s) => s.group === 'core')
  const extSections = allSections.filter((s) => s.group === 'extension')
  const appSections = allSections.filter((s) => s.group === 'apps')

  const navGroups: { key: string; label: string; items: SettingsSection[] }[] = [
    { key: 'core', label: t('settings.nav.core'), items: coreSections },
    { key: 'extension', label: t('settings.nav.extension'), items: extSections },
    { key: 'apps', label: t('settings.nav.apps'), items: appSections },
  ].filter((g) => g.items.length > 0)

  return (
    <div className="ui-shell" data-settings-view>
      <aside className="ui-sidebar" aria-label={t('settings.nav.aria')}>
        <div className="ui-sidebar__brand">
          <Icon name="settings" size={16} className="text-[var(--ink-text-2)]" />
          <span className="ui-sidebar__name">{t('settings.title')}</span>
          {desktop && (
            <span className="ui-badge ui-badge--identity ml-auto">{t('settings.desktopBadge')}</span>
          )}
        </div>

        <div className="ui-sidebar__body">
          <button onClick={onBack} className="ui-nav__item" title={t('settings.back.title')}>
            <Icon name="chevronLeft" className="ui-nav__icon" />
            <span className="ui-nav__label">{backText}</span>
            <kbd className="ui-kbd ui-nav__kbd">Esc</kbd>
          </button>

          {navGroups.map((group) => (
            <nav key={group.key} className="pt-3" aria-label={group.label}>
              <div className="ui-nav__group">{group.label}</div>
              <div className="space-y-0.5">
                {group.items.map((section) => (
                  <button
                    key={section.id}
                    onClick={() => selectSection(section.id)}
                    title={section.blurb}
                    aria-current={activeId === section.id ? 'page' : undefined}
                    className="ui-nav__item"
                  >
                    <ToolIcon icon={section.icon} fallback="settings" size={16} />
                    <span className="ui-nav__label">{section.name}</span>
                  </button>
                ))}
              </div>
            </nav>
          ))}
        </div>

        <div className="ui-sidebar__foot">
          <span
            className="ui-mono truncate"
            title={settingsPath || t('settings.configPath.placeholder')}
          >
            {settingsPath || t('settings.configPath.placeholder')}
          </span>
        </div>
      </aside>

      <main className="ui-main">
        <header className="ui-pagehead">
          <h1 className="ui-pagehead__title">
            <ToolIcon icon={active.icon} fallback="settings" size={16} className="ui-pagehead__icon" />
            <span>{active.name}</span>
          </h1>
          <span className="ui-pagehead__desc hidden md:block">{active.blurb}</span>
          <div className="ui-pagehead__actions">
            <button
              onClick={() => void reload()}
              disabled={loading}
              className="ui-btn"
              title={t('settings.reload.title')}
            >
              <Icon name="refresh" />
              {loading ? t('settings.loading') : t('settings.reload.label')}
            </button>
          </div>
        </header>

        {loadError && (
          <div className="px-6 pt-4">
            <div className="ui-notice ui-notice--error">
              <Icon name="warning" className="ui-notice__icon" />
              <div className="ui-notice__body">{t('settings.loadError', { error: loadError })}</div>
            </div>
          </div>
        )}

        <section className="flex-1 min-h-0 overflow-auto px-6 py-5">
          <div className="mx-auto w-full max-w-[900px] space-y-4">{active.render(sectionProps)}</div>
        </section>

        {toast && (
          <div className="px-6 pb-4" role="status">
            <div className={`ui-notice ${toast.kind === 'error' ? 'ui-notice--error' : 'ui-notice--ok'}`}>
              <Icon
                name={toast.kind === 'error' ? 'warning' : 'check'}
                className="ui-notice__icon"
              />
              <div className="ui-notice__body">{toast.message}</div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
