# Observatory bitmap upgrades without a memory increase — plan (2026-10-25, rev 2 — for final review)

## Status

**Implemented 2026-10-27, build 2.1.26, uncommitted.** A–G wired in as
below with these deltas from rev 2: `planet-hands.ts` sizes every icon by
a fixed master scale (REF_SCALE = 4), so a master's box can differ from
300×136; **Saturn and Venus were re-sourced on 2026-10-27** after Steve's
in-app review — the Cassini 2016 globe was a third in night and the Mariner 10
Venus had a terminator limb, so Saturn is now the Voyager 2 approach view
(PIA01364, rings levelled) and Venus the 1979 Pioneer Venus Orbiter full disc,
retoned to the old icon's cream (`candidates2.py`, `contact-fulldisc.png`); the orrery
Moon dot uses the iOS `moon75@2x` asset (as `planets/moon150.png`); the
constellation labels are in right-ascension order (Psc at 0–2h … Aqr at
22–24h — rev 2's "Cap, Aqr, Psc…" list was off by two slots, caught on the
1280 overlay); the starfield uses the fixed-virtual-sky rule Steve proposed
(below, E) rather than the viewport-scaled rule; the totality master is
framed so `SUN_RADIUS_FRACTION` is unchanged and the dark disc draws at the
Moon's diameter. Bundle 5.84 → 6.83 MB. Tests: `starfield.test.ts`,
`sidereal-labels.test.ts`, `moon-texture.test.ts`; 9008 green. Verified
headless at 1280×800, 3840×2160 and 1920×1080 @2× against build 2.1.23.
Not verified in-app: the eclipse simulator's new sprites (imports only;
framing checked in the asset pipeline).

Original plan text follows. Follows the zodiac-ring work
(2026-10-23-observatory-zodiac-svg-glyphs.md, committed): the other bitmaps
that upscale at 4K, done so the page ends up *lighter* in decoded-image memory
than today. Blue Marble maps are out of scope by decision.

Rev 2 (after review): every bitmap gets a master large enough that **nothing
is upscaled on a 4K panel** (and, where the master allows, 5K); sources are
**NASA only** (no ESA/SOHO, no ESA/Hubble, no CC BY-SA); attribution goes in
the README's Credits section, which every page's chrome already links to
(`README.md#credits`, Observatory included — observatory.html L829).

## 1. Sizes and accounting

Device-pixel sizes the dial actually draws (mainR = 896 on a 3840×2160
panel at any OS scaling; 1195 on 5120×2880):

| Asset | Drawn, 4K | Drawn, 5K | Have | Master |
|---|---|---|---|---|
| Sun disc (`L.sunD` = 100·s) | 246 | 327 | 200 (`sun@2x`) | **400²**, disc at the PNG's 70 % of frame |
| Planet icons, 7 (75×34·s) | 184×84 | 246×111 | 150×68 (`@2x`) | **300×136** each, transparent |
| Moon (2·moonR ≈ 0.78·mainR) | 699 | 932 | 768 (`moon384@2x`) | **768** covers 4K; 1024 for 5K |
| Eclipse-sim sun | ~115 | ~150 | 74 | **160²**, same SDO frame |
| Eclipse-sim totality | ~300 | ~450 | 316 | **450²** |
| Starfield / zodiac / names | vector, text | | | none |

Decoded bitmaps (`w × h × 4`) are the browser's discardable image cache; the
bundle's base64 is the hard cost (JS heap, page lifetime).

| | Today | After | Δ decoded | Δ bundle (≈ file × 1.37) |
|---|---|---|---|---|
| E. Starfield 1536×2048 → procedural | 12.58 MB | 0 | −12.58 | −0.09 |
| A. Sun 100² → 400² (SDO crop) | 0.04 | 0.64 | +0.60 | +0.25 |
| B. Planets 7 × 75×34 → 300×136 | 0.07 | 1.14 | +1.07 | +0.25 |
| C. Names 298² → text | 0.36 | 0 | −0.36 | −0.04 |
| D. Moon 300² always + 768² on demand | 0.36 | 0.36 phone / 2.72 desktop | 0 / +2.36 | +0.55 (PNG) |
| F. Eclipse sun 74² → 160², totality 316² → 450² | 0.42 | 0.91 | +0.49 | +0.3 |
| **Total** | | | **−10.8 phone / −8.4 desktop** | **≈ +1.2** |

With a 1024 Moon instead (5K coverage): desktop −6.6 MB, bundle ≈ +1.7.
Bundle today 5.84 MB → ≈ 7.0 MB. Optional trim: the Moon and sun are opaque
photos on black; stored as JPEG with a circular clip at draw time they'd be
~¼ the bytes (moon-view, eclipse-view and the ring sprites would each add a
clip) — a follow-on, not in this plan.

## 2. Per item

### A. Sun disc — new 400 px master from SDO

- Today: `main-dial.ts` imports `sun.png` (100², a SOHO EIT 304 Å frame by
  the look of it — ESA terms require written authorisation for commercial
  use, so it is also a licensing cleanup); step 8 draws it at `L.sunD` with
  alpha 0.75 and `lighten`.
- Source: SDO AIA 304 Å, the same red-orange chromosphere-with-prominences
  look. The SDO data page serves a rolling `latest_4096_0304.jpg`; the SVS
  archive has event frames at 4096². SDO: "not copyrighted unless noted",
  credit "Courtesy of NASA/SDO and the AIA, EVE, and HMI science teams".
- Make `src/shared/assets/sun400.png`: pick a frame with a good prominence,
  centre-crop so the disc is ~70 % of the square as in the PNG (the black
  surround is what `lighten` composites), resample to 400². The draw is
  size-driven, so only the import changes. Covers 5K too.
- `fixUpSunRegion` (static-cache.ts) unaffected — but see E: the starfield
  it repaints under the sun must be deterministic.

### B. Planet icons and the orrery moon — new 300×136 masters, NASA imagery

- Today: `planet-hands.ts` draws `saturn/jupiter/mars/earth/venus/mercury.png`
  (75×34) and `moon75.png`, sized by `img.naturalWidth * s`.
- **Gotcha:** any larger asset would draw larger. Add `REF_W = 75, REF_H =
  34` (the iOS authoring size) and size by those; same for the moon.
- Masters (all NASA, not copyrighted, credit the mission): Saturn — Cassini
  natural-colour mosaic PIA06193 (NASA/JPL/Space Science Institute); Jupiter
  — Cassini's Jupiter portrait PIA02873 or a Juno/JunoCam NASA release
  (NASA/JPL-Caltech/SwRI/MSSS); Mars — Viking Orbiter global mosaic
  (NASA/JPL/USGS) or MGS; Earth — Blue Marble 2012, Suomi NPP
  (NASA/NOAA/GSFC); Venus — Mariner 10 whole-planet view PIA23791
  (NASA/JPL-Caltech); Mercury — MESSENGER global view (NASA/JHUAPL/CIW).
  No Hubble: its credit line names ESA.
- Work is compositing, not pixels: mask each disc to transparency, match
  the current icons' lighting direction, disc diameter (≈ 34 of 34 px tall;
  Saturn's rings span the 75 width) and brightness. Produce a contact sheet
  of the seven at 75×34 and 300×136 beside today's icons for sign-off before
  wiring. `moon75@2x.png` (150×68) is kept as is — a 22·s-radius dot.
- Drawn every frame; `drawImage` cost follows destination size — unchanged.

### C. Constellation names — draw as text

- Today: `main-dial.ts` `drawSubdialBackground` ('Sidereal' branch) draws
  `EO-Sidereal-constellation-names-0-at-top@2x.png` (298²) at 149·s. Measured
  from the image: twelve labels, ink colour `rgb(224,224,224)`, ink radius
  56–65 at s = 1 (subR = 73), centred at **15° + 30°·k** — i.e. the odd slots
  of a 24-slot ring, 0 at top — reading clockwise from slot 1: Cap, Aqr, Psc,
  Ari, Tau, Gem, Can, Leo, Vir, Lib, Sco, Sag (confirmed on the 4K
  screenshot). Bottom-half labels are flipped to read upright (demi-radial).
- Replace with the existing helper, exactly as the commented-out iOS line
  (EOShuffleView.mm L205) did before the image was baked:
  ```ts
  const names24 = ',Cap,,Aqr,,Psc,,Ari,,Tau,,Gem,,Can,,Leo,,Vir,,Lib,,Sco,,Sag'.split(',');
  drawDialNumbersDemiRadial(ctx, cx, cy, names24,
      `${L.subdialFontSize}px 'Helvetica Neue', Helvetica, Arial, sans-serif`,
      'rgb(224, 224, 224)', r - 5 * s, r - 5 * s);
  ```
  `drawDialNumbersDemiRadial` places the ink's outer edge at `radius` via
  the measured glyph half-height, so `r − 5·s` should land the ink at ≈ 57–65
  as the image does; verify by overlay at s = 1 and nudge the radius if off.
- Remove the image import and its loader branch; `areDialImagesReady` /
  `waitForImages` then gate on the sun alone (comment updated).
- Note: the image is "0-at-top" regardless of `noonOnTop`, and so is the
  sidereal subdial's own numeral ring; keep that (no behaviour change).

### D. Moon — resolution-selected texture, big image decoded only when needed

- Today: `moon-view.ts` and `eclipse-view.ts` each load
  `src/shared/assets/moon300.png`; the moon view draws it at `2 × pixelRadius`
  where `pixelRadius ≈ L.moonR` (≈ 0.39·mainR → ~700 CSS px at 4K, 1400 device
  px at @2×: a 2.3–4.7× upscale of a photo, the most visible softness on the
  page). `eclipse-ring-sprites.ts` cuts the ring Moon marker from the same
  image via `halvedTo()` (downsamples — fine at 300).
- `moon384@2x.png` (768²) in the iOS Resources is **the same photograph,
  same orientation and framing** (checked: identical maria, Tycho rays at
  bottom), so it is a drop-in. Copy to `src/shared/assets/moon768.png`.
- New `src/shared/moon-texture.ts`:
  ```ts
  /** Small texture: always loaded (300 px). Large (768 px): created and
   *  decoded only when a caller needs more than SMALL_PX·1.2 device px. */
  export function getMoonTexture(neededDevicePx: number): HTMLImageElement | null
  export function waitForMoonTexture(): Promise<void>   // the small one
  ```
  The large `Image` is constructed from its data URL on first demand (the
  string sits in the bundle either way; the 2.36 MB decode happens only
  then). Returns the small image until the large one has loaded, so no
  blank frame. Never frees the large one (a 4K window stays 4K).
- `moon-view.ts`: `getMoonTexture(2 * pixelRadius * L.dpr)` per draw (cheap:
  a comparison). `eclipse-view.ts` and the ring sprites keep the small
  texture (their Moon is tens of px).
- Threshold `360` device px (300 × 1.2): 1280×800 @1× (moon Ø ≈ 260) and
  phones (@3×, Ø ≈ 100 CSS → 300) stay small; a 1280 @2× laptop (Ø 520) and
  every 4K case go large. Phones therefore pay nothing for D.
- 768 is a 4K-exact master (699 drawn). For 5K (932 drawn) the source is
  NASA SVS "Moon Phase and Libration" (2025 edition, svs 5415): full-disc
  frames for every hour at 5760×3240 with alpha, LRO-data renders, north
  up; pick a frame at full Moon with near-zero libration, downsample to
  1024. Credit "NASA's Scientific Visualization Studio". It is a render, not
  the current photograph, so the Moon's look changes slightly — Steve's
  call (§5). The selector takes either file; nothing else changes.

### E. Starfield — procedural, drawn into the static cache

- Today: `background.ts` loads `background@2x.png` (1536×2048, 12.6 MB
  decoded) and `drawBackground` cover-scales it over the viewport in device
  pixels (rotated 90° for landscape, as iOS). At 4K that is a 1.9× (@1×) or
  3.75× (@2×) upscale: stars become soft discs (visible on the 4K
  screenshot).
- Measured from the image: it is **pure black with ~320 stars and no
  nebulosity** (99.9 % of pixels under luminance 16; 4×4 block means all
  < 0.4/255). Stars at @2x: footprint 4–40 px² (≈ 1–3.5 px radius), peak
  luminance spread 32–255 with a floor-heavy distribution (≈ 50 % under 96,
  12 % saturated), tint ≈ 50 % white / 40 % warm / 10 % cool. Density ≈ 100
  per megapixel of image, which after cover-scaling is ≈ 250–270 stars on
  screen at any viewport.
- **As built (rule S, Steve's proposal):** a fixed virtual sky, 8192 device
  px square and centred on the window, populated at the image's density
  (≈ 290 stars per device megapixel) by one mulberry32 sequence; each star
  is drawn as a pixel-integrated Gaussian sampled from the image's 356
  measured profiles (`starfield-profiles.ts`) at their 1280×800 size. Stars
  are therefore the same pixel size on every screen, the count follows the
  window area (300 at 1280×800, ≈ 2400 at 4K), and a star keeps its place on
  resize. Off-window stars cost a few random draws and no memory. Density
  is per *device* px (a 2× display gets 4× the stars per physical area, each
  half the size) — swap to per CSS px if that reads too busy. Sheet:
  `2026-10-25-bitmap-upgrades/starfield-sheet-S.png`. The rule below is
  what rev 2 proposed and was superseded.
- Replace with a generator in `background.ts`:
  - `mulberry32(seed)` PRNG, fixed seed → the same sky every load and, more
    importantly, **identical output for identical (viewW, viewH, dpr)**, which
    `fixUpSunRegion` relies on when it repaints the patch under the sun.
  - N = round(260 × viewport area / reference area), capped (say 200–400),
    positions uniform in the viewport, drawn in device pixels (the function
    already runs un-scaled).
  - Each star: radius `r = (0.6 + 1.4·u²) × k`, peak `p` from the measured
    distribution, tint from the measured mix; drawn as a filled disc of
    radius `r` plus a radial-gradient halo to `2.5 r` (two `arc` fills, or
    one gradient fill). `k` = the cover scale the image would have had
    (`max(W/2048, H/1536)` landscape) so star sizes keep today's proportions
    to the viewport, but the core is sharp at any dpr.
  - Black fill first, as now. ~300 gradient fills: trivial, once per layout.
- Delete the image import, `loadImage`, `isBackgroundReady` (callers in
  `static-cache.ts` L72/L130 draw unconditionally) and `waitForBackgroundImage`
  (drop from the `Promise.all` in `observatory-entry.ts` L1815).
- Look check before wiring: render the procedural sky beside the image at
  1280×800 and 4K (same crops as the zodiac verification). Positions will
  differ (it is a different random sky); density, size spread, brightness
  spread and tint should read the same. Steve signs off on the look.

### F. Eclipse-simulator sprites — new masters

- `eclipse-view.ts` draws `sunEclipse.png` (74²) at `sunPixelRadius` (≈ 20·s
  of the eclipse dial, ~115 px on 4K) and `totalEclipse.png` (316²) at
  `totalR` (~300 px on 4K, ~450 on 5K).
- Sun: a tighter crop of the same SDO frame as A (disc filling the square,
  as `sunEclipse` does), 160². Totality: NASA's own 2017 eclipse frames
  from Madras, Oregon (NASA/Aubrey Gemignani, on images.nasa.gov, ~1900 px;
  the totality frame to be confirmed there — APOD corona images are
  photographer-copyrighted and are out), centre-cropped to 450². Both
  draws are size-driven; imports only.

### G. Credits

Add an "Imagery" subsection under Credits in README.md (every page's chrome
links `README.md#credits`; Observatory at observatory.html L829). NASA's
guidelines ask only that NASA be acknowledged as the source and no
endorsement implied; SDO and SVS each name a credit line. Lines:

- Sun: Courtesy of NASA/SDO and the AIA, EVE, and HMI science teams.
- Moon (if the SVS master is used): NASA's Scientific Visualization Studio.
- Planets: NASA/JPL/Space Science Institute (Saturn, Jupiter), NASA/JPL/USGS
  (Mars), NASA/NOAA/GSFC Suomi NPP (Earth), NASA/JPL-Caltech (Venus),
  NASA/JHUAPL/Carnegie Institution of Washington (Mercury) — final list per
  the images actually picked.
- Eclipse: NASA/Aubrey Gemignani.

Also list the remaining iOS-era assets we keep (Blue Marble, Black Marble,
the Moon photo) as NASA imagery in the same place.

## 3. Steps

0. **Assets.** Download (Steve's OK needed per file — sizes approximate):
   SDO `latest_4096_0304.jpg` (~3 MB) or an SVS 4096² frame; one SVS 5415
   `5760x3240` Moon frame (~15 MB PNG) if the 1024 Moon is wanted; Cassini
   PIA06193 JPEG (~10 MB); the Jupiter, Mars, Earth, Venus, Mercury
   full-disc JPEGs (1–20 MB each); the NASA 2017 totality frame (~2 MB).
   Into the scratchpad; crops/composites checked into `src/shared/assets/`
   (masters outside `src/faces/`, as the dock-icon work learned). Each
   asset's source URL, credit and the crop recipe recorded in
   `planning/2026-10-25-bitmap-upgrades/SOURCES.md`.
1. **Contact sheets** for sign-off: sun (old vs new at 1× and 4K), the seven
   planets (old vs new at 75×34 and 300×136), eclipse sprites, Moon 768 vs
   1024-render crop.
2. **A + B + C + F** (one change): imports, the `REF_W/REF_H` fix in
   planet-hands, the label ring, loader/readiness cleanup, README credits.
   Tests: a `drawDialNumbersDemiRadial` call-capture test for the 24-slot
   label list (order, font, colour, radius).
3. **E**: generator + removal; side-by-side render for sign-off; unit test
   that the generator is deterministic for a given (W, H, dpr) and that star
   count scales with area within bounds.
4. **D**: `moon-texture.ts` + the two call sites; unit test for the selector
   (below/above threshold, falls back to small until large loads).
5. `tsc`, `vitest run`, `./build.sh`; verify (§4).

## 4. Verification

Headless before/after against the dist server (the zodiac recipe), at
1280×800 @1×, 3840×2160 @1×, 1920×1080 @2×, cropping: the Moon, the sun, the
Saturn/Jupiter hands, the sidereal subdial, and a starfield patch. Expect:
Moon and sun sharp at 4K; labels in the image's positions at 1280 (overlay);
stars sharp with similar density/spread. Memory: bundle size delta from
`ls -l dist/observatory-engine.js` (expect ≈ +0.5 MB), `[mem]` JS heap line
before/after on the 1280 run, and the decoded-image arithmetic above (the
browser doesn't expose decode-cache size; a Chrome task-manager reading at
4K is the only direct check, Steve-side). `areDialImagesReady` still gates
the sun; first paint shows no blank ring or sky.

## 5. Decisions for Steve

1. Moon master: the 768 photo already in hand (4K-exact, no look change),
   or the SVS 1024 render (5K-exact, slightly different look)? Could be
   both: 768 now, 1024 later via the same selector.
2. OK to download the files listed in step 0 into the scratchpad?
3. Starfield: side-by-side render for sign-off before wiring (recommended).
4. Planet sources: I pick candidates and show the contact sheet; you choose.
