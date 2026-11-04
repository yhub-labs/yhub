// Status marks: one set of semantic colors for "dot + text", and a dot never stands alone (never color only).
//
// Semantics (same as cardRegistry.statusTone, which is the single source of truth):
//   ok / warn / error / idle — color is only for quick scanning, the text is what people read.
import type { ReactNode } from 'react'
import { Icon } from './Icon'

export type Tone = 'ok' | 'warn' | 'error' | 'idle'

export function StatusDot({ tone, title }: { tone: Tone; title?: string }) {
  return (
    <span
      className={`ui-dot ui-dot--${tone}`}
      title={title}
      aria-label={title}
      role={title ? 'img' : undefined}
    />
  )
}

/** Inline status badge: a dot + a short phrase (optional icon), colored via ui-badge--<tone> */
export function StatusBadge({
  tone,
  children,
  icon,
  title,
}: {
  tone: Tone
  children: ReactNode
  icon?: boolean
  title?: string
}) {
  return (
    <span className={`ui-badge ui-badge--${tone}`} title={title}>
      {icon ? <Icon name={tone === 'ok' ? 'check' : tone === 'error' ? 'warning' : 'info'} size={12} /> : <StatusDot tone={tone} />}
      <span>{children}</span>
    </span>
  )
}
