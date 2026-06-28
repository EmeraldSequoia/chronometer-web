/**
 * Watch expression environment setup.
 *
 * Creates an Environment populated with all init-block variables
 * and time/astronomy functions for a parsed Watch model.
 *
 * Delegates shared astronomy/calendar/time function registration to
 * astro-env.ts and adds Chronometer-specific functions:
 * - Terra/Gaia world-time ring slot system
 * - Kyoto wadokei (day/night ring, master rotation)
 * - Venezia body selector URL override
 * - Vienna noon-on-top URL override
 */

import {
    createDefaultEnvironment,
    evaluate,
    Environment,
} from '../expr/evaluator.js';
import type { Watch } from './types.js';
import type { ASTNode } from '../expr/parser.js';
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
} from '../shared/animation.js';
import { releaseCachePool } from '../astronomy/astro-cache.js';
import { ECPlanetNumber } from '../astronomy/astro-constants.js';

// Import the shared astro environment function registration
import {
    registerAstroFunctions,
    computeDayNightLeafAngle,
} from '../shared/astro-env.js';
import {
    timeIntervalFromUTCComponents,
    daysInMonth as calendarDaysInMonth,
    weekdayFromTimeInterval,
} from '../astronomy/es-calendar.js';
import { terminatorAngle } from './terminator.js';
import { PATH_SAMPLE_COUNT } from './analemma.js';
import { dateToDateInterval } from '../astronomy/es-time.js';
import { fractionOfVernalEquinoxYear, sunSkyOrientationAngle } from '../astronomy/es-astro.js';

// Re-export symbols that other modules import from watch-env.ts
// (backward compatibility — eventually consumers should import directly from astro-env.ts)
export { computeTzDeltaMs, evalAttr, evalColor } from '../shared/astro-env.js';

/**
 * Numeric codes for a CalendarRowCover's `coverType`. The expression language is
 * numeric, so the cover type is passed to the `calendarCoverOffset(code)` env
 * function as one of these codes (constructed by buildHandValues). Keep in sync
 * with the switch in {@link computeCalendarCoverOffsetForEnv}.
 */
export const CALENDAR_COVER_CODES: Record<string, number> = {
    row1Left: 0,
    row1Right: 1,
    row6Left: 2,
    row56Right: 3,
};

// Default observer location (San Jose, CA): used if geolocation unavailable
const DEFAULT_LAT_DEG = 37.205;    // degrees N
const DEFAULT_LON_DEG = -121.954;  // degrees (west is negative)

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

// --- Exported Terra types and defaults ---

/** A city entry for a Terra worldtime ring slot. */
export interface TerraSlot {
    cityName: string;
    olsonId: string;
    lat: number;
    lon: number;
}

/** Default ring slot cities (indexed by env slot 1–24). */
export const TERRA_RING_DEFAULTS: Record<number, TerraSlot> = {
    1:  { cityName: 'Pago Pago',      olsonId: 'Pacific/Pago_Pago',      lat: -14.27806, lon: -170.70250 },
    2:  { cityName: 'Honolulu',       olsonId: 'Pacific/Honolulu',       lat:  21.30694, lon: -157.85834 },
    3:  { cityName: 'Anchorage',      olsonId: 'America/Juneau',         lat:  61.21806, lon: -149.90028 },
    4:  { cityName: 'Los Angeles',    olsonId: 'America/Los_Angeles',    lat:  34.05223, lon: -118.24368 },
    5:  { cityName: 'Denver',         olsonId: 'America/Denver',         lat:  39.73915, lon: -104.98470 },
    6:  { cityName: 'Chicago',        olsonId: 'America/Chicago',        lat:  41.85003, lon:  -87.65005 },
    7:  { cityName: 'New York',       olsonId: 'America/New_York',       lat:  40.71427, lon:  -74.00597 },
    8:  { cityName: 'Santiago',       olsonId: 'America/Santiago',       lat: -33.42628, lon:  -70.56655 },
    9:  { cityName: 'Rio de Janeiro', olsonId: 'America/Sao_Paulo',      lat: -22.90278, lon:  -43.20750 },
    10: { cityName: 'Grytviken',      olsonId: 'Atlantic/South_Georgia', lat: -54.27667, lon:  -36.51167 },
    11: { cityName: 'Dakar',          olsonId: 'Africa/Dakar',           lat:  14.74208, lon:  -17.43978 },
    12: { cityName: 'London',         olsonId: 'Europe/London',          lat:  51.50842, lon:   -0.12553 },
    13: { cityName: 'Paris',          olsonId: 'Europe/Paris',           lat:  48.85341, lon:    2.34880 },
    14: { cityName: 'Cairo',          olsonId: 'Africa/Cairo',           lat:  30.05000, lon:   31.25000 },
    15: { cityName: 'Moscow',         olsonId: 'Europe/Moscow',          lat:  55.75222, lon:   37.61555 },
    16: { cityName: 'Dubai',          olsonId: 'Asia/Dubai',             lat:  25.25222, lon:   55.28000 },
    17: { cityName: 'Delhi',          olsonId: 'Asia/Kolkata',           lat:  28.66667, lon:   77.21666 },
    18: { cityName: 'Dhaka',          olsonId: 'Asia/Dhaka',             lat:  23.72305, lon:   90.40861 },
    19: { cityName: 'Bangkok',        olsonId: 'Asia/Bangkok',           lat:  13.75000, lon:  100.51667 },
    20: { cityName: 'Hong Kong',      olsonId: 'Asia/Hong_Kong',         lat:  22.28401, lon:  114.15007 },
    21: { cityName: 'Tokyo',          olsonId: 'Asia/Tokyo',             lat:  35.68953, lon:  139.69168 },
    22: { cityName: 'Sydney',         olsonId: 'Australia/Sydney',       lat: -33.86785, lon:  151.20732 },
    23: { cityName: 'Nouméa',         olsonId: 'Pacific/Noumea',         lat: -22.26667, lon:  166.45000 },
    24: { cityName: 'Auckland',       olsonId: 'Pacific/Auckland',       lat: -36.86666, lon:  174.76666 },
};

/** Default subdial cities for Gaia (indexed by env slot 2–4; slot 1 = observer). */
export const GAIA_SUBDIAL_DEFAULTS: Record<number, TerraSlot> = {
    2: { cityName: 'New York', olsonId: 'America/New_York', lat: 40.71427, lon: -74.00597 },
    3: { cityName: 'London',   olsonId: 'Europe/London',    lat: 51.50842, lon:  -0.12553 },
    4: { cityName: 'Sydney',   olsonId: 'Australia/Sydney',  lat: -33.86785, lon: 151.20732 },
};

// ============================================================================
// createWatchEnvironment — Chronometer-specific environment factory
// ============================================================================

/**
 * Persisted UI overrides applied to the env *after* the XML init blocks, so they
 * win over the XML defaults. These come from app-state (storage/URL) on the main
 * thread, or from the mirrored state on a worker — **never read here**, so this
 * builder stays pure and worker-safe (no `getState`/DOM access). Each field is the
 * already-resolved value (e.g. `body` is a planet number, not the URL string);
 * `undefined` means "leave the XML default in place".
 */
/**
 * Minimal slice of a {@link Watch} that {@link createWatchEnvironment} actually
 * needs — just the init-block expressions. A full `Watch` satisfies this, and the
 * eval-ahead worker can pass only `{ initExprs }` (the parsed init ASTs) instead of
 * cloning the entire parts tree / image data across the thread boundary.
 */
export interface WatchEnvSource {
    initExprs: ASTNode[];
}

export interface WatchEnvOverrides {
    /** Venezia selected body (resolved `ECPlanetNumber`). */
    body?: number;
    /** Vienna noon-on-top toggle (true ⇒ noonOnTop=1, dialFlip=π). */
    noonOnTop?: boolean;
    /** Kyoto constant/variable hand-rate mode (0 or 1). */
    kyMode?: number;
    /** Kyoto fixed-hand mode (0 or 1). */
    kyHandMode?: number;
}

/**
 * Build the expression environment for a watch:
 *  1. Math builtins + color constants (via createDefaultEnvironment)
 *  2. All shared astronomy/calendar/time functions (via registerAstroFunctions)
 *  3. Evaluate all init blocks (populates watch variables)
 *  4. Chronometer-specific: Kyoto/Venezia/Vienna URL overrides, wadokei, Terra ring
 *
 * @param watch - Parsed Watch model containing init expressions
 * @param observerLatDeg - Observer latitude in degrees (positive = north)
 * @param observerLonDeg - Observer longitude in degrees (negative = west)
 * @param getNow - Time source function
 * @param olsonTimezone - IANA timezone override
 * @param slotOverrides - Terra ring city overrides
 * @param globalLocationSlot - Terra ring top-slot override
 */
export function createWatchEnvironment(
    watch: WatchEnvSource,
    observerLatDeg: number = DEFAULT_LAT_DEG,
    observerLonDeg: number = DEFAULT_LON_DEG,
    getNow: () => Date = () => new Date(),
    olsonTimezone?: string,
    slotOverrides?: Record<number, TerraSlot>,
    globalLocationSlot?: number,
    overrides?: WatchEnvOverrides,
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

    // Register all shared astronomy/calendar/time functions.
    // Returns internals (pool, tzDeltaMs, tzOffsetSeconds) needed for Terra.
    const { pool, tzDeltaMs, tzOffsetSeconds } = registerAstroFunctions(
        env, OBSERVER_LAT, OBSERVER_LON, getNow, olsonTimezone,
    );

    // Evaluate all init blocks in document order
    for (const expr of watch.initExprs) {
        evaluate(expr, env);
    }

    // --- Chronometer-specific: Kyoto hand mode ---
    /** Kyoto hand mode: 0 = moving hand, 1 = fixed hand at top */
    env.kyHandMode = 0;

    // Persisted UI overrides (body / noonOnTop / kyMode / kyHandMode), applied
    // AFTER the init blocks so they win over the XML defaults. Passed in explicitly
    // (read from app-state on the main thread; mirrored on a worker) — this builder
    // does NOT read getState/DOM, keeping it pure and worker-safe.
    if (overrides) {
        if (overrides.body !== undefined) {
            const body = overrides.body;
            env.variables.set('body', body);
            // Recompute bodySlot from body (matching the XML init expression)
            const bodySlot =
                body === ECPlanetNumber.Moon ? 0 :
                body === ECPlanetNumber.Mercury ? 1 :
                body === ECPlanetNumber.Venus ? 2 :
                body === ECPlanetNumber.Mars ? 3 :
                body === ECPlanetNumber.Jupiter ? 4 :
                body === ECPlanetNumber.Saturn ? 5 :
                body === ECPlanetNumber.Uranus ? 6 :
                body === ECPlanetNumber.Neptune ? 7 :
                body === ECPlanetNumber.Sun ? 8 : 0.5;
            env.variables.set('bodySlot', bodySlot);
        }

        // Vienna noon-on-top toggle. Only the non-default (noon) case is applied;
        // false/undefined leaves the XML init's default (midnight) in place.
        if (overrides.noonOnTop) {
            env.variables.set('noonOnTop', 1);
            env.variables.set('dialFlip', Math.PI);
        }

        // Kyoto constant/variable hand rate toggle.
        if (overrides.kyMode !== undefined) {
            env.variables.set('kyMode', overrides.kyMode);
        }

        // Kyoto fixed-hand toggle.
        if (overrides.kyHandMode !== undefined) {
            env.kyHandMode = overrides.kyHandMode;
        }
    }

    env.functions.set('kyotoHandMode', () => env.kyHandMode);

    /**
     * Kyoto master rotation: returns the amount to rotate the dial pieces
     * so that the active hand appears fixed at the top (0 degrees).
     */
    env.functions.set('kyotoMasterRotation', () => {
        if (env.kyHandMode === 0) {
            return 0;
        }
        const kmode = env.variables.get('kyMode') || 0;
        if (kmode === 0) {
            // Constant rate: use hour24ValueAngle() + pi - solarNoonAngle()
            const h24 = env.functions.get('hour24ValueAngle')?.() || 0;
            const sn = env.functions.get('solarNoonAngle')?.() || 0;
            return h24 + Math.PI - sn;
        } else {
            // Variable rate: use Japan hour
            return env.functions.get('japanHourValueAngle')?.() || 0;
        }
    });

    /**
     * Helper: compute the raw sunset/sunrise angles for the wadokei day/night ring.
     * In mode 0 (constant hand rate): uses the astronomical leaf function.
     * In mode 1 (variable hand rate, temporal dial): sunset and sunrise are at
     *   fixed temporal positions, each exactly 3 temporal hours from noon,
     *   dividing the dial exactly in half (nightArc = π).
     *   Raw angles (before masterOffset): sunset = 3π/2, sunrise = π/2.
     *
     * Polar handling: when there is no sunrise or sunset (polar summer/winter),
     * the leafNumber 0/1 queries return transit-angle fallbacks that look like
     * normal angles. We detect this by also querying leafNumber 2 (polarSummer)
     * and 3 (polarWinter), then return sentinel angles that produce a near-zero
     * or near-2π nightArc for wadokeiDNNumVisible() to handle correctly.
     */
    function wadokeiDNAngles(): { sunsetAngle: number; sunriseAngle: number } | null {
        const leafAngleFn = env.functions.get('dayNightLeafAngle');
        if (!leafAngleFn) return null;

        const kyMode = env.variables.get('kyMode') ?? 0;
        if (kyMode === 1) {
            return { sunsetAngle: 3 * Math.PI / 2, sunriseAngle: Math.PI / 2 };
        }

        // Mode 0: standard astronomical computation
        const ECPlanetMidnightSun = env.variables.get('planetMidnightSun') ?? 10;

        const isPolarSummer = leafAngleFn(ECPlanetMidnightSun, 2, 0) > 0.5;
        const isPolarWinter = leafAngleFn(ECPlanetMidnightSun, 3, 0) > 0.5;

        if (isPolarSummer) {
            return { sunsetAngle: 0, sunriseAngle: 0 };
        }
        if (isPolarWinter) {
            return { sunsetAngle: 0, sunriseAngle: 2 * Math.PI - 0.001 };
        }

        const sunriseAngle = leafAngleFn(ECPlanetMidnightSun, 0, 0);
        const sunsetAngle = leafAngleFn(ECPlanetMidnightSun, 1, 0);
        return { sunsetAngle, sunriseAngle };
    }

    /**
     * wadokeiDNNumVisible(numWedges): compute how many wedges are needed
     * to tile the nighttime arc on a wadokei day/night ring.
     */
    env.functions.set('wadokeiDNNumVisible', (numWedges: number) => {
        if (numWedges <= 0) return 0;
        const angles = wadokeiDNAngles();
        if (!angles) return 0;

        let nightArc = angles.sunriseAngle - angles.sunsetAngle;
        if (nightArc < 0) nightArc += 2 * Math.PI;
        if (nightArc < 0.01) return 0;
        if (nightArc > 2 * Math.PI - 0.01) return numWedges;

        const wedgeSpan = (2 * Math.PI) / numWedges;
        return Math.min(numWedges, Math.max(1, Math.ceil(nightArc / wedgeSpan)));
    });

    env.functions.set('wadokeiDNSunsetAngle', () => {
        return wadokeiDNAngles()?.sunsetAngle ?? 0;
    });

    env.functions.set('wadokeiDNSunriseAngle', () => {
        return wadokeiDNAngles()?.sunriseAngle ?? 0;
    });

    // --- Wadokei day/night ring per-wedge functions (ObsValue expressions) ---
    // Each wedge's angle/slide is independently computable from astro-cached
    // scalars (numVis, sunset/sunrise) — no per-frame array cache. Ports the
    // slide / polar branches of drawQDayNightRing verbatim. Slide mode is
    // Kyoto-only, where sunsetAngle/sunriseAngle == wadokeiDN*Angle().

    // dayNightWedgeSlideAngle(planet, wedgeIndex, numWedges, slideDistance):
    // observer-frame angle for one wedge (masterOffset added at draw time).
    env.functions.set('dayNightWedgeSlideAngle',
        (_planet: number, wedgeIndex: number, numWedges: number, _slideDistance: number) => {
            const TWO_PI = 2 * Math.PI;
            const numVisFn = env.functions.get('wadokeiDNNumVisible');
            const numVis = numVisFn ? numVisFn(numWedges) : numWedges;
            const wedgeSpan = (TWO_PI + 0.2) / numWedges;

            if (numVis > 0 && numVis < numWedges) {
                const a = wadokeiDNAngles();
                const sunsetAngle = a?.sunsetAngle ?? 0;
                const sunriseAngle = a?.sunriseAngle ?? 0;
                let nightArc = sunriseAngle - sunsetAngle;
                if (nightArc < 0) nightArc += TWO_PI;
                const adjustedStart = sunsetAngle + wedgeSpan / 2;
                const adjustedArc = nightArc - wedgeSpan;
                const step = numVis > 1 ? adjustedArc / (numVis - 1) : 0;
                if (wedgeIndex < numVis) {
                    const raw = adjustedStart + step * wedgeIndex;
                    return ((raw % TWO_PI) + TWO_PI) % TWO_PI;
                }
                // Park hidden wedges at the last visible position (sunrise edge).
                return adjustedStart + step * (numVis - 1);
            }
            if (numVis === 0) {
                // Polar summer: no night — park all at 0 (all slid out anyway).
                return 0;
            }
            // Polar winter (numVis >= numWedges): even full-circle distribution.
            return TWO_PI * wedgeIndex / numWedges;
        });

    // dayNightWedgeSlideOffset(wedgeIndex, numWedges, slideDistance):
    // 0 if the wedge is visible, else slideDistance (slid under the cover disc).
    env.functions.set('dayNightWedgeSlideOffset',
        (wedgeIndex: number, numWedges: number, slideDistance: number) => {
            const numVisFn = env.functions.get('wadokeiDNNumVisible');
            const numVis = numVisFn ? numVisFn(numWedges) : numWedges;
            return wedgeIndex < numVis ? 0 : slideDistance;
        });

    // calendarCoverOffset(coverTypeCode): horizontal slide offset (XML px) for a
    // CalendarRowCover, by numeric coverType code (see CALENDAR_COVER_CODES). The
    // CalendarRowCover ObsValue's expression calls this; ported from the legacy
    // computeCalendarCoverOffset in animation.ts.
    env.functions.set('calendarCoverOffset', (coverTypeCode: number) => {
        return computeCalendarCoverOffsetForEnv(env, coverTypeCode);
    });

    // terminatorLeafAngle(phase, quad, idx, leavesPerQuad, incr): one moon-phase
    // terminator leaf's rotation angle. Wraps the pure terminatorAngle() and adds
    // π for the lower quadrants (LowerLeft=1, LowerRight=2), matching the legacy
    // tickLeafAnimations. Each leaf's angle ObsValue calls this with the part's
    // shared phase expression and the leaf's own quadrant/index.
    env.functions.set('terminatorLeafAngle',
        (phase: number, quad: number, idx: number, leavesPerQuad: number, incr: number) => {
            let a = terminatorAngle(phase, quad, idx, leavesPerQuad, incr);
            const isUpper = quad === 0 || quad === 3;  // TerminatorQuadrant: UL=0, UR=3
            if (!isUpper) a += Math.PI;
            return a;
        });

    // analemmaPathParameter(): the Sun's position *along* the analemma figure-eight,
    // as fraction-of-(vernal-equinox)-year × PATH_SAMPLE_COUNT (a cyclic value with
    // period PATH_SAMPLE_COUNT). analemmaRotation(): the sky-orientation angle.
    // These mirror updateAnalemmaValues() exactly; eval-ahead shifts getNow during
    // look-ahead, so no special handling is needed here.
    env.functions.set('analemmaPathParameter', () => {
        const di = dateToDateInterval(getNow());
        return fractionOfVernalEquinoxYear(di, null) * PATH_SAMPLE_COUNT;
    });
    env.functions.set('analemmaRotation', () => {
        const di = dateToDateInterval(getNow());
        return sunSkyOrientationAngle(di, OBSERVER_LAT, OBSERVER_LON, null);
    });

    // =========================================================================
    // Terra I — World-time ring functions
    // =========================================================================
    registerTerraFunctions(env, OBSERVER_LAT, OBSERVER_LON, getNow, pool, tzOffsetSeconds, slotOverrides, globalLocationSlot, olsonTimezone);

    // Release the cache pool
    releaseCachePool(pool);

    return env;
}

// ============================================================================
// CalendarRowCover offset
// ============================================================================

/**
 * Compute the xOffset (XML px) for a CalendarRowCover, by numeric coverType code.
 *
 * Direct port of computeCalendarCoverOffset from animation.ts (iOS
 * calendarRowCoverOffsetForType / calendarRowUnderlayOffsetForType), switched on
 * the numeric {@link CALENDAR_COVER_CODES} code instead of a string. Reads
 * calendar state (month/year/era, weekday start, cell width) from the env, using
 * the hybrid Julian/Gregorian calendar (es-calendar).
 */
function computeCalendarCoverOffsetForEnv(env: Environment, coverTypeCode: number): number {
    const calendarWeekdayStart = env.functions.get('calendarWeekdayStart')?.() ?? 0;
    const cellWidth = env.variables.get('calendarCellWidth') ?? 13.3;

    const monthNum = (env.functions.get('monthNumber')?.() ?? 0) + 1;
    const yearNum = env.functions.get('yearNumber')?.() ?? 2024;
    const era = env.functions.get('eraNumber')?.() ?? 1;
    const absYear = yearNum;

    // First of this month: compute weekday via epoch arithmetic
    const firstOfMonthDI = timeIntervalFromUTCComponents(era, absYear, monthNum, 1, 12, 0, 0);
    const thisMonthStartCol = (7 + weekdayFromTimeInterval(firstOfMonthDI, 0) - calendarWeekdayStart) % 7;

    // Days in this month and previous month (hybrid calendar)
    const dim = calendarDaysInMonth(era, absYear, monthNum);
    // Previous month: handle January → December of prior year
    let prevEra = era;
    let prevYear = absYear;
    let prevMonth = monthNum - 1;
    if (prevMonth < 1) {
        prevMonth = 12;
        if (era === 1 && absYear === 1) {
            prevEra = 0; prevYear = 1;  // 1 CE - 1 = 1 BCE
        } else if (era === 0) {
            prevYear = absYear + 1;      // further into BCE
        } else {
            prevYear = absYear - 1;
        }
    }
    const daysInPrevMonth = calendarDaysInMonth(prevEra, prevYear, prevMonth);

    // Next month: compute weekday and start row
    let nextEra = era;
    let nextYear = absYear;
    let nextMonth = monthNum + 1;
    if (nextMonth > 12) {
        nextMonth = 1;
        if (era === 0 && absYear === 1) {
            nextEra = 1; nextYear = 1;  // 1 BCE + 1 = 1 CE
        } else if (era === 0) {
            nextYear = absYear - 1;      // towards CE
        } else {
            nextYear = absYear + 1;
        }
    }
    const nextMonthFirstDI = timeIntervalFromUTCComponents(nextEra, nextYear, nextMonth, 1, 12, 0, 0);
    const nextMonthStartCol = (7 + weekdayFromTimeInterval(nextMonthFirstDI, 0) - calendarWeekdayStart) % 7;
    const nextMonthStartRow = Math.floor((dim + thisMonthStartCol) / 7);

    let columnMotion = 7;

    if (coverTypeCode === CALENDAR_COVER_CODES.row1Left) {
        columnMotion = thisMonthStartCol + 22 - daysInPrevMonth;
        if (columnMotion < -4) columnMotion = -4;
    } else if (coverTypeCode === CALENDAR_COVER_CODES.row1Right) {
        columnMotion = thisMonthStartCol + 26 - daysInPrevMonth;
        if (columnMotion < -5) columnMotion = -5;
    } else if (coverTypeCode === CALENDAR_COVER_CODES.row56Right) {
        columnMotion = nextMonthStartRow === 4 ? nextMonthStartCol : 7;
    } else if (coverTypeCode === CALENDAR_COVER_CODES.row6Left) {
        if (nextMonthStartRow === 5) {
            columnMotion = nextMonthStartCol;
        } else if (nextMonthStartRow === 4) {
            columnMotion = nextMonthStartCol - 7;
        } else {
            columnMotion = 7;
        }
    }

    return Math.round(columnMotion * cellWidth);
}

// ============================================================================
// Terra I — World-time ring functions (Chronometer-specific)
// ============================================================================

function registerTerraFunctions(
    env: Environment,
    OBSERVER_LAT: number,
    OBSERVER_LON: number,
    getNow: () => Date,
    pool: import('../astronomy/astro-cache.js').AstroCachePool,
    tzOffsetSeconds: number,
    slotOverrides?: Record<number, TerraSlot>,
    globalLocationSlot?: number,
    olsonTimezone?: string,
): void {
    const { functions } = env;

    // Terra uses 24 environment slots (1–24) for the worldtime ring cities.
    // On iOS these were 5–28; renumbered to 1-based for the web app.
    // Ring sector 0 corresponds to env slot 1.

    // Build working slot data: start with defaults, apply any overrides.
    const terraRingDefaults: Record<number, TerraSlot> = {};
    for (const [k, v] of Object.entries(TERRA_RING_DEFAULTS)) {
        terraRingDefaults[Number(k)] = { ...v };
    }
    if (slotOverrides) {
        for (const [k, v] of Object.entries(slotOverrides)) {
            terraRingDefaults[Number(k)] = { ...v };
        }
    }

    // Export the slot data, getNow, and a DST range function
    // so the dynamic ring renderer can access them.
    (env as any)._terraSlots = terraRingDefaults;
    (env as any)._getNow = getNow;

    // Callable DST range function for the renderer: returns {low, high} offset
    // in hours if DST exists, or null if no DST.
    (env as any)._getDSTRange = (slotNum: number): { lowHours: number; highHours: number } | null => {
        const slot = terraRingDefaults[slotNum];
        if (!slot) return null;
        const now = getNow();
        const jan = new Date(now.getFullYear(), 0, 1);
        const jul = new Date(now.getFullYear(), 6, 1);
        const janOff = getTzOffsetSeconds(slot.olsonId, jan);
        const julOff = getTzOffsetSeconds(slot.olsonId, jul);
        if (janOff === julOff) return null;
        return {
            lowHours: Math.min(janOff, julOff) / 3600,
            highHours: Math.max(janOff, julOff) / 3600,
        };
    };

    const UTCSectorNumber = 11;

    // --- Timezone offset computation via Intl.DateTimeFormat ---

    /**
     * Get the UTC offset in seconds for a given Olson timezone at a given Date.
     * Uses Intl.DateTimeFormat with 'longOffset' to parse "GMT+05:30" etc.
     */
    function getTzOffsetSeconds(olsonId: string, date: Date): number {
        try {
            const fmt = new Intl.DateTimeFormat('en-US', {
                timeZone: olsonId,
                timeZoneName: 'longOffset',
            });
            const parts = fmt.formatToParts(date);
            const tzPart = parts.find(p => p.type === 'timeZoneName');
            if (!tzPart) return 0;
            const tzStr = tzPart.value;
            if (tzStr === 'GMT' || tzStr === 'UTC') return 0;
            const m = tzStr.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
            if (!m) return 0;
            const sign = m[1] === '+' ? 1 : -1;
            const hours = parseInt(m[2], 10);
            const minutes = m[3] ? parseInt(m[3], 10) : 0;
            return sign * (hours * 3600 + minutes * 60);
        } catch {
            return 0;
        }
    }

    /**
     * Get local time components in a given Olson timezone.
     */
    function getLocalTimeInZone(olsonId: string, date: Date): {
        h24: number; min: number; sec: number; day: number; month: number; weekday: number;
    } {
        try {
            const fmt = new Intl.DateTimeFormat('en-US', {
                timeZone: olsonId,
                hour: 'numeric', minute: 'numeric', second: 'numeric',
                day: 'numeric', month: 'numeric', weekday: 'short',
                hour12: false,
            });
            const parts = fmt.formatToParts(date);
            let h24 = 0, min = 0, sec = 0, day = 1, month = 0, weekday = 0;
            for (const p of parts) {
                if (p.type === 'hour') h24 = parseInt(p.value, 10);
                else if (p.type === 'minute') min = parseInt(p.value, 10);
                else if (p.type === 'second') sec = parseInt(p.value, 10);
                else if (p.type === 'day') day = parseInt(p.value, 10);
                else if (p.type === 'month') month = parseInt(p.value, 10) - 1;
                else if (p.type === 'weekday') {
                    const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
                    weekday = wdMap[p.value] ?? 0;
                }
            }
            if (h24 === 24) h24 = 0;
            return { h24, min, sec, day, month, weekday };
        } catch {
            return {
                h24: date.getHours(), min: date.getMinutes(), sec: date.getSeconds(),
                day: date.getDate(), month: date.getMonth(), weekday: date.getDay(),
            };
        }
    }

    // --- Determine which ring slot goes at the top (12 o'clock) ---
    let detectedTopSlot = 12; // default: London (slot 12 = UTC)
    if (globalLocationSlot !== undefined) {
        detectedTopSlot = globalLocationSlot;
    } else {
        try {
            const targetTz = olsonTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
            for (const [slotStr, data] of Object.entries(terraRingDefaults)) {
                if (data.olsonId === targetTz) {
                    detectedTopSlot = parseInt(slotStr, 10);
                    break;
                }
            }
            if (detectedTopSlot === 12 && targetTz !== 'Europe/London' && targetTz !== 'UTC') {
                const nowDate = getNow();
                const targetOffset = getTzOffsetSeconds(targetTz, nowDate);
                let bestDiff = Infinity;
                for (const [slotStr, data] of Object.entries(terraRingDefaults)) {
                    const slotOffset = getTzOffsetSeconds(data.olsonId, nowDate);
                    const diff = Math.abs(slotOffset - targetOffset);
                    if (diff < bestDiff) {
                        bestDiff = diff;
                        detectedTopSlot = parseInt(slotStr, 10);
                    }
                }
            }
        } catch {
            // keep default
        }
    }

    functions.set('terraIDeviceSlot', () => detectedTopSlot);
    functions.set('overrideTerraITopSlot', (_n: number) => 0);

    functions.set('sectorAngle', (slot: number, topSlot: number) => {
        return (slot - topSlot) * Math.PI / 12;
    });

    functions.set('UTCSectorOffset', () => UTCSectorNumber - 0.5);

    functions.set('cityIndicatorOffset', (_topSlot: number, _firstRingSlot: number) => 0);

    functions.set('city24HrDialOffset', (topSlot: number, firstRingSlot: number) => {
        const slot = terraRingDefaults[topSlot];
        if (!slot) return 0;
        const offsetSec = getTzOffsetSeconds(slot.olsonId, getNow());
        return offsetSec * Math.PI / (12 * 3600) + (firstRingSlot - topSlot + UTCSectorNumber - 0.5) * Math.PI / 12;
    });

    functions.set('tzOffsetAngleN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const offsetSec = getTzOffsetSeconds(data.olsonId, getNow());
        return offsetSec * Math.PI / (12 * 3600);
    });

    functions.set('isDST', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const nowDate = getNow();
        const currentOffset = getTzOffsetSeconds(data.olsonId, nowDate);
        const jan = new Date(nowDate.getFullYear(), 0, 1);
        const janOffset = getTzOffsetSeconds(data.olsonId, jan);
        const jul = new Date(nowDate.getFullYear(), 6, 1);
        const julOffset = getTzOffsetSeconds(data.olsonId, jul);
        const stdOffset = Math.min(janOffset, julOffset);
        return currentOffset !== stdOffset ? 1 : 0;
    });

    functions.set('moreDay', (slot: number, topSlot: number) => {
        const slotData = terraRingDefaults[slot];
        const topData = terraRingDefaults[topSlot];
        if (!slotData || !topData) return 0;
        const nowDate = getNow();
        const slotTime = getLocalTimeInZone(slotData.olsonId, nowDate);
        const topTime = getLocalTimeInZone(topData.olsonId, nowDate);
        if (slotTime.month !== topTime.month) {
            const slotM = slotTime.month;
            const topM = topTime.month;
            if (slotM === 0 && topM === 11) return 1;
            if (slotM === 11 && topM === 0) return 0;
            return slotM > topM ? 1 : 0;
        }
        return slotTime.day > topTime.day ? 1 : 0;
    });

    functions.set('lessDay', (slot: number, topSlot: number) => {
        const slotData = terraRingDefaults[slot];
        const topData = terraRingDefaults[topSlot];
        if (!slotData || !topData) return 0;
        const nowDate = getNow();
        const slotTime = getLocalTimeInZone(slotData.olsonId, nowDate);
        const topTime = getLocalTimeInZone(topData.olsonId, nowDate);
        if (slotTime.month !== topTime.month) {
            const slotM = slotTime.month;
            const topM = topTime.month;
            if (slotM === 0 && topM === 11) return 0;
            if (slotM === 11 && topM === 0) return 1;
            return slotM < topM ? 1 : 0;
        }
        return slotTime.day < topTime.day ? 1 : 0;
    });

    // --- N-suffixed time functions (per-slot time in the slot's timezone) ---

    functions.set('hour12ValueAngleN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const t = getLocalTimeInZone(data.olsonId, getNow());
        const ms = getNow().getMilliseconds();
        const s = t.sec + ms / 1000;
        const m = t.min + s / 60;
        const h = (t.h24 % 12) + m / 60;
        return h * 2 * Math.PI / 12;
    });

    functions.set('minuteValueAngleN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const t = getLocalTimeInZone(data.olsonId, getNow());
        const ms = getNow().getMilliseconds();
        const s = t.sec + ms / 1000;
        const m = t.min + s / 60;
        return m * 2 * Math.PI / 60;
    });

    functions.set('secondValueAngleN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const t = getLocalTimeInZone(data.olsonId, getNow());
        const ms = getNow().getMilliseconds();
        const s = t.sec + ms / 1000;
        return s * 2 * Math.PI / 60;
    });

    functions.set('dayNumberN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const t = getLocalTimeInZone(data.olsonId, getNow());
        return t.day - 1;
    });

    functions.set('monthNumberAngleN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const t = getLocalTimeInZone(data.olsonId, getNow());
        return t.month * 2 * Math.PI / 12;
    });

    functions.set('weekdayNumberAngleN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const t = getLocalTimeInZone(data.olsonId, getNow());
        return t.weekday * 2 * Math.PI / 7;
    });

    functions.set('weekdayNumberN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        return getLocalTimeInZone(data.olsonId, getNow()).weekday;
    });

    functions.set('hour24NumberN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        return getLocalTimeInZone(data.olsonId, getNow()).h24;
    });

    functions.set('hour24ValueAngleN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const t = getLocalTimeInZone(data.olsonId, getNow());
        const ms = getNow().getMilliseconds();
        const s = t.sec + ms / 1000;
        const m = t.min + s / 60;
        const h = t.h24 + m / 60;
        return h * 2 * Math.PI / 24;
    });

    // dayNightLeafAngleForSlot(planet, leaf, numLeaves, slotNumber):
    // Like dayNightLeafAngle but uses the slot's city lat/lon for astronomy.
    functions.set('dayNightLeafAngleForSlot',
        (planetNumber: number, leafNumber: number, numLeaves: number, slotNumber: number) => {
            const slot = terraRingDefaults[slotNumber];
            if (!slot) {
                // Fallback to observer location
                return computeDayNightLeafAngle(
                    planetNumber, leafNumber, numLeaves,
                    getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds,
                ).angle;
            }
            const slotLat = slot.lat * Math.PI / 180;
            const slotLon = slot.lon * Math.PI / 180;
            const slotTzOffset = getTzOffsetSeconds(slot.olsonId, getNow());
            return computeDayNightLeafAngle(
                planetNumber, leafNumber, numLeaves,
                getNow, slotLat, slotLon, pool, slotTzOffset,
            ).angle;
        },
    );
}
