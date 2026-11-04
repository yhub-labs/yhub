// General section: where the config lives / which version, a snapshot of effective values, restore defaults
//
// Only document-level concerns belong here (version, path, restore defaults); per-field controls sit
// in their own sections (hotkeys / tray / tools). Every value is read live from the Rust side; the
// frontend caches nothing.

import { useState } from 'react'
import { formatHotkey, isTauri, tauriBridge } from '../../tauriBridge'
import { LANGUAGES, useI18n, type Lang } from '../../i18n'
import { Icon } from '../icons/Icon'
import {
  ActionButton,
  FieldRow,
  SectionCard,
  trayFieldLabel,
  valueLabel,
  type SettingsSectionProps,
} from './shared'

/** Human-readable backend source (the key contract lives in the `source` module of tauri/src/backend.rs) */
const SOURCE_LABEL_KEYS: Record<string, string> = {
  reused: 'settings.source.reused',
  external: 'settings.source.external',
  installed: 'settings.source.installed',
  uv_run: 'settings.source.uvRun',
  none: 'settings.source.none',
}

export default function GeneralSection({
  settings,
  schema,
  settingsPath,
  desktop,
  setKey,
  resetKey,
  notify,
  backend,
}: SettingsSectionProps) {
  const { t, lang, setLang } = useI18n()
  // Running restore action ('all' / section name / leaf path), used for button disabling and labels
  const [busy, setBusy] = useState('')
  // "Backend bridge" card: the log is read on demand (disk read, possibly large — not on every settings visit)
  const [logTail, setLogTail] = useState('')
  const [logBusy, setLogBusy] = useState(false)
  const [currentTheme, setCurrentTheme] = useState(
    () => document.documentElement.dataset.theme || 'dark',
  )

  const sourceLabel = (source: string): string =>
    SOURCE_LABEL_KEYS[source] ? t(SOURCE_LABEL_KEYS[source]) : source

  const changeTheme = (mode: 'dark' | 'light') => {
    setCurrentTheme(mode)
    document.documentElement.dataset.theme = mode
    try {
      const raw = localStorage.getItem('yhub.panel.prefs')
      const prefs = raw ? JSON.parse(raw) : {}
      prefs.theme = mode
      localStorage.setItem('yhub.panel.prefs', JSON.stringify(prefs))
    } catch {
      // ignore
    }
    notify(
      t('settings.theme.switched', {
        mode: mode === 'dark' ? t('settings.theme.dark') : t('settings.theme.light'),
      }),
      'info',
    )
  }

  /** Switch the UI language: applies immediately, and is also persisted as `ui_language` (best effort) */
  const changeLanguage = (next: Lang) => {
    if (next === lang) return
    setLang(next)
    // Not awaited: a backend write failure must never block the language switch (the toast explains it).
    // The shell is told **after the write lands** — it re-labels the tray by re-reading settings.json, so
    // refreshing first would re-label in the old language (the tray would stay one switch behind).
    void setKey('ui_language', next)
      .catch(() => null)
      .then(() => {
        // The tray menu is shell-owned copy built once at startup and `ui_language` is a backend-owned key,
        // so the shell never learns about the switch on its own. Tauri only (a browser has no tray); a
        // failed re-label must not break this click.
        if (isTauri()) return tauriBridge.refreshShellLanguage().catch(() => null)
        return null
      })
  }

  const showLog = async () => {
    setLogBusy(true)
    try {
      setLogTail(await backend.tail('backend', 120))
    } finally {
      setLogBusy(false)
    }
  }

  const version = settings?.version ?? schema?.version
  const actions = schema?.hotkey_actions ?? []
  const hotkeys = actions.map((action) => ({
    id: action.id,
    name: action.name,
    combo: (settings?.hotkeys?.[action.id] ?? '').trim(),
  }))
  const trayFields = schema?.tray_fields ?? []

  /** Current value of one key (display only; "—" when unavailable) */
  const currentValue = (key: string): string => {
    if (!settings) return '—'
    const [section, field] = key.split('.')
    if (section === 'hotkeys') {
      const combo = (settings.hotkeys?.[field] ?? '').trim()
      return combo ? formatHotkey(combo) : t('settings.hotkey.unbound')
    }
    const raw = (settings.tray as Record<string, unknown> | undefined)?.[field]
    if (typeof raw === 'boolean') return raw ? t('settings.on') : t('settings.off')
    return valueLabel(raw)
  }

  /** Rows for per-key reset: leaf paths (section names version/hotkeys/tray are handled by the buttons above) */
  const leafRows = (schema?.keys ?? [])
    .filter((key) => key.includes('.'))
    .map((key) => {
      const [section, field] = key.split('.')
      const label =
        section === 'hotkeys'
          ? t('settings.hotkey.row', { name: actions.find((a) => a.id === field)?.name ?? field })
          : section === 'tray'
            ? trayFieldLabel(field)
            : `${section} · ${field}`
      return { key, label, value: currentValue(key) }
    })

  const copyPath = async () => {
    if (!settingsPath) return
    try {
      await navigator.clipboard.writeText(settingsPath)
      notify(t('settings.copyPath.ok'))
    } catch {
      notify(t('settings.copyPath.fail'), 'error')
    }
  }

  const restore = async (key: string | undefined, label: string) => {
    if (key === undefined) {
      const ok = window.confirm(t('settings.restore.confirm'))
      if (!ok) return
    }
    setBusy(key ?? 'all')
    const res = await resetKey(key)
    setBusy('')
    if (res.ok) notify(t('settings.restore.done', { label }))
  }

  /** Reset one key: value null = hand it back to its default (the backend validates and persists) */
  const restoreOne = async (key: string, label: string) => {
    setBusy(key)
    const res = await setKey(key, null)
    setBusy('')
    if (res.ok) notify(t('settings.restore.done', { label }))
  }

  return (
    <div className="space-y-5">
      <SectionCard title={t('settings.config.title')} description={t('settings.config.desc')}>
        <FieldRow label={t('settings.config.version')} hint={t('settings.config.versionHint')}>
          <span className="font-mono text-neutral-300">
            {version === undefined ? '—' : `v${version}`}
          </span>
        </FieldRow>

        <FieldRow
          label={t('settings.config.path')}
          hint={settingsPath ? t('settings.config.pathHintOn') : t('settings.config.pathHintOff')}
        >
          <span
            className="font-mono text-[11px] text-neutral-400 truncate max-w-[360px]"
            title={settingsPath}
          >
            {settingsPath || '—'}
          </span>
          <ActionButton
            onClick={() => void copyPath()}
            disabled={!settingsPath}
            title={t('settings.copyPath.title')}
          >
            {t('settings.copyPath.button')}
          </ActionButton>
        </FieldRow>

        {!desktop && (
          <div className="px-5 py-3.5 text-[11px] text-amber-200/90 bg-amber-500/[0.06] leading-relaxed">
            {t('settings.preview.body')}
            <code className="font-mono">tauri dev</code>
            {t('settings.preview.tail')}
          </div>
        )}
      </SectionCard>

      <SectionCard title={t('settings.backend.title')} description={t('settings.backend.desc')}>
        <FieldRow
          label={t('settings.backend.status')}
          hint={
            backend.status?.running
              ? backend.status.healthy
                ? t('settings.backend.statusHintOk')
                : t('settings.backend.statusHintUnhealthy')
              : t('settings.backend.statusHintStopped')
          }
        >
          <span className={backend.status?.running ? 'text-[var(--ink-ok-text)]' : 'text-[var(--ink-text-2)]'}>
            {backend.status
              ? backend.status.running
                ? t('settings.running')
                : t('settings.notRunning')
              : desktop
                ? t('settings.loading')
                : '—'}
          </span>
        </FieldRow>

        <FieldRow label={t('settings.backend.source')} hint={t('settings.backend.sourceHint')}>
          <span className="text-neutral-300">
            {backend.status ? sourceLabel(backend.status.source) : '—'}
          </span>
        </FieldRow>

        <FieldRow label={t('settings.backend.port')} hint={t('settings.backend.portHint')}>
          <span className="font-mono text-neutral-300">{backend.status?.port ?? '—'}</span>
        </FieldRow>

        <FieldRow
          label={t('settings.backend.pid')}
          hint={
            backend.status?.owned
              ? t('settings.backend.pidOwned')
              : backend.status?.running
                ? t('settings.backend.pidForeign')
                : undefined
          }
        >
          <span className="font-mono text-neutral-300">{backend.status?.pid ?? '—'}</span>
        </FieldRow>

        <FieldRow label={t('settings.backend.version')} hint={t('settings.backend.versionHint')}>
          <span className="font-mono text-neutral-300">
            {backend.health?.version ?? backend.status?.version ?? '—'}
          </span>
        </FieldRow>

        <FieldRow label={t('settings.backend.tools')} hint={t('settings.backend.toolsHint')}>
          <span className="font-mono text-neutral-300">
            {backend.health?.tools === null || backend.health?.tools === undefined
              ? '—'
              : t('settings.backend.toolsCount', { count: backend.health.tools })}
          </span>
        </FieldRow>

        <FieldRow label={t('settings.backend.latency')} hint={t('settings.backend.latencyHint')}>
          <span className="font-mono text-neutral-300">
            {backend.health
              ? `${backend.health.latency_ms} ms${backend.health.ok ? '' : t('settings.backend.latencyFail')}`
              : '—'}
          </span>
        </FieldRow>

        <FieldRow
          label={t('settings.backend.log')}
          hint={backend.status?.log_path || t('settings.backend.logHintFallback')}
        >
          <ActionButton onClick={() => void showLog()} disabled={!desktop || logBusy}>
            {logBusy ? t('settings.loading') : t('settings.backend.logButton')}
          </ActionButton>
        </FieldRow>

        <FieldRow
          label={t('settings.backend.connectivity')}
          hint={t('settings.backend.connectivityHint')}
        >
          <ActionButton onClick={() => void backend.refresh()} disabled={!desktop || backend.busy}>
            {backend.busy ? t('settings.backend.checkBusy') : t('settings.backend.check')}
          </ActionButton>
        </FieldRow>

        {(backend.error || backend.health?.error) && (
          <div className="px-5 py-3.5 text-[11px] text-red-200/90 bg-red-500/[0.07] leading-relaxed">
            <div>{backend.health?.error ?? backend.error}</div>
            {(backend.health?.hint ?? backend.status?.hint) && (
              <div className="mt-1 text-red-200/70">{backend.health?.hint ?? backend.status?.hint}</div>
            )}
          </div>
        )}

        {logTail && (
          <div className="px-5 py-3.5">
            <div className="mb-2 text-[11px] text-neutral-400">
              {t('settings.backend.logTail', {
                path: backend.status?.log_path ?? 'logs/backend.log',
              })}
            </div>
            <pre className="max-h-56 overflow-auto rounded-lg bg-black/40 p-3 text-[11px] leading-relaxed text-neutral-300 font-mono whitespace-pre-wrap">
              {logTail}
            </pre>
          </div>
        )}

        {!desktop && (
          <div className="px-5 py-3.5 text-[11px] text-amber-200/90 bg-amber-500/[0.06] leading-relaxed">
            {t('settings.backend.preview')}
          </div>
        )}
      </SectionCard>

      <SectionCard title={t('settings.theme.title')} description={t('settings.theme.desc')}>
        <FieldRow label={t('settings.theme.row')} hint={t('settings.theme.rowHint')}>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => changeTheme('dark')}
              className={`ui-btn ui-btn--sm ${currentTheme === 'dark' ? 'ui-btn--primary' : 'ui-btn--ghost'}`}
            >
              <Icon name="moon" size={13} />
              {t('settings.theme.dark')}
            </button>
            <button
              type="button"
              onClick={() => changeTheme('light')}
              className={`ui-btn ui-btn--sm ${currentTheme === 'light' ? 'ui-btn--primary' : 'ui-btn--ghost'}`}
            >
              <Icon name="sun" size={13} />
              {t('settings.theme.light')}
            </button>
          </div>
        </FieldRow>

        <FieldRow label={t('settings.language.label')} hint={t('settings.language.hint')}>
          <select
            value={lang}
            aria-label={t('settings.language.label')}
            onChange={(event) => changeLanguage(event.target.value as Lang)}
            className="ui-input w-auto"
          >
            {LANGUAGES.map((option) => (
              <option key={option.id} value={option.id}>
                {t(`settings.language.${option.id}`)}
              </option>
            ))}
          </select>
        </FieldRow>
      </SectionCard>

      <SectionCard title={t('settings.snapshot.title')} description={t('settings.snapshot.desc')}>
        {hotkeys.map((hotkey) => (
          <FieldRow key={hotkey.id} label={t('settings.hotkey.row', { name: hotkey.name })}>
            <span className="font-mono text-neutral-300">
              {hotkey.combo ? formatHotkey(hotkey.combo) : t('settings.hotkey.unbound')}
            </span>
          </FieldRow>
        ))}
        {hotkeys.length === 0 && <FieldRow label={t('settings.hotkey.label')} value="—" />}
        {trayFields.map((field) => (
          <FieldRow key={field} label={trayFieldLabel(field)}>
            <span className="text-neutral-300">
              {valueLabel((settings?.tray as Record<string, unknown> | undefined)?.[field])}
            </span>
          </FieldRow>
        ))}
        <FieldRow
          label={t('settings.snapshot.capsules')}
          hint={t('settings.snapshot.capsulesHint')}
        >
          <span className="font-mono text-neutral-300">{settings?.capsules_dir || t('settings.unset')}</span>
        </FieldRow>
      </SectionCard>

      <SectionCard title={t('settings.restore.title')} description={t('settings.restore.desc')}>
        <FieldRow label={t('settings.restore.hotkeys')} hint={t('settings.restore.hotkeysHint')}>
          <ActionButton
            onClick={() => void restore('hotkeys', t('settings.restore.hotkeys'))}
            disabled={!desktop || busy !== ''}
          >
            {busy === 'hotkeys' ? t('settings.busy') : t('settings.restore.button')}
          </ActionButton>
        </FieldRow>

        <FieldRow label={t('settings.restore.tray')} hint={t('settings.restore.trayHint')}>
          <ActionButton
            onClick={() => void restore('tray', t('settings.restore.tray'))}
            disabled={!desktop || busy !== ''}
          >
            {busy === 'tray' ? t('settings.busy') : t('settings.restore.button')}
          </ActionButton>
        </FieldRow>

        <FieldRow label={t('settings.restore.all')} hint={t('settings.restore.allHint')}>
          <ActionButton
            danger
            onClick={() => void restore(undefined, t('settings.restore.all'))}
            disabled={!desktop || busy !== ''}
          >
            {busy === 'all' ? t('settings.busy') : t('settings.restore.allButton')}
          </ActionButton>
        </FieldRow>

        {/* Escape hatch: with no control built for a section yet, any single key can still go back to its default */}
        <details className="px-5 py-3.5">
          <summary className="text-[12px] text-neutral-400 cursor-pointer select-none">
            {t('settings.restore.advanced')}
          </summary>
          <div className="mt-3 space-y-2">
            {leafRows.map((row) => (
              <div key={row.key} className="flex items-center gap-3">
                <span className="flex-1 min-w-0 truncate text-[12px] text-neutral-300" title={row.key}>
                  {row.label}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-neutral-400 truncate max-w-[180px]">
                  {row.value}
                </span>
                <ActionButton
                  onClick={() => void restoreOne(row.key, row.label)}
                  disabled={!desktop || busy !== ''}
                >
                  {busy === row.key ? t('settings.busy') : t('settings.restore.button')}
                </ActionButton>
              </div>
            ))}
            {leafRows.length === 0 && (
              <div className="text-[11px] text-neutral-400">{t('settings.loading')}</div>
            )}
          </div>
        </details>
      </SectionCard>
    </div>
  )
}
