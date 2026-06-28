# Expressions

The expression system evaluates the C-like arithmetic expressions embedded in watch-face XML attributes (e.g., `hour24Number() >= 12 ? 0 : pi`). Expression strings are valid JavaScript, so the JS engine itself parses and runs them — there is no custom tokenizer/parser/evaluator. (For the analysis behind this decision, see `planning/2026-06-15-eval-vs-custom-parser.md`.)

## Expression Language

The language supports:
- **Arithmetic**: `+`, `-`, `*`, `/`, `%`
- **Comparisons**: `<`, `>`, `<=`, `>=`, `==`, `!=`
- **Logical**: `&&`, `||`, `!`
- **Bitwise**: `&`, `|`, `^`, `~`, `<<`, `>>`
- **Ternary**: `cond ? trueExpr : falseExpr`
- **Function calls**: `sin(x)`, `hour24Number()`, `sunRA()`
- **Variables**: `pi`, `mainR`, user-defined via init blocks
- **Assignment chains**: `cr=136, cr2=114, mainR=cr+18` (in init blocks only)
- **Constants**: numeric literals (decimal, hex `0x…`, scientific `1e10`), `pi`

Examples from watch XML:
```
hour24Number() >= 12 ? 0 : pi
r*cos(th*pi/180)
DSTNumber() ? pi*7/4 : pi/4
terminatorAngle(moonAgeAngle(), 0, 3, 6, 0)
```

Because every construct above is also valid JavaScript, the expressions run unchanged. Two semantic notes: comparison/logical/`!` results are JS booleans, which the compiler coerces to `1`/`0` (a leading unary `+`) so arithmetic matches the original C semantics; and `==`/`!=` compare numbers, so no type-coercion surprises arise.

## Compilation: `new Function`

### `compileExpr` (`src/expr/compile.ts`)

`compileExpr(src)` returns a `CompiledExpr` — a closure compiled once via `new Function`. It is **env-parameterized**: `compiled(env)` resolves each referenced identifier from the env passed *at call time* (not a captured one). This matters because the environment is rebuilt on every step/scrub (fresh timezone/time/init bindings) while the `ObsValue`s that hold the compiled closures persist — the closure must read whichever env is current, exactly as the old `evalAttr(expr, env)` did.

Resolution mirrors the original evaluator: a call `name(...)` binds the env **function**, a bare identifier binds the env **variable** (so a name registered as both — e.g. `calendarWeekdayStart` — is disambiguated by syntactic position). The only non-JS "parsing" left anywhere is `referencedNames(src)`, a small identifier regex (digit-in-identifier safe and lookbehind-free for old Safari).

### `runInit` (`src/expr/compile.ts`)

`<init>` blocks contain assignments, so they use `runInit(src, vars, fns)` instead: it runs the block via `new Function` and merges the resulting variable bindings directly into the store. No retained evaluator, no AST.

### Environment (`src/expr/env.ts`)

`createDefaultEnvironment()` provides the base scope both paths evaluate against:
- **Variables**: `pi`, color constants, planet constants (`Sun`, `Moon`, …), plus all init-block-defined variables.
- **Functions**: `sin`, `cos`, `hour24Number`, `sunRA`, `moonAgeAngle`, `dayNightLeafAngleIsRiseSet`, etc.

## Representation: expression strings

Expression-valued attributes are stored as **raw source strings** in the part model (not pre-parsed). Compilation happens when the `ObsValue` for a dynamic attribute is constructed, and is memoized per source string for the render-pass `evalAttr`/`evalColor` helpers.

### Type system

In `src/watch/types.ts`, attributes that contain expressions are typed `string`:
- Non-expression textual attributes (`name`, `type`, `text`, `fontName`, `marks`, `src`, `modes`, `action`) — plain strings as before.
- Mathematical properties (`x`, `y`, `radius`, `angle`, `length`, `width`, `update`, `animSpeed`, `fontSize`, …) — expression strings, compiled on demand.

### `evalAttr` / `evalColor` API

```typescript
export function evalAttr(expr: string | undefined, env: Environment): number {
    if (!expr) return 0;
    return compiledFor(expr)(env);   // compile-and-memo by source string, then call with env
}
```

This is the primary interface for the **render pass** (called throughout `renderer.ts` and `terminator.ts`). The hot **update pass** instead stores a compiled `evalFn` on each `ObsValue` and calls `v.evalFn(env)` directly (see `updater.ts`). `evalColor` is the same, formatting the numeric `0xAARRGGBB` result as a CSS color.

## Init Blocks

Watch XML can contain `<init expr>` blocks that define variables:

```xml
<init expr="cr=136, cr2=114, mainR=cr+18, ..." />
```

These are:
1. Stored as raw strings in `xml-parser.ts` (`watch.initExprs: string[]`).
2. Applied by `runInit()` per block, in document order, in `watch-env.ts` (Chronometer) or via `createAstroEnvironment()` (Inspector and other apps) at environment creation time.
3. The resulting variable bindings are merged into the environment for subsequent expression evaluation.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/expr/compile.ts` | `compileExpr` (read-only exprs → `new Function` closure), `runInit` (init blocks), `referencedNames` |
| `src/expr/env.ts` | `Environment`/`ExprFunction` types and `createDefaultEnvironment()` (`pi`, planet constants, math functions) |
| `src/shared/astro-env.ts` | Shared astronomy/calendar/time function registry (~160 functions). Planet rise/set master cache. `evalAttr`/`evalColor`. `createAstroEnvironment()` factory for non-Chronometer apps |
| `src/watch/watch-env.ts` | Imports `astro-env.ts`, adds Chronometer-specific functions (Terra slots, Kyoto wadokei, Venezia body), runs init via `runInit()` |
| `src/watch/xml-parser.ts` | `attrExpr()` helper returning the raw attribute string |
| `src/watch/types.ts` | Expression attributes typed `string` |
| `src/inspector/expr-metadata.ts` | Curated descriptions of all functions/constants for autocomplete and reference panel |

## Related Docs

- [XML Parsing](xml-parsing.md) — How attributes are read from XML
- [Astronomy](astronomy.md) — Astronomy functions available in the expression environment
- [Inspector](inspector.md) — Live expression evaluator with autocomplete and reference panel
- [Animation](animation.md) — How `evalAttr`/`evalFn` are called during animation ticks
- [Architecture Overview](architecture-overview.md) — Shared environment architecture and import discipline
