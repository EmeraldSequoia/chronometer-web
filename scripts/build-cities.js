#!/usr/bin/env node
/**
 * Build script: process GeoNames data into a compact JS module for the city picker.
 *
 * Input files (in scripts/geonames-data/):
 *   - cities1000.txt        — main city data
 *   - admin1CodesASCII.txt  — state/province name lookup
 *   - admin2Codes.txt       — county/district name lookup (disambiguation)
 *   - alternateNamesV2.txt  — IATA airport codes
 *   - allCountries.txt      — airport coordinates (for airports not in cities1000)
 *
 * Additional input:
 *   - src/extra-cities.ts   — user-defined custom cities merged into the database
 *
 * Output:
 *   - src/cities-data.js    — compact JS module with city + airport data
 */

import { readFileSync, writeFileSync, createReadStream, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createInterface } from 'readline';
import esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'geonames-data');
const OUT_FILE = join(__dirname, '..', 'src', 'cities-data.js');
const EXTRA_SRC = join(__dirname, '..', 'src', 'extra-cities.ts');

// ---------------------------------------------------------------------------
// Preflight: all inputs must exist (no silent fallbacks)
// ---------------------------------------------------------------------------

if (!existsSync(EXTRA_SRC)) {
    console.error(`ERROR: ${EXTRA_SRC} not found — it is a required input.`);
    process.exit(1);
}

const REQUIRED_DATA_FILES = [
    'cities1000.txt',
    'admin1CodesASCII.txt',
    'admin2Codes.txt',
    'alternateNamesV2.txt',
    'allCountries.txt',
];
const missingFiles = REQUIRED_DATA_FILES.filter(f => !existsSync(join(DATA_DIR, f)));
if (missingFiles.length > 0) {
    console.error(`ERROR: missing GeoNames data files in ${DATA_DIR}:`);
    for (const f of missingFiles) console.error(`  - ${f}`);
    console.error('Download from https://download.geonames.org/export/dump/');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readTSV(filename) {
    const path = join(DATA_DIR, filename);
    console.log(`Reading ${filename}...`);
    const text = readFileSync(path, 'utf-8');
    return text.split('\n').filter(line => line && !line.startsWith('#'));
}

function toASCII(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Stream a large file line-by-line without loading it all into memory. */
async function forEachLine(filename, callback) {
    const path = join(DATA_DIR, filename);
    console.log(`Streaming ${filename}...`);
    const rl = createInterface({
        input: createReadStream(path, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
    });
    let count = 0;
    for await (const line of rl) {
        if (!line || line.startsWith('#')) continue;
        count++;
        const stop = callback(line, count);
        if (stop === true) { rl.close(); break; }
    }
    return count;
}

// ---------------------------------------------------------------------------
// 1. Parse admin1 codes
// ---------------------------------------------------------------------------

console.log('=== Phase 1: Admin1 codes ===');
const admin1Map = new Map();  // "CC.admin1code" -> "State Name"
for (const line of readTSV('admin1CodesASCII.txt')) {
    const parts = line.split('\t');
    if (parts.length >= 2) {
        admin1Map.set(parts[0], parts[1]);  // e.g. "US.CA" -> "California"
    }
}
console.log(`  ${admin1Map.size} admin1 codes loaded`);

// Also load admin2 codes for disambiguation
const admin2Map = new Map();  // "CC.admin1.admin2" -> "County Name"
for (const line of readTSV('admin2Codes.txt')) {
    const parts = line.split('\t');
    if (parts.length >= 2) {
        admin2Map.set(parts[0], parts[1]);  // e.g. "US.CA.085" -> "Santa Clara County"
    }
}
console.log(`  ${admin2Map.size} admin2 codes loaded`);

// ---------------------------------------------------------------------------
// 2. Parse cities1000
// ---------------------------------------------------------------------------

console.log('=== Phase 2: Cities ===');
const cities = [];
const cityById = new Map();

for (const line of readTSV('cities1000.txt')) {
    const f = line.split('\t');
    if (f.length < 18) continue;

    const geonameid = f[0];
    const name = f[1];
    const asciiname = f[2];
    const alternatenames = f[3];  // comma-separated
    const lat = parseFloat(f[4]);
    const lon = parseFloat(f[5]);
    const countryCode = f[8];
    const admin1Code = f[10];
    const admin2Code = f[11];
    const population = parseInt(f[14], 10) || 0;
    const timezone = f[17];

    const admin1Key = `${countryCode}.${admin1Code}`;
    const admin1Name = admin1Map.get(admin1Key) || admin1Code || '';

    // Resolve admin2 code to name
    const admin2Key = `${countryCode}.${admin1Code}.${admin2Code}`;
    const admin2Name = admin2Map.get(admin2Key) || admin2Code || '';

    const city = {
        geonameid,
        name,
        asciiname: asciiname.toLowerCase(),
        alternatenames,
        lat: Math.round(lat * 1000) / 1000,
        lon: Math.round(lon * 1000) / 1000,
        countryCode,
        admin1Name,
        admin2Name,
        population,
        timezone,
    };
    cities.push(city);
    cityById.set(geonameid, city);
}
console.log(`  ${cities.length} cities loaded`);

// ---------------------------------------------------------------------------
// 2b. Extra cities (src/extra-cities.ts)
// ---------------------------------------------------------------------------

console.log('=== Phase 2b: Extra cities ===');

const EXTRA_TEMP = join(__dirname, 'extra-cities-temp.js');
let extraCities;
try {
    esbuild.buildSync({
        entryPoints: [EXTRA_SRC],
        outfile: EXTRA_TEMP,
        format: 'esm',
        platform: 'node',
    });
    ({ extraCities } = await import(pathToFileURL(EXTRA_TEMP).href));
} finally {
    if (existsSync(EXTRA_TEMP)) unlinkSync(EXTRA_TEMP);
}

function failExtra(i, name, msg) {
    console.error(`ERROR: src/extra-cities.ts entry ${i} (${JSON.stringify(name)}): ${msg}`);
    process.exit(1);
}

for (let i = 0; i < extraCities.length; i++) {
    const e = extraCities[i];
    if (typeof e.name !== 'string' || !e.name || e.name.includes('\n')) {
        failExtra(i, e.name, 'name must be a non-empty string without newlines');
    }
    if (!(e.latitude >= -90 && e.latitude <= 90)) {
        failExtra(i, e.name, `latitude out of range: ${e.latitude}`);
    }
    if (!(e.longitude >= -180 && e.longitude <= 180)) {
        failExtra(i, e.name, `longitude out of range: ${e.longitude}`);
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: e.olsonTimezone });
    } catch {
        failExtra(i, e.name, `unknown olsonTimezone: ${JSON.stringify(e.olsonTimezone)}`);
    }
    if (!/^[A-Z]{2}$/.test(e.countryCode)) {
        failExtra(i, e.name, `countryCode must be two uppercase letters: ${JSON.stringify(e.countryCode)}`);
    }
    for (const field of ['admin1Name', 'admin2Name']) {
        if (e[field] !== undefined && (typeof e[field] !== 'string' || e[field].includes('\n'))) {
            failExtra(i, e.name, `${field} must be a string without newlines`);
        }
    }
    if (!Number.isInteger(e.population) || e.population < 0) {
        failExtra(i, e.name, `population must be a non-negative integer: ${e.population}`);
    }

    const lat = Math.round(e.latitude * 1000) / 1000;
    const lon = Math.round(e.longitude * 1000) / 1000;
    cities.push({
        geonameid: `extra-${toASCII(e.name)}-${lat}-${lon}`,
        name: e.name,
        asciiname: toASCII(e.name),
        alternatenames: '',
        lat,
        lon,
        countryCode: e.countryCode,
        admin1Name: e.admin1Name ?? '',
        admin2Name: e.admin2Name ?? '',
        population: e.population,
        timezone: e.olsonTimezone,
    });
}
console.log(`  ${extraCities.length} extra cities appended`);

// ---------------------------------------------------------------------------
// 3. Detect duplicates needing admin2 disambiguation
// ---------------------------------------------------------------------------

console.log('=== Phase 3: Duplicate detection ===');
const groupKey = (c) => `${c.name}|${c.countryCode}|${c.admin1Name}`;
const groups = new Map();
for (const c of cities) {
    const key = groupKey(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
}

// For groups with >1 entry and different admin2 codes, mark them
let disambiguated = 0;
for (const [, group] of groups) {
    if (group.length > 1) {
        const admin2s = new Set(group.map(c => c.admin2Name));
        if (admin2s.size > 1) {
            // Need admin2 for disambiguation
            for (const c of group) {
                c.needsAdmin2 = true;
            }
            disambiguated += group.length;
        }
    }
}
console.log(`  ${disambiguated} cities need admin2 disambiguation`);

// ---------------------------------------------------------------------------
// 4. Parse IATA codes from alternateNamesV2
// ---------------------------------------------------------------------------

console.log('=== Phase 4: IATA codes ===');
const iataByGeonameid = new Map();  // geonameid -> [iata1, iata2, ...]

await forEachLine('alternateNamesV2.txt', (line, count) => {
    if (count % 5000000 === 0) console.log(`    ...${(count / 1000000).toFixed(0)}M lines`);
    const f = line.split('\t');
    if (f.length < 4 || f[2] !== 'iata') return;
    const geonameid = f[1];
    const iataCode = f[3].trim().toUpperCase();
    if (iataCode.length < 2 || iataCode.length > 4) return;

    if (!iataByGeonameid.has(geonameid)) {
        iataByGeonameid.set(geonameid, []);
    }
    iataByGeonameid.get(geonameid).push(iataCode);
});
console.log(`  ${iataByGeonameid.size} geonameids with IATA codes`);

// ---------------------------------------------------------------------------
// 5. Load airport coordinates from allCountries (for airports not in cities1000)
// ---------------------------------------------------------------------------

console.log('=== Phase 5: Airport coordinates ===');

// Determine which geonameids we need from allCountries
const neededIds = new Set();
for (const [gid] of iataByGeonameid) {
    if (!cityById.has(gid)) {
        neededIds.add(gid);
    }
}
console.log(`  ${neededIds.size} airport geonameids need coordinates from allCountries`);

const airportFeatures = new Map();  // geonameid -> {name, lat, lon, countryCode, timezone}

await forEachLine('allCountries.txt', (line, count) => {
    if (count % 2000000 === 0) {
        console.log(`    ...${(count / 1000000).toFixed(0)}M lines, found ${airportFeatures.size} airports, ${neededIds.size} remaining`);
    }

    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) return;
    const gid = line.slice(0, tabIdx);
    if (!neededIds.has(gid)) return;

    const f = line.split('\t');
    if (f.length < 18) return;

    airportFeatures.set(gid, {
        name: f[1],
        lat: Math.round(parseFloat(f[4]) * 1000) / 1000,
        lon: Math.round(parseFloat(f[5]) * 1000) / 1000,
        countryCode: f[8],
        timezone: f[17],
    });

    neededIds.delete(gid);
    if (neededIds.size === 0) return true;  // stop early
});
console.log(`  ${airportFeatures.size} airport features loaded`);
if (neededIds.size > 0) {
    console.log(`  WARNING: ${neededIds.size} airport geonameids not found in allCountries`);
}

// ---------------------------------------------------------------------------
// 6. Build airport entries
// ---------------------------------------------------------------------------

console.log('=== Phase 6: Building airport entries ===');
const airports = [];

for (const [gid, iataCodes] of iataByGeonameid) {
    // Try to find the associated city
    const city = cityById.get(gid);
    const airport = city ? null : airportFeatures.get(gid);

    if (!city && !airport) continue;  // skip if we can't find coordinates

    const lat = city ? city.lat : airport.lat;
    const lon = city ? city.lon : airport.lon;
    const tz = city ? city.timezone : airport.timezone;
    const cc = city ? city.countryCode : airport.countryCode;

    // Find the nearest city name for display
    let displayCity = city ? city.name : airport.name;
    // Clean up the airport name — often it's "City Airport" or "City International Airport"
    // Use the closest large city's name (weighted by population)
    if (!city) {
        // Score: lower is better. Distance penalized, large population rewarded.
        // Using population directly as divisor (not log) so NYC (8M) dominates over
        // Springfield Gardens (25K) even though it's a bit farther.
        let bestScore = Infinity;
        let nearestName = airport.name.replace(/\s+(International\s+)?Airport$/i, '');
        for (const c of cities) {
            if (c.countryCode !== cc) continue;
            const dlat = c.lat - lat;
            const dlon = c.lon - lon;
            const distSq = dlat * dlat + dlon * dlon;
            // Only consider cities within ~1 degree (~100 km)
            if (distSq > 1) continue;
            const score = distSq / Math.max(c.population, 1);
            if (score < bestScore) {
                bestScore = score;
                nearestName = c.name;
            }
        }
        displayCity = nearestName;
    }

    for (const iata of iataCodes) {
        airports.push({
            iata,
            displayCity,
            lat,
            lon,
            timezone: tz,
            countryCode: cc,
        });
    }
}
console.log(`  ${airports.length} airport entries created`);

// ---------------------------------------------------------------------------
// 7. Build lookup tables
// ---------------------------------------------------------------------------

console.log('=== Phase 7: Lookup tables ===');

// Timezone lookup
const tzSet = new Set();
for (const c of cities) tzSet.add(c.timezone);
for (const a of airports) tzSet.add(a.timezone);
const tzList = [...tzSet].sort();
const tzIndex = new Map();
tzList.forEach((tz, i) => tzIndex.set(tz, i));
console.log(`  ${tzList.length} unique timezones`);

// Country code lookup
const ccSet = new Set();
for (const c of cities) ccSet.add(c.countryCode);
for (const a of airports) ccSet.add(a.countryCode);
const ccList = [...ccSet].sort();
const ccIndex = new Map();
ccList.forEach((cc, i) => ccIndex.set(cc, i));
console.log(`  ${ccList.length} unique country codes`);

// Admin1 name lookup
const adSet = new Set();
for (const c of cities) adSet.add(c.admin1Name);
const adList = [...adSet].sort();
const adIndex = new Map();
adList.forEach((ad, i) => adIndex.set(ad, i));
console.log(`  ${adList.length} unique admin1 names`);

// ---------------------------------------------------------------------------
// 8. Sort cities by population descending
// ---------------------------------------------------------------------------

cities.sort((a, b) => b.population - a.population);

// ---------------------------------------------------------------------------
// 9. Build columnar output (format v2)
// ---------------------------------------------------------------------------
//
// Instead of 167k array-of-arrays (which JSON.parse explodes into ~45 MB of
// per-object heap), we emit parallel columns: numeric fields as base64-packed
// little-endian typed-array buffers, and text fields as single newline-joined
// strings sliced on demand at runtime. See planning/2026-06-13-observatory-
// cities-columnar.md and src/shared/city-search.ts for the consumer.

console.log('=== Phase 9: Building columns ===');

const DELIM = '\n';

function assertNoDelim(s, what, i) {
    if (s.indexOf(DELIM) !== -1) {
        throw new Error(`Field contains newline delimiter (${what} @ row ${i}): ${JSON.stringify(s.slice(0, 80))}`);
    }
}

// Pack a typed array as base64 of its raw little-endian bytes. Node runs on
// little-endian hosts; the runtime decoder byte-swaps only on big-endian.
function packB64(typedArr) {
    return Buffer.from(typedArr.buffer, typedArr.byteOffset, typedArr.byteLength).toString('base64');
}

// ── City columns ──
const N = cities.length;
const cLat = new Int32Array(N);   // round(deg * 1000) — exact to 3 decimals
const cLon = new Int32Array(N);
const cPop = new Uint32Array(N);
const cTz = new Uint16Array(N);   // index into TZ
const cCc = new Uint16Array(N);   // index into CC
const cAd1 = new Uint16Array(N);  // index into AD
const nameParts = new Array(N);
const asciiParts = new Array(N);
const altParts = new Array(N);
const ad2 = {};                   // sparse: rowIndex -> county name

let foldedAdded = 0;
for (let i = 0; i < N; i++) {
    const c = cities[i];
    cLat[i] = Math.round(c.lat * 1000);
    cLon[i] = Math.round(c.lon * 1000);
    cPop[i] = c.population;
    cTz[i] = tzIndex.get(c.timezone);
    cCc[i] = ccIndex.get(c.countryCode);
    cAd1[i] = adIndex.get(c.admin1Name);

    // Filtered alt names: keep variants whose ASCII-folded form starts
    // differently from the primary name (prefix search on asciiname already
    // handles same-prefix variants).
    const primaryAscii = c.asciiname;  // already lowercase
    const prefix3 = primaryAscii.substring(0, 3);
    const seen = new Set([primaryAscii]);
    const useful = [];
    if (c.alternatenames) {
        for (const alt of c.alternatenames.split(',')) {
            const altAscii = toASCII(alt.trim());
            if (!altAscii || altAscii.length <= 1 || seen.has(altAscii)) continue;
            seen.add(altAscii);
            if (altAscii.substring(0, 3) !== prefix3) {
                useful.push(altAscii);
            }
        }
    }
    // Fold the old "original UTF-8 name" search branch into alts at build time:
    // search previously also matched toASCII(name). Storing it here preserves
    // that recall without a costly per-row fold at query time. (May itself be
    // non-Latin, e.g. CJK — fine.)
    //
    // This deliberately bypasses the prefix3 filter and the `seen` set above:
    // GeoNames asciiname uses ae/oe/ue expansion (e.g. "Stöckheim" → asciiname
    // "stoeckheim"), so toASCII(name) ("stockheim") can share the first 3 chars
    // with asciiname yet diverge later — the asciiname prefix search does NOT
    // cover it, and the prefix3 filter would have dropped it. Dedupe only
    // against the actual output list.
    const foldedName = toASCII(c.name);
    if (foldedName && foldedName.length > 1 && foldedName !== primaryAscii && !useful.includes(foldedName)) {
        useful.push(foldedName);
        foldedAdded++;
    }
    const altStr = useful.join(',');

    assertNoDelim(c.name, 'name', i);
    assertNoDelim(primaryAscii, 'ascii', i);
    assertNoDelim(altStr, 'alts', i);

    nameParts[i] = c.name;
    asciiParts[i] = primaryAscii;
    altParts[i] = altStr;

    if (c.needsAdmin2 && c.admin2Name) ad2[i] = c.admin2Name;
}
console.log(`  ${N} cities, ${foldedAdded} original-name folds added to alts, ${Object.keys(ad2).length} admin2 entries`);

const names = nameParts.join(DELIM);
const ascii = asciiParts.join(DELIM);
const alts = altParts.join(DELIM);

// ── Airport columns (sorted by IATA) ──
const aSorted = airports.slice().sort((a, b) => a.iata.localeCompare(b.iata));
const aN = aSorted.length;
const aLat = new Int32Array(aN);
const aLon = new Int32Array(aN);
const aTz = new Uint16Array(aN);
const aCc = new Uint16Array(aN);
const aIataParts = new Array(aN);
const aCityParts = new Array(aN);
for (let i = 0; i < aN; i++) {
    const a = aSorted[i];
    aLat[i] = Math.round(a.lat * 1000);
    aLon[i] = Math.round(a.lon * 1000);
    aTz[i] = tzIndex.get(a.timezone);
    aCc[i] = ccIndex.get(a.countryCode);
    assertNoDelim(a.iata, 'iata', i);
    assertNoDelim(a.displayCity, 'displayCity', i);
    aIataParts[i] = a.iata;
    aCityParts[i] = a.displayCity;
}
const aIata = aIataParts.join(DELIM);
const aCity = aCityParts.join(DELIM);
console.log(`  ${aN} airports`);

// ---------------------------------------------------------------------------
// 10. Write output
// ---------------------------------------------------------------------------

console.log('=== Phase 10: Writing output ===');

// Numeric columns are base64 typed-array buffers; text columns are big
// newline-joined strings; lookup tables stay as small JSON arrays. Wrapped in
// JSON.parse() of a single string to avoid iOS Safari's recursive-descent
// parser blowing the stack — but note the heavy data is now strings + base64,
// never 167k array literals.
const dataObj = {
    v: 2,
    N, aN,
    TZ: tzList,
    CC: ccList,
    AD: adList,
    ad2,
    cLat: packB64(cLat), cLon: packB64(cLon), cPop: packB64(cPop),
    cTz: packB64(cTz), cCc: packB64(cCc), cAd1: packB64(cAd1),
    names, ascii, alts,
    aLat: packB64(aLat), aLon: packB64(aLon), aTz: packB64(aTz), aCc: packB64(aCc),
    aIata, aCity,
};

// JSON.stringify the data, then embed it as a JS string literal.
// We escape backslashes and single-quotes for the JS string, and use single
// quotes to avoid escaping all the double quotes in JSON. JSON.stringify already
// escapes the newline delimiters (\n), and backslash-doubling preserves them.
const jsonStr = JSON.stringify(dataObj);
const escapedJson = jsonStr
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");

const output = `// Auto-generated by scripts/build-cities.js — do not edit
// Source: GeoNames cities1000 + alternateNamesV2 (CC BY 4.0)
// Generated: ${new Date().toISOString()}
//
// Format v2 (columnar). See planning/2026-06-13-observatory-cities-columnar.md.
//   Numeric columns (cLat,cLon,cPop,cTz,cCc,cAd1,aLat,aLon,aTz,aCc): base64 of
//     raw little-endian typed-array bytes. lat/lon are round(deg*1000) Int32.
//   Text columns (names,ascii,alts,aIata,aCity): newline-joined; row i is the
//     slice between the i-th and (i+1)-th newline.
//   ad2: sparse { rowIndex: countyName } for disambiguated cities.
// Uses JSON.parse to avoid iOS Safari stack overflow on large array literals.

(function() {
  var data = JSON.parse('${escapedJson}');
  window.ChronometerCities = data;
  if (typeof window._chronCitiesCallback === 'function') {
    window._chronCitiesCallback(data);
  }
})();
`;

writeFileSync(OUT_FILE, output, 'utf-8');
const sizeMB = (Buffer.byteLength(output, 'utf-8') / (1024 * 1024)).toFixed(1);
console.log(`  Written to ${OUT_FILE} (${sizeMB} MB)`);
console.log('Done!');

