#!/usr/bin/env bash
#
# 插件本地开发：把插件目录**软链**进一个独立配置根，再用 `--reload` 起后端。
#
#   ./scripts/dev-plugin.sh ~/Projects/yhub-plugin-zdic
#   ./scripts/dev-plugin.sh ~/Projects/yhub-plugins/memos --port 8791
#
# 为什么不是「复制进 ~/.config/yhub/plugins」再反复 `plugin install --force`：
#   * 复制之后你改的是仓库，跑的是副本，两边会不知不觉分叉；
#   * 宿主对已加载的模块按 (路径, mtime, size) 缓存，但 **HTTP 路由绑定的是注册时的函数对象**，
#     重新 import 不会换掉已注册的路由 —— 所以改代码要么重置注册表，要么重起进程。
# 软链 + `--reload` 让「保存即重起」，路由、locales、manifest 一起重读，没有半新半旧的状态。
#
# 环境隔离：默认配置根是 build/dev-config（仓库内、gitignored），不会碰 ~/.config/yhub。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PLUGIN_DIR=""
PORT="8790"
CONFIG_DIR="${YHUB_DEV_CONFIG:-$REPO_ROOT/build/dev-config}"
LANG_TAG="${YHUB_LANG:-en}"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --config) CONFIG_DIR="$2"; shift 2 ;;
    --lang) LANG_TAG="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "未知参数：$1" >&2; exit 2 ;;
    *) PLUGIN_DIR="$1"; shift ;;
  esac
done

PLUGIN_DIR="${PLUGIN_DIR:-$PWD}"
[ -f "$PLUGIN_DIR/plugin.json" ] || {
  echo "× $PLUGIN_DIR 里没有 plugin.json —— 传一个插件目录，或先 cd 进去" >&2
  exit 1
}
PLUGIN_DIR="$(cd "$PLUGIN_DIR" && pwd)"

PLUGIN_ID="$(python3 - "$PLUGIN_DIR/plugin.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["id"])
PY
)"

mkdir -p "$CONFIG_DIR/plugins"
rm -rf "$CONFIG_DIR/plugins/$PLUGIN_ID"
ln -s "$PLUGIN_DIR" "$CONFIG_DIR/plugins/$PLUGIN_ID"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "× 端口 $PORT 已被占用（多半是装机版后端）。先退 App 或 kill 它：" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | sed -n '1,3p' >&2
  exit 1
fi

cat <<EOF
插件      ${PLUGIN_ID}（${PLUGIN_DIR}）
软链      ${CONFIG_DIR}/plugins/${PLUGIN_ID}
配置根    ${CONFIG_DIR}     语言 ${LANG_TAG}
后端      http://127.0.0.1:${PORT}
界面      http://127.0.0.1:${PORT}/      改前端另开：cd web && npm run dev（5173 代理 /api 到 ${PORT}）

保存 plugin.py / plugin.json / locales/*.json 会自动重起；manifest 或 locales 写错时后端会带着
错误信息退出，那就是反馈（不会留一个半新半旧的进程）。
EOF

# 退出时提醒：开发后端占过 8790、也 export 过隔离变量。直接 `open -a` 重开 App 会继承它们，
# 于是装机版后端读的是这个开发配置根（工具只剩几个，界面上看不出原因）。
cleanup_note() {
  echo
  echo "== 开发后端已停。重开装机版请用：make open-app（会摘掉 YHUB_* 隔离变量）"
}
trap cleanup_note EXIT

export YHUB_CONFIG_DIR="$CONFIG_DIR"
export YHUB_LANG="$LANG_TAG"
exec uv run uvicorn yhub.server.main:app \
  --host 127.0.0.1 --port "$PORT" \
  --reload \
  --reload-dir "$PLUGIN_DIR" \
  --reload-dir "$REPO_ROOT/yhub/server/adapters" \
  --reload-include '*.py' --reload-include '*.json'   # uvicorn 默认只盯 *.py，locales 也得盯
