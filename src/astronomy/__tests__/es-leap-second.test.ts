/**
 * Tests for es-leap-second.ts — the generated TAI−UTC table.
 *
 * These guard the *data*, not the astronomy: a table regenerated from a
 * changed leap-seconds.list must still start at 10 s in 1972, step by one
 * second at a time, and land on a UTC month boundary every time. The ΔT
 * consequences are tested in es-astro.test.ts, where convertUTtoET lives.
 */
import { describe, test, expect } from 'vitest';
import {
    kECLeapEraStart,
    kECLeapTableEntryCount,
    kECLeapTableFinalTAIMinusUTC,
    kECLeapTableValidUntil,
    kECLeapTableValidUntilISO,
    kECTTMinusTAI,
    leapSecondTableEntries,
    taiMinusUTCForDateInterval,
    ttMinusUTCForDateInterval,
} from '../es-leap-second';

/** Apple epoch seconds for a UTC instant. */
const appleEpoch = (iso: string) => new Date(iso).getTime() / 1000 - 978307200;

const entries = leapSecondTableEntries();

describe('leap-second table integrity', () => {
    test('starts at 1972-01-01 with TAI−UTC = 10 s', () => {
        expect(entries[0].dateInterval).toBe(appleEpoch('1972-01-01T00:00:00Z'));
        expect(entries[0].dateInterval).toBe(kECLeapEraStart);
        expect(entries[0].taiMinusUTC).toBe(10);
    });

    test('ends at 2017-01-01 with TAI−UTC = 37 s', () => {
        const last = entries[entries.length - 1];
        expect(last.dateInterval).toBe(appleEpoch('2017-01-01T00:00:00Z'));
        expect(last.taiMinusUTC).toBe(37);
        expect(last.taiMinusUTC).toBe(kECLeapTableFinalTAIMinusUTC);
    });

    test('entry count matches the exported constant', () => {
        expect(entries.length).toBe(kECLeapTableEntryCount);
    });

    test('the 27 transitions sum to 37 − 10', () => {
        const transitions = entries.length - 1;
        expect(transitions).toBe(27);
        let sum = 0;
        for (let i = 1; i < entries.length; i++) {
            sum += entries[i].taiMinusUTC - entries[i - 1].taiMinusUTC;
        }
        expect(sum).toBe(37 - 10);
    });

    test('transitions are strictly ordered and step by exactly one second', () => {
        for (let i = 1; i < entries.length; i++) {
            expect(entries[i].dateInterval).toBeGreaterThan(entries[i - 1].dateInterval);
            expect(entries[i].taiMinusUTC - entries[i - 1].taiMinusUTC).toBe(1);
        }
    });

    test('every transition falls on a January 1 or July 1 UTC midnight', () => {
        // International agreement puts leap seconds at end of June/December;
        // an entry anywhere else means the epoch conversion is off.
        for (const entry of entries) {
            const d = new Date((entry.dateInterval + 978307200) * 1000);
            expect(d.toISOString()).toMatch(/T00:00:00\.000Z$/);
            expect(d.getUTCDate()).toBe(1);
            expect([0, 6]).toContain(d.getUTCMonth());
        }
    });

    test('expiry constant and its ISO form agree, and lie ahead of the last entry', () => {
        expect(kECLeapTableValidUntilISO).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(appleEpoch(`${kECLeapTableValidUntilISO}T00:00:00Z`)).toBe(kECLeapTableValidUntil);
        expect(kECLeapTableValidUntil).toBeGreaterThan(entries[entries.length - 1].dateInterval);
    });

    test('TT − TAI is the defined 32.184 s', () => {
        expect(kECTTMinusTAI).toBe(32.184);
    });
});

describe('taiMinusUTCForDateInterval', () => {
    test('steps exactly at each transition instant, not a second early or late', () => {
        for (let i = 1; i < entries.length; i++) {
            const t = entries[i].dateInterval;
            expect(taiMinusUTCForDateInterval(t - 1)).toBe(entries[i - 1].taiMinusUTC);
            expect(taiMinusUTCForDateInterval(t)).toBe(entries[i].taiMinusUTC);
        }
    });

    test('clamps to the first entry before 1972', () => {
        expect(taiMinusUTCForDateInterval(kECLeapEraStart - 1)).toBe(10);
        expect(taiMinusUTCForDateInterval(appleEpoch('1900-01-01T00:00:00Z'))).toBe(10);
    });

    test('holds the final value indefinitely after the last transition', () => {
        expect(taiMinusUTCForDateInterval(appleEpoch('2026-08-18T00:00:00Z'))).toBe(37);
        expect(taiMinusUTCForDateInterval(appleEpoch('2400-01-01T00:00:00Z'))).toBe(37);
    });

    test('the last-entry cache never changes an answer', () => {
        // Walk the table forwards, backwards, and in a jumbled order; the
        // cached-index fast path must agree with a plain linear scan every
        // time. This is the one place the accessor could go subtly wrong.
        const probes: number[] = [];
        for (const entry of entries) {
            probes.push(entry.dateInterval - 1, entry.dateInterval, entry.dateInterval + 1);
        }
        probes.push(appleEpoch('1950-01-01T00:00:00Z'), appleEpoch('2100-01-01T00:00:00Z'));

        const linear = (t: number) => {
            let value = entries[0].taiMinusUTC;
            for (const entry of entries) if (t >= entry.dateInterval) value = entry.taiMinusUTC;
            return value;
        };

        const orders = [
            probes,
            [...probes].reverse(),
            [...probes].sort((a, b) => (a * 7919) % 1000 - (b * 7919) % 1000),
        ];
        for (const order of orders) {
            for (const t of order) {
                expect(taiMinusUTCForDateInterval(t)).toBe(linear(t));
            }
        }
    });
});

describe('ttMinusUTCForDateInterval', () => {
    // TT − UTC = 32.184 + (TAI − UTC): exact by definition inside the table.
    const cases: [string, number][] = [
        ['1972-01-02T00:00:00Z', 42.184],   // first day of the leap era
        ['1976-06-15T00:00:00Z', 47.184],   // mid-table: TAI−UTC = 15
        ['1995-06-15T00:00:00Z', 61.184],   // mid-table: TAI−UTC = 29
        ['2017-01-01T00:00:00Z', 69.184],   // the last transition itself
        ['2026-08-18T12:00:00Z', 69.184],   // today
    ];
    for (const [iso, expected] of cases) {
        test(`${iso} → ${expected} s`, () => {
            expect(ttMinusUTCForDateInterval(appleEpoch(iso))).toBeCloseTo(expected, 10);
        });
    }
});
