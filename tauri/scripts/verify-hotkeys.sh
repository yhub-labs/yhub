#!/usr/bin/env bash
# 多动作全局热键端到端验证：真跑桌面程序 + 真合成按键（osascript 发系统级按键），
# 验证"注册 → 系统投递按键 → 动作 → 面板"这条链，而不是内部直接调用函数。
#
# 覆盖：
#   A. 启动注册：动作表里配置过的动作逐个注册（日志带 action=id），没配的明确跳过
#   B. 真按键分发：合成的组合键被系统送进程序，日志出现对应动作 id（本机没给辅助功能权限时如实报 SKIP）
#   C. 应用内自检：apply_hotkey（设置界面同一条路径）→ 系统注册 → dispatch → 面板显隐（真实窗口状态）
#   D. 冲突兜底：配置文件里两个动作绑同一个键（写法/顺序不同也算同一个键）→ 只保留一个，
#      另一项回退默认，日志给出人话警告，进程不崩
#   E. 解绑：组合键留空 → 不注册
#
# 用法：tauri/scripts/verify-hotkeys.sh [--no-build]
#   RUN_SECS=8     每个用例最多让程序跑多久
#   KEEP_DIR=…     把各用例的程序日志复制到这里（默认随临时目录删掉）
#
# 前置：macOS 需要给运行本脚本的程序"辅助功能"权限（系统设置 → 隐私与安全性 → 辅助功能），
#       否则合成按键不会被系统投递——B 会明确报 SKIP（System Events 此时静默失败、osascript 仍返回 0），
#       不会假装通过。C 用应用内自检补上"按键之后"那半条链。
# 说明：全局热键是全系统独占的。脚本用的组合键（Ctrl+Cmd+Shift+F7/F8/F9）如果被别的程序占着，
#       注册会失败——脚本会如实报出来。日志断言只看 YHUB_CONFIG_DIR 指向临时目录跑起来的那个进程，
#       所以即使 /Applications/Y-Hub.app 也在跑，也不影响判断。

set -uo pipefail

RUN_SECS="${RUN_SECS:-8}"
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
BIN="$TARGET_DIR/debug/yhub"
[ -x "$BIN" ] || { echo "找不到可执行文件：$BIN"; exit 1; }
echo "==> 被测程序：$BIN"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/yhub-hotkeys-verify.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
CFG="$TMP/config"
mkdir -p "$CFG"

PASS=0
FAIL=0
SKIP=0
APP_PID=""
ok() { PASS=$((PASS + 1)); echo "  PASS  $1"; }
no() {
  FAIL=$((FAIL + 1))
  echo "  FAIL  $1"
}
check() { # check <描述> <期望> <实际>
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1（期望 [$2]，实际 [$3]）"; fi
}
yesno() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }
after_action() { # after_action <日志> <动作id> <正则> → yes/no
  # 取该动作之后的日志片段：从 `-> action <id>` 起，到下一条 `[hotkey] pressed` 为止。
  # 中间可能夹着别的行（例如 `[tray] place on monitor …`），所以不能用 grep -A1 这种固定窗口——
  # 那样只要中间多一行日志就会假 FAIL。这里按「动作之后、下一个按键之前」整段断言。
  local seg
  seg="$(awk -v want="-> action $2" '$0 ~ want { f = 1; next } f && /\[hotkey\] pressed/ { exit } f' "$1")"
  # 用 here-string 而不是管道：grep -q 命中即退出会让管道左侧收到 SIGPIPE，
  # 在 set -o pipefail 下整条管道会被判失败 → 假 no。
  grep -qE -- "$3" <<<"$seg" && echo yes || echo no
}

launch() { # launch <配置目录> <日志>
  local cfg="$1" log="$2"
  : >"$log"
  # 本脚本**显式**要求非静默启动（YHUB_SELFTEST_HIDDEN=0）：A/B/D/E 断言的正是「启动注册热键、
  # 真按键分发后面板真的显隐」，静默启动既不注册热键也不显示面板，会把这些断言全打掉。
  YHUB_CONFIG_DIR="$cfg" YHUB_SELFTEST_HIDDEN=0 "$BIN" >>"$log" 2>&1 &
  APP_PID=$!
}
stop_app() {
  [ -n "$APP_PID" ] || return 0
  kill "$APP_PID" 2>/dev/null
  wait "$APP_PID" 2>/dev/null
  APP_PID=""
}
alive() { kill -0 "$APP_PID" 2>/dev/null && echo yes || echo no; }

wait_log() { # wait_log <日志> <正则> [超时秒]
  local log="$1" pat="$2" limit=$(( ${3:-8} * 10 )) i=0
  while [ "$i" -lt "$limit" ]; do
    grep -qE -- "$pat" "$log" 2>/dev/null && return 0
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

# macOS 虚拟键码：F7=98 F8=100 F9=101
press() { # press <键码> <修饰键串>
  osascript -e "tell application \"System Events\" to key code $1 using {$2}" >/dev/null 2>&1
}
CTRL_CMD_SHIFT="control down, command down, shift down"

echo
echo "A. 启动注册：动作表里配置过的动作逐个注册"
python3 - "$CFG/settings.json" <<'PY'
import json, sys
settings = {
    "version": 1,
    "hotkeys": {
        "toggle_panel": "Ctrl+Cmd+Shift+F9",
        "show_panel": "Ctrl+Cmd+Shift+F8",
        "hide_panel": "Ctrl+Cmd+Shift+F7",
    },
    "tray": {"show_on_start": False},
}
json.dump(settings, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY

A_LOG="$TMP/a.log"
launch "$CFG" "$A_LOG"
wait_log "$A_LOG" '\[hotkey\] registered: Ctrl\+Cmd\+Shift\+F9' 10
check "toggle_panel 注册成功（带 action=id）" yes \
  "$(yesno grep -qF -- '[hotkey] registered: Ctrl+Cmd+Shift+F9 (action=toggle_panel)' "$A_LOG")"
check "show_panel 注册成功（这就是多动作的入口）" yes \
  "$(yesno grep -qF -- '[hotkey] registered: Ctrl+Cmd+Shift+F8 (action=show_panel)' "$A_LOG")"
check "hide_panel 注册成功" yes \
  "$(yesno grep -qF -- '[hotkey] registered: Ctrl+Cmd+Shift+F7 (action=hide_panel)' "$A_LOG")"
check "三个动作各注册一次（没有重复注册）" 3 "$(grep -c -- '\[hotkey\] registered' "$A_LOG")"

echo
echo "B. 真按键（系统级合成）→ 分发到动作"
press 100 "$CTRL_CMD_SHIFT" # Ctrl+Cmd+Shift+F8 → show_panel
sleep 1
press 98 "$CTRL_CMD_SHIFT" # Ctrl+Cmd+Shift+F7 → hide_panel
sleep 1
press 101 "$CTRL_CMD_SHIFT" # Ctrl+Cmd+Shift+F9 → toggle_panel
sleep 1
check "进程存活（真按键没把程序打崩）" yes "$(alive)"
stop_app

if grep -q -- '\[hotkey\] pressed' "$A_LOG"; then
  check "show_panel 被真按键触发" yes "$(yesno grep -q -- '-> action show_panel' "$A_LOG")"
  check "show_panel 之后面板可见" yes \
    "$(after_action "$A_LOG" show_panel '\[tray\] show ->')"
  check "hide_panel 被真按键触发" yes "$(yesno grep -q -- '-> action hide_panel' "$A_LOG")"
  check "hide_panel 之后面板收起" yes \
    "$(after_action "$A_LOG" hide_panel '\[tray\] hide ->')"
  check "toggle_panel 被真按键触发" yes "$(yesno grep -q -- '-> action toggle_panel' "$A_LOG")"
  check "每个按键都留下「按了哪个键 → 哪个动作」的日志" 3 \
    "$(grep -c -- '\[hotkey\] pressed' "$A_LOG")"
else
  # 合成按键需要给运行本脚本的程序"辅助功能"权限（系统设置 → 隐私与安全性 → 辅助功能）。
  # 没权限时 System Events 静默不投递（osascript 仍返回 0），所以这里如实报 SKIP，
  # 不假装通过；按键之后那半条链由用例 C 的应用内自检覆盖（同一套 dispatch + 真实窗口状态）。
  SKIP=$((SKIP + 1))
  echo "  SKIP  真按键分发（本机没给辅助功能权限，合成按键不会被系统投递）"
  echo "        想要真按键验证：系统设置 → 隐私与安全性 → 辅助功能，勾上运行本脚本的终端后重跑"
fi
check "日志里没有 panic" no \
  "$(yesno grep -q -e "panicked" -e "运行 Y-Hub 桌面客户端异常" "$A_LOG")"

echo
echo "C. 应用内自检：apply_hotkey（与设置界面同一条 IPC 路径）→ 系统注册 → 分发 → 面板真的动了"
SELF_CFG="$TMP/config-self"
mkdir -p "$SELF_CFG"
printf '{"version":1,"hotkeys":{"toggle_panel":"Ctrl+Cmd+Shift+F9"},"tray":{"show_on_start":false}}' \
  >"$SELF_CFG/settings.json"
SELF_LOG="$TMP/self.log"
: >"$SELF_LOG"
# 同上：C 组要真窗口状态（dispatch show_panel -> visible），显式关掉静默启动
YHUB_DEBUG_HOTKEY_SELFTEST=1 YHUB_CONFIG_DIR="$SELF_CFG" YHUB_SELFTEST_HIDDEN=0 "$BIN" >>"$SELF_LOG" 2>&1 &
APP_PID=$!
wait_log "$SELF_LOG" '\[selftest\] (PASS|FAIL)' 25
check "自检跑完并给出结论" yes \
  "$(yesno grep -qE -- '\[selftest\] (PASS|FAIL)' "$SELF_LOG")"
check "自检全部通过" yes "$(yesno grep -q -- '\[selftest\] PASS' "$SELF_LOG")"
check "自检覆盖：非法组合键被拒" yes \
  "$(yesno grep -q -- '\[selftest\] invalid combo rejected.*OK' "$SELF_LOG")"
check "自检覆盖：绑定先注册进系统再落盘" yes \
  "$(yesno grep -q -- '\[selftest\] bind registers in system.*OK' "$SELF_LOG")"
check "自检覆盖：冲突被拒且不动运行时" yes \
  "$(yesno grep -q -- '\[selftest\] conflict keeps runtime untouched.*OK' "$SELF_LOG")"
check "自检覆盖：解绑后系统里也注销了" yes \
  "$(yesno grep -q -- '\[selftest\] unbind unregisters in system.*OK' "$SELF_LOG")"
check "自检覆盖：hide_panel 收起面板" yes \
  "$(yesno grep -q -- '\[selftest\] dispatch hide_panel -> hidden.*OK' "$SELF_LOG")"
check "自检覆盖：show_panel 呼出面板" yes \
  "$(yesno grep -q -- '\[selftest\] dispatch show_panel -> visible.*OK' "$SELF_LOG")"
check "自检覆盖：toggle_panel 从收起态呼出" yes \
  "$(yesno grep -q -- '\[selftest\] dispatch toggle_panel（收起态）-> 呼出.*OK' "$SELF_LOG")"
check "自检覆盖：未绑定的组合键不触发动作" yes \
  "$(yesno grep -q -- '\[selftest\] dispatch unbound combo -> no action.*OK' "$SELF_LOG")"
# 自检跑完会自己退出（0 = 全过 / 1 = 有失败），所以这里等退出码，而不是看进程还活着
for _ in $(seq 1 100); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.2; done
wait "$APP_PID"
SELF_RC=$?
APP_PID=""
check "自检进程按结论退出（0 = 全过）" 0 "$SELF_RC"

echo
echo "D. 冲突兜底：两个动作写同一个键（写法/顺序不同，其实是同一个热键）"
CFG_D="$TMP/config-d"
mkdir -p "$CFG_D"
printf '{"version":1,"hotkeys":{"toggle_panel":"Shift+Cmd+K","show_panel":"Cmd+Shift+K","hide_panel":""}}' \
  >"$CFG_D/settings.json"
D_LOG="$TMP/d.log"
launch "$CFG_D" "$D_LOG"
wait_log "$D_LOG" '\[hotkey\] registered' 10
sleep 0.5
check "进程存活（冲突不崩）" yes "$(alive)"
stop_app
check "日志说明冲突（说清跟哪个动作抢）" yes \
  "$(yesno grep -q -- '已经绑定给' "$D_LOG")"
check "日志给出人话结论" yes \
  "$(yesno grep -q -- '同一个组合键不能绑两个动作' "$D_LOG")"
check "冲突键只注册一次" 1 "$(grep -c -- '\[hotkey\] registered: Shift+Cmd+K' "$D_LOG")"
check "被抢的那项回退默认（show_panel 默认不绑定）" yes \
  "$(yesno grep -qF -- '[hotkey] show_panel 未绑定，跳过注册' "$D_LOG")"

echo
echo "E. 解绑：组合键留空 → 不注册"
CFG_E="$TMP/config-e"
mkdir -p "$CFG_E"
printf '{"version":1,"hotkeys":{"toggle_panel":"","show_panel":"","hide_panel":""}}' >"$CFG_E/settings.json"
E_LOG="$TMP/e.log"
launch "$CFG_E" "$E_LOG"
wait_log "$E_LOG" 'toggle_panel 未绑定' 10
check "进程存活" yes "$(alive)"
check "toggle_panel 明确跳过注册" yes \
  "$(yesno grep -qF -- '[hotkey] toggle_panel 未绑定，跳过注册' "$E_LOG")"
check "一个热键都没注册" 0 "$(grep -c -- '\[hotkey\] registered' "$E_LOG")"
stop_app

if [ -n "${KEEP_DIR:-}" ]; then
  mkdir -p "$KEEP_DIR"
  cp "$TMP"/*.log "$KEEP_DIR"/ 2>/dev/null
  echo "==> 程序日志已复制到 $KEEP_DIR"
fi

stop_app
echo
echo "==== 结果：PASS=$PASS FAIL=$FAIL SKIP=$SKIP ===="
[ "$FAIL" -eq 0 ]
