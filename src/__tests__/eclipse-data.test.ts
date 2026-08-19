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
 * Times: rows store `tdMs`, the TT (TDT) instant of greatest eclipse — the
 * frame the eclipse geometry is computed in. NASA's published UT labels bake
 * in frozen ΔT predictions of assorted vintages, so UT is never stored; it is
 * derived here (and by the page module) through the engine's own leap-exact
 * ΔT via convertETtoUT. Replaying at that derived instant makes the engine's
 * internal TT equal NASA's TT exactly, which is what lets every row be
 * asserted strictly regardless of whose ΔT prediction ages how.
 * See planning/2026-08-17-eclipse-precision-and-verification.md §3b.
 *
 * Read as JSON text rather than imported: tsconfig has no resolveJsonModule and
 * build.sh gates on `tsc --noEmit` over src/**.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { calculateEclipse, EclipseKind } from '../astronomy/es-astro';
import { convertETtoUT } from '../astronomy/es-time';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '../help/eclipse-data.json');
const RAW = readFileSync(DATA_PATH, 'utf-8');

interface Eclipse {
    tdMs: number;
    nasaDeltaT: number;
    kind: string;
    region: string;
    pathRegion: string | null;
    lat: number;
    lon: number;
    coordSource: 'besselian' | 'catalog';
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

const appleEpoch = (ms: number): number => ms / 1000 - 978307200;
const toRad = (deg: number): number => (deg * Math.PI) / 180;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 16);

/** The row's UT instant of greatest eclipse (Apple-epoch seconds), derived
 *  from the stored TT through the engine's own ΔT — see the header. */
const utSeconds = (e: Eclipse): number => convertETtoUT(appleEpoch(e.tdMs));
const utMs = (e: Eclipse): number => (utSeconds(e) + 978307200) * 1000;

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
        // non-penumbral count per year never leaves 2–7. Years are counted on
        // the TD instant, matching the scraper's own gate.
        const perYear = new Map<number, number>();
        for (const e of eclipses) {
            const year = new Date(e.tdMs).getUTCFullYear();
            perYear.set(year, (perYear.get(year) ?? 0) + 1);
        }
        for (let year = meta.startYear; year <= meta.endYear; year++) {
            const n = perYear.get(year) ?? 0;
            expect(n, `${year} has ${n} eclipses`).toBeGreaterThanOrEqual(2);
            expect(n, `${year} has ${n} eclipses`).toBeLessThanOrEqual(7);
        }
    });

    test('reaches both edges of the advertised span', () => {
        const years = eclipses.map((e) => new Date(e.tdMs).getUTCFullYear());
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
            expect(eclipses[i].tdMs).toBeGreaterThan(eclipses[i - 1].tdMs);
        }
    });

    test('every row is inside the covered years', () => {
        for (const e of eclipses) {
            const year = new Date(e.tdMs).getUTCFullYear();
            expect(year).toBeGreaterThanOrEqual(meta.startYear);
            expect(year).toBeLessThanOrEqual(meta.endYear);
        }
    });

    test('fields are present and in range', () => {
        for (const e of eclipses) {
            const where = iso(e.tdMs);
            expect(ALL_KINDS, where).toContain(e.kind);
            expect(Number.isFinite(e.tdMs), where).toBe(true);
            // NASA's per-row ΔT: 66.3 s (2011) rising along their polynomial
            // to ~85 s by 2041. Well outside this band means the column moved.
            expect(e.nasaDeltaT, where).toBeGreaterThan(60);
            expect(e.nasaDeltaT, where).toBeLessThan(90);
            expect(e.lat, where).toBeGreaterThanOrEqual(-90);
            expect(e.lat, where).toBeLessThanOrEqual(90);
            expect(e.lon, where).toBeGreaterThanOrEqual(-180);
            expect(e.lon, where).toBeLessThanOrEqual(180);
            expect(['besselian', 'catalog'], where).toContain(e.coordSource);
            expect(e.region.length, where).toBeGreaterThan(2);
            if (e.pathRegion !== null) expect(e.pathRegion.length, where).toBeGreaterThan(2);
        }
    });

    test('derived UT stays within sane ΔT of the stored TT', () => {
        // The engine's ΔT runs from 66.2 s (2011, leap-exact) to ~80 s by 2041
        // (rejoined polynomial). A derivation bug — wrong epoch, wrong sign,
        // double conversion — lands far outside this band.
        for (const e of eclipses) {
            const deltaT = appleEpoch(e.tdMs) - utSeconds(e);
            expect(deltaT, `${iso(e.tdMs)} ΔT=${deltaT}`).toBeGreaterThan(60);
            expect(deltaT, `${iso(e.tdMs)} ΔT=${deltaT}`).toBeLessThan(85);
        }
    });

    test('only central solar eclipses describe a path', () => {
        // The decade tables bracket a path description for exactly the
        // eclipses that have one. Tying the two together catches a column
        // shift in that table, which would otherwise swap prose silently:
        // region text is free-form, so nothing else can tell right from wrong.
        for (const e of eclipses) {
            const central = /^(total|annular|hybrid)-solar$/.test(e.kind);
            expect(e.pathRegion !== null, `${iso(e.tdMs)} ${e.kind}`).toBe(central);
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
                `${iso(e.tdMs)} tz=${e.tz}`
            ).not.toThrow();
        }
    });

    test('detail links match the row they belong to', () => {
        for (const e of eclipses) {
            const solar = e.kind.endsWith('-solar');
            const m = e.url.match(
                /^https:\/\/www\.eclipsewise\.com\/(solar|lunar)\/(SE|LE)prime\/2001-2100\/(SE|LE)(\d{4})([A-Za-z]{3})(\d{2})([PATHN])prime\.html$/
            );
            expect(m, `${iso(e.tdMs)} ${e.url}`).not.toBeNull();
            const [, section, dirPrefix, filePrefix, year, mon, day, letter] = m!;
            expect(section).toBe(solar ? 'solar' : 'lunar');
            expect(dirPrefix).toBe(solar ? 'SE' : 'LE');
            expect(filePrefix).toBe(dirPrefix);
            expect(letter).toBe(e.kind[0].toUpperCase());

            // EclipseWise names pages by calendar date; ours is the TT instant
            // of maximum, which can sit on the next day when ΔT carries it
            // across midnight.
            const urlDay = Date.parse(`${year} ${mon} ${day} 00:00:00 UTC`);
            expect(Math.abs(urlDay - utMs(e)), `${iso(e.tdMs)} ${e.url}`).toBeLessThan(36 * 3600 * 1000);
        }
    });

    test('every solar row is besselian-sourced', () => {
        // Solar positions come from the Besselian greatest-eclipse reduction
        // (scrape-eclipses.mjs) — one consistent ΔT convention for time and
        // longitude, and sub-degree positions for the 27 rows the catalogs
        // round to whole degrees (that rounding used to drop partial-eclipse
        // deep links ~0.3° off the horizon). Lunar rows keep whole-degree
        // catalog coordinates, where rounding is harmless.
        for (const e of eclipses) {
            expect(e.coordSource, `${iso(e.tdMs)} ${e.kind}`).toBe(
                e.kind.endsWith('-solar') ? 'besselian' : 'catalog'
            );
        }
    });
});

describe('eclipse-data.json — replayed through the app eclipse model', () => {
    /**
     * At the greatest-eclipse instant and place, our own model should see the
     * same eclipse NASA does — 114 of the 115 rows exactly, including both
     * hybrids, which are total at greatest eclipse. The replay runs at the
     * derived UT (see header), so the engine's internal TT equals NASA's TT
     * exactly; the ΔT-vintage ambiguity that once forced an exemption for
     * 2032 May 09 (22 s of annularity, published UT ~7 s off our clock) is
     * gone, and that row is asserted strictly.
     *
     * One row is exempt and asserts the underlying geometry instead of the
     * label: requiring the discs concentric to within 0.02° is a tighter
     * statement about the ephemeris than any kind label. 2014 Apr 29 is the
     * century's only non-central annular (gamma −1.0000, path width 0.0 km):
     * its greatest-eclipse point is the graze point where the annular
     * threshold is met with *zero margin by construction*, so the computed
     * kind flips between annular and partial on sub-arcsecond ephemeris
     * differences — ours puts it ~2.5″ outside, and JPL Horizons agrees to
     * half an arcsecond (plan §2a). The exemption is keyed by date so it
     * cannot silently widen.
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

    /** TD dates of rows whose kind is grazing-ambiguous — see above. */
    const GRAZING = new Set(['2014-04-29']);
    const isGrazing = (e: Eclipse): boolean => GRAZING.has(iso(e.tdMs).slice(0, 10));

    test('every row reproduces its kind (or its geometry, at the graze)', () => {
        const failures: string[] = [];
        for (const e of eclipses) {
            const r = calculateEclipse(utSeconds(e), toRad(e.lat), toRad(e.lon), null);
            const separationDeg = (r.angularSeparation * 180) / Math.PI;
            const got = EclipseKind[r.eclipseKind];
            const label = `${iso(e.tdMs)} ${e.kind} @${e.lat},${e.lon} [${e.coordSource}] -> ${got} sep=${separationDeg.toFixed(4)}°`;

            if (isGrazing(e)) {
                if (separationDeg > CONCENTRIC_DEG) failures.push(`${label} (expected concentric discs)`);
            } else if (r.eclipseKind !== strictKind[e.kind]) {
                failures.push(label);
            }
        }
        expect(failures, `${failures.length} row(s) disagree with the eclipse model`).toEqual([]);
    });

    test('every grazing exemption names a real non-central annular row', () => {
        // Keeps the exemption from rotting into a blanket excuse: a stale key
        // (data regenerated, row dropped, date shifted) fails here rather than
        // silently exempting nothing — or, worse, the wrong thing.
        for (const key of GRAZING) {
            const row = eclipses.find((e) => iso(e.tdMs).slice(0, 10) === key);
            expect(row, `no eclipse on ${key}`).toBeDefined();
            expect(row!.kind, key).toBe('annular-solar');
        }
    });

    test('lunar rows are eclipsed at their zenith point', () => {
        // The zenith point is on the night side by construction, so the Moon is
        // up and the Earth's shadow is on it.
        for (const e of eclipses.filter((x) => x.kind.endsWith('-lunar'))) {
            const r = calculateEclipse(utSeconds(e), toRad(e.lat), toRad(e.lon), null);
            expect(r.shadowAngularSize, iso(e.tdMs)).toBeGreaterThan(0);
        }
    });

    test('a quarter-moon week later shows nothing (sanity on the time base)', () => {
        // Guards against an off-by-a-lot in the epoch conversion: seven days
        // after any eclipse the Moon is near quadrature, never eclipsed.
        for (const e of eclipses.slice(0, 12)) {
            const r = calculateEclipse(utSeconds(e) + 7 * 86400, toRad(e.lat), toRad(e.lon), null);
            expect([EclipseKind.NoneSolar, EclipseKind.NoneLunar, EclipseKind.SolarNotUp, EclipseKind.LunarNotUp], iso(e.tdMs)).toContain(
                r.eclipseKind
            );
        }
    });
});
