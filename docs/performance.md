# Performance

How the all-faces grid (`all.html`) was taken from ~29 fps to Chrome-60+ during
scrub, what the levers were, what we deliberately did **not** do, and what to
watch when you change rendering or astronomy code. Distilled from two
investigation series: the CPU/astronomy work (June 2026) and the rendering work
(July 2026, master doc
[planning/2026-07-03-scrub-render-perf-investigation.md](../planning/2026-07-03-scrub-render-perf-investigation.md)).

**Status (2026-07):** Chrome meets the 60 fps scrub goal (66–79 fps). Safari /
phones sit at ~26–34 fps — the characterized cost of full-resolution,
full-update-rate continuous celestial motion on WebKit. That is a deliberate
stopping point, not an open bug (see [Hard constraints](#hard-constraints)).

## Mental model (read first)

- **Cost is proportional to *drawn content*, and the expensive part is
  RASTERIZATION, not issuance.** A canvas command's cost hides in the browser's
  post-callback work, not in the JS that issued it. Per-frame glyph/path
  rasterization dominated; issuance metrics under-weighted it for months.
- **Safari defers per-canvas raster to post-rAF "slack", and slack ∝
  draw-operation count** (~100 ops/face). Frame interval ≈ body-CPU + slack;
  both scale with op count. Even a cached-bitmap blit is one op the compositor
  must raster into the destination.
- **Canvas *count* barely matters** (irrelevant in Chrome; a shared canvas did
  not help Safari — see onecanvas below). Op count matters.
- **The winning pattern is appearance-keyed bake-once-blit-rotated bitmap
  caches** for anything that repeats: bake at a neutral angle into a
  tight-cropped bitmap keyed by visual signature, blit it rotated/translated per
  frame. Memory ∝ ink, not layer size. See [rendering.md](rendering.md).

## Large levers we found

| Lever | What it bought | Detail |
|---|---|---|
| **Astronomy (rise/set) cache** — memoize the master rise/set search across wedges and faces (~97% hit) and per-tick astronomy generally. Use it *everywhere* an astro value is read per frame. | The single biggest CPU win; got scrub to ~27 fps before rendering work began. | [planning/…per-tick-astronomy-memoization](../planning/2026-06-28-per-tick-astronomy-memoization.md), [planning/…daynight-wedge-memo](../planning/2026-06-28-daynight-wedge-memo.md) |
| **Wheel glyph-atlas cache** — bake each glyph once into a texture atlas, blit; render the wheel band once at angle 0 and blit it rotated. | **~+47 fps in Chrome** (the whole Chrome-60 story). Per-frame glyph *raster* was the dominant cost. | [planning/…scrub-render-perf-investigation](../planning/2026-07-03-scrub-render-perf-investigation.md) "Re-baseline" |
| **Hand bitmap caches (split-shadow)** — bake body + a screen-fixed shadow layer per appearance, blit rotated. | Keeps Safari off a ~12 fps floor: live `shadowBlur` hands are Safari's raster bomb. Also deleted ~200 lines of April prebuild machinery. | [shadows.md](shadows.md), [planning/…facebuffers-ceiling…](../planning/2026-07-06-facebuffers-ceiling-native-timings.txt) |
| **Wedge / day-night bitmap cache** — `getWedgeBitmap`, one bitmap per appearance signature shared across identical wedges, blit rotated. | Removed per-frame annular-sector path fills. | [planning/…cross-face-and-wedge-blit](../planning/2026-06-28-scrub-perf-cross-face-and-wedge-blit.md) |
| **Terminator retained `Path2D`** — cache the rigid leaf geometry (built once), replace ~60 trig `lineTo`s/leaf/frame with 2 draw calls. | Terminator part-type ~0.5 → ~0.2 ms/frame. NB: still fills/strokes live (not a blit — see below). | [terminator.md](terminator.md) |
| **Per-tick env-rebuild guard** — `rebuildEnvironments` fired every tick; now only on DST-state change. | Removed a per-tick full-environment rebuild. | [timezone-and-dst.md](timezone-and-dst.md) |
| **Pre-parsed expression AST** — evaluate a cached AST, not a re-parsed string, per `evalAttr`. | Cut per-frame eval cost; chosen over a custom parser. | [expressions.md](expressions.md), [planning/…eval-vs-custom-parser](../planning/2026-06-15-eval-vs-custom-parser.md) |
| **Probe fix** — the per-frame `getImageData` "flush probe" is now opt-in (`?probe`). | Was a live user bug: it tripped a *sticky* quarter-rate Chrome throttle. Never re-enable by default. | investigation doc, Phase 0 |

## Ideas we did not pursue (and why)

- **onecanvas** (draw all 16 faces into one shared canvas) — *tried, refuted.*
  Keeps every draw op, so slack was unchanged; +85 MB. Canvas count is not the
  lever. [investigation doc "timings-10"].
- **Sandwich / face buffers** (buffer a quiescent layer, redraw only movers) —
  *mechanism proven, then killed by product reality.* The `facebuffers`
  prototype hit 44 fps on Safari, but only by letting faces step at tick rate.
  This app has **no quiescent layer during scrub by design** — every astro part
  moves visibly each tick, and scrub-by-**month** moves them more. Bufferable
  share ≈ 0. [planning/…phase3-face-buffer-caching](../planning/2026-07-04-phase3-face-buffer-caching.md), investigation doc "timings-11".
- **dpr1 / reduced backing resolution** — *rejected on product grounds.*
  Full-resolution output is a hard constraint (see below).
- **Tick-stagger / CPU-spreaders** — *not worth it.* A fast-forward proxy
  (`Now`>1×, no discrete tick spikes) tops out at ~36–40 fps on Safari, and
  spreading updates introduces its own cross-face lag. Ceiling too low.
- **Level-of-detail during motion**, **incremental/delta astronomy**,
  **WebGL/OffscreenCanvas** — unexplored; each is a large change against an
  already-characterized ceiling, and the first two trade fidelity the product
  wants to keep.

## Guardrails when modifying code

- **New per-frame drawing pays raster cost — especially on Safari, in the
  slack.** Before adding live paths/fills/text to a face, ask whether it can be
  an appearance-keyed bitmap blit instead. Adding ~ops/face regresses Safari
  even if Chrome shrugs.
- **Bitmap caches must key on appearance and invalidate only on resize /
  env-rebuild — never per tick.** If a cache rebuilds during scrub it defeats
  itself; verify with the `[mem]` ledger and the part-type profile.
- **Never call `getImageData` on a visible canvas per frame** (Chrome sticky
  throttle).
- **The astronomy/env caches assume env is time-invariant between DST changes.**
  Adding time-dependent state to the environment can silently break the rebuild
  guard and the rise/set cache. See
  [planning/…scrub-perf-next-levers](../planning/2026-06-29-scrub-perf-next-levers.md).
- **Every bitmap cache adds to the memory ledger.** Watch the 4K/5K budget
  (~258 MB canvas baseline; device targets 100 MB floor → 500 MB 4K). The
  `[mem]` line prints in every scrub summary.
- **Run the perf-regression harness** after touching hot paths — it catches
  "still correct, but slower". [perf-regression.md](perf-regression.md).

## Hard constraints

Two product constraints bound every future perf idea:

1. **Full resolution** — no backing-DPR reduction or lower-res buffers. Take
   the fps hit over softening the faces.
2. **Full update rate** — every astro part updates every tick, by design; the
   app is a demonstration of continuous celestial motion (day- *and*
   month-scrub). No buffering / staleness / frame-skipping schemes.

Any lever must preserve both. That leaves op-count-neutral CPU wins and better
caches — not resolution, layer, or update-rate trades.

## Measuring

- **Authoritative numbers are native**, from a 240 Hz Mac Studio; the dev VM
  caps rAF at 60 Hz (directional only). Build (`bash build.sh`), `zip -qr
  dist.zip dist`, run natively, paste the `[scrub-perf]` block.
- **Check the `build N.N.N` stamp** in the Environment/`[mem]` lines first — it
  catches stale bundles (old tabs, HTTP cache). `build.sh` injects it via
  `esbuild --define`.
- **Flags** (`?ablate=…`, composable): `nowheelcache` / `nohandcache`
  kill-switches, `onecanvas`, `facebuffers`, `staggertick`, `dpr1`, `nobezel`,
  `faces=N`, plus `?tickprofile=1` (attribution + part-type + `[mem]`),
  `?probe`, `?fps=1`, `&t=<ms>&dir=0` (freeze time). Full list in the
  investigation doc.
