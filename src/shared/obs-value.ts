/**
 * ObsValue — a single expression-driven animated value.
 *
 * An ObsValue holds a parsed AST expression, an update interval, animation
 * speeds, and an AnimatingValue for smooth interpolation between updates.
 * It is the general-purpose animation-value primitive shared across apps
 * (Observatory today; Inspector; eventually Chronometer).
 *
 * This module owns the *value* (the data type + construction). The logic that
 * *drives* values each frame — scheduling, the update branches, interpolation —
 * lives in the companion `updater.ts` (the embryonic "updater" subsystem).
 *
 * Modeled after the watch-face HandState/AnimatingValue system in animation.ts.
 */

import type { Environment } from '../expr/env.js';
import { compileExpr, type CompiledExpr } from '../expr/compile.js';
import { type AnimatingValue, makeAnimatingValue } from './animation.js';

/**
 * An `animSpeed` sentinel meaning "jump instantly to the target on a settle /
 * snap update" (no animation). Used by clients with digital readouts (the
 * Inspector), where a value can be any magnitude and a finite settle speed would
 * either crawl or overshoot. Distinct from "snap", which elsewhere means
 * "animate at the default speed" (the legacy snap-to-target branch).
 */
export const JUMP = Infinity;

// ============================================================================
// Types
// ============================================================================

/** A single dynamic value. */
export interface ObsValue {
    /** Human-readable name for debugging. */
    name: string;

    /** Source expression string for computing this value's target (kept for
     *  debugging; the actual evaluation goes through {@link evalFn}). */
    expr: string;

    /** Compiled closure that evaluates {@link expr} in this value's environment.
     *  Captured once at construction; recomputed whenever the env is rebuilt
     *  (which reconstructs the ObsValue). Named `evalFn`, not `eval`, to avoid
     *  shadowing the global. */
    evalFn: CompiledExpr;

    /** Update interval in seconds.
     *  Positive: epoch-aligned boundary (e.g., 3600 = hourly, 1 = per second,
     *    0.1 = ten times per second).
     *  Negative: sentinel (e.g., EC_UPDATE_NEXT_SUNRISE). */
    updateInterval: number;

    /** Settle / catch-up animation speed, in units/s (rad/s for angular values).
     *  Governs the *non-budget* animations — the stopped-state settle, the
     *  legacy snap-to-target, and a continuous value's catch-up after a gap.
     *  (Eval-ahead and scrub ignore it; they animate over an explicit time
     *  budget.) Default 2.0.
     *
     *  This is the per-app "default animation speed" carried over from
     *  Chronometer/Observatory, made client-controllable per value. There is no
     *  meaningful finite speed for an arbitrary linear value (a value in seconds,
     *  AU, or a dateInterval spans many orders of magnitude), so a client showing
     *  *digital* readouts sets it to {@link JUMP} (= Infinity) to jump instantly
     *  to the correct value on settle rather than creep at a mis-scaled rate. */
    animSpeed: number;

    /** If true, the value is **continuous**: at 1× / −1× the updater evaluates
     *  it at the current display time *every frame* and sets it directly, and
     *  only *animates* (at `animSpeed`, shortest path, re-aimed each frame) when
     *  the drawn position is off by more than the updater's snap threshold —
     *  after a hidden tab, a sleep, a Now press, at startup. Observatory's second
     *  hands. `updateInterval` is not consulted at 1× for these (scrub
     *  re-evaluates every value every tick; stopped settles at the frozen time).
     *  Replaced the two-phase natural-speed sweep on 2026-10-28; see
     *  updater.ts `updateObsValueContinuous`. */
    continuous: boolean;

    /** Current computed value. NaN = "don't display this element". */
    currentValue: number;

    /** Animation state — always present, all values animate. */
    anim: AnimatingValue;

    /** Display-time ms-since-epoch of the next scheduled update. */
    nextUpdateDisplayTime: number;

    /** performance.now() at which the next update should fire. */
    nextUpdateTime: number;

    /** On-beat scheduling (see {@link onBeat}). When the value has *arrived* at a
     *  boundary and is *sitting* waiting to begin its next snap, this holds the
     *  already-evaluated next target, the real time the boundary lands
     *  (`boundaryRealMs`), and the real time to *begin* the snap (`startTime =
     *  boundaryRealMs − d`, where `d` is the sweep duration). `null` while sweeping
     *  or frozen. The on-beat phase is implicit: sweeping ⇒ `anim.animating`;
     *  sitting ⇒ `pendingTarget != null && !anim.animating`. */
    pendingTarget: { target: number; boundaryRealMs: number; startTime: number } | null;

    /** If true, this value is linear (not an angle) — skip fmod wrapping.
     *  Used for earth view values like sun declination, and for the Inspector's
     *  raw-number / date readouts. Def-level input; the updater drives animation
     *  off {@link period} (derived from this). */
    linear: boolean;

    /** Wrap period for shortest-path animation: `2π` for angles, `Infinity` for
     *  linear values, or any finite period for a cyclic non-angle (e.g. the
     *  analemma path parameter, period = PATH_SAMPLE_COUNT). Derived at
     *  construction: `linear ? Infinity : (def.period ?? 2π)`. The single source
     *  of truth the updater/animation core use for wrapping. */
    period: number;

    /** If true, use the lag-free "eval-ahead" update: evaluate the expression at
     *  the *next* update boundary (one interval into the future) and sweep there,
     *  arriving exactly as that boundary occurs. Eliminates the one-interval lag
     *  of interpolating between past samples. Requires a `withDisplayTime` helper
     *  to be supplied to the updater (see updater.ts / makeOverridableGetNow). */
    evalAhead: boolean;

    /** If true, use **on-beat scheduling**: the value *snaps at its natural speed*
     *  but *lands exactly on the beat* (the update boundary), instead of stretching
     *  the sweep across the whole interval (plain {@link evalAhead}) or starting the
     *  snap at the beat (legacy). On arrival at boundary `B_k`, the next target at
     *  `B_{k+1}` is evaluated and stored in {@link pendingTarget}; the value *sits*
     *  until `B_{k+1} − d` then snaps over `d`, arriving on `B_{k+1}`. Gives ticks +
     *  1× idle + on-beat precision. Mutually exclusive with `evalAhead`/`discrete`;
     *  requires `withDisplayTime`. See
     *  planning/2026-06-26-worker-eval-ahead-pipeline.md. */
    onBeat: boolean;

    /** If true, the updater evaluates this value at the *current* display time and
     *  **snaps** (no eval-ahead, no interpolation), so the underlying function's
     *  semantics decide which value applies now. Takes precedence over `evalAhead`.
     *
     *  This is a **client policy, not a property of the expression.** The client
     *  sets it when interpolating the value across a change would be meaningless
     *  *for that display*. Example: when today's sunrise rolls over to the next
     *  day's, the Inspector's *text* readout should **jump** to the new time, while
     *  a graphical client **animates** the same quantity — Observatory's sunrise
     *  hand sweeps smoothly to the new day's position. So `discrete` is rare in
     *  Observatory/Chronometer (graphical, animate everywhere) and common only in
     *  the Inspector's text readouts. */
    discrete: boolean;
}

/** Declarative definition used to construct an ObsValue (string expression). */
export interface ObsValueDef {
    name: string;
    expr: string;
    updateInterval: number;  // seconds
    animSpeed?: number;      // catch-up speed in rad/s; default 2.0
    continuous?: boolean;    // if true, evaluate every frame and track directly (second hands)
    linear?: boolean;        // if true, value is not an angle — skip fmod wrapping
    period?: number;         // cyclic wrap period (default 2π for angles); ignored when linear
    evalAhead?: boolean;     // if true, use lag-free eval-ahead update
    onBeat?: boolean;        // if true, use on-beat scheduling (snap lands on the boundary)
    discrete?: boolean;      // if true, evaluate at current time and snap (no interpolation)
}

// ============================================================================
// Construction
// ============================================================================

/** Create a single ObsValue from a definition with a string expression. The
 *  expression is compiled once here; the closure is stored on {@link ObsValue.evalFn}
 *  and called by the updater each frame. */
export function createObsValue(
    def: ObsValueDef,
    env: Environment,
    perfNow: number,
    _getNow?: () => Date,
): ObsValue {
    const expr = def.expr;
    const evalFn = compileExpr(expr);
    const initialValue = evalFn(env);
    const animSpeed = def.animSpeed ?? 2.0;      // rad/s
    const linear = def.linear ?? false;
    // Wrap period: linear ⇒ no wrap (Infinity); else the given period or 2π (angle).
    const period = linear ? Infinity : (def.period ?? 2 * Math.PI);

    return {
        name: def.name,
        expr,
        evalFn,
        updateInterval: def.updateInterval,
        animSpeed,
        continuous: def.continuous ?? false,
        currentValue: initialValue,
        anim: makeAnimatingValue(initialValue, perfNow),
        // Schedule immediate update on first frame so animation starts right away.
        nextUpdateDisplayTime: 0,
        nextUpdateTime: 0,
        pendingTarget: null,
        linear,
        period,
        evalAhead: def.evalAhead ?? false,
        onBeat: def.onBeat ?? false,
        discrete: def.discrete ?? false,
    };
}
