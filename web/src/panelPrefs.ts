/**
 * Panel preferences: theme, per-card size overrides, card visibility, desktop layout, icon folders.
 *
 * Frontend-only (localStorage): read on mount via App.tsx's lazy initializer (so the first paint
 * already has the right theme and never flashes dark), written on change from App.tsx's
 * useEffect. The backend knows nothing about it — another machine or cleared storage returns to
 * factory state.
 *
 * Only known fields with valid values survive: dirty data (hand edits, leftovers from older
 * versions) is dropped field by field and falls back to defaults, so a weird value sitting in
 * localStorage can never stop the panel from booting.
 * Defaults = factory state (theme=dark, sizes empty = declared size, hidden empty = all visible,
 * layout empty = default shelf packing, folders empty = no folders).
 */
import type { CardSpan } from './components/Card'

/** Dark is the factory default (see the palette comment in bento.css) */
export type ThemeMode = 'dark' | 'light'

/**
 * Grid packing mode (P2):
 *  - `compact`: RGL compacts vertically, items always float up, no empty rows;
 *  - `free`: no compaction — items stay where they were dropped, and gaps are gaps the **user**
 *    asked for.
 */
export type PackingMode = 'compact' | 'free'

/**
 */
/** Size presets (12-column base): sm=1×1 (icon), md=6×2, lg=6×4, full=12×2 (full width) */
export type CardSize = CardSpan

/**
 * One entry per item (phase C / D7): `page` is the page index, `x/y/w/h` are grid coordinates
 * inside that page (12-column base, clamped to 6/3 when rendering narrow screens). Only items the
 * user has dragged get an entry; ids without one use the default shelf packing.
 *
 * Note: `w/h` are **free values**, not limited to the four tiers — P2 added resizing, so whatever
 * the user dragged to wins.
 */
export interface WallLayoutEntry {
  page: number
  x: number
  y: number
  w: number
  h: number
}

/** Icon folder (phase C / D7): icons only; members keep their layout entries so dissolving restores them in place */
export interface WallFolder {
  id: string
  name: string
  memberIds: string[]
}

export interface PanelPrefs {
  theme: ThemeMode
  /** card id → size override; unregistered ids keep their declared default size */
  sizes: Record<string, CardSize>
  /** hidden card ids: skipped by both grid and sidebar; the customize popover can re-enable them */
  hidden: string[]
  /** desktop layout: id → page + in-page coordinates; persisted after drag/resize, cleared by "reset" */
  layout: Record<string, WallLayoutEntry>
  /** grid packing mode: compact (vertical compaction) / free (stays where dropped) */
  packing: PackingMode
  /** icon folders (phase C): same lifecycle as layout, cleared by "reset" as well */
  folders: WallFolder[]
}

export const PANEL_PREFS_KEY = 'yhub.panel.prefs'

export const DEFAULT_PREFS: PanelPrefs = {
  theme: 'dark',
  sizes: {},
  hidden: [],
  layout: {},
  packing: 'compact',
  folders: [],
}

const THEMES: readonly string[] = ['dark', 'light']
const PACKINGS: readonly string[] = ['compact', 'free']
const SIZES: readonly string[] = ['sm', 'md', 'lg', 'full']

/** Keep only known values: unknown fields and invalid values are dropped (empty result = all defaults) */
function sanitize(raw: unknown): PanelPrefs {
  const prefs: PanelPrefs = {
    theme: 'dark',
    sizes: {},
    hidden: [],
    layout: {},
    packing: 'compact',
    folders: [],
  }
  if (typeof raw !== 'object' || raw === null) return prefs
  const obj = raw as Record<string, unknown>

  if (typeof obj.packing === 'string' && PACKINGS.includes(obj.packing)) {
    prefs.packing = obj.packing as PackingMode
  }

  if (typeof obj.theme === 'string' && THEMES.includes(obj.theme)) {
    prefs.theme = obj.theme as ThemeMode
  }
  if (typeof obj.sizes === 'object' && obj.sizes !== null) {
    for (const [id, size] of Object.entries(obj.sizes as Record<string, unknown>)) {
      if (typeof id === 'string' && typeof size === 'string' && SIZES.includes(size)) {
        prefs.sizes[id] = size as CardSize
      }
    }
  }
  if (Array.isArray(obj.hidden)) {
    prefs.hidden = obj.hidden.filter((id): id is string => typeof id === 'string')
  }
  if (typeof obj.layout === 'object' && obj.layout !== null) {
    for (const [id, entry] of Object.entries(obj.layout as Record<string, unknown>)) {
      if (typeof id !== 'string' || typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      const nums = [e.page, e.x, e.y, e.w, e.h].map((v) => (typeof v === 'number' ? v : NaN))
      if (nums.some((v) => !Number.isFinite(v) || v < 0)) continue
      prefs.layout[id] = {
        page: Math.floor(nums[0]),
        x: Math.floor(nums[1]),
        y: Math.floor(nums[2]),
        w: Math.max(1, Math.floor(nums[3])),
        h: Math.max(1, Math.floor(nums[4])),
      }
    }
  }
  if (Array.isArray(obj.folders)) {
    for (const f of obj.folders) {
      if (typeof f !== 'object' || f === null) continue
      const folder = f as Record<string, unknown>
      if (typeof folder.id !== 'string' || typeof folder.name !== 'string') continue
      if (!Array.isArray(folder.memberIds)) continue
      const memberIds = folder.memberIds.filter((m): m is string => typeof m === 'string')
      if (memberIds.length === 0) continue // an empty folder is meaningless — drop it
      prefs.folders.push({ id: folder.id, name: folder.name, memberIds })
    }
  }

  return prefs
}

export function loadPrefs(): PanelPrefs {
  try {
    return sanitize(JSON.parse(window.localStorage.getItem(PANEL_PREFS_KEY) ?? 'null'))
  } catch {
    // private mode / storage disabled / hand-broken JSON: treat as "no preferences"
    return { ...DEFAULT_PREFS }
  }
}

export function savePrefs(prefs: PanelPrefs): void {
  try {
    window.localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // cannot persist: prefs still apply for this session, only a reload falls back to defaults
  }
}
