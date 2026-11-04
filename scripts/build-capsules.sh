#!/usr/bin/env bash
#
# 把 `capsule-src/` 里多文件胶囊工程构建成单文件 HTML，落 `capsules/`（运行时扫它）。
#
# 每个子目录是一种常见布局：
#   * 有 package.json → 走 `npm run build`（Vite / 任意构建器；推荐 vite-plugin-singlefile 产出单 HTML）
#   * 没 package.json 但有 .html → 直接拷贝（ Already single file，可跳过构建器）
#
# 产出只认单文件：运行时 /capsules 只扫 .html/.htm，多文件 authored 源不要直接放 capsules/。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p capsules

# 清理「源已经删掉、产物还在」的胶囊：不然胶囊库里会留一个再也构建不出来的孤魂。
for out in capsules/*.html capsules/*/; do
  [ -e "$out" ] || continue
  name="$(basename "$out")"
  name="${name%.html}"
  name="${name%/}"
  [ -d "capsule-src/$name" ] || { echo "== capsules：清理已删除的 $name"; rm -rf "$out"; }
done

if ! compgen -G "capsule-src/*" > /dev/null; then
  echo "== capsules：capsule-src/ 为空，跳过（没有多文件胶囊要构建）"
  exit 0
fi

for src in capsule-src/*/; do
  [ -d "$src" ] || continue
  name="$(basename "$src")"
  echo "== capsules：构建 $name"
  # 先清掉上一轮的产物（两种形态都清）：否则旧版本留下的 <name>/index.html 会和新产出的
  # <name>.html 同时存在 —— 同一个胶囊在列表里出现两次，短地址还会互相撞车。
  rm -rf "capsules/$name" "capsules/$name.html"
  if [ -f "$src/package.json" ]; then
    (
      cd "$src"
      if [ -f package-lock.json ]; then
        npm ci
      else
        npm install
      fi
      npm run build
    )
  else
    # 没有构建器 = 单文件胶囊：只产出 capsules/<name>.html 这一份。
    # （连目录一起拷贝会让同一个胶囊有两种地址形态，短地址还会互相抢。）
    src_html="$src/index.html"
    if [ ! -f "$src_html" ]; then
      src_html="$(ls "$src"*.html 2>/dev/null | head -1 || true)"
    fi
    if [ -z "${src_html:-}" ] || [ ! -f "$src_html" ]; then
      echo "   ⚠ 跳过 ${name}：目录里没有 .html" >&2
      continue
    fi
    cp "$src_html" "capsules/$name.html"
  fi
done

echo "== capsules：产物在 capsules/（gitignored 构建产物）"
