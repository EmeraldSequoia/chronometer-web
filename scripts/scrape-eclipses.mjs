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
 *   SEsearch/SEdata.php       per-eclipse Besselian-elements page, every solar
 *                             eclipse: TDT instant of greatest eclipse, NASA's
 *                             per-row ΔT, and the full polynomial elements
 *                             (x, y, d, l1, l2, μ as cubics about t0)
 *   SEpath/SEpath2001/*.html  per-eclipse path pages, central solar only:
 *                             greatest eclipse in UT and lat/lon to 0.1' —
 *                             kept as validation fixtures for the reduction
 *
 * Solar positions are computed here, not copied: every solar row's
 * greatest-eclipse point is derived from its Besselian elements
 * (greatestEclipseFromElements below). The catalogs round the point to whole
 * degrees (up to ~78 km — enough to miss a 21 km umbral path and draw a
 * partial eclipse on a row labelled "total"), the path pages give 0.1' but
 * exist only for central rows, and both bake in NASA's ΔT vintage (next
 * paragraph). The reduction is validated against every path page to 0.5' and
 * every SEdata circumstance block to 0.25° before its output is trusted.
 * Lunar rows keep catalog coordinates, where the rounding is harmless (a
 * lunar eclipse looks the same across the whole night hemisphere).
 *
 * Times are stored as TT (`tdMs`), not UT. NASA's published UT labels embed
 * frozen ΔT *predictions* of three different vintages (the same 2024 eclipse
 * carries 74.0 s on SEdata, 70.6 s on its path page, against the realized
 * 69.184 s), and the archive never re-converts. The TT instant is what the
 * eclipse geometry is computed in and is immune to all of that. Consumers
 * derive UT at run/test time from the engine's own leap-exact ΔT (es-time.ts
 * convertETtoUT), so deep links self-correct whenever the leap table is
 * updated, without re-scraping. NASA's per-row ΔT is kept as `nasaDeltaT` for
 * provenance and for recovering their published UT in diagnostics.
 * Longitudes carry the same vintage bias — the Earth-fixed frame slides
 * 15.04″ of longitude per second of ΔT — so the reduction is validated with
 * NASA's stated ΔT and then emitted with ours. See
 * planning/2026-08-17-eclipse-precision-and-verification.md §3b.
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

/** NASA writes ° ' Δ μ as entities — numeric in the catalogs and path pages,
 *  named on SEdata.php. */
function decodeEntities(text) {
    return text
        .replace(/&#176;|&deg;/g, '°')
        .replace(/&#39;|&rsquo;/g, "'")
        .replace(/&#916;|&Delta;/g, 'Δ')
        .replace(/&mu;/g, 'μ')
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

/** Epoch ms of a TT/TDT calendar instant. (Epoch ms are a UT-shaped ruler,
 *  but they serve equally well as a linear count of TT — the JSON stores TT
 *  instants on it, labelled `tdMs`.) */
function tdMsFrom(year, mon, day, hh, mm, ss) {
    const monthIndex = MONTHS.indexOf(mon);
    if (monthIndex < 0) die(`unknown month "${mon}"`);
    return Date.UTC(year, monthIndex, day, hh, mm, ss);
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
            tdMs: tdMsFrom(year, mon, Number(dayStr), Number(hh), Number(mm), Number(ss)),
            nasaDeltaT: Number(deltaTStr),
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

/** Path pages state greatest eclipse in UT with 0.1-arcminute coordinates,
 *  and the ΔT that UT was derived with — both are validation fixtures for
 *  the Besselian reduction (TT = published UT + stated ΔT). */
function parsePathPage(html, url) {
    const text = decodeEntities(stripTags(html)).replace(/\s+/g, ' ');
    const m = text.match(
        /Greatest Eclipse:\s*Time\s*=\s*(\d{1,2}):(\d{2}):([\d.]+)\s*UT\s*Lat\s*=\s*(\d+)°([\d.]+)'([NS])\s*Long\s*=\s*(\d+)°([\d.]+)'([EW])/
    );
    if (!m) die(`no greatest-eclipse block in ${url} — page format changed?`);
    const dt = text.match(/ΔT\s*=\s*([\d.]+)\s*seconds/);
    if (!dt) die(`no ΔT statement in ${url} — page format changed?`);
    return {
        hh: Number(m[1]),
        mm: Number(m[2]),
        ss: Number(m[3]),
        lat: degreesMinutes(m[4], m[5], m[6]),
        lon: degreesMinutes(m[7], m[8], m[9]),
        deltaT: Number(dt[1]),
    };
}

// ---------------------------------------------- SEdata Besselian elements

/**
 * SEsearch/SEdata.php?Ecl=YYYYMMDD prints one solar eclipse's polynomial
 * Besselian elements inside a <pre>. The PHP behind it is visibly fragile:
 * two live warnings are injected mid-<pre> where the d3 coefficient should be
 * (`Undefined variable $_5MCSE_besselian_d3`), splitting the n=3 row, and the
 * null prints as 0.0000000 in d3's slot (d's n=2 term is already ~1e-6, so a
 * zero cubic is exact for our purposes). The parser drops the warning lines,
 * then tokenizes the coefficient table and insists on exactly four rows of
 * six coefficients so any other damage hard-fails. One more quirk: UT minutes
 * in the circumstance block are not zero-padded ("06:3:24").
 */
function parseSEdata(html, url) {
    const preMatch = html.match(/<pre>([\s\S]*?)<\/pre>/);
    if (!preMatch) die(`no <pre> block in ${url} — page format changed?`);
    const lines = preMatch[1].split('\n').filter((line) => !/Warning<\/b>|SEdata\.php/.test(line));
    const text = decodeEntities(stripTags(lines.join('\n')));

    const instant = text.match(/Instant of\s+(\d{1,2}):(\d{1,2}):(\d{1,2}) TDT/);
    const deltaT = text.match(/ΔT\s*=\s*([\d.]+)\s*s/);
    const t0Line = text.match(
        /Polynomial Besselian Elements for:\s+(\d{4}) ([A-Z][a-z]{2})\s+(\d{1,2})\s+([\d.]+)\s+TDT/
    );
    const geUt = text.match(/Circumstances at Greatest Eclipse:\s+(\d{1,2}):(\d{1,2}):(\d{1,2}) UT/);
    const geLat = text.match(/Latitude:\s+([\d.]+)°\s*([NS])/);
    const geLon = text.match(/Longitude:\s+([\d.]+)°\s*([EW])/);
    if (!instant || !deltaT || !t0Line || !geUt || !geLat || !geLon) {
        die(`SEdata fields missing in ${url} — page format changed?`);
    }

    const header = text.match(/\n\s+n\s+x\s+y\s+d\s+l1\s+l2\s+μ\s*\n/);
    const tanF = text.match(/tan f1\s*=\s*([\d.-]+)\s+tan f2\s*=\s*([\d.-]+)/);
    if (!header || !tanF) die(`SEdata coefficient table not found in ${url} — page format changed?`);
    const block = text.slice(header.index + header[0].length, tanF.index);
    const tokens = block.split(/\s+/).filter((tok) => /^-?[\d.]+$/.test(tok));
    if (tokens.length !== 4 * 7) {
        die(`SEdata coefficient table has ${tokens.length} numbers, expected 28, in ${url}`);
    }
    const columns = { x: [], y: [], d: [], l1: [], l2: [], mu: [] };
    const order = ['x', 'y', 'd', 'l1', 'l2', 'mu'];
    for (let n = 0; n < 4; n++) {
        if (Number(tokens[n * 7]) !== n) die(`SEdata coefficient row ${n} mislabeled in ${url}`);
        order.forEach((name, i) => columns[name].push(Number(tokens[n * 7 + 1 + i])));
    }

    const [, yearStr, mon, dayStr, t0Str] = t0Line;
    const dateMs = tdMsFrom(Number(yearStr), mon, Number(dayStr), 0, 0, 0);
    const tdtInstantMs = dateMs + (Number(instant[1]) * 3600 + Number(instant[2]) * 60 + Number(instant[3])) * 1000;
    // t0 is the integral TDT hour nearest greatest eclipse, but NASA prints
    // its clock against the eclipse's own date — an eclipse at 23:53 TDT gets
    // "0.000 TDT", meaning midnight at that date's *end*. Snap to the day
    // that puts t0 beside the instant.
    let t0Ms = dateMs + Number(t0Str) * 3600_000;
    t0Ms -= Math.round((t0Ms - tdtInstantMs) / 86400_000) * 86400_000;
    return {
        url,
        tdtInstantMs,
        deltaT: Number(deltaT[1]),
        t0Ms,
        elements: columns,
        printed: {
            utSecondsOfDay: Number(geUt[1]) * 3600 + Number(geUt[2]) * 60 + Number(geUt[3]),
            lat: signedDegrees(geLat[1] + geLat[2]),
            lon: signedDegrees(geLon[1] + geLon[2]),
        },
    };
}

// ------------------------------------ Besselian greatest-eclipse reduction

/** Flattening adopted by the Five Millennium Canon (1/298.257). */
const EARTH_FLATTENING = 1 / 298.257;
const EARTH_E2 = 2 * EARTH_FLATTENING - EARTH_FLATTENING * EARTH_FLATTENING;

/** Degrees of longitude the ephemeris meridian leads Greenwich per second of
 *  ΔT: 1.002738 × 15°/3600 h — the 15.04″/s rate. ΔT enters the reduction
 *  only through this term, which is what lets main() validate the math with
 *  NASA's stated ΔT and then emit coordinates with the engine's. */
const LON_DEG_PER_DELTAT_SECOND = 0.00417807;

const evalPoly = (c, t) => ((c[3] * t + c[2]) * t + c[1]) * t + c[0];
const evalPolyDeriv = (c, t) => (3 * c[3] * t + 2 * c[2]) * t + c[1];

/** Wrap a longitude difference onto [−180°, 180°). */
const lonDelta = (a, b) => ((((a - b + 540) % 360) + 360) % 360) - 180;

/**
 * Greatest eclipse from polynomial Besselian elements — the standard
 * reduction (Explanatory Supplement; Meeus, *Elements of Solar Eclipses*):
 * the instant the shadow axis passes closest to the Earth's centre (Newton on
 * d/dt(x² + y²) = 0), then the surface point closest to the axis at that
 * instant, which is NASA's documented definition for every eclipse type
 * (SEcat5/SEcatkey.html).
 *
 * Central rows: the axis pierces the surface. The line ξ = x, η = y is
 * intersected with the ellipsoid exactly (a quadratic in ζ, solved in the
 * equatorial frame) — the textbook shortcut of scaling y by 1/ρ1 against a
 * unit sphere is only approximate and drifts past 0.5' at Antarctic
 * latitudes (2021 Dec 04 sits at 76.8°S).
 *
 * Non-central rows: the closest point sits where the geodetic normal is
 * perpendicular to the axis (the Lagrange condition — equivalently, the Sun's
 * altitude is exactly 0°, as NASA's circumstance blocks print). That ring is
 * parametrized by the normal's position angle and searched in 1D. NB the
 * minimum is genuinely flat: near the limb tangency the axis distance varies
 * only quadratically along the ring, so ~1e-4 Earth radii of formulation
 * difference moves the argmin kilometres. NASA's stored partial positions sit
 * 3–8′ from this exact minimum with the same axis distance to that order —
 * same valley, different series expansion — which is why partial rows are
 * validated to 0.25° (SEdata prints 0.1° anyway) while central rows hold 0.5′
 * against the path pages.
 */
function greatestEclipseFromElements(se, deltaTSeconds) {
    const el = se.elements;
    // t*: t0 is chosen adjacent to greatest eclipse, so Newton from 0 converges
    // in two or three steps; the rest are free.
    let t = 0;
    for (let i = 0; i < 10; i++) {
        const x = evalPoly(el.x, t), y = evalPoly(el.y, t);
        const xd = evalPolyDeriv(el.x, t), yd = evalPolyDeriv(el.y, t);
        const xdd = 2 * el.x[2] + 6 * el.x[3] * t, ydd = 2 * el.y[2] + 6 * el.y[3] * t;
        t -= (x * xd + y * yd) / (xd * xd + yd * yd + x * xdd + y * ydd);
    }
    const x = evalPoly(el.x, t);
    const y = evalPoly(el.y, t);
    const d = (evalPoly(el.d, t) * Math.PI) / 180;
    const mu = evalPoly(el.mu, t);
    const sinD = Math.sin(d), cosD = Math.cos(d);

    // Intersect the shadow axis (ξ = x, η = y, ζ free) with the ellipsoid.
    // In the equatorial frame A = ζ cos d − η sin d, B = ξ, C = η cos d +
    // ζ sin d, and the surface is A² + B² + C²/(1−e²) = 1 — a quadratic in ζ
    // whose discriminant is the exact central/non-central test.
    const qa = cosD * cosD + (sinD * sinD) / (1 - EARTH_E2);
    const qb = 2 * y * sinD * cosD * (1 / (1 - EARTH_E2) - 1);
    const qc = y * y * sinD * sinD + x * x + (y * y * cosD * cosD) / (1 - EARTH_E2) - 1;
    const disc = qb * qb - 4 * qa * qc;

    let latRad, hourAngle;
    if (disc >= 0) {
        // Central: the near intersection (largest ζ, the Moon-ward one).
        const zeta = (-qb + Math.sqrt(disc)) / (2 * qa);
        const A = zeta * cosD - y * sinD;
        const B = x;
        const C = y * cosD + zeta * sinD;
        // Geodetic latitude of a point on the ellipsoid, from its geocentric.
        latRad = Math.atan(C / ((1 - EARTH_E2) * Math.hypot(A, B)));
        hourAngle = Math.atan2(B, A);
    } else {
        // Non-central: search the sunrise/sunset ring. A unit normal with no
        // ζ-component is (sin ψ, cos ψ, 0) in the fundamental frame; mapping
        // it through the d-rotation gives the geodetic latitude and hour
        // angle, and those give the surface position exactly.
        const ringPoint = (psi) => {
            const sinPhi = Math.cos(psi) * cosD;
            const phi = Math.asin(sinPhi);
            const H = Math.atan2(Math.sin(psi), -Math.cos(psi) * sinD);
            const C = 1 / Math.sqrt(1 - EARTH_E2 * sinPhi * sinPhi);
            const pcos = C * Math.cos(phi);
            const psin = C * (1 - EARTH_E2) * sinPhi;
            const xi = pcos * Math.sin(H);
            const eta = psin * cosD - pcos * Math.cos(H) * sinD;
            return { phi, H, dist: Math.hypot(xi - x, eta - y) };
        };
        let bestPsi = 0, bestDist = Infinity;
        const STEPS = 720;
        for (let i = 0; i < STEPS; i++) {
            const psi = (2 * Math.PI * i) / STEPS;
            const { dist } = ringPoint(psi);
            if (dist < bestDist) { bestDist = dist; bestPsi = psi; }
        }
        let lo = bestPsi - (2 * Math.PI) / STEPS;
        let hi = bestPsi + (2 * Math.PI) / STEPS;
        for (let i = 0; i < 80; i++) {
            const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
            if (ringPoint(m1).dist <= ringPoint(m2).dist) hi = m2; else lo = m1;
        }
        const p = ringPoint((lo + hi) / 2);
        latRad = p.phi;
        hourAngle = p.H;
    }

    let lon = (hourAngle * 180) / Math.PI - mu + LON_DEG_PER_DELTAT_SECOND * deltaTSeconds;
    lon = ((lon % 360) + 540) % 360 - 180;
    return {
        tdMs: se.t0Ms + t * 3600_000,
        lat: (latRad * 180) / Math.PI,
        lon,
    };
}

// ------------------------------------------------------------ engine ΔT

/**
 * The engine's own leap-exact ΔT, imported from the TypeScript sources:
 * esbuild (already a devDependency) bundles a one-line entry in memory and
 * the module is imported through a data: URL. Node cannot import the TS files
 * directly (extensionless import specifiers), and duplicating the leap-second
 * table here would let the two drift.
 */
async function loadEngineTime() {
    const { build } = await import('esbuild');
    const result = await build({
        stdin: {
            contents: "export { convertETtoUT } from './es-time';",
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

/** The engine's ΔT (seconds) in force at a TT instant, via convertETtoUT. */
function engineDeltaTAt(convertETtoUT, tdMs) {
    const ttSeconds = tdMs / 1000 - 978307200;
    return ttSeconds - convertETtoUT(ttSeconds);
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
        // Stands for the per-eclipse element queries (?Ecl=YYYYMMDD).
        `${NASA}/SEsearch/SEdata.php`,
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
    const { convertETtoUT } = await loadEngineTime();
    const eclipses = [];
    let pathValidated = 0;
    const pad2 = (n) => String(n).padStart(2, '0');

    for (const [kind, rows] of [['solar', solarRows], ['lunar', lunarRows]]) {
        for (const row of rows) {
            const kindName = kind === 'solar' ? SOLAR_KINDS[row.kindLetter] : LUNAR_KINDS[row.kindLetter];
            if (kind === 'lunar' && row.kindLetter === 'N') continue; // penumbral — see header
            if (!kindName) die(`unmapped ${kind} type code "${row.typeCode}" on ${row.key}`);

            const region = regions[kind].get(row.key);
            if (!region) die(`no decade-table region for ${kind} eclipse ${row.key}`);

            let { lat, lon, tdMs, nasaDeltaT } = row;
            let coordSource = 'catalog';
            if (kind === 'solar') {
                const sedataUrl =
                    `${NASA}/SEsearch/SEdata.php?Ecl=${row.year}${pad2(MONTHS.indexOf(row.mon) + 1)}${pad2(row.day)}`;
                const se = parseSEdata(await fetchText(sedataUrl, cache), sedataUrl);

                // Identity gates: the elements page must describe the catalog's
                // eclipse on the catalog's clock (the catalog rounds ΔT to
                // whole seconds; SEdata prints one decimal).
                if (Math.abs(se.tdtInstantMs - row.tdMs) > 2000) {
                    die(`${row.key}: SEdata TDT instant is ${Math.round((se.tdtInstantMs - row.tdMs) / 1000)}s from the catalog TD`);
                }
                if (Math.abs(se.deltaT - row.nasaDeltaT) > 1) {
                    die(`${row.key}: SEdata ΔT ${se.deltaT}s vs catalog ${row.nasaDeltaT}s`);
                }

                // (1) Validate the reduction in NASA's own frame: with their
                // stated ΔT it must land on their printed greatest-eclipse
                // instant, clock and circumstances. (0.25°, not 0.5': the
                // printed block rounds to 0.1° and, for non-central rows, the
                // flat-valley effect described at greatestEclipseFromElements
                // adds a few arcminutes of legitimate spread.)
                const geNasa = greatestEclipseFromElements(se, se.deltaT);
                if (Math.abs(geNasa.tdMs - se.tdtInstantMs) > 2000) {
                    die(`${row.key}: reduced greatest-eclipse instant is ${((geNasa.tdMs - se.tdtInstantMs) / 1000).toFixed(1)}s from SEdata's`);
                }
                const utMsOfDay = ((se.tdtInstantMs - se.deltaT * 1000) % 86400000 + 86400000) % 86400000;
                const utDiff = Math.abs(utMsOfDay / 1000 - se.printed.utSecondsOfDay);
                if (Math.min(utDiff, 86400 - utDiff) > 1.5) {
                    die(`${row.key}: TDT − ΔT does not reproduce SEdata's printed UT clock`);
                }
                if (Math.abs(geNasa.lat - se.printed.lat) > 0.25 || Math.abs(lonDelta(geNasa.lon, se.printed.lon)) > 0.25) {
                    die(`${row.key}: reduced position ${geNasa.lat.toFixed(3)},${geNasa.lon.toFixed(3)} vs SEdata's printed ${se.printed.lat},${se.printed.lon}`);
                }

                // (1b) Where a path page exists (central rows), it is the
                // 0.1'-precision fixture: the reduction run with the path
                // page's own ΔT must reproduce its position to 0.5' and its
                // TT instant (published UT + stated ΔT) to 2 s.
                if (row.pathUrl) {
                    const path = parsePathPage(await fetchText(row.pathUrl, cache), row.pathUrl);
                    const gePath = greatestEclipseFromElements(se, path.deltaT);
                    let pathTdMs = tdMsFrom(row.year, row.mon, row.day, path.hh, path.mm, 0)
                        + Math.round((path.ss + path.deltaT) * 1000);
                    pathTdMs -= Math.round((pathTdMs - se.tdtInstantMs) / 86400000) * 86400000;
                    if (Math.abs(gePath.tdMs - pathTdMs) > 2000) {
                        die(`${row.key}: reduced instant is ${((gePath.tdMs - pathTdMs) / 1000).toFixed(1)}s from the path page's`);
                    }
                    // Great-circle arc is the meaningful metric: raw
                    // longitude minutes inflate by 1/cos(lat) at the polar
                    // latitudes central eclipses favour.
                    const gcArcmin = Math.hypot(
                        gePath.lat - path.lat,
                        lonDelta(gePath.lon, path.lon) * Math.cos((path.lat * Math.PI) / 180)
                    ) * 60;
                    // 42 of the 43 fixtures agree to ≤0.48' (median ~0.1').
                    // 2021 Dec 04 sits at gamma −0.9526, where the pierce
                    // point is near the limb and position error amplifies by
                    // 1/ζ (×3.4) — and the path pages were computed with
                    // ELP2000-85 against the published elements' ELP2000-82.
                    // The allowance is keyed so it cannot widen silently.
                    const allowance = row.key === '2021 Dec 04' ? 1.2 : 0.5;
                    if (gcArcmin > allowance) {
                        die(`${row.key}: reduced position is ${gcArcmin.toFixed(2)}' (great-circle) from the path page's — reduction is broken`);
                    }
                    pathValidated++;
                }

                // (2) Emit in the engine's ΔT frame. The reduction's only ΔT
                // dependence is the ephemeris-meridian rate, asserted exactly.
                const ourDeltaT = engineDeltaTAt(convertETtoUT, se.tdtInstantMs);
                const ge = greatestEclipseFromElements(se, ourDeltaT);
                const expectedShift = LON_DEG_PER_DELTAT_SECOND * (se.deltaT - ourDeltaT);
                if (Math.abs(lonDelta(geNasa.lon, ge.lon) - expectedShift) > 1e-9) {
                    die(`${row.key}: ΔT self-test failed — longitude moved ${lonDelta(geNasa.lon, ge.lon)}° for ${(se.deltaT - ourDeltaT).toFixed(3)}s of ΔT`);
                }
                if (Math.abs(ge.lat - row.lat) > 0.75 || Math.abs(lonDelta(ge.lon, row.lon)) > 0.75) {
                    die(`${row.key}: reduced position disagrees with the whole-degree catalog value`);
                }

                lat = Number(ge.lat.toFixed(4));
                lon = Number(ge.lon.toFixed(4));
                tdMs = Math.round(ge.tdMs);
                nasaDeltaT = se.deltaT;
                coordSource = 'besselian';
            }

            eclipses.push({
                tdMs,
                nasaDeltaT,
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

    eclipses.sort((a, b) => a.tdMs - b.tdMs);

    // Sanity gates — better to fail than to commit a plausible-looking table.
    const years = end - start + 1;
    const perYear = eclipses.length / years;
    if (perYear < 2 || perYear > 8) die(`${eclipses.length} eclipses over ${years} years (${perYear.toFixed(1)}/yr) is outside the expected band`);
    for (let i = 1; i < eclipses.length; i++) {
        if (eclipses[i].tdMs <= eclipses[i - 1].tdMs) die(`eclipses out of order at index ${i}`);
    }
    // Every year has at least two solar eclipses, and the century's busiest has
    // seven non-penumbral events; anything outside that means rows were dropped
    // (a hidden subset parses as a plausible but incomplete table) or doubled.
    const perYearCounts = new Map();
    for (const e of eclipses) {
        const year = new Date(e.tdMs).getUTCFullYear();
        perYearCounts.set(year, (perYearCounts.get(year) ?? 0) + 1);
    }
    for (let year = start; year <= end; year++) {
        const n = perYearCounts.get(year) ?? 0;
        if (n < 2 || n > 7) die(`${year} has ${n} eclipses — expected 2–7; rows are being dropped or duplicated`);
    }

    // Positions no longer depend on the path pages, but they are the only
    // 0.1'-grade fixtures the reduction is validated against, so losing the
    // catalog's link markup would silently gut the validation. NASA publishes
    // a path page for every central eclipse bar the rare non-central ones
    // (three in the whole century).
    const central = eclipses.filter((e) => /^(total|annular|hybrid)-solar$/.test(e.kind));
    if (central.length - pathValidated > 3) {
        die(
            `only ${pathValidated}/${central.length} central eclipses had a ../SEpath/…path.html link in their ` +
            `catalog row — the catalog's link markup has probably changed, and with it the reduction's 0.1' validation coverage.`
        );
    }
    console.log(
        `Besselian positions for ${eclipses.filter((e) => e.coordSource === 'besselian').length} solar rows; ` +
        `reduction validated against ${pathValidated} path pages (0.5') and every SEdata circumstance block (0.25°)`
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
                'Penumbral lunar eclipses are omitted. tdMs is the TT (TDT) instant of greatest eclipse; derive ' +
                'UT at run time with the engine\'s ΔT (es-time convertETtoUT) — NASA\'s published UT labels bake ' +
                'in frozen ΔT predictions of assorted vintages, kept per row as nasaDeltaT for provenance. Solar ' +
                'positions are Besselian greatest-eclipse reductions from SEdata.php elements, emitted with the ' +
                'engine\'s ΔT and validated against NASA\'s path pages (0.5\') and printed circumstances (0.25°); ' +
                'lunar positions are catalog values rounded to whole degrees. Region text is NASA\'s own, with ' +
                'lowercase compass abbreviations spelled out ("c US" to "central US") and stray punctuation ' +
                'tidied; capitalised forms are left alone because they are names, not directions ' +
                '("S. Africa" is the country).',
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
