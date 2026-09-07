/**
 * ensureTzResolved — the one contract for correcting a *provisional*
 * (browser-zone) timezone from the city database, shared by Chronometer,
 * Observatory and Inspector (each instantiates it with its own hooks).
 *
 * Contract:
 *  - No-op unless the app says a resolution is needed (its startup zone was the
 *    tier-3 browser fallback — see tz-resolve.ts).
 *  - Deferred while the app says the live coordinates are transient (a map
 *    drag): nothing resolves, nothing persists, the flag stays armed and the
 *    app re-runs it once the coordinates are settled.
 *  - Resident DB → resolve synchronously: no parse, no release.
 *  - Otherwise, parse on demand via resolveTimezoneFromDb and release
 *    afterwards (in a finally, through the app's guard) — unless the app's
 *    location-name reverse-geocode already has a parse in flight (its handler
 *    calls us with the DB resident) or a resolution for the same coordinates
 *    is already pending. A pending resolution for OTHER coordinates does not
 *    block: a newer location must never wait on a stale answer it will ignore.
 *  - The answer is stamped with the coordinates it was asked for and ignored
 *    (flag left armed) if the location changed meanwhile — a newer location
 *    owns its own resolution.
 *  - A landed answer clears the flag. null (DB unavailable) keeps the guess and
 *    persists nothing — the next load retries. A zone is applied only if it
 *    differs from the current one, but is handed to persistTimezone regardless
 *    (the app persists it when storage has none yet, so the common "the browser
 *    zone happened to be right" case does not re-parse on every load).
 */

import { findClosestCity, isCityDataLoaded } from './city-search';
import { resolveTimezoneFromDb } from './tz-resolve';

export interface TzResolverDeps {
    /** The live observer coordinates. */
    getLocation(): { lat: number; lon: number };
    /** Whether the current zone is a provisional guess needing correction. */
    needsResolution(): boolean;
    setNeedsResolution(v: boolean): void;
    /** The current in-memory zone (undefined if none). */
    getTimezone(): string | undefined;
    /** Apply a corrected zone in memory (env rebuild, displays). Called only on change. */
    applyTimezone(tz: string): void;
    /** Persist a DB-derived zone; the app gates this (persistent mode, nothing stored yet). */
    persistTimezone(tz: string): void;
    /** True while the app's location-name reverse-geocode parse is in flight. */
    parseInFlight(): boolean;
    /** True while the live coordinates are transient (e.g. a map drag). Optional. */
    suspended?(): boolean;
    /** Release the parsed DB after a parse of our own (the app applies its guard). */
    release(): void;
    /** Reported when the async path's apply throws (the release still runs). Optional. */
    onError?(err: unknown): void;
    // --- test seams; default to the real city DB ---
    isLoaded?(): boolean;
    findZone?(lat: number, lon: number): string | null;
    resolveFromDb?(lat: number, lon: number): Promise<string | null>;
}

/** Build an app's ensureTzResolved() from its hooks. */
export function createTzResolver(deps: TzResolverDeps): () => void {
    const isLoaded = deps.isLoaded ?? isCityDataLoaded;
    const findZone = deps.findZone ?? ((lat: number, lon: number) => findClosestCity(lat, lon)?.timezone ?? null);
    const resolveFromDb = deps.resolveFromDb ?? resolveTimezoneFromDb;
    /** Coordinates of the resolveFromDb() currently in flight, if any. */
    let pending: { lat: number; lon: number } | null = null;

    return function ensureTzResolved(): void {
        if (!deps.needsResolution()) return;
        if (deps.suspended?.()) return;                       // transient coordinates — defer, keep the flag armed
        const { lat: forLat, lon: forLon } = deps.getLocation();
        const apply = (resolved: string | null): void => {
            if (!deps.needsResolution()) return;              // resolved meanwhile (the synchronous path)
            if (deps.suspended?.()) return;                   // became transient — defer, keep the flag armed
            const cur = deps.getLocation();
            if (cur.lat !== forLat || cur.lon !== forLon) return;   // a newer location owns its own resolution
            deps.setNeedsResolution(false);
            if (!resolved) return;                            // DB unavailable — keep the guess, retry next load
            if (resolved !== deps.getTimezone()) deps.applyTimezone(resolved);
            deps.persistTimezone(resolved);
        };
        if (isLoaded()) {
            apply(findZone(forLat, forLon));
            return;
        }
        if (deps.parseInFlight()) return;                     // the name path's handler will call us with the DB resident
        if (pending && pending.lat === forLat && pending.lon === forLon) return;
        pending = { lat: forLat, lon: forLon };
        resolveFromDb(forLat, forLon).then(apply).catch((err) => deps.onError?.(err)).finally(() => {
            pending = null;
            deps.release();
        });
    };
}
