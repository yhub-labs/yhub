#!/usr/bin/env bash
#
# 把 `capsule-src/` 里多文件胶囊工程构建成单文件 HTML，落 `capsules/`（运行时扫它）。
#
# 每个子目录是一种常见布局：
#   * 有 package.json → 走 `npm run build`（Vite / 任意构建器；推荐 vite-plugin-singlefile 产出单 HTML）
#   * 没 package.json 但有 .html → 直接拷贝（ Already single file，可跳过构建器）
#
# 产出只认单文件：运行时 /capsules 只扫 .html/.htm，多文件 authored 源不要直接放 capsules/。
#
# 另有一类**不来自 capsule-src/** 的随包胶囊：上游官方发布的单文件 HTML，**构建时**从官网下载，
# 产物与工程胶囊一样落在 capsules/<名字>.html。登记表见下面 vendored_capsules()：加一个「官方单文件
# 应用」只需加一行（名字 + 下载地址），不需要为它写代码。下载失败不会静默：有上一轮产物就复用它
# （离线可重复构建），一份都没有才让构建失败。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p capsules

# ---- 随包分发的第三方单文件胶囊（构建时下载，不是 capsule-src/ 里的工程）------------------
# 每行 `名字|下载地址`。名字 = 产物 capsules/<名字>.html，也是孤儿清理的白名单。
# 地址可用环境变量覆盖：`YHUB_CAPSULE_URL_<大写名字>`（如 YHUB_CAPSULE_URL_TIDDLYWIKI=/path/x.html）。
vendored_capsules() {
  cat <<'EOF'
tiddlywiki|https://tiddlywiki.com/empty.html
EOF
}

# 通用下载器：体积 / 内容做最小体检（拒绝错误页、空响应），失败时优先复用上一轮产物。
fetch_vendored() {
  local name="$1" url="$2" out="capsules/$1.html" override tmp bytes
  override="YHUB_CAPSULE_URL_$(printf '%s' "$name" | tr '[:lower:]-/.' '[:upper:]___')"
  url="${!override:-$url}"
  tmp="$(mktemp "${TMPDIR:-/tmp}/$name.XXXXXX")"
  if curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 "$url" -o "$tmp" \
     && [ "$(wc -c < "$tmp" | tr -d ' ')" -gt 100000 ] \
     && grep -qi "<html" "$tmp"; then
    mv "$tmp" "$out"
    chmod 644 "$out"  # mktemp 是 600；随包资源按普通只读文件分发
    bytes="$(wc -c < "$out" | tr -d ' ')"
    echo "== capsules：$name ← $url（$bytes 字节）"
    return 0
  fi
  rm -f "$tmp"
  if [ -f "$out" ]; then
    echo "== capsules：⚠ 下载 $name 失败（$url），沿用上一轮产物" >&2
    return 0
  fi
  echo "== capsules：✗ 下载 $name 失败（$url），且没有可复用的产物" >&2
  return 1
}

VENDORED_CAPSULES=""
while IFS='|' read -r vname vurl; do
  [ -n "${vname:-}" ] || continue
  VENDORED_CAPSULES="$VENDORED_CAPSULES $vname"
  fetch_vendored "$vname" "$vurl" || exit 1
done < <(vendored_capsules)

# 清理「源已经删掉、产物还在」的胶囊：不然胶囊库里会留一个再也构建不出来的孤魂。
for out in capsules/*.html capsules/*/; do
  [ -e "$out" ] || continue
  name="$(basename "$out")"
  name="${name%.html}"
  name="${name%/}"
  case " $VENDORED_CAPSULES " in *" $name "*) continue ;; esac
  [ -d "capsule-src/$name" ] || { echo "== capsules：清理已删除的 $name"; rm -rf "$out"; }
done

if ! compgen -G "capsule-src/*" > /dev/null; then
  echo "== capsules：capsule-src/ 为空，跳过工程构建（随包下载的胶囊已就绪）"
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
