# EO eclipse simulator: physical horizon + Basel-matched "Below horizon"

**Status**: **IMPLEMENTED 2026-08-18** (commit f5c7a75); **§3b (the
kind-gated caption) superseded 2026-08-28** — the kind gate inherited
`calculateEclipse`'s needle-pegging override, which made the caption
unreachable across a wide band where the disc still draws; replaced by a
wash-closure gate, see
[2026-08-28-eclipse-below-horizon-caption.md](2026-08-28-eclipse-below-horizon-caption.md).
§3a (the wash geometry) stands. — landed as §9
specified: `horizonOverlayState` helper exactly per §3c (engine-constant
refraction, caption gated on `SolarNotUp`/`LunarNotUp`), unit tests with the
§8 fixture table added to `src/observatory/__tests__/eclipse.test.ts`, and
the divergence note in docs/observatory.md. Supersedes the optional
"commit 4" sketched in §10 of
[2026-08-16-topocentric-eclipse-sizes.md](2026-08-16-topocentric-eclipse-sizes.md).
Status updated retroactively by the planning session.
**Created**: 2026-08-18
**Baseline**: e2c7b43 (+ topocentric fix 2f756b8)

## 1. What's wrong (two defects, one overlay)

The Observatory's eclipse-simulator horizon treatment
([eclipse-view.ts:357–376](../src/observatory/eclipse-view.ts)) draws a green
wash below the *geometric* horizon and captions "Below horizon" whenever the
Sun/Moon midpoint's geometric altitude is negative:

1. **No refraction** — at true altitude −0.27° the refracted Sun is actually
   fully visible, sitting tangent on the horizon; EO paints it fully green.
   This is Steve's 2011 Jan 04 field report, and it recurs structurally:
   greatest eclipse for a *partial* is always on the terminator, so ~12 of
   the eclipse table's 70 solar rows land in the disagreement band.
2. **Wrong threshold for the caption** — `horizonPixelY > 0` ⇔ avg geometric
   alt < 0, while Basel's wheel (via `legacyEclipseKind()` →
   `calculateEclipse`) says "Sun not up" only below
   −(34′ refraction + semidiameter) ≈ −0.838°
   ([es-astro.ts:774](../src/astronomy/es-astro.ts),
   [es-coordinates.ts:391](../src/astronomy/es-coordinates.ts)). The two
   apps disagree across a 0.83° band that partial-eclipse deep links hit
   constantly.

The web code is a faithful port: the identical fill and `horizonPixelY > 0`
label logic is in the iOS original
(`.observatory-ref/Classes/EOEclipseView.mm:292–308`). Like the topocentric
and ΔT fixes, this is the original author correcting the shared algorithm,
not a port repair — same iOS-parity posture (§7).

## 2. Goal (Steve, 2026-08-18)

The green overlay should sit at the **physical apparent horizon** relative
to the drawn discs — covering part of the Sun when the Sun is partly set,
half when half — and the "Below horizon" caption should flip **exactly when
Basel's wheel flips** to "Sun/Moon not up".

## 3. Why this is small: the geometry is already right except for one term

The disc view is an angular map: bodies are placed at their true relative
alt/az offsets around the midpoint (`±separation·ppar/2` along
`θ = atan2(altDelta, azDelta·cos)`, eclipse-view.ts:254–268), disc radii use
the same `ppar` (px/radian), and the horizon line is already drawn at the
midpoint's altitude: `horizonPixelY = −avgAlt·ppar` (:268, :298 for the
lunar branch). So each disc's covered fraction is already *geometrically*
correct — the only missing physics is that near the horizon we see the
**refracted** image, lifted ~34′.

### 3a. Overlay: apparent altitude via the engine's own refraction model

```ts
const apparentAvgAlt = avgAlt + kECRefractionAtHorizonX;   // both branches
horizonPixelY = -apparentAvgAlt * ppar;
```

Use the engine's existing constant
([astro-constants.ts:84](../src/astronomy/astro-constants.ts), 34′), **not**
an altitude-dependent formula (Sæmundsson/Bennett — rejected, §6), because
the constant is the refraction model the engine already lives by: rise/set
times (`altitudeAtRiseSet`) and the Basel/`calculateEclipse` "not up"
threshold are built on it. Consequences, all exact by construction:

- Caption-flip consistency: kind goes `SolarNotUp` at true alt
  −(34′ + SD) ⇔ apparent center = −SD ⇔ the disc's top edge touches the
  line ⇔ the wash has *just* fully covered it. No sliver-visible-but-
  captioned states.
- Rise/set consistency: at the engine's rise/set instant the disc sits
  tangent above the line.
- "Halfway" reads correctly: true alt −34′ → apparent 0 → line through
  disc center.

The unconditional shift is harmless away from the horizon: at high
altitudes the line is clamped off-disc regardless (:359–360 logic
unchanged). Apply identically in the lunar branch (:298) — the Moon's image
is the refracted thing there; the anti-solar shadow point is a geometric
construct but sits within a degree of the Moon, inside the stated
approximations (§5).

### 3b. Caption: gate on the eclipse kind, not on the pixel position

```ts
showHorizonLabel = drawingSomething &&
    (kind === EclipseKind.SolarNotUp || kind === EclipseKind.LunarNotUp);
```

`eclKind` is already streamed to the view
([obs-values.ts:299](../src/observatory/obs-values.ts), `eclipseKindRaw()`)
and is the same `calculateEclipse` classification Basel's
`legacyEclipseKind()` renders
([astro-env.ts:1928](../src/shared/astro-env.ts)) — so EO's caption and
Basel's wheel flip on the same tick of the same function, with the same
topocentric altitudes (`altitudeOfPlanet` ↔ `planetAltAz(...,
correctForParallax=true)`). Parity is by construction, not by matched
constants.

The overlay wash itself keeps its current independent life (it can cover
*part* of a disc with no caption — that's the point of the fix).

### 3c. Testable extraction

Pull the two decisions into a pure exported helper (no canvas):

```ts
export function horizonOverlayState(avgAlt: number, kind: EclipseKind):
    { apparentAvgAlt: number; showLabel: boolean }
```

so the fixture arithmetic in §8 becomes a vitest rather than a screenshot.

## 4. Explicitly not changing

- `calculateEclipse`, `altitudeAtRiseSet`, any obs-value expression, Basel's
  wheel, the ring hands, the caption text/typography, the overlay color, the
  10° draw gate, the clamp/`drawingSomething` logic.
- No altitude-dependent refraction anywhere else in the app.
- No attempt to draw refracted *flattening* (the real setting Sun is ~20%
  vertically squashed) — uniform lift only (§5).

## 5. Documented approximations (accepted)

- **Uniform refraction shift** at the horizon constant: real refraction at
  +1° true altitude is ~21′, not 34′, so a disc a degree up is drawn ~13′
  (≈ half a disc radius) closer to the line than reality. The overlay only
  matters within ~a degree of the horizon, and the error shrinks to zero
  exactly at the moments that matter (rise/set tangency, caption flip).
- **Midpoint anchoring**: one straight line at the *average* apparent
  altitude; differential refraction across the ≤1° visible scene (≤ a few
  arcmin) is ignored.
- **Existing placement approximations** unchanged: the az×cos(alt) fudge
  (:260) and linear alt/az mapping.

## 6. Rejected alternatives

- **Sæmundsson/Bennett altitude-dependent refraction** — better mid-altitude
  physics, but it disagrees with the engine's 34′ convention by ~3′ at the
  caption-flip altitude, re-creating exactly the sliver-mismatch this plan
  exists to remove; and it needs a new engine function + singularity
  handling. Wrong trade for a display strip one degree tall.
- **Threshold-only fix** (adopt −0.838° for the caption, leave the wash
  geometric — the original §10 sketch): kills the Basel disagreement but
  still paints a fully-visible touching-the-horizon Sun as fully set;
  fails Steve's "halfway when halfway" requirement.
- **Per-body horizon lines**: physically meaningless (there is one horizon)
  and the single line is already correct to arcminutes.
- **Removing the overlay**: it carries real information (how much of the
  event your site actually sees); the fix makes it honest rather than gone.

## 7. iOS parity

Deliberate divergence from `EOEclipseView.mm:292–308` until Steve mirrors
it, recorded the same way as the other two engine corrections: note in
[docs/observatory.md](../docs/observatory.md) (display behavior, so the
observatory doc rather than astronomy.md), and flag the mirror change +
line numbers in the commit message.

## 8. Verification

Fixture arithmetic (constant = 0.567°; Sun SD ≈ 0.27°), asserted in the
§3c unit test and eyeballed via the eclipse-table deep links:

| true center alt | apparent | expected look | caption | Basel wheel |
|---|---|---|---|---|
| −0.202° (2014 Apr 29 row) | +0.365° | disc fully visible, sky gap of ~0.1° below | off | Partial |
| −0.274° (2011 Jan 04 row) | +0.293° | fully visible, bottom limb ~1′ above the line | off | Partial |
| −0.567° | 0 | **half** covered | off | Partial |
| −0.838° | −0.271° = −SD | wash just closes over the top limb | **flips on** | flips to Sun not up |
| −1.5° | −0.93° | fully green | on | Sun not up |

- Unit: `horizonOverlayState` at the five rows above; plus lunar-branch
  spot values.
- Headless (established recipes; note the browser pane may not fire rAF —
  fall back to state assertions or Steve's dist flow): open the 2011 Jan 04
  and 2014 Apr 29 Observatory deep links from the eclipse-data harness —
  before: full green + "Below horizon"; after: fully visible Sun on the
  horizon, no caption. Scrub ±minutes to watch the wash slide through the
  half-covered state with no caption until the flip.
- **Cross-app parity check**: at each of the ~12 disagreement-band rows,
  open the paired Chronometer link — EO caption state must equal Basel's
  wheel state at every one (post-change this is tautological; the check
  guards the wiring).
- Full suite + `tsc --noEmit`; no goldens should move (this file has no
  regression coverage; observatory-layout snapshots don't render the
  eclipse disc contents).

## 9. Commit breakdown (Steve owns every commit)

1. `horizonOverlayState` helper + unit test + the two-line integration in
   `drawEclipseView` (both branches) + docs/observatory.md divergence note.
   One commit — the change is small; the plan is long only because the
   reasoning needed writing down.
