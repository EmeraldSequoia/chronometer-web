# Per-instant tz conversion: geneva crash + perf regression (found via profiling)

**Date:** 2026-06-30
**Status:** Found by re-profiling after the other session's per-instant tz-conversion change. **Not
fixed here** — this is that session's in-progress, uncommitted code (`astro-env.ts` +152 vs HEAD:
`tzFormatter` / `tzOffsetSecondsAt` / `targetLocalDate`). This doc is the analysis for whoever fixes it.
Both issues were caught by the new perf harness ([2026-06-30-perf-regression-harness.md](2026-06-30-perf-regression-harness.md)).

---

## Two problems, one root

The change ports iOS `ESCalendar` **per-instant** timezone conversion: resolve the UTC offset *at the
instant being converted* (correct across DST transitions) via `Intl.DateTimeFormat.formatToParts`,
instead of a single captured offset. Correct in spirit, but:

### 1. 🔴 CRASH — geneva, during scrub (correctness regression)

```
RangeError: Invalid time value
  at DateTimeFormat.formatToParts (<anonymous>)
  at tzOffsetSecondsAt (src/shared/astro-env.ts:125)     // formatToParts(new Date(utcMs))
  at targetLocalDate    (src/shared/astro-env.ts:355)     // offMs = tzOffsetSecondsAt(tz, utcMs)*1000
  at <obsValue eval>    (src/shared/astro-env.ts:444)     // const yr = targetLocalDate(t).getUTCFullYear()
  at onArrivalOnBeat    (src/shared/updater.ts:532)        // eval-ahead
```

**Mechanism (confirmed):**
- Geneva has a value scheduled `update='updateAtEnvChangeOnly'`. `computeNextBoundary` returns
  **`Infinity`** for that sentinel (animation.ts: `if (!isFinite(eventDI)) return Infinity`). The same
  happens for any rise/set sentinel that resolves to **NaN** (e.g. no event at a polar latitude).
- During scrub, `onArrivalOnBeat` evaluates **eval-ahead at the boundary display time** —
  `withDisplayTime(Infinity, … evalFn …)`. So inside the eval, `getNow()` is `new Date(Infinity)` =
  **Invalid Date**, and `now.getTime()` is **`NaN`** (astro-env.ts:443).
- The new DST-indicator block (astro-env.ts:443-446) then calls `targetLocalDate(NaN)` →
  `tzOffsetSecondsAt(tz, NaN)` → `new Date(NaN)` → `formatToParts` **throws `RangeError`**.

The old captured-offset path tolerated a non-finite display time (plain arithmetic, no `Date`
construction). The new per-instant path does not. **The regression suite (`npx vitest run`) should
also surface this** — geneva's scrub cases at any location will hit the same path and throw.

### 2. 🟠 PERF — per-instant `formatToParts` per eval (kyoto +41%, …)

Measured vs the pre-change baseline (perf harness, this machine):

| face | base | now | Δ |
|---|---:|---:|---:|
| kyoto | 1.45 | 2.04 | **+41%** |
| haleakala | 0.052 | 0.072 | +38% |
| hana | 0.81 | 0.95 | +17% |
| selene | 1.80 | 2.06 | +15% |
| venezia | 0.64 | 0.71 | +11% |
| gaia / mauna-kea | — | — | +5–13% |
| basel, terra, miami, vienna, … | | | flat |

The regressed faces are exactly the ones doing **per-instant `targetLocalDate` conversions**; each call
is an `Intl.formatToParts`, which is ~µs even though the **formatter is already cached** (`tzFormatter`
via `_tzFmtCache`). It's `formatToParts` *itself*, run per-eval per-tick, that costs. Faces that don't
use the per-instant path (basel/terra/miami/vienna) are unchanged.

---

## Fix analysis

### Crash — guard non-finite time (small, urgent)

The eval **does** run at the `Infinity` boundary (the envChangeOnly value's expression executes
eval-ahead), so the tz code must tolerate a non-finite instant. Guarding only `targetLocalDate` is
**insufficient** — line 445-446 also call `tzOffsetSecondsAt(tz, Date.UTC(yr, …))` where `yr` came from
`targetLocalDate(NaN).getUTCFullYear()` = `NaN`, so it re-crashes. So guard at the source:

```ts
export function tzOffsetSecondsAt(tz: string, utcMs: number): number {
    if (!Number.isFinite(utcMs)) return 0;   // offset at a non-finite instant is undefined;
                                              // return 0 so eval-at-"never" produces a defined,
                                              // never-displayed value instead of throwing.
    const parts = tzFormatter(tz).formatToParts(new Date(utcMs));
    …
}
```

Returning `0` (or the captured `tzOffsetSeconds`) is safe because the value is never actually *shown*
at `Infinity` — it's an eval-ahead toward a "never" boundary; only the non-crashing is load-bearing.
Consider also guarding `targetLocalDate` the same way for clarity. **Separately worth deciding** (not
required for the fix): whether `onArrivalOnBeat` should eval-ahead at all when the boundary is
non-finite — arguably there's nothing to animate toward "never," and skipping it would avoid feeding
`Infinity` into *any* expression. That's a broader updater change; the tz guard is the targeted fix.

### Perf — memoize the offset, gated by the next DST change (the deferred Lever-D problem)

Caching the *formatter* (done) doesn't help; `formatToParts` per eval is the cost. The offset is
constant within a tz **except across DST transition instants**, so:

- **Wrong/easy:** memoize per `(tz, floor(utcMs/86400000))` (per day). Fast, but **incorrect on the two
  DST-transition days per year** — the offset changes mid-day — which defeats the whole point of going
  per-instant (DST correctness). Don't ship this.
- **Correct:** memoize per `tz` as `{ offsetSec, validFromMs, validUntilMs }`. On a call, if `utcMs ∈
  [validFrom, validUntil)` return the cached offset (O(1), no `formatToParts`); else recompute the
  offset **and** the next transition instant (a short bounded `formatToParts` probe/binary-search
  forward to the next change), and refresh the window. Cost amortizes to ~twice a year per tz instead
  of once per eval. This is exactly the **"gate by the next DST change"** we flagged as out-of-scope in
  Lever D (the Terra `Intl` work) — the per-instant path has now made it load-bearing.

A lighter interim that's *correct* (if less elegant): keep per-instant `formatToParts`, but only call it
where DST-exactness matters; for the many per-tick calls that just need "the offset around now," reuse
the captured `tzOffsetSeconds` (already on `env`) and reserve the per-instant lookup for the specific
indicators that need transition-accuracy. Reduces call volume without the windowed memo.

---

## How this was caught / how to re-check

```bash
npx vitest run                         # would throw on geneva scrub cases (the crash)
npx tsx src/__tests__/perf/perf-regression.ts    # flags geneva CRASH + kyoto/haleakala/hana/selene ⚠ slower
```
After the fix, re-run both; once green and on a clean tree, `--capture` a fresh `perf-baseline.json`
(the per-instant change is intended, so the new — hopefully-recovered — numbers become the benchmark).
