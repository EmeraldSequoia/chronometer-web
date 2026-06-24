# Drag-to-Explore: Largest City Within 1 Pixel

## Goal

During drag-to-explore on the Observatory earth map, instead of finding the
*closest* city globally, find the *largest* city within a 1-CSS-pixel radius of
the cursor. Use that city for both the timezone and the footer display name.

When no city falls within the 1-pixel radius, fall back to the closest city for
both timezone and display — this previews what will happen if the user releases
the mouse and accepts the confirmation.

## Background

The earth map uses an equirectangular projection:
- 1 CSS pixel = `360 / earthW` degrees longitude
- 1 CSS pixel = `180 / earthH` degrees latitude

The radius is **pixel-based** (not a fixed geographic distance), so the
geographic coverage scales with the map size. On a 400px-wide map, 1 pixel ≈
0.9° ≈ 100km at the equator; on a 1200px map, ≈ 0.3° ≈ 33km.

## Proposed Changes

### city-search.ts

Add a new exported function:

```typescript
/**
 * Find the largest city within `radiusDeg` of (lat, lon).
 * Exploits the population-descending sort order: the FIRST city
 * found inside the radius is guaranteed to be the largest, so we
 * can return immediately without scanning the rest.
 *
 * Returns null if no city falls within the radius.
 */
export function findLargestCityNear(
    lat: number, lon: number, radiusDeg: number,
): CityResult | null
```

**Algorithm**: Linear scan of the 167K cities. For each city, compute the
equirectangular distance (same formula as `findClosestCity`). Since cities are
sorted by population descending, the **first** hit inside the radius is the
largest — early exit.

- In populated areas (Tokyo, NYC, London) this returns almost immediately
  (those cities are in the first few hundred entries).
- In unpopulated areas (ocean, desert) the full 167K scan runs without a hit,
  returning `null`. Same cost as `findClosestCity`.

### observatory-entry.ts

In `applyTemporaryLocation`, replace the current `findClosestCity` call:

```typescript
const radiusDeg = layout ? 360 / layout.earthW : 1;
const nearby = findLargestCityNear(lat, lon, radiusDeg);
if (nearby) {
    locationTimezone = nearby.timezone;
    if (nameEl) nameEl.textContent = nearby.shortLabel;
} else {
    // No city within 1 pixel — fall back to closest for both tz and display.
    // This previews what will happen if the user lifts and accepts.
    const closest = findClosestCity(lat, lon);
    locationTimezone = closest?.timezone
        || Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (nameEl) nameEl.textContent = closest?.shortLabel
        ?? `${lat.toFixed(1)}°, ${lon.toFixed(1)}°`;
}
```

The `layout` parameter is already available as a module-level variable.

## Verification

- Build with `bash build.sh`
- Drag over Tokyo → should show "Tokyo" and Asia/Tokyo timezone
- Drag over open ocean → should show closest city name and reasonable timezone
- Drag over rural area → shows closest city (fallback)
- Check that drag responsiveness is not degraded (early-exit should be faster
  than `findClosestCity` in the common case)
