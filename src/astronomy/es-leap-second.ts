/**
 * TAI−UTC (leap-second) table — GENERATED FILE, DO NOT EDIT.
 *
 * Regenerate with:  node scripts/update-leap-seconds.mjs
 *
 * Source:  https://data.iana.org/time-zones/data/leap-seconds.list
 *          (origin https://hpiers.obspm.fr/iers/bul/bulc/ntp/leap-seconds.list)
 * Last update line (#$): 2026-07-06T07:44:57Z
 * Expiration line (#@):  2027-06-28T00:00:00Z
 * Integrity hash (#h):   a9bad14584c31c70758402aab37bfd545923836a — verified at generation time
 *
 * From 1972-01-01 onward, TT−UTC is exact by definition:
 *
 *     TT − UTC = 32.184 s + (TAI − UTC)
 *
 * because TT is a fixed 32.184 s ahead of TAI and TAI−UTC is an integer that
 * changes only at the announced leap seconds tabulated below. That makes ΔT a
 * lookup rather than a fitted polynomial for the whole modern era — see
 * es-time.ts `convertUTtoET`, which is the only consumer.
 *
 * The table is authoritative only as far as the IERS has announced, hence
 * `kECLeapTableValidUntil`. build.sh warns once today is past it.
 *
 * All times are Apple-epoch seconds (since 2001-01-01 00:00:00 UTC).
 */

/* LEAP-TABLE-EXPIRES 2027-06-28 — build.sh greps this line. */

/** 1972-01-01 00:00:00 UTC — the first line of the table, and the start of
 *  the era in which TAI−UTC is defined at all. */
export const kECLeapEraStart = -915235200;

/** The source file's own expiration (2027-06-28): past this instant the
 *  IERS has announced nothing, so neither can we. */
export const kECLeapTableValidUntil = 835833600;

/** Same instant as an ISO day, for messages and tests. */
export const kECLeapTableValidUntilISO = '2027-06-28';

/** TT − TAI, fixed by definition. */
export const kECTTMinusTAI = 32.184;

/**
 * The table, flattened to (Apple-epoch instant, TAI−UTC from that instant on)
 * pairs. Storing TAI−UTC directly rather than a cumulative leap count keeps
 * the accessor a plain lookup and would absorb a negative leap second without
 * any special case.
 */
const leapSecondTable: readonly number[] = [
    -915235200, 10,   // 1 Jan 1972
    -899510400, 11,   // 1 Jul 1972
    -883612800, 12,   // 1 Jan 1973
    -852076800, 13,   // 1 Jan 1974
    -820540800, 14,   // 1 Jan 1975
    -789004800, 15,   // 1 Jan 1976
    -757382400, 16,   // 1 Jan 1977
    -725846400, 17,   // 1 Jan 1978
    -694310400, 18,   // 1 Jan 1979
    -662774400, 19,   // 1 Jan 1980
    -615513600, 20,   // 1 Jul 1981
    -583977600, 21,   // 1 Jul 1982
    -552441600, 22,   // 1 Jul 1983
    -489283200, 23,   // 1 Jul 1985
    -410313600, 24,   // 1 Jan 1988
    -347155200, 25,   // 1 Jan 1990
    -315619200, 26,   // 1 Jan 1991
    -268358400, 27,   // 1 Jul 1992
    -236822400, 28,   // 1 Jul 1993
    -205286400, 29,   // 1 Jul 1994
    -157852800, 30,   // 1 Jan 1996
    -110592000, 31,   // 1 Jul 1997
     -63158400, 32,   // 1 Jan 1999
     157766400, 33,   // 1 Jan 2006
     252460800, 34,   // 1 Jan 2009
     362793600, 35,   // 1 Jul 2012
     457401600, 36,   // 1 Jul 2015
     504921600, 37,   // 1 Jan 2017
];

/** Number of rows in `leapSecondTable` (2 numbers apiece). */
export const kECLeapTableEntryCount = 28;

/** TAI−UTC at the end of the table, i.e. the value in force today. */
export const kECLeapTableFinalTAIMinusUTC = 37;

/** Last-entry cache: consecutive calls are almost always in the same era. */
let _cachedIndex = leapSecondTable.length - 2;

/**
 * TAI−UTC, in seconds, in force at `dateInterval` (Apple-epoch seconds).
 *
 * Values before the first entry clamp to it. UTC did not step by whole
 * seconds before 1972-01-01, and es-time.ts uses `kECLeapEraStart` to keep
 * the polynomial ΔT in charge of that era.
 */
export function taiMinusUTCForDateInterval(dateInterval: number): number {
    // Fast path: still inside the cached entry's span?
    const cached = _cachedIndex;
    if (dateInterval >= leapSecondTable[cached] &&
        (cached + 2 >= leapSecondTable.length || dateInterval < leapSecondTable[cached + 2])) {
        return leapSecondTable[cached + 1];
    }
    if (dateInterval < leapSecondTable[0]) {
        return leapSecondTable[1];
    }
    // Binary search over the entries for the last one at or before the date.
    let lo = 0;
    let hi = leapSecondTable.length / 2 - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (leapSecondTable[mid * 2] <= dateInterval) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    _cachedIndex = lo * 2;
    return leapSecondTable[lo * 2 + 1];
}

/**
 * TT − UTC, in seconds, at `dateInterval` — i.e. ΔT with UT taken as UTC.
 * Exact for any instant from 1972-01-01 through the table's expiry.
 */
export function ttMinusUTCForDateInterval(dateInterval: number): number {
    return kECTTMinusTAI + taiMinusUTCForDateInterval(dateInterval);
}

/** The raw table, for tests that audit it row by row. */
export function leapSecondTableEntries(): { dateInterval: number; taiMinusUTC: number }[] {
    const out: { dateInterval: number; taiMinusUTC: number }[] = [];
    for (let i = 0; i < leapSecondTable.length; i += 2) {
        out.push({ dateInterval: leapSecondTable[i], taiMinusUTC: leapSecondTable[i + 1] });
    }
    return out;
}
