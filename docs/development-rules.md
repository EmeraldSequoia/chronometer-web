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
2. Preserve existing `HandState` objects — do **not** call `initHandStates()`
3. Reset hand schedules (`hs.nextUpdateTime = 0`) so expressions re-evaluate immediately
4. Update terminator leaf angles and reset their schedules
5. Rebuild static caches (`buildStaticBlockCaches()`) for visual elements that depend on the new state
6. Restart the scheduler

**The only exceptions** where full rebuild (including fresh hand states) is acceptable: initial startup and canvas resize — both are "from scratch" moments where there are no animations to preserve.

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

During initial hand state collection (`createHandState` in `animation.ts`), expression functions may be called before all variables are resolved, producing `NaN` inputs. Functions that do table lookups (e.g., `findOuterPlanetDatum` in `wb-planets.ts`) must guard against `NaN` at the top:

```typescript
if (isNaN(U)) return null;
```

`NaN` defeats range checks because `NaN < x` and `NaN > x` are both `false`, causing index calculations to produce `NaN` and crash on array access.

### Boundary scheduling must use `rawGetNow`, never `getNow`

`HandState` has two time sources: `getNow` (quantized by `beatsPerSecond`) and `rawGetNow` (unquantized). `computeNextBoundary` and `displayTimeToPerfNow` must always use `rawGetNow`. Using the quantized `getNow` causes `Math.ceil` to return the current time (not the next boundary) when the quantized time is already aligned, leading to every-frame evaluation and a visible ~0.5s timing skew between faces with different `beatsPerSecond` values. See the `[!IMPORTANT]` block in [animation.md](animation.md) for details.

## 6. Animation Schedule Reset Rules

Reset hand schedules (`nextUpdateTime = 0`) only at **discrete transition points**:
- Single step taps
- Body switches
- Start of hold-to-scrub

Do **not** reset on every tick during continuous scrubbing — the quantized tick system handles scheduling correctly, and resetting disrupts in-progress animations.

Terminator leaves have their own `nextUpdateTime` and `resetLeafSchedules()` function. These must also be reset at the same transition points as hand states.

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

When switching bodies, preserve existing `HandState` objects rather than recreating them. Update the environment, reset schedules, and let the animation system interpolate from old to new target values for smooth transitions. (This is an instance of the general rule in §3.)

### Vienna noon/midnight toggle

Vienna's 24-hour dial supports switching between midnight-on-top (default) and noon-on-top via the persisted `vnoon` setting (stored through `app-state.ts`, in the `chronometer` namespace) and a pill toggle in `#vienna-noon-toggle`. The toggle:
1. Sets `noonOnTop` and `dialFlip` env variables (the XML uses `dialFlip` in hand angles, day/night ring `masterOffset`, and the 24-hour number dial `angle`)
2. Rebuilds the static cache and resets hand/dial schedules
3. The 24-hour number dial animates automatically via its `HandState` (driven by `angle='dialFlip'` + `animSpeed='1'`)

The 24-hour number dial uses `orientation='radial'` so labels remain readable in both orientations — `radial` always points text tops outward. No text swapping is needed; the 180° rotation naturally moves the correct numbers to the top. The dial is outside the `<static>` block so the renderer can animate it per-frame.

This follows the same post-init-override pattern as `body` (applied after init blocks in `watch-env.ts`, sourced from `getState()`).

### Terra embed mode

Terra supports an `embed=1` URL parameter for iframe embedding.
See [Embedding](embedding.md) for full details.

### Kyoto wadokei toggles

Kyoto's fixed-hand and rate-mode toggles are controlled by the `wadokei='1'` XML feature flag (not by face name). The engine uses `face.watch.wadokei` to decide whether to show the toggle UI — following the same pattern as `planetSelector` for Venezia.

**State restoration**: `restoreKyotoState(face)` must be called after every `createWatchEnvironment()` invocation (currently 6 sites in `engine-entry.ts`). It reads `kyhand` and `kmode` from the URL and injects them into the fresh environment. If you add a new `createWatchEnvironment()` call site, add `restoreKyotoState(face)` immediately after.

**Animation snapping**: When toggling modes, `finishAnimations()` must be called on the face's hand states *before* applying the new mode values. Without this, `kyotoMasterRotation()` jumps by a large angle and the animation system may interpolate through the wrong direction.

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

## 13. Keep Inspector Expression Metadata in Sync

When adding or changing expression functions in `src/shared/astro-env.ts` or `src/watch/watch-env.ts`, also update the curated metadata table in `src/inspector/expr-metadata.ts`. This table powers the Inspector's **Reference panel** and **autocomplete** — if a function is missing, developers can still evaluate it manually, but it won't appear in the categorized reference or get a description/signature hint.

Each entry needs: `name`, `category` (for grouping), `desc` (one-line description), `kind` (`'fn'` or `'const'`), and optionally `sig` (parameter signature like `'(planet, leaf)'`). New categories should also be added to `CATEGORY_ORDER`.

See [Inspector](inspector.md) for how the metadata is used.

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

