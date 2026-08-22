# Astronomy Cache: Slop → 0 (exact-time re-keying, everywhere)

**Date:** 2026-08-22
**Status:** ✅ **Implemented 2026-08-22** (approved by Steve: "do the necessary
changes for slop 0 unconditionally"). **Bit-identical** — full suite green (8692
tests, all 15 golden regression faces; no re-baselining needed — the play/pause
500 ms captures turned out not to embed any anchor-stale astronomy). Perf:
interleaved same-machine A/B (2 rounds, order swapped between rounds) showed the
slop-0 tree **flat-to-slightly-faster** in the 1-day/tick scrub bench (totals
~12.6 ms vs ~13.0 ms for the 0.5 s tree; no face consistently worse). The
compare-vs-baseline run flagged +34% — that is the stale 2026-06-29
Steve's-machine baseline plus VM noise, not the change (the A/B is the evidence;
VM numbers are directional only, so a confirming run on Steve's machine is still
worthwhile).
**Supersedes** the "keep `ASTRO_SLOP_RAW = 0.5 s`" line of the DECIDED block in
[2026-06-28-daynight-wedge-memo.md](2026-06-28-daynight-wedge-memo.md) (that block
ruled out *widening* slop and kept 0.5 pending evidence; the evidence is now in).

## TL;DR

The slot cache's push-time invalidation test (`|dateInterval − anchor| > slop`,
[astro-cache.ts:544](../src/astronomy/astro-cache.ts:544)) becomes an **exact-match
test** — any change of the pushed time re-keys the cache. Motivation: we are about
to map the engine's accuracy boundaries against the Willmann-Bell book values, and
the 0.5 s slop is the one place the engine can serve a value computed at a slightly
different time than requested. A full 8-agent investigation (2026-08-22, adversarial
verify pass included) found slop 0 is **correctness-positive** (it fixes latent bugs)
and **performance-neutral in every steady-state mode**, with exactly two bounded
costs, both addressed here:

1. **Build/rebuild storms** evaluate hundreds of expressions with *unfrozen*
   advancing wall-clock time → freeze display time around them (new
   `TimeController.withFrozenFrame`).
2. **Mauna Kea's render-time `alpha` astronomy** rises from ~3 to ~12 pool
   invalidations/s at 1× (~+1.8 ms/s) → **accepted for now, not fixed** — the
   obvious fix changes polar-edge visibility semantics; see §5.

## 1. Background: what slop is and where it came from

Time enters the slot cache only at push time. `pushECAstroCacheWithSlopInPool`
invalidates all slots iff the global flag changed, a NaN transition occurred, or
`|dateInterval − cache.dateInterval| > slop`. On a *within-slop* push the anchor
`dateInterval` is **not** updated, so one cache generation can mix slots computed at
times up to `slop` apart, and serve them across that window.

- The iOS original is **2.0 s** (`.chronometer-ref/Classes/ECAstronomyCache.h:464`,
  same in `.esastro-ref`). The entire recorded rationale is one comment: "if the
  date has not changed by this much we do not recalculate."
- The web port narrowed it to **0.5 s** ([astro-cache.ts:361](../src/astronomy/astro-cache.ts:361));
  the narrowing predates every planning doc that mentions it and is documented
  nowhere.
- iOS used slop 0 for all refinement-cache pushes, exactly as the web port does —
  the "outer default / refinement 0" split is original.
- The Inspector already runs slop 0 for its `liveAstro` pushes in production
  ([inspector-entry.ts:60](../src/inspector/inspector-entry.ts:60)) because 0.5 s
  visibly froze its 0.1 s-cadence readouts (hold-then-jump).

## 2. Why zero is *correct* (not just tolerable)

- **Latent day-flip bugs today.** Day-keyed slots validated only by generation —
  `moonAgeAtDayOffset` ([astro-env.ts:1315](../src/shared/astro-env.ts:1315)) and
  the for-day rise/set slots ([es-riseset.ts:631](../src/astronomy/es-riseset.ts:631))
  — can serve the **previous local day's value for up to 0.5 s after local
  midnight** (DEL ring off by a day-step; sundial for-day values on the wrong day).
  Exact re-keying eliminates the window.
- **Stale live readouts.** In live 1× mode the pool is long-lived (no per-tick
  invalidation), so off-phase eval groups within 0.5 s of each other share a stale
  anchor — e.g. EO's eclipse readouts can be computed on ≤0.5 s-stale shared slots,
  relevant at the engine's ±2 s-vs-NASA contact-time margin.
- **The design contract already assumes it.** The updater's invariant comment
  ([updater.ts:938](../src/shared/updater.ts:938): eval results are
  "order-independent" functions of env + display time + cache) and the memoization
  doc's correctness claim ("a value evaluated at time *t* uses a cache valid for
  *t*… never reads a stale value",
  [2026-06-28-per-tick-astronomy-memoization.md](2026-06-28-per-tick-astronomy-memoization.md) §4b)
  are *strictly* true only at slop 0. The wedge-memo DECIDED block already assigned
  cross-tick recompute-avoidance to update sentinels, not slop, and within-tick
  sharing to the frozen frame time — slop had no documented job left.
- **Accuracy work.** For the Willmann-Bell boundary mapping, slop 0 guarantees any
  engine-vs-book deviation is the *math*, never the cache.

## 3. Why zero is ~free (the investigation, condensed)

Three claims were verified against the code (and an adversarial pass then failed to
refute the correctness conclusion):

1. **Scrub: moot.** EC O(1)-invalidates the whole pool every tick when the env
   rebuild is skipped ([engine-entry.ts:1050](../src/engine-entry.ts:1050)); EO
   builds a fresh env/pool every 100 ms tick. Minimum scrub delta is 1 display-second,
   so within-tick eval-time groups differ by exactly 0 or ≥1 s.
2. **Live mode: evals are boundary-batched.** Non-onBeat values are gated by
   `nextUpdateTime`; onBeat values evaluate only on arrival. Sub-second XML update
   intervals are all pure `liveTime` clock hands; the fastest astronomy-bearing
   values run at 1 s (Haleakala/Venezia hands), EO's at 1 s (clock + eclipse
   sentinel). Renderers read `currentValue` only — with the one exception in §5.
3. **Push keys are bit-identical where sharing matters.** Display time is frozen
   per frame (`beginFrame`/`endFrame`); on-beat/eval-ahead evals *do* push future
   boundary times within the same frame (several distinct times per frame — the
   original "one frozen time per tick" intuition is false as stated), but the
   `byEvalTimeClass` sort keeps same-time groups contiguous, epoch-aligned
   boundaries are pure functions of (interval, frozen now, tzOffset) so group keys
   are bit-identical, and invalidation requires `> slop` *strictly* — Δ = 0 never
   re-keys even at slop 0. The push-inventory trace found **no path where the same
   instant reaches a >0-slop cache through two different float chains**.

Slop-independent by construction: NaN/Infinity sentinel boundaries (NaN branches
precede the slop compare), `midnightCache` (keys are exact integer multiples of
86400 s), sentinel/stepper searches (throwaway pools), refinement pushes (already
slop 0), the eclipse-table page and scripts (null caches, no pools).

## 4. Cost 1: build/rebuild storms → freeze display time

Every ObsValue evaluates once at construction
([obs-value.ts:175](../src/shared/obs-value.ts:175)), and EC's `buildCache` /
env-rebuild paths (init blocks, `buildStaticBlockCaches`, `updateLeafAngles`) run in
`setTimeout` chains **outside any frame snapshot** — in live mode each eval sees a
fresh `Date.now()+offset`, so a storm's pushes advance ~1 ms apart. At slop 0.5 a
storm is one cache era; at slop 0 it would re-key per elapsed millisecond,
re-running ~68–158 µs master searches per ms-cohort (~tens of ms extra across
all.html's 16 faces, and per resize/location/DST gesture).

Not a correctness issue (every value is built with `nextUpdateTime: 0` and re-evals
at one frozen frame time before first paint), but a real, avoidable cost.

**Fix:** `TimeController.withFrozenFrame(fn)` — re-entrancy-safe wrapper (no-op when
a frame snapshot is already active; otherwise `beginFrame`/`try/finally endFrame`.
Under an active hold it takes a snapshot of the held time — value-identical, since
`_computeDisplayTime` returns the hold). Wrap the synchronous storm bodies:

- EC: `buildCache`, `rebuildEnvironments`, `rebuildAllForLocation`,
  `handleDstTransition`, and the planet-selector / Terra-city / Gaia-subdial
  rebuild bodies.
- EO: `rebuildEnv`, and the `buildObsValues` call in `init()`.
- Inspector: its env(+catalog) build sites, same pattern.

The freeze is semantically inert wherever time was already constant (scrub tickTime,
stopped mode, active holds) and pins live-mode storms to one instant — which is
*better* than today (today's storm values are mutually inconsistent within the
storm's duration; frozen, they are exactly consistent).

## 5. Cost 2: Mauna Kea render-time alpha — accepted, follow-up sketched

Mauna Kea's dawn/dusk image hands carry `alpha='sunriseIndicatorValid()'` /
`'sunsetIndicatorValid()'` ([MaunaKea-I.xml:52](../src/watch/assets/mauna-kea/MaunaKea-I.xml)),
the **only render-time-evaluated astronomy in all 16 faces** (every other
astro-bearing attribute is ObsValue-backed; the Selene per-render wedge colors are
pool-free day-parity math). The renderer evaluates `alpha` on every render
([renderer.ts:2615](../src/watch/renderer.ts:2615)); MK renders essentially every
frame at 1× (0.1 s second/minute sweeps), and its bps=10 quantizer grids the push
times at 10/s. Under slop 0 that's ~12 pool invalidations/s (vs ~3 today), each
killing the for-day memo slots: **≈ +1.8 ms/s while MK is displayed at 1×**.
Frame-rate independent (bps caps it); scrub unaffected (per-tick invalidation
already forces one for-day search pair per tick under either slop).

**Why we are NOT ObsValue-izing the alphas in this change:** the render-time eval
is *load-bearing at polar edges*. The hands' update sentinels are
`updateAtNextSunset`/`updateAtNextSunrise`; when the referenced event stops
existing (polar onset) the sentinel boundary goes to Infinity and the *angle*
freezes — it's the per-render alpha flipping to 0 **at local midnight** that hides
the stale hand promptly. An alpha ObsValue on the part's own sentinel would keep
the hand visible for months at polar onset. The correct design is an alpha ObsValue
on an `…OrMidnight` sentinel (discrete, no animation; `lightweight`-guarded so the
regression bench's snapshot set is unchanged) — a small, separately-testable change
with its own visible-behavior surface. Bundling it into a cache-semantics change
would muddy both the goldens and the perf gate. Accepting +1.8 ms/s (~0.2% of one
core, one face, 1× only) until then.

## 6. DECIDED — the change list

1. **Exact re-keying**: drop `ASTRO_SLOP_RAW` and the `slop` parameter entirely;
   the invalidation test becomes `dateInterval !== valueCache.dateInterval` (NaN
   branches unchanged, checked first). `pushECAstroCacheWithSlopInPool` is deleted;
   `pushECAstroCacheInPool` is the single push. The es-riseset refinement pushes
   (already slop 0) switch to it mechanically.
2. **Remove the override plumbing**: `liveAstroSlopSec` parameter of
   `createAstroEnvironment`/`registerAstroFunctions`, and the Inspector's
   `INSPECTOR_LIVE_ASTRO_SLOP_SEC` (now the global behavior).
3. **Delete dead machinery** flagged by the audit: the write-only
   `AstroCache.astroSlop` field and the never-pushed/never-read `pool.tempCache`.
4. **Storm freezing** per §4 (`withFrozenFrame` + wraps). As implemented, the
   wrapped sites are — EC: `buildCache`, `rebuildEnvironments`,
   `rebuildAllForLocation`, `handleDstTransition`, the planet-selector /
   Terra-city / Gaia-subdial rebuild loops, `setNoonOnTop` (the Vienna
   noon/midnight toggle — initially missed; caught by the post-change review),
   and `createFace`'s `createWatchEnvironment` (init-block evaluation);
   EO: `rebuildEnv` and the `buildObsValues` call in `init()`;
   Inspector: `buildCatalog`.
5. **Comment repairs**: the misleading "evaluated … each frame" comment at
   [engine-entry.ts:1065](../src/engine-entry.ts:1065) (leaves eval on arrival;
   the per-frame path is renderFrame's `evalAttr`), and the slop mentions in
   `liveAstro` / `getMasterRiseSet` / `moonAgeAtDayOffset` docs.
6. **Mauna Kea alpha**: no change now; follow-up per §5.

## 7. Test & gate plan

- Full suite (`npm test`). Expected golden exposure is narrow: the play/pause
  scenarios advance display time by exactly 500 ms at 1× between captures
  ([scenarios.ts:192](../src/__tests__/scenarios.ts:192)) — precisely *at* the old
  boundary where `> 0.5` was false, so those captures can embed anchor-stale values
  that now become exact. The 16.7 ms mid-anim captures run in stopped mode
  (constant display time) and must not shift. **Goldens are never regenerated
  without Steve's express go-ahead** (docs/testing.md); if diffs appear, surface
  the field-bucketed numeric diff first (per the golden-rebaseline audit
  procedure) and stop.
- Perf: this is squarely in dev-rules §18 territory (cache-pool change → perf
  regression run). Local interleaved A/B is directional only; authoritative
  numbers come from Steve's 240 Hz machine via a dist build with the
  `build N.N.N` stamp check.

## 8. Follow-ups (not this change)

- Mauna Kea alpha ObsValue with `…OrMidnight` sentinel (§5).
- docs/astronomy.md still documents the deleted `PlanetRiseSetCache` Map
  (~lines 250–267) — stale independently of this change.
