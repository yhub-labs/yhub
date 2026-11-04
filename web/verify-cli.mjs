// 验收「三面同构」（同一份 TOOL_META → 路由 / MCP / CLI，见 api-contract.md）：
//   1) MCP 面：真 stdio 握手拿 tools/list —— 清单与入参 schema 必须和声明一致；
//   2) CLI ↔ API 对账：`yhub <cmd> --json` 与对应 HTTP 接口**同一份 body**（A5 口径）；
//   3) 错误三通道：同一份 ToolError 在 HTTP 是 400 {ok:false,error,hint}、
//      CLI 是退出码 1 + 同样的 JSON（--json 模式）、MCP 是 error 结果。
//
// 前置：后端在跑（和 smoke.mjs 同一约定）
//     uv run yhub gui --no-open
//     cd web && node verify-cli.mjs
// 环境：YHUB_GUI_URL（默认 http://127.0.0.1:8790/）

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

process.env.YHUB_LANG = process.env.YHUB_LANG ?? 'zh-CN'
const URL_BASE = (process.env.YHUB_GUI_URL ?? 'http://127.0.0.1:8790/').replace(/\/$/, '')
// 内置（核心）MCP 工具：与 packaging/verify-backend.sh 的 EXPECTED 同口径；
// 非核心插件声明的走下面的 externalMcpNames() 超集。
const MCP_TOOLS = [
  'rclone_probe', 'rclone_status', 'rclone_umount',
  'rss_list', 'rss_add', 'rss_remove', 'rss_items',
]

/**
 * 外置插件声明的 MCP 工具（配置根 `plugins/<id>/plugin.json` 的 faces.mcp）。
 * 口径是「内置 7 个一个不少 + 已安装插件的超集」，而不是写死 7。
 */
function externalMcpNames() {
  const configRoot = process.env.YHUB_CONFIG_DIR || join(homedir(), '.config', 'yhub')
  const root = join(configRoot, 'plugins')
  const names = []
  if (!existsSync(root)) return names
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.') || entry.startsWith('_')) continue
    const dir = join(root, entry)
    if (existsSync(join(dir, 'disabled'))) continue // disabled 的插件本就不加载
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
      for (const tool of manifest?.faces?.mcp ?? []) {
        if (typeof tool?.name === 'string') names.push(tool.name)
      }
    } catch { /* 坏 manifest 由加载器 fail-loud，这里不替它判 */ }
  }
  return names.sort()
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`)
}

function yhub(args, { timeout = 60000 } = {}) {
  const r = spawnSync('uv', ['run', 'yhub', ...args], { encoding: 'utf8', timeout })
  if (r.error) throw r.error
  return { code: r.status, out: r.stdout, err: r.stderr }
}

/** `yhub --help` 的顶层命令表（argparse 的 `{a,b,c}` 那一段）。 */
function cliCommands() {
  const { out } = yhub(['--help'])
  const hit = /\{([^{}]+)\}/.exec(out)
  return hit ? hit[1].split(',').map((s) => s.trim()) : []
}

async function api(path, init) {
  const resp = await fetch(URL_BASE + path, init)
  const text = await resp.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: resp.status, body, text }
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

function diffPath(a, b, path = '$') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`
  }
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  for (const k of keys) {
    const hit = diffPath(a?.[k], b?.[k], `${path}.${k}`)
    if (hit) return hit
  }
  return `${path}: mismatch`
}

// ---------------------------------------------------------------- 1) MCP 面
async function mcpHandshake() {
  const child = spawn('uv', ['run', 'yhub', 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  const pending = new Map()
  let stderr = ''
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
      } catch { /* 非 JSON 行（日志）忽略 */ }
    }
  })
  const rpc = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`rpc ${method} 超时`)), 20000)
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')

  try {
    const init = await rpc(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verify-cli', version: '0' },
    })
    if (!init.result) throw new Error(`initialize 失败：${JSON.stringify(init.error)} ${stderr.slice(0, 400)}`)
    notify('notifications/initialized', {})
    const list = await rpc(2, 'tools/list', {})
    const tools = (list.result?.tools ?? []).map((t) => t.name).sort()
    const expectedMcp = [...MCP_TOOLS, ...externalMcpNames()].sort()
    check(
      'MCP 面清单 == 内置核心 + 外置插件声明的（核心一个不少）',
      JSON.stringify(tools) === JSON.stringify(expectedMcp),
      tools.join(','),
    )
    // zdic is a non-core plugin; only assert its declaration when it is installed.
    if (tools.includes('zdic_lookup')) {
      const zdic = (list.result?.tools ?? []).find((t) => t.name === 'zdic_lookup')
      const schema = zdic?.inputSchema ?? {}
      const props = Object.keys(schema.properties ?? {})
      check(
        'MCP zdic_lookup 入参 schema 来自声明（word 必填 + traditional 可选）',
        props.includes('word') && props.includes('traditional')
          && (schema.required ?? []).includes('word')
          && schema.properties?.traditional?.type === 'boolean',
        JSON.stringify({ props, required: schema.required }),
      )
    }
    const rcloneUmount = (list.result?.tools ?? []).find((t) => t.name === 'rclone_umount')
    check(
      'MCP rclone_umount 只收 name（面级过滤没漏声明）',
      JSON.stringify(Object.keys(rcloneUmount?.inputSchema?.properties ?? {})) === '["name"]',
      JSON.stringify(rcloneUmount?.inputSchema?.properties ?? {}),
    )
  } finally {
    child.kill('SIGKILL')
  }
}

// ---------------------------------------------------------------- 2) CLI ↔ API 对账
async function reconcile() {
  const commands = cliCommands()

  // a) 汉典（非核心插件）：GET /api/zdic?q=水 ≡ yhub zdic -j 水
  if (commands.includes('zdic')) {
    const { status, body } = await api('/api/zdic?q=' + encodeURIComponent('水'))
    const cli = yhub(['zdic', '-j', '水'])
    let parsed = null
    try { parsed = JSON.parse(cli.out) } catch { /* 下面的 diff 会报 */ }
    check(
      '对账 zdic：GET /api/zdic?q=水 ≡ yhub zdic -j 水',
      status === 200 && cli.code === 0 && diffPath(body, parsed) === null,
      diffPath(body, parsed) ?? `HTTP ${status} exit ${cli.code}`,
    )
  }

  // b) rclone 状态（易变键：时间戳类剥掉再比）
  {
    const { status, body } = await api('/api/rclone')
    const cli = yhub(['rclone', 'status', '-j'])
    let parsed = null
    try { parsed = JSON.parse(cli.out) } catch { /* diff 报 */ }
    const drop = ['checked_at', 'probed_at', 'started_at', 'queried_at']
    const hit = diffPath(stable(body, drop), stable(parsed, drop))
    check(
      '对账 rclone：GET /api/rclone ≡ yhub rclone status -j（剥时间戳）',
      status === 200 && cli.code === 0 && hit === null,
      hit ?? `HTTP ${status} exit ${cli.code}`,
    )
  }

  // c) 定时任务：GET /api/scheduler/jobs ≡ yhub schedule list -j
  {
    const { status, body } = await api('/api/scheduler/jobs')
    const cli = yhub(['schedule', 'list', '-j'])
    let parsed = null
    try { parsed = JSON.parse(cli.out) } catch { /* diff 报 */ }
    const drop = ['now', 'checked_at']
    const hit = diffPath(stable(body, drop), stable(parsed, drop))
    check(
      '对账 schedule：GET /api/scheduler/jobs ≡ yhub schedule list -j（剥时钟）',
      status === 200 && cli.code === 0 && hit === null,
      hit ?? `HTTP ${status} exit ${cli.code}`,
    )
  }

  // c2) RSS：GET /api/rss ≡ yhub rss list -j
  //     两个进程各有自己的抓取缓存，所以 fetched_at 这类时刻键要剥掉再比（内容必须一致）。
  {
    const { status, body } = await api('/api/rss?live=true')
    const cli = yhub(['rss', 'list', '-j'])
    let parsed = null
    try { parsed = JSON.parse(cli.out) } catch { /* diff 报 */ }
    const drop = ['fetched_at', 'live', 'items', 'site', 'error']
    const hit = diffPath(stable(body, drop), stable(parsed, drop))
    check(
      '对账 rss：GET /api/rss ≡ yhub rss list -j（剥抓取时刻）',
      status === 200 && cli.code === 0 && hit === null,
      hit ?? `HTTP ${status} exit ${cli.code}`,
    )
  }

  // d) 配置：独立 Config 工具已退役（2026-10 统一到设置中心：/api/settings + 桌面壳 + 网页「配置」），
  //    所以这里不再有「CLI config ≡ HTTP」的对账；留一条断言防止 CLI 面悄悄长回来。
  {
    const { status, body } = await api('/api/settings')
    check(
      '配置：GET /api/settings 可用，且 CLI 已无 config 命令（独立 Config 工具已退役）',
      status === 200 && typeof body?.settings === 'object' && !commands.includes('config'),
      `HTTP ${status} commands=${commands.join(',')}`,
    )
  }

  // e) Memos（非核心插件）：以实际请求形态为准——200 → 数据对账；400 → 错误三通道对账
  if (commands.includes('memos')) {
    const http = await api('/api/memos?day=today&limit=100')
    const cli = yhub(['memos', 'list', 'today', '-j'])
    let parsed = null
    try { parsed = JSON.parse(cli.out) } catch { /* 下面报 */ }
    if (http.status === 200 && parsed?.ok === true) {
      const hit = diffPath(http.body, parsed)
      check(
        '对账 memos：GET /api/memos?day=today ≡ yhub memos list today -j',
        cli.code === 0 && hit === null,
        hit ?? `HTTP ${http.status} exit ${cli.code}`,
      )
    } else {
      const same = http.status === 400 && cli.code === 1
        && parsed?.ok === false && parsed?.error === http.body?.error
        && parsed?.hint === http.body?.hint
      check(
        '错误三通道 memos（未配置）：HTTP 400 ≡ CLI exit 1 + 同一份 {ok:false,error,hint}',
        same,
        `HTTP ${http.status} ${JSON.stringify(http.body)} | CLI ${cli.code} ${cli.out.trim().slice(0, 160)}`,
      )
    }
  }
}

// ---------------------------------------------------------------- main
try {
  const health = await api('/api/health')
  if (health.status !== 200) throw new Error(`/api/health -> ${health.status}`)
  await mcpHandshake()
  await reconcile()
} catch (err) {
  check('验收脚本自身跑通', false, String(err?.message ?? err))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) process.exit(1)
