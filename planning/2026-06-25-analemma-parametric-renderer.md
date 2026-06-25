# Parametric Analemma Renderer

> **Status:** Implemented 2026-06-25 (astro primitives + parametric renderer).
> Verified: full test suite (8533) green, build clean, Vienna analemma marker
> tracks summer-solstice → equinox → winter-solstice along the figure-eight.
>
> **Relationship to other work.** This is the *prerequisite* refactoring called
> out in Phase 8 of
> [2026-06-15-chronometer-obsvalue-port.md](2026-06-15-chronometer-obsvalue-port.md)
> ("Analemma → ObsValues"), where it is explicitly marked out of scope:
>
> > **Prerequisite.** Before this phase, the analemma renderer will be
> > refactored (in a separate task) to accept a **parametric path parameter**
> > instead of pre-computed (x, y) coordinates.
>
> This document covers only the renderer refactoring. It does **not** add env
> functions or ObsValues — that is the ObsValue port, handled separately. The
> goal here is to land the parametric renderer first, with **no observable
> change in behavior**, so the ObsValue port can later drop in cleanly.

## Motivation

Today the analemma marker position is computed as concrete `(x, y)` XML
coordinates and snapped directly each update interval. Phase 8 wants to drive
the marker from a single **parametric** scalar (a fractional day-of-year), for
two reasons:

- **Scale-independence.** The astronomy ("how far through the solar year") is
  decoupled from path geometry/scaling. The eventual env function returns pure
  astronomy with no knowledge of disc radius or pixel scaling.
- **Animatable along the track.** A scalar parameter maps to points *on* the
  figure-eight path. Animating between two parameter values moves the Sun marker
  smoothly **along** the figure-eight, rather than cutting a straight chord
  between `(x₁, y₁)` and `(x₂, y₂)`. This is what lets the future ObsValue use
  `evalAhead: true` for smooth scrubbing instead of `discrete: true`.

This refactoring makes the renderer *consume* such a parameter. The astronomy
that produces the parameter stays in `updateAnalemmaValues` for now (so behavior
is unchanged); the ObsValue port later moves it into an env function.

> **Precision is a first-class requirement here.** Chronometer is scrubbed to
> arbitrary epochs (the motivating test case is **3900 BCE**). A naive parameter
> of "elapsed days modulo 365" drifts by ~0.242 day/year (the tropical year is
> ~365.24219 days), i.e. ~half a path-step over the 2024→2026 gap and a *quarter
> of the figure* per century — disqualifying. The design below therefore
> parametrizes by **fraction of the actual equinox-to-equinox year**, so the
> sample count is a pure resolution knob with no astronomical meaning, and adds a
> reusable equinox/solstice primitive to the astro library.

## Current state

All current code lives in [src/watch/analemma.ts](../src/watch/analemma.ts).

Relevant pieces:

- **Path generation** (`computeAnalemmaPath`, init only): builds a 365-point
  path of alt/az deltas relative to the vernal-equinox reference day
  (`REF_EPOCH_SECONDS` = 2024-03-20 12:00 UT), at the reference location
  (`REF_LAT_RAD` = 45°N, `REF_LON_RAD` = 0°). Index `d` = day `d` since the
  reference equinox, sampled at 12:00 UT.
- **Path scaling** (`expandAnalemma`, init only): produces
  `state.pathScaled: [number, number][]` — the path in XML coords, foreshortened
  by `cos(alt)`, uniformly scaled to fit the disc, and centered (the bounding-box
  offset `pathOffsetX/Y` is already subtracted into `pathScaled`).
- **Marker computation** (`updateAnalemmaValues`, per update interval): computes
  `state.currentSunX`, `state.currentSunY` **directly from astronomy** for the
  current date's 12:00 UT at the reference location, and `state.currentRotation`
  from `sunSkyOrientationAngle` at the *observer's* location.
- **Draw** (`drawAnalemma`): blits background, channel bitmap (rotated by
  `currentRotation`), and the Sun bitmap at `(currentSunX, currentSunY)`.
- **Scheduling** (`tickAnalemma`, `resetAnalemmaSchedule`): snap-update on an
  interval; reset forces immediate recompute. Wired from
  [src/engine-entry.ts](../src/engine-entry.ts).

### Key equivalence (why the refactor is behavior-preserving)

For day index `i`:

```
pathScaled[i] = [ deltaAz_i · cos(refAlt + deltaAlt_i) · scaleFactor − pathOffsetX,
                  deltaAlt_i · scaleFactor − pathOffsetY ]
```

and the current marker computation is:

```
currentSunX = normalizeAngleDelta(az − refAz) · cos(alt) · scaleFactor − pathOffsetX
currentSunY = (alt − refAlt) · scaleFactor − pathOffsetY
```

Since `alt = refAlt + deltaAlt` and `(az − refAz)` is exactly `deltaAz`, the
marker at integer day `i` lands **exactly** on `pathScaled[i]` — *at the
reference epoch*. So replacing the direct `(x, y)` computation with "find the
fractional position along the path, then look up `pathScaled` at that fractional
index" reproduces the current marker near the present and interpolates sensibly
between samples. This is the behavior-preserving core of the refactor.

> ⚠️ The equivalence above is exact only because today's marker math and the
> path are both anchored to the same 2024 reference. The Design section anchors
> day 0 to the *true* equinox and indexes the path by fraction-of-equinox-year to
> stay correct far from the present — so "behavior-preserving" means *visually
> identical near the present*, not bit-identical. See
> [Precision: parametrization](#precision-parametrization).

## Naming

`PATH_DAYS` is renamed **`PATH_SAMPLE_COUNT`** throughout. The old name implied
"days," but the value is now just the number of points in the rendered path
array (the parameter's full-loop scale). Set **`PATH_SAMPLE_COUNT = 1000`** (was
365) for smoother rendering of the figure-eight's sharp solstice turns. See
[Resolution](#resolution-genuine-sub-day-sampling-via-eot-declination) for how
the path is genuinely sampled at that resolution (not spline-upsampled).

## Precision: parametrization

The parameter must answer "how far along the analemma is the Sun *right now*"
in a way that stays correct at any epoch. Two independent error sources, and the
fix for each:

| Error source | Naive version | Fix |
|---|---|---|
| **Year length ≠ sample count.** Tropical year ≈ 365.24219 d; `mod 365` gains ~0.242 d/yr of phase error (≈ a quarter of the figure per century). | divides elapsed days by a constant | parametrize by **fraction of the actual year**, never by a day count |
| **Equinox-to-equinox interval varies** year to year (orbital dynamics + nutation; secular drift). | assumes a fixed-length year | anchor to the *real* equinoxes bracketing the display time |

### Parameter definition

```
pathParameter(t) = PATH_SAMPLE_COUNT × fractionOfVernalEquinoxYear(t)

fractionOfVernalEquinoxYear(t) = (t − VE_prev) / (VE_next − VE_prev)   ∈ [0, 1)
```

where `VE_prev` = most recent vernal equinox ≤ `t`, and `VE_next` = the next
vernal equinox after `t`. The fraction is **0 at the equinox and reaches 1 one
tropical year later, whatever that year's true length is** — both error sources
vanish. `PATH_SAMPLE_COUNT` is purely the rendered path's length; it carries no
astronomical meaning. The fraction function lives in the astro library (see
below) so non-ObsValue callers get it for free.

## Resolution: genuine sub-day sampling via (EOT, declination)

A literal "1000 raw samples" of `sunAltitude/sunAzimuth` does **not** work: the
analemma is the Sun's position at a *fixed civil time* (12:00 UT) across
different *dates*. Sampling at `VE_ref + (d/1000)·year` lands at instants ~8.77 h
apart — all different times of day — so raw alt/az would fold in the Sun's
diurnal motion and smear the figure into a band.

The correct way to sample at any resolution is the **(EOT, declination)
decomposition** — reconstruct the *noon* configuration as a continuous function
of time:

```
δ(t)   = sun declination at t                       // continuous (sunRAandDecl)
H(t)   = EOTSeconds(t) · (2π / 86400)                // sun's hour angle at mean noon; sign TBD by test
sinAlt = sin δ · sin φ + cos δ · cos φ · cos H
alt    = asin(sinAlt)
az     = atan2(−cos δ · cos φ · sin H,  sin δ − sin φ · sinAlt)   // same formulas as planetAltAz
```

with `φ = REF_LAT_RAD`. Both [`EOTSeconds`](../src/astronomy/es-astro.ts) and
`sunRAandDecl` are **sub-day continuous** (verified — `EOTSeconds`' `noonD` is
only the origin for `longitudeOfMeanSun`, not a snap; both terms are evaluated at
the actual instant). At 12:00 UT (mean noon at Greenwich, `REF_LON_RAD = 0`) the
Sun's actual hour angle *equals* its EOT angle, so this reproduces today's
`sunAltitude/sunAzimuth` figure **exactly at integer-day noons** while
interpolating smoothly between them at genuine astronomical resolution.

So `PATH_SAMPLE_COUNT = 1000` becomes a true sample count (not a spline upsample),
and `pathScaled` holds 1000 genuinely-computed points; `pathParamToXY` keeps its
cheap **linear** per-frame lookup over that dense array.

### Generation outline

```
VE_ref     = vernalEquinoxOnOrBefore(REF_EPOCH_SECONDS)   // day 0 at fraction 0
VE_refNext = vernalEquinoxAfter(VE_ref)
yearLen    = VE_refNext − VE_ref
for d in 0 … PATH_SAMPLE_COUNT−1:
    t = VE_ref + (d / PATH_SAMPLE_COUNT) · yearLen
    path[d] = analemmaPointFromEotDecl(t, REF_LAT_RAD)    // (EOT, δ) decomposition above; deltas vs VE_ref
pathScaled = scaleAndCenter(path)                          // existing scaling, now on 1000 points
```

Sample `d` sits at fraction `d / PATH_SAMPLE_COUNT` of the equinox year exactly,
so the parameter indexes it consistently and the closed-loop wrap
(`PATH_SAMPLE_COUNT−1 → 0`) spans exactly the last `1/PATH_SAMPLE_COUNT`.

### Season ticks become computed, not hardcoded

The current ticks use hardcoded `dayIndex: 0, 93, 184, 275` for VE/SS/AE/WS.
Seasons are *unequal* lengths (orbital eccentricity), so those are approximate
(notably WS). With the crossing primitive available, compute each tick's
parameter from the real crossing time:
`tickParam = PATH_SAMPLE_COUNT × fractionOfVernalEquinoxYear(crossing)`, then map
to a (fractional) index into the dense `pathScaled`. This keeps the ticks on the
channel exactly where the marker crosses them.

## Astro-library additions

Per the decision to keep the seasonal-phase astronomy reusable (and independent
of ObsValue), the "how far through the vernal-equinox year" computation lives in
[src/astronomy/es-astro.ts](../src/astronomy/es-astro.ts). `WB_sunLongitudeApparent(U, cache)`
already gives the Sun's apparent ecliptic longitude; build three exports on it:

```ts
/**
 * Date interval at which the Sun's apparent ecliptic longitude equals
 * targetLongitudeRad, nearest to approxDateInterval. Newton root-find on
 * WB_sunLongitudeApparent. Equinoxes/solstices are targets 0, π/2, π, 3π/2.
 */
export function solarLongitudeCrossingTime(
    targetLongitudeRad: number, approxDateInterval: number, cache: AstroCache | null,
): number;

/** Vernal equinox (λ☉ = 0) on or before / strictly after the given instant. */
export function vernalEquinoxOnOrBefore(dateInterval: number, cache: AstroCache | null): number;
export function vernalEquinoxAfter(dateInterval: number, cache: AstroCache | null): number;

/**
 * Fraction [0, 1) through the current vernal-equinox year:
 *   (t − VE_prev) / (VE_next − VE_prev).
 * The headline reusable primitive — the Phase-8 env function is a one-liner
 * wrapping this, and any non-ObsValue caller can use it directly.
 */
export function fractionOfVernalEquinoxYear(dateInterval: number, cache: AstroCache | null): number;
```

`fractionOfVernalEquinoxYear` is what the analemma (and later the env function
`analemmaPathParameter()`) calls; the renderer just multiplies by
`PATH_SAMPLE_COUNT`. `solarLongitudeCrossingTime` also yields the solstice/equinox
crossings for the season ticks.

> Root-find notes: apparent solar longitude advances ~0.986°/day but wraps at 2π;
> iterate on the signed angular distance to the target (normalized to (−π, π]).
> Seed the step from the mean rate (`2π / tropicalYearSeconds`); 4–6 Newton
> iterations reach < 1 s. The root-find evaluates λ☉ at many instants, so it must
> **not** reuse a per-date `AstroCache` (pass a fresh/`null` cache internally);
> the `cache` parameter is kept only for signature consistency with the library.

> Per-frame cost: `fractionOfVernalEquinoxYear` runs two root-finds (~22 µs
> measured). The analemma updates at most once per frame (every frame only during
> accelerated scrubbing), so this is negligible and is called statelessly — no
> per-face equinox cache (a cache would duplicate the astro logic and need
> invalidation on every scrub direction change / jump).

## Renderer mapping

The renderer maps `pathParameter` to `(x, y)` by **wrapped linear interpolation**
of `pathScaled`, and uses `currentRotation` exactly as today.

### New helper: `pathParamToXY`

```ts
/**
 * Map a path parameter (fraction-of-year × PATH_SAMPLE_COUNT, range
 * [0, PATH_SAMPLE_COUNT)) to an (x, y) point in XML coords by linearly
 * interpolating between adjacent points of the closed-loop pathScaled array.
 */
function pathParamToXY(
    pathScaled: [number, number][],
    pathParameter: number,
): [number, number] {
    const n = pathScaled.length;            // PATH_SAMPLE_COUNT (1000)
    // Normalize into [0, n) — guards against NaN / negatives / >= n.
    let t = pathParameter % n;
    if (!Number.isFinite(t)) t = 0;
    if (t < 0) t += n;
    const i0 = Math.floor(t);
    const i1 = (i0 + 1) % n;                 // wraps last sample -> 0 (closed loop)
    const frac = t - i0;
    const [x0, y0] = pathScaled[i0];
    const [x1, y1] = pathScaled[i1];
    return [x0 + (x1 - x0) * frac, y0 + (y1 - y0) * frac];
}
```

Notes:
- `pathScaled` is already offset-corrected, so the result needs **no** further
  `pathOffset` subtraction (unlike the old `currentSunX/Y` math).
- The closed-loop wrap (`i1 = (i0 + 1) % n`) matches `buildChannelPath2D`, which
  already closes the path from the last sample back to index 0.

### State change

In `AnalemmaState`, replace the two coordinate fields with one parameter field:

```diff
-    // Current state (updated at each interval, no interpolation)
-    currentSunX: number;
-    currentSunY: number;
-    currentRotation: number;
+    // Current state (recomputed each frame from the display time, no interpolation)
+    currentPathParameter: number;   // fraction-of-year × PATH_SAMPLE_COUNT, [0, PATH_SAMPLE_COUNT)
+    currentRotation: number;
```

This is the field the ObsValue port will later feed from
`pathParam.anim.currentValue`. Keeping it on the state (rather than passing it as
a draw argument) matches the terminator pattern Phase 8 describes
(`leaf._obsAngle` / read in the renderer) and minimizes churn in
`renderer.ts`/`engine-entry.ts`.

### `updateAnalemmaValues` change

Set the parameter directly from the shared astro primitive, using the **live
display instant `di`** (not a noon-snapped value), so the parameter is a
*continuous* function of time — the marker glides along the figure and the
Phase 8 ObsValue can animate it.

```diff
-    const alt = sunAltitude(noonDI, REF_LAT_RAD, REF_LON_RAD, null);
-    const az = sunAzimuth(noonDI, REF_LAT_RAD, REF_LON_RAD, null);
-
-    state.currentSunX = normalizeAngleDelta(az - state.refAz) * Math.cos(alt) * state.scaleFactor - state.pathOffsetX;
-    state.currentSunY = (alt - state.refAlt) * state.scaleFactor - state.pathOffsetY;
+    // Fraction through the current vernal-equinox year (anchored to the real
+    // bracketing equinoxes → exact at any epoch), scaled to the path's sample
+    // domain. Continuous in `di`; this is exactly the value the Phase 8 env
+    // function analemmaPathParameter() will return.
+    state.currentPathParameter = fractionOfVernalEquinoxYear(di, null) * PATH_SAMPLE_COUNT;
```

`di` is the display instant already computed in this function. The
`refAlt`/`refAz`/`scaleFactor`/`pathOffset` fields are no longer needed for the
marker (they remain in state — still used by path scaling at init; we only
remove the per-update consumption). `sunAltitude`/`sunAzimuth` become unused
imports here — drop them.

> No per-frame caching: `fractionOfVernalEquinoxYear` measures ~22 µs/call (two
> root-finds) — negligible against the frame budget — so a stateless call beats
> a memoized bracket, which would both duplicate the astro logic and need
> careful invalidation on every scrub/jump.

### Path generation change (`computeAnalemmaPath`)

Anchor day 0 to the true equinox and sample `PATH_SAMPLE_COUNT` points across the
equinox year via the (EOT, δ) decomposition (see
[Resolution](#resolution-genuine-sub-day-sampling-via-eot-declination)):

```diff
-    for (let d = 0; d < PATH_DAYS; d++) {
-        const di = REF_EPOCH_SECONDS + d * 86400;
-        const alt = sunAltitude(di, REF_LAT_RAD, REF_LON_RAD, null);
-        const az  = sunAzimuth(di, REF_LAT_RAD, REF_LON_RAD, null);
+    const veRef     = vernalEquinoxOnOrBefore(REF_EPOCH_SECONDS, null);
+    const yearLen   = vernalEquinoxAfter(veRef, null) - veRef;
+    for (let d = 0; d < PATH_SAMPLE_COUNT; d++) {
+        const di = veRef + (d / PATH_SAMPLE_COUNT) * yearLen;
+        const { alt, az } = analemmaPointFromEotDecl(di, REF_LAT_RAD);
         ...
     }
```

`analemmaPointFromEotDecl` is the decomposition helper (matches
`sunAltitude/sunAzimuth` at integer-day noons — asserted in tests). Scaling/
centering runs on the 1000 points unchanged. Season-tick parameters map via
`fractionOfVernalEquinoxYear(crossing) × PATH_SAMPLE_COUNT`.

Season-tick indices ([`SEASON_TICKS`](../src/watch/analemma.ts)) become computed
from `solarLongitudeCrossingTime(π/2 · k, …)` near the reference year rather than
the hardcoded `0/93/184/275`.

### `drawAnalemma` change

Convert the parameter to `(x, y)` at draw time:

```diff
-    // --- Sun marker (pre-rendered bitmap with shadow) ---
-    if (state.sunBitmap) {
+    // --- Sun marker (pre-rendered bitmap with shadow) ---
+    if (state.sunBitmap) {
+        const [sunX, sunY] = pathParamToXY(state.pathScaled, state.currentPathParameter);
         ctx.drawImage(
             state.sunBitmap,
-            state.currentSunX - state.sunBitmapAnchorX,
-            -state.currentSunY - state.sunBitmapAnchorY,
+            sunX - state.sunBitmapAnchorX,
+            -sunY - state.sunBitmapAnchorY,
             state.sunBitmapW,
             state.sunBitmapH,
         );
     }
```

The Y-negation for canvas coords is preserved from the current draw code.

### Scheduling, engine wiring — unchanged

`tickAnalemma`, `resetAnalemmaSchedule`, and all the `engine-entry.ts` call sites
are untouched by this refactoring. (Phase 8 removes them when the Updater takes
over; that is out of scope here.)

## Interface exposed for the ObsValue port (Phase 8)

After this refactoring, Phase 8 only needs to:

1. Add env functions `analemmaPathParameter()` and `analemmaRotation()` (the
   astronomy currently inlined in `updateAnalemmaValues` moves there).
2. Create two ObsValues (`pathParam`, `rotation`).
3. Feed `state.currentPathParameter = pathParam.anim.currentValue` and
   `state.currentRotation = rotation.anim.currentValue` (or read the ObsValues
   directly in the renderer), and delete `tickAnalemma` / `updateAnalemmaValues`
   / `resetAnalemmaSchedule`.

No further renderer changes will be required — `pathParamToXY` and the
`currentPathParameter` field are the contract.

## File changes

### [MODIFY] [src/astronomy/es-astro.ts](../src/astronomy/es-astro.ts)

- Add and export `solarLongitudeCrossingTime`, `vernalEquinoxOnOrBefore`,
  `vernalEquinoxAfter`, and `fractionOfVernalEquinoxYear` (see
  [Astro-library additions](#astro-library-additions)). The last is the headline
  reusable primitive.

### [NEW] [src/astronomy/__tests__/es-astro.test.ts](../src/astronomy/__tests__/es-astro.test.ts) (extend)

- Equinox/solstice accuracy and `fractionOfVernalEquinoxYear` monotonicity/wrap
  tests; the epoch-sweep phase-fidelity test (see Verification).

### [MODIFY] [src/watch/analemma.ts](../src/watch/analemma.ts)

- Rename `PATH_DAYS` → `PATH_SAMPLE_COUNT` and set it to `1000`.
- Add `pathParamToXY()` helper and `analemmaPointFromEotDecl()` (the (EOT, δ)
  decomposition).
- `computeAnalemmaPath`: sample `PATH_SAMPLE_COUNT` points across the equinox
  year via `analemmaPointFromEotDecl`, anchored to
  `vernalEquinoxOnOrBefore(REF_EPOCH_SECONDS)`.
- `SEASON_TICKS`: compute tick parameters from `solarLongitudeCrossingTime`
  (precompute the four indices at init).
- `AnalemmaState`: replace `currentSunX` / `currentSunY` with
  `currentPathParameter`.
- `updateAnalemmaValues`: set `currentPathParameter =
  fractionOfVernalEquinoxYear(di) × PATH_SAMPLE_COUNT`; drop the direct `(x, y)`
  math and the now-unused alt/az locals and `sunAltitude`/`sunAzimuth` imports.
- `expandAnalemma`: initialize `currentPathParameter: 0`.
- `drawAnalemma`: derive `(sunX, sunY)` via `pathParamToXY`.

No changes expected in `renderer.ts`, `engine-entry.ts`, or `types.ts` — the
state-field swap is internal to `analemma.ts`.

## Verification

### Automated

- `bash build.sh` succeeds; TypeScript strict compile clean (no dangling
  `currentSunX` / `currentSunY` references).
- **`solarLongitudeCrossingTime` accuracy.** Unit-test that the 2024 vernal
  equinox solves to 2024-03-20 ~03:06 UT (±1 min) and that the four seasonal
  targets `{0, π/2, π, 3π/2}` land on the known 2024 equinox/solstice instants.
- **Epoch sweep — phase fidelity (the key test).** This isolates *parametrization*
  error from *shape* error. For each test epoch (today, ±100 yr, ±1000 yr, and
  **3900 BCE**):
  1. Build the path **for that epoch** (`veRef`/`veRefNext` from that epoch's
     equinoxes).
  2. **Old reference value:** the pre-refactor marker math — compute the Sun's
     alt/az at the epoch's noon-UT and project via the same epoch path's
     scaling.
  3. **New value:** `pathParamToXY(pathParameter(t))`.
  4. Assert agreement to sub-pixel (well under the Sun-marker radius). Because
     the path is epoch-matched, any residual is pure interpolation noise — and
     the *naive* `mod 365` parameter must visibly **fail** this at ±100 yr,
     proving the equinox anchoring is doing its job.
- **Shape-drift measurement (informational, not pass/fail).** For the same
  epochs, compare the fixed-2024 path against the epoch-specific path and record
  the max marker displacement. This quantifies the residual the app would carry
  if the displayed path stays anchored to 2024 (see open question below).

### Manual

- **Visual equivalence near the present.** Build the dist server and load an
  analemma face (e.g. Vienna — `src/watch/assets/vienna/Vienna-I.xml`). The Sun
  marker sits at the same position as before this change for the current date.
- **Scrub a full year** (year-rate scrub): the marker traces the figure-eight
  smoothly and continuously, including the wrap through the vernal equinox with
  no jump.
- **Season-tick alignment.** The marker passes through each colored season tick
  at the corresponding equinox/solstice (now that ticks are computed, this
  should be tighter than before).
- Rotation behavior (disc orientation, `bgRotates`) is visually unchanged.

## Open questions

- **Static 2024 path vs. epoch-specific path (the shape-drift decision).** The
  parametrization fix makes the marker's *phase* exact at any epoch, but the
  path *shape* is still baked from the 2024 reference frame. Over millennia the
  true analemma changes (obliquity ~24.1° in 3900 BCE vs 23.4° now; eccentricity
  / perihelion differ), so at extreme dates the true Sun won't lie exactly on
  the drawn 2024 channel. **Decide, informed by the shape-drift measurement
  above:** (a) accept it within a stated date window; (b) regenerate the path
  for the displayed epoch — note this makes the path time-dependent, which the
  ObsValue port (path is currently init-time static) must account for; or (c)
  regenerate only when the display epoch moves beyond a threshold.
- **Sampling fidelity of linear interpolation.** Linear interpolation between
  the `PATH_SAMPLE_COUNT` (1000) genuinely-computed samples differs negligibly
  from the true position between samples. At 1000 points on a smooth curve the
  error is far sub-pixel — proposing we accept it. (Higher-order interpolation is
  unnecessary at this density.)
- **Marker now snaps to the path.** Previously the marker was computed from
  astronomy independently of `pathScaled`; now it lies exactly on the drawn
  channel. Arguably *more* correct (marker-on-track), but a (small, intended)
  behavior change worth noting.
- **Where the equinox wrappers live.** `solarLongitudeCrossingTime` clearly
  belongs in `es-astro.ts`. The `vernalEquinox*` convenience wrappers could go
  there too or stay analemma-local — minor API-surface call.
