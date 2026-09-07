// @vitest-environment jsdom
/**
 * tz-resolve — provisional vs confident timezone answers, and the DB-backed
 * re-resolution that corrects a provisional one.
 *
 * The city DB is parsed lazily; while it is not resident, resolveTimezone()
 * can only return the browser's zone. That answer is a guess and must never be
 * persisted as the location's timezone — every app's ensureTzResolved()
 * corrects it from the DB. These tests pin the contract those paths rely on.
 *
 * Fixture note: ingest() nulls window.ChronometerCities, so the fixture must be
 * re-installed before every load (or a second loadCityData() falls through to
 * the fetch path and hangs under jsdom).
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { loadCityData, releaseCityData, isCityDataLoaded } from '../shared/city-search.js';
import { resolveTimezone, resolveTimezoneProvisional, resolveTimezoneFromDb } from '../shared/tz-resolve.js';

function packB64(arr: ArrayBufferView): string {
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
}

/** Two cities: Munich (Europe/Berlin) and San Jose (America/Los_Angeles). */
function installFixture(): void {
    const cLat = Int32Array.from([48137, 37339]);
    const cLon = Int32Array.from([11575, -121895]);
    const cPop = Uint32Array.from([1400000, 1000000]);
    const cTz = Uint16Array.from([2, 1]);
    const cCc = Uint16Array.from([1, 0]);
    const cAd1 = Uint16Array.from([2, 1]);
    (window as any).ChronometerCities = {
        v: 2, N: 2, aN: 0,
        TZ: ['', 'America/Los_Angeles', 'Europe/Berlin'],
        CC: ['US', 'DE'],
        AD: ['', 'California', 'Bavaria'],
        ad2: {},
        cLat: packB64(cLat), cLon: packB64(cLon), cPop: packB64(cPop),
        cTz: packB64(cTz), cCc: packB64(cCc), cAd1: packB64(cAd1),
        names: 'Munich\nSan Jose', ascii: 'munich\nsan jose', alts: '\n',
        aLat: packB64(new Int32Array(0)), aLon: packB64(new Int32Array(0)),
        aTz: packB64(new Uint16Array(0)), aCc: packB64(new Uint16Array(0)),
        aIata: '', aCity: '',
    };
}

const SAN_JOSE = { lat: 37.339, lon: -121.895 };
const MUNICH = { lat: 48.137, lon: 11.575 };
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

beforeEach(() => {
    releaseCityData();
    installFixture();
});

describe('resolveTimezoneProvisional', () => {
    test('DB not resident → the browser zone, flagged provisional; resolveTimezone agrees', () => {
        expect(isCityDataLoaded()).toBe(false);
        const r = resolveTimezoneProvisional(SAN_JOSE.lat, SAN_JOSE.lon, null);
        expect(r).toEqual({ tz: browserZone(), provisional: true });
        expect(resolveTimezone(SAN_JOSE.lat, SAN_JOSE.lon, null)).toBe(r.tz);
    });

    test('DB resident → the nearest city\'s zone, confident', async () => {
        await loadCityData();
        expect(resolveTimezoneProvisional(SAN_JOSE.lat, SAN_JOSE.lon, null)).toEqual({ tz: 'America/Los_Angeles', provisional: false });
        expect(resolveTimezoneProvisional(MUNICH.lat, MUNICH.lon, null)).toEqual({ tz: 'Europe/Berlin', provisional: false });
    });

    test('a city pick is confident regardless of the DB', () => {
        expect(resolveTimezoneProvisional(0, 0, 'Asia/Tokyo')).toEqual({ tz: 'Asia/Tokyo', provisional: false });
    });
});

describe('resolveTimezoneFromDb', () => {
    test('loads the DB on demand and returns the nearest city\'s zone (caller owns the release)', async () => {
        expect(isCityDataLoaded()).toBe(false);
        await expect(resolveTimezoneFromDb(MUNICH.lat, MUNICH.lon)).resolves.toBe('Europe/Berlin');
        expect(isCityDataLoaded()).toBe(true);
    });

    test('tolerates a release racing between its load and its lookup (reloads and retries)', async () => {
        const pending = resolveTimezoneFromDb(SAN_JOSE.lat, SAN_JOSE.lon);   // awaits loadCityData() → continuation queued
        releaseCityData();                                                   // the "other consumer" frees it first
        installFixture();                                                    // (fixture re-install: see header)
        await expect(pending).resolves.toBe('America/Los_Angeles');
    });

    test('after a release, a fresh call re-parses and answers for the new coordinates', async () => {
        await resolveTimezoneFromDb(MUNICH.lat, MUNICH.lon);
        releaseCityData();
        installFixture();
        await expect(resolveTimezoneFromDb(SAN_JOSE.lat, SAN_JOSE.lon)).resolves.toBe('America/Los_Angeles');
    });
});
