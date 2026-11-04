// 信息墙面板 QA：断点 × 主题的排版/溢出/裁切/控制台 + 三态（加载/空/错）+ 焦点环。
// 口径记在 docs/gui-development.md（本脚本 + verify-contrast.mjs + verify-bento-grid.mjs 三件套）。
//
// 前置： uv run yhub gui --no-open（服务 web/dist，先 npm run build）
// 跑法： node verify-bento-qa.mjs          （截图： OUT_DIR=/path/ node verify-bento-qa.mjs）
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const URL = process.env.YHUB_GUI_URL ?? 'http://127.0.0.1:8790/'
// 便当布局现在只属于信息墙模块（格子铺成网格，墙头带「🎨 自定义」），
// 这一套断言打的就是信息墙工具页 —— 分区、格子、墙头、侧栏同框。
const WALL_URL = `${URL}?tool=dashboard`
const CHROME =
  process.env.YHUB_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = process.env.OUT_DIR ?? ''
if (OUT) mkdirSync(OUT, { recursive: true })
/** 有 OUT_DIR 才截图；没给就只跑断言（CI 里别生成没人看的 PNG） */
const shot = (page, name) => (OUT ? page.screenshot({ path: `${OUT}${name}` }) : Promise.resolve())

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`)
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu'],
})

const watchErrors = (page, { allow500 = false } = {}) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    if (/favicon|frame-ancestors|status of 404/.test(m.text())) return
    // 注入的 500 本身必然被浏览器记成一条网络错误日志 —— 那是测试制造的，不是页面缺陷
    if (allow500 && /Failed to load resource: the server responded with a status of 500/.test(m.text())) return
    errors.push(m.text())
  })
  return errors
}

const resetScroll = async (page) => {
  await page.evaluate(() => {
    const s = document.querySelector('.bento-main section')
    if (s) s.scrollTop = 0
    window.scrollTo(0, 0)
  })
  await page.waitForTimeout(350)
}

/** 排版体检：列数 / 页面横向溢出 / 出视口元素 / 真裁切（无省略号的 overflow:hidden） */
const layoutProbe = (page) =>
  page.evaluate(() => {
    const grid = document.querySelector('[data-wall-grid]')
    // 阶段 C：grid 由 react-grid-layout 接管，列数按几何量（1×1 item 宽 × n + 间距 ≈ 容器宽）；
    // 间距从墙的 `data-grid-gap` 读（与 RGL 的 margin 同源，不写死 —— P1 已从 16 改成 12）
    // 列数按几何反推：任取一个条目，用它的 w 与实测宽反解列宽（图标固定 1×1，任一项都行）
    const el = document.querySelector('[data-wall-item]')
    const w = Number((el?.getAttribute('data-entry') ?? '').split(',')[3] ?? 0)
    const pw = el?.getBoundingClientRect().width ?? 0
    const gap = Number(
      document.querySelector('[data-wall-pager]')?.getAttribute('data-grid-gap') ?? 0,
    )
    const colW = el && w && pw ? (pw - (w - 1) * gap) / w : 0
    const cols = grid && colW ? Math.round((grid.getBoundingClientRect().width + gap) / (colW + gap)) : 0
    const docOverflowX = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    // 有意截断的豁免：祖先上有 `overflow:hidden + text-overflow:ellipsis` 时，行框是被裁掉的，
    // 但行内子元素（典型是 <a>）的 rect 仍报未裁切的宽度 —— 那不算「戳出视口」，
    // 与下面「真裁切」口径同一套规则（省略号是有意为之）。
    const inEllipsis = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const st = getComputedStyle(p)
        if (st.overflowX === 'hidden' && st.textOverflow === 'ellipsis') return true
      }
      return false
    }
    const outOfViewport = [...document.querySelectorAll('main *')].filter((el) => {
      if (el.closest('iframe')) return false
      const r = el.getBoundingClientRect()
      if (!(r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1))) return false
      return !inEllipsis(el)
    }).length
    // 真裁切 = 装不下(横向) 且没有省略号兜底，且自己/祖先不可滚
    const clips = []
    for (const el of document.querySelectorAll('main *, aside *')) {
      if (el.closest('iframe')) continue
      const st = getComputedStyle(el)
      if (st.display === 'none' || st.visibility === 'hidden') continue
      const text = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
      if (!text) continue
      const hiddenX = st.overflowX === 'hidden' && el.scrollWidth > el.clientWidth + 2
      const hiddenY = st.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 2
      if (!hiddenX && !hiddenY) continue
      if (st.textOverflow === 'ellipsis') continue // 有意省略号
      // 无障碍隐藏（sr-only：1px + clip）不是裁切
      if (el.classList.contains('sr-only') || parseFloat(st.width) <= 1 || parseFloat(st.height) <= 1) continue
      // 纵向：正文容器 overflow:auto/scroll = 有意滚动
      const scroller = st.overflowY === 'auto' || st.overflowY === 'scroll'
      if (hiddenY && scroller) continue
      clips.push({
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
        text: (el.textContent ?? '').trim().slice(0, 40),
        hiddenX,
        hiddenY,
      })
    }
    const cards = [...document.querySelectorAll('.bento-card')].length
    // 阶段 B：卡 = 格子 + 应用图标；图标没有卡头标题，用标签位（[data-icon-label]）齐平口径
    const titled = [
      ...document.querySelectorAll('.bento-card__title, [data-icon-label]'),
    ].length
    return { cols, docOverflowX, outOfViewport, clips, cards, titled }
  })

/** 等真格子（有标题的卡）：加载骨架也是 .bento-card，量早了会假红 */
const waitWall = async (page) => {
  await page.waitForSelector('.bento-grid .bento-card__title', { timeout: 25000 })
  await page.waitForTimeout(1200)
}

/* ────────────── 1) 断点 × 主题 ────────────── */
const CASES = [
  { name: 'desktop-1440', w: 1440, h: 900, cols: 12 },
  { name: 'tablet-768', w: 768, h: 1024, cols: 6 },
  { name: 'mobile-390', w: 390, h: 844, cols: 3 },
  // 断点边界：12 列起点(1024) / 6 列起点(640) / 3 列起点(639) —— 贴着线最容易挤出裁切
  { name: 'edge-1024', w: 1024, h: 800, cols: 12 },
  { name: 'edge-640', w: 640, h: 900, cols: 6 },
  { name: 'edge-639', w: 639, h: 900, cols: 3 },
]

for (const theme of ['dark', 'light']) {
  for (const c of CASES) {
    const page = await browser.newPage({ viewport: { width: c.w, height: c.h } })
    await page.addInitScript(() => window.localStorage.setItem('yhub.lang', 'zh-CN'))
    const errors = watchErrors(page)
    await page.goto(WALL_URL, { waitUntil: 'networkidle' })
    await page.evaluate((t) => {
      localStorage.setItem('yhub.panel.prefs', JSON.stringify({ theme: t, sizes: {}, hidden: [] }))
    }, theme)
    await page.reload({ waitUntil: 'networkidle' })
    await waitWall(page)
    const r = await layoutProbe(page)
    const tag = `${theme}/${c.name}`
    check(`${tag}：列数 = ${c.cols}`, r.cols === c.cols, `cols=${r.cols}`)
    check(
      `${tag}：每个格子/图标一张卡且都有标题或标签`,
      r.cards >= 5 && r.titled === r.cards,
      `${r.cards} 卡 / ${r.titled} 标题`,
    )
    check(`${tag}：页面不横向溢出`, !r.docOverflowX, `overflowX=${r.docOverflowX}`)
    check(`${tag}：没有元素戳出视口`, r.outOfViewport === 0, `out=${r.outOfViewport}`)
    check(
      `${tag}：没有真裁切（无省略号的 overflow:hidden）`,
      r.clips.length === 0,
      r.clips.length ? JSON.stringify(r.clips.slice(0, 4)) : '0',
    )
    // 侧栏在 <768px 收成图标栏（md:w-64），窄屏要真的收起来
    const asideW = await page.evaluate(() => document.querySelector('aside')?.getBoundingClientRect().width ?? 0)
    const wantAside = c.w >= 768 ? 256 : 56
    check(`${tag}：侧栏宽度 ${wantAside}px`, Math.abs(asideW - wantAside) < 2, `w=${asideW}`)
    await resetScroll(page)
    await shot(page, `${theme}-${c.name}-top.png`)
    await page.evaluate(() => {
      const s = document.querySelector('.bento-main section')
      if (s) s.scrollTop = s.scrollHeight
    })
    await page.waitForTimeout(500)
    await shot(page, `${theme}-${c.name}-bottom.png`)
    check(`${tag}：无控制台/JS 报错`, errors.length === 0, errors.slice(0, 2).join(' | '))
    await page.close()
  }
}

/* ────────────── 2) 三态：加载 / 空 / 错 ────────────── */
const JSON_HEADERS = { 'content-type': 'application/json' }

// 2a. 加载态：把格子接口**扣住不放**，墙头下面该出骨架格（形状 = 加载完的墙）。
//     扣住而不是「延迟 N 秒」：延迟是跟测试自己的耗时赛跑（等骨架、截图都要花时间），
//     一旦赛不过就成了假红（2026-09-29 实测：卡内 loading 断言全红，实际页面是对的）。
//     闸门由测试**主动**放：骨架断言完放行，再断言骨架撤掉。
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.addInitScript(() => window.localStorage.setItem('yhub.lang', 'zh-CN'))
  const errors = watchErrors(page)
  let releaseCells = false
  const hold = async (route) => {
    while (!releaseCells) await new Promise((r) => setTimeout(r, 100))
    try {
      await route.continue()
    } catch {
      /* 已经处理过 / 页面关了：忽略 */
    }
  }
  await page.route(/\/api\/dashboard\/cells(\?|$)/, hold)
  await page.goto(WALL_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="wall-skeleton"] .bento-skeleton', { timeout: 15000 })
  const skel = await page.evaluate(() => ({
    n: document.querySelectorAll('[data-testid="wall-skeleton"] .bento-card').length,
    headBlocks: document.querySelectorAll(
      '[data-testid="wall-skeleton"] .bento-card__head .bento-skeleton__block',
    ).length,
    spans: [...document.querySelectorAll('[data-testid="wall-skeleton"] .bento-card')].map(
      (c) => c.dataset.bentoSpan,
    ),
  }))
  check(
    '加载态：格子未回时出 5 张骨架卡（通栏总览压顶 + 两格一行，先乱后整不发生）',
    skel.n === 5 && skel.headBlocks === 5 && skel.spans[0] === 'full',
    // 骨架形状写死在 Dashboard.tsx 的 SKELETON_SPANS 里，两边对不上就是有人改了一头
    `n=${skel.n} headBlocks=${skel.headBlocks} spans=${skel.spans.join('/')}`,
  )
  await resetScroll(page)
  await shot(page, 'state-loading-skeleton.png')
  releaseCells = true
  await page.unroute(/\/api\/dashboard\/cells(\?|$)/)
  await page.waitForSelector('.bento-card__title', { timeout: 20000 })
  await page.waitForTimeout(600)
  check('加载态：数据到齐后骨架全部撤掉', (await page.locator('.bento-skeleton').count()) === 0)
  // 阶段 C：只渲染当前页 —— 标题位 = 格子标题 + 图标标签，一起数
  const realCards = await page.evaluate(
    () => document.querySelectorAll('.bento-card__title, [data-icon-label]').length,
  )
  check('加载态：格子/图标真的铺出来（标题+标签数 ≥ 5）', realCards >= 5, `titles=${realCards}`)
  check('加载态：无控制台/JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '))
  await page.close()
}

// 2b. 空态：信息墙 0 格（200 + total: 0 —— 不是错误、不是加载）
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.addInitScript(() => window.localStorage.setItem('yhub.lang', 'zh-CN'))
  const errors = watchErrors(page)
  await page.route('**/api/dashboard/cells', (r) =>
    r.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ ok: true, generated_at: new Date().toISOString(), next_refresh_in: 60, total: 0, count: 0, cells: [] }),
    }),
  )
  await page.goto(WALL_URL, { waitUntil: 'networkidle' })
  await page.waitForSelector('.bento-state--empty', { timeout: 25000 })
  await page.waitForTimeout(600)
  const dashEmpty = await page.locator('.bento-state--empty').filter({ hasText: '这一面墙还没有格子' }).count()
  check('空态：信息墙 0 格 → 空态块（不是错误、不是白屏）', dashEmpty > 0, `count=${dashEmpty}`)
  // C5：分区头已退役（D7）—— 分区各自的空态块不复存在，空态收敛到上面那个全局块
  const zoneSections = await page.locator('section[aria-label]').count()
  check('C5：分区头已退役（section 分区数 = 0，空态走全局块）', zoneSections === 0, `sections=${zoneSections}`)
  const stateCount = await page.locator('.bento-state').count()
  check('空态：空块数量克制（只该出现该出现的）', stateCount <= 4, `states=${stateCount}`)
  check('空态：无控制台/JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '))
  await resetScroll(page)
  await shot(page, 'state-empty.png')
  await page.close()
}

// 2c. 错误态：格子接口 500 → 页面红块 + 重试真的能恢复（墙头与侧栏不受牵连）
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.addInitScript(() => window.localStorage.setItem('yhub.lang', 'zh-CN'))
  const errors = watchErrors(page, { allow500: true })
  let cellsFail = true
  await page.route('**/api/dashboard/cells', async (r) => {
    if (cellsFail) {
      await r.fulfill({
        status: 500,
        headers: JSON_HEADERS,
        body: JSON.stringify({ ok: false, error: '信息墙取数崩了（QA 注入）', hint: '看后端日志里的 traceback' }),
      })
    } else await r.continue()
  })
  await page.goto(WALL_URL, { waitUntil: 'networkidle' })
  const cardErr = page.locator('main .bento-state--error')
  await cardErr.first().waitFor({ timeout: 15000 })
  await page.waitForTimeout(500)
  const alertRole = await cardErr.first().getAttribute('role')
  const errText = await cardErr.first().innerText()
  const asideOk = (await page.locator('aside').count()) === 1
  check(
    '错误态：取数失败出红块且 role=alert（有重试按钮），侧栏/墙头不被牵连',
    alertRole === 'alert' && /QA 注入/.test(errText) && /重试/.test(errText) && asideOk,
    errText.replace(/\n/g, ' ').slice(0, 70),
  )
  await resetScroll(page)
  await shot(page, 'state-error-card.png')
  // 注入撤掉后应当恢复：后端首取格子可能要几秒，点重试并轮询（上限 20s）
  cellsFail = false
  await page.locator('main .bento-state--error button', { hasText: '重试' }).click()
  let recovered = -1
  let tiles = 0
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500)
    recovered = await page.locator('main .bento-state--error').count()
    tiles = await page.locator('[data-cell]').count()
    if (recovered === 0 && tiles > 0) break
  }
  check('错误态：重试后恢复出数据（错误块消失 + 格子回来）', recovered === 0 && tiles > 0, `remaining=${recovered} tiles=${tiles}`)
  await page.close()
}

// 2d. 页面级错误：工具清单接口本身 500 → 顶部错误块 + 侧栏「后端未连接」
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.addInitScript(() => window.localStorage.setItem('yhub.lang', 'zh-CN'))
  const errors = watchErrors(page, { allow500: true })
  await page.route('**/api/tools', (r) =>
    r.fulfill({
      status: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ ok: false, error: '连不上本地后端（QA 注入）', hint: '跑 uv run yhub gui --no-open' }),
    }),
  )
  await page.goto(WALL_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  const pageErr = page.locator('main .bento-state--error')
  const n = await pageErr.count()
  const text = n ? await pageErr.first().innerText() : ''
  const role = n ? await pageErr.first().getAttribute('role') : ''
  check(
    '错误态（页面级）：清单 500 → 顶部红块 + hint + role=alert',
    n > 0 && role === 'alert' && /QA 注入/.test(text) && /uv run yhub gui/.test(text),
    text.replace(/\n/g, ' ').slice(0, 80),
  )
  check('错误态（页面级）：不出假骨架（骨架只属于格子加载态）', (await page.locator('.bento-skeleton').count()) === 0)
  const navErr = await page.locator('aside').innerText()
  check('错误态（页面级）：侧栏如实说「后端未连接」', /后端未连接/.test(navErr), navErr.split('\n').slice(-2).join(' / '))
  await resetScroll(page)
  await shot(page, 'state-error-page.png')
  check('错误态（页面级）：无控制台/JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '))
  await page.close()
}

/* ────────────── 3) 焦点环（两主题） ────────────── */
for (const theme of ['dark', 'light']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.addInitScript(() => window.localStorage.setItem('yhub.lang', 'zh-CN'))
  const errors = watchErrors(page)
  await page.goto(WALL_URL, { waitUntil: 'networkidle' })
  await page.evaluate((t) => {
    localStorage.setItem('yhub.panel.prefs', JSON.stringify({ theme: t, sizes: {}, hidden: [] }))
  }, theme)
  await page.reload({ waitUntil: 'networkidle' })
  await waitWall(page)
  // 侧栏顶部（不可聚焦的容器）点一下，把「顺序导航起点」放回文档开头，
  // 再用 Tab 按 DOM 顺序走完整条链：侧栏 → 墙头按钮 → 格子里的深链
  await page.locator('aside > div').first().click()
  const seen = []
  const noRing = []
  let leftPage = 0
  for (let i = 0; i < 60 && leftPage < 1; i++) {
    await page.keyboard.press('Tab')
    const info = await page.evaluate(() => {
      const el = document.activeElement
      if (!el) return { none: true }
      if (el === document.body) return { body: true }
      if (el.tagName === 'IFRAME') return { iframe: true }
      const st = getComputedStyle(el)
      const ring =
        (st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) >= 1) ||
        (st.boxShadow !== 'none' && st.boxShadow !== '')
      return {
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : '').split(/\s+/).slice(0, 3).join('.'),
        inCard: !!el.closest('.bento-card'),
        ring,
        outline: `${st.outlineStyle} ${st.outlineWidth} ${st.outlineColor}`,
        text: (el.textContent ?? '').trim().slice(0, 18),
      }
    })
    if (info.none) break
    if (info.body) {
      // 焦点离开页面（走到浏览器 UI）—— 记一次就收工，这一站不算页面元素
      leftPage++
      continue
    }
    if (info.iframe) {
      seen.push('iframe（子文档自管焦点样式）')
      break
    }
    seen.push(`${info.tag}.${info.cls}${info.inCard ? ' [card]' : ''}${info.ring ? '' : ' ✗no-ring'}`)
    if (!info.ring) noRing.push(`${info.tag}.${info.cls} "${info.text}" outline=${info.outline}`)
    if (seen.length === 6) await shot(page, `focus-${theme}-shell.png`)
    if (seen.length === 24) await shot(page, `focus-${theme}-card.png`)
    if (seen.length >= 40) break
  }
  const inCard = seen.filter((s) => s.includes('[card]')).length
  check(
    `焦点环（${theme}）：每一步键盘焦点都有可见环（${seen.length} 站，其中格内 ${inCard} 站）`,
    noRing.length === 0 && seen.length >= 15 && inCard >= 4,
    noRing.length ? noRing.join(' ; ') : seen.slice(0, 5).join(' → '),
  )
  check(`焦点环（${theme}）：无控制台/JS 报错`, errors.length === 0, errors.slice(0, 2).join(' | '))
  await page.close()
}

await browser.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
if (failed.length) {
  console.log('未通过：')
  for (const f of failed) console.log(`  FAIL  ${f.name}  → ${f.detail}`)
  process.exitCode = 1
}
