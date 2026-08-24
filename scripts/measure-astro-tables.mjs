#!/usr/bin/env node
/**
 * measure-astro-tables.mjs — what the Willmann-Bell series data costs:
 * bytes over the wire, and bytes of heap once loaded.
 *
 * The engine's accuracy is bought with data — `lunar-tables.ts` and
 * `planet-tables.ts` are pure coefficient tables transcribed from the two
 * books, and they are by a wide margin the largest thing in the astronomy
 * engine. This reports:
 *
 *   - download size: each table module bundled the way build.sh bundles it
 *     (esbuild, es2020, NOT minified), raw and under gzip and brotli;
 *   - the tables' share of the real Chronometer engine bundle, attributed
 *     with esbuild's own metafile rather than estimated;
 *   - memory: the float64 payload (every distinct number in the tables),
 *     the cost of the JavaScript objects and arrays that hold it, and the
 *     total heap growth from importing the module.
 *
 * Reference sharing matters in both counts: the four outer-planet
 * descriptors alias the same arrays the module also exports directly, so
 * every walk here counts an object once (`structuredClone` preserves that
 * sharing; a JSON round-trip would duplicate the aliased arrays and
 * overstate the total by ~10%).
 *
 * Memory figures are V8's — the engine in Node, Chrome and Edge.
 * JavaScriptCore and SpiderMonkey lay these structures out differently.
 * Run with --expose-gc so the heap can be settled before each reading:
 *
 *   node --expose-gc scripts/measure-astro-tables.mjs
 *
 * Findings are quoted in docs/accuracy.md ("What the tables cost").
 */

import { build } from 'esbuild';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = ['lunar-tables', 'planet-tables'];

const KB = (n) => (n / 1024).toFixed(1).padStart(8) + ' KB';
const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const br = (buf) => brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

/** Bundle table modules exactly as build.sh does — es2020, not minified. */
async function bundleTables(entry) {
    const result = await build({
        stdin: { contents: entry, resolveDir: join(ROOT, 'src/astronomy'), loader: 'ts' },
        bundle: true, format: 'esm', platform: 'browser', target: 'es2020', write: false,
    });
    return Buffer.from(result.outputFiles[0].text);
}

/** Count distinct numbers, objects and arrays, following aliases only once. */
function census(root) {
    let numbers = 0, objects = 0, arrays = 0;
    const seen = new Set();
    const walk = (v) => {
        if (typeof v === 'number') { numbers++; return; }
        if (!v || typeof v !== 'object' || seen.has(v)) return;
        seen.add(v);
        if (Array.isArray(v)) { arrays++; for (const x of v) walk(x); return; }
        objects++;
        for (const k of Object.keys(v)) walk(v[k]);
    };
    walk(root);
    return { numbers, objects, arrays };
}

async function main() {
    console.log('Willmann-Bell table data — download size and memory footprint');
    console.log('');

    // ---------------------------------------------------------- download
    console.log('=== Download (bundled as build.sh bundles it: es2020, not minified) ===');
    let combined = null;
    for (const mod of [...MODULES, 'both']) {
        const entry = mod === 'both'
            ? MODULES.map((m, i) => `export * as T${i} from './${m}';`).join('\n')
            : `export * as T from './${mod}';`;
        const buf = await bundleTables(entry);
        if (mod === 'both') combined = buf;
        console.log(`  ${mod.padEnd(14)} raw ${KB(buf.length)}   gzip ${KB(gz(buf))}   brotli ${KB(br(buf))}`);
    }

    // ------------------------------------------- share of the app bundle
    const app = await build({
        entryPoints: [join(ROOT, 'src/engine-entry.ts')],
        bundle: true, format: 'iife', target: 'es2020', write: false, metafile: true,
        logLevel: 'silent',
        define: { __BUILD_VERSION__: '"0.0.0"' },
        loader: { '.xml': 'text', '.png': 'dataurl', '.jpg': 'dataurl', '.bin': 'dataurl' },
    });
    const out = Object.values(app.metafile.outputs).find((o) => o.entryPoint);
    const tableBytes = Object.entries(out.inputs)
        .filter(([f]) => MODULES.some((m) => f.endsWith(`${m}.ts`)))
        .reduce((sum, [, v]) => sum + v.bytesInOutput, 0);
    console.log('');
    console.log('=== Share of the Chronometer engine bundle ===');
    console.log(`  whole bundle       ${KB(out.bytes)}`);
    console.log(`  the two tables     ${KB(tableBytes)}   ${(100 * tableBytes / out.bytes).toFixed(1)}% of it`);

    // ------------------------------------------------------------ memory
    console.log('');
    if (typeof global.gc !== 'function') {
        console.log('=== Memory: skipped — re-run with `node --expose-gc` ===');
        return;
    }
    const settle = () => { for (let i = 0; i < 6; i++) global.gc(); return process.memoryUsage().heapUsed; };

    // Import from a real file, the way a browser loads a script. (A
    // base64 data: URL would work too, but the URL string itself stays on
    // the heap and inflates the import figure by megabytes.)
    const tmp = mkdtempSync(join(tmpdir(), 'wb-tables-'));
    const file = join(tmp, 'tables.mjs');
    writeFileSync(file, combined);

    const beforeImport = settle();
    const mod = await import(pathToFileURL(file).href);
    const afterImport = settle();

    const tables = Object.fromEntries(Object.entries(mod).map(([k, ns]) => [k, { ...ns }]));
    const { numbers, objects, arrays } = census(tables);

    const beforeClone = settle();
    const clone = structuredClone(tables);
    const afterClone = settle();

    const payload = numbers * 8;
    const structures = afterClone - beforeClone;
    console.log('=== Memory once loaded (V8: Node, Chrome, Edge) ===');
    console.log(`  the numbers themselves     ${KB(payload)}   ${numbers.toLocaleString()} distinct float64 values`);
    console.log(`  as JS objects and arrays   ${KB(structures)}   ${(structures / payload).toFixed(1)}× the payload — ${objects.toLocaleString()} objects, ${arrays.toLocaleString()} arrays`);
    console.log(`  heap growth on import      ${KB(afterImport - beforeImport)}   the above plus compiled code and retained source`);

    if (!clone) throw new Error('unreachable — keeps the clone alive across the measurement');
    rmSync(tmp, { recursive: true, force: true });
}

await main();
