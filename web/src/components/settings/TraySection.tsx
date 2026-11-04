// Tray section: menu-bar icon and window behavior switches (these values are actually read in tray.rs / main.rs)
//
// Contract (see the settings UI section of docs/gui-development.md):
//   - the section never invokes: reads and writes go through props setKey / resetKey (validate → persist → return full settings);
//   - allowed values / defaults always come from schema (tray_fields / close_behaviors / click_behaviors); the frontend
//     defines no allowed values, only the "enum value → label" display mapping (valueLabel / trayFieldLabel in shared.tsx);
//   - changes apply immediately: the Rust side re-reads the config file on every click/window close, no caching
//     (no restart, no change subscription needed).
//
// Runtime mapping:
//   close_behavior     → WindowEvent::CloseRequested in main.rs (hide = only hide, quit = terminate the process)
//   left_click / double_click → handle_left_click in tray.rs (double click is synthesized with a 320ms window)
//   show_on_start      → apply_startup_visibility in tray.rs (the window is visible:false in tauri.conf.json)
//   show_notifications → notify() in tray.rs (system notification when hiding to the menu bar / quitting)

import { useState } from 'react'
import { useI18n } from '../../i18n'
import {
  ActionButton,
  FieldRow,
  SectionCard,
  trayFieldLabel,
  valueLabel,
  type SettingsSectionProps,
} from './shared'

/** Tray section fields (same order as the backend TRAY_FIELDS, used for the "current values" snapshot) */
const FIELD_HINT_KEYS: Record<string, string> = {
  close_behavior: 'settings.tray.hint.close_behavior',
  left_click: 'settings.tray.hint.left_click',
  double_click: 'settings.tray.hint.double_click',
  show_on_start: 'settings.tray.hint.show_on_start',
  show_notifications: 'settings.tray.hint.show_notifications',
}

export default function TraySection({
  settings,
  schema,
  desktop,
  setKey,
  resetKey,
  notify,
}: SettingsSectionProps) {
  const { t } = useI18n()
  /** Field currently being written (drives control disabling and labels) */
  const [busy, setBusy] = useState('')
  /** In-place write failure (the shell already toasted once; this leaves a trace) */
  const [error, setError] = useState('')

  const fields = schema?.tray_fields ?? []
  const closeBehaviors = schema?.close_behaviors ?? []
  const clickBehaviors = schema?.click_behaviors ?? []
  const tray = (settings?.tray ?? undefined) as Record<string, unknown> | undefined
  const locked = !desktop || busy !== ''

  const valueOf = (field: string): unknown => tray?.[field]
  const fieldHint = (field: string): string | undefined =>
    FIELD_HINT_KEYS[field] ? t(FIELD_HINT_KEYS[field]) : undefined

  /** Write one field: clear the error on success, show it in place on failure (the Rust side returns the error, allowed values included) */
  const write = async (field: string, value: unknown) => {
    const key = `tray.${field}`
    setBusy(key)
    const res = await setKey(key, value)
    setBusy('')
    if (res.ok) {
      setError('')
      notify(t('settings.tray.notify.saved', { field: trayFieldLabel(field) }))
    } else {
      setError(t('settings.tray.error.write', { field: trayFieldLabel(field), error: res.error }))
    }
  }

  const restoreTray = async () => {
    setBusy('tray')
    const res = await resetKey('tray')
    setBusy('')
    if (res.ok) {
      setError('')
      notify(t('settings.tray.notify.restored'))
    } else {
      setError(res.error)
    }
  }

  /** Select: allowed values come from the backend schema; a current value missing from the list is still shown as-is (never silently rewritten) */
  const enumRow = (field: string, options: string[]) => {
    const current = String(valueOf(field) ?? '')
    const list = current && !options.includes(current) ? [...options, current] : options
    return (
      <FieldRow key={field} label={trayFieldLabel(field)} hint={fieldHint(field)}>
        <select
          value={current}
          disabled={locked || list.length === 0}
          aria-label={trayFieldLabel(field)}
          onChange={(event) => void write(field, event.target.value)}
          className="ui-input w-auto disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {list.map((option) => (
            <option key={option} value={option}>
              {valueLabel(option)}
            </option>
          ))}
        </select>
      </FieldRow>
    )
  }

  /** Toggle: writes a boolean (the backend accepts only true / false, the UI invents no third state) */
  const boolRow = (field: string) => {
    const on = valueOf(field) === true
    return (
      <FieldRow key={field} label={trayFieldLabel(field)} hint={fieldHint(field)}>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={trayFieldLabel(field)}
          disabled={locked}
          title={on ? t('settings.tray.toggle.off') : t('settings.tray.toggle.on')}
          onClick={() => void write(field, !on)}
          className={`ui-btn ${on ? 'ui-btn--on' : ''}`}
        >
          {busy === `tray.${field}` ? t('settings.tray.saving') : on ? t('settings.on') : t('settings.off')}
        </button>
      </FieldRow>
    )
  }

  return (
    <div className="space-y-5">
      <SectionCard
        title={t('settings.tray.window.title')}
        description={t('settings.tray.window.description')}
        footer={t('settings.tray.window.footer')}
      >
        {fields.includes('close_behavior') && enumRow('close_behavior', closeBehaviors)}
        {fields.includes('show_on_start') && boolRow('show_on_start')}
        {fields.includes('show_notifications') && boolRow('show_notifications')}

        {!desktop && (
          <div className="px-5 py-3.5 text-[11px] text-amber-200/90 bg-amber-500/[0.06] leading-relaxed">
            {t('settings.tray.preview.body')}
            <code className="font-mono"> tauri dev</code>
            {t('settings.tray.preview.tail')}
          </div>
        )}

        {error && (
          <div className="px-5 py-3.5 text-[11px] text-red-200 bg-red-500/[0.06] leading-relaxed">
            {t('settings.tray.error.title', { error })}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title={t('settings.tray.click.title')}
        description={t('settings.tray.click.description')}
        footer={t('settings.tray.click.footer')}
      >
        {fields.includes('left_click') && enumRow('left_click', clickBehaviors)}
        {fields.includes('double_click') && enumRow('double_click', clickBehaviors)}
      </SectionCard>

      <SectionCard
        title={t('settings.tray.menu.title')}
        description={t('settings.tray.menu.description')}
      >
        <FieldRow
          label={t('settings.tray.menu.toggle')}
          hint={t('settings.tray.menu.toggleHint')}
        />
        <FieldRow label={t('settings.tray.menu.web')} hint={t('settings.tray.menu.webHint')} />
        <FieldRow
          label={t('settings.tray.menu.settings')}
          hint={t('settings.tray.menu.settingsHint')}
        />
        <FieldRow label={t('settings.tray.menu.quit')} hint={t('settings.tray.menu.quitHint')} />
      </SectionCard>

      <SectionCard
        title={t('settings.tray.current.title')}
        description={t('settings.tray.current.description')}
        footer={t('settings.tray.current.footer')}
      >
        {fields.map((field) => (
          <FieldRow key={field} label={trayFieldLabel(field)}>
            <span className="font-mono text-[11px] text-neutral-400">
              {typeof valueOf(field) === 'boolean'
                ? valueOf(field)
                  ? 'true'
                  : 'false'
                : String(valueOf(field) ?? '—')}
            </span>
            <span className="text-neutral-300">{valueLabel(valueOf(field))}</span>
          </FieldRow>
        ))}
        {fields.length === 0 && <FieldRow label={t('settings.tray.current.empty')} value={t('settings.loading')} />}

        <FieldRow label={t('settings.tray.restore')} hint={t('settings.tray.restore.hint')}>
          <ActionButton onClick={() => void restoreTray()} disabled={locked}>
            {busy === 'tray' ? t('settings.busy') : t('settings.tray.restore')}
          </ActionButton>
        </FieldRow>
      </SectionCard>
    </div>
  )
}
