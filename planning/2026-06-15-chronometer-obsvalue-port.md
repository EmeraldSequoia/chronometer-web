# Port Chronometer to the ObsValue System

**Date:** 2026-06-15
**Status:** Draft — awaiting review (revision 4).

> **Scope.** Replace Chronometer's per-part `HandState` / `tickAnimations`
> animation system with `ObsValue`s driven by the shared `Updater`, including
> the **terminator leaves** and **analemma** subsystems. After this work, all
> three apps (Observatory, Inspector, Chronometer) share a single animation-value
> mechanism, and the Chronometer-specific `HandState` system, `TerminatorLeafState`
> animation loop, and `AnalemmaState` scheduling can be retired. The port is
> *behavioral* — the rendered output should be visually identical — and must
> follow the development rules (§2 never simplify, §4 rendering order is sacred,
> §3 never rebuild parts at runtime).

## Background — current state

### Chronometer animation (the system being replaced)

Chronometer's animation lives in
[animation.ts](../src/shared/animation.ts) and is driven from
[engine-entry.ts](../src/engine-entry.ts). The core types:

- **`HandState`** — one per dynamic part (QHand, Wheel, QWedge, animated QDial,
  QDayNightRing, CalendarRowCover). Holds an `AnimatingValue` for `angle`, plus
  optional `offsetAngle`, `xMotion`, `yMotion`. Carries `getNow` (quantized)
  and `rawGetNow` (unquantized) closures, `updateIntervalMs`, `animSpeed`.
- **`AnimatingValue`** — the raw interpolation state (`currentValue`, `targetValue`,
  `lastAnimationTime`, `animationStopTime`, `animating`).

Per-frame flow:
1. `tickAnimations(states, env, now, tickMs, deltaSec, timeDir)` — for each
   state whose timer expired, evaluates the angle expression, starts an
   animation, and schedules the next update. Handles both 1× and quantized
   (scrub) modes with adaptive compression. Writes each result to
   `part.dynamicState.currentAngle`.
2. The renderer reads `part.dynamicState.currentAngle` (and `.currentOffsetAngle`,
   `.currentXMotion`, `.currentYMotion`) each frame.

Additionally, **QDayNightRing** parts have three separate animation subsystems
embedded in the renderer and `engine-entry.ts`:
- `_masterOffsetAnim` — the ring's overall rotation (noon/midnight toggle on
  Vienna, wadokei mode switch on Kyoto). Driven by UI actions (pill toggles)
  that set a new target and call `startAnimationRaw`.
- `_wedgeAngleAnims` — per-wedge angular positions (N wedges, typically 24).
  Driven by the ring's cached astronomy angles; animated toward new targets
  each time the cache expires.
- `_wedgeSlides` — per-wedge radial slide position (Kyoto wadokei only).
  Controls which wedges are visible by sliding hidden ones behind a cover disc.

All three are raw `AnimatingValue` arrays managed outside the unified animation
system.

Transition handling lives in `engine-entry.ts` as hand-rolled
`finishAllAnimations()`, `resetAllSchedules()`, and per-transition callbacks
(`onTimeStep`, `onScrubStart`, `onScrubEnd`, `onNowClicked`,
`onTransportChange`).

### ObsValue system (the target)

[obs-value.ts](../src/shared/obs-value.ts) +
[updater.ts](../src/shared/updater.ts) provide:

- **`ObsValue`** — one per animated quantity. Holds a parsed AST, update interval,
  `animSpeed`, `naturalSpeed`, `currentValue`, `anim: AnimatingValue`, and flags
  (`linear`, `evalAhead`, `discrete`).
- **`Updater<K>`** — a name-keyed collection of `ObsValue`s. Per-frame `tick()`
  runs the update + animate passes. `reset()` re-arms all schedules.
  `anyAnimating()` for idle decisions.

The Updater integrates with the time controller via `initTimeControls({ updater })`
— the shared UI auto-calls `updater.reset()` on every transition, eliminating
hand-rolled transition callbacks for the generic work.

## Design Decisions (resolved)

### Eval-ahead for all values

All Chronometer ObsValues use `evalAhead: true`, with CalendarRowCover using
`discrete: true`. This is the forward-looking mechanism and subsumes the legacy
snap-to-target and scrub-compression branches.

> [!NOTE]
> **Behavioral improvement for bps=1 faces.** Faces with `beatsPerSecond=1`
> (one tick per second) currently start each hand animation *at* the top of the
> second — the hand is at the old position when the second ticks, then animates
> to the new one. With eval-ahead, the animation starts *before* the top of the
> second so that it arrives at the new position exactly when the second ticks.
> This is a deliberate behavioral change that better preserves the mechanical
> model: the hand is always where it should be at the moment of the beat.

### Astro cache impact of eval-ahead

Eval-ahead temporarily shifts `getNow()` to a future time via `withDisplayTime`.
The question is whether this reduces cache hits in the astronomy cache pool
(`AstroCachePool`), which uses a 0.5-second slop tolerance (`ASTRO_SLOP_RAW`).

**Analysis:** The impact is **minimal** for these reasons:

1. **Staggered timers.** Only ObsValues whose `nextUpdateTime` has arrived are
   re-evaluated in a given frame. Typically only 1–3 values fire per frame (the
   fast hands), and fast hands don't call astronomy functions.
2. **Sequential override.** When an astro-dependent value (e.g., a day-night ring
   at 300s interval) does fire, `withDisplayTime` shifts `getNow` to ~300s in
   the future for just that one evaluation. The cache rebuilds for that future
   time — but **it would have rebuilt anyway** when that time actually arrived.
3. **Scoped override.** The `withDisplayTime` override is scoped to the single
   `evalAttr` callback. After return, `getNow` reverts to the real time, so the
   cache returns to its normal state. No lingering invalidation.
4. **Already happens today.** When multiple parts with different update intervals
   fire in the same frame, the current system evaluates them sequentially at the
   *same* time. Eval-ahead changes the *which* time, but not the pattern of
   sequential evaluations.

The only scenario where eval-ahead adds extra invalidations is if two
astro-dependent values fire on the same frame with different future targets —
but this is rare (update intervals are typically identical for astro parts on
the same face), and a single extra cache rebuild per 60–300s is negligible.

### Context: state management

Since this plan was originally drafted, all application state (location,
configuration, time) has moved to `app-state.ts` — a `getState()`/`setState()`
abstraction backed by browser **LocalStorage** by default, with URL-parameter
fallback for `file://` URLs. See
[planning/2026-06-13-localstorage-state-and-sharing.md](2026-06-13-localstorage-state-and-sharing.md).

Key implications for this plan:
- **Observer location** (`lat`/`lon`) is already read via `getState()` and passed
  to `createWatchEnvironment` as parameters. No changes needed — the ObsValue
  port doesn't touch location plumbing.
- **No precision restriction.** Because LocalStorage is device-local (never sent
  to a server), there is no need to truncate lat/lon precision. Full `number`
  precision is stored and used.
- **Cross-tab sync.** `onSharedChange` fires when another tab changes shared
  state (location, time). The env rebuild + `updater.reset()` pattern handles
  this correctly — same as any location change.

### One `Updater` per face

Each face has its own `beatsPerSecond` quantization, environment, and part set.
A per-face `Updater` keeps these isolated and maps cleanly onto a potential
future optimization where off-screen faces skip rendering entirely.

The `initTimeControls` config receives a wrapper object that delegates `reset()`
to all face updaters:
```ts
const allUpdaters = {
    reset() { for (const f of faces) f.updater.reset(); },
    anyAnimating() { return faces.some(f => f.updater.anyAnimating()); },
};
```

### Named keys — single source of truth

ObsValue names use the convention `<faceName>.<partName>.<property>`, where:
- `faceName` is the watch's `name` field (e.g., `"Haleakalā"`, `"Vienna"`)
- `partName` is the part's `name` field from PartBase (set from the XML `name` attribute)
- `property` is one of: `angle`, `offsetAngle`, `xMotion`, `yMotion`,
  `masterOffset`, `wedgeAngle.<N>`, `wedgeSlide.<N>`

For example: `"Vienna.24HourHand.angle"`, `"Kyoto.dayNight.wedgeAngle.3"`.

The **renderer** reads values directly from the Updater, not from
`part.dynamicState`. This means:

1. The renderer receives the face's `Updater` as a parameter.
2. Where it currently reads `part.dynamicState.currentAngle`, it constructs
   the key and reads `updater.get(key).currentValue`.
3. `part.dynamicState` and the `DynamicState` interface are retired.

> [!NOTE]
> **Performance.** The `Updater.get()` is a `Map.get()` — O(1) amortized. For
> hot paths (QHand drawing called 25× per frame), the key could be cached on the
> part as `part._obsKey` during construction. Alternatively, the part could hold
> a direct reference to its ObsValue (`part._obsAngle: ObsValue`), set during
> `buildHandValues`. Either approach avoids constructing keys at render time.
> The recommendation is to store the ObsValue reference on the part for hot paths.

### QDayNightRing — full port to ObsValues

All three QDayNightRing animation dimensions become ObsValues:

- **`masterOffset`**: Expression-driven, same as any QHand angle. Uses
  `evalAhead: true`, `linear: false`.
- **Per-wedge angles** (`wedgeAngle.0` … `wedgeAngle.23`): Each wedge's target
  angle is computed by the `dayNightLeafAngle` env function. These become
  ObsValues with the leaf-angle function as their expression. Use
  `evalAhead: true`, `linear: false`.
- **Per-wedge slides** (`wedgeSlide.0` … `wedgeSlide.23`, Kyoto only): Radial
  slide distance (0 = visible, `slideDistance` = hidden). Use `linear: true`.
  These are UI-state-driven (how many wedges are visible) rather than
  expression-driven. They could be `discrete: false` ObsValues whose expression
  evaluates the visibility predicate, or managed through `Updater` set-target
  operations.

> [!IMPORTANT]
> **Wedge animation challenge.** The current wedge animations live *inside the
> renderer* — target angles are computed from astronomy functions during the
> draw pass and fed to `AnimatingValue`s inline. Porting to ObsValues means
> this computation moves to `buildHandValues` (or a per-face wedge-value
> builder), and the renderer only reads `currentValue` from the Updater.
> This requires creating per-wedge expression nodes (or wrapper eval functions)
> that call the same astronomy leaf-angle functions. The number of wedges is
> known at XML parse time (`numWedges` attribute), so the ObsValue set is fixed
> per face.

### Per-wedge expressions — string-based env functions

For QDayNightRing wedge angles and slide distances, each ObsValue needs an
"expression" that calls an astronomy or visibility function with a wedge index.
We use **string-based env functions** (option b from the original analysis):

1. Register `dayNightWedgeAngle(planetNumber, wedgeIndex, numWedges)` and
   `dayNightWedgeSlide(wedgeIndex, numWedges, slideDistance)` as env functions
   during `createWatchEnvironment`.
2. Each wedge ObsValue's expression is a string like
   `"dayNightWedgeAngle(1, 3, 24)"`, parsed into an AST at construction time.
3. When the future JS-eval migration (see
   [planning/2026-06-15-eval-vs-custom-parser.md](2026-06-15-eval-vs-custom-parser.md))
   replaces the custom parser, these strings will work directly with
   `new Function()` — no special-casing needed.

The same pattern applies to the slide visibility expressions:
`"dayNightWedgeSlide(3, 24, 15)"` returns 0 (visible) or `slideDistance`
(hidden) based on `wadokeiDNNumVisible(numWedges)` internally.

### CalendarRowCover — env function

`computeCalendarCoverOffset` (currently a TypeScript function in `animation.ts`)
becomes a registered env function. The ObsValue's expression string calls that
function:
```
calendarCoverOffset(coverType)
```
This requires:
1. Register `calendarCoverOffset` in the env's function map during
   `createWatchEnvironment`.
2. The function reads calendar state from the env (month, year, weekday start)
   and returns the integer pixel offset.
3. The ObsValue uses `discrete: true, linear: true`.

### `beatsPerSecond` quantization

`makeOverridableGetNow(rawGetNow)` produces the overridable wrapper. The
env's function closures already capture the quantized `getNow`, so expression
evaluation through the env always sees quantized time. The Updater's `getNow`
(the overridable wrapper) uses `rawGetNow` as its base, which is correct for
scheduling (`computeNextBoundary`). The `withDisplayTime` override temporarily
shifts `rawGetNow` for eval-ahead — the env closures then see the shifted
(but still unquantized) time, which is correct because `withDisplayTime` is
only used for computing the *target* value at a future boundary, and the
quantization semantics are captured in the env functions themselves.

## Per-value mapping

Each Chronometer dynamic part produces these ObsValues:

| Part type | Properties | Flags |
|-----------|-----------|-------|
| **QHand** | `angle`, optional `offsetAngle`, `xMotion`, `yMotion` | `evalAhead`, `linear` for x/yMotion |
| **Wheel** | `angle` | `evalAhead` |
| **QWedge** | `angle`, optional `offsetAngle` | `evalAhead` |
| **QDial** (animated) | `angle` | `evalAhead` |
| **QDayNightRing** | `masterOffset` + per-wedge `wedgeAngle.<N>` + per-wedge `wedgeSlide.<N>` | `evalAhead` for angles, `linear` for slides |
| **CalendarRowCover** | `xMotion` | `discrete: true, linear: true` |

---

## Proposed Changes

### Phase 1: CalendarRowCover env function

#### [MODIFY] `src/watch/watch-env.ts`

Register `calendarCoverOffset(coverType: number): number` in the env's
function map. The function body is the logic currently in
`computeCalendarCoverOffset` from `animation.ts` — it reads calendar state
(`calendarMonth`, `calendarYear`, `calendarWeekStartDay`) from the env and
returns the integer pixel offset.

#### [MODIFY] `src/shared/animation.ts`

Remove `computeCalendarCoverOffset` (the logic moves to the env function).

---

### Phase 2: Updater construction + named keys

#### [NEW] `src/watch/hand-values.ts`

The Chronometer-specific bridge between the part model and the Updater. This
module:

1. **`buildHandValues(faceName, watch, env, perfNow, getNow, rawGetNow): Updater`**
   — Walks the part tree (same traversal as `collectDynamicParts`), and for each
   dynamic part creates the appropriate ObsValue(s) and registers them on an
   `Updater`. Each ObsValue's `name` follows the `<faceName>.<partName>.<property>`
   convention.

2. **Per-part ObsValue wiring.** For each dynamic part, stores a direct reference
   to its ObsValue(s) on the part object for O(1) renderer access:
   - `part._obsAngle: ObsValue` — angle ObsValue (set for QHand, Wheel, QWedge, QDial)
   - `part._obsOffsetAngle: ObsValue` — offsetAngle ObsValue (QHand, QWedge with offsetAngle)
   - `part._obsXMotion: ObsValue` — xMotion ObsValue (QHand, CalendarRowCover)
   - `part._obsYMotion: ObsValue` — yMotion ObsValue (QHand)
   - `part._obsMasterOffset: ObsValue` — masterOffset ObsValue (QDayNightRing)
   - `part._obsWedgeAngles: ObsValue[]` — per-wedge angle ObsValues (QDayNightRing)
   - `part._obsWedgeSlides: ObsValue[]` — per-wedge slide ObsValues (QDayNightRing)

3. **QDayNightRing construction.** For each QDayNightRing part:
   - Create a `masterOffset` ObsValue from the part's `masterOffset` expression.
   - Create `numWedges` angle ObsValues, each with an expression that calls the
     leaf-angle function for wedge index `i`. These may be thin wrapper AST nodes
     or registered env functions (`dayNightWedgeAngle(partIndex, wedgeIndex)`).
   - For Kyoto (slideDistance > 0): create `numWedges` slide ObsValues, each
     with an expression that returns 0 (visible) or `slideDistance` (hidden)
     based on the `wadokeiDNNumVisible` env function.

4. **`beatsPerSecond` handling.** `makeOverridableGetNow(rawGetNow)` produces
   the timing pair. The Updater receives `getNow` (the overridable wrapper,
   whose base is `rawGetNow`) and `withDisplayTime`. Expression evaluation
   goes through the env, which already captures the quantized `getNow`.

#### [MODIFY] `src/watch/types.ts`

Add optional ObsValue reference fields to `PartBase` and `QDayNightRingPart`:
```ts
// In PartBase:
_obsAngle?: ObsValue;
_obsOffsetAngle?: ObsValue;
_obsXMotion?: ObsValue;
_obsYMotion?: ObsValue;

// In QDayNightRingPart:
_obsMasterOffset?: ObsValue;
_obsWedgeAngles?: ObsValue[];
_obsWedgeSlides?: ObsValue[];
```

Remove the `dynamicState` field from `PartBase` and the `DynamicState` interface
(replaced by ObsValue references).

Remove `_masterOffsetAnim`, `_wedgeSlides`, `_wedgeAngleAnims` from
`QDayNightRingPart` (replaced by ObsValue references).

---

### Phase 3: Renderer migration

#### [MODIFY] `src/watch/renderer.ts`

Replace all reads of `part.dynamicState.currentAngle` etc. with reads from the
ObsValue references:

```diff
-const angle = part.dynamicState
-    ? part.dynamicState.currentAngle
-    : evalAttr(part.angle, env);
+const angle = part._obsAngle
+    ? part._obsAngle.currentValue
+    : evalAttr(part.angle, env);
```

The same pattern applies to `currentOffsetAngle` → `_obsOffsetAngle.currentValue`,
`currentXMotion` → `_obsXMotion.currentValue`, etc.

For `drawQDayNightRing`:
- Read `masterOffset` from `part._obsMasterOffset.currentValue`.
- Read per-wedge angles from `part._obsWedgeAngles[i].currentValue`.
- Read per-wedge slides from `part._obsWedgeSlides[i].currentValue`.
- Remove the inline animation logic (`startAnimationRaw`, `interpolateRaw`,
  `makeAnimatingValue` calls, `_wedgeAngleAnims`/`_wedgeSlides` management).
- The wedge angle caching (`_cachedAngles`, `_cacheStart`, `_cacheNextUpdate`)
  is subsumed by the ObsValue update scheduling — remove it.

---

### Phase 4: Engine integration

#### [MODIFY] `src/engine-entry.ts`

**FaceInstance changes:**
- Replace `handStates: HandState[]` with `updater: Updater`.
- Remove imports of `initHandStates`, `tickAnimations`, `nextWakeupTime`,
  `anyAnimating`, `finishAnimations`, `resetHandSchedules`.

**Construction:**
```ts
face.updater = buildHandValues(
    watch.name, watch, env, performance.now(),
    makeGetNow(watch.beatsPerSecond), rawGetNow,
);
```

**Per-frame loop:**
```diff
-tickAnimations(face.handStates, face.env, now, tickMs, deltaSec, timeDir);
-// ... inline QDayNightRing masterOffset interpolation ...
+face.updater.tick(env, now, getNow, withDisplayTime, timingCtx);
```

**Transition handling:**
```diff
-function finishAllAnimations() {
-    for (const face of faces) {
-        finishAnimations(face.handStates);
-        finishLeafAnimations(face.terminatorLeaves);
-        finishDayNightSlides(face.watch);
-    }
-}
+function finishAllAnimations() {
+    for (const face of faces) {
+        face.updater.finish();  // covers hands, wedges, terminator, analemma
+    }
+}
```

```diff
-function resetAllSchedules() {
-    for (const face of faces) {
-        resetHandSchedules(face.handStates);
-        resetLeafSchedules(face.terminatorLeaves);
-        resetDayNightSlides(face.watch);
-    }
-}
+function resetAllSchedules() {
+    for (const face of faces) {
+        face.updater.reset();  // covers hands, wedges, terminator, analemma
+    }
+}
```

The `initTimeControls` `updater` field receives the all-faces wrapper, so
generic transition callbacks (scrub start/end, transport change) auto-call
`reset()`. Face-specific callbacks remain for:
- `rebuildEnvironments()` (time controller `onTick`)
- Kyoto/Vienna UI toggle logic (which now calls `updater.reset()` instead of
  manual schedule manipulation)

**Idle scheduler:**
```diff
-const t = nextWakeupTime(face.handStates);
+const t = face.updater.nextWakeupTime();
```

**`anyAnimating`:**
```diff
-const faceAnimating = anyAnimating(face.handStates) || anyLeafAnimating(face.terminatorLeaves) || ringAnimating;
+const faceAnimating = face.updater.anyAnimating();  // covers hands, wedges, terminator, analemma
```

> [!NOTE]
> The diffs above show the **final state** after all phases (1–8). During
> Phase 4 implementation, terminator/analemma calls will still be present;
> they are removed in Phase 7 (terminator) and Phase 8 (analemma).

**Vienna noon/midnight toggle and Kyoto mode switch:**
Replace manual `startAnimationRaw(part._masterOffsetAnim, ...)` logic with
setting the env variable and calling `updater.reset()`. The masterOffset
ObsValue re-evaluates and animates to the new target automatically via
eval-ahead.

---

### Phase 5: Updater extensions

#### [MODIFY] `src/shared/updater.ts`

Add:

1. **`Updater.finish()`** — Snap all in-flight animations to their targets and
   freeze schedules (`nextUpdateTime = Infinity`). Used for step events and
   transport transitions where the system must settle immediately.

2. **`Updater.nextWakeupTime(): number`** — Return the minimum `nextUpdateTime`
   across all values. Used by the idle scheduler to set a precise `setTimeout`.

---

### Phase 6: Clean up deprecated code

#### [MODIFY] `src/shared/animation.ts`

Remove or deprecate (these are no longer used by any consumer):
- `HandState` interface
- `initHandStates`, `collectDynamicParts`, `createHandState`,
  `createCalendarCoverState`, `computeCalendarCoverOffset`
- `tickAnimations`
- `nextWakeupTime`, `anyAnimating` (HandState versions), `finishAnimations`,
  `resetHandSchedules`
- The private `startAnimation`, `snapToTarget`, `snapToTargetRaw` helpers
- `finishDayNightSlides`, `resetDayNightSlides`

Keep (still used by ObsValue/Updater):
- `AnimatingValue`, `makeAnimatingValue`
- `startAnimationRaw`, `interpolateValue`, `startValueAnimation`,
  `startLinearAnimation`
- `computeNextBoundary`, `displayTimeToPerfNow`
- Sentinel constants and decoders
- `SCHEDULER_LOOKAHEAD_MS`

---

### Phase 7: Terminator leaves → ObsValues

The terminator subsystem (`terminator.ts`) has its own animation loop
(`TerminatorLeafState` + `tickLeafAnimations` + `resetLeafSchedules`) that
duplicates the eval→animate→interpolate pattern. Port it to ObsValues.

#### Architecture

A single `<terminator>` XML element expands into `4 × leavesPerQuadrant` leaves.
Each leaf has:
- **`angleAnim`** — rotation angle, computed by `terminatorAngle(phase, quad, idx, lpq, incr)`.
  All leaves share the same `phase` input (from the part's `phaseAngle` expression).
- **`rotationAnim`** — system rotation (from `rotation` expression, typically
  `moonRelativePositionAngle`). Shared across all leaves.

Key property: **all leaves evaluate the same two env expressions** (`phaseAngle`
and `rotation`), then each leaf applies `terminatorAngle()` with its own
quadrant/index to compute its individual angle target.

#### Approach

1. **Register `terminatorLeafAngle(phase, quad, idx, lpq, incr)` as an env
   function** in `createWatchEnvironment`. This wraps the existing pure
   `terminatorAngle()` function. For lower quadrants, adds π to the result.

2. **Per-leaf ObsValues in `buildHandValues`:** For each expanded leaf, create:
   - `angle` ObsValue: expression string calls
     `terminatorLeafAngle(phaseAngle(), quad, idx, lpq, incr)`. This composes the
     shared phase expression with the per-leaf `terminatorAngle` math.
   - `rotation` ObsValue: expression is the same `rotation` AST from the
     `TerminatorPart`. Shared AST reference across all leaves — the Updater
     evaluates it once per frame tick (only when the timer fires).

3. **Store ObsValue refs on `TerminatorLeafState`:**
   ```ts
   _obsAngle?: ObsValue;
   _obsRotation?: ObsValue;
   ```
   The renderer reads `leaf._obsAngle.currentValue` and
   `leaf._obsRotation.currentValue` instead of `leaf.currentAngle` /
   `leaf.currentRotation`.

4. **Remove from `engine-entry.ts`:** The `tickLeafAnimations`,
   `finishLeafAnimations`, `resetLeafSchedules`, `anyLeafAnimating` calls are
   replaced by the face's `updater.tick()` / `updater.finish()` /
   `updater.reset()` / `updater.anyAnimating()`.

5. **`updateLeafAngles` stays** (used for static cache building at init time,
   before the Updater exists). It sets `currentAngle`/`currentRotation` directly.

#### [MODIFY] `src/watch/watch-env.ts`

Register `terminatorLeafAngle(phase, quad, idx, lpq, incr)` — wraps
`terminatorAngle` + the lower-quadrant π offset.

#### [MODIFY] `src/watch/hand-values.ts`

In `buildHandValues`, after walking the part tree for QHand/Wheel/etc., iterate
over `face.terminatorLeaves` and create per-leaf `angle` and `rotation` ObsValues.

#### [MODIFY] `src/watch/terminator.ts`

Add optional `_obsAngle` / `_obsRotation` fields to `TerminatorLeafState`.
Mark `tickLeafAnimations`, `finishLeafAnimations`, `resetLeafSchedules`,
`anyLeafAnimating` as deprecated (still present for the static cache path).

#### [MODIFY] `src/watch/renderer.ts`

In `drawTerminator`, read leaf angles from ObsValue refs:
```diff
-leaf.currentAngle = interpolateRaw(leaf.angleAnim, now);
-leaf.currentRotation = interpolateRaw(leaf.rotationAnim, now);
+// Updater already interpolated these; renderer just reads currentValue.
+const angle = leaf._obsAngle?.anim.currentValue ?? leaf.currentAngle;
+const rotation = leaf._obsRotation?.anim.currentValue ?? leaf.currentRotation;
```

#### [MODIFY] `src/engine-entry.ts`

Remove per-frame `tickLeafAnimations` calls (covered by `updater.tick`).
Remove `finishLeafAnimations` / `resetLeafSchedules` / `anyLeafAnimating` calls
(covered by `updater.finish` / `updater.reset` / `updater.anyAnimating`).

---

### Phase 8: Analemma → ObsValues

> [!IMPORTANT]
> **Prerequisite.** Before this phase, the analemma renderer will be refactored
> (in a separate task) to accept a **parametric path parameter** instead of
> pre-computed (x, y) coordinates. This plan only describes the env functions
> and ObsValues; the renderer refactoring is out of scope.

The current analemma computes three values per update: `currentSunX`,
`currentSunY` (Sun's position on the figure-eight path in XML coords), and
`currentRotation` (sky orientation angle). These snap directly (no animation).

#### Parametric approach

Instead of three coordinate-level ObsValues, we use **two parametric ObsValues**:

1. **`pathParameter`** — a fractional day-of-year relative to the vernal equinox
   (0.0–364.999…). The analemma's 365-point path is indexed by this value;
   the renderer interpolates between adjacent path points to get (x, y).
2. **`rotation`** — the sky orientation angle (`sunSkyOrientationAngle` at the
   observer's location).

Benefits:
- **Scale-independent.** The env function returns pure astronomy ("how far
  through the solar year"), with no knowledge of path geometry or scaling.
- **Animatable along the track.** Because the parametric value maps to path
  points, animating between two values moves the Sun marker smoothly *along*
  the figure-eight, not in a straight line between (x₁, y₁) and (x₂, y₂).
  This means the ObsValue can use `evalAhead: true` (not `discrete: true`)
  for smooth animation during scrubbing.

#### Env functions

1. **`analemmaPathParameter()`** — Returns fractional days since the vernal
   equinox reference date (March 20 at 12:00 UT), modulo 365. This is computed
   from the current display time (`getNow()`). During eval-ahead,
   `withDisplayTime` naturally shifts to the future time.

2. **`analemmaRotation()`** — Returns `sunSkyOrientationAngle(di, obsLat, obsLon)`
   for the current display time at the observer's location.

#### ObsValues

- `<face>.analemma.pathParam` — `evalAhead: true`, expression
  `"analemmaPathParameter()"`. Continuous, animatable.
- `<face>.analemma.rotation` — `evalAhead: true`, expression
  `"analemmaRotation()"`. Continuous, animatable.

#### Renderer (after prerequisite refactoring)

The renderer receives the `pathParameter` value, looks up the two adjacent
path points in the pre-computed 365-point array, interpolates to get (x, y)
in XML coords, and draws the Sun marker there. The `rotation` value is
applied as the disc rotation angle. No knowledge of astronomy is needed in
the renderer.

#### File changes (this plan)

##### [MODIFY] `src/shared/astro-env.ts` (or `src/watch/watch-env.ts`)

Register `analemmaPathParameter()` and `analemmaRotation()` as env functions.
`analemmaPathParameter` computes `(noonDI - REF_EPOCH_SECONDS) / 86400 mod 365`
where `noonDI` is 12:00 UT on the current date. `analemmaRotation` wraps
`sunSkyOrientationAngle`.

##### [MODIFY] `src/watch/hand-values.ts`

Create two ObsValues for the analemma (pathParam + rotation).

##### [MODIFY] `src/engine-entry.ts`

Remove `tickAnalemma` / `resetAnalemmaSchedule` calls (covered by Updater).

---

### Docs to update (per Development Rules §1)

- **[animation.md](../docs/animation.md)** — The HandState system section becomes
  a historical note or is removed. The ObsValue Layer section is updated to
  describe Chronometer as a consumer. The `beatsPerSecond` quantization and
  two-time-base architecture sections are updated to reflect the Updater.
- **[architecture-overview.md](../docs/architecture-overview.md)** — Update the
  source layout and import discipline tables. Note that `hand-values.ts` is the
  Chronometer-specific bridge.
- **[observatory.md](../docs/observatory.md)** — Minor update noting Chronometer
  now also uses the shared Updater.
- **[development-rules.md](../docs/development-rules.md)** — §3 (animation-
  preserving pattern) is updated to reference `updater.reset()` instead of
  `HandState` / `initHandStates` / hand schedule resets. §6 (schedule reset
  rules) is similarly updated to reference the Updater's `reset()`.

## Open Questions

All design questions have been resolved — see the Design Decisions section above.

## Verification Plan

### Automated Tests

- `bash build.sh` succeeds.
- Bundle isolation: `grep -c 'observatory/' dist/chronometer-engine.js` → 0.
- TypeScript strict compilation — no `dynamicState` references remain in
  renderer or engine.
- No remaining `tickLeafAnimations`, `tickAnalemma`, `resetLeafSchedules`,
  `resetAnalemmaSchedule` calls in `engine-entry.ts`.

### Manual Verification

- All 25 faces render identically to the current version.
- Second-hand sweep is smooth at the correct rate (matching `beatsPerSecond`).
- **bps=1 faces**: verify the improved eval-ahead timing (hand arrives at target
  exactly on the beat, not after).
- Scrubbing at all rates (sec, min, hr, day, month, year) produces smooth
  animations with correct compression.
- Single-step taps snap correctly.
- Astro steps animate smoothly to the new position.
- Stopped state is fully idle (no re-evaluation, no rAF busy-loop).
- Resuming from stop animates smoothly.
- Location change triggers smooth animation to new positions.
- Body switch (Venezia) animates smoothly.
- Vienna noon/midnight toggle: day/night ring rotates smoothly, all dials flip.
- Kyoto wadokei toggles: hand mode and rate mode, day/night wedges slide
  in/out correctly, masterOffset rotates.
- Terra/Gaia world-time displays update correctly.
- Calendar covers (Milano, Hana) slide correctly during month transitions.
- DST transitions are handled correctly (environment rebuild, schedule reset).
- **Moon terminator** phases render correctly on all faces with terminators
  (Haleakalā, Mauna Kea). Leaf animation is smooth during scrubbing.
  Static block caches rebuild correctly after env changes.
- **Analemma** (Mauna Kea): Sun marker position and sky rotation update at the
  correct interval. Sun tracks smoothly along the figure-eight during scrubbing
  (prerequisite: analemma parametric refactoring completed before this phase).
- FPS indicator (`?fps`) shows expected render/idle behavior.
