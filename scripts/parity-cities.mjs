#!/usr/bin/env node
/**
 * One-shot parity check: old (v1 array-of-arrays, from git HEAD) vs new
 * (v2 columnar, on disk) city search. Run before committing the v2 cities DB.
 *
 *   node scripts/parity-cities.mjs
 *
 * Compares searchCities() result SETS (must be identical; uses a large limit to
 * remove top-N cutoff sensitivity) and reports ordering deltas separately (the
 * original-name fold intentionally shifts a few matches from priority 2 -> 3).
 * Also compares findClosestCity() over a global lat/lon grid (must be identical).
 */
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Load both data files (each is an IIFE that assigns window.ChronometerCities)
// ---------------------------------------------------------------------------
function loadCitiesFile(jsText) {
    const window = {};
    // eslint-disable-next-line no-new-func
    new Function('window', jsText)(window);
    return window.ChronometerCities;
}

const v1 = loadCitiesFile(execSync('git show HEAD:src/cities-data.js', { maxBuffer: 1 << 30 }).toString('utf-8'));
const v2raw = loadCitiesFile(readFileSync('src/cities-data.js', 'utf-8'));

if (!v1 || v1.v === 2) { console.error('git HEAD cities-data.js is not v1; nothing to compare.'); process.exit(1); }
if (!v2raw || v2raw.v !== 2) { console.error('on-disk cities-data.js is not v2.'); process.exit(1); }

function toASCII(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// OLD implementation (verbatim port of pre-change city-search.ts)
// ---------------------------------------------------------------------------
const oTZ = v1.TZ, oCC = v1.CC, oAD = v1.AD, oCITIES = v1.CITIES, oAIRPORTS = v1.AIRPORTS;
const C_NAME = 0, C_ASCII = 1, C_CC = 2, C_AD1 = 3, C_LAT = 4, C_LON = 5, C_TZ = 6, C_POP = 7, C_ALT = 8, C_AD2 = 9;
const A_IATA = 0, A_CITY = 1, A_LAT = 2, A_LON = 3, A_TZ = 4;

function oldSearch(query, limit) {
    if (!query || query.length < 2) return [];
    const q = toASCII(query.trim());
    if (!q) return [];
    const qUpper = query.trim().toUpperCase();
    const results = [];
    for (const a of oAIRPORTS) {
        const iata = a[A_IATA];
        if (iata.startsWith(qUpper) || iata === qUpper) {
            results.push({ result: { label: `${iata}  ${a[A_CITY]} airport`, lat: a[A_LAT], lon: a[A_LON], isAirport: true }, priority: iata === qUpper ? 0 : 1, pop: 0 });
        }
    }
    for (const c of oCITIES) {
        const asciiName = c[C_ASCII], name = c[C_NAME], pop = c[C_POP];
        let matched = false, priority = 3;
        if (asciiName.startsWith(q)) { matched = true; priority = asciiName === q ? 0 : 1; }
        if (!matched) {
            const nameLower = name.toLowerCase();
            if (nameLower.startsWith(q) || toASCII(name).startsWith(q)) { matched = true; priority = 2; }
        }
        if (!matched && c[C_ALT]) {
            const alts = c[C_ALT];
            if (alts.includes(q)) {
                for (const alt of alts.split(',')) { if (alt.startsWith(q)) { matched = true; priority = 3; break; } }
            }
        }
        if (matched) {
            const cc = oCC[c[C_CC]] || '', admin1 = oAD[c[C_AD1]] || '';
            let label = name;
            if (c[C_AD2]) label += ` (${c[C_AD2]})`;
            if (admin1) label += `, ${admin1}`;
            if (cc) label += `, ${cc}`;
            results.push({ result: { label, lat: c[C_LAT], lon: c[C_LON], isAirport: false }, priority, pop });
        }
    }
    results.sort((a, b) => (a.priority !== b.priority) ? a.priority - b.priority : b.pop - a.pop);
    return results.slice(0, limit).map(r => r.result);
}

function oldClosest(lat, lon) {
    let bestDist = Infinity, bestIdx = -1;
    const cosLat = Math.cos(lat * Math.PI / 180);
    for (let i = 0; i < oCITIES.length; i++) {
        const dLat = oCITIES[i][C_LAT] - lat, dLon = (oCITIES[i][C_LON] - lon) * cosLat;
        const d = dLat * dLat + dLon * dLon;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx < 0) return null;
    const c = oCITIES[bestIdx];
    return { label: c[C_NAME], lat: c[C_LAT], lon: c[C_LON] };
}

// ---------------------------------------------------------------------------
// NEW implementation (mirror of post-change city-search.ts)
// ---------------------------------------------------------------------------
function b64ToBytes(s) { return Uint8Array.from(Buffer.from(s, 'base64')); }
function decI32(s) { const b = b64ToBytes(s); return new Int32Array(b.buffer, b.byteOffset, b.byteLength >> 2); }
function decU32(s) { const b = b64ToBytes(s); return new Uint32Array(b.buffer, b.byteOffset, b.byteLength >> 2); }
function decU16(s) { const b = b64ToBytes(s); return new Uint16Array(b.buffer, b.byteOffset, b.byteLength >> 1); }
function buildOffsets(str, rows) {
    const off = new Uint32Array(rows + 1);
    let r = 1, pos = str.indexOf('\n');
    while (pos !== -1) { off[r++] = pos + 1; pos = str.indexOf('\n', pos + 1); }
    off[rows] = str.length + 1;
    return off;
}
function rowStr(str, off, i) { return str.slice(off[i], off[i + 1] - 1); }
function rowLen(off, i) { return off[i + 1] - 1 - off[i]; }
function startsWithAt(h, start, q) { for (let k = 0; k < q.length; k++) if (h.charCodeAt(start + k) !== q.charCodeAt(k)) return false; return true; }
function rowOfOffset(off, pos) { let lo = 0, hi = off.length - 2; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (off[m] <= pos) lo = m; else hi = m - 1; } return lo; }

const nTZ = v2raw.TZ, nCC = v2raw.CC, nAD = v2raw.AD, N = v2raw.N, aN = v2raw.aN;
const cLat = decI32(v2raw.cLat), cLon = decI32(v2raw.cLon), cPop = decU32(v2raw.cPop);
const cTz = decU16(v2raw.cTz), cCc = decU16(v2raw.cCc), cAd1 = decU16(v2raw.cAd1);
const names = v2raw.names, ascii = v2raw.ascii, alts = v2raw.alts;
const nameOff = buildOffsets(names, N), asciiOff = buildOffsets(ascii, N), altOff = buildOffsets(alts, N);
const ad2 = new Map(); for (const k in v2raw.ad2) ad2.set(+k, v2raw.ad2[k]);
const aLat = decI32(v2raw.aLat), aLon = decI32(v2raw.aLon), aTz = decU16(v2raw.aTz);
const aIata = v2raw.aIata, aCity = v2raw.aCity;
const aIataOff = buildOffsets(aIata, aN), aCityOff = buildOffsets(aCity, aN);

function cityLabel(i, name) {
    let label = name;
    const a2 = ad2.get(i); if (a2) label += ` (${a2})`;
    const admin1 = nAD[cAd1[i]] || ''; if (admin1) label += `, ${admin1}`;
    const cc = nCC[cCc[i]] || ''; if (cc) label += `, ${cc}`;
    return label;
}
function newSearch(query, limit) {
    if (!query || query.length < 2) return [];
    const q = toASCII(query.trim());
    if (!q) return [];
    const qUpper = query.trim().toUpperCase();
    const results = [];
    for (let i = 0; i < aN; i++) {
        if (!startsWithAt(aIata, aIataOff[i], qUpper)) continue;
        const iata = rowStr(aIata, aIataOff, i), city = rowStr(aCity, aCityOff, i);
        results.push({ result: { label: `${iata}  ${city} airport`, lat: aLat[i] / 1000, lon: aLon[i] / 1000, isAirport: true }, priority: rowLen(aIataOff, i) === qUpper.length ? 0 : 1, pop: 0 });
    }
    const matched = new Set();
    for (let i = 0; i < N; i++) {
        if (!startsWithAt(ascii, asciiOff[i], q)) continue;
        matched.add(i);
        const name = rowStr(names, nameOff, i);
        results.push({ result: { label: cityLabel(i, name), lat: cLat[i] / 1000, lon: cLon[i] / 1000, isAirport: false }, priority: rowLen(asciiOff, i) === q.length ? 0 : 1, pop: cPop[i] });
    }
    let pos = alts.indexOf(q);
    while (pos >= 0) {
        const prev = pos === 0 ? 10 : alts.charCodeAt(pos - 1);
        if (prev === 10 || prev === 44) {
            const i = rowOfOffset(altOff, pos);
            if (!matched.has(i)) {
                matched.add(i);
                const name = rowStr(names, nameOff, i);
                results.push({ result: { label: cityLabel(i, name), lat: cLat[i] / 1000, lon: cLon[i] / 1000, isAirport: false }, priority: 3, pop: cPop[i] });
            }
        }
        pos = alts.indexOf(q, pos + 1);
    }
    results.sort((a, b) => (a.priority !== b.priority) ? a.priority - b.priority : b.pop - a.pop);
    return results.slice(0, limit).map(r => r.result);
}
function newClosest(lat, lon) {
    let bestDist = Infinity, bestIdx = -1;
    const cosLat = Math.cos(lat * Math.PI / 180);
    for (let i = 0; i < N; i++) {
        const dLat = cLat[i] / 1000 - lat, dLon = (cLon[i] / 1000 - lon) * cosLat;
        const d = dLat * dLat + dLon * dLon;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx < 0) return null;
    return { label: rowStr(names, nameOff, bestIdx), lat: cLat[bestIdx] / 1000, lon: cLon[bestIdx] / 1000 };
}

// ---------------------------------------------------------------------------
// Build query battery
// ---------------------------------------------------------------------------
const curated = ['san', 'new', 'los', 'munich', 'münchen', 'peking', 'beijing', 'tokyo', '東京', 'sfo', 'lax', 'jfk',
    'paris', 'koln', 'köln', 'cologne', 'sao', 'são', 'moscow', 'москва', 'zurich', 'zürich', 'delhi', 'mumbai',
    'shanghai', '上海', 'seoul', '서울', 'cairo', 'القاهرة', 'springfield', 'cambridge', 'a', 'ab', 'xy', 'zz', 'aa'];

const prefixes = new Set(curated);
// Sample prefixes from the top-population cities' ascii names + alt names.
for (let i = 0; i < Math.min(N, 4000); i++) {
    const a = rowStr(ascii, asciiOff, i);
    if (a.length >= 2) prefixes.add(a.slice(0, 2));
    if (a.length >= 3) prefixes.add(a.slice(0, 3));
    if (a.length >= 4) prefixes.add(a.slice(0, 4));
    prefixes.add(a);
    const al = rowStr(alts, altOff, i);
    if (al) { const first = al.split(',')[0]; if (first.length >= 3) prefixes.add(first.slice(0, 3)); }
}
const queries = [...prefixes];
console.log(`Testing ${queries.length} queries...`);

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------
const LIMIT = 500;  // large enough that top-N cutoff doesn't hide set diffs
const key = r => `${r.isAirport ? 'A' : 'C'}|${r.label}|${r.lat}|${r.lon}`;

let setMismatch = 0, orderDelta = 0;
const sampleDiffs = [];
for (const query of queries) {
    const oldR = oldSearch(query, LIMIT), newR = newSearch(query, LIMIT);
    const oldKeys = oldR.map(key), newKeys = newR.map(key);
    const oldSet = new Set(oldKeys), newSet = new Set(newKeys);
    const missing = oldKeys.filter(k => !newSet.has(k));
    const extra = newKeys.filter(k => !oldSet.has(k));
    if (missing.length || extra.length) {
        setMismatch++;
        if (sampleDiffs.length < 15) sampleDiffs.push({ query, missing: missing.slice(0, 4), extra: extra.slice(0, 4) });
    } else if (oldKeys.join('\n') !== newKeys.join('\n')) {
        orderDelta++;
    }
}

console.log(`\n=== searchCities (limit ${LIMIT}) ===`);
console.log(`  set mismatches: ${setMismatch} / ${queries.length}`);
console.log(`  order-only deltas: ${orderDelta} / ${queries.length}`);
if (sampleDiffs.length) {
    console.log('  sample set mismatches:');
    for (const d of sampleDiffs) console.log(`    "${d.query}"  missing=${JSON.stringify(d.missing)}  extra=${JSON.stringify(d.extra)}`);
}

// findClosestCity over a global grid
let closestMismatch = 0;
const closestSamples = [];
let gridCount = 0;
for (let lat = -85; lat <= 85; lat += 5) {
    for (let lon = -180; lon < 180; lon += 5) {
        gridCount++;
        const o = oldClosest(lat, lon), n = newClosest(lat, lon);
        if (!o || !n || o.label !== n.label || o.lat !== n.lat || o.lon !== n.lon) {
            closestMismatch++;
            if (closestSamples.length < 10) closestSamples.push({ lat, lon, old: o, new: n });
        }
    }
}
console.log(`\n=== findClosestCity (${gridCount} grid points) ===`);
console.log(`  mismatches: ${closestMismatch}`);
for (const s of closestSamples) console.log(`    (${s.lat},${s.lon}) old=${JSON.stringify(s.old)} new=${JSON.stringify(s.new)}`);

console.log(`\n${setMismatch === 0 && closestMismatch === 0 ? 'PARITY OK (order deltas are expected from the original-name fold)' : 'PARITY FAILED'}`);
process.exit(setMismatch === 0 && closestMismatch === 0 ? 0 : 1);
