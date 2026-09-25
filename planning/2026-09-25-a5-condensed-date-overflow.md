# A5 condensed date line overflows the right edge

Status: APPROVED 2026-09-25 (parts 1 + 2, centring kept) and implemented the
same day — see "As built" and "Browser independence" at the end.

## Report

Safari, 1728×970, anchor A5 (mainR 460.8): on 25 Sep 2026 BCE the bottom-right
line `Sep 25  2026 BCE  Julian LMT` runs off the right side of the display —
only part of the "LMT" is visible. Worse on a BCE leap year such as 1401 BCE,
where the small text has to hold `Julian LMT leap`. Pre-existing: the same
line used to carry `GMT-10:31:26`, which is wider than `Julian LMT`.

## What the code does today

A5 (`applyA5`, `src/observatory/anchor-layout.ts:375`) draws the date as two
blocks on a shared baseline (`date-view.ts` split/condensed branch, l.426):

1. The weekday is fitted to its box (`condensedDateLayout`: `fitUnit` of the
   weekday text into `dateW × dateH`) → the unit `u`; its baseline is placed so
   the deepest weekday descender sits `halfPad` above the footer.
2. The info line `[monthDay, year, Julian?, tz?, leap?]` is drawn **at that
   same forced unit** (`forceU: dl.u`, `baselineY`), centred on `date2CX`.
   Nothing checks its width against anything.

Both boxes come from the landscape split template in `layout.ts`
(`computeBaseLayout`, l.740–760): `d2W = W − g − (xR + extR + g)`, i.e. the
column to the right of the ext dials, `d2H = clamp(0.16·H, 40, 170)`. `applyA5`
then rescales the main dial (`mainR = 0.475·H`) and moves the ecl/eot dials up
beside the map — but leaves the date boxes where the template put them, so
`date2W` is the template's guess, not A5's free width.

Reproduced headless at 1728×970 (Honolulu; the Julian dates the seeds landed
on, `Oct 12 2026 BCE` and `Oct 7 1401 BCE`, are a digit narrower than Steve's
`Sep 25`):

| line                                  | drawn extent (px) | box (px)      | right margin |
|---------------------------------------|-------------------|---------------|--------------|
| `Oct 12  2026 BCE  Julian LMT`        | 1268 → 1703       | ≈1264 → 1706  | 1706         |
| `Oct 7  1401 BCE  Julian LMT leap`    | 1272 → 1703       | ≈1264 → 1706  | 1706         |
| free span to the dial rim at that height | ≈1231 → 1706   | (unused ≈35–70 px on the left) | |

Both lines fill the box to within a few px. "Sep" is ≈16 px wider than "Oct"
at this unit, so Steve's `Sep 25  2026 BCE  Julian LMT` is ≈5 px past the
margin in Chrome and further in Safari (whose footer/button metrics give a
slightly different `bounds.bottom`, hence box heights and `u`), and the leap
variant is ≈25 px past — clipped by the window edge.

## Fix (two parts, both small)

### 1. Guarantee at render time: a forced unit never overflows its box

`drawBlock` (`date-view.ts:255`), when `opts.forceU` is given: cap the unit so
the widest live line fits the box —

```
u = forceU != null ? Math.min(forceU, REF * boxW / maxW) : fitted
```

One line. Effects: the A5 info line shrinks uniformly, only when it would not
fit, keeping the shared baseline (pinned) and the weekday's size (the weekday
is fitted to its own box already, so the cap is a no-op there); A6's forced
line (`dateForceU`, box = the layout-time line width + 4) gets the same
guarantee after a scrub to longer strings; A1's forced stack is sized from its
own ink and never triggers. Awide/Asq already auto-fit (no `forceU`).

Cost: in the overflow regime the info line's size follows the string, so
`Sep 25 …` can render a few % smaller than `Oct 7 …`. Only there; elsewhere
nothing changes.

### 2. A5 sizes its date boxes from its own geometry

In `applyA5`, after the dial rescale: the info box spans from the main dial's
rim at the line's height plus `halfPad` to the right margin `W − halfPad`
(mirror for the weekday box on the left). Rim x at height y:
`mainCX + sqrt(mainR² − (y − mainCY)²)`, evaluated at the ink top of the line
(the tallest point is the month/day; `condensedDateLayout` gives the baseline
and ascent). Set `L.date2CX/date2W` (and `dateCX/dateW`) from that span and
keep centring the text in it (no alignment change to the look Steve tuned).

Effect at 1728×970: the info box grows from ≈442 px to ≈475 px, which fits
`Sep 25  2026 BCE  Julian LMT` (≈451) at the weekday's unit outright; the
leap variant (≈490) still needs part 1's cap, by ≈3%. Wider windows have more
slack; narrower ones (a real iPhone landscape, where A5 is designed) lean on
part 1.

Not proposed: right-aligning the line to the margin (would use the span the
same way once the box is honest, but changes how the corner reads); dropping
or abbreviating "leap"/"Julian" in tight cases (variable labels); a second
line for the qualifiers (A5 is the one-line variant by design, and the
baseline rule leaves no room below).

## Steps

1. `date-view.ts` `drawBlock`: the forced-unit cap (part 1) + a unit test with
   a fake canvas context (`measureText` proportional to length) that draws the
   A5 branch with a narrow `date2W` and asserts every `fillText` x-extent stays
   inside the box, for the longest strings `extractDateFields` produces at
   Honolulu on 25 Sep 1401 BCE.
2. `anchor-layout.ts` `applyA5`: the rim-based boxes (part 2). Confirm the
   layout harness/goldens for A5 (if any) still pass; the weekday box change
   must not alter the weekday's unit at the recorded anchors (it is height-
   bound there — verify by logging `u` before/after at 1728×970, 844×390).
3. Headless shots at 1728×970 and 844×390, Honolulu, for 25 Sep 2026 BCE,
   25 Sep 1401 BCE, 22 May 1500 and today; before/after. Then Steve's Safari
   check at the reported viewport.
4. `docs/observatory.md` § Date Display: the cap rule and A5's box rule.

## Decisions for Steve

1. Part 1 alone (never overflows, occasional few-% shrink) vs. parts 1 + 2
   (recommended: 2 removes the shrink at desktop widths, 1 guarantees the rest).
2. Keep centring in the box (recommended) or hug the corners (weekday flush
   left, date flush right).

## Browser independence (Steve's flag, 2026-09-25)

Steve flagged the plan's line "further in Safari, whose footer/button metrics
give a slightly different `bounds.bottom`": the development rule
(docs/development-rules.md § 9) is that drawn text renders the same in every
browser. Verified, and the remark was wrong:

- The date view draws with `textBaseline = 'alphabetic'` and places by
  `measureText` metrics (advance widths, `actualBoundingBox*`), in
  `Arial, sans-serif` — rule 9's method. The layout's chrome inputs are
  constants (`HEADER_H = 48`, `FOOTER_H = 32`; `#time-bar` and the location
  group are pinned to `--obs-footer-h`, so `measuredFooterH()` is 32 in every
  browser on one line).
- Playwright's WebKit (Safari's engine on this Mac's CoreText) and Google
  Chrome, same built page, same seeded state, 1728×970 at DPR 2, Julian
  25 Sep 2026 BCE: every `measureText` width identical to three decimals
  (`Sep 25`@72 228.199, `2026 BCE`@30.24 137.852, `Julian`@15.12 39.505,
  `LMT` 30.24, `leap` 28.586; assembled line 476.87 / 510.75 with leap);
  the drawn line's ink 1272.0→1727.5 (Chrome) vs 1271.5→1727.5 (WebKit);
  whole-frame diff 0.5 % of pixels beyond 40 levels (glyph antialiasing),
  mean 0.85 levels. Both clip "LMT" to "LM" — Steve's screen exactly.
- DPR 1 vs 2 in headless Chrome: identical CSS-px extents (1264.5→1711.5).
- What differed in the plan's first repro was the *viewport*: headless
  Chrome's `--window-size=1728,970` gave a shorter content height than a
  real 970-px viewport, hence a smaller dial (`mainR = 0.475·H`) and a box
  further left. With the real geometry (mainR 460.8, Steve's log) the line
  is centred ≈1510 in a box ≈1305→1715, 477 px wide for `Sep 25  2026 BCE
  Julian LMT` → 21 px clipped; 511 px with `leap`.

(Real Safari could not be driven: the AppleScript automation request timed
out — a permission prompt only Steve can answer. Playwright's WebKit uses
the same macOS text stack.)

## As built

- Part 1, refined: `drawBlock` treats the box as the placement and a new
  `spanMin`/`spanMax` (default: the box edges) as the hard limit. A block
  wider than its box is **pushed inside the span first** (right edge pinned
  at the margin, growing leftward), and only a block wider than the span is
  shrunk uniformly. A block that fits its box is drawn exactly as before —
  so no date that fits today moves; long lines slide left as far as needed;
  shrinking is the last resort. (The plan's "centre in the honest box"
  would have moved every corner date ≈75 px left at 1728 wide.)
- Part 2: `applyA5` sets `L.date2SpanMin` = the dial rim at the line's ink
  top + halfPad, `L.date2SpanMax = W − halfPad`; `shiftLayout` offsets them
  with the other x fields. At 1728×970 the span is ≈1162→1706 (544 px): the
  2026 BCE line (477) and the 1401 BCE leap line (511) both fit at the
  weekday's unit — no shrink at desktop widths. The weekday box is untouched.
- Test: `src/observatory/__tests__/date-view-overflow.test.ts` (fake canvas
  context): fits-the-box → unchanged centring; wider than the box → pushed
  to the span end at full size; wider than the span → uniform shrink; no
  span (A6-style) → the box is the limit.
