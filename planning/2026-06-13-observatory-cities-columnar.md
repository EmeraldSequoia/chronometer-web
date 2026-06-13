# Observatory memory: compact the cities DB (columnar form)

Plan for **item 2** of [2026-06-12-observatory-memory.md](2026-06-12-observatory-memory.md).
Item 5 (reuse per-frame `dayMaskCanvas`) is already done.

Status: **IMPLEMENTED (2026-06-13).** See "Outcome" at the end.

## Goal

Stop materializing the cities database as ~167k live JS arrays + ~425k small
string objects. Keep the same data, restructured so the heap cost drops from
**~45 MB → ~13 MB** (~32 MB saved), without slowing — ideally speeding —
`findClosestCity` and `searchCities`.

This is the single largest memory win in the parent doc. It combines well with
item 1 (lazy-load), but is independent: lazy-load helps sessions that never
search; this caps the cost for sessions that do.

## Why the current form costs 45 MB

`src/cities-data.js` (19 MB at rest) is one `JSON.parse('...')` of a single
string. The string is cheap; `JSON.parse` is what explodes it:

| Contributor | Approx heap |
|---|---|
| 167,617 city arrays (8–10 elems each), ~32–130 B/array header+slots | ~15–22 MB |
| ~425k small strings (name/ascii/alt/admin2), ~16 B header each | ~7 MB |
| ~8.7 M chars of actual text (V8 stores ASCII as 1 byte/char) | ~8.7 MB |
| airports (21,080 arrays) + lookup tables | ~3–5 MB |

It's **per-object header overhead**, not char data. Eliminating the 167k array
objects and the ~425k string objects is the whole game.

### Measured composition (2026-06-12, current data)

- CITIES: 167,617 rows. AIRPORTS: 21,080. TZ: 406, CC: 248, AD: 3,705.
- name chars: 1.65 M · ascii chars: 1.65 M
- **alt-name chars: 5.39 M (62% of text), across 88,539 rows** — match-only,
  never displayed.
- rows needing admin2: 3,171 (sparse).

## The constraint that picks the design

`findClosestCity(lat, lon)` is called in ~12 places (incl. the load path, to
reverse-geocode coords → city name for the location bar) and **scans every
city's lat/lon on each call**. A pure newline-string-scan form would force
reparsing 167k lines per nearest-city lookup. So lat/lon (and the other numeric
fields) must live in random-access typed arrays. Once we have those, the rest
follows the columnar pattern, with the alt-names column handled by string-scan
(where that technique actually pays).

## Target runtime data structure (`city-search.ts`)

Replace `CITIES: any[][]` / `AIRPORTS: any[][]` with parallel columns. All
arrays are indexed by row `i`, rows stay sorted by population descending (as
today).

```ts
// Cities — N = 167,617
let N = 0;
let cLat: Int32Array;    // round(deg * 1000); decode deg = v / 1000  (EXACT match to current rounding)
let cLon: Int32Array;    // round(deg * 1000)
let cPop: Uint32Array;
let cTz:  Uint16Array;   // index into TZ  (406 → needs 16-bit)
let cCc:  Uint16Array;   // index into CC  (248; use 16-bit for headroom, +167 KB only)
let cAd1: Uint16Array;   // index into AD  (3,705 → needs 16-bit)

// Concatenated text + offset index (offsets built at load, not shipped)
let names: string;  let nameOff: Uint32Array;  // original UTF-8 names (display) — two-byte string
let ascii: string;  let asciiOff: Uint32Array; // ASCII-folded names (search) — one-byte string
let alts:  string;  let altOff:  Uint32Array;  // per-row comma-joined alt blobs (search) — one-byte string

let ad2: Map<number, string>;  // sparse: rowIdx → county name (3,171 entries)

// Airports — columnar too (minor contributor, but removes 21k array headers)
let aN = 0;
let aIata: string;  let aIataOff: Uint32Array;
let aCity: string;  let aCityOff: Uint32Array;
let aLat: Int32Array; let aLon: Int32Array;
let aTz: Uint16Array; let aCc: Uint16Array;

let TZ: string[]; let CC: string[]; let AD: string[];  // small lookup tables, unchanged
```

### Offset scheme

Concatenated strings join rows with `'\n'`. Row `i`'s text is
`str.slice(off[i], off[i+1] - 1)` (the `-1` drops the trailing delimiter);
`off` is `Uint32Array(rows + 1)` with `off[0] = 0` and `off[rows] = str.length + 1`.
Empty rows (no alts) are zero-length spans — naturally handled.

Offsets are **not shipped**; they're rebuilt once at load by a single scan for
`'\n'` (`buildOffsets(str)` → Uint32Array). Saves ~6 MB of download and is a
few ms over ~10 M chars.

### Projected steady-state heap

V8 stores a string as one byte/char **only if every char is Latin1** (≤ 0xFF);
a single char above that makes the whole string two-byte. Measured non-Latin1
content (2026-06-13): ascii 0.0% (1-byte), names 1.2% (forces 2-byte, but it's
display data — unavoidable), **alts 38.9% of chars / 74.8% of alt-bearing rows
(forces 2-byte)**. So the alt column is ~10.8 MB, not ~5.4 MB.

| Column | Size |
|---|---|
| cLat/cLon/cPop (Int32×2 + Uint32) | ~2.0 MB |
| cTz/cCc/cAd1 (Uint16×3) | ~1.0 MB |
| ascii string (one-byte) + asciiOff | ~2.3 MB |
| names string (two-byte, 1.2% unicode) + nameOff | ~4.0 MB |
| **alts string (two-byte, 38.9% unicode) + altOff** | **~11.5 MB** |
| ad2 map (3,171) + airports columns | ~1.5 MB |
| **Total** | **~22 MB** |

~22 MB vs ~45 MB today (~23 MB saved); Observatory steady-state ~90 → ~67 MB.
The two-byte `alts` blob is the floor. Rejected micro-optimizations: splitting
alts into Latin1/non-Latin1 sub-blobs (~2 MB saved, not worth per-row
bookkeeping); UTF-8 `Uint8Array` for alts (~9.6 MB, not worth byte-compare
complexity). See "Optional follow-ups" for offloading/trimming alts entirely.

### Non-ASCII alt names — preserved, no special handling

`toASCII()` strips diacritic combining marks but does **not** transliterate
scripts, so native-script names ("東京", "Пекин") are stored verbatim in the alt
column today and matched when the user types native script (`toASCII(query)`
preserves those chars). The `indexOf`/`startsWithAt` scan uses `charCodeAt`,
which works identically on two-byte strings, so this capability is unchanged.
The build-time original-name fold likewise appends `toASCII(name)` even when it's
non-Latin — still matchable, no special case. The only consequence of non-ASCII
alts is the two-byte heap cost above.

## On-disk format (`cities-data.js`, generated)

Keep the `JSON.parse('...')` wrapper — the iOS-Safari stack overflow was caused
by large **array literals**, not by JSON.parse of an object whose values are a
few big strings + small arrays. New parsed shape:

```js
{
  v: 2,                         // format version
  N, aN,
  TZ: [...], CC: [...], AD: [...],   // small arrays, as today
  ad2: { "<rowIdx>": "County", ... }, // sparse object, 3,171 entries
  // numeric columns as base64 of the raw little-endian buffers:
  cLat: "<b64>", cLon: "<b64>", cPop: "<b64>",
  cTz: "<b64>",  cCc: "<b64>",  cAd1: "<b64>",
  aLat: "<b64>", aLon: "<b64>", aTz: "<b64>", aCc: "<b64>",
  // concatenated text as plain JSON string values:
  names: "...\n...", ascii: "...\n...", alts: "...\n...",
  aIata: "...\n...", aCity: "...\n...",
}
```

base64 buffers are atob'd into a fresh `Uint8Array` (buffer offset 0) so
typed-array views are correctly aligned.

#### Endianness

The file is **always written little-endian**. The decode does a one-time runtime
endianness check and byte-swaps in place **only on a big-endian platform**, so
the common path stays a zero-copy `new Int32Array(buf)`:

```js
const IS_LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
function swapInPlace(bytes, width) {   // never runs on LE hardware
  for (let i = 0; i < bytes.length; i += width)
    for (let j = 0; j < width >> 1; j++) {
      const t = bytes[i + j];
      bytes[i + j] = bytes[i + width - 1 - j];
      bytes[i + width - 1 - j] = t;
    }
}
```

In practice it never executes: OS/2 and ArcaOS are x86-only (LE), and every ARM
browser (Android/iOS) runs LE. Costs nothing on the common path; correct if a BE
browser ever appears. Only the binary numeric columns need this — the JSON
string columns (`names`/`ascii`/`alts`) are endianness-independent text.

Estimated file size ~13–15 MB (down from 19 MB — we drop the array-literal
quoting/punctuation). Gzips comparably or slightly better.

## Search algorithm changes

### `loadCityData()` — decode once

After `JSON.parse`, the data object holds strings + base64. Decode:
- `b64ToBuf(s)`: `atob` → `Uint8Array(len)` → return `.buffer`. Wrap in the
  right typed-array view (`new Int32Array(buf)`, etc.).
- `names/ascii/alts` taken as-is; build `nameOff/asciiOff/altOff` via
  `buildOffsets`.
- `ad2 = new Map(Object.entries(raw.ad2).map(([k,v]) => [+k, v]))`.
- Same for airports.

Keep the existing `<script>`-tag load + `_chronCitiesCallback` mechanism and
the `window.ChronometerCities` pre-bundle check (unchanged transport; only the
shape inside changes).

### `startsWithAt(haystack, start, needle)` helper (no allocation)

```ts
function startsWithAt(h: string, start: number, q: string): boolean {
  for (let k = 0; k < q.length; k++)
    if (h.charCodeAt(start + k) !== q.charCodeAt(k)) return false;
  return true;
}
```
Safe across row boundaries: the `'\n'` delimiter never appears in a query, so a
needle longer than the row mismatches at the delimiter. No substring allocated.

### `searchCities(query, limit)`

1. **Airports** — unchanged logic, reading `aIata`/`aCity` via offsets.
2. **Cities, ascii prefix** — for each row `i`: `startsWithAt(ascii, asciiOff[i], q)`.
   Match → priority 0 (exact, when row length === q length) or 1. Record matched
   rows in a `Set` so the alt pass doesn't double-add.
3. **Cities, alt-name match** — global scan of the `alts` string instead of
   per-row work:
   ```ts
   let pos = alts.indexOf(q);
   while (pos >= 0) {
     const prev = pos === 0 ? 10 : alts.charCodeAt(pos - 1); // 10 = '\n'
     if (prev === 10 || prev === 44 /* ',' */) {             // prefix boundary
       const row = rowOfOffset(altOff, pos);                 // binary search
       if (!matchedSet.has(row)) { add row, priority 3 }
     }
     pos = alts.indexOf(q, pos + 1);
   }
   ```
4. **Label building** — original name slice (`names`/`nameOff`) + `ad2` (if row
   present) + `AD[cAd1[i]]` + `CC[cCc[i]]`; timezone `TZ[cTz[i]]`.
5. Sort by (priority asc, pop desc); slice to `limit`. (pop read from `cPop[i]`.)

#### Behavior delta to review: the "original UTF-8 name" branch

Today's per-row branch 2 also matches `toASCII(originalName)` /
`name.toLowerCase()` when it differs from the stored `asciiname`. Replicating
this at runtime would mean slicing+folding the original name for ~167k
non-matching rows per keystroke — too slow.

**Proposed:** fold it in at **build time** — when `toASCII(name) !== asciiname`,
append `toASCII(name)` to that row's alt blob. Runtime then needs only the ascii
prefix pass + alt scan; recall is preserved. The only delta is ranking: such a
match surfaces at alt priority (3) rather than the old name priority (2). This
shifts ordering only among same-population ties for a small set of non-ASCII
edge cases. **Flagged for review; the parity script (below) will enumerate every
actual diff so we can accept or refine.**

### `findClosestCity(lat, lon)`

Loop `i` over `0..N`, read `cLat[i]/1000`, `cLon[i]/1000` from Int32Arrays
(faster than today's object property access). Same equirectangular metric. Build
label from columns as above. Returns the same shape incl. `distanceDeg`.

## Build script changes (`scripts/build-cities.js`, phase 9 rewrite)

Phases 1–8 (parse, dedupe, IATA, lookup tables, sort by pop) are unchanged.
Replace the output phase:

1. Build parallel JS arrays from the sorted `cities` / `airports`.
2. Apply the original-name fold: for each city, if `toASCII(name) !== asciiname`,
   append the folded form to its alt list.
3. **Validate** no `name`/`ascii`/`alt`/`iata`/`displayCity` field contains
   `'\n'` (skip-with-warning or sanitize; GeoNames names don't contain
   newlines, but assert it).
4. Encode numeric columns: build the typed arrays, then
   `Buffer.from(arr.buffer).toString('base64')`. (lat/lon as
   `round(deg * 1000)` Int32 — exact, matches current rounding.)
5. Concatenate text columns with `'\n'`.
6. Emit `ad2` sparse object keyed by sorted row index.
7. Write the `JSON.parse('...')` wrapper with the v2 shape; keep the
   `_chronCitiesCallback` invocation.
8. Keep the header comment block documenting the v2 layout.

## Files touched

| File | Change |
|---|---|
| `scripts/build-cities.js` | Rewrite output phase (above). |
| `src/cities-data.js` | Regenerated (v2 shape). |
| `src/cities-data.d.ts` | New declaration for `window.ChronometerCities` v2. |
| `src/shared/city-search.ts` | Rewrite `loadCityData`/`searchCities`/`findClosestCity` + helpers. |
| `docs/location-and-cities.md` | Update data-pipeline + format sections. |

No change to: the `<script>`-tag transport, `build.sh` (still copies the single
file), callers of `searchCities`/`findClosestCity`/`loadCityData` (same exported
signatures and `CityResult` shape).

## Testing & verification

1. **Parity script** (the real guard — see below): old vs new `searchCities`
   and `findClosestCity` produce identical results.
2. **Full suite** `npm test` (8494 tests). Note: these are render regression
   tests; grep shows no test imports `city-search`, so they won't catch search
   regressions — hence the parity script. Consider adding a small `city-search`
   unit test as part of this work.
3. **Heap re-measure** in the dist build (per the parent doc's methodology:
   `performance.memory.usedJSHeapSize`, ~8 s after load). Expect steady state
   ~90 MB → ~58 MB. Confirm canvas numbers unchanged.
4. **Manual smoke** in the dist build: open the location dialog, search
   ("San", "München", "Peking", "SFO", "東京"), pick a city, confirm the
   location bar reverse-geocodes correctly.

### Parity script details

A throwaway Node script that:
- Loads the **old** `cities-data.js` (from git: `git show HEAD:src/cities-data.js`)
  and the **new** one.
- Reimplements/imports both `searchCities` variants (old object form vs new
  columnar) in Node.
- Runs a battery of ~300 queries: top-population city prefixes, 2–3 char
  prefixes, diacritic names, known alt-name cases (Peking→Beijing,
  München→Munich), IATA codes, mixed case.
- Asserts identical **result sets** (lat/lon/label); diffs **ordering**
  separately and prints the (expected, bounded) ranking deltas from the
  original-name fold.
- Runs `findClosestCity` over a global lat/lon grid (e.g. 5° spacing) and
  asserts identical city selection.

## Risks & mitigations

- **Endianness** — file is always LE; runtime check + in-place byte-swap on the
  (effectively nonexistent) BE platform. Zero-copy fast path on LE.
- **Delimiter collision** — validated at build; `'\n'` never in names.
- **Float/precision** — lat/lon stored as scaled Int32 (exact to current
  3-decimal rounding), not Float32. No drift.
- **Ranking deltas** (original-name fold) — enumerated and reviewed via parity
  script; recall unchanged.
- **iOS Safari** — no large array literals; JSON.parse of strings+base64 only.
- **Search-path coverage gap** — parity script + new unit test compensate for
  the absent automated coverage.

## Out of scope (optional follow-ups)

- **Trim/offload alt-names** (the 6 MB floor). The parent doc notes alt
  transliterations could live in a separate lazily-fetched blob or be trimmed at
  build time. Could drop steady state further (~17 → ~11 MB) but changes recall
  and adds a second fetch. Defer.
- **Item 1 (lazy-load) interplay** — orthogonal; can land before or after.

## Rollout

Single PR. Sequence: build-script rewrite → regenerate `cities-data.js` →
city-search rewrite → parity script green → docs → heap re-measure.

## Outcome (2026-06-13)

Implemented as planned, with two notable findings during execution:

1. **Fold-fix.** The first regen missed 12 cities (e.g. Stöckheim, Bürstadt)
   because GeoNames `asciiname` uses ae/oe/ue expansion ("stoeckheim"), so the
   folded name ("stockheim") shared the first 3 chars with `asciiname` and was
   dropped by the prefix3 alt filter — and re-blocked by the `seen` set. Fixed
   by having the original-name fold bypass both the prefix3 filter and `seen`,
   deduping only against the output list. Folds went 1,135 → 3,936.
2. **Raw-payload release.** After `ingest`, `city-search.ts` nulls
   `window.ChronometerCities` to free the now-redundant base64 blobs (~4 MB);
   the decoded typed arrays and text columns survive via module references.

**Parity** (`scripts/parity-cities.mjs`, 9,981 queries, unlimited limit):
0 `searchCities` set mismatches, 0 `findClosestCity` mismatches over a global
grid. 412 order-only deltas — the accepted priority 2→3 shift for the
original-name fold (reviewed: at the real limit of 20 it reorders ~0.3% of
queries near rank 20, always obscure <15k-pop towns, often *improving* results
by surfacing higher-population cities; full result set unchanged).

**Sizes/heap:** `cities-data.js` 19.2 → 17.0 MB. Browser `usedJSHeapSize`
(observatory, DPR-2 mobile) dropped from the ~65 MB baseline to ~43–52 MB after
GC (the deterministic column byte-counts sum to ~22 MB resident vs the old
~45 MB). `performance.memory` is noisy without forced GC; the column math is the
rigorous figure.

**Tests:** full suite 8,503 pass (8,494 + 9 new `city-search.test.ts`).
Verified in-browser: v2 decodes in-engine, ASCII/IATA/alt/fold search and
reverse-geocode all work; earth view + dials render unchanged.

**Files:** `scripts/build-cities.js`, `src/cities-data.js` (regenerated),
`src/cities-data.d.ts`, `src/shared/city-search.ts`, `docs/location-and-cities.md`,
`src/__tests__/city-search.test.ts`, `scripts/parity-cities.mjs` (migration tool).
