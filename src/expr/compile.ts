/**
 * Expression compilation via the JS engine.
 *
 * Replaces the former custom tokenizer/parser/evaluator: instead of parsing
 * each C-like expression string into an AST and tree-walking it, we compile it
 * once to a closure with `new Function` and call that. The only non-JS "parsing"
 * left anywhere is the `referencedNames` identifier regex below.
 *
 * Two entry points:
 *   - `compileExpr(src, env)` — read-only runtime expressions (the hot path).
 *     Binds only the names the expression references, captured once.
 *   - `runInit(src, vars, fns)` — `<init>` blocks, which assign variables.
 *
 * `new Function` bodies are non-strict (we deliberately do NOT emit
 * `'use strict'`), so the theoretical `0377` octal literal still evaluates and
 * we avoid strict-mode parameter traps. Expression strings come only from
 * shipped XML and the Inspector text box, so this is the same trust boundary as
 * the rest of the source (see the eval-vs-parser plan, Assertion 5).
 */

import type { Environment, ExprFunction } from './env.js';

/**
 * A compiled expression. Evaluated against the env passed *at call time* (not a
 * captured one) — exactly like the old `evalAttr(expr, env)`. This matters
 * because the env is rebuilt on every step/scrub (new tz/time/init bindings)
 * while ObsValues persist; the closure must read whichever env is current.
 */
export type CompiledExpr = (env: Environment) => number;

/**
 * JS reserved words and literals that must never be used as `new Function`
 * parameter names or object-literal shorthand keys. `true`/`false`/`null` are
 * literals; `NaN`/`Infinity`/`undefined` are global values we want native, not
 * shadowed; the rest are keywords that are illegal as binding names. Dropping
 * them from the bound-names list means the generated code uses JS's native
 * meaning — bit-identical to the old evaluator (e.g. `2 == true` → `2 == 1` → 0
 * in both arithmetic/comparison contexts).
 */
const JS_RESERVED = new Set<string>([
    'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
    'in', 'of', 'new', 'typeof', 'void', 'delete', 'instanceof', 'this',
    'function', 'return', 'if', 'else', 'var', 'let', 'const', 'do', 'while',
    'for', 'class', 'with', 'switch', 'case', 'break', 'continue', 'default',
    'throw', 'try', 'catch', 'finally', 'yield', 'await', 'enum', 'export',
    'import', 'extends', 'super', 'debugger',
]);

/**
 * Identifiers referenced by an expression, minus JS reserved words/literals.
 *
 * Single left-to-right scan with the identifier alternative listed FIRST: the
 * scanner consumes a name like `hour24ValueAngle` whole (the `[\w$]*` tail
 * swallows the embedded digits), and the numeric alternatives only win where a
 * literal starts at a position an identifier cannot — `0xff00c0ac`, `1e10`.
 * This is both lookbehind-free (old-Safari safe) and digit-in-identifier safe.
 *
 * (An earlier "strip numeric literals first" approach was buggy: it matched the
 * `24` inside `hour24ValueAngle` and split the name into bogus pieces.)
 */
export function referencedNames(src: string): string[] {
    const toks = src.match(
        /[A-Za-z_$][\w$]*|0[xX][0-9a-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?/g,
    ) ?? [];
    const ids = toks.filter((t) => /^[A-Za-z_$]/.test(t));
    return [...new Set(ids)].filter((n) => !JS_RESERVED.has(n));
}

/**
 * Identifiers used as a CALL — i.e. immediately followed by `(`. Used to
 * disambiguate a name registered as BOTH a variable and a function (e.g.
 * `calendarWeekdayStart`): the old tree-walk evaluator resolved a bare
 * identifier to the variable and a call `name(...)` to the function, purely by
 * syntactic position. (Lookahead only — no lookbehind — so old-Safari safe.)
 */
function calledNames(src: string): Set<string> {
    return new Set(src.match(/[A-Za-z_$][\w$]*(?=\s*\()/g) ?? []);
}

/**
 * Resolve whether a referenced `name` should bind to the env FUNCTION (true) or
 * the env VARIABLE (false), matching the old evaluator: a call → function; a
 * bare identifier → variable. A name in only one map resolves there.
 */
function bindsFunction(
    name: string, called: Set<string>,
    hasVar: boolean, hasFn: boolean,
): boolean {
    return hasFn && (called.has(name) || !hasVar);
}

/**
 * Compile a read-only expression once into an env-parameterized closure. The
 * generated `new Function` body is env-independent; every referenced identifier
 * becomes a parameter, resolved from the env passed at call time (call → the
 * function, bare identifier → the variable; see bindsFunction). Reading both the
 * binding kind AND the value live per call is what keeps it bit-identical to the
 * old evaluator across env rebuilds, runtime variable toggles (Vienna
 * `dialFlip`/`noonOnTop`, Kyoto `kyMode`), and eval-ahead time shifts.
 *
 * An unknown identifier resolves to `undefined`, so the result throws (NaN/
 * TypeError at eval, or SyntaxError here at compile) on malformed input —
 * matching the Inspector's existing try/catch-on-construct behavior.
 */
export function compileExpr(src: string): CompiledExpr {
    const names = referencedNames(src);
    const called = calledNames(src);
    // Leading unary `+` coerces a boolean result to a number: the old evaluator
    // returned 1/0 for top-level comparisons, `!`, and `&&`/`||`, whereas native
    // JS yields true/false. `+x` is the identity on any number (incl. NaN, ±0,
    // ±Infinity), so this is bit-identical for numeric results and fixes the
    // boolean cases.
    const compiled = new Function(...names, `return +(${src});`) as (...a: unknown[]) => number;
    return (env: Environment) => compiled(
        ...names.map((n) =>
            bindsFunction(n, called, env.variables.has(n), env.functions.has(n))
                ? env.functions.get(n)
                : env.variables.get(n),
        ),
    );
}

/**
 * Evaluate an `<init>` block — a comma-separated list of assignments
 * (`cr=136, mainR=cr+18`, chained `hrColor=minColor=black`) — directly into the
 * variable store. There is exactly one writer (init) and one store
 * (`env.variables`), so init writes the store directly; no throwaway scope, no
 * write-back protocol, no retained evaluator.
 *
 * Every assignment target is an identifier, so it appears in `names`, so it is a
 * mutable function parameter whose final value is handed back out and merged
 * into `vars`. Functions (`cos`, `fmod`) and pre-existing variables (`pi`,
 * `black`) flow in as args; functions are never written back.
 */
export function runInit(
    src: string,
    vars: Map<string, number>,
    fns: Map<string, ExprFunction>,
): void {
    const names = referencedNames(src);
    const called = calledNames(src);
    const args = names.map<number | ExprFunction | undefined>(
        (n) => (bindsFunction(n, called, vars.has(n), fns.has(n)) ? fns.get(n) : vars.get(n)),
    );
    const body = `${src};\nreturn {${names.join(',')}};`;
    const out = new Function(...names, body)(...args) as Record<string, number>;
    for (const n of names) {
        if (!fns.has(n)) vars.set(n, out[n]);
    }
}
