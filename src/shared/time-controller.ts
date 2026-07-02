/**
 * Time Controller — Quantized-tick time model.
 *
 * Manages simulated time for the Chronometer watch faces.
 * Supports real-time (1× with optional offset), stopped,
 * and accelerated rates using discrete 10 Hz ticks.
 *
 * At accelerated rates, each tick advances by one calendar unit
 * (second, minute, hour, day, month, or year) and the displayed
 * time is snapped to an integer multiple of that unit. Between
 * ticks, getDisplayTime() returns an interpolated value so hands
 * animate smoothly.
 */

// ============================================================================
// Rate definitions
// ============================================================================

export type TimeUnit = 'second' | 'minute' | 'hour' | 'day' | 'month' | 'year';

export interface RateOption {
    /** User-facing label, e.g. "10 hr/s" */
    label: string;
    /** Calendar unit advanced per tick */
    unit: TimeUnit;
}

/** Available speed magnitudes (1× is special-cased, not in this list) */
export const RATE_OPTIONS: RateOption[] = [
    { label: '10×',      unit: 'second' },
    { label: '10 min/s', unit: 'minute' },
    { label: '10 hr/s',  unit: 'hour'   },
    { label: '10 day/s', unit: 'day'    },
    { label: '10 mo/s',  unit: 'month'  },
    { label: '10 yr/s',  unit: 'year'   },
];

/** Tick interval in milliseconds (10 Hz) */
export const TICK_INTERVAL_MS = 100;

/**
 * Approximate display-time seconds advanced per tick for a given unit.
 * Used by the animation system to decide fast vs slow part scheduling.
 */
export function displaySecondsPerTick(unit: TimeUnit): number {
    switch (unit) {
        case 'second': return 1;
        case 'minute': return 60;
        case 'hour':   return 3600;
        case 'day':    return 86400;
        case 'month':  return 30 * 86400;  // approximate
        case 'year':   return 365 * 86400; // approximate
    }
}

import {
    addMonthsToTimeInterval, addYearsToTimeInterval,
    localComponentsFromTimeInterval, timeIntervalFromLocalComponents,
} from '../astronomy/es-calendar.js';
import { dateToDateInterval, dateIntervalToDate, MIN_DISPLAY_DATE_MS, MAX_DISPLAY_DATE_MS } from '../astronomy/es-time.js';

// ============================================================================
// Calendar-aware time arithmetic
// ============================================================================

/**
 * Advance a Date by one calendar unit in the given direction.
 *
 * For second/minute/hour/day: uses continuous timestamp arithmetic (correct
 * for all dates regardless of calendar system).
 *
 * For month/year: uses the hybrid Julian/Gregorian calendar system via
 * es-calendar.ts, which handles the Julian/Gregorian switchover correctly.
 *
 * tzOffsetSeconds is 0 when not available (time controller operates in UTC
 * internally; timezone adjustments are applied at the display layer).
 */
function advanceByUnit(date: Date, unit: TimeUnit, direction: 1 | -1): Date {
    switch (unit) {
        case 'second':
            return new Date(date.getTime() + direction * 1000);
        case 'minute':
            return new Date(date.getTime() + direction * 60_000);
        case 'hour':
            return new Date(date.getTime() + direction * 3_600_000);
        case 'day':
            return new Date(date.getTime() + direction * 86_400_000);
        case 'month': {
            // Use hybrid calendar month addition (handles Julian/Gregorian
            // switchover, day clamping like Jan 31 + 1 month → Feb 28)
            const di = dateToDateInterval(date);
            const newDI = addMonthsToTimeInterval(di, 0, direction);
            return dateIntervalToDate(newDI);
        }
        case 'year': {
            // Use hybrid calendar year addition (handles Feb 29 clamping)
            const di = dateToDateInterval(date);
            const newDI = addYearsToTimeInterval(di, 0, direction);
            return dateIntervalToDate(newDI);
        }
    }
}

/**
 * Snap a Date to the nearest integer multiple of the given unit,
 * rounding in the given direction (forward or backward).
 *
 * For month/year cases: uses hybrid calendar decomposition/recomposition
 * so snapping works correctly across the Julian/Gregorian switchover.
 */
function snapToUnit(date: Date, unit: TimeUnit, direction: 1 | -1): Date {
    const d = new Date(date.getTime());
    switch (unit) {
        case 'second':
            d.setMilliseconds(0);
            if (direction > 0 && date.getMilliseconds() > 0) {
                d.setSeconds(d.getSeconds() + 1);
            }
            break;
        case 'minute':
            d.setMilliseconds(0);
            d.setSeconds(0);
            if (direction > 0 && (date.getSeconds() > 0 || date.getMilliseconds() > 0)) {
                d.setMinutes(d.getMinutes() + 1);
            }
            break;
        case 'hour':
            d.setMilliseconds(0);
            d.setSeconds(0);
            d.setMinutes(0);
            if (direction > 0 && (date.getMinutes() > 0 || date.getSeconds() > 0 || date.getMilliseconds() > 0)) {
                d.setHours(d.getHours() + 1);
            }
            break;
        case 'day':
            d.setMilliseconds(0);
            d.setSeconds(0);
            d.setMinutes(0);
            d.setHours(0);
            if (direction > 0 && (date.getHours() > 0 || date.getMinutes() > 0 || date.getSeconds() > 0 || date.getMilliseconds() > 0)) {
                d.setDate(d.getDate() + 1);
            }
            break;
        case 'month': {
            // Snap to first of month using hybrid calendar decomposition
            const di = dateToDateInterval(date);
            const cs = localComponentsFromTimeInterval(di, 0);
            const needAdvance = direction > 0 && (cs.day > 1 || cs.hour > 0 || cs.minute > 0 || cs.seconds > 0);
            let snapDI = timeIntervalFromLocalComponents(0, cs.era, cs.year, cs.month, 1, 0, 0, 0);
            if (needAdvance) {
                snapDI = addMonthsToTimeInterval(snapDI, 0, 1);
            }
            return dateIntervalToDate(snapDI);
        }
        case 'year': {
            // Snap to Jan 1 using hybrid calendar decomposition
            const di = dateToDateInterval(date);
            const cs = localComponentsFromTimeInterval(di, 0);
            const needAdvance = direction > 0 && (cs.month > 1 || cs.day > 1 || cs.hour > 0 || cs.minute > 0 || cs.seconds > 0);
            let snapDI = timeIntervalFromLocalComponents(0, cs.era, cs.year, 1, 1, 0, 0, 0);
            if (needAdvance) {
                snapDI = addYearsToTimeInterval(snapDI, 0, 1);
            }
            return dateIntervalToDate(snapDI);
        }
    }
    return d;
}


// ============================================================================
// TimeController
// ============================================================================

export class TimeController {
    // --- Offset mode (1× with offset) ---
    /** Millisecond offset from real time (used in 1× and -1× modes) */
    private offsetMs = 0;

    // --- Quantized tick mode ---
    /** Current rate option, or null for 1×/-1× */
    private rate: RateOption | null = null;
    /** Direction: 1 = forward, -1 = reverse */
    private direction: 1 | -1 = 1;
    /** Whether time is stopped */
    private stopped = false;

    /** The simulated time at the most recent tick boundary */
    private tickTime: Date = new Date();
    /** The next tick target (for interpolation) */
    private nextTickTime: Date = new Date();
    /** performance.now() of the most recent tick */
    public lastTickRealMs = 0;

    /** Callback fired on each tick (engine rebuilds caches, renders) */
    onTick: (() => void) | null = null;

    /**
     * Per-frame snapshot: when set, getDisplayTime() returns this value
     * instead of recomputing, ensuring all parts in a single render frame
     * see exactly the same time.
     */
    private frameSnapshot: Date | null = null;

    // ========================================================================
    // Public getters
    // ========================================================================

    /** Is this running at real time with no offset? */
    get isRealTime(): boolean {
        return this.rate === null && this.direction === 1 && !this.stopped && this.offsetMs === 0;
    }

    /** Get the current rate option (null = 1×) */
    get currentRate(): RateOption | null { return this.rate; }

    /** Get the current direction */
    get currentDirection(): 1 | -1 { return this.direction; }

    /** Is time stopped? */
    get isStopped(): boolean { return this.stopped; }

    /** Millisecond offset from real time (used in 1× mode). */
    get timeOffset(): number { return this.offsetMs; }

    /** Human-readable status label */
    get statusLabel(): string {
        if (this.stopped) return 'Stopped';
        if (this.rate === null) {
            if (this.direction === -1) return '1× ◀';
            if (this.offsetMs !== 0) return '1×';
            return '1× (real time)';
        }
        return `${this.rate.label} ${this.direction === 1 ? '▶' : '◀'}`;
    }

    // ========================================================================
    // Core time computation
    // ========================================================================

    /**
     * Get the current display time.
     *
     * If beginFrame() has been called, returns the frozen snapshot so all
     * parts within a single render frame see exactly the same time.
     *
     * Otherwise computes the time:
     * - In 1× mode: real time + offset
     * - In -1× mode: time flows backward from an anchor
     * - In stopped mode: frozen tickTime
     * - In quantized mode: interpolation between tickTime and nextTickTime
     */
    getDisplayTime(): Date {
        // Return per-frame snapshot if active
        if (this.frameSnapshot !== null) {
            return this.frameSnapshot;
        }
        return this._computeDisplayTime();
    }

    /**
     * Snapshot the current display time for the duration of a render frame.
     * All calls to getDisplayTime() will return this exact value until
     * endFrame() is called.
     */
    beginFrame(): void {
        this.frameSnapshot = this._computeDisplayTime();
    }

    /**
     * Release the per-frame snapshot, allowing getDisplayTime() to
     * compute fresh values again.
     */
    endFrame(): void {
        this.frameSnapshot = null;
    }

    /** Internal: compute the display time without snapshotting. */
    private _computeDisplayTime(): Date {
        // 1× or -1× mode (no quantized rate selected)
        if (this.rate === null && !this.stopped) {
            if (this.direction === -1) {
                // -1× mode: time flows backward from anchor
                const realNow = Date.now();
                const elapsed = realNow - this.reverseAnchorRealMs;
                return new Date(this.reverseAnchorSimMs - elapsed);
            }
            // 1× mode: real time + offset
            return new Date(Date.now() + this.offsetMs);
        }

        // Stopped: return frozen time
        if (this.stopped) {
            return new Date(this.tickTime.getTime());
        }

        // Quantized mode: return the exact current tick time.
        // No interpolation — the animation system handles smooth hand
        // transitions between ticks. This keeps subordinate hands
        // (e.g. seconds at hour rate) perfectly locked.
        return new Date(this.tickTime.getTime());
    }

    // ========================================================================
    // Tick logic (called from RAF loop)
    // ========================================================================

    /**
     * Called every animation frame. Checks if a tick boundary has been
     * crossed and fires the tick if so. Returns true if a tick occurred.
     */
    checkTick(nowPerfMs: number): boolean {
        // No ticking in 1×, -1×, or stopped modes
        if (this.rate === null || this.stopped) return false;

        if (nowPerfMs - this.lastTickRealMs >= TICK_INTERVAL_MS) {
            this.tickTime = new Date(this.nextTickTime.getTime());
            this.nextTickTime = advanceByUnit(this.tickTime, this.rate.unit, this.direction);
            this.lastTickRealMs = nowPerfMs;
            // NOTE: We now call onTick() here. The env functions are live
            // closures that call getNow(), but calendar-dependent init
            // expressions, timezone/DST offsets, and terminator/analemma calculations
            // need a rebuilt environment to reflect DST transitions during continuous scrubbing.
            this.onTick?.();
            this.clampDisplayTime();
            return true;
        }
        return false;
    }

    /**
     * Whether the render loop should run continuously.
     * True for quantized rates; false for stopped and 1×/-1× (which use
     * idle-timeout scheduling with direction-aware boundary alignment).
     */
    get needsContinuousRender(): boolean {
        if (this.stopped) return false;
        if (this.rate !== null) return true;    // quantized ticking
        return false;                           // 1× or -1× — use normal scheduler
    }

    // ========================================================================
    // Rate / direction / time control
    // ========================================================================

    /**
     * Set a quantized rate. Pass null for 1×.
     * When activating a quantized rate, snaps time to the unit boundary.
     */
    setRate(rate: RateOption | null): void {
        const prevTime = this.getDisplayTime();
        this.stopped = false;

        if (rate === null) {
            // Switching to 1×/-1× mode: capture current sim time as offset
            this.rate = null;
            this.offsetMs = prevTime.getTime() - Date.now();
            if (this.direction === -1) {
                // For -1×, we need to set up so time flows backward
                this._setupReverseOneX(prevTime);
            }
            return;
        }

        this.rate = rate;
        // Only snap to unit boundary for seconds (zeroing milliseconds,
        // which aren't displayed). For all other rates, preserve sub-unit
        // fields — snapping would zero out visible hands (e.g., minute/
        // second hands when scrubbing by hour) causing them to jump.
        if (rate.unit === 'second') {
            this.tickTime = snapToUnit(prevTime, rate.unit, this.direction);
        } else {
            this.tickTime = prevTime;
        }
        this.nextTickTime = advanceByUnit(this.tickTime, rate.unit, this.direction);
        this.lastTickRealMs = performance.now();
        this.clampDisplayTime();
        this.onTick?.();
    }

    /** Set direction (forward or reverse). Preserves current rate. */
    setDirection(dir: 1 | -1): void {
        if (dir === this.direction) return;

        const prevTime = this.getDisplayTime();
        this.direction = dir;
        this.stopped = false;

        if (this.rate === null) {
            // 1×/-1× toggle
            this._setupReverseOneX(prevTime);
        } else {
            // Same snap policy as setRate: only snap for seconds (zeroing
            // invisible milliseconds). Snapping other units would zero
            // visible hands — and since stop() leaves the rate in place,
            // this fired on the *leftover* rate when a new opposite-direction
            // scrub started (hold-to-scrub calls setDirection before setRate),
            // jumping seconds (or the whole time-of-day) to 0.
            this.tickTime = this.rate.unit === 'second'
                ? snapToUnit(prevTime, this.rate.unit, dir)
                : new Date(prevTime.getTime());
            this.nextTickTime = advanceByUnit(this.tickTime, this.rate.unit, dir);
            this.lastTickRealMs = performance.now();
        }
        this.clampDisplayTime();
        this.onTick?.();
    }

    /** Stop time. */
    stop(): void {
        if (this.stopped) return;
        const prevTime = this.getDisplayTime();
        this.stopped = true;
        this.tickTime = prevTime;
        this.nextTickTime = prevTime;

        // Capture offset for resuming in 1× later
        this.offsetMs = prevTime.getTime() - Date.now();
    }

    /**
     * Step by one calendar unit. Works whether stopped or running.
     * While running at a quantized rate, this is an additional jump
     * on top of the tick rhythm.
     */
    step(unit: TimeUnit, dir: 1 | -1): void {
        const prevTime = this.getDisplayTime();
        const newTime = advanceByUnit(prevTime, unit, dir);

        if (this.stopped || this.rate === null) {
            // In stopped or 1× mode: just jump
            this.tickTime = newTime;
            this.nextTickTime = newTime;
            this.offsetMs = newTime.getTime() - Date.now();
        } else {
            // In quantized mode: jump and re-snap
            this.tickTime = snapToUnit(newTime, this.rate.unit, this.direction);
            this.nextTickTime = advanceByUnit(this.tickTime, this.rate.unit, this.direction);
            this.lastTickRealMs = performance.now();
        }
        this.clampDisplayTime();
        this.onTick?.();
    }

    /** Set an exact date/time. Stops the clock. */
    setTime(date: Date): void {
        this.stopped = true;
        this.tickTime = date;
        this.nextTickTime = date;
        this.offsetMs = date.getTime() - Date.now();
        this.clampDisplayTime();
        this.onTick?.();
    }

    /** Reset to real time, 1× forward. */
    reset(): void {
        this.offsetMs = 0;
        this.rate = null;
        this.direction = 1;
        this.stopped = false;
        this.tickTime = new Date();
        this.nextTickTime = new Date();
        this.lastTickRealMs = 0;
        this.onTick?.();
    }

    /** Set millisecond offset from real time, running 1× forward. */
    setOffset(ms: number): void {
        this.offsetMs = ms;
        this.rate = null;
        this.direction = 1;
        this.stopped = false;
        this.tickTime = new Date(Date.now() + ms);
        this.nextTickTime = new Date(Date.now() + ms);
        this.lastTickRealMs = 0;
        this.clampDisplayTime();
        this.onTick?.();
    }

    // ========================================================================
    // Date range constraint
    // ========================================================================

    /**
     * Check if the current display time exceeds the supported astronomical
     * range (4000 BCE – 2800 CE) and constrain it. Returns true if clamping
     * occurred.
     *
     * Mirrors iOS ESWatchTime::checkAndConstrainAbsoluteTime:
     * - If time is running, stop the clock at the boundary
     * - If time is stopped, clamp the frozen value to the boundary
     */
    clampDisplayTime(): boolean {
        const t = this.getDisplayTime().getTime();
        if (t <= MIN_DISPLAY_DATE_MS) {
            if (!this.stopped) {
                this.stop();
            }
            this.tickTime = new Date(MIN_DISPLAY_DATE_MS);
            this.nextTickTime = new Date(MIN_DISPLAY_DATE_MS);
            this.offsetMs = MIN_DISPLAY_DATE_MS - Date.now();
            return true;
        }
        if (t >= MAX_DISPLAY_DATE_MS) {
            if (!this.stopped) {
                this.stop();
            }
            this.tickTime = new Date(MAX_DISPLAY_DATE_MS);
            this.nextTickTime = new Date(MAX_DISPLAY_DATE_MS);
            this.offsetMs = MAX_DISPLAY_DATE_MS - Date.now();
            return true;
        }
        return false;
    }

    // ========================================================================
    // Internal helpers
    // ========================================================================

    /**
     * Set up offset for -1× mode. In -1× mode, time runs backward:
     * each real ms that passes subtracts 1ms from the simulated time.
     * We represent this as an offset that decreases by 2× real elapsed
     * (since Date.now() increases by 1ms per ms, we need -2ms offset
     * per ms to get net -1ms/ms).
     *
     * Actually, simpler approach: we store an anchor and compute
     * the simulated time as: anchor - (realNow - anchorReal).
     * This is equivalent to offsetMs decreasing by 2 per real ms.
     *
     * For simplicity, we'll track the offset differently for -1×:
     * simTime = 2 * anchorReal - realNow + originalOffset
     * i.e. offsetMs is set to 2 * anchorReal + originalOffset - Date.now()
     * but this drifts... Let's just use a stable anchor approach.
     */
    private reverseAnchorRealMs = 0;
    private reverseAnchorSimMs = 0;

    private _setupReverseOneX(prevTime: Date): void {
        if (this.direction === -1) {
            this.reverseAnchorRealMs = Date.now();
            this.reverseAnchorSimMs = prevTime.getTime();
            // Override getDisplayTime to use anchor-based reverse
            this.offsetMs = NaN; // sentinel: use reverse anchor instead
        } else {
            // Switching back to forward: capture current sim time as offset
            this.offsetMs = prevTime.getTime() - Date.now();
        }
    }
}
