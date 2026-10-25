# Observatory zodiac ring as vector glyphs — plan (2026-10-23, rev 2 — implemented 2026-10-24)

## Status (2026-10-24, build 2.1.23, uncommitted)

Implemented with option **B** (hand-drawn strokes), green: tsc clean, 8996
vitest tests (4 new). Verified headless against the dist server, before vs
after, at 1280×800 @1×, 3840×2160 @1× and 1920×1080 @2× — same positions,
crisp strokes at 4K (`2026-10-23-zodiac-glyphs/verify-*.png`).

- `src/observatory/zodiac-glyphs.ts` — the 12 glyphs (40 paths), slot order,
  `ZODIAC_RING_R = 237`, `drawZodiacRing()`.
- `src/observatory/main-dial.ts` — step 4 calls `drawZodiacRing(ctx, cx, cy,
  L.zD / 526)`; `zodiac.png` import and loader removed (sun and
  constellation-name images keep the readiness gate).
- `src/observatory/__tests__/zodiac-glyphs.test.ts`.
- Authoring harness and data in `planning/2026-10-23-zodiac-glyphs/`:
  `glyphs-2x-frame.js` (authored shapes), `fit1x.py` (per-glyph fit to the
  1× PNG → `glyphs-1x-frame.js`, the source of the TS module), `contact.html`
  (review sheet), `skel.py`/`fit.py` (skeleton maps and coverage scores).

Decisions taken during the work:
- The PNG glyphs are **not** Apple Symbols (compared side by side), so the
  artwork itself was the only reference; `zodiac@2x.png` is a separate ~1.2×
  larger, offset rendering, used for shapes only, then fitted to the 1× file.
- Strokes are drawn **opaque** in `rgb(144,144,144)` (= 50 % white over the
  dial's 12.5 %-white-on-black) so self-crossings don't double up — Steve's
  call. Stroke weight varies per sign as in the artwork (Sagittarius 2.7,
  Leo 1.5 units at s = 1).
- Pisces tips, Scorpius arrow, Virgo bowl/foot and Taurus (½ unit down)
  tuned on review.

## 1. Why the symbols are fuzzy

`src/observatory/main-dial.ts` step 4 draws the whole zodiac ring as one
bitmap: `.observatory-ref/Resources/zodiac.png`, 526×526 px, RGBA, 14 KB,
stretched to `L.zD = 526·s` CSS px at `globalAlpha 0.5` (iOS parity:
EOShuffleView.mm L106–112). `s = mainR / 365`, and the static cache draws
under a `dpr` scale, so the bitmap is upscaled by `s · dpr`:

| window                      | mainR | s    | zD (device px) | upscale |
|-----------------------------|-------|------|----------------|---------|
| 1280×800 @1×                | ~332  | 0.91 | ~478           | 0.9×    |
| 4K 3840×2160 @1×            | ~896  | 2.46 | ~1292          | 2.5×    |
| Retina 1920×1080 CSS @2×    | ~448  | 1.23 | ~1290          | 2.5×    |
| 5K / 4K-at-2× fullscreen    | ~896  | 2.46 | ~2580          | 4.9×    |

Every glyph is only ~25 px tall in the source, so at 4K it is a 2.5–5×
blow-up of a 25-px raster — hence fuzzy. Nothing else is wrong: the ring
is positioned and oriented correctly.

What the PNG actually contains (decoded pixel-by-pixel, scratch script
`zpng.py` / `zink.py`): twelve white glyphs, nothing else. The faint second
set of small dark symbols visible in `zodiac@2x.png` does **not** exist in
the 1× file the web app uses (its only dark pixels are anti-aliasing fringe
at the same twelve angles). The @2x file is RGB with a black background and
is not referenced by the web code; ignore it.

Measured geometry at reference scale (s = 1, centre at 263,263):

| slot | sign        | angle (cw from top) | ink radius     | ink height | half-width |
|------|-------------|---------------------|----------------|------------|------------|
| 0    | ♓ Pisces    | 0°                  | 227.1 – 252.2  | 25.0       | 10.6       |
| 1    | ♒ Aquarius  | 30°                 | 233.0 – 247.0  | 14.0       | 12.7       |
| 2    | ♑ Capricorn | 60°                 | 226.0 – 251.9  | 25.9       | 12.3       |
| 3    | ♐ Sagittar. | 90°                 | 227.3 – 252.2  | 24.9       | 12.9       |
| 4    | ♏ Scorpius  | 120°                | 221.6 – 249.6  | 28.0       | 14.2       |
| 5    | ♎ Libra     | 150°                | 223.5 – 245.1  | 21.6       | 12.9       |
| 6    | ♍ Virgo     | 180°                | 221.0 – 252.2  | 31.1       | 14.1       |
| 7    | ♌ Leo       | 210°                | 220.8 – 246.6  | 25.8       | 10.3       |
| 8    | ♋ Cancer    | 240°                | 222.6 – 245.6  | 23.0       | 12.1       |
| 9    | ♊ Gemini    | 270°                | 226.1 – 251.3  | 25.2       | 13.2       |
| 10   | ♉ Taurus    | 300°                | 225.9 – 251.9  | 26.0       | 11.9       |
| 11   | ♈ Aries     | 330°                | 225.7 – 252.0  | 26.2       | 13.7       |

Angular offsets from the slot centre are all under 0.5°. The order is the
iOS text string `♓,♒,♑,♐,♏,♎,♍,♌,♋,♊,♉,♈` read clockwise from the top
(EOShuffleView.mm L114, the commented-out `drawDialNumbersDemiRadial` call at
font size 36 that the PNG replaced). Orientation is demi-radial: the top
half reads outward-up, the bottom half (slots 4–8) is flipped 180° so it
reads upright — the same convention as `demiRadialTextCenter` in
`draw-utils.ts`. Outer ink edge ≈ 252 = zR − 20 on the top half. Alpha:
glyph core 255 × globalAlpha 0.5 → effective 50 % white.

The PNG glyph shapes match **Apple Symbols** (iOS's fallback for Arial at
those code points — compare the scratch render `glyphs.png`). Apple's font
licence does not allow shipping those outlines, so an exact re-creation
from the same font is off the table.

## 2. Why not just `fillText('♓')`

Runtime text is platform-dependent and, worse, emoji-prone: with
`'Arial'`, `'Times New Roman'` or `'Hiragino Sans'` Chrome on this Mac
falls through to Apple Color Emoji for U+2648–U+2653 (purple tiles —
see `glyphs.png`). Only `'Apple Symbols'` and `'Menlo'` render text
glyphs, and neither exists on Windows/Android. That is presumably why the
PNG exists. Vector paths are deterministic everywhere.

## 3. Proposal: twelve `Path2D` glyphs, filled at device resolution

### 3.1 Glyph source — Steve picks (see §7)

**A. Outlines from an open-licence font (recommended).** Extract the
twelve glyph outlines once, with a small Node script using `opentype.js`
(npm, v2.0.0), into a checked-in TypeScript module of SVG path strings.
Candidates, both reachable and both licence-clean for embedding:

- *DejaVu Sans* — Bitstream Vera licence (free to embed, modify,
  redistribute, attribution in source). `DejaVuSans.ttf` from the npm
  package `dejavu-fonts-ttf@2.37.3` via jsdelivr, ~757 KB. Geometric,
  slightly heavier strokes.
- *Noto Sans Symbols* — SIL OFL 1.1. npm `@fontsource/noto-sans-symbols@5.3.0`
  (WOFF, which opentype.js parses), a few hundred KB. Lighter, closer in
  weight to the current PNG.

The font file is a build-time input only: it is **not** committed. The
extraction script, the font's name/version/URL, and the licence notice
are committed alongside the generated module, so the paths are
reproducible. Look changes from Apple Symbols' calligraphic strokes to the
chosen font's sans design — a visible but modest restyle at the ring.

**B. Hand-authored monoline strokes matching the current look.** Twelve
open SVG subpaths (`M`/`L`/`C`/`A`) drawn by me from the PNG as a guide,
stroked with round caps/joins at ~2.2·s px. Keeps the calligraphic
character, needs no download and no licence note (typeface designs are
not copyrightable; only font software is). Risk is fidelity: each glyph
has to be eyeballed against the PNG overlay, and a few (♏ ♍ ♐ tails,
♒ waves) will take iteration. I would show an overlay contact sheet
before wiring it in.

**C. Trace the PNG (potrace) — rejected.** Source glyphs are 25 px tall;
tracing gives lumpy curves that still look wrong at 4K.

### 3.2 Rendering (same for A or B)

New module `src/observatory/zodiac-glyphs.ts`:

```ts
export interface ZodiacGlyph { name: string; d: string; /* SVG path, units of a 1000-unit em */ 
                               bbox: { x0: number; y0: number; x1: number; y1: number } }
export const ZODIAC_GLYPHS: readonly ZodiacGlyph[]  // slot order ♓ ♒ ♑ ♐ ♏ ♎ ♍ ♌ ♋ ♊ ♉ ♈
```

`main-dial.ts` step 4 becomes:

- `Path2D` built once per glyph (module-level cache; `Path2D` exists in
  every browser we target and is absent only in jsdom, so guard for tests).
- For slot `i`: centre from `demiRadialTextCenter(cx, cy, i, 12, R, R, halfH)`
  with `R = 252·s` (measured outer ink edge) and `halfH` = that glyph's
  own ink half-height at the drawn scale, so each glyph's outer edge lands
  where the PNG's does; rotate by `angle + π/2 (+ π on the bottom half)` —
  identical convention to the numerals.
- Scale: one common factor `k = 36·s / unitsPerEm` (iOS `zodiacFontSize`)
  for option A, so relative glyph sizes stay as the font designed them;
  for option B the paths are authored directly in the PNG's 526-unit
  space and scaled by `s`.
- Fill (A) or stroke (B) in `rgba(255,255,255,0.5)` — the PNG's effective
  value. One knob.
- Remove the `zodiac.png` import, the `zodiacImg` loader, and its branch
  in `areDialImagesReady`/`waitForImages` (sun and constellation images
  keep those). Bundle shrinks ~19 KB (data URL).

Because the static cache's context is already scaled by `dpr`, path
fills rasterise straight to device pixels: crisp at 1×, 2×, 4K, 8K,
with no image load and no async gap at first paint.

### 3.3 What does not change

Positions, order, orientation, alpha, `L.zD`/`L.zR`/`zodiacFontSize`
(layout untouched — the snapshot test `observatory-layout.test.ts.snap`
stays green), the 12-hour golden numerals that share the ring, and the
iOS 1-px draw offset (which the web already ignores).

## 4. Steps

1. (A only) Fetch the chosen font into the scratchpad, `npm i opentype.js`
   there, write `scripts/extract-zodiac-glyphs.mjs` → emits
   `src/observatory/zodiac-glyphs.ts` with path `d`, bbox, unitsPerEm,
   font name/version/licence header.
   (B only) Author `zodiac-glyphs.ts` by hand; render a contact sheet
   over the PNG for review before step 2.
2. Rewrite step 4 of `drawMainDial` as in §3.2; drop the PNG import and
   loader branch.
3. Unit test (vitest, jsdom): 12 entries, slot order, every `d` parses
   (regex over the command grammar), bboxes sane. Cheap, guards the
   generated file.
4. `tsc`, `vitest run`, `./build.sh`.
5. Verify (§5), then tune the one alpha knob if the ring reads lighter or
   heavier than before.

## 5. Verification

Headless Chrome against the dist server (memory: "Headless dist-page
screenshots"), seeded location, three sizes, before (git stash) vs after:

- 1280×800 @1× — must look the same as today to a casual eye.
- 3840×2160 @1× and 1920×1080 `--force-device-scale-factor=2` — the 4K
  cases; crop the ring at 100 % and compare edge sharpness.
- Per-glyph ink extents at s = 1 re-measured with `zink.py` on the
  screenshot and compared to the table in §1 (target: outer edge within
  ~1 px, angular offset < 0.5°).
- Console clean; `areDialImagesReady` path still gates the sun/constellation
  images; first paint has no blank ring.

## 6. Out of scope (same disease, separate decisions)

Still bitmaps that upscale at 4K: `sun.png` (100 px) at the dial centre,
the sidereal constellation-names overlay (298 px @2x), and the seven planet
icons in `planet-hands.ts`. The constellation names could become drawn
text like the numerals; the sun and planets are shaded art and would need
new masters. Not touched here.

## 7. Decisions needed

1. Glyph source: **A** (font outlines; DejaVu Sans or Noto Sans Symbols —
   say which, or I render both for a side-by-side first) or **B**
   (hand-drawn monoline strokes keeping the Apple Symbols look).
2. For A: OK to download the font file(s) named in §3.1 into the
   scratchpad for extraction (not committed).
