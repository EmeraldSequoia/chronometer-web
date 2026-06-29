/**
 * Phase 4: Astro Boundary Unit Tests
 *
 * Independent unit tests for the astronomical functions that feed into
 * the hand scheduling system: rise/set computation, moon phase quarters,
 * transit times, and the astro-stepper dispatcher.
 *
 * These validate correctness against known astronomical events rather than
 * relying on golden-file regression.
 */

import { describe, test, expect } from 'vitest';
import { dateToDateInterval, dateIntervalToDate } from '../astronomy/es-time.js';
import {
    planetaryRiseSetTimeRefined,
    planettransitTimeRefined,
    sunriseForDay,
    sunsetForDay,
    suntransitForDay,
} from '../astronomy/es-riseset.js';
import { moonAge, refineMoonAgeTargetForDate, closestQuarterPhaseTime } from '../astronomy/es-astro.js';
import { ECPlanetNumber, isNoRiseSet } from '../astronomy/astro-constants.js';
import { AstroCachePool, initializeCachePool, releaseCachePool } from '../astronomy/astro-cache.js';
import {
    findNextRiseSet,
    findNextQuarterPhase,
    findNextTransit,
    computeAstroTarget,
} from '../shared/astro-stepper.js';

// ============================================================================
// Helpers
// ============================================================================

const toRad = (deg: number) => deg * Math.PI / 180;
const toDeg = (rad: number) => rad * 180 / Math.PI;
const appleEpoch = (d: Date) => d.getTime() / 1000 - 978307200;

function makePool(di: number, lat: number, lon: number): AstroCachePool {
    const pool = new AstroCachePool();
    initializeCachePool(pool, di, lat, lon);
    return pool;
}

/** Convert dateInterval to a UTC ISO string for readable test output. */
function diToISO(di: number): string {
    return dateIntervalToDate(di).toISOString();
}

/** Extract hour (decimal, UTC) from a dateInterval. */
function diToUTCHour(di: number): number {
    const d = dateIntervalToDate(di);
    return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}

// ============================================================================
// Test locations (same 3 as regression suite)
// ============================================================================

const CUPERTINO = { lat: toRad(37.3230), lon: toRad(-122.0322), tz: 'America/Los_Angeles' };
const ARCTIC    = { lat: toRad(85.0),    lon: toRad(21.0),      tz: 'Europe/Oslo' };
const EQUATOR   = { lat: toRad(-5.0),    lon: toRad(36.8),      tz: 'Africa/Dar_es_Salaam' };

// London for simpler UTC verification
const LONDON = { lat: toRad(51.5), lon: toRad(-0.1) };

// ============================================================================
// 1. planetaryRiseSetTimeRefined — direct low-level tests
// ============================================================================

describe('planetaryRiseSetTimeRefined', () => {
    test('sunrise at London on 2024-06-15 is around 04:43 UTC', () => {
        const noon = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const pool = makePool(noon, LONDON.lat, LONDON.lon);
        const result = planetaryRiseSetTimeRefined(
            noon, LONDON.lat, LONDON.lon, true, ECPlanetNumber.Sun, NaN, pool,
        );
        expect(isNoRiseSet(result.riseSetTime)).toBe(false);
        const hour = diToUTCHour(result.riseSetTime);
        // London sunrise mid-June: ~03:40-04:50 UTC
        expect(hour).toBeGreaterThan(3.5);
        expect(hour).toBeLessThan(5.0);
        releaseCachePool(pool);
    });

    test('sunset at London on 2024-06-15 is around 21:20 UTC', () => {
        const noon = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const pool = makePool(noon, LONDON.lat, LONDON.lon);
        const result = planetaryRiseSetTimeRefined(
            noon, LONDON.lat, LONDON.lon, false, ECPlanetNumber.Sun, NaN, pool,
        );
        expect(isNoRiseSet(result.riseSetTime)).toBe(false);
        const hour = diToUTCHour(result.riseSetTime);
        // London sunset mid-June: ~20:20 UTC (21:20 BST)
        expect(hour).toBeGreaterThan(20.0);
        expect(hour).toBeLessThan(21.5);
        releaseCachePool(pool);
    });

    test('sunrise at Cupertino on 2024-12-21 is around 15:22 UTC (07:22 PST)', () => {
        const noon = appleEpoch(new Date('2024-12-21T20:00:00Z'));
        const pool = makePool(noon, CUPERTINO.lat, CUPERTINO.lon);
        const result = planetaryRiseSetTimeRefined(
            noon, CUPERTINO.lat, CUPERTINO.lon, true, ECPlanetNumber.Sun, NaN, pool,
        );
        expect(isNoRiseSet(result.riseSetTime)).toBe(false);
        const hour = diToUTCHour(result.riseSetTime);
        // Winter solstice sunrise Cupertino: ~07:22 PST = 15:22 UTC
        expect(hour).toBeGreaterThan(15.0);
        expect(hour).toBeLessThan(15.7);
        releaseCachePool(pool);
    });

    test('Arctic 85°N in June: sun never sets (always above)', () => {
        const noon = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const pool = makePool(noon, ARCTIC.lat, ARCTIC.lon);
        const result = planetaryRiseSetTimeRefined(
            noon, ARCTIC.lat, ARCTIC.lon, false, ECPlanetNumber.Sun, NaN, pool,
        );
        // At 85°N in June, sun is always above horizon
        expect(isNoRiseSet(result.riseSetTime)).toBe(true);
        releaseCachePool(pool);
    });

    test('Arctic 85°N in December: sun never rises (always below)', () => {
        const noon = appleEpoch(new Date('2024-12-21T12:00:00Z'));
        const pool = makePool(noon, ARCTIC.lat, ARCTIC.lon);
        const result = planetaryRiseSetTimeRefined(
            noon, ARCTIC.lat, ARCTIC.lon, true, ECPlanetNumber.Sun, NaN, pool,
        );
        // At 85°N in December, sun is always below horizon
        expect(isNoRiseSet(result.riseSetTime)).toBe(true);
        releaseCachePool(pool);
    });

    test('equator sunrise/sunset are roughly 12h apart year-round', () => {
        const dates = [
            new Date('2024-03-20T12:00:00Z'), // equinox
            new Date('2024-06-21T12:00:00Z'), // solstice
            new Date('2024-12-21T12:00:00Z'), // solstice
        ];
        for (const d of dates) {
            const di = appleEpoch(d);
            const pool = makePool(di, EQUATOR.lat, EQUATOR.lon);
            const rise = planetaryRiseSetTimeRefined(
                di, EQUATOR.lat, EQUATOR.lon, true, ECPlanetNumber.Sun, NaN, pool,
            );
            const set = planetaryRiseSetTimeRefined(
                di, EQUATOR.lat, EQUATOR.lon, false, ECPlanetNumber.Sun, NaN, pool,
            );
            expect(isNoRiseSet(rise.riseSetTime)).toBe(false);
            expect(isNoRiseSet(set.riseSetTime)).toBe(false);
            const dayHours = Math.abs(set.riseSetTime - rise.riseSetTime) / 3600;
            // Near equator, day length is ~12h ± 0.5h
            expect(dayHours).toBeGreaterThan(11.5);
            expect(dayHours).toBeLessThan(12.5);
            releaseCachePool(pool);
        }
    });

    test('moonrise at Cupertino returns a plausible time', () => {
        const di = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const pool = makePool(di, CUPERTINO.lat, CUPERTINO.lon);
        const result = planetaryRiseSetTimeRefined(
            di, CUPERTINO.lat, CUPERTINO.lon, true, ECPlanetNumber.Moon, NaN, pool,
        );
        if (!isNoRiseSet(result.riseSetTime)) {
            // Moonrise should be within ±1 day of the search date
            const delta = Math.abs(result.riseSetTime - di);
            expect(delta).toBeLessThan(86400);
        }
        releaseCachePool(pool);
    });
});

// ============================================================================
// 2. planettransitTimeRefined — solar/lunar transit
// ============================================================================

describe('planettransitTimeRefined', () => {
    test('solar transit at London is near 12:00 UTC (±15 min EOT)', () => {
        const di = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const pool = makePool(di, LONDON.lat, LONDON.lon);
        const transit = planettransitTimeRefined(
            di, LONDON.lat, LONDON.lon, true, ECPlanetNumber.Sun, pool,
        );
        const hour = diToUTCHour(transit);
        // Solar noon at London ~12:00 UTC ± EOT (~15 min max)
        expect(hour).toBeGreaterThan(11.5);
        expect(hour).toBeLessThan(12.5);
        releaseCachePool(pool);
    });

    test('suntransitForDay matches planettransitTimeRefined', () => {
        const di = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const pool = makePool(di, LONDON.lat, LONDON.lon);
        const forDay = suntransitForDay(di, LONDON.lat, LONDON.lon, pool);
        releaseCachePool(pool);

        const pool2 = makePool(di, LONDON.lat, LONDON.lon);
        const refined = planettransitTimeRefined(
            di, LONDON.lat, LONDON.lon, true, ECPlanetNumber.Sun, pool2,
        );
        releaseCachePool(pool2);
        // Should be very close (same algorithm, different entry point)
        expect(Math.abs(forDay - refined)).toBeLessThan(60);
    });

    test('solar transit at Cupertino is ~12:10 PST = ~20:10 UTC', () => {
        const di = appleEpoch(new Date('2024-06-15T20:00:00Z'));
        const pool = makePool(di, CUPERTINO.lat, CUPERTINO.lon);
        const transit = planettransitTimeRefined(
            di, CUPERTINO.lat, CUPERTINO.lon, true, ECPlanetNumber.Sun, pool,
        );
        const hour = diToUTCHour(transit);
        // Solar noon at Cupertino (lon -122°) ≈ 12:08 local ≈ 20:08 UTC
        expect(hour).toBeGreaterThan(19.8);
        expect(hour).toBeLessThan(20.5);
        releaseCachePool(pool);
    });
});

// ============================================================================
// 3. findNextRiseSet — astro-stepper wrapper
// ============================================================================

describe('findNextRiseSet (astro-stepper)', () => {
    test('forward sunrise from midnight returns same-day sunrise', () => {
        const midnight = new Date('2024-06-15T00:00:00Z');
        const result = findNextRiseSet(
            true, ECPlanetNumber.Sun, midnight, 1, LONDON.lat, LONDON.lon,
        );
        expect(result).not.toBeNull();
        // Should be the same day (June 15)
        expect(result!.getUTCDate()).toBe(15);
        expect(result!.getUTCMonth()).toBe(5); // June = 5
    });

    test('backward sunrise from noon returns same-day sunrise', () => {
        const noon = new Date('2024-06-15T12:00:00Z');
        const result = findNextRiseSet(
            true, ECPlanetNumber.Sun, noon, -1, LONDON.lat, LONDON.lon,
        );
        expect(result).not.toBeNull();
        // Should be same day (we're after sunrise, so backward finds it)
        expect(result!.getUTCDate()).toBe(15);
    });

    test('forward sunset from noon returns same-day sunset', () => {
        const noon = new Date('2024-06-15T12:00:00Z');
        const result = findNextRiseSet(
            false, ECPlanetNumber.Sun, noon, 1, LONDON.lat, LONDON.lon,
        );
        expect(result).not.toBeNull();
        expect(result!.getUTCDate()).toBe(15);
        const hour = result!.getUTCHours() + result!.getUTCMinutes() / 60;
        expect(hour).toBeGreaterThan(20);
    });

    test('Arctic summer: sunrise returns null (always above)', () => {
        const d = new Date('2024-06-15T12:00:00Z');
        const result = findNextRiseSet(
            true, ECPlanetNumber.Sun, d, 1, ARCTIC.lat, ARCTIC.lon,
        );
        expect(result).toBeNull();
    });

    test('Arctic winter: sunset returns null (always below)', () => {
        const d = new Date('2024-12-21T12:00:00Z');
        const result = findNextRiseSet(
            false, ECPlanetNumber.Sun, d, 1, ARCTIC.lat, ARCTIC.lon,
        );
        expect(result).toBeNull();
    });

    test('moonrise forward from Cupertino returns result within 2 days', () => {
        const d = new Date('2024-06-15T12:00:00Z');
        const result = findNextRiseSet(
            true, ECPlanetNumber.Moon, d, 1, CUPERTINO.lat, CUPERTINO.lon,
        );
        if (result) {
            const deltaH = (result.getTime() - d.getTime()) / 3600000;
            expect(deltaH).toBeGreaterThan(0);
            expect(deltaH).toBeLessThan(48);
        }
    });
});

// ============================================================================
// 4. findNextTransit — astro-stepper transit wrapper
// ============================================================================

describe('findNextTransit (astro-stepper)', () => {
    test('forward sun transit from midnight is same-day solar noon', () => {
        const midnight = new Date('2024-06-15T00:00:00Z');
        const result = findNextTransit(
            ECPlanetNumber.Sun, midnight, 1, LONDON.lat, LONDON.lon,
        );
        expect(result).not.toBeNull();
        expect(result!.getUTCDate()).toBe(15);
        const h = result!.getUTCHours() + result!.getUTCMinutes() / 60;
        expect(h).toBeGreaterThan(11.5);
        expect(h).toBeLessThan(12.5);
    });

    test('backward sun transit from midnight is previous-day solar noon', () => {
        const midnight = new Date('2024-06-15T00:00:00Z');
        const result = findNextTransit(
            ECPlanetNumber.Sun, midnight, -1, LONDON.lat, LONDON.lon,
        );
        expect(result).not.toBeNull();
        expect(result!.getUTCDate()).toBe(14);
    });

    test('forward moon transit returns plausible result', () => {
        const d = new Date('2024-06-15T12:00:00Z');
        const result = findNextTransit(
            ECPlanetNumber.Moon, d, 1, CUPERTINO.lat, CUPERTINO.lon,
        );
        expect(result).not.toBeNull();
        const deltaH = (result!.getTime() - d.getTime()) / 3600000;
        expect(deltaH).toBeGreaterThan(0);
        // Moon transit interval ~24h50m, so should be within ~26h
        expect(deltaH).toBeLessThan(26);
    });
});

// ============================================================================
// 5. findNextQuarterPhase — moon phase stepping
// ============================================================================

describe('findNextQuarterPhase', () => {
    // Known 2024 moon phases (approximate UTC times):
    // New Moon:       2024-06-06 12:38
    // First Quarter:  2024-06-14 05:18
    // Full Moon:      2024-06-22 01:08
    // Third Quarter:  2024-06-28 21:53

    test('forward from June 1 finds new moon ~June 6', () => {
        const d = new Date('2024-06-01T00:00:00Z');
        const result = findNextQuarterPhase(d, 1);
        expect(result.getUTCDate()).toBeGreaterThanOrEqual(5);
        expect(result.getUTCDate()).toBeLessThanOrEqual(7);
        expect(result.getUTCMonth()).toBe(5); // June
    });

    test('forward from June 7 finds first quarter ~June 14', () => {
        const d = new Date('2024-06-07T00:00:00Z');
        const result = findNextQuarterPhase(d, 1);
        expect(result.getUTCDate()).toBeGreaterThanOrEqual(13);
        expect(result.getUTCDate()).toBeLessThanOrEqual(15);
    });

    test('forward from June 15 finds full moon ~June 22', () => {
        const d = new Date('2024-06-15T00:00:00Z');
        const result = findNextQuarterPhase(d, 1);
        expect(result.getUTCDate()).toBeGreaterThanOrEqual(21);
        expect(result.getUTCDate()).toBeLessThanOrEqual(23);
    });

    test('backward from June 25 finds full moon ~June 22', () => {
        const d = new Date('2024-06-25T00:00:00Z');
        const result = findNextQuarterPhase(d, -1);
        expect(result.getUTCDate()).toBeGreaterThanOrEqual(21);
        expect(result.getUTCDate()).toBeLessThanOrEqual(23);
    });

    test('backward from June 7 finds new moon ~June 6', () => {
        const d = new Date('2024-06-07T12:00:00Z');
        const result = findNextQuarterPhase(d, -1);
        expect(result.getUTCDate()).toBeGreaterThanOrEqual(5);
        expect(result.getUTCDate()).toBeLessThanOrEqual(7);
    });

    test('phase at found quarter is near a multiple of π/2', () => {
        const d = new Date('2024-06-10T00:00:00Z');
        const result = findNextQuarterPhase(d, 1);
        const di = appleEpoch(result);
        const { age } = moonAge(di, null);
        // Should be within ~2° of an exact quarter
        const quarterRemainder = age % (Math.PI / 2);
        const dist = Math.min(quarterRemainder, Math.PI / 2 - quarterRemainder);
        expect(toDeg(dist)).toBeLessThan(2);
    });
});

// ============================================================================
// 6. refineMoonAgeTargetForDate — iterative convergence
// ============================================================================

describe('refineMoonAgeTargetForDate', () => {
    test('refining to age=0 near new moon converges', () => {
        // Start near new moon 2024-06-06
        const guess = appleEpoch(new Date('2024-06-05T00:00:00Z'));
        const refined = refineMoonAgeTargetForDate(guess, 0);
        const { age } = moonAge(refined, null);
        // Age should be very close to 0 (or 2π)
        const dist = Math.min(age, 2 * Math.PI - age);
        expect(dist).toBeLessThan(0.01); // < ~0.6°
    });

    test('refining to age=π near full moon converges', () => {
        const guess = appleEpoch(new Date('2024-06-20T00:00:00Z'));
        const refined = refineMoonAgeTargetForDate(guess, Math.PI);
        const { age } = moonAge(refined, null);
        expect(Math.abs(age - Math.PI)).toBeLessThan(0.01);
    });

    test('refining to age=π/2 (first quarter) converges', () => {
        const guess = appleEpoch(new Date('2024-06-12T00:00:00Z'));
        const refined = refineMoonAgeTargetForDate(guess, Math.PI / 2);
        const { age } = moonAge(refined, null);
        expect(Math.abs(age - Math.PI / 2)).toBeLessThan(0.01);
    });
});

// ============================================================================
// 7. closestQuarterPhaseTime — closest quarter finder
// ============================================================================

describe('closestQuarterPhaseTime', () => {
    test('closest new moon from June 5 is June 6', () => {
        const di = appleEpoch(new Date('2024-06-05T00:00:00Z'));
        const result = closestQuarterPhaseTime(0, di);
        const d = dateIntervalToDate(result);
        expect(d.getUTCDate()).toBeGreaterThanOrEqual(5);
        expect(d.getUTCDate()).toBeLessThanOrEqual(7);
    });

    test('closest full moon from June 20 is June 22', () => {
        const di = appleEpoch(new Date('2024-06-20T00:00:00Z'));
        const result = closestQuarterPhaseTime(Math.PI, di);
        const d = dateIntervalToDate(result);
        expect(d.getUTCDate()).toBeGreaterThanOrEqual(21);
        expect(d.getUTCDate()).toBeLessThanOrEqual(23);
    });
});

// ============================================================================
// 8. computeAstroTarget — dispatcher
// ============================================================================

describe('computeAstroTarget', () => {
    test('sunrise dispatches correctly', () => {
        const d = new Date('2024-06-15T00:00:00Z');
        const result = computeAstroTarget('sunrise', 1, d, LONDON.lat, LONDON.lon);
        expect(result).not.toBeNull();
        const h = result!.getUTCHours() + result!.getUTCMinutes() / 60;
        // findNextRiseSet starts from midnight + 5s fudge, finds same-day sunrise ~3:40-4:50 UTC
        expect(h).toBeGreaterThan(3);
        expect(h).toBeLessThan(5.5);
    });

    test('sunset dispatches correctly', () => {
        const d = new Date('2024-06-15T12:00:00Z');
        const result = computeAstroTarget('sunset', 1, d, LONDON.lat, LONDON.lon);
        expect(result).not.toBeNull();
        const h = result!.getUTCHours() + result!.getUTCMinutes() / 60;
        expect(h).toBeGreaterThan(20);
    });

    test('moonphase dispatches correctly', () => {
        const d = new Date('2024-06-10T00:00:00Z');
        const result = computeAstroTarget('moonphase', 1, d, LONDON.lat, LONDON.lon);
        expect(result).not.toBeNull();
    });

    test('sun-transit dispatches correctly', () => {
        const d = new Date('2024-06-15T00:00:00Z');
        const result = computeAstroTarget('sun-transit', 1, d, LONDON.lat, LONDON.lon);
        expect(result).not.toBeNull();
        const h = result!.getUTCHours() + result!.getUTCMinutes() / 60;
        expect(h).toBeGreaterThan(11.5);
        expect(h).toBeLessThan(12.5);
    });

    test('body-rise for Mars returns plausible result', () => {
        const d = new Date('2024-06-15T12:00:00Z');
        const result = computeAstroTarget(
            'body-rise', 1, d, CUPERTINO.lat, CUPERTINO.lon, ECPlanetNumber.Mars,
        );
        // Mars should rise somewhere; result within 2 days
        if (result) {
            const deltaH = (result.getTime() - d.getTime()) / 3600000;
            expect(deltaH).toBeLessThan(48);
        }
    });

    test('body-rise without bodyPlanetNumber returns null', () => {
        const d = new Date('2024-06-15T12:00:00Z');
        const result = computeAstroTarget('body-rise', 1, d, LONDON.lat, LONDON.lon);
        expect(result).toBeNull();
    });
});

// ============================================================================
// 9. Consistency checks: sunrise < transit < sunset
// ============================================================================

describe('sunrise < transit < sunset ordering', () => {
    // makePool leaves tzOffsetSeconds = 0, so the "local day" these for-day searches use
    // is the UTC day; pick dates/locations where sunrise/transit/sunset all fall on the
    // same UTC day. (The local-day behavior with a real offset is covered below.)
    const cases = [
        { name: 'London summer',    date: '2024-06-15T12:00:00Z', ...LONDON },
        { name: 'Equator equinox',  date: '2024-03-20T12:00:00Z', ...EQUATOR },
    ];

    for (const c of cases) {
        test(c.name, () => {
            const di = appleEpoch(new Date(c.date));
            const pool = makePool(di, c.lat, c.lon);
            const rise = sunriseForDay(di, c.lat, c.lon, pool);
            const transit = suntransitForDay(di, c.lat, c.lon, pool);
            const set = sunsetForDay(di, c.lat, c.lon, pool);
            releaseCachePool(pool);

            expect(isNoRiseSet(rise)).toBe(false);
            expect(isNoRiseSet(set)).toBe(false);
            expect(rise).toBeLessThan(transit);
            expect(transit).toBeLessThan(set);
        });
    }
});

// ============================================================================
// 9b. Rise/set use the LOCAL calendar day, not the UTC day
// ============================================================================

describe('for-day searches resolve the local calendar day', () => {
    // Regression lock for the local-day fix (replacing the old UT-noon search). When the
    // local clock reads evening at a western longitude, the UTC instant is already the
    // *next* UTC day. The old UT-noon code returned that next day's event; the corrected
    // riseSetForLocalDay must return the event on the user's CURRENT local day.
    const tzOffset = -7 * 3600; // PDT (America/Los_Angeles in June)
    const localCivilDay = (di: number): number =>
        new Date((di + 978307200 + tzOffset) * 1000).getUTCDate();

    test('evening-local west: sunrise/sunset fall on today\'s local day, not the UTC day', () => {
        // 2024-06-15 22:00 PDT == 2024-06-16 05:00 UTC → local day 15, UTC day 16.
        const di = appleEpoch(new Date('2024-06-16T05:00:00Z'));
        const pool = new AstroCachePool();
        initializeCachePool(pool, di, CUPERTINO.lat, CUPERTINO.lon, false, tzOffset);
        const sunrise = sunriseForDay(di, CUPERTINO.lat, CUPERTINO.lon, pool);
        const sunset = sunsetForDay(di, CUPERTINO.lat, CUPERTINO.lon, pool);
        const transit = suntransitForDay(di, CUPERTINO.lat, CUPERTINO.lon, pool);
        releaseCachePool(pool);

        expect(isNoRiseSet(sunrise)).toBe(false);
        expect(isNoRiseSet(sunset)).toBe(false);
        // All three events are on the 15th (local) — the old UT-noon search returned the 16th.
        expect(localCivilDay(sunrise)).toBe(15);
        expect(localCivilDay(transit)).toBe(15);
        expect(localCivilDay(sunset)).toBe(15);
        expect(sunrise).toBeLessThan(transit);
        expect(transit).toBeLessThan(sunset);
    });
});

// ============================================================================
// 10. Direction symmetry: forward then backward returns near start
// ============================================================================

describe('forward/backward symmetry', () => {
    test('sunrise fwd then bwd returns near original', () => {
        const d = new Date('2024-06-15T12:00:00Z');
        const fwd = findNextRiseSet(true, ECPlanetNumber.Sun, d, 1, LONDON.lat, LONDON.lon);
        expect(fwd).not.toBeNull();
        // fwd finds next sunrise (June 16). Backward from that finds the SAME sunrise
        // (within the fudge window), or the prior day's.
        const bwd = findNextRiseSet(true, ECPlanetNumber.Sun, fwd!, -1, LONDON.lat, LONDON.lon);
        expect(bwd).not.toBeNull();
        // Backward result should be before or at the forward result
        expect(bwd!.getTime()).toBeLessThanOrEqual(fwd!.getTime());
        // And within ~24h+margin
        expect(fwd!.getTime() - bwd!.getTime()).toBeLessThan(25 * 3600 * 1000);
    });

    test('moon phase fwd then bwd returns near original', () => {
        const d = new Date('2024-06-10T00:00:00Z');
        const fwd = findNextQuarterPhase(d, 1);
        const bwd = findNextQuarterPhase(fwd, -1);
        // Backward from the next quarter should find the previous quarter,
        // which is before our start date
        expect(bwd.getTime()).toBeLessThan(fwd.getTime());
    });
});
