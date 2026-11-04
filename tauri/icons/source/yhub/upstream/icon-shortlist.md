# Y-Hub icon candidate shortlist — "gem + sparkle" among open-source icons

> **Naming retired**: the "Zhuó" and "Mó" below are the etymology of **old names**, and are retired along with the final naming (current naming is in the "Naming" section of the root `README.md`);
> the paragraphs that use them to describe shape trade-offs are kept only as a design-history record.

Downstream step: composite the final icon from this shortlist; the color parameters are in `obsidian-color-spec.md` (same directory).

Conclusion up front: **#1 recommendation is `reicon:gem-sparkle-filled` (MIT)** — it holds both halves of this gem at once: the gem body is what gets carved (zhuó),
and the four-pointed sparkle beside it is the light produced by polishing (mó); the solid silhouette still reads as "a glowing gem" at 16px in a menu bar, making it
the most legible at small size in this round of measurement; MIT licensed, native 24×24 grid, `currentColor` coloring, so it can be vendored straight into the repository and recolored.

---

## 1. Overall ranking

| Rank | Iconify id | Library | License | Native grid | Style | Why it ranks here |
|---|---|---|---|---|---|---|
| **1** | `reicon:gem-sparkle-filled` | Reicon | MIT | 24×24 | solid fill | gem + sparkle, clearest at 16px in measurement, both halves of the meaning present |
| 2 | `material-symbols:diamond-shine` | Material Symbols | Apache-2.0 | 24×24 | solid fill | gem + three flashes; cleanest geometry, most stable maintainer |
| 3 | `reicon:gem-sparkle` | Reicon | MIT | 24×24 | stroke 1.5 | the stroked version of the same idea, suited to inline body text/lists |
| 4 | `lucide:gem` | Lucide | ISC | 24×24 | stroke 2 | the safest generic gem; lacks the "polish" hint, you must add the sparkle yourself |
| 5 | `tabler:chisel` | Tabler | MIT | 24×24 | stroke 2 | the only literal "zhuó"; blurs into a blob at 16px, only fit as a secondary mark at large sizes |

Every candidate SVG is a 24×24 viewBox with `currentColor` and can be pasted directly.

---

## 2. Candidate by candidate

### #1 `reicon:gem-sparkle-filled` — MIT

- Iconify: https://iconify.design/icon-sets/reicon/gem-sparkle-filled.html
- Source repository: https://github.com/dqev/reicon (LICENSE verified as MIT, see §4)
- Source file (as fetched for measurement): `https://api.iconify.design/reicon/gem-sparkle-filled.svg?height=24&width=24`
- What it reads as: a solid gem, one four-pointed sparkle at the top right, one tiny highlight dot at the top left. The sparkle is the only element that states "polished/glowing".
- Implementation: native 24×24, pure `fill="currentColor"`, zero-cost recoloring; at small size it can be used directly as a macOS template icon.

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="currentColor"><path d="M21.346 3.094L20 2.642l-.45-1.357c-.145-.438-.866-.438-1.012 0l-.45 1.357l-1.345.452a.538.538 0 0 0 0 1.02l1.346.452l.45 1.357a.533.533 0 0 0 1.01 0l.45-1.357l1.346-.452a.538.538 0 0 0 .001-1.02M2.333 4a1 1 0 1 0 0-2a1 1 0 0 0 0 2"/><path fill-rule="evenodd" d="M7.215 3.333c-.647 0-1.271.27-1.714.739L2.297 7.48a2.31 2.31 0 0 0-.164 2.979l7.991 10.608c.447.593 1.13.933 1.876.933c.745 0 1.43-.34 1.876-.933l7.99-10.608c.33-.437.483-.956.466-1.469a1 1 0 0 0-1-.99H16.53l-2.15-4.129a1 1 0 0 0-.888-.538zm4.784 15.207L14.577 10H9.42zM7.213 5.333c-.097 0-.19.04-.256.11L4.553 8h2.915l1.39-2.667z" clip-rule="evenodd"/></g></svg>
```

### #2 `material-symbols:diamond-shine` — Apache-2.0

- Iconify: https://iconify.design/icon-sets/material-symbols/diamond-shine.html
- Source repository: https://github.com/google/material-design-icons (Apache-2.0)
- Source file: `https://api.iconify.design/material-symbols/diamond-shine.svg?height=24&width=24`
- What it reads as: a crown trapezoid + pavilion triangle form the gem, with three "flash" strokes above (a small diamond on each side + one vertical stroke in the middle).
- Trade-off: geometry is tidier than #1 and less brandy (it looks like a system icon); the three flashes merge into a gray blob at 16px, so at small sizes it is best to keep only the gem body.

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M4.575 7L2.45 4.875l1.425-1.4L6 5.6zM11 5V2h2v3zm8.375 2L17.95 5.575l2.125-2.125L21.5 4.875zM12 22l-8.075-8h16.15zM8 7h8l4.1 5H3.9z"/></svg>
```

### #3 `reicon:gem-sparkle` — MIT

- Iconify: https://iconify.design/icon-sets/reicon/gem-sparkle.html
- Source file: `https://api.iconify.design/reicon/gem-sparkle.svg?height=24&width=24`
- What it reads as: the stroked version of #1's composition (gem outline + facet lines + sparkle + small top-left highlight dot).
- Trade-off: `stroke-width="1.5"`, so at 16px the stroke is only about 1px, thinner than Lucide's 2; suited to inline UI rather than a menu-bar silhouette.

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21.331 9c.017.3-.07.6-.263.857l-7.99 10.608a1.352 1.352 0 0 1-2.155 0L2.932 9.857a1.31 1.31 0 0 1 .093-1.693l3.206-3.408c.254-.27.61-.424.984-.424h6.278M2.737 9h18.594"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10.507 4.333L8.076 9l3.61 11.964m1.807-16.631L15.924 9l-3.61 11.964"/><path fill="currentColor" d="M2.333 4a1 1 0 1 0 0-2a1 1 0 0 0 0 2m19.013-.906L20 2.642l-.45-1.357c-.145-.438-.866-.438-1.012 0l-.45 1.357l-1.345.452a.538.538 0 0 0 0 1.02l1.346.452l.45 1.357a.533.533 0 0 0 1.01 0l.45-1.357l1.346-.452a.538.538 0 0 0 0-1.02z"/></g></svg>
```

### #4 `lucide:gem` — ISC

- Iconify: https://iconify.design/icon-sets/lucide/gem.html
- Source repository: https://github.com/lucide-icons/lucide (LICENSE verified as ISC, see §4)
- Source file: `https://api.iconify.design/lucide/gem.svg?height=24&width=24`
- What it reads as: a clean multi-faceted gem outline (crown, table, pavilion), with no sparkle and no motion.
- Trade-off: the steadiest at small size in this round of measurement, with the largest ecosystem and the most "safe"; but it only says "gem", not "polished", and it is the most overused gem icon on the web, so it has the lowest recognizability. To use it you have to add a sparkle yourself.

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M10.5 3L8 9l4 13l4-13l-2.5-6"/><path d="M17 3a2 2 0 0 1 1.6.8l3 4a2 2 0 0 1 .013 2.382l-7.99 10.986a2 2 0 0 1-3.247 0l-7.99-10.986A2 2 0 0 1 2.4 7.8l2.998-3.997A2 2 0 0 1 7 3zM2 9h20"/></g></svg>
```

### #5 `tabler:chisel` — MIT

- Iconify: https://iconify.design/icon-sets/tabler/chisel.html
- Source repository: https://github.com/tabler/tabler-icons (MIT)
- Source file: `https://api.iconify.design/tabler/chisel.svg?height=24&width=24`
- What it reads as: a chisel set at an angle (blade at the top left, rounded handle at the bottom right), with a small cut-out in the middle.
- Trade-off: **this is the only UI icon in all open-source libraries that draws a "chisel" directly** (see §3: `chisel` returns only 2 results across all of Iconify), the most literal match for "zhuó";
  but at 16px the outline and the cut-out eat into each other, and in measurement it reads as "a diagonal line plus a small dot". Recommend using it only as a large-size secondary mark / an about-page illustration, not as a menu-bar icon.

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m14 14l1.5 1.5m2.847.075l2.08 2.079a1.96 1.96 0 0 1-2.773 2.772l-2.08-2.079a1.96 1.96 0 0 1 2.773-2.772M3 6l3-3l7.414 7.414A2 2 0 0 1 14 11.828V14h-2.172a2 2 0 0 1-1.414-.586z"/></svg>
```

---

## 3. How these were found (reproducible)

Everything went through the Iconify HTTP API; not one link is invented.

**Search** (`limit=64`, fetched term by term, raw JSON stored in `build/icons/search_*.json` / `s2_*.json` / `s3_*.json`):

```
https://api.iconify.design/search?query=<term>&limit=64
```

Terms queried: carve, chisel, hammer, mallet, gem, diamond, jewel, polish, sparkle, refine, brush, sculpt,
craft, anvil, whetstone, engraving, stone, sharpening, grindstone, hand-craft, handyman, knife-sharpener,
gem-stone, pencil-ruler, diamond-shine, chisel-tool, hammer-and-chisel, crafting, diamond-cut, gem-cutting,
cut-diamond, jade, carving, engraving, hone, sharpen, grind, sculpture, polish-shine, shine, polishing-tool,
craft-tool, artisan, handmade, lapidary, jeweler, gem-cutter, gem-cutting-tool, cutting-gem, crystal, gemstone,
amethyst, quartz, diamond-sparkle, gem-sparkle, jewelry-gem

**Key finding — the "carving" half is nearly empty in the icon libraries:**

| Query | Hits across all of Iconify | Result |
|---|---|---|
| `chisel` | **2** | `tabler:chisel`, `game-icons:chisel` |
| `carve` | **1** | `mdi:pumpkin-carved` (a jack-o'-lantern, irrelevant) |
| `carving` / `engraving` / `whetstone` / `sharpening` / `grindstone` | **0** | — |
| `sharpen` | 2 | `griddy-icons:knife-sharpener(-filled)` |
| `sculpture` | 8 | 6 are the same image at different weights from `iconmind:sculpture-*` |
| `lapidary` / `jeweler` / `gem-cutter` | **0** | — |
| `gem` | 64+ | a large number of duplicated generic gems |
| `polish` | 57 | almost all "nail polish" |

**Fetching icons**: `https://api.iconify.design/<prefix>/<name>.svg?height=24&width=24`, and for the raw path
`https://api.iconify.design/<prefix>.json?icons=<name>`.

**Checking licenses**: `https://api.iconify.design/collections?prefixes=tabler,lucide,...` for Iconify's labels,
then go back to the source repository to verify (§4).

**Legibility measurement**: render the candidates into HTML, take headless Chrome screenshots (`--force-device-scale-factor=6`, so that 16px is upscaled enough to see pixels),
then judge them image by image. Evidence images:
`build/contact-sheet.png` (22 candidates @96px, once each on a dark and a light background), `build/size-sheet-3x.png` (8 candidates @16/22/32/48),
`build/small-test.png` (7 candidates @16/22, 6× upscale), `build/final-verify.png` (the 5 delivered SVGs loaded standalone as `<img>` + purple inline).

Measured 16px menu-bar legibility ranking (best→worst):
`reicon:gem-sparkle-filled` > `material-symbols:diamond-shine` > `reicon:gem-sparkle` > `hugeicons:gem` >
`lucide:gem` > `tabler:chisel` > `game-icons:cut-diamond` (its facet lines all mush together at 16px).
Of these, only the top three still read as both "gem" and "glowing" at 16px.

---

## 4. License verification (each checked against the source repository, not copied from Iconify's labels)

| Library | Repository | License | How verified |
|---|---|---|---|
| Reicon | https://github.com/dqev/reicon | **MIT** | GitHub API `license=MIT`; first line of `LICENSE` is `MIT License / Copyright (c) 2025 REICON` |
| Material Symbols | https://github.com/google/material-design-icons | **Apache-2.0** | GitHub API `license=Apache-2.0` |
| Lucide | https://github.com/lucide-icons/lucide | **ISC** | GitHub API reports `NOASSERTION`, so read `LICENSE`: first line is `ISC License` |
| Tabler | https://github.com/tabler/tabler-icons | **MIT** | GitHub API `license=MIT`; first line of `LICENSE` is `MIT License / Copyright (c) 2020-2026 Paweł Kuna` |
| Game Icons | https://github.com/game-icons/icons | **CC BY 3.0** (individual icons may also be CC0) | GitHub API reports `NOASSERTION`, read `license.txt`: `Icons provided under the Creative Commons 3.0 BY or CC0 if mentioned below` |

The rejected `game-icons:chisel` / `game-icons:cut-diamond` are CC-BY-3.0, and their attribution authors can be looked up in the repository tree:
`delapouite/chisel.svg` (Delapouite), `lorc/cut-diamond.svg` (Lorc). CC-BY requires visible attribution in the product,
which is an extra burden for an "app icon" — that is the secondary reason they did not make the top five (the main reason is that they blur at small size).

---

## 5. Considered and rejected

| Icon | Why it was rejected |
|---|---|
| `game-icons:cut-diamond` (CC-BY-3.0, Lorc) | the most literal "cut gem", but the facet lines are too dense and it becomes one blob at 16px; also CC-BY requires attribution |
| `game-icons:chisel` (CC-BY-3.0, Delapouite) | the only image of "a chisel chiseling with wood chips flying", the most dynamic; but it has too much detail, falls apart at small size, and carries an attribution burden |
| `tabler:hammer` / `lucide:hammer` / `ph:hammer` | a hammer reads as "repair/construction", which is not the same thing as "carving" |
| `icon-park-outline:hammer-and-anvil` / `material-symbols:handyman` | an anvil/a tool set reads as "workshop", completely unreadable at 16px |
| `griddy-icons:knife-sharpener` (MIT) | literally "mó" — a honing rod; but at 16px it is a pile of crossing diagonals, and it looks like a knife rather than polishing |
| `iconmind:sculpture-outline-regular` | a portrait bust on a pedestal, reads as "museum/sculpture", not "carving" |
| `glyphs:mallet` | a wooden mallet, 80×80 grid, and a mallet reads more like an "auction gavel" |
| `lucide:stone` / `game-icons:stone-crafting` / `game-icons:stone-bust` | stone/pickaxe → reads as "quarrying/mining" |
| `lucide:sparkles` / `tabler:sparkle` | light only, no gem; and sparkles is by now the generic symbol for "AI features", so it is easily misread |
| `reicon:pen-sparkle` | pen + sparkle, reads as "AI writing" |

---

## 6. Notes for the compositing step

1. **Do not let gem + purple = Obsidian**. Obsidian's official mark is itself a flat purple gem (`#6C31E3`),
   and this project's color spec also comes from Obsidian. If it is to "not look like a copy of Obsidian", separate it by **silhouette difference**:
   keep #1's **four-pointed sparkle** and give the gem asymmetric facets; do not make a symmetrical Obsidian-style gem outline.
2. **Dare to delete at small sizes**. For the menu-bar template image (16–22px) use only the solid gem body (drop the small top-left highlight dot),
   and add the sparkle back at ≥20px; `material-symbols:diamond-shine`'s three flashes definitely blur at 16px, so don't copy them.
3. **Attribution**. Among the top five, Reicon / Tabler are MIT, Lucide is ISC, Material Symbols is Apache-2.0 —
   all of them only require keeping the copyright and license notice in the distributed artifact (put it in `THIRD-PARTY.md` or on an about page; it need not be exposed in the UI).
   If CC-BY-3.0 Game Icons is used in the end, then **visible attribution** is mandatory (author name + license link).
4. **Delivered SVGs are already on disk** (5 files, all having passed XML parsing + 24×24 viewBox + `currentColor` checks,
   with path data byte-identical to what the Iconify API returns):
   - `build/icon/shortlist/01-reicon-gem-sparkle-filled.svg` — sha256 `f1c7b716539bad42884da34d4f13dd7990668ee56afd7678ff2ffc02ce6f2e85`
   - `build/icon/shortlist/02-material-symbols-diamond-shine.svg` — sha256 `ee1845fd072dfc4a19147083a972ad7c0250368dea66ee3118437f9eeebdaa80`
   - `build/icon/shortlist/03-reicon-gem-sparkle.svg` — sha256 `abe2e6c2cd163dc4b4fac7d4c6a367da32620ded556d63b76070a0b9f1a91625`
   - `build/icon/shortlist/04-lucide-gem.svg` — sha256 `7e5810da91f7c2bd9b133e3b33e4b4d2908bbaf98fcb8682ea8202ff0aa4c0ed`
   - `build/icon/shortlist/05-tabler-chisel.svg` — sha256 `74ea52b875472c7f253da22a0e2463b339ee9bcb02c7c44576435af814d341ab`

---

## 7. Reproduction commands

```bash
# search (example)
curl -s "https://api.iconify.design/search?query=chisel&limit=64"
# licenses
curl -s "https://api.iconify.design/collections?prefixes=tabler,lucide,mdi,reicon,game-icons,material-symbols"
# fetch icon / fetch path
curl -s "https://api.iconify.design/reicon/gem-sparkle-filled.svg?height=24&width=24"
curl -s "https://api.iconify.design/reicon.json?icons=gem-sparkle-filled"
# validate delivered files
cd build/icons/final && for f in *.svg; do xmllint --noout "$f" && grep -q 'viewBox="0 0 24 24"' "$f" && grep -q currentColor "$f" && echo "OK $f"; done
# regenerate the evidence images
cd build/icons && bash make-sheet.sh && bash make-size-sheet.sh && bash make-small-test.sh && bash make-large-sheet.sh && bash make-final-verify.sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=6 --window-size=380,300 \
  --screenshot=<worktree>/build/small-test.png "file://<worktree>/build/small-test.html"
```
