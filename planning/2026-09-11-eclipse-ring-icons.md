# Eclipse Simulator ring icons — high-res Sun, Moon, Earth-shadow and node markers

> Dated plan, 2026-09-11. Status: ✅ **approved** 2026-09-11 (rev 2 + the Q4
> decision); ✅ **implemented** 2026-09-11, uncommitted. After reviewing the
> renders, Steve picked the NNE ×1.5 Moon and replaced the halo with a mid-gray
> border on the dark parts (Decisions 5–6). Awaiting his visual check. See
> [Implementation notes](#implementation-notes-2026-09-11). Written to be
> self-contained, so it survives conversation compression.
>
> **What changed in rev 2 (after the first review):**
> - Q1–Q3 are decided; see Decisions.
> - The two lunar-node markers are now in scope and measured below.
> - One new question (Q4) about the node design. Now decided: Decision 4.

## Decisions (review of rev 1)

1. **Moon texture.** The lit half shows a roughly equal mix of dark maria and
   bright highlands. I render the **west** and **north-northeast** candidates at
   actual size, and Steve picks one.
2. **Node markers.** In scope.
3. **Halo.** Centre the faint outer halo, which fixes the iOS PSD's half-pixel
   offset.
4. **Node design** (review of rev 2). Reproduce the shipped line-and-arrowhead,
   sharp at every size. Ignore the unshipped Ω/☊ glyph in
   `eclipseRingAscNode@2x.psd`.
5. **Moon pick** (review of the implementation renders). The north-northeast
   half of `moon300.png`, brightened 1.5×.
6. **No halo** (same review). Drop the halo and the lighter rim altogether.
   Instead, draw a mid-gray border on the dark parts only: all of the Earth
   shadow, and the Moon's dark half. Supersedes Decision 3.

## Problem

The five markers on the Eclipse Simulator ring are drawn by
`src/observatory/eclipse-view.ts` (`drawRingHands` / `drawRingMarker`). They are
the iOS @1x PNGs in `src/shared/assets/`, never regenerated:

| Marker | File | Size (px) |
|---|---|---|
| Sun | `eclipseRingSun.png` | 27×27 |
| Moon | `eclipseRingMoon.png` | 20×20 |
| Earth shadow | `eclipseRingEarthShadow.png` | 20×20 |
| Ascending node | `eclipseRingAscNode.png` | 15×15 |
| Descending node | `eclipseRingDesNode.png` | 15×15 |

Each is drawn into a box of `RING_SIZE · s` CSS px, with `s = eclipseR1 / 49`,
so every device scales them up. Sizes below come from the real `computeLayout`
(zero chrome):

| Device (CSS viewport @DPR) | s | Sun (device px) | Moon / shadow (device px) | Nodes (device px) | Upscale |
|---|---|---|---|---|---|
| iPhone SE 375×667 @2 | 0.63 | 34 | 25 | 19 | 1.3× |
| iPhone Pro Max 440×956 @3 | 0.74 | 60 | 45 | 33 | 2.2× |
| iPad 11 portrait @2 | 1.04 | 56 | 42 | 31 | 2.1× |
| MacBook Air window 1470×830 @2 | 1.16 | 63 | 47 | 35 | 2.3× |
| FHD desktop 1920×960 @1 | 1.76 | 48 | 35 | 26 | 1.8× |
| 5K iMac 2560×1300 @2 | 2.31 | 125 | 93 | 69 | 4.6× |
| 6K XDR 3008×1560 @2 | 2.66 | 143 | 106 | 80 | 5.3× |

The iOS `@2x` variants in `.observatory-ref/Resources/` (Sun 52², Moon 34²)
aren't usable either: their sizes are odd, and they're still too small for
desktop. There is no `@2x` node PNG (see the node notes below).

## Decision: render at runtime (recommended) vs. baked data URLs

**Recommendation:** draw the five icons in code into small cached canvases,
at the exact device-pixel size, and pass those canvases to the existing
`drawRingMarker`. The sprites are built on first draw. They are rebuilt only
when `pxPerPt = s · dpr` changes, which happens on resize, rotation, moving to a
display with a different DPR, or browser zoom.

- **Sharp at every size.** The range is 19 to 143 device px, and it changes
  live.
  - A fixed-resolution data URL is either too small for the 5K/6K displays or
    gets shrunk 3–4× on phones.
  - The canvas's default low-quality smoothing aliases when it shrinks an
    image. The Sun's thin points and the 1-pt node lines would shimmer as the
    markers rotate.
  - Rendering at 1:1 avoids both problems.
- **No bundle growth.**
  - The Moon's lit half comes from `moon300.png`, which `eclipse-view.ts`
    already imports for the disc.
  - All five old PNGs get deleted, so the bundle shrinks slightly.
  - Baked high-res PNGs would add about 30 KB of base64, mostly for the Moon.
- **Geometry lives in code.** It's a handful of named constants, in the same
  iOS-point boxes as the old PNGs. That makes it easy to review and tweak, and
  it's checked against the old PNGs (see Verification).
- **Cost.** Five tiny canvases.
  - About 40 KB on a phone and 220 KB on the 6K XDR.
  - Rendering takes well under 1 ms, and only happens when the scale changes.
  - Per-frame work is unchanged: five `drawImage` calls, as today.
  - No new hooks: the cache key is checked inside `drawRingHands`.

Baked data URLs would win only on runtime simplicity (swap five files). Doing
them well would mean shipping several resolutions (mip levels) or working
around `imageSmoothingQuality`, which gives the simplicity back.

## What the old icons are (measured)

These measurements come from per-pixel alpha and brightness dumps of the @1x
PNGs, cross-checked against the iOS `@2x` files and Firenze's face art.
- Units are iOS points, which equal @1x pixels.
- "PNG coords" are image coordinates, with y pointing down.

**Sun** (box 27×27):
- A round body plus **8 equal triangular rays**. That's the construction of the
  watch renderer's `sun` hand (iOS `ECQHandSun`), which also drew Firenze's
  center star.
- The body radius is about 4.25 pt; the valleys between rays are flat arcs, not
  V's.
- The ray tips reach about 8.5 pt, on the axes and the diagonals (0°, 45°, …).
- Fill `#f2e407`, exactly Firenze's `sunColor`.
- A thin dark stroke `#120400`, which is Firenze's `sunStrokeColor`. It's
  clearly visible in the iOS @2x.
- **The star's center is at PNG (13.5, 17.5), 4 pt below the box center.**
- Firenze's star has one longer ray (the `ECQHandSun` "first ray is longer"
  rule). The ring icon doesn't, and we keep it that way.

**Moon** (box 20×20):
- Disc centered at (10, 10), radius 8 pt.
- **The top half of the PNG is lit** (grey lunar texture).
- The bottom half is opaque black.
- The line between them is straight and runs through the center.
- The rim has the same lighter border as the shadow.

**Earth shadow** (box 20×20):
- The same disc.
- Fill `rgba(0,0,0,0.66)` (alpha 168).
- A rim about 1 pt wide, at alpha ≈ 0.71 and grey ≈ 54. That is exactly a
  `rgba(255,255,255,0.15)` stroke over the fill. It's the same stroke
  `eclipse-view.ts` uses for the shadow outline inside the disc.

Both 20-px icons also have a barely visible white halo just outside the disc
(≤ 5 % alpha).
- It is noticeably stronger at the bottom right.
- The cause: the PSD's "Outline" layer sits half a pixel off its "Fill" layer
  (extents 1..20 vs 2..18).
- The result is a lopsided glow that rotates with the marker.
- **The new halo is centred** (Decision 3).

**Lunar nodes** (box 15×15). These are `eclipseRingAscNode.png` and
`eclipseRingDesNode.png`, byte-identical to the iOS @1x files.
- **The line:** a **1-pt radial line** running the full height of the box, in
  `#b60000` at about 94 % opacity.
  - The ring is exactly 14 s wide, so on screen the line crosses the whole ring
    and sticks out ½ pt on each side.
- **The arrowhead:** a small solid **triangle** on the line.
  - Its base runs 4 pt along the line, and it sticks out 2 pt.
  - It's centered ½ pt below the box center, in PNG coords.
  - It points **left** on the ascending node and **right** on the descending
    node. Otherwise the two markers are mirror images.
- **Centering:** the old line sits 0.03 pt left of center (a faint 6 % bleed
  column). The new one is centered exactly.
- **An unshipped alternative:** the iOS source folder also has
  `eclipseRingAscNode@2x.psd`, which holds a different design.
  - It's an Ω-shaped ☊ glyph (an arch with foot serifs), made from a text layer
    named "Ω".
  - It was never exported: there's no `@2x` node PNG, and the shipped @1x is
    the line-and-arrowhead.
  - See Q4.

## Placement and orientation: unchanged by construction

These all stay **exactly as they are**:
- `drawRingMarker`, which does rotate(firstAngle) → translate(0, radius) →
  rotate(glyph) → **scale(1, −1)** → drawImage
- `RING_SIZE`
- the radii (`R2 + 4s`, `R1 − 1s`, `(R1 + R2)/2`)
- the angles

The only change is that the image argument becomes a canvas. Each sprite uses
the same box and the same "PNG-up" layout as its old file, so the existing
vertical flip does what it did before:

- **Sun:** the star center, 4 pt low in the PNG, flips to 4 pt inward. That
  lands it exactly on the outer rim R2, as the `drawRingMarker` comment
  documents. The glyph angle is 0, so the rays stay pointing out from the dial
  and along it.
- **Moon:**
  - The lit top of the PNG flips to local +y.
  - The glyph rotation `sunRA − moonRA` makes the total rotation `π + sunRA`,
    which is the Sun marker's own placement angle.
  - So the **lit half always faces the Sun marker**, and the lit/dark line is
    perpendicular to the Sun direction.
- **Shadow:** rotationally symmetric, so only the centering matters.
- **Nodes:**
  - The line stays radial.
  - The arrowhead's ½-pt offset flips to ½ pt inward of the ring's middle.
  - PNG-left is the direction of increasing RA, which is clockwise on screen. So
    the ascending node's arrow points clockwise and the descending node's
    points counterclockwise.
  - The two markers are 180° apart, so **both arrowheads always point the same
    way on screen**. That makes a handy check.

## Moon texture

- **Source: `moon300.png`**, which the eclipse view already loads.
  - Firenze's Moon (`parts-bin/planets/moonTransparent-4x.png`) is only 24 px
    across, even at 4×.
  - It's also a `watch/` asset, and the Observatory bundle must not pull those
    in (the build's `grep -c 'watch/'` check).
- **Shrink it once**, when the sprite is built: from 300 px down to a disc of at
  most 86 px.
  - Use `imageSmoothingQuality = 'high'`, or repeated halving where a browser
    ignores that setting.
  - The Moon sprite waits for `moonImg.ready`. Until then the Moon marker is
    skipped, as today.
- **Texture rotation** (Decision 1). I scanned `moon300.png` for the fraction of
  the lit half darker than brightness 110, by which half of the photo is lit:

  | Lit half of the photo | north | NNE (15°) | east | south | west | WNW (285°) |
  |---|---|---|---|---|---|---|
  | Dark fraction | 0.55 | 0.51 | 0.25 | 0.19 | 0.49 | 0.51 |

  - **West:** Oceanus Procellarum and Mare Imbrium over the bright southern
    highlands and Tycho.
  - **North-northeast:** Imbrium, Serenitatis and Crisium.

  I'll render both at actual size (phone and 6K scale) for Steve to pick.
- **Brightness** (changed during implementation). The plan was to match the old
  icon's mean brightness, but the numbers ruled it out. The old lit half
  averages 220; `moon300`'s candidate halves average 109–115. Matching would
  need 1.9×, which clips the highlands to flat white and erases the maria — the
  opposite of "an equal mix of white and black". Instead, `MOON_STYLE.gain` is
  1.5, applied as an additive `lighter` pass (works in every browser, unlike
  `ctx.filter`). Steve sees 1.0 and 1.5 side by side.

## Implementation

1. **New file `src/observatory/eclipse-ring-sprites.ts`.**
   - Geometry constants and path helpers, all in iOS points:
     - Sun: body and tip radii, star center.
     - Moon and shadow: disc radius, rim and halo widths and alphas.
     - Nodes: line width and extent, arrowhead base, depth, offset and side.
     - Colors.
   - A function `getRingSprites(pxPerPt, moonTexture | null)` that returns
     `{ sun, moon | null, earthShadow, ascNode, desNode }` as `OffscreenCanvas`es
     of `ceil(box · pxPerPt)` px.
     - It caches the result, keyed on `pxPerPt` plus whether the Moon texture is
       ready.
   - Each sprite is drawn scaled by `N / box`, so its content maps back onto the
     old box exactly.
   - The final dimensions come from fitting against the old PNGs (see
     Verification).
2. **Changes to `eclipse-view.ts`.**
   - Remove all five ring-PNG imports, their loads, and the `ringSun` …
     `ringDesNode` state. `Img`/`loadImg` stay for the four disc images.
   - `drawRingMarker` takes a `CanvasImageSource`.
   - `drawRingHands` computes `pxPerPt = s · dpr`, using the same DPR the frame
     is scaled by, and fetches the sprites.
   - Update the `drawRingMarker` comment. Keep the reason for the flip, because
     the sprites follow the PNG layout on purpose.
3. **Delete** all five `src/shared/assets/eclipseRing*.png`.
4. **Tests** (vitest; pure geometry, because Node has no canvas):
   - Sun: ray-tip and body radii, and the 4-pt center offset.
   - Nodes: line extent, arrowhead position, and which side it's on.
   - Sprite pixel sizes.
   - The cache: it rebuilds when the scale changes, doesn't rebuild when the
     scale is the same, and builds the Moon only once its texture is ready.
5. **Docs** (`docs/observatory.md`, section "Eclipse Simulator"):
   - Add a paragraph on the sprites drawn in code: where the geometry comes
     from, the cache key, the Moon texture, and the PNG layout.
   - Fix the out-of-date "Coordinate note" while there. It says
     `rotate(−firstAngle) → translate(0, −radius)`, "CCW from the top". The
     code does `rotate(firstAngle) → translate(0, radius)`, clockwise from the
     bottom, as the `drawRingMarker` comment says.
   - Leave the Phase 7B plan alone; it's history.
6. **Canvas memory log (`[mem]` ledger).** Not worth a line (≤ 220 KB worst
   case). Say so in a comment.

## Verification

- **Automated checks:**
  - `npx tsc --noEmit`
  - `npx vitest run`
  - `./build.sh`
  - `grep -c 'watch/' dist/observatory-engine.js` is unchanged
- **Same-size check.** Use the harness from my canvas-verify-without-rAF note:
  render each new sprite at exactly 1× (27/20/20/15/15 px) and compare it with
  the old PNG.
  - Total alpha coverage within about 3 %. Old values, in pixel equivalents:
    Sun 115.4, Moon 215.5, shadow 142.2, ascending node 20.7, descending node
    21.0.
  - Edges within ½ px.
  - Centre of coverage matching the old one, apart from the deliberate
    re-centering. The halo and the node line move by ≤ 0.15 px.
- **Before/after images.** In the same harness, `git stash` the view file to
  render the eclipse dial with the old and new markers.
  - At phone scale (pxPerPt ≈ 2.2) and 6K scale (≈ 5.3).
  - At three moments:
    - a new moon near a node
    - a full moon
    - a quarter moon, to confirm the lit half faces the Sun marker
  - Also confirm that both node arrowheads point the same way on screen.
  - A difference overlay, to confirm the positions are identical.
  - Send the PNGs to Steve, together with the two Moon candidates.
- **Steve's visual check:** the dist build on the 240 Hz machine and on a
  phone. Check the `build N.N.N` stamp first.

## Implementation notes (2026-09-11)

**Files**
- New: `src/observatory/eclipse-ring-sprites.ts` and
  `src/observatory/__tests__/eclipse-ring-sprites.test.ts`.
- Changed: `eclipse-view.ts` and `docs/observatory.md`. The docs now have a
  "Ring markers" subsection, and the out-of-date Coordinate note is fixed.
- Deleted: the five `eclipseRing*.png` files.

**Fitted geometry.** Each value is the best fit against the old PNG by
supersampled RMS alpha error.
- **Sun:** tips at 8 pt, valleys at 4 pt. Half the ray length is exactly the
  `ECQHandSun` proportion. A 0.5-pt `#120400` stroke with round joins.
- **Discs:** radius 8 pt. The first fit added a 1.25-pt rim of 15 % white and a
  halo fading from 14 % to 0 over 2 pt. Decision 6 removed both. Now the dark
  parts get a 0.75-pt opaque `#808080` border, inset so the disc stays 16 pt
  across.
- **Nodes:** a 1-pt line at 94 %. The arrowhead's base is 5 pt and it sticks out
  2.5 pt.

**Device scale.** It comes from `ctx.getTransform()` (`hypot(a, b)`), not from
`devicePixelRatio`. That's always the scale the canvas actually renders at, and
the harness gets it for free.

**Fit at 1×** (new sprite vs. old PNG; final, after Decisions 5–6):

| Marker | α-sum old → new | Centroid old → new | Extent (α > ¼) | RMS α |
|---|---|---|---|---|
| Sun | 115.4 → 115.5 (+0.1 %) | (13.50, 17.66) → (13.49, 17.50) | identical | 0.032 |
| Moon | 215.5 → 205.8 (−4.5 %) | (9.89, 9.99) → (10.00, 9.98) | identical | 0.103 |
| Earth shadow | 142.2 → 146.2 (+2.8 %) | (10.13, 10.10) → (9.99, 9.98) | identical | 0.081 |
| Asc node | 20.7 → 20.7 (−0.2 %) | (7.09, 7.64) → (7.08, 7.66) | identical | 0.029 |
| Des node | 21.0 → 20.7 (−1.6 %) | (7.84, 7.64) → (7.92, 7.66) | identical | 0.031 |

Notes on the centroid shifts:
- **Sun (0.16 px):** the old hand-drawn star is bottom-heavy. Its extent is
  centred exactly where the new one is.
- **Shadow and nodes:** the deliberate re-centering.
- **Moon:** its RMS is the texture.
- **Moon and shadow coverage:** after Decision 6 the Moon has no halo (−4.5 %),
  and the shadow's opaque gray border outweighs the old translucent rim
  (+2.8 %). The silhouettes are unchanged.

**Mirroring check.** The Moon sprite was drawn through `drawRingMarker`'s flip
and correlated against the photo at every 5° turn, both mirrored and unmirrored.
The best match is the expected turn, unmirrored: r = 0.999 for the west
candidate, and 1.000 for the final north-northeast pick.

**Before/after renders.** The real `drawEclipseView`, old vs. new, at phone
(s 0.744 @3) and 6K (s 2.656 @2) scale, at four instants: the 2026-08-12 solar
eclipse, the 2026-03-03 lunar eclipse, and the first and last quarters.
- All five markers sit in the same places.
- The Moon's lit half faces the Sun marker in both quarters.
- Both node arrowheads point the same way on screen.

**Automated checks:**
- `tsc --noEmit` is clean.
- The full `npx vitest run` passes: 52 files, 8774 tests, including the 7 new
  ring-sprite tests.
- `./build.sh` is clean. Two builds (before and after Decisions 5–6) bumped
  `version.txt` from 2.0.128 to 2.0.130.
- `grep -c 'watch/' dist/observatory-engine.js` is unchanged at 1.
- `dist/observatory-engine.js` has no `eclipseRing` references and is 4.6 KB
  smaller.

## Open questions

None. Q4 (node design) is now Decision 4: keep the shipped line-and-arrowhead.
It's what users see today, and it reads cleanly across a 14-pt ring. The
never-shipped ☊/☋ glyphs from the iOS `@2x` PSD would have been a bigger visual
change and crowded at 15 pt.

The one choice left for implementation time is the Moon candidate (west vs.
north-northeast; Decision 1).

## Out of scope

- The help screenshot `help/images/observatory/5eclipses.png`, which shows the
  old icons.
- An iOS backport. If wanted later, the same sprite code could export @2x/@3x
  PNGs for iOS through the `ios-backports` workflow.
