# Cities DB — lazy load & lazy parse

Status: **IMPLEMENTED (2026-06-15).** See "Outcome" at the end.

The third and largest remaining lever from
[planning/2026-06-12-observatory-memory.md](2026-06-12-observatory-memory.md)
(item 1, extended). Builds on two things already done:

- **Columnar v2** ([2026-06-13-observatory-cities-columnar.md](2026-06-13-observatory-cities-columnar.md)):
  the parsed DB is now ~22 MB resident instead of ~45 MB.
- **LocalStorage state model** ([2026-06-13-localstorage-state-and-sharing.md](2026-06-13-localstorage-state-and-sharing.md)):
  `getState()` now returns a *persisted* `city` name, so the location display
  can render **without** the cities DB in the common case. This is the
  precondition that makes lazy-load actually viable.

## Goal

Stop eagerly downloading + parsing the 17 MB cities DB on every startup. Touch
it only when genuinely needed, and minimize its resident footprint between uses.
Targets two costs:

- **Memory:** ~22 MB parsed form (and a ~17 MB transient parse spike) that today
  every non-embed session pays whether or not it ever searches.
- **Network latency / flakiness:** 17 MB is a long transfer on a slow/flaky
  link; today it competes with first render even when unused.

## Current behavior (verified 2026-06-14)

The DB is **eagerly loaded + parsed on every non-embed startup**, in two places:

- `engine-entry.ts:274` — `loadCityData().then(...)` to reverse-geocode the
  footer and backfill Terra/Gaia slot city names.
- `location-dialog.ts:222` — `initLocationDialog()` (run at startup by all three
  apps' `setupLocationDialog`) calls `loadCityData().catch(() => {})`
  ("Preload city database in the background").
- Observatory reaches it transitively through `initLocationDialog`; the eager
  `engine-entry.ts:274` block is Chronometer-only.

`loadCityData()` (in `city-search.ts`) still downloads via a `<script>` tag that
**downloads and parses together** — there is no way to prefetch without parsing.

### Who actually needs the DB

| Consumer | Needs DB? | Notes |
|---|---|---|
| Footer location name when `getState().city` is set | **No** | `observatory-entry.ts:457-459`, `location-dialog.ts:227` use the stored city; DB untouched. **This is the common case now.** |
| Footer name when coords but no stored city | Yes (`findClosestCity`) | fresh manual entry, or a `bloc` fix with no persisted city |
| Location dialog search (typeahead) | Yes (`searchCities`) | only when the user opens the dialog |
| Terra/Gaia observer-slot name (`engine-entry.ts:277-294`) | Only when unnamed | Chronometer-only; *same* answer as the footer reverse-geocode. With a stored `city` it's free; see dedicated section. |
| Embed mode | No | already skipped |

So after the state-model work, the *display* path needs the DB only when we hold
coordinates without a name. Search always needs it but only on explicit open.

## Blocker to confirm first: `bloc` does not persist its fix

The localStorage plan states `bloc:true` is now stored **alongside** the
last-known `lat/lon/city`. The code does **not** do this:

- `observatory-entry.ts:491` and `engine-entry.ts:2024` write
  `{ bloc:true, lat:null, lon:null, city:null }` on the browser-location path.
- The successful startup fix (`observatory-entry.ts:545-564`) updates in-memory
  `lat/lon` and the display but never calls `setState` to persist them.

Consequence: a `bloc=1` reload has no seed → 0,0 flash returns **and** a
reverse-geocode (DB load) is forced on every geolocation startup. The lazy-load
win for the `bloc` case depends on this seed existing.

**Decision (resolved 2026-06-14): persist the seed.** Store the last-known
`lat/lon/city/(tz)` alongside `bloc:true` — both on the browser-location
`onLocationChange` path (`observatory-entry.ts:491`, `engine-entry.ts:2024`) and
on the successful startup fix (`observatory-entry.ts:545-564`, and the
`engine-entry.ts:338-363` bloc branch). This fixes the 0,0 flash and is the
precondition for skipping the DB on geolocation reloads. Implement first.

## Design

The core design is a **single integrated mechanism**, not separable layers:
**prefetch the DB early in the background → keep only the ~7.5 MB compressed blob
resident → decompress + parse on demand (no network wait).** On top of that, the
state model lets us **skip parsing entirely** when a stored `city` already
answers the question.

> **Why prefetch is not optional.** Today's eager `loadCityData()` is, in effect,
> an unmanaged prefetch — it's why tapping "Location" is instant. Removing it for
> the memory win *without* a background prefetch would regress the on-tap path:
> on a flaky link the user would wait for the full 17 MB download the moment they
> open the dialog. So the prefetch + resident compressed blob is what *preserves*
> the "we need it" path while we optimize the "we never need it" path.

### 1. Make loading lazy (parse on demand)

Remove the two eager `loadCityData()` calls. Load on demand at the points that
need it:

- **Dialog open** — `locationDialog.show()` (or first keystroke) triggers
  `loadCityData()` before `searchCities`. The dialog already has an
  `if (!isCityDataLoaded()) await loadCityData()` guard in the search handlers
  (`location-dialog.ts:507-512`, `engine-entry.ts:2148`), so search already works
  without the eager preload — removing the preload mostly just defers it.
- **Reverse-geocode needed (non-embed only)** — when we have coords but no stored
  `city` (manual entry; `bloc` fix beyond the reuse threshold), call
  `loadCityData()` then `findClosestCity`, render, and **persist the derived
  `city`** via `setState` so subsequent loads skip the DB entirely. Gated by
  `!isEmbedMode` — embed never reverse-geocodes (see "Embed mode").
- **Terra/Gaia observer-slot name** (Chronometer) — see the dedicated section
  below. Resolved approach: the observer slot's name is the *same answer* as the
  footer reverse-geocode, so it consumes the shared resolved `city`; no
  independent DB access, and the eager "backfill" pass is removed.

Net: the common bookmark/stored-city session loads the DB **never**; geolocation
and manual-entry sessions load it once and then persist the name.

### Terra/Gaia observer-slot naming (how the committed code works)

The observer's own location appears as a slot: a **ring slot** for Terra
(`globalLocationSlot`) and **subdial slot 1** for Gaia. Naming happens in two
passes:

- **Pass 1 — `buildSlotOverrides()`** (`engine-entry.ts:508`, runs at startup and
  on every location change). Observer-name priority:
  1. `locationSource` (the stored/URL city) — **no DB**;
  2. else **only if `isCityDataLoaded()` already** → `findClosestCity` (never
     triggers a load itself);
  3. else fallback — **Terra:** `olsonIdToCityName(tz)` (e.g. "Los Angeles",
     `:573`); **Gaia:** the literal placeholder `'Observer'` (`:599`).
- **Pass 2 — the eager "backfill"** (`engine-entry.ts:274-295`) runs *after* the
  async `loadCityData()` resolves and re-resolves the observer slot **only when**
  `!locationSource` and lat/lon ≠ 0,0 (Terra: `worldTimeRing` + a
  `globalLocationSlot`; Gaia: slot 1 still `'Observer'`). Action:
  `findClosestCity(lat,lon)` → overwrite the slot's `cityName` with the nearest
  city's `shortLabel`. **Label-only** — the slot's lat/lon/tz/env are already
  correct.

So pass 2 exists *only because* the eager load is async: pass 1 runs before the
DB is ready and falls back, and pass 2 upgrades the fallback once the DB lands.

**Your read is correct:** user-customized slots (`r*`/`d*`) and the observer slot
*when a name exists* come entirely from persisted state (name + tz + lat/lon) and
need no DB. The DB is only the fallback that upgrades an *unnamed* observer
location's label to the nearest city — the **same** lookup the footer needs.
Terra already degrades gracefully without it (shows "Los Angeles"); only Gaia
shows the ugly `'Observer'` placeholder.

**Resolved approach:**
1. **Unify** observer-name resolution: when the observer has no name, do the
   single on-demand reverse-geocode (footer path), set `locationSource`, persist
   `city`, then re-run `buildSlotOverrides()` (already done on location change at
   `:1753`) so Terra and Gaia pick it up. **Delete the pass-2 backfill block.**
2. **Improve Gaia's no-DB fallback** to `olsonIdToCityName(tz)` (matching Terra)
   so an unnamed observer shows "Los Angeles" rather than `'Observer'` before/with
   no reverse-geocode — making lazy-load graceful for Gaia too.
3. No `ec:slots` schema change needed: the observer slot is computed from the
   observer location + the persisted `city`, not stored as a slot override.

### 2. Decouple download from parse, prefetch into a resident compressed blob

Today's `<script>` tag fuses download and parse. The split is **protocol-aware**,
because `file://` cannot use `fetch()` (Chrome blocks `fetch()`/XHR of local
files) — and `file://` doesn't need any of this machinery anyway, since local
reads have no network latency to hide.

**`http(s)` — fetch + compressed blob + prefetch:**
- Ship a **dedicated compressed artifact** the loader fetches as opaque bytes:
  `cities-data.json.gz` (raw gzip of the JSON payload, served **without**
  `Content-Encoding: gzip` so the browser doesn't auto-inflate it). `fetch()` →
  `arrayBuffer()` → keep the ~7.5 MB compressed bytes resident.
- Decompress + parse on demand via `DecompressionStream('gzip')` → JSON string →
  `JSON.parse` → ingest. (Use `gzip`, not brotli — `DecompressionStream` support
  for `gzip` is universal; `br` is not.) This is download-once insurance
  independent of HTTP-cache eviction.
- **Size note:** the gz is **~7.5 MB**, not the ~2–3 MB first estimated. Measured
  floor: text columns 11.6 MB → 5.5 MB gz (diverse city names + native-script
  alts barely compress); v2 base64 numerics → ~1.8 MB. A raw-binary container
  would save only ~0.25 MB (numerics 3.1 MB → 1.6 MB gz), so it's not worth the
  added parse complexity. The real lever to shrink this is trimming/offloading
  the alt-name transliterations (62% of the text) — deferred, see the columnar
  plan's "optional follow-ups". 7.5 MB resident still beats 22 MB parsed, and the
  wire size equals a gzip-transferred `.js`.
- **Prefetch by default**, kicked off at idle / after first render so it doesn't
  contend with startup. **Gate only on `save-data`** — *not* on connection speed:
  a slow-but-not-data-saver link is exactly when hiding the transfer matters most,
  and the blob is only ~7.5 MB, so "wasted if never used" is cheap. If `save-data`
  is set, skip the prefetch and accept the on-tap fetch.

**Embed mode is entirely DB-free** (not a prefetch gate but a whole separate
path): no eager load, no prefetch, and — after this work — **the on-demand
reverse-geocode must also be gated by `!isEmbedMode`** so an embedded face never
pulls the 17 MB DB into an iframe. See the embed section below.

**`file://` — lazy `<script>` injection (unchanged mechanism):**
- Keep the existing `<script src="cities-data.js">` load, but inject it **on
  demand** instead of eagerly. Local reads are instant, so there is no transfer
  to hide and no need for a resident compressed blob or prefetch.
- Parse-then-drop (§3) re-injects the `<script>` when the DB is needed again — a
  fresh element re-executes the IIFE (re-reads the local file + re-parses), which
  is cheap on local disk.

Detect via `window.location.protocol === 'file:'`. This mirrors the existing
protocol-aware split in `app-state.ts` (UrlBackend on `file://`).

Build: `build.sh` emits **both** `cities-data.js` (script form, for `file://`)
and `cities-data.json.gz` (~7.5 MB, for the `http(s)` fetch path). The ~17 MB
`.js` is only loaded under `file://`.

### 3. Parse-then-drop (residency between uses)

- After a one-shot use (reverse-geocode), **drop the parsed form** and keep only
  the resident compressed blob; re-decompress + re-parse if needed again. During
  an open dialog the parsed form stays resident (that's when it's needed); drop
  on close.
- Tradeoff to keep in view: dropping/re-parsing trades a lower steady-state floor
  for re-incurring the ~17 MB parse spike on each use. Acceptable because re-uses
  are user-initiated and infrequent, and the bytes are already resident so there
  is **no network wait** — only CPU. The spike already lands unavoidably on
  dialog open.

## Embed mode (the `embed` URL param)

Embed is a deliberately DB-free path and must stay that way:

- **Today:** only Terra is officially supported in embed (the only face that
  doesn't depend on the user's location). The embed path skips `loadCityData()`
  entirely and the observer name falls back to `olsonIdToCityName(tz)` (e.g.
  "Los Angeles") — no cities DB.
- **Invariant for this work:** embed loads no DB at any point — no eager load, no
  prefetch, **and the new on-demand reverse-geocode is gated by `!isEmbedMode`.**
  The observer name in embed is `city` (if the embedder supplied it) else
  `olsonIdToCityName(tz)`. (This is the same graceful no-DB fallback we're adding
  to Gaia, so it composes for free.)
- **Future:** if embed is extended to other faces, the embedding page will be
  **required to pass `lat`/`lon`** as URL params (embed has no geolocation/prompt
  flow). If the embedder also wants a precise place name it passes `city=`;
  otherwise the face shows the Olson name. Either way, **no DB in an iframe.**

## Privacy / precision (resolved)

Stored coordinates live in localStorage — never in history, sync, or server logs
— so **no precision restriction is needed**; keep full precision for accuracy.
The only coords-in-URL surface is the explicit **Share** link (consented), and
the OSM `Referer` leak is already closed by `referrerpolicy="origin"`.

## Decisions (resolved 2026-06-14)

1. **`bloc` seed:** ✅ persist last-known `lat/lon/city/(tz)` alongside
   `bloc:true`. Implement first; also fixes the 0,0 flash.
2. **Terra/Gaia observer name:** ✅ unify on the shared reverse-geocode + persisted
   `city`; delete the eager backfill pass; improve Gaia's no-DB fallback to
   `olsonIdToCityName`. No `ec:slots` schema change.
3. **Artifact format:** ✅ protocol-aware — `http(s)` fetches a new
   `cities-data.json.gz` (~7.5 MB, held compressed, `DecompressionStream('gzip')`);
   `file://` keeps the lazy `<script>` injection (no `fetch()` on local files,
   and no latency to hide). `build.sh` emits both.
4. **Scope:** ✅ do all of §§1–3 in this pass, including parse-then-drop.

## Risks

- **Removing the eager preload** could surface a latent assumption that the DB is
  loaded by the time some non-dialog code runs (the observer-slot pass-2 relied on
  exactly this). The consumer table + observer-slot section are the audit; each
  remaining need gets an explicit on-demand load or the persisted `city`.
- **Prefetch wastes bandwidth** for sessions that never search — mitigated by the
  `save-data` gate and the ~7.5 MB compressed artifact.
- **Decompression support:** `DecompressionStream('gzip')` is widely available but
  verify on the target cheap-phone browsers; fall back to the `<script>` path
  (also used for `file://`) if absent.
- **Two artifacts in `dist`:** `cities-data.js` (~17 MB, `file://`) and
  `cities-data.json.gz` (~7.5 MB, `http(s)`). Keep them in sync in `build.sh`
  (both derived from the same generated payload).

## Suggested sequencing

1. **`bloc` seed persistence** — small; fixes the 0,0 flash and unblocks the
   `bloc` lazy path.
2. **Unify observer-name resolution** — route the footer + Terra global slot +
   Gaia observer slot through one on-demand reverse-geocode that persists `city`;
   delete the pass-2 backfill; add Gaia's `olsonIdToCityName` fallback.
3. **Protocol-aware loader** — `http(s)` fetch of `cities-data.json.gz` into a
   resident compressed blob + `DecompressionStream` parse on demand;
   `file://` lazy `<script>` injection. `build.sh` emits the `.gz` artifact.
   Prefetch by default, gated on `save-data`/embed. Remove the eager loads.
4. **Parse-then-drop** — drop the parsed form after one-shot uses / on dialog
   close; re-acquire from the blob (http(s)) or by re-injecting the script
   (file://).
5. **Verify** across stored-city, manual-entry, `bloc` (incl. moved-vs-stationary
   reload), dialog-search, `file://`, and embed paths; re-measure heap and on-tap
   latency on a throttled connection.

## Outcome (2026-06-15)

Implemented across all four decisions. Key deviations/notes:

- **Compressed blob is ~7.5 MB, not ~2–3 MB** (the v1 estimate). Floor is the
  text columns (city names + native-script alts) at 5.5 MB gz; the v2 base64
  numerics add ~1.8 MB. A raw-binary container saves only ~0.25 MB — not worth
  it. Trimming alt transliterations is the real lever (deferred). Policy kept as
  "hold always" per review.
- **Loader** (`city-search.ts`): protocol-aware. `http(s)` fetches
  `cities-data.json.gz`, holds it as a resident `Uint8Array`, and
  decompresses + parses on demand via `DecompressionStream('gzip')`; `file://`
  uses on-demand `<script>` injection (no `fetch()` of local files; re-injects
  after release). New `prefetchCityData()` / `releaseCityData()`; little-endian
  byte-swap guard retained for the numeric columns.
- **Build**: `scripts/make-cities-gz.mjs` derives `dist/cities-data.json.gz`
  from `src/cities-data.js` at build time (no second committed artifact); wired
  into `build.sh`.
- **Eager loads removed** (`engine-entry.ts`, `location-dialog.ts`). Prefetch
  fires at startup gated on `navigator.connection.saveData` (and skipped in
  embed). Dialog parses on show; releases on dismiss (parse-then-drop).
- **Observer-slot unification** (`engine-entry.ts`): the eager pass-2 backfill is
  gone; `backfillObserverSlots()` runs after the on-demand reverse-geocode, and
  Gaia's no-DB fallback now uses `olsonIdToCityName` (matching Terra).
- **`bloc` seed**: browser-location writes now persist `lat/lon/(city)/tz`
  alongside `bloc:true` (user edits unconditional; automatic startup-fix /
  background-refresh writes gated on the new `isPersistentMode()` so they neither
  mutate a shared URL nor trip the session re-prompt). Seeded `bloc` reloads show
  the stored location immediately and refresh geolocation quietly, updating only
  past a 16 km move. Implemented in all three apps.
- **app-state**: added `isPersistentMode()` (true under `LocalStorageBackend`).

**Verification:** typecheck clean; full suite 8529 pass; build emits both
artifacts. In-browser (http(s)): Observatory and Terra stored-city reloads fetch
**only** `cities-data.json.gz` (the prefetch blob) and never parse the DB —
footer/slot names come from the stored `city`; opening the dialog parses from the
blob (no network) and search works; dismiss logs "Released parsed city data";
coords-only (Munich) reverse-geocodes on demand and **persists** the derived city.
No console errors. `file://` path is logic-verified (not browser-tested here —
serves http).

**Indicator (2026-06-15):** during a seeded-`bloc` background geolocation
refresh, the location name is tinted yellow (`#e6b800`) and reverts on resolve.
On **failure** (denied/timeout/error), a one-time-per-session dismissible toast
appears — "Could not retrieve location from browser — falling back to last known
location." — because the seed may be stale (the user could have last run the app
months ago elsewhere). Implemented via the shared `showStorageWarning` toast +
a per-app `notifyBlocRefreshFailed()` guard, in all three apps. (Verified via
in-app instrumentation: toast created on denial, auto-dismisses at 12s; the
external preview-eval poller couldn't observe the transient, a tooling quirk.)
Other error paths unchanged: "no location at all" shows the location prompt; a
DB download/parse failure shows "City search unavailable: …" in search results.
A fuller animated "updating…" affordance remains deferred.
