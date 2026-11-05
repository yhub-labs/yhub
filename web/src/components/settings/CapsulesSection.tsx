import { useCallback, useEffect, useRef, useState } from 'react'
import {
  capsules as vaultCapsules,
  type CapsuleMeta,
  type VaultCapsule,
  type VaultCapsules,
} from '../../api'
import { useI18n } from '../../i18n'
import { tauriBridge } from '../../tauriBridge'
import { SectionCard, type SettingsSectionProps } from './shared'
import { Icon } from '../icons/Icon'
import { ToolIcon } from '../icons/ToolIcon'

/**
 * Capsules-library settings: **there is nothing to configure** in the normal case — the library lives at
 * the default location (`<data folder>/capsules`) and is created on the first import or save. This panel
 * only surfaces the states that need a decision.
 *
 * States (told to us by `problem` from `/api/capsules`):
 *   disabled   the user turned the layer off (built-in samples only) — one click brings it back.
 *   missing    an explicit path that does not exist — offer "create it / pick again / turn it off".
 *   not_dir / unwritable  wrong path / not writable — also fixable states, so "off" is not enough.
 *   ok         fine — show the path (or the default location) + capsule count; the folder may not exist
 *              yet, in which case the first import creates it.
 *
 * `capsules_dir` is an **override**: empty means the default location, and turning the layer off is
 * the separate `capsules_enabled` switch (never an empty path).
 *
 * Every directory operation goes through the backend (`POST /api/capsules/ensure`, `/meta`, `/import`,
 * `/delete`) and desktop shell commands (native picker, Finder); the UI never touches the filesystem
 * (AGENTS.md iron rule).
 */
function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** File → base64 (chunked: a single `String.fromCharCode(...bytes)` overflows the stack on big pages) */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

const EMPTY_DRAFT = { title: '', icon: '', description: '', order: '' }
type Draft = typeof EMPTY_DRAFT

export default function CapsulesSection({
  settings,
  desktop,
  setKey,
  reload,
  notify,
}: SettingsSectionProps) {
  const { t } = useI18n()
  const [capsuleList, setCapsuleList] = useState<VaultCapsules | null>(null)
  const [draftDir, setDraftDir] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  // Import + declared metadata (the optional front door: the folder still works, this is the guided path)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [removeData, setRemoveData] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

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
  const defaultDir = capsuleList?.default_capsules_dir || capsuleList?.recommended_dir || ''
  const libraryExists = capsuleList?.capsules_dir_exists ?? false
  const usingDefault = capsuleList?.using_default ?? true
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

  /** Turn the user layer back on without touching the path (empty path = the default location). */
  const enableLibrary = async () => {
    setBusy(true)
    const res = await setKey('capsules_enabled', true)
    setBusy(false)
    if (res.ok) {
      setDraftDir(null)
      setAdvanced(false)
      notify(t('settings.capsules.notify.libraryOn', { path: defaultDir }), 'info')
      await loadList()
      await reload()
    }
  }

  /** Turn the user layer off (built-in samples only): a switch, **not** an empty path. */
  const disableLibrary = async () => {
    setBusy(true)
    const res = await setKey('capsules_enabled', false)
    setBusy(false)
    if (res.ok) {
      setDraftDir(null)
      setAdvanced(false)
      notify(t('settings.capsules.notify.dirReset'), 'info')
      void loadList()
    }
  }

  /** Drop an explicit override → back to the default location (which follows the data folder). */
  const useDefaultDir = async () => {
    setBusy(true)
    const res = await setKey('capsules_dir', '')
    setBusy(false)
    if (res.ok) {
      setDraftDir(null)
      setAdvanced(false)
      notify(t('settings.capsules.notify.dirUpdated'), 'info')
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

  /** One capsule from the file picker: bytes → base64 → backend copies it into the library. */
  const importFile = async (file: File) => {
    const limit = capsuleList?.max_bytes ?? 0
    if (limit && file.size > limit) {
      notify(t('settings.capsules.importTooBig', { limit: Math.round(limit / (1024 * 1024)) }), 'error')
      return
    }
    setBusy(true)
    try {
      const res = await vaultCapsules.importCapsule({
        filename: file.name,
        content_base64: toBase64(await file.arrayBuffer()),
      })
      notify(
        t(
          res.unchanged
            ? 'settings.capsules.notify.importedUnchanged'
            : res.replaced
              ? 'settings.capsules.notify.importedReplaced'
              : 'settings.capsules.notify.imported',
          { name: res.relpath },
        ),
        'info',
      )
      await loadList()
      await reload()
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const startEdit = (capsule: VaultCapsule) => {
    const meta: CapsuleMeta = capsule.meta ?? {}
    setDraft({
      title: meta.title ?? '',
      icon: meta.icon ?? '',
      description: meta.description ?? '',
      order: typeof meta.order === 'number' ? String(meta.order) : '',
    })
    setEditing(capsule.relpath)
    setConfirming(null)
    setRemoveData(false)
  }

  const saveMeta = async (capsule: VaultCapsule) => {
    const orderText = draft.order.trim()
    const order = orderText === '' ? null : Number(orderText)
    if (order !== null && !Number.isInteger(order)) {
      notify(t('settings.capsules.field.orderInvalid'), 'error')
      return
    }
    setBusy(true)
    try {
      await vaultCapsules.setMeta({
        relpath: capsule.relpath,
        title: draft.title.trim() || null,
        icon: draft.icon.trim() || null,
        description: draft.description.trim() || null,
        order,
      })
      notify(t('settings.capsules.notify.metaSaved', { name: capsule.title || capsule.name }), 'info')
      setEditing(null)
      await loadList()
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const resetMeta = async (capsule: VaultCapsule) => {
    setBusy(true)
    try {
      await vaultCapsules.setMeta({ relpath: capsule.relpath, reset: true })
      notify(t('settings.capsules.notify.metaReset', { name: capsule.title || capsule.name }), 'info')
      setEditing(null)
      await loadList()
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const removeCapsule = async (capsule: VaultCapsule) => {
    setBusy(true)
    try {
      const res = await vaultCapsules.remove({
        relpath: capsule.relpath,
        remove_data: removeData,
      })
      notify(
        t(res.kept_data ? 'settings.capsules.notify.deletedKeptData' : 'settings.capsules.notify.deleted', {
          name: capsule.title || capsule.name,
        }),
        'info',
      )
      setEditing(null)
      setConfirming(null)
      setRemoveData(false)
      await loadList()
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

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
              {/* 1. Turned off: one click puts the default location back (no typing, no folder picking) */}
              {problem === 'disabled' && (
                <>
                  <div className="text-[13px] font-medium text-[var(--ink-text)]">
                    {t('settings.capsules.disabled.title')}
                  </div>
                  <div className="ui-meta leading-relaxed">
                    {t('settings.capsules.disabled.description')}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void enableLibrary()}
                      className="ui-btn ui-btn--primary"
                    >
                      <Icon name="plus" />
                      {t('settings.capsules.disabled.enable')}
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
                    {t('settings.capsules.defaultLocation')}
                    <span className="ui-mono">{defaultDir}</span>
                  </div>
                </>
              )}

              {/* 2. Configured but broken: say exactly what is wrong and offer the matching fix */}
              {problem !== null && problem !== 'disabled' && (
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
                      onClick={() => void disableLibrary()}
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
                      title={brokenPath}
                    >
                      {brokenPath}
                    </span>
                    {usingDefault && (
                      <span className="ui-badge" title={t('settings.capsules.defaultBadgeTitle')}>
                        {t('settings.capsules.defaultBadge')}
                      </span>
                    )}
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      {desktop && libraryExists && (
                        <button
                          type="button"
                          onClick={() => void openFolder(brokenPath)}
                          className="ui-btn ui-btn--sm"
                        >
                          <Icon name="folder" />
                          {t('settings.capsules.openFolder')}
                        </button>
                      )}
                      {!usingDefault && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void useDefaultDir()}
                          className="ui-btn ui-btn--sm ui-btn--ghost"
                        >
                          {t('settings.capsules.useDefault')}
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
                        onClick={() => void disableLibrary()}
                        className="ui-btn ui-btn--sm ui-btn--ghost"
                      >
                        {t('settings.capsules.disable')}
                      </button>
                    </div>
                  </div>
                  <div className="ui-meta">
                    {t('settings.capsules.indexed', { count: items.length })}
                    {!libraryExists ? t('settings.capsules.createdOnFirstUse') : ''}
                  </div>
                </>
              )}

              {advanced && manualInput}
              {!advanced && isDirty && manualInput}

              {/* The optional front door: import copies a file in (the library is created on demand).
                  Dropping the .html into the folder by hand keeps working — same list either way. */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                  className="ui-btn ui-btn--sm"
                >
                  <Icon name="plus" size={12} />
                  {t('settings.capsules.import')}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".html,.htm,text/html"
                  className="hidden"
                  aria-label={t('settings.capsules.import')}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void importFile(file)
                  }}
                />
                <span className="ui-meta leading-relaxed">{t('settings.capsules.importHint')}</span>
              </div>
            </>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title={t('settings.capsules.list.title', { count: items.length })}
        description={t('settings.capsules.list.description')}
      >
        {(capsuleList?.stale_metadata ?? 0) > 0 && (
          <div className="ui-meta px-4 pt-3">
            {t('settings.capsules.stale', { count: capsuleList?.stale_metadata ?? 0 })}
          </div>
        )}
        {items.length > 0 ? (
          <div className="divide-y divide-[var(--ink-line)]">
            {items.map((capsule) => {
              const isDisabled = capsule.enabled === false
              const isSystem = capsule.source === 'system'
              const hasMeta = Object.keys(capsule.meta ?? {}).length > 0
              const folderCapsule = capsule.relpath.includes('/')
              const isEditing = editing === capsule.relpath
              return (
                <div
                  key={`${capsule.source}-${capsule.relpath}`}
                  data-capsule-row={capsule.relpath}
                  className={`transition-opacity ${
                    isDisabled ? 'opacity-60 bg-[var(--ink-bg-subtle,#f9f9f9)] dark:bg-white/5' : ''
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="w-6 h-6 flex items-center justify-center shrink-0">
                      <ToolIcon icon={capsule.icon} fallback="capsule" size={16} />
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
                        {hasMeta ? (
                          <span className="ui-badge" title={t('settings.capsules.list.customTitle')}>
                            {t('settings.capsules.list.custom')}
                          </span>
                        ) : null}
                        {isSystem ? (
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
                        {capsule.description ? (
                          <span className="truncate max-w-sm" title={capsule.description}>
                            {capsule.description}
                          </span>
                        ) : null}
                        <span>{sizeLabel(capsule.bytes)}</span>
                        <span className="ui-mono select-all truncate max-w-sm">{capsule.url}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => (isEditing ? setEditing(null) : startEdit(capsule))}
                        className="ui-btn ui-btn--sm ui-btn--ghost"
                      >
                        <Icon name="edit" size={12} />
                        {t('settings.capsules.edit')}
                      </button>
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

                  {/* Declared details (the overlay): every field optional, empty = keep what the page says */}
                  {isEditing && (
                    <div className="px-4 pb-4 space-y-3" data-capsule-editor={capsule.relpath}>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="block space-y-1">
                          <span className="ui-meta">{t('settings.capsules.field.title')}</span>
                          <input
                            type="text"
                            className="ui-input"
                            placeholder={t('settings.capsules.field.titlePlaceholder')}
                            value={draft.title}
                            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                          />
                        </label>
                        <label className="block space-y-1">
                          <span className="ui-meta">{t('settings.capsules.field.icon')}</span>
                          <input
                            type="text"
                            className="ui-input"
                            placeholder={t('settings.capsules.field.iconPlaceholder')}
                            value={draft.icon}
                            onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
                          />
                        </label>
                        <label className="block space-y-1">
                          <span className="ui-meta">{t('settings.capsules.field.description')}</span>
                          <input
                            type="text"
                            className="ui-input"
                            placeholder={t('settings.capsules.field.descriptionPlaceholder')}
                            value={draft.description}
                            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                          />
                        </label>
                        <label className="block space-y-1">
                          <span className="ui-meta">{t('settings.capsules.field.order')}</span>
                          <input
                            type="text"
                            inputMode="numeric"
                            className="ui-input"
                            placeholder={t('settings.capsules.field.orderPlaceholder')}
                            value={draft.order}
                            onChange={(e) => setDraft({ ...draft, order: e.target.value })}
                          />
                        </label>
                      </div>
                      <div className="ui-meta leading-relaxed">
                        {t('settings.capsules.field.hint')}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void saveMeta(capsule)}
                          className="ui-btn ui-btn--sm ui-btn--primary"
                        >
                          {t('settings.capsules.editSave')}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setEditing(null)}
                          className="ui-btn ui-btn--sm ui-btn--ghost"
                        >
                          {t('settings.capsules.editCancel')}
                        </button>
                        {hasMeta && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void resetMeta(capsule)}
                            className="ui-btn ui-btn--sm ui-btn--ghost"
                          >
                            {t('settings.capsules.editReset')}
                          </button>
                        )}
                        {!isSystem && (
                          <div className="ml-auto flex flex-wrap items-center gap-2">
                            {confirming === capsule.relpath ? (
                              <>
                                {folderCapsule && (
                                  <label className="flex items-center gap-1.5 ui-meta">
                                    <input
                                      type="checkbox"
                                      checked={removeData}
                                      disabled={busy}
                                      onChange={(e) => setRemoveData(e.target.checked)}
                                    />
                                    {t('settings.capsules.deleteData')}
                                  </label>
                                )}
                                <span className="ui-meta">{t('settings.capsules.deleteConfirmHint')}</span>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void removeCapsule(capsule)}
                                  className="ui-btn ui-btn--sm ui-btn--danger"
                                >
                                  {t('settings.capsules.deleteConfirm')}
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    setConfirming(null)
                                    setRemoveData(false)
                                  }}
                                  className="ui-btn ui-btn--sm ui-btn--ghost"
                                >
                                  {t('settings.capsules.editCancel')}
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  setConfirming(capsule.relpath)
                                  setRemoveData(false)
                                }}
                                className="ui-btn ui-btn--sm ui-btn--ghost"
                              >
                                <Icon name="trash" size={12} />
                                {t('settings.capsules.delete')}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="px-4 py-6 text-center ui-meta">
            {problem === 'disabled'
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
