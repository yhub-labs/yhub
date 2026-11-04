#!/usr/bin/env bash
# 后端桥接（Tauri ↔ Python 后端）的端到端验证：真跑桌面程序，用假后端把"拉得起、连得上、
# 崩了能自愈、关得掉、日志能定位"这几件事逐条断言出来。
#
# 为什么用假后端：这一层要验的是**桥接**（定位产物 → 拉起 → 等就绪 → HTTP 探活 → 收日志 →
# 优雅关闭），不是 Python 业务。假后端是一个 30 行的 stdlib http.server，只认 /api/health 与
# /api/tools，可以精确控制"能起来 / 永远起不来 / 环境变量写错"三种情形，跑得又快又稳。
# 真后端另有一个用例（E）：本机装了 yhub 就用它，没有就用 uv run 起真服务，验真接口。
#
# 覆盖：
#   A. 正常路径：按需拉起 → /api/health 拿到版本、/api/tools 拿到工具数 → 子进程 stdout 进日志
#      → 退出时只关自己拉起的那个（端口释放、进程不残留）
#   B. 拉不起来（进程起来了但永远不听端口）：有界超时 + 人话错误 + 日志路径 + 清理子进程 + 不卡死
#   C. 环境变量写错（YHUB_BACKEND_BIN 指向不存在的文件）：不假装成功，错误里带路径与办法
#   D. 复用已在跑的后端：不重复拉起、退出时不杀别人的进程
#   E. 真后端（可选）：已安装 yhub 或 uv run 起真服务，验真 /api/health + /api/tools
#
# 用法：tauri/scripts/verify-backend-bridge.sh [--no-build]
#   RUN_TIMEOUT=40        每个用例最多等多少秒（自检跑完会自己退出）
#   KEEP_DIR=…            把各用例的程序日志与后端日志复制到这个目录（默认随临时目录一起删）
#   YHUB_BIN=…          指定被测二进制（并行开发时建议 cp 一份快照再用它）
#   YHUB_REAL_BACKEND=… 指定真后端 `yhub`（默认找 PATH / ~/.local/bin/yhub，都没有就 uv run）
#
# 安全性：程序以 YHUB_CONFIG_DIR 指向临时目录运行，绝不读写 ~/.config/yhub/。
# 端口：每个用例都换一个空闲端口（YHUB_BACKEND_PORT），不碰 8790 上你正在用的后端。

set -uo pipefail

RUN_TIMEOUT="${RUN_TIMEOUT:-40}"
DO_BUILD=1
[ "${1:-}" = "--no-build" ] && DO_BUILD=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$TAURI_DIR/.." && pwd)"

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
echo "==> 二进制指纹：$(md5 -q "$BIN" 2>/dev/null || shasum -a 256 "$BIN" | awk '{print $1}')"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/yhub-backend-verify.XXXXXX")"
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
has() { # has <日志文件> <正则> → yes/no
  if grep -qE -- "$2" "$1" 2>/dev/null; then echo yes; else echo no; fi
}
grep1() { # grep1 <文件> <正则>：取第一处匹配（没匹配到就空）
  grep -oE -- "$2" "$1" 2>/dev/null | head -1
}

# 每个用例一个空闲端口，避免和本机正在跑的后端抢 8790
free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

# ---------------------------------------------------------------- 三个假后端

cat >"$TMP/stub_ok.py" <<'PY'
#!/usr/bin/env python3
"""验证用假后端：只说 HTTP，不做真业务。端口从 YHUB_PORT 读（与真后端同一契约）。"""
import json
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("YHUB_PORT", "8790"))
READY_FILE = os.environ.get("STUB_READY_FILE", "")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, payload, status=200):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/health":
            self._send({"ok": True, "version": "stub-1.0.0", "service": "yhub-stub"})
        elif self.path == "/api/tools":
            self._send({"ok": True, "tools": [{"id": "zdic"}, {"id": "memos"}, {"id": "lv"}]})
        else:
            self._send({"ok": False, "error": "no such route"}, 404)

    def log_message(self, *args):  # 安静点
        pass


srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
# 先打印再进循环：这一行同时证明"子进程 stdout 被后端日志接住了"
print("[stub] backend ready on 127.0.0.1:%d pid=%d" % (PORT, os.getpid()), flush=True)
if READY_FILE:
    with open(READY_FILE, "w") as fh:
        fh.write(str(os.getpid()))


def bye(*_args):
    sys.exit(0)


signal.signal(signal.SIGTERM, bye)
srv.serve_forever()
PY
chmod +x "$TMP/stub_ok.py"

# 起得来、但永远不听端口：用来验"等就绪超时"
cat >"$TMP/stub_never.py" <<'PY'
#!/usr/bin/env python3
"""起来了但永远不监听端口：专门制造"等就绪超时"。"""
import os
import time

print("[stub-never] started pid=%d port=%s (故意不听端口)" % (os.getpid(), os.environ.get("YHUB_PORT")), flush=True)
time.sleep(300)
PY
chmod +x "$TMP/stub_never.py"

# ---------------------------------------------------------------- 用例运行器

EXTRA_ENV=""
run_case() { # run_case <日志名>：跑程序直到自检自己退出（EXTRA_ENV 追加环境变量）
  LOG="$TMP/$1.log"
  : >"$LOG"
  # 默认静默启动（YHUB_SELFTEST_HIDDEN=1）：本脚本只验后端桥接，不需要面板，也不该弹窗。
  # EXTRA_ENV 排在后面，用例要真窗口时写 YHUB_SELFTEST_HIDDEN=0 就能盖掉。
  # shellcheck disable=SC2086
  env YHUB_CONFIG_DIR="$CFG" YHUB_DEBUG_BACKEND_SELFTEST="$SELFTEST_MODE" \
    YHUB_SELFTEST_HIDDEN="${YHUB_SELFTEST_HIDDEN:-1}" $EXTRA_ENV "$BIN" >"$LOG" 2>&1 &
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

# 每个用例都要求的公共结论：自检跑完、全绿、退出码 0、进程没赖着不走
common_checks() { # common_checks <用例名>
  local log="$TMP/$CASE_LOG.log"
  check "$1：自检跑完（done failures=0）" yes "$(has "$log" '\[selftest\] done failures=0')"
  check "$1：没有 selftest FAIL 行" no "$(has "$log" '\[selftest\] .* FAIL$')"
  check "$1：进程自行退出（存活=0）" 0 "$ALIVE"
  check "$1：退出码 0" 0 "$EXIT_CODE"
}

port_alive() { # port_alive <端口> → yes/no
  python3 - "$1" <<'PY'
import socket, sys
s = socket.socket()
s.settimeout(0.4)
try:
    s.connect(("127.0.0.1", int(sys.argv[1])))
    print("yes")
except OSError:
    print("no")
finally:
    s.close()
PY
}

pid_alive() { # pid_alive <pid> → yes/no
  if kill -0 "$1" 2>/dev/null; then echo yes; else echo no; fi
}

# ---------------------------------------------------------------- A. 正常路径

echo
echo "A. 正常路径：按需拉起假后端 → 探活 → 收日志 → 退出时关掉自己拉起的进程"
PORT_A="$(free_port)"
CFG="$TMP/config-a"
mkdir -p "$CFG"
SELFTEST_MODE="1"
EXTRA_ENV="YHUB_BACKEND_BIN=$TMP/stub_ok.py YHUB_BACKEND_PORT=$PORT_A"
CASE_LOG="a"
run_case a
EXTRA_ENV=""
common_checks "正常路径"
A="$TMP/a.log"
BACKEND_LOG="$CFG/logs/backend.log"
DESKTOP_LOG="$CFG/logs/desktop.log"
check "正常路径：按需拉起（source=external 且写了日志）" yes "$(has "$A" "\[backend\] 拉起后端：.*\(source=external, port=$PORT_A\)")"
check "正常路径：等到了就绪（记录 pid 与首次响应耗时）" yes "$(has "$A" "\[backend\] 后端就绪：pid=[0-9]+ source=external version=stub-1\.0\.0 首次响应 [0-9]+ ms")"
check "正常路径：/api/health 拿到后端自报的版本（不是本地常量）" yes "$(has "$A" 'health: ok=true version=Some\("stub-1\.0\.0"\)')"
check "正常路径：/api/tools 拿到 3 个工具（真实业务接口通了）" yes "$(has "$A" 'tools=Some\(3\)')"
check "正常路径：status 报告运行中" yes "$(has "$A" 'status 报告运行中: got=true want=true OK')"
check "正常路径：调用不存在的接口有界返回（不卡死）" yes "$(has "$A" '调用不存在的接口有界返回（不卡死）: got=true want=true OK')"
check "正常路径：崩溃后下一次调用自动重新拉起（自愈）" yes "$(has "$A" '崩溃后下一次调用自动重新拉起（自愈）: got=true want=true OK')"
check "正常路径：退出时只关自己拉起的那个（关的是我们拉起的 pid）" yes "$(has "$A" '\[backend\] 已关闭自启后端 pid=[0-9]+')"
check "正常路径：退出钩子也跑过（第二次调用是空操作，不重复关）" yes "$(has "$A" '没有本进程拉起的后端，跳过（app exit）')"
check "正常路径：关闭后端口已释放" yes "$(has "$A" '关闭后端口已释放: got=true want=true OK')"
check "正常路径：假后端的 stdout 被接进后端日志（能定位）" yes "$(has "$BACKEND_LOG" '\[stub\] backend ready on 127\.0\.0\.1:'$PORT_A)"
check "正常路径：桌面端日志也落盘（logs/desktop.log，带时间戳）" yes "$(has "$DESKTOP_LOG" '^\[20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:]{8}\] 拉起后端：')"
check "正常路径：桌面端日志记下了关闭（同一份日志能串起全过程）" yes "$(has "$DESKTOP_LOG" '已关闭自启后端 pid=[0-9]+')"
check "正常路径：跑完端口空着（没有残留监听）" no "$(port_alive "$PORT_A")"
LAST_PID="$(grep -oE '后端就绪：pid=[0-9]+' "$A" 2>/dev/null | tail -1 | tr -dc '0-9')"
if [ -n "${LAST_PID:-}" ]; then
  check "正常路径：最后拉起的后端进程已退出（pid=${LAST_PID}）" no "$(pid_alive "$LAST_PID")"
else
  no "正常路径：没能从日志里取到最后拉起的 pid（日志格式变了？）"
fi

# ---------------------------------------------------------------- B. 起不来

echo
echo "B. 拉不起来（进程活着但永不听端口）：有界超时 + 人话错误 + 清理 + 不卡死"
PORT_B="$(free_port)"
CFG="$TMP/config-b"
mkdir -p "$CFG"
SELFTEST_MODE="timeout"
EXTRA_ENV="YHUB_BACKEND_BIN=$TMP/stub_never.py YHUB_BACKEND_PORT=$PORT_B YHUB_BACKEND_TIMEOUT_MS=1500"
CASE_LOG="b"
run_case b
EXTRA_ENV=""
common_checks "起不来"
B="$TMP/b.log"
check "起不来：自检认定「拉不起后端时不假装成功」" yes "$(has "$B" '拉不起后端时不假装成功: got=false want=false OK')"
check "起不来：失败原因说清了（超时/进程早退）" yes "$(has "$B" '失败信息说清了原因（超时/进程早退）: got=true want=true OK')"
check "起不来：错误里带日志路径（可定位）" yes "$(has "$B" '失败信息带日志路径（可定位）: got=true want=true OK')"
check "起不来：真的按超时收手（错误文本里有等待上限）" yes "$(has "$B" '后端没能在 1500 ms 内就绪')"
check "起不来：把刚拉起的进程清理掉了（不留孤儿）" yes "$(has "$B" '已清理刚拉起的进程（SIGTERM')"
check "起不来：失败后端口空着（没有假装在跑）" yes "$(has "$B" '失败后不留监听进程（端口空着）: got=true want=true OK')"
check "起不来：失败后查状态仍有界返回（App 没卡死）" yes "$(has "$B" '失败后状态查询仍有界返回: got=true want=true OK')"
check "起不来：跑完端口真的空着" no "$(port_alive "$PORT_B")"
NEVER_PID="$(grep1 "$CFG/logs/backend.log" 'stub-never\] started pid=[0-9]+' | tr -dc '0-9')"
check "起不来：那个不听端口的子进程已不在（pid=${NEVER_PID}）" no "$(pid_alive "$NEVER_PID")"

# ---------------------------------------------------------------- C. 环境变量写错

echo
echo "C. 环境变量写错（YHUB_BACKEND_BIN 指向不存在的文件）：不假装成功，说清怎么办"
PORT_C="$(free_port)"
CFG="$TMP/config-c"
mkdir -p "$CFG"
SELFTEST_MODE="badbin"
EXTRA_ENV="YHUB_BACKEND_BIN=$TMP/not-there-at-all YHUB_BACKEND_PORT=$PORT_C"
CASE_LOG="c"
run_case c
EXTRA_ENV=""
common_checks "环境变量写错"
C="$TMP/c.log"
check "写错：自检认定「不假装成功」" yes "$(has "$C" '环境变量写错时不假装成功: got=false want=false OK')"
check "写错：错误里带上写错的路径" yes "$(has "$C" '错误里带上写错的路径: got=true want=true OK')"
check "写错：错误里有怎么办（hint）" yes "$(has "$C" '错误里有怎么办（hint）: got=true want=true OK')"
check "写错：人话错误直接可读（含变量名与路径）" yes "$(has "$C" 'YHUB_BACKEND_BIN 指向的文件不存在')"

# ---------------------------------------------------------------- D. 复用已有后端

echo
echo "D. 复用已在跑的后端：不重复拉起、退出时不杀别人的进程"
PORT_D="$(free_port)"
CFG="$TMP/config-d"
mkdir -p "$CFG"
SELFTEST_MODE="1"
STUB_READY="$TMP/stub-d.ready"
rm -f "$STUB_READY"
YHUB_PORT="$PORT_D" STUB_READY_FILE="$STUB_READY" "$TMP/stub_ok.py" >"$TMP/stub-d.out" 2>&1 &
STUB_D_PID=$!
for _ in $(seq 1 40); do [ -s "$STUB_READY" ] && break; sleep 0.25; done
check "复用：外部后端已就位（脚本自己起的）" yes "$(port_alive "$PORT_D")"
EXTRA_ENV="YHUB_BACKEND_BIN=$TMP/stub_ok.py YHUB_BACKEND_PORT=$PORT_D"
CASE_LOG="d"
run_case d
EXTRA_ENV=""
common_checks "复用"
D="$TMP/d.log"
check "复用：状态里来源是 reused（没重复拉起）" yes "$(has "$D" 'ensure_running: running=true healthy=true source=reused owned=false')"
check "复用：没有打印「拉起后端」（真的一次都没起）" no "$(has "$D" '\[backend\] 拉起后端：')"
check "复用：自检明确跳过了关闭相位" yes "$(has "$D" '端口上是别人拉起的后端（source=reused）：跳过崩溃自愈与关闭相位')"
check "复用：退出后外部后端仍然活着（没被我们杀掉）" yes "$(pid_alive "$STUB_D_PID")"
check "复用：退出后端口仍在服务" yes "$(port_alive "$PORT_D")"
kill "$STUB_D_PID" 2>/dev/null
wait "$STUB_D_PID" 2>/dev/null
check "复用：清理掉脚本自己起的后端后端口空着" no "$(port_alive "$PORT_D")"

# ---------------------------------------------------------------- E. 真后端（可选）

echo
echo "E. 真后端（可选）：已安装 yhub 或 uv run 起真服务，验真 /api/health + /api/tools"
REAL_BIN="${YHUB_REAL_BACKEND:-$(command -v yhub 2>/dev/null || true)}"
if [ -z "$REAL_BIN" ] && [ -x "$HOME/.local/bin/yhub" ]; then
  REAL_BIN="$HOME/.local/bin/yhub"
fi
if [ -n "$REAL_BIN" ] && [ -x "$REAL_BIN" ]; then
  echo "      （用已安装的 yhub：${REAL_BIN}）"
  REAL_CMD="$REAL_BIN"
elif command -v uv >/dev/null 2>&1; then
  echo "      （没有已安装的 yhub，退回 uv run 起源码态真服务）"
  cat >"$TMP/real_wrapper.sh" <<PY
#!/bin/sh
cd "$REPO_DIR" && exec uv run yhub "\$@"
PY
  chmod +x "$TMP/real_wrapper.sh"
  REAL_CMD="$TMP/real_wrapper.sh"
else
  REAL_CMD=""
fi

if [ -z "$REAL_CMD" ]; then
  echo "  SKIP  没有已安装的 yhub，也没有 uv：跳过真后端用例"
else
  PORT_E="$(free_port)"
  CFG="$TMP/config-e"
  mkdir -p "$CFG"
  SELFTEST_MODE="1"
  RUN_TIMEOUT=90
  EXTRA_ENV="YHUB_BACKEND_BIN=$REAL_CMD YHUB_BACKEND_PORT=$PORT_E YHUB_BACKEND_TIMEOUT_MS=60000"
  CASE_LOG="e"
  run_case e
  EXTRA_ENV=""
  RUN_TIMEOUT=40
  common_checks "真后端"
  E="$TMP/e.log"
  check "真后端：等到了就绪（source=external）" yes "$(has "$E" '\[backend\] 后端就绪：pid=[0-9]+ source=external')"
  check "真后端：/api/health 有版本号" yes "$(has "$E" 'health: ok=true version=Some\("[0-9]')"
  check "真后端：/api/tools 拿到工具清单（至少 3 个核心工具）" yes "$(has "$E" 'tools=Some\(([3-9]|[1-9][0-9])\)')"
  check "真后端：工具数不是编的（/api/tools 真返回过）" yes "$(has "$E" '真实业务接口 /api/tools 拿到工具清单: got=true want=true OK')"
  check "真后端：退出后端口空着" no "$(port_alive "$PORT_E")"
fi

if [ -n "${KEEP_DIR:-}" ]; then
  mkdir -p "$KEEP_DIR"
  cp "$TMP"/*.log "$KEEP_DIR"/ 2>/dev/null
  for d in "$TMP"/config-*; do
    [ -d "$d/logs" ] || continue
    mkdir -p "$KEEP_DIR/$(basename "$d")"
    cp "$d/logs"/*.log "$KEEP_DIR/$(basename "$d")/" 2>/dev/null
  done
  echo "==> 程序日志已复制到 $KEEP_DIR"
fi

echo
echo "==== 结果：PASS=$PASS FAIL=$FAIL ===="
[ "$FAIL" -eq 0 ]
