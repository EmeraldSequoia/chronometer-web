# Rules to Follow When Making Changes

This document collects critical invariants, rules, and pitfalls that must be observed when modifying the Chronometer Web codebase. Violating these rules tends to produce subtle bugs that are hard to diagnose.

## 1. Keep Documentation Up to Date

If you change anything that would invalidate a doc in this directory, update the doc at the same time. If you add something that should be covered by the docs but isn't, add that too. The docs should always reflect the current state of the codebase.

When editing HTML files (especially the help files in `src/help/`), format them with Prettier: `npx -y prettier --write src/help/*.html`.

## 2. Never Simplify iOS Algorithms

Refer to [iOS Reference Repositories](ios-reference.md) for details on the iOS implementation.

When porting logic from the iOS reference code (`.chronometer-ref/`, `.esastro-ref/`, `.estime-ref/`, `.esobservatory-ref/`), **never simplify** the logic. Code that appears redundant or overly complex is almost always handling an edge case that is not immediately obvious.

If you *cannot* implement the iOS algorithm directly for technical or structural reasons, **stop and ask the user** how to proceed. Do not attempt to design a novel approximation on your own.

**Example**: The Willmann-Bell astronomical calculations have intermediate steps that look algebraically reducible. They are not — they handle numerical stability at extreme date ranges.

## 3. Never Rebuild Parts at Runtime

Parts are parsed once at startup via `parseWatchXML`. The resulting `watch.parts` array is **never replaced** after that. All runtime state changes — time ticks, location changes, body switches, timezone changes — must preserve the existing part tree.

**The animation-preserving pattern** (used for any input change):
1. Create a fresh `Environment` via `createWatchEnvironment()` (picks up new lat/lon/timezone/body)
2. Preserve the existing per-face `Updater` (and its ObsValues) — do **not** call `buildHandValues()` again
3. Re-evaluate immediately by calling `face.updater.reset()` (sets every value's `nextUpdateTime = 0`). This also covers terminator-leaf and analemma values, which are ObsValues on the same Updater
4. Rebuild static caches (`buildStaticBlockCaches()`) for visual elements that depend on the new state
5. Restart the scheduler

**The only exceptions** where a full rebuild (including a fresh `Updater`) is acceptable: initial startup and canvas resize — both are "from scratch" moments where there are no animations to preserve.

**If you believe a full part rebuild is needed, stop and ask the user.** There is almost certainly a way to achieve the desired effect by refreshing the environment and resetting schedules instead.

## 4. Rendering Order is Sacred

Parts must be rendered in exactly the order they appear in the XML file. This order is critical for correct visual layering:
- Hands that overlap other hands must appear later in the XML than the hands they overlap.
- "Windows" (cutout borders) must appear after the parts that show through them but before any hands that overlap them.
- The renderer must **not** sort, reorder, or apply z-index logic — it must use pure document order.

## 5. API Pitfalls

### `julianCenturiesSince2000EpochForDateInterval` returns an object

This function returns `{ julianCenturiesSince2000Epoch: number, deltaT: number }`, **not** a bare number. Always destructure it:

```typescript
const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, cache);
```

### NaN guards in astronomical functions

During initial ObsValue construction (`buildHandValues` in `hand-values.ts`), expression functions may be called before all variables are resolved, producing `NaN` inputs. Functions that do table lookups (e.g., `findOuterPlanetDatum` in `wb-planets.ts`) must guard against `NaN` at the top:

```typescript
if (isNaN(U)) return null;
```

`NaN` defeats range checks because `NaN < x` and `NaN > x` are both `false`, causing index calculations to produce `NaN` and crash on array access.

### Boundary scheduling must use the unquantized time source, never the quantized one

A face has two time sources: a per-face quantized `getNow` (by `beatsPerSecond`), captured by the env's expression functions, and an unquantized base, passed to `updater.tick`. `computeNextBoundary` / `displayTimeToPerfNow` must always use the unquantized source. Using the quantized one causes `Math.ceil` to return the current time (not the next boundary) when the quantized time is already aligned, leading to every-frame evaluation and a visible ~0.5s timing skew between faces with different `beatsPerSecond` values. The seam is built by `makeOverridableGetNow(rawGetNow)` with the quantizer layered on top — see [animation.md](animation.md) and `hand-values.ts`.

## 6. Animation Schedule Reset Rules

Re-arm value schedules with **`face.updater.reset()`** (sets every ObsValue's `nextUpdateTime = 0`) only at **discrete transition points**:
- Single step taps
- Body switches
- Start of hold-to-scrub

Do **not** reset on every tick during continuous scrubbing — the scrub-compression update path handles scheduling correctly, and resetting disrupts in-progress animations.

`updater.reset()` covers everything on the face: hands, wheels, dials, calendar covers, the day/night ring (masterOffset + wedges), terminator leaves, and the analemma — all are ObsValues on the one per-face `Updater`. There is no longer a separate `resetLeafSchedules()` / `resetAnalemmaSchedule()` to call. Pair it with `face.updater.finish()` (snap + freeze) where the legacy code called `finishAnimations()` — e.g. before re-arming on a step.

## 7. Engine Bundling and Import Discipline

The codebase produces multiple bundles:
- **`chronometer-engine.js`**: Contains `src/watch/`, `src/shared/`, `src/expr/`, and `src/astronomy/`
- **`inspector-engine.js`**: Contains `src/inspector/`, `src/shared/`, `src/expr/`, and `src/astronomy/` — but **not** `src/watch/`

Adding new functions to `src/shared/astro-env.ts` requires a full `bash build.sh` rebuild and affects both bundles. Adding functions to `src/watch/watch-env.ts` affects only Chronometer.

**Import discipline:** Apps in `src/inspector/` (and future `src/observatory/`) must never import from `src/watch/`. This ensures their bundles don't pull in Chronometer-specific code (XML parser, renderer, face assets). See [Architecture Overview](architecture-overview.md) for the full import boundary rules.

## 8. Interactive Controller Patterns

### Planet/body selector

Faces like Venezia that allow switching between celestial bodies persist the
selection through `app-state.ts` (the `body` field, in the `chronometer`
namespace — LocalStorage by default, URL only for sharing/fallback). The
selector UI is injected into `#planet-selector` in `face-template.html`, hidden
by default and shown only for applicable faces. The toggle calls
`setState({ body })`; `watch-env.ts` reads `getState().body` when building the
environment.

### Persisted overrides vs init blocks

Persisted overrides like `body` and `vnoon` must be applied **after** XML init
block evaluation in `watch-env.ts` (which reads them via `getState()`), as init
blocks may set default values that would otherwise overwrite them.

### Animation-preserving body switch

When switching bodies, preserve the existing per-face `Updater` rather than rebuilding it. Update the environment and call `face.updater.reset()`, and let the values interpolate from old to new targets for smooth transitions. (This is an instance of the general rule in §3.)

### Vienna noon/midnight toggle

Vienna's 24-hour dial supports switching between midnight-on-top (default) and noon-on-top via the persisted `vnoon` setting (stored through `app-state.ts`, in the `chronometer` namespace) and a pill toggle in `#vienna-noon-toggle`. The toggle:
1. Sets `noonOnTop` and `dialFlip` env variables (the XML uses `dialFlip` in hand angles, day/night ring `masterOffset`, and the 24-hour number dial `angle`)
2. Rebuilds the static cache and calls `face.updater.reset()`
3. The dials/hands and the ring's `masterOffset` ObsValue animate to the flipped position automatically. The `dialFlip` dials use `update='0'` (env-change-only), so they flip at constant `animSpeed`; the ring's `masterOffset` is deliberately **not** eval-ahead so it flips at the same constant speed and stays coherent with them

The 24-hour number dial uses `orientation='radial'` so labels remain readable in both orientations — `radial` always points text tops outward. No text swapping is needed; the 180° rotation naturally moves the correct numbers to the top. The dial is outside the `<static>` block so the renderer can animate it per-frame.

This follows the same post-init-override pattern as `body` (applied after init blocks in `watch-env.ts`, sourced from `getState()`).

### Terra embed mode

Terra supports an `embed=1` URL parameter for iframe embedding.
See [Embedding](embedding.md) for full details.

### Kyoto wadokei toggles

Kyoto's fixed-hand and rate-mode toggles are controlled by the `wadokei='1'` XML feature flag (not by face name). The engine uses `face.watch.wadokei` to decide whether to show the toggle UI — following the same pattern as `planetSelector` for Venezia.

**State restoration**: `restoreKyotoState(face)` must be called after every `createWatchEnvironment()` invocation (currently 6 sites in `engine-entry.ts`). It reads `kyhand` and `kmode` from the URL and injects them into the fresh environment. If you add a new `createWatchEnvironment()` call site, add `restoreKyotoState(face)` immediately after.

**Animation snapping**: When toggling modes, call `face.updater.finish()` (then `face.updater.reset()`) *before*/around applying the new mode values. Without the `finish()`, `kyotoMasterRotation()` jumps by a large angle and the values may interpolate through the wrong direction.

**Face image**: `face.png` is a `<hand>` element (outside `<static>`) with `angle='0 - kyotoMasterRotation()'` so it rotates with the dial in fixed-hand mode. See [XML Syntax — Kyoto Wadokei Toggles](xml-syntax.md#kyoto-wadokei-toggles) for full details.

## 9. Cross-Browser Text Positioning

**Never** use `textBaseline = 'top'` — Safari positions it differently from Chrome. Always use `textBaseline = 'alphabetic'` with `textVisualCenterY(ctx, label)` as the Y-offset. This applies to all dial, wheel, and calendar text rendering. See [Rendering — Cross-Browser Text Positioning](rendering.md#cross-browser-text-positioning) for details.

## 10. If Blocked, Ask

If you cannot implement the iOS algorithm directly, cannot find the source of a rendering bug, or believe a fundamental architectural constraint needs to be violated — **stop and ask the user** how to proceed. Do not attempt speculative workarounds.

## 11. Date Range Constraint: 4000 BCE – 2800 CE

The astronomical series approximations (Willmann-Bell planetary/sun tables) are only valid for the range **4000 BCE to 2800 CE**. All time-mutation paths must enforce this invariant:

- `TimeController.clampDisplayTime()` checks the current display time against the boundary constants `MIN_DISPLAY_DATE_MS` / `MAX_DISPLAY_DATE_MS` (from `es-time.ts`). When the limit is hit, the clock stops (if running) or the frozen value is clamped (if stopped). This mirrors iOS `ESWatchTime::checkAndConstrainAbsoluteTime()`.
- The method is called after every time mutation (`step`, `setTime`, `setRate`, `setDirection`, `setOffset`, `checkTick`) and in the render-loop frame callback (for 1×/-1× with offset).
- Date input fields in `applyDateInputs()` clamp the constructed date before passing it to `setTime()`.
- `formatSimTime()` appends "⚠ earliest" or "⚠ latest" at the boundary.

## 12. NEVER NEVER NEVER rebuild golden files unless the user expressly asks you to.

Since the golden files are gitignored, if you regenerate the inappropriately, the previous version will need to be regenerated with an older version of the code, and it is not always obvious which
version of the code that would need to be. If a test fails and you think you need to regenerate,
ask the user and do nothing without explicit instruction.

## 13. (Retired) Keep Inspector Expression Metadata in Sync

Retired 2026-07: the Inspector's expression evaluator (and its curated metadata in `expr-metadata.ts`) was removed, so there is no metadata table to keep in sync. The heading is kept so rules 14+ keep their numbers.

## 14. Never Make Build Behavior Conditional on Output File Existence

Build steps must either always run or always check that required *inputs* exist and fail if missing. Never skip generating an output because it already exists; never silently use a stale output when inputs are unavailable.

**Prohibited patterns:**
```bash
# BAD: Skips generation if output already exists
if [ ! -f "output.js" ]; then
  generate_output
fi

# BAD: Silently skips missing files
[ -f "$f" ] && cp "$f" dest/
```

**Acceptable patterns:**
```bash
# GOOD: Guard — validates input exists, fails fast
if [ ! -f "required-input.txt" ]; then
  echo "ERROR: missing required-input.txt" >&2
  exit 1
fi
```

See [Build System — File Categories](build-system.md#file-categories-and-archival) for the full categorization system and archival workflow. The agent skill `audit-build-hygiene` can be used to scan the build process for violations of this rule.

## 15. Observatory is a separate web app with its own doc

Read [Observatory Documentation](observatory.md) for information on how to build and run Observatory.

## 16. Never make unchecked changes to the iOS reference codebases.

The scope of this project does not include modifying the iOS reference codebases. Never modify them; check with the user if you think it's necessary.

## 17. Reach for the slot-based astronomy cache before inventing a new memoization mechanism

The `AstroCache` slot mechanism (`src/astronomy/astro-cache.ts`) is the project's primary memoization tool. It is a flat array of numeric slots with a `currentFlag` validity scheme, keyed by `(location, dateInterval)`, and it has been used in iOS for years for exactly this purpose. It is designed to memoize **both** high-level results (e.g. a rise/set angle for a planet) **and** the lower-level intermediates those results share (positions, nutation, obliquity) — all in one pass, with no ordering dependency between callers.

**When you think you need to memoize something, do this first:**

1. **Check whether the code you're touching already has slots for it.** Slots are sometimes defined but never wired up (a port artifact). Example found 2026-06-29: `dayNightMasterRiseAngleLST…` slots existed in the enum but `computeDayNightLeafAngleLST` ignored them and re-ran the rise/set search on every leaf — 41× the cost of the properly-cached local-time ring. The fix was to *use the existing slots*, not to add a new cache.
2. **Check how iOS cached it.** The reference (`.chronometer-ref/Classes/ECAstronomy.m`, `ECAstronomyCache.h`) almost always memoized inline against the slot cache, keyed by an index like `baseSlotIndex + planetNumber (+ timeBaseOffset)`. Mirror that. iOS rarely needed bespoke memo wrappers; if the port grew one (e.g. `getMasterRiseSet`), that is a sign the low-level function should have cached into slots itself.
3. **If a function recomputes the same astronomy across calls in a tick, the function — or the slot-backed helper it calls — should write its result into a slot,** so siblings hit the cache. Factor shared sub-computations into their own slot if needed.

**Do not** introduce a parallel `Map`-based memo, a per-tick scratch object, or a hand-rolled wrapper when a slot (existing or new) would do. New mechanisms cost complexity and tend to drift out of the `(location, di)` invalidation model, producing stale-value bugs. The retired `tickMemo` (a `Map`) is the cautionary example — it was replaced wholesale by dedicated slots.

**Use *the* pool's caches, even for a brief, few-slot need.** The rule is not "any slot-based cache is fine" — it is "use the existing `AstroCachePool`." The pool already provides reusable caches (`finalCache`, `refinementCache`, `tempCache`) whose invalidation is a single `currentFlag` bump — **O(1), independent of slot count** — so reusing one for a short window (e.g. one part's sub-calculations, or one phase of the tick) is essentially free and is the intended pattern. Reach for a pool cache (re-keyed/invalidated as needed) before ever defining a new cache object of your own. A short-lived `tempCache` from the pool is correct; a freshly-allocated cache or a `Map` is not.

**The one legitimate limit:** each cache holds a single `(location, dateInterval)` at a time. Genuinely multi-location work in one tick (e.g. per-city world-clock rings, where one ring's slot for `planetNumber=Sun` would collide with another city's) needs either per-location slot indexing or a per-location temp cache from the pool — but that is still the pool's slot mechanism, not a new one. Likewise, two operations in one tick that want *different* dateIntervals simultaneously (e.g. a boundary search keyed at "now" interleaved with an eval keyed at a future boundary) cannot share one cache instance without thrashing — separate them into phases, or give each its own pool cache. Confirm you actually have one of these cases (measure / trace the control flow) before reaching past a single shared cache.

## 18. Run the perf-regression check for performance-sensitive changes

The Vitest suite is bit-identical/correctness only — it catches crashes but **not** "still correct, just slower." For any change that could plausibly affect the scrub/tick cost — astronomy, the cache pool, the updater/animation tick, expression evaluation, or per-eval work like timezone conversion — run the perf-regression check **alongside** `npx vitest run`, and surface the result to the user:

```bash
npx tsx src/__tests__/perf/perf-regression.ts
```

It measures every face's warm tick, diffs against `src/__tests__/perf/perf-baseline.json`, and prints a per-face + total summary with an instruction to surface notable deltas. It is **reported, not gated** (wall-clock time is machine-dependent, so it never fails the build). Re-baseline (`--capture`) only after an *intended* perf change, on a known-good tree — same discipline as regenerating golden files (§12). See [Perf Regression Check](perf-regression.md) for how to read the output and judge measurement noise vs a real regression — per-face timings swing ~±10% run-to-run *even on one machine* (run ordering / thermal / JIT-GC), so a single-shot per-face delta under ~10–15% is not evidence of a regression; confirm suspected ones with an interleaved same-machine A/B.

