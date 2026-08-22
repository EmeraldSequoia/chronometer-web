/**
 * Rise/Set/Transit computation.
 *
 * Ported from ESAstronomy.cpp: iterative refinement algorithm for calculating
 * sunrise, sunset, moonrise, moonset, and transit times.
 *
 * The algorithm follows Meeus pp 102-103 with iterative refinement using
 * the extrapolateToYEqualX convergence accelerator from the original code.
 *
 * Times in Apple epoch seconds, angles in radians.
 */

import {
    fmod,
    ECPlanetNumber,
    ECWBPrecision,
    ALWAYS_ABOVE_HORIZON,
    ALWAYS_BELOW_HORIZON,
    isNoRiseSet,
    kECRefractionAtHorizonX,
    kECCivilTwilightAltitude,
    kECNauticalTwilightAltitude,
    kECAstroTwilightAltitude,
    kECGoldenHourAltitude,
} from './astro-constants';
import {
    AstroCache,
    AstroCachePool,
    CacheSlot,
    pushECAstroCacheInPool,
    popECAstroCacheToInPool,
} from './astro-cache';
import { julianCenturiesSince2000EpochForDateInterval, priorUTMidnightForDateInterval } from './es-time';
import { convertLSTtoGST, convertGSTtoLST, convertUTToGSTP03, convertGSTtoUTclosest } from './es-sidereal';
import { sunRAandDecl, moonRAAndDecl, altitudeAtRiseSet } from './es-coordinates';
import { WB_sunRAAndDecl } from './wb-sun';
import { WB_MoonRAAndDecl, WB_MoonDistance } from './wb-moon';
import { WB_planetApparentPosition } from './willmann-bell';

const TWO_PI = Math.PI * 2;

// ============================================================================
// Core rise/set time calculation (single iteration)
// ============================================================================

/**
 * Calculate rise or set time for an object with given RA/Decl.
 * Based on Meeus pp 102-103 (without delta-m correction).
 *
 * Returns the date interval of the rise/set event, or ALWAYS_ABOVE_HORIZON / ALWAYS_BELOW_HORIZON.
 */
function riseSetTime(
    riseNotSet: boolean,
    rightAscension: number,
    declination: number,
    observerLatitude: number,
    observerLongitude: number,
    altAtRiseSet: number,
    calculationDateInterval: number,
    cachePool: AstroCachePool | null,
): number {
    const cosH = (Math.sin(altAtRiseSet) - Math.sin(observerLatitude) * Math.sin(declination))
        / (Math.cos(observerLatitude) * Math.cos(declination));

    if (cosH < -1.0) {
        return ALWAYS_ABOVE_HORIZON; // always above the horizon
    } else if (cosH > 1.0) {
        return ALWAYS_BELOW_HORIZON; // always below the horizon
    }

    const H = Math.acos(cosH);
    let LST_rs = rightAscension + (riseNotSet ? TWO_PI - H : H);
    if (LST_rs > TWO_PI) {
        LST_rs -= TWO_PI;
    }

    const { gst: GST_rs } = convertLSTtoGST(LST_rs, observerLongitude);
    const riseSetDate = convertGSTtoUTclosest(GST_rs, calculationDateInterval, cachePool);
    return riseSetDate;
}

// ============================================================================
// Transit time
// ============================================================================

/**
 * Calculate the transit time (meridian crossing) for an object.
 */
function transitTime(
    dateInterval: number,
    wantHighTransit: boolean,
    observerLongitude: number,
    rightAscension: number,
    currentCache: AstroCache | null,
): number {
    const gst = convertUTToGSTP03(dateInterval, currentCache);
    let ra = rightAscension;
    if (!wantHighTransit) {
        ra += Math.PI;
    }
    let hourAngle = fmod(gst + observerLongitude - ra, TWO_PI);
    if (hourAngle > Math.PI) {
        hourAngle -= TWO_PI;
    } else if (hourAngle < -Math.PI) {
        hourAngle += TWO_PI;
    }
    return dateInterval - hourAngle * (12 * 3600) / Math.PI;
}

// ============================================================================
// Convergence accelerator
// ============================================================================

/**
 * Linear fit: find where y = x on the line through (X1,Y1) and (X2,Y2).
 */
function linearFit(X1: number, Y1: number, X2: number, Y2: number): number {
    const offset = X1;
    const x1 = 0;
    const y1 = Y1 - offset;
    const x2 = X2 - offset;
    const y2 = Y2 - offset;
    const denom = x2 - x1 - y2 + y1;
    if (denom === 0) {
        return y2 + offset;
    }
    const root = (y1 * (x2 - x1) - x1 * (y2 - y1)) / denom;
    if (Math.abs(root - y2) > 12 * 3600) {
        return y2 + offset;
    }
    return offset + root;
}

/**
 * Extrapolate to find x where f(x) = x, using parabolic/linear fitting.
 * From the original ESAstronomy.cpp.
 */
function extrapolateToYEqualX(x: number[], y: number[], numValues: number): number {
    if (numValues === 1) {
        return y[0];
    }

    if (numValues > 2) {
        const offset = x[numValues - 3];
        const X1 = 0;
        const Y1 = y[numValues - 3] - offset;
        const X2 = x[numValues - 2] - offset;
        const Y2 = y[numValues - 2] - offset;
        const X3 = x[numValues - 1] - offset;
        const Y3 = y[numValues - 1] - offset;

        if (X1 !== X2 && X1 !== X3 && X2 !== X3) {
            const k1 = Y1 / ((X1 - X2) * (X1 - X3));
            const k2 = Y2 / ((X2 - X1) * (X2 - X3));
            const k3 = Y3 / ((X3 - X1) * (X3 - X2));

            const C2 = k1 + k2 + k3;
            const C1 = k1 * (X2 + X3) + k2 * (X1 + X3) + k3 * (X1 + X2);
            const C0 = k1 * X2 * X3 + k2 * X1 * X3 + k3 * X1 * X2;

            if (C2 !== 0) {
                const p = (-C1 - 1) / C2;
                const q = C0 / C2;
                const D = p * p / 4 - q;
                if (D >= 0) {
                    const sqrtTerm = Math.sqrt(D);
                    const root1 = -p / 2 + sqrtTerm;
                    const root2 = -p / 2 - sqrtTerm;
                    if (Math.abs(root1 - Y3) < Math.abs(root2 - Y3)) {
                        if (Math.abs(root1 - Y3) < 24 * 3600) {
                            return root1 + offset;
                        }
                    } else {
                        if (Math.abs(root2 - Y3) < 24 * 3600) {
                            return root2 + offset;
                        }
                    }
                }
            }
        }
    }

    return linearFit(x[numValues - 2], y[numValues - 2], x[numValues - 1], y[numValues - 1]);
}

// ============================================================================
// Iterative rise/set refinement (the main algorithm)
// ============================================================================

/**
 * Get planet RA/Decl for a given date (dispatches to Sun or Moon).
 * Returns { rightAscension, declination, distance }.
 */
function getPlanetRADeclDist(
    planetNumber: number,
    julianCenturiesSince2000Epoch: number,
    cache: AstroCache | null,
    precision: ECWBPrecision,
): { rightAscension: number; declination: number; distance: number } {
    if (planetNumber === ECPlanetNumber.Sun) {
        const result = WB_sunRAAndDecl(julianCenturiesSince2000Epoch / 100, cache ?? undefined);
        return {
            rightAscension: result.rightAscension,
            declination: result.declination,
            distance: 1.0, // approximate; will use WB_sunRadius for precise
        };
    } else if (planetNumber === ECPlanetNumber.Moon) {
        const result = WB_MoonRAAndDecl(julianCenturiesSince2000Epoch, cache ?? undefined, precision);
        const distKm = WB_MoonDistance(julianCenturiesSince2000Epoch, cache ?? undefined, precision);
        return {
            rightAscension: result.rightAscension,
            declination: result.declination,
            distance: distKm / 149597870.691,
        };
    } else {
        // Other planets: use WB_planetApparentPosition
        const pos = WB_planetApparentPosition(
            planetNumber as ECPlanetNumber,
            julianCenturiesSince2000Epoch / 100,
            cache ?? undefined,
        );
        return {
            rightAscension: pos.apparentRightAscension,
            declination: pos.apparentDeclination,
            distance: pos.geocentricDistance,
        };
    }
}

/**
 * Result of a rise/set time calculation.
 * Matches iOS riseSetOrTransit output parameter pattern.
 */
export interface RiseSetResult {
    /** The rise or set event time (dateInterval), or ALWAYS_ABOVE/BELOW_HORIZON sentinel. */
    riseSetTime: number;
    /** Associated transit/reference time — used by nextPrevRiseSetInternal for direction validation. */
    transitTime: number;
}

/**
 * Iterative rise/set computation for Sun or Moon.
 * Follows the full algorithm from ESAstronomy.cpp:planetaryRiseSetTimeRefined.
 *
 * @param calculationDateInterval - Starting date for the search
 * @param observerLatitude - Observer latitude (radians)
 * @param observerLongitude - Observer longitude (radians, east positive)
 * @param riseNotSet - true for rise, false for set
 * @param planetNumber - ECPlanetNumber
 * @param overrideAltitudeDesired - Override the default altitude at rise/set (NaN for default)
 * @param cachePool - AstroCachePool for computation
 * @returns RiseSetResult with the event time and associated transit time
 */

export function planetaryRiseSetTimeRefined(
    calculationDateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    riseNotSet: boolean,
    planetNumber: number,
    overrideAltitudeDesired: number,
    cachePool: AstroCachePool,
): RiseSetResult {
    // Full port of iOS ESAstronomy.cpp planetaryRiseSetTimeRefined (lines 1529-1786).
    // Includes transit-retry, polar binary search, and bisection recovery.
    let tryDate = calculationDateInterval;
    let lastValidResultDate = NaN;
    let lastValidTryDate = NaN;
    let convergedToInvalid = false;
    const polarSpecial = Math.abs(observerLatitude) > Math.PI / 180 * 89;

    let precision: ECWBPrecision = planetNumber === ECPlanetNumber.Moon
        ? ECWBPrecision.Low : ECWBPrecision.Full;
    if (polarSpecial) {
        precision = ECWBPrecision.Full;  // iOS: We need all the help we can get at polar latitudes
    }

    const numIterations = 20;
    const numPolarTries = 10;  // Binary-search tries for polar — gets within ~1 minute
    const tryDates: number[] = new Array(numIterations + numPolarTries + 1);
    const results: number[] = new Array(numIterations + numPolarTries + 1);
    let fitTries = 0;
    let lastDelta = 0;
    let firstNan = NaN;
    let firstTransit = tryDate;

    for (let i = 0; i < numIterations; i++) {
        // Upgrade Moon precision near the end
        if (planetNumber === ECPlanetNumber.Moon && i === numIterations - 1 && precision !== ECWBPrecision.Full) {
            precision = ECWBPrecision.Full;
            i--;  // Give two more shots with full precision
            fitTries = 0;  // Ignore low-precision prior values
        }

        let priorCache = pushECAstroCacheInPool(
            cachePool, cachePool.refinementCache, tryDate,
        );

        let jcse =
            julianCenturiesSince2000EpochForDateInterval(tryDate, cachePool.currentCache).julianCenturiesSince2000Epoch;

        let radecl = getPlanetRADeclDist(
            planetNumber, jcse, cachePool.currentCache, precision,
        );

        const altitude = isNaN(overrideAltitudeDesired)
            ? altitudeAtRiseSet(jcse, planetNumber, true, cachePool.currentCache, precision)
            : overrideAltitudeDesired;

        let newDate = riseSetTime(
            riseNotSet, radecl.rightAscension, radecl.declination,
            observerLatitude, observerLongitude,
            altitude, tryDate, cachePool,
        );

        popECAstroCacheToInPool(cachePool, priorCache);

        if (isNoRiseSet(newDate)) {
            // iOS lines 1577-1733: no rise/set — attempt transit-retry and polar recovery
            if (!convergedToInvalid) {
                // First time hitting invalid — try from the transit point
                convergedToInvalid = true;

                // iOS: if below horizon, want high transit to check highest point;
                //      if above horizon, want low transit to check lowest point
                const wantHighTransit = newDate === ALWAYS_BELOW_HORIZON;

                priorCache = pushECAstroCacheInPool(
                    cachePool, cachePool.refinementCache, tryDate,
                );
                const transitT = planettransitTimeRefined(
                    tryDate, observerLatitude, observerLongitude,
                    wantHighTransit, planetNumber, cachePool,
                );
                popECAstroCacheToInPool(cachePool, priorCache);
                firstTransit = transitT;
                firstNan = newDate;

                // Retry rise/set from the transit point
                priorCache = pushECAstroCacheInPool(
                    cachePool, cachePool.refinementCache, transitT,
                );
                jcse = julianCenturiesSince2000EpochForDateInterval(transitT, cachePool.currentCache).julianCenturiesSince2000Epoch;
                radecl = getPlanetRADeclDist(
                    planetNumber, jcse, cachePool.currentCache, precision,
                );
                const altit = isNaN(overrideAltitudeDesired)
                    ? altitudeAtRiseSet(jcse, planetNumber, true, cachePool.currentCache, precision)
                    : overrideAltitudeDesired;
                newDate = riseSetTime(
                    riseNotSet, radecl.rightAscension, radecl.declination,
                    observerLatitude, observerLongitude,
                    altit, transitT, cachePool,
                );
                popECAstroCacheToInPool(cachePool, priorCache);

                if (isNoRiseSet(newDate)) {
                    if (polarSpecial) {
                        // iOS lines 1600-1703: Polar binary search
                        // Go ±13 hours from transit and look for an above/below transition

                        // Check -13 hrs
                        const priorPolar = transitT - 13 * 3600;
                        priorCache = pushECAstroCacheInPool(
                            cachePool, cachePool.refinementCache, priorPolar,
                        );
                        jcse = julianCenturiesSince2000EpochForDateInterval(priorPolar, cachePool.currentCache).julianCenturiesSince2000Epoch;
                        radecl = getPlanetRADeclDist(
                            planetNumber, jcse, cachePool.currentCache, precision,
                        );
                        const priorPolarEvent = riseSetTime(
                            riseNotSet, radecl.rightAscension, radecl.declination,
                            observerLatitude, observerLongitude,
                            altitudeAtRiseSet(jcse, planetNumber, true, cachePool.currentCache, precision),
                            priorPolar, cachePool,
                        );
                        popECAstroCacheToInPool(cachePool, priorCache);

                        let binaryLow = NaN;
                        let binaryHigh = NaN;
                        let binaryLowEvent = NaN;
                        let binaryHighEvent = NaN;

                        if (isNoRiseSet(priorPolarEvent)) {
                            // Prior event is also NaN — check if it's a different kind of NaN
                            if (priorPolarEvent !== newDate) {
                                // Different sentinel: one is always-above, other always-below → transition between them
                                binaryLow = priorPolar;
                                binaryLowEvent = priorPolarEvent;
                                binaryHigh = transitT;
                                binaryHighEvent = newDate;
                            }

                            // Check +13 hrs
                            const nextPolar = tryDate + 13 * 3600;
                            priorCache = pushECAstroCacheInPool(
                                cachePool, cachePool.refinementCache, nextPolar,
                            );
                            jcse = julianCenturiesSince2000EpochForDateInterval(nextPolar, cachePool.currentCache).julianCenturiesSince2000Epoch;
                            radecl = getPlanetRADeclDist(
                                planetNumber, jcse, cachePool.currentCache, precision,
                            );
                            const nextPolarEvent = riseSetTime(
                                riseNotSet, radecl.rightAscension, radecl.declination,
                                observerLatitude, observerLongitude,
                                altitudeAtRiseSet(jcse, planetNumber, true, cachePool.currentCache, precision),
                                nextPolar, cachePool,
                            );
                            popECAstroCacheToInPool(cachePool, priorCache);

                            if (isNoRiseSet(nextPolarEvent)) {
                                if (nextPolarEvent !== newDate) {
                                    // Different sentinel → transition between transit and +13h
                                    binaryLow = transitT;
                                    binaryLowEvent = newDate;
                                    binaryHigh = nextPolar;
                                    binaryHighEvent = nextPolarEvent;
                                } else if (isNaN(binaryLow)) {
                                    // Both sides same as transit → truly no rise/set
                                    return { riseSetTime: newDate, transitTime: transitT };
                                }
                            } else {
                                // +13h has a valid event
                                if (nextPolarEvent > tryDate + 24 * 3600) {
                                    // Too far ahead, doesn't count
                                    return { riseSetTime: newDate, transitTime: transitT };
                                }
                                tryDate = nextPolar;
                                newDate = nextPolarEvent;
                            }
                        } else {
                            // Prior polar event is valid (not NaN)
                            if (priorPolarEvent < tryDate - 24 * 3600) {
                                // Too long ago, doesn't count
                                return { riseSetTime: newDate, transitTime: transitT };
                            }
                            tryDate = priorPolar;
                            newDate = priorPolarEvent;
                        }

                        // Binary search between binaryLow and binaryHigh if set
                        if (!isNaN(binaryLow)) {
                            let polarTries = numPolarTries;
                            while (polarTries-- > 0) {
                                const split = (binaryLow + binaryHigh) / 2;
                                priorCache = pushECAstroCacheInPool(
                                    cachePool, cachePool.refinementCache, split,
                                );
                                jcse = julianCenturiesSince2000EpochForDateInterval(split, cachePool.currentCache).julianCenturiesSince2000Epoch;
                                radecl = getPlanetRADeclDist(
                                    planetNumber, jcse, cachePool.currentCache, precision,
                                );
                                const splitEvent = riseSetTime(
                                    riseNotSet, radecl.rightAscension, radecl.declination,
                                    observerLatitude, observerLongitude,
                                    altitudeAtRiseSet(jcse, planetNumber, true, cachePool.currentCache, precision),
                                    split, cachePool,
                                );
                                popECAstroCacheToInPool(cachePool, priorCache);

                                if (!isNoRiseSet(splitEvent)) {
                                    // Found a valid rise/set — use split as pseudo "transit"
                                    firstTransit = split;
                                    newDate = splitEvent;
                                    break;
                                }
                                // Narrow the binary search
                                if (splitEvent === binaryLowEvent) {
                                    binaryLow = split;
                                    binaryLowEvent = splitEvent;
                                } else {
                                    binaryHigh = split;
                                    binaryHighEvent = splitEvent;
                                }
                            }
                            if (isNoRiseSet(newDate)) {
                                // Binary search didn't find a valid point
                                return { riseSetTime: newDate, transitTime: firstTransit };
                            }
                        }
                    } else {
                        // Not polarSpecial — no further recovery possible
                        return { riseSetTime: newDate, transitTime: transitT };
                    }
                } // end if isNoRiseSet(newDate) at transit

                // Transit retry succeeded — add (transitT, newDate) as a fit point
                // and continue iterating
                if (!isNoRiseSet(newDate)) {
                    lastValidTryDate = firstTransit;
                    lastValidResultDate = newDate;
                    tryDates[fitTries] = firstTransit;
                    results[fitTries++] = newDate;
                    tryDate = extrapolateToYEqualX(tryDates, results, fitTries);
                }
            } else {
                // iOS lines 1724-1733: already did the convergedToInvalid case
                // Bisect between last valid date and current invalid tryDate
                if (!isNaN(lastValidTryDate)) {
                    tryDate = (tryDate + lastValidTryDate) / 2;
                } else {
                    // No valid try date — can't recover
                    return { riseSetTime: newDate, transitTime: tryDate };
                }
                // We have no curve info here, so don't add to fitTries arrays
            }
        } else {
            // iOS lines 1734-1743: valid rise/set result
            lastValidTryDate = tryDate;
            lastValidResultDate = newDate;
            tryDates[fitTries] = tryDate;
            results[fitTries++] = newDate;
            tryDate = extrapolateToYEqualX(tryDates, results, fitTries);
        }

        // iOS lines 1748-1766: convergence check (outside NaN handling)
        lastDelta = lastValidResultDate - lastValidTryDate;
        if (Math.abs(lastDelta) < 0.1) {
            if (planetNumber === ECPlanetNumber.Moon && precision !== ECWBPrecision.Full) {
                precision = ECWBPrecision.Full;
                continue;
            }
            // Converged
            return { riseSetTime: lastValidResultDate, transitTime: lastValidResultDate };
        }
    }

    // iOS lines 1773-1785: Did not converge
    if (isNaN(lastValidResultDate)) {
        return { riseSetTime: lastValidResultDate, transitTime: tryDate };
    } else if (Math.abs(lastDelta) > 60) {
        // Still futzing around — return firstNan with firstTransit
        return { riseSetTime: firstNan, transitTime: firstTransit };
    } else {
        return { riseSetTime: lastValidResultDate, transitTime: lastValidResultDate };
    }
}

/**
 * Calculate transit time for a planet, with iterative refinement.
 */
export function planettransitTimeRefined(
    calculationDateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    wantHighTransit: boolean,
    planetNumber: number,
    cachePool: AstroCachePool,
): number {
    let tryDate = calculationDateInterval;
    let precision: ECWBPrecision = planetNumber === ECPlanetNumber.Moon
        ? ECWBPrecision.Low : ECWBPrecision.Full;

    const numIterations = 7;
    const tryDates: number[] = new Array(numIterations);
    const results_arr: number[] = new Array(numIterations);
    let fitTries = 0;

    for (let i = 0; i < numIterations; i++) {
        if (planetNumber === ECPlanetNumber.Moon && i === numIterations - 1 && precision !== ECWBPrecision.Full) {
            precision = ECWBPrecision.Full;
            i--;
            fitTries = 0;
        }

        const priorCache = pushECAstroCacheInPool(
            cachePool, cachePool.refinementCache, tryDate,
        );

        const { julianCenturiesSince2000Epoch } =
            julianCenturiesSince2000EpochForDateInterval(tryDate, cachePool.currentCache);

        const { rightAscension } = getPlanetRADeclDist(
            planetNumber, julianCenturiesSince2000Epoch, cachePool.currentCache, precision,
        );

        const newDate = transitTime(
            tryDate, wantHighTransit, observerLongitude,
            rightAscension, cachePool.currentCache,
        );

        popECAstroCacheToInPool(cachePool, priorCache);

        if (Math.abs(newDate - tryDate) < 0.1) {
            if (planetNumber === ECPlanetNumber.Moon && precision !== ECWBPrecision.Full) {
                precision = ECWBPrecision.Full;
            } else {
                return newDate;
            }
        }

        tryDates[fitTries] = tryDate;
        results_arr[fitTries] = newDate;
        fitTries++;
        tryDate = extrapolateToYEqualX(tryDates, results_arr, fitTries);
    }

    return tryDate;
}

// ============================================================================
// "For day" searches (find the body's rise/set/transit on the LOCAL calendar day)
// ============================================================================

/**
 * Rise (`riseNotSet=true`) or set (`false`) of a body for the LOCAL calendar day,
 * seeded at that day's local noon (`noonDI`). Searches forward from local noon; if
 * that event doesn't fall on the local day, searches backward from the previous local
 * noon; returns the event on the local day, or NaN if none (e.g. polar day/night).
 *
 * `isSameLocalDay(eventDI)` decides "on the local day" — supplied by the caller, which
 * owns the timezone/calendar (this layer stays tz-agnostic). The result is memoized in
 * the planet rise/set for-day slot of the pool's **current cache** (keyed by that
 * cache's display time), so the several subdial values referencing one event share a
 * single ~68µs search. Planets 0..9 only; Pluto/MidnightSun compute uncached, matching
 * getMasterRiseSet.
 *
 * Replaces an earlier UT-noon single-search version (a bad iOS port that returned the
 * wrong day for western longitudes). See
 * planning/2026-06-28-per-tick-astronomy-memoization.md.
 */
export function riseSetForLocalDay(
    noonDI: number,
    observerLatitude: number,
    observerLongitude: number,
    riseNotSet: boolean,
    planetNumber: number,
    cachePool: AstroCachePool,
    isSameLocalDay: (eventDI: number) => boolean,
): number {
    const cache = cachePool.currentCache;
    const slot = (planetNumber >= 0 && planetNumber <= 9)
        ? (riseNotSet ? CacheSlot.planetriseForDay : CacheSlot.planetsetForDay) + planetNumber
        : -1;
    if (slot >= 0 && cache && cache.isValid(slot)) {
        return cache.get(slot);
    }

    let result = NaN;
    const fwd = planetaryRiseSetTimeRefined(
        noonDI, observerLatitude, observerLongitude,
        riseNotSet, planetNumber, NaN, cachePool,
    ).riseSetTime;
    if (!isNoRiseSet(fwd) && isSameLocalDay(fwd)) {
        result = fwd;
    } else {
        const bwd = planetaryRiseSetTimeRefined(
            noonDI - 24 * 3600, observerLatitude, observerLongitude,
            riseNotSet, planetNumber, NaN, cachePool,
        ).riseSetTime;
        if (!isNoRiseSet(bwd) && isSameLocalDay(bwd)) {
            result = bwd;
        }
    }

    if (slot >= 0 && cache) cache.set(slot, result);
    return result;
}

/**
 * High transit (meridian crossing) of a body for the LOCAL calendar day, seeded at the
 * day's local noon. Transit always exists, but the one nearest local noon can land on
 * the adjacent local day; the forward/backward + `isSameLocalDay` selection mirrors
 * {@link riseSetForLocalDay}. Memoized in the `planettransitForDay` slot (planets 0..9).
 */
export function transitForLocalDay(
    noonDI: number,
    observerLatitude: number,
    observerLongitude: number,
    planetNumber: number,
    cachePool: AstroCachePool,
    isSameLocalDay: (eventDI: number) => boolean,
): number {
    const cache = cachePool.currentCache;
    const slot = (planetNumber >= 0 && planetNumber <= 9)
        ? CacheSlot.planettransitForDay + planetNumber : -1;
    if (slot >= 0 && cache && cache.isValid(slot)) {
        return cache.get(slot);
    }

    let result = planettransitTimeRefined(
        noonDI, observerLatitude, observerLongitude, true, planetNumber, cachePool,
    );
    if (!isSameLocalDay(result)) {
        const result2 = planettransitTimeRefined(
            noonDI - 24 * 3600, observerLatitude, observerLongitude, true, planetNumber, cachePool,
        );
        result = isSameLocalDay(result2) ? result2 : NaN;
    }

    if (slot >= 0 && cache) cache.set(slot, result);
    return result;
}

/**
 * Local noon + day window `[start, end)` (as date intervals) for the local calendar day
 * containing `dateInterval`, given the timezone's UTC offset. Pure arithmetic — used by
 * the self-contained wrappers below and available for callers that don't have their own
 * civil-calendar logic.
 */
export function localDayNoonAndWindow(
    dateInterval: number,
    tzOffsetSeconds: number,
): { noonDI: number; dayStartDI: number; dayEndDI: number } {
    const localSec = dateInterval + 978307200 + tzOffsetSeconds;
    const localDayStartSec = localSec - (((localSec % 86400) + 86400) % 86400);
    const dayStartDI = localDayStartSec - tzOffsetSeconds - 978307200;
    return { noonDI: dayStartDI + 12 * 3600, dayStartDI, dayEndDI: dayStartDI + 86400 };
}

/**
 * Self-contained "today's sunrise" for a given date, deriving the local day from the
 * pool's `tzOffsetSeconds`. Convenience wrapper over {@link riseSetForLocalDay} for
 * standalone callers/tests (production routes through astro-env, which supplies its own
 * local-noon seed and same-day predicate).
 */
export function sunriseForDay(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cachePool: AstroCachePool,
): number {
    const { noonDI, dayStartDI, dayEndDI } = localDayNoonAndWindow(dateInterval, cachePool.tzOffsetSeconds);
    return riseSetForLocalDay(
        noonDI, observerLatitude, observerLongitude, true, ECPlanetNumber.Sun, cachePool,
        (e) => e >= dayStartDI && e < dayEndDI,
    );
}

/** Self-contained "today's sunset" (see {@link sunriseForDay}). */
export function sunsetForDay(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cachePool: AstroCachePool,
): number {
    const { noonDI, dayStartDI, dayEndDI } = localDayNoonAndWindow(dateInterval, cachePool.tzOffsetSeconds);
    return riseSetForLocalDay(
        noonDI, observerLatitude, observerLongitude, false, ECPlanetNumber.Sun, cachePool,
        (e) => e >= dayStartDI && e < dayEndDI,
    );
}

/** Self-contained "today's solar transit" (see {@link sunriseForDay}). */
export function suntransitForDay(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cachePool: AstroCachePool,
): number {
    const { noonDI, dayStartDI, dayEndDI } = localDayNoonAndWindow(dateInterval, cachePool.tzOffsetSeconds);
    return transitForLocalDay(
        noonDI, observerLatitude, observerLongitude, ECPlanetNumber.Sun, cachePool,
        (e) => e >= dayStartDI && e < dayEndDI,
    );
}

// ============================================================================
// Twilight times
// ============================================================================

/**
 * Find the time when the Sun crosses a given altitude boundary for the day.
 * Used for twilight calculations.
 *
 * @param riseNotSet - true for morning boundary, false for evening boundary
 * @param altitudeDesired - The target altitude in radians (e.g. kECCivilTwilightAltitude)
 */
export function sunAltitudeTimeForDay(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    riseNotSet: boolean,
    altitudeDesired: number,
    cachePool: AstroCachePool,
): number {
    const midnight = priorUTMidnightForDateInterval(dateInterval, cachePool.currentCache);
    const noon = midnight + 12 * 3600;

    return planetaryRiseSetTimeRefined(
        noon, observerLatitude, observerLongitude,
        riseNotSet, ECPlanetNumber.Sun, altitudeDesired, cachePool,
    ).riseSetTime;
}

/** Civil twilight start (morning). */
export function civilTwilightMorning(
    dateInterval: number, lat: number, lon: number, pool: AstroCachePool,
): number {
    return sunAltitudeTimeForDay(dateInterval, lat, lon, true, kECCivilTwilightAltitude, pool);
}

/** Civil twilight end (evening). */
export function civilTwilightEvening(
    dateInterval: number, lat: number, lon: number, pool: AstroCachePool,
): number {
    return sunAltitudeTimeForDay(dateInterval, lat, lon, false, kECCivilTwilightAltitude, pool);
}

/** Nautical twilight start (morning). */
export function nauticalTwilightMorning(
    dateInterval: number, lat: number, lon: number, pool: AstroCachePool,
): number {
    return sunAltitudeTimeForDay(dateInterval, lat, lon, true, kECNauticalTwilightAltitude, pool);
}

/** Nautical twilight end (evening). */
export function nauticalTwilightEvening(
    dateInterval: number, lat: number, lon: number, pool: AstroCachePool,
): number {
    return sunAltitudeTimeForDay(dateInterval, lat, lon, false, kECNauticalTwilightAltitude, pool);
}

/** Astronomical twilight start (morning). */
export function astroTwilightMorning(
    dateInterval: number, lat: number, lon: number, pool: AstroCachePool,
): number {
    return sunAltitudeTimeForDay(dateInterval, lat, lon, true, kECAstroTwilightAltitude, pool);
}

/** Astronomical twilight end (evening). */
export function astroTwilightEvening(
    dateInterval: number, lat: number, lon: number, pool: AstroCachePool,
): number {
    return sunAltitudeTimeForDay(dateInterval, lat, lon, false, kECAstroTwilightAltitude, pool);
}

/** Golden hour start (morning). */
export function goldenHourMorning(
    dateInterval: number, lat: number, lon: number, pool: AstroCachePool,
): number {
    return sunAltitudeTimeForDay(dateInterval, lat, lon, true, kECGoldenHourAltitude, pool);
}

/** Golden hour end (evening). */
export function goldenHourEvening(
    dateInterval: number, lat: number, lon: number, pool: AstroCachePool,
): number {
    return sunAltitudeTimeForDay(dateInterval, lat, lon, false, kECGoldenHourAltitude, pool);
}
