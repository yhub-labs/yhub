import { useCallback, useEffect, useState } from 'react'
import { api, type JobRun, type JobView, type SchedulerOverview } from '../api'
import { CardState } from './Card'
import { Icon } from './icons/Icon'
import { useI18n } from '../i18n'

/**
 * Scheduler panel: read the job table, read each run's result, trigger a job now.
 *
 * Display + trigger only (`POST /api/scheduler/jobs/<id>/run`); scheduling itself lives in the
 * backend process (`yhub/server/adapters/_scheduler.py`, tick thread + `runs.jsonl`), so jobs keep
 * running with this panel closed, and panel and wall cells read the same state.
 *
 * The three states (ok/warn/alert) and the summary are computed in the backend — thresholds are
 * never recomputed here, same rule as the wall.
 */

/** Button look shared with the other panels (see Rclone.tsx): solid blue for the primary action, outline for the rest */
const BTN = 'ui-btn ui-btn--sm'
const BTN_PRIMARY = 'ui-btn ui-btn--primary ui-btn--sm'

const STATUS_STYLE: Record<
  JobView['status'],
  { dot: string; text: string; badge: string; labelKey: string }
> = {
  ok: {
    dot: 'ui-dot ui-dot--ok',
    text: 'text-[var(--ink-ok-text)]',
    badge: 'ui-badge ui-badge--ok',
    labelKey: 'scheduler.status.ok',
  },
  warn: {
    dot: 'ui-dot ui-dot--warn',
    text: 'text-[var(--ink-warn-text)]',
    badge: 'ui-badge ui-badge--warn',
    labelKey: 'scheduler.status.warn',
  },
  alert: {
    dot: 'ui-dot ui-dot--error',
    text: 'text-[var(--ink-danger-text)]',
    badge: 'ui-badge ui-badge--error',
    labelKey: 'scheduler.status.alert',
  },
}

const STAMP_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** "09-28 08:30"; unparseable input is echoed verbatim rather than inventing a time */
function stamp(iso: string | null): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  return Number.isNaN(t) ? iso : STAMP_FMT.format(t)
}

/** Duration: milliseconds below one second, seconds above */
function spent(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

const TRIGGER_LABEL: Record<string, string> = {
  schedule: 'scheduler.trigger.schedule',
  manual: 'scheduler.trigger.manual',
  cli: 'scheduler.trigger.cli',
}

const RUN_STATUS_LABEL: Record<string, string> = {
  ok: 'scheduler.runStatus.ok',
  fail: 'scheduler.runStatus.fail',
  timeout: 'scheduler.runStatus.timeout',
  error: 'scheduler.runStatus.error',
}

export default function Scheduler() {
  const { t } = useI18n()
  const [overview, setOverview] = useState<SchedulerOverview | null>(null)
  const [runs, setRuns] = useState<JobRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [note, setNote] = useState('')
  const [openReport, setOpenReport] = useState<{ job: string; html: string } | null>(null)
  const [reportErr, setReportErr] = useState('')

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [jobs, history] = await Promise.all([api.schedulerJobs(), api.schedulerRuns(undefined, 8)])
      setOverview(jobs)
      setRuns(history.runs)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Jobs run in the backend and this only observes them: 12s polling is enough, and it stops while the page is hidden
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh(true)
    }, 12_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  async function runNow(job: JobView) {
    setBusyId(job.id)
    setNote('')
    try {
      const res = await api.schedulerRun(job.id)
      const r = res.run
      setNote(
        r.status === 'ok'
          ? t('scheduler.runOk', { title: job.title, duration: spent(r.duration_ms) })
          : t('scheduler.runFailed', {
              title: job.title,
              status: t(RUN_STATUS_LABEL[r.status] ?? r.status),
              detail: r.error || `exit ${r.exit_code}`,
            }),
      )
      await refresh(true)
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId('')
    }
  }

  async function showReport(job: JobView) {
    setReportErr('')
    setOpenReport({ job: job.id, html: '' })
    try {
      setOpenReport({ job: job.id, html: await api.schedulerReport(job.id) })
    } catch (e) {
      setReportErr(e instanceof Error ? e.message : String(e))
      setOpenReport(null)
    }
  }

  if (loading && !overview) return <CardState kind="loading">{t('scheduler.loading')}</CardState>

  if (error && !overview) {
    return (
      <CardState kind="error" actions={<button className={`${BTN_PRIMARY}`} onClick={() => void refresh()}>{t('common.retry')}</button>}>
        {error}
      </CardState>
    )
  }

  if (!overview) return <CardState kind="empty">{t('scheduler.empty')}</CardState>

  const jobs = overview.jobs
  const counts = jobs.reduce(
    (acc, job) => ({ ...acc, [job.status]: (acc[job.status] ?? 0) + 1 }),
    {} as Record<JobView['status'], number>,
  )

  return (
    <div className="space-y-3 text-sm text-[var(--ink-text)]" data-testid="scheduler-panel">
      {/* Scheduler itself: only when enabled do jobs actually run on time */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius)] border border-[var(--ink-line)] bg-[var(--ink-2)] px-3 py-2">
        <span
          className={`ui-badge ${overview.enabled ? 'ui-badge--ok' : 'ui-badge--warn'}`}
        >
          <span
            className={`ui-dot ${overview.enabled ? 'ui-dot--ok' : 'ui-dot--warn'}`}
            aria-hidden="true"
          />
          {overview.enabled ? t('scheduler.enabled') : t('scheduler.disabled')}
        </span>
        <span className="ui-meta">{t('scheduler.tick', { seconds: overview.tick_seconds })}</span>
        <span className="ui-meta">
          {t('scheduler.summary', {
            total: jobs.length,
            ok: counts.ok ?? 0,
            warn: counts.warn ?? 0,
            alert: counts.alert ?? 0,
          })}
        </span>
        <button className={`ml-auto ${BTN}`} onClick={() => void refresh()} disabled={loading}>
          {loading ? t('scheduler.refreshing') : t('scheduler.refresh')}
        </button>
      </div>

      {note && (
        <div className="ui-notice">
          <Icon name="info" className="ui-notice__icon" />
          <div className="ui-notice__body">{note}</div>
        </div>
      )}

      {/* Spell out where the job table lives: editing jobs means editing this file, and not finding it is a common dead end */}
      <div className="ui-meta">
        {t('scheduler.pathsPrefix')}
        <code className="ui-mono">{overview.config_path}</code>
        {t('scheduler.pathsMiddle')}
        <code className="ui-mono">{overview.runs_path}</code>
      </div>

      <div className="space-y-2">
        {jobs.map((job) => {
          const style = STATUS_STYLE[job.status]
          const last = job.last_run
          return (
            <div
              key={job.id}
              data-testid="scheduler-job"
              data-job={job.id}
              className="rounded-[var(--radius)] border border-[var(--ink-line)] bg-[var(--ink-2)] px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={style.dot} aria-hidden="true" />
                <span className="font-medium text-[var(--ink-text)]">{job.title}</span>
                <code className="ui-mono">{job.id}</code>
                <span className={style.badge}>{t(style.labelKey)}</span>
                {!job.enabled && (
                  <span className="ui-badge">
                    {t('scheduler.jobDisabled')}
                  </span>
                )}
                <span className="ui-meta">{job.schedule}</span>
                <div className="ml-auto flex items-center gap-2">
                  {job.report && (
                    <button className={BTN} onClick={() => void showReport(job)}>
                      {t('scheduler.viewReport')}
                    </button>
                  )}
                  <button
                    className={BTN_PRIMARY}
                    onClick={() => void runNow(job)}
                    disabled={busyId === job.id || !job.ready}
                    title={job.ready ? t('scheduler.runTooltip') : job.ready_reason}
                  >
                    {busyId === job.id ? t('scheduler.runningNow') : t('scheduler.runNow')}
                  </button>
                </div>
              </div>

              <div className={`mt-1.5 ${style.text}`}>{job.summary}</div>

              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 ui-meta">
                <span>
                  {t('scheduler.lastRun')}
                  {last
                    ? t('scheduler.lastRunDetail', {
                        when: stamp(last.started_at),
                        status: t(RUN_STATUS_LABEL[last.status] ?? last.status),
                        duration: spent(last.duration_ms),
                      })
                    : t('scheduler.neverRun')}
                </span>
                <span>{t('scheduler.nextRun', { when: stamp(job.next_due) })}</span>
                {job.fail_streak > 1 && (
                  <span className="text-[var(--ink-warn-text)]">
                    {t('scheduler.failStreak', { count: job.fail_streak })}
                  </span>
                )}
              </div>

              {!job.ready && (
                <div className="mt-1 text-xs text-[var(--ink-warn-text)]">{job.ready_reason}</div>
              )}

              {job.detail.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 ui-meta">
                  {job.detail.map((item, i) => (
                    <li key={i} className="truncate" title={item.text}>
                      {item.href ? (
                        <a
                          className="hover:text-[var(--ink-text)] underline decoration-dotted underline-offset-2"
                          href={item.href}
                        >
                          {item.text}
                        </a>
                      ) : (
                        item.text
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {last?.out_tail && last.status !== 'ok' && (
                <details className="mt-1.5">
                  <summary className="cursor-pointer ui-meta">{t('scheduler.showOutput')}</summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded-[var(--radius)] bg-[var(--ink-3)] p-2 text-[11px] leading-relaxed text-[var(--ink-text-2)]">
                    {last.out_tail}
                  </pre>
                </details>
              )}
            </div>
          )
        })}
      </div>

      {/* Recent runs: what ran, and whether it worked */}
      <div>
        <div className="mb-1 ui-meta">{t('scheduler.historyTitle', { count: runs.length })}</div>
        {runs.length === 0 ? (
          <div className="ui-meta">{t('scheduler.historyEmpty')}</div>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {runs.map((run, i) => (
                <tr key={`${run.job}-${run.started_at}-${i}`} className="border-t border-[var(--ink-line)]">
                  <td className="py-1 pr-2 text-[var(--ink-text-3)]">{stamp(run.started_at)}</td>
                  <td className="py-1 pr-2 text-[var(--ink-text-2)]">{run.job}</td>
                  <td className="py-1 pr-2 text-neutral-400">{t(TRIGGER_LABEL[run.trigger] ?? run.trigger)}</td>
                  <td className={`py-1 pr-2 ${run.status === 'ok' ? 'text-[var(--ink-ok-text)]' : 'text-[var(--ink-danger-text)]'}`}>
                    {t(RUN_STATUS_LABEL[run.status] ?? run.status)}
                  </td>
                  <td className="py-1 pr-2 text-neutral-400">{spent(run.duration_ms)}</td>
                  <td className="py-1 text-neutral-400">exit {run.exit_code ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(openReport || reportErr) && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/70 p-4" role="dialog" aria-label={t('scheduler.report')}>
          <div className="mb-2 flex items-center gap-3 text-sm text-neutral-200">
            <span>{t('scheduler.reportHeading', { job: openReport?.job ?? '' })}</span>
            <button
              className={`ml-auto ${BTN}`}
              onClick={() => {
                setOpenReport(null)
                setReportErr('')
              }}
            >
              {t('common.close')}
            </button>
          </div>
          {reportErr ? (
            <CardState kind="error">{reportErr}</CardState>
          ) : (
            <iframe
              title={t('scheduler.report')}
              srcDoc={openReport?.html ?? ''}
              // Reports ship their own styles and scripts and must open offline; the sandbox deliberately omits allow-same-origin so a report gets no backend access
              sandbox="allow-scripts allow-downloads"
              className="min-h-0 flex-1 rounded-[var(--radius)] bg-white"
            />
          )}
        </div>
      )}
    </div>
  )
}