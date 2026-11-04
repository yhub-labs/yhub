# Obsidian icon color reference spec (for the Y-Hub icon)

Purpose: pin down the hard parameters for the "colors + gradient" of the new Y-Hub icon so that it feels like the same family as Obsidian.
Boundary: **use the colors only, do not copy the shape**. Obsidian's gem logo is their trademark; do not reproduce its paths/composition.
All hex values are taken from real assets, sources in §2; measurement method in §6.

Generated: 2026-09-24 20:53 CST (measured against local Obsidian 1.13.7 + live assets)

---

## 1. Quick reference (TL;DR)

| Use | Value |
| --- | --- |
| Monochrome / small size (dark background) | `#A88BFA` |
| Monochrome / small size (light background) | `#6C31E3` |
| Large-size gradient (3 stops) | `#C9B2F5` → `#8A5CF5` → `#5529AE`, direction 225° (bright top right → dark bottom left) |
| Dark-background pairing | background `#1C1C1C` / secondary `#232323`; icon uses `#A88BFA` or the gradient above |
| Light-background pairing | background `#FFFFFF` / secondary `#FAFAFA`; icon uses `#6C31E3` (or `#7852EE`) |
| macOS menu bar / tray | no color: a pure black + alpha template image (the repo already has this approach in `tauri/…/tray-template.png`) |

---

## 2. Sources (all measured, not from memory)

| # | Source | How it was read | Values obtained |
| --- | --- | --- | --- |
| S1 | `https://obsidian.md/images/obsidian-logo-gradient.svg` (asset linked from the official brand page `https://obsidian.md/brand`) | downloaded with `curl`, sha256 `119b01b9…1280` | gem body `fill="#6c31e3"`; plus 8 `radialGradient` white highlights (`stop-color="#fff"`, `stop-opacity` 0.1–0.8) |
| S2 | `https://obsidian.md/favicon.svg` | `curl`, sha256 `70fd49cd…b9fe` | `.purple { fill: #9974F8 }`; `@media (prefers-color-scheme: dark) { .purple { fill: #A88BFA } }` |
| S3 | `https://obsidian.md/images/obsidian-logo-text-purple.svg` (and also `-text-black.svg` / `-text-white-purple.svg`) | `curl`, purple version sha256 `17adb1f9…bef2` | glyph `#A079FF`; black version all `#000`; white-purple version glyph `#A079FF` + text `#FFF` |
| S4 | Inline SVG in the `https://obsidian.md/` home page (the gem with `viewBox="0 0 512 512"`, the horizontal logo with `viewBox="0 0 143 25"`) | `curl` the homepage HTML, then extract the inline SVG with a regex | gem body likewise `#6c31e3`; horizontal logo glyph `#A88BFA`, text `currentColor` |
| S5 | Local `/Applications/Obsidian.app` 1.13.7 → default theme CSS inside `Contents/Resources/obsidian.asar` | extracted the text from the asar, regexed the `.theme-dark` / `.theme-light` blocks | `--accent-h: 258; --accent-s: 88%; --accent-l: 66%` (i.e. `#8A5CF5`); `--color-purple` dark `#a882ff` / light `#7852ee`; base scale (§4) |
| S6 | Local `/Applications/Obsidian.app` 1.13.7 → `Contents/Resources/icon.icns` | `sips` to a 1024×1024 PNG, then per-pixel statistics | backplate vertical gradient `#262626` (top) → `#1A1A1A` (bottom), a `#363636` highlight along the top edge; measured gem purple gradient in §6 |

---

## 3. Color table

| Role | Hex | HSL | Source | Note |
| --- | --- | --- | --- | --- |
| Official gem logo flat fill | `#6C31E3` | hsl(260 76% 54%) | S1, S4 | the **only** purple in the online mark, see §5 |
| favicon light-mode purple | `#9974F8` | hsl(257 90% 71%) | S2 | the only asset examined that switches on `prefers-color-scheme` |
| favicon dark-mode purple | `#A88BFA` | hsl(256 92% 76%) | S2, S4 | also the horizontal logo's glyph color |
| Horizontal logo glyph purple (works on black/white) | `#A079FF` | hsl(257 100% 74%) | S3 | pairs with `#000` or `#FFF` text |
| App primary color (default accent) | `#8A5CF5` | hsl(258 88% 66%) | S5 | the base color of every accent/button in the Obsidian UI |
| App `--color-purple` (dark theme) | `#A882FF` | hsl(258 100% 75%) | S5 | |
| App `--color-purple` (light theme) | `#7852EE` | hsl(255 82% 63%) | S5 | |
| accent hover/brighter (dark theme accent-1 / accent-2) | `#A68AF9` / `#C5B6FC` | — | derived from the S5 formulas `hsl(h-3, s*1.02, l*1.15)` / `hsl(h-5, s*1.05, l*1.29)` | derived values, not asset originals |
| accent hover/brighter (light theme accent-1 / accent-2) | `#9873F7` / `#A68AF9` | — | S5 formulas `hsl(h-1, s*1.01, l*1.075)` / `hsl(h-3, s*1.02, l*1.15)` | derived values |
| Icon backplate (macOS app icon) | `#262626` → `#1A1A1A` | — | S6 | vertical; `#363636` highlight along the top edge |
| App dark backgrounds (base-00 / base-10 / base-30) | `#1C1C1C` / `#232323` / `#333333` | — | S5 `.theme-dark` | |
| App light backgrounds (base-00 / base-10 / base-30) | `#FFFFFF` / `#FAFAFA` / `#E4E4E4` | — | S5 `.theme-light` | |
| Dark theme body-text gray | `#DADADA` | — | S5 `.theme-dark` base-100 | |
| Light theme body-text gray | `#222222` | — | S5 `.theme-light` base-100 | |

The hue band is extremely narrow: every purple above sits at **h ≈ 255–261**. Any new color scheme that lands in this range will not drift off.

---

## 4. Gradient spec (for large sizes)

The official Obsidian mark itself has **no linear gradient** (see §5), so the one below is derived from "the official app accent + the measured light/dark direction of the official macOS icon"; it is **inspiration/reference**, not a copy. Direction is based on measurement: the gem's brightness correlates with `(x − y)` at **+0.60**, i.e. the light source is at the **top right**.

**Direction**: bright at the top right → dark at the bottom left.

SVG (paste as-is; rendering already measured, see below):

```svg
<linearGradient id="yhub-grad" x1="1" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#C9B2F5"/>
  <stop offset="0.5" stop-color="#8A5CF5"/>
  <stop offset="1" stop-color="#5529AE"/>
</linearGradient>
```

CSS equivalent:

```css
background: linear-gradient(225deg, #C9B2F5 0%, #8A5CF5 50%, #5529AE 100%);
```

**Rendered measurement** (Chrome; the SVG above rasterized to 240×240, then pixels sampled):

| Sample position | Measured color | Expected |
| --- | --- | --- |
| top right (0.9, 0.1) | `#BDA1F5` | approaches stop 0 `#C9B2F5` ✓ |
| diagonal midpoint (0.75, 0.25) | `#AA87F5` | between the bright end and the midpoint ✓ |
| exact center (0.5, 0.5) | `#8A5CF5` | exactly the 50% stop ✓ |
| diagonal midpoint (0.25, 0.75) | `#7043D2` | between the midpoint and the dark end ✓ |
| bottom left (0.1, 0.9) | `#6034BD` | approaches stop 1 `#5529AE` ✓ |
| top left (0.1, 0.1) / bottom right (0.9, 0.9) | both `#8A5CF5` | on a 45° gradient the isoline should pass through both points ✓ |

Measured provenance of the stops: `#C9B2F5` ≈ the icon gem's p99 brightness (measured `#CAB5F5`); `#8A5CF5` = the official accent (icon gem median measured `#8858E8`, nearly identical); `#5529AE` ≈ p5 of gem brightness (measured `#5529AD`).

**Do not use the gradient at small sizes**: at ≤24px the three stops squeeze into one patch and it just blurs. Use the flat color from §1 at small sizes.

---

## 5. Flat vs gradient (how the official assets actually use them)

- **The online mark (website / horizontal logo / favicon) is flat color**: `#6C31E3` as a single-color base, then 8 white `radialGradient`s (`stop-color="#fff"`, opacity 0.1–0.8) layered on as gem-facet highlights. Even though the file is named `obsidian-logo-gradient.svg`, the file contains **not a single `linearGradient`** — "gradient" there refers to those white radial highlights.
- **The macOS app icon is a real gradient**: in `icon.icns` the gem's dark end measures `#5125AA` (darker than the flat `#6C31E3`; white highlights cannot darken anything, so the purple itself must be a gradient).
- **Light/dark mode switching is done with a CSS media query**: officially only the favicon implements `prefers-color-scheme`, light `#9974F8` / dark `#A88BFA`; inside the app it is the same accent throughout, with the background swapped via the theme's base scale.

---

## 6. Light / dark usage rules (with measured contrast)

Contrast is computed with the WCAG formula (script in §6), not estimated:

| Foreground | Background | Contrast | Verdict |
| --- | --- | --- | --- |
| `#A88BFA` | `#1C1C1C` | **6.28:1** | first choice on a dark background (text grade) |
| `#A882FF` | `#1C1C1C` | 5.93:1 | acceptable on a dark background |
| `#A079FF` | `#1C1C1C` | 5.42:1 | acceptable on a dark background |
| `#8A5CF5` | `#1C1C1C` | 4.00:1 | usable for shapes/large type on a dark background, not for body text |
| `#6C31E3` | `#1C1C1C` | 2.59:1 | **forbidden on a dark background** (too dark) |
| `#5529AE` | `#1C1C1C` | 1.88:1 | forbidden on a dark background |
| `#6C31E3` | `#FFFFFF` | **6.59:1** | first choice on a light background |
| `#7852EE` | `#FFFFFF` | 4.95:1 | acceptable on a light background |
| `#8A5CF5` | `#FFFFFF` | 4.26:1 | usable on a light background |
| `#9974F8` | `#FFFFFF` | 3.38:1 | only enough for shapes/large type |
| `#C9B2F5` | `#FFFFFF` | 1.88:1 | **forbidden on a light background** (the gradient's bright end only holds on dark) |
| `#8A5CF5` | `#1A1A1A` (icon backplate) | 4.09:1 | usable on the icon backplate |

Rules:

1. **Dark mode**: background `#1C1C1C` (primary) / `#232323` (secondary); use `#A88BFA` for the monochrome icon; if you want a gradient, use the §4 one (its bright end `#C9B2F5` is 9.06:1 on `#1C1C1C`, safe).
2. **Light mode**: background `#FFFFFF` (primary) / `#FAFAFA` (secondary); use `#6C31E3` for the monochrome icon; if you want a gradient on a light background you must push the bright end darker (e.g. `#7852EE → #5529AE`), otherwise the bright end has only 1.88:1 against white and effectively disappears.
3. **Size tiers**: ≤24px flat color; only ≥64px gets the gradient.
4. **macOS tray/menu bar**: a colored icon neither looks like a system icon in the menu bar nor survives the light/dark switch — use a template image (pure black + alpha), which auto-inverts with the system.
5. **Do not use `#6C31E3` on a dark background**: this is the most common failure mode (2.59:1).

---

## 7. Appendix: measurement evidence

**Light/dark direction of the macOS icon gem** (1024×1024, mean per 64px bin of `(x − y)`, n = pixel count):

```
x-y ≈ -447  #7B52CD (n=6905)      ← bottom left, darkest
x-y ≈ -319  #6E43C7 (n=17466)
x-y ≈ -191  #6739C2 (n=21733)     ← darkest band
x-y ≈  -63  #7E58CA (n=13967)
x-y ≈   +1  #AF91EE (n=19905)     ← brightest band
x-y ≈ +129  #A683ED (n=22457)
x-y ≈ +321  #8E63E6 (n=7379)      ← top-right edge
```

Brightness percentiles (gem region, 212,366 pixels): p1 `#5125AA`, p5 `#5529AD`, p25 `#693EC0`, p50 `#8858E8`, p75 `#A987EF`, p95 `#C4ACF4`, p99 `#CAB5F5`, brightest single pixel `#D2BDFE`.

Backplate vertical sampling (x=180): y=150 `#222222` → y=450 `#1F1F1F` → y=750 `#1B1B1B`; center-axis top y=98 `#363636` (top-edge highlight) → y=106 `#262626`.

---

## 8. Three concrete recommendations for Y-Hub

1. Take `#8A5CF5` as the monochrome primary color (the official app accent: 4.00:1 on dark, 4.26:1 on light — neither side is a failure); if you want one color to cover everything and only on dark backgrounds, use `#A88BFA`.
2. For large sizes / the icon, use the 225° three-stop gradient from §4; the direction must be bright top-right → dark bottom-left, otherwise it will not match Obsidian's feel.
3. Pick a separate open-source icon for the shape itself (see the shortlist in `icon-shortlist.md`); **do not** reproduce Obsidian's gem outline; this spec borrows only the colors and the light/dark relationship.

---

## 9. How to reproduce

Live assets: `curl -sSL -o logo-gradient.svg https://obsidian.md/images/obsidian-logo-gradient.svg` (swap the URL the same way for the favicon / horizontal logo).
Local app: `sips -s format png /Applications/Obsidian.app/Contents/Resources/icon.icns --out appicon.png`, then per-pixel statistics; for the theme CSS, search `Contents/Resources/obsidian.asar` for `.theme-dark {` / `.theme-light {` / `--accent-h`.
Gradient validity: drop the §4 SVG into HTML, rasterize it in Chrome, then sample points with `getImageData` (the §4 table is that method's output).
