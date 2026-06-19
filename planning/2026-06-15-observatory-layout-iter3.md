# Observatory Layout — Iteration 3 (Design Points & Transitions)

**Date:** 2026-06-15
**Status:** 🟡 In progress — A2 (iPhone portrait), A3 (iPad portrait), A3m (iPad mini), A4 (iPad landscape), A5 (iPhone landscape), **A6 (extreme landscape) ✅ complete**; A1 (extreme portrait) not started; transitions §7 pending.
**Parents:**
- [2026-06-06-observatory-phase-8-layout.md](2026-06-06-observatory-phase-8-layout.md) — adaptive two-template engine
- [2026-06-10-observatory-phase-8b-layout-refinement.md](2026-06-10-observatory-phase-8b-layout-refinement.md) — refinements R1–R6

---

## 0. What this document is

This is **not** an implementation plan. It is the *record of an extended tuning
phase*. The output is a set of **optimum layout rules** per design point (and
per transition), captured in English tables here, which a *later* plan will turn
into production code.

We do this empirically: build an instrumented harness that reproduces the
**committed** layout logic, then refine it by eye at carefully chosen aspect
ratios and sizes, recording each rule as we agree on it.

### Why anchors + transitions instead of incremental code

Iteration 2 ([layout.ts](../src/observatory/layout.ts)) is **two templates**
(`portrait`/`landscape`) chosen by aspect with a hysteresis dead-band, plus one
continuous adaptive sizing cascade, plus a separate **mobile-only** path.
Iteration 3 generalizes that to **6 aspect anchors + 5 transitions** and
**retires the mobile-only path**. We tune the anchors first so we understand how
much they diverge *before* committing to a code architecture — particularly
because the transitions may be complex and we don't want to lock into a less
capable structure.

---

## 1. The three independent layout axes

A window's layout is a function of three **independent** inputs. Keeping them
separate is the central design decision of iteration 3.

| Axis | What it is | Character |
|---|---|---|
| **Aspect ratio** (W/H) | The *anchor identity*. | Continuous; defines the 6 design points + 5 transitions. |
| **Size** (`S=min(W,H)`, `L=max`) | Two same-aspect windows of different pixel size. Fixed-size UI elements take different *fractions*. | Continuous, secondary. Hypothesis: effects are **small** vs. aspect — to be tested per anchor. |

**Safe-area insets are NOT a third axis.** Since we put nothing in the unsafe
areas, the **safe rectangle *is* the design surface** — and it is identical for a
notched phone and a desktop window of the same dimensions. So we design directly
in the reduced (safe) rect: the insets are "baked out," anchor dimensions are
safe-rect dimensions, and the layout never sees insets at all. (`viewport-fit=
cover` is still needed at runtime to *obtain* the safe rect — see §5 — but it
doesn't enter the layout math.) This is the simplification that collapses the
phone and desktop-window cases into one.

```
computeLayout(safeW, safeH, chrome)        // operates entirely in the safe rect
```

Out of tuning scope (held constant across all anchors unless they actively
interact): inside-dial scaling (`s = mainR/365`), footer-chrome reserve, popover
L-exclusion.

### 1.1 Nested design rects & element decoupling

The design surface nests in two steps, each "subtract the fixed part, design in
what's left" — the same move twice:

1. **Safe rect** = physical − unsafe insets (§1).
2. **Content rect** = safe rect − **fixed-size chrome** (the header row and the
   single footer row). The header (Observatory · ℹ · share), footer (location/time
   + noon-toggle icon), and their text/buttons are **fixed px** — sized for
   readability/touch, *not* scaled. The dial-region layout (moon, map, date,
   main dial, outer dials) is captured **relative to the content rect**, which
   grows with the window while the chrome stays fixed.

Within the content rect, **elements are sized and positioned independently** —
no element's size is derived from another's. Concretely, this **retires the
iteration-2 couplings** we hit:

| Iteration-2 coupling (to drop) | Iteration-3 |
|---|---|
| `dateH = 0.45·mapH` (date welded to map) | date box sized by its own rule vs. the content rect (A2 trial: `dateH ≈ 0.144·W`); map sized independently |
| `dateW` floor of 140px tips `oneBand`, **flipping the whole layout row↔stack by *size*** | **date mode pinned per anchor** (A2 = `row` at every size); mode changes are explicit *transition* decisions, never silent size thresholds |
| date font capped (`dateH≤80`, `UNIT_MAX=72`) | **fonts scale with their own box**, which scales with the content rect; caps only where we deliberately choose. *(A2 verified: monthDay "J" = 11 / 13 / 16 px across small / canonical / large — proportional.)* |

Harness support: A2 calls the exported `portraitTwoBand` directly (pinning the
phone layout) and overrides the date box (`a2DateBox`), so large no longer flips
to the iPad one-band/stack arrangement.

---

## 2. The design points (anchors)

*Started with six; **A3m** (iPad mini) was promoted to its own anchor during A3
tuning — the iPad aspect spread needs distinct mini rules. Expect other anchors
to split similarly as we tune.*

Design points are keyed on **aspect ratio + size only — never device or a
`mobile` flag**, and all dimensions are **safe-rect** dimensions (§1). "iPhone
portrait" is shorthand for *aspect ≈ 0.51* (the safe rect); it applies identically
to a same-aspect desktop window. (This retires iteration 2's mobile-only path —
see §0.)

| # | Anchor | Aspect (W/H) | Canonical px (safe rect) | Basis / notes |
|---|--------|-------------|--------------|---------------|
| A1 | **Extreme portrait** | **0.10** | — | Narrowest we support. Expectation: degrade to ~one element per row. |
| A2 | **iPhone portrait** | **0.512** | 430×839 | 19.5:9 iPhone (430×932) minus safe insets (top 59 + bottom 34). *(SE governed by the A2↔A3 transition.)* |
| A3 | **iPad portrait** | **0.725** | 834×1150 | iPad 11"/Air 11"/Pro 11" (834×1194) minus insets (24/20). 13" (1024×1322 = 0.775) is a wider sample. |
| A3m | **iPad mini portrait** | **0.683** | 744×1089 | iPad mini (744×1133) minus insets — its own anchor (A3 + map ×1.10 + date −5%). |
| A4 | **iPad landscape** | **1.45** | ~1700×1180 | Reciprocal of A3. Variations: **1.333** (13"), **1.523** (mini). |
| A5 | **iPhone landscape** | **1.99** | 814×409 | **Safe rect** (932×430 − insets 0/59/21/59); ≈ reciprocal of A2 (1/0.512 = 1.95). *(Physical 932×430 = 2.168 — the edge-inclusive size — is **not** the anchor.)* |
| A6 | **Extreme landscape** | **10.0** | — | Widest we support. Expectation: degrade to ~one element per column. |

### 2.1 Sample sizes per anchor (size axis)

For each anchor we tune at a **small / canonical / large** sample to test the
"size effects are small" hypothesis. (Filled in / revised as we tune.)

| Anchor | Small | Canonical | Large |
|---|---|---|---|
| A1 extreme portrait | TBD | TBD | TBD |
| A2 iPhone portrait | 360×702 | 430×839 | 560×1093 |
| A3 iPad portrait | 720×993 (+ xs 360×497) | 834×1150 | 1100×1517 |
| A3m iPad mini | 600×878 | 744×1089 | 900×1318 |
| A4 iPad landscape | 1190×820 | 1710×1180 | 2174×1500 |
| A5 iPhone landscape | 700×352 | 814×409 | 1000×503 |
| A6 extreme landscape | TBD | TBD | TBD |

### 2.2 Safe insets → safe-rect dimensions

We don't model insets (§1); instead each anchor's **safe-rect** dimensions are
derived once from the physical size minus the device's safe insets. Reference
insets used to derive the anchors:

| Device | physical | insets (t/r/b/l) | → safe rect |
|---|---|---|---|
| iPhone portrait (installed) | 430×932 | 59/0/34/0 | **430×839** (A2) |
| iPhone landscape | 932×430 | 0/59/21/59 | 814×409 (A5) |
| iPad portrait | — | 24/0/20/0 | (A3, TBD) |

A desktop window has zero insets, so its safe rect = the window; a window at an
anchor's safe-rect dimensions reproduces that anchor exactly.

---

## 3. Rule representation (how we record what we agree on)

Every rule we capture during tuning is tagged on **two** dimensions so the later
implementation — especially the transitions — can't be architecturally boxed in:

1. **Driver** — `aspect-driven` (part of the anchor's identity) vs.
   `size-driven` (a fraction-of-window / fixed-chrome correction).
2. **Transition behavior** — `snap` (changes discretely at a transition) vs.
   `interpolate` (varies smoothly across aspect). Interpolated rules are
   expressed as **numeric parameters that vary with aspect**, never as
   `if (landscape) …` branches.

*(A former third tag — `bleed`/`clamp` for unsafe areas — was retired when we
made the safe rect the design surface (§1): everything is laid out inside the
safe rect, so nothing bleeds. Nothing is placed in unsafe areas.)*

---

## 4. The per-anchor tuning loop

For each anchor, in order A2 → A3 → A4 → A5 → A6 → A1 (start with the known-good
iPhone portrait, end with the extremes):

1. **Harness** renders the *committed* layout at the anchor's aspect, with live
   W/H controls, inset sliders + presets, a measured-ratio readout (D, extR,
   moonR, mapW, all gaps), and labeled bounding-box overlays.
2. **You give a rule** by eye. I encode it as a named parameter in that anchor's
   rule-set **and** a row in §6's table, tagged per §3.
3. **Sweep the sample sizes** (§2.1) and inset presets (§2.2); you give
   size-/inset-dependent rules; I record them as functions of `S`/`L`/`dpr`/insets.
4. **Finalize** → write that anchor's §6 subsection → capture a baseline
   screenshot → next anchor.

Then **transitions** (§7): pick two adjacent anchors, scrub aspect between them
in the harness, agree on the blend, record it.

---

## 5. Prerequisite for the implementation phase (not done now)

`src/observatory/observatory.html` viewport is currently
`width=device-width, initial-scale=1.0, user-scalable=no` — **no
`viewport-fit=cover`**. Turning it on is required for the web to expose
`env(safe-area-inset-*)`, which is how the runtime obtains the **safe rect** that
the whole layout is designed in (§1). Flip `viewport-fit=cover` as the first step
of the implementation plan, and feed the resulting safe rect to `computeLayout`.

---

## 6. Design-point rules (filled in as we tune)

### 6.0 Cross-cutting rules (apply to every anchor)

Rules invariant of which anchor we're in — captured once so per-anchor rules
stay clean.

| # | Rule | Where | Status |
|---|---|---|---|
| RR1 | **Date block centers on real glyph ink, not the em-box** — and on the **prominent** ink only. `drawBlock` shifts all baselines so the visible ink's vertical midpoint lands on the box center, using `actualBoundingBox*` metrics. The **faint *and* small secondary fields (timezone, "leap")** are excluded from the centering bounds (they don't read as part of the date's mass, so counting them made the prominent content look shifted up — visible in `stack` mode where tz is its own bottom line). Makes the box a faithful proxy for the *prominent* ink in all three modes (`row`/`split`/`stack`). | [date-view.ts](../src/observatory/date-view.ts) `drawBlock` (`prominentOnly`) | ✅ done |
| CC1 | **Eclipse footprint = `extR`.** All four outer dials are the same size. The eclipse is a disc (`eclipseR1`) + marker ring (`eclipseR2`); `extDerived` authored `eclipseR2 = extR + 3·es ≈ 1.05·extR` (an iOS port: 63 px ring vs 60 px ext dials), so its footprint was 5 % over. Fix: size the eclipse's outer ring to `extR` (preserve the internal R1/R2 proportions). | [layout.ts](../src/observatory/layout.ts) `extDerived` | 🔲 impl |
| RR2 | **Landscape bottom date: month-day on the bottom line, year/tz on top, tight spacing.** In `split` mode (landscape, date along the bottom), the date2 block draws **year+tz above month-day** so the prominent month-day sits at the same height as the weekday on the left, with the year/tz reading above it. The two lines use **ink-tight spacing** (`drawBlock({ tight })`): lines are placed on real `actualBoundingBox` ink + a proportional pad (`TIGHT_LINE_GAP`), not the em-box advance (which reserved the big line's full ascent and floated the year far above). Matches the iOS landscape spacing (EOClock.mm `bdY3 = bdY + 34.5`, big font 48 → year centre ~0.72× big-font above month-day centre) and scales with the font. Element rendering (sizes/colors) is unchanged — only line order and gap. | [date-view.ts](../src/observatory/date-view.ts) `drawDateView` (`split`) / `drawBlock` | ✅ done |

*RR1 verified in harness:* A2 `row` ink offset went +5px → −0 (top↕12/bot↕1 →
top↕7/bot↕7); A4 `split` boxes both center within ±1px. *CC1 verified:* with the
eclipse drawn at `extR`, all four rim gaps match (A2 19/19/19/19, A3 16/16/16/16).

### A2 — iPhone portrait (aspect 0.512) ✅
*Safe rect; canonical 430×839; samples 360×702 / 430×839 / 560×1093.*
*Verified ship-ready across all three samples.*

**Layout (within the content rect = safe rect − header − footer):**

| # | Rule | Value / detail | Driver | Transition |
|---|---|---|---|---|
| L1 | **Two-band phone layout, pinned** | moon+map band, date band, then the main dial; **never** flips to the iPad one-band/stack arrangement, at any size. | aspect | snap |
| L2 | **Main dial** | `D = 0.95·W` (the iOS portrait invariant), centered horizontally. | aspect | interpolate |
| L3 | **Outer dials grow, holding rim-gap + side-margin** | Each grows from its committed size while holding (a) its rim gap to the main dial and (b) its margin to the nearest **side** edge; it repositions **angularly** (top-right eclipse moves up-and-left as it grows). Growth target ≈ ×1.36 at canonical. All four read the **same size** — eclipse footprint = `extR` (see shared impl note). | aspect | interpolate |
| L4 | **Reclaim ½ the header→map gap** | Move moon+map up by half the (mostly empty) gap between the header row and the band. | aspect | interpolate |
| L5 | **Cluster shift to clear the footer** | Move the whole dial cluster (main + 4 outer) up so the bottom dials clear the **single footer row** by **6 px**. | aspect | interpolate (target is size-driven) |
| L6 | **Date box, decoupled from map** | `mode = row` (pinned); `dateH ≈ 0.144·W`; `dateW ≈ W − 32`; centered horizontally. Font then scales with the box ∝ available size (verified J = 11/13/16 px @ 360/430/560). **No** `0.45·mapH` coupling, no 80px/`UNIT_MAX` cap in range. | aspect | interpolate |
| L7 | **Date position** | Plain-centered between map-bottom and main-dial-top. The monthDay-cap **raise is reserved for narrower aspects** (it fades in below ~0.51 — pin down in the **A1↔A2 transition**). | aspect | **interpolate** (raise = f(aspect)) |

**Chrome (fixed-size, inside the safe rect — does *not* scale with the window):**

| # | Element | Detail |
|---|---|---|
| C1 | Header row | `Observatory` left · `ℹ` + `share` right; one row, **~32 px — same height as the footer (C2)**. |
| C2 | Footer | **single row** (~32 px: location + time-controller button + red offset) with a **centered noon-toggle icon**. Tapping it raises the Midnight/Noon pill as an **on-demand overlay** (may overlap the dial; rare), so the pill costs the static layout nothing. |

**Implementation notes (production changes for the build-out plan):**
- **RR1** date ink-centering — ✅ already in `date-view.ts`.
- **Noon toggle = footer center icon + on-demand pill overlay** (§6.C2). Replaces the wrapped 2nd-row pill; removes all pill-fit layout coupling.
- **CC1 — eclipse footprint = `extR`** (shared, see below).
- `viewport-fit=cover` to obtain the safe rect (§5).
- L1 needs the layout to **not** select one-band at A2 — the harness pins it via the exported `portraitTwoBand`; production should drop the width-triggered `oneBand` flip for this anchor.
- The `dateWMin = max(0.26·W, 140)` floor (the trigger for the bad flip) should not gate layout mode.

**Key measured ratios @ canonical (430×839):** `D/S = 0.95`, `extR/mainR ≈ 0.224` after L3 growth, `mapW/D ≈ 0.67`, monthDay-cap `J = 13 px`.

### A3 — iPad portrait (aspect 0.725) ✅
*Safe rect (iPad 11" 834×1194 − insets 24/20); canonical 834×1150.*
*Size samples (all 0.725): xs 360×497 · small 720×993 · canon 834×1150 · large 1100×1517. Wider variation: 13" 1024×1322 (0.775).*

A3 is the **one-band (iPad) arrangement**: a header band of **moon ◂ map ▸ date** (date `stack`-style, right of the map), then the main dial with four corner dials, all within the content rect.

| # | Rule | Value / detail | Driver | Transition |
|---|---|---|---|---|
| L1 | **One-band layout, pinned** | moon ◂ map ▸ date header band, then the main dial; **never** flips to the two-band/phone arrangement, at any size. | aspect | snap |
| L2 | **Main dial** | `D = 0.95·W`, centered horizontally. | aspect | interpolate |
| L3 | **Moon centered horizontally** | moon centered in its space between the **left edge and the map** (`moonCX = mapLeft / 2`). | aspect | interpolate |
| L4 | **Date centered horizontally** | symmetric to L3: date centered between the **map's right edge and the right edge**. | aspect | interpolate |
| L5 | **Map centered vertically** | map centered between the header row (content top) and the main-dial top. | aspect | interpolate |
| L6 | **Explicit outer dials** | **radius = `k·mainR`** (k ≈ 0.165); placed at a **rim-gap = `gapFrac·mainR`** (gapFrac ≈ 0.04, *proportional* — constant % of the dial at every size) along each committed corner angle; **fit-clamp** shrinks the radius if clamping to the band/edges would push it into the rim; top dials are the bottom dials **mirrored** across the main center (one radius + gap for all four; eclipse footprint = `extR`). Replaces the committed corner-solver's hidden shrink-to-fit (single explicit source). | aspect | interpolate |
| L7 | **Moon-proximity cap (L6)** | when the top-left dial (alt) would sit closer to the **moon** than to the main dial, pull all four dials inward (same size) until alt's moon-gap = its main-gap. Size-triggered; dormant once the proportional gap (L6) already clears the moon. | aspect | interpolate (fires by size) |
| L8 | **Display centered vertically** | the whole non-chrome cluster (band + dials) is centered vertically between the header and footer (fixes the dial touching the footer at wider/taller variations). | aspect | interpolate |

**Chrome:** same as A2 (C1 header, C2 single-row footer + center noon icon).

**Implementation note:** like A2, production must pin the one-band arrangement for this anchor (harness uses the exported `portraitOneBand`) rather than letting the width-triggered selector flip it; and the outer-dial sizing (L6/L7) is now an **explicit rule**, not the committed `portraitCornerDials` shrink-to-fit.

### A3m — iPad mini portrait (aspect 0.683) ✅
*Safe rect (iPad mini 744×1133 − insets 24/20); canonical 744×1089.*

The mini's narrower aspect gets its **own anchor**. It **inherits all of A3's rules**, plus:

| # | Rule | Value / detail | Driver | Transition |
|---|---|---|---|---|
| M1 | **Map expanded** | map width ×**1.10**, centered horizontally (moon re-centers left per A3-L3, date per A3-L4). | aspect | interpolate (×1.0 at A3 → ×1.10 at A3m) |
| M2 | **Date −5 %** | date box shrunk 5 % (smaller font) to compensate for the wider map. | aspect | interpolate |

The **A3 ↔ A3m** map-expansion and date-shrink interpolate across aspect (≈0.725 → 0.683) — a transition (§7).

### A4 — iPad landscape (aspect 1.45) ✅
*Safe rect = reciprocal of A3; canonical ~1710×1180. Variations: 1.333 (13"), 1.523 (mini).*

A4 is the **landscape arrangement** and the committed `computeLayout` is **already close**: moon top-left, map top-right, the large main dial centered, the date in `split` mode (weekday bottom-left, month-day/year+tz bottom-right), and the four outer dials in the left & right columns flanking the main dial. We keep all of that and add a single explicit rule for the outer dials.

| # | Rule | Value / detail | Driver | Transition |
|---|---|---|---|---|
| L1 | **Symmetric outer dials** | Make the four outer dials read as a symmetric frame. In the **left column**, space **alt** (upper) and **az** (lower) **evenly — equal gaps around the two dials** — in the vertical span between the **moon's bottom** and the **weekday's top**. Then give **ecl** = alt's y and **eot** = az's y (x already mirrored left/right by the committed solver, radius unchanged for all four). Replaces the committed corner-solver's per-column clamping, which left the left pair (clamped under the moon) and the right pair (clamped under the map) at different heights. | aspect | interpolate |

**Note:** because the map (top-right) sits higher/smaller than the moon (top-left), mirroring the y's leaves a **larger ecl↔map gap** than the alt↔moon gap. That asymmetry of *gaps* is accepted in exchange for the dials themselves being top/bottom symmetric — the eye reads the four-dial frame, not the background gaps.

**Chrome:** same as A2/A3 (C1 header, C2 single-row footer + center noon icon).

### A5 — iPhone landscape (aspect 1.99) ✅
*Safe rect 814×409 (iPhone 932×430 − insets 0/59/21/59); ≈ reciprocal of A2. Samples (same aspect): 700×352 · 814×409 · 1000×503.*

A5 is the **short-and-wide landscape**. The committed corner layout doesn't suit it, so A5 is **almost entirely computed from a single spacing unit** — `halfPad = 0.0125·W` (half the portrait side-margin) — leaving **no tuning knobs**. The arrangement, left→right: **moon · {alt, az} · main dial · {ecl, eot} · map** across the top, with **weekday** bottom-left and a **condensed single-line date** bottom-right.

Everything below is in the **content rect** but the **main dial is centred in the full safe rect** (it overlaps the chrome).

| # | Rule | Value / detail | Driver | Transition |
|---|---|---|---|---|
| L1 | **Main dial overlaps chrome** | `D = 0.95·H` (H = full safe height), centred vertically in the **full safe rect**, so it overlaps both the header and footer bands with **`0.025·H` padding** top & bottom — numerically the same fraction as portrait's `0.025·W` horizontal padding. The inner sub-dial cluster scales/moves with it. | aspect | interpolate (the 0.95 fraction is shared with portrait L2) |
| L2 | **Noon icon off-centre** | The footer's centred noon-toggle icon moves **left** (near the time-controller button), since the dial now covers the footer centre. | aspect | snap |
| L3 | **Halved margins** | The outer dials' outer margins **and the map's right margin** are **`halfPad`** (half the normal side margin). The moon & map tops sit **`halfPad` below the header's bottom edge** (same gap as the map's right margin). | aspect | interpolate |
| L4 | **Map auto-sized** | Map (top-right, ~2:1) **grows until its lower-left corner's radial gap** (along the line to the main centre) **to the main rim = `halfPad`**. | size | computed |
| L5 | **Outer-dial radius (solved)** | One radius `r` for all four, the **largest** for which the three right-side gaps all equal `halfPad`: **eot's outer margin**, the **eot↔ecl gap**, and the **ecl↔main gap measured radially** (centre-to-centre line, ecl→main). alt/az **reuse** `r`. | size | computed |
| L6 | **Dials on one row per side, independent Y** | All four share their side's row. **alt/az** centre vertically in **moon-bottom ↔ date-top**; **ecl/eot** centre in **map-bottom ↔ date-top** — *separate* y's, so a bigger moon drops only the left pair (the right would look unbalanced against the space under the smaller map). Horizontally: **alt**'s outer edge at the `halfPad` margin, **az** splits the span to the main rim into two equal gaps (mirror on the right: **eot** at the margin, **ecl** splits). | size | computed |
| L7 | **Moon auto-sized** | Moon **grows until the smaller** of four gaps reaches `halfPad`: (1) its **radial gap to alt/az** (equal for both, since it's centred over the pair), (2) the **alt/az-bottom ↔ weekday-top** gap, (3) the **left margin** (the moon's left edge must stay ≥ `halfPad` from the edge), and (4) its **radial gap to the main dial's rim**. Centred horizontally over the alt/az pair. *(Normally (2) binds. (3)/(4) are guards that bite when the chrome is dropped — see CC2 — and the vertical space balloons; without them the enlarged moon spills past the left edge or into the dial. In practice (3) binds before (4).)* | size | computed |
| L8 | **Date dropped to the footer** | Weekday (bottom-left) + the condensed date line (bottom-right) drop to a **shared baseline** placed so the **deepest weekday descender** sits `halfPad` above the footer top. The descender depth is the **max over all of Sun–Sat** (every name ends in "-day" → the `y` descender, but the max is taken so it never shifts with the day). | aspect | interpolate |
| L9 | **Condensed date, weekday-matched** | Block 2 is one line **"month-day  year  tz"** — **same per-element font sizes as the stacked A4** (month-day big, year medium, tz/leap faint small), **no `·` separators** — rendered at the **weekday's unit and baseline** so "Jun 18" matches "Thursday" in size and sits on the same baseline. Segments are **baseline-aligned** (a `dateSegCenter` option can centre them instead; baseline preferred). | aspect | interpolate |

**Chrome:** same as A2/A3/A4 (C1 header, C2 single-row footer), except the noon icon is left-shifted (L2). **Exception:** the short **700×352** sample falls below the chrome-drop height (CC2: H < 368), so it drops header+footer and the moon clamps to the left margin (L7 guards) — the canonical 814×409 and large 1000×503 keep chrome.

**Implementation notes:** the shared `condensedDateLayout(ctx, weekday, boxW, boxH, descenderBottomY)` (in `date-view.ts`) returns `{u, baselineY, top}` and is the **single source** used by both the renderer (to draw) and the layout (to place the dials), so dial geometry and rendered text agree. `drawBlock` gained `forceU`/`baselineY`/`segCenter` and returns `{u, baselineY}`. New `LayoutParams`: `dateCondensed`, `dateSegCenter`, `dateBaselineBottom`.

### A6 — Extreme landscape (aspect 10.0) ✅
*Samples: 1000×100 · 1200×120 · 1600×160 (aspect 10).*

A6 is the **degenerate landscape**: a tall-and-thin sliver of content where the time controller can't usefully open. So the chrome is dropped (CC2) and **all elements** lay out in **one row**, vertically centred. The **main dial** fills the full row height; the **outer circles are smaller** (a tunable fraction of the main dial). With the outer dials sized down, the row generally **fits with real gaps** (gap rule, L3); if it still overflows, gaps collapse and overlap is accepted as a graceful degradation.

| # | Rule | Value / detail | Drives |
|---|---|---|---|
| CC2 | **Chrome-drop (cross-cutting)** | Drop **both** header and footer when the **time controller's default-config popover can't fit on screen**. "Default config" = the popover open on the **Date** tab, astro tab collapsed; its measured footprint is **200 × 368** (`tp-lower` min-width drives W; `tp-upper`+`tp-lower` stacked drive H — see `src/partials/time-controller.{css,html}`). Rule: `dropChrome = (W < 200) ‖ (H < 368)`. Bites at extreme aspects: A6 by height (H ≤ 160 < 368, always drops), A1 by width (W < 200). **Note:** this also drops chrome on A5's short sample (700×352, H<368) — an accepted reclassification (that sample becomes A6-like). | viewport W·H |
| L1 | **One row, all elements** | Left→right: **moon · weekday · alt · az · DIAL · ecl · eot · date · map**, vertically centred in the (full, chrome-dropped) height. | — |
| L2 | **Element sizing (two tunable ratios)** | The **main dial** ⌀ = **row height** (fills the height). The **five outer circles** (moon = alt = az = ecl = eot, all equal) are ⌀ = **`dialK · main-⌀`** — a tunable ratio `dialK` (harness slider, default **0.65**), so they're smaller than the dial. The map ≈ 2:1 (2·height wide). Weekday + condensed date are at unit **`u = fontK · (outer-dial ⌀)`** — a second tunable ratio `fontK` (default **0.35**), proportional and **uncapped** (`UNIT_MAX` does **not** apply), tracking the outer-dial size at every sample; 2026/PDT stay relative to `u`. *(Resolves the old "all circles equal" open decision — outer dials are now smaller than the main dial, which also frees horizontal space.)* | size |
| L3 | **Gap distribution (no element shrink)** | The element widths are fixed (L2); only the horizontal spacing flexes. Target: a **`halfPad`** margin on each outside edge and **`halfPad`** between every adjacent pair (8 inner gaps). **Surplus** (elements + gaps narrower than W — the usual case with the smaller outer dials): keep the outer margins at `halfPad` and **expand the 8 inner gaps evenly** to fill. **Deficit:** **first shrink the two outer margins to 0**, then **shrink the 8 inner gaps evenly** (below `halfPad`, into **overlap** when nothing's left). Continuous across the transition. **No element is scaled** by the gap rule — overflow is taken by the gaps, not the elements. | size |

**Date:** reuses `dateCondensed` (single-line "month-day · year · tz", A4 segment sizes, dots dropped) via the A6 path in `date-view.ts` — weekday and date are each ink-centred in their own box at `dateForceU = u`, **not** dropped to a footer (there is none).

**Implementation:** `applyA6` in the harness; the split/`dateCondensed` path in `date-view.ts`. CC2 lives in the harness `draw()` and is **cross-cutting** (also governs A1).

*Verified (harness, `?v=13`): A6 canon 1200×120 with defaults (dialK=0.65, fontK=0.35) → chrome dropped, main dial ⌀=120, outer circles ⌀=78, font `u`≈27 — row **fits with real gaps** (surplus: outer margins=halfPad, inner gaps expand evenly), matching the earlier look (main dial larger than the equal, smaller outer dials). Gap-rule regimes (when forced into deficit by larger dials/font) still verified: outer margins consume to 0 first, then inner gaps shrink into overlap. Chrome-drop boundary: 700×352 drops, 814×409 & 1000×503 keep, 150-wide drops.*

### A1 — Extreme portrait (aspect 0.10)
*Not started.*

---

## 7. Transitions (filled in after all anchors)

| Transition | From → To | Blend rule | Notes |
|---|---|---|---|
| T1 | A1 ↔ A2 | TBD | monthDay-cap date raise fades in here (A2-L7) |
| T2 | A2 ↔ A3m | TBD | governs iPhone SE (0.562); the two-band↔one-band change is a **snap** decision, not a size threshold |
| Tm | A3m ↔ A3 | map ×1.10→1.0, date −5%→0% across aspect 0.683→0.725 | iPad mini → 11"; interpolate the A3m deltas (M1/M2) |
| T3 | A3 ↔ A4 | TBD | portrait/landscape flip near square |
| T4 | A4 ↔ A5 | TBD | iPad→iPhone landscape: A4's two-column split + two-line date condenses to A5's one-row-per-side + single-line date as the rect shortens |
| T5 | A5 ↔ A6 | TBD | landscape gets so wide everything collapses to a single row (A6) |

---

## 8. Open questions

- A1/A6 canonical pixel sizes and sample sizes (TBD once we see the degenerate
  layouts).
- ~~Whether A3's canonical should be 0.69 or 0.75~~ → **resolved:** A3 = 0.725
  (iPad 11"), with A3m (0.683) split off as its own anchor and 13" (0.775) a
  wider sample.
- **"Size effects are small" hypothesis — partly false, and that's fine.** A3's
  outer-dial ratio drifts with size under the committed shrink (0.140→0.165), so
  we made it an **explicit proportional rule** instead (A3-L6). The lesson: where
  size effects appear, replace the implicit committed behavior with an explicit
  rule rather than hoping they're negligible.
- The dial-content (real dials with live values) isn't in the harness — some
  size choices (A3-L6 `k`, A2-L3 grow) are "looks right as outlines" and may need
  a pass once real content is in place.
