#!/usr/bin/env bash
#
# 抢焦点场景验证：在「面板不是前台」的条件下，跑一份会启动 app 的验证脚本。
#
# 为什么单独有这么个脚本：托盘/热键自检的显隐断言会跟「失焦自动收起」竞态 —— 面板刚显示，
# 前台就被别的应用拿走 → `main.rs` 的失焦自动收起把面板藏起来 → 350ms 后断言读到的是
# 「已收起」→ 假 FAIL（产品行为正确，是断言和环境在抢）。**本用例的唯一价值就是能稳定构造
# 这个场景**，所以它不能被删掉、也不能被削弱。
#
# 旧手法（已弃用）与它的问题：
#   每 250ms `open -a TextEdit` 一次，跑前/跑后还 `pgrep -x TextEdit` + kill 掉本机**所有**
#   TextEdit 实例。实测代价：
#   * 桌面被劫持：用户点回自己的窗口，0.25 秒后又被拖走 —— 一次两分钟里 273 次激活 / 140.3s
#     （2.70~2.80 次/秒），设备端 TextEdit 启动时间戳逐秒对齐；
#   * `kill` 掉别人开着的 TextEdit —— 未保存文档有丢失风险（设计缺陷，不是偶发）；
#   * 屏幕上真的会弹出 TextEdit 的窗口。
#
# 新手法把「抢焦点」降级成**有界、可核对、不占用桌面**的一步：
#
#   * 对手 = 系统自带的「访达」(Finder)，用 `System Events` 把它设为前台。选它的理由：
#     ① 它本来就常驻，不需要新建/安装/打包任何东西（对手不是我们带进来的应用）；
#     ② 没有访达窗口时激活它，屏幕上**不会出现任何窗口**（`onscreen-windows.py` 实测：激活
#        前后访达窗口数都是 0），用户能看到的只有菜单栏归属变化 —— 与点一下桌面同效；不存在
#        「有个窗口自己弹出来」，也没有哪个文档会抢走键盘输入；
#     ③ 它不会加载文档、不写盘、不联网，是 macOS 里最不可能跟用户工作抢资源的应用。
#
#   * **只在被测 app 自己拿到前台的那一瞬间抢一次**（默认 `YHUB_FOCUS_MODE=on-demand`）：
#     每 250ms 看一次前台是谁（`lsappinfo front`），前台不是被测 app 就**什么都不做**。这就是
#     「用户在自己的窗口里工作时，本探针一次都不碰桌面」的实现 —— 旧手法恰恰相反：每 0.25 秒
#     把用户从他的窗口里拖走一次，那才是用户抱怨的「抢持桌面」。
#
#   * **不 kill、不 pgrep 任何应用实例**：全程不碰 TextEdit 或任何编辑器；唯一 kill 的是本脚本
#     自己起的抢焦点循环（`$STEAL_PID`）。跑完把前台还给「跑之前的前台应用」。
#
#   * 有上限：抢满 `YHUB_FOCUS_MAX_STEALS`（默认 60）次后不再抢，收尾报告里会写明。
#
#   * 默认**不跑**：必须显式 `YHUB_FOCUS_STEAL=1`。它不在 `make` / 默认验收链路里，也不要接进
#     CI —— 它会短暂改变前台归属（见上），只适合「这台机器现在没人在用桌面」时手动跑。
#
# 一个诚实的边界：被测 app 是**按进程名**认的（`YHUB_FOCUS_TARGET`，默认 `yhub`）。所以跑这个用例
# 期间，如果本机常驻的那个 Y-Hub 实例（或它的面板）抢到前台，也会一并被抢走 —— 这是「只在没人用桌面时跑」
# 的又一条理由，不是缺陷。
#
# 用法：
#   YHUB_FOCUS_STEAL=1 ./tauri/scripts/probe-focus-steal.sh                        # 默认跑托盘行为验证
#   YHUB_FOCUS_STEAL=1 ./tauri/scripts/probe-focus-steal.sh tauri/scripts/verify-hotkeys.sh --no-build
#
# 环境变量：
#   YHUB_FOCUS_STEAL=1          必须显式打开（没设 = 只打印说明并退出 3）
#   YHUB_FOCUS_MODE             on-demand（默认，只在前台是被测 app 时抢一次）/ off（完全不抢，
#                                 只观测前台归属，拿「安静环境」基线）。没有「无条件一直抢」的模式：
#                                 那正是旧手法的缺陷，本卡不再提供这条路径。
#                                 观测每轮都要起 lsappinfo，间隔是下限（实测 0.25s 的设置跑出来约 0.44s/轮）。
#   YHUB_FOCUS_TARGET=yhub    被测 app 的进程名（大小写不敏感的前缀匹配）
#   YHUB_FOCUS_OPPONENT=Finder  抢焦点对手（进程名，交给 System Events 设为前台）
#   YHUB_FOCUS_INTERVAL=0.25    观测/抢的间隔（秒，实际会略大：每轮还要起两个 lsappinfo）
#   YHUB_FOCUS_MAX_STEALS=60    最多抢多少次
#   KEEP_DIR=…                    把被测脚本的输出留一份（默认只打印尾部）

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=app-test-lock.sh
source "$SCRIPT_DIR/app-test-lock.sh"
yhub_app_test_lock "$0" "$@"

INTERVAL="${YHUB_FOCUS_INTERVAL:-0.25}"
MODE="${YHUB_FOCUS_MODE:-on-demand}"
TARGET_APP="${YHUB_FOCUS_TARGET:-yhub}"
OPPONENT="${YHUB_FOCUS_OPPONENT:-Finder}"
MAX_STEALS="${YHUB_FOCUS_MAX_STEALS:-60}"

# 不给参数 = 跑默认目标（托盘行为验证）；只给 --no-build 这种选项时，选项转给默认目标
if [ "${#}" -eq 0 ] || [ "${1#-}" != "$1" ]; then
  TARGET=("$SCRIPT_DIR/verify-tray-behavior.sh" "$@")
else
  TARGET=("$@")
fi

if [ "${YHUB_FOCUS_STEAL:-}" != "1" ]; then
  cat <<'MSG'
==> 这个用例会**短暂改变前台归属**（把前台交给访达），所以默认不跑。
    确实要跑（先确认这台机器现在没人在用桌面）时显式打开：
        YHUB_FOCUS_STEAL=1 ./tauri/scripts/probe-focus-steal.sh [--no-build]
    它不在 make / 默认验收链路里，别接进 CI。
    只观测前台归属、完全不抢（安静的基线）：加 YHUB_FOCUS_MODE=off
MSG
  exit 3
fi

case "$MODE" in
on-demand | off) ;;
*)
  echo "YHUB_FOCUS_MODE 只能是 on-demand / off（现在：${MODE}）" >&2
  exit 2
  ;;
esac

if [ -n "${KEEP_DIR:-}" ]; then
  mkdir -p "$KEEP_DIR"
  LOG="$KEEP_DIR/focus-steal.log"
else
  LOG="$(mktemp -t yhub-focus-steal)"
fi
STATS="$(mktemp -t yhub-focus-stats)"
STEAL_PID=""

front_name() { # 当前前台应用的进程名（拿不到就打印空；注意可能是本地化名，如「访达」）
  local asn
  asn="$(lsappinfo front 2>/dev/null)" || return 0
  [ -n "$asn" ] || return 0
  lsappinfo info -only name "$asn" 2>/dev/null | sed -n 's/^"\(.*\)" ASN:.*/\1/p'
}

front_pid() { # 当前前台应用的 pid（System Events 口径；还前台用它，免得踩本地化名）
  osascript -e 'tell application "System Events" to get unix id of first process whose frontmost is true' 2>/dev/null | tr -d '[:space:]'
}

lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

is_target() { # is_target <进程名>
  local f
  f="$(lc "$1")"
  [ -n "$f" ] || return 1
  case "$f" in
  *"$(lc "$TARGET_APP")"*) return 0 ;;
  *) return 1 ;;
  esac
}

steal() { # 让对手成为前台（本脚本唯一改变前台归属的入口）；失败原因原样回给调用方
  osascript -e "tell application \"System Events\" to set frontmost of process \"${OPPONENT}\" to true" 2>&1
}

FRONT_BEFORE="$(front_name)"
FRONT_BEFORE_PID="$(front_pid)"

restore_front() { # restore_front <pid> <名字（只用于打印）>：把前台还给跑之前的应用
  local want_pid="$1" want_name="$2"
  [ -n "$want_pid" ] || return 0
  [ "$(front_pid)" != "$want_pid" ] || return 0
  # 先按 pid 还（`lsappinfo` 给的是本地化名，拿名字还「访达」会失败）
  osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is ${want_pid}) to true" >/dev/null 2>&1 || true
  if [ "$(front_pid)" != "$want_pid" ] && [ -n "$want_name" ]; then
    osascript -e "tell application \"System Events\" to set frontmost of process \"${want_name}\" to true" >/dev/null 2>&1 || true
  fi
  if [ "$(front_pid)" = "$want_pid" ]; then
    echo "==> 前台已还给「${want_name:-pid ${want_pid}}」（pid ${want_pid}）"
  else
    echo "==> 前台没能还给「${want_name:-pid ${want_pid}}」（pid ${want_pid}）—— 点一下你自己的窗口即可，不影响功能"
  fi
}

stop_stealer() {
  [ -n "$STEAL_PID" ] || return 0
  kill "$STEAL_PID" 2>/dev/null
  wait "$STEAL_PID" 2>/dev/null
  STEAL_PID=""
}

cleanup() { # 退出兜底：只停自己的循环 + 还前台，不 kill 任何应用进程
  stop_stealer
  restore_front "$FRONT_BEFORE_PID" "$FRONT_BEFORE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> 被测脚本：${TARGET[*]}"
echo "==> 抢焦点：对手=${OPPONENT}，模式=${MODE}，间隔=${INTERVAL}s，上限=${MAX_STEALS} 次"
echo "==> 跑之前的前台：${FRONT_BEFORE:-未知}（pid ${FRONT_BEFORE_PID:-未知}；收尾时还给它）"
echo "==> 输出留 ${LOG}"

if [ "$MODE" != "off" ]; then
  # 先确认对手真的能被激活：System Events / 辅助功能没授权时它会**静默失败**，那样这个用例就退化
  # 成「什么都没验证」。这里必须响（同 app-test-lock.sh 的态度：宁可明确失败，也不静默退化）。
  # 注意：别去比对进程名 —— 同一个进程 `lsappinfo` 给的是本地化名（访达），System Events 给的是
  # 英文名（Finder），拿名字比会误判。这里看两件事：命令有没有报错、前台有没有真的换人。
  STEAL_ERR="$(steal)"
  steal_rc=$?
  sleep 0.4
  probe_front="$(front_name)"
  if [ "$steal_rc" != "0" ] || [ -n "$STEAL_ERR" ]; then
    echo "==> 抢焦点自检失败：激活「${OPPONENT}」时报错（rc=${steal_rc}）：${STEAL_ERR}" >&2
    echo "    多半是 System Events 自动化 / 辅助功能没授权给跑这个脚本的终端（-1743 / -1719 / -10006）。" >&2
    echo "    授权后重跑；不想授权就别跑对抗场景（YHUB_FOCUS_MODE=off 只观测前台，不构成对抗条件）。" >&2
    exit 4
  fi
  if [ "$probe_front" = "$FRONT_BEFORE" ] && is_target "$probe_front"; then
    echo "==> 抢焦点自检失败：激活「${OPPONENT}」之后前台还是被测 app（${probe_front}）" >&2
    exit 4
  fi
  echo "==> 对手可用（前台：${FRONT_BEFORE:-未知} -> ${probe_front:-未知}；访达在 lsappinfo 里是本地化名）"
fi

# 抢焦点循环：只把统计写进 $STATS，不碰任何应用进程；被测脚本一结束就被上面 stop_stealer 杀掉
(
  steals=0
  target_ticks=0
  ticks=0
  capped=0
  while :; do
    f="$(front_name)"
    ticks=$((ticks + 1))
    is_target "$f" && target_ticks=$((target_ticks + 1))
    if [ "$MODE" = "on-demand" ] && is_target "$f"; then
      if [ "$steals" -ge "$MAX_STEALS" ]; then
        capped=1
      else
        steal
        steals=$((steals + 1))
      fi
    fi
    printf '%s %s %s %s\n' "$steals" "$target_ticks" "$ticks" "$capped" >"$STATS"
    sleep "$INTERVAL"
  done
) &
STEAL_PID=$!

"${TARGET[@]}" >"$LOG" 2>&1
RC=$?
stop_stealer

STEALS=0
TARGET_TICKS=0
TICKS=0
CAPPED=0
if [ -s "$STATS" ]; then
  read -r STEALS TARGET_TICKS TICKS CAPPED <"$STATS" || true
fi
FRONT_AFTER="$(front_name)"

echo
echo "==> 被测脚本退出码：$RC"
echo "==> 自检结论行："
grep -E '\[selftest\] (PASS|FAIL|done)|^  (FAIL|SKIP)|^==== ' "$LOG" | tail -20 || true
if [ -n "${KEEP_DIR:-}" ]; then
  echo "==> 完整日志：$LOG"
else
  echo "==> 完整日志（临时文件，本脚本不删）：$LOG"
fi

echo
echo "==> 对抗场景核对（本用例唯一的产物）"
echo "    观测 ${TICKS} 轮 / 每 ${INTERVAL}s 一轮；期间前台属于被测 app（${TARGET_APP}）的采样 ${TARGET_TICKS} 轮"
echo "    抢焦点 ${STEALS} 次（上限 ${MAX_STEALS}）；此刻前台：${FRONT_AFTER:-未知}"
if [ "$CAPPED" = "1" ]; then
  echo "    注意：已到抢焦点上限，之后的「前台是被测 app」时刻没有再抢"
fi
if [ "$MODE" = "off" ]; then
  echo "    模式 off：本次没有抢焦点 —— 这是「安静环境」基线，不是对抗场景"
elif [ "$STEALS" = "0" ]; then
  echo "    模式 ${MODE} 但一次都没抢：这段时间被测 app 从来没拿到过前台，说明环境本身就是"
  echo "    「面板抢不到前台」的状态 —— 对抗条件天然成立（自检日志里应能看到 focused=true 紧跟"
  echo "    focused=false / blur -> hide）。"
fi
echo "    本脚本没有 kill 任何应用进程（只 kill 自己起的抢焦点循环）"

restore_front "$FRONT_BEFORE_PID" "$FRONT_BEFORE"
exit "$RC"
