# Observatory: Merge the Three Full-Viewport Static Caches

**Status**: IMPLEMENTED 2026-08-28 (build 2.0.111) — uncommitted, pending review.
Verified: before/after pixel-diff harness (exact after the sun fix-up; ~115 px of
invisible raster noise, see Implementation Findings), full-app render + [mem]
ledger (screen 16.8 + static cache 16.8 MiB at 1280×860@2x), noon-toggle snap,
resize/anchor switch, A/B vs pre-change engine, tsc + 8692 tests + build.sh.
**Created**: 2026-08-26
**Baseline**: 9462ca9 "Update docs with info about the size of the astronomy tables"

## TL;DR

Observatory keeps three full-viewport OffscreenCanvas static caches — starfield
background (background.ts:76), main dial (main-dial.ts:108), peripheral dials
(peripheral-dials.ts:326) — blitted back-to-back with nothing drawn between them
(observatory-entry.ts:395-410), after an unconditional black `fillRect` clear
(observatory-entry.ts:385-387). Merge them into **one** cache canvas that is always
non-null and always fully opaque. Per-frame static work drops from 4 full-viewport
ops to 1; cache memory drops 3× (at 8K: ~380 → ~127 MiB). Full-viewport canvas
surfaces go 4 → 2, halving full-viewport bitmap memory on **every** monitor (at 8K:
~506 → ~253 MiB). The three modules keep their draw code and image loading; only the
cache storage/invalidation moves.

## Problem

Motivation: 8K kiosk mode (Mac mini M4 → 8K TV over HDMI, dpr 1). At 7680×4320 each
full-viewport RGBA surface is 126.6 MiB, and the static layer costs four full-viewport
raster ops per frame before any dynamic drawing. This merge is an op-count/memory
lever, not a resolution trade — full-res stays untouched. It pays off at 4K/5K too.

Every frame while the clock runs (kiosk mode = `continuous` true,
observatory-entry.ts:590-596), drawFrame does:

1. Black `fillRect` over the whole canvas (observatory-entry.ts:385-387).
2. `getBackgroundCache(L)` blit, null-guarded (395-398).
3. `getMainDialCache(L, noonOnTop)` blit, null-guarded (403-407).
4. `getPeripheralDialsCache(L)` blit, unconditional — never null (409-410).

Nothing is drawn between the blits, and all three caches are identically sized
`viewW*dpr × viewH*dpr` (matching `canvas.width/height` exactly). At 8K that is
~133 Mpx of writes per frame for content that changes only on resize or a
noon-toggle, and 380 MiB of cache backing store.

The three modules also disagree on bookkeeping, which the merge must unify:

- **Keys** (none is a superset of another):
  background `viewW×viewH:dpr` (background.ts:53-55);
  main-dial `viewW×viewH:mainR:noonOnTop`, no dpr (main-dial.ts:84-86);
  peripheral `viewW×viewH:altR:eotR`, no dpr, no centers (peripheral-dials.ts:316-318).
  Key-completeness today leans on resizeCanvas() force-invalidating all of them on
  every real geometry change (observatory-entry.ts:347-350), not on key equality.
- **Nullability**: background and main-dial return null until their images load;
  peripheral never does. So at startup the user sees peripheral dials before the
  starfield/dial images arrive — incidental behavior, released per review (see
  Resolved During Review #1).
- **Invalidate semantics**: peripheral nulls its canvas (peripheral-dials.ts:341-344);
  the other two only clear the key string.
- **noonOnTop** self-invalidates via the main-dial key only — the toggle sites
  (observatory-entry.ts:958-968, 1389-1396) call no invalidator. Documented at
  observatory-entry.ts:899-903 and docs/observatory.md:635-637.

## Approach

### 1. Export plain draw functions from the three modules

Each module keeps its drawing code and (where applicable) image loading, and loses its
cache state:

- `background.ts`: export `drawBackground(ctx, L)` (the current build body, lines
  81-105 — **draws in raw device pixels, no dpr scale**; keep that) and
  `isBackgroundReady(): boolean` (current `imageLoaded && backgroundImg &&
  naturalWidth > 0` gate, lines 68-70). Keep `waitForBackgroundImage()`.
- `main-dial.ts`: export the existing `drawMainDial(ctx, L, noonOnTop)` (draws in
  logical units, caller pre-scales) and `areDialImagesReady(): boolean`
  (current `imagesLoaded`, line 98). Keep `waitForImages()`. Drop the dead
  write-only `cacheNoonOnTop` (line 78).
- `peripheral-dials.ts`: export `drawPeripheralDials(ctx, L)` wrapping the four
  existing draws (Altitude/Azimuth/EOT/Eclipse-ring, drawn in logical units).

Remove `getBackgroundCache`/`getMainDialCache`/`getPeripheralDialsCache` and the three
`invalidate*Cache` functions. observatory-entry.ts is their sole consumer (verified by
repo-wide grep; no test references any of them).

### 2. One merged cache module: `src/observatory/static-cache.ts`

```
let cache: OffscreenCanvas | null = null;
let cacheKey = '';

key(L, noonOnTop) =
  `${L.viewW}x${L.viewH}:${L.dpr}:${L.mainR.toFixed(1)}:${L.altR.toFixed(1)}` +
  `:${noonOnTop}`

getStaticCache(L, noonOnTop): OffscreenCanvas   // never null
invalidateStaticCache(): void                    // cacheKey = '' only; keep canvas
```

Build order inside the cache (preserves today's z-order exactly):

0. `ctx.setTransform(1, 0, 0, 1, 0, 0)` — unconditional, before anything else.
   Today every rebuild gets a brand-new OffscreenCanvas and therefore a fresh
   identity context (background.ts:76, main-dial.ts:108, peripheral-dials.ts:326);
   the reuse path below (Allocation reuse) removes that guarantee, so a leftover
   transform from any future unbalanced save/restore in the draw code must be
   neutralized here rather than trusted away.
1. Opaque black fill over the whole canvas (device px). This is the always-there
   base — it makes the **non-null ⇒ fully opaque** contract unconditional, which is
   what lets drawFrame drop its per-frame clear (§3). (When the background image is
   ready its own black fill + cover-cropped draw repaints this; harmless.)
2. `if (isBackgroundReady()) drawBackground(ctx, L)` — device-px space.
3. `ctx.save(); ctx.scale(dpr, dpr)`.
4. `if (areDialImagesReady()) drawMainDial(ctx, L, noonOnTop)`.
5. `drawPeripheralDials(ctx, L)` — unconditional, as today.
6. `ctx.restore()`.

Key design points:

- **Union key, geometry-only.** The union (`viewW, viewH, dpr, mainR, altR,
  noonOnTop`) covers every field any of the three old keys tracked. (`eotR` is
  omitted: `altR === azR === eotR` in every layout branch, and `eclipseR1/R2` +
  ext/eot font sizes are re-derived from `altR` alone in applyAnchor's unconditional
  tail, anchor-layout.ts:866-884 — `altR` pins them all. If that invariant ever
  breaks, the anchor-layout change is the place that must know — §4 puts guard
  comments at every one of those sites.) Real geometry
  changes remain covered primarily by the explicit invalidate in resizeCanvas(),
  same as today — the key is the defensive check, not the primary trigger; this
  merge must not start leaning on key equality for footer-wrap/safe-area changes
  the old keys never captured either.
- **Image arrival = one explicit invalidate.** The builder draws whichever layers
  are ready at build time (steps 2 and 4 consult the readiness accessors), and the
  existing image-load handler (observatory-entry.ts:1490-1497) repoints its
  `invalidateMainDialCache()` to `invalidateStaticCache()` — now the sole,
  load-bearing rebuild trigger for image arrival (its `scheduleFrame()` stays).
  Readiness is deliberately NOT in the cache key: per review, the
  peripheral-dials-before-images startup ordering is not a behavior we need to
  preserve. In practice it's mostly preserved anyway — a pre-image build still
  shows black + peripheral dials, and since all images resolve close together the
  intermediate state is near-undetectable. On image error the promises still
  resolve (background.ts:36, main-dial.ts onerror), so the rebuild always fires and
  the readiness accessors settle stably — no rebuild thrash. `__appReady` timing
  (observatory-entry.ts:569-572) is unaffected.
- **Allocation reuse**: `invalidateStaticCache()` clears the key only. On rebuild,
  if device-pixel dims are unchanged, redraw into the existing canvas (step 0
  resets the transform, step 1's opaque fill makes a clear unnecessary); if dims
  changed, resize via `cache.width/height =` rather than `new OffscreenCanvas` —
  never holds two full-viewport canvases at once. At 8K that avoids a 127 MiB
  realloc + GC churn per resize/toggle.
- **noonOnTop toggle now rebuilds all three layers** instead of just the main dial.
  Redraw only — none of the three draws touch time, location, or ObsValues
  (drawMainDial is a pure function of geometry + the flag; background and
  peripheral are pure geometry/image), so no part/astro recomputation is involved;
  the toggle's `updater?.reset()` is unchanged from today. The added work is the
  background cover-draw + the peripheral vector pass — roughly one frame's worth of
  today's per-frame static budget (which already moves ~4 full-viewport ops every
  frame), one time per toggle. Any machine sustaining the animate framerate today
  absorbs it invisibly.

### 3. Rewire observatory-entry.ts

- drawFrame: delete the `fillRect` clear (385-387) and replace the three blits
  (395-410) with one `ctx.drawImage(getStaticCache(L, noonOnTop), 0, 0)`. Safe
  because the cache is never null and fully opaque edge-to-edge (§2 step 1); all
  contexts are default alpha:true, plain source-over.
- resizeCanvas (347-350): the three invalidations collapse to
  `invalidateStaticCache()`; **keep `invalidateRingCache()` exactly where it is** —
  the rise/set ring cache (a documented no-op, ring-view.ts:519-522, also called
  alone from rebuildEnvFrozen at observatory-entry.ts:713) is out of scope and must
  not get conflated with the merged static cache. The invariant to preserve,
  stated precisely: a location/tz/drag change **via rebuildEnvFrozen itself** must
  not invalidate the merged cache. (A drag can still reach resizeCanvas
  indirectly, today and after: applyTemporaryLocation rewrites `#location-name`
  on pointermove (observatory-entry.ts:1004, 1012, 1023), and a label-length
  change can re-wrap `#obs-footer-row`, whose ResizeObserver
  (observatory-entry.ts:1328-1329) funnels into resizeCanvas. Pre-existing,
  identical for the old three caches; not a merge regression.)
- Image-load `.then` (1490-1497): `invalidateMainDialCache()` →
  `invalidateStaticCache()`; keep `scheduleFrame()`. This call is now load-bearing
  (see §2) — it is what brings the starfield + dial into the cache once images
  arrive.
- noonOnTop toggle sites: unchanged — the merged key contains `noonOnTop`, so the
  self-invalidation contract carries over 1:1.
- Remove the vestigial `needsStaticRedraw` (declaration observatory-entry.ts:356,
  write-only assignments :351 and :714 — read nowhere; per review, drop it).

### 4. Divergence-guard comments at the subdial size definitions

The merged key tracks `altR` alone on the strength of two invariants enforced only
in layout code: `altR === azR === eotR` in every branch, and `eclipseR1/R2` +
ext/eot font sizes re-derived from `altR` in applyAnchor's unconditional tail. Per
review, add a one-line comment at **every** site that assigns these (layout.ts:852-
856; the anchor-layout.ts branch assignments — the sweep found :429, :572, :636,
:683, :780-784, :831-835; and the applyAnchor tail at anchor-layout.ts:866-884 —
re-grep at implementation time in case branches moved), along the lines of:

```
// alt/az/eot radii must stay equal (and eclipse/font sizes derived from altR):
// static-cache.ts keys on altR alone. If these ever diverge, extend that key.
```

### 5. One-shot canvas ledger log (`[mem]`)

Observatory has no memory instrumentation today (the `[mem]` ledger is
Chronometer-only, engine-entry.ts:1229). Per review, add a small one:

- A helper in observatory-entry.ts that estimates every canvas/bitmap Observatory
  holds at w×h×4: the visible canvas, the merged static cache, earth-view's
  `maskCanvas`/`dayMaskCanvas` (earth-view.ts:233, :705), and whatever else a
  grep for canvas allocations in src/observatory/ + the shared modules it uses
  turns up at implementation time (moon view, mini-map texture, hand caches).
- Printed once, after the image-arrival rebuild (so sizes are final), in the
  engine's format with the build stamp:
  `[mem] build N.N.N · observatory canvas est TOTAL X MB: screen A · static cache
  B · earth masks C · …`. Chrome-only JS heap appended as in engine-entry.ts.

### 6. Docs

docs/observatory.md: source-layout table lines 12-13, 20 (three "(static cache)"
tags → one merged-cache note + new static-cache.ts row); the Peripheral Dials
architecture block (554-567, describes its own full-viewport cache); the Noon-on-Top
sentence (635-637, names `getMainDialCache(L, noonOnTop)`). While editing the
Peripheral Dials section, also fix two pre-existing staleness bugs there: the
architecture block omits `drawEclipseDial` (peripheral-dials.ts:296-307, drawn
unconditionally at :332-335), and lines 551-552 still claim the eclipse slot is
"intentionally empty, deferred" — contradicted by the code and by the doc's own
Eclipse Simulator section (684-689). docs/performance.md and docs/rendering.md
contain no Observatory content — no changes.

## Implementation findings (2026-08-28)

Two things surfaced during the pixel-diff verification (before/after harness per
the canvas-verify recipe), both now handled:

- **The sun's `lighten` composite is destination-dependent** — the one op in the
  static stack that isn't source-over (main-dial.ts step 8: sun.png is RGB with a
  black matte; 'lighten' erases it). Against the merged canvas it also blended
  with the starfield, where the old pipeline blended against the dial layer's
  transparent-backed content and composited the result over the stars
  (dimming stars under the matte — the iOS-faithful reference). Without a fix
  this was the entire visible diff (~46k px, Δ up to 139). Fix implemented in
  static-cache.ts `fixUpSunRegion()`: render the dial layer alone into a
  sun-box-sized scratch (device-pixel-aligned), then splice it over a repainted
  background patch. Exact; scratch is ~1 MB and transient.
- **Irreducible raster noise**: after the sun fix, before/after differ by ~115
  isolated pixels (of 6M, Δ ≤ 22, sign both ways) on near-tangent arc AA edges
  (orbit circles grazing subdial rims) and scaled-image edges — Skia rasterizes
  the same path with slightly different AA coverage depending on the canvas's
  draw batch. Verified visually indistinguishable at 4× zoom; not fixable while
  actually merging the canvases; expected to vary across Chrome versions/GPUs.

## What this buys

Per full-viewport RGBA surface: 4K 31.6 MiB · 5K 56.2 MiB · 8K 126.6 MiB.

| | surfaces (visible + caches) | 8K total | per-frame static ops |
|---|---|---|---|
| today | 1 + 3 | ~506 MiB | clear + 3 blits (~133 Mpx writes) |
| after | 1 + 1 | ~253 MiB | 1 blit (~33 Mpx) |

All four surfaces are identically `viewW*dpr × viewH*dpr`, so the 4 → 2 halving of
full-viewport bitmap memory holds on **every** monitor, not just 8K. Observatory's
remaining offscreen bitmaps (earth-view night/day masks, moon view, per-hand
caches) are region-sized — small against a full-viewport surface — so total
onscreen+offscreen canvas memory is very nearly halved as well; the new `[mem]`
log (§5) shows the exact split.

## Explicitly not changing

- **ring-view.ts** and its invalidateRingCache (fourth, dynamic-ish cache) — stays
  independent, same call sites.
- Dynamic per-frame layers (peripheral-hands.ts, eclipse-view.ts, ring-view.ts,
  moon/earth/date views) — untouched; they keep drawing on the live context after
  the single blit, inside the same dpr-scaled block (observatory-entry.ts:413+).
- The three modules' image-loading machinery and `waitFor*` promises.
- Full resolution / full update rate — this is op-count only (no dpr1, no buffering
  of moving parts).
- Kiosk frame-rate cap — separate lever, separate discussion.

## Risks

- **Stale-cache bugs from key unification** — the main risk. Mitigation: the union
  key strictly dominates all three old keys (incl. dpr, which two of three omitted
  — a pre-existing latent gap this fixes), and the explicit invalidate-on-resize
  path is kept as the primary trigger, same shape as today.
- **noonOnTop toggle cost** grows from main-dial-only to full rebuild (~one extra
  33 Mpx image draw + vector pass at 8K, once per toggle). If it visibly hitches on
  low-end hardware we can revisit; not expected to. Same shape at startup: the
  image-arrival invalidate rebuilds all three layers instead of one — a single
  one-time startup cost, negligible against steady-state savings.
- **Canvas reuse makes context state persistent** across rebuilds — a new
  invariant, moot today because every rebuild starts from a fresh canvas. Step 0's
  unconditional `setTransform` is the guard; without it, a future unbalanced
  save/restore anywhere in the draw code would compound across same-size rebuilds.
- **Behavior change window at startup**: released per review; verify only that the
  final state is complete — no permanently missing layer (Testing #3).
- The `altR`-pins-everything invariant (anchor-layout.ts:866-884) becomes
  load-bearing for the merged key. It already silently underpinned peripheral's old
  key; the merged key's comment should state it so a future anchor branch that
  breaks it knows where to look.

## Testing

No unit test references any of the three cache modules (repo-wide grep; the
regression/golden suite is Chronometer-only), so verification is visual/manual:

1. **Pixel-identical check** (canvas-verify-without-raf recipe): one-shot draw
   harness renders Observatory at 2-3 viewport sizes before (git stash) and after;
   diff PNGs. Steady-state frames must be identical.
2. Build via build.sh, serve dist on a fresh port, confirm the `build N.N.N` stamp.
3. **Startup completeness** with images throttled (devtools): all layers present
   once loading settles — no permanently missing starfield/dial. The intermediate
   ordering is not contractual (released per review); also check the image-error
   path (block one image) leaves a stable, non-thrashing partial render.
4. **Noon toggle**, resize/orientation, fullscreen toggle, footer-row wrap, location
   drag + tz change, sleep/wake catch-up. For the drag case, watch a build-counter
   log that also names the trigger: rebuilds must come only from resize-path
   invalidations (including a legitimate footer-wrap during drag — see §3), never
   from rebuildEnvFrozen itself. Pin the test window width away from a footer wrap
   boundary to keep the signal clean.
5. Memory: canvas surface count 4 → 2 in a heap snapshot, cross-checked against the
   new `[mem]` log (§5).
6. Perf sanity on the 240Hz machine via dist.zip if desired — expectation is
   strictly fewer ops/frame, so no perf gate needed for landing. Development-rules
   §18 (perf-regression check) is scoped out explicitly: this touches Observatory's
   static-blit path, not the astronomy/cache-pool/updater/eval hot path §18
   enumerates, so `perf-regression.ts` (a Chronometer scrub-cost gate) isn't the
   applicable instrument.

## Resolved During Review (2026-08-28)

1. Startup layer-ordering (peripheral dials first) — **released**. Consequence:
   readiness bits dropped from the cache key; the image-load handler's invalidate is
   repointed to `invalidateStaticCache()` and becomes the sole image-arrival rebuild
   trigger (§2, §3). This also settles the old Open Question about that handler's
   redundant `invalidateMainDialCache()`: it doesn't survive as-is — its replacement
   is load-bearing.
2. `needsStaticRedraw` — **remove in passing** (§3).
3. `[mem]` ledger log — **add** (§5).
4. Subdial-size divergence — **guard comments at every assignment site** (§4).
5. Memory framing confirmed: full-viewport surfaces 4 → 2 on all monitors; total
   onscreen+offscreen canvas memory very nearly halved (What This Buys).
6. noonOnTop toggle cost confirmed as **redraw-only** — no part/astro recompute;
   bounded by ~one frame of today's per-frame static budget (§2, Risks).
