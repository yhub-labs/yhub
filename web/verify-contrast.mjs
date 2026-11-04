// 对比度全量探针（分组统计）：深/浅 × 工作台/设置/启动器/自定义弹层，共 8 个态。
// 口径：oklch/oklab 可解析、半透明背景逐层合成到最近的不透明底、按字号取 4.5 / 3.0 阈值；
// 排除「纯 emoji 文本」（emoji 走彩色字形，CSS color 不参与渲染）与 iframe 子文档。
// 结果记在 docs/gui-development.md 的「验收口径」。跑法： node verify-contrast.mjs
import { chromium } from 'playwright-core'

const URL = process.env.YHUB_GUI_URL ?? 'http://127.0.0.1:8790/'
const CHROME =
  process.env.YHUB_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.addInitScript(() => window.localStorage.setItem('yhub.lang', 'zh-CN'))

const probe = () =>
  page.evaluate(() => {
    const num = (s) => {
      if (s == null) return null
      const v = String(s).trim()
      if (v === 'none') return 0
      if (v.endsWith('%')) return (parseFloat(v) / 100) * 255
      return parseFloat(v)
    }
    const oklabToRgb = (L, a, b, alpha) => {
      const l_ = L + 0.3963377774 * a + 0.2158037573 * b
      const m_ = L - 0.1055613458 * a - 0.0638541728 * b
      const s_ = L - 0.0894841775 * a - 1.291485548 * b
      const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
      const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
      const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
      const bb = -0.0041960863 * l + 0.7034186147 * m + 1.707614701 * s
      const enc = (v) => {
        v = Math.min(1, Math.max(0, v))
        return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
      }
      return { r: enc(r) * 255, g: enc(g) * 255, b: enc(bb) * 255, a: alpha }
    }
    const alphaOf = (p, idx) => {
      const v = p[idx]
      if (v === undefined) return 1
      return v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v)
    }
    const parse = (css) => {
      if (!css) return null
      const s = css.trim()
      let m = /^rgba?\(([^)]+)\)$/i.exec(s)
      if (m) {
        const p = m[1].split(/[\s,/]+/).filter(Boolean)
        return { r: num(p[0]), g: num(p[1]), b: num(p[2]), a: p[3] === undefined ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]) }
      }
      m = /^#([0-9a-f]{3,8})$/i.exec(s)
      if (m) {
        const h = m[1]
        const g2 = (i) => parseInt(h.length <= 4 ? h[i] + h[i] : h.slice(i * 2, i * 2 + 2), 16)
        return { r: g2(0), g: g2(1), b: g2(2), a: h.length === 8 ? g2(3) / 255 : h.length === 4 ? g2(3) / 15 : 1 }
      }
      m = /^oklch\(([^)]+)\)$/i.exec(s)
      if (m) {
        const p = m[1].split(/[\s,/]+/).filter(Boolean)
        return oklabToRgb(parseFloat(p[0]), (parseFloat(p[1]) || 0) * Math.cos(((parseFloat(p[2]) || 0) * Math.PI) / 180), (parseFloat(p[1]) || 0) * Math.sin(((parseFloat(p[2]) || 0) * Math.PI) / 180), alphaOf(p, 3))
      }
      m = /^oklab\(([^)]+)\)$/i.exec(s)
      if (m) {
        const p = m[1].split(/[\s,/]+/).filter(Boolean)
        return oklabToRgb(parseFloat(p[0]), parseFloat(p[1]) || 0, parseFloat(p[2]) || 0, alphaOf(p, 3))
      }
      return null
    }
    const over = (src, dst) => ({ r: src.a * src.r + (1 - src.a) * dst.r, g: src.a * src.g + (1 - src.a) * dst.g, b: src.a * src.b + (1 - src.a) * dst.b, a: 1 })
    const lum = ({ r, g, b }) => {
      const f = (v) => {
        v /= 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const ratio = (c1, c2) => {
      const [l1, l2] = [lum(c1), lum(c2)].sort((x, y) => y - x)
      return (l1 + 0.05) / (l2 + 0.05)
    }
    const effBg = (el) => {
      const layers = []
      let node = el
      let opaque = null
      for (let i = 0; node && i < 20; i++, node = node.parentElement) {
        const c = parse(getComputedStyle(node).backgroundColor)
        if (!c || c.a === 0) continue
        layers.push(c)
        if (c.a >= 0.999) {
          opaque = c
          break
        }
      }
      let base = opaque ?? { r: 255, g: 255, b: 255, a: 1 }
      for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base)
      return base
    }
    const cls = (n) => {
      const raw = (typeof n.className === 'string' ? n.className : '').split(/\s+/)
      const keep = raw.filter((x) => x && !/^[A-Za-z0-9_-]{24,}$/.test(x))
      // 取最像「语义类」的两个（bento-*/text-* 等），长哈希类丢掉
      const prefer = keep.filter((x) => /bento|text-|bento-state|bento-card|rounded|border/.test(x))
      return (prefer.length ? prefer : keep).slice(0, 2).join('.')
    }
    // 纯 emoji / 装饰符号：彩色字形，CSS color 不参与渲染 → 排除
    const isEmojiOnly = (t) => {
      const s = t.trim()
      if (!s) return false
      return [...s].every((ch) => {
        const cp = ch.codePointAt(0)
        return (
          cp >= 0x1f000 ||
          (cp >= 0x2600 && cp <= 0x27bf) ||
          cp === 0xfe0f ||
          cp === 0x200d ||
          /\s/.test(ch) ||
          cp === 0x00b7
        )
      })
    }

    const groups = new Map()
    let emojiSkipped = 0
    const check = (fgCss, bgEl, el, label) => {
      const fg = parse(fgCss)
      if (!fg) return
      const bg = effBg(bgEl)
      const r = ratio(fg, bg)
      const st = getComputedStyle(el)
      const size = parseFloat(st.fontSize)
      const bold = Number(st.fontWeight) >= 700
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5
      if (r >= need) return
      const text = (el.getAttribute('placeholder') ?? el.textContent ?? '').trim().slice(0, 24)
      if (label === 'text' && isEmojiOnly(text)) {
        emojiSkipped++
        return
      }
      const key = `${fgCss} @${Math.round(size)}px ${cls(el)}`
      const g = groups.get(key) ?? { key, count: 0, worst: r, need, sample: text, label }
      g.count++
      if (r < g.worst) {
        g.worst = r
        g.sample = text
      }
      groups.set(key, g)
    }
    // body 而不是 main/aside：启动器视图没有 main/aside（App 直接返回 Launcher），
    // 用 main/aside 会把启动器整屏漏掉（v1 就这么漏的）
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('iframe')) continue
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
      const st = getComputedStyle(el)
      if (st.visibility === 'hidden' || st.display === 'none') continue
      if (hasText) check(st.color, el, el, 'text')
      if (el.tagName === 'INPUT') {
        const ph = getComputedStyle(el, '::placeholder').color
        if (ph && ph !== st.color) check(ph, el, el, 'placeholder')
      }
    }
    return {
      groups: [...groups.values()].sort((a, b) => a.worst - b.worst),
      total: [...groups.values()].reduce((n, g) => n + g.count, 0),
      emojiSkipped,
    }
  })

const CASES = [
  // 便当布局现在只属于信息墙模块（格子铺成网格）：这一态测墙工具页（含侧栏 + 墙头），
  // 工具页是「一个工具一页」，其余工具页另有 toolpage 用例。
  ['dark', 'wall', '?tool=dashboard'],
  ['dark', 'toolpage', '?tool=rclone'],
  ['dark', 'settings', '?view=settings'],
  ['dark', 'launcher', '?launcher=1'],
  ['light', 'wall', '?tool=dashboard'],
  ['light', 'toolpage', '?tool=rclone'],
  ['light', 'settings', '?view=settings'],
  ['light', 'launcher', '?launcher=1'],
  // 自定义弹层（信息墙墙头「🎨 自定义」）单独各测一次：它浮在卡片上，底色是另一套
  ['dark', 'customize', '?tool=dashboard'],
  ['light', 'customize', '?tool=dashboard'],
]

const openCustomize = async () => {
  await page.locator('[data-pref-trigger]').click()
  await page.waitForSelector('text=偏好只存本机浏览器', { timeout: 5000 })
  await page.waitForTimeout(400)
}

for (const [theme, view, qs] of CASES) {
  await page.goto(URL + (qs === '?launcher=1' ? '' : qs), { waitUntil: 'networkidle' })
  await page.evaluate((t) => {
    localStorage.setItem('yhub.panel.prefs', JSON.stringify({ theme: t, sizes: {}, hidden: [] }))
  }, theme)
  await page.reload({ waitUntil: 'networkidle' })
  if (qs === '?launcher=1') {
    await page.waitForSelector('main [data-tool-page]', { timeout: 25000 })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
  } else if (qs === '?tool=dashboard') {
    // 墙工具页：先等工具页壳，再等真格子（骨架卡没有文字，量早了会漏测）
    await page.waitForSelector('main [data-tool-page]', { timeout: 25000 })
    await page.waitForSelector('.bento-grid .bento-card__title', { timeout: 25000 })
    await page.waitForTimeout(1500)
  } else if (qs.startsWith('?tool=')) {
    await page.waitForSelector('main [data-tool-page]', { timeout: 25000 })
    await page.waitForTimeout(1500)
  } else {
    await page.waitForTimeout(1500)
  }
  if (view === 'customize') await openCustomize()
  const res = await probe()
  console.log(
    `\n=== ${theme} / ${view}: ${res.groups.length} 组、${res.total} 处未达标（排除纯 emoji ${res.emojiSkipped} 处）===`,
  )
  for (const g of res.groups)
    console.log(
      `  ${String(Math.round(g.worst * 100) / 100).padStart(5)} (需 ${g.need}) ×${String(g.count).padStart(3)}  [${g.label}] ${g.sample}  ← ${g.key}`,
    )
}
await browser.close()
