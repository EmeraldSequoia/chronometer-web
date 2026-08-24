#!/usr/bin/env node
/**
 * verify-wb-envelopes.mjs — sample the engine's geocentric apparent
 * longitudes against JPL Horizons (DE44x) inside each epoch band of the
 * Willmann-Bell books' back-cover accuracy tables, transcribed in
 * "Sheet 1-Moon.csv" and "Sheet 1-Sun & Planets.csv" at the repo root.
 * Those tables promise a maximum error of "the longitude in degrees" per
 * body per period — this script measures what the engine actually does,
 * 3 sample epochs per band (15% / 50% / 85%), a sanity check rather than
 * a max-error search.
 *
 * Method: both sides are evaluated at the same TT instant (engine fed TDT
 * centuries directly, Horizons queried with TIME_TYPE=TT), so ΔT never
 * enters. The engine's apparent RA/Dec (true equator & equinox of date —
 * the same airless `(a-app)` frame verify-eclipse-horizons.mjs validated)
 * and Horizons' are both rotated to ecliptic-of-date with the SAME mean
 * obliquity, so the rotation cancels and Δλ isolates the series error
 * (plus ~0.2″ of nutation-truncation noise common to every tier). As a
 * pipeline check, Horizons' ObsEcLon column is reproduced from Horizons'
 * own RA/Dec through the same rotation (sub-arcsecond agreement expected —
 * ObsEcLon is documented IAU76/80 ecliptic-of-date and verified to be the
 * true-equinox rotation of the a-app position).
 *
 * Tier policy (per Steve): the Moon runs Full precision in every band
 * (production always uses Full); Mid/Low are additionally measured only in
 * bands whose Full cell is blank on the back cover, and only where their
 * own cell has a printed value. Measurements against a blank cell are
 * reported as informational — the books promise nothing there.
 *
 * Caveat for epochs far from J2000: the raw Δλ measures the engine against
 * modern truth (DE44x), while the back covers promise fidelity to the
 * parent theories as built. Two known model-era gaps separate those:
 *   - Moon: the 1991 theory's tidal secular acceleration differs from
 *     DE44x's, a signed quadratic drift in mean longitude. The report fits
 *     Δλ ≈ a·t² over the Full-tier samples and shows per-cell residuals.
 *   - Sun/planets: equinox-realization (precession-model) differences
 *     appear as a common-mode Δλ shared by all bodies at the same epoch —
 *     estimated from the Sun+inner-planet median so body-specific series
 *     error can be judged separately.
 *
 * Manual and evidence-generating only — never part of build or CI.
 * Responses are cached in scripts/horizons-cache/ (committed), so re-runs
 * are offline and byte-stable. Live runs are sequential and paced per
 * JPL's fair-use policy (~45 calls on a cold cache).
 *
 *   node scripts/verify-wb-envelopes.mjs             # everything
 *   node scripts/verify-wb-envelopes.mjs --only moon
 *   node scripts/verify-wb-envelopes.mjs --cache /tmp/h
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HORIZONS = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const AU_KM = 149597870.691;
const RAD = Math.PI / 180;
const ARCSEC = 3600;
const J2000_JD = 2451545.0;

const TIER = { Low: 0, Mid: 1, Full: 2 };
const TIER_NAME = ['low', 'mid', 'full'];

/** body key → { horizons COMMAND, ECPlanetNumber }. Mars..Neptune use the
 *  system BARYCENTERS: planet-center ephemerides only span A.D. 1600+, while
 *  the barycenters ride DE441's full ±13000-year span, and the offset
 *  (≤ ~130 km, satellite-driven) is ≤ 0.05″ as seen from Earth — far below
 *  every envelope. Mercury/Venus centers are moonless and span-complete. */
const BODIES = {
    sun:     { command: '10',  planet: 0 },
    moon:    { command: '301', planet: 1 },
    mercury: { command: '199', planet: 2 },
    venus:   { command: '299', planet: 3 },
    mars:    { command: '4',   planet: 5 },
    jupiter: { command: '5',   planet: 6 },
    saturn:  { command: '6',   planet: 7 },
    uranus:  { command: '7',   planet: 8 },
    neptune: { command: '8',   planet: 9 },
};

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
    const opts = { cache: join(ROOT, 'scripts/horizons-cache'), only: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--cache') {
            if (!argv[i + 1]) die('--cache needs a path');
            opts.cache = argv[++i];
        } else if (arg === '--only') {
            const body = (argv[i + 1] ?? '').toLowerCase();
            if (!(body in BODIES)) die(`--only needs one of: ${Object.keys(BODIES).join(', ')}`);
            opts.only = body;
            i++;
        } else {
            die(`unknown argument ${arg}`);
        }
    }
    return opts;
}

function die(message) {
    console.error(`verify-wb-envelopes: ${message}`);
    process.exit(1);
}

// ---------------------------------------------------------- envelope tables

/**
 * Parse a back-cover CSV: header row of "A to B" year bands, then one row
 * per series with blank cells preserved as null. Years like "-4000" /
 * "+2800" are astronomical numbering (year 0 exists).
 */
function parseEnvelopeCsv(path) {
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const header = lines[1].split(',').slice(1);
    const bands = header.map((h) => {
        const m = h.trim().match(/^([+-]?\d+)\s+to\s+([+-]?\d+)$/);
        if (!m) die(`unparsable band "${h}" in ${path}`);
        return { y0: Number(m[1]), y1: Number(m[2]) };
    });
    const rows = {};
    for (const line of lines.slice(2)) {
        const cells = line.split(',');
        const name = cells[0].trim();
        rows[name] = bands.map((band, i) => {
            const v = (cells[i + 1] ?? '').trim();
            return v === '' ? null : Number(v);
        });
    }
    return { bands, rows };
}

// ------------------------------------------------------------------ engine

/** Bundle the TypeScript engine in memory (same trick as verify-eclipse-horizons.mjs). */
async function loadEngine() {
    const { build } = await import('esbuild');
    const result = await build({
        stdin: {
            contents: "export { WB_planetApparentPosition } from './willmann-bell';",
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cached fetch, sequential and paced (see verify-eclipse-horizons.mjs). */
async function fetchText(url, cacheDir, condense) {
    // Long URLs (multi-epoch TLISTs) truncate identically, so the name alone
    // is not a safe key — a full-URL hash disambiguates.
    const cacheFile = join(cacheDir,
        url.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 160) + '_' + createHash('sha256').update(url).digest('hex').slice(0, 16));
    if (existsSync(cacheFile)) return readFileSync(cacheFile, 'utf8');

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const resp = await fetch(url, { redirect: 'follow' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const text = condense(await resp.text());
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

/** Keep only what the report reads: version, column header, data, and the
 *  footnote lines that document the ObsEcLon reference frame. */
function condenseHorizons(raw) {
    const keep = [];
    const version = raw.match(/API VERSION:\s*\S+/);
    if (version) keep.push(version[0]);
    const lines = raw.split('\n');
    const soe = lines.indexOf('$$SOE');
    const eoe = lines.indexOf('$$EOE');
    if (soe < 0 || eoe < soe) {
        // Throwing keeps error responses (span limits, outages) out of the
        // cache; fetchText retries then dies with the URL.
        throw new Error(`no ephemeris data: ${lines.filter((l) => /No ephemeris|error/i.test(l)).join('; ') || 'no $$SOE block'}`);
    }
    keep.push(lines[soe - 2] ?? '', lines[soe - 1] ?? '');
    keep.push(...lines.slice(soe, eoe + 1));
    keep.push(...lines.filter((l) => /Obs?EcLon|ecliptic.*(of.date|longitude)/i.test(l) && !/\$\$SOE/.test(l)).slice(0, 6));
    return keep.join('\n');
}

/**
 * One geocentric observer-table query for several TT instants at once.
 * Columns are located by header name, not position.
 */
async function horizonsQuery(command, jdTtList, cacheDir) {
    const params = new URLSearchParams({
        format: 'text',
        COMMAND: `'${command}'`,
        EPHEM_TYPE: 'OBSERVER',
        CENTER: "'500@399'",
        TLIST_TYPE: 'JD',
        TIME_TYPE: 'TT',
        TLIST: `'${jdTtList.map((jd) => jd.toFixed(6)).join(' ')}'`,
        QUANTITIES: "'2,31,20'",
        ANG_FORMAT: 'DEG',
        EXTRA_PREC: 'YES',
        APPARENT: 'AIRLESS',
        CSV_FORMAT: 'YES',
    });
    const url = `${HORIZONS}?${params.toString()}`;
    const text = await fetchText(url, cacheDir, condenseHorizons);

    const version = text.match(/API VERSION:\s*(\S+)/);
    if (!version || !version[1].startsWith('1.')) {
        die(`Horizons API version changed (${version?.[1]}) — re-verify the column layout before trusting this run`);
    }
    const lines = text.split('\n');
    const soe = lines.indexOf('$$SOE');
    const eoe = lines.indexOf('$$EOE');
    if (soe < 0 || eoe < 0) die(`no $$SOE data for target ${command} at JDs ${jdTtList.join(', ')}`);
    const header = lines.slice(Math.max(0, soe - 3), soe).find((l) => /R\.A\./.test(l));
    if (!header) die(`no column header for target ${command}`);
    const cols = header.split(',').map((c) => c.trim());
    const col = (re) => {
        const i = cols.findIndex((c) => re.test(c));
        if (i < 0) die(`column ${re} missing for target ${command}; header: ${header}`);
        return i;
    };
    const iRa = col(/^R\.A\./), iDec = col(/^DEC/);
    const iLon = col(/^ObsEcLon$/), iLat = col(/^ObsEcLat$/);
    const iDelta = col(/^delta$/);

    return lines.slice(soe + 1, eoe).map((line) => {
        const f = line.split(',').map((s) => s.trim());
        const row = {
            raDeg: Number(f[iRa]), decDeg: Number(f[iDec]),
            ecLonDeg: Number(f[iLon]), ecLatDeg: Number(f[iLat]),
            deltaAU: Number(f[iDelta]),
        };
        if (![row.raDeg, row.decDeg, row.ecLonDeg, row.ecLatDeg, row.deltaAU].every(Number.isFinite)) {
            die(`unparsable data line for target ${command}: ${line}`);
        }
        return row;
    });
}

// ------------------------------------------------------------------- math

/** Laskar (1986) mean obliquity, radians; U = TDT centuries since J2000 / 100. */
function meanObliquityRad(tCenturies) {
    const U = tCenturies / 100;
    let eps = 23 * 3600 + 26 * 60 + 21.448;
    const terms = [-4680.93, -1.55, 1999.25, -51.38, -249.67, -39.05, 7.12, 27.87, 5.79, 2.45];
    let p = 1;
    for (const c of terms) { p *= U; eps += c * p; }
    return (eps / 3600) * RAD;
}

/** Rotate equatorial RA/Dec (radians) into ecliptic lon/lat (radians) for a
 *  given obliquity. Used identically on both sides so the rotation cancels. */
function eclipticFromEquatorial(ra, dec, eps) {
    const sinE = Math.sin(eps), cosE = Math.cos(eps);
    const sinRa = Math.sin(ra), cosRa = Math.cos(ra);
    const sinDec = Math.sin(dec), cosDec = Math.cos(dec);
    const lon = Math.atan2(sinRa * cosDec * cosE + sinDec * sinE, cosRa * cosDec);
    const lat = Math.asin(sinDec * cosE - cosDec * sinE * sinRa);
    return { lon: lon < 0 ? lon + 2 * Math.PI : lon, lat };
}

/** Signed smallest difference a−b for angles in degrees. */
function angleDiffDeg(a, b) {
    return ((a - b + 540) % 360) - 180;
}

const fmt = (v, w, p) => v.toFixed(p).padStart(w);

// -------------------------------------------------------------------- main

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const { WB_planetApparentPosition } = await loadEngine();

    const moonCsv = parseEnvelopeCsv(join(ROOT, 'Sheet 1-Moon.csv'));
    const planetsCsv = parseEnvelopeCsv(join(ROOT, 'Sheet 1-Sun & Planets.csv'));

    /** One measurement plan entry per body: bands + per-band tier list. */
    const plans = [];

    {
        const hi = moonCsv.rows['Moon (hi precision)'];
        const mid = moonCsv.rows['Moon (mid precision)'];
        const lo = moonCsv.rows['Moon (lo precision)'];
        plans.push({
            body: 'moon',
            bands: moonCsv.bands.map((band, i) => ({
                ...band,
                tiers: [
                    { tier: TIER.Full, promised: hi[i] },
                    ...(hi[i] === null && mid[i] !== null ? [{ tier: TIER.Mid, promised: mid[i] }] : []),
                    ...(hi[i] === null && lo[i] !== null ? [{ tier: TIER.Low, promised: lo[i] }] : []),
                ],
            })),
        });
    }
    for (const [name, cells] of Object.entries(planetsCsv.rows)) {
        const body = name.toLowerCase();
        if (!(body in BODIES)) die(`unknown body "${name}" in planets CSV`);
        plans.push({
            body,
            bands: planetsCsv.bands
                .map((band, i) => ({ ...band, tiers: [{ tier: null, promised: cells[i] }] }))
                .filter((b) => b.tiers[0].promised !== null),  // blank = outside the printed table (and the outer-planet data tables)
        });
    }

    const selected = opts.only ? plans.filter((p) => p.body === opts.only) : plans;

    console.log('Engine vs JPL Horizons — Willmann-Bell back-cover longitude envelopes');
    console.log('Geocentric apparent, matched TT instants (ΔT excluded); 3 samples per band at 15/50/85%');
    console.log('Δλ = engine − Horizons in apparent ecliptic-of-date longitude; envelopes are the books\' promised max |error|');
    console.log('');

    /** pipeline check: Horizons ObsEcLon reproduced from Horizons' own RA/Dec */
    let rotCheckMax = 0;
    let rotCheckCount = 0;
    /** per-epoch Δλ across Sun+inner planets, for the common-mode (frame) estimate */
    const commonMode = new Map();
    const summary = [];

    for (const plan of selected) {
        const { command, planet } = BODIES[plan.body];
        console.log(`--- ${plan.body} ---`);
        for (const band of plan.bands) {
            const years = [0.15, 0.5, 0.85].map((f) => band.y0 + f * (band.y1 - band.y0));
            const jds = years.map((y) => J2000_JD + (y - 2000) * 365.25);
            const rows = await horizonsQuery(command, jds, opts.cache);
            if (rows.length !== jds.length) die(`expected ${jds.length} rows for ${plan.body}, got ${rows.length}`);

            for (let i = 0; i < rows.length; i++) {
                const eps = meanObliquityRad((jds[i] - J2000_JD) / 36525);
                const jplEc = eclipticFromEquatorial(rows[i].raDeg * RAD, rows[i].decDeg * RAD, eps);
                rotCheckMax = Math.max(rotCheckMax, Math.abs(angleDiffDeg(jplEc.lon / RAD, rows[i].ecLonDeg)) * ARCSEC);
                rotCheckCount++;
            }

            for (const { tier, promised } of band.tiers) {
                const tierLabel = tier === null ? '' : ` ${TIER_NAME[tier]}`;
                const samples = [];
                const parts = [];
                for (let i = 0; i < jds.length; i++) {
                    const t = (jds[i] - J2000_JD) / 36525;       // TDT centuries
                    const U = t / 100;                            // hundred-centuries (engine's planet arg)
                    const eps = meanObliquityRad(t);
                    const pos = WB_planetApparentPosition(planet, U, null, tier ?? TIER.Full);
                    const eng = eclipticFromEquatorial(pos.apparentRightAscension, pos.apparentDeclination, eps);
                    const jpl = eclipticFromEquatorial(rows[i].raDeg * RAD, rows[i].decDeg * RAD, eps);
                    const dLonDeg = angleDiffDeg(eng.lon / RAD, jpl.lon / RAD);
                    const dLatAs = (eng.lat - jpl.lat) / RAD * ARCSEC;
                    const dDistKm = (pos.geocentricDistance - rows[i].deltaAU) * AU_KM;
                    samples.push({ t, dLonDeg });
                    parts.push(`${fmt(dLonDeg * ARCSEC, 9, 2)}″`);

                    if ((tier ?? TIER.Full) === TIER.Full) {
                        if (['sun', 'mercury', 'venus', 'mars'].includes(plan.body)) {
                            const key = jds[i].toFixed(0);
                            if (!commonMode.has(key)) commonMode.set(key, { year: years[i], values: [] });
                            commonMode.get(key).values.push(dLonDeg * ARCSEC);
                        }
                        if (i === jds.length - 1) {
                            parts.push(`| Δβ ${fmt(dLatAs, 7, 2)}″ Δdist ${fmt(dDistKm, 9, 1)} km (last sample)`);
                        }
                    }
                }
                const maxDeg = Math.max(...samples.map((s) => Math.abs(s.dLonDeg)));
                const status = promised === null
                    ? '(no promise — informational)'
                    : maxDeg <= promised ? 'OK' : '*** EXCEEDS ***';
                const bandLabel = `${String(band.y0).padStart(5)}..${String(band.y1).padEnd(5)}`;
                console.log(
                    `${bandLabel}${tierLabel.padEnd(6)} ${parts.join(' ')}  max ${fmt(maxDeg, 8, 5)}° vs ${promised === null ? '   —    ' : fmt(promised, 7, 4) + '°'} ${status}`
                );
                summary.push({ body: plan.body, band, tier, promised, maxDeg, samples, ok: promised === null ? null : maxDeg <= promised });
            }
        }
        console.log('');
    }

    if (rotCheckCount) {
        console.log(`Pipeline check — Horizons ObsEcLon reproduced from Horizons' own RA/Dec via this script's rotation (${rotCheckCount} samples): max |Δ| ${rotCheckMax.toFixed(2)}″${rotCheckMax < 2 ? ' — rotation and column parsing verified.' : ' — UNEXPECTED, distrust the rotation.'}`);
        console.log('');
    }

    // Moon tidal-acceleration diagnostic: the 1991 theory's tidal secular
    // acceleration differs from DE44x's, which shows up against Horizons as
    // a signed quadratic drift of the mean longitude — common to all three
    // tiers, invisible to the books' (truncation-fidelity) envelopes. Fit
    // it from the Full-tier samples and re-judge each printed cell on the
    // residual.
    const moonFull = summary.filter((s) => s.body === 'moon' && s.tier === TIER.Full);
    if (moonFull.length > 3) {
        const pts = moonFull.flatMap((s) => s.samples);
        const a = pts.reduce((acc, p) => acc + p.dLonDeg * p.t * p.t, 0)
                / pts.reduce((acc, p) => acc + p.t ** 4, 0);
        console.log(`Moon tidal-acceleration diagnostic: fit Δλ ≈ a·t² over ${pts.length} Full samples gives a = ${(a * ARCSEC).toFixed(2)}″/cy²`);
        console.log('  (equivalent to a lunar mean-motion secular-acceleration difference of ' + (2 * a * ARCSEC).toFixed(1) + '″/cy² between the 1991 theory and DE44x)');
        console.log('  Residual |Δλ − a·t²| per printed cell:');
        for (const s of summary.filter((x) => x.body === 'moon' && x.promised !== null)) {
            const resid = Math.max(...s.samples.map((p) => Math.abs(p.dLonDeg - a * p.t * p.t)));
            const verdict = resid <= s.promised ? 'within envelope' : 'STILL EXCEEDS';
            console.log(`    ${String(s.band.y0).padStart(5)}..${String(s.band.y1).padEnd(5)} ${TIER_NAME[s.tier].padEnd(4)} raw ${fmt(s.maxDeg, 8, 5)}° → residual ${fmt(resid, 8, 5)}° vs ${fmt(s.promised, 7, 4)}° ${verdict}`);
        }
        console.log('');
    }

    if (commonMode.size) {
        console.log('Common-mode Δλ across Sun/Mercury/Venus/Mars at shared epochs (frame-realization offset estimate; series error is the spread around it):');
        const entries = [...commonMode.values()].filter((e) => e.values.length >= 2).sort((a, b) => a.year - b.year);
        for (const e of entries) {
            const s = [...e.values].sort((x, y) => x - y);
            const median = s[Math.floor(s.length / 2)];
            console.log(`  year ${fmt(e.year, 7, 0)}: median ${fmt(median, 8, 2)}″ over ${e.values.length} bodies (spread ${fmt(s[s.length - 1] - s[0], 7, 2)}″)`);
        }
        console.log('');
    }

    const exceeded = summary.filter((s) => s.ok === false);
    console.log(`Promised cells measured: ${summary.filter((s) => s.ok !== null).length}; within envelope: ${summary.filter((s) => s.ok === true).length}; exceeded: ${exceeded.length}`);
    for (const s of exceeded) {
        console.log(`  *** ${s.body}${s.tier === null ? '' : ' ' + TIER_NAME[s.tier]} ${s.band.y0}..${s.band.y1}: measured ${s.maxDeg.toFixed(5)}° vs promised ${s.promised}°`);
    }
}

await main();
