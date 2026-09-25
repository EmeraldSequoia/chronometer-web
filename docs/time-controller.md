# Time Controller

The time controller is the shared transport for all three apps: the
`#time-bar` under the display (date, offset, rate, Now) and the `#time-popover`
panel it opens (`⏱ Show time controller`, hotkey `t`). This doc covers the
panel's design and wiring; the time model it drives is `TimeController` in
`src/shared/time-controller.ts` ([animation.md](animation.md#time-controls-contract)
has the `initTimeControls` contract). It is the implementation record of
Part 4 of
[planning/2026-09-14-user-options-panel.md](../planning/2026-09-14-user-options-panel.md)
(plan: [planning/2026-09-23-time-controller-redesign.md](../planning/2026-09-23-time-controller-redesign.md)).

## The panel: unit first, then one pair

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

Markup: `src/partials/time-controller.html` (injected as `{{TIME_CONTROLLER}}`
by build.sh into the face pages, Observatory and the Inspector); appearance:
`src/partials/time-controller.css` (`{{TIME_CSS}}`); wiring:
`src/shared/time-controls-ui.ts`.

**Why unit-first.** The previous panel had five ◀ 1y ▶ … ◀ 1mi ▶ rows of
22 px buttons and a Date / Astro tab pair with seven event rows; nothing met
a touch-target guideline, there was no seconds unit, and rise / set /
transit applied to the Sun and Moon only. Choosing the unit once and then
using one big pair gives 44 px targets everywhere in the same footprint,
and it makes the unit *visible*: the pair's centre label always names it
("1 day", "Sunrise", "Jupiter transit"), so the mode is never hidden, and the
time bar keeps showing the offset after every step.

### Units

| Chip | `tu` | Pair label | Tap | Hold |
|------|------|------------|-----|------|
| yr, mo, day, hr, min, sec | `yr mo day hr min sec` | 1 year … 1 second | `TimeController.step(unit)` (stops the clock first) | scrub at 10 units / s (`RATE_OPTIONS`) |
| rise, set, transit | `rise set transit` | *Body* rise / set / transit (Sunrise, Moonset, Sun transit …) | `computeAstroTarget('body-rise' …)` for the chosen body, then `setTime` | tap only — each jump is a rise / set / transit search |
| phase | `phase` | Moon phase | `computeAstroTarget('moonphase')` | tap only |

Row 1 is the five largest calendar units; row 2 is seconds and the four
astro chips, tinted so the group boundary reads even though the rows split
it. `UNITS` in time-controls-ui.ts is the table. The default is a day.

Hold-to-scrub: a press steps once, and after `HOLD_DELAY_MS` (300 ms) the
clock runs at the unit's rate in the pressed direction until release, which
stops it. The pair uses Pointer Events with capture, so the release reaches
the button wherever the pointer went by then — which is what makes
[hands-free scrubbing](#hands-free-scrubbing) possible. While a scrub runs
the popover fades to `--tp-scrub-opacity` (0.38, `.tp-hidden`) so the display
underneath is visible; see [the scrub fade](#the-scrub-fade-two-stories).

### The body

Rise / set / transit apply to any of nine bodies (Sun, Moon, Mercury, Venus,
Mars, Jupiter, Saturn, Uranus, Neptune — `CONTROLLER_BODIES`, Venezia's
order and spelling). The ‹ › row appears for those three units only; *phase*
is Moon-only and hides it.

The controller's body is **decoupled from the page's** (parent plan §7.3):
picking Mars here leaves Venezia showing Jupiter, and vice versa. It
*defaults* to the page's body — `getSelectedBody` in the `initTimeControls`
config: Venezia's selected planet on single-face Venezia, the Observatory's
dial planet; the Inspector passes nothing — and follows it while the user
has not chosen; the first ‹ › tap stores `tb` and the two are independent
from then on. Without a page body and without `tb` the body is the Moon.
The search itself is `computeAstroTarget` with the `body-*` event types and
the body's `ECPlanetNumber`; a body that never rises or sets at the
location (a polar day, a circumpolar planet) returns null and the pressed
button flashes (`.flash-fail`).

### Persistence

`tu` (the chip) and `tb` (the body, or null = follow the page) live in
`UrlState` and are routed **per app** by app-state (`namespaceOf`: the
running app's namespace; nothing on the index / pick pages), like the
retired Date / Astro tab `tp` was. Defaults are omitted from storage and
URLs; both are shareable (`buildShareUrl` writes `tu=rise&tb=saturn`), so a
shared link opens the controller the way the sender had it. Legacy `?tp=a`
links are cleaned from the URL on adoption and otherwise ignored.

### Transport and date

The transport is one row: `Now ▶` whenever time is overridden, then `‖`
while running or `◀` `▶` when stopped (`renderTransport`, rebuilt only when
that state changes so the buttons keep their listeners), with the 44 px
close × as the row's last cell. The transport buttons act on **press**
(`pointerdown`), like the step pair: a stop lands the instant the finger
touches rather than on release. (The time bar's Now and the × still act on
click.) The date inputs are
always present under the pair (no tab): year / month / day and CE-BCE /
hour / minute, applied on change through the hybrid calendar
([calendar.md](calendar.md#time-bar-display)). The composition is two-pass —
compose with the current offset, look the zone's offset up at the result,
recompose if it differs — so the typed wall time wins across a DST edge or an
era flip (a BCE date sits on the zone's LMT, an hour's fraction away from
today's offset).

### The scrub fade: two stories

Setting the time has two stories, like setting the location
([planning/2026-09-24-time-controller-two-stories.md](../planning/2026-09-24-time-controller-two-stories.md)):

- **Precise** — "I want to know about *this* time": type a date, or get
  there by steps ("in a few days", "at the next full moon", "at sunset").
  Several taps, each aimed at a target; the display is not the point until
  the last one. The location dialog is this story for location.
- **Exploratory** — "what changes as time passes?": hold to scrub. One
  continuous gesture whose whole point is watching the display. Dragging the
  map is this story for location — and nothing overlays the display while
  you do.

So the panel **fades only while a scrub runs, and never on a tap**: a panel
that faded after every step moved the target out from under the next one
(the 2026-07-17 tap ghost, retired; users read it as the controller "going
away entirely"). A hold fades the popover to 0.38 when it engages (at
+300 ms, the first moment a press is known to be a scrub) and the release
restores it; steps, astro jumps, transport presses, Now, chips and the date
inputs leave it alone. The fade must stay opacity-only: the hold's release
arrives on the faded button, and `visibility` / `display` would stop
hit-testing and strand the hold.

### Hands-free scrubbing

The native app has a habit its users like: slide the finger off the
display while scrubbing and the scrub keeps going, finger out of the way,
until the next tap. The web controller does this on purpose, and narrowly:
a release that lands **off the button and at the display's edge** (within
`EDGE_PX` of the visual viewport's edge, or past it — a mouse dragged out of
the browser window and released) turns the scrub from *on until release*
into *on until the next press*. A release anywhere on the display, on the
button or off it, stops as usual, so a wobble never locks.

The outcome is visible before it happens: while the held pointer is where a
release would lock — the captured button's `pointermove`s drive it, so a
mouse dragged out of the window counts — the panel comes back to **full
opacity with a large green padlock over it** (`.tp-lock-zone`,
`#tp-lock-badge`, the badge at 0.75); move back onto the display and it
fades again. Let go in the zone and the padlock **stays up**, dimmed to 0.4
over the panel at the scrub level (`.tp-locked`; the badge is a child of the
popover, so the two multiply to about 0.15 — a full-strength lock was
distracting). The time bar shows the rate throughout.

A hands-free scrub stops on:

- **the next press anywhere**, which does nothing else: it is swallowed in
  the capture phase (no map drag, no menu, no chip) along with the click the
  browser synthesises from it;
- **Escape** (the panel stays open; the next Escape closes it — see below);
- **the tab going hidden** (`visibilitychange`), so a background tab cannot
  run time away for an hour;
- a cancelled or lost pointer at any time (unknown state: stop).

The apps see nothing new: `onScrubStart` fired when the hold engaged,
`onScrubEnd` and the time-state write fire at the stop.

### Closing the panel

The × in the top row, the time bar's ⏱ toggle, the `t` key and the ⋮ menu's
item close the panel, and each stops any running scrub first (`hidePopover`
ends the hold — `display: none` would otherwise strand a held button's
release). Two more, for the precise story's "done now":

- **Escape, last in the hierarchy.** On pages that pass `escapeYields`
  (Observatory, Inspector), the UI installs a window capture-phase Escape
  listener that closes the panel only while that predicate is false — no
  dialog, menu or fullscreen is up to take the key first (each of those owns
  its own Escape, and most close themselves on the same keydown without
  stopping it, so the decision has to be made in the capture phase on the
  pre-close state). A focused date input gives up focus first; the pending
  edit applies on change. Chronometer runs its own Escape ladder with the
  panel as its last rung and passes nothing.
- **A press on the display** (the Observatory canvas, wired in its entry)
  closes the panel and passes through, so a map drag with the panel open
  both closes it and starts the drag. Presses on chrome (Settings, Set
  location, the corners) leave it open. The face pages and the Inspector
  are to follow after the Observatory's native pass.

## Footprint and placement

The panel is one 264 px column (five 44 px chips plus gaps and padding),
389 px tall in the default configuration (a calendar unit, body row hidden;
433 with the body row). That default is the Observatory's CC2 chrome-drop
footprint, `TC_POPOVER_W / H` in `src/observatory/anchor-layout.ts`
([observatory.md](observatory.md)): the panel sits `TC_POPOVER_GAP` (6 px)
above the footer band, so the bands are kept only while the safe rect holds
panel + gap + footer; otherwise both bands drop, the ⋮ menu carries the
controls, and the panel moves down into the freed band
(`body.obs-chrome-dropped #time-popover`). A viewport shorter than the panel
itself (a phone on its side) does not cut it off: `#tp-panel` is capped at
the visible height (`100dvh` less its offsets, `100vh` where dvh is
unknown) and scrolls inside itself, like the ⋮ menu, so the chips at the top
stay reachable. Each page positions `#time-popover` itself (bottom-right of
the viewport on the face pages, above the footer row on the Observatory,
8 px in on the Inspector) and sets the cap's offsets in its own rule; it is a
pure overlay everywhere — no layout participates
([planning/2026-07-17-time-controller-cleanup.md](../planning/2026-07-17-time-controller-cleanup.md)).

## Files

| File | Role |
|------|------|
| `src/partials/time-controller.html`, `.css` | markup and appearance |
| `src/shared/time-controls-ui.ts` | `initTimeControls`: units, the pair, hold-to-scrub, the scrub fade, hands-free scrubbing, Escape, the body, transport, date inputs; `UNITS`, `CONTROLLER_BODIES`, `astroStepLabel` |
| `src/shared/time-controller.ts` | the time model: 1× / offset / stopped / quantized rates |
| `src/shared/astro-stepper.ts` | rise / set / transit / phase searches (`computeAstroTarget`) |
| `src/shared/url-state.ts`, `app-state.ts` | `tu` / `tb` |
| tests | `src/__tests__/time-controls-units.test.ts` (units, the pair, the fade, hands-free, Escape), `scrub-direction-snap.test.ts`, `astro-boundary.test.ts` |
