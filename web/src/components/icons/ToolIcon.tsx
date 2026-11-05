// Renders a tool/plugin/capsule icon: a known drawn-icon name, an image (data: / https: URL), or a
// short text label (an emoji such as 📄, or a couple of CJK characters).
//
// Why the text kind exists: a capsule's **declared** icon (the `capsules.json` overlay, Settings →
// capsules) is cheapest as an emoji, while a scraped `<link rel=icon>` is an image. Rendering the
// emoji as `<img src="📄">` fails silently, so the value is classified once here and every surface
// (launcher, wall, settings list) draws the same thing.
import { useState } from 'react'
import { Icon, type IconName } from './Icon'

const NAMES = new Set<string>([
  'dashboard', 'zdic', 'memos', 'rclone', 'gemini', 'scheduler',
  'checkList', 'stethoscope', 'sync', 'broom', 'rss', 'settings', 'home', 'plugin', 'capsule',
  'tray', 'keyboard', 'search', 'folder', 'library',
])

export type ResolvedIcon =
  | { kind: 'name'; name: IconName }
  | { kind: 'image'; src: string }
  | { kind: 'text'; text: string }

/** Non-ASCII + short = a label/emoji. ASCII stays a name (so an unknown ASCII name still falls back). */
function isTextLabel(value: string): boolean {
  return value.length <= 16 && /[^\x00-\x7f]/.test(value) && !/^(data:|https?:)/.test(value)
}

export function resolveIcon(raw: string | undefined | null, fallback: IconName = 'info'): ResolvedIcon {
  const value = (raw ?? '').trim()
  if (!value) return { kind: 'name', name: fallback }
  if (NAMES.has(value)) return { kind: 'name', name: value as IconName }
  if (/^(data:|https?:)/.test(value)) return { kind: 'image', src: value }
  if (isTextLabel(value)) return { kind: 'text', text: value }
  return { kind: 'name', name: fallback }
}

export function ToolIcon({
  icon,
  fallback = 'info',
  size = '1em',
  className,
}: {
  icon?: string | null
  fallback?: IconName
  size?: number | string
  className?: string
}) {
  // A broken image URL (a stale https: icon, a truncated data: string) falls back to the glyph
  // instead of leaving the browser's broken-image box behind.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const resolved = resolveIcon(icon, fallback)
  if (resolved.kind === 'image') {
    if (failedSrc === resolved.src) return <Icon name={fallback} size={size} className={className} />
    return (
      <img
        src={resolved.src}
        alt=""
        aria-hidden="true"
        className={className ?? 'tool-icon-img'}
        onError={() => setFailedSrc(resolved.src)}
      />
    )
  }
  if (resolved.kind === 'text') {
    return (
      <span
        className={className ?? 'tool-icon-text'}
        aria-hidden="true"
        style={{ fontSize: typeof size === 'number' ? `${size}px` : size, lineHeight: 1 }}
      >
        {resolved.text}
      </span>
    )
  }
  return <Icon name={resolved.name} size={size} className={className} />
}

export default ToolIcon
