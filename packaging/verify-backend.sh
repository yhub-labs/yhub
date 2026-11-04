#!/usr/bin/env bash
#
# 验收 Python 后端：起它、打真实接口、核对「工具没被静默丢掉」，并量启动耗时。
#
#   ./packaging/verify-backend.sh                 # 用源码树（uv run yhub）
#   ./packaging/verify-backend.sh /path/to/yhub   # 用指定 yhub 可执行文件（例如 uv tool 装的）
#   YHUB_BACKEND_CMD="yhub" ./packaging/verify-backend.sh   # 自定义启动命令
#
# 这个脚本是**必须**的：白屏/空工具清单这类故障，进程照常起、/api/health 照常 200，
# 只有 /api/tools 会静默变成空数组、所有适配器路由 404 —— 不主动断言就发现不了。
#
# 端口用随机空闲端口，不会碰开发机上常驻的 8790 后端。
set -euo pipefail
export YHUB_LANG="${YHUB_LANG:-zh-CN}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
REPORT="$REPO_ROOT/build/backend-verify.json"
RUN_LOG="$REPO_ROOT/build/backend-verify-run.log"
PID_FILE="$REPO_ROOT/build/backend-verify.pid"
# 验收用的临时配置根：后端读的 `settings.json` 就是 shell 那份（同一个 YHUB_CONFIG_DIR），
# 这里造一份只属于验收的配置，绝不碰用户真实的 ~/.config/yhub。
VERIFY_CONFIG="$REPO_ROOT/build/verify-config"
# 「库里的胶囊」（capsules_dir 扫目录）验收用的临时目录 + 一个「目录外」文件（symlink 逃逸对照）
VERIFY_APPS="$REPO_ROOT/build/verify-apps"
VERIFY_OUTSIDE="$REPO_ROOT/build/verify-apps-outside"
# Rclone 验收用的临时 rclone 配置 + 两个「假 crypt 远端」：
#   cryptempty → 指向空目录（挂载能成功，用来验真挂/真读/真卸）
#   cryptjunk  → 上游里既有**经 crypt 写进去的加密名字**（验「密码错」），又混着非加密名字
#                （macOS 的 .DS_Store 那类，验「密码对别误判」—— 用户 2026-09-29 踩的就是这个）
#               —— 用它**确定性地**验「密码不对」这条分支，不必知道真密码
#   plaindir   → 普通 local 远端（不需要密码）
VERIFY_RCLONE_CONF="$VERIFY_CONFIG/rclone.conf"
VERIFY_RCLONE_ROOT="$REPO_ROOT/build/verify-rclone"
VERIFY_ENV="$VERIFY_CONFIG/.env"

# 启动命令：显式参数 > YHUB_BACKEND_CMD > 源码树的 `uv run yhub`。
# 注意这里是数组，`yhub gui ...` 与 `uv run yhub gui ...` 都能用。
if [ $# -ge 1 ]; then
  BACKEND_CMD=("$1")
elif [ -n "${YHUB_BACKEND_CMD:-}" ]; then
  read -r -a BACKEND_CMD <<< "$YHUB_BACKEND_CMD"
else
  BACKEND_CMD=(uv run yhub)
fi

cleanup_all() {
  [ -n "$STARTED_PID" ] && kill "$STARTED_PID" 2>/dev/null || true
  cleanup_rclone_mounts
  return 0
}

# 挂载是**真的**挂着（rclone + fuse-t）：断言中途失败会留下真挂载点，
# 下一轮的 rm -rf 就会撞上 "Resource busy"。所以每轮开头和收尾都强制收干净。
cleanup_rclone_mounts() {
  local point points
  # 脚本是 `set -euo pipefail`：grep 找不到东西时退出码 1，管道就会把脚本带走 —— 所以整条兜住
  # 两条口径：fixture 目录本身，以及挂在 /tmp 里那份（下面专门用**符号链接路径**验一条回归）
  points=$( { mount | grep -F -e "$VERIFY_RCLONE_ROOT" -e "yhub-rclone-" || true; } \
            | awk '{ for (i = 1; i <= NF; i++) if ($i == "on") print $(i+1) }' || true)
  while IFS= read -r point; do
    [ -n "$point" ] || continue
    umount "$point" 2>/dev/null || true
    if command -v diskutil >/dev/null 2>&1; then diskutil unmount force "$point" >/dev/null 2>&1 || true; fi
  done <<< "$points"
  return 0
}
trap cleanup_all EXIT

PY="$REPO_ROOT/build/venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"
[ -n "$PY" ] || { echo "找不到 python3" >&2; exit 1; }

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

# 缺外部依赖（rclone + macFUSE/FUSE-T）而跳过的段落：结尾必须报出来，不能假装全绿
SKIPPED=0
skip_section() { printf '\033[33mSKIP\033[0m %s\n' "$*"; SKIPPED=$((SKIPPED + 1)); }

mkdir -p "$REPO_ROOT/build"

say "后端自检"
command -v "${BACKEND_CMD[0]}" >/dev/null 2>&1 || fail "找不到启动命令 ${BACKEND_CMD[*]}"
"${BACKEND_CMD[@]}" --version >/dev/null 2>&1 || fail "启动命令不可用：${BACKEND_CMD[*]}（先 uv sync 或 uv tool install .）"
echo "命令：${BACKEND_CMD[*]}"
echo "版本：$("${BACKEND_CMD[@]}" --version 2>/dev/null || echo unknown)"

PORT=$("$PY" -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')

# 起后端 → 等 /api/health 200 → 把耗时写进全局 READY_SECONDS。
# 注意：**不能**用 $(...) 捕获本函数，那样 STARTED_PID 会留在子 shell 里，
# 上一轮进程就永远关不掉，第二轮会「0.02s 就绪」（其实在量第一个进程）。
READY_SECONDS=""
STARTED_PID=""
# 默认关掉系统胶囊层（本脚本的胶囊断言用自己造的临时目录，结果才确定）；
# 「内置胶囊层」那一相会把它切空 → 退回仓库/包自带的 capsules。
SYSTEM_CAPS_DIR="/nonexistent"

start_and_wait() {
  local label="$1" pid t0 t1
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "端口 ${PORT} 上已有服务应答（${label}）—— 上一轮进程没清干净" >&2
    return 1
  fi
  : > "$RUN_LOG"
  # 在子 shell 里起进程（不是主 shell 的 job），这样 kill 它时不会往 stderr 喷
  # "Terminated: 15" 这种 job control 噪音；pid 经文件回传。
  # 信息墙会往 <配置根>/dashboard/snapshots.jsonl 落快照：验收跑一次性测试，
  # 换成 build/ 下的临时根，别动用户真实的 ~/.config/yhub（同 scripts/smoke_dashboard.py）。
  ( YHUB_PORT="$PORT" YHUB_DASHBOARD_DIR="$REPO_ROOT/build/verify-dashboard" \
      YHUB_CONFIG_DIR="$VERIFY_CONFIG" YHUB_SYSTEM_CAPSULES_DIR="${SYSTEM_CAPS_DIR}" RCLONE_CONFIG="$VERIFY_RCLONE_CONF" \
      "${BACKEND_CMD[@]}" gui --no-open --port "$PORT" >>"$RUN_LOG" 2>&1 & echo $! > "$PID_FILE" )
  pid="$(cat "$PID_FILE")"
  STARTED_PID="$pid"
  t0=$(date +%s.%N)
  for _ in $(seq 1 200); do
    if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      t1=$(date +%s.%N)
      READY_SECONDS=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.2f", b-a}')
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || { echo "后端进程在就绪前退出（${label}），日志：" >&2; cat "$RUN_LOG" >&2; return 1; }
    sleep 0.1
  done
  echo "等待 /api/health 超时（20s，${label}），日志：" >&2; cat "$RUN_LOG" >&2; return 1
}

stop_backend() {
  [ -n "$STARTED_PID" ] || return 0
  kill "$STARTED_PID" 2>/dev/null || true
  for _ in $(seq 1 50); do kill -0 "$STARTED_PID" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$STARTED_PID" 2>/dev/null || true
  STARTED_PID=""
  # 等端口真的安静下来，否则下一轮量到的是别人
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  echo "端口 ${PORT} 上的后端没停下来" >&2; return 1
}

say "0/5 造临时配置：库里的应用"
rm -rf "$VERIFY_CONFIG" "$VERIFY_APPS" "$VERIFY_OUTSIDE"
mkdir -p "$VERIFY_CONFIG" "$VERIFY_APPS/子目录" "$VERIFY_APPS/看板" "$VERIFY_APPS/拼音" "$VERIFY_OUTSIDE"

# 「库里的应用」：只要文件在目录里就算一个应用（没有导入、没有清单）。
# 顺带放一条 symlink 指到目录外 —— 它**不该**被列出来、也不该被写（列出来等于开后门）。
# 四种布局各造一个 —— 它们对应后端那套「后缀补全 + 目录首页识别」：
#   顶层单文件 panel.html / 目录首页 看板/index.html / 目录名同名文件 拼音/拼音.html / 深一层 子目录/nested.html
# 书签式元数据（title / icon / description）：像浏览器收藏夹那样从 <head> 抠名字和图标。
# panel.html 带全套；看板/index.html 故意什么都不写 —— 该如实给空串，显示层自己回落文件名。
printf '<!doctype html>\n<html><head><title>验收面板</title><meta name="description" content="验收用面板描述"><link rel="icon" href="data:image/png;base64,iVBORw0KGgo="></head><body><h1>面板验收</h1></body></html>\n' > "$VERIFY_APPS/panel.html"
printf '<!doctype html>\n<html><body><h1>目录首页</h1></body></html>\n' > "$VERIFY_APPS/看板/index.html"
printf '<!doctype html>\n<html><body><h1>拼音注音</h1></body></html>\n' > "$VERIFY_APPS/拼音/拼音.html"
printf '<!doctype html>\n<html><body><h1>子目录</h1></body></html>\n' > "$VERIFY_APPS/子目录/nested.html"
printf '<!doctype html>\n<html><body><h1>不该被看到的</h1></body></html>\n' > "$VERIFY_OUTSIDE/secret.html"
ln -sf "$VERIFY_OUTSIDE/secret.html" "$VERIFY_APPS/escape.html"

printf 'YHUB_TOKEN=test-token\n' > "$VERIFY_ENV"
"$PY" - "$VERIFY_CONFIG" "$VERIFY_APPS" <<'PY'
import json, sys
cfg, apps = sys.argv[1], sys.argv[2]
with open(f"{cfg}/settings.json", "w", encoding="utf-8") as fh:
    json.dump({
        "capsules_dir": apps,
    }, fh, ensure_ascii=False, indent=2)
PY
# Rclone 的临时 fixture：两个假 crypt 远端 + 一个普通远端（不碰用户真实的 ~/.config/rclone）
cleanup_rclone_mounts          # 上一轮若在断言中途失败，可能留着真挂载点
rm -rf "$VERIFY_RCLONE_ROOT"
mkdir -p "$VERIFY_RCLONE_ROOT/cryptempty" "$VERIFY_RCLONE_ROOT/cryptjunk" "$VERIFY_RCLONE_ROOT/plain"
printf '普通远端里的一个文件\n' > "$VERIFY_RCLONE_ROOT/plain/readme.txt"
printf '要经 crypt 写进去的内容\n' > "$VERIFY_RCLONE_ROOT/seed.txt"

# cryptjunk 要像用户真实的 crypt 盘：上游里有**经这个 crypt 写进去的加密名字**，根里还混着
# 非加密名字（macOS 的 .DS_Store / 直接拷进去的普通文件名）。
# 先用带密码的临时配置往里写点东西（密码是本脚本的一次性假密码），再把密码从配置里抹掉 ——
# 这两样缺一不可：只有加密名字才能验出「密码错」，只有非加密名字才能验出「密码对也别误判」。
export VERIFY_RCLONE_SEEDED=0
export VERIFY_RCLONE_PASSWORD="dummy-pw-verify-only"
if command -v rclone >/dev/null 2>&1; then
  SEED_CONF="$VERIFY_RCLONE_ROOT/seed.conf"
  OBSCURED=$(uv run python -c 'import sys; sys.path.insert(0, "'"$REPO_ROOT"'"); from yhub.cli.rclone_obscure import obscure; print(obscure(sys.argv[1]))' "$VERIFY_RCLONE_PASSWORD")
  cat > "$SEED_CONF" <<CONF
[cryptjunk]
type = crypt
remote = $VERIFY_RCLONE_ROOT/cryptjunk
password = $OBSCURED
CONF
  if RCLONE_CONFIG="$SEED_CONF" rclone copyto "$VERIFY_RCLONE_ROOT/seed.txt" cryptjunk:docs/f.txt >/dev/null 2>&1; then
    export VERIFY_RCLONE_SEEDED=1
  fi
  rm -f "$SEED_CONF"
fi
# 非加密名字（外来名字）：crypt 对它们一律报 undecryptable，**密码正确时也一样**
printf '这里是明文文件：crypt 远端会把它当成解不开的名字\n' > "$VERIFY_RCLONE_ROOT/cryptjunk/hello.txt"
# 再放一条**符号链接**挂载点，指向 /tmp 下的真实目录（macOS 上 /tmp → /private/tmp）：
# 「记录里存的是 /tmp 形式、挂载表里是 /private/tmp 形式」这种不一致，曾让 probe 误报「没挂着」，
# 所以验收里专门挂一次这种路径。
VERIFY_RCLONE_TMPLINK="$VERIFY_RCLONE_ROOT/mnt-link"
ln -sfn "$(mktemp -d /tmp/yhub-rclone-XXXXXX)" "$VERIFY_RCLONE_TMPLINK"

cat > "$VERIFY_RCLONE_CONF" <<CONF
[cryptempty]
type = crypt
remote = $VERIFY_RCLONE_ROOT/cryptempty
password =

[cryptjunk]
type = crypt
remote = $VERIFY_RCLONE_ROOT/cryptjunk
password =

[plaindir]
type = local
remote = $VERIFY_RCLONE_ROOT/plain
CONF

echo "临时配置：$VERIFY_CONFIG/settings.json"
echo "临时 rclone 配置：${VERIFY_RCLONE_CONF}（cryptempty / cryptjunk（含加密名字+非加密名字）/ plaindir）"
echo "临时应用目录：${VERIFY_APPS}（顶层单文件 + 目录首页 + 目录名同名文件 + 深一层 + 一条 symlink 逃逸对照）"

say "1/5 首次启动（新进程第一次跑）"
start_and_wait cold || { stop_backend || true; fail "首次启动失败"; }
COLD="$READY_SECONDS"
echo "就绪耗时：${COLD}s（端口 ${PORT}）"

say "2/5 接口断言（工具数 + 真实数据）"
export REQ_TIMES="$REPO_ROOT/build/backend-req-times.json"
"$PY" - "$PORT" "$VERIFY_APPS" "$VERIFY_OUTSIDE" "$VERIFY_CONFIG" <<'PY' || { stop_backend; fail "接口断言未通过"; }
import json, os, sys, time, urllib.error, urllib.request

port = int(sys.argv[1])
base = f"http://127.0.0.1:{port}"
capsules_dir = sys.argv[2]
outside_dir = sys.argv[3]
cfg_root = sys.argv[4]
# 内置（= 核心插件）工具清单：随 wheel 分发（dashboard / settings / capsules 是纯能力型，不占工具条目）。
# 核心插件：rclone, rss, scheduler
EXPECTED = ["rclone", "rss", "scheduler"]
request_seconds = {}

def get(path):
    t0 = time.perf_counter()
    with urllib.request.urlopen(base + path, timeout=30) as resp:
        body = resp.read()
        request_seconds[path] = time.perf_counter() - t0
        return resp.status, body

def get_json(path):
    status, body = get(path)
    assert status == 200, f"{path} -> HTTP {status}"
    return json.loads(body)

tools = get_json("/api/tools")["tools"]
ids = [t["id"] for t in tools]
assert len(ids) == len(EXPECTED), f"/api/tools 只有 {len(ids)} 个工具：{ids}（期望 {EXPECTED}）—— 多半是 wheel 里漏了 yhub/server/adapters 或配置根混进了插件"
assert sorted(ids) == EXPECTED, f"工具清单不符：{ids} != {EXPECTED}"
print(f"PASS /api/tools：{len(ids)} 个工具 {ids}")

# 非核心插件的路由不该出现在基线里：隔离配置根一个外置插件都没装。
for path in ("/api/zdic?q=%E4%BD%A0", "/api/gemini/status", "/api/chrome-doctor/report", "/api/memos/config"):
    try:
        get_json(path)
    except urllib.error.HTTPError as exc:
        assert exc.code == 404, f"{path} -> HTTP {exc.code}（应当 404：它是非核心插件提供的路由）"
        print(f"PASS {path.split('?')[0]}：404（非核心插件未装，符合预期）")
    else:
        raise AssertionError(f"{path} 竟然可用 —— 基线里混进了非核心插件")

sched = get_json("/api/scheduler/jobs")
assert sched["ok"] is True and isinstance(sched["jobs"], list), f"/api/scheduler/jobs 信封不对：{list(sched)}"
print(f"PASS /api/scheduler/jobs：核心插件可用 jobs={len(sched['jobs'])}")

# 信息墙（dashboard 适配器）：后端必须带上它的 4 条只读路由与真实取数
wall = get_json("/api/dashboard/cells")
GATE = ("id", "title", "status", "summary", "updated_at", "href",
        "zone", "order", "enabled", "stale_after", "source")
assert wall["ok"] is True, f"/api/dashboard/cells 信封不对：{list(wall)}"
assert wall["cells"], "/api/dashboard/cells 一个格子都没有 —— 适配器或配置没进来"
missing = [c.get("id") for c in wall["cells"] if any(k not in c for k in GATE)]
assert not missing, f"格子缺进屏字段：{missing}"
assert all(c["status"] in ("ok", "warn", "alert") for c in wall["cells"]), "三态枚举越界"
ids = [c["id"] for c in wall["cells"]]
# 宿主通知瓦片恒在（跨插件聚合，不属于任何插件）。
# 非核心插件的格子**不在这里**：隔离配置根一个外置插件都没装。
assert "overview.alerts" in ids, f"宿主通知瓦片没了：{ids}"
assert "rclone.mounts" in ids, f"核心插件 rclone.mounts 没在基线里：{ids}"
for cid in ("tasks.today", "projects.due"):
    assert cid not in ids, f"非核心插件的格子 {cid} 不应在基线里：{ids}"
stray = sorted(i for i in ids if i.startswith(("svc.", "sync.")))
assert not stray, f"基线不该自带 svc.*/sync.*（它们是非核心插件）：{stray}"
print(f"PASS /api/dashboard/cells：{wall['total']} 格（top {wall['count']}），"
      f"11 个进屏字段齐全，含宿主通知瓦片与 rclone.mounts、不含非核心插件产的格子，"
      f"next_refresh_in={wall.get('next_refresh_in')}s")

# 信息墙网页要能被浏览器直接打开：桌面端托盘菜单与面板墙头的「打开信息墙网页」入口
# 打开的就是 http://127.0.0.1:<port>/?view=wall（信息墙独立页），所以产物必须带 web/dist
# （随包分发在 yhub/web/dist）。静态托管只看路径，query 不影响 —— 两条入口 URL 一起断言，
# 将来谁改了入口忘了这里，先在这里红。
status, html = get("/")
assert status == 200, f"/ -> HTTP {status}：后端应当能直接服务信息墙网页（wheel 里缺 yhub/web/dist？）"
low = html.lower()
assert b"<!doctype html" in low, f"/ 返回的不是 HTML 页面：{html[:120]!r}"
assert b'id="root"' in html, f"/ 返回的不是 Y-Hub 前端（缺 #root 挂载点）：{html[:120]!r}"
print(f"PASS /：信息墙网页可从浏览器打开（{len(html)} 字节）")

status, _ = get("/?view=wall")
assert status == 200, f"/?view=wall -> HTTP {status}"
print("PASS /?view=wall：信息墙独立页入口 200")

status, _ = get("/?tool=dashboard")
assert status == 200, f"/?tool=dashboard -> HTTP {status}"
print("PASS /?tool=dashboard：工作台深链 200")

status, _ = get("/settings")
assert status == 200, f"/settings -> HTTP {status}"
status, _ = get("/apps/rclone")
assert status == 200, f"/apps/rclone -> HTTP {status}"
print("PASS /settings & /apps/rclone：SPA 路径路由直达 200")

# 页面在 /capsules/*（人打开），JSON 列表在 /api/capsules（机器读）——两套命名空间刻意分开：
# 这批地址是给浏览器渲染的页面，不是接口。TiddlyWiki 那类单文件应用靠 OPTIONS 探到 DAV 头
# 才认为「服务器收 PUT」（否则退回「下载一份新文件」），靠 HEAD 取 ETag，PUT 认 If-Match。
import urllib.error
from urllib.parse import quote


def call(path, method="GET", data=None, headers=None):
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read(), resp.headers
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), exc.headers


# ---------------------------------------------------------------------------
# 「库里的胶囊」（/api/capsules 列表 + /capsules/* 页面，capsules_dir 扫目录）：文件放进去就出现，
# 不需要导入或清单。重点不是「能读到」，而是**地址规则**与**边界**：
# 后缀自动补全 / 目录首页识别 / 短地址可用；symlink 逃逸不算胶囊；只有 .html/.htm
# 与非点开头的路径可取；跨源写 403、过期 If-Match 412 —— 它写的是库里的文件。
listing = get_json("/api/capsules")
assert listing["ok"] is True, f"列表信封不对：{listing}"
assert listing["max_capsules"] == 200 and listing["max_bytes"] == 32 * 1024 * 1024, \
    f"上限要如实报出：{listing.get('max_capsules')} / {listing.get('max_bytes')}"
assert listing["capsules_dir"] == capsules_dir, f"列表该报出 capsules_dir：{listing.get('capsules_dir')!r}"
rel_paths = sorted(t["relpath"] for t in listing["capsules"])
assert rel_paths == ["panel.html", "子目录/nested.html", "拼音/拼音.html", "看板/index.html"], \
    f"capsules_dir 扫到的清单不对：{rel_paths}"
short = {t["relpath"]: t["url_path"] for t in listing["capsules"]}
assert short == {
    "panel.html": "panel",
    "看板/index.html": "看板/",   # 目录型应用的短地址带尾斜杠（相对 ./data/ 才不漂出文件夹）
    "拼音/拼音.html": "拼音",
    "子目录/nested.html": "子目录/nested",
}, f"短地址规则不对：{short}"
for entry in listing["capsules"]:
    assert entry["url"] == f"{base}/capsules/{quote(entry['url_path'])}", f"胶囊地址不对：{entry['url']}"
print(f"PASS /api/capsules 列表：{len(listing['capsules'])} 个 {rel_paths}；短地址 {list(short.values())}")

# 引导三态 + 一键创建（2026-11）：列表要如实报出用户层状态与推荐位置；
# ensure 负责「建目录 + 写配置」，界面据此做「使用推荐位置 / 创建这个目录」。
for field in ("configured", "problem", "problem_detail", "configured_path", "recommended_dir"):
    assert field in listing, f"/api/capsules 缺引导字段 {field}：{list(listing)}"
assert listing["configured"] is True and listing["problem"] is None, \
    f"配好的临时目录该是正常态：configured={listing['configured']} problem={listing['problem']}"
assert listing["recommended_dir"] == "~/Y-Hub/capsules", f"推荐位置不符：{listing['recommended_dir']!r}"
print(f"PASS 胶囊引导三态：configured=True problem=None recommended={listing['recommended_dir']}")

# 指向一个不存在的路径 → problem=missing；ensure 建好之后 → problem 消失
# （先删干净：上一轮 ensure 建出来的目录会留在 build/ 里，不删就不是「不存在」了）
import shutil
_absent_dir = os.path.join(os.path.dirname(capsules_dir), "absent-capsules")
shutil.rmtree(_absent_dir, ignore_errors=True)
put_body = json.dumps({"key": "capsules_dir", "value": _absent_dir}).encode()
status, body, _headers = call("/api/settings", method="PUT", data=put_body, headers={"Content-Type": "application/json"})
assert status == 200, f"PUT /api/settings -> HTTP {status}"
absent = get_json("/api/capsules")
assert absent["problem"] == "missing" and absent["configured"] is False, \
    f"不存在的目录该报 missing：{absent.get('problem')!r}"
ensure_body = json.dumps({"path": absent["configured_path"]}).encode()
status, body, _headers = call("/api/capsules/ensure", method="POST", data=ensure_body, headers={"Content-Type": "application/json"})
assert status == 200, f"POST /api/capsules/ensure -> HTTP {status} {body[:120]!r}"
fixed = get_json("/api/capsules")
assert fixed["problem"] is None and fixed["configured"] is True, \
    f"ensure 之后该恢复正常：{fixed.get('problem')!r}"
print("PASS /api/capsules/ensure：missing → 一键创建 → 正常（写配置同一入口）")
# 还原成验收用的胶囊目录（后面的文件/沙盒断言都按这个目录跑）
restore = json.dumps({"key": "capsules_dir", "value": capsules_dir}).encode()
status, body, _headers = call("/api/settings", method="PUT", data=restore, headers={"Content-Type": "application/json"})
assert status == 200, f"还原 capsules_dir -> HTTP {status}"
assert get_json("/api/capsules")["problem"] is None, "还原后该恢复正常态"
shutil.rmtree(_absent_dir, ignore_errors=True)  # 不留脏目录给下一轮

# ---- 书签式三件套：有就给真的，没有就给空串（绝不编、绝不回落成文件名——回落是显示层的事）
by_rel = {t["relpath"]: t for t in listing["capsules"]}
panel = by_rel["panel.html"]
assert panel.get("title") == "验收面板", f"书签名该取 <title>：{panel.get('title')!r}"
assert str(panel.get("description", "")).startswith("验收用"), f"描述该取 meta description：{panel.get('description')!r}"
assert str(panel.get("icon", "")).startswith("data:image/png"), \
    f"图标该是内联 data: 串：{str(panel.get('icon'))[:40]!r}"
bare = by_rel["看板/index.html"]
assert bare.get("title") == "" and bare.get("icon") == "" and bare.get("description") == "", \
    f"没写的字段该是空串（显示层自己回落文件名）：title={bare.get('title')!r} icon={bare.get('icon')!r}"
print("PASS /api/capsules 书签式三件套：title/description/icon 真的给真的、缺的给空串")

# ---- 地址解析：后缀补全 / 目录首页 / 目录名同名文件 / 显式路径 ----
status, body, headers = call("/capsules/panel")
assert status == 200 and "面板验收" in body.decode("utf-8"), f"/capsules/panel 该补成 panel.html：HTTP {status}"
assert "text/html" in headers.get("Content-Type", ""), f"Content-Type 不对：{headers.get('Content-Type')!r}"
assert headers.get("Cache-Control") == "no-store", "页面必须自己发 no-store（/capsules 不在 /api 前缀里）"
assert "unsafe-eval" in headers.get("Content-Security-Policy", ""), \
    "页面 CSP 必须放开 'unsafe-eval'：否则 TiddlyWiki 这类用 eval 起内核的应用会半死"
csp_script = headers.get("Content-Security-Policy", "").split("script-src")[1].split(";")[0] \
    if "script-src" in headers.get("Content-Security-Policy", "") else ""
assert "https:" in csp_script, \
    f"script-src 必须带 https:（托管页等价 file://，CDN 脚本（如 marked）要能加载）：{csp_script!r}"
app_etag = headers.get("ETag")
assert app_etag, "GET 胶囊必须给 ETag（单文件应用靠它做冲突检测）"

# ---- 胶囊隔离：浏览器请求只能访问自己的文件夹（服务端 Referer 校验 + CSP 收口）----
# 自测口径：有 Sec-Fetch-* 才算浏览器；curl/脚本（本脚本）不带这些头，仍可运维读写。
def browser_headers(referer=None, mode="cors", site="same-origin", dest=None):
    h = {"Sec-Fetch-Site": site, "Sec-Fetch-Mode": mode}
    if dest:
        h["Sec-Fetch-Dest"] = dest
    if referer:
        # Referer 是 HTTP 头：非 ASCII 必须百分号编码（浏览器也这么做）
        h["Referer"] = base + quote(referer, safe="/")
    return h

status, _, _ = call("/capsules/panel.html", headers=browser_headers("/capsules/panel"))
assert status == 200, f"胶囊读自己应当 200，实际 {status}"
status, _, _ = call("/capsules/" + quote("看板") + "/index.html",
                    headers=browser_headers("/capsules/panel"))
assert status == 403, f"胶囊读别人的入口应当 403，实际 {status}"
status, _, _ = call("/capsules/panel.html", headers=browser_headers())
assert status == 403, f"没有 Referer 的同源 fetch 应当 403（防 no-referrer 绕过），实际 {status}"
status, _, _ = call("/capsules/panel.html", headers=browser_headers(mode="navigate", site="none"))
assert status == 200, f"地址栏打开胶囊应当放行，实际 {status}"
# 启动器用 window.open(url, '_blank', 'noopener,noreferrer') 开胶囊：没有 Referer，但 Chrome 仍按发起方
# 算出 sec-fetch-site: same-origin（它不看 Referer 头）。这是**用户点开胶囊**的主路径，必须放行。
status, _, _ = call("/capsules/panel.html",
                    headers=browser_headers(mode="navigate", site="same-origin", dest="document"))
assert status == 200, f"启动器无 Referer 地打开胶囊（same-origin 导航）应当放行，实际 {status}"
# 主界面 / 设置页的普通链接：Referer 存在但不在 /capsules/ 下 → 正常导航，放行
status, _, _ = call("/capsules/panel.html",
                    headers={**browser_headers(mode="navigate", site="same-origin", dest="document"),
                             "Referer": base + "/"})
assert status == 200, f"从主界面打开胶囊应当放行，实际 {status}"
# 无 Referer 的 iframe 导航（referrerPolicy=no-referrer）必须仍然 403：父页面能读它的 DOM
status, _, _ = call("/capsules/panel.html",
                    headers=browser_headers(mode="navigate", site="same-origin", dest="iframe"))
assert status == 403, f"无 Referer 的 iframe 导航应当 403（否则可绕开隔离读 DOM），实际 {status}"
status, _, _ = call("/api/capsules", headers=browser_headers("/capsules/panel"))
assert status == 403, f"胶囊调宿主 /api 应当 403，实际 {status}"
status, _, _ = call("/api/capsules", headers={"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors"})
assert status == 403, f"没有 Referer 的同源浏览器请求也不能调 /api（Service Worker 绕过），实际 {status}"
status, _, _ = call("/capsules/" + quote("看板/data/isolation.json"), method="PUT", data=b"x",
                    headers={**browser_headers("/capsules/panel"), "Content-Type": "application/json"})
assert status == 403, f"胶囊写别人文件夹应当 403，实际 {status}"
status, _, _ = call("/capsules/" + quote("看板/data/isolation.json"), method="PUT", data=b"x",
                    headers={**browser_headers("/capsules/看板/"), "Content-Type": "application/json"})
assert status == 204, f"胶囊写自己文件夹应当 204，实际 {status}"
csp_own = headers.get("Content-Security-Policy", "")
assert "/capsules/panel" in csp_own and "default-src 'none'" in csp_own, \
    f"CSP 该收口到胶囊自己的 URL 前缀：{csp_own!r}"
assert "connect-src 'self'" not in csp_own, f"CSP 不该再给整个 'self'：{csp_own!r}"
# 沙盒里写出来的 .html 也是「页面」：必须同样套页面 CSP，否则 iframe 过去就绕开隔离
status, _, _ = call("/capsules/" + quote("看板/data/page.html"), method="PUT",
                    data=b"<!doctype html><p>x</p>",
                    headers={**browser_headers("/capsules/看板/"), "Content-Type": "text/html"})
assert status == 204, f"写沙盒 HTML 失败：HTTP {status}"
status, _, page_headers = call("/capsules/" + quote("看板/data/page.html"),
                              headers=browser_headers("/capsules/看板/"))
assert status == 200, f"读沙盒 HTML 失败：HTTP {status}"
csp_page = page_headers.get("Content-Security-Policy", "")
assert "/capsules/" + quote("看板") in csp_page and "default-src 'none'" in csp_page, \
    f"沙盒 HTML 也要有按胶囊收口的 CSP：{csp_page!r}"
print("PASS 胶囊隔离：自己的文件夹可读写、别人的 403、无 Referer 的 fetch/iframe 403、启动器与地址栏打开放行、宿主 /api 403、CSP 只放本胶囊")

# ---- 子域开关（配置默认关闭；开启后胶囊走 <slug>.localhost，Host 即身份）----
call("/api/settings", method="PUT", data=json.dumps({"key": "capsules_subdomains", "value": True}).encode(),
     headers={"Content-Type": "application/json"})
try:
    sub = get_json("/api/capsules")
    assert sub.get("capsules_subdomains") is True, f"开关没生效：{sub.get('capsules_subdomains')}"
    panel_item = next(c for c in sub["capsules"] if c["relpath"] == "panel.html")
    assert ".localhost:" in panel_item["url"], f"开启后 url 该是子域：{panel_item['url']}"
    from urllib.parse import urlsplit
    sub_host = urlsplit(panel_item["url"]).netloc
    status, _, _ = call("/api/capsules", headers={"Host": sub_host})
    assert status == 403, f"胶囊子域不能调宿主 /api：{status}"
    status, _, _ = call("/capsules/panel.html", headers={"Host": sub_host})
    assert status == 200, f"胶囊子域访问自己该 200：{status}"
    status, _, _ = call("/capsules/panel.html")
    assert status == 200, f"主地址仍有 302 → 跟随到自己的子域后应为 200：{status}"
finally:
    call("/api/settings", method="PUT", data=json.dumps({"key": "capsules_subdomains", "value": False}).encode(),
         headers={"Content-Type": "application/json"})
print("PASS 胶囊子域开关：URL 用 <slug>.localhost、子域禁 /api、子域只能读自己、主地址 302")

# ---- 逐胶囊覆盖：全局关，只让 panel.html 走子域 ----
call("/api/settings", method="PUT",
     data=json.dumps({"key": "capsules_subdomains_overrides", "value": {"panel.html": True}}).encode(),
     headers={"Content-Type": "application/json"})
try:
    mixed = get_json("/api/capsules")
    panel_mixed = next(c for c in mixed["capsules"] if c["relpath"] == "panel.html")
    board_mixed = next(c for c in mixed["capsules"] if c["relpath"] == "看板/index.html")
    assert panel_mixed["subdomains"] is True and ".localhost:" in panel_mixed["url"], panel_mixed
    assert board_mixed["subdomains"] is False and "127.0.0.1" in board_mixed["url"], board_mixed
    panel_host = urlsplit(panel_mixed["url"]).netloc
    status, _, _ = call("/capsules/panel.html", headers={"Host": panel_host})
    assert status == 200, f"独立胶囊在子域该 200：{status}"
    status, _, _ = call("/capsules/" + quote("看板") + "/index.html", headers={"Host": panel_host})
    assert status == 403, f"同源胶囊不能被独立胶囊的子域读到：{status}"
    print("PASS 逐胶囊 origin：只让 panel.html 走子域，其余留在 127.0.0.1，跨胶囊仍 403")
finally:
    call("/api/settings", method="PUT",
         data=json.dumps({"key": "capsules_subdomains_overrides", "value": {}}).encode(),
         headers={"Content-Type": "application/json"})
status, body, _ = call("/capsules/" + quote("看板"))
assert status == 200 and "目录首页" in body.decode("utf-8"), f"/capsules/看板 该命中 看板/index.html：HTTP {status}"
status, body, _ = call("/capsules/" + quote("拼音"))
assert status == 200 and "拼音注音" in body.decode("utf-8"), f"/capsules/拼音 该命中 拼音/拼音.html：HTTP {status}"
status, body, _ = call("/capsules/panel.html")
assert status == 200 and "面板验收" in body.decode("utf-8"), f"显式路径永远有效：HTTP {status}"
status, body, _ = call("/capsules/" + quote("子目录/nested"))
assert status == 200 and "子目录" in body.decode("utf-8"), f"深一层的短地址要能用：HTTP {status}"
status, _, _ = call("/capsules/panel/")
assert status == 404, f"带斜杠 = 只认该目录的 index.html，panel/ 里没有：HTTP {status}"
print("PASS /capsules/<路径>：后缀补全 / 目录首页 / 目录名同名文件 / 显式路径 / 深一层都对")

status, _, headers = call("/capsules/panel.html", method="OPTIONS")
assert status == 200 and headers.get("DAV"), f"OPTIONS 必须 200 + DAV 头：HTTP {status}"
status, _, headers = call("/capsules/panel.html", method="HEAD")
assert status == 200 and headers.get("ETag"), f"HEAD 必须给 ETag：HTTP {status}"

new_app = b'<!doctype html>\n<html><body><h1>\xe9\x9d\xa2\xe6\x9d\xbf\xe9\xaa\x8c\xe6\x94\xb6 v2</h1></body></html>\n'
status, _, headers = call("/capsules/panel", method="PUT", data=new_app,
                          headers={"If-Match": app_etag, "Content-Type": "text/html;charset=UTF-8"})
assert status == 204, f"PUT 胶囊失败：HTTP {status}"
with open(os.path.join(capsules_dir, "panel.html"), "rb") as fh:
    assert fh.read() == new_app, "PUT 之后库里的文件内容不对"
status, _, _ = call("/capsules/panel.html", method="PUT", data=b"x", headers={"If-Match": app_etag})
assert status == 412, f"过期 If-Match 应当 412，实际 HTTP {status}"
status, _, _ = call("/capsules/panel.html", method="PUT", data=b"x", headers={"Origin": "https://evil.example"})
assert status == 403, f"跨源 PUT 胶囊应当 403，实际 HTTP {status}"
status, _, _ = call("/capsules/panel.html", method="PUT", data=b"a" * (32 * 1024 * 1024 + 1))
assert status == 413, f"超过 32 MiB 应当 413，实际 HTTP {status}"
with open(os.path.join(capsules_dir, "panel.html"), "rb") as fh:
    assert fh.read() == new_app, "被拒的超大 PUT 不该动文件"
print("PASS PUT /capsules：短地址与显式地址同一文件（204 磁盘已变）/ 过期 412 / 跨源 403 / 超限 413")

# 边界：symlink 指到目录外、点开头的路径、非 .html 后缀 —— 一律取不到，更写不进
status, _, _ = call("/capsules/escape.html")
assert status == 404, f"symlink 逃逸应当 404，实际 HTTP {status}"
with open(os.path.join(outside_dir, "secret.html"), "r", encoding="utf-8") as fh:
    assert "不该被看到的" in fh.read(), "目录外的文件被改动了"
status, _, _ = call("/capsules/escape.html", method="PUT", data=b"x")
assert status == 404, f"往 symlink 逃逸写应当 404，实际 HTTP {status}"
status, _, _ = call("/capsules/.git/config.html")
assert status == 404, f"点开头的路径应当 404（防 .git 之类被端出去），实际 HTTP {status}"
status, _, _ = call("/capsules/nope.txt")
assert status == 404, f"非 .html/.htm 不该被托管，实际 HTTP {status}"
status, _, _ = call("/capsules/../verify-apps-outside/secret.html")
assert status in (400, 403, 404), f"用 .. 穿越应当被拒，实际 HTTP {status}"
status, _, _ = call("/capsules/panel/../../verify-apps-outside/secret.html")
assert status in (400, 403, 404), f"带 .. 的地址一律拒：HTTP {status}"
print("PASS /capsules 边界：symlink 逃逸 404（库外未动）/ 点开头 404 / 非 html 404 / .. 被拒")

# ---- 胶囊沙盒：给每个小应用一个文件夹，它在自己文件夹里建/读/删数据文件 ----
# 多文件应用（如 data/chat/*.json）的数据层。判定：解析不到入口的路径落在
# **第一个含入口 html 的目录**内；顶层散文件应用没有沙盒；入口 html 本身仍不可新建/删除。
payload = json.dumps({"hello": "沙盒"}, ensure_ascii=False).encode("utf-8")
status, _, headers = call("/capsules/" + quote("看板/data/index.json"), method="PUT", data=payload,
                          headers={"Content-Type": "application/json"})
assert status == 204, f"沙盒 PUT 新建失败：HTTP {status}"
assert headers.get("ETag"), "沙盒 PUT 该回 ETag"
status, _, _ = call("/capsules/" + quote("看板/data/chat/new1.json"), method="PUT", data=b'{"n":1}',
                    headers={"Content-Type": "application/json"})
assert status == 204, f"沙盒 PUT 自动建父目录失败（多文件胶囊合同要求预建 data/chat/，我们该建得更快）：HTTP {status}"
status, body, headers = call("/capsules/" + quote("看板/data/index.json"))
assert status == 200 and body == payload, f"沙盒 GET 读回不对：HTTP {status} {body[:80]!r}"
assert "application/json" in headers.get("Content-Type", ""), \
    f"沙盒文件该按后缀给类型：{headers.get('Content-Type')!r}"
assert headers.get("Cache-Control") == "no-store" and headers.get("ETag"), "沙盒 GET 该带 no-store + ETag"
assert not headers.get("Content-Security-Policy"), "沙盒数据文件不是页面，不该带页面 CSP"
status, _, _ = call("/capsules/" + quote("看板/data/index.json"), method="PUT", data=b"x",
                    headers={"If-Match": '"stale"'})
assert status == 412, f"沙盒过期 If-Match 该 412：HTTP {status}"
status, _, _ = call("/capsules/" + quote("看板/data/x.json"), method="PUT", data=b"x",
                    headers={"Origin": "https://evil.example"})
assert status == 403, f"跨源写沙盒该 403：HTTP {status}"
# 沙盒内点开头放行（.appdata 这类隐藏目录归应用自己管），顶层点开头仍拒
status, _, _ = call("/capsules/" + quote("看板/.appdata/index.json"), method="PUT", data=b"{}",
                    headers={"Content-Type": "application/json"})
assert status == 204, f"沙盒内点开头目录该放行（用户选的 B 方案）：HTTP {status}"
status, _, _ = call("/capsules/" + quote(".appdata/x.json"), method="PUT", data=b"x")
assert status == 404, f"顶层点开头仍该拒：HTTP {status}"
status, _, _ = call("/capsules/" + quote("看板/data/../../../verify-apps-outside/x.json"), method="PUT", data=b"x")
assert status in (400, 403, 404), f"带 .. 的沙盒路径一律拒：HTTP {status}"
status, _, _ = call("/capsules/panel/data/x.json", method="PUT", data=b"x")
assert status == 404, f"顶层散文件应用没有沙盒（它的目录就是 apps 根）：HTTP {status}"
status, _, _ = call("/capsules/panel", method="DELETE")
assert status == 405, f"应用本体不可 DELETE：HTTP {status}"
status, _, _ = call("/capsules/" + quote("看板/data/chat/new1.json"), method="DELETE")
assert status == 204, f"沙盒 DELETE 失败：HTTP {status}"
status, _, _ = call("/capsules/" + quote("看板/data/chat/new1.json"))
assert status == 404, f"删掉的沙盒文件还在：HTTP {status}"
still = sorted(t["relpath"] for t in get_json("/api/capsules")["capsules"])
assert "看板/data/index.json" not in still and "看板/index.html" in still, \
    f"沙盒数据不该进胶囊列表（列表 = 胶囊，不是数据）：{still}"
print("PASS 胶囊沙盒：新建+自动建父目录 / 读回无 CSP / 412 / 403 / 顶层点段拒·盒内点段放行 / .. 拒 / 散文件无沙盒 / 本体不可删 / 数据不进列表")

# 文件放进去就出现、删掉就消失（这套机制的全部好处就在这一条上）
fresh = os.path.join(capsules_dir, "子目录", "fresh.html")
with open(fresh, "w", encoding="utf-8") as fh:
    fh.write("<!doctype html><html><body>fresh</body></html>")
got = sorted(t["relpath"] for t in get_json("/api/capsules")["capsules"])
assert "子目录/fresh.html" in got, f"新放进目录的文件没自动出现：{got}"
os.unlink(fresh)
got = sorted(t["relpath"] for t in get_json("/api/capsules")["capsules"])
assert "子目录/fresh.html" not in got, f"删掉的文件还留在列表里：{got}"
print("PASS 生命周期：放进去就出现、删掉就消失（无导入、无清单）")

# ---------------------------------------------------------------------------
# 配置读写（/api/settings）：写入口不再只有桌面壳 —— CLI 与网页端共用同一套语义与校验。
# 这里刻意验「被拒时一个字都不落盘」：半截配置比没改更糟，是这套接口最容易写坏的地方。
cfg_file = os.path.join(cfg_root, "settings.json")
view = get_json("/api/settings")
assert view["path"] == cfg_file, f"该报出配置文件路径：{view['path']!r} != {cfg_file!r}"
assert view["settings"]["capsules_dir"] == capsules_dir, f"读回的 capsules_dir 不对：{view['settings']['capsules_dir']!r}"
assert "capsules_dir" in view["schema"]["keys"], "schema 该带上 capsules_dir（界面不硬编码键名）"
with open(cfg_file, "rb") as fh:
    before = fh.read()

status, err, _ = call("/api/settings", method="PUT",
                      data=json.dumps({"key": "capsules_dir", "value": "相对路径"}).encode(),
                      headers={"Content-Type": "application/json"})
assert status == 400 and "绝对路径" in err.decode("utf-8"), f"相对路径该被拒：HTTP {status} {err[:120]!r}"
with open(cfg_file, "rb") as fh:
    assert fh.read() == before, "被拒的写入不该动配置文件（不留半截）"
status, err, _ = call("/api/settings", method="PUT",
                      data=json.dumps({"key": "hotkeys.show_panel", "value": "Option+Space"}).encode(),
                      headers={"Content-Type": "application/json"})
assert status == 400 and "已经绑定给" in err.decode("utf-8"), f"热键撞车该被拒：HTTP {status} {err[:120]!r}"
status, err, _ = call("/api/settings", method="PUT",
                      data=json.dumps({"key": "nope", "value": 1}).encode(),
                      headers={"Content-Type": "application/json"})
assert status == 400 and "capsules_dir" in err.decode("utf-8"), f"未知键该被拒并列出可用路径：{err[:160]!r}"
print("PASS /api/settings 校验：相对路径 / 热键撞车 / 未知键都 400，且配置一字未动")

status, ok, _ = call("/api/settings", method="PUT",
                     data=json.dumps({"key": "tray.show_notifications", "value": True}).encode(),
                     headers={"Content-Type": "application/json"})
assert status == 200, f"合法写入该成功：HTTP {status} {ok[:120]!r}"
with open(cfg_file, encoding="utf-8") as fh:
    on_disk = json.load(fh)
assert on_disk["tray"]["show_notifications"] is True, f"值没落到文件里：{on_disk.get('tray')}"
assert on_disk["capsules_dir"] == capsules_dir, "改一项不该把别的键碰掉"
status, ok, _ = call("/api/settings", method="PUT",
                     data=json.dumps({"key": "tray.show_notifications", "value": None}).encode(),
                     headers={"Content-Type": "application/json"})
assert status == 200 and json.loads(ok)["settings"]["tray"]["show_notifications"] is False, \
    f"null 该恢复默认：{ok[:120]!r}"
print("PASS /api/settings 写入：落盘 + 只动目标键；null = 恢复默认")

# ---- 本机写接口的 Host / Origin 闸门（挡 DNS rebinding 与跨源表单写）----
status, _, _ = call("/api/health", headers={"Host": "evil.example"})
assert status == 400, f"非本机 Host 应当 400（DNS rebinding），实际 {status}"
status, _, _ = call("/api/settings", method="PUT", data=b'{"key":"tray.show_notifications","value":false}',
                    headers={"Origin": "https://evil.example", "Content-Type": "application/json"})
assert status == 403, f"跨源写 /api/settings 应当 403，实际 {status}"
print("PASS 写接口闸门：非本机 Host 400、跨源 Origin 403")

print("请求耗时（秒）：" + json.dumps({k: round(v, 3) for k, v in request_seconds.items()}, ensure_ascii=False))
with open(os.environ["REQ_TIMES"], "w") as fh:
    json.dump({k: round(v, 3) for k, v in request_seconds.items()}, fh, indent=2)
PY

say "2.5/5 MCP 面清单（声明层，源码全量）"
# 配置根钉死成验收用的临时目录：用户机器上装了外置插件（~/.config/yhub/plugins/）时，
# 这条「内置 7 个 MCP 工具」的源码层断言也不该被外置清单污染（见 docs/plugins.md）。
YHUB_CONFIG_DIR="$VERIFY_CONFIG" uv run python - <<'PY' || { echo "FAIL MCP 面清单变了（要改文档：AGENTS.md + api-contract.md）"; exit 1; }
from yhub.server.adapters import discover_adapters
names = sorted(
    t["name"]
    for e in discover_adapters()
    for t in (e["meta"].get("faces") or {}).get("mcp", [])
)
expected = [
    "rclone_probe", "rclone_status", "rclone_umount",
    "rss_add", "rss_items", "rss_list", "rss_remove",
]
assert names == expected, f"MCP 面清单变了：{names}"
print(f"PASS MCP 面 {len(names)} 个（与 AGENTS.md/verify-cli.mjs 声明一致）")
PY

say "2.7/5 cells 产地注册表（声明层，源码全量）"
# 中心只做「注册表 + 聚合」：除宿主通知瓦片外，每个格子的产地都必须是某个插件的
# presentation.tiles，且每个产地都自带可调用的 fetch（没 fetch = 没人取数）。
# 配置根同样钉死成验收临时目录，外置插件不参与这条「内置产地」断言。
YHUB_CONFIG_DIR="$VERIFY_CONFIG" uv run python - <<'PY' || { echo "FAIL cells 产地注册表变了（中心零产地）"; exit 1; }
from yhub.server.adapters import plugin_tiles
from yhub.server.adapters._dashboard_sources import OVERVIEW_ID, resolve_specs

specs = resolve_specs()
ids = [s["id"] for s in specs]
tile_ids = sorted(t["id"] for _pid, t in plugin_tiles())
centric = sorted(i for i in ids if i != OVERVIEW_ID)
assert centric == tile_ids, (
    f"中心清单与插件 tiles 对不上：只在中心={sorted(set(centric) - set(tile_ids))} "
    f"只在插件={sorted(set(tile_ids) - set(centric))}")
missing_fetch = [s["id"] for s in specs if s["id"] != OVERVIEW_ID and not callable(s.get("fetch"))]
assert not missing_fetch, f"这些格子没有产地 fetch：{missing_fetch}"
host = next(s for s in specs if s["id"] == OVERVIEW_ID)
assert host["source"] == "derived" and host["group"] is None, f"宿主通知瓦片形状不对：{host}"
# 非核心插件的格子不该出现在基线里（svc.* / sync.* 两个插件已移除，这条留作护栏）
stray_tiles = sorted(t for t in tile_ids if t.startswith(("svc.", "sync.")))
assert not stray_tiles, f"基线声明了非核心插件的格子：{stray_tiles}"
print(f"PASS cells 注册表：{len(ids)} 格 = 宿主 1 + 插件 {len(tile_ids)}，中心零产地、产地都带 fetch")
PY

# 真挂/真读/真卸要 rclone + macFUSE/FUSE-T：没有就整段跳过（假 rclone 的密码卫生段落照跑）。
# 装机版上的同一组断言由 `make verify-app` 覆盖。
if command -v rclone >/dev/null 2>&1; then
say "3/5 Rclone：远端清单 + 错误路径 + 真挂/真读/真卸（临时假远端，不碰真实配置）"
"$PY" - "$PORT" "$VERIFY_RCLONE_CONF" "$VERIFY_CONFIG" "$VERIFY_RCLONE_ROOT" <<'PY' || { stop_backend; fail "rclone 断言未通过"; }
import json, os, subprocess, sys, urllib.error, urllib.request

port, conf, cfg_root, root = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
base = f"http://127.0.0.1:{port}"
SECRET = os.environ.get("VERIFY_RCLONE_PASSWORD", "dummy-pw-verify-only")
WRONG = SECRET + "-wrong"
SEEDED = os.environ.get("VERIFY_RCLONE_SEEDED", "0") == "1"
mountpoint = os.path.join(root, "mnt")


def call(path, body=None, timeout=180):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        base + path,
        data=data,
        method="POST" if data is not None else "GET",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


status, body = call("/api/lv")
assert status == 404, f"/api/lv 还在（LV 旧工具没下线）：HTTP {status} {body}"
print("PASS LV 内存盘已下线：/api/lv -> 404")

status, view = call("/api/rclone")
assert status == 200, f"/api/rclone -> HTTP {status} {view}"
assert view["rclone"]["config"] == conf, f"后端读的不是临时 rclone 配置：{view['rclone']['config']}"
remotes = {row["name"]: row for row in view["remotes"]}
assert set(remotes) == {"cryptempty", "cryptjunk", "plaindir"}, f"远端清单不符：{sorted(remotes)}"
assert remotes["cryptempty"]["encrypted"] and remotes["cryptempty"]["needs_password"], "crypt 远端该报「加密 + 需要密码」"
assert not remotes["plaindir"]["encrypted"] and not remotes["plaindir"]["needs_password"], "local 远端不该要密码"
assert view["mounts"] == [], f"验收开始时不该有挂载：{view['mounts']}"
assert SECRET not in json.dumps(view, ensure_ascii=False), "状态响应里出现了密码"
print(f"PASS /api/rclone：{len(remotes)} 个远端（crypt 要密码 / local 不要），挂载 0 条")

status, body = call("/api/rclone/mount", {"name": "nope"})
assert status == 400 and "没有这个远端" in body.get("error", ""), f"未知远端：{status} {body}"
status, body = call("/api/rclone/mount", {"name": "cryptempty"})
assert status == 400 and "需要密码" in body.get("error", ""), f"缺密码：{status} {body}"
status, body = call("/api/rclone/probe", {"name": "plaindir"})
assert status == 400 and ("挂载记录" in body.get("error", "") or "没挂着" in body.get("error", "")), \
    f"探测未挂载的：{status} {body}"
# 「更多参数」的闸门：密码一律不许从这里进 argv；位置参数不许顶掉远端/挂载点
status, body = call("/api/rclone/mount", {"name": "plaindir", "extra": "--password hunter2"})
assert status == 400 and "--password" in body.get("error", ""), f"密码经更多参数透传没被拦：{status} {body}"
status, body = call("/api/rclone/mount", {"name": "plaindir", "extra": "junk-positional"})
assert status == 400 and "只能加参数" in body.get("error", ""), f"位置参数没被拦：{status} {body}"
status, body = call("/api/rclone/mount", {"name": "plaindir", "extra": "--dir-cache-time '10s"})
assert status == 400 and "切不开" in body.get("error", ""), f"引号没配平没被拦：{status} {body}"
status, view = call("/api/rclone")
assert view.get("vfs_cache_mode") == "writes" and "cache_modes" not in view, \
    f"缓存模式应当是常设的 writes（不再是一张可选列表）：{view.get('vfs_cache_mode')} / cache_modes={view.get('cache_modes')}"
print("PASS rclone 错误路径：未知远端 / 缺密码 / 探测未挂载 / 更多参数闸门（密码、位置参数、引号），都是 400 + 人话")
print("PASS rclone 缓存模式是常设的 writes（接口不再暴露可选列表）")

# 预检的两条判据（用真实加密远端复现后重写）：
#   ① 密码错 → 上游里经 crypt 写进去的名字一个都解不开 → 必须拦
#   ② 密码对、但上游根里有非加密名字（.DS_Store 那种）→ 绝不能误判成密码错（这就是用户踩的那个）
if SEEDED:
    status, body = call(
        "/api/rclone/mount",
        {"name": "cryptjunk", "mountpoint": os.path.join(root, "mnt-wrong"), "password": WRONG},
    )
    assert status == 400 and "密码不对" in body.get("error", ""), f"错密码分支：{status} {body}"
    print("PASS rclone 错密码：挂之前就拦住（rclone 自己会带着错密码挂上，之后只吐 undecryptable 名字）")

    status, body = call(
        "/api/rclone/mount",
        {"name": "cryptjunk", "mountpoint": os.path.join(root, "mnt-junk"), "password": SECRET,
         "extra": "--vfs-cache-mode off"},
    )
    assert status == 200, f"密码对却挂不上（预检误判？）：{status} {body}"
    note = (body.get("mounted") or {}).get("preflight", "")
    assert "不是经这个 crypt 写进去的" in note, f"没有把上游里的非加密名字说清楚：{note!r}"
    assert "读得出" in note, f"预检应当确认读得出名字：{note!r}"
    print(f"PASS rclone 预检不误判：密码对 + 上游根里有非加密名字 → 照样挂上（{note}）")
    status, body = call("/api/rclone/umount", {"name": "cryptjunk"})
    assert status == 200, f"卸载失败：{status} {body}"
else:
    print("SKIP rclone 预检两条判据：本机没有 rclone（没法往 crypt 里写加密名字）")

# 挂在一个**符号链接**路径上（record 存的是 /tmp 形式，挂载表里是 /private/tmp 形式）——
# 这条就是防「probe 拿记录里未解析的路径去比挂载表」那个回归
status, body = call(
    "/api/rclone/mount",
    {"name": "cryptempty", "mountpoint": os.path.join(root, "mnt-link"), "password": SECRET,
     "extra": "--read-only --dir-cache-time 1s"},
)
if status != 200:
    hint = (body.get("hint") or "")[:160]
    print(f"SKIP rclone 真挂载：本机 rclone mount 起不来（{body.get('error')} / {hint}）—— 接口契约与密码卫生已单独覆盖")
else:
    mounted = body["mounted"]
    assert mounted["mountpoint"].endswith("mnt-link"), f"挂载记录不对：{mounted}"
    assert mounted["readable"], f"挂上了但读不出内容（预热没等完）：{mounted}"
    status, probe = call("/api/rclone/probe", {"name": "cryptempty"})
    assert status == 200 and probe["probe"]["ok"], f"刚挂上就探测失败（挂载表缓存回归）：{status} {probe}"
    assert mounted["mountpoint_resolved"] != mounted["mountpoint"] or not mounted["mountpoint"].startswith("/tmp"), \
        "符号链接对照没生效（挂载点没走 /tmp）"
    # 进程那一维：挂上之后必须能认出 rclone 的 pid。曾按「命令行里含这几个字」认，挂载路径里
    # 带 yhub 的真实进程被自己排除，pid 永远 None、「进程存活」形同虚设，卸载也不发 SIGTERM
    # （2026-09-29 实测）—— 这条断言防的就是它。
    assert isinstance(mounted.get("pid"), int) and mounted["pid"] > 0, \
        f"挂载记录里没有 rclone 进程的 pid：{mounted.get('pid')}"
    # 「更多参数」要真透传、记录要如实（缓存模式是常设 writes，额外参数里的开关不藏）
    assert mounted["cache"] == "writes", f"缓存模式不是常设的 writes：{mounted.get('cache')}"
    assert mounted["extra_args"] == ["--read-only", "--dir-cache-time", "1s"], \
        f"更多参数没如实记录：{mounted.get('extra_args')}"
    assert mounted["read_only"] is True, "更多参数里给了 --read-only，记录里却没标只读（状态骗人）"
    print(f"PASS rclone 真挂载（符号链接路径 {mounted['mountpoint']} → {mounted['mountpoint_resolved']}）："
          f"读得出来（预热 {mounted['warmup_ms']}ms），刚挂上就能探测；"
          f"更多参数已透传 {mounted['extra_args']}，缓存模式常设 {mounted['cache']}")
    status, view = call("/api/rclone")
    assert SECRET not in json.dumps(view, ensure_ascii=False), "挂载后的状态响应里出现密码"
    state_file = os.path.join(cfg_root, "rclone.state.json")
    assert os.path.isfile(state_file), f"状态文件没落在临时配置根里：{state_file}"
    blob = open(state_file, encoding="utf-8").read()
    assert SECRET not in blob, f"状态文件里出现明文密码：{state_file}"
    assert "obscure" not in blob.lower() and "password" not in blob.lower(), f"状态文件里出现密码字段：{state_file}"
    print(f"PASS rclone 密码不落盘：{os.path.relpath(state_file, os.getcwd())} 里既没有明文也没有密码字段")
    # 信息墙那一格必须**真的取到数**：取数调的是适配器的 cell()，写错名字就会永远
    # 「取数出错，拿不到这一格的数据」（2026-09-29 实测踩到）—— 这条断言防的就是它。
    status, cells = call("/api/dashboard/cells")
    assert status == 200, f"/api/dashboard/cells -> HTTP {status}"
    wall = next((c for c in cells["cells"] if c["id"] == "rclone.mounts"), None)
    assert wall is not None, "信息墙上没有 rclone 那一格"
    assert "source_error" not in wall or not wall["source_error"], f"rclone 那一格取数出错：{wall.get('source_error')}"
    assert wall["status"] in ("ok", "warn"), f"rclone 那一格状态不对：{wall['status']}"
    print(f"PASS 信息墙 rclone 那一格：取到数了（{wall['status']}：{wall['summary']}；深链 {wall['href']}）")

    status, body = call("/api/rclone/umount", {"name": "cryptempty"})
    assert status == 200, f"卸载失败：{status} {body}"
    status, view = call("/api/rclone")
    assert view["mounts"] == [], "卸载后还有挂载记录"
    # 卸载要连**进程**一起收干净（SIGTERM 那一步靠 pid，pid 认不出来就留一个孤儿 rclone）
    try:
        leftovers = subprocess.run(["ps", "-axo", "command="], capture_output=True, text=True).stdout
    except OSError:
        leftovers = subprocess.run(["pgrep", "-fl", "rclone"], capture_output=True, text=True).stdout
    orphans = [ln for ln in leftovers.splitlines() if f"rclone mount cryptempty:" in ln]
    assert not orphans, f"卸载后还有 rclone 进程没收掉：{orphans}"
    print("PASS rclone 卸载：挂载表、记录、进程都清干净（含 /tmp 那条符号链接路径）")
PY
else
  skip_section "3/5 Rclone 真挂/真读/真卸：本机没有 rclone（挂载还需要 macFUSE / FUSE-T）"
fi


say "3.5/5 Rclone 密码卫生 + 僵住也不拖住请求路径（假 rclone / 假 ls 探针）"
"$PY" - "$REPO_ROOT" <<'PY' || { stop_backend; fail "rclone 密码卫生 / 僵住回归断言未通过"; }
import json, os, shutil, subprocess, sys, tempfile, threading, time
from pathlib import Path

repo = Path(sys.argv[1])
sys.path.insert(0, str(repo))
from yhub.cli import rclone as rc
from yhub.cli import rclone_obscure as ob

SECRET = "dummy-pw-hygiene-only"
REMOTE = "hygieneprobe"

FAKE_RCLONE = """#!/bin/bash
{
  echo "--- argv"
  for a in "$@"; do echo "$a"; done
  echo "--- env"
  env | grep -E '^RCLONE_CONFIG_[A-Z0-9_]*PASS(WORD)?=' | sed 's/^/env:/'
} >> "$RCLONE_RECORD"
case "$1" in
  lsf) exit 0 ;;
  mount) touch "$FAKE_MOUNT_FLAG"; exit 0 ;;
esac
exit 0
"""

FAKE_MOUNT = """#!/bin/bash
if [ -f "$FAKE_MOUNT_FLAG" ]; then echo "fake-src on $FAKE_MOUNT_POINT (fuse-t, nodev, nosuid)"; fi
exit 0
"""

# 1) obscure 算法本身：FIPS-197 的 AES-256 官方向量 + 与 rclone 的 reveal 对拍（若本机有 rclone）
key = bytes(range(32))
assert ob._encrypt_block(bytes.fromhex("00112233445566778899aabbccddeeff"), ob._expand_key(key)).hex() == \
    "8ea2b7ca516745bfeafc49904b496089", "AES-256 实现不对（FIPS-197 C.3 向量）"
for sample in ("x", "", "中文密码", "a" * 64):
    assert ob.reveal(ob.obscure(sample)) == sample, f"obscure/reveal 不是一对：{sample!r}"
if shutil.which("rclone"):
    import subprocess
    mine = ob.obscure(SECRET)
    theirs = subprocess.run(["rclone", "reveal", mine], capture_output=True, text=True).stdout.strip()
    assert theirs == SECRET, f"rclone reveal 认不出我们算的 obscured：{theirs[:40]}"
    ours = ob.reveal(subprocess.run(["rclone", "obscure", SECRET], capture_output=True, text=True).stdout.strip())
    assert ours == SECRET, "我们认不出 rclone 算的 obscured"
    print("PASS rclone obscure：AES-256 官方向量 + 与 rclone 双向对拍一致")
else:
    print("PASS rclone obscure：AES-256 官方向量 + 往返一致（本机没有 rclone，跳过对拍）")

work = Path(tempfile.mkdtemp(prefix="rclone-hygiene-"))
shim, record, point = work / "bin", work / "record.txt", work / "mnt"
shim.mkdir()
(shim / "rclone").write_text(FAKE_RCLONE, encoding="utf-8")
(shim / "mount").write_text(FAKE_MOUNT, encoding="utf-8")
for name in ("rclone", "mount"):
    (shim / name).chmod(0o755)
config, state = work / "rclone.conf", work / "state.json"
config.write_text(f"[{REMOTE}]\ntype = crypt\nremote = /tmp\npassword = \n", encoding="utf-8")

saved = {k: os.environ.get(k) for k in ("PATH", "RCLONE_CONFIG", "RCLONE_CONFIG_VAULT_PASSWORD")}
os.environ["PATH"] = f"{shim}:{saved['PATH']}"
os.environ["RCLONE_CONFIG"] = str(config)
os.environ["RCLONE_RECORD"] = str(record)
os.environ["FAKE_MOUNT_POINT"] = str(point.resolve())
os.environ["FAKE_MOUNT_FLAG"] = str(work / "mounted.flag")
# 状态文件路径是**现算**的（跟着 YHUB_CONFIG_DIR 走）→ 把配置根挪到临时目录，假 rclone 的
# 调用记录与状态就落在 work/ 下，不会碰用户真实的 ~/.config/yhub/rclone.state.json。
os.environ["YHUB_CONFIG_DIR"] = str(work)
state = rc.state_path()
rc.RCLONE_CONFIG_PATH = config

try:
    row = rc.mount(REMOTE, mountpoint=str(point), password=SECRET, extra_args=["--vfs-cache-mode", "off"])
    text = record.read_text(encoding="utf-8")
    blocks = [b for b in text.split("--- argv") if b.strip()]
    argv_lines = []
    for block in blocks:
        head, _, _ = block.partition("--- env")
        argv_lines += [line for line in head.splitlines() if line.strip()]
    assert len(blocks) == 2, f"假 rclone 该被调用 2 次（预检 + 挂载），实际 {len(blocks)}"
    assert SECRET not in text, "argv 里出现了明文密码"
    assert not any(ob.looks_obscured(line) for line in argv_lines if len(line) > 24), "argv 里出现了像 obscured 的长串"
    expect_key = f"RCLONE_CONFIG_{REMOTE.upper()}_PASSWORD"
    env_lines = [line[4:] for line in text.splitlines() if line.startswith("env:")]
    got = dict(line.split("=", 1) for line in env_lines)
    assert expect_key in got, f"环境变量里没收到 {expect_key}（密码没传过去）"
    assert got[expect_key] != SECRET, "环境变量里收到的是明文（应当先算成 obscured）"
    assert ob.reveal(got[expect_key]) == SECRET, "环境变量里的值还原不回明文"
    assert expect_key not in os.environ, "调用返回后本进程环境里还留着密码键"
    assert not state.exists() or SECRET not in state.read_text(encoding="utf-8"), "状态文件里出现明文密码"
    leftovers = [str(f) for f in work.rglob("*") if f.is_file() and f != record and SECRET in f.read_text(encoding="utf-8", errors="ignore")]
    assert not leftovers, f"工作目录里出现明文密码：{leftovers}"
    print(f"PASS rclone 密码卫生：argv 里没有密码；环境变量收到的是 obscured（{len(got[expect_key])} 字符）；"
          f"返回后本进程无残留；状态文件与工作目录都干净（假 rclone 被调用 {len(blocks)} 次）")

    # ---- 回归：挂载点僵住时，请求路径一秒都不许被拖住 -------------------------------------
    # 用户报的真 bug（2026-09-29）：挂载点僵住时那次读**不可中断**，`subprocess` 的超时杀不掉它，
    # 谁调用谁永久挂住 —— 探测在请求路径上（面板每 5 秒轮一次、工作台那一格也会拉），
    # 几分钟就把后端线程耗干，界面再也开不出来。这里用「假 ls 永不返回」把僵住场景钉死。
    wedge = Path(tempfile.mkdtemp(prefix="rclone-wedge-"))
    wshim = wedge / "bin"
    wshim.mkdir()
    for name, body in (("mount", FAKE_MOUNT), ("ls", "#!/bin/bash\nsleep 999\n"),
                       ("df", "#!/bin/bash\necho 'Filesystem 1024-blocks Used Available Capacity Mounted on'\n"
                              "echo '/dev/disk3s1 1000000 1 999999 1% /'\n")):
        (wshim / name).write_text(body, encoding="utf-8")
        (wshim / name).chmod(0o755)
    wpoint, wflag = wedge / "mnt", wedge / "mounted.flag"
    wpoint.mkdir()
    wflag.write_text("")
    # 保留上一层（假 rclone 的 shim）在 PATH 里：否则 rclone_bin() 找不到 rclone，
    # cell() 会直接报「本机没装 rclone」，这条断言就永远走不到「读不动」那个分支
    os.environ["PATH"] = f"{wshim}:{os.environ['PATH']}"
    os.environ["FAKE_MOUNT_POINT"] = str(wpoint.resolve())
    os.environ["FAKE_MOUNT_FLAG"] = str(wflag)
    os.environ["YHUB_CONFIG_DIR"] = str(wedge)
    stale_state = rc.state_path()
    stale_state.parent.mkdir(parents=True, exist_ok=True)
    stale_state.write_text(json.dumps({
        "version": 1,
        "mounts": {"wedged": {
            "name": "wedged", "remote": "wedged:", "type": "crypt", "encrypted": True,
            "mountpoint": str(wpoint), "mountpoint_resolved": str(wpoint.resolve()),
            "source": "fake-src", "pid": os.getpid(), "read_only": False, "cache": "writes",
            "extra_args": [], "started_at": "2020-01-01 00:00:00", "readable": True,
            "warmup_ms": 1, "probe_fails": 0,
        }},
    }, ensure_ascii=False), encoding="utf-8")

    def seconds(fn):
        begin = time.time()
        value = fn()
        return time.time() - begin, value

    stuck_seconds = rc.PROBE_STUCK_SECONDS
    rc.PROBE_STUCK_SECONDS = 1.0  # 别为了等门限让验收多跑 30 秒
    try:
        rc.start_probe("wedged")
        again = rc.start_probe("wedged")
        running = [t for t in threading.enumerate() if t.name == "rclone-probe-wedged"]
        assert len(running) == 1, f"同一个远端起了不止一个探测线程：{len(running)}"
        assert again.get("running"), f"第二次 start_probe 没说清在飞：{again}"
        took_rows, _ = seconds(lambda: rc.mounts(auto_probe=True))
        took_status, view = seconds(rc.status)
        took_cell, _ = seconds(rc.cell)
        took_probe, probed = seconds(lambda: rc.probe("wedged", wait_seconds=1.0))
        assert took_rows < 2 and took_status < 2 and took_cell < 2, (
            f"探测卡住时请求路径被拖住了：mounts {took_rows:.2f}s / status {took_status:.2f}s / cell {took_cell:.2f}s")
        assert probed.get("running"), f"有界等待没在跑：{probed}"
        assert took_probe < 3, f"探测端点等了 {took_probe:.2f}s（应当 ≤ 有界等待）"
        time.sleep(1.5)
        row = next(r for r in rc.mounts(auto_probe=False) if r["name"] == "wedged")
        assert row.get("probe_stuck_seconds"), f"跑了 1.5s（门限 1.0s）却没说「卡住」：{row.get('probe_running')}"
        wall = rc.cell()
        assert "读不动" in wall["summary"], f"信息墙那格没说读不动：{wall}"
        print(f"PASS rclone 僵住也不拖住请求：挂载点读不动时 mounts/status/cell 都在 {took_rows:.2f}s 内回，"
              f"探测有界返回（{took_probe:.2f}s）；同一远端只起一根探测；卡住 {row['probe_stuck_seconds']}s 后如实报「读不动了」")
    finally:
        rc.PROBE_STUCK_SECONDS = stuck_seconds
        os.environ["PATH"] = f"{shim}:{saved['PATH']}"
    shutil.rmtree(wedge, ignore_errors=True)
    os.system("pkill -f 'sleep 999' >/dev/null 2>&1")
finally:
    for key_name, value in saved.items():
        if value is None:
            os.environ.pop(key_name, None)
        else:
            os.environ[key_name] = value
    shutil.rmtree(work, ignore_errors=True)
PY

say "3.8/5 内置胶囊层：随包分发 + 只读 + 页面可取"
stop_backend || fail "上一轮后端没停下来"
SYSTEM_CAPS_DIR=""
start_and_wait builtin-capsules || { stop_backend || true; fail "带内置胶囊层启动失败"; }
"$PY" - "$PORT" <<'CAPASSERT' || { stop_backend; fail "内置胶囊层断言未通过"; }
import json, sys, urllib.error, urllib.parse, urllib.request

base = f"http://127.0.0.1:{int(sys.argv[1])}"


def get(path):
    with urllib.request.urlopen(base + path, timeout=30) as resp:
        return resp.status, resp.read()


listing = json.loads(get("/api/capsules")[1])
sysdir = listing.get("system_capsules_dir") or ""
assert sysdir, "系统层目录没定位到（仓库 capsules/ 为空？先 make capsules）"
sys_caps = [c for c in listing["capsules"] if c.get("source") == "system"]
assert len(sys_caps) >= 1, f"一个内置胶囊都没有：{[c.get('relpath') for c in sys_caps]}"
assert all(c.get("writable") is False for c in sys_caps), "内置层不该是可写"
one = sys_caps[0]
page = "/capsules/" + urllib.parse.quote(one["url_path"])
status, body = get(page)
assert status == 200 and b"<html" in body.lower(), f"内置胶囊页面打不开：{page} HTTP {status}"
req = urllib.request.Request(base + page, data=b"x", method="PUT")
try:
    urllib.request.urlopen(req, timeout=10)
    raise AssertionError("内置胶囊竟然可写（应 403）")
except urllib.error.HTTPError as exc:
    assert exc.code == 403, f"内置胶囊 PUT 该 403，实际 {exc.code}"
print(f"PASS 内置胶囊层：{len(sys_caps)} 个（{', '.join(c['relpath'] for c in sys_caps)}），只读，页面可取")
CAPASSERT
stop_backend || fail "内置胶囊层后端没停下来"
SYSTEM_CAPS_DIR="/nonexistent"

say "4/4 热启动（同一份代码第二次跑，进程刚退出）"
stop_backend || fail "上一轮后端没停下来"
start_and_wait warm || { stop_backend || true; fail "热启动失败"; }
WARM="$READY_SECONDS"
echo "就绪耗时：${WARM}s"
stop_backend || fail "后端没停下来"

"$PY" - "$REPORT" "$COLD" "$WARM" "$REQ_TIMES" <<'PY'
import json, sys
report, cold, warm, req_times = (
    sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4])
with open(req_times) as fh:
    request_seconds = json.load(fh)
out = {
    "mode": "python",
    "cold_start_seconds": cold,
    "warm_start_seconds": warm,
    "request_seconds": request_seconds,
    "note": "cold = 后端在本机第一次启动（页缓存冷热程度取决于系统，非严格冷启动）；warm = 紧接着第二次启动",
}
with open(report, "w") as fh:
    json.dump(out, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PY

if [ "$SKIPPED" -gt 0 ]; then
  say "全绿（${SKIPPED} 段跳过：缺外部依赖，见上面的 SKIP 行）"
else
  say "全绿"
fi
cat <<EOF
  启动命令      ${BACKEND_CMD[*]}
  首次启动      ${COLD}s
  热启动        ${WARM}s
  报告          build/backend-verify.json
EOF
