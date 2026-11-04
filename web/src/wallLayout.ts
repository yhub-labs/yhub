/**
 * Pure desktop-layout logic (phase C / D7): default placement, paging, in-page clamping.
 *
 * Touches neither React nor the DOM — the math lives here, Dashboard only renders and persists.
 *
 * Three sources feed one visible list:
 *   1. **Default placement** (never dragged): alerts overview → app icons → folders → todos →
 *      status, packed into pages as shelves (page capacity = 12 cols × rowsPerPage); `zone/order`
 *      is only metadata for that order.
 *   2. **User-dragged entries** (panelPrefs.layout): page + in-page coordinates as stored, clamped
 *      to the current column count before rendering. Icons and folders are always normalized to
 *      exactly one 1×1 slot; only cells may be resized.
 *   3. **Folders** (panelPrefs.folders): members are not rendered individually; the folder takes
 *      one slot itself (`folder:<id>`).
 *
 * Columns: paging always uses a base of **12** (desktop); on narrow screens (6/3 cols) w/x are
 * clamped to the real count, so a wide card (full=12) stays full width at 6 and at 3 columns —
 * the meaning survives.
 *
 * Why 12 (E1): at 4 columns an icon had to fill a 268×182px cell (the icon itself is 28px),
 * because the grid scale was designed for **information cards** and icons reused the same ruler.
 * 12 divides 2/3/4/6, so "icon 1/12, small card 1/2, large card 1/2 with double height, full-width
 * row" all land on one scale.
 */
import type { WallFolder, WallLayoutEntry } from './panelPrefs'

/** Paging base column count (desktop); the render layer clamps to 12/6/3 by viewport width */
export const BASE_COLS = 12

/** Column count at the tablet breakpoint (≥640px) */
export const TABLET_COLS = 6

/** Column count at the phone breakpoint (<640px) */
export const PHONE_COLS = 3

/**
 * **Base pixel height** of one grid row. A fixed value, no longer derived from the viewport
 * (the old version floated between 110–240px). Icon/card size should not wobble with the
 * monitor — adapting to the viewport is `rowsPerPage`'s job ("how many rows fit a page"), not
 * "how tall is one row".
 */
export const ROW_PX = 80

/** Grid gap (same value as `--bento-gap` in bento.css): RGL margins and drop-target math both read it */
export const GRID_GAP = 12

/** Four size tiers → grid footprint (12-column base) */
export function tierBox(tier: string): { w: number; h: number } {
  switch (tier) {
    case 'sm':
      // icon tier: 1 of 12 columns ≈ 82×80px, the icon fills it exactly
      return { w: 1, h: 1 }
    case 'lg':
      return { w: 6, h: 4 }
    case 'full':
      return { w: BASE_COLS, h: 2 }
    case 'md':
    default:
      return { w: 6, h: 2 }
  }
}

/** The three item kinds on the desktop: decides minimum size (a cell must not be squeezed to icon size) */
export type ItemKind = 'cell' | 'icon' | 'folder'

/**
 * Minimum size (lower bound for free resizing).
 * A cell is a **card with body text**: squeezed to 1 column wide (≈82px) the header, status dot
 * and body crush together, so it gets 3×2; icons/folders have no body, so 1×1 is their natural
 * size.
 */
export function minBox(kind: ItemKind): { minW: number; minH: number } {
  return kind === 'cell' ? { minW: 3, minH: 2 } : { minW: 1, minH: 1 }
}

/**
 * Which tier the free-resized w/h is closest to — written back into `prefs.sizes`.
 * Without this mapping the size dropdown in "customize" would keep showing the old tier (a lie).
 */
export function tierOf(w: number, h: number): string {
  let best = 'sm'
  let cost = Number.POSITIVE_INFINITY
  for (const tier of ['sm', 'md', 'lg', 'full']) {
    const box = tierBox(tier)
    const c = Math.abs(box.w - w) * 2 + Math.abs(box.h - h) * 3
    if (c < cost) {
      cost = c
      best = tier
    }
  }
  return best
}

/** Preference id prefix for icons/folders. */
export function isIconId(id: string): boolean {
  return /^(tool|app|folder):/.test(id)
}

export interface PackerItem {
  id: string
  /** size tier (sm/md/lg/full) */
  tier: string
}

/**
 * Default placement: shelf packing into pages. Wrap when `x` does not fit, page over when `y`
 * overflows. Input order = placement order (the caller sorts it: overview → icons → zone cells).
 *
 * **A wrap must skip the whole shelf height**: the old version did `y += 1`, so after a 2-row
 * item (full-width row, large card) the next line landed right on top of it (P1: every icon
 * stacked onto the second row of the full-width overview cell).
 */
export function packPages(
  items: PackerItem[],
  rowsPerPage: number,
): Record<string, WallLayoutEntry> {
  const out: Record<string, WallLayoutEntry> = {}
  let page = 0
  let x = 0
  let y = 0
  let shelfH = 0
  for (const item of items) {
    const { w, h } = tierBox(item.tier)
    if (x + w > BASE_COLS) {
      x = 0
      y += Math.max(1, shelfH)
      shelfH = 0
    }
    if (y + h > rowsPerPage) {
      page += 1
      x = 0
      y = 0
      shelfH = 0
    }
    out[item.id] = { page, x, y, w, h }
    x += w
    shelfH = Math.max(shelfH, h)
  }
  return out
}

/** Clamp to the current column count: wide cards fill it, coordinates stay in range (at 1 column everything stacks full width) */
export function clampEntry(entry: WallLayoutEntry, cols: number, rows: number): WallLayoutEntry {
  const w = Math.min(entry.w, cols)
  const h = Math.min(entry.h, rows)
  const x = Math.min(entry.x, Math.max(0, cols - w))
  const y = Math.min(entry.y, Math.max(0, rows - h))
  return { ...entry, w, h, x, y }
}

/** A folder's id in the layout (folder tiles share panelPrefs.layout with icons) */
export function folderTileId(folderId: string): string {
  return `folder:${folderId}`
}

/**
 * Icons and folders have exactly one size: one 1×1 grid slot. Stale preferences from older
 * layouts are normalized here so neither rendering nor persistence can make them larger.
 */
export function fixedIconEntry(entry: WallLayoutEntry): WallLayoutEntry {
  return { ...entry, w: 1, h: 1 }
}

/** One item on the paged wall grid: information cell, app icon or icon folder */
export interface VisibleItem {
  id: string
  entry: WallLayoutEntry
  kind: ItemKind
  /** Present for `kind === 'folder'`; the grid renders this folder's tile */
  folder?: WallFolder
}

/**
 * Narrow-screen reflow: coordinates are stored against a **12-column base**, so clamping x
 * directly at 6/3 columns would pile everything with x=3..11 onto the right edge in one column
 * (P1: on phones icons went from "three per row" to "one under another").
 * Narrow screens therefore **reflow** instead: sort by (page, row, column) and refill as shelves
 * left to right, wrapping and paging when an item is too wide or the page overflows.
 */
function reflow(items: VisibleItem[], cols: number, rows: number): VisibleItem[] {
  const byPage = new Map<number, VisibleItem[]>()
  for (const it of items) {
    const p = Math.max(0, Math.floor(it.entry.page))
    if (!byPage.has(p)) byPage.set(p, [])
    byPage.get(p)!.push(it)
  }
  const out: VisibleItem[] = []
  let page = 0
  let x = 0
  let y = 0
  let shelfH = 0
  for (const p of [...byPage.keys()].sort((a, b) => a - b)) {
    const list = [...byPage.get(p)!].sort(
      (a, b) => a.entry.y - b.entry.y || a.entry.x - b.entry.x || a.id.localeCompare(b.id),
    )
    // every original page starts on a fresh row — don't append it under the previous page's last row
    if (x !== 0) {
      x = 0
      y += Math.max(1, shelfH)
      shelfH = 0
    }
    for (const it of list) {
      const w = Math.max(1, Math.min(it.entry.w, cols))
      const h = Math.max(1, Math.min(it.entry.h, rows))
      if (x + w > cols) {
        x = 0
        y += Math.max(1, shelfH)
        shelfH = 0
      }
      if (y + h > rows) {
        page += 1
        x = 0
        y = 0
        shelfH = 0
      }
      out.push({ ...it, entry: { page, x, y, w, h } })
      x += w
      shelfH = Math.max(shelfH, h)
    }
  }
  return out
}

/**
 * Convert coordinates under the **current column count** back to the **12-column base** (used
 * before persisting). Row height is fixed, so y/h do not change with column count; only x/w scale
 * by `12/cols`.
 * An icon/folder is always one 1×1 slot, so dragging it on a narrow screen cannot make it
 * larger in the 12-column base either.
 */
export function toBaseEntry(
  entry: WallLayoutEntry,
  cols: number,
  kind: ItemKind,
): WallLayoutEntry {
  const fixed = kind === 'cell' ? entry : fixedIconEntry(entry)
  if (cols === BASE_COLS || cols <= 0) return fixed
  const k = BASE_COLS / cols
  return {
    page: fixed.page,
    x: Math.max(0, Math.min(BASE_COLS - 1, Math.round(fixed.x * k))),
    y: fixed.y,
    w: kind === 'cell' ? Math.max(1, Math.round(fixed.w * k)) : 1,
    h: fixed.h,
  }
}

/**
 * Visible list for the paged wall: cells, app icons and icon folders all share one grid.
 *
 * - hidden cells/icons and folder members are not rendered; folder tiles are always visible,
 *   because dissolving a folder (not hiding it) is its removal path;
 * - icons/folders are forced to 1×1, regardless of any stale size preference or layout entry;
 * - wide screens (12 cols) clamp the stored coordinates; narrow screens (6/3 cols) go through
 *   `reflow`.
 */
export function visibleItems(opts: {
  entries: Record<string, WallLayoutEntry>
  hidden: string[]
  folders: WallFolder[]
  cells: { id: string }[]
  icons: { id: string }[]
  cols: number
  rows: number
}): VisibleItem[] {
  const { entries, hidden, folders, cells, icons, cols, rows } = opts
  const hiddenSet = new Set(hidden)
  const memberSet = new Set(folders.flatMap((f) => f.memberIds))

  const items: VisibleItem[] = []
  for (const c of cells) {
    const entry = entries[c.id]
    if (!entry || hiddenSet.has(c.id) || memberSet.has(c.id)) continue
    items.push({ id: c.id, entry, kind: 'cell' })
  }
  for (const i of icons) {
    const entry = entries[i.id]
    if (!entry || hiddenSet.has(i.id) || memberSet.has(i.id)) continue
    items.push({ id: i.id, entry: fixedIconEntry(entry), kind: 'icon' })
  }
  for (const f of folders) {
    const id = folderTileId(f.id)
    const entry = entries[id] ?? { page: 0, x: 0, y: 0, w: 1, h: 1 }
    items.push({ id, entry: fixedIconEntry(entry), kind: 'folder', folder: f })
  }
  if (cols !== BASE_COLS) return reflow(items, cols, rows)
  return items.map((it) => ({ ...it, entry: clampEntry(it.entry, cols, rows) }))
}

/**
 * Content-driven height (P3): given a card's natural pixel height, return how many rows it needs.
 *
 * RGL's h is an integer row count and card height = `h × ROW_PX + (h−1) × GAP`, so the inverse
 * must round up — better one row of trailing whitespace than a clipped last paragraph.
 */
export function rowsForContent(px: number, rows: number, minH: number): number {
  if (!Number.isFinite(px) || px <= 0) return minH
  const h = Math.ceil((px + GRID_GAP) / (ROW_PX + GRID_GAP))
  return Math.max(minH, Math.min(rows, h))
}

/**
 * Find a free slot for an item just added from the widget library (phone home screens' "add an
 * icon").
 *
 * Scan row by row from page 0: look for `w` consecutive free columns whose `h` rows are also free;
 * wrap when it does not fit; page over when the page is full. If nothing is found (only possible
 * on a pathologically full page), fall back to the end of the last page — let RGL's vertical
 * compaction settle it, which beats "clicked and nothing happened".
 *
 * Only **same-page** occupancy counts: stacking across pages is meaningless (one page is one
 * screen), so other pages are not checked.
 */
export function findFreeSlot(
  occupied: WallLayoutEntry[],
  w: number,
  h: number,
  cols: number,
  rowsPerPage: number,
): WallLayoutEntry {
  const width = Math.min(Math.max(1, w), cols)
  const height = Math.min(Math.max(1, h), rowsPerPage)
  const byPage = new Map<number, WallLayoutEntry[]>()
  for (const e of occupied) {
    const page = Math.max(0, Math.floor(e.page))
    if (!byPage.has(page)) byPage.set(page, [])
    byPage.get(page)!.push(e)
  }
  const maxPage = Math.max(0, ...[...byPage.keys()])
  for (let page = 0; page <= maxPage + 1; page += 1) {
    const taken = byPage.get(page) ?? []
    for (let y = 0; y + height <= rowsPerPage; y += 1) {
      for (let x = 0; x + width <= cols; x += 1) {
        const clash = taken.some(
          (t) =>
            x < t.x + t.w &&
            t.x < x + width &&
            y < t.y + t.h &&
            t.y < y + height,
        )
        if (!clash) return { page, x, y, w: width, h: height }
      }
    }
  }
  const last = byPage.get(maxPage) ?? []
  const bottom = last.reduce((m, e) => Math.max(m, e.y + e.h), 0)
  return { page: maxPage, x: 0, y: bottom, w: width, h: height }
}
