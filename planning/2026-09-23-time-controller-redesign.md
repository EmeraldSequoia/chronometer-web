# Plan: the time controller, redesigned — unit first, one ◀ ▶ pair, any body

**Status**: IMPLEMENTED 2026-09-23 (build 2.0.154 after review round 1; awaiting Steve's native review) — Part 4 of
[2026-09-14-user-options-panel.md](2026-09-14-user-options-panel.md) (§3.2
design notes, decisions §7.3, §6 row 4). Every design question was decided
on 2026-09-16 ("always the new design"; controller body *decoupled* from the
page's body, defaulting to it); what remains is in-app judgement of the
footprint and feel.
**Created**: 2026-09-23
**Baseline**: 776b0cc (`Add a Settings dialog with device preferences`, build 2.0.148)
**Related**: [2026-07-17-time-controller-scrub-invisibility.md](2026-07-17-time-controller-scrub-invisibility.md)
(the ghosting the new panel keeps), [2026-07-17-time-controller-cleanup.md](2026-07-17-time-controller-cleanup.md)
(the popover is a pure overlay on every page), [docs/animation.md](../docs/animation.md#time-controls-contract)
(the `initTimeControls` contract).

## 1. What changes for the user

Today's popover: five ◀ 1y ▶ … ◀ 1mi ▶ step rows in a 120 px column, 11 px
text on 22 px buttons, and a Date / Astro tab pair below with seven event
rows of 28 px chevrons — nothing meets a touch-target guideline, there is no
seconds unit, and rise / set / transit apply to the Sun and Moon only (or to
Venezia's body, on Venezia). The new panel (parent §3.2):

```
 ┌────────────────────────────────┐
 │ [ Now ▶ ] [ ‖ ]      transport │  one row: Now (when overridden); ‖ running / ◀ ▶ stopped
 │ 10 day/s ▶           rate label│
 │ STEP BY                        │
 │ [yr ] [mo ] [day] [hr ] [min]  │  unit chips, 44 px, two rows of five
 │ [sec] [rise][set][transit][phase]│  astro chips tinted; one chip is selected
 │ [‹]      Jupiter          [›]  │  body stepper — rise / set / transit only
 │ [ ◀ ]    Jupiter rise    [ ▶ ] │  THE pair: 56 px targets; label = the selected unit
 │ SET DATE & TIME                │
 │ [YYYY] [MM] [DD]               │  unchanged inputs
 │ [ CE ] [HH] [mm]               │
 └────────────────────────────────┘
```

- **Unit first, then one pair.** Choose what a step means (a chip), then
  step or hold-to-scrub with one big ◀ ▶ pair. The pair's centre label
  always names the unit ("1 day", "Sunrise", "Jupiter transit"), so the mode
  is never hidden; the time bar keeps showing the offset after each step.
- **Seconds** is a unit (was missing); holding scrubs at 10 s/s.
- **Any body** for rise / set / transit: a ‹ Body › stepper appears for
  those three units (Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn,
  Uranus, Neptune). *Phase* is Moon-only: it hides the stepper. The
  controller's body is **decoupled** from the page's (parent §7.3): picking
  Mars here leaves Venezia on Jupiter; it *defaults* to the page's body
  where the page has one (Venezia's face body, Observatory's dial body),
  else the Moon, until the user picks one.
- **Hold-to-scrub** on ◀ / ▶ scrubs by the selected time unit, as today's
  per-row hold did; astro units are tap-only (each jump is a search).
- **44 px targets** on everything; the pair is 56 px tall.
- No tabs: the date inputs sit below the pair, always present.

## 2. Design

### 2.1 Units and labels

| Chip | `tu` | Pair label | Step | Hold |
|------|------|------------|------|------|
| yr | `yr` | 1 year | `step('year')` | 10 yr/s |
| mo | `mo` | 1 month | `step('month')` | 10 mo/s |
| day | `day` (default) | 1 day | `step('day')` | 10 day/s |
| hr | `hr` | 1 hour | `step('hour')` | 10 hr/s |
| min | `min` | 1 minute | `step('minute')` | 10 min/s |
| sec | `sec` | 1 second | `step('second')` | 10× |
| rise | `rise` | Sunrise / Moonrise / *Body* rise | `findNextRiseSet(true, body)` | tap only |
| set | `set` | Sunset / Moonset / *Body* set | `findNextRiseSet(false, body)` | tap only |
| transit | `transit` | Sun transit / Moon transit / *Body* transit | `findNextTransit(body)` | tap only |
| phase | `phase` | Moon phase | `findNextQuarterPhase` | tap only |

Row 1 is the five largest time units, row 2 is seconds plus the four astro
chips (parent §3.2: 6 + 4 split 5 / 5; the astro chips get a tint so the
group boundary reads even mid-row). Hold rates are `RATE_OPTIONS[0..5]`
(`second … year`), the same table today's rows index.

### 2.2 Persistence — `tu` and `tb` replace `tp`

`tp` (the Date / Astro tab) has no meaning in the new panel. Two fields take
its place, **routed exactly as `tp` was** (parent §3.2: "same routing as
`tp` today"): per app (`namespaceOf` → the running app's namespace; null on
index / pick), shareable (`SHAREABLE_FIELDS`, `SHAREABLE_URL_KEYS`,
`urlScalarOverrides`, `buildShareUrl`), defaults omitted:

- `tu`: the chip key above; default `day`.
- `tb`: the controller body as a lower-case name (`sun moon mercury venus
  mars jupiter saturn uranus neptune`, the spelling Venezia's `body` uses);
  default `null` = "follow the page's body, else the Moon".

`tp` is removed from `UrlState`, url-state's read / write / share, app-state's
routing and defaults, and the tests; `tp` stays in `CLEARED_URL_KEYS` so a
legacy `?tp=a` link is cleaned from the URL on adoption. Stored `tp` values
in existing `ec:*` blobs are inert.

### 2.3 The body

`initTimeControls` keeps `getSelectedBody?: () => number | undefined` as the
*page body* hook (a planet number; Chronometer passes Venezia's selection,
the Observatory its dial planet, the Inspector nothing). The controller
body = stored `tb` → planet number, else `getSelectedBody?.()`, else
Moon. While `tb` is null the stepper shows the page's body and follows it
when the page changes (Venezia's icons); once the user steps the body, `tb`
is written and the two are independent.

Chronometer today communicates the body through `data-planet` on three
label spans it swaps in for the Moon rows; that DOM coupling goes.
`selectPlanet` in engine-entry.ts keeps the selected planet number in a
variable that `getSelectedBody` returns, and the UI refreshes its body
label through the API's `updateTimeUI` (called on every frame anyway).

### 2.4 Markup and layout (`partials/time-controller.html`, `.css`)

One panel, `#tp-panel`, 264 px wide (240 inner), replaces `#tp-upper` +
`#tp-lower`; the L-shape existed only because the step column was narrow.
`#time-popover` keeps its container role (positioning per page, opacity
ghosting, `pointer-events: none` with the panel opting back in). Inside,
top to bottom: `.tp-top-row` (`#tp-transport`, one row of 44 px buttons,
and the 44 px `#tp-close` × as its last cell — review round 1), `#tp-rate-label`, the STEP BY caption, `#tp-units` (a 5-column
grid of `.tp-chip`, 44 px tall, `data-unit`), `#tp-body-row` (`#tp-body-prev`
‹, `#tp-body-name`, `#tp-body-next` ›; hidden unless rise / set / transit),
`.tp-step-pair` (`#tp-step-back` ◀, `#tp-step-label`, `#tp-step-fwd` ▶; the
buttons 56 × 56), the SET DATE & TIME caption and the unchanged date inputs
(`#tp-year … #tp-minute`, `#tp-bce`). No `backdrop-filter` (the panels'
comment carries over).

Estimated height (day unit, no body row): 44 + 20 + 18 + 92 + 56 + 18 + 76
+ paddings ≈ 360–380 px; with a body row ≈ +50. Measured after the build
and written into the Observatory's CC2 footprint (§2.6).

### 2.5 Wiring (`time-controls-ui.ts`)

- The `[data-step]` per-row wiring and `stepMap` / `unitToRateIndex` become
  a `UNITS` table (chip key → label, `TimeUnit` or astro event, rate
  index). `doStep` / `startHold` / `endHold` keep their bodies but read the
  *selected* unit; `ghostTap(true)` on every step / astro tap as now;
  `.tp-hidden` for the hold; the flash-fail on a null astro result.
- `selectUnit(key)`: chip `.active`, pair label, body-row visibility,
  `setState({ tu })`. Initial unit from `getState().tu` (the tab used to
  come from the URL; reading state is the storage-mode-correct form).
- The body stepper: ‹ › cycle the nine bodies; `setState({ tb })`; label
  refresh in `updateTimeUI` (cheap: a string compare).
- The transport renders one row.
- `switchTab`, the tab elements, and the astro `[data-astro]` rows go.

### 2.6 Observatory CC2 footprint

`TC_POPOVER_W / H` (anchor-layout.ts, today 200 × 368 — "the controller's
default-config popover") become the new panel's measured default size
(time unit selected, body row hidden). The threshold rule is unchanged: the
safe rect must hold the panel or the chrome bands drop.

### 2.7 Not doing (per the parent plan)

Keyboard ← / → stepping (a natural follow-on); hold-to-scrub on astro units;
coupling the controller body to the page's; a "which controller" preference.

## 3. Steps

1. State: `tu` / `tb` in url-state.ts (`UrlState`, `readUrlState`,
   `writeUrlState`, `buildShareUrl`) and app-state.ts (`namespaceOf`,
   `defaultState`, `isDefaultValue`, `SHAREABLE_*`, `urlScalarOverrides`);
   `tp` out; tests in app-state.test.ts.
2. Partial markup + CSS.
3. time-controls-ui.ts: units, body, pair, transport row, initial state.
4. Entries: Chronometer's Venezia body hook (drop the label swapping);
   Observatory passes its dial planet; Inspector unchanged.
5. Build, measure the panel, set `TC_POPOVER_W / H`.
6. Tests: update time-controls-ghost.test.ts to the new markup; new
   time-controls-units.test.ts (chips, pair, hold, body default / override,
   phase → Moon, persistence).
7. Docs: new docs/time-controller.md (indexed in docs/README.md); the
   contract table in animation.md; observatory.md's CC2 numbers;
   inspector.md's controller paragraph; help.html's "Astronomical Event
   Stepping" section rewritten as the controller's section (units, the
   pair, hold-to-scrub, the body stepper, the events list kept); the
   per-app help pages that mention the Astro tab.
8. `tsc`, vitest, `bash build.sh`; pane checks on the three apps (chips,
   pair label, body row, hold-to-scrub via mousedown / mouseup with the rAF
   shim, `tu` / `tb` in storage and share links); headless screenshots.

## 4. Implementation record (2026-09-23, build 2.0.152)

Everything in §3 landed. `tsc` clean; 8848 tests pass (13 new in
`time-controls-units.test.ts`; the ghost test re-pointed at the pair; the
app-state tests moved from `tp` to `tu` / `tb`). Design details settled
while building:

- **Row split**: row 1 = `yr mo day hr min` (descending), row 2 = `sec`
  plus the four tinted astro chips — one calendar chip sits with the astro
  group whichever way six + four split five / five; the tint marks the
  group, and descending order reads naturally.
- **Astro search** always goes through the `body-*` event types with the
  body's `ECPlanetNumber` (`computeAstroTarget` handles the Sun and Moon
  there too); the `sunrise` … `moon-transit` types stay for the tests.
- **Labels**: "Sunrise" / "Moonset" as one word, "Sun transit", "Jupiter
  rise", "Moon phase" (`astroStepLabel`).
- **The page body hook** (`getSelectedBody`) is read on every
  `updateTimeUI`, so while no body is stored the pair's label follows
  Venezia's icons live; Chronometer keeps the selected planet number in a
  variable instead of poking `data-planet` onto label spans.
- **Transport** is one row (Now ▶, then ‖ or ◀ ▶), 44 px.
- **Date inputs** are 44 px tall too (first measured at 40).
- **Footprint**: default 264 × 389 (a calendar unit; with the body row
  433) → `TC_POPOVER_W / H`. Re-deriving the CC2 rule exposed a
  pre-existing gap: the Observatory's panel sits 6 px *above the footer
  band*, so "safe height ≥ panel" left the panel's top 26–38 px off-screen
  at heights just over the threshold (the old 368 px panel had the same
  flaw). The rule now requires panel + gap + footer (`TC_POPOVER_GAP`), the
  dropped state moves the panel into the freed band, and — for viewports
  shorter than the panel itself, a phone on its side — `#tp-panel` is
  capped at the visible height and scrolls inside itself like the ⋮ menu,
  so the chips at the top stay reachable (the old panel was simply cut off
  there).
- **Found and fixed on the way**: in the Observatory's CC2-dropped and
  fullscreen states the controller could not be opened at all — the
  partial sits inside `#obs-footer-row`, and both states hid the whole row,
  so the ⋮ menu's "Show time controller" and the `t` key showed nothing
  (since Part 1 for the dropped state; fullscreen for longer). The row now
  stays displayed (it is a transparent, `pointer-events: none` strip) and
  only the bar and the location controls hide; the panel drops into the
  freed band in both states.

Pane verification on 2.0.149 (DOM reads at 1280×800; rAF frozen, so
scrubbing was checked through the controller's own state):

| Page | Result |
|------|--------|
| observatory.html | `t` opens the panel (264 × 381 before the input bump); chips `yr mo day* hr min / sec rise set transit phase`, each 44 × 44; pair buttons 56 × 56; transport `‖` 44 px; label "1 day", body row hidden. `rise` → body row shown, "Sunrise" (the dial's Sun), panel 433; `›` → "Moonrise", `ec:observatory {"tu":"rise","tb":"moon"}`; `phase` → "Moon phase", row hidden. `sec` + mousedown on ▶ → after 450 ms rate label "10× ▶", `.tp-hidden`, `.holding`; mouseup → "Stopped", `ec:shared` gains `t` / `dir: 0`; Now clears them; close restores the bar label |
| terra.html | panel at the viewport's bottom-right (264 × 380), day selected, nothing stored until chosen |
| inspector.html | `transit` → "Moon transit" (no page body), `ec:inspector {"tu":"transit"}`, panel 433 |

Footprint and reachability on 2.0.152 (Observatory unless noted):

| Viewport | Result |
|----------|--------|
| 800×440 | chrome kept (440 ≥ 389 + 6 + 32); panel 389 tall, top 13, bottom 402, footer top 408 |
| 800×400 | dropped (400 < 427); the ⋮ menu's "Show time controller" opens the panel in the freed band (top 6, bottom 394); a chip is hit-testable; the footer row is displayed, the bar hidden |
| 600×300 | dropped; panel capped at 288 (scroll height 387, max scrollTop 101); transport and chips at the top at scroll 0, the minute input's bottom at 277 when scrolled |
| 1280×800 + `is-fullscreen` | panel opens, bottom at 794 (the bar hidden) |
| terra.html 956×440 | panel 388 at the viewport's bottom-right, chips and pair on screen, no scrolling needed |

For Steve natively: the panel's look and the chip labels at phone size;
hold-to-scrub feel on the 56 px buttons (touch); the body row on Venezia
following the face's planet until stepped; whether the day default and the
row split read right; the ghosting under the taller panel.

## 5. Review round 1 (Steve, 2026-09-23; build 2.0.153)

- **Close button at 44 px.** It was the old 24 px disc floating above the
  panel; at 44 px there it would have added its height to the CC2
  footprint, so it moved inside the panel as the last cell of the transport
  row (`.tp-top-row`), top-right where a close belongs, borderless until
  hovered. Panel height unchanged (389), so `TC_POPOVER_H` stands.
- **Pause / play act on press** (build 2.0.154). Pre-existing: the transport
  buttons had always used `click` (release) while the step pair acts on
  press. Steve asked for press; the transport row's four buttons (Now ▶, ‖,
  ◀, ▶) now act on `pointerdown` — mouse, touch and pen alike — with
  `preventDefault` so the press neither focuses nor selects, and nothing
  listens for the click that follows. The time bar's Now button and the ×
  stay on click. Pane check on 2.0.154: a `pointerdown` on ‖ alone reads
  "Stopped" and re-renders ◀ ▶; the pointerup and click that follow change
  nothing; ◀ press → "1× ◀"; Now ▶ press → "1× (real time)".

