#!/usr/bin/env node
/**
 * verify-eclipse-intervals.mjs — measure the engine's eclipse *contact
 * times* (and the interval they bound) against JPL Horizons, for every
 * eclipse in the app's table (src/help/eclipse-data.json, 2011–2041).
 *
 * One interval per eclipse, at the table's own point:
 *   total-solar    C2..C3  (totality)        at the greatest-eclipse site
 *   annular-solar  C2..C3  (annularity)      at the greatest-eclipse site
 *   hybrid-solar   whichever of the two the engine's disc sizes give at
 *                  greatest eclipse (hybrids are total at GE)
 *   partial-solar  C1..C4  (the eclipse)     at the greatest-eclipse site
 *   total-lunar    U2..U3  (umbral totality) geocentric
 *   partial-lunar  U1..U4  (umbral eclipse)  geocentric
 *
 * Method: the engine's contact is the root of a contact metric —
 * topocentric Sun/Moon separation minus the disc-sum/difference threshold
 * (solar), or geocentric Moon/anti-Sun separation minus the umbral-shadow
 * threshold (lunar) — exactly the thresholds calculateEclipse classifies
 * with (es-astro.ts:754–821, umbral rule 1.01·π_moon − s_sun + π_sun at
 * :675). Contacts are bisected on the engine, then the SAME metric —
 * engine disc radii, engine shadow rule, engine size/parallax formulas —
 * is applied to Horizons' apparent positions and its root found by Newton
 * iteration: sample Horizons at the current estimate ±20 s, take the
 * quadratic's root, re-query around it, repeat to 0.05 s. The window must
 * stay SHORT — a fixed ±300 s window silently misfits any central phase
 * shorter than it (a 32-second annularity came out 13 s wrong) — and
 * re-querying is what keeps a large shift from being an extrapolation. Because every
 * convention is shared, Δt isolates ephemeris + ΔT-convention
 * differences; Δduration (end minus start) additionally cancels most of
 * ΔT, leaving nearly pure geometry.
 *
 * Both sides run in UT (the app's world): the engine converts through its
 * leap-exact ΔT, Horizons through its own TDB−UT. Inside the leap-second
 * era the two agree; on predicted-era rows Horizons freezes TT−UTC at the
 * last announced leap second (32.184 + 37 = 69.184 s) while the engine
 * extrapolates its rejoined polynomial, and that convention gap (ΔΔT) is
 * reported per row so contact-time offsets can be read against it. (ΔΔT is
 * computed, not queried: Horizons' quantity 30 regressed upstream sometime
 * between 2026-08-18 and 2026-08-23 — the byte-identical query that
 * produced the committed 69.185639 fixtures now returns a constant
 * 1.867199 — so this script does not request it.)
 *
 * Manual and evidence-generating only — never part of build or CI.
 * Responses are cached (condensed) like the sibling verify scripts;
 * re-runs are offline and byte-stable. Live cold-cache runs make 2
 * sequential paced calls per eclipse per iteration, typically 2
 * iterations (~500 total).
 *
 *   node scripts/verify-eclipse-intervals.mjs                 # all rows
 *   node scripts/verify-eclipse-intervals.mjs --only 2024-04-08
 *   node scripts/verify-eclipse-intervals.mjs --kind total-solar
 *   node scripts/verify-eclipse-intervals.mjs --cache /tmp/h
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HORIZONS = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const RAD = Math.PI / 180;
const ARCSEC = 3600;
const APPLE_EPOCH_UNIX = 978307200;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
    const opts = { cache: join(ROOT, 'scripts/horizons-cache'), only: null, kind: null, decompose: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--cache') {
            if (!argv[i + 1]) die('--cache needs a path');
            opts.cache = argv[++i];
        } else if (arg === '--only') {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(argv[i + 1] ?? '')) die('--only needs YYYY-MM-DD');
            opts.only = argv[++i];
        } else if (arg === '--kind') {
            opts.kind = argv[++i];
        } else if (arg === '--decompose') {
            opts.decompose = true;
        } else {
            die(`unknown argument ${arg}`);
        }
    }
    return opts;
}

function die(message) {
    console.error(`verify-eclipse-intervals: ${message}`);
    process.exit(1);
}

// ------------------------------------------------------------------ engine

/** Bundle the TypeScript engine in memory, with a small adapter that
 *  returns the geocentric + topocentric apparent state of both bodies at a
 *  UT instant through the app's own pipeline (null caches throughout). */
async function loadEngine() {
    const { build } = await import('esbuild');
    const adapter = `
import { convertUTToGSTP03, convertGSTtoLST } from './es-sidereal';
import { sunRAandDecl, moonRAAndDecl, topocentricParallax, planetSizeAndParallax, distanceOfPlanetInAU } from './es-coordinates';
import { julianCenturiesSince2000EpochForDateInterval, convertETtoUT } from './es-time';
import { ECPlanetNumber } from './astro-constants';
export { convertETtoUT };
export { kECLeapTableValidUntil } from './es-leap-second';
export const SUN = ECPlanetNumber.Sun;
export const MOON = ECPlanetNumber.Moon;
export function sizeAndParallax(planet: number, distAU: number) {
    return planetSizeAndParallax(planet, distAU);
}
export function eclipseBodies(dateInterval: number, lat: number, lon: number) {
    const gst = convertUTToGSTP03(dateInterval, null);
    const lst = convertGSTtoLST(gst, lon);
    const { julianCenturiesSince2000Epoch: jcse } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, null);
    const state: any = {};
    for (const [key, planet] of [['sun', ECPlanetNumber.Sun], ['moon', ECPlanetNumber.Moon]] as const) {
        const rd = planet === ECPlanetNumber.Sun ? sunRAandDecl(dateInterval, null) : moonRAAndDecl(dateInterval, null);
        const distAU = distanceOfPlanetInAU(planet, jcse, null);
        const H = lst - rd.rightAscension;
        const topo = topocentricParallax(rd.rightAscension, rd.declination, H, distAU, lat, 0);
        state[key] = {
            raGeo: rd.rightAscension, decGeo: rd.declination, distGeoAU: distAU,
            raTopo: lst - topo.Hprime, decTopo: topo.declPrime,
            distTopoAU: distAU * topo.distanceRatio,
        };
    }
    return state;
}
`;
    const result = await build({
        stdin: { contents: adapter, resolveDir: join(ROOT, 'src/astronomy'), loader: 'ts' },
        bundle: true,
        format: 'esm',
        platform: 'node',
        write: false,
    });
    const b64 = Buffer.from(result.outputFiles[0].text).toString('base64');
    return import(`data:text/javascript;base64,${b64}`);
}

// ----------------------------------------------------------------- metrics

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

/** Mirrors umbralAngularRadius (es-astro.ts:675) — traditional 1% enlargement. */
function umbralRadius(moonParallax, sunAngularRadius, sunParallax) {
    return 1.01 * moonParallax - sunAngularRadius + sunParallax;
}

/** A Horizons row as a one-body state (topocentric when the query was
 *  sited; the geo/topo members then hold the same numbers, and each metric
 *  reads only the pair it needs). */
function horBody(row) {
    return {
        raGeo: row.raDeg * RAD, decGeo: row.decDeg * RAD, distGeoAU: row.deltaAU,
        raTopo: row.raDeg * RAD, decTopo: row.decDeg * RAD, distTopoAU: row.deltaAU,
    };
}

/** Mix engine and Horizons states per component, so a contact shift can be
 *  attributed to one body's direction or one body's distance (disc size). */
function hybridState(eng, hor, pick) {
    const mk = (body) => {
        const pos = pick[body + 'Pos'] === 'H' ? hor[body] : eng[body];
        const dist = pick[body + 'Dist'] === 'H' ? hor[body] : eng[body];
        return {
            raGeo: pos.raGeo, decGeo: pos.decGeo, distGeoAU: dist.distGeoAU,
            raTopo: pos.raTopo, decTopo: pos.decTopo, distTopoAU: dist.distTopoAU,
        };
    };
    return { sun: mk('sun'), moon: mk('moon') };
}

/**
 * Contact metrics from a two-body state (either engine-produced or
 * Horizons-produced), using the ENGINE's size/parallax function on both
 * sides so radius conventions cancel. Solar metrics use the topocentric
 * members, lunar the geocentric ones. A metric is zero exactly at contact.
 */
function makeMetrics(engine) {
    return {
        solar(state) {
            const sSun = engine.sizeAndParallax(engine.SUN, state.sun.distTopoAU);
            const sMoon = engine.sizeAndParallax(engine.MOON, state.moon.distTopoAU);
            const sep = separationRad(state.sun.raTopo, state.sun.decTopo, state.moon.raTopo, state.moon.decTopo);
            return {
                outer: sep - (sSun.angularSize + sMoon.angularSize) / 2,          // C1/C4
                innerTotal: sep - (sMoon.angularSize - sSun.angularSize) / 2,     // C2/C3 (total)
                innerAnnular: sep - (sSun.angularSize - sMoon.angularSize) / 2,   // C2/C3 (annular)
                discDelta: (sMoon.angularSize - sSun.angularSize) / 2,            // >0 → total capable
            };
        },
        lunar(state) {
            const sSun = engine.sizeAndParallax(engine.SUN, state.sun.distGeoAU);
            const sMoon = engine.sizeAndParallax(engine.MOON, state.moon.distGeoAU);
            const shadowR = umbralRadius(sMoon.parallax, sSun.angularSize / 2, sSun.parallax);
            const sep = separationRad(state.sun.raGeo + Math.PI, -state.sun.decGeo, state.moon.raGeo, state.moon.decGeo);
            return {
                outer: sep - (sMoon.angularSize / 2 + shadowR),                   // U1/U4
                inner: sep - (shadowR - sMoon.angularSize / 2),                   // U2/U3
            };
        },
    };
}

// ---------------------------------------------------------------- horizons

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function condenseHorizons(raw) {
    const keep = [];
    const version = raw.match(/API VERSION:\s*\S+/);
    if (version) keep.push(version[0]);
    const lines = raw.split('\n');
    const soe = lines.indexOf('$$SOE');
    const eoe = lines.indexOf('$$EOE');
    if (soe < 0 || eoe < soe) {
        throw new Error(`no ephemeris data: ${lines.filter((l) => /No ephemeris|error/i.test(l)).join('; ') || 'no $$SOE block'}`);
    }
    keep.push(lines[soe - 2] ?? '', lines[soe - 1] ?? '');
    keep.push(...lines.slice(soe, eoe + 1));
    return keep.join('\n');
}

/**
 * Observer-table query for a list of UT JD instants. Topocentric when
 * `site` is given (lon/lat degrees at 0 km), geocentric otherwise.
 * Returns [{raDeg, decDeg, deltaAU, tdbMinusUt}] in TLIST order.
 */
async function horizonsQuery(command, site, jdUtList, cacheDir) {
    const params = new URLSearchParams({
        format: 'text',
        COMMAND: `'${command}'`,
        EPHEM_TYPE: 'OBSERVER',
        CENTER: site ? "'coord@399'" : "'500@399'",
        ...(site ? { COORD_TYPE: 'GEODETIC', SITE_COORD: `'${site.lon},${site.lat},0'` } : {}),
        TLIST_TYPE: 'JD',
        TIME_TYPE: 'UT',
        TLIST: `'${jdUtList.map((jd) => jd.toFixed(9)).join(' ')}'`,
        QUANTITIES: "'2,20'",
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
    const header = lines.slice(Math.max(0, soe - 3), soe).find((l) => /R\.A\./.test(l));
    if (!header) die(`no column header for target ${command}`);
    const cols = header.split(',').map((c) => c.trim());
    const col = (re) => {
        const i = cols.findIndex((c) => re.test(c));
        if (i < 0) die(`column ${re} missing for target ${command}; header: ${header}`);
        return i;
    };
    const iRa = col(/^R\.A\./), iDec = col(/^DEC/), iDelta = col(/^delta$/);

    const rows = lines.slice(soe + 1, eoe).map((line) => {
        const f = line.split(',').map((s) => s.trim());
        const row = { raDeg: Number(f[iRa]), decDeg: Number(f[iDec]), deltaAU: Number(f[iDelta]) };
        if (![row.raDeg, row.decDeg, row.deltaAU].every(Number.isFinite)) {
            die(`unparsable data line for target ${command}: ${line}`);
        }
        return row;
    });
    if (rows.length !== jdUtList.length) {
        die(`expected ${jdUtList.length} rows for target ${command}, got ${rows.length}`);
    }
    return rows;
}

/**
 * horizonsQuery for epochs in ARBITRARY order: Horizons sorts TLIST
 * chronologically before output (the C2/C3 sample windows interleave when
 * totality is short), so send it sorted and un-sort the result.
 */
async function horizonsQueryOrdered(command, site, jdUtList, cacheDir) {
    const order = [...jdUtList.keys()].sort((a, b) => jdUtList[a] - jdUtList[b]);
    const rows = await horizonsQuery(command, site, order.map((i) => jdUtList[i]), cacheDir);
    const out = new Array(jdUtList.length);
    order.forEach((origIdx, sortedPos) => { out[origIdx] = rows[sortedPos]; });
    return out;
}

// ------------------------------------------------------------ root finding

/** Bisect metric(t) to ~1 ms inside a bracketing interval. */
function bisect(metric, tLo, tHi) {
    let mLo = metric(tLo);
    for (let i = 0; i < 60 && tHi - tLo > 0.001; i++) {
        const tMid = (tLo + tHi) / 2;
        const mMid = metric(tMid);
        if ((mLo < 0) === (mMid < 0)) { tLo = tMid; mLo = mMid; } else { tHi = tMid; }
    }
    return (tLo + tHi) / 2;
}

/** Find the (first, last) roots of metric(t) in [t0−span, t0+span]. */
function findContacts(metric, t0, span, stepSec) {
    const crossings = [];
    let prevT = t0 - span;
    let prevM = metric(prevT);
    for (let t = prevT + stepSec; t <= t0 + span + 1e-9; t += stepSec) {
        const m = metric(t);
        if ((prevM < 0) !== (m < 0)) crossings.push(bisect(metric, prevT, t));
        prevT = t; prevM = m;
    }
    return crossings;
}

/** Root of the quadratic through (t1,m1)(t2,m2)(t3,m3) nearest t2. */
function quadraticRoot(t1, m1, t2, m2, t3, m3) {
    // Shift to x = t − t2 for conditioning.
    const x1 = t1 - t2, x3 = t3 - t2;
    const a = (m3 * x1 - m1 * x3 + m2 * (x3 - x1)) / (x1 * x3 * (x3 - x1));
    const b = (m3 - m1) / (x3 - x1) - a * (x1 + x3);
    const c = m2;
    if (Math.abs(a) < 1e-18) return t2 - c / b;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return t2 - c / b;   // fall back to the secant when the parabola misses zero
    const r1 = (-b + Math.sqrt(disc)) / (2 * a);
    const r2 = (-b - Math.sqrt(disc)) / (2 * a);
    return t2 + (Math.abs(r1) < Math.abs(r2) ? r1 : r2);
}

// -------------------------------------------------------------------- main

const fmt = (v, w, p) => v.toFixed(p).padStart(w);
const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const data = JSON.parse(readFileSync(join(ROOT, 'src/help/eclipse-data.json'), 'utf8'));
    const engine = await loadEngine();
    const metrics = makeMetrics(engine);

    let rows = data.eclipses;
    if (opts.only) rows = rows.filter((e) => new Date(e.tdMs).toISOString().startsWith(opts.only));
    if (opts.kind) rows = rows.filter((e) => e.kind === opts.kind);
    if (rows.length === 0) die('no matching eclipse rows');

    console.log(`Engine vs JPL Horizons — eclipse contact times and intervals, ${rows.length} rows`);
    console.log('Δ = Horizons-implied − engine, seconds (positive: engine contact is early); era P = past the leap table, both ΔTs are predictions');
    console.log('Solar rows at the greatest-eclipse site (airless topocentric); lunar rows geocentric umbral, engine shadow rule on both sides');
    console.log('');

    const stats = { start: [], end: [], dur: [], startP: [], endP: [], durP: [] };
    const skipped = [];

    for (const e of rows) {
        const date = new Date(e.tdMs).toISOString().slice(0, 10);
        const tdSec = e.tdMs / 1000 - APPLE_EPOCH_UNIX;
        const t0 = engine.convertETtoUT(tdSec);
        const deltaTEng = tdSec - t0;
        const predictedEra = t0 > engine.kECLeapTableValidUntil;
        const latRad = e.lat * RAD, lonRad = e.lon * RAD;
        const solar = e.kind.endsWith('-solar');

        // Choose the contact metric for this row's single interval.
        let metricName, metricKey;
        if (solar) {
            const m0 = metrics.solar(engine.eclipseBodies(t0, latRad, lonRad));
            if (e.kind === 'partial-solar') {
                metricName = 'C1..C4';
                metricKey = 'outer';
            } else if (e.kind === 'total-solar' || (e.kind === 'hybrid-solar' && m0.discDelta >= 0)) {
                metricName = e.kind === 'hybrid-solar' ? 'C2..C3 (total@GE)' : 'C2..C3';
                metricKey = 'innerTotal';
            } else {
                metricName = e.kind === 'hybrid-solar' ? 'C2..C3 (annular@GE)' : 'C2..C3';
                metricKey = 'innerAnnular';
            }
        } else {
            metricName = e.kind === 'total-lunar' ? 'U2..U3' : 'U1..U4';
            metricKey = e.kind === 'total-lunar' ? 'inner' : 'outer';
        }
        const metric = solar
            ? (t) => metrics.solar(engine.eclipseBodies(t, latRad, lonRad))[metricKey]
            : (t) => metrics.lunar(engine.eclipseBodies(t, 0, 0))[metricKey];

        // Engine contacts: central solar phases live within minutes of GE;
        // partial-solar and umbral-lunar phases within a few hours.
        // Central phases can be seconds long, so scan them finely enough that
        // both contacts cannot hide inside one step.
        const central = e.kind === 'total-solar' || e.kind === 'annular-solar' || e.kind === 'hybrid-solar';
        const span = central ? 1800 : 4 * 3600;
        const contacts = findContacts(metric, t0, span, central ? 5 : 60);
        if (contacts.length !== 2) {
            skipped.push(`${date} ${e.kind}: ${contacts.length} engine crossings of ${metricName} (min metric ${(Math.min(...[-span, 0, span].map((dt) => metric(t0 + dt))) / RAD * ARCSEC).toFixed(1)}″)`);
            continue;
        }
        const [tStart, tEnd] = contacts;

        // Newton-iterate Horizons' root of the same metric, keeping the
        // sampling window short so the quadratic stays a local model.
        const OFF = 20;
        const site = solar ? { lon: e.lon, lat: e.lat } : null;
        const M = (st) => (solar ? metrics.solar(st) : metrics.lunar(st))[metricKey];
        let est = [0, 0];
        let epochs, sunRows, moonRows, horStates, iters = 0;
        for (; iters < 5; iters++) {
            epochs = [
                tStart + est[0] - OFF, tStart + est[0], tStart + est[0] + OFF,
                tEnd + est[1] - OFF, tEnd + est[1], tEnd + est[1] + OFF,
            ];
            const jds = epochs.map((t) => (t + APPLE_EPOCH_UNIX) / 86400 + 2440587.5);
            sunRows = await horizonsQueryOrdered('10', site, jds, opts.cache);
            moonRows = await horizonsQueryOrdered('301', site, jds, opts.cache);
            horStates = epochs.map((_, i) => ({ sun: horBody(sunRows[i]), moon: horBody(moonRows[i]) }));
            const mH = horStates.map(M);
            const next = [
                quadraticRoot(epochs[0], mH[0], epochs[1], mH[1], epochs[2], mH[2]) - tStart,
                quadraticRoot(epochs[3], mH[3], epochs[4], mH[4], epochs[5], mH[5]) - tEnd,
            ];
            const moved = Math.max(Math.abs(next[0] - est[0]), Math.abs(next[1] - est[1]));
            est = next;
            if (moved < 0.05) break;
        }
        const [dStart, dEnd] = est;
        const durEng = tEnd - tStart;
        const dDur = dEnd - dStart;
        // Horizons' predicted-era convention freezes TT−UTC at the last leap
        // second (none announced beyond 37 s); the engine extrapolates. In the
        // leap era both are leap-exact and agree identically.
        const dDt = predictedEra ? deltaTEng - (32.184 + 37) : 0;

        (predictedEra ? stats.startP : stats.start).push(Math.abs(dStart));
        (predictedEra ? stats.endP : stats.end).push(Math.abs(dEnd));
        (predictedEra ? stats.durP : stats.dur).push(Math.abs(dDur));

        console.log(
            `${date} ${e.kind.padEnd(13)}${predictedEra ? 'P' : ' '} ${metricName.padEnd(18)} ` +
            `start Δ ${fmt(dStart, 7, 2)}s  end Δ ${fmt(dEnd, 7, 2)}s | ` +
            `dur eng ${fmt(durEng / 60, 7, 2)}m Δ ${fmt(dDur, 6, 2)}s | ΔΔT ${predictedEra ? fmt(dDt, 6, 2) + 's' : '  --  '}`
        );

        // Attribute each contact shift to one body's direction or disc size.
        // Δt ≈ −m_horizons(t_engine) / (dm/dt), and the metric is near-linear
        // in each component, so swapping one component at a time partitions
        // the shift into seconds.
        if (opts.decompose) {
            const A = (v) => (v / RAD * ARCSEC);
            for (const [label, ci] of [['start', 1], ['end', 4]]) {
                const t = epochs[ci];
                const eng = engine.eclipseBodies(t, solar ? latRad : 0, solar ? lonRad : 0);
                const hor = horStates[ci];
                const base = M(eng);
                const rate = (metric(t + 1) - metric(t - 1)) / 2;
                const E = { sunPos: 'E', sunDist: 'E', moonPos: 'E', moonDist: 'E' };
                const part = (over) => -(M(hybridState(eng, hor, { ...E, ...over })) - base) / rate;
                const dSunPos = part({ sunPos: 'H' }), dSunDist = part({ sunDist: 'H' });
                const dMoonPos = part({ moonPos: 'H' }), dMoonDist = part({ moonDist: 'H' });
                const sum = dSunPos + dSunDist + dMoonPos + dMoonDist;
                const sep = (b) => {
                    const raKey = solar ? 'raTopo' : 'raGeo', decKey = solar ? 'decTopo' : 'decGeo';
                    const dRa = ((hor[b][raKey] - eng[b][raKey]) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
                    return A(Math.hypot(dRa * Math.cos(eng[b][decKey]), hor[b][decKey] - eng[b][decKey]));
                };
                console.log(
                    `    ${label.padEnd(5)} Δ ${fmt(ci === 1 ? dStart : dEnd, 7, 2)}s = sun pos ${fmt(dSunPos, 7, 2)} + sun size ${fmt(dSunDist, 6, 2)} ` +
                    `+ moon pos ${fmt(dMoonPos, 7, 2)} + moon size ${fmt(dMoonDist, 6, 2)} (sum ${fmt(sum, 7, 2)}) | ` +
                    `offsets sun ${fmt(sep('sun'), 5, 2)}″ moon ${fmt(sep('moon'), 5, 2)}″ | rate ${fmt(Math.abs(A(rate)), 6, 4)}″/s`
                );
            }
        }
    }

    console.log('');
    for (const [label, s, e2, d] of [['leap era', stats.start, stats.end, stats.dur], ['predicted era', stats.startP, stats.endP, stats.durP]]) {
        if (!s.length) continue;
        console.log(`${label} (${s.length} rows): |Δstart| median ${median(s).toFixed(2)}s max ${Math.max(...s).toFixed(2)}s; ` +
            `|Δend| median ${median(e2).toFixed(2)}s max ${Math.max(...e2).toFixed(2)}s; ` +
            `|Δduration| median ${median(d).toFixed(2)}s max ${Math.max(...d).toFixed(2)}s`);
    }
    if (skipped.length) {
        console.log('');
        console.log(`skipped ${skipped.length} rows (engine did not produce exactly two crossings at the table point):`);
        for (const s of skipped) console.log(`  ${s}`);
    }
}

await main();
