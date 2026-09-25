# Plan: Observatory drag magnifier — gate it on pointer motion

**Status**: IMPLEMENTED 2026-09-24 — review round 1 applied the same day
(build 2.1.5): Steve chose one rule, far stricter than any of the four
candidates, and the candidates and their `?mag=` switch are gone (§7);
round 2 (build 2.1.6) made the hide anchor a one-second trail so a slow
crawl keeps the bubble (§8); round 3 (build 2.1.7) halved the dwell to
1 s (§9); round 4 (build 2.1.8) exempted touch drags — the finger covers
the point, so there the bubble is always up (§10). The knobs are his to
tune. — Part 6 of
[2026-09-14-user-options-panel.md](2026-09-14-user-options-panel.md) (§3.6,
decision §7 item 7, §6 row 6). The last unbuilt part of that project.
**Created**: 2026-09-24
**Baseline**: 48692c6 (`[Observatory] Briefly highlight the half-circle
target area for alt/az presses`, build 2.1.3)
**Related**: the magnifier itself —
[2026-07-25-map-pointing-phase-1-magnifier.md](2026-07-25-map-pointing-phase-1-magnifier.md)
and [2026-08-08-magnifier-touch-sizing.md](2026-08-08-magnifier-touch-sizing.md);
living description [docs/observatory.md § Drag-to-Explore](../docs/observatory.md#drag-to-explore-earth-map).

## 1. The problem and the decision

Drag-to-explore on the Observatory's earth map shows a magnifier bubble: a
10° window around the drag point with city dots and labels, so that a
1-pixel move (San José → San Francisco on a laptop) can be seen. The bubble
is the point of the feature when the pointer is nearly still — and a
distraction when it is not. Sweeping across continents to watch the dials
swing, the bubble sits in the band, hides a third of it on a phone, and
shows a smear of nothing useful at that speed.

A per-user setting was rejected in the parent plan (§3.6): the two wants
are not two users, they are one user at two speeds. **Speed is intent.** A
fast sweep means "what happens when I move far"; slowing down or stopping
means "where exactly am I". So the bubble gates itself on how the pointer
moves, and nobody has to find a switch.

Steve's note on the parent decision (2026-09-16): speed gating is fine as
a start, but he is not convinced it is the right knob. So this part builds
the estimator once and puts **three heuristics and an off switch** behind
it, all selectable with a URL parameter, for one on-device comparison. The
one that wins stays; the others are deleted afterwards. Speed gating is the
default until then.

## 2. Design

### 2.1 `src/observatory/magnifier-gate.ts` — pure state machine, unit-tested

No canvas, no DOM. `drawDragMagnifier` steps it once per frame with the drag
point in CSS px, the frame time and the band width, and gets back an
opacity in 0..1 which multiplies the whole bubble.

**Speed estimate.** An exponential average of the per-frame speed,
`v += (|Δp| / Δt − v) · (1 − e^(−Δt / MAG_V_TAU))`, MAG_V_TAU = 50 ms. It is
the time-weighted mean over the last ~50 ms whatever the frame or
pointer-event rate — a 240 Hz loop fed by 60 Hz events sees three still
frames per moving one and the mean is still right. Frames run only while
something animates, so a step can arrive after a long gap (the loop parked
with the pointer still); the estimate then reads the gap's average speed,
near zero, which is what a pointer that has not moved deserves.

**Rules.** All on the one estimate, plus a displacement from an anchor
for the two dwell-based modes:

| Mode | Show when | Hide when | Anchor |
|------|-----------|-----------|--------|
| `speed` (default) | v < MAG_V_LO (100 px/s) — includes rest | v > MAG_V_HI (300 px/s) | — |
| `dwell` | v < MAG_V_LO for MAG_DWELL_MS (200 ms) | displacement from the anchor > MAG_FAR_FRAC (⅓) of the band width, at any speed | where the bubble appeared |
| `combo` | v < MAG_V_LO for MAG_DWELL_MS | v > MAG_V_HI, **or** displacement from the anchor > ⅓ of the band | the last point where the pointer was slow |
| `off` | always | never | — |

The gap between MAG_V_LO and MAG_V_HI is the hysteresis: a pointer between
the two keeps whatever state it has, so the estimate's ripple at a
threshold cannot flicker the bubble.

`combo`'s moving anchor is what makes it a combination rather than `dwell`
with a speed rule bolted on: slow travel never trips the distance rule
(the anchor follows), fast travel trips the speed rule at once, and what
the distance rule catches is the middle — sustained medium-speed travel
across a third of the band, which is "moving far" even though it is never
fast. `dwell`'s anchor is fixed where the bubble appeared, as the parent
plan describes it, so slow travel of more than a third of the band hides
the bubble and 200 ms later brings it back: a blink every third of the
band. That is a property of the mode as specified, left in so the feel pass
can judge it rather than a bug.

**Fade.** Opacity ramps linearly toward the target over MAG_FADE_MS =
150 ms each way. It is an opacity change, not motion, so it is not gated on
`prefers-reduced-motion` (the same call the tap wash made).

**Reset (press or resume).** `speed` and `off` start shown; `dwell` and
`combo` start hidden and need their dwell. Opacity starts at 0 in every
mode but `off`, so the bubble fades in on the press instead of popping — a
press that turns straight into a sweep produces a faint partial fade rather
than a flash. (This is the one change to a plain press-and-hold on the
desktop: 150 ms to full instead of instant.)

**Frames.** `magGateAnimating()` is true while the opacity is ramping or
while the bubble is hidden — a show is then pending on the estimate
decaying or a dwell counting, and needs frames the pointer is no longer
generating.

### 2.2 `earth-view.ts`

- `drawDragMagnifier` computes the drag point (already needed for
  placement) first, steps the gate, and when the opacity is 0 pins the
  smoothing state to the pointer (content centre, side, position) and
  returns without drawing — so the bubble fades back in *where the pointer
  is*, not lerping over from where it went out. Otherwise the whole bubble
  (blit, overlays, both rings) draws under `ctx.globalAlpha` scaled by the
  opacity, restored after.
- `resetDragMagnifier` resets the gate with the rest of the smoothing state.
- `setDragMagnifierGateMode(mode)` for the entry; `dragMagnifierAnimating()`
  for the loop (false whenever the magnifier is inactive).
- `window._dragMag` gains `alpha`, `v`, `shown` and `mode` beside the
  geometry, for headless checks; it is set on hidden frames too.

Sizing, placement, side-flip, smoothing, labels: untouched.

### 2.3 Entry (`observatory-entry.ts`)

- `?mag=speed|dwell|combo|off` is read once at init (after `initEarthView`)
  through `parseMagGateMode`; anything else leaves the default. A
  diagnostic like `?probe` and `?fps`: not persisted, not carried across
  app links. Goes when the feel pass has chosen.
- `tickBody` folds `dragMagnifierAnimating()` into `animating` **after**
  `drawFrame()` (the gate steps inside the draw), so the parked-loop rule
  keeps frames coming through a fade or a pending show. The loop already
  animates for 300 ms after every map move (`tickFixedDuration`); the hook
  matters when a show needs longer than that — a 200 ms dwell plus a 150 ms
  fade, or a slow decay of the estimate — and costs nothing otherwise.
- The Keep dialog's park is untouched: `endDragMagnifier` runs on
  `pointerup` before the state becomes `confirming`, and
  `dragMagnifierAnimating` is false from then on. The dialog's
  backdrop-filter exposure (see the comment above `continuous`) stays
  exactly as verified.

### 2.4 Not doing

- **No setting** — decided in the parent plan (§3.6, §7 item 7).
- **No pointer-event plumbing.** The parent plan expected the estimate to
  come from the smoothed position earth-view already tracks; stepping on
  frames from the applied drag point is the same information, needs no
  new path through the entry, and the loop's animating hook covers the
  at-rest case.
- **No touch-specific thresholds.** Speed here is hand motion in CSS px/s,
  which means the same thing on a phone and a laptop; the touch gap and
  size rules from the touch-sizing plan already handle what differs.
- **No change to what the bubble shows** or how it is placed.

## 3. Steps

1. `magnifier-gate.ts` + `__tests__/magnifier-gate.test.ts` — the four
   modes, the fade, the animating predicate, the long-gap step, the parser.
2. `earth-view.ts` — step the gate at the top of `drawDragMagnifier`, the
   hidden early-out with the smoothing pin, `globalAlpha`, the reset, the
   two exports, the debug fields.
3. `observatory-entry.ts` — `?mag=` at init; the animating hook in
   `tickBody`.
4. `docs/observatory.md` — a Magnifier subsection under Drag-to-Explore
   (the magnifier had no living description at all).
5. Parent plan: status line, §3.6 pointer, §6 row 6.
6. Build; typecheck; tests; headless verification (§5); dist.zip to Steve.

## 4. Feel pass (Steve, dist.zip on the phone; the desktop counts too)

Load `observatory.html?mag=speed`, `?mag=dwell`, `?mag=combo` and
`?mag=off` in turn and drag the same three ways in each:

- **Sweep** across the whole band at finger speed and watch the dials —
  is the bubble out of the way? (`off` is the baseline this has to beat.)
- **Creep** a few pixels at a time hunting for a city — does the bubble
  stay put, and does it come back fast enough after a sweep?
- **Sweep, then slow into a target** without stopping — the case the modes
  disagree on most: `speed` shows as soon as the finger is slow, `dwell`
  and `combo` want a 200 ms pause first, and `combo` also drops the bubble
  on a long medium-speed approach.

Then the knobs, all at the top of `magnifier-gate.ts`:

| Knob | Value | What it changes |
|------|-------|-----------------|
| `MAG_V_HI` | 300 px/s | how fast is "sweeping" (speed, combo) |
| `MAG_V_LO` | 100 px/s | how slow is "looking" (all modes); the gap to `MAG_V_HI` is the hysteresis |
| `MAG_V_TAU` | 50 ms | how quickly the estimate follows a change of speed |
| `MAG_FADE_MS` | 150 ms | the ramp, each way |
| `MAG_DWELL_MS` | 200 ms | the pause `dwell` and `combo` want before showing |
| `MAG_FAR_FRAC` | ⅓ | how far is "moving far" (dwell, combo), as a fraction of the band width |

Known properties to judge rather than fix: `dwell`'s blink on slow travel
past a third of the band (§2.1); `dwell`/`combo`'s 200 ms delay on a plain
press-and-hold; `speed`'s immediate show when a sweep merely slows.

After the choice: delete the losing modes and the `?mag=` switch, keep the
estimator and the fade, and record the choice here and in the parent plan.

## 5. Verification

Headless, in the browser pane (dist server on a fresh port, build stamp
checked): the drag is driven with synthetic `PointerEvent`s on the canvas
and `window._dragMag` is read between frames. See §6 for what was run.

Unit: `magnifier-gate.test.ts` covers every rule in the table, the fade
timing, the hysteresis band, the long-gap step and the parser.

*§2–§5 describe the four-candidate build (2.1.4) as it was; §7 is what
ships.*

## 6. Implementation record (2026-09-24, build 2.1.4, uncommitted)

**Files.** `src/observatory/magnifier-gate.ts` (new) and
`src/observatory/__tests__/magnifier-gate.test.ts` (15 tests);
`earth-view.ts` (gate step, hidden early-out with the smoothing pin,
`globalAlpha`, reset, two exports, debug fields); `observatory-entry.ts`
(`?mag=` at init, the animating hook after `drawFrame`);
`docs/observatory.md` (new Magnifier subsection); the parent plan (status,
§3.6, §6 row 6); `.claude/launch.json` (a fresh preview port). Typecheck
clean; the full suite passes (8909 tests, 61 files).

**Headless verification** (browser pane; the dist server on :8873 — every
preview slot belonged to other chats, so an existing server was used; the
bundle URL carries `?v=2.1.4`, so no stale cache, and the console stamp
read `build 2.1.4`). Viewport 1280×800; band at x 960–1254, y 72–222, so
the bubble is d ≈ 88 px (r 45) and a third of the band ≈ 98 px. Synthetic
`PointerEvent`s on the canvas, `window._dragMag` read between frames:

- **speed** (San Francisco): press +70 ms α 0.49, +170 ms α 1 — the fade-in.
  Sweep at ~650 px/s: `shown` false, α 0.21 at ~110 ms, then 0. Stop: +50 ms
  v 231 still hidden; +150 ms shown, α 0.45, v 33; +400 ms α 1. A creep at
  ~41 px/s stays shown; ~155 px/s from the shown state stays shown (the
  hysteresis band). Screenshot: the bubble in the band with Kampala and
  Nairobi labelled, placed left of a pointer on the right half. `pointerup`:
  `_dragMag` null, Keep dialog up, cursor restored; Escape: dialog gone,
  San Francisco back.
- **dwell**: hold +150 ms hidden; +300 ms shown, α 0.21; +700 ms α 1. A
  72 px sweep at ~550 px/s stays shown; at 168 px it hides (α 0.22, fading).
  Stop: +100 and +250 ms hidden (v 65 → 3, the dwell counting); +500 ms
  shown, α 1 — with no pointer move in that window, so those frames came
  from the loop-wake hook. Release and Escape as above.
- **off** (under the pre-load rAF shim): α 1 at press +60 ms and through a
  168 px sweep; the bubble tracks; release and Escape as above.
- **combo**: unit-tested only; the wiring is the same.

Pane caveat met along the way: rAF froze mid-session (0 frames in 3 s)
between runs, which stalled one dwell run after its fade-in and left the
first off run without a single frame — the location label still updated
synchronously on every move, and nothing was logged. Not app behaviour;
the off run was redone under the shim. (A pane profile with nothing stored
starts at lat 0 / lon 0 / tz undefined, "No location set"; both stalls
happened to land there, which cost some time telling the two apart.)

## 7. Review round 1 (Steve, 2026-09-24; build 2.1.5): one rule, much stricter

Seen on the desktop, before any phone pass: the bubble needs to be kept off
the map far more aggressively. There is very little point in it except for
*very* small motions, and refining a position that way will not be a
common story. So no comparison of candidates — one rule, in Steve's words:

- Don't show the loupe until the speed has been below **5 px/s** for at
  least **two seconds**.
- Don't take it away if the speed briefly goes above 5 px/s while the
  pixels travelled are under **10 px**; otherwise take it away immediately
  once we have moved 10 px.

(He also asked for the speed threshold to be symmetric at 5 px/s — under
this rule there is only one threshold, so it is.)

**Translation into the module.** This is the `dwell` scheme with new
numbers and an absolute hide distance, so the four candidates and the
`?mag=` switch were deleted and the gate is now that one rule with four
constants at the top of `magnifier-gate.ts`:

| Knob | Value | Meaning |
|------|-------|---------|
| `MAG_REST_V` | 5 px/s | average speed below which the pointer is at rest |
| `MAG_DWELL_MS` | 2000 ms | how long it must be at rest before the bubble shows |
| `MAG_FAR_PX` | 10 px | displacement from where the bubble appeared that hides it |
| `MAG_FADE_MS` | 150 ms | the opacity ramp, each way |

One interpretive step, flagged to Steve: "below 5 px/s for two seconds" is
measured as an **average over the window** — the pointer stays within
`MAG_REST_PX` = 5 px/s × 2 s = 10 px of where it came to rest for 2 s
(leaving that radius restarts the clock from the current point). An
instantaneous estimate at 5 px/s is down at the level of touch jitter: one
1 px twitch reads 60 px/s for a frame, and on a phone the clock would
restart forever. The average reading keeps the same numbers and is what
the words mean in practice; the previous speed estimator (the exponential
average) is gone with the candidates, since neither rule needs a speed at
all — the hide rule is pure displacement from the anchor, exactly as
stated, so a fast twitch inside 10 px keeps the bubble. The rule is pure
geometry and time, hence frame-rate independent by construction.

Consequences worth knowing while tuning: a press that does not move shows
the bubble after 2 s; after a sweep the clock counts from the stop; a
steady crawl at 4 px/s shows it after 2 s and then loses it 2.5 s later
(10 px from where it appeared) — the rule as stated, and probably what
"very small motions" means. If the bubble should instead survive a run of
small refinements in one direction, the one-line variant is to move the
anchor with the pointer while it is at rest (the old `combo` idea); not
done.

**Verified** (unit: 11 tests — the dwell from a press and from a stop, the
average-speed reading with a 4 px/s crawl showing and a 6 px/s one never
showing, jitter immunity, the fast excursion inside 10 px, the 10 px hide
and the fresh rest after it, the long-gap step, rate independence at 60 and
240 Hz, reset). Full suite green (8905). Pane, under the rAF shim, build
2.1.5: see the record below.

**Pane record (build 2.1.5, rAF shim, 1280×800, band x 960–1254 so the
bubble is r 45; the script's sleeps overran under the pane's timer
throttling, so `restMs` from `_dragMag` is the clock that counts):**
press and hold — hidden at 1.2 s at rest (α 0, `restMs` 1221), shown α 1
by the 2 s mark; a 6 px twitch (375 px/s for a frame) and back — stays
shown, `driftPx` 6 then 0; 12 px of slow drift (30 px/s) — hidden the
moment it passed 10 px (α 0.18 and falling 115 ms later, the rest clock
restarted there); a 100 px sweep — hidden throughout, rest clock ~100 ms
at its end; then no pointer input at all — still hidden at 1.7 s at rest,
shown α 1 by 2.2 s (those frames came from the loop-wake hook); `pointerup`
→ `_dragMag` null and the Keep dialog up, Escape → gone and San Francisco
restored.

## 8. Review round 2 (Steve, 2026-09-24; build 2.1.6): the anchor moves

§7's consequence — a steady 4 px/s crawl shows the bubble and then loses
it 2.5 s later, 10 px from where it appeared — was not wanted: a low speed
without actually stopping should not take the loupe away either. Steve's
proposal: move the anchor every second.

**Done as a trail rather than a stepped anchor.** A stepped anchor has a
phase artifact: 6 px just before the reset plus 6 px just after is a 12 px
burst that is never measured whole, so whether it hides the bubble depends
on where the clock happened to be. So the gate keeps the trail of positions
over the last `MAG_DRIFT_MS` = 1000 ms and hides when the pointer is more
than `MAG_FAR_PX` from **any** of them — the anchor at every point of the
last second. Consequences, all of them the intent:

- a crawl slower than `MAG_FAR_PX / MAG_DRIFT_MS` = 10 px/s keeps the
  bubble for any length (the trail moves with it); faster hides it;
- a 10 px burst hides it whenever it happens, split or not; an
  out-and-back beyond 10 px hides it at the far point;
- 10 px covered over more than a second is a crawl, not a burst;
- after the loop has parked with the bubble shown (pointer still), a jump
  is measured against the position the pointer left: the trail always
  keeps the youngest sample older than the window as the boundary
  reference.

Between 5 and 10 px/s the rules are consistent by construction: hidden
stays hidden (the rest window sees more than 10 px in 2 s) and shown stays
shown. `MAG_DRIFT_MS` is the new knob; at 2000 ms the two rules become
symmetric at 5 px/s.

Mechanics: a 256-slot `Float64Array` ring of (t, x, y), sampled at most
every 8 ms so it covers the window at any frame rate, cleared and seeded
when the bubble appears, scanned newest-first per frame and stopping at the
boundary sample — at most ~125 distances a frame, no per-frame allocation.
`magGateDebug().driftPx` reports the measured trail drift while shown.

**Verified**: 17 unit tests (the six new hide cases above plus the hide
rule at 60 and 240 Hz); full suite green (8911). Pane, under the rAF shim,
build 2.1.6: see below.

**Pane record (build 2.1.6, rAF shim, 1280×800):** press and hold 2.3 s —
shown, α 1; a crawl of 40 px in 9.5 s (≈ 4 px/s, four times the old
fixed-anchor limit) — shown throughout, α never below 1, trail drift
peaking at 7 px, the bubble tracking the pointer (x 1061 → 1101); then a
12 px burst — hidden at once (α 0 within the first sample, the rest clock
restarted); `pointerup` → `_dragMag` null and the Keep dialog up, Escape →
gone.

## 9. Review round 3 (Steve, 2026-09-24; build 2.1.7): the dwell is 1 s

The speed may be right; the initial 2 s delay is too long. `MAG_DWELL_MS`
2000 → 1000, everything else the same. One derived change, since "at rest"
is defined as staying within `MAG_REST_V × MAG_DWELL_MS` of the rest point:
the rest radius `MAG_REST_PX` is now 5 px rather than 10 — the reading
that keeps the speed at 5 px/s. Both rules now sit on a one-second window:
show after 1 s within 5 px (under 5 px/s), hide on 10 px within 1 s (over
10 px/s); between the two, hysteresis as before. Touch jitter of a pixel or
two still sits well inside the 5 px radius. Unit tests are written against
the constants and needed one change (the jitter test's schedule scales
with the dwell); 17 pass, full suite green.

**Pane record (build 2.1.7, rAF shim, 1280×800):** press and hold —
hidden at 0.4 s and 0.9 s at rest, the rest clock running straight
through a 3 px twitch (`restMs` 391 → 599 → 897, `driftPx` 3: inside the
5 px radius, no restart), shown at α 1 by 1.3 s; `pointerup` → `_dragMag`
null and the Keep dialog up, Escape → gone.

## 10. Review round 4 (Steve, 2026-09-24; build 2.1.8): touch is exempt

Tried on the phone: one of the reasons for the magnifier in the first place
is that on a touch device the finger is right on the target — the bubble
is the only view of the point being chosen, at any speed. So touch drags
are exempt from the gate: the bubble is up for the whole drag from the
press, exactly its pre-Part-6 behaviour. Mouse drags keep §7–§9.

**Mechanics.** Nothing new to detect: each drag already records
`pointerType === 'touch'` at its start (`resetDragMagnifier`'s `isTouch`,
from the touch-sizing plan) for the 44 px finger-clearance gap, and the
same flag now short-circuits the gate — `drawDragMagnifier` uses opacity 1
without stepping it, and `dragMagnifierAnimating()` is false, so a touch
drag's loop parks as it always did. Per drag, not per device, as before
(an iPad with a trackpad gates the trackpad and exempts the finger).
**Pen** drags are gated with the mouse: a stylus tip does not hide the
point the way a fingertip pad does; if that turns out wrong, the predicate
is the one comparison in `startDragAt`. `window._dragMag.touch` reports
the flag.

Pane (rAF shim, build 2.1.8): a synthetic touch drag — α 1 and `touch`
true from the first sample after the press (80 ms) through a 168 px sweep
at ~600 px/s and a 1.3 s stop; a mouse drag in the same page — hidden
through the sweep (the rest clock resetting every ~50–100 ms), counting
after the stop (536 ms at +400 ms), shown at α 1 by +1.3 s. Release and
Escape as before on both. (A synthetic touch event needs the pane's live
pointer id — `pointerId: 1` — for the drag to end: with a made-up id the
browser's `releasePointerCapture` throws in the `pointerup` handler before
the Keep dialog; real touches carry live ids.)

