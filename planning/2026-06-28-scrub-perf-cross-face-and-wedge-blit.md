# Scrub Performance, Round 2: Cross-Face Cache Sharing + Wedge Blit

**Date:** 2026-06-28
**Status:** 📋 Planned. Instrumentation (Part A) implemented **and measured** —
the baseline **refutes Part B** and **confirms render (Part C) as the prize**. See
"Baseline measurement" below; Parts B/C rewritten accordingly.

## Baseline measurement (2026-06-28, Chrome, all.html, 16 faces @ 511px)

```
Frame CPU split (99 scrub frames): tick avg 12.22ms, render avg 13.40ms
Master rise/set search: 745 computes / 65507 calls (7.5 computes/frame, 99% hit),
  0.035ms/search, 0.26ms/frame, 26ms total
Tick attribution: update 12.19ms [eval 10.57 · boundary 0.94 · interp 0.16 · rest 0.53],
  13.7µs/eval (76230 evals)
Ticked: 1563 obsValues across 16 faces (98/face); ~1310 wedge evals/tick
```

**What it says:**
- **render = 13.40ms (~52%)** of the frame — the single biggest lever. ✅ Part C.
- **tick eval = 10.57ms (~41%)**, spread over ~770 evals/frame at **13.7µs/eval**;
  **86% of all evals are day/night wedges** (65507 of 76230 calls reach the search).
- **the rise/set search is only 0.26ms/frame (99% cache hit)** — the within-face memo
  ([2026-06-28-daynight-wedge-memo.md](2026-06-28-daynight-wedge-memo.md)) already
  solved it. **Cross-face sharing would save a fraction of 0.26ms → Part B is dead.**

**Conclusion:** wedges dominate *both* halves (~1310/tick, ~82/face — expensive to
*evaluate* and to *draw*). The two worthwhile levers both target wedges:
**C (blit)** for the render half, and **a new LOD lever** for wedge *count*, which
attacks both halves at once and is especially apt on all.html where each face is
~128px and a 96-wedge ring is invisible detail. Part B (below) is retained only as a
record of why it was rejected.
**Follows:** [2026-06-28-daynight-wedge-memo.md](2026-06-28-daynight-wedge-memo.md),
which made the rise/set search run **once per ring per tick** *within a face*. This plan
extends the same single-cache philosophy **across faces**, and separately attacks the
**render** half of the frame, which is now the larger consumer on Chrome.

> **Directive (Steve, 2026-06-28):** reuse the **one** existing astro cache (the
> `AstroCache` slot system) rather than introduce a second memoization mechanism.
> Part B is therefore a *sharing* of the existing pool, not a new keyed `Map`.

## TL;DR

**Measured** (baseline below): on all.html the frame is **render 13.4ms (~52%)** + **tick
12.2ms (~48%)**, and **wedges dominate both halves** (~1310 wedge evals/tick). The rise/set
**search is already cheap** (0.26ms/frame, 99% cache hit), so the cross-face cache idea
(**Part B**) is **rejected**. The two real levers both target wedges:

1. **Part C — blit day/night wedges instead of re-tessellating them.** `drawQDayNightRing`
   ([renderer.ts](../src/watch/renderer.ts) L2638) issues `numWedges` (24–96) annular-sector
   paths per ring per frame — `beginPath → arc → arc → fill → stroke` each. Every wedge
   in a ring is **geometrically identical** (same inner/outer R, same span, same
   fill/stroke); only the rotation differs. Pre-render **one** wedge to an
   `OffscreenCanvas` and `drawImage` it rotated N times. This is the `refName` insight:
   parts sharing a `refName` share one backing image. Targets the 13.4ms render half.
   Same technique applies to the 119 `<QWedge>` parts.

2. **Part D — wedge-count LOD.** ~1310 wedges/tick scale *both* halves. On all.html each
   face is ~128px, where a 96-wedge ring is invisible detail. Cap `numWedges` by on-screen
   ring size → attacks the tick eval *and* the render at once, no astronomy parity risk.

(**Part B**, retained below for the record, would share one `AstroCachePool` across faces
instead of one per face — but the search it targets is 0.26ms/frame, so it's not worth it.)

## Part A — Instrumentation (✅ implemented)

Added lightweight counters around the master search so we can *measure* the cross-face
redundancy before refactoring, and confirm Part B's win after.

- [astro-env.ts](../src/shared/astro-env.ts): `export const astroProfile = { masterCalls,
  masterComputes, masterMs }` + `resetAstroProfile()`. `computeMasterRiseSet` bumps
  `masterComputes` and accumulates `masterMs`; `getMasterRiseSet` bumps `masterCalls`.
- [engine-entry.ts](../src/engine-entry.ts): `resetAstroProfile()` at scrub start; a new
  line in the `[scrub-perf]` end-of-session log:

  ```
  - Master rise/set search: <computes> computes / <calls> calls
    (<computes/frame>, <hit%> cache hit), <ms/search>, <ms/frame>, <total>ms
  ```

**How to read it.** Scrub `all.html` for a few seconds, stop, read the console.
- `computes/frame` ≈ the number of *distinct* searches the page does each tick **today**.
  With per-face pools this is roughly Σ over faces of (distinct planet rings on that face).
- After Part B it should drop to the globally-distinct `(planet, location)` count
  (~Sun+Moon+5 planets ≈ a handful), independent of face count.
- `ms/frame` is the astronomy wall-time the shared pool would (mostly) eliminate.
- Run with `?tickprofile` too, to keep the eval/boundary/interp split alongside.

## Part B — Single shared astro cache across faces — ❌ REJECTED (measured)

**The baseline kills this.** The master search is **0.26ms/frame at 99% cache hit**;
sharing pools across faces would recover only a fraction of that. The design below is
correct and was kept for the record (and in case a future change makes the search hot
again — e.g. a face that scrubs faster than slop, or reviving `dayNightLeafAngleForSlot`),
but it is **not worth implementing now**. Skip to Part C and the new Part D (LOD).

### Why it would have been correct (verified)

- **Same location for every ring.** ⚠️ **CORRECTION (2026-06-28, later):** this was WRONG.
  `dayNightLeafAngleForSlot` is absent from XML *text* but is **generated at runtime** by
  `buildDayNightRing` whenever a `QDayNightRing` carries `envSlot` — and **Gaia's four rings
  carry `envSlot='1'…'4'`**, so they DO compute per-city day/night at four different
  locations. So *not* every ring shares one `(lat, lon)`. (This doesn't change Part B's
  rejection — the master search is cheap regardless.) But it surfaces a real bug:
  `getMasterRiseSet` keys its `dayNightMaster*` slot by **`planetNumber` only**, not lat/lon,
  so Gaia's four `planetSun` rings at different locations **collide** in that memo — slot-2/3/4
  read slot-1's city's rise/set. **CONFIRMED** by direct test (2026-06-28): same pool, Sun,
  same time, equator vs arctic → both return `2.3328` (arctic's true value is `4.3341`). So
  Gaia currently renders all four day/night rings as the *first* slot's city. It's a
  regression from the day/night memo; the green "bit-identical" suite is on baked-in wrong
  values (Gaia's snapshot was captured with the memo present). **NOT in production** — the
  deployed GitHub release (`4b0fdff`, ~2026-06-24) predates the memo and shows Gaia's four
  dials with clearly-different rise/set. So **no urgent standalone fix**: fold it into the
  `(location, di)` cache key in
  [2026-06-28-per-tick-astronomy-memoization.md](2026-06-28-per-tick-astronomy-memoization.md)
  §4b, which makes the collision impossible (different slot location ⇒ different cache).
  (The snapshot re-baseline happens then.)
- **tz-independent.** The `dayNightMaster*` slots store **raw UTC event times**
  ([astro-cache.ts](../src/astronomy/astro-cache.ts) L241 doc-comment). Timezone enters
  only via `angle24HourForDate(di, tzOffsetSeconds)` applied *after* the cache. So faces
  with different timezones can share the search outputs; only the cheap per-face angle
  conversion differs.
- **Single-threaded.** Ticks are synchronous; the pool's push/pop nesting is safe to
  share. No re-entrancy concern.

### Design

A module-level pool **registry** keyed by observer location, returned from
`registerAstroFunctions` instead of `new AstroCachePool()`:

```ts
// astro-env.ts
const _poolRegistry = new Map<string, AstroCachePool>();
function sharedPoolFor(latRad: number, lonRad: number): AstroCachePool {
    // round to ~1e-6 rad so float jitter doesn't fragment the key
    const key = `${latRad.toFixed(6)},${lonRad.toFixed(6)}`;
    let pool = _poolRegistry.get(key);
    if (!pool) { pool = new AstroCachePool(); _poolRegistry.set(key, pool); }
    return pool;
}
```

- `registerAstroFunctions` calls `sharedPoolFor(OBSERVER_LAT, OBSERVER_LON)` and
  `initializeCachePool(pool, dateInterval, lat, lon, false, tzOffsetSeconds)`.
- Because all same-location faces get the **same pool object**, face #2's read of the
  Sun ring hits the slots face #1 already filled this tick (same `calcDate` within the
  0.5 s slop, same `globalValidFlag`). `masterComputes` drops accordingly.
- **Lifetime / clearing.** Keep the existing self-invalidation: each
  `getMasterRiseSet`/rise-set call `pushECAstroCacheInPool(pool, finalCache, calcDate)`
  invalidates when the display time moves past slop. Nothing new to clear. This honors
  the "one mechanism, defined slop, cleared at the right time" directive.

### Risks & decisions to resolve during implementation

1. **tz in the invalidation key.** `initializeCachePool` currently bumps
   location-*independent* slots when `tzOffsetSeconds` differs ([astro-cache.ts](../src/astronomy/astro-cache.ts)
   L481-492). With a shared pool, faces with different tz would bump each other at
   **env-creation time**. This is *benign* (init runs once per face up front; slots heal
   on first tick) but wasteful. **Decision:** since the cached slots are tz-independent,
   drop `tzOffsetSeconds` from the pool's invalidation entirely, or skip re-init if the
   pool is already initialized for this `(lat, lon, direction)`. Prefer dropping it —
   tz genuinely doesn't belong in the astro cache key.
2. **`rebuildEnvironments` / DST paths** ([engine-entry.ts](../src/engine-entry.ts) L839)
   recreate envs (and today, pools) on step events and DST transitions. With shared pools
   these must fetch from the registry, not allocate, and must not destructively reset a
   pool another face is mid-tick on. Since rebuild happens between frames, a plain
   re-`initializeCachePool` is fine; just confirm it doesn't bump away a still-valid tick.
3. **`runningBackward` during reverse scrub.** Today the pool is always init'd with
   `false` and never flipped; reverse scrub still self-invalidates by `calcDate`. Keep
   that behavior (don't add direction to the key) unless measurement shows a reverse-scrub
   regression. If we ever do, the key gains a direction component.
4. **Latent slot-collision guard.** `getMasterRiseSet` keys slots on `planetNumber`
   only, *not* lat/lon — safe **only** because one pool == one location. The registry
   enforces that invariant. If `dayNightLeafAngleForSlot` is ever revived, it must fetch
   `sharedPoolFor(slotLat, slotLon)` rather than reuse the observer pool (which would
   also *fix* the existing collision bug). Add a code comment to that effect.

### Expected result

`masterComputes/frame` independent of face count; the `ms/frame` astronomy line in the
scrub log drops to near the single-face cost. Full test suite must stay bit-identical
(8539 tests, incl. arctic polar rings) — the values are unchanged, only *who computes
them* changes.

## Part C — Wedge blit (render-side)

### Approach

Cache one rendered wedge per ring-geometry signature, blit rotated per wedge.

- **Signature / invalidation:** `(outerR, innerR, wedgeSpan, fillColor, strokeColor,
  lineWidth, devicePixelScale)`. Rebuild the bitmap only when the signature changes
  (resize, env rebuild, color expr change) — same pattern as the existing
  `part.cachedCanvas` static-block caches ([renderer.ts](../src/watch/renderer.ts) L74).
- **Draw:** for each wedge, `save → rotate(angle) → [translate(0, slide)] →
  drawImage(wedgeBitmap, …) → restore`. The wadokei `slide` is still a per-wedge
  translate — cheap, and the blit handles it.
- **Render the wedge bitmap at the center-up orientation** (`-π/2`, matching the current
  path) into a tight bounding box, at **device-pixel scale** (multiply by `face.scale` /
  DPR) so it stays crisp.
- Apply to `<QWedge>` too (119 instances): key the blit cache by `refName` so all parts
  sharing a `refName` share one bitmap — exactly the intent of `refName`.

### Risks

- **Overlap + semi-transparent edges.** Wedges deliberately overlap (`span = 2π/n + 0.2`)
  and may stroke/fill with alpha. Blitting overlapping semi-transparent bitmaps composites
  differently than filling overlapping paths. **Verify visual parity** against the current
  path renderer (screenshot diff on Miami/Kyoto/Basel). Opaque fills are safe; alpha edges
  need a look. If parity fails for alpha, restrict the blit to opaque-fill rings and leave
  alpha rings on the path renderer.
- **Stroke AA at small sizes** on `all.html` (tiny faces) — the bitmap must be built at
  the actual on-screen pixel size to avoid blurry edges; rebuild on resize.
- **Memory:** one small bitmap per distinct ring geometry — negligible, and far less than
  the per-wedge path churn it replaces.

### Measurement

Re-read the `[scrub-perf]` `render(draw issuance)` average before/after on `all.html` and
on a single heavy face (Miami). Target: render time roughly proportional to total wedge
count drops to ~1 `drawImage` per wedge with no path tessellation.

### Implementation results — ✅ done (measured 2026-06-28, Chrome)

Implemented in [renderer.ts](../src/watch/renderer.ts): `buildWedgeBitmap` /
`getWedgeBitmap` cache one device-resolution sector per ring geometry (signature =
`scale|outerR|innerR|span|fill|stroke|lineWidth`), blitted rotated per wedge.
`strokeFillWedgePath` is the shared path used by both the bitmap builder and the
fallback (span ≥ π, never hit in practice). Parity verified by stash-build-screenshot
before/after: Miami (7 filled rings) and Kyoto (stroke-only + wadokei slide) are
visually identical; all 8505 tests still green.

**Both `QDayNightRing` and `QWedge` blit, via one process-wide appearance-keyed cache.**
The cache is keyed purely by appearance signature (`scale|outerR|innerR|span|fill|stroke|
lineWidth`) in a module-level `Map`, *not* per part — this **is** the iOS `refName`
image-sharing mechanism: every wedge that looks identical resolves to one bitmap.

**Two findings reshaped the change:**

1. **The win is GPU-rasterization-bound, so it scales with face size — not draw-call
   count.** Single large faces (724 px): Miami GPU flush/render **21.2 → 11.7 ms**
   (38 → 60 fps, vsync-capped); Selene **22.7 → 17.7 ms** (34 → 44 fps). On the 16-face
   `all.html` grid at 412 px/face it's **neutral, within run-to-run noise** (GPU
   ~12.5 → ~13.4 ms, ~13–16 fps both ways) — there wedges are a minority of GPU load,
   dominated by 16 full static-cache blits + the ~11 ms tick eval. So: **big win for
   wedge-heavy single-face views, neutral for the grid.**

2. **A per-part cache caused a real regression; the `refName`/appearance-shared cache
   fixes it (this was the whole point of `refName`).** A first cut keyed the bitmap
   *per part*, which *regressed* `all.html` (15.8 → 12.4 fps). A `__wedgeRebuilds`
   counter showed **~56 OffscreenCanvas rebuilds/tick**: **Selene's** day-alternating
   `delOnDay*` `QWedge` date wedges (refName `DELDay A`/`B`) change `fillColor` every
   tick, busting a per-part cache. But `delOnDayTintColor` only ever yields **two**
   colors, and the refName groups guarantee all same-name wedges share one appearance
   at any tick — so an appearance-keyed shared cache holds exactly **two stable
   entries** and the day-flip merely re-routes each wedge between them. Measured:
   **2 builds at warm-up, then 0 rebuilds during scrub** (Selene *and* `all.html`).
   Regression gone, and `QWedge` now benefits too (Selene win above).

**Net:** low-risk, parity-clean (Selene/Miami/Kyoto before-after identical), tests green;
meaningfully faster on heavy single faces, neutral on `all.html`. It does **not** by
itself fix `all.html` scrub — there the cost is the aggregate of 16 static-cache blits +
the ~11 ms tick eval, so **Part D (LOD)** and/or reducing per-face static re-blit remain
the levers for the grid.

## Part D — Wedge-count LOD — ❌ DROPPED (Steve, 2026-06-28)

Steve: prefer the small all.html faces to reproduce the large look **faithfully** over a
faster scrub frame rate ("most people won't scrub; if they do, rarely"). So no LOD — keep
full wedge counts at every size. Left here only as a record of the rejected option.

## Part E — Memoize position astronomy (the real tick lever)

**Found by the Node tick profiler** ([step0-tick-profile.ts](step0-tick-profile.ts), real
timers — the browser ?tickprofile per-eval µs was a `performance.now()` artifact). The
eval-dominated tick is **not the evaluator (~0.01µs)** — it's **un-memoized full-series
moon/planet POSITION astronomy**. Every astro fn in [astro-env.ts](../src/shared/astro-env.ts)
passes `null` cache, so `moonRAAndDecl`/`planetEclipticLongitude`/`moonAge` recompute the
**full WB series (~13–19µs) on every call**, shared by nobody within a tick.

Measured warm tick (1 day/tick): **Miami 0.44ms** (its 7 day/night rings ARE memoized via
`getMasterRiseSet` → cheap), **Selene 3.25ms** (58× `moonDeltaEclipticLongitudeAtDeltaDay`
@13µs + position subdials @19µs, all un-memoized). Cold/warm 1.1×, GC 0 → real astronomy,
not JIT/GC. So all.html's heavy tick is the moon/planet-position faces (Selene, Venezia,
Firenze orrery, …), not the day/night rings or the evaluator.

**Fix (same mechanism as the rise/set memo, single cache):**
- Route the position functions through the slot cache: push `pool.finalCache` with the
  frozen tick `calcDate` and pass it (instead of `null`) to `moonRAAndDecl` /
  `planetEclipticLongitude` / `moonAge` / `sun*`. Within a tick (time frozen) all same-time
  callers collapse to **one** compute. Slots already exist (`moonRA`, `moonDecl`,
  `moonEclipticLongitude`, `planetEclipticLongitude`, `sunRA`, …).
- `moonDeltaEclipticLongitudeAtDeltaDay(0..7)` computes at 8 *offset* times → memoize per
  delta-day per tick: 58 calls → 8 computes.
- Zero visual change (identical values, computed once). Expect Selene ~3.25ms → ~0.5ms and
  a meaningful all.html tick drop. Guard with the full regression suite (bit-identical).

## Suggested order

1. ✅ **A** — instrumentation + measured.
2. ❌ **B** — rejected (cross-face search sharing saves <0.26ms/frame).
3. ✅ **C** — wedge blit (QDayNightRing + QWedge, appearance-keyed shared cache). Done,
   parity-verified, tests green. Big win on heavy single faces; neutral on the grid.
4. ❌ **D** — LOD dropped (faithful small-face rendering preferred).
5. **E** — memoize position astronomy via the slot cache. **The real tick lever.** Next.
6. ✅ memory note updated.
