/**
 * Time conversion utilities for ESAstronomy.
 *
 * Ported from ESAstronomy.cpp: Delta T computation, Julian date conversion,
 * and Julian centuries since J2000.0 epoch.
 *
 * All "dateInterval" parameters are seconds since the Apple/NeXT reference
 * date (Jan 1, 2001 00:00:00 UTC).
 */

import {
    kEC1990Epoch,
    kECJulianDateOf1990Epoch,
    kECJulianDateOf2000Epoch,
    kECJulianDaysPerCentury,
} from './astro-constants';
import type { AstroCache } from './astro-cache';
import { CacheSlot } from './astro-cache';
import {
    kECLeapEraStart,
    kECLeapTableValidUntil,
    kECLeapTableValidUntilISO,
    ttMinusUTCForDateInterval,
} from './es-leap-second';

// ============================================================================
// Supported astronomical date range
// ============================================================================

/**
 * Earliest supported astronomical date: Jan 1, 4000 BCE 00:00:00 UTC.
 * Apple epoch seconds (since Jan 1, 2001 00:00:00 UTC).
 * From ESTime.hpp: ESMinimumSupportedAstroDate.
 */
export const ES_MIN_ASTRO_DATE = -189344476800.0;

/**
 * Latest supported astronomical date: Jan 1, 2801 CE 00:00:00 UTC.
 * Apple epoch seconds (since Jan 1, 2001 00:00:00 UTC).
 * From ESTime.hpp: ESMaximumSupportedAstroDate.
 */
export const ES_MAX_ASTRO_DATE = 25245561600.0;

/** Earliest supported date as JS Date.getTime() milliseconds. */
export const MIN_DISPLAY_DATE_MS = (ES_MIN_ASTRO_DATE + 978307200) * 1000;

/** Latest supported date as JS Date.getTime() milliseconds. */
export const MAX_DISPLAY_DATE_MS = (ES_MAX_ASTRO_DATE + 978307200) * 1000;

// ============================================================================
// Delta T tables and functions
// ============================================================================

/**
 * Delta T table from Meeus 2nd ed, p79.
 * Values for even years from 1620 through 2004.
 */
const deltaTTable: readonly number[] = [
    121/*1620*/, 112/*1622*/, 103/*1624*/, 95/*1626*/, 88/*1628*/,
    82/*1630*/,  77/*1632*/,  72/*1634*/,  68/*1636*/, 63/*1638*/,
    60/*1640*/,  56/*1642*/,  53/*1644*/,  51/*1646*/, 48/*1648*/,
    46/*1650*/,  44/*1652*/,  42/*1654*/,  40/*1656*/, 38/*1658*/,
    35/*1660*/,  33/*1662*/,  31/*1664*/,  29/*1666*/, 26/*1668*/,
    24/*1670*/,  22/*1672*/,  20/*1674*/,  18/*1676*/, 16/*1678*/,
    14/*1680*/,  12/*1682*/,  11/*1684*/,  10/*1686*/,  9/*1688*/,
     8/*1690*/,   7/*1692*/,   7/*1694*/,   7/*1696*/,  7/*1698*/,
     7/*1700*/,   7/*1702*/,   8/*1704*/,   8/*1706*/,  9/*1708*/,
     9/*1710*/,   9/*1712*/,   9/*1714*/,   9/*1716*/, 10/*1718*/,
    10/*1720*/,  10/*1722*/,  10/*1724*/,  10/*1726*/, 10/*1728*/,
    10/*1730*/,  10/*1732*/,  11/*1734*/,  11/*1736*/, 11/*1738*/,
    11/*1740*/,  11/*1742*/,  12/*1744*/,  12/*1746*/, 12/*1748*/,
    12/*1750*/,  13/*1752*/,  13/*1754*/,  13/*1756*/, 14/*1758*/,
    14/*1760*/,  14/*1762*/,  14/*1764*/,  15/*1766*/, 15/*1768*/,
    15/*1770*/,  15/*1772*/,  15/*1774*/,  16/*1776*/, 16/*1778*/,
    16/*1780*/,  16/*1782*/,  16/*1784*/,  16/*1786*/, 16/*1788*/,
    16/*1790*/,  15/*1792*/,  15/*1794*/,  14/*1796*/, 13/*1798*/,
    13.1/*1800*/,  12.5/*1802*/,  12.2/*1804*/,  12/*1806*/,  12/*1808*/,
    12/*1810*/,  12/*1812*/,  12/*1814*/,  12/*1816*/, 11.9/*1818*/,
    11.6/*1820*/,  11/*1822*/,  10.2/*1824*/,   9.2/*1826*/,   8.2/*1828*/,
     7.1/*1830*/,   6.2/*1832*/,   5.6/*1834*/,   5.4/*1836*/,   5.3/*1838*/,
     5.4/*1840*/,   5.6/*1842*/,   5.9/*1844*/,   6.2/*1846*/,   6.5/*1848*/,
     6.8/*1850*/,   7.1/*1852*/,   7.3/*1854*/,   7.5/*1856*/,   7.6/*1858*/,
     7.7/*1860*/,   7.3/*1862*/,   6.2/*1864*/,   5.2/*1866*/,   2.7/*1868*/,
     1.4/*1870*/,  -1.2/*1872*/,  -2.8/*1874*/,  -3.8/*1876*/,  -4.8/*1878*/,
    -5.5/*1880*/,  -5.3/*1882*/,  -5.6/*1884*/,  -5.7/*1886*/,  -5.9/*1888*/,
    -6.0/*1890*/,  -6.3/*1892*/,  -6.5/*1894*/,  -6.2/*1896*/,  -4.7/*1898*/,
    -2.8/*1900*/,  -0.1/*1902*/,   2.6/*1904*/,   5.3/*1906*/,   7.7/*1908*/,
    10.4/*1910*/,  13.3/*1912*/,  16.0/*1914*/,  18.2/*1916*/,  20.2/*1918*/,
    21.1/*1920*/,  22.4/*1922*/,  23.5/*1924*/,  23.8/*1926*/,  24.3/*1928*/,
    24/*1930*/,  23.9/*1932*/,  23.9/*1934*/,  23.7/*1936*/,  24/*1938*/,
    24.3/*1940*/,  25.3/*1942*/,  26.2/*1944*/,  27.3/*1946*/,  28.2/*1948*/,
    29.1/*1950*/,  30/*1952*/,   30.7/*1954*/,  31.4/*1956*/,  32.2/*1958*/,
    33.1/*1960*/,  34/*1962*/,   35/*1964*/,   36.5/*1966*/,  38.3/*1968*/,
    40.2/*1970*/,  42.2/*1972*/,  44.5/*1974*/,  46.5/*1976*/,  48.5/*1978*/,
    50.5/*1980*/,  52.2/*1982*/,  53.8/*1984*/,  54.9/*1986*/,  55.8/*1988*/,
    56.9/*1990*/,  58.3/*1992*/,  60/*1994*/,   61.6/*1996*/,  63/*1998*/,
    63.8/*2000*/,  64.3/*2002*/,  64.6/*2004*/,
];

/**
 * Delta T from Meeus 2nd ed, p78.
 * Uses the Delta T table for 1620-2004 and polynomial extrapolation outside that range.
 */
export function ECMeeusDeltaT(yearValue: number): number {
    if (yearValue < 948) {
        const t = (yearValue - 2000) / 100;
        return 2177 + 497 * t + 44.1 * t * t;
    } else if (yearValue < 1620) {
        const t = (yearValue - 2000) / 100;
        return 102 + 102 * t + 25.3 * t * t;
    } else if (yearValue >= 2100) {
        const t = (yearValue - 2000) / 100;
        return 102 + 102 * t + 25.3 * t * t;
    } else if (yearValue > 2004) {
        const t = (yearValue - 2000) / 100;
        return 102 + 102 * t + 25.3 * t * t + 0.37 * (yearValue - 2100);
    } else if (yearValue === 2004) {
        return deltaTTable[(2004 - 1620) / 2];
    } else {
        const realIndex = (yearValue - 1620) / 2;
        const priorIndex = Math.floor(realIndex);
        const nextIndex = priorIndex + 1;
        const interpolation = realIndex - priorIndex;
        return deltaTTable[priorIndex] + (deltaTTable[nextIndex] - deltaTTable[priorIndex]) * interpolation;
    }
}

/**
 * Delta T from Espenak & Meeus (2006), "Five Millennium Canon of Solar Eclipses".
 * Polynomial expressions for different eras.
 */
export function espenakDeltaT(yearValue: number): number {
    if (yearValue >= 2005 && yearValue <= 2050) {
        const t = yearValue - 2000;
        return 62.92 + 0.32217 * t + 0.005589 * t * t;
    } else if (yearValue < -500 || yearValue >= 2150) {
        const u = (yearValue - 1820) / 100;
        return -20 + 32 * u * u;
    } else if (yearValue < 500) {
        const u = yearValue / 100;
        const u2 = u * u;
        const u3 = u2 * u;
        const u4 = u2 * u2;
        const u5 = u3 * u2;
        const u6 = u3 * u3;
        return 10583.6 - 1014.41 * u + 33.78311 * u2 - 5.952053 * u3
            - 0.1798452 * u4 + 0.022174192 * u5 + 0.0090316521 * u6;
    } else if (yearValue < 1600) {
        const u = (yearValue - 1000) / 100;
        const u2 = u * u;
        const u3 = u2 * u;
        const u4 = u2 * u2;
        const u5 = u3 * u2;
        const u6 = u3 * u3;
        return 1574.2 - 556.01 * u + 71.23472 * u2 + 0.319781 * u3
            - 0.8503463 * u4 - 0.005050998 * u5 + 0.0083572073 * u6;
    } else if (yearValue < 1700) {
        const t = yearValue - 1600;
        const t2 = t * t;
        const t3 = t2 * t;
        return 120 - 0.9808 * t - 0.01532 * t2 + t3 / 7129;
    } else if (yearValue < 1800) {
        const t = yearValue - 1700;
        const t2 = t * t;
        const t3 = t2 * t;
        const t4 = t2 * t2;
        return 8.83 + 0.1603 * t - 0.0059285 * t2 + 0.00013336 * t3 - t4 / 1174000;
    } else if (yearValue < 1860) {
        const t = yearValue - 1800;
        const t2 = t * t;
        const t3 = t2 * t;
        const t4 = t2 * t2;
        const t5 = t3 * t2;
        const t6 = t3 * t3;
        const t7 = t4 * t3;
        return 13.72 - 0.332447 * t + 0.0068612 * t2 + 0.0041116 * t3 - 0.00037436 * t4
            + 0.0000121272 * t5 - 0.0000001699 * t6 + 0.000000000875 * t7;
    } else if (yearValue < 1900) {
        const t = yearValue - 1860;
        const t2 = t * t;
        const t3 = t2 * t;
        const t4 = t2 * t2;
        const t5 = t3 * t2;
        return 7.62 + 0.5737 * t - 0.251754 * t2 + 0.01680668 * t3
            - 0.0004473624 * t4 + t5 / 233174;
    } else if (yearValue < 1920) {
        const t = yearValue - 1900;
        const t2 = t * t;
        const t3 = t2 * t;
        const t4 = t2 * t2;
        return -2.79 + 1.494119 * t - 0.0598939 * t2 + 0.0061966 * t3 - 0.000197 * t4;
    } else if (yearValue < 1941) {
        const t = yearValue - 1920;
        const t2 = t * t;
        const t3 = t2 * t;
        return 21.20 + 0.84493 * t - 0.076100 * t2 + 0.0020936 * t3;
    } else if (yearValue < 1961) {
        const t = yearValue - 1950;
        const t2 = t * t;
        const t3 = t2 * t;
        return 29.07 + 0.407 * t - t2 / 233 + t3 / 2547;
    } else if (yearValue < 1986) {
        const t = yearValue - 1975;
        const t2 = t * t;
        const t3 = t2 * t;
        return 45.45 + 1.067 * t - t2 / 260 - t3 / 718;
    } else if (yearValue < 2005) {
        const t = yearValue - 2000;
        const t2 = t * t;
        const t3 = t2 * t;
        const t4 = t2 * t2;
        const t5 = t3 * t2;
        return 63.86 + 0.3345 * t - 0.060374 * t2 + 0.0017275 * t3 + 0.000651814 * t4
            + 0.00002373599 * t5;
    } else {
        // 2050 < yearValue < 2150
        const t1 = (yearValue - 1820) / 100;
        return -20 + 32 * t1 * t1 - 0.5628 * (2150 - yearValue);
    }
}

/**
 * Espenak's ΔT at `kECLeapTableValidUntil` minus the exact value there — the
 * constant that makes the polynomial rejoin the table without a step. Computed
 * once, lazily, from generated constants.
 */
let _leapRejoinOffset: number | null = null;
function leapRejoinOffset(): number {
    if (_leapRejoinOffset === null) {
        // The same year-plus-fraction convention the polynomials are fed below.
        const d = new Date((kECLeapTableValidUntil + 978307200) * 1000);
        const year = d.getUTCFullYear();
        const jan1 = Date.UTC(year, 0, 1) / 1000 - 978307200;
        const yearValue = year + (kECLeapTableValidUntil - jan1) / (365.25 * 24 * 3600);
        _leapRejoinOffset =
            espenakDeltaT(yearValue) - ttMinusUTCForDateInterval(kECLeapTableValidUntil);
    }
    return _leapRejoinOffset;
}

/**
 * Convert UT to ET/TDT by adding ΔT. Three eras, in time order:
 *
 * 1. **Before 1972** — `espenakDeltaT`, the Five Millennium Canon polynomials.
 *    That is what they are for, and there is nothing better.
 * 2. **1972 through {@link kECLeapTableValidUntilISO}** — exact, from the
 *    leap-second table: `TT − UTC = 32.184 + (TAI − UTC)`. No fit is involved,
 *    so within this window ΔT is right to the millisecond rather than to the
 *    several seconds the polynomial had drifted (it predicted the Earth would
 *    keep slowing; instead it sped up, and by 2026 the 2005–2050 branch is
 *    ~5.9 s high — about 3″ of Moon).
 * 3. **After the table's expiry** — the polynomial again, shifted by the
 *    constant that makes it continuous at the handover. The parabola's
 *    curvature is the trustworthy part of the physics (tidal braking, good to
 *    centuries); its decadal level is not, and the offset absorbs that.
 *
 * The 1972 boundary itself steps by about 0.07 s (espenakDeltaT(1972.0) ≈ 42.25
 * against the exact 42.184) — far inside the polynomial's own error band there,
 * and not worth blending across.
 *
 * `ut` is UTC, not UT1; the |UT1 − UTC| < 0.9 s difference is unmodelled here
 * exactly as it was before. See planning/2026-08-18-leap-second-deltat.md.
 */
function convertUTtoET(ut: number, yearValue: number): number {
    if (ut < kECLeapEraStart) {
        return ut + espenakDeltaT(yearValue);
    }
    if (ut <= kECLeapTableValidUntil) {
        return ut + ttMinusUTCForDateInterval(ut);
    }
    return ut + espenakDeltaT(yearValue) - leapRejoinOffset();
}

// ============================================================================
// Julian date conversion
// ============================================================================

/**
 * Convert a date interval (Apple epoch seconds) to a Julian date.
 */
export function julianDateForDate(dateInterval: number): number {
    const secondsSince1990Epoch = dateInterval - kEC1990Epoch;
    return kECJulianDateOf1990Epoch + secondsSince1990Epoch / (24 * 3600);
}

// ============================================================================
// UT Midnight
// ============================================================================

/**
 * Return the prior UT midnight for a given date interval.
 * Uses Date arithmetic referencing UTC.
 */
function priorUTMidnightForDateRaw(dateInterval: number): number {
    // Convert Apple epoch to JS Date (Unix epoch)
    const unixMs = (dateInterval + 978307200) * 1000;
    const d = new Date(unixMs);
    d.setUTCHours(0, 0, 0, 0);
    // Convert back to Apple epoch
    return d.getTime() / 1000 - 978307200;
}

// Simple cache for prior UT midnight to avoid redundant date arithmetic
let _lastCalculatedMidnight = 0;

/**
 * Return the prior UT midnight for a given date interval, with caching.
 */
export function priorUTMidnightForDateInterval(
    dateInterval: number,
    cache: AstroCache | null,
): number {
    if (cache && cache.isValid(CacheSlot.priorUTMidnight)) {
        return cache.get(CacheSlot.priorUTMidnight);
    }

    let val: number;
    if (dateInterval > _lastCalculatedMidnight &&
        dateInterval < _lastCalculatedMidnight + 24 * 3600) {
        val = _lastCalculatedMidnight;
    } else {
        val = priorUTMidnightForDateRaw(dateInterval);
        _lastCalculatedMidnight = val;
    }

    if (cache) {
        cache.set(CacheSlot.priorUTMidnight, val);
    }
    return val;
}

// ============================================================================
// Julian centuries since J2000.0
// ============================================================================

// Simple cache for year start to avoid redundant date lookups
let _lastCalculatedFirstInterval = 0;
let _lastYearValue = 0;

/**
 * Result of computing Julian centuries since J2000.0 epoch.
 */
export interface JulianCenturiesResult {
    julianCenturiesSince2000Epoch: number;
    deltaT: number;
}

/**
 * Return TDT/ET Julian centuries since J2000.0 epoch for a given UT date interval.
 * This is the central time-conversion function used throughout the astronomy code.
 */
export function julianCenturiesSince2000EpochForDateInterval(
    dateInterval: number,
    cache: AstroCache | null,
): JulianCenturiesResult {
    if (cache && cache.isValid(CacheSlot.tdtCenturies)) {
        return {
            julianCenturiesSince2000Epoch: cache.get(CacheSlot.tdtCenturies),
            deltaT: cache.get(CacheSlot.tdtCenturiesDeltaT),
        };
    }

    const utSeconds = dateInterval;

    let firstOfThisYearInterval: number;
    if (utSeconds > _lastCalculatedFirstInterval &&
        utSeconds < _lastCalculatedFirstInterval + (24 * 3600 * 330)) {
        firstOfThisYearInterval = _lastCalculatedFirstInterval;
    } else {
        // Convert to JS Date to get year start
        const unixMs = (utSeconds + 978307200) * 1000;
        const d = new Date(unixMs);
        const year = d.getUTCFullYear();
        // Get Jan 1 of this year
        const jan1 = Date.UTC(year, 0, 1, 0, 0, 0, 0);
        firstOfThisYearInterval = jan1 / 1000 - 978307200;
        _lastCalculatedFirstInterval = firstOfThisYearInterval;
        // For era handling, use the Gregorian year value directly
        _lastYearValue = year;
    }

    const yearValue = _lastYearValue + (utSeconds - firstOfThisYearInterval) / (365.25 * 24 * 3600);
    const etSeconds = convertUTtoET(utSeconds, yearValue);
    const deltaT = etSeconds - utSeconds;
    const julianDaysSince2000Epoch = julianDateForDate(etSeconds) - kECJulianDateOf2000Epoch;
    const julianCenturiesSince2000Epoch = julianDaysSince2000Epoch / kECJulianDaysPerCentury;

    if (cache) {
        cache.set(CacheSlot.tdtCenturies, julianCenturiesSince2000Epoch);
        cache.set(CacheSlot.tdtCenturiesDeltaT, deltaT);
        cache.set(CacheSlot.tdtHundredCenturies, julianCenturiesSince2000Epoch / 100);
    }

    return { julianCenturiesSince2000Epoch, deltaT };
}

/**
 * Convert a JavaScript Date to an Apple epoch time interval (seconds since 2001-01-01 00:00:00 UTC).
 */
export function dateToDateInterval(date: Date): number {
    return date.getTime() / 1000 - 978307200;
}

/**
 * Convert an Apple epoch time interval to a JavaScript Date.
 */
export function dateIntervalToDate(dateInterval: number): Date {
    return new Date((dateInterval + 978307200) * 1000);
}
