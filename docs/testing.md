# Testing

The project uses [Vitest](https://vitest.dev/) for all testing. Tests are organized into three categories: unit tests, regression (snapshot) tests, and astronomical boundary tests.

## Quick Reference

```bash
# Run all tests (unit + regression + astro boundary)
npm test

# Run only regression tests
npm run test:regression

# Regenerate golden snapshot baselines
# NEVER NEVER NEVER run this command unless the user expressly asks you to.
npm run test:capture

# Watch mode (re-run on file changes)
npm run test:watch
```

## Test Categories

### 1. Unit Tests

Located in `src/__tests__/` and `src/watch/__tests__/` and `src/astronomy/__tests__/`.

These test individual modules in isolation:
- **XML parser** (`xml-parser.test.ts`) — Part taxonomy, attribute parsing, expression AST construction
- **DST detection** (`dst-detect.test.ts`) — Timezone offset and DST transition logic
- **Astronomy core** (`es-astro.test.ts`) — Time conversion, sidereal time, coordinates, rise/set, moon age
- **Willmann-Bell** (`willmann-bell.test.ts`) — Planetary position calculations

### 2. Regression Tests (Snapshot-Based)

Located in `src/__tests__/regression/`. One thin test file per face (14 total).

These capture the **computed values** of every dynamic part on every watch face across a matrix of times, locations, and interaction modes. Instead of comparing screenshots, they compare the numeric state of every hand/wheel/wedge (angle, offsetAngle, xMotion, yMotion, animation flags).

#### Architecture

```
src/__tests__/
├── face-registry.ts      # Face → XML path mapping, test locations
├── scenarios.ts           # 182 scenario definitions (types A–F)
├── snapshot-utils.ts      # Golden file I/O with Infinity/NaN handling
├── test-bench.ts          # TestBench class + runFaceRegressionSuite()
├── regression/
│   ├── babylon.test.ts    # Per-face test files (14 total)
│   ├── basel.test.ts
│   ├── ...
│   └── vienna.test.ts
└── snapshots/             # Golden JSON files (gitignored, ~246MB)
    ├── babylon-cupertino.snap.json
    ├── babylon-arctic.snap.json
    └── ...                # 42 files total (14 faces × 3 locations)
```

#### How It Works

1. **`TestBench`** wraps `TimeController` + `createWatchEnvironment` + `buildHandValues` + `updater.tick` for headless execution in Node.js — no Canvas or DOM required. It mirrors the engine's animation path (overridable getNow seam + `beatsPerSecond` quantization) and builds the Updater in **lightweight** mode (skips day/night wedges, terminator leaves, and the analemma — none are snapshotted; the analemma needs `OffscreenCanvas`, absent in Node). Goldens capture each dynamic part's `_obs*` values.

2. **Scenarios** define sequences of actions (set time, step, scrub, play/pause) with capture checkpoints. Six scenario types cover all interaction modes:

   | Type | Description | Checkpoints per time |
   |------|-------------|---------------------|
   | A. Idle | Set time, tick, capture | 1 |
   | B. Step Forward | Post-step, mid-animation, settled | 3 per unit |
   | C. Step Backward | Same as B, direction = −1 | 3 per unit |
   | D. Scrub Forward | tick1, tick2, tick3, released | 4 per unit |
   | E. Scrub Backward | Same as D, direction = −1 | 4 per unit |
   | F. Play/Pause/Reverse | play-fwd, pause, resume, reverse, final | 5 |

3. **Golden files** are JSON snapshots of all part values at each checkpoint. On first run, generate baselines with `npm run test:capture`. Subsequent runs compare against these baselines. If tests fail, NEVER NEVER NEVER run this capture command unless the user expressly asks you to.

4. **Numeric tolerance**: 1e-9 for floating-point comparisons; strict equality for booleans and animation flags.

#### Test Locations

| Location | Latitude | Longitude | Timezone | Purpose |
|----------|----------|-----------|----------|---------|
| Cupertino | 37.3°N | 122.0°W | America/Los_Angeles | Mid-latitude baseline |
| Arctic | 85.0°N | 21.0°E | Europe/Oslo | Midnight sun / polar night |
| Equator | 5.0°S | 36.8°E | Africa/Dar_es_Salaam | Minimal seasonal variation |

#### Reference Times

1. `2025-06-15T12:00:00Z` — Summer solstice, daytime
2. `2025-06-15T00:00:00Z` — Same day, midnight
3. `2025-12-21T18:00:00Z` — Winter solstice, afternoon
4. `2025-01-01T00:00:00Z` — New Year midnight
5. `2025-03-09T10:00:00Z` — Near US DST spring-forward
6. `2024-02-29T06:00:00Z` — Leap day
7. `2000-01-01T12:00:00Z` — J2000 epoch

#### Metrics

| Metric | Value |
|--------|-------|
| Test files | 22 |
| Total vitest tests | 8,472 |
| Individual field assertions | ~5.1 million |
| Capture/verify time | ~38 seconds |
| Golden file storage | ~246MB (gitignored) |

#### When to Regenerate Baselines

Run `npm run test:capture` after:
- Changing any expression evaluation logic
- Modifying animation timing or interpolation
- Updating astronomical calculations
- Changing the environment variable computation
- Adding/removing parts from an XML face definition

After regenerating, review the diff in the golden files (if tracked) or spot-check a few values to confirm the changes are intentional.

### 3. Astronomical Boundary Tests

Located in `src/__tests__/astro-boundary.test.ts`.

These validate the astronomical functions that feed into the hand scheduling system, using known astronomical events as ground truth rather than golden-file regression. They cover:

- **Rise/set computation** (`planetaryRiseSetTimeRefined`) — Sunrise/sunset at known locations and dates, polar edge cases (midnight sun, polar night), equatorial day-length invariant
- **Transit computation** (`planettransitTimeRefined`) — Solar noon timing, consistency with `suntransitForDay`
- **Astro-stepper functions** (`findNextRiseSet`, `findNextTransit`, `findNextQuarterPhase`) — Direction handling, polar edge cases, moon phase stepping against known 2024 lunar calendar
- **Moon phase refinement** (`refineMoonAgeTargetForDate`, `closestQuarterPhaseTime`) — Iterative convergence to exact phase angles
- **Dispatcher** (`computeAstroTarget`) — Correct routing for all event types
- **Ordering invariants** — `sunrise < transit < sunset` at multiple locations
- **Direction symmetry** — Forward-then-backward round-trip consistency

## Key Design Decisions

### Why snapshot-based testing instead of screenshots?

1. **Speed**: 7,644 tests in ~38 seconds vs. minutes for screenshot rendering
2. **Precision**: Captures exact numeric values, not pixel approximations
3. **Debuggability**: Failed assertions show exactly which part, which field, and by how much
4. **No browser dependency**: Runs in Node.js with no Canvas/DOM mocking needed

### Why mock `performance.now()`?

Two call sites in production code call `performance.now()` directly rather than accepting it as a parameter:
- `displayTimeToPerfNow()` in `animation.ts` (line ~819)
- `expandTerminatorToLeaves()` in `terminator.ts` (line ~292)

The `TestBench` mocks `performance.now()` via `vi.spyOn` to make these deterministic.

### Why simulate play instead of using `TimeController` 1× mode?

`TimeController`'s 1×/−1× mode computes display time from `Date.now()`, which is non-deterministic. The `TestBench` simulates play by keeping the clock stopped and manually advancing display time in `advanceRealTime()`, giving fully deterministic snapshots.

### Why gitignore the golden files?

At ~246MB total, the golden JSON files are too large for git. They are regenerated locally with `npm run test:capture` (~38 seconds). The test code and scenario definitions *are* committed — only the baselines are ephemeral.
