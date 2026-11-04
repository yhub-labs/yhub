import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'

/**
 * Generic bento card shell: icon + title + subtitle + status dot + actions + body.
 *
 * Presentation only — any panel component can be dropped in as children unchanged.
 * Styles live in `src/bento.css` (`.bento-card*`, `.bento-state*`); per-card
 * default span/title live in `cardRegistry.ts`.
 */

export type CardSpan = 'sm' | 'md' | 'lg' | 'full'

/** Semantic tones for the header status dot; same set as the panel status text (bento.css `.bento-card__status`) */
export type CardTone = 'ok' | 'warn' | 'error' | 'idle'

/** Unified in-card state kinds, see `CardState` */
export type CardStateKind = 'loading' | 'empty' | 'ok' | 'warn' | 'error'

export interface CardStatus {
  tone?: CardTone
  /** ready/status phrase; on narrow cards only the dot shows, the text moves to title/aria-label */
  label?: string
}

export interface CardProps {
  /** Card anchor: DOM id = `bento-card-<id>` */
  id: string
  title?: string
  /** Clickable title = deep link (wall cells): opens in a new tab, a panel must not navigate the host webview */
  titleHref?: string
  icon?: ReactNode
  subtitle?: string
  /** Grid footprint (12-column base): sm=1×1 (icon), md=6×2, lg=6×4, full=12×2 (full width); narrow screens collapse it via bento.css and wallLayout */
  span?: CardSpan
  /** Extra data-* attributes (wall cells carry data-cell / data-status / data-staleness for tests and styling) */
  dataAttrs?: Record<string, string>
  /** Header action area (buttons etc.), optional per card */
  actions?: ReactNode
  /** Header status dot (ready/error…), fed by the same data as the sidebar dot */
  status?: CardStatus
  /** Loading: render skeleton placeholders in header and body instead of children */
  loading?: boolean
  /** Card matches the selected sidebar item: outline marks the current location */
  active?: boolean
  /**
   * Reports the height this card's content naturally needs (px, header included),
   * which drives content-adaptive height: size follows content, not manual dragging.
   * Measures the content with a Range rather than `scrollHeight`, because the latter
   * is floored by clientHeight and the card could then never shrink back.
   */
  onNatural?: (px: number) => void
  /** Change it to re-measure the natural height (used when auto-height is enabled) */
  measureToken?: number
  children?: ReactNode
}

/** Skeleton bars; staggered widths make it read as loading rather than as content */
export function CardSkeleton({ bars = 3 }: { bars?: number }) {
  const widths = ['84%', '62%', '73%']
  return (
    <div className="bento-skeleton" aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} className="bento-skeleton__bar" style={{ width: widths[i % widths.length] }} />
      ))}
    </div>
  )
}

/**
 * The single way to render in-card states, so panels share radius and colors.
 * Copy stays with each panel: the smoke assertions match on text, not styling.
 */
export function CardState({
  kind,
  hint,
  actions,
  children,
}: {
  kind: CardStateKind
  /** Small supplementary "what to do" line below the body */
  hint?: ReactNode
  /** Buttons inside the state block (retry / dismiss…), after body and hint */
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <div
      className={`bento-state bento-state--${kind}`}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      <div className="bento-state__text">
        {kind === 'loading' && <span className="bento-state__dot" aria-hidden="true" />}
        {children}
      </div>
      {hint != null && <div className="bento-state__hint">{hint}</div>}
      {actions != null && <div className="bento-state__actions">{actions}</div>}
    </div>
  )
}

export default function Card({
  id,
  title,
  titleHref,
  icon,
  subtitle,
  span = 'sm',
  dataAttrs,
  actions,
  status,
  loading = false,
  active = false,
  onNatural,
  measureToken = 0,
  children,
}: CardProps) {
  const { t } = useI18n()
  const tone = status?.tone ?? 'idle'

  // Bottom fade when the body overflows the card: macOS overlay scrollbars are
  // invisible until you scroll, so clipped content would read as broken. Hidden at the end.
  const bodyRef = useRef<HTMLDivElement>(null)
  const [moreBelow, setMoreBelow] = useState(false)
  // Callback in a ref: measure is wired to a ResizeObserver and must not be re-observed on every parent render
  const naturalRef = useRef(onNatural)
  naturalRef.current = onNatural
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = () => {
      const overflow = el.scrollHeight - el.clientHeight > 4
      setMoreBelow(overflow && el.scrollTop + el.clientHeight < el.scrollHeight - 4)
      // Natural height = content height + card chrome (= card height − visible body height; both scale with line height, so the delta is constant)
      const report = naturalRef.current
      if (!report) return
      const card = el.closest('.bento-card') as HTMLElement | null
      const chrome = card ? card.offsetHeight - el.clientHeight : 0
      const cs = getComputedStyle(el)
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      const range = document.createRange()
      range.selectNodeContents(el)
      const content = range.getBoundingClientRect().height
      report(Math.ceil(content + padY + chrome))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    // Growing content resizes the root element (the RO catches that); a new root element needs re-observing
    const mo = new MutationObserver(() => {
      measure()
      if (el.firstElementChild) ro.observe(el.firstElementChild)
    })
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    el.addEventListener('scroll', measure, { passive: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
      el.removeEventListener('scroll', measure)
    }
  }, [measureToken])

  return (
    <article
      id={`bento-card-${id}`}
      data-bento-card={id}
      data-bento-span={span}
      data-bento-status={tone}
      {...dataAttrs}
      className={`bento-card bento-card--${span}${active ? ' is-active' : ''}${moreBelow ? ' has-more' : ''}`}
    >
      <header className="bento-card__head">
        {loading ? (
          <>
            <span className="bento-skeleton__block" aria-hidden="true" />
            <span className="bento-skeleton__bar bento-skeleton__bar--title" aria-hidden="true" />
          </>
        ) : (
          <>
            {icon != null && (
              <span className="bento-card__icon" aria-hidden="true">
                {icon}
              </span>
            )}
            <div className="bento-card__titles">
              {title && (
                <h2 className="bento-card__title">
                  {titleHref ? (
                    <a
                      href={titleHref}
                      target="_blank"
                      rel="noreferrer"
                      title={t('cards.openLink', { href: titleHref })}
                    >
                      {title}
                    </a>
                  ) : (
                    title
                  )}
                </h2>
              )}
              {subtitle && <p className="bento-card__subtitle">{subtitle}</p>}
            </div>
            {status && (
              <span
                className={`bento-card__status is-${tone}`}
                title={status.label}
                aria-label={status.label}
              >
                <span className="bento-card__status-dot" aria-hidden="true" />
                {status.label && <span className="bento-card__status-label">{status.label}</span>}
              </span>
            )}
            {actions && <div className="bento-card__actions">{actions}</div>}
          </>
        )}
      </header>
      <div ref={bodyRef} className="bento-card__body">
        {loading ? <CardSkeleton bars={4} /> : children}
      </div>
    </article>
  )
}
