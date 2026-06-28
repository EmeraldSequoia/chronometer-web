/**
 * Step 0 follow-up probe: WHY is a wedge eval so expensive, and why doesn't the
 * cache help across wedges? Theory: the `numLeaves>0` wedge path bypasses the
 * persistent `getPlanetRiseSetCache` memo and re-runs the full ~20-iteration
 * rise + set root-finder on every call, whereas the `numLeaves===0` indicator
 * path hits the memo. Test both at a FIXED time, repeated.
 */
import { createAstroEnvironment } from '../src/shared/astro-env.js';

declare const print: ((s: string) => void) | undefined;
const log = typeof print !== 'undefined' ? print : (s: string) => console.log(s);
const nowMs = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now() : () => Date.now();

const getNow = () => new Date(Date.UTC(2026, 5, 28, 12, 0, 0)); // FIXED time
const env = createAstroEnvironment(21.3, -157.8, getNow, 'Pacific/Honolulu');
const dnla = env.functions.get('dayNightLeafAngle')!;

function probe(label: string, fn: () => number, iters: number): void {
    let acc = 0;
    for (let i = 0; i < 2000; i++) acc += fn();          // warm
    const t0 = nowMs();
    for (let i = 0; i < iters; i++) acc += fn();
    const dt = nowMs() - t0;
    if (acc === Infinity) log('guard');
    log(`  ${label.padEnd(42)} ${((dt * 1000) / iters).toFixed(3)} µs/call`);
}

log('\n=== Why is a wedge eval expensive? (fixed time, repeated calls) ===\n');
log('Sun (planet=0):');
probe('rise indicator  dnla(0,0,0)  [memoized path]', () => dnla(0, 0, 0), 1_000_000);
probe('wedge           dnla(0,5,24) [root-finder]',  () => dnla(0, 5, 24), 200_000);
log('\nMoon (planet=1):');
probe('rise indicator  dnla(1,0,0)  [memoized path]', () => dnla(1, 0, 0), 1_000_000);
probe('wedge           dnla(1,5,24) [root-finder]',  () => dnla(1, 5, 24), 50_000);
log('\nIf the indicator (numLeaves=0) is ~0µs but the wedge (numLeaves=24) is');
log('many µs AT THE SAME FIXED TIME, the wedge path is recomputing the rise/set');
log('root-finder every call instead of reusing a memo — the real bottleneck.\n');
