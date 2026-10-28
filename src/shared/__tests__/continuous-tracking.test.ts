/**
 * Continuous values (Observatory's second hands) — 2026-10-28.
 *
 * At 1× / −1× a continuous value is evaluated at the current display time
 * every frame and set directly; it only *animates* (at animSpeed, shortest
 * path, re-aimed each frame) when the drawn position is off by more than the
 * snap threshold — a hidden tab, a system sleep, a Now press, startup.
 *
 * This replaced the two-phase natural-speed sweep, whose future sweep target
 * finish() snapped to on every tab return (the hand jumped up to 20 s ahead
 * and ran backwards) and whose direction-dependent catch-up arithmetic
 * disagreed with the shortest-path animator (planning/2026-10-28-second-
 * hands-continuous-tracking.md). The scenarios drive the real Updater with
 * fake wall and perf clocks through the loop's per-frame sequence
 * (checkTick → beginFrame → tick → endFrame).
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createObsValue } from '../obs-value';
import { Updater, timingContextForFrame, makeOverridableGetNow } from '../updater';
import { TimeController } from '../time-controller';
import type { Environment } from '../../expr/env';

const W = 2 * Math.PI / 60;          // second hand, rad/s
const T0 = new Date('2026-10-28T10:00:00.000Z').getTime();

let wall = T0;
let perf = 100_000;

beforeEach(() => {
    wall = T0; perf = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    vi.spyOn(performance, 'now').mockImplementation(() => perf);
});
afterEach(() => { vi.restoreAllMocks(); });

function setup(fps = 60) {
    const STEP = 1000 / fps;
    const tc = new TimeController();
    tc.setTime(new Date(wall));
    tc.setOffset(0);                 // 1× forward, display == wall
    const { getNow, withDisplayTime } = makeOverridableGetNow(() => tc.getDisplayTime());
    const functions = new Map<string, (...a: number[]) => number>();
    functions.set('secAngle', () => ((getNow().getTime() / 1000) % 60) * W);
    const env = { functions, variables: new Map() } as unknown as Environment;
    const u = new Updater();
    const v = u.add(createObsValue(
        { name: 'second', expr: 'secAngle()', updateInterval: 1, continuous: true }, env, perf));
    const frame = () => {
        tc.checkTick(perf); tc.beginFrame();
        u.tick(env, perf, getNow, withDisplayTime, timingContextForFrame(tc));
        tc.endFrame();
    };
    /** Hand minus correct, in seconds, wrapped to (−30, 30]. */
    const errSec = () => {
        const d = v.currentValue / W - ((getNow().getTime() / 1000) % 60);
        return ((d + 30) % 60 + 60) % 60 - 30;
    };
    /** One frame, measured right after it draws (before the clocks advance). */
    const stepFrame = () => { frame(); const e = errSec(); wall += STEP; perf += STEP; return e; };
    const run = (ms: number) => { for (let t = 0; t < ms; t += STEP) stepFrame(); };
    /** Frames until |err| < 0.05 s, asserting monotonic approach from `sign` side; −1 if never. */
    const settle = (ms: number, sign: 1 | -1) => {
        let prev = sign * Infinity, settledAt = -1;
        for (let t = 0; t < ms; t += STEP) {
            const e = stepFrame();
            if (settledAt < 0) {
                if (sign > 0) expect(e).toBeLessThanOrEqual(prev + 1e-6);      // coming down from ahead
                else expect(e).toBeGreaterThanOrEqual(prev - 1e-6);            // coming up from behind
                if (Math.abs(e) < 0.05) settledAt = t;
            } else {
                expect(Math.abs(e)).toBeLessThan(1e-6);                        // and then exact
            }
            prev = e;
        }
        return settledAt;
    };
    return { tc, u, v, STEP, frame, run, stepFrame, errSec, settle };
}

describe('continuous tracking at 1×', () => {
    test('steady state is exact every frame at 60 fps', () => {
        const { stepFrame } = setup(60);
        for (let i = 0; i < 300; i++) expect(Math.abs(stepFrame())).toBeLessThan(1e-9);
    });

    test('steady state is exact every frame under the Low power cap (10 fps) — it steps, never lags', () => {
        const { stepFrame } = setup(10);
        for (let i = 0; i < 50; i++) expect(Math.abs(stepFrame())).toBeLessThan(1e-9);
    });

    test('a hidden-tab gap: behind by the gap on return, caught up forward at animSpeed, then exact', () => {
        const { u, run, errSec, settle } = setup();
        run(3000);
        wall += 1000; perf += 1000;               // hidden 1 s, no frames
        u.finish(); u.reset();                    // Observatory's resyncAfterGap
        expect(errSec()).toBeCloseTo(-1, 1);
        // 1 s of error closes at 2 rad/s − 2π/60 ≈ 0.06 s.
        const t = settle(2000, -1);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThan(150);
    });

    test('a system sleep (perf clock frozen): same catch-up', () => {
        const { u, run, errSec, settle } = setup();
        run(3000);
        wall += 5000;                              // 5 s asleep: wall advances, perf does not
        u.finish(); u.reset();
        expect(errSec()).toBeCloseTo(-5, 1);
        const t = settle(2000, -1);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThan(450);               // 5 s ÷ (2 − 0.105) rad/s ≈ 0.28 s
    });

    test('a long gap (40 s) takes the shortest path and lands exactly', () => {
        const { u, run, errSec, stepFrame } = setup();
        run(3000);
        wall += 40_000; perf += 40_000;
        u.finish(); u.reset();
        expect(Math.abs(errSec())).toBeCloseTo(20, 0);   // 40 s behind ≡ 20 s ahead
        let settledAt = -1;
        for (let t = 0; t < 3000; t += 1000 / 60) {
            const e = stepFrame();
            if (settledAt < 0 && Math.abs(e) < 0.05) settledAt = t;
            else if (settledAt >= 0) expect(Math.abs(e)).toBeLessThan(1e-6);
        }
        expect(settledAt).toBeGreaterThanOrEqual(0);
        expect(settledAt).toBeLessThan(1200);          // 20 s·2π/60 ≈ 2.1 rad at ~2.1 rad/s
    });

    test('a hand knocked AHEAD (a Now press) backs up at animSpeed', () => {
        const { v, run, errSec, settle } = setup();
        run(3000);
        v.anim.currentValue += 5 * W; v.anim.targetValue += 5 * W; v.currentValue += 5 * W;
        expect(errSec()).toBeCloseTo(5, 1);
        const t = settle(2000, 1);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThan(400);
    });

    test('startup: a value created before the first frame catches up, then tracks', () => {
        const { u, run, errSec, settle, STEP } = setup();
        void u;
        wall += 1500; perf += 1500;                // first frame 1.5 s after creation
        expect(errSec()).toBeCloseTo(-1.5, 1);
        const t = settle(1000, -1);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThan(200);
        run(STEP);
    });
});

describe('continuous tracking in the other modes', () => {
    test('reverse (−1×): tracks exactly with display time running backwards', () => {
        const { tc, v, run, stepFrame } = setup();
        run(1000);
        tc.setDirection(-1);
        // The flip lands between frames: the first reverse frame's display time
        // is the anchor (one frame past the last forward frame). Compare from it.
        expect(Math.abs(stepFrame())).toBeLessThan(1e-9);
        const before = v.currentValue;
        let last = before;
        for (let i = 0; i < 120; i++) {
            expect(Math.abs(stepFrame())).toBeLessThan(1e-9);
            // The hand goes backwards (mod the seam).
            let d = v.currentValue - last; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
            expect(d).toBeLessThanOrEqual(0);
            last = v.currentValue;
        }
        expect(v.currentValue).not.toBe(before);
    });

    test('stopped: settles on the frozen display time and holds', () => {
        const { tc, u, run, stepFrame, errSec } = setup();
        run(1000);
        tc.stop();
        run(500);
        expect(Math.abs(errSec())).toBeLessThan(1e-6);
        const held = stepFrame();
        expect(Math.abs(held)).toBeLessThan(1e-6);
        expect(u.anyAnimating()).toBe(false);
    });
});
