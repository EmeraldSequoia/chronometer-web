/**
 * Natural-speed (second hand) resync regressions — 2026-10-28.
 *
 * Two defects in the two-phase natural-speed mechanism showed up together on
 * every tab return (Observatory: resyncAfterGap = finish() + reset()):
 *
 *   1. `finish()` snapped a natural-speed hand to `anim.targetValue`, which for
 *      these values is the END of the current sweep — up to 20 s in the future.
 *      The hand jumped ahead by the remaining sweep and the catch-up then ran
 *      it backwards (at a speed that depended on where in the 20 s cycle the
 *      tab was hidden: still, creeping, or several times normal speed).
 *   2. Phase 1 measured the error clockwise into [0, 2π) and computed its
 *      duration for that path, but `startAnimationRaw` animates the shortest
 *      path, so any error over π (a hand more than 30 s behind, or any hand
 *      that is ahead) moved backwards over a duration computed for the forward
 *      trip.
 *
 * The scenarios drive the real Updater with fake wall and perf clocks, mirroring
 * the loop's per-frame sequence (checkTick → beginFrame → tick → endFrame).
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createObsValue } from '../obs-value';
import { Updater, timingContextForFrame, makeOverridableGetNow } from '../updater';
import { TimeController } from '../time-controller';
import type { Environment } from '../../expr/env';

const W = 2 * Math.PI / 60;          // second-hand natural speed, rad/s
const STEP = 1000 / 60;              // 60 fps
const T0 = new Date('2026-10-28T10:00:00.000Z').getTime();   // on a 20 s boundary

let wall = T0;
let perf = 100_000;

beforeEach(() => {
    wall = T0; perf = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    vi.spyOn(performance, 'now').mockImplementation(() => perf);
});
afterEach(() => { vi.restoreAllMocks(); });

function setup() {
    const tc = new TimeController();
    // Anchor display time to the fake wall clock (1× forward, offset 0).
    tc.setTime(new Date(wall));
    tc.setOffset(0);
    const { getNow, withDisplayTime } = makeOverridableGetNow(() => tc.getDisplayTime());
    const functions = new Map<string, (...a: number[]) => number>();
    functions.set('secAngle', () => ((getNow().getTime() / 1000) % 60) * W);
    const env = { functions, variables: new Map() } as unknown as Environment;
    const u = new Updater();
    const v = u.add(createObsValue(
        { name: 'second', expr: 'secAngle()', updateInterval: 20, naturalSpeed: W }, env, perf));
    const frame = () => {
        tc.checkTick(perf); tc.beginFrame();
        u.tick(env, perf, getNow, withDisplayTime, timingContextForFrame(tc));
        tc.endFrame();
    };
    const run = (ms: number) => { for (let t = 0; t < ms; t += STEP) { frame(); wall += STEP; perf += STEP; } };
    /** One frame, measured right after it draws (before the clocks advance). */
    const stepFrame = () => { frame(); const e = errSec(); wall += STEP; perf += STEP; return e; };
    /** Hand minus correct, in seconds, wrapped to (−30, 30]. */
    const errSec = () => {
        let d = v.currentValue / W - ((getNow().getTime() / 1000) % 60);
        return ((d + 30) % 60 + 60) % 60 - 30;
    };
    return { u, v, frame, run, stepFrame, errSec };
}

describe('natural-speed hand across a gap (finish + reset)', () => {
    test('a short hidden-tab gap: finish() leaves the hand where the sweep has it — no jump, no motion', () => {
        const { u, run, stepFrame, errSec } = setup();
        run(14_000);                              // 14 s into the 20 s cycle: 6 s of sweep remain
        expect(Math.abs(errSec())).toBeLessThan(0.05);
        wall += 1000; perf += 1000;               // hidden 1 s: no frames, both clocks run
        u.finish(); u.reset();
        // Pre-fix: +4.98 s here (the sweep's end), then backwards for 3 s.
        expect(Math.abs(errSec())).toBeLessThan(0.05);
        for (let t = 0; t < 3000; t += STEP) {
            expect(Math.abs(stepFrame())).toBeLessThan(0.05);
        }
    });

    test('a system sleep (perf clock frozen): the hand is behind by the gap and catches up forward', () => {
        const { u, run, stepFrame, errSec } = setup();
        run(10_000);
        wall += 5000;                              // 5 s asleep: wall advances, perf does not
        u.finish(); u.reset();
        expect(errSec()).toBeCloseTo(-5, 0);
        let prev = errSec();
        let settledAt = -1;
        for (let t = 0; t < 2000; t += STEP) {
            const e = stepFrame();
            if (settledAt < 0) {
                expect(e).toBeGreaterThanOrEqual(prev - 1e-6);   // monotonic forward catch-up
                if (Math.abs(e) < 0.05) settledAt = t;
            }
            prev = e;
        }
        // 5 s of error closes at (2 − 2π/60) rad/s ≈ 0.28 s; allow a frame or two.
        expect(settledAt).toBeGreaterThan(0);
        expect(settledAt).toBeLessThan(450);
    });
});

describe('Phase 1 direction and duration agree', () => {
    test('a hand AHEAD backs up at the catch-up speed, not at a speed computed for the long way round', () => {
        const { u, v, run, stepFrame, errSec } = setup();
        run(3000);
        v.anim.currentValue += 5 * W; v.anim.targetValue += 5 * W; v.currentValue += 5 * W;  // 5 s ahead
        u.finish(); u.reset();
        expect(errSec()).toBeCloseTo(5, 0);
        let prev = errSec();
        let settledAt = -1;
        for (let t = 0; t < 2000; t += STEP) {
            const e = stepFrame();
            if (settledAt < 0) {
                expect(e).toBeLessThanOrEqual(prev + 1e-6);      // monotonic backward
                if (Math.abs(e) < 0.05) settledAt = t;
            }
            prev = e;
        }
        // 5 s ahead closes at (2 + 2π/60) rad/s ≈ 0.25 s. Pre-fix this took ~3 s.
        expect(settledAt).toBeGreaterThan(0);
        expect(settledAt).toBeLessThan(400);
    });

    test('a hand more than 30 s behind takes the short way back over a matching duration', () => {
        const { u, run, stepFrame, errSec } = setup();
        run(10_000);
        wall += 40_000; perf += 40_000;            // hidden 40 s: sweep ended at the 20 s mark, hand 30 s off
        u.finish(); u.reset();
        const e0 = Math.abs(errSec());
        expect(e0).toBeGreaterThan(25);
        let settledAt = -1;
        for (let t = 0; t < 3000; t += STEP) {
            const e = stepFrame();
            if (settledAt < 0 && Math.abs(e) < 0.05) settledAt = t;
        }
        // ≤ π of error at ≥ (2 − 2π/60) rad/s: under 1.7 s, and it lands exactly.
        expect(settledAt).toBeGreaterThan(0);
        expect(settledAt).toBeLessThan(1700);
        expect(Math.abs(errSec())).toBeLessThan(0.05);
    });
});
