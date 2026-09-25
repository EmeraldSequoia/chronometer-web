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
import { tzOffsetSecondsAt, computeTzDeltaMs } from '../shared/astro-env';

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

/**
 * Eras and early years (planning/2026-09-24-seconds-scrub-cadence-and-bce-offset.md
 * §2): Intl reports a BCE year era-relative ("2026" for 2026 BC) and names the
 * era only when asked, and Date.UTC maps a year of 0–99 to 1900–1999. Read
 * either way, a rebuilt instant lands thousands of years off and the "offset"
 * is that difference — Chronometer's BCE toggle showed the instant with a
 * 4051-year offset. Before its first rule (1883) Los Angeles is LMT −7:52:58,
 * which Intl extrapolates for every earlier instant.
 */
describe('tzOffsetSecondsAt across eras and early years', () => {
    const LA = 'America/Los_Angeles';
    const LMT = -(7 * 3600 + 52 * 60 + 58);
    // A proleptic-Gregorian UTC instant without Date.UTC's 0–99 mapping.
    const utc = (y: number, m: number, d: number, h = 12): number => {
        const x = new Date(0);
        x.setUTCFullYear(y, m - 1, d);
        x.setUTCHours(h, 0, 0, 0);
        return x.getTime();
    };

    test.each([
        ['1000 CE', utc(1000, 6, 1)],
        ['1582 Oct 14 (Gregorian)', utc(1582, 10, 14)],
        ['50 CE', utc(50, 6, 1)],
        ['1 BCE (astronomical year 0)', utc(0, 6, 1)],
        ['2026 BCE (the toggle repro instant)', -126048445140000],
        ['the 4000 BCE limit', -188366169600000],
    ] as const)('%s is LMT', (_label, ms) => {
        expect(tzOffsetSecondsAt(LA, ms)).toBe(LMT);
    });

    test('modern DST is unchanged', () => {
        expect(tzOffsetSecondsAt(LA, Date.UTC(2026, 6, 15, 12))).toBe(-7 * 3600);
        expect(tzOffsetSecondsAt(LA, Date.UTC(2026, 0, 15, 12))).toBe(-8 * 3600);
    });

    test('the delta at a BCE display time is a zone difference, not millennia', () => {
        // Chronometer recomputes its display delta at the display time; it must
        // stay within a day whatever the machine's own zone is.
        expect(Math.abs(computeTzDeltaMs(LA, new Date(-126048445140000)))).toBeLessThan(86_400_000);
        expect(Math.abs(computeTzDeltaMs(LA, new Date(utc(50, 6, 1))))).toBeLessThan(86_400_000);
    });
});
