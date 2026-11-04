import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '../i18n'
import { Icon } from './icons/Icon'

/**
 * UI error boundary: a render crash must be visible inside the panel, never a blank screen.
 *
 * A real outage drove this: the Rclone panel treated an action envelope as state
 * (`st.mounts` undefined) and threw while rendering. React unmounted the whole tree, the
 * panel went fully blank, and the polling useEffect was torn down too — so it could never
 * recover. Users saw "click uninstall, UI dies instantly" with no clue. With this boundary
 * the crash shows readable copy + the raw error + a reload button the user can send along.
 */
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The shell started from Dock/hotkey has no visible console; still log it for headless/dev debugging
    console.error(t('errors.renderLog'), error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    const e = this.state.error
    return (
      <div className="ui-shell" data-error-boundary>
        <div className="ui-main" style={{ padding: 24, gap: 12 }}>
          <div className="ui-notice ui-notice--error">
            <Icon name="warning" className="ui-notice__icon" />
            <div className="ui-notice__body">
              <div className="ui-notice__title">{t('errors.title')}</div>
              <div>{t('errors.body')}</div>
            </div>
          </div>
          <pre className="ui-mono max-h-64 overflow-auto rounded-[var(--radius)] border border-[var(--ink-line)] bg-[var(--ink-3)] p-3 whitespace-pre-wrap text-[var(--ink-danger-text)]">
            {String(e?.stack || e?.message || e)}
          </pre>
          <div className="flex gap-2">
            <button className="ui-btn" onClick={() => this.setState({ error: null })}>
              {t('errors.retry')}
            </button>
            <button className="ui-btn ui-btn--primary" onClick={() => location.reload()}>
              {t('errors.reload')}
            </button>
          </div>
        </div>
      </div>
    )
  }
}
