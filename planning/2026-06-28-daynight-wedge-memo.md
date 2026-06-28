# Day/Night Ring Wedges: Memoize the Rise/Set Search (and unify on the slot cache)

**Date:** 2026-06-28
**Status:** Diagnosis complete; implementation not started.
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

The slot cache (`AstroCache` / `AstroCachePool`) requires `pool.currentCache` to be
pushed for the *current* date (`initializeCachePool` / `pushECAstroCacheInPool`) before
slot reads/writes are valid. But that setup runs **once at env-build time**
([astro-env.ts:453](../src/shared/astro-env.ts:453),
[watch-env.ts:456](../src/watch/watch-env.ts:456)) and is then **released** — there is
**no per-tick re-push** of `finalCache` with the live display time. During a scrub the
slot cache is therefore keyed to a stale build-time date, so naïve master-angle slots
would never validate.

This is almost certainly why a prior porting step introduced the `PlanetRiseSetCache`
**Map**: it self-validates against `calcDate` (`existing.cachedDateInterval === calcDate`)
on every call, sidestepping the un-pushed slot cache. *(Confirm rather than assume —
check git history / original intent before deleting; per repo convention, ask Steve if
the reason isn't clear from the code.)*

**Implication:** unifying on the slot cache is not just "write to the slots." It
requires establishing the current cache with the **live display `dateInterval` and a
chosen slop** at the right scope so master-angle slots are valid across all wedges in a
tick — either:
- (i) a **per-tick push**: before the update/render pass evaluates obsValues, push
  `finalCache` for the current display time; pop after; or
- (ii) a **push/pop inside the wedge helper**, around the master-angle read/write,
  keyed to `calcDate` with explicit slop.

Option (i) is the more idiomatic "one cache, controlled slop, cleared at tick
boundaries" model Steve asked for; (ii) is a more contained change. Decide during
implementation.

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
5. **Establish the per-tick (or per-helper) current-cache push** with controlled slop
   (the prerequisite from "the crux" above).

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
- **MidnightSun/nightTime:** `nightTime` is derived from the *original* planet then the
  planet is substituted to Sun for the search; the memo key must use the **substituted**
  planet (as `computeAndCachePlanetRiseSet` already does), and `nightTime` is applied in
  the cheap per-call tail.
- **Slop & clearing (the point of unifying):** choose the slop for the master-angle
  cache deliberately, and ensure it clears on date-beyond-slop, **location change**, and
  **body/face switch** — the slot cache's flag mechanism already gives location/global
  invalidation; the per-tick push gives time invalidation.

## Expected payoff

A 96-wedge Moon ring: ~15 ms → ~0.3 ms per tick. Sun rings benefit less in absolute
terms (~9 µs → shared) but still collapse to one search per ring. This is the dominant
scrub-tick cost the Step 0 profiling chased; unlike the eval→`new Function` migration
(≤1% ceiling), this targets the function-body work that actually dominates.
