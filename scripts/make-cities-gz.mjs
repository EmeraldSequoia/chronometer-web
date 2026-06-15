#!/usr/bin/env node
/**
 * Emit dist/cities-data.json.gz — the gzip of the raw v2 JSON payload, for the
 * http(s) fetch path in city-search.ts (held resident as a ~2-3 MB compressed
 * blob, decompressed + parsed on demand). The `<script>`-form cities-data.js is
 * still shipped for the file:// path.
 *
 * Derived at build time from src/cities-data.js so there is no second committed
 * artifact to keep in sync. See planning/2026-06-14-observatory-cities-lazy-load.md.
 *
 *   node scripts/make-cities-gz.mjs [outDir=dist]
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = process.argv[2] || join(root, 'dist');

// Execute cities-data.js in a minimal sandbox to recover window.ChronometerCities.
const js = readFileSync(join(root, 'src', 'cities-data.js'), 'utf-8');
const sandbox = { ChronometerCities: undefined };
// eslint-disable-next-line no-new-func
new Function('window', js)(sandbox);
const data = sandbox.ChronometerCities;
if (!data || data.v !== 2) {
    console.error('cities-data.js did not yield a v2 ChronometerCities payload');
    process.exit(1);
}

// Re-serialize to clean JSON (round-trips out of the JS string-literal escaping)
// and gzip at max level (build-time cost only).
const json = JSON.stringify(data);
const gz = gzipSync(Buffer.from(json, 'utf-8'), { level: 9 });
const outPath = join(outDir, 'cities-data.json.gz');
writeFileSync(outPath, gz);

const mb = (n) => (n / (1024 * 1024)).toFixed(1);
console.log(`  → cities-data.json.gz (${mb(gz.length)} MB, from ${mb(Buffer.byteLength(json))} MB JSON)`);
