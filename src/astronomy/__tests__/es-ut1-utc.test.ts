/**
 * Tests for es-ut1-utc.ts — the generated UT1−UTC series and its model.
 *
 * These guard the *data and the accessor*, not the astronomy: a table
 * regenerated from a newer finals.all must still be a smooth monthly series
 * from 1973, stay inside ±0.9 s for the whole leap-second era, show every
 * leap second as an exact +1 s step, and hand over to the far-future model
 * without a kink. Nothing consumes the accessor yet (commit 2 of
 * planning/2026-10-28-continuous-utc-ut1.md wires it into sidereal time).
 */
import { describe, test, expect } from 'vitest';
import {
    kECUT1AtFirstSample,
    kECUT1AtLastSample,
    kECUT1SecularCurvature,
    kECUT1SlopePerYear,
    kECUT1TableEntryCount,
    kECUT1TableFirstSample,
    kECUT1TableLastSample,
    kECUT1TableLastSampleISO,
    kECUT1TableStaleAfterISO,
    ut1MinusUTCForDateInterval,
    ut1TableEntries,
} from '../es-ut1-utc';
import { leapSecondTableEntries } from '../es-leap-second';

/** Apple epoch seconds for a UTC instant. */
const appleEpoch = (iso: string) => new Date(iso).getTime() / 1000 - 978307200;
const isoDay = (t: number) => new Date((t + 978307200) * 1000).toISOString().slice(0, 10);

/** Continuous UTC: no leap second after this (CGPM Resolution 5, 2026). */
const kContinuousUTCStart = appleEpoch('2027-05-20T00:00:00Z');
const kSecondsPerYear = 31557600;

const entries = ut1TableEntries();

describe('UT1−UTC table integrity', () => {
    test('starts in January 1973 (the first row of finals.all) and runs past today', () => {
        expect(entries[0].dateInterval).toBe(kECUT1TableFirstSample);
        expect(isoDay(entries[0].dateInterval)).toBe('1973-01-02');
        expect(entries.length).toBe(kECUT1TableEntryCount);
        expect(entries.length).toBeGreaterThan(600);
        const last = entries[entries.length - 1];
        expect(last.dateInterval).toBe(kECUT1TableLastSample);
        expect(isoDay(last.dateInterval)).toBe(kECUT1TableLastSampleISO);
        expect(kECUT1TableLastSampleISO > '2026-10-01').toBe(true);
        expect(kECUT1TableStaleAfterISO > kECUT1TableLastSampleISO).toBe(true);
    });

    test('instants are strictly increasing and land on the 1st of each month', () => {
        for (let i = 1; i < entries.length; i++) {
            expect(entries[i].dateInterval).toBeGreaterThan(entries[i - 1].dateInterval);
            if (i < entries.length - 1) {
                expect(new Date((entries[i].dateInterval + 978307200) * 1000).getUTCDate()).toBe(1);
            }
            expect(Number.isInteger(entries[i].smoothMs)).toBe(true);
        }
    });

    test('the stored series is leap-step-free: never more than 150 ms between samples', () => {
        for (let i = 1; i < entries.length; i++) {
            expect(Math.abs(entries[i].smoothMs - entries[i - 1].smoothMs)).toBeLessThanOrEqual(150);
        }
    });

    test('UT1−UTC stays inside ±0.9 s for the whole leap-second era', () => {
        // Daily steps through the table, not just the samples: interpolation
        // across a leap-second month must not leak outside the band either.
        for (let t = kECUT1TableFirstSample; t < Math.min(kECUT1TableLastSample, kContinuousUTCStart); t += 86400) {
            expect(Math.abs(ut1MinusUTCForDateInterval(t))).toBeLessThan(0.9);
        }
    });

    test('every leap second since 1973 is an exact +1 s step in UT1−UTC', () => {
        const leaps = leapSecondTableEntries().filter((e) => e.dateInterval > kECUT1TableFirstSample);
        expect(leaps.length).toBe(25);
        for (const { dateInterval } of leaps) {
            const before = ut1MinusUTCForDateInterval(dateInterval - 1);
            const after = ut1MinusUTCForDateInterval(dateInterval);
            expect(after - before).toBeCloseTo(1, 3);
        }
    });

    test('known values: the 2017 leap second took UT1−UTC from −0.41 s to +0.59 s', () => {
        // Dec 31 is interpolated across the month (a few ms); Jan 1 is a sample.
        expect(Math.abs(ut1MinusUTCForDateInterval(appleEpoch('2016-12-31T00:00:00Z')) - (-0.407))).toBeLessThan(0.02);
        expect(ut1MinusUTCForDateInterval(appleEpoch('2017-01-01T00:00:00Z'))).toBeCloseTo(0.591, 3);
    });
});

describe('ut1MinusUTCForDateInterval', () => {
    test('reproduces the samples and interpolates linearly between them', () => {
        // Pick a stretch with no leap second so the stored value is UT1−UTC itself.
        const i = entries.findIndex((e) => e.dateInterval >= appleEpoch('2020-03-01T00:00:00Z'));
        const a = entries[i];
        const b = entries[i + 1];
        expect(ut1MinusUTCForDateInterval(a.dateInterval)).toBeCloseTo(a.smoothMs / 1000, 9);
        expect(ut1MinusUTCForDateInterval(b.dateInterval)).toBeCloseTo(b.smoothMs / 1000, 9);
        const mid = (a.dateInterval + b.dateInterval) / 2;
        expect(ut1MinusUTCForDateInterval(mid)).toBeCloseTo((a.smoothMs + b.smoothMs) / 2000, 9);
    });

    test('the segment cache gives the same answers as a cold lookup, in any order', () => {
        const probes = [
            appleEpoch('1980-06-15T12:00:00Z'), appleEpoch('2026-01-01T00:00:00Z'),
            appleEpoch('1973-01-02T00:00:00Z'), appleEpoch('1999-12-31T23:59:59Z'),
            appleEpoch('2026-01-01T00:00:00Z'), appleEpoch('2010-07-04T06:00:00Z'),
        ];
        const cold = probes.map((t) => ut1MinusUTCForDateInterval(t));
        for (let pass = 0; pass < 3; pass++) {
            const order = pass === 0 ? probes : pass === 1 ? [...probes].reverse() : [...probes].sort();
            for (const t of order) {
                expect(ut1MinusUTCForDateInterval(t)).toBe(cold[probes.indexOf(t)]);
            }
        }
    });

    test('before the first sample the UT1−UTC value there is held (not the smooth series)', () => {
        const first = ut1MinusUTCForDateInterval(kECUT1TableFirstSample);
        expect(first).toBe(kECUT1AtFirstSample);
        expect(Math.abs(first)).toBeLessThan(0.9);
        // 1972 has two leap seconds behind the first sample; the hold must
        // not step back through them.
        for (const iso of ['1972-01-01T00:00:00Z', '1972-06-30T23:59:59Z', '1972-07-01T00:00:00Z', '1960-01-01T00:00:00Z']) {
            expect(ut1MinusUTCForDateInterval(appleEpoch(iso))).toBe(first);
        }
    });

    test('the model takes over at the last sample with no step and the IERS slope', () => {
        const t0 = kECUT1TableLastSample;
        expect(ut1MinusUTCForDateInterval(t0)).toBeCloseTo(kECUT1AtLastSample, 9);
        expect(ut1MinusUTCForDateInterval(t0 + 1)).toBeCloseTo(kECUT1AtLastSample, 6);
        const dt = 86400;
        const slopePerDay = (ut1MinusUTCForDateInterval(t0 + dt) - ut1MinusUTCForDateInterval(t0)) / dt * kSecondsPerYear;
        expect(slopePerDay).toBeCloseTo(kECUT1SlopePerYear, 4);
        // Sanity on the constants themselves: a small current trend and the
        // 2 × 32 s/cy² curvature.
        expect(Math.abs(kECUT1SlopePerYear)).toBeLessThan(1);
        expect(kECUT1SecularCurvature).toBe(0.0064);
    });

    test('far future follows DUT1(t₀) + s·τ − ½·c·τ²', () => {
        for (const years of [1, 10, 23.5, 100]) {
            const t = kECUT1TableLastSample + years * kSecondsPerYear;
            const want = kECUT1AtLastSample + kECUT1SlopePerYear * years
                - 0.5 * kECUT1SecularCurvature * years * years;
            expect(ut1MinusUTCForDateInterval(t)).toBeCloseTo(want, 9);
        }
        // The curvature is the parabola's: a century out it contributes 32 s.
        const century = kECUT1TableLastSample + 100 * kSecondsPerYear;
        const linear = kECUT1AtLastSample + kECUT1SlopePerYear * 100;
        expect(linear - ut1MinusUTCForDateInterval(century)).toBeCloseTo(32, 6);
    });
});
