# Location: stale city/timezone after lat/lon links, and "Observer" on Gaia after a move

**Status**: **IMPLEMENTATION COMPLETE** — all seven steps, all twelve defects.
Steps 1, 1b, 2 and 3 landed 2026-09-06 (committed in d1f4c4b); steps 4, 5, 6
and 7 landed 2026-09-07 (uncommitted at the time of writing).

How to read this document now: §1–§4 are the original diagnosis and stand as
written; **§5's step headings carry a status line and any place where the code
diverged from the instruction below it**; §11–§14 are the implementation
records, with the before/after evidence and the review findings. §7 and §8 list
what was actually written.

All product decisions taken (§9, Steve 2026-09-05/06): adoption clears `bloc`;
Terra showed "Los Angeles"; eclipse links adopt as nearest DB city; Terra
persists only *user* overrides of the observer slot; Observatory releases the
parsed DB when the Keep/Revert modal goes away; the ungated startup tz write
is gated. Q2 is diagnostic only and did not change the plan.
**Created**: 2026-09-05
**Baseline**: 7d60c27 (dist bundle built 2026-09-03 matches this source)
**Related**: [2026-06-13-localstorage-state-and-sharing.md](2026-06-13-localstorage-state-and-sharing.md)
(adoption / partial-link merge), [2026-06-14-observatory-cities-lazy-load.md](2026-06-14-observatory-cities-lazy-load.md)
(lazy city DB, "Observer" placeholder decision).

## 1. Symptoms (Steve, 2026-09-05)

1. Opened the app with `?lat=…&lon=…`. The coordinates were accepted and used,
   but the city name and the timezone did not update.
2. Drove to a nearby city while in follow-the-device (`bloc`) mode. The local
   city on Terra and Gaia showed "Observer" instead of the nearest city.

## 2. Findings at a glance

Method: seven independent end-to-end code traces of concrete scenarios,
deduplicated into 12 candidate defects, each of the 9 in scope refuted from
three angles (code path, timing/races, documented intent). All 27 refutation
attempts failed — every candidate is a real defect. Scratch vitests under jsdom
reproduce B1, B2, B4, B7 and B9 (see §10).

All twelve are fixed; the last column says which step did it.

| # | Defect | Where | Explains | Severity | Fixed in |
|---|--------|-------|----------|----------|----------|
| B1 | Adopting a lat/lon-only link keeps the OLD stored `city`, `tz`, `lsrc`, `bloc` beside the NEW coordinates; nothing re-derives them | [app-state.ts:386-409, 518-526](../src/shared/app-state.ts) | report 1 | high | step 5 |
| B2 | Stale `bloc:true` survives adoption, so the next reload / tab-return silently replaces the link's location with the device fix (>16 km) | [engine-entry.ts:4035](../src/engine-entry.ts), [observatory-entry.ts:776](../src/observatory/observatory-entry.ts) | report 1 (variant) | high | step 5 |
| B3 | Observatory never re-resolves a browser-fallback timezone from the city DB (Chronometer and Inspector do) | [observatory-entry.ts:154-156](../src/observatory/observatory-entry.ts) | report 1 if in Observatory | high | step 3 |
| B4 | Nearest-city backfill writes `face.terraSlotOverrides`, but the env holds **copies** (`{...v}`) and Terra's ring names are baked into a cached knockout; the on-screen label never updates in-session | [engine-entry.ts:490-503](../src/engine-entry.ts), [watch-env.ts:607-616](../src/watch/watch-env.ts), [renderer.ts:3246-3250](../src/watch/renderer.ts) | report 2 | high | step 1 |
| B5 | The in-session location-change path builds Gaia slot 1 by hand and emits the literal `'Observer'` (no `olsonIdToCityName` fallback); the startup path has the fallback | [engine-entry.ts:2348-2360](../src/engine-entry.ts) vs [:746-755](../src/engine-entry.ts) | report 2 | medium | step 1 |
| B6 | The startup tz correction rebuilds via `handleDstTransition`, which never re-derives observer slots: Terra's ring sector + main hands and Gaia's main dial stay on the browser zone all session | [engine-entry.ts:3003-3013, 1978-1980](../src/engine-entry.ts) | report 1 (in-session face view) | medium | step 2+3 |
| B7 | After "Save as my default", index/face navigation links still carry the pre-Save query, so the next page prompts again and runs session-only | [index-page.ts:45-53](../src/index-page.ts), [url-state.ts:354-395](../src/shared/url-state.ts) | report 1 (repeat prompt) | medium | step 5 |
| B8 | `refreshBlocLocation` calls `updateLocationDisplay` twice → two handlers on one DB-load promise; the second blanks the footer and re-parses the ~22 MB DB | [engine-entry.ts:4036-4040](../src/engine-entry.ts) | report 2 (side effect) | medium | step 1 |
| B11 | Bloc / browser-fix paths persist the browser-zone *guess* as the location tz with no re-resolution (latent: only wrong when OS zone ≠ fix zone) | [engine-entry.ts:446-452, 2572, 2635, 4039](../src/engine-entry.ts) | — | low | step 4 |
| B9 | Terra/Gaia city picks in "visit only" mode never trigger the session re-prompt (`setSlotOverrides` bypasses `setState`) — confirmed by critic scratch test | [app-state.ts:624-661](../src/shared/app-state.ts) | — | low | step 6 |
| B10 | Startup `updateLocationDisplay()` runs before `const faces` exists; if the DB parse wins the race the callback throws in the TDZ, `.catch(()=>{})` swallows it, city persistence and DB release are skipped | [engine-entry.ts:547, 784, 494, 542](../src/engine-entry.ts) | — | low | step 1 |
| B12 | Observatory DB-load callback returns early when a city appeared mid-parse, skipping `releaseCityData()` | [observatory-entry.ts:657-661](../src/observatory/observatory-entry.ts) | — | low | step 3 |

B9, B10, B12 were confirmed from source by the planners but not put through the
three-angle refutation pass (budget); treat them as high-confidence.

## 3. How each report happens

### 3a. Report 1 — lat/lon link, stale city and timezone

Stored `ec:shared` = `{lat, lon, city:"Cupertino", tz:"America/Los_Angeles", lsrc:"city"}`.
Open `terra.html?lat=40.7&lon=-74.0`.

1. `initAppState` sees shareable params that differ from storage → runs on
   `UrlBackend` and shows "Use these shared settings?" ([app-state.ts:481-500](../src/shared/app-state.ts)).
   `getState()` now returns `{lat:40.7, lon:-74, city:null, tz:null}`.
2. `main()` resolves `locationSource=''`, no tz → browser zone as a *transient*
   backstop, `tzNeedsResolution=true` ([engine-entry.ts:419-428](../src/engine-entry.ts)).
   The footer reverse-geocodes once the DB parses; the tz backstop corrects
   `locationTimezone` and the tz label ([:3003-3013](../src/engine-entry.ts)).
   **In-session the footer and tz label are right.** But the faces are not:
   the backstop rebuilds through `handleDstTransition`, which keeps the
   observer slots derived from the browser zone (B6), so Terra's top sector,
   Terra's main hands and Gaia's main dial keep showing Los Angeles time.
3. Both automatic writes — city ([:540](../src/engine-entry.ts)) and tz
   ([:3010](../src/engine-entry.ts)) — are gated on `isPersistentMode()`, which
   is false until Save. If the DB parse landed *before* Save (the common
   ordering), nothing is written.
4. "Save as my default" → `adoptCurrentStateAsDefault` writes only the fields
   literally present in the URL: `{lat, lon}` ([app-state.ts:386-409, 518-526](../src/shared/app-state.ts)).
   Proven by scratch test: `ec:shared` becomes
   `{lat:40.7, lon:-74, city:"Cupertino", tz:"America/Los_Angeles", lsrc:"city"}`.
   Even a *later* city backfill is refused because `!getState().city` now reads
   the stale "Cupertino" (B1).
5. Next clean reload (any app): coordinates 40.7/−74 with the label
   "Cupertino" and Pacific time. In Observatory the in-session picture is worse:
   it has no DB-backed tz backstop at all, so a lat/lon-only link runs on the
   browser zone for the whole session (B3).
6. If the stored state also had `bloc:true`, it survives adoption; the next
   reload's quiet refresh finds the device >16 km from the link and silently
   replaces the link's location (B2). If you landed on `index.html`, its face
   cards still carry `?lat&lon` after Save, so the face page prompts again (B7).

The partial-field merge was introduced deliberately (planning 2026-06-13 L38-41)
so a *slots-only* link would not clobber the stored location. It was not
designed for the lat/lon-only case. Share-button links always carry
city/tz/lsrc, so only hand-typed links (and the eclipse-table deep links, which
omit city/lsrc) hit this.

### 3b. Report 2 — "Observer" after driving

Seeded bloc state with a stored city name. Startup takes the stored name, so
the city DB is **never parsed** this session ([engine-entry.ts:508-510](../src/engine-entry.ts)).
Return to the tab after >15 min → `onWake` → `refreshBlocLocation` → fix
>16 km away → `applyLocation(…, 'browser')` with `locationSource=''`.

1. `rebuildAllForLocationFrozen` re-derives the slots with the DB unparsed:
   Terra's global slot falls back to the timezone's representative city
   ("Los Angeles"); Gaia's hand-built slot-1 block has no such fallback and
   emits the literal `'Observer'` (B5) ([:2348-2360](../src/engine-entry.ts)).
   These strings are copied into `env._terraSlots` at env creation
   ([watch-env.ts:607-616](../src/watch/watch-env.ts)).
2. `updateLocationDisplay` starts the DB parse; when it lands, the footer shows
   the nearest city and `backfillObserverSlots` writes the name into
   `face.terraSlotOverrides` — an object the env never reads (B4). No env
   rebuild, no `renderDirty`, and the Terra knockout cache is preserved by every
   later rebuild path. The face keeps "Observer" / "Los Angeles" until a reload.
3. Storage is repaired (`city` is persisted at [:540](../src/engine-entry.ts)),
   which is why a reload looks right — the on-screen-only symptom you saw.
4. Side effect: the second `updateLocationDisplay()` at [:4040](../src/engine-entry.ts)
   blanks the footer and re-parses the DB (B8).

### 3c. What the code says you did *not* see

- **Terra cannot render the literal "Observer".** The string exists only in
  the two Gaia (`worldTimeSubdials`) branches; Terra's chain ends in
  `olsonIdToCityName` → "Local". On `all.html` you most likely saw Gaia's
  "Observer" next to Terra's "Los Angeles" — both wrong, both fixed by B4/B5.
- **A move under 16 km does nothing.** Cupertino → downtown San Jose is ~11 km,
  below the stationary threshold ([engine-entry.ts:4035](../src/engine-entry.ts)),
  so the sequence above requires a fix >16 km from the stored seed.

## 4. Root-cause seams (why the fixes look the way they do)

1. **Location fields are one dependent group, treated as six scalars.**
   `lat/lon/city/tz/lsrc/bloc` are written together by every explicit-location
   path ([engine-entry.ts:2578](../src/engine-entry.ts), [observatory-entry.ts:734, 1267](../src/observatory/observatory-entry.ts),
   [index-page.ts:204](../src/index-page.ts)) except adoption.
2. **Adoption is unobservable.** Nothing tells an app that persistence just
   became available, so derivations that ran while gated off are never replayed
   ([app-state.ts:503-511, 663-668](../src/shared/app-state.ts)).
3. **Observer-slot names live in two places with a one-way copy.**
   `face.terraSlotOverrides` → copied into `env._terraSlots` → baked into
   `env._terraCityKnockout`. Label updates must reach the env explicitly.
4. **Two derivations of the observer slot.** `buildSlotOverrides` (documented
   priority chain) and the hand-rolled Gaia block in `rebuildAllForLocationFrozen`.
5. **"Provisional tz" is tracked only on the startup lat/lon branch.**
   `resolveTimezone()` with the DB unparsed returns the browser zone; only
   [engine-entry.ts:419-428](../src/engine-entry.ts) remembers that it is a guess.
   The bloc, dialog, refresh and cross-tab paths persist the guess.
6. **Two rebuild primitives, one wrong for tz changes.** `handleDstTransition`
   (clock-shift class, preserves slots and knockout) vs `rebuildAllForLocation`
   (location class, re-derives slots). A timezone correction is location-class.

## 5. Fix plan (ordered; each step independently shippable)

The order follows dependencies and keeps persisted-state changes last. The
minimal path for the two reports alone is marked ★.

Each step below is annotated with what actually landed. The instruction text is
left as written — the reasoning is still the reasoning — with a
**Changed in implementation** note wherever the code ended up somewhere else,
so nothing here reads as a live instruction that the source no longer follows.

### Step 1 ★ — Observer-slot display fixes (Chronometer only; B5, B4, B8, B10)

**Landed 2026-09-06 — §11.** As written, plus one fix from the review: the
backfill's scheduler kick is gated on `firstFramePainted` (an earlier kick ran
a frame over unbuilt faces and still fired the load-bar handoff).

1. **Single slot derivation** — [engine-entry.ts:2342-2360](../src/engine-entry.ts)
   `rebuildAllForLocationFrozen.beforeEnvRebuild`: replace the Terra-only
   re-run plus the hand-built Gaia block with one branch:
   `if (worldTimeRing || worldTimeSubdials) { const r = buildSlotOverrides(face.watch); face.terraSlotOverrides = r?.overrides; face.globalLocationSlot = r?.globalLocationSlot; }`.
   Delete the `'Observer'` block. `buildSlotOverrides` already reads the
   module-level `lat/lon/locationSource/locationTimezone` set before the hook.
   Optional: change the last-resort literal at [:755](../src/engine-entry.ts) from
   `'Observer'` to `'Local'` to match Terra and the docs (unreachable in
   practice; cosmetic).
2. **Relabel the live env** — new `export function relabelTerraSlot(env, slot, cityName): boolean`
   in [watch-env.ts](../src/watch/watch-env.ts) next to `registerTerraFunctions`:
   set `env._terraSlots[slot].cityName`, null out `env._terraCityKnockout`
   (the renderer rebuilds it lazily, same idiom as [engine-entry.ts:996](../src/engine-entry.ts)),
   return whether anything changed.
   In `backfillObserverSlots` ([:490-503](../src/engine-entry.ts)) keep the
   face-side writes (later rebuilds re-copy from them) and additionally call
   `relabelTerraSlot(face.env, slot, name)`; set `face.renderDirty = true` when
   it returns true. Both labels are drawn in the per-frame QHand pass, not the
   static cache, so `renderDirty` suffices. Not gated on `isPersistentMode()`
   (display only); the `setState({city})` at [:540](../src/engine-entry.ts) stays gated.
3. **De-duplicate the refresh path** — [engine-entry.ts:4036-4040](../src/engine-entry.ts):
   keep the reseed `setState` *after* `applyLocation` but before any await
   (step 4 below makes its `tz` value depend on a flag `applyLocation` sets),
   and delete the second `updateLocationDisplay()` with a comment that
   `rebuildAllForLocationFrozen` already calls it.
4. **In-flight guard + ordering** — in `updateLocationDisplay`'s
   DB-not-parsed branch ([:529-542](../src/engine-entry.ts)) add a closure-level
   `reverseGeocodeInFlight` flag, checked **before** the label is blanked;
   wrap the handler body in `try/finally` so `releaseCityData()` cannot be
   skipped by a throw. Move the startup `updateLocationDisplay()` call from
   [:547](../src/engine-entry.ts) to just after the face-construction loop
   ([:840](../src/engine-entry.ts)). Do **not** instead hoist `const faces`: an
   early empty-array backfill would release the DB before the faces are built.

### Step 1b — Terra: persist only *user* overrides of the observer slot (decided 2026-09-06)

**Landed 2026-09-06 — §11.** The two-map form, as recommended. The r-key parse
and serialize moved to pure functions in `watch/terra-slots.ts` so the
persistence invariant is unit-testable.

**Today.** `buildSlotOverrides` builds the display table as
`{...userOverrides}` from `ec:slots`, then unconditionally overwrites the
global slot with the injected observer ([engine-entry.ts:717-733](../src/engine-entry.ts)).
`assignCityToSlot` writes the user's pick into that same in-memory table,
persists it, then rebuilds (re-injecting the observer for display, with the
warning "your location may override this slot") ([:3482-3500](../src/engine-entry.ts)).
`writeTerraOverridesToUrl` persists **every** entry of the in-memory table
([:3454-3460](../src/engine-entry.ts)); Gaia's writer skips its observer slot
([:3758](../src/engine-entry.ts)). Two consequences:

- After any rebuild the table entry for the global slot *is* the injected
  observer, so the next slot edit — of any slot — persists the observer's
  current name/zone/coords as a "user override" of that sector. When the
  observer later moves to another zone, that sector shows the ghost, the ghost
  counts as a user override in the tie-break ([:686-703](../src/engine-entry.ts)),
  and Share links carry it (planning 2026-06-14 L153-154 says the observer slot
  is computed, never stored).
- Worse: a user's *genuine* override of the observer slot is replaced in the
  in-memory table by the injection on rebuild, so the next unrelated slot edit
  persists the observer over it — the user's choice is silently lost.

**Rule (Steve).** Record anything the user has overridden in the observer
slot; skip persistence iff the slot holds the auto-injected value. Display is
unchanged: the observer occupies the slot whose UTC offset matches the current
timezone (injection wins there), and a user override of that slot is retained
and shows again once the observer moves to a different slot.

**Design.** The merged table cannot distinguish "user override" from
"injected observer" after a rebuild, so a skip-if-default check on it is not
enough. Keep the user's overrides as their own source of truth:

1. `buildSlotOverrides` (or the extracted `deriveObserverSlots`) returns
   `userOverrides` alongside `overrides`; store it as `face.terraUserOverrides`
   next to `terraSlotOverrides` ([:279-281](../src/engine-entry.ts)).
2. `assignCityToSlot` writes the pick into `face.terraUserOverrides[slot]`
   (and, for immediate display, into `terraSlotOverrides` as today).
3. `writeTerraOverridesToUrl` serializes `face.terraUserOverrides` only.
   The observer slot is therefore persisted iff the user overrode it; the
   injected value never reaches `ec:slots`.
4. `rebuildTerraForSlotChange` / `rebuildAllForLocationFrozen` rebuild the
   display table from `terraUserOverrides` + injection, as today.
5. The reset path that clears all overrides ([:3563](../src/engine-entry.ts))
   clears both maps.

Minimal alternative if the extra map is unwanted: an `injected?: true` marker
on the `TerraSlot` written by the injection ([watch-env.ts:95-100](../src/watch/watch-env.ts))
and skipped by the writer — but that still loses the user's override of the
global slot after a rebuild unless the writer also re-reads `getSlotOverrides()`
for that slot, so the two-map form is preferred.

**Migration.** Existing `ec:slots` blobs may already contain a ghost
(`r{N}` equal to a past observer). Nothing in the blob marks it; do not try to
detect it. The user can clear it via the Terra dialog's reset; note it in the
changelog.

### Step 2 — Timezone primitives (shared)

**Landed 2026-09-06 — §12**, including the optional item 3.

1. [tz-resolve.ts](../src/shared/tz-resolve.ts): add
   `resolveTimezoneProvisional(lat, lon, cityTz): { tz, provisional }`
   (tiers 1-2 → `provisional:false`; browser/UTC fallback → `true`) and
   implement `resolveTimezone` on top of it. Document the never-persist rule
   (mirrors [index-page.ts:195-199](../src/index-page.ts)).
   > **Changed in implementation (step 4).** `resolveTimezone` was deleted once
   > step 4 had routed every caller through the provisional form: each one
   > resolves a zone in order to show *and* store it, so each one has to know
   > whether the answer is a guess. A zone-only convenience form left standing
   > is the trap that reintroduces B11 at the next persist site.
2. [engine-entry.ts](../src/engine-entry.ts): add `applyResolvedTimezone(tz)`
   next to `applyLocation`: set `locationTimezone`, `tzDeltaMs`, then
   `rebuildAllForLocation(lat, lon)` + `scheduleDstRebuild()`. Reword the
   comment at [:1978](../src/engine-entry.ts) to state that
   `handleDstTransition` is for clock shifts only and a change of
   `locationTimezone` must go through `applyResolvedTimezone`.
3. Optional, test-enablement: extract `buildSlotOverrides` into a pure
   `deriveObserverSlots(watch, ctx)` in a new `src/watch/observer-slots.ts`
   (engine-entry's `main()` cannot be booted under jsdom).

### Step 3 ★(Observatory) — One `ensureTzResolved()` per app (B3, B6, B12)

**Landed 2026-09-06 — §12.** The contract was extracted rather than
triplicated (see the note at the end of this step), and two deduplication
deviations were needed to keep startup to a single DB parse.

One contract, implemented in Chronometer ([engine-entry.ts:3003-3013](../src/engine-entry.ts)),
Inspector ([inspector-entry.ts:973-989](../src/inspector/inspector-entry.ts))
and **new** in Observatory (replace [observatory-entry.ts:154-156](../src/observatory/observatory-entry.ts)
with the Inspector startup shape and add the function; call it once in `init()`):

- Guard on `tzNeedsResolution`; stamp `forLat/forLon` and ignore the answer if
  the coordinates changed meanwhile (a newer location owns its own resolution).
  Stamp, not a global in-flight promise: a global dedupe would hand a newer
  provisional location the old coordinates' promise.
- Apply: Chronometer via `applyResolvedTimezone` (re-derives slots — fixes B6);
  Observatory via `updater?.reset(); rebuildEnv(); updateLocationDisplay(); timeUI?.updateTimezoneDisplay(); scheduleFrame()`;
  Inspector as today.
- Persist when `resolved && isPersistentMode() && !getState().tz`, **regardless
  of whether the zone changed** — otherwise the equal-zone case never persists
  and every persistent-mode load re-parses the DB.

> **Changed in implementation.** The contract lives in
> `createTzResolver(deps)` ([shared/tz-ensure.ts](../src/shared/tz-ensure.ts));
> each app instantiates it with its own hooks instead of holding a third copy.
> Two additions keep startup to one parse: a resident DB resolves synchronously,
> and the resolver declines to start a parse of its own while the location-name
> path is already parsing. The Observatory also *suspends* it during a map drag
> — the live coordinates are the drag position then — and re-runs it from
> `dismissKeepDialog`.
- Release in `finally` with the app's guard (Chronometer `!dialogOpen()`;
  Observatory `!dialogShown() && dragState === 'idle'`) — never behind an early
  return (that is B12's shape).
- B12: reorder the Observatory DB-load callback ([:657-661](../src/observatory/observatory-entry.ts))
  to `if (!getState().city) applyClosest(); if (…) releaseCityData();`
  (Inspector's shape).
- **Map-drag release (decided 2026-09-06):** at the very end of
  `dismissKeepDialog` ([:1292](../src/observatory/observatory-entry.ts)), after
  `dragState = 'idle'` and after the Keep/Revert branches' own
  `updateLocationDisplay()` calls (Keep's nearest-city persist needs the resident
  DB), add `if (!dialogShown()) releaseCityData();`. Do **not** release while
  `dragState === 'confirming'`: a map press while the Keep/Revert modal is up
  resumes the drag ([:187-191, 1054-1065](../src/observatory/observatory-entry.ts))
  and needs the parsed DB. `dismissKeepDialog` is the only transition back to
  `idle`, so this is the single release point for both Keep and Revert. The
  next drag re-parses from the resident compressed blob (CPU only, no network).

Ship this step **before** step 5: clearing a stale tz on adoption without an
Observatory backstop would move the Observatory from "stale zone" to "browser
zone".

### Step 4 — Provisional tz at every persist site (B11) + session-mode name gap

**Landed 2026-09-07 — §13.** Every listed site, plus two additions the plan did
not anticipate (`persistableTz`, and an in-memory city name for Observatory and
Inspector — see the notes below).

Route every `resolveTimezone` call that feeds a `setState({tz})` through
`resolveTimezoneProvisional`, set `tzNeedsResolution = provisional`, write
`tz: provisional ? null : tz`, and call `ensureTzResolved()` when provisional:

> **Changed in implementation.** That last ternary is named:
> `persistableTz(tz, provisional)` in tz-resolve.ts, so `grep persistableTz` is
> the inventory of location `setState({ tz })` sites and the rule has a unit
> test. The `ensureTzResolved()` call goes *after* each site's display update,
> so the location-name reverse-geocode owns the parse and the resolver defers to
> it (one parse per location change, measured). Two sites the list misses: the
> Observatory's drag `pointerup`, whose zone is what a later Keep persists, and
> the Alt-drag "keep the old timezone" checkbox — so `savedTzProvisional` now
> travels with `savedTz` through Revert and the lock.

- Chronometer: fresh-bloc branch [:446-452](../src/engine-entry.ts); `applyLocation`
  [:2572-2579](../src/engine-entry.ts); dialog `onFix` [:2635](../src/engine-entry.ts);
  `refreshBlocLocation` [:4039](../src/engine-entry.ts); `onSharedChange` [:2979](../src/engine-entry.ts).
  Note: Chronometer's own dialog does **not** parse the DB on show (only on
  the first search keystroke, [:2775-2780](../src/engine-entry.ts)), so typed
  coordinates are routinely provisional — a primary repro, not an edge case.
- Observatory: `refreshBlocLocation` [:778-782](../src/observatory/observatory-entry.ts),
  fresh-bloc success [:833-838](../src/observatory/observatory-entry.ts),
  `onLocationChange` [:722-734](../src/observatory/observatory-entry.ts),
  `dismissKeepDialog` Keep [:1254-1267](../src/observatory/observatory-entry.ts),
  `onSharedChange` [:1358](../src/observatory/observatory-entry.ts).
- Inspector: [:197-208, 241-247, 277-283, 415](../src/inspector/inspector-entry.ts).
- Shared dialog: add `provisional: boolean` to `LocationChangeInfo`
  ([location-dialog.ts:82, 276](../src/shared/location-dialog.ts)).
- index.html: `...(tz ? { tz } : {})` at [index-page.ts:204](../src/index-page.ts)
  → `tz: tz ?? null` so a prior location's zone is not kept; the browser-button
  reset at [:256](../src/index-page.ts) should also write `tz: null`.
- Same pass: Observatory/Inspector `refreshBlocLocation` clear the stale name
  only under `isPersistentMode()` ([observatory-entry.ts:781](../src/observatory/observatory-entry.ts),
  [inspector-entry.ts:283](../src/inspector/inspector-entry.ts)) while their
  `updateLocationDisplay` reads `getState().city` first — in session-only mode a
  >16 km move keeps rendering the old name at the new coordinates. Clear the
  in-memory name unconditionally; gate only the storage write.
  > **Changed in implementation.** There *was* no in-memory name to clear —
  > that is the whole bug. Both apps gained `locationCityName` (the counterpart
  > of Chronometer's `locationSource`), initialised from `urlState.city`, read
  > by `updateLocationDisplay` and the Set-location button, and written by every
  > path that moves the observer. Storage writes stay gated exactly as before.
- Parity scope: Inspector has no wake-triggered refresh (startup only), so the
  "same-session wake" claims apply to Chronometer + Observatory.

### Step 5 ★ — Adoption semantics (B1, B2, B7)

**Landed 2026-09-07 — §14.** Items 1, 2, 4 and 5 as written; item 3's two
subscriber bodies changed (notes below).

1. **Location group rule** — [app-state.ts:386-409](../src/shared/app-state.ts)
   `urlScalarOverrides()`: after the per-key `has()` lines,
   `if (has('lat') || has('lon','long')) { out.lat = url.lat; out.lon = url.lon; out.city = url.city; out.tz = url.tz; out.bloc = url.bloc; out.lsrc = locationSourceOf(url); }`.
   For a lat/lon-only link this yields `city:null, tz:null, bloc:false, lsrc:'manual'`;
   `mergeNamespace` deletes the nulls/false from `ec:shared`, so the next load
   re-derives city and tz through the existing (step 3) backstops. Full Share
   links are unchanged (their `url.*` equal what `has()` emitted). Slots-only,
   picks-only and time-only links still merge (the 2026-06-13 invariant).
   `bloc:false` matches every other explicit-location write — **product
   decision, §9 Q1**. Write an explicit `lsrc` so the legacy inference (which
   would later mislabel a backfilled city as a "city" pick) is never reached.
2. **Adoption hook** — `onAdoptedAsDefault(cb)` listener registry in app-state,
   fired at the end of `adoptCurrentStateAsDefault` (both the incoming prompt
   and the session re-prompt go through it). In `clearShareableParamsFromUrl`
   call `updateNavigationLinks()` after `history.replaceState` (what
   `writeUrlState` already does).
3. **Subscribers**: Chronometer registers `persistDerivedCity()` (persist the
   nearest city if the DB is loaded, else re-enter `updateLocationDisplay`'s
   on-demand path, whose guards now pass) and `if (!getState().tz) ensureTzResolved()`;
   Observatory/Inspector register `updateLocationDisplay()` + the same tz call;
   index-page re-runs `updateLinks()` (and makes it mode-aware like
   `appNavHref`); pick-page refreshes `#pick-home-link`
   ([pick-page.ts:71-75](../src/pick-page.ts)), which none of the generic link
   updaters touch.
   > **Changed in implementation.** Two of these bodies are no-ops as specified.
   > - *The tz call.* By Save time the backstop has usually already resolved and
   >   disarmed, so `if (!getState().tz) ensureTzResolved()` would do nothing and
   >   the resolved zone would never reach the freshly-cleared storage — leaving
   >   every later load to re-parse the 22 MB DB. Each app now stores the zone it
   >   already holds when it is confident, and calls `ensureTzResolved()` only
   >   while the flag is still armed.
   > - *The city.* `updateLocationDisplay()` returns early once a name is on
   >   screen (Observatory/Inspector), and Chronometer's on-demand path blanks
   >   the label before parsing — re-entering after the DB was released would
   >   flash the name off for the parse. All three now persist the name already
   >   in memory (`locationCityName`, and a new `derivedCityName` in
   >   Chronometer with exactly the label's lifetime), falling back to the
   >   on-demand path only when there is none.
   >
   > Chronometer registers its subscriber late in `main()`, beside the startup
   > `ensureTzResolved()` call: `main()` awaits geolocation on a `bloc` link and
   > the dialog can be answered during that wait, so an earlier registration
   > could invoke the resolver in its temporal dead zone. Nothing is lost — an
   > adoption before that point leaves the startup derivations to run in
   > persistent mode, which is what the hook would have replayed.
   >
   > `navSearch()` was extracted from `appNavHref` so index-page's `updateLinks`
   > and pick-page's `updateHomeLink` share the mode-aware rule rather than
   > re-deriving it.
4. **Gate the `setState({ tz })` at [engine-entry.ts:423](../src/engine-entry.ts)
   (decided 2026-09-06):** `if (isPersistentMode()) setState({ tz: locationTimezone })`,
   like every other automatic write. Note it is unreachable today: `loaded`
   is set only by `ingest()` ([city-search.ts:178-198](../src/shared/city-search.ts))
   and nothing calls `loadCityData()` before this line (the first call is
   [:535](../src/engine-entry.ts)); the prefetch only stores bytes. The tz that
   *sometimes* survives adoption today comes from the [:3010](../src/engine-entry.ts)
   backstop in the Save-before-parse ordering, not from this line. Gating is
   future-proofing for any preload that parses the DB before `main()`.
5. Eclipse-table deep links ([eclipse-table-page.ts:164-172](../src/eclipse-table-page.ts))
   emit `lat`, `lon`, `tz`, `t`, `dir=0` (plus `picks`/`body` for
   `selected.html`) and no `city`/`lsrc`. **Decided 2026-09-06:** no change to
   the links. Under the group rule `tz` is kept as sent, the city is backfilled
   with the nearest database city, and provenance records `lsrc:'manual'` (the
   location dialog will read "manually entered" for an eclipse site — accepted).

### Step 6 — B9 (small, any time after step 5)

**Landed 2026-09-07 — §14.** As written. Both `setSlotOverrides` callers are
genuine user edits (a city pick, the reset confirmation) — no rebuild path
reaches it, so the re-prompt never fires spuriously.

In `setSlotOverrides`'s `UrlBackend` branch ([app-state.ts:655-661](../src/shared/app-state.ts)):
if `sessionRePromptArmed`, disarm and `void promptSessionReprompt()`, so a
Terra/Gaia city pick in "visit only" mode gets the same offer as any other
config edit (planning 2026-06-13 L256-258) and reaches the adoption hook.

### Step 7 — Docs and tests sweep (§7, §8)

**Landed 2026-09-07 — §14.** §7 and §8 below record what was written.

### Not planned

- The time group has the same merge hazard as the location group (a `?t=` link
  adopted over a stored `off` leaves both; apps read `off` first). One-line
  extension of the group rule if wanted later. **Still not done** — see §15.

## 6. Edge cases the plan must keep true

**All hold.** The first four and the last two are pinned by unit tests
(`adoption.test.ts`, `tz-ensure.test.ts`, `tz-resolve*.test.ts`,
`observer-slot-relabel.test.ts`); the rest were checked in the browser pane
(§11–§14). One is stronger than written: the Observatory now also suspends the
*city-name* backfill during a map drag, not only the timezone resolution — the
live coordinates are the drag position for both (§13 review).

- Full Share links (lat/lon/city/tz/lsrc[/bloc]) adopt exactly as today.
- Slots-only / picks-only / t-only links never touch the stored location.
- Save before vs after the DB parse both converge on a persisted DB-derived
  city and tz (the scratch `b1-timing` cases become the regression tests).
- `resolveTimezoneFromDb` → `null` (offline, fetch failure) persists nothing;
  storage tz stays absent so the next load retries; never persist a browser zone.
- Session-only (`UrlBackend`) and in-memory modes: on-screen relabel and tz
  correction still happen; no automatic storage/URL writes (the
  `isPersistentMode` doc comment's rule).
- A location change while a resolution is in flight: the coordinate stamp makes
  the stale answer a no-op.
- Location dialog open / map drag in progress: no DB release until dismiss/idle.
- DST and per-tick rebuilds keep preserving the knockout; they re-copy from
  `face.terraSlotOverrides`, which the backfill also updated, so they stay
  consistent with the relabeled env.
- Multi-face pages (`all.html`, `selected.html`): the backfill loops all faces.
- Embed mode untouched (lat/lon 0,0; no DB).

## 7. Tests

**Written.** Nine files, 75 cases, all under jsdom in the existing
`app-state.test.ts` style (seed `localStorage`, `history.replaceState`,
`initAppState`, click `.ec-modal-btn.ec-primary`, flush microtasks). Full suite:
51 files / 8767 tests green.

| File | Cases | Pins |
|---|---|---|
| [adoption.test.ts](../src/__tests__/adoption.test.ts) | 17 | the location group (lat/lon-only, full Share, `bloc=1`, eclipse-shaped, `lon`-only); slots-only / picks-only / time-only still merge; `onAdoptedAsDefault` fires once after storage is written and the URL cleaned, unsubscribe, a throwing listener, the re-prompt path, never on a session-only visit; nav links re-synced; B9 re-prompts once and adopts the pick |
| [tz-ensure.test.ts](../src/__tests__/tz-ensure.test.ts) | 13 | the `createTzResolver` contract, fake-driven: sync fast path; stale stamp ignored with the flag armed; null → flag cleared, nothing persisted; same zone → no apply but persist; no own parse while the name path parses; pending dedupe per coordinates; suspended → deferred; apply throw → reported, DB still released |
| [observer-slots.test.ts](../src/__tests__/observer-slots.test.ts) | 13 | LA → slot 4 / NY → slot 7 (a tz change **must** move the derived slots); name priority down to `'Local'`; Gaia slot 1 follows `locationTimezone`; tie-break goldens |
| [tz-resolve.test.ts](../src/__tests__/tz-resolve.test.ts) | 10 | provisional vs confident; `persistableTz` (confident → itself, guess → null, absent → null not `undefined`); `resolveTimezoneFromDb` on demand and across a racing release |
| [observer-slot-relabel.test.ts](../src/__tests__/observer-slot-relabel.test.ts) | 7 | the env slot is a distinct object from the override; `relabelTerraSlot` updates the env, nulls the knockout, is idempotent, tolerates a missing slot; the dual write |
| [terra-slot-persistence.test.ts](../src/__tests__/terra-slot-persistence.test.ts) | 7 | the observer is displayed in its slot while the persisted map still holds the user's `r7`; an unrelated slot edit never writes the observer's name; the reset clears both maps |
| [location-dialog-provisional.test.ts](../src/__tests__/location-dialog-provisional.test.ts) | 3 | `LocationChangeInfo.provisional` end-to-end through the shared dialog: same coordinates, both answers, tracking the DB rather than the location |
| [tz-resolve-db-unavailable.test.ts](../src/__tests__/tz-resolve-db-unavailable.test.ts) | 3 | load rejects → null; resident-check never true → null after three attempts; the retry across a shared in-flight promise with a racing release |
| [terra-env-stale-slot.test.ts](../src/__tests__/terra-env-stale-slot.test.ts) | 2 | characterization: an env with LA slot data and a NY `olsonTimezone` keeps LA time — why `applyResolvedTimezone` exists |

Two planned items were not written as such: `index-links.test.ts` folded into
`adoption.test.ts` (the mechanism is `clearShareableParamsFromUrl` →
`updateNavigationLinks`; index-page's own module has top-level DOM side effects
and cannot be imported under jsdom), and the `city-search` release/re-parse pin
was covered by the `tz-resolve-db-unavailable` retry cases instead.

**Manual runs** (browser pane, scratch builds of HEAD and the working tree —
see §11–§14 for the numbers): (a) seeded-`bloc` device move >16 km with a
stubbed `navigator.geolocation` — Gaia slot 1 and Terra's top slot take the
nearest city as soon as the footer does, one `[CitySearch] Released`;
(b) a lat/lon-only link with the VM zone in LA — the tz label corrects, and
Save + reload keeps the corrected zone in `ec:shared.tz`; (c) the full report-1
sequence with `bloc:true` seeded — adoption clears `bloc`, so no coordinate
replacement; (d) Observatory drag → press through the modal (resumes, no
re-parse) → Keep or Revert (exactly one release), plus the Alt-drag timezone
lock; (e) Terra's observer sector after a location change, read off a `fillText`
spy on the ring knockout. Steve's own device-level checks (DevTools Sensors,
a real 15-minute tab-return) are still worth doing once for (a).

## 8. Docs updated

All done, across steps 1–7.

- [docs/location-and-cities.md](../docs/location-and-cities.md) — a
  "Timezone resolution" subsection (stored → nearest-city zone → provisional
  browser zone, corrected by `ensureTzResolved()`, stored only when
  DB-derived, via `persistableTz`); the in-session label upgrade; a note that
  the displayed name lives in memory, not in `getState().city`, because the
  storage write is gated; and a new **"Adopting an incoming location"** section
  for the location group rule and `onAdoptedAsDefault`.
- [docs/world-time-slots.md](../docs/world-time-slots.md) — slot-1 name
  priority incl. `olsonIdToCityName`; one derivation applied at startup *and*
  on location change; "once the DB loads" now happens in-session via
  `relabelTerraSlot`; the observer slot's `olsonId` re-derives on any change of
  `locationTimezone`, never by the DST path; and, under "Global Location
  Override" / "City Customization Dialog", that only *user* overrides are
  persisted.
- [docs/timezone-and-dst.md](../docs/timezone-and-dst.md) — the provisional →
  corrected pipeline, the two rules every location path obeys (store through
  `persistableTz`, arm `tzNeedsResolution`), the `createTzResolver` contract,
  and the key-files table.
- [docs/observatory.md](../docs/observatory.md) — tz backstop parity; every
  later location change re-arms it; the drag-to-explore DB lifecycle and the
  saved provisional flag that travels with `savedTz`.
- [docs/adding-a-new-app.md](../docs/adding-a-new-app.md) *(not in the original
  list)* — its location sample still showed the old `initLocationDialog`
  signature and `resolveTimezone`; a new app copying it would have
  reintroduced B11. Now shows `info.provisional` → `persistableTz` →
  `ensureTzResolved`, with `tz-ensure.ts` added to the key-files table.
- [planning/2026-06-13](2026-06-13-localstorage-state-and-sharing.md) — amended
  at its partial-merge fix (the location group is the exception) and at the
  re-prompt section (it no longer "writes the full current state"; the adoption
  hook; slot picks now re-prompt).
- [planning/2026-06-14](2026-06-14-observatory-cities-lazy-load.md) — amended:
  the live-env relabel supersedes the "set locationSource" wording; both paths
  now go through one derivation; only user overrides are persisted; a tz
  correction re-runs pass 1.
- Source comments: `engine-entry.ts`'s reference to `ensureTzResolved` is now
  true; `app-state.ts`'s `urlScalarOverrides` documents the group rule, and
  **`isPersistentMode`'s doc comment gained the corollary** — a gated write that
  was skipped is *lost* unless something replays it, so keep it in memory, write
  it again from an `onAdoptedAsDefault` subscriber, and never let the display
  read the gated field back from storage.

## 9. Product decisions (all taken)

1. **Should "Save as my default" on a lat/lon link *without* `bloc` turn
   follow-the-device off?** **Decided 2026-09-05 (Steve): yes.** Saving a
   specific location means the user does not want the next device-location
   update to replace it. Adoption writes `bloc:false`, consistent with every
   other explicit-location write.
2. **Which app and which button for report 1?** *Diagnostic only — the
   answer does not change the plan; all three mechanisms are fixed.*
   Observatory + any button reproduces the wrong tz immediately (B3);
   Chronometer + "Save as my default" + reload reproduces both symptoms from
   storage (B1); Chronometer reading the *face* (Terra's top slot and hands,
   Gaia's main dial) rather than the footer reproduces them in-session (B6).
   The stored `ec:shared` blob on that device would settle it (a stale `tz`
   present ⇒ the Save-then-reload path).
3. **What did Terra actually show?** **Answered 2026-09-05: "Los Angeles"**,
   not "Observer" — matches the code prediction; no uncovered path.
4. **Four smaller decisions — all taken 2026-09-06:**
   (a) eclipse-table deep links: keep as is; adopt with the nearest database
   city and `lsrc:'manual'` (§5 step 5.5);
   (b) Terra observer slot: persist only what the user overrode, never the
   injected value; display rule unchanged (§5 step 1b);
   (c) Observatory map drag: keep the parsed DB while the Keep/Revert modal is
   up (a press resumes the drag), release when it goes away (§5 step 3);
   (d) gate the startup tz write at [engine-entry.ts:423](../src/engine-entry.ts)
   (§5 step 5.4).

## 10. Appendix — verification artifacts

Scratch vitests (session scratchpad; ephemeral, copies attached to the chat):
`s1-adopt`, `s6-adopt`, `s3-save-merge`, `b1-adopt`, `b1-timing`,
`b2-adopt-bloc` (B1/B2/B7: exact `ec:shared` after Save, both parse orderings,
stale bloc survives), `b3-obs-tz`, `b3-tz` (browser-zone fallback with the DB
unparsed; `resolveTimezoneFromDb` contract), `s5-env-copy`, `b4-slot-copy`
(env holds a distinct copy of the slot; post-build mutation does not reach it),
`critic-b9-slots-reprompt` (B9 and the ungated `:423` write). Run with
`npx vitest run -c <scratch>/vitest.scratch.config.ts`.

**Superseded.** Every behaviour those scratch tests reproduced is now pinned by
a committed test in §7 — the B1/B2/B7/B9 cases by `adoption.test.ts`, the
provisional-fallback cases by `tz-resolve.test.ts`, and the env-copy case by
`observer-slot-relabel.test.ts`. They are recorded here only as the audit trail
for the diagnosis; there is nothing left to re-run.

## 11. Implementation notes — steps 1 and 1b (2026-09-06)

Files: `src/engine-entry.ts`, `src/watch/watch-env.ts` (`relabelTerraSlot`),
`src/watch/terra-slots.ts` (`parseTerraUserOverrides`,
`serializeTerraOverrides`, `TERRA_RING_SLOT_COUNT`), new tests
`src/__tests__/observer-slot-relabel.test.ts` and
`src/__tests__/terra-slot-persistence.test.ts`; docs
`docs/world-time-slots.md`, `docs/location-and-cities.md`. `tsc --noEmit`
clean; full vitest suite green (44 files / 8705 tests + 13 new).

Landed as planned, with these specifics:

- Step 1.1: `rebuildAllForLocationFrozen` re-derives both Terra and Gaia via
  `buildSlotOverrides`; the hand-built Gaia block is gone; the last-resort
  literal in `buildSlotOverrides` is now `'Local'` (unreachable in practice —
  `resolveTimezone` never returns an empty zone).
- Step 1.2: `relabelTerraSlot(env, slot, name)` in watch-env.ts;
  `backfillObserverSlots` updates both the face-side overrides and the live
  env, marks the face dirty, and — only once the first frame has painted —
  calls `ensureSchedulerRunning()` so a stopped clock still repaints. (Review
  caught the unguarded form: at startup the loop is first started by the
  initial cache build's completion, and a kick before that ran a frame that
  skipped every unbuilt face yet still fired the load-bar handoff over blank
  canvases. Gated on `firstFramePainted`; the first scheduled start draws the
  relabeled env anyway.)
- Step 1.3: `refreshBlocLocation` no longer calls `updateLocationDisplay()` a
  second time (the reseed write stays after `applyLocation`, before any await).
- Step 1.4: `reverseGeocodeInFlight` guard (the label is blanked first — a
  named label never describes new unnamed coordinates — then the guard
  returns); the DB-load handler's body is in `try/finally` so
  `releaseCityData()` always runs — including when a *named* location arrived
  mid-parse, where the old code returned before releasing (a leak, the B12
  pattern in Chronometer). The startup `updateLocationDisplay()` call moved
  to just after the face-construction loop (the app is behind the
  load-progress bar until the first frame, so nothing is visible any later).
- Step 1b: `SlotOverrideResult.userOverrides` / `FaceInstance.terraUserOverrides`;
  `assignCityToSlot` writes the pick into both maps; `writeTerraOverridesToUrl`
  serializes only the user map; the reset clears both. The r-key parse and
  serialize moved to pure functions in terra-slots.ts so they are unit-testable.

Not changed *by this step* (the first two were done in steps 2–4): the startup
double parse (name path + tz backstop each parsed once — step 3's merged
`ensureTzResolved`); the browser-zone tz after an in-session location change
with the DB unparsed (B6/B11);
Chronometer's private location dialog does not release the parsed DB on
dismiss (pre-existing; the DB stays resident until the next reverse-geocode
release).

**Before/after evidence** (scratch builds of HEAD and the working tree, served
from the session scratchpad; browser pane with a setTimeout rAF shim, a
`fillText` spy on the Gaia local-subdial font, lat/lon-only URL, then the
location dialog's "Use coordinates" with 40.7/−74.0 while the DB was unparsed):

| build | frames after the change (label drawn on Gaia's local subdial) | footer |
|---|---|---|
| HEAD | "Los Angeles" ×2 (pre-change), then **"Observer"** on every frame for 8 s, even though `[CitySearch] Loaded` landed 0.15 s after the click | Brooklyn Heights |
| patched | "Cupertino" (pre-change — the startup relabel already worked), then **"Brooklyn Heights"** on every frame after the parse | Brooklyn Heights |

Terra (patched): the ring knockout rebuilt with "Brooklyn Heights" painted in
the observer sector (slot 4, the erased default "Los Angeles"); a second move
to 51.5/−0.12 painted "Lambeth". Exactly one `[CitySearch] Loaded` per
location change and no second parse (the dialog was open, so no release —
by design).

**Review pass (4 lenses, adversarial):** one medium finding (the startup
scheduler kick above — fixed), two low (blank-before-guard; the
`terraUserOverrides` comment — both fixed), and two test/doc notes: the Terra
persistence tests pin the pure parse/serialize contract and the ghost
mechanism on data, not the dialog wiring (which lives in `main()` closures
and needs the step-2.3 `deriveObserverSlots` extraction for a seam — the test
header says so); a dual-write test was added to observer-slot-relabel.test.ts.
Verifiers confirmed every reviewed behaviour listed in §5 step 1 as intended
(Gaia slots 2–N re-read from storage on a location change are always in sync
with the in-memory table; the deferred startup call has no consumer between
the old and new sites; the try/finally release when a named location arrives
mid-parse is correct — the tz backstop re-parses and the city dialogs re-check
`isCityDataLoaded`).

**Final build timings** (Gaia, patched, lat/lon-only URL, pane with rAF shim,
times from bundle start): DB parsed 0.29 s → released; tz backstop parse
0.44 s → released; first drawn frame 1.01 s already labelled "Cupertino";
load bar removed 1.07 s (after that frame). In-session: coordinates changed at
+1.38 s, parse landed +1.52 s, next frame +3.39 s drew "Brooklyn Heights".

## 12. Implementation notes — steps 2 and 3 (2026-09-06)

Files: `src/shared/tz-resolve.ts`, `src/watch/observer-slots.ts` (new),
`src/engine-entry.ts`, `src/inspector/inspector-entry.ts`,
`src/observatory/observatory-entry.ts`; new tests
`src/__tests__/observer-slots.test.ts`, `tz-resolve.test.ts`,
`terra-env-stale-slot.test.ts`; docs `timezone-and-dst.md`, `observatory.md`,
`location-and-cities.md`, `world-time-slots.md`. `tsc --noEmit` clean; full
vitest green (47 files / 8727 tests, 21 new).

Landed as planned, with these specifics and deviations:

- Step 2.1: `resolveTimezoneProvisional(lat, lon, cityTz) → {tz, provisional}`;
  `resolveTimezone` delegates to it. (Not yet used at the persist sites —
  that is step 4; used by the Observatory startup block.)
- Step 2.2: `applyResolvedTimezone(tz)` re-derives slots via
  `rebuildAllForLocation`. **Deviation:** before the first frame has painted
  it must not start the render loop (the load-bar handoff fires on the first
  frame — the review of step 1 caught the same hazard) and the initial static
  caches may still be building, so it swaps envs and slot tables in place via
  `rebuildFacesForEnvChange({ skipUnbuiltCaches: true, restartScheduler: false })`
  — a new option that leaves faces whose initial caches are unbuilt to the
  pending initial build (which reads `face.env` when its turn comes) — and
  updates the location bar and tz label; the initial build's completion starts
  the loop. The slot re-derivation hook is factored as `reDeriveSlotTables`.
- Step 2.3 (optional in the plan, done): `buildSlotOverrides` extracted to the
  pure `deriveObserverSlots(watch, ctx)` (+ `resolveObserverName`) in
  `watch/observer-slots.ts`; the engine's function is a thin wrapper. The 1b
  persistence invariant now has an end-to-end test on that seam.
- Step 3: one `ensureTzResolved()` per app with the coordinate stamp, the
  `!getState().tz` persist gate, release in `finally`, and the Observatory's
  new startup block + backstop. **Deviations, both to avoid a second parse:**
  (a) resident DB → synchronous fast path (no parse, no release); (b) each
  app's location-name DB-load handler calls `ensureTzResolved()` while the DB
  is resident, and the standalone call declines to start its own
  `resolveTimezoneFromDb` while that name-path parse is in flight
  (`reverseGeocodeInFlight` / `cityParseInFlight`) or while a resolution for
  the same coordinates is already pending (`tzResolvePending`, keyed on
  coordinates so a newer location is never left waiting on a stale answer).
  `apply` also bails if `tzNeedsResolution` was cleared meanwhile. Without
  (b) the first build still parsed twice at startup (measured).
- B12: the Observatory DB-load handler releases regardless of a mid-parse
  stored city. Map drag: released at the very end of `dismissKeepDialog`
  (decision 9(c)).

**Before/after evidence** (scratch builds of HEAD and the working tree in the
browser pane, rAF shim, `fillText` spy on the Terra knockout; `terra.html?lat=40.7&lon=-74.0`,
VM browser zone America/Los_Angeles, "Use for this visit only"):

| build | startup parses | Terra ring after the correction | tz label |
|---|---|---|---|
| HEAD | 2 (name path, then the backstop's retry) | **"Brooklyn Heights" painted in the Los Angeles column (slot 4)**, "New York" default untouched — B6 | America/New_York |
| patched | 1 | "Brooklyn Heights" in the **New York column (slot 7)**, "Los Angeles" back to its default | America/New_York |

Observatory (`observatory.html?lat=40.7&lon=-74.0`, patched): one startup
parse; the dialog's tz line — written by the shared time controls from the
Observatory's own `locationTimezone` — reads America/New_York (B3; HEAD had no
correction at all). Map drag: press parses the DB; release → Keep/Revert modal
with no release; a press while the modal is up resumed the drag with no
release; Revert → exactly one `[CitySearch] Released`; a second drag re-parsed
and Keep released again.

**Review pass (4 lenses; verifiers partly cut off by the session limit, so the
findings below were confirmed by reading and by tests) and what changed:**

- **High — Inspector crashed at module load.** My `cityParseInFlight` was
  declared ~800 lines below the module-level `updateLocationDisplay()` call
  that assigns it: a temporal-dead-zone throw on any unnamed location with the
  DB unparsed (the report-1 link shape). Fixed by declaring the flag, and the
  resolver, next to `tzNeedsResolution` near the top; verified in the pane
  (no errors, one parse, zone corrected).
- **Medium — Observatory resolution landing mid-drag.** The name-path handler
  ran during drag-to-explore with the live lat/lon at the dragged spot, so the
  resolver stamped, applied and persisted the *dragged* spot's zone against
  the stored location, and Revert restored the provisional guess for good.
  Fixed: the resolver is suspended while `dragState !== 'idle'` (flag stays
  armed) and `dismissKeepDialog` re-runs it once settled, before its release.
  Verified: during the modal the dialog's tz line showed the dragged spot's
  zone; after Revert it read America/New_York again with one release.
- **Medium — the contract was triplicated, untested.** Extracted to
  `createTzResolver(deps)` in `src/shared/tz-ensure.ts` (hooks: location,
  needs-resolution flag, apply, persist gate, parse-in-flight, suspended,
  release, onError; DB seams injectable). 13 fake-driven tests pin the
  contract (sync fast path; stale stamp ignored with the flag armed; null →
  flag cleared, nothing persisted; same zone → no apply but persist; no own
  parse while the name path parses; pending dedupe per coordinates; suspended
  → deferred; apply throw → reported, DB still released).
- **Medium — missing tests.** `tz-resolve-db-unavailable.test.ts`: load
  rejects → null; load resolves but the DB never becomes resident → null after
  three attempts; and the retry across a shared in-flight promise with a
  racing release registered ahead of the resolver (the production shape).
- **Low.** Async-path `.catch(() => {})` (all three apps, and the name-path
  handler) now log; the resolver JSDoc sits on the resolver; the Observatory
  init comment describes the real ordering; §12 records the flag semantics
  (above). The Chronometer double parse the reviewer saw was the pre-dedupe
  snapshot; the deduped build parses once (measured in all three apps).

The refactor itself (factory + the two fixes) was not put through a second
agent review pass; it is covered by the new unit tests and the three-app
browser run above.

## 13. Implementation notes — step 4 (2026-09-07)

Files: `src/shared/tz-resolve.ts` (`persistableTz`; `resolveTimezone` deleted),
`src/shared/location-dialog.ts` (`LocationChangeInfo.provisional`),
`src/engine-entry.ts`, `src/observatory/observatory-entry.ts`,
`src/inspector/inspector-entry.ts`, `src/index-page.ts`; new test
`src/__tests__/location-dialog-provisional.test.ts`, extended
`tz-resolve.test.ts`; docs `timezone-and-dst.md`, `location-and-cities.md`,
`observatory.md`, `adding-a-new-app.md`. `tsc --noEmit` clean; full vitest
green (50 files / 8750 tests, 7 new).

Landed as planned, with these specifics and deviations:

- **`persistableTz(tz, provisional)` (new, not in the plan).** The plan spelled
  the rule inline at ~10 sites as `tz: provisional ? null : tz`. Naming it
  makes the invariant greppable — `grep persistableTz` *is* the inventory of
  `setState({ tz })` sites — and gives the "store null, never a guess, never
  `undefined`" rule a unit test. Every listed site now uses it.
- **`resolveTimezone()` deleted.** After the pass it had no production caller:
  every caller resolves a zone in order to show *and* store it, so every caller
  must know whether the answer is a guess. Leaving the zone-only form standing
  was the trap that would reintroduce B11 at the next new persist site.
- Chronometer: the startup lat/lon branch's `isCityDataLoaded()` fork collapsed
  into `resolveTimezoneProvisional` (it also fixes a latent case the fork got
  wrong — DB resident but `findClosestCity` null would have persisted the
  browser zone); fresh-bloc branch; `applyLocation` (sets the flag and calls
  `ensureTzResolved()` at its end, so the two callers that persist *after* it
  returns read a settled flag); dialog `onFix`; `refreshBlocLocation`;
  `onSharedChange`. The startup branch cannot call `ensureTzResolved()` — the
  resolver is a `const` ~1900 lines further down `main()` (TDZ, the shape of
  the step-3 Inspector crash) — and does not need to: the existing startup call
  covers it.
- Observatory / Inspector: `onLocationChange` reads `info.provisional`; bloc
  fix, bloc refresh and `onSharedChange` resolve provisionally. Each new call
  site runs `ensureTzResolved()` **after** its `updateLocationDisplay()`, so the
  location-name reverse-geocode owns the parse and the resolver defers to it
  (verified: one `[CitySearch] Loaded` per location change).
- Observatory map drag: `savedTzProvisional` joins `savedTz`, because the drag
  now moves the flag. Revert restores both (keeping §12's documented behaviour —
  Revert restores the pre-drag guess and the trailing `ensureTzResolved()`
  corrects it), and the Alt-drag "keep the old timezone" checkbox carries the
  pre-drag zone's provisional-ness with the zone it keeps.
- index.html: `...(tz ? { tz } : {})` → `persistableTz(...)`, and the
  browser-button reset writes `tz: null`. The hand-rolled
  `cityTz ?? (isCityDataLoaded() ? resolveTimezone(...) : null)` is exactly
  `resolveTimezoneProvisional` + `persistableTz`, so the tiering is now shared.
- **Session-mode name gap.** The plan says "clear the in-memory name
  unconditionally", but Observatory and Inspector had no in-memory name — their
  `updateLocationDisplay` read `getState().city`, and `setState({city:null})` is
  gated. Added `locationCityName` (the counterpart of Chronometer's
  `locationSource`), initialised from `urlState.city`, written by every path
  that moves the observer (dialog pick, bloc fix, bloc refresh → `null`, kept
  map drag → `null`, Revert → `savedCity`, cross-tab, and the reverse-geocode's
  own backfill) and read by `updateLocationDisplay` and the "Set location"
  button's `updateState`. Storage writes stay gated exactly as before.

**Before/after evidence** (scratch builds of HEAD and the working tree served
from the session scratchpad; browser pane with a `setTimeout` rAF shim, a
`console.log` collector, and — for the bloc cases — a stubbed
`navigator.geolocation` returning London, 5,500 km from the seeded New York
location). VM browser zone: America/Los_Angeles.

| scenario | HEAD | patched |
|---|---|---|
| Terra, session-only, dialog "Use coordinates" 51.5/−0.12 with the DB released after startup | footer "Lambeth", tz label **America/Los_Angeles**, URL carries `tz=America%2FLos_Angeles` | "Lambeth", **Europe/London**, URL carries **no `tz`** |
| Terra, persistent, same pick | `ec:shared.tz` = **"America/Los_Angeles"** beside London coordinates | `ec:shared.tz` = **"Europe/London"** |
| Inspector, session-only, seeded bloc + device fix in London | name **"Brooklyn Heights"**, zone **America/Los_Angeles**, no DB parse at all | name **"Lambeth"**, zone **Europe/London**, one parse + one release |
| Observatory, session-only, same | bar and dialog **"Brooklyn Heights, New York, US"**, zone America/Los_Angeles | **"Lambeth, England, GB"**, Europe/London |

Observatory map drag (patched, persistent): press → one `[CitySearch] Loaded`;
Keep → name "Doolittle", `ec:shared` `{tz:"America/Chicago", lsrc:"map"}`, one
`[CitySearch] Released`. Second drag → Revert → name back to "Doolittle",
storage untouched, one parse + one release. Alt-drag with the checkbox
unchecked → moved to Al Fuwayliq (Saudi Arabia) while both the display and
`ec:shared.tz` kept **America/Chicago** — the lock is honoured and persisted.

**Review pass (single agent, high effort) and what changed:**

- **Low, pre-existing, fixed.** The Observatory's location-name DB handler
  backfilled the nearest city from the *live* lat/lon, which during a
  drag-to-explore is the transient drag position: a press that lands while the
  startup reverse-geocode is still parsing named — and, in persistent mode,
  persisted — the dragged spot's city against the stored location. The tz half
  of this was fixed in step 3 (`suspended`); the name half now suspends the
  same way (`if (!locationCityName && dragState === 'idle')`), leaving the work
  to `dismissKeepDialog`'s own `updateLocationDisplay()`. Self-healing before
  (both Keep and Revert repair it), so the window was "close the tab mid-drag",
  but it is the same stale-name-beside-coordinates shape this plan is about.
- **Low, fixed.** The Observatory and Inspector fresh-`bloc` startup branches
  set every other location field but left `locationCityName` at whatever
  `urlState.city` held; they now clear it, since a brand-new device fix has no
  name until the reverse-geocode supplies one.
- Verified again after both fixes: Keep and Revert on a rebuilt scratch
  Observatory still give one parse + one release with the right name and
  storage.

Not changed *by this step* (both done in step 5, §14): adoption still merged
per-field here, so a lat/lon-only link Save kept a stale stored `city`/`bloc`
(B1/B2); and the startup `setState({ tz })` at the confident branch was still
ungated (5.4).

## 14. Implementation notes — steps 5, 6 and 7 (2026-09-07)

Files: `src/shared/app-state.ts` (the location group rule, `onAdoptedAsDefault`,
the slot re-prompt), `src/shared/app-nav.ts` (`navSearch`), `src/engine-entry.ts`,
`src/observatory/observatory-entry.ts`, `src/inspector/inspector-entry.ts`,
`src/index-page.ts`, `src/pick-page.ts`; new test
`src/__tests__/adoption.test.ts` (17 cases); docs `location-and-cities.md` and
amendments to the 2026-06-13 and 2026-06-14 plans. `tsc --noEmit` clean; full
vitest green (51 files / 8767 tests).

### Step 5 — adoption semantics

- **5.1 The location group.** `urlScalarOverrides()` keeps its per-field lines
  and then, when the URL carries `lat` or `lon`, adopts all six fields together
  (`lsrc` via `locationSourceOf(url)`, so provenance is explicit and a later
  backfilled `city` is never read back as a deliberate city pick). A `lon`-only
  link now clears the whole location instead of silently pairing a new longitude
  with the stored latitude — the honest outcome for a malformed link.
- **5.2 The hook.** `onAdoptedAsDefault(cb)` returns an unsubscribe; listeners
  fire at the end of `adoptCurrentStateAsDefault` (so both prompts go through
  it), each in a try/catch so one throwing subscriber cannot strand the rest.
  `clearShareableParamsFromUrl` now calls `updateNavigationLinks()` after its
  `replaceState`, matching what `writeUrlState` already does — that alone fixes
  B7 for every page whose links the shared updater owns.
- **5.3 Subscribers.** Chronometer, Observatory and Inspector each register
  `persistDerivedCity()` plus the timezone replay; index-page re-runs
  `updateLinks()`, pick-page `updateHomeLink()`.
  - **Deviation (tz).** The plan said `if (!getState().tz) ensureTzResolved()`.
    That silently does nothing in the common case: by Save time the backstop has
    usually already resolved and disarmed, so the resolved zone would never
    reach the freshly-cleared storage and every later load would re-parse the
    22 MB DB. The subscriber now stores the zone it already holds when it is
    confident, and calls `ensureTzResolved()` only while the flag is still armed.
  - **Deviation (city, Chronometer).** The plan said to re-enter
    `updateLocationDisplay`'s on-demand path. That path blanks the label before
    parsing, so re-entering after the DB was released would flash the name off
    for ~300 ms at the moment of the click. Added `derivedCityName` — the
    nearest-city `shortLabel` behind the label currently on screen, with exactly
    the label's lifetime (set where the label is written, cleared where it is
    blanked). The subscriber persists that when it has it and falls back to the
    plan's path otherwise. Observatory and Inspector already have step 4's
    `locationCityName` and use it the same way.
  - **Registration point (Chronometer).** Registered late in `main()`, beside
    the startup `ensureTzResolved()` call, because `main()` awaits geolocation
    on a `bloc` link and the dialog can be answered during that wait — an early
    registration could invoke `ensureTzResolved` in its temporal dead zone (the
    shape of the step-3 Inspector crash). Nothing is lost: an adoption before
    that point simply leaves the startup derivations to run in persistent mode.
  - **`navSearch()`** extracted from `appNavHref` so index-page's `updateLinks`
    and pick-page's `updateHomeLink` build links by the same rule the cross-app
    links use (clean in persistent mode, full query string in the fallbacks).
    `appNavHref` is now `page + navSearch()`.
- **5.4** The startup `setState({ tz })` is gated on `isPersistentMode()`.
- **5.5** Eclipse-table deep links unchanged, as decided; pinned by a test.

### Step 6 — B9

`setSlotOverrides`'s `UrlBackend` branch disarms `sessionRePromptArmed` and
re-prompts, so a Terra/Gaia city pick — the one session-only edit that bypasses
`setState` — gets the same offer as any other. `adoptCurrentStateAsDefault`
switches the backend before writing slots, so its own `setSlotOverrides` call
takes the LocalStorage branch and cannot recurse.

### Step 7 — docs and tests

`adoption.test.ts` covers the group rule (lat/lon-only, full Share, `bloc=1`,
eclipse-shaped, `lon`-only), the merge cases that must not change (slots-only,
picks-only, time-only), the hook (fires once after storage is written and the
URL cleaned; unsubscribe; one listener throwing; the first-edit re-prompt path;
never on a session-only visit), the nav-link re-sync, and B9 (re-prompts once,
adopts the pick). Docs: a new "Adopting an incoming location" section in
`location-and-cities.md`; amendments to the 2026-06-13 plan (the group rule,
the hook, the slot re-prompt, and the stale "writes the full current state"
wording) and the 2026-06-14 plan (the live-env relabel supersedes "set
locationSource"; one derivation; only user overrides persisted; a tz correction
re-runs pass 1); and a corollary added to `isPersistentMode`'s doc comment —
a gated write that was skipped is lost unless something replays it.

**Before/after evidence** (scratch builds of HEAD and the working tree, browser
pane; stored `ec:shared` seeded to Cupertino + `bloc:true`, opened at
`?lat=40.7&lon=-74.0`, then "Save as my default"):

| | HEAD | patched |
|---|---|---|
| Terra, `ec:shared` after Save | `{lat:40.7, lon:-74, city:"Cupertino", tz:"America/Los_Angeles", lsrc:"city", bloc:true}` | `{lat:40.7, lon:-74, lsrc:"manual", city:"Brooklyn Heights", tz:"America/New_York"}` |
| index.html, face-card + pick-card hrefs after Save | still `…?lat=40.7&lon=-74.0` (the next page prompts again — B7) | clean (`all.html`, `pick.html`) |
| pick.html `#pick-home-link` after Save | — | `?lat&lon&picks` → `index.html` |

Observatory and Inspector adopt to the same blob as Terra. Every one of the four
does it with **no extra DB parse** (one `[CitySearch] Loaded` + one `Released`
for the whole visit) — the hook writes the name and zone already in memory. The
reload after Save (clean URL, as the fixed links now produce) shows no prompt,
"Brooklyn Heights", America/New_York, and **zero** parses, since the stored city
and tz make the DB unnecessary.

Both §6 orderings converge: Saving *before* the parse (clicked at +112 ms, zero
parses done; the parse landed at +247 ms) reaches the same blob as Saving after
it, still with one parse and one release — early, the hook's guards simply pass
the work to the in-flight reverse-geocode and the still-armed tz backstop.

**Review pass (single agent) and what changed:** one finding, fixed —
`initAppState`'s equal-to-stored branch cleaned the URL *before* assigning the
LocalStorage backend, and cleaning now re-syncs the navigation links, whose
selected-faces/pick routing reads `getState().picks`. With no backend assigned
yet, `backend()` lazily made a UrlBackend and read picks from the params being
deleted, so a bookmark of one's own `?picks=…` default briefly routed "Pick
Faces" instead of "Selected Faces". Backend assigned first; verified in the pane
(pick card → `selected.html`, titled "Selected Faces", URL cleaned, no prompt).
Also checked: the `arc` radius errors the Observatory logs under the browser
pane's 0×0 viewport are identical on HEAD — a pane artifact, not this change.

## 15. Done

All seven steps are implemented and all twelve defects (§2) are fixed:

- **Report 1** — a `?lat&lon` link now corrects its own timezone in-session in
  all three apps (and on the faces, not just the footer), stores nothing it only
  guessed, and adopts as a whole location: New York coordinates no longer keep
  Cupertino's name, Pacific time, or follow-the-device. The links out of the page
  are cleaned at the same moment, so the next page does not ask again.
- **Report 2** — driving to another city relabels Terra's ring sector and Gaia's
  local subdial on the next frame instead of at the next reload, in session-only
  mode as well as persistent, with one database parse and one release.

`tsc --noEmit` clean; 51 test files / 8767 tests green. Steps 1–3 are in
d1f4c4b; steps 4–7 are in the working tree, unreviewed by Steve and uncommitted.

Deliberately left undone (§5 "Not planned"): the **time group** has the same
merge hazard as the location group — adopting a `?t=` link over a stored `off`
leaves both, and the apps read `off` first. It is a one-line extension of the
group rule in `urlScalarOverrides()` if it ever bites.
