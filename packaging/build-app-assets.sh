#!/usr/bin/env bash
#
# Tauri 的 beforeBuildCommand 落点：`tauri build` 之前把前端与随包胶囊准备好。
#
#   ./packaging/build-app-assets.sh
#
# **不再冻结 Python 后端**：App 里没有 Python 运行时，后端由用户安装的 `yhub` 提供
# （PyPI / `uv tool install .` / 源码树 `uv run`）。壳在启动时按
# 「复用已有服务 → 已安装 yhub → uv run」的顺序拉起（见 tauri/src/backend.rs）。
#
# 两件事：
#   1) web/dist —— 前端在**编译期**嵌进 Tauri 二进制（改完前端不重建，装的还是旧界面）；
#   2) capsules/ —— 随包分发的只读示例胶囊（由 capsule-src/ 构建）。
#
# cwd 说明：Tauri v2 的 beforeBuildCommand 在**仓库根**执行，所以 tauri.conf.json
# 里写的是 `bash packaging/...`。
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "== [1/2] 构建前端 web/dist"
[ -d web/node_modules ] || {
  echo "缺 web/node_modules —— 先执行：cd web && npm install" >&2; exit 1; }
( cd web && npm run build )

echo "== [2/2] 构建胶囊产物 capsules/"
./scripts/build-capsules.sh

echo "== 资源就绪：web/dist + capsules/（后端由已安装的 yhub 提供）"
