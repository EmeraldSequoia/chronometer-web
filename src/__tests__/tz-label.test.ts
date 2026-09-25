/**
 * Zone labels (src/shared/tz-label.ts): before a zone's first rule Intl has no
 * abbreviation and reports the extrapolated local-mean-time offset itself,
 * with seconds ("GMT-10:31:26"). That reads "LMT" in the Observatory header's
 * small zone slot and in the "(LMT) UTC-10:31:26" zone lines; every real
 * abbreviation — and the seconds-free offset forms ICU uses where en-US has no
 * name — passes through unchanged.
 * (planning/2026-09-24-julian-indicator-and-lmt-label.md)
 */
import { describe, test, expect } from 'vitest';
import {
    tzAbbreviationAt, utcOffsetLabelAt, formatZoneLine, isOffsetAbbreviation,
} from '../shared/tz-label';
import { hybridDateFields } from '../shared/hybrid-date';

const utc = (y: number, m: number, d: number): Date => {
    const t = new Date(Date.UTC(2000, m - 1, d, 12));
    t.setUTCFullYear(y);   // years 0–99 and BCE need the explicit setter
    return t;
};

describe('tzAbbreviationAt', () => {
    test.each([
        ['Pacific/Honolulu', utc(2026, 6, 18), 'HST'],
        ['Pacific/Honolulu', utc(1900, 1, 1), 'GMT-10:30'],   // real standard time, no seconds
        ['Pacific/Honolulu', utc(1800, 1, 1), 'LMT'],         // GMT-10:31:26
        ['Pacific/Honolulu', utc(-43, 3, 15), 'LMT'],         // 44 BCE
        ['America/Los_Angeles', utc(2026, 6, 18), 'PDT'],
        ['America/Los_Angeles', utc(1800, 1, 1), 'LMT'],      // GMT-7:52:58
        ['Europe/Vienna', utc(2026, 6, 18), 'GMT+2'],         // ICU's en-US name; passes through
        ['Europe/Vienna', utc(1500, 6, 1), 'LMT'],            // GMT+1:05:21
        ['Asia/Kolkata', utc(1900, 1, 1), 'LMT'],             // GMT+5:21:10
        ['Asia/Kolkata', utc(2026, 1, 1), 'GMT+5:30'],
        ['Etc/GMT+10', utc(2026, 1, 1), 'GMT-10'],
    ])('%s at %s → %s', (tz, date, expected) => {
        expect(tzAbbreviationAt(tz, date)).toBe(expected);
    });

    test('an invalid zone yields the empty string, not a throw', () => {
        expect(tzAbbreviationAt('Not/AZone', utc(2026, 1, 1))).toBe('');
    });
});

describe('utcOffsetLabelAt', () => {
    test.each([
        ['America/Los_Angeles', utc(2026, 6, 18), 'UTC-7:00'],
        ['Asia/Kolkata', utc(2026, 1, 1), 'UTC+5:30'],
        ['Pacific/Honolulu', utc(1800, 1, 1), 'UTC-10:31:26'],   // the exact offset survives
    ])('%s at %s → %s', (tz, date, expected) => {
        expect(utcOffsetLabelAt(tz, date)).toBe(expected);
    });
    test('the UTC zone reads UTC (ICU versions differ on a "+0:00" suffix)', () => {
        expect(utcOffsetLabelAt('UTC', utc(2026, 1, 1))).toMatch(/^UTC(\+0:00)?$/);
    });
});

describe('formatZoneLine', () => {
    test('with the zone name (time controller, Chronometer footer)', () => {
        expect(formatZoneLine('America/Los_Angeles', utc(2026, 6, 18), true))
            .toBe('America/Los_Angeles (PDT) UTC-7:00');
        expect(formatZoneLine('Pacific/Honolulu', utc(1800, 1, 1), true))
            .toBe('Pacific/Honolulu (LMT) UTC-10:31:26');
    });
    test('without the zone name (Inspector)', () => {
        expect(formatZoneLine('Pacific/Honolulu', utc(1800, 1, 1), false))
            .toBe('(LMT) UTC-10:31:26');
    });
    test('no zone → empty; invalid zone → the bare id with the name, empty without', () => {
        expect(formatZoneLine(undefined, utc(2026, 1, 1), true)).toBe('');
        expect(formatZoneLine('Not/AZone', utc(2026, 1, 1), true)).toBe('Not/AZone');
        expect(formatZoneLine('Not/AZone', utc(2026, 1, 1), false)).toBe('');
    });
});

describe('isOffsetAbbreviation', () => {
    test.each([
        ['GMT+2', true], ['GMT-10:30', true], ['UTC', true], ['GMT', true],
        ['HST', false], ['PDT', false], ['LMT', false], ['', false],
    ])('%s → %s', (abbr, expected) => {
        expect(isOffsetAbbreviation(abbr)).toBe(expected);
    });
});

describe('hybridDateFields.julian', () => {
    const tz = 'Europe/Rome';
    test('the day before the switchover is Julian; the switchover day is not', () => {
        // Julian 4 Oct 1582 is followed by Gregorian 15 Oct 1582.
        expect(hybridDateFields(utc(1582, 10, 4), tz).julian).toBe(true);
        expect(hybridDateFields(utc(1582, 10, 15), tz).julian).toBe(false);
    });
    test('BCE dates are Julian too (proleptic), with the era in the year label', () => {
        const f = hybridDateFields(utc(-43, 3, 15), tz);
        expect(f.julian).toBe(true);
        expect(f.era).toBe(0);
        expect(f.yearLabel).toBe('44 BCE');
    });
    test('a modern date is not Julian', () => {
        expect(hybridDateFields(utc(2026, 9, 24), tz).julian).toBe(false);
    });
});
