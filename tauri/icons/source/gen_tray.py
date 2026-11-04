#!/usr/bin/env python3
"""生成 macOS 菜单栏（托盘）模板图：tauri/icons/tray/tray-template.png

为什么不复用 App 图标
--------------------
1. 菜单栏图标必须是**模板图**（只取 alpha，无颜色），macOS 按系统主题自动反色；
   App 图标是「实心绿底板 + 反白图形」的方块，当模板图用会在菜单栏里变成一块实心砖。
2. 菜单栏可用高度只有 18pt（`tray-icon` 在 macOS 上固定按 18pt 绘制）。
   底板一占，图形只剩 ~10px，「三格 + 一点」的缝就糊在一起了。所以这里只取**图形本体**
   （几何与 App 图标同源），吃掉底板省下的那圈留白，图形直接铺到 18pt。

几何来源：tauri/icons/source/yhub/yhub-icon-mono.svg —— 也就是 App 图标母版
（app-icon.svg）的同一个几何真相，两处永远一致，改图只改 yhub/ 下那两个 SVG。

尺寸：36×36 像素 = 18pt @2x。

用法（需要带 Pillow 的 python3；渲染用本机 Chrome，与 web/smoke.mjs 同一个）：
    python3 tauri/icons/source/gen_tray.py             # 出图 tray-template.png
    python3 tauri/icons/source/gen_tray.py --variants  # 出候选对比图（含"去掉星芒"那版）
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HERE = Path(__file__).resolve().parent                 # tauri/icons/source
SRC = HERE / "yhub" / "yhub-icon-mono.svg"         # 几何真相
OUT = HERE.parent / "tray" / "tray-template.png"
SHEET = HERE.parent.parent.parent / "build" / "tray-variants.png"
N = 36                                                 # 18pt @2x


def load_svg(*, tight: bool = True, size: int = N) -> str:
    """读单色源文件，把 width/height 换成目标像素（Chrome 按声明尺寸 1:1 出图）。

    tight=True：把 viewBox 收到图形 ink bbox 外侧约 1 单位（24 单位里占 2.9~21.1），图形铺满 18pt；
    tight=False：保留原始 24×24 留白，作为候选对比用。
    """
    svg = SRC.read_text(encoding="utf-8").replace('width="24" height="24"', f'width="{size}" height="{size}"')
    if tight:
        # 留一圈约 1.2 单位（≈2px @36px）的空气：菜单栏图标贴边会被系统圆角裁掉
        svg = svg.replace('viewBox="0 0 24 24"', 'viewBox="1.9 1.9 20.2 20.2"')
    return svg


def render(svg: str, size: int = N) -> Image.Image:
    """Chrome 无头渲染成透明底 PNG。"""
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "in.svg"
        png = Path(td) / "out.png"
        src.write_text(svg, encoding="utf-8")
        r = subprocess.run([CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
                            "--force-device-scale-factor=1", f"--window-size={size},{size}",
                            "--default-background-color=00000000", f"--screenshot={png}",
                            f"file://{src}"], capture_output=True, text=True)
        if not png.exists():
            raise RuntimeError(f"Chrome 没出图：{r.stderr[-400:]}")
        im = Image.open(png).convert("RGBA")
    if im.size != (size, size):
        raise RuntimeError(f"渲染尺寸不符：{im.size}，期望 {size}x{size}")
    return im


def to_template(im: Image.Image) -> Image.Image:
    """模板图 = 纯黑 + alpha：RGB 全部归零，只留 alpha 通道给系统反色。"""
    black = Image.new("RGBA", im.size, (0, 0, 0, 0))
    black.putalpha(im.getchannel("A"))
    return black


def report(name: str, im: Image.Image) -> None:
    box = im.getchannel("A").getbbox()
    px = im.load()
    w, h = im.size
    solid = sum(1 for y in range(h) for x in range(w) if px[x, y][3] >= 250)
    colors = {px[x, y][:3] for y in range(h) for x in range(w) if px[x, y][3] > 0}
    print(f"  {name}: {w}x{h} alpha_bbox={box} 实心{solid}px 非透明色={sorted(colors)[:3]}"
          f"{' (全黑 ✓)' if colors <= {(0, 0, 0)} else ' ✗ 不是纯黑'}")


def write_sheet() -> None:
    """候选对比：满尺寸 / 留白原生，各在浅底与深底上放大 4 倍看真像素。"""
    zoom, cell, pad, top = 4, N * 4 + 24, 20, 34
    variants = [("tight (adopted)", True), ("native 24-unit padding", False)]
    bgs = [(255, 255, 255), (28, 28, 28)]
    w = pad * 2 + len(bgs) * cell
    h = top + len(variants) * (cell + top)
    sheet = Image.new("RGB", (w, h), (235, 235, 235))
    d = ImageDraw.Draw(sheet)
    y = top
    for label, tight in variants:
        for i, bg in enumerate(bgs):
            fg = (0, 0, 0) if sum(bg) > 384 else (255, 255, 255)
            x0 = pad + i * cell
            d.rectangle([x0, y - top, x0 + cell - 1, y + cell - top + N * zoom - 1], fill=bg)
            glyph = render(load_svg(tight=tight))
            layer = Image.new("RGB", (N, N), fg)
            layer.paste(Image.new("RGB", (N, N), bg), (0, 0), glyph.getchannel("A"))
            sheet.paste(layer.resize((N * zoom, N * zoom), Image.Resampling.NEAREST), (x0 + 12, y))
            d.text((x0 + 12, y - top + 10), f"{label}  bg={'#FFF' if fg == (0, 0, 0) else '#1C1C1C'}",
                   fill=fg)
        y += cell + top
    SHEET.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(SHEET)
    print(f"  对比图 → {SHEET}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--variants", action="store_true", help="出候选方案对比图")
    a = ap.parse_args()

    if a.variants:
        write_sheet()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    to_template(render(load_svg())).save(OUT)
    print(f"wrote {OUT}")
    report("tray-template", Image.open(OUT).convert("RGBA"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
