# Scrub render performance: investigation plan (all-faces page)

**→ Continuing in a new session? Start with
[2026-07-06-session-handoff.md](2026-07-06-session-handoff.md)** (scoreboard,
tree state, next-step queue, measurement mechanics).

*2026-07-03, updated 2026-07-06 (timings-11)* · **Status: CHROME TARGET
ACHIEVED — 66–79 fps at no-flag baseline (was 29; wheel glyph-atlas cache +
probe fix). Safari: hand unification validated (26–34 fps); hand+wheel caches
worth ~14 fps (live shadow-blur hands = raster bomb). onecanvas REFUTED. Model
now settled: Safari defers per-canvas raster to post-rAF slack, and
**slack ∝ draw-operation count** (not canvas count — why onecanvas failed; not
resolution — dpr1 rejected by Steve, full-res is a hard constraint).
facebuffers ceiling (timings-11) proves it: reducing each face to one blit
takes Safari 26 → 44 fps and cuts slack 17 → 11 ms. That 44 is the OPTIMISTIC
ceiling (tick-rate stepping); a fidelity-preserving sandwich captures only the
slow astronomical layer's share, ~+5–10 fps. Next: middle-share
instrumentation to size the achievable fraction before building the sandwich.
Memory: 258 MB canvas baseline / 328 MB facebuffers at 4K.**

Follow-on to the scrub CPU work (eval/boundary/rise-set caching), which brought
scrub-by-day on all.html to ~27 fps. This plan covers the *rendering* side:
draw issuance + whatever the browser does after our rAF callback returns.

## Goal

**60 fps during scrub-by-day on all.html.** Whether that's achievable is itself
a discovery outcome of this investigation — the deliverable is either a
data-backed path to 60, or a clear statement of which wall we hit and its cost.
Moving 27→30 fps is explicitly *not* the goal, so "shave the tail frames"
tactics are insufficient on their own; the *average* frame must get much cheaper.

**Budget math.** 60 fps means ≤16.7 ms/frame sustained, worst case included.
Known per-frame CPU today is already ~15.3 ms (tick 4.47 + draw issuance 10.81,
max 26 ms) *before* any browser-side raster/composite cost. Two consequences:

1. Draw issuance (10.81 ms, 2.4× the tick cost) must come down by roughly half
   at minimum, independent of anything we learn about GPU time. "CPU" vs
   "non-CPU" rendering cost are coupled: every canvas command eliminated saves
   both issuance CPU and downstream raster.
2. Any real (non-quantization) browser-side cost we find stacks on top of that.

## Constraints & measurement environment

- **We develop inside a VM; authoritative numbers come from outside it.**
  Workflow for every experiment: build a flag-gated variant (`build.sh`, zip
  `dist/`), Steve runs it natively and pastes the `[scrub-perf]` console block
  back. Therefore **all instrumentation must be in-page and console-reported**
  — self-contained summaries, no attached-profiler dependency. In-VM runs are
  fine for smoke-testing flags and for *directional* comparisons only.
- **Baseline numbers context:** native machine is a Mac Studio M3 Ultra
  driving a 4K monitor ("looks like" 3360×1890) at **240 Hz** — both machine
  and monitor support 240 fps, and the browser delivers it (see next bullet).
  Browser window maximized but not fullscreen. The **VM caps rAF at 60 Hz**
  (confirmed by the Phase 0 quantum sampler: ~16.7 ms median), one more
  reason VM numbers are directional only.
- **Calibration points (native):** Observatory's full-screen single canvas
  runs 240 fps in Chrome at 1× forward and ~100 fps while scrubbing; Safari
  exceeds 200 fps forward. So raw single-canvas fill/composite throughput is
  *not* limiting on this hardware — suspicion falls on what's different on
  all.html: 16 separate canvases, 16× command issuance, 16-layer compositing,
  and per-frame gradient/shadow construction. Observatory-scrub at ~100 fps
  (~10 ms/frame) vs all-faces-scrub at ~36 ms/frame over a *similar* physical
  pixel area is the sharpest version of this comparison.
- Browser: baseline log format suggests Safari. Record UA in the env line;
  Chrome cross-checks are useful for attribution but Safari numbers decide.
- Beware the dist preview cache gotcha (stale bundles) — fresh `http.server`
  port per rebuild.

## Baseline (2026-07-03, native, 4K monitor)

```
Avg animation FPS 26.8 · inter-frame interval avg 36.55ms (min 33, max 49) → 27.4 fps
Pure animation frames (N=120): CPU avg 14.35ms (max 26) · "GPU flush" avg 3.96ms (max 13)
Frame CPU split (180 scrub frames): tick 4.47ms · render(draw issuance) 10.81ms
16 faces · 98 obsValues/face · canvas 536px (CSS)
```

Frame mix: 180 scrub frames = 60 tick frames + 120 inter-tick (animation-only)
frames — **2/3 of all scrub frames are inter-tick**, which is what makes the
skip-idle-faces idea (Phase 1B) potentially large.

## What code reading established

- **Per-face canvases, unconditional full redraw.** Each face is its own
  canvas (`engine-entry.ts:731`); the frame loop calls `renderFrame` for every
  enabled face every frame with no dirty check (`engine-entry.ts:1198`).
  `renderFrame` does a full-canvas `clearRect` + full part redraw
  (`renderer.ts:582`). During scrub-by-*day*, time-of-day parts literally
  don't move; only calendar/astro indications change.
- **The "GPU flush" metric is weaker than it looks.** It's
  `getImageData(0,0,1,1)` on *one* face's canvas (`engine-entry.ts:1224`):
  flushes only that canvas's command buffer, adds a readback stall real frames
  don't pay, and says nothing about the other 15 canvases, whose raster/
  composite happens after the callback where we can't see it. Treat 3.96 ms as
  neither an upper nor lower bound.
- **~17 ms/frame is unaccounted.** Attributable work ≈ 19 ms vs 36.55 ms
  interval. Candidate explanations in H2 below; distinguishing them is the
  single highest-value measurement.
- **Static caching already exists** for `<static>` blocks (offscreen canvas
  blit, `renderer.ts:648`) and drop shadows (pre-rendered bitmaps). But:
- **`drawBezel` builds a radial + linear + *conic* gradient every frame, per
  face** (`renderer.ts:765–798`), for a bezel that never changes. Conic
  gradient rasterization is expensive in several browsers. Likewise window
  inner shadows build 4–5 gradients per frame (`renderer.ts:2929–2970`).
- The loop already computes `face.updater.anyAnimating()` per face per frame
  (`engine-entry.ts:1202`) — the skip experiment's gating signal exists.

## Hypotheses (ranked by suspected impact)

- **H1 — Issuance volume.** 10.81 ms to issue commands for 16 full faces every
  frame, most of which didn't change. Remedy family: skip idle faces
  (Phase 1B), dirty-part tracking, more static caching.
- **H2 — ✅ RESOLVED (Phase 0 native results): the unaccounted time is real
  browser-side back-pressure, not vsync wait.** At 240 Hz, vsync wait can be
  at most ~4 ms; measured slack is 17–26 ms — the largest component of every
  frame in both browsers. Two distinct signatures: Chrome holds a ~33 ms
  cadence lock (slack varies inversely with frame JS), Safari charges a
  ~constant ~18 ms after every frame (interval ≈ JS + 18). See "Phase 0
  native results" below; Phase 1A/1D discriminate the mechanism.
- **H3 — Fill rate.** 16 canvases × 536 CSS px; at dpr 2 that's ≈18.4 Mpx
  (~73 MB backing store) cleared + rewritten per frame. The Observatory
  calibration point argues against raw fill rate being the wall, but a 4K
  monitor at unknown dpr keeps this live. Phase 1C tests it directly.
- **H4 — Expensive primitives.** Per-frame conic/radial/linear gradient
  construction (bezel, window shadows), `fillText` (calendar wheels, QText),
  terminator/day-night path fills. Phase 2 toggles.
- **H5 — 16-layer compositing overhead.** Sixteen separate canvas layers may
  cost the compositor more than one big canvas (Observatory renders one).
  Phase 1D's face-count sweep plus profiler traces speak to this.

## Phase 0 — Instrumentation upgrades (no behavior change) — ✅ implemented 2026-07-03

All additions went into the existing `[scrub-perf]` summary so a native run is a
single copy-paste (`engine-entry.ts`). What landed:

- **Environment line**: browser+version, dpr, canvas CSS/physical px, window
  size, and a measured display quantum (one-shot 60-frame rAF sampler ~1 s
  after load; min + median delta → estimated Hz).
- **Frame-class split**: per-class (tick-boundary vs pure-anim) frame counts,
  body CPU avg/max, and the update-vs-render split within each class.
- **Faces-animating counts** per class (sizes Phase 1B — see findings).
- **Post-callback slack**: rAF gap minus our JS, per class — the direct
  measure of browser-side back-pressure.
- **Interval stats + 2 ms-bucket histograms**, attributed to the *preceding*
  frame's class (its issuance/raster is what gates the next rAF).
- **Per-face table**: avg render+update ms/frame per face, ranked by render.
- **`?noprobe` flag**: disables the per-anim-frame `getImageData` flush probe;
  the probe line is now labeled for what it is (1 canvas of 16, incl. readback
  stall).

### Phase 0 findings (VM smoke runs, Chrome 148 @ 60 Hz cap — directional only)

1. **The naive Phase 1B gate is dead: all 16 faces report outstanding
   animations on every scrub frame** (min = max = 16, both classes). This is
   by design: during scrub every per-tick-changing obsValue runs a perpetual
   beat sweep (tick → interpolate toward next tick's value,
   `updater.ts` SWEEPING state), and every face has at least one
   daily-changing value. Face-level `anyAnimating()` skipping would skip
   nothing. Phase 1B must be redesigned around a finer criterion — per-face
   "any *rendered* value changed ≥ε since last drawn frame", per-part dirty
   tracking, or staggered rendering (each face redrawn every Nth frame).
2. **The flush probe distorts the measurement it serves.** In the VM it cost
   avg ~10.6 ms, max ~121 ms per anim frame; disabling it moved avg scrub FPS
   30.1 → 33.0 (interval 36.5 → 29.3 ms). The old native baseline (probe on,
   Safari) is therefore somewhat probe-inflated — **native re-baseline must
   run `&noprobe=1`**, with one probe-on run kept as a cross-check.
3. **Updater work is not confined to tick frames**: anim frames spent
   ~4.4-4.7 ms in `updater.tick` (interp + scheduling for ~1.5k values) vs
   ~9.7-10.2 ms on tick frames (VM numbers). So inter-tick CPU is
   interp+issuance, not just issuance.
4. **Per-face costs are uneven but not one-face-dominated** (VM): render
   ranges 0.04–0.66 ms/frame (Babylon, Selene, Terra, Gaia top); update
   ranges 0.02–1.32 ms/frame (Selene, Kyoto, Terra top). Note first-run
   numbers showed Babylon at 1.53 ms render vs 0.66 on the second run —
   run-to-run variance is real; use medians of 3.

### Native Phase 0 run sheet (Steve, outside the VM)

1. Unzip `dist.zip`, serve on a **fresh port**: `python3 -m http.server 8123
   --directory dist` (bump the port on every new build — stale-bundle gotcha).
2. `http://localhost:8123/all.html?lat=<lat>&lon=<lon>&tickprofile=1&noprobe=1`
3. Wait ~2 s after load (lets the refresh sampler finish), then hold the
   **+day** step button ~6 s (≈60 ticks) and release. Copy the whole
   `[scrub-perf]` block from the console.
4. Repeat ×3 (medians), then: one run **without** `noprobe` (probe-inflation
   cross-check), and ideally the 3-run set in both Safari and Chrome.

What the native results decide: display quantum line confirms 240 Hz; slack
avg tells us how much real browser-side back-pressure exists per frame (H2);
the class split gives the true tick-frame vs anim-frame budgets for the 60 fps
math; the per-face table and faces-animating line shape the Phase 1B redesign.

## Phase 0 native results (2026-07-03) — H2 resolved

Raw data: [2026-07-03-phase0-native-timings.txt](2026-07-03-phase0-native-timings.txt)
(Chrome 149 ×3 noprobe + 1 probe-on; Safari 26.5 same; M3 Ultra, 240 Hz, dpr 2,
16 canvases @ ~535 px CSS / ~1070 px physical).

**Environment confirmed.** Both browsers deliver rAF at ~240 Hz when idle
(quantum ~4.0–4.2 ms). Caveat: the load-time sampler was polluted on the first
run in each browser (read 49 Hz / 38 Hz); trust runs where it reads ~240 Hz.
Vsync wait can therefore explain at most ~4 ms/frame — and slack measures
17–26 ms. **H2 is settled: the missing time is real browser-side
back-pressure, not vsync quantization.** Slack is the single largest component
of every frame in both browsers, bigger than issuance and bigger than update.

**The two browsers show different slack signatures:**

- **Chrome: cadence lock.** Anim-frame intervals are pinned at ~33 ms
  (histogram mass at 32–34 = 8×4.17 ms slots; min ~29 ≈ 7 slots) regardless of
  frame cost: slack is *larger* after cheap anim frames (25.9 ms) than after
  expensive tick frames (20.7 ms) — interval stays ~constant and slack absorbs
  the difference. That is a scheduler holding the page at ~30 fps, not work
  serialized after our JS. Chrome's frame scheduler picks a sustainable
  BeginFrame cadence from recent frame cost — our worst frames (tick frames:
  avg 16–21 ms JS, max 50–56 ms) plausibly set the cadence for *all* frames.
- **Safari: constant post-frame cost.** Slack is ~18 ms after *every* frame
  (min pinned at 16 ms), so interval ≈ our JS + 18 ms (anim: 18 JS + 18 = ~36;
  tick: 31 JS + 18 = ~50). That looks like serialized per-frame browser work
  (or a fixed down-throttle) rather than a cadence lock.

**Per-frame JS budgets (noprobe medians):**

| | Chrome anim | Chrome tick | Safari anim | Safari tick |
|---|---|---|---|---|
| body CPU | 8.8 ms | 16.4–21.5 ms (max 56) | 17.7–18.2 ms | 31–32.5 ms (max 52) |
| — update | 4.3 | 9.9 | 6.1 | 15.0–15.6 |
| — render | 4.3 | 5.0–8.8 | 11.2–11.5 | 11.4–12.2 |
| slack after | 25.9 | 20.7 | 17.5–18.5 | 18.3–18.4 |

Notable: Chrome's draw issuance is ~2.6× cheaper than Safari's (4.3 vs
11.5 ms) — Safari pays much more per canvas command, so command-count
reduction (caching, skipping) helps Safari most. Update work concentrates on
tick frames as suspected (~10 ms Chrome / ~15 ms Safari per tick frame), and
tick frames have a heavy tail (50 ms+ maxima).

**Probe poisoning confirmed, worse than thought.** With the probe on, Chrome's
face[0] (Babylon) issuance jumps 0.55 → 2.35 ms/frame — per-frame
`getImageData` appears to kick that canvas onto a slow (likely readback-
synchronized) path, on top of the 6.8 ms avg stall. Historic per-face and
baseline numbers were distorted; `noprobe` stays mandatory. Safari shows the
stall (3.7 ms) but not the poisoning.

**Run-to-run variance warning:** Safari #1's CPU numbers were ~1.5–2× faster
than #2/#3 across the board (eval 1.8 vs 3.7 µs; issuance 9.2 vs 11.5 ms) —
cause unknown (thermal, JIT state, inspector overhead). Medians of ≥3 runs are
not optional in Safari.

**60 fps math after Phase 0.** Budget at 60 fps is 16.7 ms JS+slack per frame:

- Chrome: anim-frame JS (8.8 ms) already fits — *if* slack drops to ≤8 ms.
  Tick-frame JS (16–21 avg, 56 max) busts the budget on its own → tick-frame
  work must roughly halve, which likely *also* raises the cadence the
  scheduler picks (the lock and the spikes are probably the same problem).
- Safari: anim-frame JS alone (17.7 ms, of which 11.5 is issuance) busts the
  budget → issuance must roughly halve *and* the ~18 ms post-frame cost must
  shrink; if the latter is Safari-internal and irreducible, 60 fps may not be
  reachable in Safari without cutting canvas count/size (H5/H3 remedies).

**What Phase 1 must now decide:** (a) does the slack shrink when we render
less (→ real raster/commit back-pressure) or only when *worst-frame JS*
shrinks (→ scheduler cadence, Chrome) or neither (→ fixed browser cost,
Safari)? (b) how does slack scale with canvas count? These map to 1A/1D
below; the flags are unchanged but the priority order is now
**1A → 1D → 1B(stagger render) → 1E(stagger update) → 1C**.

## Phase 1 — Bounding ablations (one dist.zip, query-flag per experiment) — ✅ implemented 2026-07-03

Each flag isolates one variable; visual artifacts behind flags are fine. All
flags shipped in one build (`engine-entry.ts`), composable via
`&ablate=a,b&faces=N`, active only while scrubbing (except `dpr1`, which sizes
backing stores for the whole session). The active flag set is echoed in the
summary's Environment line. VM smoke results (60 Hz cap, small window —
directional only): `ablate=render` → 60 fps at the cap, render 0.00 ms;
`staggerrender` → render halved, 50 fps; `staggertick` → tick-frame body CPU
flattened 16→9.7 ms (max 16.5); `dpr1` → backing 1 confirmed; `faces=4` →
4 faces drawn, 60 fps at the cap.

### Native Phase 1 run matrix (priority order — stop early if time-limited)

Per config: hold **+day** ~6 s, paste the block. 2 runs Chrome / 3 runs Safari
(variance). All URLs include `?lat=&lon=&tickprofile=1&noprobe=1` plus:

1. `&ablate=render` — 1A, the mechanism discriminator: does slack collapse
   when we stop drawing?
2. `&faces=1` / `&faces=4` / `&faces=8` — 1D: how does slack scale with
   canvas count? (Safari's constant ~18 ms is the target question.)
3. `&ablate=staggertick` — 1E: does flattening the tick spike raise Chrome's
   cadence?
4. `&ablate=staggerrender` — 1B: does halving issuance halve the render share?
5. `&ablate=dpr1` — 1C: fill-rate sensitivity.
6. `&ablate=staggerrender,staggertick` — best-shot combo: how close to 60?

- **1A — Null render** (`&ablate=render`): tick everything, skip all
  `renderFrame` calls. Bounds the *entire* rendering share (issuance + raster
  + composite). If intervals collapse to one vsync slot, rendering is the
  whole story; the gap between 1A and baseline is the budget the other
  experiments must apportion.
- **1B — Skip unchanged faces** (`&ablate=idlefaces`): **redesigned after
  Phase 0 finding 1** — face-level `anyAnimating()` gating skips nothing
  during scrub (all 16 faces run perpetual beat sweeps). Candidate gates, in
  rough order of measurement value: (a) per-face "no rendered value moved ≥ε
  since the face was last drawn" (needs a cheap changed-flag from the
  updater); (b) staggered rendering — draw each face every 2nd frame,
  alternating halves (bounds the gain from any halved-issuance scheme and
  doubles as a shippable degrade-during-scrub mode); (c) per-part dirty
  tracking (most precise, most work — only if (a)/(b) measure well). For the
  bounding run, (b) is trivial to implement and answers "does halving
  issuance+raster actually halve the render share?" — disagreement implicates
  compositing (H5).
- **1C — Reduced backing store** (`&ablate=dpr1`): size canvases at dpr 1
  during scrub (quarter the pixels at dpr 2). Isolates fill rate (H3). Also
  doubles as a candidate shipping mitigation (lower res only while scrubbing,
  restore on release) if it measures big.
- **1D — Face-count sweep** (`&faces=1|4|8|16`): render only the first N
  faces (still tick all 16, so the tick share stays constant). Linear scaling
  → per-face costs dominate; super-linear → compositing/layer overhead (H5);
  large constant → shared per-frame overhead. **Post-Phase 0: watch the slack
  line specifically** — if Safari's ~18 ms constant scales with N, it's
  per-canvas commit/raster; if it doesn't, it's a fixed throttle.
- **1E — Stagger tick updates** (`&ablate=staggertick`): spread the 16 faces'
  tick-boundary update work across the frames between ticks (e.g. 4 faces per
  frame) instead of all on the tick frame. Added after Phase 0: tick-frame JS
  spikes (avg 16–21 ms, max 56 ms in Chrome) are the likely input to Chrome's
  cadence lock, so flattening them tests whether the scheduler up-shifts —
  and it's a shippable remedy, since beat sweeps already bridge the visual
  gap between ticks.

**Decision point after Phase 1:** we should be able to write a ledger —
ms/frame attributable to issuance, raster/composite, vsync wait, tick — and
state whether {skip idle faces + issuance cuts} plausibly reaches ≤16.7 ms
worst-case, or whether raster/composite is a second wall needing H3/H5
remedies, or whether 60 fps is out of reach and why.

## Phase 1 native results (2026-07-04) — the bottleneck is per-canvas commit overhead

Raw data: [2026-07-04-phase1-native-timings.txt](2026-07-04-phase1-native-timings.txt)
(Chrome 149 ×3, Safari 26.5 ×2–3 per config, noprobe, M3 Ultra @ 240 Hz, dpr 2).
The combo run (staggerrender+staggertick) was skipped — moot given the verdict below.

**The scaling law.** Median anim-frame interval (ms) and post-callback slack by
number of canvases drawn per frame:

| canvases drawn | Chrome interval | Chrome slack | Safari interval | Safari slack |
|---|---|---|---|---|
| 0 (`ablate=render`) | 4.27 | 0.63 | 6.7 | 1.6 |
| 1 (`faces=1`) | 4.90 | 0.87 | 9.5 | 2.8 |
| 4 (`faces=4`) | 8.95 | 4.11 | 15.4 | 6.3 |
| 8 (`faces=8`) | 14.39 | 8.10 | 24.9 | 10.7 |
| 16 (baseline) | 34.49 | 25.84 | 35.6 | 18.1 |

Interval ≈ frame JS + **~1.4 ms per drawn canvas** (Chrome) / **~2.2 ms per
drawn canvas** (Safari). Overall scrub fps: Chrome 212–221 with no drawing,
186–191 at one face, 103–115 at four, **64–71 at eight**, ~29 at sixteen.
Safari: 129–132 / 86–106 / 52–67 / 33–42 / ~28.

**Verdicts:**

- **H5 CONFIRMED as the dominant cost.** With rendering ablated, slack
  collapses to 0.6 ms (Chrome) / 1.6 ms (Safari) — the browsers deliver rAF at
  212–236 / 129–150 fps while we tick all 16 faces. Safari's "constant ~18 ms"
  was not a throttle; it is per-canvas commit/raster cost and scales cleanly
  with the number of dirty canvases.
- **H3 (fill rate) WEAK, confirmed.** `dpr1` (¼ the pixels) saved only
  ~0.25 ms/canvas in Chrome (fps 29→~34) and roughly nothing in Safari. The
  per-canvas cost is fixed per-layer overhead (commit/IPC/compositor), not
  bandwidth. Drop dpr reduction as a remedy.
- **Chrome "cadence lock from JS spikes" DEAD.** `staggertick` halved
  tick-frame JS (16–21→~10.5 ms) but anim intervals stayed ~35.5 ms — the
  ~33 ms cadence was 16-layer pipeline throughput, not scheduler punishment.
  staggertick still earned **+5 fps overall** (Chrome ~28→33, Safari ~28→33)
  purely by making tick frames cheaper; it remains a worthwhile shippable
  lever.
- **staggerrender anomaly:** drawing 8 alternating canvases/frame gives only
  42–48 fps vs 64–71 fps for a static 8 (`faces=8`) — interval 22.0 vs
  14.4 ms in Chrome. Alternating the dirty set costs ~2× the per-canvas
  overhead of a stable set (plausibly texture-recycling defeat). Noted, but
  superseded by the structural remedy.

**The remedy hierarchy is now obvious: reduce the number of canvas layers
committed per frame.** Ranked program:

1. **One shared canvas for the all-faces grid** (all 16 faces drawn into a
   single canvas at their cell offsets). Predicted from the law: Chrome anim
   interval ≈ 8.8 JS + ~1 ≈ 10 ms → **~80–100 fps overall** (60 fps target
   cleared with margin, even before tick-frame work); Safari ≈ 17.7 + ~3 ≈
   21 ms → ~45 fps overall, still issuance-limited. Implementation notes:
   static-cache blits use `resetTransform(); drawImage(cache, 0, 0)` and
   assume face-local canvas coords — they must switch to the face's cell
   transform; per-face click→navigate needs hit-testing on the shared canvas.
   Prototype behind `&ablate=onecanvas` first (artifacts acceptable) to
   confirm the prediction before productizing.
2. **Safari issuance reduction** (needed to lift Safari from ~45 toward 60):
   Safari pays 11.5 ms/frame issuing commands vs Chrome's 4.3 for identical
   drawing — the Phase 2 primitive toggles (bezel conic/radial gradients
   rebuilt per frame, window inner-shadow gradients, text) now target Safari
   specifically, plus obvious caching (bake bezel into the static cache).
3. **staggertick** — keep; cheap +5 fps on tick frames, composes with #1.
4. dpr reduction, face skipping — dropped (weak / superseded).

**60 fps verdict so far:** Chrome — yes, via #1 (+#3 for margin), with high
confidence. Safari — #1 alone lands ~45 fps; #1 + #2 (halving issuance)
projects to ~55–60 fps; plausible but the projection has real uncertainty, to
be resolved by measuring the onecanvas prototype.

## Phase 2 prototype — shared canvas (`ablate=onecanvas`) + `nobezel` — ✅ implemented 2026-07-04

**What was built:**

- `&ablate=onecanvas`: all faces draw into ONE shared canvas at their grid-cell
  offsets; the per-face canvases stay in the DOM (they define layout and
  static-cache sizes) but are hidden and never dirtied. `renderFrame` gained an
  optional viewport (origin/size) param; the two face-local blit sites
  (`resetTransform(); drawImage(cache, 0, 0)`) now reset to the face origin
  instead (`renderer.ts`). Whole-session flag; click-to-navigate is dead under
  it. Visual check in the VM: all 16 faces render correctly, including window
  cutouts and static caches.
- `&ablate=nobezel`: skips `drawBezel` (per-frame conic/radial/linear gradient
  construction) — sizes the bezel's total cost. Composes with everything.
- Independent improvement found along the way: `drawAnalemma` (Vienna) no
  longer `clip()`s the destination per frame — the clipped channel+sun are
  composed in a small cached scratch canvas and blitted (`analemma.ts`).

**VM smoke results (Chrome, 60 Hz cap, software raster — magnitudes are NOT
representative, mechanisms are):**

- onecanvas works: after-anim slack collapsed 26 → ~6.4 ms; interval 29.3 →
  24.0 despite the flush anomaly below.
- **Chrome mid-recording flush anomaly:** with all 16 faces' ops in one
  command stream, one face's issuance absorbs a ~9–19 ms synchronous flush
  (billed to Terra, ~10th in draw order; total issuance 4.9 → 13.4–23 ms).
  It is an accumulation threshold, not Terra-specific: with only 8 faces
  drawn per frame (`faces=8` or `staggerrender`) the spike vanishes entirely
  (Terra 0.24 ms, total issuance 2.5 ms) rather than halving. `nobezel` did
  *not* remove it (one run got worse), so the budget currency (op count vs
  bytes vs estimated raster cost) is unresolved — and VM run-to-run variance
  under software raster is too large to chase it further there.
- Native expectation: the flush is raster work moved into our JS window; on a
  real GPU it should shrink dramatically — and even in the VM, onecanvas net
  frame time still beat baseline. **If the flush is still large natively, the
  fallback design is 2 shared canvases (8 faces each): stays under the
  recording budget and still pays ~2 layers instead of 16.**

### Native Phase 2 run sheet (Chrome ×3, Safari ×3, all with `noprobe=1`)

1. `&ablate=onecanvas` — the headline: does the per-layer cost collapse
   natively, and what does the flush cost on a real GPU? Watch the per-face
   line for a Terra-billed spike (both browsers — Safari's recording
   architecture differs and may not flush at all).
2. `&ablate=onecanvas,staggertick` — best shot at 60 fps: single layer +
   flattened tick frames.
3. `&ablate=nobezel` — bezel price tag in the normal 16-canvas mode (Safari
   especially: its 11.5 ms issuance is the post-onecanvas blocker).
4. `&ablate=onecanvas,nobezel` — the Safari stack: single layer + cheaper
   issuance.
5. (only if #1 shows the Terra spike natively) `&ablate=onecanvas,staggerrender`
   — confirms the under-budget behavior as the 2-canvas fallback predictor.

## Phase 2 native results — onecanvas (2026-07-04): browsers split; Chrome's law reinterpreted

Raw data: [2026-07-04-phase2-onecanvas-native-timings.txt](2026-07-04-phase2-onecanvas-native-timings.txt)
(`ablate=onecanvas` ×3 each browser, noprobe; run from the pre-clip-fix zip — per-face
px identical to all prior runs per the env lines, so comparable. Shared canvas
6718×3307 phys ≈ 22 Mpx.)

**Chrome: no net win — the cost is conserved.** Slack collapsed exactly as
predicted (25.8 → 1.1 ms — per-layer commit gone), but issuance exploded 4.3 →
27–30 ms: the same work moved into synchronous mid-recording flushes, billed to
4 faces (Milano 7.5 + Chandra 7.0 + Terra 5.2 + Basel 3.4 ≈ 23 ms — note
Milano draws almost nothing; it's billed a flush, confirming the accounting
artifact). Anim-frame totals: baseline 8.8 JS + 25.8 slack = 34.6 ms vs
onecanvas 32–35 JS + 1.1 slack = 33–36 ms. **Conserved within ±1 ms.**

Reinterpretation: Chrome's Phase-1 "per-canvas commit overhead" was never
per-layer IPC — it is **main-thread raster-prep work proportional to drawn
content** (~1.5–1.7 ms per full face at this size), which lands in post-rAF
slack (per-canvas mode) or in issuance (shared mode) but never goes away. This
retro-explains everything: the faces sweep scaled with content (content ∝
canvases drawn), dpr1 did nothing (command/tessellation cost, not fill), and
Observatory's 25 Mpx single canvas hits 240 fps because its per-frame content
is a handful of cached blits. **Chrome's only lever is drawing less content
per frame.** Canvas count is irrelevant to Chrome.

**Safari: solid, on-model win — ~28 → ~40 fps.** Fast-CPU-state runs (#1, #3):
anim intervals 22.4–23.5 ms (JS 13–17.5 + slack 5–10.7, down from 18.1);
issuance unchanged (~9.6–11.2 — Safari keeps raster out of the JS window).
Run #2 was the known slow-CPU-mode outlier (eval 6.0 µs, one 217 ms tick
frame). Safari's cost DOES have a real per-layer component; one layer saved
~13 ms/frame. Remaining budget to 60 fps: anim frames need ~6 ms more —
issuance cuts; tick frames (30.6 ms CPU) need staggertick.

**Unified model after Phase 2:**

| | per-layer cost | content-proportional cost | onecanvas effect |
|---|---|---|---|
| Chrome | ~0 | ~1.5–1.7 ms/face/frame (main-thread raster prep) | neutral (work relocated) |
| Safari | ~1 ms/canvas/frame | ~0.7 ms/face issuance + few ms/22 Mpx commit | **+12 fps** |

**The convergent design (Phase 3 candidate): shared canvas + per-face cached
buffers.** Cache each face's full rendering in a per-face offscreen; per frame,
blit 16 buffers + redraw only the parts whose obsValues are animating; rebuild
a face's buffer on its tick (staggerable). Content per frame collapses to ~16
blits + a few hands/wedges per face — cheap for Chrome's content-proportional
cost, and the single layer + tiny issuance satisfies Safari. This is exactly
Observatory's proven architecture (240 fps forward / 100 fps scrubbing).

**Interim probes (flags already in the current dist.zip, no rebuild needed):**

1. `&ablate=onecanvas,nobezel` — now a *Chrome* probe too: bezel gradients are
   exactly the expensive-to-raster-prep content; measures how much of the
   ~25 ms flush they are. Also the Safari issuance stack.
2. `&ablate=onecanvas,staggerrender` — halves content/frame on one layer;
   direct test of the content-proportional model (Chrome prediction: interval
   ≈ ~20 ms → ~50 fps).
3. `&ablate=onecanvas,staggertick` — Safari's tick-frame fix; little expected
   Chrome effect (tick spikes aren't Chrome's binding constraint).

**Known prototype issue (measurement-safe, fix queued):** under onecanvas the
faces don't move aside for the open time controller. Mechanism: the grid
element's rect doesn't change when the controller opens at this window size —
normal mode avoids the controller by *shifting* face positions (`gridShiftX/Y`
path), not resizing them — and `syncSharedLayout`'s staleness guard only
watches the grid rect and face canvas size, so a position-only relayout never
triggers an offset recompute. Measurement impact: none — shared-canvas area is
identical with or without the controller, per-face px match all prior datasets
(535/536 CSS), and only face positions within the same-size canvas differ,
which affects neither Chrome's content-proportional cost nor Safari's layer
commit. Fix for the next build: include face rect positions (first + last
face) in the staleness check.

## Phase 2b native results — combos (2026-07-04): model confirmed, bezel exonerated

Raw data: [2026-07-04-phase2b-combo-native-timings.txt](2026-07-04-phase2b-combo-native-timings.txt).
Overall scrub fps (medians) and anim-frame interval decomposition (JS + slack):

| config | Chrome fps | Chrome anim ms | Safari fps | Safari anim ms |
|---|---|---|---|---|
| baseline (16 canvases) | ~29 | 34.5 (8.8+25.8) | ~28 | 35.6 (17.7+18.1) |
| onecanvas | ~27 | 33.6 (32.5+1.1) | ~38–40 | 23.0 (17.5+5.5) |
| onecanvas+staggerrender | **~42** | 21.9 (17.8+4.0) | **~45** | 19.4 (12.5+6.4) |
| onecanvas+staggertick | ~33.5 | 34.4 (33.5+1.1) | ~31.5 | 34.9 (19.4+15.5) |
| onecanvas+nobezel | ~29 | 32.3 (31.6+1.0) | ~30 | 30.0 (18.2+11.8) |

**Verdicts:**

- **Content-proportional model CONFIRMED quantitatively (Chrome).** Halving
  drawn content (staggerrender) halved the flush (issuance 26→13 ms) and
  lifted 27→42 fps; slack stayed ~1–4 ms. Cost tracks content, not layers.
- **Bezel EXONERATED.** nobezel bought ~1–2 ms of Chrome's ~25 ms content
  cost and ~0 of Safari's issuance (the flush-billed faces barely moved).
  There is no single expensive primitive — the cost is total command volume.
  The bezel-gradient cache is demoted from perf remedy to (at most) cleanup.
- **staggertick:** Chrome +6 fps (tick-frame body 39→17 ms) — real, composes.
  Safari inconclusive-to-negative in this session (whole timings-4 Safari set
  ran in the slow CPU state: eval 3.4–3.8 µs vs 1.7 µs in timings-3 run 1 —
  cross-session Safari comparisons need matching CPU state; staggerrender's
  45 fps might be ~55 in the fast state).
- **Current champion: onecanvas+staggerrender — Chrome ~42 / Safari ~45 fps**
  (from ~29/28 baseline), at the cost of each face redrawing every 2nd frame.
  **Not shippable** per the fidelity rule adopted 2026-07-04 (per-face ~21 Hz
  gates perceived smoothness below today's uniform ~29) — measurement
  instrument only; see the Phase 3 doc.

**Phase 3 — face-buffer caching (now the clear path to 60).** Full design in
[2026-07-04-phase3-face-buffer-caching.md](2026-07-04-phase3-face-buffer-caching.md).
Core idea: an order-preserving *prefix* cache per face (buffer = document-order
prefix rendered normally; tail parts still drawn live in order on top — no
z-layering, appearance exactly preserved). Prototype `ablate=facebuffers`
measures the ceiling (whole face buffered, per-tick staggered rebuilds, 10 Hz
per-face stepping during scrub); production uses a dynamic split point so
animating parts keep full-rate sweeps with no visual compromise.

## Device targets & memory ledger (added 2026-07-05)

**Targets (fuzzy, per Steve):**

1. **100 MB floor** (really 150 MB with GC headroom): has to run, ≥10 fps.
2. **Modern low-end phone** (Samsung/Apple/Google — research exact limits):
   should run 30 fps, slightly-under OK, ideally 60.
3. **Modern desktop, 4K monitor**: same fps targets; memory tradeable for
   speed up to ~500 MB.
4. **Modern desktop, 5K monitor**: same, softer.

**The `[mem]` ledger** (implemented 2026-07-05): accounting of every canvas/
bitmap we allocate (w×h×4), printed once after initial cache build and in
every scrub-perf summary, plus Chrome-only JS heap. Manual complement for
Safari/old iPhones: append `[mem] Safari process RSS: NNN MB (Activity
Monitor)` to pasted runs, occasionally.

**First matrix (VM, all.html, no flags, wheel cache on — geometry-authentic
per tier via viewport scaling at dpr 2; perf numbers NOT valid from VM, memory
geometry IS):**

| profile | face px | canvas total | faces | static | images | shadows | wheel$ | JS heap used |
|---|---|---|---|---|---|---|---|---|
| phone 375×667 | 160 | **94.7 MB** | 1.6 | 1.9 | 82.3 | 0.5 | 1.1 | 137 MB |
| laptop 1512×900 | 476 | 133.8 | 13.8 | 16.4 | 82.3 | 4.1 | 9.5 | 144 |
| 5K-default 2560×1395 | 824 | 221.7 | 41.4 | 49.2 | 82.3 | 12.0 | 28.5 | 148 |
| 4K-scaled 3359×1739 | 1070 | **312.0** | 69.9 | 83.0 | 82.3 | 20.1 | **48.0** | 154 |

**Implications:**

- **The phone floor is NOT about render canvases** (~5 MB there). It's source
  images (82.3 MB of decoded ImageBitmaps, resolution-independent) + JS heap
  (~137 MB — likely including the retained base64 `dataUrl` strings in
  `window.ChronometerFaces` after decode, and the cities DB). Fixes are
  orthogonal to the scrub work: release dataUrls post-decode, decode bitmaps
  at display size (`createImageBitmap` resize options), lazy cities.
- **4K is already at the ~500 MB ceiling** (312 canvas + ~154 heap) *before*
  the sandwich buffers (+~70) or shared canvas (+~89). Offsets: ~~wheel cache
  byte budget~~ **resolved 2026-07-05** — per-glyph atlas redesign took the
  wheel cache 48 → 5.4 MB at 4K with no quality trade (see Phase 3 doc,
  production item 1); total now 269 MB. Remaining offsets: static caches
  (83 MB) deserve an audit, image downscaling helps here too (−40ish).
- Phase 3 doc open question 4 is answered: buffers are affordable at 4K only
  with the above offsets; **scrub-session-scoped allocation** (alloc on scrub
  start, free on end) is the recommended shape.

## Re-baseline (2026-07-05, post-atlas post-probe-fix): Chrome target ACHIEVED at baseline

Raw data: [2026-07-05-rebaseline-native-timings.txt](2026-07-05-rebaseline-native-timings.txt)
(no-flag baseline / `nowheelcache` / `onecanvas`; Safari ×3+2+2, Chrome ×2+2+2).

| config | Chrome fps | Safari fps |
|---|---|---|
| baseline (atlas wheels, probe off) | **73.6 / 70.9** | 33.4 / 25.4 / 20.2 |
| nowheelcache | 25.2 / 24.9 | 20.0 / 22.3 |
| onecanvas | 70.7 / 68.5 | 26.5 / 30.2 |

**Chrome: 29 → ~72 fps at baseline — the 60 fps goal is met with no flags and no
structural change.** The decomposition: anim frames 12.3–12.6 ms intervals
(~80 fps), slack collapsed 25.8 → **4.5 ms**, and the wheel A/B shows the cause:
`nowheelcache` restores 25 fps with 22–28 ms slack. **The wheel cache alone was
worth ~47 fps in Chrome — and almost none of it was issuance.** Refined model:
Chrome's "content-proportional raster-prep" was dominated by **per-frame glyph
rasterization** (cheap to issue, brutal to raster) — which is why nobezel
(gradients) did nothing while wheels (text) were everything, and why issuance
metrics under-weighted them all along. onecanvas confirmed neutral in Chrome.

**Safari: still the laggard (20–33 fps, CPU-state-dependent).** Atlas saves
~3 ms issuance (Wheel 5.1 → 1.6–2.3); slack improved to ~14–16; onecanvas adds
~+5 fps. Remaining Safari binders: per-layer commits (onecanvas needed),
issuance (Terminator now the top part type at 2.5–3.0 ms, QHand(vector)
1.4–1.8), tick-frame eval (~18 ms, stagger), and its bimodal CPU state (not
ours to fix). Phones run WebKit, so this work doubles as the phone-tier path.

**Memory ledger validated cross-machine:** native baseline 269–270 MB ==
VM 4K-profile prediction (269.3); onecanvas +84.9 shared canvas = 354.9;
wheel cache 5.4 native ✓.

**Revised roadmap:** Chrome — done at desktop; headroom available via tick
frames if ever needed. Safari/phones — (1) extend the appearance-cache pattern
to Terminator leaves and vector hands (same recipe as wheels; their raster
cost likely exceeds their issuance, per the text-raster lesson), (2)
production onecanvas, (3) sandwich buffers, (4) tick-stagger. Re-measure after
(1) — if the raster-side wins repeat, the sandwich's scope may shrink further.

**Step (1) implemented 2026-07-05** (same dist.zip series):
- **Terminator leaves → retained Path2D** (`terminator.ts`): each leaf's ~60
  trig-computed path commands per frame become two draw calls of a cached
  path; pixel-identical by construction, no flag needed. VM Chrome:
  Terminator part-type 0.53 → 0.19 ms/frame.
- **Vector hands → appearance-keyed bitmaps** (`renderer.ts` getHandBitmap;
  kill-switch `?ablate=nohandcache`): body + shadow baked once per appearance
  (probe render + alpha-scan tight crop, so memory ∝ ink — 0.1 MB in VM,
  ~1 MB at 4K), blitted rotated. This extends the treatment `_shadowBitmap`
  hands already receive, so the one visual change — the baked shadow rotates
  with the hand instead of staying screen-fixed — makes vector hands
  *consistent* with the existing bitmap hands and with iOS's pre-rendered
  shadows. Frozen-time diff: 12/16 faces pixel-identical; 4 faces show only
  small localized shadow-direction deltas. Watch item for native runs: the
  per-frame appearance-key evaluation (~19 evals/hand) showed as +0.1–0.2 ms
  in VM Chrome (QHand(vector) 0.65 → 0.85 there — Chrome never had a hand
  problem); if Safari's QHand(vector) doesn't drop from its 1.4–1.8 ms,
  optimize the key path (pre-parsed static signature + per-frame color evals
  only).

**Hand cache reworked 2026-07-05 evening** (timings-7 archived as
[2026-07-05-caches-step1-native-timings.txt](2026-07-05-caches-step1-native-timings.txt)
confirmed both watch items: Terminator Path2D won decisively — Safari 2.5–3.0
→ 0.85–1.1 ms, Chrome baseline 76.9 fps — but the welded hand cache was a
wash on Safari issuance, key evals eating the blit savings):

1. **Split shadow bitmaps, screen-fixed light** (per Steve: iOS drew separate
   shadow quads offset down-right in screen space). Each shadowed appearance
   now bakes a body layer + a shadow-only silhouette (offscreen-displacement
   trick — same shadow rasterizer as the live path, so blur/opacity/stacking
   match exactly); per frame the shadow blits with the screen-space offset
   applied *before* the hand rotation, then the body. Restores the live
   path's fixed-light look at every angle — the earlier "shadow rotates"
   trade is gone. The frozen-time residual diffs on 4 faces proved to be
   body-resample AA (identical counts welded vs split), the same class as
   every bitmap cache. Follow-up candidate: convert the legacy
   `_shadowBitmap` image hands (which still bake-and-rotate) to the same
   two-blit scheme for cross-hand consistency.
2. **Per-part appearance memo**: per frame only color attrs are evaluated;
   geometry re-keys only on env rebuild / resize. VM Chrome QHand(vector)
   0.85 → 0.75 ms (live-path parity, now including the shadow blit); Safari
   should recover more since its evals are pricier.

**Hand unification completed 2026-07-05 (later):** investigating the legacy
`_shadowBitmap` machinery revealed `buildHandShadowCaches` had been
pre-building welded (rotating-light) bitmaps for **all** z>0 hands — vector
AND image — since April, meaning shadowed vector hands never reached either
the live path or the new cache, and the kill-switch never disabled the
prebuilds. The whole build-time machinery is now deleted (~200 net lines
removed: buildHandShadowCaches, buildSingleHandShadow, buildImageHandShadow,
the bake-only body helpers, the `_shadowBitmap*` part fields, and both
welded fast paths); every hand — vector and image, including
offsetRadius/Moon-orbit hands that the old bitmaps skipped — now uses the
runtime split-shadow caches with screen-fixed light. Consequences: the
`[mem]` "shadows" category (20.1 MB at 4K) drops to 0, replaced by a few MB
of tight-cropped split layers; `?ablate=nohandcache` is now a true
fully-live A/B for the first time; and all hands are light-consistent.
Frozen-time diff vs live: small resample-class residuals (≤0.2% of pixels
per face) across shadowed-hand faces, as expected for any bitmap cache.

**Memo simplified to zero-eval (2026-07-05, on Steve's challenge):** the
per-frame color evaluations were defending dynamic hand colors — a case the
April prebuild system never supported either ("hand appearance is fixed at
init time") and no face uses. The memo now keys on (env identity, dev) only;
colors evaluate solely on memo miss (init / resize / env rebuild). Steady
state per hand: two reference compares + blits — zero expression evals. VM
Chrome QHand(vector) 1.01 → 0.80 ms; the residual vs the old prebuilt fast
path is the second (shadow) blit, i.e. the price of screen-fixed light.

## timings-8 post-mortem (2026-07-06): Safari ran a stale bundle; Chrome validates the hand unification

Raw data: [2026-07-06-hand-caches-native-timings.txt](2026-07-06-hand-caches-native-timings.txt)
(Safari ×3 baseline + 1 `nohandcache,nowheelcache`, Chrome ×1 baseline).

**The four Safari runs did not execute the new build.** Their `[mem]` ledger
reads `shadows 20.1 · hand cache 0.6` — byte-identical to timings-7 — but the
shipped bundle deleted every `_shadowBitmap` write and can only print
`shadows 0.0` (confirmed against both the source and the actual
`dist/chronometer-engine.js` of 2026-07-05 20:26, where the only occurrence is
the ledger *read*). Cause (per Steve): the Safari runs were made in an **old
tab left over from the timings-7 session**, still running that build — not
HTTP caching. The Chrome run is from the correct bundle
(`shadows 0.0 · hand cache 8.1`) and is valid.

**Mitigation (shipped, v2.0.33):** `build.sh` now injects the auto-incremented
version into the engine (`esbuild --define:__BUILD_VERSION__`), and both the
startup `[mem]` line and the `[scrub-perf]` Environment line print
`build N.N.N`. Every future pasted block self-identifies its build; check it
FIRST when reading native results. The stamp catches every stale-bundle
mechanism the same way — old tabs (both native incidents), HTTP caching (the
VM-preview gotcha), or running the wrong zip. (Native protocol: if the stamp
is stale or missing, close/reload the tab onto the new build and re-run.)

What the runs still tell us:

- **Chrome (valid): 78.7 fps baseline** (was 76.9 in timings-7) —
  the split-shadow caches + zero-eval memo + prebuilt-machinery deletion hold
  Chrome above target. QHand(vector) 0.71 ms (0.73 t7). Ledger: hand cache
  8.1 MB now carries *all* hands (vector + image) as tight-cropped split
  layers, replacing 20.1 MB of prebuilds + 0.6 MB memo → canvas TOTAL
  257.3 MB (was 269.9), −12.6 MB at 4K.
- **Safari (replication of timings-7 only):** fast-CPU state 33.3 fps;
  slow-state 24.8 / 26.1; ablation 24.1. Replicates the welded-cache-is-a-wash
  result (cached QHand(vector) 1.12 fast / 1.62–1.72 slow vs 1.34 fully-live
  in the ablation run) and the wheel cache's worth (Wheel 4.70 live vs
  1.99–2.03 cached, slow state). **The split-shadow/zero-eval hand work is
  still unmeasured on Safari**, and the true `nohandcache` A/B (possible for
  the first time since the prebuild deletion) hasn't happened yet.
- **The Safari slack wall, now very well replicated:** post-callback slack is
  17.4–19.5 ms on every Safari run — fast or slow CPU state, cached or
  ablated, tick or anim frames. Anim interval ≈ body CPU + ~18 ms slack
  (fast: 9.1 + 19.5 → 28.6 ms ≈ 35 fps; slow: ~15.3 + ~18 → ~33.8 ms ≈
  29.6 fps). Two consequences for the roadmap:
  1. Issuance micro-optimization is exhausted as a Safari lever: total render
     issuance is 4.9 ms (fast state) of a 28.6 ms interval; halving it buys
     ~2–3 fps. Remaining CPU-side lever is tick-frame eval (update 16.3–16.9
     ms on slow-state tick frames → tick-stagger).
  2. The ~18 ms slack is the wall between Safari and 60 fps: even at zero JS
     it caps near ~55 fps. Its composition (per-layer commit ≈ 1 ms × 16
     layers, per the onecanvas evidence, vs content raster) decides which
     structural fix pays: onecanvas attacks layer count, sandwich buffers
     attack per-frame painted content. This is the question the next
     experiments must answer — measure, don't guess.

**Verdict on the hand-cache line of work:** Chrome-validated, Safari-pending.
Re-capture on Safari with the stamped build (baseline ×3 + `nohandcache` ×1,
matching CPU states via the µs/eval line) before starting sandwich-buffer
implementation; it doubles as the first true hand A/B and the last cheap
datapoint on whether issuance-side caching moves Safari at all.

## timings-9 (2026-07-06): Safari validated, and the first TRUE hand-cache A/B rewrites the Safari model

Raw data: [2026-07-06-true-handcache-ab-native-timings.txt](2026-07-06-true-handcache-ab-native-timings.txt)
(Safari ×3 baseline + ×2 `nohandcache,nowheelcache`, Chrome ×1; per-run
validity annotations in the file header). All five Safari runs read
`build 2.0.33` ✓. The Chrome run has *no* stamp — the Chrome tab was still on
the pre-stamp 07-05 bundle (same failure mode as timings-8: a leftover tab,
caught immediately by the missing stamp; that bundle carries the same hand
code, so its 79.7 fps is valid — reload every tab onto the new build before
capturing).

**1. Hand unification validated on Safari — no regression, big cleanup
banked.** Baseline 34.0 fps fast-state / 26.1–26.8 slow (timings-8's stale
replication of the welded prebuilds: 33.3 / 24.8–26.1). QHand(vector)
issuance 1.25 fast / 1.66–1.76 slow (welded: 1.12 / 1.62–1.72) — the extra
~0.1 ms is the second (shadow) blit, the price of screen-fixed light.
Terminator holds 0.82–1.19. Ledger: `shadows 0.0 · hand cache 8.2` ✓,
TOTAL 258.0 MB.

**2. The true A/B (the headline): without the hand+wheel caches Safari
collapses to 12.7 fps — the caches are load-bearing via RASTER, not
issuance.** Run 5 (`nohandcache,nowheelcache`, near-matched CPU state:
4.6 µs/eval vs baseline's 3.8–3.9) vs runs 2–3:

| | cached (runs 2–3) | fully live (run 5) |
|---|---|---|
| fps | 26.1 / 26.8 | **12.7** |
| post-callback slack | ~17 ms | **48–53 ms** |
| render issuance Σ | 6.9–7.5 ms | 9.6 ms |
| anim interval | 31–32 ms | 71 ms (89 ms cadence-locked) |

Issuance moves ~2.5 ms; slack moves **~33 ms**. Attribution: in timings-7/8's
*broken* A/B (old bundle), `nowheelcache` was already truly live — Wheel 4.7–4.9
ms issuance — and slack stayed ~17 ms. So live *glyphs* don't blow Safari's
raster (unlike Chrome, where they were the whole story). The new ingredient in
run 5 is truly-live *hands*: per-frame `shadowBlur` shadows (the live path
sets `ctx.shadowBlur` per hand). **Live shadow-blur is Safari's raster bomb;
the split-shadow cache converts it to two cheap blits.** The earlier
"hand cache is a wash on Safari" verdict is formally retracted — it compared
cache-vs-prebuilds (both cached where it mattered), never cache-vs-live.
(Run 4, the other ablation, hit a thermal state 3× worse than baseline
(12.5 µs/eval, 10 lost ticks) — excluded from comparisons.)

**3. Revised Safari model.** With all caches on, per-frame painted content is
almost entirely bitmap blits, and the remaining ~17–18 ms slack is *not*
content raster — the strongest remaining suspect is **per-layer commit
overhead** (~1 ms × 16 canvases, per the re-baseline onecanvas evidence).
Consequences for the roadmap:

- **onecanvas deserves a re-measure before sandwich work begins.** The
  re-baseline's modest +5 fps was measured when content raster was still
  heavy (pre terminator/hand caches), which diluted the commit savings. Now
  that content is cheap, collapsing 16 commits → 1 attacks the dominant
  remaining term directly. Prediction to test: fast-state anim interval
  28 ms ≈ 9.4 CPU + 18.6 slack; if slack is commit-dominated, onecanvas on
  v2.0.33 should cut it toward the Observatory single-canvas calibration
  (~10 ms/frame all-in at similar area) → Safari ≳40 fps. It's already a
  flag: `?ablate=onecanvas`, Safari ×2–3, states matched via µs/eval.
- **Sandwich buffers' value proposition shrinks to CPU**: with content raster
  cached and commits unaffected by it, the sandwich mainly saves issuance
  (5–7.5 ms) + some update work — worth having, but it no longer looks like
  the structural Safari fix. Gate the design work on the onecanvas result.
- **Tick-stagger unchanged**: slow-state tick frames still cost 26–29 ms body
  CPU (update 13.8–16.3), producing the 43–47 ms after-tick intervals.

## timings-10 (2026-07-06): onecanvas REFUTED — the all.html/Observatory gap is content, not layer count

Raw data: [2026-07-06-onecanvas-remeasure-native-timings.txt](2026-07-06-onecanvas-remeasure-native-timings.txt)
(Safari ×3 `onecanvas` + Chrome ×1 baseline; all `build 2.0.33` ✓). This is
the queue-1 experiment timings-9 promoted, and it **falsifies the prediction.**

**onecanvas does not help Safari — it's slightly worse, and the slack did not
collapse.** State-matched picture (µs/eval in parens):

| | baseline (t9 runs 2–3) | onecanvas (t10 runs 1–3) |
|---|---|---|
| µs/eval | 3.8–3.9 | 4.4–4.8 |
| fps | 26.1 / 26.8 | 24.7 / 24.7 / 24.0 |
| anim interval | 31–32 ms | 37–38 ms |
| after-anim slack | ~17 ms | 18–21 ms |
| after-tick slack | ~17 ms | 11–13 ms |
| memory (4K) | 258 MB | **342.9 MB** (+84.9 shared canvas) |

The onecanvas runs sit at a slightly warmer CPU state (4.4–4.8 vs 3.8–3.9
µs/eval), so some of the fps gap is state, not the flag — but even granting
that, onecanvas lands ≤25 fps where the prediction was **≥40**, and the
after-anim slack (the dominant frame class during scrub) went *up*, not down.
Prediction falsified.

**What it means.** Collapsing 16 layer commits → 1 was supposed to cut the
slack if per-layer commit count dominated it. It didn't. There's a *real but
small* per-layer effect visible on the heaviest (tick) frames — their slack
dropped 17 → 11–13 ms — but it's cancelled on anim frames by the cost of
presenting one **larger** surface every frame: the shared canvas is
6714×3316 = 22.3 M px vs 16×1072² = 18.4 M px of per-face backing (+21%, from
the inter-face gaps), an 84.9 MB allocation. Net: neutral-to-worse.

The deeper read: the Observatory calibration (one full-screen canvas at
~100 fps while scrubbing) does **not** transfer to all.html by removing
layers, so **the gap between them is the *content*, not the layer count** —
16 detailed faces' worth of paths/blits is simply expensive to composite,
however many canvases hold it. Safari's ~17 ms slack is therefore most likely
**physical-pixel / composited-area driven**, not commit-count driven.
[**Superseded by timings-11:** "content, not layer count" holds, but the
slack is not composited-*area* — it's deferred *raster of the draw ops*, and
it IS reducible by cutting op count (facebuffers did; onecanvas couldn't
because it kept every op). The dpr1-probe recommendation below is moot — Steve
rejected dpr1, and timings-11 answered the question without it.]

**Roadmap consequences:**

- **onecanvas is dead as a Safari fix** (and it costs +85 MB prototype /
  ~+15 MB production for nothing). Drop it from the queue.
- **Next probe is `?ablate=dpr1`** — the clean test of the area hypothesis.
  Safari runs at dpr 2 / backing 2 (1072 px phys per face); dpr1 quarters the
  physical pixels for the whole session. If the ~17 ms slack is area-driven it
  should fall sharply under dpr1 (and that's a shippable product lever —
  reduced backing DPR on Safari/phones, a sharpness-for-fps trade); if slack
  barely moves, it's fixed per-frame overhead and Safari is near its floor.
  Capture: Safari `?ablate=dpr1` ×2–3, states matched via µs/eval.
- **Sandwich buffers** still attack the *body-CPU* half of the interval
  (issuance 5–7.5 ms + update), independent of the slack question:
  baseline slow interval ≈ 14.5 CPU + 17 slack = 31 ms; halving body CPU →
  ~9 + 17 = 26 ms ≈ 38 fps *if slack holds*. So the sandwich is worth ~+10 fps
  on Safari at best — real, but it cannot break the slack floor. Gate its
  (large) implementation cost on the dpr1 result: if dpr1 shows the slack is
  reducible, prioritize that first.
- **Chrome (stamped baseline, run 4): 66.3 fps.** Lower than the 78.7 seen
  cold, but this run was *last*, after three heavy 85 MB-shared-canvas Safari
  runs warmed the machine (2.0 µs/eval + higher per-frame CPU); the only
  2.0.33 code change is the once-per-summary build stamp, which cannot touch
  frame cost. Not a regression — still passes the 60 fps-avg target. Worth a
  clean cold re-confirm when convenient.

## timings-11 (2026-07-06): facebuffers ceiling — Safari's slack IS reducible; it's deferred per-canvas raster

Raw data: [2026-07-06-facebuffers-ceiling-native-timings.txt](2026-07-06-facebuffers-ceiling-native-timings.txt)
(Safari ×3 `facebuffers` + Chrome ×1; all `build 2.0.33` ✓; matched against
timings-9's slow-state baseline at 3.8–3.9 µs/eval — these ran at 3.4–3.7).

**Headline: whole-face buffering takes Safari 26–27 → 40–44 fps at matched
CPU (+~68%), and — the surprise — it cuts the *slack*, not just issuance.**

| (Safari, slow state, matched µs/eval) | baseline (t9) | facebuffers (t11) | Δ |
|---|---|---|---|
| fps | 26.1 | 44.2 | **+69%** |
| anim interval | 31.0 ms | 18.6 ms | −12.4 |
| render issuance (body) | 7.4 ms | 1.4 ms | −6.0 |
| **post-callback slack** | **17.0 ms** | **10.9 ms** | **−6.1** |
| update (body) | 6.5 ms | 5.8 ms | ~0 |
| memory (4K) | 258 MB | 328 MB | +70 (buffers) |

The interval win splits almost evenly between issuance and slack. **The slack
drop is the new physics.** Prediction going in was that slack would *hold*
(facebuffers still presents 16 same-size canvases). It fell by 6 ms — so a
large part of Safari's slack was never fixed composite/present cost; it was
**deferred rasterization of the draw operations issued into each canvas.**
When a face becomes a single `drawImage(buffer)` instead of ~50–100
path/blit ops, the browser's post-callback raster collapses.

**This unifies every Safari result to date into one coherent model:**
Safari defers per-canvas raster of issued draw ops to the post-rAF slack, and
**slack ∝ draw-operation count** (roughly), not canvas count and not
issuance-CPU:
- onecanvas (timings-10) kept all ~1600 ops, just redirected them to one
  canvas → same total raster → **slack unchanged** (why it failed). ✔
- facebuffers (here) *reduces* ops to ~1/face → **slack collapses.** ✔
- The original hard-won lesson ("costs hide in post-rAF slack, and the
  expensive thing is RASTERIZATION not issuance") was right all along; the
  timings-9 gloss that "content is now cheap blits, slack = composite-area"
  was **wrong** and is retracted — even cached hand/wheel *blits* are draw
  ops the browser must raster into the destination, and there are ~100/face.

Chrome (run 4) confirms the mechanism cross-engine: 66–79 → 180 fps, slack
4 → 1 ms. (Not decision-relevant — Chrome already clears 60 — but it's the
same effect.)

**The catch — this is the *optimistic ceiling*, not the achievable number.**
facebuffers hits 44 fps by letting all 16 faces step at tick-rate (the
round-robin rebuilds ≤4 faces/frame; everything else blits a stale buffer).
That's the fidelity violation the flag exists to measure past. A shippable
sandwich must keep the *fast movers* live every frame, and during a
**day-scrub** the expensive movers — date wheels (~12°/tick), and the
sweeping hands — move visibly and cannot be buffered without perceptible
stepping. The genuinely slow, bufferable parts during a day-scrub are the
astronomical layer (terminator, day-night ring, rise/set wedges, analemma —
all drift on a ~1-day cadence) plus the already-cached static base. So the
fidelity-preserving sandwich captures **only the slow layer's** share of the
6 ms issuance + 6 ms slack, not the whole 12 ms.

**How much of the 44-fps ceiling survives fidelity is the one open number**,
and it's exactly what the Phase 3 middle-share instrumentation was specified
to measure: per-part pixel-movement-per-tick during a real day-scrub →
fraction of render cost in parts moving < ~0.5 px/tick (bufferable). Rough
priors from the render breakdown (Terminator 1.0 + QWedge 0.5 + QDayNightRing
0.5 + dial/static, all bufferable; Wheel 1.7 + hands live) suggest the slow
layer is a real but minority share — plausibly worth **+5–10 fps**
fidelity-preserving (Safari ~32–37), well short of the 44 ceiling and of 60,
but a meaningful phone-tier win.

**Verdict (revised 2026-07-06 after Steve's design constraint): sandwich is
DEAD.** timings-11 proved the *mechanism* (buffering cuts both halves; slack
is op-count-reducible, not a fixed floor) — but the mechanism needs a
quiescent/slow layer to buffer, and this app has none during scrub *by
design*. Steve: every astro part (terminator, day/night, wedges, analemma)
moves a visibly different amount per simulated day; scrub-by-**month** is an
equally-important benchmark where they move even more; and the desired
direction on 4K/5K is *more* frequent astro updates, not fewer. facebuffers
reached 44 fps only by letting faces step at tick rate — exactly the fidelity
loss the product can't take. So the bufferable share is ~0, the middle-share
instrumentation would only confirm that, and it is **not worth building**.
See [[no-quiescent-layer-during-scrub]]. The one remaining full-fidelity lever
is **tick-stagger** (spread the per-tick update spike, op-count-neutral, ~+5–6
fps in earlier probes); beyond that, Safari's ~26–34 fps is the characterized
cost of full-res continuous celestial motion on WebKit.

## Phase 2 — Primitive attribution (only where Phase 1 leaves questions)

- **Toggles**, same protocol: no-op `drawBezel` (per-frame conic/radial
  gradients), skip window inner shadows, skip text drawing, skip
  terminator/day-night fills. Each delta attributes ms to a primitive class
  and ranks the cache-more list. (Baking the bezel into the static cache is
  almost certainly a win regardless — but measure first so the ledger stays
  honest.)
- **Profiler traces, recorded natively by Steve, analyzed in the VM:** Chrome
  Performance trace with advanced paint instrumentation (raster/GPU-thread
  visibility), saved as JSON and dropped into the repo/scratchpad for
  analysis; Safari Web Inspector Rendering Frames timeline for the
  ship-target shape (Script vs Layout & Rendering vs Painting vs Composite).
  This is attribution support, not the primary metric.

## Phase 3 — Synthesis

Produce in this doc: (1) the per-frame budget ledger from measured deltas;
(2) ranked optimizations, each with measured expected saving and a note on
correctness risk (dirty tracking is the main one — skipping a face that
needed a redraw is a visible bug, and scrub-end must force a full redraw);
(3) the 60 fps verdict: the combination of remedies whose savings sum to
≤16.7 ms worst-case on the native machine, or the identified wall.

## Measurement protocol (every run)

- Same URL flags (`?lat=&lon=&tickprofile=1&noprobe=1` + experiment flag),
  same window setup (4K monitor, maximized), same 60-tick scrub-by-day
  gesture. `noprobe` is part of the standard protocol as of Phase 0
  (finding 2); probe-on runs are a labeled cross-check only.
- **Update 2026-07-05: the probe is now OPT-IN (`?probe`) and off by
  default** — `noprobe` is no longer needed (still honored). Third and fatal
  strike against it: combined with the wheel glyph-atlas renderer, the
  per-frame `getImageData` readback of a canvas composed from many
  OffscreenCanvas textures trips Chrome into a **page-wide, sticky
  quarter-rate rAF throttle** (~15 fps persisting after scrub ends; raw-rAF
  probe measured 66.7 ms delivery with our JS at ~6% CPU). Reproduced in the
  VM, matched Steve's native report (150 → 15 fps sticky), bisected via
  `nowheelcache` (recovers) and confirmed via `noprobe` (no degradation at
  all — flat 60 through and after scrub). Since the probe previously ran for
  ordinary users during any scrub, this was a live user-facing bug, not just
  a measurement artifact.
- 3 runs per variant; report medians. Compare **avg and max** interval plus
  the histogram — 60 fps is a worst-case target, not an average target.
- Fresh dist server port after every rebuild (cache gotcha).
- Every pasted result includes the Phase 0 environment line so VM-vs-native
  and monitor/dpr context is never ambiguous.

## Non-goals / deliberately deferred

- No optimizations before Phase 1 lands — including the "obvious" bezel cache
  — so every remedy has a measured before/after.
- Scrub-by-other-units (hour/minute) and single-face pages: out of scope until
  all.html scrub-by-day is understood; revisit for shared wins.
- Cheap-phone re-baselining: after the desktop path to 60 is settled (or
  refuted), rerun the flag matrix on a phone before committing to remedies —
  fill-rate conclusions especially may invert there.
