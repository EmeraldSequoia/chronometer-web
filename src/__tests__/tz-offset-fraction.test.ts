/**
 * tzOffsetSecondsAt must be immune to the sub-second fraction of the queried
 * instant. Intl.DateTimeFormat truncates to whole seconds, so comparing the
 * formatted local second against the *untruncated* utcMs made the offset come
 * out 1s low whenever the fraction exceeded ~500ms. The per-tz offset-window
 * memo then served that poisoned value for ±10 days of queries — during a map
 * drag, zones first queried at an unlucky fraction disagreed with clean zones
 * by one second, and the civil second hand hopped back and forth at timezone
 * crossings.
 *
 * Each case below uses a DST-free zone not queried elsewhere in this file, so
 * the FIRST query (whose fraction poisons the memo on buggy code) is the one
 * under test.
 */
import { describe, test, expect } from 'vitest';
import { tzOffsetSecondsAt } from '../shared/astro-env';

const T = Date.UTC(2026, 6, 15, 18, 20, 33);  // a plain summer instant

describe('tzOffsetSecondsAt sub-second immunity', () => {
    test.each([
        ['Asia/Tokyo', 9 * 3600, 0],
        ['Pacific/Honolulu', -10 * 3600, 499],
        ['America/Phoenix', -7 * 3600, 500],
        ['Asia/Kathmandu', (5 * 60 + 45) * 60, 999],
        ['Australia/Brisbane', 10 * 3600, 731],
    ] as const)('%s at +%ims fraction', (tz, offsetSec, fracMs) => {
        // First-ever query for this tz lands at the fraction under test.
        expect(tzOffsetSecondsAt(tz, T + fracMs)).toBe(offsetSec);
        // And stays consistent for other fractions afterward (memo window).
        expect(tzOffsetSecondsAt(tz, T)).toBe(offsetSec);
        expect(tzOffsetSecondsAt(tz, T + 999)).toBe(offsetSec);
    });

    test('two zones first queried at different fractions agree on the shared offset', () => {
        // Same UTC offset in summer (+2): a clean-fraction zone and an
        // unlucky-fraction zone must not disagree — this is the drag-time
        // "second hand hops at tz crossings" shape.
        const clean = tzOffsetSecondsAt('Europe/Paris', T + 100);
        const dirty = tzOffsetSecondsAt('Europe/Berlin', T + 900);
        expect(clean).toBe(2 * 3600);
        expect(dirty).toBe(clean);
    });
});
