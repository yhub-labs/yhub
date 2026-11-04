// Hand-drawn icons (Lucide style: 24 grid / 1.75 stroke / round caps and joins). No icon library, no CDN.
//
// Why not emoji: an emoji is a color bitmap glyph, so size, optical weight and baseline come from
// the font — 📖 and 🗄️ in one row can differ 2× visually and look dirty on light backgrounds;
// screen readers also read them literally ("book", "floppy") and glyphs change per platform.
// Every UI icon goes through here and is colored with currentColor.
//
// Usage: <Icon name="zdic" /> (size comes from CSS 1em / font-size, 1em by default).
import type { SVGProps } from 'react'

export type IconName =
  // view / navigation
  | 'search'
  | 'settings'
  | 'home'
  | 'chevronLeft'
  | 'chevronRight'
  | 'close'
  | 'check'
  | 'pin'
  | 'pinOff'
  | 'refresh'
  | 'edit'
  | 'palette'
  | 'library'
  | 'drag'
  | 'resize'
  | 'trash'
  | 'external'
  | 'warning'
  | 'info'
  | 'plus'
  | 'keyboard'
  | 'plugin'
  | 'capsule'
  | 'tray'
  | 'folder'
  | 'link'
  | 'more'
  | 'arrowUpRight'
  | 'globe'
  | 'eyeOff'
  | 'shield'
  | 'terminal'
  | 'sidebar'
  | 'sun'
  | 'moon'
  // tools (one-to-one with each adapter's TOOL_META.icon, see web/src/icons.ts)
  | 'dashboard'
  | 'zdic'
  | 'memos'
  | 'rclone'
  | 'gemini'
  | 'scheduler'
  | 'checkList'
  | 'stethoscope'
  | 'sync'
  | 'broom'
  | 'rss'

type Paths = readonly string[]

const PATHS: Record<IconName, Paths> = {
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4.2-4.2'],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  ],
  home: ['M4 10.5 12 4l8 6.5', 'M6.5 9v10a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9', 'M10 20v-5h4v5'],
  sidebar: ['M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M9 4v16'],
  sun: [
    'M12 3v2',
    'M12 19v2',
    'M4.22 4.22l1.42 1.42',
    'M18.36 18.36l1.42 1.42',
    'M3 12h2',
    'M19 12h2',
    'M4.22 19.78l1.42-1.42',
    'M18.36 5.64l1.42-1.42',
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  ],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z'],
  chevronLeft: ['M14.5 5.5 8 12l6.5 6.5'],
  chevronRight: ['M9.5 5.5 16 12l-6.5 6.5'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  check: ['M4.5 12.5 9.5 17.5 19.5 7'],
  pin: ['M9 3h6', 'M12 3v8', 'M7 20h10', 'M12 11c-2.5 0-4 1.6-4 3.6 0 1.5.8 2.6 2 3.4V20h4v-2c1.2-.8 2-1.9 2-3.4 0-2-1.5-3.6-4-3.6z'],
  pinOff: ['M9 3h6', 'M12 3v8', 'M7 20h10', 'M4 4l16 16'],
  refresh: ['M20 11a8 8 0 1 0-2.3 6.2', 'M20 5v6h-6'],
  edit: ['M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z', 'M14.5 6.5l3 3'],
  palette: [
    'M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.7 1.8-1.7 0-.6-.2-1-.6-1.4-.4-.4-.6-.8-.6-1.3 0-1 .8-1.8 1.8-1.8H16a5 5 0 0 0 5-5C21 6 17 3 12 3z',
    'M7.5 11.5h.01',
    'M10 8h.01',
    'M14 7.5h.01',
  ],
  library: ['M4 6h3v14H4z', 'M10 6h3v14h-3z', 'M16.2 6.7l2.9-.6 2.1 13.2-2.9.6z'],
  drag: ['M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01'],
  // RSS: fan of arcs plus a dot (Lucide rss geometry; the dot is drawn with a round linecap)
  rss: ['M4 11a9 9 0 0 1 9 9', 'M4 4a16 16 0 0 1 16 16', 'M5 19h.01'],
  // Free resize: two outward arrows at the bottom-right corner (Lucide maximize-2 geometry)
  resize: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'],
  trash: ['M4 7h16', 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2', 'M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12', 'M10 11v5', 'M14 11v5'],
  external: ['M14 4h6v6', 'M20 4l-8 8', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  warning: ['M12 4 3 19h18L12 4z', 'M12 10v4', 'M12 17h.01'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 11v5', 'M12 8h.01'],
  plus: ['M12 5v14', 'M5 12h14'],
  keyboard: ['M3 7.5A1.5 1.5 0 0 1 4.5 6h15A1.5 1.5 0 0 1 21 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5z', 'M7 10h.01', 'M11 10h.01', 'M15 10h.01', 'M8 14h8'],
  plugin: ['M9 3v4', 'M15 3v4', 'M6 7h12v5a6 6 0 0 1-12 0z', 'M12 18v3'],
  capsule: ['M10.5 3.5 3.5 10.5a3.5 3.5 0 0 0 5 5l7-7a3.5 3.5 0 0 0-5-5z', 'M7 7l7 7'],
  tray: ['M4 13h4l1.5 3h5L16 13h4', 'M4 13 6.5 5h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z'],
  folder: ['M3 7a1 1 0 0 1 1-1h5l2 2.5h8a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z'],
  link: ['M10 13.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L11 7.5', 'M14 10.5a3.5 3.5 0 0 0-5 0L6.5 13a3.5 3.5 0 0 0 5 5l1.5-1.5'],
  more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  arrowUpRight: ['M7 17 17 7', 'M9 7h8v8'],
  globe: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3.5 12h17', 'M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z'],
  eyeOff: ['M4 4l16 16', 'M10.6 5.2A9.6 9.6 0 0 1 12 5c5 0 9 7 9 7a17 17 0 0 1-3.2 3.9', 'M6.6 7.4A17.6 17.6 0 0 0 3 12s4 7 9 7a9.5 9.5 0 0 0 4.2-1', 'M9.8 9.9a3 3 0 0 0 4.2 4.2'],
  shield: ['M12 3l7 3v5.5c0 4-3 7.4-7 9.5-4-2.1-7-5.5-7-9.5V6z', 'M9 12l2 2 4-4'],
  terminal: ['M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z', 'M7.5 10.5 10 13l-2.5 2.5', 'M13 15.5h4'],
  dashboard: ['M4 4h7v6H4z', 'M4 14h7v6H4z', 'M15 4h5v10h-5z', 'M15 18h5v2h-5z'],
  zdic: ['M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z', 'M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z', 'M7 8h1.5', 'M7 11h1.5'],
  memos: ['M5 4h10l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M14 4v4h4', 'M8 12h8', 'M8 16h5'],
  rclone: ['M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z', 'M4 10h16', 'M7.5 13h.01', 'M7.5 16h.01'],
  gemini: ['M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z'],
  scheduler: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M12 8v4.5l3 1.8'],
  checkList: ['M4 6.5 6 8.5 9.5 5', 'M4 17.5l2 2 3.5-3.5', 'M13 7h7', 'M13 18h7'],
  stethoscope: ['M6 4v6a4 4 0 0 0 8 0V4', 'M10 14v3a4 4 0 0 0 8 0v-1.2', 'M18 8.5h.01'],
  sync: ['M20 12a8 8 0 0 1-13.7 5.6', 'M4 12a8 8 0 0 1 13.7-5.6', 'M4 19v-4h4', 'M20 5v4h-4'],
  broom: ['M14 4l6 6', 'M9.5 12.5l2 2', 'M12 10.5 13.5 9l4 4-6.5 6.5-3-3z', 'M8 14l-4 6 6-4'],
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  /** Visual size (px); defaults to 1em so it follows the font size */
  size?: number | string
  /** Stroke weight: on a 24 grid, 1.75 is the step that matches 13px text in weight */
  strokeWidth?: number
  /** Accessible name; without one the icon is treated as decorative (aria-hidden) */
  label?: string
}

export function Icon({ name, size = '1em', strokeWidth = 1.75, label, ...rest }: IconProps) {
  const paths = PATHS[name] ?? PATHS.info
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

export default Icon
