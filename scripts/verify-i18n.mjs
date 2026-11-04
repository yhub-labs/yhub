// i18n parity, per layer. Three catalogs feed the product and each one had its own blind spot:
//
//   1. web/src/i18n/catalogs/*.ts  — flat `en` / `zhCN` maps
//   2. yhub/locales/*.py           — backend/CLI `EN` / `ZH` maps
//   3. tauri/src/i18n.rs           — shell tray/notification strings (match arms)
//
// "aligned" is not "complete": a missing key falls back to the source language, so this
// script only covers parity and duplicate keys. Display text declared in Chinese (TOOL_META,
// tile titles, param help, MCP descriptions) is checked by scripts/verify-i18n-display.py,
// which asserts every such string has a TEXT_EN entry.
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB_DIR = join(ROOT, 'web', 'src', 'i18n', 'catalogs')
const PY_DIR = join(ROOT, 'yhub', 'locales')
const RUST = join(ROOT, 'tauri', 'src', 'i18n.rs')

let failed = 0
const fail = (msg) => {
  console.log(`FAIL  ${msg}`)
  failed++
}

// ---------------------------------------------------------------- web catalogs
{
  const KEY = /'([^']+)'\s*:/g
  const seen = new Map()
  for (const file of readdirSync(WEB_DIR).filter((f) => f.endsWith('.ts')).sort()) {
    const text = readFileSync(join(WEB_DIR, file), 'utf8')
    const enStart = text.indexOf('export const en')
    const zhStart = text.indexOf('export const zhCN')
    if (enStart < 0 || zhStart < 0) {
      fail(`${file}: missing en or zhCN export`)
      continue
    }
    const enKeys = new Set([...text.slice(enStart, zhStart).matchAll(KEY)].map((m) => m[1]))
    const zhKeys = new Set([...text.slice(zhStart).matchAll(KEY)].map((m) => m[1]))
    const missingZh = [...enKeys].filter((k) => !zhKeys.has(k))
    const missingEn = [...zhKeys].filter((k) => !enKeys.has(k))
    if (missingZh.length || missingEn.length) {
      fail(`${file}: en-only=${missingZh.slice(0, 5)} zh-only=${missingEn.slice(0, 5)}`)
    }
    for (const key of enKeys) {
      if (seen.has(key)) fail(`duplicate web key ${key} in ${file} and ${seen.get(key)}`)
      else seen.set(key, file)
    }
  }
  console.log(`PASS  web catalogs: ${seen.size} keys, en/zh parity, no duplicates`)
}

// ---------------------------------------------------------------- backend catalogs
{
  const PY_KEY = /^ {4}"([^"]+)":/gm
  const block = (text, marker, nextMarkers) => {
    const start = text.indexOf(marker)
    if (start < 0) return null
    const body = text.slice(start + marker.length)
    let end = body.length
    for (const m of nextMarkers) {
      const at = body.indexOf(m)
      if (at >= 0 && at < end) end = at
    }
    return [...body.slice(0, end).matchAll(PY_KEY)].map((m) => m[1])
  }
  const seen = new Map()
  for (const file of readdirSync(PY_DIR).filter((f) => f.endsWith('.py')).sort()) {
    if (file === 'display.py' || file === '__init__.py') continue
    const text = readFileSync(join(PY_DIR, file), 'utf8')
    const en = block(text, 'EN = {', ['\nZH = {', '\nTEXT_EN = {'])
    const zh = block(text, 'ZH = {', ['\nTEXT_EN = {'])
    if (!en || !zh) {
      fail(`yhub/locales/${file}: missing EN or ZH map`)
      continue
    }
    const enSet = new Set(en)
    const zhSet = new Set(zh)
    const missingZh = [...enSet].filter((k) => !zhSet.has(k))
    const missingEn = [...zhSet].filter((k) => !enSet.has(k))
    if (missingZh.length || missingEn.length) {
      fail(`yhub/locales/${file}: en-only=${missingZh.slice(0, 5)} zh-only=${missingEn.slice(0, 5)}`)
    }
    for (const key of enSet) {
      if (seen.has(key)) fail(`duplicate backend key ${key} in ${file} and ${seen.get(key)}`)
      else seen.set(key, file)
    }
  }
  console.log(`PASS  backend catalogs: ${seen.size} keys, EN/ZH parity, no duplicate keys`)
}

// ---------------------------------------------------------------- shell (Rust) catalog
{
  const text = readFileSync(RUST, 'utf8')
  const en = new Set()
  const fallback = new Set()
  for (const m of text.matchAll(/\((Lang::En|_),\s*"([^"]+)"\)\s*=>/g)) {
    ;(m[1] === 'Lang::En' ? en : fallback).add(m[2])
  }
  const missingFallback = [...en].filter((k) => !fallback.has(k))
  const missingEn = [...fallback].filter((k) => !en.has(k))
  if (missingFallback.length || missingEn.length) {
    fail(`tauri/src/i18n.rs: en-only=${missingFallback.slice(0, 5)} zh-only=${missingEn.slice(0, 5)}`)
  } else {
    console.log(`PASS  shell catalog: ${en.size} keys, en/zh parity`)
  }
}

console.log(failed === 0 ? 'PASS  i18n: all layers aligned' : `FAIL  ${failed} issue(s)`)
process.exit(failed === 0 ? 0 : 1)
