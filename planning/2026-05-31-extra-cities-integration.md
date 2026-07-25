# Extra Cities Integration into Cities Database

**Status**: Partially complete — syntax errors fixed, build script changes NOT yet applied.  
**Created**: 2026-05-31  
**Last Updated**: 2026-07-25  

## Goal

Allow users to define custom cities in `src/extra-cities.ts` that get merged into the compiled GeoNames cities database (`src/cities-data.js`) when `node scripts/build-cities.js` is run.

## Current State

### What's Done

1. **`src/extra-cities.ts`** — Syntax errors corrected, file is valid TypeScript:
   - Exports `ExtraCity` type and `extraCities` array
   - Contains one test entry: "Dolphin Island" (Fiji)

### What's NOT Done

2. **`scripts/build-cities.js`** — Has been **reverted to its original state**. None of the extra-cities integration code is present. The following changes need to be applied:
   - Add `existsSync`, `unlinkSync` to the `fs` import
   - Add `import esbuild from 'esbuild';`
   - Add an early check that `src/extra-cities.ts` exists, failing with a clear error if not
   - Add an early check that all required GeoNames raw data files exist in `scripts/geonames-data/`, failing with a clear error listing missing files
   - Add a "Phase 2b: Extra Cities" section after Phase 2 (cities parsing) and before Phase 3 (duplicate detection) that:
     - Transpiles `src/extra-cities.ts` → `scripts/extra-cities-temp.js` using `esbuild.buildSync`
     - Dynamically imports the transpiled module
     - Maps each `ExtraCity` to the internal city record format
     - Appends them to the `cities` array
     - Cleans up the temp file

3. **`.gitignore`** — Needs `scripts/extra-cities-temp.js` added

4. **Regenerating `src/cities-data.js`** — After the script changes are applied, run `node scripts/build-cities.js` to regenerate the database with the extra cities included

5. **Rebuilding dist** — Run `bash build.sh` to copy the updated `src/cities-data.js` into `dist/`

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
    countryCode: string;    // ISO 3166 two-letter code
    population: number;
}
```

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
    admin1Name: '',
    admin2Name: '',
    population,
    timezone: olsonTimezone,
}
```

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
