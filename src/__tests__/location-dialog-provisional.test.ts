// @vitest-environment jsdom
/**
 * The shared location dialog reports whether the zone it resolved is a guess.
 *
 * Typed coordinates get their zone from the nearest city in the DB — but the
 * dialog only parses that DB on the first *search* keystroke, so "Use
 * coordinates" routinely runs with it unparsed and falls back to the browser's
 * zone. `LocationChangeInfo.provisional` is how the consumer (Observatory,
 * Inspector) knows not to persist that answer and to arm its ensureTzResolved()
 * backstop instead. These tests pin that flag end to end through the dialog.
 *
 * Fixture note: ingest() nulls window.ChronometerCities, so the fixture must be
 * re-installed before every load (see tz-resolve.test.ts).
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initLocationDialog } from '../shared/location-dialog.js';
import { loadCityData, releaseCityData, isCityDataLoaded } from '../shared/city-search.js';

// The map preview draws a globe onto a canvas and fetches an OSM tile — neither
// works under jsdom, and both are irrelevant to the reported zone.
vi.mock('../shared/mini-map.js', () => ({
    renderGlobe: async () => {},
    loadOSMTile: async () => true,
}));

const DIALOG_HTML = readFileSync(resolve(__dirname, '../partials/location-dialog.html'), 'utf8');

function packB64(arr: ArrayBufferView): string {
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
}

/** One city: San Jose (America/Los_Angeles). */
function installFixture(): void {
    (window as any).ChronometerCities = {
        v: 2, N: 1, aN: 0,
        TZ: ['', 'America/Los_Angeles'],
        CC: ['US'],
        AD: ['', 'California'],
        ad2: {},
        cLat: packB64(Int32Array.from([37339])),
        cLon: packB64(Int32Array.from([-121895])),
        cPop: packB64(Uint32Array.from([1000000])),
        cTz: packB64(Uint16Array.from([1])),
        cCc: packB64(Uint16Array.from([0])),
        cAd1: packB64(Uint16Array.from([1])),
        names: 'San Jose', ascii: 'san jose', alts: '',
        aLat: packB64(new Int32Array(0)), aLon: packB64(new Int32Array(0)),
        aTz: packB64(new Uint16Array(0)), aCc: packB64(new Uint16Array(0)),
        aIata: '', aCity: '',
    };
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Mount the dialog partial and return a recorder for onLocationChange. */
function mountDialog() {
    document.body.innerHTML = DIALOG_HTML;
    const changes: any[] = [];
    initLocationDialog({ onLocationChange: (info) => { changes.push(info); } });
    return changes;
}

/** Type coordinates and press "Use coordinates". */
function useCoords(lat: number, lon: number): void {
    (document.getElementById('lp-lat') as HTMLInputElement).value = String(lat);
    (document.getElementById('lp-lon') as HTMLInputElement).value = String(lon);
    document.getElementById('lp-use-coords')!.dispatchEvent(new Event('click'));
}

beforeEach(() => {
    releaseCityData();
    installFixture();
});

describe('LocationChangeInfo.provisional', () => {
    test('typed coordinates with the DB unparsed → the browser zone, flagged provisional', () => {
        expect(isCityDataLoaded()).toBe(false);
        const changes = mountDialog();
        useCoords(37.4, -121.9);
        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({
            lat: 37.4, lon: -121.9, sourceType: 'manual',
            timezone: browserZone(), provisional: true,
        });
    });

    test('typed coordinates with the DB resident → the nearest city\'s zone, confident', async () => {
        await loadCityData();
        const changes = mountDialog();
        useCoords(37.4, -121.9);
        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({
            timezone: 'America/Los_Angeles', provisional: false,
        });
    });

    test('the flag tracks the DB, not the location: same coordinates, both answers', async () => {
        const changes = mountDialog();
        useCoords(37.4, -121.9);
        await loadCityData();
        useCoords(37.4, -121.9);
        expect(changes.map(c => c.provisional)).toEqual([true, false]);
        expect(changes[1].timezone).toBe('America/Los_Angeles');
    });
});
