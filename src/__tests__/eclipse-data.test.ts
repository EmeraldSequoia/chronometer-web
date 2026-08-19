/**
 * Guards src/help/eclipse-data.json, the generated dataset behind the Eclipse
 * Table help page (planning/2026-08-16-eclipse-table-page.md).
 *
 * Two jobs:
 *
 *  (a) Shape — every field the page module relies on exists and is sane, so a
 *      re-run of scripts/scrape-eclipses.mjs against changed NASA markup fails
 *      here rather than shipping a plausible-looking but wrong table.
 *  (b) Cross-check — each row is replayed through the app's own eclipse model
 *      (calculateEclipse), which is an independent check of NASA's numbers
 *      against our Willmann-Bell ephemerides: a mistyped time, a swapped
 *      hemisphere, or a mismapped type code all move the computed kind.
 *
 * Read as JSON text rather than imported: tsconfig has no resolveJsonModule and
 * build.sh gates on `tsc --noEmit` over src/**.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { calculateEclipse, EclipseKind } from '../astronomy/es-astro';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '../help/eclipse-data.json');
const RAW = readFileSync(DATA_PATH, 'utf-8');

interface Eclipse {
    utcMs: number;
    kind: string;
    region: string;
    pathRegion: string | null;
    lat: number;
    lon: number;
    coordSource: 'path' | 'catalog';
    tz: string;
    url: string;
}
interface EclipseData {
    meta: {
        generator: string;
        generated: string;
        startYear: number;
        endYear: number;
        acknowledgment: string;
        sources: string[];
        note: string;
        counts: { total: number; solar: number; lunar: number };
    };
    eclipses: Eclipse[];
}

const data: EclipseData = JSON.parse(RAW);
const { meta, eclipses } = data;

const SOLAR_KINDS = ['partial-solar', 'annular-solar', 'total-solar', 'hybrid-solar'];
const LUNAR_KINDS = ['partial-lunar', 'total-lunar'];
const ALL_KINDS = [...SOLAR_KINDS, ...LUNAR_KINDS];

const appleEpoch = (utcMs: number): number => utcMs / 1000 - 978307200;
const toRad = (deg: number): number => (deg * Math.PI) / 180;
const iso = (utcMs: number): string => new Date(utcMs).toISOString().slice(0, 16);

describe('eclipse-data.json — file and meta', () => {
    test('inlines safely into a <script> block', () => {
        // The page ships this verbatim inside <script type="application/json">.
        expect(RAW).not.toMatch(/<\/script/i);
        expect(RAW).not.toMatch(/<!--/);
    });

    test('meta describes a coherent, attributed dataset', () => {
        expect(meta.generator).toBe('scripts/scrape-eclipses.mjs');
        expect(meta.generated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isFinite(Date.parse(meta.generated))).toBe(true);
        expect(meta.startYear).toBeLessThanOrEqual(meta.endYear);
        // NASA's reproduction permission is conditional on this credit line.
        expect(meta.acknowledgment).toContain('Espenak');
        expect(meta.sources.length).toBeGreaterThanOrEqual(4);
        for (const url of meta.sources) expect(url).toMatch(/^https:\/\/eclipse\.gsfc\.nasa\.gov\//);
    });

    test('counts match the rows', () => {
        expect(meta.counts.total).toBe(eclipses.length);
        expect(meta.counts.solar).toBe(eclipses.filter((e) => e.kind.endsWith('-solar')).length);
        expect(meta.counts.lunar).toBe(eclipses.filter((e) => e.kind.endsWith('-lunar')).length);
        expect(meta.counts.solar + meta.counts.lunar).toBe(eclipses.length);
    });

    test('every single year is covered at a believable rate', () => {
        // Per year, not averaged over the window: an average hides a whole
        // decade going missing. Across the full 2001–2100 catalogs the
        // non-penumbral count per year never leaves 2–7.
        const perYear = new Map<number, number>();
        for (const e of eclipses) {
            const year = new Date(e.utcMs).getUTCFullYear();
            perYear.set(year, (perYear.get(year) ?? 0) + 1);
        }
        for (let year = meta.startYear; year <= meta.endYear; year++) {
            const n = perYear.get(year) ?? 0;
            expect(n, `${year} has ${n} eclipses`).toBeGreaterThanOrEqual(2);
            expect(n, `${year} has ${n} eclipses`).toBeLessThanOrEqual(7);
        }
    });

    test('reaches both edges of the advertised span', () => {
        const years = eclipses.map((e) => new Date(e.utcMs).getUTCFullYear());
        expect(Math.min(...years)).toBe(meta.startYear);
        expect(Math.max(...years)).toBe(meta.endYear);
    });

    test('every eclipse kind appears', () => {
        // Hybrids are the rare one — three in 2011–2041 — and the kind most
        // likely to be lost to a type-code mapping slip.
        for (const kind of ALL_KINDS) {
            expect(eclipses.some((e) => e.kind === kind), `no ${kind} rows`).toBe(true);
        }
    });
});

describe('eclipse-data.json — rows', () => {
    test('chronological with no duplicates', () => {
        for (let i = 1; i < eclipses.length; i++) {
            expect(eclipses[i].utcMs).toBeGreaterThan(eclipses[i - 1].utcMs);
        }
    });

    test('every row is inside the covered years', () => {
        for (const e of eclipses) {
            const year = new Date(e.utcMs).getUTCFullYear();
            expect(year).toBeGreaterThanOrEqual(meta.startYear);
            expect(year).toBeLessThanOrEqual(meta.endYear);
        }
    });

    test('fields are present and in range', () => {
        for (const e of eclipses) {
            const where = iso(e.utcMs);
            expect(ALL_KINDS, where).toContain(e.kind);
            expect(Number.isFinite(e.utcMs), where).toBe(true);
            expect(e.lat, where).toBeGreaterThanOrEqual(-90);
            expect(e.lat, where).toBeLessThanOrEqual(90);
            expect(e.lon, where).toBeGreaterThanOrEqual(-180);
            expect(e.lon, where).toBeLessThanOrEqual(180);
            expect(['path', 'catalog'], where).toContain(e.coordSource);
            expect(e.region.length, where).toBeGreaterThan(2);
            if (e.pathRegion !== null) expect(e.pathRegion.length, where).toBeGreaterThan(2);
        }
    });

    test('only central solar eclipses describe a path', () => {
        // The decade tables bracket a path description for exactly the
        // eclipses that have one. Tying the two together catches a column
        // shift in that table, which would otherwise swap prose silently:
        // region text is free-form, so nothing else can tell right from wrong.
        for (const e of eclipses) {
            const central = /^(total|annular|hybrid)-solar$/.test(e.kind);
            expect(e.pathRegion !== null, `${iso(e.utcMs)} ${e.kind}`).toBe(central);
        }
    });

    test('penumbral lunar eclipses are omitted (decision Q2)', () => {
        // They are barely visible and the app's umbral-only model reports no
        // eclipse at all, so their deep links would land on an empty sky.
        expect(eclipses.some((e) => /penumbral/.test(e.kind))).toBe(false);
    });

    test('timezones are zones the platform accepts', () => {
        // The deep links hand these to the apps, which feed Intl directly.
        for (const e of eclipses) {
            expect(
                () => new Intl.DateTimeFormat('en-US', { timeZone: e.tz }),
                `${iso(e.utcMs)} tz=${e.tz}`
            ).not.toThrow();
        }
    });

    test('detail links match the row they belong to', () => {
        for (const e of eclipses) {
            const solar = e.kind.endsWith('-solar');
            const m = e.url.match(
                /^https:\/\/www\.eclipsewise\.com\/(solar|lunar)\/(SE|LE)prime\/2001-2100\/(SE|LE)(\d{4})([A-Za-z]{3})(\d{2})([PATHN])prime\.html$/
            );
            expect(m, `${iso(e.utcMs)} ${e.url}`).not.toBeNull();
            const [, section, dirPrefix, filePrefix, year, mon, day, letter] = m!;
            expect(section).toBe(solar ? 'solar' : 'lunar');
            expect(dirPrefix).toBe(solar ? 'SE' : 'LE');
            expect(filePrefix).toBe(dirPrefix);
            expect(letter).toBe(e.kind[0].toUpperCase());

            // EclipseWise names pages by calendar date; ours is the UT instant
            // of maximum, which can sit on the previous day when TD − ΔT rolls
            // back across midnight.
            const urlDay = Date.parse(`${year} ${mon} ${day} 00:00:00 UTC`);
            expect(Math.abs(urlDay - e.utcMs), `${iso(e.utcMs)} ${e.url}`).toBeLessThan(36 * 3600 * 1000);
        }
    });

    test('central solar eclipses carry path-page precision', () => {
        // Whole-degree catalog coordinates are up to ~78 km off, which can fall
        // outside a narrow umbral path and make a "total" link show a partial.
        // NASA publishes a path page for every central eclipse except the rare
        // non-central ones, so at most a couple of rows may lack one.
        const central = eclipses.filter((e) => /^(total|annular|hybrid)-solar$/.test(e.kind));
        const coarse = central.filter((e) => e.coordSource !== 'path');
        expect(central.length).toBeGreaterThan(0);
        expect(coarse.length / central.length).toBeLessThan(0.1);
    });
});

describe('eclipse-data.json — replayed through the app eclipse model', () => {
    /**
     * At the published instant and place of greatest eclipse, our own model
     * should see the same eclipse NASA does — 114 of the 115 rows exactly,
     * including both hybrids, which are total at greatest eclipse.
     *
     * One category is exempt and asserts the underlying geometry instead of
     * the label: a non-central annular (no path page, so whole-degree catalog
     * coordinates, up to ~78 km off). Its shadow axis misses the Earth
     * entirely, so the strip where the ring is actually visible is narrow and
     * the published position need not be on it; the sole such row,
     * 2014 Apr 29, misses annular by 2.5 arcsec — inside that coordinate
     * uncertainty. For it, require the discs be concentric to within 0.02° —
     * a tighter statement about the ephemeris than any kind label.
     *
     * Hybrids are asserted strictly (planning/2026-08-16-topocentric-eclipse-sizes.md):
     * their discs match to a ten-thousandth of a degree geocentrically, so
     * they only classify as total once the thresholds use topocentric disc
     * sizes. This is the permanent guard on that fix — do not re-exempt them.
     */
    const CONCENTRIC_DEG = 0.02;

    const strictKind: Record<string, EclipseKind> = {
        'total-solar': EclipseKind.TotalSolar,
        'annular-solar': EclipseKind.AnnularSolar,
        'partial-solar': EclipseKind.PartialSolar,
        // Hybrid = annular at the path's ends, total in its middle; NASA's
        // greatest-eclipse point is in the middle.
        'hybrid-solar': EclipseKind.TotalSolar,
        'total-lunar': EclipseKind.TotalLunar,
        'partial-lunar': EclipseKind.PartialLunar,
    };

    const isAmbiguous = (e: Eclipse): boolean =>
        e.kind === 'annular-solar' && e.coordSource === 'catalog';

    test('every row reproduces its kind (or its geometry, at the boundary)', () => {
        const failures: string[] = [];
        for (const e of eclipses) {
            const r = calculateEclipse(appleEpoch(e.utcMs), toRad(e.lat), toRad(e.lon), null);
            const separationDeg = (r.angularSeparation * 180) / Math.PI;
            const got = EclipseKind[r.eclipseKind];
            const label = `${iso(e.utcMs)} ${e.kind} @${e.lat},${e.lon} [${e.coordSource}] -> ${got} sep=${separationDeg.toFixed(4)}°`;

            if (isAmbiguous(e)) {
                if (separationDeg > CONCENTRIC_DEG) failures.push(`${label} (expected concentric discs)`);
            } else if (r.eclipseKind !== strictKind[e.kind]) {
                failures.push(label);
            }
        }
        expect(failures, `${failures.length} row(s) disagree with the eclipse model`).toEqual([]);
    });

    test('lunar rows are eclipsed at their zenith point', () => {
        // The zenith point is on the night side by construction, so the Moon is
        // up and the Earth's shadow is on it.
        for (const e of eclipses.filter((x) => x.kind.endsWith('-lunar'))) {
            const r = calculateEclipse(appleEpoch(e.utcMs), toRad(e.lat), toRad(e.lon), null);
            expect(r.shadowAngularSize, iso(e.utcMs)).toBeGreaterThan(0);
        }
    });

    test('a quarter-moon week later shows nothing (sanity on the time base)', () => {
        // Guards against an off-by-a-lot in the epoch conversion: seven days
        // after any eclipse the Moon is near quadrature, never eclipsed.
        for (const e of eclipses.slice(0, 12)) {
            const r = calculateEclipse(appleEpoch(e.utcMs + 7 * 86400_000), toRad(e.lat), toRad(e.lon), null);
            expect([EclipseKind.NoneSolar, EclipseKind.NoneLunar, EclipseKind.SolarNotUp, EclipseKind.LunarNotUp], iso(e.utcMs)).toContain(
                r.eclipseKind
            );
        }
    });
});
