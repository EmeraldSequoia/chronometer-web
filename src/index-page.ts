/**
 * Index page logic for Emerald Chronometer.
 *
 * Built by esbuild as an IIFE — no ES modules needed.
 * Handles:
 *   - URL state management (lat/lon/city propagation to face links)
 *   - Browser geolocation check
 *   - Full location dialog with city search, globe, and OSM map
 */

import { loadCityData, searchCities, findClosestCity, isCityDataLoaded, loadError } from './shared/city-search.js';
import type { CityResult } from './shared/city-search.js';
import { renderGlobe, loadOSMTile } from './shared/mini-map.js';
import { resolveTimezone } from './shared/tz-resolve.js';
import { initAppState, getState, setState } from './shared/app-state.js';
import { registerHotkey } from './shared/hotkeys.js';
import { initAppNavLinks, registerAppNavHotkeys } from './shared/app-nav.js';
import { openGeneralHelpTopic } from './shared/help-popover.js';

// Select the state backend before any getState()/setState() call.
initAppState({ app: 'index' });

// ============================================================================
// Constants
// ============================================================================

const DEMO_LAT = 37.3349;   // Apple Park, Cupertino
const DEMO_LON = -122.0090;

const isFileProtocol = window.location.protocol === 'file:';

// Preload city database in the background so it's ready when the user
// opens the location dialog. Fire-and-forget — errors are silently
// ignored here since loadCityData() will report them on actual use.
loadCityData().catch(() => {});

// ============================================================================
// Navigation link updates
// ============================================================================

/** Update all face-card links to include the current URL search params. */
function updateLinks() {
    const search = window.location.search;
    document.querySelectorAll('a.face-card').forEach(a => {
        const baseHref = a.getAttribute('data-base-href') || a.getAttribute('href')!;
        if (!a.hasAttribute('data-base-href')) a.setAttribute('data-base-href', baseHref);
        const url = new URL(baseHref, window.location.href);
        url.search = search;
        (a as HTMLAnchorElement).href = url.toString();
    });

    // Smart pick card: show "Selected Faces" if picks exist, else "Pick Faces"
    const pickCard = document.getElementById('pick-card') as HTMLAnchorElement | null;
    if (pickCard) {
        const hasPicks = !!getState().picks;
        const baseHref = hasPicks ? 'selected.html' : 'pick.html';
        const url = new URL(baseHref, window.location.href);
        url.search = search;
        pickCard.href = url.toString();
        const titleEl = document.getElementById('pick-card-title');
        const descEl = document.getElementById('pick-card-desc');
        if (titleEl) titleEl.textContent = hasPicks ? 'Selected Faces' : 'Pick Faces';
        if (descEl) descEl.textContent = hasPicks ? 'View your chosen faces' : 'Choose and order your favorite faces';
    }
}

// ============================================================================
// Geolocation
// ============================================================================

type GeoResult =
    | { status: 'success'; lat: number; lon: number }
    | { status: 'denied' }
    | { status: 'timeout' }
    | { status: 'unavailable' };

function requestBrowserLocation(timeoutMs?: number): Promise<GeoResult> {
    if (!navigator.geolocation) return Promise.resolve({ status: 'unavailable' });
    return new Promise((resolve) => {
        const options: PositionOptions = {};
        if (timeoutMs != null) options.timeout = timeoutMs;
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ status: 'success', lat: pos.coords.latitude, lon: pos.coords.longitude }),
            (err) => {
                if (err.code === err.PERMISSION_DENIED) resolve({ status: 'denied' });
                else if (err.code === err.TIMEOUT) resolve({ status: 'timeout' });
                else resolve({ status: 'unavailable' });
            },
            options,
        );
    });
}

// ============================================================================
// Location dialog
// ============================================================================

const locationPrompt = document.getElementById('location-prompt')!;
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
const lpOsmAttribution = document.getElementById('lp-osm-attribution')!;
const lpDoneBtn = document.getElementById('lp-done')!;
const lpDialogFooter = lpDoneBtn.parentElement!;

let hasLocation = false;  // tracks whether a valid location has been set
const browserBtnLabel = (lpUseBrowser as HTMLButtonElement).textContent || 'Use device location via browser';
let currentLat = 0;
let currentLon = 0;
let locationSource = '';
let locationFullLabel = '';  // Full "City, State, Country" for dialog display
let locationSourceType: 'url-city' | 'browser' | 'manual' | 'none' = 'none';
let needsPrompt = false;  // true when showing prompt at startup (no URL location)

function showPrompt(geoDenied: boolean) {
    locationPrompt.style.display = '';
    if (geoDenied) {
        (lpUseBrowser as HTMLButtonElement).disabled = true;
        lpUseBrowser.dataset.tooltip = isFileProtocol
            ? 'Not all browsers support location access from file:// URLs'
            : 'Browser location was not granted — check your browser settings to allow it';
        lpUseBrowser.textContent = browserBtnLabel + ' (unavailable)';
    }

    // Show status or no-location placeholder
    if (hasLocation) {
        lpStatusSection.classList.add('visible');
        lpNoLocation.classList.add('hidden');
        updateMapPreview(currentLat, currentLon);
    } else {
        lpStatusSection.classList.remove('visible');
        lpNoLocation.classList.remove('hidden');
        // Show prominent hint on first visit (no URL location params),
        // plain "No location set yet" otherwise.
        if (needsPrompt) {
            lpNoLocationHint.style.display = '';
            lpNoLocationDefault.style.display = 'none';
        } else {
            lpNoLocationHint.style.display = 'none';
            lpNoLocationDefault.style.display = '';
        }
    }
    lpDialogFooter.classList.toggle('visible', hasLocation);
}

function hidePrompt() {
    locationPrompt.style.display = 'none';
}

function buildLocationNameHTML(): string {
    if (locationSourceType === 'url-city' && locationFullLabel) {
        return `${locationFullLabel} <span class="lp-loc-source">(from cities database)</span>`;
    }
    if (locationSourceType === 'browser' || locationSourceType === 'manual') {
        const closest = findClosestCity(currentLat, currentLon);
        const sourceLabel = locationSourceType === 'browser' ? '(from browser)' : '(manually entered)';
        if (closest) {
            return `${closest.label} <span class="lp-loc-source">${sourceLabel}</span>`;
        }
        return `${currentLat.toFixed(3)}, ${currentLon.toFixed(3)} <span class="lp-loc-source">${sourceLabel}</span>`;
    }
    return `${currentLat.toFixed(3)}, ${currentLon.toFixed(3)}`;
}

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

function applyLocation(newLat: number, newLon: number, source: string, fullLabel: string, sourceType: typeof locationSourceType, writeToUrl: boolean, cityTz: string | null = null) {
    hasLocation = true;
    currentLat = newLat;
    currentLon = newLon;
    locationSource = source;
    locationFullLabel = fullLabel;
    locationSourceType = sourceType;
    if (writeToUrl) {
        // Persist the location's timezone so a face opened from here reads it
        // straight from shared state — no DB-load race, no nearest-city
        // approximation. Only persist a *confident* tz: a city pick carries its
        // exact zone; a manual pick uses nearest-city ONLY if the DB is already
        // loaded. Otherwise leave tz unset and let the face resolve+persist it
        // once its own DB loads (backstop-then-update). Never persist a bare
        // browser fallback as the location's tz.
        const tz = cityTz
            ? cityTz
            : (isCityDataLoaded() ? resolveTimezone(newLat, newLon, null) : null);
        setState({ lat: newLat, lon: newLon, city: source || null, ...(tz ? { tz } : {}) });
    }
    updateLinks();
    updateMapPreview(newLat, newLon);
    lpDialogFooter.classList.add('visible');
}

// ============================================================================
// Button handlers
// ============================================================================

lpUseCoords.addEventListener('click', () => {
    const newLat = parseFloat(lpLatInput.value);
    const newLon = parseFloat(lpLonInput.value);
    if (isNaN(newLat) || isNaN(newLon)) return;
    applyLocation(newLat, newLon, '', '', 'manual', true);
});

lpUseBrowser.addEventListener('click', async () => {
    lpUseBrowser.textContent = 'Requesting…';
    const result = await requestBrowserLocation();  // no timeout — wait indefinitely
    if (result.status === 'success') {
        lpUseBrowser.textContent = browserBtnLabel;
        applyLocation(result.lat, result.lon, '', '', 'browser', false);
        // Write bloc=1 and clear lat/lon/city so next reload asks browser again
        setState({ bloc: true, lat: null, lon: null, city: null });
        updateLinks();
    } else if (result.status === 'denied') {
        // User denied — disable the button
        const btn = lpUseBrowser as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = browserBtnLabel + ' (unavailable)';
        btn.dataset.tooltip = isFileProtocol
            ? 'Not all browsers support location access from file:// URLs'
            : 'Browser location was not granted — check your browser settings to allow it';
    } else {
        lpUseBrowser.textContent = browserBtnLabel;
    }
});

// Close prompt when clicking backdrop (only if we have a location)
locationPrompt.querySelector('.lp-backdrop')!.addEventListener('click', () => {
    if (hasLocation) hidePrompt();
});

// Close prompt with Escape key
document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && locationPrompt.style.display !== 'none') {
        if (hasLocation) hidePrompt();
    }
});

// Done button
lpDoneBtn.addEventListener('click', () => {
    hidePrompt();
});

// ============================================================================
// City search autocomplete
// ============================================================================

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
            applyLocation(r.lat, r.lon, r.shortLabel, r.label, 'url-city', true, r.timezone || null);
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

lpCityInput.addEventListener('input', debounceCitySearch);
lpCityInput.addEventListener('keyup', debounceCitySearch);
lpCityInput.addEventListener('compositionend', debounceCitySearch);

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

// ============================================================================
// Startup: check for existing location or prompt
// ============================================================================

// ============================================================================
// Cross-app navigation (header icons + i/o/c/a) and page hotkeys
// ============================================================================

// This page IS Chronometer, so drop its own entry from the Other Apps section
// (the popup wiring is inline in index.html, not help-popover.ts).
document.querySelectorAll('#other-apps-section .other-app[data-app="chronometer"]')
    .forEach(el => el.remove());

// No time controller here, so there is no state to flush before navigating.
// Key table: help.html#hotkeys.
initAppNavLinks();
registerAppNavHotkeys();
registerHotkey('h', () => document.getElementById('info-btn')?.click());
registerHotkey('?', () => openGeneralHelpTopic('#hotkeys'));
registerHotkey('l', () => showPrompt(false));

(async function init() {
    const urlState = getState();

    if (urlState.lat !== null && urlState.lon !== null) {
        hasLocation = true;
        currentLat = urlState.lat;
        currentLon = urlState.lon;
        locationSource = urlState.city || '';
        locationSourceType = urlState.city ? 'url-city' : 'manual';
        updateLinks();
    } else if (urlState.bloc) {
        // bloc=1 set — ask browser for location with 10s timeout
        const result = await requestBrowserLocation(10000);
        if (result.status === 'success') {
            hasLocation = true;
            currentLat = result.lat;
            currentLon = result.lon;
            locationSourceType = 'browser';
            updateLinks();
        } else if (result.status === 'denied') {
            // User explicitly denied — show prompt with button disabled
            needsPrompt = true;
            showPrompt(true);
            updateLinks();
        } else {
            // Timeout or unavailable — show prompt as if user opened it
            needsPrompt = true;
            showPrompt(false);
            updateLinks();
        }
    } else {
        // No location and no bloc — show prompt
        needsPrompt = true;
        showPrompt(false);
        updateLinks();
    }
})();
