# Phase 3: face-buffer caching — order-preserving prefix caches, not z-layers

*2026-07-04* · **Status: design for review — nothing implemented.**
Expands the "Phase 3" paragraph of
[2026-07-03-scrub-render-perf-investigation.md](2026-07-03-scrub-render-perf-investigation.md).

## Why (one paragraph of context)

Phases 0–2b established that scrub render cost is proportional to **drawn
content volume** per frame: Chrome pays main-thread raster-prep for every
command regardless of canvas count (~25 ms/frame for 16 full faces); Safari
pays issuance (~11 ms) plus per-layer commit. Halving content (staggerrender)
halved the cost and reached Chrome ~42 / Safari ~45 fps. To reach 60+, we must
cut per-frame content by ~4–8×, without changing what a frame looks like.

## The core objection this design must answer

You cannot draw an animating part "on top of" a flattened face image: parts
draw in XML document order, and an animating hand may sit *below* other parts
(windows, covers, terminator leaves, later static blocks). Reordering draws —
z-layer indexing — was considered and rejected previously, and this design
**does not reintroduce it**. Nothing is ever drawn out of document order.

## The idea: cache a document-order *prefix*, live-draw the *tail*

For a parts list `P[0..n)` in document order, pick a split index `k`. Then:

- **Prefix buffer**: an offscreen canvas holding `P[0..k)` rendered normally
  (same code path as today — including static-block blits, live parts, window
  cutouts — just targeted at the buffer instead of the screen).
- **Per frame**: blit the prefix buffer (1 drawImage), then draw `P[k..n)`
  live, in document order, exactly as today.

Appearance is *exactly* today's rendering for any `k`: the buffer is not a
flattening trick, it is a snapshot of "everything below the split line", and
everything at-or-above the line still draws in order on top of it. The whole
question becomes: **how high can `k` sit, and how often must the buffer
rebuild?**

- If nothing in `P[0..k)` changed since the buffer was built, the blit is
  pixel-identical to redrawing — rebuild is only needed when a prefix part's
  value changes (at most once per scrub tick; staggerable across faces).
- Parts in the tail `P[k..n)` render every frame at full smoothness — beat
  sweeps preserved, no 10 Hz stepping — because they were never cached.

**What the buffer does and doesn't sacrifice (the year-digit question, and
the fidelity dial):** buffered parts are *not* frozen — every change is
captured, because the buffer rebuilds each tick. When the year digit rolls
over at some tick, that tick's rebuild renders it; no anticipation is needed
and no split-point recomputation happens. What buffered parts give up is
*intra-tick* smoothness: their slide animations get sampled once per rebuild
(≈ tick rate) instead of every frame.

There is no free class of "parts that don't animate": Chronometer parts
emulate physical mechanisms — everything slides, wheels included (their
sweeps are just discretely triggered). **Fidelity rule (decided 2026-07-04):
perceived smoothness is gated by the slowest visible part, so no perceptibly
moving part may render below frame rate.** Tick-rate sampling of visible
slides is therefore out. Buffers may hold only:

1. **Sub-pixel movers** — parts whose per-*tick* screen motion is < ~1 px in
   the current mode (outer-planet hands during day-scrub; year wheel between
   rollovers; HMS during day-scrub, which move 0 px). Pixel quantization
   makes per-frame and per-tick sampling pixel-identical for these, so
   buffering costs nothing perceptually. Computable per part per mode from
   value deltas — a threshold, not a judgment call.
2. **Rare movers during their slides** — when a buffered part does slide
   (year rollover), its buffer rebuilds *every frame* for the few frames of
   the slide: full fidelity during the event, amortized to nothing.

The win therefore equals the quiescent+sub-pixel content share per mode —
a measurable quantity, not a policy dial. Same rule, applied elsewhere:
**staggerrender is disqualified as a shipping config** (each face at ~21 Hz
under a 42 fps global rate is worse than uniform ~29 by this criterion); it
remains a measurement instrument. And the live set being larger under this
rule raises the value of hand-bitmap caching (below).

**The split set is per scrub unit** (day was just the first case measured;
hour and month are equally in scope):

- *by day*: HMS hands don't move → top suffix buffer never rebuilds; middle =
  daily movers ≥1 px/tick (astro hands, moon, terminator, day/night wedges,
  date wheels); sub-pixel movers (outer planets, year wheel) buffer.
- *by hour*: HMS sweep continuously → they join the live middle (the suffix
  buffer may be empty — the sandwich degrades gracefully); calendar and other
  slow movers buffer (sub-pixel per hour-tick).
- *by month*: calendar and moon are the fast movers → middle; HMS still →
  suffix buffer again; year wheel slides every ~12 ticks (rare-mover rule:
  frame-rate rebuilds during those slides).

The framework is the same in every mode; only the assignment changes, and it
is still a function of part type + scrub unit, not of which tick we're on —
which is all "sticky" ever needs to mean.

**Three-piece sandwich (motivated by HMS-on-top):** hour/minute/second hands
almost always sit at the *top* of the document order (they span the whole
face). During scrub-by-day they don't move at all — so a *suffix* buffer
`P[j..n)` captures them and never rebuilds during the scrub. Per frame:
blit bottom buffer `[0..k)` → live-draw middle `[k..j)` → blit top buffer
`[j..n)`. The live middle shrinks to just the between-ticks smooth animators
(astro hands, moon indicators, terminator), which is where the content-volume
win comes from. Document order is preserved exactly at both seams; the only
constraint is not splitting between a `Window` and the drawable that
consumes it.

This is the same trick the existing `<static>` cache system already plays
(cached spans + live parts between them, `renderer.ts`
renderPartsDocumentOrder), with two differences: the spans are chosen at
runtime from animation state rather than declared by the XML author, and they
include parts the author marked dynamic but which don't need per-frame motion
in this scrub mode. (Verified 2026-07-04: no face XML has a QHand inside a
`<static>` block — the `drawQHandsInParts` call on static children in
renderPartsDocumentOrder is vestigial for the current face set. A parse-time
warning would keep it that way; cheap cleanup, separate from this work.)

## Why this can win (and when it can't)

Per-frame content becomes `16 blits + Σ tail parts`. The win per face is
`1 − |tail| / |face|`, so everything depends on where the lowest
between-ticks-animating part sits in each face's document order. Watch faces
conventionally put hands near the top of the stack, so tails are *plausibly*
small for most faces — but this is exactly the kind of assumption this
project has learned to measure first:

**Instrumentation before implementation** (cheap, next build): for each face,
log the computed split index, tail part count, and tail share of today's
per-face render ms. That single console line predicts the total win before
any buffer code exists. Faces with early animating parts (a rotating
background disc would be the worst case) get little benefit and simply keep
rendering as they do today — correctness never depends on the split.

## Blit economics (are blits actually cheaper than drawing?)

Direct evidence from the codebase: **wedges already work this way.** `QWedge`
and `QDayNightRing` render via `getWedgeBitmap` — an appearance-keyed
offscreen cache — and blit the cached bitmap rotated/translated per wedge
(`renderer.ts` drawQWedge/drawQDayNightRing); path tessellation is only the
cache-miss fallback. Day/night rings are everywhere in these faces and their
per-face render costs are unremarkable, so rotated blits are demonstrably
compatible with the budget. Under the confirmed content-volume model, one
`drawImage` (a single recorded op) beats a multi-op path fill+stroke roughly
in proportion to the op count it replaces.

Corollary — **hand-bitmap caching** is a candidate content reduction for the
live middle: vector hands (drawHandShape / Quad / Sun / Breguet bodies) are
path-drawn per frame today, while image hands already blit. Narrow hands make
small bitmaps (~face-radius × hand-width at device res ≈ tens of KB each; a
few MB across all faces). The cache should be **appearance-keyed like
`getWedgeBitmap`**, not per-part: many faces reuse one hand shape across
subdials (e.g. Venezia's rise/set/transit subdials — three copies of the same
two shapes collapse to two bitmaps), and on all.html every face renders at
the same scale, so an appearance key shares bitmaps *across* faces too. Two
caveats: rotated blits resample (the wedge cache already accepts this,
matching iOS's image-sharing), and hands' aggregate share of frame cost is
unmeasured — the instrumentation build below reports per-part-type ms shares
so this gets sized before built. Note this lever matters *more* if the
fidelity policy keeps most parts in the live middle.

## Design details

- **Split-point constraints:** never split between a `Window` part and the
  drawable that consumes it (window+consumer are atomic). (`<static>` blocks
  need no special case — verified none contain QHands.)
- **Sticky split:** the tail/middle set is computed per face once per scrub
  session from part type + scrub unit (which parts need smooth per-frame
  motion in this mode) — it does not depend on which tick we're at, so no
  mid-session recomputation. Prefix/suffix changes of any kind are captured
  by the rebuild schedule. Conservative choice (larger middle) is always
  safe.
- **Rebuild schedule:** a face's buffer rebuilds when any prefix part's value
  changed — during scrub-by-day, at most once per tick. Stagger rebuilds
  (~2 faces per frame, reusing the staggertick frames-since-tick machinery)
  so tick frames don't spike. Force rebuild + full redraw on scrub end,
  stop, env rebuild, resize, and cache invalidation.
- **Composition with onecanvas:** buffers blit into the shared canvas
  (Safari needs the single layer; Chrome is indifferent). The prefix buffer
  is face-local, so it uses the existing face-origin viewport mechanism.
- **Memory:** 16 buffers at 1072² × 4 B ≈ 73 MB at desktop dpr 2 — roughly
  doubles face-canvas memory. Desktop OK; on phones faces are smaller but
  this needs a check against the ~100 MB budget before shipping (option:
  buffers at reduced resolution on small screens, or only for the visible
  page).
- **Non-scrub mode:** the same structure helps normal 1× running (second
  hands are the only per-frame animators on most faces; prefix rebuilds
  ~once/minute) — but that's a later, separate enablement; Phase 3 scopes to
  scrub.

## Prototype vs production

- **Prototype (`ablate=facebuffers`), measurement-first:** fix `k = n` (whole
  face in the buffer), rebuild once per tick staggered, blit per frame. This
  measures the *ceiling* (content ≈ 16 blits) with ~40 lines of engine code
  and no split-point logic. Visual compromise, prototype only: every part
  steps at tick rate (~10 Hz) during scrub — beat sweeps frozen between
  rebuilds. Projection from the confirmed model: Chrome anim frames ~8–10 ms
  (→ comfortably past 60 fps overall), Safari ~12–16 ms (→ ~60 fps).
- **Production:** the dynamic sandwich (bottom buffer / live middle / top
  buffer); middle parts keep full-rate sweeps, so there is no visual
  compromise at all. Cost sits between the prototype ceiling and today, per
  the measured middle shares.
- **Considered and deferred — dirty-rect rendering:** redraw only parts
  intersecting the union of animating parts' bounds (in document order, with
  a clip). Order-correct and buffer-free, but needs bounds tracking for
  every part type and degenerates with large animated regions (wedges,
  terminator). Revisit only if measured tail shares are bad.

## Open questions for review

1. ~~Fidelity policy~~ **Resolved 2026-07-04:** no perceptibly moving part
   below frame rate; buffers hold only sub-pixel-per-tick movers and
   quiescent parts, with frame-rate rebuilds during rare slides. The win is
   now the measured quiescent+sub-pixel content share per mode.
2. Is the part → driving-obsValues mapping directly available? (The updater
   binds values per face; the split computation needs "does part P evaluate
   any value in the smooth set". Worst case: mark parts dirty during eval.)
3. Any faces with fast movers near the bottom of the stack (rotating
   discs/backgrounds)? Those faces cap their own win but don't affect others.
4. Is the ~73 MB desktop buffer memory acceptable to ship, given the phone
   budget note — or should buffers be scrub-session-scoped (allocated on
   scrub start, freed on end)?

## Measurement plan — ✅ build shipped 2026-07-04 (dist.zip)

1. ✅ **Per-part-type render attribution** (`renderer.ts` setPartProfiling,
   enabled with `?tickprofile`): "Render ms/frame by part type" line in the
   scrub summary. Note its meaning depends on config — under normal/onecanvas
   configs it is the per-frame content mix (what sizes hand bitmaps and the
   live middle); under facebuffers it shows amortized *rebuild* content.
   (The quiescent/sub-pixel share measurement rides on the part→value
   mapping and comes with the production split work; thresholds to report:
   0.25/0.5/1 px per tick, per Steve's sub-pixel-visibility caveat.)
2. ✅ **`ablate=facebuffers` ceiling prototype**: whole-face buffers
   (HTMLCanvas, circle-cropped like the CSS crop), rebuilt round-robin ≤4
   faces/frame once per tick, blitted every frame; falls back to direct
   render until a face's first rebuild; composes with onecanvas. What it
   teaches: (a) the price of the blit substrate the sandwich sits on
   (production ≈ 2× the ceiling's 16 blits), (b) go/no-go — if the ceiling
   can't clear 60 fps the sandwich can't either, (c) rebuild-scheduler and
   ~73 MB buffer behavior. VM smoke (60 Hz cap, directional): facebuffers
   53.9 fps, onecanvas+facebuffers **59.2 fps pinned at the cap** (interval
   16.45 ms ≈ one 60 Hz slot), issuance 3.3–4.0 ms; visuals correct.
   Also in this build: shared-canvas offset sync now detects position-only
   relayouts (controller-avoidance grid shift).
3. **Native run sheet** (noprobe, ×3 per browser): `ablate=facebuffers`,
   `ablate=onecanvas,facebuffers`, plus one plain `ablate=onecanvas` run to
   capture the part-type content mix for hand-bitmap sizing. Headline
   numbers: overall fps and the anim-frame interval (the 240 Hz display can
   finally show >60).
4. Decision gate: if `onecanvas,facebuffers` clears ~60 fps in both browsers,
   proceed to the dynamic-split production design with measured shares; if
   not, the residual goes back through the profile's ledger.

## Ceiling results (2026-07-04, native) — gate passed; wheels unmasked

Raw data: [2026-07-04-phase3-ceiling-native-timings.txt](2026-07-04-phase3-ceiling-native-timings.txt).

**Chrome: gate cleared with ~60% headroom.** `onecanvas,facebuffers`:
**92.5–97.4 fps overall** (anim intervals 8.7–9.1 ms ≈ 110–116 fps; tick
frames ~24 ms with 4 rebuilds each). `facebuffers` alone: ~90 fps. Baseline
was ~29. The blit substrate is essentially free in Chrome (anim-frame
issuance ~3.1 ms for 16 blits + clears).

**Safari: passes only in its fast state; bimodal as ever.**
`onecanvas,facebuffers` runs: 35.3 / **57.0** / 37.8 fps. The good-state run:
anim intervals 15.2 ms (≈66 fps), slack 6.1, issuance 2.3 — overall 57 with
**tick frames now the binder** (body ~23 ms, of which update/eval ~15.6 —
a CPU problem, not a render problem; staggertick is the built lever).
Slow-state runs lose ~8 ms/frame across eval AND slack. `facebuffers` alone
(16 canvases) stays ~31 fps — the ~18 ms per-layer commit persists, so
onecanvas remains mandatory for Safari. (One Safari run hit a massive
thermal/GC event — 48% lost ticks, eval 26 µs — discarded.)

**The content mix (plain onecanvas, Safari, Σ 10.19 ms/frame):**
**Wheel 4.58 (45%) · Terminator 2.37 (23%) · QHand(vector) 1.23 (12%)** ·
QWedge 0.46 · QDayNightRing 0.42 · QRect 0.29 · everything else < 0.25.
Two consequences:

1. **Wheels are the dominant content class, and they're uncached.**
   `drawWheel` re-runs measureText over every label + fillText per digit,
   per wheel, per frame — no appearance cache. Since a wheel band's artwork
   is constant (only its rotation changes), the wedge-bitmap pattern applies
   directly: **wheel-bitmap caching gives frame-rate wheel slides at blit
   cost**, dissolving the fidelity-vs-cost tension for the biggest Safari
   content item with no policy compromise. It also helps every config,
   including today's shipping page.
2. **Hand bitmaps demoted:** QHand(vector) is only 12% of issuance — wheel
   bitmaps first, terminator (23%, morphing leaf paths, harder to cache)
   second if still needed.

**Revised production order:**
1. **Wheel-bitmap cache** — ✅ implemented 2026-07-04 (`renderer.ts`
   drawWheel; kill-switch `?ablate=nowheelcache`), covering **all** wheels.
   Full-circle wheels rotate rigidly and cache directly. Partial-arc digit
   wheels (Chandra day / Vienna year etc.) originally counter-rotated their
   labels to stay upright — verified to be a **web-port deviation from iOS**:
   ECQWheelView drawLabels (.chronometer-ref/Classes/ECQView.m ~2586) steps
   the CTM per label with no counter-rotation, baking glyphs rigidly into the
   disc texture, per the rotating-disc intent. The counter-rotation was
   removed, making partial-arc wheels rotation-invariant (blit with −angle;
   reversed slot progression) and cacheable. Behavior change: digits now tilt
   with the disc by up to one slot (~8°) mid-roll, matching iOS; rest
   positions are pixel-equivalent (the removed rotation was provably zero for
   the visible digit at rest). Guard: a partial-arc wheel with ticks or
   halfAndHalf would mix rotation signs and stays live (none exist today).
   halfAndHalf `difference`-blend text is baked against the ring inside the
   bitmap — band-edge AA fringes only. Verification (VM): Vienna "JUL 04 /
   2026" and Terra "Thursday / MAY 28" + 24h ring correct and crisp at full
   size; frozen-time cache-vs-live pixel diff bounded to glyph-edge AA shifts;
   Chrome A/B Wheel 1.99 → 0.63 ms/frame, issuance 5.28 → 3.8 ms. Safari
   native (wheels were 4.58 ms, 45% of issuance) should gain far more —
   remeasure with the baseline-vs-nowheelcache pair.
2. **Sandwich buffers** per this doc (wheels may stay in the live middle at
   full fidelity once they're blits).
3. **staggertick** (or production tick-stagger) for Safari's tick-frame eval
   spike — composes with 1–2.
4. Terminator leaf-draw optimization only if Safari still falls short.

Projection: Chrome is done (95 fps ceiling, and adding a live middle of a
few ms keeps it comfortably over 60). Safari good-state = 57 now; wheel
bitmaps (+~1.3 ms/frame rebuild savings, more in the live middle later) and
tick-stagger (~7 ms off tick frames) project past 60; slow-state Safari
remains hostage to its own CPU state, which no rendering fix addresses.
