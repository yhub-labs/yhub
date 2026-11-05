#!/usr/bin/env bash
#
# 装机版 .app 的端到端验收：**装到干净路径、启动真 App、跑真后端**，把
# 「打包配置对不对」与「桥接好不好用」这两件事在真产物上逐条断言出来。
#
# 后端**不在包里**：App 启动时按「复用已有服务 → 已安装 yhub → uv run」找后端。
# 本脚本事先造一个 `uv run yhub` 包装脚本并用 YHUB_BACKEND_BIN 指给 App，
# 保证验的是**当前源码树**，而不是机器上某个旧版 yhub。
#
#   ./tauri/scripts/verify-packed-app.sh                       # 验收 release 装机包
#   ./tauri/scripts/verify-packed-app.sh path/to/Y-Hub.app    # 验收指定 .app（debug 包也行）
#
# ⚠️ 验收对象是**已经打好的那个 .app**（默认 tauri/target/release/bundle/macos/Y-Hub.app），
# 本脚本不会替你构建。改完代码没重新 `make app` 就来验，验的是上一版产物 —— 症状是「源码里明明
# 有的工具/接口在包里没有」这类 FAIL。
#
# 与另外两个脚本的分工（别重复实现）：
#   * packaging/verify-backend.sh        —— 只看「Python 后端本身」的业务正确性（源码树或已安装版）
#   * tauri/scripts/verify-backend-bridge.sh —— 只看「桥接逻辑」（用假后端，快而稳）
#   * 本脚本                             —— 看「装完的 App」：落点/签名/体积/已安装后端真被用上/
#                                          冷启动耗时/真业务数据/切前后台/网络异常/退出不留孤儿
#
# 安全性：所有用例都用 YHUB_CONFIG_DIR 指向临时目录（绝不读写 ~/.yhub/），
# 端口一律用随机空闲端口（不碰开发机上常驻的 8790 后端）。
#
# 静默启动：所有用例默认带 YHUB_SELFTEST_HIDDEN=1（App 不显示面板、不注册全局热键），
# 只有专测「面板显隐 / 热键」的 4a / 4b 显式写 YHUB_SELFTEST_HIDDEN=0。
# 想回到「每个用例都弹面板」的老行为：YHUB_SELFTEST_HIDDEN=0 ./verify-packed-app.sh。
#
# 互斥：本脚本启动时会拿 /tmp/yhub-app-test.lock（见 app-test-lock.sh），
# 与其它「会启动 app 的验证脚本」串行 —— 两个 worker 并发时不会一起反复弹窗。
#
#   KEEP_DIR=…    把程序日志、后端日志、报告留一份到这个目录（默认随临时目录删掉）
#   INSTALL_ROOT=…  安装落点（默认 <repo>/build/install）
#   APP_TIMEOUT=…   每个用例最多等多少秒（默认 60）

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# 机器级互斥：同一时刻只允许一个「会启动 app 的验证脚本」在跑。
# 并发跑两个时，第二个会在这里排队等锁，而不是跟着一起反复启动 app（否则就是「疯狂弹窗」）。
source "$SCRIPT_DIR/app-test-lock.sh"
yhub_app_test_lock "$0" "$@"

APP="${1:-$REPO_ROOT/tauri/target/release/bundle/macos/Y-Hub.app}"
APP="$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"
INSTALL_ROOT="${INSTALL_ROOT:-$REPO_ROOT/build/install}"
INSTALLED="$INSTALL_ROOT/$(basename "$APP")"
APP_TIMEOUT="${APP_TIMEOUT:-60}"
REPORT="$REPO_ROOT/build/packed-app-verify.json"
KEEP_DIR="${KEEP_DIR:-}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
PASS=0
FAIL=0
KNOWN=0
ok() { PASS=$((PASS + 1)); echo "  PASS  $1"; }
no() { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; }
# 已知问题（xfail）：结果确实是错的，但**已定位、已归因、已写进问题清单**，不作为本卡验收失败。
# 将来上游修好了，这条断言会以 PASS 出现（xpass），能被发现。
known() { KNOWN=$((KNOWN + 1)); echo "  KNOWN $1"; }
check() { # check <描述> <期望> <实际>
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1（期望 [$2]，实际 [$3]）"; fi
}
has() { # has <日志文件> <正则> → yes/no
  if grep -qE -- "$2" "$1" 2>/dev/null; then echo yes; else echo no; fi
}
grep1() { grep -oE -- "$2" "$1" 2>/dev/null | head -1; }

PY="$(command -v python3)"
[ -n "$PY" ] || { echo "找不到 python3" >&2; exit 1; }

# 后端自报的版本来自这棵树（yhub/__init__.py 是唯一真源）。原来这里写死过 0.4.0，
# 版本一变这两条断言就永远红 —— 断言的是「自报版本 == 这棵树的版本」，不是某个字面量。
TREE_VERSION="$(grep -m1 '^__version__' "$REPO_ROOT/yhub/__init__.py" | cut -d'"' -f2)"
TREE_VERSION_RE="$(printf '%s' "$TREE_VERSION" | sed 's/\./\\./g')"
[ -n "$TREE_VERSION" ] || { echo "读不到 yhub/__init__.py 的 __version__" >&2; exit 1; }

# 本脚本自己起的进程（退出时兜底清理，绝不留下孤儿）
APP_PIDS=""
cleanup() {
  for p in $APP_PIDS; do kill "$p" 2>/dev/null; done
  sleep 0.3
  for p in $APP_PIDS; do kill -9 "$p" 2>/dev/null; done
  # 兜底：把「本脚本装的那份产物」拉起的后端一起收掉。
  # 这不是洁癖：App 被 SIGTERM 杀掉时它的退出钩子不跑，自启后端会变孤儿继续占端口（见 docs）。
  for p in $(pgrep -f "$INSTALL_ROOT" 2>/dev/null); do kill "$p" 2>/dev/null; done
  sleep 0.3
  for p in $(pgrep -f "$INSTALL_ROOT" 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
  rm -rf "$TMP"
}
TMP="$(mktemp -d "${TMPDIR:-/tmp}/yhub-packed-verify.XXXXXX")"
trap cleanup EXIT

# 让被测 App 用**当前源码树**的后端。
# 优先用 .venv 里的 console script：它和真实安装一样是「直接子进程 = 监听者」，
# 不会多一层 shell（否则「后端是 App 的直接子进程」这条断言会假失败）。
if [ -x "$REPO_ROOT/.venv/bin/yhub" ]; then
  VERIFY_YHUB_WRAPPER="$REPO_ROOT/.venv/bin/yhub"
else
  VERIFY_YHUB_WRAPPER="$TMP/yhub-dev.sh"
  cat >"$VERIFY_YHUB_WRAPPER" <<EOF
#!/bin/sh
cd "$REPO_ROOT" && exec uv run yhub "\$@"
EOF
  chmod +x "$VERIFY_YHUB_WRAPPER"
fi

free_port() {
  "$PY" - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

http_code() { curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 10 "$1" 2>/dev/null; }
http_ready() { curl -sf --noproxy '*' --max-time 3 "$1/api/health" >/dev/null 2>&1; }

port_alive() {
  "$PY" - "$1" <<'PY'
import socket, sys
s = socket.socket(); s.settimeout(0.4)
try:
    s.connect(("127.0.0.1", int(sys.argv[1]))); print("yes")
except OSError:
    print("no")
finally:
    s.close()
PY
}

pid_alive() { if kill -0 "$1" 2>/dev/null; then echo yes; else echo no; fi; }

ppid_of() { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; }

# 启动一个「真 App 实例」：隔离配置目录 + 指定端口（+ 追加环境变量），日志回落盘。
# 用法：launch_app <日志名> <端口> <配置目录名> [额外 env…]（"KEY=VALUE" 形式）
#
# 默认带 YHUB_SELFTEST_HIDDEN=1：App 静默启动（不显示面板、不注册全局热键），屏幕上不会弹窗。
# 额外 env 排在后面，所以「专测面板显隐/热键」的用例写 YHUB_SELFTEST_HIDDEN=0 就能盖掉它。
launch_app() {
  local name="$1" port="$2" cfgname="$3"; shift 3
  CFG="$TMP/$cfgname"
  mkdir -p "$CFG"
  APP_LOG="$TMP/$name.log"
  : >"$APP_LOG"
  env YHUB_CONFIG_DIR="$CFG" YHUB_BACKEND_PORT="$port" YHUB_LANG=zh-CN \
    YHUB_BACKEND_BIN="${YHUB_BACKEND_BIN:-$VERIFY_YHUB_WRAPPER}" \
    YHUB_SELFTEST_HIDDEN="${YHUB_SELFTEST_HIDDEN:-1}" "$@" \
    "$INSTALLED/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$INSTALLED/Contents/Info.plist")" \
    >>"$APP_LOG" 2>&1 &
  APP_PID=$!
  APP_PIDS="$APP_PIDS $APP_PID"
}

stop_app() { # stop_app：按用户路径之外的方式收尾（SIGTERM），并等它真的退出
  [ -n "${APP_PID:-}" ] || return 0
  kill "$APP_PID" 2>/dev/null
  local i=0
  while kill -0 "$APP_PID" 2>/dev/null && [ "$i" -lt 60 ]; do sleep 0.1; i=$((i + 1)); done
  kill -9 "$APP_PID" 2>/dev/null
  wait "$APP_PID" 2>/dev/null
  return 0
}

# 等 app 自己退出（自检模式会自己 app.exit），返回 "存活 退出码"
wait_app() {
  local start t
  start=$(date +%s)
  while kill -0 "$APP_PID" 2>/dev/null; do
    t=$(( $(date +%s) - start ))
    if [ "$t" -ge "$APP_TIMEOUT" ]; then WAIT_ALIVE=1; WAIT_CODE="timeout"; return 0; fi
    sleep 0.3
  done
  WAIT_ALIVE=0
  wait "$APP_PID" 2>/dev/null
  WAIT_CODE=$?
  APP_PIDS="$(echo "$APP_PIDS" | tr ' ' '\n' | grep -v "^$APP_PID\$" | tr '\n' ' ')"
  return 0
}

common_selftest_checks() { # common_selftest_checks <用例名> <日志>
  # 两种收尾约定都认：后端桥接自检打印 `[selftest] done failures=0`，热键自检打印 `[selftest] PASS`。
  if grep -qE '\[selftest\] done failures=0|\[selftest\] PASS' "$2" 2>/dev/null; then
    ok "$1：自检跑完且全绿"
  else
    no "$1：自检没有以「全绿」收尾（期望 done failures=0 或 PASS）"
  fi
  check "$1：没有 FAIL 行" no "$(has "$2" '\[selftest\] .* FAIL$')"
  check "$1：进程自行退出（存活=0）" 0 "$WAIT_ALIVE"
  check "$1：退出码 0" 0 "$WAIT_CODE"
}

echo "验收对象：$APP"
[ -d "$APP" ] || { echo "找不到 .app：${APP}（先跑 make app）" >&2; exit 1; }

# ---------------------------------------------------------------- 0. 落点 / 签名 / 结构

say "0/7 打包配置复核（落点、签名、体积、没有内嵌 Python 运行时）"
EXE_NAME="$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null)"
EXE="$APP/Contents/MacOS/$EXE_NAME"
[ -x "$EXE" ] && ok "可执行文件在 Contents/MacOS/$EXE_NAME" || no "找不到可执行文件 $EXE"

# 新约定：包里**不该**再有 Python 运行时/冻结后端。它只会让包变大、让插件生态锁死。
[ -e "$APP/Contents/Resources/backend" ] \
  && no "包里仍有 Resources/backend —— 冻结后端没去掉（占体积、锁死插件生态）" \
  || ok "包里没有嵌入 Python 运行时（后端由已安装的 yhub 提供）"

# 第三方许可声明（THIRD-PARTY.md）是**分发义务**：装机包里必须有，且与仓库根那份逐字节相同。
# 它由 bundle.resources 带进包（映射形式 "../THIRD-PARTY.md" → "THIRD-PARTY.md"），
# 落点 Contents/Resources/THIRD-PARTY.md —— 为什么用映射形式见 docs/packaging.md。
TP_IN_APP="$(find "$APP/Contents/Resources" -maxdepth 2 -name 'THIRD-PARTY.md' -type f -print -quit)"
TP_SRC="$REPO_ROOT/THIRD-PARTY.md"
if [ -n "$TP_IN_APP" ]; then
  ok "第三方声明进了包：${TP_IN_APP#"$APP"/}"
else
  no "装机包里找不到 THIRD-PARTY.md（bundle.resources 少了它？）"
fi
if [ -n "$TP_IN_APP" ] && [ -f "$TP_SRC" ]; then
  check "包内 THIRD-PARTY.md == 仓库根那份（sha256）" \
    "$(shasum -a 256 "$TP_SRC" | awk '{print $1}')" \
    "$(shasum -a 256 "$TP_IN_APP" | awk '{print $1}')"
  # 图标声明按 THIRD-PARTY.md 里真实存在的那句话断言（英文原文 + 仓库内的绘制源目录）
  check "包内 THIRD-PARTY.md 带着图标自绘声明" yes \
    "$(grep -q 'original artwork drawn in this repository' "$TP_IN_APP" &&
       grep -q 'No third-party icon set is used' "$TP_IN_APP" && echo yes || echo no)"
LIC_IN_APP="$(find "$APP/Contents/Resources" -maxdepth 2 -name 'LICENSE' -type f -print -quit)"
check "MIT LICENSE 随包分发（许可义务）" yes \
  "$([ -n "$LIC_IN_APP" ] && echo yes || echo no)"
check "包内 LICENSE == 仓库根那份（sha256）" \
  "$(shasum -a 256 "$REPO_ROOT/LICENSE" | awk '{print $1}')" \
  "$(shasum -a 256 "${LIC_IN_APP:-/nonexistent}" | awk '{print $1}')"
else
  no "无法比对 THIRD-PARTY.md 哈希（源文件缺失：${TP_SRC}）"
fi

EMBEDDED_SHA=""

# 壳二进制：release 包对 target/release，debug 包对 target/debug。
# 这里**不能**直接比 sha256：bundler 会对塞进 .app 的那份做 codesign（实测日志里的
# "replacing existing signature"），签名 blob 变了哈希必然不同 —— 第一次跑本脚本时就踩到了。
# 换成两条能真正判「就是这次构建」的判据：桥接代码标记两边都在（正面例子：
# 共用 tauri/target 会让你验到别人分支的二进制，strings | grep 才是有效证据），
# 且 .app 里那份不比源二进制旧。
PROFILE_DIR=release
case "$APP" in */target/debug/*) PROFILE_DIR=debug ;; esac
SHELL_BIN="$REPO_ROOT/tauri/target/$PROFILE_DIR/$(basename "$EXE")"
if [ -x "$SHELL_BIN" ]; then
  MARKER="YHUB_DEBUG_BACKEND_SELFTEST"
  # 注意：这里不能用 `grep -q`（早退会让 strings 收到 SIGPIPE，pipefail 下管道变成 141，
  # 看起来就像「标记不存在」—— 第一次跑本脚本就是这么假 FAIL 的）。
  check "桥接代码标记在源二进制里（本卡改动确实编进去了）" 1 \
    "$([ "$(strings -a "$SHELL_BIN" | grep -c "$MARKER")" -gt 0 ] && echo 1 || echo 0)"
  check "桥接代码标记在 .app 的壳里（装的就是这份构建）" 1 \
    "$([ "$(strings -a "$EXE" | grep -c "$MARKER")" -gt 0 ] && echo 1 || echo 0)"
  if [ ! "$EXE" -ot "$SHELL_BIN" ]; then
    ok "打包产物的壳不比源二进制旧（打包发生在编译之后）"
  else
    no "打包产物比源二进制还旧 —— 验的可能是上一轮的 .app"
  fi
  SHELL_SHA="$(shasum -a 256 "$EXE" | awk '{print $1}')"
else
  no "找不到构建出的壳二进制：${SHELL_BIN}"
  SHELL_SHA=""
fi

codesign --verify --deep --strict "$APP" >/dev/null 2>&1
check "codesign --verify --deep --strict（资源一起被签名）" 0 "$?"
DR="$(codesign -dr - "$APP" 2>&1 | tr '\n' ' ')"
case "$DR" in
  *'certificate root'*) ok "签名身份是稳定证书（不是 ad-hoc cdhash，本地网络授权记得住）" ;;
  *) no "签名身份不是证书：$DR" ;;
esac
check "Info.plist 带 LSUIElement（Dock/Cmd+Tab 不出现）" true \
  "$(/usr/libexec/PlistBuddy -c 'Print LSUIElement' "$APP/Contents/Info.plist" 2>/dev/null)"
LND="$(/usr/libexec/PlistBuddy -c 'Print NSLocalNetworkUsageDescription' "$APP/Contents/Info.plist" 2>/dev/null)"
[ -n "$LND" ] && ok "Info.plist 声明了 NSLocalNetworkUsageDescription" || no "Info.plist 缺本地网络用途声明"

APP_BYTES=$(( $(du -sk "$APP" | awk '{print $1}') * 1024 ))
SHELL_BYTES=$(( $(du -sk "$APP/Contents/MacOS" | awk '{print $1}') * 1024 ))
RES_BYTES=$(( $(du -sk "$APP/Contents/Resources" | awk '{print $1}') * 1024 ))
BACKEND_BYTES=0
echo "  体积：.app $((APP_BYTES/1024/1024)) MB（壳 $((SHELL_BYTES/1024/1024)) MB + Resources $((RES_BYTES/1024/1024)) MB；不含 Python 运行时）"

# ---------------------------------------------------------------- 1. 安装

say "1/7 安装到干净路径（.app 的「安装」= 整包拷到目标位置）"
rm -rf "$INSTALLED"
mkdir -p "$INSTALL_ROOT"
cp -R "$APP" "$INSTALLED"
check "安装副本可执行文件存在" yes "$([ -x "$INSTALLED/Contents/MacOS/$EXE_NAME" ] && echo yes || echo no)"
check "安装副本里没有嵌入的 Python 运行时" no \
  "$([ -e "$INSTALLED/Contents/Resources/backend" ] && echo yes || echo no)"
codesign --verify --deep --strict "$INSTALLED" >/dev/null 2>&1
check "安装副本签名仍然有效（拷完没坏）" 0 "$?"
check "安装副本没有配隔离属性（本机打包无 com.apple.quarantine）" 0 \
  "$(xattr "$INSTALLED" 2>/dev/null | grep -c quarantine)"
check "安装副本与构建产物同哈希（壳二进制）" \
  "$(shasum -a 256 "$APP/Contents/MacOS/$EXE_NAME" | awk '{print $1}')" \
  "$(shasum -a 256 "$INSTALLED/Contents/MacOS/$EXE_NAME" | awk '{print $1}')"

# ---------------------------------------------------------------- 2. 冷启动 + 端到端业务

say "2/7 冷启动 → 真后端就绪 → 核心接口业务结果（真 App、真产物、隔离配置）"
PORT1="$(free_port)"
launch_app cold "$PORT1" config-cold
T0=$(date +%s.%N)
READY_AT=""
for _ in $(seq 1 300); do
  if http_ready "http://127.0.0.1:$PORT1"; then READY_AT=$(date +%s.%N); break; fi
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 0.1
done
if [ -n "$READY_AT" ]; then
  COLD_APP=$(awk -v a="$T0" -v b="$READY_AT" 'BEGIN{printf "%.2f", b-a}')
  ok "冷启动到后端可用：${COLD_APP}s（App 进程启动起算，外部探 /api/health）"
else
  COLD_APP=""
  no "冷启动超时：App 起来后没能等到后端就绪（日志：${APP_LOG}）"
  sed -n '1,20p' "$APP_LOG" | sed 's/^/        /'
fi
COLD_LOG="$APP_LOG"
COLD_CFG="$CFG"

# 外部探到 200 可能比 App 自己那行「后端就绪」日志早几毫秒（两个探针并行），先等这行落盘再断言，
# 否则会偶发假 FAIL（上一轮就踩到了：冷启动 0.99s，日志行还没写出来）。
for _ in $(seq 1 40); do
  grep -q '\[backend\] 后端就绪' "$COLD_LOG" 2>/dev/null && break
  sleep 0.1
done

BACKEND_LOG="$COLD_CFG/logs/backend.log"
DESKTOP_LOG="$COLD_CFG/logs/desktop.log"
check "用的是显式指定的 yhub（source=external，不是机器上随机一个旧版）" yes \
  "$(has "$COLD_LOG" "\[backend\] 拉起后端：.*source=external, port=$PORT1")"
check "桥接层记下了就绪（pid + 版本 + 首次响应耗时）" yes \
  "$(has "$COLD_LOG" "\\[backend\\] 后端就绪：pid=[0-9]+ source=external version=$TREE_VERSION_RE 首次响应 [0-9]+ ms")"
check "子进程 stdout/stderr 进了后端日志（可定位）" yes "$(has "$BACKEND_LOG" 'Uvicorn running on http://127\.0\.0\.1:'$PORT1)"
check "桌面端日志落盘（带时间戳）" yes "$(has "$DESKTOP_LOG" '^\[20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:]{8}\] 拉起后端：')"

RDY_PID="$(grep1 "$COLD_LOG" '后端就绪：pid=[0-9]+' | tr -dc '0-9')"
LISTEN_PID="$(lsof -nP -iTCP:"$PORT1" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ -n "$RDY_PID" ] && [ -n "$LISTEN_PID" ]; then
  # 真后端是 app 的子进程（不是「碰巧别人在跑」）：父进程必须是本用例的 App
  check "监听 $PORT1 的进程就是桥接层拉起的那个（pid=${RDY_PID}）" "$RDY_PID" "$LISTEN_PID"
  check "该后端是 App 的子进程（ppid=$(ppid_of "$LISTEN_PID")）" "$APP_PID" "$(ppid_of "$LISTEN_PID")"
else
  no "没能对上「桥接记录的后端 pid」与「端口监听者」（ready_pid=${RDY_PID:-空} listen_pid=${LISTEN_PID:-空}）"
fi

if [ -n "$READY_AT" ]; then
  "$PY" - "$PORT1" "$TMP/requests.json" "$TMP/expected-tools.txt" <<'PY' || no "核心接口业务断言未通过"
import json, sys, time, urllib.request, urllib.error

port = int(sys.argv[1])
base = f"http://127.0.0.1:{port}"
# 核心插件（随包分发）：rclone / rss / scheduler（dashboard 为内建能力型底座）
EXPECTED = ["rclone", "rss", "scheduler"]
# 把「应该有几个工具」交给后面的自检用例比对：加了新工具只需要改上面这一行，
# 不会出现「清单已经更新、另一处还硬编码旧数字」的腐烂（2026-09-28 踩过一次）。
if len(sys.argv) > 3:
    with open(sys.argv[3], "w") as fh:
        fh.write(str(len(EXPECTED)))
times = {}
ok = True

def get(path):
    t0 = time.perf_counter()
    with urllib.request.urlopen(base + path, timeout=30) as r:
        body = r.read()
        times[path] = round(time.perf_counter() - t0, 3)
        return r.status, body

def get_json(path):
    status, body = get(path)
    assert status == 200, f"{path} -> HTTP {status}"
    return json.loads(body)

def line(verdict, text):
    print(f"  {verdict}  {text}")
    return verdict == "PASS"

try:
    # 1) 工具清单：装机版必须和开发态一样（漏 --add-data 会静默变 0）
    ids = [t["id"] for t in get_json("/api/tools")["tools"]]
    ok &= line("PASS" if sorted(ids) == EXPECTED else "FAIL",
               f"端到端 /api/tools：{len(ids)} 个工具 {ids}")
    # 2) 真业务数据：核心插件 scheduler（任务表与调度状态，装机版必须能真干活）
    sched = get_json("/api/scheduler/jobs")
    good = sched.get("ok") is True and isinstance(sched.get("jobs"), list)
    ok &= line("PASS" if good else "FAIL",
               f"端到端 /api/scheduler/jobs：ok={sched.get('ok')} "
               f"任务 {len(sched.get('jobs') or [])} 条")
    # 2b) 真业务数据：核心插件 rss（空配置也要给出清单与配置文件路径，不能 500）
    feed = get_json("/api/rss?live=false")
    good = feed.get("ok") is True and isinstance(feed.get("feeds"), list) \
        and str(feed.get("config_path", "")).endswith("rss.json")
    ok &= line("PASS" if good else "FAIL",
               f"端到端 /api/rss：ok={feed.get('ok')} 源 {len(feed.get('feeds') or [])} 个")
    # 3) 非核心插件的路由不该随包（隔离配置根一个外置插件都没装）
    for path in ("/api/zdic?q=%E4%BD%A0", "/api/gemini/status"):
        try:
            get(path)
            ok &= line("FAIL", f"端到端 {path}：竟然可用（非核心插件混进产物了）")
        except urllib.error.HTTPError as e:
            ok &= line("PASS" if e.code == 404 else "FAIL",
                       f"端到端 {path}：HTTP {e.code}（应 404）")
    # 5) 不存在的路径要有界返回 404（App 界面上表现为人话错误，不是卡住）
    try:
        get("/api/__no_such_path__")
        ok &= line("FAIL", "端到端 404 探针：竟然返回 200")
    except urllib.error.HTTPError as e:
        ok &= line("PASS" if e.code == 404 else "FAIL", f"端到端 404 探针：HTTP {e.code}")
except Exception as e:  # noqa: BLE001
    ok = False
    print(f"  FAIL  端到端业务断言异常：{type(e).__name__}: {e}")

print("  请求耗时（秒）：" + json.dumps(times, ensure_ascii=False))
with open(sys.argv[2], "w") as fh:
    json.dump({"ok": ok, "request_seconds": times}, fh, indent=2)
sys.exit(0 if ok else 1)
PY
else
  no "跳过核心接口断言（后端没就绪）"
fi

# 退出不留孤儿：SIGTERM 收尾后端口要释放、拉起的后端要跟着走
stop_app
sleep 0.5
# 这里的断言是「不留孤儿」，SIGTERM 路径下会不通过 —— 那是**实测发现的问题**（问题清单 F1），
# 所以按已知问题记（KNOWN），不当成验收失败。断言完立刻收干净，不给这台机器留垃圾进程。
ORPHAN_PIDS="$(lsof -nP -iTCP:"$PORT1" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
if [ -n "$ORPHAN_PIDS" ]; then
  known "F1 SIGTERM 杀 App 后自启后端变孤儿（pid=${ORPHAN_PIDS}，ppid 已变 1）—— 退出钩子没跑"
else
  ok "SIGTERM 杀 App 后端口 ${PORT1} 已释放（F1 已修）"
fi
if [ -n "${RDY_PID:-}" ] && [ -n "$ORPHAN_PIDS" ]; then
  echo "  该孤儿就是桥接层记录的 pid=${RDY_PID}（同一份证据，不重复计数）"
fi
if [ -n "$ORPHAN_PIDS" ]; then
  echo "  已把孤儿收干净（脚本不留垃圾）"
  for p in $ORPHAN_PIDS; do kill "$p" 2>/dev/null; done
  sleep 0.5
  for p in $ORPHAN_PIDS; do kill -9 "$p" 2>/dev/null; done
fi
check "脚本收尾后端口 ${PORT1} 空着（不留垃圾）" no "$(port_alive "$PORT1")"

# ---------------------------------------------------------------- 3. 应用侧桥接自检

say "3/7 应用侧桥接自检（装机副本上跑 YHUB_DEBUG_BACKEND_SELFTEST=1）"
PORT2="$(free_port)"
launch_app selftest "$PORT2" config-selftest YHUB_DEBUG_BACKEND_SELFTEST=1
wait_app
common_selftest_checks "应用自检" "$APP_LOG"
S="$APP_LOG"
check "自检：拉起并探活成功" yes "$(has "$S" 'ensure_running 拉起并探活成功: got=true want=true OK')"
check "自检：来源是显式指定的 yhub（source=external）" yes "$(has "$S" 'ensure_running: .*source=external .*owned=true')"
check "自检：/api/health 拿到后端自报版本（不是本地常量）" yes "$(has "$S" "health: ok=true version=Some\\(\"$TREE_VERSION_RE\"\\)")"
EXPECTED_TOOL_COUNT="$(cat "$TMP/expected-tools.txt" 2>/dev/null || echo 0)"
check "自检：真实业务接口 /api/tools 拿到 ${EXPECTED_TOOL_COUNT} 个工具（与端到端清单同数）" yes "$(has "$S" "health: .*tools=Some\\(${EXPECTED_TOOL_COUNT}\\)")"
check "自检：崩溃后下一次调用自动重新拉起（自愈）" yes "$(has "$S" '崩溃后下一次调用自动重新拉起（自愈）: got=true want=true OK')"
check "自检：调用不存在的接口有界返回（不卡死）" yes "$(has "$S" '调用不存在的接口有界返回（不卡死）: got=true want=true OK')"
check "自检：关闭后端口已释放" yes "$(has "$S" '关闭后端口已释放: got=true want=true OK')"
check "自检后端口 ${PORT2} 空着" no "$(port_alive "$PORT2")"
SELFTEST_ENSURE_MS="$(grep1 "$S" 'ensure_running: .*elapsed=[0-9]+ms' | grep1 /dev/stdin 'elapsed=[0-9]+' | tr -dc '0-9')"
SELFTEST_LATENCY_MS="$(grep1 "$S" 'health: .*latency=[0-9]+ms' | grep1 /dev/stdin 'latency=[0-9]+' | tr -dc '0-9')"
# 第 7 相位要拿这一份做「优雅退出 vs 强制退出」的对照（后面 launch_app 会覆盖 ${APP_LOG}）
SELFTEST_APP_LOG="$S"

# ---------------------------------------------------------------- 4. 切后台再回前台

say "4/7 切后台 → 再回前台：4a 热键自检按用户语义显隐 + 后端全程存活，4b 托盘自检（两处「自检期间钉住窗口」都验到）"
PORT3="$(free_port)"
# 4a/4b 是本脚本里**唯一**两个专测「面板显隐 / 热键分发」的用例：显式关掉静默启动
# （YHUB_SELFTEST_HIDDEN=0）——它们要的就是真窗口 + 真热键注册，弹窗是这两个用例的目的。
launch_app hotkey "$PORT3" config-hotkey YHUB_DEBUG_HOTKEY_SELFTEST=1 YHUB_SELFTEST_HIDDEN=0
BACKEND_PID_BEFORE=""
OK_SAMPLES=0
BAD_SAMPLES=0
PID_CHANGES=0
# 先等后端就绪再开始计「掉线」：启动瞬间还没起来的那几次探活不算「掉线」
# （第一版从进程一起来就采样，白记了 3 次失败采样）。
P3_T0=$(date +%s.%N)
for _ in $(seq 1 300); do
  http_ready "http://127.0.0.1:$PORT3" && break
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 0.1
done
P3_READY=$(date +%s.%N)
start=$(date +%s)
# 采样到「自检的显隐相位跑完」为止：之后自检会收尾退出、后端随之关闭，
# 那时再采样失败是**预期的收尾**，不是「后端掉了」（第一版采样到 done 才停手，白记了 3 次失败采样）。
while kill -0 "$APP_PID" 2>/dev/null; do
  if grep -qE '\[selftest\] done|dispatch unbound combo' "$APP_LOG" 2>/dev/null; then break; fi
  p="$(lsof -nP -iTCP:"$PORT3" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if http_ready "http://127.0.0.1:$PORT3"; then
    OK_SAMPLES=$((OK_SAMPLES + 1))
    if [ -n "$p" ]; then
      if [ -z "$BACKEND_PID_BEFORE" ]; then BACKEND_PID_BEFORE="$p"
      elif [ "$p" != "$BACKEND_PID_BEFORE" ]; then PID_CHANGES=$((PID_CHANGES + 1)); fi
    fi
  else
    BAD_SAMPLES=$((BAD_SAMPLES + 1))
  fi
  t=$(( $(date +%s) - start ))
  [ "$t" -ge "$APP_TIMEOUT" ] && break
  sleep 0.2
done
wait_app
H="$APP_LOG"
# 4a. 用户语义（不依赖上游 selftest 的判定）：面板真的显示了、真的被隐藏了，
#     以及「自检期间钉住窗口」的修复在装机版上真的到位。
#     第三条断言换过口径（跟着「自检退出码」与「钉住窗口」两个修复）：
#     它以前断言 `[window] blur -> hide` 出现过，那其实是在断言**竞态本身**——自检不固定窗口时，
#     hide_panel 收起窗口会让窗口失焦，blur->hide 顺手打了一行，于是「设计规则生效」搭了竞态的便车；
#     而且它依赖窗口真的拿到过焦点，本机实测 `window.set_focus()` 对这个 accessory app 时灵时不灵，
#     所以这条断言本来就是**会偶发假 FAIL** 的。固定之后 blur->hide 按设计不再出现，旧口径必然红。
#     现在断言的是确定的事实：钉住真的发生、跑完真的恢复、期间一次都没被失焦自动收起抢掉。
#     「未固定时点外部确实收起」的正向证据没法可靠自动化（见 4b 注释），仍由
#     docs/gui-development.md 验收表「点外部自动收起」那条人工验收覆盖。
check "4a 面板真的显示出来过（[tray] show -> visible=Ok(true)）" yes \
  "$(has "$H" '\[tray\] show -> visible=Ok\(true\)')"
check "4a 面板真的被隐藏过（[tray] hide -> visible=Ok\(false\)）" yes \
  "$(has "$H" '\[tray\] hide -> visible=Ok\(false\)')"
check "4a 热键自检期间窗口被钉住（pinned false -> true）、跑完恢复（pinned=false），显隐断言没被失焦收起抢掉" yes \
  "$([ "$(has "$H" '自检期间钉住窗口（pinned false -> true）')" = yes ] && [ "$(has "$H" '恢复窗口固定状态 pinned=false')" = yes ] && [ "$(has "$H" '\[window\] blur -> hide')" = no ] && echo yes || echo no)"
check "4a 复位到隐藏态（自检最后一步 dispatch hide_panel again -> hidden）" yes \
  "$(has "$H" 'dispatch hide_panel again -> hidden: got=false want=false OK')"
check "4a 显隐用的是真热键分发路径（pressed alt+Space -> action toggle_panel）" yes \
  "$(has "$H" '\[hotkey\] pressed alt\+Space -> action toggle_panel')"
check "4a 显隐期间后端一直可用（成功采样 ≥ 5 次）" yes \
  "$([ "$OK_SAMPLES" -ge 5 ] && echo yes || echo no)"
check "4a 显隐期间后端一次都没掉（失败采样 = 0）" 0 "$BAD_SAMPLES"
check "4a 显隐不会重启后端（监听 pid 始终是同一个）" 0 "$PID_CHANGES"
echo "  4a 采样（到自检跑完为止）：成功 ${OK_SAMPLES} 次 / 失败 ${BAD_SAMPLES} 次 / 后端被换掉 ${PID_CHANGES} 次"
echo "  4a 后端就绪耗时：$(awk -v a="$P3_T0" -v b="$P3_READY" 'BEGIN{printf "%.2f", b-a}')s（与冷启动相位同一量法）"
check "4a 退出后端口 ${PORT3} 及后端都干净" "" \
  "$(lsof -nP -iTCP:"$PORT3" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"

# 4b. 托盘自检（tray.rs::spawn_selftest）在装机版上跑一遍。
# 4a 验的是热键自检那处固定（hotkeys.rs），这一处验的是托盘自检那处（tray.rs）——它更刁：
# 必须在 setup 那一轮里**同步**钉住（进自检线程之前），否则 show_on_start=true 的用例照样红，
# 细节见 docs/gui-development.md 已知环境限制 7。两处修复是一起落库的。
#
# 这一轮不再需要 YHUB_DEBUG_NO_HIDE=1 那个绕法：那条注释以前写的是「上游修复尚未合并到 main」，
# 现在修复已进 main，自检自己会把窗口固定住，所以在**真实的失焦自动收起规则**下跑才验得到东西。
#
# 为什么不在这儿验「未固定时点外部确实收起」这条产品规则的正向：本机实测没法可靠地把这个
# accessory app 的窗口弄到前台 —— `System Events set frontmost of process "yhub"` 无效果、
# `perform action "AXRaise" of window 1` 报 -1719「无效的索引」（accessory app 的窗口 System Events
# 认不到）、app 自己的 `window.set_focus()` 时灵时不灵（同一次脚本里 4a 有轮 focused=Ok(true)、
# 有轮 focused=Ok(false)）。拿不到焦点就不会有失焦事件，也就没有 `[window] blur -> hide` 可断言。
# 所以那条正向证据仍走人工验收（docs/gui-development.md 验收表「点外部自动收起」）；
# 想自动化得先解决「怎么稳定地把 accessory 窗口弄到前台」，那是另一张卡的事。
PORT3B="$(free_port)"
launch_app tray-selftest "$PORT3B" config-tray-selftest \
  YHUB_DEBUG_TRAY_SELFTEST=1 YHUB_SELFTEST_HIDDEN=0
wait_app
common_selftest_checks "4b 托盘自检（自检期间钉住窗口）" "$APP_LOG"
check "4b 托盘自检：固定真的发生了（pinned false -> true）" yes \
  "$(has "$APP_LOG" '自检期间钉住窗口（pinned false -> true）')"
check "4b 托盘自检：跑完把固定状态恢复原值" yes \
  "$(has "$APP_LOG" '恢复窗口固定状态')"
check "4b 后端口 ${PORT3B} 空着" no "$(port_alive "$PORT3B")"

# ---------------------------------------------------------------- 5. 网络异常

say "5/7 网络异常（外网不可达：代理指向死端口）—— App 与本地接口不受影响，外网接口给人话错误"
PORT4="$(free_port)"
launch_app netfail "$PORT4" config-netfail \
  HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 \
  http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 \
  NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
NET_READY=""
for _ in $(seq 1 300); do
  http_ready "http://127.0.0.1:$PORT4" && { NET_READY=1; break; }
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 0.1
done
if [ -n "$NET_READY" ]; then
  ok "断网场景下 App 仍然把后端拉起来了（本地 loopback 不受代理影响）"
  check "断网场景 /api/health 仍 200" 200 "$(http_code "http://127.0.0.1:$PORT4/api/health")"
  check "断网场景 /api/tools 仍 200（本地工具不受影响）" 200 "$(http_code "http://127.0.0.1:$PORT4/api/tools")"
  "$PY" - "$PORT4" <<'PY' || no "断网场景下本机接口表现不符合预期"
import json, sys, urllib.request

base = f"http://127.0.0.1:{int(sys.argv[1])}"
# 断网不该影响本机能力：核心插件 scheduler 只读本机配置与状态
try:
    with urllib.request.urlopen(base + "/api/scheduler/jobs", timeout=20) as r:
        body = json.loads(r.read())
    print(f"  {'PASS' if body.get('ok') is True else 'FAIL'}  断网场景 /api/scheduler/jobs：ok={body.get('ok')}")
    sys.exit(0 if body.get("ok") is True else 1)
except Exception as e:  # noqa: BLE001
    print(f"  FAIL  断网场景 /api/scheduler/jobs 失败：{type(e).__name__}: {e}")
    sys.exit(1)
PY
  check "断网场景：后端仍有可读日志（可定位）" yes \
    "$(has "$CFG/logs/backend.log" 'Uvicorn|Started server|/api/health')"
else
  no "断网场景：App 没能在断网下就绪（连本地 loopback 都被影响？）"
fi
stop_app

# ---------------------------------------------------------------- 6. 后端拉不起来 / 环境变量写错

say "6/7 后端异常路径（装机副本上）：拉不起来要有界失败，路径写错要给人话错误与办法"
cat >"$TMP/stub_never.py" <<'PY'
#!/usr/bin/env python3
"""起来了但永远不听端口：制造「等就绪超时」。"""
import os
import time

print("[stub-never] started pid=%d port=%s (故意不听端口)" % (os.getpid(), os.environ.get("YHUB_PORT")), flush=True)
time.sleep(300)
PY
chmod +x "$TMP/stub_never.py"

PORT5="$(free_port)"
launch_app timeout "$PORT5" config-timeout \
  YHUB_DEBUG_BACKEND_SELFTEST=timeout \
  "YHUB_BACKEND_BIN=$TMP/stub_never.py" YHUB_BACKEND_TIMEOUT_MS=3000
wait_app
common_selftest_checks "拉不起来" "$APP_LOG"
T="$APP_LOG"
check "拉不起来：不假装成功" yes "$(has "$T" '拉不起后端时不假装成功: got=false want=false OK')"
check "拉不起来：按 3000 ms 有界收手（不是无限等）" yes "$(has "$T" '后端没能在 3000 ms 内就绪')"
check "拉不起来：错误信息带日志路径（可定位）" yes "$(has "$T" '失败信息带日志路径（可定位）: got=true want=true OK')"
check "拉不起来：清理掉刚起的进程（不留孤儿）" yes "$(has "$T" '已清理刚拉起的进程')"
check "拉不起来：失败后状态查询仍有界返回（界面不会卡死）" yes "$(has "$T" '失败后状态查询仍有界返回: got=true want=true OK')"
NEVER_PID="$(grep1 "$T" 'stub-never\] started pid=[0-9]+' | tr -dc '0-9')"
[ -n "${NEVER_PID:-}" ] && check "拉不起来：那个不听端口的子进程已被收掉" no "$(pid_alive "$NEVER_PID")"

PORT6="$(free_port)"
launch_app badbin "$PORT6" config-badbin \
  YHUB_DEBUG_BACKEND_SELFTEST=badbin "YHUB_BACKEND_BIN=$TMP/not-there-at-all"
wait_app
common_selftest_checks "环境变量写错" "$APP_LOG"
B="$APP_LOG"
check "写错：不假装成功" yes "$(has "$B" '环境变量写错时不假装成功: got=false want=false OK')"
check "写错：错误里带上写错的路径" yes "$(has "$B" 'YHUB_BACKEND_BIN 指向的文件不存在')"
check "写错：错误里有怎么办（hint）" yes "$(has "$B" '错误里有怎么办（hint）: got=true want=true OK')"

# ---------------------------------------------------------------- 7. 强制退出 vs 优雅退出

say "7/7 强制退出（SIGINT）会不会留孤儿 —— 与第 3 相位的优雅退出对照"
PORT7="$(free_port)"
launch_app sigint "$PORT7" config-sigint
SIG_READY=""
for _ in $(seq 1 300); do
  http_ready "http://127.0.0.1:$PORT7" && { SIG_READY=1; break; }
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 0.1
done
if [ -n "$SIG_READY" ]; then
  SIG_BACKEND_PID="$(lsof -nP -iTCP:"$PORT7" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  ok "强制退出用例：App 与后端已就位（后端 pid=${SIG_BACKEND_PID}）"
  kill -INT "$APP_PID" 2>/dev/null
  i=0
  while kill -0 "$APP_PID" 2>/dev/null && [ "$i" -lt 60 ]; do sleep 0.1; i=$((i + 1)); done
  sleep 0.5
  LEFT_PIDS="$(lsof -nP -iTCP:"$PORT7" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
  if [ -n "$LEFT_PIDS" ]; then
    known "F1 同源：SIGINT 杀 App 同样留下孤儿（pid=${LEFT_PIDS}）"
    for p in $LEFT_PIDS; do kill "$p" 2>/dev/null; done
    sleep 0.5
    for p in $LEFT_PIDS; do kill -9 "$p" 2>/dev/null; done
  else
    ok "SIGINT 杀 App 后端口 ${PORT7} 已释放（F1 已修）"
  fi
  check "脚本收尾后端口 ${PORT7} 空着" no "$(port_alive "$PORT7")"
else
  no "强制退出用例：App 没能就绪"
fi
# 对照：App 自己走 app.exit()（第 3 相位的自检）时，退出钩子是**跑过**的
check "对照：优雅退出（app.exit）时退出钩子跑过" yes \
  "$(has "$SELFTEST_APP_LOG" '\[backend\] 没有本进程拉起的后端，跳过（app exit）')"
check "对照：优雅退出前已关掉自启后端（SIGTERM 后 XX ms 内退出）" yes \
  "$(has "$SELFTEST_APP_LOG" '已关闭自启后端 pid=[0-9]+.*SIGTERM 后 [0-9]+ ms 内退出（selftest）')"

# ---------------------------------------------------------------- 汇总

say "汇总"
"$PY" - "$REPORT" "$APP" "$COLD_APP" "$COLD_APP" "$APP_BYTES" "$SHELL_BYTES" "$RES_BYTES" \
  "$BACKEND_BYTES" "$EMBEDDED_SHA" "$TMP/requests.json" \
  "${SELFTEST_ENSURE_MS:-}" "${SELFTEST_LATENCY_MS:-}" "$PASS" "$FAIL" "$KNOWN" "${SHELL_SHA:-}" <<'PY'
import json, os, sys

(report, app, cold_app, _cold, app_bytes, shell_bytes, res_bytes, backend_bytes,
 embedded_sha, req_path, selftest_ms, selftest_latency, passed, failed, known, shell_sha) = sys.argv[1:17]
with open(req_path) as fh:
    business = json.load(fh)
out = {
    "app": app,
    "app_bytes": int(app_bytes),
    "app_mb": round(int(app_bytes) / 1024 / 1024, 1),
    "shell_mb": round(int(shell_bytes) / 1024 / 1024, 1),
    "resources_mb": round(int(res_bytes) / 1024 / 1024, 1),
    "backend_source": "external-wrapper",
    "shell_binary_sha256": shell_sha or None,
    "cold_start_to_backend_ready_s": float(cold_app) if cold_app else None,
    "business_ok": business["ok"],
    "request_seconds": business["request_seconds"],
    "selftest_embed_ensure_ms": int(selftest_ms) if selftest_ms else None,
    "selftest_health_latency_ms": int(selftest_latency) if selftest_latency else None,
    "assertions": {"pass": int(passed), "fail": int(failed), "known": int(known)},
    "note": ("cold_start = App 进程启动 → 外部探到 /api/health 200 的墙钟耗时；"
             "页缓存未清空，严格冷启动（重启后首次）会略慢"),
}
with open(report, "w") as fh:
    json.dump(out, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
print(json.dumps(out, ensure_ascii=False, indent=2))
PY

if [ -n "$KEEP_DIR" ]; then
  mkdir -p "$KEEP_DIR"
  cp "$TMP"/*.log "$KEEP_DIR"/ 2>/dev/null
  for d in "$TMP"/config-*; do
    [ -d "$d/logs" ] || continue
    mkdir -p "$KEEP_DIR/$(basename "$d")"
    cp "$d/logs"/*.log "$KEEP_DIR/$(basename "$d")/" 2>/dev/null
  done
  cp "$REPORT" "$KEEP_DIR"/ 2>/dev/null
  echo "==> 日志与报告已留存：$KEEP_DIR"
fi

echo
echo "==== 结果：PASS=$PASS FAIL=$FAIL KNOWN=$KNOWN （KNOWN = 已定位并写入问题清单的已知缺陷）===="
[ "$FAIL" -eq 0 ]
