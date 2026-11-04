import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  pluginCatalog,
  pluginInventory,
  type PluginCatalogEntry,
  type PluginEntry,
  type PluginUpdate,
} from '../../api'
import { t, useI18n } from '../../i18n'
import { FieldRow, SectionCard, type SettingsSectionProps } from './shared'
import { ToolIcon } from '../icons/ToolIcon'

/**
 * Plugins section: core / third-party, install, remove, enable/disable.
 *
 * Product rules:
 *   * **Core plugins** ship with the software and **can be disabled but never removed** — the UI offers
 *     no remove entry at all (instead of letting the click fail);
 *   * **Third-party plugins** can be installed and removed: uninstalled ones show "install", installed
 *     ones show "remove".
 *
 * Enable/disable uses the settings shell's `setKey` (writes `plugins.<id>._enabled`, the same semantics
 * as `yhub plugin enable/disable` and the shell settings page, **no backend restart**); install/remove
 * use the backend plugin endpoints, whose CLI equivalent is `yhub plugin install / remove`. The backend
 * rebuilds its registry in place on every one of those, so `restart_required` in the response decides
 * whether the notice mentions a restart (see `withRestart`). The UI only renders and submits — it never
 * builds paths or touches the filesystem.
 */

const BTN = 'ui-btn ui-btn--sm'
const BTN_DANGER = 'ui-btn ui-btn--sm ui-btn--danger'

/** Backend error text joined with its hint (the separator follows the active language); module-level `t` always reads the current language */
function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const sep = t('settings.plugins.error.hintSeparator')
    return `${e.message}${e.hint ? `${sep}${e.hint}` : ''}`
  }
  return String(e)
}

/**
 * `restart_required` is what the backend actually did, not a fixed sentence: install / remove / enable in
 * the GUI rebuild the registry in place (False, the tool shows up immediately), while a CLI install has no
 * live hook to call (True). Append the restart note only when it is really needed.
 */
function withRestart(text: string, needed?: boolean): string {
  return needed ? `${text}${t('settings.plugins.notify.restartSuffix')}` : text
}

function KindBadge({ kind }: { kind: PluginEntry['kind'] }) {
  const { t } = useI18n()
  const core = kind === 'core'
  return (
    <span
      className="ui-badge"
      title={
        core ? t('settings.plugins.kind.coreTitle') : t('settings.plugins.kind.thirdTitle')
      }
    >
      {core ? t('settings.plugins.kind.core') : t('settings.plugins.kind.third')}
    </span>
  )
}

function Row({ entry, busy, onToggle, onInstall, onRemove }: {
  entry: PluginEntry
  busy: string
  onToggle: (entry: PluginEntry) => void
  onInstall: (entry: PluginEntry) => void
  onRemove: (entry: PluginEntry) => void
}) {
  const { t } = useI18n()
  const working = busy === entry.id
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--ink-line)] px-4 py-3 last:border-b-0">
      <ToolIcon icon={entry.icon} fallback="plugin" size={16} />
      <span className="text-[13px] font-medium text-[var(--ink-text)]">{entry.name}</span>
      <code className="ui-mono">{entry.id}</code>
      <KindBadge kind={entry.kind} />

      {entry.broken ? (
        <span className="ui-badge ui-badge--error">
          {t('settings.plugins.badge.broken', { error: entry.broken })}
        </span>
      ) : !entry.installed ? (
        <span className="ui-badge">{t('settings.plugins.badge.notInstalled')}</span>
      ) : entry.enabled ? (
        <span className="ui-badge ui-badge--ok">{t('settings.plugins.badge.enabled')}</span>
      ) : (
        <span className="ui-badge ui-badge--warn">{t('settings.plugins.badge.disabled')}</span>
      )}
      {entry.disabled_file && (
        <span
          className="ui-badge ui-badge--warn"
          title={t('settings.plugins.badge.disabledFileTitle')}
        >
          {t('settings.plugins.badge.disabledFile')}
        </span>
      )}

      <span className="ml-auto flex items-center gap-2">
        {entry.installed && !entry.broken && (
          <button
            type="button"
            className={BTN}
            disabled={working}
            onClick={() => onToggle(entry)}
            title={
              entry.enabled
                ? t('settings.plugins.toggle.disableTitle')
                : t('settings.plugins.toggle.enableTitle')
            }
          >
            {working
              ? t('settings.busy')
              : entry.enabled
                ? t('settings.plugins.toggle.disable')
                : t('settings.plugins.toggle.enable')}
          </button>
        )}
        {!entry.installed && (
          <button type="button" className={BTN} disabled={working} onClick={() => onInstall(entry)}>
            {working ? t('settings.plugins.installing') : t('settings.plugins.install')}
          </button>
        )}
        {/* Core plugins get no remove entry: they ship in the package and can only be disabled */}
        {entry.installed && entry.uninstallable && (
          <button type="button" className={BTN_DANGER} disabled={working} onClick={() => onRemove(entry)}>
            {working ? t('settings.busy') : t('settings.plugins.remove')}
          </button>
        )}
      </span>

      {entry.description && (
        <div className="w-full ui-meta">{entry.description}</div>
      )}
    </div>
  )
}

export default function PluginsSection({ settings: currentSettings, schema, setKey, notify }: SettingsSectionProps) {
  const { t } = useI18n()
  const [entries, setEntries] = useState<PluginEntry[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [catalog, setCatalog] = useState<PluginCatalogEntry[] | null>(null)
  const [catalogError, setCatalogError] = useState('')
  const [query, setQuery] = useState('')
  const [spec, setSpec] = useState('')
  const [registryDraft, setRegistryDraft] = useState<string | null>(null)
  const [updates, setUpdates] = useState<PluginUpdate[] | null>(null)
  const [marketBusy, setMarketBusy] = useState('')

  const registryUrl = currentSettings?.plugins_registry_url || ''
  // The official index is a backend default, so "empty" now means "turned off" — offer a way back
  // that does not require knowing the URL by heart.
  const defaultRegistry = String(
    (schema?.defaults as Record<string, unknown> | undefined)?.plugins_registry_url ?? '',
  )

  const load = useCallback(async () => {
    try {
      const data = await pluginInventory.list()
      setEntries(data.plugins)
      setError('')
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

  const loadCatalog = useCallback(
    async (q = query, refresh = false) => {
      setMarketBusy('catalog')
      try {
        const data = await pluginCatalog.list(q, refresh)
        setCatalog(data.plugins)
        setCatalogError('')
      } catch (e) {
        setCatalog([])
        setCatalogError(errorText(e))
      } finally {
        setMarketBusy('')
      }
    },
    [query],
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (registryUrl) void loadCatalog('', false)
    // Auto-fetch once when the plugin source URL changes; search/refresh are explicit button clicks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryUrl])

  /** Enable/disable: uses the settings shell's write channel (writes `plugins.<id>._enabled`), same semantics as the CLI */
  const toggle = useCallback(
    async (entry: PluginEntry) => {
      setBusy(entry.id)
      try {
        const r = await setKey(`plugins.${entry.id}._enabled`, !entry.enabled)
        if (!r.ok) {
          notify(t('settings.plugins.notify.failed', { error: r.error }), 'error')
          return
        }
        notify(
          t(entry.enabled ? 'settings.plugins.notify.disabled' : 'settings.plugins.notify.enabled', {
            name: entry.name,
          }),
          'info',
        )
        await load()
      } catch (e) {
        notify(
          t('settings.plugins.notify.failed', {
            error: e instanceof ApiError ? e.message : String(e),
          }),
          'error',
        )
      } finally {
        setBusy('')
      }
    },
    [load, notify, setKey, t],
  )

  const call = useCallback(
    async (path: string, entry: PluginEntry, okText: string) => {
      setBusy(entry.id)
      try {
        const r = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: entry.id }),
        })
        const body = await r.json().catch(() => null)
        if (body?.ok) notify(withRestart(okText, body.restart_required), 'info')
        else
          notify(
            t('settings.plugins.notify.failed', { error: body?.error ?? `HTTP ${r.status}` }),
            'error',
          )
        await load()
      } catch (e) {
        notify(t('settings.plugins.notify.failed', { error: String(e) }), 'error')
      } finally {
        setBusy('')
      }
    },
    [load, notify, t],
  )

  const install = useCallback(
    (entry: PluginEntry) =>
      call(
        '/api/plugin-install',
        entry,
        t('settings.plugins.notify.installed', { name: entry.name }),
      ),
    [call, t],
  )
  const remove = useCallback(
    (entry: PluginEntry) =>
      call('/api/plugin-remove', entry, t('settings.plugins.notify.removed', { name: entry.name })),
    [call, t],
  )

  const installCatalog = useCallback(
    async (entry: PluginCatalogEntry) => {
      setMarketBusy(entry.id)
      try {
        const r = await pluginCatalog.install(entry.id)
        notify(
          withRestart(
            t('settings.plugins.notify.installedVersion', {
              name: entry.name,
              version: r.version ?? '',
            }),
            r.restart_required,
          ),
          'info',
        )
        await Promise.all([load(), loadCatalog()])
      } catch (e) {
        notify(
          t('settings.plugins.notify.failed', {
            error: e instanceof Error ? e.message : String(e),
          }),
          'error',
        )
      } finally {
        setMarketBusy('')
      }
    },
    [load, loadCatalog, notify, t],
  )

  const installGithub = useCallback(async () => {
    const value = spec.trim()
    if (!value) return
    if (!window.confirm(t('settings.plugins.confirm.github', { spec: value }))) return
    setMarketBusy('github')
    try {
      const r = await pluginCatalog.install(value)
      notify(
        withRestart(
          t('settings.plugins.notify.installedVersion', { name: r.id, version: r.version ?? '' }),
          r.restart_required,
        ),
        'info',
      )
      setSpec('')
      await Promise.all([load(), loadCatalog()])
    } catch (e) {
      notify(
        t('settings.plugins.notify.failed', {
          error: e instanceof Error ? e.message : String(e),
        }),
        'error',
      )
    } finally {
      setMarketBusy('')
    }
  }, [load, loadCatalog, notify, spec, t])

  const checkUpdates = useCallback(async () => {
    setMarketBusy('updates')
    try {
      const r = await pluginCatalog.updates()
      setUpdates(r.updates)
      if (!r.updates.some((u) => u.update_available)) notify(t('settings.plugins.notify.noUpdates'), 'info')
    } catch (e) {
      notify(
        t('settings.plugins.notify.checkFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
        'error',
      )
    } finally {
      setMarketBusy('')
    }
  }, [notify, t])

  const updateOne = useCallback(
    async (id: string) => {
      setMarketBusy(id)
      try {
        const r = await pluginCatalog.update(id)
        notify(
          r.updated.length
            ? withRestart(
                t('settings.plugins.notify.updated', { id }),
                r.updated.some((u) => u.restart_required),
              )
            : t('settings.plugins.notify.noUpdateFor', { id }),
          'info',
        )
        await Promise.all([load(), checkUpdates()])
      } catch (e) {
        notify(
          t('settings.plugins.notify.updateFailed', {
            error: e instanceof Error ? e.message : String(e),
          }),
          'error',
        )
      } finally {
        setMarketBusy('')
      }
    },
    [checkUpdates, load, notify, t],
  )

  const updateAll = useCallback(async () => {
    setMarketBusy('all')
    try {
      const r = await pluginCatalog.updateAll()
      notify(
        withRestart(
          t('settings.plugins.notify.updatedAll', { count: r.updated.length }),
          r.updated.some((u) => u.restart_required),
        ),
        'info',
      )
      await Promise.all([load(), checkUpdates()])
    } catch (e) {
      notify(
        t('settings.plugins.notify.updateFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
        'error',
      )
    } finally {
      setMarketBusy('')
    }
  }, [checkUpdates, load, notify, t])

  const saveRegistry = useCallback(async () => {
    if (registryDraft === null) return
    setMarketBusy('registry')
    try {
      const r = await setKey('plugins_registry_url', registryDraft.trim())
      if (!r.ok) {
        notify(t('settings.plugins.notify.saveFailed', { error: r.error }), 'error')
        return
      }
      setRegistryDraft(null)
      notify(t('settings.plugins.notify.registrySaved'), 'info')
      await loadCatalog('', true)
    } finally {
      setMarketBusy('')
    }
  }, [loadCatalog, notify, registryDraft, setKey, t])

  const restoreRegistry = useCallback(async () => {
    if (!defaultRegistry) return
    setMarketBusy('registry')
    try {
      const r = await setKey('plugins_registry_url', defaultRegistry)
      if (!r.ok) {
        notify(t('settings.plugins.notify.saveFailed', { error: r.error }), 'error')
        return
      }
      setRegistryDraft(null)
      notify(t('settings.plugins.notify.registrySaved'), 'info')
      await loadCatalog('', true)
    } finally {
      setMarketBusy('')
    }
  }, [defaultRegistry, loadCatalog, notify, setKey, t])

  const core = (entries ?? []).filter((e) => e.kind === 'core')
  const third = (entries ?? []).filter((e) => e.kind !== 'core')

  return (
    <div className="space-y-5" data-section="plugins">
      <SectionCard
        title={t('settings.plugins.title')}
        description={t('settings.plugins.description')}
        footer={t('settings.plugins.footer')}
      >
        {error ? (
          <div className="px-5 py-4 text-[12px] text-red-300">
            {t('settings.plugins.error.load', { error })}
            <button type="button" className={`ml-2 ${BTN}`} onClick={() => void load()}>
              {t('settings.plugins.retry')}
            </button>
          </div>
        ) : !entries ? (
          <div className="px-5 py-4 text-[12px] text-neutral-400">{t('settings.plugins.loading')}</div>
        ) : (
          <>
            <FieldRow
              label={t('settings.plugins.stats.label')}
              hint={t('settings.plugins.stats.hint')}
            >
              <span className="text-[12px] text-neutral-300">
                {t('settings.plugins.stats.value', {
                  core: core.length,
                  installed: third.filter((e) => e.installed).length,
                  third: third.length,
                })}
              </span>
              <button type="button" className={`ml-auto ${BTN}`} onClick={() => void load()}>
                {t('settings.plugins.reload')}
              </button>
            </FieldRow>
            <div className="border-t border-white/10">
              <div className="px-5 pt-3 text-[11px] text-neutral-400">
                {t('settings.plugins.core.title')}
              </div>
              {core.map((e) => (
                <Row key={e.id} entry={e} busy={busy} onToggle={toggle} onInstall={install} onRemove={remove} />
              ))}
            </div>
            <div className="border-t border-white/10">
              <div className="px-5 pt-3 text-[11px] text-neutral-400">
                {t('settings.plugins.third.title')}
              </div>
              {third.length === 0 && (
                <div className="px-5 py-3 text-[12px] text-neutral-500">
                  {t('settings.plugins.third.empty')}
                </div>
              )}
              {third.map((e) => (
                <Row key={e.id} entry={e} busy={busy} onToggle={toggle} onInstall={install} onRemove={remove} />
              ))}
            </div>
          </>
        )}
      </SectionCard>

      <SectionCard
        title={t('settings.plugins.market.title')}
        description={t('settings.plugins.market.description')}
        footer={t('settings.plugins.market.footer')}
      >
        <div className="px-4 py-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              aria-label={t('settings.plugins.market.registryAria')}
              className="ui-input ui-mono min-w-[18rem] flex-1"
              placeholder={t('settings.plugins.market.registryPlaceholder')}
              value={registryDraft ?? registryUrl}
              onChange={(e) => setRegistryDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveRegistry() }}
            />
            <button type="button" className={BTN} disabled={marketBusy === 'registry'} onClick={() => void saveRegistry()}>
              {marketBusy === 'registry'
                ? t('settings.plugins.saving')
                : t('settings.plugins.market.saveRegistry')}
            </button>
            <button type="button" className={BTN} disabled={marketBusy === 'catalog'} onClick={() => void loadCatalog(query, true)}>
              {t('settings.plugins.market.refresh')}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              aria-label={t('settings.plugins.market.searchAria')}
              className="ui-input min-w-[14rem] flex-1"
              placeholder={t('settings.plugins.market.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void loadCatalog(query, true) }}
            />
            <button type="button" className={BTN} disabled={marketBusy === 'catalog'} onClick={() => void loadCatalog(query, true)}>
              {t('settings.plugins.market.search')}
            </button>
          </div>
          {/* "Off" is a state of its own, not an error from the catalog: show it with the way back,
              whatever the last catalog call returned (a cleared source makes that call fail). */}
          {!registryUrl && defaultRegistry ? (
            <div className="flex flex-wrap items-center gap-2 ui-meta">
              {t('settings.plugins.market.noRegistry')}
              <button
                type="button"
                className={BTN}
                disabled={marketBusy === 'registry'}
                onClick={() => void restoreRegistry()}
              >
                {t('settings.plugins.market.useDefault')}
              </button>
            </div>
          ) : null}
          {catalogError ? (
            <div className="text-[12px] text-red-300">
              {catalogError}
              <span className="ui-meta ml-2">{t('settings.plugins.market.noRegistryHint')}</span>
            </div>
          ) : !catalog ? (
            <div className="ui-meta">
              {registryUrl ? t('settings.plugins.market.loading') : ''}
            </div>
          ) : catalog.length === 0 ? (
            <div className="ui-meta">{t('settings.plugins.market.empty')}</div>
          ) : (
            <div className="border-t border-[var(--ink-line)]">
              {catalog.map((entry) => (
                <div key={entry.id} className="flex flex-wrap items-center gap-2 border-b border-[var(--ink-line)] px-1 py-3 last:border-b-0">
                  <span className="text-[13px] font-medium text-[var(--ink-text)]">{entry.name}</span>
                  <code className="ui-mono">{entry.id}</code>
                  {entry.version && <span className="ui-badge">v{entry.version}</span>}
                  {entry.installed ? (
                    <span className="ui-badge ui-badge--ok">
                      {t('settings.plugins.market.installed', {
                        suffix: entry.installed_version ? ` v${entry.installed_version}` : '',
                      })}
                    </span>
                  ) : (
                    <span className="ui-badge">{t('settings.plugins.badge.notInstalled')}</span>
                  )}
                  {entry.update_available && (
                    <span className="ui-badge ui-badge--warn">
                      {t('settings.plugins.market.updateAvailable')}
                    </span>
                  )}
                  <span className="w-full ui-meta">{entry.description}{entry.author ? ` · ${entry.author}` : ''}</span>
                  <span className="ml-auto flex items-center gap-2">
                    {!entry.installed && (
                      <button
                        type="button"
                        className={BTN}
                        disabled={marketBusy === entry.id}
                        onClick={() => void installCatalog(entry)}
                      >
                        {marketBusy === entry.id
                          ? t('settings.plugins.installing')
                          : t('settings.plugins.install')}
                      </button>
                    )}
                    {entry.installed && entry.update_available && (
                      <button
                        type="button"
                        className={BTN}
                        disabled={marketBusy === entry.id}
                        onClick={() => void updateOne(entry.id)}
                      >
                        {marketBusy === entry.id
                          ? t('settings.plugins.updating')
                          : t('settings.plugins.update')}
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title={t('settings.plugins.github.title')}
        description={t('settings.plugins.github.description')}
        footer={t('settings.plugins.github.footer')}
      >
        <div className="px-4 py-4 flex flex-wrap items-center gap-2">
          <input
            type="text"
            aria-label={t('settings.plugins.github.aria')}
            className="ui-input ui-mono min-w-[18rem] flex-1"
            placeholder={t('settings.plugins.github.placeholder')}
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void installGithub() }}
          />
          <button type="button" className={BTN} disabled={!spec.trim() || marketBusy === 'github'} onClick={() => void installGithub()}>
            {marketBusy === 'github'
              ? t('settings.plugins.installing')
              : t('settings.plugins.install')}
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title={t('settings.plugins.updates.title')}
        description={t('settings.plugins.updates.description')}
        footer={t('settings.plugins.updates.footer')}
      >
        <div className="px-4 py-4 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={BTN} disabled={marketBusy === 'updates'} onClick={() => void checkUpdates()}>
              {marketBusy === 'updates'
                ? t('settings.plugins.checking')
                : t('settings.plugins.checkUpdates')}
            </button>
            <button type="button" className={BTN} disabled={marketBusy === 'all' || !updates?.some((u) => u.update_available)} onClick={() => void updateAll()}>
              {marketBusy === 'all'
                ? t('settings.plugins.updating')
                : t('settings.plugins.updateAll')}
            </button>
          </div>
          {updates && updates.length === 0 && (
            <div className="ui-meta">{t('settings.plugins.updates.none')}</div>
          )}
          {updates?.map((u) => (
            <div key={u.id} className="flex flex-wrap items-center gap-2 border-b border-[var(--ink-line)] py-2 last:border-b-0">
              <span className="text-[13px] text-[var(--ink-text)]">{u.id}</span>
              <span className="ui-mono">{u.installed_version || '—'} → {u.latest_version || '—'}</span>
              <span className="ui-badge">{u.source}</span>
              {u.update_available ? (
                <button type="button" className={`ml-auto ${BTN}`} disabled={marketBusy === u.id} onClick={() => void updateOne(u.id)}>
                  {marketBusy === u.id
                    ? t('settings.plugins.updating')
                    : t('settings.plugins.update')}
                </button>
              ) : (
                <span className="ml-auto ui-badge ui-badge--ok">
                  {t('settings.plugins.updates.latest')}
                </span>
              )}
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  )
}
