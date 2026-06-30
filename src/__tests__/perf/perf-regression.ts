/**
 * Perf-regression harness — a REPORTED, not gated, step in a full regression.
 *
 * Why not a vitest assertion: wall-clock time is machine- and load-dependent, so a
 * hard `tick < Xms` gate is flaky. Instead this measures every face's warm tick,
 * diffs against a committed benchmark (`perf-baseline.json`), prints a per-face +
 * total summary, and ends with an INSTRUCTION for the agent running the regression
 * to surface notable deltas to the user. The correctness suite (`npx vitest run`)
 * remains the hard gate and catches crashes; this catches "still correct, but
 * slower" — any slowdown, holistically, not a hand-picked set of op-counts.
 *
 * Usage:
 *   npx tsx src/__tests__/perf/perf-regression.ts            # compare vs baseline, print summary
 *   npx tsx src/__tests__/perf/perf-regression.ts --runs=3   # fewer runs per face (faster, noisier)
 *   npx tsx src/__tests__/perf/perf-regression.ts --capture   # RE-BASELINE (only on a known-good tree)
 *
 * Re-baseline (`--capture`) is the perf analog of `CAPTURE=1` for the golden files:
 * do it only deliberately, after an *intended* perf change, on a quiet machine.
 *
 * See docs/perf-regression.md for the design.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { ALL_FACES, faceName, medianFaceTickMs } from './profile-core.js';

const BASELINE_PATH = 'src/__tests__/perf/perf-baseline.json';
const SURFACE_PCT = 15;     // |Δ%| at/above this is "notable" …
const SURFACE_MIN_MS = 0.01; // … but only if the absolute move is also ≥ this (drops sub-ms noise)

const args = process.argv.slice(2);
const capture = args.includes('--capture');
const runsArg = args.find((a) => a.startsWith('--runs='));
const runs = runsArg ? Math.max(1, parseInt(runsArg.split('=')[1], 10)) : 4;

interface Baseline {
    capturedAt: string;
    machine: string;
    node: string;
    note: string;
    methodology: string;
    calibrationMs: number;
    faces: Record<string, number>;
}

/** A fixed pure-arithmetic loop — its time is a rough machine-speed yardstick, so a
 *  uniform shift across all faces can be told apart from a real regression. */
function calibrationMs(): number {
    const vals: number[] = [];
    for (let r = 0; r < 5; r++) {
        const t0 = performance.now();
        let s = 0;
        for (let i = 0; i < 5_000_000; i++) s += Math.sqrt(i % 1000) * 1.0000001;
        if (s < 0) throw new Error('unreachable'); // keep the loop from being optimized away
        vals.push(performance.now() - t0);
    }
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
}

type Measured = { name: string; ms: number | null; error?: string };

function measureAll(): Measured[] {
    const out: Measured[] = [];
    for (const face of ALL_FACES) {
        const name = faceName(face);
        process.stderr.write(`  measuring ${name} (${runs}x)…\r`);
        try {
            out.push({ name, ms: round(medianFaceTickMs(face, runs)) });
        } catch (e) {
            out.push({ name, ms: null, error: (e as Error).message.split('\n')[0] });
        }
    }
    process.stderr.write('                                   \r');
    return out;
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

// --- Capture mode: write a fresh baseline ---
if (capture) {
    const cal = round(calibrationMs());
    const measured = measureAll();
    const crashed = measured.filter((m) => m.ms === null);
    if (crashed.length) {
        console.error(`\n✗ Refusing to capture: ${crashed.length} face(s) crashed (${crashed.map((c) => c.name).join(', ')}).`);
        console.error('  A baseline must be captured on a KNOWN-GOOD tree. Fix the crash(es) first.');
        process.exit(1);
    }
    const faces: Record<string, number> = {};
    for (const m of measured) faces[m.name] = m.ms as number;
    const baseline: Baseline = {
        capturedAt: new Date().toISOString().slice(0, 10),
        machine: process.env.PERF_MACHINE ?? '(set PERF_MACHINE env to record the CPU/host)',
        node: process.version,
        note: '(describe the code state, e.g. "post Lever A, pre tz-fix")',
        methodology: `median of ${runs} runs, 1000 warm + 2000 measure ticks, 1 day/tick scrub`,
        calibrationMs: cal,
        faces,
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    const total = round(Object.values(faces).reduce((a, b) => a + b, 0));
    console.log(`Wrote ${BASELINE_PATH}: ${ALL_FACES.length} faces, total ${total} ms, calibration ${cal} ms.`);
    console.log('Remember to fill in `machine` and `note`.');
    process.exit(0);
}

// --- Compare mode: measure, diff vs baseline, print summary + agent directive ---
if (!existsSync(BASELINE_PATH)) {
    console.error(`No baseline at ${BASELINE_PATH}. Capture one on a known-good tree: --capture`);
    process.exit(1);
}
const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const cal = round(calibrationMs());
const measured = measureAll();

const calFactor = baseline.calibrationMs > 0 ? cal / baseline.calibrationMs : 1;

console.log(`\nPerf regression vs baseline (${baseline.capturedAt}, ${baseline.machine})`);
console.log(`methodology: ${baseline.methodology}; this run: median of ${runs}`);
console.log(`machine-speed calibration: this ${cal} ms vs baseline ${baseline.calibrationMs} ms `
    + `→ factor ${round(calFactor)}x (≈1.0 means comparable machines)\n`);

console.log('  face          base      now      Δ%   flag');
console.log('  ----          ----      ---      --   ----');
let baseTotal = 0;
let nowTotal = 0;
let nowTotalComparable = 0; // sum over faces present in both, no crashes
const notable: string[] = [];
for (const m of measured) {
    const base = baseline.faces[m.name];
    if (m.ms === null) {
        console.log(`  ${pad(m.name)} ${fmt(base)}    CRASH         🔴 ${m.error ?? ''}`);
        notable.push(`${m.name}: CRASH (${m.error ?? 'threw'})`);
        if (base !== undefined) baseTotal += base;
        continue;
    }
    if (base === undefined) {
        console.log(`  ${pad(m.name)}    —    ${fmt(m.ms)}     —   (new face — no baseline)`);
        continue;
    }
    const dPct = ((m.ms - base) / base) * 100;
    baseTotal += base;
    nowTotal += m.ms;
    nowTotalComparable += m.ms;
    const isNotable = Math.abs(dPct) >= SURFACE_PCT && Math.abs(m.ms - base) >= SURFACE_MIN_MS;
    const flag = isNotable ? (dPct > 0 ? '⚠ slower' : '✓ faster') : '';
    console.log(`  ${pad(m.name)} ${fmt(base)}  ${fmt(m.ms)}  ${sign(dPct)}%  ${flag}`);
    if (isNotable) notable.push(`${m.name}: ${sign(dPct)}% (${base}→${m.ms} ms)`);
}
const totalPct = baseTotal > 0 ? ((nowTotalComparable - baseTotal) / baseTotal) * 100 : 0;
console.log('  ----          ----      ---      --');
console.log(`  ${pad('TOTAL')} ${fmt(round(baseTotal))}  ${fmt(round(nowTotal))}  ${sign(totalPct)}%`);

console.log('\n──────────────────────────────────────────────────────────────────────');
console.log('AGENT: report the following to the user as part of the regression result:');
console.log(`  • TOTAL Δ vs baseline: ${sign(totalPct)}%  (machine-speed factor ${round(calFactor)}x).`);
if (Math.abs(calFactor - 1) > 0.1) {
    console.log(`    NOTE: calibration ≠ 1.0 — this machine differs from the baseline machine, so a`);
    console.log(`    roughly-uniform shift of ~${sign((calFactor - 1) * 100)}% is expected and is NOT a regression.`);
}
if (notable.length) {
    console.log('  • Faces with |Δ| ≥ ' + SURFACE_PCT + '% (surface these explicitly):');
    for (const n of notable) console.log('      - ' + n);
    console.log('    A LOCALIZED spike (one face up, others flat) is a likely regression — flag it.');
    console.log('    A UNIFORM shift across all faces usually means a different/loaded machine — say so.');
} else {
    console.log('  • No face moved by ≥ ' + SURFACE_PCT + '%. No perf regression to surface.');
}
console.log('  • Surface speedups too: they confirm an optimization, or hint that work was skipped.');
console.log('──────────────────────────────────────────────────────────────────────');

function pad(s: string): string { return (s + '            ').slice(0, 12); }
function fmt(x: number | undefined): string { return x === undefined ? '   —  ' : x.toFixed(3).padStart(7); }
function sign(x: number): string { return (x >= 0 ? '+' : '') + x.toFixed(1); }
