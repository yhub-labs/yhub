#!/usr/bin/env bash
# 「会启动 app 的验证脚本」的机器级互斥：同一时刻只允许一个在跑。
#
# 为什么需要（不是洁癖）：每个验证脚本都会反复启动真 App。两个脚本并发时，屏幕上就是
# 「有个应用在疯狂被打开」——实测过一次两路并发在 27 分钟里启动了 107 次。串行化同时顺手
# 解决三件事：
#   * 屏幕上不再反复弹窗；
#   * 两个脚本不会抢同一个安装落点（verify-packed-app.sh 的 build/install）与同一份报告；
#   * 不会抢注册同一组全局热键（热键是全系统独占的）。
#
# 用法（放在脚本最前面，紧跟 `set -uo pipefail` 之后）：
#     SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#     source "$SCRIPT_DIR/app-test-lock.sh"
#     yhub_app_test_lock "$0" "$@"
#
# 语义：不在锁里 → 拿到锁后**重新 exec 自己**（把锁的 fd 带进新进程，参数原样传）；
#       已经在锁里（YHUB_APP_TEST_LOCK_HELD=1）→ 什么都不做。
# 锁是文件锁：进程一死（含被 kill -9）锁就自动释放，不会留下需要人工清理的死锁。
#
# 环境变量：
#   YHUB_APP_TEST_LOCK       锁文件（默认 /tmp/yhub-app-test.lock）
#   YHUB_APP_TEST_LOCK_WAIT  最多等多少秒（默认 1800；等不到就退出，退出码 75 = EX_TEMPFAIL）
#
# 实现说明：macOS 自带没有 flock(1)（那是 util-linux 的），但有 /usr/bin/lockf；两者语义一样
# （持有锁 → exec 命令 → 命令退出时释放）。所以优先用 flock（Linux / brew 装了 util-linux 时），
# 否则用 lockf。两个都没有就明确报错，不静默退化成「没加锁」。

YHUB_APP_TEST_LOCK="${YHUB_APP_TEST_LOCK:-/tmp/yhub-app-test.lock}"
YHUB_APP_TEST_LOCK_WAIT="${YHUB_APP_TEST_LOCK_WAIT:-1800}"

yhub_app_test_lock() { # yhub_app_test_lock <脚本路径> [脚本参数…]
  if [ "${YHUB_APP_TEST_LOCK_HELD:-}" = "1" ]; then
    if [ -n "${YHUB_APP_TEST_LOCK_WAIT_START:-}" ]; then
      echo "==> [lock] 拿到互斥锁：$(date '+%F %T')（等了 $(( $(date +%s) - YHUB_APP_TEST_LOCK_WAIT_START ))s；锁文件 ${YHUB_APP_TEST_LOCK}）"
      unset YHUB_APP_TEST_LOCK_WAIT_START
    else
      echo "==> [lock] 已在互斥锁内（${YHUB_APP_TEST_LOCK}，由外层脚本持有）"
    fi
    return 0
  fi

  local script="$1"
  shift
  local self
  self="$(cd "$(dirname "$script")" && pwd)/$(basename "$script")"

  local waiter=""
  if command -v flock >/dev/null 2>&1; then
    waiter="flock"
  elif [ -x /usr/bin/lockf ]; then
    waiter="/usr/bin/lockf"
  else
    echo "找不到 flock / lockf：无法加机器级互斥（装 util-linux 或用 macOS 自带的 /usr/bin/lockf）" >&2
    exit 75
  fi

  echo "==> [lock] 等 app 测试互斥锁：${YHUB_APP_TEST_LOCK}（$(date '+%F %T') 开始等，最多 ${YHUB_APP_TEST_LOCK_WAIT}s）"
  echo "        同一台机器上另有一份「会启动 app 的验证脚本」在跑时，会在这里排队而不是并发弹窗"

  local waited
  waited="$(date +%s)"
  if [ "$waiter" = "flock" ]; then
    # shellcheck disable=SC2086
    exec env YHUB_APP_TEST_LOCK_HELD=1 \
      YHUB_APP_TEST_LOCK="$YHUB_APP_TEST_LOCK" \
      YHUB_APP_TEST_LOCK_WAIT_START="$waited" \
      flock -w "$YHUB_APP_TEST_LOCK_WAIT" "$YHUB_APP_TEST_LOCK" "$self" "$@"
  else
    # shellcheck disable=SC2086
    exec env YHUB_APP_TEST_LOCK_HELD=1 \
      YHUB_APP_TEST_LOCK="$YHUB_APP_TEST_LOCK" \
      YHUB_APP_TEST_LOCK_WAIT_START="$waited" \
      "$waiter" -t "$YHUB_APP_TEST_LOCK_WAIT" "$YHUB_APP_TEST_LOCK" "$self" "$@"
  fi
}
