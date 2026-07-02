/**
 * Direction-change scrub must not snap time to the leftover rate's unit.
 *
 * stop() intentionally leaves this.rate in place (endHold relies on it), and
 * hold-to-scrub (time-controls-ui.ts startHold) calls setDirection() before
 * setRate(). setDirection() used to re-snap tickTime to the unit boundary of
 * whatever rate was left over from the previous scrub, so starting a scrub in
 * the opposite direction zeroed visible hands: a leftover minute rate zeroed
 * seconds, a leftover day rate snapped the whole time-of-day to midnight.
 * Intermittent by nature — same-direction scrubs skip setDirection's work, and
 * the first scrub after load has rate === null.
 *
 * setDirection() now follows the same policy as setRate(): snap only for the
 * 'second' unit (zeroing invisible milliseconds), preserve sub-unit fields for
 * everything else.
 */
import { describe, test, expect } from 'vitest';

import { TimeController, RATE_OPTIONS } from '../shared/time-controller.js';

const MINUTE_RATE = RATE_OPTIONS[1]; // 10 min/s
const DAY_RATE = RATE_OPTIONS[3];    // 10 day/s

/** Mirrors time-controls-ui.ts startHold(): direction first, then rate. */
function startHoldScrub(tc: TimeController, rate: (typeof RATE_OPTIONS)[number], dir: 1 | -1) {
    tc.setDirection(dir);
    tc.setRate(rate);
}

const START = new Date(2026, 5, 15, 10, 23, 47);

describe('hold-to-scrub direction change preserves sub-unit time', () => {
    test('first day scrub from stopped preserves seconds', () => {
        const tc = new TimeController();
        tc.setTime(START);
        startHoldScrub(tc, DAY_RATE, 1);
        expect(tc.getDisplayTime().getSeconds()).toBe(47);
    });

    test('day scrub after same-direction minute scrub preserves seconds', () => {
        const tc = new TimeController();
        tc.setTime(START);
        startHoldScrub(tc, MINUTE_RATE, 1);
        tc.stop(); // endHold
        startHoldScrub(tc, DAY_RATE, 1);
        expect(tc.getDisplayTime().getSeconds()).toBe(47);
    });

    test('day scrub after opposite-direction minute scrub preserves seconds', () => {
        const tc = new TimeController();
        tc.setTime(START);
        startHoldScrub(tc, MINUTE_RATE, 1);
        tc.stop(); // endHold
        startHoldScrub(tc, DAY_RATE, -1);
        expect(tc.getDisplayTime().getSeconds()).toBe(47);
    });

    test('reverse day scrub after forward day scrub preserves time-of-day', () => {
        const tc = new TimeController();
        tc.setTime(START);
        startHoldScrub(tc, DAY_RATE, 1);
        tc.stop(); // endHold
        startHoldScrub(tc, DAY_RATE, -1);
        const t = tc.getDisplayTime();
        expect(t.getHours()).toBe(10);
        expect(t.getMinutes()).toBe(23);
        expect(t.getSeconds()).toBe(47);
    });

    test('transport reverse-1× after day scrub preserves time-of-day', () => {
        // Mirrors the 1×◀ transport button: setDirection(-1) then setRate(null)
        const tc = new TimeController();
        tc.setTime(START);
        startHoldScrub(tc, DAY_RATE, 1);
        tc.stop(); // endHold
        tc.setDirection(-1);
        tc.setRate(null);
        const t = tc.getDisplayTime();
        expect(t.getHours()).toBe(10);
        expect(t.getMinutes()).toBe(23);
        // -1× runs immediately, so allow a moment of backward drift
        expect(Math.abs(t.getSeconds() - 47)).toBeLessThanOrEqual(1);
    });
});
