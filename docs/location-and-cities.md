# Location & Cities

The location system provides the observer's position (latitude, longitude, timezone) used by all astronomical calculations. It supports browser geolocation, manual coordinate entry, and city/airport search via a bundled GeoNames database.

## Location Source Priority

When determining the observer's location, the system checks in this order:

1. **URL parameters** — `lat`, `lon`, and optionally `city` and `tz`
2. **Browser geolocation** — if `bloc=1` is in the URL
3. **City search** — user searches by name and selects a city
4. **Manual coordinates** — user enters lat/lon directly
5. **Location prompt** — if none of the above, the location panel opens

**Embed mode** (`embed=1`): Location is hardcoded to (0, 0) and timezone is
detected from the browser's `Intl.DateTimeFormat` API. No geolocation prompt
is shown and the city database is not loaded. See [Embedding](embedding.md).

The resolved city name follows this priority:
1. `locationSource` (from city-picker or URL `city=` param)
2. `findClosestCity()` (once the city database loads)
3. `olsonIdToCityName()` (e.g., "Los Angeles" from "America/Los_Angeles")
4. Fallback: "Local"

## City Search

### Data Source

**GeoNames `cities1000.txt`** — ~130,000 populated places with population > 1,000. License: Creative Commons Attribution 4.0.

Supplementary data:
- `admin1CodesASCII.txt` — state/province names
- `alternateNamesV2.txt` — IATA airport codes and alternate city names

### Data Pipeline (Build-Time)

A Node.js script (`scripts/build-cities.js`) processes GeoNames data into a compact JavaScript module (`src/cities-data.js`):

1. Parse `cities1000.txt` (tab-delimited, 19 columns)
2. Join admin1 names from `admin1CodesASCII.txt`
3. Extract IATA airports from `alternateNamesV2.txt`
4. Include alternate names for search indexing
5. Detect duplicates and add admin2 for disambiguation
6. Build lookup tables (timezone, country, admin1 → numeric index)
7. Sort by population descending
8. Output **columnar** data (format v2, see below)

**Sizes**: Raw ~25 MB → compact JS ~17 MB → gzipped ~2–3 MB.

### Data Format (v2, columnar)

To avoid `JSON.parse` materializing 167k array-of-arrays + ~425k small strings
(~45 MB heap), the data is stored as parallel columns (~22 MB resident). See
[planning/2026-06-13-observatory-cities-columnar.md](../planning/2026-06-13-observatory-cities-columnar.md).

The module assigns `window.ChronometerCities` (one `JSON.parse` of a single
string — no large array literals, to dodge the iOS Safari stack overflow):

- **Numeric columns** (`cLat`, `cLon`, `cPop`, `cTz`, `cCc`, `cAd1`, plus airport
  `aLat`/`aLon`/`aTz`/`aCc`): base64 of raw **little-endian** typed-array bytes.
  `lat`/`lon` are `round(deg * 1000)` as `Int32` (exact to 3 decimals). The
  decoder (`city-search.ts`) byte-swaps only on big-endian hosts.
- **Text columns** (`names`, `ascii`, `alts`, `aIata`, `aCity`): single
  newline-joined strings; row *i* is the slice between newline *i* and *i+1*.
  Offset indices are rebuilt at load by scanning for `\n` (not shipped).
- **`ad2`**: sparse `{ rowIndex: countyName }` for disambiguated cities.

Search reads columns directly: a no-allocation `startsWithAt` for ASCII-name
prefix matching, and a single `indexOf` scan over the concatenated `alts` blob
(with comma/newline boundary checks) for alternate-name matching. The old
"original UTF-8 name" match branch is folded into `alts` at build time.

**Regenerating:** `node scripts/build-cities.js` rebuilds the file from the
GeoNames sources in `scripts/geonames-data/`.

**Validation:** `src/__tests__/city-search.test.ts` covers the decode + search
paths against a synthetic dataset. `scripts/parity-cities.mjs` is the one-shot
v1→v2 migration validator — it compares the columnar search against the previous
array-of-arrays form in git HEAD (no-op once HEAD is already v2).

### Search Implementation

- **Prefix match** on ASCII-folded name (diacritics-insensitive)
- Also matches original UTF-8 name (e.g., "München")
- Also matches alternate names (e.g., "Peking" → Beijing)
- Also matches IATA codes (e.g., "SFO")
- Results sorted: exact prefix first, then by population descending
- Capped at ~20 suggestions

**ASCII folding**:
```typescript
function toASCII(s: string): string {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
```

### Display Format

- City: `City, State, Country`
- City with disambiguation: `City (County), State, Country`
- Airport: `IATA  CityName airport`

## `file://` URL Limitations

When opened via `file://` protocol (double-clicking HTML):

| Feature | Status | Why |
|---------|--------|-----|
| Watch rendering | ✅ Works | No server dependency |
| City/airport search | ✅ Works | Data bundled in JS |
| Manual lat/lon entry | ✅ Works | No server dependency |
| Time controller | ✅ Works | No server dependency |
| **OSM map tiles** | ❌ No detailed map | OSM requires HTTP `Referer` header |
| **Browser geolocation** | ⚠️ May not work | Some browsers restrict to secure contexts |

**Fallbacks**:
- No map → Blue Marble globe shown instead (enlarged to 160px)
- No geolocation → city search or manual coordinates

## Integration with Watch Environment

When a location is set (from any source), the system:
1. Updates `lat`, `lon`, and `timezone` in the URL state
2. Calls `rebuildAllForLocation()` which re-runs `buildSlotOverrides()` for world-time faces
3. Creates fresh `Environment` objects with new lat/lon
4. Resets hand schedules and rebuilds static caches

## Key Source Files

| File | Purpose |
|------|---------|
| `src/city-search.ts` | City/airport search engine |
| `src/cities-data.js` | Bundled city database (generated, tracked in git) |
| `src/cities-data.d.ts` | TypeScript declarations for city data |
| `src/engine-entry.ts` | Location update handling, `rebuildAllForLocation()` |
| `src/url-state.ts` | URL parameter reading/writing for location |
| `src/mini-map.ts` | Blue Marble globe and OSM tile map |
| `src/tz-resolve.ts` | Timezone resolution utilities |
| `scripts/build-cities.js` | GeoNames → JS data pipeline |

## Related Docs

- [World-Time Slots](world-time-slots.md) — How location feeds into Terra/Gaia slot systems
- [Timezone & DST](timezone-and-dst.md) — DST transition detection and timezone offset handling
- [Architecture Overview](architecture-overview.md) — No-backend design constraint
