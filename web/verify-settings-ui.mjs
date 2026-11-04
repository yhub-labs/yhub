// 设置界面的「真桌面契约」验证：在无头 Chrome 里把 Tauri 的 IPC 换成桩，
// 让 isTauri() 为 true，然后按真实点击路径走一遍读取 / 单项恢复 / 整段恢复，
// 断言界面发出的 IPC 命令名与参数形状和 `tauri/src/commands.rs` 的约定一致。
//
// 为什么需要它：macOS 上没有可用的 webview WebDriver，桌面壳里"点一下按钮"这一环
// 无法自动化（见 docs/gui-development.md 环境事实）。Rust 侧的读写/校验/迁移由
// `tauri/scripts/verify-settings-parity.sh` + `cargo test` 覆盖；这个脚本补的是**界面 ↔ IPC 契约**：
// 命令名、`{key, value}` 参数形状、写后返回的完整设置是否被界面采纳。
//
// 用法（先起后端 + 构建前端）：
//   uv run yhub gui --no-open &
//   cd web && npm run build && node verify-settings-ui.mjs
//
// 桩里刻意放了一组"非默认值"，这样"恢复默认"能被观察到：写后界面必须显示默认值。

import { chromium } from 'playwright-core'

const URL = process.env.YHUB_GUI_URL ?? 'http://127.0.0.1:8790/'
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
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|frame-ancestors|status of 404/.test(m.text())) errors.push(m.text())
})

// ---- Tauri IPC 桩：按 commands.rs / config.rs 的契约实现（含默认值、点号路径、null=恢复默认）
await page.addInitScript(() => {
  localStorage.setItem('yhub.lang', 'zh-CN')
  const DEFAULTS = {
    version: 1,
    // 三个动作：toggle_panel 有默认组合键，另两个默认不绑定（与 config.rs 的 HOTKEY_ACTIONS 一致）
    hotkeys: { toggle_panel: 'Option+Space', show_panel: '', hide_panel: '' },
    tray: {
      close_behavior: 'hide',
      left_click: 'toggle_panel',
      double_click: 'none',
      show_on_start: false,
      show_notifications: false,
    },
    capsules_dir: '',
    capsules_subdomains: false,
    capsules_subdomains_overrides: {},
  }
  // 组合键等价判定：与书写顺序 / 别名 / 大小写无关（与 Rust 侧 config::same_combo 一致，
  // 因为"Cmd+Shift+K"和"Shift+Cmd+K"在系统层面是同一个键）
  const MOD_ALIASES = {
    ctrl: 'Ctrl',
    control: 'Ctrl',
    option: 'Option',
    alt: 'Option',
    shift: 'Shift',
    cmd: 'Cmd',
    command: 'Cmd',
    super: 'Cmd',
    cmdorctrl: 'Cmd',
    cmdorcontrol: 'Cmd',
    commandorctrl: 'Cmd',
    commandorcontrol: 'Cmd',
  }
  const MOD_ORDER = ['Ctrl', 'Option', 'Shift', 'Cmd']
  const normCombo = (combo) => {
    const mods = new Set()
    const keys = []
    for (const raw of String(combo).split('+')) {
      const token = raw.trim()
      if (!token) continue
      const mod = MOD_ALIASES[token.toLowerCase()]
      if (mod) mods.add(mod)
      else keys.push(token)
    }
    // 修饰键固定顺序，否则"顺序不同"会漏判成两个不同的键
    return [...MOD_ORDER.filter((mod) => mods.has(mod)), ...keys].join('+')
  }

  const SCHEMA = {
    version: 1,
    keys: [
      'version',
      'hotkeys',
      'hotkeys.toggle_panel',
      'hotkeys.show_panel',
      'hotkeys.hide_panel',
      'tray',
      'tray.close_behavior',
      'tray.left_click',
      'tray.double_click',
      'tray.show_on_start',
      'tray.show_notifications',
      'capsules_dir',
    ],
    hotkey_actions: [
      { id: 'toggle_panel', name: '呼出 / 收起面板', default_combo: 'Option+Space' },
      { id: 'show_panel', name: '只呼出面板', default_combo: '' },
      { id: 'hide_panel', name: '只收起面板', default_combo: '' },
    ],
    tray_fields: [
      'close_behavior',
      'left_click',
      'double_click',
      'show_on_start',
      'show_notifications',
    ],
    close_behaviors: ['hide', 'quit'],
    click_behaviors: ['toggle_panel', 'show_menu', 'none'],
    defaults: JSON.parse(JSON.stringify(DEFAULTS)),
  }
  // 起点刻意非默认，方便观察"恢复默认"是否真的落库并回显
  let state = {
    version: 1,
    hotkeys: { toggle_panel: 'Cmd+Shift+K', show_panel: '', hide_panel: '' },
    tray: {
      close_behavior: 'quit',
      left_click: 'show_menu',
      double_click: 'none',
      show_on_start: true,
      show_notifications: false,
    },
    capsules_dir: '/Users/example/Y-Hub/capsules',
    capsules_subdomains: false,
    capsules_subdomains_overrides: {},
  }
  const calls = []
  window.__YHUB_IPC_CALLS__ = calls

  // ---- 事件系统桩：@tauri-apps/api 的 listen() 走 transformCallback + plugin:event|listen，
  //      这里按它的实现接住，并提供 __YHUB_EMIT__ 让测试模拟"后端 emit"（托盘菜单「设置…」那条路）。
  const callbacks = new Map()
  const listeners = new Map()
  let callbackSeq = 0
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    registerListener: () => {},
    unregisterListener: () => {},
  }
  window.__YHUB_EMIT__ = (event, payload) => {
    const ids = listeners.get(event) ?? []
    for (const id of ids) {
      const fn = window[`_${id}`]
      if (typeof fn === 'function') fn({ event, id, payload })
    }
    return ids.length
  }
  window.__YHUB_EVENT_LISTENERS__ = listeners

  const clone = (v) => JSON.parse(JSON.stringify(v))
  const getPath = (key) => key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), state)
  const defaultFor = (key) => key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), DEFAULTS)
  const setPath = (key, value) => {
    const parts = key.split('.')
    let cursor = state
    for (const part of parts.slice(0, -1)) cursor = cursor[part]
    cursor[parts[parts.length - 1]] = value
  }

  window.__TAURI_INTERNALS__ = {
    transformCallback: (callback, once = false) => {
      const id = ++callbackSeq
      callbacks.set(id, { callback, once })
      window[`_${id}`] = (payload) => {
        const entry = callbacks.get(id)
        if (!entry) return
        if (entry.once) {
          callbacks.delete(id)
          delete window[`_${id}`]
        }
        entry.callback(payload)
      }
      return id
    },
    invoke: async (cmd, args = {}) => {
      calls.push({ cmd, args: clone(args) })
      switch (cmd) {
        // 事件系统（App.tsx 订阅托盘菜单的「设置…」）
        case 'plugin:event|listen': {
          const list = listeners.get(args.event) ?? []
          list.push(args.handler)
          listeners.set(args.event, list)
          return args.handler
        }
        case 'plugin:event|unlisten':
          return null
        case 'get_settings':
          return clone(state)
        case 'set_setting': {
          // value = null → 该项默认值（与 config::set_in 一致）
          const next = args.value === null ? clone(defaultFor(args.key)) : clone(args.value)
          // 热键照 Rust 侧来：格式校验 / 已被别的动作占用 / 被系统占用 → 都是抛错且不落盘
          if (args.key.startsWith('hotkeys.')) {
            const action = args.key.slice('hotkeys.'.length)
            if (typeof next !== 'string') {
              throw new Error(`${args.key} 必须是字符串（留空字符串表示不绑定）`)
            }
            if (next === 'NotAKey') {
              throw new Error(`组合键 "${next}" 无法解析：形如 Option+Space、Cmd+Shift+K`)
            }
            // 模拟 macOS 层注册失败（被别的程序占用）——同样按解析后的值比对
            if (next !== '' && normCombo(next) === normCombo('Ctrl+Cmd+Shift+F9')) {
              throw new Error(`热键 ${next} 无效或被系统占用：RegisterEventHotKey failed`)
            }
            const holder = Object.entries(state.hotkeys).find(
              ([id, combo]) =>
                id !== action &&
                next.trim() !== '' &&
                normCombo(combo) === normCombo(next),
            )
            if (holder) {
              const name = SCHEMA.hotkey_actions.find((a) => a.id === holder[0])?.name ?? holder[0]
              throw new Error(
                `组合键 "${next}" 已经绑定给「${name}」，同一个组合键不能绑两个动作`,
              )
            }
          }
          setPath(args.key, next)
          return clone(state)
        }
        case 'reset_settings': {
          if (args.key == null) state = clone(DEFAULTS)
          else setPath(args.key, clone(defaultFor(args.key)))
          return clone(state)
        }
        case 'get_settings_schema':
          return clone(SCHEMA)
        case 'get_settings_path':
          return '/Users/example/.config/yhub/settings.json'
        case 'get_hotkey':
          return state.hotkeys.toggle_panel ?? ''
        case 'set_hotkey': {
          setPath('hotkeys.toggle_panel', args.hotkey)
          return state.hotkeys.toggle_panel
        }
        // 后端桥接：桌面端进设置**只探测不拉起**（见 tauri/src/backend.rs / Settings.tsx）。
        // 桩里给一份"已在跑、已安装 yhub"的状态，界面应当照实回显，而不是显示前端常量。
        case 'backend_status':
          return {
            port: 8790,
            running: true,
            healthy: true,
            source: 'installed',
            owned: true,
            pid: 4242,
            bin: null,
            version: '0.1.0',
            latency_ms: 3,
            started_at: 1700000000,
            error: null,
            hint: null,
            log_path: '/tmp/yhub/logs/backend.log',
          }
        // 其余宿主命令：给个合法空值，避免界面报错
        case 'get_apps':
        default:
          return null
      }
    },
  }

  // 桌面设置页的非壳键现在走 /api/settings（后端单一真源）。GET 用桩返回同一份 state，
  // 其余请求照常打到真实后端。
  const realFetch = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    const method = (init.method || (typeof input === 'string' ? 'GET' : input.method) || 'GET').toUpperCase()
    if (url.includes('/api/settings') && method === 'GET') {
      return new Response(JSON.stringify({
        ok: true,
        path: '/Users/example/.config/yhub/settings.json',
        settings: state,
        schema: SCHEMA,
        warnings: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return realFetch(input, init)
  }
})

const mainText = () => page.locator('main').innerText()

/** 等 <main> 里出现某个模式（正则） */
async function waitMain(pattern, timeout = 20000) {
  const deadline = Date.now() + timeout
  let text = ''
  while (Date.now() < deadline) {
    text = await mainText()
    if (pattern.test(text)) return text
    await page.waitForTimeout(200)
  }
  throw new Error(`等待 ${pattern} 超时；当前 main 文本：${text.slice(0, 200).replace(/\n/g, ' ')}`)
}

const ipcCalls = () => page.evaluate(() => window.__YHUB_IPC_CALLS__)

/**
 * 热键分区里某个动作的整行。
 * 用行容器（`[data-hotkey-row]` —— 比 div.px-5 这类版式类稳：间距/内边距改了不该让契约测试红），
 * 按动作名定位；行内的 flex 子块也带 flex 类，只靠 div.flex 会取到内层、拿不到行内的错误提示。
 */
const hotkeyRow = (name) => page.locator('main [data-hotkey-row]', { hasText: name }).first()

/**
 * 行文本：键帽是 flex 里的独立 <kbd>，innerText 会在它们之间插换行，
 * 所以统一把连续空白压成单个空格再断言（否则 "⌃ ⇧ F9" 永远匹配不上）。
 */
const rowText = async (row) => (await row.innerText()).replace(/\s+/g, ' ').trim()

/** <main> 文本的空白压平版：flex 里的独立 <kbd> 键帽之间会插换行，断言前统一压成空格 */
const mainFlat = async () => (await mainText()).replace(/\s+/g, ' ')

/**
 * 真实按下一组组合键：修饰键按下 → 普通键 → 松开修饰键。
 * 中间留一点时间（键盘事件和界面重渲染之间需要一帧）。
 */
async function pressCombo(mods, key) {
  for (const mod of mods) {
    await page.keyboard.down(mod)
    await page.waitForTimeout(60)
  }
  await page.keyboard.press(key)
  await page.waitForTimeout(60)
  for (const mod of [...mods].reverse()) await page.keyboard.up(mod)
  await page.waitForTimeout(120)
}

try {
  await page.goto(`${URL}?view=settings`, { waitUntil: 'networkidle' })

  // 1) 桌面态读取：真实值渲染出来（不是前端常量）
  let text = await waitMain(/当前配置速览/)
  check('桌面态：不再显示"浏览器预览态"提示', !/浏览器预览态/.test(text))
  check('读取：设置版本来自 get_settings', /v1/.test(text), text.split('\n')[0])
  check(
    '读取：配置文件路径来自 get_settings_path',
    /\/Users\/example\/\.config\/yhub\/desktop\.json/.test(text),
  )
  check('读取：热键按组合键格式化显示（⌘ ⇧ K）', /⌘ ⇧ K/.test(text))
  check('读取：托盘行为按枚举文案显示（弹出菜单 / 退出程序）', /弹出菜单/.test(text) && /退出程序/.test(text))
  check('读取：库里的胶囊目录来自 get_settings', /Y-Hub\/capsules/.test(text))

  const readCalls = await ipcCalls()
  check(
    'IPC 契约：壳键读取走 get_settings / get_settings_path（其余键走 /api/settings）',
    ['get_settings', 'get_settings_path'].every((cmd) =>
      readCalls.some((c) => c.cmd === cmd),
    ) && !readCalls.some((c) => c.cmd === 'get_settings_schema'),
    readCalls.map((c) => c.cmd).join(','),
  )

  // 1b) 后端桥接卡片：进设置**只探测**后端（backend_status），绝不顺手拉起（backend_ensure）。
  //     界面里不能出现 shell / HTTP 细节，显示的数据必须来自后端自报（桩里给的是 installed/0.2.0）。
  text = await waitMain(/运行中/)
  const bridgeCalls = await ipcCalls()
  check(
    '通用分区出现「后端桥接」卡片（写明默认端口）',
    /后端桥接/.test(text) && /127\.0\.0\.1:8790/.test(text),
  )
  check(
    'IPC 契约：进设置只探测后端（backend_status 有、backend_ensure 没有）',
    bridgeCalls.some((c) => c.cmd === 'backend_status') &&
      !bridgeCalls.some((c) => c.cmd === 'backend_ensure'),
    bridgeCalls.map((c) => c.cmd).join(','),
  )
  check(
    '后端桥接卡片照实回显（运行中 / 已安装 yhub / 端口 8790）',
    /运行中/.test(text) && /已安装的 yhub/.test(text) && /8790/.test(text),
  )

  // 2) 单项恢复默认：set_setting(key, null) → 界面采纳写后返回值
  await page.locator('details summary').click()
  const row = page.locator('details div.flex', { hasText: '左键单击' }).first()
  check('单项重置行存在（左键单击 = 弹出菜单）', (await row.innerText()).includes('弹出菜单'))
  await row.locator('button').click()
  text = await waitMain(/已恢复默认：左键单击/)

  const afterOne = await ipcCalls()
  const one = afterOne.find((c) => c.cmd === 'set_setting')
  check(
    'IPC 契约：单项恢复 = set_setting {key, value:null}',
    !!one && one.args.key === 'tray.left_click' && one.args.value === null,
    one ? JSON.stringify(one.args) : '没有发出 set_setting',
  )
  const rowAfter = await row.innerText()
  check('写后回显：该项变成默认值「呼出 / 收起面板」', rowAfter.includes('呼出 / 收起面板'), rowAfter)
  check('写后回显：其它项不受影响（关闭窗口时仍是退出程序）', /退出程序/.test(text))

  // 3) 热键分区：动作表全部来自 schema；录制写入走 set_setting；冲突 / 无效 / 系统占用就地提示
  await page.locator('nav button', { hasText: '热键' }).click()
  text = await waitMain(/全局快捷键/)
  check(
    '热键分区：动作表来自 schema（三个动作都渲染出来）',
    ['呼出 / 收起面板', '只呼出面板', '只收起面板'].every((name) => text.includes(name)),
  )
  check('热键分区：当前组合键格式化为符号（⌘ ⇧ K）', /⌘ ⇧ K/.test(await mainFlat()))
  check('热键分区：默认不绑定的动作显示「未绑定」', /未绑定/.test(text))

  const toggleRow = hotkeyRow('呼出 / 收起面板')
  const showRow = hotkeyRow('只呼出面板')
  const hideRow = hotkeyRow('只收起面板')

  // 3a) 录制：⌃ ⇧ F9 → set_setting('hotkeys.hide_panel', 'Ctrl+Shift+F9')，写后立刻回显
  await hideRow.locator('button', { hasText: '录制' }).click()
  check('录制态：提示按下组合键', /按下组合键/.test(await mainText()))
  await pressCombo(['Control', 'Shift'], 'F9')
  await waitMain(/已绑定：只收起面板/)
  const bindCall = (await ipcCalls()).find(
    (c) => c.cmd === 'set_setting' && c.args.key === 'hotkeys.hide_panel',
  )
  check(
    'IPC 契约：录制写入 = set_setting {key:"hotkeys.hide_panel", value:"Ctrl+Shift+F9"}',
    !!bindCall && bindCall.args.value === 'Ctrl+Shift+F9',
    bindCall ? JSON.stringify(bindCall.args) : '没有发出 set_setting',
  )
  check('写后回显：该行显示 ⌃ ⇧ F9', /⌃ ⇧ F9/.test(await rowText(hideRow)), await rowText(hideRow))
  check('录制结束：提示消失', !/按下组合键/.test(await mainText()))

  // 3b) 本程序内部冲突：把已绑给「呼出 / 收起面板」的 ⌘ ⇧ K 录给「只呼出面板」
  //     （⌘ ⇧ K 与配置里的 Cmd+Shift+K 写法不同，但系统层面是同一个键，必须照样判冲突）
  const beforeConflict = (await ipcCalls()).length
  await showRow.locator('button', { hasText: '录制' }).click()
  await pressCombo(['Meta', 'Shift'], 'K')
  await page.waitForTimeout(200)
  check(
    '冲突提示：就地说明这个组合键已绑给哪个动作',
    /已经绑定给「呼出 \/ 收起面板」/.test(await rowText(showRow)),
    await rowText(showRow),
  )
  check('冲突时不动绑定：仍停在录制态（没有偷偷写进去）', /按下组合键/.test(await rowText(showRow)))
  check('冲突时本地拦截，不发 IPC', (await ipcCalls()).length === beforeConflict)

  // 3c) 被系统占用：后端注册失败 → 行内就地显示后端的人话错误，绑定不变
  await pressCombo(['Control', 'Meta', 'Shift'], 'F9')
  await page.waitForTimeout(200)
  check(
    '系统占用：行内就地显示后端错误',
    /无效或被系统占用/.test(await rowText(showRow)),
    await rowText(showRow),
  )
  check('系统占用：仍停在录制态（旧值不变）', /按下组合键/.test(await rowText(showRow)))

  // 3d) 无效组合键：缺修饰键 / 后端解析不了的键 都被拒绝
  await showRow.locator('button', { hasText: '取消' }).click() // 退出上一步的录制态
  await showRow.locator('button', { hasText: '录制' }).click()
  const beforeInvalid = (await ipcCalls()).length
  await page.keyboard.press('F9')
  await page.waitForTimeout(150)
  check('无效组合键：只按普通键（无修饰键）被拒绝', /至少要有一个/.test(await rowText(showRow)))
  await page.keyboard.press('AudioVolumeUp')
  await page.waitForTimeout(150)
  check('无效组合键：后端解析不了的键被拒绝', /不支持绑定/.test(await rowText(showRow)))
  check('无效组合键没有产生写入', (await ipcCalls()).length === beforeInvalid)

  // 3e) ESC 取消录制：录制控件自己吃掉 ESC，设置界面不会返回上一个视图
  await page.keyboard.press('Escape')
  text = await mainText()
  check('ESC 取消录制：录制态消失', !/按下组合键/.test(text))
  check('ESC 被录制控件吃掉：仍停在设置界面', /全局快捷键/.test(text) && /只呼出面板/.test(text))
  check(
    '冲突 / 系统占用都没改动绑定：取消后该行仍是「未绑定」',
    /未绑定/.test(await rowText(showRow)),
    await rowText(showRow),
  )

  // 3f) 清除绑定 = 写空字符串；恢复默认 = reset_settings 单项
  await hideRow.locator('button', { hasText: '清除' }).click()
  await waitMain(/已清除绑定：只收起面板/)
  const clearCall = (await ipcCalls())
    .filter((c) => c.cmd === 'set_setting' && c.args.key === 'hotkeys.hide_panel')
    .pop()
  check(
    'IPC 契约：清除 = set_setting {key:"hotkeys.hide_panel", value:""}',
    !!clearCall && clearCall.args.value === '',
    clearCall ? JSON.stringify(clearCall.args) : '没有发出 set_setting',
  )
  check('清除后回显「未绑定」', /未绑定/.test(await rowText(hideRow)))

  await toggleRow.locator('button', { hasText: '恢复默认' }).click()
  await waitMain(/已恢复默认：呼出 \/ 收起面板/)
  const resetOne = (await ipcCalls())
    .filter((c) => c.cmd === 'reset_settings' && c.args.key === 'hotkeys.toggle_panel')
    .pop()
  check(
    'IPC 契约：恢复默认 = reset_settings {key:"hotkeys.toggle_panel"}',
    !!resetOne,
    resetOne ? JSON.stringify(resetOne.args) : '没有发出 reset_settings',
  )
  check('恢复默认后回显默认组合键 ⌥ Space', /⌥ Space/.test(await rowText(toggleRow)))

  // 4) 整段恢复：reset_settings(key) 与 reset_settings(null)
  //    「全部恢复默认」按钮在通用分区；「全部恢复默认」会先弹二次确认：先挂上接受对话框的处理器，再点按钮
  await page.locator('nav button', { hasText: '通用' }).click()
  await waitMain(/当前配置速览/)
  const beforeResetAll = (await ipcCalls()).length
  page.on('dialog', (dialog) => void dialog.accept())
  await page.locator('main button', { hasText: '全部恢复默认' }).first().click()
  await waitMain(/已恢复默认：全部设置/)

  const allCalls = await ipcCalls()
  // 从点击前的位置往后找：前面单项恢复也发过 reset_settings
  const resetAll = allCalls.slice(beforeResetAll).find((c) => c.cmd === 'reset_settings')
  check(
    'IPC 契约：全部恢复 = reset_settings {key:null}',
    !!resetAll && resetAll.args.key === null,
    resetAll ? JSON.stringify(resetAll.args) : '没有发出 reset_settings',
  )
  text = await mainText()
  check(
    '整段恢复后回显默认值（⌥ Space / 隐藏面板 / 库里的胶囊回到未设置）',
    /⌥ Space/.test(text) && /隐藏面板/.test(text) && /库里的胶囊/.test(text),
  )

  // 4) 托盘分区：控件渲染真实值 + 写入走 set_setting（下拉框 / 开关），可选值来自 schema
  await page.locator('aside button', { hasText: '托盘' }).first().click()
  text = await waitMain(/窗口与菜单栏/)
  const closeSelect = page.locator('select[aria-label="关闭窗口时"]')
  const leftSelect = page.locator('select[aria-label="左键单击"]')
  const notifySwitch = page.locator('button[role="switch"][aria-label="显示托盘通知"]')
  check('托盘分区渲染三个下拉/开关控件', (await closeSelect.count()) === 1 && (await leftSelect.count()) === 1 && (await notifySwitch.count()) === 1)
  check('托盘控件读的是 get_settings 的值（整段恢复后是默认值）', (await closeSelect.inputValue()) === 'hide' && (await leftSelect.inputValue()) === 'toggle_panel', `${await closeSelect.inputValue()} / ${await leftSelect.inputValue()}`)
  check(
    '托盘下拉框的可选值来自 schema.close_behaviors / click_behaviors',
    (await closeSelect.locator('option').allInnerTexts()).join('|') === '隐藏面板（进程留在菜单栏）|退出程序' &&
      (await leftSelect.locator('option').allInnerTexts()).join('|') === '呼出 / 收起面板|弹出菜单|不响应',
  )

  await closeSelect.selectOption('quit')
  text = await waitMain(/已保存：关闭窗口时/)
  const trayCalls = await ipcCalls()
  const closeCall = trayCalls.filter((c) => c.cmd === 'set_setting').pop()
  check(
    'IPC 契约：下拉框写入 = set_setting {key:"tray.close_behavior", value:"quit"}',
    !!closeCall && closeCall.args.key === 'tray.close_behavior' && closeCall.args.value === 'quit',
    closeCall ? JSON.stringify(closeCall.args) : '没有发出 set_setting',
  )
  check('写后回显：下拉框变成「退出程序」', (await closeSelect.locator('option:checked').innerText()) === '退出程序')

  await notifySwitch.click()
  await waitMain(/已保存：显示托盘通知/)
  const notifyCall = (await ipcCalls()).filter((c) => c.cmd === 'set_setting').pop()
  check(
    'IPC 契约：开关写入 = set_setting {key:"tray.show_notifications", value:true}',
    !!notifyCall && notifyCall.args.key === 'tray.show_notifications' && notifyCall.args.value === true,
    notifyCall ? JSON.stringify(notifyCall.args) : '没有发出 set_setting',
  )
  check('写后回显：开关变成「开」', (await notifySwitch.innerText()).trim() === '开')

  // 5) 托盘菜单「设置…」：Rust 侧 emit('yhub:open-settings','tray') → 界面切到设置/托盘分区
  check(
    '界面订阅了 yhub:open-settings（托盘菜单入口的前提）',
    (await page.evaluate(() => Array.from(window.__YHUB_EVENT_LISTENERS__.keys()))).includes('yhub:open-settings'),
  )
  await page.locator('aside button', { hasText: '返回工作台' }).first().click()
  await waitMain(/桌面|汉典|固定窗口/)
  const delivered = await page.evaluate(() => window.__YHUB_EMIT__('yhub:open-settings', 'tray'))
  // 等**要断言的字段行**（「关闭窗口时」，来自 schema.tray_fields），不要等卡片标题
  // （「窗口与菜单栏」是写死的 SectionCard title）：设置外壳每次回到设置视图都会重新 invoke 一次
  // get_settings_schema，标题先画、字段行晚一帧才到，等标题会把断言放过去（实测偶发 62/63）。
  text = await waitMain(/关闭窗口时/)
  check('托盘菜单「设置…」事件送达（有监听者）', delivered > 0, `监听者 ${delivered}`)
  check('事件把界面切到设置视图的托盘分区', /关闭窗口时/.test(text) && /托盘菜单入口/.test(text))

  check('无 JS 运行时报错', errors.length === 0, errors.slice(0, 2).join(' / '))
} catch (e) {
  check('设置界面契约验证跑完', false, String(e).slice(0, 300))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length ? 1 : 0)
