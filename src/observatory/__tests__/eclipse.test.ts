/**
 * Phase 7B eclipse simulator tests.
 *
 *  (a) calculateEclipse / EclipseKind around known eclipses — validates the
 *      quantities the expr-function wrappers (eclipseAngularSeparation,
 *      eclipseShadowAngularSize, eclipseKindRaw) read.
 *  (b) the EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION resolver: ~1 s while the
 *      disc is shown (separation < 10°), and a capped (≤1 h) interval that never
 *      overshoots the threshold crossing while only the caption is up.
 *  (c) horizonOverlayState: the refraction lift the green below-horizon wash
 *      is drawn at (planning/2026-08-18-eclipse-horizon-indicator.md), the
 *      body-anchored wash line that makes caption ⟺ painted closure an exact
 *      identity (plan-08-28 §12), and the "Below horizon" caption that flips
 *      exactly when the wash closes over the eclipsed body — NOT on the
 *      eclipse kind, whose needle-pegging override made the caption
 *      unreachable while the disc still drew
 *      (planning/2026-08-28-eclipse-below-horizon-caption.md).
 */
import { describe, test, expect } from 'vitest';
import {
    calculateEclipse,
    EclipseKind,
    eclipseKindIsMoreSolarThanLunar,
} from '../../astronomy/es-astro';
import {
    nextInterestingEclipseMotion,
    EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION,
} from '../../shared/animation';
import { createAstroEnvironment } from '../../shared/astro-env';
import { makeOverridableGetNow, type TimingContext } from '../../shared/updater';
import { buildObsValues } from '../obs-values';
import { horizonOverlayState } from '../eclipse-view';
import { kECRefractionAtHorizonX, ECPlanetNumber } from '../../astronomy/astro-constants';
import {
    altitudeAtRiseSet,
    distanceOfPlanetInAU,
    planetSizeAndParallax,
} from '../../astronomy/es-coordinates';
import { julianCenturiesSince2000EpochForDateInterval } from '../../astronomy/es-time';

function appleEpoch(date: Date): number {
    return date.getTime() / 1000 - 978307200;
}
function toRad(deg: number): number {
    return deg * Math.PI / 180;
}

const THRESHOLD = Math.PI / 18;  // 10°

const SUN_SD_DEG = 0.271;              // solar semidiameter, ≈ 16.3′
const SUN_SD = toRad(SUN_SD_DEG);

// Port constants + the angular-radius mirror of eclipse-view.ts:82-85 —
// deliberately duplicated rather than imported: the mirror IS the assertion
// that the view's math is what these tests think it is.
const AU_KM = 149600000.0;
const LUNAR_RADIUS_KM = 1737.10;
const SOLAR_RADIUS_KM = 695500;
const moonAngR = (distAU: number) => Math.atan(LUNAR_RADIUS_KM / (distAU * AU_KM));
const sunAngR = (distAU: number) => Math.atan(SOLAR_RADIUS_KM / (distAU * AU_KM));

/**
 * Build the real Observatory obs-value updater at a frozen instant and run one
 * 1×-forward tick (mirrors observatory-entry's bootstrap). Shared by the
 * sentinel, disc-radius, and caption-regression describes.
 */
function tickedObsValues(iso: string, latDeg: number, lonDeg: number) {
    const base = () => new Date(iso);
    const { getNow, withDisplayTime } = makeOverridableGetNow(base);
    const env = createAstroEnvironment(latDeg, lonDeg, getNow);
    // Variables other Observatory defs reference (mirrors observatory-entry).
    env.variables.set('noonOnTop', 0);
    env.variables.set('dialPlanet', 0);
    const perfNow = performance.now();
    const updater = buildObsValues(env, perfNow, getNow);
    const ctx: TimingContext = { tickIntervalMs: null, displayDeltaSec: 0, direction: 1 };
    updater.tick(env, perfNow, getNow, withDisplayTime, ctx);
    return { updater, getNow };
}

describe('calculateEclipse — known events', () => {
    test('2026-08-12 total solar eclipse: small separation, solar kind', () => {
        // Greatest eclipse ≈ 17:46 UT; path crosses northern Spain.
        const t = appleEpoch(new Date('2026-08-12T18:30:00Z'));
        const r = calculateEclipse(t, toRad(43.0), toRad(-6.0), null);
        expect(r.angularSeparation).toBeLessThan(THRESHOLD);
        expect(eclipseKindIsMoreSolarThanLunar(r.eclipseKind)).toBe(true);
    });

    test('2026-03-03 total lunar eclipse: small separation, lunar kind, shadow > 0', () => {
        // Greatest eclipse ≈ 11:33 UT; visible from the Pacific / E. Asia.
        const t = appleEpoch(new Date('2026-03-03T11:33:00Z'));
        const r = calculateEclipse(t, toRad(20.7), toRad(-156.15), null);
        expect(r.angularSeparation).toBeLessThan(THRESHOLD);
        expect(eclipseKindIsMoreSolarThanLunar(r.eclipseKind)).toBe(false);
        expect(r.shadowAngularSize).toBeGreaterThan(0);
    });

    test('first quarter moon: large separation, no eclipse', () => {
        // 2026-08-20 is roughly first quarter (≈90° from new on 2026-08-12).
        const t = appleEpoch(new Date('2026-08-20T12:00:00Z'));
        const r = calculateEclipse(t, toRad(37.2), toRad(-121.9), null);
        expect(r.angularSeparation).toBeGreaterThan(THRESHOLD);
        expect([EclipseKind.NoneSolar, EclipseKind.NoneLunar]).toContain(r.eclipseKind);
    });
});

describe('eclipse update sentinel resolver', () => {
    const lat = toRad(43.0), lon = toRad(-6.0);
    const at = (iso: string) => () => new Date(iso);

    test('inside the threshold → ~1 s cadence (forward)', () => {
        const getNow = at('2026-08-12T18:30:00Z');
        const nowDI = appleEpoch(getNow());
        const next = nextInterestingEclipseMotion(getNow, lat, lon, 1);
        expect(next - nowDI).toBeCloseTo(1, 6);
    });

    test('outside the threshold → capped at ≤ 1 hour, in the future', () => {
        const getNow = at('2026-08-20T12:00:00Z');  // first quarter, far from eclipse
        const nowDI = appleEpoch(getNow());
        const next = nextInterestingEclipseMotion(getNow, lat, lon, 1);
        const dt = next - nowDI;
        expect(dt).toBeGreaterThan(1);
        expect(dt).toBeLessThanOrEqual(3600);
    });

    test('never overshoots the crossing: separation stays > threshold at the returned time', () => {
        // ~1.5 days before the solar eclipse, comfortably outside 10°.
        const getNow = at('2026-08-11T00:00:00Z');
        const nowDI = appleEpoch(getNow());
        const sepNow = calculateEclipse(nowDI, lat, lon, null).angularSeparation;
        expect(sepNow).toBeGreaterThan(THRESHOLD);  // precondition: caption mode
        const next = nextInterestingEclipseMotion(getNow, lat, lon, 1);
        const sepNext = calculateEclipse(next, lat, lon, null).angularSeparation;
        // Conservative bound must not skip past the crossing into the disc-drawn
        // region (allow a tiny epsilon for the boundary itself).
        expect(sepNext).toBeGreaterThan(THRESHOLD - 1e-6);
    });

    test('reverse time direction returns a time in the past', () => {
        const getNow = at('2026-08-20T12:00:00Z');
        const nowDI = appleEpoch(getNow());
        const next = nextInterestingEclipseMotion(getNow, lat, lon, -1);
        expect(next).toBeLessThan(nowDI);
        expect(nowDI - next).toBeLessThanOrEqual(3600);
    });
});

describe('eclipse sentinel — end-to-end through the updater', () => {
    // Builds the real Observatory updater and drives one 1×-forward tick, then
    // reads a registered ecl* value's scheduled next-update time. This exercises
    // the full path: the value's registered updateInterval → computeNextBoundary
    // → resolveSentinel's new case → nextInterestingEclipseMotion → display ms.

    // Schedule eclSeparation once at a given time/location and return the gap
    // (ms) between its next-update display time and "now".
    function scheduledGapMs(iso: string, latDeg: number, lonDeg: number): number {
        const { updater, getNow } = tickedObsValues(iso, latDeg, lonDeg);
        const v = updater.get('eclSeparation');
        // Sanity: the value really is registered on the eclipse sentinel.
        expect(v.updateInterval).toBe(EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION);
        return v.nextUpdateDisplayTime - getNow().getTime();
    }

    test('near an eclipse → next update ~1 s out', () => {
        // N Spain during the 2026-08-12 total solar eclipse (separation < 10°).
        const gap = scheduledGapMs('2026-08-12T18:30:00Z', 43.0, -6.0);
        expect(gap).toBeGreaterThan(995);
        expect(gap).toBeLessThan(1005);
    });

    test('away from an eclipse → next update > 1 s and ≤ 1 h out', () => {
        // First quarter, far from any eclipse (separation ≫ 10°).
        const gap = scheduledGapMs('2026-08-20T12:00:00Z', 43.0, -6.0);
        expect(gap).toBeGreaterThan(1005);
        expect(gap).toBeLessThanOrEqual(3600 * 1000);
    });
});

describe('simulator discs are sized topocentrically', () => {
    // eclSunDist/eclMoonDist feed the drawn disc radii. They must be
    // topocentric, or the simulator draws a Moon too small to cover a Sun it
    // has already labelled Total — an annulus at a total eclipse
    // (planning/2026-08-16-topocentric-eclipse-sizes.md). Geocentrically the
    // hybrids below give moon/sun ≈ 0.998–0.9998; topocentrically ≈ 1.014–1.016.
    /** Drive the real obs-values once and reproduce eclipse-view's disc radii. */
    function discRadii(iso: string, latDeg: number, lonDeg: number) {
        const { updater } = tickedObsValues(iso, latDeg, lonDeg);
        return {
            moonR: moonAngR(updater.get('eclMoonDist').currentValue),
            sunR: sunAngR(updater.get('eclSunDist').currentValue),
            kind: Math.round(updater.get('eclKind').currentValue) as EclipseKind,
        };
    }

    // NASA's published greatest-eclipse UT and path-page point for the two
    // hybrids of 2011–2041; both are total there. (Hardcoded fixtures —
    // eclipse-data.json itself now stores TT instants and reduced positions.)
    test.each([
        ['2013-11-03 hybrid', '2013-11-03T12:46:29Z', 3.49, -11.6983],
        ['2023-04-20 hybrid', '2023-04-20T04:16:45Z', -9.595, 125.78],
    ])('%s: Moon disc covers the Sun with room to spare', (_label, iso, lat, lon) => {
        const { moonR, sunR, kind } = discRadii(iso as string, lat as number, lon as number);
        expect(kind).toBe(EclipseKind.TotalSolar);
        // Not just `moonR > sunR`: geocentric distances leave 2013 covered by a
        // hairline (1.0003) purely because the view's body radii differ a little
        // from the ephemeris ones, and leave 2023 uncovered outright. The real
        // topocentric margin at these near-overhead eclipses is ~1.5%.
        expect(moonR / sunR).toBeGreaterThan(1.005);
    });

    test('2020-06-21 annular: Moon disc stays smaller than the Sun', () => {
        // The correction must not flip an annular; its topocentric margin is
        // small (moon/sun ≈ 0.994) but the sign is unambiguous.
        const { moonR, sunR, kind } = discRadii('2020-06-21T06:40:06Z', 30.52, 79.665);
        expect(kind).toBe(EclipseKind.AnnularSolar);
        expect(moonR).toBeLessThan(sunR);
    });
});

describe('horizonOverlayState — refraction lift', () => {
    const toDeg = (rad: number) => rad * 180 / Math.PI;
    const REFRACTION_DEG = 34 / 60;        // 0.5667° — the engine's convention
    const SD = SUN_SD;                     // body radius arg (lift ignores it)

    // The §8 fixture table of planning/2026-08-18-eclipse-horizon-indicator.md,
    // re-anchored to the primary body (plan-08-28 §12): trueAlt is the BODY's
    // altitude, and "apparent" is where the wash line sits relative to the
    // drawn body; positive = line below the body (still up), negative = above.
    test.each([
        ['2014-04-29 row: fully visible, small gap below', -0.202, 0.365],
        ['2011-01-04 row: bottom limb ~1′ above the line', -0.274, 0.293],
        ['halfway: line through the body center', -0.567, 0.000],
        ['caption flip: wash just closes over the top limb', -0.838, -0.271],
        ['well set: fully green', -1.500, -0.933],
    ])('%s', (_label, trueAltDeg, expectedApparentDeg) => {
        const bodyAlt = (trueAltDeg as number) * Math.PI / 180;
        const { apparentBodyAlt } = horizonOverlayState(bodyAlt, SD);
        expect(toDeg(apparentBodyAlt)).toBeCloseTo(expectedApparentDeg as number, 2);
    });

    test('true alt −34′ puts the line exactly through the body center (half covered)', () => {
        const { apparentBodyAlt } = horizonOverlayState(-kECRefractionAtHorizonX, SD);
        expect(apparentBodyAlt).toBeCloseTo(0, 12);
    });

    test('the lift is unconditional (high altitudes shift too, harmlessly off-disc)', () => {
        const high = 45 * Math.PI / 180;
        const { apparentBodyAlt } = horizonOverlayState(high, SD);
        expect(toDeg(apparentBodyAlt)).toBeCloseTo(45 + REFRACTION_DEG, 6);
    });
});

describe('horizonOverlayState — "Below horizon" flips at wash closure over the body', () => {
    // Caption predicate: bodyAlt + 34′ + bodyRadius ≤ 0 — the engine's
    // topocentric rise/set altitude. Why it is deliberately NOT gated on the
    // EclipseKind: see the horizonOverlayState docstring and
    // planning/2026-08-28-eclipse-below-horizon-caption.md.
    const SD = SUN_SD;
    const FLIP = -(kECRefractionAtHorizonX + SD);   // ≈ −0.838° true altitude
    const EPS = 1e-6;

    test('the flip altitude is pinned to the engine rise/set convention', () => {
        // The predicate re-derives altitudeAtRiseSet(…, geocentric=false) =
        // −34′ − angularDiameter/2. If that convention ever changes shape (a
        // new refraction model, a parallax/dip term), the caption must move
        // with it: fed the engine's own radius, the flip must sit exactly at
        // the engine's rise/set altitude.
        const t = appleEpoch(new Date('2026-08-28T01:00:00Z'));
        const { julianCenturiesSince2000Epoch: jcse } =
            julianCenturiesSince2000EpochForDateInterval(t, null);
        for (const planet of [ECPlanetNumber.Sun, ECPlanetNumber.Moon]) {
            const altRS = altitudeAtRiseSet(jcse, planet, false, null);
            const dist = distanceOfPlanetInAU(planet, jcse, null);
            const angR = planetSizeAndParallax(planet, dist).angularSize / 2;
            expect(-(kECRefractionAtHorizonX + angR)).toBeCloseTo(altRS, 15);
            expect(horizonOverlayState(altRS - 1e-9, angR).showLabel).toBe(true);
            expect(horizonOverlayState(altRS + 1e-9, angR).showLabel).toBe(false);
        }
    });

    test('at −(34′+SD) the line sits one semidiameter above the body and the caption just flips', () => {
        // The wash has *just* closed over the top limb — apparent body center
        // = −SD — at the same altitude the caption appears: no sliver is
        // visible under a "Below horizon" caption, and none is hidden without one.
        const { apparentBodyAlt, showLabel } = horizonOverlayState(FLIP, SD);
        expect(apparentBodyAlt).toBeCloseTo(-SD, 12);
        expect(showLabel).toBe(true);
        expect(horizonOverlayState(FLIP + EPS, SD).showLabel).toBe(false);
        expect(horizonOverlayState(FLIP - EPS, SD).showLabel).toBe(true);
    });

    test('the wash and the caption are independent: partly covered, no caption', () => {
        // Body half set (apparent center on the line): the green covers half
        // of it with no "Below horizon" — the transition band keeps its life.
        const { apparentBodyAlt, showLabel } = horizonOverlayState(
            -kECRefractionAtHorizonX, SD);
        expect(apparentBodyAlt).toBeCloseTo(0, 12);
        expect(showLabel).toBe(false);
    });

    test('caption ⟺ drawn closure, wherever the composition put the body (plan §12)', () => {
        // The call sites anchor the wash line to the drawn body:
        //   washLineY = apparentBodyAlt·ppar + bodyPixelY
        // so the drawn top limb (bodyPixelY − r) reaches the line exactly when
        // the caption predicate flips — bodyPixelY cancels. Assert the identity
        // in pixel space across composition offsets (the lunar branch draws the
        // Moon up to sinθ·shadowR/2 off the altitude map) and altitudes.
        const ppar = 20 / Math.atan(1737.10 / 355000.0);   // eclipse-view.ts:87-91
        const r = SD * ppar;
        for (const bodyPixelY of [-30, -8.5, 0, 8.5, 30]) {
            for (const dAlt of [-0.05, -0.002, 0, 0.002, 0.05]) {
                const bodyAlt = FLIP + toRad(dAlt);
                const h = horizonOverlayState(bodyAlt, SD);
                const washLineY = h.apparentBodyAlt * ppar + bodyPixelY;
                const drawnClosed = bodyPixelY - r >= washLineY - 1e-9;
                expect(drawnClosed).toBe(h.showLabel);
            }
        }
    });
});

describe('caption regression — the kind gate broke on the needle-pegging override', () => {
    // Two fully-green discs the old kind-gated caption missed (the pegging
    // override — see the horizonOverlayState docstring — had rewritten the
    // NotUp kinds to None… while the disc still drew). Guards against
    // re-anchoring the caption to the kind. Values cross-checked against a
    // probe replay of drawEclipseView (plan doc §1).

    /** Drive the real obs-values once and mirror the drawEclipseView call sites. */
    function captionInputs(iso: string, latDeg: number, lonDeg: number) {
        const { updater } = tickedObsValues(iso, latDeg, lonDeg);
        return {
            kind: Math.round(updater.get('eclKind').currentValue) as EclipseKind,
            separation: updater.get('eclSeparation').currentValue,
            sunAlt: updater.get('eclSunAlt').currentValue,
            moonAlt: updater.get('eclMoonAlt').currentValue,
            sunAngR: sunAngR(updater.get('eclSunDist').currentValue),
            moonAngR: moonAngR(updater.get('eclMoonDist').currentValue),
        };
    }

    test('lunar branch: Moon 19° down, kind pegged to NoneLunar — caption ON', () => {
        const v = captionInputs('2026-08-28T01:00:00Z', 37.2, -121.9);
        expect(v.kind).toBe(EclipseKind.NoneLunar);            // pegged, NOT LunarNotUp
        expect(v.separation).toBeLessThan(THRESHOLD);          // the disc is drawn
        expect(v.moonAlt).toBeLessThan(toRad(-15));
        expect(horizonOverlayState(v.moonAlt, v.moonAngR).showLabel).toBe(true);
    });

    test('solar branch: Sun set all night, kind pegged to NoneSolar — caption ON', () => {
        const v = captionInputs('2026-03-19T02:20:00Z', 37.2, -121.9);
        expect(v.kind).toBe(EclipseKind.NoneSolar);            // pegged, NOT SolarNotUp
        expect(v.separation).toBeLessThan(THRESHOLD);
        expect(v.sunAlt).toBeLessThan(toRad(-1));
        expect(horizonOverlayState(v.sunAlt, v.sunAngR).showLabel).toBe(true);
    });
});
