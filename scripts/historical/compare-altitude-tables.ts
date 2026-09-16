/**
 * Compare our Int16 altitude table with the iOS-generated Float32 table.
 *
 * Usage: npx tsx scripts/historical/compare-altitude-tables.ts
 *
 * Reads:
 *   - src/observatory/data/altitude-table.bin  (our Int16 table, 696,900 bytes)
 *   - .esastro-ref/Resources/SunAltitudeData-ss101-lat150-alt23-9.dat  (iOS Float32, 1,393,800 bytes)
 *
 * Reports:
 *   - Max absolute difference between the two tables (in radians and degrees)
 *   - Number of entries with significant differences
 *   - Summary statistics
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const SS_SLOTS = 101;
const LAT_SLOTS = 150;
const ALT_SLOTS = 23;
const TOTAL_ENTRIES = SS_SLOTS * LAT_SLOTS * ALT_SLOTS;

// Read our Int16 table
const ourPath = resolve('src/observatory/data/altitude-table.bin');
const ourBytes = readFileSync(ourPath);
const ourInt16 = new Int16Array(ourBytes.buffer, ourBytes.byteOffset, ourBytes.byteLength / 2);

// Decode Int16 → Float32
const ourFloat = new Float32Array(ourInt16.length);
const INT16_DECODE = Math.PI / 32767;
for (let i = 0; i < ourInt16.length; i++) {
    ourFloat[i] = ourInt16[i] * INT16_DECODE;
}

// Read the iOS Float32 table
const iosPath = resolve('.esastro-ref/Resources/SunAltitudeData-ss101-lat150-alt23-9.dat');
const iosBytes = readFileSync(iosPath);
const iosFloat = new Float32Array(iosBytes.buffer, iosBytes.byteOffset, iosBytes.byteLength / 4);

console.log(`Our table:  ${ourInt16.length} entries (${ourBytes.byteLength} bytes, Int16)`);
console.log(`iOS table:  ${iosFloat.length} entries (${iosBytes.byteLength} bytes, Float32)`);
console.log(`Expected:   ${TOTAL_ENTRIES} entries`);
console.log();

if (ourInt16.length !== TOTAL_ENTRIES) {
    console.error(`ERROR: Our table has ${ourInt16.length} entries, expected ${TOTAL_ENTRIES}`);
    process.exit(1);
}
if (iosFloat.length !== TOTAL_ENTRIES) {
    console.error(`ERROR: iOS table has ${iosFloat.length} entries, expected ${TOTAL_ENTRIES}`);
    process.exit(1);
}

// Compare
let maxDiff = 0;
let maxDiffIdx = 0;
let sumDiff = 0;
let numDiffs = 0;
const THRESHOLD_RAD = 0.001;  // ~0.057°

for (let i = 0; i < TOTAL_ENTRIES; i++) {
    const diff = Math.abs(ourFloat[i] - iosFloat[i]);
    sumDiff += diff;
    if (diff > THRESHOLD_RAD) numDiffs++;
    if (diff > maxDiff) {
        maxDiff = diff;
        maxDiffIdx = i;
    }
}

const avgDiff = sumDiff / TOTAL_ENTRIES;

// Decode worst-case index
const ssIdx = Math.floor(maxDiffIdx / (LAT_SLOTS * ALT_SLOTS));
const latIdx = Math.floor((maxDiffIdx % (LAT_SLOTS * ALT_SLOTS)) / ALT_SLOTS);
const altIdx = maxDiffIdx % ALT_SLOTS;

console.log('=== Comparison Results ===');
console.log(`Max difference:     ${maxDiff.toFixed(6)} rad (${(maxDiff * 180 / Math.PI).toFixed(4)}°)`);
console.log(`  at ss=${ssIdx}, lat=${latIdx}, alt=${altIdx}`);
console.log(`  our value:  ${ourFloat[maxDiffIdx].toFixed(6)} rad`);
console.log(`  iOS value:  ${iosFloat[maxDiffIdx].toFixed(6)} rad`);
console.log(`Avg difference:     ${avgDiff.toFixed(8)} rad (${(avgDiff * 180 / Math.PI).toFixed(6)}°)`);
console.log(`Entries > ${THRESHOLD_RAD} rad: ${numDiffs} / ${TOTAL_ENTRIES} (${(numDiffs / TOTAL_ENTRIES * 100).toFixed(2)}%)`);
console.log();

// Int16 quantization error (theoretical max)
const quantMax = Math.PI / 32767 / 2;
console.log(`Int16 quantization max error: ${quantMax.toFixed(8)} rad (${(quantMax * 180 / Math.PI).toFixed(6)}°)`);

// Spot check some specific entries for manual verification
console.log();
console.log('=== Spot Checks (equinox sslat=0, various latitudes) ===');
console.log('ss  lat  alt  | our (rad)    | iOS (rad)    | diff (rad)');
console.log('---  ---  --- | ------------ | ------------ | ------------');

for (const ss of [0, 50, 100]) {
    for (const lat of [0, 37, 75, 149]) {
        for (const alt of [0, 11, 22]) {
            const idx = ss * LAT_SLOTS * ALT_SLOTS + lat * ALT_SLOTS + alt;
            const o = ourFloat[idx];
            const ios = iosFloat[idx];
            const d = Math.abs(o - ios);
            console.log(`${String(ss).padStart(3)}  ${String(lat).padStart(3)}  ${String(alt).padStart(3)} | ${o.toFixed(8).padStart(12)} | ${ios.toFixed(8).padStart(12)} | ${d.toFixed(8).padStart(12)}`);
        }
    }
}
