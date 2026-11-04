import { useCallback, useEffect, useState } from 'react'
import { api, type RcloneProbe, type RcloneStatus } from '../api'
import { CardState } from './Card'
import { Icon } from './icons/Icon'
import { t, useI18n } from '../i18n'

/**
 * Rclone disk panel: mount / unmount / inspect.
 *
 * Three contracts shared with the backend that this UI must not break:
 *  1. **The password is used for this one mount only**: it lives in component state and is
 *     cleared the moment it is submitted — never in localStorage, never echoed back, never in
 *     any list (the backend does not store it either).
 *  2. **The monitor looks at the mount itself**: mountpoint, process, last probe's entry count
 *     and capacity. The backend holds no password, so it never asks the remote.
 *  3. One remote mounts at one mountpoint at a time: unmount before changing it.
 */
function Row({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  const color =
    tone === 'ok'
      ? 'text-[var(--ink-ok-text)]'
      : tone === 'warn'
        ? 'text-[var(--ink-warn-text)]'
        : 'text-[var(--ink-text)]'
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-xs text-[var(--ink-text-3)] shrink-0">{label}</span>
      <span className={`text-xs ui-mono tabular-nums text-right break-all ${color}`}>{value}</span>
    </div>
  )
}

function human(size?: number | null): string {
  if (size === null || size === undefined) return '—'
  let value = size
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
    if (value < 1024 || unit === 'TB') return unit === 'B' ? `${Math.round(value)}B` : `${value.toFixed(1)}${unit}`
    value /= 1024
  }
  return '—'
}

function probeLine(p: RcloneProbe | null, at: string | null): string {
  if (!p) return t('rclone.probeNever')
  if (!p.ok) return t('rclone.probeFail', { reason: p.error ?? t('rclone.probeFailReason') })
  const line = t('rclone.probeResult', {
    dirs: p.dirs ?? 0,
    files: p.files ?? 0,
    total: human(p.total),
    free: human(p.free),
    ms: p.took_ms ?? 0,
  })
  return at ? `${line} · ${at}` : line
}

export default function Rclone({ onStatusChange }: { onStatusChange?: () => void }) {
  const { t } = useI18n()
  const [st, setSt] = useState<RcloneStatus | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  // Remote whose mount form is expanded
  const [form, setForm] = useState('')
  const [dir, setDir] = useState('')
  const [password, setPassword] = useState('')
  // Extra args: a raw string of rclone flags, passed through; cache mode is fixed elsewhere, not chosen here
  const [extra, setExtra] = useState('')

  const load = useCallback(async () => {
    try {
      const out = await api.rclone()
      setSt(out)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 5000) // The watcher is a backend thread; this only reads its result
    return () => clearInterval(timer)
  }, [load])

  function openForm(name: string, suggested: string) {
    setForm(name)
    setDir(suggested)
    setPassword('')
    setExtra('')
    setNote('')
  }

  async function doMount(name: string) {
    setBusy(`mount:${name}`)
    setError('')
    setNote('')
    try {
      const payload: { name: string; mountpoint: string; extra?: string; password?: string } = {
        name,
        mountpoint: dir.trim(),
      }
      if (extra.trim()) payload.extra = extra.trim()
      if (password) payload.password = password
      const out = await api.rcloneMount(payload)
      setNote(t('rclone.mountedNote', { name: out.mounted.name, mountpoint: out.mounted.mountpoint }))
      setForm('')
      setPassword('')
      setSt(out.status)
      onStatusChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      if (e && typeof e === 'object' && 'hint' in e) setNote(String((e as { hint: string }).hint))
    } finally {
      setPassword('')
      setBusy('')
    }
  }

  async function doUmount(name: string) {
    setBusy(`umount:${name}`)
    setError('')
    setNote('')
    try {
      const out = await api.rcloneUmount(name)
      setNote(t('rclone.unmountedNote', { name }))
      // Careful: `out` is an action envelope; the state is `out.status` (setSt(out) renders the panel blank/crashing)
      setSt(out.status)
      onStatusChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  async function doProbe(name: string) {
    setBusy(`probe:${name}`)
    setError('')
    try {
      const out = await api.rcloneProbe(name)
      setSt(out.status)
      setNote(t('rclone.probeNote', { name, line: probeLine(out.probe, out.probe.at ?? null) }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  if (!st) return <CardState kind="loading">{t('rclone.loading')}</CardState>

  const mountedCount = st.mounts.filter((m) => m.mounted).length

  return (
    <div className="space-y-4">
      {/* Top: one-line status + environment */}
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`ui-badge ${
            !st.rclone.installed ? '' : mountedCount > 0 ? 'ui-badge--ok' : ''
          }`}
        >
          <span
            className={`ui-dot ${
              !st.rclone.installed ? 'ui-dot--idle' : mountedCount > 0 ? 'ui-dot--ok' : 'ui-dot--idle'
            }`}
          />
          {!st.rclone.installed
            ? t('rclone.notInstalled')
            : mountedCount > 0
              ? t('rclone.mountedCount', { count: mountedCount })
              : t('rclone.notMounted')}
        </span>
        <span className="ui-mono ui-meta truncate max-w-[22rem]">
          {st.rclone.version || t('rclone.noVersion')}
        </span>
        <button onClick={() => void load()} className="ui-btn ui-btn--ghost ui-btn--sm ml-auto">
          <Icon name="refresh" size={12} />
          {t('rclone.refresh')}
        </button>
      </div>

      {/* Remotes from the config */}
      <div className="space-y-2">
        <div className="ui-section__title">{t('rclone.remotesTitle', { path: st.rclone.config })}</div>
        {st.remotes.length === 0 && (
          <CardState kind="empty">
            {t('rclone.emptyPrefix')}
            <code className="font-mono">rclone config</code>
            {t('rclone.emptyMiddle')}
            <code className="font-mono mx-1">RCLONE_CONFIG</code>
            {t('rclone.emptySuffix')}
          </CardState>
        )}
        {st.remotes.map((r) => (
          <div
            key={r.name}
            className="rounded-[var(--radius)] border border-[var(--ink-line)] bg-[var(--ink-2)] px-4 py-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{r.name}</span>
              <span className="ui-badge">{r.type}</span>
              {r.encrypted && (
                <span className="ui-badge ui-badge--warn">
                  <Icon name="shield" size={11} />
                  {t('rclone.badgeEncrypted')}
                </span>
              )}
              {r.needs_password && <span className="ui-badge">{t('rclone.badgeNeedsPassword')}</span>}
              <span className="ui-meta ui-mono truncate max-w-[16rem]">{r.target}</span>
              <div className="ml-auto flex gap-2">
                {r.mounted ? (
                  <>
                    <button
                      onClick={() => void doProbe(r.name)}
                      disabled={!!busy}
                      className="ui-btn ui-btn--sm"
                    >
                      {busy === `probe:${r.name}` ? t('rclone.probing') : t('rclone.probe')}
                    </button>
                    <button
                      onClick={() => void doUmount(r.name)}
                      disabled={!!busy}
                      className="ui-btn ui-btn--sm"
                    >
                      {busy === `umount:${r.name}` ? t('rclone.unmounting') : t('rclone.unmount')}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => (form === r.name ? setForm('') : openForm(r.name, r.mountpoint))}
                    disabled={!!busy || !st.rclone.installed}
                    className="ui-btn ui-btn--primary ui-btn--sm"
                  >
                    {t('rclone.mount')}
                  </button>
                )}
              </div>
            </div>

            {r.mounted && (
              <div className="mt-2 divide-y divide-[var(--ink-line)]">
                <Row label={t('rclone.mountpoint')} value={r.mountpoint} tone="ok" />
                <Row label={t('rclone.pid')} value={r.pid ? `${r.pid}` : '—'} tone={r.pid_alive ? 'ok' : 'warn'} />
                <Row label={t('rclone.mountedAt')} value={r.uptime ?? '—'} />
              </div>
            )}

            {form === r.name && !r.mounted && (
              <div className="mt-3 space-y-3 rounded-[var(--radius)] border border-[var(--ink-line)] bg-[var(--ink-3)] p-3">
                <label className="block text-[11px] text-[var(--ink-text-2)]">
                  {t('rclone.mountpointDefaultPrefix')}
                  <code className="font-mono">~/{r.name}</code>
                  {t('rclone.mountpointDefaultSuffix')}
                  <input
                    value={dir}
                    onChange={(e) => setDir(e.target.value)}
                    spellCheck={false}
                    className="ui-input ui-mono mt-1"
                  />
                </label>
                {r.needs_password && (
                  <label className="block text-[11px] text-[var(--ink-text-2)]">
                    {t('rclone.passwordLabel')}
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={t('rclone.passwordPlaceholder')}
                      className="ui-input ui-mono mt-1"
                    />
                    <span className="mt-1 block ui-meta">{t('rclone.passwordHint')}</span>
                  </label>
                )}
                <label className="block text-[11px] text-[var(--ink-text-2)]">
                  {t('rclone.extraLabel')}
                  <input
                    value={extra}
                    onChange={(e) => setExtra(e.target.value)}
                    spellCheck={false}
                    placeholder={t('rclone.extraPlaceholder')}
                    className="ui-input ui-mono mt-1"
                  />
                  <span className="mt-1 block ui-meta">
                    {t('rclone.cacheHintPrefix')}
                    <code className="font-mono">{st.vfs_cache_mode}</code>
                    {t('rclone.cacheHintAfterMode')}
                    <code className="font-mono mx-1">--vfs-cache-mode off</code>
                    {t('rclone.cacheHintAfterOverride')}
                    <code className="font-mono mx-1">ps</code>
                    {t('rclone.cacheHintSuffix')}
                  </span>
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => void doMount(r.name)}
                    disabled={!!busy}
                    className="ui-btn ui-btn--primary ui-btn--sm"
                  >
                    {busy === `mount:${r.name}` ? t('rclone.mounting') : t('rclone.confirmMount')}
                  </button>
                  <button
                    onClick={() => {
                      setForm('')
                      setPassword('')
                    }}
                    className="ui-btn ui-btn--sm"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Live mounts */}
      {st.mounts.length > 0 && (
        <div className="space-y-2">
          <div className="ui-section__title">
            {t('rclone.liveTitle', { tick: st.watcher.tick_seconds, probe: st.watcher.probe_every })}
          </div>
          {st.mounts.map((m) => (
            <div
              key={m.name}
              className={`rounded-[var(--radius)] border px-4 py-3 ${
                m.dropped || m.degraded
                  ? 'border-[color-mix(in_srgb,var(--ink-warn)_35%,transparent)] bg-[var(--ink-warn-quiet)]'
                  : 'border-[var(--ink-line)] bg-[var(--ink-2)]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-[var(--ink-text)]">{m.name}</span>
                <span className="ui-meta ui-mono">{m.remote}</span>
                {m.read_only && <span className="ui-badge">{t('rclone.readOnly')}</span>}
                <span
                  className={`ui-badge ${
                    m.dropped || m.degraded || m.stale ? 'ui-badge--warn' : 'ui-badge--ok'
                  }`}
                >
                  <span className={`ui-dot ${m.dropped || m.degraded || m.stale ? 'ui-dot--warn' : 'ui-dot--ok'}`} />
                  {m.dropped
                    ? t('rclone.statusDropped')
                    : m.degraded
                      ? t('rclone.statusDegraded')
                      : m.stale
                        ? t('rclone.statusStale')
                        : t('rclone.statusMounted')}
                </span>
              </div>
              <div className="mt-1 divide-y divide-[var(--ink-line)]">
                <Row label={t('rclone.mountpoint')} value={m.mountpoint} />
                <Row label={t('rclone.source')} value={m.source_now ?? m.source ?? '—'} />
                <Row label={t('rclone.pid')} value={m.pid ? `${m.pid}` : '—'} tone={m.pid_alive ? 'ok' : 'warn'} />
                <Row label={t('rclone.cacheMode')} value={m.cache} />
                {m.extra_args && m.extra_args.length > 0 && (
                  <Row label={t('rclone.extraArgs')} value={m.extra_args.join(' ')} />
                )}
                {m.preflight && <Row label={t('rclone.preflight')} value={m.preflight} />}
                {m.probe_stuck_seconds ? (
                  <Row
                    label={t('rclone.probe')}
                    value={t('rclone.probeStuck', { seconds: m.probe_stuck_seconds })}
                    tone="warn"
                  />
                ) : (
                  m.probe_running && <Row label={t('rclone.probe')} value={t('rclone.probingMount')} />
                )}
                <Row label={t('rclone.mountedAt')} value={m.started_at} />
                <Row
                  label={t('rclone.lastProbe')}
                  value={probeLine(m.probe, m.probed_at)}
                  tone={m.probe && !m.probe.ok ? 'warn' : undefined}
                />
                {m.probe?.names && m.probe.names.length > 0 && (
                  <Row
                    label={t('rclone.firstEntries')}
                    value={m.probe.names.slice(0, 5).join(t('rclone.entrySeparator'))}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {st.untracked.length > 0 && (
        <div className="rounded-[var(--radius)] border border-[var(--ink-line)] bg-[var(--ink-2)] px-4 py-3">
          <div className="ui-section__title">{t('rclone.untrackedTitle')}</div>
          {st.untracked.map((u) => (
            <Row key={u.mountpoint} label={u.mountpoint} value={u.source} />
          ))}
        </div>
      )}

      {error && <CardState kind="error">{error}</CardState>}
      {note && <div className="ui-meta break-all">{note}</div>}

      <div className="ui-meta leading-relaxed">{t('rclone.footer')}</div>
    </div>
  )
}
