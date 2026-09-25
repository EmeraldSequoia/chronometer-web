# Plan: a user options panel — or as little of one as we can get away with

**Status**: revision 11 (2026-09-24) — every part built. Part 6 (magnifier
gating) is
[2026-09-24-magnifier-speed-gating.md](2026-09-24-magnifier-speed-gating.md)
(build 2.1.8; Steve's review rounds replaced the four candidates with one
strict rule for mouse drags — 1 s at rest under 5 px/s to show, 10 px of
drift within a second to hide, so a slow crawl keeps it — whose knobs are
his to tune; touch drags are exempt, the bubble always up, since the
finger covers the point). Part 5 (the ‹ › body chevrons) is
[2026-09-23-observatory-body-chevrons.md](2026-09-23-observatory-body-chevrons.md).
Part 4 (the time controller: unit chips, one ◀ ▶ pair, any body) is
[2026-09-23-time-controller-redesign.md](2026-09-23-time-controller-redesign.md)
(build 2.0.150, awaiting Steve's native review; living description
[docs/time-controller.md](../docs/time-controller.md)). Part 1
([2026-09-17-chrome-targets-and-overflow-menu.md](2026-09-17-chrome-targets-and-overflow-menu.md)),
including the outcome of Steve's in-app review (desktop fine at 44 px; phones
always collapse to the ⋮ menu); Part 2
([2026-09-22-steady-state-frame-pacer.md](2026-09-22-steady-state-frame-pacer.md));
Part 3 with Part 7 folded in
([2026-09-22-settings-dialog-and-prefs.md](2026-09-22-settings-dialog-and-prefs.md);
living description in [docs/preferences.md](../docs/preferences.md)); Steve's
review round 1 applied 2026-09-23 (build 2.0.146), and its follow-up —
per-app sections, the Forget scope, the notice's text and icons, retiring
the storage-paradigm notice — implemented the same day (build 2.0.148):
[2026-09-23-settings-sections-and-forget-scope.md](2026-09-23-settings-sections-and-forget-scope.md).
Part 3 and that follow-up land as one commit. The handoff that started Part 3 is
[2026-09-22-options-panel-handoff.md](2026-09-22-options-panel-handoff.md).
Every question in §7 is decided. What remains is in-app tuning, noted in
each section: final button size (§3.1 A), chevron alpha (§3.3.1), the
magnifier heuristic (§3.6), the low-power cap value (§3.4 — shipped at 10).
Each part in §6 gets its own plan document when it is implemented.
**Created**: 2026-09-14
**Baseline**: cb731ca (`[Observatory] Update the sprites on the eclipse simulator ring`)
**Related**:
[2026-06-13-localstorage-state-and-sharing.md](2026-06-13-localstorage-state-and-sharing.md)
(persistence model, namespaces, share links),
[2026-07-17-time-controller-scrub-invisibility.md](2026-07-17-time-controller-scrub-invisibility.md)
(controller ghosting; the exclusion-rect lineage of the chrome engine),
[2026-07-07-per-face-render-gate-plan.md](2026-07-07-per-face-render-gate-plan.md)
(what 1× costs today),
[2026-07-25-map-pointing-phase-1-magnifier.md](2026-07-25-map-pointing-phase-1-magnifier.md)
(the magnifier), [docs/performance.md](../docs/performance.md) (hard constraints).

## 0. Summary

The brief: a common options page behind a gear icon on every app page, a
one-time "Got it" notice, and six candidate options — with a standing
instruction to push back wherever a design can serve everyone without a
setting. The nominal deliverable (the panel) is allowed to shrink or vanish.

Verdict at a glance. "Setting?" is whether a per-user control survives.

| # | Candidate | Serve-everyone alternative | Recommendation | Setting? |
|---|-----------|----------------------------|----------------|----------|
| 1 | App icon size | 44 px hit areas everywhere (pointer-type sizing as the fallback if desktop looks heavy); when the corner runs out of room, collapse every corner button behind one ⋮ menu button | Do both | **No** |
| 2 | Time controller | Redesign it once (unit-first, one big ◀ ▶ pair, any body for rise/set/transit); don't keep two controllers | Redesign, always on | **No** |
| 3 | Observatory body cycling | Make the body selector *visible* (a ◀ Body ▶ stepper); auto-cycle only as a kiosk URL parameter if a kiosk ever exists | Visible affordance: dim ‹ › chevrons beside the body name, nudged clear of the scale when needed (mock, §3.3.1) | **No** |
| 4 | Desired fps | Built-in 60 fps cap for steady-state rendering (nobody can see 240 Hz second hands); a single "Low power" toggle is the one thing here that can't be derived | Cap built in; low-power toggle (decided 2026-09-16) | **Yes (1 toggle)** |
| 5 | Per-app controls in the panel | Move only Observatory's noon-on-top (its footer disc is cryptic); leave Venezia / Vienna / Kyoto / Terra / Gaia controls where they are | Move one | Moves, doesn't add |
| 6 | Magnifier on map drag | Gate it on pointer speed: a fast sweep hides it, slowing down or stopping shows it | Speed gating | **No** |
| 7 | New candidates | **Keep screen awake** (Wake Lock; intent-only, the strongest genuine setting for a clock app). **Forget my settings on this device** (an action, not an option) | Add both | **Yes / action** |

What that leaves in the panel: three toggles and one action (§4).
Small, but two of the rows can live nowhere else, and it has to be *obviously*
a settings page (Steve, 2026-09-16): a **⚙ gear in the top-right whenever
there is room**, and when there isn't, every corner button including the gear
collapses behind **one ⋮ menu button** — the conventional place to look for
things that aren't on screen. (Revision 1 proposed a Settings section inside
the ℹ popup; rejected — nobody looks for settings under "i" or Help.) The
notice becomes a toast (not a modal) with a **Got it** button, repeated on
every load until it is clicked. The project still has substantial parts (§6); they are mostly not "options".

## 1. Principles used to evaluate

1. A setting is justified only when the right behaviour depends on something
   the app cannot observe: **user intent** (keep the screen on; trade motion
   for battery). When it depends on **device capability** (touch vs mouse,
   display refresh, viewport) or **context** (how fast the finger is moving),
   derive it and serve everyone.
2. **View state is not a preference.** Noon-on-top, the selected body, the
   face picks are shareable, live in the app namespaces already, and travel
   in share links. Device preferences must **never** travel in share links.
3. Every setting costs a panel row, a help paragraph, a test-matrix column,
   and a support question ("why does it look different on my phone?").
4. "Straightforward to implement" is necessary, not sufficient.
5. Existing hard constraints stand: full resolution, full update rate during
   scrub, no `backdrop-filter` on live overlays, 4000 BCE – 2800 CE.

## 2. Inventory — what exists today (the facts the plan rests on)

### 2.1 Corner chrome

| Page | Top-left | Top-right | Size | Layout |
|------|----------|-----------|------|--------|
| Face pages (single / all / selected) | back, all-faces, selected-faces, edit-picks (4) | fullscreen, info, *face name*, share, observatory, inspector (5 + label) | 36 × 36 px, 44 px pitch | [chrome-layout.ts](../src/shared/chrome-layout.ts) picks row / column / L per corner, translates then shrinks the grid when chrome would cover a face; groups declared at [engine-entry.ts:2147-2149](../src/engine-entry.ts) |
| Observatory | title | chronometer, inspector, info, share, fullscreen (5) | header band 32 px tall (`--obs-header-h`) | fixed band; **CC2 drops all chrome** (header, footer, time-bar, noon icon) when the safe rect can't hold the 200 × 368 time-controller popover — [layout.ts:95-99](../src/observatory/layout.ts), [observatory.html:99-108](../src/observatory/observatory.html). A phone in portrait can end up with no header at all: no info, share, apps, or location without rotating. |
| Inspector | — | info, share (2); no fullscreen button | 34 × 34 px | same engine, one group ([inspector-entry.ts:1052](../src/inspector/inspector-entry.ts)) |
| index.html | — | observatory, inspector, info | — | static |
| pick.html, eclipse-table.html | task pages: home link / table links; no app chrome | | | |

Touch-target references: Apple HIG 44 pt, Material 48 dp, WCAG 2.5.5 (AAA)
44 px, WCAG 2.2 2.5.8 (AA) 24 px. 36 px fails the platform guidelines; the
Observatory's 32 px header is worse. Adding a gear puts 10 buttons plus a
label on a face page.

Fullscreen: `body.is-fullscreen` hides every chrome element except the
fullscreen button ([face-template.html:279-301](../src/face-template.html),
[fullscreen.ts](../src/shared/fullscreen.ts), faux mode on iPhone). Overlays
stay reachable by hotkey (`h`, `t`, `l`).

### 2.2 Time controller

- Bottom-right L-shaped popover: upper panel **120 px** wide (transport row,
  rate label, five ◀ / ▶ step rows — year, month, day, hour, minute; **no
  seconds row**); lower panel min **200 px** with Date | Astro tabs
  ([time-controller.css:190,211-212](../src/partials/time-controller.css)).
  Astro tab: sunrise, sunset, moonrise, moonset, moon phase, sun transit,
  moon transit (7 rows). On single-face Venezia the Moon rows become
  body rows via `getSelectedBody` ([engine-entry.ts:2991](../src/engine-entry.ts));
  **Observatory does not pass `getSelectedBody`**, so its Astro tab is
  Sun/Moon only even though its dials have a selected planet.
- Step buttons are **11 px text with 4 × 2 px padding**
  ([time-controller.css:269-273](../src/partials/time-controller.css)); the
  astro ◀ / ▶ are 28 px wide. Nothing in the panel meets a touch-target
  guideline.
- Hold-to-scrub on a step button runs 10 units/s at a 10 Hz tick
  ([time-controller.ts:29-37](../src/shared/time-controller.ts)); the popover
  ghosts while scrubbing (July work). The Observatory layout reserves
  200 × 368 for the popover (CC2).

### 2.3 Observatory body selection

One body is shown on the altitude/azimuth dials, from seven
(Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn —
[obs-values.ts:61-69](../src/observatory/obs-values.ts)). Clicking the
altitude dial advances, the azimuth dial goes back (iOS `EOClock.mm` parity —
[observatory-entry.ts:279-283](../src/observatory/observatory-entry.ts));
the hands animate to the new body; persisted as `op`. The only visible
affordance is the body name drawn on the dials — nothing says "tap me".
Venezia, by contrast, shows nine 30 px planet icons plus ◀ Name ▶.

### 2.4 Frame loops at 1×

| App | While the clock runs | Per frame |
|-----|----------------------|-----------|
| Observatory | rAF **every display frame** (`continuous = !stopped \|\| animating`, [observatory-entry.ts:617-623](../src/observatory/observatory-entry.ts)) | full `drawFrame`: static blit, rings, hands, map, moon, eclipse. The second hands re-evaluate their *target* every **20 ms** ([obs-values.ts:143](../src/observatory/obs-values.ts)) and sweep at natural speed on **every frame** in between ([updater.ts:797-803](../src/shared/updater.ts)), so they do move at 240 Hz — in steps a quarter the size of the 60 Hz ones. |
| Inspector | same rule ([inspector-entry.ts:957-963](../src/inspector/inspector-entry.ts)) | re-renders the catalog every frame |
| Chronometer | `needsContinuousRender` is **false** at 1× ([time-controller.ts:390](../src/shared/time-controller.ts)); the loop sleeps on a boundary timer (`armIdle`) and runs rAF only while a hand is mid-snap, with the per-face render gate | awake ~85 % of the time on all.html; awake frames run at display rate |

Existing instrumentation: `?fps` readout (`p` hotkey, `f` is fullscreen),
`?drawstats`. The Battery Status API is already consulted for a face variable
([astro-env.ts:82](../src/shared/astro-env.ts)) — Chrome/Edge/Android only;
Safari never shipped it and Firefox removed it. No `prefers-reduced-motion`
handling. No Wake Lock anywhere.

### 2.5 Magnifier

Always shown during a map drag, mouse or touch; ≤ 140 px, offset 16 px (mouse)
or 44 px (touch) from the pointer, position and content lerped with a 60 ms
time constant ([earth-view.ts:386-406](../src/observatory/earth-view.ts),
[observatory-entry.ts:1293](../src/observatory/observatory-entry.ts)). Content
is a self-blit of the band plus crisp city dots and labels.

### 2.6 Persistence model

Namespaces `ec:shared`, `ec:chronometer`, `ec:observatory`, `ec:inspector`,
`ec:slots`, `ec:meta` ([app-state.ts:44-92](../src/shared/app-state.ts)).
URL-only fields: `embed`, `fps`, `tc`. Fallbacks: URL backend (file:// without
storage), in-memory. Share links carry `SHAREABLE_FIELDS`; in non-persistent
mode navigation links carry the **whole** query ([app-nav.ts:60-71](../src/shared/app-nav.ts)).
Cross-tab sync via storage events.

One-time-notice precedent: `ec:meta.noticeSeen` + an auto-dismissing toast with
an × ([app-state.ts:591-603](../src/shared/app-state.ts),
[incoming-settings-dialog.ts:217-237](../src/shared/incoming-settings-dialog.ts)).
If the flag can't be written it shows on every load.

## 3. The candidates

### 3.1 App icon size — and the hamburger

**Problem.** 36 px targets (32 in Observatory), up to ten corner items on a
face page, and a gear would add one more. On phones, larger icons eat the
face; on desktops they are visually heavy.

**Alternatives that need no setting.**

- **A. Bigger targets.** 44 px hit areas. Steve (2026-09-16): probably
  better on desktop too, so **start with 44 px everywhere** if that is the
  easiest first step, and judge in the running app; sizing by pointer type
  (`@media (any-pointer: coarse)`, which also catches touch laptops, with
  fine-pointer devices at 36 px) is the fallback if the desktop ends up
  looking heavy. **Glyphs stay at today's size** until seen in situ — it is
  the hit area that must grow; a glyph bump is a likely follow-up once we can
  compare. The chrome engine measures the elements, so it adapts with no
  further work; the Observatory header height follows (`HEADER_H` in
  [observatory-entry.ts:322](../src/observatory/observatory-entry.ts)).
- **B. Collapse behind a ⋮ menu when the corner runs out of room** (Steve,
  2026-09-16: three stacked dots — the "more" menu users already know from
  Android and the web). On wide layouts every button stays where it is, plus
  the gear. When the corner can't fit them, the corner shows **[⋮]
  [fullscreen]** and nothing else; the menu lists Settings, Share, Help /
  About, the cross-app links and, on face pages, Home / All faces / Selected /
  Edit selection — 44 px rows, closes on outside tap or Esc, no
  `backdrop-filter`, hidden by `body.is-fullscreen` like the rest.
  - *Fullscreen stays outside the menu* (Steve, 2026-09-16: the exit
    button is the one required control in an otherwise chrome-free view).
    So the corner has three states: the full row; collapsed, [⋮]
    [fullscreen]; and fullscreen mode, [exit] alone — the last is today's
    behaviour, unchanged.
  - *Collapse-only:* the ⋮ never appears on wide layouts (Steve,
    2026-09-16) — one convention per layout.
  - *Phones always collapse* (Steve, 2026-09-17, after using build 2.0.132
    on an iPhone 18 Pro Max): on a phone the icons are noise even when they
    fit. A short side ≤ 500 CSS px collapses every page, index included,
    portrait or landscape; the rule below covers larger viewports.
  - *Trigger on larger viewports:* not a media query. The chrome engine already knows whether the
    preferred configuration fits at `dy = 0`; collapse when the full set
    would force the content to move or shrink. Hazard: collapsing changes the
    item count, which changes the layout, which could un-collapse — evaluate
    the full set once per viewport size and latch the result (hysteresis).
  - *Observatory:* the header always has room for [⋮] [fullscreen] at
    375 px, so the **CC2 chrome-drop becomes a collapse, never "nothing"**.
    Today a portrait phone can lose every control.
  - *Inspector, index:* the same menu component; index.html has no content to
    protect, so it collapses by width alone.
  - One new shared component (the menu), used by all four page types; the
    Settings dialog it opens is §4's.
- **C. A Settings section inside the ℹ popup.** Revision 1's proposal —
  withdrawn. Steve's objection (2026-09-16): it must be obvious that a
  settings page *exists*, and under an "i" button or a Help page is not where
  anyone looks. Agreed; the discoverability argument outweighs the
  one-fewer-overlay argument.
- **D. An icon-size setting.** Rejected. The people who need bigger targets
  are exactly the people who won't find a setting behind a 36 px gear.

**Recommendation.** A + B. No setting. The gear is a permanent top-right
button wherever there is room, next to ℹ in every configuration
(`rowOrder` keeps its neighbours stable — see the chrome-buttons memory);
otherwise it is the first row of the ⋮ menu.

**Cost.** A: CSS plus the Observatory header variable — small. B: moderate —
one shared menu component; the collapse rule in the three chrome consumers
(face pages, Inspector, Observatory header) with latching; Observatory
chrome-drop reworked into collapse; help text. Risk: two different corner
states to keep visually consistent — the collapsed state must not move the
fullscreen button.

### 3.2 Time controller

**Direction (Steve).** Bigger buttons; choose the unit first (sec / min / hr /
day / month / year, or rise / set / transit / phase), then one ◀ ▶ pair; the
astro choices add a body picker so rise/set/transit work for any planet on
any page. The question: option, or always?

**Always** (decided 2026-09-16). Two controllers means two help sections, two layouts to fit in
CC2, and two test matrices; a "which controller" preference is precisely the
noise the brief is trying to avoid; and the current controller fails the
touch-target bar on every device, so this is not a choice between two good
designs.

**Design notes and pushback on the details.**

- *Modes cause mode errors.* Unit-first makes ◀ ▶ modal. The mitigation is
  that the pair **shows its unit in large text** ("◀ 1 day ▶",
  "◀ Moonrise ▶") so the state is never hidden; the time-bar readout already
  shows the offset after a step.
- *Chip layout.* Ten unit chips at ≥ 44 px don't fit one 200 px row; two rows
  of five (sec min hr day mo yr | rise set transit phase — 6 + 4, split 5/5)
  ≈ 220 px wide. A nine-body icon row is ~300 px, too wide; use a
  **◀ [icon Name] ▶ body stepper** like Venezia's (one row, big targets,
  always shows the current body).
- *Phase is Moon-only*: choosing it fixes the body to Moon and hides the
  stepper. Rise / set / transit apply to every body; the polar no-event case
  keeps the existing flash-fail.
- *Seconds* becomes a step unit (missing today).
- *Body default and coupling* (**decided: decoupled**, Steve 2026-09-16). Two bodies are in play: the one the *page shows* (Venezia's
  face body, Observatory's alt/az dial body) and the one the *controller
  steps by* (its new ◀ Body ▶ row). *Coupled* would mean they are the same
  thing: pick Mars in the controller and Venezia switches to Mars (and vice
  versa). *Decoupled* means the controller's body is only "whose rise / set
  / transit do I jump to", and picking Mars there leaves the face on Jupiter.
  Decoupled, defaulting to the page's body when it has one (else Moon) —
  coupling would make the controller a second, hidden way to change the face,
  and on all.html or the Inspector there is no page body to couple to anyway.
- *Persistence*: selected unit and body per app, replacing `tp` (same routing
  as `tp` today).
- *Footprint estimate*: transport (44) + rate label (16) + chip grid
  (2 × 44 + 8) + body row (44, astro only) + ◀ ▶ pair (56) + Date section
  (~110) ≈ 380–420 px tall × 220 wide — about today's 200 × 368, with every
  target ≥ 44 px and no separate Astro pane (today's tallest state). If height
  bites on phones, the Date inputs collapse behind a "Set date…" disclosure.
  The Observatory CC2 threshold is re-derived from the new size.
- *Scrub*: hold on ◀ / ▶ scrubs by the selected time unit. Astro chips stay
  tap-only at first (each astro jump is a rise/set/transit search; a 10 Hz
  repeat would be a perf question of its own).
- *Keyboard*: ← / → stepping by the selected unit is a natural follow-on, not
  part of this.

**Setting:** none. **Recommendation:** do it as its own part — the largest one.

### 3.3 Observatory body cycling

**Problem.** One body on the alt/az dials and an invisible affordance.

- **A. Make the affordance visible.** Turn the body-name caption into a
  ◀ Body ▶ stepper drawn on the canvas and hit-tested like the dials, or a
  small icon strip under the dials on wide layouts. Keep the tap-a-dial
  shortcut. No setting. (Resolved by the mock, §3.3.1.)
- **B. Auto-cycle by default, stop on tap.** Pushback: perpetual motion on a
  reading instrument (a user comparing Jupiter's altitude finds the dial
  swapped mid-read); the animating hands defeat the 1× idle and energy story
  (§3.4); a share link can't capture "cycling"; and "stops when you tap" is
  one more invisible mode.
- **C. Auto-cycle as an option (every N s).** This is a kiosk / wall-display
  feature. If it is ever wanted, a **URL parameter** (`?cycle=10`) serves the
  kiosk story better than a panel row: a kiosk is configured once, by URL, and
  the parameter is bookmarkable. Keeps the panel clean.

**Recommendation.** A — but the *at-rest look decides* (Steve, 2026-09-16:
Observatory's appearance has been appreciated for fifteen years; most people
will never use this feature even once it is discoverable, so what the dials
look like when nobody is touching them dominates). The candidate treatments
are rendered from the real dial in §3.3.1. C is not needed now; a kiosk URL
parameter can be added later. No setting.

#### 3.3.1 Mock: the body label at rest (rendered 2026-09-16)

Rendered from the real dial code (static cache + hands + label) at 1280 × 800,
Moon selected, San Francisco, 2026-09-16 20:30 PDT — a scratchpad harness
(`scratchpad/mock/harness.ts`, esbuild bundle, headless Chrome screenshot);
nothing in the repo changed. The images were reviewed on 2026-09-16/17 and
not kept (Steve's call); the harness lived in the session scratchpad and is
gone with it, so the tables below are the record. Seven treatments of the
body name that sits at the top of each alt/az dial:

| | Treatment | At rest, whole Observatory at ½ size | Close-up |
|---|---|---|---|
| v0 | today: name only | baseline | — |
| v1 | dim ‹ › chevrons at 45 % flanking the name | essentially invisible at a glance; visible when you look at the dial | reads as a control, quietly |
| v2 | small solid triangles at 70 % | noticeable; the dial gains a control | clearly a stepper; heavier than the dial's own typography |
| v3 | pill outline around the name | a new shape on the dial face | reads as a button; most foreign to the look |
| v4 | seven body dots under the name | a new element; unreadable at this size | busy; competes with the scale numerals |
| v5 | nothing at rest; chevrons + highlight only on hover / touch | identical to today | engaged state shown; touch users get no invitation at rest |
| v6 | dropdown caret after the name | small; off-centre name | reads as a form control, out of character |

Observations: v3, v4 and v6 change the character of the dial and are out.
v2 is honest but heavy. The choice is between **v1** (a hint that costs
almost nothing at rest) and **v5** (costs nothing at rest, but on a phone
there is no hover, so the affordance is only revealed *after* a tap — which
is today's discoverability problem restated). Recommendation: **v1 at
30–45 %**, with the chevrons also acting as the tap targets (‹ back, › forward
— which retires the "altitude dial forward, azimuth dial back" oddity while
keeping the whole-dial tap as a shortcut), plus v5's highlight on hover for
mouse users. Alpha to be tuned in situ; a phone render is worth a look
before committing since the label scales with the dial.

**Widest-name check (2026-09-16, second and third renders).** Steve agreed
with v1 at 45 % but asked to see the widest name. In the label font Mercury is
the widest body name by a margin (60 px at the desktop dial size; Jupiter 50,
Saturn 49, Venus 46, Moon 42). It exposes a structural problem on the
**altitude dial**, which is a half-dial with its 0…90 scale on the left: with
Mercury, the left chevron lands against the "30" numeral, and since every
dimension scales with the dial radius it does so at every size (desktop and a
390 × 844 phone render alike). The azimuth dial is a full circle with open
space at the top and has no such problem. Four fixes rendered:

| | Fix | Result |
|---|---|---|
| a | as proposed (full-size ‹ ›, 0.5 em gap) | ‹ touches "30" with Mercury |
| b | 0.8× chevrons, 0.3 em gap | still crowded |
| c | as b, with the whole group nudged right until ‹ clears "30" | clears, but the name is now a few px off the dial's centre line while "Altitude" below stays centred — a small wart, only for Mercury |
| d | single › after the name, name stays exactly where it is today | clean for every name on both dials, at every size — but one-directional |

**Decided: c** (Steve, 2026-09-17) — two chevrons, so that overshooting the
body you wanted is one tap back rather than a lap around the cycle. Spec:

- ‹ › at 0.8 × the label font, 45 % alpha, 0.3 em from the name.
- On the altitude half-dial only, when the left chevron would come within
  0.35 em of the "30" numeral (Mercury today; any future long name), the
  whole name + chevron group shifts right by the minimum that clears it.
  Short names never move, so the at-rest look for the usual bodies is
  unchanged; for Mercury the name sits a few px right of the dial's centre
  line, which the mock showed to be a minor wart.
- **Touch targets are 44 px regardless of glyph size** (Steve, 2026-09-17).
  The chevrons are ~7 px on a phone dial, so their targets cannot be squares
  around the glyphs — on a 390 px phone the altitude dial is only ~83 px
  across and two 44 px squares would overlap each other and the hub. The
  rule instead: **the dial's left half is the "back" target and its right
  half the "forward" target**, each extended with slop to at least 44 px in
  both dimensions, and the chevrons sit inside their halves as the visual
  hint. This replaces today's iOS-parity split (altitude dial forward,
  azimuth dial back) with the same left/right split on both dials; it is
  the more legible rule and the chevrons now say so.
- Hover (mouse): the hovered chevron brightens to ~90 %.
- **Label animation on a body change** (Steve, 2026-09-17): the outgoing
  name slides out *in the direction of the tapped chevron* while fading,
  and the incoming name slides in from the opposite side, about 250 ms,
  clipped to the label zone so nothing crosses the numerals or the hub.
  Same animation whichever target was hit (chevron or dial half), so the
  motion teaches the chevrons to someone who never noticed them and
  confirms them to someone who did. The hands' existing sweep to the new
  body runs concurrently. Reverse direction for ‹; cross-tab or share-link
  body changes snap without the slide (no gesture to explain).
- Help text gains one line under Observatory's peripheral dials.

### 3.4 Frame-rate target and energy

**Facts.** Observatory and Inspector draw on every display frame while the
clock runs; on a 240 Hz display that is four times the work of 60 Hz for no
visible gain (the second hands do move on every frame, but a 6°/s hand moves 0.1° per
60 Hz frame and 0.025° per 240 Hz frame — a fraction of a pixel either way). ProMotion phones and iPads (120 Hz) pay double. Chronometer's
1× loop is boundary-scheduled, but its awake windows are the snap animations,
which run at display rate.

- **A. Built-in 60 fps cap for steady state.** Not a setting: nobody wants
  240 Hz second hands and, per the brief, nobody can see them.
  - Steady state = 1× / −1× / offset, no animation in flight, no drag, no
    scrub. Bypass the cap when `timeController.currentRate !== null`,
    `dragState !== 'idle'`, `updater.anyAnimating()`, or a step button is
    held — those keep raw rAF, as the brief asks.
  - Implementation: a shared frame pacer in `src/shared/` (setTimeout to the
    next slot, then rAF — the pattern Chronometer's `armIdle` /
    `onIdleWakeup` already uses), consumed by all three loops. Granularity at
    240 Hz is 4.2 ms, so 60 fps lands within a frame of jitter.
  - Chronometer subtlety: its awake frames are mostly mid-snap frames, i.e.
    exactly the motion case, so the cap applies to almost nothing there. The
    win is Observatory and Inspector.
- **B. Low-power mode (~10–12 fps steady-state cap) — decided, build it**
  (Steve, 2026-09-16). It is intent: "I'd rather have a stepping second hand
  than the battery cost." Not derivable, and not to be keyed on
  battery-vs-mains either: laptops, phones and tablets are on battery almost
  always, so "on battery" is not a useful signal — and the Battery Status API
  is absent on Safari, iOS and Firefox anyway. Since the panel exists, the
  toggle costs one row.
  - *Form:* one toggle, "Low power (slower hand motion)". Not a numeric fps
    field. Same exemptions as A: scrub, drag and in-flight animations run at
    full rate. In Chronometer it also coarsens the snaps; that is what low
    power means.
  - *Measurement* is now for tuning the cap (10 vs 12 vs 15 fps) and for
    the release note, not a gate: `powermetrics` on the 240 Hz Mac Studio at
    uncapped / 60 / low (native only — the VM caps rAF at 60), and a
    30-minute battery-percentage drain on an iPhone at 60 vs low. Energy ∝
    frames × per-frame cost, so 60 → 10 removes ~83 % of steady-state render
    work; the absolute saving on a phone is a guess until measured (a few
    hundred mW against a ~1–2 W screen).
- **C. A numeric "desired fps" field.** Rejected. Numbers invite tinkering and
  support questions; two positions cover every real story.
- **Also:** honour `prefers-reduced-motion` automatically (values snap
  instead of sweep). Tiny, separate, no setting.

**Recommendation.** A built in (its own part; touches all three loops). B
built as the panel's one behaviour toggle.

### 3.5 Per-app controls in the panel

- **Observatory noon-on-top: move it.** The footer half-disc is cryptic, and
  removing it frees the footer centre — which also retires the A5 icon-dodging
  (`positionNoonIcon`, [observatory-entry.ts:1026](../src/observatory/observatory-entry.ts);
  see [docs/observatory.md § Noon-on-Top](../docs/observatory.md)).
  It is view state (`onoon`, shareable), so the panel row reads "Observatory:
  noon at the top of the 24-hour dial" and writes the same `onoon` — no
  storage change. **Consequence:** the panel must be reachable inside
  Observatory on the layouts where chrome is dropped today (§3.1's fix);
  moving a control into a panel a phone user can't open would be a
  regression. On Observatory pages the Got-it notice (§4) also says the
  noon control now lives in Settings, so returning users find it.
- **Vienna's noon pill (`vnoon`)**: leave it. It sits next to the face and is
  discoverable; a duplicate panel row is noise.
- **Venezia body, Kyoto toggles, Terra / Gaia cities**: stay in place (agreed
  in the brief).
- **Time controller visibility, location**: already buttons plus hotkeys.

### 3.6 Magnifier during map drag

**Problem.** The bubble distracts from the whole-map effect when sweeping
across continents.

**Alternative without a setting — speed gating.** Speed is intent: a fast
sweep means "what happens when I move far"; slowing down or stopping means
"where exactly am I". Fade the bubble out (~150 ms) when the pointer exceeds
v_hi (order 300 CSS px/s ≈ 25° of longitude per second on a phone band) and
back in below v_lo (~100 px/s) or at rest. Hysteresis avoids flicker; the
existing 60 ms lerp already smooths the content. Cheap: earth-view.ts already
tracks the smoothed position, so a velocity estimate is a few lines. Same rule
for mouse and touch (touch already carries the 44 px offset). Tune with the
same on-device feel pass the magnifier had.

*Weaker alternative considered:* magnifier only on coarse pointers (the finger
occludes the point; a mouse has the crosshair). Rejected — the city labels are
the value, and 1 px is San José → San Francisco on a laptop too.

**Setting:** rejected. **Recommendation:** start with speed gating (Steve,
2026-09-16: fine as a start, not convinced it is the right knob). Alternatives
to try in the same feel pass, all a few lines on one velocity / displacement
estimate: *dwell-to-show* — the bubble appears only once the pointer pauses
(~200 ms) and then stays until the pointer has travelled a long way from where
it appeared (a distance threshold, say a third of the band width); or a
*combination* — show on pause or slow movement, hide on fast movement or large
displacement. Compare on device before choosing.

*Implemented 2026-09-24 —
[2026-09-24-magnifier-speed-gating.md](2026-09-24-magnifier-speed-gating.md).
Built first with all three plus `off` switchable for a comparison; Steve's
review the same day (its §7) settled on one much stricter rule instead —
the bubble is for very small motions only: 1 s at rest (average under
5 px/s; round 3 halved it from 2 s) to show, 10 px of drift within the
last second to hide (round 2: a trail anchor, so a slow crawl keeps it).
Round 4, from the phone: touch drags are exempt — the finger covers the
point, so there the bubble is always up.*

### 3.7 Other candidates

**Proposed — both accepted 2026-09-16.**

- **Keep screen awake.** A clock that lets the phone sleep is not a clock.
  `navigator.wakeLock.request('screen')` — Chrome 84+, Safari 16.4+, Firefox
  126+; no permission prompt; released on `visibilitychange` hidden and
  re-acquired on visible (the existing wake-triggers seam is the right
  neighbour). Intent-only, so a genuine setting; default off; per device;
  offered only when `'wakeLock' in navigator`. It is also what makes the
  low-power toggle matter.
- **Forget my settings on this device.** Clears `ec:*` and reloads. The
  privacy text already tells users their settings live in local storage; the
  button is the honest counterpart, and a support tool ("try Forget
  settings"). An action, not an option; trivial.

**Considered and rejected.**

- Reduced motion → honour the OS setting automatically (§3.4).
- Show the fps readout → stays a diagnostic (`?fps`, `p`).
- 12/24-hour time, date format → follow the locale where not already.
- Default Chronometer landing page → already solved by "most recent page"
  (7d60c27).
- Dark / light, colours → out of scope per the brief.
- Hotkey remapping → no.
- Open in fullscreen on load → browsers require a gesture; impossible.

## 4. The panel: contents, shape, notice, storage

Contents (all decided):

| Row | Kind | Scope |
|-----|------|-------|
| Keep screen awake | toggle | device |
| Low power (slower hand motion) | toggle | device |
| Observatory: noon at the top of the 24-hour dial | toggle | view state (`onoon`, unchanged) |
| Forget my settings on this device | action | device |

Show all rows on every page (the brief asks for one common page; four rows is
not overwhelming, and the Observatory row is shared state anyway).

**Shape — decided 2026-09-16.** A dedicated **Settings dialog**, opened by the
⚙ gear when the corner has room and by the ⋮ menu's first row when it
doesn't (§3.1 B). It is obviously a settings page, which is the point; the
cost is one more overlay, kept small by reusing the existing modal
conventions rather than the ℹ popup's slider: `ensureModalStyles` /
`ec-modal` from
[incoming-settings-dialog.ts](../src/shared/incoming-settings-dialog.ts),
blur-the-content-behind (never `backdrop-filter`), park the render loop while
it is up, Esc closes, hidden chrome in fullscreen but the dialog itself still
reachable by hotkey. Hotkey: `,` (decided 2026-09-16; the desktop preferences convention).
The rejected alternative — a Settings section inside the ℹ popup — is
recorded in §3.1 C.

**The notice.** A **toast with a Got it button** (the paradigm-notice
pattern), not a modal — nothing in the panel blocks use of the app, and a
modal on first load is the most intrusive thing an app can do. Unlike the
paradigm notice it **does not auto-dismiss and has no ×**: it shows on every
page load until Got it is clicked (Steve, 2026-09-16), and the click is what
writes `ec:meta.optionsSeen`. In URL-mode sessions the acknowledgement rides
the query string, which navigation links already carry in that mode. Text
along the lines of: "Settings — keep the screen awake, low power, and more —
are behind the ⚙ (or ⋮) button, top right." On Observatory pages it adds
that the Midnight / Noon control now lives there.

**Storage.** Device preferences get their own namespace, `ec:prefs`:
never in `SHAREABLE_FIELDS` or share URLs, carried by navigation links in
non-persistent mode, cross-tab synced. Two ways to build it: extend `UrlState`
+ `namespaceOf` with a `prefs` namespace, or keep prefs **out of `UrlState`**
in a small `prefs.ts` (read/write `ec:prefs`, URL fallback, change events).
Recommend the separate module — it keeps the incoming-settings decision tree
and the share-link equality logic untouched.

## 5. Constraints every part must respect (the project-wide scope)

- **Fullscreen:** any new chrome is hidden by `body.is-fullscreen`; overlays
  remain reachable by hotkey.
- **Observatory CC2 / chrome-drop:** new chrome and the new controller size
  feed the layout thresholds; chrome-drop degrades to a minimal header, never
  to nothing.
- **Collapsed layouts:** the ⋮ menu holds everything, Settings first; the
  fullscreen button stays outside it in every state.
- **Share links never carry device prefs; navigation links in URL mode must.**
- **No `backdrop-filter`** on new overlays (blur the content behind); park the
  render loop under full-screen overlays.
- **44 px targets** for anything new, everywhere (decision 2), whatever the
  glyph size (decision 4).
- **Docs:** help pages, the README and help.html hotkey tables, and `docs/`
  updated in the same change (development rule 1).
- **Perf:** the pacer never touches scrub; run the perf-regression check for
  loop changes (rule 18); numbers come from the native 240 Hz machine.

## 6. Parts (proposed order; each gets its own plan doc when implemented)

| Part | Scope | Depends on | Size |
|------|-------|------------|------|
| 1 | 44 px targets everywhere first (judge in situ; pointer-type sizing as fallback; glyphs unchanged); shared ⋮ menu component and the collapse rule (latched engine signal); Observatory chrome-drop → collapse instead of none | — | M — **done 2026-09-17**, [plan](2026-09-17-chrome-targets-and-overflow-menu.md) |
| 2 | Steady-state 60 fps pacer in all three loops; honour `prefers-reduced-motion` | — | S–M — **done 2026-09-22**, [plan](2026-09-22-steady-state-frame-pacer.md) |
| 3 | `prefs.ts`; Settings dialog + ⚙ button (and its ⋮ row); Got-it toast; Keep screen awake; Forget settings; noon-on-top moved | 1 (menu, collapse rule) | M — **done 2026-09-22** (with 7), [plan](2026-09-22-settings-dialog-and-prefs.md) |
| 4 | Time-controller redesign: unit-first, any-body astro, 44 px targets; CC2 threshold re-derived | 1 (sizing conventions) | L — **done 2026-09-23**, [plan](2026-09-23-time-controller-redesign.md) |
| 5 | Observatory ‹ Body › chevrons (treatment c), 44 px half-dial targets, directional label slide on change, help line; (`?cycle=N` only if a kiosk use ever exists) | — | S — **done 2026-09-23**, [plan](2026-09-23-observatory-body-chevrons.md) |
| 6 | Magnifier gating, mouse drags — rest 1 s to show, 10 px within a second to hide; touch always up (Steve's rule, review rounds 1–4) | — | S — **done 2026-09-24**, [plan](2026-09-24-magnifier-speed-gating.md) |
| 7 | Low-power toggle (decided); cap value tuned by measurement | 2, 3 | S — **done 2026-09-22** inside Part 3 (`LOW_POWER_FPS` = 10, to tune) |

Order rationale: 1 and 2 are the largest user-visible wins and unblock 3; 4 is
the biggest and independent; 5–7 are small and independent. 7 could fold into
3 if the pacer (2) lands first — the toggle is one row plus one number.

## 7. Decisions log

Settled in Steve's reviews of 2026-09-16 and 2026-09-17 (numbering kept from
the original question list):

1. **Panel shape:** ⚙ gear whenever there is room; otherwise one ⋮ menu
   holding everything. (a) Collapsed corner = [⋮] [fullscreen]; fullscreen
   mode keeps only the exit button, as today (confirmed). (b) The ⋮ is
   collapse-only.
2. **Button size:** 44 px everywhere — judged in the app on 2026-09-17: fine on
   desktop, so no pointer-type fallback. Glyphs unchanged for now. On phones
   the question is moot: **every phone-sized viewport (short side ≤ 500 px)
   collapses to the ⋮ menu**, on every page.
3. **Time controller:** always the new design. Controller body **decoupled**
   from the page's body, defaulting to it (§3.2).
4. **Body cycling:** no auto-cycle; a kiosk URL parameter could come later.
   Treatment **c** (2026-09-17): dim ‹ › chevrons at 45 %, group nudged
   right on the altitude dial when a long name would collide with "30";
   touch targets 44 px (dial halves) regardless of glyph size; the label
   slides out and in in the chevron's direction on every change (§3.3.1).
5. **Frame rate:** built-in 60 fps cap; low-power toggle built without a
   measurement gate and not keyed on battery state.
6. **Noon-on-top:** moves to Settings for Observatory only; Vienna's pill
   stays.
7. **Magnifier:** start with speed gating; try dwell-to-show and the
   combination heuristic in the same feel pass.
8. **Keep screen awake** and **Forget my settings:** both in.
9. **Notice:** toast with Got it, repeated on every load until clicked.
10. **Hotkey:** `,`.

## 8. Noticed in passing (not part of this project)

- The README's hotkey table says `f` toggles the fps indicator; the code and
  help.html have `f` = fullscreen and `p` = fps. The README is stale.
- Observatory's Astro tab never offers body rise / set / transit even though
  the dials have a selected planet (no `getSelectedBody` is passed). Part 4
  resolves it.
