# Plan: two time-controller bugs — the second hands' 20-second scrub cadence, and the BCE toggle on Chronometer

**Status**: IMPLEMENTED 2026-09-24 (build 2.0.163; record in §5, round 2
in §6) — uncommitted, all suites green (goldens recaptured). Nothing
pending but Steve's native pass.
**Created**: 2026-09-24
**Baseline**: 324f514 (`Tweaks to time controller visibility`, build 2.0.160)
**Related**: [2026-09-24-time-controller-two-stories.md](2026-09-24-time-controller-two-stories.md)
(the seconds unit is new since the redesign — the first bug was always
there, unreachable), [docs/observatory.md](../docs/observatory.md#value-system)
(the value table and the two-phase sweep), [docs/animation.md](../docs/animation.md)
(the update dispatch), [docs/timezone-and-dst.md](../docs/timezone-and-dst.md)
(the per-instant zone-offset lookup).

## 1. Scrub and tap by seconds "jump by 20 s"

### 1.1 What is and is not broken

The **time model is right**. In the pane (build 2.0.160, Observatory) the
time bar steps by exactly one second per ▶ tap (15:55:14 → :15 → :16), and a
hold scrubs at 10 s per second (the `10×` rate is `TICK_INTERVAL_MS` = 100 ms
ticks of one second). `TimeController.step('second')` is a plain +1000 ms and
`setRate` for seconds only zeroes the milliseconds.

What jumps is the **second hands** — the Observatory's four
(`second`, `utcSecond`, `solarSecond`, `sidSecond` in
[obs-values.ts](../src/observatory/obs-values.ts)), which are declared

```
{ name: 'second', expr: 'secondValueAngle()', updateInterval: 20, naturalSpeed: SECOND_NATURAL_SPEED }
```

— a 20-second re-evaluation interval with a natural-speed sweep (2π / 60
rad/s) in between. That is the "low-power natural animation": at 1× the hand
is re-synced to the expression only every 20 s and sweeps at its known rate
in between, which is why the pane cannot see the bug (the hands are canvas
pixels and the pane is hidden) but a simulation can.

### 1.2 Mechanism, confirmed by simulation

A script driving the real `Updater` with an Observatory-style second hand
(interval 20, natural speed 2π/60) and a control minute hand (interval 1),
through the loop's real per-frame sequence (`checkTick` → `beginFrame` →
`updater.tick(…, timingContextForFrame(tc))`), at 60 fps:

| Scenario | Second hand |
|---|---|
| 1× for 3 s | tracks display time (natural sweep) |
| tap from running: `stop()` + `step('second')` + `reset()` | settles from 10.29 s to 11.30 s over ~80 ms — **one second, correct** |
| tap while stopped | 11.30 → 12.30 over ~70 ms — correct |
| **scrub at 10×** (1 s per 100 ms tick), 4 s | display 13 → 15 → 17 → 19 s while the hand **sits at 13**; at display 21 it sweeps to 21 in one tick; sits at 21 through display 23 … 37; at 39 sweeps to 41; sits … — **a 20-second jump every two real seconds** |
| control: scrub minutes at 10 min/s | minute hand tracks every tick |

The cause is in `updateObsValueScrub`
([updater.ts](../src/shared/updater.ts), the legacy scrub-compression branch
that non-eval-ahead Observatory values take): it schedules the next
re-evaluation at the value's own **display-time boundary**,
`computeNextBoundary(updateInterval)`, and converts it to real time as
`ticksUntilUpdate = ceil(Δdisplay / displayDeltaPerTick)`. At every other
rate one tick crosses at least one 20 s boundary, so the cadence collapses
to "every tick" and nothing shows. At the seconds rate one tick is one
second, so the hand is re-evaluated every **twenty** ticks and then
animated to the new target (compressed into the tick budget), which reads as
a 20 s jump. Reverse scrubbing is the same with the previous boundary.

The **tap** is not broken (confirmed by Steve, §4): both tap cases above move
one second, through `settleAtNow` (direction 0). The release after a seconds
scrub — the hand up to 19 s behind, settled forward in one motion by
`endHold` → `stop()` → `reset()` — is part of the same symptom and goes away
with the cadence fix.

### 1.3 Fix

**Under scrub, every value re-evaluates every tick** (decided, §4). In
`updateObsValueScrub` the boundary scheduling goes: `v.nextUpdateTime =
perfNow + tickIntervalMs` and `v.nextUpdateDisplayTime = now +
displayDeltaSec · dir` — exactly what the other two scrub branches already
do (`updateObsValueDiscrete`: "re-evaluate every tick so the snapped value
tracks the scrubbed display time"; `updateObsValueEvalAhead`: "the next
update is the next tick"). The legacy branch was the odd one out. The
animation budget becomes one tick, as it already is at day rates.

Why not a narrower rule (only natural-speed values per tick, the rest on
their boundaries)? Steve's call: scrubbing by days or hours already
re-evaluates everything every tick, so the per-tick cost at the seconds and
minutes rates is a cost the loop already pays at the rates that matter; the
seconds unit exists for precise setting (eclipses), not for scrubbing, and a
special case in the scrub path is complexity without a payoff. At 1× the
economy stays untouched — there the 20 s re-sync with the natural sweep in
between is what keeps the solar and sidereal second hands cheap, and this
change does not go near it.

`nextUpdateDisplayTime` has no readers outside updater.ts (checked), so
dropping the scrub-time boundary computation changes nothing else. The
existing budget logic then does the right thing for free: the 6° per-tick
delta takes 52 ms at `animSpeed` (2 rad/s), under the 100 ms tick, so the
"too fast — stretch to fill one tick" branch gives a smooth 100 ms sweep per
tick, i.e. continuous motion at 10 s/s; a value whose target did not change
between ticks (a sunrise wedge mid-day) is a no-op in `startAnimationRaw`.
The release catch-up becomes at most one second.

Alternative, deferred: move the four second hands to `evalAhead: true`. The
eval-ahead branch is mode-aware (per tick under scrub, chord-sweep between
boundaries at 1×; docs/animation.md says the natural speed "falls out").
It would retire the two-phase natural-speed code path for the Observatory —
the direction the code comments point to — but it changes the 1× look of
the second hands and is a bigger review than this bug warrants. Not now.

### 1.4 Why "evaluate at the tick, arrive by the next" is right under scrub

Steve's reading (§4), confirmed: at 1× a hand must be in the right place at
the top of the second — there is an external truth to match, which is what
eval-ahead's "evaluate at the *next* point, arrive exactly as display gets
there" buys. Under scrub there is no such truth: display time is whatever
the last tick said, so if every part is evaluated at the same instant (the
current tick's display time) and animates there over the tick, the face is
self-consistent — everything shows the value computed a tenth of a second
ago, together. The only external reference is the time bar's text, which
leads the hands by that tenth of a second; invisible.

The one thing consistency needs is that all parts use the *same* scheme, and
they do: **no Observatory or Inspector value opts into eval-ahead**
(`evalAhead: true` appears nowhere outside the tests; Chronometer keeps it
off, per docs/animation.md). Under scrub every value goes through either the
discrete branch (snap at now, every tick) or the legacy scrub branch
(animate to A(now)) — and §1.3 makes the latter every-tick too. The
eval-ahead scrub branch in updater.ts stays as it is, unused by any app.

### 1.5 Tests and docs

- New `src/shared/__tests__/scrub-cadence.test.ts`, modelled on
  `onbeat-resume.test.ts` (a functions-map env, mocked `Date.now` /
  `performance.now`): a natural-speed value with interval 20 tracks A(now)
  within one tick on every tick of a 1 s/tick scrub, forward and reverse; a
  snap-to-target value with interval 3600 does too under scrub, and at 1×
  still waits for its boundary (the economy that stays); the minute hand
  control. This is the §1.2 simulation made permanent.
- docs/observatory.md: the "Two-phase sweep" paragraph and the values table
  gain the scrub-cadence sentence; docs/animation.md's dispatch list (branch
  4) says "every tick under scrub, like the other branches".
- Native pass (Steve): a seconds scrub on the Observatory reads as a smooth
  10 s/s sweep; release lands within a second; taps move one second.

## 2. The BCE toggle on Chronometer

### 2.1 Reproduction (pane, build 2.0.160)

On terra.html at "Sep 24, 2026 16:01" (1×), clicking the CE/BCE toggle:

- the controller's instant is **correct**: the URL state carries
  `t = −126048445140000` = 2026 BCE Sep 24 (Julian), the same instant the
  Observatory produces for the same click;
- but the bar shows `Sep 7, 2026 (Julian)  15:08:02`, the inputs read
  `2026 9 7 15 8`, and the toggle reads **CE**, inactive;
- a second click composes from those wrong inputs and lands on the
  4000 BCE limit (`Nov 29, 4001 (Julian) — AT LIMIT`);
- the console logs `[rebuildEnvironments] DST transition detected (offset
  -25200 -> 127837238822)` and then `-> 252487123622` — a timezone offset
  of about **4051 years**.

A plain load of terra.html at that instant (`?t=-126048445140000&dir=0`)
renders it correctly (`Sep 24, 2026 BCE (Julian)`), as does the Observatory
after the same click. So the shared formatter and the calendar code are
fine (a direct probe of `timeIntervalFromLocalComponents` /
`localComponentsFromTimeInterval` round-trips era 0 correctly, and both
bundles contain exactly one copy of each); what differs is the **timezone
offset** Chronometer hands the formatter.

### 2.2 Mechanism, confirmed by probe

`rawTzOffsetSecondsAt(tz, utcMs)` in [astro-env.ts](../src/shared/astro-env.ts)
computes a zone's offset at an instant by formatting the instant with
`Intl.DateTimeFormat(…, { timeZone })`, reading the numeric parts back, and
differencing `Date.UTC(p.year, p.month − 1, p.day, …)` against the input.
Two things go wrong before 100 CE:

1. **BCE years.** Intl reports the *era-relative* year — `year=2026` for
   2026 BC — and the era only as a separate part when the formatter asks for
   it (it does not). `Date.UTC(2026, …)` is 2026 **CE**, 4051 years later,
   so the "offset" is that difference: probe
   `tzOffsetSecondsAt('America/Los_Angeles', −126048445140000)` →
   **127,837,238,822 s**. The per-zone memo window (`_tzOffsetWindow`) then
   serves the poisoned value for ±10 days of queries, and its probes at
   `utcMs ± radius` compound it (the second jump in the log).
2. **Years 0–99.** `Date.UTC` maps a year argument of 0–99 to 1900–1999, so
   1–99 CE (and 1 BCE = year 0) get 19th-century offsets: probe for year 0
   → −28800 (the 1900 PST rule), where the zone's LMT rule is −28378.

Chronometer is the app that shows it because it computes its bar/input
delta **at the display time**: `tzDeltaMs = computeTzDeltaMs(locationTimezone,
rawGetNow())` in `rebuildEnvironmentsFrozen` ([engine-entry.ts:1033](../src/engine-entry.ts))
and in the DST-rebuild path (line 2006) — the right semantics (DST at the
displayed instant), on a lookup that cannot read the instant. The
Observatory and the Inspector pass no date (real now), so their `tzDeltaMs`
never sees a BCE instant and their bars survive. With `tzDeltaMs` ≈ 4051
years, the shared `targetTzOffsetSec()` feeds `updateTimeUI`, which
decomposes the (correct) instant with that offset: it lands on the
**Gregorian** side of the switchover, at CE 2026 Sep 7 (the proleptic
Gregorian date of a 2026 BCE Julian instant) plus the LMT hours — while the
"(Julian)" tag is decided from the raw instant, hence the impossible-looking
`Sep 7, 2026 (Julian)`. The toggle reads the era from those components
(CE), the inputs show the shifted date, and the next click composes from
them. On the plain load the first render precedes the first rebuild, which
is why it looks right until the display time is rebuilt from.

**Wider blast radius than the toggle.** The same lookup is the
`env.tzOffsetSec` every app bakes into its astronomy environment
(`envTzOffsetSec`) and the per-instant lookup the wedges, rings and
rise/set code call. At any BCE date, and at 1–99 CE, the local-time
astronomy in all three apps — day boundaries, `computeNextBoundary`'s
local-midnight alignment, rise/set-in-local-time readouts — carries the same
bogus offset. Chronometer's toggle is the visible symptom of a shared bug.

### 2.3 Fix

In `rawTzOffsetSecondsAt` / `tzFormatter`:

- add `era: 'short'` to the formatter options and keep it on the `en-US`
  locale it already uses (era strings are locale-specific: `BC` / `AD`);
- read the era part; for `BC` (Intl may also spell `BCE`) use
  `year = 1 − p.year` (astronomical numbering: 1 BC = 0, 2 BC = −1);
- build the comparison instant with `setUTCFullYear` instead of `Date.UTC`
  — `const d = new Date(0); d.setUTCFullYear(y, p.month − 1, p.day);
  d.setUTCHours(p.hour % 24, p.minute, p.second, 0)` — so 0–99 are real
  years;
- keep the truncate-to-seconds comparison (the fraction fix in the current
  code) and the memo window as they are; the window's probes are correct
  once the raw lookup is.

Nothing changes in Chronometer: computing `tzDeltaMs` at the display time is
what a DST-correct bar needs, and it becomes right once the lookup is. The
Observatory's and Inspector's "delta at real now" stays as it is — a
separate, pre-existing inconsistency (their bar's offset is the browser
zone's JS offset *at the instant* plus the target−browser delta *at now*),
not part of this bug.

**Included (decided, §4): the wall time shifts on toggle.** On both apps
the typed 15:55 becomes 15:06 after the click: `applyDateInputs` composes
with the offset at the *previous* display time (PDT, −7:00) and the result
displays with the offset at *its own* instant (LMT for a BCE date,
−7:52:58). The same happens for any typed date across a DST edge. Fix: a
**two-pass composition** in the shared `applyDateInputs` — compose with the
offset at the current display time, look the offset up at the result
(`targetTzOffsetSec(d)`), and if it differs recompose with that one (the
same two-pass idea `timeIntervalFromLocalComponents` documents). The typed
wall time then wins across any offset change, era or DST. The offset
lookup is the shared `targetTzOffsetSec` (the browser zone's JS offset at
the instant plus the app's target−browser delta), so the fix is exact
wherever that is — the browser's own zone, and any zone once §2.3's lookup
is right on Chronometer's display-time delta.

### 2.4 Intl and the hybrid calendar: why the lookup is calendar-free

Steve's concern (§4): docs/calendar.md is emphatic that JavaScript's `Date`
and, by extension, `Intl` are **proleptic Gregorian**, while the app's
calendar is hybrid — Gregorian from 15 Oct 1582, Julian before, proleptic
Julian before 1 BCE — so nothing that produces calendar *components* may
come from `Date` getters or `Intl` (weekday, month length, "Oct 5–14, 1582
do not exist"). That intent stands, and the offset lookup does not violate
it: it never produces components for display. It formats an instant in the
zone, reads the parts back, and rebuilds *the same instant* from them in the
same proleptic-Gregorian system (`setUTCFullYear` is proleptic Gregorian,
as `Date.UTC` was); the difference between that and the UTC instant is the
zone's offset — a property of the instant, independent of which calendar
labels it. The calendar cancels out. The hybrid components are then
produced, as always, by `localComponentsFromTimeInterval` in es-calendar,
which switches to Julian arithmetic below the switchover itself.

The bug was never the calendar; it was the **year** being read wrongly
(era-relative for BC, and 0–99 mapped to 1900–1999). Probe of the §2.3
prototype in America/Los_Angeles (Intl parts → current lookup → fixed
lookup → hybrid local components with the fixed offset):

| Instant | Intl reports | current | fixed | hybrid local |
|---|---|---|---|---|
| 2026 CE Sep 24 22:00Z | 09/24/2026 AD 15:00 | −25200 | −25200 | 2026-9-24 15:00 |
| 2026 CE Jan 15 20:00Z | 01/15/2026 AD 12:00 | −28800 | −28800 | 2026-1-15 12:00 |
| 1582 Oct 14 (Gregorian) 12:00Z | 10/14/1582 AD 04:07:02 | −28378 | −28378 | **1582-10-4** (Julian) 4:07 |
| 1000 CE Jun 1 12:00Z | 06/01/1000 AD | −28378 | −28378 | 1000-5-26 (Julian) |
| 50 CE Jun 1 12:00Z | 06/01/50 AD | **59,958,115,622** | −28378 | 50-6-3 |
| 1 BCE (year 0) Jun 1 12:00Z | 06/01/1 **BC** | **59,989,651,622** | −28378 | BCE 1-6-3 |
| 2026 BCE (the Terra instant) | 09/07/2026 **BC** 15:08:02 | **127,837,238,822** | −28378 | BCE 2026-9-24 15:08 |
| 4000 BCE Jan 1 00:00Z (the limit) | 11/29/4001 BC | **252,487,123,622** | −28378 | BCE 4001-12-31 16:07 |

Three things the table shows. Intl stays proleptic Gregorian all the way
down (14 Oct 1582 is "10/14", 1 BCE is "1 BC") and reports the era only
because the prototype asks for it. The current lookup is already wrong at
50 CE and 1 BCE, not just for deep BCE dates — the 0–99 mapping. And the
fixed offset before 1883 is the zone's **LMT** (−7:52:58 for Los Angeles),
the single earliest rule Intl extrapolates outside the tz-data range — the
same convention the code's own comment on the probe radii relies on, and
what the browser's `Date.getTimezoneOffset()` returns for those instants
(472 min), so the bar's `targetTzOffsetSec` and the env's offset agree.
With that offset, es-calendar's hybrid decomposition yields the expected
Julian components (Oct 4 1582; May 26 for a proleptic-Gregorian Jun 1 in
the year 1000; the 4000 BCE limit at 16:07 the previous local day).

One doc correction to fold in: docs/timezone-and-dst.md still describes the
delta as coming from `Intl.DateTimeFormat` with `longOffset` (its step 2);
the code has used numeric `formatToParts` → instant differencing for some
time. The §2.3 change is the place to bring that paragraph up to date.

### 2.5 Tests and docs

- `src/__tests__/tz-offset-fraction.test.ts` (the lookup's existing test)
  gains: 2026 BCE in America/Los_Angeles → the LMT rule (−28378), not
  ~1.28e11; year 0 and 50 CE → LMT, not 1900's rule; `computeTzDeltaMs(tz,
  bceDate)` small; a modern DST pair unchanged; and the memo window across
  a BCE query.
- A time-controls test: toggling BCE on a 2026 CE date keeps year/month/day
  and the era reads BCE; toggling back restores CE (and, if §2.3's
  two-pass lands, the wall time is unchanged both ways).
- docs/timezone-and-dst.md: the era and 0–99 handling in the lookup;
  docs/time-controller.md: a line on the toggle if the two-pass lands.
- Pane: Terra toggle → `Sep 24, 2026 BCE (Julian)`, inputs `2026 9 24`,
  no `DST transition detected` spam, second click back to CE Sep 24 2026;
  the Observatory the same; and a rise/set readout at a BCE date in the
  Inspector before/after (it should change — it was wrong).

## 3. Steps

1. §2.3 lookup fix + §2.4 tests (BCE first, per Steve).
2. §2.3 two-pass composition.
3. Pane checks for §2.
4. §1.3 cadence fix + the scrub-cadence test.
5. Docs; `tsc`, vitest, `bash build.sh`.
6. Native pass: the seconds scrub feel on the Observatory; the BCE toggle
   on a face page; a Chronometer face at a BCE date.

## 4. Decisions (Steve, 2026-09-24)

1. **The jump was on scrub only, not on a tap** — the §1.2 reading stands.
2. **Include the two-pass wall-time fix** (§2.3).
3. **Cadence: whatever is simpler** — every value re-evaluates every tick
   under scrub. Scrubbing by days or hours already updates every part on
   every tick; the incremental gain of a per-value economy at the seconds
   rate (a unit that exists for precise setting, not scrubbing) does not
   justify complexity in the scrub path. **1× is different**: there the
   parts update seldom, and keeping the solar and sidereal second hands on
   their 20 s re-sync with the natural sweep in between is a real concern —
   untouched by this change.
4. **Clarifications (same day)**: eval-ahead has no role under scrub —
   evaluating every part at the tick and arriving by the next is
   self-consistent (§1.4, confirmed: no app value uses eval-ahead). And
   `Intl` in the offset lookup does not conflict with the hybrid calendar:
   it is used only to difference two representations of one instant, and
   es-calendar still owns every calendar component (§2.4, with the probe
   table).

## 5. Implementation record (2026-09-24, build 2.0.162)

### 5.1 What landed

- **The zone-offset lookup** (`rawTzOffsetSecondsAt`, astro-env.ts): the
  formatter requests `era`; BC years map to astronomical numbering; the
  comparison instant is built with `setUTCFullYear` (no 0–99 → 1900s). Six
  historical instants in `tz-offset-fraction.test.ts` (1000 CE, 14 Oct 1582,
  50 CE, 1 BCE, 2026 BCE, the 4000 BCE limit) now read Los Angeles' LMT;
  modern DST unchanged; `computeTzDeltaMs` at a BCE display time stays under
  a day. Five of those failed on the pre-fix code.
- **Two-pass composition** in `applyDateInputs`: compose with the current
  offset, look the offset up at the result, recompose if it moved.
- **The controller's offset is the zone's own, per instant.** Pane testing
  of the two-pass on 2.0.161 left two residues: on Terra the toggled time
  was 58 s off (the second pass used the browser's minute-rounded LMT,
  −7:52:00, while Chronometer then displayed with Intl's exact −7:52:58 once
  its delta was recomputed at the new display time), and on both pages the
  minute input drifted by one per round trip (16:55:00 decomposed as
  16:54:59.99999). So `targetTzOffsetSec(d)` now returns
  `tzOffsetSecondsAt(tz, d)` whenever a zone is known — exact per instant,
  the same offset the astronomy env uses, so composition and display agree
  to the second whatever instant an app last computed its `tzDeltaMs` at —
  and falls back to the browser offset plus the app delta without a zone.
  This also makes the bar's offset right across DST edges in a target zone
  that is not the browser's, a pre-existing wart the plan had noted.
- **A display nudge**: the bar and the inputs decompose the instant at
  +0.5 ms (`DISPLAY_NUDGE_S`). Far from the epoch the calendar's day-fraction
  arithmetic carries a few 10⁻⁵ s of float noise, so an exact minute can
  floor to the previous one; the nudge is invisible at one-second
  granularity. The calendar core itself is untouched (§5.4).
- **Per-tick scrub cadence** in `updateObsValueScrub`: `nextUpdateTime =
  perfNow + tickIntervalMs`, `nextUpdateDisplayTime = now + delta·dir`, and
  one `startAnimationRaw` over exactly one tick — the compress / stretch /
  natural three-way collapsed to that. `scrub-cadence.test.ts` (3 tests, the
  §1.2 simulation made permanent) fails on the pre-fix updater with the
  hand 17–18 s behind, and passes now within 1.5 s.
- **Tests**: the toggle test in `time-controls-units.test.ts` names
  `America/Los_Angeles` explicitly (deterministic on any machine) and walks
  four wall times (15:55, 15:02, 00:00, 23:59) through BCE and back,
  checking the inputs, the bar's clock, and the restored instant.
- **Docs**: timezone-and-dst.md (the lookup, calendar-free, the two traps,
  LMT, the stale `longOffset` sentence replaced); observatory.md (mode 3 is
  the per-tick scrub; the two-phase sweep is a 1× mechanism); animation.md
  (the dispatch list); time-controller.md (two-pass composition);
  calendar.md (the offset lookup is calendar-free).

### 5.2 Pane verification (dist server on a fresh port, build 2.0.162)

| Page | Result |
|------|--------|
| terra.html | type 15:55 → `Sep 24, 2026  15:55:00`; BCE → `Sep 24, 2026 BCE (Julian)  15:55:00`, inputs `2026 9 24 15 55`, button BCE active, `t` = −002025-09-07T23:47:58Z (LMT), zone label `GMT-7:52:58`; CE → `Sep 24, 2026  15:55:00`, `t` = 2026-09-24T22:55:00Z exactly; a second BCE / CE round trip identical. The `[rebuildEnvironments] DST transition` log now reads `-25200 -> -28378` and back — the zone's real PDT ↔ LMT swap |
| observatory.html | the same round trip: `15:55:00` ↔ `15:55:00 BCE (Julian)`, inputs stable across two round trips |

The seconds scrub cannot be seen in the pane (the hands are canvas pixels
and the pane is hidden); the simulation-turned-test is its proof, and
Steve's native pass is the feel check.

### 5.3 The full suite

`tsc` clean; 8162 tests pass; **714 fail, all in the three Chronometer face
regression goldens** (`gaia`, `vienna`, `mauna-kea`), all in scrub scenarios
(every unit, both directions). Field-bucketed audit of the 6398 failed
assertions (the recipe from the golden re-baseline memory):

- 6370 are `nextUpdateDisplayTime`, the updater's scheduling field the
  bench snapshots per part per tick. The goldens record the value's own
  display-time boundary; the field now records the next tick, so every diff
  is either one scrub unit (1000 ms at seconds, 60000 at minutes, an hour,
  a day, a month, a year) or the distance to the old hourly / daily
  boundary (3597000–3599000, 82800000).
- 28 are `angleAnimating: expected true to be false` on Mauna Kea's
  `daytime` part at tick 3 of the seconds and minutes scrubs — the part now
  sweeps every tick instead of waiting for its boundary; its angle itself
  is within tolerance (no angle assertion failed).
- **No drawn value differs**: not one angle, position or rotation
  assertion failed across the three files.

So the goldens pin the scheduling detail this change deliberately altered,
and nothing else. They need re-capturing (`CAPTURE=1`), which is Steve's
call (development-rules §12) — §5.4.

### 5.4 Pending decisions

1. **Re-baseline the three face goldens?** The audit above is the case; the
   tests stay red until then.
2. **Fix the calendar's float noise at the source?** The +0.5 ms nudge is
   applied by the controller UI only; the Inspector's readouts and any other
   consumer of `localComponentsFromTimeInterval` still see 59.99999 s about
   half the time at BCE dates. The `.estime-ref` `ESCalendar.cpp` has the
   same `hoursF = xRemainder * 24 … floor` structure, so quantizing the day
   fraction to the millisecond in `utcComponentsFromTimeInterval` would be a
   deliberate deviation from the port — rule 2 says ask, so: asking.

## 6. Round 2 (Steve, 2026-09-24; build 2.0.163)

Decisions: regenerate the goldens; quantize in `utcComponentsFromTimeInterval`;
and a third pre-existing bug — typing 1582-9-1 into the controller made the
main display read 1582-9-11.

- **Goldens recaptured** (`CAPTURE=1`, the three face regression files;
  8190 tests in the regression suite), after every other change below so
  they were captured once. The full suite is green: 60 files, 8891 tests.
- **The calendar decomposition is millisecond-exact at the source**
  (es-calendar.ts, `splitDay`): the time of day is the exact remainder of
  the interval within its day, quantized to the millisecond, the day index
  corrected when the quotient's noise lands an exact midnight on the wrong
  day; the interval is quantized up front so the calendar branch, the day
  and the time of day agree (a hair below the switchover rounds onto it and
  takes the Gregorian branch). `weekdayFromTimeInterval` uses the same day
  index. A deliberate deviation from `ESCalendar.cpp`, documented in
  calendar.md. The controller's +0.5 ms display nudge from §5.1 is gone —
  the calendar does its job now. `es-calendar-precision.test.ts` (11
  tests): whole-minute round trips across both eras with `seconds` exactly
  0, the LMT instant that read 15:01:59.99999, fractional seconds kept to
  the millisecond, a hair before a midnight rounding onto it, and the
  switchover edge (a hair before → 15 Oct 1582 00:00:00; a millisecond
  before → 4 Oct 1582 23:59:59.999). Eight fail on the pre-fix calendar.
- **1582-9-1 → 9-11.** Not the controller: its bar read `Sep 1, 1582
  (Julian)` all along. The Observatory's date view (`extractDateFields`,
  date-view.ts) formatted weekday, month, day and year through
  `Intl.DateTimeFormat`, which is proleptic Gregorian — a Julian 1 Sep 1582
  is 11 Sep in that calendar — and dropped BCE eras; its leap test was
  Gregorian-only. The Inspector's date line (`formatDate`,
  `toLocaleDateString`) had the same defect. Both now take their fields
  from a new shared `hybridDateFields` (src/shared/hybrid-date.ts): the
  hybrid calendar's components in the zone at the instant (offset from
  `tzOffsetSecondsAt`), the weekday by epoch arithmetic, month and weekday
  names from tables, a year label with the era, and a leap flag under the
  calendar in force (Julian rules before 1582). Intl remains only for the
  zone abbreviation. Pinned in the precision test: 4 Oct 1582 a Thursday,
  15 Oct a Friday; the Julian 1 Sep 1582 instant whose `getUTCDate()` is 11
  reads as Sep 1; `2026 BCE`; 1500 leap (Julian), 1900 not, 2024 leap.
  Remaining Intl calendar consumers, out of scope: the eclipse table's date
  strings (modern range) and the Terra slot-time probe in watch-env.ts.

Pane, build 2.0.163 (fresh port, `[mem] build 2.0.163`):

| Page | Result |
|------|--------|
| observatory.html | typed 1582-9-1 12:00 → bar `Sep 1, 1582 (Julian)  12:00:00`; a `fillText` spy over 3.5 s of frames caught the date view drawing `Saturday`, `Sep 1`, `1582` (Julian 1 Sep 1582 was a Saturday) and nothing with `11`; BCE round trip at 15:55 still exact |
| inspector.html | `#date-display`: `Saturday, September 1, 1582` at the typed date; `Thursday, September 24, 2026` back at today; `Sunday, September 24, 2026 BCE` after the toggle |

Native pass (Steve): the seconds scrub feel on the Observatory; the BCE
toggle on a face page; the Observatory's date block at a Julian date and a
BCE date (the year label grows by " BCE", which the layout measures from the
same fields it draws).
