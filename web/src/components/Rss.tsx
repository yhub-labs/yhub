import { useCallback, useEffect, useState } from 'react'
import { api, type RssFeed, type RssItem } from '../api'
import { CardState } from './Card'
import { Icon } from './icons/Icon'
import { useI18n } from '../i18n'

/**
 * RSS panel: one feed per row, each row can change URL / toggle / refresh / delete.
 *
 * One feed = one wall cell (`rss.<id>`). Everything here writes the same
 * `~/.yhub/rss.json` — editing the file by hand, the CLI, and this panel are equivalent.
 *
 * Display and calls only; fetching, parsing and state classification all live in the backend
 * (`yhub/server/adapters/_rss.py`). A feed whose URL cannot be read is **still saved**; the panel
 * flags it and says what to do — a broken feed should fail honestly on the wall, not let the user
 * save it and see "saved" while nothing happened.
 */
export default function Rss() {
  const { t } = useI18n()
  const [feeds, setFeeds] = useState<RssFeed[]>([])
  const [configPath, setConfigPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  // Add form
  const [draftUrl, setDraftUrl] = useState('')
  const [draftTitle, setDraftTitle] = useState('')
  // Inline editing (one row at a time)
  const [editing, setEditing] = useState<{ id: string; url: string; title: string } | null>(null)
  // Expanded item preview
  const [preview, setPreview] = useState<{ id: string; items: RssItem[] } | null>(null)

  const load = useCallback(async (live = true) => {
    setLoading(true)
    setError('')
    setHint('')
    try {
      const out = await api.rssList(live)
      setFeeds(out.feeds)
      setConfigPath(out.config_path)
    } catch (e) {
      setFeeds([])
      setError(e instanceof Error ? e.message : String(e))
      if (e && typeof e === 'object' && 'hint' in e) setHint(String((e as { hint: string }).hint))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** Single write path: refresh the list afterwards and surface the backend's human-readable note */
  async function act(key: string, fn: () => Promise<string>) {
    setBusy(key)
    setError('')
    setHint('')
    setNote('')
    try {
      setNote(await fn())
      await load(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      if (e && typeof e === 'object' && 'hint' in e) setHint(String((e as { hint: string }).hint))
    } finally {
      setBusy('')
    }
  }

  const add = () =>
    act('add', async () => {
      const out = await api.rssAdd({ url: draftUrl.trim(), title: draftTitle.trim() })
      setDraftUrl('')
      setDraftTitle('')
      if (out.feed.error) {
        throw Object.assign(new Error(t('rss.savedUnreadable', { title: out.feed.title, message: out.feed.error.message })), {
          hint: out.feed.error.hint,
        })
      }
      return t('rss.added', { title: out.feed.title, count: out.feed.items })
    })

  const save = () =>
    act('save', async () => {
      if (!editing) return ''
      const out = await api.rssAdd({
        id: editing.id,
        url: editing.url.trim(),
        title: editing.title.trim(),
      })
      setEditing(null)
      if (out.feed.error) {
        throw Object.assign(new Error(t('rss.saveUnreadable', { message: out.feed.error.message })), {
          hint: out.feed.error.hint,
        })
      }
      return t('rss.updated', { title: out.feed.title, count: out.feed.items })
    })

  const toggle = (feed: RssFeed) =>
    act(`toggle:${feed.id}`, async () => {
      const out = await api.rssAdd({
        id: feed.id,
        url: feed.url,
        title: feed.title,
        enabled: !feed.enabled,
      })
      return out.feed.enabled
        ? t('rss.toggledOn', { title: feed.title })
        : t('rss.toggledOff', { title: feed.title })
    })

  const refresh = (feed: RssFeed) =>
    act(`refresh:${feed.id}`, async () => {
      const out = await api.rssRefresh(feed.id)
      if (out.feed.error) {
        throw Object.assign(new Error(t('rss.refreshError', { title: feed.title, message: out.feed.error.message })), {
          hint: out.feed.error.hint,
        })
      }
      return t('rss.refreshed', { title: feed.title, count: out.feed.items })
    })

  const remove = (feed: RssFeed) =>
    act(`remove:${feed.id}`, async () => {
      await api.rssRemove(feed.id)
      if (preview?.id === feed.id) setPreview(null)
      return t('rss.removed', { title: feed.title })
    })

  const inspect = (feed: RssFeed) =>
    act(`items:${feed.id}`, async () => {
      if (preview?.id === feed.id) {
        setPreview(null)
        return ''
      }
      const out = await api.rssItems(feed.id, feed.limit)
      setPreview({ id: feed.id, items: out.items })
      return ''
    })

  return (
    <div className="space-y-3 text-sm text-[var(--ink-text)]" data-testid="rss-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className="ui-meta">
          {loading ? t('common.loading') : t('rss.count', { count: feeds.length })}
        </span>
        <button
          onClick={() => void load()}
          disabled={loading || !!busy}
          className="ui-btn ui-btn--ghost ui-btn--sm"
          title={t('rss.refreshAllTooltip')}
        >
          <Icon name="refresh" size={12} />
          {t('rss.refreshAll')}
        </button>
        {configPath && (
          <span
            className="ml-auto ui-meta ui-mono truncate max-w-[280px]"
            title={t('rss.configTooltip', { path: configPath })}
          >
            {configPath}
          </span>
        )}
      </div>

      {/* Add: a URL is enough, the title can follow later */}
      <div className="ui-section space-y-2" data-rss-add>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draftUrl.trim() && !busy) void add()
            }}
            placeholder={t('rss.urlPlaceholder')}
            aria-label={t('rss.urlLabel')}
            data-rss-new-url
            className="ui-input flex-1 min-w-[240px]"
            autoComplete="off"
          />
          <input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder={t('rss.titlePlaceholder')}
            aria-label={t('rss.titleLabel')}
            data-rss-new-title
            className="ui-input"
            style={{ flex: '0 0 170px' }}
            autoComplete="off"
          />
          <button
            onClick={() => void add()}
            disabled={!!busy || !draftUrl.trim()}
            className="ui-btn ui-btn--primary shrink-0"
            data-rss-add-btn
          >
            <Icon name="plus" size={13} />
            {busy === 'add' ? t('rss.reading') : t('rss.add')}
          </button>
        </div>
        <div className="ui-meta">{t('rss.addHelp')}</div>
      </div>

      {error && (
        <CardState kind="error" hint={hint || undefined}>
          {error}
        </CardState>
      )}
      {!error && note && <div className="ui-meta text-[var(--ink-ok-text)]">{note}</div>}

      {!loading && feeds.length === 0 && !error && (
        <CardState kind="empty">{t('rss.empty')}</CardState>
      )}

      <div className="space-y-2">
        {feeds.map((feed) => {
          const editingThis = editing?.id === feed.id
          const hasError = !!feed.error
          return (
            <div
              key={feed.id}
              data-rss-feed={feed.id}
              className="rounded-[var(--radius)] border border-[var(--ink-line)] bg-[var(--ink-2)] px-4 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`ui-dot ${hasError ? 'ui-dot--warn' : feed.enabled ? 'ui-dot--ok' : 'ui-dot--idle'}`}
                  aria-hidden="true"
                />
                <span className="font-medium text-[var(--ink-text)] truncate max-w-[40%]">
                  {feed.title}
                </span>
                <span className="ui-badge ui-mono">{feed.id}</span>
                <span className="ui-meta">
                  {hasError
                    ? t('rss.readError', { message: feed.error?.message ?? '' })
                    : feed.items > 0
                      ? t('rss.itemsMeta', {
                          count: feed.items,
                          when: feed.fetched_at?.slice(5, 16).replace('T', ' ') ?? '—',
                        })
                      : t('rss.neverFetched')}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  <button
                    onClick={() => void inspect(feed)}
                    disabled={!!busy || hasError}
                    className="ui-btn ui-btn--ghost ui-btn--sm"
                    data-rss-preview={feed.id}
                    title={t('rss.previewTooltip')}
                  >
                    {preview?.id === feed.id ? t('rss.collapse') : t('rss.preview')}
                  </button>
                  <button
                    onClick={() => void refresh(feed)}
                    disabled={!!busy}
                    className="ui-btn ui-btn--ghost ui-btn--icon"
                    title={t('rss.refreshTooltip')}
                    aria-label={t('rss.refreshAria', { title: feed.title })}
                  >
                    <Icon name="refresh" size={13} />
                  </button>
                  <button
                    onClick={() => void toggle(feed)}
                    disabled={!!busy}
                    className="ui-btn ui-btn--ghost ui-btn--sm"
                    data-rss-toggle={feed.id}
                    title={feed.enabled ? t('rss.takeOffWallTooltip') : t('rss.putOnWallTooltip')}
                  >
                    {feed.enabled ? t('rss.onWall') : t('rss.offWall')}
                  </button>
                  <button
                    onClick={() =>
                      setEditing(
                        editingThis
                          ? null
                          : { id: feed.id, url: feed.url, title: feed.title },
                      )
                    }
                    className="ui-btn ui-btn--ghost ui-btn--icon"
                    data-rss-edit={feed.id}
                    title={t('rss.editTooltip')}
                    aria-label={t('rss.editAria', { title: feed.title })}
                  >
                    <Icon name="edit" size={13} />
                  </button>
                  <button
                    onClick={() => void remove(feed)}
                    disabled={!!busy}
                    className="ui-btn ui-btn--ghost ui-btn--icon"
                    data-rss-remove={feed.id}
                    title={t('rss.removeTooltip')}
                    aria-label={t('rss.removeAria', { title: feed.title })}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </span>
              </div>

              {editingThis ? (
                <div className="mt-2 flex flex-wrap items-center gap-2" data-rss-edit-form={feed.id}>
                  <input
                    value={editing.url}
                    onChange={(e) => setEditing({ ...editing, url: e.target.value })}
                    aria-label={t('rss.urlLabel')}
                    className="ui-input flex-1 min-w-[240px]"
                    autoComplete="off"
                  />
                  <input
                    value={editing.title}
                    onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                    aria-label={t('rss.titleLabel')}
                    className="ui-input"
                    style={{ flex: '0 0 150px' }}
                    autoComplete="off"
                  />
                  <button
                    onClick={() => void save()}
                    disabled={!!busy || !editing.url.trim()}
                    className="ui-btn ui-btn--primary ui-btn--sm shrink-0"
                  >
                    {busy === 'save' ? t('rss.saving') : t('common.save')}
                  </button>
                  <button onClick={() => setEditing(null)} className="ui-btn ui-btn--ghost ui-btn--sm">
                    {t('common.cancel')}
                  </button>
                </div>
              ) : (
                <div className="ui-meta ui-mono mt-1 truncate" title={feed.url}>
                  {feed.url}
                </div>
              )}

              {hasError && feed.error?.hint && (
                <div className="mt-1 text-[11px] text-[var(--ink-warn-text)]">{feed.error.hint}</div>
              )}

              {preview?.id === feed.id && (
                <ul className="mt-2 space-y-1 border-t border-[var(--ink-line)] pt-2">
                  {preview.items.map((item, i) => (
                    <li key={`${item.href}-${i}`} className="flex items-baseline gap-2 text-[13px]">
                      <span className="ui-mono text-[11px] text-[var(--ink-text-3)] shrink-0 w-[74px]">
                        {item.published_text || '—'}
                      </span>
                      {item.href ? (
                        <a
                          href={item.href}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate text-[var(--ink-text)] hover:underline decoration-dotted underline-offset-2"
                          title={item.href}
                        >
                          {item.title}
                        </a>
                      ) : (
                        <span className="truncate">{item.title}</span>
                      )}
                    </li>
                  ))}
                  {preview.items.length === 0 && <li className="ui-meta">{t('rss.previewEmpty')}</li>}
                </ul>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
