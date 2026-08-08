# Drag Magnifier: Touch Sizing & Finger Clearance

**Status**: IMPLEMENTED 2026-08-08 (build 2.0.80) — pending device tuning of
MAG_BAND_FRAC (0.30) and MAG_GAP_TOUCH (44). (Rev 2: size cap universal, label
scaling by area included.)
**Created**: 2026-08-08
**Baseline**: c29f1a7 "Custom magnifier first pass (too big on phone)" — shippable on
desktop *at 4K monitor size*; that case must not change.

## Problem (phone)

Two compounding issues on touch devices:

1. **Too big.** `d = min(MAG_MAX_DIAM=140, bh − 2·MAG_EDGE)`. The phone layout's
   band is short, so the height term binds: the bubble is the full band height,
   which on a narrow band is also ~half the band *width*.
2. **Finger occlusion.** `MAG_GAP = 16` CSS px between the drag point and the
   bubble edge. A fingertip pad covers far more than 16 px, so the near (left,
   when the bubble is on the right) part of the bubble is hidden under the finger.

## Approach

Sizing and label density scale with the band/bubble on every input type; only
the finger-clearance gap is touch-specific. Detect input *per drag*, not per
device (hybrids: iPad + trackpad, touch laptops).

### 1. Plumb pointer type (one choke point) — needed only for the gap (#3)

Both drag entries call `startDragAt(ev, x, y)` (observatory-entry.ts:1004, 1024),
which already receives the `PointerEvent` and calls `resetDragMagnifier(lat, lon)`.
Add a parameter: `resetDragMagnifier(lat, lon, ev.pointerType === 'touch')` →
module flag `magTouch` in earth-view.ts.

### 2. Size cap (band-width-relative, ALL input types)

```
const MAG_BAND_FRAC = 0.30;   // tune (desktop window resize makes this easy)
d = min(MAG_MAX_DIAM, bh − 2·MAG_EDGE, MAG_BAND_FRAC · bw)
```

A width-relative cap fixes both symptoms at once (≤30% of width can't be "half
the width", and on short-wide bands it also pulls the bubble under full height).
Unconditional by design: with MAG_MAX_DIAM = 140 the width term only binds when
bw < 140/0.30 ≈ 467 CSS px, so large-window/4K desktop keeps today's exact size
by construction; small windows and phones shrink. Keep the existing `d < 40`
degenerate bail. A8 (bubble fully in-band) unchanged.

### 3. Touch finger clearance

```
const MAG_GAP_TOUCH = 44;   // vs 16 for mouse; tune on device
```

~44 px matches the scale of iOS's own loupe offset. The existing side-flip +
clamp logic already accounts for the gap when deciding fit, so flips/clamping
need no changes — a bigger gap just participates. This is the "move it right"
ask: bubble sits clear of the finger pad on whichever side it occupies (the
occlusion problem is mirrored when the bubble is left of the finger).

### 4. Label count scales with bubble AREA (included, not optional)

Each label consumes roughly constant screen area (10 px text + the 26 px
MAG_LABEL_SEP separation radius), so the count that fits without crowding is
proportional to bubble area, i.e. d². Anchor to today's tuning — 6 labels at
the 140 px max diameter:

```
maxLabels = max(1, round(MAG_MAX_LABELS · (d / MAG_MAX_DIAM)²))
```

→ 6 at 140 px (unchanged at 4K), 3 at ~100 px (phone), 2 at ~87 px (small
desktop window). Floor of 1 keeps an orientation cue in even the smallest
bubble. Also drives the citiesInWindow candidate limit (currently
MAG_MAX_LABELS · 2). Knobs if device testing disagrees: the anchor count and
the floor — the area model itself stays.

## Explicitly not changing

- `MAG_SPAN_DEG = 10` stays (recently tuned). Revisit only if the smaller
  bubble reads too coarse — a touch-only span of 8° would be the knob.
- Placement/side-flip logic, A8 hard constraint, lerp smoothing.
- Large-window desktop appearance (cap and label formula are anchored to be
  no-ops at d = 140).

## Testing

- Constants grouped at the top of earth-view.ts for quick iteration.
- MAG_BAND_FRAC and the label formula are tunable on desktop by resizing the
  window below ~467 px band width — no phone round-trip needed for those.
- Device test via dist.zip on the phone for MAG_GAP_TOUCH (real finger
  occlusion can't be simulated in the pane).
- Desktop sanity check: large-window mouse drag renders identically to c29f1a7.
