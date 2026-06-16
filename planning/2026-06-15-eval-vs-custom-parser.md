# Replacing the Custom Expression Parser with `eval()`

**Date:** 2026-06-15  
**Status:** Analysis / Investigation

## Background

The Chronometer expression system was ported from the iOS reference code, where a
custom lex/yacc parser was essential: C/Objective-C has no built-in interpreter for
data-driven expressions. The parser converts expression strings from XML into a
binary AST, and the evaluator walks that AST at runtime.

In JavaScript/TypeScript, the situation is fundamentally different — a built-in
interpreter is available via `eval()` or `new Function()`. This document
evaluates whether switching to the JS interpreter is sound, practical, and net
beneficial.

---

## Assertion 1: Syntax Compatibility

**Verdict: ✅ True — with a few very minor wrinkles that are easily handled.**

The expression language documented in [expressions.md](../docs/expressions.md) and
implemented in the [tokenizer](../src/expr/tokenizer.ts), [parser](../src/expr/parser.ts),
and [evaluator](../src/expr/evaluator.ts) supports the following constructs.
Each is assessed against JavaScript syntax:

| Construct | Example | JS-compatible? | Notes |
|-----------|---------|:-:|-------|
| Arithmetic `+ - * / %` | `r*cos(th*pi/180)` | ✅ | Identical |
| Comparisons `< > <= >= == !=` | `hour24Number() >= 12` | ✅ | `==`/`!=` in JS use type coercion, but all values are numbers, so this is safe (and matches C). Could use `===`/`!==` — same result for number-to-number |
| Logical `&& \|\|` | `!timeIsCorrect() \|\| manualSet()` | ✅ | Identical, including short-circuit semantics |
| Logical NOT `!` | `!0` → `1` | ⚠️ | In C, `!0 → 1`, `!42 → 0`. In JS, `!0 → true`, `!42 → false`. The ternary and comparison uses that consume `!` results treat truthy/falsy, so this works. But if a `!` result is used *arithmetically* (multiplied, added), `true`/`false` coerce to `1`/`0` in JS, so it works correctly |
| Ternary `? :` | `a ? b : c` | ✅ | Identical |
| Function calls | `sin(x)`, `hour24Number()` | ✅ | So long as the function names are in scope |
| Variables | `pi`, `mainR` | ✅ | So long as variable names are in scope |
| Assignment `=` | `cr=136` | ✅ | JS assignment expressions return the assigned value, same as C |
| Chained assignment | `hrColor=minColor=black` | ✅ | JS right-to-left assignment: `hrColor = (minColor = black)` — works correctly. Found in Kyoto-I.xml |
| Compound assignment `+= -= *= /=` | `x += 5` | ✅ | Identical |
| Comma operator | `a=1, b=2, c=a+b` | ✅ | JS comma operator evaluates left-to-right, returns last — matches the C/evaluator behavior exactly |
| Unary `+ -` | `-riseX` | ✅ | Identical |
| Bitwise `& \| ^ ~ << >>` | `5 & 3` | ✅ | Identical (all operate on 32-bit integers in both) |
| Hex literals | `0xff00c0ac` | ✅ | JS `parseInt` and literal parsing handle hex identically |
| Decimal/float literals | `3.14`, `.5`, `2.` | ✅ | Identical |
| Scientific notation | `1e10`, `3.14e-2` | ✅ | Identical |
| Octal literals | `0377` | ⚠️ | C interprets `0377` as octal (= 255). JS strict mode forbids `0`-prefixed octals — `eval('0377')` throws in strict mode. **However: no octal literals appear in any XML file** — I searched all `.xml` files and found zero occurrences. The only octal handling is in the tokenizer test suite. This is a non-issue for the actual data |
| Block comments `/* */` | | N/A | Supported by the tokenizer but not present in any XML expression — **zero occurrences found**. JS also supports `/* */` so it would work anyway |
| Parenthesized expressions | `(a + b) * c` | ✅ | Identical |

### Summary

Every syntax construct actually used in the XML expression data is valid JavaScript.
The octal literal edge case is theoretical only — no XML file uses octal literals.
The `!` operator produces `boolean` in JS rather than `0`/`1`, but JS auto-coerces
`true → 1` and `false → 0` in arithmetic contexts, so the behavior is identical in
all practical uses.

### NaN and Infinity

Both `NaN` and `Infinity` flow through the expression system, but they are
**never expression-syntax literals** — they come from function return values
and are consumed by downstream code:

**NaN sources (all from function returns, not expression strings):**
- Astronomical functions return `NaN` when an event doesn't occur today
  (e.g., `riseSetForDay()` → `NaN` at polar latitudes where the sun
  doesn't rise). See [astro-env.ts](../src/shared/astro-env.ts) L472–509.
- `riseOfPlanetForDayValid(body)` tests `isNaN(riseSetForDay(...))` to
  return 0 or 1 — so `NaN` is produced and consumed entirely within the
  function layer; it doesn't appear as an expression token.
- `ObsValue.currentValue` documents that `NaN` means "don't display this
  element" ([obs-value.ts](../src/shared/obs-value.ts) L70).

**NaN consumers:**
- [animation.ts](../src/shared/animation.ts) L780–789: `startAnimationRaw()`
  checks `isNaN(newTarget) || isNaN(val.currentValue)` and snaps immediately
  — no interpolation is meaningful when transitioning to/from "don't display".
- [renderer.ts](../src/watch/renderer.ts) L2680: checks `!isNaN(slotNumber)`.

**Infinity sources:**
- `JUMP = Infinity` in [obs-value.ts](../src/shared/obs-value.ts) — used as
  an animation speed sentinel meaning "snap instantly".
- `nextUpdateTime = Infinity` — "never re-evaluate" (frozen state).
- `computeNextBoundary()` returns `Infinity` for environment-only sentinels.

**Impact on the eval() migration: None.**

Neither `NaN` nor `Infinity` appear as tokens in any XML expression string
(verified by grep across all `.xml` files). They enter the system exclusively
as JavaScript `number` values returned by environment functions (`getNow`,
`riseSetForDay`, etc.) or set in `ObsValue` fields. Since `eval()` evaluates
expressions in a scope where these functions are bound as regular JS
functions, they will continue to return `NaN`/`Infinity` as JS numbers
exactly as they do today.

The one semantic note: in the current custom evaluator, comparison operators
return `0`/`1` as integers (L232–237). When a function returns `NaN` and
the expression compares it (e.g., `result >= 12`), both C and JS comparisons
with NaN return false/0 — the behavior is identical. The TS evaluator
already uses JS comparison semantics (`l < r ? 1 : 0`) and the `eval()`
approach would use native `<`, which returns `false` (coerces to `0` in
arithmetic context). Same result.

---

## Assertion 2: Complexity Win

**Verdict: ✅ Clear win.**

The custom expression system comprises:

| File | Lines | Purpose |
|------|------:|---------|
| [tokenizer.ts](../src/expr/tokenizer.ts) | 262 | Token stream |
| [parser.ts](../src/expr/parser.ts) | 410 | Recursive-descent → AST |
| [evaluator.ts](../src/expr/evaluator.ts) | 266 | AST walker |
| [expr.test.ts](../src/expr/__tests__/expr.test.ts) | 646 | Test suite |
| **Total** | **1,584** | |

With `eval()`, **all of tokenizer.ts and parser.ts go away**. The evaluator
simplifies to a thin wrapper that calls `eval()` or `new Function()` in an
environment where all variables and functions are defined. The test suite shrinks
drastically (testing the JS interpreter's parsing is pointless; only the
environment setup and evaluation wrapper need testing).

Additionally, `ASTNode` type references that thread through the codebase simplify
to `string`:

- [types.ts](../src/watch/types.ts) — ~80 `ASTNode` optional fields become `string`
- [xml-parser.ts](../src/watch/xml-parser.ts) — `attrExpr()` stops calling `parse()`, just returns the raw string
- [obs-value.ts](../src/shared/obs-value.ts) — `expr: ASTNode` → `expr: string`
- [astro-env.ts](../src/shared/astro-env.ts) — `evalAttr()` changes implementation
- [watch-env.ts](../src/watch/watch-env.ts) — `evaluate(expr, env)` calls change
- [terminator.ts](../src/watch/terminator.ts) — minor import change

The `Environment` interface itself (variables Map + functions Map) remains, but
its role changes from "AST evaluator context" to "JS eval scope setup".

---

## Assertion 3: Memory Savings

**Verdict: ✅ True, modest but real.**

Currently every numeric XML attribute is pre-parsed into an AST tree. A typical
`ASTNode` for `r*cos(th*pi/180)` creates ~9 heap objects (BinaryOp, FunctionCall,
BinaryOp, BinaryOp, Identifier×3, NumberLiteral). A watch face like Basel has
hundreds of expression attributes — easily thousands of AST nodes in memory.

With `eval()`, these are all replaced by the original expression strings, which
are already in memory as part of the XML parse. Strings are primitive-like,
typically interned, and have no per-object overhead.

The savings are modest in absolute terms (probably tens of KB per face) but
directionally correct and contribute to the overall simplification.

---

## Assertion 4: Performance Savings

**Verdict: ✅ True, with nuance.**

### Parse-time savings
Startup is faster because parsing XML attributes no longer requires a recursive-
descent parse per attribute — strings are just kept as-is. This is a one-time
win per face load.

### Eval-time: wash or slight win
Currently, evaluating an expression requires JS code (the `evaluate()` walker) to
traverse a JS object tree. With `eval()`, the JS engine compiles the expression
to bytecode (or even JIT-compiles it to native code) the first time it's seen.
Subsequent evaluations of the same expression via a cached `Function` object are
extremely fast — the JS engine is heavily optimized for this.

In practice, `new Function(...)` with pre-bound variables is slightly faster than
a custom tree-walker for expressions that are evaluated many times per second
(which is exactly the use case for animation-tick expressions).

The performance win is not dramatic (the evaluator is already fast), but the
direction is correct.

---

## Assertion 5: No Security Loss

**Verdict: ✅ Correct — no security regression.**

### 5a. No user-controlled expression injection
The expression strings come from three sources:

1. **XML files** shipped with the app (static assets, not user-editable)
2. **Init block expressions** in XML (same source)
3. **Inspector free-form text box** (where the user types arbitrary expressions)

For cases 1 and 2, the app evaluates its own shipped code — the same trust
boundary as the rest of the TypeScript source. `eval()` on trusted data is
no different from running compiled code.

### 5b. Inspector is already an open sandbox
The Inspector already lets the user evaluate arbitrary expressions, and the
user already has access to the Chrome DevTools console. `eval()` in the
Inspector adds no capability the user doesn't already have.

### 5c. No server-side execution
This is a fully static client-side app with no backend. There are no server
callbacks, no database queries, no authentication tokens. Even if a user
could inject arbitrary JS (which they can already via the console), there is
nothing dangerous to access.

### 5d. JS engine vs. custom code
The V8/JavaScriptCore `eval()` implementation is tested against billions of
invocations daily and has dedicated security teams. Our custom parser/evaluator
is a ~900-line hand-rolled implementation. From a security standpoint, the
battle-tested engine is strictly better.

---

## Assertion 6: Implementation Plan

**Verdict: ✅ Correct decomposition, with some additional details.**

### Part 1: Change expression representation from `ASTNode` to `string`

**Files affected:**
- [types.ts](../src/watch/types.ts) — All `ASTNode` optional fields → `string` (Watch.initExprs: `string[]`)
- [xml-parser.ts](../src/watch/xml-parser.ts) — `attrExpr()` returns `string | undefined` instead of calling `parse()`; `processElement` for `<init>` stores raw expression string
- [obs-value.ts](../src/shared/obs-value.ts) — `expr: ASTNode` → `expr: string`

### Part 2: Change evaluation to use `eval()` / `new Function()`

**Files affected:**
- [evaluator.ts](../src/expr/evaluator.ts) — Replace `evaluate()` with a function that:
  1. Destructures `env.variables` and `env.functions` into a scope object
  2. Calls `new Function(...varNames, ...fnNames, 'return (' + expr + ')')(...varValues, ...fnValues)`
  3. For init blocks (with assignments), uses a different wrapper that declares
     `let` variables and writes back to `env.variables`
- [astro-env.ts](../src/shared/astro-env.ts) — `evalAttr()` signature changes (`string | undefined` instead of `ASTNode | undefined`)
- [watch-env.ts](../src/watch/watch-env.ts) — `evaluate()` calls for init block evaluation change
- [terminator.ts](../src/watch/terminator.ts) — Minor: `ASTNode` → `string` for `terminatorAngle()` params
- [updater.ts](../src/shared/updater.ts) — `evalAttr()` calls unchanged (the function signature changes, but call sites don't)
- [animation.ts](../src/shared/animation.ts) — No ASTNode references; no changes needed
- [renderer.ts](../src/watch/renderer.ts) — `evalAttr()` and `evalColor()` calls unchanged

**Implementation approach for `new Function()`:**

The key design choice is how to bridge the `Environment` (Maps of variables and
functions) with the JS eval scope. Two options:

**Option A — `new Function()` with explicit parameter binding:**
```typescript
function evalExpr(expr: string, env: Environment): number {
    const names = [...env.variables.keys(), ...env.functions.keys()];
    const values = [...env.variables.values(), ...env.functions.values()];
    const fn = new Function(...names, `return (${expr})`);
    return fn(...values);
}
```
Pro: Clean sandbox. Con: Creating a new Function object per evaluation is
expensive — must cache compiled functions per expression string.

**Option B — `with` statement + proxy object (not recommended):**
The `with` statement is deprecated and forbidden in strict mode.

**Option C — `new Function()` with a single scope object (recommended):**
```typescript
function evalExpr(expr: string, env: Environment): number {
    // Build scope object with all vars + fns
    const scope: Record<string, any> = {};
    for (const [k, v] of env.variables) scope[k] = v;
    for (const [k, v] of env.functions) scope[k] = v;
    // Destructure scope keys into function parameters
    const keys = Object.keys(scope);
    const fn = new Function(...keys, `return (${expr})`);
    return fn(...keys.map(k => scope[k]));
}
```

**Caching strategy:** Since expressions are evaluated repeatedly (every animation
frame), the compiled `Function` should be cached by expression string. The
scope parameter names rarely change (only when the environment is rebuilt), so
the cache key is `(exprString, sortedScopeKeyList)`.

**Init block handling:** Init blocks use the comma operator with assignments
(`cr=136, cr2=114, mainR=cr+18`). In JS, these are valid comma expressions
where each assignment mutates a variable. The wrapper must:
1. Declare all variables with `let`
2. Evaluate the expression
3. Write modified variables back to `env.variables`

The chained assignment pattern `hrColor=minColor=black` is valid JS and works
correctly.

### Part 3: Remove the custom parser code

**Files to delete:**
- [tokenizer.ts](../src/expr/tokenizer.ts) (262 lines)
- [parser.ts](../src/expr/parser.ts) (410 lines)
- [expr.test.ts](../src/expr/__tests__/expr.test.ts) — tokenizer and parser tests removed; evaluator tests simplified

**Files to update:**
- Build scripts — remove any expr-related generation steps
- [architecture-overview.md](../docs/architecture-overview.md) and other docs referencing `src/expr/`
- [development-rules.md](../docs/development-rules.md) §7 — bundle includes `src/expr/`
- [expressions.md](../docs/expressions.md) — rewrite to reflect new approach

---

## Pre-Requisite: ObsValue Migration

> Does this depend on switching Chronometer to the ObsValue system first?

**No, not strictly — but it would reduce churn.** The reasons:

1. Currently, `ASTNode` is used in two parallel systems:
   - **Chronometer's watch parts** (types.ts → xml-parser.ts → renderer.ts/animation.ts)
   - **ObsValue** (obs-value.ts → updater.ts, used by Observatory and Inspector)

2. If Chronometer switches to ObsValue first, then the Part types no longer
   store `ASTNode` — they store `ObsValue` references (or expression strings
   that ObsValue holds). The `ASTNode → string` change would be made in one
   place (ObsValue) rather than in both the Part types and ObsValue.

3. If we do the eval migration **before** the ObsValue switch, we touch types.ts
   and xml-parser.ts to change `ASTNode → string`, then touch them again during
   the ObsValue migration. Double churn, but manageable.

**Recommendation:** Do the ObsValue migration first. It's a larger architectural
improvement that the eval change naturally falls out of — once all expressions
are managed through ObsValue, changing the evaluation strategy is a single-point
change in `evalAttr()` and `createObsValue()`.

---

## Risks and Mitigations

### Risk: `new Function()` cache invalidation
If environments are rebuilt frequently (which they are — on location change,
body switch, etc.), the scope key list may change, invalidating cached Functions.
**Mitigation:** Cache by `(exprString, frozenKeyList)`. In practice the key list
is stable within a session — only the values change, not the names.

### Risk: CSP (Content Security Policy) restrictions
`eval()` and `new Function()` are blocked by strict CSP headers
(`script-src` without `'unsafe-eval'`). Since this is a static app served from
any web server, the deployer controls CSP. The app currently has no CSP
restrictions. **Mitigation:** Document that `'unsafe-eval'` is required if CSP
is applied, or use a CSP nonce.

### Risk: Numeric precision differences
The custom evaluator returns `1`/`0` for boolean comparisons; JS returns
`true`/`false`. When used in arithmetic (`a == b` appearing in `(a == b) * pi`),
JS coerces `true → 1`, `false → 0`, so the result is identical.

### Risk: Octal literals in future XML
If someone adds an expression with `0377`, JS strict mode rejects it.
**Mitigation:** Forbid strict mode in the eval wrapper (use sloppy mode), or
add a simple regex preprocessor to convert `0[0-7]+` to decimal. In practice
this is very unlikely to arise.

---

## Conclusion

All six assertions check out. Replacing the custom parser/evaluator with
`eval()` / `new Function()` is sound, reduces complexity (~1,600 lines of
parser code eliminated), saves memory, and has no security downside for this
fully-static client-side application.

The recommended sequencing is:
1. **First:** Migrate Chronometer to the ObsValue system (separate effort per [animation.md](../docs/animation.md))
2. **Then:** Replace expression representation and evaluation (this change)

This ordering minimizes double-churn on the Part types and concentrates the
expression change to a single code path.
