# Hardening After Slop Removal: Invalidation Counter, Safe Frame Brackets, Rank-1 Sort

**Date:** 2026-08-22
**Status:** Proposed — awaiting Steve's approval (expanded from the review
follow-up chip so the design can be judged before any code changes).
**Parent:** [2026-08-22-astro-slop-zero.md](2026-08-22-astro-slop-zero.md) —
these are the three "skipped" findings from that change's review that harden the
machinery the slop removal now leans on. None is urgent; none changes any
computed value.

## TL;DR

Slop removal made two things load-bearing that used to be forgiving: (a) storm
sites must remember `withFrozenFrame` (a missed wrap silently degrades to
one whole-pool invalidation per elapsed millisecond — this failure mode already
happened once, in `setNoonOnTop`, caught only by the review), and (b) the frame
snapshot is now the *only* thing keeping same-group cache pushes bit-identical.
Three small changes make failures of both visible or impossible:

1. **A pool-invalidation counter** folded into the existing always-on
   `astroProfile` counters and the `[scrub-perf]` report.
2. **Exception-safe `beginFrame`/`endFrame`** in the three rAF loops (a thrown
   frame currently sticks the snapshot forever — the clock freezes until reload).
3. **Sub-sort rank 1 (evalAhead) by `updateInterval`** in `byEvalTimeClass`,
   mirroring rank 2 — closes the one remaining structural cache-thrash path.

Expected test impact: **bit-identical** (items 1 and 3 change no values; item 2
changes only the exception path). Perf impact: one integer increment per pool
invalidation (item 1); nothing else touches a hot path.

## Item 1 — pool-invalidation counter

**Problem.** Under exact-match re-keying, an unfrozen eval storm has *no
functional symptom* — every value is individually correct, just recomputed per
ms-cohort instead of once. The `setNoonOnTop` miss (parent doc §6.4) produced
exactly this: correct rendering, wasted work, invisible except by wall-time
profiling. There is currently no counter that would show "hundreds of
invalidations where 1 was expected."

**Design.** The codebase already has the right pattern:
[`astroProfile`](../src/shared/astro-env.ts:2281) — always-on integer counters
(`masterCalls`/`masterComputes`/`masterMs`/`leafCalls`/`leafMs`), explicitly kept
cheap for the hot path, reset at scrub start (`resetAstroProfile`,
[astro-env.ts:2293](../src/shared/astro-env.ts:2293)) and printed at scrub end in
the `[scrub-perf]` block ([engine-entry.ts:1454](../src/engine-entry.ts:1454)).

Layering: `astroProfile` lives in astro-env, which *imports* astro-cache, so the
counter itself must live in astro-cache. Concretely:

- `astro-cache.ts` exports `export const cacheStats = { invalidations: 0 }`;
  `pushECAstroCacheInPool` increments it inside the `needsInvalidation` branch
  (one integer add next to an existing flag bump — negligible), and
  `invalidateCachePool` counts as one (it is one deliberate whole-pool
  invalidation, not four).
- `resetAstroProfile()` also zeroes it; the `[scrub-perf]` astro line prints it
  (e.g. `invalidations: N (M/tick)`).

**What it buys.** During scrub, the expected count is ~1 per tick per face pool
(plus refinement/midnight re-keys inside searches — the first captured number
becomes the baseline for "expected"). A missed wrap or a future regression that
starts thrashing shows up as an order-of-magnitude jump in a number that is
already part of every pasted `[scrub-perf]` block.

**Known blind spot (honest limit).** The report prints only at scrub end, so a
gesture-time storm at 1× (the `setNoonOnTop` shape) still prints nothing by
default. The counter is still inspectable in the console, and the scrub path —
the perf-gated one — is fully covered. A possible extension (not proposed now,
flag if wanted): a dev-only warning when more than ~50 invalidations land within
one event-loop turn, which is precisely the unfrozen-storm signature. Deferred
because it adds a timing heuristic to a hot path for a case the review process
has now caught once already.

## Item 2 — exception-safe frame brackets

**Problem.** All three rAF loops hand-roll the bracket with no `try/finally`:
EC [engine-entry.ts:1544](../src/engine-entry.ts:1544) → `endFrame()` at ~1736,
EO [observatory-entry.ts:521](../src/observatory/observatory-entry.ts:521) →
~561, Inspector
[inspector-entry.ts:793](../src/inspector/inspector-entry.ts:793) → ~812.
Verified: none has an early `return` between the pair, so the *only* escape path
is an exception — but if any eval/draw throws, `endFrame()` is skipped and
`frameSnapshot` sticks permanently: every subsequent `getDisplayTime()` returns
the stuck instant, the clock appears stopped, and (because `withFrozenFrame`
passes through when a snapshot is active) every storm freeze silently no-ops at
the stale time. One thrown frame = frozen app until reload, with no error beyond
the original one. Pre-existing, but the slop change raised the stakes: the
snapshot is now the sole guarantor of same-group key identity.

**Design.** Wrap each frame body: `try { …body… } finally { timeController.endFrame(); }`.
Notes per loop:

- **EC**: the scrub-perf instrumentation after `endFrame()` (~1738+) stays
  outside the `finally` — it must keep running post-frame exactly as today.
- **Inspector**: also move `inTick = false` (and any `frameRequestedDuringTick`
  bookkeeping that must not be skipped) into the same `finally`, so a thrown
  frame can't wedge its re-entry guard either.
- **EO**: straightforward; `drawFrame()` and the updater passes are the throw
  candidates.

Not using `withFrozenFrame` here: the loops need `beginFrame` early and
substantial code between the pair; a `try/finally` is the minimal faithful form
and keeps the diff readable. Behavior with no exception is byte-identical.

## Item 3 — sub-sort rank 1 (evalAhead) by interval

**Problem.** [`byEvalTimeClass`](../src/shared/updater.ts:871) orders values
rank 0 (eval at now) → rank 1 (evalAhead) → rank 2 (onBeat), and sub-sorts by
`updateInterval` **only for rank 2**. Rank-1 values at 1× each evaluate at their
own per-interval boundary ([updater.ts:205](../src/shared/updater.ts:205)), so
mixed-cadence rank-1 values firing on the same frame interleave in *registration*
order — alternating push times, each alternation a whole-pool invalidation under
exact-match re-keying. The 0.5 s slop used to absorb sub-second alternations;
that absorber is gone.

**Exposure today: latent, not live.** Only the Inspector registers rank-1 values
(catalog cells, cadences 0.1/1/60 s); its adjacent boundaries are ≥0.9 s apart,
which the old slop re-keyed too — so current behavior is unchanged from
pre-slop-removal, and EC/EO register no rank-1 values at all. The risk is any
*future* evalAhead adopter with sub-second mixed cadences silently paying one
pool invalidation per alternation per frame.

**Design.** One comparator line: when both values are rank 1 and intervals
differ, sort by `updateInterval` — the same clause rank 2 already has. Safety of
reordering: the sort is a stable one-time sort (registration order preserved
within equal keys), and the updater's own documented invariant
([updater.ts:938](../src/shared/updater.ts:938)) — every evalFn is a function of
env + display time + cache, order-independent — is *strictly* true now at slop 0
(the parent change made it so). Same-interval rank-1 values share bit-identical
boundary keys (epoch-aligned, pure function of interval + frozen now), so
grouping them is exactly as valid as rank 2's grouping. During scrub all rank-1
evals share one time (now + tick delta), so the sub-sort is inert there.
Incidental benefit: the Inspector's whole-second frames (where 0.1 s and 1 s
cells coincide) drop from interleaved alternation to two contiguous groups.

## Verification

- `npx tsc --noEmit`; full `npx vitest run` — expected **fully green with zero
  golden diffs** (no computed value changes; EC/EO have no rank-1 values).
- New unit test for item 2's contract at the TimeController level is already
  implicitly covered (`withFrozenFrame` is try/finally); the render loops
  themselves aren't unit-tested — verify by code inspection plus one manual
  check: throw injected in a dev console (`updater.tick` monkeypatch) and
  confirm the clock keeps running on the next frame.
- Item 1: run a short scrub, confirm the `[scrub-perf]` block prints a sane
  invalidation count (~ticks × faces magnitude), and note that number in this
  doc as the reference baseline.
- Per development-rules §18 this touches the cache pool and tick: run
  `npx tsx src/__tests__/perf/perf-regression.ts` — expected noise-level (one
  integer increment); interleaved A/B only if it flags.

## Coordination

Two sibling sessions are (or were) working concurrently:
`Extract shared per-face rebuild helper` (engine-entry.ts, rebuild loops
~3100–3720) and `Mauna Kea alpha ObsValues` (hand-values.ts / renderer.ts).
Item 2 touches engine-entry.ts at ~1544/1736 — a different region, but the same
file: land this after those merge, or rebase over them. Items 1 and 3 touch
files neither session edits.

## Out of scope

- The unfrozen-storm *warning* heuristic (item 1's "possible extension").
- Deleting the dead `renderWatch` (renderer.ts:221, flagged in the same review)
  — trivial, but it belongs with the Mauna Kea/renderer work, not here.
- Any change to what gets computed — all three items are observability,
  exception-robustness, and ordering only.
