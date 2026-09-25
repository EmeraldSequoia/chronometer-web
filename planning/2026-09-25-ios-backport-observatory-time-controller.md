# iOS back-port: the time controller, for Emerald Observatory (iPad)

**Status**: proposed 2026-09-25 — a plan for the Observatory maintainer to
review on GitHub before anything is built. Nothing is implemented and no
repository was touched: the iOS sources below were read from fresh,
read-only clones of the GitHub `main` branches. Emerald Chronometer (iOS)
is explicitly **out of scope** — its hand-dragging and tappable date
windows cover the same ground differently.

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
  instead of revealing a row of buttons; the panel's × (or the same button,
  now reading "Done") closes it. The strip along the top still appears
  whenever the time is not the present, panel or no panel, and gains a
  **Now** button of its own, so a set time can be *kept* with the panel
  closed — today's Reset both returns to now and leaves set mode; the two
  come apart.
- **Choose, then step**: tap a unit chip once (year, month, day, hour,
  minute, second — or rise, set, transit, phase), then tap ◀ or ▶ as often
  as needed. The label between the pair always names what a tap will do
  ("1 day", "Sunset", "Jupiter transit").
- **Hold to scrub** at ten units a second (today: twenty, after 0.75 s;
  the web's 300 ms engagement and 10/s rate are proposed, tunable). The
  panel fades to about a third while the scrub runs so the display shows
  through.
- **Hands-free scrubbing** keeps the old app's latch, narrowed the way the
  web did it: slide the finger off the button *and off the edge of the
  screen* before lifting and the scrub runs on until the next tap anywhere;
  a green padlock on the panel shows when letting go would do that. Today
  any release outside the button latches (§9 decision 2).
- **New abilities**: a seconds unit; rise, set and transit for nine bodies
  (Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune),
  defaulting to the planet on the altitude/azimuth dials; a typed date and
  time with a CE/BCE toggle; a transport row that stops the clock and
  restarts it at 1× from the set time, forward (and, optionally, backward,
  §6.3); a status line ("Stopped", "10 day/s ▶", "1× (real time)").
- **Century** is not a web unit (§9 decision 1 — keep it as an eleventh
  chip or let year-scrubbing at 10/s cover it).
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
  nothing; the panel (264×389 canvas units, 433 with the body row) covers
  the lower-right of the display — the Equation of Time subdial and part of
  the main dial's evening side — whenever it is open. The scrub fade and the
  close-on-display-press rule mitigate this; §9 decision 5 is about where it
  should sit, and a draggable panel is an optional extra (§4.2 j).
- **Two taps instead of one** when the unit changes: today "+1 month, +2
  days, −1 hour" is four taps; with unit chips it is seven. Repeated steps
  of *one* unit cost the same as today.
- **Steps snap** (no sweep). That is today's behaviour too; the web's hands
  glide because of an animation system iOS does not have (§4.3).
- **A narrower latch** than today's, if decision 2 follows the web.
- **Century** goes, if decision 1 follows the web.
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
| Time bar (`#time-bar`: date, offset, rate, Now) | The existing `dateLabel` strip along the top, plus a small `UIButton` ("Now" or the existing "Reset" string, §9 decision 3) at its right end | Shown while the panel is open **or** the time is not real; the status bar hides while it shows, as it does in set mode today. |
| `⏱ Show / Hide time controller` | The existing Set button (`resetBut`): "Set" when closed, "Done" (existing key) when open | Same place, same size, same `createButtonAtX:` plumbing. |
| Transport row (`Now ▶`, `‖`, `◀ ▶`, 44 px) and `×` | Four `UIButton`s, 44 units tall, in the panel's top row; act on `TouchDown` | ‖ → `time->stop()`; ▶ → `time->setWarp(1)`; ◀ → `setWarp(-1)` (needs §6.3); Now → `resetToLocal()`; each followed by `resetTargets` + `timeChanged = true`. Explicit `setWarp(±1)` rather than `start()`: `start()` resumes at whatever the warp was before the freeze. |
| `#tp-rate-label` | `UILabel`, 11 pt, `#8af` | "Stopped" / "1× (real time)" / "1×" / "1× ◀" / "10 day/s ▶", from warp and scrub state (§4.2 h). |
| Unit chips (`.tp-chip`, 5 × 2 grid, 44 px, astro tint) | Ten (or eleven) `UIButton`s, 44 units, `layer` styled like the CSS; the selected one highlighted (`#8af` border and text) | Labels reuse the row's existing localized abbreviations (§5.5). `UISegmentedControl` was considered and rejected: its selection is per control, the astro tint and the two-row split fight it, and its height is not 44. |
| Body row (`‹ Name ›`) | Two 44-unit `UIButton`s and a `UILabel` (`#8af`, 15 pt); hidden unless rise / set / transit | Name from `[Utilities nameOfPlanetWithNumber:]` (already localized for all nine bodies). |
| The pair (`◀ ▶` 56 px, `#tp-step-label`) | Two 56-unit `UIButton`s with `TouchDown` / `TouchUpInside` / `TouchUpOutside` / `TouchCancel` / `TouchDragInside` / `TouchDragOutside` actions taking the `UIEvent`; a bold 15 pt `UILabel` | UIControl keeps tracking a touch wherever it goes, so the release reaches the button with its location, which is what the edge rule needs (§4.2 c–e). |
| Date inputs (`#tp-year … #tp-minute`, `#tp-bce`) | Five `UITextField`s (number pad, centred, 44 tall) and a CE/BCE `UIButton`; apply on end of editing / Return | Composed with `ESCalendar_timeIntervalFromLocalDateComponents(env->estz(), &cs)` — hybrid calendar, era in `cs.era`, the zone's offset at the target instant, so the web's two-pass composition is unnecessary. A `UIDatePicker` is the native-looking alternative and the reason not to use it is real: it is proleptic Gregorian (ten days off before 1582-10-15) and has no BCE, while the app's range is 4000 BCE – 2800 CE (§9 decision 6). |
| `.tp-hidden` (0.38), `.tp-lock-zone`, `.tp-locked`, `#tp-lock-badge` | `panel.alpha` animated over 0.15 s; a `UIImageView` with the SF Symbol `lock.fill` tinted `#4cd964`, 96 units, alpha 0.75 in the zone and 0.4 once locked | `alpha` keeps hit-testing (UIKit stops delivering touches only below 0.01), so a held button keeps tracking through the fade — the iOS form of the web's "opacity-only" rule: never `hidden`, never removed, mid-hold. SF Symbols are already used by the app (`info.circle`, MainViewController.mm:32). |
| The hands-free stop (document capture-phase `pointerdown` + click swallower) | A transparent full-canvas `UIButton` ("shield") added above everything while a scrub runs hands-free; its `TouchDown` stops the scrub and the touch goes nowhere else | The app's own idiom: `snoozeBut` (:2197) is exactly this for the alarm. No click swallower is needed — UIKit synthesises no click. |
| A press on the display closes the panel | A `UILongPressGestureRecognizer` (`minimumPressDuration 0`, `cancelsTouchesInView NO`) on the base view whose delegate ignores touches inside the panel, the Set button and the strip | Recognises at `touchesBegan`, so it acts on the press like the web, and the touch still reaches whatever it landed on (the altitude dial cycles its planet). |
| Escape (capture-phase, yields to overlays) | `-keyCommands` on `MainViewController` (`UIKeyInputEscape`; optionally `t`); acts only while nothing is presented (`presentedViewController == nil` — the Options screen and alerts own the key otherwise) | iPad hardware keyboards and the Mac. |
| `updater.reset()` after every transition | `resetTargets` (already what Reset does) after transport changes and Now; `timeChanged = true` after every step, jump or typed date so every `EOScheduledView` redraws at the next tick (≤ 50 ms), as `doJumps` does today | Not `resetTargets` on steps: `EOHandView.resetTarget` re-arms the one-second animated sweep, which is designed for a running clock (it computes the target for *now + 1 s*) and would lag a 10 Hz scrub. |
| `tu` / `tb` in `app-state` | `NSUserDefaults` keys `EOTimeStepUnit` (string, default `"day"`) and `EOTimeStepBody` (planet number, default −1 = follow the dials), registered in `setupDefaults` | The web also persists the panel's open state and the overridden time itself; iOS keeps its current behaviour (fresh launch = present, panel closed) unless the maintainer wants otherwise (§9 decision 4). |
| `RATE_OPTIONS` / `TICK_INTERVAL_MS` (10 Hz) | The existing 20 Hz `tick` drives the scrub: one unit whenever ≥ 100 ms have passed since the last scrub step | No second timer; no warp — a scrub is a sequence of the same `advanceBy*` jumps a tap makes, exactly like today's `doJumps`, so DST days, Feb 29 and month ends behave as they do now. |

### 4.2 Behaviour

The spec the code follows; where the web and today's iOS differ, the choice
is stated.

a. **Units.** `yr mo day hr min sec` step by `advanceByYears / Months /
   Days(env)` and `advanceBySeconds(3600 / 60 / 1)`; `rise set transit`
   search for the chosen body; `phase` searches the Moon's quarters
   (`nextMoonPhase` / `prevMoonPhase`, as today). The default unit is a
   day. (Century, if kept: `advanceByYears(±100)`, as today.)

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
   advances one unit every 100 ms until the scrub ends. (Today: 750 ms then
   20/s. Both numbers are one constant each; the web's are proposed for
   parity and can be tuned on the device.)

d. **Release.** `TouchUpInside`, or `TouchUpOutside` anywhere on the
   display: end the scrub — `time->stop()`, restore the panel, `resetTargets`
   (so the views re-arm their schedules from the stopped time), write the
   status line. `TouchCancel` (a system gesture, a rotation, a phone call):
   end the scrub — unknown state, stop.

e. **Hands-free** (the latch, narrowed): a `TouchUpOutside` whose location
   (`[[event touchesForView:button] anyObject] locationInView:nil`, in
   window points) is within 8 points of the window's edge, or beyond it,
   turns the scrub from *until release* into *until the next press*. While
   the held touch is in that zone (`TouchDragOutside` reports it) the panel
   returns to full alpha with the padlock at 0.75; drag back in and it fades
   again. Once locked, the padlock stays at 0.4 over the faded panel, the
   button's highlight clears, the shield goes up, and the next press
   anywhere — the shield's `TouchDown` — stops the scrub and is swallowed.
   The scrub also stops on Escape (the panel stays open), on
   `goingToBackground` (a suspended app must not run time away when it
   resumes; today's latched counters do exactly that), and on an
   orientation change (`prepareToReorient`). Whether an iPad delivers
   `touchesEnded` or `touchesCancelled` when a finger leaves the screen edge
   is the same open question the web pass had; a cancel whose last drag
   location was in the zone should lock too, and the device pass decides
   whether that rule is needed (§8.3).

f. **The fade** is the only fade: taps, transport presses, Now, chips and
   the date fields leave the panel at full alpha (the two stories). The
   fade's level, 0.38, is the web's tuned value; the maintainer sets the
   final one on a real display.

g. **Transport.** `Now ▶` appears whenever `!time->isCorrect()`; `‖` while
   `warp != 0`; `◀ ▶` (or `▶` alone, §6.3) while stopped. All act on
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

j. **Placement.** Anchored to the canvas's lower-right corner with a
   12-unit margin in both orientations, over the Equation of Time subdial (and, in landscape, the lower edge of the eclipse simulator) —
   the web's position and the least time-critical element to cover. The
   maintainer may prefer another anchor (§9 decision 5); a `UIPanGesture`
   on the panel's top row to let the user drag it is a cheap extra if the
   overlap turns out to matter. In canvas units the panel is 264 × 389
   (433 with the body row): on a 12.9" iPad (scale ≈ 1.33) that is about
   352 × 519 points with 59-point chips, on an 8.3" mini (scale ≈ 0.97)
   about 43-point chips.

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
   "AT LIMIT" (the unused existing strings "The earliest / latest time
   supported is" can carry it) and a scrub against the limit simply sits
   there, as on the web.

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
- The `t` and `n` hotkeys (Escape is one line; the rest is a taste call).
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
  frames in canvas units, the touch handling for the pair (hold timer, edge
  rule, drag feedback), the fade and padlock, the shield, the date fields
  and keyboard avoidance; it drives the stepper and reads it to refresh
  labels once per tick. It knows nothing about the astronomy.
- **`EOClock.h/.mm`** loses the fourteen button ivars, the seven step
  counters, `doJumps`' unit branches, twenty-eight `if` branches in the two
  button actions, seven creation sites, fourteen reorient lines and
  fourteen `release`s — about 150 lines — and gains the stepper and panel
  as members, their creation and reorientation, the strip's new content,
  the display-press recogniser, and the "strip visible" rule: about 80
  lines.
- **`EOScheduledView.mm`** gains direction awareness if reverse running is
  wanted (§6.3): a dozen lines.
- **`esastro`** gets a one-line fix (§6.7), mirrored in Chronometer's
  `ECAstronomy.m`.

Rough size: 250–350 lines for the stepper, 600–800 for the view, net
about −70 in `EOClock`. Nothing new is linked: Foundation, UIKit,
QuartzCore and the four Emerald libraries are already there.

### 5.2 Constraints of this code base

- **Manual retain/release.** No ARC anywhere (`[super dealloc]`,
  `autorelease`, `release` throughout; no `CLANG_ENABLE_OBJC_ARC` in the
  project). New files follow suit — or are marked `-fobjc-arc` per file in
  the target's Compile Sources, which the maintainer may prefer for new
  code; either is fine, mixing is supported, but the choice should be made
  once.
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
  as touches; the hands-free rule's "release outside the window" case is to
  be verified there (§8.3).
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
  this at 20 Hz; the proposed 10 Hz halves it.

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
the iOS chips read `year mon day hour min / sec rise set transit phase`
rather than the web's `yr mo …`; `"Set" "Reset" "Done"`; the nine body
names; the two "earliest / latest time supported" strings.

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
| `10 %@/s` | scrub rate, e.g. "10 day/s" |
| `Sunrise`, `Sunset`, `Moonrise`, `Moonset` | the pair's label for the Sun and Moon |
| `%@ rise`, `%@ set`, `%@ transit` | the pair's label for a planet, e.g. "Jupiter rise" |
| `Moon phase` | the pair's label for the phase chip |
| `Stopped`, `real time` | status line ("1× (real time)" is built around the glyphs) |
| `Now` | transport / strip button — or reuse `"Reset"` (§9 decision 3) |
| `CE`, `BCE` | era toggle |
| `Help Text2`, `Help Text3` | **rewritten** English (the row, the latch and "Tap 'Reset'" are gone); all seven translations become stale until redone |

About twenty keys times eight files; plus `iTC description4` if the App
Store copy is kept in sync. The `printLocalizedStrings` block in
`OrreryAppDelegate.mm` (a `#if PRINTLOCALIZEDSTRINGS` developer tool)
carries the English defaults of the help texts and should be updated with
them.

### 5.6 Risks and unknowns

- **UIControl touch tracking at the screen edge** (§4.2 e): ended vs
  cancelled, and the last reported location of a fast slide — decided on
  the device, as on the web.
- **The Mac**: does a mouse released outside the window deliver
  `TouchUpOutside` with an out-of-window location? If not, the Mac loses
  the hands-free gesture (the web's mouse rule) and nothing else.
- **The portrait reorient quirk** (§5.2) can put the panel 77 units off
  on first try; the `dateLabel` precedent shows the fix.
- **Keyboard avoidance** is new to the app; a wrong frame calculation
  under the split/floating iPad keyboards is the likely first bug.
- **`prevPlanettransit`** returns the *next* transit today (§6.7): without
  the fix, "transit ◀" moves forward.
- **Redraw cost** during a scrub is today's, halved; no new risk, but the
  10 Hz rate is a knob if an older iPad stutters.
- **Existing users'** muscle memory: the latch narrowing and the two-tap
  unit change are the two things support mail would mention.

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
  (§5.1): `-initWithStepper:` builds the widgets at canvas size 264 × 389
  (433 with the body row); `-refresh` once per tick (labels, fields,
  transport row rebuilt only when its state changes, chip highlight);
  `-endScrubForClose` used by every close path.
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
  `createButtonAtX:` at the strip's right end, action → `[stepper now]`);
  add the display-press recogniser to `view`.
- In `tick` (:632): `[stepper scrubTick]` where `doJumps` was called;
  `[self updateTimeStrip]` while the strip is visible; `[timePanel refresh]`
  while the panel is open.
- `-updateTimeStrip`: today's text plus `[stepper statusString]`; the
  "AT LIMIT" suffix; `nowBut.hidden = time->isCorrect()`.
- `-timeStripVisible` (`setMode || !time->isCorrect()`), used by
  `setStatusBar:` (:274 — `setMode` → strip visible) and by
  `MainViewController` (§6.4).
- `-timeDidChange` (`timeChanged = true`) and `-transportDidChange`
  (`[self resetTargets]`) for the stepper.
- `goingToBackground` (:622): `[stepper stopScrub]`. `prepareToReorient`
  (:2451): the same. `moveClockWidgetsForOrientation:` (:2212): reorient
  `timePanel` and `nowBut`.
- `dealloc` (:2531): release the two new objects.

### 6.3 Observatory — `Classes/EOScheduledView.mm` (only for reverse running)

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
previous one on the way back, as the rings expect. If the maintainer skips
reverse, the transport shows `▶` alone while stopped and this file is
untouched (§9 decision 7).

### 6.4 Observatory — `MainViewController`, `OrreryAppDelegate`, `FlipsideViewController`

- `MainViewController.mm`:49 and :72 (`dateLabel.hidden = !setMode`) use
  the new `timeStripVisible`. Add `-keyCommands` (Escape; optionally `t`)
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
  finger off the edge of the screen before lifting it to keep scrubbing
  hands-free; tap anywhere to stop. Tap 'Now' to return to the present.").
- `iTC description4` (App Store copy) is the maintainer's to update or not.

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
   300 ms / 10 per second, release stops; the fade; the strip's status
   text; the Set/Done toggle). The old row goes in the same step — the two
   cannot coexist in `setMode`. Feature parity with today minus phase,
   century (if dropped) and the latch. Persist the unit.
2. **Astro chips and the body row** (+ the esastro fix, §6.7, and its
   Chronometer twin). Persist the body. The flash on a NaN result.
3. **Transport and Now** (`‖`, `▶`, `Now ▶`; the strip's Now button; strip
   visible while overridden with the panel closed).
4. **Reverse** (`◀`, `EOScheduledView` direction awareness) — optional.
5. **Hands-free**: the edge rule, the padlock and lock-zone feedback, the
   shield, the stops (Escape, background, rotation).
6. **Date fields** with the CE/BCE toggle, keyboard avoidance.
7. **Close rules and keys**: the display-press recogniser, Escape (and
   `t`), every close path ending a scrub first.
8. **Strings and help** (§6.5), translations arranged.
9. **Device pass** (§8.3) and tuning of the four knobs: hold delay, scrub
   rate, edge distance, fade level.

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

1. Set opens the panel at the anchor in both orientations, after a
   rotation with it open, and after a window resize on the Mac; Done / ×
   close it; the status bar hides while the strip shows.
2. Chips: one selected; the pair's label names it; the default is a day;
   the choice survives a relaunch.
3. Tap ◀ / ▶ for each calendar unit: one step, the strip updates within a
   tick, the clock is stopped, no fade.
4. Hold: nothing extra for 300 ms, then ten steps a second, the panel at
   the fade level; release on the button stops; release off the button in
   the middle of the display stops; release at each edge (right, bottom,
   top, left) locks with the padlock; drag into the zone and back out shows
   and hides the padlock; a tap anywhere stops a locked scrub and does
   nothing else (a tap on the altitude dial while locked must **not** cycle
   the planet).
5. Whether an edge slide-off arrives as ended or cancelled (a cancel today
   stops); a fast slide's last reported position against the 8-point rule.
6. Locked scrub + Home (background) → stopped on return; locked scrub +
   rotation → stopped.
7. Astro chips against §8.2, both directions, for the Sun, Moon and a
   planet; the body row follows the dials' planet until stepped; phase
   hides the row; Longyearbyen's Sun flashes.
8. Transport: ‖ stops; ▶ runs at 1× from the set time (hands and rings
   move, rise/set hands re-arm); ◀ runs backward with everything moving
   (if §6.3 is in); Now returns to the present with the panel open.
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

## 9. Decisions for the maintainer

The web decided each of these for itself; the iOS app is the maintainer's,
and some of them trade the web's choice against an existing iOS habit.
Recommendations are marked.

1. **Century.** Drop it for exact parity (recommended — year scrubbing at
   ten a second covers a century in ten seconds), or keep it as an eleventh
   chip (a six-column first row, `cent year mon day hour min`, panel about
   308 units wide; the existing "cent" string).
2. **The latch rule.** The web's edge-only rule (recommended: narrow,
   accident-resistant, one help sentence, the padlock as feedback), or the
   app's documented any-release-outside latch (one predicate; existing
   users know it; more accidental locks, which the padlock and tap-to-stop
   now make visible and cheap).
3. **"Now" or "Reset"** for the return-to-present button. "Reset" is
   translated in all eight languages and is what the app has always
   called it; "Now" matches the web. Either is one key.
4. **Persist the set time across launches?** The web does (share links);
   the app never has. Recommended: keep the app's behaviour — a launch is
   the present.
5. **Where the panel sits.** Lower right (the web's position; covers the
   Equation of Time subdial; in landscape it also clips the eclipse
   simulator's lower edge). Alternatives: upper right under the header
   (covers the evening side of the rings, which stepping is often about);
   lower left (covers the azimuth dial); draggable.
6. **Date entry.** Five fields plus CE/BCE (recommended: the full range and
   the hybrid calendar), or a `UIDatePicker` (native look; proleptic
   Gregorian, no BCE — the range would have to be fenced to 1583–2800).
7. **Reverse running** (§6.3): include it (recommended: the model and the
   astronomy already support it; the display needs a dozen lines), or
   ship the transport with `▶` alone.
8. **Hold delay, scrub rate, edge distance, fade level.** The web's
   300 ms / 10 per second / 8 points / 0.38 as starting values; the app's
   750 ms / 20 per second are the incumbents.
9. **ARC for the new files** (per-file `-fobjc-arc`), or manual
   retain/release like the rest.
10. **The `t` hotkey and the App Store description** — small, the
    maintainer's call.

## 10. Workflow and report format

- **The plan**: Steve commits this file in chronometer-web; the maintainer
  reviews it on GitHub; the decisions in §9 come back as comments or edits.
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
