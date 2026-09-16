#!/usr/bin/env node
/**
 * Script to download and convert C data tables to TypeScript.
 */

import { writeFileSync } from 'fs';
import { get } from 'https';

const LUNAR_URL = 'https://raw.githubusercontent.com/EmeraldSequoia/esastro/main/Willmann-Bell/Lunar/ESWBLunarTable.h';
const PLANETS_URL = 'https://raw.githubusercontent.com/EmeraldSequoia/esastro/main/Willmann-Bell/Planets/ESWBPlanetsTable.h';

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', reject);
        }).on('error', reject);
    });
}

/**
 * Find a balanced brace block starting from the first '{' at or after `start`.
 * Returns the content between the outermost braces and the index after the closing brace.
 */
function findBraceBlock(src, start) {
    let openIdx = src.indexOf('{', start);
    if (openIdx === -1) return null;
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) {
                return { content: src.substring(openIdx + 1, i), endIdx: i + 1 };
            }
        }
    }
    return null;
}

/**
 * Parse all top-level brace-delimited entries from a string.
 * e.g. "{ 1, 2, 3 }, { 4, 5, 6 }" -> [" 1, 2, 3 ", " 4, 5, 6 "]
 */
function parseStructEntries(content) {
    const entries = [];
    let pos = 0;
    while (pos < content.length) {
        const block = findBraceBlock(content, pos);
        if (!block) break;
        entries.push(block.content);
        pos = block.endIdx;
    }
    return entries;
}

function convertLunarTable(cSource) {
    let ts = `/**
 * Lunar data tables.
 *
 * Ported from ESWBLunarTable.h in the EmeraldSequoia/esastro repository.
 * Original data derived from "Lunar Tables and Programs from 4000 B.C. to A.D. 8000"
 * by Michelle Chapront-Touzé & Jean Chapront, published by Willmann-Bell, Inc.
 */

`;

    // Define struct field mappings
    const fieldMaps = {
        SvDatum: ['vn', 'an0', 'an1', 'an2', 'an3', 'an4'],
        Sv1Datum: ['vn', 'an0', 'an1'],
        Sv2Datum: ['vn', 'an0', 'an1'],
        Sv3Datum: ['vn', 'an0', 'an1'],
        SuDatum: ['un', 'bn0', 'bn1', 'bn2', 'bn3', 'bn4'],
        Su1Datum: ['un', 'bn0', 'bn1'],
        Su2Datum: ['un', 'bn0', 'bn1'],
        Su3Datum: ['un', 'bn0', 'bn1'],
        SrDatum: ['rn', 'dn0', 'dn1', 'dn2', 'dn3', 'dn4'],
        Sr1Datum: ['rn', 'dn0', 'dn1'],
        Sr2Datum: ['rn', 'dn0', 'dn1'],
        Sr3Datum: ['rn', 'dn0', 'dn1'],
        NutationDatum: ['mu0n', 'mu1n', 'mu2n', 'psin', 'psi1n', 'obn', 'ob1n'],
    };

    // Emit interfaces
    for (const [name, fields] of Object.entries(fieldMaps)) {
        ts += `export interface ${name} {\n`;
        for (const f of fields) {
            ts += `    readonly ${f}: number;\n`;
        }
        ts += `}\n\n`;
    }

    // Find and convert all struct arrays
    const structArrayRegex = /static\s+const\s+(\w+)\s+(\w+)\s*\[\s*\d*\s*\]\s*=\s*\{/g;
    let match;
    while ((match = structArrayRegex.exec(cSource)) !== null) {
        const typeName = match[1];
        const arrayName = match[2];
        const fields = fieldMaps[typeName];
        
        if (!fields) continue;  // Skip unknown types

        // Find the full brace block
        const block = findBraceBlock(cSource, match.index + match[0].length - 1);
        if (!block) continue;

        // Parse entries
        const entries = parseStructEntries(block.content);
        
        ts += `export const ${arrayName}: readonly ${typeName}[] = [\n`;
        for (const entry of entries) {
            const values = entry.split(',').map(v => v.replace(/\/\*.*?\*\//g, '').trim()).filter(v => v.length > 0);
            if (values.length >= fields.length) {
                const pairs = fields.map((f, i) => `${f}: ${values[i]}`).join(', ');
                ts += `    { ${pairs} },\n`;
            }
        }
        ts += `];\n\n`;
    }

    // Simple count arrays (int arrays)
    const intArrayRegex = /static\s+(?:const\s+)?int\s+(\w+)\s*\[\s*\d*\s*\]\s*=\s*\{([^}]+)\}\s*;/g;
    while ((match = intArrayRegex.exec(cSource)) !== null) {
        const name = match[1];
        const nums = match[2].match(/-?\d+/g);
        if (nums) {
            ts += `export const ${name}: readonly number[] = [${nums.join(', ')}];\n\n`;
        }
    }

    return ts;
}

function convertPlanetsTable(cSource) {
    let ts = `/**
 * Planet data tables.
 *
 * Ported from ESWBPlanetsTable.h in the EmeraldSequoia/esastro repository.
 * Original data derived from "Planetary Programs and Tables from -4000 to +2800"
 * by Pierre Bretagnon & Jean-Louis Simon, published by Willmann-Bell, Inc.
 */

`;

    // Interfaces
    ts += `export interface SunDatum {\n    readonly li: number;\n    readonly ri: number;\n    readonly ali: number;\n    readonly bli: number;\n}\n\n`;
    ts += `export interface InnerPlanetDatum {\n    readonly vi: number;\n    readonly ai: number;\n    readonly bi: number;\n}\n\n`;
    ts += `export interface OuterPlanetDatum {\n    readonly aLong: readonly number[];\n    readonly aLat: readonly number[];\n    readonly aRad: readonly number[];\n}\n\n`;
    ts += `export interface OuterPlanetJDRange {\n    readonly startJD: number;\n    readonly endJD: number;\n}\n\n`;
    ts += `export interface OuterPlanetDescriptor {\n    readonly numEntries: number;\n    readonly data: readonly OuterPlanetDatum[];\n    readonly jdRange: readonly OuterPlanetJDRange[];\n}\n\n`;

    // Extract SunDatum array
    {
        const regex = /static\s+const\s+SunDatum\s+sunData\s*\[\s*\d*\s*\]\s*=\s*\{/;
        const m = regex.exec(cSource);
        if (m) {
            const block = findBraceBlock(cSource, m.index + m[0].length - 1);
            if (block) {
                const entries = parseStructEntries(block.content);
                ts += `export const sunData: readonly SunDatum[] = [\n`;
                for (const entry of entries) {
                    const values = entry.split(',').map(v => v.replace(/\/\*.*?\*\//g, '').trim()).filter(v => v.length > 0);
                    if (values.length >= 4) {
                        ts += `    { li: ${values[0]}, ri: ${values[1]}, ali: ${values[2]}, bli: ${values[3]} },\n`;
                    }
                }
                ts += `];\n\n`;
                ts += `export const numSunData = sunData.length;\n\n`;
            }
        }
    }

    // Extract InnerPlanetDatum arrays
    const innerNames = [
        'mercuryLongitudeData', 'mercuryLatitudeData', 'mercuryRadiusData',
        'venusLongitudeData', 'venusLatitudeData', 'venusRadiusData',
        'marsLongitudeData', 'marsLatitudeData', 'marsRadiusData',
    ];
    for (const name of innerNames) {
        const regex = new RegExp(`static\\s+const\\s+InnerPlanetDatum\\s+${name}\\s*\\[\\s*\\d*\\s*\\]\\s*=\\s*\\{`);
        const m = regex.exec(cSource);
        if (m) {
            const block = findBraceBlock(cSource, m.index + m[0].length - 1);
            if (block) {
                const entries = parseStructEntries(block.content);
                ts += `export const ${name}: readonly InnerPlanetDatum[] = [\n`;
                for (const entry of entries) {
                    const values = entry.split(',').map(v => v.replace(/\/\*.*?\*\//g, '').trim()).filter(v => v.length > 0);
                    if (values.length >= 3) {
                        ts += `    { vi: ${values[0]}, ai: ${values[1]}, bi: ${values[2]} },\n`;
                    }
                }
                ts += `];\n\n`;
            }
        }
    }

    // num* constants
    const numRegex = /static\s+(?:const\s+)?int\s+(num\w+Data)\s*=\s*(\d+)\s*;/g;
    let match;
    while ((match = numRegex.exec(cSource)) !== null) {
        ts += `export const ${match[1]} = ${match[2]};\n\n`;
    }

    // OuterPlanetJDRange arrays
    const jdRangeNames = ['jupiterJDRange', 'saturnJDRange', 'uranusJDRange', 'neptuneJDRange'];
    for (const name of jdRangeNames) {
        const regex = new RegExp(`static\\s+const\\s+OuterPlanetJDRange\\s+${name}\\s*\\[\\s*\\d*\\s*\\]\\s*=\\s*\\{`);
        const m = regex.exec(cSource);
        if (m) {
            const block = findBraceBlock(cSource, m.index + m[0].length - 1);
            if (block) {
                const entries = parseStructEntries(block.content);
                ts += `export const ${name}: readonly OuterPlanetJDRange[] = [\n`;
                for (const entry of entries) {
                    const values = entry.split(',').map(v => v.replace(/\/\*.*?\*\//g, '').trim()).filter(v => v.length > 0);
                    if (values.length >= 2) {
                        ts += `    { startJD: ${values[0]}, endJD: ${values[1]} },\n`;
                    }
                }
                ts += `];\n\n`;
            }
        }
    }

    // OuterPlanetDatum arrays - these have { {7nums}, {7nums}, {7nums} } per entry
    const outerDataNames = ['jupiterData', 'saturnData', 'uranusData', 'neptuneData'];
    for (const name of outerDataNames) {
        const regex = new RegExp(`static\\s+const\\s+OuterPlanetDatum\\s+${name}\\s*\\[\\s*\\d*\\s*\\]\\s*=\\s*\\{`);
        const m = regex.exec(cSource);
        if (m) {
            const block = findBraceBlock(cSource, m.index + m[0].length - 1);
            if (block) {
                // Each top-level entry has 3 sub-arrays: aLong, aLat, aRad
                const entries = parseStructEntries(block.content);
                ts += `export const ${name}: readonly OuterPlanetDatum[] = [\n`;
                for (const entry of entries) {
                    // Parse 3 sub-arrays
                    const subArrays = parseStructEntries(entry);
                    if (subArrays.length >= 3) {
                        const aLong = subArrays[0].split(',').map(v => v.replace(/\/\*.*?\*\//g, '').trim()).filter(v => v.length > 0);
                        const aLat = subArrays[1].split(',').map(v => v.replace(/\/\*.*?\*\//g, '').trim()).filter(v => v.length > 0);
                        const aRad = subArrays[2].split(',').map(v => v.replace(/\/\*.*?\*\//g, '').trim()).filter(v => v.length > 0);
                        ts += `    { aLong: [${aLong.join(', ')}], aLat: [${aLat.join(', ')}], aRad: [${aRad.join(', ')}] },\n`;
                    }
                }
                ts += `];\n\n`;
            }
        }
    }

    // num*Entries constants
    const numEntriesRegex = /static\s+(?:const\s+)?int\s+(num\w+Entries)\s*=\s*(\d+)\s*;/g;
    while ((match = numEntriesRegex.exec(cSource)) !== null) {
        ts += `export const ${match[1]} = ${match[2]};\n\n`;
    }

    // OuterPlanetDescriptor objects
    const outerDescRegex = /static\s+const\s+OuterPlanetDescriptor\s+(\w+)\s*=\s*\{\s*(\d+)\s*,\s*(\w+)\s*,\s*(\w+)\s*\}\s*;/g;
    while ((match = outerDescRegex.exec(cSource)) !== null) {
        const name = match[1];
        const numEntries = match[2];
        const dataRef = match[3];
        const jdRangeRef = match[4];
        ts += `export const ${name}: OuterPlanetDescriptor = { numEntries: ${numEntries}, data: ${dataRef}, jdRange: ${jdRangeRef} };\n\n`;
    }

    return ts;
}

async function main() {
    console.log('Downloading lunar table...');
    const lunarSource = await fetchUrl(LUNAR_URL);
    console.log(`  Downloaded ${lunarSource.length} bytes`);
    
    console.log('Converting lunar table...');
    const lunarTs = convertLunarTable(lunarSource);
    const lunarPath = new URL('../../src/astronomy/lunar-tables.ts', import.meta.url).pathname;
    writeFileSync(lunarPath, lunarTs);
    console.log(`  Wrote ${lunarTs.length} bytes to ${lunarPath}`);

    console.log('Downloading planets table...');
    const planetsSource = await fetchUrl(PLANETS_URL);
    console.log(`  Downloaded ${planetsSource.length} bytes`);
    
    console.log('Converting planets table...');
    const planetsTs = convertPlanetsTable(planetsSource);
    const planetsPath = new URL('../../src/astronomy/planet-tables.ts', import.meta.url).pathname;
    writeFileSync(planetsPath, planetsTs);
    console.log(`  Wrote ${planetsTs.length} bytes to ${planetsPath}`);

    console.log('Done!');
}

main().catch(console.error);
