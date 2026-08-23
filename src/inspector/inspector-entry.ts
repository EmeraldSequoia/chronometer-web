/**
 * Inspector — live astronomy data explorer.
 *
 * Entry point for the Inspector app. Imports ONLY from:
 *   - src/shared/   (astro-env, url-state, tz-resolve, city-search)
 *   - src/expr/     (expression compiler, via obs-value)
 *   - src/astronomy/ (rise/set for sunrise/sunset)
 *
 * Does NOT import from src/watch/ — keeps the bundle clean of
 * Chronometer-specific code (renderer, XML parser, Terra slots, etc.)
 */

import { createAstroEnvironment, computeTzDeltaMs } from '../shared/astro-env.js';
import { createObsValue, JUMP, type ObsValue } from '../shared/obs-value.js';
import {
    makeOverridableGetNow, Updater, timingContextForFrame,
} from '../shared/updater.js';
import { TimeController } from '../shared/time-controller.js';
import { initTimeControls, flushTimeState, type TimeControlsAPI } from '../shared/time-controls-ui.js';
import { registerHotkey } from '../shared/hotkeys.js';
import { initAppNavLinks, registerAppNavHotkeys } from '../shared/app-nav.js';
import { createFpsIndicator } from '../shared/fps-indicator.js';
import { getState, setState, initAppState, onSharedChange, isPersistentMode } from '../shared/app-state.js';
import { locationSourceOf } from '../shared/url-state.js';
import { initShareButton } from '../shared/share-button.js';
import { initHelpPopover, openGeneralHelpTopic } from '../shared/help-popover.js';
import { resolveTimezone, resolveTimezoneFromDb } from '../shared/tz-resolve.js';
import { findClosestCity, prefetchCityData, loadCityData, releaseCityData, isCityDataLoaded } from '../shared/city-search.js';
import { initLocationDialog, requestBrowserLocation } from '../shared/location-dialog.js';
import { showStorageWarning } from '../shared/incoming-settings-dialog.js';
import { CATALOG, tagIsAngular, tagIsDiscrete, type CatalogCell, type Tag } from './catalog.js';
import { layoutChrome, type ChromeItem, type Rect } from '../shared/chrome-layout.js';

// ============================================================================
// Initialization
// ============================================================================

// DOM references
const timeDisplay = document.getElementById('time-display')!;
const dateDisplay = document.getElementById('date-display')!;
const locationName = document.getElementById('location-name')!;
const locationDetail = document.getElementById('location-detail')!;
const setLocationBtn = document.getElementById('set-location-btn')!;
const catalogEl = document.getElementById('catalog')!;
const tzDisplay = document.getElementById('tz-display')!;

// Split the time display into a main HH:MM:SS span and a dimmer subsecond span
// (updated per-frame, so the millisecond motion is visible at the full frame rate).
const timeMainEl = document.createElement('span');
const timeSubsecEl = document.createElement('span');
timeSubsecEl.className = 'time-subsec';
timeDisplay.textContent = '';
timeDisplay.append(timeMainEl, timeSubsecEl);

// --- Resolve location from URL params ---
initAppState({ app: 'inspector' });
const urlState = getState();
const hasUrlLocation = urlState.lat !== null && urlState.lon !== null;
let lat = urlState.lat ?? 0;
let lon = urlState.lon ?? 0;
let locationTimezone: string | undefined = urlState.tz || undefined;
let needsPrompt = !hasUrlLocation && !urlState.bloc;

// Prefetch the city DB in the background (held as a ~7.5 MB compressed blob,
// parsed on demand) unless the user asked to conserve data. See
// planning/2026-06-14-observatory-cities-lazy-load.md.
if (!(navigator as any).connection?.saveData) prefetchCityData();

// Yellow tint for the location name while a seeded-bloc geolocation refresh is
// in flight (lightweight stand-in for a fuller "updating location" indicator).
const LOCATING_TINT = '#e6b800';

// A seeded-bloc refresh failure may mean we're showing a stale last-known
// location — tell the user once per session via the shared dismissible toast.
let blocRefreshNoticeShown = false;
function notifyBlocRefreshFailed(): void {
    if (blocRefreshNoticeShown) return;
    blocRefreshNoticeShown = true;
    showStorageWarning('Could not retrieve location from browser — falling back to last known location.');
}

/** True while the location dialog/prompt is on screen. */
function dialogShown(): boolean {
    const lp = document.getElementById('location-prompt');
    return !!lp && lp.style.display !== 'none';
}

/** Great-circle distance in km (for the bloc "moved?" reuse threshold). */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// If no timezone in URL/state, resolve it from lat/lon (only if we have a
// location). Use the nearest-city zone when the city DB is already resident;
// otherwise fall back to the browser zone as a TRANSIENT backstop and re-resolve
// once the DB loads (see "Backstop timezone re-resolution" below) — a direct link
// at lat/lon should end up on the *location's* zone, not the browser's.
let tzNeedsResolution = false;
if (!locationTimezone && hasUrlLocation) {
    if (isCityDataLoaded()) {
        locationTimezone = resolveTimezone(lat, lon, null);
    } else {
        locationTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        tzNeedsResolution = true;
    }
}

let tzDeltaMs = computeTzDeltaMs(locationTimezone);

/** Format timezone abbreviation and UTC offset, e.g. "(PDT) UTC-7:00". */
function formatTimezoneInfo(olsonId: string | undefined, referenceDate?: Date): string {
    if (!olsonId) return '';
    try {
        const ref = referenceDate || new Date();
        // Get short abbreviation like "PDT", "EST"
        const shortFmt = new Intl.DateTimeFormat('en-US', {
            timeZone: olsonId,
            timeZoneName: 'short',
        });
        const shortParts = shortFmt.formatToParts(ref);
        const abbr = shortParts.find(p => p.type === 'timeZoneName')?.value || '';

        // Get UTC offset like "GMT-07:00"
        const longFmt = new Intl.DateTimeFormat('en-US', {
            timeZone: olsonId,
            timeZoneName: 'longOffset',
        });
        const longParts = longFmt.formatToParts(ref);
        const offsetStr = longParts.find(p => p.type === 'timeZoneName')?.value || '';
        // Convert "GMT-07:00" to "UTC-7:00", "GMT+05:30" to "UTC+5:30", "GMT" to "UTC"
        let utcStr = offsetStr.replace('GMT', 'UTC');
        // Remove leading zero: UTC-07:00 → UTC-7:00, UTC+05:30 → UTC+5:30
        utcStr = utcStr.replace(/([+-])0(\d)/, '$1$2');

        return `(${abbr})\u00a0${utcStr}`;
    } catch {
        return '';
    }
}

// Display location
function updateLocationDisplay(): void {
    if (lat === 0 && lon === 0 && needsPrompt) {
        locationName.textContent = 'No location set';
        locationDetail.textContent = 'Use the Set button to choose a location';
        return;
    }
    const cityName = getState().city || null;
    if (cityName) {
        locationName.textContent = cityName;
    } else if (isCityDataLoaded()) {
        const closest = findClosestCity(lat, lon);
        if (closest) {
            locationName.textContent = closest.shortLabel;
            if (isPersistentMode() && !getState().city) setState({ city: closest.shortLabel });
        } else {
            locationName.textContent = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
        }
    } else {
        // DB not parsed yet — show coords and resolve in the background (parse on
        // demand), persisting the derived city so future loads skip the DB.
        locationName.textContent = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
        loadCityData().then(() => {
            if (!getState().city) {
                const c = findClosestCity(lat, lon);
                if (c) {
                    locationName.textContent = c.shortLabel;
                    if (isPersistentMode()) setState({ city: c.shortLabel });
                }
            }
            if (!dialogShown()) releaseCityData();
        }).catch(() => {});
    }
    const tzInfo = formatTimezoneInfo(locationTimezone);
    const tzDisplayStr = locationTimezone || 'Browser TZ';
    const detail = tzInfo
        ? `${lat.toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'W'}  ·  ${tzDisplayStr} ${tzInfo}`
        : `${lat.toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'W'}  ·  ${tzDisplayStr}`;
    locationDetail.textContent = detail;
}
updateLocationDisplay();

// --- Location dialog (shared module) ---
const locationDialog = initLocationDialog({
    initialLat: lat,
    initialLon: lon,
    needsPrompt,
    onLocationChange: (info) => {
        // Update our location state
        lat = info.lat;
        lon = info.lon;
        locationTimezone = info.timezone;
        tzDeltaMs = computeTzDeltaMs(locationTimezone);
        needsPrompt = false;

        // Persist so the location survives reload.
        if (info.sourceType === 'browser') {
            // Persist bloc intent *with* the fix, so a reload seeds the display
            // (no 0,0 flash) and can skip the DB while stationary.
            const derived = isCityDataLoaded() ? (findClosestCity(info.lat, info.lon)?.shortLabel ?? null) : null;
            setState({ bloc: true, lsrc: 'browser', lat: info.lat, lon: info.lon, city: derived, tz: info.timezone || null });
        } else {
            setState({ bloc: false, lsrc: info.sourceType, lat: info.lat, lon: info.lon, city: info.source || null, tz: info.timezone || null });
        }

        // Rebuild the astronomy environment with new location
        env = createAstroEnvironment(lat, lon, getNow, locationTimezone);

        // Refresh all displays
        updateLocationDisplay();
        updateTimeDisplay();
        resetAllSchedules();   // re-evaluate the catalog against the new env
        scheduleFrame();
    },
});

if (locationDialog) {
    setLocationBtn.addEventListener('click', () => {
        const s = getState();
        if (s.lat !== null && s.lon !== null) {
            locationDialog.updateState(s.lat, s.lon, locationSourceOf(s), s.city || '', s.city || '');
        }
        locationDialog.show();
    });

    // Auto-show the location dialog on first visit (no URL location)
    if (needsPrompt) {
        locationDialog.show();
    }

    // Handle bloc=1: request browser location on startup
    if (urlState.bloc && !hasUrlLocation) {
        requestBrowserLocation(10000).then(result => {
            if (result.status === 'success') {
                // Apply via the same path as the dialog's onLocationChange
                const tz = resolveTimezone(result.lat, result.lon, null);
                lat = result.lat;
                lon = result.lon;
                locationTimezone = tz;
                tzDeltaMs = computeTzDeltaMs(locationTimezone);
                needsPrompt = false;
                // Seed the fix so the next reload shows it immediately (no 0,0
                // flash) and can skip the DB while stationary; the city name is
                // filled by updateLocationDisplay's reverse-geocode.
                if (isPersistentMode()) setState({ bloc: true, lsrc: 'browser', lat, lon, tz: locationTimezone || null });
                locationDialog.updateState(lat, lon, 'browser', '', '');
                env = createAstroEnvironment(lat, lon, getNow, locationTimezone);
                updateLocationDisplay();
                updateTimeDisplay();
                resetAllSchedules();   // re-evaluate the catalog against the new env
                scheduleFrame();
            } else {
                // Browser denied or timed out — show location prompt
                needsPrompt = true;
                locationDialog.setNeedsPrompt(true);
                if (result.status === 'denied') {
                    locationDialog.setGeoPermission('denied');
                }
                locationDialog.show();
            }
        });
    } else if (urlState.bloc && hasUrlLocation) {
        // Seeded bloc: the display already shows the stored last-known location.
        // Tint it yellow while refreshing geolocation quietly in the background;
        // update only if we've moved beyond the reuse threshold. Failure/denial
        // keeps the (valid) seed — genuine "no location"/"DB unavailable" errors
        // surface elsewhere.
        if (locationName) locationName.style.color = LOCATING_TINT;
        requestBrowserLocation(10000).then(result => {
            if (result.status !== 'success') { notifyBlocRefreshFailed(); return; }
            if (haversineKm(lat, lon, result.lat, result.lon) <= 16) return;  // stationary
            const tz = resolveTimezone(result.lat, result.lon, null);
            lat = result.lat;
            lon = result.lon;
            locationTimezone = tz;
            tzDeltaMs = computeTzDeltaMs(locationTimezone);
            // Moved: reseed and clear the stale city so updateLocationDisplay
            // reverse-geocodes the new spot.
            if (isPersistentMode()) setState({ bloc: true, lsrc: 'browser', lat, lon, city: null, tz });
            locationDialog.updateState(lat, lon, 'browser', '', '');
            env = createAstroEnvironment(lat, lon, getNow, locationTimezone);
            updateLocationDisplay();
            updateTimeDisplay();
            resetAllSchedules();
            scheduleFrame();
        }).catch(() => notifyBlocRefreshFailed()).finally(() => {
            if (locationName) locationName.style.color = '';
        });
    }
}

// --- Time controller ---
const timeController = new TimeController();

// Restore time state from URL (mirrors Chronometer), enabling deep-links to a
// specific time (e.g. from Chronometer to the Inspector at the same instant).
if (urlState.off !== null && !isNaN(urlState.off)) {
    timeController.setOffset(urlState.off);
} else if (urlState.t !== null && !isNaN(urlState.t)) {
    timeController.setTime(new Date(urlState.t));
    if (urlState.dir === 1) { timeController.setDirection(1); timeController.setRate(null); }
    else if (urlState.dir === -1) { timeController.setDirection(-1); timeController.setRate(null); }
    // dir === 0 stays stopped (setTime already stops)
}

// --- Create the astronomy environment ---
// getNow returns the controller's display time, wrapped so the updater can
// transiently evaluate "ahead" at a future display time (eval-ahead).
const { getNow, withDisplayTime } = makeOverridableGetNow(() => timeController.getDisplayTime());

let env = createAstroEnvironment(lat, lon, getNow, locationTimezone);

// The updater owns the catalog's ObsValue collection.
const updater = new Updater();

// ============================================================================
// Time display
// ============================================================================

function formatTime(date: Date): string {
    const h = date.getHours().toString().padStart(2, '0');
    const m = date.getMinutes().toString().padStart(2, '0');
    const s = date.getSeconds().toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
}

function formatDate(date: Date): string {
    const options: Intl.DateTimeFormatOptions = {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: locationTimezone,
    };
    return date.toLocaleDateString('en-US', options);
}

function updateTimeDisplay(): void {
    const now = getNow();
    // Shift to target timezone for display
    const shifted = tzDeltaMs !== 0 ? new Date(now.getTime() + tzDeltaMs) : now;
    timeMainEl.textContent = formatTime(shifted);
    // Subsecond portion (to the nearest ms), dimmer via the .time-subsec class.
    timeSubsecEl.textContent = `.${shifted.getMilliseconds().toString().padStart(3, '0')}`;
    dateDisplay.textContent = formatDate(now);
    tzDisplay.textContent = formatTimezoneInfo(locationTimezone, now);
}

// ============================================================================
// Date-interval formatting (catalog LT cells)
// ============================================================================

/** Epoch reference for date interval conversion: 2001-01-01T00:00:00Z */
const EPOCH_2001_MS = 978307200000;

/**
 * Format a value interpreted as a dateInterval (seconds since 2001-01-01Z) as a
 * local time-of-day in the configured timezone. Returns '—' when out of range /
 * NaN (e.g. a polar no-rise-set sentinel).
 */
function formatDateIntervalTime(value: number): string {
    const dateMs = value * 1000 + EPOCH_2001_MS;
    if (!isFinite(dateMs) || dateMs <= -6.2e13 || dateMs >= 2.5e14) return '—';
    const d = new Date(dateMs);
    if (locationTimezone) {
        try {
            return new Intl.DateTimeFormat('en-US', {
                timeZone: locationTimezone,
                hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
            }).format(d);
        } catch {
            return d.toISOString().slice(11, 19);
        }
    }
    return d.toISOString().slice(11, 19);
}

// ============================================================================
// Share button + cross-tab sync
// ============================================================================

// Share button — copy a link encoding the current time/location/config.
initShareButton({ getState });

// Help ("ℹ") popover — shared wiring; the General Help iframe drops the
// topics that don't apply via the app=inspector param (see help.html).
initHelpPopover({ generalHelpUrl: 'help.html?embed=1&app=inspector', app: 'inspector' });

// Live cross-tab sync: when another tab (or app) changes the shared location
// or time, apply it here without a reload.
function applyTimeFromState(s: ReturnType<typeof getState>): boolean {
    if (s.off !== null) { timeController.setOffset(s.off); return true; }
    if (s.t !== null) {
        timeController.setTime(new Date(s.t));
        if (s.dir === 1) { timeController.setDirection(1); timeController.setRate(null); }
        else if (s.dir === -1) { timeController.setDirection(-1); timeController.setRate(null); }
        return true;
    }
    // Real-time: only reset if not already real-time (avoid churn on a live clock).
    if (!timeController.isRealTime) { timeController.reset(); return true; }
    return false;
}

onSharedChange((s) => {
    let changed = false;
    if (s.lat !== null && s.lon !== null &&
        (s.lat !== lat || s.lon !== lon || (s.tz || undefined) !== locationTimezone)) {
        lat = s.lat;
        lon = s.lon;
        locationTimezone = s.tz || resolveTimezone(lat, lon, null);
        tzDeltaMs = computeTzDeltaMs(locationTimezone);
        needsPrompt = false;
        urlState.city = s.city;
        env = createAstroEnvironment(lat, lon, getNow, locationTimezone);
        updateLocationDisplay();
        resetAllSchedules();
        changed = true;
    }
    if (applyTimeFromState(s)) changed = true;
    if (changed) { updateTimeDisplay(); scheduleFrame(); }
});

// ============================================================================
// Ephemeris catalog
// ============================================================================

interface CatalogHandle {
    cell: CatalogCell;
    obs: ObsValue;
    valueEl: HTMLElement;
    last: string;  // last rendered string, to skip redundant DOM writes
}

const catalogHandles: CatalogHandle[] = [];

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
const KM_PER_AU = 149597870.7;
const MINUS = '−';
const APOS = '’';

// Browser-time diagnostic row: raw wall-clock via performance.now(), no
// TimeController/ObsValue in the path. Injected into the Time catalog group.
let browserTimeEl: HTMLElement | null = null;
let browserTimeRowEl: HTMLElement | null = null;
let lastBrowserTimeStr = '';

/** Build the catalog DOM and its parallel ObsValue list (once, at startup). */
function buildCatalog(): void {
    // Frozen: every catalog cell evaluates its expression once at construction;
    // freezing pins the whole storm to one instant so the astro cache isn't
    // re-keyed per elapsed ms (planning/2026-08-22-astro-slop-zero.md §4).
    timeController.withFrozenFrame(buildCatalogFrozen);
}

function buildCatalogFrozen(): void {
    const now = performance.now();
    for (const group of CATALOG) {
        const groupEl = document.createElement('section');
        groupEl.className = 'cat-group';
        const nameEl = document.createElement('h2');
        nameEl.className = 'cat-group-name';
        nameEl.textContent = group.name;
        groupEl.appendChild(nameEl);

        for (const row of group.rows) {
            const rowEl = document.createElement('div');
            rowEl.className = row.layout === 'fields' ? 'cat-row cat-row-fields' : 'cat-row';
            // Always render the label span so it occupies grid track 1 (keeps the
            // value columns aligned even for unlabeled rows).
            const lbl = document.createElement('span');
            lbl.className = 'cat-row-label';
            lbl.textContent = row.rowLabel ?? '';
            rowEl.appendChild(lbl);
            // Cells go in a wrapper (display:contents on wide layouts, the
            // wrapping flex container on narrow ones — see inspector.html CSS).
            const cellsEl = document.createElement('div');
            cellsEl.className = 'cat-cells';
            rowEl.appendChild(cellsEl);
            for (const cell of row.cells) {
                const cellEl = document.createElement('div');
                cellEl.className = 'cat-cell';
                if (cell.label) {
                    const cl = document.createElement('span');
                    cl.className = 'cat-cell-label';
                    cl.textContent = cell.label;
                    cellEl.appendChild(cl);
                }
                const valueEl = document.createElement('span');
                valueEl.className = 'cat-cell-value';
                valueEl.textContent = '—';
                cellEl.appendChild(valueEl);
                cellsEl.appendChild(cellEl);

                const discrete = tagIsDiscrete(cell.tag);
                const obs = createObsValue(
                    {
                        name: cell.expr, expr: cell.expr, updateInterval: cell.updateInterval,
                        evalAhead: !discrete, discrete, linear: !tagIsAngular(cell.tag),
                        // Digital readout: jump to the new value on stop/step rather
                        // than creep at a magnitude-mismatched settle speed.
                        animSpeed: JUMP,
                    },
                    env, now, getNow,
                );
                updater.add(obs);  // the Updater owns the catalog collection
                catalogHandles.push({ cell, obs, valueEl, last: '' });
            }
            groupEl.appendChild(rowEl);
        }
        catalogEl.appendChild(groupEl);
    }

    // Inject the "Browser time" diagnostic row into the first group (Time).
    const timeGroupEl = catalogEl.querySelector('.cat-group');
    if (timeGroupEl) {
        const btRow = document.createElement('div');
        btRow.className = 'cat-row';
        const btLabel = document.createElement('span');
        btLabel.className = 'cat-row-label';
        btLabel.textContent = 'Browser time';
        btRow.appendChild(btLabel);
        const btCells = document.createElement('div');
        btCells.className = 'cat-cells';
        btRow.appendChild(btCells);
        const btCell = document.createElement('div');
        btCell.className = 'cat-cell';
        const btValue = document.createElement('span');
        btValue.className = 'cat-cell-value';
        btValue.textContent = '—';
        btCell.appendChild(btValue);
        btCells.appendChild(btCell);
        timeGroupEl.appendChild(btRow);
        browserTimeEl = btValue;
        browserTimeRowEl = btRow;
    }
}

/** Re-evaluate the catalog against the current env/time. */
function resetAllSchedules(): void {
    updater.reset();
}

// ── Value formatters by tag ─────────────────────────────────────────────────

function pad2(n: number): string { return n.toString().padStart(2, '0'); }
function pad3(n: number): string { return n.toString().padStart(3, '0'); }

/** Group an integer-digit string with compressed apostrophe thousands separators. */
function groupThousands(digits: string): string {
    let out = '';
    for (let i = 0; i < digits.length; i++) {
        if (i > 0 && (digits.length - i) % 3 === 0) out += `<span class="kilo-sep">${APOS}</span>`;
        out += digits[i];
    }
    return out;
}

function fmtAngle(v: number): string {
    if (!isFinite(v)) return '—';
    let deg = v * 180 / Math.PI;
    deg = ((deg % 360) + 360) % 360;
    return `${deg.toFixed(2)}°`;
}

function fmtDeg(v: number): string {
    if (!isFinite(v)) return '—';
    const deg = v * 180 / Math.PI;
    return `${deg < 0 ? MINUS : ''}${Math.abs(deg).toFixed(2)}°`;
}

/** Node–syzygy gap: node-minus-Sun longitude → distance from the nearest
 *  point where new moons (Δ=0) or full moons (Δ=180°) occur. Fed the
 *  Moon-nearest node, the nearer syzygy is the one the Moon is approaching. */
function fmtNodeGap(v: number): string {
    if (!isFinite(v)) return '—';
    let deg = v * 180 / Math.PI;
    deg = ((deg % 360) + 360) % 360;
    const fromNew = Math.min(deg, 360 - deg);
    const fromFull = Math.abs(deg - 180);
    return fromNew <= fromFull
        ? `${fromNew.toFixed(2)}° from new moon`
        : `${fromFull.toFixed(2)}° from full moon`;
}

function fmtInt(v: number): string {
    if (!isFinite(v)) return '—';
    return Math.round(v).toString();
}

function fmtNum(v: number): string {
    if (!isFinite(v)) return '—';
    return Number.isInteger(v) ? v.toString() : v.toFixed(3);
}

/** Seconds-of-minute → zero-padded "SS.sss" (constant width — a varying width
 *  makes the wrapped Clock row blip between one and two lines). */
function fmtSec(v: number): string {
    if (!isFinite(v)) return '—';
    const totalMs = Math.round(v * 1000);
    const ms = totalMs % 1000;
    const ss = Math.floor(totalMs / 1000);
    return `${pad2(ss)}.${pad3(ms)}`;
}

function fmtBool(v: number): string {
    if (!isFinite(v)) return '—';
    return Math.round(v) !== 0 ? 'yes' : 'no';
}

/** Basel's eclipse-kind wheel text, indexed by the collapsed legacyEclipseKind()
 *  value (the wheel's blank "no eclipse" slot shown as "None"). */
const ECLIPSE_KIND_NAMES = [
    'None', 'Sun not up', 'Partial Solar', 'Annular Solar',
    'Total Solar', 'Moon not up', 'Partial Lunar', 'Total Lunar',
];

function fmtEclipseKind(v: number): string {
    if (!isFinite(v)) return '—';
    return ECLIPSE_KIND_NAMES[Math.round(v)] ?? '—';
}

/** Which lunar node the Moon is currently closest to (0/1). */
function fmtNodeKind(v: number): string {
    if (!isFinite(v)) return '—';
    return Math.round(v) !== 0 ? 'Descending' : 'Ascending';
}

function fmtWeekday(v: number): string {
    if (!isFinite(v)) return '—';
    const idx = ((Math.round(v) % 7) + 7) % 7;
    return `${idx} (${WEEKDAY_NAMES[idx]})`;
}

function fmtMonth(v: number): string {
    if (!isFinite(v)) return '—';
    const idx = ((Math.round(v) % 12) + 12) % 12;
    return `${idx} (${MONTH_NAMES[idx]})`;
}

/** English ordinal: 1→1st, 2→2nd, 3→3rd, 4→4th, 11→11th, 21→21st… */
function ordinal(n: number): string {
    const v = n % 100;
    const suffix = (v >= 11 && v <= 13) ? 'th'
        : (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
    return `${n}${suffix}`;
}

/** dayNumber is 0-based (0 = 1st); show raw value + the calendar day as ordinal. */
function fmtDay(v: number): string {
    if (!isFinite(v)) return '—';
    const n = Math.round(v);
    return `${n} (${ordinal(n + 1)})`;
}

/** Seconds → "HH:MM:SS.sss" with sign. */
function fmtHMS(seconds: number): string {
    if (!isFinite(seconds)) return '—';
    const sign = seconds < 0 ? MINUS : '';
    const totalMs = Math.round(Math.abs(seconds) * 1000);
    const ms = totalMs % 1000;
    let rem = Math.floor(totalMs / 1000);
    const ss = rem % 60; rem = Math.floor(rem / 60);
    const m = rem % 60; const h = Math.floor(rem / 60);
    return `${sign}${pad2(h)}:${pad2(m)}:${pad2(ss)}.${pad3(ms)}`;
}

/** Signed clock offset in seconds → "±HH:MM" (whole minutes). */
function fmtHM(seconds: number): string {
    if (!isFinite(seconds)) return '—';
    const sign = seconds < 0 ? MINUS : '+';
    const totalMin = Math.round(Math.abs(seconds) / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${sign}${pad2(h)}:${pad2(m)}`;
}

/** Small signed seconds (EOT) → "±MM:SS.sss". */
function fmtMS(seconds: number): string {
    if (!isFinite(seconds)) return '—';
    const sign = seconds < 0 ? MINUS : '+';
    const totalMs = Math.round(Math.abs(seconds) * 1000);
    const ms = totalMs % 1000;
    let rem = Math.floor(totalMs / 1000);
    const ss = rem % 60; const m = Math.floor(rem / 60);
    return `${sign}${pad2(m)}:${pad2(ss)}.${pad3(ms)}`;
}

/** AU value → "X.xxxx AU" + dimmer grouped km (returns HTML). */
function fmtDist(au: number): string {
    if (!isFinite(au)) return '—';
    const auStr = `${au.toFixed(au < 1 ? 5 : 4)} AU`;
    const kmStr = `${groupThousands(Math.round(au * KM_PER_AU).toString())} km`;
    return `${auStr}<span class="dist-km">${kmStr}</span>`;
}

/** Returns true if the formatter emits HTML (vs plain text). */
function tagIsHtml(tag: Tag): boolean { return tag === 'DIST'; }

function formatCell(tag: Tag, v: number): string {
    switch (tag) {
        case 'A': return fmtAngle(v);
        case 'NGAP': return fmtNodeGap(v);
        case 'Ldeg': return fmtDeg(v);
        case 'Num': return fmtNum(v);
        case 'SEC': return fmtSec(v);
        case 'Int': return fmtInt(v);
        case 'BOOL': return fmtBool(v);
        case 'WD': return fmtWeekday(v);
        case 'MO': return fmtMonth(v);
        case 'DAY': return fmtDay(v);
        case 'HMS': return fmtHMS(v);
        case 'HM': return fmtHM(v);
        case 'MS': return fmtMS(v);
        case 'LT': return formatDateIntervalTime(v);
        case 'DIST': return fmtDist(v);
        case 'EK': return fmtEclipseKind(v);
        case 'ND': return fmtNodeKind(v);
    }
}

/** Per-frame: render changed catalog cells from their (already-advanced) values.
 *  The Updater advances the ObsValues; this only formats + writes the DOM. */
function renderCatalog(): void {
    for (const h of catalogHandles) {
        const str = formatCell(h.cell.tag, h.obs.currentValue);
        if (str === h.last) continue;  // skip redundant DOM writes
        h.last = str;
        if (tagIsHtml(h.cell.tag)) h.valueEl.innerHTML = str;
        else h.valueEl.textContent = str;
    }
}

/**
 * Render the "Browser time" diagnostic row from the raw browser clock.
 * Uses performance.timeOrigin + performance.now() → Date, bypassing
 * TimeController and ObsValue entirely. Grayed out when stopped (the
 * comparison to display time is meaningless when the clock isn't running).
 */
function renderBrowserTime(): void {
    if (!browserTimeEl || !browserTimeRowEl) return;
    const stopped = timeController.isStopped;
    browserTimeRowEl.style.opacity = stopped ? '0.35' : '';
    if (stopped) return;  // no point updating the text while grayed out
    const wallMs = performance.timeOrigin + performance.now();
    const wallDate = new Date(wallMs);
    // Apply the same tz shift the header uses so the comparison is apples-to-apples.
    const shifted = tzDeltaMs !== 0 ? new Date(wallDate.getTime() + tzDeltaMs) : wallDate;
    const secSinceMidnight = shifted.getHours() * 3600 + shifted.getMinutes() * 60
        + shifted.getSeconds() + shifted.getMilliseconds() / 1000;
    const str = fmtHMS(secSinceMidnight);
    if (str !== lastBrowserTimeStr) {
        lastBrowserTimeStr = str;
        browserTimeEl.textContent = str;
    }
}

// ============================================================================
// Main update loop
// ============================================================================

// Page-level FPS overlay (enabled via ?fps) — shared with Chronometer/Observatory.
const fpsIndicator = createFpsIndicator(urlState.fps);

// --- Idle scheduler (mirrors Observatory) ---
// The loop runs while time is moving or an animation is settling, then goes idle.
// Transport actions and edits restart it via scheduleFrame().
let rafId: number | null = null;
let inTick = false;
let frameRequestedDuringTick = false;

function scheduleFrame(): void {
    if (inTick) { frameRequestedDuringTick = true; return; }
    if (rafId === null) rafId = requestAnimationFrame(tick);
}

/** One-shot: fires the load-progress bar's __appReady handoff on first paint. */
let firstFramePainted = false;

/**
 * rAF callback: delegates to tickBody with an unconditional cleanup backstop —
 * a thrown frame would otherwise stick the frame snapshot forever (clock
 * frozen, withFrozenFrame no-oping at the stale time) AND leave the inTick
 * re-entry guard wedged. Both resets are idempotent after a normal frame.
 * See planning/2026-08-22-slop-hardening.md §2.
 */
function tick(): void {
    try {
        tickBody();
    } finally {
        inTick = false;
        timeController.endFrame();
    }
}

function tickBody(): void {
    rafId = null;
    inTick = true;
    frameRequestedDuringTick = false;
    const perfNow = performance.now();

    timeController.checkTick(perfNow);
    timeController.beginFrame();

    // Advance the catalog from one timing context (the controller↔updater seam).
    const ctx = timingContextForFrame(timeController);
    updater.tick(env, perfNow, getNow, withDisplayTime, ctx);

    updateTimeDisplay();
    renderCatalog();
    renderBrowserTime();
    timeUI?.updateTimeUI();

    // First-frame handoff to the load-progress bar (planning §4g): the catalog
    // is now rendered, so the bootstrap can drop its "Initializing…" overlay.
    if (!firstFramePainted) {
        firstFramePainted = true;
        (window as { __appReady?: () => void }).__appReady?.();
    }

    timeController.clampDisplayTime();
    timeController.endFrame();

    const continuous = !timeController.isStopped || updater.anyAnimating();
    fpsIndicator?.recordFrame(continuous, performance.now() - perfNow);

    inTick = false;
    if (continuous || frameRequestedDuringTick) {
        rafId = requestAnimationFrame(tick);
    }
}

// --- Wire the time-controls UI ---
// Time-state (t/off/dir) persistence lives in the shared layer; the header
// app-nav links flush it just before navigating.
function writeTimeState(): void {
    flushTimeState(timeController);
}

// The catalog updater is reset automatically on transitions by the shared
// controls (we pass it below), and `writeTimeState` defaults to the shared
// writer — no custom transition callbacks needed.
const timeUI: TimeControlsAPI | null = initTimeControls({
    timeController,
    updater,
    getTimezone: () => locationTimezone,
    getTzDeltaMs: () => tzDeltaMs,
    getLat: () => lat,
    getLon: () => lon,
    ensureSchedulerRunning: () => { scheduleFrame(); },
});

// --- Cross-app navigation (header icons + i/o/c/a) and page hotkeys ---
// Time state is flushed (writeTimeState) just before navigation so the target
// app opens at the exact current time, even mid-scrub. Key table:
// help.html#hotkeys.
initAppNavLinks(writeTimeState);
registerAppNavHotkeys(writeTimeState);
registerHotkey('h', () => document.getElementById('info-btn')?.click());
registerHotkey('?', () => openGeneralHelpTopic('#hotkeys'));
registerHotkey('t', () => document.getElementById('time-bar-label')?.click());
registerHotkey('n', () => document.getElementById('time-bar-now')?.click());
registerHotkey('l', () => document.getElementById('set-location-btn')?.click());

// --- Corner-chrome layout: keep the fixed top-right buttons off the header ---
// Same engine as the Chronometer face pages (shared/chrome-layout.ts): try
// row / L / column shapes for the button group against the centered header
// text; when nothing clears in place, push the whole pinned column down by
// the minimum that does (the catalog just loses that height and scrolls).
// Text boxes are measured with Ranges — the time display's innerHTML is
// rewritten every frame, so wrapper spans would not survive — and the
// full-width <p> blocks would register as colliding even where their
// centered text doesn't.

const CHROME_IDS = ['share-btn', 'info-btn', 'observatory-link', 'chronometer-link'];
const CHROME_EDGE_MARGIN = 12; // matches the page's authored top/right insets
let appliedChromeDy = 0;

function chromeAvoidRect(el: Element | null, whole: boolean): Rect | null {
    if (!el) return null;
    let r: DOMRect;
    if (whole) {
        r = el.getBoundingClientRect();
    } else {
        const range = document.createRange();
        range.selectNodeContents(el);
        r = range.getBoundingClientRect();
    }
    if (r.width <= 0 || r.height <= 0) return null;
    // Un-apply the current push-down so the engine sees baseline positions.
    return { left: r.left, top: r.top - appliedChromeDy, right: r.right, bottom: r.bottom - appliedChromeDy };
}

function layoutTopChrome(): void {
    const items: ChromeItem[] = [];
    for (const id of CHROME_IDS) {
        const el = document.getElementById(id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        items.push({ id, w: r.width, h: r.height });
    }

    const rects: Rect[] = [];
    for (const el of [
        document.querySelector('.app-title'),
        timeDisplay, dateDisplay,
        document.getElementById('tz-display'),
        document.getElementById('time-bar'),
    ]) {
        const r = chromeAvoidRect(el, false);
        if (r) rects.push(r);
    }
    const cat = chromeAvoidRect(document.getElementById('catalog'), true);
    if (cat) rects.push(cat);

    const result = layoutChrome(
        [{ corner: 'tr', items, defaultSplit: items.length }],
        { circles: [], rects },
        {
            viewportW: document.documentElement.clientWidth,
            maxDy: Number.POSITIVE_INFINITY,
            edgeMargin: CHROME_EDGE_MARGIN,
        },
    );

    for (const p of result.placed) {
        const el = document.getElementById(p.id);
        if (!el) continue;
        el.style.top = `${p.top}px`;
        if (p.right !== undefined) el.style.right = `${p.right}px`;
    }

    const dy = Math.ceil(result.dy);
    if (dy !== appliedChromeDy) {
        appliedChromeDy = dy;
        const pinned = document.querySelector<HTMLElement>('.pinned-top');
        if (pinned) pinned.style.paddingTop = dy > 0 ? `${dy}px` : '';
    }
}

let chromeResizeTimer: ReturnType<typeof setTimeout> | null = null;
window.addEventListener('resize', () => {
    if (chromeResizeTimer !== null) clearTimeout(chromeResizeTimer);
    chromeResizeTimer = setTimeout(() => {
        chromeResizeTimer = null;
        layoutTopChrome();
    }, 150);
});

// Initial build + start
buildCatalog();
updateTimeDisplay();
renderBrowserTime();
timeUI?.updateTimeUI();
scheduleFrame();
// First chrome pass after the initial paint, and again once the webfonts
// land (the time display's measured width changes with the real font).
requestAnimationFrame(() => layoutTopChrome());
document.fonts?.ready.then(() => layoutTopChrome());

// Backstop timezone re-resolution: if startup fell back to the browser zone
// because the city DB wasn't loaded (a direct link with lat/lon but no tz),
// correct it once the DB is available. resolveTimezoneFromDb awaits the load and
// tolerates a racing releaseCityData() (there is no refcount). On a change we
// rebuild the env and refresh the catalog, mirroring onLocationChange.
if (tzNeedsResolution) {
    resolveTimezoneFromDb(lat, lon).then(resolved => {
        tzNeedsResolution = false;
        if (resolved && resolved !== locationTimezone) {
            locationTimezone = resolved;
            tzDeltaMs = computeTzDeltaMs(locationTimezone);
            env = createAstroEnvironment(lat, lon, getNow, locationTimezone);
            if (isPersistentMode()) setState({ tz: locationTimezone });
            updateLocationDisplay();
            updateTimeDisplay();
            resetAllSchedules();   // re-evaluate the catalog against the new env
            scheduleFrame();
        }
        if (!dialogShown()) releaseCityData();  // drop the parsed DB unless the dialog needs it
    });
}

console.log('[Inspector] Initialized — lat:', lat, 'lon:', lon, 'tz:', locationTimezone,
    '— catalog values:', updater.all.length);
