import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type Lang = 'en' | 'zh-CN'
type Catalog = Record<string, string>

type CatalogModule = {
  en?: Catalog
  zhCN?: Catalog
}

// Catalogs are split by feature so contributors can add keys without touching a giant file.
// Each file exports `en` (source language) and `zhCN` (translation).
const modules = import.meta.glob<CatalogModule>('./catalogs/*.ts', { eager: true })

const en: Catalog = {}
const zhCN: Catalog = {}
for (const mod of Object.values(modules)) {
  Object.assign(en, mod.en ?? {})
  Object.assign(zhCN, mod.zhCN ?? {})
}

export const LANGUAGES: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'zh-CN', label: '简体中文' },
]

// English is the default; Chinese is available from Settings.
export const DEFAULT_LANG: Lang = 'en'
const STORAGE_KEY = 'yhub.lang'

let activeLang: Lang = DEFAULT_LANG

function isLang(value: unknown): value is Lang {
  return value === 'en' || value === 'zh-CN'
}

export function detectLang(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (isLang(stored)) return stored
  } catch {
    /* localStorage may be unavailable */
  }
  return DEFAULT_LANG
}

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    params[key] === undefined || params[key] === null ? `{${key}}` : String(params[key]),
  )
}

/** Translate a key in the active language. Safe to call outside React (api.ts, helpers). */
export function t(key: string, params?: Record<string, unknown>): string {
  const catalog = activeLang === 'en' ? en : zhCN
  const fallback = en[key] ?? key
  const template = catalog[key] ?? fallback
  return interpolate(template, params)
}

export function getLang(): Lang {
  return activeLang
}

export function setLangGlobal(lang: Lang): void {
  activeLang = lang
  try {
    document.documentElement.lang = lang
    document.documentElement.dataset.lang = lang
    window.localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    /* non-browser/test environments */
  }
}

type I18nValue = {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: string, params?: Record<string, unknown>) => string
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const initial = detectLang()
    activeLang = initial
    return initial
  })

  const setLang = useCallback((next: Lang) => {
    setLangGlobal(next)
    setLangState(next)
  }, [])

  useEffect(() => {
    setLangGlobal(lang)
  }, [lang])

  // `ui_language` in the config is the durable language choice (the backend renders its own strings
  // and the tray with it); localStorage only makes boot fast. Adopt the config value when this
  // webview has no choice yet — otherwise a cleared profile shows an English UI while the backend
  // keeps answering in Chinese, and every server-rendered tool name disagrees with the sidebar.
  useEffect(() => {
    let stored: string | null = null
    try {
      stored = window.localStorage.getItem(STORAGE_KEY)
    } catch {
      /* no storage: fall through to the config */
    }
    if (isLang(stored)) return
    let active = true
    void fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((payload) => {
        const next = payload?.settings?.ui_language ?? payload?.ui_language
        if (active && isLang(next)) {
          setLangGlobal(next)
          setLangState(next)
        }
      })
      .catch(() => {
        /* no backend (static preview / tests): keep the default */
      })
    return () => {
      active = false
    }
  }, [])

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      setLang,
      t: (key, params) => {
        const catalog = lang === 'en' ? en : zhCN
        const template = catalog[key] ?? en[key] ?? key
        return interpolate(template, params)
      },
    }),
    [lang, setLang],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>')
  return ctx
}
