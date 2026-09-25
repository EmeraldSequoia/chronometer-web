# Plan: the time controller's two stories — fade only while scrubbing, Escape and a display press close it, hands-free scrubbing

**Status**: COMPLETE 2026-09-24 except the native pass (build 2.0.164;
records in §9, §10 and §11) — every step of §7 has landed and is
pane-verified on all three pages; step 7 (Steve's native pass) is the only
open item. Decisions in §8.
**Created**: 2026-09-24
**Baseline**: 4e967cc (`[Observatory] Add chevrons for changing planet on
alti/az subdials`, build 2.0.157).
**Related**: [2026-07-17-time-controller-scrub-invisibility.md](2026-07-17-time-controller-scrub-invisibility.md)
(the tap ghost this plan retires — its §4 "any actuating tap ghosts" rule is
superseded here), [2026-09-23-time-controller-redesign.md](2026-09-23-time-controller-redesign.md)
(the panel as it stands), [docs/time-controller.md](../docs/time-controller.md).
The native app's controller lives in the local, gitignored
`ios-backports/Chronometer/` tree (`Classes/ECControllerView.m`,
`ChronometerAppDelegate.m`) — referenced in §6.1.

## 1. Two stories, like location

Setting the location has two stories, and the app already treats them
differently without saying so:

| | Precise | Exploratory |
|---|---|---|
| **Location** | "I want to know about *this* place": the location dialog. Several taps (search, pick, Done); it overlays the display, which nobody minds because the display is not the point until the dialog closes. | "What changes as I move?": drag the map. Nothing overlays the display, because seeing the whole display *is* the point. |
| **Time** | "I want to know about *this* time": type a date — or, just as often, get there by steps: "in a few days", "at the next full moon", "at sunset". Several taps or clicks. | "What changes as time passes?": hold to scrub by hours or days. One continuous gesture. |

The two time stories make opposite demands on the panel:

- **Precise (stepping).** The user taps several times in a row and is aiming
  at a target each time. They do not care about the display until they are
  done, and they would rather the panel *not* disappear: a panel that fades
  after every tap moves the target out from under the next one. Feedback
  since the panel redesign: it was confusing that the controller "went away
  entirely" — the 2026-07-17 rule ghosts the panel to 25 % after *every*
  actuating tap (steps, astro jumps, transport, Now), and holds the ghost
  until the step animation settles, so a run of steps is a run of
  disappearances.
- **Exploratory (scrubbing).** One press, held. Nothing else is going to be
  tapped until the finger lifts, so there is no target to preserve — and the
  whole point is to watch the display move. The panel should get out of the
  way, and the finger ideally too (§6).

The map already resolves this for location by construction: the dialog
overlays, the drag does not. For time the two stories share one panel, so
the panel's *behaviour* has to make the distinction: **fade only while a
scrub is running; never on a tap.** Everything in §§2–3 follows from that
sentence; §§4–5 make the panel cheaper to put away when the precise story is
over; §6 lets the exploratory story run with the finger off the screen.

## 2. Fade only while scrubbing, not when stepping

Today ([time-controls-ui.ts](../src/shared/time-controls-ui.ts)): every
step, astro jump, transport press and Now calls `ghostTap()` → `.tp-ghost`
(25 %) for a 1 s dwell, extended for step taps until the app's animations
settle (`isSettled` probe, 200 ms poll, 4 s cap). A hold adds `.tp-hidden`
(also 25 %) at +300 ms and `endHold()` clears both. So a press is a two-stage
fade (ghost at 0 ms, "hidden" at 300 ms) and a tap is a one-second
disappearance.

After:

- **`ghostTap()` goes**, with its four call sites (`stepPress`,
  `handleAstroStep` success, `nowClicked`, the transport buttons), the
  `GHOST_*` constants, `ghostTimer`, `settledProbe`, and the `isSettled`
  config hook. Chronometer's explicit probe
  (`isSettled: () => !faces.some(…anyAnimating())`, engine-entry.ts:3099)
  goes with it; `updater.anyAnimating()` itself stays — the render loops use
  it. The "panel's return doubles as the change-landed signal" idea from
  the 2026-07-17 plan is given up deliberately: in the precise story the user
  is looking at the panel, not waiting on the display.
- **`.tp-hidden` stays as the one fade**, added in `startHold()` (at
  +300 ms, the first moment a press is known to be a scrub) and removed in
  `endHold()`. The 150 ms opacity transition stays. A tap never fades; a
  hold fades once, when it engages. (Keeping the class name avoids churn in
  the tests and docs; it is documented as "the scrub fade".)
- **Transport and Now do not fade either** (confirmed, §8). The rule is
  literal: only a running scrub. The 2026-07-17 reasoning for ghosting
  transport taps ("you want to see the moment 1× reverse starts") bought one
  second of visibility for a state that lasts minutes; with §§4–5 the honest
  answer — close the panel — is one key or one tap away.
- **The date-entry form** was never ghosted; unchanged.
- **Stale-fade guard** in `showPopover()` stays for `.tp-hidden` (belt and
  braces once §4 makes `hidePopover()` end a hold first).
- **CSS**: the `.tp-ghost` rule and its comment go; the `.tp-hidden` comment
  is rewritten (the opacity-only constraint stays load-bearing — the hold's
  release still arrives on the faded button).
- **Tests**: [time-controls-ghost.test.ts](../src/__tests__/time-controls-ghost.test.ts)
  is nine tests about the tap ghost and its dwell/settle/cap; six of them
  test behaviour that no longer exists. Fold what remains into
  [time-controls-units.test.ts](../src/__tests__/time-controls-units.test.ts)
  (which already asserts hold → `.tp-hidden` → release clears it) as: a
  hold fades after the delay and release restores; a tap on any chip /
  step / astro / transport / Now does **not** add a fade class; a
  force-close mid-hold leaves nothing stale. Delete the ghost test file.
- **Docs**: the "Hold-to-scrub is unchanged…" paragraph and the Files table
  in docs/time-controller.md; help.html's Hold paragraph (its "the panel
  fades so you can watch" sentence stays true — reword to say it fades
  *while held*); a superseded note at the top of the 2026-07-17 plan's
  status banner. docs/animation.md's `initTimeControls` contract table has
  no `isSettled` row (checked), so nothing to remove there.

## 3. Twice the opacity

`.tp-hidden` goes from **0.25 to 0.5**. History: 0.05 and 0.15 read as
fully invisible natively; 0.25 was tuned on the Chrome phone emulator and is
what the feedback calls "went away entirely". The panel's own background is
`rgba(26,26,46,.96)`, so at 0.5 the dial shows through at roughly half
strength — enough to watch a scrub, while the chips and the pair still read
as a panel. One CSS line; Steve's native pass sets the final value. The
hands-free state (§6) keeps the same level — its feedback is a flash, not a
different steady state (§6.4).

## 4. Escape closes the controller — last in the hierarchy

**Chronometer already does this.** Its Escape ladder
([engine-entry.ts:2817](../src/engine-entry.ts)) closes the topmost of:
confirm overlay → Terra/Gaia city dialog → help → location prompt → **time
popover** (rung 5, last). Nothing to add there beyond the mid-hold fix
below.

**The Observatory has no ladder.** Each overlay owns its own Escape
listener, and they differ in phase and in whether they stop the event:

| Overlay | Listener | Stops propagation? |
|---|---|---|
| Settings dialog (and its Forget confirm) | window, capture ([settings-dialog.ts:317](../src/shared/settings-dialog.ts)) | yes |
| Map Keep/Revert dialog | document, capture ([observatory-entry.ts:1366](../src/observatory/observatory-entry.ts)) | no (preventDefault only) |
| Location dialog | document, bubble ([location-dialog.ts:507](../src/shared/location-dialog.ts)) | yes, when dismissable |
| Help popover | document, bubble ([help-popover.ts:106](../src/shared/help-popover.ts)) | no |
| Share modal | document, bubble ([share-button.ts:78](../src/shared/share-button.ts)) | no |
| ⋮ menu | window, bubble ([overflow-menu.ts:208](../src/shared/overflow-menu.ts)) | no |
| Faux fullscreen | window, bubble ([fullscreen.ts:82](../src/shared/fullscreen.ts)) | no |

Because most of them close themselves on the same keydown *without*
stopping it, a bubble-phase "close the controller if nothing else is open"
listener would run after they have already closed and see nothing open —
and close the controller in the same keystroke. So the controller's rung
must decide on the **pre-close** state:

- A `window` **capture-phase** keydown listener, registered at init (so it
  precedes the dialogs' own capture listeners, which are added when they
  open). On Escape: if `escapeYields()` → return without touching the event
  (whoever is open handles it); else if a hands-free scrub is running (§6)
  → stop it and keep the panel (the next Escape closes); else if the
  popover is open → `hidePopover()` (which ends any hold), `preventDefault()`.
- If focus is in one of the panel's date inputs, Escape blurs the input and
  does not close; the next Escape closes. (The form has no cancel concept —
  the pending edit applies on `change`, as it would on clicking away.)
- **Where it lives**: the mechanics (capture phase, end-hold-first, the
  input rule) are the same on every page, the predicate is not. Add an
  optional `escapeYields?: () => boolean` to `TimeControlsConfig`; when
  supplied, `initTimeControls` installs the listener. The Observatory
  passes `isSettingsDialogOpen() || dragState !== 'idle' || location dialog
  visible || #info-overlay.visible || share modal present || ⋮ menu open ||
  body.is-fullscreen`. Two of those need a small accessor: the ⋮ menu keeps
  `open` private (export `isOverflowMenuOpen()`), and the share modal's
  backdrop is anonymous (give it an id, or export `isShareDialogOpen()`);
  `LocationDialogAPI` gets `isVisible()`. The Inspector passes the same
  predicate minus the map and fullscreen terms (it has no Escape for the
  popover today; parity is one line). Chronometer keeps its ladder and
  passes nothing.
- **Fullscreen first** (decided, §8). With the real Fullscreen API the
  browser consumes Escape to exit fullscreen before the page sees it; the
  faux mode's listener does the same, and the predicate's `is-fullscreen`
  term keeps the rung consistent with that: in fullscreen, Escape only
  leaves fullscreen; the next Escape closes the controller.
- **Mid-hold close (a latent bug, fixed on all close paths).**
  `hidePopover()` sets `display: none`; if that happens during a hold
  (Chronometer's rung 5 today; the ⋮ menu item; the `t` key) the pressed
  button stops hit-testing, its `mouseup` never arrives, and the scrub runs
  on with the panel gone — the exact failure the opacity-only comment warns
  about. `hidePopover()` calls `endHold()` first (which, after §6, also
  releases a hands-free scrub).

## 5. A press on the display closes it

The precedent is the ⋮ menu ([overflow-menu.ts:202](../src/shared/overflow-menu.ts)):
a document `pointerdown` that ignores presses inside the menu or its button
and otherwise closes the menu, **passing the press through** to whatever it
landed on. The dialogs are the other pattern — a backdrop that swallows the
press. The controller is a non-modal overlay with no backdrop, so it follows
the menu.

Two ways to say "outside":

- *Negative*: any press not inside `#time-popover`, `#time-bar` (its own
  toggle, rate label and Now), the ⋮ menu (its "Hide time controller" item
  would otherwise close the panel on `pointerdown` and re-open it on the
  `click` that follows), and every dialog and its backdrop — a list that
  grows with the chrome.
- *Positive* (**decided**, §8): a press on the **display itself** — the
  Observatory canvas — closes the panel. Presses on chrome (Settings, Set
  location, the corner buttons, the footer) leave it alone: the controller
  survives a visit to Settings, which is what the precise story wants, and
  no list needs maintaining.

Implementation: one canvas `pointerdown` listener in the Observatory entry
(next to the map-drag one), `if (timeUI?.isPopoverOpen()) timeUI.hidePopover()`.
The press passes through, so a map drag with the panel open both closes the
panel and starts the drag (the exploratory story in one gesture), and a tap
on a dial body both closes it and cycles the body. Persisted `tu` / `tb`
mean nothing is lost by a stray close; `t`, ⏱ or the ⋮ menu reopen it.

Consequences to accept: a stray tap on the display mid-story-1 closes the
panel (one tap to reopen); a press outside while a date input has focus
blurs it, applies the edit, then closes. While a hands-free scrub is running
(§6) the first press stops the scrub and is swallowed before it reaches the
canvas, so it does not also close the panel.

**Scope** (decided, §8): the Observatory first. The face pages and the
Inspector get the same rule as the **very last step**, after the native
pass on the Observatory: the face pages' display is their face canvases,
which have their own click semantics (engine-entry.ts:839 — check what a
face click does on all.html before wiring, since a navigation makes closing
moot), and the Inspector's is its main content area. The shared module needs
nothing new for either.

## 6. Hands-free scrubbing — the iOS behaviour, on purpose

### 6.1 What the native app does, and why the web cannot inherit it

In `ECControllerView.m`, `touchesEnded` hands the touch's end point to the
app delegate, which hit-tests it (`findClosestActivePartInWatch:toPoint:`)
to decide whether the pressed button gets its release; a scrub is a
repeating-part timer (`repeatingPartTimer`) that the release path cancels.
`touchesCancelled` reports a sentinel point (−10000, −10000). A finger that
slides off the display edge evidently never delivers an end that reaches
the timer cancel, so the rate stays set until the next touch, whose end does.
Unintended, but liked: the finger gets completely out of the way of the
display, and one tap stops it.

Browsers never lose the end of a touch: a finger leaving the screen edge
yields `pointerup` / `touchend` with the last on-screen coordinates (or, on
some platforms, `pointercancel`), and both of the web controller's paths
(`stepRelease`, `endHold`) stop the scrub — as does `mouseleave` for a mouse
that wanders off the button. So the web needs an explicit rule.

### 6.2 What it has to do

1. Start with no new control — the gesture *is* the feature.
2. Keep the panel out of the way (it is already faded).
3. Stop on one press anywhere, and that press must do nothing else: no map
   drag, no body cycle, no closing the panel.
4. Work with mouse and touch alike.
5. Be accident-resistant: an unintended lock runs time away at ten units a
   second, so a wobble must not lock; a missed lock costs only a repeat of
   the gesture.
6. **Keep the unusual behaviour's scope small** (Steve, §8): a scrub that
   outlives the finger is surprising the first time however it is entered,
   so it should be entered by as narrow a gesture as possible — the iOS one,
   and no wider.
7. **Say when it happens** (Steve, §8): the change from "on until release"
   to "on until the next press" needs feedback at the moment it happens.

### 6.3 Design: release at the display edge keeps scrubbing (option B)

The scrub changes from *on until release* to *on until the next press* when
the finger (or mouse) leaves the display while a scrub is running — the
native gesture, and only that. A release anywhere on the display, on the
button or off it, stops the scrub as it does today.

Mechanics:

- **Pointer Events with capture.** The pair moves from `mousedown` /
  `mouseup` / `mouseleave` + `touchstart` / `touchend` / `touchcancel` to
  `pointerdown` / `pointerup` / `pointercancel` with `setPointerCapture`
  (the map drag already does this, observatory-entry.ts:1318) and
  `touch-action: none` on the two step buttons (today `manipulation`;
  `none` stops the browser from turning a finger slide into a panel scroll
  — `#tp-panel` is `overflow-y: auto` at short viewports — which would
  arrive as `pointercancel`). Capture keeps every `pointermove` and the
  `pointerup` coming to the button wherever the pointer goes, including
  outside the browser window for a mouse. Boundary events are suppressed
  while captured, so **leaving the button no longer stops the scrub; the
  release does** — necessary, because the scrub must run without a break
  through the slide to the edge. (For a mouse this is the one visible
  change outside the gesture itself: slide off and release inside the
  window stops at the release rather than at the leave.)
- **The predicate**, evaluated on `pointerup` after the hold engaged: the
  release point is **outside the button's rect** (no slop — a lift on the
  button's own pixels is a stop, wherever on the button) **and at the
  display edge**: within `EDGE_PX` of any edge of the visual viewport
  (`visualViewport.offsetLeft/offsetTop/width/height`; `innerWidth` /
  `innerHeight` where it is absent — jsdom), or outside it entirely (a
  mouse released beyond the window; a touch whose last sample landed past
  the boundary). Both halves matter: the outside-the-button half is what
  lets `EDGE_PX` be generous without a normal lift ever qualifying — the
  Observatory's ▶ sits 12 px from the right edge, so with the button
  excluded the whole gap can count as "edge". Start `EDGE_PX` at 8; the
  device pass tunes it (a fast slide's last sample can land several px
  short of the edge).
- **Which edges.** The Observatory panel is 12 px from the right edge and
  sits above the footer band (or in it, when CC2 dropped the bands), so the
  short slides are ▶ rightwards off the edge, and either button downwards
  across the footer and off the bottom. The face pages' panel is at the
  viewport's bottom-right; the Inspector's 8 px in. Outside fullscreen,
  Safari's bottom toolbar occupies the bottom edge; a touch that started in
  the page is still tracked across it and the release reports a point at or
  past the page's boundary, which the predicate accepts (to verify on the
  device — §7).
- **Mouse.** With capture, the `pointerup` of a drag that leaves the browser
  window still arrives, with client coordinates outside the viewport. So
  the mouse gesture is *drag off the browser window and release*; the
  window stands in for the display. (Requiring the physical screen boundary
  via `screenX` / `screenY` would be stricter but is unreliable across
  multiple displays; not proposed.)
- **`pointercancel` / `lostpointercapture`** after the hold engaged:
  **stop** (unknown state). The device pass decides whether an iOS slide
  off the display edge arrives as `pointerup` at the edge (→ lock, as
  designed) or as `pointercancel`; if the latter, a cancel whose last
  `pointermove` sample was at the edge locks too (the last sample is kept
  for this).
- **Locked state.** Rate and direction stay set; `.tp-hidden` stays; the
  `.holding` highlight clears (no finger there — the bar's red "10 day/s ▶"
  shows the state); a `scrubLocked` flag; the lock flash fires (§6.4).
  `onScrubStart` already fired at hold engagement; `onScrubEnd` and
  `writeTimeState` fire at the stop, so the contract with the apps is
  unchanged and storage / the URL reflect where the scrub stopped.
- **Stop.** A document-level `pointerdown` listener in the **capture
  phase**, installed only while locked, that `stopPropagation`s,
  `preventDefault`s, and runs `endHold()` (stop, restore the panel, write
  state). Swallowing `pointerdown` does not cancel the `click` the browser
  synthesises afterwards, and the Observatory's canvas click cycles the dial
  body — so a one-shot capture `click` swallower is armed alongside. The
  transport ‖ press is a `pointerdown` too, so it stops the scrub through
  the same listener (it does nothing else, which is what ‖ means). Also
  stop on **Escape** (before the §4 close rung) and on
  **`visibilitychange` → hidden**: a backgrounded tab must not run time
  away for an hour (iOS has no equivalent; a web tab does).
- **Accident analysis.** A lock needs ≥300 ms held, a release off the
  button, *and* the pointer at the display edge or outside the window — a
  normal lift cannot do it, and neither can a slide that stays on the
  display. An unintended lock is visible (bar in red, panel at half
  strength, the flash) and one press undoes it.

### 6.4 The lock flash (feedback on entering hands-free)

At the moment the scrub becomes hands-free, the panel **flashes for
0.2 s: opacity ramps from the scrub level up to full over 0.1 s and back
down over 0.1 s** (Steve, §8). Mechanics: a `.tp-lock-flash` class on
`#time-popover` driving a 200 ms keyframe animation (0.5 → 1 → 0.5),
removed on `animationend` (and defensively at the stop, so a press mid-flash
leaves nothing behind); declared after `.tp-hidden` so the animation wins
while it runs, after which `.tp-hidden`'s 0.5 stands. No steady-state
change: the hands-free level is the held level. It is an opacity pulse, not
movement, so it runs under `prefers-reduced-motion` too (open to reversal —
§8). Tests can assert the class is added at lock and cleared by a synthetic
`animationend`; jsdom runs no animations.

### 6.5 Alternatives considered

- **A. Release off the button keeps scrubbing** (round 1's recommendation):
  the same mechanics with a wider predicate — any release outside the button
  (plus slop) locks, so it works identically with a mouse on-screen.
  Rejected (Steve): neither A nor B is discoverable on its own, so A's
  extra reach buys nothing there; the case that separates them — the finger
  or mouse leaves the button but not the screen — is as likely to be an
  accident as a lock; and the unusual behaviour should have the narrowest
  scope that still gives the native gesture.
- **C. Camera-style lock target**: a lock glyph appears in the pair's centre
  label while a hold is engaged; slide onto it and release (iOS Camera's
  slide-to-lock recording). Discoverable and deliberate, but a visual on a
  half-faded panel, a second target, and a direction. Reserved as a polish
  layer if discoverability ever matters; B is one help sentence.
- **D. A transport rate** ("run at 10 day/s" as a transport mode): no
  gesture subtlety, but chrome in a row that is already four 44 px cells
  wide, and not the iOS gesture. Not pursued.

### 6.6 Interactions with §§2–5

- **Fade level while locked.** The held level (0.5), with the §6.4 flash on
  entry; the bar shows the rate throughout.
- **Escape** while locked stops the scrub and restores the panel; it does
  not close. The next Escape closes.
- **Display press** while locked stops the scrub and is swallowed; the
  panel stays open. The next press closes it (§5).
- **Date limits**: the controller clamps and the bar shows "AT LIMIT"; a
  locked scrub just sits there. Auto-stopping at the limit is a small
  optional extra.
- **Chronometer and the Inspector** get hands-free scrubbing automatically
  through the shared module (Chronometer's `onScrubEnd` snap runs at the
  stop, as after any hold); their display-press close comes last (§5).
- **Keyboard** (`t`, `n`, the hotkeys) is untouched.

## 7. Steps

1. **§2 + §3**: retire the tap ghost, `.tp-hidden` to 0.5, `hidePopover()`
   ends a hold first, tests folded, docs. Smallest unit; shippable alone.
2. **§4**: `escapeYields` in the shared module; the three small accessors
   (⋮ menu, share modal, location dialog); the Observatory's and the
   Inspector's predicates.
3. **§5**: the Observatory canvas listener.
4. **§6a**: migrate the pair to Pointer Events with capture and
   `touch-action: none`. Behaviour as today except that the release, not the
   leave, stops (§6.3) — its own reviewable step.
5. **§6b**: the edge predicate and lock, the flash, the capture-phase stop
   listener and click swallower, Escape / visibility stops.
6. `tsc`, vitest (jsdom 29 has `PointerEvent`; `setPointerCapture` /
   `releasePointerCapture` are absent and need a stub in the test setup;
   `visualViewport` is absent, hence the `innerWidth` fallback),
   `bash build.sh`; pane checks with the rAF shim on the three pages
   (chronometer-pane-verify-recipe): tap → no fade class; hold → 0.5;
   Escape with each overlay up in turn, and in faux fullscreen; a canvas
   press closes; lock via a synthetic `pointerup` on ▶ with
   `clientX = innerWidth` after 300 ms (rate stays, `.tp-lock-flash`
   present, `.holding` gone); a `pointerup` at the button centre stops; a
   `pointerup` off the button but mid-display stops; a document
   `pointerdown` while locked stops and is swallowed (the canvas click does
   *not* cycle the body); Escape while locked stops and keeps the panel, the
   next Escape closes. Headless screenshots for the 0.5 look over the dial.
7. **Native pass (Steve)**: the 0.5 level over a real dial; the flash's
   feel; the edge slide-off on iPhone — `pointerup` at the edge vs
   `pointercancel`, Safari's toolbar on the bottom edge, `EDGE_PX` against a
   fast slide's last sample; the mouse gesture (drag off the window,
   release); a tab switch stopping a locked scrub.
8. **Docs**: docs/time-controller.md (the hold paragraph; new "Closing the
   panel" and "Hands-free scrubbing" paragraphs; the Files table);
   help.html (the Hold paragraph gains "slide your finger off the edge of
   the screen before letting go to keep scrubbing; tap anywhere to stop";
   the keyboard table gains Escape — it has no row today);
   help/observatory.html's "Setting the time" paragraph, which still
   describes the retired Date / Astro tabs — refresh it while there;
   docs/observatory.md where the Keep dialog's Escape is described; the
   2026-07-17 plan's status banner.
9. **Last, after the native pass**: the display-press close on the face
   pages and the Inspector (§5 scope).

## 8. Decisions (Steve, 2026-09-24) and what is still open

Decided:

1. **§6: option B** — the display edge only. Neither A nor B is
   discoverable on its own; the case that separates them (off the button,
   still on the screen) is as likely intentional as not; keep the unusual
   behaviour's scope narrow to limit surprise.
2. **§2**: transport (‖, ◀, ▶) and Now lose the fade too.
3. **§5**: the positive rule — a press on the display closes the panel;
   chrome presses (Settings, Set location, …) leave it open.
4. **§5 scope**: the face pages and the Inspector are in the plan, as the
   very last step, after manual testing.
5. **§3 / §6.4**: no separate hands-free level; instead a 0.2 s flash on
   entering hands-free (0.1 s up to full, 0.1 s back down).
6. **§4**: in fullscreen, Escape only exits fullscreen.

Still open (settle during implementation or the native pass):

- `EDGE_PX` (starting at 8) once a fast slide's last sample is seen on the
  device.
- Whether an iOS edge slide-off arrives as `pointerup` or `pointercancel`
  (§6.3) — decides whether the cancel-at-edge rule is needed.
- Whether the flash should also run under `prefers-reduced-motion` (kept,
  as an opacity pulse; easy to gate).
- Whether the mouse gesture (release outside the browser window) should be
  documented in help alongside the touch one, or left as parity.

## 9. Implementation record (2026-09-24, build 2.0.158)

Everything in §7 steps 1–6 and 8 landed; `tsc` clean; 8860 tests pass (the
units test grew from 13 to 27 — the fade, hands-free, Escape and mid-hold
close pins; the nine-test ghost file is gone). Uncommitted, awaiting the
native pass.

**Shared module** (`time-controls-ui.ts`): `ghostTap`, the `GHOST_*`
constants, the settle probe and the `isSettled` hook are gone (Chronometer's
probe with them; the `updater` type is now just `{ reset() }`). The pair is
on Pointer Events with capture and `touch-action: none`; one press at a
time (a second pointer while one is down is ignored — today a second
`mousedown` started a second hold timer); `pointercancel` /
`lostpointercapture` after the hold stop. `releaseLeavesDisplay` is the
§6.3 predicate (off the button's rect, and within `EDGE_PX` = 8 of a
`visualViewport` edge or past it; `innerWidth/Height` where the API is
absent). `lockScrub` / `unlockScrub` / `onLockedPress`: the capture-phase
document `pointerdown` stops and swallows, and arms a one-shot capture
`click` swallower that also disarms itself after 500 ms if no click comes
(so it can never eat an unrelated later click). `endHold` covers both the
held and the hands-free case; `hidePopover` calls it first. The Escape
listener is a window capture-phase keydown installed on every page: a
hands-free scrub stops first (stops propagation, so Chronometer's ladder
does not also close the panel); the close rung runs only where
`escapeYields` is supplied, and is guarded by `timePopover.isConnected` (a
detached instance — jsdom re-inits per test — never acts).

**CSS**: `--tp-scrub-opacity: 0.5` on `#time-popover`, used by `.tp-hidden`
and by the `tp-lock-flash` keyframes (0.5 → 1 → 0.5 over 0.2 s,
`ease-in-out`); the class is removed on `animationend` (target-checked —
the popover's only animation) and at the stop.

**Accessors** for the predicates: `isOverflowMenuOpen()` (overflow-menu.ts),
`isShareDialogOpen()` (share-button.ts, a module variable set on open and
cleared on close), `LocationDialogAPI.isVisible()`. The Observatory's
dialog handle was local to `setupLocationDialog`; it is now mirrored into a
module-level `activeLocationDialog` for the predicate (the local `const`
stays, so TypeScript's null narrowing in the handlers is unchanged).

**Pane verification** (dist server on a fresh port, build stamp 2.0.158,
1024×768; synthetic `PointerEvent`s with `pointerType: 'touch'`, the
▶ button at x 943–999 on the Observatory):

| Page | Result |
|------|--------|
| observatory.html | tap ▶ → no fade class, "Stopped", +1 day · hold → `.tp-hidden` + `.holding` at +360 ms, computed opacity 0.94 mid-transition then 0.5 · release on the button → restored, stopped · release at (500, 300) → stopped, no flash · release at (1022, 560) → "10 day/s ▶" keeps running, `.tp-hidden .tp-lock-flash`, `.holding` gone, opacity 0.5; the flash's `animationstart` / `animationend` both fire when the pane's throttled animation clock next advances (~1 s here) and the class clears · canvas press at (300, 300) → stopped, press and click both `defaultPrevented`, panel open · Escape → closed · Escape with `is-fullscreen` on body → not prevented, panel stays; class removed → closes · Settings open → Escape closes Settings, panel stays; next Escape closes · focused hour input → Escape blurs it, panel stays; next Escape closes · canvas press on an idle panel → closed · hands-free then Escape → "Stopped", panel open · hands-free then `document.hidden` → stopped |
| terra.html | hold → `.tp-hidden` "10 day/s ▶" · release at the right edge → locked with flash, `.holding` gone · Escape → stopped, panel stays (the ladder did not run) · next Escape → the ladder's rung 5 closes it · locked, press on a face canvas → stopped, prevented, panel open · tap → no fade |
| inspector.html | Escape → closed · ⋮ menu open → Escape closes the menu, panel stays · Settings open → Escape closes Settings, panel stays · edge release → locked · Escape → stopped, panel open · next Escape → closed |

The pane ran in session storage mode (the incoming-settings modal was
dismissed with "this visit only"), so the state write at the stop was not
observed there; the units test pins it (`dir: 0` after the stop press).
Storage-backed runs are part of the native pass.

**For the native pass (Steve)**: the 0.5 fade over a real dial; the flash's
feel; the edge slide-off on iPhone — whether it arrives as `pointerup` at
the edge (→ locks) or `pointercancel` (→ stops today; §6.3 has the
cancel-at-edge rule ready), Safari's toolbar on the bottom edge, whether a
fast slide's last sample lands within 8 px; the mouse gesture (drag out of
the browser window and release); a tab switch stopping a locked scrub; the
storage writes above. Then step 9.

## 10. Review round 3 (Steve, 2026-09-24; build 2.0.159)

- **Scrub level 0.38** (from 0.5), for a look; `--tp-scrub-opacity`.
- **Lock-zone feedback replaces the flash.** The flash told you the lock had
  happened; nothing told you it was *about* to, and with a mouse there was
  no way to predict it. Now, while a held scrub's pointer is where a release
  would lock (the captured button's `pointermove`s, so a mouse dragged out
  of the window counts), the panel comes back to full opacity with a large
  green padlock over it (`.tp-lock-zone`, `#tp-lock-badge`, a 96 px SVG in
  the partial); move back onto the display and it fades again. Release in
  the zone and the padlock stays up, faded with the panel at the scrub level
  (`.tp-locked`). The `tp-lock-flash` keyframes, class and `animationend`
  listener are gone; the two-stage "up on entering the zone, down on
  release" is the state change's feedback now. `lastPointer` tracks the
  held pointer from press through moves; `updateLockZone()` runs on every
  move and when the hold engages (the pointer may already be there).
- Tests: 28 (a zone test — nothing before the hold engages, shown once it
  does with the pointer already at the edge, cleared on a move back, shown
  again out of the window, cleared on the button; and the locked state
  keeping the badge at the scrub level).
- **Padlock dimmed** (same day, build 2.0.160): the lock at the panel's
  full strength was distracting even faded. Its own opacity is 0.75 in the
  zone (over the full-opacity panel) and 0.4 once released (over the 0.38
  panel, ≈ 0.15 effective); the two multiply because the badge is a child of
  the popover.

## 11. Step 9 (2026-09-24, build 2.0.164)

The display-press close on the face pages and the Inspector, brought
forward on Steve's word before the native pass.

- **Chronometer**: one `pointerdown` listener on `#watch-grid` (the face
  grid is the display) in engine-entry.ts, after the controller is wired.
  The press passes through, so on the multi-face pages a face's *click*
  still navigates to its page — the panel closes on the press first, which
  is moot but harmless.
- **Inspector**: the same listener on the time readout (`.time-section`)
  and the catalog (`#catalog`), skipping presses on a button — the location
  card's Set lives in the catalog and opens a dialog over the panel, so it is
  chrome by the §5 rule.
- Docs: time-controller.md's "Closing the panel" bullet names all three
  displays; docs/inspector.md gains a sentence; help.html's sentence no
  longer singles out the Observatory.

Pane, build 2.0.164 (fresh port, `[mem] build 2.0.164`; synthetic
`pointerdown`s, never a click):

| Page | Result |
|------|--------|
| terra.html | press on the face canvas → closed; reopened, press on the ℹ button → open; hands-free lock (`10 day/s ▶`, `.tp-hidden .tp-locked`), press on the face → `Stopped`, `defaultPrevented`, panel still open, classes clear |
| all.html (16 faces) | press on a face → closed, and still on all.html (no navigation from a press alone) |
| inspector.html | press on the catalog → closed; reopened, press on Set → open; press on the time readout → closed; reopened, press on ℹ → open |
