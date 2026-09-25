/**
 * The drag magnifier's visibility gate (magnifier-gate.ts; plan
 * planning/2026-09-24-magnifier-speed-gating.md §7):
 *
 *  (a) a press that does not move: hidden for MAG_DWELL_MS, then a fade-in
 *      over MAG_FADE_MS; the rest clock counts from the press.
 *  (b) after a sweep the rest clock counts from the stop.
 *  (c) "at rest" is an average: a crawl under MAG_REST_V shows at
 *      MAG_DWELL_MS, one over it never shows; a 1 px twitch every few
 *      hundred ms (touch jitter) does not restart the clock.
 *  (d) shown: a fast excursion inside MAG_FAR_PX keeps it; MAG_FAR_PX of
 *      drift within MAG_DRIFT_MS hides it at once and a fresh rest is
 *      needed; a crawl slower than MAG_FAR_PX / MAG_DRIFT_MS keeps it for
 *      any length (the trail anchor moves with it), a burst split across
 *      any instant still counts, and a jump after a parked gap counts
 *      against the position the pointer left.
 *  (e) magGateAnimating — true while hidden or ramping, false once shown
 *      and settled; a step after a long parked gap finds the clock elapsed;
 *      the rule is frame-rate independent; reset forgets everything.
 */
import { describe, test, expect } from 'vitest';
import {
    createMagGate, resetMagGate, stepMagGate, magGateAnimating, magGateDebug,
    MAG_REST_V, MAG_DWELL_MS, MAG_FAR_PX, MAG_FADE_MS, MAG_REST_PX, MAG_DRIFT_MS,
    type MagGate,
} from '../magnifier-gate.js';

let clock = 0, px = 0, py = 0;

function fresh(): MagGate {
    clock = 1000; px = 400; py = 100;
    const g = createMagGate();
    stepMagGate(g, px, py, clock);  // the first frame: takes the point, no motion yet
    return g;
}

/** Step at `dt` ms for `ms` with the pointer moving at (vx, vy) CSS px/s. */
function drive(g: MagGate, vx: number, vy: number, ms: number, dt = 16): number {
    let a = g.alpha;
    for (let i = 0; i < ms / dt; i++) {
        clock += dt;
        px += vx * dt / 1000;
        py += vy * dt / 1000;
        a = stepMagGate(g, px, py, clock);
    }
    return a;
}

/** Jump the pointer by (dx, dy) in one frame. */
function jump(g: MagGate, dx: number, dy: number, dt = 16): number {
    clock += dt; px += dx; py += dy;
    return stepMagGate(g, px, py, clock);
}

describe('showing', () => {
    test('a press that does not move: hidden for MAG_DWELL_MS, then fades in', () => {
        const g = fresh();
        expect(g.shown).toBe(false);
        expect(drive(g, 0, 0, MAG_DWELL_MS - 100)).toBe(0);
        expect(g.shown).toBe(false);
        expect(magGateAnimating(g)).toBe(true);           // the rest clock is counting
        const { restMs } = magGateDebug(g, px, py, clock);   // the drive rounds up to whole frames
        expect(restMs).toBeGreaterThanOrEqual(MAG_DWELL_MS - 100);
        expect(restMs).toBeLessThan(MAG_DWELL_MS);
        drive(g, 0, 0, 100 + 16);
        expect(g.shown).toBe(true);
        const a0 = g.alpha;                               // the ramp began on the frame it showed
        expect(drive(g, 0, 0, 64)).toBeCloseTo(a0 + 64 / MAG_FADE_MS, 2);
        expect(drive(g, 0, 0, MAG_FADE_MS)).toBe(1);
        expect(magGateAnimating(g)).toBe(false);
    });

    test('after a sweep the rest clock counts from the stop', () => {
        const g = fresh();
        drive(g, 600, 0, 400);                            // 240 px sweep
        expect(g.shown).toBe(false);
        expect(magGateDebug(g, px, py, clock).restMs).toBeLessThan(50);
        drive(g, 0, 0, MAG_DWELL_MS - 100);
        expect(g.shown).toBe(false);
        drive(g, 0, 0, 100 + 16);
        expect(g.shown).toBe(true);
        expect(magGateDebug(g, px, py, clock).driftPx).toBe(0);
    });

    test('a crawl under MAG_REST_V shows at MAG_DWELL_MS; one over it never shows', () => {
        const slow = fresh();
        drive(slow, MAG_REST_V * 0.8, 0, MAG_DWELL_MS + 16);
        expect(slow.shown).toBe(true);
        const fast = fresh();
        drive(fast, MAG_REST_V * 1.2, 0, 5 * MAG_DWELL_MS);
        expect(fast.shown).toBe(false);
        expect(fast.alpha).toBe(0);
    });

    test('touch jitter — a 1 px twitch every 100 ms — does not restart the clock', () => {
        const g = fresh();
        const start = clock;
        for (let i = 0; clock - start < MAG_DWELL_MS - 150; i++) {
            drive(g, 0, 0, 100);
            jump(g, i % 2 ? 1 : -1, 0);                   // 60 px/s for one frame
        }
        expect(g.shown).toBe(false);                      // most of the dwell at rest so far
        drive(g, 0, 0, 200);
        expect(g.shown).toBe(true);                       // a little more and it shows
    });
});

describe('hiding', () => {
    function shown(): MagGate {
        const g = fresh();
        drive(g, 0, 0, MAG_DWELL_MS + MAG_FADE_MS + 32);
        expect(g.alpha).toBe(1);
        return g;
    }

    test('a fast excursion inside MAG_FAR_PX keeps it, whatever the speed', () => {
        const g = shown();
        jump(g, MAG_FAR_PX * 0.6, 0);                     // 6 px in one frame: 375 px/s
        expect(g.shown).toBe(true);
        jump(g, -MAG_FAR_PX * 0.6, 0);
        drive(g, 0, 0, 500);
        expect(g.shown).toBe(true);
        expect(g.alpha).toBe(1);
    });

    test('MAG_FAR_PX of drift hides it at once; a fresh rest is needed', () => {
        const g = shown();
        drive(g, MAG_REST_V * 0.8, 0, 1000);              // 4 px, slowly: still inside
        expect(g.shown).toBe(true);
        jump(g, MAG_FAR_PX, 0);                           // 14 px from where it was a second ago
        expect(g.shown).toBe(false);
        expect(magGateAnimating(g)).toBe(true);
        expect(drive(g, 0, 0, MAG_FADE_MS + 16)).toBe(0);
        drive(g, 0, 0, MAG_DWELL_MS - 300);
        expect(g.shown).toBe(false);
        drive(g, 0, 0, 300 + 16);
        expect(g.shown).toBe(true);                       // the rest began at the hide
    });

    test('a diagonal drift counts the whole vector', () => {
        const g = shown();
        jump(g, MAG_FAR_PX * 0.75, MAG_FAR_PX * 0.75);    // 10.6 px
        expect(g.shown).toBe(false);
    });

    test('a crawl slower than MAG_FAR_PX / MAG_DRIFT_MS keeps it for any length', () => {
        const g = shown();
        const v = 0.8 * MAG_FAR_PX / (MAG_DRIFT_MS / 1000);   // 8 px/s
        drive(g, v, 0, 10000);                                // 80 px, well past any fixed anchor
        expect(g.shown).toBe(true);
        expect(g.alpha).toBe(1);
        expect(magGateDebug(g, px, py, clock).driftPx).toBeLessThan(MAG_FAR_PX);
    });

    test('a crawl faster than MAG_FAR_PX / MAG_DRIFT_MS hides it', () => {
        const g = shown();
        const v = 1.3 * MAG_FAR_PX / (MAG_DRIFT_MS / 1000);   // 13 px/s
        drive(g, v, 0, 1500);
        expect(g.shown).toBe(false);
    });

    test('a burst split across any instant still counts: 6 px, a pause, 6 px more', () => {
        const g = shown();
        drive(g, 0, 0, 900);
        jump(g, MAG_FAR_PX * 0.6, 0);
        drive(g, 0, 0, 200);                              // straddles where a 1 s anchor reset would fall
        jump(g, MAG_FAR_PX * 0.6, 0);                     // 12 px within 0.25 s
        expect(g.shown).toBe(false);
    });

    test('an out-and-back beyond MAG_FAR_PX hides it at the far point', () => {
        const g = shown();
        jump(g, MAG_FAR_PX * 1.2, 0);
        expect(g.shown).toBe(false);
    });

    test('the trail forgets: MAG_FAR_PX covered over more than MAG_DRIFT_MS is a crawl, not a burst', () => {
        const g = shown();
        jump(g, MAG_FAR_PX * 0.6, 0);
        drive(g, 0, 0, MAG_DRIFT_MS + 100);
        jump(g, MAG_FAR_PX * 0.6, 0);                     // 12 px total, but 1.1 s apart
        expect(g.shown).toBe(true);
    });

    test('a jump after a parked gap counts against the position the pointer left', () => {
        const g = shown();
        clock += 5000;                                    // the loop parked; no samples for 5 s
        expect(jump(g, MAG_FAR_PX * 1.2, 0)).toBeLessThan(1);
        expect(g.shown).toBe(false);
    });
});

describe('frames, gaps, rates, reset', () => {
    test('a step after a long parked gap finds the rest clock elapsed', () => {
        const g = fresh();
        drive(g, 0, 0, 200);
        clock += MAG_DWELL_MS + 1000;                     // the loop parked, the pointer still
        stepMagGate(g, px, py, clock);
        expect(g.shown).toBe(true);
        expect(g.alpha).toBe(1);                          // the ramp completed in the gap
    });

    test('the rule is frame-rate independent', () => {
        const at60 = fresh();
        drive(at60, MAG_REST_V * 0.8, 0, MAG_DWELL_MS + 32, 16);
        const at240 = fresh();
        drive(at240, MAG_REST_V * 0.8, 0, MAG_DWELL_MS + 32, 4);
        expect(at60.shown).toBe(true);
        expect(at240.shown).toBe(true);
        // ... and the hide rule: a 13 px/s crawl goes at both rates, an 8 px/s one stays.
        for (const [dt, v, want] of [[16, 13, false], [4, 13, false], [16, 8, true], [4, 8, true]] as const) {
            const g = fresh();
            drive(g, 0, 0, MAG_DWELL_MS + MAG_FADE_MS + 32, dt);
            expect(g.alpha).toBe(1);
            drive(g, v, 0, 1500, dt);
            expect(g.shown).toBe(want);
        }
    });

    test('MAG_REST_PX is the distance MAG_REST_V covers in MAG_DWELL_MS', () => {
        expect(MAG_REST_PX).toBeCloseTo(MAG_REST_V * MAG_DWELL_MS / 1000, 9);
    });

    test('reset forgets the previous drag', () => {
        const g = fresh();
        drive(g, 0, 0, MAG_DWELL_MS + MAG_FADE_MS + 32);
        expect(g.alpha).toBe(1);
        resetMagGate(g);
        expect(g.shown).toBe(false);
        expect(g.alpha).toBe(0);
        expect(g.hasPos).toBe(false);
        expect(magGateDebug(g, px, py, clock)).toEqual({ restMs: 0, driftPx: 0 });
    });
});
