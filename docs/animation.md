# Animation

The animation system manages how watch hands move between their computed positions, supporting both real-time ticking and accelerated time scrubbing.

## iOS/Android Reference

> **Prerequisites**: Run `scripts/clone-refs.sh` to clone the reference repos. See [ios-reference.md](ios-reference.md).

| Repo | Key files |
|------|-----------|
| `.chronometer-ref/` | `Classes/ECGLPart.m` (animation interpolation, `kECGLAngleAnimationSpeed`), `Classes/ECWatchController.m` (update scheduling) |

## `beatsPerSecond` — Time Quantization

Each watch declares `beatsPerSecond` on its `<watch>` element. This controls the granularity of the time that expressions see, mirroring the behavior of a physical watch mechanism:

| `beatsPerSecond` | Effect | Faces |
|---|---|---|
| `0` | No quantization — fully continuous sweep | Firenze, Chandra, Miami, Venezia, Selene |
| `1` | Snap to whole seconds — tick-tick second hand | Babylon, Haleakala, Hana |
| `8` | Snap to 1/8 s — smooth sweep at 8 Hz | Terra, Gaia |
| `10` | Snap to 1/10 s — smooth sweep at 10 Hz | Geneva, Basel, Mauna Kea |

The default is `0` (continuous), matching iOS (`ECWatchDefinitionManager.m`, `df:0`).

**Implementation**: `makeGetNow(bps)` in `engine-entry.ts` wraps the raw `timeController.getDisplayTime()` with quantization, mirroring iOS `latchTimeForBeatsPerSecond`:
```typescript
const quantizedMs = Math.round(ms / 1000 * bps) / bps * 1000;
```
Each face gets its own quantized `getNow` closure, passed to `createWatchEnvironment` (for expression evaluation) and as the `getNow` parameter of `initHandStates`. A separate **unquantized** `rawGetNow` is also passed to `initHandStates` for boundary scheduling (see below).

> [!IMPORTANT]
> **Boundary scheduling must use raw (unquantized) time.** The quantized `getNow` is only for expression evaluation — determining *what* angle a hand should show. The `rawGetNow` is used by `computeNextBoundary` and `displayTimeToPerfNow` to determine *when* the next update fires. This matches the iOS architecture where `ECDynamicUpdate.getNextUpdateTimeForInterval` computes boundaries in "iPhone time" (real device time), not in latched/quantized watch time.
>
> **Why this matters**: With `bps=1`, `Math.round` snaps the displayed time to the nearest whole second, which can be up to 0.5s ahead of real time. If `computeNextBoundary` uses this quantized time, `Math.ceil` of an already-aligned value returns the current time (not the next boundary), producing a zero delta and causing every-frame re-evaluation. The hand then ticks 0.5s before faces with `bps=0`, creating visible inter-face skew.

## Two-Time-Base Architecture

The system uses two independent time bases:

| Time Base | Source | Used For |
|-----------|--------|----------|
| **Display time** | `getNow()` → `makeGetNow(bps)` → `timeController.getDisplayTime()` | Evaluating angle expressions — determines **what** the target position should be |
| **Real time** | `performance.now()` | Animation interpolation — determines **where** the hand is drawn right now |

These must never be conflated. Display time can jump by hours/days per tick; real time always advances smoothly at 1:1.

## Core Types

```typescript
interface AnimatingValue {
    currentValue: number;       // What we render right now
    targetValue: number;        // Where we're heading
    lastAnimationTime: number;  // performance.now() at last interpolation step
    animationStopTime: number;  // When animation should be complete
    animating: boolean;         // Is an animation in progress?
}

interface HandState {
    part: QHandPart | WheelPart | QWedgePart;
    angle: AnimatingValue;
    offsetAngle: AnimatingValue | null;   // For orbit hands (e.g. Moon)
    xMotion: AnimatingValue | null;       // Linear X translation (calendar wires)
    yMotion: AnimatingValue | null;       // Linear Y translation (calendar wires)
    updateIntervalMs: number;             // From XML update attr
    nextUpdateTime: number;               // performance.now() for next re-eval
    animSpeed: number;                    // From XML animSpeed attr (default 1.0)
    getNow: () => Date;                   // Display time source (quantized) — for expressions
    rawGetNow: () => Date;                // Unquantized time — for boundary scheduling
}
```

## Update Interval (`update` attribute)

Controls **how often** a hand's angle expression is re-evaluated:

| Example | Meaning |
|---------|---------|
| `update="1"` | Every 1 second (second hand, sun/moon hands) |
| `update="60"` | Every 60 seconds (hour hand, AM/PM wheel) |
| `update="1/60"` | 60× per second (subsecond smooth sweep) |
| `update="1 * days()"` | Once per day (date/month/weekday wheels) |
| No `update` | Defaults to `1/beatsPerSecond` |

Updates fire on **local-time-aligned clock boundaries**, not relative to page load. The alignment formula shifts by the watch's timezone offset (iOS: `ECDynamicUpdate.m` line 192), so a daily update (`1 * days()`) fires at **local midnight**, not UTC midnight.

**Sentinel-based scheduling**: Named sentinel values (e.g., `updateAtNextSunriseOrMidnight`) compute the true next astronomical event time (sunrise, sunset, moonrise, moonset) in display time and schedule the part to re-evaluate at that boundary. The `OrMidnight` variants clamp the event time to the next local midnight, so the part updates at whichever comes first. This works correctly in forward, backward (-1×), and quantized (scrubbing) modes. See `computeNextBoundary()` and `resolveSentinel()` in `animation.ts`.

> **Battery-driven parts**: A part whose angle reads `batteryLevel()` should use the `update` mechanism to re-evaluate no more than about once per minute (Milano's power-reserve hand uses `update='60'`). Battery level changes slowly, so a coarse interval avoids needless re-evaluation/animation churn. The async `levelchange` listener (in `astro-env.ts` / `watch-env.ts`) only refreshes the cached value — it does not itself trigger a re-eval; the value is picked up on the part's next scheduled update.

## Animation Speed (`animSpeed` attribute)

Controls **how** the hand moves to its new position:

- `animSpeed="0"` or absent → snap instantly
- `animSpeed="2.0"` → animate at 2× base speed
- Default is `1.0` if not specified

The animation is **linear interpolation**: although the per-frame code updates `lastAnimationTime` and uses `(target - current) * fraction`, the math works out to constant per-frame displacement since remaining time and remaining distance decrease proportionally.

### Animation Direction (`animationDir`)

For circular values, controls which direction to sweep:
- `ECAnimationDirClosest` (default) — shortest path
- `ECAnimationDirAlwaysCW` — always clockwise
- `ECAnimationDirAlwaysCCW` — always counter-clockwise
- `ECAnimationDirFurthest` — long way around

### Wrap-Around Handling

`startAnimationRaw` normalizes targets to `[0, 2π)` and unwraps `currentValue` so the delta is in `[-π, π]`:

```typescript
let delta = newTarget - val.currentValue;
delta = delta - TWO_PI * Math.round(delta / TWO_PI);  // normalize to [-π, π]
val.currentValue = newTarget - delta;  // unwrap so animation goes shortest path
```

## Modes of Operation

### 1× Mode (Normal / Real Time) and -1× Mode (Reverse)

- `tickIntervalMs = null`
- Expressions re-evaluate at local-time-aligned boundaries
- Animations use natural speed (`kECGLAngleAnimationSpeed × animSpeed`)
- No compression logic
- Both directions use the same idle-timeout scheduler; `nextAlignedUpdate()` is direction-aware, using `Math.ceil` (forward) or `Math.floor` (backward) to find the next boundary in the direction time is flowing

### Quantized Mode (Scrubbing / Accelerated)

Used for hold-to-scrub at rates like 10 hr/s, 10 day/s:

- Display time jumps in fixed steps on each tick (10 Hz tick rate, 100ms intervals)
- **Adaptive compression**: If natural animation duration exceeds the tick interval, compress to fit. Otherwise, use natural speed.
- **Independent compression**: `angle`, `offsetAngle`, `xMotion`, and `yMotion` are all compressed independently
- **Schedule skipping**: Slow-updating parts skip ticks where their expression wouldn't change

**Decision rule** for each hand update:
1. `ticksUntilUpdate = ceil(part.updateIntervalSec / displayDeltaPerTick)`
2. `timeUntilNextUpdate = ticksUntilUpdate × TICK_INTERVAL_MS`
3. `normalDuration = delta / (speed × animSpeed)` — where speed is angular or linear
4. If `normalDuration ≤ timeUntilNextUpdate` → use normal speed
5. If `normalDuration > timeUntilNextUpdate` → compress to `timeUntilNextUpdate`

### Single-Step Mode

- Triggered by a single tap on a step button
- **Stops time first** (`timeController.stop()`) and snaps in-flight animations (`finishAllAnimations()`), matching scrub behavior
- Then calls `timeController.step()`, `resetHandSchedules`, and `tickAnimations` once
- Animations use natural speed (no compression)
- `ensureSchedulerRunning()` keeps the rAF loop running while `anyAnimating` is true

### Astro Step Mode

- Triggered by tapping a ◀/▶ button on the **Astro tab** of the time controller
- Jumps to the next/previous occurrence of an astronomical event (sunrise, sunset, moonrise, moonset, moon phase, transit)
- **Flow**: `stop()` → `finishAllAnimations()` → `setTime(targetDate)` → `beginFrame()` → `tickAnimations()` per face → `endFrame()` → `startScheduler()`
- Uses `computeAstroTarget()` (in `src/watch/astro-stepper.ts`) to find the event time
- **Degree/radian conversion**: `lat`/`lon` are stored in degrees in `engine-entry.ts` but the astronomy routines expect radians; the handler converts with `× Math.PI / 180`
- **Invalid date guard**: If the astro computation returns `null` or `NaN`, the button flashes red and no time change occurs (prevents time controller corruption)
- **Venezia body swap**: On single-face Venezia, the moonrise/moonset/moon-transit rows are replaced with body-aware versions that use the currently selected planet. The body param propagates to navigation links via `updateNavigationLinks()`

#### Astro Event Search Algorithms

| Event | Function | Source |
|-------|----------|--------|
| Sunrise/Sunset | `findNextRiseSet()` | Ports iOS `nextPrevRiseSetInternal` via `planetaryRiseSetTimeRefined` |
| Moonrise/Moonset | `findNextRiseSet()` | Same as above with `ECPlanetNumber.Moon` |
| Moon Phase | `findNextQuarterPhase()` | Ports iOS `nextMoonPhase()` / `prevMoonPhase()` using `refineMoonAgeTargetForDate` |
| Sun/Moon Transit | `findNextTransit()` | Uses `planettransitTimeRefined` with 12-hour fudge to avoid same-transit convergence |
| Body Rise/Set/Transit | Same as above | Uses the selected body's `ECPlanetNumber` from Venezia's planet selector |

## Hold-Scrub Time Preservation

When holding a step button, `timeController.setRate()` starts quantized scrubbing. The rate activation includes a `snapToUnit()` call that aligns to the nearest boundary.

**Problem**: For rates above seconds, `snapToUnit` zeroes sub-unit time fields (minutes, seconds), causing hands to jump.

**Solution**: Only snap for the `second` rate (zeroing milliseconds). For all other rates, preserve current time exactly and start ticking from there. Since `advanceByUnit()` preserves sub-unit fields (e.g., adding 1 day preserves HMS), all subsequent ticks maintain correct time-of-day.

## Transition Behavior

| Transition | What happens |
|-----------|--------------|
| **Single tap** | Stop time, snap in-flight animations, step by one unit, animate at natural speed |
| **Astro tap** | Stop time, snap in-flight, compute next event, `setTime()`, animate all hands to new positions |
| **Hold → scrub** | After 300ms hold delay, enter quantized mode. `resetHandSchedules()` forces immediate re-eval |
| **Pause** | Freeze display time. `finishAnimations()` snaps all hands to targets **and freezes their schedules** (`nextUpdateTime = Infinity`). Schedules are **not** re-armed on stop |
| **Resume (Play)** | Unfreeze at 1×. `resetHandSchedules()` forces immediate re-eval with normal scheduling |

### Stopped state: no re-evaluation, full idle

While the clock is stopped, display time is frozen, so every hand expression returns a constant — there is nothing to re-evaluate. Two mechanisms keep a stopped face from doing needless work:

1. The stop-transition handlers (`onTransportChange`, `onScrubEnd` in `engine-entry.ts`) call `finishAllAnimations()` (which freezes schedules) but **do not** call `resetAllSchedules()` while `timeController.isStopped` — re-arming would defeat the freeze and cause every-frame re-evaluation.
2. `armIdle()` is a no-op while stopped, so once any in-flight settle animation completes the requestAnimationFrame loop goes **fully idle** rather than busy-waiting on per-hand update boundaries. Resuming (play / step / env change) re-arms the loop via `ensureSchedulerRunning()`.

This was added to fix faces rendering continuously (or busy-looping the idle scheduler) while stopped. See [planning/2026-06-03-stopped-clock-rendering.md](../planning/2026-06-03-stopped-clock-rendering.md).

## Key Functions

| Function | Purpose |
|----------|---------|
| `initHandStates(watch, env, now, getNow)` | Build animation state for all dynamic parts |
| `tickAnimations(states, env, now, tickMs, deltaSec, timeDir)` | Per-frame: re-evaluate + start animations |
| `startValueAnimation(val, target, now, speed, durationOverride?)` | Core: begin/restart an animation on an abstract value |
| `startAnimationRaw(val, target, now, speed, durationOverride?, linear?)` | Angle wrapper: unwraps for shortest-path, then calls core. If `linear` is true, skips `fmod` normalization and angular unwrapping (used for Observatory earth view's sun declination) |
| `startLinearAnimation(val, target, now, speed, durationOverride?)` | Linear wrapper: calls core without angle wrapping |
| `interpolateValue(val, now)` | Advance currentValue toward target (abstract, semantics-free) |
| `interpolateRaw(val, now)` | Angle wrapper: calls core, applies `fmod(2π)` when done |
| `finishAnimations(states)` | Snap all in-flight animations to targets |
| `finishAllAnimations()` | Snap all hands on all faces |
| `resetHandSchedules(states)` | Set nextUpdateTime=0 so all hands re-evaluate next frame |
| `nextWakeupTime(states)` | Find earliest scheduled update (for idle timer) |
| `makeGetNow(bps)` | Create a per-face quantized getNow closure |

## Constants (from `ECConstants.h`)

| Constant | Value | Meaning |
|----------|-------|---------|
| `kECGLAngleAnimationSpeed` | `2.0` rad/s | Base angular animation speed |
| `kECGLLinearAnimationSpeed` | `60.0` px/s | Base linear animation speed (xMotion/yMotion) |
| `kECGLFrameRate` | `1/240` s | Minimum animation duration; below this, snap |

## Unified Animation Core

All animation types (angular, linear, terminator leaf) share a common semantics-free core:

1. **`startValueAnimation(val, target, now, speed, durationOverride?)`** — Sets `targetValue`, computes `animationStopTime`, marks `animating = true`
2. **`interpolateValue(val, now)`** — Linear interpolation from current to target based on elapsed real time

Specialized wrappers add type-specific behavior:
- **`startAnimationRaw`** — Normalizes angles to `[0, 2π)` and unwraps for shortest-path before calling core
- **`startLinearAnimation`** — Calls core directly (no wrapping needed for pixel translations)
- **`interpolateRaw`** — Calls core, then applies `fmod(2π)` when animation completes

The terminator leaf system (`terminator.ts`) also uses the unified core via `startAnimationRaw` for leaf angles and rotations.

## ObsValue Layer

Built on the primitives above, **`ObsValue`** ([src/shared/obs-value.ts](../src/shared/obs-value.ts)) is a general-purpose, expression-driven animated value: a parsed AST + update interval + animation speeds + an `AnimatingValue`. The per-frame logic that drives ObsValues lives in [src/shared/updater.ts](../src/shared/updater.ts) — the embryonic "updater" subsystem — and runs two passes:

1. **`updateObsValues(values, env, perfNow, getNow, …)`** — for each value whose timer expired, re-evaluate the expression and start an animation. Dispatches to one of: eval-ahead, scrub compression, two-phase `naturalSpeed` sweep, or snap-to-target.
2. **`animateObsValues(values, perfNow)`** — interpolate every value toward its target (and hand off Phase-2 sweeps).

Both operate on a flat `ObsValue[]` and are normally driven through the **`Updater`** (below) rather than called directly. See [Observatory — ObsValue System](observatory.md#obsvalue-system).

### Eval-ahead (lag-free tracking)

A value sampled every Δ and interpolated between *past* samples lags real time by Δ. **Eval-ahead** (`evalAhead: true`) removes that lag: at each update it evaluates the target at the **next update point** in display time and sweeps there, arriving exactly as display reaches that point. Because an expression is a pure function of display time, the future target is obtained by direct evaluation — no rate estimate needed. Each interval is then the chord `A(now) → A(next)`: symmetric curvature error, **no time lag**.

Eval-ahead is the *single continuous mechanism*, made **mode-aware** by where the next point is — this is what lets it handle the time controller's modes without separate branches:

| Mode | Next point (display time) | Budget (real) |
|------|---------------------------|---------------|
| Play 1× / reverse −1× | the value's next epoch boundary | time until it (display↔real 1:1) |
| **Scrub** | the **next tick**: `now + displayDeltaSec·dir` | `TICK_INTERVAL_MS` |
| Stopped | — (routed to a settle-at-now branch) | — |

Two things fall out of this:
- **Scrub needs no compression branch** — it is just eval-ahead with the next point at the next tick, and is **lag-free at every tick** (the displayed value equals the true value when display reaches that point).
- **`naturalSpeed` falls out** — a constant-rate value's "natural speed" is the slope between `A(now)` and `A(next)`; sweeping the chord over the budget reproduces constant velocity with the rate *inferred*, not configured. The legacy `naturalSpeed` two-phase and scrub-compression branches remain for Observatory but are mechanisms we converge away from.

Eval-ahead evaluates the expression at a shifted display time via **`makeOverridableGetNow(base)`** (updater.ts), which returns a `getNow` plus a `withDisplayTime(displayMs, fn)` that transiently overrides the clock for the duration of `fn`. The display time enters expressions only through `getNow`, so shifting it shifts the whole evaluation — no second environment needed. The Inspector uses eval-ahead to show smooth, lag-free readouts while fully re-evaluating only 10×/s; see [Inspector — Expression Evaluator](inspector.md#expression-evaluator).

### TimingContext and the `Updater`

The per-frame timing state (`tickIntervalMs`, `displayDeltaSec`, `direction`) is bundled as a **`TimingContext`** — the generic seam between the time controller and the updater. `timingContextForFrame(timeController)` builds it; the **`Updater`** object (updater.ts) owns an `ObsValue` collection and advances it each frame via `tick(env, perfNow, getNow, withDisplayTime, ctx)`, exposing `anyAnimating()` and `reset()`.

The `Updater<K extends string = string>` is **name-keyed**: `add(v)` registers a value (keyed by `v.name`) and `get(name: K)` looks one up (throwing on a miss). `K` is a pure client-side convenience — the shared updater stores values in a plain `Map<string, ObsValue>` and never references any client's key union, so the shared layer stays unaware of client-specific types. Observatory instantiates `Updater<ObsValueName>` so its renderers get typo-checked lookups; the Inspector uses the default `Updater` (`K = string`) for its catalog and never calls `get()`. Both Observatory and the Inspector are consumers.

**The controller↔updater seam is generic.** A client constructs an `Updater` with its values and hands it to `initTimeControls({ updater, … })`. From then on the shared time-controls UI performs the generic work on **every** transition (scrub start/end, single-step, astro-step, date-input, Now, transport): it runs the controller action (`reset()`/`stop()`/etc.), calls `updater.reset()` to re-arm all schedules, and persists the time state (`writeTimeStateToUrl`, the default `writeTimeState`, which routes through `app-state`). A client only supplies a transition callback (`onNowClicked`, `onScrubEnd`, …) when it has **custom** work beyond that — e.g. the Inspector re-parses its free-form expression box (which lives outside the updater for error isolation); Observatory rebuilds its astro `env` via the time controller's own `onTick` and so needs **no** transition callbacks at all. See the contract below.

### Time-controls contract

`initTimeControls(config)` ([src/shared/time-controls-ui.ts](../src/shared/time-controls-ui.ts)) owns the transport bar + popover. Its config splits cleanly into *provided* state, an *optional updater*, and *optional* custom-logic notifications:

| Field | Required? | Purpose |
|-------|-----------|---------|
| `timeController` | yes | the shared `TimeController` the UI drives |
| `getTimezone` / `getTzDeltaMs` / `getLat` / `getLon` | yes | read-only accessors for the UI's display + astro stepping |
| `getSelectedBody` | optional | body selector for astro-step (rise/set/transit) |
| `updater` | optional | anything with `reset()`; the UI calls it on **every** transition. Pass the client's `Updater` to get automatic schedule re-arming. |
| `ensureSchedulerRunning` | yes | restart the client's (app-owned) render loop after a transition; the rAF loop differs per app, so there is no generic default |
| `onTimeStep` / `onScrubStart` / `onScrubEnd` / `onNowClicked` / `onTransportChange` | optional | **notifications for custom logic only** — omit when the client has none |
| `writeTimeState` | optional | defaults to `writeTimeStateToUrl(timeController)`, which persists `t`/`off`/`dir` through `app-state` (LocalStorage by default, URL for sharing/fallback); override only to change time-state persistence |

The UI performs the generic controller action itself (e.g. `nowClicked()` → `timeController.reset()`, `endHold()` → `timeController.stop()`), then `updater?.reset()`, then the optional notification, then `updateTimeUI()` / `ensureSchedulerRunning()` / `writeTimeState()`. Because every `TimeController` mutation (`reset`/`stop`/`setTime`/`setOffset`/`setRate`/`setDirection`) fires `onTick`, a client that wires `timeController.onTick` to its env rebuild (Observatory, Chronometer) gets a fresh env on every transition for free.

### Discrete values (snap, no interpolation)

The **`ObsValue.discrete`** flag tells the updater to evaluate a value at the **current** display time and set it directly (no eval-ahead, no interpolation), letting the function's own semantics decide which value applies now. Eval-ahead would be wrong here (it crosses the value's change-point early — e.g. showing tomorrow's sunrise before midnight), and interpolating a step value produces nonexistent in-between readings. `discrete` takes precedence over `evalAhead`. Its only mode dependence is **cadence**: it re-evaluates at the value's boundary at 1×/reverse, and **every tick while scrubbing** (so the snapped value tracks the scrubbed time), and keeps instant-snap even when stopped.

### Settle speed and `JUMP` (digital readouts)

`ObsValue.animSpeed` is the per-app "default animation speed" carried over from Chronometer/Observatory. It governs only the **non-budget** animations — the stopped-state *settle* and the legacy snap-to-target (eval-ahead and scrub ignore it, animating over an explicit time budget). For an *angle* a finite speed (2 rad/s) settles in well under a second, but a **linear** value can be any magnitude (seconds-of-day 0–86400, AU, a dateInterval ~7.8×10⁸), so a fixed units/s either crawls or overshoots — e.g. stepping a day jumps sidereal time ~236 s, which at 2 units/s would creep for ~118 s. A client showing **digital** readouts (the Inspector) therefore sets `animSpeed` to the **`JUMP`** sentinel (`= Infinity`, in obs-value.ts), so values *jump* to the correct value on stop/step instead of easing — while play/scrub stay smooth (those are budget-bounded). `JUMP` is deliberately not called "snap" to avoid colliding with the existing "snap = animate at default speed (vs. the slow naturalSpeed sweep)" usage.

**`discrete` is a *client* policy, not a property of the expression.** The client sets it when interpolating a value across a change would be meaningless *for that particular display*. For example, when today's sunrise rolls over to the next day's, the Inspector's *text* readout should **jump** to the new time, whereas a graphical client **animates** the same quantity — Observatory's sunrise hand sweeps smoothly to the new day's position. So `discrete` is rare in Observatory/Chronometer (graphical, animate everywhere) and common only in the Inspector's ephemeris catalog (rise/set/transit, integer date/clock fields, weekday, planet up/down, TZ offset).

## Key Source Files

| File | Purpose |
|------|---------|
| `src/shared/animation.ts` | All animation logic: hand states, ticking, interpolation, unified core |
| `src/shared/obs-value.ts` | `ObsValue` — general expression-driven animated value (type + `createObsValue`) |
| `src/shared/updater.ts` | ObsValue per-frame update/animate passes + `makeOverridableGetNow` (eval-ahead) |
| `src/watch/astro-stepper.ts` | Astronomical event stepping: rise/set, moon phase, transit search |
| `src/watch/terminator.ts` | Moon-phase leaf animation (uses unified core) |
| `src/time-controller.ts` | Display time management, rate control, tick scheduling |
| `src/engine-entry.ts` | Main loop, scheduler, transition handling, `makeGetNow` |
| `src/watch/watch-env.ts` | Expression environment (receives quantized `getNow`) |

## Related Docs

- [Rendering](rendering.md) — How animated parts are drawn each frame
- [Timezone & DST](timezone-and-dst.md) — DST transition detection and environment rebuild triggers
- [Development Rules](development-rules.md) — Schedule reset rules (§6), never rebuild parts (§3)
