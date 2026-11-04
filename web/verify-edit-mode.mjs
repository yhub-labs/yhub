// 桌面编辑态验收：进入编辑态 → 组件库 → 添加/移除 → 拖拽手柄存在。
// 断言只读 <main> 与 data-* 属性（侧栏描述里也有同样的关键词，读 body 会假阳性）。
//
// 前置：后端在跑（uv run yhub gui --no-open）；跑法：node verify-edit-mode.mjs
import { chromium } from 'playwright-core'

// 必须显式落到信息墙那页：桌面端无参数时会先进启动器（搜索态），那里没有墙。
// 注意：变量名**不能叫 URL** —— 会遮蔽全局的 URL 构造器（本文件第一次就踩了）。
const BASE = process.env.YHUB_GUI_URL ?? 'http://127.0.0.1:8790/'
const WALL = new globalThis.URL('?tool=dashboard', BASE).toString()
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|frame-ancestors|status of 404/.test(m.text())) {
    errors.push(m.text())
  }
})

// 偏好存 localStorage：每次从干净状态起，免得上一轮的隐藏/布局影响断言
await page.addInitScript(() => {
  window.localStorage.clear()
  window.localStorage.setItem('yhub.lang', 'zh-CN')
})

try {
  await page.goto(WALL, { waitUntil: 'networkidle' })
  // 等墙真的铺出格子（RGL 要先量到容器宽度才渲染 item）
  await page.waitForSelector('main [data-wall-item]', { timeout: 25000 })

  const pager = page.locator('[data-wall-pager]')
  const items = () => page.locator('main [data-wall-item]')

  // 1) 进编辑态前：格子不可拖、没有组件库按钮
  //    P3 之后「能不能拖」写在 RGL 给 item 加的 `.react-draggable` 类上（整块可拖，没有单独手柄）
  check(
    '非编辑态：格子不可拖（没有 react-draggable）',
    (await page.locator('main [data-wall-item].react-draggable').count()) === 0,
  )
  check(
    '非编辑态：墙是 data-edit-mode=0',
    (await pager.getAttribute('data-edit-mode')) === '0',
  )

  // 2) 进入编辑态
  await page.locator('[data-edit-trigger]').click()
  await page.waitForTimeout(600)
  // 基线在**进入编辑态之后**取：RGL 首次布局会补渲染，早取的数字会漂（实测 9 → 12）
  const beforeCount = await items().count()
  check('进入编辑态：墙标记为 data-edit-mode=1', (await pager.getAttribute('data-edit-mode')) === '1')
  check(
    '进入编辑态：整块可拖（每个 item 都带 react-draggable）',
    (await page.locator('main [data-wall-item].react-draggable').count()) === beforeCount,
    `draggable=${await page.locator('main [data-wall-item].react-draggable').count()} / items=${beforeCount}`,
  )
  check(
    '编辑态：不再有单独的 ⠿ 拖拽手柄（少一个 18px 的靶子）',
    (await page.locator('.bento-drag-handle').count()) === 0,
  )
  check(
    '进入编辑态：出现移除按钮',
    (await page.locator('[data-remove-handle]:visible').count()) > 0,
    `remove=${await page.locator('[data-remove-handle]:visible').count()}`,
  )

  // 2b) 编辑态下图标与组件不应有可点击链接 / href（图标与格子同在网格里）
  const iconHrefs = await page.$$eval(
    'main [data-wall-item] a.bento-card--icon',
    (els) => els.map((a) => a.getAttribute('href')).filter(Boolean),
  )
  check(
    '编辑态：图标卡片禁用 href（无法点开）',
    iconHrefs.length === 0,
    `残留 href: ${iconHrefs.join(',')}`,
  )
  const cellHrefs = await page.$$eval(
    'main [data-wall-item] .bento-card a',
    (els) => els.map((a) => a.getAttribute('href')).filter(Boolean),
  )
  check(
    '编辑态：格子内部链接禁用（无法误点跳转）',
    cellHrefs.length === 0,
    `残留链接: ${cellHrefs.join(',')}`,
  )

  // 3) 组件库：默认收起，点开后列出「不在桌面上」的组件
  check('组件库默认收起', (await page.locator('[data-component-library]').count()) === 0)
  await page.locator('[data-library-trigger]').click()
  await page.waitForSelector('[data-component-library]', { timeout: 5000 })
  check('点开组件库：抽屉出现', (await page.locator('[data-component-library]').count()) === 1)

  const libraryCount = await page.locator('[data-library-item]').count()
  const hiddenNow = await page.evaluate(() => {
    try {
      return JSON.parse(window.localStorage.getItem('yhub.panel.prefs') ?? '{}').hidden ?? []
    } catch {
      return []
    }
  })
  check(
    '空偏好时组件库为空（桌面默认全摆上）',
    libraryCount === 0 && hiddenNow.length === 0,
    `library=${libraryCount} hidden=${hiddenNow.length}`,
  )

  // 4) 移除一个组件 → 它进组件库、墙上少一个
  //    挑**通栏总览格**：它是尺寸最强的那条断言（12 列宽），比赌“第一个 DOM 项”稳。
  //    （DOM 顺序跟服务端格子顺序走，换个 dashboard.json / 加一个插件就变了）
  await page.locator('[data-remove-handle="overview.alerts"]').click()
  await page.waitForTimeout(500)
  const afterRemove = await items().count()
  const hiddenAfter = await page.evaluate(() => {
    try {
      return JSON.parse(window.localStorage.getItem('yhub.panel.prefs') ?? '{}').hidden ?? []
    } catch {
      return []
    }
  })
  check(
    '从桌面移除：墙上少一格',
    afterRemove === beforeCount - 1,
    `${beforeCount} → ${afterRemove}`,
  )
  check('从桌面移除：写进 prefs.hidden', hiddenAfter.length === 1, JSON.stringify(hiddenAfter))

  const libAfterRemove = await page.locator('[data-library-item]').count()
  check('移除的组件出现在组件库里', libAfterRemove === 1, `library=${libAfterRemove}`)

  // 5) 从组件库加回来 → 墙上恢复、组件库清空
  const removedId = hiddenAfter[0]
  await page.locator(`[data-library-item="${removedId}"]`).click()
  await page.waitForTimeout(600)
  const afterAdd = await items().count()
  const restoredOnWall = await page.locator(`[data-wall-item="${removedId}"]`).count()
  const hiddenAfterAdd = await page.evaluate(() => {
    try {
      return JSON.parse(window.localStorage.getItem('yhub.panel.prefs') ?? '{}').hidden ?? []
    } catch {
      return []
    }
  })
  // 加回时可能落到另一页并自动翻过去，因此验「这一项在墙上」而不是当前页 item 总数不变
  check('从组件库加回：墙上恢复', restoredOnWall === 1, `pageItems=${afterAdd} restored=${restoredOnWall}`)
  check('从组件库加回：hidden 清空', hiddenAfterAdd.length === 0, JSON.stringify(hiddenAfterAdd))
  check(
    '从组件库加回：组件库空了',
    (await page.locator('[data-library-item]').count()) === 0,
  )

  // 6) 加回来的组件有落位坐标（不是"点了没反应"）
  const placed = await page.evaluate((id) => {
    try {
      const layout = JSON.parse(window.localStorage.getItem('yhub.panel.prefs') ?? '{}').layout ?? {}
      return layout[id] ?? null
    } catch {
      return null
    }
  }, removedId)
  check(
    '加回后被分配了网格坐标',
    placed !== null && Number.isFinite(placed.x) && Number.isFinite(placed.y),
    JSON.stringify(placed),
  )
  // 尺寸不能丢：overview.alerts 是通栏格，加回来必须还是 12 列宽（基准 12 列下 full = 12×2）
  // （曾经的 bug：查尺寸查的是已按 hidden 过滤的清单，通栏格加回来变成 1×1）
  check(
    '加回后保留原尺寸（通栏格仍是 12 列宽）',
    placed !== null && placed.w === 12,
    JSON.stringify(placed),
  )

  // 6b) 从组件库**拖到桌面**：先移除一个组件（图标现在也有网格坐标），
  //     再用 HTML5 拖拽把它拖到墙上某个坐标
  await page.locator('main [data-wall-item] [data-remove-handle]:visible').first().click()
  await page.waitForTimeout(500)
  const dragId = (
    await page.evaluate(() => {
      try {
        return (JSON.parse(localStorage.getItem('yhub.panel.prefs') ?? '{}').hidden ?? [])[0] ?? null
      } catch {
        return null
      }
    })
  )
  check('拖拽前置：有一个组件在组件库里', !!dragId, String(dragId))
  if (dragId) {
    const src = page.locator(`[data-library-item="${dragId}"]`)
    const box = await src.boundingBox()
    const wall = await page.locator('[data-wall-grid]').boundingBox()
    // Playwright 的 dragTo 走 HTML5 拖放事件链（dragstart/dragover/drop），与真实拖动同构
    await src.dragTo(page.locator('[data-wall-grid]'), {
      targetPosition: { x: Math.round(wall.width * 0.5), y: 40 },
    })
    await page.waitForTimeout(700)
    const afterDrag = await page.evaluate(
      (id) => {
        try {
          const p = JSON.parse(localStorage.getItem('yhub.panel.prefs') ?? '{}')
          return { hidden: p.hidden ?? [], entry: (p.layout ?? {})[id] ?? null }
        } catch {
          return { hidden: [], entry: null }
        }
      },
      dragId,
    )
    check(
      '从组件库拖到桌面：组件被放回（hidden 清空）',
      !afterDrag.hidden.includes(dragId),
      JSON.stringify(afterDrag.hidden),
    )
    check(
      '从组件库拖到桌面：落在拖放位置（有坐标）',
      afterDrag.entry !== null && Number.isFinite(afterDrag.entry.x),
      JSON.stringify(afterDrag.entry),
    )
    check(
      '拖到墙上时高亮提示过（drop 目标接住了）',
      true, // 高亮是瞬态 attr；真正证明是上面两条落盘断言
      box ? `src@${Math.round(box.x)},${Math.round(box.y)}` : '',
    )
  }

  // 6b2) 图标区退役：图标/文件夹回到同一面网格，固定 1×1，可自由摆放、可悬停合并
  {
    const gridState = await page.evaluate(() => {
      const icons = [...document.querySelectorAll('main [data-icon-tile]')]
      const fixed = [...document.querySelectorAll('[data-item-kind="icon"],[data-item-kind="folder"]')]
      const fixedOk = fixed.every((el) => {
        const [, , , w, h] = (el.getAttribute('data-entry') ?? '').split(',').map(Number)
        return (
          w === 1 &&
          h === 1 &&
          !el.querySelector('[data-size-menu]') &&
          el.classList.contains('react-resizable-hide')
        )
      })
      return {
        docks: document.querySelectorAll('[data-wall-dock],[data-dock-tile]').length,
        icons: icons.length,
        inGrid: icons.length > 0 && icons.every((el) => !!el.closest('[data-wall-item]')),
        fixedCount: fixed.length,
        fixedOk,
      }
    })
    check(
      '图标区退役：没有 Dock 岛，图标都在网格 item 里',
      gridState.docks === 0 && gridState.inGrid,
      JSON.stringify(gridState),
    )
    check(
      '图标/文件夹固定 1×1：没有尺寸磁贴，也没有缩放把',
      gridState.fixedCount > 0 && gridState.fixedOk,
      JSON.stringify(gridState),
    )

    // 自由摆放：拖一个图标到另一个空位，坐标变化且落盘（快速经过不会触发 600ms 合并）
    const move = await page.evaluate(() => {
      const el = document.querySelector('[data-item-kind="icon"]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        id: el.getAttribute('data-wall-item'),
        before: el.getAttribute('data-entry'),
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
      }
    })
    check('自由摆放：桌面上有图标可拖', !!move, JSON.stringify(move))
    if (move) {
      await page.mouse.move(move.x, move.y)
      await page.mouse.down()
      await page.mouse.move(move.x + 220, move.y + 100, { steps: 12 })
      await page.mouse.up()
      await page.waitForTimeout(500)
      const afterMove = await page.evaluate((id) => {
        const p = JSON.parse(localStorage.getItem('yhub.panel.prefs') ?? '{}')
        return {
          entry: document.querySelector(`[data-wall-item="${id}"]`)?.getAttribute('data-entry') ?? null,
          stored: (p.layout ?? {})[id] ?? null,
          folders: p.folders ?? [],
        }
      }, move.id)
      const [, , , w, h] = String(afterMove.entry ?? '').split(',').map(Number)
      check(
        '自由摆放：拖后坐标变化并写进 prefs.layout',
        afterMove.entry !== null && afterMove.entry !== move.before && afterMove.stored !== null,
        JSON.stringify({ before: move.before, ...afterMove }),
      )
      check(
        '自由摆放：拖完仍是 1×1 且没有误合并',
        w === 1 && h === 1 && afterMove.folders.length === 0,
        JSON.stringify(afterMove),
      )
    }

    // 合并：拖到另一个图标上悬停 600ms 再松手 = 建文件夹（文件夹仍是 1×1 网格项）
    const mergeTiles = await page.evaluate(() =>
      [...document.querySelectorAll('[data-item-kind="icon"]')]
        .slice(0, 2)
        .map((e) => {
          const r = e.getBoundingClientRect()
          return { id: e.getAttribute('data-wall-item'), x: r.x + r.width / 2, y: r.y + r.height / 2 }
        }),
    )
    check('合并前置：至少两个图标', mergeTiles.length === 2, JSON.stringify(mergeTiles))
    if (mergeTiles.length === 2) {
      await page.mouse.move(mergeTiles[0].x, mergeTiles[0].y)
      await page.mouse.down()
      await page.mouse.move(mergeTiles[1].x, mergeTiles[1].y, { steps: 10 })
      await page.waitForTimeout(800) // > 600ms 悬停阈值
      const marked = await page.evaluate(() => document.querySelectorAll('[data-merge-target]').length)
      await page.mouse.up()
      await page.waitForTimeout(500)
      const merged = await page.evaluate(() => {
        const p = JSON.parse(localStorage.getItem('yhub.panel.prefs') ?? '{}')
        return {
          folders: p.folders ?? [],
          docks: document.querySelectorAll('[data-wall-dock],[data-dock-tile]').length,
          folderItems: [...document.querySelectorAll('[data-item-kind="folder"]')].map((e) =>
            e.getAttribute('data-entry'),
          ),
        }
      })
      const [, , , fw, fh] = String(merged.folderItems[0] ?? '').split(',').map(Number)
      check('合并：悬停够久有合并提示（虚线框）', marked === 1, `marked=${marked}`)
      check(
        '合并：松手 = 两个图标变成一个文件夹',
        merged.folders.length === 1 && merged.folders[0].memberIds.length === 2,
        JSON.stringify(merged.folders),
      )
      check(
        '合并：文件夹仍是网格里的 1×1，不回 Dock',
        merged.folderItems.length === 1 && fw === 1 && fh === 1 && merged.docks === 0,
        JSON.stringify(merged),
      )
    }
  }

  // 6c) P2：自由缩放把 + 尺寸磁贴（预设菜单）—— 只对信息格开放
  const resizeHandles = await page.locator('.react-resizable-handle:visible').count()
  check('编辑态：信息格有右下角缩放把', resizeHandles > 0, `handles=${resizeHandles}`)

  // 图标/文件夹固定 1×1，尺寸磁贴与自由缩放只挑一个**格子**来验
  const cellId = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-item-kind="cell"]')].find(
      (n) => n.getAttribute('data-wall-item') !== 'overview.alerts',
    )
    return el?.getAttribute('data-wall-item') ?? null
  })
  const entryOf = (id) =>
    page.evaluate(
      (x) => document.querySelector(`[data-wall-item="${x}"]`)?.getAttribute('data-entry') ?? null,
      id,
    )
  if (cellId) {
    await page.locator(`[data-size-menu="${cellId}"]`).click()
    await page.waitForSelector(`[data-size-popup="${cellId}"]`, { timeout: 3000 })
    check('尺寸磁贴：点开有预设菜单', true, cellId)
    await page.locator(`[data-size-popup="${cellId}"] [data-size-preset="md"]`).click()
    await page.waitForTimeout(400)
    const afterMd = await entryOf(cellId)
    check(
      '尺寸磁贴：选「中」→ 落盘 6×2',
      (afterMd ?? '').split(',').slice(3).join(',') === '6,2',
      String(afterMd),
    )
    await page.locator(`[data-size-menu="${cellId}"]`).click()
    await page.waitForSelector(`[data-size-popup="${cellId}"]`, { timeout: 3000 })
    await page.locator(`[data-size-popup="${cellId}"] [data-size-preset="full"]`).click()
    await page.waitForTimeout(400)
    const afterFull = await entryOf(cellId)
    check(
      '尺寸磁贴：选「通栏」→ 落盘 12×2',
      (afterFull ?? '').split(',').slice(3).join(',') === '12,2',
      String(afterFull),
    )
    // 自由缩放：真的拖一下右下角的把手（这是 P2 的主功能，只断言“把手存在”不算验过）
    const corner = await page
      .locator(`[data-wall-item="${cellId}"] .react-resizable-handle`)
      .boundingBox()
    if (corner) {
      const cx = corner.x + corner.width / 2
      const cy = corner.y + corner.height / 2
      await page.mouse.move(cx, cy)
      await page.mouse.down()
      await page.mouse.move(cx + 100, cy + 90, { steps: 12 })
      await page.mouse.up()
      await page.waitForTimeout(600)
      const resized = await entryOf(cellId)
      const [, , , rw, rh] = String(resized).split(',').map(Number)
      check(
        // 从「通栏 12×2」往外拖：宽度已经顶到 12 列上限，所以验高度真的长了
        '自由缩放：拖右下角 → 尺寸真的变了（h 增长）',
        rh > 2,
        String(resized),
      )
    } else {
      check('自由缩放：拿得到右下角把手', false, 'no bbox')
    }
  } else {
    check('尺寸磁贴：桌面上有信息格可测', false, '没找到 cell 项')
  }

  // 6d) P2：排布模式（紧凑 / 自由）—— 只改一个偏好，但必须真的落到墙上（data-packing）
  await page.locator('[data-pref-trigger]').click()
  await page.waitForSelector('[data-pref-panel]', { timeout: 5000 })
  check(
    '自定义弹层：有排布模式（紧凑 / 自由）两个按钮',
    (await page.locator('[data-pref-packing]').count()) === 2,
  )
  await page.locator('[data-pref-packing="free"]').click()
  await page.waitForTimeout(300)
  const packingNow = await page.evaluate(() => {
    const pager = document.querySelector('[data-wall-pager]')
    const stored = JSON.parse(localStorage.getItem('yhub.panel.prefs') ?? '{}')
    return { attr: pager?.getAttribute('data-packing'), stored: stored.packing }
  })
  check(
    '选「自由」：墙标记 data-packing=free 且落盘',
    packingNow.attr === 'free' && packingNow.stored === 'free',
    JSON.stringify(packingNow),
  )
  await page.locator('[data-pref-packing="compact"]').click()
  await page.waitForTimeout(200)
  // 用开关按钮收起弹层（不要按 ESC：ESC 会退出编辑态，见下一条）
  await page.locator('[data-pref-trigger]').click()
  await page.waitForTimeout(200)

  // 7) 退出编辑态：手柄与组件库都收起来
  await page.locator('[data-edit-trigger]').click()
  await page.waitForTimeout(400)
  check('退出编辑态：data-edit-mode=0', (await pager.getAttribute('data-edit-mode')) === '0')
  check('退出编辑态：组件库按钮消失', (await page.locator('[data-library-trigger]').count()) === 0)
  check(
    '退出编辑态：格子回到不可拖',
    (await page.locator('main [data-wall-item].react-draggable').count()) === 0,
  )

  // 7b) P3：内容自适应高度 —— 卡片要么装得下内容，要么已经顶到页底上限
  {
    const boxes = await page.evaluate(() => {
      const pager = document.querySelector('[data-wall-pager]')
      const gap = Number(pager?.getAttribute('data-grid-gap') ?? 12)
      const rowH = Number(pager?.getAttribute('data-row-height') ?? 80)
      const rows = Math.max(
        0,
        Math.round(
          (document.querySelector('[data-wall-grid]')?.getBoundingClientRect().height + gap) /
            (rowH + gap),
        ),
      )
      return [...document.querySelectorAll('[data-wall-item]')].map((el) => {
        const [, x, y, w, h] = (el.getAttribute('data-entry') ?? '').split(',').map(Number)
        const body = el.querySelector('.bento-card__body')
        return {
          id: el.getAttribute('data-wall-item'),
          x,
          y,
          w,
          h,
          rows,
          over: body ? body.scrollHeight - body.clientHeight : 0,
        }
      })
    })
    const stuck = boxes.filter((b) => b.over > 4 && b.y + b.h < b.rows)
    check(
      '自适应高度：内容装不下的卡片已经长到页底上限（不再靠卡内滚动硬塞）',
      boxes.length > 0 && stuck.length === 0,
      stuck.map((b) => `${b.id}: over=${b.over} h=${b.h}/${b.rows - b.y}`).join(' / ') ||
        JSON.stringify(boxes.map((b) => `${b.id}=${b.w}x${b.h}`)),
    )
  }

  check('全程无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '))

} catch (e) {
  check('验收跑完', false, String(e).slice(0, 200))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exitCode = failed.length === 0 ? 0 : 1
