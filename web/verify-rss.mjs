// RSS 订阅端到端验收（HTTP 面 + 信息墙格子）：不碰真实配置，自带一个假源站。
//
// 跑法：cd web && node verify-rss.mjs
//
// 为什么单独一个脚本：
//   加源 / 改地址 / 删源会**写配置文件**，smoke.mjs 连的是用户真实配置（只读），
//   所以写路径只能在一份临时配置根上验。这里自己起一个后端（随机端口 + 临时配置根）
//   和一个本地假源站，跑完就收，用户机器上什么都不留。
//
// 验什么：
//   * 解析：RSS 2.0 / Atom 两种方言的标题、链接、时间排序；
//   * 三态：坏地址 → 400 人话；源返回 404 / 不是 XML → 存下来但标成故障（不假绿）；
//   * 动力学：加一条订阅 → /api/dashboard/cells 立刻多一格 `rss.<id>`，删掉就消失；
//   * 改地址：同一个 id 再 POST 是「就地覆盖」（id 不变、顺序不变 = 墙上位置不丢）。

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(process.cwd(), '..')

/* ---------------------------------------------------------------- 假源站 */

const RSS_OK = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>本地 RSS</title><link>https://rss.example.com/</link>
<item><title>第一条 &amp; 实体</title><link>https://rss.example.com/1</link>
  <pubDate>Wed, 02 Oct 2024 13:00:00 GMT</pubDate></item>
<item><title>第二条</title><link>https://rss.example.com/2</link>
  <pubDate>Tue, 01 Oct 2024 09:30:00 GMT</pubDate></item>
<item><title>第三条</title><link>https://rss.example.com/3</link>
  <pubDate>Mon, 30 Sep 2024 08:00:00 GMT</pubDate></item>
</channel></rss>`

const ATOM_OK = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>本地 Atom</title><link href="https://atom.example.com/"/>
  <entry><title>原子一</title><link rel="alternate" href="https://atom.example.com/a"/>
    <updated>2024-10-03T01:02:03Z</updated></entry>
  <entry><title>原子二</title><link href="https://atom.example.com/b"/>
    <published>2024-10-02T01:02:03Z</published></entry>
</feed>`

const NOT_A_FEED = `<!doctype html><html><body><h1>这是一个网页</h1></body></html>`

function serveFixtures() {
  const server = createServer((req, res) => {
    if (req.url === '/rss.xml') {
      res.writeHead(200, { 'content-type': 'application/rss+xml' })
      res.end(RSS_OK)
    } else if (req.url === '/atom.xml') {
      res.writeHead(200, { 'content-type': 'application/atom+xml' })
      res.end(ATOM_OK)
    } else if (req.url === '/web.html') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(NOT_A_FEED)
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    }
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)))
}

/* ------------------------------------------------------------ 进程小工具 */

function freePort() {
  return new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => ok(port))
    })
  })
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`)
}

async function waitHealth(base, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`${base}/api/health`)
      if (r.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function stable(value, dropKeys) {
  if (Array.isArray(value)) return value.map((v) => stable(v, dropKeys))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (dropKeys.includes(k)) continue
      out[k] = stable(v, dropKeys)
    }
    return out
  }
  return value
}

const drop = ['fetched_at', 'updated_at', 'generated_at', 'next_refresh_in', 'now', 'checked_at']

setTimeout(() => {
  console.error('× 验收脚本超时（180s）—— 多半是后端没起来或假源站没关')
  process.exit(1)
}, 180_000).unref()

let backend = null
let fixtures = null
let cfgDir = null

try {
  fixtures = await serveFixtures()
  const feedPort = fixtures.address().port
  const base = `http://127.0.0.1:${feedPort}`

  cfgDir = mkdtempSync(join(tmpdir(), 'yhub-rss-'))
  const port = await freePort()
  const api = `http://127.0.0.1:${port}`
  // 后端输出写到文件而不是管道：管道会让 node 的 event loop 一直被 child 拽着不退出
  const logFd = openSync(join(cfgDir, 'backend.log'), 'a')
  backend = spawn('uv', ['run', 'yhub', 'gui', '--no-open', '--port', String(port)], {
    cwd: REPO,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      // 两个都指到临时根：rss.json（写）与 dashboard.json（读的覆盖）
      YHUB_RSS_DIR: cfgDir,
      YHUB_DASHBOARD_DIR: cfgDir,
      YHUB_SETTINGS_FILE: join(cfgDir, 'settings.json'),
    },
  })

  if (!(await waitHealth(api))) {
    throw new Error(`后端没起来：${readFileSync(join(cfgDir, 'backend.log'), 'utf8').slice(-800)}`)
  }

  const call = async (path, init) => {
    const r = await fetch(api + path, init)
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: r.status, body, text }
  }
  const json = (path, method, payload) =>
    call(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
  const cells = async () => (await call('/api/dashboard/cells')).body?.cells ?? []
  const rssCells = async () => (await cells()).filter((c) => String(c.id).startsWith('rss.'))

  /* ---------------------------------------------------------- 1) 空态 */

  {
    const { status, body } = await call('/api/rss')
    check(
      '空配置：GET /api/rss 返回 0 个源 + 配置文件路径在临时根里',
      status === 200 && body.ok === true && body.total === 0 && body.config_path.startsWith(cfgDir),
      JSON.stringify({ total: body?.total, path: body?.config_path }),
    )
  }

  /* ------------------------------------------------- 2) 加一条 RSS 2.0 */

  let rssId = ''
  {
    const { status, body } = await json('/api/rss/feeds', 'POST', {
      url: `${base}/rss.xml`,
      title: '本地 RSS',
    })
    rssId = body?.feed?.id ?? ''
    check(
      '加源（RSS 2.0）：立刻解析出 3 条 + 站点首页',
      status === 200 && body?.saved === true && body.feed.items === 3
        && body.feed.site === 'https://rss.example.com/' && !!rssId,
      JSON.stringify(body?.feed ?? null),
    )
  }

  /* ---------------------------------------------------- 3) 加一条 Atom */

  {
    const { body } = await json('/api/rss/feeds', 'POST', { url: `${base}/atom.xml` })
    check(
      '加源（Atom）：命名空间、link@href、updated 都认得（2 条）',
      body?.feed?.items === 2 && body.feed.site === 'https://atom.example.com/',
      JSON.stringify(body?.feed ?? null),
    )
  }

  /* ------------------------------------------------------- 4) 条目解析 */

  {
    const { status, body } = await call(`/api/rss/items?feed_id=${encodeURIComponent(rssId)}&limit=2`)
    const items = body?.items ?? []
    check(
      '条目：按时间倒序、实体解码、时间转 Asia/Shanghai',
      status === 200 && items.length === 2
        && items[0].title === '第一条 & 实体'
        && items[0].href === 'https://rss.example.com/1'
        && items[0].published_text === '10-02 21:00'
        && items[1].title === '第二条',
      JSON.stringify(items.map((i) => `${i.published_text} ${i.title}`)),
    )
  }

  /* --------------------------------------------------------- 5) 坏地址 */

  {
    const { status, body } = await json('/api/rss/feeds', 'POST', { url: 'ftp://nope' })
    check(
      '坏地址：400 + 人话 + 怎么办（三通道同一份 ToolError）',
      status === 400 && body?.ok === false && /http\(s\)/.test(body.error) && !!body.hint,
      JSON.stringify(body),
    )
  }

  /* --------------------------------- 6) 读不到的源：存下来但标成故障 */

  {
    const { body } = await json('/api/rss/feeds', 'POST', {
      url: `${base}/missing.xml`,
      title: '打不开的源',
    })
    check(
      '源返回 404：照样保存，但带 「HTTP 404」+ 怎么办',
      body?.saved === true && /HTTP 404/.test(body?.feed?.error?.message ?? '')
        && !!body?.feed?.error?.hint,
      JSON.stringify(body?.feed?.error ?? null),
    )
    const { body: nb } = await json('/api/rss/feeds', 'POST', {
      url: `${base}/web.html`,
      title: '不是订阅的网页',
    })
    check(
      '不是订阅格式（网页）：错误说的是「不是订阅格式」，不是「解析崩了」',
      /不是订阅格式/.test(nb?.feed?.error?.message ?? ''),
      String(nb?.feed?.error?.message ?? ''),
    )
  }

  /* ------------------------------------------- 7) 信息墙自动多格子 */

  {
    const rss = await rssCells()
    const good = rss.find((c) => c.id === `rss.${rssId}`)
    const bad = rss.find((c) => (c.title ?? '').includes('打不开的源'))
    check(
      '动力学：加了几条源，墙上就有几格 rss.*（含坏源）',
      rss.length === 4,
      rss.map((c) => c.id).join(','),
    )
    check(
      '格子内容：标题/摘要/详情链接都对，深链指向站点首页',
      !!good && good.status === 'ok'
        && good.summary.includes('3 条')
        && good.href === 'https://rss.example.com/'
        && (good.detail ?? []).length === 3
        && good.detail[0].href === 'https://rss.example.com/1',
      JSON.stringify(good && {
        status: good.status, summary: good.summary, href: good.href,
        detail: (good.detail ?? []).slice(0, 2),
      }),
    )
    check(
      '坏源上墙不假绿：status=warn 且 source_error 带 hint（R2）',
      !!bad && bad.status === 'warn' && !!bad.source_error?.hint,
      JSON.stringify(bad && { status: bad.status, error: bad.source_error }),
    )
  }

  /* --------------------------- 8) 同一个 id 再 POST = 就地改（不换位置） */

  {
    const before = (await call('/api/rss')).body?.feeds?.map((f) => f.id) ?? []
    const { body } = await json('/api/rss/feeds', 'POST', {
      id: rssId,
      url: `${base}/rss.xml`,
      title: '改过的名字',
    })
    const after = (await call('/api/rss')).body?.feeds ?? []
    check(
      '改地址：id 不变、顺序不变（格子位置因此不会丢）',
      body?.feed?.id === rssId
        && after.map((f) => f.id).join(',') === before.join(',')
        && after[0].title === '改过的名字',
      `${before.join(',')} → ${after.map((f) => f.id).join(',')} / ${after[0]?.title}`,
    )
  }

  /* ------------------------------------------ 9) 关掉一个源 = 格子还在但 disabled */

  {
    await json('/api/rss/feeds', 'POST', { id: rssId, url: `${base}/rss.xml`, enabled: false })
    const cell = (await rssCells()).find((c) => c.id === `rss.${rssId}`)
    check(
      '开关：enabled=false 的源，格子仍在但标记为不可见（前端据此隐藏）',
      !!cell && cell.enabled === false,
      JSON.stringify(cell && { id: cell.id, enabled: cell.enabled }),
    )
    await json('/api/rss/feeds', 'POST', { id: rssId, url: `${base}/rss.xml`, enabled: true })
  }

  /* ------------------------------------------------------ 10) 删除 */

  {
    const { status, body } = await call(`/api/rss/feeds/${encodeURIComponent(rssId)}`, { method: 'DELETE' })
    const gone = (await rssCells()).some((c) => c.id === `rss.${rssId}`)
    check(
      '删除：接口 200，墙上的格子跟着消失',
      status === 200 && body?.removed === true && gone === false,
      JSON.stringify({ status, removed: body?.removed, stillThere: gone }),
    )
    const again = await call(`/api/rss/feeds/${encodeURIComponent(rssId)}`, { method: 'DELETE' })
    check(
      '删不存在的订阅：400 人话（不是 500）',
      again.status === 400 && again.body?.ok === false,
      JSON.stringify(again.body),
    )
  }

  /* ------------------------------------------- 11) 配置文件是真落盘 */

  {
    const raw = JSON.parse(readFileSync(join(cfgDir, 'rss.json'), 'utf8'))
    check(
      '落盘：rss.json 是合法 JSON，删掉的那条不在里面',
      Array.isArray(raw.feeds) && !raw.feeds.some((f) => f.id === rssId) && raw.feeds.length === 3,
      JSON.stringify(raw.feeds.map((f) => f.id)),
    )
  }

  /* -------------------------------------------- 12) 停掉源站 → 变故障 */

  {
    await new Promise((ok) => fixtures.close(ok))
    fixtures = null
    const feedId = (await call('/api/rss?live=false')).body?.feeds?.[0]?.id
    const { body } = await call(`/api/rss/feeds/${encodeURIComponent(feedId)}/refresh`, { method: 'POST' })
    check(
      '源站挂掉：refresh 把这次失败如实报回来（连不上 / 超时），不是 200 假成功',
      /连不上|超时/.test(body?.feed?.error?.message ?? ''),
      String(body?.feed?.error?.message ?? ''),
    )
  }

  // 时刻类字段一律剥掉再比（这轮没别的对账，留一条自检防止误用）
  check('脚本自检：stable() 会剥时刻键', JSON.stringify(stable({ a: 1, fetched_at: 2 }, drop)) === '{"a":1}')
} catch (err) {
  check('验收脚本自身跑通', false, String(err?.message ?? err).slice(0, 300))
} finally {
  if (backend) backend.kill('SIGKILL')
  if (fixtures) fixtures.close()
  if (cfgDir) rmSync(cfgDir, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
// 显式退出：假源站/子进程的句柄不一定都收干净，别让验收脚本悬着不返回
process.exit(failed.length === 0 ? 0 : 1)
