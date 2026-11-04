#!/usr/bin/env python3
"""Y-Hub 图标落地脚本：把「四格枢纽」标识铺到整套打包资产。

链条（几何只有一个真相，其余都是它的派生）：

    yhub/yhub-icon-mono.svg   几何真相（Y 拓扑的三格，本仓库自绘，无第三方图形）
        │  本脚本：几何按顺序照抄，只加底板 + 着色 + 计算居中等比缩放
        ▼
    yhub/app-icon.svg           1024 矢量母版（要改参数就改本脚本再重跑）
        │  Chrome 无头光栅化（显式 width/height，按目标像素出图）
        ▼
    yhub/app-icon.png           1024 母版位图（与 app-icon.svg 同源，留证）
        │  Pillow LANCZOS 缩放
        ▼
    tauri/icons/{16,32,128,128@2x,256,512}.png   Tauri 打包图标（tauri.conf.json 已列出）
    tauri/icons/icon.png                         1024（开发态 / Linux）
    tauri/icons/icon.icns                        macOS（iconutil）
    tauri/icons/icon.ico                         Windows
    web/public/favicon.svg                       浏览器标签页（带深浅色媒体查询）

为什么是「实心深绿底板 + 反白图形」（2026-11 改版）
--------------------------------------------------
* 图形本身就是一块平板面（Y 拓扑的三格），放在白底板上会变成「白纸上的三个绿块」，
  缩小后与系统里别的浅色图标挤在一起；反过来用品牌绿铺满底板、图形反白，
  就得到一个**实心的色块标识**：任意壁纸、Dock 深色/浅色模式下轮廓都在，
  小尺寸也只剩「白块 vs 绿块」两档对比，不依赖细节。
* 扁平：没有渐变、没有投影、没有高光。立体感交给图形本身的明暗（亮薄荷那一点）。
* 圆角沿用 macOS 的连续圆角比例（底板内缩 42px、圆角 205px ≈ 画布 20%）。

尺寸分层：
  ≤32px 用单色（#2E7D5B）按目标像素直接矢量出图 —— 反白细缝在 16px 会被抗锯齿吃掉，
  小尺寸改成「绿图形直接画在透明底上」，交给宿主底色去做对比；
  ≥64px 用母版（1024）缩下来。

用法（需要带 Pillow 的 python3；渲染用本机 Chrome，与 web/smoke.mjs 是同一个）：
    python3 tauri/icons/source/yhub/gen_app_icons.py
    python3 tauri/icons/source/yhub/gen_app_icons.py --sheet build/app-icon-plates.png
    python3 tauri/icons/source/yhub/gen_app_icons.py --dry-run     # 只算不写
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageDraw

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SVG_NS = "{http://www.w3.org/2000/svg}"

HERE = Path(__file__).resolve().parent          # tauri/icons/source/yhub
ICONS = HERE.parent.parent                      # tauri/icons
REPO = ICONS.parent.parent                      # 仓库根
MONO_SVG = HERE / "yhub-icon-mono.svg"
APP_SVG = HERE / "app-icon.svg"
APP_PNG = HERE / "app-icon.png"
FAVICON = REPO / "web" / "public" / "favicon.svg"

CANVAS = 1024           # 母版边长
CONTENT = 0.56          # 图形最长边占画布比例（实心板不需要太满，四周留白 ≈ 22%）
PLATE_INSET = 42        # 底板内缩
PLATE_RADIUS = 205      # 底板圆角半径（≈ 画布 20%，接近 macOS 图标的比例）
SMALL_PX = 32           # ≤ 这个尺寸用单色直接出图

BRAND = "#4E7A5C"       # 品牌苔绿：白字压其上 4.85:1
SAGE = "#9CC3A6"        # 浅苔：Y 主干那一格 / 深底上的单色
PLATES: dict[str, dict] = {
    # fill = 底板色；glyph = 两臂；accent = 主干那一格；flat = 小尺寸单色；on = 小尺寸底板
    "light": dict(fill=BRAND, glyph="#FFFFFF", accent=SAGE, flat=BRAND, on="#FFFFFF"),
    "dark": dict(fill="#1C1C1C", glyph="#FFFFFF", accent=SAGE, flat=SAGE, on="#1C1C1C"),
}
PNG_SET = {16: "16x16.png", 32: "32x32.png", 128: "128x128.png",
           256: "256x256.png", 512: "512x512.png"}
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
ICNS = {  # iconset 文件名 → 像素边长
    "icon_16x16.png": 16, "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128, "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
}


# ---------------------------------------------------------------- 渲染与测量

def chrome_render(svg_text: str, size: int, out: Path) -> Image.Image:
    """Chrome 无头按目标像素渲染 SVG（透明底）。显式写 width/height，Chrome 才会 1:1 出图。

    必须显式给 `--user-data-dir`：沙箱/临时目录下 Chrome 自己挑的 profile 目录建不出来时，
    它只打一行 "Failed to create a unique user data directory" 就直接退出、不出图。
    """
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "in.svg"
        src.write_text(svg_text, encoding="utf-8")
        profile = Path(td) / "chrome-profile"
        profile.mkdir()
        cmd = [CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
               f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
               "--disable-crash-reporter",
               "--force-device-scale-factor=1", f"--window-size={size},{size}",
               "--default-background-color=00000000", f"--screenshot={out}",
               f"file://{src}"]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if not out.exists():
            raise RuntimeError(f"Chrome 没出图（{size}px）：{r.stderr[-400:]}")
    im = Image.open(out).convert("RGBA")
    if im.size != (size, size):
        raise RuntimeError(f"渲染尺寸不符：{out} = {im.size}，期望 {size}x{size}")
    return im


def ink_bbox(im: Image.Image) -> tuple[int, int, int, int]:
    box = im.getchannel("A").getbbox()
    if box is None:
        raise RuntimeError("整张图全透明")
    return box


def measure(im: Image.Image) -> str:
    """一张图的体检数据：尺寸 / 四角是否透明（底板圆角生效）/ 图形主色。

    四角 alpha 是最省事的"底板有没有圆角、有没有铺满画布"的判据；主色用来确认
    主色用来确认「品牌苔绿底板 / 反白图形」都在场；小尺寸下细缝会被抗锯齿摊薄，所以看不透明像素的比例。
    """
    px = im.load()
    w, h = im.size
    colors: dict[tuple[int, int, int], int] = {}
    opaque = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a >= 250:
                opaque += 1
                colors[(r, g, b)] = colors.get((r, g, b), 0) + 1
    total = sum(colors.values()) or 1
    top = sorted(colors.items(), key=lambda kv: -kv[1])[:2]
    corners = "".join("·" if px[x, y][3] == 0 else "x"
                      for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)))
    return (f"{w}px 角[{corners}] 实心{100 * opaque // (w * h)}%"
            f" 主色=" + ", ".join(f"#{r:02X}{g:02X}{b:02X}({100 * n // total}%)" for (r, g, b), n in top))


# ---------------------------------------------------------------- 矢量母版

def glyph_shapes() -> list[dict]:
    """从单色源文件取几何（唯一真相）：4 个形状，按文档顺序。

    只认 rect / circle —— 新标识是纯几何构成的，没有 path，也就不需要 fill-rule。
    """
    root = ET.parse(MONO_SVG).getroot()
    out = []
    for el in root.iter():
        tag = el.tag.split("}")[-1]
        if tag == "rect":
            out.append({"kind": "rect", "x": float(el.get("x")), "y": float(el.get("y")),
                        "w": float(el.get("width")), "h": float(el.get("height")),
                        "rx": float(el.get("rx") or 0)})
        elif tag == "circle":
            out.append({"kind": "circle", "cx": float(el.get("cx")), "cy": float(el.get("cy")),
                        "r": float(el.get("r"))})
    if len(out) != 3:
        raise RuntimeError(f"预期 3 个形状（Y 拓扑的三格），实际 {len(out)} 个")
    return out


def glyph_bbox_units() -> tuple[float, float, float, float]:
    """渲染一张透明底探针图，实测图形 bbox 并换算回 24 单位坐标系。

    量像素而不是手算曲线极值：贝塞尔的控制点算 bbox 容易错，量出来才可靠。
    """
    raw = MONO_SVG.read_text(encoding="utf-8")
    probe = raw.replace('width="24" height="24"', f'width="{CANVAS}" height="{CANVAS}"')
    with tempfile.TemporaryDirectory() as td:
        im = chrome_render(probe, CANVAS, Path(td) / "probe.png")
    x0, y0, x1, y1 = ink_bbox(im)
    u = 24.0 / CANVAS
    return x0 * u, y0 * u, (x1 + 1) * u, (y1 + 1) * u


def build_svg(plate: str, mode: str, shapes: list[dict],
              box: tuple[float, float, float, float], size: int = CANVAS) -> str:
    """生成 app 图标 SVG。

    mode="plate"  ：实心底板 + 反白图形（大尺寸；主干那一格用浅苔）
    mode="flat"   ：只画图形（小尺寸 / 透明底，图形用品牌绿）
    """
    preset = PLATES[plate]
    x0, y0, x1, y1 = box
    k = CONTENT * CANVAS / max(x1 - x0, y1 - y0)         # 24 单位 → 画布像素
    tx = CANVAS / 2 - k * (x0 + x1) / 2
    ty = CANVAS / 2 - k * (y0 + y1) / 2

    glyph_color = preset["glyph"] if mode == "plate" else preset["flat"]
    accent_color = preset["accent"] if mode == "plate" else preset["flat"]
    # 主干 = 最后一个形状（源文件里三格的顺序：左臂、右臂、主干）
    stem = shapes[-1] if shapes else None

    body = []
    for sh in shapes:
        color = accent_color if sh is stem else glyph_color
        if sh["kind"] == "rect":
            body.append(f'    <rect x="{sh["x"]:g}" y="{sh["y"]:g}" width="{sh["w"]:g}" '
                        f'height="{sh["h"]:g}" rx="{sh["rx"]:g}" fill="{color}"/>')
        else:
            body.append(f'    <circle cx="{sh["cx"]:g}" cy="{sh["cy"]:g}" r="{sh["r"]:g}" '
                        f'fill="{color}"/>')

    plate_rect = ""
    if mode == "plate":
        plate_rect = (f'  <rect x="{PLATE_INSET}" y="{PLATE_INSET}" width="{CANVAS - 2 * PLATE_INSET}" '
                      f'height="{CANVAS - 2 * PLATE_INSET}" rx="{PLATE_RADIUS}" fill="{preset["fill"]}"/>\n')

    note = ("solid plate + reversed-out glyph" if mode == "plate"
            else "glyph only on transparent background")
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<!--
  Y-Hub app icon — generated by gen_app_icons.py; rerun the script instead of hand-editing.

  Layout: {note}.
  Plate: {plate} ({preset["fill"]}) rounded rect, inset {PLATE_INSET}, radius {PLATE_RADIUS}.
  Glyph: three cells in a Y topology — Y-Hub's own geometry (no third-party shape), defined once in
  yhub-icon-mono.svg, scaled to {CONTENT:.0%} of the canvas and centred on its measured ink bbox.
-->
<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {CANVAS} {CANVAS}" role="img" aria-label="Y-Hub">
{plate_rect}  <g transform="translate({tx:.2f} {ty:.2f}) scale({k:.4f})">
{chr(10).join(body)}
  </g>
</svg>
'''


def build_favicon(shapes: list[dict]) -> str:
    """标签页图标：单色件 + prefers-color-scheme 双色（标签栏没有宿主 CSS 可继承，只能写在文件里）。

    媒体查询写在以类名作用域的 <style> 里，不用 :root/svg 选择器——这份文件若被内联进
    别的页面，作用域外的规则不会漏进宿主文档（源文件 README §2 的顾虑）。
    """
    body = "\n".join(
        (f'    <rect x="{sh["x"]:g}" y="{sh["y"]:g}" width="{sh["w"]:g}" height="{sh["h"]:g}" rx="{sh["rx"]:g}"/>'
         if sh["kind"] == "rect" else
         f'    <circle cx="{sh["cx"]:g}" cy="{sh["cy"]:g}" r="{sh["r"]:g}"/>')
        for sh in shapes)
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<!--
  Y-Hub favicon — generated by tauri/icons/source/yhub/gen_app_icons.py.

  Three cells + one dot (the same geometry as the app icon), monochrome currentColor, with a
  prefers-color-scheme override: the browser tab bar has no host CSS to inherit from, so this is
  the one place the light/dark pair has to be decided inside the file.
  light tabs #4E7A5C (4.85:1 on #FFFFFF) / dark tabs #9CC3A6 (8.7:1 on #1C1C1C)
-->
<svg xmlns="http://www.w3.org/2000/svg" class="yhub-favicon" width="24" height="24" viewBox="0 0 24 24" fill="none" color="#4E7A5C" role="img" aria-label="Y-Hub">
  <style>.yhub-favicon{{color:#4E7A5C}}@media (prefers-color-scheme:dark){{.yhub-favicon{{color:#9CC3A6}}}}</style>
  <g fill="currentColor">
{body}
  </g>
</svg>
'''


# ---------------------------------------------------------------- 出图

class Renderer:
    """按目标像素出图：大尺寸走渐变母版缩放，小尺寸走单色直接矢量出图。"""

    def __init__(self, plate: str, shapes: list[dict], box: tuple[float, float, float, float]):
        self.plate, self.shapes, self.box = plate, shapes, box
        self.master_svg = build_svg(plate, "plate", shapes, box)
        self._master: Image.Image | None = None

    def master(self) -> Image.Image:
        if self._master is None:
            with tempfile.TemporaryDirectory() as td:
                self._master = chrome_render(self.master_svg, CANVAS, Path(td) / "master.png")
        return self._master

    def at(self, size: int) -> Image.Image:
        if size <= SMALL_PX:
            with tempfile.TemporaryDirectory() as td:
                return chrome_render(build_svg(self.plate, "flat", self.shapes, self.box, size),
                                     size, Path(td) / f"flat{size}.png")
        m = self.master()
        return m.copy() if size == CANVAS else m.resize((size, size), Image.Resampling.LANCZOS)


def write_icns(renders: dict[int, Image.Image], master: Image.Image, out: Path) -> None:
    """iconutil 只吃 .iconset 目录；小尺寸用单色那份，大尺寸用母版缩。"""
    with tempfile.TemporaryDirectory() as td:
        iconset = Path(td) / "yhub.iconset"
        iconset.mkdir()
        for name, px in ICNS.items():
            im = renders.get(px) or (master if px == CANVAS else master.resize((px, px), Image.Resampling.LANCZOS))
            im.save(iconset / name)
        r = subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out)],
                           capture_output=True, text=True)
    if r.returncode != 0 or not out.exists():
        raise RuntimeError(f"iconutil 失败：{r.stderr[-400:]}")


def write_sheet(renderer: Renderer, out: Path) -> None:
    """底板/尺寸对比图：两种底板 × 四个尺寸，浅底与深底各画一遍（给人眼选底板）。"""
    cell, pad, top = 200, 24, 30
    sizes = (256, 64, 32, 16)
    bgs = [(255, 255, 255), (28, 28, 28)]
    w = pad + len(sizes) * cell
    h = top + len(PLATES) * len(bgs) * (cell + top)
    sheet = Image.new("RGB", (w, h), (240, 240, 240))
    d = ImageDraw.Draw(sheet)
    y = top
    for plate in PLATES:
        r = Renderer(plate, renderer.shapes, renderer.box) if plate != renderer.plate else renderer
        for bg in bgs:
            fg = (0, 0, 0) if sum(bg) > 384 else (255, 255, 255)
            d.rectangle([0, y - top, w, y + cell + top - 1], fill=bg)
            d.text((pad, y - top + 9), f"plate={plate}  bg={'#FFFFFF' if fg == (0, 0, 0) else '#1C1C1C'}", fill=fg)
            for i, px in enumerate(sizes):
                im = r.at(px).convert("RGB")
                # 小尺寸件是透明底的单色图形：贴到它预期会被放上去的底色上再对比
                if px <= SMALL_PX:
                    on = Image.new("RGB", im.size, PLATES[plate]["on"])
                    on.paste(im, (0, 0), r.at(px).getchannel("A"))
                    im = on
                x = pad + i * cell + (cell - px) // 2
                sheet.paste(im, (x, y + (cell - px) // 2))
                d.text((pad + i * cell, y + cell - 14), f"{px}px{'' if px > SMALL_PX else ' mono'}", fill=fg)
            y += cell + top
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    print(f"  对比图 → {out}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plate", choices=sorted(PLATES), default="light")
    ap.add_argument("--sheet", type=Path, help="顺带出一张底板/尺寸对比图")
    ap.add_argument("--dry-run", action="store_true", help="只算不写")
    a = ap.parse_args()

    shapes = glyph_shapes()
    box = glyph_bbox_units()
    print(f"几何：{len(shapes)} 个形状，ink bbox = [{box[0]:.2f}, {box[1]:.2f}, {box[2]:.2f}, {box[3]:.2f}]"
          f"（24 单位，占比 {(box[2] - box[0]) / 24:.1%} × {(box[3] - box[1]) / 24:.1%}）")
    r = Renderer(a.plate, shapes, box)
    master = r.master()
    print(f"母版 {master.size} {measure(master)}")

    if a.sheet:
        write_sheet(r, a.sheet)

    if a.dry_run:
        print(f"[dry-run] 将写：{APP_SVG} {APP_PNG} {ICONS}/*.png {ICONS}/icon.icns "
              f"{ICONS}/icon.ico {FAVICON}")
        for px in sorted(PNG_SET):
            print(f"  {px}px {measure(r.at(px))}")
        return 0

    APP_SVG.write_text(r.master_svg, encoding="utf-8")
    master.save(APP_PNG)
    renders = {px: r.at(px) for px in PNG_SET}
    for px, name in PNG_SET.items():
        renders[px].save(ICONS / name)
    renders[256].save(ICONS / "128x128@2x.png")
    master.save(ICONS / "icon.png")
    write_icns(renders, master, ICONS / "icon.icns")
    master.save(ICONS / "icon.ico", format="ICO",
                sizes=[(s, s) for s in ICO_SIZES],
                append_images=[r.at(s) for s in ICO_SIZES])
    FAVICON.write_text(build_favicon(shapes), encoding="utf-8")

    print(f"写出（底板={a.plate}）：")
    for px, name in sorted(PNG_SET.items()):
        print(f"  {name:<14} {measure(renders[px])}")
    print(f"  {'128x128@2x.png':<14} {measure(renders[256])}")
    print(f"  {'icon.png':<14} {measure(master)}")
    print(f"  {'icon.icns':<14} {(ICONS / 'icon.icns').stat().st_size} bytes")
    print(f"  {'icon.ico':<14} {(ICONS / 'icon.ico').stat().st_size} bytes")
    print(f"  app-icon.svg / app-icon.png / web/public/favicon.svg")
    return 0


if __name__ == "__main__":
    sys.exit(main())
