/**
 * Verification for the Mauna Kea dawn/dusk alpha ObsValue change
 * (planning/2026-08-22-astro-slop-zero.md §5 follow-up).
 *
 * The dawn/dusk image hands' alpha='sunriseIndicatorValid()' /
 * 'sunsetIndicatorValid()' used to be evaluated by the renderer on every
 * render; they are now backed by discrete ObsValues on the
 * EC_UPDATE_NEXT_SUNRISE_OR_MIDNIGHT / EC_UPDATE_NEXT_SUNSET_OR_MIDNIGHT
 * sentinels (hand-values.ts OBS_ALPHA_SENTINELS). The load-bearing behavior
 * this script checks, at a polar location (Longyearbyen, 78.2°N) across the
 * onset of polar night:
 *
 *   1. The alpha ObsValues exist on the parsed dawn/dusk parts (the renderer
 *      reads part._obsAlpha.currentValue when present).
 *   2. Driven like the engine at 1× (display and perf clocks in lockstep),
 *      the ObsValue tracks a fresh-env evaluation of the indicator function
 *      at every sampled local noon — including across the Oct 25 EU fall-back.
 *   3. The dawn hand's alpha flips 1 → 0 promptly (within one 10-min tick) at
 *      the local midnight that starts the first day with no sunrise — the
 *      polar-onset case where the part's own updateAtNextSunset sentinel
 *      stops firing and a naively-scheduled alpha would stay stale for months.
 *   4. The alphas' nextUpdateDisplayTime stays finite through polar onset
 *      (the …OrMidnight sentinel clamps to local midnight when the rise/set
 *      event stops existing).
 *
 * Run:  npx vite-node planning/verify-mk-alpha-obsvalue.ts
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parseWatchXML } from '../src/watch/xml-parser.js';
import { createWatchEnvironment } from '../src/watch/watch-env.js';
import { buildHandValues } from '../src/watch/hand-values.js';
import { makeOverridableGetNow, type TimingContext } from '../src/shared/updater.js';
import { envTzStateStale } from '../src/shared/astro-env.js';
import type { WatchPart, QHandPart } from '../src/watch/types.js';

const LAT = 78.2, LON = 15.6, TZ = 'Europe/Oslo';   // Longyearbyen
const START_MS = Date.parse('2026-10-12T10:00:00Z'); // local noon-ish, before onset
const END_MS = Date.parse('2026-11-06T12:00:00Z');   // well into polar night
const STEP_MS = 10 * 60 * 1000;                      // 10-min ticks

// ---- Fake 1× clocks: display time and performance.now advance in lockstep ----
let fakeNowMs = START_MS;
let perfMs = 1000;
performance.now = () => perfMs;
if (performance.now() !== perfMs) throw new Error('performance.now patch failed');

const seam = makeOverridableGetNow(() => new Date(fakeNowMs));

// ---- Build the face, env, and the real hand ObsValues (engine wiring) ----
const xml = readFileSync('src/watch/assets/mauna-kea/MaunaKea-I.xml', 'utf8');
const domParser = new (new JSDOM('').window.DOMParser)();
const watch = parseWatchXML(xml, 'front', domParser);

let env = createWatchEnvironment(watch, LAT, LON, seam.getNow, TZ);
const updater = buildHandValues(watch.name, watch, env, perfMs);

function findHand(parts: WatchPart[], name: string): QHandPart {
    for (const p of parts) {
        if (p.type === 'QHand' && p.name === name) return p;
        if (p.type === 'Static') {
            try { return findHand(p.children, name); } catch { /* keep looking */ }
        }
    }
    throw new Error(`part '${name}' not found`);
}
const dawn = findHand(watch.parts, 'dawn');
const dusk = findHand(watch.parts, 'dusk');

// (1) The ObsValues must exist (else the renderer falls back to per-render eval).
if (!dawn._obsAlpha || !dusk._obsAlpha) {
    throw new Error(`_obsAlpha missing: dawn=${!!dawn._obsAlpha} dusk=${!!dusk._obsAlpha}`);
}
console.log(`_obsAlpha created: dawn (interval ${dawn._obsAlpha.updateInterval}), `
    + `dusk (interval ${dusk._obsAlpha.updateInterval})`);

// ---- Drive 1× frames across the window ----
const CTX: TimingContext = { tickIntervalMs: null, displayDeltaSec: 0, direction: 1 };
const localFmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
});

interface NoonSample {
    date: string; dawnAlpha: number; duskAlpha: number;
    sunriseValid: number; sunsetValid: number;
}
const noons: NoonSample[] = [];
const flips: string[] = [];
let prevDawn = dawn._obsAlpha.currentValue;
let prevDusk = dusk._obsAlpha.currentValue;
let lastNoonDate = '';
let failures = 0;

for (; fakeNowMs <= END_MS; fakeNowMs += STEP_MS, perfMs += STEP_MS) {
    // Engine parity (rebuildEnvironments guard): rebuild the env only when its
    // captured tz state went stale (the Oct 25 fall-back), resetting schedules
    // on an offset change.
    if (envTzStateStale(env, TZ) || env.captureStale?.()) {
        const oldOffset = env.tzOffsetSec;
        env = createWatchEnvironment(watch, LAT, LON, seam.getNow, TZ);
        if (env.tzOffsetSec !== oldOffset) updater.reset();
    }
    updater.tick(env, perfMs, seam.getNow, seam.withDisplayTime, CTX);

    const local = localFmt.format(new Date(fakeNowMs));   // "YYYY-MM-DD HH:MM"
    const [date, hhmm] = local.split(' ');

    const dawnA = dawn._obsAlpha.currentValue;
    const duskA = dusk._obsAlpha.currentValue;
    if (dawnA !== prevDawn) { flips.push(`dawn ${prevDawn} -> ${dawnA} at ${local}`); prevDawn = dawnA; }
    if (duskA !== prevDusk) { flips.push(`dusk ${prevDusk} -> ${duskA} at ${local}`); prevDusk = duskA; }

    // (4) Scheduling must never freeze at Infinity, even with no sunrise/sunset.
    if (!isFinite(dawn._obsAlpha.nextUpdateDisplayTime) || !isFinite(dusk._obsAlpha.nextUpdateDisplayTime)) {
        console.log(`FAIL: non-finite nextUpdateDisplayTime at ${local}`);
        failures++;
    }

    // (2) At each local noon, compare against a fresh env (ground truth).
    if (hhmm >= '12:00' && date !== lastNoonDate) {
        lastNoonDate = date;
        const frozen = fakeNowMs;
        const fresh = createWatchEnvironment(watch, LAT, LON, () => new Date(frozen), TZ);
        const sunriseValid = (fresh.functions.get('sunriseIndicatorValid') as () => number)();
        const sunsetValid = (fresh.functions.get('sunsetIndicatorValid') as () => number)();
        noons.push({ date, dawnAlpha: dawnA, duskAlpha: duskA, sunriseValid, sunsetValid });
        if (dawnA !== sunriseValid || duskA !== sunsetValid) {
            console.log(`FAIL: noon ${date}: dawn=${dawnA} (expect ${sunriseValid}), dusk=${duskA} (expect ${sunsetValid})`);
            failures++;
        }
    }
}

console.log('\ndate        dawnAlpha  duskAlpha  sunriseValid  sunsetValid');
for (const n of noons) {
    console.log(`${n.date}     ${n.dawnAlpha}          ${n.duskAlpha}         ${n.sunriseValid}             ${n.sunsetValid}`);
}
console.log('\nflips observed:');
for (const f of flips) console.log('  ' + f);

// (3) The dawn flip must land at a local midnight (within one 10-min tick),
// and both hands must be hidden by the end of the window.
const dawnFlip = flips.find(f => f.startsWith('dawn 1 -> 0'));
if (!dawnFlip) {
    console.log('FAIL: no dawn 1 -> 0 flip in the window'); failures++;
} else {
    const hhmm = dawnFlip.slice(-5);
    if (hhmm !== '00:00' && hhmm !== '00:10') {
        console.log(`FAIL: dawn flip not at local midnight (at ${hhmm})`); failures++;
    }
}
const last = noons[noons.length - 1];
if (!last || last.dawnAlpha !== 0 || last.duskAlpha !== 0 || last.sunriseValid !== 0 || last.sunsetValid !== 0) {
    console.log('FAIL: window did not end in polar night with both hands hidden'); failures++;
}

console.log(failures === 0 ? '\nPASS: all polar-onset checks passed' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
