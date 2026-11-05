// 端到端冒烟测试：用本机已装的 Chrome（无头）驱动真实界面。
// 运行前先起后端：  uv run yhub gui --no-open
// 然后：            node smoke.mjs
//
// 断言一律只读 <main>（侧栏描述里也有「部首笔画」这类词，读 body 会假阳性）。

import { chromium } from 'playwright-core'

const URL = (process.env.YHUB_GUI_URL ?? 'http://127.0.0.1:8790').replace(/\/$/, '') + '/'
const CHROME =
  process.env.YHUB_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
// 语言必须**确定**：界面文案现在跟随后端的 `settings.ui_language`（0.1.7 起，见 commit 0203286），
// 工具名/状态文案也由后端渲染。这套断言的中文选择器因此要求后端就是 zh-CN —— 先探一下，
// 不是就立刻说清楚怎么跑，而不是让后面十几条断言莫名其妙地超时。localStorage 那一手保留着，
// 供仍在按 localStorage 取语言的老版本界面使用。
const backendLang = await fetch(`${URL}api/settings`)
  .then((r) => r.json())
  .then((d) => d?.settings?.ui_language)
  .catch(() => null)
if (backendLang !== 'zh-CN') {
  console.log(
    `FAIL  冒烟需要一个 zh-CN 的后端（当前 ui_language=${backendLang}）。用临时配置根起一个再跑，例如：\n` +
      '  mkdir -p /tmp/yh-smoke && echo \'{"ui_language": "zh-CN"}\' > /tmp/yh-smoke/settings.json\n' +
      '  YHUB_CONFIG_DIR=/tmp/yh-smoke YHUB_SETTINGS_FILE=/tmp/yh-smoke/settings.json uv run yhub gui --no-open --port 8797 &\n' +
      '  cd web && YHUB_GUI_URL=http://127.0.0.1:8797 npm run smoke',
  )
  await browser.close()
  process.exit(1)
}
await page.addInitScript(() => window.localStorage.setItem('yhub.lang', 'zh-CN'))
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  // 「status of 404」是**网络日志**不是页面 JS 报错：老那套 HTML 工具存档的「查不到就是空」语义
  // 会留下 404（机制已下线），浏览器必然把它记成一条 error 级网络消息。
  // 已知噪声豁免：favicon / CSP frame-ancestors / 已下线接口的 404 / 第三方插件上游的 4xx
  // （插件面板把上游故障如实说成错误是预期行为，不该让冒烟红）。
  if (
    m.type() === 'error' &&
    !/favicon|frame-ancestors|status of 404|status of 400/.test(m.text())
  )
    errors.push(m.text())
})

const main = () => page.locator('main')
const mainText = () => main().innerText()

/** 等 <main> 里出现某个模式（正则），返回最终文本 */
async function waitMain(pattern, timeout = 20000) {
  const deadline = Date.now() + timeout
  let text = ''
  while (Date.now() < deadline) {
    text = await mainText()
    if (pattern.test(text)) return text
    await page.waitForTimeout(250)
  }
  throw new Error(`等待 ${pattern} 超时；当前 main 文本：${text.slice(0, 200).replace(/\n/g, ' ')}`)
}

async function clickTool(name) {
  await page.locator('aside button', { hasText: name }).first().click({ timeout: 10000 })
}

try {
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.evaluate(() => window.localStorage.setItem('yhub.lang', 'zh-CN'))
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('aside button', { timeout: 10000 })

  // 1) 侧栏工具列表来自后端 /api/tools：期望清单现取，装了什么就比什么
  //    （写死名单会在装了插件时假红，也会在后端裁掉工具后假绿）
  const toolsResp = await fetch(`${URL}api/tools`).then((r) => r.json()).catch(() => null)
  const expectedTools = (toolsResp?.tools ?? [])
    .filter((t) => t.id !== 'dashboard')
    .map((t) => t.name)
  const nav = (await page.locator('aside button').allInnerTexts()).join(' | ')
  check(
    '侧栏加载后端给的工具（与 /api/tools 逐项对账）',
    expectedTools.length > 0 && expectedTools.every((n) => nav.includes(n)),
    `expected=${JSON.stringify(expectedTools)} nav=${nav.replace(/\n/g, ' ')}`,
  )
  // 反向也要对：**多出来的条目就是幽灵**（卸载/禁用插件后残留的「这个工具还没有面板」）。
  // 只比工具分组（aside nav），搜索/设置/桌面是固定入口，不参与对账。
  const navTools = (await page.locator('aside nav button').allInnerTexts()).map((s) => s.trim())
  check(
    '侧栏工具条目与 /api/tools 完全一致（多一条幽灵也算失败）',
    navTools.length === expectedTools.length && navTools.every((n, i) => n === expectedTools[i]),
    `nav=${JSON.stringify(navTools)} expected=${JSON.stringify(expectedTools)}`,
  )
  // 设置现在是侧栏顶部的固定入口（配置工具已退役进设置中心），不再占工具清单的一条
  check('侧栏顶部有设置入口', /设置/.test(nav), nav.replace(/\n/g, ' '))

  // 1b) 信息墙的便当网格：一个格子一张卡、桌面断点 4 列、页面不横向溢出
  //     （便当布局现在只属于信息墙模块；其它工具页没有网格，见 1d）
  await page.goto(`${URL}?tool=dashboard`, { waitUntil: 'networkidle' })
  await page.waitForSelector('main .bento-grid .bento-card', { timeout: 15000 })
  const gridInfo = await page.evaluate(() => {
    const grids = [...document.querySelectorAll('main .bento-grid')]
    if (!grids.length) return null
    return {
      grids: grids.length,
      cols: getComputedStyle(grids[0]).gridTemplateColumns.split(' ').filter(Boolean).length,
      cards: document.querySelectorAll('main .bento-card').length,
      cells: document.querySelectorAll('main [data-cell]').length,
      cellTitles: document.querySelectorAll('main [data-cell] .bento-card__title').length,
      icons: document.querySelectorAll('main [data-icon-tile]').length,
      iconLabels: document.querySelectorAll('main [data-icon-label]').length,
      // 图标格的实测宽度（P1 的核心断言：它不该再是一大块）
      iconW: Math.round(
        document.querySelector('main [data-icon-tile]')?.getBoundingClientRect().width ?? 0,
      ),
      hOverflow: document.documentElement.scrollWidth > window.innerWidth,
    }
  })
  check(
    // 阶段 C 口径：只渲染当前页 —— 断言当页不变量（格子有标题、图标有标签、卡数齐平）
    '便当格：格子有标题、图标有标签，卡数 = 格子 + 图标',
    !!gridInfo &&
      gridInfo.cells >= 1 &&
      gridInfo.cellTitles === gridInfo.cells &&
      gridInfo.iconLabels === gridInfo.icons &&
      gridInfo.cards === gridInfo.cells + gridInfo.icons,
    JSON.stringify(gridInfo),
  )
  // 列数按**几何**量：1×1 item 宽 × 列数 + 间距 ≈ 容器宽（旧的 gridTemplateColumns 口径随
  // react-grid-layout 接管作废 —— 容器已不是 CSS grid）
  const colsInfo = await page.evaluate(() => {
    const grid = document.querySelector('[data-wall-grid]')
    // 图标已回到网格并固定 1×1；任取一项用它的 w 反解列宽
    const el = document.querySelector('[data-wall-item]')
    if (!grid || !el) return null
    const gw = grid.getBoundingClientRect().width
    const gap = Number(document.querySelector('[data-wall-pager]')?.getAttribute('data-grid-gap') ?? 0)
    const w = Number((el.getAttribute('data-entry') ?? '').split(',')[3] ?? 0)
    const pw = el.getBoundingClientRect().width
    const colW = w ? (pw - (w - 1) * gap) / w : 0
    return { gw: Math.round(gw), w, pw: Math.round(pw), gap, colsReal: colW ? Math.round((gw + gap) / (colW + gap)) : 0 }
  })
  check('便当格：桌面断点（1280px）几何 12 列（间距从 data-grid-gap 读）', colsInfo?.colsReal === 12, JSON.stringify(colsInfo))
  // P1：图标坐在 1/12 宽的格里（≈82px），不再占满 268×182 的大块
  check(
    '便当格：图标格 ≈ 1/12 宽（不再是『好大一块』）',
    !!gridInfo && gridInfo.iconW > 40 && gridInfo.iconW < 120,
    `iconW=${gridInfo?.iconW}`,
  )
  check('便当格：页面不横向溢出', gridInfo?.hOverflow === false, JSON.stringify(gridInfo))

  // 1c) 卡片化：状态点 / 卡内滚动上限 / 尺寸登记（异常总览通栏压顶、两个分区各一张网格）
  const cardInfo = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('main .bento-card')]
    if (!cards.length) return null
    const grid = document.querySelector('main .bento-grid')
    const cs = getComputedStyle(grid)
    const contentW =
      grid.getBoundingClientRect().width -
      parseFloat(cs.paddingLeft) -
      parseFloat(cs.paddingRight)
    const overview = document.querySelector('main [data-bento-card="overview.alerts"]')
    return {
      cards: cards.length,
      cells: cards.filter((c) => c.dataset.cell !== undefined).length,
      statused: cards.filter((c) => c.querySelector('.bento-card__status')).length,
      scrolling: [...document.querySelectorAll('main .bento-card__body')].filter(
        (b) => getComputedStyle(b).overflowY === 'auto',
      ).length,
      spans: Object.fromEntries(cards.map((c) => [c.dataset.bentoCard, c.dataset.bentoSpan])),
      overviewFull:
        !!overview &&
        overview.dataset.bentoSpan === 'full' &&
        Math.abs(overview.getBoundingClientRect().width - contentW) < 2,
      zones: document.querySelectorAll('main section[aria-label]').length,
      clipped: [...document.querySelectorAll('main .bento-card__body')].filter(
        (b) => b.scrollHeight - b.clientHeight > 4,
      ).length,
      hinted: cards.filter((c) => c.classList.contains('has-more')).length,
    }
  })
  check(
    // 状态点/卡内滚动是**格子**的契约（图标块没有卡头和正文，见 Dashboard 的 IconTile）
    '便当格：每个格子都带状态点，正文走卡内滚动（不撑高整行）',
    !!cardInfo && cardInfo.statused === cardInfo.cells && cardInfo.scrolling === cardInfo.cells,
    JSON.stringify(cardInfo),
  )
  check(
    '便当格：内容装得下的格子不给假的底部渐隐提示',
    !!cardInfo && cardInfo.clipped === cardInfo.hinted,
    `clipped=${cardInfo?.clipped} hinted=${cardInfo?.hinted}`,
  )
  // 阶段 C（C5）：分区断言退役（D7），换成「分页」断言 —— 总览通栏压顶保留，
  // 页点数 = 页数，点页点翻得动（页码与卡集合跟着换）。
  const pagerBefore = await page.evaluate(() => {
    const pager = document.querySelector('[data-wall-pager]')
    return {
      pages: Number(pager?.getAttribute('data-pages') ?? 0),
      page: Number(pager?.getAttribute('data-page') ?? 0),
      dots: document.querySelectorAll('[data-page-dot]').length,
      firstItem: document.querySelector('[data-wall-item]')?.getAttribute('data-wall-item') ?? '',
    }
  })
  let pagerAfter = pagerBefore
  if (pagerBefore.pages > 1) {
    await page.click('[data-page-dot="1"]')
    await page.waitForTimeout(350)
    pagerAfter = await page.evaluate(() => {
      const pager = document.querySelector('[data-wall-pager]')
      return {
        pages: Number(pager?.getAttribute('data-pages') ?? 0),
        page: Number(pager?.getAttribute('data-page') ?? 0),
        dots: document.querySelectorAll('[data-page-dot]').length,
        firstItem: document.querySelector('[data-wall-item]')?.getAttribute('data-wall-item') ?? '',
      }
    })
    await page.click('[data-page-dot="0"]')
    await page.waitForTimeout(350)
  }
  // 页数取决于装的插件和库里的胶囊：干净安装只有一页，翻页那半段就不能硬要求
  const pagingOk =
    pagerBefore.pages <= 1 ||
    (pagerBefore.dots === pagerBefore.pages &&
      pagerAfter.page === 1 &&
      pagerAfter.firstItem !== pagerBefore.firstItem)
  check(
    '便当格：尺寸登记生效（异常总览通栏压顶）+ 分页（页点数 = 页数；有第二页时才验翻页）',
    !!cardInfo &&
      cardInfo.spans['overview.alerts'] === 'full' &&
      cardInfo.overviewFull === true &&
      pagerBefore.pages >= 1 &&
      pagingOk,
    JSON.stringify({ ...cardInfo, pagerBefore, pagerAfter }),
  )

  // 1d) 默认形态 = 工具页：侧栏是页签，切工具就换页（上一页整个卸载），不是在一张长页面上
  //     滚到别的位置。信息墙的网格跟着深链 ?tool=dashboard，刷新后还在。
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('main .bento-grid', { timeout: 10000 })
  check(
    '信息墙工具页刷新后仍是网格（深链 tool 参数留在地址上，没有 ?view= 总览）',
    (await page.locator('main .bento-grid').count()) >= 1 &&
      // 注意：本文件顶部把常量名占用了 URL，全局的 URL 构造器要走 globalThis
      new globalThis.URL(page.url()).searchParams.get('tool') === 'dashboard' &&
      !new globalThis.URL(page.url()).searchParams.has('view'),
    page.url(),
  )

  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForSelector('main [data-tool-page]', { timeout: 10000 })
  const pageShape = await page.evaluate(() => ({
    toolPage: document.querySelector('main [data-tool-page]')?.getAttribute('data-tool-page') ?? '',
    grid: document.querySelectorAll('main .bento-grid').length,
    cards: document.querySelectorAll('main .bento-card').length,
    icons: document.querySelectorAll('main [data-icon-tile]').length,
    hOverflow: document.documentElement.scrollWidth > window.innerWidth,
  }))
  check(
    // §9-1：无深链的默认落点 = 桌面
    '工作台默认 = 桌面（信息墙网格 + 应用图标）',
    pageShape.toolPage === 'dashboard' &&
      pageShape.grid >= 1 &&
      pageShape.cards >= 5 &&
      pageShape.icons >= 1 &&
      pageShape.hOverflow === false,
    JSON.stringify(pageShape),
  )

  // 1e) 阶段 B：桌面图标与清单对账 + 点击达面板 + 侧栏「信息墙」退役（B2/B4）
  // 图标现在是分页网格里的 1×1 项 —— 对账要**逐页累加唯一 id**，且不应再有 Dock 岛。
  const iconReconcile = await (async () => {
    const parse = async (res) => {
      try {
        return await res.json()
      } catch {
        return null
      }
    }
    const tools = (await parse(await fetch(`${URL}api/tools`)))?.tools ?? []
    const appsList = await parse(await fetch(`${URL}api/apps`))
    // 桌面图标 = 工具（去 dashboard）+ Mac 应用 + 库里的 HTML 胶囊（Dashboard 的 iconTiles 三源合一）
    const capsList = await parse(await fetch(`${URL}api/capsules`))
    const expected =
      tools.filter((t) => t.id !== 'dashboard').length +
      (appsList?.apps ?? []).length +
      (capsList?.capsules ?? []).length
    await page.waitForSelector('[data-wall-pager]', { timeout: 10000 })
    const pages = Number(await page.getAttribute('[data-wall-pager]', 'data-pages')) || 1
    const seen = new Set()
    let toolIcons = 0
    let appIcons = 0
    let capsuleIcons = 0
    let docks = 0
    for (let i = 0; i < pages; i += 1) {
      if (i > 0) {
        const dot = page.locator(`[data-page-dot="${i}"]`)
        if ((await dot.count()) === 0) break
        await dot.click()
        await page.waitForTimeout(250)
      }
      const per = await page.evaluate(() => {
        const icons = [...document.querySelectorAll('main [data-icon-tile]')]
        return {
          ids: icons.map((x) => x.dataset.iconTile),
          tools: icons.filter((x) => x.dataset.iconKind === 'tool').length,
          apps: icons.filter((x) => x.dataset.iconKind === 'app').length,
          capsules: icons.filter((x) => x.dataset.iconKind === 'capsule').length,
          docks: document.querySelectorAll('[data-wall-dock],[data-dock-tile]').length,
          inGrid: icons.every((x) => !!x.closest('[data-wall-item]')),
        }
      })
      per.ids.forEach((id) => id && seen.add(id))
      toolIcons += per.tools
      appIcons += per.apps
      capsuleIcons += per.capsules
      docks = Math.max(docks, per.docks)
    }
    if (pages > 1 && (await page.locator('[data-page-dot="0"]').count()) > 0) {
      await page.locator('[data-page-dot="0"]').click()
      await page.waitForTimeout(250)
    }
    return { expected, actual: seen.size, toolIcons, appIcons, capsuleIcons, docks, pages }
  })()
  check(
    '桌面图标与清单对账（/api/tools 去 dashboard + /api/apps == 图标数）',
    iconReconcile.expected === iconReconcile.actual &&
      iconReconcile.actual >= 1 &&
      iconReconcile.docks === 0,
    JSON.stringify(iconReconcile),
  )

  // 点工具图标 = 拉起主页面（§4.2）：工作台原地换页，不整页重载。
  // 工具图标的 kind 是 `app`、id 是 `tool:<工具 id>`（Dashboard 的 iconTiles 约定）；
  // 它们可能分布在不同页，所以逐页找第一个，别用 `data-icon-kind="tool"` 这种不存在的取值。
  const toolIcon = await (async () => {
    const pages = Number(await page.getAttribute('[data-wall-pager]', 'data-pages')) || 1
    for (let i = 0; i < pages; i += 1) {
      if (i > 0) {
        const dot = page.locator(`[data-page-dot="${i}"]`)
        if ((await dot.count()) === 0) break
        await dot.click()
        await page.waitForTimeout(250)
      }
      const count = await page.locator('main [data-icon-tile][data-icon-tile^="tool:"]').count()
      if (count > 0) return { count, page: i }
    }
    return { count: 0, page: -1 }
  })()
  check('桌面上有工具图标（可以点进工具主页面）', toolIcon.count > 0, JSON.stringify(toolIcon))
  await page.click('main [data-icon-tile][data-icon-tile^="tool:"]', { timeout: 10000 })
  const afterIconClick = await page.getAttribute('main [data-tool-page]', 'data-tool-page', {
    timeout: 10000,
  })
  check(
    '点工具图标 → 工作台拉起该工具主页面（不是桌面）',
    !!afterIconClick && afterIconClick !== 'dashboard',
    `toolPage=${afterIconClick}`,
  )

  const retireInfo = await page.evaluate(() => ({
    desktopEntry: !!document.querySelector('aside [data-nav-desktop]'),
    // 工具清单（nav）里不该再有 dashboard 的「信息墙」条目（D2 可见清单退役）。
    // 判据按按钮 title 的「名字 · 状态」前缀，别用 textContent 子串：新工具的状态文案里
    // 出现「信息墙」三个字就会假阳性（AGENTS.md「读侧栏描述会假阳性」同款教训）。
    navWall: [...document.querySelectorAll('aside nav button')].some((b) =>
      (b.getAttribute('title') ?? '').startsWith('信息墙 ·'),
    ),
  }))
  check(
    '侧栏顶部有「桌面」入口且工具清单里没有信息墙条目（D2 退役）',
    retireInfo.desktopEntry && !retireInfo.navWall,
    JSON.stringify(retireInfo),
  )

  // 侧栏切页 = 真换页：上一页整个卸载，不是在一张长页面上滚到别的位置
  await clickTool('RSS')
  await waitMain(/RSS/i)
  const switched = await page.evaluate(() => ({
    toolPage: document.querySelector('main [data-tool-page]')?.getAttribute('data-tool-page') ?? '',
    title: document.querySelector('main h1')?.innerText.trim() ?? '',
  }))
  check(
    '切侧栏 = 真换页（RSS 页挂上、页面标题跟着换）',
    switched.toolPage === 'rss' && /RSS/i.test(switched.title),
    JSON.stringify(switched),
  )

  // 6) Rclone 磁盘面板（LV 内存盘已下线，§3.34）
  await clickTool('Rclone')
  // 等配置路径真正渲染出来：只匹配 rclone 会读到页头就返回，后面的断言拿到的是半屏快照
  let t = await waitMain(/配置里的远端/)
  check('Rclone 面板渲染（状态 + rclone 版本 + 配置文件路径）', /Rclone 磁盘|Rclone disks|已挂|未挂载/.test(t) && /配置里的远端/.test(t), t.split('\n').slice(0, 2).join(' '))
  check(
    'Rclone 显示配置里的远端或空状态',
    /挂载|没有远端|未挂载/.test(t),
    t.split('\n').slice(0, 3).join(' '),
  )
  check('Rclone 不泄露密码字段', !/password|密码\s*[:=]\s*\S/.test(t))

  // 挂载表单长什么样：只有「挂载点（+ 需要时给密码）+ 更多参数」；缓存与只读不再让用户选
  // （缓存是常设 writes、想改走「更多参数」）。没有「挂载」按钮就说明现在都挂着，跳过。
  const mountBtn = main().locator('button', { hasText: /^挂载$/ }).first()
  // 远端行是异步来的：先等按钮出现（最多 8s），否则这条断言会因为「面板还没渲染完」而空过
  for (let i = 0; i < 32 && (await mountBtn.count()) === 0; i++) await page.waitForTimeout(250)
  if ((await mountBtn.count()) > 0) {
    await mountBtn.click()
    t = await waitMain(/更多参数/)
    check(
      'Rclone 挂载表单：有「更多参数」透传输入，不再让选缓存/只读、不收 obscured 值',
      /更多参数/.test(t) &&
        /缓存模式固定/.test(t) &&
        !/只读挂载/.test(t) &&
        !/已是算好的 obscured/.test(t),
      t.split('\n').filter((l) => /更多参数|缓存模式固定|只读/.test(l)).join(' | ').slice(0, 120),
    )
    await main().locator('button', { hasText: /^取消$/ }).first().click()
  } else {
    // 只有「所有远端都挂着」才是合理的不出现；其它情况（有没挂的远端却没按钮）是真问题
    const allMounted =
      /已挂 \d+ 个/.test(t) && (await main().locator('button', { hasText: /^卸载$/ }).count()) > 0
    check(
      allMounted
        ? 'Rclone 挂载表单：现在都挂着，没有可挂的远端（跳过）'
        : 'Rclone 挂载表单：没挂载却没出现「挂载」按钮（面板少控件？）',
      allMounted,
      t.slice(0, 110).replace(/\n/g, ' '),
    )
  }

  // 私密编辑器面板已整体下线（§3.31）。

  // 7b) 单文件 HTML 工具（/api/htmltool + yhubStore 存档）已下线：那是「导入清单」那套机制，
  //     现在库里一个目录里的每个 .html 由后端按 /apps/<路径> 托管，契约由
  //     packaging/verify-backend.sh 在临时目录里全量断言（这里不再重复测后端）。
  const base = URL.replace(/\/?$/, '/')

  // 7d) RSS 订阅：面板 = 一源一行；没订阅时给空态引导（这一段**只读**，真实配置一个字不写）
  await clickTool('RSS')
  // 等"加载中…"换成"N 个源"（或空态）再数行：只匹配介绍文案会读到还没加载完的 0 行。
  t = await waitMain(/个源 · 一个源一个信息墙格子|还没有订阅/)
  const rssPanel = await page.evaluate(() => ({
    panel: document.querySelectorAll('main [data-testid="rss-panel"]').length,
    addForm: document.querySelectorAll('main [data-rss-add] input[data-rss-new-url]').length,
    feeds: document.querySelectorAll('main [data-rss-feed]').length,
    empty: /还没有订阅/.test(document.querySelector('main')?.innerText ?? ''),
    // 每行都必须能改地址（编辑按钮），这是「每一个都可以设置 rss 地址」的落点
    editButtons: document.querySelectorAll('main [data-rss-edit]').length,
  }))
  check(
    'RSS 面板：有新增表单，每个源一行且都能改地址',
    rssPanel.panel === 1 && rssPanel.addForm === 1
      && (rssPanel.feeds === 0 ? rssPanel.empty : rssPanel.editButtons === rssPanel.feeds),
    JSON.stringify(rssPanel),
  )
  check(
    'RSS 面板：地址输入框可编辑（不写配置，只验控件在）',
    await page.locator('main [data-rss-new-url]').isEditable(),
  )

  // 7e) 设置界面：入口 / 分类导航 / 分区内容 / ESC 返回
  //     这一组只断言"与运行环境无关"的行为（浏览器态 isTauri()=false，写操作被拒绝并如实提示）
  const workbenchNav = (await page.locator('aside button').allInnerTexts()).join(' | ')
  check('工作台侧栏有设置入口', /设置/.test(workbenchNav), workbenchNav.replace(/\n/g, ' '))

  await clickTool('设置')
  let s = await waitMain(/当前配置速览/)
  const settingsNav = (await page.locator('aside button').allInnerTexts()).join(' | ')
  check(
    '设置界面：左侧分类导航',
    ['通用', '热键', '托盘'].every((name) => settingsNav.includes(name)),
    settingsNav.replace(/\n/g, ' '),
  )
  check('通用分区渲染配置信息', /设置版本/.test(s) && /配置文件/.test(s), s.split('\n')[0])
  check('浏览器态如实提示只读', /浏览器预览态/.test(s))

  await page.locator('aside button', { hasText: '托盘' }).first().click()
  s = await waitMain(/窗口与菜单栏/)
  check(
    '分类切换：托盘分区显示已实现的三张卡片',
    /窗口与菜单栏/.test(s) && /图标点击行为/.test(s) && /托盘菜单入口/.test(s),
    s.split('\n').slice(0, 2).join(' '),
  )
  check(
    '托盘分区不再显示占位（控件已实现）',
    !/本节控件尚未实现/.test(s),
    s.split('\n').slice(0, 2).join(' '),
  )
  check(
    '托盘分区说明关窗 / 点击行为与托盘菜单入口',
    /关窗行为/.test(s) &&
      /右键始终弹出菜单/.test(s) &&
      /显示面板/.test(s) &&
      /设置…/.test(s) &&
      /退出 Y-Hub/.test(s),
    s.split('\n').slice(0, 2).join(' '),
  )
  check('托盘分区如实提示浏览器态只读', /浏览器预览态/.test(s))
  check(
    '托盘菜单入口列出「打开桌面网页」（托盘形态的网页入口）',
    /打开桌面网页/.test(s) && /127\.0\.0\.1:8790/.test(s),
    s.replace(/\s+/g, ' ').slice(0, 200),
  )

  // ESC 返回上一个界面（与左上角「返回」按钮同一条路径）
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  const backNav = (await page.locator('aside button').allInnerTexts()).join(' | ')
  check('ESC 从设置返回工作台', /Rclone|RSS|Scheduler/.test(backNav) && /设置/.test(backNav), backNav.replace(/\n/g, ' '))

  // 深链：?view=settings&section=hotkeys 直接打开指定分区
  await page.goto(`${URL}?view=settings&section=hotkeys`, { waitUntil: 'networkidle' })
  s = await waitMain(/全局快捷键/)
  check(
    '设置深链直达热键分区',
    /全局快捷键/.test(s) && /组合键/.test(s),
    s.split('\n')[0],
  )
  // 浏览器态现在也能读到动作表（走 /api/settings 的 schema）：可以看、不能存 ——
  // 判据是「动作表真渲染出来 + 保存被拒的说明在场」，不再是「读不到」。
  check(
    '热键分区在浏览器态如实展示动作表，并说明不能保存',
    // 动作表渲染出来了；浏览器态没有写入通道，录制按钮被禁用（aria-disabled / disabled）
    /呼出 \/ 收起面板|Show \/ hide panel/i.test(s) &&
      (await page.locator('main button[disabled]', { hasText: '重录' }).count()) > 0,
    s.replace(/\s+/g, ' ').slice(0, 120),
  )

  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForSelector('aside button', { timeout: 10000 })

  // 8) 深链：/apps/<工具 id> 直达工具页（给热键 / 脚本用）
  await page.goto(`${URL}apps/rclone`, { waitUntil: 'networkidle' })
  t = await waitMain(/Rclone|rclone/)
  const deepTool = await page.getAttribute('main [data-tool-page]', 'data-tool-page')
  check('深链直达工具页', deepTool === 'rclone' && /Rclone|rclone/.test(t), `toolPage=${deepTool}`)

  // 9) 信息墙（M1~M6 面板）—— 这是**工作台形态**：/?tool=dashboard 是
  //    信息墙工具页，格子铺成便当网格（便当布局现在只属于这个模块）。
  //    走深链直达：侧栏有没有「桌面」取决于后端适配器是否已注册，这里不作依赖。
  //    标题随 D7 改名为「桌面」（原「信息墙」），断言跟界面走。
  await page.goto(`${URL}?tool=dashboard`, { waitUntil: 'networkidle' })
  t = await waitMain(/桌面/)
  check(
    '桌面面板渲染（标题 + 手动刷新入口）',
    // 手动刷新现在是图标按钮（aria-label + title 仍是「手动刷新」），正文里不会再出现这四个字
    /桌面/.test(t) &&
      (await page.locator('main [title="手动刷新"]').count()) > 0,
    t.split('\n').slice(0, 3).join(' '),
  )

  // 9a) 面板形态的网页入口：墙头「浏览器打开」点下去要真的开一个新标签页直达信息墙**独立页**
  //     （托盘形态的入口是 tray.rs 的右键菜单，那一项由 AX 读菜单名验证）
  check('信息墙面板带「浏览器打开」入口（面板形态的网页入口）', /浏览器打开/.test(t), t.replace(/\s+/g, ' ').slice(0, 160))
  let openUrl = ''
  try {
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 10000 }),
      page.locator('main button', { hasText: '浏览器打开' }).first().click({ timeout: 10000 }),
    ])
    openUrl = popup.url()
    await popup.close()
  } catch (e) {
    openUrl = `点击未打开新标签页：${String(e).slice(0, 120)}`
  }
  check(
    '点「浏览器打开」→ 新标签页直达信息墙独立页 /?view=wall',
    openUrl.includes('view=wall'),
    openUrl,
  )

  // 9b) 信息墙独立页（/?view=wall）：**只放信息墙** —— 副屏全屏看的就是这一页。
  //     这一组是回归线：入口以前开的是工作台，屏幕上跟着一整排小工具卡。
  await page.goto(`${URL}?view=wall`, { waitUntil: 'networkidle' })
  t = await waitMain(/桌面/)
  check(
    '独立页渲染桌面（可见标题 + 手动刷新）',
    // 手动刷新现在是图标按钮（aria-label + title 仍是「手动刷新」），正文里不会再出现这四个字
    /桌面/.test(t) &&
      (await page.locator('main [title="手动刷新"]').count()) > 0,
    t.replace(/\s+/g, ' ').slice(0, 140),
  )
  const wallInfo = await page.evaluate(() => {
    const m = document.querySelector('main')
    // 阶段 C：独立页 = 桌面全屏（分页墙 + 图标，分区头已删）。图标标签里合法出现工具名，
    // 扫「有没有漏进工作台入口」时逐块剔掉图标文本再比。
    let text = m?.innerText ?? ''
    for (const tile of document.querySelectorAll('[data-icon-tile]')) {
      text = text.split(tile.innerText).join('')
    }
    return {
      wallRoot: !!document.querySelector('main[data-wall-page]'),
      aside: !!document.querySelector('aside'),
      bentoGrid: !!document.querySelector('.bento-grid'),
      cards: document.querySelectorAll('.bento-card').length,
      otherTools: ['Rclone', 'RSS', 'Scheduler', '工作台', '设置'].filter((n) =>
        text.includes(n),
      ),
      webOpenBtn: [...document.querySelectorAll('main button')].some((b) =>
        (b.textContent ?? '').includes('浏览器打开'),
      ),
      hOverflow: document.documentElement.scrollWidth > window.innerWidth,
    }
  })
  check(
    '独立页没有侧栏、没有工具卡，格子铺成便当网格（整页只有墙）',
    wallInfo.wallRoot && !wallInfo.aside && wallInfo.bentoGrid && wallInfo.cards >= 3,
    JSON.stringify(wallInfo),
  )
  check(
    '独立页正文里不出现其它小工具 / 工作台入口（应用图标除外）',
    wallInfo.otherTools.length === 0,
    wallInfo.otherTools.join(' '),
  )
  // `?view=wall` 已统一成「侧边栏折叠的桌面视图」（见 App.tsx 的 wall 兼容模式），
  // 不再是完全独立的裸页 —— 它仍然是一个工作台页面，所以「浏览器打开」按钮留着是对的。
  check(
    '桌面视图（?view=wall）是折叠侧栏的工作台页，仍可「浏览器打开」',
    wallInfo.wallRoot && wallInfo.webOpenBtn === true,
    JSON.stringify({ wallRoot: wallInfo.wallRoot, webOpenBtn: wallInfo.webOpenBtn }),
  )
  check('独立页不横向溢出', wallInfo.hOverflow === false, JSON.stringify(wallInfo))

  // 接口就绪 → 断言真实数据；接口未就绪 → 断言如实报错（不白屏、不编数据）
  const cellsRes = await fetch(`${base}api/dashboard/cells`)
  let cellsBody = null
  try {
    cellsBody = await cellsRes.json()
  } catch {
    cellsBody = null
  }
  if (cellsRes.status === 200 && Array.isArray(cellsBody?.cells)) {
    const shown = cellsBody.cells.filter((c) => c.enabled)

    // 阶段 F7：**按插件对账**（plan §5 F7）——格子不再按「中心 15 格」数，而是跟
    // /api/plugins 里的 tiles 声明逐一对账：每个声明的格子在墙上恰好一次、墙上没有
    // 「野生格子」；宿主通知瓦片 overview.alerts 是唯一不由插件声明的格子（F5 宿主常驻）。
    {
      const pluginsRes = await fetch(`${base}api/plugins`)
      let pluginsBody = null
      try { pluginsBody = await pluginsRes.json() } catch { pluginsBody = null }
      const declared = (pluginsBody?.plugins ?? []).flatMap((p) => p.tiles ?? [])
      const cellIds = cellsBody.cells.map((c) => c.id)
      const HOST = 'overview.alerts'
      const dupIds = cellIds.filter((id, i) => cellIds.indexOf(id) !== i)
      const undeclared = cellIds.filter((id) => id !== HOST && !declared.includes(id))
      const missing = declared.filter((id) => !cellIds.includes(id))
      const hosts = cellIds.filter((id) => id === HOST).length
      check(
        '按插件对账：每格都有产地声明、每个声明的格恰好一次（宿主通知瓦片除外）',
        dupIds.length === 0 && undeclared.length === 0 && missing.length === 0 && hosts === 1,
        JSON.stringify({ cells: cellIds.length, declared: declared.length, hosts, dupIds, undeclared, missing }),
      )
    }
    if (shown.length > 0) {
      const first = shown.find((c) => c.id !== 'overview.alerts') ?? shown[0]
      const esc = String(first.title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      t = await waitMain(new RegExp(esc))
      check('信息墙渲染真实格子（格子标题出现在 <main>）', t.includes(first.title), `${first.id} · ${first.title}`)
      const allOk = shown.every((c) => c.status === 'ok')
      if (allOk && shown.some((c) => c.id === 'overview.alerts')) {
        check('全绿时总览格出现「一切正常」', /一切正常/.test(t), t.replace(/\s+/g, ' ').slice(0, 120))
      } else {
        check('存在非 ok 格时总览不显示假绿（无「一切正常」）', !/一切正常/.test(t), t.replace(/\s+/g, ' ').slice(0, 120))
      }
      const hrefs = await page
        .locator('main [data-cell] a[href]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('href')))
      check(
        '格子可点 = 深链（<a href> 存在，不是按钮假链接）',
        hrefs.some((h) => h && h !== '#'),
        hrefs.slice(0, 3).join(' | '),
      )
      // 墙头计数必须跟异常总览格对齐：两边都只数上游格（不含聚合格自己），
      // 且「非 ok 或非 fresh」都算异常（契约 §6.5）。以前墙头多数了聚合格自己，写 7 而格里写 6。
      //
      // 比对必须「同一快照内」：DOM 是页面自己那次 fetch 的快照，下面的 shown 又是
      // smoke 另发的一次 fetch。两次之间只要撞上一次刷新（冷启动后头几十秒尤其容易，
      // 2026-09-25 22:08 实测 DOM 8 格 / 新 fetch 6 格），数字本来就该不同 —— 拿它们互比
      // 会把「测试自己跨快照」误报成产品缺陷。所以拆成两对同源比对：
      //   前端对 = 墙头 vs 异常总览格（都从同一段 DOM 文本 t 里取）；
      //   后端对 = 聚合格 summary vs smoke 自己那次 fetch 的上游计数。
      const flagged = shown.filter(
        (c) => c.id !== 'overview.alerts' && (c.status !== 'ok' || c.staleness !== 'fresh'),
      )
      const headN = /·\s*(\d+)\s*格异常/.exec(t)?.[1]
      // 聚合格的 title/summary 由数据源决定（本机配置可能是中文或英文），从它自己的 DOM 文本
      // 与接口 summary 里取数字，别写死「异常总览 / 格异常」这类文案。
      const tileText = await page
        .locator('main [data-cell="overview.alerts"]')
        .innerText()
        .catch(() => '')
      const tileCount = (text) =>
        /(\d+)\s*(?:格异常|cells need attention)/i.exec(text)?.[1]
      const domTileN = tileCount(tileText)
      const tileSummary = shown.find((c) => c.id === 'overview.alerts')?.summary ?? ''
      const apiTileN = tileCount(tileSummary)
      if (headN !== undefined) {
        check(
          '墙头计数 == 异常总览格计数（页面同一快照，都不含聚合格自己）',
          Number(headN) === Number(domTileN),
          `head=${headN} domTile=${domTileN}`,
        )
      } else {
        check('全绿时墙头写「全部正常」', /全部正常/.test(t), t.replace(/\s+/g, ' ').slice(0, 120))
      }
      if (flagged.length > 0) {
        check(
          '接口侧聚合格计数 == 接口侧上游异常格数（同一快照）',
          Number(apiTileN) === flagged.length,
          `tile=${apiTileN} flagged=${flagged.length}`,
        )
      } else {
        check('接口全绿时聚合格写「一切正常」', /一切正常/.test(tileSummary), tileSummary)
      }
    } else {
      // 200 + total: 0 = 空态（不是错误、不是加载态）
      t = await waitMain(/还没有格子/)
      check('信息墙空态（total: 0 → 明确提示而非报错）', /还没有格子/.test(t), t.replace(/\s+/g, ' ').slice(0, 120))
    }
  } else {
    // 后端还没提供 /api/dashboard/*（后端卡尚未合并）：面板必须自己灰一块并给出怎么办
    check(
      '信息墙接口未就绪时如实进入错误态（不白屏、不编数据）',
      /HTTP 404|HTTP \d{3}|连不上|失败/.test(t),
      t.replace(/\s+/g, ' ').slice(0, 160),
    )
  }

  // 9c) 定时任务（cron 式调度）：调度状态正常展示
  await page.goto(`${URL}?tool=scheduler`, { waitUntil: 'networkidle' })
  t = await waitMain(/定时任务/)
  check(
    '定时任务面板渲染（调度状态正常展示）',
    /定时任务/.test(t) && /调度中|调度已关闭/.test(t),
    t.replace(/\s+/g, ' ').slice(0, 160),
  )

  const jobCell = await page.evaluate(() => {
    const el = document.querySelector('main [data-testid="scheduler-job"]')
    if (!el) return null
    return {
      id: el.getAttribute('data-job') ?? '',
      text: (el.innerText ?? '').replace(/\s+/g, ' ').slice(0, 220),
    }
  })
  if (jobCell) {
    check(
      '任务卡带任务 id + 上次运行 + 下次时间（信息墙格子的同一份状态）',
      jobCell.id.length > 0 && /上次运行：/.test(jobCell.text) && /下次：/.test(jobCell.text),
      JSON.stringify(jobCell),
    )
    const runBtn = page.locator('main [data-testid="scheduler-job"] button', { hasText: '立即运行' }).first()
    let ranNow = '按钮不可用（任务没就绪）'
    if (await runBtn.isEnabled().catch(() => false)) {
      await runBtn.click()
      try {
        t = await waitMain(/跑完了|没跑成/, 120000)
        ranNow = (t.match(/[^\n]*(跑完了|没跑成)[^\n]*/) ?? [''])[0].slice(0, 160)
      } catch (e) {
        ranNow = String(e).slice(0, 160)
      }
    }
    check('点「立即运行」真跑一次并在面板留痕', /跑完了|没跑成/.test(ranNow), ranNow)
  }

  await page.goto(`${URL}?view=wall`, { waitUntil: 'networkidle' })
  await waitMain(/桌面/)

  // 阶段 F5：宿主通知瓦片（overview.alerts）恒在第 1 页 —— 跨插件聚合不属于任何插件，
  // 由宿主常驻提供（plan §5 F5/D7 ③）；默认摆放把它排最前，只渲染当前页时第 2 页起不许再出现。
  {
    const dots = await page.locator('[data-page-dot]').count()
    // 一页装得下的墙没有页点（干净安装就是这样）：此时第 1 页 = 唯一那页，别去点不存在的点
    const onDot = async (i) => {
      if (dots === 0) return page.locator('main [data-bento-card="overview.alerts"]').count()
      await page.click(`[data-page-dot="${i}"]`)
      await page.waitForTimeout(250)
      return page.locator('main [data-bento-card="overview.alerts"]').count()
    }
    const onPage1 = await onDot(0)
    const onPage2 = dots > 1 ? await onDot(1) : 0
    if (dots > 1) await onDot(0) // 回到第 1 页，别影响后面的逐页找格子
    check(
      '阶段 F5：宿主通知瓦片恒在第 1 页（第 2 页起不再出现）',
      onPage1 === 1 && onPage2 === 0,
      JSON.stringify({ dots, onPage1, onPage2 }),
    )
  }


  // 10) 桌面偏好：外观 / 排布（「自定义」弹层）+ 尺寸 / 显隐（编辑态）—— 全存 localStorage，刷新后还在。
  //     分工是刻意收过的：「自定义」只留全局项，逐格清单已删（与组件库、尺寸磁贴三处重复）。
  //     改动最后会「恢复默认」，不给无 JS 报错那条断言留脏状态。
  //     控件挂在**信息墙墙头**的弹层上（data-pref-*，便当布局只服务这面墙），所以这一段走 ?tool=dashboard。
  await page.goto(`${URL}?tool=dashboard`, { waitUntil: 'networkidle' })
  await page.waitForSelector('main [data-pref-trigger]', { timeout: 10000 })
  await page.waitForSelector('main [data-bento-card]', { timeout: 15000 })
  const themeOf = () => page.evaluate(() => document.documentElement.dataset.theme || 'dark')
  const cardBgLum = async () =>
    page.evaluate(() => {
      const el = document.querySelector('main')
      const parts = (el ? getComputedStyle(el).backgroundColor : 'rgb(0,0,0)').match(/\d+/g) ?? ['0', '0', '0']
      const [r, g, b] = parts.map(Number)
      return Math.round((r + g + b) / 3)
    })
  // 挑一个非总览的格子做尺寸/显隐实验：格子清单是配置驱动的（cron.<任务> 这类动态格），
  // 写死某个 id 会在换机器 / 改 dashboard.json 后变成假红。
  const targetId = await page.evaluate(() => {
    // 只挑**格子**（带 data-cell）：图标固定 1×1，不参与尺寸/显隐实验
    const cards = [...document.querySelectorAll('main [data-bento-card]')]
    const c =
      cards.find((el) => el.dataset.cell !== undefined && el.dataset.bentoCard !== 'overview.alerts') ??
      cards.find((el) => el.dataset.cell !== undefined) ??
      cards[0]
    return c?.dataset.bentoCard ?? ''
  })
  // 默认尺寸分三类：总览通栏 / 图标 1×1 / 其余格子 2×1（目标挑到图标是常态：页 1 总览之后是图标流）
  const targetDefault =
    targetId === 'overview.alerts' ? 'full' : targetId.includes(':') ? 'sm' : 'md'
  const cellSpan = () => page.getAttribute(`main [data-bento-card="${targetId}"]`, 'data-bento-span')
  const cellCount = () => page.locator('main [data-bento-card]').count()
  const openCustomize = async () => {
    await page.locator('main [data-pref-trigger]').click()
    await page.waitForSelector('main [data-pref-panel]', { timeout: 5000 })
  }

  check(
    '自定义入口默认收起 + 无偏好 = 深色基线（html[data-theme]）',
    (await themeOf()) === 'dark' && (await page.locator('main [data-pref-panel]').count()) === 0,
    await themeOf(),
  )

  await openCustomize()
  const prefCount = await page.locator('main [data-pref-panel]').evaluate((el) => ({
    themes: el.querySelectorAll('[data-pref-theme]').length,
    packing: el.querySelectorAll('[data-pref-packing]').length,
    // 逐格清单必须**不存在**：显隐归组件库、尺寸归 ⤢ 磁贴，弹层再列一份就是三处重复
    sizes: el.querySelectorAll('[data-pref-size]').length,
    hides: el.querySelectorAll('[data-pref-hide]').length,
  }))
  check(
    '自定义弹层：只有全局项（外观两档 + 排布两档），不再列逐格清单',
    prefCount.themes === 2 && prefCount.packing === 2 && prefCount.sizes === 0 && prefCount.hides === 0,
    JSON.stringify(prefCount),
  )

  // 外观深 → 浅：html 属性翻转、内容区底色变浅、被桥接的侧栏文字同步变深
  const lumBefore = await cardBgLum()
  const navDark = () =>
    page.evaluate(() => {
      // 侧栏「设置」入口在顶部分组里，不在 <nav> 内：取侧栏里第一个导航项即可
      const el = document.querySelector('aside .ui-nav__item')
      if (!el) return false
      const parts = getComputedStyle(el).color.match(/\d+/g) ?? ['255', '255', '255']
      const [r, g, b] = parts.map(Number)
      return r + g + b < 400 // 深字（#3f3f46 这一档）才算桥接成功
    })
  await page.locator('main [data-pref-theme="light"]').click()
  await page.waitForTimeout(200)
  const lumAfter = await cardBgLum()
  check(
    '切「浅色」：html[data-theme=light]，内容区变浅 + 侧栏文字变深（工具类桥接生效）',
    (await themeOf()) === 'light' &&
      lumBefore < 80 &&
      lumAfter > 200 &&
      (await navDark()),
    `bg ${lumBefore} → ${lumAfter}`,
  )

  // ESC 只关弹层（不把工作台退回启动器、不离开信息墙页），刷新后主题还在
  await page.keyboard.press('Escape')
  check(
    'ESC 只关自定义弹层，信息墙工具页原样留着',
    (await page.locator('main [data-pref-panel]').count()) === 0 &&
      (await page.locator('main [data-tool-page="dashboard"]').count()) === 1,
  )
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('main [data-pref-trigger]', { timeout: 10000 })
  check('浅色主题刷新后保留（localStorage 读回）', (await themeOf()) === 'light', await themeOf())

  /** 编辑态是开关式的：按需进/出，别跟后面的步骤抢状态 */
  const setEdit = async (on) => {
    const now = (await page.getAttribute('[data-wall-pager]', 'data-edit-mode')) === '1'
    if (now !== on) {
      await page.locator('main [data-edit-trigger]').click()
      await page.waitForTimeout(400)
    }
  }

  // 每格尺寸（唯一入口 = 编辑态的 ⤢ 尺寸磁贴，P2）：targetId 改成「通栏」→ 网格即时换占位，刷新后还在。
  // （格子没有 1×1 档：12 列下 1/12 宽 ≈ 82px，卡头和正文一起挤爆；图标固定 1×1，没有尺寸菜单）
  const sizeTarget = targetId
  const sizeSpan = () => page.getAttribute(`main [data-bento-card="${sizeTarget}"]`, 'data-bento-span')
  check('尺寸实验有格子可选', !!sizeTarget, String(sizeTarget))
  await setEdit(true)
  await page.locator(`main [data-size-menu="${sizeTarget}"]`).click()
  await page.waitForSelector(`main [data-size-popup="${sizeTarget}"]`, { timeout: 5000 })
  await page.locator(`main [data-size-popup="${sizeTarget}"] [data-size-preset="full"]`).click()
  await page.waitForTimeout(400)
  check(`改尺寸即时生效（${sizeTarget} → 通栏）`, (await sizeSpan()) === 'full', await sizeSpan())
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('main [data-wall-item]', { timeout: 15000 })
  check('尺寸偏好刷新后保留', (await sizeSpan()) === 'full', await sizeSpan())

  // 显隐（唯一入口 = 编辑态的 × 移除，P3）：藏掉一个格子 → 墙上少一张卡；
  // 侧栏是**工具**清单，跟格子显隐无关，一个都不能少
  await setEdit(true)
  const navBefore = await page.locator('aside .ui-nav__item').count()
  const cellsBefore = await cellCount()
  await page.locator(`main [data-remove-handle="${targetId}"]`).click()
  await page.waitForTimeout(500)
  check(
    '隐藏格子：墙上少一张卡，侧栏工具一个不少',
    (await cellCount()) === cellsBefore - 1 &&
      (await page.locator(`main [data-bento-card="${targetId}"]`).count()) === 0 &&
      (await page.locator('aside .ui-nav__item').count()) === navBefore,
    `cells ${cellsBefore} → ${await cellCount()} / nav ${navBefore} → ${await page.locator('aside .ui-nav__item').count()}`,
  )
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('main [data-wall-item]', { timeout: 15000 })
  check(
    '隐藏偏好刷新后保留',
    (await page.locator(`main [data-bento-card="${targetId}"]`).count()) === 0,
  )

  // C5：拖完刷新还在 —— **编辑态**（独立的桌面编辑模式）拖手柄换位 → panelPrefs.layout 落盘
  // → 刷新后坐标不变。挑页内一个 x=0 的小格（图标或信息格）往右拖，避开 targetId。
  //
  // 注意：编辑态与「自定义」弹层是**两件事**（弹层会盖住墙、挡掉手柄的点击，所以拖拽归编辑态管）。
  // 这里要进编辑态，而不是开弹层。
  await page.locator('main [data-edit-trigger]').click()
  await page.waitForSelector('main [data-wall-pager][data-edit-mode="1"]', { timeout: 5000 })
  // P3 起整块可拖（没有单独的 ⠿ 手柄）——从格子**中心**按下去拖，跟真实用户一样
  const dragSpec = await page.evaluate((skip) => {
    const els = [...document.querySelectorAll('[data-wall-item]')].filter((el) => {
      const id = el.getAttribute('data-wall-item') ?? ''
      const [px, x] = (el.getAttribute('data-entry') ?? '').split(',')
      const w = Number((el.getAttribute('data-entry') ?? '').split(',')[3] ?? 0)
      // 通栏项（w = 12）横向拖不动，选它等于「拖了没反应」
      return id !== skip && px === '0' && w <= 6 && el.classList.contains('react-draggable')
    })
    const el = els[0]
    if (!el) return null
    const r = el.getBoundingClientRect()
    const ex = Number((el.getAttribute('data-entry') ?? '').split(',')[1] ?? 0)
    return {
      id: el.getAttribute('data-wall-item'),
      before: el.getAttribute('data-entry'),
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      // 在左半边就往右拖，在右半边就往左拖（往空位走，且不碰视口边缘的翻页热区）
      dx: ex === 0 ? 220 : -220,
    }
  }, targetId)
  if (dragSpec) {
    await page.mouse.move(dragSpec.x, dragSpec.y)
    await page.mouse.down()
    await page.mouse.move(dragSpec.x + (dragSpec.dx ?? 200), dragSpec.y + 30, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(500)
  }
  // 合并后成员当场让位给文件夹块 —— 读属性不能用会等待选择器的 getAttribute，用 evaluate
  const dragAfter = dragSpec
    ? await page.evaluate(
        (id) =>
          document.querySelector(`[data-wall-item="${id}"]`)?.getAttribute('data-entry') ?? null,
        dragSpec.id,
      )
    : null
  // 落点可能是空位（改坐标）也可能是另一个图标（合并成文件夹）——两者都是合法持久态
  const store1 = await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('yhub.panel.prefs') ?? '{}')
    return { layout: p.layout ?? {}, folders: p.folders ?? [] }
  })
  await page.keyboard.press('Escape') // 退出编辑态，别打断后面的恢复默认流程
  await page.waitForTimeout(150)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('main [data-pref-trigger]', { timeout: 10000 })
  const store2 = await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('yhub.panel.prefs') ?? '{}')
    return { layout: p.layout ?? {}, folders: p.folders ?? [] }
  })
  const merged =
    !!dragSpec && store1.folders.some((f) => f.memberIds?.includes(dragSpec.id))
  // 合并分支：成员被收进文件夹 = 拖拽已发生（它的渲染让位给了文件夹块）；普通分支看坐标变化
  let moved = false
  if (dragSpec && merged) {
    moved = true
  } else if (dragSpec && dragAfter && dragAfter !== dragSpec.before) {
    const reloadedEntry = await page.evaluate(
      (id) =>
        document.querySelector(`[data-wall-item="${id}"]`)?.getAttribute('data-entry') ?? null,
      dragSpec.id,
    )
    moved = reloadedEntry === dragAfter
  }
  check(
    'C5 拖完刷新还在（编辑态拖手柄 → layout/folders 落盘 → 刷新后状态一致）',
    !!dragSpec &&
      moved &&
      JSON.stringify(store1.layout) === JSON.stringify(store2.layout) &&
      JSON.stringify(store1.folders) === JSON.stringify(store2.folders),
    JSON.stringify({ dragSpec, dragAfter, merged, keys1: Object.keys(store1.layout).length, keys2: Object.keys(store2.layout).length }),
  )

  // 恢复默认 = 基线：深色 + 登记尺寸 + 格子全回来 + 存储里没残留（layout/folders 一并清）
  await openCustomize()
  await page.locator('main [data-pref-panel] button', { hasText: '恢复默认' }).click()
  await page.waitForTimeout(200)
  const storedPrefs = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('yhub.panel.prefs') ?? 'null')
    } catch {
      return null
    }
  })
  check(
    `恢复默认：深色 + ${targetId} 回登记尺寸 + 被藏的格子回来`,
    (await themeOf()) === 'dark' &&
      (await cellSpan()) === targetDefault &&
      (await page.locator(`main [data-bento-card="${targetId}"]`).count()) === 1,
    JSON.stringify(storedPrefs),
  )
  check(
    '恢复默认后存储里没有残留偏好',
    storedPrefs?.theme === 'dark' &&
      Object.keys(storedPrefs?.sizes ?? {}).length === 0 &&
      (storedPrefs?.hidden ?? []).length === 0,
    JSON.stringify(storedPrefs),
  )

  // 12) 设置面板：网页端也能进入 /settings 读写 settings.json（Obsidian 式统一设置中心）
  //     这一段**只读**：冒烟连的是真实配置，一个字都不写。
  await page.goto(`${URL}settings?section=capsules`, { waitUntil: 'networkidle' })
  const cfgText = await waitMain(/胶囊库|已索引胶囊/)
  check(
    '设置面板：深链 /settings?section=capsules 直接进入胶囊设置分区',
    (await page.locator('main [data-section="capsules"]').count()) === 1,
  )
  // 胶囊库按三态给引导：未配置 → 使用推荐位置；配错 → 创建/重新选择；正常 → 已启用。
  // 冒烟跑在真实配置上，三种都可能出现，所以断言「至少一种引导在场」而不是写死某一种。
  const guide = await page.evaluate(() => {
    const el = document.querySelector('main [data-section="capsules"]')
    const t = el?.innerText ?? ''
    return {
      disabled: /已关闭|打开（默认位置）/.test(t),
      broken: /创建这个目录|重新选择/.test(t),
      ok: /已启用/.test(t),
      manual: /手动填写/.test(t),
    }
  })
  check(
    '设置面板：胶囊库按状态给出引导（已关闭 / 配错 / 正常 至少一种）',
    guide.disabled || guide.broken || guide.ok,
    JSON.stringify(guide),
  )
  // 手动填写是逃生舱：点开后才有输入框，且未改动时「保存」是灰的（draft 逻辑在起作用）
  if (guide.manual) {
    await page
      .locator('main [data-section="capsules"] button', { hasText: '手动填写' })
      .first()
      .click()
      .catch(() => {})
  }
  const saveBtn = page
    .locator('main [data-section="capsules"] button', { hasText: '保存' })
    .first()
  check(
    '设置面板：手动填写可编辑，未改动时「保存」是灰的',
    (await page.locator('main [data-section="capsules"] input[aria-label="胶囊目录路径"]').count()) === 1 &&
      (await saveBtn.count()) > 0 &&
      (await saveBtn.isDisabled()),
  )
  const openButtons = await page
    .locator('main [data-section="capsules"] button', { hasText: '在浏览器打开' })
    .count()
  check(
    '设置面板：胶囊列表正常渲染（有胶囊时有打开按钮，无胶囊时有提示）',
    openButtons > 0 ? true : /还没有胶囊|暂未扫描/.test(cfgText),
    cfgText.replace(/\s+/g, ' ').slice(0, 200),
  )

  // 12b) 导入入口 + 声明式元数据：导入是可选的正门（拖文件进目录照样有效），编辑只写胶囊库不动页面
  const section = page.locator('main [data-section="capsules"]')
  check(
    '设置面板：胶囊库有导入入口（文件选择器只收 .html/.htm）',
    (await section.locator('input[type="file"][accept*=".html"]').count()) === 1,
  )
  if (openButtons > 0) {
    const declared = `冒烟声明名-${Date.now()}`
    await section.locator('button', { hasText: '信息' }).first().click()
    const editor = section.locator('[data-capsule-editor]').first()
    await editor.waitFor({ state: 'visible', timeout: 5000 })
    await editor.locator('input[type="text"]').first().fill(declared)
    await editor.locator('button', { hasText: '保存' }).first().click()
    let afterText = ''
    for (let i = 0; i < 40; i++) {
      afterText = await section.innerText()
      if (afterText.includes(declared)) break
      await page.waitForTimeout(200)
    }
    check(
      '设置面板：编辑胶囊信息 → 覆盖显示名并标为「已自定义」（只进胶囊库，不改页面）',
      afterText.includes(declared) && afterText.includes('已自定义'),
      afterText.replace(/\s+/g, ' ').slice(0, 200),
    )
    // 还原：恢复成页面自己声明的值，列表里不该再出现这个名字
    await section.locator('button', { hasText: '信息' }).first().click()
    const editor2 = section.locator('[data-capsule-editor]').first()
    await editor2.waitFor({ state: 'visible', timeout: 5000 })
    const resetBtn = editor2.locator('button', { hasText: '恢复成页面值' })
    if ((await resetBtn.count()) > 0) {
      await resetBtn.first().click()
    } else {
      // 编辑面板没展开成「有覆盖」形态时直接走接口，避免脏数据留在真实胶囊库里
      await page.evaluate(
        (name) =>
          fetch('/api/capsules/meta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ relpath: name, reset: true }),
          }),
        (vaultCapsules && vaultCapsules[0] && vaultCapsules[0].relpath) || '',
      )
    }
    let revertedText = ''
    for (let i = 0; i < 40; i++) {
      revertedText = await section.innerText()
      if (!revertedText.includes(declared)) break
      await page.waitForTimeout(200)
    }
    check(
      '设置面板：恢复成页面值 → 声明名消失（胶囊清单永远跟着文件走）',
      !revertedText.includes(declared),
      revertedText.replace(/\s+/g, ' ').slice(0, 200),
    )
  }

  // 13) 启动器：capsules_dir 扫出来的 HTML 胶囊自动进搜索列表，搜得到、可跳转到 web 页面
  //     这一态没有 <main>（整页就是启动器），断言读 [data-launcher]；整段**只读**：
  //     不按回车执行，免得冒烟把页面真开出去。先在页面里取 /api/capsules 的清单，再对账。
  const vaultCapsules = await page.evaluate(async () => {
    try {
      const res = await fetch('/api/capsules', { cache: 'no-store' })
      const data = await res.json()
      return Array.isArray(data.capsules)
        ? data.capsules.map((a) => ({
            relpath: a.relpath,
            url_path: a.url_path,
            title: a.title ?? '',
            icon: a.icon ?? '',
            description: a.description ?? '',
          }))
        : null
    } catch {
      return null
    }
  })
  // 上一段停在设置界面：ESC 先「设置 → 工作台」，再按一次才是「工作台 → 启动器」
  // （ESC 的优先级链见 docs/gui-development.md §1.2 / App.tsx 的 handleKeyDown）
  await page.waitForSelector('[data-settings-view]', { timeout: 10000 })
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-settings-view]', { state: 'detached', timeout: 10000 })
  await page.keyboard.press('Escape') // 工作台 → 启动器
  await page.waitForSelector('[data-launcher]', { timeout: 10000 })
  let launcherText = ''
  // 等底栏计数**与接口一致**再断言（首帧 footer 是 0，抢跑会读到旧值）
  const wantFooter = Array.isArray(vaultCapsules) ? `胶囊 ${vaultCapsules.length}` : null
  for (let i = 0; i < 40; i++) {
    launcherText = await page.locator('[data-launcher]').innerText()
    if (wantFooter ? launcherText.includes(wantFooter) : /胶囊 \d+/.test(launcherText)) break
    await page.waitForTimeout(250) // 等启动器把 /api/capsules 拉回来
  }
  const vaultRows = await page.locator('[data-item-type="vault_capsule"]').count()
  check(
    '启动器：HTML 胶囊混进搜索列表（条数与 /api/capsules 一致）',
    Array.isArray(vaultCapsules) && vaultRows === vaultCapsules.length,
    `界面 ${vaultRows} 条 / 接口 ${Array.isArray(vaultCapsules) ? vaultCapsules.length : '取不到'}`,
  )
  check(
    '启动器：底栏如实报「胶囊 N」（放进去就出现的那条计数）',
    Array.isArray(vaultCapsules) && launcherText.includes(`胶囊 ${vaultCapsules.length}`),
    launcherText.replace(/\s+/g, ' ').slice(-140),
  )

  // 阶段 B（§9-2）：dashboard 从可见清单退役后，搜「桌面」要有直达项
  await page.locator('[data-launcher] input').fill('桌面')
  await page.waitForTimeout(300)
  const desktopRows = await page.locator('[data-item-type="quick_action"]').allInnerTexts()
  check(
    '启动器：搜「桌面」出直达项（打开桌面 —— dashboard 退役后的搜索入口）',
    desktopRows.some((t) => t.includes('打开桌面')),
    desktopRows.join(' | ').replace(/\n/g, ' ').slice(0, 200),
  )
  await page.locator('[data-launcher] input').fill('')
  await page.waitForTimeout(200)

  if (Array.isArray(vaultCapsules) && vaultCapsules.length > 0) {
    const first = vaultCapsules[0]
    const keyword = first.url_path.split('/').filter(Boolean).pop() // 短地址最后一段（如 pinyin；目录型是 chat/ 要滤掉空段）
    await page.locator('[data-launcher] input').fill(keyword)
    await page.waitForTimeout(300)
    const hitTexts = await page.locator('[data-item-type="vault_capsule"]').allInnerTexts()
    const hit = hitTexts.find((t) => t.includes(first.relpath)) ?? ''
    check(
      '启动器：搜名字命中 HTML 胶囊（胶囊 徽标 + 副标题是库内路径）',
      hitTexts.length > 0 && /胶囊/.test(hit) && hit.includes(first.relpath),
      hitTexts.join(' | ').replace(/\n/g, ' ').slice(0, 200),
    )
    // 书签式三件套：接口每条都带 title / icon / description（文件里没写就是空串）
    const metaOk = vaultCapsules.every(
      (a) => typeof a.title === 'string' && typeof a.icon === 'string' && typeof a.description === 'string',
    )
    check(
      '接口：HTML 胶囊有书签式三件套（title/icon/description，缺了也如实给空串）',
      metaOk,
      JSON.stringify(vaultCapsules[0]).slice(0, 180),
    )
    if (first.title) {
      check(
        '启动器：书签名当显示名（<title> 出现在命中行里，不再只显示文件名）',
        hit.includes(first.title),
        hit.replace(/\n/g, ' ').slice(0, 160),
      )
    }
    if (first.icon) {
      const imgCount = await page.locator('[data-item-type="vault_capsule"] img').count()
      check(
        '启动器：书签图标画成 <img>（data:/https 的 src；画不出才退 💊）',
        imgCount > 0,
        `${imgCount} 张图标`,
      )
    }
  } else {
    check(
      '启动器：搜名字命中 HTML 胶囊',
      Array.isArray(vaultCapsules),
      'capsules_dir 为空 / 未配置，本条只验清单取数成功',
    )
  }

  // 13) 插件自带面板：装了带 panel 的插件就必须**真的渲染**出来（不是 iframe 空壳）
  //     没装这类插件时只验「不该出现的占位」不出现——CI 里没有第三方插件，跳过要如实说出来。
  const panelTools = (await fetch(`${URL}api/tools`).then((r) => r.json()).catch(() => null))
    ?.tools?.filter((t) => t.panel) ?? []
  if (!panelTools.length) {
    check('插件面板：未安装带面板的插件（跳过渲染断言）', true, 'no tool declares presentation.panel')
  } else {
    const target = panelTools[0]
    await page.goto(`${URL}?tool=${target.id}`, { waitUntil: 'networkidle' })
    const frame = page.locator('iframe.tool-panel-frame')
    await frame.waitFor({ state: 'visible', timeout: 15000 })
    const src = await frame.getAttribute('src')
    check(
      `插件面板：${target.id} 的 iframe 指向插件自己的 URL`,
      src === target.panel,
      `src=${src} expected=${target.panel}`,
    )
    // 面板内容是插件自己的 HTML：等它把控件或文本画出来，别只验 iframe 存在
    const inner = page.frameLocator('iframe.tool-panel-frame')
    const probe = await inner.locator('body').evaluate((body) => ({
      text: (body.innerText ?? '').trim(),
      controls: body.querySelectorAll('input, textarea, button, select').length,
    }))
    check(
      '插件面板：面板内部真的画出了内容（文本或控件）',
      probe.controls > 0 || probe.text.length > 0,
      `controls=${probe.controls} text=${probe.text.slice(0, 80).replace(/\n/g, ' ')}`,
    )
    check(
      '插件面板：不再显示「这个工具还没有面板」占位',
      !/还没有面板|no panel yet/i.test(await mainText()),
      (await mainText()).slice(0, 120).replace(/\n/g, ' '),
    )
  }

  check('无 JS 运行时报错', errors.length === 0, errors.slice(0, 2).join(' / '))
} catch (e) {
  check('冒烟测试跑完', false, String(e).slice(0, 240))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length ? 1 : 0)
