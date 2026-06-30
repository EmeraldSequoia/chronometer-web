/**
 * Reusable warm-tick measurement core, shared by the perf-regression harness
 * (`perf-regression.ts`). Mirrors the measurement `step0-tick-profile.ts` does
 * (same observer, same Gaia/Terra city-slot seeding, same 1-day/tick scrub, same
 * warm-up), but as an importable function returning a number instead of a
 * print-only script. (`step0-tick-profile.ts` predates this and could be
 * refactored onto it later; left as-is to avoid churn.)
 *
 * Node `performance.now()` has real nanosecond resolution, so unlike the in-browser
 * `?tickprofile` these timings are trustworthy and repeatable.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parseWatchXML } from '../../watch/xml-parser.js';
import { createWatchEnvironment, GAIA_SUBDIAL_DEFAULTS, type TerraSlot } from '../../watch/watch-env.js';
import { buildHandValues } from '../../watch/hand-values.js';
import { Updater, makeOverridableGetNow, setTickProfiling, type TimingContext } from '../../shared/updater.js';
import { setAstroProfiling } from '../../shared/astro-env.js';

/** All shipped faces, by `<dir>/<xml-basename>` (the XML lives under src/watch/assets). */
export const ALL_FACES = [
    'babylon/Babylon-I',
    'basel/Basel-I',
    'chandra/Chandra-I-android',
    'firenze/Firenze-I',
    'gaia/Gaia-I',
    'geneva/Geneva-I',
    'haleakala/Haleakala-android',
    'hana/Hana-I-android',
    'kyoto/Kyoto-I',
    'mauna-kea/MaunaKea-I',
    'miami/Miami-I',
    'milano/Milano-I',
    'selene/Selene-I',
    'terra/Terra-I',
    'venezia/Venezia-I',
    'vienna/Vienna-I',
];

/** "gaia/Gaia-I" → "gaia" (the short, stable key used in the baseline). */
export function faceName(faceRel: string): string {
    return faceRel.split('/')[0];
}

const DAY_MS = 86_400_000;
// Cupertino / Bay Area → America/Los_Angeles. Real tz + world-clock city slots make
// Terra/Gaia take the same code paths as the browser (see step0-tick-profile.ts).
const OBSERVER_LAT_DEG = 37.3349;
const OBSERVER_LON_DEG = -122.0090;
const OBSERVER_TZ = 'America/Los_Angeles';

export interface MeasureOpts {
    /** Warm-up ticks before timing (JIT) — default 1000. */
    warmTicks?: number;
    /** Timed ticks — default 2000. */
    measureTicks?: number;
}

/**
 * Warm-tick time (ms/tick) for one face under a 1-day/tick scrub. Throws if the
 * face's tick throws (e.g. a crash) — callers should catch and report it.
 */
export function measureFaceTickMs(faceRel: string, opts: MeasureOpts = {}): number {
    const warmTicks = opts.warmTicks ?? 1000;
    const measureTicks = opts.measureTicks ?? 2000;

    const xml = readFileSync(`src/watch/assets/${faceRel}.xml`, 'utf8');
    const domParser = new (new JSDOM('').window.DOMParser)();
    const watch = parseWatchXML(xml, 'front', domParser);

    let displayMs = Date.UTC(2026, 5, 28, 12, 0, 0);
    const base = () => new Date(displayMs);
    const { getNow, withDisplayTime } = makeOverridableGetNow(base);

    const isGaia = /gaia/i.test(faceRel);
    const slotOverrides: Record<number, TerraSlot> | undefined = isGaia
        ? {
            1: { cityName: 'Observer', olsonId: OBSERVER_TZ, lat: OBSERVER_LAT_DEG, lon: OBSERVER_LON_DEG },
            ...Object.fromEntries(Object.entries(GAIA_SUBDIAL_DEFAULTS).map(([k, v]) => [k, { ...v }])),
        }
        : undefined;

    const env = createWatchEnvironment(
        watch, OBSERVER_LAT_DEG, OBSERVER_LON_DEG, getNow, OBSERVER_TZ, slotOverrides,
    );

    let perfNow = 0;
    const updater: Updater = buildHandValues(watch.name, watch, env, perfNow);
    const ctx: TimingContext = { tickIntervalMs: 100, displayDeltaSec: 86400, direction: 1 };
    setTickProfiling(false);
    setAstroProfiling(false);

    const oneTick = (): void => {
        displayMs += DAY_MS;
        perfNow += 100;
        updater.tick(env, perfNow, getNow, withDisplayTime, ctx);
    };

    for (let i = 0; i < warmTicks; i++) oneTick();
    const t0 = performance.now();
    for (let i = 0; i < measureTicks; i++) oneTick();
    return (performance.now() - t0) / measureTicks;
}

/** Median ms/tick over `runs` independent measurements (smooths run-to-run noise). */
export function medianFaceTickMs(faceRel: string, runs = 4, opts?: MeasureOpts): number {
    const vals: number[] = [];
    for (let i = 0; i < runs; i++) vals.push(measureFaceTickMs(faceRel, opts));
    vals.sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}
