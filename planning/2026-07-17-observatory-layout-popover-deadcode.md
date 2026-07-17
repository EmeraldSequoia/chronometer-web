# Plan: remove dead popover-arm layout code from Observatory `layout.ts`

> **Status: draft for review, 2026-07-17.** No code written. Spun out of
> [2026-07-17-time-controller-cleanup.md](2026-07-17-time-controller-cleanup.md)
> §5 (Q3) at Steve's request. Independent of the scrub-invisibility /
> Chronometer cleanup work — this is Observatory-only and predates it.

## 1. What this is

Observatory's **old** layout module,
[src/observatory/layout.ts](../src/observatory/layout.ts), still carries the
machinery for reshaping the dial layout around an **open time-controller
popover**: the popover's vertical arm narrowed the effective window width and
its lower arm became a right-anchored "bottom band" that pushed dials up.

Observatory's **iteration 3** (commit `025c7ce`, "9 aspect anchors") moved
production to [src/observatory/anchor-layout.ts](../src/observatory/anchor-layout.ts)
and made the popover a **pure overlay** — the same conceptual change we just
made for Chronometer. Every production call now passes `popover: null` /
`lowerBand: null`, so the reshaping code never runs. It's dead, but — unlike
Chronometer's case — it's *threaded through live layout functions* rather than
sitting in one deletable block, which is why it needs its own plan.

## 2. Verified dead (2026-07-17)

Single funnel, all null. Every path into the layout functions goes through
`buildBaseLayout` ([anchor-layout.ts:897-901](../src/observatory/anchor-layout.ts)):

```
898  if (anchorId === 'A2') return portraitTwoBand(W, H - footerH, null);
899  if (anchorId === 'A3' || anchorId === 'A3m') return portraitOneBand(W, H - footerH, null);
900  return computeBaseLayout(W, H, { footerH, popover: null });
```

- **Production**: `observatory-entry.ts:290` → `computeLayout` (anchor-layout)
  → `buildBaseLayout`. The chrome it builds (`chromeParams()`,
  [observatory-entry.ts:271-274](../src/observatory/observatory-entry.ts)) is an
  `ObsChrome` with no popover field — comment already says "so no popover arms."
- **Harness**: `harness/layout-harness.html:305` calls the same `buildBaseLayout`
  → same hard-coded `null`. The harness references `TC_POPOVER_W/H` only for the
  chrome-drop decision (see §3), never to construct a `PopoverArms`.
- **Tests**: no test imports `layout.ts`/`anchor-layout.ts` or references
  `computeBaseLayout` / `portraitOneBand` / `portraitTwoBand` / `bottomLimitFor`
  / `PopoverArms` / `LowerBand` / `lowerBand`. Two keyword matches
  (`composite-icon.test.ts`, `time-controls-ghost.test.ts`) are false positives.
  **Removing the popover path breaks zero tests.**

So the reshaping path is provably unreachable, and simplifying "as if
`lowerBand === null`" is **behavior-preserving by construction** — every
`if (lowerBand …)` branch is dead and every `bottomLimitFor(...)` returns the
plain window bottom.

## 3. Do NOT touch — the separate, LIVE chrome-drop feature

`anchor-layout.ts` exports `TC_POPOVER_W = 200` / `TC_POPOVER_H = 368`
([:80-81](../src/observatory/anchor-layout.ts)) and uses them at
[:954](../src/observatory/anchor-layout.ts) — `dropChrome = safeW < TC_POPOVER_W || safeH < TC_POPOVER_H`
— to set `L.chromeDropped` ([:977](../src/observatory/anchor-layout.ts)), which
`observatory-entry.ts:294` toggles as `obs-chrome-dropped` (hides the DOM
header/footer when the window can't fit the time controller). This uses the
popover's **pixel footprint**, not the dead `PopoverArms` layout path. It is
live and unrelated. **Leave `TC_POPOVER_W/H`, `dropChrome`, `chromeDropped`,
and `obs-chrome-dropped` entirely alone.**

## 4. Removal map (per construct)

"Clean" = delete the whole thing. "Entangled" = the call still does real
non-popover work with `lowerBand === null`; it must be **simplified in place**
(not deleted), because `bottomLimitFor(…, null, …)` returns `H` — a genuine
window-bottom clamp survives. All line numbers are current
[layout.ts](../src/observatory/layout.ts).

| Construct | Lines | Type | Note |
|---|---|---|---|
| `PopoverArms` interface | 71-77 | Clean | Unreferenced once §a done |
| `popover` field in `ChromeParams` | 82-83 | Clean | Keep `footerH`; interface survives |
| `LowerBand` interface | 86-92 | Clean | After all threading gone |
| Popover block in `computeBaseLayout` | 430-439 | Entangled-lite | Delete 434-439 + comment; `let W` → `const W = viewW`; drop `lowerBand` arg at 443-444 |
| `bottomLimitFor` fn | 453-460 | Entangled | Degenerates to `return H`; simplify callers first, then delete |
| `if (lowerBand …)` in `portraitOneBand` | 586-593 | Clean | Pure dead branch |
| `if (lowerBand …)` in `portraitTwoBand` | 670-677 | Clean | Pure dead branch |
| `bottomLimitFor` calls in `portraitCornerDials` | 520-521 | Entangled | `Math.min(bottomLimitFor(…), H - g)` → `H - g` |
| `bottomLimitFor` calls in `computeLandscape` | 802, 809, 821, 826 | Entangled | Each → `H` (window bottom); surrounding date/weekday math stays |
| eot clamp in `computeLandscape` | 854-856 | **Entangled — rewrite, don't delete** | `eotBottomLimit = bottomLimitFor(…) → H`; keep `if (eotCY + extR > H) eotCY = H - extR` (verified: real clamp) |
| Stale strategy prose (popover reshaping) | 16-20 | Comment | Update to reflect overlay-only |

Signature-threading (the `lowerBand: LowerBand | null` param) to unthread:
`bottomLimitFor` (457), `computePortrait` (466), `PortraitCommon.lowerBand`
field (490, destructured 508), `portraitOneBand` (551, **exported**),
`portraitTwoBand` (631, **exported**), `computeLandscape` (715) — plus the
pass-through sites 479-480, 611, 695.

Cross-file (all trivial): `anchor-layout.ts` :898/:899 drop the trailing
`null`; :900 `{ footerH, popover: null }` → `{ footerH }`. The
`type ChromeParams` import ([:32](../src/observatory/anchor-layout.ts)) stays
valid. Harness needs no source edit — only a rebuild (`build-harness.sh`).

## 5. Phasing (isolate the risky half)

The clean deletions and the entangled simplifications have different risk, so
split them:

- **Phase 1 — seal the entry (low risk, independently shippable).** Remove
  `PopoverArms`, the `popover` field in `ChromeParams`, the construction block
  in `computeBaseLayout` (430-439), and the 3 `anchor-layout.ts` call-site
  args. Now `lowerBand` is *provably* always `null` everywhere, but the
  internal params/branches still exist. This alone kills the "could this be
  non-null?" question and is a pure entry-surface change. `tsc` + the §6
  equivalence check.
- **Phase 2 — unthread `lowerBand` (the entangled half).** Delete the dead
  `if (lowerBand)` branches (clean), simplify each `bottomLimitFor` call site
  to its `null`-case value (`H` or `H - g`), **rewriting the eot clamp at
  854-856 to preserve the window-bottom clamp**, then delete `bottomLimitFor`,
  the `LowerBand` interface, and the `lowerBand` params from all six
  signatures + pass-through sites. Re-run the §6 equivalence check after each
  call-site simplification, not just at the end.

Phase 1 is safe to land on its own; Phase 2 is where a careless edit could
change a live layout, so it carries the heavier verification.

## 6. Verification

The strong check here is **layout-equivalence**, not pixels: the change must
produce byte-identical `LayoutParams` for every anchor at every size, because
it's behavior-preserving by construction.

- `tsc --noEmit` clean; full `vitest` suite green (no layout tests exist, but
  this guards the broader build).
- **Equivalence sweep**: before starting, capture `buildBaseLayout` /
  `computeLayout` output (the full `LayoutParams`) for all 9 anchors across a
  grid of viewport sizes (portrait, landscape, square, tiny, huge) into a
  golden file; after each phase, re-run and assert deep-equal. A throwaway
  Node/vitest script importing the built module is enough; this catches any
  arithmetic slip in the entangled simplifications immediately. (Consider
  keeping it as a permanent `layout.test.ts` — there is currently *no* layout
  regression test, which is partly why this code rotted unnoticed.)
- **Harness eyeball**: `build-harness.sh` then drive `harness/layout-harness.html`
  through the anchors in the browser pane; confirm the dials render identically
  and the chrome-drop (§3) still triggers at small sizes.
- Live Observatory smoke: open at a few sizes with the time controller open —
  dials unchanged, popover overlays as it does today.

## 7. Open questions for Steve

1. **Scope**: both phases (full excision, cleanest end state) — recommended —
   or Phase 1 only for now (seal the entry, leave the always-null plumbing)?
2. **Regression test**: add the equivalence sweep as a permanent
   `layout.test.ts`? It's cheap and this module had no coverage.
3. Any known reason the popover-arm reshaping might be *wanted back* (e.g. a
   future non-overlay time-controller on Observatory)? If so, this becomes a
   git-history parking exercise like the Chronometer cleanup rather than a
   delete. Nothing in the current direction suggests it, but flagging since
   the code was recent (iteration-3 era).
