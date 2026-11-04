// Shared contract and UI primitives for settings sections
//
// Layout convention: **one section = one `settings/<Xxx>Section.tsx` file + one line in `registry.tsx`**.
// A section depends only on `SettingsSectionProps` and never invokes Tauri itself — reads and writes
// go through setKey / resetKey, so "validate → persist → return the full updated settings → refresh UI
// → notify" is implemented exactly once.
//
// Two hard rules (same as the settings UI section of docs/gui-development.md):
//   1. Allowed values / hotkey action table / defaults always come from `schema` (backend
//      `get_settings_schema`), never hardcoded here; the LABELS below only translate backend values
//      into display copy, they do not define what is allowed.
//   2. Failures never throw: setKey / resetKey return `{ok:false,error}` (a toast has already fired),
//      so callers can render the error in place.

import type { ReactNode } from 'react'
import type { BackendStatus, BridgeHealth, Settings, SettingsSchema } from '../../tauriBridge'
import { t } from '../../i18n'

/** Uniform write result: a failure has already toasted, so the human-readable error is returned for in-place display */
export type WriteResult = { ok: true; settings: Settings } | { ok: false; error: string }

/**
 * The backend bridge (Python backend) capabilities handed to sections.
 *
 * Sections never invoke Tauri themselves (hard rule above); the settings shell reads the state and
 * passes it down. "Re-check" calls `refresh()` (= `backend_health`: make sure it runs, then really hit
 * /api/health and /api/tools); on failure `error` / `health.error` + `hint` are what to show the user.
 */
export type BackendBridge = {
  /** Current status (probed once when settings opens; does not spawn a process) */
  status: BackendStatus | null
  /** Latest connectivity check result (only present after clicking "re-check") */
  health: BridgeHealth | null
  /** Checking (spawning can take up to 20s; the UI says so honestly) */
  busy: boolean
  /** Why the check itself failed (e.g. IPC error) */
  error: string
  refresh: () => Promise<void>
  /** Read the log tail: kind = 'backend' (Python stack traces live here) | 'desktop' */
  tail: (kind: 'backend' | 'desktop', lines?: number) => Promise<string>
}

/** Everything a settings section gets (sections depend only on this) */
export type SettingsSectionProps = {
  /** Current settings (real values on desktop; null in browser preview) */
  settings: Settings | null
  /** Backend catalog: allowed values / hotkey action table / defaults (used to render the form) */
  schema: SettingsSchema | null
  /** Config file path (`get_settings_path`; empty string in browser mode) */
  settingsPath: string
  /** Running inside the desktop shell (false = browser preview: read-only, cannot save) */
  desktop: boolean
  /** Write one key: validate → persist → return full updated settings (hotkeys are re-registered too) */
  setKey: (key: string, value: unknown) => Promise<WriteResult>
  /** Restore defaults: no key = everything, with key = just that one (`tray` / `hotkeys.toggle_panel` paths both work) */
  resetKey: (key?: string) => Promise<WriteResult>
  /** Re-read all settings (after the config was changed outside the UI) */
  reload: () => Promise<void>
  /** Bottom-right toast: used for both success and failure */
  notify: (message: string, kind?: 'info' | 'error') => void
  /** Backend bridge (Python backend) runtime state and actions (see BackendBridge) */
  backend: BackendBridge
}

/** One settings section (left nav entry + one content container) */
export type SettingsSection = {
  id: string
  name: string
  icon: string
  group?: 'core' | 'extension' | 'apps'
  /** One-line description: used by the nav hover and the section header */
  blurb: string
  render: (props: SettingsSectionProps) => ReactNode
}

// ---------------------------------------------------------------- display copy (does not define allowed values)

/** Translate backend enum values for display; unknown values pass through so new backend items are visible */
const VALUE_LABEL_KEYS: Record<string, string> = {
  hide: 'settings.value.hide',
  quit: 'settings.value.quit',
  toggle_panel: 'settings.value.toggle_panel',
  show_menu: 'settings.value.show_menu',
  none: 'settings.value.none',
}

export function valueLabel(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  const raw = String(value)
  const key = VALUE_LABEL_KEYS[raw]
  return key ? t(key) : raw
}

/** Tray field → label (the field names themselves come from schema.tray_fields) */
const TRAY_FIELD_LABEL_KEYS: Record<string, string> = {
  close_behavior: 'settings.field.close_behavior',
  left_click: 'settings.field.left_click',
  double_click: 'settings.field.double_click',
  show_on_start: 'settings.field.show_on_start',
  show_notifications: 'settings.field.show_notifications',
}

export function trayFieldLabel(field: string): string {
  return TRAY_FIELD_LABEL_KEYS[field] ? t(TRAY_FIELD_LABEL_KEYS[field]) : field
}

// ---------------------------------------------------------------- UI primitives

/** One card inside a section: title + description + a few rows of settings */
export function SectionCard({
  title,
  description,
  footer,
  children,
}: {
  title: string
  description?: string
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-[var(--radius)] border border-[var(--ink-line)] bg-[var(--ink-2)] overflow-hidden">
      <header className="px-4 py-3 border-b border-[var(--ink-line)]">
        <h2 className="text-[13px] font-semibold text-[var(--ink-text)]">{title}</h2>
        {description && (
          <p className="ui-meta mt-1 leading-relaxed">{description}</p>
        )}
      </header>
      <div className="divide-y divide-[var(--ink-line)]">{children}</div>
      {footer && (
        <div className="px-4 py-3 border-t border-[var(--ink-line)] ui-meta leading-relaxed">
          {footer}
        </div>
      )}
    </section>
  )
}

/** One settings row: label + hint on the left, control on the right (read-only value when no children) */
export function FieldRow({
  label,
  hint,
  extra,
  value,
  children,
}: {
  label: string
  hint?: string
  /** An extra block below the hint (e.g. a tool's hosted address); same width as hint, the right column stays for buttons */
  extra?: ReactNode
  value?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="px-4 py-3 flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-[var(--ink-text)]">{label}</div>
        {hint && <div className="ui-meta mt-0.5 leading-relaxed">{hint}</div>}
        {extra}
      </div>
      <div className="shrink-0 flex items-center gap-2 text-[12px] text-[var(--ink-text-2)]">
        {children ?? <span className="ui-mono">{value ?? '—'}</span>}
      </div>
    </div>
  )
}

/** Small button (one style across all sections, never re-styled per section) */
export function ActionButton({
  children,
  onClick,
  disabled,
  danger,
  title,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`ui-btn ${danger ? 'ui-btn--danger' : ''}`}
    >
      {children}
    </button>
  )
}

/**
 * Placeholder section: container, routing and read/write channel are ready, only the content is missing.
 * Kept so a not-yet-built section is honestly visible in the UI instead of pretending to work.
 */
export function ReservedSection({
  pending,
  owns,
  status,
}: {
  /** One line saying what this section has not done yet */
  pending: string
  /** Settings planned for this section (a list for humans) */
  owns: string[]
  /** Read-only supplement such as current values */
  status?: ReactNode
}) {
  return (
    <SectionCard
      title={t('settings.reserved.title')}
      description={pending}
      footer={t('settings.reserved.footer')}
    >
      <div className="px-4 py-4">
        <div className="ui-meta mb-2">{t('settings.reserved.owns')}</div>
        <ul className="space-y-1.5 text-[12px] text-[var(--ink-text-2)]">
          {owns.map((item) => (
            <li key={item} className="flex gap-2">
              <span className="text-[var(--ink-text-3)]">·</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
        {status && <div className="mt-3 ui-meta">{status}</div>}
      </div>
    </SectionCard>
  )
}
