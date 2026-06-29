# Per-Tick Astronomy Memoization: Research, Part E, and a Cache-Pool Design

**Date:** 2026-06-28
**Status:** Part E (per-tick result memo) implemented & shipped (bit-identical, 8505 tests).
This doc collects the full investigation behind it and designs the next step — a
display-time-keyed cache pool — including a correction to the eval-timing model that
changes how that pool must be sized.

**Related:** [2026-06-28-scrub-perf-cross-face-and-wedge-blit.md](2026-06-28-scrub-perf-cross-face-and-wedge-blit.md)
(render/wedge-blit; rejects cross-face cache sharing), [2026-06-28-daynight-wedge-memo.md](2026-06-28-daynight-wedge-memo.md)
(the original rise/set search memo via `getMasterRiseSet`).
**Probes:** `planning/step0-tick-profile.ts` (Node updater.tick profiler, real timers,
per-function attribution), `planning/step0-eval-cost.ts` (per-call microbench).

---

## TL;DR

- The scrub tick is **not** the evaluator and **not** the day/night ring. It is
  **un-memoized full-WB-series moon/planet astronomy** (~13–19µs/call) invoked many times
  per tick on moon/planet-heavy faces, each passing `null` cache.
- Measured warm tick: Miami **0.44ms** (day/night rings are memoized), Selene **3.25ms**
  (58 DEL-wedge `moonAge` calls + rise/set/phase searches, none memoized).
- **Part E** (shipped): a per-tick result memo (`tickMemo`) for the "once per day"
  searches → Selene **3.25 → 2.0ms**, all.html tick **~12.7 → 10.8ms**, bit-identical.
- The subtlety that shapes the design: **on-beat values (the wedge/hand bulk) evaluate at
  their own per-`updateInterval` boundary**, so several distinct display times are in flight
  per tick (not two). A fixed cache pool would thus need careful sizing/LRU (§4).
- **Recommended design (§4b, Steve): batch the tick's evals by display time** — sort the due
  values by their eval boundary and process in order, so only one display time is active at a
  time and a **single re-keyable slot cache** suffices: no pool sizing, can't thrash, shares
  the underlying moon/planet *position* across functions, and unifies on the slot cache. The
  only change is reordering the iteration + a cheap pre-pass; per-value animation untouched.
- The DEL ring's **29 distinct delta-days** (moonAge at midnight±14) are irreducible under
  any per-display-time cache (they're offset times, not the eval time) — but the *duplicate*
  calls and isolation are best handled by **29 dedicated cache slots** (§5, Steve 2026-06-29),
  which retires `tickMemo` for the ring and needs no `cache="private"`. Reducing the 29 computes
  (cheaper moonAge algorithm) stays deferred. Not urgent.

---

## 1. How we got here (the netting-out)

Starting point: scrub on all.html shows ~50% CPU; user's M3 frame split was tick **18.32ms**
+ render ~12ms, GPU cheap (6.85ms) → **CPU/tick-bound**.

A sequence of wrong turns, each corrected by measurement:

1. **"It's the rise/set search, shared per-face."** No — the day/night master search is
   already memoized (`getMasterRiseSet`): **0.25ms/frame, 99% hit**. Cross-face sharing
   (Part B) rejected.
2. **"It's the expression evaluator (14.6µs/eval)."** No — that figure is a **browser
   `performance.now()` artifact**: the profiler calls `now()` twice per eval and Chrome's
   clamped `now()` costs ~7µs/call. Node microbench (real timers): evaluator `1+2` =
   **0.01µs**, a wedge eval = **0.26µs**.
3. **"It's GC / JIT."** No — Node tick profiler: GC **0ms**, cold/warm only **1.1×** on
   Selene (it's real work, not warm-up). (Miami is 1.6× — some JIT, but Miami is cheap.)
4. **It's un-memoized position astronomy.** Confirmed by per-function attribution.

### Per-call cost (Node, moving clock, correct call syntax)

> A probe bug initially measured bare names (`moonAltitude`) which compile to `+fn`=NaN
> *without calling* — that's why they first looked like 0.1µs. With `()`:

| function | µs/call | what |
|---|---|---|
| evaluator only (`1 + 2`) | **0.01** | the "expensive eval" is a myth |
| `moonDeltaEclipticLongitudeAtDeltaDay(n)` | **13** | `moonAge` (full lunar series) at midnight±n |
| `moonriseForDayValid()` / `…Hour12ValueAngle()` | **68** | rise/set root-finder (fwd+back) |
| `closestFullMoonDayNumber()` | **75** | phase search |
| `ELongitudeOfPlanet` / `distanceFromEarthOfPlanet` | **19** | planet/moon ecliptic series |
| `moonAltitude` / `moonAgeAngle` | **14–19** | full lunar series, `null` cache |
| `moonElongation()` | **33** | sun+moon position |

### Warm tick by face (Node updater.tick, 1 day/tick)

| face | obsValues | tick (pre-E) | dominated by |
|---|---|---|---|
| Miami | 179 | **0.44ms** | day/night rings — already memoized; ~6 searches/tick |
| Selene | 89 | **3.25ms** | 58× moonDelta (0.85ms) + 8 closest (0.4ms) + rise/set (0.3ms) |
| Venezia | 47 | 0.60ms | planet positions |
| Firenze | 24 | 0.03ms | light |

**Takeaway:** the tick scales with *un-memoized full-series astronomy calls*, concentrated
in a few moon/planet faces; the evaluator and the day/night ring are not the cost.

---

## 2. Part E — per-tick result memo (shipped)

`astro-env.ts` `tickMemo(key, compute)` memoizes the expensive "once per day" results for
the current display time: `riseSetForDay`, `transitForDay`, `closestPhaseDayNumber`,
`moonDeltaEclipticLongitudeAtDeltaDay`. Keyed by `(key, round(di / 0.5s))` in a small
per-env `Map` (cap 256, clear on overflow). Bit-identical; **Selene 3.25 → 2.0ms,
all.html tick ~12.7 → 10.8ms.**

It is deliberately **not** the slot cache. The first attempt pushed `finalCache` at each
call's `di` (like `getMasterRiseSet`); it thrashed (memoized ~nothing). Reasons, now
understood precisely (see §3): multiple display times are live per tick, and a single
`dateInterval` cache can hold only one.

**Why `tickMemo` only partially helps Selene:** the DEL ring genuinely references **29
distinct delta-days (−14…+14)**. The memo collapses the *duplicate* calls (58 → 29) but the
29 distinct `moonAge` computes remain (~0.4ms). That floor is real, not a memo failure.

> **Directive tension (Steve):** "exactly one caching mechanism." `tickMemo` is a *second*
> mechanism. It earns its place only if the slot-cache design in §4 can't be made to work;
> §3 shows the slot cache *can* work but must be a small **pool** keyed by display time.

---

## 3. The eval-timing model (corrected — this is the crux)

Earlier claim (wrong): "during scrub there are two display times per tick — discrete at
*now*, eval-ahead at *next tick*." A read of the dispatch corrects this:

`updateObsValues` ([updater.ts](../src/shared/updater.ts) ~L745) routes each value:

- **discrete** (`updateObsValueDiscrete`) → eval at **now**.
- **eval-ahead, scrub** (`updateObsValueEvalAhead`, L197-201) → eval at **next tick**
  (`now + displayDelta`), uniform.
- **on-beat** (`onBeatStep` → `onArrivalOnBeat`, L507/L531) — **the bulk: wedges and hands**
  — eval at the value's **own next update boundary** `computeNextBoundary(updateInterval…)`,
  and (L514-516) "re-evaluated only when accelerated display time reaches its boundary —
  NOT every tick."

So the on-beat eval time **varies per `updateInterval`**. Faces use ~6–8 distinct numeric
intervals (`1`, `60`, `900`, `3600`, `86400`, `days()`, …) plus event sentinels. On a tick
where values of several intervals arrive, there are **several distinct display times in
flight**, each wanting its own consistent astronomy snapshot.

**Crucial silver lining:** values sharing an `updateInterval` compute the **same** boundary
(`computeNextBoundary` depends only on interval + current time, not per-value phase), so a
ring's N wedges (all one `update=`) evaluate at one display time → they would share one
cache. That is exactly the "many wedge parts with the same update spec share a cache" win.

**Implication for the pool:** a fixed 2–3 cache pool is **too small** — it would thrash when
several intervals fire together. The pool must be **keyed by display time** and sized to the
number of distinct intervals *doing expensive astronomy* simultaneously (likely small — the
expensive calls cluster on a couple of intervals, e.g. DEL wedges `update=3600`, rise/set
`update=60` — but this must be **measured**, not assumed).

---

## 4. Proposed design — a display-time-keyed slot-cache pool

This is Steve's idea (push a fresh cache per eval-ahead point; keep a small pool so
same-time parts share), refined for §3. It unifies on the slot cache (one mechanism) and
additionally shares the underlying **position** (moonRA/sunRA/planet slots) across *different*
functions at the same time — which the per-function `tickMemo` cannot.

### Sketch

- Extend `AstroCachePool` with a small **LRU pool** of `AstroCache` objects, each tagged
  with the display `di` it currently holds.
- `cacheForDisplayTime(di)`: return the pool cache whose `di` matches (within slop); else
  evict LRU, re-key to `di` (invalidate its slots), return it.
- Astronomy env functions call `cacheForDisplayTime(dateToDateInterval(getNow()))` and pass
  it (instead of `null`) to `moonRAAndDecl` / `planetEclipticLongitude` / `riseSetForDay` /
  etc. The slot cache memoizes natively; same-(time) callers share, including the shared
  moon position across altitude/azimuth/age/elongation/position-angle.
- `getMasterRiseSet` and the rise/set/phase result slots move onto the same pool.

### Why it does **not** thrash (given correct sizing)

Within a tick the live display times = the distinct `updateInterval` boundaries that arrived
this tick. Size the pool ≥ that (with LRU headroom). Because same-interval parts share a
boundary, the count is bounded by *distinct intervals in flight*, not part count. Across
ticks the boundaries advance; LRU re-keys the same few cache objects. No per-call push/pop
of a single shared cache, so no clobbering between interleaved times.

### Open sizing question (measure first)

Instrument the distinct `(updateInterval-boundary)` set per tick **for values that call
expensive astronomy** during a representative scrub. If that's ≤ ~4, a pool of 4–6 (LRU)
is ample. If it's larger, either grow the pool or keep `tickMemo` for the result-style
memos and use the pool only for position sharing. (The probe `step0-tick-profile.ts` already
has per-function attribution; extend it to bucket eval `di` per function.)

### Trade-off vs the shipped `tickMemo`

| | `tickMemo` (Map, shipped) | display-time slot pool (proposed) |
|---|---|---|
| holds many live times | yes (Map grows, capped) | only pool-size (LRU) |
| shares underlying *position* across fns | **no** (per-result) | **yes** (moonRA slot) |
| "one mechanism" | no (2nd mechanism) | yes (slot cache) |
| risk | low (already shipped) | needs sizing + careful invalidation |

A reasonable end state: **the pool for position + search memoization**, retiring `tickMemo`.

## 4b. Better: batch the tick's evals by display time (Steve, 2026-06-28) — RECOMMENDED

The pool's whole difficulty is "N display times live *simultaneously*." Remove the
simultaneity: **process this tick's due values grouped by their eval display time, one group
at a time.** While a group is in flight only *one* display time is active, so a **single**
cache (re-keyed when moving to the next group) suffices — no pool, no sizing question, and it
**cannot thrash** (each time is fully evaluated before the next begins). Within a group every
function shares natively (position + results); across groups the one cache invalidates and
recomputes. Total astronomy = Σ over distinct times of (distinct work at that time) — optimal.

### Cheapest realization: sort, don't restructure

The eval display time of a value is `computeNextBoundary(updateInterval, getNow, …)` — it
does **not** depend on the eval result, so it can be computed in a cheap pre-pass. Then:

1. Pre-pass over the due values: compute each one's target eval time (its boundary). For the
   handful of event-sentinel intervals this is a search, but it's the *same* search
   `onArrivalOnBeat` already does — compute once and reuse.
2. **Sort** the due values by that eval time.
3. Iterate in sorted order (the existing `onBeatStep`/`updateObsValue` per value, unchanged).
   Route the astronomy functions through the pool's *current* cache; because the iteration is
   sorted, consecutive values share a time, so a **size-1** cache (re-keyed only when the time
   changes) already captures all sharing. The pool degenerates to one object.

So Steve's grouping = "sort the due list by eval time + one re-keyable cache." It avoids both
the pool-sizing question (§4) **and** a rewrite of the tuned animation state machine — the
only loop change is reordering the iteration and a pre-pass; per-value scheduling/animation
and `perfNow` are untouched, so it stays bit-identical.

**Even cheaper — a static sort.** Same-`updateInterval` values evaluate at the *same*
boundary every tick (`computeNextBoundary` is deterministic in interval + current time), so
the per-tick pre-pass/sort can collapse to a **one-time stable sort of `updater.values` by
the boundary key at build** (`buildHandValues`). Then same-interval values are contiguous;
the single cache re-keys at each interval transition and stays valid across each run. The key
is `(updateInterval, updateOffset)` — `updateOffset` shifts the boundary, so values with the
same interval but different offsets belong to different groups. Sorting `updater.values` is
safe: the renderer iterates `watch.parts` (document order), not the ObsValue list, and the
animate pass is order-independent. This is the lowest-risk realization — no per-tick work at
all beyond the cache re-key.

**The cache key is `(location, display-time)`, not just time — and `envSlot` is the location.**
Astronomy depends on observer location, so a part bound to a non-observer location must not
share the observer's location-dependent slots. The real example is **Gaia**: its four day/night
rings carry `envSlot='1'…'4'` and compute per-city day/night at the *same* display time.
Handle it by folding location into both keys: **sort key `(envSlot, updateInterval,
updateOffset)`**, and **cache key `(location, di)`** where location is the part's `envSlot`
location or the observer. Then same-`(location, interval)` parts group and share; re-keying
the single cache to a new location invalidates only the **location-dependent** slots (alt/az,
rise/set), so **location-independent** astronomy (ecliptic positions) still shares across *all*
groups. Today Gaia schedules these rings with a numeric `update='3600'`, not a per-slot sentinel, so
right now `envSlot` matters only for the cache key, not the boundary.

**…but Gaia's `update='3600'` is itself a (minor) bug, and fixing it makes `envSlot` part of
the *boundary* too (Steve).** Conceptually those rings should update at each city's actual
sunrise/sunset — sunset changes at sunrise and vice-versa — exactly like Miami's observer
rings, via `updateAtNextSunrise`/`Sunset` sentinels. (It's only minor for the Sun because
solar rise/set barely shifts day to day, unlike the Moon.) Fixing it means a per-slot sentinel:
`computeNextBoundary`/`resolveSentinel` must resolve the event **at the slot's location**, not
the observer's (they currently read only `env.observerLat/Lon` — see §"per-value boundary
input"). That makes the boundary depend on `envSlot` — i.e. the per-value input I claimed
didn't exist would now exist. **The fix is the same `envSlot` already in the sort key:** group
by **`(envSlot, updateInterval, updateOffset)`**. `envSlot` is the same for the vast majority
of parts (observer), so it's a cheap secondary discriminator that pulls the few world-clock
parts into their own per-slot groups; within a group `(envSlot, interval)` is constant, so the
boundary is too — static sort still holds, even with per-slot sentinels. So `envSlot` belongs
in the key for *two* reasons: cache location **and** per-slot boundary. `cache="private"`
stays reserved for the DEL ring's offset times.

**Why the static sort also works for event sentinels** (`updateAtNextSunrise`,
`updateAtNextMoonsetOrMidnight`, …). One might fear that a sentinel "interval" is an event
*search*, not a fixed period, so sorting by it can't predict the eval time. But the static
sort doesn't sort by the *resolved* time — it sorts by the `updateInterval` **value** (the
sentinel constant). And `computeNextBoundary` / `resolveSentinel` ([animation.ts](../src/shared/animation.ts)
L275/L566) are **pure functions of `(updateInterval, getNow, dir, env)`** — `resolveSentinel`
reads only `env.observerLat/Lon/tzOffset`, **no per-value state**. So two values with the same
sentinel constant resolve to the *same* event boundary every tick and land in the same group;
the constant sort groups them without ever running the (expensive) event search just to sort.
The numeric and sentinel cases are therefore identical for grouping. **The one caveat to
record:** this holds *only because* boundary resolution has no per-value input. If sentinels
ever become per-value — e.g. a Terra world-clock value scheduling on *its slot's* sunrise
rather than the observer's (`computeNextBoundary` currently ignores `envSlot`) — the sort key
would have to include that slot. Today it doesn't, so `(updateInterval, updateOffset)` is a
complete key. Worth a code comment at the sort site so this assumption is visible.

### Caveats

- **Eval-order independence** (must hold, and does on inspection): a value's `evalFn` is a
  pure read of `env` functions/variables + the (overridden) display time + the cache. Env
  variables are mutated only on toggle/rebuild, never mid-tick; the cache is correctly scoped
  to the active group. No value reads another value's `currentValue` at eval time (that
  coupling is render-only, via `_obsAngle`). Verify with the regression suite (bit-identical).
- **Pre-pass cost:** `computeNextBoundary` for numeric intervals is arithmetic; reuse its
  result in `onArrivalOnBeat` so it isn't computed twice.
- **Still doesn't help the DEL ring** (§5) — its 29 computes are at midnight-offset times,
  not the group's display time.

### Why this beats the pool

| | pool (§4) | sort-by-time (§4b) |
|---|---|---|
| thrash risk | if live times > pool size | **never** (one time at a time) |
| sizing question | yes | **none** (size-1 cache) |
| caches held | several (LRU) | **one** |
| loop change | none (function routing only) | sort + pre-pass (no state-machine rewrite) |
| sharing | within size-limited pool | **maximal** (all same-time work shares) |

Both share the underlying position and unify on the slot cache. §4b is the cleaner target;
§4 (pool) is the fallback if sorting the due list per tick proves too costly (unlikely — it's
a few hundred values with cheap keys).

---

## 5. The DEL ring (29 distinct delta-days) — separate problem

`moonDeltaEclipticLongitudeAtDeltaDay(n)` computes `moonAge` at **local midnight ± n days**
(n ∈ −14…+14). These are 29 **offset** times unrelated to the eval display time, so *no*
per-display-time cache can collapse them below 29 computes/tick (~0.4ms at 1 day/tick). Two
distinct concerns: **memoization/isolation** (collapse the duplicate calls *and* don't let
those offset-time computes invalidate the tick's shared cache) and **the 29 computes
themselves**.

### Memoization via 29 dedicated slots (RECOMMENDED, Steve 2026-06-29)

The cleanest answer to the first concern — and the one that satisfies the "exactly one caching
mechanism" directive — is to **give the offset-day `moonAge` its own cache slots** rather than a
`Map` (`tickMemo`) or a scratch cache. Add 29 slots indexed `n + 14 ∈ [0,28]`, in the existing
`<type><index>` pattern (e.g. `moonAgeAtDayOffset` … `moonAgeAtDayOffset28`). The DEL function
computes `moonAge(localMidnight(displayDate) + n)` internally with a `null` cache and stores the
*result* in slot `n+14` of the **shared per-display-time cache**.

Why this is the right shape:

- **It fits the slot model exactly.** A slot holds a deterministic function of the cache's
  `(location, dateInterval)` key. `moonAge` at `localMidnight(displayDate) + n` is precisely
  that — a pure function of (display time, tz, n), just like `closestFullMoon` / `nextMoonPhase`,
  which are already display-time-derived slots. These *are* legitimate astronomy slots; framing
  them as "moonAge at integer day offset, ±14" keeps the engine free of any "DEL ring" knowledge.
- **Isolation comes for free — no `cache="private"` needed for Selene.** The internal compute
  passes `null`, so it never touches the shared cache; only the result lands in a dedicated slot
  keyed to the *display* time. There is **no push of the shared cache to an offset `dateInterval`**,
  so there is nothing to poison. Confirmed against [Selene-I.xml:98](../src/watch/assets/selene/Selene-I.xml):
  the DEL wedges call **only** `moonDeltaEclipticLongitudeAtDeltaDay` for astronomy (the
  `delOnDayStrokeColor`/`TintColor` calls are pure index→color), so 29 slots fully cover the ring.
- **It retires `tickMemo` for this case** — replacing a `Map` + per-call string-key build with an
  array index (strictly cheaper per call), and it coexists cleanly with §4b: all DEL wedges share
  one `update=3600` → one group → one display time → slots fill once, wedges share, no other
  group's re-key interferes (the group runs contiguously).

Three caveats to settle when implementing:

1. **The slots are timezone-dependent → place them in the *location-dependent* region (after
   `firstLocationDependent`).** `moonAge` at a fixed instant is location-independent, but the
   *instant* is local midnight, which depends on tz. If placed before `firstLocationDependent`,
   [`initializeCachePool`](../src/astronomy/astro-cache.ts) preserves them across an observer/tz
   change (it bumps location-independent flags forward) → stale values computed at the old tz's
   midnight. Past the boundary they invalidate on location change like everything else. This is a
   correctness requirement, not cosmetic.
2. **The ±14 range is baked into the layout** (29 = one synodic month centered on today — a
   principled magnitude, not arbitrary). Needs a bounds guard so an out-of-range `n` falls back to
   an uncached compute rather than indexing past the slab. Record the range rationale in a comment.
3. **It does not reduce the 29 computes** (~0.4ms) — same floor as `tickMemo`. That's the separate,
   deferred "cheaper moonAge" work below. No regression, no perf win from this change itself; the
   win is mechanism unification + a cheaper per-call path.

> **On passing a cache to `moonAge` (investigated 2026-06-29):** the internal `null` is correct —
> supplying a cache buys essentially nothing. Within one `moonAge` call the expensive full lunar
> series runs **exactly once** (un-dedupable). The only redundant intermediates are a second
> `julianCenturiesSince2000EpochForDateInterval` (cheap arithmetic; a cache would slot-hit it) and a
> double nutation/obliquity — but the moon path uses *un-slotted local* `nutations()`/`meanObliquity`
> ([wb-moon.ts:191](../src/astronomy/wb-moon.ts)) while only the sun path is slot-backed, and they use
> different argument scaling, so a cache can't share them anyway. So `null` internally + 29 result
> slots keeps the work at its irreducible floor with zero poisoning risk; a scratch cache would add
> risk for a sub-µs saving.

### Isolation fallback: a *private* cache, selected by XML attribute (Steve)

*Superseded for Selene by the 29-slot approach above (which needs no private cache). Retained as
the **general** mechanism for any future part that does offset-time astronomy through a function
that is **not** slot-backed.* The motivation:

The DEL ring must NOT use the tick's shared cache — but it *should* use **a** cache, so each
part's own sub-calculations are cached. Mechanism (honoring the dev rule — *no semantic
knowledge of specific parts in non-XML code; behavior is specified in the XML*):

- Add a generic part attribute, e.g. **`cache="private"`** (default `"shared"`). The engine
  reads it with no idea what a "DEL ring" is.
- When the updater evaluates a value whose part is `cache="private"`, it routes that part's
  astronomy onto a **scratch `AstroCache`** (e.g. `pool.tempCache`) instead of the shared
  per-display-time cache: push scratch → eval the part → pop back. The shared cache's slots
  are untouched, so the rest of the group keeps sharing.
- Within the part, sub-calculations still cache against the scratch cache (e.g. if one wedge's
  expression touches the same body twice, the second is a hit). For the DEL ring the function
  computes at 29 distinct offset times, so cross-wedge sharing isn't available — but the
  **isolation** is the point: this is what lets §4b route *everything else* through one shared
  cache without the DEL ring poisoning it. (It also replaces the hacky "keep `moonAge` on
  `null`" — the choice now lives in the XML, not in `astro-env.ts`.)
- The DEL ring's per-wedge offset `moonAge` still needs its cache keyed at the *offset* time,
  not the part's boundary; with a private scratch cache the function can push/re-key it at
  `requestedDI` freely without affecting anything shared.

### The 29 computes — cheaper `moonAge` (deferred)

The ring only needs Δ(ecliptic longitude) across ±14 days at ~daily resolution; a lower-order
lunar series, or a local linear/quadratic model around "today", could replace 29 full-series
evals. Revisit **only if** these become the dominant cost (we're not there — Selene is 2.0ms,
mostly other things).

---

## Implementation log

- **Stage 1 — Gaia collision fix (DONE 2026-06-28).** `getMasterRiseSet` now bypasses the
  `dayNightMaster*` memo when the passed `(observerLat, observerLon)` ≠ the pool's own
  observer — so per-slot `ForSlot` rings at other locations compute correctly. Bit-identical
  to the suite (the regression harness leaves Gaia's 4 slots unconfigured → all fall back to
  the observer, where the guard is a no-op); probe confirms equator vs arctic now diverge
  correctly. This is the `(location, di)` key's location half, applied at the one site that
  had the bug. Remaining §4b stages route the rest through a shared `(location, di)` cache.

- **Stage 2a — grouping sort (DONE 2026-06-29).** `Updater.tick` lazily, once, stable-sorts
  its values by eval **time class** — `byEvalTimeClass`: rank 0 `now` (discrete/scrub), rank 1
  `next-tick` (eval-ahead), rank 2 `boundary` (on-beat, sub-keyed by `updateInterval`). Pure
  reorder, **bit-identical (8505 tests)** — which *proves* the eval-order independence the
  cache routing relies on. Currently inert (nothing routes through a shared cache yet); it's
  the foundation for 2b. (`envSlot`/`updateOffset` will join the key when 2b needs them; today
  ~all parts are `envSlot=0`/`offset=0`.)

- **Stage 2c (DEL ring) — 29 dedicated slots (DONE 2026-06-29).** Added
  `CacheSlot.moonAgeAtDayOffset`…`+28` (29 slots, index `n+14`) in the *location-dependent*
  region of [astro-cache.ts](../src/astronomy/astro-cache.ts) (tz-dependent "local midnight").
  `moonDeltaEclipticLongitudeAtDeltaDay(n)` now memoizes its full-series moonAge in slot `n+14`
  of `pool.finalCache`, keyed by the display time — the same push/pop pattern as
  `getMasterRiseSet`. A bounds guard (`|n| > 14` or non-integer) falls back to an uncached
  compute. The internal `moonAge` keeps its `null` cache (documented: the series runs once, and
  a real cache there would clobber finalCache's display-time-keyed moon/sun slots). **Retires
  `tickMemo` for the ring** (it still serves rise/set/closest-phase); no `cache="private"`
  needed. Safe before the full 2b routing because the **Stage-2a sort keeps the DEL wedges
  (`onBeat`, `update=3600`) contiguous**, so they don't interleave with `getMasterRiseSet` on
  `finalCache`; verified **bit-identical (8505 tests)**, Selene included.
  **Measured (step0-tick-profile selene, 2000-tick warm):** Selene warm tick **2.46 → ~2.06
  ms** (−0.40 ms, ~16%; reproduces 2.04–2.10 across runs); `eval` µs/call 21.8 → 18.4. Cold
  (60-tick sample) flat within noise. The DEL function floor is unchanged (~0.69 ms/tick: 58
  calls → 29 distinct full-series `moonAge` computes) — the win is the cheaper per-call memo
  (array slot vs `Map` string-key), not fewer computes. Reducing the 29 stays deferred (§5).

- **Stage 2b — route live astronomy through the shared display-time cache (DONE 2026-06-29).**
  Added a `liveAstro((cache, di) => …)` helper in [astro-env.ts](../src/shared/astro-env.ts): it
  computes `di = dateToDateInterval(getNow())`, pushes `pool.finalCache` at `di` (re-keying it),
  runs the call with that cache, and pops — the same push/pop as `getMasterRiseSet`. Converted the
  observer-location, display-time functions that previously passed `null`: sun/moon **alt/az**,
  **moonAge/elongation/relative angles**, **planet ecliptic lon/lat/distance/alt/az/RA/decl**,
  **sun/moon RA**, **LST**, **EOT** (+ `solarTimeSec`/`subSolar*`), **vernal-equinox / J2000 /
  ascending-node** angles, **season**, the two **planet-terminator** functions, and the six
  **eclipse** functions. Within a sorted leaf group (one display time) these now share the
  underlying position slots (e.g. Basel's 6 eclipse fns → one `calculateEclipse`; Venezia's planet
  fns → one series).
  - **Left `null` deliberately:** offset/search-time calls (the DEL ring's `requestedDI`, the
    `season` reference longitude at `thisDay2001`, the rise/set/transit *for-day* searches, and
    module-level helpers taking a `calcDate`/`tryDate` parameter). The for-day searches use
    `pool.refinementCache`, not `finalCache`, so they don't poison the shared position slots; and
    `getMasterRiseSet` keys `finalCache` at the **same** display `di`, so all `finalCache` users in a
    group coexist (disjoint slots, one di) with no mutual invalidation.
  - **Verified bit-identical (8505 tests)** — Basel/Venezia/Gaia included. **Measured warm tick
    (step0-tick-profile, 2000-tick):** Venezia **0.733 → 0.655 ms (−11%)**, Basel **4.785 → 4.352 ms
    (−9%)**, Selene 2.05 → 2.01 (DEL-dominated), Miami flat (already memoized). No warm regression;
    cold flat-to-better. `liveAstro` push/pop overhead negligible.

- **Stage 2d — for-day / closest-phase onto slots; tickMemo retired; es-riseset local-day fix
  (DONE 2026-06-29).** The last `tickMemo` users (rise/set & transit "for-day", closest-phase day
  numbers) moved onto their existing dedicated slots, keyed by display time via `liveAstro`. They
  *are* display-time-derived (anchored to today's local calendar day), so they fit the slot model;
  the per-day re-eval is governed by each part's `updateInterval` (event boundary / `days()`), so
  the slot's slop granularity is irrelevant. **`tickMemo` and `ASTRO_SLOP_SEC` are removed — the
  slot cache is now the single astronomy-memoization mechanism.**
  - **es-riseset fix:** the slot-backed `sunriseForDay`/`sunsetForDay`/`suntransitForDay` were a bad
    iOS port (single search from **UT noon** → wrong day at non-UTC offsets) and were **production-
    unused** (only two test files called them; the env had its own local-day logic). Replaced with
    correct cores `riseSetForLocalDay`/`transitForLocalDay` (forward/backward local-noon search +
    caller-injected `isSameLocalDay` predicate + slot caching, planets 0..9 with a Pluto/MidnightSun
    guard like `getMasterRiseSet`). The env supplies the two civil-calendar inputs the astronomy
    layer can't know — the local-noon **seed** (kept byte-for-byte: browser-`Date` for rise/set,
    `tzOffsetSeconds` arithmetic for transit, so the iterative solver's seed is unchanged → no
    last-ULP drift) and the same-day predicate. The kept sun wrappers now derive the local day from
    `pool.tzOffsetSeconds`.
  - **Verified bit-identical (8506 tests)** — Selene/Venezia/Geneva/Haleakala/Gaia included — plus a
    new regression-lock test (evening-local western longitude: rise/set/transit resolve to today's
    **local** day, which the old UT-noon search got wrong). **Perf neutral** (Selene/Venezia/Geneva
    flat within noise; Venezia min 0.655 vs baseline 0.675) — this was correctness + unification, not
    a perf change.

### Stage 2b/2c routing subtleties to handle carefully (found while scoping)

The cache routing is mechanical but has real coordination hazards — do it deliberately, not
rushed:

1. **Shared pool state.** `getMasterRiseSet`'s Stage-1 location guard compares the call's
   `(lat,lon)` to `pool.observerLatitude/Longitude`. An `activeAstroCache(di, lat, lon)` that
   *mutates* the pool's observer location (to re-key by location) would interfere with that
   guard. Re-keying location must either not touch the guard's fields or the guard must move
   to the same mechanism.
2. **`finalCache` is shared** by `getMasterRiseSet` (dayNightMaster slots) and would be shared
   by the position functions. Within a sorted group (same di+location) they coexist (different
   slots); the sort keeps different-di groups from interleaving. Verify no cross-invalidation.
3. **`moonDelta`'s memo → 29 dedicated slots (DECIDED, see §5).** Earlier framing held this
   `(deltaDay n, di)` memo was Map-shaped and couldn't be a slot. It can: `n` is bounded
   (−14…+14), so 29 fixed slots (indexed `n+14`) hold the per-day result, keyed by the shared
   cache's display time. This **retires `tickMemo` for the DEL ring** and removes the need for
   `cache="private"` here (the internal compute passes `null`, so nothing offset-time touches the
   shared cache). Caveats: slots must live in the *location-dependent* region (tz-dependent), and
   a bounds guard handles out-of-range `n`. The 29 computes themselves are unchanged.

### Eval-time has THREE classes, not "now vs next" — affects the sort key

Re-deriving the dispatch for the cache work: a value's eval display time depends on its
**path**, not just its interval — `now` (discrete / scrub-compress), `next-tick` (eval-ahead
during scrub), or its own **boundary** (on-beat). So two same-`updateInterval` values can eval
at different times if their paths differ. Correctness is unaffected (the cache re-keys on the
*actual* `di`), but a sort key of `(envSlot, updateInterval, updateOffset)` alone leaves
residual thrash where, say, a discrete `…Hour24Number` and an on-beat `…Hour12ValueAngle`
share an interval and both call the same search. Two fixes: **(a)** fold the path determinant
into the static key — `(envSlot, isDiscrete, evalAhead, updateInterval, updateOffset)` (all
static flags); or **(b)** the **dynamic per-tick sort** by each due value's actual eval `di`,
which subsumes all path cases without enumerating them. (b) is more robust; (a) keeps the
"no per-tick work" property. **Decision needed before Stage 2.**

## 6. Recommendation / next steps

1. **Keep Part E (`tickMemo`) shipped** — a real, safe, bit-identical win that stands until
   §4b lands (and `tickMemo` can be retired then).
2. **Build §4b** — the recommended path. It sidesteps the pool-sizing question entirely and
   can't thrash. **Status: Stages 2a (sort) + 2b (live-function routing) + 2c (DEL slots) + 2d
   (for-day/closest-phase slots + es-riseset local-day fix) all DONE 2026-06-29 — see the
   implementation log. `tickMemo` is fully retired; the slot cache is the single astronomy memo.**
   Original steps:
   a. One-time **static sort** of `updater.values` by `(updateInterval, updateOffset)` at
      build (§4b "even cheaper"), with a comment recording the "no per-value boundary input"
      assumption (sentinels).
   b. Route the astronomy functions through the pool's **current** cache — a single
      `AstroCache` re-keyed when the active display time changes.
   c. **Add the 29 DEL-ring slots (§5)** in the location-dependent region, route
      `moonDeltaEclipticLongitudeAtDeltaDay(n)` onto slot `n+14` (with a bounds guard), and
      **retire `tickMemo` for the ring**. This needs no `cache="private"` for Selene; keep the
      `cache="private"` mechanism only if/when a non-slot-backed offset-time part appears.
   d. Gate on the full regression suite (bit-identical) — verifies eval-order independence.
3. Re-measure Selene + all.html tick (Node `step0-tick-profile.ts` and the browser scrub log).
4. **Defer** the cheaper-moonAge work (reducing the 29 computes) until those calls actually dominate.
5. Reassess the frame with the wedge-blit render savings.

**Run it always, not just during scrub (Steve).** Less code (no mode branch) and the cost is
negligible: the sort is one-time at build, and in 1×/idle only a handful of values are due per
frame, so the cache re-keying is trivial — and even beneficial (the few due values still share
astronomy). The shared cache invalidates correctly in every mode (slop-based, same as today).
So: no scrub-only guard. §4 (the LRU pool) remains the fallback only if the static-sort
assumption breaks.

## Resolved decisions (Steve, 2026-06-28)

- **Attribute = `cache="private"`** — "create a temporary cache just for evaluating this
  part's values." Absent ⇒ today's behavior (share the tick cache). The engine reads it
  generically; no part-specific code. **Update (2026-06-29):** the DEL ring — its original
  motivation — is now handled by 29 dedicated slots (§5) and does **not** need this. The
  attribute stays designed-but-unused, to be implemented only when a part does offset-time
  astronomy through a function that isn't slot-backed.
- **Reuse the scratch cache, don't allocate per eval.** Cheaper and avoids GC. An `AstroCache`
  is two typed arrays of `NUM_SLOTS` (~400+ slots ≈ a few KB); allocating one per private-part
  eval per frame is real churn. Reuse is ~free: invalidation is a single `currentFlag` bump
  (no array clear), exactly the version-flag design the cache already has. Keep a tiny fixed
  set (1, maybe 2–3 for nesting) of reusable scratch caches — `pool.tempCache` already exists;
  add a dedicated one if a private part can be evaluated while `tempCache` is in use by a
  search. When a private part finishes, no cleanup needed — the next push's flag bump
  invalidates its slots.
- **Static sort accepted.** See the clarification below on why it's *safe* regardless of the
  per-value-input assumption.

### "Per-value boundary input" — what it means, and why getting it wrong is harmless

The static sort assumes a value's eval time is determined by its **sort key**
`(updateInterval, updateOffset)` alone. "Per-value boundary input" = anything *else*,
specific to the value, that `computeNextBoundary` depends on. Today there is none — but a
concrete future example: a **Terra world-clock part scheduling on _its own slot's_ sunrise**
(its city) rather than the observer's. Two such parts share the sentinel
`updateAtNextSunrise` but resolve to **different** event times (different cities), so the
`(updateInterval)` key would group them while they actually eval at different times.
(`computeNextBoundary` currently ignores `envSlot`, so this can't happen yet.)

**Crucially, breaking the assumption costs performance, not correctness.** Correctness comes
from the cache **always re-keying on the actual eval `di`** — a value evaluated at time *t*
uses a cache valid for *t*, recomputing if the cache held a different time. So a mis-grouped
value just triggers an extra re-key (a `currentFlag` bump + recompute) — it never reads a
stale value. The static sort is therefore a *sharing heuristic*: a wrong key degrades sharing
(more re-keys) but can't produce wrong output. The suite stays bit-identical either way; only
the perf delta moves. That makes the static sort safe to ship and measure, with the dynamic
per-tick sort (§4b) as a pure optimization if some key ever proves incomplete.

---

## 7. Why the worker-eval-ahead pipeline didn't help (hypothesis)

The [worker-eval-ahead](../planning/2026-06-26-worker-eval-ahead-pipeline.md) branch moved the
whole update pass (astronomy + eval) onto a worker that precomputes targets N boundaries
ahead, leaving the main thread to interpolate. It didn't improve scrub. With everything we
now know, the likely reason:

**Moving work off-thread doesn't *reduce* it — and the cost was redundancy, not placement.**
During scrub at 1 day/tick every value's boundary is reached every tick, so the worker must
compute a *full tick's* astronomy per frame. At the time, that astronomy was dominated by
**un-memoized redundant recomputation** (per-wedge rise/set before `getMasterRiseSet`; the
null-cache positions/searches found here) — ~tens of ms/tick. So:

- If per-tick astronomy ≥ frame budget, the worker **can't stay ahead**; the buffer misses,
  and the design's "fail fast: wait a beat" makes the frame rate gate on the worker's
  throughput (one tick per ~18ms) — i.e. the worker becomes the *serial* bottleneck, with
  only the render (~12ms) hidden underneath. Net ≈ the same wall, plus worker/postMessage/
  generation-invalidation overhead → "no help."
- The actual lever is to **reduce** the astronomy (memoization: Part E, and §4b's shared
  cache + position sharing), which Node profiling confirms helps. Once the per-tick astronomy
  is sub-millisecond for most faces, the main thread isn't astronomy-bound, so the worker is
  unnecessary; if a heavy face still needs it, the worker would then parallelize a *small,
  budget-fitting* residual effectively.

So the ordering was backwards: parallelize-before-reduce. Reduce first (this doc); revisit the
worker only if a face remains CPU-bound after. (Confirm against the branch's own measurements
when we return to it — this is a hypothesis from the plan + our profiling, not its results.)
