/**
 * Astronomy cache system.
 *
 * TypeScript port of the ECAstroCache slot-based caching system from ESAstronomyCache.hpp/cpp.
 * Now includes the full cache slot enum (location-independent + location-dependent)
 * and the cache pool system needed for rise/set iteration.
 */

// ============================================================================
// Cache Slot Indices
// ============================================================================

/**
 * Full cache slot enum matching ESAstronomyCache.hpp CacheSlotIndex.
 *
 * The WB (Willmann-Bell) slots are a subset of these. The old WBCacheSlot
 * enum values are maintained as aliases via the mapping in the WB modules.
 */
export const enum CacheSlot {
    // ============================
    // Location-independent slots
    // ============================
    priorUTMidnight = 0,
    sunEclipticLongitude,
    sunRA,
    sunDecl,
    sunRAJ2000,
    sunDeclJ2000,
    sunTrueAnomaly,
    sunMeanAnomaly,
    moonRA,
    moonDecl,
    moonRAJ2000,
    moonDeclJ2000,
    moonEclipticLongitude,
    moonCorrectedAnomaly,
    eotForDay,
    moonAge,
    moonPhase,
    nextMoonPhase,
    prevMoonPhase,
    closestNewMoon,
    closestFullMoon,
    closestFirstQuarter,
    closestThirdQuarter,
    closestSunEclipticLongitude,
    closestSunEclipticLongitude1,
    closestSunEclipticLongitude2,
    closestSunEclipticLongitude3,
    closestSunEclipticLongIndicatorAngle,
    closestSunEclipticLongIndicatorAngle1,
    closestSunEclipticLongIndicatorAngle2,
    closestSunEclipticLongIndicatorAngle3,
    nextNewMoon,
    nextFullMoon,
    nextFirstQuarter,
    nextThirdQuarter,
    moonPositionAngle,
    vernalEquinox,
    moonAscendingNodeLongitude,
    moonAscendingNodeRA,
    moonAscendingNodeDecl,
    moonAscendingNodeRAJ2000,
    moonAscendingNodeDeclJ2000,
    precession,
    calendarError,
    realMoonAgeAngle,
    tdtCenturies,
    tdtCenturiesDeltaT,
    tdtHundredCenturies,

    // WB-specific location-independent slots
    WBAscendingNodeLongitude,
    WBLunarLongitudeLow,
    WBLunarLongitudeMid,
    WBLunarLongitudeFull,
    WBLunarLatitudeLow,
    WBLunarLatitudeMid,
    WBLunarLatitudeFull,
    WBLunarDistanceLow,
    WBLunarDistanceMid,
    WBLunarDistanceFull,
    WBMoonRALow,
    WBMoonRAMid,
    WBMoonRAFull,
    WBMoonDeclLow,
    WBMoonDeclMid,
    WBMoonDeclFull,
    WBMoonEclipticLongitudeLow,
    WBMoonEclipticLongitudeMid,
    WBMoonEclipticLongitudeFull,
    WBMoonEclipticLatitudeLow,
    WBMoonEclipticLatitudeMid,
    WBMoonEclipticLatitudeFull,
    WBMoonDistanceLow,
    WBMoonDistanceMid,
    WBMoonDistanceFull,
    WBSunLongitude,
    WBSunLongitudeApparent,
    WBSunRadius,
    WBNutation,
    WBObliquity,

    // Planet heliocentric slots (10 planets each)
    planetHeliocentricLongitude,   // base for +0..+9
    planetHeliocentricLongitude1,
    planetHeliocentricLongitude2,
    planetHeliocentricLongitude3,
    planetHeliocentricLongitude4,
    planetHeliocentricLongitude5,
    planetHeliocentricLongitude6,
    planetHeliocentricLongitude7,
    planetHeliocentricLongitude8,
    planetHeliocentricLongitude9,
    planetHeliocentricLatitude,
    planetHeliocentricLatitude1,
    planetHeliocentricLatitude2,
    planetHeliocentricLatitude3,
    planetHeliocentricLatitude4,
    planetHeliocentricLatitude5,
    planetHeliocentricLatitude6,
    planetHeliocentricLatitude7,
    planetHeliocentricLatitude8,
    planetHeliocentricLatitude9,
    planetHeliocentricRadius,
    planetHeliocentricRadius1,
    planetHeliocentricRadius2,
    planetHeliocentricRadius3,
    planetHeliocentricRadius4,
    planetHeliocentricRadius5,
    planetHeliocentricRadius6,
    planetHeliocentricRadius7,
    planetHeliocentricRadius8,
    planetHeliocentricRadius9,
    planetGeocentricDistance,
    planetGeocentricDistance1,
    planetGeocentricDistance2,
    planetGeocentricDistance3,
    planetGeocentricDistance4,
    planetGeocentricDistance5,
    planetGeocentricDistance6,
    planetGeocentricDistance7,
    planetGeocentricDistance8,
    planetGeocentricDistance9,
    planetEclipticLongitude,
    planetEclipticLongitude1,
    planetEclipticLongitude2,
    planetEclipticLongitude3,
    planetEclipticLongitude4,
    planetEclipticLongitude5,
    planetEclipticLongitude6,
    planetEclipticLongitude7,
    planetEclipticLongitude8,
    planetEclipticLongitude9,
    planetEclipticLatitude,
    planetEclipticLatitude1,
    planetEclipticLatitude2,
    planetEclipticLatitude3,
    planetEclipticLatitude4,
    planetEclipticLatitude5,
    planetEclipticLatitude6,
    planetEclipticLatitude7,
    planetEclipticLatitude8,
    planetEclipticLatitude9,

    // ============================
    // Location-dependent slots
    // ============================
    firstLocationDependent,
    nextSunrise = firstLocationDependent,
    prevSunrise,
    nextMoonrise,
    prevMoonrise,
    nextSunset,
    prevSunset,
    nextSuntransit,
    nextMoonset,
    prevMoonset,
    nextMoontransit,
    sunriseForDay,
    sunsetForDay,
    moonriseForDay,
    moonsetForDay,
    suntransitForDay,
    moontransitForDay,
    moonRelativePositionAngle,
    moonRelativeAngle,
    sunAltitude,
    sunAzimuth,
    moonAltitude,
    moonAzimuth,
    azimuthOfHighestEcliptic,
    longitudeOfHighestEcliptic,
    eclipticAltitude,
    longitudeOfEclipticMeridian,
    meridianTime,
    moonMeridianTime,
    lst,
    eclipseAngularSeparation,
    eclipseSeparation,
    eclipseShadowAngularSize,
    eclipseKind,

    // Planet location-dependent (10 per category)
    planetIsUp,    // +0..+9
    planetIsUp1, planetIsUp2, planetIsUp3, planetIsUp4,
    planetIsUp5, planetIsUp6, planetIsUp7, planetIsUp8, planetIsUp9,

    nextPlanetrise,
    nextPlanetrise1, nextPlanetrise2, nextPlanetrise3, nextPlanetrise4,
    nextPlanetrise5, nextPlanetrise6, nextPlanetrise7, nextPlanetrise8, nextPlanetrise9,

    nextPlanetset,
    nextPlanetset1, nextPlanetset2, nextPlanetset3, nextPlanetset4,
    nextPlanetset5, nextPlanetset6, nextPlanetset7, nextPlanetset8, nextPlanetset9,

    nextPlanettransit,
    nextPlanettransit1, nextPlanettransit2, nextPlanettransit3, nextPlanettransit4,
    nextPlanettransit5, nextPlanettransit6, nextPlanettransit7, nextPlanettransit8, nextPlanettransit9,

    nextPlanettransitLow,
    nextPlanettransitLow1, nextPlanettransitLow2, nextPlanettransitLow3, nextPlanettransitLow4,
    nextPlanettransitLow5, nextPlanettransitLow6, nextPlanettransitLow7, nextPlanettransitLow8, nextPlanettransitLow9,

    prevPlanetrise,
    prevPlanetrise1, prevPlanetrise2, prevPlanetrise3, prevPlanetrise4,
    prevPlanetrise5, prevPlanetrise6, prevPlanetrise7, prevPlanetrise8, prevPlanetrise9,

    prevPlanetset,
    prevPlanetset1, prevPlanetset2, prevPlanetset3, prevPlanetset4,
    prevPlanetset5, prevPlanetset6, prevPlanetset7, prevPlanetset8, prevPlanetset9,

    prevPlanettransit,
    prevPlanettransit1, prevPlanettransit2, prevPlanettransit3, prevPlanettransit4,
    prevPlanettransit5, prevPlanettransit6, prevPlanettransit7, prevPlanettransit8, prevPlanettransit9,

    prevPlanettransitLow,
    prevPlanettransitLow1, prevPlanettransitLow2, prevPlanettransitLow3, prevPlanettransitLow4,
    prevPlanettransitLow5, prevPlanettransitLow6, prevPlanettransitLow7, prevPlanettransitLow8, prevPlanettransitLow9,

    // Day/night master rise/set search outputs — raw event/transit *times*
    // (seconds since the 2001 epoch, or the ±1e18 always-above/below sentinels),
    // NOT angles. Memoized once per (planet, date, lat, lon) and shared by every
    // wedge/indicator in a tick. See getMasterRiseSet() in astro-env.ts.
    // 10 slots per category (planet 0..9).
    dayNightMasterRiseTime,
    dayNightMasterRiseTime1, dayNightMasterRiseTime2, dayNightMasterRiseTime3,
    dayNightMasterRiseTime4, dayNightMasterRiseTime5, dayNightMasterRiseTime6,
    dayNightMasterRiseTime7, dayNightMasterRiseTime8, dayNightMasterRiseTime9,

    dayNightMasterSetTime,
    dayNightMasterSetTime1, dayNightMasterSetTime2, dayNightMasterSetTime3,
    dayNightMasterSetTime4, dayNightMasterSetTime5, dayNightMasterSetTime6,
    dayNightMasterSetTime7, dayNightMasterSetTime8, dayNightMasterSetTime9,

    dayNightMasterRiseTransitTime,
    dayNightMasterRiseTransitTime1, dayNightMasterRiseTransitTime2, dayNightMasterRiseTransitTime3,
    dayNightMasterRiseTransitTime4, dayNightMasterRiseTransitTime5, dayNightMasterRiseTransitTime6,
    dayNightMasterRiseTransitTime7, dayNightMasterRiseTransitTime8, dayNightMasterRiseTransitTime9,

    dayNightMasterSetTransitTime,
    dayNightMasterSetTransitTime1, dayNightMasterSetTransitTime2, dayNightMasterSetTransitTime3,
    dayNightMasterSetTransitTime4, dayNightMasterSetTransitTime5, dayNightMasterSetTransitTime6,
    dayNightMasterSetTransitTime7, dayNightMasterSetTransitTime8, dayNightMasterSetTransitTime9,

    dayNightMasterRiseAngleLST,
    dayNightMasterRiseAngleLST1, dayNightMasterRiseAngleLST2, dayNightMasterRiseAngleLST3,
    dayNightMasterRiseAngleLST4, dayNightMasterRiseAngleLST5, dayNightMasterRiseAngleLST6,
    dayNightMasterRiseAngleLST7, dayNightMasterRiseAngleLST8, dayNightMasterRiseAngleLST9,

    dayNightMasterSetAngleLST,
    dayNightMasterSetAngleLST1, dayNightMasterSetAngleLST2, dayNightMasterSetAngleLST3,
    dayNightMasterSetAngleLST4, dayNightMasterSetAngleLST5, dayNightMasterSetAngleLST6,
    dayNightMasterSetAngleLST7, dayNightMasterSetAngleLST8, dayNightMasterSetAngleLST9,

    dayNightMasterRTransitAngleLST,
    dayNightMasterRTransitAngleLST1, dayNightMasterRTransitAngleLST2, dayNightMasterRTransitAngleLST3,
    dayNightMasterRTransitAngleLST4, dayNightMasterRTransitAngleLST5, dayNightMasterRTransitAngleLST6,
    dayNightMasterRTransitAngleLST7, dayNightMasterRTransitAngleLST8, dayNightMasterRTransitAngleLST9,

    dayNightMasterSTransitAngleLST,
    dayNightMasterSTransitAngleLST1, dayNightMasterSTransitAngleLST2, dayNightMasterSTransitAngleLST3,
    dayNightMasterSTransitAngleLST4, dayNightMasterSTransitAngleLST5, dayNightMasterSTransitAngleLST6,
    dayNightMasterSTransitAngleLST7, dayNightMasterSTransitAngleLST8, dayNightMasterSTransitAngleLST9,

    // Twilight/golden hour for-day slots
    sunGoldenHourMorning,
    sunRiseMorning,
    sunCivilTwilightMorning,
    sunNauticalTwilightMorning,
    sunAstroTwilightMorning,
    sunGoldenHourEvening,
    sunSetEvening,
    sunCivilTwilightEvening,
    sunNauticalTwilightEvening,
    sunAstroTwilightEvening,

    // Planet for-day slots
    planetriseForDay,
    planetriseForDay1, planetriseForDay2, planetriseForDay3, planetriseForDay4,
    planetriseForDay5, planetriseForDay6, planetriseForDay7, planetriseForDay8, planetriseForDay9,

    planetsetForDay,
    planetsetForDay1, planetsetForDay2, planetsetForDay3, planetsetForDay4,
    planetsetForDay5, planetsetForDay6, planetsetForDay7, planetsetForDay8, planetsetForDay9,

    planettransitForDay,
    planettransitForDay1, planettransitForDay2, planettransitForDay3, planettransitForDay4,
    planettransitForDay5, planettransitForDay6, planettransitForDay7, planettransitForDay8, planettransitForDay9,

    // Planet alt/az/RA/decl slots
    planetAltitude,
    planetAltitude1, planetAltitude2, planetAltitude3, planetAltitude4,
    planetAltitude5, planetAltitude6, planetAltitude7, planetAltitude8, planetAltitude9,

    planetAzimuth,
    planetAzimuth1, planetAzimuth2, planetAzimuth3, planetAzimuth4,
    planetAzimuth5, planetAzimuth6, planetAzimuth7, planetAzimuth8, planetAzimuth9,

    planetRA,
    planetRA1, planetRA2, planetRA3, planetRA4,
    planetRA5, planetRA6, planetRA7, planetRA8, planetRA9,

    planetDecl,
    planetDecl1, planetDecl2, planetDecl3, planetDecl4,
    planetDecl5, planetDecl6, planetDecl7, planetDecl8, planetDecl9,

    planetRATopo,
    planetRATopo1, planetRATopo2, planetRATopo3, planetRATopo4,
    planetRATopo5, planetRATopo6, planetRATopo7, planetRATopo8, planetRATopo9,

    planetDeclTopo,
    planetDeclTopo1, planetDeclTopo2, planetDeclTopo3, planetDeclTopo4,
    planetDeclTopo5, planetDeclTopo6, planetDeclTopo7, planetDeclTopo8, planetDeclTopo9,

    planetMeridianTime,
    planetMeridianTime1, planetMeridianTime2, planetMeridianTime3, planetMeridianTime4,
    planetMeridianTime5, planetMeridianTime6, planetMeridianTime7, planetMeridianTime8, planetMeridianTime9,

    // moonAge (= moon − sun ecliptic longitude) at local midnight + (offset − 14) days,
    // i.e. slot index `offset = n + 14` for delta-day n ∈ [−14, +14] — one synodic month
    // centered on today, the DEL ring's range (see Selene-I.xml). Memoizes the ring's 29
    // distinct offset-time moonAge computes per display time, shared by all its wedges.
    // LOCATION-DEPENDENT on purpose: the value is location-independent at a fixed instant,
    // but the instant ("local midnight") depends on the observer timezone, so these must
    // invalidate on a location/tz change — hence their placement after firstLocationDependent.
    // See planning/2026-06-28-per-tick-astronomy-memoization.md §5.
    moonAgeAtDayOffset,    // offset 0 (n = −14)
    moonAgeAtDayOffset1, moonAgeAtDayOffset2, moonAgeAtDayOffset3, moonAgeAtDayOffset4,
    moonAgeAtDayOffset5, moonAgeAtDayOffset6, moonAgeAtDayOffset7, moonAgeAtDayOffset8, moonAgeAtDayOffset9,
    moonAgeAtDayOffset10, moonAgeAtDayOffset11, moonAgeAtDayOffset12, moonAgeAtDayOffset13, moonAgeAtDayOffset14,
    moonAgeAtDayOffset15, moonAgeAtDayOffset16, moonAgeAtDayOffset17, moonAgeAtDayOffset18, moonAgeAtDayOffset19,
    moonAgeAtDayOffset20, moonAgeAtDayOffset21, moonAgeAtDayOffset22, moonAgeAtDayOffset23, moonAgeAtDayOffset24,
    moonAgeAtDayOffset25, moonAgeAtDayOffset26, moonAgeAtDayOffset27, moonAgeAtDayOffset28,  // offset 28 (n = +14)

    /** Total number of cache slots. */
    NUM_SLOTS,
}

// ============================================================================
// Cache statistics
// ============================================================================

/**
 * Always-on invalidation counter (the astroProfile pattern — one integer add
 * per re-key, kept cheap for the hot path). Under exact-match re-keying an
 * unfrozen eval storm has no functional symptom — every value is individually
 * correct, just recomputed per elapsed-ms cohort — so this counter is what
 * makes such a regression visible: it is reset by resetAstroProfile() and
 * reported (with a warn threshold) in the [scrub-perf] block.
 * See planning/2026-08-22-slop-hardening.md §1.
 */
export const cacheStats = {
    invalidations: 0,
};

// ============================================================================
// AstroCache class
// ============================================================================

/**
 * Slot-based cache mirroring the original ECAstroCache struct.
 *
 * Each slot stores a numeric value and a validity flag. The `currentFlag`
 * counter is bumped whenever the time changes, which invalidates all
 * previously cached values without needing to clear the arrays.
 */
export class AstroCache {
    /** Cached values. */
    cacheSlots: Float64Array;

    /** Validity flags — a slot is valid iff its flag equals `currentFlag`. */
    cacheSlotValidFlag: Uint32Array;

    /** Bumped each time the cache is invalidated (i.e. time changes). */
    currentFlag: number;

    /** The global validity flag matched at the time this cache was last set up. */
    globalValidFlag: number;

    /** The date interval this cache was set up for. */
    dateInterval: number;

    constructor(numSlots: number = CacheSlot.NUM_SLOTS) {
        this.cacheSlots = new Float64Array(numSlots);
        this.cacheSlotValidFlag = new Uint32Array(numSlots);
        this.currentFlag = 1;  // Start at 1; flags initialize to 0, so all are initially invalid
        this.globalValidFlag = 0;
        this.dateInterval = NaN;
    }

    /** Check whether a given slot contains a valid cached value. */
    isValid(slotIndex: number): boolean {
        return this.cacheSlotValidFlag[slotIndex] === this.currentFlag;
    }

    /** Retrieve the cached value for a slot (caller must check isValid first). */
    get(slotIndex: number): number {
        return this.cacheSlots[slotIndex];
    }

    /** Store a value into a cache slot and mark it as valid. */
    set(slotIndex: number, value: number): void {
        this.cacheSlots[slotIndex] = value;
        this.cacheSlotValidFlag[slotIndex] = this.currentFlag;
    }

    /** Invalidate all cached values by bumping the flag. */
    invalidate(): void {
        if (this.currentFlag === 0xFFFFFFFF) {
            // Overflow guard (very rare): reinitialize
            this.currentFlag = 1;
            this.cacheSlotValidFlag.fill(0);
        } else {
            this.currentFlag++;
        }
    }
}

// ============================================================================
// Astro Cache Pool
// ============================================================================

/**
 * A pool of caches used for different computation contexts.
 * Mirrors the C++ ECAstroCachePool struct.
 */
export class AstroCachePool {
    observerLatitude: number = 0;
    observerLongitude: number = 0;
    runningBackward: boolean = false;
    tzOffsetSeconds: number = 0;
    currentGlobalCacheFlag: number = 1;

    /** The main cache, used for the "current" time. */
    finalCache: AstroCache = new AstroCache();

    /** Cache used during rise/set refinement iterations. */
    refinementCache: AstroCache = new AstroCache();

    /** Cache for UT midnight calculations. */
    midnightCache: AstroCache = new AstroCache();

    /** The currently active cache in this pool. */
    currentCache: AstroCache | null = null;
}

// ============================================================================
// Cache Pool Operations
// ============================================================================

/**
 * Bump location-independent slot validity flags when location changes.
 * This preserves cached values that don't depend on location while
 * invalidating location-dependent ones.
 */
function bumpValidFlagsForLocationIndependentSlots(
    cache: AstroCache,
    oldGlobalFlag: number,
): void {
    for (let i = 0; i < CacheSlot.firstLocationDependent; i++) {
        if (cache.cacheSlotValidFlag[i] === oldGlobalFlag) {
            cache.cacheSlotValidFlag[i]++;
        }
    }
}

/**
 * Initialize a cache pool with observer parameters.
 * Sets up the global cache flag, handling location-change optimization.
 */
export function initializeCachePool(
    pool: AstroCachePool,
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    runningBackward: boolean = false,
    tzOffsetSeconds: number = 0,
): void {
    // Update global flag based on what changed
    if (runningBackward !== pool.runningBackward) {
        pool.runningBackward = runningBackward;
        pool.currentGlobalCacheFlag++;
    } else if (
        tzOffsetSeconds !== pool.tzOffsetSeconds ||
        observerLatitude !== pool.observerLatitude ||
        observerLongitude !== pool.observerLongitude
    ) {
        pool.observerLatitude = observerLatitude;
        pool.observerLongitude = observerLongitude;
        pool.tzOffsetSeconds = tzOffsetSeconds;
        const oldGlobalFlag = pool.currentGlobalCacheFlag++;
        bumpValidFlagsForLocationIndependentSlots(pool.finalCache, oldGlobalFlag);
        bumpValidFlagsForLocationIndependentSlots(pool.midnightCache, oldGlobalFlag);
    }

    // Push the final cache as the current cache
    pushECAstroCacheInPool(pool, pool.finalCache, dateInterval);
}

/**
 * Set the given cache active in the pool, returning the previously active cache.
 * If the date has changed at all, the cache is invalidated: re-keying is an
 * exact-match test, so a value evaluated at time t always uses a cache valid
 * for exactly t. (Historically this tolerated a slop — 2.0 s on iOS, then
 * 0.5 s here — which could serve slots computed up to that far from the
 * requested time; see planning/2026-08-22-astro-slop-zero.md for why that was
 * retired. Within one frozen frame, same-group pushes carry bit-identical
 * dateIntervals, so cross-part sharing is unaffected.)
 */
export function pushECAstroCacheInPool(
    pool: AstroCachePool,
    valueCache: AstroCache,
    dateInterval: number,
): AstroCache | null {
    const oldCache = pool.currentCache;
    pool.currentCache = valueCache;

    if (valueCache.currentFlag === 0) {
        valueCache.currentFlag = 1;
    }

    // Check if we need to invalidate
    let needsInvalidation = false;

    if (valueCache.globalValidFlag !== pool.currentGlobalCacheFlag) {
        valueCache.globalValidFlag = pool.currentGlobalCacheFlag;
        needsInvalidation = true;
    } else if (!Object.is(valueCache.dateInterval, dateInterval)) {
        // Exact-match re-keying: any real time change invalidates. SameValue
        // (not !==) so repeated NaN pushes — eval-ahead toward a "never"
        // boundary — stay a no-op instead of invalidating on every push.
        needsInvalidation = true;
    }

    if (needsInvalidation) {
        cacheStats.invalidations++;
        valueCache.invalidate();
        valueCache.dateInterval = dateInterval;
    }

    return oldCache;
}

/**
 * Pop back to a previously active cache.
 */
export function popECAstroCacheToInPool(
    pool: AstroCachePool,
    previousCache: AstroCache | null,
): void {
    pool.currentCache = previousCache;
}

/**
 * Release the cache pool (set current cache to null).
 */
export function releaseCachePool(pool: AstroCachePool): void {
    pool.currentCache = null;
}

/**
 * Invalidate every cache in the pool — O(1) per cache (bumps each
 * `currentFlag`; no arrays are cleared).
 *
 * Used by the per-tick env-rebuild guard: when a scrub tick skips the full
 * environment rebuild (timezone offset unchanged), this restores the exact
 * semantics a rebuild would have had — a pool whose slots are all invalid at
 * tick start — so no value computed at a previous tick's time (or a previous
 * tick's eval-ahead boundary) can be served for the current tick.
 */
export function invalidateCachePool(pool: AstroCachePool): void {
    cacheStats.invalidations++;  // one deliberate whole-pool invalidation, counted once
    pool.finalCache.invalidate();
    pool.refinementCache.invalidate();
    pool.midnightCache.invalidate();
}

// ============================================================================
// Legacy WBCacheSlot mapping
// ============================================================================

/**
 * Maps old WBCacheSlot values to new CacheSlot values.
 * This ensures the existing WB modules work with the expanded cache.
 */
export const enum WBCacheSlot {
    AscendingNodeLongitude = CacheSlot.WBAscendingNodeLongitude,

    LunarLongitudeLow  = CacheSlot.WBLunarLongitudeLow,
    LunarLongitudeMid  = CacheSlot.WBLunarLongitudeMid,
    LunarLongitudeFull  = CacheSlot.WBLunarLongitudeFull,

    LunarLatitudeLow  = CacheSlot.WBLunarLatitudeLow,
    LunarLatitudeMid  = CacheSlot.WBLunarLatitudeMid,
    LunarLatitudeFull  = CacheSlot.WBLunarLatitudeFull,

    LunarDistanceLow  = CacheSlot.WBLunarDistanceLow,
    LunarDistanceMid  = CacheSlot.WBLunarDistanceMid,
    LunarDistanceFull  = CacheSlot.WBLunarDistanceFull,

    MoonRALow           = CacheSlot.WBMoonRALow,
    MoonRAMid           = CacheSlot.WBMoonRAMid,
    MoonRAFull          = CacheSlot.WBMoonRAFull,

    MoonDeclLow         = CacheSlot.WBMoonDeclLow,
    MoonDeclMid         = CacheSlot.WBMoonDeclMid,
    MoonDeclFull        = CacheSlot.WBMoonDeclFull,

    MoonEclipticLongitudeLow  = CacheSlot.WBMoonEclipticLongitudeLow,
    MoonEclipticLongitudeMid  = CacheSlot.WBMoonEclipticLongitudeMid,
    MoonEclipticLongitudeFull = CacheSlot.WBMoonEclipticLongitudeFull,

    MoonEclipticLatitudeLow  = CacheSlot.WBMoonEclipticLatitudeLow,
    MoonEclipticLatitudeMid  = CacheSlot.WBMoonEclipticLatitudeMid,
    MoonEclipticLatitudeFull = CacheSlot.WBMoonEclipticLatitudeFull,

    MoonDistanceLow  = CacheSlot.WBMoonDistanceLow,
    MoonDistanceMid  = CacheSlot.WBMoonDistanceMid,
    MoonDistanceFull = CacheSlot.WBMoonDistanceFull,

    SunLongitude          = CacheSlot.WBSunLongitude,
    SunLongitudeApparent  = CacheSlot.WBSunLongitudeApparent,
    SunRadius             = CacheSlot.WBSunRadius,

    Nutation   = CacheSlot.WBNutation,
    Obliquity  = CacheSlot.WBObliquity,

    /** Total number of WB-specific cache slots (kept for backward compat). */
    NUM_SLOTS  = CacheSlot.NUM_SLOTS,
}
