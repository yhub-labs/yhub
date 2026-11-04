// Hotkey section: action list + combo recording + conflict/invalid feedback + clear and restore defaults
//
// Boundaries (same as the settings UI section of docs/gui-development.md):
//   - the action table (id / label / default combo) comes from `schema.hotkey_actions`, never hardcoded here;
//   - there is exactly one write path: `setKey('hotkeys.<action id>', combo)`, empty string = unbind;
//     restore default uses `resetKey('hotkeys.<action id>')`;
//   - the backend registers **before** persisting: on failure it returns `{ok:false, error}` (the message
//     already says "invalid or taken by the system") and the old hotkey stays — so the conflict/invalid
//     hint is simply the error shown in place;
//   - the recording control swallows keys itself (`preventDefault + stopPropagation`, including ESC and
//     ⌘,) — otherwise the settings shell treats them as "go back to the previous screen".
//
// Combo strings use the spelling the backend's parser (global-hotkey) accepts: modifiers first, the key
// last, modifiers ordered Ctrl → Option → Shift → Cmd (the macOS ⌃⌥⇧⌘ habit).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t, useI18n } from '../../i18n'
import { formatHotkey } from '../../tauriBridge'
import { ActionButton, SectionCard, type SettingsSectionProps } from './shared'
import { Icon } from '../icons/Icon'

/** Shell-declared action id → catalog key. The shell only carries a Chinese label (config.rs), so the
 *  page translates by id and falls back to that label for actions it does not know (a future action). */
const ACTION_LABELS: Record<string, string> = {
  toggle_panel: 'settings.hotkeys.action.toggle_panel',
  show_panel: 'settings.hotkeys.action.show_panel',
  hide_panel: 'settings.hotkeys.action.hide_panel',
}
function actionLabel(action: { id: string; name: string }): string {
  const key = ACTION_LABELS[action.id]
  return key ? t(key) : action.name
}

/** `KeyboardEvent.code` → key name the backend parser accepts (unrecognized = cannot be bound) */
const CODE_TO_KEY: Record<string, string> = (() => {
  const map: Record<string, string> = {
    Space: 'Space',
    Enter: 'Enter',
    NumpadEnter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    Insert: 'Insert',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    NumpadAdd: 'NumAdd',
    NumpadSubtract: 'NumSubtract',
    NumpadMultiply: 'NumMultiply',
    NumpadDivide: 'NumDivide',
    NumpadDecimal: 'NumDecimal',
  }
  for (let i = 0; i < 26; i += 1) map[`Key${String.fromCharCode(65 + i)}`] = String.fromCharCode(65 + i)
  for (let i = 0; i <= 9; i += 1) {
    map[`Digit${i}`] = String(i)
    map[`Numpad${i}`] = `Num${i}`
  }
  for (let i = 1; i <= 24; i += 1) map[`F${i}`] = `F${i}`
  return map
})()

const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']

/** Fixed modifier write/compare order: the macOS ⌃⌥⇧⌘ habit (shared by `buildCombo` and `normalizeCombo`) */
const MODIFIER_ORDER = ['Ctrl', 'Option', 'Shift', 'Cmd']

/** Modifier spelling → canonical name (same aliases the backend parser accepts: ctrl/control, alt/option, cmd/command/super) */
const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  option: 'Option',
  alt: 'Option',
  shift: 'Shift',
  cmd: 'Cmd',
  command: 'Cmd',
  super: 'Cmd',
  cmdorctrl: 'Cmd',
  cmdorcontrol: 'Cmd',
  commandorctrl: 'Cmd',
  commandorcontrol: 'Cmd',
}

/**
 * Canonical form of a combo, **for comparison only** (is it the same hotkey): independent of spelling
 * order, aliases and case. Persistence and display keep the original text, so the UI shows exactly what
 * is in the config file. Without this, `Cmd+Shift+K` and `Shift+Cmd+K` are one hotkey to the system but
 * the UI would not detect the conflict.
 */
function normalizeCombo(combo: string): string {
  const mods = new Set<string>()
  const keys: string[] = []
  for (const raw of combo.split('+')) {
    const token = raw.trim()
    if (!token) continue
    const mod = MODIFIER_ALIASES[token.toLowerCase()]
    if (mod) mods.add(mod)
    else keys.push(token)
  }
  // Sort modifiers in the fixed order (same as buildCombo's write order), otherwise "different order" slips through again
  return [...MODIFIER_ORDER.filter((mod) => mods.has(mod)), ...keys].join('+')
}

function modifierPreview(mods: { ctrl: boolean; option: boolean; shift: boolean; cmd: boolean }): string {
  const parts: string[] = []
  if (mods.ctrl) parts.push('⌃')
  if (mods.option) parts.push('⌥')
  if (mods.shift) parts.push('⇧')
  if (mods.cmd) parts.push('⌘')
  return parts.join(' ')
}

/** Build a combo: ordered modifiers first, the key last (strictly the backend's parsing rule) */
function buildCombo(mods: { ctrl: boolean; option: boolean; shift: boolean; cmd: boolean }, key: string): string {
  const parts: string[] = []
  if (mods.ctrl) parts.push('Ctrl')
  if (mods.option) parts.push('Option')
  if (mods.shift) parts.push('Shift')
  if (mods.cmd) parts.push('Cmd')
  parts.push(key)
  return parts.join('+')
}

/** Render a combo as keycap chips split on the symbols (⌃ ⇧ K) */
function ComboChips({ combo }: { combo: string }) {
  if (!combo) return <span className="ui-meta text-[12px]">{t('settings.hotkeys.unbound')}</span>
  return (
    <span className="inline-flex items-center gap-1">
      {combo.split('+').map((part) => (
        <kbd
          key={part}
          className="ui-kbd min-w-[22px]"
        >
          {formatHotkey(part)}
        </kbd>
      ))}
    </span>
  )
}

export default function HotkeySection({
  settings,
  schema,
  desktop,
  setKey,
  resetKey,
  notify,
}: SettingsSectionProps) {
  // `t` from the hook re-renders the panel when the language changes; the module-level `t` above is
  // only for the small `ComboChips` component that sits outside this component's render scope.
  const { t: tr } = useI18n()
  /** Action id being recorded (null = not recording) */
  const [recordingId, setRecordingId] = useState<string | null>(null)
  /** Modifiers held so far while recording (feedback that a normal key is still expected) */
  const [pending, setPending] = useState('')
  /** In-place problem (invalid combo / conflict / backend rejection) */
  const [problem, setProblem] = useState<{ actionId: string; message: string } | null>(null)
  /** Action id currently being written */
  const [busy, setBusy] = useState('')

  const actions = schema?.hotkey_actions ?? []

  const comboOf = useCallback(
    (actionId: string) => (settings?.hotkeys?.[actionId] ?? '').trim(),
    [settings],
  )

  /** Combos bound more than once in the config → the action names involved (only after hand-editing; the UI must say so) */
  const duplicates = useMemo(() => {
    const seen = new Map<string, string[]>()
    for (const action of actions) {
      const combo = comboOf(action.id)
      if (!combo) continue
      // Group by canonical form: different spelling/order but the same hotkey still counts as a duplicate
      const key = normalizeCombo(combo)
      seen.set(key, [...(seen.get(key) ?? []), actionLabel(action)])
    }
    return new Map([...seen].filter(([, names]) => names.length > 1))
  }, [actions, comboOf])

  const stopRecording = useCallback(() => {
    setRecordingId(null)
    setPending('')
  }, [])

  const write = useCallback(
    async (actionId: string, actionName: string, combo: string, verb: 'bind' | 'clear' | 'default') => {
      setBusy(actionId)
      const res = await setKey(`hotkeys.${actionId}`, combo)
      setBusy('')
      if (!res.ok) return res
      setProblem(null)
      if (verb === 'bind')
        notify(tr('settings.hotkeys.notify.bound', { name: actionName, combo: formatHotkey(combo) || combo }))
      else if (verb === 'clear') notify(tr('settings.hotkeys.notify.cleared', { name: actionName }))
      else
        notify(
          combo
            ? tr('settings.hotkeys.notify.restored', { name: actionName, combo: formatHotkey(combo) })
            : tr('settings.hotkeys.notify.restoredUnbound', { name: actionName }),
        )
      return res
    },
    [notify, setKey, tr],
  )

  // Values the recording effect needs live in a ref so the effect depends on recordingId only.
  // Otherwise "hold a modifier → setPending → re-render" tears down and re-adds the keyboard listener,
  // and the very next keypress can land in that gap (dropped key while recording).
  const latest = useRef({ actions, comboOf, notify, stopRecording, write, tr })
  latest.current = { actions, comboOf, notify, stopRecording, write, tr }

  // Recording: swallow every key in the capture phase (including ESC / ⌘,), then parse it into a combo and write
  useEffect(() => {
    if (!recordingId) return

    const handle = async (e: KeyboardEvent) => {
      const { actions: list, comboOf, notify, stopRecording, write, tr } = latest.current
      const action = list.find((a) => a.id === recordingId)
      if (!action) return
      // While recording these keys belong to the recorder and must not leak to the settings shell (otherwise ESC goes back a screen)
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      if (e.repeat) return

      const mods = { ctrl: e.ctrlKey, option: e.altKey, shift: e.shiftKey, cmd: e.metaKey }

      if (e.key === 'Escape') {
        stopRecording()
        setProblem(null)
        notify(tr('settings.hotkeys.notify.cancelled'))
        return
      }
      if (MODIFIER_KEYS.includes(e.key)) {
        setPending(modifierPreview(mods))
        return
      }

      const key = CODE_TO_KEY[e.code]
      if (!key) {
        setProblem({
          actionId: action.id,
          message: tr('settings.hotkeys.problem.unsupported', { code: e.code }),
        })
        return
      }
      if (!mods.ctrl && !mods.option && !mods.cmd) {
        setProblem({
          actionId: action.id,
          message: tr('settings.hotkeys.problem.modifier'),
        })
        return
      }

      const combo = buildCombo(mods, key)
      const holder = list.find(
        (a) =>
          a.id !== action.id &&
          comboOf(a.id) !== '' &&
          normalizeCombo(comboOf(a.id)) === normalizeCombo(combo),
      )
      if (holder) {
        setProblem({
          actionId: action.id,
          message: tr('settings.hotkeys.problem.taken', {
            combo: formatHotkey(combo),
            name: holder.name,
          }),
        })
        return
      }

      const res = await write(action.id, actionLabel(action), combo, 'bind')
      if (res.ok) stopRecording()
      else setProblem({ actionId: action.id, message: res.error })
    }

    const onKeyDown = (e: KeyboardEvent) => void handle(e)
    const onKeyUp = (e: KeyboardEvent) => {
      if (MODIFIER_KEYS.includes(e.key)) {
        setPending(
          modifierPreview({ ctrl: e.ctrlKey, option: e.altKey, shift: e.shiftKey, cmd: e.metaKey }),
        )
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [recordingId])

  const sectionTitle = tr('settings.hotkeys.title')
  const sectionBlurb = tr('settings.hotkeys.description')

  // Browser preview cannot read the action table: say so instead of showing fake data
  if (!schema) {
    return (
      <SectionCard
        title={sectionTitle}
        description={sectionBlurb}
        footer={tr('settings.hotkeys.previewFooter')}
      >
        <div className="px-4 py-4 ui-meta leading-relaxed">
          {tr('settings.hotkeys.previewBody')}
        </div>
      </SectionCard>
    )
  }

  const boundCount = actions.filter((a) => comboOf(a.id) !== '').length
  const writable = desktop && !busy

  return (
    <div className="space-y-5">
      <SectionCard
        title={sectionTitle}
        description={sectionBlurb}
        footer={tr('settings.hotkeys.footer', { bound: boundCount, total: actions.length })}
      >
        {actions.length === 0 && (
          <div className="px-4 py-4 ui-meta">{tr('settings.hotkeys.empty')}</div>
        )}

        {actions.map((action) => {
          const combo = comboOf(action.id)
          const isRecording = recordingId === action.id
          const rowProblem = problem?.actionId === action.id ? problem.message : ''
          const twins = combo ? duplicates.get(normalizeCombo(combo)) : undefined
          const defaultCombo = (action.default_combo ?? '').trim()

          return (
            <div key={action.id} className="px-4 py-3" data-hotkey-row={action.id}>
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-[var(--ink-text)]">{actionLabel(action)}</div>
                  <div className="ui-meta mt-0.5 leading-relaxed">
                    {tr('settings.hotkeys.defaultCombo', {
                      combo: defaultCombo
                        ? formatHotkey(defaultCombo)
                        : tr('settings.hotkeys.noDefault'),
                    })}
                    {twins && (
                      <span className="text-amber-300">
                        {tr('settings.hotkeys.duplicate', {
                          names: twins
                            .filter((n) => n !== actionLabel(action))
                            .join(tr('settings.hotkeys.duplicateSeparator')),
                        })}
                      </span>
                    )}
                  </div>
                </div>

                <div className="shrink-0 flex items-center gap-2">
                  {isRecording ? (
                    <span className="min-w-[150px] text-center px-2 py-1 rounded-[var(--radius)] border border-[var(--ink-accent)] bg-[var(--ink-accent-quiet)] text-[12px] text-[var(--ink-accent-text)]">
                      {pending ? `${pending} …` : tr('settings.hotkeys.recording')}
                    </span>
                  ) : (
                    <span className="min-w-[70px] flex justify-end">
                      <ComboChips combo={combo} />
                    </span>
                  )}

                  <ActionButton
                    onClick={() => {
                      if (isRecording) {
                        stopRecording()
                        return
                      }
                      setProblem(null)
                      setPending('')
                      setRecordingId(action.id)
                    }}
                    disabled={!desktop}
                    title={
                      isRecording
                        ? tr('settings.hotkeys.stop.title')
                        : tr('settings.hotkeys.record.title')
                    }
                  >
                    {isRecording
                      ? tr('settings.hotkeys.stop')
                      : combo
                        ? tr('settings.hotkeys.rerecord')
                        : tr('settings.hotkeys.record')}
                  </ActionButton>

                  <ActionButton
                    onClick={() => void write(action.id, actionLabel(action), '', 'clear')}
                    disabled={!writable || !combo}
                    title={tr('settings.hotkeys.clear.title')}
                  >
                    {tr('settings.hotkeys.clear')}
                  </ActionButton>

                  <ActionButton
                    onClick={() => {
                      // Restore default goes through reset_settings: hand this key back to its default (which may be unbound)
                      setBusy(action.id)
                      void resetKey(`hotkeys.${action.id}`).then((res) => {
                        setBusy('')
                        if (res.ok) {
                          setProblem(null)
                          notify(
                            defaultCombo
                              ? tr('settings.hotkeys.notify.restored', {
                                  name: actionLabel(action),
                                  combo: formatHotkey(defaultCombo),
                                })
                              : tr('settings.hotkeys.notify.restoredUnbound', { name: actionLabel(action) }),
                          )
                        }
                      })
                    }}
                    disabled={!writable || combo === defaultCombo}
                    title={tr('settings.hotkeys.restore.title')}
                  >
                    {tr('settings.hotkeys.restore')}
                  </ActionButton>
                </div>
              </div>

              {isRecording && (
                <div className="mt-2 ui-meta">{tr('settings.hotkeys.recordingHint')}</div>
              )}
              {rowProblem && (
                <div className="mt-2 ui-notice ui-notice--error">
                  <Icon name="warning" className="ui-notice__icon" />
                  <div className="ui-notice__body">{rowProblem}</div>
                </div>
              )}
            </div>
          )
        })}
      </SectionCard>

      <SectionCard
        title={tr('settings.hotkeys.rules.title')}
        description={tr('settings.hotkeys.rules.description')}
      >
        <div className="px-4 py-4 ui-meta leading-relaxed flex flex-col gap-1.5">
          <div>{tr('settings.hotkeys.rules.invalid')}</div>
          <div>{tr('settings.hotkeys.rules.occupied')}</div>
          <div>{tr('settings.hotkeys.rules.clear')}</div>
          <div>{tr('settings.hotkeys.rules.persist')}</div>
        </div>
      </SectionCard>
    </div>
  )
}