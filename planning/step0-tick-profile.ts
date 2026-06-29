/**
 * Where does the ~18ms scrub tick actually go? Node-side profile of the real
 * updater.tick() machinery for a heavy face (Miami: 7 day/night rings), with a
 * MOVING clock (1 day/tick, like `1d ▶`). Node's performance.now() has real
 * nanosecond resolution, so unlike the in-browser ?tickprofile the per-eval
 * timing is trustworthy here.
 *
 * Reports: clean total tick (no profiler), the profiled breakdown
 * (update = eval + boundary + interp + rest; animate), the astronomy split, and
 * GC time observed during the run.
 */
import { readFileSync } from 'node:fs';
import { PerformanceObserver } from 'node:perf_hooks';
import { JSDOM } from 'jsdom';
import { parseWatchXML } from '../src/watch/xml-parser.js';
import { createWatchEnvironment } from '../src/watch/watch-env.js';
import { buildHandValues } from '../src/watch/hand-values.js';
import {
    Updater, makeOverridableGetNow, tickProfile, resetTickProfile, setTickProfiling,
    type TimingContext,
} from '../src/shared/updater.js';
import { astroProfile, resetAstroProfile, setAstroProfiling } from '../src/shared/astro-env.js';

const FACE = process.argv[2] || 'miami/Miami-I';
const xml = readFileSync(`src/watch/assets/${FACE}.xml`, 'utf8');
const domParser = new (new JSDOM('').window.DOMParser)();
const watch = parseWatchXML(xml, 'front', domParser);

// Moving clock: +1 calendar day per tick (the heaviest scrub — flips day-parity
// colors and re-crosses rise/set boundaries every tick).
const DAY_MS = 86_400_000;
let displayMs = Date.UTC(2026, 5, 28, 12, 0, 0);
const base = () => new Date(displayMs);
const { getNow, withDisplayTime } = makeOverridableGetNow(base);

const env = createWatchEnvironment(watch, 37.3349, -122.0090, getNow);

// Per-function instrumentation: wrap every env function to count calls + time.
const fnStats = new Map<string, { calls: number; ms: number }>();
let _instr = false;
for (const [name, fn] of env.functions) {
    env.functions.set(name, (...args: number[]) => {
        if (!_instr) return (fn as (...a: number[]) => number)(...args);
        const s = fnStats.get(name) ?? { calls: 0, ms: 0 };
        const t = performance.now();
        const r = (fn as (...a: number[]) => number)(...args);
        s.ms += performance.now() - t; s.calls++; fnStats.set(name, s);
        return r;
    });
}

let perfNow = 0;
const updater: Updater = buildHandValues(watch.name, watch, env, perfNow);
const ctx: TimingContext = { tickIntervalMs: 100, displayDeltaSec: 86400, direction: 1 };

function oneTick(): void {
    displayMs += DAY_MS;
    perfNow += 100;
    updater.tick(env, perfNow, getNow, withDisplayTime, ctx);
}

const N = 2000;

// --- Pass 0: COLD ticks (no warm-up) — mimics a short real scrub where V8
// hasn't optimized the hot path yet. ~60 ticks ≈ a 6 s scrub at 100ms/tick.
const COLD = 60;
const c0 = performance.now();
for (let i = 0; i < COLD; i++) oneTick();
const coldTotal = performance.now() - c0;

for (let i = 0; i < 1000; i++) oneTick();      // warm (JIT)

// --- Pass 1: clean total (no per-eval profiler overhead) ---
setTickProfiling(false); setAstroProfiling(false);
let gcMs = 0, gcCount = 0;
const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) { gcMs += e.duration; gcCount++; }
});
obs.observe({ entryTypes: ['gc'] });
const heap0 = process.memoryUsage().heapUsed;
const t0 = performance.now();
for (let i = 0; i < N; i++) oneTick();
const cleanTotal = performance.now() - t0;
const heap1 = process.memoryUsage().heapUsed;
obs.disconnect();

// --- Pass 2: profiled breakdown ---
setTickProfiling(true); setAstroProfiling(true);
resetTickProfile(); resetAstroProfile();
const t1 = performance.now();
for (let i = 0; i < N; i++) oneTick();
const profiledTotal = performance.now() - t1;

// --- Pass 3: per-function attribution ---
_instr = true;
const PN = 400;
for (let i = 0; i < PN; i++) oneTick();
_instr = false;
const top = [...fnStats.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 10);
console.log(`\n  -- top env functions by total time (${PN} ticks) --`);
for (const [name, s] of top) {
    console.log(`    ${name.padEnd(38)} ${(s.ms / PN).toFixed(3)} ms/tick  (${(s.calls / PN).toFixed(0)} calls/tick, ${(s.ms * 1000 / s.calls).toFixed(2)} µs/call)`);
}

const nVals = updater.all.length;
const p = tickProfile, a = astroProfile;
const rest = p.updateMs - p.evalMs - p.boundaryMs - p.interpMs;
const per = (ms: number) => (ms / N).toFixed(3);

console.log(`\n=== Tick profile: ${watch.name}  (${nVals} obsValues, ${N} ticks, 1 day/tick) ===\n`);
console.log(`  COLD tick (first ${COLD}, no warm-up): ${(coldTotal / COLD).toFixed(3)} ms/tick   <- mimics a short real scrub`);
console.log(`  CLEAN total tick (warmed):        ${per(cleanTotal)} ms/tick   (cold/warm = ${((coldTotal / COLD) / (cleanTotal / N)).toFixed(1)}×)`);
console.log(`  Profiled total tick:              ${per(profiledTotal)} ms/tick   (profiler adds ${(((profiledTotal-cleanTotal)/N)).toFixed(3)} ms/tick of now() overhead)\n`);
console.log(`  -- profiled breakdown (avg/tick) --`);
console.log(`  update total:   ${per(p.updateMs)} ms`);
console.log(`    eval:         ${per(p.evalMs)} ms   (${p.evalCalls} calls, ${(p.evalMs*1000/p.evalCalls).toFixed(3)} µs/call)`);
console.log(`    boundary:     ${per(p.boundaryMs)} ms   (scheduling: computeNextBoundary)`);
console.log(`    interp:       ${per(p.interpMs)} ms`);
console.log(`    rest:         ${per(rest)} ms   (per-value bookkeeping outside the timed sub-parts)`);
console.log(`  animate:        ${per(p.animateMs)} ms   (2nd interpolation pass)`);
console.log(`\n  astronomy:      master ${per(a.masterMs)} ms (${(a.masterComputes/N).toFixed(1)} searches/tick), leaf ${per(a.leafMs)} ms (${(a.leafCalls/N).toFixed(0)} calls/tick)`);
console.log(`\n  GC during clean pass: ${gcMs.toFixed(1)} ms total over ${gcCount} collections = ${(gcMs/N).toFixed(3)} ms/tick`);
console.log(`  Heap growth over ${N} ticks: ${((heap1-heap0)/1e6).toFixed(1)} MB (${((heap1-heap0)/N/1024).toFixed(1)} KB/tick of survivors)\n`);
