#!/usr/bin/env bash
#
# 一条命令把「当前代码」装成 /Applications/Y-Hub.app —— 本机自用装机步骤的唯一入口。
#
#   ./packaging/install-app.sh                # 构建（输入有变才构建）→ 退出在跑的 App → 归档旧包 → 装新包 → 复核 → 重启
#   ./packaging/install-app.sh --force        # 忽略指纹，强制重新构建
#   ./packaging/install-app.sh --no-build     # 不构建，直接装 tauri/target/release/bundle/macos/Y-Hub.app
#   ./packaging/install-app.sh --no-restart   # 装完不自动拉起（下次自己开）
#
# 为什么需要它：手工步骤散在 docs 里（build → 退 App → rm -rf → ditto → codesign 复核），
# 漏任何一步的代价都是**静默**的 —— 装到上一轮的旧包、签名失效导致「本地网络」授权作废、
# 或者残留一个 PPID=1 的旧后端继续占 8790。这里把每一步固定下来，失败就红着退出。
#
# 「已经是最新」判定：把构建输入（web/ yhub/ packaging/ tauri/src 等）的内容哈希算成
# 一个指纹，连同「装的是哪次构建」一起写进 build/installed-app.json。下次跑先比指纹，
# 没变就直接说「已是最新」并退出 —— 所以只改文档/测试的提交不会触发重建重装。
#
# 退出码：0 装好（或本来就最新）；1 构建/复核失败（旧包已归档，回滚命令会打印出来）。
#
# 改这个脚本的约定：中文字符串里引用变量一律写 ${VAR} —— 「$LOG（」这种写法里 bash 会把
# 全角括号当成变量名的一部分，报 `LOG…: unbound variable`（本脚本第一次跑就踩了）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# tauri / cargo / uv / npm 都装在 ~/.local/bin、~/.cargo/bin —— git hook 与非交互 shell 里
# 没有交互式 PATH，这里显式补上，免得「终端里能跑、hook 里找不到命令」。
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

DO_BUILD=1
FORCE=0
RESTART=1
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --no-build) DO_BUILD=0 ;;
    --no-restart) RESTART=0 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：${arg}（--force / --no-build / --no-restart）" >&2; exit 2 ;;
  esac
done

APP_NAME="Y-Hub"
BUNDLE="$REPO_ROOT/tauri/target/release/bundle/macos/$APP_NAME.app"
DEST="/Applications/$APP_NAME.app"
ARCHIVE_DIR="${YHUB_ARCHIVE_DIR:-$HOME/Applications-Archive}"
KEEP_ARCHIVES=5
STATE="$REPO_ROOT/build/installed-app.json"
LOG="$REPO_ROOT/build/install-app.log"
PORT=8790
CFG_DIR="${YHUB_CONFIG_DIR:-$HOME/.config/yhub}"
BACKEND_PID_FILE="${YHUB_LOG_DIR:-$CFG_DIR/logs}/backend.pid"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { echo "   $*"; }

# 机器级互斥：本脚本会启动真 App（注册全局热键），与「会启动 app 的验证脚本」必须串行。
# 复用同一把锁（tauri/scripts/app-test-lock.sh），不另造一套。
YHUB_APP_TEST_LOCK_WAIT="${YHUB_APP_TEST_LOCK_WAIT:-900}"
source "$REPO_ROOT/tauri/scripts/app-test-lock.sh"
yhub_app_test_lock "$0" "$@"

# ---------------------------------------------------------------- 输入指纹

input_fingerprint() {
  {
    find web -type f ! -path 'web/node_modules/*' ! -path 'web/dist/*' \
      ! -name 'verify-*' ! -name 'smoke.mjs' ! -name '.DS_Store'
    find yhub packaging scripts capsule-src -type f ! -name '.DS_Store' \
      ! -path 'capsule-src/*/node_modules/*'
    find tauri/src tauri/icons -type f ! -name '.DS_Store'
    printf '%s\n' pyproject.toml tauri/Cargo.toml tauri/Cargo.lock \
      tauri/tauri.conf.json tauri/Info.plist
  } 2>/dev/null | LC_ALL=C sort | xargs shasum -a 256 2>/dev/null | shasum -a 256 | awk '{print $1}'
}

json_get() { # json_get <文件> <键>（不用 jq，只读自己写的扁平字段）
  [ -f "$1" ] || return 1
  # 注意 `or ""` 这种写法会把数字 0 也变成空串（0 是 falsy），于是「dirty_files: 0」读出来是 ""，
  # 拿它跟 "0" 比永远不等 —— 实测因此把「提交号从 f3bd116 更新为 f3bd116」也打了出来。
  python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if v is None else v)' "$1" "$2" 2>/dev/null
}

shasum_of() { [ -f "$1" ] && shasum -a 256 "$1" | awk '{print $1}' || echo ""; }

HEAD_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
DIRTY="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
FINGERPRINT="$(input_fingerprint)"

step "0/7 本次要装的代码"
info "HEAD=${HEAD_SHA}$([ "$DIRTY" != "0" ] && echo "（工作区有 ${DIRTY} 处未提交改动 —— 装的就是这棵树，不是干净提交）" || echo "（工作区干净）")"
info "输入指纹 ${FINGERPRINT:0:16}…"

"$REPO_ROOT/scripts/check-versions.sh" || {
  step "版本号不一致，停止装机"
  info "改 yhub/__init__.py、web/package.json、tauri/Cargo.toml、tauri/tauri.conf.json 四处"
  exit 1
}

PREV_FP="$(json_get "$STATE" input_fingerprint || true)"
PREV_EXE_SHA="$(json_get "$STATE" shell_sha256 || true)"
PREV_OK="$(json_get "$STATE" checks_ok || true)"
PREV_BACKEND_OK="$(json_get "$STATE" backend_ok || true)"
# 「已经是最新」必须同时满足三件事，缺一件就会把**旧包**当最新：
#   1) 输入指纹没变；2) 目标 app 在；3) 壳二进制还是那份；
#   另外 4) 上次复核是**通过**的：`checks_ok: false` 的安装记录不能拿来当"最新"的依据。
if [ "$FORCE" = 0 ] && [ "$PREV_FP" = "$FINGERPRINT" ] && [ -d "$DEST" ] \
   && [ "$PREV_OK" = "True" ] \
   && [ "$PREV_BACKEND_OK" = "True" ] \
   && [ "$(shasum_of "$DEST/Contents/MacOS/yhub")" = "$PREV_EXE_SHA" ]; then
  step "已经是最新：输入指纹没变，/Applications/$APP_NAME.app 就是这份代码"
  PREV_COMMIT_NOW="$(json_get "$STATE" commit || true)"
  # 内容没变不等于「记录里的提交号还对」：把改动提交之后，文件一个字节没变、指纹自然也没变，
  # 但记录下来的是「当时那棵树是脏的、提交号是上一个」。不更新的话，下次问「装着哪个提交」
  # 会得到一个误导答案。所以指纹相同也把提交号/脏树状态刷成现在这份。
  if [ "$PREV_COMMIT_NOW" != "$HEAD_SHA" ] || [ "$(json_get "$STATE" dirty_files || true)" != "$DIRTY" ]; then
    python3 - "$STATE" "$HEAD_SHA" "$DIRTY" <<'PY'
import json, sys, time
(state, commit, dirty) = sys.argv[1:4]
with open(state) as fh:
    data = json.load(fh)
data["commit"] = commit
data["dirty_files"] = int(dirty)
data["relabelled_at"] = time.strftime("%F %T")
with open(state, "w") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2); fh.write("\n")
PY
    info "记录的提交号从 ${PREV_COMMIT_NOW} 更新为 ${HEAD_SHA}（内容未变，没重建）"
  else
    info "装的提交：${PREV_COMMIT_NOW}（$(json_get "$STATE" installed_at)）"
  fi
  info "要强制重建：./packaging/install-app.sh --force"
  exit 0
fi

if [ -n "$PREV_FP" ] && [ -f "$STATE" ]; then
  PREV_COMMIT="$(json_get "$STATE" commit || true)"
  if [ -n "$PREV_COMMIT" ] && git rev-parse --verify -q "$PREV_COMMIT" >/dev/null 2>&1; then
    info "上次装的是 ${PREV_COMMIT}，之后的改动（只看构建输入）："
    git log --oneline "$PREV_COMMIT..HEAD" -- web/src yhub packaging tauri/src \
      tauri/tauri.conf.json 2>/dev/null | sed 's/^/     /' | head -20
  fi
fi

# ---------------------------------------------------------------- 构建

if [ "$DO_BUILD" = 1 ]; then
  step "2/7 构建装机包（前端 web/dist + 胶囊 + Tauri release；后端由已安装的 yhub 提供）"
  mkdir -p "$REPO_ROOT/build"
  info "完整日志：${LOG}（构建期间可以另开终端 tail -f）"
  START=$(date +%s)
  if ! ( cd tauri && tauri build --bundles app ) 2>&1 | tee "$LOG"; then
    step "构建失败"
    info "日志尾部：" ; tail -20 "$LOG" | sed 's/^/     /'
    exit 1
  fi
  info "构建耗时 $(( $(date +%s) - START ))s"
else
  step "2/7 跳过构建（--no-build）"
fi

[ -d "$BUNDLE" ] || { step "找不到构建产物 $BUNDLE"; info "先跑 make app 或去掉 --no-build"; exit 1; }

# ---------------------------------------------------------------- 安装后端

# 新架构：.app 里没有 Python，壳启动时拉起**已安装的 yhub**。所以「让本机跟上当前代码」
# 必须同时更新它，否则会出现「App 是新的、后端还是上一版」这种最迷惑的状态。
step "3/7 安装 Python 后端（壳拉起的就是它；此时 web/dist 与 capsules 已是本轮构建）"
BACKEND_OK=0
if command -v uv >/dev/null 2>&1; then
  uv cache clean yhub >/dev/null 2>&1 || true
  if uv tool install . --force >/dev/null 2>&1; then
    BACKEND_OK=1
    info "后端已更新：$(command -v yhub)（$(yhub --version 2>/dev/null || echo '?')）"
  else
    info "⚠ 后端安装失败 —— App 会退回 uv run（源码树）或报「找不到后端」；手动重试：make install-backend"
  fi
else
  info "⚠ 没有 uv：跳过后端安装；请用 pip install . 或 pip install yhub，否则壳找不到后端"
fi
if [ "$BACKEND_OK" = 0 ] && command -v yhub >/dev/null 2>&1 && yhub --version >/dev/null 2>&1; then
  info "已有可用的 yhub，但这一轮没能更新它（下次 make install 会重试）"
fi

# ---------------------------------------------------------------- 退出正在跑的 App

step "4/7 退出正在跑的 App 与它拉起的后端"
stop_app() {
  local pids i
  pids="$(pgrep -f "$DEST" 2>/dev/null | tr '\n' ' ' || true)"
  [ -n "${pids// /}" ] || { info "没有正在跑的 App"; return 0; }
  info "正在退出：$pids"
  # 先 SIGTERM（走 App 自己的退出路径）；App 被杀时退出钩子不一定跑，所以下面还要捞残留。
  kill $pids 2>/dev/null || true
  i=0; while [ "$i" -lt 50 ] && [ -n "$(pgrep -f "$DEST" 2>/dev/null || true)" ]; do sleep 0.1; i=$((i+1)); done
  pids="$(pgrep -f "$DEST" 2>/dev/null | tr '\n' ' ' || true)"
  if [ -n "${pids// /}" ]; then
    info "5s 内没退干净，SIGKILL：$pids"
    kill -9 $pids 2>/dev/null || true
    sleep 0.5
  fi
  # 兜底：App 拉起的后端可能已 PPID=1 占着端口（已知缺陷 F1，见 docs/roadmap.md），不清掉新的装上去也起不来。
  pids="$(pgrep -f "$DEST" 2>/dev/null | tr '\n' ' ' || true)"
  [ -n "${pids// /}" ] && { kill -9 $pids 2>/dev/null || true; sleep 0.3; }
  info "App 与旧后端都已退出"
}
stop_app

# 后端是**独立进程**（不再是 .app 里的冻结产物）：App 被 SIGKILL 时它的退出钩子不跑，
# 后端会变成 PPID=1 的孤儿继续占着 8790。下一轮 App 启动会「复用」这个旧进程 ——
# 于是「刚更新完后端」看起来完全没生效（实测踩过）。这里只收两种：pid 文件记录的、以及
# 已经是孤儿的；用户前台 `uv run yhub gui`（ppid 是终端）不动。
stop_orphan_backend() {
  local pids pid cmd ppid recorded i
  recorded="$(cat "$BACKEND_PID_FILE" 2>/dev/null || true)"
  pids="$recorded $(pgrep -f 'yhub.*gui.*--port[ =]8790' 2>/dev/null || true)"
  for pid in $pids; do
    kill -0 "$pid" 2>/dev/null || continue
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in *yhub*gui*--port*8790*) ;; *) continue ;; esac
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    if [ "$ppid" != "1" ] && [ "$pid" != "$recorded" ]; then
      info "跳过前台后端 pid=${pid}（ppid=${ppid}，不是本 App 拉起的）"
      continue
    fi
    info "收掉旧后端 pid=${pid}（ppid=${ppid:-?}）"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    i=0
    while [ "$i" -lt 50 ] && kill -0 "$pid" 2>/dev/null; do sleep 0.1; i=$((i+1)); done
    kill -9 -- "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
  done
  rm -f "$BACKEND_PID_FILE"
  # 端口真的安静下来再继续：否则重启的 App 会再次复用旧进程
  i=0
  while [ "$i" -lt 50 ] && curl -sf --noproxy '*' --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; do
    sleep 0.1; i=$((i+1))
  done
  if curl -sf --noproxy '*' --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    info "⚠ 端口 $PORT 仍有服务应答（可能不是 yhub，或需要 sudo 才能收）"
  fi
}
stop_orphan_backend

# ---------------------------------------------------------------- 归档 + 安装

step "5/7 归档旧包 → 安装新包"
ARCHIVED=""
if [ -e "$DEST" ]; then
  mkdir -p "$ARCHIVE_DIR"
  ARCHIVED="$ARCHIVE_DIR/$APP_NAME.app.bak-$(date +%Y%m%d-%H%M%S)"
  mv "$DEST" "$ARCHIVED"
  info "旧包已归档：$ARCHIVED"
else
  info "没有旧包（首次安装）"
fi
# 用 ditto 不用 cp -R：cp 会丢扩展属性/资源分支，签过名的 .app 这样拷容易被判坏。
ditto "$BUNDLE" "$DEST"
info "已安装 → ${DEST}（$(du -sh "$DEST" | awk '{print $1}')）"

# 只留最近几份归档，否则每次 50 MB 无限涨。
# `|| true` 不能省：新 App 名第一次装机时一份归档都没有，`ls` 会以 2 退出，
# 而本脚本是 `set -o pipefail` —— 整条管道会被判失败，脚本在这里静默死掉（实测踩过）。
{ ls -1dt "$ARCHIVE_DIR/$APP_NAME.app.bak-"* 2>/dev/null || true; } \
  | tail -n +$((KEEP_ARCHIVES + 1)) | while read -r old; do
  rm -rf "$old"; info "清掉更早的归档：$(basename "$old")"
done

# ---------------------------------------------------------------- 复核（装的是不是这份构建）

step "6/7 复核装机副本"
FAIL=0
chk() { # chk <描述> <期望> <实际>
  if [ "$2" = "$3" ]; then echo "   PASS  $1"
  else echo "   FAIL  $1（期望 [$2]，实际 [$3]）"; FAIL=1; fi
}

EXE="$DEST/Contents/MacOS/yhub"
[ -x "$EXE" ] && echo "   PASS  可执行文件在 Contents/MacOS/yhub" || { echo "   FAIL  找不到 $EXE"; FAIL=1; }
if codesign --verify --deep --strict "$DEST" >/dev/null 2>&1; then
  echo "   PASS  codesign --verify --deep --strict（壳与资源一起签过名）"
else
  echo "   FAIL  codesign 校验不过 —— 往包里手工加过文件？这会让签名与本地网络授权失效"; FAIL=1
fi
DR="$(codesign -dr - "$DEST" 2>&1 | tr '\n' ' ')"
case "$DR" in
  *'certificate root'*) echo "   PASS  签名身份是稳定证书（不是 ad-hoc cdhash —— 重装不会丢「本地网络」授权）" ;;
  *) echo "   FAIL  签名身份不是稳定证书：$DR"; FAIL=1 ;;
esac
chk "装机副本没有隔离属性（本机自打包不该有 com.apple.quarantine）" 0 \
  "$(xattr "$DEST" 2>/dev/null | grep -c quarantine || true)"
chk "包里没有 Python 运行时（后端由已安装的 yhub 提供）" no \
  "$([ -e "$DEST/Contents/Resources/backend" ] && echo yes || echo no)"
chk "第三方声明在包里（分发义务）" yes \
  "$([ -f "$DEST/Contents/Resources/THIRD-PARTY.md" ] && echo yes || echo no)"
chk "MIT LICENSE 在包里（许可义务）" yes \
  "$([ -f "$DEST/Contents/Resources/LICENSE" ] && echo yes || echo no)"
chk "Info.plist 带 LSUIElement（Dock / Cmd+Tab 不出现）" true \
  "$(/usr/libexec/PlistBuddy -c 'Print LSUIElement' "$DEST/Contents/Info.plist" 2>/dev/null || echo '')"

# 前端 = 本次 web/dist（壳在编译期嵌入 dist，页面自己的资源名对得上才算装的是新界面）
DIST_JS="$(ls -1 "$REPO_ROOT/web/dist/assets"/*.js 2>/dev/null | head -1 || true)"

# ---------------------------------------------------------------- 记录 + 重启

step "7/7 记录「装的是哪次构建」"
mkdir -p "$REPO_ROOT/build"
YHUB_BIN_PATH="$(command -v yhub 2>/dev/null || true)"
YHUB_BIN_VERSION="$([ -n "$YHUB_BIN_PATH" ] && "$YHUB_BIN_PATH" --version 2>/dev/null || true)"
python3 - "$STATE" "$DEST" "$BUNDLE" "$HEAD_SHA" "$DIRTY" "$FINGERPRINT" "$FAIL" \
  "$(shasum_of "$EXE")" "${YHUB_BIN_PATH:-}" "${YHUB_BIN_VERSION:-}" "$BACKEND_OK" \
  "${ARCHIVED:-}" "$(date '+%F %T')" "${DIST_JS:-}" <<'PY'
import json, os, sys
(state, dest, bundle, commit, dirty, fp, failed, shell_sha, backend_path, backend_version,
 backend_ok, archived, when, dist_js) = sys.argv[1:15]
def tree_bytes(p):
    total = 0
    for root, _dirs, files in os.walk(p):
        for f in files:
            try: total += os.path.getsize(os.path.join(root, f))
            except OSError: pass
    return total
out = {
    "installed_at": when,
    "commit": commit,
    "dirty_files": int(dirty),
    "input_fingerprint": fp,
    "app": dest,
    "source_bundle": bundle,
    "app_mb": round(tree_bytes(dest) / 1024 / 1024, 1),
    "shell_sha256": shell_sha,
    "backend_path": backend_path or None,
    "backend_version": backend_version or None,
    "backend_ok": backend_ok == "1",
    "dist_js": os.path.basename(dist_js) if dist_js else None,
    "prev_archive": archived or None,
    "checks_ok": failed == "0",
}
with open(state, "w") as fh:
    json.dump(out, fh, ensure_ascii=False, indent=2); fh.write("\n")
print("   " + json.dumps(out, ensure_ascii=False))
PY

if [ "$FAIL" != 0 ]; then
  step "复核没过：新包已装上去但不合格，建议回滚"
  info "回滚：mv \"${ARCHIVED:-<归档>}\" \"$DEST\""
  exit 1
fi

if [ "$RESTART" = 1 ]; then
  info "拉起新装的 App…"
  # 环境隔离：本脚本常在验收/开发 shell 里被调用，那个 shell 可能还带着 YHUB_CONFIG_DIR 之类的
  # 隔离变量。App 会继承它们，于是装机版后端读的是临时配置根（症状：工具只剩几个、设置页路径
  # 在 /var/folders）。拉起前一律摘掉，App 才会落到 ~/.config/yhub。
  env -u YHUB_CONFIG_DIR -u YHUB_LANG -u YHUB_SETTINGS_FILE -u YHUB_PORT open "$DEST"
  READY=""
  for _ in $(seq 1 150); do
    if curl -sf --noproxy '*' --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then READY=1; break; fi
    sleep 0.2
  done
  if [ -n "$READY" ]; then
    VER="$(curl -s --noproxy '*' --max-time 3 "http://127.0.0.1:$PORT/api/health" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version") or "?")' 2>/dev/null || echo '?')"
    TOOLS="$(curl -s --noproxy '*' --max-time 3 "http://127.0.0.1:$PORT/api/tools" \
      | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("tools") or []))' 2>/dev/null || echo '?')"
    info "后端已就绪：http://127.0.0.1:$PORT/api/health version=${VER}，工具 ${TOOLS} 个"
  else
    info "30s 内没等到 /api/health —— 看日志：~/.config/yhub/logs/desktop.log 与 backend.log"
    info "（如果 8790 上本来就是你的开发后端，这条探活说明不了 App 的状态）"
  fi
else
  info "按 --no-restart：不自动拉起 App"
fi

step "完成：/Applications/$APP_NAME.app 已是 $HEAD_SHA 这棵树"
[ "$DIRTY" != "0" ] && info "注意：工作区有未提交改动，装的是脏树（别人/明天的你无法用提交号复现这份包）"
exit 0
