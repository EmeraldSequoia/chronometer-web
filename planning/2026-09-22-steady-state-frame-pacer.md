# Plan: steady-state 60 fps pacer, and honouring prefers-reduced-motion

**Status**: IMPLEMENTED 2026-09-22 (build 2.0.139, uncommitted) — Part 2 of
[2026-09-14-user-options-panel.md](2026-09-14-user-options-panel.md) (§3.4 A, §6).
**Created**: 2026-09-22
**Baseline**: c5ff2e3 plus the uncommitted Part 1 work (build 2.0.138).
**Decision this implements** (parent §7, item 5): a built-in 60 fps cap on
steady-state rendering, no setting; scrubbing, dragging and user-driven
transitions stay at the display's rate. The Low-power toggle (Part 7) will
lower the same cap through the same mechanism.

## 1. The problem

Observatory and the Inspector re-request `requestAnimationFrame` on every
display frame while the clock runs: 240 draws/s on a 240 Hz monitor, 120 on a
ProMotion phone, for motion nobody can see (a 6°/s second hand moves 0.1° per
60 Hz frame and 0.025° per 240 Hz frame — a fraction of a pixel either way).
Chronometer's 1× loop is boundary-scheduled and idles between value
boundaries, but its awake windows — the hands' per-beat snaps, ~85 % of the
time on all.html — also run at display rate.

## 2. Design

### 2.1 `src/shared/frame-pacer.ts`

One pacer per loop. `request(cb, paced)` replaces the loop's
`requestAnimationFrame` call: unpaced → rAF; paced → draw on every k-th
vsync, k = ⌊display ÷ 60⌋ (§6; §5 for why a timer alone is not enough): a
`setTimeout` wakes half a display period before the slot, a rAF lands on the
vsync, and a frame whose timestamp is still ahead of the slot is skipped and
re-armed. The display rate comes from a shared 12-frame probe (§6).
`pending` replaces the loops' `rafId !== null` checks; `cancel()` their
`cancelAnimationFrame`. `burst(ms = 2000)` lifts the cap after a user-driven
change so the sweep to new targets renders at full rate; `setTargetFps` is
the hook for Part 7. The `?fps` readout gains a `p<share> <Hz>` tail.

### 2.2 What is steady state

| Loop | paced when | burst from |
|------|------------|------------|
| Observatory | `timeController.currentRate === null && dragState === 'idle'` (scrub incl. hold-to-scrub, and drag-to-explore, are unpaced) | `scheduleFrame()` — every explicit wake: transport / step / Now, location, body, noon, resize, Keep / Revert, help close |
| Inspector | `timeController.currentRate === null` | `scheduleFrame()` |
| Chronometer | `!timeController.needsContinuousRender` (scrub is the only continuous-render mode) — so the per-beat snaps are paced too | `startScheduler()` and `ensureSchedulerRunning()` — every explicit kick and every time-UI transition |

A frame requested *during* a tick (`frameRequestedDuringTick`) is a wake for a
change and stays immediate. The help-overlay park is unchanged (`cancel()`).

### 2.3 prefers-reduced-motion

The shared updater snaps *transitions* instead of animating them when the OS
asks for reduced motion (`matchMedia('(prefers-reduced-motion: reduce)')`,
tracked live; guarded for jsdom): the catch-up phase of natural-speed hands,
settle-at-now when stopped, the legacy snap-to-target at 1×, the drag's
fixed-duration updates, and the on-beat settles. The motion that *is* the
content is untouched — the second hands' natural-speed sweep, the eval-ahead
sweep between boundaries, the on-beat sweep to the next beat, and scrub
compression (scrubbing is motion by definition). Exported `setReducedMotion`
for tests.

## 3. Verification

- Unit: `frame-pacer.test.ts` (fake timers + fake rAF) — slot timing,
  replace / cancel, burst window, uncapped and lower targets. Updater test
  for reduced motion.
- Pane: instrument `requestAnimationFrame` / `setTimeout` on a running page —
  steady state shows timer-then-rAF pairs; a Now tap shows a 2 s rAF-only
  burst. Rates themselves can't be judged in the VM (rAF is capped at 60
  there).
- Native (Steve, 240 Hz): `?fps` should read ~60 in steady state on all three
  apps, ~240 while scrubbing or dragging the map, and ~240 for two seconds
  after a step tap.
- Perf-regression check (rule 18): the updater gained one branch per
  transition; run and report.

## 4. Implementation record (2026-09-22)

Landed as designed: `src/shared/frame-pacer.ts` (with
`src/shared/__tests__/frame-pacer.test.ts`, 6 cases under fake timers and a
fake rAF), the three loops rewired (`pacer.request / cancel / pending /
burst` replace every `rafId` touch point), and the reduced-motion seam in
`updater.ts` (`setReducedMotion`, `transitionMultiplier`; 2 cases in
`reduced-motion.test.ts`). `tsc` clean; 8789 tests pass.

**Perf-regression check (rule 18).** The first run, straight after the full
suite, reported TOTAL +16.7 % with terra +100 % and four other faces ≥ 15 %.
An interleaved A/B (with the change / with the original `updater.ts` stashed /
with the change again) gave +22.1 % / **+23.2 %** / +16.5 % with the same faces
up in all three, machine-speed factor 0.82–0.86×: the machine, not the change
— which adds one function call per *transition start*, nothing per tick. Not
a regression.

**Pane verification** (the tab's native rAF was dead, so the page was
reloaded through `document.write` with a 16 ms timer-based rAF shim; counters
wrapped the shim and `setTimeout`, bucketing pacer timers (< 15 ms) apart
from the shim's own 16 ms ones):

| Phase (Observatory, 1× real time) | frames / 2 s | pacer timers | reading |
|---|---|---|---|
| steady state | 61 | 61 (≈ 12.7 ms each) | every frame waits for its slot: paced |
| 2 s after a wake (resize) | 101 | 3 (before the 150 ms debounce) | burst: frames only |
| steady again | 60 | 60 | paced again |
| hold-to-scrub (earlier run) | 108 | 0 | unpaced |

Under the shim a paced frame costs timer + 16 ms, so the pane shows ~30 fps;
on a real display the rAF lands on the next vsync and the cap is 60. Rates
themselves are for Steve's 240 Hz machine: `?fps` should read ~60 in steady
state on all three apps, ~240 while scrubbing or dragging, ~240 for two
seconds after a step or Now.

## 5. Steve's 120 Hz report and the fix (2026-09-22, build 2.0.140)

On a 120 Hz laptop running 2.0.139, Chrome showed Observatory at ~90 fps in
steady state and Safari (with its >60 fps flag) ~80 — down from 120, but not
the intended 60. The first pacer computed the next slot from the previous
frame's rAF timestamp plus 16.67 ms and woke a timer 3 ms early. Browsers may
run a timer-requested rAF *inside the frame already in progress*, whose
timestamp is older than the callback time; pacing from that stale timestamp
made the next slot early, and on 120 Hz the frames settled about 11 ms
apart. A timer-and-lead scheme cannot be made exact on high-refresh displays
in any case.

Fix: pace on a fixed 60 fps grid aligned to vsync. The pacer measures the
display period from consecutive unpaced frames (the load burst gives ~120
samples), wakes half a period before each grid slot, arms a rAF, and skips
any frame whose timestamp is still ahead of the slot. 120 Hz draws every
other vsync and 240 Hz every fourth, exactly; 60 Hz is plain rAF; 144 Hz
alternates 48 / 72 and averages 60 (60 does not divide 144 — and "not more
than 60 on average" is the requirement, not a jitter-free 60). Tests simulate
all four displays. The `?fps` readout now ends with `p<share> <Hz>` — the
share of frames drawn under the cap and the measured display rate — so the
next report can say which mode the loop was in.

## 6. Uniform pacing: probe, snapping, floor rule (2026-09-22, build 2.0.141)

Steve's review of 2.0.140: Observatory read 120–125 Hz and paced to 60 as
intended, but Chronometer's readout often showed no Hz at all (Mauna Kea by
itself, most recently), and the nearest-vsync grid's 48 / 72 alternation on
144 Hz displays was uneven pacing by construction — invisible for the
steady-state hands (±3.5 ms × 30 px/s ≈ 0.1 px) but not something to rely on.

- **Why Chronometer had no measurement.** The pacer measured the display
  from consecutive frames armed from inside the previous frame in unpaced /
  burst mode. Observatory produces hundreds in its load burst; Chronometer's
  1× loop is idle-timer driven and rarely draws two vsyncs in a row —
  Mauna Kea's 10 Hz second hand completes each 0.6° snap within one frame,
  so at 1× the loop draws exactly one frame per beat and never measures.
- **Probe.** A shared 12-frame rAF probe (`probeDisplayPeriod`) runs at page
  load, when the tab becomes visible, and once a minute (a window can move to
  another monitor, and macOS Low Power Mode caps ProMotion at 60 Hz, with no
  event). The first gap is discarded (it carries the request's latency);
  the median of the rest is the period. ~100 ms of empty callbacks.
- **Snapping.** The measured rate is snapped to the nearest of 60, 72, 75,
  90, 100, 120, 144, 165, 240, 360 Hz within 6 % (Steve's panel read up to
  125). The common rates sit exactly on the integer boundaries of the k
  rule, so an unsnapped estimate a few percent long would floor k to 1 and
  silently switch the cap off.
- **Rule (Steve's):** draw every k-th vsync, k = ⌊display ÷ cap⌋ — the
  highest rate at or above the cap that divides the display's evenly, so
  intervals are uniform: 60 fps on 120 / 240 Hz, 72 on 144, 82.5 on 165, the
  display's rate on 60 / 75 / 90 (no saving on 90 Hz phones; "never below
  60" wins there). Same rule for the Low-power target: 10 fps on 120 Hz is
  every 12th vsync.
- Tests simulate 60, 90, 120, 144, 165 and 240 Hz displays with the probe
  running; snapping has its own cases. 8796 tests pass.
- **Chronometer's idle wakes are paced too** (found in the same review, build
  2.0.142): under a 120 Hz shim Mauna Kea read `60avg p2` — 60 frames/s, 2 %
  paced. The idle scheduler wakes 50 ms *before* each value boundary and
  free-runs frames until it passes (a documented 1× behaviour), and
  `onIdleWakeup` had requested those frames unpaced on the theory that the
  timer had already waited. Now paced: immediate when the last frame was long
  ago, capped while free-running.
