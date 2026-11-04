// TiddlyWiki 自动保存验收（随包胶囊：capsules/tiddlywiki.html）。
//
// 为什么单独一份：TiddlyWiki 的保存协议不是「普通 PUT」，而是
//   1) OPTIONS 探到 `DAV` 头 → 才认为服务器收 PUT（否则 save() 直接返回 false，只给下载）；
//   2) HEAD 取 `ETag`，保存时带 `If-Match`，期望 204 + 新 ETag，过期要 412；
//   3) 保存 URL = 当前页面地址（短地址 /capsules/tiddlywiki，没有 .html 后缀）。
// 这条链路任何一环断了，界面都只是「看起来正常，保存没反应」。所以这里用真 Chrome 跑一遍：
//
//   * 打开内置胶囊（system 层，只读）→ 页面必须真的启动（$tw 可用）；
//   * 新建一条 tiddler 并点「完成」→ TiddlyWiki 的自动保存（$:/config/AutoSave = yes）应自己发 PUT；
//   * 第一个保存必须**落成用户层副本**：内置 html 一个字节都不许变（升级不覆盖用户编辑）；
//   * 再改一次 → 写到用户副本，ETag 更新；携带过期 If-Match → 412；
//   * 刷新页面 → 刚才那条 tiddler 还在（GET 已经命中用户副本）。
//
// 用法（自己起一个临时配置的测试后端，不碰 8790 和真实胶囊库）：
//     cd web && node verify-tiddlywiki-save.mjs
//
// 依赖：本机 Chrome；首次运行会去官网取一次 capsules/tiddlywiki.html（`make capsules` 也会取）。

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { chromium } from 'playwright-core'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME =
  process.env.YHUB_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const TW_URL = process.env.YHUB_TIDDLYWIKI_URL ?? 'https://tiddlywiki.com/empty.html'
const TW_HTML = join(REPO, 'capsules', 'tiddlywiki.html')
const SCRIPT_SRC = process.env.YHUB_TIDDLYWIKI_HTML ?? ''

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

async function ensureTiddlyWiki() {
  if (SCRIPT_SRC) {
    mkdirSync(dirname(TW_HTML), { recursive: true })
    writeFileSync(TW_HTML, readFileSync(SCRIPT_SRC))
    return 'local'
  }
  if (existsSync(TW_HTML) && statSync(TW_HTML).size > 100_000) return 'existing'
  const resp = await fetch(TW_URL, { redirect: 'follow' })
  if (!resp.ok) throw new Error(`下载 TiddlyWiki 失败：HTTP ${resp.status} (${TW_URL})`)
  const body = Buffer.from(await resp.arrayBuffer())
  if (body.length < 100_000 || !body.toString('utf8').toLowerCase().includes('tiddlywiki')) {
    throw new Error(`下载内容不像 TiddlyWiki（${body.length} 字节）：${TW_URL}`)
  }
  mkdirSync(dirname(TW_HTML), { recursive: true })
  writeFileSync(TW_HTML, body, { mode: 0o644 })
  return `downloaded ${body.length} bytes`
}

// ------------------------------------------------------------------ 测试后端

let backend = null

async function startBackend(port, env) {
  const child = spawn('uv', ['run', 'yhub', 'gui', '--no-open', '--port', String(port)], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env,
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const base = `http://127.0.0.1:${port}`
  const t0 = Date.now()
  while (Date.now() - t0 < 60000) {
    if (child.exitCode !== null) {
      throw new Error(`测试后端先退出了（exit ${child.exitCode}）：${log.slice(-800)}`)
    }
    try {
      const resp = await fetch(`${base}/api/health`)
      if (resp.ok) {
        backend = { child, base, port, log: () => log }
        return backend
      }
    } catch { /* 还没起来 */ }
    await sleep(200)
  }
  throw new Error(`等 /api/health 超时（${port}）：${log.slice(-800)}`)
}

async function stopBackend() {
  if (!backend) return
  const { child, port } = backend
  backend = null
  child.kill('SIGTERM')
  for (let i = 0; i < 50; i += 1) {
    if (!(await portAlive(port))) return
    await sleep(200)
  }
  spawnSync('bash', ['-c', `lsof -ti tcp:${port} 2>/dev/null | xargs kill -9 2>/dev/null || true`])
}

function portAlive(port) {
  return new Promise((res) => {
    const sock = net.connect(port, '127.0.0.1')
    sock.once('connect', () => { sock.destroy(); res(true) })
    sock.once('error', () => res(false))
  })
}

async function api(path, init) {
  const resp = await fetch(backend.base + path, init)
  const text = await resp.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: resp.status, body, text, headers: resp.headers }
}

// ------------------------------------------------------------------ 主流程

// TiddlyWiki 5.3 的正文编辑器是 iframe（"framed editor"）：正文要敲进它的 document.body，
// 不是外面那个 hidden 的 textarea（那是无 iframe 环境的回退）。先点进 iframe 再打字。
async function typeBody(page, text) {
  await page.locator('iframe.tc-edit-texteditor-body').first().click()
  await page.keyboard.type(text)
}

const work = mkdtempSync(join(tmpdir(), 'yhub-tw-save-'))
const capsDir = join(work, 'caps')
const configDir = join(work, 'config')
mkdirSync(capsDir, { recursive: true })
mkdirSync(configDir, { recursive: true })

let browser = null
try {
  const how = await ensureTiddlyWiki()
  check('内置胶囊产物就绪', existsSync(TW_HTML), `${TW_HTML}（${how}）`)
  const systemBefore = sha(readFileSync(TW_HTML))

  const port = await freePort()
  await startBackend(port, {
    ...process.env,
    YHUB_CONFIG_DIR: configDir,
    YHUB_SYSTEM_CAPSULES_DIR: join(REPO, 'capsules'),
    YHUB_LANG: 'zh-CN',
  })
  const settings = await api('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'capsules_dir', value: capsDir }),
  })
  check('用户胶囊目录指向临时目录', settings.status === 200, `HTTP ${settings.status}`)

  const listing = await api('/api/capsules')
  const item = listing.body?.capsules?.find((c) => c.relpath === 'tiddlywiki.html')
  check('列表里有内置 tiddlywiki', Boolean(item), item ? `url=${item.url_path} source=${item.source}` : '缺条目')
  check('内置 tiddlywiki 来自只读系统层', item?.source === 'system' && item?.writable === false)
  check('书签标题来自 <title>', /tiddlywiki/i.test(item?.title ?? ''), item?.title ?? '')

  const pageUrl = `${backend.base}/capsules/tiddlywiki`
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu'],
  })
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  const errors = []
  const puts = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    // favicon 是本站缺省图标，被页面 CSP 拦掉是预期噪声（不是胶囊的问题）
    if (m.type() === 'error' && !/favicon|frame-ancestors/.test(m.text())) errors.push(m.text())
  })
  page.on('response', (r) => {
    const req = r.request()
    if (req.method() === 'PUT' && r.url().includes('/capsules/tiddlywiki')) {
      puts.push({ status: r.status(), ifMatch: req.headers()['if-match'], etag: r.headers()['etag'] })
    }
    if (r.status() >= 400 && !/favicon/.test(r.url())) {
      r.text()
        .then((t) => errors.push(`HTTP ${r.status()} ${req.method()} ${r.url()} BODY=${t.slice(0, 300)} HEADERS=${JSON.stringify(req.headers())}`))
        .catch((e) => errors.push(`HTTP ${r.status()} ${req.method()} ${r.url()} (no body: ${e})`))
    }
  })

  await page.goto(pageUrl, { waitUntil: 'load' })
  await page.waitForFunction(
    () => window.$tw && window.$tw.wiki && window.$tw.wiki.getTiddler('$:/core'),
    null,
    { timeout: 45000 },
  )
  check('页面真的启起来了（$tw 可用）', true)
  check(
    'TiddlyWiki 自动保存是开的',
    (await page.evaluate(() => window.$tw.wiki.getTiddlerText('$:/config/AutoSave'))) === 'yes',
  )
  const putSaverReady = await page
    .waitForFunction(
      () => window.$tw.saverHandler?.savers?.some(
        (s) => s.info?.name === 'put' && s.serverAcceptsPuts === true,
      ),
      null,
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false)
  check('put 保存器已就位（OPTIONS 拿到 DAV 才会置 true）', putSaverReady)

  // ---- 第一次保存：新建 tiddler → 点「完成」→ 自动保存发 PUT ----
  const marker1 = `自动保存验收 ${Date.now()}`
  const firstPut = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().includes('/capsules/tiddlywiki'),
    { timeout: 30000 },
  )
  await page.locator('button[title="Create a new tiddler"]').first().click()
  await page.waitForSelector('input.tc-titlebar', { timeout: 15000 })
  await page.locator('input.tc-titlebar').first().fill(marker1)
  await typeBody(page, '第一次保存的正文 marker-1')
  await page.locator('button[title="Confirm changes to this tiddler"]').first().click()
  const firstResp = await firstPut
  check('点「完成」后自动保存真的发出 PUT', firstResp.status() === 204, `HTTP ${firstResp.status()}`)

  const userCopy = join(capsDir, 'tiddlywiki.html')
  let saved = null
  for (let i = 0; i < 50; i += 1) {
    if (existsSync(userCopy)) {
      saved = readFileSync(userCopy)
      if (saved.includes(marker1)) break
    }
    await sleep(200)
  }
  check('保存落成用户层副本', Boolean(saved), userCopy)
  check('副本里真有那条 tiddler', Boolean(saved?.includes(marker1)), marker1)
  check(
    '内置（只读）文件一个字节都没动',
    sha(readFileSync(TW_HTML)) === systemBefore,
    '系统层仍是随包分发的原件',
  )
  check(
    'PUT 回了新 ETag（保存器据此续写）',
    Boolean(puts[0]?.etag) && puts[0].etag !== `"${systemBefore.slice(0, 16)}"`,
    `etag=${puts[0]?.etag}`,
  )

  // ---- 第二次保存：写进用户副本，ETag 更新、不再 412 ----
  const marker2 = `第二次保存 ${Date.now()}`
  const secondPut = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().includes('/capsules/tiddlywiki'),
    { timeout: 30000 },
  )
  await page.locator('button[title="Create a new tiddler"]').first().click()
  await page.waitForSelector('input.tc-titlebar', { timeout: 15000 })
  await page.locator('input.tc-titlebar').first().fill(marker2)
  await typeBody(page, '第二次保存的正文 marker-2')
  await page.locator('button[title="Confirm changes to this tiddler"]').first().click()
  const secondResp = await secondPut
  check('第二次保存也是 204', secondResp.status() === 204, `HTTP ${secondResp.status()}`)
  let saved2 = null
  for (let i = 0; i < 100; i += 1) {
    saved2 = existsSync(userCopy) ? readFileSync(userCopy) : null
    if (saved2?.includes(marker2)) break
    await sleep(200)
  }
  check(
    '副本包含两次修改',
    Boolean(saved2?.includes(marker1) && saved2?.includes(marker2)),
    saved2
      ? `marker1=${saved2.includes(marker1)} marker2=${saved2.includes(marker2)} bytes=${saved2.length}`
      : '缺用户副本',
  )
  check('两次 PUT 的 ETag 不同（没有复用旧的）', puts.length >= 2 && puts[0].etag !== puts[1].etag,
    `${puts.map((p) => p.etag).join(' / ')}`)

  // ---- 并发保护：过期 If-Match 必须 412（TiddlyWiki 据此报「编辑冲突」） ----
  // 带同源 Referer：页面的保存请求就是这个身份，服务端据此判定「不是跨胶囊请求」
  const stale = await fetch(pageUrl, {
    method: 'PUT',
    headers: {
      'If-Match': puts[0].etag,
      'Content-Type': 'text/html;charset=UTF-8',
      Referer: pageUrl,
    },
    body: '<html>stale</html>',
  })
  check('过期 If-Match → 412（不静默覆盖）', stale.status === 412, `HTTP ${stale.status}`)

  // ---- 刷新后还在：GET 命中用户副本 ----
  await page.goto(pageUrl, { waitUntil: 'load' })
  await page.waitForFunction(
    () => window.$tw && window.$tw.wiki && window.$tw.wiki.getTiddler('$:/core'),
    null,
    { timeout: 45000 },
  )
  const hasAfterReload = await page.evaluate((t) => window.$tw.wiki.tiddlerExists(t), marker2)
  check('刷新后那条 tiddler 还在（读到了用户副本）', hasAfterReload)

  const page404 = await fetch(`${backend.base}/capsules/tiddlywiki.html`, {
    headers: { Referer: `${backend.base}/capsules/tiddlywiki` },
  })
  check('显式地址也命中副本', page404.status === 200 && (await page404.text()).includes(marker2))

  check('页面没有 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (err) {
  check('运行未抛异常', false, String(err?.stack ?? err).split('\n').slice(0, 4).join(' | '))
} finally {
  if (browser) await browser.close().catch(() => {})
  await stopBackend().catch(() => {})
  rmSync(work, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.error(`FAILED: ${failed.map((r) => r.name).join(' / ')}`)
  process.exitCode = 1
}
