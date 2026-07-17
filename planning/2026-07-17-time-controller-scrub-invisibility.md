# Plan: make the time controller invisible while scrubbing

> **Status: phases 1–2 implemented 2026-07-17** (phase 1 in build 2.0.42;
> scrub opacity retuned to **0.25** in 2.0.43 after Steve's native eyeball —
> 0.05 and 0.15 both read as fully invisible on a real display, 0.25
> confirmed good on the Chrome phone-size emulator; phase 2 in **2.0.44**).
> Phase 1: `.tp-hidden` (0.25, 0.15 s transition) engaged in `startHold()`,
> cleared in `endHold()`, with a stale-ghost guard in `showPopover()`.
> Phase 2: `.tp-ghost` (also 0.25, separate class so the levels can diverge;
> `.tp-hidden` declared after so a hold wins) + 1000 ms dwell timer in
> `ghostTap()`, called from `doStep()`, `handleAstroStep()` (success only —
> the flash-fail stays readable), `nowClicked()` (both Now buttons), and the
> transport pause/◀/▶ handlers. Exclusions honored: tab switches, ×,
> date-entry form. In-VM verified on Observatory + Chronometer (dist server,
> port 8813, 2.0.44 bundle): tap ghosts immediately and expires at ~1 s;
> repeated taps hold the ghost; hold composes (ghost expires mid-hold,
> `.tp-hidden` persists, release restores); transport/Now/astro all ghost;
> tab switch and date-input change do NOT; Chronometer canvas untouched.
> Compositor frozen in the VM tab, so fades verified with transition
> disabled. **Animation-aware restore added in 2.0.45** (same-day review):
> for step/astro taps the ghost restores at the later of the dwell and the
> app's animations settling (poll 200 ms, cap 4 s) — the panel's return
> doubles as the "change finished landing" signal. New optional
> `isSettled` config hook; defaults to `!updater.anyAnimating()` when the
> shared Updater is passed (Observatory/Inspector automatic), Chronometer
> passes an explicit any-enabled-face probe. Transport/Now taps keep the
> plain dwell — a running 1× clock never settles. Covered by
> [time-controls-ghost.test.ts](../src/__tests__/time-controls-ghost.test.ts)
> (jsdom, 9 tests: dwell, settle-wait, cap, re-arm, transport plain dwell,
> exclusions, hold composition, release-clears-ghost, stale-guard);
> live-verified in Observatory (ghost held ~1 s past dwell while the
> day-step sweep landed, then restored).
>
> **Scrub release restores immediately** (decided same-day): `endHold()`
> clears the initiating tap's ghost + timer, so hold = ghosted, release =
> restored, always. This also fixed a latent inconsistency where holds
> shorter than the 4 s cap settle-waited after release but longer ones
> didn't. Rationale: the user watched the whole scrub (nothing left to
> land — Chronometer force-snaps on release anyway), and release is when
> attention returns to the panel.
>
> **Phase 3 implemented 2026-07-17** (build 2.0.46), per the conservative
> §3 scope: the `isPopoverOpen()` exclusion branch of `onGridResize()` is
> removed and Chronometer passes no `onPopoverToggle` (open/close and
> Astro-tab switches no longer relayout or invalidate face caches). The
> overlap helpers and top-left-aligned layout path remain in place
> (unreachable) as substrate for the top-button task. Live-verified on
> all.html (17 faces) at a 900×620 viewport where `#tp-upper` genuinely
> overlays a face: open / astro-tab / close all leave every face position
> and canvas size byte-identical; scrub + tap ghosting keep the overlay
> out of the way during interaction. All 8547 tests pass.
>
> **Outstanding: Steve's native eyeball** (fade feel, tap-ghost dwell, and
> the §3 sign-off that an idle-open popover overlaying faces is
> acceptable — single-face pages are the sharpest case). Phase 4's native
> half is that pass; the in-VM half is done. Future layering noted in
> review: keep the last-tapped button more opaque (requires per-element
> fading — container opacity caps children); revisit alongside the
> planned bigger-buttons task.
>
> Steve's calls: Option A for stepping; the ghost rule extends
> to transport taps (◀ 1×, 1× ▶, ‖, Now▶) — *any* time-actuating tap on the
> controller ghosts it briefly; scrub opacity starts at **0.05** (whisper,
> not 0) for eyeball tuning; step defaults (0.15 / 1000 ms / 150 ms) stand;
> Chronometer removal is **conservative** — remove only the controller area
> check, leave the rest of the layout machinery in place (it also serves the
> top buttons and bottom bars via container sizing).

**Goal.** While the user is actively scrubbing, fade the time-controller
popover out so the app underneath is fully visible. Once the popover never
needs to be *seen around* during time manipulation, it can be a pure overlay
in every app — which lets us delete Chronometer's popover-dodging grid
relayout machinery (~250 lines, plus the face-cache rebuild churn it triggers
on every open/close).

## 1. Current state (verified in code, 2026-07-17)

The controller is one shared partial + one shared module, consumed by three
apps:

- **DOM/CSS**: [time-controller.html](../src/partials/time-controller.html),
  [time-controller.css](../src/partials/time-controller.css). Two pieces:
  `#time-bar` (in-flow bar: date readout, offset, rate, Now button) and
  `#time-popover` (the L-shaped panel, `position: absolute; bottom: 0; right: 0`).
  The popover container is `pointer-events: none`; the sections
  (`#tp-upper`, `#tp-lower`, `#tp-close`) re-enable `pointer-events: auto`
  and carry their own translucent bg + backdrop blur.
- **Logic**: [time-controls-ui.ts](../src/shared/time-controls-ui.ts).
  The scrub lifecycle already has clean single entry/exit points:
  `startHold()` (~line 580, fires after `HOLD_DELAY_MS = 300`) and
  `endHold()` (~596, fires on mouseup/mouseleave/touchend/touchcancel).
  Discrete transitions: `doStep()` (~628, every step-button mousedown),
  `handleAstroStep()` (~716), `applyDateInputs()` (~774).
- **Chronometer** ([engine-entry.ts](../src/engine-entry.ts)): the only app
  that relayouts around the popover. When it opens, `onGridResize()` builds
  exclusion rects for `#tp-upper` (plus `#tp-lower` when the Astro tab is up),
  binary-searches face size × column count so no face overlaps, then
  binary-searches a shift position (~2098–2283). Open/close and Astro-tab
  switches drive a full relayout via `onPopoverToggle` (~3037–3049) and the
  `positionChanged` tracking (`wasShifted`/`wasAstroTab`, ~1999–2000,
  2288–2293). Every one of these relayouts changes face size → invalidates
  all face caches → ~100–350 ms sequential rebuild.
- **Observatory** ([observatory-entry.ts:1308](../src/observatory/observatory-entry.ts))
  and **Inspector** ([inspector-entry.ts:822](../src/inspector/inspector-entry.ts)):
  the popover is already a pure overlay; no layout participation. But it
  *covers* the bottom-right of the display while scrubbing — in Observatory
  that's dial territory, which is exactly what you want to watch mid-scrub.

Key observation: **the `#time-bar` is not the popover.** The date/offset/rate
readout lives in the bar, which stays visible in-flow. Hiding the popover
during a scrub loses no information — the changing date and the scrub rate
remain on screen the whole time.

## 2. Design: opacity ghosting on the popover

One mechanism, shared by all three apps for free (partial + shared module):

- CSS classes on `#time-popover`:
  - `.tp-hidden` → `opacity: 0.25` (scrubbing — enough for the app to show
    through while the controls stay findable; eyeball history: 0.05 and
    0.15 both read as fully invisible on a real display, Steve 2026-07-17)
  - `.tp-ghost` → tap ghosting (steps, astro jumps, transport — see §4).
    Planned at 0.15, but that's now known to read as invisible — likely
    unify with the scrub level at 0.25, i.e. one class may serve both;
    settle when phase 2 starts.
  - plus `transition: opacity 0.15s` on the container.
- **Opacity only — never `display: none` or `visibility: hidden`.** The hold
  gesture depends on the held button continuing to receive
  `mouseup`/`mouseleave`/`touchend`; hidden-visibility elements stop
  hit-testing and would strand the hold. Opacity keeps the full event flow
  and keeps repeated taps landing on the same (faint or invisible) button.
- Wiring in `initTimeControls()`:
  - `startHold()` adds `.tp-hidden`; `endHold()` removes it. During the hold
    the pointer is already down on the button, so near-invisibility is safe —
    there's nothing to aim at until release, and release restores it.
  - Tap ghosting (steps, astro, transport) per §4.
  - No API/config changes; apps pick it up automatically.

What stays visible during a scrub: the whole app, plus `#time-bar` with the
live date, the `(+3d 4h)` offset, and the rate label (the bar shows
rate/offset whenever time is overridden, which a scrub always is).

Side notes:

- The `.holding` button highlight becomes invisible mid-scrub — moot, the
  finger is on the button.
- `#tp-close` floats above the popover top edge but is a child, so it fades
  with the container. Correct.
- `mouseleave` → `endHold()` still works with opacity 0 (element hit-tests
  normally), so sliding off the invisible button cancels the scrub and fades
  the popover back — reasonable recovery behavior.

## 3. The payoff: retire Chronometer's popover area check (conservatively)

With the popover guaranteed near-invisible during scrubs (and ghosted on
every actuating tap, per §4), it becomes acceptable for it to simply overlay
the face grid when open-and-idle, exactly like Observatory.

**Scope decision (Steve, 2026-07-17): be careful here.** The grid layout
machinery also works around the top buttons and the bottom bars (via
container sizing — `triggerManualResize()` subtracts the location panel,
time bar, planet selector, etc. heights, ~2401–2409). None of that changes.
The first pass removes **only the controller area check**:

- Remove the `if (timeUI?.isPopoverOpen())` branch of `onGridResize()`
  (~2098–2283): the tp-upper/tp-lower exclusion rects, `configFits`, and
  both binary searches. Everything else in `onGridResize()` — `optimizeGrid`,
  the centered/nestled layout, resize debouncing — is untouched.
- Make Chronometer's `onPopoverToggle` (~3037–3049) stop calling
  `onGridResize()` (no-op or drop the config entry). Without this, popover
  open/close and Astro-tab switches still force a relayout whose
  `positionChanged` term (`wasAstroTab`, ~2288–2293) invalidates every face
  cache for nothing.

> **Superseded 2026-07-17:** the "kept, not deleted" decision below was
> reversed after seeing the post-phase-3 state — the valuable algorithm was
> already git-only and the remaining plumbing was rot-prone. It was all
> deleted in
> [2026-07-17-time-controller-cleanup.md](2026-07-17-time-controller-cleanup.md)
> (build 2.0.47); the algorithm stays recoverable from git history for the
> top-button task. The original reasoning is retained below for context.

**The exclusion machinery is kept, not deleted** (Steve's question,
2026-07-17). Verified: `computeFaceCenters()` is *not* used on ordinary
window resize — its only call site is inside the popover branch (2181); the
normal resize path positions faces with its own inline geometry
(~2329–2386). `computeFaceCenters` exists to *predict* where the full-size
centered layout would land so the branch can test for overlap before
shrinking/shifting. So removing the branch orphans it — but the machinery
(`computeFaceCenters`, `circleOverlapsExclusion`, `configFits`, the
size/shift binary searches, the `useTopLeftAlign` layout path) is generic
over exclusion rects: the popover was just one *source* of rects. An
upcoming task — keeping the top buttons (ⓘ and the app-nav buttons) clear
of faces — is the same problem with different, always-present rects. That
task's shape will be discussed once this one is substantially complete;
until then the machinery stays as its substrate (likely future form:
`onGridResize` takes exclusion rects as an input, button bounding boxes
become the permanent source).

**Cleanup list** (small, deferred until after behavior sign-off):

- One of the duplicated circle-vs-rect testers goes:
  `anyFaceOverlapsRect()` (~2050, already dead today) vs.
  `circleOverlapsExclusion` — keep one.
- The 320 ms post-transition relayout timer in `switchTab()`
  ([time-controls-ui.ts:691](../src/shared/time-controls-ui.ts)) — serves
  nothing once Chronometer's hook is a no-op (Observatory uses
  `onPopoverToggle` as a redraw kick, so the hook itself stays).
- `wasShifted` / `wasAstroTab` / `POPOVER_GAP`: `wasAstroTab` and
  `POPOVER_GAP` are popover-specific (though a gap constant reappears,
  possibly renamed, when button rects arrive); `wasShifted`-style
  position-changed tracking likely *earns its keep* once exclusion rects are
  always active — leave it.

Behavioral consequences to sign off on:

- Opening/closing the popover no longer resizes faces → **no cache-rebuild
  churn**; open/close becomes instant. Faces keep full size always (in line
  with the no-resolution-for-fps principle: nothing shrinks anymore).
- When open and idle, the popover covers the bottom-right of the grid — up to
  ~1–2 faces partially, depending on grid shape. Mitigations: it ghosts the
  moment you interact with time (§4), Escape and × close it, and the faces
  under it keep animating (no occlusion special-casing — same as Observatory
  today, and no new render cost since those faces were always drawn).
- `?tc=true` deep links: startup layout is now identical with or without the
  popover — one less initial-relayout path.

## 4. Tap ghosting — **decided: Option A, extended to transport**

Stepping is the hard case because each tap is discrete: the user taps
◀1d / sunrise-▶ repeatedly and wants to *watch the change land* between taps
— but their next tap needs a target, so full invisibility doesn't work.

**The rule (Steve, 2026-07-17): whenever you tap something on the controller
that actuates time, it immediately goes transparent for about a second.**
One consistent behavior across:

- **Step buttons** (`doStep()`): add `.tp-ghost` (~0.15) immediately,
  (re)start a ~1 s dwell timer; on expiry with no further activity, fade
  back to full opacity. Buttons stay fully interactive while ghosted; faint
  outlines are enough to keep tapping in place.
- **Astro jump buttons** (`handleAstroStep()`): same. The Observatory
  killer use case — tap through sunrises while actually seeing the sky dial.
- **Transport buttons** (◀ 1×, 1× ▶, ‖, and both Now buttons): same ghost +
  dwell. This addresses the run-backward case: there is no fast transport
  rate (see corrected §6), but starting 1×-reverse with the popover open
  covers content at the very moment you want to watch time change direction.
  The tap-ghost shows that moment; if the user then wants a long look they
  close the panel (× / Escape / the bar toggle).
- Scrub composition: every hold starts with `doStep()` on mousedown (ghost
  at 0.15), then `startHold()` at +300 ms deepens to `.tp-hidden` (0.05) —
  a smooth two-stage fade.

**Exclusions** (the deliberate carve-outs from full consistency): the
Date/Astro **tab switches** and **× close** (panel navigation — you need to
see what you just revealed), and the **date-entry form** (fields + BCE
toggle) — `applyDateInputs()` fires on input `change` while the user is
reading/typing in the form; ghosting it mid-edit would be hostile. Revisit
after feel-testing if the inconsistency grates.

Risk: mis-taps on faint controls. Tunables: ghost opacity (0.10–0.25) and
dwell (700–1500 ms). Optional refinement if needed: keep the most recently
tapped button at a higher opacity than the rest of the panel.

Discarded alternatives, for the record: leaving steps opaque (invisible
step effects, weakest in Observatory); full hide with restore-on-timer (an
invisible-but-interactive panel is an accident trap); keyboard stepping
(complementary at best, no help on touch).

## 5. Phases

1. **Shared ghost mechanism (scrub).** CSS classes + transitions in
   [time-controller.css](../src/partials/time-controller.css); add/remove
   `.tp-hidden` in `startHold()`/`endHold()`. All three apps get it via the
   partial. Smallest reviewable unit; independently shippable.
2. **Tap ghosting.** `.tp-ghost` + dwell timer on step, astro, and transport
   handlers (§4). Transport buttons are built dynamically in
   `renderTransport()` — attach the ghost in their click handlers there.
3. **Chronometer area-check removal (conservative).** §3 scope only: the
   `isPopoverOpen()` branch of `onGridResize()` + neutralize the
   `onPopoverToggle` relayout call. The exclusion machinery stays as the
   substrate for the top-button task (§3); only the small §3 cleanup list
   runs later, after sign-off.
4. **Verification.**
   - In-VM: build via `build.sh` + dist server (fresh port, check the
     `build N.N.N` stamp — see dist-preview-cache-gotcha). Headless drive of
     hold-to-scrub in Observatory (frozen-rAF caveats apply) asserting class
     toggles and computed opacity; Chronometer: open popover → assert **no**
     face `canvas.width` change, grid positions unchanged, no cache rebuild
     log.
   - Existing tests: `time-controller-hold.test.ts` and
     `scrub-direction-snap.test.ts` cover the TimeController, not the DOM —
     they should pass untouched. New coverage if worthwhile: a jsdom test of
     the class lifecycle in `initTimeControls` (step → ghost, hold → hidden,
     release → restored, dwell expiry → restored).
   - Native/eyeball (Steve): ghost opacity + dwell tuning, the two-stage
     fade feel, mis-tap check on phone (touch targets while ghosted),
     backdrop-blur appearance at partial opacity, and the §3 sign-off that
     an idle-open popover overlaying faces is acceptable.

## 6. Risks & edge cases

- **Event flow while invisible** is the load-bearing constraint: opacity
  only, ever. A future refactor to `visibility`/`display` would silently
  break hold-release. Worth a comment at the class definition.
- **Backdrop blur at partial opacity**: the sections use
  `rgba(26,26,46,.96)` + `backdrop-filter: blur(16px)`; container opacity
  scales the whole composite. Probably fine; eyeball item.
- **No fast transport exists** (correction to the draft, verified
  2026-07-17): every non-1× rate comes from `setRate(RATE_OPTIONS[...])`,
  whose only call site is `startHold()` — hold-to-scrub. All transport and
  deep-link paths call `setRate(null)` (1×). The transport modes are exactly
  ◀ 1×, 1× ▶, ‖, and Now. The residual case is therefore 1× playback
  (notably reverse) with the popover open and idle: content under the panel
  is covered while time runs. Accepted, mitigated by the transport tap-ghost
  (§4 — you see the moment of actuation) and by closing the panel for a
  long look.
- **Observatory map-drag hold** (`isHeld`) is a location gesture, not a time
  scrub — no interaction with this work.
- **Idle render loops**: ghosting is pure CSS on a DOM element, so no
  scheduler kicks are needed beyond what scrub/step paths already do.

## 7. Decisions (Steve, 2026-07-17) and what's still open

Decided:

1. **Option A** (ghost + dwell) for stepping — "clearly best."
2. **Unified tap rule**: transport taps (◀ 1×, 1× ▶, ‖, Now▶) ghost exactly
   like steps — any actuating tap → transparent for about a second.
3. **Scrub opacity**: started at 0.05; native eyeball found 0.05 and 0.15
   essentially invisible → **0.25** as of build 2.0.43.
4. **Defaults**: dwell 1000 ms and fades 150 ms confirmed. Ghost opacity
   was 0.15, now superseded by the eyeball result — likely 0.25 (unified
   with scrub); confirm at phase 2 start.
5. **Conservative Chronometer removal**: only the controller area check goes
   in the first pass. The exclusion-rect machinery is *kept* as the
   substrate for the upcoming top-button overlap task (§3) — to be scoped
   once this task is substantially complete; only the small §3 cleanup list
   is deferred-then-deleted.

Still open (fine to resolve during implementation/eyeball):

- Single-face pages: with the area check gone, an idle-open popover covers
  part of the lone face. Check during the eyeball pass whether that's
  acceptable or wants a nudge (e.g. per-page popover anchor).
- Whether the date-entry form's exclusion from the tap rule (§4) feels
  inconsistent enough to revisit.
