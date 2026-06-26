# Port Chronometer to the ObsValue System

**Date:** 2026-06-15
**Status:** ✅ **Implemented** (2026-06-26). All 8 phases landed. Notable
deviation from the draft: **eval-ahead is OFF for Chronometer**
(`EVAL_AHEAD = false` in `hand-values.ts`) — it turned ticking watches into
continuous sweeps, kept the 1× loop from idling, and thrashed the astro cache
during scrub (evaluating a full interval ahead while terminator/static evaluate at
`now`). The non-eval-ahead branches (snap-at-boundary / scrub-compression) are
modeled on the legacy `tickAnimations` and restore ticks, 1× idle, and single-time
astronomy. A future "do eval-ahead properly" (on-beat scheduling + worker pipeline)
is captured separately in
[2026-06-26-worker-eval-ahead-pipeline.md](2026-06-26-worker-eval-ahead-pipeline.md).
The regression test-bench was migrated to the Updater path and goldens re-captured.

> **Revision 5 (code-grounded review).** Reconciled the plan with the current
> source. Material changes:
> 1. **`beatsPerSecond` + eval-ahead wiring corrected** — the Chronometer env
>    currently captures `makeGetNow(bps)` built directly on `rawGetNow`, *not* on
>    an overridable seam, so eval-ahead could not shift the env's evaluation time
>    as written. The fix (per-face overridable base, with the quantizer layered on
>    top) is now spelled out. See *“`beatsPerSecond` quantization + eval-ahead
>    seam”*.
> 2. **QDayNightRing wedge angles** — the renderer's wedge-angle computation is
>    *collective* (depends on `numVis`, the night-arc distribution, parking, and
>    polar special-cases), not a set of independent per-wedge functions. The env
>    function therefore computes the whole distribution once and memoizes it per
>    display-time so the 24 same-schedule ObsValues don't each redo it. See
>    *“QDayNightRing — collective wedge computation”*.
> 3. **Transition callbacks vs. the stopped-clock freeze** — Chronometer cannot
>    use the generic `initTimeControls({ updater })` auto-reset seam unconditionally:
>    several transitions must `finish()` then **conditionally** `reset()` (skipping
>    reset while stopped) to preserve the stopped-clock freeze (§6 /
>    `planning/2026-06-03-stopped-clock-rendering.md`). The plan keeps explicit
>    callbacks. See *“Transition handling — finish + conditional reset”*.
> 4. **Analemma prerequisite is DONE** — `analemma.ts` is already parametric
>    (`currentPathParameter` + `currentRotation`), so Phase 8 is unblocked and is
>    updated to match the implemented field names.
> 5. **Terminator is drawn live — remove its static-cache rebuild.** Verified on
>    every face that `<terminator>`/`<analemma>` are top-level parts *outside* any
>    `<static>` block, so they render live each frame. The periodic
>    `buildStaticBlockCaches` rebuild gated on terminator presence is wasted work
>    and is removed along with `tickLeafAnimations`. No new render cache is added.
>    (Corrects an earlier revision-5 draft that wrongly kept the rebuild.)
> 6. **bps=1 eval-ahead timing change accepted** (owner sign-off): hands arrive on
>    the beat. This is the one intended visible change.
> 7. **No non-astro value caches** — audited every cache; the port deletes all
>    per-frame value caches (QDayNightRing wedge angles independently recompute over
>    astro-cached scalars). Only init-time-constant bitmaps and the `<static>`
>    layer cache remain. See *“No non-astro value caches”*.
> 8. **Cyclic shortest-path generalized** — the `linear` boolean becomes a
>    `period` (`2π` = angle, `Infinity` = linear, `PATH_SAMPLE_COUNT` = analemma),
>    so the equinox wrap reuses the angle seam logic. CalendarRowCover slides
>    (`linear`, **not** `discrete`). See *“Cyclic values …”*.

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
— the shared UI auto-calls `updater.reset()` on every transition. **For
Chronometer this is necessary but not sufficient** (see *“Transition handling —
finish + conditional reset”*): several Chronometer transitions must `finish()`
(snap + freeze) and then *conditionally* `reset()` to preserve the stopped-clock
freeze, so Chronometer keeps explicit transition callbacks rather than relying on
the generic auto-reset alone.

## Design Decisions (resolved)

### Cyclic values — generalize the angular shortest-path

> [!NOTE]
> **Revision 5 (added in review).** The analemma path parameter is **cyclic**
> (period `PATH_SAMPLE_COUNT`), not linear — the equinox rollover 999→0 is the
> same "wrong way around" problem as a hand sweeping 359°→0°. Rather than
> special-case it, generalize the angular shortest-path logic to an arbitrary
> period.

Today the animation core branches on a boolean `linear`
([animation.ts:765-811](../src/shared/animation.ts)): angles (`linear` false)
unwrap to the shortest path mod `2π`; linear values (`linear` true) interpolate
straight. Replace the boolean with a **`period`**:

| `period` | behavior | maps from |
|----------|----------|-----------|
| `2π` | angle (shortest path mod 2π) | `linear: false` |
| `Infinity` (or undefined) | straight-line, no wrap | `linear: true` |
| `PATH_SAMPLE_COUNT` | analemma path param | (new) |

Each `2π` literal becomes `period`: the unwrap
(`delta -= period · round(delta / period)`), the on-completion wrap
(`fmod(result, period)`), and the scrub shortest-path delta (normalize mod
`period`, shortest ≤ `period/2`). **`period = 2π` reproduces today's angle math
bit-for-bit**, so Observatory/Inspector behavior is unchanged.

- **Scope.** This touches the *shared* `animation.ts` / `updater.ts`, used by all
  three apps. Keep the public `ObsValue.linear` flag (maps to `period: Infinity`);
  add an optional `ObsValue.period?: number` (default `2π` when not linear) so
  only the analemma `pathParam` sets a non-2π period.
- **Test.** Add a unit test asserting an angle value animates the short way across
  the 0/2π seam (guards the `period = 2π` equivalence), and one for a cyclic value
  with a non-2π period crossing its seam.
- **Lands with Phase 5** (the other shared-core change), before Phase 8 needs it.

### Eval-ahead for all values

All Chronometer ObsValues use `evalAhead: true`. This is the forward-looking
mechanism and subsumes the legacy snap-to-target and scrub-compression branches.
**No Chronometer value is `discrete`** — every quantity animates (including
CalendarRowCover, which slides; see below). `discrete` is an Inspector-only
text-readout policy.

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

### No non-astro value caches

**Principle (owner-confirmed):** the only expensive computations are in the
astronomy code, which already caches via the `AstroCachePool`. Nothing in the
Chronometer layer should cache *computed values*. If a hot astronomy quantity
isn't cached, the fix is a new astro-cache slot, never a value cache in the env,
renderer, or part.

Audit of every current non-astro cache and its disposition after the port:

| Cache | Kind | Disposition |
|-------|------|-------------|
| `_cachedAngles` / `_cacheStart` / `_cacheNextUpdate` (QDayNightRing) | per-frame **value** cache of wedge angles | **Deleted.** Wedge angles recompute over astro-cached scalars (see *“independent per-wedge angles”*). |
| `_masterOffsetAnim` / `_wedgeAngleAnims` / `_wedgeSlides` | per-part animation state | **Replaced** by ObsValues. |
| Periodic terminator `buildStaticBlockCaches` rebuild | wasted (terminator is live) | **Removed.** |
| `_cacheNumVis` (QDayNightRing) | part of the angle cache | **Deleted** with `_cachedAngles`. |
| `<static>` block bitmaps (`part.cachedCanvas`) | render-layer bitmap of *static* content | **Kept.** Web analog of iOS's retained CALayer backing store; holds only non-animated content (numerals, decals, baked window cutouts), rebuilt on mode/date/tz/resize — not per frame, not a value cache. |
| Hand-shadow bitmaps (`buildHandShadowCaches`) | init/resize-only constant bitmaps | **Kept.** Time-independent. |
| Analemma `channel`/`bg`/`sun` bitmaps | init-time constant bitmaps | **Kept.** Time-independent. |

Net: the port **removes** every per-frame value cache; the only caches left are
init-time-constant bitmaps and the structural `<static>` layer cache, none of
which recompute astronomy.

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

### Transition handling — finish + conditional reset

> [!IMPORTANT]
> **Revision 5 correction.** The draft implied the generic `updater` seam
> replaces the transition callbacks. It cannot, because Chronometer's current
> callbacks ([engine-entry.ts:2332-2364](../src/engine-entry.ts)) do two things
> the generic seam does not:
> 1. **`finish()` before `reset()`** on step / now / transport / scrub-end, so
>    hands snap to their final positions instead of freezing mid-sweep.
> 2. **Skip `reset()` while stopped.** `onScrubEnd` / `onTransportChange` re-arm
>    schedules *only* when `!timeController.isStopped`; otherwise the freeze from
>    `finish()` must stay, or hands re-evaluate every frame while stopped (the
>    stopped-clock idle regression — `planning/2026-06-03-stopped-clock-rendering.md`,
>    Development Rule §6).

**Decision.** Keep explicit per-transition callbacks; map them onto the Updater:

| Callback | Today | After port |
|----------|-------|-----------|
| `onTimeStep` | `finishAllAnimations(); resetAllSchedules()` | `forEachFace(finish); forEachFace(reset)` |
| `onScrubStart` | `resetAllSchedules()` | `forEachFace(reset)` |
| `onScrubEnd` | `rebuildEnvironments(); finish; if(!stopped) reset` | same, via Updater |
| `onNowClicked` | `finish; reset; restart scheduler` | same, via Updater |
| `onTransportChange` | `rebuildEnvironments(); finish; if(!stopped) reset` | same, via Updater |

where `finish`/`reset` call `face.updater.finish()` / `face.updater.reset()`.
Whether to *also* pass the generic `updater` field to `initTimeControls` is an
open call: if the shared UI's auto-`reset()` fires unconditionally it would
re-arm while stopped and defeat the freeze, so the safe default is **not** to pass
it and to drive everything from the explicit callbacks. Confirm during Phase 4 by
checking each `updater?.reset()` call site in `time-controls-ui.ts` against the
stopped state.

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

### QDayNightRing — independent per-wedge angles (no array cache)

> [!NOTE]
> **Revision 5 (corrected after review).** An earlier draft of this section
> proposed memoizing the whole wedge-angle array. That is unnecessary — wedge `i`'s
> angle is independently computable, and everything expensive is already in the
> astro cache. **No per-frame array cache is introduced; the existing
> `_cachedAngles` / `_cacheStart` / `_cacheNextUpdate` value cache is deleted.**

Wedge `i`'s angle is `dayNightWedgeAngle(planetNumber, i, numWedges)`:

- **Normal mode** (Mauna Kea, Vienna): `leafAngleFn(planet, i, numWedges)` —
  a pure function of `i`, `numWedges`, and observer astronomy. The astronomy is
  cached: `dayNightLeafAngle` routes through `getPlanetRiseSetCache` /
  `computeDayNightLeafAngle` with the astro `pool`
  ([astro-env.ts:1714](../src/shared/astro-env.ts)).
- **Slide mode** (Kyoto): the renderer's distribution
  ([renderer.ts:2731-2788](../src/watch/renderer.ts)) depends on the set **only**
  through three shared scalars — `numVis` (`wadokeiDNNumVisible`), `sunsetAngle`,
  `sunriseAngle` (`wadokeiDNSunsetAngle/SunriseAngle`) — each of which bottoms out
  in the astro-cached `dayNightLeafAngle`. Given those scalars, wedge `i` is O(1)
  arithmetic (`adjustedStart + step·i`, parked wedges at the sunrise edge). So the
  function recomputes the scalars (astro-cache hits — all `numWedges` calls in a
  tick share one display instant) and returns element `i`. The slide / polar /
  normal branches move **verbatim** into the env function (Development Rule §2 —
  no simplification of the math).

`dayNightWedgeSlide(wedgeIndex, numWedges, slideDistance)` likewise reads `numVis`
from the same astro-cached scalars and returns `wedgeIndex < numVis ? 0 : slideDistance`.

- Angle ObsValues: `evalAhead: true, linear: false`. Slide ObsValues:
  `linear: true` (**not** `discrete` — they slide smoothly).
- **`masterOffset` stays a separate ObsValue** and is **not** folded into the
  wedge angles — the renderer keeps adding `masterOffset + wedgeAngle[i]` at draw
  time (wedge ObsValues are observer-frame angles).

> [!NOTE]
> If profiling ever shows the per-wedge scalar recomputation is hot (it shouldn't
> be — astro-cache hits + arithmetic), the fix is an **astro** cache slot for the
> missing quantity, never a new value cache in the env or renderer.

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
3. The ObsValue uses `evalAhead: true, linear: true` (**not** `discrete`). The
   cover must **slide** smoothly into place across a month transition, matching
   today's `startLinearAnimation` behavior ([animation.ts:1257-1260](../src/shared/animation.ts));
   `discrete` would snap it. `linear: true` skips angular wrapping (it's a pixel
   offset). `evalAhead` lets it animate to the new offset over the budget when the
   month rolls over (including during scrub).

### `beatsPerSecond` quantization + eval-ahead seam

> [!IMPORTANT]
> **This is the central wiring correction in revision 5.** For eval-ahead to
> work, `withDisplayTime(future, …)` must shift the *same* time source the env's
> astro functions read through. Observatory gets this for free because its env
> captures the overridable `getNow` directly
> ([observatory-entry.ts:144-145](../src/observatory/observatory-entry.ts)).
> Chronometer does **not**: today each face's env captures
> `makeGetNow(bps)`, which quantizes `rawGetNow = timeController.getDisplayTime`
> *directly* ([engine-entry.ts:528-536, 705](../src/engine-entry.ts)). A
> separate overridable wrapper would not be seen by the env, so eval-ahead would
> silently no-op.

**The fix — layer the quantizer on top of the overridable base, per face:**

```ts
// Per face, at Updater construction (in buildHandValues):
const { getNow: rawOverridable, withDisplayTime } =
    makeOverridableGetNow(rawGetNow);            // base = timeController.getDisplayTime
const faceGetNow = quantize(rawOverridable, bps); // the env captures THIS
```

- The **env** captures `faceGetNow` (quantized) — every astro/angle function sees
  quantized display time, exactly as today.
- The **Updater** receives `getNow = rawOverridable` (unquantized) for
  *scheduling* — `computeNextBoundary` must use unquantized time, matching iOS
  (boundaries in iPhone time, not latched watch time). It also receives
  `withDisplayTime`.
- When the eval-ahead pass calls `withDisplayTime(futureMs, () => evalAttr(expr, env))`,
  `rawOverridable` returns the future instant, `faceGetNow` quantizes it, and the
  env evaluates the target at the **quantized future boundary** — correct.

There is one `makeOverridableGetNow` (hence one `withDisplayTime`) **per face**,
which is natural since there is one `Updater` per face. The existing
`makeGetNow(bps)` quantizer logic is reused; only its *base* changes from
`rawGetNow` to the per-face `rawOverridable`.

> [!NOTE]
> `rebuildEnvironments()` / `handleDstTransition()` recreate `face.env` via
> `createWatchEnvironment(... makeGetNow(bps) ...)`. After the port these must
> pass the face's `faceGetNow` (built on the persistent `rawOverridable`), and
> must **not** allocate a fresh overridable seam — otherwise the Updater's
> `withDisplayTime` and the new env would diverge. The `rawOverridable` /
> `withDisplayTime` pair is owned by the face for its lifetime; only the
> quantizing env closure is rebuilt.

## Per-value mapping

Each Chronometer dynamic part produces these ObsValues:

| Part type | Properties | Flags |
|-----------|-----------|-------|
| **QHand** | `angle`, optional `offsetAngle`, `xMotion`, `yMotion` | `evalAhead`, `linear` for x/yMotion |
| **Wheel** | `angle` | `evalAhead` |
| **QWedge** | `angle`, optional `offsetAngle` | `evalAhead` |
| **QDial** (animated) | `angle` | `evalAhead` |
| **QDayNightRing** | `masterOffset` + per-wedge `wedgeAngle.<N>` + per-wedge `wedgeSlide.<N>` | `evalAhead` for angles, `linear` for slides |
| **CalendarRowCover** | `xMotion` | `evalAhead: true, linear: true` (slides smoothly; **not** discrete) |

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
   freeze schedules. For each value: clear `pendingSweep`; set
   `anim.currentValue = anim.targetValue` (wrapped via `fmod(…, period)` when the
   value is cyclic, matching `finishAnimations`); set `anim.animating = false`;
   **also write `v.currentValue`** so the renderer reads the settled value; set
   `nextUpdateDisplayTime = nextUpdateTime = Infinity`. Used for step events and
   transport transitions where the system must settle immediately. (Mirrors the
   existing `finishAnimations` in `animation.ts`, generalized to `period` and the
   `pendingSweep`/`currentValue` fields ObsValue adds.)

2. **`Updater.nextWakeupTime(): number`** — Return the minimum `nextUpdateTime`
   across all values (`Infinity` if none). Used by the idle scheduler to set a
   precise `setTimeout`. Equivalent to the existing `nextWakeupTime(states)`.

> [!NOTE]
> Both are thin wrappers over the existing module-level helpers' logic, kept on
> the `Updater` class so Chronometer reads them per-face. Observatory/Inspector do
> not call them today, so adding them is additive (no behavior change there).

#### [MODIFY] `src/shared/animation.ts` + `src/shared/obs-value.ts`

Generalize the `linear` boolean to a **`period`** (see *“Cyclic values —
generalize the angular shortest-path”*): `2π` = angle, `Infinity` = linear,
arbitrary = cyclic. `startAnimationRaw`, the completion wrap, and the scrub
shortest-path delta parameterize on `period`; `period = 2π` is bit-identical to
today. `ObsValue` keeps `linear` (→ `period: Infinity`) and gains optional
`period?: number` (default `2π`). Only the analemma `pathParam` sets a non-2π
period. Add the two seam-crossing unit tests noted in the design decision.

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

6. **Remove the periodic static-cache rebuild for the terminator.** Verified
   across all faces: every `<terminator>` is a **top-level part outside any
   `<static>` block** (geneva, chandra, venezia, babylon, gaia, hana, selene), so
   it is drawn **live** each frame via `renderPartsDocumentOrder`
   ([renderer.ts:701-703](../src/watch/renderer.ts)) — never baked into a static
   cache. The `terminatorLeaves` argument to `buildStaticBlockCaches` only draws
   when a terminator sits *inside* a `<static>` block, which no face does. The
   per-frame rebuild gated on `terminatorLeaves.length > 0`
   ([engine-entry.ts:1076-1094](../src/engine-entry.ts)) therefore rebuilds caches
   that don't contain the terminator — wasted work. After the port the leaves draw
   live from their ObsValue `currentValue`, and **both** `tickLeafAnimations`
   **and** the periodic `buildStaticBlockCaches` rebuild are removed. (The
   `terminatorLeaves` param to `buildStaticBlockCaches` can stay for the
   theoretical in-static case but is a no-op on every shipping face.)

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
**Also remove the periodic `buildStaticBlockCaches(..., terminatorLeaves)` rebuild
and `face.lastTerminatorRebuild` bookkeeping** ([engine-entry.ts:1076-1094](../src/engine-entry.ts)):
the terminator is drawn live (it is never inside a `<static>` block on any face),
so the rebuild does nothing useful. The `updateLeafAngles` static-path call in
`buildCache` / `handleDstTransition` stays (it feeds the live draw's initial
positions before the Updater's first tick).

---

### Phase 8: Analemma → ObsValues

> [!NOTE]
> **Prerequisite DONE (revision 5).** The analemma renderer has already been
> refactored to the parametric form. `analemma.ts` now stores
> `currentPathParameter` (fraction-of-year × `PATH_SAMPLE_COUNT`, range
> `[0, PATH_SAMPLE_COUNT)`) and `currentRotation`, and `drawAnalemma` derives the
> Sun (x, y) at draw time via `pathParamToXY(state.pathScaled, currentPathParameter)`
> ([analemma.ts:584-604, 754-764](../src/watch/analemma.ts)). Phase 8 is therefore
> unblocked — it only needs the two env functions + two ObsValues + ObsValue-ref
> reads in the renderer.

The analemma currently computes two values per update (`tickAnalemma` →
`updateAnalemmaValues`): `currentPathParameter` (Sun's position *along* the
figure-eight, from `fractionOfVernalEquinoxYear(di) * PATH_SAMPLE_COUNT`) and
`currentRotation` (sky orientation, from `sunSkyOrientationAngle`). Both snap
directly today; the ObsValue port makes them animate.

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

- `<face>.analemma.pathParam` — `evalAhead: true`, **cyclic with
  `period: PATH_SAMPLE_COUNT`** (see *“Cyclic values — generalize the angular
  shortest-path”*), expression `"analemmaPathParameter()"`. Continuous, animatable.
- `<face>.analemma.rotation` — `evalAhead: true` (angle, `period: 2π`),
  expression `"analemmaRotation()"`. Continuous, animatable.

The renderer reads `state._obsPathParam.currentValue` /
`state._obsRotation.currentValue` instead of `state.currentPathParameter` /
`state.currentRotation`. `pathParamToXY` already mods by the path length, so it
tolerates an unwrapped `currentValue` mid-animation.

> [!NOTE]
> **Year-boundary wrap is handled by `period`, not a special-case.** The path
> parameter is cyclic with period `PATH_SAMPLE_COUNT`, exactly analogous to an
> angle's `2π`. With the generalized animation (below) the equinox rollover
> 999→0 takes the short way forward, just like 359°→0° on a hand — no snap, no
> bespoke edge handling.

#### Renderer (after prerequisite refactoring)

The renderer receives the `pathParameter` value, looks up the two adjacent
path points in the pre-computed 365-point array, interpolates to get (x, y)
in XML coords, and draws the Sun marker there. The `rotation` value is
applied as the disc rotation angle. No knowledge of astronomy is needed in
the renderer.

#### File changes (this plan)

##### [MODIFY] `src/shared/astro-env.ts` (or `src/watch/watch-env.ts`)

Register `analemmaPathParameter()` and `analemmaRotation()` as env functions,
reusing the **exact** math already in `updateAnalemmaValues`
([analemma.ts:584-604](../src/watch/analemma.ts)) so values match bit-for-bit:
- `analemmaPathParameter()` = `fractionOfVernalEquinoxYear(di, null) * PATH_SAMPLE_COUNT`,
  where `di = dateToDateInterval(getNow())`. (`PATH_SAMPLE_COUNT` must be shared,
  not re-hardcoded — export it from `analemma.ts`.)
- `analemmaRotation()` = `sunSkyOrientationAngle(di, obsLat, obsLon, null)`.

During eval-ahead, `getNow()` inside `withDisplayTime` already shifts `di` to the
future instant — no special handling needed.

##### [MODIFY] `src/watch/analemma.ts`

Add optional `_obsPathParam?: ObsValue` / `_obsRotation?: ObsValue` refs to
`AnalemmaState`. `drawAnalemma` reads `currentValue` from them when present,
falling back to `state.currentPathParameter` / `state.currentRotation` for the
static/init path (before the Updater exists). `expandAnalemma`'s initial
`updateAnalemmaValues` call stays (seeds the first frame). Export
`PATH_SAMPLE_COUNT`.

##### [MODIFY] `src/watch/hand-values.ts`

Create two ObsValues for the analemma (pathParam + rotation), store the refs on
`AnalemmaState`. Keyed `<face>.analemma.pathParam` / `<face>.analemma.rotation`.

##### [MODIFY] `src/engine-entry.ts`

Remove `tickAnalemma` / `resetAnalemmaSchedule` calls (covered by `updater.tick`
/ `updater.reset`). Note the existing per-frame `if (tickMs !== null)
resetAnalemmaSchedule(...)` forced-update hack ([engine-entry.ts:1097-1100])
disappears — eval-ahead handles scrub natively.

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

Most design questions are resolved (Design Decisions above). Revision 5 leaves
one small item to confirm **during implementation**, not blocking:

1. **Generic `updater` seam vs. stopped freeze** — the shared UI calls
   `updater.reset()` immediately before each transition callback (~9 sites). Since
   Chronometer's callbacks run last and call `finish()`, passing `updater` is
   *redundant* rather than broken — but the safe default is **not** to pass it and
   to drive reset/finish purely from the explicit callbacks (see *“Transition
   handling — finish + conditional reset”*). Confirm by eyeballing each
   `updater?.reset()` site in `time-controls-ui.ts` during Phase 4.

Resolved in review:
- QDayNightRing wedge angles need **no** memo/array cache — each wedge is
  independently computable over astro-cached scalars (*“QDayNightRing — independent
  per-wedge angles”*).
- The analemma equinox wrap is handled by the generalized **`period`** (cyclic
  shortest-path), not a special-case (*“Cyclic values — generalize the angular
  shortest-path”*).

## Suggested sequencing

Phases are ordered so the build stays green and each phase is independently
verifiable:

- **Phase 1** (CalendarRowCover env fn) and **Phase 5** (`Updater.finish` /
  `nextWakeupTime`) are self-contained and can land first.
- **Phases 2–4** are the core swap (build values → renderer reads ObsValue refs →
  engine drives `updater.tick`); they must land together since they retire
  `dynamicState`. The **`beatsPerSecond` seam** rewiring is the riskiest single
  step — do it first within Phase 2 and verify a simple bps=1 face (e.g. a plain
  hands face) before touching QDayNightRing.
- **QDayNightRing** (within 2–4) is the hardest; verify Vienna (masterOffset
  toggle) and Kyoto (slide/polar) explicitly.
- **Phase 7** (terminator) and **Phase 8** (analemma) are additive subsystems;
  land each after the core is stable.
- **Phase 6** (delete dead code) is last.

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
