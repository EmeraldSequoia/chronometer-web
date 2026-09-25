/**
 * The hybrid calendar's decomposition is exact to the millisecond
 * (planning/2026-09-24-seconds-scrub-cadence-and-bce-offset.md §5): the port
 * took the time of day from the fraction of a large day quotient, whose float
 * noise (a few 10⁻⁵ s at BCE dates) turned an exact 16:55:00 into
 * 16:54:59.99999 and the wrong minute. And the displays' calendar fields
 * (`hybridDateFields`) come from this calendar, not from Intl / Date, which
 * are proleptic Gregorian.
 */
import { describe, test, expect } from 'vitest';
import {
    utcComponentsFromTimeInterval, timeIntervalFromUTCComponents,
    localComponentsFromTimeInterval, timeIntervalFromLocalComponents,
    kECJulianGregorianSwitchoverTimeInterval,
} from '../astronomy/es-calendar';
import { dateIntervalToDate } from '../astronomy/es-time';
import { hybridDateFields } from '../shared/hybrid-date';

describe('utcComponentsFromTimeInterval is exact to the millisecond', () => {
    test.each([
        [1, 2026, 9, 24, 15, 55],
        [1, 1582, 9, 1, 12, 0],
        [1, 1582, 10, 15, 0, 0],
        [1, 50, 6, 3, 23, 59],
        [0, 1, 6, 3, 0, 0],
        [0, 2026, 9, 7, 15, 2],
        [0, 4000, 1, 1, 0, 0],
    ])('era %i, %i-%i-%i %i:%i round-trips with seconds exactly 0', (era, y, m, d, h, mi) => {
        const t = timeIntervalFromUTCComponents(era, y, m, d, h, mi, 0);
        const cs = utcComponentsFromTimeInterval(t);
        expect([cs.era, cs.year, cs.month, cs.day, cs.hour, cs.minute, cs.seconds]).toEqual([era, y, m, d, h, mi, 0]);
    });

    test('the LMT instant that read 15:01:59.99999', () => {
        const LMT = -28378;
        const t = timeIntervalFromLocalComponents(LMT, 0, 2026, 9, 7, 15, 2, 0);
        const cs = localComponentsFromTimeInterval(t, LMT);
        expect([cs.hour, cs.minute, cs.seconds]).toEqual([15, 2, 0]);
    });

    test('fractional seconds survive to the millisecond', () => {
        const t = timeIntervalFromUTCComponents(1, 2026, 9, 24, 12, 30, 15.25);
        expect(utcComponentsFromTimeInterval(t).seconds).toBe(15.25);
        const b = timeIntervalFromUTCComponents(0, 2026, 9, 24, 12, 30, 15.25);
        expect(utcComponentsFromTimeInterval(b).seconds).toBeCloseTo(15.25, 3);
    });

    test('a hair before a midnight rounds onto it; a millisecond before stays the day before', () => {
        const midnight = timeIntervalFromUTCComponents(0, 2026, 9, 8, 0, 0, 0);
        const at = utcComponentsFromTimeInterval(midnight - 1e-6);
        expect([at.day, at.hour, at.minute, at.seconds]).toEqual([8, 0, 0, 0]);
        const before = utcComponentsFromTimeInterval(midnight - 0.001);
        expect([before.day, before.hour, before.minute, before.seconds]).toEqual([7, 23, 59, 59.999]);
    });

    test('the switchover: a hair before it is 15 Oct 1582 Gregorian; a millisecond before is 4 Oct 1582 Julian', () => {
        const s = kECJulianGregorianSwitchoverTimeInterval;
        const at = utcComponentsFromTimeInterval(s - 1e-6);
        expect([at.year, at.month, at.day, at.hour, at.minute, at.seconds]).toEqual([1582, 10, 15, 0, 0, 0]);
        const before = utcComponentsFromTimeInterval(s - 0.001);
        expect([before.year, before.month, before.day, before.hour, before.minute, before.seconds])
            .toEqual([1582, 10, 4, 23, 59, 59.999]);
    });
});

describe('hybridDateFields — the displays\' calendar', () => {
    const at = (era: number, y: number, m: number, d: number, h = 12) =>
        dateIntervalToDate(timeIntervalFromUTCComponents(era, y, m, d, h, 0, 0));

    test('4 Oct 1582 is a Thursday and 15 Oct 1582 a Friday', () => {
        expect(hybridDateFields(at(1, 1582, 10, 4), 'UTC')).toMatchObject(
            { year: 1582, month: 10, day: 4, weekdayName: 'Thursday', monthShort: 'Oct', yearLabel: '1582', leap: false });
        expect(hybridDateFields(at(1, 1582, 10, 15), 'UTC')).toMatchObject({ day: 15, weekdayName: 'Friday' });
    });

    test('a Julian 1 Sep 1582 reads as 1 Sep, not the proleptic-Gregorian 11 Sep that Date reports', () => {
        const d = at(1, 1582, 9, 1);
        expect(d.getUTCDate()).toBe(11);
        expect(hybridDateFields(d, 'UTC')).toMatchObject({ month: 9, day: 1, monthShort: 'Sep', monthName: 'September' });
    });

    test('BCE years carry the era; leap years follow the Julian rule before the switchover', () => {
        expect(hybridDateFields(at(0, 2026, 9, 24), 'UTC').yearLabel).toBe('2026 BCE');
        expect(hybridDateFields(at(1, 1500, 6, 1), 'UTC').leap).toBe(true);    // Julian: yes; Gregorian: no
        expect(hybridDateFields(at(1, 1900, 6, 1), 'UTC').leap).toBe(false);   // Gregorian century rule
        expect(hybridDateFields(at(1, 2024, 6, 1), 'UTC').leap).toBe(true);
    });

    test('in a zone, the fields are the zone\'s local date (LMT before its first rule)', () => {
        // The BCE toggle's repro instant: 2026 BCE Sep 24 15:55 in Los Angeles LMT.
        expect(hybridDateFields(new Date(-126048442322000), 'America/Los_Angeles')).toMatchObject(
            { era: 0, year: 2026, month: 9, day: 24, hour: 15, minute: 55, seconds: 0, tzOffsetSec: -28378 });
    });
});
