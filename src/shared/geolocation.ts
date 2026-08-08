/**
 * Shared browser-geolocation helpers.
 *
 * Two request profiles:
 *
 *   - requestBrowserLocation(): one-shot getCurrentPosition. Used by the
 *     automatic paths (startup bloc fetch, seeded-bloc refresh, wake-triggered
 *     refresh) which are bounded and fall back to a stored seed on failure.
 *
 *   - watchBrowserLocation(): indefinite watchPosition for the explicit
 *     dialog button. POSITION_UNAVAILABLE / TIMEOUT are NON-terminal there:
 *     on Apple platforms CoreLocation reports kCLErrorLocationUnknown while
 *     it keeps scanning, and the documented guidance is to ignore the error
 *     and wait. The watch stays open until the first fix, PERMISSION_DENIED,
 *     or cancellation (the caller shows a Cancel affordance; there is
 *     deliberately no deadline — the user is the deadline).
 *
 * maximumAge is left at its default (0) in both profiles: fixes must be
 * fresh. A cached position would defeat the follow-the-device intent for a
 * laptop that commutes (same machine, 50 miles apart within a day).
 */

export type GeoResult =
    | { status: 'success'; lat: number; lon: number }
    | { status: 'denied'; message?: string }
    | { status: 'timeout'; message?: string }
    | { status: 'unavailable'; message?: string };

/**
 * Staleness threshold for wake-triggered bloc refreshes: when a wake/tab-
 * return fires and the last browser-location attempt is older than this,
 * bloc mode re-checks the device location. Deliberately short (people either
 * keep the tab up continuously or return rarely); a system-timezone change
 * bypasses it entirely.
 */
export const BLOC_REFRESH_STALE_MS = 15 * 60 * 1000;

/**
 * Current IANA timezone of the device ('' if unavailable). Crossing a
 * timezone border changes this (with OS auto-timezone on) without any
 * location permission involved — a free travel signal.
 */
export function systemTimezone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
        return '';
    }
}

function geoErrorName(err: GeolocationPositionError): string {
    return err.code === err.PERMISSION_DENIED ? 'PERMISSION_DENIED'
        : err.code === err.TIMEOUT ? 'TIMEOUT' : 'POSITION_UNAVAILABLE';
}

function logFix(pos: GeolocationPosition): void {
    console.log(`[Geolocation] fix: ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)} (±${Math.round(pos.coords.accuracy)}m)`);
}

/**
 * Request the device location via the browser geolocation API (one-shot).
 * @param timeoutMs  If provided, give up after this many ms (TIMEOUT).
 *                   If omitted, wait indefinitely for user response.
 */
export function requestBrowserLocation(timeoutMs?: number): Promise<GeoResult> {
    if (!navigator.geolocation) return Promise.resolve({ status: 'unavailable' });
    return new Promise((resolve) => {
        const options: PositionOptions = {};
        if (timeoutMs != null) options.timeout = timeoutMs;
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                logFix(pos);
                resolve({ status: 'success', lat: pos.coords.latitude, lon: pos.coords.longitude });
            },
            (err) => {
                console.warn(`[Geolocation] getCurrentPosition failed: ${geoErrorName(err)} — ${err.message}`);
                if (err.code === err.PERMISSION_DENIED) resolve({ status: 'denied', message: err.message });
                else if (err.code === err.TIMEOUT) resolve({ status: 'timeout', message: err.message });
                else resolve({ status: 'unavailable', message: err.message });
            },
            options,
        );
    });
}

export interface GeoWatchHandlers {
    /** First fresh fix. The watch has already been cleared when this fires. */
    onFix: (lat: number, lon: number) => void;
    /** Terminal: permission denied (or geolocation unsupported). Watch cleared. */
    onDenied: (message: string) => void;
    /** Non-terminal failure (unavailable/timeout) — the watch keeps waiting. */
    onStatus?: (codeName: string, message: string) => void;
}

/**
 * Wait indefinitely for a location fix via watchPosition. Returns a cancel
 * function; the watch also self-clears on the first fix or on
 * PERMISSION_DENIED. Non-terminal errors are reported via onStatus and the
 * wait continues (keeping the session open is what lets the OS keep trying).
 */
export function watchBrowserLocation(handlers: GeoWatchHandlers): () => void {
    if (!navigator.geolocation) {
        handlers.onDenied('Geolocation is not supported by this browser');
        return () => {};
    }
    let watchId: number | null = null;
    let lastLogged = '';
    const clear = () => {
        if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }
    };
    watchId = navigator.geolocation.watchPosition(
        (pos) => {
            if (watchId === null) return;   // cancelled with a fix in flight
            logFix(pos);
            clear();
            handlers.onFix(pos.coords.latitude, pos.coords.longitude);
        },
        (err) => {
            if (watchId === null) return;
            // Retries deliver a stream of often-identical errors — log only
            // when the error actually changes.
            const line = `${geoErrorName(err)} — ${err.message}`;
            if (line !== lastLogged) {
                lastLogged = line;
                console.warn(`[Geolocation] watchPosition error: ${line}`);
            }
            if (err.code === err.PERMISSION_DENIED) {
                clear();
                handlers.onDenied(err.message);
            } else {
                handlers.onStatus?.(geoErrorName(err), err.message);
            }
        },
    );
    return clear;
}
