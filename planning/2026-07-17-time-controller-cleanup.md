# Plan: cleanup after the time-controller scrub-invisibility work

> **Status: §§3–4 implemented 2026-07-17 (build 2.0.47).** Steve approved Q1
> (delete the whole dead cluster + the 2b vestige) and Q2 (remove the
> `switchTab` timer); both done. Q3 (Observatory `layout.ts` archaeology)
> spun out into its own plan:
> [2026-07-17-observatory-layout-popover-deadcode.md](2026-07-17-observatory-layout-popover-deadcode.md).
> Follow-on to
> [2026-07-17-time-controller-scrub-invisibility.md](2026-07-17-time-controller-scrub-invisibility.md).
>
> Implemented: deleted `computeFaceCenters`, `anyFaceOverlapsRect`,
> `POPOVER_GAP`, `hexColX`, `useTopLeftAlign` + its layout block,
> `gridShiftX/Y`, and the `isAstroTab`/`positionChanged`/`wasShifted`/
> `wasAstroTab` tracking from [engine-entry.ts](../src/engine-entry.ts)
> `onGridResize` (the early-return is now size-only); removed the `switchTab`
> 320 ms timer from [time-controls-ui.ts](../src/shared/time-controls-ui.ts).
> `tsc` clean; all 8547 tests pass; in-VM on all.html @900×620 (tp-upper
> overlapping a face) face positions + canvas sizes byte-identical across
> open / Astro-tab / resize-with-Astro-tab / close — the last confirming the
> 2b spurious-rebuild path is gone. Scrub + tap ghosting unaffected. The
> pre-cleanup exclusion algorithm remains recoverable from git history
> (`main` before this commit) for the future top-button task.

## 1. What phase 3 left behind

Phase 3 removed the `if (timeUI?.isPopoverOpen())` exclusion branch of
`onGridResize()` and stopped Chronometer passing `onPopoverToggle`. That
deleted the *clever* part — `configFits`, the max-size binary search, the
shift search, and the local `circleOverlapsExclusion` all lived inside that
branch and are now **only in git history** (all our changes are still
uncommitted, so HEAD/`main` retains the full pre-phase-3 algorithm).

What remains in [engine-entry.ts](../src/engine-entry.ts) is the *plumbing*
that fed that branch — now unreachable, plus one still-active vestige.

## 2. Dead-code inventory (verified 2026-07-17, post-phase-3)

Two categories. Line numbers are current working-tree.

### 2a. Unreachable (pure dead code)

- `computeFaceCenters()` (~2007) — **no callers.** Its only caller was in the
  deleted branch. Note it *duplicates* the live inline centered-layout
  geometry (~2147+); see §3 rot argument.
- `anyFaceOverlapsRect()` (~2050) — no callers (was already dead before this
  work).
- `POPOVER_GAP` (~1994) — referenced only inside `anyFaceOverlapsRect`.
- `hexColX` (~2084) — used only at ~2138, inside the dead `useTopLeftAlign`
  block below.
- `useTopLeftAlign` (~2078) — declared `false`, **never assigned `true`**
  anymore (the assignment was in the deleted branch). Therefore:
  - the `if (useTopLeftAlign)` layout block (~2128–2146) is unreachable;
  - `gridShiftX` / `gridShiftY` (~2077) are only ever `0` and only read
    inside that block.

### 2b. Active vestige (a real, if small, cost)

- `isAstroTab` / `positionChanged` / `wasShifted` / `wasAstroTab`
  (~2000, 2106–2111). With `useTopLeftAlign ≡ false` and `wasShifted ≡ false`,
  the expression collapses to `positionChanged = (isAstroTab !== wasAstroTab)`.
  That term can still be **true** when the Astro-tab state differs from the
  last layout, which makes the early-return at ~2109 fall through and forces a
  **full relayout + all-face cache rebuild** on the next `onGridResize` (e.g. a
  window resize that happens to follow an Astro-tab toggle). It's not a
  correctness bug — the layout is identical — but it's a spurious rebuild the
  popover no longer has any reason to trigger. Removing it is the one piece
  of this cleanup with a live payoff, not just tidiness.

The build passes today because the dead functions reference each other (a
self-contained cluster) and TS doesn't flag unused module-scope functions.

## 3. The decision: delete now vs. keep as substrate

The scrub-invisibility plan (§3) leaned **keep** — the exclusion machinery is
generic over rects and the future top-button overlap task is "the same problem
with different rects." Having now seen the post-phase-3 state, I recommend
**deleting** it instead. Three reasons the "keep" case is weaker than it looked:

1. **The valuable part is already gone.** The non-trivial algorithm
   (`configFits` + max-size binary search + shift search) was *inside* the
   phase-3-deleted branch — it's already history-only. What's left to "keep"
   is just the plumbing (predict centers, test a circle vs. a rect, an
   alternate top-left layout path) — the least valuable, most reconstructible
   piece.
2. **It rots.** `computeFaceCenters` duplicates the live inline centered-layout
   geometry. If the live math changes, the dead copy silently diverges — so as
   a "substrate" for a future task it's actively untrustworthy, worse than a
   clean re-derivation.
3. **Git already preserves it, better.** The full algorithm sits in `main`
   before the cleanup commit. When the top-button task starts it will almost
   certainly refactor `onGridResize` to take exclusion rects as an input (a
   different shape than the popover-specific inline branch), so the old code is
   *reference material* regardless — and git history is a more honest reference
   than a rotting in-tree copy.

**Recommendation:** delete the whole dead cluster (2a) and the vestige (2b)
now; when the top-button task is scoped, recover the algorithm from the
pre-cleanup git revision as reference and rebuild against the then-current
layout code. If you'd rather hedge, the fallback is "delete 2b now (it has a
live cost), keep 2a until the top-button task" — but 2a is exactly the
rot-prone part, so I'd avoid it.

## 4. Shared-module cleanup ([time-controls-ui.ts](../src/shared/time-controls-ui.ts))

- **`switchTab` 320 ms relayout timer** (~766). It fires `onPopoverToggle?.(true)`
  320 ms after a Date/Astro tab switch — added solely to trigger Chronometer's
  post-transition relayout, which phase 3 removed. Consumers now:
  - Chronometer passes no `onPopoverToggle` → the timer is a no-op.
  - Observatory's `onPopoverToggle` is a bare `scheduleFrame()` redraw kick
    ([observatory-entry.ts:1308](../src/observatory/observatory-entry.ts)); a
    tab switch doesn't change the canvas, so the kick is unnecessary too.
  - Inspector passes no `onPopoverToggle`.
  So the timer serves nothing. **Remove the timer** (keep the `switchTab` tab
  visual + `setState({ tp })`). Leave the `onPopoverToggle` config hook itself
  — `showPopover`/`hidePopover` still call it and Observatory still wants the
  open/close redraw kick.
- **Sanity-check the `onPopoverToggle` open/close kicks** stay correct for
  Observatory after the timer removal (they're independent of the timer, so
  this is just a no-regression check, not a change).

## 5. Out of scope — flagged, needs a separate go-ahead

While tracing the above I found **older, unrelated popover dead code in
[observatory/layout.ts](../src/observatory/layout.ts)**: the `PopoverArms`
interface and the `popover`/`lowerBand` branches inside `computeBaseLayout`,
`portraitOneBand`, `portraitTwoBand`. Observatory's iteration-3 switch to
`anchor-layout.ts` calls all three with `popover: null` / `lowerBand: null`
([anchor-layout.ts:898–900](../src/observatory/anchor-layout.ts)), so those
branches are never exercised — but the code is threaded *through live layout
functions*, not a standalone block, so untangling it is more delicate than
this cleanup and predates the scrub work.

**Not touching it here.** It's a separate archaeology task; if you want it
done, say so and I'll scope it on its own (and confirm intent before removing
anything, per your standing "ask before deep archaeology" preference).

## 6. Verification

- Small, deletion-only change with a mechanical risk (removing something
  still reached). Guard rails:
  - `tsc --noEmit` clean (catches any lingering reference to a deleted symbol).
  - Full `vitest` suite green — including the existing
    [time-controls-ghost.test.ts](../src/__tests__/time-controls-ghost.test.ts)
    and the grid/layout regression tests.
  - In-VM (dist server, fresh port, verify the `build N.N.N` stamp):
    - **all.html at a small viewport** (e.g. 900×620, where `#tp-upper`
      overlays a face — the phase-3 verification setup): face positions and
      canvas sizes stay byte-identical across popover open / Astro-tab switch /
      close, same as after phase 3.
    - **The 2b payoff**: toggle to the Astro tab, then fire a window resize,
      and confirm no unnecessary all-face cache rebuild (watch `?drawstats` /
      the cache-rebuild path) — i.e. resize with the Astro tab active behaves
      the same as with the Date tab active.
    - Scrub + tap ghosting still behave (regression check on the shared
      module edit).

## 7. Open questions for Steve

1. **§3 — the main call:** delete the whole dead cluster now (recommended), or
   keep 2a until the top-button task? (2b comes out either way — it has a live
   cost.)
2. **§4** — agree the `switchTab` 320 ms timer can go?
3. **§5** — want the Observatory `layout.ts` popover-arm archaeology scoped as
   its own task, or leave it entirely for now?
