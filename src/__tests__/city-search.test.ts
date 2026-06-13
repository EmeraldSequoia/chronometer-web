// @vitest-environment jsdom
//
// Unit coverage for the columnar (v2) city-search engine. Uses a tiny synthetic
// payload (not the 17 MB production DB) to exercise the decode + search paths:
// base64 typed-array decode, newline-string row slicing, ASCII prefix match,
// exact-vs-prefix priority, population ordering, alternate-name scan, IATA
// match, label building (admin2/admin1/country), and findClosestCity.
//
// Full-database behavior parity (old array-of-arrays vs new columnar) was
// validated separately by scripts/parity-cities.mjs during the v2 migration.
import { describe, it, expect, beforeAll } from 'vitest';
import { loadCityData, searchCities, findClosestCity, isCityDataLoaded } from '../shared/city-search.js';

function packB64(arr: ArrayBufferView): string {
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
}

beforeAll(async () => {
    // Three cities, sorted by population descending (as the build does):
    // Munich (1.4M), San Jose (1.0M), San Francisco (870k).
    const names = ['Munich', 'San Jose', 'San Francisco'].join('\n');
    const ascii = ['munich', 'san jose', 'san francisco'].join('\n');
    const alts = ['munchen,muenchen', '', ''].join('\n');  // Munich matched via folded alt
    const cLat = Int32Array.from([48137, 37339, 37774]);   // round(deg * 1000)
    const cLon = Int32Array.from([11575, -121895, -122419]);
    const cPop = Uint32Array.from([1400000, 1000000, 870000]);
    const cTz = Uint16Array.from([2, 1, 1]);
    const cCc = Uint16Array.from([1, 0, 0]);
    const cAd1 = Uint16Array.from([2, 1, 1]);

    const aIata = ['SFO'].join('\n');
    const aCity = ['San Francisco'].join('\n');
    const aLat = Int32Array.from([37620]);
    const aLon = Int32Array.from([-122380]);
    const aTz = Uint16Array.from([1]);
    const aCc = Uint16Array.from([0]);

    (window as any).ChronometerCities = {
        v: 2, N: 3, aN: 1,
        TZ: ['', 'America/Los_Angeles', 'Europe/Berlin'],
        CC: ['US', 'DE'],
        AD: ['', 'California', 'Bavaria'],
        ad2: { '1': 'Santa Clara County' },  // San Jose needs admin2 disambiguation
        cLat: packB64(cLat), cLon: packB64(cLon), cPop: packB64(cPop),
        cTz: packB64(cTz), cCc: packB64(cCc), cAd1: packB64(cAd1),
        names, ascii, alts,
        aLat: packB64(aLat), aLon: packB64(aLon), aTz: packB64(aTz), aCc: packB64(aCc),
        aIata, aCity,
    };
    await loadCityData();
});

describe('city-search (columnar v2)', () => {
    it('loads the synthetic dataset', () => {
        expect(isCityDataLoaded()).toBe(true);
    });

    it('matches ASCII name prefix, ordered by population', () => {
        const r = searchCities('san', 10);
        expect(r.map(x => x.shortLabel)).toEqual(['San Jose', 'San Francisco']);
    });

    it('ranks an exact name match first', () => {
        const r = searchCities('san francisco', 10);
        expect(r[0].shortLabel).toBe('San Francisco');
    });

    it('builds "City (County), State, Country" labels', () => {
        const r = searchCities('san jose', 10);
        expect(r[0].label).toBe('San Jose (Santa Clara County), California, US');
    });

    it('matches via alternate names (München → "munchen")', () => {
        const r = searchCities('munchen', 10);
        expect(r.map(x => x.shortLabel)).toContain('Munich');
        const munich = r.find(x => x.shortLabel === 'Munich')!;
        expect(munich.label).toBe('Munich, Bavaria, DE');
    });

    it('does not match alt substrings that cross an entry boundary', () => {
        // "uenchen" appears only inside "muenchen", not at a comma/newline
        // boundary, so it must not register as a prefix match.
        expect(searchCities('uenchen', 10)).toHaveLength(0);
    });

    it('matches IATA airport codes', () => {
        const r = searchCities('sfo', 10);
        expect(r[0].isAirport).toBe(true);
        expect(r[0].label).toContain('SFO');
        expect(r[0].timezone).toBe('America/Los_Angeles');
    });

    it('decodes coordinates and timezone exactly', () => {
        const sf = searchCities('san francisco', 10).find(x => x.shortLabel === 'San Francisco')!;
        expect(sf.lat).toBeCloseTo(37.774, 3);
        expect(sf.lon).toBeCloseTo(-122.419, 3);
        expect(sf.timezone).toBe('America/Los_Angeles');
    });

    it('findClosestCity returns the nearest city', () => {
        const c = findClosestCity(37.78, -122.42);
        expect(c?.shortLabel).toBe('San Francisco');
        expect(c?.distanceDeg).toBeGreaterThanOrEqual(0);
        const c2 = findClosestCity(48.1, 11.6);
        expect(c2?.shortLabel).toBe('Munich');
    });
});
