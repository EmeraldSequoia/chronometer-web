/**
 * Day/night ring polar "always-above transit" regression test.
 *
 * At a polar latitude during polar summer the Sun is always above the horizon,
 * so the day/night rise/set indicators have no true rise/set and fall back to the
 * transit angle. iOS (ECAstronomy.m ~L4619) deliberately adds π in that case
 * because the rise/set search returns the LOW transit, but the indicator should
 * show the HIGH transit (solar noon):
 *
 *     if (isnan(riseTimeAngle)) {
 *         if (EC_nansEqual(riseTimeAngle, kECAlwaysAboveHorizon)) {
 *             rTransitAngle = EC_fmod(rTransitAngle + M_PI, 2 * M_PI);   // high transit
 *         }
 *     }
 *
 * The TS LT path (`computeDayNightLeafAngle`) guards this with
 * `isNaN(riseTime) && isAlwaysAbove(riseTime)`. The "no rise/set" sentinel is the
 * FINITE value ±1e18 (not NaN), so `isNaN(riseTime)` is always false and the +π
 * never fires — the indicator points at the LOW transit (≈ local midnight). The
 * TS LST path uses the correct `isAlwaysAbove(riseTime)` guard.
 *
 * Oracle: `planettransit24HourIndicatorAngle(Sun)` computes the TRUE high transit
 * via an independent path (`planettransitTimeRefined`, wantHighTransit=true) using
 * the SAME local-time conversion, so it is a confound-free reference. The rise/set
 * indicator's always-above fallback must match it (to within the small
 * refined-vs-search transit residual), NOT be π away from it.
 *
 * See planning/2026-06-29-scrub-perf-next-levers.md (Lever A) and
 * planning/verify-polar-transit.ts.
 */
import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { parseWatchXML } from '../watch/xml-parser.js';
import { createWatchEnvironment } from '../watch/watch-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, '..', 'watch', 'assets');

function loadWatch(rel: string) {
    const xmlText = readFileSync(join(ASSETS_DIR, rel), 'utf-8');
    const dom = new JSDOM('', { contentType: 'text/html' });
    const domParser = new dom.window.DOMParser();
    return parseWatchXML(xmlText, 'front', domParser);
}

// Smallest angular distance on the circle.
function circDist(a: number, b: number): number {
    let d = Math.abs(a - b) % (2 * Math.PI);
    return Math.min(d, 2 * Math.PI - d);
}

describe('Day/night ring polar always-above transit (LT path)', () => {
    let perfNowSpy: ReturnType<typeof vi.spyOn>;
    beforeAll(() => { perfNowSpy = vi.spyOn(performance, 'now').mockImplementation(() => 1000); });
    afterAll(() => { perfNowSpy.mockRestore(); });

    // Mauna Kea registers the Sun rise/set indicators and the transit oracle, but
    // these env functions are shared, so any face works. 85°N, June → always-above.
    function polarSummerEnv() {
        const watch = loadWatch(join('mauna-kea', 'MaunaKea-I.xml'));
        const getNow = () => new Date('2025-06-21T12:00:00Z');
        return createWatchEnvironment(watch, 85.0, 21.0, getNow, 'Europe/Oslo');
    }

    test('precondition: 85°N June is polar summer (Sun always above)', () => {
        const env = polarSummerEnv();
        const polarSummer = (env.functions.get('polarSummer') as () => number)();
        expect(polarSummer).toBe(1);
    });

    test('Sun rise indicator falls back to the HIGH transit (solar noon), not the low transit', () => {
        const env = polarSummerEnv();
        const riseIndicator = (env.functions.get('sunrise24HourIndicatorAngle') as () => number)();
        const highTransit = (env.functions.get('planettransit24HourIndicatorAngle') as (p: number) => number)(0);

        // Correct: the always-above fallback equals the true high transit.
        // Bug: it equals high transit − π (the low transit / local midnight).
        expect(circDist(riseIndicator, highTransit)).toBeLessThan(0.05);
        // And it must NOT be ~π away (guards against the dead-isNaN regression).
        expect(circDist(riseIndicator, highTransit)).not.toBeGreaterThan(Math.PI - 0.05);
    });

    test('Sun set indicator falls back to the HIGH transit (solar noon), not the low transit', () => {
        const env = polarSummerEnv();
        const setIndicator = (env.functions.get('sunset24HourIndicatorAngle') as () => number)();
        const highTransit = (env.functions.get('planettransit24HourIndicatorAngle') as (p: number) => number)(0);
        expect(circDist(setIndicator, highTransit)).toBeLessThan(0.05);
    });
});
