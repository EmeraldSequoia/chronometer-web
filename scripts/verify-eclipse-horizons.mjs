#!/usr/bin/env node
/**
 * verify-eclipse-horizons.mjs — measure the eclipse engine against JPL
 * Horizons, an authority independent of the Espenak/NASA canon that
 * everything in eclipse-data.json is scraped from (and, with --opale,
 * against IMCCE's INPOP19A, independent of both).
 *
 * For each solar row of src/help/eclipse-data.json: two sequential Horizons
 * calls (Sun, Moon) for topocentric apparent-of-date RA/Dec (airless — the
 * `(a-app)` frame, exactly what the engine computes), angular diameter,
 * range, and EOP-derived TDB−UT, at the row's greatest-eclipse site and
 * derived-UT instant. Then compare, at full float precision:
 *
 *   - Sun−Moon angular separation vs calculateEclipse — the number the
 *     partial/annular/total thresholds cut, quoted in the JSON test only to
 *     1e-4°; rows off by more than 0.5″ are flagged;
 *   - topocentric Sun/Moon distances vs Horizons' range — the disc-size
 *     check, done through distances because it is radius-convention-free
 *     (Horizons uses IAU 2015 nominal radii, the engine 695500/1737.10 km);
 *   - the engine's ΔT vs TDB−UT — exact agreement expected inside the leap
 *     era; seconds-scale divergence is *expected* past the leap table's
 *     expiry, where the two sides follow different conventions (Horizons
 *     freezes TAI−UTC at the last announced leap second; the engine
 *     extrapolates the rejoined polynomial — see es-time.ts). A ΔT
 *     difference moves the whole eclipse along its track, so predicted-era
 *     rows are flagged only beyond 1″ + 0.56″/s × |ΔΔT|, the Moon's maximum
 *     angular rate against the Sun; leap-era rows are flagged over 0.5″.
 *
 * Manual and evidence-generating only — never part of build or CI: Horizons
 * is a best-effort service with a strict sequential-requests fair-use policy
 * (~0.3 s/call; 140 calls ≈ 2 minutes live). Responses are cached in
 * scripts/horizons-cache/ (committed), so re-runs are offline and the report
 * is byte-stable; a format change upstream announces itself in the
 * `API VERSION` line, which this script checks.
 *
 *   node scripts/verify-eclipse-horizons.mjs                # all 70 solar rows
 *   node scripts/verify-eclipse-horizons.mjs --opale        # + IMCCE cross-check
 *   node scripts/verify-eclipse-horizons.mjs --only 2024-04-08
 *   node scripts/verify-eclipse-horizons.mjs --cache /tmp/h # elsewhere
 *
 * Findings live in docs/astronomy.md ("Measured accuracy") and
 * planning/2026-08-17-eclipse-precision-and-verification.md.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HORIZONS = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const OPALE = 'https://opale.imcce.fr/api/v1/phenomena/eclipses/10';
const AU_KM = 149597870.7;
/** IAU 2015 nominal radii — what Horizons' Ang-diam uses. */
const SUN_RADIUS_KM = 695700;
const MOON_RADIUS_KM = 1737.4;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
    const opts = {
        cache: join(ROOT, 'scripts/horizons-cache'),
        opale: false,
        only: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--cache') {
            if (!argv[i + 1]) die('--cache needs a path');
            opts.cache = argv[++i];
        } else if (arg === '--opale') {
            opts.opale = true;
        } else if (arg === '--only') {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(argv[i + 1] ?? '')) die('--only needs YYYY-MM-DD');
            opts.only = argv[++i];
        } else {
            die(`unknown argument ${arg}`);
        }
    }
    return opts;
}

function die(message) {
    console.error(`verify-eclipse-horizons: ${message}`);
    process.exit(1);
}

// ------------------------------------------------------------------ fetching

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cached fetch; live requests are strictly sequential and paced, per JPL's
 *  fair-use policy. `condense` (optional) reduces a live response before it
 *  is cached — the committed fixtures keep only what the report reads. */
async function fetchText(url, cacheDir, condense = null) {
    const cacheFile = join(cacheDir, url.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 200));
    if (existsSync(cacheFile)) return readFileSync(cacheFile, 'utf8');

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const resp = await fetch(url, { redirect: 'follow' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const text = condense ? condense(await resp.text()) : await resp.text();
            mkdirSync(cacheDir, { recursive: true });
            writeFileSync(cacheFile, text);
            await sleep(400);
            return text;
        } catch (err) {
            lastError = err;
            await sleep(1500 * attempt);
        }
    }
    die(`could not fetch ${url}: ${lastError?.message ?? lastError}`);
}

// ------------------------------------------------------------------ engine

/** Bundle the TypeScript engine in memory (same trick as scrape-eclipses.mjs). */
async function loadEngine() {
    const { build } = await import('esbuild');
    const result = await build({
        stdin: {
            contents: [
                "export { calculateEclipse, planetTopocentricDistance } from './es-astro';",
                "export { convertETtoUT } from './es-time';",
                "export { ECPlanetNumber } from './astro-constants';",
                "export { kECLeapTableValidUntil } from './es-leap-second';",
            ].join('\n'),
            resolveDir: join(ROOT, 'src/astronomy'),
            loader: 'ts',
        },
        bundle: true,
        format: 'esm',
        platform: 'node',
        write: false,
    });
    const b64 = Buffer.from(result.outputFiles[0].text).toString('base64');
    return import(`data:text/javascript;base64,${b64}`);
}

// ---------------------------------------------------------------- horizons

/**
 * One Horizons observer-table query at a single UT instant. Column layout
 * with QUANTITIES='2,13,20,30' and CSV_FORMAT=YES (indexed positionally —
 * two presence-flag columns sit between the date and the RA):
 *   [0] date  [1][2] flags  [3] RA°  [4] Dec°  [5] Ang-diam″
 *   [6] delta AU  [7] deldot  [8] TDB−UT s
 */
async function horizonsQuery(command, lonDeg, latDeg, jdUt, cacheDir) {
    const params = new URLSearchParams({
        format: 'text',
        COMMAND: `'${command}'`,
        EPHEM_TYPE: 'OBSERVER',
        CENTER: "'coord@399'",
        COORD_TYPE: 'GEODETIC',
        SITE_COORD: `'${lonDeg},${latDeg},0'`,
        TLIST_TYPE: 'JD',
        TIME_TYPE: 'UT',
        TLIST: `'${jdUt.toFixed(10)}'`,
        QUANTITIES: "'2,13,20,30'",
        ANG_FORMAT: 'DEG',
        EXTRA_PREC: 'YES',
        APPARENT: 'AIRLESS',
        CSV_FORMAT: 'YES',
    });
    const url = `${HORIZONS}?${params.toString()}`;
    const text = await fetchText(url, cacheDir);

    const version = text.match(/API VERSION:\s*(\S+)/);
    if (!version || !version[1].startsWith('1.')) {
        die(`Horizons API version changed (${version?.[1]}) — re-verify the column layout before trusting this run`);
    }
    const m = text.match(/\$\$SOE\n(.*)\n\$\$EOE/);
    if (!m) die(`no $$SOE data line for target ${command} at JD ${jdUt}`);
    const fields = m[1].split(',').map((f) => f.trim());
    const [raDeg, decDeg, angDiamArcsec, deltaAU, tdbMinusUt] =
        [fields[3], fields[4], fields[5], fields[6], fields[8]].map(Number);
    if (![raDeg, decDeg, angDiamArcsec, deltaAU, tdbMinusUt].every(Number.isFinite)) {
        die(`unparsable data line for target ${command}: ${m[1]}`);
    }
    return { raDeg, decDeg, angDiamArcsec, deltaAU, tdbMinusUt };
}

/** Same Vincenty form the engine uses — exact at small separations. */
function separationRad(ra1, dec1, ra2, dec2) {
    const sinD1 = Math.sin(dec1), cosD1 = Math.cos(dec1);
    const sinD2 = Math.sin(dec2), cosD2 = Math.cos(dec2);
    const sinRA = Math.sin(ra2 - ra1), cosRA = Math.cos(ra2 - ra1);
    const x = cosD1 * sinD2 - sinD1 * cosD2 * cosRA;
    const y = cosD2 * sinRA;
    const z = sinD1 * sinD2 + cosD1 * cosD2 * cosRA;
    return Math.atan2(Math.hypot(x, y), z);
}

// -------------------------------------------------------------------- main

const RAD = Math.PI / 180;
const ARCSEC = 3600;
const fmt = (v, w, p) => v.toFixed(p).padStart(w);

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const data = JSON.parse(readFileSync(join(ROOT, 'src/help/eclipse-data.json'), 'utf8'));
    const engine = await loadEngine();
    const { calculateEclipse, planetTopocentricDistance, convertETtoUT, ECPlanetNumber, kECLeapTableValidUntil } = engine;

    let rows = data.eclipses.filter((e) => e.kind.endsWith('-solar'));
    if (opts.only) {
        rows = rows.filter((e) => new Date(e.tdMs).toISOString().startsWith(opts.only));
        if (rows.length === 0) die(`no solar row on ${opts.only}`);
    }

    console.log(`Engine vs JPL Horizons — ${rows.length} solar greatest-eclipse rows, topocentric, airless apparent-of-date`);
    console.log('sep = Sun−Moon centre separation; Δ = engine − Horizons; era P = ΔT predicted on both sides (past leap table)');
    console.log('');

    const stats = { sep: [], sepPredicted: [], sunKm: [], moonKm: [], sunSize: [], moonSize: [], dtExact: [], dtPredicted: [] };
    const flagged = [];

    for (const e of rows) {
        const date = new Date(e.tdMs).toISOString().slice(0, 10);
        const tdSec = e.tdMs / 1000 - 978307200;
        const utSec = convertETtoUT(tdSec);
        const deltaTEng = tdSec - utSec;
        const utUnixMs = (utSec + 978307200) * 1000;
        const jdUt = utUnixMs / 86400000 + 2440587.5;
        const predictedEra = utSec > kECLeapTableValidUntil;

        const sun = await horizonsQuery('10', e.lon, e.lat, jdUt, opts.cache);
        const moon = await horizonsQuery('301', e.lon, e.lat, jdUt, opts.cache);

        const sepJpl = separationRad(sun.raDeg * RAD, sun.decDeg * RAD, moon.raDeg * RAD, moon.decDeg * RAD) / RAD * ARCSEC;
        const r = calculateEclipse(utSec, e.lat * RAD, e.lon * RAD, null);
        const sepEng = (r.angularSeparation / RAD) * ARCSEC;
        const dSep = sepEng - sepJpl;

        const sunDistEng = planetTopocentricDistance(ECPlanetNumber.Sun, utSec, e.lat * RAD, e.lon * RAD, null);
        const moonDistEng = planetTopocentricDistance(ECPlanetNumber.Moon, utSec, e.lat * RAD, e.lon * RAD, null);
        const dSunKm = (sunDistEng - sun.deltaAU) * AU_KM;
        const dMoonKm = (moonDistEng - moon.deltaAU) * AU_KM;

        // Disc sizes, radius-convention normalized: the diameter Horizons
        // would print for the engine's distance, minus what it did print.
        const predDiam = (rKm, distAU) => (2 * Math.asin(rKm / (distAU * AU_KM)) / RAD) * ARCSEC;
        const dSunSize = predDiam(SUN_RADIUS_KM, sunDistEng) - sun.angDiamArcsec;
        const dMoonSize = predDiam(MOON_RADIUS_KM, moonDistEng) - moon.angDiamArcsec;

        const dDt = deltaTEng - sun.tdbMinusUt;

        (predictedEra ? stats.sepPredicted : stats.sep).push(Math.abs(dSep));
        stats.sunKm.push(Math.abs(dSunKm));
        stats.moonKm.push(Math.abs(dMoonKm));
        stats.sunSize.push(Math.abs(dSunSize));
        stats.moonSize.push(Math.abs(dMoonSize));
        (predictedEra ? stats.dtPredicted : stats.dtExact).push(Math.abs(dDt));

        // A ΔT disagreement slides the site under the eclipse track, moving
        // the topocentric Moon (not the Sun) by up to ~0.56″ per second — so
        // past the leap table both sides are self-consistent predictions and
        // only a residual beyond that rate would indict the geometry.
        const allowance = predictedEra ? 1 + 0.56 * Math.abs(dDt) : 0.5;
        const flag = Math.abs(dSep) > allowance ? '  ***' : '';
        if (flag) flagged.push(`${date} Δsep ${dSep.toFixed(3)}″`);
        console.log(
            `${date} ${e.kind.padEnd(14)}${predictedEra ? 'P' : ' '} ` +
            `sep eng ${fmt(sepEng, 9, 3)}″ jpl ${fmt(sepJpl, 9, 3)}″ Δ ${fmt(dSep, 7, 3)}″ | ` +
            `dist Δ sun ${fmt(dSunKm, 7, 1)} km moon ${fmt(dMoonKm, 6, 2)} km | ` +
            `size Δ sun ${fmt(dSunSize, 6, 3)}″ moon ${fmt(dMoonSize, 6, 3)}″ | ` +
            `ΔT eng ${fmt(deltaTEng, 7, 3)} jpl ${fmt(sun.tdbMinusUt, 7, 3)} Δ ${fmt(dDt, 7, 3)} s${flag}`
        );
    }

    const median = (a) => {
        const s = [...a].sort((x, y) => x - y);
        return s.length ? s[Math.floor(s.length / 2)] : NaN;
    };
    const max = (a) => (a.length ? Math.max(...a) : NaN);
    console.log('');
    console.log(`|Δ separation| leap era median ${median(stats.sep).toFixed(3)}″  max ${max(stats.sep).toFixed(3)}″ (${stats.sep.length} rows)`);
    if (stats.sepPredicted.length) {
        console.log(`|Δ separation| predicted era median ${median(stats.sepPredicted).toFixed(3)}″  max ${max(stats.sepPredicted).toFixed(3)}″ (${stats.sepPredicted.length} rows — tracks 0.56″/s × ΔΔT)`);
    }
    console.log(`flagged beyond allowance: ${flagged.length}${flagged.length ? ` (${flagged.join('; ')})` : ''}`);
    console.log(`|Δ sun dist|    median ${median(stats.sunKm).toFixed(1)} km  max ${max(stats.sunKm).toFixed(1)} km`);
    console.log(`|Δ moon dist|   median ${median(stats.moonKm).toFixed(2)} km  max ${max(stats.moonKm).toFixed(2)} km`);
    console.log(`|Δ sun size|    median ${median(stats.sunSize).toFixed(3)}″  max ${max(stats.sunSize).toFixed(3)}″ (radius-normalized)`);
    console.log(`|Δ moon size|   median ${median(stats.moonSize).toFixed(3)}″  max ${max(stats.moonSize).toFixed(3)}″ (radius-normalized)`);
    console.log(`|Δ ΔT| leap era median ${median(stats.dtExact).toFixed(3)} s  max ${max(stats.dtExact).toFixed(3)} s (${stats.dtExact.length} rows)`);
    if (stats.dtPredicted.length) {
        console.log(`|Δ ΔT| predicted era median ${median(stats.dtPredicted).toFixed(3)} s  max ${max(stats.dtPredicted).toFixed(3)} s (${stats.dtPredicted.length} rows — divergence expected; both sides extrapolate)`);
    }

    if (opts.opale) await opaleCheck(rows, engine, opts);
}

// ------------------------------------------------------------------- OPALE

/**
 * IMCCE cross-check: greatest-eclipse position and instant from INPOP19A —
 * independent of both Espenak (VSOP87/ELP2000-82) and JPL (DE44x). Terms:
 * free for private/educational use with the source identified; do not ship
 * OPALE numbers in the app without an LTE authorization (plan §2c). Position
 * deltas are reported, not gated: OPALE's greatest-eclipse point for
 * non-central rows has the same flat-valley latitude the reduction note in
 * scrape-eclipses.mjs describes, so arcminutes of spread are expected there.
 */
async function opaleCheck(rows, engine, opts) {
    const { convertETtoUT } = engine;
    console.log('');
    console.log('Cross-check vs IMCCE OPALE (INPOP19A) greatest-eclipse circumstances');
    const gcDeltas = [];
    const dtDeltas = [];
    for (const e of rows) {
        const tdSec = e.tdMs / 1000 - 978307200;
        const utSec = convertETtoUT(tdSec);
        const utDate = new Date((utSec + 978307200) * 1000);
        const date = utDate.toISOString().slice(0, 10);
        // A raw OPALE response is ~800 KB of visibility polylines; only the
        // `greatest` event is read, so that is all the cache keeps.
        const condense = (raw) => {
            let g = null;
            try { g = JSON.parse(raw).response.data[0].events.greatest ?? null; } catch { /* keep null */ }
            return JSON.stringify({ greatest: g });
        };
        const text = await fetchText(`${OPALE}/${date}`, opts.cache, condense);
        let greatest = null;
        try {
            greatest = JSON.parse(text).greatest;
        } catch { /* fall through to the no-record line */ }
        if (!greatest) {
            console.log(`${date} ${e.kind.padEnd(14)} no OPALE record`);
            continue;
        }
        const [lonO, latO] = greatest.location.geometry.coordinates;
        const gcArcmin = Math.hypot(
            latO - e.lat,
            (((lonO - e.lon + 540) % 360) - 180) * Math.cos(latO * RAD)
        ) * 60;
        const dtSec = (utDate.getTime() - Date.parse(`${greatest.date}Z`)) / 1000;
        gcDeltas.push(gcArcmin);
        dtDeltas.push(Math.abs(dtSec));
        console.log(
            `${date} ${e.kind.padEnd(14)} GE Δ ${fmt(gcArcmin, 6, 2)}′ (ours ${e.lat.toFixed(4)},${e.lon.toFixed(4)} vs ${latO.toFixed(4)},${lonO.toFixed(4)}) ` +
            `instant Δ ${fmt(dtSec, 6, 1)} s  their UT1−TT ${greatest['UT1-TT']}`
        );
    }
    const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    if (gcDeltas.length) {
        console.log(`OPALE GE position Δ median ${median(gcDeltas).toFixed(2)}′ max ${Math.max(...gcDeltas).toFixed(2)}′; instant Δ median ${median(dtDeltas).toFixed(1)} s max ${Math.max(...dtDeltas).toFixed(1)} s (${gcDeltas.length} rows)`);
    }
}

await main();
