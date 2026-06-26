# Worker-Threaded Eval-Ahead Pipeline (with on-beat scheduling)

**Date:** 2026-06-26
**Status:** Exploratory — captured from discussion, **not scheduled**. Out of scope
for the current ObsValue port. Build on top of the port's
`EVAL_AHEAD = false` baseline (see
[2026-06-15-chronometer-obsvalue-port.md](2026-06-15-chronometer-obsvalue-port.md)).

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
far ahead as we like. This both hides latency and — crucially — gives the worker
its **own `AstroCachePool` working on future times**, while the main thread's pool
works on `now` (terminator / analemma / static rebuild). Different threads,
different pools → **no thrash**, plus parallelism. (Strictly better than a
single-thread two-cache split.)

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
- During scrub the upcoming boundaries are `D + k·unit` (deterministic in display
  time); the worker walks them forward. A scrub-rate change re-spaces the
  boundaries → generation bump.

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

## Open questions / risks (for when this is picked up)

- **Per-value vs batch eval.** Each ObsValue has its own update interval, so "T+1"
  differs per value → per-value pipelines and ring buffers, which is a lot of
  bookkeeping. Alternative: worker evaluates *all* values at a given display time
  in one message. Decide the granularity.
- **Fallback on miss** — wait vs synchronous main-thread eval; pick per value or
  globally. Depends on buffer depth `N`.
- **Overhead vs benefit** — message-passing helps most during scrub / on heavy
  faces; at 1× the worker mostly idles. Consider gating worker use to faces above
  an astronomy-cost threshold, or accept always-on for simplicity.
- **`finish()` / `reset()` semantics** across the thread boundary (generation bump
  + immediate sync eval, as above).
- **Memory** — per-value ring buffer of `N` precomputed targets.
- **Arrival detection** must be precise (the schedule fires off animation
  *completion*, not an expression boundary).

## Prerequisite / how to evaluate it

The three-number FPS indicator (raw headroom = `1000/median(frame-work-ms)`,
actual-when-animating = `1000/median(inter-frame Δ)`, average = throughput) is the
measurement tool for whether (B) actually buys frame budget. Land that first so
this work can be judged on the "raw headroom" number rather than the vsync-pinned,
jitter-inflated metric.
