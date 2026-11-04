import { useCallback, useEffect, useState } from 'react'
import { capsules as vaultCapsules, type VaultCapsule, type VaultCapsules } from '../../api'
import { useI18n } from '../../i18n'
import { tauriBridge } from '../../tauriBridge'
import { SectionCard, type SettingsSectionProps } from './shared'
import { Icon } from '../icons/Icon'

/**
 * Capsules-library settings: **most people should never need to configure this**, so guide only when needed.
 *
 * Three states (told to us by `problem` from `/api/capsules`):
 *   unset      no library of their own yet — built-in samples only. Offer "use the recommended path / pick a folder / type it manually".
 *   missing    configured but the directory does not exist — offer "create it / pick again / disable".
 *   not_dir / unwritable  wrong path / not writable — also fixable states, so "not configured" is not enough.
 *   ok         fine — show path + capsule count + open folder.
 *
 * Every directory operation goes through the backend (`POST /api/capsules/ensure`) and desktop shell
 * commands (native picker, Finder); the UI never touches the filesystem (AGENTS.md iron rule).
 */
function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export default function CapsulesSection({
  settings,
  desktop,
  setKey,
  resetKey,
  reload,
  notify,
}: SettingsSectionProps) {
  const { t } = useI18n()
  const [capsuleList, setCapsuleList] = useState<VaultCapsules | null>(null)
  const [draftDir, setDraftDir] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)

  const currentDir = settings?.capsules_dir || ''
  const globalSub = !!settings?.capsules_subdomains
  const subOverrides = settings?.capsules_subdomains_overrides ?? {}
  const subEffective = (capsule: VaultCapsule) =>
    subOverrides[capsule.scope || capsule.relpath] ?? globalSub
  const hasOverride = (capsule: VaultCapsule) =>
    Object.prototype.hasOwnProperty.call(subOverrides, capsule.scope || capsule.relpath)
  const setCapsuleSub = async (capsule: VaultCapsule, next: boolean) => {
    const scope = capsule.scope || capsule.relpath
    await setKey('capsules_subdomains_overrides', { ...subOverrides, [scope]: next })
    await loadList()
  }
  const followGlobal = async (capsule: VaultCapsule) => {
    const scope = capsule.scope || capsule.relpath
    const next = { ...subOverrides }
    delete next[scope]
    await setKey('capsules_subdomains_overrides', next)
    await loadList()
  }
  const problem = capsuleList?.problem ?? null
  const recommended = capsuleList?.recommended_dir || '~/Y-Hub/capsules'
  const brokenPath = capsuleList?.configured_path || currentDir

  const loadList = useCallback(async () => {
    try {
      setCapsuleList(await vaultCapsules.list())
    } catch {
      setCapsuleList(null)
    }
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList, currentDir])

  /** Create the directory + write config (backend does both), then refresh list and settings */
  const ensure = async (path?: string) => {
    setBusy(true)
    try {
      const res = await vaultCapsules.ensure(path)
      notify(
        t(res.created ? 'settings.capsules.notify.created' : 'settings.capsules.notify.enabled', {
          path: res.capsules_dir,
        }),
        'info',
      )
      setDraftDir(null)
      setAdvanced(false)
      await loadList()
      await reload()
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  /** Native directory picker (browser preview lacks this capability, so the button is hidden there) */
  const pick = async () => {
    setBusy(true)
    try {
      const picked = await tauriBridge.pickDirectory(t('settings.capsules.pickTitle'))
      if (picked) await ensure(picked)
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const openFolder = async (path: string) => {
    try {
      await tauriBridge.revealPath(path)
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  /** Type the path manually (escape hatch: bulk deployment, scripts, non-default locations) */
  const saveDir = async () => {
    const val = draftDir !== null ? draftDir : currentDir
    setBusy(true)
    const res = await setKey('capsules_dir', val)
    setBusy(false)
    if (res.ok) {
      setDraftDir(null)
      setAdvanced(false)
      notify(t('settings.capsules.notify.dirUpdated'), 'info')
      void loadList()
    }
  }

  const resetDir = async () => {
    setBusy(true)
    const res = await resetKey('capsules_dir')
    setBusy(false)
    if (res.ok) {
      setDraftDir(null)
      setAdvanced(false)
      notify(t('settings.capsules.notify.dirReset'), 'info')
      void loadList()
    }
  }

  const openCapsule = async (capsule: VaultCapsule) => {
    if (desktop) {
      try {
        await tauriBridge.openCapsule(capsule.url)
        return
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), 'error')
        return
      }
    }
    window.open(capsule.url, '_blank', 'noopener')
  }

  const toggleEnabled = async (capsule: VaultCapsule) => {
    const nextState = capsule.enabled === false
    setBusy(true)
    try {
      await vaultCapsules.toggle({
        id: capsule.id,
        relpath: capsule.relpath,
        source: capsule.source,
        enabled: nextState,
      })
      notify(
        t(
          nextState ? 'settings.capsules.notify.toggleOn' : 'settings.capsules.notify.toggleOff',
          { name: capsule.title || capsule.name },
        ),
        'info',
      )
      await loadList()
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const items = capsuleList?.capsules ?? []
  const isDirty = draftDir !== null && draftDir !== currentDir

  const manualInput = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          aria-label={t('settings.capsules.path.aria')}
          className="ui-input ui-mono min-w-[20rem] flex-1"
          placeholder={t('settings.capsules.path.placeholder')}
          value={draftDir !== null ? draftDir : currentDir}
          onChange={(e) => setDraftDir(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveDir()
          }}
        />
        <button
          type="button"
          disabled={busy || !isDirty}
          onClick={() => void saveDir()}
          className="ui-btn ui-btn--sm"
        >
          {t('settings.capsules.path.save')}
        </button>
      </div>
      <div className="ui-meta leading-relaxed">
        {t('settings.capsules.path.hint')}
      </div>
    </div>
  )

  return (
    <div className="space-y-5" data-section="capsules">
      <SectionCard
        title={t('settings.capsules.title')}
        description={t('settings.capsules.description')}
        footer={t('settings.capsules.footer')}
      >
        <div className="px-4 py-4 space-y-3">
          {!capsuleList ? (
            <div className="ui-meta">{t('settings.capsules.loading')}</div>
          ) : (
            <>
              {/* 1. Not configured yet: offer the recommended path and a picker, no typing required */}
              {problem === 'unset' && (
                <>
                  <div className="text-[13px] font-medium text-[var(--ink-text)]">
                    {t('settings.capsules.unset.title')}
                  </div>
                  <div className="ui-meta leading-relaxed">
                    {t('settings.capsules.unset.description')}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void ensure()}
                      className="ui-btn ui-btn--primary"
                    >
                      <Icon name="plus" />
                      {t('settings.capsules.unset.useRecommended')}
                    </button>
                    {desktop && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void pick()}
                        className="ui-btn"
                      >
                        <Icon name="folder" />
                        {t('settings.capsules.pick')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="ui-btn ui-btn--ghost"
                      onClick={() => setAdvanced((v) => !v)}
                    >
                      {t('settings.capsules.manual')}
                    </button>
                  </div>
                  <div className="ui-meta">
                    {t('settings.capsules.unset.recommended')}
                    <span className="ui-mono">{recommended}</span>
                  </div>
                </>
              )}

              {/* 2. Configured but broken: say exactly what is wrong and offer the matching fix */}
              {problem !== null && problem !== 'unset' && (
                <>
                  <div className="ui-notice ui-notice--error">
                    <Icon name="warning" className="ui-notice__icon" />
                    <div className="ui-notice__body">
                      <div className="ui-notice__title">
                        {capsuleList.problem_detail || t('settings.capsules.problem.title')}
                        {problem === 'unwritable'
                          ? t('settings.capsules.problem.readOnly')
                          : ''}
                      </div>
                      <div className="ui-mono break-all">{brokenPath}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {problem === 'missing' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void ensure(brokenPath)}
                        className="ui-btn ui-btn--primary"
                      >
                        <Icon name="folder" />
                        {t('settings.capsules.createDir')}
                      </button>
                    )}
                    {desktop && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void pick()}
                        className="ui-btn"
                      >
                        {t('settings.capsules.repick')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="ui-btn ui-btn--ghost"
                      onClick={() => setAdvanced((v) => !v)}
                    >
                      {t('settings.capsules.manualShort')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void resetDir()}
                      className="ui-btn ui-btn--ghost"
                    >
                      {t('settings.capsules.disableSamples')}
                    </button>
                  </div>
                </>
              )}

              {/* 3. Healthy: path + capsule count + open folder / change */}
              {problem === null && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="ui-badge ui-badge--ok">
                      <span className="ui-dot ui-dot--ok" />
                      {t('settings.capsules.enabledBadge')}
                    </span>
                    <span
                      className="ui-mono truncate max-w-[26rem]"
                      title={capsuleList.capsules_dir}
                    >
                      {capsuleList.capsules_dir}
                    </span>
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      {desktop && (
                        <button
                          type="button"
                          onClick={() => void openFolder(capsuleList.capsules_dir)}
                          className="ui-btn ui-btn--sm"
                        >
                          <Icon name="folder" />
                          {t('settings.capsules.openFolder')}
                        </button>
                      )}
                      {desktop && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void pick()}
                          className="ui-btn ui-btn--sm"
                        >
                          {t('settings.capsules.change')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="ui-btn ui-btn--sm ui-btn--ghost"
                        onClick={() => setAdvanced((v) => !v)}
                      >
                        {t('settings.capsules.manualShort')}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void resetDir()}
                        className="ui-btn ui-btn--sm ui-btn--ghost"
                      >
                        {t('settings.capsules.disable')}
                      </button>
                    </div>
                  </div>
                  <div className="ui-meta">
                    {t('settings.capsules.indexed', { count: items.length })}
                  </div>
                </>
              )}

              {advanced && manualInput}
              {!advanced && isDirty && manualInput}
            </>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title={t('settings.capsules.list.title', { count: items.length })}
        description={t('settings.capsules.list.description')}
      >
        {items.length > 0 ? (
          <div className="divide-y divide-[var(--ink-line)]">
            {items.map((capsule) => {
              const isDisabled = capsule.enabled === false
              return (
                <div
                  key={`${capsule.source}-${capsule.relpath}`}
                  className={`flex flex-wrap items-center gap-3 px-4 py-3 transition-opacity ${
                    isDisabled ? 'opacity-60 bg-[var(--ink-bg-subtle,#f9f9f9)] dark:bg-white/5' : ''
                  }`}
                >
                  <div className="w-6 h-6 flex items-center justify-center shrink-0">
                    {capsule.icon ? (
                      <img
                        src={capsule.icon}
                        alt=""
                        className="w-5 h-5 object-contain"
                        onError={(ev) => {
                          ev.currentTarget.style.display = 'none'
                        }}
                      />
                    ) : (
                      <Icon name="capsule" size={16} className="text-[var(--ink-text-2)]" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium text-[var(--ink-text)] truncate">
                        {capsule.title || capsule.name}
                      </span>
                      <span className="ui-mono">{capsule.relpath}</span>
                      {isDisabled ? (
                        <span className="ui-badge ui-badge--warn">
                          {t('settings.capsules.list.disabledBadge')}
                        </span>
                      ) : null}
                      {capsule.source === 'system' ? (
                        <span className="ui-badge" title={t('settings.capsules.list.systemTitle')}>
                          {t('settings.capsules.list.system')}
                        </span>
                      ) : (
                        <span
                          className="ui-badge ui-badge--ok"
                          title={t('settings.capsules.list.userTitle')}
                        >
                          {t('settings.capsules.list.user')}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 ui-meta mt-0.5">
                      <span>{sizeLabel(capsule.bytes)}</span>
                      <span className="ui-mono select-all truncate max-w-sm">{capsule.url}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void toggleEnabled(capsule)}
                      className={`ui-btn ui-btn--sm ${
                        isDisabled ? 'ui-btn--primary' : 'ui-btn--ghost'
                      }`}
                    >
                      {isDisabled ? t('settings.capsules.enable') : t('settings.capsules.disable')}
                    </button>
                    <label
                      className="flex items-center gap-1.5 ui-meta"
                      title={t('settings.capsules.subdomain.title')}
                    >
                      <input
                        type="checkbox"
                        checked={subEffective(capsule)}
                        disabled={busy}
                        onChange={(e) => void setCapsuleSub(capsule, e.target.checked)}
                      />
                      {t('settings.capsules.subdomain.label')}
                    </label>
                    {hasOverride(capsule) && (
                      <button
                        type="button"
                        className="ui-btn ui-btn--ghost ui-btn--sm"
                        disabled={busy}
                        onClick={() => void followGlobal(capsule)}
                      >
                        {t('settings.capsules.subdomain.followGlobal')}
                      </button>
                    )}
                    {!isDisabled && (
                      <button
                        type="button"
                        onClick={() => void openCapsule(capsule)}
                        className="ui-btn ui-btn--sm"
                      >
                        <Icon name="external" size={12} />
                        {t('settings.capsules.open')}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="px-4 py-6 text-center ui-meta">
            {problem === 'unset'
              ? t('settings.capsules.empty.unset')
              : t('settings.capsules.empty.none')}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title={t('settings.capsules.isolation.title')}
        description={t('settings.capsules.isolation.description')}
        footer={t('settings.capsules.isolation.footer')}
      >
        <label className="px-4 py-4 flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={!!settings?.capsules_subdomains}
            disabled={busy}
            onChange={(e) => void setKey('capsules_subdomains', e.target.checked)}
          />
          <span>
            <span className="block text-[13px] font-medium text-[var(--ink-text)]">
              {t('settings.capsules.isolation.rowTitle')}
            </span>
            <span className="block ui-meta mt-0.5 leading-relaxed">
              {t('settings.capsules.isolation.rowHint')}
            </span>
          </span>
        </label>
      </SectionCard>
    </div>
  )
}
