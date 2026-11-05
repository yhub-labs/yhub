// 验收外置插件目录（docs/plugins.md）。
// 基线 = **一个第三方插件都没装**（本机装着的会临时挪开、跑完还原）；样例用
// web/fixtures/example-plugin/（脚本自己装入/清理）：
//   1) 装入示例插件 → 启动器条目 / 信息墙两格 / CLI 子命令 / MCP 工具 / 配置声明**全部自动出现**；
//   2) 格子对账：example.ok、example.down 在 /api/dashboard/cells 里各恰好一次、id 不重复、
//      格子集合 = 基线 + 这两格，且插件声明的 title 就是格子标题（现读生效）；
//      example.down 必败 → R2 的 source_error 人话格（message + hint 都非空）恒可断言；
//   3) D3 过渡开关：目录里放 `disabled` → 上述条目与那两格全部消失；
//   4) 加载语义：坏 import = 跳过不崩、坏声明 = ValueError 带定位、disabled = 逃生舱；
//   5) 装入 / 清理全程**仓库零改动**（git status --porcelain 前后一致 = 「装入零改动」证明）。
//
// 用法（不依赖已起的后端；自己挑空闲口拉一个测试后端，绝不碰 8790 装机版）：
//     cd web && node verify-plugins.mjs        # 或 make verify-plugins
//
// 会临时动 ~/.yhub/plugins/example-plugin（已存在则先挪开、收尾还原），
// 基线期会把本机装着的全部第三方插件挪到 ~/.yhub/.pre-verify-parked 再还原。
// **不要**在设置了 YHUB_CONFIG_DIR / YHUB_SETTINGS_FILE 的 shell 里跑（脚本会拒绝启动）。

import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

process.env.YHUB_LANG = process.env.YHUB_LANG ?? 'zh-CN'

// 这个脚本**故意**操作真实配置根的 plugins/（把本机装着的插件挪开、跑完还原），所以它要求
// 后端也读同一个根。继承来的 YHUB_CONFIG_DIR/YHUB_SETTINGS_FILE 会让后端读另一个根 →
// 装入的示例插件对后端不可见（典型症状：基线全绿、装完 4/10）。这里直接拒绝，别让人猜。
for (const key of ['YHUB_CONFIG_DIR', 'YHUB_SETTINGS_FILE']) {
  if (process.env[key]) {
    console.error(
      `${key} is set (${process.env[key]}) — this script drives the real config root. ` +
        `Run it with: env -u ${key} node verify-plugins.mjs`,
    )
    process.exit(1)
  }
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_ID = 'example-plugin'
const SRC = join(REPO, 'web', 'fixtures', PLUGIN_ID)
const PLUGINS_ROOT = join(homedir(), '.yhub', 'plugins')
const TARGET = join(PLUGINS_ROOT, PLUGIN_ID)
// 基线期把本机装着的第三方插件整个挪到这里（同一个「不能留在 plugins/ 里」的理由）
const PARK_ROOT = join(homedir(), '.yhub', '.pre-verify-parked')
// 示例插件声明的两格（读 manifest 现算，别在这里手写第二份）
const manifestSrc = JSON.parse(readFileSync(join(SRC, 'plugin.json'), 'utf8'))
const EXAMPLE_TILES = manifestSrc.presentation.tiles.map((t) => t.id)
// 内置（= 核心插件）MCP 工具清单：与 packaging/verify-backend.sh 同口径。
const MCP_BUILTIN = [
  'rclone_probe', 'rclone_status', 'rclone_umount',
  'rss_list', 'rss_add', 'rss_remove', 'rss_items',
]
// 内置工具清单 = 随 wheel 分发的**核心插件**（外置插件未装入时 /api/tools 的清单，
// 与 packaging/verify-backend.sh 的 EXPECTED 同口径）。外置插件本机装没装都会被基线期挪走，所以不在这里。
const TOOLS_BUILTIN = [
  'rclone', 'rss', 'scheduler',
]

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function yhub(args, { timeout = 60000, env = {} } = {}) {
  const r = spawnSync('uv', ['run', 'yhub', ...args], {
    cwd: REPO, encoding: 'utf8', timeout, env: { ...process.env, ...env },
  })
  if (r.error) throw r.error
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function runPython(code, env = {}) {
  const r = spawnSync('uv', ['run', 'python', '-c', code], {
    cwd: REPO, encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env },
  })
  if (r.error) throw r.error
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function gitStatus() {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' })
  if (r.error) throw r.error
  return r.stdout
}

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

async function portAlive(port) {
  return new Promise((res) => {
    const sock = net.connect(port, '127.0.0.1')
    sock.once('connect', () => { sock.destroy(); res(true) })
    sock.once('error', () => res(false))
  })
}

// ------------------------------------------------------------------ 测试后端

let backend = null // { child, base, port, log }

async function startBackend(port) {
  const child = spawn('uv', ['run', 'yhub', 'gui', '--no-open', '--port', String(port)], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const base = `http://127.0.0.1:${port}`
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
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
  // uv run 的子进程没跟着退：按端口收（只碰本脚本自己挑的口，绝不误杀别的进程）
  spawnSync('bash', ['-c', `lsof -ti tcp:${port} 2>/dev/null | xargs kill -9 2>/dev/null || true`])
  for (let i = 0; i < 25; i += 1) {
    if (!(await portAlive(port))) return
    await sleep(200)
  }
  throw new Error(`测试后端没停下来（端口 ${port}）`)
}

async function api(path, init) {
  const resp = await fetch(backend.base + path, init)
  const text = await resp.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: resp.status, body, text, contentType: resp.headers.get('content-type') ?? '' }
}

async function toolIds() {
  const { status, body } = await api('/api/tools')
  if (status !== 200 || !body?.ok) throw new Error(`/api/tools -> ${status} ${String(status === 200 ? body?.error : '')}`)
  return body.tools.map((t) => t.id)
}

async function toolEntry(id) {
  const { body } = await api('/api/tools')
  return body.tools.find((t) => t.id === id) ?? null
}

async function cellList() {
  const { status, body } = await api('/api/dashboard/cells')
  if (status !== 200 || !body?.ok) throw new Error(`/api/dashboard/cells -> ${status}`)
  return body.cells
}

const countOf = (cells, id) => cells.filter((c) => c.id === id).length
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')

// ------------------------------------------------------------------ MCP 面

async function mcpSession(fn) {
  const child = spawn('uv', ['run', 'yhub', 'mcp'], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  let stderr = ''
  const pending = new Map()
  child.stderr.on('data', (d) => { stderr += d })
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg)
          pending.delete(msg.id)
        }
      } catch { /* 日志行，忽略 */ }
    }
  })
  const rpc = (id, method, params) => new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`rpc ${method} 超时：${stderr.slice(0, 300)}`)), 25000)
    pending.set(id, (msg) => { clearTimeout(timer); res(msg) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try {
    const init = await rpc(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verify-plugins', version: '0' },
    })
    if (!init.result) throw new Error(`initialize 失败：${JSON.stringify(init.error)}`)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
    const list = await rpc(2, 'tools/list', {})
    const tools = list.result?.tools ?? []
    return await fn({ tools, rpc, stderr })
  } finally {
    child.kill('SIGKILL')
  }
}

// ------------------------------------------------------------------ 加载语义

function pluginFixture(id, { manifest, code, disabled = false }) {
  const root = mkdtempSync(join(tmpdir(), 'yhub-plugins-'))
  const dir = join(root, 'plugins', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2))
  if (code != null) writeFileSync(join(dir, 'plugin.py'), code)
  if (disabled) writeFileSync(join(dir, 'disabled'), '')
  return { root, dir }
}

const DISCOVER = 'from yhub.server.adapters import discover_adapters; print(sorted(a["meta"]["id"] for a in discover_adapters()))'

function loaderSemantics() {
  // a) 坏 import：跳过 + 告警，启动不崩（如实降级、不白屏）
  const a = pluginFixture('broken-import', {
    manifest: { schema: 2, version: '0.1.0', id: 'broken-import', name: '坏插件', icon: '💥', description: '导入就炸', trust: 'full' },
    code: 'raise RuntimeError("导入期爆炸")\n',
  })
  const ra = runPython(DISCOVER, { YHUB_CONFIG_DIR: a.root })
  check(
    '加载语义：plugin.py 导入失败 = 跳过 + 启动不崩',
    ra.code === 0 && !ra.out.includes('broken-import'),
    `exit=${ra.code} out=${ra.out.trim()}`,
  )
  check('加载语义：导入失败有日志告警（stderr）', /导入失败|跳过/.test(ra.err), ra.err.split('\n').find((l) => l.includes('plugins')) ?? ra.err.slice(-200))
  rmSync(a.root, { recursive: true, force: true })

  // b) 坏声明：ValueError 带 <id>/plugin.json.<字段> 定位（不许静默降级）
  const b = pluginFixture('broken-manifest', {
    manifest: { schema: 2, version: '0.1.0', id: 'broken-manifest', name: '坏声明', icon: '💥', description: '缺 trust' },
    code: 'TOOL_META = {}\n',
  })
  const rb = runPython(DISCOVER, { YHUB_CONFIG_DIR: b.root })
  check(
    '加载语义：声明错 fail-loud（ValueError 带 id/字段定位）',
    rb.code !== 0 && rb.err.includes('broken-manifest/plugin.json.trust'),
    `exit=${rb.code} ${rb.err.split('\n').filter((l) => l.includes('ValueError')).join(' ')}`,
  )

  // c) 面板路径越界：启动即报错，不留到请求时（CSP 是卫生，不是沙箱；路径是契约）
  const c2 = pluginFixture('bad-panel', {
    manifest: {
      schema: 2, version: '0.1.0', id: 'bad-panel', name: '面板越界', icon: '💥',
      description: 'panel 指向插件目录之外', trust: 'full',
      presentation: { panel: '../outside.html' },
    },
    code: 'TOOL_META = {}\n',
  })
  const rd = runPython(DISCOVER, { YHUB_CONFIG_DIR: c2.root })
  check(
    '加载语义：panel 路径越界 = 启动报错并点名字段',
    rd.code !== 0 && rd.err.includes('bad-panel/plugin.json.presentation.panel'),
    `exit=${rd.code} ${rd.err.split('\n').filter((l) => l.includes('panel')).join(' ').slice(0, 200)}`,
  )
  rmSync(c2.root, { recursive: true, force: true })

  // d) 同一份坏声明 + disabled 标记 = 逃生舱（先于 manifest 校验）
  writeFileSync(join(b.dir, 'disabled'), '')
  const rc = runPython(DISCOVER, { YHUB_CONFIG_DIR: b.root })
  check(
    '加载语义：disabled 是逃生舱（坏声明 + disabled = 正常跳过）',
    rc.code === 0 && !rc.out.includes('broken-manifest'),
    `exit=${rc.code} out=${rc.out.trim()}`,
  )
  rmSync(b.root, { recursive: true, force: true })
}

// ------------------------------------------------------------------ main

async function main() {
  const gitBefore = gitStatus()
  let installed = false
  // 「挪开的第三方插件」= 现场装着的全部（不止示例那一个）。基线的定义是
  // 「一个外置插件都没装」，所以本机日常装着的那些（如 chrome-doctor）
  // 也得先请出去，跑完原样还回来——否则基线会随着本机装了什么而漂。
  const parked = []

  try {
    // 把已存在的第三方插件目录全挪开（收尾逐个还原）
    if (existsSync(PLUGINS_ROOT)) {
      for (const name of readdirSync(PLUGINS_ROOT)) {
        const src = join(PLUGINS_ROOT, name)
        if (name.startsWith('.')) continue
        const dst = join(PARK_ROOT, name)
        rmSync(dst, { recursive: true, force: true })
        mkdirSync(PARK_ROOT, { recursive: true })
        renameSync(src, dst)
        parked.push(name)
      }
    }

    // ---- 阶段 A：没装外置插件的基线 -------------------------------------
    await startBackend(await freePort())
    const baseTools = await toolIds()
    const baseCells = await cellList()
    check(
      '基线：外置未装入时 = 内置工具清单（不多不少：rclone, scheduler）',
      sameSet(baseTools, TOOLS_BUILTIN),
      JSON.stringify(baseTools),
    )
    check(
      '基线：核心 rclone.mounts 在、示例插件的两格不在（产地跟着插件走）',
      countOf(baseCells, 'rclone.mounts') === 1
        && EXAMPLE_TILES.every((cid) => countOf(baseCells, cid) === 0)
        && countOf(baseCells, 'overview.alerts') === 1,
      `cells=${baseCells.length}`,
    )
    const { body: pluginsBody } = await api('/api/plugins')
    check(
      '/api/plugins 接口可用且返回 plugins 列表',
      Array.isArray(pluginsBody?.plugins),
      JSON.stringify(pluginsBody),
    )
    await stopBackend()

    // ---- 阶段 B：装入示例插件 -------------------------------------------
    mkdirSync(PLUGINS_ROOT, { recursive: true })
    cpSync(SRC, TARGET, { recursive: true })
    installed = true

    await startBackend(await freePort())
    const entry = await toolEntry(PLUGIN_ID)
    check(
      '/api/tools 出现插件条目（id/name/icon/description 与 plugin.json 一致）',
      !!entry && entry.name === manifestSrc.name && entry.icon === manifestSrc.icon
        && entry.description === manifestSrc.description,
      JSON.stringify(entry),
    )
    const toolsNow = await toolIds()
    check(
      `工具清单 = 基线 + ${PLUGIN_ID}（不多不少）`,
      sameSet(toolsNow, [...baseTools, PLUGIN_ID]),
      JSON.stringify(toolsNow),
    )

    // 面板：声明 → /api/tools 带 URL → 路由原样吐插件自己的 HTML（宿主不编译、不注入）
    check(
      '面板：声明了 presentation.panel 的工具带 panel URL',
      entry?.panel === `/api/plugins/${PLUGIN_ID}/panel`,
      `panel=${JSON.stringify(entry?.panel)}`,
    )
    const panelResp = await api(`/api/plugins/${PLUGIN_ID}/panel`)
    check(
      '面板：GET /api/plugins/<id>/panel 原样返回插件目录里的 HTML',
      panelResp.status === 200
        && /text\/html/.test(panelResp.contentType)
        && panelResp.text.includes('example-plugin-panel-marker'),
      `status=${panelResp.status} type=${panelResp.contentType} bytes=${panelResp.text.length}`,
    )
    const coreTool = (await api('/api/tools')).body.tools.find((t) => !t.panel && t.id !== PLUGIN_ID)
    check(
      '面板：没声明面板的工具不带 panel 字段（不是空字符串）',
      !!coreTool && !('panel' in coreTool),
      `tool=${coreTool?.id} keys=${coreTool ? Object.keys(coreTool).join(',') : '-'}`,
    )
    const unknownPanel = await api('/api/plugins/no-such-plugin/panel')
    check(
      '面板：未装插件的面板 URL 404（不是 500）',
      unknownPanel.status === 404,
      `status=${unknownPanel.status}`,
    )

    const cellsNow = await cellList()
    for (const cid of EXAMPLE_TILES) {
      check(`格子桥：${cid} 恰好一次`, countOf(cellsNow, cid) === 1, `cells=${cellsNow.length}`)
    }
    check(
      '格子桥：id 不重复（每个 id 恰好一份）',
      new Set(cellsNow.map((c) => c.id)).size === cellsNow.length,
      `cells=${cellsNow.length} unique=${new Set(cellsNow.map((c) => c.id)).size}`,
    )
    check(
      '格子对账：格子集合 = 基线 + 示例两格（不多不少，id 不重复）',
      sameSet(cellsNow.map((c) => c.id), [...baseCells.map((c) => c.id), ...EXAMPLE_TILES]),
      `now=${cellsNow.length} base=${baseCells.length}`,
    )
    const okTile = manifestSrc.presentation.tiles.find((t) => t.id === 'example.ok')
    const nowOk = cellsNow.find((c) => c.id === 'example.ok')
    check(
      '产地声明：zone/order/title/source 按插件 manifest 呈现（声明即产地）',
      nowOk.zone === okTile.zone && nowOk.order === okTile.order
        && nowOk.title === okTile.title && nowOk.source === okTile.source,
      `${nowOk.zone}/${nowOk.order}/${nowOk.title}/${nowOk.source}`,
    )
    // R2：示例的必败格恒失败 → 必须给 source_error 人话格（绝不假绿）
    const downCell = cellsNow.find((c) => c.id === 'example.down')
    check(
      'R2：取数失败给 source_error 人话格（message + hint 都非空）',
      !!downCell?.source_error
        && typeof downCell.source_error.message === 'string' && downCell.source_error.message.length > 0
        && typeof downCell.source_error.hint === 'string' && downCell.source_error.hint.length > 0,
      JSON.stringify(downCell?.source_error ?? downCell?.summary),
    )
    // 常绿格不能被拖下水：失败只该降它自己那一格
    check(
      'R2：失败只降自己那格（example.ok 照常是 ok 信封）',
      nowOk?.source_error == null && typeof nowOk?.summary === 'string' && nowOk.summary.length > 0,
      `summary=${nowOk?.summary}`,
    )

    // 覆盖层现读验证：改**安装副本**的 title → 下一次请求就该生效（不用重启）
    const installedManifest = join(TARGET, 'plugin.json')
    const originalManifest = readFileSync(installedManifest, 'utf8')
    const edited = JSON.parse(originalManifest)
    const editedTile = edited.presentation.tiles.find((t) => t.id === 'example.ok')
    editedTile.title = '示例常绿·改'
    writeFileSync(installedManifest, JSON.stringify(edited, null, 2))
    const overridden = await cellList()
    const editedCell = overridden.find((c) => c.id === 'example.ok')
    check(
      '产地声明：改 manifest 的 title → 格子标题立刻变（现读生效）',
      editedCell?.title === '示例常绿·改',
      `title=${editedCell?.title}`,
    )
    writeFileSync(installedManifest, originalManifest) // 还原安装副本
    const restored = await cellList()
    check(
      '产地声明：还原 manifest 后 title 回到声明默认',
      restored.find((c) => c.id === 'example.ok')?.title === okTile.title,
      `title=${restored.find((c) => c.id === 'example.ok')?.title}`,
    )

    // 配置声明面：GET /api/plugins 的 config 段与 manifest 一致（面板照它渲染）
    const { body: pluginsNow } = await api('/api/plugins')
    const declared = (pluginsNow?.plugins ?? []).find((p) => p.id === PLUGIN_ID)
    check(
      '配置声明：GET /api/plugins 回传 manifest 的 config 段（key/type/default）',
      Array.isArray(declared?.config) && declared.config[0]?.key === manifestSrc.config[0].key
        && declared.config[0]?.type === manifestSrc.config[0].type
        && declared.config[0]?.default === manifestSrc.config[0].default,
      JSON.stringify(declared?.config),
    )

    // MCP 面
    await mcpSession(async ({ tools, rpc }) => {
      const names = tools.map((t) => t.name)
      check(
        'MCP tools/list 出现插件声明的 example_* 工具',
        names.includes('example_hello'),
        names.join(','),
      )
      check(
        'MCP 面清单 = 内置 7 个 + example_hello（外置是超集，内置一个不少）',
        MCP_BUILTIN.every((n) => names.includes(n)) && names.length === MCP_BUILTIN.length + 1,
        `total=${names.length}`,
      )
      const called = await rpc(3, 'tools/call', { name: 'example_hello', arguments: {} })
      let payload = null
      try { payload = JSON.parse(called.result?.content?.[0]?.text ?? 'null') } catch { /* 下面报 */ }
      // 成功 = {ok:true, summary…}；失败 = 宿主 wrapper 的 {error, hint}（ToolError 三通道之一）
      const okSuccess = payload?.ok === true
      const okToolError = typeof payload?.error === 'string' && payload.error.length > 0
        && typeof payload?.hint === 'string'
      check(
        'MCP example_hello 可调用：成功 {ok:true} 或 ToolError 人话 + hint',
        okSuccess || okToolError,
        JSON.stringify(payload).slice(0, 200),
      )
    })

    // CLI 面
    const help = yhub(['exdemo', '--help'])
    check(
      'CLI `yhub exdemo --help` 有效（子命令来自声明）',
      help.code === 0 && /hello/.test(help.out),
      `exit=${help.code}`,
    )
    const compEnabled = yhub(['completion', 'zsh'])
    check(
      'CLI：动态补全词表自动带上 exdemo（解析树来自声明）',
      compEnabled.code === 0 && compEnabled.out.includes("'exdemo:"),
      `exit=${compEnabled.code}`,
    )
    const helloJson = yhub(['exdemo', 'hello', '--json'])
    let helloPayload = null
    try { helloPayload = JSON.parse(helloJson.out) } catch { /* 下面报 */ }
    check(
      'CLI `exdemo hello --json`：成功 {ok:true} 或 ToolError {ok:false,error,hint}（退出码对齐）',
      (helloJson.code === 0 && helloPayload?.ok === true)
        || (helloJson.code === 1 && helloPayload?.ok === false
          && !!helloPayload.error && typeof helloPayload.hint === 'string'),
      `exit=${helloJson.code} ${helloJson.out.trim().slice(0, 160)}`,
    )
    // 面板跟着插件走：禁用后路由不再服务
    await stopBackend()

    // ---- 阶段 C：disabled 标记（D3 过渡开关）---------------------------
    writeFileSync(join(TARGET, 'disabled'), '')
    await startBackend(await freePort())
    const toolsDisabled = await toolIds()
    check(
      'disabled：/api/tools 条目消失（清单回到基线）',
      sameSet(toolsDisabled, baseTools),
      JSON.stringify(toolsDisabled),
    )
    const panelDisabled = await api(`/api/plugins/${PLUGIN_ID}/panel`)
    check(
      'disabled：插件面板 URL 不再服务（404）',
      panelDisabled.status === 404,
      `status=${panelDisabled.status}`,
    )
    const cellsDisabled = await cellList()
    check(
      'disabled：示例两格随插件消失（核心 rclone.mounts 照常——产地跟着各自插件）',
      EXAMPLE_TILES.every((cid) => countOf(cellsDisabled, cid) === 0)
        && countOf(cellsDisabled, 'rclone.mounts') === 1
        && sameSet(cellsDisabled.map((c) => c.id), baseCells.map((c) => c.id)),
      `cells=${cellsDisabled.length}`,
    )
    check(
      'disabled：宿主通知瓦片与其余格子照常（那两格不是唯一产地）',
      // 只断言**核心**产的格子：svc.*/sync.* 是非核心插件，基线期被请出去了，
      // 拿它们做「其余格子照常」的证据会随本机装了什么而漂。
      countOf(cellsDisabled, 'overview.alerts') === 1
        && countOf(cellsDisabled, 'rclone.mounts') === 1,
      `cells=${cellsDisabled.length}`,
    )
    await stopBackend()
    // 注意：不能用 `yhub exdemo …` 的退出码反证消失——argparse 对未知命令本来就退 2，
    // 与「命令是否还存在」无关。补全词表由解析树动态渲染，声明没了词表就没了，
    // 这才是「子命令消失」的真信号。
    const compDisabled = yhub(['completion', 'zsh'])
    check(
      'disabled：CLI 子命令消失（补全词表里没有 exdemo）',
      compDisabled.code === 0 && !compDisabled.out.includes("'exdemo:"),
      `exit=${compDisabled.code} hasExdemo=${compDisabled.out.includes("'exdemo:")}`,
    )
    const treeDisabled = runPython('from yhub.cli.generate import command_tree; print(sorted(command_tree()))')
    check(
      'disabled：声明面生成器里也没有 exdemo 命令',
      // command_tree() 打印的是 Python repr（单引号列表），按元素精确匹配 'exdemo'
      treeDisabled.code === 0 && !treeDisabled.out.includes("'exdemo'"),
      treeDisabled.out.trim(),
    )
    await mcpSession(async ({ tools }) => {
      const exTools = tools.map((t) => t.name).filter((n) => n.startsWith('example_'))
      check('disabled：MCP 面无 example_* 工具', exTools.length === 0, exTools.join(','))
      check(
        'disabled：MCP 面回到内置清单（内置一个不少）',
        MCP_BUILTIN.every((n) => tools.map((t) => t.name).includes(n))
          && tools.length === MCP_BUILTIN.length,
        `total=${tools.length}`,
      )
    })

    // ---- 阶段 D：加载器语义（隔离配置根，不起服务）----------------------
    loaderSemantics()
  } finally {
    await stopBackend().catch((e) => console.error('清理后端失败：', e.message))
    if (installed) rmSync(TARGET, { recursive: true, force: true })
    // 把基线期请出去的第三方插件原样还回来（顺序无关，逐个搬回）
    for (const name of parked) {
      const from = join(PARK_ROOT, name)
      if (!existsSync(from)) continue
      const to = join(PLUGINS_ROOT, name)
      rmSync(to, { recursive: true, force: true })
      mkdirSync(PLUGINS_ROOT, { recursive: true })
      renameSync(from, to)
    }
    rmSync(PARK_ROOT, { recursive: true, force: true })
  }

  // ---- 装入零改动：安装/清理动作不碰仓库任何被跟踪文件 ----------------
  const gitAfter = gitStatus()
  check(
    '装入/清理全程仓库零改动（git status --porcelain 前后一致）',
    gitAfter === gitBefore,
    gitAfter === gitBefore ? `status 行数 ${gitBefore ? gitBefore.trim().split('\n').length : 0}` :
      `before:\n${gitBefore}\nafter:\n${gitAfter}`,
  )
}

try {
  await main()
} catch (err) {
  check('验收脚本自身跑通', false, String(err?.stack ?? err).slice(0, 600))
  await stopBackend().catch(() => {})
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) process.exit(1)
