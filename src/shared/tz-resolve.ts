/**
 * Timezone resolver — determines the IANA timezone for a given location.
 *
 * Tiers:
 *  1. If a city was selected from search, use its known timezone.
 *  2. Otherwise, use the closest city in our GeoNames database.
 *  3. Last resort: the browser's zone.
 *
 * Tier 3 is a GUESS, not a property of the location: the city database is
 * parsed lazily, so a location resolved while it is not resident gets the
 * browser's zone. Such a result is *provisional* — it must never be persisted
 * as the location's tz (a stored browser zone would poison every later load)
 * and must be re-resolved once the database is available (see
 * resolveTimezoneFromDb and each app's ensureTzResolved). resolveTimezone()
 * is the convenience form for callers that only need the zone;
 * resolveTimezoneProvisional() also says whether it is a guess.
 */

import { findClosestCity, loadCityData, isCityDataLoaded } from './city-search';

export interface TzResolution {
    /** IANA timezone string (e.g. "America/Los_Angeles"). */
    tz: string;
    /** True when `tz` is the browser-zone fallback (tier 3) — do not persist. */
    provisional: boolean;
}

/**
 * Resolve the IANA timezone for a location, reporting whether the answer is a
 * confident one (city pick / nearest DB city) or the browser-zone fallback.
 *
 * @param lat       Latitude in degrees
 * @param lon       Longitude in degrees
 * @param cityTz    If the user selected a city from search, that city's timezone; otherwise null
 */
export function resolveTimezoneProvisional(lat: number, lon: number, cityTz: string | null): TzResolution {
    // Tier 1: explicit city timezone from search selection
    if (cityTz) return { tz: cityTz, provisional: false };

    // Tier 2: closest city in our 167K-city database (null while unparsed)
    const closest = findClosestCity(lat, lon);
    if (closest?.timezone) return { tz: closest.timezone, provisional: false };

    // Tier 3: browser timezone fallback — a guess
    try {
        return { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, provisional: true };
    } catch {
        return { tz: 'Etc/UTC', provisional: true };
    }
}

/**
 * Resolve the IANA timezone for a location (see resolveTimezoneProvisional for
 * the tiers). Callers that persist the result must check `provisional` via
 * resolveTimezoneProvisional instead.
 */
export function resolveTimezone(lat: number, lon: number, cityTz: string | null): string {
    return resolveTimezoneProvisional(lat, lon, cityTz).tz;
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
