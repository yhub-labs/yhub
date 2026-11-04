// Renders a tool/plugin icon: a known drawn-icon name or an image data/HTTPS URL.
import { Icon, type IconName } from './Icon'

const NAMES = new Set<string>([
  'dashboard', 'zdic', 'memos', 'rclone', 'gemini', 'scheduler',
  'checkList', 'stethoscope', 'sync', 'broom', 'rss', 'settings', 'home', 'plugin', 'capsule',
  'tray', 'keyboard', 'search', 'folder', 'library',
])

export type ResolvedIcon =
  | { kind: 'name'; name: IconName }
  | { kind: 'image'; src: string }

export function resolveIcon(raw: string | undefined | null, fallback: IconName = 'info'): ResolvedIcon {
  const value = (raw ?? '').trim()
  if (!value) return { kind: 'name', name: fallback }
  if (NAMES.has(value)) return { kind: 'name', name: value as IconName }
  if (/^(data:|https?:)/.test(value)) return { kind: 'image', src: value }
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
  const resolved = resolveIcon(icon, fallback)
  if (resolved.kind === 'image') {
    return <img src={resolved.src} alt="" aria-hidden="true" className={className ?? 'tool-icon-img'} />
  }
  return <Icon name={resolved.name} size={size} className={className} />
}

export default ToolIcon
