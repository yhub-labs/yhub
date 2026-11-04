// 信息墙便当网格三断点验收：列数 / 卡片数 / 横向溢出 / 卡内溢出 / 控制台报错，可选截图。
//
// 运行前先起后端（服务 web/dist，所以先 `npm run build`）：
//   uv run yhub gui --no-open &
//   node verify-bento-grid.mjs
//
// 环境变量：
//   YHUB_GUI_URL  默认 http://127.0.0.1:8790/
//   OUT_DIR         给了就按断点存截图（bento-<断点>-top/bottom.png）
//
// 断点口径（与 src/bento.css / wallLayout.ts 一致）：≥1024px 12 列、640~1023px 6 列、<640px 3 列。

import { chromium } from 'playwright-core'

const URL = process.env.YHUB_GUI_URL ?? 'http://127.0.0.1:8790/'
// 便当布局现在只属于信息墙模块（格子铺成网格），所以这一套断言打信息墙工具页：
// 分区头、异常总览、格子都在 <main> 里，跟其它断言同一条口径。
const WALL_URL = `${URL}?tool=dashboard`
const CHROME =
  process.env.YHUB_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = process.env.OUT_DIR ?? ''

const CASES = [
  { name: 'desktop-1440', width: 1440, height: 900, cols: 12 },
  { name: 'tablet-768', width: 768, height: 1024, cols: 6 },
  { name: 'mobile-390', width: 390, height: 844, cols: 3 },
]

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`)
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu'],
})

for (const c of CASES) {
  const page = await browser.newPage({ viewport: { width: c.width, height: c.height } })
  await page.addInitScript(() => window.localStorage.setItem('yhub.lang', 'zh-CN'))
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    // 「status of 404」是网络日志不是页面报错（存档键不存在 = 404 是契约语义，同 smoke.mjs）
    if (m.type() === 'error' && !/favicon|frame-ancestors|status of 404/.test(m.text()))
      errors.push(m.text())
  })

  try {
    await page.goto(WALL_URL, { waitUntil: 'networkidle' })
    // 等**真格子**（有标题的卡），不是加载骨架 —— 骨架卡没有标题，量早了会假红
    await page.waitForSelector('.bento-grid .bento-card__title', { timeout: 25000 })
    await page.waitForTimeout(1500)

    const info = await page.evaluate(() => {
      const grid = document.querySelector('.bento-grid')
      const cards = [...document.querySelectorAll('.bento-card')]
      const scrollBox = document.querySelector('.tool-page') // 滚动的是工具页，不是 document
      return {
        // 阶段 C：容器已被 react-grid-layout 接管（display:block）——列数按几何量：
        // 1×1 item 宽 × n + 间距 ≈ 容器宽。间距从墙上读（`data-grid-gap`，与 RGL 的 margin 同源，
        // 不写死 —— P1 把它从 16 改成了 12，写死的会把断言带进坑里）。
        // 列数按几何反推：任取一个条目，用它的 w 和实测宽反解列宽，再除容器宽。
        // （图标已回到网格并固定 1×1；任取一项用它的 w 反解列宽）
        cols: (() => {
          const pager = document.querySelector('[data-wall-pager]')
          const gap = Number(pager?.getAttribute('data-grid-gap') ?? 0)
          const el = document.querySelector('[data-wall-item]')
          const w = Number((el?.getAttribute('data-entry') ?? '').split(',')[3] ?? 0)
          const pw = el?.getBoundingClientRect().width ?? 0
          if (!el || !w || !pw) return 0
          const colW = (pw - (w - 1) * gap) / w
          return Math.round((grid.getBoundingClientRect().width + gap) / (colW + gap))
        })(),
        cards: cards.length,
        // 阶段 B：卡 = 格子（.bento-card__title）+ 应用图标（[data-icon-label]），两者各有其标题位
        titled: cards.filter((el) => el.querySelector('.bento-card__title, [data-icon-label]')).length,
        radius: getComputedStyle(cards[0]).borderRadius,
        docOverflowX: document.documentElement.scrollWidth > window.innerWidth,
        outOfViewport: cards.filter((el) => {
          const r = el.getBoundingClientRect()
          return r.right > window.innerWidth + 1 || r.left < -1
        }).length,
        bodyOverflowX: [...document.querySelectorAll('.bento-card__body')].filter(
          (el) => el.scrollWidth > el.clientWidth + 1,
        ).length,
        scrollable: scrollBox ? scrollBox.scrollHeight > scrollBox.clientHeight : false,
      }
    })

    check(`${c.name}：${c.cols} 列`, info.cols === c.cols, `cols=${info.cols}`)
    check(
      `${c.name}：每个格子/图标一张卡且都有标题或标签`,
      info.titled === info.cards && info.cards >= 5,
      `cards=${info.cards} titled=${info.titled}`,
    )
    check(
      `${c.name}：无横向溢出（页面 / 卡片 / 卡内正文）`,
      !info.docOverflowX && info.outOfViewport === 0 && info.bodyOverflowX === 0,
      JSON.stringify(info),
    )
    // 2026-11 改版：圆角从 16px 收到 8px（--radius-lg），偏「软件」而不是「落地页卡片」
    check(`${c.name}：圆角 8px 生效`, info.radius === '8px', info.radius)
    check(`${c.name}：无 JS 报错`, errors.length === 0, errors.slice(0, 2).join(' / '))

    if (OUT) {
      await page.evaluate(() => {
        const box = document.querySelector('.tool-page')
        if (box) box.scrollTop = 0
      })
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${OUT}/bento-${c.name}-top.png` })
      await page.evaluate(() => {
        const box = document.querySelector('.tool-page')
        if (box) box.scrollTop = box.scrollHeight
      })
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${OUT}/bento-${c.name}-bottom.png` })
      console.log(`      截图 → ${OUT}/bento-${c.name}-{top,bottom}.png`)
    }
  } catch (e) {
    check(`${c.name}：跑完`, false, String(e).slice(0, 200))
  }
  await page.close()
}

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length ? 1 : 0)
