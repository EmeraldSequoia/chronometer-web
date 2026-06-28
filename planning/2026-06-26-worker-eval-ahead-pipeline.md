# Worker-Threaded Eval-Ahead Pipeline (with on-beat scheduling)

**Date:** 2026-06-26
**Status:** **Planned** — open questions resolved (owner answers, 2026-06-26),
ready to schedule. Builds on the ObsValue port's `EVAL_AHEAD = false` baseline (see
[2026-06-15-chronometer-obsvalue-port.md](2026-06-15-chronometer-obsvalue-port.md)).
Detailed design in *“Bookkeeping design”* below; phasing in *“Phases”*.

> **Prerequisite is DONE and motivates this work.** The three-number FPS
> indicator landed (commit `faffade`). On the slow target it reads **~16 fps with
> over half the frame spent in CPU** — i.e. the main thread is CPU-bound on the
> *update pass* (astronomy + expression eval), not GPU-bound. That is exactly the
> cost (B) moves off-thread, so the worker pipeline is now justified on measured
> data, not speculation.

## Why this exists

The ObsValue port initially turned on eval-ahead for every Chronometer value and
hit three regressions, all traced to one cause — eval-ahead **stretched** each
animation across its whole update interval and **evaluated astronomy a full
interval into the future**:

1. A 1-bps hand (`update=1s`) swept the entire second instead of *ticking*.
2. The 1× loop never went idle (the hand was always mid-sweep) → continuous 60 fps.
3. Each scrub frame evaluated astronomy at `now + 1 day` while the env rebuild /
   terminator / analemma evaluated at `now`, **thrashing the single
   `AstroCachePool`** (≈ doubling astronomy work per scrub tick).

The shipped fix is `EVAL_AHEAD = false`: the Updater's snap-at-boundary /
scrub-compression branches (modeled on the legacy `tickAnimations`) restore ticks,
1× idle, and single-time astronomy. That baseline is correct and performant.

This doc captures how to bring eval-ahead **back, done right** — as a polish +
performance feature, not a fix. Two independent-but-composable pieces:

- **(A) On-beat scheduling** — make a hand *snap at its natural speed* but *land*
  exactly on the beat, instead of stretching the sweep across the interval.
- **(B) Worker-threaded look-ahead** — move the expensive evaluation (astronomy +
  expression eval) onto a worker that runs a deterministic forward-walk, several
  boundaries ahead, with its **own** astro cache.

Neither is needed for correctness. Pursue only if (a) on-beat tick precision is
wanted, and/or (b) heavy faces need the parallelism to hold frame budget on slow
devices (e.g. the VM where the original regression showed 10 fps).

## (A) On-beat scheduling — single-thread version

Keep the natural `animSpeed` snap (duration `d = Δ/speed`) but **delay its start**
so it *completes* on the beat, rather than stretching duration to the whole budget.

Per value, the cadence alternates between two events:

- **At arrival** (hand reaches boundary `B`): evaluate the *next* target `T_next`
  at `B+I`, **store it** (one new field, sibling to the existing `pendingSweep` —
  call it `pendingTarget`). Now `Δ = shortestPath(currentValue → T_next)` and
  `d = Δ/speed` are known. Schedule the *start* at real-time `(B+I) − d` and
  **sit** (not animating).
- **At the start** (`(B+I) − d`): `startAnimationRaw` toward the stored
  `pendingTarget` over `d`, clear `pendingTarget`, arrive exactly at `B+I`.

The phase is implicit in whether `pendingTarget` is set, so it's ~one extra field
(this is the resolution to the "chicken-and-egg" of needing `Δ` to schedule, but
`Δ` needing the future target — we just evaluate-and-store on arrival).

Properties:
- **Ticks** (fast snap, not a stretched sweep) and **1× idle** (sits between snaps).
- **On-beat**: the snap finishes *at* the boundary, vs the legacy ~`d`-late arrival.
- **No re-eval at start** — the interpolation frames in between are free.
- **Graceful degrade**: for a fast/smooth hand where `d ≥ I`, the start time is
  already ≤ now → it animates immediately and continuously (correct for bps=0).
- **Reset/step**: clear `pendingTarget` and snap to `now` (instant response).

Astronomy cost (single-thread version): the eval-at-arrival looks a full interval
ahead, but happens **once per interval, staggered across values** — the negligible
1× case the original "minimal impact" analysis actually holds for. Scrub stays on
the current-time path, so the place that thrashed never takes this branch.

## (B) Worker-threaded look-ahead pipeline

Because astronomy is **deterministic** given (display time, location, mode), the
worker can compute any future boundary's target without main-thread coupling, as
far ahead as we like. This both hides latency and gives the worker its **own
`AstroCachePool`**.

> **Correction (owner, 2026-06-26).** Earlier drafts framed the win as "worker pool
> on future times vs. main pool on `now` → no thrash." That split is now obsolete:
> the terminator and analemma are **fully ported to ObsValues**, so the main thread
> runs **no astronomy during steady-state animation**. The benefit is therefore not
> "avoid two-pool thrash" but simply **moving the entire update-pass cost (all
> astronomy + all expression eval) off the main thread**. See the elaboration in
> *“Worker bundling — safety findings”*.

Split of labor: the **update pass** (evaluate expressions + astronomy → target)
runs on the worker; the **animate pass** (interpolate toward the latest target)
stays cheap on the main thread.

### Producer/consumer cadence (the intended design)

Always keep the worker a step or two ahead:

- When the main thread **arrives at update time `T`**, ask the worker to start
  computing the target for `T+2`.
- The worker should already be **done with `T+1`**, so the main thread uses that
  target to schedule the animation toward it (starting immediately if `(T+1) − d`
  is already past; otherwise waiting until the worker finishes if it's behind).
- When the worker finishes `T+2`, record it in the slot the main thread will read
  **at arrival `T+1`**.

So it's a ring buffer of precomputed `(boundary, target)` per value, depth `N`.
`N = 1` is the minimum (T+1 ready at T). Going deeper (`N ≥ 2`) **absorbs jitter**
and lets occasionally-expensive calculations (rise/set refinement, eclipse
geometry) amortize across several intervals without stalling a single frame.

If a needed target *isn't* ready when due (worker behind / very expensive calc),
the main thread either waits (hand sits a beat late) or falls back to a synchronous
main-thread eval for that value that frame. Buffer depth `N` is tuned to make this
rare.

### Determinism, state mirroring, invalidation

- Mirror env state to the worker: location (lat/lon), tz, mode flags (noonOnTop,
  kyMode, kyHandMode, selected body), and the scrub unit/direction (which sets the
  spacing of upcoming display-time boundaries).
- Tag the mirrored state with a **generation counter**. The worker stamps each
  result with the generation it was computed under; the main thread **discards
  stale-generation results**. Any transition (location/mode/rate/direction change,
  DST, step, Now) bumps the generation → invalidates the buffer → worker refills
  from the new state; the main thread does one synchronous eval for the current
  frame so the watch responds instantly while the worker catches up.
- During scrub the display clock advances deterministically (`D + k·unit` per
  tick), so each value's upcoming *update boundaries* — the same boundaries it has
  at 1× — are equally deterministic; the worker walks them forward (it is *not* fed
  one eval per tick — see *“Computing T+1, T+2”*). A scrub-rate change re-spaces the
  display progression → generation bump.

### Worker bundling

The astronomy modules and the expression parser/evaluator are pure math / no DOM,
so they're worker-safe; they'd be bundled into the worker. Verify no DOM/`document`
reach-through during the move.

## How the pieces fit

- (A) on its own gives on-beat ticks + idle on the main thread; the eval-at-arrival
  is the only astro cost and it's the benign 1× case.
- (B) makes (A) trivial: the worker supplies `pendingTarget` *before* arrival, so
  the main thread just reads it, computes `d`, schedules the start, and
  interpolates — all cheap, with the expensive eval fully offloaded and on a
  separate cache.
- Net target state: lag-free on-beat ticks, 1× idle, **and** heavy faces that hold
  frame budget during scrub because astronomy runs in parallel on its own cache.

## Resolved decisions (owner, 2026-06-26)

The open questions are now answered. Each maps to a section below.

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Per-value vs **batch** eval | **No batch.** Centralized event queue + tiny per-value result buffer. | Batch re-evaluates values that aren't due → wasted CPU, the exact thing we're trying to save. |
| 2 | Fallback on a **buffer miss** | **Fail fast: wait one beat, log a warning.** No synchronous main-thread fallback. | A miss means our look-ahead strategy is wrong; we want it loud and visible, not silently papered over. Revisit only if logs show unavoidable misses. |
| 3 | **Overhead vs benefit** gating | **Start with all values on the worker.** No cost-threshold gate. | Simpler; add gates later only if profiling shows the cheap-value message traffic matters. |
| 4 | `finish()` / `reset()` across the boundary | Generation bump + clear buffers + one sync eval (reset); + snap/freeze/clear pendingTarget (finish). | See *“finish() / reset() across the thread boundary”*. |
| 5 | **Memory** / buffer depth `N` | **`N = 2`.** | Exercises the `N ≥ 1` machinery and gives a full interval of compute slack per result; tune later. |
| 6 | **Arrival detection** | Animation-**completion** event in the animate pass (not an expression-boundary timer). | See *“Arrival detection”*. |

## Bookkeeping design (the core)

The worry in the original draft was "per-value pipelines and ring buffers = a lot
of bookkeeping." The resolution is to **split scheduling from storage**:

- **One centralized event queue** (per face) drives *when* things happen.
- **A tiny per-value result buffer** (depth `N`, the ring) holds *what was
  computed ahead*.

This avoids both rejected extremes: it is **not** batch eval (we only ever compute
a value at a boundary it actually has), and it is **not** a forest of independent
per-value timers (one queue orders everything).

### Three data structures

1. **Start-event queue** `Q` (per face): a min-heap of
   `{ realTime, value }` entries — the real `performance.now()` at which a value
   should *begin* its on-beat snap toward an already-known target. Drained each
   frame "until the head time has not yet passed" (exactly the owner's proposed
   loop). This is the only *timer* in the system.

2. **Per-value result buffer** `v.ahead`: a small FIFO (cap `N`) of
   `{ boundaryDisplayMs, target, generation }` — targets the worker has
   precomputed for this value's upcoming boundaries. `N = 2`.

3. **Worker request queue** (mirrored main↔worker): outstanding
   `{ valueId, boundaryDisplayMs, generation }` compute tasks. The worker drains
   it, computes each target, and posts results back; the main thread files each
   result into the matching `v.ahead`.

There is **no** per-value `setTimeout`/`nextUpdateTime` polling for the eval pass —
`Q` subsumes it. The per-frame *animate* pass still iterates the values that are
actively interpolating (unavoidable — that's the interpolation), but values that
are *sitting* between snaps are not animating and cost ~nothing.

### The two-event cadence (per value)

With on-beat scheduling each value alternates between exactly two events per
interval. For value `v` with interval `I`, boundaries `B_0, B_1, …` (display-time
multiples of `I`; at 1× display == real):

- **Arrival** (animation just completed, hand sits on `B_k`): detected in the
  animate pass (§*Arrival detection*). On arrival we:
  1. Take `T_{k+1}` from the front of `v.ahead` (the worker computed it during the
     previous interval).
  2. Compute `Δ = shortestPath(currentValue → T_{k+1})` (mod `v.period`) and
     `d = |Δ| / speed`.
  3. Stash `T_{k+1}` in `v.pendingTarget` and push `{ realTime: B_{k+1} − d, v }`
     onto `Q`. (If `B_{k+1} − d ≤ now`, push with `now` → it starts this frame;
     this is the `d ≥ I` graceful-degrade / continuous-sweep case.)
  4. Request the worker to compute `T_{k+1+N}` (= `T_{k+3}` at `N=2`), keeping the
     buffer full.

- **Start** (`Q` head fires at `B_{k+1} − d`): `startAnimationRaw(v.anim,
  v.pendingTarget, now, …, d, v.period)`, clear `pendingTarget`. The hand snaps at
  its natural speed and **arrives exactly on `B_{k+1}`**, where the cycle repeats.

`pendingTarget` is the single new `ObsValue` field — sibling to the existing
`pendingSweep` — and the phase (sitting vs sweeping) is implicit in whether it is
set. This is the "chicken-and-egg" resolution from §(A): we need `Δ` to schedule
the start, and `Δ` needs the future target, so we **evaluate-and-store on arrival**
(the worker having done the evaluation ahead of time).

### Computing T+1, T+2 — an incremental walk, not multiples

**Confirmed (owner, 2026-06-26): the boundary sequence is walked incrementally,
and — importantly — it is the *same* sequence in 1× and scrub.** `T_{k+1}, T_{k+2}`
are the value's own successive **update boundaries in display time**, computed by
walking `computeNextBoundary` ([animation.ts:275](../src/shared/animation.ts)) per
value, per direction:

```
B_{k+1} = computeNextBoundary(I, getNow@now, dir)
B_{k+2} = computeNextBoundary(I, getNow@(B_{k+1} + ε·dir), dir)   // step past B_{k+1}, ask again
```

This incremental walk is **mandatory**, not just cleaner, because:
- **Sentinel intervals are irregular.** Negative `updateInterval`s
  (`EC_UPDATE_NEXT_SUNRISE = −1001`, …, `EC_UPDATE_NEXT_SUNSET_OR_MIDNIGHT`,
  [animation.ts:47-56](../src/shared/animation.ts)) resolve to *astronomical
  events*, whose spacing is not constant — "next sunrise after the next sunrise"
  requires re-resolving from a time past the first.
- **Even positive intervals aren't pure multiples** — `computeNextBoundary`
  aligns daily boundaries to **local** midnight (tz-shifted) and respects DST, so
  `B + I` can be off by an hour across a transition.
- Direction matters: reverse walks to the *previous* boundary each step.

> **Correction (owner, 2026-06-26): scrub is NOT per-tick.** An earlier draft said
> the scrub eval points are "the upcoming ticks." Wrong — and it would throw away
> the very CPU saving we want. During scrub a value is re-evaluated **only when the
> accelerated display time reaches the value's next update boundary**, exactly as in
> 1×. A slow part (e.g. a 300 s day-night ring) under a slow scrub does **not**
> recompute every 0.1 s tick — it recomputes only on the ticks where display time
> actually crosses one of *its* boundaries. The shipped baseline already does this
> ([updater.ts:318 `updateObsValueScrub`](../src/shared/updater.ts)): it schedules
> `nextUpdateTime = now + ticksUntilUpdate·tickInterval`, where
> `ticksUntilUpdate = max(1, ⌈displayΔ-to-boundary / displayΔ-per-tick⌉)`.

So **only the display→real budget mapping differs between modes**, never the
boundary sequence:

| | next eval point (display time) | real-time budget to it |
|---|---|---|
| **1× / reverse** | next boundary `B_{k+1}` | `B_{k+1} − now` (display↔real 1:1) |
| **Scrub** | next boundary `B_{k+1}` | `ticksUntilUpdate · tickInterval` (compressed) |

Two regimes fall out of the budget formula, both already handled:
- **Slow scrub** (boundary many ticks away): `ticksUntilUpdate` large → the value
  sleeps across the intervening ticks. **This is the CPU win.**
- **Fast scrub** (several boundaries inside one tick): `ticksUntilUpdate` floors at
  `1`, so the value re-evaluates at most once per tick and snaps — the only regime
  that approaches per-tick cadence (and it can't display faster than one tick
  anyway).

The worker therefore receives, per request, a fully-resolved
`boundaryDisplayMs` (the main thread walks the sequence and hands the worker an
absolute display instant to evaluate at) — the worker never re-derives the schedule
and never knows about ticks vs 1×; it just evaluates `A(boundaryDisplayMs)`. This
keeps all the sentinel/DST/direction/compression subtlety on the main-thread side
of the wire.

### Walkthrough at `N = 2`

Steady state, value at boundary `B_k`, `v.ahead = [T_{k+1}, T_{k+2}]`:

```
arrival@B_k:  consume T_{k+1}  → ahead=[T_{k+2}]; schedule start@(B_{k+1}−d);
              request T_{k+3}  → worker computes it during [B_k, B_{k+1}]
start@B_{k+1}−d: animate → arrives@B_{k+1}
result T_{k+3} arrives:  ahead=[T_{k+2}, T_{k+3}]   (full again)
arrival@B_{k+1}: consume T_{k+2} → …
```

The worker always has a **full interval `I`** to compute one value's next target —
that is the jitter/expensive-calc absorption `N ≥ 2` buys. `N = 1` would demand the
result within the same frame as arrival; `N = 2` is the first depth with real slack.

### Why a queue, not a sweep over all values

Draining `Q` touches only the values whose start time has passed this frame
(typically 0–3). It is the natural home for the owner's "keep working until the
update time has not yet passed" loop. The worker side mirrors it: a FIFO work
queue, processed by due `boundaryDisplayMs`, so the *soonest-needed* target is
always computed first even when the worker is briefly behind.

## Arrival detection

**What the question means.** On-beat scheduling fires the arrival action off the
*completion of the animation* (the hand physically reaching `B_k`), **not** off a
wall-clock "expression boundary" timer. If we instead re-evaluated at the boundary
*time*, we'd act before or after the hand visually arrives and lose the on-beat
property (and double-fire during the `d ≥ I` continuous case).

**How.** Generalize the existing Phase-2 handoff already in `animateObsValue`
([updater.ts:524](../src/shared/updater.ts) — `if (!v.anim.animating &&
v.pendingSweep)`). The on-beat version, per value, in the animate pass:

```
animateObsValue(v):
  v.currentValue = interpolate(v.anim, now)
  if (v.anim just transitioned animating → !animating):   // ARRIVAL
      onArrival(v)        // consume ahead-buffer, compute d, schedule start, request next
```

"Just transitioned" needs an explicit edge (store `wasAnimating`, or have
`startAnimationRaw` mark completion) so arrival fires **once**, not every idle
frame. This is the "must be precise" caveat: arrival is an *edge*, the start is a
*time*. Sitting values (post-arrival, pre-start) are `!animating` with
`pendingTarget` set — they are skipped by both passes until `Q` fires their start.

## finish() / reset() across the thread boundary

**Reset** (`updater.reset()`; env changed — location, mode toggle, DST, scrub
rate/direction, body switch) means "everything you precomputed is now stale."
Across the worker boundary:

1. **Bump the generation counter** (mirrored to the worker with the new env state).
2. **Clear every `v.ahead`** and `v.pendingTarget`; flush `Q`.
3. Worker results tagged with an **older generation are discarded** on arrival
   (they may already be in flight).
4. The main thread does **one synchronous eval** for the current frame so the
   watch responds instantly, then re-arms the cadence; the worker refills `ahead`
   from the new state. (This is the only place a main-thread astronomy eval
   happens in steady state — it is the deliberate "respond now, catch up async"
   seam, *not* the rejected per-miss fallback.)

**Finish** (`updater.finish()`; step / transport / scrub-end / stopped-clock
freeze) = reset's invalidation **plus** snap-and-freeze: clear `pendingTarget`,
set `anim.currentValue = anim.targetValue` (wrapped to `[0, period)` for cyclic
values), `animating = false`, write `v.currentValue`, freeze schedules. Because
the value snaps to its *current* target and freezes, no buffered future target is
consumed; bumping the generation ensures a stray late worker result can't
resurrect motion after the freeze. The stopped-clock idle invariant
(`planning/2026-06-03-stopped-clock-rendering.md`, Dev Rule §6) is preserved: a
frozen value has no `Q` entry and an empty `ahead`, so nothing re-evaluates and the
worker goes idle (no outstanding requests).

> **Subtlety to verify against the stopped-clock rules:** when `finish()` lands on
> a *sitting* value (arrived at `B_k`, `pendingTarget` set, frozen time between
> `B_k` and `B_{k+1}`), legacy `finish()` snaps to `anim.targetValue` — which is
> `B_k`'s target, where the hand already sits. That matches "freeze where you are."
> Confirm no face expects the *interpolated mid-interval* position on freeze; the
> ObsValue port's `finish()` already snaps to `targetValue`, so this is unchanged.

## Determinism, state mirroring, invalidation (Chronometer specifics)

The worker recomputes astronomy from mirrored state; it must match the main
thread's env **bit-for-bit**, including Chronometer's quirks:

- **Mirror to the worker:** `lat`, `lon`, `tzOffsetSeconds`, **`beatsPerSecond`**
  (the quantizer — the worker must quantize candidate boundary/eval times the same
  way `faceGetNow` does, see §*beatsPerSecond seam* in the port doc), mode flags
  (`noonOnTop`, Kyoto `kyMode`/`kyHandMode`, Venezia selected body, Terra slot
  overrides, global location slot), and the scrub `unit`/`direction` (which sets
  upcoming display-boundary spacing).
- **Generation counter** tags mirrored state; the worker stamps each result; the
  main thread discards stale-generation results (§*finish/reset*). Any transition
  bumps it.
- **Scrub** advances display time deterministically (`D + k·unit` per tick); each
  value's *update boundaries* within that progression are what the worker walks
  (once per boundary, **not** once per tick — *“Computing T+1, T+2”*). A rate change
  re-spaces the progression → generation bump.
- **Per-face worker context.** One `Updater` per face → one generation + one mirror
  per face. Whether faces share a single worker (multiplexed by face id) or get one
  worker each is a *Phase B-2* tuning call; start with **one shared worker** posting
  `{faceId, valueId, …}` and measure.

## Worker bundling — safety findings

Audited the modules the worker must bundle (astronomy + `expr` parser/evaluator +
the env-function bodies). Worker-safe with three mirror/guard points:

- **`astro-env.ts:1161` uses `navigator.language`** (locale for formatting).
  `navigator` exists in workers, but to stay deterministic, **mirror the resolved
  locale** into the worker rather than reading it there (part of the state mirror).
- **`watch-env.ts` imports `getState`** (LocalStorage-backed). The worker **cannot**
  call `getState`; all state arrives via the mirror message. Factor a worker-safe
  env builder that takes explicit state instead of reading `getState`/the DOM.
- **`analemma.ts` `OffscreenCanvas`/`getContext`** is **bitmap construction**, which
  **stays on the main thread**. The worker bundles only the analemma *math*
  (`analemmaPathParameter()` / `analemmaRotation()` → `fractionOfVernalEquinoxYear`,
  `sunSkyOrientationAngle`), never the draw/bitmap code. Confirms the worker bundles
  a *subset*: pure math, no rendering.

The worker holds its **own `AstroCachePool`**. Note the "two pools working
concurrently, no thrash" framing in §(B)'s intro is now **largely historical**:
that concern dates from when the terminator/analemma still evaluated astronomy at
`now` on the main thread *during* eval-ahead's future evaluation. **They are now
fully ported to ObsValues**, so during steady-state operation the main thread does
**no astronomy at all** — it only interpolates `currentValue`s and renders
(render-time `evalAttr` is on geometry attrs, not astronomy). The update pass (the
*only* astronomy) moves **wholesale** to the worker. So the real story is simpler
than "split two pools": the **worker owns astronomy, the main thread owns
interpolation + rendering.** The main thread's pool survives only for the rare
non-per-frame astronomy — the `reset()` sync eval and static-cache rebuilds at
event boundaries (mode/date/tz/resize) — which never run concurrently with the
worker's per-frame look-ahead.

## Phases

Two independently landable, independently verifiable phases. (A) is lower-risk and
useful on its own; (B) is where the CPU win lands.

### Phase A — on-beat scheduling, single-thread

**Status: ✅ COMPLETE (2026-06-27).** `onBeat` flag added to `ObsValue`;
`onBeatStep` (sit/sweep state machine + arrival edge + stopped-settle) added to
`updater.ts`; Chronometer flipped from `EVAL_AHEAD=false` to `onBeat:true` (except
`masterOffset`). `finish(env)` bakes `A(now)` on freeze paths; engine + bench
updated. tsc clean; heaviest face (Mauna Kea) renders live with no console errors.
Owner verified the on-beat behavior in-browser (added a `performance.now()` readout
to confirm hands land on the beat, differing from the committed code). Regression
goldens re-captured to bless the live-motion timing; **full suite green (8539
tests)**. Stopped/paused/stepped/scrub-released states preserve exact legacy values
(settle-to-exact-time); only live-motion timing changed, as intended.

Re-enable eval-ahead for Chronometer **as on-beat scheduling**, no worker yet.

> **Implementation deviations from the sketch (decided 2026-06-27, during build):**
> 1. **On-beat is an opt-in `onBeat` flag, not a rewrite of the `evalAhead`
>    branch.** Audit found the shared `evalAhead` branch is still used by the
>    **Inspector** (`evalAhead: true` + `animSpeed: JUMP`, an animate-over-budget
>    semantics distinct from on-beat's sit-then-snap). Replacing it in place would
>    regress the Inspector. So `onBeat` is a new `ObsValue` flag; Chronometer's
>    values set it, Inspector/Observatory are untouched. The legacy
>    snap-at-boundary / scrub-compression / eval-ahead branches all remain for their
>    existing consumers. (A later, separate task may migrate the Inspector.)
> 2. **No centralized start-event queue `Q` in Phase A.** The single-thread version
>    reuses the existing per-value `nextUpdateTime` scheduling (which already drives
>    the idle-wakeup `nextWakeupTime()`): a *sitting* value sets `nextUpdateTime =
>    startTime`, so the idle scheduler wakes exactly when the snap should begin.
>    Arrival is the animation-completion edge, detected in the per-value step. The
>    centralized `Q` is introduced in **Phase B**, where it organizes worker
>    requests; it buys nothing over per-value `nextUpdateTime` in single-thread.
> 3. **`masterOffset` (Vienna/Kyoto ring rotation) stays non-on-beat.** It must flip
>    at a *constant* `animSpeed` to stay coherent with the `dialFlip` dials
>    (`update='0'`), so it keeps the legacy snap path — same reasoning that kept it
>    off eval-ahead ([hand-values.ts:210-221](../src/watch/hand-values.ts)).

- A-1. Add `pendingTarget` to `ObsValue`; add the per-face start-event queue `Q`
  and the arrival edge to the animate pass (updater.ts).
- A-2. Replace the eval-ahead update branch's "stretch across the interval" with
  the arrival→schedule-start→snap cadence. Evaluate the next target **synchronously
  on arrival** for now (worker comes in Phase B); store in `pendingTarget`.
- A-3. Flip Chronometer's `EVAL_AHEAD` back on (per-value `evalAhead: true`),
  delete the snap-at-boundary / scrub-compression baseline branches *only* once A
  is verified to subsume them.
- A-4. Verify: ticks (not sweeps) at 1×; 1× idle between snaps; on-beat arrival
  (bps=1 hand lands *on* the second); single-time astronomy during scrub (no cache
  thrash). Compare the three FPS numbers against the `EVAL_AHEAD = false` baseline —
  expect equal-or-better CPU and restored idle.

**Phase A alone resolves the three original regressions** and gives on-beat
precision; it is shippable without (B).

### Phase B — worker-threaded look-ahead

Offload the on-arrival evaluation to a worker.

- B-1. Factor a **worker-safe env builder** (explicit state in, no `getState`/DOM)
  and bundle astronomy + `expr` + env-function bodies into a worker entry. Verify
  no DOM/`getState`/`navigator` reach-through (the three points above).
  **✅ DONE (2026-06-27, env-builder half).** `createWatchEnvironment` is now pure:
  the `body`/`noonOnTop`/`kyMode`/`kyHandMode` overrides became an explicit
  `WatchEnvOverrides` param instead of an in-builder `getState()`/`window` read. The
  main thread supplies them via `readPersistedOverrides()` (engine-entry), threaded
  through all 7 call sites; the worker (B-2) will supply the same shape from its
  mirror. Verified: the worker-bundle module set (`watch-env`, `astro-env`,
  `animation`, `obs-value`, `updater`, `expr/*`, `astronomy/*`, `terminator`,
  `analemma`) is grep-clean of `window`/`document`/`getState`/`localStorage`;
  remaining browser-API touches are `navigator.language`/`getBattery` (guarded,
  worker-available) and `OffscreenCanvas` (a worker API). tsc clean, full suite
  green (8539), and the override path verified live (Venezia `?body=mars` →
  "Mars Trans", planet 5). **Remaining for B-1:** create the actual worker entry +
  esbuild bundle target (deferred into B-2 wiring).
- B-2. Wire the **mirror message** (state + generation) and the **request/result**
  protocol; give the worker its own `AstroCachePool`. Start with **one shared
  worker**, all values, `N = 2`.
  **✅ (i) done (2026-06-27): build/transport proof.** `src/watch/eval-worker.ts`
  bundles to `dist/chronometer-worker.js` (separate esbuild target in build.sh,
  90 kb). Verified in-browser: the worker **loads worker-safe** (force-imports the
  pure `createWatchEnvironment`; a DOM-touching module-init would have thrown on
  load — it didn't, `onerror` never fired) and **round-trips real astronomy** —
  `{type:'ping', timeMs: 2026-06-27T12:00Z}` → `{di: 804254400, moonAge age 2.665 /
  phase 0.944}`, echo preserved, no console errors. Confirms the bundling +
  transport approach. Note: under `file://`, `new Worker(url)` is blocked, **but a
  Blob-URL worker works** (`new Worker(URL.createObjectURL(new Blob([src])))`) — it
  just needs the worker source inlined (can't `fetch()` on file://). So file://
  support is possible via the blob path; otherwise fall back to the Phase-A
  synchronous on-beat path (the worker is an optional accelerator).

  **✅ (ii) done (2026-06-27): worker-core + determinism proven.**
  `src/watch/worker-core.ts` is the pure, node-testable worker logic — builds a face
  env from mirrored state and evaluates value exprs at future boundaries via the
  same overridable seam + bps quantizer as the engine. A shared
  `src/shared/time-quantize.ts` (`quantizeGetNow`) is now the single quantizer used
  by both `engine-entry` and `worker-core` (no drift). `src/__tests__/worker-core.test.ts`
  asserts the worker's targets are **bit-identical** to a main-thread eval-ahead
  reference for **every face × every ObsValue × 11 time offsets** (sub-second →
  300 days) — all 16 pass; full suite 8555 green. Three findings that shaped the
  protocol:
    1. **`DOMParser` is unavailable in a dedicated worker**, so the worker does not
       parse XML — it receives the already-parsed `initExprs` + per-value
       expression ASTs (plain objects → structured-cloneable). Added `WatchEnvSource`
       (`{ initExprs }`) so the worker passes only the init ASTs, not the parts tree
       or image data.
    2. **Init blocks evaluate at construction-time `getNow`**, so the worker must
       build its env at the **same display instant** the main thread mirrored
       (`WorkerFaceInit.nowMs`); otherwise date/calendar/UT-base values captured at
       init diverge. A later main-thread env rebuild bumps the generation and
       re-inits the worker at the new `nowMs`.
    3. **ObsValue *names* are not unique** — `refName` parts share a name (e.g.
       Babylon's four `year` digit wheels are all `Babylon.year.angle`). The engine
       is unaffected (renderer uses direct `part._obsAngle` refs), but the **worker
       request/result protocol must key values by a unique id**, not the name.
  **✅ (iii-a) done (2026-06-27): protocol + dispatcher + client.**
  `src/watch/worker-protocol.ts` defines the `init`/`req`/`res` messages (generation
  on every message; values keyed by unique id). `WorkerDispatcher` (in worker-core)
  owns the per-face map and gates `req` by generation (stale/unknown → dropped).
  `eval-worker.ts` is now just postMessage glue around it. `src/watch/worker-client.ts`
  is the main-thread wrapper: spawns `chronometer-worker.js`, exposes
  `available` (false ⇒ engine uses the Phase-A sync path), and has the Blob-URL
  fallback for `file://`. Verified: node test drives the dispatcher through
  `structuredClone` (proves the payload — incl. ASTs — is postMessage-safe) and the
  results match the main thread; generation-gating drops stale/unknown reqs; and the
  **real bundled worker** round-trips `init`+`req`→`res` in-browser (hand-built AST
  cloned over real `postMessage` → `hour24Number` = 5 at 12:00 Z / PDT). Full suite
  8557 green. (Worker bundle is now 1.2 MB — it bundles the full astronomy/env graph,
  shared with the engine; fine for budget.)
  **✅ (iii-b) done (2026-06-27): engine render-loop integration.**
  `ObsValue` gained `ahead` (depth-`N=2` buffer) + `aheadPending` + a `requestAhead`
  hook. `onArrivalOnBeat` now: if `requestAhead` is set, **request** upcoming
  boundaries + **consume** the precomputed target (miss → fail-fast: sit a beat,
  throttled warn, self-heals); else the synchronous Phase-A eval (unchanged).
  Engine spawns one shared `WorkerEvalClient`; `maybeReinitWorker(face)` runs each
  frame and re-`init`s (bumping generation) only when a **state fingerprint**
  (location / DST tz / overrides / bps / Terra slots) changes — NOT on the per-tick
  env rebuild (time is handled by `withDisplayTime`). Results route into `ahead` with
  generation filtering. `reset()`/`finish()` clear the buffers. When
  `!client.available` (file://, no workers) the values keep `requestAhead` unset →
  exact Phase-A path.
    - **Interval gate added (decision #3's deferred gate, now empirically required).**
      First run flooded misses on `second.angle` (`update='.1'`, a 10 Hz *arithmetic*
      value): offloading cheap/fast values just spams the worker and misses every
      beat. `isWorkerEligible = onBeat && (interval < 0 || interval ≥ 2 s)` — astro
      values (coarse intervals / event sentinels) offload; cheap sub-second hands
      stay synchronous.
    - **Also fixed a B-1 regression**: the map-drag location site
      ([engine-entry.ts] `newLat,newLon`) had lost its `readPersistedOverrides()`
      arg; restored.
    - **Verified in-browser** (Mauna Kea, the heaviest face): worker bundle fetched
      → active; astro values offloaded; **zero steady-state misses; no console
      errors**; renders identically to Phase A (determinism guarantees value
      equality). tsc clean; full suite **8557 green** (node has no worker → exercises
      the sync path).
    - **Testing gotcha**: `python3 -m http.server` sends no cache headers, so the
      browser serves **stale bundles** after a rebuild — verify on a fresh port to
      bust the cache.
  **Refinements (2026-06-27):**
    - **Interval gate removed.** The "0.1 s second hand can't round-trip" finding was
      an artifact of a *stale cached bundle* (the throttle wasn't firing either —
      impossible with fresh code). Fresh + ungated: a 0.1 s value misses ~2×/3 s
      (rare, self-healing), confirming a postMessage round-trip easily fits 100 ms.
      So `isWorkerEligible = v.onBeat` (offload all, per decision #3). A cheap-value
      gate remains a possible *traffic* optimization, not a correctness need.
    - **Observability:** startup logs `[eval-worker] ENABLED/DISABLED (reason)`;
      `?noworker` force-disables for same-machine A/B.
    - **file:// is worker-OFF** (`new Worker(url)` blocked; Blob-URL fallback would
      need the 1.2 MB source inlined → bundle bloat for a dev-only path, deferred).
      Test on http.

  **(iv) measurement — IN PROGRESS / blocked on a representative device.**
  A/B on the headless preview (Mauna Kea, scrub 1 day/tick): worker ON 16.1 fps /
  CPU 1.5 ms / GPU 52 ms; worker OFF 16.2 fps / CPU 1.3 ms / GPU 51 ms — **no fps
  difference**. Cause: the preview is **GPU/render-bound** (that 51 ms "GPU flush" is
  almost certainly *software* rasterization in the headless browser), so CPU
  astronomy isn't the bottleneck there and offloading it can't move fps. The
  worker's win only appears when **CPU-bound** — the prerequisite's "16 fps, >½ CPU"
  regime. **The headless preview is not representative; measure on the real slow
  target** (http, scrub a heavy face, `?noworker` A/B, watch the CPU number — not
  just fps). Also note `[scrub-perf]`'s "Pure Animation Frame Stats" cover only the
  *interpolation* frames (no astronomy ever), so they understate the worker by
  construction — a per-tick-frame CPU measure would show it directly.

  **⚠️ DECISIVE FINDING (2026-06-27): astronomy is NOT the per-frame bottleneck —
  rendering is.** Added a per-frame CPU split to `[scrub-perf]` (tick = updater
  update+astro+animate vs render = `renderFrame` draw-command issuance). Mauna Kea,
  1 day/tick scrub, headless preview:
    - worker ON:  tick **0.23 ms**, render **1.63 ms**
    - worker OFF: tick **0.23 ms**, render **1.65 ms**
  The tick time (which *includes* astronomy) is **identical** with the worker on or
  off and is **tiny** — because the `AstroCachePool` already collapses the work (all
  ~48 day/night wedges share one cached rise/set compute per display instant). So
  **the worker offloads an already-cheap cost** (~0.23 ms), which is why on/off shows
  no difference. The JS CPU per frame is dominated by **render (≈1.6 ms)**, and the
  ~58 ms wall frame by GPU rasterization (~50 ms — software in the headless preview,
  not representative).

  **Implication:** the premise that astronomy CPU is the scrub bottleneck does not
  hold here — the astro cache already solved it. Before more worker work, **measure
  the split on the real slow device** (the new `[scrub-perf]` "Frame CPU split"
  line): if `tick` is small there too, the worker cannot help and the lever is
  **rendering** (draw-call issuance + canvas/GPU). The worker pipeline is complete,
  correct, and harmless (gated + sync-fallback), but its value is unproven and looks
  unlikely on cache-warm faces.

  **CONFIRMED on the real target — all.html (2026-06-27).** all.html (all faces in a
  grid, the worst case for CPU+render+scrub-fps) is where the tick cost is large
  (owner's machine: tick **102 ms**; preview ~17 faces: tick **22.7 ms**). A/B there:
    - worker ON:  tick 22.66 ms / render 12.29 ms
    - worker OFF: tick 23.52 ms / render 13.65 ms
  The worker saves **~1 ms of ~23 ms (≈noise)**. So even on the heavy page, astronomy
  is ≈1 ms; the remaining ~22 ms (102 ms on the slow machine) is **per-value
  per-frame machinery** — interpolation + the on-beat sit/sweep state machine +
  boundary walking (`computeNextBoundary`) — across the *thousands* of ObsValues on
  17–25 faces, all ticked every frame. **The worker is the wrong lever for the
  thing that's actually slow.**

  **PIVOT (recommended): optimize the per-value tick pass, not astronomy.** Concrete
  levers, in rough priority:
    1. **Double interpolation** — `onBeatStep` interpolates AND the subsequent
       `animateObsValues` interpolates the same value again (the integration left
       both). Eliminate the second pass for on-beat values (keep it for the
       fixed-duration/drag path).
    2. **Skip sitting/idle values** — a value that is `!animating` (sitting between
       beats, or frozen) needs no interpolation; today every value is touched every
       frame. Maintain an "active" subset.
    3. **Only tick visible/on-screen faces** (all.html renders a grid; off-screen or
       tiny thumbnails could tick less often).
    4. **Reduce boundary-walking** — `ensureRequested`/`computeNextBoundary` per
       arrival (×3 in worker mode) adds main-thread work; the worker path made this
       *worse*, not better.
  **Decision needed:** keep the worker (harmless, gated, but ~0 benefit + added
  complexity) or shelve/revert it, and pivot to the tick pass.
- B-3. Replace Phase A's synchronous on-arrival eval with a **buffer read** from
  `v.ahead`; on a miss, **wait one beat and log** (fail-fast, decision #2). On
  `reset()`/`finish()`, bump generation + one sync eval (decision #4).
- B-4. Verify on the slow target: the **CPU portion** of the frame drops (the
  update pass moved off-thread); raw-headroom FPS rises; scrub on heavy faces
  (Mauna Kea terminator+analemma, Kyoto wadokei) holds budget. Watch the console
  for buffer-miss warnings — any sustained misses mean the look-ahead is mis-tuned
  (revisit `N` or worker scheduling), per decision #2.

## What to offload — all of it

**Owner direction (2026-06-26): there is no meaningful astronomy-vs-other-CPU
distinction; offload the entire update pass.** The worker computes every value's
target (expression eval + any astronomy it triggers); the main thread is left with
interpolation + rendering only. The thing to watch is **not** which values are
"worth" offloading but the **two costs the offload itself adds**:

- **Messaging CPU** — `postMessage` (de)serialization per request/result. Bounded by
  Σ(1/updateInterval) over values × `N`, which is a handful of small messages per
  second per face (on-beat means each value re-evaluates once per interval, not per
  frame). Use plain transferable-friendly payloads (numbers/ids, no object graphs).
  If it ever shows up, batch a face's due requests into one message per frame.
- **Memory** — `v.ahead` is `N=2` small records per value; the worker mirrors env
  state + its own `AstroCachePool` (one per worker, not per value). Negligible
  against the cities DB budget ([[observatory-memory-budget]]).

So the only gate is "keep messaging + memory cheap," not "is this value
astronomical." The earlier idea of cost-thresholding which values go to the worker
is **dropped**.

## Remaining open questions (narrowed)

- **One shared worker vs one-per-face** — start shared (B-2); revisit only if a
  single worker can't keep `N=2` full across all enabled faces.
- **Buffer-miss logging volume** — if fail-fast logging proves noisy under
  legitimate transients (e.g. a burst of resets), downgrade to a counter surfaced
  in the FPS overlay rather than per-miss `console.warn`.
