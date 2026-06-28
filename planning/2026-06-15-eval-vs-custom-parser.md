# Replacing the Custom Expression Parser with `eval()`

**Date:** 2026-06-15  
**Status:** ✅ **IMPLEMENTED 2026-06-28 as a simplification** (Step 0 gate had FAILED, so
this carried **no** performance benefit — it was done purely to delete the custom
front-end). The ~940-line tokenizer/parser/evaluator + `ASTNode` are gone; the JS engine
(`new Function`) is the only parser. Full suite **8504 green** (regression goldens, captured
from the old evaluator, all pass bit-identical). New code: `src/expr/compile.ts`
(`compileExpr`/`runInit`/`referencedNames`) + `src/expr/env.ts`. The real scrub-tick lever
remains the separate day/night wedge memoization in
[2026-06-28-daynight-wedge-memo.md](2026-06-28-daynight-wedge-memo.md).

> **Three bugs surfaced during implementation that this plan did NOT anticipate** (all fixed;
> each is now covered by a regression case):
> 1. **`referencedNames` "strip numbers first" is wrong** — it splits digit-bearing
>    identifiers like `hour24ValueAngle`. Replaced with a single identifier-first scan.
> 2. **Variable values are NOT static after init** — runtime toggles mutate them (Vienna
>    `dialFlip`/`noonOnTop`, Kyoto `kyMode`), so closures must read variables live, not snapshot.
> 3. **A name can be BOTH a variable and a function** (`calendarWeekdayStart`) — bare
>    identifier → variable, call `name()` → function, resolved by syntactic position.
> 4. **The env is rebuilt every step/scrub while ObsValues persist** — so `CompiledExpr` must
>    be **env-parameterized** (`evalFn(env)`), resolving against the env passed at call time,
>    exactly like the old `evalAttr(expr, env)`. (This was the subtle one — it only manifested
>    on the time-override paths, never on idle frames.)

> **What changed.** The plan originally opened with a performance hypothesis: profiling
> showed the AST evaluator is ~92–95% of the scrub tick, and a `new Function`-compiled
> closure was *expected* to erase that as interpreter/tree-walk overhead. Step 0
> measured it directly on both V8 and JSC (see **“Step 0 RESULTS”** under Assertion 6).
> **Result: the win does not exist.** The interpreter/tree-walk overhead is a fixed
> ~0.06–0.13 µs/eval regardless of expression — so the *maximum* the migration can
> reclaim is ≈0.1 µs × 1563 evals ≈ **0.16 ms of a ~20 ms tick (<1%)**, and that ceiling
> holds however effective the astronomy cache is, because the cost is the env-function
> *body* (real astronomy), which compilation does not touch. The profiling section's
> premise that the 26 µs/eval was "interpreter machinery, not the work inside the env
> functions" is **disproven**: direct measurement shows the body *is* the cost (a Moon
> day/night wedge is ~158 µs of root-finding). Read the "Profiling evidence" and
> "Assertion 4" sections below with this correction in mind — they are retained for the
> record but their perf conclusions are superseded by Step 0 RESULTS.

**Remaining rationale (if pursued at all): pure simplification.** Deleting ~940 lines
of bespoke tokenizer/parser/evaluator so the only parser in the codebase is the JS
engine's, plus modest memory savings and no security/`file://` regression (all still
valid). Whether that is worth the multi-file threading + correctness risk is a
standalone call — there is **no** performance argument for it.

---

## Implementation summary (start here)

> Single entry point for a fresh session. **Read the Status block above first: the perf
> justification is dead; this is simplification-only and unscheduled.** The authoritative
> design (if it proceeds) is **Assertion 6** plus the revised **init** and **Part 3**
> sections; Assertions 1–5 are supporting analysis. This whole migration is
> `file://`-safe and CSP-safe (verified; see the CSP risk section).

**Goal.** Delete the entire custom expression front-end (`tokenizer.ts` + `parser.ts`
+ `evaluator.ts` + the `ASTNode` type, ~940 lines) and let the JS engine parse and
run expressions. The only non-JS "parsing" that remains is one ~5-line identifier
regex (`referencedNames`).

**Ordered checklist:**

0. **Step 0 — benchmark gate. DONE 2026-06-28 → FAILED.** Compared a `new Function`
   closure vs. the current tree-walk on real hot expressions, V8 + JSC. Compiled was
   **not** materially faster on the dominant expressions (~1.0× on the day/night
   wedges). The perf rationale is gone; steps 1–5 below are simplification-only and
   should only be undertaken if that simplification is judged worth it on its own.
   (Assertion 6 → Step 0 RESULTS.)
1. **Add `src/expr/compile.ts`** with three exports, plus a home for the still-needed
   `Environment` / `ExprFunction` / `createDefaultEnvironment` (move them here or to
   `expr/env.ts`):
   - `referencedNames(src)` — identifiers minus JS reserved words, numeric-literal-
     safe (strip-numbers-first; **no** lookbehind — old-Safari). The two traps
     (`true`/`false`; hex/sci literals) are confirmed live in the XML.
   - `compileExpr(src, env): CompiledExpr` — bind only referenced names, captured
     once (function refs live, variable values snapshotted).
   - `runInit(src, vars, fns)` — parser-free init: assign-and-merge into the variable
     store. No write-back protocol, no retained evaluator.
2. **Land the regression corpus test BEFORE deleting anything** — assert `compileExpr`
   is bit-identical to the old evaluator across real XML expressions (include a
   hex-heavy and a scientific-notation case), and that `runInit` reproduces the old
   `initExprs` bindings. This is the safety net for the steps below.
3. **Wire the two compiled populations** (Assertion 6 → Part 1):
   - **ObsValue hot path:** add `ObsValue.evalFn: CompiledExpr` (compile in
     `createObsValue`); replace the ~8 `evalAttr(v.expr, env)` sites in `updater.ts`
     with `v.evalFn()`.
   - **Render pass:** make `evalAttr`/`evalColor` compile-and-memo, keyed
     **per-`env`** (`WeakMap<Environment, Map<string, CompiledExpr>>`) — not a global
     string map (16 envs coexist on `all.html`). Call sites unchanged.
4. **Thread `ASTNode → string`** (Assertion 6 → Part 2): `types.ts` (~80 fields +
   `initExprs: string[]`), `xml-parser.ts` (`attrExpr` returns raw string), `terminator.ts`
   (`phaseExpr`/`rotationExpr` → string), `obs-value.ts` (drop `createObsValueFromAST`),
   and **hand-values.ts synthetic ASTs → parenthesized string composition**. Point
   `watch-env.ts`’s init loop at `runInit`.
5. **Delete** `tokenizer.ts`, `parser.ts`, `evaluator.ts`, `ASTNode`; rewrite the
   expr tests; update `architecture-overview.md`, `development-rules.md` §7,
   `expressions.md`.

**Highest-risk spots to watch** (each is a confirmed gotcha, detailed inline): the
`referencedNames` traps (step 1); the per-env render cache (step 3); precedence when
composing `terminatorLeafAngle(...)` strings — wrap embedded sub-exprs in parens
(step 4).

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

## Profiling evidence (2026-06-28): the AST evaluator IS the scrub bottleneck

A perf investigation (originally chasing scrub frame rate; it considered and
**shelved** a worker-threaded astronomy offload — branch `worker-eval-ahead`)
pinned the cost precisely. **The custom AST evaluator (`evalAttr` →
`evaluate()`) dominates scrub-time CPU.** This is the strongest motivation for this
migration and supersedes Assertion 4's "wash / slight win" estimate.

**Workload:** `all.html` (every face in a grid — the heaviest case), scrubbing
1 day/tick. **1563 obsValues across 16 built faces (~98/face)**, the bulk being
day/night-ring wedges (~96 obsValues per ring), each re-evaluating its expression
every scrub tick.

**Tick attribution (avg per scrub frame, `?tickprofile`):**

| Engine | update pass | **eval** | boundary | interp | rest | 2nd-interp pass | per-eval |
|---|---|---|---|---|---|---|---|
| Chrome / V8 | 22.5ms | **20.4ms (≈92%)** | 1.1ms | 0.17ms | 0.7ms | 0.02ms | 26.2µs |
| Safari / JSC | 28.5ms | **27.0ms (≈95%)** | 0.9ms | 0.16ms | 0.4ms | 0.00ms | 26.6µs |

Corroborating facts:
- **Window-independent.** The tick is flat across an 88px↔224px canvas (6.5× pixel
  area) → the cost is per-part computation, **not pixels/rendering**. (Render —
  draw-command issuance — is a separate ~13ms and also part-count-bound; the large
  pixel-dependent number is GPU rasterization, which is fast on real hardware but
  slow under the headless software renderer used for some of these measurements.)
- **Not interpolation / not the on-beat machinery.** Interpolation ≈0.17ms, the
  second interpolation pass ≈0.02ms (sitting values no-op it), `computeNextBoundary`
  ≈1ms — all negligible vs eval.
- **Not astronomy.** The shelved worker experiment offloaded *all* astronomy to a
  thread and cut the tick by only ~1ms — the `AstroCachePool` already minimizes it.
  So the ~26µs/eval is the interpreter machinery (tree-walk + variable/function
  `Map` lookups + per-call dispatch over ~1563 values/tick), not the work inside the
  env functions.
- **Browser spread is interpreter-shaped.** The per-eval cost is ~26µs on both
  engines; differences in *total* scrub cost across browsers track JS-interpreter
  behavior, consistent with "this is the AST walker," not arithmetic or GPU.

**Implication for this plan (a hypothesis, not a proven result):** compiling each
expression once to a closure (`new Function`) and calling it directly *should*
collapse the ~26µs/eval to low single-digit µs, i.e. cut the dominant ~20–27ms tick
by most of itself. This is the motivating bet, but two caveats keep it from being a
sure thing — both must be measured, not assumed:

1. **Residual function-body work.** A portion of the 26µs is the env-function
   bodies invoked by each eval (e.g. the day/night wedge functions), which
   compilation does **not** remove. If that residual is large, the win shrinks and
   the next target becomes the function bodies or the sheer ~1563-evals/tick count
   (e.g. the wedges).
2. **Per-call binding overhead.** A naïve `new Function(...allKeys, body)` that
   spreads the full ~100-entry environment on every call can *replace* tree-walk
   cost with argument-marshalling cost. The design in Assertion 6 avoids this by
   binding only the few names an expression references, captured once per value —
   but this is exactly why the design matters and why Step 0 measures a realistic
   binding, not a toy `new Function('return 1+1')`.

**Two eval populations, not one.** Profiling pinned the *update* (tick) pass, which
is ObsValue eval. But there is a second, separate population: the **render pass**
re-evaluates ~200 *static* part attributes per frame via `evalAttr`/`evalColor`
in [renderer.ts](../src/watch/renderer.ts) (radius, colors, lengths, widths). Those
are tree-walks too and are part of the ~13ms render cost. Any “delete the
evaluator” plan must give *both* populations a compiled path; see Assertion 6.

**Reproduce / measure (instrumentation landed on `main`):**
- `[scrub-perf]` console summary (always on) reports the **tick vs render split** and
  `Ticked: <N> obsValues across <M> faces · canvas <px>`.
- **`?tickprofile`** adds the per-value attribution above (eval/boundary/interp/rest
  + µs/eval). It is **off by default** because the per-value `performance.now()`
  calls tax the very hot path being measured. Scrub a heavy face (e.g. all.html,
  hold `1d ▶`) and read the line printed on scrub end.

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

**Verdict: ⚠️ Plausibly a large win, but unproven — do not treat as a sure thing.**
The original "wash or slight win" estimate understated the *opportunity*: profiling
shows the AST evaluator is ~92–95% of the scrub tick (see *“Profiling evidence”*
above), so the evaluator is unambiguously where the time goes. What profiling does
**not** establish is that a `new Function` closure will be faster *at the same
work* — that depends on how much of the per-eval cost is interpreter/tree-walk
overhead (which a JIT erases) versus env-function-body work and per-call binding
(which it does not). The honest position: strong prior that compilation helps,
no measurement yet. Step 0 (Assertion 6) settles it before the full migration.

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

**Verdict: ⚠️ The original three-part decomposition is directionally right but
under-specified for the post-ObsValue codebase.** Rewritten below to be
implementation-ready: it names the real call sites, specifies the compiled-closure
design (the crux — getting this wrong forfeits the win), and adds the two pieces
the original omitted (render-pass attribute evals; synthetic-AST construction in
hand-values/terminator).

### Step 0 (do this first): a benchmark spike to de-risk the win

Before touching the codebase, confirm the hypothesis from Assertion 4 on a
*representative* expression and a *realistic binding*. Pick a real hot expression
(e.g. a day/night wedge `dayNightLeafAngle(planet, i, n)` and a hand angle like
`hour24ValueAngle()`), and compare, over ~1e6 iterations:

1. current tree-walk `evaluate(ast, env)`;
2. a `new Function`-compiled closure bound the way Part 2 proposes (only referenced
   names captured once), calling the *same* env functions.

Measure per-eval µs on both V8 and JSC. **Decision gate:** proceed only if (2) is
materially faster than (1) on the expressions that dominate the tick. If the win is
small, the residual is function-body work (Profiling caveat #1) and the right next
move is optimizing the wedge/astronomy functions or cutting the ~1563-evals/tick
count — *not* this migration. Keep the spike script in `planning/`.

#### Step 0 RESULTS (2026-06-28) — the performance gate FAILS; caveat #1 was the reality

Ran the spike (`planning/step0-bench.ts`, bundle with esbuild, run on `node` = V8 and
the JSC `Helpers/jsc`). Per-eval µs, tree-walk → compiled, against a real
`createAstroEnvironment`:

| Scenario | V8 tree→comp (speedup, **abs. save**) | JSC tree→comp (speedup, **abs. save**) |
|---|---|---|
| `r*cos(th*pi/180)` (arith control, no env fn) | 0.133→0.025 (5.4×, **0.108µs**) | 0.110→0.032 (3.5×, **0.078µs**) |
| `hour24ValueAngle()` (cheap hand angle) | 0.147→0.112 (1.31×, **0.035µs**) | 0.109→0.100 (1.09×, **0.009µs**) |
| `dayNightLeafAngle(0,5,24)` single (cold) | 10.26→10.29 (1.00×) | 6.12→5.99 (1.02×, **0.13µs**) |
| **ring scrub, Sun N=24 (cache active)** | 9.50→9.43 (1.01×, **0.07µs**) | 5.55→5.49 (1.01×, **0.06µs**) |
| **ring scrub, Moon N=24 (cache active)** | 158.1→157.5 (1.00×, **0.6µs**) | 67.9→67.8 (1.00×, **0.06µs**) |
| ring scrub, Sun/Moon N=96 (cache active) | 9.7→9.6 / 154.9→155.6 (≈1.0×) | 5.4→5.4 / 67.1→67.2 (≈1.0×) |

**The "realistic ring scrub" rows model the real app**: advance the clock once per
tick, then evaluate a whole ring of wedges (varying leaf index, same planet/day) so
the `AstroCachePool` is warm across the ring — exactly the scenario where "all wedges
make the same astronomy calls." It does **not** rescue the win: a Sun wedge stays
~9.4µs (V8) / ~5.5µs (JSC), a Moon wedge ~155µs / ~67µs, and compiling saves ~0%.

**Why the gate fails, cache-independently.** The interpreter/tree-walk overhead is a
*fixed* ~0.06–0.13µs/eval added on top of the function body, no matter how big the
body is (the "abs. save" column is ~0.1µs everywhere). The arith control's "5.4×" is
5× of a tiny number — the same ~0.1µs absolute. So the **maximum** the migration can
reclaim is ≈0.1µs × 1563 evals ≈ **0.16ms out of the ~20ms tick (<1%)** — and that
ceiling holds however effective the cache is, because the body cost is what
compilation does *not* touch. The profiling section's premise that the 26µs/eval was
"interpreter machinery, not the work inside the env functions" is **disproven**:
direct measurement shows the body *is* the cost (Sun wedge ~9µs, Moon ~155µs of real
astronomy). The right perf lever is the wedge/astronomy bodies or the eval count,
**not** this migration. **Conclusion: do not pursue this migration as a performance
play.** (It may still be worth doing purely as a ~940-line simplification — a
separate decision.)

### The core design: compile once per value, bind only referenced names

The naïve `new Function(...allKeys, body)` (old Options A/C) is wrong for the hot
path: spreading the full ~100-entry environment on every call trades tree-walk cost
for argument-marshalling cost. Instead:

```typescript
// expr/compile.ts (new) — replaces evaluator.ts for the hot path.
export type CompiledExpr = () => number;

export function compileExpr(src: string, env: Environment): CompiledExpr {
    // 1. Identifiers the expression references (see referencedNames below).
    const names = referencedNames(src).filter(n => env.variables.has(n) || env.functions.has(n));
    // 2. Capture the bindings ONCE: function refs are live (they read getNow
    //    internally); variable values are snapshotted (see invariant below).
    const values = names.map(n => env.functions.get(n) ?? env.variables.get(n));
    // 3. Compile once; the closure spreads only the few referenced values.
    const fn = new Function(...names, `return (${src});`) as (...a: unknown[]) => number;
    return () => fn(...values);
}
```

**`referencedNames` — the one helper, fully specified (two non-obvious traps).**
Both `compileExpr` and `runInit` depend on it; it is the *only* non-JS "parsing"
left. Naïve `/[A-Za-z_$][\w$]*/g` has two bugs that **will** crash or corrupt the
build, so spell it out:

```typescript
// Identifiers, minus (a) JS reserved words and (b) false matches inside numeric
// literals. Both traps are confirmed live in the real XML (see notes).
const JS_RESERVED = new Set([
    'true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'in', 'of', 'new',
    'typeof', 'void', 'delete', 'instanceof', 'this', 'function', 'return', 'if',
    'else', 'var', 'let', 'const', 'do', 'while', 'for', 'class', 'with',
    // (extend to the full reserved list to be safe against future XML)
]);
export function referencedNames(src: string): string[] {
    // CORRECTED 2026-06-28 (Step 0): the "strip numbers first" approach below is
    // BUGGY — `/\d*\.?\d+/g` matches the `24` inside identifiers like
    // `hour24ValueAngle` / `hour24Number`, splitting them into bogus pieces, so the
    // real name never gets bound and the closure throws ReferenceError. Instead do a
    // SINGLE left-to-right scan with the identifier alternative listed FIRST: the
    // scanner consumes `hour24ValueAngle` whole (the `[\w$]*` tail swallows digits),
    // and the number alternatives only win where a literal starts at a position an
    // identifier cannot (`0xff00c0ac`, `1e10`). Lookbehind-free (old-Safari safe)
    // AND digit-in-identifier safe. (Verified in the Step 0 spike.)
    const toks = src.match(
        /[A-Za-z_$][\w$]*|0[xX][0-9a-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?/g,
    ) ?? [];
    const ids = toks.filter(t => /^[A-Za-z_$]/.test(t));
    return [...new Set(ids)].filter(n => !JS_RESERVED.has(n));
}
```

- **Trap (a) — `true`/`false` are illegal `new Function` parameter names.** At least
  one XML expression references `true`, and `createDefaultEnvironment` even binds
  `true→1`, `false→0`. Passing `'true'` to `new Function` throws `SyntaxError`. The
  fix is to **drop them from `names` and rely on JS's native `true`/`false`**, which
  coerce to `1`/`0` in every arithmetic/comparison context — bit-identical to the old
  evaluator (`2 == true` → `2 == 1` → `0` in both). Those two env bindings become
  dead and can be removed from `createDefaultEnvironment`.
- **Trap (b) — hex/scientific literals.** `0xff00c0ac` and `1e10` appear throughout
  (133 hex literals in init blocks alone). The lookbehind above is mandatory; the
  regression corpus test must include a hex-heavy and a scientific-notation
  expression.

**Why capturing values once is correct (the load-bearing invariant).** Per-frame
change in this system flows in through **env functions** (they call the overridable
`getNow()` internally), whose references are stable — so capturing the *function
ref* once and letting it read live time is exactly right, and it is also why
**eval-ahead still works unchanged**: `withDisplayTime(ms, fn)` mutates the `getNow`
closure the captured functions read; compiled-vs-tree-walk is irrelevant to it.
**Variables**, by contrast, are written only by init blocks at face-load time and
are static thereafter; nothing mutates `env.variables` per frame. The one rule the
implementation must honor: **recompile whenever the environment is rebuilt** (body
switch, location change). That already happens — `buildHandValues` re-runs and
reconstructs every `ObsValue` — so compilation belongs in `createObsValue` /
`createObsValueFromAST`, naturally inheriting the existing rebuild lifecycle.

### Part 1: Two compiled populations

**1a. ObsValue expressions (the profiled tick hot path).** Store the compiled
closure on the value and call it instead of `evalAttr(v.expr, env)`:
- [obs-value.ts](../src/shared/obs-value.ts) — `ObsValue.expr: ASTNode` → keep the
  source `string` (for debugging) **plus** add `evalFn: CompiledExpr` (do *not* name
  the field `eval` — it shadows the global and trips linters/strict mode).
  `createObsValue` compiles from its string; `createObsValueFromAST` is replaced (see
  Part 2) — Parts now hand over strings, so there is no longer a pre-parsed AST to
  accept. The construction-time initial-value eval (`evalAttr(expr, env)` at
  `obs-value.ts:184`) becomes `v.evalFn()`.
- [updater.ts](../src/shared/updater.ts) — replace every `evalAttr(v.expr, env)`
  (≈8 sites: `onArrivalOnBeat`, `updateObsValueScrub`, `updateObsValueEvalAhead`,
  `updateObsValueDiscrete`, `settleAtNow`, `snapToTargetAtBoundary`,
  `updateNaturalSpeedValue`, `updateObsValueFixedDuration`, `onBeatStep`,
  `Updater.finish`) with `v.evalFn()`. This is the change that should move the tick.

**1b. Render-pass static attributes (the second population — originally omitted).**
[renderer.ts](../src/watch/renderer.ts) calls `evalAttr`/`evalColor` ~200× per
frame on Part attributes (`part.radius`, `part.fillColor`, …). Give these a compiled
path too, but the cache **must be per-`env`, not a single module-level
`Map<string, …>`** — that is the one subtle correctness trap here:
- **Why per-env.** `createDefaultEnvironment()` runs fresh per watch
  (`watch-env.ts:168`), so `all.html` holds **16 distinct envs at once**, and the same
  source string means different things in each (`r*cos(th*pi/180)` — `r`/`th` are
  set by *each face's* init block). A string-keyed global cache would hand face B a
  closure bound to face A's variable snapshot. Key by env identity:
  `const cache = new WeakMap<Environment, Map<string, CompiledExpr>>();` (or hang the
  inner `Map` off the `Environment` object). `WeakMap` also lets a face's cache be
  GC'd when its env is discarded on body/location change.
- `evalAttr(expr, env)` / `evalColor(expr, env)` in
  [astro-env.ts](../src/shared/astro-env.ts) keep their call signatures but, with
  `expr` now a `string`, look up `cache.get(env)?.get(src)` (compiling + storing on
  miss) and call it. The ~200 call sites in renderer.ts and ~13 in terminator.ts are
  then **unchanged at the call site** — only the helper's implementation changes.

### Part 2: Representation change `ASTNode → string` (the threading work)

This is *not* a single-point change (see the corrected note under the old
prerequisite). Touch-points:
- [types.ts](../src/watch/types.ts) — ~80 `ASTNode` optional fields → `string`;
  `Watch.initExprs: ASTNode[]` → `string[]`.
- [xml-parser.ts](../src/watch/xml-parser.ts) — `attrExpr()` returns the raw
  `string | undefined` (drops the `parse()` call); `<init>` handling stores the raw
  expression string instead of `parse(exprStr)`.
- [hand-values.ts](../src/watch/hand-values.ts) — **synthetic-AST construction must
  become string composition.** The `lit()` helper and the hand-built `FunctionCall`
  node for `terminatorLeafAngle(...)` (in `buildTerminatorValues`) become template
  strings, e.g.
  `` `terminatorLeafAngle((${leaf.phaseExpr ?? '0'}), ${quad}, ${idx}, ${lpq}, ${incr})` ``.
  **Wrap embedded sub-expressions in parens** (`(${phaseExpr})`) to preserve
  precedence. `createObsValueFromAST` call sites switch to `createObsValue` (string).
- [terminator.ts](../src/watch/terminator.ts) — `phaseExpr`/`rotationExpr` fields
  `ASTNode → string`; its ~13 `evaluate(node, env)` calls become
  `evalAttr(str, env)` (or `compileExpr(str, env)()` for one-shots).
- [obs-value.ts](../src/shared/obs-value.ts) — drop the `ObsValueDefAST` variant and
  `createObsValueFromAST`; everything constructs from strings now.

**Init blocks are parser-free too — `runInit` (this is what lets us delete the whole
parser).** Init blocks (`cr=136, cr2=114, mainR=cr+18`, chained
`hrColor=minColor=black`) assign variables, so they cannot use the read-only
`compileExpr` above. They do **not**, however, need a retained evaluator. The
enabling facts:

- **All assignments in the entire XML corpus live inside `<init>` blocks** (verified
  2026-06-28: 208 init blocks; zero assignments — single, chained, or compound — in
  any runtime attribute expression). So the *runtime* path is purely read-only and
  the assignment problem is confined to init.
- **Init's only job is to populate the variable namespace.** There is one writer
  (init) and one store (`env.variables`) that runtime reads from — so there is no
  "write back to a throwaway scope" step to engineer; init writes the store directly.
- **Init expressions are semantically trivial** — `name = <arithmetic>` over
  `+ - * /`, unary minus, `cos`/`sin`, hex/decimal literals, parens, comma. No
  ternary, comparison, logical, bitwise, or compound assignment appears. `new
  Function` evaluates all of it natively.

The implementation reuses the *same* `referencedNames(src)` helper the runtime path
already needs — the only non-JS "parsing" left anywhere (a ~3-line identifier
regex, not a grammar):

```typescript
// expr/compile.ts — alongside compileExpr; ExprFunction is the existing env fn type.
function runInit(src: string, vars: Map<string, number>, fns: Map<string, ExprFunction>): void {
    const names = referencedNames(src);                       // same helper; keywords excluded
    const args  = names.map(n => fns.get(n) ?? vars.get(n));  // funcs + existing vars in
    const body  = `${src};\nreturn {${names.join(',')}};`;    // hand every name back out
    const out   = new Function(...names, body)(...args) as Record<string, number>;
    for (const n of names) if (!fns.has(n)) vars.set(n, out[n]);  // merge results into store
}
```

Every assignment target appears as an identifier, so it is in `names`, so it is a
mutable parameter, so its final value returns in `out` and lands in `vars`.
`cos`/`pi`/`black` flow in as args and are skipped on write-out (`!fns.has` and
unchanged value). Chained assignment and comma sequences are just JS. No LHS-only
scan, no `let` redeclaration, no `with`. [watch-env.ts](../src/watch/watch-env.ts)’s
init loop calls `runInit(expr, env.variables, env.functions)` per block, in document
order, exactly as today.

*(A `with(scopeProxy)` variant — `new Function('S', \`with(S){ ${src} }\`)` over a
`has:()=>true` Proxy — also works and reads like "evaluate init in this scope," but
it is not recommended: `with` would deopt a hot function (fine here, since init is
once-per-load, but a footgun if copied to the runtime path) and the regex version
above needs no deprecated construct. Mentioned only so the option is on record.)*

**Sloppy-mode / octal note.** `new Function` bodies are **non-strict** unless they
begin with `'use strict'`. We will *not* add that directive, so the theoretical
`0377` octal literal (Assertion 1 — zero occurrences in any XML) would still
evaluate, and `with`-free codegen keeps us clear of the strict-mode traps. No action
needed; just don’t opt into strict mode in the wrapper.

**Inspector error parity.** [inspector-entry.ts](../src/inspector/inspector-entry.ts)
wraps `createObsValue(...)` in `try/catch` and shows `e.message`. With `new Function`,
a malformed expression throws `SyntaxError` at *compile* time (inside
`createObsValue`) and an unknown identifier throws `ReferenceError` at the *first*
eval — which also happens inside `createObsValue` (it evaluates the initial value).
So the existing try/catch still catches both; only the message text changes (e.g.
“Unexpected token” instead of the custom parser’s wording). Acceptable; note it in
the Inspector’s help text if the current copy quotes the old messages.

### Part 3: Remove the custom parser code — *all of it*

Because init is parser-free (`runInit` above), **the entire custom expression
front-end is deleted with no vestige retained.** A "tiny evaluator for init" was
considered and rejected: init RHS is full arithmetic, so retaining it would drag in
essentially all of `tokenizer.ts` (~262 lines) plus the `parseExpression →
parseAssignment → parseAdditive → … → parsePrimary` spine of `parser.ts` (~300 of
410 lines) and most of `evaluator.ts` — ~550–600 of the ~940 lines, *and* a
developer would still have to understand a bespoke grammar. That defeats the point;
the whole value of this migration is that the only parser in the codebase becomes
the JS engine's.

**Files to delete (unconditional):**
- [tokenizer.ts](../src/expr/tokenizer.ts) (262 lines) — replaced by the
  `referencedNames` identifier regex.
- [parser.ts](../src/expr/parser.ts) (410 lines) — the `ASTNode` type and all
  recursive-descent parsing go; `new Function` parses instead.
- [evaluator.ts](../src/expr/evaluator.ts) (266 lines) — the tree-walker goes;
  `compileExpr`/`runInit` (the new `expr/compile.ts`) replace it. Keep
  `createDefaultEnvironment` and the `Environment`/`ExprFunction` types by moving
  them into `compile.ts` (or a small `expr/env.ts`) — they are still needed.
- [expr.test.ts](../src/expr/__tests__/expr.test.ts) — tokenizer/parser tests
  removed; **add** a focused test that `compileExpr` returns bit-identical results to
  the old evaluator on a corpus of real XML expressions, and that `runInit`
  reproduces the old `initExprs` variable bindings (the regression guard for this
  migration — land it *before* deleting anything, so the old and new paths can be
  diffed against each other).

Confirmed no other consumer pins the parser in place: the remaining `parse()` /
`evaluate()` callers are exactly the sites this migration rewrites (obs-value
construction, `evalAttr`/`evalColor`, terminator's 13 evals, watch-env init, the
synthetic ASTs in hand-values). The lone `parse(` in
[ring-view.ts](../src/observatory/ring-view.ts) is a same-named *local* color-string
helper, not the expression parser.

**Files to update:**
- Build scripts — remove any expr-related steps (none today; `build.sh` bundles
  `src/` wholesale, so deletions just shrink the bundle).
- [architecture-overview.md](../docs/architecture-overview.md), 
  [development-rules.md](../docs/development-rules.md) §7,
  [expressions.md](../docs/expressions.md) — update to the compiled-closure model.

---

## ~~Pre-Requisite: ObsValue Migration~~ — DONE (2026-06-28)

> Earlier draft asked: does this depend on switching Chronometer to the ObsValue
> system first?

**The ObsValue migration is complete, so this is no longer a prerequisite of any
kind.** Chronometer's dynamic parts now build per-face `Updater`s of `ObsValue`s
([hand-values.ts](../src/watch/hand-values.ts)), and the hot scrub-tick eval is
`evalAttr(v.expr, env)` driven from [updater.ts](../src/shared/updater.ts).

**But note an important correction to the old reasoning:** the migration did **not**
collapse `ASTNode → string` to a single point. Reality, as built:

- `ObsValue.expr` is still an `ASTNode` (`obs-value.ts` L41); `createObsValue`
  *parses* a string, `createObsValueFromAST` takes a pre-parsed node.
- Watch **Part types still store `ASTNode`** (`types.ts` — ~80 fields), and
  `hand-values.ts` feeds those nodes straight into `createObsValueFromAST`.
- `hand-values.ts` and [terminator.ts](../src/watch/terminator.ts) also **synthesize
  AST nodes programmatically** (the `lit()` helper, hand-built `FunctionCall` nodes
  for `terminatorLeafAngle(...)`), and `watch.initExprs` is `ASTNode[]`.

So the `ASTNode → string` change still threads through Part types, the XML parser,
hand-values, terminator, and ObsValue — it is *not* a one-line swap. That changes
nothing about feasibility, but it does mean the implementation plan (Assertion 6,
rewritten below) must enumerate those touch-points explicitly. The migration having
landed is a *help* (the eval call sites are now concentrated in `updater.ts` +
`renderer.ts`), not the single choke point the old prerequisite imagined.

---

## Risks and Mitigations

### Risk: `new Function()` cache invalidation
If environments are rebuilt frequently (which they are — on location change,
body switch, etc.), the scope key list may change, invalidating cached Functions.
**Mitigation:** Cache by `(exprString, frozenKeyList)`. In practice the key list
is stable within a session — only the values change, not the names.

### Risk: CSP (Content Security Policy) restrictions
`eval()` and `new Function()` are blocked by strict CSP (`script-src` without
`'unsafe-eval'`). Status in this app, verified 2026-06-28:

- **No CSP anywhere today.** There is no `Content-Security-Policy` `<meta>` tag in
  any source HTML (`grep -ri content-security-policy src/**/*.html` → no matches),
  and the app ships no server, so no response headers either. `new Function` is
  unrestricted.
- **`file://` is fine — this is the important confirmation.** `file://` URLs carry
  *no HTTP response headers*, so a header-based CSP cannot exist there. The only way
  to get a CSP on `file://` is a `<meta http-equiv>` tag, which we do not ship. And
  `new Function`/`eval` are pure language features (no network), so they execute
  identically under `file://` — there is no `file://`-specific restriction on them.
  (Contrast `fetch()` of local files, which *is* CORS-blocked on `file://`; the
  build already sidesteps that by inlining XML via esbuild and using IIFE bundles,
  not ES modules — see below. This migration adds no new network or module
  dependency, so it does not regress `file://` support.)
- **Future-proofing.** If a deployer ever adds a CSP, `'unsafe-eval'` (or a nonce)
  would be required. **Mitigation:** note this in [build-system.md](../docs/build-system.md)
  alongside the existing `file://` deployment notes.

**`file://` sign-off for the rest of the plan.** Nothing else proposed here touches
the loader, network, or module system. Bundles remain `--format=iife` classic
scripts (`<script src>`), expression strings are already inlined from the XML at
build time, and compilation happens in-process. So the whole plan — not just the
CSP point — is `file://`-safe.

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

**The performance case is dead (Step 0, 2026-06-28).** The migration is still **sound,
safe, and `file://`-compatible** — syntax compatibility, security, memory, and
complexity all check out, and the ObsValue migration (the former prerequisite) has
landed, so the eval call sites are concentrated in `updater.ts` and `renderer.ts`. But
the headline justification — reclaiming the scrub tick — **was measured and does not
hold.** A `new Function` closure is ~1.0× the tree-walk on the dominant day/night
wedges (the interpreter overhead is a fixed ~0.1 µs/eval, <1% of the tick, and the
cache cannot change that because the cost is the astronomy *body*). The real scrub
lever is elsewhere: per-wedge rise/set memoization, tracked in
[2026-06-28-daynight-wedge-memo.md](2026-06-28-daynight-wedge-memo.md).

**So this migration is now optional and simplification-only.** It is worth doing only
if deleting ~940 lines of bespoke parser/evaluator (leaving the JS engine as the only
parser) is judged worth the multi-file `ASTNode → string` threading and its correctness
risk — there is **no** performance reason to do it. It is **not currently scheduled.**

If it is later undertaken as a cleanup, the sequencing (the ObsValue migration is done;
ignore the old ordering; **skip Step 0 — already done and failed**):
1. **Build the compiled path** (`expr/compile.ts`: `compileExpr` + `runInit`, sharing
   one **corrected** `referencedNames` regex — see the fix in Assertion 6, step 1)
   behind a regression test that asserts bit-identical results to the old evaluator
   across a corpus of real XML expressions — covering the per-value `CompiledExpr`
   (ObsValue path), the memoized `evalAttr`/`evalColor` (render pass), **and** `runInit`
   reproducing the old `initExprs` variable bindings.
2. **Thread `ASTNode → string`** through Part types, xml-parser, hand-values
   (synthetic-AST → string composition), terminator, obs-value, and watch-env's init
   loop. Init needs no parser — it uses `runInit`.
3. **Delete the entire custom front-end** — `tokenizer.ts`, `parser.ts`,
   `evaluator.ts`, `ASTNode` (no vestige retained) — and update docs.

Net effect if shipped: the **whole ~940-line custom tokenizer/parser/evaluator is gone**
(the only parser left is the JS engine's), modest memory savings, no security or
`file://` regression — and **no measurable scrub-tick change** (Step 0).
