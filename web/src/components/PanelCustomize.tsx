import { useEffect, useRef, type CSSProperties } from 'react'
import { useI18n } from '../i18n'
import { Icon } from './icons/Icon'
import type { PackingMode, PanelPrefs, ThemeMode } from '../panelPrefs'

/**
 * Wall-header "Customize" popover: global items only — light/dark, packing mode, reset.
 *
 * Deliberately no per-cell list. Whether a widget is on the desktop and how big a cell is both
 * already have a direct entry point (edit mode), and duplicating them here gave the same state
 * three different controls — users could not tell which one to trust. What to use instead:
 *
 * | Capability | Only entry point | Why not here |
 * | --- | --- | --- |
 * | on/off the desktop | edit mode: × on the wall / click in the component library | that is an action on the visible thing, not a setting |
 * | cell size | edit mode: ⤢ size tile / drag the corner | scale is judged on the wall; picking "md 6×2" from a list is abstract |
 * | light/dark, compact/free | here | affects the whole look, no second entry point |
 *
 * Prefs go to localStorage only (App.tsx applies the theme to html[data-theme]); no backend.
 */

const THEME_OPTIONS: { value: ThemeMode; labelKey: string }[] = [
  { value: 'dark', labelKey: 'dashboard.customize.theme.dark' },
  { value: 'light', labelKey: 'dashboard.customize.theme.light' },
]

const PACKING_OPTIONS: { value: PackingMode; labelKey: string; hintKey: string }[] = [
  {
    value: 'compact',
    labelKey: 'dashboard.customize.packing.compact',
    hintKey: 'dashboard.customize.packing.compactHint',
  },
  {
    value: 'free',
    labelKey: 'dashboard.customize.packing.free',
    hintKey: 'dashboard.customize.packing.freeHint',
  },
]

export interface PanelCustomizeProps {
  prefs: PanelPrefs
  onTheme: (theme: ThemeMode) => void
  /** Packing mode (compact / free) */
  onPacking: (packing: PackingMode) => void
  onReset: () => void
  onClose: () => void
}

export default function PanelCustomize({
  prefs,
  onTheme,
  onPacking,
  onReset,
  onClose,
}: PanelCustomizeProps) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)

  // Close when clicking outside. Allowlist (one missing entry causes "clicking once also exits edit mode", measured):
  //   * [data-pref-trigger]     — the trigger toggles itself; without it mousedown closes and click reopens
  //   * [data-edit-trigger]     — edit-mode toggle
  //   * [data-library-trigger]  — component-library drawer, part of edit mode; must not close it
  //   * [data-remove-handle] / [data-size-menu] — on the wall; pressing them operates the desktop, not an exit
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null
      if (
        ref.current?.contains(el) ||
        el?.closest?.(
          '[data-pref-trigger],[data-edit-trigger],[data-library-trigger],[data-remove-handle],[data-size-menu]',
        )
      ) {
        return
      }
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  // Shared row surface: background/border/text all use bento tokens — light theme overrides the tokens in theme-light.css, so it follows automatically
  const surface: CSSProperties = {
    background: 'var(--ink-2)',
    borderColor: 'var(--ink-line-strong)',
    color: 'var(--ink-text)',
    boxShadow: 'var(--shadow-2)',
  }

  const seg = (active: boolean): CSSProperties => ({
    background: active ? 'var(--ink-accent-quiet)' : 'transparent',
    borderColor: active ? 'var(--ink-accent)' : 'var(--ink-line)',
    color: active ? 'var(--ink-accent-text)' : 'var(--ink-text-2)',
    fontWeight: active ? 600 : 400,
  })

  return (
    <div
      ref={ref}
      data-pref-panel
      role="dialog"
      aria-label={t('dashboard.customize.aria')}
      className="absolute right-0 top-full mt-2 w-[300px] rounded-[var(--radius-lg)] border p-3 z-50"
      style={surface}
    >
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[13px] font-semibold">{t('dashboard.customize.title')}</span>
        <button
          onClick={onClose}
          className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm"
          title={t('dashboard.customize.closeTooltip')}
          aria-label={t('common.close')}
        >
          <Icon name="close" size={13} />
        </button>
      </div>

      {/* Appearance: two steps, dark/light, written immediately */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[11px] text-[var(--ink-text-3)] w-8 shrink-0">
          {t('dashboard.customize.appearance')}
        </span>
        {THEME_OPTIONS.map((opt) => {
          const active = prefs.theme === opt.value
          return (
            <button
              key={opt.value}
              data-pref-theme={opt.value}
              aria-pressed={active}
              onClick={() => onTheme(opt.value)}
              className="px-2.5 py-1 rounded-[var(--radius)] text-xs border transition-colors"
              style={seg(active)}
            >
              {t(opt.labelKey)}
            </button>
          )
        })}
      </div>

      {/* Packing: compact (RGL packs vertically) / free (no packing) */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[11px] text-[var(--ink-text-3)] w-8 shrink-0">
          {t('dashboard.customize.packing')}
        </span>
        {PACKING_OPTIONS.map((opt) => {
          const active = (prefs.packing ?? 'compact') === opt.value
          return (
            <button
              key={opt.value}
              data-pref-packing={opt.value}
              aria-pressed={active}
              title={t(opt.hintKey)}
              onClick={() => onPacking(opt.value)}
              className="px-2.5 py-1 rounded-[var(--radius)] text-xs border transition-colors"
              style={seg(active)}
            >
              {t(opt.labelKey)}
            </button>
          )
        })}
      </div>

      {/* Point the duplicate entries elsewhere, so users stop looking for hide/resize in this layer */}
      <div className="ui-meta leading-relaxed border-t border-[var(--ink-line)] pt-2.5 mb-2.5">
        {t('dashboard.customize.hintPrefix')}
        <b className="font-normal text-[var(--ink-text-2)]">{t('dashboard.customize.hintBold')}</b>
        {t('dashboard.customize.hintSuffix')}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="ui-meta leading-snug">{t('dashboard.customize.localOnly')}</span>
        <button onClick={onReset} className="ui-btn ui-btn--sm">
          <Icon name="refresh" size={12} />
          {t('common.reset')}
        </button>
      </div>
    </div>
  )
}
