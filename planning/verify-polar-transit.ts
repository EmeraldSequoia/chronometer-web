/**
 * Manual verification for the suspected LT day/night "always-above transit"
 * bug (planning/2026-06-29-scrub-perf-next-levers.md, Lever A).
 *
 * Claim under test: in computeDayNightLeafAngle (the LT path), the polar
 * transit adjustment is guarded by `isNaN(riseTime) && isAlwaysAbove(riseTime)`.
 * The "no rise/set" sentinel is the FINITE value ±1e18 (not NaN), so
 * isNaN(riseTime) is always false and the +π adjustment NEVER fires. The LST
 * path uses the correct `isAlwaysAbove(riseTime)` guard.
 *
 * iOS reference (.chronometer-ref/Classes/ECAstronomy.m): iOS does NOT have this
 * bug. Its sentinel is `#define kECAlwaysAboveHorizon nan("2")` (a NaN), and the
 * guard is `if (isnan(riseTimeAngle)) { if (EC_nansEqual(riseTimeAngle,
 * kECAlwaysAboveHorizon)) rTransitAngle += M_PI; }` — it checks the *angle*
 * (which inherits the NaN), so the +π fires. The TS port switched the sentinel to
 * finite ±1e18 and the LT guard kept `isNaN(riseTime)` on a now-finite value, so
 * it became dead. The TS LST path uses the correct `isAlwaysAbove(riseTime)`.
 *
 * This script does NOT modify any source. It:
 *   (1) Proves the guard is structurally dead (pure logic on the sentinel).
 *   (2) Evaluates a face's day/night env functions at a polar location in
 *       summer (always-above) and winter (always-below), printing the angles
 *       in clock-hours and the indicator validity flags, so you can judge
 *       whether the visible output is right and whether the bug is masked.
 *   (3) ISOLATION PROOF: at polar summer the Sun rise/set indicator falls back to
 *       the transit angle. `planettransit24HourIndicatorAngle(Sun)` computes the
 *       true HIGH transit (solar noon) via an independent path using the SAME LT
 *       conversion — a confound-free oracle. The current (buggy) indicator should
 *       read ≈ oracle − π (the LOW transit); current + π should read ≈ oracle.
 *
 * Run:  npx tsx planning/verify-polar-transit.ts [face] [latDeg]
 *   e.g. npx tsx planning/verify-polar-transit.ts mauna-kea/MaunaKea-I 85
 *        npx tsx planning/verify-polar-transit.ts basel/Basel-I 85
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parseWatchXML } from '../src/watch/xml-parser.js';
import { createWatchEnvironment } from '../src/watch/watch-env.js';
import { ALWAYS_ABOVE_HORIZON, ALWAYS_BELOW_HORIZON, isAlwaysAbove } from '../src/astronomy/astro-constants.js';

const FACE = process.argv[2] || 'mauna-kea/MaunaKea-I';
const LAT = parseFloat(process.argv[3] || '85');
const LON = 21.0;
const TZ = 'Europe/Oslo';

// ---- (1) Structural proof: is the LT guard dead? ----
console.log('=== (1) Is the LT transit guard `isNaN(riseTime) && isAlwaysAbove(riseTime)` dead? ===');
for (const [label, sentinel] of [['ALWAYS_ABOVE', ALWAYS_ABOVE_HORIZON], ['ALWAYS_BELOW', ALWAYS_BELOW_HORIZON]] as const) {
    const guardLT = isNaN(sentinel) && isAlwaysAbove(sentinel);     // LT path condition
    const guardLST = isAlwaysAbove(sentinel);                       // LST path condition
    console.log(`  ${label} = ${sentinel}   isNaN=${isNaN(sentinel)}   isAlwaysAbove=${isAlwaysAbove(sentinel)}`
        + `   ->  LT-guard fires? ${guardLT}   LST-guard fires? ${guardLST}`);
}
console.log('  => If LT-guard is always false while LST-guard is true, the LT +π adjustment is unreachable.\n');

// ---- (2) Evaluate the face at a polar location, summer & winter ----
const xml = readFileSync(`src/watch/assets/${FACE}.xml`, 'utf8');
const domParser = new (new JSDOM('').window.DOMParser)();
const watch = parseWatchXML(xml, 'front', domParser);

const toHours = (angleRad: number) => {
    if (!isFinite(angleRad)) return angleRad;
    let h = (angleRad / (2 * Math.PI)) * 24;
    h = ((h % 24) + 24) % 24;
    return h;
};
const fmt = (x: number) => isFinite(x) ? x.toFixed(4) : String(x);

const PROBE_FNS = [
    'sunrise24HourIndicatorAngle', 'sunset24HourIndicatorAngle',
    'sunriseIndicatorValid', 'sunsetIndicatorValid',
    'polarSummer', 'polarWinter',
    // Basel LST analogues (only present on Basel):
    'planetrise24HourIndicatorAngleLST', 'planetset24HourIndicatorAngleLST',
];

for (const [season, iso] of [['POLAR SUMMER (always-above)', '2025-06-21T12:00:00Z'],
                              ['POLAR WINTER (always-below)', '2025-12-21T12:00:00Z']] as const) {
    const getNow = () => new Date(iso);
    const env = createWatchEnvironment(watch, LAT, LON, getNow, TZ);
    console.log(`=== (2) ${FACE} @ ${LAT}°N — ${season}  [${iso}] ===`);
    for (const name of PROBE_FNS) {
        const fn = env.functions.get(name) as ((...a: number[]) => number) | undefined;
        if (!fn) continue;
        // The *24HourIndicatorAngleLST functions take a planet number (Sun = 0).
        const isLST = name.endsWith('LST');
        const v = isLST ? fn(0) : fn();
        const asHours = name.toLowerCase().includes('angle') ? `  (~${fmt(toHours(v))}h on a 24h dial)` : '';
        console.log(`    ${name.padEnd(38)} = ${fmt(v)}${asHours}`);
    }

    // (3) Isolation proof — only meaningful where the Sun is always-above (polar summer).
    const sunIndicator = env.functions.get('sunrise24HourIndicatorAngle') as (() => number) | undefined;
    const sunHighTransit = env.functions.get('planettransit24HourIndicatorAngle') as ((p: number) => number) | undefined;
    const polarSummerFn = env.functions.get('polarSummer') as (() => number) | undefined;
    if (sunIndicator && sunHighTransit && polarSummerFn && polarSummerFn() === 1) {
        const current = sunIndicator();                              // buggy: falls back to LOW transit
        const fixed = ((current + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        const oracle = sunHighTransit(0);                            // independent TRUE high transit (same LT conv)
        const diff = (a: number, b: number) => {
            let d = Math.abs(a - b) % (2 * Math.PI);
            return Math.min(d, 2 * Math.PI - d);
        };
        console.log('    -- BUG ISOLATION (Sun, always-above) --');
        console.log(`      current  sunrise24HourIndicatorAngle   = ${fmt(current)}  (~${fmt(toHours(current))}h)   <- what ships today`);
        console.log(`      fixed    current + π                   = ${fmt(fixed)}  (~${fmt(toHours(fixed))}h)   <- after the 1-token fix`);
        console.log(`      oracle   planettransit (TRUE high)     = ${fmt(oracle)}  (~${fmt(toHours(oracle))}h)   <- independent correct noon`);
        console.log(`      |current − oracle| = ${fmt(diff(current, oracle))} rad (expect ≈ π = ${fmt(Math.PI)} → today points at the LOW transit)`);
        console.log(`      |fixed   − oracle| = ${fmt(diff(fixed, oracle))} rad (expect ≈ 0   → the fix matches the true high transit)`);
    }
    console.log();
}

console.log('Interpretation:');
console.log('  • A *IndicatorValid = 0 means that indicator is HIDDEN (alpha 0) at this latitude,');
console.log('    so an off-by-π angle there would NOT be visible — which would explain a face');
console.log('    "looking correct" at the poles despite the underlying bug.');
console.log('  • For a Sun rise/set indicator at polar summer, the physically correct fallback is');
console.log('    the HIGH transit (~local noon). If the LT angle reads ~local midnight instead, the');
console.log('    +π adjustment is missing (the bug). Compare LT (sunrise24HourIndicatorAngle) against');
console.log('    Basel\'s LST (planetrise24HourIndicatorAngleLST) which applies the +π.');
