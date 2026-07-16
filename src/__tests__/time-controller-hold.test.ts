import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimeController } from '../shared/time-controller.js';

// The display hold (map drag-to-explore) is a read-side freeze: getDisplayTime()
// returns the held instant while the underlying transport keeps flowing, and
// releaseHold() reveals live time again — no offset accumulation, no transport
// state change.

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));
});
afterEach(() => {
    vi.useRealTimers();
});

describe('TimeController display hold', () => {
    test('freezes getDisplayTime while real time flows, release reveals live time', () => {
        const tc = new TimeController();
        const t0 = tc.getDisplayTime().getTime();

        tc.holdDisplayTime();
        expect(tc.isHeld).toBe(true);
        vi.advanceTimersByTime(10_000);
        expect(tc.getDisplayTime().getTime()).toBe(t0);

        tc.releaseHold();
        expect(tc.isHeld).toBe(false);
        // Real time flowed underneath: display snaps to live, no offset sticks.
        expect(tc.getDisplayTime().getTime()).toBe(t0 + 10_000);
        expect(tc.isRealTime).toBe(true);
    });

    test('does not touch transport state', () => {
        const tc = new TimeController();
        tc.holdDisplayTime();
        expect(tc.isStopped).toBe(false);
        expect(tc.isRealTime).toBe(true);
        expect(tc.currentRate).toBeNull();
        tc.releaseHold();
    });

    test('re-holding while held keeps the original instant (resumed drag)', () => {
        const tc = new TimeController();
        const t0 = tc.getDisplayTime().getTime();
        tc.holdDisplayTime();
        vi.advanceTimersByTime(5_000);
        tc.holdDisplayTime();  // resume press — must not re-capture
        expect(tc.getDisplayTime().getTime()).toBe(t0);
        tc.releaseHold();
    });

    test('holding a stopped clock is a no-op view-wise and release reveals it unchanged', () => {
        const tc = new TimeController();
        tc.stop();
        const frozen = tc.getDisplayTime().getTime();

        tc.holdDisplayTime();
        vi.advanceTimersByTime(7_000);
        expect(tc.getDisplayTime().getTime()).toBe(frozen);

        tc.releaseHold();
        expect(tc.getDisplayTime().getTime()).toBe(frozen);
        expect(tc.isStopped).toBe(true);
    });

    test('beginFrame during a hold snapshots the held time', () => {
        const tc = new TimeController();
        const t0 = tc.getDisplayTime().getTime();
        tc.holdDisplayTime();
        vi.advanceTimersByTime(3_000);

        tc.beginFrame();
        expect(tc.getDisplayTime().getTime()).toBe(t0);
        tc.endFrame();
        tc.releaseHold();
    });

    test('releaseHold without a hold is a no-op', () => {
        const tc = new TimeController();
        expect(() => tc.releaseHold()).not.toThrow();
        expect(tc.isHeld).toBe(false);
    });
});
