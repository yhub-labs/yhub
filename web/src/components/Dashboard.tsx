import { useCallback, useEffect, useRef, useState, type MouseEvent, type TouchEvent as ReactTouchEvent } from 'react'
import ReactGridLayout, {
  noCompactor,
  useContainerWidth,
  verticalCompactor,
  type Layout,
  type LayoutItem,
} from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import { api, capsules, ApiError, type Cell, type CellListResult, type PluginConfigTool, type Tool, type VaultCapsule } from '../api'
import { tauriBridge, isTauri } from '../tauriBridge'
import { t, useI18n } from '../i18n'
import Card, { CardState, type CardSpan, type CardTone } from './Card'
import { Icon, type IconName } from './icons/Icon'
import { ToolIcon } from './icons/ToolIcon'
import PanelCustomize from './PanelCustomize'
import ComponentLibrary, { type LibraryItem } from './ComponentLibrary'
import { vaultCapsuleTitle } from './Launcher'
import type { CardSize, PackingMode, PanelPrefs, ThemeMode, WallFolder, WallLayoutEntry } from '../panelPrefs'
import {
  BASE_COLS,
  GRID_GAP,
  PHONE_COLS,
  ROW_PX,
  TABLET_COLS,
  clampEntry,
  findFreeSlot,
  fixedIconEntry,
  folderTileId,
  isIconId,
  minBox,
  packPages,
  rowsForContent,
  tierBox,
  tierOf,
  toBaseEntry,
  visibleItems,
  type PackerItem,
} from '../wallLayout'

/**
 * The wall (M1~M6): rendering only.
 *
 * Contract highlights (api-contract.md):
 *  - one GET returns everything (/api/dashboard/cells); loading / empty / error are all local states,
 *    the page never blanks out;
 *  - `status` and `staleness` are computed server-side; updated_at is never re-thresholded here;
 *  - polling follows next_refresh_in from the envelope and pauses while the page is hidden;
 *  - cells with `enabled: false` are hidden by the frontend; a click is a deep link (href), nothing
 *    expands or edits inside the panel;
 *  - dimming reads staleness directly; relative times use Asia/Shanghai in 24-hour form.
 *
 * **Layout**: the bento grid now serves only this wall — every cell is a `.bento-card`, each island
 * packs a `.bento-grid`, and the alerts overview spans the top (styles in `src/bento.css`).
 * Size/visibility prefs are keyed by **cell id** in `panelPrefs.sizes/hidden` (edited by the wall's
 * "Customize" control).
 *
 * **App icons**: render fixed 1×1 icon tiles aggregated from `/api/tools` (minus dashboard itself)
 * and capsules; they share the paged grid with cells, can be dragged freely, but cannot be resized.
 * A click opens a tool page or an HTML capsule in a new tab / the system browser. Icon ids are
 * `tool:<id>` / `app:<relpath>` and share `panelPrefs.hidden/layout` with cells.
 */

/**
 * Default grid footprint per cell (a registry): the alerts overview spans the top, everything else is 6×2.
 * The scale lives in `tierBox` (wallLayout.ts): 12-column base × 80px rows.
 * Unregistered ids (dynamic ones like `cron.<job>`) fall back to `DEFAULT_CELL_SPAN`; sizes changed
 * per cell in "Customize" live in `panelPrefs.sizes` and win over this table.
 */
const CELL_SPANS: Record<string, CardSpan> = {
  'overview.alerts': 'full',
}
const DEFAULT_CELL_SPAN: CardSpan = 'md'
/** Grid gap lives in wallLayout.ts (`GRID_GAP`): drop math and RGL's margin must use the same value */
function cellSpan(id: string): CardSpan {
  return CELL_SPANS[id] ?? DEFAULT_CELL_SPAN
}

/**
 * Schematic icon for a cell (component library and card headers): the cells response has no icon field,
 * so give a stable one by id prefix. Cosmetic only — unknown prefixes get a neutral block.
 */
function cellIcon(id: string): IconName {
  const prefix = id.split('.')[0]
  const table: Record<string, IconName> = {
    overview: 'dashboard',
    svc: 'stethoscope',
    sync: 'sync',
    kb: 'zdic',
    rclone: 'rclone',
    cron: 'scheduler',
  }
  return table[prefix] ?? 'library'
}

/** Loading skeleton: shaped like the loaded wall (overview spanning the top + two per row), so it never jumps from messy to aligned */
const SKELETON_SPANS: CardSpan[] = ['full', 'md', 'md', 'md', 'md']

/** Cell status → header dot tone (alert = red, using Card's error level) */
const TONE: Record<Cell['status'], CardTone> = { ok: 'ok', warn: 'warn', alert: 'error' }

const STATUS_STYLE: Record<
  Cell['status'],
  { dot: string; text: string; badge: string; border: string; labelKey: string }
> = {
  ok: {
    dot: 'ui-dot ui-dot--ok',
    text: 'text-[var(--ink-ok-text)]',
    badge: 'ui-badge ui-badge--ok',
    border: 'border-[var(--ink-line)]',
    labelKey: 'dashboard.status.ok',
  },
  warn: {
    dot: 'ui-dot ui-dot--warn',
    text: 'text-[var(--ink-warn-text)]',
    badge: 'ui-badge ui-badge--warn',
    border: 'border-[var(--ink-warn)]',
    labelKey: 'dashboard.status.warn',
  },
  alert: {
    dot: 'ui-dot ui-dot--error',
    text: 'text-[var(--ink-danger-text)]',
    badge: 'ui-badge ui-badge--error',
    border: 'border-[var(--ink-danger)]',
    labelKey: 'dashboard.status.alert',
  },
}

// Zones retired in phase C (D7): `zone/order` only remains as ordering metadata for the default
// placement (see packPages in wallLayout.ts); page dots and folders replaced the visual zone headers.

/** Absolute time: Asia/Shanghai, 24-hour (contract §1) */
const ABS_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const CLOCK_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

function absTime(iso: string): string {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '—' : ABS_FMT.format(t)
}

/** Relative time: computed once per render, so the panel stays still instead of ticking every second */
function relTime(iso: string, now: number): string {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return '—'
  const diff = now - parsed
  if (diff < 60_000) return t('dashboard.age.justNow')
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return t('dashboard.age.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('dashboard.age.hours', { count: hours })
  const days = Math.floor(hours / 24)
  if (days <= 3) return t('dashboard.age.days', { count: days })
  return absTime(iso)
}

/** Staleness badge: the key is translated where it is rendered (module tables never freeze copy) */
const STALE_LABEL_KEYS: Record<NonNullable<Cell['staleness']>, string> = {
  fresh: '',
  stale: 'dashboard.stale.stale',
  expired: 'dashboard.stale.expired',
}

/** Deep links always open in a new tab / the system handler: the panel must not navigate the host webview */
function linkProps(href: string | undefined) {
  return href ? { href, target: '_blank' as const, rel: 'noreferrer' } : {}
}

/**
 * Handle for the wall's "Customize" control: preference state belongs to the host (App.tsx) —
 * the theme must be applied to `<html data-theme>`, so it has to live at the outermost level.
 */
export interface WallCustomize {
  prefs: PanelPrefs
  /**
   * Desktop edit mode (the phone home screen's "edit"): enables drag handles, remove buttons and the component library.
   * Separate from `open` below (the customize popover) — merging the two once made the popover cover
   * the wall and swallow every handle click (measured).
   */
  editMode: boolean
  setEditMode: (open: boolean) => void
  /** "Customize" popover (appearance + per-cell size/visibility) */
  open: boolean
  setOpen: (open: boolean) => void
  onTheme: (theme: ThemeMode) => void
  onSize: (id: string, size: CardSize | null) => void
  onToggleHidden: (id: string) => void
  onReset: () => void
  /** Phase C: persist drag placement (id → page + in-page position) */
  onLayout: (layout: Record<string, WallLayoutEntry>) => void
  /** Phase C: icon folder changes */
  onFolders: (folders: WallFolder[]) => void
  /** P2: packing mode (compact packs up / free does not) */
  onPacking: (packing: PackingMode) => void
}

/**
 * Size presets (P2's "size tiles"): one-to-one with `tierBox`, and the values are footprints on the
 * **12-column base** — persisting does not clamp them to the current column count (narrow screens
 * converge via `visibleItems`), otherwise picking "full width" on a phone would leave half a row on
 * a desktop display.
 */
const SIZE_PRESETS: { value: CardSize; labelKey: string }[] = [
  { value: 'sm', labelKey: 'dashboard.size.sm' },
  { value: 'md', labelKey: 'dashboard.size.md' },
  { value: 'lg', labelKey: 'dashboard.size.lg' },
  { value: 'full', labelKey: 'dashboard.size.full' },
]

function CellCard({ cell, now, span, editMode, onNatural, measureToken }: {
  cell: Cell
  now: number
  span: CardSpan
  /** Edit mode: kill every navigation (whole card, card title, detail links) to prevent misclicks */
  editMode: boolean
  /** P3: report the content's natural height (drives content-adaptive height) */
  onNatural?: (px: number) => void
  /** Change it to re-measure (used when auto-height is on) */
  measureToken?: number
}) {
  const { t } = useI18n()
  const st = STATUS_STYLE[cell.status] ?? STATUS_STYLE.warn
  const dim = cell.staleness !== undefined && cell.staleness !== 'fresh'
  const staleKey = cell.staleness ? STALE_LABEL_KEYS[cell.staleness] : ''
  const staleLabel = staleKey ? t(staleKey) : ''
  const detail = cell.detail ?? []
  // Edit mode always renders as "no link": without an href the browser has no clickable area at all
  const hasLink = !editMode && !!cell.href && cell.href !== '#'
  const summary = cell.summary || '—'

  const meta = (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-neutral-400 font-mono">
      <span title={t('dashboard.lastSuccess', { time: cell.updated_at })}>
        {t('dashboard.updatedAt', { time: absTime(cell.updated_at) })}
      </span>
      {cell.staleness && cell.staleness !== 'fresh' && (
        <span>{t('dashboard.threshold', { seconds: cell.stale_after })}</span>
      )}
      <span className="truncate" title={t('dashboard.source', { source: cell.source })}>
        · {cell.source}
      </span>
    </div>
  )

  return (
    <Card
      id={cell.id}
      title={cell.title}
      titleHref={hasLink ? cell.href : undefined}
      span={span}
      dataAttrs={{
        'data-cell': cell.id,
        'data-status': cell.status,
        'data-staleness': cell.staleness ?? '',
      }}
      status={{ tone: TONE[cell.status] ?? 'warn', label: t(st.labelKey) }}
      onNatural={onNatural}
      measureToken={measureToken}
      actions={
        <>
          {staleLabel && (
            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-neutral-400 border border-white/10">
              {staleLabel}
            </span>
          )}
          <span
            className={`shrink-0 text-[11px] ${st.text}`}
            title={t('dashboard.lastSuccess', { time: cell.updated_at })}
          >
            {relTime(cell.updated_at, now)}
          </span>
        </>
      }
    >
      {/* Whole body is clickable = deep link (the header title has its own link to the same target);
          each detail row carries its own href, so no nested <a> */}
      {hasLink ? (
        <a
          {...linkProps(cell.href)}
          className="block -mx-1 px-1 py-1 rounded hover:bg-white/[0.04] transition-colors"
          title={t('dashboard.cellLinkTitle', { title: cell.title, href: cell.href })}
        >
          <div className={`text-[13px] leading-snug ${dim ? 'text-neutral-400' : 'text-neutral-300'}`}>
            {summary}
          </div>
          {meta}
        </a>
      ) : (
        <>
          <div className={`text-[13px] leading-snug ${dim ? 'text-neutral-400' : 'text-neutral-300'}`}>
            {summary}
          </div>
          {meta}
        </>
      )}

      {detail.length > 0 && (
        <ul className="mt-3 border-t border-white/5 pt-2.5 space-y-1">
          {detail.map((item, i) => (
            <li key={i} className="text-xs leading-relaxed">
              {!editMode && item.href ? (
                <a
                  {...linkProps(item.href)}
                  className="text-neutral-400 hover:text-neutral-200 underline decoration-white/20 underline-offset-2"
                >
                  {item.text}
                </a>
              ) : (
                <span className="text-neutral-400">{item.text}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Source unreachable: dim only this cell and say what to do, never pretend ok (R2) */}
      {cell.source_error && (
        <div className="mt-3 border-t border-white/5 pt-2 text-[11px] text-amber-300/90">
          {cell.source_error.hint || cell.source_error.message}
        </div>
      )}
    </Card>
  )
}

/** App/capsule icon tile: fixed 1×1 centered icon + label; placement/hidden share panelPrefs with cells */
type IconTileData = {
  /** Preference storage key: `app:<id>` / `capsule:<relpath>` (cell ids contain no colon, so these never collide) */
  id: string
  name: string
  /** Emoji, or a data:/https: icon URL from the capsule's bookmark fields */
  icon: string
  /** App = `/apps/<id>` (in-host page change); capsule = the backend's `url` (new tab / system browser) */
  href: string
  kind: 'app' | 'capsule'
}

/** Open an icon item (shared by IconTile clicks and the folder overlay's "open"): the §4.2 launch branch */
function openIconItem(
  item: IconTileData,
  onOpenApp: ((id: string) => void) | undefined,
  onError: (msg: string) => void,
) {
  if (item.kind === 'capsule') {
    // HTML capsule: a same-origin new tab in the browser; on desktop the shell hands it to the system browser (same rule as the launcher)
    if (isTauri()) {
      void tauriBridge.openCapsule(item.href).catch((err) =>
        onError(err instanceof Error ? err.message : String(err)),
      )
    } else {
      window.open(item.href, '_blank', 'noopener,noreferrer')
    }
    return
  }
  // App: in-host page change (App owns the active state; without a callback, native href navigation is the fallback)
  const appId = item.href.replace(/^\/apps\//, '').replace(/^\?tool=/, '')
  onOpenApp?.(appId)
}

function IconTile({
  item,
  span,
  onOpenTool,
  onError,
  editMode,
}: {
  item: IconTileData
  span: CardSpan
  /** Page-change callback from the host (App owns the active state); without it, native href navigation is the fallback */
  onOpenTool?: (id: string) => void
  onError: (msg: string) => void
  /** Edit mode: icons cannot be opened (drag/remove only) — one stray click would switch the workbench away, which feels awful */
  editMode: boolean
}) {
  const { t } = useI18n()
  const isApp = item.kind === 'app'
  const isImage = /^(data:|https?:)/.test(item.icon)

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (editMode) {
      // Fallback: even a real click in edit mode must not navigate (normally there is no href here, so it is not clickable at all)
      e.preventDefault()
      return
    }
    if (onOpenTool || isApp) e.preventDefault()
    openIconItem(item, onOpenTool, onError)
  }

  return (
    <a
      id={`bento-card-${item.id}`}
      data-bento-card={item.id}
      data-icon-tile={item.id}
      data-icon-kind={item.kind}
      data-bento-span={span}
      className={`bento-card bento-card--${span} bento-card--icon${
        editMode ? ' bento-card--editing' : ''
      }`}
      // Edit mode **omits the href**: no link means no clickable area (more thorough than preventDefault, and
      // no hover pointer or "open in new tab" leftovers) — dragging and the remove key keep working
      href={editMode ? undefined : item.href}
      target={isApp && !editMode ? '_blank' : undefined}
      rel={isApp && !editMode ? 'noreferrer' : undefined}
      onClick={handleClick}
      draggable={false}
      aria-disabled={editMode || undefined}
      title={
        editMode
          ? t('dashboard.iconTile.editTitle', { name: item.name })
          : isApp
            ? t('dashboard.iconTile.appTitle', { name: item.name, href: item.href })
            : t('dashboard.iconTile.capsuleTitle', { name: item.name, href: item.href })
      }
    >
      {isImage ? (
        <img className="bento-icon__img" src={item.icon} alt="" aria-hidden="true" />
      ) : (
        <span className="bento-icon__glyph">
          <ToolIcon icon={item.icon} fallback="plugin" size={26} />
        </span>
      )}
      <span className="bento-icon__label" data-icon-label={item.id}>
        {item.name}
      </span>
    </a>
  )
}

/**
 * Icon folder tile (phase C / D7): 1×1 with the first 4 members tiled 2×2; click expands an overlay.
 * Same boundary as the phone: only icons go into folders — wall cells never do.
 */
function FolderTile({
  folder,
  members,
  span,
  onOpen,
  editMode,
}: {
  folder: WallFolder
  members: IconTileData[]
  span: CardSpan
  onOpen: () => void
  /** Edit mode: do not expand the overlay (dragging the folder itself is still allowed) */
  editMode: boolean
}) {
  const { t } = useI18n()
  const id = folderTileId(folder.id)
  return (
    <div
      id={`bento-card-${id}`}
      data-bento-card={id}
      data-folder-tile={folder.id}
      data-bento-span={span}
      className={`bento-card bento-card--${span} bento-card--icon bento-folder${
        editMode ? ' bento-card--editing' : ''
      }`}
      role={editMode ? undefined : 'button'}
      tabIndex={editMode ? undefined : 0}
      aria-disabled={editMode || undefined}
      title={
        editMode
          ? t('dashboard.folderTile.editTitle', { name: folder.name })
          : t('dashboard.folderTile.title', { name: folder.name, count: members.length })
      }
      onClick={editMode ? undefined : onOpen}
      onKeyDown={(e) => {
        if (!editMode && e.key === 'Enter') onOpen()
      }}
    >
      <span className="bento-folder__grid" aria-hidden="true">
        {members.slice(0, 4).map((m) =>
          /^(data:|https?:)/.test(m.icon) ? (
            <img key={m.id} className="bento-folder__mini" src={m.icon} alt="" />
          ) : (
            <span key={m.id} className="bento-folder__mini">
              <ToolIcon icon={m.icon} fallback="plugin" size={15} />
            </span>
          ),
        )}
      </span>
      <span className="bento-icon__label" data-folder-label={folder.id}>
        {folder.name}
      </span>
    </div>
  )
}

/** Folder overlay: member list (open / remove) + rename / dissolve / close. */
function FolderOverlay({
  folder,
  members,
  onOpenMember,
  onRemoveMember,
  onRename,
  onDissolve,
  onClose,
}: {
  folder: WallFolder
  members: IconTileData[]
  onOpenMember: (member: IconTileData) => void
  onRemoveMember: (memberId: string) => void
  onRename: () => void
  onDissolve: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  return (
    <div
      className="folder-overlay"
      data-folder-overlay={folder.id}
      role="dialog"
      aria-label={t('dashboard.folder.aria', { name: folder.name })}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="folder-overlay__head">
        <span className="folder-overlay__name" data-folder-name={folder.id}>
          {folder.name}
        </span>
        <span className="folder-overlay__count">
          {t('dashboard.folder.count', { count: members.length })}
        </span>
        <button
          data-folder-act="rename"
          onClick={onRename}
          title={t('dashboard.folder.rename')}
          aria-label={t('dashboard.folder.rename')}
        >
          <Icon name="edit" size={13} />
        </button>
        <button
          data-folder-act="dissolve"
          onClick={onDissolve}
          title={t('dashboard.folder.dissolveTooltip')}
          aria-label={t('dashboard.folder.dissolve')}
        >
          <Icon name="trash" size={13} />
        </button>
        <button
          data-folder-act="close"
          onClick={onClose}
          title={t('dashboard.folder.closeTooltip')}
          aria-label={t('common.close')}
        >
          <Icon name="close" size={13} />
        </button>
      </div>
      <ul className="folder-overlay__list">
        {members.map((m) => (
          <li key={m.id} data-folder-member={m.id}>
            <button
              className="folder-overlay__open"
              onClick={() => onOpenMember(m)}
              title={t('dashboard.folder.openMember', { name: m.name })}
            >
              {/^(data:|https?:)/.test(m.icon) ? (
                <img className="bento-folder__mini" src={m.icon} alt="" />
              ) : (
                <span className="bento-folder__mini">
                  <ToolIcon icon={m.icon} fallback="plugin" size={15} />
                </span>
              )}
              <span className="folder-overlay__label">{m.name}</span>
            </button>
            <button
              data-folder-act="remove"
              onClick={() => onRemoveMember(m.id)}
              title={t('dashboard.folder.removeMember')}
              aria-label={t('dashboard.folder.removeMemberAria', { name: m.name })}
            >
              <Icon name="close" size={12} />
            </button>
          </li>
        ))}
        {members.length === 0 && (
          <li className="folder-overlay__empty">{t('dashboard.folder.empty')}</li>
        )}
      </ul>
    </div>
  )
}

export default function Dashboard({
  customize,
  tools = [],
  plugins = [],
  onOpenTool,
}: {
  customize?: WallCustomize
  /** Tool list (already fetched by App from /api/tools): one of the sources for desktop icons */
  tools?: Tool[]
  /** Plugin declarations (/api/plugins): the **only** truth about cell ownership (the tiles field says who produces what) */
  plugins?: PluginConfigTool[]
  /** Clicking a tool icon = in-host page change (App's handleSelectTool) */
  onOpenTool?: (id: string) => void
}) {
  const { t } = useI18n()
  const [data, setData] = useState<CellListResult | null>(null)
  /** First-screen request in flight (local state: one GET returns everything, so the whole wall renders at once) */
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<{ message: string; hint: string } | null>(null)
  /** One-line human-readable error when "open in browser" fails (silent on success: the browser opens by itself) */
  const [webError, setWebError] = useState('')

  /** Library HTML capsules (icon source): best-effort — if unreadable, draw nothing; the wall still works */
  const [vaultCapsules, setVaultCapsules] = useState<VaultCapsule[]>([])

  const dataRef = useRef<CellListResult | null>(null)
  const mounted = useRef(true)

  const load = useCallback(async () => {
    setRefreshing(true)
    // Icon sources refresh in the same tick as the wall (a failed capsules read silently degrades to tool icons only)
    try {
      const res = await capsules.list()
      if (mounted.current) setVaultCapsules(res.capsules.filter((c) => c.enabled !== false))
    } catch {
      if (mounted.current) setVaultCapsules([])
    }
    try {
      const res = await api.dashboardCells()
      if (!mounted.current) return
      dataRef.current = res
      setData(res)
      setError(null)
    } catch (e) {
      if (!mounted.current) return
      // Dim only this block: keep the last successful data (show it if present), never a blank page
      setError({
        message: e instanceof Error ? e.message : String(e),
        hint: e instanceof ApiError ? e.hint : '',
      })
    } finally {
      if (mounted.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  // Polling: follow next_refresh_in from the envelope (default 60s, clamped to 15~300s), pause while the
  // page is hidden (visibilitychange), and fetch immediately plus resume when it becomes visible again.
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    let handle: ReturnType<typeof setTimeout> | undefined

    const nextDelayMs = () => {
      const secs = dataRef.current?.next_refresh_in
      const wait = typeof secs === 'number' && secs > 0 ? Math.min(Math.max(secs, 15), 300) : 60
      return wait * 1000
    }
    const schedule = () => {
      if (cancelled || document.hidden) return
      clearTimeout(handle)
      handle = setTimeout(async () => {
        await load()
        schedule()
      }, nextDelayMs())
    }
    const onVisibility = () => {
      clearTimeout(handle)
      if (document.hidden || cancelled) return
      void load().then(schedule)
    }

    void load().then(schedule)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      mounted.current = false
      clearTimeout(handle)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  const now = Date.parse(data?.generated_at ?? '') || Date.now()
  // Counting basis = server-side enabled cells (cells hidden locally by "Customize" are a display preference
  // only; the header count and the alerts overview cell both follow the wall's truth, so they must agree).
  const enabled = (data?.cells ?? []).filter((c) => c.enabled)
  const hidden = customize?.prefs.hidden ?? []
  /** Cells that are enabled and not hidden locally (folders only hold icons, they never affect cells) */
  const cells = enabled.filter((c) => !hidden.includes(c.id))
  // Counting matches the aggregate cell in contract §6.5: only upstream cells (excluding overview.alerts itself),
  // and "not ok or not fresh" counts as abnormal — otherwise the header says 7 abnormal while the overview cell says 6.
  const abnormal = enabled.filter(
    (c) => c.id !== 'overview.alerts' && (c.status !== 'ok' || c.staleness !== 'fresh'),
  ).length
  const shownCount = enabled.length

  /** Span: per-cell preference > cell registry (CELL_SPANS) > md fallback */
  const spanOf = (c: Cell): CardSpan => {
    const size = customize?.prefs.sizes[c.id] ?? cellSpan(c.id)
    // A cell is a card with body text: at 1/12 width (≈82px) header and body both crush, so fall back to md
    // (in the old layout a 1×1 card still had 268px of readable width; no longer true)
    return size === 'sm' ? 'md' : size
  }

  /** App and capsule icons: tools minus dashboard itself (its visible-list entry was retired) + library HTML capsules */
  const iconTiles: IconTileData[] = [
    ...tools
      .filter((t) => t.id !== 'dashboard')
      .map<IconTileData>((t) => ({
        id: `tool:${t.id}`,
        name: t.name,
        icon: t.icon || 'plugin',
        href: `/apps/${t.id}`,
        kind: 'app',
      })),
    ...vaultCapsules.map<IconTileData>((a) => ({
      id: `app:${a.relpath}`,
      name: vaultCapsuleTitle(a),
      icon: a.icon?.trim() || 'capsule',
      href: a.url,
      kind: 'capsule',
    })),
  ]
  /** Icons and folders have one fixed footprint: exactly 1×1; no size preference can change it. */
  const folders = customize?.prefs.folders ?? []
  const iconById = new Map(iconTiles.map((i) => [i.id, i]))
  const folderById = new Map(folders.map((f) => [folderTileId(f.id), f]))
  const memberSet = new Set(folders.flatMap((f) => f.memberIds))
  const hiddenSet = new Set(hidden)
  /** Visible icons participate in default shelf packing; folder members are represented by their folder tile */
  const visibleIconIds = iconTiles
    .filter((i) => !hiddenSet.has(i.id) && !memberSet.has(i.id))
    .map((i) => i.id)
  const folderIds = folders.map((f) => folderTileId(f.id))
  const fixedIds = [...iconTiles.map((i) => i.id), ...folderIds]

  // —— Phase C: one page = one screen (measured: shrink row height, and fall back to in-page scrolling when full) ——
  // Rows and row height derive from the viewport: available height = viewport − (header / page dots / page padding).
  const [viewportH, setViewportH] = useState(() => window.innerHeight)
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const chromeH = 320
  const availH = Math.max(420, viewportH - chromeH)
  /**
   * Page capacity: one page = one screen (row height is fixed, so how many rows fit depends only on
   * viewport height). The old version derived row height from the viewport too (110~240px), so the same
   * card was 182px on a 900px screen and 240px on a 1440px one — icons and cards wobbled with the
   * monitor, unlike a desktop app. Now only the row count adapts.
   */
  const rowsPerPage = Math.max(4, Math.min(12, Math.floor((availH + GRID_GAP) / (ROW_PX + GRID_GAP))))
  const rowHeight = ROW_PX

  /**
   * Default placement (ids nobody dragged use this): overview → icons → folders → things to do →
   * state to know. Icons/folders are 1×1 slots in the same paging grid as cells. `zone/order` is
   * only metadata for this order (D7); visual zone headers are no longer rendered.
   */
  const packOrder: PackerItem[] = (() => {
    const zoneOrder = (zone: Cell['zone']) =>
      cells
        .filter((c) => c.zone === zone)
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    const order: PackerItem[] = []
    const overviewCell = cells.find((c) => c.id === 'overview.alerts')
    if (overviewCell) order.push({ id: overviewCell.id, tier: spanOf(overviewCell) })
    for (const id of visibleIconIds) order.push({ id, tier: 'sm' })
    for (const id of folderIds) order.push({ id, tier: 'sm' })
    for (const zone of ['todo', 'status'] as const) {
      for (const c of zoneOrder(zone)) {
        if (c.id === 'overview.alerts') continue
        order.push({ id: c.id, tier: spanOf(c) })
      }
    }
    return order
  })()
  /** Default placement + what the user dragged (stored entries win — that is explicit user intent) */
  const mergedLayout: Record<string, WallLayoutEntry> = {
    ...packPages(packOrder, rowsPerPage),
    ...(customize?.prefs.layout ?? {}),
  }
  // Stale or hand-edited entries must not resurrect a larger icon/folder footprint.
  for (const id of fixedIds) {
    const entry = mergedLayout[id]
    if (entry) mergedLayout[id] = fixedIconEntry(entry)
  }

  // Column count breaks on the **viewport**, not the container width (same ruler as bento.css media queries:
  // ≥1024 twelve columns / ≥640 six / narrower three — the container loses 256px to the sidebar, and breaking
  // on it would drop a column tier)
  const { width, containerRef, mounted: widthReady } = useContainerWidth()
  const [viewportW, setViewportW] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setViewportW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const cols = viewportW >= 1024 ? BASE_COLS : viewportW >= 640 ? TABLET_COLS : PHONE_COLS

  /** One paged grid: cells + freely placeable icons/folders (the latter locked to 1×1) */
  const items = visibleItems({
    entries: mergedLayout,
    hidden,
    folders,
    cells,
    icons: iconTiles,
    cols,
    rows: rowsPerPage,
  })

  const pageCount = items.reduce((n, it) => Math.max(n, it.entry.page + 1), 1)
  const [page, setPage] = useState(0)
  // Clamp the page number when pages disappear (cells hidden / folder dissolved)
  useEffect(() => {
    setPage((p) => Math.min(p, pageCount - 1))
  }, [pageCount])
  const pageItems = items.filter((it) => it.entry.page === page)
  /**
   * Layout handed to RGL: cells may resize (minimum 3×2); icons/folders are locked to exactly
   * 1×1 with `maxW/maxH` and `isResizable: false`, while remaining freely draggable.
   */
  const rglLayout: Layout = pageItems.map((it) => {
    const min = minBox(it.kind)
    const fixed = it.kind !== 'cell'
    return {
      i: it.id,
      x: it.entry.x,
      y: it.entry.y,
      w: it.entry.w,
      h: it.entry.h,
      minW: Math.min(min.minW, cols),
      minH: min.minH,
      ...(fixed ? { maxW: 1, maxH: 1, isResizable: false } : { maxW: cols }),
    }
  })
  /**
   * —— Content-adaptive height (P3) ——
   * Each card reports the height its content naturally needs (`Card.onNatural`), which is converted into
   * rows and written back into the layout. Cells the user resized by hand or via a size preset (a value in
   * `prefs.sizes[id]`) are left alone — that is explicit intent. The cap is `rowsPerPage - y`: cells may only
   * grow downward, never push the block to the top of the page (otherwise every refresh would jump).
   */
  const [measureToken, setMeasureToken] = useState(0)
  const measured = useRef(new Map<string, number>())
  const flushRef = useRef<() => void>(() => {})
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  flushRef.current = () => {
    if (!customize) return
    const changed: Record<string, WallLayoutEntry> = {}
    let any = false
    for (const [id, px] of measured.current) {
      const cur = mergedLayout[id]
      if (!cur) continue
      const min = minBox('cell').minH
      const want = rowsForContent(px, rowsPerPage, min)
      const h = Math.min(want, Math.max(min, rowsPerPage - cur.y))
      if (h === cur.h) continue
      changed[id] = { ...cur, h }
      any = true
    }
    if (!any) return
    // Write in one pass: writing only the changed ones would leave untouched rows at the old row height (visible stacking in free mode)
    customize.onLayout({ ...mergedLayout, ...changed })
  }
  /** Switch a cell back to "height follows content": drop its size preference, then re-measure it */
  const useAutoHeight = (id: string) => {
    if (!customize) return
    const kind = items.find((it) => it.id === id)?.kind ?? (isIconId(id) ? 'icon' : 'cell')
    if (kind !== 'cell') return
    customize.onSize(id, null)
    measured.current.delete(id)
    setMeasureToken((t) => t + 1)
  }

  /** Natural height reported by a card: debounced and flushed together, so each card does not write storage separately */
  const noteNatural = (id: string, px: number) => {
    if (!customize) return
    if (customize.prefs.sizes[id]) return
    const prev = measured.current.get(id)
    if (prev !== undefined && Math.abs(prev - px) < 2) return
    measured.current.set(id, px)
    if (flushTimer.current) return
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null
      flushRef.current()
    }, 120)
  }
  useEffect(() => () => {
    if (flushTimer.current) clearTimeout(flushTimer.current)
  }, [])

  /** Edit mode = a separate desktop edit mode (handles/remove/library all read it), unrelated to the "Customize" popover */
  const editMode = customize?.editMode ?? false
  // Collapse the size menu when leaving edit mode (otherwise it hangs over a wall that can no longer be dragged)
  useEffect(() => {
    if (!editMode) setSizeMenu(null)
  }, [editMode])
  // ————————————————— phase C interactions ————————————————————————

  const cellById = new Map(cells.map((c) => [c.id, c]))

  /** Component library drawer open (edit mode only; not auto-opened on narrow desktops) */
  const [libraryOpen, setLibraryOpen] = useState(false)

  /** Size menu (P2): the item whose preset menu is open + viewport coordinates (fixed, so the grid cannot clip it) */
  const [sizeMenu, setSizeMenu] = useState<{ id: string; x: number; y: number } | null>(null)

  /** Packing mode (P2): compact = RGL compacts vertically (items float up, no empty rows); free = stays where dropped */
  const compactor = (customize?.prefs.packing ?? 'compact') === 'free' ? noCompactor : verticalCompactor

  /**
   * The only entry point for resizing: **the size writes both `sizes` and `layout`**.
   *
   * Writing `sizes` alone is not enough — `prefs.layout` wins inside `mergedLayout` when rendering, so a
   * cell that had been dragged (has a layout entry) would show "changed" in the menu while the wall did
   * not move at all (an old bug). The stored w/h are **12-column base** tiers, not clamped to the current
   * column count (see SIZE_PRESETS).
   */
  const applySize = (id: string, size: CardSize) => {
    if (!customize) return
    const kind = items.find((it) => it.id === id)?.kind ?? (isIconId(id) ? 'icon' : 'cell')
    // Icons and folders are fixed 1×1: no size preference, no menu, no resizing.
    if (kind !== 'cell') return
    customize.onSize(id, size)
    const cur = mergedLayout[id]
    if (!cur) return
    const min = minBox(kind)
    const box = tierBox(size)
    // Raise the tier to the item's minimum size — "small" means 3×2 for a cell, not icon-sized
    const w = Math.max(box.w, min.minW)
    const h = Math.max(box.h, min.minH)
    customize.onLayout(
      { ...customize.prefs.layout, [id]: clampEntry({ ...cur, w, h }, BASE_COLS, rowsPerPage) },
    )
  }

  /**
   * Persist a free resize (P2): same path as dragging — freeze the whole page's coordinates first, then write once.
   * The final w/h are also rounded to the nearest tier and written back to `sizes`, otherwise the size menu in
   * "Customize" would keep lying.
   */
  const handleResizeStop = (
    layout: Layout,
    _oldItem: LayoutItem | null,
    newItem: LayoutItem | null,
  ) => {
    suppressClickUntil.current = Date.now() + 350
    if (!customize) return
    const snapshot: Record<string, WallLayoutEntry> = { ...customize.prefs.layout }
    let settled: WallLayoutEntry | null = null
    for (const li of layout) {
      // On narrow screens write only the changed item: narrow-screen coordinates come from a temporary
      // `reflow`, and writing the whole page back would bake the three-column rearrangement into the
      // 12-column store, so one phone edit would scramble the desktop layout.
      if (cols !== BASE_COLS && newItem && li.i !== newItem.i) continue
      const kind = items.find((it) => it.id === li.i)?.kind ?? 'cell'
      const base = toBaseEntry({ page, x: li.x, y: li.y, w: li.w, h: li.h }, cols, kind)
      snapshot[li.i] = base
      if (newItem && li.i === newItem.i) settled = base
    }
    customize.onLayout(snapshot)
    // Tier rounding must use **12-column base** w/h (on narrow screens li.w uses the 3-column scale, and feeding it to tierOf picks the wrong tier).
    // Fixed 1×1 icons/folders never get a size preference.
    if (newItem && settled) {
      const kind = items.find((it) => it.id === newItem.i)?.kind ?? 'cell'
      if (kind === 'cell') customize.onSize(newItem.i, tierOf(settled.w, settled.h) as CardSize)
    }
  }

  /**
   * Component library = everything **not currently on the desktop**:
   *   * cells that are hidden (`prefs.hidden`) — exactly where "remove to library" puts them;
   *   * icons that sit in no folder (tools / library apps)… conversely, only **unhidden** items count as
   *     being on the desktop, so cells are taken as "enabled and hidden" while icons are taken by "hidden".
   * Anything already on the desktop stays out (the phone's drawer only holds unplaced items).
   *
   * Grouped by app: an app's icon entry and the info cells it produces share one group (icons first).
   * Ownership follows the `tiles` declarations in `/api/plugins` (only the server knows where things come
   * from); it is never guessed from cell ids.
   */
  const libraryItems: LibraryItem[] = (() => {
    const out: LibraryItem[] = []

    // Ownership lookup for tools and modules
    const toolMap = new Map(tools.map((t) => [t.id, t]))
    const vaultMap = new Map(vaultCapsules.map((a) => [`app:${a.relpath}`, a]))

    // Cell → owning app, **following the server declaration** (`tiles` in `GET /api/plugins`).
    const ownerByCell = new Map<string, Tool>()
    for (const p of plugins) {
      const owner = toolMap.get(p.id)
      for (const cid of p.tiles ?? []) {
        if (owner) ownerByCell.set(cid, owner)
      }
    }
    const own = (t: Tool) => ({ appId: `tool:${t.id}`, appName: t.name, appIcon: t.icon })

    const cellAppLookup = (cellId: string): { appId: string; appName: string; appIcon?: string } => {
      const owner = ownerByCell.get(cellId)
      if (owner) return own(owner)
      // The host notification tile belongs to no plugin, so it gets its own group
      if (cellId === 'overview.alerts') {
        return { appId: 'system', appName: t('dashboard.systemOverview'), appIcon: 'dashboard' }
      }
      // Unrecognized cells get their own group by id prefix; ownership is never guessed
      const prefix = cellId.split('.')[0]
      const match = toolMap.get(prefix)
      if (match) return own(match)
      return { appId: prefix, appName: prefix, appIcon: cellIcon(cellId) }
    }

    // 1. Cell cards
    for (const c of enabled) {
      if (!hiddenSet.has(c.id)) continue
      const meta = cellAppLookup(c.id)
      out.push({
        id: c.id,
        title: c.title,
        icon: cellIcon(c.id),
        kind: 'cell',
        appId: meta.appId,
        appName: meta.appName,
        appIcon: meta.appIcon,
        group: meta.appName,
        span: spanOf(c),
      })
    }

    // 2. App / tool icon items (at least one icon; folder members are already represented by their folder)
    for (const i of iconTiles) {
      if (!hiddenSet.has(i.id) || memberSet.has(i.id)) continue
      let appName = i.name
      let appIcon = i.icon
      let appId = i.id
      if (i.kind === 'app') {
        const tId = i.id.replace(/^tool:/, '')
        const t = toolMap.get(tId)
        if (t) {
          appName = t.name
          appIcon = t.icon
          appId = `tool:${t.id}`
        }
      } else {
        const a = vaultMap.get(i.id)
        if (a) {
          appName = vaultCapsuleTitle(a)
          appIcon = a.icon?.trim() || 'capsule'
          appId = i.id
        }
      }

      out.push({
        id: i.id,
        title: t('dashboard.iconTitle', { name: appName }),
        icon: i.icon,
        kind: 'icon',
        appId,
        appName,
        appIcon,
        group: appName,
        span: 'sm',
      })
    }
    return out
  })()

  /**
   * Put an item from the library back on the desktop: **unhide it first**, then find it a free slot.
   *
   * Occupancy uses `items` (already converged to the **current** column count), not `mergedLayout`
   * (12-column base) — mixing the two scales computes stepped, misaligned slots on narrow screens
   * (the same trap as P1). Cells keep their declared size; icons/folders always ask for one 1×1 slot.
   */
  const addFromLibrary = (id: string) => {
    if (!customize) return
    // Careful: look up the size among **enabled** cells (before the hidden filter) — the items sitting in the
    // library are exactly the hidden ones, so `cells`/`cellById` do not contain them (measured: the full-width
    // overview.alerts came back as 1×1).
    const cellEntry = enabled.find((c) => c.id === id)
    const kind = cellEntry ? 'cell' : 'icon'
    const { w, h } = cellEntry ? tierBox(spanOf(cellEntry)) : { w: 1, h: 1 }
    const occupied = items.filter((it) => it.id !== id).map((it) => it.entry)
    const slot = findFreeSlot(occupied, w, h, cols, rowsPerPage)
    customize.onToggleHidden(id)
    customize.onLayout({
      ...(customize.prefs.layout ?? {}),
      [id]: toBaseEntry(slot, cols, kind),
    })
    // Jump to the page it landed on, so the user sees it was added
    setPage(slot.page)
  }

  /** Move an item off the desktop back into the component library (= hide it).
   *
   * **Freeze the current placement first**, then hide: items nobody dragged use the default flow layout, so
   * removing one shifts everything after it forward (measured: removing the full-width overview cell turned
   * 9 items on the page into 12) — that is a "reflow", not "taking one away". After freezing, the rest stay
   * put and only its own slot empties, matching the phone habit of long-pressing an icon to delete it. It also
   * comes back where it was. Icons now have coordinates too, so all item kinds need the freeze.
   */
  const removeToLibrary = (id: string) => {
    if (!customize) return
    customize.onLayout({ ...mergedLayout })
    customize.onToggleHidden(id)
  }

  /**
   * Drop from the component library **onto the desktop**: convert the drop point into in-page grid coordinates
   * and place it right there. Icons/folders use one fixed 1×1 slot; cells keep their declared size.
   *
   * The math uses the wall container's padding box with the current rowHeight/margin to derive `x/y`, then clamps
   * it to the valid range (columns/rows). Dropping outside the wall (e.g. back onto the drawer) falls back to
   * "find a free slot automatically". It shares one persistence path with click-to-add, so size, hidden and
   * layout are written in exactly one place.
   */
  const dropFromLibrary = (id: string, clientX: number, clientY: number) => {
    if (!customize) return
    const host = containerRef.current
    if (!host) {
      addFromLibrary(id)
      return
    }
    const rect = host.getBoundingClientRect()
    const inside =
      clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
    if (!inside) {
      addFromLibrary(id)
      return
    }
    const cellEntry = enabled.find((c) => c.id === id)
    const kind = cellEntry ? 'cell' : 'icon'
    const { w, h } = cellEntry ? tierBox(spanOf(cellEntry)) : { w: 1, h: 1 }
    const colW = (rect.width - (cols - 1) * GRID_GAP) / cols
    const rawX = Math.floor((clientX - rect.left) / (colW + GRID_GAP))
    const rawY = Math.floor((clientY - rect.top) / (rowHeight + GRID_GAP))
    const slot: WallLayoutEntry = {
      page,
      x: Math.max(0, Math.min(rawX, cols - Math.min(w, cols))),
      y: Math.max(0, Math.min(rawY, Math.max(0, rowsPerPage - Math.min(h, rowsPerPage)))),
      w: Math.min(w, cols),
      h: Math.min(h, rowsPerPage),
    }
    customize.onToggleHidden(id)
    customize.onLayout({
      ...(customize.prefs.layout ?? {}),
      [id]: toBaseEntry(slot, cols, kind),
    })
  }

  /** Page-dot alert marker: the dot turns red when that page holds an alert cell */
  const pagesWithAlert = new Set(
    items
      .filter((it) => it.kind === 'cell' && (cellById.get(it.id)?.status ?? 'ok') === 'alert')
      .map((it) => it.entry.page),
  )

  const [openFolderId, setOpenFolderId] = useState<string | null>(null)
  const openFolder = folders.find((f) => f.id === openFolderId) ?? null
  const folderMembersOf = (f: WallFolder): IconTileData[] =>
    f.memberIds
      .map((id) => iconById.get(id))
      .filter((m): m is IconTileData => !!m)

  /** All folder changes go through here: when a folder disappears, drop its layout entry (member entries are always kept) */
  const updateFolders = (next: WallFolder[]) => {
    if (!customize) return
    const alive = new Set(next.map((f) => f.id))
    if (next.length !== folders.length || next.some((f, i) => f.id !== folders[i]?.id)) {
      const layout = { ...customize.prefs.layout }
      for (const f of folders) {
        if (!alive.has(f.id)) delete layout[folderTileId(f.id)]
      }
      customize.onLayout(layout)
    }
    customize.onFolders(next)
  }

  // Gesture split: horizontal swipe = page flip (not in edit mode); dragging only starts from the handle (RGL draggableHandle).
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  const handleTouchStart = (e: ReactTouchEvent) => {
    const t = e.touches[0]
    touchStart.current = { x: t.clientX, y: t.clientY }
  }
  const handleTouchEnd = (e: ReactTouchEvent) => {
    const start = touchStart.current
    touchStart.current = null
    if (!start || editMode) return
    const t = e.changedTouches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    if (Math.abs(dx) < 60 || Math.abs(dy) > 50) return
    // Swiping off an interactive element is not a page flip (links/buttons/scrollable bodies keep their own semantics)
    const target = e.target as HTMLElement | null
    if (target?.closest?.('a,button,input,select,textarea,.bento-card__body')) return
    setPage((p) => Math.max(0, Math.min(pageCount - 1, dx < 0 ? p + 1 : p - 1)))
  }

  // Edit-mode dragging (RGL): track the edge page-flip target and a 600ms hover merge target.
  // Icons/folders are ordinary grid items, so folder merging happens by dropping one icon on another
  // icon/folder tile. Note: **no setState while dragging** — any re-render gives the controlled layout a
  // new array identity and RGL cancels the drag on the spot (measured: dragStart fires, transform never
  // moves, dragStop never arrives). Both highlights are command-written attributes.
  const pagerRef = useRef<HTMLDivElement>(null)
  const dragMeta = useRef<{ edge?: 'left' | 'right' }>({})
  // After a drag the browser still fires a click on the same element from down/up — icons are <a>, and that click
  // would switch the workbench to another tool page (unmounting this Dashboard, which looks like the element
  // vanishing). Suppression window: clicks on the pager are swallowed for 350ms after dragStop.
  const suppressClickUntil = useRef(0)
  const hoverTargetId = useRef<string | null>(null)
  const mergeReadyId = useRef<string | null>(null)
  const mergeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Icon/folder rectangles at drag start: vertical compaction moves tiles during a drag, but the user aims at where they were. */
  const mergeRects = useRef<
    { id: string; left: number; right: number; top: number; bottom: number }[]
  >([])
  const setEdgeAttr = (edge: 'left' | 'right' | null) => {
    const pager = pagerRef.current
    if (!pager) return
    if (edge) pager.setAttribute('data-drag-edge', edge)
    else pager.removeAttribute('data-drag-edge')
  }
  const setMergeAttr = (id: string | null) => {
    const pager = pagerRef.current
    pager?.querySelectorAll('[data-merge-target]').forEach((el) => el.removeAttribute('data-merge-target'))
    if (!id || !pager) return
    const node = Array.from(pager.querySelectorAll('[data-wall-item]')).find(
      (el) => el.getAttribute('data-wall-item') === id,
    )
    node?.setAttribute('data-merge-target', '1')
  }
  const clearMergeHover = () => {
    if (mergeTimer.current) {
      clearTimeout(mergeTimer.current)
      mergeTimer.current = null
    }
    hoverTargetId.current = null
    mergeReadyId.current = null
    setMergeAttr(null)
  }
  /** Hovering an icon/folder for 600ms = merge; a quick pass only moves the dragged icon. */
  const watchMergeTarget = (candidate: string | null) => {
    if (candidate === hoverTargetId.current) return
    if (mergeTimer.current) {
      clearTimeout(mergeTimer.current)
      mergeTimer.current = null
    }
    mergeReadyId.current = null
    setMergeAttr(null)
    hoverTargetId.current = candidate
    if (!candidate) return
    mergeTimer.current = setTimeout(() => {
      mergeTimer.current = null
      if (hoverTargetId.current !== candidate) return
      mergeReadyId.current = candidate
      setMergeAttr(candidate)
    }, 600)
  }
  useEffect(() => () => {
    if (mergeTimer.current) clearTimeout(mergeTimer.current)
  }, [])

  /** Snapshot merge targets before RGL compaction shifts the tiles under the dragged item. */
  const handleDragStart = (
    _layout: Layout,
    _oldItem: LayoutItem | null,
    newItem: LayoutItem | null,
  ) => {
    const draggedId = newItem?.i
    mergeRects.current = Array.from(pagerRef.current?.querySelectorAll('[data-wall-item]') ?? [])
      .filter((el) => {
        const kind = el.getAttribute('data-item-kind')
        return (kind === 'icon' || kind === 'folder') && el.getAttribute('data-wall-item') !== draggedId
      })
      .map((el) => {
        const r = el.getBoundingClientRect()
        return {
          id: el.getAttribute('data-wall-item') ?? '',
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        }
      })
      .filter((r) => r.id !== '')
  }

  const handleDrag = (
    _layout: Layout,
    _oldItem: LayoutItem | null,
    newItem: LayoutItem | null,
    _placeholder: LayoutItem | null,
    e: Event,
  ) => {
    try {
      const ev = e as globalThis.MouseEvent
      const rect = pagerRef.current?.getBoundingClientRect()
      const meta: { edge?: 'left' | 'right' } = {}
      let candidate: string | null = null
      if (rect && typeof ev.clientX === 'number' && typeof ev.clientY === 'number') {
        const x = ev.clientX - rect.left
        if (x < 56) meta.edge = 'left'
        else if (x > rect.width - 56) meta.edge = 'right'
        const draggedId = newItem?.i
        const dragged = draggedId ? items.find((it) => it.id === draggedId) : undefined
        // The dragged tile sits on top of the pointer, so elementsFromPoint cannot see the tile
        // underneath. Drag-start rectangles also survive RGL's vertical compaction.
        if (dragged?.kind === 'icon') {
          const target = mergeRects.current.find(
            (r) =>
              ev.clientX >= r.left &&
              ev.clientX <= r.right &&
              ev.clientY >= r.top &&
              ev.clientY <= r.bottom,
          )
          candidate = target?.id ?? null
        }
      }
      dragMeta.current = meta
      setEdgeAttr(meta.edge ?? null)
      watchMergeTarget(candidate)
    } catch {
      // Drag telemetry failing must not break the whole drag chain.
      dragMeta.current = {}
      clearMergeHover()
    }
  }

  const handleDragStop = (
    layout: Layout,
    _oldItem: LayoutItem | null,
    newItem: LayoutItem | null,
    _placeholder: LayoutItem | null,
    _e: Event,
  ) => {
    suppressClickUntil.current = Date.now() + 350
    const draggedId = newItem?.i ?? null
    const mergeId = mergeReadyId.current
    const meta = dragMeta.current
    dragMeta.current = {}
    mergeRects.current = []
    clearMergeHover()
    setEdgeAttr(null)
    if (!draggedId || !customize) return

    // 1) Freeze every position on this page first (original-position entries for members that were dragged
    // are kept, so removing/dissolving can put them back)
    const snapshot: Record<string, WallLayoutEntry> = { ...customize.prefs.layout }
    for (const li of layout) {
      // Same as handleResizeStop: on narrow screens write only the dragged item (reflow coordinates are not user intent)
      if (cols !== BASE_COLS && li.i !== draggedId) continue
      const kind = items.find((it) => it.id === li.i)?.kind ?? 'cell'
      snapshot[li.i] = toBaseEntry({ page, x: li.x, y: li.y, w: li.w, h: li.h }, cols, kind)
    }
    let foldersNext = folders
    const dragged = items.find((it) => it.id === draggedId)

    if (dragged?.kind === 'icon' && mergeId && mergeId !== draggedId) {
      if (mergeId.startsWith('folder:')) {
        // Drop onto an existing folder = join it.
        const folder = folders.find((f) => folderTileId(f.id) === mergeId)
        if (folder && !folder.memberIds.includes(draggedId)) {
          foldersNext = folders.map((f) =>
            f.id === folder.id ? { ...f, memberIds: [...f.memberIds, draggedId] } : f,
          )
        }
      } else {
        // Drop onto another icon = create a folder at the target's 1×1 slot.
        const target = iconById.get(mergeId)
        const targetEntry = snapshot[mergeId] ?? mergedLayout[mergeId]
        if (target && targetEntry) {
          const fid = `f${Date.now().toString(36)}`
          snapshot[folderTileId(fid)] = fixedIconEntry({ ...targetEntry })
          foldersNext = [
            ...folders,
            { id: fid, name: target.name, memberIds: [mergeId, draggedId] },
          ]
        }
      }
    }

    if (foldersNext === folders && meta.edge) {
      // Dragging to the viewport edge = cross-page (hover-to-flip preview is deferred; edge-drop flipping ships first)
      const targetPage = Math.max(
        0,
        Math.min(pageCount - 1, meta.edge === 'left' ? page - 1 : page + 1),
      )
      if (targetPage !== page && snapshot[draggedId]) {
        snapshot[draggedId] = { ...snapshot[draggedId], page: targetPage }
        setPage(targetPage)
      }
    }

    // Single write: layout is written exactly once (updateFolders' layout deletion is overlay-only; writing again
    // in the same frame would overwrite this with the stale snapshot — measured)
    customize.onLayout(snapshot)
    if (foldersNext !== folders) customize.onFolders(foldersNext)
  }

  return (
    <div className="space-y-4">
      {/* Wall header: the title comes from the tool page header (see "信息墙" in cardRegistry), so only the count
          and manual refresh remain. The standalone page (/?view=wall) has no tool header, so the title shows here,
          and the "browser open" button only exists in the workbench — on the standalone page you are already in a
          browser, so it would be meaningless. "Customize" (appearance + per-cell size/visibility) hangs off this row:
          the bento layout now serves only this wall. */}
      <div className="relative flex flex-wrap items-center gap-3 bento-wallbar">
        <h2 className="sr-only">
          {t('dashboard.title')}
        </h2>
        {data && (
          <span className="text-xs text-neutral-400">
            {t('dashboard.count', { count: shownCount })}
            {abnormal > 0
              ? t('dashboard.countAbnormal', { count: abnormal })
              : shownCount > 0
                ? t('dashboard.countAllOk')
                : ''}
          </span>
        )}
        {data && (
          <span
            className="text-[11px] text-neutral-400"
            title={t('dashboard.generatedAt', { time: data.generated_at })}
          >
            {/* Snapshot time and the live clock are written separately: two formats side by side for the same instant
                (`08:26 08:26:24 生成`) read like a duplicate */}
            {t('dashboard.generatedLine', {
              time: absTime(data.generated_at),
              now: CLOCK_FMT.format(now),
            })}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* Desktop edit mode (the phone home screen's "edit"): drag handles and the component library only exist here.
              Split from "Customize": customize owns appearance and per-cell size (settings-ish), edit mode owns
              "where things sit, what to add, what to remove" (action-ish). */}
          {customize && (
            <button
              data-edit-trigger
              onClick={() => {
                const next = !editMode
                customize.setEditMode(next)
                if (!next) setLibraryOpen(false)
              }}
              aria-pressed={editMode}
              className={`ui-btn ${editMode ? 'ui-btn--on' : ''}`}
              title={t('dashboard.editTooltip')}
            >
              <Icon name={editMode ? 'check' : 'edit'} />
              <span>{editMode ? t('dashboard.done') : t('dashboard.edit')}</span>
            </button>
          )}
          {editMode && customize && (
            <button
              data-library-trigger
              onClick={() => setLibraryOpen((v) => !v)}
              aria-expanded={libraryOpen}
              className={`ui-btn ${libraryOpen ? 'ui-btn--on' : ''}`}
              title={t('dashboard.libraryTooltip')}
            >
              <Icon name="library" />
              <span>{t('dashboard.library')}</span>
              {libraryItems.length > 0 && (
                <span className="ui-badge ui-badge--identity">{libraryItems.length}</span>
              )}
            </button>
          )}
          {customize && (
            <button
              data-pref-trigger
              onClick={() => customize.setOpen(!customize.open)}
              aria-expanded={customize.open}
              className={`ui-btn ${customize.open ? 'ui-btn--on' : ''}`}
              title={t('dashboard.customizeTooltip')}
            >
              <Icon name="palette" />
              <span>{t('dashboard.customize')}</span>
            </button>
          )}
          {/* In a browser this opens a new tab; on desktop it goes through Rust, which ensures the
              backend is running and then opens the system browser. */}
          {(
            <button
              onClick={() => {
                void tauriBridge.openDashboardWeb().catch((e) =>
                  setWebError(e instanceof Error ? e.message : String(e)),
                )
              }}
              className="ui-btn ui-btn--ghost"
              title={t('dashboard.openInBrowserTooltip')}
            >
              <Icon name="external" />
              <span>{t('dashboard.openInBrowser')}</span>
            </button>
          )}
          <button
            onClick={() => void load()}
            disabled={refreshing || loading}
            className="ui-btn ui-btn--ghost ui-btn--icon"
            title={t('dashboard.refresh')}
            aria-label={t('dashboard.refresh')}
          >
            <Icon name="refresh" />
          </button>
          {customize?.open && (
            <PanelCustomize
              prefs={customize.prefs}
              onTheme={customize.onTheme}
              onPacking={customize.onPacking}
              onReset={customize.onReset}
              onClose={() => customize.setOpen(false)}
            />
          )}
        </div>
      </div>

      {/* An open failure shows one line and does not interrupt the rest of the wall (same principle as the error state) */}
      {webError && (
        <CardState
          kind="warn"
          actions={
            <button
              onClick={() => setWebError('')}
              className="px-3 py-1.5 rounded-lg text-xs bg-white/10 hover:bg-white/15 text-neutral-200"
            >
              {t('dashboard.gotIt')}
            </button>
          }
        >
          {t('dashboard.webError', { message: webError })}
        </CardState>
      )}

      {/* Loading: skeleton cells are laid out in the wall's final shape (overview spanning the top + two per row), swapped in place when data arrives */}
      {loading && !data && !error && (
        <>
          <span className="sr-only">{t('dashboard.loading')}</span>
          <div className="bento-grid" data-testid="wall-skeleton">
            {SKELETON_SPANS.map((span, i) => (
              <Card key={`skeleton-${i}`} id={`wall-skeleton-${i}`} span={span} loading />
            ))}
          </div>
        </>
      )}

      {/* Error state: dim only this block, the page never blanks; last data (if any) keeps rendering below */}
      {error && (
        <CardState
          kind="error"
          hint={error.hint || t('dashboard.errorHint')}
          actions={
            <button
              onClick={() => void load()}
              className="px-3 py-1.5 rounded-lg text-xs bg-white/10 hover:bg-white/15 text-neutral-200"
            >
              {t('common.retry')}
            </button>
          }
        >
          {error.message}
        </CardState>
      )}

      {/* Empty state: 200 + total: 0 is neither an error nor loading; having cells that are all hidden locally is a different case */}
      {data && enabled.length === 0 && !error && (
        <CardState kind="empty">
          {t('dashboard.empty.noCellsPrefix')}
          <code className="font-mono">~/.config/yhub/dashboard.json</code>
          {t('dashboard.empty.noCellsSuffix')}
        </CardState>
      )}
      {data && enabled.length > 0 && cells.length === 0 && !error && (
        <CardState kind="empty">{t('dashboard.empty.allHidden')}</CardState>
      )}

      {/* ——— Phase C: single grid engine + paging (D7) ———
          Zone headers are gone (zone/order is only placement metadata); only the current page renders; page dots
          carry alert markers; handle dragging is enabled only in edit mode (the customize popover open). The
          container ref doubles as RGL's width measurement. In edit mode the component library drawer hangs on the
          right (narrow screens turn it into a full panel floating over the wall, see CSS). */}
      <div className="bento-stage">
      {editMode && libraryOpen && customize && (
        <ComponentLibrary
          items={libraryItems}
          onAdd={addFromLibrary}
          onClose={() => setLibraryOpen(false)}
        />
      )}
      <div
        ref={pagerRef}
        className="wall-pager"
        data-wall-pager
        data-page={page}
        data-pages={pageCount}
        data-cols={cols}
        data-edit-mode={editMode ? '1' : '0'}
        data-row-height={rowHeight}
        data-grid-gap={GRID_GAP}
        data-packing={customize?.prefs.packing ?? 'compact'}
        onDragOver={(e) => {
          // Accept only drops from the component library (HTML5 drag defaults to "reject", so preventDefault is required)
          if (!editMode || !libraryOpen) return
          if (!e.dataTransfer.types.includes('application/x-yhub-component')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          e.currentTarget.setAttribute('data-drop-active', '1')
        }}
        onDragLeave={() => pagerRef.current?.removeAttribute('data-drop-active')}
        onDrop={(e) => {
          pagerRef.current?.removeAttribute('data-drop-active')
          if (!editMode || !libraryOpen) return
          const id =
            e.dataTransfer.getData('application/x-yhub-component') ||
            e.dataTransfer.getData('text/plain')
          if (!id || !libraryItems.some((it) => it.id === id)) return
          e.preventDefault()
          dropFromLibrary(id, e.clientX, e.clientY)
        }}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onDragStart={(e) => e.preventDefault()}
        onClickCapture={(e) => {
          if (Date.now() < suppressClickUntil.current) {
            e.preventDefault()
            e.stopPropagation()
          }
        }}
      >
        <div ref={containerRef} className="bento-grid wall-grid" data-wall-grid>
          {widthReady && width > 0 && pageItems.length > 0 && (
            <ReactGridLayout
              layout={rglLayout}
              width={width}
              gridConfig={{
                cols,
                rowHeight,
                margin: [GRID_GAP, GRID_GAP],
                containerPadding: [0, 0],
              }}
              compactor={compactor}
              // In edit mode the **whole card is draggable**, with no separate ⠿ handle: links are already disabled in
              // edit mode (icons have no href, in-card links do not open), so the card face has no other use than
              // dragging/resizing. `cancel` excludes the three elements that consume mouse events themselves: the
              // remove handle, the size handle and the resize handle.
              dragConfig={{
                enabled: editMode,
                bounded: false,
                // 3px threshold: with whole-card dragging, a plain click should not count as a drag (otherwise one click
                // freezes the layout)
                threshold: 3,
                cancel: '[data-remove-handle],[data-size-menu],[data-no-drag],.react-resizable-handle',
              }}
              // Free resize (P2): edit mode only, one handle at the bottom-right. Minimum sizes come from each item's minW/minH
              resizeConfig={{ enabled: editMode, handles: ['se'] }}
              onDragStart={handleDragStart}
              onDrag={handleDrag}
              onDragStop={handleDragStop}
              onResizeStop={handleResizeStop}
            >
              {pageItems.map((it) => {
                const cell = it.kind === 'cell' ? cellById.get(it.id) : undefined
                const icon = it.kind === 'icon' ? iconById.get(it.id) : undefined
                const folder = it.kind === 'folder' ? (it.folder ?? folderById.get(it.id)) : undefined
                const e = it.entry
                return (
                  <div
                    key={it.id}
                    data-wall-item={it.id}
                    data-item-kind={it.kind}
                    data-entry={`${e.page},${e.x},${e.y},${e.w},${e.h}`}
                    className="relative h-full"
                  >
                    {/* Edit-mode "remove": offered for **cells and icons** only (a folder is a container; dissolving goes through
                        its own overlay). Rendered at this level rather than inside the card because removeToLibrary is only
                        visible here, and the handle must sit inside the RGL item's positioning context (absolute against it). */}
                    {editMode && it.kind !== 'folder' && (
                      <button
                        type="button"
                        className="bento-remove-handle"
                        data-remove-handle={it.id}
                        title={t('dashboard.removeToLibrary')}
                        aria-label={t('dashboard.removeToLibraryAria', { id: it.id })}
                        onClick={(ev) => {
                          ev.preventDefault()
                          ev.stopPropagation()
                          removeToLibrary(it.id)
                        }}
                      >
                        <Icon name="close" size={13} />
                      </button>
                    )}
                    {/* Size tile (P2): cells only. Icons/folders are fixed 1×1, so they get neither this menu
                        nor a resize handle. The menu itself renders at the wall level (fixed positioning). */}
                    {editMode && it.kind === 'cell' && (
                      <button
                        type="button"
                        className="bento-size-handle"
                        data-size-menu={it.id}
                        aria-expanded={sizeMenu?.id === it.id}
                        title={t('dashboard.size.title', { w: e.w, h: e.h })}
                        aria-label={t('dashboard.size.aria', { id: it.id })}
                        onClick={(ev) => {
                          ev.preventDefault()
                          ev.stopPropagation()
                          if (sizeMenu?.id === it.id) {
                            setSizeMenu(null)
                            return
                          }
                          const r = ev.currentTarget.getBoundingClientRect()
                          setSizeMenu({
                            id: it.id,
                            x: Math.max(8, Math.min(r.right - 132, window.innerWidth - 148)),
                            y: Math.min(r.bottom + 4, window.innerHeight - 180),
                          })
                        }}
                      >
                        <Icon name="resize" size={13} />
                      </button>
                    )}
                    {cell && (
                      <CellCard
                        cell={cell}
                        now={now}
                        span={spanOf(cell)}
                        editMode={editMode}
                        onNatural={(px) => noteNatural(cell.id, px)}
                        measureToken={measureToken}
                      />
                    )}
                    {icon && (
                      <IconTile
                        item={icon}
                        span="sm"
                        onOpenTool={onOpenTool}
                        onError={setWebError}
                        editMode={editMode}
                      />
                    )}
                    {folder && (
                      <FolderTile
                        folder={folder}
                        members={folderMembersOf(folder)}
                        span="sm"
                        onOpen={() => setOpenFolderId(folder.id)}
                        editMode={editMode}
                      />
                    )}
                  </div>
                )
              })}
            </ReactGridLayout>
          )}
        </div>

        {/* Page dots: numeric dots plus a red dot on pages holding an alert cell; hidden when there is one page */}
        {pageCount > 1 && (
          <nav className="page-dots" data-page-dots aria-label={t('dashboard.pages.aria')}>
            {Array.from({ length: pageCount }, (_, i) => (
              <button
                key={i}
                data-page-dot={i}
                aria-current={i === page ? 'page' : undefined}
                aria-label={
                  pagesWithAlert.has(i)
                    ? t('dashboard.pages.labelAlert', { page: i + 1 })
                    : t('dashboard.pages.label', { page: i + 1 })
                }
                onClick={() => setPage(i)}
              >
                <span className="page-dots__num">{i + 1}</span>
                {pagesWithAlert.has(i) && <span className="page-dots__alert" data-page-alert={i} />}
              </button>
            ))}
          </nav>
        )}

        {/* Highlight when dragged to the viewport edge: releasing flips to the adjacent page (the attribute is written
            imperatively by handleDrag to avoid re-rendering mid-drag) */}

        {/* Size preset menu (P2): fixed positioning plus a transparent scrim that closes it on an outside click.
            Not mounted inside a grid item: RGL's transform creates a stacking context and neighbours would cover the menu. */}
        {sizeMenu &&
          (() => {
            const target = items.find((i) => i.id === sizeMenu.id)
            // Stale menu state or a fixed 1×1 icon/folder must never open a size menu.
            if (!target || target.kind !== 'cell') return null
            const cur = target.entry
            // A cell cannot do the icon tier (1/12 width is unreadable) — so that option is not offered here
            const min = minBox('cell')
            const presets = SIZE_PRESETS.filter((p) => {
              const box = tierBox(p.value)
              return box.w >= min.minW && box.h >= min.minH
            })
            return (
              <>
                <div className="bento-size-scrim" onClick={() => setSizeMenu(null)} />
                <div
                  className="bento-size-menu"
                  data-size-popup={sizeMenu.id}
                  role="menu"
                  aria-label={t('dashboard.size.menuAria', { id: sizeMenu.id })}
                  style={{ left: sizeMenu.x, top: sizeMenu.y }}
                >
                  {presets.map((p) => {
                    const box = tierBox(p.value)
                    const on = cur ? cur.w === box.w && cur.h === box.h : false
                    return (
                      <button
                        key={p.value}
                        type="button"
                        role="menuitem"
                        data-size-preset={p.value}
                        aria-pressed={on}
                        className={on ? 'is-on' : ''}
                        onClick={() => {
                          applySize(sizeMenu.id, p.value)
                          setSizeMenu(null)
                        }}
                      >
                        {t(p.labelKey)}
                      </button>
                    )
                  })}
                  {/* Clearing the size preference = back to "height follows content" (P3). Without this, once a size was
                      set there was no way back to auto height except "restore defaults", which wipes the whole desktop. */}
                  <button
                    type="button"
                    role="menuitem"
                    data-size-auto="1"
                    aria-pressed={!customize?.prefs.sizes[sizeMenu.id]}
                    className={!customize?.prefs.sizes[sizeMenu.id] ? 'is-on' : ''}
                    onClick={() => {
                      useAutoHeight(sizeMenu.id)
                      setSizeMenu(null)
                    }}
                  >
                    {t('dashboard.size.auto')}
                  </button>
                  <span className="bento-size-menu__hint">{t('dashboard.size.hint')}</span>
                </div>
              </>
            )
          })()}

        {/* Folder overlay: open/remove members, rename, dissolve */}
        {openFolder && (
          <FolderOverlay
            folder={openFolder}
            members={folderMembersOf(openFolder)}
            onOpenMember={(member) => {
              openIconItem(member, onOpenTool, setWebError)
              setOpenFolderId(null)
            }}
            onRemoveMember={(memberId) => {
              updateFolders(
                folders
                  .map((f) =>
                    f.id === openFolder.id
                      ? { ...f, memberIds: f.memberIds.filter((m) => m !== memberId) }
                      : f,
                  )
                  .filter((f) => f.memberIds.length > 0),
              )
            }}
            onRename={() => {
              const name = window.prompt(t('dashboard.folder.renamePrompt'), openFolder.name)
              if (name && name.trim()) {
                updateFolders(
                  folders.map((f) =>
                    f.id === openFolder.id ? { ...f, name: name.trim() } : f,
                  ),
                )
              }
            }}
            onDissolve={() => {
              updateFolders(folders.filter((f) => f.id !== openFolder.id))
              setOpenFolderId(null)
            }}
            onClose={() => setOpenFolderId(null)}
          />
        )}
      </div>
      </div>
    </div>
  )
}
