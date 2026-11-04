// Transport-layer errors and hints raised by the frontend API/bridge modules (api.ts, tauriBridge.ts).
// Only errors the frontend itself constructs live here; text handed back by the backend is passed
// through verbatim and is never translated.
export const en = {
  // api.ts — request() transport classification
  'api.timeout.title': 'The local backend did not respond within {seconds} seconds ({path})',
  'api.timeout.hint':
    'The backend may be busy or stuck: retry in a moment. On desktop, check the status and logs under Settings → General → Backend bridge.',
  'api.network.title': 'Cannot reach the local backend ({path})',
  'api.network.hint.desktop':
    'The desktop app first tries to start the installed yhub. If the backend is not installed, run in a terminal: uv tool install yhub (or make install-backend), then click "Check again". For details see ~/.config/yhub/logs/desktop.log',
  'api.network.hint.browser':
    'The backend may not be up yet or has already exited. In the browser, start it first with uv run yhub gui --no-open',
  'api.badResponse.title': 'Unexpected API response (HTTP {status}, the body is not JSON)',
  'api.badResponse.hint':
    'The backend may have crashed; on desktop, check the stack traces in the backend log under Settings → General → Backend bridge.',
  'api.requestFailed': 'Request failed (HTTP {status})',

  // api.ts — endpoints that read a non-envelope body
  'api.report.readFailed': 'Could not read the report (HTTP {status})',
  'api.capsules.listFailed': 'Could not read the capsules in your library (HTTP {status})',

  // tauriBridge.ts — commands that only exist in the desktop shell
  'bridge.launchApp.desktopOnly': 'Launching Mac apps directly requires the desktop app',
  'bridge.settings.desktopOnly': 'Settings can only be changed in the desktop app',
  'bridge.openCapsule.desktopOnly':
    'Opening in the browser is desktop-only (the browser preview is read-only)',
  'bridge.reveal.desktopOnly': 'Show in Folder is desktop-only',
}

export const zhCN = {
  // api.ts — request() transport categories
  'api.timeout.title': '本地后端 {seconds} 秒没有响应（{path}）',
  'api.timeout.hint': '后端可能在忙或卡住了：稍后重试；桌面端可在「设置 → 通用 → 后端桥接」看状态与日志',
  'api.network.title': '连不上本地后端（{path}）',
  'api.network.hint.desktop':
    '桌面端会先尝试拉起已安装的 yhub。没装后端时，在终端运行：uv tool install yhub（或 make install-backend），然后点「重新检测」。详细原因见 ~/.config/yhub/logs/desktop.log',
  'api.network.hint.browser':
    '后端可能还没起来或已经退出。浏览器态请先跑 uv run yhub gui --no-open',
  'api.badResponse.title': '接口返回异常（HTTP {status}，响应不是 JSON）',
  'api.badResponse.hint': '后端可能崩了；桌面端可在「设置 → 通用 → 后端桥接」看后端日志里的堆栈',
  'api.requestFailed': '请求失败（HTTP {status}）',

  // api.ts — endpoints that read the raw body
  'api.report.readFailed': '读报告失败（HTTP {status}）',
  'api.capsules.listFailed': '读取库里的胶囊失败（HTTP {status}）',

  // tauriBridge.ts — commands available only in the desktop shell
  'bridge.launchApp.desktopOnly': '直接启动 Mac 应用程序需要在桌面端运行',
  'bridge.settings.desktopOnly': '设置只能在桌面端修改',
  'bridge.openCapsule.desktopOnly': '用浏览器打开只能在桌面端使用（浏览器预览态只读）',
  'bridge.reveal.desktopOnly': '在文件夹中显示只能在桌面端使用',
}
