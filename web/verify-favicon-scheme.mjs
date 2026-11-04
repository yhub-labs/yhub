// favicon.svg 的 prefers-color-scheme 双色是否真的生效。
//
// 做法：用 playwright 以浅色 / 深色两种配色各打开一次 favicon.svg，直接读 resolved 的 color
// （favicon 用 currentColor 着色，color 就是这个文件在浏览器里的实际颜色），并各存一张截图做证据。
// 期望：light -> rgb(78, 122, 92) = #4E7A5C（白底 4.85:1）；dark -> rgb(156, 195, 166) = #9CC3A6（深底 8.7:1）。
//
// 用法：cd web && node verify-favicon-scheme.mjs   （退出码 0 = 两种配色都对）
import { chromium } from 'playwright-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SVG_URL = new URL('./public/favicon.svg', import.meta.url).href
const WANT = { light: 'rgb(78, 122, 92)', dark: 'rgb(156, 195, 166)' }

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
let failed = 0
for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 96, height: 96 }, colorScheme: scheme })
  await page.goto(SVG_URL)
  const got = await page.evaluate(() => getComputedStyle(document.documentElement).color)
  const shot = `/tmp/favicon-scheme-${scheme}.png`
  await page.screenshot({ path: shot, omitBackground: true })
  const ok = got === WANT[scheme]
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${scheme}: color=${got}（期望 ${WANT[scheme]}）→ 截图 ${shot}`)
  await page.close()
}
await browser.close()
console.log(failed === 0 ? 'favicon 双色 OK' : `${failed} 项不符`)
process.exit(failed === 0 ? 0 : 1)
