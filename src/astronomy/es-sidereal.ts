/**
 * Sidereal time conversions.
 *
 * Ported from ESAstronomy.cpp: GST/LST conversions using the P03 precession model.
 *
 * All angles are in radians unless otherwise noted.
 * All time intervals are seconds since Apple epoch (Jan 1, 2001 00:00:00 UTC).
 */

import { fmod, kECUTUnitsPerGSTUnit } from './astro-constants';
import { AstroCache, AstroCachePool, pushECAstroCacheInPool, popECAstroCacheToInPool } from './astro-cache';
import {
    julianCenturiesSince2000EpochForDateInterval,
    priorUTMidnightForDateInterval,
    ut1MinusUTCForUT,
} from './es-time';

const TWO_PI = Math.PI * 2;

// ============================================================================
// GST ↔ LST conversions
// ============================================================================

/**
 * Convert LST (Local Sidereal Time) to GST (Greenwich Sidereal Time).
 * Returns { gst, dayOffset } where dayOffset is -1, 0, or 1.
 */
export function convertLSTtoGST(
    lst: number,
    observerLongitude: number,
): { gst: number; dayOffset: number } {
    let gst = lst - observerLongitude;
    let dayOffset = 0;
    if (gst < 0) {
        gst += TWO_PI;
        dayOffset = -1;
    } else if (gst > TWO_PI) {
        gst -= TWO_PI;
        dayOffset = 1;
    }
    return { gst, dayOffset };
}

/**
 * Convert GST (Greenwich Sidereal Time) to LST (Local Sidereal Time).
 */
export function convertGSTtoLST(
    gst: number,
    observerLongitude: number,
): number {
    let lst = gst + observerLongitude;
    if (lst < 0) {
        lst += TWO_PI;
    } else if (lst > TWO_PI) {
        lst -= TWO_PI;
    }
    return lst;
}

// ============================================================================
// UT ↔ GST conversions  (P03 precession model)
// ============================================================================

/**
 * Convert UT to GST using the P03 precession model.
 * Internal function that takes pre-computed parameters.
 *
 * @param centuriesSinceEpochTDT - TDT Julian centuries since J2000.0
 * @param deltaTSeconds - Delta T in seconds
 * @param utSinceMidnightRadians - UT since midnight, in radians (1h = π/12)
 * @param _priorUTMidnight - unused but kept for API compatibility
 */
function convertUTToGSTP03x(
    centuriesSinceEpochTDT: number,
    deltaTSeconds: number,
    utSinceMidnightRadians: number,
    _priorUTMidnight: number,
): number {
    const t = centuriesSinceEpochTDT;
    const tu = t - deltaTSeconds / (24 * 3600 * 36525);
    const t2 = t * t;
    const t3 = t2 * t;
    const t4 = t2 * t2;
    const t5 = t3 * t2;

    // GMST in seconds of time
    let gmst = 24110.5493771
        + 8640184.79447825 * tu
        + 307.4771013 * (t - tu)
        + 0.092772110 * t2
        - 0.0000002926 * t3
        - 0.00000199708 * t4
        - 0.000000002454 * t5;

    // Convert from seconds to radians
    gmst *= Math.PI / (12.0 * 3600);

    // Add UT since midnight
    gmst += utSinceMidnightRadians;

    // Normalize to [0, 2π)
    gmst = fmod(gmst, TWO_PI);
    if (gmst < 0) {
        gmst += TWO_PI;
    }

    return gmst;
}

/**
 * Convert a UT(C) date interval to Greenwich Sidereal Time (radians) using the
 * P03 model.
 *
 * Sidereal time is a function of UT1, not UTC: both inputs to the formula —
 * `tu` (via ΔT = TT − UT1) and the time since midnight — are UT1. The date
 * interval is UTC, so UT1 − UTC is added to the since-midnight term (the
 * prior *UTC* midnight is a fine origin: the formula is used mod 2π). Under
 * continuous UTC this term grows without bound; 1 s of it is 15″ of hour
 * angle. See planning/2026-10-28-continuous-utc-ut1.md §3c.
 */
export function convertUTToGSTP03(
    calculationDate: number,
    cache: AstroCache | null,
): number {
    const { julianCenturiesSince2000Epoch, deltaT, ut1MinusUTC } =
        julianCenturiesSince2000EpochForDateInterval(calculationDate, cache);
    const priorUTMidnightD = priorUTMidnightForDateInterval(calculationDate, cache);
    const ut1RadiansSinceMidnight = (calculationDate + ut1MinusUTC - priorUTMidnightD) * Math.PI / (12 * 3600);
    return convertUTToGSTP03x(julianCenturiesSince2000Epoch, deltaT, ut1RadiansSinceMidnight, priorUTMidnightD);
}

/**
 * Solve GST for the time since the given UTC midnight, in the formula's own
 * units: radians of UT, where UTC since midnight = ut − (UT1 − UTC)·R⁻¹
 * (R = sidereal rate, R⁻¹ = kECUTUnitsPerGSTUnit). The UT1 − UTC term enters
 * once at rate 1 because T0's tu already sits at the midnight's UT1 — see
 * convertUTToGSTP03 — so gst − T0 = k·(utcSinceMidnight·R + (UT1 − UTC)).
 * Returns a potential second value too (−1 if there is only one). The
 * caller that knows the instant finishes the job: convertGSTtoUTclosest.
 * The 0/2π seam is the caller's to resolve as well — an answer at midnight
 * can come back as either end.
 */
export function convertGSTtoUT(
    gst: number,
    priorUTMidnight: number,
    cachePool: AstroCachePool | null,
): { ut: number; ut2: number } {
    let priorCache: AstroCache | null = null;
    if (cachePool) {
        priorCache = pushECAstroCacheInPool(cachePool, cachePool.midnightCache, priorUTMidnight);
    }

    const { julianCenturiesSince2000Epoch, deltaT } =
        julianCenturiesSince2000EpochForDateInterval(
            priorUTMidnight,
            cachePool ? cachePool.currentCache : null,
        );

    // GST at the UTC midnight with the since-midnight term at zero.
    const T0 = convertUTToGSTP03x(julianCenturiesSince2000Epoch, deltaT, 0, priorUTMidnight);

    if (cachePool && priorCache !== undefined) {
        popECAstroCacheToInPool(cachePool, priorCache);
    }

    let ut = gst - T0;
    if (ut < 0) {
        ut += TWO_PI;
    } else if (ut > TWO_PI) {
        ut -= TWO_PI;
    }
    ut *= kECUTUnitsPerGSTUnit;

    let ut2 = ut + kECUTUnitsPerGSTUnit * TWO_PI;
    if (ut2 > TWO_PI) {
        ut2 = -1; // only one UT for this GST
    }

    return { ut, ut2 };
}

/**
 * Convert GST to UT, finding the UT(C) instant closest to a given target date.
 *
 * convertGSTtoUT's reading, as seconds past the target's UTC midnight, is
 * UTC + (UT1 − UTC)·R⁻¹; UTC is that minus the term, with UT1 − UTC taken at
 * the reading (it moves at most ~3 ms a day and the reading is within an
 * hour of the instant even at the 3600 s cap, so this is exact to
 * microseconds). GST repeats every sidereal day, so the candidates are a
 * sidereal day apart: pick the one nearest the target. Choosing by
 * closeness, rather than by which side of ±12 h the first answer fell, is
 * what keeps an answer at midnight itself — which the solve can return as
 * either end of the 0/2π seam — from landing a sidereal day off.
 */
export function convertGSTtoUTclosest(
    gst: number,
    closestToThisDate: number,
    cachePool: AstroCachePool | null,
): number {
    const cache = cachePool ? cachePool.currentCache : null;
    const toSeconds = (12 * 3600) / Math.PI;
    const siderealDay = 24 * 3600 * kECUTUnitsPerGSTUnit;

    const midnight = priorUTMidnightForDateInterval(closestToThisDate, cache);
    const { ut } = convertGSTtoUT(gst, midnight, cachePool);
    const reading = midnight + ut * toSeconds;
    const toUTC = (r: number) => r - ut1MinusUTCForUT(r) * kECUTUnitsPerGSTUnit;

    let best = toUTC(reading);
    for (const shift of [-siderealDay, siderealDay]) {
        const candidate = toUTC(reading + shift);
        if (Math.abs(candidate - closestToThisDate) < Math.abs(best - closestToThisDate)) {
            best = candidate;
        }
    }
    return best;
}

/**
 * Compute the difference between GST and UT for a given date.
 * Returns the sidereal-UT offset in radians: what a face adds to the clock's
 * (UTC) time since midnight to get sidereal time, so UT1 − UTC is inside it.
 */
export function GSTDifferenceForDate(
    dateInterval: number,
    cache: AstroCache | null,
): number {
    const { julianCenturiesSince2000Epoch, deltaT, ut1MinusUTC } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);
    const priorUTMidnightD = priorUTMidnightForDateInterval(dateInterval, cache);
    const utcRadiansSinceMidnight = (dateInterval - priorUTMidnightD) * Math.PI / (12 * 3600);
    const ut1RadiansSinceMidnight = utcRadiansSinceMidnight + ut1MinusUTC * Math.PI / (12 * 3600);
    const gst = convertUTToGSTP03x(julianCenturiesSince2000Epoch, deltaT, ut1RadiansSinceMidnight, priorUTMidnightD);
    return gst - utcRadiansSinceMidnight;
}
