#!/usr/bin/env bash
# 托盘行为设置的端到端验证：真跑桌面程序，四套配置各跑一遍，断言"行为跟着设置变"。
#
# 为什么这么验：本机 macOS 上合成鼠标事件到不了第三方状态项（收得到 Enter/Leave，收不到 Click），
# 所以"真实点一下菜单栏图标"没法自动化。程序自带 YHUB_DEBUG_TRAY_SELFTEST=1 自检——它走的是
# 和托盘事件完全相同的函数（handle_left_click / show_panel / hide_panel / CloseRequested），
# 期望值全部从设置里推出来，于是同一份自检就能给多套配置用。
#
# 覆盖：
#   A. 默认值（hide / left_click=toggle_panel / double_click=none / 启动不弹窗 / 不发通知）+ 重启后配置保持
#   B. close_behavior=quit：关窗即退出进程（不是隐藏）
#   C. left_click=none + double_click=toggle_panel + show_on_start=true + show_notifications=true
#      （双击生效且挂起的单击被取消；启动即弹面板；通知真的发出去）
#   D. left_click=show_menu：左键只弹菜单，面板显隐不动
#
# 用法：tauri/scripts/verify-tray-behavior.sh [--no-build]
#   RUN_TIMEOUT=40  每个用例最多等多少秒（自检跑完会自己退出）
#   KEEP_DIR=…      把各用例的程序日志复制到这个目录（默认随临时目录一起删）
#
# 安全性：程序以 YHUB_CONFIG_DIR 指向临时目录运行，绝不读写 ~/.config/yhub/settings.json。
# 注意：若 8790 端口没有后端在跑，程序会顺手把 Python 后端拉起来；脚本不会去杀它。

set -uo pipefail

RUN_TIMEOUT="${RUN_TIMEOUT:-40}"
DO_BUILD=1
[ "${1:-}" = "--no-build" ] && DO_BUILD=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# 机器级互斥：同一时刻只允许一个「会启动 app 的验证脚本」在跑（见 app-test-lock.sh）。
# 本脚本（托盘行为）是「抢焦点」用例的默认被测对象，见 probe-focus-steal.sh。
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
# YHUB_BIN 可以指向一份"拷出来的二进制快照"：多张卡片并行时共用同一个 target 目录，
# 谁后编译谁覆盖 debug/yhub，跑验证时可能拿到别人的构建产物（实测踩过）。
# 建议：cargo build 完立刻 cp 一份到自己的目录，再用 YHUB_BIN=… 跑本脚本。
BIN="${YHUB_BIN:-$TARGET_DIR/debug/yhub}"
[ -x "$BIN" ] || { echo "找不到可执行文件：$BIN"; exit 1; }
echo "==> 被测程序：$BIN"
echo "==> 二进制指纹：$(md5 -q "$BIN" 2>/dev/null || shasum -a 256 "$BIN" | awk '{print $1}')"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/yhub-tray-verify.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
CFG="$TMP/config"
mkdir -p "$CFG"
CONFIG="$CFG/settings.json"
# 追加给被测程序的环境变量（用例 F 用；run_case 里展开，默认空）
EXTRA_ENV=""

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
sha() { shasum -a 256 "$1" | awk '{print $1}'; }
jget() { # jget <文件> <点号路径>
  python3 - "$1" "$2" <<'PY'
import json, sys
cur = json.load(open(sys.argv[1], encoding="utf-8"))
for part in sys.argv[2].split("."):
    if part:
        cur = cur[int(part)] if isinstance(cur, list) else cur[part]
print(json.dumps(cur, ensure_ascii=False, sort_keys=True))
PY
}

write_config() { # write_config <json>
  printf '%s\n' "$1" >"$CONFIG"
}

run_case() { # run_case <日志名>：跑程序直到自检自己退出（EXTRA_ENV 可追加环境变量）
  LOG="$TMP/$1.log"
  : >"$LOG"
  # 本脚本**显式**要求非静默启动（YHUB_SELFTEST_HIDDEN=0）：它整篇断言的都是面板显隐与托盘
  # 行为（启动即弹面板 / 关窗隐藏 / 左键切换面板），静默启动会把面板按住不动，断言全无意义。
  # shellcheck disable=SC2086
  env YHUB_CONFIG_DIR="$CFG" YHUB_DEBUG_TRAY_SELFTEST=1 YHUB_SELFTEST_HIDDEN=0 $EXTRA_ENV "$BIN" >"$LOG" 2>&1 &
  local pid=$!
  local start=$SECONDS
  while kill -0 "$pid" 2>/dev/null && ((SECONDS - start < RUN_TIMEOUT)); do sleep 0.5; done
  if kill -0 "$pid" 2>/dev/null; then
    ALIVE=1
    EXIT_CODE="timeout"
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  else
    ALIVE=0
    wait "$pid"
    EXIT_CODE=$?
  fi
  echo "      （进程存活=$ALIVE 退出码=${EXIT_CODE}，用时 $((SECONDS - start))s）"
}

# 每个用例都要求的公共结论：自检自己跑完、全绿、退出码 0、进程没赖着不走
common_checks() { # common_checks <用例名> [是否期望 selftest PASS，默认 yes]
  local log="$TMP/$CASE_LOG.log"
  local want_pass="${2:-yes}"
  check "$1：自检跑完并 PASS" "$want_pass" "$(has "$log" '^\[selftest\] PASS$')"
  check "$1：没有 selftest FAIL 行" no "$(has "$log" '\[selftest\] FAIL')"
  check "$1：进程自行退出（存活=0）" 0 "$ALIVE"
  check "$1：退出码 0" 0 "$EXIT_CODE"
}

echo
echo "A. 默认值：关窗隐藏 / 左键切换面板 / 双击不响应 / 启动不弹窗 / 不发通知"
write_config '{"version":1,"hotkeys":{"toggle_panel":"Ctrl+Cmd+Shift+F11"},"tray":{"close_behavior":"hide","left_click":"toggle_panel","double_click":"none","show_on_start":false,"show_notifications":false}}'
BEFORE="$(sha "$CONFIG")"
CASE_LOG="a1"
run_case a1
common_checks "默认值"
A1="$TMP/a1.log"
check "默认值：启动不显示面板（show_on_start=false）" yes "$(has "$A1" 'startup visibility = show_on_start: got=false want=false OK')"
check "默认值：左键单击走 toggle_panel" yes "$(has "$A1" '\[tray\] action=toggle_panel source=left_click')"
check "默认值：一次双击只切换一回（第二个点击按 double_click=none 不响应）" yes "$(has "$A1" 'double click left_click=toggle_panel double_click=none: got=true want=true OK')"
check "默认值：关窗只隐藏（进程留着）" yes "$(has "$A1" '\[window\] close requested -> hide .*close_behavior=hide')"
check "默认值：关窗后窗口对象还在" yes "$(has "$A1" 'close -> window still alive: got=true want=true OK')"
check "默认值：关窗后托盘还能把面板叫回来" yes "$(has "$A1" 'click after close: got=true want=true OK')"
check "默认值：左键不交给 macOS 原生弹菜单（native=false）" yes "$(has "$A1" '\[tray\] apply: 左键弹菜单 native=false')"
check "默认值：不发系统通知（只记 skipped）" yes "$(has "$A1" '\[notify\] skipped \(show_notifications=false\)')"
check "默认值：没有真的去发通知" no "$(has "$A1" '\[notify\] posting:')"

echo
echo "A2. 重启后配置保持：同一份配置再跑一遍，行为一模一样"
CASE_LOG="a2"
run_case a2
common_checks "重启后"
A2="$TMP/a2.log"
check "重启后：启动行与第一遍一致" "$(grep -oE '^\[selftest\] start .*' "$A1" | head -1)" "$(grep -oE '^\[selftest\] start .*' "$A2" | head -1)"
check "重启后：启动仍不显示面板" yes "$(has "$A2" 'startup visibility = show_on_start: got=false want=false OK')"
check "重启后：关窗仍只隐藏" yes "$(has "$A2" '\[window\] close requested -> hide .*close_behavior=hide')"
check "跑完两遍没改写配置文件（只有迁移才写盘）" "$BEFORE" "$(sha "$CONFIG")"

echo
echo "B. close_behavior=quit：关窗即退出进程"
write_config '{"version":1,"hotkeys":{"toggle_panel":"Ctrl+Cmd+Shift+F12"},"tray":{"close_behavior":"quit","left_click":"toggle_panel","double_click":"none","show_on_start":false,"show_notifications":false}}'
CASE_LOG="b"
run_case b
# quit 用例：关窗那一刻进程就退出了，自检的收尾行（PASS）不会打印——这正是期望的行为
common_checks "quit" no
B="$TMP/b.log"
check "quit：日志明确记录了关窗即退出" yes "$(has "$B" '\[window\] close requested -> quit \(close_behavior=quit')"
check "quit：没有走「只隐藏」分支" no "$(has "$B" 'close requested -> hide')"
check "quit：自检报告关窗后进程应自行退出" yes "$(has "$B" 'close_behavior=quit：关窗后进程应当自行退出')"
check "quit：没有落到「进程仍在」的失败分支" no "$(has "$B" 'close 之后进程仍在')"
check "quit：托盘点击行为不受影响（左键仍是切换面板）" yes "$(has "$B" '\[tray\] action=toggle_panel source=left_click')"

echo
echo "C. left_click=none + double_click=toggle_panel + show_on_start=true + show_notifications=true"
write_config '{"version":1,"hotkeys":{"toggle_panel":"Ctrl+Cmd+Shift+F10"},"tray":{"close_behavior":"hide","left_click":"none","double_click":"toggle_panel","show_on_start":true,"show_notifications":true}}'
CASE_LOG="c"
run_case c
common_checks "非默认组合"
C="$TMP/c.log"
check "非默认组合：启动即显示面板（show_on_start=true）" yes "$(has "$C" 'startup visibility = show_on_start: got=true want=true OK')"
check "非默认组合：启动真的调了显示（不是只读设置）" yes "$(has "$C" '\[tray\] show_on_start=true -> 启动即显示面板')"
check "非默认组合：左键单击按 none 不响应" yes "$(has "$C" 'single click left_click=none: got=false want=false OK')"
check "非默认组合：双击走 toggle_panel" yes "$(has "$C" '\[tray\] action=toggle_panel source=double_click')"
check "非默认组合：挂起的单击被双击取消（单击没有额外生效）" yes "$(has "$C" '\[tray\] pending single click cancelled by double click')"
check "非默认组合：双击后一次点击只切换一回" yes "$(has "$C" 'double click left_click=none double_click=toggle_panel: got=true want=true OK')"
check "非默认组合：关窗时发了系统通知" yes "$(has "$C" '\[notify\] posting: 已收起到菜单栏')"
check "非默认组合：通知已交给 osascript（有退出码记录）" yes "$(has "$C" '\[notify\] osascript exit:')"

echo
echo "D. left_click=show_menu：左键只弹菜单，面板显隐不动"
write_config '{"version":1,"hotkeys":{"toggle_panel":"Ctrl+Cmd+Shift+F9"},"tray":{"close_behavior":"hide","left_click":"show_menu","double_click":"none","show_on_start":false,"show_notifications":false}}'
CASE_LOG="d"
run_case d
common_checks "show_menu"
D="$TMP/d.log"
check "show_menu：左键动作被识别为 show_menu" yes "$(has "$D" '\[tray\] action=show_menu source=left_click')"
check "show_menu：左键弹菜单交给 macOS 原生开关（native=true）" yes "$(has "$D" '\[tray\] apply: 左键弹菜单 native=true')"
check "show_menu：点击时走原生弹出（非阻塞，不卡主线程）" yes "$(has "$D" '\[tray\] show_menu -> 交给 macOS 原生弹出（非阻塞）')"
check "show_menu：没有退回模态的程序化弹出" no "$(has "$D" '\[tray\] show_menu -> 已请求在鼠标位置弹出菜单')"
check "show_menu：面板显隐不受影响（单击后仍隐藏）" yes "$(has "$D" 'single click left_click=show_menu: got=false want=false OK')"
check "show_menu：关窗仍按 close_behavior=hide 处理" yes "$(has "$D" '\[window\] close requested -> hide .*close_behavior=hide')"

echo
echo "E. 托盘菜单入口（显示 / 隐藏 / 设置… / 退出）"
E="$TMP/a1.log"
check "菜单构建成功" yes "$(has "$E" '\[tray\] built id=yhub-tray')"
check "托盘 id 与菜单项注册无异常" no "$(has "$E" '\[tray\] build FAILED')"
check "对话框开着时收起被挡下（hide_panel 跳过）" yes "$(has "$E" '\[tray\] hide -> 跳过（系统对话框开着）')"
check "对话框开着时面板保持可见（显隐断言）" yes "$(has "$E" '对话框开着时 hide_panel 不收面板: got=true want=true OK')"
check "对话框关掉后收起照旧生效" yes "$(has "$E" '对话框关掉后 hide_panel 照旧收起: got=false want=false OK')"

echo
echo "F. 运行中改设置立刻生效（走 config::set + apply_settings，与界面写设置同一条路径）"
CFG="$TMP/config-live"
mkdir -p "$CFG"
CONFIG="$CFG/settings.json"
write_config '{"version":1,"hotkeys":{"toggle_panel":"Ctrl+Cmd+Shift+F8"},"tray":{"close_behavior":"hide","left_click":"toggle_panel","double_click":"none","show_on_start":false,"show_notifications":false}}'
CASE_LOG="f"
EXTRA_ENV="YHUB_DEBUG_TRAY_LIVE_RELOAD=1"
run_case f
EXTRA_ENV=""
common_checks "改完立刻生效"
F="$TMP/f.log"
check "立刻生效：自检记录了设置被改写（toggle_panel → none）" yes "$(has "$F" '\[selftest\] live reload: left_click toggle_panel -> none')"
check "立刻生效：新值下一次点击就生效（none → 不响应，面板不动）" yes "$(has "$F" 'live reload: 新值立刻生效: got=false want=false OK')"
check "立刻生效：改回原值也立刻生效（toggle_panel → 面板弹出）" yes "$(has "$F" 'live reload: 改回原值也立刻生效: got=true want=true OK')"
check "立刻生效：落盘值与运行时一致（改回后文件里是 toggle_panel）" '"toggle_panel"' "$(jget "$CONFIG" tray.left_click)"

if [ -n "${KEEP_DIR:-}" ]; then
  mkdir -p "$KEEP_DIR"
  cp "$TMP"/*.log "$KEEP_DIR"/ 2>/dev/null
  echo "==> 程序日志已复制到 $KEEP_DIR"
fi

echo
echo "==== 结果：PASS=$PASS FAIL=$FAIL ===="
[ "$FAIL" -eq 0 ]
