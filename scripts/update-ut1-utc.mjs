#!/usr/bin/env node
/**
 * update-ut1-utc.mjs — regenerate src/astronomy/es-ut1-utc.ts, the UT1−UTC
 * (DUT1) series behind the Earth-rotation side of ΔT (see
 * planning/2026-10-28-continuous-utc-ut1.md).
 *
 * Run this by hand about once a year, or whenever the build prints the
 * "UT1−UTC table is stale" warning; it is NOT part of the build (build.sh
 * only checks the committed file's date).
 *
 *   node scripts/update-ut1-utc.mjs
 *   node scripts/update-ut1-utc.mjs --cache /tmp/iers    # reuse downloads
 *   node scripts/update-ut1-utc.mjs --out /tmp/x.ts      # dry run
 *
 * Sources — both from the IERS Rapid Service / Prediction Centre (USNO):
 *
 *   finals.all     one line per day from 1973-01-02 with the Bulletin A
 *                  UT1−UTC (cols 59–68, 'I' observed / 'P' predicted in
 *                  col 58), running about a year past the issue date
 *   bulletinA.txt  the weekly bulletin, for its "long range" line
 *                  UT1-UTC = a + b (MJD − m) − (UT2−UT1), which gives the
 *                  slope used past the end of the predictions
 *
 * The generated table samples finals.all once a month, in a form with the
 * leap-second steps removed: what is stored is
 *
 *     u(t) = (UT1 − UTC)(t) − (TAI − UTC)(t) + 37
 *
 * i.e. UT1 − TAI shifted so that u = UT1 − UTC from 2017 on. UT1 − TAI is
 * smooth (the Earth doesn't step), so linear interpolation between monthly
 * samples is good to a few ms; the runtime adds back the exact TAI−UTC
 * step from es-leap-second.ts. Storing raw UT1−UTC instead would smear
 * every leap second across the month before it.
 *
 * Anything unexpected in either file is a hard failure rather than a
 * guess: a mis-parsed column would put every hour angle seconds off with
 * nothing to notice it.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FINALS_SOURCES = [
    'https://datacenter.iers.org/data/latestVersion/finals.all.iau2000.txt',
    'https://maia.usno.navy.mil/ser7/finals.all',
];
const BULLETIN_A_SOURCES = [
    'https://datacenter.iers.org/data/latestVersion/bulletinA.txt',
    'https://maia.usno.navy.mil/ser7/ser7.dat',
];

/** MJD of 2001-01-01 00:00:00 UTC, the Apple epoch. */
const MJD_APPLE_EPOCH = 51910;
/** Apple epoch → Unix epoch, in seconds. */
const APPLE_TO_UNIX = 978307200;
/** The first line of finals.all, by construction. */
const FIRST_ROW_MJD = 41684;           // 1973-01-02
/** TAI−UTC in force at the end of the leap table (and, now, forever). */
const FINAL_TAI_MINUS_UTC = 37;
/** Continuous UTC: no leap second after this instant (CGPM Res. 5, 2026). */
const CONTINUOUS_UTC_MJD = 61545;      // 2027-05-20
/** Build warning fires this long after the last sample (Steve: 12 months). */
const STALE_AFTER_MONTHS = 12;
/** 2 × 32 s/cy² — the secular tidal/GIA acceleration of ΔT, in s/yr². */
const SECULAR_CURVATURE = 0.0064;

const LEAP_TABLE = join(ROOT, 'src/astronomy/es-leap-second.ts');

function die(message) {
    console.error(`update-ut1-utc: ${message}`);
    process.exit(1);
}

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
    const opts = {
        out: join(ROOT, 'src/astronomy/es-ut1-utc.ts'),
        cache: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const val = argv[i + 1];
        if (arg === '--out' || arg === '--cache') {
            if (!val) die(`${arg} needs a path`);
            opts[arg.slice(2)] = val;
            i++;
        } else {
            die(`unknown argument ${arg}`);
        }
    }
    return opts;
}

// ------------------------------------------------------------------ fetching

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchFirst(sources, cacheDir) {
    let lastError = null;
    for (const url of sources) {
        const cacheFile = cacheDir ? join(cacheDir, url.replace(/[^A-Za-z0-9]+/g, '_')) : null;
        if (cacheFile && existsSync(cacheFile)) {
            console.log(`Using cached ${url}`);
            return { url, text: readFileSync(cacheFile, 'utf8') };
        }
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const resp = await fetch(url, { redirect: 'follow' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const text = await resp.text();
                if (cacheFile) {
                    mkdirSync(cacheDir, { recursive: true });
                    writeFileSync(cacheFile, text);
                }
                console.log(`Fetched ${url}`);
                return { url, text };
            } catch (err) {
                lastError = err;
                await sleep(1000 * attempt);
            }
        }
        console.warn(`  (${url} unreachable: ${lastError?.message ?? lastError})`);
    }
    die(`no source reachable; last error: ${lastError?.message ?? lastError}`);
}

// ----------------------------------------------------------- finals.all

/**
 * Parse the daily rows. Columns per readme.finals (1-based):
 *   1-2 yy, 3-4 mm, 5-6 dd, 8-15 MJD, 58 flag, 59-68 UT1−UTC.
 * Rows past the end of the predictions carry a blank UT1−UTC; the first
 * such row ends the series.
 */
function parseFinals(text) {
    const rows = [];
    let lineNo = 0;
    for (const line of text.split('\n')) {
        lineNo++;
        if (!line.trim()) continue;
        if (line.length < 68) die(`finals line ${lineNo} is only ${line.length} chars`);
        const field = line.slice(58, 68);
        if (!field.trim()) break;                       // predictions exhausted
        const yy = Number(line.slice(0, 2));
        const mm = Number(line.slice(2, 4));
        const dd = Number(line.slice(4, 6));
        const mjd = Number(line.slice(7, 15));
        const flag = line[57];
        const ut1utc = Number(field);
        if (![yy, mm, dd, mjd, ut1utc].every(Number.isFinite)) {
            die(`finals line ${lineNo}: unparsable fields ${JSON.stringify(line.slice(0, 68))}`);
        }
        if (flag !== 'I' && flag !== 'P') die(`finals line ${lineNo}: flag ${JSON.stringify(flag)}`);
        if (!Number.isInteger(mjd)) die(`finals line ${lineNo}: fractional MJD ${mjd}`);
        const year = mjd <= 51543 ? 1900 + yy : 2000 + yy;
        // The calendar columns must agree with the MJD column.
        const isoFromMjd = isoDay(mjdToApple(mjd));
        const isoFromCols = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
        if (isoFromMjd !== isoFromCols) {
            die(`finals line ${lineNo}: MJD ${mjd} is ${isoFromMjd} but columns say ${isoFromCols}`);
        }
        rows.push({ mjd, dd, flag, ut1utc });
    }
    if (rows.length === 0) die('no rows parsed from finals.all');
    if (rows[0].mjd !== FIRST_ROW_MJD) die(`first row is MJD ${rows[0].mjd}; expected ${FIRST_ROW_MJD} (1973-01-02)`);
    for (let i = 1; i < rows.length; i++) {
        if (rows[i].mjd !== rows[i - 1].mjd + 1) die(`gap in finals.all at MJD ${rows[i - 1].mjd} → ${rows[i].mjd}`);
        if (rows[i].flag === 'I' && rows[i - 1].flag === 'P') die(`observed row after a predicted one at MJD ${rows[i].mjd}`);
    }
    for (const r of rows) {
        if (r.mjd < CONTINUOUS_UTC_MJD && Math.abs(r.ut1utc) > 0.95) {
            die(`|UT1−UTC| = ${r.ut1utc} at MJD ${r.mjd}, before continuous UTC — mis-parse?`);
        }
    }
    const predicted = rows.filter((r) => r.flag === 'P').length;
    if (predicted < 180) console.warn(`  ! only ${predicted} predicted rows (IERS usually gives ~365)`);
    return rows;
}

/**
 * Detect the leap seconds as the ~±1 s jumps between consecutive days and
 * return TAI−UTC per row, cross-checked against the generated leap table.
 */
function taiMinusUTCPerRow(rows) {
    const leapText = readFileSync(LEAP_TABLE, 'utf8');
    const expected = new Map();                         // apple seconds → TAI−UTC
    for (const m of leapText.matchAll(/^\s*(-?\d+),\s*(\d+),\s*\/\/ /gm)) {
        expected.set(Number(m[1]), Number(m[2]));
    }
    if (expected.size < 28) die(`parsed only ${expected.size} rows out of ${LEAP_TABLE}`);

    // TAI−UTC at the first row (1973-01-02): the last leap entry at or before it.
    const firstApple = mjdToApple(rows[0].mjd);
    let tai = null;
    for (const [t, v] of expected) if (t <= firstApple) tai = v;
    if (tai === null) die('leap table has no entry before 1973-01-02');

    const out = [];
    const seen = new Set();
    for (let i = 0; i < rows.length; i++) {
        if (i > 0) {
            const jump = rows[i].ut1utc - rows[i - 1].ut1utc;
            if (Math.abs(jump) > 0.5) {
                const step = Math.round(jump);
                if (Math.abs(step) !== 1 || Math.abs(jump - step) > 0.05) {
                    die(`jump of ${jump.toFixed(4)} s at MJD ${rows[i].mjd} is not a leap second`);
                }
                const at = mjdToApple(rows[i].mjd);
                if (expected.get(at) !== tai + step) {
                    die(`finals.all steps TAI−UTC to ${tai + step} at ${isoDay(at)}; leap table says ${expected.get(at) ?? 'no leap there'}`);
                }
                tai += step;
                seen.add(at);
            }
        }
        out.push(tai);
    }
    for (const [t, v] of expected) {
        if (t > firstApple && !seen.has(t)) die(`leap table has a step at ${isoDay(t)} (→ ${v}) that finals.all does not show`);
    }
    if (tai !== FINAL_TAI_MINUS_UTC) die(`TAI−UTC ends at ${tai}, expected ${FINAL_TAI_MINUS_UTC}`);
    return out;
}

// ---------------------------------------------------------- Bulletin A

/** UT2−UT1 conventional seasonal term (IERS Bulletin A definition), seconds. */
function ut2MinusUT1(mjd) {
    const T = 2000 + (mjd - 51544.03) / 365.2422;
    const a = 2 * Math.PI * T;
    return 0.022 * Math.sin(a) - 0.012 * Math.cos(a) - 0.006 * Math.sin(2 * a) + 0.007 * Math.cos(2 * a);
}

function parseBulletinA(text) {
    const m = /UT1-UTC\s*=\s*([-+]?\d*\.\d+)\s*([-+])\s*(\d*\.\d+)\s*\(\s*MJD\s*-\s*(\d+)\s*\)\s*-\s*\(\s*UT2-UT1\s*\)/.exec(text);
    if (!m) die('Bulletin A has no "UT1-UTC = a ± b (MJD - m) - (UT2-UT1)" line');
    const a = Number(m[1]);
    const b = (m[2] === '-' ? -1 : 1) * Number(m[3]);
    const mjd0 = Number(m[4]);
    const vol = /Vol\.\s*([IVXLC]+)\s+No\.\s*(\d+)/.exec(text);
    const date = /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/.exec(text);
    if (!vol || !date) die('Bulletin A header: could not find "Vol. … No. …" and an issue date');
    const issue = `${date[3]}-${String(['January','February','March','April','May','June','July','August','September','October','November','December'].indexOf(date[2]) + 1).padStart(2, '0')}-${date[1].padStart(2, '0')}`;
    return { a, b, mjd0, issue, label: `Vol. ${vol[1]} No. ${vol[2]}` };
}

// --------------------------------------------------------------- sampling

const mjdToApple = (mjd) => (mjd - MJD_APPLE_EPOCH) * 86400;
const isoDay = (appleSeconds) => new Date((appleSeconds + APPLE_TO_UNIX) * 1000).toISOString().slice(0, 10);

/** First row, every 1st of the month, and the last row. */
function sample(rows, tai) {
    const samples = [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (i === 0 || r.dd === 1 || i === rows.length - 1) {
            const u = r.ut1utc - tai[i] + FINAL_TAI_MINUS_UTC;
            samples.push({ apple: mjdToApple(r.mjd), ms: Math.round(u * 1000), mjd: r.mjd, flag: r.flag, ut1utc: r.ut1utc });
        }
    }
    for (let i = 1; i < samples.length; i++) {
        const d = Math.abs(samples[i].ms - samples[i - 1].ms);
        if (d > 150) die(`UT1−TAI moves ${d} ms between ${isoDay(samples[i - 1].apple)} and ${isoDay(samples[i].apple)} — a leap step leaked through?`);
    }
    return samples;
}

// ---------------------------------------------------------------- generation

function addMonths(iso, months) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + months);
    return d.toISOString().slice(0, 10);
}

function generate(samples, rows, bulletin, meta) {
    const first = samples[0];
    const last = samples[samples.length - 1];
    const lastObserved = rows.filter((r) => r.flag === 'I').at(-1);
    const slopePerYear = bulletin.b * 365.25;
    // Backward extrapolation for 1972 (the year before finals.all starts):
    // the smooth series' slope over its first year, in s/s.
    const yearIn = samples.findIndex((x) => x.apple >= first.apple + 365 * 86400);
    if (yearIn < 2) die('fewer than a year of samples to take the opening slope from');
    const preSlope = (samples[yearIn].ms - first.ms) / 1000 / (samples[yearIn].apple - first.apple);
    const staleAfter = addMonths(isoDay(last.apple), STALE_AFTER_MONTHS);

    // One line per calendar year: "/* 1973 */ t,ms, t,ms, …"
    const byYear = new Map();
    for (const s of samples) {
        const y = isoDay(s.apple).slice(0, 4);
        if (!byYear.has(y)) byYear.set(y, []);
        byYear.get(y).push(`${s.apple},${s.ms}`);
    }
    const tableLines = [...byYear].map(([y, parts]) => `    /* ${y} */ ${parts.join(', ')},`);

    return `/**
 * UT1−UTC (DUT1) series and far-future model — GENERATED FILE, DO NOT EDIT.
 *
 * Regenerate with:  node scripts/update-ut1-utc.mjs
 *
 * Sources (IERS Rapid Service / Prediction Centre):
 *   ${meta.finalsUrl}
 *     rows ${isoDay(mjdToApple(rows[0].mjd))} … ${isoDay(last.apple)}; observed through ${isoDay(mjdToApple(lastObserved.mjd))}, predicted after
 *   ${meta.bulletinUrl}
 *     Bulletin A ${bulletin.label}, ${bulletin.issue}; long-range line
 *     UT1-UTC = ${bulletin.a} ${bulletin.b < 0 ? '-' : '+'} ${Math.abs(bulletin.b)} (MJD - ${bulletin.mjd0}) - (UT2-UT1)
 *
 * What is stored is NOT UT1−UTC but the leap-step-free series
 *
 *     u(t) = (UT1 − UTC)(t) − (TAI − UTC)(t) + ${FINAL_TAI_MINUS_UTC}
 *
 * sampled on the 1st of every month (plus the first and last rows of the
 * source). UT1 − TAI is smooth, so linear interpolation is good to a few
 * ms; the accessor adds back the exact TAI−UTC step from es-leap-second.ts,
 * which makes u identical to UT1−UTC from 2017-01-01 on. See
 * planning/2026-10-28-continuous-utc-ut1.md §3b.
 *
 * Past the last sample the series continues with the model
 *
 *     DUT1(t) = DUT1(t₀) + s·τ − ½·c·τ²        τ = years past t₀
 *
 * where s is the slope of Bulletin A's long-range line (the IERS's own
 * statement of the current trend) and c = 2 × 32 s/cy² is the secular
 * tidal/post-glacial acceleration of ΔT (Morrison & Stephenson). Level and
 * slope from the IERS, curvature from physics, nothing else claimed; the
 * conventional ±0.03 s seasonal term (UT2−UT1) is ignored. Honest
 * uncertainty: ±1 s at 10 years, ±several s at 30, ±10–20 s per century.
 *
 * All times are Apple-epoch seconds (since 2001-01-01 00:00:00 UTC);
 * stored values are integer milliseconds.
 */

import { kECLeapTableFinalTAIMinusUTC, taiMinusUTCForDateInterval } from './es-leap-second';

/* UT1-TABLE-ENDS ${isoDay(last.apple)} STALE-AFTER ${staleAfter} — build.sh greps this line. */

/** First sample (${isoDay(first.apple)}): before it the smooth series is extrapolated
 *  backward at \`kECUT1PreTableSlope\`. */
export const kECUT1TableFirstSample = ${first.apple};

/** Slope of the smooth series over its first year, s/s (${(preSlope * 31557600).toFixed(3)} s/yr),
 *  used to extend it back over 1972, the one year of the leap-second era
 *  finals.all does not cover. Checked against Meeus's 1972 ΔT in the tests;
 *  before 1972 UT is treated as UT1 and this is never consulted. */
export const kECUT1PreTableSlope = ${preSlope.toExponential(6)};

/** Last sample (${isoDay(last.apple)}), the end of the IERS predictions; the model takes over after it. */
export const kECUT1TableLastSample = ${last.apple};

/** Same instant as an ISO day, for messages and tests. */
export const kECUT1TableLastSampleISO = '${isoDay(last.apple)}';

/** The build warns once today is past this (${STALE_AFTER_MONTHS} months after the last sample). */
export const kECUT1TableStaleAfterISO = '${staleAfter}';

/** Number of (instant, value) pairs in the table. */
export const kECUT1TableEntryCount = ${samples.length};

/** UT1−UTC at the last sample, seconds — the model's anchor. */
export const kECUT1AtLastSample = ${(last.ms / 1000).toFixed(3)};

/** Slope past the last sample, s/yr: Bulletin A's ${bulletin.b} s/day × 365.25. */
export const kECUT1SlopePerYear = ${slopePerYear.toPrecision(6)};

/** Secular curvature of ΔT, s/yr² (2 × 32 s/cy²); DUT1 curves by −½·c·τ². */
export const kECUT1SecularCurvature = ${SECULAR_CURVATURE};

/** Seconds in a Julian year. */
const kSecondsPerYear = 31557600;

/**
 * The table, flattened to (Apple-epoch instant, u in integer ms) pairs,
 * one line per calendar year.
 */
const ut1Table: readonly number[] = [
${tableLines.join('\n')}
];

/** Last-segment cache: consecutive calls are almost always in the same month. */
let _cachedIndex = 0;

/** The stored, leap-step-free series u(t) (see the header), seconds. */
function smoothSeriesForDateInterval(dateInterval: number): number {
    const n = ut1Table.length;
    if (dateInterval <= ut1Table[0]) {
        return (ut1Table[1] + (dateInterval - ut1Table[0]) * kECUT1PreTableSlope * 1000) / 1000;
    }
    if (dateInterval >= ut1Table[n - 2]) {
        return ut1Table[n - 1] / 1000;
    }
    // Fast path: still inside the cached segment?
    let i = _cachedIndex;
    if (!(dateInterval >= ut1Table[i] && dateInterval < ut1Table[i + 2])) {
        // Binary search over pairs for the last instant at or before the date.
        let lo = 0;
        let hi = n / 2 - 2;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (ut1Table[mid * 2] <= dateInterval) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        i = lo * 2;
        _cachedIndex = i;
    }
    const t0 = ut1Table[i];
    const t1 = ut1Table[i + 2];
    const f = (dateInterval - t0) / (t1 - t0);
    return (ut1Table[i + 1] + (ut1Table[i + 3] - ut1Table[i + 1]) * f) / 1000;
}

/**
 * UT1 − UTC, in seconds, at \`dateInterval\` (Apple-epoch seconds).
 *
 * Table-backed (IERS observed + predicted) through ${isoDay(last.apple)}, then the
 * slope-plus-curvature model; before ${isoDay(first.apple)} the smooth series is
 * extrapolated back linearly, which covers 1972 to a few hundredths of a
 * second. Callers treat UT as UT1 before 1972 and don't ask.
 */
export function ut1MinusUTCForDateInterval(dateInterval: number): number {
    if (dateInterval > kECUT1TableLastSample) {
        const tau = (dateInterval - kECUT1TableLastSample) / kSecondsPerYear;
        return kECUT1AtLastSample + kECUT1SlopePerYear * tau
            - 0.5 * kECUT1SecularCurvature * tau * tau;
    }
    return smoothSeriesForDateInterval(dateInterval)
        + taiMinusUTCForDateInterval(dateInterval) - kECLeapTableFinalTAIMinusUTC;
}

/** The raw table, for tests that audit it row by row. */
export function ut1TableEntries(): { dateInterval: number; smoothMs: number }[] {
    const out: { dateInterval: number; smoothMs: number }[] = [];
    for (let i = 0; i < ut1Table.length; i += 2) {
        out.push({ dateInterval: ut1Table[i], smoothMs: ut1Table[i + 1] });
    }
    return out;
}
`;
}

// ---------------------------------------------------------------------- main

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const finals = await fetchFirst(FINALS_SOURCES, opts.cache);
    const bulletinA = await fetchFirst(BULLETIN_A_SOURCES, opts.cache);

    const rows = parseFinals(finals.text);
    const tai = taiMinusUTCPerRow(rows);
    const bulletin = parseBulletinA(bulletinA.text);

    // Cross-check the two products: the long-range line evaluated at the
    // last prediction row should land near that row's value.
    const last = rows[rows.length - 1];
    const fromLine = bulletin.a + bulletin.b * (last.mjd - bulletin.mjd0) - ut2MinusUT1(last.mjd);
    const diff = fromLine - last.ut1utc;
    if (Math.abs(diff) > 0.2) {
        die(`Bulletin A long-range line gives ${fromLine.toFixed(4)} at the last finals row (${last.ut1utc}); ` +
            `${diff.toFixed(4)} s apart — different vintages, or a mis-parse`);
    }
    if (Math.abs(diff) > 0.05) console.warn(`  ! long-range line vs last row differ by ${diff.toFixed(3)} s`);

    const samples = sample(rows, tai);
    const observed = rows.filter((r) => r.flag === 'I').length;
    console.log(`Parsed ${rows.length} daily rows (${observed} observed, ${rows.length - observed} predicted), ` +
        `${samples.length} samples ${isoDay(samples[0].apple)} … ${isoDay(samples.at(-1).apple)}`);
    console.log(`Bulletin A ${bulletin.label} (${bulletin.issue}): slope ${bulletin.b} s/day = ${(bulletin.b * 365.25).toFixed(4)} s/yr; ` +
        `line vs last row ${diff.toFixed(4)} s`);

    writeFileSync(opts.out, generate(samples, rows, bulletin, { finalsUrl: finals.url, bulletinUrl: bulletinA.url }));
    console.log(`Wrote ${opts.out}`);
}

await main();
