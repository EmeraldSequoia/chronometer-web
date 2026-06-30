# Scrub Performance — Next Levers (fresh measurement + plan)

**Date:** 2026-06-29
**Status:** Measurement done; levers identified; **no implementation yet — awaiting review.**
**Supersedes the open work in** [2026-06-28-per-tick-astronomy-memoization.md](2026-06-28-per-tick-astronomy-memoization.md).
That doc's §4b program (sort-by-display-time + single slot cache, `tickMemo` retired) is **shipped
and closed** (Stages 1, 2a–2d, all bit-identical). This doc starts from the post-2d state and
re-profiles *every* face to find what dominates now.

**Probe:** `planning/step0-tick-profile.ts` (Node `updater.tick` profiler — real `performance.now()`,
per-function attribution, eval/boundary/interp/rest split, GC). Node-based, repeatable; we are
deliberately **not** using the in-browser `?tickprofile` (its `now()` is clamped/noisy).
Run: `npx tsx planning/step0-tick-profile.ts <dir>/<Face-xml-basename>` (e.g. `selene/Selene-I`).

---

## TL;DR

- Re-profiled all 16 faces (warm tick, 2000-tick, 1 day/tick). **The astronomy-eval
  memoization from the prior doc holds** — Miami/Venezia/Selene eval is cheap now. But the
  heavy faces moved: **Gaia 5.5ms, Terra 4.7ms, Basel 4.3ms** are the new top three.
- **The recurring root cause is caching that was never wired up, not a need for new mechanisms.**
  Every lever below is "make the code use the slot cache the way iOS already did" (see new
  development-rule §17, added this session at Steve's direction). Three of the four heavy costs
  are functions re-running an identical search/format on every leaf because their slots are
  unused or their location collides with the observer's.
- **Levers, in recommended order:**
  1. **Basel LST day/night ring** (lever A) — `dayNightLeafAngleLST` runs 2 root-finder searches
     **per leaf** (33 leaves → 66 searches/tick), 112µs/call vs the plain ring's 2.73µs. The cause:
     the `dayNightMasterRiseAngleLST…` **slots already exist but are referenced nowhere** — the LST
     path never caches. iOS used **one** `dayNightLeafAngleForPlanetNumber:…:timeBaseKind:` that
     indexes those LST slots via a `possibleLSTOffset`. Fix = wire the LST path to its existing
     slots (ideally unify the two TS functions like iOS). **Est. Basel 4.3ms → <1ms.** Highest
     confidence, smallest blast radius.
  2. **Boundary-scheduling tax** (lever B) — `computeNextBoundary`→`nextPlanetRiseSet` resolving event
     sentinels is unmemoized and allocates a fresh pool per call. **⏸️ ATTEMPTED → DEFERRED** (see impl
     log): iOS memoizes this on the shared pool in dormant result slots, but the TS **eval-ahead**
     (eval at `finalCache@boundary` while the sentinel search runs at `now`) cross-talks on the shared
     `midnightCache` — the per-call fresh pool was isolating exactly that. ~0.6ms (7%) left; revisit via
     a **multi-display-time pool** or the **two-phase restructure** *after* render work.
  3. **Gaia per-city day/night rings** (lever C) — `dayNightLeafAngleForSlot` at a non-observer
     location **bypasses `getMasterRiseSet`'s memo entirely** (the slot is keyed by `planetNumber`
     and valid only for the observer; 4 Sun rings at 4 cities would collide). So every leaf re-runs
     the full search → 111 searches/tick. Needs per-location (per-slot) cache keying.
  4. **Terra timezone functions** (lever D) — **not astronomy at all.** `moreDay`/`lessDay`/
     `tzOffsetAngleN` each construct a **fresh `Intl.DateTimeFormat` per call** (`getTzOffsetSeconds`,
     ~30–80µs of allocation). 72 calls/tick → ~4ms of pure formatter churn. Fix = cache the
     `Intl.DateTimeFormat` per `olsonId` (and/or memoize the offset per `(olsonId, day)`). Trivial,
     high payoff. (The slot cache does *not* apply here — it's not `(location, di)` astronomy.)
- **Budget reconciliation:** the all-faces Node sum is ≈21ms, ~2× the prior doc's browser ~10.8ms.
  Steve confirms the face set is unchanged (>1 month) and all faces were on-screen, so the gap is
  **almost certainly the profiler running Gaia/Terra with their city slots unset** (they fall back
  to the observer / take cheaper paths in a way the browser doesn't). **Action: enhance the profiler
  to load the real default city slots** before quoting any "% of budget".
- Deferred (unchanged): the DEL-ring 29 distinct `moonAge` computes (0.66ms on Selene) — needs a
  cheaper lunar series, not caching. Only worth it if it becomes dominant; it isn't.

---

## 1. Current measurements (warm tick, Node, 2000-tick, 1 day/tick)

| face | warm tick | profiled update split | top contributor(s) |
|---|---:|---|---|
| **gaia** | **5.52 ms** | eval 6.56, boundary 0.01 | `dayNightLeafAngleForSlot` 4.32 (92 calls, 47µs) |
| **terra** | **4.75 ms** | — | `moreDay` 1.93 + `lessDay` 1.50 + `tzOffsetAngleN` 0.90 (24 calls ea) |
| **basel** | **4.27 ms** | eval 5.09, boundary 0.01 | `dayNightLeafAngleLST` 3.71 (33 calls, **112µs**) |
| **selene** | **1.83 ms** | eval 1.67, **boundary 0.53** | DEL 0.66 + phases 0.38 + rise/set 0.28 + boundary 0.53 |
| **kyoto** | **1.44 ms** | — | `angleForJapanHour` 1.00 (83 calls) + `solarNoonAngle` 0.31 |
| geneva | 0.82 ms | | |
| hana | 0.81 ms | | |
| **venezia** | **0.63 ms** | eval 0.10, **boundary 0.66** | **scheduling-bound** — boundary is 85% of update |
| miami | 0.45 ms | eval 0.54 | `dayNightLeafAngle` 0.33 (memoized, 2.73µs/call) |
| vienna | 0.29 ms | | |
| mauna-kea | 0.17 ms | | |
| chandra | 0.05 ms | | |
| haleakala | 0.05 ms | | |
| firenze | 0.03 ms | | |
| babylon | 0.015 ms | | |
| milano | 0.003 ms | | |
| **SUM** | **≈ 21.1 ms** | | top 5 (gaia+terra+basel+selene+kyoto) = 17.8ms = **84%** |

Cross-cutting reads:
- **Eval astronomy is no longer the universal villain** — Miami/Venezia/Firenze eval is sub-0.1ms;
  the prior doc's memoization stuck. The cost migrated to (a) *un-memoized* ring variants (Basel
  LST, Gaia/Terra per-slot), and (b) the *scheduler* (boundary).
- **`computeNextBoundary` is now visible and large** on event-sentinel faces (Venezia, Selene).
  It was out of scope before (the §4b work explicitly left `perfNow`/scheduling untouched).
- **GC is 0ms** everywhere; cold/warm ratio ~1–3× (real work, not warm-up) — consistent with the
  prior doc. Profiler `now()` overhead is small (≤0.05ms/tick).

### The budget question (resolve by fixing the probe, then re-summing)

60fps budget = 16.67ms. The all-faces Node sum (≈21ms) is **127% of budget**. The prior doc cited an
*in-browser* all.html tick of ~10.8ms (~65%). Steve's review settled the candidate explanations:
- **Face set unchanged** for >1 month; these measurements are <1 week old → not a face-set drift.
- **All faces were on-screen** in the browser reading → not off-screen throttling.
- **Most likely: the probe runs Gaia/Terra with their city slots _unset_.** The probe constructs the
  env at Miami's observer and never populates `terraRingDefaults` / Gaia slots, so the world-clock
  faces take fallback/observer paths that differ from the browser (where real cities are configured).
  Both the absolute ms *and* the cross-face sum are therefore untrustworthy for those two faces.

**Action (prerequisite for a real budget number): enhance `step0-tick-profile.ts` to load the real
default city slots** for Terra and Gaia (see §0 below), then re-measure those two and re-sum. Until
then, treat the 21ms sum as an upper-bound estimate and the per-face *shape* (which function
dominates) as the reliable part.

---

## 0. Probe enhancement — load real default city slots (do first)

The profiler ([step0-tick-profile.ts:36](step0-tick-profile.ts#L36)) does
`createWatchEnvironment(watch, 37.3349, -122.0090, getNow)` and never configures world-clock slots.
For Terra/Gaia that means `terraRingDefaults` is whatever the env builds by default (possibly empty
→ `dayNightLeafAngleForSlot` hits its observer fallback; `moreDay`/`lessDay` may early-return). The
browser, by contrast, populates the default city set. **Match it:** find where the engine seeds the
default Terra/Gaia slots (`rebuildTerraForSlotChange` / `rebuildGaiaForSlotChange` in
[engine-entry.ts](../src/engine-entry.ts#L2941), and the slot defaults they read) and apply the same
seed in the probe before the warm-up loop. Then re-run Terra/Gaia and record real numbers.

This is a measurement-fidelity fix, not a perf change; it gates the budget claim and the sizing of
levers C/D. Cheap; do it first.

---

## 2. Lever A — Basel's LST day/night ring (recommended first)

**Finding.** `dayNightLeafAngleLST` ([astro-env.ts:2705](../src/shared/astro-env.ts#L2705)) is 87%
of Basel's tick: 3.71ms over 33 calls @ 112µs. It calls `nextPrevRiseSetInternal` **fresh, twice per
leaf** (rise + set, [astro-env.ts:2723](../src/shared/astro-env.ts#L2723)) — 33 leaves × 2 = 66
root-finder searches/tick, none cached. The plain local-time `computeDayNightLeafAngle`
([astro-env.ts:2200](../src/shared/astro-env.ts#L2200)) instead routes through `getMasterRiseSet`,
which memoizes into `dayNightMaster*` slots so all leaves of a ring share **one** search/tick (Miami:
2.73µs/call — 41× cheaper). Confirmed by the astronomy counters reading `master 0.000 / leaf 0.000`
for Basel (the LST path touches neither memo).

**The slots already exist — they're just unused.** `CacheSlot.dayNightMasterRiseAngleLST` /
`SetAngleLST` / `RTransitAngleLST` / `STransitAngleLST` (planet-indexed 0..9) are defined in
[astro-cache.ts:266](../src/astronomy/astro-cache.ts#L266) and **referenced nowhere outside the enum**
(grep-confirmed). This is the development-rule §17 pattern exactly: a port artifact where the slots
were carried over but never wired.

**What iOS did (the design to mirror).** iOS has a *single*
`dayNightLeafAngleForPlanetNumber:leafNumber:numLeaves:timeBaseKind:`
([ECAstronomy.m:4560](../.chronometer-ref/Classes/ECAstronomy.m#L4560)) for both time bases. It picks
the slot block with an offset:
```objc
int possibleLSTOffset = timeBaseKind == ECTimeBaseKindLT ? 0
                        : (dayNightMasterRiseAngleLSTSlotIndex - dayNightMasterRiseAngleSlotIndex);
int masterRiseSlotIndex = dayNightMasterRiseAngleSlotIndex + planetNumber + possibleLSTOffset;
```
then `if (cacheSlotValidFlag[masterRiseSlotIndex] == currentFlag) read; else search + store`. So iOS
caches the rise/set **angle** (post-conversion) inline against the slot cache, keyed by
`planetNumber (+ LST offset)` — **no separate `getMasterRiseSet` wrapper.**

**On `getMasterRiseSet` (answers "why do we need it / was it in iOS?").** It was **not** in iOS — it's
a TS-port wrapper that re-implements the inline slot-caching iOS did, but only for the local-time path
and caching *times* (`dayNightMasterRiseTime`) rather than *angles* (`dayNightMasterRiseAngle`). It's
not wrong, just a bespoke layer that the LST path never got. We don't strictly need it; the clean end
state is the iOS shape.

**Fix — DECIDED (Steve, 2026-06-29): the iOS-unified form.** Unify the two TS functions into one
parameterized by `timeBaseKind`, selecting the slot block via the `possibleLSTOffset` trick, exactly
as iOS does. Rationale (Steve): *"The closer we get to the iOS implementation, the easier it is to
reason about what the performance should be."* This caches the LST rise/set into the existing
`dayNightMasterRiseAngleLST…` slots, removes the orphaned slots, and retires the LT/LST divergence
permanently. As part of this, decide whether to keep `getMasterRiseSet` (LT/time-slot wrapper) or
fold it into the unified angle-slot path — favor whichever lands closest to iOS's single inline
cached function (which stored *angles*, keyed by `planetNumber (+ LST offset)`, with no wrapper).
*(The minimal "just wire the LST slots, leave two functions" variant is rejected — it would preserve
the very divergence we want gone.)*

**Risk/verify.** Must stay bit-identical (8506-test suite, Basel included). The LST path currently uses
`planetIsUpForRiseSet` + `-fudgeFactorSeconds` + `lookahead = 13.2h`; iOS's inline path uses the same
constants, so caching the result changes nothing but call count. **Est. impact: Basel 4.27ms → <1ms.**

---

## 3. Lever B — the boundary-scheduling tax (`computeNextBoundary`)

**Finding.** The scheduler's `computeNextBoundary` / `resolveSentinel`
([animation.ts](../src/shared/animation.ts) ~L275/L566) resolves each on-beat value's *next* update
boundary. For event sentinels (`updateAtNextMoonset`, `…Sunrise`, planet rise/set, …) that means an
**event search every tick** — and it is **unmemoized**. It now dominates the event faces:
- **Venezia:** boundary **0.66ms** of 0.77ms update (85%); eval is only 0.10ms.
- **Selene:** boundary **0.53ms** (the largest single non-DEL piece; see §5 of the prior doc's
  netting — this was never addressed by the eval-only §4b work).

**Why it was missed.** The entire prior program was explicit that it left the scheduler / `perfNow`
untouched (bit-identical guarantee depended on not reordering scheduling). So boundary resolution
was never memoized — and once eval astronomy got cheap, boundary popped to the top on these faces.

**Steve's model (review question).** Steve's proposed approach: at arrival we do no evals; **first**
all parts needing scheduling resolve their boundaries (at arrival/"now"), **then** all parts eval at
their future update times (already sorted, already on `finalCache`). If those are two clean phases, a
**single `finalCache` suffices for everything** — and Steve asked me to stop if that's *not* true.

**Traced the code — the model needs one structural change to hold (STOP / REVIEW).** Two findings:

1. **The boundary search is structurally disconnected from the pool.** `computeNextBoundary` →
   `resolveSentinel` → `nextPlanetRiseSet(isRise, planet, getNow, lat, lon, dir)`
   ([animation.ts:344](../src/shared/animation.ts#L344)) takes **no cache/pool/env-cache argument at
   all** — it cannot touch `finalCache` today. Each value's sentinel re-runs a full rise/set root-find;
   N moon-event hands ⇒ N identical searches (the 0.53/0.66ms). So Lever B *does* require threading a
   pool cache into this path. (Per rule §17, thread one of the **pool's** caches, not a new object.)

2. **Boundaries and evals are interleaved per-value, not phased.** `updateObsValues` is a single loop
   ([updater.ts:745](../src/shared/updater.ts#L745)); for each on-beat value `onArrivalOnBeat`
   ([updater.ts:507](../src/shared/updater.ts#L507)) calls `computeNextBoundary` **then** `evalFn`
   back-to-back — `[boundary(v1), eval(v1)], [boundary(v2), eval(v2)], …`, **not** Steve's
   `[all boundaries], [all evals]`. This matters because the two operations want **different
   dateIntervals**: the boundary search is keyed at **now** (it computes "next moonrise after now"),
   while the eval is keyed at the **future boundary di**. A single `finalCache` holds one di; interleaved
   per-value it would thrash now↔boundary twice per value. (Note the boundary *result* and the eval di
   coincide — the eval happens *at* the next moonrise — but the boundary must be *found* from "now"
   before that di is known, so the keys genuinely differ during the search.)

**So: Steve's "single finalCache" model is correct in spirit, but the cleanest realization is _two_
pool caches (no restructure), not one cache + a phase split.** A phase split (all boundaries, then all
evals) would *also* work with a single re-keyed cache, but it restructures the tuned on-beat state
machine (the `ARRIVED → SITTING → SWEEPING` chain, `pendingTarget`) that §4b deliberately only
*reordered*, never *restructured*. The two-cache approach gets the same sharing with no restructure —
see the DECIDED block below.

**DECIDED (Steve, 2026-06-29): two coexisting pool caches, NO restructure.** Keep the interleaved
per-value structure; just give the boundary work its own pool cache, separate from the eval cache.
Because they are different caches holding different di's, interleaving no longer thrashes. Steve
confirmed this is preferable to restructuring the tuned state machine. Role assignment (chosen to
minimize risk):

- **Eval pass stays on `finalCache`** (unchanged from Stage 2b — already bit-identical). Keyed at the
  eval-ahead display time; the Stage-2a sort makes same-eval-time values contiguous, so it invalidates
  **once per distinct eval-time group** (`currentFlag` bump). This is the "re-keyed per eval-time" cache.
- **Boundary result-memo goes on `pool.tempCache`** (the *new* work). Keyed at the arrival time
  ("now"), which is constant across the tick → **valid the whole tick, never re-keyed**, so every value
  sharing a `(sentinel, location)` hits the resolved event time instead of re-searching. This is the
  "valid all tick" cache.

  *(Steve described the roles with the names swapped — finalCache for boundary, tempCache for eval. The
  behavior is identical either way; we assign the new "valid-all-tick" memo to tempCache so the tested
  eval machinery never moves off finalCache.)*

**What the boundary cache actually holds — a result memo, not a position cache.** The boundary work is
a root-find (`nextPlanetRiseSet`) that probes altitude at many candidate times across the lookahead. So:
- The **resolved event time** ("next moonrise = T for this sentinel+location") is the value that's
  constant all tick and shared across values → it lives in `tempCache` slots (the all-tick cache).
- The **within-search probing** uses the existing `refinementCache`, re-keyed rapidly *inside* one
  search (as today) — *not* the all-tick cache.

So three pool caches with correct, distinct validity: `finalCache` (evals, per-group), `tempCache`
(boundary results, all-tick), `refinementCache` (search internals). Only the `tempCache` result-memo
is new.

**Implementation note: `nextPlanetRiseSet` takes no pool argument today** — the real work of this lever
is threading the pool into `computeNextBoundary → resolveSentinel → nextPlanetRiseSet` so it can (a)
read/write the resolved-event-time slot in `tempCache` and (b) use `refinementCache` for its probing.
Add dedicated slots for the resolved sentinel events (one per `(sentinel, location)` we actually use).

**Watch dev-rule §5** ("Boundary scheduling must use the unquantized time source"): threading a cache
must not change which `getNow` the boundary uses.

---

## 4. Lever C — Gaia's per-city day/night rings (slot-key by location)

**Finding.** Gaia 5.52ms, dominated by `dayNightLeafAngleForSlot` 4.32ms (92 calls @ 47µs). Steve's
arithmetic is right: 4 rings → ~1ms *per ring*, which is far too much for one day/night ring — they
are **not being cached.** Code confirms why
([watch-env.ts:847](../src/watch/watch-env.ts#L847)): `dayNightLeafAngleForSlot` calls
`computeDayNightLeafAngle` with the *slot's* lat/lon, which calls `getMasterRiseSet` — but
`getMasterRiseSet` only uses its slots when `observerLat === pool.observerLatitude &&
observerLon === pool.observerLongitude` ([astro-env.ts:2152](../src/shared/astro-env.ts#L2152)).
For a non-observer city it **bypasses the memo and computes fresh on every leaf** → 92 leaves ×
full search = 111 searches/tick (`master 1.50ms / leaf 1.56ms`). The slot is keyed by `planetNumber`
alone; 4 Sun rings at 4 cities would all collide onto `planetNumber=0`, which is exactly why the
guard refuses to cache them.

**This is still the pool's slot mechanism (rule §17), just keyed by `(location, di)`.** The leaves
*within one ring* (one slotNumber → one location) all want the identical rise/set; only across the 4
cities does it differ.

**Approach — DECIDED direction (Steve, 2026-06-29): a per-location temp cache, selected by
`cache="private"`.** Because the critical wedges of one ring are created together and **grouped by
their timezone/location** (the Stage-2a sort already groups by `envSlot`), we can run each ring under
its **own pool temp cache** that invalidates when we first arrive at that location and then **persists
for every other part on that subdial.** This is exactly the use case the prior doc reserved the
`cache="private"` XML attribute for — and Gaia's per-city rings are likely **the place we actually
implement it.** Mechanism (engine reads it generically, no per-face knowledge):
- A part marked `cache="private"` routes its astronomy onto a **pool temp cache** (re-keyed to that
  part's `(envSlot location, di)`) instead of the shared observer `finalCache`.
- Within a ring/subdial group, all leaves at the same city share that temp cache (one search per
  city). Moving to the next city re-keys it (O(1) flag bump). The observer `finalCache` is never
  polluted by the off-observer searches.
- Confirm the Stage-2a sort keeps a city's parts contiguous (so the temp cache isn't thrashed by an
  interleaved other-location part). `envSlot` is already in the sort key per the prior doc.

This needs no new mechanism — it's `pool.tempCache` (or a small fixed set for nesting) plus the
`cache="private"` routing the prior doc already specified. Per-`slotNumber` dedicated slots remain a
fallback if the temp-cache routing proves awkward.

**Re-measure with real city slots first (§0).** With slots unset the probe may be under- or
over-counting Gaia. The *shape* (per-leaf re-search, no caching) is certain from the code; the
absolute ms needs the §0 fix.

---

## 5. Lever D — Terra's timezone functions (NOT astronomy — `Intl` churn)

**Finding.** Terra 4.75ms, from `moreDay` 1.93 + `lessDay` 1.50 + `tzOffsetAngleN` 0.90 (24 calls
each, 37–80µs). Steve's instinct is right: **there are no astronomy calls here at all.** All three
route through `getTzOffsetSeconds` ([watch-env.ts:608](../src/watch/watch-env.ts#L608)), which
constructs a **brand-new `Intl.DateTimeFormat` on every call** and runs `formatToParts`.
`Intl.DateTimeFormat` construction is notoriously expensive (~tens of µs of allocation + ICU setup);
`moreDay` calls it several times (slot + top, possibly Jan/Jul probes) → ~80µs. ~72 calls/tick ⇒
~4ms of pure formatter churn.

**Fix — SCOPED (Steve, 2026-06-29): cache the formatter only; do NOT cache the offset (yet).** The
slot astronomy cache does **not** apply (this isn't `(location, di)` astronomy — rule §17's "legitimate
limit"). The asserted bottleneck is `Intl.DateTimeFormat` *construction*, so:
- **Cache the `Intl.DateTimeFormat` per `olsonId`** (a `Map` of reusable formatters, keyed by zone;
  only the input `date` varies per call). This is the whole fix for now. `getLocalTimeInZone`
  ([watch-env.ts:633](../src/watch/watch-env.ts#L633)) has the same per-call construction and should
  share the cached formatters. A formatter `Map` keyed by `olsonId` is a legitimate non-astronomy
  cache (rule §17 governs the *astro* pool; tz formatters aren't astronomy).
- **Do NOT memoize the offset value.** Steve's caution: **DST is not cleanly "per-day"** — the offset
  changes at DST transition *instants*, and a naive `(olsonId, localDay)` memo would be wrong across a
  transition and at timezone changes. Memoizing the offset correctly requires gating on the **next DST
  change** (which the part arguably should already track — Steve suspects that logic exists but isn't
  in the right place). That's out of scope here. **Start with the formatter cache only.**
- **If the formatter cache is insufficient** (i.e. `formatToParts` itself, not construction, is still
  the cost), **stop and discuss with Steve before caching the offset** — don't add an offset memo
  unilaterally.

**Est. impact (formatter cache alone): Terra 4.75ms → well under 1ms** *if* construction is the
bottleneck as asserted. This is independent of all the astronomy work; verify the win with the probe
before deciding whether the offset question even needs revisiting.

---

## 6. Deferred (unchanged from prior doc)

- **DEL-ring 29 distinct `moonAge` computes** (~0.66ms on Selene). Irreducible under any
  display-time cache (offset times). Needs a *cheaper lunar series* (lower-order or local
  quadratic), not memoization. Revisit only if it becomes the dominant face cost — it isn't
  (Selene's boundary + phase + rise/set together exceed it, and Selene isn't even top-3).
- **The `cache="private"` attribute** — designed-but-unused; only needed if a future part does
  offset-time astronomy through a non-slot-backed function. No action.

---

## 7. Order of work — status (updated 2026-06-29)

0. **Probe enhancement (§0): load real default Terra/Gaia city slots.** ✅ DONE.
1. **Lever D (Terra `Intl` formatter cache).** ✅ DONE — Terra 4.79→0.40, Gaia 5.52→1.06ms.
2. **Lever A (Basel LST → iOS-unified `timeBaseKind`).** ✅ DONE — Basel 4.50→0.36ms; also fixed a
   latent polar transit bug + retired the LT/LST divergence.
3. **Lever B (boundary scheduling).** ⏸️ ATTEMPTED → DEFERRED. The shared-pool + result-memo (iOS
   form) is blocked by the eval-ahead divergence (see the implementation log). Revisit via a
   multi-display-time pool or the two-phase restructure. ~0.6ms (7%) left on the table.
4. **Lever C (Gaia per-city slots).** ⏸️ DE-PRIORITIZED — Lever D dropped Gaia to ~1.06ms; the
   per-leaf uncached search is the residual. Revisit only if Gaia re-enters the top tier.
5. **cheaper-moonAge** (Selene DEL ring ~0.66ms) — still deferred.

**▶ NEXT (Steve, 2026-06-29): switch to render/GPU performance.** CPU tick is down to ~8.3 ms
all-faces (from ~21); the original frame split had render ~12 ms + GPU 6.85 ms, so render is now the
dominant lever. The remaining tick levers (B, C, cheaper-moonAge) are small (~0.3–0.6 ms each) and
should wait until render is addressed — though they're worth returning to, especially if a fix like
B's generalizes into many small wins.

**Bit-identical is the gate for every lever** (it's what proved eval-order independence before, and
it's how we know a memo didn't change a result; world-clock faces D/C should add a targeted test with
real city slots since the suite may not exercise them). Re-run `step0-tick-profile.ts` after each
lever and record deltas in the implementation log below.

**Guiding principle for all of these (new dev-rule §17):** use the slot cache that already exists —
three of the four levers are "wire up caching iOS already had," not "invent a mechanism." Lever D is
the lone exception (non-astronomy `Intl` caching).

## Implementation log

- **§0 — probe loads real city slots (DONE 2026-06-29).** `step0-tick-profile.ts` now passes the
  observer tz (`America/Los_Angeles` for the 37.33/-122 location) and, for Gaia, explicit slot
  overrides (slot 1 = observer, slots 2–4 = `GAIA_SUBDIAL_DEFAULTS` = New York/London/Sydney). Terra's
  24-city ring defaults already auto-applied inside `createWatchEnvironment`, so Terra needed no
  override. **Result — the probe was already faithful; seeding barely moved the world-clock faces:**
  Gaia 5.52→5.52ms (observer slot-1 ring now cached → `master` searches 111→87/tick, but total tick
  flat — the cost is slots 2–4), Terra 4.75→4.79ms (flat). **Full re-sweep sum ≈ 21.1ms, unchanged.**
  - **Budget conclusion (important):** the ~21ms Node all-faces sum is **robust and NOT a slot
    artifact**. So the gap vs the prior doc's browser ~10.8ms is *not* explained by §0. With the face
    set unchanged and all faces on-screen (Steve), the remaining candidates are browser-side and out
    of scope for the Node probe: rAF/visibility throttling, the browser not running every face's full
    tick each frame, or the 10.8ms figure being stale. **Node verdict stands: all-faces scrub tick
    ≈21ms (~127% of the 16.67ms budget), dominated by Gaia 5.5 / Terra 4.8 / Basel 4.1.** The levers
    target exactly those three. A browser-side cross-check is deferred (Steve: stay on Node profiling).
  - Fresh per-face warm ticks (seeded): gaia 5.52, terra 4.79, basel 4.14, selene 1.84, kyoto 1.43,
    geneva 0.91, hana 0.81, venezia 0.66, miami 0.44, vienna 0.28, mauna-kea 0.16, chandra 0.05,
    haleakala 0.05, firenze 0.03, babylon 0.01, milano 0.003.

- **Lever D — Intl formatter cache (DONE 2026-06-29). Far bigger than predicted; subsumed most of
  Lever C.** Added module-level `Intl.DateTimeFormat` caches keyed by Olson id
  ([watch-env.ts](../src/watch/watch-env.ts), `tzOffsetFormatter` / `localTimeFormatter`), used by
  `getTzOffsetSeconds` and `getLocalTimeInZone`. **No offset-value memo** (DST caution, per Steve).
  - **Terra 4.79 → 0.40 ms (−92%).** `moreDay`/`lessDay` 75/60µs → 5µs per call.
  - **Gaia 5.52 → 1.06 ms (−81%) — the surprise.** `dayNightLeafAngleForSlot` called
    `getTzOffsetSeconds(slot.olsonId, …)` **per leaf** ([watch-env.ts:859](../src/watch/watch-env.ts)),
    so ~3.5ms of Gaia's "per-city day/night" cost was **`Intl` construction, not the rise/set search**.
    The uncached-rise/set search (Lever C's premise) is only the residual ~0.97ms.
  - **All-faces Node sum 21.1 → 12.9 ms** from this one change — **now under the 16.67ms budget.**
  - **Verified bit-identical: full suite 8506 tests pass** (Terra/Gaia included). The formatter cache
    is a pure construction-vs-reuse swap; same `(olsonId, date)` → same parts.
  - **Consequence: Lever C (Gaia per-city rise/set) is de-prioritized** — Gaia is now 1.06ms, not a
    heavy face. The per-leaf uncached search remains real but small; revisit only if Gaia re-enters
    the top tier. (Lever A's Basel fix is the same *class* of bug and stays the priority.)

- **Lever A — LST↔LT unification + a polar bug fix it surfaced (DONE 2026-06-29).** Scoping the merge
  uncovered a **latent correctness bug in the LT path**, fixed first (per Steve), then the merge:
  - **The polar always-above transit bug.** `computeDayNightLeafAngle` (LT) guarded its "+π high-transit"
    adjustment with `isNaN(riseTime) && isAlwaysAbove(riseTime)`. The TS no-rise/set sentinel is the
    **finite ±1e18** (not NaN, unlike iOS's `nan("2")`), so `isNaN(riseTime)` was always false → the
    +π **never fired**: at polar summer the Sun rise/set indicators fell back to the **low** transit
    (≈ midnight) instead of the **high** transit (≈ noon). The LST path used the correct
    `isAlwaysAbove(riseTime)`; **iOS is correct** (guards on `isnan(riseTimeAngle)`, the angle, which
    inherits the NaN). A port regression from the NaN→±1e18 sentinel migration. Fix: drop the dead
    `isNaN(riseTime) &&` ([astro-env.ts:2277/2280](../src/shared/astro-env.ts)).
  - **Verification:** new unit test [daynight-polar-transit.test.ts](../src/__tests__/daynight-polar-transit.test.ts)
    (oracle = `planettransit24HourIndicatorAngle`, the true high transit via an independent path, same
    LT conversion → confound-free) — RED before the fix (off by exactly π), GREEN after. Standalone
    repro: [verify-polar-transit.ts](verify-polar-transit.ts).
  - **Golden blast radius:** exactly **57 tests, all Mauna Kea @ `arctic` @ polar-summer**, only parts
    `dawn`/`dusk` (the sole obsValues referencing `sunrise/sunset24HourIndicatorAngle`), `angle`/
    `angleTarget`, diff **= π** uniformly. Wedge-ring faces (Miami's 7, Gaia, Basel) unaffected: their
    leaves merely cyclically permute by π and, being uniform-color at always-above, capture identically.
    Mauna Kea hides dawn/dusk at the poles (`sunriseIndicatorValid=0`), which is why this was never
    visible. Mauna Kea goldens **regenerated with Steve's explicit approval** (dev-rule §12); 546/546 green.
  - **The merge (the actual Lever A).** With both paths now using `isAlwaysAbove`, the LT and LST leaf
    distributions are identical modulo the time→angle conversion, so they unified safely:
    `computeDayNightLeafAngle` gained a `timeBaseKind: 'LT'|'LST'` param (default `'LT'`) selecting a
    `toAngle` closure (`angle24HourForDate(t,tz)` vs `angle24HourLSTForDate(t,lon)`); the three LST env
    functions (`dayNightLeafAngleLST`, `planet{rise,set}24HourIndicatorAngleLST`) now call it with
    `'LST'`; **`computeDayNightLeafAngleLST` deleted**. The LST path now routes through `getMasterRiseSet`
    (shared, slot-cached) instead of re-running two root-finds per leaf — and gains the previously-missing
    MidnightSun / polar-indicator / transit branches (unexercised today, so no output change).
  - **Verified bit-identical: full suite 8509 tests pass** (8506 + 3 polar), typecheck clean, Basel/all
    faces included. **Measured: Basel 4.50 → 0.36 ms (−92%)** — `dayNightLeafAngleLST` 112µs → 7µs/call
    (33 leaves share one cached search). Miami (LT) flat. **All-faces sum 12.9 → 8.67 ms.**

### Running scoreboard (warm tick, Node)

| | start | +Lever D | +Lever A |
|---|---:|---:|---:|
| Basel | 4.14 | 4.50 | **0.36** |
| Terra | 4.79 | 0.40 | 0.41 |
| Gaia | 5.52 | 1.06 | 1.08 |
| **all-faces sum** | **21.1** | **12.9** | **8.67** |

Remaining heaviest faces: Selene 1.82, Kyoto 1.49, Gaia 1.08.

### Full re-profile after Levers D + A (2026-06-29, 4 runs/face to smooth noise)

Min / median / mean ms per warm tick (1 day/tick, 2000-tick warm), Lever B **not** applied:

| face | min | median | mean |
|---|---:|---:|---:|
| selene | 1.785 | 1.796 | 1.869 |
| kyoto | 1.448 | 1.450 | 1.450 |
| gaia | 1.052 | 1.053 | 1.055 |
| geneva | 0.819 | 0.850 | 0.855 |
| hana | 0.808 | 0.814 | 0.813 |
| venezia | 0.631 | 0.640 | 0.645 |
| miami | 0.444 | 0.458 | 0.460 |
| terra | 0.385 | 0.386 | 0.390 |
| basel | 0.366 | 0.372 | 0.379 |
| vienna | 0.291 | 0.293 | 0.293 |
| mauna-kea | 0.164 | 0.164 | 0.166 |
| chandra | 0.053 | 0.054 | 0.054 |
| haleakala | 0.052 | 0.052 | 0.053 |
| firenze | 0.031 | 0.031 | 0.032 |
| babylon | 0.012 | 0.012 | 0.012 |
| milano | 0.003 | 0.003 | 0.003 |
| **all-faces sum** | **8.34** | **8.43** | — |

Variance is low (mostly < a few %); Selene is the noisiest (DEL ring + boundary searches). The all-faces
warm tick is **~8.3–8.4 ms**, down from ~21 ms at the doc's open. **CPU tick is no longer the dominant
concern — attention should shift to render/GPU before chasing further tick levers** (Steve, 2026-06-29).

- **Lever B — boundary-scheduling memo (ATTEMPTED, REVERTED, DEFERRED 2026-06-29).** Goal: stop
  `nextPlanetRiseSet` re-running the rise/set root-finder for every sentinel-scheduled value each tick.
  - **What iOS does (and the dormant TS slots).** iOS `nextPrevPlanetRiseSetForPlanet`
    ([ECAstronomy.m](../.chronometer-ref/Classes/ECAstronomy.m)) runs the search on the **shared
    `astroCachePool`** and **memoizes the result** in dedicated slots (`nextPlanetrise`/`prevPlanetrise`/
    `nextPlanetset`/`prevPlanetset`, planet-indexed) keyed on `currentCache`. **Those slots already exist,
    dormant, in the TS `CacheSlot` enum** — another port artifact, like the LST slots in Lever A — and the
    shared-pool search (`nextPrevRiseSetInternal`) already exists in `astro-env.ts`. So the TS port's
    `new AstroCachePool()` per call in `animation.ts`'s `nextPlanetRiseSet` is **not** how iOS works.
  - **What was tried:** wired the dormant slots as a result memo in the otherwise-unused `pool.tempCache`
    (keyed at display-now via the unquantized boundary clock, dev-rule §5), routed the search onto the
    shared pool, injected via a new `Environment.nextSentinelRiseSet` that `resolveSentinel` calls.
  - **Why it failed (the eval-ahead divergence from iOS):** **118 regression failures, almost all
    backward-scrub**, off by ~a sidereal period. iOS evaluates expressions at **now**, so its shared pool
    is coherent. The TS port evaluates **ahead**, holding `finalCache@boundary` while the sentinel search
    runs at **now**; sharing the pool's other caches — notably `midnightCache`, pushed at *default* slop —
    cross-talks between the now-time search and the boundary-time eval. **The `new AstroCachePool()` per
    call was (probably unknowingly) isolating exactly this**, not just wasting memory. Reverted to the
    green Lever A/D state (8509 tests).
  - **Status: DEFERRED.** Win was ~0.3 ms each on Selene/Venezia (~0.6 ms ≈ 7% of the 8.3 ms all-faces
    sum) — not ignorable, but **render/GPU comes first** (Steve), and the clean fix needs an architectural
    change disproportionate to bolt on here.
  - **When we revisit (Steve, 2026-06-29) — two correctives to the §3 design:**
    1. **Expand the pool to handle multiple live display times, rather than a second cache.** The pool is
       effectively a startup singleton (never created/destroyed per call), so it *can* be given the
       semantics to hold more than one `(di)` at once — at most **doubling** the number of cache instances
       (one set per live display time: now vs boundary). This is the principled fix for "many kinds of
       cache pushes happen at distinct times," and keeps it one mechanism. Needs design + investigation
       of which caches must be duplicated (finalCache, midnightCache, …) and how callers pick the right
       one. *(This supersedes the §3 "two coexisting pool caches" framing, which treated tempCache as an
       ad-hoc second cache rather than a first-class per-time slot of the pool.)*
    2. **Revisit the two-phase restructure** (resolve all boundaries at now, then eval at boundary — §3).
       We did **not** deliberately reject it; we found the "two pool caches, no restructure" approach we
       *thought* was better, and it turned out not to work. With that option gone, the two-phase split is
       back on the table and should be re-evaluated on its own merits — it makes the pool coherent (one
       live time per phase) and would let the iOS-faithful shared-pool memo work unmodified.
