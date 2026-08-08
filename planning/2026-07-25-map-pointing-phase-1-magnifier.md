# Map Pointing Phase 1 — Explore Magnifier + Immediate Fixes

**Status**: IMPLEMENTED (2026-07-25) — all items landed and verified headless
(bounds sweep 46/46 in-band, max center jump 17px; cursor hidden/restored;
selection cleared on lift; 8587 tests pass). Awaiting Steve's on-device feel
pass (bubble size/span/smoothing knobs at the top of the magnifier section in
`earth-view.ts`). Two design points discovered during implementation, now part
of the design: (1) the magnifier draws BEFORE the crosshair hairlines and the
band omits the home dot while dragging — both are baked pixels that magnify
into fat smears if blitted (the hairlines/dot draw after the bubble instead,
via new `drawObserverDot` export + `omitDot` param); (2) the bubble draws its
own crisp home marker (small red/white dot) when the saved location is in
view.
Parent: `2026-07-25-map-pointing-architecture.md` (rev 2: this phase is the
only committed scope; nothing here is designed for reuse by the shelved
picker).
**Created**: 2026-07-25
**Last Updated**: 2026-07-25 (rev 4 — implemented)

## Goal

Replace the accidental iOS loupe with an app-drawn magnifier on the Observatory
earth band during drag-to-explore, plus the zero-cost fixes agreed alongside it
(cursor hiding, selection hygiene, loupe retirement).

## Scope

In: magnifier bubble, cursor hiding, selection-hygiene CSS/JS, native-loupe
suppression, a small city-bbox query helper. Out: any picker work, the
Fine-tune… pill button, any change to the band's size/projection/drag
semantics, any shared "kit" abstraction.

## 1. Magnifier Bubble

Drawn on the main canvas each tick while `dragState === 'dragging'`, after the
band and crosshair — natural home is a `drawDragMagnifier(...)` in
`src/observatory/earth-view.ts` next to `drawDragCrosshair`, called from
`drawFrame`.

**Content = what the band shows.** The band composites the current month's
Blue Marble day image (600×300 @2x, 12 monthly images), the night image, and
the terminator every tick. The magnifier must reflect exactly that state
(decision A3), so its base layer is a **same-canvas blit**: read the band
region around the drag point (already painted this frame, clipped to the band
rect) and scale it into the bubble. Month, day/night shading, terminator, and
any future band features come along for free.

Resolution honesty: at a ~5° bubble window the blit is a heavy upscale
(phone band: 5° ≈ 3 CSS px → mush; even re-sampling the 600×300 source
texture, 1.67 px/°, would give ~8 source px — no better). The wash is color
and terminator *context*; the information is carried by crisp overlays drawn
at bubble scale on top:

1. **City dots + labels** — top-K by population within the bubble's window,
   small dedupe radius. Needs a new `city-search.ts` helper
   (`citiesInBBox(bounds, k)` or similar); a linear scan over ~168 K rows is
   microseconds-to-milliseconds and runs only while dragging. If the DB isn't
   parsed yet at drag start (`loadCityData()` is async, kicked off in
   `startDragAt`), render without labels until it resolves — same graceful
   degradation the location-name readout already has.
2. **Graticule** — 1° lines at default span (~26 px apart in the bubble),
   thin and low-contrast. Optional knob; drop if noisy.
3. **Crosshair** — same visual language as the band's full-length crosshair,
   at bubble center.

Geometry and behavior:

- **Bounds (hard constraint)**: the bubble stays **entirely inside the band
  rect**, always — it never covers the moon disc, date row, dial, or chrome.
- **Shape/size**: circle, diameter = `min(~140, bandH − 8)` CSS px. On a
  375-wide phone the band is ~117 px tall → Ø ≈ 105 px there; desktop bands
  fit the full size.
- **Placement**: no flip states. The bubble sits at the pointer position
  displaced by a **continuous offset toward the band center**, clamped so the
  bubble rect stays inside the band — the position is a smooth function of
  the pointer, so it slides rather than jumps. Two wrinkles:
  - On phones the in-band cap means the bubble is nearly band-height, so it
    rides at band mid-height and the useful offset is mostly horizontal
    (toward band center X). A pure toward-center offset changes sign exactly
    at center — a jump — so the side choice gets a dead zone/hysteresis (or a
    brief slide animation on side change). Tune on device.
  - On touch, the physical finger occludes whatever is under it; the
    horizontal offset keeps the bubble off the fingertip. On mouse this
    doesn't matter (the cursor is hidden during drag, item 2).
- Never dies at band borders: the bubble centers its *content* on the clamped
  drag lat/lon (the same value the drag applies), so dragging past an edge
  pins the content at the edge instead of losing it.
- **Window**: fixed geographic span (~4–5° across the bubble, tune on device)
  — reads identically on phone and desktop regardless of band pixel density.
  At 5°/105 px ≈ 21 px/°, San Jose–San Francisco (~0.6°) sit ~13 px apart:
  separable and labeled; drop toward 4° if labels crowd.
- **Smoothing**: at phone band resolution one input pixel ≈ 1.5° ≈ a ~40 px
  jump inside the bubble. Lerp the bubble's displayed center toward the target
  each tick (display-only; the drag itself stays unsmoothed). Tuning knob —
  may prove unnecessary for trackpad/Pencil input with finer deltas.
- **Pointer types**: shown for all pointer types during drag (mouse too —
  consistent, and mouse picking has the same 1-px resolution limit).
- **Perf/memory**: one clipped `drawImage` self-blit + a handful of
  `fillText`/`arc` calls per tick, no allocation, no persistent canvases (no
  `[mem]` ledger entry). Complies with the full-update-rate constraint.

## 2. Cursor Hiding (A4)

While `dragState === 'dragging'`: `canvas.style.cursor = 'none'` (the cursor
is redundant with the crosshair and covers map pixels). Restore the existing
hover behavior (`crosshair`/default) on release. One-line change in the
existing cursor logic in `setupMapDrag` / `pointerup`.

## 3. Selection Hygiene + Loupe Retirement (A5)

Ships in the same release as the magnifier — the suppression only becomes
acceptable once the replacement exists.

1. `.map-drag-confirm { user-select: none; -webkit-user-select: none; }` —
   covers pill text and buttons (the tz label already has it).
2. In `showKeepLocationDialog()`: one deferred
   `getSelection()?.removeAllRanges()` (a tick after show; immediate clears
   have known iOS quirks).
3. `#observatory-canvas { -webkit-user-select: none; user-select: none;
   -webkit-touch-callout: none; }` — kills the native loupe and the entire
   silent-selection pathway at the root. After this, items 1–2 are
   belt-and-suspenders, kept because they're free.

No other element's selectability changes in this phase.

## Risks / Open Tuning

- **In-band occlusion**: confining the bubble to the band means that on
  phones (bubble ≈ band height) it covers a large fraction of the band while
  dragging, including sometimes the true crosshair position — acceptable
  because the bubble *shows* that position magnified, but the toward-center
  offset and the dead-zone tuning decide how it feels. Evaluate on device.
- **Side-flip hysteresis**: the dead zone around band center X needs tuning so
  the bubble neither jumps sides abruptly nor lingers over the fingertip.
- **Self-blit source clipping**: the read region must be clipped to the band
  rect (pixels outside the band are dial/starfield); near band edges the
  bubble shows the clamped-edge window rather than a shrunken one.
- **Jumpiness** at phone input resolution — see smoothing knob.
- **Label pick quality** near dense metro areas (which K, what dedupe radius)
  — tune with real data; the `findLargestCityNear` population-bias precedent
  applies.
- `user-select: none` on the canvas is global to the element: confirm no
  regression for the help popover / dialogs (separate DOM subtrees — expected
  unaffected).

## Verification

Headless (Browser pane, per established recipes: dist server on a fresh port,
`?lat=&lon=` to skip the dialog, verify the build stamp):

- Probe the band rect (cursor grid-scan), dispatch pointerdown/move/up
  sequences; screenshot: bubble present during drag, absent after release;
  bubble reflects day/night state (compare a daytime vs nighttime longitude).
- **Bounds sweep**: drive the drag point across a grid covering the whole band
  (including edges/corners) and assert the bubble rect ⊂ band rect at every
  sample; along a horizontal sweep, assert the bubble-center path is
  continuous (no teleports larger than the per-move pointer delta plus the
  slide allowance).
- `getComputedStyle` checks for the new `user-select` / `touch-callout` rules;
  cursor `none` during drag, restored after.
- Simulated lift over the pill: assert `getSelection().isCollapsed` after
  `showKeepLocationDialog()`.

On device (Steve, dist.zip flow):

- Long-press + drag on the band: **no** iOS loupe, no full-display block
  selection from a left-half press, bubble visible and surviving drifts off
  all four band edges, no selected text in the pill on lift (tap Keep/Revert
  once, immediately).
- Feel pass: bubble size, span, smoothing, occlusion.

No unit-test surface changes expected beyond a possible small test for the new
`citiesInBBox` helper.
