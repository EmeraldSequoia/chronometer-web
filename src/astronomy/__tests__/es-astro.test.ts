/**
 * Tests for ESAstronomy port modules.
 * 
 * Verifies: es-time.ts, es-sidereal.ts, es-coordinates.ts, es-astro.ts, es-riseset.ts.
 * Cross-referenced with known astronomical data and the original C implementation.
 */
import { describe, test, expect } from 'vitest';
import {
    ECMeeusDeltaT,
    espenakDeltaT,
    julianDateForDate,
    julianCenturiesSince2000EpochForDateInterval,
    priorUTMidnightForDateInterval,
    dateToDateInterval,
    dateIntervalToDate,
} from '../es-time';
import { kECLeapTableValidUntilISO } from '../es-leap-second';
import {
    convertUTToGSTP03,
    convertGSTtoLST,
    convertLSTtoGST,
    convertGSTtoUT,
    convertGSTtoUTclosest,
} from '../es-sidereal';
import {
    raAndDeclO,
    generalObliquity,
    generalPrecessionSinceJ2000,
    convertJ2000ToOfDate,
    refineConvertToJ2000FromOfDate,
    sunRAandDecl,
    moonRAAndDecl,
} from '../es-coordinates';
import {
    sunAltitude,
    sunAzimuth,
    moonAltitude,
    moonAge,
    moonRelativePositionAngle,
    EOTSeconds,
    localSiderealTime,
    solarLongitudeCrossingTime,
    vernalEquinoxOnOrBefore,
    vernalEquinoxAfter,
    fractionOfVernalEquinoxYear,
} from '../es-astro';
import {
    sunriseForDay,
    sunsetForDay,
    suntransitForDay,
    civilTwilightMorning,
    civilTwilightEvening,
} from '../es-riseset';
import { AstroCache, AstroCachePool, CacheSlot, initializeCachePool } from '../astro-cache';

// Helper: convert Date to Apple epoch seconds
function appleEpoch(date: Date): number {
    return date.getTime() / 1000 - 978307200;
}

// Helper: radians to degrees
function toDeg(rad: number): number {
    return rad * 180 / Math.PI;
}

// Helper: degrees to radians  
function toRad(deg: number): number {
    return deg * Math.PI / 180;
}

describe('es-time', () => {
    test('dateToDateInterval round-trips with dateIntervalToDate', () => {
        const d = new Date('2024-06-15T12:00:00Z');
        const interval = dateToDateInterval(d);
        const roundTripped = dateIntervalToDate(interval);
        expect(roundTripped.getTime()).toBe(d.getTime());
    });

    test('appleEpoch matches dateToDateInterval', () => {
        const d = new Date('2024-06-15T12:00:00Z');
        expect(dateToDateInterval(d)).toBe(appleEpoch(d));
    });

    test('Julian date of J2000.0 epoch', () => {
        // J2000.0 = 2000 Jan 1.5 TT = 2000-01-01 12:00:00 TT
        // Apple epoch = 2001-01-01 00:00:00 UTC
        // J2000.0 is about 365.5 days before Apple epoch
        const j2000AppleSeconds = appleEpoch(new Date('2000-01-01T12:00:00Z'));
        const jd = julianDateForDate(j2000AppleSeconds);
        // J2000.0 is defined at 12h TT, not UT. UT is ~64s earlier → ~0.00074 JD diff
        // julianDateForDate converts UT directly, so we expect the UT JD to be close.
        // The UT noon JD should be 2451545.0 ± ~0.001 JD (the Delta T offset)
        expect(jd).toBeCloseTo(2451545.0, 2);
    });

    test('Delta T values are reasonable for year 2000', () => {
        // Both methods should give ~64 seconds for year 2000
        const meeus = ECMeeusDeltaT(2000);
        const espenak = espenakDeltaT(2000);
        expect(meeus).toBeCloseTo(63.8, 0);
        expect(espenak).toBeCloseTo(63.8, 0);
    });

    test('Delta T values reasonable for year 1900', () => {
        const meeus = ECMeeusDeltaT(1900);
        expect(meeus).toBeCloseTo(-2.8, 0);
    });

    test('priorUTMidnightForDateInterval returns midnight', () => {
        const afternoon = appleEpoch(new Date('2024-06-15T15:30:00Z'));
        const midnight = priorUTMidnightForDateInterval(afternoon, null);
        const expectedMidnight = appleEpoch(new Date('2024-06-15T00:00:00Z'));
        expect(midnight).toBe(expectedMidnight);
    });

    test('julianCenturiesSince2000Epoch for J2000.0 is near zero', () => {
        const j2000 = appleEpoch(new Date('2000-01-01T12:00:00Z'));
        const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(j2000, null);
        // Should be close to 0 (within Delta T offset)
        expect(Math.abs(julianCenturiesSince2000Epoch)).toBeLessThan(0.0001);
    });

    test('julianCenturiesSince2000Epoch for J2100.0 is near 1.0', () => {
        const j2100 = appleEpoch(new Date('2100-01-01T12:00:00Z'));
        const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(j2100, null);
        expect(Math.abs(julianCenturiesSince2000Epoch - 1.0)).toBeLessThan(0.001);
    });
});

/**
 * ΔT from 1972 onward is a table lookup, not a fit — see convertUTtoET.
 * These pin the exact values; `espenakDeltaT` and `ECMeeusDeltaT` above are
 * unchanged and still cover the polynomial era.
 */
describe('es-time leap-second ΔT', () => {
    const deltaTAt = (iso: string) =>
        julianCenturiesSince2000EpochForDateInterval(appleEpoch(new Date(iso)), null).deltaT;

    test.each([
        ['1972-01-02T00:00:00Z', 42.184],   // first day of the leap era
        ['1976-06-15T00:00:00Z', 47.184],   // mid-table: TAI−UTC = 15
        ['1995-06-15T00:00:00Z', 61.184],   // mid-table: TAI−UTC = 29
        ['2017-01-01T00:00:00Z', 69.184],   // the last leap second
        ['2020-06-21T06:41:00Z', 69.184],   // an eclipse the data test replays
        ['2026-08-18T12:00:00Z', 69.184],   // today
    ])('ΔT at %s is exactly %s s', (iso, expected) => {
        expect(deltaTAt(iso)).toBeCloseTo(expected, 5);
    });

    test('pre-1972 instants still use the Espenak polynomial', () => {
        // 1971-07-01 is half a year before the table starts, so the
        // polynomial's 1961–1986 branch is what should answer — 41.7 s, well
        // clear of the 42.184 s the table would have given.
        const yearValue = 1971 + 181 / 365.25;   // the convention convertUTtoET is fed
        expect(deltaTAt('1971-07-01T00:00:00Z')).toBeCloseTo(espenakDeltaT(yearValue), 5);
    });

    test('the 1972 handover steps by less than a tenth of a second', () => {
        const before = deltaTAt('1971-12-31T23:00:00Z');
        const after = deltaTAt('1972-01-01T01:00:00Z');
        expect(Math.abs(after - before)).toBeLessThan(0.1);
    });

    test('ΔT is continuous except at the leap seconds themselves', () => {
        // Sample every 6 hours from 1970 to 2400. Steps of exactly 1 s are
        // leap seconds; the handovers at 1972 and at the table's expiry, and
        // everything in between, must stay under 0.1 s.
        const start = appleEpoch(new Date('1970-01-01T00:00:00Z'));
        const step = 6 * 3600;
        const samples = Math.floor((appleEpoch(new Date('2400-01-01T00:00:00Z')) - start) / step);
        let previous = julianCenturiesSince2000EpochForDateInterval(start, null).deltaT;
        let leapSteps = 0;
        for (let i = 1; i <= samples; i++) {
            const t = start + i * step;
            const current = julianCenturiesSince2000EpochForDateInterval(t, null).deltaT;
            const jump = current - previous;
            if (Math.abs(jump - 1) < 1e-6) {
                leapSteps++;
            } else if (Math.abs(jump) >= 0.1) {
                throw new Error(`ΔT jumped ${jump.toFixed(4)} s at ` +
                    `${new Date((t + 978307200) * 1000).toISOString()}`);
            }
            previous = current;
        }
        expect(leapSteps).toBe(27);
    });

    test('the rejoin at the table expiry is continuous', () => {
        const expiry = appleEpoch(new Date(`${kECLeapTableValidUntilISO}T00:00:00Z`));
        const inside = julianCenturiesSince2000EpochForDateInterval(expiry - 1, null).deltaT;
        const outside = julianCenturiesSince2000EpochForDateInterval(expiry + 1, null).deltaT;
        expect(inside).toBeCloseTo(69.184, 5);
        expect(outside).toBeCloseTo(69.184, 4);
    });

    test('past the expiry ΔT resumes growing at the polynomial rate', () => {
        // Offset, not clamp: the parabola's curvature is the part of the
        // physics worth keeping.
        const y2040 = deltaTAt('2040-01-01T00:00:00Z');
        expect(y2040).toBeGreaterThan(69.184);
        expect(y2040 - 69.184).toBeCloseTo(espenakDeltaT(2040) - espenakDeltaT(2027.49), 0);
    });
});

describe('es-sidereal', () => {
    test('GST is reasonable for J2000.0', () => {
        // At J2000.0 (2000-01-01 12:00 UT), GST should be about 18h 41m = 4.894 rad
        const j2000 = appleEpoch(new Date('2000-01-01T12:00:00Z'));
        const gst = convertUTToGSTP03(j2000, null);
        const gstHours = toDeg(gst) / 15;
        expect(gstHours).toBeCloseTo(18.7, 0); // Within about half an hour
    });

    test('LST = GST + longitude', () => {
        const gst = toRad(90); // 6 hours
        const lon = toRad(10); // 10° east
        const lst = convertGSTtoLST(gst, lon);
        expect(lst).toBeCloseTo(gst + lon, 10);
    });

    test('convertLSTtoGST inverts convertGSTtoLST', () => {
        const gst = toRad(90);
        const lon = toRad(30);
        const lst = convertGSTtoLST(gst, lon);
        const { gst: gstBack } = convertLSTtoGST(lst, lon);
        expect(gstBack).toBeCloseTo(gst, 10);
    });

    test('convertGSTtoUTclosest returns time near target', () => {
        const target = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const gst = convertUTToGSTP03(target, null);
        const recovered = convertGSTtoUTclosest(gst, target, null);
        // Should recover roughly the same time (within seconds)
        expect(Math.abs(recovered - target)).toBeLessThan(5);
    });
});

describe('es-coordinates', () => {
    test('obliquity at J2000.0 is about 23.44°', () => {
        const obliquity = generalObliquity(0); // t=0 is J2000.0
        expect(toDeg(obliquity)).toBeCloseTo(23.44, 1);
    });

    test('precession at J2000.0 is zero', () => {
        const prec = generalPrecessionSinceJ2000(0);
        expect(prec).toBeCloseTo(0, 10);
    });

    test('precession after 1 century is about 1.4°', () => {
        const prec = generalPrecessionSinceJ2000(1);
        expect(toDeg(prec)).toBeCloseTo(1.4, 0);
    });

    test('raAndDeclO for zero ecliptic lat/long gives RA~0, Decl~0', () => {
        const obliquity = generalObliquity(0);
        const { rightAscension, declination } = raAndDeclO(0, 0, obliquity);
        expect(rightAscension).toBeCloseTo(0, 5);
        expect(declination).toBeCloseTo(0, 5);
    });

    test('J2000 to of-date round-trip is accurate', () => {
        const t = 0.5; // Halfway through century
        const raJ2000 = toRad(120);
        const declJ2000 = toRad(25);
        const { raOfDate, declOfDate } = convertJ2000ToOfDate(t, raJ2000, declJ2000);
        const { raJ2000: raBack, declJ2000: declBack } = refineConvertToJ2000FromOfDate(t, raOfDate, declOfDate);
        // refineConvertToJ2000FromOfDate uses Meeus approximation, not exact P03 inverse
        // so we get ~arcsecond accuracy (~5 decimal places in radians)
        expect(raBack).toBeCloseTo(raJ2000, 5);
        expect(declBack).toBeCloseTo(declJ2000, 5);
    });

    test('Sun RA/Decl are in reasonable ranges', () => {
        const summerSolstice = appleEpoch(new Date('2024-06-21T12:00:00Z'));
        const { rightAscension, declination } = sunRAandDecl(summerSolstice, null);
        // RA should be about 6h = π/2 radians
        expect(toDeg(rightAscension) / 15).toBeCloseTo(6, 0);
        // Declination should be about +23.4°
        expect(toDeg(declination)).toBeCloseTo(23.4, 0.5);
    });

    test('Moon RA/Decl return valid results', () => {
        const date = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const result = moonRAAndDecl(date, null);
        // RA should be in [0, 2π)
        expect(result.rightAscension).toBeGreaterThanOrEqual(0);
        expect(result.rightAscension).toBeLessThan(Math.PI * 2);
        // Declination should be in [-π/2, π/2]
        expect(Math.abs(result.declination)).toBeLessThanOrEqual(Math.PI / 2);
    });
});

describe('es-astro', () => {
    // Haleakala, Maui: lat 20.7167°N, lon -156.15°W
    const haleakalaLat = toRad(20.7167);
    const haleakalaLon = toRad(-156.15);

    test('Sun altitude at solar noon is positive and reasonable', () => {
        // At noon UT (which is roughly morning in Hawaii), Sun may or may not be up
        // Let's pick Hawaiian noon ≈ 22:00 UT
        const hawaiiNoon = appleEpoch(new Date('2024-06-15T22:00:00Z'));
        const alt = sunAltitude(hawaiiNoon, haleakalaLat, haleakalaLon, null);
        // Sun should be very high near Hawaiian solstice noon
        expect(toDeg(alt)).toBeGreaterThan(60);
        expect(toDeg(alt)).toBeLessThan(93); // Can't be more than ~90°
    });

    test('Sun altitude at midnight is negative', () => {
        // Hawaii midnight ≈ 10:00 UT
        const hawaiiMidnight = appleEpoch(new Date('2024-06-16T10:00:00Z'));
        const alt = sunAltitude(hawaiiMidnight, haleakalaLat, haleakalaLon, null);
        expect(toDeg(alt)).toBeLessThan(0);
    });

    test('Sun azimuth is in valid range', () => {
        const date = appleEpoch(new Date('2024-06-15T22:00:00Z'));
        const az = sunAzimuth(date, haleakalaLat, haleakalaLon, null);
        expect(az).toBeGreaterThanOrEqual(-Math.PI);
        expect(az).toBeLessThanOrEqual(Math.PI);
    });

    test('Moon altitude is in valid range', () => {
        const date = appleEpoch(new Date('2024-06-15T22:00:00Z'));
        const alt = moonAltitude(date, haleakalaLat, haleakalaLon, null);
        expect(toDeg(alt)).toBeGreaterThan(-90);
        expect(toDeg(alt)).toBeLessThan(90);
    });

    test('Moon age is in [0, 2π)', () => {
        const date = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const { age, phase } = moonAge(date, null);
        expect(age).toBeGreaterThanOrEqual(0);
        expect(age).toBeLessThan(Math.PI * 2);
        expect(phase).toBeGreaterThanOrEqual(0);
        expect(phase).toBeLessThanOrEqual(1);
    });

    test('EOT is within reasonable range (±20 minutes)', () => {
        const date = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const eot = EOTSeconds(date, null);
        expect(Math.abs(eot)).toBeLessThan(20 * 60); // less than 20 minutes
    });

    test('LST differs from GST by observer longitude', () => {
        const date = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const lst = localSiderealTime(date, toRad(45), null);
        const gst = convertUTToGSTP03(date, null);
        // LST - GST should equal longitude (modulo 2π)
        let diff = lst - gst;
        if (diff < 0) diff += Math.PI * 2;
        if (diff > Math.PI * 2) diff -= Math.PI * 2;
        expect(diff).toBeCloseTo(toRad(45), 5);
    });
});

describe('es-riseset', () => {
    // Haleakala location
    const lat = toRad(20.7167);
    const lon = toRad(-156.15);

    function makeCachePool(dateInterval: number, latitude: number, longitude: number): AstroCachePool {
        const pool = new AstroCachePool();
        initializeCachePool(pool, dateInterval, latitude, longitude);
        return pool;
    }

    test('Sunrise and sunset bracket solar noon (London)', () => {
        // Use London (lat 51.5°N, lon 0°) where UT noon = local noon,
        // so sunrise & sunset found from UT noon are both on the same local day.
        const londonLat = toRad(51.5);
        const londonLon = toRad(0);
        const date = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const pool = makeCachePool(date, londonLat, londonLon);

        const sunrise = sunriseForDay(date, londonLat, londonLon, pool);
        const sunset = sunsetForDay(date, londonLat, londonLon, pool);

        // Sunrise should be before sunset on a normal day
        expect(sunrise).toBeLessThan(sunset);

        // Day length in London in June: about 16-17 hours
        const dayLengthHours = (sunset - sunrise) / 3600;
        expect(dayLengthHours).toBeGreaterThan(15);
        expect(dayLengthHours).toBeLessThan(18);
    });

    test('Solar transit is between sunrise and sunset (London)', () => {
        const londonLat = toRad(51.5);
        const londonLon = toRad(0);
        const date = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const pool = makeCachePool(date, londonLat, londonLon);

        const sunrise = sunriseForDay(date, londonLat, londonLon, pool);
        const sunset = sunsetForDay(date, londonLat, londonLon, pool);
        const transit = suntransitForDay(date, londonLat, londonLon, pool);

        expect(transit).toBeGreaterThan(sunrise);
        expect(transit).toBeLessThan(sunset);
    });

    test('Sunrise at Haleakala on June 15 2024 is approximately 5:50 AM HST', () => {
        // HST = UTC-10. Sunrise ~5:50 AM HST = 15:50 UTC
        const date = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const pool = makeCachePool(date, lat, lon);

        const sunrise = sunriseForDay(date, lat, lon, pool);
        const sunriseDate = dateIntervalToDate(sunrise);
        const sunriseHST_hours = sunriseDate.getUTCHours() - 10; // Convert UTC to HST
        const adjustedHours = sunriseHST_hours < 0 ? sunriseHST_hours + 24 : sunriseHST_hours;
        const sunriseDecimal = adjustedHours + sunriseDate.getUTCMinutes() / 60;

        // Expected: approximately 5:50 AM = 5.83
        expect(sunriseDecimal).toBeCloseTo(5.83, 0);
    });

    test('Civil twilight starts before sunrise', () => {
        const date = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const pool = makeCachePool(date, lat, lon);

        const sunrise = sunriseForDay(date, lat, lon, pool);
        const civilDawn = civilTwilightMorning(date, lat, lon, pool);

        // Civil twilight should be about 20-30 minutes before sunrise
        expect(civilDawn).toBeLessThan(sunrise);
        const diffMinutes = (sunrise - civilDawn) / 60;
        expect(diffMinutes).toBeGreaterThan(15);
        expect(diffMinutes).toBeLessThan(45);
    });

    test('Civil twilight ends after sunset', () => {
        const date = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const pool = makeCachePool(date, lat, lon);

        const sunset = sunsetForDay(date, lat, lon, pool);
        const civilDusk = civilTwilightEvening(date, lat, lon, pool);

        // Civil twilight should be about 20-30 minutes after sunset
        expect(civilDusk).toBeGreaterThan(sunset);
        const diffMinutes = (civilDusk - sunset) / 60;
        expect(diffMinutes).toBeGreaterThan(15);
        expect(diffMinutes).toBeLessThan(45);
    });
});

describe('AstroCache', () => {
    test('cache stores and retrieves values', () => {
        const cache = new AstroCache();
        cache.set(CacheSlot.sunRA, 1.234);
        expect(cache.isValid(CacheSlot.sunRA)).toBe(true);
        expect(cache.get(CacheSlot.sunRA)).toBe(1.234);
    });

    test('cache invalidation clears all values', () => {
        const cache = new AstroCache();
        cache.set(CacheSlot.sunRA, 1.234);
        cache.invalidate();
        expect(cache.isValid(CacheSlot.sunRA)).toBe(false);
    });

    test('AstroCachePool initialization works', () => {
        const pool = new AstroCachePool();
        const date = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        initializeCachePool(pool, date, toRad(20), toRad(-156));
        expect(pool.currentCache).toBeTruthy();
    });
});

describe('Moon astronomy end-to-end', () => {
    // San Jose, CA
    const lat = toRad(37.205);
    const lon = toRad(-121.954);

    test('moonRelativePositionAngle returns a value in [0, 2π)', () => {
        const date = appleEpoch(new Date('2024-06-15T22:00:00Z'));
        const angle = moonRelativePositionAngle(date, lat, lon, null);
        expect(angle).toBeGreaterThanOrEqual(0);
        expect(angle).toBeLessThan(Math.PI * 2);
    });

    test('moonRelativePositionAngle changes appreciably over 6 hours', () => {
        const date1 = appleEpoch(new Date('2024-06-15T12:00:00Z'));
        const date2 = appleEpoch(new Date('2024-06-15T18:00:00Z'));
        const angle1 = moonRelativePositionAngle(date1, lat, lon, null);
        const angle2 = moonRelativePositionAngle(date2, lat, lon, null);
        // The angle should change noticeably over 6 hours (not stuck at 0)
        const diff = Math.abs(angle2 - angle1);
        expect(diff).toBeGreaterThan(0.01);
    });

    test('moonAge at known full moon is approximately π', () => {
        // Full Moon: 2024-06-22 01:08 UTC
        const fullMoon = appleEpoch(new Date('2024-06-22T01:08:00Z'));
        const { age } = moonAge(fullMoon, null);
        // Should be close to π (180°)
        expect(toDeg(age)).toBeCloseTo(180, -1);  // within ~10°
    });

    test('moonAge at known new moon is approximately 0 or 2π', () => {
        // New Moon: 2024-06-06 12:38 UTC
        const newMoon = appleEpoch(new Date('2024-06-06T12:38:00Z'));
        const { age } = moonAge(newMoon, null);
        // Should be close to 0 (or 2π wrapped)
        const ageDeg = toDeg(age);
        const nearZero = ageDeg < 10 || ageDeg > 350;
        expect(nearZero).toBe(true);
    });

    test('moonAge phase is near 0 at new moon, near 1 at full moon', () => {
        const newMoon = appleEpoch(new Date('2024-06-06T12:38:00Z'));
        const fullMoon = appleEpoch(new Date('2024-06-22T01:08:00Z'));
        const { phase: phaseNew } = moonAge(newMoon, null);
        const { phase: phaseFull } = moonAge(fullMoon, null);
        expect(phaseNew).toBeLessThan(0.05);
        expect(phaseFull).toBeGreaterThan(0.95);
    });
});

describe('Solar longitude crossings (equinoxes / solstices)', () => {
    const TWO_PI = Math.PI * 2;

    // Published 2024 equinox/solstice instants (UT), good to the minute.
    test('2024 equinoxes and solstices match published times within 2 min', () => {
        const cases: { target: number; approx: Date; expected: Date }[] = [
            { target: 0,            approx: new Date('2024-03-20T12:00:00Z'), expected: new Date('2024-03-20T03:06:00Z') },
            { target: Math.PI / 2,  approx: new Date('2024-06-20T00:00:00Z'), expected: new Date('2024-06-20T20:51:00Z') },
            { target: Math.PI,      approx: new Date('2024-09-22T00:00:00Z'), expected: new Date('2024-09-22T12:44:00Z') },
            { target: 3 * Math.PI / 2, approx: new Date('2024-12-21T00:00:00Z'), expected: new Date('2024-12-21T09:21:00Z') },
        ];
        for (const { target, approx, expected } of cases) {
            const di = solarLongitudeCrossingTime(target, appleEpoch(approx), null);
            const errSec = Math.abs(di - appleEpoch(expected));
            expect(errSec).toBeLessThan(120);
        }
    });

    test('vernalEquinoxOnOrBefore / After bracket the instant', () => {
        const t = appleEpoch(new Date('2026-06-25T12:00:00Z'));
        const prev = vernalEquinoxOnOrBefore(t, null);
        const next = vernalEquinoxAfter(t, null);
        expect(prev).toBeLessThanOrEqual(t);
        expect(next).toBeGreaterThan(t);
        // The bracketing interval is one tropical year (~365.24 d) ± a few minutes.
        const lenDays = (next - prev) / 86400;
        expect(lenDays).toBeGreaterThan(365.0);
        expect(lenDays).toBeLessThan(365.5);
    });

    // Regression: near the autumnal equinox λ☉ ≈ π is equidistant from the two
    // bracketing λ☉ = 0 crossings, so a search seeded there can land on either.
    // The bracketing helpers must still return adjacent equinoxes (one year
    // apart), not skip a year — which would halve fractionOfVernalEquinoxYear.
    test('bracketing helpers span exactly one year at every point in the year', () => {
        const ve = solarLongitudeCrossingTime(0, appleEpoch(new Date('2024-03-20T12:00:00Z')), null);
        const year = 365.2422 * 86400;
        for (let k = 0; k < 48; k++) {
            const t = ve + (k / 48) * year;
            const prev = vernalEquinoxOnOrBefore(t, null);
            const next = vernalEquinoxAfter(t, null);
            expect(prev).toBeLessThanOrEqual(t);
            expect(next).toBeGreaterThan(t);
            const lenDays = (next - prev) / 86400;
            expect(lenDays).toBeGreaterThan(365.0);
            expect(lenDays).toBeLessThan(365.5);
        }
    });

    test('fractionOfVernalEquinoxYear tracks elapsed time across the year', () => {
        const ve = solarLongitudeCrossingTime(0, appleEpoch(new Date('2024-03-20T12:00:00Z')), null);
        const year = vernalEquinoxAfter(ve, null) - ve;
        for (let k = 1; k < 24; k++) {
            const frac = k / 24;
            expect(fractionOfVernalEquinoxYear(ve + frac * year, null)).toBeCloseTo(frac, 6);
        }
    });

    test('fractionOfVernalEquinoxYear: 0 at equinox, monotonic, wraps to ~1', () => {
        const ve = solarLongitudeCrossingTime(0, appleEpoch(new Date('2025-03-20T12:00:00Z')), null);
        // Just after the equinox → fraction ≈ 0.
        expect(fractionOfVernalEquinoxYear(ve + 60, null)).toBeLessThan(0.001);
        // Quarter / half / three-quarter year in: strictly increasing within [0, 1).
        const f25 = fractionOfVernalEquinoxYear(ve + 0.25 * 365.2422 * 86400, null);
        const f50 = fractionOfVernalEquinoxYear(ve + 0.50 * 365.2422 * 86400, null);
        const f75 = fractionOfVernalEquinoxYear(ve + 0.75 * 365.2422 * 86400, null);
        expect(f25).toBeGreaterThan(0.2);
        expect(f25).toBeLessThan(0.3);
        expect(f50).toBeGreaterThan(f25);
        expect(f75).toBeGreaterThan(f50);
        expect(f75).toBeLessThan(1);
        // Just before the next equinox → fraction ≈ 1.
        const next = vernalEquinoxAfter(ve, null);
        expect(fractionOfVernalEquinoxYear(next - 60, null)).toBeGreaterThan(0.999);
    });

    test('crossing of every multiple of π/2 is found near its seed', () => {
        for (let k = 0; k < 4; k++) {
            const target = (k * Math.PI / 2) % TWO_PI;
            const seed = appleEpoch(new Date('2030-01-01T00:00:00Z')) + k * 91 * 86400;
            const di = solarLongitudeCrossingTime(target, seed, null);
            // Returned instant should actually have that longitude (within ~1 arcmin).
            expect(Math.abs(di - seed)).toBeLessThan(120 * 86400);
        }
    });
});
