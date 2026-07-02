/**
 * Expression environment: the variable + function scope that compiled
 * expressions (see `compile.ts`) evaluate against.
 *
 * This was extracted from the former tree-walking `evaluator.ts` (now deleted)
 * when expression evaluation moved to JS-engine compilation via `new Function`.
 * The environment itself is unchanged: a Map of variables and a Map of
 * functions, all numeric (double-precision), matching the original Chronometer
 * implementation.
 */

export type ExprFunction = (...args: number[]) => number;

export interface Environment {
    /** Mutable variable bindings. */
    variables: Map<string, number>;
    /** Function bindings (math builtins + watch-specific functions). */
    functions: Map<string, ExprFunction>;
    /** Kyoto hand mode: 0 = moving hand (default), 1 = fixed hand at top */
    kyHandMode: number;
    /** Observer latitude in radians (set by watch-env, used by sentinel scheduling). */
    observerLatRad?: number;
    /** Observer longitude in radians (set by watch-env, used by sentinel scheduling). */
    observerLonRad?: number;
    /** Timezone offset in seconds east-positive (set by watch-env, used by sentinel scheduling). */
    tzOffsetSec?: number;
    /** Captured browser→target timezone delta in ms (set by registerAstroFunctions).
     *  Together with tzOffsetSec this is the complete time-dependent state baked into
     *  an env at build time; the per-tick rebuild guard compares both. */
    tzDeltaMs?: number;
    /** Display-time source (set by watch-env, used by renderer ring cache). */
    getNow?: () => Date;
    /** O(1) invalidation of this env's astro cache pool (set by registerAstroFunctions).
     *  Called by the per-tick rebuild guard when it skips a full env rebuild, so
     *  cached astronomy from a previous tick's time can never leak into this tick. */
    invalidateAstroCaches?: () => void;
    /** Does any face-specific build-time capture differ from what a fresh build
     *  would compute at the current display time? Registered only by envs that
     *  actually capture time-dependent state beyond the tz pair (e.g. Terra's
     *  offset-matched top slot). The per-tick rebuild guard consults this in
     *  addition to envTzStateStale; unset means "nothing else captured". */
    captureStale?: () => boolean;
}

/**
 * Create an environment pre-populated with math builtins and standard constants.
 */
export function createDefaultEnvironment(): Environment {
    const variables = new Map<string, number>();
    const functions = new Map<string, ExprFunction>();

    // Standard constants
    variables.set('pi', Math.PI);
    // Note: `true`/`false` are intentionally NOT bound. Compiled expressions use
    // JS's native `true`/`false`, which coerce to 1/0 in every arithmetic and
    // comparison context (and are illegal `new Function` parameter names anyway).

    // Color constants used across watch XMLs
    variables.set('black', 0xFF000000 >>> 0);
    variables.set('white', 0xFFFFFFFF >>> 0);
    variables.set('red', 0xFFFF0000 >>> 0);
    variables.set('green', 0xFF00FF00 >>> 0);
    variables.set('blue', 0xFF0000FF >>> 0);
    variables.set('clear', 0x00000000);
    variables.set('yellow', 0xFFFFFF00 >>> 0);
    variables.set('cyan', 0xFF00FFFF >>> 0);
    variables.set('magenta', 0xFFFF00FF >>> 0);
    variables.set('darkGray', 0xFF555555 >>> 0);   // iOS [UIColor darkGrayColor] = 1/3
    variables.set('lightGray', 0xFFAAAAAA >>> 0);   // iOS [UIColor lightGrayColor] = 2/3

    // Planet number constants (matching ECPlanetNumber enum)
    // Short names for convenient use in expressions (e.g. the Inspector catalog)
    variables.set('Sun', 0);
    variables.set('Moon', 1);
    variables.set('Mercury', 2);
    variables.set('Venus', 3);
    variables.set('Earth', 4);
    variables.set('Mars', 5);
    variables.set('Jupiter', 6);
    variables.set('Saturn', 7);
    variables.set('Uranus', 8);
    variables.set('Neptune', 9);
    variables.set('Pluto', 10);
    // Legacy names (used in watch XML files)
    variables.set('planetSun', 0);
    variables.set('planetMoon', 1);

    // Math functions
    functions.set('sin', Math.sin);
    functions.set('cos', Math.cos);
    functions.set('tan', Math.tan);
    functions.set('asin', Math.asin);
    functions.set('acos', Math.acos);
    functions.set('atan', Math.atan);
    functions.set('atan2', Math.atan2);
    functions.set('sqrt', Math.sqrt);
    functions.set('abs', Math.abs);
    functions.set('floor', Math.floor);
    functions.set('ceil', Math.ceil);
    functions.set('log', Math.log);
    functions.set('exp', Math.exp);
    functions.set('pow', Math.pow);
    functions.set('min', Math.min);
    functions.set('max', Math.max);
    functions.set('round', Math.round);

    // fmod: C-style float modulus (matches the original's use of fmod)
    functions.set('fmod', (a: number, b: number) => a - Math.trunc(a / b) * b);

    return { variables, functions, kyHandMode: 0 };
}
