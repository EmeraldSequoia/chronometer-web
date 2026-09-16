/**
 * Generate the sun altitude lookup table for the Observatory earth view.
 *
 * Port of ESSunAltitudeTable::fillInFromScratch() from
 *   .esastro-ref/src/ESSunAltitudeTable.cpp
 *
 * The table maps (subSolarLatitude, mapLatitude, altitudeThreshold)
 * → longitudeOffset (radians, always >= 0, symmetric about sub-solar meridian).
 *
 * Output format: Int16 fixed-point, stored as value × 32767 / π.
 * Row-major order: [sslatIndex][latIndex][altIndex]
 *
 * Usage:
 *   npx tsx scripts/historical/generate-altitude-table.ts
 *
 * Output:
 *   src/observatory/data/altitude-table.bin
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// Table dimensions — matching ES_LARGE_TABLE in ESSunAltitudeTable.hpp
// ============================================================================

const SS_STEPS = 100;
const SS_SLOTS = SS_STEPS + 1;   // 101

const LAT_STEPS = 149;
const LAT_SLOTS = LAT_STEPS + 1; // 150

const ALT_STEPS = 22;
const ALT_SLOTS = ALT_STEPS + 1; // 23

// Subsolar latitude range: 0 to 24° (negative sslat handled by flipping latitude)
const SS_MAX = 24 * Math.PI / 180;
const SS_MIN = 0;
const SS_RANGE = SS_MAX - SS_MIN;

// Altitude range: 0° to -9° (civil twilight)
const ALT_MAX = 0;
const ALT_MIN_DEGREES = -9;
const ALT_MIN = ALT_MIN_DEGREES * Math.PI / 180;
const ALT_RANGE = ALT_MAX - ALT_MIN;

// Number of parametric points (must be odd so zero is exact)
const NUM_PARAMETRIC_POINTS = 1000001;

// Int16 encoding: value × SCALE = stored int16
const INT16_SCALE = 32767 / Math.PI;

// ============================================================================
// Index↔value conversion macros (matching ESSunAltitudeTable.hpp)
// ============================================================================

function indexToSubsolar(i: number): number {
    return SS_MIN + (i * SS_RANGE / SS_STEPS);
}

function indexToLat(i: number): number {
    return -Math.PI / 2 + (i * Math.PI / LAT_STEPS);
}

function latToIndex(B: number): number {
    return Math.round((B + Math.PI / 2) / Math.PI * LAT_STEPS);
}

function indexToAlt(i: number): number {
    return ALT_MAX - (i * ALT_RANGE / ALT_STEPS);
}

// ============================================================================
// infinityForSSLatAlt — port of .esastro-ref/src/ESSunAltitudeTable.cpp L82–164
// ============================================================================

function infinityForSSLatAlt(
    subSolarLatitude: number,
    latitude: number,
    altitude: number,
): number {
    // altMax = 90° - |lat - sslat| (max solar altitude at this latitude)
    // altMin = -90° + |lat + sslat| (min solar altitude at this latitude)
    const altMax = Math.PI / 2 - Math.abs(latitude - subSolarLatitude);
    const altMin = -Math.PI / 2 + Math.abs(latitude + subSolarLatitude);

    if (altitude > altMax - 0.0001) {
        // Sun never gets up this high at this latitude → polar winter → always night
        return 0;
    } else if (altitude < altMin + 0.0001) {
        // Sun never gets down this low at this latitude → polar summer → always day
        return Math.PI;
    } else {
        // Should not happen — the parametric curve should have covered this case
        throw new Error(
            `infinityForSSLatAlt: unexpected case ` +
            `altMax=${(altMax * 180 / Math.PI).toFixed(2)}, ` +
            `altMin=${(altMin * 180 / Math.PI).toFixed(2)}, ` +
            `alt=${(altitude * 180 / Math.PI).toFixed(2)}, ` +
            `lat=${(latitude * 180 / Math.PI).toFixed(2)}, ` +
            `sslat=${(subSolarLatitude * 180 / Math.PI).toFixed(2)}`
        );
    }
}

// ============================================================================
// fillInFromScratch — port of .esastro-ref/src/ESSunAltitudeTable.cpp L168–286
// ============================================================================

function generateTable(): Float32Array {
    const totalEntries = SS_SLOTS * LAT_SLOTS * ALT_SLOTS;
    const table = new Float32Array(totalEntries);

    // Helper to set table[sslatIndex][latIndex][altIndex]
    function setEntry(ssI: number, latI: number, altI: number, value: number): void {
        table[ssI * LAT_SLOTS * ALT_SLOTS + latI * ALT_SLOTS + altI] = value;
    }

    for (let subsolarIndex = 0; subsolarIndex < SS_SLOTS; subsolarIndex++) {
        const subSolarLatitude = indexToSubsolar(subsolarIndex);

        if (subsolarIndex % 10 === 0) {
            process.stdout.write(
                `  subsolar ${subsolarIndex}/${SS_SLOTS} ` +
                `(${(subSolarLatitude * 180 / Math.PI).toFixed(1)}°)\n`
            );
        }

        for (let altitudeIndex = 0; altitudeIndex < ALT_SLOTS; altitudeIndex++) {
            const sunAltitude = indexToAlt(altitudeIndex);

            // Precalculate unvarying quantities
            const cossslat = Math.cos(subSolarLatitude);
            const sinsslat = Math.sin(subSolarLatitude);
            const sinAlt = Math.sin(sunAltitude);
            const cosAlt = Math.cos(sunAltitude);
            const sinBPart = sinsslat * sinAlt;
            const yPart = cosAlt * cossslat;

            let lastLatitude = 0;
            let lastLongitude = 0;
            let latitudeIndex = 0;
            let latitudeForLatitudeIndex = 0;
            let firstTime = true;
            let lastTime = false;

            for (let i = 0; i < NUM_PARAMETRIC_POINTS; i++) {
                lastTime = false;
                const psi = i * (Math.PI / (NUM_PARAMETRIC_POINTS - 1)) - Math.PI / 2;

                const sinB = sinBPart + yPart * Math.sin(psi);
                const x = sinAlt - sinsslat * sinB;
                const B = Math.asin(sinB);  // B = latitude at this parametric point
                const y = yPart * Math.cos(psi);
                let L = Math.atan2(y, x);   // L = longitude at this parametric point

                if (L > Math.PI) {
                    L -= 2 * Math.PI;
                } else if (L < -Math.PI) {
                    L += 2 * Math.PI;
                }

                if (firstTime) {
                    firstTime = false;
                    const newLatitudeIndex = latToIndex(B);

                    // Fill in polar slots before the first latitude crossing
                    for (latitudeIndex = 0; latitudeIndex < newLatitudeIndex; latitudeIndex++) {
                        setEntry(
                            subsolarIndex, latitudeIndex, altitudeIndex,
                            infinityForSSLatAlt(subSolarLatitude, indexToLat(latitudeIndex), sunAltitude),
                        );
                    }

                    latitudeIndex = newLatitudeIndex;
                    setEntry(subsolarIndex, latitudeIndex, altitudeIndex, L);
                    latitudeForLatitudeIndex = indexToLat(latitudeIndex);

                    if (B > latitudeForLatitudeIndex) {
                        // Already past this slot — move on
                        latitudeIndex++;
                        latitudeForLatitudeIndex = indexToLat(latitudeIndex);
                    }
                    // else: can still do better for this slot via interpolation
                } else {
                    // Interpolate between consecutive parametric points
                    while (B > latitudeForLatitudeIndex) {
                        const interpolatedLongitude =
                            lastLongitude +
                            (latitudeForLatitudeIndex - lastLatitude) /
                            (B - lastLatitude) * (L - lastLongitude);

                        setEntry(subsolarIndex, latitudeIndex, altitudeIndex, interpolatedLongitude);

                        latitudeIndex++;
                        if (latitudeIndex >= LAT_SLOTS) break;
                        latitudeForLatitudeIndex = indexToLat(latitudeIndex);
                    }

                    if (i === NUM_PARAMETRIC_POINTS - 1) {
                        // Last parametric point — fill in remaining slots
                        const newLatitudeIndex = latToIndex(B);
                        if (newLatitudeIndex === latitudeIndex && latitudeIndex < LAT_SLOTS) {
                            setEntry(subsolarIndex, latitudeIndex, altitudeIndex, L);
                        }

                        // Fill remaining with polar values
                        while (latitudeIndex < LAT_SLOTS) {
                            setEntry(
                                subsolarIndex, latitudeIndex, altitudeIndex,
                                infinityForSSLatAlt(subSolarLatitude, indexToLat(latitudeIndex), sunAltitude),
                            );
                            latitudeIndex++;
                        }
                        lastTime = true;
                    }
                }

                lastLatitude = B;
                lastLongitude = L;
            }

            if (!lastTime) {
                throw new Error(
                    `fillInFromScratch: didn't reach lastTime for ` +
                    `ssI=${subsolarIndex}, altI=${altitudeIndex}`
                );
            }
        }
    }

    return table;
}

// ============================================================================
// Encode to Int16 and write
// ============================================================================

function encodeToInt16(table: Float32Array): Int16Array {
    const result = new Int16Array(table.length);
    for (let i = 0; i < table.length; i++) {
        result[i] = Math.round(table[i] * INT16_SCALE);
    }
    return result;
}

// ============================================================================
// Main
// ============================================================================

const outputPath = new URL('../../src/observatory/data/altitude-table.bin', import.meta.url).pathname;

console.log('Generating sun altitude table...');
console.log(`  Dimensions: ${SS_SLOTS} subsolar × ${LAT_SLOTS} latitude × ${ALT_SLOTS} altitude`);
console.log(`  Total entries: ${SS_SLOTS * LAT_SLOTS * ALT_SLOTS}`);
console.log(`  Parametric points: ${NUM_PARAMETRIC_POINTS}`);
console.log(`  Altitude range: 0° to ${ALT_MIN_DEGREES}° (civil twilight)`);
console.log();

const startTime = Date.now();
const table = generateTable();
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\nTable generation took ${elapsed}s`);

// Validate: check a few known values
console.log('\nSpot checks:');
const getEntry = (ssI: number, latI: number, altI: number): number =>
    table[ssI * LAT_SLOTS * ALT_SLOTS + latI * ALT_SLOTS + altI];

// At equinox (sslat=0), equator (lat≈0°, index 75), altitude 0: should be ~π/2 (90°)
const equatorIdx = Math.round(LAT_STEPS / 2);  // 75
const eq0 = getEntry(0, equatorIdx, 0);
console.log(`  Equinox, equator, alt=0: ${(eq0 * 180 / Math.PI).toFixed(2)}° (expect ~90°)`);

// At equinox (sslat=0), north pole (lat=90°), altitude 0: should be 0 (sun at horizon = always below)
const eqPole = getEntry(0, LAT_STEPS, 0);
console.log(`  Equinox, north pole, alt=0: ${(eqPole * 180 / Math.PI).toFixed(2)}° (expect ~0°)`);

// At max sslat (24°), equator, altitude 0: should be ~90° with offset
const ss24eq = getEntry(SS_STEPS, equatorIdx, 0);
console.log(`  sslat=24°, equator, alt=0: ${(ss24eq * 180 / Math.PI).toFixed(2)}°`);

// Encode to Int16
const int16Table = encodeToInt16(table);
const buffer = Buffer.from(int16Table.buffer);

// Write output
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, buffer);

console.log(`\nWritten to ${outputPath}`);
console.log(`  Float32 size: ${(table.byteLength / 1024).toFixed(0)} KB`);
console.log(`  Int16 size:   ${(buffer.byteLength / 1024).toFixed(0)} KB`);
