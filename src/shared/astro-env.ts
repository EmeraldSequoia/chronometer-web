/**
 * Shared astronomy environment setup.
 *
 * Registers all astronomy, calendar, and time functions into an Environment.
 * This is the shared core used by both Chronometer's watch-env.ts and
 * other apps (Inspector, Observatory) that need astronomy calculations.
 *
 * Chronometer-specific functions (Terra slots, Kyoto wadokei, Venezia body
 * selector) are NOT included here — they remain in watch-env.ts.
 */

import {
    createDefaultEnvironment,
    type Environment,
} from '../expr/env.js';
import { compileExpr, type CompiledExpr } from '../expr/compile.js';
import { dateToDateInterval } from '../astronomy/es-time.js';
import {
    utcComponentsFromTimeInterval, localComponentsFromTimeInterval,
    daysInMonth as calendarDaysInMonth, kECJulianGregorianSwitchoverTimeInterval,
    timeIntervalFromUTCComponents, weekdayFromTimeInterval,
} from '../astronomy/es-calendar.js';
import {
    EC_UPDATE_NEXT_SUNRISE,
    EC_UPDATE_NEXT_SUNSET,
    EC_UPDATE_NEXT_MOONRISE,
    EC_UPDATE_NEXT_MOONSET,
    EC_UPDATE_NEXT_SUNRISE_OR_MIDNIGHT,
    EC_UPDATE_NEXT_SUNSET_OR_MIDNIGHT,
    EC_UPDATE_NEXT_MOONRISE_OR_MIDNIGHT,
    EC_UPDATE_NEXT_MOONSET_OR_MIDNIGHT,
    EC_UPDATE_ENV_CHANGE_ONLY,
    EC_UPDATE_NEXT_SUNRISE_OR_SUNSET,
    EC_UPDATE_NEXT_MOONRISE_OR_MOONSET,
} from './animation.js';
import {
    AstroCache, AstroCachePool, CacheSlot, initializeCachePool, releaseCachePool,
    cacheStats, invalidateCachePool, pushECAstroCacheInPool,
    popECAstroCacheToInPool,
} from '../astronomy/astro-cache.js';
import {
    sunAltitude, sunAzimuth, moonAltitude, moonAzimuth, moonAge,
    moonRelativePositionAngle, moonRelativeAngle as computeMoonRelativeAngle,
    moonElongation as computeMoonElongation,
    closestPhaseDayNumber, planetEclipticLongitude, planetEclipticLatitude,
    planetGeocentricDistance, planetTopocentricDistance,
    lunarAscendingNodeLongitude as computeLunarAscendingNode,
    EOTSeconds,
    calculateEclipse, EclipseKind,
    localSiderealTime,
    planetAltAz,
    positionAngle, northAngleForObject,
    sunSkyOrientationAngle,
} from '../astronomy/es-astro.js';
import {
    planetaryRiseSetTimeRefined, planettransitTimeRefined,
    riseSetForLocalDay, transitForLocalDay, type RiseSetResult,
} from '../astronomy/es-riseset.js';
import { ECPlanetNumber, ECWBPrecision, isNoRiseSet, isAlwaysAbove, fmod } from '../astronomy/astro-constants.js';
import { terminatorAngle } from '../watch/terminator.js';
import { GSTDifferenceForDate, convertUTToGSTP03, convertGSTtoLST } from '../astronomy/es-sidereal.js';
import { generalPrecessionSinceJ2000, sunRAandDecl, moonRAAndDecl, sunEclipticLongitudeForDate, raAndDeclO, generalObliquity, altitudeAtRiseSet } from '../astronomy/es-coordinates.js';
import { julianCenturiesSince2000EpochForDateInterval } from '../astronomy/es-time.js';
import { WB_planetHeliocentricLongitude, WB_planetHeliocentricLatitude, WB_planetHeliocentricRadius, WB_planetApparentPosition } from '../astronomy/willmann-bell.js';
import { WB_MoonAscendingNodeLongitude } from '../astronomy/wb-moon.js';
import { WB_nutationObliquity } from '../astronomy/wb-sun.js';

// Default observer location (San Jose, CA): used if geolocation unavailable
const DEFAULT_LAT_DEG = 37.205;    // degrees N
const DEFAULT_LON_DEG = -121.954;  // degrees (west is negative)

// DEL ring: delta-days run n ∈ [−DEL_DAY_OFFSET_MAX, +DEL_DAY_OFFSET_MAX] (one synodic
// month centered on today → 29 values). Sized to the dedicated CacheSlot.moonAgeAtDayOffset
// slab; values outside compute uncached. See astro-cache.ts and planning/...§5.
const DEL_DAY_OFFSET_MAX = 14;

let cachedBatteryLevel = 1.0;
let batteryInitialized = false;

function initBatteryState(): void {
    if (batteryInitialized) return;
    if (typeof navigator !== 'undefined' && 'getBattery' in navigator) {
        batteryInitialized = true;
        (navigator as any).getBattery().then((battery: any) => {
            cachedBatteryLevel = battery.level;
            battery.addEventListener('levelchange', () => {
                cachedBatteryLevel = battery.level;
            });
        }).catch(() => {
            // keep default 1.0
        });
    }
}

// Cache of Intl.DateTimeFormat instances keyed by IANA timezone. Constructing
// a formatter is the expensive part of an Intl call; formatToParts() on an
// existing one is cheap. One global cache serves every coexisting env.
const _tzFmtCache = new Map<string, Intl.DateTimeFormat>();

function tzFormatter(tz: string): Intl.DateTimeFormat {
    let fmt = _tzFmtCache.get(tz);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        _tzFmtCache.set(tz, fmt);
    }
    return fmt;
}

/** Uncached single offset lookup (one formatToParts). */
function rawTzOffsetSecondsAt(tz: string, utcMs: number): number {
    const parts = tzFormatter(tz).formatToParts(new Date(utcMs));
    const p: Record<string, number> = {};
    for (const part of parts) if (part.type !== 'literal') p[part.type] = +part.value;
    // h23 yields 00..23, but guard the midnight-as-24 quirk seen on some engines.
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
    // formatToParts truncates to whole seconds, so compare against the equally
    // truncated input — differencing against raw utcMs made the offset come out
    // 1s low whenever the sub-second fraction exceeded 500ms (and the per-tz
    // window memo then served that poisoned value for days of queries).
    return Math.round((asUTC - Math.floor(utcMs / 1000) * 1000) / 1000);
}

/**
 * Per-timezone memo of the constant-offset window around the last queried
 * instant. A tz's UTC offset is piecewise-constant in time — it changes only at
 * DST transitions — so once we know the offset holds across `[fromMs, untilMs)`,
 * any instant in that window is answered with no `formatToParts`. This recovers
 * the per-eval cost the per-instant conversion would otherwise add on every tick
 * (rise/set subdials, day/night ring) while staying *exact* across transitions —
 * unlike a per-day bucket, which is wrong on the two transition days.
 */
interface TzOffsetWindow { offsetSec: number; fromMs: number; untilMs: number; }
const _tzOffsetWindow = new Map<string, TzOffsetWindow>();

// Probe radii (ms), largest first. The largest must be smaller than the shortest
// real DST period, so that an unchanged offset at the probe proves the interval
// is transition-free: a round-trip offset→other→offset would need two
// transitions within 2·radius. ~10 days is safely under the shortest modern
// period (e.g. Morocco's ~month-long Ramadan DST suspension). Outside the modern
// tz-data range, Intl extrapolates a single constant rule (no transitions), so
// the widest probe always succeeds.
const _PROBE_RADII_MS = [10 * 86_400_000, 2 * 86_400_000, 6 * 3_600_000, 3_600_000];

// Farthest instant in direction `dir` (±1) provably still at `offsetSec`, probed
// at descending radii. Always returns at least utcMs ± 1ms so the window contains
// utcMs even when a transition is within the hour.
function extendTzWindow(tz: string, utcMs: number, offsetSec: number, dir: number): number {
    for (const r of _PROBE_RADII_MS) {
        if (rawTzOffsetSecondsAt(tz, utcMs + dir * r) === offsetSec) return utcMs + dir * r;
    }
    return utcMs + dir;
}

/**
 * Seconds east of UTC for the given IANA timezone AT the given instant.
 *
 * This is the web analog of iOS `ESCalendar_tzOffsetForTimeInterval(estz, dt)`
 * (.estime-ref/src/ESCalendar_Cocoa.mm): the offset is looked up *at the
 * instant being converted*, so it is correct on both sides of a DST transition.
 * It uses numeric `formatToParts` → `Date.UTC` (no fragile offset-string
 * parsing); handles fractional-hour zones (e.g. India +5:30) naturally. Results
 * are memoized by constant-offset window (see {@link _tzOffsetWindow}); the
 * returned value is identical to an uncached lookup.
 *
 * @param tz     IANA timezone (e.g. "America/New_York").
 * @param utcMs  Instant as epoch milliseconds.
 * @returns      Offset in seconds (positive east of UTC).
 */
export function tzOffsetSecondsAt(tz: string, utcMs: number): number {
    // Eval-ahead toward a non-finite ("never") boundary feeds Infinity/NaN here
    // (animation.ts returns Infinity for envChangeOnly / NaN rise-set sentinels;
    // withDisplayTime(Infinity) makes getNow() an Invalid Date → getTime() NaN).
    // formatToParts(new Date(NaN)) throws RangeError, so short-circuit. The value
    // is never displayed at "never", so any finite answer is fine; 0 is simplest.
    if (!Number.isFinite(utcMs)) return 0;
    const w = _tzOffsetWindow.get(tz);
    if (w !== undefined && utcMs >= w.fromMs && utcMs < w.untilMs) return w.offsetSec;
    const offsetSec = rawTzOffsetSecondsAt(tz, utcMs);
    _tzOffsetWindow.set(tz, {
        offsetSec,
        fromMs: extendTzWindow(tz, utcMs, offsetSec, -1),
        untilMs: extendTzWindow(tz, utcMs, offsetSec, +1),
    });
    return offsetSec;
}

/**
 * Compute the millisecond delta between a target IANA timezone and the
 * browser's local timezone.  Adding this delta to a Date's getTime()
 * makes getHours()/getMinutes()/etc. return values in the target timezone.
 *
 * @param olsonTimezone  IANA timezone (e.g. "Pacific/Honolulu"). If undefined
 *                       or empty, returns 0 (no shift).
 * @param referenceDate  Date used to determine DST state.  Defaults to now.
 * @returns              Milliseconds to add to shift from browser TZ to target TZ.
 */
export function computeTzDeltaMs(olsonTimezone: string | undefined, referenceDate?: Date): number {
    if (!olsonTimezone) return 0;
    const ref = referenceDate || new Date();
    const browserOffsetSec = -ref.getTimezoneOffset() * 60;
    let targetOffsetSec: number;
    try {
        targetOffsetSec = tzOffsetSecondsAt(olsonTimezone, ref.getTime());
    } catch {
        targetOffsetSec = browserOffsetSec;
    }
    return (targetOffsetSec - browserOffsetSec) * 1000;
}

/**
 * The timezone offset (seconds, east-positive) that {@link registerAstroFunctions}
 * captures on the env as `tzOffsetSec` for a given instant. This is the ONE piece
 * of time-dependent state baked into the env at build time (everything else is a
 * live closure over getNow()), so it is the sole thing that can go stale between
 * scrub ticks — a change here means a DST boundary was crossed and the env must be
 * rebuilt. Callers use it to decide whether a per-tick rebuild is actually needed.
 *
 * Note the browser offset cancels for a set timezone (tzDeltaMs already nets it
 * out), so the result equals the target zone's per-instant offset and is therefore
 * independent of the machine's own timezone.
 */
export function envTzOffsetSec(olsonTimezone: string | undefined, now: Date): number {
    const browserOffsetSec = -now.getTimezoneOffset() * 60;
    return browserOffsetSec + computeTzDeltaMs(olsonTimezone, now) / 1000;
}

/**
 * Is an env's captured timezone state stale for its current display time?
 *
 * An env bakes in exactly two time-dependent scalars at build time (see
 * {@link registerAstroFunctions}): `tzOffsetSec` (the target zone's offset,
 * which changes at TARGET-zone DST boundaries) and `tzDeltaMs` (the
 * browser→target delta, which ALSO changes at the BROWSER zone's DST
 * boundaries — even when the target zone observes no DST at all). A rebuild
 * is needed iff either differs from what a fresh build would capture now.
 *
 * The check reads the env's own (quantized) getNow — the exact source the
 * captured values came from — so both sides of the comparison see the same
 * instant.
 *
 * This is the per-tick rebuild guard's predicate: when it returns false, the
 * env is byte-equivalent to a fresh build (given an invalidated astro cache
 * pool), so the expensive rebuild can be skipped.
 */
export function envTzStateStale(env: Environment, olsonTimezone: string | undefined): boolean {
    const now = (env.getNow ?? (() => new Date()))();
    const deltaMs = computeTzDeltaMs(olsonTimezone, now);
    const browserOffsetSec = -now.getTimezoneOffset() * 60;
    return env.tzOffsetSec !== browserOffsetSec + deltaMs / 1000
        || env.tzDeltaMs !== deltaMs;
}

/**
 * Compile-and-memo cache for attribute/color expressions evaluated on the render
 * pass. A {@link CompiledExpr} is env-independent (it resolves names from the env
 * passed at call time), so one global cache keyed by source string serves every
 * coexisting env (e.g. the ~16 faces on `all.html`) — each call supplies its own
 * env, so there is no cross-face leakage.
 */
const exprCache = new Map<string, CompiledExpr>();

function compiledFor(src: string): CompiledExpr {
    let fn = exprCache.get(src);
    if (!fn) {
        fn = compileExpr(src);
        exprCache.set(src, fn);
    }
    return fn;
}

/**
 * Evaluate a single attribute expression in the given env.
 * Returns 0 for undefined/empty expressions.
 */
export function evalAttr(expr: string | undefined, env: Environment): number {
    if (!expr) return 0;
    return compiledFor(expr)(env);
}

/**
 * Evaluate a color expression and return a CSS color string.
 * The XML uses 0xAARRGGBB format (matching iOS UIColor).
 */
export function evalColor(expr: string | undefined, env: Environment): string {
    if (!expr) return 'rgba(0,0,0,0)';
    return argbToCSS(compiledFor(expr)(env));
}

/**
 * Convert an ARGB integer (0xAARRGGBB) to a CSS rgba() string.
 */
function argbToCSS(argb: number): string {
    const v = argb >>> 0;  // treat as unsigned 32-bit
    const a = ((v >>> 24) & 0xFF) / 255;
    const r = (v >>> 16) & 0xFF;
    const g = (v >>> 8) & 0xFF;
    const b = v & 0xFF;
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}


// ============================================================================
// AstroInternals — returned to callers who need to extend the environment
// ============================================================================

/**
 * Internal state from registerAstroFunctions, exposed so Chronometer's
 * watch-env.ts can add Terra/Kyoto/Venezia-specific functions that need
 * access to the timezone delta, cache pool, etc.
 */
export interface AstroInternals {
    pool: AstroCachePool;
    tzDeltaMs: number;
    tzOffsetSeconds: number;
}

// ============================================================================
// createAstroEnvironment — shared environment factory for all apps
// ============================================================================

/**
 * Create an expression environment populated with all astronomy, calendar,
 * and time functions. This is the shared core that Inspector, Observatory,
 * and Chronometer all use.
 *
 * Does NOT include:
 * - Watch-specific init block evaluation (needs Watch model)
 * - Terra world-time ring functions
 * - Kyoto wadokei / Venezia body selector
 * - Vienna noon-on-top toggle
 *
 * @param observerLatDeg Observer latitude in degrees (positive = north)
 * @param observerLonDeg Observer longitude in degrees (negative = west)
 * @param getNow Time source function
 * @param olsonTimezone IANA timezone override (e.g. 'America/New_York')
 * @returns The populated Environment
 */
export function createAstroEnvironment(
    observerLatDeg: number = DEFAULT_LAT_DEG,
    observerLonDeg: number = DEFAULT_LON_DEG,
    getNow: () => Date = () => new Date(),
    olsonTimezone?: string,
): Environment {
    const OBSERVER_LAT = observerLatDeg * Math.PI / 180;
    const OBSERVER_LON = observerLonDeg * Math.PI / 180;
    initBatteryState();
    const env = createDefaultEnvironment();

    // Store observer params on the env for sentinel scheduling (animation.ts)
    // and display-time source for renderer caches.
    env.observerLatRad = OBSERVER_LAT;
    env.observerLonRad = OBSERVER_LON;
    env.getNow = getNow;

    // Named update interval sentinels — negative values matching iOS ECConstants.h.
    // The animation system detects these and schedules at the appropriate event time.
    env.variables.set('updateAtNextSunrise', EC_UPDATE_NEXT_SUNRISE);
    env.variables.set('updateAtNextSunset', EC_UPDATE_NEXT_SUNSET);
    env.variables.set('updateAtNextMoonrise', EC_UPDATE_NEXT_MOONRISE);
    env.variables.set('updateAtNextMoonset', EC_UPDATE_NEXT_MOONSET);
    env.variables.set('updateAtNextSunriseOrMidnight', EC_UPDATE_NEXT_SUNRISE_OR_MIDNIGHT);
    env.variables.set('updateAtNextSunsetOrMidnight', EC_UPDATE_NEXT_SUNSET_OR_MIDNIGHT);
    env.variables.set('updateAtNextMoonriseOrMidnight', EC_UPDATE_NEXT_MOONRISE_OR_MIDNIGHT);
    env.variables.set('updateAtNextMoonsetOrMidnight', EC_UPDATE_NEXT_MOONSET_OR_MIDNIGHT);
    env.variables.set('updateAtEnvChangeOnly', EC_UPDATE_ENV_CHANGE_ONLY);
    env.variables.set('updateAtNextSunriseOrSunset', EC_UPDATE_NEXT_SUNRISE_OR_SUNSET);
    env.variables.set('updateAtNextMoonriseOrMoonset', EC_UPDATE_NEXT_MOONRISE_OR_MOONSET);

    // Aliases used by some faces
    env.variables.set('updateForTimeSyncIndicator', EC_UPDATE_ENV_CHANGE_ONLY);
    env.variables.set('updateForLocSyncIndicator', EC_UPDATE_ENV_CHANGE_ONLY);

    // Planet constants used in XML expressions
    env.variables.set('planetSun', ECPlanetNumber.Sun);
    env.variables.set('planetMoon', ECPlanetNumber.Moon);
    env.variables.set('planetMercury', ECPlanetNumber.Mercury);
    env.variables.set('planetVenus', ECPlanetNumber.Venus);
    env.variables.set('planetEarth', ECPlanetNumber.Earth);
    env.variables.set('planetMars', ECPlanetNumber.Mars);
    env.variables.set('planetJupiter', ECPlanetNumber.Jupiter);
    env.variables.set('planetSaturn', ECPlanetNumber.Saturn);
    env.variables.set('planetUranus', ECPlanetNumber.Uranus);
    env.variables.set('planetNeptune', ECPlanetNumber.Neptune);
    env.variables.set('planetMidnightSun', ECPlanetNumber.MidnightSun);

    env.variables.set('topAnchorClockNoon', 0);
    env.variables.set('topAnchorClockMidnight', 1);
    env.variables.set('topAnchorSolarNoon', 2);
    env.variables.set('topAnchorSolarMidnight', 3);

    // Register the shared functions
    const internals = registerAstroFunctions(env, OBSERVER_LAT, OBSERVER_LON, getNow, olsonTimezone);

    // Release the cache pool (callers who need it should use registerAstroFunctions directly)
    releaseCachePool(internals.pool);

    return env;
}

/**
 * Register all shared astronomy, calendar, and time functions into an
 * existing Environment. Returns internal state needed by Chronometer's
 * watch-env.ts to add Terra/Kyoto-specific functions.
 *
 * The caller is responsible for calling releaseCachePool(internals.pool)
 * when done with the returned internals.
 *
 * Cache re-keying is exact-match (no slop): any change of the display time
 * between pushes invalidates the pool's slots, so a value evaluated at time t
 * always uses astronomy computed for exactly t. Cross-part sharing relies on
 * same-group evaluations pushing bit-identical dateIntervals (frozen frame
 * time / shared epoch-aligned boundaries), not on a tolerance. See
 * planning/2026-08-22-astro-slop-zero.md.
 */
export function registerAstroFunctions(
    env: Environment,
    OBSERVER_LAT: number,
    OBSERVER_LON: number,
    getNow: () => Date = () => new Date(),
    olsonTimezone?: string,
): AstroInternals {
    const { functions } = env;

    const now = getNow();
    const dateInterval = dateToDateInterval(now);

    // Timezone offset delta in milliseconds: adding this to a Date's getTime()
    // makes getHours()/getMinutes()/getSeconds() return target-timezone values.
    const tzDeltaMs = computeTzDeltaMs(olsonTimezone, now);

    // Timezone offset in seconds (east-positive) for calendar/astronomy. Computed
    // via the shared helper so the per-tick rebuild guard (envTzStateStale, which
    // compares against env.tzOffsetSec/env.tzDeltaMs to detect DST crossings) can
    // never diverge from these formulas.
    const tzOffsetSeconds = envTzOffsetSec(olsonTimezone, now);
    env.tzOffsetSec = tzOffsetSeconds;
    env.tzDeltaMs = tzDeltaMs;

    // --- Clock hands (LIVE — recompute from Date.now() on each call) ---
    // These are called every animation frame so the hands move in real time.

    // Helper: return a Date shifted to the target timezone for display.
    // getHours/getMinutes/getSeconds on the result give target-tz values.
    // NOTE: this conflates the BROWSER's DST schedule into the reading (getHours
    // applies the browser offset at the *shifted* instant). It is retained only
    // for "current date" callers (year/month/day at now), where the conflation
    // is harmless. Wall-clock readouts that must be browser-DST-immune use
    // targetLocalDate() (per-instant) or the captured tzOffsetSeconds (liveTime).
    const liveDate = (): Date => {
        const raw = getNow();
        return tzDeltaMs !== 0 ? new Date(raw.getTime() + tzDeltaMs) : raw;
    };

    // Per-instant target-timezone wall clock: the returned Date's getUTC*
    // components equal the local wall-clock at `utcMs` in olsonTimezone (or the
    // browser timezone if unset). Web analog of iOS
    // ESCalendar_localComponentsFromTimeInterval — the offset is resolved AT the
    // instant, so it is correct across DST transitions and independent of the
    // browser's own DST schedule. Read components with getUTCHours()/etc.
    const targetLocalDate = (utcMs: number): Date => {
        const offMs = olsonTimezone
            ? tzOffsetSecondsAt(olsonTimezone, utcMs) * 1000
            : -new Date(utcMs).getTimezoneOffset() * 60000;
        return new Date(utcMs + offMs);
    };

    // Helper to extract fractional components from the current time, in the
    // target timezone.
    const liveTime = () => {
        if (tzDeltaMs === 0) {
            // Target tz == browser tz (the home-watch case): the browser-local
            // getters already give target-local time, and getHours() is itself
            // per-instant. Fast path — skips the shifted-Date construction.
            const t = getNow();
            const s = t.getSeconds() + t.getMilliseconds() / 1000;
            const m = t.getMinutes() + s / 60;
            return { h: (t.getHours() % 12) + m / 60, m, s, h24: t.getHours() };
        }
        // Different tz: shift by the captured target offset (kept current by the
        // per-transition env rebuild) and read UTC components, so a browser DST
        // transition can no longer shift a target-timezone hand (Bug 2).
        const t = new Date(getNow().getTime() + tzOffsetSeconds * 1000);
        const s = t.getUTCSeconds() + t.getUTCMilliseconds() / 1000;
        const m = t.getUTCMinutes() + s / 60;
        return { h: (t.getUTCHours() % 12) + m / 60, m, s, h24: t.getUTCHours() };
    };

    functions.set('hour12ValueAngle', () => liveTime().h * 2 * Math.PI / 12);
    functions.set('minuteValueAngle', () => liveTime().m * 2 * Math.PI / 60);
    functions.set('secondValueAngle', () => liveTime().s * 2 * Math.PI / 60);
    functions.set('secondNumberAngle', () => Math.floor(liveTime().s) * 2 * Math.PI / 60);
    functions.set('secondValue', () => liveTime().s);
    functions.set('hour24Number', () => liveTime().h24);
    // minuteNumber: integer minute (0–59). Discrete counterpart to minuteValue
    // (which is the fractional minute used for continuous hands).
    functions.set('minuteNumber', () => Math.floor(liveTime().m));
    // hour24Value: 24-hour time as continuous float (e.g. 14.5 = 2:30 PM)
    // t.m already includes seconds/60, so t.h24 + t.m/60 gives the full fractional hour.
    functions.set('hour24Value', () => {
        const t = liveTime();
        return t.h24 + t.m / 60;
    });
    // hour24ValueAngle: 24-hour time as angle (2π/24 per hour)
    functions.set('hour24ValueAngle', () => {
        const t = liveTime();
        return (t.h24 + t.m / 60) * 2 * Math.PI / 24;
    });
    // tzOffsetAngle: local timezone UTC offset as angle on 24-hour dial
    functions.set('tzOffsetAngle', () => {
        return tzOffsetSeconds * Math.PI / (3600 * 12);
    });

    // --- Calendar (LIVE — uses hybrid Julian/Gregorian calendar) ---
    // Helper: get local calendar components using the hybrid calendar system.
    // This correctly handles the Julian/Gregorian switchover at Oct 15, 1582
    // and BCE dates with proleptic Julian calendar.
    const getLocalComponents = () => {
        const di = dateToDateInterval(getNow());
        return localComponentsFromTimeInterval(di, tzOffsetSeconds);
    };

    functions.set('dayNumber', () => getLocalComponents().day - 1);  // 0-indexed for wheel math
    functions.set('dayNumberAngle', () => {
        const cs = getLocalComponents();
        return (cs.day - 1) * 2 * Math.PI / 31;
    });
    functions.set('monthNumber', () => getLocalComponents().month - 1);  // 0-indexed to match JS convention
    functions.set('monthNumberAngle', () => (getLocalComponents().month - 1) * 2 * Math.PI / 12);
    functions.set('weekdayNumberAngle', () => {
        const di = dateToDateInterval(getNow());
        return weekdayFromTimeInterval(di, tzOffsetSeconds) * 2 * Math.PI / 7;
    });
    functions.set('weekdayNumber', () => {
        const di = dateToDateInterval(getNow());
        return weekdayFromTimeInterval(di, tzOffsetSeconds);
    });
    functions.set('yearNumber', () => {
        const cs = getLocalComponents();
        return cs.year;  // Always positive; era is from eraNumber()
    });
    functions.set('eraNumber', () => getLocalComponents().era);

    // --- Geneva I calendar functions ---
    functions.set('GregorianEra', () => {
        const di = dateToDateInterval(getNow());
        return di > kECJulianGregorianSwitchoverTimeInterval ? 1 : 0;
    });
    functions.set('DSTNumber', () => {
        const now = getNow();
        if (olsonTimezone) {
            // iOS ESCalendar_isDSTAtTimeInterval(estz, t): DST is active when the
            // target's OWN UTC offset at the instant exceeds its standard offset.
            // (Comparing the browser->target delta was wrong: when the browser
            // shares the target's DST schedule the delta is constant year-round,
            // so the indicator never lit. Fixed by isolating the target offset.)
            // Standard offset = the smaller of the Jan/Jul offsets (works in both
            // hemispheres).
            const t = now.getTime();
            const yr = targetLocalDate(t).getUTCFullYear();
            const janOff = tzOffsetSecondsAt(olsonTimezone, Date.UTC(yr, 0, 1, 12));
            const julOff = tzOffsetSecondsAt(olsonTimezone, Date.UTC(yr, 6, 1, 12));
            return tzOffsetSecondsAt(olsonTimezone, t) > Math.min(janOff, julOff) ? 1 : 0;
        }
        // Browser timezone: compare January offset to current offset
        const jan = new Date(now.getFullYear(), 0, 1);
        const jul = new Date(now.getFullYear(), 6, 1);
        const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
        return now.getTimezoneOffset() < stdOffset ? 1 : 0;
    });
    functions.set('monthLen', () => {
        const cs = getLocalComponents();
        return calendarDaysInMonth(cs.era, cs.year, cs.month);
    });
    functions.set('yearNumberCEMonotonic', () => {
        // Continuous year numbering: 2 BCE=−1, 1 BCE=0, 1 CE=1, 2 CE=2, ...
        const cs = getLocalComponents();
        return cs.era === 0 ? 1 - cs.year : cs.year;
    });
    functions.set('leapYearIndicatorAngle', () => {
        // Ported from ECVirtualMachineOps.m line 4159
        const cs = getLocalComponents();
        const yearNumber = cs.year;
        const eraNumber = cs.era;
        if (eraNumber && yearNumber >= 1582) {
            // Gregorian: accounts for 100/400 year exceptions
            return Math.PI + (yearNumber % 400 === 0 ? 3 * Math.PI / 4
                : yearNumber % 100 === 0 ? 5 * Math.PI / 4
                : yearNumber % 4 === 0 ? Math.PI / 4
                : ((yearNumber % 4) * 2 + 17) * Math.PI / 12);
        } else if (eraNumber) {
            // Julian CE
            return Math.PI + (yearNumber % 4 === 0 ? Math.PI / 4
                : ((yearNumber % 4) * 2 + 17) * Math.PI / 12);
        } else {
            // Proleptic Julian BCE (leap years on 1 BCE, 5 BCE, etc.)
            const adjustedYear = yearNumber - 1;
            return Math.PI + (adjustedYear % 4 === 0 ? Math.PI / 4
                : ((adjustedYear % 4) * 2 + 17) * Math.PI / 12);
        }
    });
    functions.set('season', () => {
        // Ported from ECVirtualMachineOps.m line 2367
        // 0=spring, 1=summer, 2=fall, 3=winter
        const north = OBSERVER_LAT >= 0;  // equator counts as north
        const sunLong = liveAstro((cache, di) => planetEclipticLongitude(ECPlanetNumber.Sun, di, cache));
        if (sunLong > Math.PI * 3 / 2) return north ? 3 : 1;      // winter/summer
        else if (sunLong > Math.PI) return north ? 2 : 0;          // fall/spring
        else if (sunLong > Math.PI / 2) return north ? 1 : 3;      // summer/winter
        else return north ? 0 : 2;                                  // spring/fall
    });
    functions.set('offsetOfWinterSolsticeFromDec31Midnight', () => {
        // Ported from ECVirtualMachineOps.m line 1858
        // calendarErrorVsTropicalYear = sunLong(sameDay2001) - sunLong(today)
        const di = dateToDateInterval(getNow());
        // Today's sun longitude shares the display-time cache; the year-2001 reference
        // is at an OFFSET time (thisDay2001) so it stays null — routing it would clobber
        // the display-time sunEclipticLongitude slot.
        const todaysLongitude = liveAstro((cache) => planetEclipticLongitude(ECPlanetNumber.Sun, di, cache));

        // Get the same month/day but in year 2001 (Gregorian reference)
        const cs = utcComponentsFromTimeInterval(di);
        const thisDay2001 = timeIntervalFromUTCComponents(1, 2001, cs.month, cs.day, cs.hour, cs.minute, cs.seconds);
        const year2001Longitude = planetEclipticLongitude(ECPlanetNumber.Sun, thisDay2001, null);

        const calendarError = year2001Longitude - todaysLongitude;

        // North/south hemisphere offset
        const northSouthOffset = OBSERVER_LAT >= 0 ? 0 : Math.PI;

        // Subtract 10.25/365.25 * 2π to move winter solstice back to ~Dec 21
        return calendarError - 10.25 / 365.25 * 2 * Math.PI + northSouthOffset;
    });

    // Note: hour24ValueAngle, hour24Value, and hour24Number are registered
    // above via liveTime() which already uses the timezone-shifted date.

    // Time-unit helpers (return value in seconds, matching iOS convention for update intervals)
    functions.set('years', () => 365.25 * 86400);
    functions.set('weeks', () => 7 * 86400);
    functions.set('days', () => 86400);
    functions.set('hours', () => 3600);
    functions.set('minutes', () => 60);
    functions.set('seconds', () => 1);

    // --- Astronomy setup (snapshot for rise/set, which are daily values) ---
    const pool = new AstroCachePool();
    initializeCachePool(pool, dateInterval, OBSERVER_LAT, OBSERVER_LON, false, tzOffsetSeconds);

    // Expose O(1) pool invalidation so the per-tick rebuild guard can skip the
    // full env rebuild (offset unchanged) while still guaranteeing this tick's
    // astronomy is computed fresh — identical semantics to the fresh pool a
    // rebuild would have created.
    env.invalidateAstroCaches = () => invalidateCachePool(pool);

    /**
     * Stage 2b: route a LIVE display-time astronomy call through `pool.finalCache`,
     * keyed at the current display time, instead of passing `null`. Within a sorted
     * leaf group (one display time — see Updater's `byEvalTimeClass`) every caller then
     * shares the underlying position slots: e.g. moonAltitude + moonAzimuth + moonAge
     * compute the lunar series (`moonRAAndDecl`, ~13µs) ONCE and reuse it. The push
     * re-keys (invalidates) `finalCache` only when the display time changes between
     * groups; the Stage-2a sort keeps same-time values contiguous, so it doesn't thrash.
     * Mirrors `getMasterRiseSet`'s push/pop, and coexists with its `dayNightMaster*`
     * slots (disjoint slots, same di within a group). Observer location only — per-slot
     * (`envSlot`) rings go through `getMasterRiseSet`'s location guard, not these.
     * See planning/2026-06-28-per-tick-astronomy-memoization.md §4b.
     */
    function liveAstro<T>(compute: (cache: AstroCache, di: number) => T): T {
        const di = dateToDateInterval(getNow());
        const cache = pool.finalCache;
        const prior = pushECAstroCacheInPool(pool, cache, di);
        const r = compute(cache, di);
        popECAstroCacheToInPool(pool, prior);
        return r;
    }

    // --- Sun position (LIVE — recompute each call) ---
    // Sun altitude and azimuth change continuously throughout the day.
    functions.set('sunAltitude', () =>
        liveAstro((cache, di) => sunAltitude(di, OBSERVER_LAT, OBSERVER_LON, cache)));
    functions.set('sunAzimuth', () =>
        liveAstro((cache, di) => sunAzimuth(di, OBSERVER_LAT, OBSERVER_LON, cache)));
    functions.set('sunSkyOrientationAngle', () =>
        liveAstro((cache, di) => sunSkyOrientationAngle(di, OBSERVER_LAT, OBSERVER_LON, cache)));

    // --- Rise/set "for day" helpers ---
    // iOS planetRiseSetForDay: search forward then backward, only accept
    // results on the current calendar day.  Return NaN if no event today.
    // Find the rise/set of a body for the user's local calendar day. The search +
    // forward/backward + same-day selection + result memoization live in es-riseset's
    // riseSetForLocalDay (slot-cached per display time, replacing the old tickMemo). The
    // env supplies the two civil-calendar inputs the astronomy layer can't know: the
    // LOCAL-noon search seed (browser-Date, DST-aware) and the same-local-day predicate.
    function riseSetForDay(
        riseNotSet: boolean,
        planetNumber: ECPlanetNumber,
    ): number {
        return liveAstro((_cache, calcDate) => {
            // LOCAL noon of the user's calendar day (local time, not UT, so it agrees
            // with isSameLocalDay). Both sunrise (~6h before) and sunset (~6h after) are
            // within the solver's convergence radius from local noon.
            const ld = liveDate();  // timezone-shifted date
            const localNoon = new Date(ld.getFullYear(), ld.getMonth(), ld.getDate(), 12, 0, 0);
            const noonDI = dateToDateInterval(new Date(localNoon.getTime() - tzDeltaMs));
            return riseSetForLocalDay(
                noonDI, OBSERVER_LAT, OBSERVER_LON, riseNotSet, planetNumber, pool,
                (eventDI) => isSameLocalDay(eventDI, calcDate),
            );
        });
    }

    /** Check if two date intervals fall on the same local calendar day (in the target timezone) */
    function isSameLocalDay(di1: number, di2: number): boolean {
        // Per-instant offset for each: di1/di2 may straddle a DST transition, so a
        // single captured offset could misclassify them (and pick the wrong event).
        const d1 = targetLocalDate((di1 + 978307200) * 1000);
        const d2 = targetLocalDate((di2 + 978307200) * 1000);
        return d1.getUTCFullYear() === d2.getUTCFullYear()
            && d1.getUTCMonth() === d2.getUTCMonth()
            && d1.getUTCDate() === d2.getUTCDate();
    }

    /** Convert a dateInterval rise/set result into hour12/minute/hour24 values (in target timezone) */
    function riseSetAngles(di: number): { hour12: number; minute: number; hour24: number } {
        // Per-instant offset: the event may be on a different DST side than "now"
        // (e.g. a sunrise after a transition viewed before it), so use the offset
        // AT the event, not the captured tzDeltaMs.
        const d = targetLocalDate((di + 978307200) * 1000);
        const h = d.getUTCHours(), m = d.getUTCMinutes(), s = d.getUTCSeconds();
        return {
            hour12: (h % 12) + m / 60 + s / 3600,
            minute: m + s / 60,
            hour24: h,
        };
    }

    // --- Sunrise/sunset for today (LIVE — recompute on call) ---
    functions.set('sunriseForDayValid', () => {
        return isNaN(riseSetForDay(true, ECPlanetNumber.Sun)) ? 0 : 1;
    });
    functions.set('sunriseForDayHour12ValueAngle', () => {
        const sr = riseSetForDay(true, ECPlanetNumber.Sun);
        return isNaN(sr) ? 0 : riseSetAngles(sr).hour12 * 2 * Math.PI / 12;
    });
    functions.set('sunriseForDayMinuteValueAngle', () => {
        const sr = riseSetForDay(true, ECPlanetNumber.Sun);
        return isNaN(sr) ? 0 : riseSetAngles(sr).minute * 2 * Math.PI / 60;
    });

    functions.set('sunsetForDayValid', () => {
        return isNaN(riseSetForDay(false, ECPlanetNumber.Sun)) ? 0 : 1;
    });
    functions.set('sunsetForDayHour12ValueAngle', () => {
        const ss = riseSetForDay(false, ECPlanetNumber.Sun);
        return isNaN(ss) ? 0 : riseSetAngles(ss).hour12 * 2 * Math.PI / 12;
    });
    functions.set('sunsetForDayMinuteValueAngle', () => {
        const ss = riseSetForDay(false, ECPlanetNumber.Sun);
        return isNaN(ss) ? 0 : riseSetAngles(ss).minute * 2 * Math.PI / 60;
    });

    // --- Moon (LIVE — recompute each call) ---
    functions.set('moonAltitude', () =>
        liveAstro((cache, di) => moonAltitude(di, OBSERVER_LAT, OBSERVER_LON, cache)));
    functions.set('moonAzimuth', () =>
        liveAstro((cache, di) => moonAzimuth(di, OBSERVER_LAT, OBSERVER_LON, cache)));
    functions.set('moonAgeAngle', () =>
        liveAstro((cache, di) => moonAge(di, cache).age));
    functions.set('moonRelativePositionAngle', () =>
        liveAstro((cache, di) => moonRelativePositionAngle(di, OBSERVER_LAT, OBSERVER_LON, cache)));
    functions.set('moonRelativeAngle', () =>
        liveAstro((cache, di) => computeMoonRelativeAngle(di, OBSERVER_LAT, OBSERVER_LON, cache)));
    // realMoonAgeAngle: actual elapsed days since last new moon (not radians).
    // iOS: finds nearest new moon and returns (now - newMoon) / 86400.
    // Simplified: use moonAge (radians) * lunarCycle / 2π.
    functions.set('realMoonAgeAngle', () =>
        liveAstro((cache, di) => {
            const ageRadians = moonAge(di, cache).age;
            const kECLunarCycleInDays = 29.530588;
            return ageRadians / (2 * Math.PI) * kECLunarCycleInDays;
        }));

    // --- Moon elongation (angular separation Sun–Moon) ---
    functions.set('moonElongation', () =>
        liveAstro((cache, di) => computeMoonElongation(di, OBSERVER_LAT, OBSERVER_LON, cache)));

    // --- Closest phase quarter day numbers (LIVE — recompute from getNow()) ---
    // Closest-phase day numbers run a phase search (~75µs); memoize the result in its
    // dedicated slot per display time so repeated references share one search.
    const closestPhaseSlotted = (slot: CacheSlot, targetPhase: number): number =>
        liveAstro((cache, di) => {
            if (cache.isValid(slot)) return cache.get(slot);
            const v = closestPhaseDayNumber(targetPhase, di);
            cache.set(slot, v);
            return v;
        });
    functions.set('closestNewMoonDayNumber', () =>
        closestPhaseSlotted(CacheSlot.closestNewMoon, 0) - 1);
    functions.set('closestFirstQuarterDayNumber', () =>
        closestPhaseSlotted(CacheSlot.closestFirstQuarter, Math.PI / 2) - 1);
    functions.set('closestFullMoonDayNumber', () =>
        closestPhaseSlotted(CacheSlot.closestFullMoon, Math.PI) - 1);
    functions.set('closestThirdQuarterDayNumber', () =>
        closestPhaseSlotted(CacheSlot.closestThirdQuarter, 3 * Math.PI / 2) - 1);

    // --- Planetary ecliptic coordinates ---
    // ELongitudeOfPlanet(n): geocentric apparent ecliptic longitude (radians)
    functions.set('ELongitudeOfPlanet', (n: number) =>
        liveAstro((cache, di) => planetEclipticLongitude(n as ECPlanetNumber, di, cache)));
    // HLongitudeOfPlanet(n): heliocentric longitude (radians)
    // Used by Firenze's orrery to position planets on their orbits.
    // (WB_planetHeliocentricLongitude takes no cache; routing shares only julianCenturies.)
    functions.set('HLongitudeOfPlanet', (n: number) =>
        liveAstro((cache, di) => {
            const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, cache);
            return WB_planetHeliocentricLongitude(n as ECPlanetNumber, julianCenturiesSince2000Epoch / 100);
        }));
    // ELatitudeOfPlanet(n): geocentric apparent ecliptic latitude (radians)
    functions.set('ELatitudeOfPlanet', (n: number) =>
        liveAstro((cache, di) => planetEclipticLatitude(n as ECPlanetNumber, di, cache)));
    // distanceFromEarthOfPlanet(n): geocentric distance in AU
    functions.set('distanceFromEarthOfPlanet', (n: number) =>
        liveAstro((cache, di) => planetGeocentricDistance(n as ECPlanetNumber, di, cache)));
    // distanceFromObserverOfPlanet(n): topocentric distance in AU — the same
    // distance measured from the observer instead of the Earth's centre. Use it
    // when the value drives an apparent *size*: the Moon is up to 1.7% nearer
    // overhead, which is the total/annular margin of a solar eclipse.
    functions.set('distanceFromObserverOfPlanet', (n: number) =>
        liveAstro((cache, di) =>
            planetTopocentricDistance(n as ECPlanetNumber, di, OBSERVER_LAT, OBSERVER_LON, cache)));
    // distanceFromSunOfPlanet(n): heliocentric distance (orbital radius) in AU.
    // Companion to distanceFromEarthOfPlanet; same WB series as HLongitude/HLatitude.
    functions.set('distanceFromSunOfPlanet', (n: number) =>
        liveAstro((cache, di) => {
            const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, cache);
            return WB_planetHeliocentricRadius(n as ECPlanetNumber, julianCenturiesSince2000Epoch / 100, cache);
        }));

    // --- Planet azimuth / altitude / RA (Venezia) ---
    // azimuthOfPlanet(body): topocentric azimuth (radians)
    functions.set('azimuthOfPlanet', (planetNumber: number) =>
        liveAstro((cache, di) => {
            if (planetNumber === ECPlanetNumber.Sun) return sunAzimuth(di, OBSERVER_LAT, OBSERVER_LON, cache);
            if (planetNumber === ECPlanetNumber.Moon) return moonAzimuth(di, OBSERVER_LAT, OBSERVER_LON, cache);
            return planetAltAz(planetNumber, di, OBSERVER_LAT, OBSERVER_LON, true, false, cache);
        }));
    // altitudeOfPlanet(body): topocentric altitude (radians)
    functions.set('altitudeOfPlanet', (planetNumber: number) =>
        liveAstro((cache, di) => {
            if (planetNumber === ECPlanetNumber.Sun) return sunAltitude(di, OBSERVER_LAT, OBSERVER_LON, cache);
            if (planetNumber === ECPlanetNumber.Moon) return moonAltitude(di, OBSERVER_LAT, OBSERVER_LON, cache);
            return planetAltAz(planetNumber, di, OBSERVER_LAT, OBSERVER_LON, true, true, cache);
        }));
    // RAOfPlanet(body): right ascension (radians)
    functions.set('RAOfPlanet', (planetNumber: number) =>
        liveAstro((cache, di) => {
            if (planetNumber === ECPlanetNumber.Sun) return sunRAandDecl(di, cache).rightAscension;
            if (planetNumber === ECPlanetNumber.Moon) return moonRAAndDecl(di, cache).rightAscension;
            const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, cache);
            const pos = WB_planetApparentPosition(planetNumber as ECPlanetNumber, julianCenturiesSince2000Epoch / 100);
            return pos.apparentRightAscension;
        }));
    // declinationOfPlanet(body): geocentric apparent declination (radians).
    // Mirrors RAOfPlanet's Sun/Moon special-casing.
    functions.set('declinationOfPlanet', (planetNumber: number) =>
        liveAstro((cache, di) => {
            if (planetNumber === ECPlanetNumber.Sun) return sunRAandDecl(di, cache).declination;
            if (planetNumber === ECPlanetNumber.Moon) return moonRAAndDecl(di, cache).declination;
            const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, cache);
            const pos = WB_planetApparentPosition(planetNumber as ECPlanetNumber, julianCenturiesSince2000Epoch / 100);
            return pos.apparentDeclination;
        }));
    // HLatitudeOfPlanet(n): heliocentric latitude (radians). Companion to
    // HLongitudeOfPlanet.
    functions.set('HLatitudeOfPlanet', (n: number) =>
        liveAstro((cache, di) => {
            const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, cache);
            return WB_planetHeliocentricLatitude(n as ECPlanetNumber, julianCenturiesSince2000Epoch / 100);
        }));

    // --- Planet rise/transit/set for day (Venezia) ---
    // Helper: find transit of any planet for the current day (memoized per tick
    // in the transit forDay slot — shared by all transit subdial values).
    // Transit for the local calendar day — see riseSetForDay. The search + selection +
    // slot memoization live in es-riseset's transitForLocalDay; the env supplies the
    // local-noon seed (UTC arithmetic via tzOffsetSeconds) and the same-day predicate.
    function transitForDay(planetNumber: ECPlanetNumber): number {
        return liveAstro((_cache, di) => {
            const utcNowSec = di + 978307200;
            const localNowSec = utcNowSec + tzOffsetSeconds;
            const localDayStartSec = localNowSec - ((localNowSec % 86400) + 86400) % 86400;
            const noonDI = localDayStartSec + 12 * 3600 - tzOffsetSeconds - 978307200;
            return transitForLocalDay(
                noonDI, OBSERVER_LAT, OBSERVER_LON, planetNumber, pool,
                (eventDI) => isSameLocalDay(eventDI, di),
            );
        });
    }

    // riseOfPlanetForDayValid(body)
    functions.set('riseOfPlanetForDayValid', (planetNumber: number) => {
        return isNaN(riseSetForDay(true, planetNumber as ECPlanetNumber)) ? 0 : 1;
    });
    functions.set('riseOfPlanetForDayHour12ValueAngle', (planetNumber: number) => {
        const r = riseSetForDay(true, planetNumber as ECPlanetNumber);
        return isNaN(r) ? 0 : riseSetAngles(r).hour12 * 2 * Math.PI / 12;
    });
    functions.set('riseOfPlanetForDayMinuteValueAngle', (planetNumber: number) => {
        const r = riseSetForDay(true, planetNumber as ECPlanetNumber);
        return isNaN(r) ? 0 : riseSetAngles(r).minute * 2 * Math.PI / 60;
    });
    functions.set('riseOfPlanetForDayHour24Number', (planetNumber: number) => {
        const r = riseSetForDay(true, planetNumber as ECPlanetNumber);
        return isNaN(r) ? 0 : riseSetAngles(r).hour24;
    });

    // transitOfPlanetForDayValid(body)
    functions.set('transitOfPlanetForDayValid', (planetNumber: number) => {
        return isNaN(transitForDay(planetNumber as ECPlanetNumber)) ? 0 : 1;
    });
    functions.set('transitOfPlanetForDayHour12ValueAngle', (planetNumber: number) => {
        const t = transitForDay(planetNumber as ECPlanetNumber);
        return isNaN(t) ? 0 : riseSetAngles(t).hour12 * 2 * Math.PI / 12;
    });
    functions.set('transitOfPlanetForDayMinuteValueAngle', (planetNumber: number) => {
        const t = transitForDay(planetNumber as ECPlanetNumber);
        return isNaN(t) ? 0 : riseSetAngles(t).minute * 2 * Math.PI / 60;
    });
    functions.set('transitOfPlanetForDayHour24Number', (planetNumber: number) => {
        const t = transitForDay(planetNumber as ECPlanetNumber);
        return isNaN(t) ? 0 : riseSetAngles(t).hour24;
    });

    // setOfPlanetForDayValid(body)
    functions.set('setOfPlanetForDayValid', (planetNumber: number) => {
        return isNaN(riseSetForDay(false, planetNumber as ECPlanetNumber)) ? 0 : 1;
    });
    functions.set('setOfPlanetForDayHour12ValueAngle', (planetNumber: number) => {
        const s = riseSetForDay(false, planetNumber as ECPlanetNumber);
        return isNaN(s) ? 0 : riseSetAngles(s).hour12 * 2 * Math.PI / 12;
    });
    functions.set('setOfPlanetForDayMinuteValueAngle', (planetNumber: number) => {
        const s = riseSetForDay(false, planetNumber as ECPlanetNumber);
        return isNaN(s) ? 0 : riseSetAngles(s).minute * 2 * Math.PI / 60;
    });
    functions.set('setOfPlanetForDayHour24Number', (planetNumber: number) => {
        const s = riseSetForDay(false, planetNumber as ECPlanetNumber);
        return isNaN(s) ? 0 : riseSetAngles(s).hour24;
    });

    // =========================================================================
    // Time-returning functions (date intervals, e.g. for the Inspector catalog)
    //
    // "ForDay" variants: restricted to current calendar day (NaN if no event).
    // "Next" variants: search forward from now (can cross into next day).
    //
    // All return Apple epoch date intervals (seconds since 2001-01-01 00:00 UTC).
    // Planet numbers: Sun=0, Moon=1, Mercury=2, Venus=3, Mars=5, Jupiter=6,
    //                 Saturn=7, Uranus=8, Neptune=9
    // =========================================================================

    // --- ForDay time (current calendar day only) ---
    functions.set('sunriseForDayTime', () => {
        return riseSetForDay(true, ECPlanetNumber.Sun);
    });
    functions.set('sunsetForDayTime', () => {
        return riseSetForDay(false, ECPlanetNumber.Sun);
    });
    functions.set('sunTransitForDayTime', () => {
        return transitForDay(ECPlanetNumber.Sun);
    });
    functions.set('moonriseForDayTime', () => {
        return riseSetForDay(true, ECPlanetNumber.Moon);
    });
    functions.set('moonsetForDayTime', () => {
        return riseSetForDay(false, ECPlanetNumber.Moon);
    });
    functions.set('moonTransitForDayTime', () => {
        return transitForDay(ECPlanetNumber.Moon);
    });
    functions.set('riseOfPlanetForDayTime', (planetNumber: number) => {
        return riseSetForDay(true, planetNumber as ECPlanetNumber);
    });
    functions.set('setOfPlanetForDayTime', (planetNumber: number) => {
        return riseSetForDay(false, planetNumber as ECPlanetNumber);
    });
    functions.set('transitOfPlanetForDayTime', (planetNumber: number) => {
        return transitForDay(planetNumber as ECPlanetNumber);
    });

    // --- "Next" time helpers ---
    // Search forward from now for the next rise or set event.
    // Uses planetaryRiseSetTimeRefined with a small fudge forward (+60s)
    // to avoid returning an event that just happened.
    function nextRiseSet(riseNotSet: boolean, planetNumber: ECPlanetNumber): number {
        const now = getNow();
        const calcDate = dateToDateInterval(now);
        // Search forward: start from now + 60s fudge
        const fudgeDate = calcDate + 60;
        const result1 = planetaryRiseSetTimeRefined(
            fudgeDate, OBSERVER_LAT, OBSERVER_LON,
            riseNotSet, planetNumber, NaN, pool,
        );
        // Accept if the result is in the future
        if (!isNoRiseSet(result1.riseSetTime) && result1.riseSetTime > calcDate) {
            return result1.riseSetTime;
        }
        // If the result is in the past (or no event), try from 12h later
        const result2 = planetaryRiseSetTimeRefined(
            fudgeDate + 12 * 3600, OBSERVER_LAT, OBSERVER_LON,
            riseNotSet, planetNumber, NaN, pool,
        );
        if (!isNoRiseSet(result2.riseSetTime) && result2.riseSetTime > calcDate) {
            return result2.riseSetTime;
        }
        // Last resort: try from 24h later (for slow-moving planets)
        const result3 = planetaryRiseSetTimeRefined(
            fudgeDate + 24 * 3600, OBSERVER_LAT, OBSERVER_LON,
            riseNotSet, planetNumber, NaN, pool,
        );
        if (!isNoRiseSet(result3.riseSetTime) && result3.riseSetTime > calcDate) {
            return result3.riseSetTime;
        }
        return NaN;
    }

    // Search forward from now for the next transit.
    function nextTransit(planetNumber: ECPlanetNumber): number {
        const now = getNow();
        const calcDate = dateToDateInterval(now);
        // Start from now
        const result1 = planettransitTimeRefined(
            calcDate + 60, OBSERVER_LAT, OBSERVER_LON,
            true, planetNumber, pool,
        );
        if (result1 > calcDate) return result1;
        // Try from 12h later
        const result2 = planettransitTimeRefined(
            calcDate + 12 * 3600, OBSERVER_LAT, OBSERVER_LON,
            true, planetNumber, pool,
        );
        if (result2 > calcDate) return result2;
        return NaN;
    }

    // --- Next time (search forward from now) ---
    functions.set('nextSunrise', () => nextRiseSet(true, ECPlanetNumber.Sun));
    functions.set('nextSunset', () => nextRiseSet(false, ECPlanetNumber.Sun));
    functions.set('nextSunTransit', () => nextTransit(ECPlanetNumber.Sun));
    functions.set('nextMoonrise', () => nextRiseSet(true, ECPlanetNumber.Moon));
    functions.set('nextMoonset', () => nextRiseSet(false, ECPlanetNumber.Moon));
    functions.set('nextMoonTransit', () => nextTransit(ECPlanetNumber.Moon));
    functions.set('nextRiseOfPlanet', (planetNumber: number) => {
        return nextRiseSet(true, planetNumber as ECPlanetNumber);
    });
    functions.set('nextSetOfPlanet', (planetNumber: number) => {
        return nextRiseSet(false, planetNumber as ECPlanetNumber);
    });
    functions.set('nextTransitOfPlanet', (planetNumber: number) => {
        return nextTransit(planetNumber as ECPlanetNumber);
    });

    // --- "Prev" time helpers ---
    // Search backward from now for the most recent rise or set event.
    function prevRiseSet(riseNotSet: boolean, planetNumber: ECPlanetNumber): number {
        const now = getNow();
        const calcDate = dateToDateInterval(now);
        // Search backward: start from now - 60s fudge
        const fudgeDate = calcDate - 60;
        const result1 = planetaryRiseSetTimeRefined(
            fudgeDate, OBSERVER_LAT, OBSERVER_LON,
            riseNotSet, planetNumber, NaN, pool,
        );
        if (!isNoRiseSet(result1.riseSetTime) && result1.riseSetTime < calcDate) {
            return result1.riseSetTime;
        }
        // Try from 12h earlier
        const result2 = planetaryRiseSetTimeRefined(
            fudgeDate - 12 * 3600, OBSERVER_LAT, OBSERVER_LON,
            riseNotSet, planetNumber, NaN, pool,
        );
        if (!isNoRiseSet(result2.riseSetTime) && result2.riseSetTime < calcDate) {
            return result2.riseSetTime;
        }
        // Last resort: try from 24h earlier
        const result3 = planetaryRiseSetTimeRefined(
            fudgeDate - 24 * 3600, OBSERVER_LAT, OBSERVER_LON,
            riseNotSet, planetNumber, NaN, pool,
        );
        if (!isNoRiseSet(result3.riseSetTime) && result3.riseSetTime < calcDate) {
            return result3.riseSetTime;
        }
        return NaN;
    }

    function prevTransit(planetNumber: ECPlanetNumber): number {
        const now = getNow();
        const calcDate = dateToDateInterval(now);
        const result1 = planettransitTimeRefined(
            calcDate - 60, OBSERVER_LAT, OBSERVER_LON,
            true, planetNumber, pool,
        );
        if (result1 < calcDate) return result1;
        // Try from 12h earlier
        const result2 = planettransitTimeRefined(
            calcDate - 12 * 3600, OBSERVER_LAT, OBSERVER_LON,
            true, planetNumber, pool,
        );
        if (result2 < calcDate) return result2;
        return NaN;
    }

    // --- Prev time (search backward from now) ---
    functions.set('prevSunrise', () => prevRiseSet(true, ECPlanetNumber.Sun));
    functions.set('prevSunset', () => prevRiseSet(false, ECPlanetNumber.Sun));
    functions.set('prevSunTransit', () => prevTransit(ECPlanetNumber.Sun));
    functions.set('prevMoonrise', () => prevRiseSet(true, ECPlanetNumber.Moon));
    functions.set('prevMoonset', () => prevRiseSet(false, ECPlanetNumber.Moon));
    functions.set('prevMoonTransit', () => prevTransit(ECPlanetNumber.Moon));
    functions.set('prevRiseOfPlanet', (planetNumber: number) => {
        return prevRiseSet(true, planetNumber as ECPlanetNumber);
    });
    functions.set('prevSetOfPlanet', (planetNumber: number) => {
        return prevRiseSet(false, planetNumber as ECPlanetNumber);
    });
    functions.set('prevTransitOfPlanet', (planetNumber: number) => {
        return prevTransit(planetNumber as ECPlanetNumber);
    });

    // --- Planet phase/terminator functions (Venezia) ---
    // planetMoonAgeAngle(body): returns an age-like angle for the terminator display
    // Follows ECAstronomy.m planetAge + planetMoonAgeAngle
    functions.set('planetMoonAgeAngle', (planetNumber: number) =>
        liveAstro((cache, di) => {
        if (planetNumber === ECPlanetNumber.Sun) return Math.PI; // always bright
        if (planetNumber === ECPlanetNumber.Moon) return moonAge(di, cache).age;

        const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, cache);
        const U = julianCenturiesSince2000Epoch / 100;

        // Solve the Sun-planet-Earth triangle for phase angle
        const planet_r = WB_planetHeliocentricRadius(planetNumber as ECPlanetNumber, U);
        const planet_delta = planetGeocentricDistance(planetNumber as ECPlanetNumber, di, cache);
        const planet_R = WB_planetHeliocentricRadius(ECPlanetNumber.Earth, U); // Earth-Sun distance

        const cos_i = ((planet_r * planet_r) + (planet_delta * planet_delta) - (planet_R * planet_R))
            / (2 * planet_r * planet_delta);
        const phase = Math.acos(Math.max(-1, Math.min(1, cos_i)));

        // moonAge = pi - phase (complement)
        let moonAgeVal = Math.PI - phase;

        // Determine sign from heliocentric longitude difference
        const planetHLong = WB_planetHeliocentricLongitude(planetNumber as ECPlanetNumber, U);
        const earthHLong = WB_planetHeliocentricLongitude(ECPlanetNumber.Earth, U);
        let deltaHL = planetHLong - earthHLong;
        if (deltaHL < 0) deltaHL += 2 * Math.PI;
        if (deltaHL > Math.PI) {
            moonAgeVal = 2 * Math.PI - moonAgeVal;
        }
        return moonAgeVal;
        }));

    // planetRelativePositionAngle(body): rotation of the terminator as it appears in the sky
    // Follows ECAstronomy.m planetRelativePositionAngle
    functions.set('planetRelativePositionAngle', (planetNumber: number) =>
        liveAstro((cache, di) => {
        if (planetNumber === ECPlanetNumber.Moon) {
            return moonRelativePositionAngle(di, OBSERVER_LAT, OBSERVER_LON, cache);
        }
        if (planetNumber === ECPlanetNumber.Sun) return 0;

        const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, cache);
        const U = julianCenturiesSince2000Epoch / 100;

        // Sun RA/Decl
        const sunRD = sunRAandDecl(di, cache);
        // Planet RA/Decl (without parallax)
        const planetPos = WB_planetApparentPosition(planetNumber as ECPlanetNumber, U);
        const planetRA = planetPos.apparentRightAscension;
        const planetDecl = planetPos.apparentDeclination;

        let posAngle = positionAngle(sunRD.rightAscension, sunRD.declination, planetRA, planetDecl);

        // Check if bright limb is on the left (moonAge > pi)
        const planet_r = WB_planetHeliocentricRadius(planetNumber as ECPlanetNumber, U);
        const planet_delta = planetGeocentricDistance(planetNumber as ECPlanetNumber, di, cache);
        const planet_R = WB_planetHeliocentricRadius(ECPlanetNumber.Earth, U);
        const cos_i = ((planet_r * planet_r) + (planet_delta * planet_delta) - (planet_R * planet_R))
            / (2 * planet_r * planet_delta);
        const phase = Math.acos(Math.max(-1, Math.min(1, cos_i)));
        let moonAgeVal = Math.PI - phase;
        const planetHLong = WB_planetHeliocentricLongitude(planetNumber as ECPlanetNumber, U);
        const earthHLong = WB_planetHeliocentricLongitude(ECPlanetNumber.Earth, U);
        let deltaHL = planetHLong - earthHLong;
        if (deltaHL < 0) deltaHL += 2 * Math.PI;
        if (deltaHL > Math.PI) moonAgeVal = 2 * Math.PI - moonAgeVal;

        if (moonAgeVal > Math.PI) {
            posAngle = posAngle > Math.PI ? posAngle - Math.PI : posAngle + Math.PI;
        }

        // Compute planet's azimuth/altitude for northAngle
        const gst = convertUTToGSTP03(di, cache);
        const lst = convertGSTtoLST(gst, OBSERVER_LON);
        const planetHourAngle = lst - planetRA;
        const sinAlt = Math.sin(planetDecl) * Math.sin(OBSERVER_LAT)
            + Math.cos(planetDecl) * Math.cos(OBSERVER_LAT) * Math.cos(planetHourAngle);
        const planetAzimuth = Math.atan2(
            -Math.cos(planetDecl) * Math.cos(OBSERVER_LAT) * Math.sin(planetHourAngle),
            Math.sin(planetDecl) - Math.sin(OBSERVER_LAT) * sinAlt,
        );
        const planetAltitude = Math.asin(sinAlt);
        const nAngle = northAngleForObject(planetAltitude, planetAzimuth, OBSERVER_LAT);

        let angle = -nAngle - posAngle - Math.PI / 2;
        if (angle < 0) angle += 2 * Math.PI;
        else if (angle > 2 * Math.PI) angle -= 2 * Math.PI;
        return angle;
        }));

    // --- Venezia state variables ---
    // VeneziaTapsEnabled: always returns 0 (buttons deferred)
    functions.set('VeneziaTapsEnabled', () => 0);
    // saveBody: no-op for now
    functions.set('saveBody', (_n: number) => 0);

    // --- Lunar ascending node longitude ---
    functions.set('lunarAscendingNodeLongitude', () => {
        const di = dateToDateInterval(getNow());
        return computeLunarAscendingNode(di, null);
    });

    // --- Nearest lunar node (the node the Moon is currently closest to) ---
    // The Moon is always within 90° of exactly one node; that node is where it
    // last crossed or will next cross the ecliptic, so it's the one that
    // matters for eclipses.
    const moonIsNearDescendingNode = (cache: AstroCache, di: number): boolean => {
        const asc = computeLunarAscendingNode(di, cache);
        const moonLon = planetEclipticLongitude(ECPlanetNumber.Moon, di, cache);
        let d = fmod(moonLon - asc, 2 * Math.PI);
        if (d < 0) d += 2 * Math.PI;
        return d > Math.PI / 2 && d < 3 * Math.PI / 2;
    };
    const nearestNodeLongitude = (cache: AstroCache, di: number): number => {
        const asc = computeLunarAscendingNode(di, cache);
        if (!moonIsNearDescendingNode(cache, di)) return asc;
        const lon = asc + Math.PI;
        return lon >= 2 * Math.PI ? lon - 2 * Math.PI : lon;
    };
    // lunarNearestNodeLongitude(): geocentric ecliptic longitude of that node.
    functions.set('lunarNearestNodeLongitude', () =>
        liveAstro((cache, di) => nearestNodeLongitude(cache, di)));
    // lunarNearestNodeIsDescending(): 0 = ascending node, 1 = descending.
    functions.set('lunarNearestNodeIsDescending', () =>
        liveAstro((cache, di) => moonIsNearDescendingNode(cache, di) ? 1 : 0));
    // lunarNearestNodeMinusSunLongitude(): that node minus the Sun's geocentric
    // apparent ecliptic longitude, in [0, 2π). New moons occur at the Sun's
    // longitude and full moons opposite it, so 0 means new moons fall on this
    // node and π means full moons do — either way an eclipse season. The
    // inspector's node-gap cell folds this to a distance from the nearer of
    // the two, which for the Moon-nearest node is the syzygy the Moon is
    // actually approaching.
    functions.set('lunarNearestNodeMinusSunLongitude', () =>
        liveAstro((cache, di) => {
            const delta = nearestNodeLongitude(cache, di)
                - planetEclipticLongitude(ECPlanetNumber.Sun, di, cache);
            const folded = fmod(delta, 2 * Math.PI);
            return folded < 0 ? folded + 2 * Math.PI : folded;
        }));

    // --- Moon delta ecliptic longitude at delta day ---
    // Computes moonAge (= moonEclipticLong - sunEclipticLong) at local midnight ± n days.
    // Uses JS Date for DST-correct midnight (better than iOS, which is imprecise across DST).
    //
    // The full lunar-series moonAge (~13µs) at midnight±n is memoized in a dedicated
    // cache slot per delta-day (CacheSlot.moonAgeAtDayOffset + n+14), keyed by the
    // current display time via finalCache — the same slot-cache mechanism as
    // getMasterRiseSet, so a DEL ring's many wedges (which reference only ~29 distinct
    // delta-days) share one compute per distinct day per display time, and across ticks
    // it recomputes whenever the display time changes. This unifies on the slot cache
    // (no separate tickMemo Map for the ring). See planning/...§5.
    const moonDeltaCompute = (n: number): number => {
        const nowDate = liveDate();
        // Midnight of the target day in local timezone (DST-aware)
        const targetMidnight = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + n);
        const requestedDI = dateToDateInterval(new Date(targetMidnight.getTime() - tzDeltaMs));
        // Pass null (not finalCache): the internal moonAge runs its full lunar series
        // exactly once per call, so a cache would save nothing here — the only repeated
        // intermediate (julianCenturies) is sub-µs, and the moon path's nutation/obliquity
        // isn't slot-backed anyway. More importantly, a real cache here would be keyed at
        // the *offset* time (requestedDI), which would clobber finalCache's moon/sun slots
        // that are keyed to the *display* time. So null is both safe and simplifying; the
        // memoization happens one level up, in the per-delta-day result slot.
        return moonAge(requestedDI, null).age;
    };
    functions.set('moonDeltaEclipticLongitudeAtDeltaDay', (n: number) => {
        // Dedicated slots cover n ∈ [−14, +14] (the DEL ring's synodic-month range);
        // anything outside (or non-integer) computes uncached rather than indexing past
        // the slot range.
        if (!Number.isInteger(n) || n < -DEL_DAY_OFFSET_MAX || n > DEL_DAY_OFFSET_MAX) {
            return moonDeltaCompute(n);
        }
        const calcDate = dateToDateInterval(getNow());
        const cache = pool.finalCache;
        const prior = pushECAstroCacheInPool(pool, cache, calcDate);
        const slot = CacheSlot.moonAgeAtDayOffset + (n + DEL_DAY_OFFSET_MAX);
        let v: number;
        if (cache.isValid(slot)) {
            v = cache.get(slot);
        } else {
            v = moonDeltaCompute(n);
            cache.set(slot, v);
        }
        popECAstroCacheToInPool(pool, prior);
        return v;
    });

    // --- DEL wedge color functions (iOS-style stable alternation) ---
    // Use Unix day number (continuous integer count from epoch) for parity,
    // not day-of-month, to avoid color swaps at month boundaries with odd-length
    // months (e.g. Jan 31→Feb 1 both odd). Consecutive Unix days always alternate.
    //
    // We shift the UTC epoch ms by the full target-timezone offset so the day
    // boundary falls at local midnight.  Using liveDate().getTime() was wrong
    // because that adds only the browser-to-target delta (tzDeltaMs); when
    // browser == target timezone, tzDeltaMs is 0 and the day flipped at UTC
    // midnight instead of local midnight.
    const MS_PER_DAY = 86400000;
    const tzOffsetMs = tzOffsetSeconds * 1000;
    const localDayNum = (): number =>
        Math.floor((getNow().getTime() + tzOffsetMs) / MS_PER_DAY);
    functions.set('delOnDayTintColor', (n: number) => {
        return ((localDayNum() + n) % 2 === 0)
            ? env.variables.get('delOnDayTintColorA')!
            : env.variables.get('delOnDayTintColorB')!;
    });
    functions.set('delOnDayStrokeColor', (n: number) => {
        return ((localDayNum() + n) % 2 === 0)
            ? env.variables.get('delOnDayStrokeColorA')!
            : env.variables.get('delOnDayStrokeColorB')!;
    });
    functions.set('delOnDayTintNColor', (n: number) => {
        return ((localDayNum() + n) % 2 === 0)
            ? env.variables.get('delOnDayTintNColorA')!
            : env.variables.get('delOnDayTintNColorB')!;
    });
    functions.set('delOnDayStrokeNColor', (n: number) => {
        return ((localDayNum() + n) % 2 === 0)
            ? env.variables.get('delOnDayStrokeNColorA')!
            : env.variables.get('delOnDayStrokeNColorB')!;
    });

    // --- Moonrise/moonset for today (LIVE — recompute on call) ---
    functions.set('moonriseForDayValid', () => {
        return isNaN(riseSetForDay(true, ECPlanetNumber.Moon)) ? 0 : 1;
    });
    functions.set('moonriseForDayHour12ValueAngle', () => {
        const mr = riseSetForDay(true, ECPlanetNumber.Moon);
        return isNaN(mr) ? 0 : riseSetAngles(mr).hour12 * 2 * Math.PI / 12;
    });
    functions.set('moonriseForDayMinuteValueAngle', () => {
        const mr = riseSetForDay(true, ECPlanetNumber.Moon);
        return isNaN(mr) ? 0 : riseSetAngles(mr).minute * 2 * Math.PI / 60;
    });
    functions.set('moonriseForDayHour24Number', () => {
        const mr = riseSetForDay(true, ECPlanetNumber.Moon);
        return isNaN(mr) ? 0 : riseSetAngles(mr).hour24;
    });

    functions.set('moonsetForDayValid', () => {
        return isNaN(riseSetForDay(false, ECPlanetNumber.Moon)) ? 0 : 1;
    });
    functions.set('moonsetForDayHour12ValueAngle', () => {
        const ms = riseSetForDay(false, ECPlanetNumber.Moon);
        return isNaN(ms) ? 0 : riseSetAngles(ms).hour12 * 2 * Math.PI / 12;
    });
    functions.set('moonsetForDayMinuteValueAngle', () => {
        const ms = riseSetForDay(false, ECPlanetNumber.Moon);
        return isNaN(ms) ? 0 : riseSetAngles(ms).minute * 2 * Math.PI / 60;
    });
    functions.set('moonsetForDayHour24Number', () => {
        const ms = riseSetForDay(false, ECPlanetNumber.Moon);
        return isNaN(ms) ? 0 : riseSetAngles(ms).hour24;
    });

    // --- Button action stubs (no-ops) ---
    functions.set('manualSet', () => 0);
    functions.set('timeIsCorrect', () => 1);
    functions.set('inReverse', () => 0);
    functions.set('runningDemo', () => 0);
    functions.set('thisButtonPressed', () => 0);
    functions.set('tick', () => 0);
    functions.set('tock', () => 0);
    functions.set('stemIn', () => 0);
    functions.set('stemOut', () => 0);
    functions.set('goForward', () => 0);
    functions.set('goBackward', () => 0);
    functions.set('reset', () => 0);
    functions.set('advanceHour', () => 0);
    functions.set('advanceDay', () => 0);
    functions.set('advanceMonth', () => 0);
    functions.set('advanceSeconds', () => 0);
    functions.set('advanceToSunriseForDay', () => 0);
    functions.set('advanceToSunsetForDay', () => 0);
    functions.set('advanceToMoonriseForDay', () => 0);
    functions.set('advanceToMoonsetForDay', () => 0);
    functions.set('advanceYear', () => 0);
    functions.set('advanceYears', (_n: number) => 0);
    functions.set('advanceToNextMoonPhase', () => 0);
    functions.set('batteryLevel', () => cachedBatteryLevel);
    functions.set('batteryLevelSupported', () => (typeof navigator !== 'undefined' && 'getBattery' in navigator) ? 1 : 0);
    functions.set('goodAccuracy', () => 1);
    functions.set('heading', () => 0);

    // Timezone
    functions.set('tzOffset', () => tzOffsetSeconds);
    functions.set('tzOffsetAngle', () => tzOffsetSeconds * Math.PI / (12 * 3600));

    // Observer longitude in radians (used by Mauna Kea angle expressions)
    functions.set('longitude', () => OBSERVER_LON);

    // Observer latitude in radians (used by Gaia to flip moon for southern hemisphere)
    functions.set('latitude', () => OBSERVER_LAT);

    // Calendar wheel helpers
    // Derive calendarWeekdayStart from browser locale (Intl.Locale.getWeekInfo().firstDay).
    // getWeekInfo returns 1=Monday..7=Sunday; iOS uses 0=Sunday..6=Saturday.
    let calendarWeekdayStart = 0;  // default Sunday
    try {
        const locale = new Intl.Locale(navigator.language);
        // getWeekInfo is the modern standard; some browsers may also have .weekInfo property.
        const weekInfo = (locale as any).getWeekInfo?.() ?? (locale as any).weekInfo;
        if (weekInfo && typeof weekInfo.firstDay === 'number') {
            // Convert: getWeekInfo 1=Mon..7=Sun → iOS 0=Sun..6=Sat
            calendarWeekdayStart = weekInfo.firstDay % 7;
        }
    } catch { /* leave as Sunday */ }
    env.variables.set('calendarWeekdayStart', calendarWeekdayStart);
    functions.set('calendarWeekdayStart', () => calendarWeekdayStart);

    // weekdayNumber: 0=Sunday through 6=Saturday (ported from ECWatchTime.m weekdayNumberUsingEnv)
    // iOS uses local epoch arithmetic. For the web, we can use the tz-shifted date's getDay().
    const weekdayNumber = (): number => {
        const di = dateToDateInterval(getNow());
        return weekdayFromTimeInterval(di, tzOffsetSeconds);
    };

    // weekdayNumberAsCalendarColumn: adjusts weekday by calendarWeekdayStart
    // (ported from ECWatchTime.m weekdayNumberAsCalendarColumnUsingEnv)
    const weekdayNumberAsCalendarColumn = (): number => {
        return (7 + weekdayNumber() - calendarWeekdayStart) % 7;
    };

    // columnOfFirstOfMonth: computes which column (0-6) the 1st of the current month falls in.
    // (ported from ECGLWatch.m columnOfFirstOfMonth)
    // Note: Does not work for October 1582 after the transition — that's handled separately.
    const columnOfFirstOfMonth = (): number => {
        const cs = getLocalComponents();
        const dayOfMonth = cs.day - 1;  // 0-indexed (1st = 0)
        const wd = weekdayNumberAsCalendarColumn();
        return (wd + 7 - (dayOfMonth % 7)) % 7;
    };

    functions.set('calendarColumn', () => weekdayNumberAsCalendarColumn());

    // calendarRow: which row (0-based) the current day falls in within the month grid.
    // (ported from ECGLWatch.m calendarRow, with October 1582 handling)
    functions.set('calendarRow', () => {
        const cs = getLocalComponents();
        let dayNumber = cs.day - 1;  // 0-indexed
        let firstCol = columnOfFirstOfMonth();
        // October 1582 CE: days 5-14 were skipped.  The calendar wheel inserts
        // a 7-slot (one-row) blank gap where the missing days were, so days 15+
        // need dayNumber reduced by only 3 (10 skipped days - 7 gap slots).
        if (cs.year === 1582 && (cs.month - 1) === 9 && cs.era === 1 && dayNumber > 4) {
            dayNumber -= 3;
            firstCol = (8 - calendarWeekdayStart) % 7;  // Oct 1582 started on a Monday
        }
        const cellNumber = dayNumber + firstCol;
        return Math.floor(cellNumber / 7);
    });

    // rotationForCalendarWheel012B(weekdayStart): rotation angle for the "012B" calendar wheel.
    // (ported from ECGLWatch.m rotationForCalendarWheel012BDesignedForWeekdayStart)
    functions.set('rotationForCalendarWheel012B', (wheelWeekdayStart: number) => {
        if (calendarWeekdayStart !== wheelWeekdayStart) return 0;
        // Oct 1582: the special Oct1582 wheel is visible; keep this one
        // at its cutout angle to avoid animation glitches during the transition.
        const cs = getLocalComponents();
        if (cs.year === 1582 && (cs.month - 1) === 9 && cs.era === 1) return 3 * Math.PI / 2;
        const wd1 = columnOfFirstOfMonth();
        if (wd1 > 2) return 3 * Math.PI / 2;  // The cutout section
        return wd1 * Math.PI / 2;
    });

    // rotationForCalendarWheel3456(weekdayStart): rotation angle for the "3456" calendar wheel.
    // (ported from ECGLWatch.m rotationForCalendarWheel3456DesignedForWeekdayStart)
    functions.set('rotationForCalendarWheel3456', (wheelWeekdayStart: number) => {
        if (calendarWeekdayStart !== wheelWeekdayStart) return 0;
        // Oct 1582: keep at quadrant 0 (which shows startColumn=3, hidden behind Oct1582 wheel)
        const cs = getLocalComponents();
        if (cs.year === 1582 && (cs.month - 1) === 9 && cs.era === 1) return 0;
        const wd1 = columnOfFirstOfMonth();
        if (wd1 < 4) return 0;
        return (wd1 - 3) * Math.PI / 2;
    });

    // rotationForCalendarWheelOct1582(weekdayStart): special case for October 1582.
    // (ported from ECGLWatch.m rotationForCalendarWheelOct1582DesignedForWeekdayStart)
    functions.set('rotationForCalendarWheelOct1582', (wheelWeekdayStart: number) => {
        if (calendarWeekdayStart !== wheelWeekdayStart) return 0;
        const cs = getLocalComponents();
        if (cs.year === 1582 && (cs.month - 1) === 9 && cs.era === 1) {
            return 0;  // It IS October 1582 CE
        }
        return Math.PI / 2;  // The cutout section
    });

    // --- Terminator leaf function (5 args) ---
    functions.set('terminatorAngle', terminatorAngle);

    // --- Equation of Time angle (radians) ---
    // iOS: EOTAngle() returns [astro EOT] which is in radians
    // EOTSeconds converts HA to seconds, we need to convert back to angle
    functions.set('EOTAngle', () =>
        liveAstro((cache, di) => EOTSeconds(di, cache) * Math.PI / (12 * 3600)));
    functions.set('EOTSeconds', () => liveAstro((cache, di) => EOTSeconds(di, cache)));

    // --- Vernal equinox angle (sidereal-UT offset) ---
    // iOS: STDifferenceForDate — the difference between GST and UT
    functions.set('vernalEquinoxAngle', () =>
        liveAstro((cache, di) => GSTDifferenceForDate(di, cache)));

    // --- J2000 RA of vernal equinox of date (precession correction) ---
    // iOS: -[astro precession] = -generalPrecessionSinceJ2000(centuriesTDT)
    functions.set('J2000RAofVernalEquinoxOfDateAngle', () =>
        liveAstro((cache, di) => {
            const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, cache);
            return -generalPrecessionSinceJ2000(julianCenturiesSince2000Epoch);
        }));

    // --- Sunrise/sunset 24-hour indicator angles ---
    // iOS: dayNightLeafAngleForPlanetNumber:leafNumber:numLeaves:0
    // All four functions route through computeDayNightLeafAngle with numLeaves=0
    // to ensure they share the same rise/set search results (matching iOS).
    functions.set('sunrise24HourIndicatorAngle', () => {
        return computeDayNightLeafAngle(
            ECPlanetNumber.Sun, 0, 0,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds
        ).angle;
    });
    functions.set('sunset24HourIndicatorAngle', () => {
        return computeDayNightLeafAngle(
            ECPlanetNumber.Sun, 1, 0,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds
        ).angle;
    });

    // --- Polar summer/winter detection ---
    // iOS: dayNightLeafAngleForPlanetNumber:Sun leafNumber:2/3 numLeaves:0
    functions.set('polarSummer', () => {
        return computeDayNightLeafAngle(
            ECPlanetNumber.Sun, 2, 0,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds
        ).angle;
    });
    functions.set('polarWinter', () => {
        return computeDayNightLeafAngle(
            ECPlanetNumber.Sun, 3, 0,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds
        ).angle;
    });

    // --- Sunrise/sunset indicator validity (special ops for Mauna Kea) ---
    functions.set('sunriseIndicatorValid', () => {
        // iOS: sunIsUp ? prevSunriseValid : nextSunriseValid
        // Simplified: just check if sunrise for today is valid
        return isNaN(riseSetForDay(true, ECPlanetNumber.Sun)) ? 0 : 1;
    });
    functions.set('sunsetIndicatorValid', () => {
        return isNaN(riseSetForDay(false, ECPlanetNumber.Sun)) ? 0 : 1;
    });

    // --- Sun planetIsUp check ---
    functions.set('planetIsUp', (n: number) => {
        const di = dateToDateInterval(getNow());
        // Use the iOS-ported rise/set threshold (refraction + semidiameter, plus
        // Moon parallax), so "up" flips exactly at the body's rise/set — not at a
        // naive altitude > 0.
        return planetIsUpForRiseSet(n, di, OBSERVER_LAT, OBSERVER_LON) ? 1 : 0;
    });

    // =========================================================================
    // Japanese wadokei (temporal hour) functions — Kyoto face
    // =========================================================================

    /**
     * Get sunrise and sunset as fractional hour24Value (0–24) for today.
     * Falls back to local noon ± 6h if no rise/set (polar regions).
     * iOS: getValueFromMainAstroWatchTime:@selector(watchTimeWithSunriseForDay)
     *      watchTimeSelector:@selector(hour24ValueUsingEnv:)
     *
     * NOTE: These "ForDay" functions are constrained to the current calendar day.
     * For temporal hour calculations (japanHourValueAngle, angleForJapanHour),
     * use sunriseSunsetBracketing() instead, which finds the rise/set events
     * that bracket the current moment regardless of calendar day boundaries.
     */
    function sunriseHour24ForDay(): number {
        const sr = riseSetForDay(true, ECPlanetNumber.Sun);
        if (isNaN(sr)) {
            // Polar fallback: use noon (12.0) as midpoint, sunrise at 6.0
            return 6.0;
        }
        const d = targetLocalDate((sr + 978307200) * 1000);
        return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    }

    function sunsetHour24ForDay(): number {
        const ss = riseSetForDay(false, ECPlanetNumber.Sun);
        if (isNaN(ss)) {
            // Polar fallback: use noon (12.0) as midpoint, sunset at 18.0
            return 18.0;
        }
        const d = targetLocalDate((ss + 978307200) * 1000);
        return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    }

    /**
     * Find the sunrise and sunset that bracket the current moment, returning
     * them as hour24 values. Unlike sunriseHour24ForDay/sunsetHour24ForDay,
     * this is NOT constrained to the current calendar day — it uses the same
     * nextPrevRiseSetInternal search that computeDayNightLeafAngle uses.
     *
     * This is essential for temporal hour calculations at high latitudes
     * (e.g. Fairbanks in summer) where sunset may fall past midnight into
     * the next calendar day.
     *
     * Returns { sunrise, sunset } as fractional hours. sunrise is always
     * the most recent rise, sunset is always the next set (when sun is up),
     * and vice versa. dayLen = sunset - sunrise gives the correct day length
     * even when they span different calendar days.
     *
     * For polar cases (no rise or set), falls back to transit-based estimates:
     * polar summer → sunrise = transit - 12, sunset = transit + 12 (24h day)
     * polar winter → sunrise = sunset = transit (0h day)
     */
    function sunriseSunsetBracketing(): { sunrise: number; sunset: number } {
        const calcDate = dateToDateInterval(getNow());
        const fudgeFactorSeconds = 5;
        const lookahead = 3600 * 13.2;

        const planetIsUp = planetIsUpForRiseSet(ECPlanetNumber.Sun, calcDate, OBSERVER_LAT, OBSERVER_LON);

        // Same search logic as computeDayNightLeafAngle:
        // Rise: search backward if sun is up, forward if sun is down
        // Set:  search forward if sun is up, backward if sun is down
        const riseResult = nextPrevRiseSetInternal(
            calcDate, OBSERVER_LAT, OBSERVER_LON,
            true, ECPlanetNumber.Sun, !planetIsUp, -fudgeFactorSeconds, lookahead, pool,
        );
        const setResult = nextPrevRiseSetInternal(
            calcDate, OBSERVER_LAT, OBSERVER_LON,
            false, ECPlanetNumber.Sun, planetIsUp, -fudgeFactorSeconds, lookahead, pool,
        );

        const riseDI = riseResult.eventTime;
        const setDI = setResult.eventTime;

        // Convert dateIntervals to fractional hours in local time
        function diToHour24(di: number): number {
            const d = targetLocalDate((di + 978307200) * 1000);
            return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
        }

        if (isNoRiseSet(riseDI) && isNoRiseSet(setDI)) {
            // Both missing: polar case. Use transit-based estimate.
            const transitDI = planettransitTimeRefined(
                calcDate, OBSERVER_LAT, OBSERVER_LON,
                true, ECPlanetNumber.Sun, pool,
            );
            const transitH = diToHour24(transitDI);
            if (planetIsUp) {
                // Polar summer: sun always up → 24h day
                return { sunrise: transitH - 12, sunset: transitH + 12 };
            } else {
                // Polar winter: sun always down → 0h day
                return { sunrise: transitH, sunset: transitH };
            }
        }

        if (isNoRiseSet(riseDI)) {
            // Rise missing but set valid: near-polar case
            const setH = diToHour24(setDI);
            if (isAlwaysAbove(riseDI)) {
                // Sun always above → treat as 24h day
                return { sunrise: setH - 24, sunset: setH };
            } else {
                // Sun always below but there's a set → degenerate, use set
                return { sunrise: setH, sunset: setH };
            }
        }

        if (isNoRiseSet(setDI)) {
            // Set missing but rise valid
            const riseH = diToHour24(riseDI);
            if (isAlwaysAbove(setDI)) {
                // Sun always above → 24h day
                return { sunrise: riseH, sunset: riseH + 24 };
            } else {
                return { sunrise: riseH, sunset: riseH };
            }
        }

        // Both valid. Convert to hours, ensuring sunset > sunrise for dayLen calc.
        let riseH = diToHour24(riseDI);
        let setH = diToHour24(setDI);

        // If sunset hour < sunrise hour, the sunset is on the next calendar day.
        // Add 24 to keep sunset > sunrise for day-length computation.
        if (setH <= riseH) {
            setH += 24;
        }

        return { sunrise: riseH, sunset: setH };
    }


    // japanHourValueAngle(): angle of hand on traditional Japanese wadokei clock
    // with fixed dial. Noon on top. Variable-speed hand.
    // iOS: ECVirtualMachineOps.m lines 355–382
    functions.set('japanHourValueAngle', () => {
        let now = functions.get('hour24Value')!();
        const dayTime = functions.get('planetIsUp')!(ECPlanetNumber.Sun) !== 0;
        const { sunrise, sunset } = sunriseSunsetBracketing();
        const dayLen = sunset - sunrise;
        if (dayTime) {
            if (now < sunrise) {
                now += 24;
            }
            const dayFraction = dayLen > 0 ? (now - sunrise) / dayLen : 0.5;
            return (dayFraction + 3.0 / 2) * Math.PI;
        } else {
            let nightLen = 24 - dayLen;
            if (nightLen <= 0) {
                nightLen = 24;
            }
            let adjustedSunset = sunset % 24;  // Bring sunset back to 0-24 range for comparison
            if (adjustedSunset < 0) adjustedSunset += 24;
            if (now < adjustedSunset) {
                now += 24;
            }
            const nightFraction = (now - adjustedSunset) / nightLen;
            return (nightFraction + 1.0 / 2) * Math.PI;
        }
    });

    functions.set('solarNoonAngle', () => {
        // Compute solar noon from the sun's actual upper transit (meridian crossing).
        // This is always valid — the sun transits every day regardless of
        // whether sunrise/sunset occur (which they don't in polar regions).
        // The old approach averaged sunrise and sunset, which broke at high
        // latitudes where those events may be missing or fall on the wrong day.
        const calcDate = dateToDateInterval(getNow());
        const transitDI = planettransitTimeRefined(
            calcDate, OBSERVER_LAT, OBSERVER_LON,
            true, ECPlanetNumber.Sun, pool,
        );
        return angle24HourForDate(transitDI, tzOffsetSeconds) + Math.PI;
    });

    // angleForJapanHour(n, topAnchor): angle of center of temporal hour N on a
    // constant-rate-hand wadokei. Supports fractional n for sub-hour ticks.
    // 12 japanese hourNumbers per day; zero for noon hour ("午").
    // topAnchor allows aligning the dial to a specific standard.
    // iOS: ECVirtualMachineOps.m lines 388–407
    functions.set('angleForJapanHour', (japanHourNumber: number, topAnchor: number = 0) => {
        const { sunrise, sunset } = sunriseSunsetBracketing();
        const dayLen = sunset - sunrise;
        const nightLen = 24 - dayLen;
        
        let absoluteAngle = 0;
        if (japanHourNumber >= 9) {
            // sunrise → noon
            absoluteAngle = (sunrise + (japanHourNumber - 9) / 6 * dayLen) * Math.PI / 12 + Math.PI;
        } else if (japanHourNumber >= 6) {
            // midnight → sunrise
            absoluteAngle = (sunrise - (9 - japanHourNumber) / 6 * nightLen) * Math.PI / 12 + Math.PI;
        } else if (japanHourNumber >= 3) {
            // sunset → midnight
            absoluteAngle = (sunset + (japanHourNumber - 3) / 6 * nightLen) * Math.PI / 12 + Math.PI;
        } else {
            // noon → sunset
            absoluteAngle = (sunset - (3 - japanHourNumber) / 6 * dayLen) * Math.PI / 12 + Math.PI;
        }

        let offset = 0;
        if (topAnchor === 1) { // topAnchorClockMidnight
            offset = Math.PI;
        } else if (topAnchor === 2) { // topAnchorSolarNoon
            offset = functions.get('solarNoonAngle')!();
        } else if (topAnchor === 3) { // topAnchorSolarMidnight
            offset = functions.get('solarNoonAngle')!() + Math.PI;
        }
        return absoluteAngle - offset;
    });

    // temporalAngleFor24Hour(h, topAnchor): position of clock hour h (0–23) on the
    // constant-width temporal dial (where each temporal hour gets 30°).
    // No iOS equivalent — derived from the same sunrise/sunset data.
    // Maps daytime clock hours into the 180° daytime arc (sunrise→sunset)
    // and nighttime clock hours into the 180° nighttime arc.
    functions.set('temporalAngleFor24Hour', (h: number, topAnchor: number = 2) => {
        const calculateAngle = (hour: number) => {
            const { sunrise, sunset } = sunriseSunsetBracketing();
            const dayLen = sunset - sunrise;
            let nightLen = 24 - dayLen;
            if (nightLen <= 0) nightLen = 24;

            const sunriseAngle = 9 * Math.PI / 6;  // 270° = 3π/2
            const sunsetAngle = 3 * Math.PI / 6;   // 90° = π/2

            // Use modular sunrise/sunset for day/night determination
            const srMod = ((sunrise % 24) + 24) % 24;
            const ssMod = ((sunset % 24) + 24) % 24;
            let inDaytime: boolean;
            if (srMod < ssMod) {
                inDaytime = hour >= srMod && hour < ssMod;
            } else {
                inDaytime = hour >= srMod || hour < ssMod;
            }

            if (inDaytime) {
                let hFromSunrise = hour - srMod;
                if (hFromSunrise < 0) hFromSunrise += 24;
                const dayFrac = dayLen > 0 ? hFromSunrise / dayLen : 0.5;
                return fmod(sunriseAngle + dayFrac * Math.PI, 2 * Math.PI);
            } else {
                let hFromSunset = hour - ssMod;
                if (hFromSunset < 0) hFromSunset += 24;
                const nightFrac = hFromSunset / nightLen;
                return fmod(sunsetAngle + nightFrac * Math.PI, 2 * Math.PI);
            }
        };

        const absoluteAngle = calculateAngle(h);

        let offset = 0;
        if (topAnchor === 0) { // topAnchorClockNoon
            offset = calculateAngle(12);
        } else if (topAnchor === 1) { // topAnchorClockMidnight
            offset = calculateAngle(0);
        } else if (topAnchor === 3) { // topAnchorSolarMidnight
            offset = Math.PI;
        }
        return fmod(absoluteAngle - offset, 2 * Math.PI);
    });

    // --- Time/location indicator stubs ---
    functions.set('timeIndicatorColor', () => 0);  // stub
    functions.set('locationIndicatorColor', () => 0);  // stub
    functions.set('skew', () => 0);  // stub

    // --- Sun/Moon RA (radians) ---
    // iOS: [mainAstro sunRA] → sunRAandDecl().rightAscension
    functions.set('sunRA', () =>
        liveAstro((cache, di) => sunRAandDecl(di, cache).rightAscension));
    functions.set('moonRA', () =>
        liveAstro((cache, di) => moonRAAndDecl(di, cache).rightAscension));

    // --- minuteValue: fractional minutes (12:35:45 => 35.75) ---
    // iOS: ECWatchTime minuteValueUsingEnv: secondsSinceMidnightValue / 60 mod 60
    functions.set('minuteValue', () => {
        const now = liveDate();
        const secSinceMidnight = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
        return fmod(secSinceMidnight / 60, 60);
    });
    functions.set('minuteValueAngle', () => {
        const now = liveDate();
        const secSinceMidnight = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
        return fmod(secSinceMidnight / 60, 60) * 2 * Math.PI / 60;
    });

    // --- Local Sidereal Time in seconds ---
    // iOS: [mainAstro localSiderealTime] returns seconds
    // Our localSiderealTime() returns radians; convert: sec = radians * 12*3600/π
    functions.set('lstValue', () =>
        liveAstro((cache, di) => {
            const lstRadians = localSiderealTime(di, OBSERVER_LON, cache);
            return lstRadians * (12 * 3600) / Math.PI;
        }));

    // --- Lunar ascending node RA ---
    // iOS: [mainAstro moonAscendingNodeRA] — converts node ecliptic longitude to RA
    functions.set('lunarAscendingNodeRA', () =>
        liveAstro((cache, di) => {
        const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, cache);
        const longitude = WB_MoonAscendingNodeLongitude(julianCenturiesSince2000Epoch);
        const { nutation, obliquity } = WB_nutationObliquity(julianCenturiesSince2000Epoch / 100);
        const { rightAscension } = raAndDeclO(0, longitude, obliquity);
        let ra = rightAscension;
        if (ra < 0) ra += 2 * Math.PI;
        return ra;
        }));

    // --- Eclipse separation and kind ---
    // iOS: [mainAstro eclipseSeparation] → calculateEclipse().abstractSeparation
    functions.set('eclipseSeparation', () =>
        liveAstro((cache, di) => calculateEclipse(di, OBSERVER_LAT, OBSERVER_LON, cache).abstractSeparation));
    // iOS: eclipseKind → maps enum to wheel value (0-based with "none" collapsed)
    functions.set('eclipseKind', () =>
        liveAstro((cache, di) => {
            let value = calculateEclipse(di, OBSERVER_LAT, OBSERVER_LON, cache).eclipseKind;
            if (value > 0) value--;  // Wheel assumes one "none" value; collapse NoneSolar(0)/NoneLunar(5→4) gap
            return value;
        }));
    // legacyEclipseKind: same as eclipseKind on iOS (Android-origin shim)
    functions.set('legacyEclipseKind', () =>
        liveAstro((cache, di) => {
            let value = calculateEclipse(di, OBSERVER_LAT, OBSERVER_LON, cache).eclipseKind;
            if (value > 0) value--;
            return value;
        }));

    // --- Eclipse simulator disc geometry (Observatory Phase 7B) ---
    // These return the *physical* eclipse quantities the disc needs (not the
    // abstract/collapsed values the Basel wheel uses). iOS EOEclipseView.mm.
    // eclipseAngularSeparation(): physical Sun↔Moon (or shadow↔Moon) separation (rad)
    functions.set('eclipseAngularSeparation', () =>
        liveAstro((cache, di) => calculateEclipse(di, OBSERVER_LAT, OBSERVER_LON, cache).angularSeparation));
    // eclipseShadowAngularSize(): angular diameter of Earth's umbral shadow (rad, lunar)
    functions.set('eclipseShadowAngularSize', () =>
        liveAstro((cache, di) => calculateEclipse(di, OBSERVER_LAT, OBSERVER_LON, cache).shadowAngularSize));
    // eclipseKindRaw(): raw ECEclipseKind enum value 0..8 (read via Math.round)
    functions.set('eclipseKindRaw', () =>
        liveAstro((cache, di) => calculateEclipse(di, OBSERVER_LAT, OBSERVER_LON, cache).eclipseKind));

    // --- year366IndicatorAngle ---
    // iOS: year366IndicatorFractionUsingEnv * 2π
    // Fraction of 366-day year (non-leap years skip Feb 29 → offset after Feb)
    functions.set('year366IndicatorAngle', () => {
        return computeYear366IndicatorFraction(liveDate()) * 2 * Math.PI;
    });

    // --- closestSunEclipticLongitudeQuarter366IndicatorAngle ---
    // iOS: finds time of closest equinox/solstice, converts to year366 indicator angle
    functions.set('closestSunEclipticLongitudeQuarter366IndicatorAngle', (quarterNumber: number) => {
        return computeClosestSunEclipticLongQuarter366Angle(quarterNumber, getNow(), tzDeltaMs);
    });

    // --- planetrise/set 24-hour indicator angle LST ---
    // iOS: dayNightLeafAngleForPlanetNumber:leafNumber:0/1:numLeaves:0:timeBaseKind:LST
    functions.set('planetrise24HourIndicatorAngleLST', (planetNumber: number) => {
        return computeDayNightLeafAngle(
            planetNumber, 0, 0,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds, 'LST'
        ).angle;
    });
    functions.set('planetset24HourIndicatorAngleLST', (planetNumber: number) => {
        return computeDayNightLeafAngle(
            planetNumber, 1, 0,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds, 'LST'
        ).angle;
    });

    // --- Day/night ring leaf angle function (used by QdayNightRing) ---
    functions.set('dayNightLeafAngle', (planetNumber: number, leafNumber: number, numLeaves: number) => {
        return computeDayNightLeafAngle(
            planetNumber, leafNumber, numLeaves,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds
        ).angle;
    });

    // --- Day/night ring leaf angle function with LST time base (used by QdayNightRing with timeBase='LST') ---
    functions.set('dayNightLeafAngleLST', (planetNumber: number, leafNumber: number, numLeaves: number) => {
        return computeDayNightLeafAngle(
            planetNumber, leafNumber, numLeaves,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds, 'LST'
        ).angle;
    });

    // --- Planet transit 24-hour indicator angle ---
    // iOS: planettransit24HourIndicatorAngle(planetNumber)
    //   = dayNightLeafAngle(planetNumber, 4/*leafNumber*/, 0/*numLeaves*/)
    // This computes the high transit directly via planettransitTimeRefined,
    // NOT via the leaf-center approach.
    functions.set('planettransit24HourIndicatorAngle', (planetNumber: number) => {
        return computeDayNightLeafAngle(
            planetNumber, 4, 0,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds
        ).angle;
    });

    // --- Output parameter expression functions for dayNightLeafAngle ---
    // These provide the iOS output parameters (isRiseSet, aboveHorizon).
    // All three sibling functions go through computeDayNightLeafAngle, which
    // memoizes the expensive rise/set search in the dayNightMaster* slots — so
    // they share one computation per tick with no ordering dependency.
    functions.set('dayNightLeafAngleIsRiseSet', (planetNumber: number, leafNumber: number) => {
        return computeDayNightLeafAngle(
            planetNumber, leafNumber, 0,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds,
        ).isRiseSet ? 1 : 0;
    });
    functions.set('dayNightLeafAngleAboveHorizon', (planetNumber: number, leafNumber: number) => {
        return computeDayNightLeafAngle(
            planetNumber, leafNumber, 0,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds,
        ).aboveHorizon ? 1 : 0;
    });
    // --- Sun special angle (sunrise/sunset/twilight/golden) ---
    // Wraps computeSunSpecial24HourAngle for expression evaluation.
    // Returns the 24h dial angle (radians), or NaN if the event is invalid
    // (e.g., no sunrise in polar regions).
    // Kind: 0=SunRiseMorning, 1=SunSetEvening, 2=CivilTwiMorn, 3=CivilTwiEve,
    //       4=NautTwiMorn, 5=NautTwiEve, 6=GoldenMorn, 7=GoldenEve,
    //       8=AstroTwiMorn, 9=AstroTwiEve
    functions.set('sunSpecialAngle', (kind: number) => {
        const result = computeSunSpecial24HourAngle(
            kind as SunAltitudeKind,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds,
        );
        return result.valid ? result.angle : NaN;
    });

    // --- Solar noon angle on the 24h dial (raw, no wadokei +π offset) ---
    // Port of iOS: watchTimeWithSuntransitForDay()->hour24Value * 2π/24
    // NOTE: This is distinct from 'solarNoonAngle' (used by Kyoto wadokei),
    // which adds +π for the wadokei dial convention. Observatory uses this
    // raw version and adds its own noonOnTop offset in the expressions.
    functions.set('solarNoonAngle24h', () => {
        const di = dateToDateInterval(getNow());
        const transitDI = planettransitTimeRefined(
            di, OBSERVER_LAT, OBSERVER_LON,
            true /* wantHighTransit */, ECPlanetNumber.Sun, pool,
        );
        return angle24HourForDate(transitDI, tzOffsetSeconds);
    });

    // --- Local apparent solar time in seconds since midnight ---
    // iOS: solarTime = now + longitude * 86400/(2π) - tzOffset + EOT * 86400/(2π)
    functions.set('solarTimeSec', () =>
        liveAstro((cache, di) => {
        const eotSec = EOTSeconds(di, cache);
        const utcMs = getNow().getTime();
        const localSeconds = ((utcMs / 1000) + tzOffsetSeconds) % 86400;
        const secSinceMidnight = ((localSeconds % 86400) + 86400) % 86400;
        const solarSec = secSinceMidnight
            + OBSERVER_LON * 86400 / (2 * Math.PI)
            - tzOffsetSeconds
            + eotSec;
        return ((solarSec % 86400) + 86400) % 86400;
        }));

    // --- Planet transit angle on the 24h dial ---
    // Computes the high transit time and converts to a 24h angle.
    functions.set('planetTransitAngle', (planetNumber: number) => {
        const di = dateToDateInterval(getNow());
        const transitDI = planettransitTimeRefined(
            di, OBSERVER_LAT, OBSERVER_LON,
            true /* wantHighTransit */, planetNumber as ECPlanetNumber, pool,
        );
        return angle24HourForDate(transitDI, tzOffsetSeconds);
    });

    // --- UTC time hand angles ---
    // UTC minute: subtract tz offset (in whole minutes) from local minute angle
    functions.set('utcMinuteAngle', () => {
        const t = liveTime();
        const localMinFrac = t.m;  // fractional minutes including seconds
        const tzMinOffset = Math.round(tzOffsetSeconds / 60) % 60;
        return fmod(localMinFrac - tzMinOffset, 60) * 2 * Math.PI / 60;
    });

    // UTC second: same as local second (tz offsets are whole minutes)
    functions.set('utcSecondAngle', () => liveTime().s * 2 * Math.PI / 60);

    // --- Timezone offset in seconds (callable from expressions) ---
    functions.set('tzOffset', () => tzOffsetSeconds);

    // --- Sub-solar point (Observatory earth view) ---
    // subSolarLatitude: sun declination in radians (= sub-solar latitude)
    functions.set('subSolarLatitude', () =>
        liveAstro((cache, di) => sunRAandDecl(di, cache).declination));
    // subSolarLongitude: longitude of the point where the sun is directly
    // overhead, in radians [-π, π]. Port of iOS sslng calculation:
    //   sslng = π - solarTimeAtGreenwich × π / (12 × 3600)
    // solarTimeAtGreenwich = secondsSinceMidnight - tzOffset + EOT
    functions.set('subSolarLongitude', () =>
        liveAstro((cache, di) => {
        const eotSec = EOTSeconds(di, cache);
        // Compute seconds since local midnight in the target timezone
        const utcMs = getNow().getTime();
        const localSeconds = ((utcMs / 1000) + tzOffsetSeconds) % 86400;
        const secSinceMidnight = ((localSeconds % 86400) + 86400) % 86400;
        // Solar time at Greenwich meridian
        const solarTimeAtGreenwich = secSinceMidnight - tzOffsetSeconds + eotSec;
        let sslng = Math.PI - solarTimeAtGreenwich * Math.PI / (12 * 3600);
        // Normalize to [-π, π]
        while (sslng < -Math.PI) sslng += 2 * Math.PI;
        while (sslng > Math.PI) sslng -= 2 * Math.PI;
        return sslng;
        }));

    // --- noonOnTop variable (0 or 1, set by Observatory toggle) ---
    if (!env.variables.has('noonOnTop')) {
        env.variables.set('noonOnTop', 0);
    }

    return { pool, tzDeltaMs, tzOffsetSeconds };
}

// ============================================================================
// Day/night leaf angle — full iOS-faithful implementation
// ============================================================================

/**
 * Compute the 24-hour indicator angle for sunrise or sunset.
 * iOS: dayNightLeafAngleForPlanetNumber:ECPlanetSun leafNumber:0/1 numLeaves:0
 *
 * When numLeaves==0, leafNumber 0 returns rise angle, 1 returns set angle.
 * Falls back to transit angle if rise/set is NaN.
 */
// NOTE: dayNightLeafAngle, isPolarSummer, isPolarWinter were removed.
// All callers now use computeDayNightLeafAngle(planet, leafNumber, numLeaves=0, ...)
// which matches the iOS architecture where all outputs (indicator angles,
// polar detection, and ring leaves) share the same rise/set search results.

/**
 * Convert a dateInterval to a 24-hour angle in local time.
 * iOS: angle24HourForDateInterval:timeBaseKind:ECTimeBaseKindLT
 */
export function angle24HourForDate(dateInterval: number, tzOffsetSeconds: number): number {
    // Compute local time of day from the UTC dateInterval + timezone offset.
    // This avoids relying on browser-local getHours() which would be wrong
    // when the target timezone differs from the browser timezone.
    const utcSeconds = dateInterval + 978307200;  // Apple epoch to Unix epoch
    const localSeconds = utcSeconds + tzOffsetSeconds;
    const secondsInDay = ((localSeconds % 86400) + 86400) % 86400;  // mod to [0, 86400)
    const h = secondsInDay / 3600;
    return h * Math.PI / 12;  // 24h → 2π
}

/**
 * Determine if a planet is currently "up" (above the rise/set horizon).
 *
 * iOS: ECAstronomy.m planetIsUp (line 3408-3438).
 * Compares the planet's current altitude against altitudeAtRiseSet
 * (which accounts for refraction + semidiameter), NOT against zero.
 * Using alt > 0 would create a several-minute gap near moonrise/moonset
 * where the altitude check and the rise/set algorithm disagree.
 */
function planetIsUpForRiseSet(
    planetNumber: number,
    calcDate: number,
    observerLat: number,
    observerLon: number,
): boolean {
    const correctForParallax = planetNumber === ECPlanetNumber.Moon;
    const alt = planetAltAz(
        planetNumber, calcDate, observerLat, observerLon,
        correctForParallax, true, null,
    );
    // iOS line 3427-3430: compare against altitudeAtRiseSet, NOT zero
    const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(calcDate, null);
    const altAtRS = altitudeAtRiseSet(
        julianCenturiesSince2000Epoch, planetNumber,
        false /* !wantGeocentricAltitude, matching iOS */,
        null, ECWBPrecision.Full,
    );
    return alt > altAtRS;
}

/**
 * Port of iOS nextPrevRiseSetInternalWithFudgeInterval.
 *
 * Two-step search for the next or previous rise/set event:
 * 1. Search from (calcDate + fudge), check if the transit is in the right direction
 * 2. If not, retry from (fudgeDate + lookahead)
 *
 * Returns { eventTime, transitTime } where transitTime is the
 * riseSetOrTransit output from planetaryRiseSetTimeRefined.
 */
function nextPrevRiseSetInternal(
    calcDate: number,
    observerLat: number,
    observerLon: number,
    riseNotSet: boolean,
    planetNumber: number,
    isNext: boolean,
    fudgeSeconds: number,
    lookahead: number,
    pool: AstroCachePool,
    overrideAltitude: number = NaN,
): { eventTime: number; transitTime: number } {
    // iOS lines 2326-2329: if searching backward, negate fudge and lookahead
    let fudge = fudgeSeconds;
    let look = lookahead;
    if (!isNext) {
        fudge = -fudge;
        look = -look;
    }

    const fudgeDate = calcDate + fudge;
    const result1 = planetaryRiseSetTimeRefined(
        fudgeDate, observerLat, observerLon,
        riseNotSet, planetNumber, overrideAltitude, pool,
    );

    // iOS lines 2335-2337: check if transit is in the right direction
    const transitOk = isNext
        ? result1.transitTime >= fudgeDate
        : result1.transitTime < fudgeDate;

    if (transitOk) {
        return { eventTime: result1.riseSetTime, transitTime: result1.transitTime };
    }

    // Retry from lookahead position (iOS lines 2347-2350)
    const tryDate = fudgeDate + look;
    const result2 = planetaryRiseSetTimeRefined(
        tryDate, observerLat, observerLon,
        riseNotSet, planetNumber, overrideAltitude, pool,
    );

    return { eventTime: result2.riseSetTime, transitTime: result2.transitTime };
}

// ============================================================================
// DayNightLeafAngle structured result and iOS-style cache
// ============================================================================

/**
 * Structured result from computeDayNightLeafAngle, matching the full iOS
 * contract of dayNightLeafAngleForPlanetNumber (return value + output params).
 *
 * iOS output parameters (valid only when numLeaves == 0):
 *   *isRiseSet    → false when there is no rise or set (angle is the transit)
 *   *aboveHorizon → true if planet is always above horizon (polar summer)
 */
export interface DayNightLeafAngleResult {
    /** The computed angle (same value iOS returns from the function). */
    angle: number;
    /** false when planet doesn't rise/set and angle is the transit fallback.
     *  Valid only when numLeaves === 0. */
    isRiseSet: boolean;
    /** When isRiseSet is false: true if always above horizon, false if always below.
     *  Valid only when numLeaves === 0. */
    aboveHorizon: boolean;
}

/** The four raw outputs of the day/night rise/set search, shared by every wedge
 *  and indicator in a tick. Times are seconds since the 2001 epoch, or the
 *  ±1e18 always-above/below sentinels (see isNoRiseSet / isAlwaysAbove). */
interface MasterRiseSet {
    riseTime: number;
    setTime: number;
    riseTransitTime: number;
    setTransitTime: number;
}

const RISE_SET_FUDGE_SECONDS = 5;       // iOS: fudgeFactorSeconds = 5
const RISE_SET_LOOKAHEAD = 3600 * 13.2;

/**
 * Lightweight profiling counters for the master rise/set search — the dominant
 * scrub-tick astronomy cost. `masterComputes` counts actual root-finder runs
 * (cache misses); `masterCalls` counts every getMasterRiseSet lookup; `masterMs`
 * is the wall time spent in the searches.
 *
 * With today's per-face pools, `masterComputes` per frame ≈ Σ(distinct planet
 * rings per face) across all rendered faces — i.e. the same (Sun, today, lat,
 * lon) search re-run once per face. A shared pool should collapse it to the
 * globally-distinct (planet, location) set. Reset at scrub start and printed at
 * scrub end; see the [scrub-perf] log in engine-entry.ts.
 */
export const astroProfile = {
    masterCalls: 0,
    masterComputes: 0,
    masterMs: 0,
    // Total wall time in computeDayNightLeafAngle (the whole per-wedge day/night
    // computation — memoized search hit + the un-memoized per-wedge leaf/angle
    // math) and the call count. Compare leafMs against the tick's evalMs to see
    // how much of the eval-dominated tick is this astronomy vs evaluator overhead.
    leafCalls: 0,
    leafMs: 0,
};

export function resetAstroProfile(): void {
    astroProfile.masterCalls = 0;
    astroProfile.masterComputes = 0;
    astroProfile.masterMs = 0;
    astroProfile.leafCalls = 0;
    astroProfile.leafMs = 0;
    cacheStats.invalidations = 0;
}

// Cheap integer counters (masterCalls/Computes, leafCalls) stay always-on; the
// `performance.now()` *timing* (masterMs, leafMs) is gated behind this flag so it
// doesn't tax the hot path — it's only meaningful alongside ?tickprofile anyway,
// and timing 600+ sub-µs leaf calls/frame with now() would itself inflate the tick.
let astroProfilingEnabled = false;
export function setAstroProfiling(on: boolean): void { astroProfilingEnabled = on; }

/**
 * The expensive half of the day/night computation: the two
 * nextPrevRiseSetInternal searches. Depends only on (planet, date, lat, lon),
 * so it is identical for every wedge in a ring. Ports iOS ESAstronomy.cpp
 * L5032-5096 (search portion). `planetNumber` must already have MidnightSun
 * substituted to Sun by the caller.
 */
function computeMasterRiseSet(
    planetNumber: number,
    calcDate: number,
    observerLat: number,
    observerLon: number,
    pool: AstroCachePool,
): MasterRiseSet {
    astroProfile.masterComputes++;
    const _t0 = performance.now();

    // iOS: [self planetIsUp:planetNumber]
    const planetIsUp = planetIsUpForRiseSet(planetNumber, calcDate, observerLat, observerLon);

    // iOS lines 4598-4612: search for rise and set
    const riseResult = nextPrevRiseSetInternal(
        calcDate, observerLat, observerLon,
        true, planetNumber, !planetIsUp, -RISE_SET_FUDGE_SECONDS, RISE_SET_LOOKAHEAD, pool,
    );
    const setResult = nextPrevRiseSetInternal(
        calcDate, observerLat, observerLon,
        false, planetNumber, planetIsUp, -RISE_SET_FUDGE_SECONDS, RISE_SET_LOOKAHEAD, pool,
    );

    astroProfile.masterMs += performance.now() - _t0;
    return {
        riseTime: riseResult.eventTime,
        setTime: setResult.eventTime,
        riseTransitTime: riseResult.transitTime,
        setTransitTime: setResult.transitTime,
    };
}

/**
 * Slot-cached master rise/set search for the day/night ring.
 *
 * Memoizes the four raw search outputs in the dayNightMaster* slots of
 * `pool.finalCache`, so the ~20-iteration root-finder runs once per
 * (planet, date, lat, lon) per tick instead of once per wedge. All wedges and
 * the rise/set/aboveHorizon indicators in a tick share the result.
 *
 * This is the single astronomy caching mechanism — the slot cache. Pushing
 * `finalCache` with the live display `calcDate` self-invalidates whenever the
 * time changes (exact-match re-keying), and the cache's global flag
 * handles location/direction changes; nothing is cleared explicitly. The
 * build-time `dateInterval` heals itself on the first push at the live time.
 * Within a tick `getNow` is frozen, so every call pushes the identical
 * `calcDate` and reuses the first call's slots.
 *
 * `planetNumber` must already have MidnightSun substituted to Sun. The
 * dayNightMaster* slot categories cover planets 0..9; for any other planet
 * (e.g. Pluto = 10) we compute without memoizing — the day/night ring is not
 * used for those.
 */
function getMasterRiseSet(
    planetNumber: number,
    calcDate: number,
    observerLat: number,
    observerLon: number,
    pool: AstroCachePool,
): MasterRiseSet {
    astroProfile.masterCalls++;
    // The dayNightMaster* slots are keyed by planetNumber alone, so a memoized
    // value is valid ONLY for the pool's own observer location. A per-slot ring at
    // a different location (e.g. Gaia's four `envSlot` city rings) must NOT read the
    // observer's cached search — otherwise every slot collides onto the first one.
    // Such calls bypass the memo and compute directly (they're few — a handful of
    // rings on one face). The general fix is a (location, di)-keyed cache; see
    // planning/2026-06-28-per-tick-astronomy-memoization.md §4b.
    const sharedLocation = observerLat === pool.observerLatitude
        && observerLon === pool.observerLongitude;
    if (planetNumber < 0 || planetNumber > 9 || !sharedLocation) {
        return computeMasterRiseSet(planetNumber, calcDate, observerLat, observerLon, pool);
    }

    const cache = pool.finalCache;
    const prior = pushECAstroCacheInPool(pool, cache, calcDate);

    const riseSlot = CacheSlot.dayNightMasterRiseTime + planetNumber;
    const setSlot = CacheSlot.dayNightMasterSetTime + planetNumber;
    const riseTransitSlot = CacheSlot.dayNightMasterRiseTransitTime + planetNumber;
    const setTransitSlot = CacheSlot.dayNightMasterSetTransitTime + planetNumber;

    let result: MasterRiseSet;
    if (cache.isValid(riseSlot) && cache.isValid(setSlot)
        && cache.isValid(riseTransitSlot) && cache.isValid(setTransitSlot)) {
        result = {
            riseTime: cache.get(riseSlot),
            setTime: cache.get(setSlot),
            riseTransitTime: cache.get(riseTransitSlot),
            setTransitTime: cache.get(setTransitSlot),
        };
    } else {
        result = computeMasterRiseSet(planetNumber, calcDate, observerLat, observerLon, pool);
        cache.set(riseSlot, result.riseTime);
        cache.set(setSlot, result.setTime);
        cache.set(riseTransitSlot, result.riseTransitTime);
        cache.set(setTransitSlot, result.setTransitTime);
    }

    popECAstroCacheToInPool(pool, prior);
    return result;
}

/**
 * Time base for day/night ring angles. iOS: ECTimeBaseKind.
 * - `'LT'`  — local (clock) time, via `angle24HourForDate(t, tzOffsetSeconds)`.
 * - `'LST'` — local sidereal time, via `angle24HourLSTForDate(t, observerLon)`.
 */
export type TimeBaseKind = 'LT' | 'LST';

/**
 * Full day/night leaf angle computation.
 * iOS: dayNightLeafAngleForPlanetNumber:leafNumber:numLeaves:timeBaseKind:
 *
 * Uses nextPrevRiseSetInternal (matching iOS nextPrevRiseSetInternalWithFudgeInterval)
 * with two-step search and transit-time validation.
 *
 * numLeaves == 0: special indicator angles (rise/set/polar)
 * numLeaves > 0: individual leaf positions for day/night ring
 *
 * `timeBaseKind` selects the time→angle conversion only; everything else (the
 * shared rise/set master search and the leaf distribution) is identical for both
 * bases, exactly as in iOS's single `dayNightLeafAngleForPlanetNumber:…:timeBaseKind:`.
 *
 * Returns a DayNightLeafAngleResult with the angle and the iOS output parameters
 * (isRiseSet, aboveHorizon). For numLeaves > 0, isRiseSet is always true.
 */
export function computeDayNightLeafAngle(
    planetNumber: number,
    leafNumber: number,
    numLeaves: number,
    getNow: () => Date,
    observerLat: number,
    observerLon: number,
    pool: AstroCachePool,
    tzOffsetSeconds: number,
    timeBaseKind: TimeBaseKind = 'LT',
): DayNightLeafAngleResult {
    // Thin timing wrapper: attribute the per-wedge day/night cost so the scrub
    // log can show how much of the (eval-dominated) tick is this vs the evaluator.
    astroProfile.leafCalls++;
    if (!astroProfilingEnabled) {
        return computeDayNightLeafAngleImpl(
            planetNumber, leafNumber, numLeaves, getNow, observerLat, observerLon, pool, tzOffsetSeconds, timeBaseKind,
        );
    }
    const _t0 = performance.now();
    const r = computeDayNightLeafAngleImpl(
        planetNumber, leafNumber, numLeaves, getNow, observerLat, observerLon, pool, tzOffsetSeconds, timeBaseKind,
    );
    astroProfile.leafMs += performance.now() - _t0;
    return r;
}

function computeDayNightLeafAngleImpl(
    planetNumber: number,
    leafNumber: number,
    numLeaves: number,
    getNow: () => Date,
    observerLat: number,
    observerLon: number,
    pool: AstroCachePool,
    tzOffsetSeconds: number,
    timeBaseKind: TimeBaseKind,
): DayNightLeafAngleResult {
    const calcDate = dateToDateInterval(getNow());

    // Time→angle conversion, selected by time base. iOS: angle24HourForDateInterval:timeBaseKind:.
    const toAngle = timeBaseKind === 'LST'
        ? (t: number) => angle24HourLSTForDate(t, observerLon)
        : (t: number) => angle24HourForDate(t, tzOffsetSeconds);

    // iOS ECAstronomy.m line 4567-4570: planetMidnightSun is a special flag
    // that inverts the day/night ring (shows night leaves instead of day).
    // Substitute Sun for the actual rise/set calculations.
    const nightTime = planetNumber === ECPlanetNumber.MidnightSun;
    if (nightTime) {
        planetNumber = ECPlanetNumber.Sun;
    }

    // Transit indicator (numLeaves === 0, leafNumber === 4): computed directly via
    // planettransitTimeRefined, NOT from the rise/set search. iOS L5182-5190.
    if (numLeaves === 0 && leafNumber === 4) {
        const transitDI = planettransitTimeRefined(
            calcDate, observerLat, observerLon,
            true /* wantHighTransit */, planetNumber, pool,
        );
        return { angle: toAngle(transitDI), isRiseSet: true, aboveHorizon: false };
    }

    // isSpecial marks the numLeaves === 0 polar-detection indicators (leafNumber
    // 2/3). The leafNumber 0/1 rise/set indicators return below, right after the
    // raw angles are derived (before the leaf-distribution tail).
    const isSpecial = (numLeaves === 0);

    if (numLeaves < 0) {
        // Dawn/dusk indicators; abs(numLeaves) is amount to move backward
        // iOS line 4673-4674
        numLeaves = -numLeaves;
    }

    // Expensive rise/set search — memoized once per (planet, date, lat, lon) per
    // tick in the dayNightMaster* slots and shared by every wedge and indicator.
    const master = getMasterRiseSet(planetNumber, calcDate, observerLat, observerLon, pool);
    const riseTime = master.riseTime;
    const setTime = master.setTime;

    // iOS lines 4616-4631: transit angles. When always-above, the rise/set search
    // returns the LOW transit but the indicator must show the HIGH transit, so add π.
    // iOS guards this with `isnan(riseTimeAngle) && EC_nansEqual(…, kECAlwaysAboveHorizon)`
    // because its sentinel is a NaN. The TS sentinel is the FINITE ±1e18, so the old
    // `isNaN(riseTime)` guard was always false (dead code) and the +π never fired —
    // a port regression that left polar-summer transit fallbacks at the low transit
    // (≈ midnight). `isAlwaysAbove(riseTime)` is the correct check (matches the LST
    // path and iOS intent). See planning/2026-06-29-scrub-perf-next-levers.md (Lever A).
    let rTransitAngle = toAngle(master.riseTransitTime);
    let sTransitAngle = toAngle(master.setTransitTime);

    if (isAlwaysAbove(riseTime)) {
        rTransitAngle = fmod(rTransitAngle + Math.PI, 2 * Math.PI);
    }
    if (isAlwaysAbove(setTime)) {
        sTransitAngle = fmod(sTransitAngle + Math.PI, 2 * Math.PI);
    }

    let riseTimeAngle = isNoRiseSet(riseTime) ? NaN : toAngle(riseTime);
    let setTimeAngle = isNoRiseSet(setTime) ? NaN : toAngle(setTime);

    // Rise/set indicators (numLeaves === 0, leafNumber 0/1). iOS L5100-5125.
    // Derived from the raw angles BEFORE the polar NaN-resolution below, matching
    // the original compute-once cache. leafNumber 2/3 fall through to that logic.
    if (numLeaves === 0 && leafNumber === 0) {  // rise indicator
        const riseIsRS = !isNaN(riseTimeAngle);
        return {
            angle: riseIsRS ? riseTimeAngle : rTransitAngle,
            isRiseSet: riseIsRS,
            aboveHorizon: riseIsRS ? false : isAlwaysAbove(riseTime),
        };
    }
    if (numLeaves === 0 && leafNumber === 1) {  // set indicator
        const setIsRS = !isNaN(setTimeAngle);
        return {
            angle: setIsRS ? setTimeAngle : sTransitAngle,
            isRiseSet: setIsRS,
            aboveHorizon: setIsRS ? false : isAlwaysAbove(setTime),
        };
    }

    const leafWidth = numLeaves > 0 ? 2 * Math.PI / numLeaves : 0;
    let polarSummer = false;
    let polarWinter = false;

    // Handle NaN cases — match iOS logic exactly (lines 4676-4715)
    if (isNaN(riseTimeAngle)) {
        if (isNaN(setTimeAngle)) {
            // Both invalid — use average transit
            let sTA = sTransitAngle;
            if (sTA > rTransitAngle + Math.PI) sTA -= 2 * Math.PI;
            else if (sTA < rTransitAngle - Math.PI) sTA += 2 * Math.PI;
            const avgTransit = (rTransitAngle + sTA) / 2;
            if (isAlwaysAbove(riseTime)) {
                riseTimeAngle = avgTransit - Math.PI;
                setTimeAngle = avgTransit + Math.PI;
                polarSummer = true;
            } else {
                riseTimeAngle = avgTransit - leafWidth / 2 - 0.00001;
                setTimeAngle = avgTransit + leafWidth / 2 + 0.00001;
                polarWinter = true;
            }
        } else {
            // rise invalid, set valid
            if (isAlwaysAbove(riseTime)) {
                riseTimeAngle = setTimeAngle - 2 * Math.PI;
                polarSummer = true;
            } else {
                riseTimeAngle = setTimeAngle - leafWidth;
                polarWinter = true;
            }
        }
    } else if (isNaN(setTimeAngle)) {
        // rise valid, set invalid
        if (isAlwaysAbove(setTime)) {
            setTimeAngle = riseTimeAngle + 2 * Math.PI;
            polarSummer = true;
        } else {
            setTimeAngle = riseTimeAngle + leafWidth;
            polarWinter = true;
        }
    }

    // iOS lines 4717-4724: return polar state for special leafNumber 2/3
    if (isSpecial) {
        if (leafNumber === 2) return { angle: polarSummer ? 1 : 0, isRiseSet: true, aboveHorizon: false };
        if (leafNumber === 3) return { angle: polarWinter ? 1 : 0, isRiseSet: true, aboveHorizon: false };
    }

    // Normalize (iOS lines 4726-4732)
    riseTimeAngle = fmod(riseTimeAngle, 2 * Math.PI);
    setTimeAngle = fmod(setTimeAngle, 2 * Math.PI);
    if (setTimeAngle <= riseTimeAngle + 0.0001) {
        setTimeAngle += 2 * Math.PI;
    }

    // iOS lines 4733-4743: adjust for nighttime vs daytime
    // (nightTime was computed at the top of this function, before planet substitution)
    if (nightTime) {
        setTimeAngle += leafWidth / 2;
        riseTimeAngle -= leafWidth / 2;
    } else {
        setTimeAngle -= leafWidth / 2;
        riseTimeAngle += leafWidth / 2;
    }

    if (setTimeAngle < riseTimeAngle) {
        riseTimeAngle = setTimeAngle = (riseTimeAngle + setTimeAngle) / 2;
    }

    // iOS lines 4744-4753: compute leaf center
    let leafCenterAngle: number;
    if (nightTime) {
        leafCenterAngle = setTimeAngle + (2 * Math.PI - setTimeAngle + riseTimeAngle) / (numLeaves - 1) * leafNumber;
    } else {
        leafCenterAngle = riseTimeAngle + (setTimeAngle - riseTimeAngle) / (numLeaves - 1) * leafNumber;
    }

    if (leafCenterAngle > 2 * Math.PI) {
        leafCenterAngle -= 2 * Math.PI;
    }

    return { angle: leafCenterAngle, isRiseSet: true, aboveHorizon: false };
}

// ============================================================================
// Sun special 24-hour indicator angle (twilight / golden hour hands)
// ============================================================================

/**
 * Sun altitude kind for the Observatory's twilight/golden-hour hand indicators.
 * iOS: CacheSlotIndex enum values sunRiseMorning..sunAstroTwilightEvening
 * Port of: ESAstronomy.cpp getParamsForAltitudeKind (L2663-2714)
 */
export enum SunAltitudeKind {
    SunRiseMorning,
    SunSetEvening,
    SunGoldenHourMorning,
    SunGoldenHourEvening,
    SunCivilTwilightMorning,
    SunCivilTwilightEvening,
    SunNauticalTwilightMorning,
    SunNauticalTwilightEvening,
    SunAstroTwilightMorning,
    SunAstroTwilightEvening,
    // Sun ring gradient stops — altitudes for ring color transitions
    SunRing18BelowMorning,
    SunRing18BelowEvening,
    SunRing9BelowMorning,
    SunRing9BelowEvening,
    // SunRing1Below and SunRingHalfBelow removed: ring uses sunrise/sunset angle ± ε
    SunRing1AboveMorning,
    SunRing1AboveEvening,
    SunRing9AboveMorning,
    SunRing9AboveEvening,
    SunRing30AboveMorning,
    SunRing30AboveEvening,
}

export interface SunSpecialAngleResult {
    angle: number;
    valid: boolean;
}

/**
 * Map altitude kind to (altitude, riseNotSet) parameters.
 * Port of: ESAstronomy.cpp getParamsForAltitudeKind (L2663-2714)
 */
function getParamsForAltitudeKind(kind: SunAltitudeKind): { altitude: number; riseNotSet: boolean } {
    switch (kind) {
        case SunAltitudeKind.SunRiseMorning:
            return { altitude: NaN, riseNotSet: true };
        case SunAltitudeKind.SunSetEvening:
            return { altitude: NaN, riseNotSet: false };
        case SunAltitudeKind.SunGoldenHourMorning:
            return { altitude: 15 * Math.PI / 180, riseNotSet: true };
        case SunAltitudeKind.SunGoldenHourEvening:
            return { altitude: 15 * Math.PI / 180, riseNotSet: false };
        case SunAltitudeKind.SunCivilTwilightMorning:
            return { altitude: -6 * Math.PI / 180, riseNotSet: true };
        case SunAltitudeKind.SunCivilTwilightEvening:
            return { altitude: -6 * Math.PI / 180, riseNotSet: false };
        case SunAltitudeKind.SunNauticalTwilightMorning:
            return { altitude: -12 * Math.PI / 180, riseNotSet: true };
        case SunAltitudeKind.SunNauticalTwilightEvening:
            return { altitude: -12 * Math.PI / 180, riseNotSet: false };
        case SunAltitudeKind.SunAstroTwilightMorning:
            return { altitude: -18 * Math.PI / 180, riseNotSet: true };
        case SunAltitudeKind.SunAstroTwilightEvening:
            return { altitude: -18 * Math.PI / 180, riseNotSet: false };
        // Sun ring gradient stops
        case SunAltitudeKind.SunRing18BelowMorning:
            return { altitude: -18 * Math.PI / 180, riseNotSet: true };
        case SunAltitudeKind.SunRing18BelowEvening:
            return { altitude: -18 * Math.PI / 180, riseNotSet: false };
        case SunAltitudeKind.SunRing9BelowMorning:
            return { altitude: -9 * Math.PI / 180, riseNotSet: true };
        case SunAltitudeKind.SunRing9BelowEvening:
            return { altitude: -9 * Math.PI / 180, riseNotSet: false };
        // SunRing1Below and SunRingHalfBelow removed: ring uses sunrise/sunset ± ε
        case SunAltitudeKind.SunRing1AboveMorning:
            return { altitude: 1 * Math.PI / 180, riseNotSet: true };
        case SunAltitudeKind.SunRing1AboveEvening:
            return { altitude: 1 * Math.PI / 180, riseNotSet: false };
        case SunAltitudeKind.SunRing9AboveMorning:
            return { altitude: 9 * Math.PI / 180, riseNotSet: true };
        case SunAltitudeKind.SunRing9AboveEvening:
            return { altitude: 9 * Math.PI / 180, riseNotSet: false };
        case SunAltitudeKind.SunRing30AboveMorning:
            return { altitude: 30 * Math.PI / 180, riseNotSet: true };
        case SunAltitudeKind.SunRing30AboveEvening:
            return { altitude: 30 * Math.PI / 180, riseNotSet: false };
    }
}

/**
 * Compute the 24-hour indicator angle for a sun event (sunrise, sunset,
 * twilight boundary, or golden hour boundary).
 *
 * Port of: ESAstronomy.cpp sunSpecial24HourIndicatorAngleForAltitudeKind (L5538-5581)
 *
 * For sunrise/sunset: uses the standard dayNightLeafAngle approach.
 * For twilight/golden hour: uses a two-step search:
 *   1. Find the nearest sunset (for morning events) or sunrise (for evening events)
 *   2. From that anchor, search backward/forward for the twilight boundary
 *
 * This ensures the hand transitions at the correct point (180° from the
 * transit, i.e., when the relevant sunrise/sunset changes) rather than at
 * midnight like sunAltitudeTimeForDay would.
 */
export function computeSunSpecial24HourAngle(
    altitudeKind: SunAltitudeKind,
    getNow: () => Date,
    observerLat: number,
    observerLon: number,
    pool: AstroCachePool,
    tzOffsetSeconds: number,
): SunSpecialAngleResult {
    const { altitude, riseNotSet } = getParamsForAltitudeKind(altitudeKind);
    const calcDate = dateToDateInterval(getNow());
    const fudgeFactorSeconds = 5;
    const lookahead = 3600 * 13.2;

    if (altitudeKind === SunAltitudeKind.SunRiseMorning ||
        altitudeKind === SunAltitudeKind.SunSetEvening) {
        // Sunrise/sunset: same as computeDayNightLeafAngle(Sun, 0/1, 0, ...)
        // but with validity tracking.
        // iOS: dayNightLeafAngleForPlanetNumber(Sun, riseNotSet?0:1, 0, NaN, &validReturn, NULL)
        const planetIsUp = planetIsUpForRiseSet(ECPlanetNumber.Sun, calcDate, observerLat, observerLon);
        const result = nextPrevRiseSetInternal(
            calcDate, observerLat, observerLon,
            riseNotSet, ECPlanetNumber.Sun,
            riseNotSet ? !planetIsUp : planetIsUp,
            -fudgeFactorSeconds, lookahead, pool,
        );
        let transitAngle = angle24HourForDate(result.transitTime, tzOffsetSeconds);
        if (isNaN(result.eventTime) && isAlwaysAbove(result.eventTime)) {
            transitAngle = fmod(transitAngle + Math.PI, 2 * Math.PI);
        }
        const eventAngle = isNoRiseSet(result.eventTime)
            ? NaN
            : angle24HourForDate(result.eventTime, tzOffsetSeconds);
        if (isNaN(eventAngle)) {
            return { angle: transitAngle, valid: false };
        }
        return { angle: eventAngle, valid: true };
    }

    // =========================================================================
    // Twilight / golden hour: two-step search
    // iOS L5547-5577
    // =========================================================================
    let anchorTime: number;
    let twilightResult: { eventTime: number; transitTime: number };

    if (riseNotSet) {
        // Morning twilight: find next sunset, then search backward from there
        // for the preceding morning twilight at the specified altitude.
        // iOS L5550-5561
        const sunsetResult = nextPrevRiseSetInternal(
            calcDate, observerLat, observerLon,
            false, ECPlanetNumber.Sun,  // riseNotSet=false → sunset
            true,                        // isNext=true → forward to next sunset
            fudgeFactorSeconds, lookahead, pool,
            // NaN altitude → standard sunset
        );
        anchorTime = sunsetResult.transitTime;

        // From sunset, search backward for the morning twilight boundary
        twilightResult = nextPrevRiseSetInternal(
            anchorTime, observerLat, observerLon,
            true, ECPlanetNumber.Sun,   // riseNotSet=true → rise (morning boundary)
            false,                       // isNext=false → backward
            fudgeFactorSeconds, lookahead, pool,
            altitude,                    // override altitude for twilight
        );
    } else {
        // Evening twilight: find previous sunrise, then search forward from there
        // for the following evening twilight at the specified altitude.
        // iOS L5562-5573
        const sunriseResult = nextPrevRiseSetInternal(
            calcDate, observerLat, observerLon,
            true, ECPlanetNumber.Sun,   // riseNotSet=true → sunrise
            false,                       // isNext=false → backward to prev sunrise
            fudgeFactorSeconds, lookahead, pool,
            // NaN altitude → standard sunrise
        );
        anchorTime = sunriseResult.transitTime;

        // From sunrise, search forward for the evening twilight boundary
        twilightResult = nextPrevRiseSetInternal(
            anchorTime, observerLat, observerLon,
            false, ECPlanetNumber.Sun,  // riseNotSet=false → set (evening boundary)
            true,                        // isNext=true → forward
            fudgeFactorSeconds, lookahead, pool,
            altitude,                    // override altitude for twilight
        );
    }

    // iOS L5561/5573: valid = !isnan(ignoreMe) where ignoreMe is the event return value
    const valid = !isNaN(twilightResult.eventTime) && isFinite(twilightResult.eventTime)
        && !isNoRiseSet(twilightResult.eventTime);
    // iOS L5577: angle = angle24HourForDateInterval(riseSetOrTransit, LT)
    // riseSetOrTransit = transitTime output from the search
    const angle = angle24HourForDate(twilightResult.transitTime, tzOffsetSeconds);

    return { angle, valid };
}

// ============================================================================
// Year-366 (leap year inclusive) indicator fraction
// ============================================================================

/**
 * Compute the fraction of the year for a 366-day (leap-scaled) indicator.
 * iOS: ECWatchTime year366IndicatorFractionUsingEnv
 * 
 * Maps non-leap years so they skip February 29th (adding 1 day to the offset).
 *
 * @param date - Current JS Date
 * @returns Fraction of 366 days [0, 1)
 */
function computeYear366IndicatorFraction(date: Date): number {
    const year = date.getFullYear();
    const month = date.getMonth();
    const dom = date.getDate();
    
    // Determine if current year is leap year
    const isLeap = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0));
    
    // Find start of year
    const startOfYear = new Date(year, 0, 1);
    
    // Difference in days from start of year to now
    let diffMs = date.getTime() - startOfYear.getTime();
    let daysSinceStart = diffMs / (1000 * 60 * 60 * 24);
    
    // Non-leap years: after Feb 28, add 1 full day so we skip the Feb 29 slot
    if (!isLeap && (month > 1 || (month === 1 && dom > 28))) {
        daysSinceStart += 1;
    }
    
    // 366 days in our scaled year
    return fmod(daysSinceStart / 366.0, 1.0);
}

// ============================================================================
// Closest sun ecliptic longitude quarter (equinox/solstice)
// ============================================================================

/**
 * Approximate time when sun ecliptic longitude hits target.
 * Uses tropical year ratio.
 */
function timeOfClosestSunEclipticLongitude(
    targetSunLong: number,
    tryDate: number,
): number {
    // Pass null for cache: each iteration uses a different tryDate,
    // so a shared cache would return stale sun longitude values.
    const sunLongForTryDate = sunEclipticLongitudeForDate(tryDate, null);
    const howFarAway = targetSunLong - sunLongForTryDate;
    let deltaAngleToTarget: number;
    if (howFarAway >= 0) {
        if (howFarAway >= Math.PI) {
            deltaAngleToTarget = howFarAway - 2 * Math.PI;
        } else {
            deltaAngleToTarget = howFarAway;
        }
    } else if (howFarAway >= -Math.PI) {
        deltaAngleToTarget = howFarAway;
    } else {
        deltaAngleToTarget = howFarAway + 2 * Math.PI;
    }
    
    const kECSecondsInTropicalYear = 3600.0 * 24 * 365.2422;
    return tryDate + deltaAngleToTarget * kECSecondsInTropicalYear / (2 * Math.PI);
}

/**
 * Refine the closest equinox/solstice time and return its year366 fraction angle.
 * iOS: closestSunEclipticLongitudeQuarter366IndicatorAngle
 * quarterNumber: 0=vernal eq, 1=summer sol, 2=autumn eq, 3=winter sol
 */
function computeClosestSunEclipticLongQuarter366Angle(
    quarterNumber: number,
    nowDate: Date,
    tzDeltaMs: number,
): number {
    const calcDate = dateToDateInterval(nowDate);
    const targetSunLong = quarterNumber * Math.PI / 2;
    
    // Iterative refinement (4 steps like iOS)
    let tryDate = timeOfClosestSunEclipticLongitude(targetSunLong, calcDate);
    tryDate = timeOfClosestSunEclipticLongitude(targetSunLong, tryDate);
    tryDate = timeOfClosestSunEclipticLongitude(targetSunLong, tryDate);
    const targetTime = timeOfClosestSunEclipticLongitude(targetSunLong, tryDate);
    
    // Convert target interval to year366 fraction (tz-shifted for local calendar)
    const targetDate = new Date((targetTime + 978307200) * 1000 + tzDeltaMs);
    return computeYear366IndicatorFraction(targetDate) * 2 * Math.PI;
}

// ============================================================================
// LST 24-hour angle helper
//
// The LST day/night ring no longer has its own leaf-angle function: it shares
// `computeDayNightLeafAngle` via `timeBaseKind='LST'`, which routes the
// conversion through this helper. (Previously `computeDayNightLeafAngleLST`
// duplicated the whole distribution — a simplified subset that omitted the
// MidnightSun / polar-indicator / transit branches; the unified function covers
// them all.)
// ============================================================================

/**
 * Compute the LST 24-hour angle for a given time.
 */
function angle24HourLSTForDate(dateInterval: number, observerLon: number): number {
    const lstRadians = localSiderealTime(dateInterval, observerLon, null);
    return fmod(lstRadians, 2 * Math.PI);
}

