/**
 * Updater — the per-frame logic that drives ObsValues.
 *
 * This is the embryonic "updater" subsystem: it owns the per-value update
 * branches (snap-to-target, two-phase natural-speed sweep, scrub compression,
 * and lag-free eval-ahead), the per-frame interpolation pass, and the
 * time-shift helper (`makeOverridableGetNow`) used by eval-ahead.
 *
 * It operates on a single `ObsValue` or a flat `ObsValue[]` — collection
 * management (named structs, keyed maps) is left to each app. Over time this
 * file is the natural home for a fuller encapsulated update subsystem (keyed
 * collection, worker-backed eval, double-buffering, time-controller transition
 * glue); for now it is just the passes plus the time helper.
 */

import type { Environment } from '../expr/env.js';
import {
    startAnimationRaw,
    interpolateValue,
    computeNextBoundary,
    displayTimeToPerfNow,
} from './animation.js';
import type { ObsValue } from './obs-value.js';
import type { TimeController } from './time-controller.js';
import { TICK_INTERVAL_MS, displaySecondsPerTick } from './time-controller.js';

// Base angular animation speed (must match kECGLAngleAnimationSpeed in animation.ts).
// Used to convert ObsValue animSpeed (rad/s) to the multiplier that
// startAnimationRaw expects.
const K_ANGLE_ANIM_SPEED = 2.0;

// Error threshold (radians) below which a natural-speed value is considered
// "on track" and skips the catch-up phase.
const NATURAL_ERROR_THRESHOLD = 0.002;

// ── Tick CPU attribution (diagnostic) ───────────────────────────────────────
// Module-level accumulators summed over a scrub session; the engine resets at
// scrub start and logs at scrub end. There's a small per-value `performance.now()`
// overhead, so treat the numbers as *proportions* (where the tick time goes), not
// exact totals.
export const tickProfile = {
    updateMs: 0,    // updateObsValues — the whole update pass
    animateMs: 0,   // animateObsValues — the second interpolation pass
    evalMs: 0,      // evalAttr (expression evaluation) at on-beat arrivals
    boundaryMs: 0,  // computeNextBoundary (scheduling) at on-beat arrivals
    interpMs: 0,    // interpolateValue inside onBeatStep
    evalCalls: 0,   // # of evalAttr calls (→ per-eval µs)
};
export function resetTickProfile(): void {
    tickProfile.updateMs = 0; tickProfile.animateMs = 0; tickProfile.evalMs = 0;
    tickProfile.boundaryMs = 0; tickProfile.interpMs = 0; tickProfile.evalCalls = 0;
}
// Off by default — the per-value `performance.now()` calls tax the hot path we're
// measuring, so they're enabled on demand (engine: `?tickprofile`). When off, the
// guards are a single boolean test (~free).
let profileEnabled = false;
export function setTickProfiling(on: boolean): void { profileEnabled = on; }

// ============================================================================
// Time source / eval-ahead helper
// ============================================================================

/** Run `fn` as if the display clock read `displayMs`, then restore. */
export type WithDisplayTime = <T>(displayMs: number, fn: () => T) => T;

/**
 * Wrap a base time source in a transiently-overridable `getNow`.
 *
 * `getNow()` normally returns `base()`, but inside `withDisplayTime(ms, fn)` it
 * returns `new Date(ms)` for the duration of `fn`. This lets the updater
 * evaluate an expression "ahead" (at a future display-time boundary) without a
 * second environment — the display time enters expressions only through
 * `getNow`, so shifting it shifts the whole evaluation.
 */
export function makeOverridableGetNow(base: () => Date): {
    getNow: () => Date;
    withDisplayTime: WithDisplayTime;
} {
    let overrideMs: number | null = null;
    const getNow = (): Date => (overrideMs != null ? new Date(overrideMs) : base());
    function withDisplayTime<T>(displayMs: number, fn: () => T): T {
        const prev = overrideMs;
        overrideMs = displayMs;
        try {
            return fn();
        } finally {
            overrideMs = prev;
        }
    }
    return { getNow, withDisplayTime };
}

// ============================================================================
// Timing context — the per-frame seam between the time controller and updater
// ============================================================================

/**
 * The per-frame timing state the updater needs, derived from a `TimeController`.
 * Bundling it as one value (rather than three loose scalars threaded through
 * every call) is the generic controller↔updater seam: a client builds it once
 * per frame and hands it to the updater.
 */
export interface TimingContext {
    /** Scrub tick rate in ms, or `null` at 1× / reverse / stopped. */
    tickIntervalMs: number | null;
    /** Display seconds advanced per tick (magnitude); used by scrub eval-ahead. */
    displayDeltaSec: number;
    /** 1 = forward, −1 = reverse, 0 = stopped. */
    direction: 0 | 1 | -1;
}

/** Build the per-frame `TimingContext` from a `TimeController`. */
export function timingContextForFrame(tc: TimeController): TimingContext {
    const rate = tc.currentRate;
    return {
        tickIntervalMs: rate ? TICK_INTERVAL_MS : null,
        displayDeltaSec: rate ? displaySecondsPerTick(rate.unit) : 0,
        direction: tc.isStopped ? 0 : tc.currentDirection,
    };
}

// ============================================================================
// Update helpers
// ============================================================================

/**
 * Update a **discrete** value: evaluate at the *current* display time and snap.
 *
 * For values where interpolation is meaningless (today's sunrise, an integer
 * hour, a floored TZ offset), eval-ahead would cross the value's change-point
 * early and interpolation would show nonexistent in-between states. So we
 * evaluate at "now" (the function's own semantics decide which value applies)
 * and set the value directly with no animation.
 */
function updateObsValueDiscrete(
    v: ObsValue,
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    timeDirection: 0 | 1 | -1,
    tickIntervalMs: number | null,
): void {
    const newTarget = v.evalFn(env);

    // Cadence is the only mode dependence — the value is always evaluated at the
    // *current* display time and snapped.
    if (timeDirection === 0) {
        // Stopped: re-check shortly (time may resume).
        v.nextUpdateTime = perfNow + 100;
    } else if (tickIntervalMs !== null && tickIntervalMs > 0) {
        // Scrubbing: re-evaluate every tick so the snapped value tracks the
        // scrubbed display time with no stale lag.
        v.nextUpdateTime = perfNow + tickIntervalMs;
    } else {
        // 1× / reverse: re-evaluate at this value's next boundary.
        const dir: 1 | -1 = timeDirection === -1 ? -1 : 1;
        const nextDisplayMs = computeNextBoundary(v.updateInterval * 1000, getNow, dir, env);
        v.nextUpdateDisplayTime = nextDisplayMs;
        v.nextUpdateTime = displayTimeToPerfNow(nextDisplayMs, getNow);
    }

    // Snap — no animation, no interpolation.
    v.pendingSweep = null;
    v.anim.currentValue = newTarget;
    v.anim.targetValue = newTarget;
    v.anim.animating = false;
}

/**
 * Update a value using the lag-free **eval-ahead** scheme — the single continuous
 * mechanism, made *mode-aware* by where the upcoming eval point is:
 *
 *   - **1× / reverse:** the next point is this value's next epoch boundary; the
 *     budget is the real time until it (display↔real 1:1).
 *   - **Scrub:** the next point is the **next tick** — its display time is
 *     `now + displayDeltaSec·dir` and the budget is `tickIntervalMs`.
 *
 * Either way we evaluate the target *at the next point's display time* and sweep
 * `current → target` over the budget, arriving exactly when display reaches that
 * point. So it is lag-free at every step, and natural-speed sweep falls out: the
 * implied rate is just the slope between A(now) and A(next). `timeDirection` is
 * never 0 here (the dispatch routes stopped continuous values to settle).
 */
function updateObsValueEvalAhead(
    v: ObsValue,
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    timeDirection: 1 | -1,
    tickIntervalMs: number | null,
    displayDeltaSec: number,
    withDisplayTime?: WithDisplayTime,
): void {
    let nextDisplayMs: number;
    let budgetMs: number;

    if (tickIntervalMs !== null && tickIntervalMs > 0) {
        // Scrub: the next update is the next tick.
        nextDisplayMs = getNow().getTime() + displayDeltaSec * 1000 * timeDirection;
        budgetMs = tickIntervalMs;
        v.nextUpdateTime = perfNow + tickIntervalMs;
    } else {
        // 1× / reverse: the next update is this value's next epoch boundary.
        nextDisplayMs = computeNextBoundary(v.updateInterval * 1000, getNow, timeDirection, env);
        v.nextUpdateTime = displayTimeToPerfNow(nextDisplayMs, getNow);
        budgetMs = v.nextUpdateTime - perfNow;
    }
    v.nextUpdateDisplayTime = nextDisplayMs;

    // Evaluate the target AT the next point's display time (eval-ahead). The
    // override only applies during this evaluation; scheduling above used real time.
    const target = withDisplayTime
        ? withDisplayTime(nextDisplayMs, () => v.evalFn(env))
        : v.evalFn(env);

    v.pendingSweep = null;
    const multiplier = v.animSpeed / K_ANGLE_ANIM_SPEED;
    if (budgetMs > 0 && isFinite(budgetMs)) {
        // Sweep to the future target over the real-time budget.
        startAnimationRaw(v.anim, target, perfNow, multiplier, budgetMs, v.period);
    } else {
        // Budget is now/past — snap.
        startAnimationRaw(v.anim, target, perfNow, multiplier, undefined, v.period);
    }
}

/**
 * Update a natural-speed value (e.g., second hand) in 1×/−1× mode.
 *
 * Two-phase animation:
 *   Phase 1 (catch-up): Animate at animSpeed from current position to where
 *     the hand should be when catch-up finishes (the correct position advances
 *     at naturalSpeed during catch-up).
 *   Phase 2 (sweep): Sweep at naturalSpeed until the next update boundary.
 *
 * Phase 2 params are stored in v.pendingSweep and picked up by animateObsValue
 * when Phase 1 completes.
 */
function updateNaturalSpeedValue(
    v: ObsValue,
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    timeDirection: 1 | -1,
): void {
    const currentCorrectAngle = v.evalFn(env);

    // Schedule next update
    const nextDisplayMs = computeNextBoundary(
        v.updateInterval * 1000, getNow, timeDirection, env);
    v.nextUpdateDisplayTime = nextDisplayMs;
    v.nextUpdateTime = displayTimeToPerfNow(nextDisplayMs, getNow);

    // Real time until next update
    const dtToNextUpdateMs = v.nextUpdateTime - perfNow;
    const dtToNextUpdateSec = dtToNextUpdateMs / 1000;
    if (dtToNextUpdateSec <= 0 || !isFinite(dtToNextUpdateSec)) {
        // Edge case: next update is now or in the past — snap
        startAnimationRaw(v.anim, currentCorrectAngle, perfNow,
            v.animSpeed / K_ANGLE_ANIM_SPEED, undefined, v.period);
        v.pendingSweep = null;
        return;
    }

    // Effective natural speed (clockwise forward, counter-clockwise reverse)
    const effNaturalSpeed = v.naturalSpeed * timeDirection;

    // Compute error: how far is the hand from where it should be?
    const TWO_PI = 2 * Math.PI;
    let error: number;
    if (timeDirection === 1) {
        // Normalize clockwise [0, 2π)
        error = currentCorrectAngle - v.anim.currentValue;
        error = ((error % TWO_PI) + TWO_PI) % TWO_PI;
    } else {
        // Normalize counter-clockwise
        error = v.anim.currentValue - currentCorrectAngle;
        error = ((error % TWO_PI) + TWO_PI) % TWO_PI;
    }

    if (error < NATURAL_ERROR_THRESHOLD) {
        // On track — Phase 2 only (sweep at naturalSpeed)
        const sweepAngle = effNaturalSpeed * dtToNextUpdateSec;
        const finalTarget = currentCorrectAngle + sweepAngle;
        startAnimationRaw(v.anim, finalTarget, perfNow,
            v.naturalSpeed / K_ANGLE_ANIM_SPEED, dtToNextUpdateMs, v.period);
        v.pendingSweep = null;
        return;
    }

    // Phase 1: Catch-up at animSpeed.
    // The hand closes the gap at (animSpeed - naturalSpeed) rad/s.
    // catchUpTime = error / (animSpeed - naturalSpeed)
    const differentialSpeed = v.animSpeed - v.naturalSpeed;
    if (differentialSpeed <= 0) {
        // animSpeed not fast enough to close gap — compress everything
        const sweepAngle = effNaturalSpeed * dtToNextUpdateSec;
        const finalTarget = currentCorrectAngle + sweepAngle;
        startAnimationRaw(v.anim, finalTarget, perfNow,
            v.animSpeed / K_ANGLE_ANIM_SPEED, dtToNextUpdateMs, v.period);
        v.pendingSweep = null;
        return;
    }

    const catchUpSec = error / differentialSpeed;
    const catchUpMs = catchUpSec * 1000;

    if (catchUpMs >= dtToNextUpdateMs) {
        // Can't finish catch-up before next update — compress both phases
        const sweepAngle = effNaturalSpeed * dtToNextUpdateSec;
        const finalTarget = currentCorrectAngle + sweepAngle;
        startAnimationRaw(v.anim, finalTarget, perfNow,
            v.animSpeed / K_ANGLE_ANIM_SPEED, dtToNextUpdateMs, v.period);
        v.pendingSweep = null;
        return;
    }

    // Phase 1 target: where the correct position will be when catch-up ends
    const catchUpTarget = currentCorrectAngle + effNaturalSpeed * catchUpSec;
    startAnimationRaw(v.anim, catchUpTarget, perfNow,
        v.animSpeed / K_ANGLE_ANIM_SPEED, catchUpMs, v.period);

    // Store Phase 2 for the animate pass to pick up
    const remainingMs = dtToNextUpdateMs - catchUpMs;
    const sweepAngle = effNaturalSpeed * (remainingMs / 1000);
    v.pendingSweep = {
        target: catchUpTarget + sweepAngle,
        durationMs: remainingMs,
    };
}

/**
 * Update a value during scrub (quantized mode).
 *
 * Compression logic modeled after the watch-face tickAnimations:
 * compute how many ticks until the next update boundary, use that
 * as the real-time budget, and compress if the natural animation
 * duration exceeds it.
 */
function updateObsValueScrub(
    v: ObsValue,
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    timeDirection: 1 | -1,
    tickIntervalMs: number,
    displayDeltaPerTickSec: number,
): void {
    const newTarget = v.evalFn(env);

    // Compute next boundary in display time
    const nextDisplayMs = computeNextBoundary(
        v.updateInterval * 1000, getNow, timeDirection, env);
    v.nextUpdateDisplayTime = nextDisplayMs;

    // Compute real-time budget (same formula as tickAnimations)
    const displayNowMs = getNow().getTime();
    const displayDeltaMs = Math.abs(nextDisplayMs - displayNowMs);
    const displayDeltaPerTickMs = displayDeltaPerTickSec * 1000;
    const ticksUntilUpdate = displayDeltaPerTickMs > 0
        ? Math.max(1, Math.ceil(displayDeltaMs / displayDeltaPerTickMs))
        : 1;
    const timeUntilNextUpdateMs = ticksUntilUpdate * tickIntervalMs;

    // Schedule next re-evaluation
    v.nextUpdateTime = perfNow + timeUntilNextUpdateMs;

    // Compute natural animation duration
    const speed = v.animSpeed;  // rad/s
    let angleDelta: number;
    if (!isFinite(v.period)) {
        // Linear values: straight-line delta (no cyclic wrapping)
        angleDelta = Math.abs(newTarget - v.anim.currentValue);
    } else {
        const P = v.period;
        const normalizedTarget = ((newTarget % P) + P) % P;
        const normalizedCurrent = ((v.anim.currentValue % P) + P) % P;
        angleDelta = Math.abs(normalizedTarget - normalizedCurrent);
        if (angleDelta > P / 2) angleDelta = P - angleDelta;
    }
    const naturalDurationMs = speed > 0 ? (angleDelta / speed) * 1000 : 0;

    const multiplier = v.animSpeed / K_ANGLE_ANIM_SPEED;

    // Compress if needed, stretch if too fast, otherwise use natural speed.
    if (naturalDurationMs > timeUntilNextUpdateMs) {
        // Too slow — compress to finish before next re-evaluation
        startAnimationRaw(v.anim, newTarget, perfNow, multiplier,
            timeUntilNextUpdateMs, v.period);
    } else if (naturalDurationMs < tickIntervalMs) {
        // Too fast — stretch to fill one tick (prevents sub-frame snaps)
        startAnimationRaw(v.anim, newTarget, perfNow, multiplier,
            tickIntervalMs, v.period);
    } else {
        // Natural speed falls between one tick and next update — use as-is
        startAnimationRaw(v.anim, newTarget, perfNow, multiplier,
            undefined, v.period);
    }

    // No pending sweep during scrub — just snap-to-target with compression
    v.pendingSweep = null;
}

/**
 * Continuous value, time **stopped**: evaluate at the (frozen) current display
 * time and animate to it, re-checking shortly in case time resumes. No look-ahead.
 */
function settleAtNow(v: ObsValue, env: Environment, perfNow: number): void {
    const newTarget = v.evalFn(env);
    v.nextUpdateTime = perfNow + 100;
    v.pendingSweep = null;
    startAnimationRaw(v.anim, newTarget, perfNow,
        v.animSpeed / K_ANGLE_ANIM_SPEED, undefined, v.period);
}

/**
 * Fixed-duration update: evaluate at the current time and animate to
 * the target over exactly `durationMs` of real time.  Re-evaluates
 * every frame (`nextUpdateTime = 0`) since the caller is driving
 * continuous input (e.g. drag-to-explore pointer events).
 *
 * Modeled on `updateObsValueScrub`'s duration-override path but with a
 * constant budget instead of a computed one.  Discrete values snap
 * instantly (they represent logical/enum values where interpolation is
 * meaningless).
 */
function updateObsValueFixedDuration(
    v: ObsValue, env: Environment, perfNow: number, durationMs: number,
): void {
    const newTarget = v.evalFn(env);
    v.nextUpdateTime = 0;  // re-evaluate every frame
    v.pendingSweep = null;

    if (v.discrete) {
        // Discrete values snap — no interpolation.
        v.anim.currentValue = newTarget;
        v.anim.targetValue = newTarget;
        v.anim.animating = false;
        return;
    }

    const multiplier = v.animSpeed / K_ANGLE_ANIM_SPEED;
    startAnimationRaw(v.anim, newTarget, perfNow, multiplier, durationMs, v.period);
}

/**
 * Non-eval-ahead continuous value at 1× / reverse: evaluate at the current time
 * and animate to it at `animSpeed`, scheduling the next re-eval at the boundary.
 * (Legacy snap path — Observatory values that don't opt into eval-ahead.)
 */
function snapToTargetAtBoundary(
    v: ObsValue, env: Environment, perfNow: number,
    getNow: () => Date, timeDirection: 1 | -1,
): void {
    const newTarget = v.evalFn(env);
    const nextDisplayMs = computeNextBoundary(v.updateInterval * 1000, getNow, timeDirection, env);
    v.nextUpdateDisplayTime = nextDisplayMs;
    v.nextUpdateTime = displayTimeToPerfNow(nextDisplayMs, getNow);
    v.pendingSweep = null;
    startAnimationRaw(v.anim, newTarget, perfNow,
        v.animSpeed / K_ANGLE_ANIM_SPEED, undefined, v.period);
}

// ============================================================================
// On-beat scheduling (snap at natural speed, land on the boundary)
// ============================================================================

/**
 * Shortest-path distance from `current` to `target` honoring the value's wrap
 * `period` — mirrors the unwrap inside `startAnimationRaw` so the computed sweep
 * duration `d` matches the distance the animation will actually cover. Returns
 * `NaN` if either endpoint is `NaN` (caller treats that as a snap, `d = 0`).
 */
function shortestPathDistance(current: number, target: number, period: number): number {
    if (isNaN(current) || isNaN(target)) return NaN;
    if (!isFinite(period)) return Math.abs(target - current);
    const P = period;
    const normTarget = ((target % P) + P) % P;
    let delta = normTarget - current;
    delta = delta - P * Math.round(delta / P);
    return Math.abs(delta);
}

/**
 * On-beat **arrival**: the value has reached its current boundary and is now
 * deciding where (and when) to go next. Compute the next update boundary in
 * display time, evaluate the target *there* (eval-ahead), and schedule the snap
 * toward it. Stores the plan in `v.pendingTarget` and points `nextUpdateTime` at
 * the start (so the idle scheduler wakes exactly then).
 *
 * **When the snap starts is mode-dependent — this is the dead-beat gate.**
 *   - **1× / reverse:** begin at `boundaryRealMs − d` so the snap *arrives on the
 *     boundary* rather than starting at it. This is the "jumping seconds"
 *     complication: a 1-bps hand sits, then ticks onto the beat.
 *   - **Scrub:** begin *now* and sweep across the whole budget to the boundary, so
 *     the hand moves every frame instead of sitting most of the tick and snapping.
 *     The dead-beat aesthetic is meaningless here — the "beat" is just the 10 Hz
 *     render tick — and slow hands (e.g. Firenze's Earth/planet markers, ~1°/day)
 *     otherwise sit ~90% of each tick and step. Eval cadence is unchanged (arrival
 *     still lands on the boundary), so the boundary-batched astronomy the on-beat
 *     scheme buys during scrub is fully preserved; only the interpolation *shape*
 *     changes (fill-the-budget sweep vs. sit-then-land).
 *
 * The boundary sequence is the value's own update boundaries either way (see
 * planning/2026-06-26-worker-eval-ahead-pipeline.md, "Computing T+1, T+2").
 */
function onArrivalOnBeat(
    v: ObsValue,
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    timeDirection: 1 | -1,
    tickIntervalMs: number | null,
    displayDeltaPerTickSec: number,
    withDisplayTime?: WithDisplayTime,
): void {
    const _b0 = profileEnabled ? performance.now() : 0;
    const nextDisplayMs = computeNextBoundary(
        v.updateInterval * 1000, getNow, timeDirection, env);
    if (profileEnabled) tickProfile.boundaryMs += performance.now() - _b0;

    // Real time at which that boundary lands.
    const scrubbing = tickIntervalMs !== null && tickIntervalMs > 0;
    let boundaryRealMs: number;
    if (scrubbing) {
        // Scrub: compress display-time-to-boundary into whole ticks (the value is
        // re-evaluated only when accelerated display time reaches its boundary —
        // NOT every tick).
        const displayNowMs = getNow().getTime();
        const displayDeltaMs = Math.abs(nextDisplayMs - displayNowMs);
        const perTickMs = displayDeltaPerTickSec * 1000;
        const ticksUntilUpdate = perTickMs > 0
            ? Math.max(1, Math.ceil(displayDeltaMs / perTickMs))
            : 1;
        boundaryRealMs = perfNow + ticksUntilUpdate * tickIntervalMs;
    } else {
        // 1× / reverse: display↔real 1:1.
        boundaryRealMs = displayTimeToPerfNow(nextDisplayMs, getNow);
    }

    // Evaluate the target AT the future boundary's display time (eval-ahead).
    const _e0 = profileEnabled ? performance.now() : 0;
    const target = withDisplayTime
        ? withDisplayTime(nextDisplayMs, () => v.evalFn(env))
        : v.evalFn(env);
    if (profileEnabled) { tickProfile.evalMs += performance.now() - _e0; tickProfile.evalCalls++; }

    // When to *start* the snap — the dead-beat gate (see doc comment).
    let startTime: number;
    if (!isFinite(boundaryRealMs)) {
        startTime = Infinity;
    } else if (scrubbing) {
        // Scrub: start now and fill the whole budget → move every frame, no sit.
        startTime = perfNow;
    } else {
        // 1× / reverse: land on the beat — begin at boundary − sweepDuration so the
        // snap *arrives* on the boundary (the jumping-seconds tick).
        const dist = shortestPathDistance(v.anim.currentValue, target, v.period);
        const d = (v.animSpeed > 0 && isFinite(dist)) ? (dist / v.animSpeed) * 1000 : 0;
        startTime = boundaryRealMs - d;
        // Can't start in the past: if the snap should already be underway, begin now
        // (the budget compresses to land on the boundary; or sweeps continuously when
        // d ≥ interval — the bps=0 graceful-degrade case).
        if (startTime < perfNow) startTime = perfNow;
    }

    v.pendingTarget = { target, boundaryRealMs, startTime };
    v.nextUpdateDisplayTime = nextDisplayMs;
    v.nextUpdateTime = startTime;
}

/**
 * On-beat **start**: begin the snap toward the stored `pendingTarget` over the
 * real-time budget remaining until its boundary, so it arrives on the boundary.
 * Clears `pendingTarget`; the animation completing is the next *arrival*.
 */
function startOnBeatSweep(v: ObsValue, perfNow: number): void {
    const pt = v.pendingTarget!;
    v.pendingTarget = null;
    const multiplier = v.animSpeed / K_ANGLE_ANIM_SPEED;
    const budgetMs = pt.boundaryRealMs - perfNow;
    if (isFinite(budgetMs) && budgetMs > 0) {
        startAnimationRaw(v.anim, pt.target, perfNow, multiplier, budgetMs, v.period);
    } else {
        // Boundary is now/past — snap.
        startAnimationRaw(v.anim, pt.target, perfNow, multiplier, undefined, v.period);
    }
    // While sweeping, the next event is arrival at the boundary (idle wakeup).
    v.nextUpdateTime = isFinite(pt.boundaryRealMs) ? pt.boundaryRealMs : Infinity;
}

/**
 * Per-frame on-beat step for one value: interpolate the in-flight snap, then run
 * the sit/sweep state machine. Replaces the gated update + animate passes for
 * `onBeat` values (it does both). Phases:
 *   - **SWEEPING** (`anim.animating`): interpolation advances it; completing it is
 *     an *arrival*.
 *   - **ARRIVED** (`!animating && !pendingTarget`): schedule the next snap
 *     (`onArrivalOnBeat`).
 *   - **SITTING** (`!animating && pendingTarget`): begin the snap once
 *     `perfNow ≥ startTime`.
 *   - **FROZEN** (`finish()` ran: `nextUpdateTime === Infinity`, nothing pending):
 *     stay put until `reset()`.
 *
 * `timeDirection === 0` (stopped): **settle to the exact current display time**
 * once, then freeze (idle). On-beat ticking is a *live-play/scrub* aesthetic; a
 * stopped clock must read the precise set time, not a beat position. This animates
 * to `A(now)` (so a step / mode-toggle while stopped flips smoothly) and freezes
 * (`nextUpdateTime = Infinity`) so nothing re-evaluates until `reset()` re-arms.
 * (The no-reset freeze paths — pause / scrub-end — instead bake `A(now)` directly
 * in `finish(env)`; this branch covers the reset-while-stopped paths: step, Now,
 * UI toggles.)
 */
function onBeatStep(
    v: ObsValue,
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    timeDirection: 0 | 1 | -1,
    tickIntervalMs: number | null,
    displayDeltaPerTickSec: number,
    withDisplayTime?: WithDisplayTime,
): void {
    const multiplier = v.animSpeed / K_ANGLE_ANIM_SPEED;

    // Frozen by finish() — hold position until reset() re-arms (nextUpdateTime=0).
    if (v.nextUpdateTime === Infinity && v.pendingTarget === null && !v.anim.animating) {
        v.currentValue = v.anim.currentValue;
        return;
    }

    // Stopped: settle to A(current display time) once (animating there), then freeze.
    if (timeDirection === 0) {
        if (!v.anim.animating) {
            const target = v.evalFn(env);
            startAnimationRaw(v.anim, target, perfNow, multiplier, undefined, v.period);
            v.pendingTarget = null;
            v.nextUpdateDisplayTime = Infinity;
            v.nextUpdateTime = Infinity;
        }
        v.currentValue = interpolateValue(v.anim, perfNow);
        return;
    }

    // Fresh re-arm after reset()/construction while *running* (resume, Now,
    // location/mode/rate/direction change): respond instantly. Do one synchronous
    // eval at the *current* display time and settle there, rather than sitting at
    // the now-stale position until the next beat. Without this, onArrivalOnBeat
    // below schedules the next-boundary target and sits at the old position until
    // `boundaryRealMs − d`; since boundary spacing is the value's update interval,
    // slow hands (large intervals — planet hands) lag many seconds behind fast
    // ones after a scrub+resume. The settle's completion is an arrival, so the
    // normal on-beat scheduling re-arms the cadence from the fresh state. Mirrors
    // the stopped-settle above and the worker-pipeline reset rule "respond now,
    // then re-arm the cadence" (planning/2026-06-26-worker-eval-ahead-pipeline.md,
    // §reset step 4). `nextUpdateTime === 0` is the reset/creation sentinel; a real
    // arrival sets it to a boundary timestamp, never 0. Scrub (tickIntervalMs > 0)
    // is excluded: there onArrivalOnBeat already re-evaluates on every compressed
    // beat, so a separate instant settle isn't needed and would perturb the tick
    // trajectory.
    if (v.nextUpdateTime === 0 && !v.anim.animating
        && (tickIntervalMs === null || tickIntervalMs <= 0)) {
        const target = v.evalFn(env);
        startAnimationRaw(v.anim, target, perfNow, multiplier, undefined, v.period);
        v.pendingTarget = null;
        // No display-time boundary is scheduled yet — the settle's *arrival* re-arms
        // the beat (onArrivalOnBeat below, on a later frame). Clear the reset
        // sentinel so neither this branch nor the frozen-check re-fires meanwhile.
        v.nextUpdateDisplayTime = Infinity;
        v.nextUpdateTime = perfNow;
        v.currentValue = interpolateValue(v.anim, perfNow);
        return;
    }

    const dir: 1 | -1 = timeDirection === -1 ? -1 : 1;

    // Advance any in-flight snap (may flip animating→false, i.e. arrive).
    const _i0 = profileEnabled ? performance.now() : 0;
    v.currentValue = interpolateValue(v.anim, perfNow);
    if (profileEnabled) tickProfile.interpMs += performance.now() - _i0;

    // Resolve the scheduling state (ARRIVED → SITTING → SWEEPING can chain in one
    // frame when the start time has already passed, e.g. continuous-sweep values).
    let started = false;
    for (let guard = 0; guard < 4 && !v.anim.animating; guard++) {
        if (v.pendingTarget === null) {
            onArrivalOnBeat(v, env, perfNow, getNow, dir,
                tickIntervalMs, displayDeltaPerTickSec, withDisplayTime);
        } else if (perfNow >= v.pendingTarget.startTime) {
            startOnBeatSweep(v, perfNow);
            started = true;
        } else {
            break;  // sitting, waiting for the start time
        }
    }
    // If a snap just started, interpolate so currentValue is fresh this frame.
    if (started) v.currentValue = interpolateValue(v.anim, perfNow);
}

// ============================================================================
// Per-frame passes
// ============================================================================

/**
 * UPDATE one value — dispatch to the appropriate branch. Caller has already
 * checked that the value's timer has expired.
 *
 * Order:
 *   1. Discrete (`v.discrete`): eval-at-now instant snap; cadence = tick if
 *      scrubbing, else boundary (the one genuinely distinct, client-chosen mode).
 *   2. Stopped (`direction === 0`): continuous value settles at the frozen time.
 *   3. Eval-ahead (`v.evalAhead`): the general continuous mechanism, mode-aware
 *      (1× boundary or scrub tick) — subsumes scrub and natural-speed.
 *   4. Legacy scrub-compression (`tickIntervalMs`) — non-eval-ahead values only.
 *   5. Legacy natural-speed two-phase sweep.
 *   6. Legacy snap-to-target at a boundary.
 *
 * Branches 4–6 are the pre-eval-ahead mechanisms Observatory still uses; we
 * converge away from them later.
 */
export function updateObsValue(
    v: ObsValue,
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    tickIntervalMs: number | null,
    displayDeltaPerTickSec: number,
    timeDirection: 0 | 1 | -1,
    withDisplayTime?: WithDisplayTime,
): void {
    if (v.discrete) {
        updateObsValueDiscrete(v, env, perfNow, getNow, timeDirection, tickIntervalMs);
    } else if (timeDirection === 0) {
        settleAtNow(v, env, perfNow);
    } else if (v.evalAhead) {
        updateObsValueEvalAhead(v, env, perfNow, getNow, timeDirection,
            tickIntervalMs, displayDeltaPerTickSec, withDisplayTime);
    } else if (tickIntervalMs !== null && tickIntervalMs > 0) {
        updateObsValueScrub(v, env, perfNow, getNow, timeDirection,
            tickIntervalMs, displayDeltaPerTickSec);
    } else if (v.naturalSpeed > 0) {
        updateNaturalSpeedValue(v, env, perfNow, getNow, timeDirection);
    } else {
        snapToTargetAtBoundary(v, env, perfNow, getNow, timeDirection);
    }
}

/**
 * Pass 1: UPDATE — re-evaluate expressions whose timer has expired.
 *
 * @param tickIntervalMs      null = 1×/−1× mode, >0 = scrub tick rate (ms)
 * @param displayDeltaPerTickSec  Display seconds advanced per tick (for scrub compression)
 * @param timeDirection       1 = forward, -1 = reverse, 0 = stopped
 * @param withDisplayTime     Required for eval-ahead values (see makeOverridableGetNow)
 */
export function updateObsValues(
    values: ObsValue[],
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    tickIntervalMs: number | null = null,
    displayDeltaPerTickSec: number = 0,
    timeDirection: 0 | 1 | -1 = 1,
    withDisplayTime?: WithDisplayTime,
): void {
    for (const v of values) {
        if (v.onBeat && !v.discrete) {
            // On-beat values run every frame (the step is its own sit/sweep state
            // machine + interpolation); they are not gated by nextUpdateTime.
            onBeatStep(v, env, perfNow, getNow, timeDirection,
                tickIntervalMs, displayDeltaPerTickSec, withDisplayTime);
        } else if (perfNow >= v.nextUpdateTime) {
            updateObsValue(v, env, perfNow, getNow,
                tickIntervalMs, displayDeltaPerTickSec, timeDirection, withDisplayTime);
        }
    }
}

/**
 * ANIMATE one value — interpolate toward its target and handle Phase 2 handoff.
 * Writes the interpolated result to `currentValue`.
 */
export function animateObsValue(v: ObsValue, perfNow: number): void {
    v.currentValue = interpolateValue(v.anim, perfNow);

    // Phase 2 handoff: if Phase 1 just finished and sweep is pending
    if (!v.anim.animating && v.pendingSweep) {
        const sweep = v.pendingSweep;
        v.pendingSweep = null;
        const sweepMultiplier = v.naturalSpeed / K_ANGLE_ANIM_SPEED;
        startAnimationRaw(v.anim, sweep.target, perfNow,
            sweepMultiplier, sweep.durationMs, v.period);
        // Re-interpolate to pick up the new animation immediately
        v.currentValue = interpolateValue(v.anim, perfNow);
    }
}

/**
 * Pass 2: ANIMATE — interpolate all values toward their targets.
 */
export function animateObsValues(values: ObsValue[], perfNow: number): void {
    for (const v of values) {
        animateObsValue(v, perfNow);
    }
}

/**
 * Reset all value schedules so they re-evaluate on the very next frame.
 * Call when the environment changes (location, noonOnTop toggle, etc.).
 */
export function resetObsValueSchedules(values: ObsValue[]): void {
    for (const v of values) {
        v.nextUpdateDisplayTime = 0;
        v.nextUpdateTime = 0;
        // Drop any on-beat plan so the next frame re-evaluates from the new state.
        v.pendingTarget = null;
    }
}

/**
 * Returns true if any value is still animating (mid-interpolation) or has a
 * pending Phase-2 sweep. The render loop uses this to decide whether to keep
 * rendering while the clock is stopped.
 */
export function anyObsAnimating(values: ObsValue[]): boolean {
    for (const v of values) {
        if (v.anim.animating || v.pendingSweep) return true;
    }
    return false;
}

// ============================================================================
// Updater — owns an ObsValue collection and drives it from a TimingContext
// ============================================================================

/**
 * Owns a collection of `ObsValue`s and advances them each frame from a
 * `TimingContext` — the generic controller↔updater seam. A client registers its
 * values, calls `tick()` per frame, and reacts to time-controller transitions via
 * `reset()`. Reading happens through the client's own per-value handles (so the
 * client controls how each value is rendered).
 *
 * This is the embryonic shared "updater subsystem"; the Inspector and Observatory
 * are its consumers.
 *
 * The optional type parameter `K` names the keys a client may look up via
 * `get(name)`. It is a pure *client-side* convenience: the shared updater stores
 * values in a plain `Map<string, ObsValue>` and never references any client's key
 * union. Observatory instantiates `Updater<ObsValueName>` for typo-checked lookup;
 * the Inspector uses the default `Updater` (`K = string`) and never calls `get()`.
 */
/**
 * Stable comparator that groups ObsValues by their scrub eval *time class*:
 * `now` (rank 0: discrete/scrub-compress), `next-tick` (rank 1: eval-ahead), and
 * `boundary` (rank 2: on-beat, sub-grouped by `updateInterval` since each interval
 * resolves to a distinct boundary). Within a leaf group every value evaluates at
 * the same display time, so they share one astro cache. (`envSlot`/`updateOffset`
 * refinements can join the key later; today they're 0/observer for ~all parts.)
 */
function byEvalTimeClass(a: ObsValue, b: ObsValue): number {
    const rank = (v: ObsValue): number => (v.onBeat ? 2 : v.evalAhead ? 1 : 0);
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 2 && a.updateInterval !== b.updateInterval) return a.updateInterval - b.updateInterval;
    return 0;
}

export class Updater<K extends string = string> {
    private values: ObsValue[] = [];
    private byName = new Map<string, ObsValue>();
    /** Whether {@link values} has been grouped for astro-cache sharing (see tick). */
    private _grouped = false;

    /** Register a value; returns it for convenient handle capture. */
    add<T extends ObsValue>(v: T): T {
        this.values.push(v);
        this.byName.set(v.name, v);
        this._grouped = false;  // re-group on next tick now that the set changed
        return v;
    }
    addAll(vs: ObsValue[]): void { for (const v of vs) this.add(v); }
    remove(v: ObsValue): void {
        const i = this.values.indexOf(v);
        if (i >= 0) this.values.splice(i, 1);
        this.byName.delete(v.name);
    }
    clear(): void { this.values.length = 0; this.byName.clear(); }
    get all(): readonly ObsValue[] { return this.values; }

    /** Look up a registered value by name; throws if no such value exists. */
    get(name: K): ObsValue {
        const v = this.byName.get(name);
        if (!v) throw new Error(`Updater.get: no value named "${name}"`);
        return v;
    }

    /** True if a value with this name is registered. */
    has(name: K): boolean { return this.byName.has(name); }

    /** Per-frame: re-evaluate expired values + animate the whole collection. */
    tick(
        env: Environment,
        perfNow: number,
        getNow: () => Date,
        withDisplayTime: WithDisplayTime,
        ctx: TimingContext,
    ): void {
        // Group values by their scrub eval *time class* so that consecutive
        // evaluations share one (location, display-time) astro cache instead of
        // thrashing it. During scrub a value evaluates at: `now` (discrete/scrub),
        // `next-tick` (eval-ahead), or its own boundary `computeNextBoundary(interval)`
        // (on-beat). That class is `(onBeat/evalAhead, interval)` — all static — so a
        // one-time stable sort suffices. Pure reorder: every evalFn is a function of
        // env + display time + cache only, so the result is order-independent.
        if (!this._grouped) {
            this.values.sort(byEvalTimeClass);
            this._grouped = true;
        }
        if (!profileEnabled) {
            updateObsValues(this.values, env, perfNow, getNow,
                ctx.tickIntervalMs, ctx.displayDeltaSec, ctx.direction, withDisplayTime);
            animateObsValues(this.values, perfNow);
            return;
        }
        const _u0 = performance.now();
        updateObsValues(this.values, env, perfNow, getNow,
            ctx.tickIntervalMs, ctx.displayDeltaSec, ctx.direction, withDisplayTime);
        const _u1 = performance.now();
        animateObsValues(this.values, perfNow);
        tickProfile.updateMs += _u1 - _u0;
        tickProfile.animateMs += performance.now() - _u1;
    }

    /** True while any value is mid-animation (for idle-scheduler decisions). */
    anyAnimating(): boolean { return anyObsAnimating(this.values); }

    /**
     * Re-evaluate every value on the next frame. Bind the time-controls transition
     * callbacks (scrub start/end, step, now, transport change) to this — clients
     * "react to transitions" without computing how the controller affects values.
     */
    reset(): void { resetObsValueSchedules(this.values); }

    /**
     * Snap every in-flight animation to its target and freeze schedules.
     *
     * For each value: clear any pending Phase-2 sweep, set the animation (and the
     * displayed `currentValue`) to the target — wrapped to `[0, period)` for cyclic
     * values, left as-is for linear ones — stop animating, and freeze the schedule
     * (`nextUpdateTime = Infinity`) so nothing re-evaluates until `reset()`.
     *
     * Used for step / transport / scrub-end transitions where the system must
     * settle immediately, and (with the freeze) to hold the stopped-clock state
     * idle. Generalizes the legacy `finishAnimations`/`finishLeafAnimations` to the
     * ObsValue fields and the `period` wrap.
     *
     * **`env` (on-beat freeze paths).** When `env` is supplied, on-beat values snap
     * to `A(current display time)` instead of `anim.targetValue` — so a clock frozen
     * *between beats* reads the exact stopped time, not the last/next beat position.
     * Pass `env` on the no-reset freeze paths (pause, scrub-end while stopped). Omit
     * it on paths that `reset()` afterward (step, Now, toggles): there `finish()`
     * just snaps where the hand is, and the subsequent stopped-`onBeatStep` settle
     * animates to `A(now)` (so those transitions still flip smoothly). Non-on-beat
     * values always snap to `anim.targetValue` regardless of `env`.
     */
    finish(env?: Environment): void {
        for (const v of this.values) {
            v.pendingSweep = null;
            v.pendingTarget = null;
            let target = (v.onBeat && env) ? v.evalFn(env) : v.anim.targetValue;
            if (isFinite(v.period)) {
                target = ((target % v.period) + v.period) % v.period;
            }
            v.anim.currentValue = target;
            v.anim.targetValue = target;
            v.anim.animating = false;
            v.currentValue = target;
            v.nextUpdateDisplayTime = Infinity;
            v.nextUpdateTime = Infinity;
        }
    }

    /**
     * Earliest `performance.now()` at which any value is scheduled to re-evaluate
     * (`Infinity` if all are frozen). The idle scheduler uses this to set a precise
     * wakeup `setTimeout`. Generalizes the legacy `nextWakeupTime(states)`.
     */
    nextWakeupTime(): number {
        let earliest = Infinity;
        for (const v of this.values) {
            if (v.nextUpdateTime < earliest) earliest = v.nextUpdateTime;
        }
        return earliest;
    }

    /**
     * Like `tick()`, but forces every value to animate over exactly
     * `durationMs` of real time — no boundary scheduling, no two-phase
     * sweep.  Used for drag-to-explore, where pointer events drive
     * continuous re-evaluation at a fixed animation budget.
     *
     * Bypasses the `nextUpdateTime` gate (every value is always updated)
     * and ignores the `TimingContext` entirely.
     */
    tickFixedDuration(env: Environment, perfNow: number, durationMs: number): void {
        for (const v of this.values) {
            updateObsValueFixedDuration(v, env, perfNow, durationMs);
        }
        animateObsValues(this.values, perfNow);
    }

    /**
     * Interpolation-only pass — advance in-flight animations without
     * re-evaluating expressions.  Use on frames where the inputs (env)
     * haven't changed but existing animations should keep progressing.
     */
    animateOnly(perfNow: number): void {
        animateObsValues(this.values, perfNow);
    }
}
