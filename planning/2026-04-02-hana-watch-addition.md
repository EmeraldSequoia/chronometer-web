# Adding the Hana I ("Hana") Watch

## Goal

Add Hana I as a second watch face displayed alongside Haleakala in the grid. This requires three major enhancements:
1. **Multi-watch grid** — two watches visible side-by-side
2. **Terminator part rendering** — the moon phase "leaf" display used by Hana
3. **Moon astronomy end-to-end testing** — validating `moonRelativePositionAngle`, moonrise/set, and `moonAgeAngle`

## Background

Hana I is derived from Haleakala I (same compass/altitude structure) but replaces the **Sun** sub-dials with **Moon** sub-dials and adds a **terminator** display showing the current moon phase as a lit/dark orb. The existing multi-face architecture in `standalone.ts` already supports an array of `FaceInstance` objects and CSS grid layout, so adding a second face is mostly about:
- Copying the Hana XML into assets
- Making the XML parser actually parse `<terminator>` elements (currently skipped)
- Implementing the terminator leaf renderer (faithfully porting the iOS leaf system)
- Implementing `moonRelativePositionAngle()` (currently stubbed to `0`)

---

## Proposed Changes

### Asset Setup

#### [NEW] `src/watch/assets/hana/Hana-I-android.xml`
Copy from `.chronometer-ref/Watches/Builtin-Android/Hana I/Hana I.xml`.

---

### XML Parser + Type System

#### [MODIFY] [types.ts](file:///Users/spucci/chronometer-web/src/watch/types.ts)
- Add `TerminatorPart` interface to the `WatchPart` union:
  ```ts
  export interface TerminatorPart extends PartBase {
      type: 'Terminator';
      radius?: ASTNode;
      leavesPerQuadrant?: ASTNode;
      incremental?: ASTNode;
      leafBorderColor?: ASTNode;
      leafFillColor?: ASTNode;
      leafAnchorRadius?: ASTNode;
      update?: ASTNode;
      updateOffset?: ASTNode;
      phaseAngle?: ASTNode;       // expression: moonAgeAngle()
      rotation?: ASTNode;         // expression: moonRelativePositionAngle()
  }
  ```

#### [MODIFY] [xml-parser.ts](file:///Users/spucci/chronometer-web/src/watch/xml-parser.ts)
- Replace the `case 'terminator': // Skipped for now` with actual parsing into a `TerminatorPart`.

---

### Terminator Leaf System — Faithful Port

The iOS terminator is a key demonstration that a mechanical mechanism could approximate the correct moon phase display (vs. the two-circle approach used by most real watches, which implies an incorrect concave terminator near full moon). The leaves also animate individually when the phase changes, which matters for fast-forward modes (10x, 100x, 1000x speed).

#### How the iOS leaf system works

In iOS, `createTerminatorLeavesForRadius` expands a single `<terminator>` XML element into **`4 × leavesPerQuadrant`** individual animated hands. For Hana (`leavesPerQuadrant=6`), that's **24 leaf parts**. Each leaf:

1. **Is a separate `ECWatchHand`** with its own angle expression: `terminatorAngle(moonAgeAngle(), quad, index, leavesPerQuad, incremental)`
2. **Rotates around the terminator center** using `offsetRadius` and `offsetAngle` (upper leaves at `0`, lower at `π`, plus `moonRelativePositionAngle()` rotation)
3. **Draws a filled/stroked leaf shape** using inner and outer terminator arc points connected by a semicircular end cap

The `terminatorAngle` function (from `ECVirtualMachineOps.m:4778-4901`) determines how far each leaf has rotated based on the current moon phase. It handles four phase cycles (waxing crescent → waxing gibbous → waning gibbous → waning crescent) and uses left/right quadrant symmetry to reduce the math.

The `drawAtZoomFactor` method draws each leaf shape by:
1. Drawing the inner terminator arc from the anchor to past midpoint (30 steps)
2. Connecting with a semicircular end cap to the outer terminator arc
3. Drawing the outer terminator arc back to the anchor
4. Fill + stroke the path

#### Web implementation plan

##### [NEW] [terminator.ts](file:///Users/spucci/chronometer-web/src/watch/terminator.ts)
New module containing the terminator leaf system:

- **`terminatorAngle(phase, quadrant, indexWithinQuad, leavesPerQuad, incremental)`** — Direct port of `ECVirtualMachineOps.m:4778-4901`. This is a pure math function (no DOM/canvas dependencies). Also register this as a 5-argument function in the expression evaluator.
- **`expandTerminatorToLeaves(part: TerminatorPart, env: Environment): TerminatorLeafState[]`** — At parse/init time, expand a single `TerminatorPart` into 24 leaf state objects (4 quadrants × 6 per quadrant), each with its quadrant, index, and pre-built angle expression.
- **`drawTerminatorLeaf(ctx, leaf, env)`** — Port of `ECTerminatorLeaf.drawAtZoomFactor:`, draws one leaf shape using Canvas 2D paths. The key geometry:
  - `calculateTerminatorArcPoint(i, n, xsign, ysign, xcenter, ycenter, radius, phase)` — computes `(x, y)` for each arc step
  - Inner arc: 30 steps from anchor toward center
  - Semicircular end cap connecting inner to outer arc
  - Outer arc: 30 steps back to anchor

##### [MODIFY] [renderer.ts](file:///Users/spucci/chronometer-web/src/watch/renderer.ts)
- Add `'Terminator'` to `drawDynamicParts` dispatch (leaves are dynamic, not static, since they animate)
- Each leaf is drawn at its computed angle, translated to the terminator center `(x, -y)`, then rotated by `terminatorAngle() + offsetAngle`

##### [MODIFY] [animation.ts](file:///Users/spucci/chronometer-web/src/watch/animation.ts)
- When initializing hand states, expand `TerminatorPart` into individual leaf hand states
- Each leaf gets its own `HandState` with an angle expression calling `terminatorAngle()`

##### [MODIFY] [evaluator.ts](file:///Users/spucci/chronometer-web/src/expr/evaluator.ts)
- Register `terminatorAngle` as a 5-argument function in `createDefaultEnvironment()` (or in `watch-env.ts`)

---

### Moon Astronomy: `moonRelativePositionAngle`

#### [MODIFY] [es-astro.ts](file:///Users/spucci/chronometer-web/src/astronomy/es-astro.ts)
- Add `moonRelativePositionAngle(dateInterval, observerLat, observerLon, cache)` function.
- Port the algorithm from `ECAstronomy.m:3153-3196`:
  1. Compute Sun RA/Decl (already available via `sunRAandDecl`)
  2. Compute Moon RA/Decl (already available via `moonRAAndDecl`)
  3. Compute `positionAngle(sunRA, sunDecl, moonRA, moonDecl)` — a simple `atan2` formula
  4. Adjust for waning phase (`moonAgeAngle > π` → flip by 180°)
  5. Compute Moon's hour angle, altitude, azimuth
  6. Compute `northAngleForObject` (great circle course to celestial north pole)
  7. Final angle = `-northAngle - posAngle - π/2`, normalized to [0, 2π)

- Add helper functions:
  - `positionAngle(sunRA, sunDecl, objRA, objDecl)` — 2-line `atan2`
  - `northAngleForObject(altitude, azimuth, observerLatitude)` — wraps `greatCircleCourse`
  - `greatCircleCourse(lat1, lon1, lat2, lon2)` — 2-line `atan2`

#### [MODIFY] [watch-env.ts](file:///Users/spucci/chronometer-web/src/watch/watch-env.ts)
- Replace `functions.set('moonRelativePositionAngle', () => 0)` stub with a live implementation calling the new `moonRelativePositionAngle` from `es-astro.ts`.

---

### Standalone Entry Point

#### [MODIFY] [standalone.ts](file:///Users/spucci/chronometer-web/src/standalone.ts)
- Import Hana XML: `import hanaXML from './watch/assets/hana/Hana-I-android.xml';`
- Add to `FACE_XMLS`: `const FACE_XMLS: string[] = [haleakalaXML, hanaXML];`

---

## Verification Plan

### Automated Tests

**Existing tests** (`npm test`):
- `astronomy/__tests__/es-astro.test.ts` — covers sunAltitude, sunAzimuth, moonAltitude, moonAge, EOT, LST
- `astronomy/__tests__/willmann-bell.test.ts` — covers low-level planet position calculations
- `watch/__tests__/xml-parser.test.ts` — covers XML parsing
- `expr/__tests__/expr.test.ts` — covers expression evaluation

**New tests to add**:

1. **`astronomy/__tests__/es-astro.test.ts` additions** — Moon astronomy end-to-end:
   - `moonRelativePositionAngle` returns a value in [0, 2π) for a known date
   - `moonRelativePositionAngle` changes appreciably over 6 hours (verifies it's not stuck at 0)
   - `moonAge` at known full moon dates gives ≈π, at known new moon dates gives ≈0
   - Moonrise/moonset bracket lunar transit (similar to existing sunrise/sunset test)

2. **`watch/__tests__/xml-parser.test.ts` addition**:
   - Verify that parsing a `<terminator>` element produces a `TerminatorPart` with correct attributes

3. **`watch/__tests__/terminator.test.ts`** (new file) — Terminator leaf math:
   - `terminatorAngle` returns 0 for phase=0 (new moon, all leaves closed)
   - `terminatorAngle` returns appropriate park angle for phase=π (full moon, all leaves open)
   - Left/right quadrant symmetry: `angle(phase, UL) = angle(2π-phase, UR)` (with sign swap)
   - Phase continuity: angle changes smoothly as phase sweeps 0→2π

Run all automated tests:
```bash
cd /Users/spucci/chronometer-web && npm test
```

### Browser Verification

After implementing, build and open the standalone page:
```bash
cd /Users/spucci/chronometer-web && npm run build
open dist/index.html
```

Visual checks:
1. Two watches appear side-by-side in the grid
2. Haleakala renders identically to before (no regression)
3. Hana shows all the same dial elements as Haleakala (compass, ticks, date wheels)
4. Hana shows the terminator orb above center (at `y=termY=65`) with visible moon phase
5. Leaf shapes are visible — not circles-over-circles — demonstrating the mechanical approximation
6. Hana's moonrise/moonset sub-dial hands point to reasonable times
7. Hands animate correctly on both watches
