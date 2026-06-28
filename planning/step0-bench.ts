/**
 * Step 0 benchmark spike for the eval-vs-custom-parser plan
 * (planning/2026-06-15-eval-vs-custom-parser.md).
 *
 * DECISION GATE: compare the current tree-walk evaluator against a
 * `new Function`-compiled closure (bound exactly the way Part 2 of the plan
 * proposes — only referenced names captured once) on representative hot
 * expressions, on both V8 (node) and JSC (jsc helper). Proceed with the full
 * migration only if the compiled closure is materially faster on the
 * expressions that dominate the scrub tick.
 *
 * Build + run:
 *   npx esbuild planning/step0-bench.ts --bundle --format=iife \
 *     --platform=neutral --target=es2020 --outfile=planning/step0-bench.bundle.js
 *   node planning/step0-bench.bundle.js                                  # V8
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc \
 *     planning/step0-bench.bundle.js                                     # JSC
 */

import { parse } from '../src/expr/parser.js';
import { evaluate, type Environment, type ExprFunction } from '../src/expr/evaluator.js';
import { createAstroEnvironment } from '../src/shared/astro-env.js';

// ---------------------------------------------------------------------------
// Portable plumbing (node has console + performance; jsc has print, maybe not
// performance.now — fall back to Date.now()).
// ---------------------------------------------------------------------------
declare const print: ((s: string) => void) | undefined;
const log: (s: string) => void =
    typeof print !== 'undefined' ? print : (s) => console.log(s);
const nowMs: () => number =
    (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? () => performance.now()
        : () => Date.now();
const engine =
    typeof print !== 'undefined' ? 'JSC (jsc)' :
    (typeof process !== 'undefined' ? `V8 (node ${process.version})` : 'unknown');

// ---------------------------------------------------------------------------
// The proposed compiled path (inlined here — expr/compile.ts does not exist
// yet; Step 0 precedes building it). This is exactly the design from the plan:
// bind only referenced names, capture once, spread the few values per call.
// ---------------------------------------------------------------------------
const JS_RESERVED = new Set([
    'true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'in', 'of', 'new',
    'typeof', 'void', 'delete', 'instanceof', 'this', 'function', 'return', 'if',
    'else', 'var', 'let', 'const', 'do', 'while', 'for', 'class', 'with',
]);
function referencedNames(src: string): string[] {
    // NOTE: the plan's "strip-numbers-first" regex is WRONG — it clobbers the
    // digits inside identifiers like `hour24ValueAngle` / `hour24Number`,
    // splitting them into bogus pieces. Single-scan instead, with the
    // identifier alternative listed FIRST so a left-to-right scanner consumes
    // `hour24ValueAngle` whole; the number alternatives only win when a literal
    // starts where an identifier cannot (`0xff00c0ac`, `1e10`). This is
    // lookbehind-free (old-Safari safe) and digit-in-identifier safe.
    const toks = src.match(
        /[A-Za-z_$][\w$]*|0[xX][0-9a-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?/g,
    ) ?? [];
    const ids = toks.filter((t) => /^[A-Za-z_$]/.test(t));
    return [...new Set(ids)].filter((n) => !JS_RESERVED.has(n));
}
type CompiledExpr = () => number;
function compileExpr(src: string, env: Environment): CompiledExpr {
    const names = referencedNames(src).filter(
        (n) => env.variables.has(n) || env.functions.has(n),
    );
    const values = names.map<number | ExprFunction | undefined>(
        (n) => env.functions.get(n) ?? env.variables.get(n),
    );
    const fn = new Function(...names, `return (${src});`) as (...a: unknown[]) => number;
    return () => fn(...values);
}

// ---------------------------------------------------------------------------
// Build a real environment. Honolulu-ish coords so day/night astronomy does
// real work; the function bodies invoked by each eval are the genuine ones
// (this is what makes the "residual function-body work" caveat measurable).
// ---------------------------------------------------------------------------
let displayMs = Date.UTC(2026, 5, 28, 12, 0, 0); // mutable scrub clock
const getNow = () => new Date(displayMs);
const env = createAstroEnvironment(21.3, -157.8, getNow, 'Pacific/Honolulu');
// Render-pass-style arithmetic needs face init vars; set typical values.
env.variables.set('r', 100);
env.variables.set('th', 137);

// ---------------------------------------------------------------------------
// Timing harness. `advance` simulates a scrub (time moves 1 day/tick) so the
// AstroCachePool misses every tick exactly as it does during a real scrub —
// otherwise a fixed clock would let the cache hide all the body work and
// overstate the win. We measure both modes.
// ---------------------------------------------------------------------------
function time(label: string, iters: number, advance: boolean, run: () => number): number {
    // Warm up (let the JIT compile and the cache populate).
    let warm = 0;
    for (let i = 0; i < 2000; i++) { if (advance) displayMs += 86400000; warm += run(); }
    if (warm === Number.POSITIVE_INFINITY) log('(warm guard)');

    displayMs = Date.UTC(2026, 5, 28, 12, 0, 0);
    let acc = 0;
    const t0 = nowMs();
    for (let i = 0; i < iters; i++) {
        if (advance) displayMs += 86400000;
        acc += run();
    }
    const dt = nowMs() - t0;
    // Use acc so the optimizer cannot delete the loop.
    if (acc === Number.POSITIVE_INFINITY) log('(acc guard)');
    const perEvalUs = (dt * 1000) / iters;
    log(`    ${label.padEnd(14)} ${perEvalUs.toFixed(4)} µs/eval   (${dt.toFixed(0)} ms / ${iters} iters)`);
    return perEvalUs;
}

interface Case {
    name: string;
    src: string;
    /** advance the clock per iter (defeats the astro cache — realistic scrub) */
    advance: boolean;
    iters: number;
}
const cases: Case[] = [
    // Control: pure arithmetic, no env-function body. Shows the maximum
    // possible interpreter-overhead win (compiled SHOULD crush tree-walk here).
    { name: 'arith control  r*cos(th*pi/180)', src: 'r*cos(th*pi/180)', advance: false, iters: 2_000_000 },
    // Cheap env fn reading live time (a hand angle).
    { name: 'hand angle      hour24ValueAngle()', src: 'hour24ValueAngle()', advance: true, iters: 1_000_000 },
    // THE dominant scrub-tick expression: a day/night ring wedge. Heavy astro
    // body, recomputed every tick because the clock advances (cache misses).
    { name: 'wedge (HOT)     dayNightLeafAngle(0,5,24)', src: 'dayNightLeafAngle(0,5,24)', advance: true, iters: 200_000 },
    // Same wedge but with a STATIC clock (cache hot) — isolates pure dispatch
    // overhead from the astronomy body (the plan's caveat #1).
    { name: 'wedge (cached)  dayNightLeafAngle(0,5,24)', src: 'dayNightLeafAngle(0,5,24)', advance: false, iters: 1_000_000 },
];

log('');
log(`=== Step 0 benchmark — ${engine} ===`);
log('');

for (const c of cases) {
    log(`  ${c.name}   [${c.advance ? 'advancing clock' : 'static clock'}]`);

    // Sanity: both paths must agree on the value (bit-identical at a fixed time).
    displayMs = Date.UTC(2026, 5, 28, 12, 0, 0);
    const ast = parse(c.src);
    const treeVal = evaluate(ast, env);
    const compiled = compileExpr(c.src, env);
    const compVal = compiled();
    const agree = Object.is(treeVal, compVal) ||
        Math.abs(treeVal - compVal) < 1e-12;
    log(`    value tree=${treeVal}  compiled=${compVal}  ${agree ? 'OK' : '*** MISMATCH ***'}`);

    const tw = time('tree-walk', c.iters, c.advance, () => evaluate(ast, env));
    const cp = time('compiled', c.iters, c.advance, () => compiled());
    const speedup = tw / cp;
    log(`    => compiled is ${speedup.toFixed(2)}× the tree-walk` +
        `  (saves ${(tw - cp).toFixed(4)} µs/eval)`);
    log('');
}

// ---------------------------------------------------------------------------
// REALISTIC RING SCRUB (the case that matters). A real scrub tick advances the
// clock ONCE, then evaluates an entire ring of wedges — all at the SAME time,
// same planet, same day — so the expensive rise/set search caches on the first
// wedge and the rest reuse it (AstroCachePool, keyed by dateInterval w/ 0.5s
// slop). The single-expression rows above advanced the clock on every eval,
// which is the pathological cold-cache case and is NOT how the app runs.
//
// Here we measure the AVERAGE per-eval across a full ring, which is what the
// profiled ~20ms tick actually comprises.
// ---------------------------------------------------------------------------
function ringScrub(planet: number, N: number, ticks: number): void {
    const srcs = Array.from({ length: N }, (_, i) => `dayNightLeafAngle(${planet}, ${i}, ${N})`);
    const asts = srcs.map((s) => parse(s));
    const comps = srcs.map((s) => compileExpr(s, env));
    const totalEvals = ticks * N;

    // Warm up both paths (JIT + populate cache).
    displayMs = Date.UTC(2026, 5, 28, 12, 0, 0);
    let warm = 0;
    for (let t = 0; t < 200; t++) {
        displayMs += 86400000;
        for (let i = 0; i < N; i++) warm += evaluate(asts[i], env);
        for (let i = 0; i < N; i++) warm += comps[i]();
    }
    if (warm === Number.POSITIVE_INFINITY) log('(warm guard)');

    // Tree-walk pass.
    displayMs = Date.UTC(2026, 5, 28, 12, 0, 0);
    let acc = 0;
    let t0 = nowMs();
    for (let t = 0; t < ticks; t++) {
        displayMs += 86400000;
        for (let i = 0; i < N; i++) acc += evaluate(asts[i], env);
    }
    const twMs = nowMs() - t0;

    // Compiled pass — identical tick schedule (same cache behaviour).
    displayMs = Date.UTC(2026, 5, 28, 12, 0, 0);
    t0 = nowMs();
    for (let t = 0; t < ticks; t++) {
        displayMs += 86400000;
        for (let i = 0; i < N; i++) acc += comps[i]();
    }
    const cpMs = nowMs() - t0;
    if (acc === Number.POSITIVE_INFINITY) log('(acc guard)');

    const twUs = (twMs * 1000) / totalEvals;
    const cpUs = (cpMs * 1000) / totalEvals;
    log(`  ring planet=${planet} N=${N}  (advance clock once/tick, eval whole ring/tick)`);
    log(`    tree-walk      ${twUs.toFixed(4)} µs/eval   (${twMs.toFixed(0)} ms / ${totalEvals} evals)`);
    log(`    compiled       ${cpUs.toFixed(4)} µs/eval   (${cpMs.toFixed(0)} ms / ${totalEvals} evals)`);
    log(`    => compiled is ${(twUs / cpUs).toFixed(2)}× the tree-walk  (saves ${(twUs - cpUs).toFixed(4)} µs/eval)`);
    log('');
}

log('--- realistic ring scrub (cache active across wedges in a tick) ---');
log('');
ringScrub(0, 24, 20_000);   // Sun, 24-wedge ring
ringScrub(1, 24, 20_000);   // Moon, 24-wedge ring
ringScrub(0, 96, 5_000);    // Sun, 96-wedge ring (profiling's ~96 obsValues/ring)
ringScrub(1, 96, 5_000);    // Moon, 96-wedge ring

log('Decision gate: proceed only if "compiled" is materially faster than');
log('"tree-walk" on the realistic RING SCRUB rows — that is what the');
log('profiled ~20ms scrub tick actually comprises.');
log('');
