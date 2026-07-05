# Scrub render performance: investigation plan (all-faces page)

*2026-07-03, updated 2026-07-04* · **Status: investigation complete through the
Phase 3 ceiling. Native verdict: Chrome onecanvas+facebuffers = 92–97 fps (gate
cleared, ~60% headroom); Safari = 57 fps in its fast CPU state with tick-frame
eval now the binder. Content mix measured: Wheel 45% / Terminator 23% /
QHand(vector) 12% of issuance — `drawWheel` is uncached (per-frame measureText
+ fillText per digit) and is the top production target. Production order:
wheel-bitmap cache (✅ implemented 2026-07-04, on by default, kill-switch
`?ablate=nowheelcache`) → sandwich buffers → tick-stagger → terminator. See
[2026-07-04-phase3-face-buffer-caching.md](2026-07-04-phase3-face-buffer-caching.md)
"Ceiling results".**

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
