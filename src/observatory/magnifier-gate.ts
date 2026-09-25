/**
 * Drag-magnifier gate — decides, frame by frame, how visible the Observatory
 * map's drag magnifier is from how the pointer is moving.
 * planning/2026-09-24-magnifier-speed-gating.md (Part 6 of
 * planning/2026-09-14-user-options-panel.md, §3.6; the rule below is
 * Steve's — review round 1, §7 of the plan).
 *
 * The bubble is for very small motions — refining a position by a few
 * pixels — and for nothing else, so it stays off the map unless the pointer
 * has clearly settled:
 *
 *  - It appears only once the pointer has been at rest for MAG_DWELL_MS.
 *    "At rest" is an average speed under MAG_REST_V over that time: the
 *    pointer has stayed within MAG_REST_PX (= MAG_REST_V × MAG_DWELL_MS) of
 *    where it came to rest. Averaged, not instantaneous: at 5 px/s an
 *    instantaneous estimate is down at the level of touch jitter, where a
 *    single 1 px twitch reads 60 px/s for a frame and would restart the
 *    clock on a phone forever.
 *  - Once shown it stays through small excursions, whatever their speed,
 *    and goes the moment the pointer is MAG_FAR_PX from any point it held
 *    within the last MAG_DRIFT_MS (review round 2, §8 of the plan): the
 *    anchor is the whole trail of the last second, so a slow crawl of any
 *    length keeps the bubble while a burst of MAG_FAR_PX hides it whenever
 *    it happens. Then a fresh rest is needed.
 *
 * Pure: no canvas, no DOM. earth-view.ts feeds it the drag point (CSS px)
 * and the frame time and multiplies the bubble's opacity by what comes back.
 * Opacity ramps linearly over MAG_FADE_MS each way — an opacity change, not
 * motion, so it is not gated on prefers-reduced-motion (the same call as the
 * body selector's tap wash).
 */

/** Average speed below which the pointer counts as at rest, CSS px/s. */
export const MAG_REST_V = 5;
/** How long the pointer must be at rest before the bubble shows, ms
 *  (2000 → 1000, review round 3). */
export const MAG_DWELL_MS = 1000;
/** Displacement that hides the bubble, CSS px: more than this from any
 *  point the pointer held within the last MAG_DRIFT_MS. A faster twitch
 *  that stays inside this radius does not. */
export const MAG_FAR_PX = 10;
/** How far back the trail reaches, ms. A crawl slower than
 *  MAG_FAR_PX / MAG_DRIFT_MS never hides the bubble. */
export const MAG_DRIFT_MS = 1000;
/** Opacity ramp, each way, ms. */
export const MAG_FADE_MS = 150;
/** Radius the pointer must stay inside to count as at rest: the distance
 *  MAG_REST_V covers in MAG_DWELL_MS. */
export const MAG_REST_PX = MAG_REST_V * MAG_DWELL_MS / 1000;

/** The trail samples the position at most this often, so a fixed ring
 *  covers MAG_DRIFT_MS at any frame rate (TRAIL_N slots ≥ MAG_DRIFT_MS /
 *  TRAIL_SAMPLE_MS, plus one for the boundary reference). */
const TRAIL_SAMPLE_MS = 8;
const TRAIL_N = 256;

export interface MagGate {
    /** Whether the bubble is wanted — the opacity's target. */
    shown: boolean;
    /** Opacity, 0..1, ramping toward `shown`. */
    alpha: number;
    /** False until the first step after a reset (no reference point yet). */
    hasPos: boolean;
    /** Last step's frame time, ms. */
    lastT: number;
    /** Hidden: where and when the current rest began. */
    restX: number;
    restY: number;
    restSince: number;
    /** Shown: the trail of positions over the last MAG_DRIFT_MS — a ring of
     *  (t, x, y) triples, `trailHead` the next slot to write, `trailLen` the
     *  slots in use. Kept rather than rebuilt: no per-frame allocation. */
    trail: Float64Array;
    trailHead: number;
    trailLen: number;
    lastSampleT: number;
    /** Diagnostics: the shown-phase drift measured on the last step. */
    drift: number;
}

export function createMagGate(): MagGate {
    const g: MagGate = {
        shown: false, alpha: 0, hasPos: false, lastT: 0,
        restX: 0, restY: 0, restSince: 0,
        trail: new Float64Array(3 * TRAIL_N), trailHead: 0, trailLen: 0, lastSampleT: 0,
        drift: 0,
    };
    resetMagGate(g);
    return g;
}

/** Drag start (or resume): hidden, and the rest clock starts at the first
 *  step — a press that does not move shows the bubble after MAG_DWELL_MS. */
export function resetMagGate(g: MagGate): void {
    g.shown = false;
    g.alpha = 0;
    g.hasPos = false;
    g.trailLen = 0;
    g.trailHead = 0;
    g.drift = 0;
}

function trailPush(g: MagGate, t: number, x: number, y: number): void {
    const k = 3 * g.trailHead;
    g.trail[k] = t; g.trail[k + 1] = x; g.trail[k + 2] = y;
    g.trailHead = (g.trailHead + 1) % TRAIL_N;
    if (g.trailLen < TRAIL_N) g.trailLen++;
    g.lastSampleT = t;
}

/**
 * The farthest the pointer now is from any point of the trail within the
 * last MAG_DRIFT_MS — plus the youngest point older than that, the boundary
 * reference: after the loop parked with the bubble shown and the pointer
 * still, it is the position the pointer left, and a jump from it must count.
 */
function trailDrift(g: MagGate, x: number, y: number, t: number): number {
    let max = 0;
    for (let i = 0; i < g.trailLen; i++) {
        const k = 3 * ((g.trailHead - 1 - i + TRAIL_N) % TRAIL_N);
        const d = Math.hypot(x - g.trail[k + 1], y - g.trail[k + 2]);
        if (d > max) max = d;
        if (t - g.trail[k] > MAG_DRIFT_MS) break;
    }
    return max;
}

/**
 * Advance the gate to frame time `t` (ms) with the drag point at (x, y) CSS
 * px and return the bubble's opacity for this frame. Pure geometry and time,
 * so the frame or pointer-event rate does not matter, and a step after a
 * long gap (the loop parked with the pointer still) simply finds the rest
 * clock further along — the right answer for a pointer that has not moved.
 */
export function stepMagGate(g: MagGate, x: number, y: number, t: number): number {
    if (!g.hasPos) {
        g.hasPos = true;
        g.lastT = t;
        g.restX = x; g.restY = y; g.restSince = t;
        return g.alpha;
    }
    const dt = t - g.lastT;
    if (dt <= 0) return g.alpha;
    g.lastT = t;

    if (!g.shown) {
        if (Math.hypot(x - g.restX, y - g.restY) > MAG_REST_PX) {
            g.restX = x; g.restY = y; g.restSince = t;
        } else if (t - g.restSince >= MAG_DWELL_MS) {
            g.shown = true;
            g.trailLen = 0; g.trailHead = 0;
            trailPush(g, t, x, y);
            g.drift = 0;
        }
    } else {
        g.drift = trailDrift(g, x, y, t);
        if (g.drift > MAG_FAR_PX) {
            g.shown = false;
            g.restX = x; g.restY = y; g.restSince = t;
        } else if (t - g.lastSampleT >= TRAIL_SAMPLE_MS) {
            trailPush(g, t, x, y);
        }
    }

    const target = g.shown ? 1 : 0;
    const step = dt / MAG_FADE_MS;
    g.alpha = g.alpha < target
        ? Math.min(target, g.alpha + step)
        : Math.max(target, g.alpha - step);
    return g.alpha;
}

/**
 * True while the gate needs frames: the opacity is ramping, or the bubble is
 * hidden and its rest clock is counting toward a show. The render loop keeps
 * producing frames for it.
 */
export function magGateAnimating(g: MagGate): boolean {
    return !g.shown || g.alpha < 1;
}

/** Diagnostics: ms at rest so far (0 when shown) and the drift the rule
 *  measures — from the rest point while hidden, over the trail while shown. */
export function magGateDebug(g: MagGate, x: number, y: number, t: number): { restMs: number; driftPx: number } {
    if (!g.hasPos) return { restMs: 0, driftPx: 0 };
    return g.shown
        ? { restMs: 0, driftPx: g.drift }
        : { restMs: t - g.restSince, driftPx: Math.hypot(x - g.restX, y - g.restY) };
}
