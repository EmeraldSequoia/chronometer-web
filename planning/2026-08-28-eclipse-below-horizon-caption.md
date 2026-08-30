# EO eclipse simulator: "Below horizon" caption follows the wash, not the wheel

**Status**: **IMPLEMENTED 2026-08-28** as specified (helper signature +
call-site wiring + rename, tests reworked per §8, docs per §9); direction
approved by Steve the same day (keep the proportional wash, caption at body
closure — "option 1"). **Amended and re-implemented 2026-08-30** (§12):
after a field report of the §6 lunar sliver artifact, the wash line is now
anchored to the *drawn primary body* rather than the scene midpoint, making
caption ⟺ painted closure an exact identity and retiring the artifact.
Commit pending (Steve's).
**Created**: 2026-08-28
**Baseline**: a95d100
**Supersedes**: §3b (the caption gate) of
[2026-08-18-eclipse-horizon-indicator.md](2026-08-18-eclipse-horizon-indicator.md).
The wash geometry from that plan (§3a, apparent-horizon lift) is correct and
unchanged.

## 1. Symptom (Steve, 2026-08-28)

The disc shows the green below-horizon wash — often covering the *entire*
scene — with no "Below horizon" caption, for hours at a stretch. Headless
probe reproductions (scratchpad probe replaying `drawEclipseView`'s exact
geometry against the live engine; San Jose, 37.2 / −121.9):

```
UTC                   kind        sunAlt°   moonAlt°  green%  body%  caption
2026-08-27T23:10:00Z  NoneLunar    40.952   -40.288   100.0   100.0    —     Moon 40° down, disc fully green, no caption
2026-08-28T01:00:00Z  NoneLunar    19.588   -19.336   100.0   100.0    —
2026-08-28T01:30:00Z  LunarNotUp   13.610   -13.498   100.0   100.0   YES    caption pops on; nothing on screen changed
2026-03-19T02:20:00Z  NoneSolar    -1.268    -1.322   100.0   100.0    —     Sun below horizon all night, never captions
```

The engine's own rise/set test (`altitudeAtRiseSet`) confirms the body is
genuinely down in every uncaptioned row — the wash is *right*; the caption is
missing.

## 2. Root cause: the caption is gated on a Basel-wheel display value

The 2026-08-18 change gated the caption on the eclipse kind
([eclipse-view.ts:228](../src/observatory/eclipse-view.ts)):
`showLabel = kind === SolarNotUp || kind === LunarNotUp`, for exact parity
with Basel's wheel. But `calculateEclipse` ends with the needle-pegging
override ([es-astro.ts:830-833](../src/astronomy/es-astro.ts), a faithful
port of iOS `ECAstronomy.m:4463-4465` — "override possible not-up if needle
is pegged"):

```ts
} else if (abstractSeparation > 3) {
    abstractSeparation = 3;
    eclipseKind = solarNotLunar ? EclipseKind.NoneSolar : EclipseKind.NoneLunar;
}
```

`EclipseKind` is a **wheel display value**: when the separation runs off the
0–3 needle scale, the wheel must read "None", so the `SolarNotUp`/`LunarNotUp`
decided earlier in the same function (es-astro.ts:785-786, :813-814) is
discarded. The disc, however, keeps drawing far past the point where the
needle pegs, so there is a wide separation band in which the caption is
*structurally impossible* no matter how far below the horizon the body is:

| branch | kind pegs to `None…` above sep ≈ | disc still draws to sep ≈ | dead band |
|---|---|---|---|
| solar (3·SD☉ + SD☾) | **1.06°** | **1.91°** | 0.85° |
| lunar (3·SD☾ + R_umbra) | **1.48°** | **2.59°** | 1.11° |

(The draw limit is layout-independent: `viewR/ppar` ≈ 0.687° regardless of
scale.) The Moon crosses the dead band at ~0.5°/hr twice per lunation, which
is why the episodes last hours. Year-2026 scan, minutes:

| site | disc drawn | wash visible | caption today | longest fully-green-no-caption |
|---|---|---|---|---|
| San Jose 37°N | 2812 | 1316 | **68** | 298 min (2026-07-29) |
| Reykjavík 64°N | 2822 | 1360 | **464** | 370 min |
| Singapore 1°N | 3182 | 1686 | **778** | 140 min |

At San Jose the caption is absent ~95% of the time the wash is up.

## 3. Intended model (Steve, 2026-08-28)

- Nothing interesting (separation ≥ 10°, or scene off-disc): no bodies, no
  wash, no caption — "Eclipse Simulator". *(Already works; unchanged.)*
- Interesting and the event below the horizon: wash **and** caption together.
- Refinement kept from 2026-08-18 ("halfway looks halfway"): during the brief
  rise/set transition the wash covers only the below-horizon *portion* of the
  scene, with no caption; the caption appears at the moment the wash fully
  closes over the primary body.

[help.html:786-795](../src/help.html) already documents exactly this: "A green
wash covers any part of the scene below the apparent horizon (refraction
included), and once the eclipsed body has fully set at your location a 'Below
horizon' caption appears over it." The code never did the second half; this
plan makes it true. No help change needed.

## 4. The fix: gate the caption on wash closure over the primary body

The primary body is the thing being eclipsed — the **Sun** in the solar
branch, the **Moon** in the lunar branch (the silhouette Moon is dark and the
umbra is a construct). "Wash fully closed over it" is pure angle arithmetic:

```
showLabel  ⟺  bodyAlt + kECRefractionAtHorizonX + bodyAngularRadius ≤ 0
```

which is exactly the engine's topocentric rise/set altitude
(`altitudeAtRiseSet(…, wantGeocentricAltitude=false)` =
−34′ − angularDiameter/2, [es-coordinates.ts:390-399](../src/astronomy/es-coordinates.ts)).
So the caption flips at the engine's rise/set instant for the body:
the Sun at −0.83°…−0.84° true altitude, the Moon at −0.81°…−0.85° (both vary
with the body's apparent size through the year/orbit).

In the **solar** branch this is also pixel-exact against the painted wash
(`avgAlt` cancels; the drawn Sun sits at its altitude-map position to well
under a pixel): caption ⟹ the Sun's disc is entirely under the wash, and a
fully-washed Sun ⟹ caption. A year-long probe scan measured **zero**
disagreement minutes. In the **lunar** branch the painted scene itself is
slightly offset from the altitude map (pre-existing, iOS-faithful — §6), so
the caption is anchored to the *truth* (the Moon has set) rather than to the
drawn pixels; measured visible disagreement is 1–4 min/yr (§6).

### 4a. `horizonOverlayState` signature change ([eclipse-view.ts:222](../src/observatory/eclipse-view.ts))

```ts
export function horizonOverlayState(
    avgAlt: number,             // scene-midpoint true altitude → wash position
    bodyAlt: number,            // primary body's true altitude (Sun / Moon)
    bodyAngularRadius: number,  // its topocentric angular radius (rad)
): { apparentAvgAlt: number; showLabel: boolean } {
    return {
        apparentAvgAlt: avgAlt + kECRefractionAtHorizonX,   // unchanged (§3a of the 08-18 plan)
        showLabel: bodyAlt + kECRefractionAtHorizonX + bodyAngularRadius <= 0,
    };
}
```

`kind` drops out of the helper entirely (it keeps its other jobs at :273-274
and :310: branch selection and the TotalSolar image).

### 4b. Call-site wiring — no new obs-values, no engine change

Both inputs are already on hand. Hoist the angular radii the pixel radii are
computed from ([eclipse-view.ts:268-271](../src/observatory/eclipse-view.ts)):

```ts
const moonAngularRadius = Math.atan(LUNAR_RADIUS_KM / (moonDist * AU_KM));
const sunAngularRadius = Math.atan(SOLAR_RADIUS_KM / (sunDist * AU_KM));
const moonPixelRadius = ppar * moonAngularRadius;   // was: ppar * Math.atan(…)
const sunPixelRadius = ppar * sunAngularRadius;
```

- Solar call site (:306): `horizonOverlayState(avgAlt, sunAlt, sunAngularRadius)`
- Lunar call site (:338): `horizonOverlayState(avgAlt, moonAlt, moonAngularRadius)`

Rename `horizonLabelForKind` → `washClosedOverBody` (:282, :308, :340, :401).
The `drawingSomething` gate on the label (:401) is unchanged — no caption when
the scene is off-disc.

### 4c. Comment updates in the same file

The file header (:13-15) and the big `horizonOverlayState` docstring
(:197-221) both describe the kind gate; rewrite the **Caption** paragraph to
state the closure rule and *why the kind was the wrong anchor* (the §2
needle-pegging override — worth recording where the next reader will look).
The **Overlay position** paragraph stands.

## 5. Explicitly not changing

- `calculateEclipse` and the needle-pegging override — correct for a wheel,
  iOS-faithful, and shared with Basel and the eclipse table. `eclipseKind`
  stays a display value.
- The wash geometry: apparent-horizon lift, proportional coverage, the
  `horizonPixelY > -viewR` visibility test and clamp, color, the 10° gate,
  `drawingSomething`.
- Basel's wheel, `legacyEclipseKind`, the eclipse-table page, obs-values,
  expr functions, cache slots.
- The eclipse update sentinel: `nextInterestingEclipseMotion`
  ([animation.ts:546-558](../src/shared/animation.ts)) keys only on the 10°
  separation threshold, and the caption can only flip while the disc draws —
  the ≤1 s regime. Its new inputs (`eclSunAlt`/`eclMoonAlt`/`eclSunDist`/
  `eclMoonDist`, [obs-values.ts:300-310](../src/observatory/obs-values.ts))
  already ride the same sentinel `eclKind` did. No resolver change.
- help.html (§3 — it already describes the new behavior).

## 6. Approximations and edge cases (accepted)

- **Solar branch: pixel-exact.** The drawn Sun's vertical offset uses
  `sinθ·separation·ppar/2` (the az×cos fudge) vs the predicate's `sunAlt`;
  at the ≤1.9° separations where the disc draws these agree to well under a
  pixel at reference scale. Probe scan over 2026 at three latitudes: 0.0
  min of caption-vs-pixels disagreement.
- **Lunar branch: the painting, not the caption, is approximate.**
  *(Superseded by §12, 2026-08-30 — the body-anchored wash line retires this
  artifact; the umbra outline absorbs the offset instead.)* The Moon
  is drawn at `sinθ·(separation − shadowR)·ppar/2` (:350; 0 inside the
  umbra, :356) — the drawn Moon+shadow pair is offset from the wash's
  `avgAlt` anchor by `sinθ·shadowR/2`, up to ~0.39° ≈ 28 px at reference
  scale when the shadow–Moon axis is near-vertical. This is the iOS
  original's composition (it centers the action, not the altitude map) and
  is unchanged. Consequence: for **1–4 min/yr** (probe, three sites) the
  caption sits over a drawn Moon still showing a limb above the wash —
  worst measured sliver ~35 px (2026-07-29T13:06Z San Jose, sinθ 0.84,
  moments after the very episode in §2's table). At those instants the Moon
  *has* physically set — the caption is truthful and the drawn limb is the
  0.3° placement artifact. The reverse (fully washed, no caption) measured
  ≤1 min/yr. Note the 08-18 plan's §3 claim that bodies sit at
  "±separation·ppar/2 around the midpoint" was solar-only; its §5 "existing
  placement approximations unchanged" covers this without spelling it out.
- **Topocentric vs geocentric semidiameter.** The predicate uses the same
  topocentric radii the discs are drawn with; the engine's not-up test uses
  geocentric radii. For the Moon they differ by up to ~0.3′ of threshold
  altitude (~a minute of clock time at moonset): in that sliver the wheel
  can read "Moon not up" while the disc still shows a last limb above the
  wash — the disc is the finer instrument, and the display stays
  self-consistent.
- **eclSunAlt is not parallax-corrected** (`sunAltitude` →
  `planetAltAz(…, correctForParallax=false)`) while the engine's not-up test
  is; the difference is the solar parallax, ≤8.8″. Ignored.
- **TotalSolar corona.** The totality image (~4.6× the Sun's radius) can keep
  a corona edge above a wash the caption ignores — unreachable in practice
  (TotalSolar requires the Sun above `altitudeAtRiseSet`, which negates the
  predicate) except within the ~arcsecond topo/geocentric sliver above.
- **No hysteresis** on the flip, same as the kind gate today; the altitudes
  move smoothly and dithering is not a practical risk.
- **Behavior change, by design**: the caption will show whenever the drawn
  scene has fully set — ≈1300 min/yr at San Jose vs 68 today (§2 table),
  including ordinary non-eclipse conjunctions inside 10°. That is the honest
  reading of a fully green disc (§3).

## 7. Rejected alternatives

- **Remove the engine's needle-pegging override** (let `SolarNotUp` survive
  pegging): changes Basel's wheel — it would read "Sun not up" where iOS
  deliberately shows blank/none ("override possible not-up if needle is
  pegged" is design intent, not a bug) — and touches shared classification
  used by the wheel, the inspector, and iOS parity. The wheel is right for a
  wheel; the disc needs its own predicate.
- **New engine output / expr function** exposing the pre-clamp not-up boolean:
  new cache slot + expr + obs-value wiring for a value the view can compute
  from inputs it already has.
- **Pixel-space gate** (compare the *drawn* body position against the wash
  line): guarantees zero visible sliver, but in the lunar branch the drawn
  scene is offset from the altitude map (§6), so the caption would fire up
  to ~2 min of clock time away from the Moon's actual set — diverging from
  the engine's rise/set instant and from help.html's "once the eclipsed body
  has fully set". Wrong trade to suppress 1–4 min/yr of artifact the
  painting itself causes.
- **Strict binary wash+label** (wash all-or-nothing at one threshold):
  rejected by Steve 2026-08-28 — keeps "halfway looks halfway" (the top of
  the wash shows the horizon when in view).
- **Whole-disc-green gate** (`apparentAvgAlt ≤ −viewR/ppar` ≈ −1.25° true):
  ties caption semantics to the view radius, captions later than the body's
  actual setting, and misses the lunar corner where the Moon is fully set but
  the shadow outline still peeks in at the disc top.

## 8. Verification

Fixture rows (probe-verified at baseline; caption column = new rule):

| case | kind | bodyAlt° | wash | caption new (old) |
|---|---|---|---|---|
| 2026-08-28T01:00Z San Jose | NoneLunar | −19.34 (Moon) | full | **YES** (—) |
| 2026-03-19T02:20Z San Jose | NoneSolar | −1.27 (Sun) | full | **YES** (—) |
| 2026-08-28T01:30Z San Jose | LunarNotUp | −13.50 (Moon) | full | YES (YES) |
| 2011-01-04T08:07:30Z London | PartialSolar | −0.61 (Sun) | ~49% of disc | — (—) |
| Sun at −(34′+SD) exactly | any solar | −0.838 | just closed | flips on |
| Sun at −34′ (half set) | PartialSolar | −0.567 | half the disc | — |

(2026-07-29T13:06Z San Jose is the worst-case lunar sliver instant — caption
on, ~35 px limb drawn above the wash; the §6 accepted artifact, worth an
eyeball once.)

- **Unit** — rework the two `horizonOverlayState` describes
  ([eclipse.test.ts:207-256, :258-291](../src/observatory/__tests__/eclipse.test.ts)):
  - Refraction-lift describe (:207): the 5-row fixture table (:215-225) keeps
    its assertions under the new call signature; the three kind-passing lift
    tests (:227-231, :244-248, :250-255) get mechanical signature edits; the
    kind-flip test (:233-242) *merges into* the new flip test — under the new
    rule −(34′+SD) **is** the caption flip, so its "line one semidiameter
    above center" assertion and the ±ε label assertions become one test.
  - Kind-gate describe (:258): the kind→label table (:262-274) is replaced by
    the altitude→label table above (±ε around −(34′+SD)); the half-set test
    (:276-283) keeps the wash-without-caption property in its new form; the
    mismatched-midpoint test (:285-290) becomes "showLabel is independent of
    `avgAlt`" (assert with a deliberately absurd midpoint).
  - A convention pin test: fed the engine's own geocentric radius, the
    predicate's flip altitude must equal `altitudeAtRiseSet(…, false)` exactly
    — so a future change to the engine's rise/set shape (new refraction model,
    a parallax/dip term) fails the suite instead of silently diverging the
    caption from Basel's wheel.
  - Engine-integration regressions pinning the bug: `calculateEclipse` at the
    first two fixture rows must return the *pegged* kinds (`NoneLunar` /
    `NoneSolar`) while the predicate (fed `moonAltitude`/`sunAltitude` + the
    topocentric radius) says label ON — this is the pair the kind gate got
    wrong, and it guards against anyone re-anchoring the caption to the kind.
  - Update the file-header comment (item (c), :10-12) and the plan reference.
    Imports are unchanged (`EclipseKind` et al. all remain used).
- **Headless** (established recipes; browser-pane rAF may be frozen — fall
  back to state assertions or Steve's dist flow): Observatory at San Jose,
  2026-08-28T01:00Z deep link → fully green disc **with** caption; scrub a
  lunation to confirm caption ⟺ full wash everywhere, with the partial-wash
  transition uncaptioned. The 2011-01-04 / 2014-04-29 sunrise links from the
  08-18 plan must look exactly as they do today until the top limb submerges.
- **Year-scan cross-check** (probe): under the new rule the residual
  wash-without-caption time is 14–16 min/yr (three sites) in a handful of
  ≤5-min episodes — all genuine half-set transitions. Any bigger residual
  means a wiring bug.
- Full suite + `tsc --noEmit`. No goldens move (no engine change; layout
  snapshots don't render disc contents).

## 9. Docs

- [docs/observatory.md](../docs/observatory.md) "Below-horizon overlay"
  section (:714-765) — four spots, not just the Caption bullet:
  - the section **header** (:714) says "kind-gated caption"; rename;
  - the lead-in (:731) quotes the old signature `horizonOverlayState(avgAlt,
    kind)`;
  - the **Caption** bullet (:744-748) — rewrite to the closure rule, plus a
    dated **2026-08-28** paragraph recording the kind-gate flaw
    (needle-pegging dead band, §2 numbers) and the supersession; add the
    lunar paint-offset and topo/geo-SD approximations;
  - the iOS-status paragraph (:759-764) still claims iOS "has the original
    fill and `horizonPixelY > 0` label logic and needs the mirror change" —
    stale since the 2026-08-20 back-port (Observatory `1f0bf05`) and doubly
    wrong after this change; rewrite to the current state.
  - (:708's loose "when the eclipse itself is below the horizon" survives the
    new rule; glance during the rewrite.)
- [docs/ios-backports.md](../docs/ios-backports.md): the ledger (row :136,
  "all landed" wrap-up ~:147-156) now over-claims — note that the caption
  half of the horizon back-port is superseded and needs a follow-up.
- This plan's **Supersedes** note added to the top of
  [2026-08-18-eclipse-horizon-indicator.md](2026-08-18-eclipse-horizon-indicator.md)
  (retroactive status updates are house style).
- Note in [2026-08-19-ios-backport-horizon.md](2026-08-19-ios-backport-horizon.md)
  that the caption half of the mirrored change is superseded and needs a
  follow-up back-port.

## 10. iOS parity

`EOEclipseView.mm` now carries the kind-gated caption from the 2026-08-19
back-port (Observatory `1f0bf05`), so it has this bug too (its original
`horizonPixelY > 0` gate did not — it had the 08-18 plan's §1 defects
instead). Same posture as the other engine corrections: web first, divergence
recorded in docs/observatory.md and the ios-backports ledger, then a separate
back-port plan (`ios-backports/` clones, Steve pushes) for a fresh session
once the web change has soaked.

## 11. Commit breakdown (Steve owns every commit)

One commit: helper signature + call-site wiring + rename + comment rewrite
+ tests + docs (observatory.md, ios-backports.md, the two planning-doc
notes). The change is a few lines of substance; the plan is long because the
wrong anchor was chosen for good-sounding reasons (cross-app parity) and the
why — plus the lunar paint-offset caveat — needs writing down.

## 12. Amendment 2026-08-30: anchor the wash to the drawn body (field report)

**Trigger.** Steve observed the §6 artifact live within hours of the fix:
at 2026-08-28T02:35:54Z (Los Gatos deep link), a ~3 px sliver of the rising
Moon showed above the wash while "Below horizon" was still up. Probe replay:
the caption (truthfully) held until moonAlt crossed −(34′+SD) at 02:35:53,
but the *drawn* Moon — offset upward by `sinθ·shadowR/2` because the lunar
composition centers the action, not the altitude map — had poked above the
midpoint-anchored wash line 13 s earlier. The old kind gate had the identical
sliver at this transition (the kind is not needle-pegged there); the 08-28
change inherited it and documented it as accepted (§6). Field-observed within
hours ⇒ not acceptable.

**Fix (Steve's insight): the composition offset and the wash anchor are
independent choices.** Keep the iOS composition exactly as drawn; re-anchor
the wash line so the *drawn primary body* sits at its true altitude:

```
horizonPixelY = −(bodyAlt + kECRefractionAtHorizonX)·ppar − bodyPixelY
```

(solar: Sun/`sunPixelY`; lunar: Moon/`moonPixelY`; previously
`−(avgAlt + 34′)·ppar` in both). The closure identity is then exact — the
drawn top limb sits at the line ⟺ `bodyAlt + 34′ + bodyAngularRadius = 0`,
with `bodyPixelY` cancelling identically — so the §4 caption predicate, the
engine's rise/set instant, and the painted pixels agree by construction in
*both* branches. The §6 "caption over a visible sliver" artifact (1–4 min/yr,
worst ~35 px) and its ≤1 min/yr converse both go to zero, and the sub-pixel
solar az-fudge residual retires too. "Halfway looks halfway" strengthens: it
now holds for the body itself, not the abstract midpoint.

**What absorbs the offset instead**: a single straight line cannot be exact
for two objects ~1.4° apart in a compressed composition. Previously the error
was split between Moon and shadow; now the Moon (the visible object) is exact
and the umbra *outline* — a geometric construct nobody can see in the sky —
absorbs up to `sinθ·shadowR` (~50 px at reference scale, worst inclination).
In the solar branch the dark Moon silhouette absorbs a sub-pixel error.
Accepted: the wash is now exact precisely where a viewer can check it.

**Consequences for the code**: `horizonOverlayState` simplifies —
`avgAlt` drops out entirely; signature `(bodyAlt, bodyAngularRadius)`
returning `{ apparentBodyAlt, showLabel }`; the call sites (which already
compute the drawn positions first in the solar branch, and are reordered to
do so in the lunar branch) add the `− bodyPixelY` term. The caption predicate
is unchanged; the §-earlier AND-gate idea is unnecessary. One more deliberate
iOS divergence in the same line the 08-18 refraction lift already diverged
(EOEclipseView.mm:292–308); the pending 1f0bf05 follow-up mirror folds both
in. Tests: the refraction-lift fixtures re-anchor from `avgAlt` to `bodyAlt`
(same numbers), the pin and needle-pegging regression tests survive, and a
new test asserts the pixel-space cancellation identity directly.

**§12 verification (2026-08-30).** Probe replay of the re-anchored call sites:
at the field-report instant the Moon stays 100% covered through every
captioned tick, the caption drops at the 02:35:53 flip with the drawn limb
exactly tangent to the line, and the first sliver (1.2 px) appears only
after. Year-2026 scan at San Jose / Singapore / Reykjavík: caption-with-
sliver **0.0 min** and fully-closed-without-caption **0.0 min** at all three
(previously 1–4 and ≤1 min/yr); wash-without-caption 17–18 min/yr — all
genuine half-set transitions. Unit suite reworked per §12 (fixtures
re-anchored to the body, a pixel-space cancellation-identity test added;
25 tests), full suite + `tsc --noEmit` clean.
