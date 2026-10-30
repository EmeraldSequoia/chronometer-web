/**
 * Moon transit solver stability.
 *
 * `planettransitTimeRefined` solves the Moon at low precision first and then
 * re-solves at full precision. Until 2026-10-29 the full-precision pass inherited
 * the low-precision fit points, the quadratic fit degenerated on two abscissae
 * that differed by sub-microseconds, and when the 7 iterations ran out the solver
 * returned whichever bogus root the rounding favoured: a 1 ms change in the start
 * date moved the answer by 25.7 s (2026-01-01, lat −5°, lon 36.8°), visible as
 * jitter of tens of seconds on Miami's 24-hour Moon transit indicator.
 * See planning/2026-10-29-moon-transit-degenerate-fit.md.
 */

import { describe, test, expect } from 'vitest';
import { planettransitTimeRefined, planetaryRiseSetTimeRefined } from '../es-riseset';
import { AstroCachePool, initializeCachePool } from '../astro-cache';
import { ECPlanetNumber } from '../astro-constants';
import { moonAzimuth, moonAltitude } from '../es-astro';
import { dateToDateInterval } from '../es-time';

const toRad = (deg: number): number => deg * Math.PI / 180;
const ARCSEC = Math.PI / (180 * 3600);

/** Angular distance (radians) from `angle` to the nearest of 0 and π, mod 2π. */
function distanceFromMeridian(angle: number): number {
    const a = ((angle % Math.PI) + Math.PI) % Math.PI;  // fold onto [0, π)
    return Math.min(a, Math.PI - a);
}

interface Site { name: string; lat: number; lon: number; iso: string }

/**
 * Starts an hour apart can straddle the midpoint between two successive events, so
 * the solver legitimately answers with either neighbour (a lunar day apart; the
 * for-day callers pick the one they want). Split the sorted times at gaps over an
 * hour and return the width of each cluster: start jitter must not move an event.
 */
function clusterSpreads(times: number[]): number[] {
    const sorted = [...times].sort((a, b) => a - b);
    const spreads: number[] = [];
    let first = sorted[0];
    let last = sorted[0];
    for (const t of sorted.slice(1)) {
        if (t - last > 3600) {
            spreads.push(last - first);
            first = t;
        }
        last = t;
    }
    spreads.push(last - first);
    return spreads;
}

const SITES: Site[] = [
    { name: 'Tanzania 2026-01-01 (the reported case)', lat: -5, lon: 36.8, iso: '2026-01-01T00:00:00Z' },
    { name: 'Miami 2025-06-15', lat: 25.77, lon: -80.19, iso: '2025-06-15T12:00:00Z' },
    { name: 'Miami 2025-12-21', lat: 25.77, lon: -80.19, iso: '2025-12-21T18:00:00Z' },
    { name: 'Vienna 2024-02-29', lat: 48.21, lon: 16.37, iso: '2024-02-29T06:00:00Z' },
    { name: 'Haleakala 2000-01-01', lat: 20.7167, lon: -156.15, iso: '2000-01-01T12:00:00Z' },
];

/** Start offsets (seconds): the millisecond neighbours that used to differ by 25.7 s, and ±1 h. */
const START_OFFSETS = [-3600, -1800, -600, -60, -1, -0.001, 0, 0.001, 1, 60, 600, 1800, 3600];

function solveTransit(site: Site, offset: number, wantHighTransit: boolean): number {
    const start = dateToDateInterval(new Date(site.iso)) + offset;
    const pool = new AstroCachePool();
    initializeCachePool(pool, start, toRad(site.lat), toRad(site.lon));
    return planettransitTimeRefined(
        start, toRad(site.lat), toRad(site.lon), wantHighTransit, ECPlanetNumber.Moon, pool,
    );
}

describe('Moon transit solver', () => {
    for (const site of SITES) {
        for (const wantHighTransit of [true, false]) {
            const kind = wantHighTransit ? 'high' : 'low';

            test(`${kind} transit at ${site.name} agrees to 0.2 s for starts spread over ±1 h`, () => {
                const times = START_OFFSETS.map((offset) => solveTransit(site, offset, wantHighTransit));
                const spreads = clusterSpreads(times);
                expect(spreads.length).toBeLessThanOrEqual(2);
                for (const spread of spreads) {
                    expect(spread).toBeLessThan(0.2);
                }
            });

            // Azimuth is ill-conditioned when the Moon transits through the zenith or
            // nadir (declination ≈ ±latitude, e.g. Miami near a major lunar standstill):
            // a 0.1 s transit error is 1.5″ of hour angle but degrees of azimuth there.
            // None of the SITES/dates above is within a degree of that.
            test(`${kind} transit at ${site.name} puts the Moon on the meridian`, () => {
                for (const offset of [-3600, -0.001, 0, 0.001, 3600]) {
                    const t = solveTransit(site, offset, wantHighTransit);
                    const az = moonAzimuth(t, toRad(site.lat), toRad(site.lon), null);
                    expect(distanceFromMeridian(az)).toBeLessThan(5 * ARCSEC);
                    const alt = moonAltitude(t, toRad(site.lat), toRad(site.lon), null);
                    // High transit is the Moon's highest point of the day, low its lowest:
                    // the altitude's sign tells them apart at these mid-latitude sites.
                    expect(alt > 0).toBe(wantHighTransit);
                }
            });
        }
    }

    test('the reported case: 2026-01-01 00:00 UTC ± 1 ms, lat −5°, lon 36.8°', () => {
        const site = SITES[0];
        const before = solveTransit(site, -0.001, true);
        const at = solveTransit(site, 0, true);
        const after = solveTransit(site, 0.001, true);
        expect(Math.abs(before - at)).toBeLessThan(0.01);
        expect(Math.abs(after - at)).toBeLessThan(0.01);
    });
});

describe('Moon rise/set solver', () => {
    for (const site of SITES) {
        for (const riseNotSet of [true, false]) {
            test(`moon${riseNotSet ? 'rise' : 'set'} at ${site.name} agrees to 0.1 s for starts spread over ±1 h`, () => {
                const times = START_OFFSETS.map((offset) => {
                    const start = dateToDateInterval(new Date(site.iso)) + offset;
                    const pool = new AstroCachePool();
                    initializeCachePool(pool, start, toRad(site.lat), toRad(site.lon));
                    return planetaryRiseSetTimeRefined(
                        start, toRad(site.lat), toRad(site.lon), riseNotSet, ECPlanetNumber.Moon, NaN, pool,
                    ).riseSetTime;
                });
                const spreads = clusterSpreads(times);
                expect(spreads.length).toBeLessThanOrEqual(2);
                for (const spread of spreads) {
                    expect(spread).toBeLessThan(0.1);
                }
            });
        }
    }
});
