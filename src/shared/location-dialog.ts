/**
 * Shared location dialog wiring.
 *
 * Handles all DOM event listeners for the location prompt dialog
 * (injected via the {{LOCATION_DIALOG}} partial in build.sh):
 *   - City search autocomplete with keyboard navigation
 *   - Manual coordinate entry
 *   - Browser geolocation
 *   - Globe and OSM tile map preview
 *   - Done / backdrop / Escape dismissal
 *
 * Consuming apps call initLocationDialog() with a config object.
 * The dialog calls config.onLocationChange() when the user selects a location.
 *
 * Does NOT import from src/watch/ — safe for Inspector/Observatory.
 */

import { loadCityData, releaseCityData, searchCities, findClosestCity, isCityDataLoaded, loadError } from './city-search.js';
import type { CityResult } from './city-search.js';
import { renderGlobe, loadOSMTile } from './mini-map.js';
import { resolveTimezone } from './tz-resolve.js';
import type { LocationSource } from './url-state.js';
import { watchBrowserLocation } from './geolocation.js';

// Re-export the geolocation helpers under their historical home so existing
// consumers (Observatory/Inspector startup paths) keep importing from here.
export { requestBrowserLocation } from './geolocation.js';
export type { GeoResult } from './geolocation.js';

// ============================================================================
// Types
// ============================================================================

/** A LocationSource (persistable provenance), or 'none' while no location is set. */
export type LocationSourceType = LocationSource | 'none';

export interface LocationDialogConfig {
    /**
     * Called when the user selects a new location.
     * The dialog stays open — the consumer should update its own state
     * (environment rebuild, URL update, etc.).
     */
    onLocationChange: (info: LocationChangeInfo) => void;

    /**
     * Called when the dialog is dismissed (Done, backdrop, Escape).
     * Optional — defaults to just hiding the dialog.
     */
    onDismiss?: () => void;

    /**
     * Called when the dialog is shown.
     * Optional — consumers can use this to blur backgrounds, etc.
     */
    onShow?: () => void;

    /**
     * If true, the dialog cannot be dismissed until a location is set.
     * Used on first visit when no URL location is specified.
     */
    needsPrompt?: boolean;

    /** Initial latitude (used to pre-fill coordinate inputs). */
    initialLat?: number;
    /** Initial longitude (used to pre-fill coordinate inputs). */
    initialLon?: number;
    /** Initial geo permission state. */
    geoPermission?: 'granted' | 'denied' | 'prompt' | 'unknown';
}

export interface LocationChangeInfo {
    lat: number;
    lon: number;
    /** Short label like "San Jose" for URL/display. Empty if from coords/browser. */
    source: string;
    /** Full label like "San Jose, CA, US" for dialog display. */
    fullLabel: string;
    /** Where the new location came from — assignable directly to state `lsrc`. */
    sourceType: LocationSource;
    /** Resolved Olson timezone ID, e.g. "America/Los_Angeles". */
    timezone: string;
    /** City timezone from the database, if available (used as hint for resolveTimezone). */
    cityTimezone: string | null;
}

export interface LocationDialogAPI {
    /** Show the full dialog. */
    show: () => void;
    /**
     * Show the compact "locating" panel while waiting for browser geolocation
     * on startup. Non-dismissable; the user can switch to the full dialog.
     */
    showLocating: () => void;
    /** True while the compact locating panel is showing (caller can use this to
     *  decide whether a late geolocation result should auto-apply). */
    isLocating: () => boolean;
    /** Hide the dialog. */
    dismiss: () => void;
    /** Update the dialog's internal state (e.g. after location changes externally). */
    updateState: (lat: number, lon: number, sourceType: LocationSourceType, source: string, fullLabel: string) => void;
    /** Update the geo permission state (e.g. after a denied response). */
    setGeoPermission: (state: 'granted' | 'denied' | 'prompt' | 'unknown') => void;
    /** Set whether the dialog acts as a required prompt (can't be dismissed without selecting). */
    setNeedsPrompt: (needs: boolean) => void;
}

// ============================================================================
// Distance / bearing helpers (for "X km DIR of City" display)
// ============================================================================

/** Detect whether the browser locale prefers miles (US, UK, Myanmar, Liberia). */
function useImperial(): boolean {
    const locale = navigator.language || 'en-US';
    const region = locale.split('-')[1]?.toUpperCase() || '';
    return ['US', 'GB', 'MM', 'LR'].includes(region);
}

/** Great-circle distance in km using the Haversine formula. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial bearing from (lat1,lon1) to (lat2,lon2) as a 16-point compass direction. */
function compassBearing(lat1: number, lon1: number, lat2: number, lon2: number): string {
    const toRad = Math.PI / 180;
    const dLon = (lon2 - lon1) * toRad;
    const y = Math.sin(dLon) * Math.cos(lat2 * toRad);
    const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
              Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLon);
    let bearing = Math.atan2(y, x) * 180 / Math.PI;
    bearing = (bearing + 360) % 360;
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                  'S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(bearing / 22.5) % 16];
}

// ============================================================================
// Main initialization
// ============================================================================

/**
 * Initialize the location dialog. Call once after the DOM is ready and the
 * location dialog partial has been injected.
 *
 * Returns an API for programmatic control, or null if the dialog elements
 * aren't present in the DOM.
 */
export function initLocationDialog(config: LocationDialogConfig): LocationDialogAPI | null {
    const maybeLp = document.getElementById('location-prompt');
    if (!maybeLp) return null;
    const locationPrompt = maybeLp;

    // --- DOM references ---
    const lpLatInput = document.getElementById('lp-lat') as HTMLInputElement;
    const lpLonInput = document.getElementById('lp-lon') as HTMLInputElement;
    const lpUseCoords = document.getElementById('lp-use-coords')!;
    const lpUseBrowser = document.getElementById('lp-use-browser')!;
    const lpCityInput = document.getElementById('lp-city-input') as HTMLInputElement;
    const lpCityResults = document.getElementById('lp-city-results')!;
    const lpGlobe = document.getElementById('lp-globe') as HTMLCanvasElement;
    const lpOsmContainer = document.getElementById('lp-osm-container')!;
    const lpOsmTile = document.getElementById('lp-osm-tile') as HTMLImageElement;
    const lpMapMarker = document.getElementById('lp-map-marker')!;
    const lpOsmOffline = document.getElementById('lp-osm-offline')!;
    const lpStatusSection = document.getElementById('lp-status-section')!;
    const lpNoLocation = document.getElementById('lp-no-location')!;
    const lpNoLocationHint = document.getElementById('lp-no-location-hint')!;
    const lpNoLocationDefault = document.getElementById('lp-no-location-default')!;
    const lpLocationName = document.getElementById('lp-location-name')!;
    const lpLocationTz = document.getElementById('lp-location-tz');
    const lpOsmAttribution = document.getElementById('lp-osm-attribution')!;
    const lpDoneBtn = document.getElementById('lp-done')!;
    const lpDialogFooter = lpDoneBtn.parentElement!;
    const lpFullContent = document.getElementById('lp-full-content')!;
    const lpLocating = document.getElementById('lp-locating')!;
    const lpLocatingManual = document.getElementById('lp-locating-manual')!;
    // Nullable: tolerates a stale cached page served with this newer script.
    const lpBrowserError = document.getElementById('lp-browser-error');

    const isFileProtocol = window.location.protocol === 'file:';

    // --- Internal state ---
    let currentLat = config.initialLat ?? 0;
    let currentLon = config.initialLon ?? 0;
    let locationSource = '';
    let locationFullLabel = '';
    let locationSourceType: LocationSourceType = 'none';
    let needsPrompt = config.needsPrompt ?? false;
    let geoPermission = config.geoPermission ?? 'unknown';
    /** True while the compact "locating" panel is shown (waiting for browser geolocation). */
    let locating = false;
    const browserBtnLabel = (lpUseBrowser as HTMLButtonElement).textContent || 'Use device location via browser';
    /** Cancel handle for an in-flight indefinite browser-location wait. */
    let geoWatchCancel: (() => void) | null = null;

    // The city DB is loaded lazily: prefetched by the app entry (gated on
    // save-data) and parsed on demand when the dialog opens (showDialog) or a
    // search runs. Not loaded here at construction time.

    // --- Location name formatting ---

    function buildLocationNameHTML(): string {
        if (locationSourceType === 'city' && locationFullLabel) {
            return `${locationFullLabel} <span class="lp-loc-source">(from cities database)</span>`;
        }
        if (locationSourceType === 'browser' || locationSourceType === 'map' || locationSourceType === 'manual') {
            const closest = findClosestCity(currentLat, currentLon);
            const sourceLabel = locationSourceType === 'browser' ? '(from browser)'
                : locationSourceType === 'map' ? '(from map)' : '(manually entered)';
            if (closest) {
                const distKm = haversineKm(currentLat, currentLon, closest.lat, closest.lon);
                const THRESHOLD_KM = 16; // ~10 miles
                if (distKm > THRESHOLD_KM) {
                    const dir = compassBearing(closest.lat, closest.lon, currentLat, currentLon);
                    let distStr: string;
                    if (useImperial()) {
                        const mi = Math.round(distKm * 0.621371);
                        distStr = `${mi}\u00a0mi`;
                    } else {
                        distStr = `${Math.round(distKm)}\u00a0km`;
                    }
                    return `${distStr} ${dir} of ${closest.label} <span class="lp-loc-source">${sourceLabel}</span>`;
                }
                return `${closest.label} <span class="lp-loc-source">${sourceLabel}</span>`;
            }
            return `${currentLat.toFixed(3)}, ${currentLon.toFixed(3)} <span class="lp-loc-source">${sourceLabel}</span>`;
        }
        return `${currentLat.toFixed(3)}, ${currentLon.toFixed(3)}`;
    }

    // --- Map preview ---

    function updateMapPreview(mapLat: number, mapLon: number) {
        lpStatusSection.classList.add('visible');
        lpNoLocation.classList.add('hidden');

        renderGlobe(lpGlobe, mapLat, mapLon);
        if (isFileProtocol) {
            lpOsmContainer.style.display = 'none';
            lpOsmAttribution.style.display = 'none';
            lpGlobe.width = 160;
            lpGlobe.height = 160;
            lpGlobe.style.width = '160px';
            lpGlobe.style.height = '160px';
        } else {
            lpOsmContainer.style.display = '';
            lpOsmAttribution.style.display = '';
            lpOsmOffline.style.display = 'none';
            loadOSMTile(lpOsmContainer, lpOsmTile, lpMapMarker, mapLat, mapLon).then(ok => {
                lpOsmOffline.style.display = ok ? 'none' : '';
            });
        }
        lpLocationName.innerHTML = buildLocationNameHTML();
    }

    // --- Apply location (internal) ---

    function applyLocation(
        newLat: number, newLon: number,
        source: string, fullLabel: string,
        sourceType: LocationSource,
        cityTz: string | null = null,
    ): void {
        currentLat = newLat;
        currentLon = newLon;
        locationSource = source;
        locationFullLabel = fullLabel;
        locationSourceType = sourceType;

        const timezone = resolveTimezone(newLat, newLon, cityTz);

        // Notify consumer
        config.onLocationChange({
            lat: newLat,
            lon: newLon,
            source,
            fullLabel,
            sourceType,
            timezone,
            cityTimezone: cityTz,
        });

        // Update map preview and show Done button
        updateMapPreview(newLat, newLon);
        lpDialogFooter.classList.add('visible');
        needsPrompt = false;
        if (lpBrowserError) lpBrowserError.style.display = 'none';
    }

    // --- Show / dismiss ---

    /**
     * Show the compact "locating" panel while waiting for browser geolocation.
     * Non-dismissable (treated as a required prompt with no location yet); the
     * "Enter location manually" button switches to the full dialog.
     */
    function showLocating() {
        locating = true;
        needsPrompt = true;
        lpFullContent.style.display = 'none';
        lpLocating.style.display = '';
        locationPrompt.style.display = '';
        config.onShow?.();
    }

    function showDialog() {
        // Fresh presentation: an in-flight browser-location wait would fight
        // the button/label reset below, so cancel it first.
        cancelGeoWait();
        // Leaving (or never entering) the compact locating panel → show full dialog.
        locating = false;
        lpLocating.style.display = 'none';
        lpFullContent.style.display = '';
        locationPrompt.style.display = '';
        config.onShow?.();

        // Parse the city DB on demand (it may never have been parsed, or was
        // released on a prior dismiss). Re-render the nearest-city name once it
        // arrives — until then buildLocationNameHTML falls back to coordinates.
        loadCityData().then(() => {
            if (locationPrompt.style.display !== 'none') {
                lpLocationName.innerHTML = buildLocationNameHTML();
            }
        }).catch(() => {});

        // Pre-fill coordinate inputs
        lpLatInput.value = (currentLat !== 0 || currentLon !== 0) ? currentLat.toFixed(3) : '';
        lpLonInput.value = (currentLat !== 0 || currentLon !== 0) ? currentLon.toFixed(3) : '';

        // Clear city search, stale browser-location error, and autofocus
        if (lpCityInput) { lpCityInput.value = ''; }
        if (lpCityResults) { lpCityResults.innerHTML = ''; }
        if (lpBrowserError) { lpBrowserError.style.display = 'none'; }
        setTimeout(() => lpCityInput?.focus(), 50);

        // Show status or no-location placeholder
        const hasLocation = currentLat !== 0 || currentLon !== 0;
        if (hasLocation) {
            lpStatusSection.classList.add('visible');
            lpNoLocation.classList.add('hidden');
            updateMapPreview(currentLat, currentLon);
        } else {
            lpStatusSection.classList.remove('visible');
            lpNoLocation.classList.remove('hidden');
            if (needsPrompt) {
                lpNoLocationHint.style.display = '';
                lpNoLocationDefault.style.display = 'none';
            } else {
                lpNoLocationHint.style.display = 'none';
                lpNoLocationDefault.style.display = '';
            }
        }

        lpDialogFooter.classList.toggle('visible', !needsPrompt || hasLocation);

        // Configure browser location button
        const btn = lpUseBrowser as HTMLButtonElement;
        const deniedTooltip = isFileProtocol
            ? 'Not all browsers support location access from file:// URLs'
            : 'Browser location was not granted — check your browser settings to allow it';

        if (geoPermission === 'denied') {
            btn.disabled = true;
            btn.dataset.tooltip = deniedTooltip;
            btn.textContent = browserBtnLabel + ' (unavailable)';
        } else {
            btn.disabled = false;
            delete btn.dataset.tooltip;
            btn.textContent = browserBtnLabel;
        }

        // Disable "Use this location" until inputs have valid numbers
        const coordsBtn = lpUseCoords as HTMLButtonElement;
        function validateCoordInputs() {
            const validLat = !isNaN(parseFloat(lpLatInput.value));
            const validLon = !isNaN(parseFloat(lpLonInput.value));
            coordsBtn.disabled = !(validLat && validLon);
        }
        validateCoordInputs();
        lpLatInput.oninput = validateCoordInputs;
        lpLonInput.oninput = validateCoordInputs;
    }

    function dismissDialog() {
        // A dismissed dialog must not leave a watch running that could apply
        // a location out of nowhere later.
        cancelGeoWait();
        locating = false;
        locationPrompt.style.display = 'none';
        // Parse-then-drop: free the ~22 MB parsed form now that search is done.
        // The compressed blob stays resident, so reopening re-parses instantly
        // without a network round-trip. The host's onLocationChange has already
        // fired (and read any nearest-city name) before dismiss.
        releaseCityData();
        config.onDismiss?.();
    }

    function canDismiss(): boolean {
        return !needsPrompt || (currentLat !== 0 || currentLon !== 0);
    }

    // --- Button handlers ---

    // "Use this location" (manual coordinates)
    lpUseCoords.addEventListener('click', () => {
        const newLat = parseFloat(lpLatInput.value);
        const newLon = parseFloat(lpLonInput.value);
        if (isNaN(newLat) || isNaN(newLon)) return;
        applyLocation(newLat, newLon, '', '', 'manual');
    });

    // "Use browser location" — indefinite wait (see geolocation.ts): the OS
    // location service keeps trying for as long as the watch stays open, so
    // rather than impose a deadline the button becomes Cancel and the status
    // line explains any transient failures while the wait continues.
    function endGeoWait(): void {
        geoWatchCancel = null;
        lpUseBrowser.textContent = browserBtnLabel;
        if (lpBrowserError) lpBrowserError.style.display = 'none';
    }

    function cancelGeoWait(): void {
        if (!geoWatchCancel) return;
        const cancel = geoWatchCancel;
        endGeoWait();
        cancel();
    }

    lpUseBrowser.addEventListener('click', () => {
        if (geoWatchCancel) {    // second click = Cancel
            cancelGeoWait();
            return;
        }
        lpUseBrowser.textContent = 'Cancel request';
        if (lpBrowserError) {
            lpBrowserError.classList.remove('lp-success');
            lpBrowserError.classList.add('lp-waiting');
            lpBrowserError.textContent = 'Waiting for the browser to report a location…';
            lpBrowserError.style.display = '';
        }
        geoWatchCancel = watchBrowserLocation({
            onFix: (fixLat, fixLon) => {
                endGeoWait();
                geoPermission = 'granted';
                applyLocation(fixLat, fixLon, '', '', 'browser');
                // Explicit confirmation: a stationary refresh changes nothing
                // else visible, and success-by-silence reads as failure.
                if (lpBrowserError) {
                    lpBrowserError.classList.remove('lp-waiting');
                    lpBrowserError.classList.add('lp-success');
                    lpBrowserError.textContent = 'Refreshed browser location.';
                    lpBrowserError.style.display = '';
                }
            },
            onDenied: () => {
                endGeoWait();
                geoPermission = 'denied';
                const btn = lpUseBrowser as HTMLButtonElement;
                btn.disabled = true;
                btn.textContent = browserBtnLabel + ' (unavailable)';
                btn.dataset.tooltip = isFileProtocol
                    ? 'Not all browsers support location access from file:// URLs'
                    : 'Browser location was not granted — check your browser settings to allow it';
            },
            onStatus: (codeName, message) => {
                if (lpBrowserError) {
                    const detail = message ? `${codeName}: ${message}` : codeName;
                    lpBrowserError.textContent = `Still trying — the browser hasn't reported a location yet (${detail}).`;
                    lpBrowserError.style.display = '';
                }
            },
        });
    });

    // Backdrop click
    locationPrompt.querySelector('.lp-backdrop')!.addEventListener('click', () => {
        if (canDismiss()) dismissDialog();
    });

    // Done button — respect the non-dismissable (required-prompt) state.
    lpDoneBtn.addEventListener('click', () => {
        if (canDismiss()) dismissDialog();
    });

    // Compact panel: "Enter location manually" → switch to the full dialog.
    lpLocatingManual.addEventListener('click', () => {
        showDialog();
    });

    // Escape key — only handle if dialog is visible.
    // Note: consumers with multiple modal layers may want to handle Escape
    // themselves and call api.dismiss(). This handler is a simple fallback.
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Escape' && locationPrompt.style.display !== 'none') {
            if (canDismiss()) {
                dismissDialog();
                e.stopPropagation();
            }
        }
    });

    // =========================================================================
    // City search autocomplete
    // =========================================================================

    let citySearchDebounce: ReturnType<typeof setTimeout> | null = null;
    let cityDataLoading = false;
    let cityDataFailed = false;
    let selectedCityIndex = -1;

    function renderCityResults(results: CityResult[]) {
        lpCityResults.innerHTML = '';
        selectedCityIndex = -1;
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const div = document.createElement('div');
            div.className = 'lp-city-item';
            if (r.isAirport) {
                const parts = r.label.split('  ');
                div.innerHTML = `<span class="iata-tag">${parts[0]}</span>${parts.slice(1).join('  ')}`;
            } else {
                div.textContent = r.label;
            }
            div.addEventListener('click', () => {
                applyLocation(r.lat, r.lon, r.shortLabel, r.label, 'city', r.timezone);
                lpCityInput.value = '';
                lpCityResults.innerHTML = '';
                lpLatInput.value = r.lat.toFixed(3);
                lpLonInput.value = r.lon.toFixed(3);
            });
            lpCityResults.appendChild(div);
        }
    }

    async function onCityInput() {
        try {
            let query = lpCityInput.value.trim();
            if (query.length < 2) {
                lpCityResults.innerHTML = '';
                return;
            }

            if (cityDataFailed) {
                lpCityResults.innerHTML = `<div class="lp-city-loading">City search unavailable: ${loadError || 'unknown error'}</div>`;
                return;
            }

            if (!isCityDataLoaded()) {
                if (!cityDataLoading) {
                    cityDataLoading = true;
                    lpCityResults.innerHTML = '<div class="lp-city-loading">Loading city database…</div>';
                    try {
                        await loadCityData();
                    } catch (err) {
                        cityDataLoading = false;
                        cityDataFailed = true;
                        lpCityResults.innerHTML = `<div class="lp-city-loading">Failed to load city data: ${(err as Error).message}</div>`;
                        return;
                    }
                    cityDataLoading = false;
                    query = lpCityInput.value.trim();
                    if (query.length < 2) {
                        lpCityResults.innerHTML = '';
                        return;
                    }
                } else {
                    return;
                }
            }

            const results = searchCities(query, 20);
            renderCityResults(results);
        } catch (err) {
            console.error('[CitySearch] Error:', err);
            lpCityResults.innerHTML = `<div class="lp-city-loading">Error: ${(err as Error).message}</div>`;
        }
    }

    function debounceCitySearch() {
        if (citySearchDebounce) clearTimeout(citySearchDebounce);
        citySearchDebounce = setTimeout(onCityInput, 150);
    }

    // Listen on multiple events for iOS compatibility
    lpCityInput.addEventListener('input', debounceCitySearch);
    lpCityInput.addEventListener('keyup', debounceCitySearch);
    lpCityInput.addEventListener('compositionend', debounceCitySearch);

    // Scroll input into view on focus (iOS keyboard)
    lpCityInput.addEventListener('focus', () => {
        setTimeout(() => {
            lpCityInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 300);
    });

    // Keyboard navigation in results
    lpCityInput.addEventListener('keydown', (e: KeyboardEvent) => {
        const items = lpCityResults.querySelectorAll('.lp-city-item');
        if (items.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedCityIndex = Math.min(selectedCityIndex + 1, items.length - 1);
            items.forEach((el, i) => el.classList.toggle('selected', i === selectedCityIndex));
            (items[selectedCityIndex] as HTMLElement).scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedCityIndex = Math.max(selectedCityIndex - 1, 0);
            items.forEach((el, i) => el.classList.toggle('selected', i === selectedCityIndex));
            (items[selectedCityIndex] as HTMLElement).scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' && selectedCityIndex >= 0) {
            e.preventDefault();
            (items[selectedCityIndex] as HTMLElement).click();
        } else if (e.key === 'Escape') {
            lpCityResults.innerHTML = '';
            lpCityInput.value = '';
        }
    });

    // =========================================================================
    // Public API
    // =========================================================================

    return {
        show: showDialog,
        showLocating,
        isLocating: () => locating,
        dismiss: dismissDialog,

        updateState(lat: number, lon: number, sourceType: LocationSourceType, source: string, fullLabel: string) {
            currentLat = lat;
            currentLon = lon;
            locationSourceType = sourceType;
            locationSource = source;
            locationFullLabel = fullLabel;
        },

        setGeoPermission(state: 'granted' | 'denied' | 'prompt' | 'unknown') {
            geoPermission = state;
        },

        setNeedsPrompt(needs: boolean) {
            needsPrompt = needs;
        },
    };
}
