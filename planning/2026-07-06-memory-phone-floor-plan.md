# Plan: memory / phone-floor reduction (orthogonal to scrub-perf)

**For a fresh session.** This is the memory track called out but never pursued
during the scrub-perf work — see "Device targets & memory ledger" in
[2026-07-03-scrub-render-perf-investigation.md](2026-07-03-scrub-render-perf-investigation.md)
and the constraints in [docs/performance.md](../docs/performance.md). It is
independent of the rendering/fps work (that's done: Chrome ≥60, Safari
characterized).

**Goal:** the 100 MB-floor device tier (must run at ≥10 fps in ≤~150 MB) and the
4K/5K ceiling (~500 MB budget). The `[mem]` ledger line in every scrub summary
tracks canvas/bitmap bytes; Chrome prints JS heap; for Safari/iPhone append
`[mem] Safari process RSS: NNN MB (Activity Monitor)` manually.

## Read first — current state is NOT what the handoff says (verified 2026-07-06)

The handoff's phone-floor bullet listed three levers. **Two are already
implemented** — the note was stale. Confirm, then don't redo them:

- **Release face-data base64 `dataUrl`s after decode — DONE.**
  [engine-entry.ts](../src/engine-entry.ts) ~606–611: after
  `createImageBitmap`, `fd.images = null` and `delete window.ChronometerFaces`
  drop the retained base64 strings.
- **Lazy city load/parse (the "do what Observatory does" item) — DONE.**
  Chronometer already uses the Observatory model from
  [2026-06-14-observatory-cities-lazy-load.md](2026-06-14-observatory-cities-lazy-load.md):
  `prefetchCityData()` at startup downloads the ~7.5 MB gz blob but does **not**
  parse it; `loadCityData()` parses the ~22 MB columnar form only on demand
  (reverse-geocode / dialog); `releaseCityData()` drops it after. The handoff's
  "chronometer still eager-parses 167k cities" is wrong — that was the
  pre-June-2026 state. (Sanity check: on `all.html?lat=&lon=` you'll see
  `[CitySearch] Loaded …` then `Released parsed city data` in the console — a
  one-shot parse for the coords→city lookup, then freed.)

**So the first task is to re-measure**, not to assume the June table. Load a
phone profile (VM viewport 375×667 at dpr 2, or better, a real iPhone via
`dist.zip` + Safari RSS) and read the actual resident breakdown.

### Measured baseline (2026-07-06, VM phone profile — memory geometry is VM-valid)

`all.html` at 375×812, dpr 2, faces **104 px CSS / 208 px backing**, build
2.0.29:

```
[mem] canvas/bitmap est TOTAL 96.3 MB: faces 2.6 · static caches 3.1 ·
      images 82.3 · shadows 0.0 · wedge 0.1 · wheel 0.3 · hand 0.5 ·
      analemma 0.9 · terra ring 6.5 · face buffers 0.0 · shared 0.0
      · JS heap (Chrome-only): 115.8 / 131.9 MB
```

- **Images = 82.3 MB = 85% of the canvas total**, and it is **identical at
  every viewport** (82.3 at phone 104 px faces == 82.3 at 4K 1070 px faces) —
  the resolution-independence that makes it the lever. Everything geometry-
  scaled (faces 2.6, static 3.1, wheel 0.3, hand 0.5) is already tiny on phone.
- `terra ring` 6.5 MB is the second item — a fixed `worldtimeRingBackground-4x`
  (1208×1417) knockout, also viewport-independent; a secondary target.
- JS heap 116/132 MB is Chrome-VM only; a real phone runs Safari — measure RSS
  natively before treating heap as a target.

### Why the lever is large (source vs display size)

The face-background images are **`-4x` assets built for 4× retina** — ~1120×1120
(≈1.25 Mpx ≈ 5 MB decoded each): `vienna/face-4x`, `terra/face-4x`,
`gaia/face-4x`, `geneva/faceFront-4x`, `mauna-kea/astro-face-4x`,
`selene/…-4x`, etc. On the phone grid each face is **208 px backing** → those
are decoded ~**(1120/208)² ≈ 29× oversized**. Total decoded budget is
82.3 MB / 4 = ~21.6 Mpx; the bulk is these oversized backgrounds. Decoding at
display size on the phone grid should take images from ~82 MB toward
**order-of ~10 MB** (roughly 8×), dropping the phone canvas floor from ~96 MB
to ~25 MB. (Exact figure depends on the per-context sizing policy below — this
is an order-of-magnitude, not a promise.)

**As a share of overall phone memory** (~72 MB saved): that's **~75% of the
canvas/bitmap ledger** (96 → ~25 MB), or **~a third (≈34%) of total estimated
resident** (canvas 96 + JS heap 116 ≈ 212 MB → ~140 MB — ImageBitmaps live
outside `usedJSHeapSize`, so the two pools are roughly additive). That crosses
the phone under the ~150 MB floor-tier headroom. Caveat: the heap figure is
Chrome-VM; confirm against native Safari RSS before quoting the total-% number.

## The one real remaining lever: decode images at display size

**Problem:** [engine-entry.ts:271](../src/engine-entry.ts) calls
`createImageBitmap(blob)` with no resize options, so every face's artwork is
decoded at **full source resolution** — ~82.3 MB of `ImageBitmap`s that is the
same on a phone (faces ~160 px) as on a 4K monitor (faces ~1070 px). On the
phone floor this is the dominant cost and almost entirely waste.

**Fix:** decode to the actual on-screen size via
`createImageBitmap(blob, { resizeWidth, resizeHeight, resizeQuality: 'high' })`,
sized to the rendered face px × dpr × the per-image `scale`. On `all.html` at
phone size this could cut the image footprint several-fold.

**Complications (this is why it wasn't trivial):**
- **Face size varies by page and layout:** `all.html` renders faces small,
  single-face pages large. Decoding for a small layout and then painting a face
  large would violate the **full-resolution hard constraint**
  ([docs/performance.md](../docs/performance.md)) — blurry artwork is not
  acceptable. So decode to the *current* layout's face size.
- **There is no separate zoom path.** The app has no explicit zoom, and browser
  magnification just triggers a **relayout so everything still fits** (verified
  2026-07-06) — the face backing px tracks the layout, same as a window resize.
  So the only re-decode triggers are **initial page load** and **relayout**
  (window resize / browser magnification). Nothing during scrub or normal
  interaction. That makes the added latency very acceptable: a one-time decode
  on load (already paid today) and a re-decode on resize.
- Preserve the per-image `scale` factor already threaded through
  `LoadedImage`/`loadImagesFromFaceData`.

**De-risking — RESOLVED, both engines confirmed:**
- **Chrome (VM, 2026-07-06):** `createImageBitmap(blob, {resizeWidth:208,
  resizeHeight:208, resizeQuality:'high'})` on a 1120×1120 source returns a
  genuine 208×208 bitmap — **0.17 MB vs 4.8 MB, 29× smaller**, no error.
- **Safari (native, 2026-07-07): HONORED** — same test returned `[208, 208]`.
  WebKit respects the resize options, so **use the simple direct path**; the
  canvas-downscale fallback is NOT needed. (Phones run WebKit — this was the
  make-or-break check, now passed.)
- No remaining mechanism risk. What's left is purely the sizing policy +
  native memory/visual verification during implementation.

### Resolved decisions & mechanics (2026-07-07, confirmed with Steve)

Verified against the actual draw path before locking these in.

**Scope — resize ALL loaded bitmaps, sized to their on-screen footprint** (not just
the face backgrounds). One uniform code path: every image decodes to the physical px
it actually occupies. This auto-covers the 82 MB backgrounds *and* the 6.5 MB terra
ring and anything else oversized; small assets (logos, moon/phase icons) already
occupy few px so they decode tiny with negligible churn. There is no explicit "is
background" flag, so a backgrounds-only scope would have needed a heuristic anyway —
uniform is both simpler and more complete.

**Decode size — exact 1:1** (no resolution headroom). Decode to exactly the face's
current physical px; re-decode on relayout restores sharpness when the face grows.
Accepted tradeoff: a brief soft-focus window (~150 ms resize debounce + the async
decode) right after an *enlarging* resize/rotation before the sharp bitmap lands.
Chosen over a ~1.4× headroom because the phone floor is the whole point — 1:1 gives
~10 MB images on phone vs ~20 MB at 1.4×.

**`scale` is load-bearing — rewrite it on every decode.** Every draw site sizes the
image as `bitmap.width * scale`: [renderer.ts:2587](../src/watch/renderer.ts) (StaticPart
image), [:2631](../src/watch/renderer.ts) (image hand), the terra-ring knockout
[:3269](../src/watch/renderer.ts), and the analemma disc
[analemma.ts:535](../src/watch/analemma.ts). So a smaller decode **must** rewrite the
stored scale to `originalScale × (sourceW / decodedW)` to hold `bitmap.width × scale`
invariant. Do that once and **no draw site changes** — the whole change stays in the
loader + resize path. Get it wrong and every face paints at the wrong size. The
`[mem] images` ledger ([engine-entry.ts:1196](../src/engine-entry.ts)) sums `bitmap`
bytes, so the win reports there directly.

**Keep the compressed `Blob` to enable re-decode.** Today the blob is discarded right
after `createImageBitmap` and `fd.images` is nulled
([engine-entry.ts:271](../src/engine-entry.ts), [:608](../src/engine-entry.ts)) — so
after load there is *nothing* to re-decode from. Re-decode on relayout requires
retaining the compressed `Blob` in `LoadedImage` (still dropping the base64 dataUrl
string, as the "release dataUrls — DONE" item does). Cost is tiny: **~10.8 MB** of
compressed PNG across all 16 faces, vs the ~72 MB of decoded bitmap removed (82 → ~10
on phone). This does *not* undo the dataUrl-release win — the base64 string (4/3 the
size, and the larger of the two) still goes.

**Avoid a transient full-decode spike on the phone floor.** Sizing a decode needs the
image's intrinsic dimensions. The naive "full-decode then downscale" would briefly
spike to ~82 MB mid-load — which could itself OOM the very floor we're protecting.
Read intrinsic dims from the PNG header (IHDR; all face assets are PNG) — or, if a
non-PNG ever appears, decode + `close()` one image at a time so the peak stays bounded
to a single image.

**Sizing for multi-use / animated images.** Images are per-face (`allImages[i]`, no
cross-face sharing). If a src is drawn at more than one size within a face (reused
part, or an animated `part.scale`), size the decode to the **max** footprint so
nothing ever under-resolves.

**Where it hooks.** The resize path is already async per-face
(`onGridResize → applySize → buildAllCachesSequentially → buildCache`,
[engine-entry.ts:2281](../src/engine-entry.ts)). Insert the per-face re-decode there,
before `buildStaticBlockCaches`, awaiting the decode(s) for that face. Triggers are
**initial load** and **relayout only** (window resize / browser magnification, which
relayouts to fit — verified) — nothing during scrub or normal interaction.

**Out of scope: the one-canvas ablation** (`?ablate=onecanvas`,
[engine-entry.ts:887](../src/engine-entry.ts)) is a debug-only path and the idea has
been rejected for now — do **not** spend effort making the re-decode play with it.

**Verification:**
- **Memory:** `[mem] images` line drops on phone/laptop profiles. The authoritative
  number is native Safari **RSS** on a real iPhone (`dist.zip` + Activity Monitor);
  the Chrome-VM heap is directional only.
- **Quality (this is a quality-sensitive change):** visually confirm every face stays
  sharp at its rendered size, on `all.html` *and* on a single-face page, including
  after a resize/rotation (frozen-time screenshots at a couple of sizes). Steve should
  eyeball it natively.
- **Scrub-perf regression (required):** run the perf-regression harness **before and
  after** this change and compare — the memory change must not significantly move
  scrub tick cost. It's the headless per-face warm-tick CPU-time runner (soft /
  reported, not gated):

  ```bash
  npx vitest run                                  # correctness — hard gate
  npx tsx src/__tests__/perf/perf-regression.ts   # perf — read TOTAL Δ + any ⚠ slower / ✓ faster
  ```

  See [docs/perf-regression.md](../docs/perf-regression.md). Re-decode fires only on
  load/relayout, never during scrub, so no per-tick delta is *expected* — this guard
  confirms the smaller bitmaps didn't perturb draw/tick cost. Capture the before-run
  on the current tree first so there's a diff to read (don't `--capture` a new
  baseline unless the after-run is clean and Steve okays it). The authoritative
  in-browser scrub-fps / `[mem]` numbers still come native (240 Hz machine via
  `dist.zip`, `?probe`, verify the `build N.N.N` stamp) per
  [docs/performance.md](../docs/performance.md).

## Outcome (implemented 2026-07-07, build 2.0.30 — VM-measured, native still pending)

Implemented as decided above:
[image-loader.ts](../src/watch/image-loader.ts) gains `ImageSource` + `makeReDecodableImage`
+ `decodeLoadedImageForScale` (retain compressed blob, PNG-header dims, 1:1
resize-decode, scale rewritten to hold `bitmap.width*scale`);
[engine-entry.ts](../src/engine-entry.ts) `loadImagesFromFaceData` retains blobs instead of
full-decoding, and a new `decodeFaceImages` runs per-face in the resize path
(`buildAllCachesSequentially`) before `buildCache`, invalidating the terra-ring
knockout on re-decode. The `[mem]` ledger gained a `src blobs` line.

**Phone `all.html`** (375×812, faces ~208 px backing), `[mem]` canvas/bitmap TOTAL:

| component   | baseline 2.0.29 | now 2.0.30 |
|-------------|-----------------|------------|
| images      | 82.3 MB         | **3.0 MB** |
| terra ring  | 6.5 MB          | **0.2 MB** |
| src blobs   | —               | 8.8 MB (new, retained) |
| **TOTAL**   | **96.3 MB**     | **19.6 MB** |

Images fell **27×** (better than the ~10 MB estimate — the phone grid's faces are
tiny); the uniform scope captured the terra-ring secondary lever for free. Net
canvas ledger **96 → 19.6 MB**.

- **Scales up correctly:** single-face `selene.html` at 1400 px → `images` 4.7 MB
  (vs 3.0 for all 16 on phone), proving true 1:1 sizing, not a flat cap.
- **Quality:** faces sharp on `all.html` at phone size, after a 375→1400 resize
  (re-decode, no errors), and on a large single-face page (moon disc + fine dial
  text crisp).
- **Correctness:** `npx vitest run` — 8519/8519 pass (incl. bit-identical terra/selene).
- **Scrub-perf regression:** no effect — the harness never touches the image path.
  Verified by stashing the change: pre-change TOTAL +15.5% vs baseline, post-change
  +15.9% (∆ within run-to-run noise). That ~+15% is a **pre-existing** VM-vs-Steve's-machine
  gap (harness self-calibration 0.89×), not this change.
- **Still pending:** native Safari **RSS** on a real iPhone (the authoritative memory
  number) and a native eyeball of sharpness — Steve's device.

## Smaller / ceiling-only levers (lower priority)

- **Static caches (83 MB at 4K)** — scales with face px, so it's only ~2 MB on
  the phone floor. A **4K/5K-ceiling** lever, not a phone-floor one; audit only
  if pushing under the 500 MB ceiling. See the Device-targets matrix.
- **Cities blob trim** — the resident ~7.5 MB compressed blob is mostly alt-name
  transliterations; trimming them (deferred in the Observatory lazy-load doc's
  Outcome section) would shrink it. Minor; affects all tiers equally.

## Constraints (inherited)

Full resolution is a **hard product constraint** — the image-decode lever must
decode at enough resolution for the largest view the user can reach, never
below it. This is the whole reason the fix is "size to context + re-decode on
demand" rather than a flat downscale.

## Key references

- [2026-07-03-scrub-render-perf-investigation.md](2026-07-03-scrub-render-perf-investigation.md) — "Device targets & memory ledger" (the matrix, targets, `[mem]` ledger).
- [2026-06-14-observatory-cities-lazy-load.md](2026-06-14-observatory-cities-lazy-load.md) — the cities lazy model (already ported to chronometer; precedent for on-demand + release).
- [2026-06-12-observatory-memory.md](2026-06-12-observatory-memory.md) — Observatory's original memory-reduction levers.
- [docs/performance.md](../docs/performance.md) — hard constraints, measurement mechanics (native vs VM, build stamp, `[mem]`).
