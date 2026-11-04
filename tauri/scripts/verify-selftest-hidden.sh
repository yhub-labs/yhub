#!/usr/bin/env bash
# 静默启动开关（YHUB_SELFTEST_HIDDEN）的端到端验证：真跑桌面程序，断言「屏幕上真的没有面板」。
#
# 为什么需要：验证脚本每轮会反复启动真 App（verify-packed-app.sh 一轮 8 次），每次启动都弹面板，
# 屏幕上就是「有个应用在疯狂被打开」（实测：27 分钟 107 次）。
# 静默启动开关就是治这个的，所以它自己也必须被验：不能只信日志里那句「我不显示面板」。
#
# 「屏幕上有没有面板」的判据：问窗口服务器（WindowServer）该 pid 有没有窗口
# （tauri/scripts/onscreen-windows.py，用 CoreGraphics 的 kCGWindowListOptionOnScreenOnly）。
# 比截图强的地方：面板被别的窗口挡住时截图看不见，但窗口服务器照样知道它在屏幕上。
#
# 覆盖：
#   A. YHUB_SELFTEST_HIDDEN=1：屏幕上没有面板 + 不注册全局热键 + 一次都没调 show/hide +
#      进程活着 + 菜单栏托盘入口还在（不显示面板 ≠ 把程序藏起来）
#   B. 正对照 YHUB_DEBUG_NO_HIDE=1：面板**真的**在屏幕上（证明 A 的判据不是「恒为 no」）
#   C. 默认（不带开关）：与改动前一致 —— 注册热键、show_on_start=false 不弹面板
#
# 用法：tauri/scripts/verify-selftest-hidden.sh [--no-build]
#   RUN_SECS=4   每个用例启动后观察多久（默认 4 秒）
#   KEEP_DIR=…   把程序日志复制到这里（默认随临时目录删掉）
#   YHUB_BIN=… 指定被测二进制（并行开发时建议 cp 一份快照再用它）
#
# 安全性：YHUB_CONFIG_DIR 指向临时目录；后端用 /usr/bin/true 顶掉（起得快、不听端口、有界失败），
# 不碰本机常驻的 8790，也不留子进程。

set -uo pipefail

RUN_SECS="${RUN_SECS:-4}"
DO_BUILD=1
[ "${1:-}" = "--no-build" ] && DO_BUILD=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# 机器级互斥：同一时刻只允许一个「会启动 app 的验证脚本」在跑（见 app-test-lock.sh）
source "$SCRIPT_DIR/app-test-lock.sh"
yhub_app_test_lock "$0" "$@"

export PATH="$HOME/.cargo/bin:$PATH"

cd "$TAURI_DIR" || exit 1

if [ "$DO_BUILD" = 1 ]; then
  echo "==> cargo build"
  cargo build || { echo "构建失败，中止"; exit 1; }
fi

TARGET_DIR="$(cargo metadata --format-version 1 --no-deps \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
BIN="${YHUB_BIN:-$TARGET_DIR/debug/yhub}"
[ -x "$BIN" ] || { echo "找不到可执行文件：$BIN"; exit 1; }
echo "==> 被测程序：$BIN"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/yhub-hidden-verify.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
CFG="$TMP/config"
mkdir -p "$CFG"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  PASS  $1"; }
no() {
  FAIL=$((FAIL + 1))
  echo "  FAIL  $1"
}
check() { # check <描述> <期望> <实际>
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1（期望 [$2]，实际 [$3]）"; fi
}
has() { # has <日志> <正则> → yes/no
  if grep -qE -- "$2" "$1"; then echo yes; else echo no; fi
}

APP_ALIVE=0
APP_PID=""
ONSCREEN=""

run_app() { # run_app <用例名> [额外 env…]：起程序 → 观察 RUN_SECS → 问窗口服务器 → 收尾
  local name="$1"; shift
  LOG="$TMP/$name.log"
  : >"$LOG"
  # 后端用 /usr/bin/true 顶掉：起得快、不听端口、1.5 s 就有界失败 —— 本脚本只关心「面板在不在屏幕上」
  env YHUB_CONFIG_DIR="$CFG" YHUB_BACKEND_PORT=18791 \
    YHUB_BACKEND_BIN=/usr/bin/true YHUB_BACKEND_TIMEOUT_MS=1500 \
    "$@" "$BIN" >"$LOG" 2>&1 &
  APP_PID=$!
  sleep "$RUN_SECS"
  if kill -0 "$APP_PID" 2>/dev/null; then APP_ALIVE=1; else APP_ALIVE=0; fi
  # 判据：窗口服务器上有没有这个 pid 的窗口（yes/no）
  ONSCREEN="$(python3 "$SCRIPT_DIR/onscreen-windows.py" --pid "$APP_PID" | head -1)"
  kill "$APP_PID" 2>/dev/null
  wait "$APP_PID" 2>/dev/null
  APP_PID=""
}

echo
echo "A. YHUB_SELFTEST_HIDDEN=1：屏幕上没有面板、不注册全局热键、程序照常活着"
run_app hidden YHUB_SELFTEST_HIDDEN=1
A="$TMP/hidden.log"
check "静默启动：日志说明进入了静默模式" yes "$(has "$A" '\[selftest\] hidden=1（YHUB_SELFTEST_HIDDEN）')"
check "静默启动：屏幕上没有面板（窗口服务器上查不到这个 pid 的窗口）" no "$ONSCREEN"
check "静默启动：一次都没调过 show / hide" no "$(has "$A" '\[tray\] show ->|\[tray\] hide ->')"
check "静默启动：没有注册全局热键" no "$(has "$A" '\[hotkey\] registered')"
check "静默启动：明确记了跳过注册（不是静默跳过）" yes "$(has "$A" 'hidden=1：跳过全局热键注册')"
check "静默启动：进程活着（不显示面板 ≠ 崩）" 1 "$APP_ALIVE"
check "静默启动：菜单栏托盘入口还在（[tray] built id=yhub-tray）" yes "$(has "$A" '\[tray\] built id=yhub-tray')"

echo
echo "B. 正对照 YHUB_DEBUG_NO_HIDE=1：面板真的在屏幕上（否则 A 的判据没意义）"
run_app visible YHUB_DEBUG_NO_HIDE=1 YHUB_SELFTEST_HIDDEN=0
B="$TMP/visible.log"
check "正对照：窗口服务器上能看到这个 pid 的窗口" yes "$ONSCREEN"
check "正对照：窗口确实被 show 过（[debug] window shown at startup）" yes "$(has "$B" '\[debug\] window shown at startup')"
check "正对照：热键也注册了（或明确报出被占用）" yes \
  "$(has "$B" '\[hotkey\] (registered: Option\+Space|register Option\+Space FAILED)')"

echo
echo "C. 默认（不带开关）：与改动前一致 —— 注册热键、show_on_start=false 不弹面板"
run_app normal YHUB_SELFTEST_HIDDEN=0
C="$TMP/normal.log"
check "默认：注册热键（或明确报出被占用）" yes \
  "$(has "$C" '\[hotkey\] (registered: Option\+Space|register Option\+Space FAILED)')"
check "默认：走 show_on_start 分支（不显示面板）" yes \
  "$(has "$C" '\[tray\] show_on_start=false -> 启动不显示')"
check "默认：屏幕上没有面板" no "$ONSCREEN"

if [ -n "${KEEP_DIR:-}" ]; then
  mkdir -p "$KEEP_DIR"
  cp "$TMP"/*.log "$KEEP_DIR"/ 2>/dev/null
  echo "==> 程序日志已复制到 $KEEP_DIR"
fi

echo
echo "==== 结果：PASS=$PASS FAIL=$FAIL ===="
[ "$FAIL" -eq 0 ]
