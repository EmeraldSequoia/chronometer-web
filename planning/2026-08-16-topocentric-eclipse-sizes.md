# Eclipse discs: topocentric angular sizes

**Status**: proposed — **for a fresh session**. Found while validating the
Eclipse Table dataset ([2026-08-16-eclipse-table-page.md](2026-08-16-eclipse-table-page.md)).
Steve is the original author of this algorithm in both iOS and EO, so this is a
deliberate correction to the shared algorithm, not a port question.
**Created**: 2026-08-16
**Baseline**: e2c7b43

> **Working-tree note.** The Eclipse Table's phase 1 may still be *uncommitted*
> when you start — `git status` would then show four untracked files:
> `scripts/scrape-eclipses.mjs`, `src/help/eclipse-data.json`,
> `src/__tests__/eclipse-data.test.ts`, and the two planning docs. That is
> expected work-in-progress, not debris: **leave it in place and do not commit
> it as part of this work.** You need it — `eclipse-data.test.ts` is this
> plan's validation harness (§7). The only file of it you should touch is that
> test, and only for the tightening in §7. Everything else there is inert with
> respect to this task: nothing imports `eclipse-data.json`, and `build.sh`
> copies only `src/help/images/*`, so it never reaches `dist`.
>
> If the harness is somehow absent, regenerate it before starting:
> `node scripts/scrape-eclipses.mjs` (needs network; ~1 minute). Without it you
> are validating a subtle geometry change against the three hand-written events
> in `src/observatory/__tests__/eclipse.test.ts`, which is not enough.

## 1. The bug in one sentence

`calculateEclipse` compares a **topocentric** angular separation against
**geocentric** disc radii, and the Observatory's eclipse simulator draws both
discs from **geocentric** distances — so an observer standing under the Moon
gets a Moon that is up to 1.7% smaller than it really appears, which is
precisely the margin that separates a total eclipse from an annular one.

## 2. Where

Positions are correctly made topocentric
([es-astro.ts:757–765](../src/astronomy/es-astro.ts)) but the sizes they are
compared against are not:

```
sunAngularSize  = planetSizeAndParallax(Sun,  sunDistAU ).angularSize   // :728  geocentric
moonAngularSize = planetSizeAndParallax(Moon, moonDistAU).angularSize   // :737  geocentric
separationAtPartialEclipse = sunAngularSize/2 + moonAngularSize/2       // :766
separationAtTotalEclipse   = moonAngularSize/2 - sunAngularSize/2       // :767
separationAtAnnularEclipse = sunAngularSize/2 - moonAngularSize/2       // :768
```

The same shape is in the original: `ECAstronomy.m:4227,4235` call
`planetSizeAndParallax` with `sunGeocentricDistance` / `moonGeocentricDistance`,
and `:4258–4260` build the thresholds from them. **The web port is faithful;
the defect is in the algorithm both products share.**

The drawing half is independent of `calculateEclipse` and has the same root:
[eclipse-view.ts:231–234](../src/observatory/eclipse-view.ts) sizes the discs
from `eclMoonDist` / `eclSunDist`, which are
`distanceFromEarthOfPlanet(...)` — documented as geocentric at
[astro-env.ts:831](../src/shared/astro-env.ts). So even when the kind is
classified correctly, EO can draw a Moon too small to cover the Sun.

## 3. Evidence

Measured at NASA's published greatest-eclipse point and instant for every
solar eclipse 2011–2041 (the committed `src/help/eclipse-data.json`).
Topocentric Moon size below is computed independently, by law of cosines from
the observer's zenith angle:

| eclipse | Sun SD | Moon SD geo | Moon SD topo | engine | truth at greatest |
|---|---|---|---|---|---|
| 2013 Nov 03 (H3) | 0.2685° | 0.2686° | 0.2731° | **Partial** | Total |
| 2023 Apr 20 (H)  | 0.2652° | 0.2648° | 0.2689° | **Partial** | Total |
| 2024 Apr 08 (T)  | 0.2660° | 0.2766° | 0.2813° | Total | Total ✔ |
| 2020 Jun 21 (A)  | 0.2621° | 0.2565° | 0.2608° | Annular | Annular ✔ |

Geocentrically the hybrid discs match to within 0.0001–0.0004°, so the "total"
window (`moonSD − sunSD`) collapses below the separation and the classifier
falls through to Partial. Topocentrically the Moon wins by ~0.004° —
comfortably total, which is what actually happened (2023 was the Ningaloo
total over Australia; 2013 was total along nearly all its path).

Ordinary totals are unaffected because their geocentric margin is already
~0.01°. Annulars keep the correct sign but their margins are currently
overstated: 2020 Jun 21's true annular margin is 0.0013°, not 0.0056°.

Steve's field report, which is what triggered this: 2013 Nov 03 shows
"partial eclipse" on Basel and, in EO, "just the moon shadow in the center,
possibly covering the sun, can't tell" — the two halves of §2 exactly.

## 4. The fix

### 4a. Return the distance ratio that is already computed

[`topocentricParallax`](../src/astronomy/es-coordinates.ts) (es-coordinates.ts:55)
already forms

```
q = sqrt(A² + B² + C²)      // :72
```

which is Δ′/Δ, the topocentric-over-geocentric distance ratio, and uses it only
for `declPrime = asin(C/q)` (:77). Return it as well — no new astronomy, no new
trigonometry, nothing to validate beyond what the function already does:

```ts
return { Hprime, declPrime, distanceRatio: q };
```

Ten call sites use the two existing fields; adding a third breaks none.

### 4b. Use topocentric sizes in the solar branch

In `calculateEclipse`, after each `topocentricParallax` call, size the disc at
the topocentric distance:

```ts
const sunTopoDist  = sunDistAU  * sunTopo.distanceRatio;
const moonTopoDist = moonDistAU * moonTopo.distanceRatio;
const sunAngularSizeTopo  = planetSizeAndParallax(Sun,  sunTopoDist ).angularSize;
const moonAngularSizeTopo = planetSizeAndParallax(Moon, moonTopoDist).angularSize;
```

and build the three thresholds (:766–768) from those. Keep the **geocentric**
`moonParallax` / `sunParallax` for everything else — the lunar umbra formula
depends on them and must not change (§5).

Magnitudes, as a sanity check while implementing: the Moon's ratio runs from
≈1.000 at the horizon to ≈0.9834 at the zenith (+1.7% size); the Sun's is
≈0.99996 (+0.004%, negligible but harmless and symmetric).

### 4c. Draw the discs at topocentric distances too

EO's simulator needs the same correction or it will still draw a hairline
annulus at a hybrid. The obs-value expressions `eclSunDist` / `eclMoonDist`
([obs-values.ts:304–305](../src/observatory/obs-values.ts)) are geocentric.
Either add a topocentric distance function to the expression environment
(alongside `distanceFromEarthOfPlanet`) and switch those two values to it, or
apply the ratio in `eclipse-view.ts`. Prefer the former: the correction then
lives with the astronomy, and the drawn geometry matches the classification by
construction rather than by coincidence. Note both values are declared
`linear: true` with an eclipse-motion update interval — confirm the ratio's
time-variation is smooth enough for that interpolation (it is: q changes on
the diurnal timescale), or drop `linear`.

## 5. Explicitly do not change

- **The lunar branch.** `umbralAngularRadius(moonParallax, sunAngularSize/2,
  sunParallax)` (es-astro.ts:789) is the classical geocentric shadow
  construction, and lunar classification currently reproduces **45 of 45**
  NASA lunar eclipses. Do not "fix" it for symmetry; there is no evidence of a
  defect and the enlargement conventions are subtle. If it is ever revisited,
  it needs its own evidence and its own plan.
- **`altitudeAtRiseSet`** (es-coordinates.ts:382). It deliberately uses the
  geocentric angular diameter and parallax to define the rise/set altitude;
  that is correct for what it computes.
- **The horizon question** from the same review session — greatest eclipse for
  a *partial* lands on the terminator and NASA publishes only whole-degree
  coordinates there, so the Sun can sit a few tenths of a degree below the
  horizon. That is coordinate rounding, not this bug, and §4 will not move it
  (see §7).
- The iOS source under `.chronometer-ref/` is a read-only reference; do not
  edit it from this repo.

## 6. iOS / EO parity

This deliberately diverges from `.chronometer-ref/Classes/ECAstronomy.m` until
the same change is made there. [docs/development-rules.md](../docs/development-rules.md)
forbids simplifying iOS algorithms; this is the opposite (a correction the
original author is making in both), but the divergence must be recorded, not
silent:

- Add a short note to [docs/astronomy.md](../docs/astronomy.md) stating that
  the solar eclipse thresholds intentionally use topocentric disc sizes where
  iOS uses geocentric, with the date and reason.
- Flag in the commit message that `ECAstronomy.m:4227–4260` needs the mirror
  change (Steve's call, separate codebase).

## 7. Acceptance criteria — the harness already exists

[src/__tests__/eclipse-data.test.ts](../src/__tests__/eclipse-data.test.ts)
replays all 115 NASA eclipses 2011–2041 through `calculateEclipse` and asserts
the kind. It currently passes with **112/115 exact** plus a documented
exemption for the ambiguous cases.

Note it passes **both before and after** this fix, so it will not fail on you
mid-change: hybrids take the exemption branch, which asserts only that the
discs are concentric, and the separation it measures is already topocentric —
unmoved by this change. What it *will* catch immediately is an over-reaching
fix, because every non-ambiguous row is still asserted strictly. After this
change it should read **114/115 exact**, specifically:

- 2013 Nov 03 → `TotalSolar` (today: PartialSolar)
- 2023 Apr 20 → `TotalSolar` (today: PartialSolar)
- 2014 Apr 29 → **still `PartialSolar`**, and that is correct: its Moon is on
  the horizon, so the distance ratio is ≈1 and this fix cannot move it. It
  misses annular by 0.0007° (2.5 arcsec) — far inside the uncertainty of its
  whole-degree coordinates, and it is NASA's one *non-central* annular, whose
  shadow axis misses the Earth entirely. Leave the exemption for this row and
  narrow its justification to coordinate precision.
- All 19 totals stay Total, all 22 annulars stay Annular (tightest margin
  after the change: 2020 Jun 21 at 0.0013°), all 26 partial solar stay
  Partial, all 45 lunar unchanged.

Then **tighten the test**: drop `kind === 'hybrid-solar'` from `isAmbiguous`
so hybrids are asserted strictly, leaving only the non-central annular
exempted. That tightening is the real deliverable — it converts this fix into
a permanent guard.

## 8. Risks

- **Face regression goldens.** Basel renders the kind through
  `legacyEclipseKind()`, so a golden could move. The suite's reference times
  (scenarios.ts:40–46: 2025-06-15, 2025-12-21, 2025-01-01, 2025-03-09,
  2024-02-29, 2000-01-01) are none of them near a syzygy, and scrub
  checkpoints would have to land within minutes of a *central* eclipse at
  Cupertino/arctic/equator to flip — so expect **no** movement. If a golden
  does move, prove it is an eclipse-adjacent checkpoint before re-baselining;
  a broad diff means something else broke. Basel's separation *hand* is
  unaffected either way (separation is already topocentric).
- **Cache slots.** `calculateEclipse` memoizes into location-keyed slots
  (es-astro.ts:707–716). Sizes now depend on the observer, which those slots
  already assume — but verify no other consumer reads a size expecting the
  geocentric value.
- **Perf.** One extra `planetSizeAndParallax` per body per evaluation (two
  `atan`s). `calculateEclipse` is on the scrub path via
  `nextInterestingEclipseMotion`; the wedge-recompute cost dominates, but
  re-run the scrub probe if anything feels slower.
- **Do not chase the third digit.** The goal is the total/annular boundary,
  worth ~0.004°. Sub-arcsecond refinements (Earth-figure flattening in the
  ratio, atmospheric effects) are out of scope.

## 9. Verification

- `npx vitest run src/__tests__/eclipse-data.test.ts` — the §7 criteria.
- `npx vitest run` — full suite (8606 today); investigate any golden movement
  per §8 rather than re-baselining reflexively.
- `npx tsc --noEmit`.
- Headless/visual: build and open the two hybrids in EO — 2013 Nov 03 and
  2023 Apr 20 — and confirm the simulator now draws the Moon fully covering
  the Sun, and Basel's wheel reads "Total Solar". Ready-made deep links for
  both are in the Eclipse Table manual-test harness; if that file is gone,
  rebuild it from `src/help/eclipse-data.json`
  (`observatory.html?lat=&lon=&tz=&t=&dir=0`, percent-encode the values).
  Note the browser pane may not fire rAF at all (canvas stays black) — that is
  a known pane limitation, not a bug; fall back to Steve's dist flow.

## 10. Also worth deciding while in this code (separate from the fix)

Basel and EO disagree about when the Sun is up, over a 0.83° band:

- `calculateEclipse` treats the Sun as up while its centre is above
  **−0.838°** = −(34′ refraction + 16′ semidiameter) — i.e. the refracted
  upper limb is still visible (es-astro.ts:774, es-coordinates.ts:391).
- EO's simulator paints its "Below horizon" overlay whenever the *average
  geometric* altitude of Sun and Moon is below **0**
  ([eclipse-view.ts:268](../src/observatory/eclipse-view.ts)), with no
  refraction or semidiameter allowance.

So a Sun at −0.27° is a visible partial eclipse to Basel and "Below horizon"
to EO. **12 of the 70 solar eclipses 2011–2041 land in that band**, because
greatest eclipse for a partial is *always* on the terminator — so the Eclipse
Table will surface the disagreement repeatedly. Basel's convention is the
physically defensible one. This is a display decision, not part of the fix
above; ship it separately if Steve wants EO's overlay to adopt the same
threshold.

## 11. Commit breakdown (Steve owns every commit)

1. `topocentricParallax` returns `distanceRatio` (§4a) — pure addition, no
   behaviour change, full suite still green.
2. Solar-branch topocentric sizes (§4b) + tighten `eclipse-data.test.ts`
   (§7). This is the commit that changes behaviour; the test tightening is
   the proof.
3. EO simulator draws at topocentric distances (§4c) + docs/astronomy.md
   divergence note (§6).
4. *(optional, separate)* EO horizon-overlay convention (§10).
