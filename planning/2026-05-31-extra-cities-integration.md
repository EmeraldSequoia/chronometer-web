# Extra Cities Integration into Cities Database

**Status**: COMPLETE (2026-07-25) — build script changes applied, database regenerated
with Dolphin Island + Emerald Hills, dist rebuilt, verified end-to-end (payload diff,
real search engine, live Observatory location picker).  
**Created**: 2026-05-31  
**Last Updated**: 2026-07-25  

## Goal

Allow users to define custom cities in `src/extra-cities.ts` that get merged into the compiled GeoNames cities database (`src/cities-data.js`) when `node scripts/build-cities.js` is run.

## Current State

All steps below are DONE (2026-07-25):

1. **`src/extra-cities.ts`** — valid TypeScript:
   - Exports `ExtraCity` type (with optional `admin1Name`/`admin2Name`) and `extraCities` array
   - Contains two entries: "Dolphin Island" (Fiji) and "Emerald Hills" (California) — see City Entries below

2. **`scripts/build-cities.js`** — extra-cities integration applied:
   - Add `existsSync`, `unlinkSync` to the `fs` import
   - Add `import esbuild from 'esbuild';`
   - Add an early check that `src/extra-cities.ts` exists, failing with a clear error if not
   - Add an early check that all required GeoNames raw data files exist in `scripts/geonames-data/`, failing with a clear error listing missing files
   - Add a "Phase 2b: Extra Cities" section after Phase 2 (cities parsing) and before Phase 3 (duplicate detection) that:
     - Transpiles `src/extra-cities.ts` → `scripts/extra-cities-temp.js` using `esbuild.buildSync` (`format: 'esm'`)
     - Dynamically imports the transpiled module (via a `file://` URL)
     - Validates each entry (see Validation below), failing the build with a clear message on the first bad entry
     - Maps each `ExtraCity` to the internal city record format
     - Appends them to the `cities` array
     - Cleans up the temp file (in a `finally`, so it's removed even when validation fails)

3. **`.gitignore`** — `scripts/extra-cities-temp.js` added

4. **`src/cities-data.js` regenerated** — `node scripts/build-cities.js` run 2026-07-25: 167,617 GeoNames cities + 2 extras = 167,619 rows

5. **dist rebuilt** — `bash build.sh` run 2026-07-25; this copies `src/cities-data.js` into `dist/` and re-derives `dist/cities-data.json.gz` via `scripts/make-cities-gz.mjs` (the payload the http(s) fetch path uses), so no extra step is needed

## Design Decisions (Agreed Upon)

- `build.sh` is **not modified**. It always uses the current `src/cities-data.js` as-is.
- `scripts/build-cities.js` is the only place where the cities database is regenerated.
- The script **must fail** if `src/extra-cities.ts` is missing.
- The script **must fail** if the raw GeoNames data files are missing (no silent fallback).
- No "in-place editing" of the pre-compiled `cities-data.js`. Anyone regenerating the database needs the raw GeoNames files in `scripts/geonames-data/`.

## Required GeoNames Raw Data Files

Location: `scripts/geonames-data/` (all present as of 2026-07-25)

| File | Size | Purpose |
|------|------|---------|
| `cities1000.txt` | ~29 MB | Main city data (130K+ cities with pop > 1000) |
| `admin1CodesASCII.txt` | ~151 KB | State/province name lookup |
| `admin2Codes.txt` | ~2.3 MB | County/district name lookup (disambiguation) |
| `alternateNamesV2.txt` | ~766 MB | IATA airport codes and alternate city names |
| `allCountries.txt` | ~1.7 GB | Airport coordinates (for airports not in cities1000) |

These files are gitignored. Download from [GeoNames](https://download.geonames.org/export/dump/) if missing.

## `ExtraCity` Interface

```typescript
export type ExtraCity = {
    name: string;
    latitude: number;
    longitude: number;
    olsonTimezone: string;
    countryCode: string;    // ISO 3166 two-letter code, uppercase
    admin1Name?: string;    // state/province display name, e.g. "California" (default '')
    admin2Name?: string;    // county/district display name, e.g. "San Mateo County" (default '')
    population: number;
}
```

**Note on `population`**: it does double duty — it is the ranking key in search
results *and* the selection key for the map-drag pick (`findLargestCityNear`
returns the most populous city within the radius). A tiny value (e.g. Dolphin
Island's 10) means the entry is findable by typed search but will essentially
never win the map-drag pick.

## City Entries

| Name | Latitude | Longitude | Timezone | CC | Admin1 | Admin2 | Population |
|------|----------|-----------|----------|----|--------|--------|------------|
| Dolphin Island | -17.3053513 | 178.2253116 | Pacific/Fiji | FJ | — | — | 10 |
| Emerald Hills | 37.46082428240359 | -122.26997850548051 | America/Los_Angeles | US | California | San Mateo County | 2139 |

Emerald Hills' admin/state/country/timezone are copied from the GeoNames entry
for "Emerald Lake Hills", California (geonameid 5346413, admin1 `US.CA`,
admin2 `US.CA.081` = San Mateo County). Its population 2139 is half of Emerald
Lake Hills' 4278. Dolphin Island's population of 10 is intentional (search-only
visibility; see population note above).

## Validation (in Phase 2b)

Each entry is checked at build time; the script fails with a clear message on
the first violation:

- `name`: non-empty, no newline (the columnar packer's delimiter)
- `latitude` ∈ [-90, 90], `longitude` ∈ [-180, 180]
- `olsonTimezone`: must be accepted by `new Intl.DateTimeFormat('en-US', { timeZone })` (throws on unknown zones)
- `countryCode`: matches `/^[A-Z]{2}$/`
- `admin1Name`/`admin2Name` (if present): no newline
- `population`: finite non-negative integer

## Mapping ExtraCity → Internal City Record

Each `ExtraCity` maps to the internal `city` object used by `build-cities.js`:

```javascript
{
    geonameid: `extra-${toASCII(name)}-${lat}-${lon}`,
    name,
    asciiname: toASCII(name),
    alternatenames: '',
    lat: Math.round(latitude * 1000) / 1000,
    lon: Math.round(longitude * 1000) / 1000,
    countryCode,
    admin1Name: admin1Name ?? '',
    admin2Name: admin2Name ?? '',
    population,
    timezone: olsonTimezone,
}
```

(`geonameid` is build-internal only — it's used for IATA joins and never
emitted into the v2 columnar output, so the synthetic id is harmless.)

## Verification (after regeneration)

`scripts/parity-cities.mjs` is a dead gate for this change (it compares v1-at-
git-HEAD vs v2-on-disk; HEAD is already v2). Instead, verify with a throwaway
script (in the session scratchpad, never touching `scripts/geonames-data/`):

- new `N` = old `N` + 2
- all non-extra rows identical between old and new payloads
- search "Dolphin" returns Dolphin Island; search "Emerald Hills" returns the
  new entry (ranked below Emerald Lake Hills' 4278 where both match)
- a spot-check search (e.g. "san francisco") returns identical results
- `npm test` still passes (city-search tests)

## Key Files

| File | Role |
|------|------|
| `src/extra-cities.ts` | User-defined custom cities (TypeScript, checked in) |
| `scripts/build-cities.js` | GeoNames → `cities-data.js` build script (needs modification) |
| `src/cities-data.js` | Compiled cities database (checked in, ~6-8 MB) |
| `src/cities-data.d.ts` | TypeScript declarations for the database |
| `src/shared/city-search.ts` | Runtime search engine that consumes the database |
| `build.sh` | Main build script (copies `cities-data.js` to `dist/`, NOT modified) |

## Warnings

> [!CAUTION]
> A previous session's test script accidentally deleted the `scripts/geonames-data/` directory via `rm -rf`. Any future test scripts must use uniquely-named temporary directories, never the production data path.
