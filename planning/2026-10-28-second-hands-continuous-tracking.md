# Plan: Observatory second hands — the tab-return jump, and continuous tracking in place of the natural-speed sweep

**Status**: IMPLEMENTED 2026-10-28 in two steps. Step 1 (the two fixes inside
the natural-speed mechanism) is commit `45e3c8d`, kept as the reference
implementation of that mechanism. Step 2 (the mechanism replaced by continuous
per-frame tracking) follows it, build 2.1.30, uncommitted; unit suites green. Pending: Steve's native
pass (tab switch, help close, sleep/wake, Now after reverse, Low power).
**Created**: 2026-10-28
**Baseline**: 6da8514 (build 2.1.26)
**Related**: [docs/observatory.md](../docs/observatory.md#animation-modes)
(the value modes), [docs/animation.md](../docs/animation.md) (the dispatch),
[2026-09-24-seconds-scrub-cadence-and-bce-offset.md](2026-09-24-seconds-scrub-cadence-and-bce-offset.md)
(the previous bug in the same mechanism; its §4 kept the 1× economy that this
plan measures and removes).

## 1. The report

Returning to a tab showing Observatory, the second hands sometimes animated
*backwards* at about normal speed instead of the usual catch-up sweep; and
after even a one-second absence a hand could start out well ahead of the
correct time (up to the 20 s of the natural animation's update interval) and
then run back to meet it.

## 2. Mechanism

Observatory's four second hands (`second`, `utcSecond`, `solarSecond`,
`sidSecond`) were *natural-speed* values: re-evaluated every 20 s and swept
at a configured 2π/60 rad/s in between (a linear `AnimatingValue` whose
`targetValue` is the position at the **end** of the 20 s sweep), with a
two-phase catch-up when a re-evaluation found the hand off.

The tab-return path, `resyncAfterGap` in
[observatory-entry.ts](../src/observatory/observatory-entry.ts) (also run on
help-popover close and by the sleep/wake watchdog), is `rebuildEnv();
updater.finish(); updater.reset()`. Two defects, both in
[updater.ts](../src/shared/updater.ts):

1. **`finish()` snapped every value to `anim.targetValue`.** Right for
   snap-to-target values (the correct position at the last boundary); for a
   natural-speed hand that is the end of the sweep, 0–20 s in the *future*.
   The hand jumped ahead by whatever remained of the sweep when the tab was
   hidden.
2. **Phase 1 measured the error clockwise into [0, 2π) and computed its
   duration for that path, but `startAnimationRaw` animates the shortest
   path.** A hand 5 s ahead reads as 55 s behind; the duration is for the
   long way forward, the motion is the short way back. Any error over π —
   a hand more than 30 s behind (a tab hidden 30–60 s), or any hand ahead
   (Now after reverse play, a clock step) — moved backwards over a duration
   computed for the forward trip.

Confirmed by driving the real `Updater` with fake wall/perf clocks at 60 fps
(hidden 1 s; hand−correct in seconds):

| Hidden at | After resync | Then |
|---|---|---|
| 14 s into the 20 s cycle | +4.98 | creeps backwards at ~0.6× normal speed for 3 s |
| 5 s into the cycle | +14.0 | runs backwards at ~4.5× normal speed for 2.5 s |
| 18 s into the cycle | +0.98 | stands still for 1 s |
| 10 s in, hidden 40 s | 30 s off | runs backwards fast (defect 2 alone) |

"Sometimes, at about normal speed" is the phase of the 20 s cycle at the
moment of switching away. Chronometer is unaffected (its hands are on-beat;
nothing outside these four values set `naturalSpeed`).

## 3. What the 20 s economy bought

The interval existed so the solar and sidereal expressions were not evaluated
every frame. Measured in Node (`vite-node`), each evaluation at a *fresh*
display instant (every call misses the astro cache; includes the pool
push/pop):

| Expression | Per evaluation |
|---|---|
| `secondValueAngle()` | 0.28 µs |
| `utcSecondAngle()` | 0.27 µs |
| `fmod(solarTimeSec(), 60)…` (equation of time) | 2.14 µs |
| `fmod(lstValue(), 60)…` (sidereal) | 0.40 µs |
| all four at one instant per frame | 2.72 µs |

≈ 0.16 ms of CPU per second at 60 fps, against a running loop that redraws
the whole canvas every paced frame. Under the frozen-frame rule every value
evaluated in a frame shares that frame's instant, so the per-frame push does
not thrash anything else's cache.

## 4. Step 1 — fixes inside the mechanism (commit `45e3c8d`)

- `finish()`: a natural-speed value settles where its sweep has it **now**
  (`interpolateValue(v.anim, performance.now())`), not at the sweep's end.
  Exactly right after a hidden-tab gap (the perf clock ran on), behind by the
  gap after a sleep (the perf clock froze); `reset()`'s catch-up then animates
  only the real error.
- Phase 1: the error is the signed shortest-path distance in the direction of
  travel. Behind closes at `animSpeed − naturalSpeed`; ahead backs up at
  `animSpeed + naturalSpeed`; the band just under π where the forward chord
  would itself exceed π is sent back deliberately, so direction and duration
  always agree.
- Regression test `natural-speed-resync.test.ts` (removed again in step 2
  with the mechanism; see the commit for it).

## 5. Step 2 — continuous tracking

`ObsValue.continuous` replaces `naturalSpeed`/`pendingSweep`. At 1× / −1×
(`updateObsValueContinuous`) the value is evaluated at the current display
time every frame and set directly; it *animates* only when the drawn position
is off by more than `CONTINUOUS_SNAP_THRESHOLD` (0.05 rad — must exceed the
per-frame motion at the slowest paced rate, 2π/60 ÷ 10 fps ≈ 0.01 rad, or the
tracking would be a perpetual one-frame-late animation; it is half a second of
second hand, which the 2 rad/s catch-up covers in one frame). The catch-up is
`startAnimationRaw` at `animSpeed`, shortest path, re-aimed every frame;
reduced motion jumps it (`transitionMultiplier` = 0) while the tracking
continues. Scrub keeps the every-tick branch, stopped keeps `settleAtNow`,
drag keeps the fixed-duration branch — only the 1× dispatch changed. The
Phase-2 handoff in the animate pass, `anyObsAnimating`'s `pendingSweep`
check and the step-1 `finish()` special case are gone: a continuous value's
`targetValue` is never in the future, so the plain snap is right.

Observatory defs: `updateInterval: 1, continuous: true` (the interval is not
consulted at 1× for these). The pacer's `burst()` on every explicit wake
(including the tab-return `scheduleFrame`) is unchanged, so the catch-up
renders at the display's rate as before.

Prototype results (same fake-clock harness; now the unit test
`continuous-tracking.test.ts`): 1 s hidden → caught up in < 0.15 s; 5 s
sleep → < 0.45 s; 40 s hidden → shortest path (20 s) in < 1.2 s; 5 s ahead →
backs up in < 0.4 s; first frame 1.5 s after creation → same sweep; steady
state exact every frame at 60 fps and at 10 fps; reverse tracks exactly;
stopped settles and holds.

Direction after a gap longer than 30 s is the shortest path (backwards); a
watch-like forward-only preference would be a one-line unwrap in the branch.

## 6. Verification

- `npx vitest run`: all suites green after each step (goldens untouched —
  Chronometer has no continuous values).
- `npx tsc --noEmit`: clean.
- Native pass (Steve): tab switch at several points in a minute, help
  popover open/close, sleep/wake, Now after reverse play, Low power.
