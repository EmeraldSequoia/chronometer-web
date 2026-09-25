/**
 * The header's date strings (date-view.ts `extractDateFields`): the calendar
 * qualifier and the zone abbreviation, no canvas needed.
 */
import { describe, test, expect } from 'vitest';
import { extractDateFields } from '../date-view';

const utc = (y: number, m: number, d: number): Date => {
    const t = new Date(Date.UTC(2000, m - 1, d, 20));
    t.setUTCFullYear(y);
    return t;
};
const HNL = 'Pacific/Honolulu';

describe('extractDateFields', () => {
    test('a Julian CE date: "Julian" qualifier, Julian day of month, LMT zone', () => {
        // 1 Jun 1500 (proleptic Gregorian) is 22 May 1500 in the Julian calendar.
        const f = extractDateFields(utc(1500, 6, 1), HNL);
        expect(f).toEqual({
            weekday: 'Friday', monthDay: 'May 22', year: '1500',
            leap: true, julian: true, tzAbbrev: 'LMT',
        });
    });
    test('a BCE date carries the qualifier too, with the era in the year', () => {
        const f = extractDateFields(utc(-43, 3, 15), HNL);
        expect(f.year).toBe('44 BCE');
        expect(f.julian).toBe(true);
        expect(f.tzAbbrev).toBe('LMT');
    });
    test('the switchover: 4 Oct 1582 is Julian, 15 Oct 1582 is not', () => {
        expect(extractDateFields(utc(1582, 10, 4), HNL).julian).toBe(true);
        const g = extractDateFields(utc(1582, 10, 15), HNL);
        expect(g.julian).toBe(false);
        expect(g.monthDay).toBe('Oct 15');
    });
    test('today: no qualifier, the real abbreviation', () => {
        const f = extractDateFields(utc(2026, 6, 18), HNL);
        expect(f.julian).toBe(false);
        expect(f.tzAbbrev).toBe('HST');
        expect(f.year).toBe('2026');
    });
});
