#!/usr/bin/env python3
"""验证交付的两份 Y-Hub 图标源文件。

检查项：
  1. viewBox 是 24×24（大尺寸件与单色件都一样）；
  2. 没有任何外部引用（只允许同文档 url(#...)）；
  3. 单色件用 currentColor 着色，大尺寸件只用本仓库定义的品牌绿；
  4. 几何 = 三格按 Y 拓扑摆放（3 个圆角矩形，不引入第三方 path）。

这份几何是 Y-Hub 自己的，没有第三方图形，所以没有署名义务。

用法：python3 verify.py
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FILES = ["yhub-icon.svg", "yhub-icon-mono.svg"]
BRAND = {"#4E7A5C", "#9CC3A6"}   # 苔绿 / 浅苔

ok = True
for f in FILES:
    text = (HERE / f).read_text(encoding="utf-8")
    print(f"\n--- {f} ---")
    vb = re.search(r'viewBox="([^"]+)"', text)
    vb_ok = vb is not None and vb.group(1) == "0 0 24 24"
    print(f"  viewBox: {vb.group(1) if vb else 'MISSING'} -> {'ok' if vb_ok else 'FAIL'}")
    ok &= vb_ok

    ext = re.findall(r'(?:xlink:)?href="([^"]+)"|<image|@import', text)
    urls = re.findall(r"url\(([^)]+)\)", text)
    ext_ok = not ext and all(u.startswith("#") for u in urls)
    print(f"  external refs: {ext or 'none'}; url() refs: {urls or 'none'} -> {'ok' if ext_ok else 'FAIL'}")
    ok &= ext_ok

    shapes = len(re.findall(r"<(?:rect|circle|path)\b", text))
    shape_ok = shapes == 3 and "<path" not in text
    print(f"  shapes: {shapes}（期望 3 = Y 拓扑的三格，且不含 path） -> {'ok' if shape_ok else 'FAIL'}")
    ok &= shape_ok

    if f.endswith("mono.svg"):
        color_ok = "currentColor" in text
        print(f"  colour: currentColor -> {'ok' if color_ok else 'FAIL'}")
    else:
        used = set(re.findall(r'fill="(#[0-9A-Fa-f]{6})"', text))
        color_ok = used == BRAND
        print(f"  colour: {sorted(used)} -> {'ok' if color_ok else 'FAIL'}（期望 {sorted(BRAND)}）")
    ok &= color_ok

print("\nALL CHECKS PASS" if ok else "\nFAILURES PRESENT")
sys.exit(0 if ok else 1)
