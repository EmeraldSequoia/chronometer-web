/**
 * Scrub cadence: under hold-to-scrub every value re-evaluates every tick
 * (planning/2026-09-24-seconds-scrub-cadence-and-bce-offset.md §1).
 *
 * The pre-fix legacy scrub branch scheduled a value's next evaluation at its
 * own display-time boundary. At day rates a tick crosses every boundary, so
 * nothing showed; at the seconds rate a second hand declared with the
 * Observatory's 20 s re-sync interval was re-evaluated every twenty ticks and
 * then swept to the new target — a 20-second jump every two real seconds.
 * These tests drive the real Updater through the loops' per-frame sequence
 * (checkTick → beginFrame → tick) with a second hand and a slow value, and pin:
 * the second hand tracks each one-second tick (forward and reverse); a slow
 * snap value updates every tick under scrub too; and at 1× the slow value
 * keeps its boundary economy.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { createObsValue } from '../obs-value';
import { Updater, timingContextForFrame, makeOverridableGetNow } from '../updater';
import { TimeController, RATE_OPTIONS } from '../time-controller';
import type { Environment } from '../../expr/env';

const TWO_PI = 2 * Math.PI;
const FRAME_MS = 1000 / 60;

afterEach(() => { vi.restoreAllMocks(); });

function harness() {
    let nowMs = Date.UTC(2026, 8, 24, 22, 0, 7, 300);
    let perf = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    vi.spyOn(performance, 'now').mockImplementation(() => perf);

    const tc = new TimeController();
    const { getNow, withDisplayTime } = makeOverridableGetNow(() => tc.getDisplayTime());
    const secOf = (d: Date) => (((d.getTime() / 1000) % 60) + 60) % 60;
    const functions = new Map<string, (...a: number[]) => number>();
    functions.set('secondValueAngle', () => secOf(getNow()) * TWO_PI / 60);
    functions.set('hoursValue', () => getNow().getTime() / 3_600_000);
    const env = { functions, variables: new Map(), tzOffsetSec: 0 } as unknown as Environment;

    // The Observatory's second hand: a 20 s re-sync interval with a natural sweep.
    const second = createObsValue(
        { name: 'second', expr: 'secondValueAngle()', updateInterval: 20, naturalSpeed: TWO_PI / 60 }, env, perf);
    // A slow snap-to-target value on an hourly boundary (a planet hand's cadence).
    const slow = createObsValue(
        { name: 'slow', expr: 'hoursValue()', updateInterval: 3600, linear: true, animSpeed: 1e9 }, env, perf);
    const u = new Updater();
    u.add(second); u.add(slow);

    const frame = () => {
        perf += FRAME_MS; nowMs += FRAME_MS;
        tc.checkTick(perf);
        tc.beginFrame();
        u.tick(env, perf, getNow, withDisplayTime, timingContextForFrame(tc));
        tc.endFrame();
    };
    const handSec = () => ((((second.currentValue % TWO_PI) + TWO_PI) % TWO_PI) / TWO_PI) * 60;
    const displaySec = () => secOf(tc.getDisplayTime());
    /** Signed seconds the hand trails the display by, on the 60 s circle. */
    const lag = () => {
        const d = displaySec() - handSec();
        return ((d + 30 + 60) % 60) - 30;
    };
    return { tc, u, env, second, slow, frame, handSec, displaySec, lag, perfNow: () => perf };
}

describe('every value re-evaluates every tick under scrub', () => {
    test('the 20 s second hand tracks a 1 s/tick scrub forward within one tick', () => {
        const h = harness();
        h.tc.setOffset(0);
        for (let i = 0; i < 60; i++) h.frame();            // 1 s at 1×, sweep in flight
        h.tc.stop(); h.tc.setDirection(1); h.tc.setRate(RATE_OPTIONS[0]); h.u.reset();
        let worst = 0;
        for (let i = 0; i < 240; i++) {                    // 4 s of scrub = 40 ticks
            h.frame();
            worst = Math.max(worst, Math.abs(h.lag()));
        }
        // Pre-fix the hand sat up to ~19 s behind between its 20 s boundaries.
        expect(worst).toBeLessThan(1.5);
        expect(Math.abs(h.lag())).toBeLessThan(1.5);
    });

    test('and in reverse', () => {
        const h = harness();
        h.tc.setOffset(0);
        h.frame();
        h.tc.stop(); h.tc.setDirection(-1); h.tc.setRate(RATE_OPTIONS[0]); h.u.reset();
        let worst = 0;
        for (let i = 0; i < 240; i++) { h.frame(); worst = Math.max(worst, Math.abs(h.lag())); }
        expect(worst).toBeLessThan(1.5);
    });

    test('a slow snap value updates every tick under scrub, and keeps its boundary at 1×', () => {
        const h = harness();
        h.tc.setOffset(0);
        h.frame();
        h.tc.stop(); h.tc.setDirection(1); h.tc.setRate(RATE_OPTIONS[0]); h.u.reset();
        h.frame();
        let updates = 0;
        let last = h.slow.currentValue;
        for (let i = 0; i < 120; i++) {                    // 2 s = 20 ticks
            h.frame();
            if (h.slow.currentValue !== last) { updates++; last = h.slow.currentValue; }
        }
        expect(updates).toBeGreaterThanOrEqual(19);        // once per tick (a 1 s change in an hourly value)
        // Back to 1×: the next evaluation waits for the hourly boundary, not the next frame.
        h.tc.stop(); h.tc.setDirection(1); h.tc.setRate(null); h.u.reset();
        h.frame();
        expect(h.slow.nextUpdateTime - h.perfNow()).toBeGreaterThan(60_000);
    });
});
