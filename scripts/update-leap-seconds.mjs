#!/usr/bin/env node
/**
 * update-leap-seconds.mjs — regenerate src/astronomy/es-leap-second.ts, the
 * TAI−UTC table behind ΔT for 1972 onward (see
 * planning/2026-08-18-leap-second-deltat.md).
 *
 * Run this by hand every year or two, or whenever the build prints the
 * "leap-second table expired" warning; it is NOT part of the build (build.sh
 * only checks the committed file's expiry date).
 *
 *   node scripts/update-leap-seconds.mjs
 *   node scripts/update-leap-seconds.mjs --cache /tmp/leap   # reuse download
 *   node scripts/update-leap-seconds.mjs --out /tmp/x.ts     # dry run
 *
 * Source — `leap-seconds.list`, the IERS-maintained machine-readable list of
 * every UTC leap second, republished by IANA with the tz database:
 *
 *   https://data.iana.org/time-zones/data/leap-seconds.list        (primary)
 *   https://hpiers.obspm.fr/iers/bul/bulc/ntp/leap-seconds.list    (origin)
 *
 * The format is one line per TAI−UTC step — `<NTP seconds> <TAI−UTC> # <date>`
 * — plus three metadata lines: `#$` last update, `#@` expiration, and `#h` a
 * SHA-1 over all of those numbers, which this script verifies. The expiration
 * is the reason the file is the right source: the IERS announces leap seconds
 * only about six months ahead (Bulletin C), so `#@` is an authoritative
 * statement of how far into the future the table may be trusted. It becomes
 * `kECLeapTableValidUntil`, past which es-time.ts rejoins the Espenak
 * polynomial rather than pretending to know.
 *
 * Timestamps are NTP-epoch (1900-01-01); the app is Apple-epoch (2001-01-01),
 * so the conversion is a constant −3 187 296 000 s.
 *
 * Anything unexpected in the file is a hard failure rather than a guess: a
 * silently mis-parsed leap-second table would put every lunar position a few
 * arcseconds off with nothing to notice it.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCES = [
    'https://data.iana.org/time-zones/data/leap-seconds.list',
    'https://hpiers.obspm.fr/iers/bul/bulc/ntp/leap-seconds.list',
];

/** NTP epoch (1900-01-01) → Apple epoch (2001-01-01), in seconds. */
const NTP_TO_APPLE = -2208988800 - 978307200;
/** Apple epoch → Unix epoch, in seconds. */
const APPLE_TO_UNIX = 978307200;

/** The first line of the table, by construction: TAI−UTC was 10 s exactly. */
const FIRST_ENTRY_NTP = 2272060800;   // 1972-01-01 00:00:00 UTC
const FIRST_ENTRY_TAI = 10;

/** The iOS table this port must agree with (absent in a fresh clone). */
const IOS_TABLE = join(ROOT, '.estime-ref/src/ESLeapSecond.cpp');

function die(message) {
    console.error(`update-leap-seconds: ${message}`);
    process.exit(1);
}

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
    const opts = {
        out: join(ROOT, 'src/astronomy/es-leap-second.ts'),
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

/**
 * Try each source in turn, with a small retry apiece. A cached copy (--cache)
 * short-circuits both, so re-runs while developing the parser don't hammer
 * IANA or the Paris Observatory.
 */
async function fetchList(cacheDir) {
    let lastError = null;
    for (const url of SOURCES) {
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

// ------------------------------------------------------------------- parsing

function parseList(text) {
    let lastUpdate = null;
    let expires = null;
    let hash = null;
    const entries = [];

    for (const rawLine of text.split('\n')) {
        const line = rawLine.trimEnd();
        if (!line) continue;
        let m;
        if ((m = /^#\$\s+(\d+)$/.exec(line))) {
            lastUpdate = m[1];
        } else if ((m = /^#@\s+(\d+)$/.exec(line))) {
            expires = m[1];
        } else if ((m = /^#h\s+([0-9a-f\s]+)$/.exec(line))) {
            hash = m[1].replace(/\s+/g, '');
        } else if (line.startsWith('#')) {
            continue;                                  // prose and blank comments
        } else if ((m = /^(\d+)\s+(\d+)\s*(?:#\s*(.*))?$/.exec(line))) {
            entries.push({ ntp: m[1], tai: m[2], comment: (m[3] ?? '').trim() });
        } else {
            die(`unrecognized line in leap-seconds.list: ${JSON.stringify(line)}`);
        }
    }

    if (lastUpdate === null) die('no "#$" last-update line');
    if (expires === null) die('no "#@" expiration line');
    if (hash === null) die('no "#h" integrity hash');
    if (entries.length < 28) die(`only ${entries.length} table entries; expected at least 28`);

    // The published hash covers the decimal digits of every number in the
    // file, concatenated in order with no separators. Getting a match proves
    // we read every entry and mis-transcribed none of them.
    const digits = lastUpdate + expires + entries.map((e) => e.ntp + e.tai).join('');
    const computed = createHash('sha1').update(digits).digest('hex');
    if (computed !== hash) {
        die(`integrity hash mismatch: file says ${hash}, computed ${computed}`);
    }

    return { lastUpdate: Number(lastUpdate), expires: Number(expires), hash, entries };
}

/** Convert to Apple epoch and check the shape of the table itself. */
function buildTable(entries) {
    const rows = entries.map((e) => ({
        appleSeconds: Number(e.ntp) + NTP_TO_APPLE,
        taiMinusUTC: Number(e.tai),
        comment: e.comment,
    }));

    if (Number(entries[0].ntp) !== FIRST_ENTRY_NTP || rows[0].taiMinusUTC !== FIRST_ENTRY_TAI) {
        die(`first entry is ${entries[0].ntp}/${entries[0].tai}; ` +
            `expected ${FIRST_ENTRY_NTP}/${FIRST_ENTRY_TAI} (1972-01-01, TAI−UTC = 10 s)`);
    }
    for (let i = 0; i < rows.length; i++) {
        if (!Number.isInteger(rows[i].taiMinusUTC)) {
            die(`entry ${i} has a non-integer TAI−UTC (${rows[i].taiMinusUTC})`);
        }
        if (i > 0) {
            if (rows[i].appleSeconds <= rows[i - 1].appleSeconds) {
                die(`entry ${i} is not later than entry ${i - 1}`);
            }
            const step = rows[i].taiMinusUTC - rows[i - 1].taiMinusUTC;
            if (step === 0) die(`entry ${i} repeats TAI−UTC = ${rows[i].taiMinusUTC}`);
            // A negative leap second has never been issued but is legal; the
            // table stores TAI−UTC directly, so it needs no special handling.
            if (Math.abs(step) !== 1) {
                console.warn(`  ! entry ${i} steps TAI−UTC by ${step}, not ±1 — worth a look`);
            }
        }
    }
    return rows;
}

// ------------------------------------------------------- iOS cross-check

/**
 * The shipping iOS table (ESLeapSecond.cpp) was scraped from Wikipedia in
 * 2016. Compare it entry-for-entry against the canonical list; a mismatch is
 * a bug in the iOS products, not here, and is worth reporting.
 */
function crossCheckIOS(rows) {
    if (!existsSync(IOS_TABLE)) {
        console.log('iOS cross-check skipped (.estime-ref not present)');
        return;
    }
    const text = readFileSync(IOS_TABLE, 'utf8');
    const ios = [];
    for (const m of text.matchAll(/^\s*\{\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\s*\},/gm)) {
        ios.push({ appleSeconds: Number(m[1]), leap: Number(m[2]), cumulative: Number(m[3]) });
    }
    if (ios.length === 0) die(`could not parse any entries out of ${IOS_TABLE}`);

    // iOS lists transitions only: the 1972-01-01 base line has no step, so
    // our row 0 has no iOS counterpart. Its cumulative count is leap seconds
    // since then, i.e. TAI−UTC minus the 10 s that already existed.
    const ours = rows.slice(1);
    const problems = [];
    if (ios.length !== ours.length) {
        problems.push(`entry count: iOS ${ios.length}, canonical ${ours.length}`);
    }
    for (let i = 0; i < Math.min(ios.length, ours.length); i++) {
        const want = {
            appleSeconds: ours[i].appleSeconds,
            leap: ours[i].taiMinusUTC - rows[i].taiMinusUTC,
            cumulative: ours[i].taiMinusUTC - FIRST_ENTRY_TAI,
        };
        for (const key of ['appleSeconds', 'leap', 'cumulative']) {
            if (ios[i][key] !== want[key]) {
                problems.push(`entry ${i} (${ours[i].comment}): iOS ${key}=${ios[i][key]}, canonical ${want[key]}`);
            }
        }
    }
    if (problems.length) {
        console.warn(`\n!!! iOS table disagrees with the canonical list — report to Steve:`);
        for (const p of problems) console.warn(`      ${p}`);
        console.warn('');
    } else {
        console.log(`iOS cross-check: ESLeapSecond.cpp matches all ${ios.length} transitions`);
    }
}

// ---------------------------------------------------------------- generation

const isoDay = (appleSeconds) =>
    new Date((appleSeconds + APPLE_TO_UNIX) * 1000).toISOString().slice(0, 10);

const isoStamp = (appleSeconds) =>
    new Date((appleSeconds + APPLE_TO_UNIX) * 1000).toISOString().replace('.000', '');

function generate(rows, meta) {
    const last = rows[rows.length - 1];
    const validUntil = meta.expires + NTP_TO_APPLE;
    const width = Math.max(...rows.map((r) => String(r.appleSeconds).length));

    const tableLines = rows.map((r) => {
        const t = String(r.appleSeconds).padStart(width);
        const tai = String(r.taiMinusUTC).padStart(2);
        return `    ${t}, ${tai},   // ${r.comment}`;
    });

    return `/**
 * TAI−UTC (leap-second) table — GENERATED FILE, DO NOT EDIT.
 *
 * Regenerate with:  node scripts/update-leap-seconds.mjs
 *
 * Source:  ${meta.url}
 *          (origin ${SOURCES[1]})
 * Last update line (#$): ${isoStamp(meta.lastUpdate + NTP_TO_APPLE)}
 * Expiration line (#@):  ${isoStamp(validUntil)}
 * Integrity hash (#h):   ${meta.hash} — verified at generation time
 *
 * From 1972-01-01 onward, TT−UTC is exact by definition:
 *
 *     TT − UTC = 32.184 s + (TAI − UTC)
 *
 * because TT is a fixed 32.184 s ahead of TAI and TAI−UTC is an integer that
 * changes only at the announced leap seconds tabulated below. That makes ΔT a
 * lookup rather than a fitted polynomial for the whole modern era — see
 * es-time.ts \`convertUTtoET\`, which is the only consumer.
 *
 * The table is authoritative only as far as the IERS has announced, hence
 * \`kECLeapTableValidUntil\`. build.sh warns once today is past it.
 *
 * All times are Apple-epoch seconds (since 2001-01-01 00:00:00 UTC).
 */

/* LEAP-TABLE-EXPIRES ${isoDay(validUntil)} — build.sh greps this line. */

/** 1972-01-01 00:00:00 UTC — the first line of the table, and the start of
 *  the era in which TAI−UTC is defined at all. */
export const kECLeapEraStart = ${rows[0].appleSeconds};

/** The source file's own expiration (${isoDay(validUntil)}): past this instant the
 *  IERS has announced nothing, so neither can we. */
export const kECLeapTableValidUntil = ${validUntil};

/** Same instant as an ISO day, for messages and tests. */
export const kECLeapTableValidUntilISO = '${isoDay(validUntil)}';

/** TT − TAI, fixed by definition. */
export const kECTTMinusTAI = 32.184;

/**
 * The table, flattened to (Apple-epoch instant, TAI−UTC from that instant on)
 * pairs. Storing TAI−UTC directly rather than a cumulative leap count keeps
 * the accessor a plain lookup and would absorb a negative leap second without
 * any special case.
 */
const leapSecondTable: readonly number[] = [
${tableLines.join('\n')}
];

/** Number of rows in \`leapSecondTable\` (2 numbers apiece). */
export const kECLeapTableEntryCount = ${rows.length};

/** TAI−UTC at the end of the table, i.e. the value in force today. */
export const kECLeapTableFinalTAIMinusUTC = ${last.taiMinusUTC};

/** Last-entry cache: consecutive calls are almost always in the same era. */
let _cachedIndex = leapSecondTable.length - 2;

/**
 * TAI−UTC, in seconds, in force at \`dateInterval\` (Apple-epoch seconds).
 *
 * Values before the first entry clamp to it. UTC did not step by whole
 * seconds before ${isoDay(rows[0].appleSeconds)}, and es-time.ts uses \`kECLeapEraStart\` to keep
 * the polynomial ΔT in charge of that era.
 */
export function taiMinusUTCForDateInterval(dateInterval: number): number {
    // Fast path: still inside the cached entry's span?
    const cached = _cachedIndex;
    if (dateInterval >= leapSecondTable[cached] &&
        (cached + 2 >= leapSecondTable.length || dateInterval < leapSecondTable[cached + 2])) {
        return leapSecondTable[cached + 1];
    }
    if (dateInterval < leapSecondTable[0]) {
        return leapSecondTable[1];
    }
    // Binary search over the entries for the last one at or before the date.
    let lo = 0;
    let hi = leapSecondTable.length / 2 - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (leapSecondTable[mid * 2] <= dateInterval) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    _cachedIndex = lo * 2;
    return leapSecondTable[lo * 2 + 1];
}

/**
 * TT − UTC, in seconds, at \`dateInterval\` — i.e. ΔT with UT taken as UTC.
 * Exact for any instant from ${isoDay(rows[0].appleSeconds)} through the table's expiry.
 */
export function ttMinusUTCForDateInterval(dateInterval: number): number {
    return kECTTMinusTAI + taiMinusUTCForDateInterval(dateInterval);
}

/** The raw table, for tests that audit it row by row. */
export function leapSecondTableEntries(): { dateInterval: number; taiMinusUTC: number }[] {
    const out: { dateInterval: number; taiMinusUTC: number }[] = [];
    for (let i = 0; i < leapSecondTable.length; i += 2) {
        out.push({ dateInterval: leapSecondTable[i], taiMinusUTC: leapSecondTable[i + 1] });
    }
    return out;
}
`;
}

// ---------------------------------------------------------------------- main

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const { url, text } = await fetchList(opts.cache);
    const meta = parseList(text);
    const rows = buildTable(meta.entries);

    console.log(`Parsed ${rows.length} entries, ` +
        `TAI−UTC ${rows[0].taiMinusUTC} → ${rows[rows.length - 1].taiMinusUTC}, ` +
        `valid until ${isoDay(meta.expires + NTP_TO_APPLE)}`);
    crossCheckIOS(rows);

    writeFileSync(opts.out, generate(rows, { ...meta, url }));
    console.log(`Wrote ${opts.out}`);
}

await main();
