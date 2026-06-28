/**
 * Unit tests for the JS-compiled expression path (`compile.ts`), which replaced
 * the custom tokenizer/parser/evaluator.
 *
 * These cover the tricky constructs directly with explicit expected values:
 * hex/scientific literals, bitwise/comparison/logical operators (incl. the
 * boolean→1/0 coercion that matches the old evaluator), the comma operator,
 * `<init>` assignment (chained + compound), the var/function name collision, and
 * `referencedNames`. Comprehensive bit-identical coverage across real watch XML
 * lives in the rendering regression suite (src/__tests__/regression).
 */

import { describe, test, expect } from 'vitest';
import { createDefaultEnvironment } from '../env.js';
import type { Environment } from '../env.js';
import { compileExpr, runInit, referencedNames } from '../compile.js';

/** Env with deterministic stub functions + vars for the runtime-expr cases. */
function runtimeEnv(): Environment {
    const env = createDefaultEnvironment();
    env.variables.set('r', 143);
    env.variables.set('th', 26);
    env.functions.set('hour24Number', () => 14);
    env.functions.set('double', (x: number) => x * 2);
    // Name registered as BOTH a variable and a function (mirrors the real
    // `calendarWeekdayStart`): a bare identifier must resolve to the variable
    // (3), a call `dual()` to the function (99).
    env.variables.set('dual', 3);
    env.functions.set('dual', () => 99);
    return env;
}

const evalIn = (src: string, env = runtimeEnv()) => compileExpr(src)(env);

describe('compileExpr: literals and operators', () => {
    const cases: Array<[string, number]> = [
        // Hex (incl. high-bit color constants) and bitwise
        ['0xff00c0ac', 0xff00c0ac],
        ['0xff00c0ac & 0x00ffffff', 0x00c0ac],
        ['0x00ff0000 | 0x0000ff00', 0x00ffff00],
        // bitwise OR is signed 32-bit (matches the old evaluator's `l | r`)
        ['0xff000000 | 0x0000ff00', 0xff000000 | 0x0000ff00],
        ['5 & 3', 1], ['5 | 2', 7], ['5 ^ 1', 4], ['1 << 4', 16], ['256 >> 2', 64], ['~5', -6],
        // Scientific / float literals
        ['1e10', 1e10], ['3.14e-2', 0.0314], ['.5', 0.5], ['2.', 2], ['1.5e3 + 0.25', 1500.25],
        // Comparisons → 1/0 (matches old evaluator, not true/false)
        ['3 < 5', 1], ['3 > 5', 0], ['3 <= 3', 1], ['3 >= 4', 0], ['3 == 3', 1], ['3 != 4', 1],
        // Logical short-circuit, coerced to numbers
        ['1 && 0', 0], ['0 && 5', 0], ['1 || 0', 1], ['0 || 7', 7],
        ['!0', 1], ['!42', 0],
        // Ternary, comma, unary, calls, constants
        ['hour24Number() >= 12 ? 0 : pi', 0],
        ['(1, 2, 3)', 3],
        ['-r', -143], ['+th', 26],
        ['min(max(r, 10), 200)', 143],
        ['double(th)+1', 53],
        ['black', 0xff000000],
        // var/function name collision: bare → variable (3), call → function (99)
        ['dual + 1', 4],
        ['dual()', 99],
        ['double(dual) + dual', 9],
    ];
    for (const [src, expected] of cases) {
        test(src, () => {
            const actual = evalIn(src);
            expect(typeof actual).toBe('number');
            expect(actual).toBe(expected);
        });
    }

    test('trig over variables (close)', () => {
        expect(evalIn('r*cos(th*pi/180)')).toBeCloseTo(143 * Math.cos(26 * Math.PI / 180), 9);
    });

    test('NaN propagates', () => {
        const env = runtimeEnv();
        env.functions.set('nan', () => NaN);
        expect(Number.isNaN(compileExpr('nan() + 1')(env))).toBe(true);
    });
});

describe('runInit: assignment into the variable store', () => {
    function run(src: string): Map<string, number> {
        const env = createDefaultEnvironment();
        runInit(src, env.variables, env.functions);
        return env.variables;
    }

    test('arithmetic + cross-references + trig', () => {
        const v = run('r=143, ri=r-5, th=26, bx=r*cos(th*pi/180)');
        expect(v.get('r')).toBe(143);
        expect(v.get('ri')).toBe(138);
        expect(v.get('bx')).toBeCloseTo(143 * Math.cos(26 * Math.PI / 180), 9);
    });

    test('unary cross-reference', () => {
        const v = run('latitudeY=58, longitudeY=-latitudeY, latlongradius=20');
        expect(v.get('longitudeY')).toBe(-58);
        expect(v.get('latlongradius')).toBe(20);
    });

    test('hex color constants and named colors', () => {
        const v = run('frontBg=0xffb0b0b0, dials=white, dialmarks=black');
        expect(v.get('frontBg')).toBe(0xffb0b0b0);
        expect(v.get('dials')).toBe(0xffffffff);
        expect(v.get('dialmarks')).toBe(0xff000000);
    });

    test('chained assignment (Kyoto)', () => {
        const v = run('hrColor=minColor=black');
        expect(v.get('hrColor')).toBe(0xff000000);
        expect(v.get('minColor')).toBe(0xff000000);
    });

    test('compound assignment and scientific literals', () => {
        const v = run('x=10, x+=5, x*=2, x-=1, x/=2, freq=3.14e-2, big=1e10');
        expect(v.get('x')).toBe(14.5);   // ((10+5)*2 - 1) / 2
        expect(v.get('freq')).toBe(0.0314);
        expect(v.get('big')).toBe(1e10);
    });

    test('multiple blocks accumulate in document order', () => {
        const env = createDefaultEnvironment();
        runInit('azR=130, mainR=118', env.variables, env.functions);
        runInit('riseX=-40, setX=-riseX', env.variables, env.functions);
        expect(env.variables.get('setX')).toBe(40);
        expect(env.variables.get('mainR')).toBe(118);
    });
});

describe('referencedNames', () => {
    test('keeps digit-bearing identifiers whole', () => {
        expect(referencedNames('hour24ValueAngle()')).toEqual(['hour24ValueAngle']);
        expect(referencedNames('hour24Number() + dayNumber2()').sort())
            .toEqual(['dayNumber2', 'hour24Number']);
    });
    test('does not scan inside hex / scientific literals', () => {
        expect(referencedNames('0xff00c0ac & 0x00ffffff')).toEqual([]);
        expect(referencedNames('1e10 + 3.14e-2')).toEqual([]);
        expect(referencedNames('r*1e3')).toEqual(['r']);
    });
    test('excludes JS reserved words / literals', () => {
        expect(referencedNames('a == true ? b : false').sort()).toEqual(['a', 'b']);
    });
});
