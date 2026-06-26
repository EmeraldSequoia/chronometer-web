# Terminator (Moon Phase Display)

The terminator system renders the moon's current phase as an illuminated orb using a mechanical-leaf approximation. Unlike the simpler two-circle approach used by most real watches (which implies an incorrect concave terminator near full moon), this system faithfully reproduces the correct terminator shape.

## iOS/Android Reference

> **Prerequisites**: Run `scripts/clone-refs.sh` to clone the reference repos. See [ios-reference.md](ios-reference.md).

| Repo | Key files |
|------|-----------|
| `.chronometer-ref/` | `Classes/ECGLWatch.m` → `createTerminatorLeavesForRadius` (leaf expansion), `Classes/ECTerminatorLeaf.m` (leaf drawing), `ECVirtualMachineOps.m` lines 4778–4901 (`terminatorAngle` function) |

## How It Works

### Leaf Expansion

A single `<terminator>` XML element is expanded at init time into **`4 × leavesPerQuadrant`** individual animated leaf parts. For Hana (`leavesPerQuadrant=6`), that's **24 leaves**.

The four quadrants are:
- **UL** (upper-left), **UR** (upper-right)
- **LL** (lower-left), **LR** (lower-right)

Each leaf is a separate animated element with its own:
- Angle expression: `terminatorAngle(moonAgeAngle(), quad, index, leavesPerQuad, incremental)`
- Offset position: `offsetRadius` and `offsetAngle` (upper leaves at `0`, lower at `π`, plus `moonRelativePositionAngle()` rotation)

### `terminatorAngle` Function

This is a direct port of `ECVirtualMachineOps.m:4778-4901`. It determines how far each leaf has rotated based on the current moon phase (from `moonAgeAngle()`).

The function handles four phase cycles:
1. Waxing crescent (0 → π/2)
2. Waxing gibbous (π/2 → π)
3. Waning gibbous (π → 3π/2)
4. Waning crescent (3π/2 → 2π)

Left/right quadrant symmetry reduces the math — left-side leaves mirror right-side behavior.

The function is registered as a 5-argument function in the expression evaluator.

### Leaf Drawing

Each leaf is drawn as a filled and stroked path using Canvas 2D:

1. **Inner terminator arc**: 30 steps from anchor toward center, using `calculateTerminatorArcPoint(i, n, xsign, ysign, xcenter, ycenter, radius, phase)`
2. **Semicircular end cap**: Connects inner arc to outer arc
3. **Outer terminator arc**: 30 steps back to anchor
4. Fill + stroke the closed path

### XML Attributes

| Attribute | Purpose |
|-----------|---------|
| `radius` | Radius of the terminator orb |
| `leavesPerQuadrant` | Number of leaves per quadrant (typically 6) |
| `incremental` | Whether leaves open incrementally or all at once |
| `leafBorderColor` | Stroke color for leaf outlines |
| `leafFillColor` | Fill color for leaves |
| `leafAnchorRadius` | Radius of the anchor circle at leaf base |
| `update` | How often to re-evaluate phase angle |
| `phaseAngle` | Expression for moon phase (typically `moonAgeAngle()`) |
| `rotation` | Expression for orb rotation (typically `moonRelativePositionAngle()`) |

## Animation Behavior

Terminator leaves are **dynamic parts** — they animate individually when the phase changes. This matters for fast-forward modes where leaves visibly open and close.

Each terminator leaf is now an ObsValue on the face's `Updater` (a per-leaf `angle`, composed from the shared `phaseAngle` expression via the `terminatorLeafAngle(...)` env function, plus one shared `rotation`), built by `buildTerminatorValues` in `hand-values.ts`. They reset/finish together with everything else via `face.updater.reset()` / `face.updater.finish()` — there is no separate `resetLeafSchedules()` (see [Development Rules §6](development-rules.md#6-animation-schedule-reset-rules)). The renderer reads `leaf._obsAngle` / `leaf._obsRotation`.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/watch/terminator.ts` | `terminatorAngle()`, `expandTerminatorToLeaves()`, `drawTerminatorLeaf()` |
| `src/watch/renderer.ts` | Terminator dispatch in dynamic drawing loop |
| `src/shared/animation.ts` | Leaf hand state initialization and ticking |
| `src/watch/watch-env.ts` | `terminatorAngle` function registration |

## Related Docs

- [Astronomy](astronomy.md) — `moonAgeAngle` and `moonRelativePositionAngle` implementations
- [Animation](animation.md) — How leaf animations are scheduled and compressed during scrubbing
