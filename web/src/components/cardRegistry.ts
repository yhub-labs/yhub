import { t } from '../i18n'

/**
 * Panel inventory: title and icon per tool, shared by the page header and the card header.
 *
 * Key order mirrors `/api/tools` and therefore the sidebar: adapters are scanned in
 * directory-entry order, not alphabetically.
 *
 * One tool = one page; tools have no size concept. Bento spans (sm/md/lg/full) belong
 * to wall cells only (see `CELL_SPANS` and `panelPrefs.sizes` in `Dashboard.tsx`).
 *
 * A title hardcoded here wins over the `/api/tools` name.
 *
 * The table stores **i18n keys**, not text: `cardSpec()` translates them at render time, so the
 * page header follows the active language instead of freezing the default one at import.
 */
export interface CardSpec {
  title?: string
  icon?: string
  /** Card subtitle; falls back to the /api/tools description */
  subtitle?: string
}

interface CardSpecKeys {
  titleKey?: string
  icon?: string
  subtitleKey?: string
}

export const CARD_SPECS: Record<string, CardSpecKeys> = {
  rclone: { titleKey: 'cards.rclone.title', icon: 'rclone' },
  dashboard: { titleKey: 'cards.dashboard.title', icon: 'home' },
  scheduler: { titleKey: 'cards.scheduler.title', icon: 'scheduler' },
  rss: { titleKey: 'cards.rss.title', icon: 'rss' },
}
export function cardSpec(id: string): CardSpec {
  const spec = CARD_SPECS[id]
  if (!spec) return {}
  return {
    title: spec.titleKey ? t(spec.titleKey) : undefined,
    icon: spec.icon,
    subtitle: spec.subtitleKey ? t(spec.subtitleKey) : undefined,
  }
}

/**
 * Status dot tone, shared by card header and sidebar so both always agree.
 *
 * `ready` only means the capability is available, not that it is working: for rclone,
 * installed-or-not is ready while "2 mounted / not mounted" is status. Trusting ready
 * alone would paint "not mounted" green, so negative words in the status text win first.
 */
export function statusTone(ready: boolean, status: string): 'ok' | 'warn' {
  if (/停止|异常|失败|不可用|仅 |未配置|过期/.test(status)) return 'warn'
  return ready ? 'ok' : 'warn'
}
