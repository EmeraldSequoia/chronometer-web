# Day/Night Ring Wedges: Memoize the Rise/Set Search (and unify on the slot cache)

**Date:** 2026-06-28
**Status:** ✅ **Implemented 2026-06-28.** Bit-identical (full suite 8539 tests green,
incl. arctic polar rings — no golden re-baselining needed). Measured wedge cost at a
fixed time: Sun 9.17 → **0.170 µs**, Moon 157.8 → **0.189 µs** (the wedge path now matches
the indicator memo). 96-wedge Moon ring ≈ one ~158 µs search + 95×0.19 µs ≈ **~0.18 ms**
(was ~15 ms). Slop kept at the existing 0.5 s default. See "Implementation notes" at end.
**Supersedes** (as the real scrub-perf lever) the perf motivation in
[2026-06-15-eval-vs-custom-parser.md](2026-06-15-eval-vs-custom-parser.md), whose
Step 0 gate failed — see that doc's "Step 0 RESULTS" section.

## TL;DR

The day/night ring's per-wedge expression `dayNightLeafAngle(planet, i, numWedges)`
**re-runs the full ~20-iteration rise/set root-finder on every wedge**, even though
all wedges in a ring share the same `(planet, date, lat, lon)` and therefore the same
rise/set answer. A 96-wedge Moon ring is ~96 × 158 µs ≈ **15 ms** — by itself most of
a ~20 ms scrub tick. Memoizing the search so it runs **once per ring per tick** drops
that ring to ~0.3 ms.

The fix is a memoization, and per the directive below we want it done through the
**single** existing caching mechanism — the `AstroCache` slot system — not a second
side-channel. Today there are two mechanisms; this plan folds the second into the
first and removes it.

> **Directive (Steve, 2026-06-28):** "My personal preference is to have exactly one
> caching mechanism, so we can do things like define the slop acceptable and ensure
> that it is cleared at appropriate times." So this plan should also **scan for any
> astronomy memoization not done through the cache slots and unify it.**

## Evidence

Measured with `planning/step0-probe.ts` (esbuild bundle, run on V8/node) at a **fixed
display time, repeated calls** — so any per-call cost is recomputation, not a moving
clock:

| Call (same time, repeated) | Code path | Cost |
|---|---|---|
| `dayNightLeafAngle(0,0,0)` — Sun rise **indicator** | memoized (`numLeaves==0`) | **0.28 µs** |
| `dayNightLeafAngle(0,5,24)` — Sun **wedge** | root-finder (`numLeaves>0`) | **9.17 µs** (33×) |
| `dayNightLeafAngle(1,0,0)` — Moon rise indicator | memoized | **0.29 µs** |
| `dayNightLeafAngle(1,5,24)` — Moon **wedge** | root-finder (`numLeaves>0`) | **157.8 µs** (545×) |

The "realistic ring scrub" rows in the Step 0 doc confirm it at the ring level: with
the clock advanced once per tick and a whole ring evaluated at that time (cache "warm"
across wedges), a Sun wedge still costs ~9.4 µs and a Moon wedge ~155 µs — i.e. the
cache that *is* active does not span wedges.

Moon is ~17× the Sun for two compounding reasons, both at
[es-riseset.ts:272–293](../src/astronomy/es-riseset.ts:272): the lunar position uses
the heavy Willmann-Bell series, and the search runs Low precision then **upgrades to
Full near the end with extra iterations** (`i--; fitTries = 0`).

## Root cause

[`computeDayNightLeafAngle`](../src/shared/astro-env.ts:2164) has two paths:

- **`numLeaves === 0`** (rise/set/transit indicators): goes through
  [`getPlanetRiseSetCache`](../src/shared/astro-env.ts:2127) → the
  `planetRiseSetCaches` **Map** memo. Cheap on repeat (~0.3 µs).
- **`numLeaves > 0`** (the ring wedges): calls
  [`nextPrevRiseSetInternal`](../src/shared/astro-env.ts:2240) **directly**, bypassing
  the memo, so the expensive search reruns per wedge.

[`computeAndCachePlanetRiseSet`](../src/shared/astro-env.ts:2049) already computes
*exactly* the values the wedge path needs (planetIsUp, the two `nextPrevRiseSetInternal`
searches, `riseTime`/`setTime`, `rTransitAngle`/`sTransitAngle`,
`riseTimeAngle`/`setTimeAngle`) — the wedge path just recomputes them instead of
reusing them.

### The expensive/cheap split (defines a safe memo boundary)

In the `numLeaves > 0` body:

- **Expensive, depends only on `(planet, date, lat, lon)`** —
  [lines 2237–2264](../src/shared/astro-env.ts:2237): the searches and raw outputs.
  *Identical for every wedge in the ring.* This is the 9 µs / 158 µs.
- **Cheap, depends on `numLeaves`** —
  [lines 2271–2333](../src/shared/astro-env.ts:2271): NaN/polar resolution and
  normalization. **Must stay per-call**: several polar branches use
  `leafWidth = 2π/numLeaves` (e.g. lines 2283–2284, 2293, 2303), so the resolved
  window is numLeaves-dependent and cannot be baked into a per-(planet,date) memo.
- **Cheap, depends on `leafNumber`** —
  [lines 2336–2347](../src/shared/astro-env.ts:2336): `leafCenterAngle`, pure
  arithmetic.

So: memoize the **six raw search outputs** (numLeaves-independent); keep all
`numLeaves`/`leafNumber` math per-call.

## Why a second (Map) cache exists today — the crux for unifying

**Verified (2026-06-28, git + code).** The `PlanetRiseSetCache` Map was introduced in
commit **b0171c9 "Fix planet rings in polar regions"** (2026-05-30) — a **correctness
fix, not a perf optimization**. Its purpose is to let three *sibling* expression
functions that the evaluator calls independently and in arbitrary order —
`dayNightLeafAngle` (indicator), `dayNightLeafAngleIsRiseSet`,
`dayNightLeafAngleAboveHorizon` — share one expensive rise/set computation. The commit's
own comment: *"Each independently checks the cache and computes if needed — no ordering
dependency."*

**Why a Map and not the slot cache — confirmed.** The slot cache (`AstroCache` /
`AstroCachePool`) requires `pool.currentCache` to be pushed for the *current* date
(`initializeCachePool` / `pushECAstroCacheInPool`) before slot reads/writes are valid.
But that setup runs **once at env-build time**
([astro-env.ts:453](../src/shared/astro-env.ts:453),
[watch-env.ts:456](../src/watch/watch-env.ts:456)) and is then immediately **released to
`null`** ([astro-env.ts:247](../src/shared/astro-env.ts:247)). So during a tick there is
no established current-cache keyed to the live display time; a master-angle slot
read/write would hit a stale (build-time) or null cache. The Map self-validates against
`calcDate` (`existing.cachedDateInterval === calcDate`, **exact equality — effectively
slop 0**) on every call, sidestepping the un-pushed slot cache. *(The wedge path,
`numLeaves > 0`, never used the Map at all — it calls `nextPrevRiseSetInternal`
directly, which is why it works during scrub despite the released `finalCache`, and also
why it's expensive: the search is self-contained, pushing `refinementCache` with slop 0
per try-date at [es-riseset.ts:295](../src/astronomy/es-riseset.ts:295).)*

**The env-build "problem" is self-healing — it is NOT a blocker.** Because the slot
cache is lazy (a push beyond slop bumps a flag rather than clearing arrays — see
[astro-cache.ts:498](../src/astronomy/astro-cache.ts:498),
[astro-cache.ts:399](../src/astronomy/astro-cache.ts:399)), a stale build-time date
heals itself on the **first push at the live time**: that push exceeds slop → one lazy
invalidation → master slots recompute and store; remaining wedges/siblings in the same
tick push the identical `getNow()` value → within slop → reuse; next tick beyond slop →
auto-invalidate again. There is nothing to "clear at the right time" — the slop
comparison at push *is* the clearing.

`getNow()` is **frozen per tick**: the updater wraps evaluation in
[`withDisplayTime(displayMs, fn)`](../src/shared/updater.ts:82), so every `getNow()` in
a frame returns the same instant. That is why all wedges/siblings share within a tick
regardless of slop (the `calcDate` is identical), and it is the precondition the Map
already relies on.

**Implication:** unifying on the slot cache is therefore just two small things, not a
risky re-architecture:
1. **Re-establish `currentCache = finalCache`** (it is released to `null` after build).
2. **Push `finalCache` with the live display `dateInterval` + slop** around the
   master-angle read/write — either:
   - (i) a **per-tick push**: before the update/render pass evaluates obsValues, push
     `finalCache` for the current display time; pop after; or
   - (ii) a **push/pop inside the wedge helper**, around the master-angle read/write,
     keyed to `calcDate`.

Option (ii) is the contained change and is sufficient. Decide during implementation;
either way, the slop value is governed by the constraints in "Slop & clearing" below.

## Proposed work

1. **Add a slot-cached master rise/set helper.** Compute the six raw search outputs
   once per `(planet, date, lat, lon)`, stored in the **`dayNightMaster*` cache slots**
   ([astro-cache.ts:242–280](../src/astronomy/astro-cache.ts:242)) — which are already
   defined for exactly this purpose but **currently unused** (grep: zero references
   outside the enum). The enum has Rise/Set/RTransit/STransit per planet (4); the raw
   `riseTime`/`setTime` sentinels needed for polar `isAlwaysAbove` checks need a home
   too (add slots, or encode, or recompute the cheap sentinel test). Resolve during
   design.
2. **Route the wedge path (`numLeaves > 0`) through that helper**, then run the existing
   per-call cheap tail (lines 2266–2347) unchanged.
3. **Route the indicator path (`numLeaves === 0`) through the same helper**, replacing
   `getPlanetRiseSetCache` / `computeAndCachePlanetRiseSet`.
4. **Delete `PlanetRiseSetCache`, `planetRiseSetCaches`, `riseSetCacheKey`,
   `computeAndCachePlanetRiseSet`, `getPlanetRiseSetCache`** — one mechanism remains.
5. **Establish the per-tick (or per-helper) current-cache push** (re-point
   `currentCache` at `finalCache`, then push with the live display time) via the standard
   `pushECAstroCacheInPool` — i.e. the **existing default 0.5 s slop**, no custom value
   (see "Slop & clearing"). This is the only real prerequisite from "the crux" above; the
   build-time staleness heals itself on first push.

## Unify scan (sub-task: one caching mechanism)

Preliminary scan (2026-06-28) of `src/shared/` + `src/astronomy/` for memoization
outside the slot cache:

- **`planetRiseSetCaches` Map** (astro-env.ts:2027) — **the only astronomy-domain
  non-slot memo.** This is what items 1–4 above remove.
- Other module-level Maps found are **not** astronomy memos and are out of scope:
  `city-search.ts` `ad2` (admin-name lookup), `updater.ts` `byName` (ObsValue index),
  `app-state.ts` `buckets` (URL-state grouping).
- `es-astro.ts`, `es-coordinates.ts`, `es-riseset.ts` already thread the slot `cache`
  throughout — no second mechanism there.

So unification is well-bounded: removing `PlanetRiseSetCache` leaves the `AstroCache`
slot system as the sole astronomy cache. **Re-run this scan as a checklist item during
implementation** (in case new memos have landed) and add a lint/grep guard if useful.

## Correctness & testing

- **Bit-identical regression guard (land before changing anything):** assert the new
  memoized path returns results bit-identical to the current from-scratch
  `computeDayNightLeafAngle` across a corpus of `(planet, date, lat, lon, numLeaves,
  leafNumber)` — **including a polar latitude** (where the `leafWidth`-dependent polar
  branches live) and the **MidnightSun/nightTime** inversion.
- **Do NOT pick the slop to make the regression guard pass.** Choose the slop on the
  merits (see below). If an existing regression test then fails, that is a signal to
  **confirm the expected-value update with Steve before changing the test** — per
  [[ask-user-before-deep-archaeology]], surface the diff and its cause rather than
  silently re-baselining.
- **MidnightSun/nightTime:** `nightTime` is derived from the *original* planet then the
  planet is substituted to Sun for the search; the memo key must use the **substituted**
  planet (as `computeAndCachePlanetRiseSet` already does), and `nightTime` is applied in
  the cheap per-call tail.
- **Slop & clearing (the point of unifying) — DECIDED: use the existing default
  `ASTRO_SLOP_RAW = 0.5 s`** ([astro-cache.ts:341](../src/astronomy/astro-cache.ts:341)),
  i.e. push via the standard `pushECAstroCacheInPool` — **no custom slop**. This is the
  same slop every other slot-cached quantity already uses, so the day/night master angles
  stay consistent with the rest of the cache. Per Steve (2026-06-28): do **not** widen it
  — a wide slop is unsafe for *any* quantity (e.g. at 1 s before vs 1 s after local
  midnight the answer can flip; a 2 s slop would reuse the wrong side of the boundary).
  **Cross-tick recompute-avoidance is the job of update sentinels, not of a wide slop** —
  sentinels schedule a recompute exactly when a value changes. The 0.5 s slop only needs
  to cover within-push tolerance, and within a tick `getNow()` is frozen so the
  `calcDate` is *identical* across all wedges/siblings — so 0.5 s already gives full
  within-tick sharing and is no looser than the rest of the system.
- **Clearing on location / body / face switch** still comes for free from the slot
  cache's flag mechanism (`globalValidFlag` bump on location/direction change,
  [astro-cache.ts:450](../src/astronomy/astro-cache.ts:450)); the per-tick push gives
  time invalidation.

## Expected payoff

A 96-wedge Moon ring: ~15 ms → ~0.3 ms per tick. Sun rings benefit less in absolute
terms (~9 µs → shared) but still collapse to one search per ring. This is the dominant
scrub-tick cost the Step 0 profiling chased; unlike the eval→`new Function` migration
(≤1% ceiling), this targets the function-body work that actually dominates.

## Implementation notes (2026-06-28, as built)

- **What stores what:** the memo holds the **four raw search outputs** — `riseTime`,
  `setTime`, `riseTransitTime`, `setTransitTime` (raw event/transit times, or the ±1e18
  always-above/below sentinels) — in the renamed `dayNightMaster{Rise,Set,RiseTransit,
  SetTransit}Time` slots. All angle derivation (`rTransitAngle`, `riseTimeAngle`, …) and
  the polar `isAlwaysAbove` sentinel logic happen per-call in the consumers from these
  four raw values, so storing times (not angles) is sufficient and bit-identical
  (JS numbers are Float64, so slot round-trips are exact).
- **Helper:** `getMasterRiseSet(planet, calcDate, lat, lon, pool)` in `astro-env.ts`
  pushes `finalCache` with `pushECAstroCacheInPool` (default 0.5 s slop), reads/writes the
  four slots, pops back. `computeMasterRiseSet` is the un-cached search half.
- **One mechanism:** `PlanetRiseSetCache` / `planetRiseSetCaches` Map / `riseSetCacheKey` /
  `computeAndCachePlanetRiseSet` / `getPlanetRiseSetCache` are **deleted**. All three
  sibling expression functions (`dayNightLeafAngle` 0/1, `dayNightLeafAngleIsRiseSet`,
  `dayNightLeafAngleAboveHorizon`) now route through `computeDayNightLeafAngle`, which
  shares the slot memo — preserving the "no ordering dependency" property the Map gave.
- **Both paths unified:** indicator (`numLeaves === 0`, leafNumber 0/1) and wedge
  (`numLeaves > 0`) both call `getMasterRiseSet`. The leafNumber-4 transit indicator still
  uses `planettransitTimeRefined` directly (returns before the search). The 0/1 indicator
  returns from the raw angles **before** the polar NaN-resolution tail, matching the old
  compute-once cache exactly.
- **Pluto (planet 10):** the `dayNightMaster*` slot categories cover planets 0..9, so
  `getMasterRiseSet` computes Pluto without memoizing. (The day/night ring is not used
  for Pluto; MidnightSun=11 is substituted to Sun=0 before the helper.)
- **Left as-is:** the four unused `dayNightMaster*AngleLST` slot categories (dead) and the
  separate LST ring path (`computeDayNightLeafAngleLST`) — out of scope; not on the
  scrub-perf hot path.
