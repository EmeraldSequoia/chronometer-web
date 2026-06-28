/**
 * Animation primitives + update-interval scheduling, shared by the ObsValue
 * system (see shared/obs-value.ts + shared/updater.ts).
 *
 * Two-time-base architecture (see planning/2026-04-10-animation-strategy.md):
 * - **Display time** (getNow) evaluates expressions — WHAT the target should be.
 * - **Real time** (performance.now) drives interpolation — WHERE it is drawn now.
 *
 * This module owns the low-level pieces only:
 *  - `AnimatingValue` + `makeAnimatingValue` — the raw interpolation state.
 *  - `startAnimationRaw` / `startValueAnimation` / `interpolateValue` — the
 *    period-aware (angle / linear / cyclic) animation start + interpolation.
 *  - `computeNextBoundary` / `displayTimeToPerfNow` + the update-interval
 *    sentinel resolvers (sunrise/sunset/eclipse/sslat …) — scheduling.
 *
 * The former per-part `HandState` / `tickAnimations` driver was retired when
 * Chronometer moved onto the shared `Updater` (planning/2026-06-15-chronometer-
 * obsvalue-port.md); per-frame driving now lives in shared/updater.ts.
 */

import type { Environment } from '../expr/env.js';
import { dateToDateInterval } from '../astronomy/es-time.js';
import { sunRAandDecl } from '../astronomy/es-coordinates.js';
import { calculateEclipse } from '../astronomy/es-astro.js';
import { planetaryRiseSetTimeRefined } from '../astronomy/es-riseset.js';
import { ECPlanetNumber, isNoRiseSet } from '../astronomy/astro-constants.js';
import { AstroCachePool, initializeCachePool, releaseCachePool } from '../astronomy/astro-cache.js';

// Constants used by the scheduler
export const SCHEDULER_LOOKAHEAD_MS = 50; // arm setTimeout this many ms early to avoid skipping boundaries

// ============================================================================
// Constants (from ECConstants.h)
// ============================================================================

/** Base angular animation speed (radians per second). */
const kECGLAngleAnimationSpeed = 2.0;

/** Minimum animation duration; below this, snap directly. */
const kECGLFrameRate = 1.0 / 240;

/** Base linear animation speed (pixels per second). */
const kECGLLinearAnimationSpeed = 60.0;

// --- Named update interval sentinels (matching iOS ECConstants.h) ---
// Negative values that the animation system interprets specially.
export const EC_UPDATE_NEXT_SUNRISE              = -1001;
export const EC_UPDATE_NEXT_SUNSET               = -1002;
export const EC_UPDATE_NEXT_MOONRISE             = -1003;
export const EC_UPDATE_NEXT_MOONSET              = -1004;
export const EC_UPDATE_NEXT_SUNRISE_OR_MIDNIGHT  = -1005;
export const EC_UPDATE_NEXT_SUNSET_OR_MIDNIGHT   = -1006;
export const EC_UPDATE_NEXT_MOONRISE_OR_MIDNIGHT = -1007;
export const EC_UPDATE_NEXT_MOONSET_OR_MIDNIGHT  = -1008;
export const EC_UPDATE_ENV_CHANGE_ONLY           = -1013;
export const EC_UPDATE_NEXT_SUNRISE_OR_SUNSET    = -1016;
export const EC_UPDATE_NEXT_MOONRISE_OR_MOONSET  = -1017;
export const EC_UPDATE_NEXT_SSLAT_CHANGE         = -1018;
export const EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION = -1019;

// --- Generic planet rise/set sentinels (Observatory) ---
// Encoding: -2000 - planetNumber*2 - (set ? 1 : 0)
// Decode:   planetNumber = ((-sentinel - 2000) >> 1), isSet = ((-sentinel - 2000) & 1)
const PLANET_SENTINEL_BASE = -2000;

/** Create a sentinel for "update at next rise of planet N". */
export function EC_UPDATE_NEXT_PLANET_RISE(planet: number): number {
    return PLANET_SENTINEL_BASE - planet * 2;
}
/** Create a sentinel for "update at next set of planet N". */
export function EC_UPDATE_NEXT_PLANET_SET(planet: number): number {
    return PLANET_SENTINEL_BASE - planet * 2 - 1;
}
/** Test whether a sentinel value is a planet rise/set encoding. */
function isPlanetRiseSetSentinel(sentinel: number): boolean {
    return sentinel <= PLANET_SENTINEL_BASE;
}
/** Decode a planet rise/set sentinel. */
function decodePlanetSentinel(sentinel: number): { planet: number; isRise: boolean } {
    const offset = -sentinel + PLANET_SENTINEL_BASE;
    return { planet: offset >> 1, isRise: (offset & 1) === 0 };
}

// ============================================================================
// Types
// ============================================================================

/** Per-value animation state. */
export interface AnimatingValue {
    currentValue: number;
    targetValue: number;
    lastAnimationTime: number;   // performance.now() in ms
    animationStopTime: number;   // performance.now() in ms
    animating: boolean;
}

/** Create a fresh AnimatingValue initialized to the given value. */
export function makeAnimatingValue(initial: number, now: number): AnimatingValue {
    return {
        currentValue: initial,
        targetValue: initial,
        lastAnimationTime: now,
        animationStopTime: now,
        animating: false,
    };
}

// ============================================================================
// Core animation (semantics-free)
// ============================================================================

/**
 * Core animation start — operates on abstract values without angle/linear
 * semantics.  Callers handle any normalization (e.g. angle wrapping) before
 * invoking this function.
 *
 * @param speed  Units per second (radians/s for angles, pixels/s for linear).
 * @param durationOverrideMs  When provided, use this fixed duration instead of
 *   computing from distance / speed.  Used for tick-interval compression.
 */
function startValueAnimation(
    val: AnimatingValue,
    newTarget: number,
    now: number,
    speed: number,
    durationOverrideMs?: number,
): void {
    if (speed === 0) {
        val.currentValue = newTarget;
        val.targetValue = newTarget;
        val.animating = false;
        return;
    }

    // If already animating toward this same target, let it continue
    if (val.animating && val.targetValue === newTarget) return;

    // If mid-animation toward a DIFFERENT target, snapshot current position
    if (val.animating) {
        interpolateValue(val, now);
    }

    if (val.currentValue === newTarget) {
        val.animating = false;
        return;
    }

    val.targetValue = newTarget;

    // Compute animation duration
    const delta = Math.abs(newTarget - val.currentValue);
    const durationMs = durationOverrideMs ?? (delta / speed) * 1000;

    if (durationMs < kECGLFrameRate * 1000) {
        val.currentValue = newTarget;
        val.animating = false;
        return;
    }

    val.lastAnimationTime = now;
    val.animating = true;
    val.animationStopTime = now + durationMs;
}

/**
 * Core interpolation — operates on abstract values.
 * Exported for use by the terminator leaf animation system.
 */
export function interpolateValue(val: AnimatingValue, now: number): number {
    if (!val.animating) {
        return val.currentValue;
    }

    if (now >= val.animationStopTime) {
        val.animating = false;
        val.currentValue = val.targetValue;
        return val.currentValue;
    }

    const fraction = (now - val.lastAnimationTime) / (val.animationStopTime - val.lastAnimationTime);
    val.currentValue += (val.targetValue - val.currentValue) * fraction;
    val.lastAnimationTime = now;
    return val.currentValue;
}

// ============================================================================
// Angle animation (wraps to [0, 2π))
// ============================================================================

/**
 * Start a cyclic-or-linear animation.  Takes the shortest path around a value of
 * the given `period`, then delegates to the core.
 *
 * `period` generalizes the old `linear` boolean (see
 * planning/2026-06-15-chronometer-obsvalue-port.md, "Cyclic values"):
 *   - `2π` (default) — angle: normalize target to [0, 2π) and unwrap currentValue
 *     for the shortest angular path. Bit-identical to the former `linear:false`.
 *   - `Infinity` — linear: straight-line interpolation, no wrapping (former
 *     `linear:true`).
 *   - any finite P — cyclic with period P (e.g. the analemma path parameter):
 *     shortest path mod P, normalize target to [0, P).
 *
 * Exported for use by the terminator leaf animation system.
 */
export function startAnimationRaw(
    val: AnimatingValue,
    newTarget: number,
    now: number,
    animSpeed: number = 1.0,
    durationOverrideMs?: number,
    period: number = 2 * Math.PI,
): void {
    const speed = kECGLAngleAnimationSpeed * animSpeed;
    const wraps = isFinite(period);  // false ⇒ linear (no wrapping)

    if (wraps) {
        // Normalize target to [0, period)
        newTarget = fmod(newTarget, period);
    }

    // NaN transition: snap immediately when either endpoint is NaN.
    // Animation isn't meaningful when transitioning to/from "don't display".
    // This handles polar-region stops that become NaN when the sun doesn't
    // reach a given altitude, and must recover when the latitude changes.
    if (isNaN(newTarget) || isNaN(val.currentValue)) {
        val.currentValue = newTarget;
        val.targetValue = newTarget;
        val.animating = false;
        return;
    }

    if (speed === 0) {
        val.currentValue = newTarget;
        val.targetValue = newTarget;
        val.animating = false;
        return;
    }

    if (val.animating && val.targetValue === newTarget) return;
    if (val.animating) { interpolateValue(val, now); }
    if (val.currentValue === newTarget) { val.animating = false; return; }

    if (wraps) {
        // Unwrap currentValue so |currentValue - targetValue| ≤ period/2.
        // This avoids the animation flipping direction when crossing the seam
        // (0/2π for angles, 0/period for other cyclic values).
        let delta = newTarget - val.currentValue;
        delta = delta - period * Math.round(delta / period);
        val.currentValue = newTarget - delta;
    }

    startValueAnimation(val, newTarget, now, speed, durationOverrideMs);
}

/**
 * Interpolate an angle AnimatingValue.  Wraps result to [0, 2π) on completion.
 * Legacy export — new code should use interpolateValue + fmod.
 */
export function interpolateRaw(val: AnimatingValue, now: number): number {
    const result = interpolateValue(val, now);
    return val.animating ? result : fmod(result, 2 * Math.PI);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compute the next display-time boundary for any part.
 * Returns ms-since-epoch in display time.
 *
 * For positive intervals, returns the next epoch-aligned boundary.
 * For negative sentinel values, delegates to resolveSentinel().
 */
export function computeNextBoundary(
    updateIntervalMs: number,
    getNow: () => Date,
    timeDirection: 1 | -1,
    env: Environment,
): number {
    if (updateIntervalMs > 0) {
        // Positive interval — epoch-aligned boundary in display time.
        // Shift by the timezone offset so that daily (86400s) boundaries
        // fall at LOCAL midnight instead of UTC midnight.
        // iOS: ECDynamicUpdate.m line 192 subtracts tzOffset in the alignment.
        const tzOffsetMs = (env.tzOffsetSec ?? 0) * 1000;
        const displayNowMs = getNow().getTime();
        const localNowMs = displayNowMs + tzOffsetMs;  // shift to local
        if (timeDirection === -1) {
            // Time flows backward: find the previous boundary
            const localBoundary = Math.floor(localNowMs / updateIntervalMs) * updateIntervalMs;
            const boundary = (localBoundary === localNowMs
                ? localBoundary - updateIntervalMs
                : localBoundary) - tzOffsetMs;
            return boundary;
        } else {
            const localBoundary = Math.ceil(localNowMs / updateIntervalMs) * updateIntervalMs;
            return localBoundary - tzOffsetMs;  // shift back to UTC
        }
    }

    // Sentinel value — convert from ms back to the original constant
    const sentinel = updateIntervalMs / 1000;
    const eventDI = resolveSentinel(sentinel, getNow, env, timeDirection);

    if (!isFinite(eventDI)) {
        // envChangeOnly or unknown — return Infinity (far future in display time)
        return Infinity;
    }

    // Convert dateInterval (Apple epoch sec) to ms-since-epoch (JS Date.getTime())
    return (eventDI + 978307200) * 1000;
}

/**
 * Convert a display-time ms-since-epoch boundary to performance.now().
 * Used to set the idle-timer wakeup.
 */
export function displayTimeToPerfNow(displayTimeMs: number, getNow: () => Date): number {
    if (!isFinite(displayTimeMs)) return Infinity;
    const deltaMs = Math.abs(displayTimeMs - getNow().getTime());
    return performance.now() + deltaMs;
}

// ============================================================================
// Sentinel scheduling — astronomical event boundary computation
// ============================================================================

/** Fudge factor: 5 seconds to avoid retriggering on exact boundaries. */
const SENTINEL_FUDGE_SECONDS = 5;

/** Lookahead: 13.2 hours (matching iOS). */
const SENTINEL_LOOKAHEAD_SECONDS = 3600 * 13.2;

/**
 * Find the next rise or set event for a planet, searching in the direction
 * time is flowing. Returns a dateInterval, or NaN if no event found.
 *
 * Ports iOS ECAstronomy nextPrevRiseSetInternal + nextPrevPlanetRiseSetForPlanet.
 * The iOS "runningBackward XOR nextNotPrev" pattern simplifies here because
 * sentinel scheduling always requests "next in the direction of flow", so
 * searchForward = (timeDirection === 1).
 */
function nextPlanetRiseSet(
    riseNotSet: boolean,
    planetNumber: ECPlanetNumber,
    getNow: () => Date,
    lat: number,
    lon: number,
    timeDirection: 1 | -1,
): number {
    const calculationDI = dateToDateInterval(getNow());
    const searchForward = timeDirection === 1;

    // Fudge to avoid retriggering on the exact boundary
    const fudge = searchForward ? SENTINEL_FUDGE_SECONDS : -SENTINEL_FUDGE_SECONDS;
    const lookahead = searchForward ? SENTINEL_LOOKAHEAD_SECONDS : -SENTINEL_LOOKAHEAD_SECONDS;
    const fudgeDate = calculationDI + fudge;

    // Create a temporary cache pool for the rise/set calculation
    const pool = new AstroCachePool();
    initializeCachePool(pool, fudgeDate, lat, lon, !searchForward);

    try {
        // First attempt: search from fudged date
        const result = planetaryRiseSetTimeRefined(
            fudgeDate, lat, lon, riseNotSet, planetNumber, NaN, pool,
        );

        if (isNoRiseSet(result.riseSetTime)) {
            // Object is always above or below horizon — no event
            return NaN;
        }

        // Check if the transit time is in the right direction
        // (iOS: nextPrevRiseSetInternalWithFudgeInterval lines 2335-2337)
        const inRightDirection = searchForward
            ? result.transitTime >= fudgeDate
            : result.transitTime < fudgeDate;

        if (inRightDirection) {
            return result.riseSetTime;
        }

        // Not found on first try — search from 13.2 hours away
        const tryDate = fudgeDate + lookahead;
        releaseCachePool(pool);
        initializeCachePool(pool, tryDate, lat, lon, !searchForward);

        const result2 = planetaryRiseSetTimeRefined(
            tryDate, lat, lon, riseNotSet, planetNumber, NaN, pool,
        );

        if (isNoRiseSet(result2.riseSetTime)) {
            return NaN;
        }

        return result2.riseSetTime;
    } finally {
        releaseCachePool(pool);
    }
}

/**
 * Clamp an event time to midnight: return the earlier of the event
 * or the next local midnight (in the direction time is flowing).
 * All times are dateIntervals (Apple epoch seconds).
 *
 * Ports iOS ECAstronomy nextOrMidnightForDateInterval.
 */
function nextOrMidnight(
    eventDI: number,
    getNow: () => Date,
    tzOffsetSec: number,
    timeDirection: 1 | -1,
): number {
    if (isNaN(eventDI)) {
        // No event found — return midnight as fallback
        return nextMidnightDI(getNow, tzOffsetSec, timeDirection);
    }

    const nowDI = dateToDateInterval(getNow());

    // Compute today's local midnight (start of day) in dateInterval space.
    // Add timezone offset to get local time, floor to day, subtract tz offset.
    const localNowSec = nowDI + tzOffsetSec;
    const dayStartLocal = Math.floor(localNowSec / 86400) * 86400;
    const todayMidnightDI = dayStartLocal - tzOffsetSec;

    if (timeDirection === -1) {
        // Backward: "next midnight" = today's midnight (start of current day).
        // If event is before that, return the midnight instead.
        if (eventDI < todayMidnightDI) {
            return todayMidnightDI;
        }
    } else {
        // Forward: next midnight = today's midnight + 1 day.
        const tomorrowMidnightDI = todayMidnightDI + 86400;
        if (eventDI > tomorrowMidnightDI) {
            return tomorrowMidnightDI;
        }
    }

    return eventDI;
}

/**
 * Compute the dateInterval of the next local midnight in the direction
 * time is flowing. Used as a fallback when no astronomical event is found.
 */
function nextMidnightDI(
    getNow: () => Date,
    tzOffsetSec: number,
    timeDirection: 1 | -1,
): number {
    const nowDI = dateToDateInterval(getNow());
    const localNowSec = nowDI + tzOffsetSec;
    const dayStartLocal = Math.floor(localNowSec / 86400) * 86400;
    const todayMidnightDI = dayStartLocal - tzOffsetSec;

    if (timeDirection === -1) {
        return todayMidnightDI;
    } else {
        return todayMidnightDI + 86400;
    }
}

/**
 * Binary search for the next time the sun's declination (sub-solar latitude)
 * has changed by ≥ SSLAT_THRESHOLD from its current value.
 *
 * This adaptive sentinel gives correct scrub compression behavior:
 * - Near equinoxes (fast declination change ~0.4°/day): ~6 hour updates
 * - Near solstices (slow change ~0.01°/day): ~2 day updates
 *
 * The search extends ±2 days from now (in timeDirection), converging to
 * ~1 hour granularity in ~6 iterations of sunRAandDecl().
 *
 * Returns a dateInterval (Apple epoch seconds).
 */
const SSLAT_THRESHOLD = 0.1 * Math.PI / 180;  // 0.1° in radians
const SSLAT_SEARCH_RANGE = 2 * 86400;          // 2 days in seconds
const SSLAT_SEARCH_GRANULARITY = 3600;          // stop when within 1 hour

function nextSslatChange(
    getNow: () => Date,
    timeDirection: 1 | -1,
): number {
    const nowDI = dateToDateInterval(getNow());
    const currentDecl = sunRAandDecl(nowDI, null).declination;

    // Search boundary: 2 days in the direction time is flowing
    const boundaryDI = nowDI + timeDirection * SSLAT_SEARCH_RANGE;
    const boundaryDecl = sunRAandDecl(boundaryDI, null).declination;

    // If declination hasn't changed enough at 2 days, return the boundary
    if (Math.abs(boundaryDecl - currentDecl) < SSLAT_THRESHOLD) {
        return boundaryDI;
    }

    // Binary search: find when |decl(t) - currentDecl| first exceeds threshold
    // lo = now (threshold not yet exceeded), hi = boundary (threshold exceeded)
    let loDI = nowDI;
    let hiDI = boundaryDI;

    while (Math.abs(hiDI - loDI) > SSLAT_SEARCH_GRANULARITY) {
        const midDI = (loDI + hiDI) / 2;
        const midDecl = sunRAandDecl(midDI, null).declination;

        if (Math.abs(midDecl - currentDecl) >= SSLAT_THRESHOLD) {
            hiDI = midDI;  // threshold crossed before mid
        } else {
            loDI = midDI;  // threshold not yet crossed
        }
    }

    // Return hi (conservative: slightly after the actual crossing)
    return hiDI;
}

/**
 * Adaptive update sentinel for the Observatory eclipse simulator
 * (EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION).
 *
 * The eclipse disc is only drawn when Sun and Moon (or Earth-shadow and Moon)
 * are within ECLIPSE_THRESHOLD (10°). We want a fast (~1 s) cadence while the
 * disc is showing so the geometry animates smoothly, but a lazy cadence (capped
 * at one hour) while only the "Eclipse Simulator" caption is up.
 *
 * Eclipse separation is non-monotonic over a synodic month, so a binary search
 * (as in nextSslatChange, which relies on monotonic sun declination) is not
 * robust here. Instead we use a conservative *closing-rate bound*: given a safe
 * upper bound on |d(separation)/dt|, the soonest the separation could reach the
 * threshold is (sep − threshold) / maxRate. Checking earlier than necessary is
 * fine ("conservative, so checking more often is ok"), and we never skip the
 * crossing. Inside the threshold the clamp floors the interval at 1 s.
 *
 * Returns a dateInterval (Apple epoch seconds), honoring timeDirection.
 */
const ECLIPSE_THRESHOLD = Math.PI / 18;   // 10° — matches EOEclipseView gate
// Safe upper bound on |d(separation)/dt|: Moon moves ≈0.55°/h in ecliptic
// longitude, Sun ≈0.04°/h; 1°/h is comfortably conservative.
const ECLIPSE_MAX_CLOSING_RATE = (Math.PI / 180) / 3600;  // 1°/h in rad/s
const ECLIPSE_MAX_INTERVAL = 3600;        // cap caption-mode cadence at 1 hour

export function nextInterestingEclipseMotion(
    getNow: () => Date,
    lat: number,
    lon: number,
    timeDirection: 1 | -1,
): number {
    const nowDI = dateToDateInterval(getNow());
    const sep = calculateEclipse(nowDI, lat, lon, null).angularSeparation;
    let intervalSec = (sep - ECLIPSE_THRESHOLD) / ECLIPSE_MAX_CLOSING_RATE;
    if (intervalSec < 1) intervalSec = 1;
    if (intervalSec > ECLIPSE_MAX_INTERVAL) intervalSec = ECLIPSE_MAX_INTERVAL;
    return nowDI + timeDirection * intervalSec;
}

/**
 * Resolve a sentinel constant to its next display-time event.
 * Returns a dateInterval (Apple epoch seconds), or Infinity for envChangeOnly.
 *
 * Ports iOS ECDynamicUpdate getUpdateCalculatorForInterval dispatch table.
 */
function resolveSentinel(
    sentinel: number,
    getNow: () => Date,
    env: Environment,
    timeDirection: 1 | -1,
): number {
    const lat = env.observerLatRad ?? 0;
    const lon = env.observerLonRad ?? 0;
    const tzOff = env.tzOffsetSec ?? 0;

    switch (sentinel) {
        // Bare rise/set (no midnight clamp)
        case EC_UPDATE_NEXT_SUNRISE:
            return nextPlanetRiseSet(true, ECPlanetNumber.Sun, getNow, lat, lon, timeDirection);
        case EC_UPDATE_NEXT_SUNSET:
            return nextPlanetRiseSet(false, ECPlanetNumber.Sun, getNow, lat, lon, timeDirection);
        case EC_UPDATE_NEXT_MOONRISE:
            return nextPlanetRiseSet(true, ECPlanetNumber.Moon, getNow, lat, lon, timeDirection);
        case EC_UPDATE_NEXT_MOONSET:
            return nextPlanetRiseSet(false, ECPlanetNumber.Moon, getNow, lat, lon, timeDirection);

        // Rise/set clamped to midnight
        case EC_UPDATE_NEXT_SUNRISE_OR_MIDNIGHT:
            return nextOrMidnight(
                nextPlanetRiseSet(true, ECPlanetNumber.Sun, getNow, lat, lon, timeDirection),
                getNow, tzOff, timeDirection,
            );
        case EC_UPDATE_NEXT_SUNSET_OR_MIDNIGHT:
            return nextOrMidnight(
                nextPlanetRiseSet(false, ECPlanetNumber.Sun, getNow, lat, lon, timeDirection),
                getNow, tzOff, timeDirection,
            );
        case EC_UPDATE_NEXT_MOONRISE_OR_MIDNIGHT:
            return nextOrMidnight(
                nextPlanetRiseSet(true, ECPlanetNumber.Moon, getNow, lat, lon, timeDirection),
                getNow, tzOff, timeDirection,
            );
        case EC_UPDATE_NEXT_MOONSET_OR_MIDNIGHT:
            return nextOrMidnight(
                nextPlanetRiseSet(false, ECPlanetNumber.Moon, getNow, lat, lon, timeDirection),
                getNow, tzOff, timeDirection,
            );

        // Combined: whichever comes first in the direction of flow
        case EC_UPDATE_NEXT_SUNRISE_OR_SUNSET: {
            const rise = nextPlanetRiseSet(true, ECPlanetNumber.Sun, getNow, lat, lon, timeDirection);
            const set = nextPlanetRiseSet(false, ECPlanetNumber.Sun, getNow, lat, lon, timeDirection);
            return closerInTimeDirection(rise, set, timeDirection);
        }
        case EC_UPDATE_NEXT_MOONRISE_OR_MOONSET: {
            const rise = nextPlanetRiseSet(true, ECPlanetNumber.Moon, getNow, lat, lon, timeDirection);
            const set = nextPlanetRiseSet(false, ECPlanetNumber.Moon, getNow, lat, lon, timeDirection);
            return closerInTimeDirection(rise, set, timeDirection);
        }

        // Adaptive sslat (sun declination) change sentinel for earth view
        case EC_UPDATE_NEXT_SSLAT_CHANGE:
            return nextSslatChange(getNow, timeDirection);

        // Adaptive eclipse-simulator cadence: ~1 s while the disc is drawn,
        // capped at 1 h while only the caption shows.
        case EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION:
            return nextInterestingEclipseMotion(getNow, lat, lon, timeDirection);

        // Environment change only — effectively never (only explicit reset)
        case 0:
        case EC_UPDATE_ENV_CHANGE_ONLY:
            return Infinity;

        default:
            // Check for generic planet rise/set sentinel encoding
            if (isPlanetRiseSetSentinel(sentinel)) {
                const { planet, isRise } = decodePlanetSentinel(sentinel);
                return nextPlanetRiseSet(isRise, planet, getNow, lat, lon, timeDirection);
            }
            console.warn(`Unknown update sentinel: ${sentinel}, defaulting to daily`);
            return nextMidnightDI(getNow, tzOff, timeDirection);
    }
}

/**
 * Return whichever event is closer in the direction time is flowing.
 * Forward: min. Backward: max. Handles NaN (no-event) gracefully.
 */
function closerInTimeDirection(a: number, b: number, timeDirection: 1 | -1): number {
    if (isNaN(a)) return b;
    if (isNaN(b)) return a;
    return timeDirection === 1 ? Math.min(a, b) : Math.max(a, b);
}

/** Floating-point modulo that always returns a non-negative result. */
function fmod(value: number, modulus: number): number {
    const result = value % modulus;
    return result < 0 ? result + modulus : result;
}

