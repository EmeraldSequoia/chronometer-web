/**
 * Phase 7B eclipse simulator tests.
 *
 *  (a) calculateEclipse / EclipseKind around known eclipses — validates the
 *      quantities the expr-function wrappers (eclipseAngularSeparation,
 *      eclipseShadowAngularSize, eclipseKindRaw) read.
 *  (b) the EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION resolver: ~1 s while the
 *      disc is shown (separation < 10°), and a capped (≤1 h) interval that never
 *      overshoots the threshold crossing while only the caption is up.
 *  (c) horizonOverlayState: the refraction lift the green below-horizon wash is
 *      drawn at, and the kind-gated "Below horizon" caption
 *      (planning/2026-08-18-eclipse-horizon-indicator.md).
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
import { kECRefractionAtHorizonX } from '../../astronomy/astro-constants';

function appleEpoch(date: Date): number {
    return date.getTime() / 1000 - 978307200;
}
function toRad(deg: number): number {
    return deg * Math.PI / 180;
}

const THRESHOLD = Math.PI / 18;  // 10°

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
        const base = () => new Date(iso);
        const { getNow, withDisplayTime } = makeOverridableGetNow(base);
        const env = createAstroEnvironment(latDeg, lonDeg, getNow);
        // Variables other Observatory defs reference (mirrors observatory-entry).
        env.variables.set('noonOnTop', 0);
        env.variables.set('dialPlanet', 0);
        const perfNow = performance.now();
        const updater = buildObsValues(env, perfNow, getNow);

        // Sanity: the value really is registered on the eclipse sentinel.
        const v = updater.get('eclSeparation');
        expect(v.updateInterval).toBe(EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION);

        // One 1×-forward tick (no scrub) — schedules nextUpdateDisplayTime.
        const ctx: TimingContext = { tickIntervalMs: null, displayDeltaSec: 0, direction: 1 };
        updater.tick(env, perfNow, getNow, withDisplayTime, ctx);

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
    const AU_KM = 149600000.0;              // as eclipse-view.ts:80-82
    const LUNAR_RADIUS_KM = 1737.10;
    const SOLAR_RADIUS_KM = 695500;

    /** Drive the real obs-values once and reproduce eclipse-view's disc radii. */
    function discRadii(iso: string, latDeg: number, lonDeg: number) {
        const base = () => new Date(iso);
        const { getNow, withDisplayTime } = makeOverridableGetNow(base);
        const env = createAstroEnvironment(latDeg, lonDeg, getNow);
        env.variables.set('noonOnTop', 0);
        env.variables.set('dialPlanet', 0);
        const perfNow = performance.now();
        const updater = buildObsValues(env, perfNow, getNow);
        const ctx: TimingContext = { tickIntervalMs: null, displayDeltaSec: 0, direction: 1 };
        updater.tick(env, perfNow, getNow, withDisplayTime, ctx);
        const moonDist = updater.get('eclMoonDist').currentValue;
        const sunDist = updater.get('eclSunDist').currentValue;
        return {
            moonR: Math.atan(LUNAR_RADIUS_KM / (moonDist * AU_KM)),   // eclipse-view.ts:233-234
            sunR: Math.atan(SOLAR_RADIUS_KM / (sunDist * AU_KM)),
            kind: Math.round(updater.get('eclKind').currentValue) as EclipseKind,
        };
    }

    // NASA's greatest-eclipse instant and point for the two hybrids in
    // src/help/eclipse-data.json; both are total there.
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
    const SUN_SD_DEG = 0.271;              // solar semidiameter, ≈ 16.3′

    // The §8 fixture table of planning/2026-08-18-eclipse-horizon-indicator.md.
    // "apparent" is what the wash is drawn at; positive = line below the disc
    // center (part of the scene still up), negative = line above it.
    test.each([
        ['2014-04-29 row: fully visible, small gap below', -0.202, 0.365],
        ['2011-01-04 row: bottom limb ~1′ above the line', -0.274, 0.293],
        ['halfway: line through the disc center', -0.567, 0.000],
        ['caption flip: wash just closes over the top limb', -0.838, -0.271],
        ['well set: fully green', -1.500, -0.933],
    ])('%s', (_label, trueAltDeg, expectedApparentDeg) => {
        const { apparentAvgAlt } = horizonOverlayState(
            (trueAltDeg as number) * Math.PI / 180, EclipseKind.PartialSolar);
        expect(toDeg(apparentAvgAlt)).toBeCloseTo(expectedApparentDeg as number, 2);
    });

    test('true alt −34′ maps exactly to the disc center (half covered)', () => {
        const { apparentAvgAlt } = horizonOverlayState(
            -kECRefractionAtHorizonX, EclipseKind.PartialSolar);
        expect(apparentAvgAlt).toBeCloseTo(0, 12);
    });

    test('at the kind-flip altitude the line sits exactly one semidiameter above center', () => {
        // calculateEclipse calls the Sun "not up" below −(34′ + SD)
        // (altitudeAtRiseSet). The wash must have *just* closed over the top
        // limb there — i.e. apparent center = −SD — so no sliver is visible
        // under a "Below horizon" caption, and none is hidden without one.
        const sd = SUN_SD_DEG * Math.PI / 180;
        const { apparentAvgAlt } = horizonOverlayState(
            -(kECRefractionAtHorizonX + sd), EclipseKind.SolarNotUp);
        expect(apparentAvgAlt).toBeCloseTo(-sd, 12);
    });

    test('the lift is unconditional (high altitudes shift too, harmlessly off-disc)', () => {
        const high = 45 * Math.PI / 180;
        const { apparentAvgAlt } = horizonOverlayState(high, EclipseKind.NoneSolar);
        expect(toDeg(apparentAvgAlt)).toBeCloseTo(45 + REFRACTION_DEG, 6);
    });

    test('lunar branch: same lift (the shadow/Moon midpoint is fed the same way)', () => {
        // e.g. Moon at +0.30°, anti-solar shadow point at −0.90° → midpoint −0.30°.
        const mid = ((0.30 + -0.90) / 2) * Math.PI / 180;
        const { apparentAvgAlt } = horizonOverlayState(mid, EclipseKind.PartialLunar);
        expect(toDeg(apparentAvgAlt)).toBeCloseTo(-0.30 + REFRACTION_DEG, 6);
    });
});

describe('horizonOverlayState — "Below horizon" tracks the eclipse kind', () => {
    // The caption is gated on the same calculateEclipse classification Basel's
    // wheel renders (legacyEclipseKind), not on the wash's pixel position — so
    // the two apps flip on the same tick of the same function.
    test.each([
        [EclipseKind.SolarNotUp, true],
        [EclipseKind.LunarNotUp, true],
        [EclipseKind.NoneSolar, false],
        [EclipseKind.NoneLunar, false],
        [EclipseKind.PartialSolar, false],
        [EclipseKind.AnnularSolar, false],
        [EclipseKind.TotalSolar, false],
        [EclipseKind.PartialLunar, false],
        [EclipseKind.TotalLunar, false],
    ])('kind %s → showLabel %s', (kind, expected) => {
        expect(horizonOverlayState(0, kind as EclipseKind).showLabel).toBe(expected);
    });

    test('the wash and the caption are independent: partly covered, no caption', () => {
        // Sun half set (apparent center on the line) is still a Partial to the
        // engine — the green covers half the disc with no "Below horizon".
        const { apparentAvgAlt, showLabel } = horizonOverlayState(
            -kECRefractionAtHorizonX, EclipseKind.PartialSolar);
        expect(apparentAvgAlt).toBeCloseTo(0, 12);
        expect(showLabel).toBe(false);
    });

    test('a below-horizon kind captions regardless of the midpoint altitude', () => {
        // The Sun can be below its rise/set altitude while the Sun+Moon midpoint
        // still computes above it (the Moon is the higher of the pair). The
        // caption follows the kind; the wash follows the geometry.
        expect(horizonOverlayState(0.5 * Math.PI / 180, EclipseKind.SolarNotUp).showLabel).toBe(true);
    });
});
