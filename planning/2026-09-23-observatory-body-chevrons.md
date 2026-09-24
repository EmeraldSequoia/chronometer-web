# Plan: Observatory ‹ Body › chevrons — a visible body selector on the alt/az dials

**Status**: IMPLEMENTED 2026-09-23 (build 2.0.156 after review round 1; awaiting Steve's native review) — Part 5 of
[2026-09-14-user-options-panel.md](2026-09-14-user-options-panel.md) (§3.3,
mock and spec §3.3.1, decision §7.4, §6 row 5). Everything was decided on
2026-09-17 from the rendered mock: treatment **c**.
**Created**: 2026-09-23
**Baseline**: e6c349a (`Restructure time controller.`, build 2.0.154)
**Related**: [docs/observatory.md § Peripheral Dials](../docs/observatory.md#peripheral-dials).

## 1. The problem and the decision

One body (Sun … Saturn) is shown on the Altitude and Azimuth dials; the only
way to change it is to tap a dial, and nothing says so — the body name is
just a caption. iOS parity made the two dials cycle in opposite directions
(altitude forward, azimuth back). Auto-cycling was rejected (perpetual motion
on a reading instrument, and it defeats the idle story); the at-rest look
had to stay essentially as it has been for fifteen years. From the seven
treatments rendered from the real dial (§3.3.1), Steve chose dim ‹ ›
chevrons flanking the name, nudged clear of the altitude dial's "30" when a
long name (Mercury) would collide — **treatment c**:

- ‹ › at **0.8 ×** the label font, **45 %** alpha, **0.3 em** from the name;
  hover brightens the hovered chevron to ~90 % (mouse).
- Altitude half-dial only: when the left chevron would come within
  **0.35 em** of the "30" numeral, the whole name + chevron group shifts
  right by the minimum that clears it. Short names never move.
- **Touch targets are 44 px regardless of glyph size**: the dial's **left
  half is "back"** and its **right half "forward"**, each extended with slop
  to at least 44 px in both dimensions; the chevrons sit inside their halves
  as the visual hint. This replaces the iOS split (altitude forward, azimuth
  back) with the same left / right rule on both dials.
- **Label animation on a change**: the outgoing name slides out *in the
  tapped chevron's direction* while fading and the incoming one slides in
  from the opposite side, ~250 ms, clipped to the label zone so nothing
  crosses the numerals or the hub; the same whichever target was hit, so the
  motion teaches the chevrons. The hands' existing sweep to the new body
  runs concurrently. Cross-tab / share-link changes snap (no gesture to
  explain); so does reduced motion.
- Help gains a line under the Observatory's peripheral dials.

## 2. Design

### 2.1 `src/observatory/body-selector.ts` — pure geometry, unit-tested

- `dialHalfAt(x, y, cx, cy, r)` → `'back' | 'forward' | null`: each half is
  `max(r, 44)` wide and the pair `max(2r, 44)` tall, centred on the dial;
  `x < cx` is back.
- `layoutBodyLabel(cx, em, nameW, chevW, clearLeftOf?)` → the name's x, the
  two chevrons' centres, the nudge applied, and the label zone's half width
  (name half width + gap; the clip for the slide). `clearLeftOf` is the x
  the left chevron's left edge may not pass (the "30" numeral's bounding
  circle plus 0.35 em); a deficit nudges the group right by exactly that.
- `slideProgress(slide, nowMs)` → 0…1 over `SLIDE_MS` = 250, eased out.

### 2.2 Drawing (`peripheral-hands.ts`)

Per frame, per dial: measure the name and the ‹ glyph at the label font
(`OUTER_DIAL_TITLE_RATIO · R`, as today) and 0.8 × it; on the altitude dial
compute `clearLeftOf` from the "30" numeral — its centre through
`demiRadialTextCenter` (new, shared with `drawDialNumbersDemiRadial` in
draw-utils.ts so the two cannot drift), its extent as the bounding circle of
the rotated glyph; lay out; draw the chevrons at 45 % (90 % when hovered)
and the name — or, while a slide runs, both names offset and faded inside a
clip rect of the label zone. The module keeps the slide state:
`beginBodyLabelSlide(fromPlanet, toPlanet, dir, nowMs)` (a no-op under
reduced motion) and `bodyLabelSliding(nowMs)` for the loop.

### 2.3 Entry (`observatory-entry.ts`)

- The canvas click resolves `dialHalfAt` on the altitude dial, then the
  azimuth dial; a hit cycles by ±1 with `cycleSelectablePlanet`, starts the
  slide, and does what it did (env variable, `op`, `updater.reset()`,
  `scheduleFrame()`). The drag-suppressed synthetic click stays suppressed.
- `pointermove` (mouse only) tracks which chevron target is under the
  pointer; a change redraws (`scheduleFrame`) and the cursor becomes a
  pointer over a target (the map's crosshair is unaffected — they do not
  overlap). `pointerleave` clears it.
- The loop's `animating` ORs `bodyLabelSliding(now)` so the 250 ms slide
  gets frames even on a stopped clock.
- `onSharedChange` keeps snapping (no slide).

### 2.4 Not doing

`?cycle=N` kiosk auto-cycle (parent §3.3 C — only if a kiosk use ever
exists); a hover state on touch.

## 3. Steps

1. draw-utils: `demiRadialTextCenter`, used by `drawDialNumbersDemiRadial`.
2. body-selector.ts + tests (`src/observatory/__tests__/body-selector.test.ts`).
3. peripheral-hands.ts: chevrons, nudge, hover alpha, slide.
4. observatory-entry.ts: halves, slide start, hover, animating.
5. docs/observatory.md § Planet selection; src/help/observatory.html's
   Altitude and Azimuth paragraph; parent plan status.
6. `tsc`, vitest, build; pane checks (hit halves at desktop and phone
   sizes, `op` persistence, cursor); headless screenshots at desktop and
   phone size with Mercury selected (the nudge case) for Steve.

## 4. Implementation record (2026-09-23, build 2.0.155)

Everything in §3 landed. `tsc` clean; 8855 tests pass (7 new in
`src/observatory/__tests__/body-selector.test.ts`: the halves and their
44 px slop, the label layout and nudge, the slide's easing, the cycle, and
`demiRadialTextCenter` against the drawing code's placement).

Verified in the browser pane on the dist build (1280×800, rAF frozen so
state and cursor were read rather than pixels; dial centres from the
screenshot): clicks 30 px left / right of the altitude dial's centre step
`op` 0 → 7 → 6 (back, wrapping) and → 7 (forward); on the azimuth dial the
same rule (7 → 0 forward, wrapping; 0 → 7 → 6 back) — no longer the iOS
opposite directions; clicks on the main dial and between the two dials
change nothing. A mouse `pointermove` over either half sets the cursor to
`pointer`, over the main dial to none, and a touch pointer never does.

Real pixels (headless Chrome, close-ups enlarged 3×): at desktop size the
Sun label sits centred with faint ‹ › either side on both dials; with
Mercury the altitude dial's group is nudged right so the ‹ clears the "30"
(the azimuth dial's stays centred, as the mock predicted); at 440×956 the
chevrons are present beside "Mercury" on the phone-sized azimuth dial.

For Steve natively: the chevrons' weight at rest on the 4K and the phone
(45 % was the mock's call; tune here), the hover brightening, the slide's
feel and its 250 ms, the nudge on Mercury, and whether the halves feel
right on the phone (the altitude half-dial's forward target is its empty
right half).

## 5. Review round 1 (Steve, 2026-09-24; build 2.0.156)

- **Chevrons brighter**: at 45 % they got lost in the background starfield
  on a real display. `CHEVRON_ALPHA` is now **0.65** and the hover level
  (`CHEVRON_HOVER_ALPHA`) **1.0** as starting points. Still Steve's to tune
  in situ.

