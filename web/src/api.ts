// Types and call wrappers for the backend API. Every request goes through /api; the frontend never
// talks to the shell directly.
//
// The transport conventions (timeout / self-heal / retry / error classification) all live in
// `request()` below; each endpoint only declares its path, method and timeout. What reaches the UI
// is always an ApiError carrying a hint.
import { t } from './i18n'
import { isTauri, tauriBridge } from './tauriBridge'

export type Tool = {
  id: string
  name: string
  icon: string
  description: string
  ready: boolean
  status: string
  keywords?: string
}

export type RcloneProbe = {
  ok: boolean
  error?: string
  names?: string[]
  files?: number
  dirs?: number
  total?: number | null
  free?: number | null
  took_ms?: number
  at?: string
}

/** A remote from the config (encrypted or not, whether mounting needs a password typed fresh). */
export type RcloneRemote = {
  name: string
  type: string
  encrypted: boolean
  needs_password: boolean
  target: string
  stored_secret: boolean
  tracked: boolean
  mounted: boolean
  mountpoint: string
  pid: number | null
  pid_alive: boolean
  uptime: string | null
  cache: string | null
  read_only: boolean
}

/** One mount record plus its live state (computed by the backend's watcher thread). */
export type RcloneMount = {
  name: string
  remote: string
  type: string
  encrypted: boolean
  mountpoint: string
  mountpoint_resolved: string
  source?: string | null
  source_now?: string | null
  pid: number | null
  pid_alive: boolean
  mounted: boolean
  dropped: boolean
  stale: boolean
  degraded: boolean
  read_only: boolean
  cache: string
  extra_args?: string[]
  // one-line preflight verdict printed before mounting (e.g. "reads 3 names (2 names in the
  // upstream root were not written through this crypt)")
  preflight?: string
  // probe state: in flight / stuck for N seconds (>30s counts as stuck, i.e. the mountpoint no
  // longer reads)
  probe_running?: boolean
  probe_stuck_seconds?: number | null
  started_at: string
  probed_at: string | null
  probe: RcloneProbe | null
  probe_ok?: boolean | null
  probe_fails?: number
}

export type RcloneStatus = {
  rclone: {
    installed: boolean
    path: string | null
    version: string
    config: string
    config_exists: boolean
  }
  mount_root: string
  state_path: string
  // the VFS cache mode is a fixed value (not user-selectable; change it via "more args")
  vfs_cache_mode: string
  remotes: RcloneRemote[]
  mounts: RcloneMount[]
  untracked: { mountpoint: string; source: string }[]
  watcher: { started: boolean; tick_seconds: number; probe_every: number }
  checked_at: string
}

/** Return of `POST /api/rclone/umount`: an action envelope + the latest state under `status` (**not** the state itself!) */
export type RcloneUmountResult = {
  ok: boolean
  name: string
  mountpoint: string
  steps: string[]
  mounted: boolean
  status: RcloneStatus
}

/* ------------------------------------------------------------------ *
 * Wall (/api/dashboard/*, contract in api-contract.md)
 *
 * The unit of the API is a "cell": all fetching lives in backend adapters, so this layer only
 * receives already-computed cells. The tri-state and staleness judgement (status / staleness) are
 * computed server-side; the frontend only renders them and never recomputes.
 * ------------------------------------------------------------------ */

/* —— RSS feeds (yhub/server/adapters/rss.py) ——
   One feed = one wall cell (`rss.<id>`). `url` comes back verbatim: the panel must be able to
   edit it. */
export type RssFeed = {
  id: string
  title: string
  url: string
  enabled: boolean
  /** max items fetched per feed */
  limit: number
  /** items fetched last time (0 = never fetched) */
  items: number
  /** site home page (only known once a fetch has succeeded) */
  site: string
  /** ISO timestamp; null = never fetched successfully */
  fetched_at: string | null
  /** human-readable failure (null = fine) */
  error: { message: string; hint: string } | null
}

export type RssList = {
  ok: true
  feeds: RssFeed[]
  total: number
  refresh: number
  config_path: string
  live: boolean
}

export type RssItem = {
  title: string
  href: string
  published_at: string | null
  published_text: string
}

export type RssItems = {
  ok: true
  feed: string
  title: string
  site: string
  fetched_at: string | null
  items: RssItem[]
}

export type CellStatus = 'ok' | 'warn' | 'alert'
export type CellZone = 'todo' | 'status'
/** fresh = up to date; stale = past stale_after (dimmed); expired = past 3×stale_after */
export type CellStaleness = 'fresh' | 'stale' | 'expired'

export type CellDetailItem = {
  text: string
  /** optional: without it only the text is shown, never a fake link */
  href?: string
}

export type CellSourceError = {
  message: string
  hint: string
}

/** One cell (contract §3.1: 11 on-screen fields + optional server-computed fields) */
export type Cell = {
  id: string
  title: string
  status: CellStatus
  summary: string
  updated_at: string
  href: string
  zone: CellZone
  order: number
  /** cells with false still appear in the API and are hidden by the frontend (M6 makes visibility configurable) */
  enabled: boolean
  stale_after: number
  source: string
  staleness?: CellStaleness
  age_seconds?: number
  source_error?: CellSourceError | null
  last_attempt_at?: string
  detail?: CellDetailItem[]
}

/** Envelope of GET /api/dashboard/cells */
export type CellListResult = {
  ok: true
  generated_at: string
  /** seconds until the server allows the next refresh; polling aligns its rhythm with it */
  next_refresh_in: number
  total: number
  count: number
  cells: Cell[]
}

export type SnapshotTotals = { ok: number; warn: number; alert: number }

export type SnapshotSummary = {
  id: string
  captured_at: string
  cell_count: number
  totals: SnapshotTotals
  flagged: boolean
}

export type SnapshotListResult = {
  ok: true
  snapshots: SnapshotSummary[]
  has_more: boolean
}

export type SnapshotDetailResult = {
  ok: true
  snapshot: SnapshotSummary & { cells: Cell[] }
}

/* ------------------------------------------------------------------ *
 * Scheduled jobs (/api/scheduler/*)
 *
 * The unit is a "job": scheduling, due checks, subprocess execution and state all live in the
 * backend (yhub/server/adapters/_scheduler.py). The UI only reads the tri-state and one-liner
 * computed by job_view; "run now" triggers a single run (without changing the config).
 * ------------------------------------------------------------------ */

export type JobView = {
  id: string
  title: string
  description: string
  /** human-readable schedule, e.g. "daily 08:30", "every 6 hours", "cron 30 8 * * *" */
  schedule: string
  enabled: boolean
  critical: boolean
  ready: boolean
  ready_reason: string
  status: CellStatus
  summary: string
  detail: CellDetailItem[]
  updated_at: string | null
  next_due: string | null
  last_run: JobRun | null
  fail_streak: number
  href: string
  /** whether the job declares a report_path (then the panel can show its report) */
  report: boolean
  source_error: CellSourceError | null
}

export type JobRun = {
  job: string
  /** schedule = timer; manual = "run now" in the UI; cli = command line */
  trigger: string
  status: 'ok' | 'fail' | 'timeout' | 'error'
  started_at: string
  finished_at: string
  duration_ms: number
  exit_code: number | null
  timed_out: boolean
  error: string
  /** only the last 400 chars, kept for failures (job scripts must not print credentials) */
  out_tail: string
}

export type SchedulerOverview = {
  ok: true
  /** master switch (schedule.json's enabled) */
  enabled: boolean
  tick_seconds: number
  /** whether the tick thread is running (true as soon as the backend is up and read once) */
  started: boolean
  config_path: string
  runs_path: string
  now: string
  jobs: JobView[]
}

export type JobRunListResult = { ok: true; runs: JobRun[] }
export type JobRunResult = { ok: true; run: JobRun; job: JobView }

export type ApiErrorKind =
  /** the backend did not answer within the timeout (the request went out, no response came back) */
  | 'timeout'
  /** cannot reach the backend (nothing listening on the port / refused / connection dropped) */
  | 'network'
  /** the backend answered, but the status code or body says this was a failed call */
  | 'http'
  /** other locally constructed errors (JSON parse failures, …) */
  | 'backend'

export class ApiError extends Error {
  hint: string
  kind: ApiErrorKind
  status?: number
  constructor(message: string, hint = '', kind: ApiErrorKind = 'backend', status?: number) {
    super(message)
    this.hint = hint
    this.kind = kind
    this.status = status
  }
}

const FALLBACK_BASE_URL = 'http://127.0.0.1:8790'
/** default per-request cap. Local loopback normally answers in milliseconds — beyond this the backend is stuck */
const DEFAULT_TIMEOUT_MS = 15_000
/** retry count and backoff for idempotent (GET) requests */
const GET_RETRIES = 2
const RETRY_BACKOFF_MS = [400, 1200]

function getBaseUrl(): string {
  if (typeof window === 'undefined') return FALLBACK_BASE_URL
  const { protocol, port } = window.location
  // Desktop shell / Vite dev: the page is not served by the backend, so point explicitly at the
  // fixed port. Everything else (including `yhub gui --port 9000`) is served by the backend, so use
  // a same-origin relative path; otherwise, after a port change the frontend would connect to 8790
  // — possibly a different backend, or nothing at all.
  if (protocol.startsWith('tauri') || protocol === 'file:' || port === '5173' || port === '1420') {
    return FALLBACK_BASE_URL
  }
  return ''
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export type RequestOptions = {
  /** per-request cap (ms) */
  timeoutMs?: number
  /** retry count (GET only by default; writes are never auto-retried to avoid duplicate side effects) */
  retries?: number
  /** disables "let the desktop shell bring the backend up, then retry once" (on by default in the desktop app) */
  revive?: boolean
}

/**
 * The single backend entry point: **timeout → failure classification → self-heal → retry →
 * human-readable error**.
 *
 * Three layers, and the order must not be reversed:
 *   1. Timeout / cannot connect = a self-healable transport failure: on desktop, call
 *      `backend_ensure` first so the shell brings the backend up on demand, then try once more
 *      (a crashed backend needs no app restart — the next request revives it);
 *   2. only if that still fails, retry with backoff (GET only: retrying a write could duplicate
 *      it);
 *   3. if everything fails, throw ApiError: `message` is what happened, `hint` is what to do, and
 *      `kind` lets the caller branch on the failure type.
 * Errors the backend itself returns (`{ok:false,error,hint}`) are passed through as-is and never
 * retried — that is a business error, not a transport problem.
 */
async function request<T>(
  path: string,
  init: RequestInit = {},
  options: RequestOptions = {},
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const retries = options.retries ?? (method === 'GET' ? GET_RETRIES : 0)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let attempt = 0
  let revived = false

  for (;;) {
    try {
      return await once<T>(path, init, timeoutMs)
    } catch (raw) {
      const err = raw instanceof ApiError ? raw : new ApiError(String(raw))
      const transient = err.kind === 'network' || err.kind === 'timeout'
      if (transient && !revived && options.revive !== false && isTauri()) {
        revived = true
        console.warn('backend request failed; asking the desktop shell to restart it:', err.message)
        await tauriBridge.backendEnsure().catch(() => null)
        continue
      }
      if (transient && attempt < retries) {
        await sleep(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)])
        attempt += 1
        continue
      }
      throw err
    }
  }
}

async function once<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const fullPath = `${getBaseUrl()}${path.startsWith('/') ? path : '/' + path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(fullPath, {
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      ...init,
      signal: controller.signal,
    })
  } catch (e) {
    if (controller.signal.aborted) {
      throw new ApiError(
        t('api.timeout.title', { seconds: Math.round(timeoutMs / 1000), path: fullPath }),
        t('api.timeout.hint'),
        'timeout',
      )
    }
    throw new ApiError(
      t('api.network.title', { path: fullPath }),
      isTauri() ? t('api.network.hint.desktop') : t('api.network.hint.browser'),
      'network',
    )
  } finally {
    clearTimeout(timer)
  }

  let body: any = null
  try {
    body = await res.json()
  } catch {
    throw new ApiError(
      t('api.badResponse.title', { status: res.status }),
      t('api.badResponse.hint'),
      'http',
      res.status,
    )
  }
  if (!res.ok || body?.ok === false) {
    throw new ApiError(
      body?.error ?? t('api.requestFailed', { status: res.status }),
      body?.hint ?? '',
      'http',
      res.status,
    )
  }
  return body as T
}

export const api = {
  tools: () => request<{ tools: Tool[] }>('/api/tools'),
  health: () => request<{ version: string }>('/api/health', {}, { timeoutMs: 5_000 }),

  rclone: () => request<{ ok: boolean } & RcloneStatus>('/api/rclone'),
  // mounting spawns an rclone process and waits for the mountpoint to appear; writes are never
  // auto-retried (a duplicate mount means two processes)
  rcloneMount: (payload: {
    name: string
    mountpoint?: string
    password?: string
    read_only?: boolean
    allow_non_empty?: boolean
    // "more args": rclone flags that the backend splits and passes to the command line (never put a
    // plaintext password here)
    extra?: string
  }) =>
    request<{ ok: boolean; mounted: RcloneMount; status: RcloneStatus }>(
      '/api/rclone/mount',
      { method: 'POST', body: JSON.stringify(payload) },
      { timeoutMs: 120_000 },
    ),
  // The umount response is **not** RcloneStatus itself but "action envelope + the state in its
  // `status` field" — typing it as `{ ok: boolean } & RcloneStatus` would let `setSt(out)` compile
  // while the runtime treats the whole envelope as the state (`st.mounts` is undefined → render
  // throws → blank panel; a real outage on 2026-09-29). It is pinned to the backend's actual shape.
  rcloneUmount: (name: string) =>
    request<RcloneUmountResult>(
      '/api/rclone/umount',
      { method: 'POST', body: JSON.stringify({ name }) },
      { timeoutMs: 60_000 },
    ),
  rcloneProbe: (name: string) =>
    request<{ ok: boolean; probe: RcloneProbe; status: RcloneStatus }>(
      '/api/rclone/probe',
      { method: 'POST', body: JSON.stringify({ name }) },
      { timeoutMs: 30_000 },
    ),

  /* Wall (4 read-only GET endpoints, see api-contract.md §4; no write calls) */
  // the first load also triggers server-side TTL fetches (concurrent probes + file scans), so the
  // timeout is relaxed to 30s
  dashboardCells: () => request<CellListResult>('/api/dashboard/cells', {}, { timeoutMs: 30_000 }),
  dashboardCell: (cellId: string) =>
    request<{ ok: true; generated_at: string; cell: Cell }>(
      `/api/dashboard/cells/${encodeURIComponent(cellId)}`,
      {},
      { timeoutMs: 30_000 },
    ),
  dashboardSnapshots: (opts: { limit?: number; before?: string; flagged?: boolean } = {}) => {
    const q = new URLSearchParams()
    if (opts.limit) q.set('limit', String(opts.limit))
    if (opts.before) q.set('before', opts.before)
    if (opts.flagged) q.set('flagged', 'true')
    const qs = q.toString()
    return request<SnapshotListResult>(`/api/dashboard/snapshots${qs ? `?${qs}` : ''}`)
  },
  dashboardSnapshot: (snapshotId: string) =>
    request<SnapshotDetailResult>(`/api/dashboard/snapshots/${encodeURIComponent(snapshotId)}`),

  /* Scheduled jobs (the only write endpoint is "run now", and it does not change the config) */
  schedulerJobs: () => request<SchedulerOverview>('/api/scheduler/jobs', {}, { timeoutMs: 20_000 }),
  schedulerRuns: (job?: string, limit = 20) => {
    const q = new URLSearchParams()
    if (job) q.set('job', job)
    q.set('limit', String(limit))
    return request<JobRunListResult>(`/api/scheduler/runs?${q.toString()}`, {}, { timeoutMs: 20_000 })
  },
  // run now: wait synchronously for it to finish (a job's own timeout caps at 1 hour), so allow
  // plenty of time here
  schedulerRun: (jobId: string) =>
    request<JobRunResult>(
      `/api/scheduler/jobs/${encodeURIComponent(jobId)}/run`,
      { method: 'POST' },
      { timeoutMs: 3_600_000 },
    ),
  /* RSS feeds: one feed per wall cell (add/edit/delete all write ~/.config/yhub/rss.json) */
  rssList: (live = true) =>
    request<RssList>(`/api/rss?live=${live ? 'true' : 'false'}`, {}, { timeoutMs: 30_000 }),
  // fetching waits on the origin, so allow time (the backend caps each feed at 6s, sources run in
  // parallel)
  rssAdd: (payload: {
    url: string
    /** passing an existing id = edit that entry (the cell position is unchanged); otherwise one is derived from the hostname */
    id?: string
    title?: string
    limit?: number
    enabled?: boolean
  }) =>
    request<{ ok: true; saved: true; feed: RssFeed }>(
      '/api/rss/feeds',
      { method: 'POST', body: JSON.stringify(payload) },
      { timeoutMs: 30_000 },
    ),
  rssRemove: (feedId: string) =>
    request<{ ok: true; removed: boolean; total: number }>(
      `/api/rss/feeds/${encodeURIComponent(feedId)}`,
      { method: 'DELETE' },
    ),
  rssRefresh: (feedId: string) =>
    request<{ ok: true; feed: RssFeed }>(
      `/api/rss/feeds/${encodeURIComponent(feedId)}/refresh`,
      { method: 'POST' },
      { timeoutMs: 30_000 },
    ),
  rssItems: (feedId: string, limit = 5) =>
    request<RssItems>(
      `/api/rss/items?feed_id=${encodeURIComponent(feedId)}&limit=${limit}`,
      {},
      { timeoutMs: 30_000 },
    ),

  /** self-contained HTML report produced by a job (raw body, not an {ok,...} envelope) */
  schedulerReport: async (jobId: string): Promise<string> => {
    const res = await fetch(
      `${getBaseUrl()}/api/scheduler/jobs/${encodeURIComponent(jobId)}/report`,
      { cache: 'no-store' },
    )
    const text = await res.text()
    if (!res.ok) {
      let message = t('api.report.readFailed', { status: res.status })
      let hint = ''
      try {
        const body = JSON.parse(text)
        if (body?.error) message = body.error
        if (body?.hint) hint = body.hint
      } catch {
        /* not JSON: use the status-code message */
      }
      throw new ApiError(message, hint, 'http', res.status)
    }
    return text
  },
}

/**
 * "Capsules in your library": every .html / .htm in one library directory (`capsules_dir`) is a
 * capsule — put the file in and it appears, delete it and it disappears; there is no import
 * manifest (contract in docs/config.md).
 *
 * Addresses come from the backend (the frontend never builds port or route shapes itself): `url`
 * is the shortest readable form, e.g. `http://127.0.0.1:8790/capsules/pinyin` — suffix completion
 * and directory-index detection both happen in the backend.
 */
export type VaultCapsule = {
  /** capsule identity (directory-relative path or single file name): referenced by per-capsule settings */
  scope?: string
  /** whether this capsule currently uses an isolated origin */
  subdomains?: boolean
  /** path relative to capsules_dir: its identity in the URL (rename the file and the URL changes) */
  relpath: string
  /** file name */
  name: string
  /** absolute path (for humans only; never use it as a request address) */
  path: string
  /** path part of the shortest readable address; on name clashes it is an explicit path (the backend round-trips it before sending to confirm it resolves) */
  url_path: string
  /** absolute address that can be opened directly */
  url: string
  bytes: number
  mtime: number
  /**
   * Bookmark-style trio (like a browser bookmark; the backend extracts it from the file's <head>,
   * empty string when absent):
   * `title` display name (<title> → og:title → application-name; when empty the display layer
   * falls back to the file name);
   * `icon` (data: / https: verbatim, relative paths are already inlined as data:, so it can go
   * straight into <img src>);
   * `description` only feeds search keywords and does not change the subtitle (the subtitle stays
   * the in-library path — existing contract).
   */
  title?: string
  icon?: string
  description?: string
  /** which layer: user (your own library) | system (built-in examples shipped with the package) */
  source?: 'user' | 'system'
  /** whether that layer is writable (always false for the built-in layer: its first save is copied
   * into the user library, so the shipped file stays untouched) */
  writable?: boolean
  /** unique id, e.g. "system:hello/index.html" or "user:demo.html" */
  id?: string
  /** enabled/disabled state (default true) */
  enabled?: boolean
}

export type VaultCapsules = {
  capsules: VaultCapsule[]
  /** the capsule directory the backend actually uses (set only when the config is valid and the directory really exists) */
  capsules_dir: string
  /** three-state user-layer directory (drives UI guidance): unset / ok / configured but broken */
  configured: boolean
  problem: 'unset' | 'missing' | 'not_dir' | 'unwritable' | null
  problem_detail: string
  /** path as written in the config (shown even when the directory is missing, to aid diagnosis) */
  configured_path: string
  /** recommended location (the default for "create it for me"; never created automatically) */
  recommended_dir: string
  max_capsules: number
  max_bytes: number
  /** whether per-capsule isolated origins are enabled (the global default) */
  capsules_subdomains?: boolean
  /** per-capsule overrides */
  capsules_subdomains_overrides?: Record<string, boolean>
}

/** Result of `POST /api/capsules/ensure`: create the directory + write the config (done host-side; the UI never touches the fs) */
export type EnsureCapsulesResult = {
  ok: boolean
  capsules_dir: string
  stored: string
  created: boolean
  recommended: boolean
}

export const capsules = {
  /** scan the capsule directory; throws ApiError when the backend is down or capsules_dir is unset (the caller handles it) */
  list: async (): Promise<VaultCapsules> => {
    const res = await fetch(`${getBaseUrl()}/api/capsules`, { cache: 'no-store' })
    if (!res.ok) throw new ApiError(t('api.capsules.listFailed', { status: res.status }))
    const data = (await res.json()) as Partial<VaultCapsules>
    return {
      capsules: data.capsules ?? [],
      capsules_dir: data.capsules_dir ?? '',
      configured: data.configured ?? false,
      problem: data.problem ?? null,
      problem_detail: data.problem_detail ?? '',
      configured_path: data.configured_path ?? '',
      recommended_dir: data.recommended_dir ?? '~/Y-Hub/capsules',
      max_capsules: data.max_capsules ?? 0,
      max_bytes: data.max_bytes ?? 0,
    }
  },

  /** one-click setup of a writable capsule library: create the directory (with parents) + write capsules_dir. No path = use the recommended location. */
  ensure: (path?: string): Promise<EnsureCapsulesResult> =>
    request<EnsureCapsulesResult>('/api/capsules/ensure', {
      method: 'POST',
      body: JSON.stringify(path ? { path } : {}),
    }),

  /** toggle a capsule's enabled state */
  toggle: (payload: { id?: string; relpath?: string; source?: string; enabled: boolean }) =>
    request<{ ok: boolean; id: string; enabled: boolean }>('/api/capsules/toggle', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
}

/**
 * Settings (`settings.json`) — **editable from the web build too**.
 *
 * Why this exists: the only write path used to be the desktop shell (Tauri's `get_settings` /
 * `set_settings`); the browser build was read-only and the CLI had nothing at all — so the
 * capability switches (library path, app directory, PDF service address) could only be changed
 * inside the shell, which is just one of several frontends. The backend's `/api/settings` is a
 * third entry point with the same semantics (same validation implementation, see
 * `yhub/server/adapters/settings.py`), which is why this panel works in a plain browser too.
 *
 * Keys are **dotted paths**, identical to the shell's (`hotkeys.toggle_panel` /
 * `tray.close_behavior` / `capsules_dir` …). Available paths and enums come from the backend
 * schema; the frontend never hardcodes a list.
 * Passing `null` resets that key to its default; the backend validates everything before writing,
 * so a rejected write leaves the last valid content on disk.
 */
export type SettingsData = {
  version: number
  hotkeys: Record<string, string>
  tray: Record<string, string | boolean>
  capsules_dir: string
  /** per-capsule isolated origin (<slug>.localhost) */
  capsules_subdomains?: boolean
  /** per-capsule overrides: {scope: bool} (scope = directory-relative path / single file name) */
  capsules_subdomains_overrides?: Record<string, boolean>
  /** plugin marketplace registry URL */
  plugins_registry_url?: string
  /**
   * Plugin config section (the open namespace from phase E): key = plugin id, value = that plugin's
   * own config object.
   * The host enforces the shape but does not validate key by key; field declarations and type
   * checks live in the manifest (`plugin.json`'s config section). The panel joins the inventory
   * from `GET /api/plugins` (declarations) with the values here.
   */
  plugins: Record<string, Record<string, unknown>>
}

export type SettingsSchema = {
  version: number
  keys: string[]
  hotkey_actions: { id: string; name: string; default_combo: string }[]
  tray_fields: string[]
  close_behaviors: string[]
  click_behaviors: string[]
  defaults: SettingsData
}

export type SettingsResult = {
  ok: true
  /** absolute path of the config file (shown in the UI so users know which file they are editing) */
  path: string
  settings: SettingsData
  schema: SettingsSchema
  /** human-readable explanation of "which keys are broken and used defaults this time" */
  warnings: string[]
}

export const settings = {
  read: () => request<SettingsResult>('/api/settings'),
  update: (key: string, value: unknown) =>
    request<{ ok: true; path: string; settings: SettingsData; changed: string[] }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ key, value }),
    }),
  /** no key = reset everything */
  reset: (key?: string) =>
    request<{ ok: true; path: string; settings: SettingsData; reset: string }>(
      '/api/settings/reset',
      { method: 'POST', body: JSON.stringify(key ? { key } : {}) },
    ),
}

/**
 * **Declarations** for plugin config sections (`GET /api/plugins`): each tool manifest's `config`
 * section (key / type / default / help).
 *
 * Why the declarations do not come from `/api/settings`: that response body must match
 * the `GET /api/settings` body (the verify-cli reconciliation assertion), while the
 * declarations live in plugin.json and are not data from the config file — hence this
 * non-reconciled endpoint. **Values** are still read only from `settings.plugins.<id>` and written
 * only through `PUT /api/settings`.
 */
export type PluginConfigField = {
  key: string
  /** declared type: str (default) / bool / int — the panel picks a control from it, the backend validates with it */
  type?: string
  default?: unknown
  help?: string
}

export type PluginConfigTool = {
  id: string
  name: string
  icon: string
  config: PluginConfigField[]
  /** the cell ids this plugin produces on the wall (used for per-plugin reconciliation) */
  tiles?: string[]
}

export const pluginConfigs = {
  list: () => request<{ ok: true; plugins: PluginConfigTool[] }>('/api/plugins'),
}

/**
 * Plugin inventory (`GET /api/plugin-inventory`): core + installed external.
 *
 * Split from `pluginConfigs.list`: that one serves the **config panel** (what is installed, which
 * config keys each has); this one serves the **plugin manager UI** (it must show what is not
 * installed, which are core/third-party, and whether they can be removed).
 * The enable toggle writes `plugins.<id>._enabled`, the same semantics as the shell's settings page
 * and `yhub plugin enable/disable`.
 */
export type PluginEntry = {
  id: string
  name: string
  icon: string
  description: string
  /** core = shipped with the software (can be disabled, never uninstalled); third-party = installable and removable */
  kind: 'core' | 'third-party'
  installed: boolean
  enabled: boolean
  /** always false for core plugins (`yhub plugin remove` refuses) */
  uninstallable: boolean
  source: 'builtin' | 'config' | 'registry' | 'github' | 'local'
  version?: string
  repo?: string
  ref?: string
  pinned?: boolean
  installed_version?: string
  latest_version?: string
  update_available?: boolean
  /** a `disabled` escape-hatch marker exists in the directory (it outranks the config switch) */
  disabled_file?: boolean
  /** raw manifest text when it is broken (this entry cannot be loaded) */
  broken?: string
}

export type PluginCatalogEntry = {
  id: string
  name: string
  description: string
  author?: string
  version?: string
  repo?: string
  archive?: string
  pypi?: string
  subdir?: string
  ref?: string
  min_yhub?: string
  installed: boolean
  installed_version?: string
  update_available?: boolean
  source?: string
}

export type PluginUpdate = {
  id: string
  source: string
  installed_version: string
  latest_version: string
  update_available: boolean
}

export const pluginInventory = {
  list: () =>
    request<{
      ok: true
      plugins: PluginEntry[]
      config_dir: string
      registry_url: string
    }>('/api/plugin-inventory'),
}

export const pluginCatalog = {
  list: (q = '', refresh = false) =>
    request<{ ok: true; plugins: PluginCatalogEntry[]; registry_url: string }>(
      `/api/plugin-catalog?q=${encodeURIComponent(q)}&refresh=${refresh ? 'true' : 'false'}`,
    ),
  updates: () => request<{ ok: true; updates: PluginUpdate[] }>('/api/plugin-updates'),
  install: (spec: string, opts: { force?: boolean; ref?: string } = {}) =>
    request<{ ok: true; id: string; version?: string; source?: string; restart_required?: boolean }>(
      '/api/plugin-install',
      { method: 'POST', body: JSON.stringify({ spec, ...opts }) },
    ),
  update: (id: string) =>
    request<{
      ok: true
      updated: { id: string; version?: string; restart_required?: boolean }[]
      skipped: { id: string; reason: string }[]
    }>('/api/plugin-update', { method: 'POST', body: JSON.stringify({ id }) }),
  updateAll: () =>
    request<{
      ok: true
      updated: { id: string; version?: string; restart_required?: boolean }[]
      skipped: { id: string; reason: string }[]
    }>('/api/plugin-update', { method: 'POST', body: JSON.stringify({ all: true }) }),
}
