# iOS back-port: the time controller, for Emerald Observatory (iPad)

**Status**: **decided 2026-10-03** — the maintainer reviewed the proposal
(committed 2026-09-25 as `92d4d92`) and answered every question in §9; the
answers are folded into the text below. **Implementation in progress** on
the Observatory branch `steve/time-controller`: steps 1–8 of §7 are built
(§11–§18 are the records; steps 1–7 and the esastro fix are committed,
step 8 awaits its commit); step 9, the device pass and the knob tuning,
remains, and then the pull request (§10). The
iOS sources were read from clones of the GitHub `main` branches. Emerald
Chronometer (iOS) is explicitly **out of scope** — its hand-dragging and
tappable date windows cover the same ground differently.

**Created**: 2026-09-25

**Web spec**: [docs/time-controller.md](../docs/time-controller.md) (the
panel as it ships in build 2.0.164), with
[src/shared/time-controls-ui.ts](../src/shared/time-controls-ui.ts) (the
wiring and gestures), [src/shared/time-controller.ts](../src/shared/time-controller.ts)
(the time model), [src/shared/astro-stepper.ts](../src/shared/astro-stepper.ts)
(the rise / set / transit / phase searches) and
[src/partials/time-controller.html](../src/partials/time-controller.html) /
[.css](../src/partials/time-controller.css) (layout, sizes, colours).
Design history: [2026-09-23-time-controller-redesign.md](2026-09-23-time-controller-redesign.md)
(unit first, one pair, any body),
[2026-09-24-time-controller-two-stories.md](2026-09-24-time-controller-two-stories.md)
(fade only while scrubbing, close rules, hands-free scrubbing).

**iOS baseline** (GitHub `main` as of 2026-09-25): Observatory `881f9c9`
(v1.6.1, build 5, "fix some UI bugs"), esastro `b94f870`, estime `a9d95db`,
eslocation `8514ca3`, esutil `e2e4c0f`. Line numbers below are in that
Observatory tree. The August eclipse back-ports (Observatory `8ba1206`,
`1f0bf05`; esastro `eb077b4`…`0a6023b`; estime `0a5fbeb`) are all upstream
now, so the `ios-backports/` clones are strict ancestors of these heads and
`git pull --ff-only` will freshen them cleanly when implementation starts
([docs/ios-backports.md](../docs/ios-backports.md), "How a session does a
single fix", step 2).

## 1. In one paragraph

Replace the iOS app's "Set" mode — a single row of fourteen 45×40 unit
buttons (century, year, month, phase, day, hour, minute; red backward, blue
forward) that step on touch and repeat at twenty units a second when held —
with the web's panel: choose *what a step means* once (a calendar unit or an
astronomical event), then step with one big ◀ ▶ pair, hold either button to
scrub, type a date directly, and run or stop the clock from a transport row.
The panel is built from UIKit primitives (`UIView`, `UIButton`, `UILabel`,
`UITextField`, `NSTimer`, the app's own touch-tracking idioms) on top of the
time model the app already has (`ESWatchTime` in estime) and the searches the
astronomy library already has (`ESAstronomyManager` in esastro) — nothing
from the web's TypeScript is transliterated; the *behaviour* is ported. One
esastro one-liner is required on the way (§6.7).

## 2. The two controllers today

### 2.1 iOS: "Set" mode

Everything lives in `Classes/EOClock.mm`, on a fixed 768×1024 canvas that
`MainViewController.mm` (v1.6.1) scales to the window's safe area.

- **The Set button** (`resetBut`, 69×40, EOClock.mm:1995): under the world
  map in portrait, top centre in landscape. It toggles `setMode`
  (EOClock.mm:879–936): the button reads "Set" out of set mode and "Reset"
  in it.
- **The row** (`createClockWidgets`, EOClock.mm:1911–1912, 1919–1920,
  1950–1953, 2187–2190, 2194–2195): fourteen `UIButton`s of 45×40 canvas
  units in one row at y = 327 (portrait) / 347 (landscape), the gap between
  the header box and the top of the main dial. Left half red, right half
  blue: `cent year mon phase day hour min | min hour day phase mon year
  cent`. Red steps backward, blue forward (the static colour names
  `fwdColor` / `bckColor` are swapped relative to their use — the comment at
  :675 is the authority). Hidden unless in set mode.
- **A press** (`buttonActionDn:`, :673–730) stops the clock, sets that
  unit's step counter to ±1 and jumps once, immediately.
- **A hold**: the 20 Hz clock timer (`EOClockUpdate`, :62) calls `doJumps`
  (:433) every tick in set mode; it waits 0.75 s after the last press and
  then applies every non-zero step counter on **every** tick — twenty units
  a second (twenty *quarter phases* a second for "phase").
- **The latch** (documented: "Help Text3" in every `Localizable.strings`):
  `buttonActionUp:` (:945) is wired to `TouchUpInside` only (:1066), so a
  finger that slides off the button before lifting never clears the
  counter and the unit keeps advancing until the *same* button is tapped
  again or Reset is tapped. Latching a second unit adds it to the first.
- **Phase** jumps through `nextMoonPhase()` / `prevMoonPhase()` (:461–472)
  inside the `setupLocalEnvironmentForThreadFromActionButton` /
  `cleanup…` bracket every astronomy call needs.
- **The strip** (`dateLabel`, :419–428, :473–484): a 20-unit-tall label
  along the top of the canvas, shown only in set mode (the status bar is
  hidden to make room, `setStatusBar:` :269–277): weekday, date, time, zone,
  `<offset from now>` and the location, in red while the time is not real.
- **Reset** returns to real time (`resetToLocal()`), leaves set mode, hides
  the row and the strip, restores the status bar.
- **No running transport**: the first press stops the clock and only Reset
  restarts it, at the present. `ESWatchTime` has `start()`, `setWarp()` and
  `reverse()` (estime `ESWatchTime.cpp`:932–959, 1100–1117), but the app
  never exposes them.
- **Demo** (`demoBut`, :757–878): debug builds only; cycles five eclipse
  scenes. Unrelated to this plan except that it appears with the row.

### 2.2 Web: the panel

From [docs/time-controller.md](../docs/time-controller.md):

```
 [ Now ▶ ] [ ‖ ]            [×]  transport — Now when time is overridden; ‖ running, ◀ ▶ stopped; close
 10 day/s ▶                       the rate / status label
 STEP BY
 [yr ] [mo ] [day] [hr ] [min]    unit chips (44 px); one is selected
 [sec] [rise][set][transit][phase]   astro chips are tinted
 [‹]        Jupiter          [›]  body stepper — rise / set / transit only
 [ ◀ ]    Jupiter rise      [ ▶ ] the pair (56 px): tap = one step, hold = scrub
 SET DATE & TIME
 [YYYY] [MM] [DD]  /  [CE] [HH] [mm]
```

Tap = one step (astro chips: one search); hold = after 300 ms the clock
runs at ten units a second until release; the panel fades to 0.38 opacity
while a scrub runs and only then; a release *off the button at the display's
edge* keeps the scrub running hands-free until the next press anywhere,
with a green padlock as the tell; the transport row stops, restarts (either
direction) and returns to Now; the date fields apply on change through the
hybrid Julian/Gregorian calendar with a CE/BCE toggle; the unit and body
persist per app; Escape and a press on the display close the panel. The
time bar under the display shows the date, offset, rate and a Now button
whenever the time is overridden, panel open or not.

### 2.3 Same engine, different plumbing

The two apps share an ancestry, which is what makes this a *port* rather
than a rewrite:

| Concern | Web | iOS |
|---|---|---|
| Time model | `TimeController` (offset / stopped / quantized ticks) | `ESWatchTime` (warp + offset; stop / start / setWarp; `advanceBy*` in local wall-clock time; `setToFrozenDateInterval`; `resetToLocal`; `checkAndConstrainAbsoluteTime` — the web's `clampDisplayTime` was written to mirror it) |
| Calendar arithmetic | `es-calendar.ts` (ported from estime) | `ESCalendar_add{Days,Months,Years}ToTimeInterval`, `ESCalendar_{local,timeInterval}…DateComponents` (hybrid Julian/Gregorian, era-aware) |
| Rise / set / transit / phase | `astro-stepper.ts` (ported from esastro's `nextPrevRiseSetInternalWithFudgeInterval` family) | `ESAstronomyManager::{next,prev}Planet{rise,set}ForPlanetNumber`, `{next,prev}Planettransit`, `{next,prev}MoonPhase` |
| Display refresh | the rAF loop + `Updater.reset()` | the 20 Hz `tick` + `timeChanged` (every `EOScheduledView` updates) / `resetTargets` |
| Persistence | `app-state` (`tu`, `tb`, `t/off/dir`) | `NSUserDefaults` (the app already keeps `EOPlanet`, `EONoonOnTop`, …) |

One semantic difference to keep in mind: the web steps calendar units in
UTC components (`advanceByUnit` passes a zero zone offset), so its day step
is a flat 24 h — 12:00 PDT on the fall-back day becomes 11:00 PST the next —
and its month step from 23:00 local on Jan 30 lands on Feb 27 (verified with
the web engine, 2026-09-25). iOS's `advanceByDays` "works on DST days" by
design and its month/year steps keep the local wall-clock time. **This plan
keeps the iOS semantics** — they are the ones a user expects — and notes the
web behaviour as a separate question for the web side, not part of this
back-port.

## 3. The user's perspective

### 3.1 What changes

- The "Set" button opens a **panel** at the lower right of the display
  (draggable from there) instead of revealing a row of buttons; the panel's × (or the same button,
  now reading "Done") closes it. The strip along the top still appears
  whenever the time is not the present, panel or no panel, and gains a
  **Now** button of its own, so a set time can be *kept* with the panel
  closed — today's Reset both returns to now and leaves set mode; the two
  come apart.
- **Choose, then step**: tap a unit chip once (year, month, day, hour,
  minute, second — or rise, set, transit, phase), then tap ◀ or ▶ as often
  as needed. The label between the pair always names what a tap will do
  ("1 day", "Sunset", "Jupiter transit").
- **Hold to scrub** at twenty units a second — the old row's cadence, kept
  after the simulator pass showed the web's ten a second looked choppier
  here (§9 decision 8, revised) — after the web's 300 ms engagement. The
  panel fades to about a third while the scrub runs so the display shows
  through.
- **Hands-free scrubbing** keeps the old app's latch as it is: slide the
  finger off the button before lifting and the scrub runs on, hands-free,
  until the next tap anywhere; a green padlock on the panel shows while
  letting go would do that (§9 decision 2). Two things do change: there is
  one scrub at a time (no second unit can be stacked on a latched one), and
  *any* tap stops it — today only the same button or Reset does.
- **New abilities**: a seconds unit; rise, set and transit for nine bodies
  (Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune),
  defaulting to the planet on the altitude/azimuth dials; a typed date and
  time with a CE/BCE toggle; a transport row that stops the clock and
  restarts it at 1× from the set time, forward or backward (§6.3); a status
  line ("Stopped", "10 day/s ▶", "1× (real time)").
- **Century** stays, as an eleventh chip (§9 decision 1): the panel's first
  row is `cent year mon day hour min`, and holding scrubs centuries at ten
  a second.
- **Escape** on a hardware keyboard closes the panel (a hands-free scrub
  stops first), and a press on the display closes it too and still does what
  it did (tapping the altitude dial both closes the panel and cycles the
  planet).

### 3.2 What gets better

- Rise / set / transit stepping for any body, and seconds — neither exists
  today.
- A typed date: today reaching 1066 or 2800 means holding a button for
  many seconds while the display churns.
- Keep a time and look at it: close the panel and the display is
  unobstructed, with the red strip and Now still there.
- Run the clock from a chosen moment ("what happens over the next minute
  of this eclipse?") instead of only stepping frozen time.
- The mode is always visible (the pair's label, the status line); the
  scrub is visible (the panel fades); a latched scrub is visible (the
  padlock) and one tap stops it — today a latched unit silently keeps going
  until the right button is found.
- One shared design with the web app, and one help text to keep true.

### 3.3 What gets worse, or is merely different

- **An overlay**. The old row sat in an empty band above the dial and hid
  nothing; the panel (308×389 canvas units, 433 with the body row) opens
  over the lower-right of the display — the Equation of Time subdial and
  part of the main dial's evening side. The scrub fade and the
  close-on-display-press rule mitigate this, and the panel can be dragged
  anywhere on the canvas (§4.2 j, §9 decision 5).
- **Two taps instead of one** when the unit changes: today "+1 month, +2
  days, −1 hour" is four taps; with unit chips it is seven. Repeated steps
  of *one* unit cost the same as today.
- **Steps snap** (no sweep). That is today's behaviour too; the web's hands
  glide because of an animation system iOS does not have (§4.3).
- **Help and App Store text** must be rewritten and re-translated (§5.5):
  "Help Text2/3" describe the row, and "iTC description4" promises "…year
  or century".
- The first visit is a small relearning for existing users; the old row's
  vocabulary (the same abbreviations, red and blue for direction) carries
  over where it can.

## 4. The design on iOS

### 4.1 Element by element

| Web element | iOS primitive | Notes |
|---|---|---|
| `#time-popover` / `#tp-panel` (264 px column, 0.96 dark background, 14 px radius, 1 px border) | `EOTimeControllerView : UIView`, `opaque = NO`, background `rgba(26,26,46,.96)`, `layer.cornerRadius 14`, `borderWidth 1`; laid out in code in canvas units, a subview of the `EOBaseView` so it scales and reorients with everything else | No xib, no Auto Layout: the canvas is a fixed 768×1024 that `scaleBaseViewToSize:` scales, and every widget is positioned by `reorientSubView:` from constants set in `initializeConstantsForOrientation:` — the panel follows that convention. Not a `UIPopoverPresentationController`: a system popover cannot fade to reveal the display, is modal by default, and its material clashes with the app's chrome. |
| Time bar (`#time-bar`: date, offset, rate, Now) | The existing `dateLabel` strip along the top; the "Now ▶" `UIButton` (§9 decision 3) sits beside the Set/Done button — the two centred as a pair while it shows — not on the strip | The strip shows while the panel is open **or** the time is not real; the status bar hides while it shows, as it does in set mode today. The button shows while the time is not the present. (First built at the strip's right end: the strip's text ran under it in portrait on the simulator, 2026-10-03, §13.) |
| `⏱ Show / Hide time controller` | The existing Set button (`resetBut`): "Set" when closed, "Done" (existing key) when open | Same place, same size, same `createButtonAtX:` plumbing. |
| Transport row (`Now ▶`, `‖`, `◀ ▶`, 44 px) and `×` | Four `UIButton`s, 44 units tall, in the panel's top row; act on `TouchDown` | ‖ → `time->stop()`; ▶ → `time->setWarp(1)`; ◀ → `setWarp(-1)` (with §6.3); Now → `resetToLocal()`; each followed by `resetTargets` + `timeChanged = true`. Explicit `setWarp(±1)` rather than `start()`: `start()` resumes at whatever the warp was before the freeze. |
| `#tp-rate-label` | `UILabel`, 11 pt, `#8af` | "Stopped" / "1× (real time)" / "1×" / "1× ◀" / "10 day/s ▶", from warp and scrub state (§4.2 h). |
| Unit chips (`.tp-chip`, 5 × 2 grid, 44 px, astro tint) | Eleven `UIButton`s, 44 units tall, in two rows — `cent year mon day hour min`, then `sec rise set transit phase` stretched to the same width — `layer` styled like the CSS; the selected one highlighted (`#8af` border and text) | Labels reuse the row's existing localized abbreviations (§5.5). Six 44-unit cells and five 4-unit gaps make the panel 308 units wide (§4.2 j; §9 decision 1). `UISegmentedControl` was considered and rejected: its selection is per control, the astro tint and the two-row split fight it, and its height is not 44. |
| Body row (`‹ Name ›`) | Two 44-unit `UIButton`s and a `UILabel` (`#8af`, 15 pt); hidden unless rise / set / transit | Name from `[Utilities nameOfPlanetWithNumber:]` (already localized for all nine bodies). |
| The pair (`◀ ▶` 56 px, `#tp-step-label`) | Two 56-unit `UIButton`s with `TouchDown` / `TouchUpInside` / `TouchUpOutside` / `TouchCancel` / `TouchDragExit` / `TouchDragEnter` actions (no touch location: §9 decision 2); a bold 15 pt `UILabel` | UIControl keeps tracking a touch wherever it goes, and classes the release inside or outside, which is all the latch needs (§4.2 c–e). |
| Date inputs (`#tp-year … #tp-minute`, `#tp-bce`) | Five `UITextField`s (number pad, centred, 44 tall) and a CE/BCE `UIButton`; apply on end of editing / Return | Composed with `ESCalendar_timeIntervalFromLocalDateComponents(env->estz(), &cs)` — hybrid calendar, era in `cs.era`, the zone's offset at the target instant, so the web's two-pass composition is unnecessary. A `UIDatePicker` is the native-looking alternative and the reason not to use it is real: it is proleptic Gregorian (ten days off before 1582-10-15) and has no BCE, while the app's range is 4000 BCE – 2800 CE (§9 decision 6: the fields). |
| `.tp-hidden` (0.38), `.tp-lock-zone`, `.tp-locked`, `#tp-lock-badge` | `panel.alpha` animated over 0.15 s; a `UIImageView` with the SF Symbol `lock.fill` tinted `#4cd964`, 96 units, alpha 0.75 while the held touch is off the button and 0.4 once locked | `alpha` keeps hit-testing (UIKit stops delivering touches only below 0.01), so a held button keeps tracking through the fade — the iOS form of the web's "opacity-only" rule: never `hidden`, never removed, mid-hold. SF Symbols are already used by the app (`info.circle`, MainViewController.mm:32). |
| The hands-free stop (document capture-phase `pointerdown` + click swallower) | A transparent full-canvas `UIButton` ("shield") added above everything while a scrub runs hands-free; its `TouchDown` stops the scrub and the touch goes nowhere else | The app's own idiom: `snoozeBut` (:2197) is exactly this for the alarm. No click swallower is needed — UIKit synthesises no click. |
| A press on the display closes the panel | A `UILongPressGestureRecognizer` (`minimumPressDuration 0`, `cancelsTouchesInView NO`) on the base view whose delegate ignores touches inside the panel, the Set button and the strip | Recognises at `touchesBegan`, so it acts on the press like the web, and the touch still reaches whatever it landed on (the altitude dial cycles its planet). |
| — (the web's panel stays put) | A `UIPanGestureRecognizer` on the panel view drags it; it opens at the lower-right corner (§4.2 j, §9 decision 5) | The recogniser's delegate refuses touches that begin on a control (`gestureRecognizer:shouldReceiveTouch:` → NO for any `UIControl`), so drags start on the captions, labels or background, and a hold on the pair whose finger slides off the button is never mistaken for a drag (a pan does not overlap a button's default action, so UIKit would otherwise let the superview's recogniser take the touch and cancel the hold). |
| Escape (capture-phase, yields to overlays) | `-keyCommands` on `MainViewController` (`UIKeyInputEscape` only — no `t` toggle, §9 decision 10); acts only while nothing is presented (`presentedViewController == nil` — the Options screen and alerts own the key otherwise) | iPad hardware keyboards and the Mac. |
| `updater.reset()` after every transition | `resetTargets` (already what Reset does) after transport changes and Now; `timeChanged = true` after every step, jump or typed date so every `EOScheduledView` redraws at the next tick (≤ 50 ms), as `doJumps` does today | Not `resetTargets` on steps: `EOHandView.resetTarget` re-arms the one-second animated sweep, which is designed for a running clock (it computes the target for *now + 1 s*) and would lag a 10 Hz scrub. |
| `tu` / `tb` in `app-state` | `NSUserDefaults` keys `EOTimeStepUnit` (string, default `"day"`) and `EOTimeStepBody` (planet number, default −1 = follow the dials), registered in `setupDefaults` | The web also persists the panel's open state and the overridden time itself; iOS keeps its current behaviour: a fresh launch is the present, with the panel closed (§9 decision 4). |
| `RATE_OPTIONS` / `TICK_INTERVAL_MS` (10 Hz) | The existing 20 Hz `tick` drives the scrub: one unit per tick (the old row's cadence; revised from the web's ten a second after the simulator pass, since iOS shows no motion between positions) | No second timer; no warp — a scrub is a sequence of the same `advanceBy*` jumps a tap makes, exactly like today's `doJumps`, so DST days, Feb 29 and month ends behave as they do now. |

### 4.2 Behaviour

The spec the code follows; where the web and today's iOS differ, the choice
is stated.

a. **Units.** `cent yr mo day hr min sec` step by `advanceByYears(±100)`,
   `advanceByYears / Months / Days(env)` and `advanceBySeconds(3600 / 60 /
   1)`; `rise set transit` search for the chosen body; `phase` searches the
   Moon's quarters (`nextMoonPhase` / `prevMoonPhase`, as today). The
   default unit is a day.

b. **Tap** on ◀ / ▶: `time->stop()` first (every tap stops the clock —
   today's rule and the web's), then the step or the search, then
   `checkAndConstrainAbsoluteTime` (the `advanceBy*` and
   `setToFrozenDateInterval` calls do this themselves), then `timeChanged =
   true`. An astro search that returns NaN (polar day or night, a body that
   never rises here) flashes the pressed button's background for 0.3 s and
   changes nothing. The searches must run inside the
   `setupLocalEnvironmentForThreadFromActionButton(false, time)` / `cleanup…`
   bracket and **after** the stop: the `prev*` functions invert their
   meaning while the watch runs backward (`ESAstronomy.cpp`:2561, 2922,
   3144), and a stopped watch is never "running backward".

c. **Hold** (calendar units only; the astro chips are tap-only, as on the
   web): the tap's step happens at once; an `NSTimer` armed at `TouchDown`
   fires after 300 ms and engages the scrub — direction and unit recorded,
   the panel fades, the status line shows the rate. From then on `tick`
   advances one unit per tick — twenty a second, the old row's cadence —
   until the scrub ends. (Today: 750 ms then 20/s. The web's 300 ms is
   adopted, §9 decision 8; its ten a second was tried first and looked
   choppier in the simulator, because iOS draws each position as a jump
   while the web sweeps the hands between ticks.)

d. **Release.** `TouchUpInside` — the finger lifts on the button — ends the
   scrub: `time->stop()`, restore the panel, `resetTargets` (so the views
   re-arm their schedules from the stopped time), write the status line.
   `TouchUpOutside` — the finger lifts anywhere else — is the latch (e).
   `TouchCancel` (a system gesture, a rotation, a phone call): end the
   scrub — unknown state, stop.

e. **Hands-free** (the latch, as the app has always had it — §9 decision 2):
   a `TouchUpOutside` after the hold has engaged turns the scrub from *until
   release* into *until the next press*, wherever the finger lifts — the
   web's extra "at the display's edge" condition is not applied, so no touch
   location is needed. While the held touch is off the button
   (`TouchDragExit`; `TouchDragEnter` when it returns) the panel comes
   back to full alpha with the padlock at 0.75, so the outcome of letting
   go is visible before it happens; drag back onto the button and it fades
   again. Once locked, the padlock stays at 0.4 over the faded panel, the
   button's highlight clears, the shield goes up, and the next press
   anywhere — the shield's `TouchDown` — stops the scrub and is swallowed.
   That stop is the one departure from today's latch, where only the same
   button or Reset ends it and a second unit can be latched on top of the
   first: with one pair there is one scrub, and any tap ends it. A
   `TouchUpOutside` before the hold has engaged (a finger that slid off
   within the first 300 ms) is a tap — one step, no latch — which keeps a
   sloppy tap from running time away. The scrub also stops on Escape (the
   panel stays open), on `goingToBackground` (a suspended app must not run
   time away when it resumes; today's latched counters do exactly that),
   and on an orientation change (`prepareToReorient`). A finger that leaves
   the screen's edge is expected to arrive as `touchesEnded` (a latch); if
   a device reports a cancel instead, that lift stops — the device pass
   confirms which (§8.3).

f. **The fade** is the only fade: taps, transport presses, Now, chips and
   the date fields leave the panel at full alpha (the two stories). The
   fade's level, 0.38, is the web's tuned value (§9 decision 8), adjustable
   on a real display.

g. **Transport.** `Now ▶` appears whenever `!time->isCorrect()`; `‖` while
   `warp != 0`; `◀ ▶` while stopped (§6.3 is what makes ◀ work). All act on
   `TouchDown`. After a transport change: `resetTargets`, `timeChanged`,
   strip and status line. Now leaves the panel open (today's Reset closes
   set mode; the panel's × and the Set/Done button do that now).

h. **Status line.** "Stopped" when `warp == 0` and no scrub; "10 day/s ▶"
   (the unit's abbreviation, the direction glyph) while a scrub runs;
   "1× (real time)" when `isCorrect()`; "1×" / "1× ◀" when running at
   `warp ±1` from a set time. `ESWatchTime::representationOfWarp()` exists
   (unlocalised) and can cover any other warp.

i. **The strip** keeps today's content (`dateFormatter`, `<offset>`,
   location; red when not real) and appends the status line's text; it is
   visible while the panel is open or the time is not real, and the status
   bar hides while it is visible — the existing `setStatusBar:` rule with
   "set mode" widened to "strip visible". `MainViewController` keeps
   reserving the status bar's height (`statusBarSafeAreaTop`) so the canvas
   does not rescale when the bar hides. Optional while there: format the
   strip's date through `ESCalendar_localDateComponentsFromTimeInterval`
   rather than `NSDateFormatter`, which is proleptic Gregorian and disagrees
   with the `yearLabel` for dates before 1582-10-15 (a pre-existing
   inconsistency; the web fixed its equivalent in September).

j. **Placement.** Opens anchored to the canvas's lower-right corner with a
   12-unit margin in both orientations, over the Equation of Time subdial
   (and, in landscape, the lower edge of the eclipse simulator) — the web's
   position and the least time-critical element to cover — and can be
   **dragged** from there (§9 decision 5): a `UIPanGestureRecognizer` on the
   panel whose delegate refuses touches that begin on a control, so drags
   start on the captions, labels or background and a hold on the pair that
   slides off the button is never mistaken for a drag. The dragged position
   is kept while the app runs (across close/open and rotation, clamped to
   the canvas) and resets to the corner at the next launch; persisting it is
   one `NSUserDefaults` key if ever wanted. In canvas units the panel is
   308 × 389 (433 with the body row): on a 12.9" iPad (scale ≈ 1.33) that is
   about 410 × 519 points with 59-point chips, on an 8.3" mini (scale ≈
   0.97) about 43-point chips.

k. **Date fields.** Refreshed every tick from
   `ESCalendar_localDateComponentsFromTimeInterval(time->currentTime(),
   env->estz(), &cs)` except the field being edited (the web's rule, for
   the same reason: a running clock must not overwrite keystrokes); written
   only when the text changes. Applying: `cs = {era, year, month, day,
   hour, minute, 0}` → `ESCalendar_timeIntervalFromLocalDateComponents` →
   clamp to `[ESMinimumSupportedAstroDate, ESMaximumSupportedAstroDate]`
   (Constants.h:473–475) → `setToFrozenDateInterval` → `timeChanged`. The
   software keyboard (an iPad without a hardware keyboard) covers the
   bottom of the screen where the panel sits: observe
   `UIKeyboardWillChangeFrameNotification` and shift the panel up by the
   overlap while a field is first responder (the app has no keyboard
   handling today; the Options screen's lat/long fields sit high enough
   not to need it).

l. **Body.** The nine-body list in the web's order. While
   `EOTimeStepBody` is unset the row shows the dials' planet
   (`altHand.planet`, itself persisted as `EOPlanet`) and follows it when
   the dial is tapped; the first ‹ › tap stores a choice and the two are
   independent from then on. Phase hides the row and is always the Moon's.

m. **Limits.** `checkAndConstrainAbsoluteTime` already stops a running
   watch at 4000 BCE / 2800 CE and clamps a frozen one; the strip shows
   "AT LIMIT" (its own key; the unused "earliest / latest time supported"
   strings stay unused) and a scrub against the limit simply sits there,
   as on the web.

n. **Closing.** ×, the Set/Done button, a press on the display, Escape. Each
   ends any scrub *first* (a hidden view stops receiving the touch that
   would have ended it — the exact bug the web fixed on all its close
   paths). Closing does not change the time.

o. **Debug builds.** `demoBut` shows while the panel is open, as it shows in
   set mode today.

### 4.3 What is deliberately not ported

- The web's animation system (hands gliding to a stepped time, scrub
  compression): steps snap, as they do in the app today. Optional polish
  later: `resetTargets` on a *tap* would run `EOHandView`'s one-second
  sweep, but that sweep targets *now + 1 s* and jumps back when it
  finishes — visible on the seconds hand of a frozen clock — so it is not
  proposed.
- Share links, URL state, the `t`/`off`/`dir` persistence, the panel-open
  persistence, and the Observatory web app's chrome-drop layout rule.
- The `t` and `n` hotkeys (§9 decision 10); Escape stays, as one of the
  panel's close paths rather than a shortcut.
- Chronometer iOS.

## 5. The developer's perspective

### 5.1 Shape of the code

Two new classes and a subtraction:

- **`Classes/EOTimeStepper.h/.mm`** — the model, an `NSObject` written in
  Objective-C++ with **no UIKit**: the unit table, the selected unit and
  body, the scrub state machine (idle → pending hold → held → hands-free),
  the operations (`stepUnit:direction:`, `astroJump:direction:` returning
  whether an event was found, `setDateComponents:`, `now`, `stop`, `play`,
  `playReverse`, `startScrub:direction:`, `scrubTick`, `stopScrub`), the
  status string, and the `NSUserDefaults` reads and writes. It holds the
  `ESWatchTime *` and `ESTimeLocAstroEnvironment *` it is given and
  reports back to `EOClock` through two calls (`timeDidChange` →
  `timeChanged = true`; `transportDidChange` → `resetTargets`). Keeping
  UIKit out of it is what makes it syntax-checkable and harness-testable in
  the VM (§8.1) and keeps `EOClock.mm` from growing.
- **`Classes/EOTimeControllerView.h/.mm`** — the panel: the widgets, their
  frames in canvas units, the touch handling for the pair (hold timer, the
  latch, lock-zone feedback), the drag, the fade and padlock, the shield, the date fields
  and keyboard avoidance; it drives the stepper and reads it to refresh
  labels once per tick. It knows nothing about the astronomy.
- **`EOClock.h/.mm`** loses the fourteen button ivars, the seven step
  counters, `doJumps`' unit branches, twenty-eight `if` branches in the two
  button actions, seven creation sites, fourteen reorient lines and
  fourteen `release`s — about 150 lines — and gains the stepper and panel
  as members, their creation and reorientation, the strip's new content,
  the display-press recogniser, and the "strip visible" rule: about 80
  lines.
- **`EOScheduledView.mm`** gains direction awareness for reverse running
  (§6.3): a dozen lines.
- **`esastro`** gets a one-line fix (§6.7), mirrored in Chronometer's
  `ECAstronomy.m`.

Rough size: 250–350 lines for the stepper, 600–800 for the view, net
about −70 in `EOClock`. Nothing new is linked: Foundation, UIKit,
QuartzCore and the four Emerald libraries are already there.

### 5.2 Constraints of this code base

- **Manual retain/release.** No ARC anywhere (`[super dealloc]`,
  `autorelease`, `release` throughout; no `CLANG_ENABLE_OBJC_ARC` in the
  project). The new files follow suit — no per-file `-fobjc-arc` (§9
  decision 9): `retain` what is kept, `release` in `dealloc`, `autorelease`
  temporaries, as `EOClock.mm` does.
- **Objective-C++.** Every `.mm` includes C++ headers from estime and
  esastro; the stepper is the same kind of file.
- **Style.** Tabs, K&R braces, `bool`, the app's own `ESAssert`, long
  explicit method names, comments where something is non-obvious. Match
  `EOClock.mm`, not the web.
- **The canvas.** All geometry is in the 768×1024 canvas units, centred at
  `[EOClock clockCenter]`, y up in the constants and y down in UIKit
  (`createButtonAtX:Y:` does the flip); `initializeConstantsForOrientation:`
  holds per-orientation anchors and `moveClockWidgetsForOrientation:`
  re-places every widget through `reorientSubView:`. Note the portrait
  quirk at :1738–1745 ("Gack…"): a non-zero y offset gets +77 and is then
  measured from the screen centre rather than the dial centre — the
  `dateLabel` call at :2411 shows the pattern the panel's anchor must copy.
  Test both orientations and a window resize on the Mac.
- **iPad only, plus the Mac.** `TARGETED_DEVICE_FAMILY = 2`; the app runs
  on Apple silicon Macs as "Designed for iPad" and the maintainer has been
  fixing Mac issues (window resizing, the info button). Mouse input arrives
  as touches; a mouse button released off the pair latches like a finger,
  and a release outside the window is to be verified there (§8.3).
- **Deployment target** is `$(RECOMMENDED_IPHONEOS_DEPLOYMENT_TARGET)` —
  unpinned, whatever the maintainer's Xcode recommends. Everything proposed
  here is old UIKit (SF Symbols iOS 13, `UIKeyCommand` iOS 7,
  `UILongPressGestureRecognizer`, `UIKeyboardWillChangeFrame`); nothing
  needs `UIButton.Configuration` or `UIMenu`.
- **Localizable.strings are UTF-16 LE** (all eight); edit them in Xcode or
  through `iconv` / `plutil`, never with a UTF-8-only tool (§5.5).
- **The 20 Hz tick is the app's heartbeat.** Every scrub step sets
  `timeChanged`, and every `EOScheduledView` then redraws — the seven rings
  and the Earth view through Core Graphics `drawRect:`. Today's hold does
  this at 20 Hz, and so does the new one (§4.2 c).

### 5.3 Maintainability

- One table of units replaces fourteen ivars, seven counters and the
  `if (sender == …)` ladders; adding a unit or a body is one table row.
- The stepper is the only place that touches `ESWatchTime` for user
  actions, which is where a future maintainer looks first.
- The panel is one view with one owner; the old buttons were created in
  five places across `createClockWidgets` (interleaved with unrelated
  widgets) and re-placed in a fourth place.
- The help text describes the same panel as the web's, so the two apps'
  documentation can be kept true together.
- Cost: a new class boundary in a code base that has few, and the
  `EOClock` ↔ stepper ↔ view calls to keep straight (three methods each
  way). Keep the interfaces small and one-directional (view → stepper →
  clock).

### 5.4 Testability

- In the VM: `clang -fsyntax-only -x objective-c++ -fno-objc-arc` passes
  on Foundation-only files (verified 2026-09-25 with the Command Line Tools'
  macOS SDK); UIKit files cannot be checked here. A host harness like the
  topocentric back-port's can drive esastro's search functions and compare
  them with the web engine's gold values (§8.1–8.2).
- On the device: no test target exists; the checklist in §8.3 is the test
  plan.

### 5.5 Localization

Eight languages (`de en es fr it ja nl zh-Hans`), UTF-16 LE, English keys
with translator comments. `NSLocalizedString` returns the **key** when a
language's table lacks it, so untranslated strings show in English rather
than breaking — acceptable for a first build, not for release.

Reused as they are (already translated everywhere): `"cent" "year" "mon"
"day" "hour" "min" "phase"` for the chips — the row's own abbreviations,
sized for 45-unit buttons in every language ("Jhd.", "Mo.", "世紀"…), so
the iOS chips read `cent year mon day hour min / sec rise set transit phase`
rather than the web's `yr mo …`; `"Set" "Done"` (the "Reset" title retires
with the old row — §9 decision 3); the nine body
names.

New keys (English key = English text; comment for translators):

| Key | Comment |
|---|---|
| `sec` | short abbreviation for second (time unit chip) |
| `rise` | chip: the rising of a body (sunrise, moonrise) |
| `set` | chip: the setting of a body, as in sunset — **not** the verb (the existing `"Set"` key is the verb; keys are case-sensitive, translations differ) |
| `transit` | chip: a body crossing the meridian |
| `Step by` | caption above the unit chips |
| `Set date & time` | caption above the date fields |
| `1 %@` | the pair's label for a calendar unit, e.g. "1 day" (%@ is the unit abbreviation) |
| `%d %@/s` | scrub rate, e.g. "20 day/s" (%d is the rate, %@ the unit) |
| `Sunrise`, `Sunset`, `Moonrise`, `Moonset` | the pair's label for the Sun and Moon |
| `%@ rise`, `%@ set`, `%@ transit` | the pair's label for a planet, e.g. "Jupiter rise" |
| `Moon phase` | the pair's label for the phase chip |
| `Stopped`, `real time` | status line ("1× (real time)" is built around the glyphs) |
| `Now` | the return-to-present button, in the transport and beside Set/Done (§9 decision 3) |
| `CE`, `BCE` | era toggle |
| `AT LIMIT` | strip suffix: the time is clamped at the end of the supported range (§4.2 m) |
| `Help Text2`, `Help Text3` | **rewritten** English (the row, the latch and "Tap 'Reset'" are gone); all seven translations become stale until redone |

About twenty keys times eight files; the App Store copy (`iTC
description4`) is the maintainer's own (§9 decision 10). The `printLocalizedStrings` block in
`OrreryAppDelegate.mm` (a `#if PRINTLOCALIZEDSTRINGS` developer tool)
carries the English defaults of the help texts and should be updated with
them.

### 5.6 Risks and unknowns

- **Latch accidents**: with the app's own rule any release off the button
  latches, so a sloppy lift can start a hands-free scrub; the padlock warns
  before the lift, one tap stops it, and a lift before the hold has engaged
  (§4.2 e) never latches.
- **The Mac**: does a mouse button released outside the window deliver
  `TouchUpOutside`? If it delivers a cancel instead, that release stops
  rather than latches — the only Mac-specific difference, and harmless.
- **The portrait reorient quirk** (§5.2) can put the panel 77 units off
  on first try; the `dateLabel` precedent shows the fix.
- **Keyboard avoidance** is new to the app; a wrong frame calculation
  under the split/floating iPad keyboards is the likely first bug.
- **`prevPlanettransit`** returns the *next* transit today (§6.7): without
  the fix, "transit ◀" moves forward.
- **Redraw cost** during a scrub is today's; no new risk, and the per-tick
  cadence is one line to change if an older iPad stutters.
- **Existing users'** muscle memory: the two-tap unit change and "any tap
  stops a latched scrub" are the two things support mail would mention.

## 6. Exactly what changes, and where

### 6.1 Observatory — new files

- `Classes/EOTimeStepper.h`, `Classes/EOTimeStepper.mm` (§5.1). Interface
  sketch, in the app's style: `-initWithWatchTime:env:clock:`; `unit` /
  `body` properties (persisted); `-stepUnit:direction:`,
  `-astroJump:direction:` (returns `bool`), `-setEra:year:month:day:hour:minute:`,
  `-now`, `-stop`, `-play`, `-playReverse`; `-startScrub:direction:`,
  `-scrubTick` (called from `EOClock tick`), `-stopScrub`, `-lockScrub`;
  `-isScrubbing`, `-isLocked`; `-statusString`; `-bodyPlanetNumber`
  (stored, else the dials' planet).
- `Classes/EOTimeControllerView.h`, `Classes/EOTimeControllerView.mm`
  (§5.1): `-initWithStepper:` builds the widgets at canvas size 308 × 389
  (433 with the body row) and installs the drag recogniser; `-refresh` once
  per tick (labels, fields, transport row rebuilt only when its state
  changes, chip highlight); `-endScrubForClose` used by every close path;
  `-clampToCanvas` after a drag or a reorientation.
- Both added to the Observatory target in `Observatory.xcodeproj` (Xcode
  does this on "Add Files…"; no other project change).

### 6.2 Observatory — `Classes/EOClock.h` and `Classes/EOClock.mm`

Remove:

- EOClock.h:130–145 the fourteen unit-button ivars (`yearBut … minuteButB`),
  including the never-created `wdayBut` / `wdayButB`; :157–164 the seven
  step counters (and `wkdStep`); :165 `resetBool` (never set true).
- EOClock.mm:430–431 `lastButtonPress` / `timeChanged` globals stay
  (`timeChanged` is still the redraw signal; `lastButtonPress` goes with
  `doJumps`).
- :433–486 `doJumps`: the unit branches (:437–472) go; the strip update
  (:473–484) moves to a new `-updateTimeStrip` called from `tick`.
- :675–730 the fourteen unit branches of `buttonActionDn:`; :946–959 the
  seven of `buttonActionUp:`.
- :879–936 the `resetBut` branch becomes "toggle the panel" (title
  Set/Done, `setMode`, `demoBut.hidden` in debug builds, `setStatusBar:`,
  strip visibility) — `resetToLocal` and `resetTargets` move to the
  stepper's `-now`.
- :1494–1543 the `adv*ButtonOffsetX` / `back*ButtonOffsetX` constants and
  their assignments (`advButtonWidth` / `Height` stay: `resetBut` and
  `demoBut` use them).
- :1911–1912, :1919–1920, :1950–1953, :2187–2190, :2194–2195 the button
  creation sites.
- :2245–2258 the fourteen reorient lines.
- :2537–2544 (all but `demoBut`'s at :2541) and :2556–2562 the fourteen `release`s (`resetBut`'s at :2545 stays).

Add:

- Members: `EOTimeStepper *stepper; EOTimeControllerView *timePanel;
  UIButton *nowBut;` and per-orientation anchor constants (`tcPanelX`,
  `tcPanelY`) in `initializeConstantsForOrientation:` (:1513), next to
  `resetX / resetY`.
- In `init` (:279) or `createClockWidgets` (:1869): create the stepper with
  `time`, `env` and `self`; create the panel (hidden) and `nowBut` (hidden;
  `createButtonAtX:` beside Set/Done, action → `[stepper now]`);
  add the display-press recogniser to `view`.
- In `tick` (:632): `[stepper scrubTick]` where `doJumps` was called;
  `[self updateTimeStrip]` while the strip is visible; `[timePanel refresh]`
  while the panel is open.
- `-updateTimeStrip`: today's text plus `[stepper statusString]`; the
  "AT LIMIT" suffix. `-updateNowButton`, from `tick`: `nowBut.hidden =
  time->isCorrect()`, and Set/Done slides over so the two are centred as a
  pair while Now shows (`placeSetAndNowButtonsForOrientation:`).
- `-timeStripVisible` (`setMode || !time->isCorrect()`), used by
  `setStatusBar:` (:274 — `setMode` → strip visible) and by
  `MainViewController` (§6.4).
- `-timeDidChange` (`timeChanged = true`) and `-transportDidChange`
  (`[self resetTargets]`) for the stepper.
- `goingToBackground` (:622): `[stepper stopScrub]`. `prepareToReorient`
  (:2451): the same. `moveClockWidgetsForOrientation:` (:2212): reorient
  `nowBut`, and `timePanel` to its dragged position clamped to the new
  canvas (the corner anchor only until the first drag).
- `dealloc` (:2531): release the two new objects.

### 6.3 Observatory — `Classes/EOScheduledView.mm` (reverse running)

`tick:` (:75–80) schedules the next update as `floor((now+update)/update)
* update + updateOffset` and fires when `now > target`; `resetTarget`
(:87–90) sets `target = floor(now/update) * update`. With a negative warp
`now` decreases and neither condition is ever met again: the display would
freeze while the clock ran backward. Direction-aware form: when
`[EOClock theClock].time->runningBackward()`, fire when `now < target` and
set `target = ceil((now-update)/update) * update - updateOffset` (and
`ceil(now/update) * update` in `resetTarget`). The rest of the display
already handles reverse: `ESWatchTime::isDSTUsingEnv` nudges the sample
the right way, and `setupLocalEnvironmentForThreadFromActionButton` passes
`runningBackward()` into the cache pool so "next sunrise" means the
previous one on the way back, as the rings expect. Reverse running is in (§9
decision 7).

### 6.4 Observatory — `MainViewController`, `OrreryAppDelegate`, `FlipsideViewController`

- `MainViewController.mm`:49 and :72 (`dateLabel.hidden = !setMode`) use
  the new `timeStripVisible`. Add `-keyCommands` (Escape only; no `t` toggle, §9 decision 10)
  with `canBecomeFirstResponder`; the handler asks `EOClock` to stop a
  hands-free scrub, else resign a first-responder date field, else close
  the panel — only while `presentedViewController == nil`.
- `OrreryAppDelegate.mm`:38–51 `setupDefaults`: register `EOTimeStepUnit`
  (`@"day"`) and `EOTimeStepBody` (`@-1`). `printLocalizedStrings` (:177–):
  the English defaults of "Help Text2/3".
- `FlipsideViewController.mm`: no code change — the help view concatenates
  the "Help Text*" keys (:165–174), so the rewritten strings appear by
  themselves.

### 6.5 Observatory — strings and help

- All eight `*.lproj/Localizable.strings` (UTF-16 LE): the §5.5 keys;
  rewritten "Help Text2" ("Tap 'Set' to open the time controller. Choose
  what a step means — a year, month, day, hour, minute or second, or the
  rise, set or transit of a body, or the Moon's quarter phase — then tap
  ◀ or ▶ to step…") and "Help Text3" ("Hold ◀ or ▶ to scrub… slide your
  finger off the button before lifting it to keep scrubbing hands-free; tap
  anywhere to stop. Tap 'Now' to return to the present.").
- `iTC description4` (App Store copy) is the maintainer's own (§9 decision
  10).

### 6.6 Observatory — resources

None required. The padlock is the SF Symbol `lock.fill`; the chips are
drawn `UIButton`s; `iFasterW.png` and its siblings in `Resources/` are
unused by the current code and stay unused.

### 6.7 esastro (and Chronometer): `prevPlanettransit`

`esastro/src/ESAstronomy.cpp`:2972 —

```cpp
ESTimeInterval
ESAstronomyManager::prevPlanettransit(int planetNumber) {
    return nextPrevPlanettransit(planetNumber, true/*nextNotPrev*/);
}
```

The argument should be `false`. Today the only callers are the
`watchTimeWithPrev{Planetrise,Planetset}` fallbacks (:5494, :5512 — used
when a body has no rise or set that day), where the wrong direction is
hard to see; the new "transit ◀" chip would call it directly and move
forward. Chronometer's parallel implementation has the identical slip
(`ios-backports/Chronometer/Classes/ECAstronomy.m`:2803 —
`nextNotPrev:true`); per the "duplicated code is the norm" rule both get
the one-character fix, each as its own small commit with its own message.
The web port is unaffected: its `findNextTransit` carries the direction
itself. The harness in §8.1 is the proof (before: "previous" == "next";
after: the gold table's ◀ column).

### 6.8 chronometer-web

Nothing in code. When this plan is committed, a row in
[docs/ios-backports.md](../docs/ios-backports.md)'s planned back-ports
table pointing here, and — separately from this back-port — the web's own
UTC-component calendar stepping (§2.3) is worth a look.

## 7. Steps, in shippable increments

Each step builds and runs on its own; the maintainer can stop after any of
them and still have a coherent app.

1. **Model + panel with the calendar units and the pair** (`EOTimeStepper`,
   `EOTimeControllerView` with the chips, the pair, tap and hold at
   300 ms / one unit per tick (20 a second), release stops; the fade; the drag; the strip's
   status text; the Set/Done toggle). The old row goes in the same step —
   the two cannot coexist in `setMode`. Feature parity with today minus
   phase and the latch. Persist the unit.
2. **Astro chips and the body row** (+ the esastro fix, §6.7, and its
   Chronometer twin). Persist the body. The flash on a NaN result.
3. **Transport and Now** (`‖`, `▶`, `Now ▶`; the Now button beside Set/Done;
   strip visible while overridden with the panel closed).
4. **Reverse** (`◀`, `EOScheduledView` direction awareness).
5. **Hands-free**: the latch (any release off the button after the hold has
   engaged), the padlock and lock-zone feedback, the shield, the stops
   (Escape, background, rotation).
6. **Date fields** with the CE/BCE toggle, keyboard avoidance.
7. **Close rules and keys**: the display-press recogniser, Escape, every
   close path ending a scrub first.
8. **Strings and help** (§6.5), translations arranged.
9. **Device pass** (§8.3) and tuning of the three knobs: hold delay, scrub
   rate, fade level (§9 decision 8).

## 8. Validation

### 8.1 In the VM (what a session can do)

- `clang -fsyntax-only -x objective-c++ -fno-objc-arc` on
  `EOTimeStepper.mm` with the estime/esastro include paths (Foundation
  resolves against the Command Line Tools SDK here; UIKit does not, so
  `EOTimeControllerView.mm` and the `EOClock.mm` edits get a careful read
  instead).
- A host harness in the topocentric back-port's mould: compile the real
  `ESAstronomy.cpp` and its tables, stand up an `ESAstronomyManager` with a
  fixed location and a frozen `ESWatchTime`, and replay §8.2 through
  `next/prevPlanetriseForPlanetNumber`, `next/prevPlanetsetForPlanetNumber`,
  `next/prevPlanettransit` and `next/prevMoonPhase`, before and after the
  §6.7 fix. Feasibility of instantiating the manager outside the app is to
  be confirmed at implementation time; if it cannot be done, the device
  pass compares against the web Inspector's readouts at the same instants.
- The calendar steps need no harness: they are the `advanceBy*` calls the
  app makes today.

### 8.2 Gold values for the device pass

Computed 2026-09-25 with the web engine (`computeAstroTarget`; the engine
is JPL-Horizons-verified, [docs/astronomy.md](../docs/astronomy.md)). The
app shows local time; these are UTC. Set the location manually in Options
(Use Location Services off).

**San Francisco, 37.7749 N 122.4194 W, from 2026-09-25 20:00:00 UTC**
(13:00 PDT):

| body | event | ▶ next | ◀ previous |
|---|---|---|---|
| Sun | rise | 2026-09-26 14:01:06 | 2026-09-25 14:00:15 |
| Sun | set | 2026-09-26 02:01:38 | 2026-09-25 02:03:11 |
| Sun | transit | 2026-09-25 20:01:15 | 2026-09-24 20:01:35 |
| Moon | rise | 2026-09-26 01:28:47 | 2026-09-25 01:04:39 |
| Moon | set | 2026-09-26 14:00:57 | 2026-09-25 12:55:18 |
| Moon | transit | 2026-09-26 07:39:33 | 2026-09-25 06:55:07 |
| Moon | phase | 2026-09-26 16:49:18 | 2026-09-18 20:44:11 |
| Jupiter | rise | 2026-09-26 10:20:31 | 2026-09-25 10:23:31 |
| Jupiter | set | 2026-09-26 00:09:23 | 2026-09-25 00:12:46 |
| Jupiter | transit | 2026-09-26 17:13:19 | 2026-09-25 17:16:30 |
| Saturn | rise | 2026-09-26 02:28:20 | 2026-09-25 02:32:27 |
| Saturn | set | 2026-09-26 14:45:56 | 2026-09-25 14:50:14 |
| Saturn | transit | 2026-09-26 08:37:09 | 2026-09-25 08:41:22 |
| Neptune | rise | 2026-09-26 02:00:48 | 2026-09-25 02:04:47 |
| Neptune | set | 2026-09-26 14:03:52 | 2026-09-25 14:07:56 |
| Neptune | transit | 2026-09-26 08:02:20 | 2026-09-25 08:06:22 |

**Longyearbyen, 78.22 N 15.63 E, from 2026-11-20 12:00:00 UTC** (polar
night): Sun rise and set — no event either way (the button flashes); Sun
transit ▶ 2026-11-21 10:43:20, ◀ 2026-11-20 10:43:06; Moon rise ▶
2026-11-21 10:07:29, ◀ 2026-11-20 11:47:34; Moon set ▶ 2026-11-21
04:35:54, ◀ 2026-11-20 01:13:03; Moon transit ▶ 2026-11-20 19:20:22, ◀
2026-11-19 18:35:47.

Agreement to within a few seconds is expected (the two engines share the
refinement but not every constant; the eclipse back-ports saw sub-2 s
agreement on contact times).

**Calendar steps** (iOS semantics, §2.3), Pacific time: Jan 31 12:00 +1
month → Feb 28 12:00; Feb 29 2024 12:00 +1 year → Feb 28 2025 12:00; Oct 31
2026 12:00 PDT +1 day → Nov 1 12:00 PST (25 h later); 1582 Oct 4 12:00 +1
day → 1582 Oct 15 12:00 (the hybrid switchover; the strip's date must agree
with the year label — §4.2 i); 4000 BCE Jan 1 −1 day → stays, "AT LIMIT".

### 8.3 Device checklist (the maintainer's)

1. Set opens the panel at the corner in both orientations, after a
   rotation with it open, and after a window resize on the Mac; a drag
   from a caption moves it and a drag that starts on a button does not; the
   dragged position survives close/open and rotation but not a relaunch;
   Done / × close it; the status bar hides while the strip shows.
2. Chips: one selected; the pair's label names it; the default is a day;
   the choice survives a relaunch.
3. Tap ◀ / ▶ for each calendar unit: one step, the strip updates within a
   tick, the clock is stopped, no fade.
4. Hold: nothing extra for 300 ms, then twenty steps a second (one per tick), the panel at
   the fade level; release on the button stops; release anywhere off the
   button locks with the padlock; drag off the button and back on shows
   and hides the padlock; a lift off the button within the first 300 ms is
   just a tap; a tap anywhere stops a locked scrub and does nothing else (a
   tap on the altitude dial while locked must **not** cycle the planet).
5. A slide off the screen's edge: whether it arrives as ended (latches) or
   cancelled (stops); on the Mac, a mouse button released outside the
   window.
6. Locked scrub + Home (background) → stopped on return; locked scrub +
   rotation → stopped.
7. Astro chips against §8.2, both directions, for the Sun, Moon and a
   planet; the body row follows the dials' planet until stepped; phase
   hides the row; Longyearbyen's Sun flashes.
8. Transport: ‖ stops; ▶ runs at 1× from the set time (hands and rings
   move, rise/set hands re-arm); ◀ runs backward with everything moving
   (§6.3); Now returns to the present with the panel open.
9. Date fields: typed values apply on end of editing; a BCE date; a date
   before 1582-10-15 (Julian: the strip and the year label agree); values
   beyond the limits clamp; the software keyboard does not cover the
   fields; the fields do not overwrite while being edited with the clock
   running.
10. Close on a display press: the press still reaches what it hit; presses
    on the panel, Set and the strip do not close it.
11. Escape on a hardware keyboard: stops a locked scrub first, then blurs a
    field, then closes; does nothing while Options or an alert is up.
12. Help (Options screen) reads correctly in English and shows English
    fallbacks in a language without the new strings.
13. The alarm still rings at real time while the display time is set.
14. Debug build: Demo appears with the panel.

## 9. Decisions (the maintainer, 2026-10-03)

The web decided each of these for itself; the iOS app is the maintainer's,
and some of them traded the web's choice against an existing iOS habit. His
answers, now folded into the sections above:

1. **Century: keep it** — an eleventh chip; the first row is six wide
   (`cent year mon day hour min`), the panel 308 units wide (§4.1, §4.2 j).
2. **The latch: as the app works today** — any release off the button
   keeps the scrub running, not only a release at the display's edge
   (§4.2 d–e). Two consequences accepted with it: any tap stops a latched
   scrub, and there is only ever one scrub (§4.2 e).
3. **"Now"** for the return-to-present button, in the transport row and
   beside Set/Done (on the strip at first; moved after the simulator pass,
   §13); the "Reset" title retires (§5.5).
4. **Do not persist the set time** — every launch starts at the present
   (§4.1).
5. **Lower right, then draggable** — opens at the web's corner; a pan moves
   it for the rest of the run (§4.2 j).
6. **Date entry: the five fields plus CE/BCE** (§4.1, §4.2 k), not a
   `UIDatePicker`.
7. **Reverse running: yes** — `◀` in the transport, `EOScheduledView` made
   direction-aware (§6.3).
8. **The knobs: the web's values** — 300 ms hold delay and 0.38 fade. The
   web's ten units a second was adopted too and **revised 2026-10-03** after
   the simulator pass: iOS draws each scrub position as a jump, with no
   motion between ticks, so ten a second only looked choppier than the old
   twenty; the scrub moves one unit per clock tick, twenty a second, as the
   old row did (§4.2 c). The web's 8-point edge distance has no role under
   decision 2.
9. **No ARC** — the new files use manual retain/release like the rest
   (§5.2).
10. **No hotkey** — the `t` toggle is dropped; Escape stays only as one of
    the panel's close paths (§4.2 n — strike it too if "no hotkey" meant
    every key). The App Store description is the maintainer's own.

## 10. Workflow and report format

- **The plan**: committed in chronometer-web (`92d4d92`) and reviewed by
  the maintainer; his decisions are in §9 and applied throughout
  (2026-10-03).
- **The code**: per [docs/ios-backports.md](../docs/ios-backports.md), a
  session works in `ios-backports/Observatory/` (and `esastro/`,
  `Chronometer/` for §6.7) after `git pull --ff-only` freshens each clone —
  which will fast-forward, since every earlier back-port is upstream now —
  never commits, and reports the diff with a suggested commit message per
  repo. Because the repository has a maintainer of its own, the outbound
  half changes shape: the work should reach GitHub as a **pull request**
  from Steve's fork or branch (pushed from outside the VM through the
  `transfer` bare repos as before), not as a push to `main`, so the
  maintainer merges what he has reviewed. Alternatively the maintainer
  builds it himself from this plan; the plan is written to be usable either
  way.
- **Increments**: §7's steps are separable commits; steps 1–3 are the
  minimum that makes sense to ship together (the row is gone after step 1).
- **The report** for each increment: the diff, what was syntax-checked and
  harness-verified in the VM, what was not (everything UIKit, everything
  on-device), and the §8.3 items it enables.

## 11. Implementation record — step 1 (2026-10-03)

Landed in `ios-backports/Observatory/` (working tree left dirty for the
maintainer's PR; nothing committed), on top of `881f9c9`:

- **New** `Classes/EOTimeStepper.h/.mm` (the model, Foundation-only: it
  reaches the clock through an `EOTimeStepperClient` protocol —
  `timeDidChange` / `transportDidChange` — rather than importing the clock's
  UIKit-bearing header) and `Classes/EOTimeControllerView.h/.mm` (the panel:
  top row with `Now ▶` and `×`, status line, STEP BY caption, seven chips —
  `cent year mon day hour min` and `sec` alone on the second row until the
  astro chips arrive in step 2 — the 56-unit ◀ ▶ pair with its label, the
  scrub fade at 0.38, and the drag). Both registered in
  `Observatory.xcodeproj` by hand (four file references, two build files,
  the Classes group, the Sources phase; `plutil -lint` passes).
- **`EOClock.h/.mm`**: the fourteen button ivars, seven step counters,
  `resetBool`, `doJumps`, `lastButtonPress`, the button creation sites, the
  reorient lines, the releases and the row's layout constants are gone;
  `setMode` now means "the panel is open"; the strip (`dateLabel`) is
  visible while the panel is open **or** the time is not the present
  (`timeStripVisible`, used by `setStatusBar:` and both
  `dateLabel.hidden` sites) and carries the status line; `tick` drives the
  scrub and refreshes the panel; `openTimePanel` / `closeTimePanel` replace
  the Set/Reset branch (the eclipse demo's location/time-zone restore moved
  to the close); `goingToBackground` and `prepareToReorient` end a scrub;
  `moveClockWidgetsForOrientation:` places the panel.
- `MainViewController.mm`: the `viewDidAppear` strip rule;
  `OrreryAppDelegate.mm`: `EOTimeStepUnit` registered (`day`).

Deviations from the step as written, all deliberate: the panel's **Now**
button is included (without it a step-1 build would have no way back to
the present once "Done" stopped resetting the time), and so is the
"strip visible while overridden" rule (a closed panel with a set time
would otherwise show nothing). The **strings files are untouched** (step
8): the new keys (`sec`, `Step by`, `1 %@`, `%d %@/s`, `Stopped`,
`real time`, `Now`) fall back to their English keys everywhere; `Set` and
`Done` are existing keys. New code uses four-space indentation like the
maintainer's recent additions; edits inside the old files keep their tab
style.

**Verified in the VM** (Command Line Tools 27.0, clang 21; no Xcode, no iOS
SDK): `EOTimeStepper.mm` passes `clang -fsyntax-only -x objective-c++
-fno-objc-arc -DES_IOS=1` against the plain macOS SDK with no UIKit in
sight; `EOTimeControllerView.mm`, `EOClock.mm`, `MainViewController.mm`
and `OrreryAppDelegate.mm` pass the same check against the macOS SDK's
Mac Catalyst UIKit headers (`-target arm64-apple-ios18.0-macabi`, the
`System/iOSSupport` framework and include paths, plus `-D__FP__` to keep a
macOS-only Carbon header's `pi` from colliding with `Constants.h`'s macro —
a harness artefact the iOS build never sees). The only diagnostics are the
files' pre-existing deprecation warnings; none mention the new code.
**Not verifiable here**: the Xcode build itself, the nib and scaling
interplay, touch tracking, and everything in §8.3 — the maintainer's
device pass is the gate, items 1–4, 6, 8 (Now only) and 14 applying to
this step.

Suggested commit message (Observatory):

```
Replace the Set-mode stepper buttons with the time controller panel (step 1)

A panel at the lower right of the display (draggable from its captions)
replaces the row of fourteen unit buttons: choose a unit chip (century,
year, month, day, hour, minute, second), then tap ◀ ▶ to step or hold to
scrub at twenty units a second; Now returns to the present.  EOTimeStepper is
the model (the same ESWatchTime jumps as before, Foundation-only),
EOTimeControllerView the UIKit panel.  The date strip along the top now
shows whenever the time is not the present and reports the clock's state.
The step unit persists as EOTimeStepUnit.  The astro chips, the body row,
the running transport, the latch, the date fields and the help text follow
in later steps; new strings fall back to English until the translations
are done.

Design: chronometer-web planning/2026-09-25-ios-backport-observatory-time-controller.md
```

**Revision after the simulator pass (2026-10-03).** The scrub rate is back
to the old row's: one unit per clock tick, twenty a second
(`EOTimeStepper scrubTick` steps on every call; the stepper takes the
clock's `ticksPerSecond` for the status line, now a `%d %@/s` format). The
web's ten a second had been adopted with decision 8, but it rides on the
web's animation between ticks, which iOS does not have, so it only halved
the frame rate of the jumps. The 300 ms hold delay and the 0.38 fade stand.

## 12. Implementation record — step 2 (2026-10-03)

On the same branch, after step 1 and the scrub-rate revision; the trees are
left dirty for the maintainer's PR (Observatory), for Steve's esastro branch, and
— Chronometer having a new owner of its own as of 2026-10-03, with the
repository's future undecided — uncommitted in the Chronometer clone until
that is settled:

- **Observatory.** `EOTimeStepper`: four event units (`rise set transit
  phase`, keys the web's) after the calendar units; the body for rise /
  set / transit as `EOTimeStepBody` (−1 = follow the dials, read through a
  new `dialPlanetNumber` client call that returns `altHand.planet`) and
  the ‹ › cycle through the nine bodies in the web's order;
  `astroJumpInDirection:` stops the clock first — the library's `prev*`
  searches read their direction from the watch — and runs
  `next/prevPlanetriseForPlanetNumber`, `next/prevPlanetsetForPlanetNumber`,
  `next/prevPlanettransit` and `next/prevMoonPhase` inside the manager's
  environment bracket, as the old phase buttons did; `pressInDirection:`
  now answers whether the search found an event and arms no hold for an
  event unit. The planet-generic rise/set search serves the Sun and Moon
  too: the library's own `nextSunrise` calls it with `ECPlanetSun`, so one
  code path covers all nine bodies. `EOTimeControllerView`: eleven chips
  in two rows (the second row's five share its width), the four event
  chips tinted; the ‹ Body › row (44-unit buttons, the name from
  `Utilities nameOfPlanetWithNumber:`) laid out only for rise / set /
  transit, the panel growing and shrinking from its bottom edge; the
  pressed pair button turns brown for 0.3 s when a search finds nothing.
  `OrreryAppDelegate`: `EOTimeStepBody` registered as −1. Strings still
  fall back to English (step 8): `rise`, `set`, `transit`, `Sunrise`,
  `Sunset`, `Moonrise`, `Moonset`, `%@ rise`, `%@ set`, `%@ transit`,
  `Moon phase`; `phase` is an existing key.
- **esastro** `src/ESAstronomy.cpp`:2973 and **Chronometer**
  `Classes/ECAstronomy.m`:2804: `prevPlanettransit` asks for the previous
  transit (§6.7). One word each; both clones were already current with
  GitHub.

**Verified in the VM.** The compile checks of step 1, all clean (the
stepper still Foundation-only; the esastro file as host C++). And the §8.1
harness exists: [2026-10-03-ios-astro-harness/](2026-10-03-ios-astro-harness/)
builds the real esastro, estime, eslocation and esutil sources for this Mac
(the time service on its plain system-clock driver, the NTP maker stubbed)
and replays the §8.2 instants through exactly the calls the stepper makes.
With the fix, every Sun, Moon, transit and phase value agrees with the web
gold table **to the second**; the planet rise and set values agree within
2–7 s (Jupiter and Saturn 5–7 s, Neptune 2 s — the "few seconds" §8.2
allows: the two engines share the refinement but not every convention);
Longyearbyen's Sun returns no rise and no set, as the table says. Built
from the pre-fix `ESAstronomy.cpp`, every "previous transit" equals the
"next transit" — the bug exactly as §6.7 describes.

**Not verifiable here**: the Xcode build, the body row's layout change and
the flash on a real screen, and §8.3 item 7.

Suggested commit messages:

Observatory —

```
Add the astronomical events and the body row to the time controller (step 2)

Four more chips — rise, set, transit, phase — jump to the next or previous
event instead of stepping a calendar unit: the rising, setting or meridian
crossing of a chosen body (Sun, Moon, Mercury, Venus, Mars, Jupiter,
Saturn, Uranus, Neptune), or the Moon's quarter phase.  A ‹ Body › row
appears for rise, set and transit; it follows the planet on the altitude
and azimuth dials until stepped, and the choice persists as EOTimeStepBody.
The searches are the astronomy library's own (nextPlanetriseForPlanetNumber
and friends, nextMoonPhase as before), run with the clock stopped; a
search that finds nothing (a polar night) flashes the button.  Event chips
are tap-only.  Needs esastro's prevPlanettransit fix.

Design: chronometer-web planning/2026-09-25-ios-backport-observatory-time-controller.md
```

esastro —

```
Make prevPlanettransit return the previous transit

It passed nextNotPrev=true, the same as nextPlanettransit, so "previous"
was the next transit.  Only the watchTimeWithPrevPlanetrise/set fallbacks
(a body with no rise or set that day) reached it before; Observatory's
time controller now calls it directly.  Checked against the web engine
with a host harness: previous transits now precede the instant and agree
with the web's to the second.
```

Chronometer —

```
Make prevPlanettransit: return the previous transit

The Objective-C twin of esastro's fix: it passed nextNotPrev:true like
nextPlanettransit:, so "previous" was the next transit.  Only the
watchTimeWithPrevPlanetrise:/set: fallbacks reached it.
```

## 13. Implementation record — step 3 (2026-10-03)

On the same branch, after the step-2 commit (3216f5e); Observatory only.
Committed as c6cd924 with the Now button on the strip; the revision below
is a follow-up, left in the clone for its own commit:

- **`EOTimeStepper`**: the transport — `stop` (`time->stop()`), `play`
  (`setWarp(1.0)`; not `start()`, which resumes at whatever speed preceded
  the freeze), `now` as before; each ends any press and reports
  `transportDidChange`. `isRunning` and `isAtPresent` for the views.
- **`EOTimeControllerView`**: the top row is the transport — `Now ▶` while
  the time is not the present, then `‖` (the web's `.tp-btn.active` look)
  while the clock runs or `▶` while it is stopped (`◀` joins it in step 4)
  — the buttons present sharing the width left of the ×, as the web's
  `flex: 1` cells do, and acting on the press. The row is laid out again
  only when that set changes (`layoutTransportRow`, from `refresh`), and a
  button hidden by the press that landed on it has its highlight cleared.
- **`EOClock`**: `nowBut`, a `Now ▶` to the right of the Set/Done button,
  the same size and plain look, made with `createButtonAtX:`;
  `buttonActionDn:` → `[stepper now]`. It shows while the time is not the
  present, whatever moved it there (the controller, or the eclipse demo):
  `updateNowButton`, from `tick`, sets `hidden` from `isCorrect()` on
  change and then places the two buttons
  (`placeSetAndNowButtonsForOrientation:`, which
  `moveClockWidgetsForOrientation:` calls as well): Set/Done alone at
  `resetX`; while Now shows, the pair centred there, 8 units apart. The
  strip is untouched beyond step 1's `timeStripVisible` rule.
- Strings: `Now` is the key the panel has used since step 1 (English until
  step 8).

**Revision after the simulator pass (2026-10-03).** The button was first
placed at the strip's right end, with a thin border: in portrait the
strip's text (the offset, the location) ran under it, and the border
matched no other button (Set is plain text). It now sits beside Set/Done,
plain, as Steve proposed, with the same visibility rule, and the strip is
text only again; a `setTimeStripHidden:` that had tied the button to the
strip's hiding (and `MainViewController`'s use of it) went with the move.
Second pass, the same day: while Now shows, the two buttons are centred
where Set/Done sits alone, so the layout keeps its symmetry; Set slides
over as Now appears and back as it goes.

**Verified in the VM.** The Catalyst syntax check of `EOClock.mm`,
`EOTimeControllerView.mm` and `MainViewController.mm`, and the
Foundation-only check of `EOTimeStepper.mm`: clean, no new warnings. The
transitions walked against `ESWatchTime.cpp`: `setWarp(1)` from a freeze
re-incorporates the skew, so ▶ resumes from the frozen instant;
`resetToLocal` makes `isCorrect()` true, so with the panel closed the strip
hides through `transportDidChange` the moment Now is pressed and the status
bar returns; the button goes at the next tick.

**Not verifiable here**: the Now button's fit beside Set/Done on a real
screen in both orientations; the row rebuilt under a finger.

**Device checklist** (with §8.3 item 8): `‖` freezes mid-second; `▶`
resumes from that instant at 1× (the status line "1×", hands and rings
moving again); the panel's `Now ▶` returns to the present and leaves the
panel open (the strip turns white; the Now beside Set hides); Set, a step,
Done: the strip stays and `Now ▶` sits beside Set, the pair centred where
Set was; press it: strip gone, status bar back, button gone, Set back in
the middle; rotate while overridden: the pair stays centred; the eclipse
demo (debug builds) brings it up too.

Suggested commit message for the follow-up (or fold it into c6cd924 with
`git commit --amend` before the branch is published further — it has been
pushed to the transfer repository, so an amend means a force-push there):

```
Move the time controller's Now button from the strip to beside Set/Done

On the simulator the strip's text ran under the button in portrait, and its
border matched no other button.  It is now a plain button to the right of
Set/Done, the same size, shown while the time is not the present, the two
centred as a pair where Set/Done sits alone; the strip is text only again,
and the code that hid the button with the strip goes.
```

## 14. Implementation record — step 4 (2026-10-03)

On the same branch, after 8cf8211 (the Now-button move); Observatory only,
left in the clone for Steve's commit:

- **`EOScheduledView`**: `tick:` and `resetTarget` are direction-aware
  (§6.3). Running backward, `now` decreases, so a view fires when
  `now < target` and re-arms at `ceil((now − update) / update) · update −
  updateOffset`, the mirror image of the forward form; `resetTarget` sets
  the boundary just ahead (`ceil(now / update) · update`) so the next tick
  updates, as the forward form's `floor` does. The period and the stagger
  (`updateOffset`) are preserved; the first interval after a reset can run
  to two periods, as it can forward (the existing form's quirk, mirrored,
  not fixed). Stopped, the forward form applies and never fires, as
  before; `forceIt` (a step, a jump) is unchanged.
- **`EOHandView`**: the one-second re-sync sweep after a reset targets
  where the hand will be a second *earlier* while the clock runs backward
  (`tim->runningBackward()`), so the hands sweep counter-clockwise into a
  backward run rather than lurching forward first.
- **`EOTimeStepper`**: `playReverse` = `setWarp(−1)` + `transportDidChange`;
  `statusString` already said "1× ◀".
- **`EOTimeControllerView`**: `◀` beside `▶` while the clock is stopped
  (`Now ▶ ◀ ▶` sharing the row), acting on the press like the others.
- Not changed, checked: the Sun ring draws ±12 h around `now` through a
  frozen temporary watch (direction-free); the map and the planet
  positions are functions of the instant; the Sun hands'
  `sunSpecial24HourIndicatorAngleForAltitudeKind` and the library's
  `next*` family already switch meaning with `runningBackward()`
  (Chronometer runs backward); the alarm compares system time, not the
  displayed time; the stepper's own searches run with the clock stopped
  (§12). One latent catch for the maintainer, not reached today:
  `EOMoonAgeView` (commented out since before this work) walks *earlier*
  new moons with `nextQuarterAngle(0, t, false)`, and that three-argument
  search inverts `nextNotPrev` while the watch runs backward — revived as
  is, it would loop forever in a backward run.

**Verified in the VM.** Compile checks of the four touched Objective-C++
files, clean. The scheduling arithmetic by hand for `update` 60 / offset
29.5 and `update` 1 / offset 0: the period is preserved in both directions,
and a direction change self-heals even without `resetTargets` (a forward
target lies ahead, so `now < target` fires at once going back, and the
reverse).

**Not verifiable here**: the backward sweep's look (Core Animation
interpolates the rotation; a one-second sweep of a few degrees is
unambiguous), a backward DST crossing (the DST indicator's lookups are
absolute — `ESCalendar_nextDSTChangeAfterTimeInterval` — so it is direction-free;
the hour hands across the change are the library's `isDSTUsingEnv` nudge),
the date labels rolling back at midnight.

**Device checklist** (§8.3 item 8, ◀): from a set time, ◀: the second
hands sweep counter-clockwise after the one-second re-sync, the minute and
hour hands follow, the status line reads "1× ◀", the strip's offset moves
accordingly; the rings, the map's terminator, the planets and the Moon move
backward at their own cadences (the ring every few minutes); ‖ freezes; ▶
runs forward from there; ◀, then ‖, then a step: the clock stays frozen on
the stepped time; Now returns to the present; cross local midnight
backward (the big date and the weekday roll back) and a DST change
backward.

Suggested commit message:

```
Run the clock backward from the time controller (step 4)

◀ in the transport runs the clock at real speed in reverse (setWarp(-1)),
with ▶ beside it while the clock is stopped.  The scheduled views re-arm
by direction: running backward they update at the period boundary before
now rather than the one after, and the hands' one-second re-sync sweep
targets a second earlier, so everything moves backward at its usual
cadence.  The astronomy searches already follow the watch's direction.

Design: chronometer-web planning/2026-09-25-ios-backport-observatory-time-controller.md
```

## 15. Implementation record — step 5 (2026-10-03)

On the same branch, after e101a82 (step 4); Observatory only, left in the
clone for Steve's commit:

- **`EOTimeStepper`**: a fourth scrub state, `EOTimeScrubLocked`
  (hands-free); `lockScrub` moves Held to it and `isLocked` reads it, while
  `isScrubbing`, `scrubTick`, `statusString` and `endPress` treat the two
  running states alike — so every existing stop (`endPress` from the
  background, a rotation, the panel closing) stops a locked scrub too, and
  `transportDidChange` follows as before.
- **`EOTimeControllerView`**: the pair's touches are classed by UIControl:
  `TouchUpInside` and `TouchCancel` end the scrub; `TouchUpOutside` after
  the hold has engaged locks it (before that, a sloppy tap: one step, no
  latch); `TouchDragExit` / `TouchDragEnter` track whether the held finger
  is off the button. The padlock (SF Symbol `lock.fill`, #4cd964, 96 units,
  an image view over the whole panel that takes no touches) shows at 0.75
  over the panel at full alpha while a lift would lock, and at 0.4 over
  the panel faded to 0.38 once it has — the web's levels, multiplying as
  they do there. The fade now reads "scrubbing and not in the lock zone".
- **`EOClock`**: `shieldBut`, a transparent 1200-unit button created and
  reoriented beside `snoozeBut` (sized past the canvas because
  `reorientSubView:`'s portrait quirk shifts a zero offset by 77 units),
  shown above everything from `tick` while the stepper is locked; its
  `TouchDown` ends the scrub and does nothing else. `escapeKeyPressed`
  stops a running scrub; its "else close the panel" is step 7's.
- **`MainViewController`**: `canBecomeFirstResponder`,
  `becomeFirstResponder` on appear, `keyCommands` with Escape only (§9
  decision 10), acting only while nothing is presented.

**Verified in the VM.** Compile checks of the four touched Objective-C++
files: clean, the pre-existing deprecations only. The state walk: Pending
→ Held at 300 ms; Held + a lift inside → Idle; Held + a lift outside →
Locked; Locked + any press → the shield's `TouchDown` → Idle, the shield
hidden at once; Escape / background / rotation / close → Idle; a lift
outside while Pending → Idle with the one step taken.

**Not verifiable here**: where UIKit's inside/outside boundary lies for a
tracked button (a tolerance beyond the bounds is reported, about 70
points; it decides both where the padlock appears and where a lift locks,
so the two agree by construction); whether a finger leaving the screen's
edge arrives as a lift or a cancel (§4.2 e); the padlock's look at 0.15
effective over the display; Escape reaching the view controller when
nothing else holds first-responder status.

**Device checklist** (§8.3 items 4–5 and 11): hold ▶, slide off, lift: the
scrub runs on, the padlock dim over the faded panel; tap the display: it
stops and nothing else happens (the dials keep their planet, no panel
button acts); hold, slide off: the panel at full alpha with the bright
padlock; slide back: faded, no padlock; lift on the button: stop; a
slide-off-and-lift under 300 ms: one step; lock, then Escape: stop, the
panel open; lock, then rotate / Home: stopped on return; lock, then Done:
covered — one tap stops, the next is Done.

Suggested commit message:

```
Scrub hands-free from the time controller (step 5)

Lift the finger off a held ◀ or ▶ and the scrub runs on until the next
press anywhere, as the old row's latched buttons did; a lift on the button
stops it as before, and a slide-off within the first 300 ms is just a tap.
A green padlock over the panel shows the outcome before it happens and
stays, dimmer, while the scrub runs hands-free.  A transparent shield over
the display turns the next press into the stop and swallows it; Escape,
the background and a rotation stop it too.

Design: chronometer-web planning/2026-09-25-ios-backport-observatory-time-controller.md
```

## 16. Implementation record — step 6 (2026-10-03)

On the same branch, after 74f64cc (step 5); Observatory only, left in the
clone for Steve's commit:

- **`EOTimeStepper`**: `dateComponents:` (the displayed time in the
  clock's zone, through `ESCalendar_localDateComponentsFromTimeInterval`);
  `setEra:year:month:day:hour:minute:` composes `{era, year, month, day,
  hour, minute, 0}` through
  `ESCalendar_timeIntervalFromLocalDateComponents(env->estz(), …)` — the
  hybrid calendar at the zone's offset for that instant, so no two-pass —
  clamps to `[ESMinimumSupportedAstroDate, ESMaximumSupportedAstroDate]`,
  freezes the clock there and reports `timeDidChange`; it answers false
  when it clamped. `isAtLimit` for the strip. The fields' values are
  clamped to their own ranges first (year 1–9999, month 1–12, day 1–31,
  hour 0–23, minute 0–59); the calendar normalises the rest (Feb 30 →
  Mar 1).
- **`EOTimeControllerView`**: the web's two rows under the pair, captioned
  SET DATE & TIME: year / month / day, then CE·BCE / hour / minute — five
  `UITextField`s (number pad, dark keyboard, monospaced digits, the web's
  colours; digits only and length-limited through the delegate; the whole
  value selected on begin editing) and the era button (BCE in red, the
  web's `.active`). A value applies when its field ends editing — Return,
  a touch elsewhere on the panel, another field, Escape, the panel
  closing; the era applies at once; an apply with any field empty is
  skipped (the web's rule) and the next refresh refills it. Every tick the
  fields follow the time except the one being edited; the era button
  always follows. Keyboard avoidance: `UIKeyboardWillChangeFrameNotification`
  → the keyboard's end frame converted into the canvas → the panel lifts
  by the overlap plus 8 units, no further than the canvas's top, animated
  with the keyboard; the lift is zero again once the frame lies below the
  screen. The panel grows by two 44-unit rows, the caption and gaps.
- **`EOClock`**: Escape, when no scrub runs, ends a date field's edit (the
  value applies); its "else close the panel" is still step 7's. The strip
  appends "AT LIMIT" while the time sits at the range's end.
- Strings (English until step 8): `Set date & time`, `CE`, `BCE`,
  `AT LIMIT` (added to §5.5).

**Verified in the VM.** Compile checks: clean. A calendar probe
([2026-10-03-ios-astro-harness/calprobe.mm](2026-10-03-ios-astro-harness/calprobe.mm),
linked against the harness's estime objects, San Francisco's zone)
composes typed values exactly as the stepper does and reads them back as
the fields would: 2026-10-03 12:00 → 19:00:00 UTC exactly; 1582 Oct 4 and
Oct 15 at noon lie 86 400 s apart, and a day step from Oct 4 lands on Oct
15 (the §8.2 gold); a typed date inside the gap (Oct 10) reads as Julian
and shows as Oct 20 — deterministic, no failure; 44 BCE Mar 15 round-trips
with era 0, year 44; 4000 BCE Jan 1 00:00 local is inside the range (the
limit is 00:00 UTC), 4001 BCE clamps to it and reads 4001-12-31 16:07:02
BCE local, AT LIMIT; 2800 Dec 31 23:59 Pacific lies beyond the UTC limit,
so it clamps to Dec 31 2800 16:00 PST, AT LIMIT — in a western zone the
typeable range ends that afternoon; Feb 30 2024 → Mar 1; 2026 Mar 8 02:30
(the spring-forward gap) → 03:30 PDT; 2026 Nov 1 01:30 (ambiguous) → the
first, PDT. One library observation off the panel's path:
`ESCalendar_UTCDateComponentsFromTimeInterval` gave minute 59 with
seconds 60.000 for two exact-minute PDT instants (the instants and the
local decomposition the fields use are exact).

**Not verifiable here**: the number pad's layout and its dismiss key on
iPad; the lift under the split and floating keyboards (§5.6 named this
the likely first bug); the selection on begin editing; the look of the
two rows.

**Device checklist** (§8.3 item 9): type a year and tap elsewhere: the
time jumps, frozen, and the strip agrees; Return applies too; a BCE date
(toggle, then a year); 1582-10-04, then day ▶: Oct 15, the year label
agreeing; 2801, or 4001 BCE: clamped, "AT LIMIT" on the strip; with the
software keyboard: the panel lifts clear and comes back; Done while
editing: applies and closes; Escape while editing: applies, the panel
stays.

Suggested commit message:

```
Type a date and time in the time controller (step 6)

Two rows of fields under the pair — year, month, day; CE/BCE, hour,
minute — show the displayed time and apply a typed value when the field
ends editing, through the hybrid calendar in the clock's zone (Julian
before 1582-10-15, BCE through the era toggle), clamped to the range the
astronomy supports; the strip says AT LIMIT at either end.  The panel
lifts clear of the software keyboard while a field is edited.

Design: chronometer-web planning/2026-09-25-ios-backport-observatory-time-controller.md
```

## 17. Implementation record — step 7 (2026-10-03)

On the same branch, after 1f14905 (step 6); Observatory only, left in the
clone for Steve's commit:

- **`EOClock`**: `displayPress`, a `UILongPressGestureRecognizer` of zero
  duration on the base view (§4.1), so it fires on the touch itself; it
  recognises alongside every other recogniser and cancels no touches, so
  the press goes on to do what it landed on — the dials cycle their
  planet, the map opens the maintainer's location picker. Its delegate
  (`gestureRecognizer:shouldReceiveTouch:`) says what the display is: not
  the panel and its subviews, not Set/Done, Now, Demo or the NTP corner,
  not the strip (which takes no touches itself, so the touch's location
  is tested against its frame), and not the two full-canvas overlays —
  the alarm's snooze and the hands-free shield, whose press is a stop and
  nothing else. Closed, the recogniser receives nothing. Escape now runs
  the full ladder: stop a scrub, else end a field's edit, else close the
  panel; `MainViewController` already yields the key to anything
  presented.
- Every close path — ×, Done, a press on the display, Escape — goes
  through `closeTimePanel`, whose first act is `prepareToHide`: the
  pending edit applies, any scrub ends (held or hands-free), the keyboard
  goes. Closing does not change the time (§4.2 n).

**Verified in the VM.** Compile checks: clean. The paths walked: a press
on a dial with the panel open closes it and the dial still cycles (no
cancelled touch); a tap on the map closes it and the picker still opens
(simultaneous recognition keeps the tap recogniser alive); a press on the
shield stops the scrub and leaves the panel open; a press on Set/Done or
Now does its own thing only; Escape with a locked scrub stops it, a second
Escape ends an edit if one is open, a third closes the panel.

**Not verifiable here**: that the zero-duration long press begins on a
touch landing on a UIControl. UIKit's rule since iOS 6 lets a control's
default action pre-empt only the recognisers that overlap it — a single
tap on a button, switch, stepper, segmented or page control, a swipe on a
slider's knob, a pan on a switch's knob — and a long press is outside
that list, so a dial tap should both cycle and close; the device pass
confirms it, along with the touch-down timing against the picker's tap.

**Device checklist** (§8.3 item 10): with the panel open, tap the
altitude dial: the panel closes and the planet changes; tap the map: the
panel closes and the picker opens; tap Set/Done: closes, nothing else;
tap Now beside it: back to the present, the panel stays; tap the strip:
nothing; while a hands-free scrub runs, tap the display: the scrub stops,
the panel stays; press Escape three times from a locked scrub with an
edit open: stop, apply, close.

Suggested commit message:

```
Close the time controller from the display and from Escape (step 7)

A press anywhere on the display closes the panel and still does what it
landed on (a dial tap cycles its planet, a map tap opens the location
picker); presses on the controller's own chrome — Set/Done, Now, the
strip — leave it open, and a press on the hands-free shield only stops
the scrub.  Escape stops a scrub, else ends a date field's edit, else
closes the panel.  Every close path ends a scrub and applies a pending
edit first.

Design: chronometer-web planning/2026-09-25-ios-backport-observatory-time-controller.md
```

## 18. Implementation record — step 8 (2026-10-03)

On the same branch, after 949d412 (step 7); Observatory only, left in the
clone for Steve's commit:

- **All eight `Localizable.strings`** (UTF-16 LE with a BOM, as before:
  converted to UTF-8 for the edit and back, the round trip proven
  byte-identical on all eight before anything changed). The controller's
  22 keys are appended in the maintainer's `"key" = "value";` style, each
  with the translator comment its `NSLocalizedString` call carries in the
  code — generated from the three source files, genstrings-style, so the
  two cannot drift: `%@ rise`, `%@ set`, `%@ transit`, `%d %@/s`, `1 %@`,
  `AT LIMIT`, `BCE`, `CE`, `Moon phase`, `Moonrise`, `Moonset`, `Now`,
  `real time`, `rise`, `sec`, `set`, `Set date & time`, `Step by`,
  `Stopped`, `Sunrise`, `Sunset`, `transit`. In the seven other languages
  the values are translations drafted by the session, under a header
  comment marking them for a native speaker's review; the chip words keep
  the register and length of the existing abbreviations (German Aufg. /
  Unterg. / Transit / Sek., Japanese 出 / 入り / 南中 / 秒, …) and the era
  toggle follows each language's convention (v. Chr. / n. Chr., av. J.-C.
  / ap. J.-C., 紀元前 / 西暦, 公元前 / 公元, …). The reused
  keys (`cent year mon day hour min phase`, `Set`, `Done`, the body names)
  are present in every file.
- **Help Text2 / Help Text3** rewritten in English — the old texts
  described the row, its blue and red units, the latch and 'Reset'. Text2:
  Set opens the controller, what a step means, ◀ ▶, typed dates, the
  transport. Text3: hold to scrub, the hands-free slide-off with the
  padlock, a tap anywhere to stop, Now, Done or the display to close.
  The seven other languages carry translations of the new paragraphs,
  drafted by the session (German, Spanish, French, Italian, Japanese,
  Dutch, Simplified Chinese) and marked "review pending" in their
  comments; each quotes the button titles that file already uses (German
  'Einst.' and 'Fertig', French 'Régler' and 'Fini', Italian 'Imposta' and
  'Fine', …) with the new Now title beside them. The old translated
  paragraphs, which described the removed row, remain in git history. `OrreryAppDelegate.mm`'s `PRINTLOCALIZEDSTRINGS`
  defaults carry the same two texts.
- Left alone, as pre-existing: three keys the code uses that the files
  never carried (the 2023 store notice, `WARNING`, and in Dutch the zodiac
  list) — the generator found them and they were taken back out; `Reset`
  stays in the files, unused; `iTC description4` is the maintainer's (§9
  decision 10).

**Verified in the VM.** `plutil -lint` passes on all eight files; every
key the controller's code uses is present in every language; each file
gained exactly 22 keys (en 120 → 142; nl 108 → 130, its earlier gaps as
they were). The translation pass changed 24 values per file and
re-linted clean; the only values equal to their key are the format strings
and French sec / transit, Italian and Dutch sec — the same word in those
languages.

**Not verifiable here**: the chips' fit with the longer translations of
the reused and the new chip words on a real screen (they were sized for the old
45-unit buttons; the chips are the same width), and the help page's
layout with the new paragraph lengths.

**Device checklist**: in German or Japanese the chips read Jhd. Jahr Mo.
Tag Stunde min / Sek. Aufg. Unterg. Transit Phase (世紀 年 月 日 時間 分 /
秒 出 入り 南中 月相), the panel's captions, labels and era toggle read in
that language, the help's two time-controller paragraphs describe the
panel in it, and nothing shows a raw key; a native speaker's pass over the
seven blocks before release.

Suggested commit message:

```
Add the time controller's strings and rewrite its help (step 8)

Twenty-two new keys in all eight Localizable.strings, with the translator
comments from the code.  Help Text2 and Help Text3 now describe the
controller — what a step means, hold to scrub, hands-free with the
padlock, Now, Done — in place of the old row.  The seven other languages
carry machine-drafted translations of the new keys and paragraphs, marked
in their comments as pending a native speaker's review; each quotes the
button titles its file already uses.  The PRINTLOCALIZEDSTRINGS defaults
match the English.
```
