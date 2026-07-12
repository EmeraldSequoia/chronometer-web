# Session handoff — scrub render performance work (2026-07-06)

Continuation notes for a fresh session. The full narrative lives in
[2026-07-03-scrub-render-perf-investigation.md](2026-07-03-scrub-render-perf-investigation.md)
(chronological, includes every native dataset) and
[2026-07-04-phase3-face-buffer-caching.md](2026-07-04-phase3-face-buffer-caching.md)
(the sandwich design + fidelity rule). This doc is the "start here" summary.

## Scoreboard (native, all.html scrub-by-day, no flags)

- Start of investigation (07-03): Chrome ~29 fps · Safari ~28 fps.
- Latest measured (timings-10, 07-06, stamped build 2.0.33): **Chrome 66.3**
  (thermal-warm run, was 78.7 cold — not a regression) · **Safari 24.0–24.7
  under `onecanvas`**. Baseline (timings-9): Chrome 78.7–79.7 · Safari 34.0
  fast-CPU-state / 26.1–26.8 slow. Hand unification validated on BOTH
  engines; the TRUE `nohandcache,nowheelcache` A/B showed Safari collapsing to
  **12.7 fps** (slack 17 → ~50 ms) — the caches are load-bearing via *raster*
  (live shadow-blur hands are the bomb). The old "hand cache is a wash"
  verdict is retracted.
- **facebuffers ceiling (timings-11): Safari 26 → 44 fps** (whole-face
  buffering, +~68% at matched CPU), and it cut the **slack** 17 → 11 ms as
  well as issuance 7.4 → 1.4 ms. This settles the Safari model:
  **slack ∝ draw-operation count** — Safari defers per-canvas raster of the
  issued ops to post-rAF slack. onecanvas failed because it kept every op
  (just moved them to one canvas); facebuffers wins because it cuts ops to
  ~1/face. The timings-10 "composite-area" read is superseded (the "content
  not layer count" part holds). **BUT 44 is the optimistic ceiling** —
  achieved via tick-rate stepping (fidelity violation); a fidelity-preserving
  sandwich captures only the slow-mover share (~+5–10 fps).
- **Chrome's 60 fps target: met at plain baseline.** Safari is the open
  front; phones run WebKit, so Safari work = phone-tier work. dpr1 is off the
  table (Steve: full-res is a hard constraint). Next: middle-share
  instrumentation to size the fidelity-preserving fraction of the ceiling
  (see queue).
- Memory (4K profile): 258.0 MB canvas/bitmap after hand unification
  (shadows 20.1 → 0, hand cache 8.2); `[mem]` ledger line in every scrub
  summary tracks it. Device targets in the main doc ("Device targets &
  memory ledger"): 100 MB floor → 500 MB 4K.

## State of the tree

- Committed through `87881ca` (glyph-atlas wheels, probe fix, analemma scrub
  fix, Chrome >60 milestone).
- **Uncommitted (verified, in dist.zip 2026-07-05 20:27):** terminator-leaf
  Path2D cache; vector+image hand split-shadow caches (screen-fixed light);
  deletion of the April `buildHandShadowCaches` machinery (~200 net lines
  removed, `_shadowBitmap*` fields gone); zero-eval hand memo; ledger
  `hand cache` category (`shadows` now reads 0.0). Suggested commit message:
  "Hand/terminator caches: split shadows (fixed light), delete prebuilt
  shadow machinery".
- **timings-8 captured and analyzed 07-06** (archived as
  [2026-07-06-hand-caches-native-timings.txt](2026-07-06-hand-caches-native-timings.txt)):
  Chrome 78.7 fps on the new bundle ✓; Safari runs came from an old tab still
  on the timings-7 build (per Steve — not caching). Led to the build stamp.
- **Build stamp added 07-06 (v2.0.33, also uncommitted):** `build.sh` injects
  the version via `esbuild --define:__BUILD_VERSION__`; the `[scrub-perf]`
  Environment line and startup `[mem]` line print `build N.N.N`. Check the
  stamp before trusting any pasted block, and reload every tab onto the new
  build when a zip lands (timings-9's Chrome run came back unstamped — a
  leftover tab again, this time Chrome's).
- **timings-9 captured and analyzed 07-06** (archived as
  [2026-07-06-true-handcache-ab-native-timings.txt](2026-07-06-true-handcache-ab-native-timings.txt)):
  Safari validation ✓ + true hand A/B ✓ (see scoreboard). The whole
  uncommitted set is now validated on both engines — **ready to commit**
  (suggested message above, plus the build stamp).
- **timings-10 captured and analyzed 07-06** (archived as
  [2026-07-06-onecanvas-remeasure-native-timings.txt](2026-07-06-onecanvas-remeasure-native-timings.txt)):
  onecanvas refuted (see scoreboard + "timings-10" in main doc). No code
  change — measurement only.
- **timings-11 captured and analyzed 07-06** (archived as
  [2026-07-06-facebuffers-ceiling-native-timings.txt](2026-07-06-facebuffers-ceiling-native-timings.txt)):
  facebuffers ceiling — Safari 26 → 44 fps, slack reducible (see scoreboard +
  "timings-11" in main doc). No code change — measurement only.

## Product constraint (2026-07-06)

**Steve rejected `dpr1` — full render resolution is a hard constraint; take
the fps hit over softening the faces.** ([[no-resolution-for-fps-tradeoffs]]
in memory.) Every lever must preserve full-res output. Note this rules out
*resolution* reduction, NOT op-count reduction: timings-11 showed the slack is
reducible by cutting draw-operation count (buffering), full-res, so buffering
is still on the table — dpr1 was just a different (rejected) way at the same
slack.

## Safari model (settled at timings-11)

Interval = body-CPU + post-callback slack. **Both are draw-op-count driven:**
Safari defers per-canvas rasterization of the issued draw ops to the slack, so
`slack ∝ ops` (≈100/face). Levers, by what they do to op count:
- onecanvas — keeps all ops (moves them to 1 canvas) → slack unchanged → **dead.**
- dpr1 — cuts pixels not ops → **rejected** (full-res is a hard constraint).
- **buffering (facebuffers/sandwich) — cuts ops to ~1/face → cuts BOTH halves,**
  facebuffers ceiling Safari 26 → 44 fps — BUT only by letting faces step at
  tick rate, which the product can't accept (see below) → **dead too.**

## Sandwich verdict: DEAD (2026-07-06, Steve's design constraint)

[[no-quiescent-layer-during-scrub]]: **by design no face part updates less
often than the tick** — every astro part (terminator, day/night, wedges,
analemma) moves a visibly different amount per simulated day, scrub-by-**month**
is an equally-important benchmark (parts move even more), and the desired
direction is *more* frequent updates on 4K/5K, not fewer. So the buffering
premise (a quiescent/sub-pixel layer to blit stale) has ~0 bufferable share
here. The facebuffers 44 fps is unreachable at fidelity. **The middle-share
instrumentation is NOT worth building** — Steve's domain knowledge already
answers it (~0). Sandwich + facebuffers-style buffering are off the table.

## Next-step queue (in order)

1. **Tick-stagger** — the only remaining full-fidelity, full-res,
   full-update-rate lever. Spreads the per-tick update spike (Safari
   slow-state tick frames 26–29 ms body CPU → 43–47 ms after-tick intervals)
   across frames without dropping any frame's content. `staggertick` flag
   showed +5–6 fps in earlier probes; production version = spread the tick
   update work, not skip it. Op-count-neutral (doesn't touch slack), so
   ceiling is modest. Measure a clean native `?ablate=staggertick` A/B first.
2. **Wrap-up path** (likely). If tick-stagger's win is small, the honest
   end-state is: Chrome meets 60 (66–79 fps); Safari/phones ~26–34 fps is the
   **characterized cost of full-res continuous celestial motion on WebKit**,
   with slack ∝ op count and no fidelity-free way to cut ops. Commit the
   banked wins, write the closing verdict, clean up loose `timings-*.txt`.
   (Speculative-only, needs Steve's appetite: level-of-detail *during motion*
   — fewer ops while actively scrubbing, full detail when stopped; a
   detail-during-motion trade distinct from dpr1's static-image softening.
   Probably also unwelcome given the "more updates, not fewer" direction.)
4. **Phone-floor / memory track** (orthogonal) — see the standalone plan
   [2026-07-06-memory-phone-floor-plan.md](2026-07-06-memory-phone-floor-plan.md).
   CORRECTION (verified 2026-07-06): dataUrl release AND Observatory-style lazy
   city load/parse are **already implemented** — the earlier "chronometer still
   eager-parses 167k cities" was stale. The one real remaining lever is
   decoding source images at display size (the 82 MB `createImageBitmap`).
5. Parked: dirty-rect alternative, `_hbMemo` dynamic-color support (fixed
   appearance is the contract), image-hand `_imageHandShadowCache` memo,
   **per-face 1× render gate** (battery nice-to-have, fidelity-free; ready-to-
   run plan: [2026-07-07-per-face-render-gate-plan.md](2026-07-07-per-face-render-gate-plan.md)).
6. **Z-order layering: assessed and rejected 2026-07-07** (bounded by
   facebuffers on every axis; memory table + correctness analysis in the
   investigation doc; one-liner in performance.md).

## Mechanics a new session needs

- **Flags** (all composable): `?tickprofile=1` (attribution + part-type +
  memory lines), `?probe` (flush probe, OPT-IN — as default it caused a
  sticky page-wide Chrome 15 fps throttle; never re-enable by default),
  `?fps=1` overlay, `&t=<ms>&dir=0` freezes display time (deterministic
  pixel comparisons), `?ablate=` list: `nowheelcache`, `nohandcache`
  (kill-switches for shipped caches), `onecanvas`, `facebuffers`,
  `staggertick`, `staggerrender`, `render`, `dpr1`, `nobezel`, `faces=N`
  (measurement ablations; staggerrender is NOT shippable per fidelity rule).
- **Measurement workflow**: authoritative numbers come from Steve's native
  240 Hz machine — build `bash build.sh`, `zip -qr dist.zip dist`, he runs
  and pastes `[scrub-perf]` blocks (hold **+day** ~6 s; medians of 3; Safari
  is thermally/JIT bimodal — match CPU states via the µs/eval line). VM
  preview = mechanism checks only (60 Hz cap, software raster): serve dist
  on a FRESH port each rebuild (launch.json has dist-fresh* entries),
  scrub programmatically by dispatching mousedown/mouseup on
  `[data-step="+day"]`, frozen-time pixel diffs via sessionStorage
  128px-downsample compare (see transcript pattern; auto-memory also has
  these recipes).
- **Verification bar for renderer caches**: frozen-time diff vs kill-switch
  (expect only resample-class residuals, ≤~0.2%/face), full-grid screenshot,
  single-face screenshots for text/detail (vienna, terra), part-type ms
  line before/after, `[mem]` line, native eyeball by Steve for anything
  with a quality trade.
- **Key model facts** (hard-won; don't re-derive): render cost ∝ drawn
  content, and the expensive content is glyph/path RASTERIZATION, not
  issuance — costs hide in post-rAF slack, not the issuance column (wheels
  were 45% of Safari issuance but ~20 ms of Chrome slack). Canvas count is
  irrelevant in Chrome, ~1 ms/layer in Safari. `getImageData` per frame on a
  visible canvas poisons Chrome (probe story). All 16 faces always have
  beat-sweep animations during scrub (face-level idle skipping is a no-op).
  Wheels/wedges/hands/leaves now all follow the appearance-keyed
  bake-once-blit-rotated pattern; partial-arc wheels and digit tilt match
  iOS's rigid-disc rendering (verified against .chronometer-ref sources).
