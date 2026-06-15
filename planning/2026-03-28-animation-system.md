# Hand Update Intervals and Animation

> **2026-04-18**: Updated to reflect the implemented system. Added sections on two-time-base architecture, quantized scrubbing, adaptive compression, hold-scrub time preservation, and wrap-around handling. Removed the scrub-freeze detection system (replaced by preserving sub-unit time fields during hold-scrub rate activation).

## Problem

Currently, all hands re-evaluate their angle expressions every animation frame, and there is no smooth interpolation between values. This is both wasteful (astronomy calculations run 60× per second) and visually wrong (the "jumping second hand" complication requires the hand to tick discretely, then *animate* smoothly to its new position).

## Key Concepts from the iOS App

### Update Interval (`update` attribute)
Controls **how often** a hand's angle expression is re-evaluated:
- `update="1"` → re-evaluate every 1 second (second hand, minute hand, sun/moon position hands)
- `update="60"` → re-evaluate every 60 seconds (hour hand, AM/PM wheel)
- `update="1/60"` → re-evaluate 60× per second (subsecond hand — smooth sweep)
- `update="updateAtNextSunriseOrMidnight"` → re-evaluate once per day (sunrise/sunset hands)
- `update="1 * days()"` → re-evaluate once per day (date/month/weekday wheels)
- No `update` → defaults to `1/beatsPerSecond` (for Haleakala, `beatsPerSecond=1`, so every 1s)

This is **not just an optimization** — it determines the watch's visual behavior. A second hand with `update="1"` + `angle="secondNumberAngle()"` should jump discretely once per second, not sweep continuously.

### Update Alignment
Updates must fire on **exact clock boundaries**, not relative to when the page loaded:
- `update="1"` → fires when `floor(secondsSinceEpoch)` changes (exact second boundaries)
- `update="N"` → fires when `floor(secondsSinceEpoch / N)` changes (every N seconds, epoch-aligned)
- `update="someUpdateKindName"` → named sentinel constants (negative values in iOS, e.g. `updateAtNextSunriseOrMidnight = -1005`), specially interpreted by the timer system to compute the exact next event time. Currently approximated as daily (`86400s`) in the web app.

### Animation (`animSpeed` attribute)
Controls **how** the hand moves to its new position after an update:
- `animSpeed="0"` or absent → snap instantly to the new angle (no animation)
- `animSpeed="2.0"` → animate smoothly from old angle to new angle, at 2× base speed
- Default `animSpeed` is `1.0` if not specified

#### How it works (from `ECGLPart.m`):

```
On update tick:
  1. Re-evaluate the angle expression → new targetValue
  2. If currentValue == targetValue → no animation needed
  3. Else:
     animationSpeed = kECGLAngleAnimationSpeed * animSpeed   (radians per second)
     deltaTime = |targetValue - currentValue| / animationSpeed
     if deltaTime < one frame → snap directly (no visible animation)
     else:
       animating = true
       animationStopTime = now + deltaTime

On each render frame (while animating):
  if now >= animationStopTime → snap to target, animating = false
  else:
     fractionComplete = (now - lastAnimationTime) / (animationStopTime - lastAnimationTime)
     currentValue += (targetValue - currentValue) * fractionComplete
     lastAnimationTime = now
  render hand at currentValue
```

Although the code updates `lastAnimationTime` and uses `(targetValue - currentValue) * fractionComplete` each frame (which looks like it could be exponential), the math works out to **linear interpolation**: since remaining time and remaining distance decrease proportionally, the per-frame displacement is constant.

### Animation Direction (`animationDir`)
For circular values (angles), controls which direction to sweep:
- `ECAnimationDirClosest` (default) — take shortest path around the circle
- `ECAnimationDirAlwaysCW` — always clockwise
- `ECAnimationDirAlwaysCCW` — always counter-clockwise
- `ECAnimationDirFurthest` — take the long way around

This handles wrap-around cases (e.g., second hand going from 59 back to 0 should sweep forward through position 0, not sweep backward through 30).

## Implemented Architecture

### Two-Time-Base System

The animation system uses two independent time bases:

1. **Display time** (`getNow()`) — determines WHAT values the angle expressions evaluate to. This is the "watch time" that can be scrubbed, paused, or running in real time.
2. **Real time** (`performance.now()`) — determines WHERE the hand is drawn right now. Used for smooth interpolation between expression evaluations, targeting up to 240fps rendering.

This separation allows:
- Display time to jump discretely (e.g., step by 1 hour) while the animation smoothly interpolates the visual transition
- Quantized scrubbing at high rates (10 hr/s) where display time advances in fixed steps on each tick

### Core Types (in `animation.ts`)

```typescript
interface AnimatingValue {
    currentValue: number;       // What we render right now
    targetValue: number;        // Where we're heading
    lastAnimationTime: number;  // performance.now() at last interpolation step
    animationStopTime: number;  // When animation should be complete
    animating: boolean;         // Is an animation in progress?
}

interface HandState {
    part: QHandPart | WheelPart | QWedgePart;  // Reference to XML part
    angle: AnimatingValue;
    offsetAngle: AnimatingValue | null;   // For orbit hands (e.g. Moon)
    updateIntervalMs: number;            // From XML update attr
    nextUpdateTime: number;              // performance.now() for next re-eval
    animSpeed: number;                   // From XML animSpeed attr (default 1.0)
    getNow: () => Date;                  // Display time source
}
```

### Main Loop Flow

```
frame():
  now = performance.now()
  timeController.checkTick(now)      // advance display time if quantized tick due
  timeController.beginFrame()         // latch display time for this frame

  for each face:
    tickAnimations(handStates, env, now, tickMs, deltaSec)
    tickLeafAnimations(...)           // terminator day/night leaves
    renderFrame(...)

  if stillAnimating || needsContinuousRender:
    requestAnimationFrame(frame)
  else:
    armIdle()                         // setTimeout to next scheduled update
```

### Modes of Operation

#### 1× Mode (Normal / Real Time)
- `tickIntervalMs = null`
- Expressions re-evaluate at epoch-aligned boundaries (e.g., every exact second)
- Animations use natural speed (`kECGLAngleAnimationSpeed * animSpeed`)
- No compression logic

#### Quantized Mode (Scrubbing / Accelerated)
- `tickIntervalMs` = the interval between display-time ticks
- `displayDeltaPerTickSec` = how many display seconds advance per tick
- **Adaptive compression**: If a hand's natural animation duration would exceed the tick interval, its animation is compressed to fit. Otherwise, natural speed is used.
- **Independent compression**: `angle` and `offsetAngle` are compressed independently, so a slow wedge flip doesn't force an orbit hand to compress unnecessarily.
- **Schedule skipping**: Slow-updating parts (e.g., `update="3600"`) skip ticks where their expression wouldn't change, avoiding unnecessary re-evaluations.

#### Single-Step Mode
- `tickIntervalMs = null` (like 1× mode)
- Called from mousedown/touchstart handlers
- Calls `resetHandSchedules` then `tickAnimations` once
- Animations use natural speed (no compression)

### Hold-Scrub Time Preservation

When the user holds a step button, the system transitions from single-step mode to quantized scrubbing by calling `timeController.setRate()`. The rate activation includes a `snapToUnit()` call that aligns the tick time to the nearest unit boundary.

**Problem**: For rates above seconds, `snapToUnit` zeroes out sub-unit time fields. E.g., snapping to hour boundaries sets minutes and seconds to 0, causing minute/second hands to jump to 12 o'clock. Snapping to day boundaries sets HMS to midnight.

**Solution**: Only snap for the `second` rate (zeroing milliseconds, which aren't displayed). For all other rates (`minute`, `hour`, `day`, `month`, `year`), preserve the current time exactly and start ticking from there. Since `advanceByUnit()` preserves sub-unit fields (e.g., adding 1 day preserves HMS), all subsequent ticks maintain the correct time-of-day.

This means that when holding the hour button starting from 3:15:42 PM, the display time advances through 4:15:42, 5:15:42, etc. — the minute and second hands stay at 15 and 42, matching the iOS behavior where dragging doesn't disturb uninvolved hands.

### Key Functions

| Function | Purpose |
|----------|---------|
| `initHandStates(watch, env, now)` | Build animation state for all dynamic parts |
| `tickAnimations(states, env, now, tickMs, deltaSec)` | Per-frame: re-evaluate + start animations |
| `startAnimationRaw(val, target, now, speed, durationOverride?)` | Begin/restart an animation |
| `interpolateRaw(val, now)` | Advance currentValue toward target |
| `finishAnimations(states)` | Snap all in-flight animations to targets |
| `resetHandSchedules(states)` | Set nextUpdateTime=0 so all hands re-evaluate next frame |
| `nextWakeupTime(states)` | Find earliest scheduled update (for idle timer) |

### Constants (from `ECConstants.h`)

| Constant | Value | Meaning |
|----------|-------|---------|
| `kECGLAngleAnimationSpeed` | `2.0` rad/s | Base angular animation speed |
| `kECGLFrameRate` | `1/240` s | Minimum animation duration; below this, snap |

### Wrap-Around Handling

`startAnimationRaw` normalizes targets to `[0, 2π)` and unwraps `currentValue` so the delta is in `[-π, π]`, ensuring the shortest path around the circle:

```typescript
let delta = newTarget - val.currentValue;
delta = delta - TWO_PI * Math.round(delta / TWO_PI);  // normalize to [-π, π]
val.currentValue = newTarget - delta;  // unwrap so animation goes shortest path
```

## Haleakala Specific Hands

| Hand | `update` | `angle` | `animSpeed` | Notes |
|------|----------|---------|-------------|-------|
| `second` | `1` | `secondNumberAngle()` | `2.0` | Jumping second with smooth animation |
| `subsecond` | `1/60` | `secondValue() * 2π` | — | Sweeping sub-second |
| `minute`/`min` | `1` | `minuteValueAngle()` | — | |
| `12hour`/`hr` | `60` | `hour12ValueAngle()` | — | Re-evaluates once/minute |
| `saz hand` | `1` | `sunAzimuth()` | — | Sun azimuth |
| `salt hand` | `1` | `-π/2 + sunAltitude()` | — | Sun altitude |
| `nxt rs hr` | `nextSunrise` | `sunriseForDayHour12ValueAngle()` | — | Daily |
| `am/pm` wheel | `60` | `hour24Number() >= 12 ? 0 : π` | `5.0` | |
| Date wheels | `1 * days()` | Calendar expressions | — | Daily |

## Verification

- The second hand should tick (jump) once per second, with a brief smooth animation to its new position
- The subsecond hand should sweep continuously at 60 fps
- The sun altitude/azimuth hands should update once per second, snapping (no animSpeed)
- The hour hand should update once per minute
- The AM/PM dot should flip smoothly with `animSpeed=5.0`
- Hold-scrub by day: HMS hands should stay at their current position (same time of day)
- Hold-scrub by hour: minute/second hands should stay at their current position
- Hold-scrub by minute: second hand should stay at its current position
- Moon and other complex hands should animate smoothly during any scrub rate
