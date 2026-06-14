/**
 * Inspector — live astronomy data explorer.
 *
 * Entry point for the Inspector app. Imports ONLY from:
 *   - src/shared/   (astro-env, url-state, tz-resolve, city-search)
 *   - src/expr/     (parser, evaluator)
 *   - src/astronomy/ (rise/set for sunrise/sunset)
 *
 * Does NOT import from src/watch/ — keeps the bundle clean of
 * Chronometer-specific code (renderer, XML parser, Terra slots, etc.)
 */

import { createAstroEnvironment, computeTzDeltaMs } from '../shared/astro-env.js';
import { createObsValue, JUMP, type ObsValue } from '../shared/obs-value.js';
import {
    updateObsValues, animateObsValues, resetObsValueSchedules, makeOverridableGetNow,
    Updater, timingContextForFrame, type TimingContext,
} from '../shared/updater.js';
import { TimeController } from '../shared/time-controller.js';
import { initTimeControls, writeTimeStateToUrl, type TimeControlsAPI } from '../shared/time-controls-ui.js';
import { createFpsIndicator } from '../shared/fps-indicator.js';
import { getState, setState, initAppState } from '../shared/app-state.js';
import { initShareButton } from '../shared/share-button.js';
import { resolveTimezone } from '../shared/tz-resolve.js';
import { findClosestCity } from '../shared/city-search.js';
import { initLocationDialog, requestBrowserLocation } from '../shared/location-dialog.js';
import { EXPR_METADATA, CATEGORY_ORDER, type ExprEntry } from './expr-metadata.js';
import { CATALOG, tagIsAngular, tagIsDiscrete, type CatalogCell, type Tag } from './catalog.js';

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
const exprInput = document.getElementById('expr-input') as HTMLInputElement;
const exprResults = document.getElementById('expr-results')!;
const exprNumber = document.getElementById('expr-number')!;
const exprAngle = document.getElementById('expr-angle')!;
const exprDate = document.getElementById('expr-date')!;
const exprError = document.getElementById('expr-error')!;
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

// If no timezone in URL, resolve it from lat/lon (only if we have a location)
if (!locationTimezone && hasUrlLocation) {
    locationTimezone = resolveTimezone(lat, lon, null);
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
    const cityName = urlState.city || null;
    if (cityName) {
        locationName.textContent = cityName;
    } else {
        // Try to find the closest city
        const closest = findClosestCity(lat, lon);
        if (closest) {
            locationName.textContent = closest.shortLabel;
        } else {
            locationName.textContent = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
        }
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

        // Write to URL so the location persists on reload
        if (info.sourceType === 'browser') {
            // For browser location, use bloc=1 so next reload re-asks
            setState({ bloc: true, lat: null, lon: null, city: null, tz: null });
        } else {
            setState({ lat: info.lat, lon: info.lon, city: info.source || null, tz: info.timezone || null });
        }

        // Rebuild the astronomy environment with new location
        env = createAstroEnvironment(lat, lon, getNow, locationTimezone);

        // Refresh all displays
        updateLocationDisplay();
        updateTimeDisplay();
        rebuildExprValues();   // snap expression to the new environment
        resetAllSchedules();   // re-evaluate the catalog against the new env
        scheduleFrame();
    },
});

if (locationDialog) {
    setLocationBtn.addEventListener('click', () => {
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
                locationDialog.updateState(lat, lon, 'browser', '', '');
                env = createAstroEnvironment(lat, lon, getNow, locationTimezone);
                updateLocationDisplay();
                updateTimeDisplay();
                rebuildExprValues();   // snap expression to the new environment
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

// The updater owns the catalog's ObsValue collection (the expression box is
// managed separately — it has user-input error handling and rebuilds on edit).
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
// Date-interval formatting (shared by the expression box and catalog LT cells)
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
// Expression evaluator
// ============================================================================

// The expression result is driven by two ObsValues sharing the same parsed
// expression: one with **angle** semantics (for the Angle° readout — shortest-
// path wrap to [0,360°)) and one with **linear** semantics (for the Number and
// Date readouts — raw straight-line interpolation). Both use lag-free eval-ahead
// (evaluate the next 0.1s boundary, sweep there), so the readouts track real
// time with no perceptible lag while updating only 10×/s.
const EXPR_UPDATE_INTERVAL_SEC = 0.1;  // full re-eval cadence (epoch-aligned)

let lastExprText = '';
let exprAngleVal: ObsValue | null = null;   // linear:false → Angle readout
let exprLinearVal: ObsValue | null = null;  // linear:true  → Number + Date readouts
let exprValues: ObsValue[] = [];

/**
 * Rebuild (and snap) the expression ObsValues. Called when the expression text
 * or the location/environment changes — we never animate from the old
 * expression's value to the new one. Parse/eval errors are surfaced here.
 */
function rebuildExprValues(): void {
    const text = exprInput.value.trim();

    if (!text) {
        exprResults.classList.remove('visible');
        exprError.classList.remove('visible');
        lastExprText = '';
        exprAngleVal = null;
        exprLinearVal = null;
        exprValues = [];
        return;
    }

    lastExprText = text;
    const now = performance.now();
    try {
        // animSpeed: JUMP so a stopped/stepped value jumps to its new value
        // (digital readout) rather than creeping at a mis-scaled settle speed.
        const base = {
            name: 'expr', expr: text, updateInterval: EXPR_UPDATE_INTERVAL_SEC,
            evalAhead: true, animSpeed: JUMP,
        };
        exprAngleVal = createObsValue({ ...base, linear: false }, env, now, getNow);
        exprLinearVal = createObsValue({ ...base, linear: true }, env, now, getNow);
        exprValues = [exprAngleVal, exprLinearVal];
        exprError.classList.remove('visible');
        exprResults.classList.add('visible');
        renderExprValues();
        scheduleFrame();  // restart the loop if idle (e.g. while time is stopped)
    } catch (e: any) {
        exprAngleVal = null;
        exprLinearVal = null;
        exprValues = [];
        exprResults.classList.remove('visible');
        exprError.textContent = e.message || 'Parse error';
        exprError.classList.add('visible');
    }
}

/** Format the current (interpolated) ObsValue values into the three readouts. */
function renderExprValues(): void {
    if (!exprAngleVal || !exprLinearVal) return;
    const value = exprLinearVal.currentValue;     // raw number / date interval
    const angleRad = exprAngleVal.currentValue;   // angle, wrapped to [0,2π)

    // Number format (raw, linear)
    if (Number.isInteger(value) && Math.abs(value) < 1e15) {
        exprNumber.textContent = value.toString();
    } else {
        exprNumber.textContent = value.toPrecision(10);
    }

    // Angle format (radians → degrees, angle semantics)
    const degrees = angleRad * 180 / Math.PI;
    exprAngle.textContent = `${degrees.toFixed(4)}°`;

    // Date format: interpret the raw value as a dateInterval (seconds since
    // 2001-01-01T00:00:00Z)
    const dateMs = value * 1000 + EPOCH_2001_MS;
    if (isFinite(dateMs) && dateMs > -6.2e13 && dateMs < 2.5e14) {
        const d = new Date(dateMs);
        if (locationTimezone) {
            try {
                const fmt = new Intl.DateTimeFormat('en-US', {
                    timeZone: locationTimezone,
                    year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit', second: '2-digit',
                    hour12: false,
                });
                const tzAbbr = new Intl.DateTimeFormat('en-US', {
                    timeZone: locationTimezone,
                    timeZoneName: 'short',
                }).formatToParts(d).find(p => p.type === 'timeZoneName')?.value || '';
                exprDate.textContent = `${fmt.format(d)} ${tzAbbr}`;
            } catch {
                exprDate.textContent = d.toISOString().replace('T', ' ').replace('Z', ' UTC');
            }
        } else {
            exprDate.textContent = d.toISOString().replace('T', ' ').replace('Z', ' UTC');
        }
    } else {
        exprDate.textContent = '—';
    }
}

/**
 * Per-frame drive of the expression ObsValues. Managed separately from the
 * Updater because the user-typed expression can fail to evaluate; this guards
 * evaluation so a per-frame error shows in the UI without breaking the rAF loop
 * (or aborting the catalog's update pass).
 */
function tickExprValues(perfNow: number, ctx: TimingContext): void {
    if (exprValues.length === 0) return;
    try {
        updateObsValues(exprValues, env, perfNow, getNow,
            ctx.tickIntervalMs, ctx.displayDeltaSec, ctx.direction, withDisplayTime);
        animateObsValues(exprValues, perfNow);
        exprError.classList.remove('visible');
        exprResults.classList.add('visible');
        renderExprValues();
    } catch (e: any) {
        exprResults.classList.remove('visible');
        exprError.textContent = e.message || 'Evaluation error';
        exprError.classList.add('visible');
    }
}

// Listen for input changes
exprInput.addEventListener('input', () => {
    rebuildExprValues();
    updateAutocomplete();
});

// ============================================================================
// Autocomplete
// ============================================================================

const acDropdown = document.getElementById('expr-autocomplete')!;
let acItems: ExprEntry[] = [];
let acSelectedIdx = -1;

/** Extract the word fragment at the cursor for autocomplete matching. */
function getWordAtCursor(): { word: string; start: number; end: number } {
    const pos = exprInput.selectionStart ?? exprInput.value.length;
    const text = exprInput.value;
    // Walk backward from cursor to find word start
    let start = pos;
    while (start > 0 && /[a-zA-Z0-9_]/.test(text[start - 1])) start--;
    // Walk forward from cursor to find word end
    let end = pos;
    while (end < text.length && /[a-zA-Z0-9_]/.test(text[end])) end++;
    return { word: text.slice(start, pos), start, end };
}

/** Build the merged list of completions from metadata + env keys. */
function getAllCompletions(): ExprEntry[] {
    // Start with curated metadata
    const seen = new Set(EXPR_METADATA.map(e => e.name));
    const extras: ExprEntry[] = [];
    // Add any env functions not in metadata
    if (env) {
        for (const name of env.functions.keys()) {
            if (!seen.has(name)) {
                extras.push({ name, category: 'Other', desc: '', kind: 'fn' });
                seen.add(name);
            }
        }
        for (const name of env.variables.keys()) {
            if (!seen.has(name)) {
                extras.push({ name, category: 'Other', desc: '', kind: 'const' });
                seen.add(name);
            }
        }
    }
    return [...EXPR_METADATA, ...extras];
}

function updateAutocomplete(): void {
    const { word } = getWordAtCursor();
    if (word.length < 2) {
        acDropdown.classList.remove('visible');
        acItems = [];
        return;
    }
    const lc = word.toLowerCase();
    const all = getAllCompletions();
    // Filter: prefix match first, then substring match
    const prefixMatches = all.filter(e => e.name.toLowerCase().startsWith(lc));
    const subMatches = all.filter(e => !e.name.toLowerCase().startsWith(lc) && e.name.toLowerCase().includes(lc));
    acItems = [...prefixMatches, ...subMatches].slice(0, 20);

    if (acItems.length === 0 || (acItems.length === 1 && acItems[0].name.toLowerCase() === lc)) {
        acDropdown.classList.remove('visible');
        acItems = [];
        return;
    }

    acSelectedIdx = -1;
    renderAutocomplete();
    acDropdown.classList.add('visible');
}

function renderAutocomplete(): void {
    acDropdown.innerHTML = acItems.map((entry, i) => {
        const kindClass = entry.kind === 'fn' ? 'fn' : 'const';
        const kindLabel = entry.kind === 'fn' ? 'fn' : 'var';
        const sig = entry.kind === 'fn' ? (entry.sig || '()') : '';
        const selected = i === acSelectedIdx ? ' selected' : '';
        return `<div class="ac-item${selected}" data-idx="${i}">
            <span class="ac-kind ${kindClass}">${kindLabel}</span>
            <span class="ac-name">${entry.name}</span>
            <span class="ac-sig">${sig}</span>
            <span class="ac-desc">${entry.desc}</span>
        </div>`;
    }).join('');
}

function acceptAutocomplete(idx: number): void {
    const entry = acItems[idx];
    if (!entry) return;
    const { start, end } = getWordAtCursor();
    const text = exprInput.value;
    let insert = entry.name;
    if (entry.kind === 'fn') {
        insert += entry.sig || '()';
    }
    exprInput.value = text.slice(0, start) + insert + text.slice(end);
    // Place cursor: inside parens if fn with args, after everything otherwise
    const cursorPos = entry.kind === 'fn' && entry.sig && entry.sig !== '()'
        ? start + entry.name.length + 1  // after '('
        : start + insert.length;
    exprInput.setSelectionRange(cursorPos, cursorPos);
    acDropdown.classList.remove('visible');
    acItems = [];
    rebuildExprValues();
}

// Keyboard navigation for autocomplete
exprInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!acDropdown.classList.contains('visible')) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        acSelectedIdx = Math.min(acSelectedIdx + 1, acItems.length - 1);
        renderAutocomplete();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        acSelectedIdx = Math.max(acSelectedIdx - 1, 0);
        renderAutocomplete();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (acSelectedIdx >= 0) {
            e.preventDefault();
            acceptAutocomplete(acSelectedIdx);
        }
    } else if (e.key === 'Escape') {
        acDropdown.classList.remove('visible');
        acItems = [];
    }
});

// Click on autocomplete item
acDropdown.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault(); // keep focus on input
    const item = (e.target as HTMLElement).closest('.ac-item') as HTMLElement;
    if (item) {
        const idx = parseInt(item.dataset.idx!, 10);
        acceptAutocomplete(idx);
    }
});

// Close autocomplete when input loses focus
exprInput.addEventListener('blur', () => {
    // Delay to allow click events on dropdown items
    setTimeout(() => {
        acDropdown.classList.remove('visible');
        acItems = [];
    }, 150);
});

// ============================================================================
// Reference Panel
// ============================================================================

const refToggle = document.getElementById('ref-toggle')!;
const refPanel = document.getElementById('ref-panel')!;

// Share button — copy a link encoding the current time/location/config.
initShareButton({ getState });

function buildReferencePanel(): void {
    const all = getAllCompletions();
    // Group by category
    const groups = new Map<string, ExprEntry[]>();
    for (const entry of all) {
        const cat = entry.category;
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat)!.push(entry);
    }

    // Sort categories by CATEGORY_ORDER, then alphabetical for unlisted
    const catOrder = [...CATEGORY_ORDER];
    for (const cat of groups.keys()) {
        if (!catOrder.includes(cat)) catOrder.push(cat);
    }

    let html = '';
    for (const cat of catOrder) {
        const entries = groups.get(cat);
        if (!entries || entries.length === 0) continue;
        html += `<div class="ref-category">`;
        html += `<div class="ref-cat-header"><span class="ref-cat-arrow">▶</span> ${cat} <span style="color:#4b5563;font-weight:400">(${entries.length})</span></div>`;
        html += `<div class="ref-cat-body">`;
        for (const entry of entries) {
            const sig = entry.kind === 'fn' ? (entry.sig || '()') : '';
            html += `<div class="ref-item" data-name="${entry.name}" data-kind="${entry.kind}" data-sig="${entry.sig || ''}">`;
            html += `<span class="ref-item-name">${entry.name}${sig}</span>`;
            html += `<span class="ref-item-desc">${entry.desc}</span>`;
            html += `</div>`;
        }
        html += `</div></div>`;
    }
    refPanel.innerHTML = html;

    // Category toggle
    refPanel.querySelectorAll('.ref-cat-header').forEach(header => {
        header.addEventListener('click', () => {
            header.parentElement!.classList.toggle('open');
        });
    });

    // Click to insert
    refPanel.querySelectorAll('.ref-item').forEach(item => {
        item.addEventListener('click', () => {
            const el = item as HTMLElement;
            const name = el.dataset.name!;
            const kind = el.dataset.kind!;
            const sig = el.dataset.sig || '';
            let insert = name;
            if (kind === 'fn') {
                insert += sig || '()';
            }
            // Append to current input (or replace if empty)
            if (exprInput.value.trim() === '') {
                exprInput.value = insert;
            } else {
                // Insert at cursor
                const pos = exprInput.selectionStart ?? exprInput.value.length;
                const text = exprInput.value;
                exprInput.value = text.slice(0, pos) + insert + text.slice(pos);
            }
            const cursorPos = kind === 'fn' && sig && sig !== '()'
                ? exprInput.value.indexOf(insert) + name.length + 1
                : exprInput.value.indexOf(insert) + insert.length;
            exprInput.setSelectionRange(cursorPos, cursorPos);
            exprInput.focus();
            rebuildExprValues();
        });
    });
}

refToggle.addEventListener('click', () => {
    const isOpen = refPanel.classList.toggle('visible');
    refToggle.classList.toggle('active', isOpen);
    if (isOpen && refPanel.innerHTML === '') {
        buildReferencePanel();
    }
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

/** Build the catalog DOM and its parallel ObsValue list (once, at startup). */
function buildCatalog(): void {
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
            for (const cell of row.cells) {
                const cellEl = document.createElement('div');
                cellEl.className = cell.tag === 'DIST' ? 'cat-cell dist-cell' : 'cat-cell';
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
                rowEl.appendChild(cellEl);

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
}

/** Re-evaluate the catalog and the expression box against the current env/time. */
function resetAllSchedules(): void {
    updater.reset();
    resetObsValueSchedules(exprValues);
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

function fmtInt(v: number): string {
    if (!isFinite(v)) return '—';
    return Math.round(v).toString();
}

function fmtNum(v: number): string {
    if (!isFinite(v)) return '—';
    return Number.isInteger(v) ? v.toString() : v.toFixed(3);
}

function fmtBool(v: number): string {
    if (!isFinite(v)) return '—';
    return Math.round(v) !== 0 ? 'yes' : 'no';
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
        case 'Ldeg': return fmtDeg(v);
        case 'Num': return fmtNum(v);
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

function tick(): void {
    rafId = null;
    inTick = true;
    frameRequestedDuringTick = false;
    const perfNow = performance.now();

    timeController.checkTick(perfNow);
    timeController.beginFrame();

    // Advance everything from one timing context (the controller↔updater seam).
    const ctx = timingContextForFrame(timeController);
    updater.tick(env, perfNow, getNow, withDisplayTime, ctx);   // catalog
    tickExprValues(perfNow, ctx);                                // expression box

    updateTimeDisplay();
    renderCatalog();
    timeUI?.updateTimeUI();

    timeController.clampDisplayTime();
    timeController.endFrame();

    const continuous = !timeController.isStopped || updater.anyAnimating();
    fpsIndicator?.recordFrame(continuous);

    inTick = false;
    if (continuous || frameRequestedDuringTick) {
        rafId = requestAnimationFrame(tick);
    }
}

// --- Wire the time-controls UI ---
// Time-state (t/off/dir) URL persistence lives in the shared layer; the footer
// "open in <app>" links flush it just before navigating.
function writeTimeState(): void {
    writeTimeStateToUrl(timeController);
}

// The free-form expression box lives OUTSIDE the catalog updater (for error
// isolation), so it needs a custom re-arm hook on transitions. The catalog
// updater itself is reset automatically by the shared controls (we pass it
// below), and `writeTimeState` defaults to the shared writer.
function resetExprBox(): void {
    rebuildExprValues();                  // re-parse the expression against env
    resetObsValueSchedules(exprValues);   // re-evaluate the expr box next frame
}

const timeUI: TimeControlsAPI | null = initTimeControls({
    timeController,
    updater,
    getTimezone: () => locationTimezone,
    getTzDeltaMs: () => tzDeltaMs,
    getLat: () => lat,
    getLon: () => lon,
    onTimeStep: resetExprBox,
    onScrubStart: () => { resetObsValueSchedules(exprValues); },
    onScrubEnd: resetExprBox,
    onNowClicked: resetExprBox,
    onTransportChange: resetExprBox,
    ensureSchedulerRunning: () => { scheduleFrame(); },
});

// --- "Open in <app>" footer links ---
// Carry the current location + time state to Observatory / Chronometer in a new
// tab. The URL is flushed (writeTimeState) just before navigation so the link
// always reflects the exact current time, even mid-scrub.
function wireAppLink(id: string, page: string): void {
    const a = document.getElementById(id) as HTMLAnchorElement | null;
    if (!a) return;
    const setHref = () => { a.href = page + window.location.search; };
    const flushAndSet = () => { writeTimeState(); setHref(); };
    a.addEventListener('pointerdown', flushAndSet);  // before click / middle-click
    a.addEventListener('focus', flushAndSet);         // before keyboard activation
    setHref();                                        // initial href (no flush)
}
wireAppLink('open-observatory', 'observatory.html');
wireAppLink('open-chronometer', 'all.html');

// Initial build + start
buildCatalog();
updateTimeDisplay();
timeUI?.updateTimeUI();
scheduleFrame();

console.log('[Inspector] Initialized — lat:', lat, 'lon:', lon, 'tz:', locationTimezone,
    '— catalog values:', updater.all.length);
