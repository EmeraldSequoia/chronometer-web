/**
 * Corrected per-call costs (MOVING clock, proper call syntax — nullary fns need
 * `()` or the compiler returns +fn = NaN without calling). Pinpoints Selene's hogs.
 */
import { createAstroEnvironment } from '../src/shared/astro-env.js';
import { compileExpr } from '../src/expr/compile.js';

let _t = Date.UTC(2026, 5, 28, 12, 0, 0);
const getNow = () => { _t += 2_200_000; return new Date(_t); };
const env = createAstroEnvironment(37.3349, -122.0090, getNow);

function bench(label: string, src: string, iters: number): void {
    const fn = compileExpr(src);
    let acc = 0;
    for (let i = 0; i < 200; i++) acc += fn(env);
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) acc += fn(env);
    const dt = performance.now() - t0;
    if (acc === Infinity) console.log('guard');
    console.log(`  ${label.padEnd(42)} ${((dt * 1000) / iters).toFixed(2)} µs/call`);
}

console.log('\n=== Selene functions, MOVING clock, CORRECT syntax ===\n');
console.log('DEL wedges (×58/tick):');
bench('moonDeltaEclipticLongitudeAtDeltaDay(3)', 'moonDeltaEclipticLongitudeAtDeltaDay(3)', 50_000);
console.log('Rise/set "for day" subdials (×~8/tick):');
bench('moonriseForDayValid()', 'moonriseForDayValid()', 5_000);
bench('moonriseForDayHour12ValueAngle()', 'moonriseForDayHour12ValueAngle()', 5_000);
bench('moonsetForDayHour12ValueAngle()', 'moonsetForDayHour12ValueAngle()', 5_000);
console.log('Planet/moon ecliptic position (×~6/tick):');
bench('ELongitudeOfPlanet(1)', 'ELongitudeOfPlanet(1)', 50_000);
bench('distanceFromEarthOfPlanet(1)', 'distanceFromEarthOfPlanet(1)', 50_000);
console.log('Other moon (×~few/tick):');
bench('moonAltitude()', 'moonAltitude()', 50_000);
bench('moonAgeAngle()', 'moonAgeAngle()', 50_000);
bench('moonElongation()', 'moonElongation()', 50_000);
bench('closestFullMoonDayNumber()', 'closestFullMoonDayNumber()', 20_000);
