import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import type { CardSpan } from './Card'
import { Icon } from './icons/Icon'
import { ToolIcon } from './icons/ToolIcon'

/**
 * Component library (part of desktop edit mode): everything **not currently on the desktop**,
 * click once to put it back.
 *
 * Same mental model as a phone home screen: edit mode opens a widget/app drawer holding
 * everything available but unplaced; one click (or drag) puts it back. "Not on the desktop"
 * here means hidden cells (`prefs.hidden`) and icons that sit in no folder.
 *
 * Rendering and callbacks only: finding a free slot and persisting belongs to Dashboard,
 * the one place that knows the layout. This panel touches neither localStorage nor the backend.
 */

export interface LibraryItem {
  id: string
  title: string
  /** Icon glyph (emoji or image URL); falls back to the category when a cell has no icon */
  icon: string
  kind: 'cell' | 'icon'
  /** Owning app / plugin / category identifier */
  appId?: string
  /** Owning app / plugin / module name, used as the group heading (e.g. zdic, Rclone disks, service monitor) */
  appName?: string
  /** The owning app's main icon */
  appIcon?: string
  /** Drawer group heading (appName preferred, group as fallback) */
  group: string
  span: CardSpan
}

export interface ComponentLibraryProps {
  items: LibraryItem[]
  /** Click = place back on the desktop (a free slot is found automatically) */
  onAdd: (id: string) => void
  onClose: () => void
}

export default function ComponentLibrary({ items, onAdd, onClose }: ComponentLibraryProps) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  /** The item being dragged (payload travels in dataTransfer; this only drives visuals) */
  const [dragging, setDragging] = useState<string | null>(null)

  interface AppGroup {
    key: string
    name: string
    icon?: string
    items: LibraryItem[]
  }

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? items.filter(
          (i) =>
            i.title.toLowerCase().includes(q) ||
            i.id.toLowerCase().includes(q) ||
            (i.appName && i.appName.toLowerCase().includes(q)),
        )
      : items

    const map = new Map<string, AppGroup>()
    for (const item of filtered) {
      const key = item.appId || item.appName || item.group
      const name = item.appName || item.group
      const icon = item.appIcon || (item.kind === 'icon' ? item.icon : undefined)
      if (!map.has(key)) {
        map.set(key, { key, name, icon, items: [] })
      }
      map.get(key)!.items.push(item)
    }

    // Icons (launch entries) first, then cards/status cells, each alphabetically
    for (const g of map.values()) {
      g.items.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'icon' ? -1 : 1
        return a.title.localeCompare(b.title)
      })
    }

    return [...map.values()]
  }, [items, query])

  return (
    <aside
      data-component-library
      aria-label={t('dashboard.library')}
      className="bento-library w-64 shrink-0 flex flex-col rounded-[var(--radius-lg)] border border-[var(--ink-line-strong)] bg-[var(--ink-2)]"
    >
      <header className="flex items-center gap-2 border-b border-[var(--ink-line)] px-3 py-2">
        <Icon name="library" size={14} className="text-[var(--ink-text-2)]" />
        <span className="text-[13px] font-medium text-[var(--ink-text)]">{t('dashboard.library')}</span>
        <span className="ui-meta">{t('dashboard.library.available', { count: items.length })}</span>
        <button
          type="button"
          onClick={onClose}
          className="ui-btn ui-btn--ghost ui-btn--sm ml-auto"
          title={t('dashboard.library.collapseTooltip')}
        >
          {t('dashboard.library.collapse')}
        </button>
      </header>

      <div className="border-b border-[var(--ink-line)] px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('dashboard.library.searchPlaceholder')}
          aria-label={t('dashboard.library.searchAria')}
          className="ui-input"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {items.length === 0 ? (
          <div className="px-2 py-6 text-center ui-meta">
            {t('dashboard.library.empty')}
          </div>
        ) : groups.length === 0 ? (
          <div className="px-2 py-6 text-center ui-meta">{t('dashboard.library.noMatch')}</div>
        ) : (
          groups.map((group) => (
            <section key={group.key} className="mb-3.5">
              <div className="flex items-center gap-1.5 px-1 pb-1.5 text-[11px] font-medium text-[var(--ink-text-3)]">
                <ToolIcon icon={group.icon} fallback="folder" size={13} />
                <span className="truncate">{group.name}</span>
                <span className="ml-auto ui-mono">{group.items.length}</span>
              </div>
              <div className="space-y-1">
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-library-item={item.id}
                    draggable
                    onDragStart={(e) => {
                      // Two payloads: the custom MIME this component reads, plus text/plain as a
                      // fallback that also makes the browser start the drag. The wall handles the drop.
                      e.dataTransfer.setData('application/x-yhub-component', item.id)
                      e.dataTransfer.setData('text/plain', item.id)
                      e.dataTransfer.effectAllowed = 'copy'
                      setDragging(item.id)
                    }}
                    onDragEnd={() => setDragging(null)}
                    onClick={() => onAdd(item.id)}
                    title={t('dashboard.library.itemTooltip', { title: item.title })}
                    className={`flex w-full items-center gap-2 rounded-[var(--radius)] border px-2 py-1.5 text-left transition-colors ${
                      dragging === item.id
                        ? 'border-[var(--ink-accent)] bg-[var(--ink-accent-quiet)] opacity-60'
                        : 'border-[var(--ink-line)] bg-[var(--ink-3)] hover:bg-[var(--ink-4)]'
                    }`}
                  >
                    <ToolIcon icon={item.icon} fallback={item.kind === 'icon' ? 'plugin' : 'library'} size={14} />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--ink-text)]">
                      {item.title}
                    </span>
                    <span className="shrink-0 ui-badge">
                      {item.kind === 'icon' ? t('dashboard.library.iconBadge') : item.span}
                    </span>
                    <Icon name="plus" size={12} className="shrink-0 text-[var(--ink-text-3)]" />
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      <footer className="border-t border-[var(--ink-line)] px-3 py-2 ui-meta leading-relaxed">
        {t('dashboard.library.footerPrefix')}
        <b className="font-normal text-[var(--ink-text-2)]">{t('dashboard.library.footerBold')}</b>
        {t('dashboard.library.footerSuffix')}
      </footer>
    </aside>
  )
}
