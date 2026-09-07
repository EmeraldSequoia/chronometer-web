// @vitest-environment jsdom
/**
 * resolveTimezoneFromDb when the city database cannot be loaded, plus the
 * retry across the real shared-load-promise path.
 *
 * The apply hooks in every app branch on `null` ("DB unavailable — keep the
 * guess, persist nothing"); if this ever returned the browser zone instead,
 * a guess would be persisted as the location's tz — the poison the tz-resolve
 * header forbids. The city-search module is partially mocked so loadCityData
 * can be made to reject, to resolve without the DB becoming resident, or to
 * take a real macrotask like the production fetch+parse path.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const ctl: { loadCityData: (() => Promise<void>) | null; isLoaded: (() => boolean) | null } = { loadCityData: null, isLoaded: null };

vi.mock('../shared/city-search.js', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../shared/city-search.js')>();
    return {
        ...orig,
        loadCityData: () => (ctl.loadCityData ? ctl.loadCityData() : orig.loadCityData()),
        isCityDataLoaded: () => (ctl.isLoaded ? ctl.isLoaded() : orig.isCityDataLoaded()),
    };
});

import { loadCityData, releaseCityData, isCityDataLoaded } from '../shared/city-search.js';
import { resolveTimezoneFromDb } from '../shared/tz-resolve.js';

function packB64(arr: ArrayBufferView): string {
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
}
/** One city: San Jose (America/Los_Angeles). Re-install before every load (ingest nulls it). */
function installFixture(): void {
    (window as any).ChronometerCities = {
        v: 2, N: 1, aN: 0,
        TZ: ['', 'America/Los_Angeles'], CC: ['US'], AD: ['', 'California'], ad2: {},
        cLat: packB64(Int32Array.from([37339])), cLon: packB64(Int32Array.from([-121895])), cPop: packB64(Uint32Array.from([1000000])),
        cTz: packB64(Uint16Array.from([1])), cCc: packB64(Uint16Array.from([0])), cAd1: packB64(Uint16Array.from([1])),
        names: 'San Jose', ascii: 'san jose', alts: '',
        aLat: packB64(new Int32Array(0)), aLon: packB64(new Int32Array(0)), aTz: packB64(new Uint16Array(0)), aCc: packB64(new Uint16Array(0)),
        aIata: '', aCity: '',
    };
}
const SAN_JOSE = { lat: 37.339, lon: -121.895 };

beforeEach(() => {
    ctl.loadCityData = null; ctl.isLoaded = null;
    releaseCityData();
});

describe('resolveTimezoneFromDb when the DB cannot be loaded', () => {
    test('loadCityData rejects (offline) → null, never a browser zone', async () => {
        ctl.loadCityData = () => Promise.reject(new Error('offline'));
        await expect(resolveTimezoneFromDb(SAN_JOSE.lat, SAN_JOSE.lon)).resolves.toBeNull();
    });

    test('loadCityData resolves but the DB never becomes resident → null after the retry budget', async () => {
        let loads = 0;
        ctl.loadCityData = async () => { loads++; };
        ctl.isLoaded = () => false;
        await expect(resolveTimezoneFromDb(SAN_JOSE.lat, SAN_JOSE.lon)).resolves.toBeNull();
        expect(loads).toBe(3);
    });
});

describe('retry across an asynchronous load (the production fetch+parse shape)', () => {
    test('a release that lands between the shared load resolving and our lookup triggers a reload, not a null', async () => {
        // Like the real module: one in-flight promise shared by concurrent callers,
        // resolved after a macrotask (the gunzip+parse), nulled in a finally.
        let loads = 0;
        let inflight: Promise<void> | null = null;
        ctl.loadCityData = () => {
            inflight ??= (async () => {
                loads++;
                await new Promise((r) => setTimeout(r, 0));
                installFixture();
                ctl.loadCityData = null;                   // later loads go to the real module (fast path)
                const mod = await import('../shared/city-search.js');
                await mod.loadCityData();
            })().finally(() => { inflight = null; });
            return inflight;
        };
        // The "racing consumer" registers its release on the shared promise FIRST,
        // exactly as the location-name path's handler does…
        const shared = loadCityData();
        void shared.then(() => { releaseCityData(); installFixture(); });
        // …then the resolver awaits the same promise; its lookup runs after the release.
        const pending = resolveTimezoneFromDb(SAN_JOSE.lat, SAN_JOSE.lon);
        await expect(pending).resolves.toBe('America/Los_Angeles');
        expect(loads).toBe(1);                            // the retry re-parsed via the real fast path, not the mock
        expect(isCityDataLoaded()).toBe(true);            // the retry left it resident — the caller owns the release
    });
});
