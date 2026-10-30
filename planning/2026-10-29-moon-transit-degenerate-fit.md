# Moon transit solver: degenerate fit after the precision switch

**Status**: built and verified on worktree branch
`claude/affectionate-ramanujan-24d48a` (one commit, rebased onto c1798df),
**not in main** — Steve tests natively and lands it (§6, §8).
**Created**: 2026-10-29
**Baseline**: c1798df (continuous-UTC commit 2); the investigation ran at
45a39bf and was re-gated after the rebase.
**Found by**: the golden audit of
[2026-10-28-continuous-utc-ut1.md](2026-10-28-continuous-utc-ut1.md) §11, as
jitter of tens of seconds on Miami's 24-hour Moon transit indicator
(`planettransit24HourIndicatorAngle`).

## 1. Symptom

`planettransitTimeRefined` ([es-riseset.ts](../src/astronomy/es-riseset.ts))
returned, for the Moon's high transit seen from lat −5°, lon 36.8°:

| start instant (UTC)         | transit returned     |
|-----------------------------|----------------------|
| 2026-01-01 00:00:00 − 1 s   | 18:52:48.04          |
| 2026-01-01 00:00:00         | 18:52:48.04          |
| 2026-01-01 00:00:00 + 1 s   | 18:52:48.04          |
| 2026-01-01 00:00:00 + 10 min| 18:52:54.08          |
| 2026-01-01 00:00:00 + 1 h   | 18:52:47.81          |

(The parent audit saw 18:52:48.04 vs 18:53:13.70 for a sub-millisecond
change of start, from a different pool state.) The true full-precision
transit is **18:52:46.80**: the Moon's azimuth there is 0° to 0.04″, and
every start now returns it.

## 2. Mechanism

The solver seeds the Moon at `ECWBPrecision.Low`, iterates
`transitTime` with the `extrapolateToYEqualX` accelerator, and when two
successive tries agree to 0.1 s switches to `Full`. Trace of the start+0
case (tries and results in seconds relative to Apple-epoch 788 899 900;
the true transit is 66.80):

| i | precision | try        | result     | result − try |
|---|-----------|------------|------------|--------------|
| 0 | Low | 18500.000 | 854.101 | −17645.9 |
| 1 | Low | 854.101 | 103.850 | −750.3 |
| 2 | Low | 70.535471 | 70.766479 | +0.231 |
| 3 | Low | 70.776659 | 70.776660 | +0.000 → switch to Full |
| 4 | Full | 70.776660 | 66.969225 | −3.807 |
| 5 | Full | 70.535471 | 66.959045 | −3.576 |
| 6 | Full | 70.535472 | 66.959045 | −3.576 → exhausted |
|   | | returns extrapolation **68.045** | | |

Three things combine:

1. **The Low and Full lunar models disagree by 3.8 s of transit time**
   here (≈57″ of RA; Low keeps 29 of the 218 longitude terms). So at the
   switch, the function being solved jumps: the fit arrays hold four points
   on the Low curve (converged, result ≈ try) and the next point lands 3.8 s
   below them.
2. **The convergence branch of the switch keeps the Low fit points.** The
   other switch — at `i === numIterations − 1`, when Low never converged —
   does `fitTries = 0` with the comment "ignore any low-precision prior
   values". The convergence branch forgot to, in the iOS original as well.
3. **The quadratic degenerates on near-coincident abscissae.** Iteration 4
   is evaluated at the Low fixed point, i.e. at (to sub-microseconds) the
   same `try` as iteration 3, but with a result 3.8 s different.
   `extrapolateToYEqualX` guards only exact equality (`X2 !== X3`); the
   Lagrange parabola through points 1 µs apart in x and 3.8 s apart in y is
   numerically vertical, and its "closest root to Y3" is, by rounding,
   the *oldest* abscissa in the window (iteration 2's try). So the Full
   pass is re-evaluated at the two Low-era tries alternately — the
   "oscillation by 3.6 s" is the constant Low→Full offset at those two
   abscissae, not the Full pass failing to converge — until the 7
   iterations run out, and the solver returns the last extrapolation,
   itself a degenerate root (1–7 s off), unevaluated. Which root the
   rounding favours depends on bits of the start date; hence the jitter.

`planetaryRiseSetTimeRefined` has the same switch without the reset, but
with 20 iterations it recovers: after 3–4 wasted iterations the mixed fits
walk off the Low abscissae and converge normally (moonrise/moonset were
stable to 3 ms before the fix). The Sun and planets are never at Low
precision and are unaffected.

## 3. The fix (shared algorithm, three places)

All in [es-riseset.ts](../src/astronomy/es-riseset.ts); the iOS original
(`ESAstronomy.cpp` `planettransitTimeRefined`, `planetaryRiseSetTimeRefined`,
`extrapolateToYEqualX`) needs the same three edits (§7).

1. **`planettransitTimeRefined`, convergence-branch switch**: discard the
   Low points (`fitTries = 0`), give Full the same two shots the exhaustion
   branch grants (`if (i > numIterations − 3) i = numIterations − 3`), and
   `continue` so the first Full evaluation happens at the converged Low
   date without recording the Low point. The Full pass then runs on its
   own curve: evaluate at x₀, fit(1) = f(x₀), evaluate, linear fit (the
   Moon's contraction factor is ~0.04, so the line is accurate to
   milliseconds), evaluate → |Δ| < 0.1 s → return. If the budget runs out
   after two Full shots, the returned extrapolation is a linear fit
   through two Full points, not a degenerate root.
2. **`planetaryRiseSetTimeRefined`, convergence-branch switch**: the same
   `fitTries = 0` before `continue` (its `tryDate` is already the Low
   fixed point). Saves 3–4 iterations per Moon rise/set solve — the
   per-wedge rise/set recompute is the scrub bottleneck.
3. **`extrapolateToYEqualX`**: abscissae within
   `kFitCoincidentAbscissaTolerance = 1 ms` are treated as coincident:
   if the two latest coincide, return the latest result (a plain
   fixed-point step — the latest value "is presumed most accurate", and a
   y-gap across a sub-ms x-gap means two different functions, not a slope);
   if the oldest of the three coincides with either, skip the parabola and
   fall to the linear fit as before. A safety net now that the era mixing
   is gone; nothing in the suite or the sweep reaches it.

Nothing was simplified away (development-rules §2): the Low→Full staging,
the 7/20 budgets, the accelerator and the exhaustion branch are as before.

## 4. Tests

New [es-riseset-moon-transit.test.ts](../src/astronomy/__tests__/es-riseset-moon-transit.test.ts)
(31 tests): at five site/date pairs (the reported case, Miami ×2, Vienna,
Haleakala), for high and low transit, starts spread over ±1 h (13 offsets
including ±1 ms) agree to 0.2 s — sorted results are clustered at gaps
over an hour, since a start an hour away may legitimately pick the
neighbouring lunar day's event, and each cluster must be < 0.2 s wide —
and the Moon's azimuth at the solved instant is 0°/180° to 5″ with the
altitude sign telling high from low. Moonrise/moonset get the same ±1 h
agreement to 0.1 s. Plus the reported ±1 ms case to 0.01 s.

The azimuth check is deliberately not applied at zenith/nadir transits: a
sweep (below) found Miami cases at declination ±25.77° where a 3 ms transit
error is 2.4° of azimuth (altitude −90.000°). Hour angle is the robust
measure there.

**Sweep** (scratch, not kept): 2024–2025 every 5 days × lat −75/−45/−5/
25.77/48.2/70 × lon −122/36.8 × high/low = 3 528 transit solves, each from
5 starts (0, +1 ms, +1 s, ±30 min): worst within-cluster spread 3.6 ms;
hour-angle residual ≤ 0.06″ (4 ms) at every flagged case; moonrise/moonset
worst spread 0.2 ms.

Gates in the worktree: `npx tsc --noEmit` clean (with the generated faces
dir present); `npx vitest run` excluding the goldens: 58 files, 869 tests
green; goldens recaptured and audited (§5).

## 5. Golden audit

CAPTURE=1 in the worktree (a private copy of the goldens; main's were not
touched), then the field-bucketed numeric diff against **main's current
goldens** (captured by the continuous-UTC commit 2, i.e. this fix's exact
"before"): 45 files, 3.89 M numeric leaves, 12 119 changed, 94 buckets.

- **Only Moon rise/set/transit hands move**: Geneva/Selene `nxt mrs
  hr/mn`, `mset hr/min`; Hana `nxt rs hr/mn`, `set hr/min`, `mr am/pm`;
  Venezia `rise/transit/set hr/min`; Basel `moonrise b`/`moonset b`; Miami
  `moon label b` (the 24-hour transit indicator). No Sun, planet, calendar
  or clock hand changes.
- **The reported scenario is in the goldens**: Miami at the "equator"
  location (lat −5°, lon 36.8°) stepped/scrubbed a year forward from
  2025-01-01 00:00 UTC displays 2026-01-01 00:00 UTC, and its `moon label
  b` moves by 1.962e-3 rad = **26.98 s** in all six of those checkpoints:
  the golden held the degenerate root (18:53:13.70), the hand now shows
  the transit (18:52:46.80).
- Every other 24-hour-dial move is ≤ 1 s (6 900 of them) or 1–5 s (21,
  the Low→Full offset where the old loop had returned a Low-era value).
  The hour/minute event hands move by at most 1.745e-3 rad = exactly 1 s
  on a minute hand (quantised event seconds crossing a boundary).
- `nextUpdateDisplayTime` deltas ≤ 6.3 **ms** (scheduling follows the
  event time); `angleAnimating` flips are mostly true→false — the
  millisecond jitter that kept the Moon hands "animating" between ticks
  is gone.

A first audit at 45a39bf (baseline captured unfixed there, so without
commit 2's DUT1 shift) showed the same part set with the largest move
3.9 s: which bogus root the exhausted loop returns depends on the low
bits of the inputs, so commit 2 moved that scenario from a 1 s error to a
27 s one. That is the jitter the parent audit saw.

## 6. Landing

From the main checkout (worktree workflow):

    git cherry-pick --no-commit claude/affectionate-ramanujan-24d48a

Files: `src/astronomy/es-riseset.ts`, the new test, this doc. Then
`npm run test:capture` once (main's goldens predate this fix; the
expected movement is §5).

## 7. iOS back-port

Same three edits in `ESAstronomy.cpp`: `fitTries = 0; continue;` (and the
two-shot clamp) in `planettransitTimeRefined`'s convergence switch,
`fitTries = 0` in `planetaryRiseSetTimeRefined`'s, and the 1 ms
coincidence tolerance in `extrapolateToYEqualX`. Follows the usual
plan-on-GitHub + PR route with the new maintainers; not started.

## 8. Proposed commit message

    Moon transit/rise-set solvers: discard low-precision fit points at the precision switch

    planettransitTimeRefined solved the Moon at low precision, then switched to
    full precision keeping the low-precision fit points; the quadratic through
    two abscissae a sub-microsecond apart returned a bogus root, the 7 iterations
    ran out, and the unevaluated extrapolation came back 1–7 s off and moving by
    tens of seconds with the start date (25.7 s for a 1 ms change at 2026-01-01,
    lat −5°, lon 36.8°) — the jitter on Miami's 24-hour Moon transit indicator.
    The switch now discards the low-precision points (as the exhaustion branch
    already did), gives full precision two shots, and re-solves from the converged
    low-precision date; extrapolateToYEqualX treats abscissae within 1 ms as
    coincident; planetaryRiseSetTimeRefined gets the same reset (it recovered by
    bisection but spent 3–4 extra iterations). New test: starts over ±1 h agree
    to 0.2 s and the Moon is on the meridian to 5″. Goldens: Moon rise/set/transit
    hands only; the reported scenario's 24-hour indicator moves 27 s, everything
    else ≤ 5 s. See planning/2026-10-29-moon-transit-degenerate-fit.md.
