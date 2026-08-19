#!/usr/bin/env node
/**
 * scrape-eclipses.mjs — generate src/help/eclipse-data.json for the Eclipse
 * Table help page (see planning/2026-08-16-eclipse-table-page.md).
 *
 * Run this by hand every few years to move the covered window forward; it is
 * NOT part of the build (build.sh only verifies the committed JSON exists).
 *
 *   node scripts/scrape-eclipses.mjs                    # currentYear ± 15
 *   node scripts/scrape-eclipses.mjs --start 2011 --end 2041
 *   node scripts/scrape-eclipses.mjs --cache /tmp/nasa  # reuse downloads
 *
 * Sources — all NASA GSFC, whose footers grant free reproduction with the
 * acknowledgment "Eclipse Predictions by Fred Espenak, NASA's GSFC":
 *
 *   SEcat5/SE2001-2100.html   solar century catalog  (<pre>, fixed-width):
 *                             date, TD of greatest eclipse, ΔT, saros, type,
 *                             gamma, magnitude, lat/lon (whole degrees)
 *   LEcat5/LE2001-2100.html   lunar century catalog  (same shape)
 *   SEdecade/LEdecade         decade tables (real <table>): the human-readable
 *                             visibility region, and for central solar
 *                             eclipses the bracketed path description
 *   SEpath/SEpath2001/*.html  per-eclipse path pages, central solar only:
 *                             greatest eclipse in UT and lat/lon to 0.1', i.e.
 *                             ~200 m instead of the catalog's whole degrees
 *
 * Why the path pages matter: the catalogs round the greatest-eclipse point to
 * whole degrees (up to ~78 km of error). Umbral paths in range get as narrow as
 * 21 km (2020 Jun 21) and 49 km (2023 Apr 20), so a deep link built from
 * catalog coordinates would drop the viewer outside totality and the app would
 * draw a partial eclipse on a row labelled "total". Central rows therefore take
 * their time and position from the path page; partial solar and all lunar rows
 * keep catalog coordinates, where the rounding is harmless (a partial eclipse
 * has no umbra to miss, and a lunar eclipse looks the same across the whole
 * night hemisphere).
 *
 * Times: the catalogs publish TD, so UT = TD − ΔT. Path pages publish UT
 * directly and we prefer it. The two disagree by a few seconds (they assume
 * slightly different ΔT); the page displays whole minutes.
 *
 * !! When this is next re-run, also keep TD (or NASA's per-row ΔT, which the
 * century catalogs print in their own column and this script already parses).
 * Since 2026-08-18 the engine's ΔT is the exact leap-second value rather than
 * the Espenak polynomial NASA assumed, so for rows past the leap table's
 * expiry the published UT is a few seconds off *our* greatest eclipse — enough
 * to mislabel the narrowest annular in the set (2032 May 09, 22 s of
 * annularity). Storing TD lets the page and the test both work in the frame
 * that does not depend on whose ΔT you believe. See
 * planning/2026-08-16-eclipse-table-page.md §9a.
 *
 * Penumbral lunar eclipses are dropped: they are barely perceptible in the sky,
 * and the app's own eclipse model is umbral-only, so their deep links would
 * show "no eclipse" (decision Q2 in the plan).
 *
 * Output is a single committed artifact, src/help/eclipse-data.json, holding
 * facts only — the page module builds the deep links and the prose from it.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NASA = 'https://eclipse.gsfc.nasa.gov';
const ECLIPSEWISE = 'https://www.eclipsewise.com';
const ACKNOWLEDGMENT = "Eclipse Predictions by Fred Espenak, NASA's GSFC";

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Whole-degree coordinates are this coarse; see the header note. */
const CATALOG_COORD_ERROR_KM = 78;
/** Beyond this, the nearest city's civil time says nothing about the site. */
const CITY_TZ_MAX_KM = 500;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
    const now = new Date();
    const opts = {
        start: now.getUTCFullYear() - 15,
        end: now.getUTCFullYear() + 15,
        out: join(ROOT, 'src/help/eclipse-data.json'),
        cache: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const val = argv[i + 1];
        if (arg === '--start' || arg === '--end') {
            const year = Number(val);
            if (!Number.isInteger(year) || year < 2001 || year > 2100) {
                die(`${arg} must be a year within 2001–2100 (the catalogs' range), got ${val}`);
            }
            opts[arg.slice(2)] = year;
            i++;
        } else if (arg === '--out' || arg === '--cache') {
            if (!val) die(`${arg} needs a path`);
            opts[arg.slice(2)] = val;
            i++;
        } else {
            die(`unknown argument ${arg}`);
        }
    }
    if (opts.end < opts.start) die(`--end (${opts.end}) precedes --start (${opts.start})`);
    return opts;
}

function die(message) {
    console.error(`scrape-eclipses: ${message}`);
    process.exit(1);
}

// ------------------------------------------------------------------ fetching

/**
 * Fetch with a small retry and a polite pause between live requests. Cached
 * copies (--cache) skip both, so re-runs while developing the parser don't
 * hammer NASA.
 */
async function fetchText(url, cacheDir) {
    const cacheFile = cacheDir ? join(cacheDir, url.replace(/[^A-Za-z0-9]+/g, '_')) : null;
    if (cacheFile && existsSync(cacheFile)) return readFileSync(cacheFile, 'utf8');

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const resp = await fetch(url, { redirect: 'follow' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const text = await resp.text();
            if (cacheFile) {
                mkdirSync(cacheDir, { recursive: true });
                writeFileSync(cacheFile, text);
            }
            await sleep(250);
            return text;
        } catch (err) {
            lastError = err;
            await sleep(1000 * attempt);
        }
    }
    die(`could not fetch ${url}: ${lastError?.message ?? lastError}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------- parsing

const stripTags = (line) => line.replace(/<[^>]*>/g, '');

/** NASA writes ° and ' as numeric entities inside the <pre> and path blocks. */
function decodeEntities(text) {
    return text
        .replace(/&#176;/g, '°')
        .replace(/&#39;/g, "'")
        .replace(/&#916;/g, 'Δ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}

/** "25N" → 25, "104W" → −104. */
function signedDegrees(field) {
    const m = field.match(/^(\d+(?:\.\d+)?)([NSEW])$/);
    if (!m) die(`unparsable coordinate "${field}"`);
    const value = Number(m[1]);
    return m[2] === 'S' || m[2] === 'W' ? -value : value;
}

/** "25°17.2'N" → 25.2867 */
function degreesMinutes(deg, min, hemi) {
    const value = Number(deg) + Number(min) / 60;
    return hemi === 'S' || hemi === 'W' ? -value : value;
}

function dateKey(year, mon, day) {
    return `${year} ${mon} ${String(day).padStart(2, '0')}`;
}

function utcMsFrom(year, mon, day, hh, mm, ss, deltaTSeconds) {
    const monthIndex = MONTHS.indexOf(mon);
    if (monthIndex < 0) die(`unknown month "${mon}"`);
    const td = Date.UTC(year, monthIndex, day, hh, mm, ss);
    // UT = TD − ΔT; subtracting can roll back across midnight, which epoch
    // arithmetic handles for us.
    return td - deltaTSeconds * 1000;
}

/**
 * Century-catalog rows live inside <pre> with links wrapped around individual
 * fields, so each line is parsed twice: tags stripped for the columns, raw for
 * the embedded path-page href.
 *
 * Solar: … Type QLE Gamma Mag Lat Long SunAlt PathWidth Duration
 * Lunar: … Type QSE Gamma PenMag UmbMag  <durations>  Lat Long
 */
function parseCentury(html, kind, { start, end }) {
    const rowRe = /^(\d{5})\s+(\d{4})\s+([A-Z][a-z]{2})\s+(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d+)\s+\d+\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/;
    const rows = [];
    let candidates = 0;

    for (const rawLine of html.split('\n')) {
        const text = decodeEntities(stripTags(rawLine)).trimEnd();
        if (!/^\d{5}\s+\d{4}\s+[A-Z][a-z]{2}\s/.test(text)) continue;
        candidates++;

        const m = text.match(rowRe);
        if (!m) die(`unparsable ${kind} catalog row: ${text}`);
        const [, , yearStr, mon, dayStr, hh, mm, ss, deltaTStr, sarosStr, type, , tail] = m;

        const year = Number(yearStr);
        if (year < start || year > end) continue;

        // Lat/Long sit at opposite ends of the tail in the two catalogs: right
        // after the magnitudes for solar, last for lunar (durations, which can
        // be "-", come in between).
        const tailFields = tail.trim().split(/\s+/);
        let latField, lonField;
        if (kind === 'solar') {
            [, , latField, lonField] = tailFields; // gamma, mag, lat, lon
        } else {
            [latField, lonField] = tailFields.slice(-2);
        }

        const pathHref = rawLine.match(/href="\.\.\/(SEpath\/[^"]+path\.html)"/);

        rows.push({
            year,
            mon,
            day: Number(dayStr),
            key: dateKey(year, mon, Number(dayStr)),
            typeCode: type,
            kindLetter: type[0],
            saros: Number(sarosStr),
            utcMs: utcMsFrom(year, mon, Number(dayStr), Number(hh), Number(mm), Number(ss), Number(deltaTStr)),
            lat: signedDegrees(latField),
            lon: signedDegrees(lonField),
            pathUrl: pathHref ? `${NASA}/${pathHref[1]}` : null,
        });
    }

    if (candidates < 200) die(`${kind} catalog: only ${candidates} rows found — page format changed?`);
    return rows;
}

/**
 * Decade tables are real <table> markup. Columns end with the visibility
 * region; central solar rows add a bolded bracket naming the path, e.g.
 * "N. America, C. America [Total: Mexico, c US, e Canada]".
 */
const DECADE_COLUMNS = 7;
const DECADE_REGION_COLUMN = 6;

function parseDecade(html, kind) {
    const doc = new JSDOM(html).window.document;
    const byDate = new Map();

    for (const tr of doc.querySelectorAll('tr')) {
        const cells = tr.querySelectorAll('td');
        // Nav and footer tables share the page, so identify data rows by their
        // date cell before insisting on the column count.
        if (cells.length === 0) continue;
        const dateText = cells[0].textContent.trim();
        const m = dateText.match(/^(\d{4})\s+([A-Z][a-z]{2})\s+(\d{2})$/);
        if (!m) continue;
        if (cells.length !== DECADE_COLUMNS) {
            die(`${kind} decade row ${dateText} has ${cells.length} columns, expected ${DECADE_COLUMNS} — page format changed?`);
        }

        const regionCell = cells[DECADE_REGION_COLUMN].textContent.replace(/\s+/g, ' ').trim();
        // Region is prose; anything else means the columns moved under us.
        if (!/[A-Za-z]{3}/.test(regionCell)) {
            die(`${kind} decade row ${dateText}: region cell "${regionCell}" is not a place description — page format changed?`);
        }
        const bracket = regionCell.match(/\[([^\]]*)\]/);
        const general = regionCell.replace(/\[[^\]]*\]/, '').trim().replace(/[,;]\s*$/, '');

        byDate.set(dateKey(Number(m[1]), m[2], Number(m[3])), {
            year: Number(m[1]),
            // "Total" / "Annular" / "Partial" / "Hybrid" / "Penumbral" — used
            // only to exclude penumbral rows from the completeness cross-check.
            type: cells[2].textContent.trim(),
            region: expandDirections(general),
            // Drop the "Total:"/"Annular:" prefix — the row already says the kind.
            pathRegion: bracket ? expandDirections(bracket[1].replace(/^[A-Za-z-]+:\s*/, '')) : null,
        });
    }

    if (byDate.size === 0) die(`${kind} decade table: no rows parsed — page format changed?`);
    return byDate;
}

/**
 * NASA compresses compass directions to single letters, in three shapes:
 * "c US", "n. China", and "w & s Africa". Spell them out; the project prefers
 * plain words in user-facing text. A token is only rewritten when it stands
 * alone before a place name or a conjunction, so ordinary words are untouched.
 *
 * Punctuation is tidied too — the source has stray doubled commas
 * ("Africa,, Asia") — but wording is otherwise left exactly as published,
 * typos included, since this is quoted third-party text.
 */
const DIRECTIONS = {
    n: 'northern', s: 'southern', e: 'eastern', w: 'western', c: 'central',
    ne: 'northeastern', nw: 'northwestern', se: 'southeastern', sw: 'southwestern',
};
function expandDirections(text) {
    return text
        .replace(/\b([nsew]|[ns][ew]|c)\.?\s+(?=[A-Z&])/g, (whole, token) => `${DIRECTIONS[token]} `)
        .replace(/\s*,(\s*,)+/g, ',')
        .replace(/\s+,/g, ',')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/** Path pages state greatest eclipse in UT with 0.1-arcminute coordinates. */
function parsePathPage(html, url) {
    const text = decodeEntities(stripTags(html)).replace(/\s+/g, ' ');
    const m = text.match(
        /Greatest Eclipse:\s*Time\s*=\s*(\d{1,2}):(\d{2}):([\d.]+)\s*UT\s*Lat\s*=\s*(\d+)°([\d.]+)'([NS])\s*Long\s*=\s*(\d+)°([\d.]+)'([EW])/
    );
    if (!m) die(`no greatest-eclipse block in ${url} — page format changed?`);
    return {
        hh: Number(m[1]),
        mm: Number(m[2]),
        ss: Number(m[3]),
        lat: degreesMinutes(m[4], m[5], m[6]),
        lon: degreesMinutes(m[7], m[8], m[9]),
    };
}

// -------------------------------------------------------------- timezones

/**
 * Nearest-city timezone, using the same GeoNames database the apps ship
 * (src/cities-data.js assigns its payload to window.ChronometerCities).
 *
 * Greatest eclipse usually falls at sea, where no city's civil time is
 * meaningful, so beyond CITY_TZ_MAX_KM we fall back to the nautical zone for
 * that longitude. Note Etc/GMT signs are inverted by IANA convention:
 * Etc/GMT+5 is UTC−5.
 */
function loadCities() {
    // Same sandbox trick make-cities-gz.mjs uses: the file is browser code that
    // assigns to `window`, so hand it an object to fill in.
    const js = readFileSync(join(ROOT, 'src/cities-data.js'), 'utf-8');
    const sandbox = { ChronometerCities: undefined };
    new Function('window', js)(sandbox);
    const data = sandbox.ChronometerCities;
    if (!data || data.v !== 2) die('src/cities-data.js did not provide a v2 payload');

    const column = (b64, Type) => {
        const buf = Buffer.from(b64, 'base64');
        return new Type(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    };
    return {
        lat: column(data.cLat, Int32Array),
        lon: column(data.cLon, Int32Array),
        tz: column(data.cTz, Uint16Array),
        names: data.TZ,
        count: data.N,
    };
}

function resolveTimezone(cities, lat, lon) {
    let bestKm = Infinity;
    let bestRow = -1;
    const latRad = (lat * Math.PI) / 180;
    const kmPerDegLon = 111.32 * Math.cos(latRad);

    for (let i = 0; i < cities.count; i++) {
        const dLat = (cities.lat[i] / 1000 - lat) * 111.32;
        let dLonDeg = cities.lon[i] / 1000 - lon;
        if (dLonDeg > 180) dLonDeg -= 360;
        else if (dLonDeg < -180) dLonDeg += 360;
        const dLon = dLonDeg * kmPerDegLon;
        const km = dLat * dLat + dLon * dLon;
        if (km < bestKm) {
            bestKm = km;
            bestRow = i;
        }
    }

    const distanceKm = Math.sqrt(bestKm);
    if (bestRow >= 0 && distanceKm <= CITY_TZ_MAX_KM) {
        const name = cities.names[cities.tz[bestRow]];
        if (name) return name;
    }
    const offset = Math.round(lon / 15);
    if (offset === 0) return 'UTC';
    return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

// ----------------------------------------------------------------- assembly

const SOLAR_KINDS = { P: 'partial-solar', A: 'annular-solar', T: 'total-solar', H: 'hybrid-solar' };
const LUNAR_KINDS = { P: 'partial-lunar', T: 'total-lunar' };

function eclipseWiseUrl(kind, row) {
    const stem = `${row.year}${row.mon}${String(row.day).padStart(2, '0')}${row.kindLetter}`;
    return kind === 'solar'
        ? `${ECLIPSEWISE}/solar/SEprime/2001-2100/SE${stem}prime.html`
        : `${ECLIPSEWISE}/lunar/LEprime/2001-2100/LE${stem}prime.html`;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const { start, end, cache } = opts;
    console.log(`Covering ${start}–${end}${cache ? ` (cache ${cache})` : ''}`);

    const sources = [
        `${NASA}/SEcat5/SE2001-2100.html`,
        `${NASA}/LEcat5/LE2001-2100.html`,
    ];

    const solarRows = parseCentury(await fetchText(sources[0], cache), 'solar', opts);
    const lunarRows = parseCentury(await fetchText(sources[1], cache), 'lunar', opts);
    console.log(`Catalogs: ${solarRows.length} solar, ${lunarRows.length} lunar in range`);

    // Decade tables supply the region prose, one page per decade per kind.
    // NASA names each page for the first year of its decade, and those decades
    // run 1-to-0 (SEdecade2011 covers 2011–2020), so the page holding year Y is
    // ((Y − 1) / 10 rounded down) * 10 + 1.
    const decadePageFor = (year) => Math.floor((year - 1) / 10) * 10 + 1;
    const regions = { solar: new Map(), lunar: new Map() };
    for (let page = decadePageFor(start); page <= end; page += 10) {
        for (const [kind, prefix] of [['solar', 'SE'], ['lunar', 'LE']]) {
            const url = `${NASA}/${prefix}decade/${prefix}decade${page}.html`;
            sources.push(url);
            for (const [key, value] of parseDecade(await fetchText(url, cache), kind)) {
                regions[kind].set(key, value);
            }
        }
    }

    // Completeness, checked against an independent NASA page rather than a
    // plausibility band: the decade tables list the same eclipses as the
    // catalogs, so anything they show in range must have arrived above. A
    // catalog row that stops matching the row regex would otherwise vanish
    // without trace, and a handful of missing eclipses looks entirely normal.
    for (const [kind, rows] of [['solar', solarRows], ['lunar', lunarRows]]) {
        const seen = new Set(rows.map((r) => r.key));
        for (const [key, entry] of regions[kind]) {
            if (entry.year < start || entry.year > end) continue;
            if (kind === 'lunar' && /penumbral/i.test(entry.type)) continue;
            if (!seen.has(key)) {
                die(`${kind} eclipse ${key} (${entry.type}) is in the decade table but missing from the century catalog — catalog rows are being dropped`);
            }
        }
    }

    const cities = loadCities();
    const eclipses = [];
    let pathRefined = 0;

    for (const [kind, rows] of [['solar', solarRows], ['lunar', lunarRows]]) {
        for (const row of rows) {
            const kindName = kind === 'solar' ? SOLAR_KINDS[row.kindLetter] : LUNAR_KINDS[row.kindLetter];
            if (kind === 'lunar' && row.kindLetter === 'N') continue; // penumbral — see header
            if (!kindName) die(`unmapped ${kind} type code "${row.typeCode}" on ${row.key}`);

            const region = regions[kind].get(row.key);
            if (!region) die(`no decade-table region for ${kind} eclipse ${row.key}`);

            let { lat, lon, utcMs } = row;
            let coordSource = 'catalog';
            if (row.pathUrl) {
                const precise = parsePathPage(await fetchText(row.pathUrl, cache), row.pathUrl);
                const drift = Math.abs(
                    utcMsFrom(row.year, row.mon, row.day, precise.hh, precise.mm, Math.round(precise.ss), 0) - utcMs
                );
                if (drift > 120_000) {
                    die(`${row.key}: path page UT differs from catalog TD−ΔT by ${Math.round(drift / 1000)}s`);
                }
                if (Math.abs(precise.lat - lat) > 1 || Math.abs(precise.lon - lon) > 1) {
                    die(`${row.key}: path-page position disagrees with the catalog by more than a degree`);
                }
                lat = Number(precise.lat.toFixed(4));
                lon = Number(precise.lon.toFixed(4));
                utcMs = utcMsFrom(row.year, row.mon, row.day, precise.hh, precise.mm, Math.round(precise.ss), 0);
                coordSource = 'path';
                pathRefined++;
            }

            eclipses.push({
                utcMs,
                kind: kindName,
                region: region.region,
                pathRegion: region.pathRegion,
                lat,
                lon,
                coordSource,
                tz: resolveTimezone(cities, lat, lon),
                url: eclipseWiseUrl(kind, row),
            });
        }
    }

    eclipses.sort((a, b) => a.utcMs - b.utcMs);

    // Sanity gates — better to fail than to commit a plausible-looking table.
    const years = end - start + 1;
    const perYear = eclipses.length / years;
    if (perYear < 2 || perYear > 8) die(`${eclipses.length} eclipses over ${years} years (${perYear.toFixed(1)}/yr) is outside the expected band`);
    for (let i = 1; i < eclipses.length; i++) {
        if (eclipses[i].utcMs <= eclipses[i - 1].utcMs) die(`eclipses out of order at index ${i}`);
    }
    // Every year has at least two solar eclipses, and the century's busiest has
    // seven non-penumbral events; anything outside that means rows were dropped
    // (a hidden subset parses as a plausible but incomplete table) or doubled.
    const perYearCounts = new Map();
    for (const e of eclipses) {
        const year = new Date(e.utcMs).getUTCFullYear();
        perYearCounts.set(year, (perYearCounts.get(year) ?? 0) + 1);
    }
    for (let year = start; year <= end; year++) {
        const n = perYearCounts.get(year) ?? 0;
        if (n < 2 || n > 7) die(`${year} has ${n} eclipses — expected 2–7; rows are being dropped or duplicated`);
    }

    // A central eclipse whose catalog row lost its path link silently falls back
    // to whole-degree coordinates, which can land outside a narrow umbral path.
    // NASA publishes a path page for every central eclipse bar a handful of
    // non-central ones (three in the whole century), so more than a few misses
    // means the link markup moved, not that the pages are absent.
    const central = eclipses.filter((e) => /^(total|annular|hybrid)-solar$/.test(e.kind));
    const coarseCentral = central.filter((e) => e.coordSource !== 'path');
    if (coarseCentral.length > 3) {
        die(
            `${coarseCentral.length}/${central.length} central eclipses have no ../SEpath/…path.html link in their ` +
            `catalog row — the catalog's link markup has probably changed. Positions would silently degrade to ` +
            `~${CATALOG_COORD_ERROR_KM} km, enough to miss a narrow umbral path.`
        );
    }
    console.log(
        `Refined ${pathRefined} positions from path pages; ` +
        `${coarseCentral.length}/${central.length} central eclipses have no path link in the catalog` +
        (coarseCentral.length ? ` (${coarseCentral.map((e) => new Date(e.utcMs).toISOString().slice(0, 10)).join(', ')} — position good to ~${CATALOG_COORD_ERROR_KM} km)` : '')
    );

    const payload = {
        meta: {
            generator: 'scripts/scrape-eclipses.mjs',
            generated: new Date().toISOString().slice(0, 10),
            startYear: start,
            endYear: end,
            acknowledgment: ACKNOWLEDGMENT,
            sources,
            note:
                'Penumbral lunar eclipses are omitted. Central solar positions come from NASA path pages; ' +
                'others are catalog values rounded to whole degrees. Region text is NASA\'s own, with lowercase ' +
                'compass abbreviations spelled out ("c US" to "central US") and stray punctuation tidied; ' +
                'capitalised forms are left alone because they are names, not directions ("S. Africa" is the country).',
            counts: {
                total: eclipses.length,
                solar: eclipses.filter((e) => e.kind.endsWith('solar')).length,
                lunar: eclipses.filter((e) => e.kind.endsWith('lunar')).length,
            },
        },
        eclipses,
    };

    // The JSON is inlined into a <script> block, so it must not be able to
    // close it or open a comment.
    const json = `${JSON.stringify(payload, null, 1)}\n`;
    if (/<\/script|<!--/i.test(json)) die('generated JSON contains markup that cannot be inlined safely');

    writeFileSync(opts.out, json);
    console.log(`Wrote ${opts.out} — ${eclipses.length} eclipses (${payload.meta.counts.solar} solar, ${payload.meta.counts.lunar} lunar)`);
}

await main();
