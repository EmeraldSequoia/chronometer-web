/**
 * Timezone resolver — determines the IANA timezone for a given location.
 *
 * Two tiers:
 *  1. If a city was selected from search, use its known timezone.
 *  2. Otherwise, use the closest city in our GeoNames database.
 *  3. Last resort: browser timezone.
 */

import { findClosestCity, loadCityData, isCityDataLoaded } from './city-search';

/**
 * Resolve the IANA timezone for a location.
 *
 * @param lat       Latitude in degrees
 * @param lon       Longitude in degrees
 * @param cityTz    If the user selected a city from search, that city's timezone; otherwise null
 * @returns         IANA timezone string (e.g. "America/Los_Angeles")
 */
export function resolveTimezone(lat: number, lon: number, cityTz: string | null): string {
    // Tier 1: explicit city timezone from search selection
    if (cityTz) return cityTz;

    // Tier 2: closest city in our 167K-city database
    const closest = findClosestCity(lat, lon);
    if (closest?.timezone) return closest.timezone;

    // Tier 3: browser timezone fallback
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
        return 'Etc/UTC';
    }
}

/**
 * Resolve the nearest-city IANA timezone, loading the city DB if it isn't
 * resident yet. Unlike {@link resolveTimezone} (which returns the browser zone
 * when the DB isn't loaded), this awaits the load — so a page opened directly at
 * lat/lon with no `tz` still gets the *location's* zone rather than the browser's.
 *
 * The DB has no refcount: a concurrent consumer's `releaseCityData()` can free it
 * between our `await` and the lookup. We tolerate that by retrying — a reload
 * after a release runs alone (the racing consumer registered its release on the
 * earlier load promise, not ours), so the second attempt succeeds.
 *
 * @returns the nearest-city zone, or `null` if the DB can't be loaded
 *          (offline / file://) — callers keep their browser-zone fallback then.
 *          Does not release the DB; the caller owns that (dialog/memory policy).
 */
export async function resolveTimezoneFromDb(lat: number, lon: number): Promise<string | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await loadCityData();
        } catch {
            return null;
        }
        // Read synchronously in the same microtask so no release can interleave.
        if (isCityDataLoaded()) return findClosestCity(lat, lon)?.timezone ?? null;
        // A racing releaseCityData() freed it before we ran; loop to reload.
    }
    return null;
}
