

/**
 * Per-face data files push their data onto this global array.
 * The engine reads it at startup.
 */
interface FaceData {
    name: string;
    /** Two-letter URL abbreviation for compact picks parameter encoding. */
    urlAbbrev: string;
    xml: string;
    thumb: string;
    images: Record<string, { dataUrl: string; scale: number }>;
}

interface ChronometerEngine {
    start: () => Promise<void>;
}

declare global {
    interface Window {
        ChronometerFaces: FaceData[];
        Chronometer: ChronometerEngine;
    }
}

// Build version injected by build.sh (esbuild --define). Undefined in scratch
// builds; always access via the typeof-guarded _buildStamp().
declare const __BUILD_VERSION__: string | undefined;

import { parseWatchXML } from './watch/xml-parser.js';
import { createWatchEnvironment, computeTzDeltaMs, GAIA_SUBDIAL_DEFAULTS } from './watch/watch-env.js';
import type { TerraSlot } from './watch/watch-env.js';
import { TERRA_RING_DEFAULTS } from './watch/watch-env.js';
import { validSlotsForTz, formatSlotOffset, getStandardOffsetMinutes, olsonIdToCityName } from './watch/terra-slots.js';
import { buildStaticBlockCaches, renderFrame, BEZEL_THICKNESS_XML, setPartProfiling, resetPartProfile, getPartProfile, setWheelCacheDisabled, setHandCacheDisabled, rendererCacheMemoryBytes } from './watch/renderer.js';
import type { LoadedImage } from './watch/image-loader.js';
import { makeReDecodableImage, decodeLoadedImageForScale } from './watch/image-loader.js';
import { SCHEDULER_LOOKAHEAD_MS } from './shared/animation.js';
import { Updater, makeOverridableGetNow, timingContextForFrame, tickProfile, resetTickProfile, setTickProfiling, type WithDisplayTime } from './shared/updater.js';
import { astroProfile, resetAstroProfile, setAstroProfiling, envTzStateStale } from './shared/astro-env.js';
import { buildHandValues } from './watch/hand-values.js';
import type { Watch } from './watch/types.js';
import type { Environment } from './expr/env.js';
import type { TerminatorLeafState } from './watch/terminator.js';
import { expandTerminatorToLeaves, updateLeafAngles } from './watch/terminator.js';
import { buildTerminatorValues, buildAnalemmaValues } from './watch/hand-values.js';
import type { AnalemmaState } from './watch/analemma.js';
import { expandAnalemma } from './watch/analemma.js';
import { evalAttr } from './watch/watch-env.js';
import { TimeController, TICK_INTERVAL_MS, displaySecondsPerTick } from './shared/time-controller.js';

import { initNavigationLinks, updateNavigationLinks } from './shared/url-state.js';
import { getState, setState, initAppState, onSharedChange, getSlotOverrides, setSlotOverrides, isPersistentMode } from './shared/app-state.js';
import { createFpsIndicator } from './shared/fps-indicator.js';
import { initHelpPopover, openGeneralHelpTopic } from './shared/help-popover.js';
import { registerHotkey } from './shared/hotkeys.js';
import { initAppNavLinks, registerAppNavHotkeys } from './shared/app-nav.js';
import { initShareButton } from './shared/share-button.js';
import { loadCityData, prefetchCityData, releaseCityData, searchCities, findClosestCity, isCityDataLoaded, loadError } from './shared/city-search.js';
import { showStorageWarning } from './shared/incoming-settings-dialog.js';
import type { CityResult } from './shared/city-search.js';
import { renderGlobe, loadOSMTile } from './shared/mini-map.js';
import { resolveTimezone, resolveTimezoneFromDb } from './shared/tz-resolve.js';
import { findNextDstTransition, findPrevDstTransition } from './shared/dst-detect.js';

import { initTimeControls, flushTimeState } from './shared/time-controls-ui.js';
import { MIN_DISPLAY_DATE_MS, MAX_DISPLAY_DATE_MS } from './astronomy/es-time.js';
import { getBezelBackgroundColor, updateDynamicCompositeIcon } from './shared/composite-icon.js';

// Select the state backend before any getState()/setState() call. Phase 1-2
// keeps the URL backend active (behavior-preserving); Phase 3 enables storage.
initAppState({ app: 'chronometer' });

// Opt-in per-value tick attribution (taxes the hot path; off by default). Enable
// with ?tickprofile to break the scrub tick into eval/boundary/interp on scrub end.
const _tickProfile = typeof location !== 'undefined'
    && new URLSearchParams(location.search).has('tickprofile');
setTickProfiling(_tickProfile);
setAstroProfiling(_tickProfile);
setPartProfiling(_tickProfile);

// The flush probe (getImageData once per pure-anim frame during scrub) is
// OPT-IN via ?probe as of 2026-07-05 — previously on by default, disabled via
// ?noprobe. Two strikes killed the default: it adds a readback stall and can
// kick the probed canvas onto a slow path (Chrome, seen Phase 1), and with the
// wheel glyph-atlas renderer the per-frame readback of a canvas composed from
// many OffscreenCanvas textures trips Chrome into a page-wide *sticky*
// quarter-rate rAF throttle (~15 fps persisting after scrub ends).
// ?noprobe is still honored (wins over ?probe) so old run URLs stay valid.
const _probeEnabled = typeof location !== 'undefined'
    && new URLSearchParams(location.search).has('probe')
    && !new URLSearchParams(location.search).has('noprobe');

// ?drawstats logs face-draws/s vs loop frames/s at 1× every ~5s, to verify the
// per-face render gate (planning/2026-07-07-per-face-render-gate-plan.md):
// frames/s × enabled faces is what an ungated loop would draw.
const _drawStats = typeof location !== 'undefined'
    && new URLSearchParams(location.search).has('drawstats');

// --- Phase 1 render-perf ablation flags ---
// (planning/2026-07-03-scrub-render-perf-investigation.md — bounding ablations.)
// All are measurement flags: they may produce visual artifacts during scrub and
// only alter behavior while scrubbing (except dpr1, which sizes backing stores
// for the whole session). Composable via ?ablate=a,b · &faces=N:
//   render        — 1A: tick everything, issue no draw commands
//   staggerrender — 1B: each face draws every 2nd frame (alternating halves)
//   staggertick   — 1E: odd faces freeze on the tick frame, catch up next frame
//                   (spreads the tick-boundary update spike across two frames)
//   dpr1          — 1C: canvas backing stores at dpr 1 (quarter the pixels)
//   faces=N       — 1D: draw only the first N faces (all 16 still tick)
//   onecanvas     — Phase 2: all faces drawn into ONE shared canvas at their
//                   cell offsets (per-face canvases hidden, never dirtied) —
//                   tests the per-layer-commit-cost verdict. Whole session,
//                   not scrub-only; click-to-navigate is dead under this flag.
//   nobezel       — Phase 2: skip drawBezel (its conic/radial/linear gradients
//                   are rebuilt every frame) — sizes the bezel's total cost.
//   facebuffers   — Phase 3 ceiling prototype (measurement-only; per-face
//                   ~tick-rate stepping during scrub violates the fidelity
//                   rule): whole-face offscreen buffers rebuilt round-robin
//                   (≤4/frame, once per tick each), blitted every frame.
//                   Prices the blit substrate the sandwich design sits on.
//                   Don't combine with staggerrender/staggertick/faces.
const _ablate = new Set(
    (typeof location !== 'undefined'
        ? (new URLSearchParams(location.search).get('ablate') ?? '')
        : '').split(',').filter(Boolean));
for (const f of _ablate) {
    if (!['render', 'staggerrender', 'staggertick', 'dpr1', 'onecanvas', 'nobezel', 'facebuffers', 'nowheelcache', 'nohandcache'].includes(f)) {
        console.warn(`[scrub-perf] Unknown ?ablate flag "${f}" — ignored.`);
    }
}
// nowheelcache / nohandcache: A/B kill-switches for the wheel glyph-atlas and
// vector-hand bitmap caches (production optimizations, ON by default).
if (_ablate.has('nowheelcache')) setWheelCacheDisabled(true);
if (_ablate.has('nohandcache')) setHandCacheDisabled(true);
const _ablateRender = _ablate.has('render');
const _ablateStaggerRender = _ablate.has('staggerrender');
const _ablateStaggerTick = _ablate.has('staggertick');
const _ablateDpr1 = _ablate.has('dpr1');
const _ablateOneCanvas = _ablate.has('onecanvas');
const _ablateNoBezel = _ablate.has('nobezel');
const _ablateFaceBuffers = _ablate.has('facebuffers');
const _facesLimit = (() => {
    const n = parseInt((typeof location !== 'undefined'
        ? new URLSearchParams(location.search).get('faces')
        : null) ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : Infinity;
})();
/** Effective devicePixelRatio for canvas backing stores (1C ablation seam). */
function effectiveDpr(): number {
    return _ablateDpr1 ? 1 : (window.devicePixelRatio || 1);
}

// --- Display refresh estimate (render-perf Phase 0) ---
// One-shot rAF cadence sampler started ~1s after load: consecutive rAF deltas
// quantize to the display's frame slots, so their minimum estimates the vsync
// quantum (the median adds context if the page is busy while sampling). The
// dev VM caps rAF at 60Hz while the native test machine runs 240Hz — this is
// what tells pasted scrub-perf results apart. Reported in the scrub summary.
let _refreshMinDeltaMs: number | null = null;
let _refreshMedianDeltaMs: number | null = null;
if (typeof requestAnimationFrame !== 'undefined' && typeof document !== 'undefined') {
    const deltas: number[] = [];
    let last: number | null = null;
    let remaining = 60;
    const sample = (ts: number) => {
        if (last !== null) deltas.push(ts - last);
        last = ts;
        if (--remaining > 0) { requestAnimationFrame(sample); return; }
        deltas.sort((a, b) => a - b);
        _refreshMinDeltaMs = deltas[0] ?? null;
        _refreshMedianDeltaMs = deltas[deltas.length >> 1] ?? null;
    };
    setTimeout(() => requestAnimationFrame(sample), 1000);
}

/** Convert a face name like "Mauna Kea" or "Haleakalā" to a filename like "mauna-kea" */
function faceNameToSlug(name: string): string {
    return name
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip diacritics
        .toLowerCase()
        .replace(/\s+/g, '-');
}

// ============================================================================
// Location helpers
// ============================================================================

const DEMO_LAT = 37.3349;   // Apple Park, Cupertino
const DEMO_LON = -122.0090;

type GeoResult =
    | { status: 'success'; lat: number; lon: number }
    | { status: 'denied' }
    | { status: 'timeout' }
    | { status: 'unavailable' };

/**
 * Request the device location via the browser geolocation API.
 * @param timeoutMs  If provided, give up after this many ms (TIMEOUT).
 *                   If omitted, wait indefinitely for user response.
 */
// A seeded-bloc refresh failure may mean we're showing a stale last-known
// location — tell the user once per session via the shared dismissible toast.
let blocRefreshNoticeShown = false;
function notifyBlocRefreshFailed(): void {
    if (blocRefreshNoticeShown) return;
    blocRefreshNoticeShown = true;
    showStorageWarning('Could not retrieve location from browser — falling back to last known location.');
}

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
// Grid layout maths
/**
 * Find the (cols, rows) layout that maximizes face size for the given
 * container dimensions.  Tries every valid column count from 1..count
 * and picks the one producing the largest cells.  When two candidates
 * tie on size, prefer the one with smaller rows+cols (more balanced).
 */
function optimizeGrid(
    count: number,
    containerW: number, containerH: number,
    gap: number, padding: number,
): { cols: number; rows: number; size: number } {
    if (count <= 0) return { cols: 1, rows: 1, size: 0 };

    let bestCols = 1, bestRows = count, bestSize = 0;

    for (let c = 1; c <= count; c++) {
        const r = Math.ceil(count / c);
        const usableW = containerW - 2 * padding - gap * (c - 1);
        const usableH = containerH - 2 * padding - gap * (r - 1);
        const size = Math.floor(Math.min(usableW / c, usableH / r));
        // Prefer larger size; break ties with smaller rows+cols (more balanced)
        const isBetter = size > bestSize;
        const isTie = size === bestSize && (c + r) < (bestCols + bestRows);
        if (isBetter || isTie) {
            bestSize = size;
            bestCols = c;
            bestRows = r;
        }
    }

    return { cols: bestCols, rows: bestRows, size: bestSize };
}

// ============================================================================
// Image loading from FaceData
// ============================================================================

async function loadImagesFromFaceData(
    imageMap: Record<string, { dataUrl: string; scale: number }>
): Promise<Map<string, LoadedImage>> {
    const result = new Map<string, LoadedImage>();
    const entries = Object.entries(imageMap);
    const loadPromises = entries.map(async ([src, { dataUrl, scale }]) => {
        try {
            const response = await fetch(dataUrl);
            const blob = await response.blob();
            // Retain the compressed blob + intrinsics; defer the real decode to the
            // resize path (decodeFaceImages), which sizes each bitmap to the face's
            // actual on-screen px. Avoids decoding these -4x assets at full source
            // resolution — the dominant, resolution-independent memory cost.
            result.set(src, await makeReDecodableImage(blob, scale));
        } catch (e) {
            console.warn(`Failed to load image: ${src}`, e);
        }
    });
    await Promise.all(loadPromises);
    return result;
}

// ============================================================================
// Per-face instance
// ============================================================================

interface FaceInstance {
    watch: Watch;
    env: Environment;
    cachesBuilt: boolean;
    /** Per-face ObsValue collection driven each frame (replaces handStates). */
    updater: Updater;
    /** Per-face overridable (unquantized) display-time source — base of the env's
     *  quantized getNow and of the Updater's eval-ahead time shift. */
    getNow: () => Date;
    /** Eval-ahead time-shift helper paired with {@link getNow}. */
    withDisplayTime: WithDisplayTime;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    sizePx: number;
    images: Map<string, LoadedImage>;
    enabled: boolean;
    scale: number;
    /**
     * Per-face render gate (1×/idle only; scrub always draws). Set when the
     * updater reports a value moved, or explicitly by anything that changes
     * pixels without moving an ObsValue (cache rebuild, env swap, finish/reset,
     * scheduler kick). Cleared when the face is drawn. Must stay conservative:
     * a spurious draw costs microwatts, a missed one is a visibly stale face.
     */
    renderDirty: boolean;
    terminatorLeaves: TerminatorLeafState[];
    analemmaState: AnalemmaState | null;
    faceDataIndex: number;
    /** Per-face slot overrides for Terra/Gaia world-clock faces. */
    terraSlotOverrides?: Record<number, TerraSlot>;
    /** For worldTimeRing faces: which ring slot holds the global location (1–24). */
    globalLocationSlot?: number;
    /** ?ablate=facebuffers: whole-face buffer + the tick epoch it was rendered at. */
    fbCanvas?: HTMLCanvasElement;
    fbCtx?: CanvasRenderingContext2D;
    fbEpoch?: number;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    let faceDataArray = window.ChronometerFaces || [];
    if (faceDataArray.length === 0) {
        console.error('No face data registered. Include at least one face-*.js script.');
        return;
    }

    // On selected.html, filter and reorder faces by the picks parameter
    const isSelectedPage = window.location.pathname.endsWith('selected.html');
    if (isSelectedPage) {
        const picksParam = getState().picks;
        if (picksParam && picksParam.length >= 2) {
            // Parse picks string into array of 2-letter abbreviations
            const abbrevs: string[] = [];
            for (let i = 0; i + 1 < picksParam.length; i += 2) {
                abbrevs.push(picksParam.substring(i, i + 2));
            }
            // Filter and reorder faceDataArray to match picks order
            const byAbbrev = new Map(faceDataArray.map(f => [f.urlAbbrev, f]));
            const filtered: FaceData[] = [];
            for (const abbrev of abbrevs) {
                const face = byAbbrev.get(abbrev);
                if (face) filtered.push(face);
            }
            if (filtered.length > 0) {
                faceDataArray = filtered;
            }
        } else {
            // No picks on selected.html — redirect to pick.html
            const url = new URL('pick.html', window.location.href);
            url.search = window.location.search;
            window.location.replace(url.toString());
            return;
        }
    }

    // --- UI elements ---
    const grid = document.getElementById('watch-grid') as HTMLDivElement;
    const locationDisplay = document.getElementById('location-display')!;
    const sourceLabel = document.getElementById('location-source')!;
    const locationTzLabel = document.getElementById('location-tz')!;
    const setLocationBtn = document.getElementById('set-location-btn')!;
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
    const lpLocationTz = document.getElementById('lp-location-tz')!;
    const lpOsmAttribution = document.getElementById('lp-osm-attribution')!;
    const lpDoneBtn = document.getElementById('lp-done')!;
    const lpDialogFooter = lpDoneBtn.parentElement!;

    // Initialize link preservation
    initNavigationLinks();

    // --- Read URL state early (needed for embed mode guard below) ---
    const urlState = getState();
    const isEmbedMode = urlState.embed;
    if (isEmbedMode) {
        document.body.classList.add('embed-mode');
    }

    // Prefetch the city DB in the background (held as a ~7.5 MB compressed blob,
    // parsed on demand) unless the user asked to conserve data. Embed mode never
    // touches the DB. The DB is parsed lazily — when the dialog opens, or when an
    // unnamed observer location needs reverse-geocoding (see updateLocationDisplay
    // / backfillObserverSlots). See planning/2026-06-14-observatory-cities-lazy-load.md.
    if (!isEmbedMode && !(navigator as any).connection?.saveData) {
        prefetchCityData();
    }

    // --- Resolve location ---
    let lat: number, lon: number;
    let locationSource = '';
    let locationFullLabel = '';  // Full "City, State, Country" for dialog display
    // Track how the location was obtained for display purposes
    let locationSourceType: 'url-city' | 'browser' | 'manual' | 'none' = 'none';
    let needsPrompt = false;
    // Resolved IANA timezone for the current location (e.g. "America/Los_Angeles")
    let locationTimezone: string | undefined = urlState.tz || undefined;
    let tzDeltaMs = computeTzDeltaMs(locationTimezone);
    // True when locationTimezone is a transient browser-tz backstop (the city DB
    // wasn't loaded when we needed to resolve), to be re-resolved once it loads.
    let tzNeedsResolution = false;
    // Track whether browser geolocation is available
    // 'granted' = we got a position, 'denied' = user rejected or unavailable, 'unknown' = never tried
    let geoPermission: 'granted' | 'denied' | 'unknown' = 'unknown';
    // True when bloc is set *and* we seeded from a stored last-known location:
    // show the seed immediately, then refresh geolocation quietly in the background.
    let needsBlocRefresh = false;

    if (isEmbedMode) {
        // Embed mode: hardcode location, use browser timezone. No geolocation needed.
        lat = 0;
        lon = 0;
        locationSource = '';
        locationTimezone = urlState.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
        tzDeltaMs = computeTzDeltaMs(locationTimezone);
        needsPrompt = false;
    } else if (urlState.lat !== null && urlState.lon !== null) {
        lat = urlState.lat;
        lon = urlState.lon;
        locationSource = urlState.city || '';
        locationSourceType = urlState.city ? 'url-city' : 'manual';
        // Seeded bloc: keep showing this stored location, but refresh geolocation
        // quietly in the background once the watch is up (see below).
        needsBlocRefresh = urlState.bloc === true;
        // If no tz in stored state (e.g. a shared link, or pre-tz state), resolve
        // it. Prefer a confident answer: a loaded city DB gives the nearest-city
        // zone, which we persist. If the DB isn't ready, fall back to the browser
        // zone as a TRANSIENT backstop — don't persist it (that would poison
        // future loads) — and re-resolve once the DB loads (see ensureTzResolved).
        if (!locationTimezone) {
            if (isCityDataLoaded()) {
                locationTimezone = resolveTimezone(lat, lon, null);
                tzDeltaMs = computeTzDeltaMs(locationTimezone);
                setState({ tz: locationTimezone });
            } else {
                locationTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
                tzDeltaMs = computeTzDeltaMs(locationTimezone);
                tzNeedsResolution = true;
            }
        }
        // We haven't tried geolocation — check the Permissions API if available
        if (navigator.permissions) {
            try {
                const status = await navigator.permissions.query({ name: 'geolocation' });
                geoPermission = status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'denied' : 'unknown';
            } catch { /* ignore — not all browsers support this */ }
        }
    } else if (urlState.bloc) {
        // bloc=1 set — ask browser for location with 10s timeout
        const result = await requestBrowserLocation(10000);
        if (result.status === 'success') {
            lat = result.lat; lon = result.lon;
            locationSource = '';
            locationSourceType = 'browser';
            geoPermission = 'granted';
            locationTimezone = resolveTimezone(lat, lon, null);
            tzDeltaMs = computeTzDeltaMs(locationTimezone);
            // Seed the fix so the next reload shows it immediately (no 0,0 flash)
            // and can skip the DB while stationary. Automatic write — gated on
            // persistent mode; the city name is filled by updateLocationDisplay's
            // on-demand reverse-geocode.
            if (isPersistentMode()) setState({ bloc: true, lat, lon, tz: locationTimezone || null });
        } else if (result.status === 'denied') {
            // User explicitly denied — show prompt with button disabled
            lat = 0; lon = 0;
            locationSource = '';
            locationSourceType = 'none';
            needsPrompt = true;
            geoPermission = 'denied';
        } else {
            // Timeout or unavailable — show prompt as if user opened it
            // (browser button stays enabled so they can try again)
            lat = 0; lon = 0;
            locationSource = '';
            locationSourceType = 'none';
            needsPrompt = true;
            geoPermission = 'unknown';
        }
    } else {
        // No lat/lon and no bloc — go straight to location prompt
        lat = 0; lon = 0;
        locationSource = '';
        locationSourceType = 'none';
        needsPrompt = true;
        geoPermission = 'unknown';
    }

    /** True while the location dialog/prompt is on screen. */
    function dialogOpen(): boolean {
        const lp = document.getElementById('location-prompt');
        return !!lp && lp.style.display !== 'none';
    }

    /**
     * Label the Terra/Gaia observer slot(s) with the nearest-city name once the
     * DB is parsed (coords unchanged — label only). Only for an *unnamed*
     * observer; named locations already carry their name via locationSource.
     * Replaces the old eager post-load "backfill" pass, now run on demand.
     */
    function backfillObserverSlots(): void {
        if (locationSource || (lat === 0 && lon === 0) || !isCityDataLoaded()) return;
        const closest = findClosestCity(lat, lon);
        if (!closest) return;
        for (const face of faces) {
            if (face.watch.worldTimeSubdials && face.terraSlotOverrides?.[1]) {
                face.terraSlotOverrides[1].cityName = closest.shortLabel;
            }
            if (face.watch.worldTimeRing && face.globalLocationSlot !== undefined) {
                const glSlot = face.terraSlotOverrides?.[face.globalLocationSlot];
                if (glSlot) glSlot.cityName = closest.shortLabel;
            }
        }
    }

    function updateLocationDisplay() {
        locationDisplay.innerHTML = `Latitude&nbsp;<span style="font-family:monospace">${lat.toFixed(3)}</span>&nbsp;&ensp;Longitude&nbsp;<span style="font-family:monospace">${lon.toFixed(3)}</span>`;
        // Show city name or "X mi DIR of CityName" for all source types
        if (locationSource) {
            // User picked a city from search — use the short label directly
            sourceLabel.textContent = locationSource;
        } else if (isCityDataLoaded() && (lat !== 0 || lon !== 0)) {
            // Manual or browser location — find closest city and describe
            const closest = findClosestCity(lat, lon);
            if (closest) {
                const distKm = haversineKm(lat, lon, closest.lat, closest.lon);
                const THRESHOLD_KM = 16; // ~10 miles
                if (distKm > THRESHOLD_KM) {
                    const dir = compassBearing(closest.lat, closest.lon, lat, lon);
                    if (useImperial()) {
                        sourceLabel.textContent = `${Math.round(distKm * 0.621371)}\u00a0mi ${dir} of ${closest.shortLabel}`;
                    } else {
                        sourceLabel.textContent = `${Math.round(distKm)}\u00a0km ${dir} of ${closest.shortLabel}`;
                    }
                } else {
                    sourceLabel.textContent = closest.shortLabel;
                }
            } else {
                sourceLabel.textContent = '';
            }
        } else if (!isCityDataLoaded() && (lat !== 0 || lon !== 0) && !isEmbedMode) {
            // DB not parsed yet — show coords-only for now and resolve in the
            // background (parse on demand), then re-render, label the observer
            // slots, and persist the derived city so future loads skip the DB.
            sourceLabel.textContent = '';
            loadCityData().then(() => {
                if (locationSource) return;       // a named location was set meanwhile
                updateLocationDisplay();          // now loaded → renders nearest city
                backfillObserverSlots();
                const c = findClosestCity(lat, lon);
                if (c && isPersistentMode() && !getState().city) setState({ city: c.shortLabel });
                if (!dialogOpen()) releaseCityData();
            }).catch(() => {});
        } else {
            sourceLabel.textContent = '';
        }
    }
    updateLocationDisplay();

    // --- Load per-face images and parse watches ---
    const parsedWatches: Watch[] = [];
    const allImages: Map<string, LoadedImage>[] = [];

    // Capture planet icon data URLs for the planet selector before releasing
    const planetIconDataUrls: Map<string, string> = new Map();
    const planetIconKeys = [
        'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'sun',
    ];
    const planetIconSrcMap: Record<string, string> = {
        moon: '../partsBin/moonES36.png',
        mercury: '../partsBin/planets/mercury36.png',
        venus: '../partsBin/planets/venus36.png',
        mars: '../partsBin/planets/mars36.png',
        jupiter: '../partsBin/planets/jupiter36.png',
        saturn: '../partsBin/planets/saturn36.png',
        uranus: '../partsBin/planets/uranus36.png',
        neptune: '../partsBin/planets/neptune36.png',
        sun: '../partsBin/planets/sun36.png',
    };

    for (const fd of faceDataArray) {
        parsedWatches.push(parseWatchXML(fd.xml, 'front'));
        // Capture planet icon data URLs before loading (Venezia face has these)
        if (fd.images) {
            for (const [key, src] of Object.entries(planetIconSrcMap)) {
                const entry = (fd.images as Record<string, { dataUrl: string }>)[src];
                if (entry && !planetIconDataUrls.has(key)) {
                    planetIconDataUrls.set(key, entry.dataUrl);
                }
            }
        }
        allImages.push(await loadImagesFromFaceData(fd.images));
        // Release the large base64 data-URL strings now that ImageBitmaps
        // have been created — these are ~4.4 MB of retained strings otherwise.
        fd.images = null as any;
    }
    // Also release the global so the face-*.js IIFE closures can be GC'd
    delete (window as any).ChronometerFaces;

    // Apply dynamic icon updates and bezel backgrounds
    const isSingleFacePage = faceDataArray.length === 1 && !isSelectedPage;
    const isAllFacesPage = window.location.pathname.endsWith('all.html');
    if (isSingleFacePage && parsedWatches[0]) {
        const bezelColor = parsedWatches[0].bezelColor;
        updateDynamicCompositeIcon([faceDataArray[0].thumb], bezelColor);
    } else if (isSelectedPage || isAllFacesPage) {
        const bezelColors = parsedWatches.map(w => w.bezelColor).filter(Boolean);
        const thumbs = faceDataArray.map(fd => fd.thumb);
        updateDynamicCompositeIcon(thumbs, bezelColors);
    }

    // --- Time controller ---
    const timeController = new TimeController();

    // Restore time state from URL
    if (urlState.off !== null && !isNaN(urlState.off)) {
        // Offset mode: 1× forward with a fixed offset from real time
        timeController.setOffset(urlState.off);
    } else if (urlState.t !== null && !isNaN(urlState.t)) {
        timeController.setTime(new Date(urlState.t));
        if (urlState.dir === 1) {
            // Resume forward at 1×
            timeController.setDirection(1);
            timeController.setRate(null);
        } else if (urlState.dir === -1) {
            // Resume reverse at 1×
            timeController.setDirection(-1);
            timeController.setRate(null);
        }
        // dir === 0 stays stopped (setTime already stops)
    }

    const rawGetNow = () => timeController.getDisplayTime();

    /**
     * Create a per-face getNow closure that applies beatsPerSecond
     * quantization.  Mirrors iOS latchTimeForBeatsPerSecond:
     *   latchNTPTime = rint(currentTime * bps) / bps
     * With bps=0, no quantization (continuous sweep).
     * With bps=1, snap to whole seconds (tick-tick).
     * With bps=10, snap to 0.1s (smooth 10 Hz sweep).
     *
     * `base` is the unquantized display-time source the quantizer reads through.
     * It is the face's *overridable* getNow (see makeOverridableGetNow), so the
     * Updater's eval-ahead `withDisplayTime` shift propagates into the env's
     * quantized time. Defaults to the global rawGetNow.
     */
    function makeGetNow(bps: number, base: () => Date = rawGetNow): () => Date {
        if (bps <= 0) return base;
        return () => {
            const d = base();
            const ms = d.getTime();
            const quantizedMs = Math.round(ms / 1000 * bps) / bps * 1000;
            return new Date(quantizedMs);
        };
    }

    // --- Per-face slot overrides helper ---
    // Builds slot overrides based on watch feature flags:
    // - worldTimeRing: reads r1..r24 from URL, then injects the global
    //   location into the best matching slot (placed at top of dial).
    // - worldTimeSubdials: reads d2..dN from URL, slot 1 = observer (Gaia-style)
    // Other faces get no overrides.
    // URL prefixes: 'r' = ring, 'd' = dial/subdial (avoids collision).
    interface SlotOverrideResult {
        overrides: Record<number, TerraSlot>;
        globalLocationSlot?: number;
    }
    function buildSlotOverrides(watch: Watch): SlotOverrideResult | undefined {
        const slotParams = getSlotOverrides();
        if (watch.worldTimeRing) {
            // Collect user overrides from persisted slot state
            const userOverrides: Record<number, TerraSlot> = {};
            for (let slot = 1; slot <= 24; slot++) {
                const name = slotParams[`r${slot}`] ?? null;
                const tz = slotParams[`r${slot}tz`] ?? null;
                const latStr = slotParams[`r${slot}lat`] ?? null;
                const lonStr = slotParams[`r${slot}lon`] ?? null;
                if (name && tz) {
                    userOverrides[slot] = {
                        cityName: name,
                        olsonId: tz,
                        lat: latStr ? parseFloat(latStr) : 0,
                        lon: lonStr ? parseFloat(lonStr) : 0,
                    };
                }
            }

            // Start with user overrides
            const overrides: Record<number, TerraSlot> = { ...userOverrides };

            // Determine which slot to use for the global location
            let globalSlot: number | undefined;
            if (locationTimezone && (lat !== 0 || lon !== 0)) {
                const validSlots = validSlotsForTz(locationTimezone);
                if (validSlots.length === 1) {
                    globalSlot = validSlots[0];
                } else if (validSlots.length > 1) {
                    // Tie-break: prefer the slot NOT overridden by the user
                    const nonOverridden = validSlots.filter(s => !(s in userOverrides));
                    const overridden = validSlots.filter(s => s in userOverrides);
                    if (nonOverridden.length >= 1 && overridden.length >= 1) {
                        // Only one is non-overridden → pick it
                        globalSlot = nonOverridden[0];
                    } else {
                        // Neither or both overridden → pick by standard-time match
                        const globalStdOff = getStandardOffsetMinutes(locationTimezone);
                        let bestSlot = validSlots[0];
                        let bestDiff = Infinity;
                        for (const s of validSlots) {
                            const slotCity = userOverrides[s] || TERRA_RING_DEFAULTS[s];
                            if (!slotCity) continue;
                            const slotStdOff = getStandardOffsetMinutes(slotCity.olsonId);
                            const diff = Math.abs(slotStdOff - globalStdOff);
                            if (diff < bestDiff) {
                                bestDiff = diff;
                                bestSlot = s;
                            }
                        }
                        globalSlot = bestSlot;
                    }
                } else if (validSlots.length === 0) {
                    // Shouldn't happen for real timezones — fall back to offset match
                    console.warn(`[Terra] No valid slot for timezone ${locationTimezone}`);
                }

                // Inject the global location into the chosen slot
                if (globalSlot !== undefined) {
                    let cityName = locationSource;
                    if (!cityName && isCityDataLoaded() && (lat !== 0 || lon !== 0)) {
                        const closest = findClosestCity(lat, lon);
                        if (closest) cityName = closest.shortLabel;
                    }
                    if (!cityName && locationTimezone) {
                        cityName = olsonIdToCityName(locationTimezone);
                    }
                    overrides[globalSlot] = {
                        cityName: cityName || 'Local',
                        olsonId: locationTimezone,
                        lat, lon,
                    };
                }
            }

            return {
                overrides: Object.keys(overrides).length > 0 ? overrides : {},
                globalLocationSlot: globalSlot,
            };
        }
        if (watch.worldTimeSubdials) {
            const nSubdials = watch.maxSeparateLoc || 4;
            const overrides: Record<number, TerraSlot> = {};
            // Slot 1 = observer location — use city name from URL or closest city
            let observerName = locationSource;
            if (!observerName && isCityDataLoaded() && (lat !== 0 || lon !== 0)) {
                const closest = findClosestCity(lat, lon);
                if (closest) observerName = closest.shortLabel;
            }
            // No-DB fallback to the timezone's representative city (matching the
            // Terra global slot), so lazy-loading shows e.g. "Los Angeles" rather
            // than the bare "Observer" placeholder before any reverse-geocode.
            if (!observerName && locationTimezone) {
                observerName = olsonIdToCityName(locationTimezone);
            }
            overrides[1] = {
                cityName: observerName || 'Observer',
                olsonId: locationTimezone || '',
                lat, lon,
            };
            // Slots 2–N: user overrides or defaults
            for (let slot = 2; slot <= nSubdials; slot++) {
                const name = slotParams[`d${slot}`] ?? null;
                const tz = slotParams[`d${slot}tz`] ?? null;
                const latStr = slotParams[`d${slot}lat`] ?? null;
                const lonStr = slotParams[`d${slot}lon`] ?? null;
                if (name && tz) {
                    overrides[slot] = {
                        cityName: name,
                        olsonId: tz,
                        lat: latStr ? parseFloat(latStr) : 0,
                        lon: lonStr ? parseFloat(lonStr) : 0,
                    };
                } else {
                    const def = GAIA_SUBDIAL_DEFAULTS[slot];
                    if (def) overrides[slot] = { ...def };
                }
            }
            return { overrides };
        }
        return undefined;
    }

    // --- Build the DOM: one cell + canvas per face ---
    // cols/rows are recomputed on every resize via optimizeGrid
    let cols = 1, rows = 1;

    const faces: FaceInstance[] = [];

    /**
     * Restore Kyoto-specific state (hand mode and rate mode) onto a fresh
     * Environment after it has been recreated by createWatchEnvironment().
     * Reads the persisted values from the URL so toggles survive time stepping,
     * location changes, and other operations that rebuild the environment.
     */
    function restoreKyotoState(face: FaceInstance): void {
        if (!face.watch.wadokei) return;
        const s = getState();
        if (s.kyhand === '1') face.env.kyHandMode = 1;
        if (s.kmode === '1') face.env.variables.set('kyMode', 1);
    }

    for (let i = 0; i < parsedWatches.length; i++) {
        const cell = document.createElement('div');
        cell.className = 'face-cell';

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        cell.appendChild(canvas);
        grid.appendChild(cell);

        const watch = parsedWatches[i];
        const slotResult = buildSlotOverrides(watch);
        const faceOverrides = slotResult?.overrides;
        // Per-face overridable time seam: the quantized env getNow and the
        // Updater's eval-ahead shift both read through this same base, so
        // withDisplayTime() shifts the env's evaluation time (see makeGetNow).
        const { getNow: faceRawGetNow, withDisplayTime } = makeOverridableGetNow(rawGetNow);
        const faceGetNow = makeGetNow(watch.beatsPerSecond, faceRawGetNow);
        const env = createWatchEnvironment(watch, lat, lon, faceGetNow, locationTimezone, faceOverrides, slotResult?.globalLocationSlot);

        const face: FaceInstance = {
            watch,
            env,
            cachesBuilt: false,
            updater: new Updater(),
            getNow: faceRawGetNow,
            withDisplayTime,
            canvas,
            ctx,
            sizePx: 0,
            images: allImages[i],
            enabled: true,
            scale: 1,
            renderDirty: true,
            terminatorLeaves: [],
            analemmaState: null,
            faceDataIndex: i,
            terraSlotOverrides: faceOverrides,
            globalLocationSlot: slotResult?.globalLocationSlot,
        };
        faces.push(face);
    }

    // On multi-face pages (all.html, selected.html), make each face clickable → navigate to its page
    const isMultiFace = faceDataArray.length > 1;
    if (isMultiFace || isSelectedPage || isAllFacesPage) {
        // Hide the appropriate nav icon depending on which multi-face page we're on
        if (isSelectedPage) {
            document.body.classList.add('is-selected-faces');
        } else if (isAllFacesPage) {
            document.body.classList.add('is-all-faces');
        }
        for (let i = 0; i < faces.length; i++) {
            const face = faces[i];
            const slug = faceNameToSlug(faceDataArray[i].name);
            face.canvas.style.cursor = 'pointer';
            face.canvas.addEventListener('click', () => {
                // Preserve location/time state in the URL
                const params = new URLSearchParams(window.location.search);
                window.location.href = `${slug}.html${params.toString() ? '?' + params.toString() : ''}`;
            });
        }
    }

    // --- onecanvas ablation: one shared canvas replaces the 16 per-face layers ---
    // Per-face canvases stay in the DOM (they define the grid layout and the
    // static-cache sizes) but are hidden and never dirtied; all faces draw into
    // this one canvas at their cell offsets, so the compositor commits a single
    // layer per frame instead of 16.
    let _sharedCanvas: HTMLCanvasElement | null = null;
    let _sharedCtx: CanvasRenderingContext2D | null = null;
    let _sharedOffsets: { x: number; y: number }[] = [];
    let _sharedFacePx = 0;
    if (_ablateOneCanvas) {
        grid.style.position = 'relative';
        _sharedCanvas = document.createElement('canvas');
        _sharedCanvas.style.position = 'absolute';
        _sharedCanvas.style.inset = '0';
        _sharedCanvas.style.pointerEvents = 'none';
        grid.appendChild(_sharedCanvas);
        _sharedCtx = _sharedCanvas.getContext('2d')!;
        for (const face of faces) face.canvas.style.visibility = 'hidden';
    }
    /** (Re)size the shared canvas + recompute face cell offsets when layout changed. */
    let _sharedPosKey = '';
    function syncSharedLayout(): void {
        if (!_sharedCanvas || !_sharedCtx) return;
        const dpr = effectiveDpr();
        const rect = grid.getBoundingClientRect();
        const w = Math.round(rect.width * dpr);
        const h = Math.round(rect.height * dpr);
        const facePx = faces[0]?.canvas.width ?? 0;
        // Position-only relayouts (the controller-avoidance grid *shift*) change
        // neither the grid rect nor face sizes — track first+last face positions
        // so stale offsets get recomputed (found via the controller overlap bug).
        const r0 = faces[0]?.canvas.getBoundingClientRect();
        const rN = faces[faces.length - 1]?.canvas.getBoundingClientRect();
        const posKey = r0 && rN
            ? `${(r0.left - rect.left).toFixed(1)},${(r0.top - rect.top).toFixed(1)},${(rN.left - rect.left).toFixed(1)},${(rN.top - rect.top).toFixed(1)}`
            : '';
        if (_sharedCanvas.width === w && _sharedCanvas.height === h
            && _sharedOffsets.length === faces.length && _sharedFacePx === facePx
            && _sharedPosKey === posKey) return;
        _sharedPosKey = posKey;
        _sharedCanvas.width = w;
        _sharedCanvas.height = h;
        _sharedCanvas.style.width = `${rect.width}px`;
        _sharedCanvas.style.height = `${rect.height}px`;
        _sharedFacePx = facePx;
        _sharedOffsets = faces.map(f => {
            const r = f.canvas.getBoundingClientRect();
            return { x: Math.round((r.left - rect.left) * dpr), y: Math.round((r.top - rect.top) * dpr) };
        });
    }

    // --- Size all canvases to match the grid container ---
    function applySize(face: FaceInstance, size: number) {
        const dpr = effectiveDpr();
        const physPx = Math.round(size * dpr);
        face.canvas.width = physPx;
        face.canvas.height = physPx;
        face.canvas.style.width = `${size}px`;
        face.canvas.style.height = `${size}px`;
        const bezel = face.watch.bezelColor ? BEZEL_THICKNESS_XML : 0;
        const totalDiameter = face.watch.faceWidth + 2 * bezel;
        face.sizePx = size;
        face.scale = physPx / totalDiameter;
    }

    // --- Build (or rebuild) the StaticCache for a face ---
    function buildCache(face: FaceInstance) {
        if (!face.enabled || face.sizePx === 0) return;
        const { canvas, watch, env, images, scale } = face;
        face.terminatorLeaves = [];
        for (const part of watch.parts) {
            if (part.type === 'Terminator') {
                face.terminatorLeaves.push(...expandTerminatorToLeaves(part, env));
            }
        }
        if (face.terminatorLeaves.length > 0) {
            updateLeafAngles(face.terminatorLeaves, face.env);
        }
        buildStaticBlockCaches(watch, env, canvas.width, canvas.height, scale, images, face.terminatorLeaves);
        // (Hand shadows are no longer pre-built here: all hands — vector and
        // image — use the renderer's runtime appearance caches, which bake
        // split body/shadow layers on first draw.)
        face.cachesBuilt = true;
        // Expand analemma parts
        face.analemmaState = null;
        for (const part of watch.parts) {
            if (part.type === 'Analemma') {
                face.analemmaState = expandAnalemma(part, env, images);
                break;  // Only one analemma per face
            }
        }
        face.updater = buildHandValues(watch.name, watch, env, performance.now());
        buildTerminatorValues(face.updater, watch.name, face.terminatorLeaves, env, performance.now());
        if (face.analemmaState) buildAnalemmaValues(face.updater, watch.name, face.analemmaState, env, performance.now());
        // Statics + backing store just changed (resize clears the canvas): the
        // first frame after cachesBuilt flips true must draw unconditionally.
        face.renderDirty = true;
    }

    /**
     * Re-decode a face's images to the pixels they occupy on screen at the face's
     * current scale (1:1). This is the memory/phone-floor lever: the -4x face
     * artwork is decoded at display size instead of full source resolution. It runs
     * in the resize path only — the sole place face.scale changes — and is a no-op
     * for images already at the right size (repeat resize at an unchanged scale) and
     * for images without a retained source (e.g. the built-in loadWatchImages path).
     *
     * Triggers are initial load and relayout (window resize / browser magnification),
     * never scrub or normal interaction, so the added decode latency is paid rarely.
     */
    async function decodeFaceImages(face: FaceInstance): Promise<void> {
        if (!face.enabled || face.sizePx === 0) return;
        let anyRedecoded = false;
        await Promise.all([...face.images.values()].map(async (loaded) => {
            const before = loaded.bitmap;
            await decodeLoadedImageForScale(loaded, face.scale);
            if (loaded.bitmap !== before) anyRedecoded = true;
        }));
        // The Terra city-name knockout is built at the ring bitmap's native
        // resolution and cached on the env (deliberately preserved across env
        // rebuilds). A resized ring bitmap makes that cache the wrong size, so drop
        // it after a re-decode — it rebuilds lazily on the next draw.
        if (anyRedecoded) (face.env as any)._terraCityKnockout = null;
    }

    function buildAllCachesSequentially(facesToBuild: FaceInstance[], onDone: () => void) {
        let idx = 0;
        function buildNext() {
            if (idx >= facesToBuild.length) { onDone(); return; }
            const face = facesToBuild[idx++];
            const buildThenContinue = () => {
                try {
                    buildCache(face);
                } catch (err) {
                    // A single face's cache build must never strand the batch: onDone()
                    // re-kicks the render loop, so skipping it would leave the grid dark.
                    // Log and carry on — the face stays cachesBuilt=false (skipped by the
                    // frame loop) and is retried on the next rebuild (resize / location).
                    console.error(`[buildCache] face "${face.watch?.name ?? '?'}" threw; leaving it unbuilt:`, err);
                }
                setTimeout(buildNext, 0);
            };
            // Re-decode images to display size before building this face's caches
            // (buildStaticBlockCaches consumes the bitmaps). Sequential per-face so
            // the transient decode cost stays bounded to one face at a time.
            decodeFaceImages(face).then(buildThenContinue, (err) => {
                console.error(`[decodeFaceImages] face "${face.watch?.name ?? '?'}" threw:`, err);
                buildThenContinue();
            });
        }
        buildNext();
    }

    // =========================================================================
    // Time controller — tick callback
    // =========================================================================

    /**
     * Rebuild environments and static caches for the current simulated time,
     * preserving existing part objects and hand states so animations
     * continue smoothly. Used for step events where only the time changes.
     *
     * The env functions (hour12ValueAngle, etc.) are live closures over
     * getNow(), so they automatically see the new time. But calendar-
     * dependent init expressions and terminator computations need
     * a fresh environment.
     */
    function rebuildEnvironments() {
        const oldTzDeltaMs = tzDeltaMs;
        tzDeltaMs = computeTzDeltaMs(locationTimezone, rawGetNow());
        let tzOffsetChanged = false;

        // The only time-dependent state baked into an env is its captured tz offset
        // (env.tzOffsetSec); everything else is either static config or a live closure
        // over getNow(). So a rebuild is only *necessary* when that offset changes —
        // i.e. a DST boundary was crossed. On the scrub hot path (this runs every
        // 100ms tick) the offset is unchanged for the vast majority of ticks, so this
        // guard skips a full createWatchEnvironment + buildStaticBlockCaches per face
        // that would produce a byte-identical result. See planning/ perf notes.

        for (const face of faces) {
            if (!face.enabled) continue;
            if (!envTzStateStale(face.env, locationTimezone) && !face.env.captureStale?.()) {
                // Captured state unchanged → the live getNow() closures already
                // reflect the new display time; nothing baked into the env is stale.
                // Skip the rebuild — but invalidate the env's astro cache pool (O(1))
                // so this tick's astronomy starts from the same all-invalid state a
                // fresh pool would have, never serving values computed at a previous
                // tick's time.
                face.env.invalidateAstroCaches?.();
                continue;
            }

            // Preserve the Terra city-name knockout cache across env rebuilds
            // (it's stored on the env but doesn't depend on time — only on slot assignments).
            const oldKnockout = (face.env as any)._terraCityKnockout;
            const oldTzOffset = face.env.tzOffsetSec;

            // Rebuild the environment but keep the same watch/parts
            face.env = createWatchEnvironment(face.watch, lat, lon, makeGetNow(face.watch.beatsPerSecond, face.getNow), locationTimezone, face.terraSlotOverrides, face.globalLocationSlot);
                    restoreKyotoState(face);
            if (oldKnockout) (face.env as any)._terraCityKnockout = oldKnockout;
            // Invalidate QDayNightRing render caches so astronomy values
            // are recomputed immediately for the new time.
            // Preserve terminator leaves — their angle/rotation ObsValues are
            // evaluated against the (live) env each frame by updater.tick, so they
            // don't need recreating. Recreating them would destroy animation state.
            const { canvas, watch, env, images, scale } = face;
            buildStaticBlockCaches(watch, env, canvas.width, canvas.height, scale, images, face.terminatorLeaves);
            // Statics changed without any ObsValue moving — force a redraw.
            face.renderDirty = true;
            // Force analemma to recompute on the next frame

            // If the timezone offset changed (e.g. DST transition), reset schedules to force immediate hand re-evaluation
            if (oldTzOffset !== undefined && face.env.tzOffsetSec !== oldTzOffset) {
                console.log(`[rebuildEnvironments] DST transition detected (offset ${oldTzOffset} -> ${face.env.tzOffsetSec}) - resetting schedules`);
                tzOffsetChanged = true;
                face.updater.reset();
            }
        }

        if (tzDeltaMs !== oldTzDeltaMs || tzOffsetChanged) {
            timeUI?.updateTimezoneDisplay();
        }

        // Reschedule the DST timer — displayed time and/or direction may
        // have changed, so the next transition point could be different.
        scheduleDstRebuild();
    }


    timeController.onTick = rebuildEnvironments;

    // =========================================================================
    // Scheduler
    // =========================================================================

    let idleTimerId: ReturnType<typeof setTimeout> | null = null;
    let rafId: number | null = null;

    // --- FPS indicator (page-level, enabled via the ?fps URL parameter) ---
    // One readout for the whole page: every face renders in a single frame()
    // call, so frames-per-second is a page metric, not a per-face one. The
    // overlay (two metrics + dimming + watchdog) lives in the shared helper;
    // we just feed it one recordFrame() per frame with this frame's
    // continuous-render decision. See src/shared/fps-indicator.ts.
    const _fps = createFpsIndicator(urlState.fps);

    function stopScheduler() {
        if (idleTimerId !== null) { clearTimeout(idleTimerId); idleTimerId = null; }
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    }


    // --- ?drawstats: render-gate verification counters (reported at 1× only) ---
    let _dsDraws = 0;
    let _dsFrames = 0;
    let _dsLastReport = 0;

    // --- Scrubbing performance instrumentation ---
    let _wasScrubbing = false;
    let _scrubTotalExpectedTicks = 0;
    let _scrubProcessedTicks = 0;
    let _scrubLostTicks = 0;

    // Animation FPS tracking per update interval:
    let _intervalUpdateFrameTime: number | null = null;
    let _intervalFrameCount = 0;
    let _intervalLastFrameTime: number | null = null;
    const _scrubIntervalFpsList: number[] = [];
    let _scrubIntervalZeroFrameCount = 0;

    // Pure animation frame statistics:
    let _pureAnimCount = 0;
    let _pureAnimCpuTimeTotal = 0;
    let _pureAnimCpuMin = Infinity;
    let _pureAnimCpuMax = -Infinity;
    let _pureAnimGpuTimeTotal = 0;
    let _pureAnimGpuMin = Infinity;
    let _pureAnimGpuMax = -Infinity;
    let _pureAnimDeltaTotal = 0;
    let _pureAnimDeltaCount = 0;
    let _pureAnimDeltaMin = Infinity;
    let _pureAnimDeltaMax = -Infinity;
    let _lastAnimFrameTime: number | null = null;

    // Per-frame CPU breakdown across ALL scrub frames (tick = updater update+animate,
    // incl. astronomy; render = renderFrame draw-command issuance). Answers "where
    // does the frame CPU go — astronomy/expression eval or rendering?".
    let _scrubTickMsTotal = 0;
    let _scrubRenderMsTotal = 0;
    let _scrubBodyFrameCount = 0;

    // --- Render-perf Phase 0 (planning/2026-07-03-scrub-render-perf-investigation.md) ---
    // Frame-class split: "tick" frames process a quantized tick boundary (updater
    // update/eval work concentrates there); "anim" frames only advance animations.
    // Inter-frame intervals and post-callback slack are attributed to the
    // *preceding* frame's class, since that frame's issuance/raster is what gates
    // the next rAF delivery.
    function _newClassStats() {
        return {
            n: 0, cpuMs: 0, cpuMax: -Infinity,
            tickMs: 0, renderMs: 0,
            animFaces: 0, animFacesMin: Infinity, animFacesMax: -Infinity,
            slackMs: 0, slackMin: Infinity, slackMax: -Infinity, slackN: 0,
            intervalMs: 0, intervalMin: Infinity, intervalMax: -Infinity, intervalN: 0,
            hist: new Map<number, number>(),   // 2ms interval buckets → count
        };
    }
    type ClassStats = ReturnType<typeof _newClassStats>;
    let _classTick = _newClassStats();
    let _classAnim = _newClassStats();
    let _prevScrubFrameWasTick = false;
    let _prevScrubFrameStart: number | null = null;
    let _prevScrubFrameEnd: number | null = null;
    let _faceTickMs: number[] = [];
    let _faceRenderMs: number[] = [];
    // Phase 1 ablation state: global frame parity (staggerrender) and frames
    // elapsed since the last scrub tick (staggertick deferral window).
    let _frameCounter = 0;
    let _framesSinceTick = 999;
    // facebuffers state: tick epoch buffers are rebuilt against, and the
    // round-robin cursor for fair rebuild scheduling (≤4 faces/frame).
    let _fbTickEpoch = 0;
    let _fbCursor = 0;
    const FB_REBUILDS_PER_FRAME = 4;

    // =========================================================================
    // Canvas-memory ledger (`[mem]`) — accounting of every canvas/bitmap we
    // allocate, estimated as w×h×4 bytes. Printed once after the initial cache
    // build and appended to each scrub-perf summary. Device targets: see
    // planning/2026-07-03-scrub-render-perf-investigation.md "Device targets".
    // =========================================================================
    let _memReported = false;
    function canvasMemoryReport(): string {
        const MB = (b: number) => (b / (1024 * 1024)).toFixed(1);
        const seen = new Set<object>();
        const sz = (c: { width: number; height: number } | null | undefined): number => {
            if (!c || seen.has(c)) return 0;
            seen.add(c);
            return c.width * c.height * 4;
        };
        let facesB = 0, staticB = 0, shadowB = 0, imagesB = 0, srcBlobB = 0, analemmaB = 0, buffersB = 0, terraB = 0;
        const walkParts = (parts: any[]): void => {
            for (const p of parts) {
                staticB += sz(p.cachedCanvas);
                shadowB += sz(p._shadowBitmap);
                if (p.children) walkParts(p.children);
            }
        };
        for (const face of faces) {
            facesB += sz(face.canvas);
            buffersB += sz(face.fbCanvas);
            walkParts(face.watch.parts);
            for (const img of face.images.values()) {
                imagesB += sz(img.bitmap);
                // Compressed source retained for display-size re-decode on resize.
                if (img.source) srcBlobB += img.source.blob.size;
            }
            const a = face.analemmaState as any;
            if (a) analemmaB += sz(a.bgBitmap) + sz(a.channelBitmap) + sz(a.sunBitmap) + sz(a._scratchCanvas);
            terraB += sz((face.env as any)._terraCityKnockout);
        }
        const sharedB = sz(_sharedCanvas);
        const rc = rendererCacheMemoryBytes();
        const total = facesB + staticB + shadowB + imagesB + srcBlobB + analemmaB + buffersB + terraB
            + sharedB + rc.wedgeCache + rc.wheelCache + rc.handCache + rc.cutoutTemp;
        const mem = (performance as any).memory;
        const jsHeap = mem
            ? ` · JS heap (Chrome-only): ${MB(mem.usedJSHeapSize)}/${MB(mem.totalJSHeapSize)}MB`
            : '';
        return `canvas/bitmap est TOTAL ${MB(total)}MB: faces ${MB(facesB)} · static caches ${MB(staticB)} · ` +
            `images ${MB(imagesB)} · src blobs ${MB(srcBlobB)} · shadows ${MB(shadowB)} · wedge cache ${MB(rc.wedgeCache)} · ` +
            `wheel cache ${MB(rc.wheelCache)} · hand cache ${MB(rc.handCache)} · analemma ${MB(analemmaB)} · ` +
            `terra ring ${MB(terraB)} · cutout temp ${MB(rc.cutoutTemp)} · face buffers ${MB(buffersB)} · ` +
            `shared canvas ${MB(sharedB)}${jsHeap}`;
    }

    function _buildStamp(): string {
        // Injected by build.sh via esbuild --define; scratch/esbuild-only builds
        // (no define) report 'dev'. Present in every pasted [scrub-perf] block so
        // a stale cached bundle is detectable from the log alone (a Safari run on
        // 2026-07-05 silently measured the previous build; see the timings-8
        // post-mortem in the investigation doc).
        return typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : 'dev';
    }

    function _browserShort(): string {
        const ua = navigator.userAgent;
        let m: RegExpExecArray | null;
        if ((m = /Edg\/(\d+)/.exec(ua))) return `Edge ${m[1]}`;
        if ((m = /Chrome\/(\d+)/.exec(ua))) return `Chrome ${m[1]}`;
        if ((m = /Version\/(\d+(?:\.\d+)?).*Safari/.exec(ua))) return `Safari ${m[1]}`;
        if ((m = /Firefox\/(\d+)/.exec(ua))) return `Firefox ${m[1]}`;
        return ua.slice(0, 40);
    }

    function frame() {
        rafId = null;
        _frameCounter++;
        const now = performance.now();
        const frameStart = now;
        let stillAnimating = false;

        const isScrubbing = timeController.currentRate !== null && !timeController.isStopped;
        let willTick = false;

        if (isScrubbing) {
            if (!_wasScrubbing) {
                _wasScrubbing = true;
                _scrubTotalExpectedTicks = 0;
                _scrubProcessedTicks = 0;
                _scrubLostTicks = 0;
                _intervalUpdateFrameTime = null;
                _intervalFrameCount = 0;
                _intervalLastFrameTime = null;
                _scrubIntervalFpsList.length = 0;
                _scrubIntervalZeroFrameCount = 0;

                _pureAnimCount = 0;
                _pureAnimCpuTimeTotal = 0;
                _pureAnimCpuMin = Infinity;
                _pureAnimCpuMax = -Infinity;
                _pureAnimGpuTimeTotal = 0;
                _pureAnimGpuMin = Infinity;
                _pureAnimGpuMax = -Infinity;
                _pureAnimDeltaTotal = 0;
                _pureAnimDeltaCount = 0;
                _pureAnimDeltaMin = Infinity;
                _pureAnimDeltaMax = -Infinity;
                _lastAnimFrameTime = null;
                _scrubTickMsTotal = 0;
                _scrubRenderMsTotal = 0;
                _scrubBodyFrameCount = 0;
                _classTick = _newClassStats();
                _classAnim = _newClassStats();
                _prevScrubFrameWasTick = false;
                _prevScrubFrameStart = null;
                _prevScrubFrameEnd = null;
                _faceTickMs = faces.map(() => 0);
                _faceRenderMs = faces.map(() => 0);
                _framesSinceTick = 999;
                _fbTickEpoch = 0;
                _fbCursor = 0;
                for (const f of faces) f.fbEpoch = -1;
                resetTickProfile();
                resetAstroProfile();
                resetPartProfile();
                console.log('[scrub-perf] Scrubbing session started.');
            }

            const elapsed = now - timeController.lastTickRealMs;
            willTick = elapsed >= TICK_INTERVAL_MS;
            _framesSinceTick = willTick ? 0 : _framesSinceTick + 1;
            if (willTick) _fbTickEpoch++;

            // Interval + post-callback slack, attributed to the preceding
            // frame's class (its issuance/raster is what gated this rAF).
            if (_prevScrubFrameStart !== null) {
                const cls = _prevScrubFrameWasTick ? _classTick : _classAnim;
                const interval = now - _prevScrubFrameStart;
                cls.intervalN++;
                cls.intervalMs += interval;
                if (interval < cls.intervalMin) cls.intervalMin = interval;
                if (interval > cls.intervalMax) cls.intervalMax = interval;
                const bucket = Math.round(interval / 2) * 2;
                cls.hist.set(bucket, (cls.hist.get(bucket) ?? 0) + 1);
                if (_prevScrubFrameEnd !== null) {
                    const slack = now - _prevScrubFrameEnd;
                    cls.slackN++;
                    cls.slackMs += slack;
                    if (slack < cls.slackMin) cls.slackMin = slack;
                    if (slack > cls.slackMax) cls.slackMax = slack;
                }
            }

            if (willTick) {
                const expectedTicks = Math.floor(elapsed / TICK_INTERVAL_MS);
                const lostTicks = expectedTicks - 1;

                _scrubTotalExpectedTicks += expectedTicks;
                _scrubProcessedTicks += 1;
                _scrubLostTicks += lostTicks;

                // Process the end of the previous update interval for animation FPS
                if (_intervalUpdateFrameTime !== null) {
                    if (_intervalFrameCount > 0 && _intervalLastFrameTime !== null) {
                        const duration = _intervalLastFrameTime - _intervalUpdateFrameTime;
                        const fps = _intervalFrameCount / (duration / 1000);
                        _scrubIntervalFpsList.push(fps);
                    } else {
                        _scrubIntervalZeroFrameCount++;
                    }
                }

                // Start the new update interval
                _intervalUpdateFrameTime = now;
                _intervalFrameCount = 0;
                _intervalLastFrameTime = null;
            } else {
                // This is an animation frame within the current update interval
                if (_intervalUpdateFrameTime !== null) {
                    _intervalFrameCount++;
                    _intervalLastFrameTime = now;
                }
            }
        }

        if (!isScrubbing && _wasScrubbing) {
            _wasScrubbing = false;

            // Process the final interval if it was in progress
            if (_intervalUpdateFrameTime !== null) {
                if (_intervalFrameCount > 0 && _intervalLastFrameTime !== null) {
                    const duration = _intervalLastFrameTime - _intervalUpdateFrameTime;
                    const fps = _intervalFrameCount / (duration / 1000);
                    _scrubIntervalFpsList.push(fps);
                } else {
                    _scrubIntervalZeroFrameCount++;
                }
            }

            const avgFps = _scrubIntervalFpsList.length > 0
                ? (_scrubIntervalFpsList.reduce((a, b) => a + b, 0) / _scrubIntervalFpsList.length).toFixed(1)
                : 'N/A';
            const minFps = _scrubIntervalFpsList.length > 0
                ? Math.min(..._scrubIntervalFpsList).toFixed(1)
                : 'N/A';
            const maxFps = _scrubIntervalFpsList.length > 0
                ? Math.max(..._scrubIntervalFpsList).toFixed(1)
                : 'N/A';
            const lostPercent = _scrubTotalExpectedTicks > 0
                ? ((_scrubLostTicks / _scrubTotalExpectedTicks) * 100).toFixed(1)
                : '0.0';

            const avgCpu = _pureAnimCount > 0 ? (_pureAnimCpuTimeTotal / _pureAnimCount).toFixed(2) : 'N/A';
            const minCpu = _pureAnimCount > 0 ? _pureAnimCpuMin.toFixed(2) : 'N/A';
            const maxCpu = _pureAnimCount > 0 ? _pureAnimCpuMax.toFixed(2) : 'N/A';

            const avgGpu = _pureAnimCount > 0 ? (_pureAnimGpuTimeTotal / _pureAnimCount).toFixed(2) : 'N/A';
            const minGpu = _pureAnimCount > 0 ? _pureAnimGpuMin.toFixed(2) : 'N/A';
            const maxGpu = _pureAnimCount > 0 ? _pureAnimGpuMax.toFixed(2) : 'N/A';

            const avgDelta = _pureAnimDeltaCount > 0 ? (_pureAnimDeltaTotal / _pureAnimDeltaCount).toFixed(2) : 'N/A';
            const minDelta = _pureAnimDeltaCount > 0 ? _pureAnimDeltaMin.toFixed(2) : 'N/A';
            const maxDelta = _pureAnimDeltaCount > 0 ? _pureAnimDeltaMax.toFixed(2) : 'N/A';
            const avgAnimFps = _pureAnimDeltaCount > 0 ? (1000 / (_pureAnimDeltaTotal / _pureAnimDeltaCount)).toFixed(1) : 'N/A';

            console.log(
                `[scrub-perf] Scrub session ended:\n` +
                `  - Total expected ticks: ${_scrubTotalExpectedTicks}\n` +
                `  - Processed ticks: ${_scrubProcessedTicks}\n` +
                `  - Lost/skipped ticks: ${_scrubLostTicks} (${lostPercent}%)\n` +
                `  - Avg animation FPS: ${avgFps} (min: ${minFps}, max: ${maxFps} over ${_scrubIntervalFpsList.length} intervals)\n` +
                `  - Intervals with zero animation frames: ${_scrubIntervalZeroFrameCount}\n` +
                `  - Pure Animation Frame Stats (N = ${_pureAnimCount}):\n` +
                `    - CPU execution: avg ${avgCpu}ms (min: ${minCpu}ms, max: ${maxCpu}ms)\n` +
                `    - Flush probe (getImageData on 1 of ${faces.length} canvases; incl. readback stall)${_probeEnabled ? '' : ' [off; opt in with ?probe]'}: avg ${avgGpu}ms (min: ${minGpu}ms, max: ${maxGpu}ms)\n` +
                `    - Inter-frame interval: avg ${avgDelta}ms (min: ${minDelta}ms, max: ${maxDelta}ms) -> equivalent to ${avgAnimFps} FPS\n` +
                `  - Frame CPU split (all ${_scrubBodyFrameCount} scrub frames): ` +
                `tick(update+astro+animate) avg ${(_scrubBodyFrameCount ? _scrubTickMsTotal / _scrubBodyFrameCount : 0).toFixed(2)}ms, ` +
                `render(draw issuance) avg ${(_scrubBodyFrameCount ? _scrubRenderMsTotal / _scrubBodyFrameCount : 0).toFixed(2)}ms\n` +
                (() => {
                    const built = faces.filter(f => f.enabled && f.cachesBuilt);
                    const obs = built.reduce((n, f) => n + f.updater.all.length, 0);
                    return `  - Ticked: ${obs} obsValues across ${built.length} faces ` +
                        `(${built.length ? (obs / built.length).toFixed(0) : 0}/face) · canvas ${built[0]?.sizePx ?? 0}px`;
                })() +
                (() => {
                    const n = _scrubBodyFrameCount || 1;
                    const a = astroProfile;
                    const perSearch = a.masterComputes ? (a.masterMs / a.masterComputes) : 0;
                    const hitRate = a.masterCalls ? (1 - a.masterComputes / a.masterCalls) * 100 : 0;
                    const perLeaf = a.leafCalls ? (a.leafMs / a.leafCalls * 1000) : 0;
                    return `\n  - Master rise/set search: ${a.masterComputes} computes / ${a.masterCalls} calls ` +
                        `(${(a.masterComputes / n).toFixed(1)} computes/frame, ${hitRate.toFixed(0)}% cache hit), ` +
                        `${perSearch.toFixed(3)}ms/search, ${(a.masterMs / n).toFixed(2)}ms/frame, ${a.masterMs.toFixed(0)}ms total` +
                        `\n  - Day/night leaf calc: ${a.leafCalls} calls (${(a.leafCalls / n).toFixed(0)}/frame), ` +
                        `${perLeaf.toFixed(1)}µs/call, ${(a.leafMs / n).toFixed(2)}ms/frame ` +
                        `(= the share of tick eval spent in day/night wedge astronomy)`;
                })() +
                (_tickProfile ? '\n' + (() => {
                    const n = _scrubBodyFrameCount || 1;
                    const p = tickProfile;
                    const rest = p.updateMs - p.evalMs - p.boundaryMs - p.interpMs;
                    const perEvalUs = p.evalCalls ? (p.evalMs * 1000 / p.evalCalls) : 0;
                    return `  - Tick attribution (avg/frame): update ${(p.updateMs/n).toFixed(2)}ms ` +
                        `[eval ${(p.evalMs/n).toFixed(2)} · boundary ${(p.boundaryMs/n).toFixed(2)} · ` +
                        `interp ${(p.interpMs/n).toFixed(2)} · rest ${(rest/n).toFixed(2)}], ` +
                        `animate(2nd interp) ${(p.animateMs/n).toFixed(2)}ms · ` +
                        `${perEvalUs.toFixed(1)}µs/eval (${p.evalCalls} evals)`;
                })() : '') +
                '\n' + (() => {
                    // --- Render-perf Phase 0 report ---
                    const f1 = (x: number) => x.toFixed(1);
                    const f2 = (x: number) => x.toFixed(2);
                    const built = faces.filter(f => f.enabled && f.cachesBuilt);
                    const nAll = _scrubBodyFrameCount || 1;
                    const quantum = _refreshMinDeltaMs !== null && _refreshMedianDeltaMs !== null
                        ? `~${f1(_refreshMedianDeltaMs)}ms median / ${f1(_refreshMinDeltaMs)}ms min (~${Math.round(1000 / _refreshMedianDeltaMs)}Hz est)`
                        : 'n/a (sampler did not complete)';
                    const clsLine = (s: ClassStats) => s.n
                        ? `N=${s.n} · body CPU avg ${f2(s.cpuMs / s.n)}ms (max ${f1(s.cpuMax)}) ` +
                          `[update ${f2(s.tickMs / s.n)} · render ${f2(s.renderMs / s.n)}]`
                        : 'N=0';
                    const slackLine = (s: ClassStats) => s.slackN
                        ? `avg ${f2(s.slackMs / s.slackN)}ms (min ${f1(s.slackMin)}, max ${f1(s.slackMax)})`
                        : 'n/a';
                    const intervalLine = (s: ClassStats) => s.intervalN
                        ? `avg ${f2(s.intervalMs / s.intervalN)}ms (min ${f1(s.intervalMin)}, max ${f1(s.intervalMax)})`
                        : 'n/a';
                    const histStr = (s: ClassStats) =>
                        [...s.hist.entries()].sort((a, b) => a[0] - b[0])
                            .map(([bucket, count]) => `${bucket}:${count}`).join(' ') || 'n/a';
                    const animFacesStr = (s: ClassStats) => s.n
                        ? `avg ${f1(s.animFaces / s.n)} (min ${s.animFacesMin}, max ${s.animFacesMax})`
                        : 'n/a';
                    const perFace = faces
                        .map((f, i) => ({ f, i }))
                        .filter(({ f }) => f.enabled && f.cachesBuilt)
                        .map(({ f, i }) => ({
                            name: f.watch?.name ?? '?',
                            render: (_faceRenderMs[i] ?? 0) / nAll,
                            update: (_faceTickMs[i] ?? 0) / nAll,
                        }))
                        .sort((a, b) => b.render - a.render);
                    const perFaceStr = perFace.map(p => `${p.name} ${f2(p.render)}+${f2(p.update)}`).join(' · ');
                    const flagsStr = [
                        ..._ablate,
                        _facesLimit !== Infinity ? `faces=${_facesLimit}` : '',
                        _probeEnabled ? 'probe' : '',
                    ].filter(Boolean).join(',') || 'none';
                    return `  - Environment: build ${_buildStamp()} · ${_browserShort()} · dpr ${window.devicePixelRatio} (backing ${effectiveDpr()}) · ` +
                        `${built.length} canvases @ ${built[0]?.sizePx ?? 0}px CSS / ${built[0]?.canvas.width ?? 0}px phys · ` +
                        `window ${window.innerWidth}×${window.innerHeight} · display quantum ${quantum}` +
                        (_sharedCanvas ? ` · shared canvas ${_sharedCanvas.width}×${_sharedCanvas.height}px phys` : '') +
                        ` · flags ${flagsStr}\n` +
                        `  - Frame classes (flush probe excluded): tick ${clsLine(_classTick)} || anim ${clsLine(_classAnim)}\n` +
                        `  - Faces animating (of ${built.length}): at tick frames ${animFacesStr(_classTick)} · between ticks ${animFacesStr(_classAnim)} (= faces Phase-1B idle-face skipping would still render)\n` +
                        `  - Post-callback slack (rAF gap minus our JS): after tick ${slackLine(_classTick)} · after anim ${slackLine(_classAnim)} (after-anim slack follows the flush probe)\n` +
                        `  - Intervals by preceding frame class: after tick ${intervalLine(_classTick)} · after anim ${intervalLine(_classAnim)}\n` +
                        `  - Interval histogram (ms:count, 2ms buckets): after-tick ${histStr(_classTick)} | after-anim ${histStr(_classAnim)}\n` +
                        `  - Per-face avg ms/frame (render+update), ranked by render: ${perFaceStr}` +
                        (_tickProfile ? (() => {
                            const entries = [...getPartProfile().entries()].sort((a, b) => b[1] - a[1]);
                            if (entries.length === 0) return '';
                            const total = entries.reduce((s, [, v]) => s + v, 0);
                            return `\n  - Render ms/frame by part type (Σ ${f2(total / nAll)}): ` +
                                entries.map(([k, v]) => `${k} ${f2(v / nAll)}`).join(' · ');
                        })() : '') +
                        `\n  - Memory: ${canvasMemoryReport()}`;
                })()
            );
        }

        // Check for quantized tick boundary
        timeController.checkTick(now);

        // Snapshot the time for this frame — all getNow() calls within
        // this frame will return the exact same value.
        timeController.beginFrame();
        // Safety net: in 1×/-1× continuous mode with offset, the display time
        // can drift past the supported astronomical range (4000 BCE – 2800 CE).
        // Clamp here so the boundary is enforced every frame.
        if (timeController.clampDisplayTime()) {
            finishAllAnimations();
            timeUI?.updateTimeUI();
            writeTimeState();
        }
        const frameRealTime = new Date();  // capture real time at same instant as sim

        // Compute tick parameters for the animation system
        const rate = timeController.currentRate;
        const tickMs = rate !== null ? TICK_INTERVAL_MS : null;
        const deltaSec = rate !== null ? displaySecondsPerTick(rate.unit) : 0;

        let renderMs = 0;
        let tickCpuMs = 0;
        let animatingFaceCount = 0;

        const isPureAnimFrame = isScrubbing && !willTick;
        const animStart = isPureAnimFrame ? performance.now() : 0;

        // Per-frame timing seam (scrub tick rate / display delta / direction;
        // direction is 0 when stopped so continuous values settle).
        const timingCtx = timingContextForFrame(timeController);

        if (_ablateOneCanvas) syncSharedLayout();

        // facebuffers: choose up to FB_REBUILDS_PER_FRAME stale faces to rebuild
        // this frame, round-robin from _fbCursor so no face starves when
        // frames-per-tick < faces/FB_REBUILDS_PER_FRAME.
        let _fbRebuildSet: Set<number> | null = null;
        if (_ablateFaceBuffers && isScrubbing) {
            _fbRebuildSet = new Set();
            let lastPicked = -1;
            for (let scanned = 0; scanned < faces.length && _fbRebuildSet.size < FB_REBUILDS_PER_FRAME; scanned++) {
                const idx = (_fbCursor + scanned) % faces.length;
                const f = faces[idx];
                if (f.enabled && f.cachesBuilt && (f.fbEpoch ?? -1) !== _fbTickEpoch) {
                    _fbRebuildSet.add(idx);
                    lastPicked = idx;
                }
            }
            if (lastPicked >= 0) _fbCursor = (lastPicked + 1) % faces.length;
        }

        for (let fi = 0; fi < faces.length; fi++) {
            const face = faces[fi];
            if (!face.enabled || !face.cachesBuilt) continue;
            // Per-face error boundary. The whole rAF loop is a single chain
            // (setTimeout → onIdleWakeup → rAF → frame → armIdle → …) with no
            // watchdog: if this frame throws before the re-arm at the bottom, the
            // loop is left with rafId === null and idleTimerId === null and stays
            // frozen until some unrelated event calls ensureSchedulerRunning(). In
            // the all-faces grid that means one face's transient failure freezes
            // *every* face. Contain a face's tick/render here so the loop always
            // reaches its re-arm; the display time keeps advancing, so a transient
            // (time-dependent) failure clears itself on a later frame.
            try {
                // Drive all ObsValues for this face — hands, wheels, dials, wedges,
                // masterOffset, and the terminator leaves (all on the per-face Updater).
                // Phase 1 ablation gates — active only while scrubbing.
                // staggertick freezes odd faces on the tick frame (no tick, no
                // render); they catch up next frame (the updater's guard loop
                // chains ARRIVED→SITTING→SWEEPING for late processing).
                const doTick = !isScrubbing
                    || !_ablateStaggerTick || _framesSinceTick >= (fi % 2);

                const tickStart = performance.now();
                if (doTick) {
                    if (face.updater.tick(face.env, now, face.getNow, face.withDisplayTime, timingCtx)) {
                        face.renderDirty = true;
                    }
                }
                const tickEnd = performance.now();
                tickCpuMs += tickEnd - tickStart;

                // Per-face render gate: at 1×/idle, skip the draw when nothing that
                // draws has changed since this face's last draw (lookahead frames and
                // other faces' beats otherwise cause byte-identical full redraws).
                // During scrub every value moves every tick, so the gate never
                // engages there — scrub keeps its original (ablation-gated) logic.
                const doRender = isScrubbing
                    ? (doTick
                        && !_ablateRender
                        && fi < _facesLimit
                        && (!_ablateStaggerRender || (_frameCounter + fi) % 2 === 0))
                    : face.renderDirty;

                if (doRender) {
                    const fbW = face.canvas.width;
                    const fbH = face.canvas.height;
                    if (_fbRebuildSet && _fbRebuildSet.has(fi)) {
                        // facebuffers: rebuild this face's buffer (full render,
                        // circle-cropped like the CSS border-radius crop).
                        if (!face.fbCanvas || face.fbCanvas.width !== fbW || face.fbCanvas.height !== fbH) {
                            face.fbCanvas = document.createElement('canvas');
                            face.fbCanvas.width = fbW;
                            face.fbCanvas.height = fbH;
                            face.fbCtx = face.fbCanvas.getContext('2d')!;
                        }
                        renderFrame(face.fbCtx!, face.watch, face.env, face.scale, face.images, face.terminatorLeaves, face.analemmaState,
                            { clipToCircle: true, noBezel: _ablateNoBezel });
                        face.fbEpoch = _fbTickEpoch;
                    }
                    if (_fbRebuildSet && face.fbCanvas) {
                        // facebuffers: blit the (possibly one-tick-old) buffer.
                        if (_ablateOneCanvas && _sharedCtx && _sharedOffsets[fi]) {
                            const o = _sharedOffsets[fi];
                            _sharedCtx.clearRect(o.x, o.y, fbW, fbH);
                            _sharedCtx.drawImage(face.fbCanvas, o.x, o.y);
                        } else {
                            face.ctx.clearRect(0, 0, fbW, fbH);
                            face.ctx.drawImage(face.fbCanvas, 0, 0);
                        }
                    } else if (_ablateOneCanvas && _sharedCtx && _sharedOffsets[fi]) {
                        renderFrame(_sharedCtx, face.watch, face.env, face.scale, face.images, face.terminatorLeaves, face.analemmaState,
                            { x: _sharedOffsets[fi].x, y: _sharedOffsets[fi].y, w: fbW, h: fbH, noBezel: _ablateNoBezel, clipToCircle: true });
                    } else {
                        renderFrame(face.ctx, face.watch, face.env, face.scale, face.images, face.terminatorLeaves, face.analemmaState,
                            _ablateNoBezel ? { noBezel: true } : undefined);
                    }
                    face.renderDirty = false;
                    _dsDraws++;
                }

                const renderEnd = performance.now();
                renderMs += renderEnd - tickEnd;
                if (isScrubbing) {
                    _faceTickMs[fi] += tickEnd - tickStart;
                    _faceRenderMs[fi] += renderEnd - tickEnd;
                }

                const faceAnimating = face.updater.anyAnimating();
                if (faceAnimating) {
                    stillAnimating = true;
                    animatingFaceCount++;
                }
            } catch (err) {
                // Log loudly (this should never happen) but keep the loop alive.
                // A throw mid-tick may have moved values without reporting it, and a
                // throw mid-render leaves a half-drawn canvas — either way, redraw.
                face.renderDirty = true;
                console.error(`[frame] face "${face.watch?.name ?? '?'}" tick/render threw; skipping this frame:`, err);
            }
        }

        // Accumulate the tick/render CPU split across all scrub frames.
        if (isScrubbing) {
            _scrubTickMsTotal += tickCpuMs;
            _scrubRenderMsTotal += renderMs;
            _scrubBodyFrameCount++;
        }

        let gpuProbeMs = 0;
        if (isPureAnimFrame) {
            const animJsEnd = performance.now();
            const testFace = faces.find(f => f.enabled && f.cachesBuilt);
            if (testFace && _probeEnabled) {
                testFace.ctx.getImageData(0, 0, 1, 1);
            }
            const animGpuEnd = performance.now();
            const cpuTime = animJsEnd - animStart;
            const gpuTime = animGpuEnd - animJsEnd;
            gpuProbeMs = gpuTime;

            _pureAnimCount++;
            _pureAnimCpuTimeTotal += cpuTime;
            if (cpuTime < _pureAnimCpuMin) _pureAnimCpuMin = cpuTime;
            if (cpuTime > _pureAnimCpuMax) _pureAnimCpuMax = cpuTime;

            _pureAnimGpuTimeTotal += gpuTime;
            if (gpuTime < _pureAnimGpuMin) _pureAnimGpuMin = gpuTime;
            if (gpuTime > _pureAnimGpuMax) _pureAnimGpuMax = gpuTime;

            if (_lastAnimFrameTime !== null) {
                const delta = now - _lastAnimFrameTime;
                _pureAnimDeltaTotal += delta;
                _pureAnimDeltaCount++;
                if (delta < _pureAnimDeltaMin) _pureAnimDeltaMin = delta;
                if (delta > _pureAnimDeltaMax) _pureAnimDeltaMax = delta;
            }
            _lastAnimFrameTime = now;
        } else if (isScrubbing && willTick) {
            _lastAnimFrameTime = null;
        }
        // Update mini-bar time display (using frameRealTime captured at beginFrame)
        // This is a lightweight per-frame update — the full updateTimeUI() rebuilds
        // transport buttons and is called only on state changes, not every frame.
        timeUI?.updateTimeUI();

        timeController.endFrame();

        if (isScrubbing) {
            // Per-class body CPU (frame start → here). Excludes the flush probe
            // (reported separately; nonzero only on pure-anim frames) so the
            // tick/anim class comparison isn't skewed by measurement cost.
            const bodyEnd = performance.now();
            const cls = willTick ? _classTick : _classAnim;
            const cpu = bodyEnd - frameStart - gpuProbeMs;
            cls.n++;
            cls.cpuMs += cpu;
            if (cpu > cls.cpuMax) cls.cpuMax = cpu;
            cls.tickMs += tickCpuMs;
            cls.renderMs += renderMs;
            cls.animFaces += animatingFaceCount;
            if (animatingFaceCount < cls.animFacesMin) cls.animFacesMin = animatingFaceCount;
            if (animatingFaceCount > cls.animFacesMax) cls.animFacesMax = animatingFaceCount;
            _prevScrubFrameWasTick = willTick;
            _prevScrubFrameStart = frameStart;
            _prevScrubFrameEnd = bodyEnd;
        } else {
            _prevScrubFrameStart = null;
            _prevScrubFrameEnd = null;
        }

        // One-shot memory ledger once every face's caches exist (initial footprint).
        if (!_memReported && faces.every(f => !f.enabled || f.cachesBuilt)) {
            _memReported = true;
            console.log(`[mem] build ${_buildStamp()} · ` + canvasMemoryReport());
        }

        if (_drawStats) {
            if (isScrubbing) {
                // Scrub draws are ungated by design; keep them out of the numbers.
                _dsDraws = 0; _dsFrames = 0; _dsLastReport = 0;
            } else {
                _dsFrames++;
                if (_dsLastReport === 0) {
                    _dsLastReport = now; _dsDraws = 0; _dsFrames = 0;
                } else if (now - _dsLastReport >= 5000) {
                    const s = (now - _dsLastReport) / 1000;
                    const nFaces = faces.filter(f => f.enabled).length;
                    console.log(`[drawstats] build ${_buildStamp()} · `
                        + `${(_dsDraws / s).toFixed(1)} face-draws/s · `
                        + `${(_dsFrames / s).toFixed(1)} loop-frames/s · `
                        + `${nFaces} faces (ungated would draw ${(_dsFrames / s * nFaces).toFixed(0)}/s)`);
                    _dsDraws = 0; _dsFrames = 0; _dsLastReport = now;
                }
            }
        }

        // Decide whether to keep the RAF loop running
        const willContinue = timeController.needsContinuousRender || stillAnimating;
        _fps?.recordFrame(willContinue, performance.now() - frameStart);
        if (willContinue) {
            rafId = requestAnimationFrame(frame);
        } else {
            armIdle();
        }
    }

    function armIdle() {
        if (idleTimerId !== null) return;
        // A stopped clock never needs a re-evaluation wakeup: display time is
        // frozen, so hand expressions return constant values. Bailing here lets
        // the loop go fully idle once any in-flight animation settles, instead
        // of busy-waiting on per-hand update schedules. Resuming (play/step/env
        // change) re-arms the loop via ensureSchedulerRunning().
        if (timeController.isStopped) return;
        let earliest = Infinity;
        for (const face of faces) {
            if (!face.enabled) continue;
            const t = face.updater.nextWakeupTime();
            if (t < earliest) earliest = t;
        }
        if (earliest === Infinity) return;
        const delay = Math.max(0, earliest - performance.now() - SCHEDULER_LOOKAHEAD_MS);
        idleTimerId = setTimeout(onIdleWakeup, delay);
    }

    function onIdleWakeup() {
        idleTimerId = null;
        if (rafId !== null) return;
        rafId = requestAnimationFrame(frame);
    }

    function startScheduler() {
        stopScheduler();
        // Every explicit kick (location/DST rebuild, planet/mode/slot toggles,
        // cross-tab sync, Now) historically relied on "the next frame redraws
        // everything anyway" — preserve that contract under the render gate.
        for (const face of faces) face.renderDirty = true;
        rafId = requestAnimationFrame(frame);
    }

    // =========================================================================
    // DST transition detection
    // =========================================================================
    // The watch environments capture timezone-related values (tzDeltaMs,
    // tzOffsetSeconds) as constants at creation time.  When a DST transition
    // occurs in either the location timezone or the browser's system timezone,
    // these values become stale.  We compute the exact next transition time
    // and set a precise timer rather than polling.
    //
    // A lightweight 1-second poll of the browser's IANA timezone *name*
    // handles manual OS timezone changes (which invalidate tzDeltaMs
    // immediately and may change the browser-TZ DST schedule).

    let _dstTimerId: ReturnType<typeof setTimeout> | null = null;

    /**
     * Rebuild environments when a DST transition occurs or the browser's
     * system timezone changes.  Follows the §3 animation-preserving pattern.
     */
    function handleDstTransition() {

        // Use displayed time — in offset 1× mode the displayed date may
        // be in a different DST state than the real date.
        tzDeltaMs = computeTzDeltaMs(locationTimezone, rawGetNow());

        for (const face of faces) {
            if (!face.enabled) continue;
            const oldKnockout = (face.env as any)._terraCityKnockout;
            face.env = createWatchEnvironment(face.watch, lat, lon, makeGetNow(face.watch.beatsPerSecond, face.getNow), locationTimezone, face.terraSlotOverrides, face.globalLocationSlot);
                    restoreKyotoState(face);
            if (oldKnockout) (face.env as any)._terraCityKnockout = oldKnockout;
            if (face.terminatorLeaves.length > 0) {
                updateLeafAngles(face.terminatorLeaves, face.env);
            }
            const { canvas, watch, env, images, scale } = face;
            buildStaticBlockCaches(watch, env, canvas.width, canvas.height, scale, images, face.terminatorLeaves);
            face.updater.reset();
        }

        timeUI?.updateTimezoneDisplay();
        stopScheduler();
        startScheduler();
    }

    /**
     * Compute the next DST transition in either the location timezone or
     * the browser timezone, and set a setTimeout for that moment.
     * Chains via setTimeout for delays exceeding the 2^31-1 ms limit.
     */
    function scheduleDstRebuild() {
        if (_dstTimerId !== null) { clearTimeout(_dstTimerId); _dstTimerId = null; }

        // Use the *displayed* time (not real time) to find the next transition.
        // In 1× forward with an offset, displayed time may cross DST boundaries
        // at a different wall-clock time than the real time.
        const displayNow = rawGetNow();
        const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

        // Choose search direction based on time controller state.
        // In -1× mode, time moves backward so we need the previous transition.
        const isBackward = timeController.currentDirection === -1 && timeController.currentRate === null;
        const findTransition = isBackward ? findPrevDstTransition : findNextDstTransition;

        // Find next/prev transition in location timezone
        const locNext = locationTimezone
            ? findTransition(locationTimezone, displayNow)
            : null;

        // Find next/prev transition in browser timezone (only if different)
        const browserNext = (browserTz !== locationTimezone)
            ? findTransition(browserTz, displayNow)
            : null;

        // Take the earliest
        let next: Date | null = null;
        if (locNext && browserNext) {
            next = locNext < browserNext ? locNext : browserNext;
        } else {
            next = locNext || browserNext;
        }

        if (!next) {
            return;
        }

        // Compute delay in real time.  In 1× mode the display-time delta
        // equals real-time delta.  In -1× mode the display time moves
        // backward, so the delay is how far back in display time the
        // target is (absolute difference either way).
        // In accelerated modes, rebuildEnvironments() runs on every tick
        // and already calls scheduleDstRebuild(), so this timer is
        // redundant but harmless.
        let delay = Math.abs(next.getTime() - displayNow.getTime());

        // setTimeout max is ~24.8 days (2^31 - 1 ms).
        // If further out, set a wake-up at 24 days to re-check.
        const MAX_TIMEOUT = 2_147_483_647; // 2^31 - 1
        if (delay > MAX_TIMEOUT) {
            _dstTimerId = setTimeout(scheduleDstRebuild, MAX_TIMEOUT);
            return;
        }

        // Add a small buffer to ensure we're past the boundary.
        // The binary search already converges to the exact minute, so
        // 100ms is sufficient.
        delay = Math.max(0, delay) + 100;


        _dstTimerId = setTimeout(() => {
            _dstTimerId = null;
            handleDstTransition();
            scheduleDstRebuild(); // Schedule the next one
        }, delay);
    }

    // --- Lightweight browser TZ name poll ---
    // Detects manual OS timezone changes, which invalidate tzDeltaMs
    // immediately and may change the browser-TZ DST schedule.
    let _cachedBrowserTzName = Intl.DateTimeFormat().resolvedOptions().timeZone;

    setInterval(() => {
        const currentTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (currentTz === _cachedBrowserTzName) return;

        console.log(`[tz-detect] Browser timezone changed: ${_cachedBrowserTzName} → ${currentTz}`);
        _cachedBrowserTzName = currentTz;

        // Immediately rebuild envs so tzDeltaMs is recalculated
        handleDstTransition();

        // Reschedule DST timer for the new browser TZ
        scheduleDstRebuild();
    }, 1000);

    // =========================================================================
    // Resize handling
    // =========================================================================

    const GAP_PX = 12;
    const PADDING_PX = 12;
    const POPOVER_GAP = 8;   // minimum gap between face edge and popover

    let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let lastContainerW = 0;
    let lastContainerH = 0;
    let wasShifted = false;  // tracks if face is currently in a popover-dodged position
    let wasAstroTab = false;  // tracks if the Astro tab was active during last layout

    /**
     * Compute face center positions (relative to the grid container)
     * for a given grid configuration and face size.
     * offsetAdjustX/Y shift the grid from its default centered position.
     */
    function computeFaceCenters(
        nFaces: number, gridCols: number, gridRows: number,
        size: number, containerW: number, containerH: number,
        offsetAdjustX = 0, offsetAdjustY = 0,
    ): Array<{ cx: number; cy: number }> {
        const cellStep = size + GAP_PX;
        const remainder = nFaces - gridCols * (gridRows - 1);
        const canNestle = gridRows > 1 && remainder !== gridCols
                          && (gridCols - remainder) % 2 === 1;
        const nestledStep = canNestle ? cellStep * Math.sqrt(3) / 2 : cellStep;

        const gridW = gridCols * size + (gridCols - 1) * GAP_PX;
        const lastRowY = gridRows === 1 ? 0 : nestledStep + (gridRows - 2) * cellStep;
        const totalH = lastRowY + size;

        const offsetX = (containerW - gridW) / 2 + offsetAdjustX;
        const offsetY = (containerH - totalH) / 2 + offsetAdjustY;

        const centers: Array<{ cx: number; cy: number }> = [];
        for (let i = 0; i < nFaces; i++) {
            let row: number, colIdx: number, itemsInRow: number;
            if (i < remainder) {
                row = 0; colIdx = i; itemsInRow = remainder;
            } else {
                const j = i - remainder;
                row = 1 + Math.floor(j / gridCols);
                colIdx = j % gridCols;
                itemsInRow = gridCols;
            }
            const rowW = itemsInRow * size + (itemsInRow - 1) * GAP_PX;
            const rowOffsetX = (gridW - rowW) / 2;
            const x = offsetX + rowOffsetX + colIdx * cellStep;
            const rowY = row === 0 ? 0 : nestledStep + (row - 1) * cellStep;
            const y = offsetY + rowY;
            centers.push({ cx: x + size / 2, cy: y + size / 2 });
        }
        return centers;
    }

    /**
     * Check if any circular face overlaps a rectangle (the popover).
     * Returns true if overlap detected.
     */
    function anyFaceOverlapsRect(
        centers: Array<{ cx: number; cy: number }>,
        radius: number,
        rectLeft: number, rectTop: number,
        rectRight: number, rectBottom: number,
    ): boolean {
        for (const { cx, cy } of centers) {
            const nearX = Math.max(rectLeft, Math.min(cx, rectRight));
            const nearY = Math.max(rectTop, Math.min(cy, rectBottom));
            const dx = cx - nearX;
            const dy = cy - nearY;
            if (dx * dx + dy * dy < (radius + POPOVER_GAP) * (radius + POPOVER_GAP)) {
                return true;
            }
        }
        return false;
    }


    function onGridResize(W: number, H: number) {
        lastContainerW = W;
        lastContainerH = H;

        const result = optimizeGrid(faces.length, W, H, GAP_PX, PADDING_PX);
        if (result.size <= 0) return;

        let size = result.size;
        let gridShiftX = 0, gridShiftY = 0;
        let useTopLeftAlign = false;

        // Compute X position for column c with hex close-pack at the
        // long/short boundary.  Long columns use normal cellStep spacing,
        // and the first short column is placed hexStep from the last long
        // column. Subsequent short columns use normal cellStep.
        const hexColX = (
            col: number, remainder: number, nCols: number,
            cellStep: number, hasNestle: boolean,
        ): number => {
            if (!hasNestle || col < remainder) {
                return col * cellStep;
            }
            const hexStep = cellStep * Math.sqrt(3) / 2;
            return (remainder - 1) * cellStep + hexStep + (col - remainder) * cellStep;
        };

        // If the popover is open, find the largest face size where some
        // grid configuration (column count) places the grid top-left-aligned
        // without the bottom-right face overlapping the popover.
        if (timeUI?.isPopoverOpen()) {
            const gridRect = grid.getBoundingClientRect();
            const popRect = document.getElementById('time-popover')!.getBoundingClientRect();
            // Use tp-upper's narrow width for horizontal bounds (tp-lower
            // sits over the time bar/location panel below the grid, so its
            // extra width doesn't block faces in the grid area).
            const upperEl = document.getElementById('tp-upper')!;
            const upperRect = upperEl.getBoundingClientRect();
            const pLeft = upperRect.left - gridRect.left;
            const pTop = popRect.top - gridRect.top;
            const pRight = upperRect.right - gridRect.left;
            const pBottom = popRect.bottom - gridRect.top;

            // Build exclusion rects: always include tp-upper region.
            // When the Astro tab is active, tp-lower is taller and can
            // overlap faces, so add it as a second exclusion zone.
            type Rect = { left: number; top: number; right: number; bottom: number };
            const exclusionRects: Rect[] = [
                { left: pLeft, top: pTop, right: pRight, bottom: pBottom },
            ];
            const lowerEl = document.getElementById('tp-lower');
            const astroActive = lowerEl &&
                !document.getElementById('tp-tab-astro')?.classList.contains('tp-pane-hidden');
            if (astroActive && lowerEl) {
                const lowerRect = lowerEl.getBoundingClientRect();
                exclusionRects.push({
                    left: lowerRect.left - gridRect.left,
                    top: lowerRect.top - gridRect.top,
                    right: lowerRect.right - gridRect.left,
                    bottom: lowerRect.bottom - gridRect.top,
                });
            }

            /** Check if a circle overlaps any exclusion rect. */
            const circleOverlapsExclusion = (
                cx: number, cy: number, r: number,
            ): boolean => {
                for (const rect of exclusionRects) {
                    const nearX = Math.max(rect.left, Math.min(cx, rect.right));
                    const nearY = Math.max(rect.top, Math.min(cy, rect.bottom));
                    const dx = cx - nearX;
                    const dy = cy - nearY;
                    if (dx * dx + dy * dy < (r + POPOVER_GAP) * (r + POPOVER_GAP)) {
                        return true;
                    }
                }
                return false;
            };

            // Check whether a grid with `cols` columns at face `size`
            // fits without any face overlapping the popover.
            // The grid is pinned to top-left (PADDING offset).
            const configFits = (cols: number, s: number): boolean => {
                const rows = Math.ceil(faces.length / cols);
                const cellStep = s + GAP_PX;
                const remainder = faces.length - cols * (rows - 1);
                const r = s / 2;

                const hasNestle = remainder > 0 && remainder < cols;

                // Check grid fits in container at all
                const lastColX = hexColX(cols - 1, remainder, cols, cellStep, hasNestle);
                const gridW = lastColX + s + 2 * PADDING_PX;
                const gridH = (rows - 1) * cellStep + s + 2 * PADDING_PX;
                if (gridW > W || gridH > H) return false;

                // Check ALL faces for overlap with exclusion zones
                for (let i = 0; i < faces.length; i++) {
                    const row = Math.floor(i / cols);
                    const col = i % cols;
                    const isShortCol = col >= remainder;
                    const ny = isShortCol && hasNestle ? cellStep / 2 : 0;
                    const cx = PADDING_PX + hexColX(col, remainder, cols, cellStep, hasNestle) + r;
                    const cy = PADDING_PX + row * cellStep + ny + r;

                    if (circleOverlapsExclusion(cx, cy, r)) {
                        return false;
                    }
                }
                return true;
            };

            // Check if the current full-size layout has overlap
            const centers = computeFaceCenters(
                faces.length, result.cols, result.rows, size, W, H);
            let hasOverlap = false;
            for (const { cx, cy } of centers) {
                if (circleOverlapsExclusion(cx, cy, size / 2)) {
                    hasOverlap = true;
                    break;
                }
            }
            if (hasOverlap) {

                // Binary search for the largest face size that works
                // with some grid configuration, pinned top-left.
                // Use max(W,H) as upper bound since hex packing allows
                // larger faces than optimizeGrid's uniform-spacing estimate.
                let lo = 0, hi = Math.max(W, H);

                for (let iter = 0; iter < 25; iter++) {
                    const mid = Math.floor((lo + hi) / 2);
                    if (mid <= 0) break;

                    // Try all possible column counts
                    let anyWorks = false;
                    for (let c = 1; c <= faces.length; c++) {
                        if (configFits(c, mid)) {
                            anyWorks = true;
                            break;
                        }
                    }
                    if (anyWorks) {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }

                // Found the max size. Now pick the best column count at that size:
                // prefer the config that gives the largest face (they're all `lo`,
                // so prefer fewer total cells = more balanced layout).
                size = lo;
                let bestConfig = result.cols;
                for (let c = 1; c <= faces.length; c++) {
                    if (configFits(c, size)) {
                        bestConfig = c;
                        break;  // first valid config at this size
                    }
                }

                result.cols = bestConfig;
                result.rows = Math.ceil(faces.length / bestConfig);
                useTopLeftAlign = true;
                if (size <= 0) return;

                // Now find the best position that doesn't overlap.
                const cellStep = size + GAP_PX;
                const remainder = faces.length - bestConfig * (result.rows - 1);
                const hasNestle = remainder > 0 && remainder < bestConfig;
                const lastColX = hexColX(bestConfig - 1, remainder, bestConfig, cellStep, hasNestle);
                const gridW = lastColX + size;
                const gridH = (result.rows - 1) * cellStep + size;
                const centeredX = (W - gridW) / 2 - PADDING_PX;
                const centeredY = (H - gridH) / 2 - PADDING_PX;
                const r = size / 2;

                const shiftFits = (dx: number, dy: number): boolean => {
                    for (let i = 0; i < faces.length; i++) {
                        const row = Math.floor(i / bestConfig);
                        const col = i % bestConfig;
                        const isShort = col >= remainder;
                        const cx = PADDING_PX + dx + hexColX(col, remainder, bestConfig, cellStep, hasNestle) + r;
                        const cy = PADDING_PX + dy + row * cellStep + (isShort && hasNestle ? cellStep / 2 : 0) + r;
                        if (circleOverlapsExclusion(cx, cy, r)) {
                            return false;
                        }
                    }
                    return true;
                };

                // Step 1: find best horizontal position
                let sLo = 0, sHi = Math.max(0, centeredX);
                for (let iter = 0; iter < 20; iter++) {
                    const sMid = (sLo + sHi) / 2;
                    if (shiftFits(sMid, 0)) {
                        sLo = sMid;
                    } else {
                        sHi = sMid;
                    }
                }
                gridShiftX = sLo;

                // Step 2: at that horizontal position, find best vertical position
                let vLo = 0, vHi = Math.max(0, centeredY);
                for (let iter = 0; iter < 20; iter++) {
                    const vMid = (vLo + vHi) / 2;
                    if (shiftFits(gridShiftX, vMid)) {
                        vLo = vMid;
                    } else {
                        vHi = vMid;
                    }
                }
                gridShiftY = vLo;
            }
        }

        const dpr = effectiveDpr();
        const newPhys = Math.round(size * dpr);
        // Skip if size hasn't changed AND layout position hasn't changed
        const isAstroTab = (timeUI?.isPopoverOpen() ?? false) &&
            !document.getElementById('tp-tab-astro')?.classList.contains('tp-pane-hidden');
        const positionChanged = useTopLeftAlign !== wasShifted || isAstroTab !== wasAstroTab;
        if (newPhys === faces[0]?.canvas.width && !positionChanged) return;
        wasShifted = useTopLeftAlign;
        wasAstroTab = isAstroTab;

        // Deliberately NOT stopScheduler() here. The render loop keeps running
        // across the (async, per-face) cache rebuild below: a face whose cache we
        // invalidate (cachesBuilt=false) is skipped by the frame loop and re-appears
        // when its rebuild completes, while every already-built face keeps animating.
        // Previously we stopped the loop and only restarted it in the rebuild's
        // completion callback — which made grid liveness hostage to that async
        // setTimeout chain: a throttled timer (backgrounded tab) or a thrown
        // buildCache would strand *every* face frozen for seconds. The build is
        // ~100–350ms for the full grid (measured), so faces resolve to the new
        // values within a few hundred ms; the startScheduler() at the end is now
        // just a prompt-render kick, not a restart-from-stopped.

        cols = result.cols;
        rows = result.rows;

        if (useTopLeftAlign) {
            // Top-left-aligned grid with hex close-pack (matches configFits() geometry)
            const cellStep = size + GAP_PX;
            const remainder = faces.length - cols * (rows - 1);
            const hasNestle = remainder > 0 && remainder < cols;

            for (let i = 0; i < faces.length; i++) {
                const row = Math.floor(i / cols);
                const col = i % cols;
                const isShortCol = col >= remainder;
                const x = PADDING_PX + gridShiftX + hexColX(col, remainder, cols, cellStep, hasNestle);
                const y = PADDING_PX + gridShiftY + row * cellStep + (isShortCol && hasNestle ? cellStep / 2 : 0);
                const cell = faces[i].canvas.parentElement as HTMLElement;
                cell.style.position = 'absolute';
                cell.style.left = `${x}px`;
                cell.style.top = `${y}px`;
                cell.style.width = `${size}px`;
                cell.style.height = `${size}px`;
            }
        } else {
            const cellStep = size + GAP_PX; // center-to-center distance

            // Position each face cell absolutely.
            // The first (incomplete) row goes at the top.
            const remainder = faces.length - cols * (rows - 1); // items in short top row

            // Nestling: when (cols - remainder) is odd, the short row's faces
            // are offset by half a cellStep from the full rows.  Round faces
            // can nestle into those gaps, reducing the vertical spacing so that
            // the diagonal edge-to-edge distance equals GAP_PX.
            const canNestle = rows > 1 && remainder !== cols && (cols - remainder) % 2 === 1;
            const nestledStep = canNestle ? cellStep * Math.sqrt(3) / 2 : cellStep;

            // Total grid dimensions (nestled first gap, normal for rest)
            const gridW = cols * size + (cols - 1) * GAP_PX;
            // Simpler: row 0 at y=0, row 1 at y=nestledStep, row k>1 at y=nestledStep+(k-1)*cellStep
            // Total height = last_row_y + size
            const lastRowY = rows === 1 ? 0 : nestledStep + (rows - 2) * cellStep;
            const totalH = lastRowY + size;

            // Offset to center the grid in the container, with popover shift
            const offsetX = (W - gridW) / 2 + gridShiftX;
            const offsetY = (H - totalH) / 2 + gridShiftY;

            for (let i = 0; i < faces.length; i++) {
                let row: number, colIdx: number, itemsInRow: number;

                if (i < remainder) {
                    // Short top row
                    row = 0;
                    colIdx = i;
                    itemsInRow = remainder;
                } else {
                    // Full rows below
                    const j = i - remainder;
                    row = 1 + Math.floor(j / cols);
                    colIdx = j % cols;
                    itemsInRow = cols;
                }

                // Center incomplete rows: extra offset for short rows
                const rowW = itemsInRow * size + (itemsInRow - 1) * GAP_PX;
                const rowOffsetX = (gridW - rowW) / 2;

                const x = offsetX + rowOffsetX + colIdx * cellStep;
                // Row 0 at y=0, row 1 at y=nestledStep, row 2+ at y=nestledStep+(row-1)*cellStep
                const rowY = row === 0 ? 0 : nestledStep + (row - 1) * cellStep;
                const y = offsetY + rowY;

                const cell = faces[i].canvas.parentElement as HTMLElement;
                cell.style.position = 'absolute';
                cell.style.left = `${x}px`;
                cell.style.top = `${y}px`;
                cell.style.width = `${size}px`;
                cell.style.height = `${size}px`;
            }
        }

        for (const face of faces) {
            applySize(face, size);
            face.cachesBuilt = false;
        }

        buildAllCachesSequentially(faces.filter(f => f.enabled), () => {
            startScheduler();
            scheduleDstRebuild();
        });
    }

    /** Manually trigger a grid resize recalculation (used when UI elements
     *  change visibility without changing the viewport size). */
    function triggerManualResize() {
        const appEl = grid.parentElement!;
        const W = appEl.clientWidth;
        const totalH = appEl.clientHeight;
        const locPanelH = document.getElementById('location-panel')?.offsetHeight ?? 0;
        const tbH = document.getElementById('time-bar')?.offsetHeight ?? 0;
        const psH = document.getElementById('planet-selector')?.offsetHeight ?? 0;
        const ccH = document.getElementById('change-cities-btn')?.offsetHeight ?? 0;
        const vtH = document.getElementById('vienna-noon-toggle')?.offsetHeight ?? 0;
        const ktH = document.getElementById('kyoto-mode-toggle')?.offsetHeight ?? 0;
        const khH = document.getElementById('kyoto-hand-toggle')?.offsetHeight ?? 0;
        onGridResize(W, totalH - locPanelH - tbH - psH - ccH - vtH - ktH - khH);
    }

    const resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const { width } = entry.contentRect;
        if (isEmbedMode) {
            // No panels to subtract — face fills viewport
            if (resizeDebounceTimer !== null) clearTimeout(resizeDebounceTimer);
            resizeDebounceTimer = setTimeout(() => {
                resizeDebounceTimer = null;
                onGridResize(width, entry.contentRect.height);
            }, 150);
        } else {
            // Subtract the location panel and time bar heights from the parent's height
            const locationPanel = document.getElementById('location-panel');
            const timeBarEl = document.getElementById('time-bar');
            const planetSelectorEl = document.getElementById('planet-selector');
            const changeCitiesBtnEl = document.getElementById('change-cities-btn');
            const viennaToggleEl = document.getElementById('vienna-noon-toggle');
            const panelH = locationPanel ? locationPanel.offsetHeight : 0;
            const timeBarH = timeBarEl ? timeBarEl.offsetHeight : 0;
            const planetSelH = planetSelectorEl ? planetSelectorEl.offsetHeight : 0;
            const changeCitiesH = changeCitiesBtnEl ? changeCitiesBtnEl.offsetHeight : 0;
            const viennaToggleH = viennaToggleEl ? viennaToggleEl.offsetHeight : 0;
            const kyotoToggleEl = document.getElementById('kyoto-mode-toggle');
            const kyotoToggleH = kyotoToggleEl ? kyotoToggleEl.offsetHeight : 0;
            const kyotoHandToggleEl = document.getElementById('kyoto-hand-toggle');
            const kyotoHandToggleH = kyotoHandToggleEl ? kyotoHandToggleEl.offsetHeight : 0;
            const height = entry.contentRect.height - panelH - timeBarH - planetSelH - changeCitiesH - viennaToggleH - kyotoToggleH - kyotoHandToggleH;
            if (resizeDebounceTimer !== null) clearTimeout(resizeDebounceTimer);
            resizeDebounceTimer = setTimeout(() => {
                resizeDebounceTimer = null;
                onGridResize(width, height);
            }, 150);
        }
    });
    resizeObserver.observe(grid.parentElement!);

    // =========================================================================
    // Location change / prompt
    // =========================================================================

    function rebuildAllForLocation(newLat: number, newLon: number) {
        lat = newLat;
        lon = newLon;
        for (const face of faces) {
            if (!face.enabled) continue;
            // Re-run slot overrides for Terra (worldTimeRing) faces — the global
            // location slot may change when the user changes their location.
            if (face.watch.worldTimeRing) {
                const slotResult = buildSlotOverrides(face.watch);
                face.terraSlotOverrides = slotResult?.overrides;
                face.globalLocationSlot = slotResult?.globalLocationSlot;
            }
            // Update Gaia slot 1 to match new observer location
            if (face.watch.worldTimeSubdials && face.terraSlotOverrides) {
                let obsName = locationSource;
                if (!obsName && isCityDataLoaded() && (newLat !== 0 || newLon !== 0)) {
                    const closest = findClosestCity(newLat, newLon);
                    if (closest) obsName = closest.shortLabel;
                }
                face.terraSlotOverrides[1] = {
                    cityName: obsName || 'Observer',
                    olsonId: locationTimezone || '',
                    lat: newLat, lon: newLon,
                };
            }
            // Fresh environment with new lat/lon/tz — same watch/parts
            face.env = createWatchEnvironment(face.watch, newLat, newLon, makeGetNow(face.watch.beatsPerSecond, face.getNow), locationTimezone, face.terraSlotOverrides, face.globalLocationSlot);
            restoreKyotoState(face);
            // Update terminator leaves (preserve for animation interpolation)
            if (face.terminatorLeaves.length > 0) {
                updateLeafAngles(face.terminatorLeaves, face.env);
            }
            // Rebuild static caches (day/night rings, sunrise marks, etc.)
            const { canvas, watch, env, images, scale } = face;
            buildStaticBlockCaches(watch, env, canvas.width, canvas.height, scale, images, face.terminatorLeaves);
            // Reset hand schedules so they re-evaluate immediately and animate to new targets
            face.updater.reset();
        }
        updateLocationDisplay();
        timeUI?.updateTimezoneDisplay();
        // The location panel may have changed height (e.g. city name now shown).
        // The ResizeObserver watches #app (viewport-sized) so it won't fire.
        // Defer a manual resize recalc so the face size accounts for the new panel height.
        requestAnimationFrame(() => {
            triggerManualResize();
        });
        // Kick the scheduler to start animating immediately
        stopScheduler();
        startScheduler();
    }
    // Capture the browser button's label from the HTML (single source of truth)
    const browserBtnLabel = (lpUseBrowser as HTMLButtonElement).textContent || 'Use device location via browser';

    function showLocationPrompt(blur: boolean) {
        locationPrompt.style.display = '';
        if (blur) grid.classList.add('blurred');
        // Pre-fill with current values (always, for manual invocation)
        lpLatInput.value = (lat !== 0 || lon !== 0) ? lat.toFixed(3) : '';
        lpLonInput.value = (lat !== 0 || lon !== 0) ? lon.toFixed(3) : '';
        // Clear city search and autofocus
        if (lpCityInput) { lpCityInput.value = ''; }
        if (lpCityResults) { lpCityResults.innerHTML = ''; }
        // Autofocus the search input after dialog renders
        setTimeout(() => lpCityInput?.focus(), 50);

        // Show status section (map + location name) or no-location placeholder
        const hasLocation = lat !== 0 || lon !== 0;
        if (hasLocation) {
            lpStatusSection.classList.add('visible');
            lpNoLocation.classList.add('hidden');
            updateMapPreview(lat, lon);
        } else {
            lpStatusSection.classList.remove('visible');
            lpNoLocation.classList.remove('hidden');
            // Show prominent hint on first visit (needsPrompt = no URL location),
            // plain "No location set yet" when user manually clears/re-opens.
            if (needsPrompt) {
                lpNoLocationHint.style.display = '';
                lpNoLocationDefault.style.display = 'none';
            } else {
                lpNoLocationHint.style.display = 'none';
                lpNoLocationDefault.style.display = '';
            }
        }

        // Show Done button when user can dismiss (has a real location)
        lpDialogFooter.classList.toggle('visible', !needsPrompt || hasLocation);

        // Configure browser location button based on permission state
        const btn = lpUseBrowser as HTMLButtonElement;
        const isFileUrl = window.location.protocol === 'file:';
        const deniedTooltip = isFileUrl
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

    function dismissLocationPrompt() {
        locationPrompt.style.display = 'none';
        grid.classList.remove('blurred');
    }

    const isFileProtocol = window.location.protocol === 'file:';

    /**
     * Build the location name string for the dialog header.
     * Rules:
     *   - If locationSourceType is 'url-city' → use locationSource + "(from cities database)"
     *   - If locationSourceType is 'browser' → find closest city + "(from browser)"
     *   - If locationSourceType is 'manual'  → find closest city + "(manually entered)"
     *   - If no city data loaded yet, just show coords
     */
    /**
     * Detect whether the browser locale prefers miles (US, UK, Myanmar, Liberia)
     * or kilometers (everyone else).
     */
    function useImperial(): boolean {
        const locale = navigator.language || 'en-US';
        const region = locale.split('-')[1]?.toUpperCase() || '';
        // US, UK (road signs in miles), Myanmar, Liberia
        return ['US', 'GB', 'MM', 'LR'].includes(region);
    }

    /**
     * Compute great-circle distance in km using the Haversine formula.
     */
    function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371; // Earth radius in km
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /**
     * Compute initial bearing from point 1 to point 2, returned as a
     * 16-point compass direction (N, NNE, NE, ENE, E, ...).
     */
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

    function buildLocationNameHTML(): string {
        if (locationSourceType === 'url-city' && locationFullLabel) {
            return `${locationFullLabel} <span class="lp-loc-source">(from cities database)</span>`;
        }
        // For browser or manual, find closest city
        if (locationSourceType === 'browser' || locationSourceType === 'manual') {
            const closest = findClosestCity(lat, lon);
            const sourceLabel = locationSourceType === 'browser' ? '(from browser)' : '(manually entered)';
            if (closest) {
                const distKm = haversineKm(lat, lon, closest.lat, closest.lon);
                const THRESHOLD_KM = 16; // ~10 miles
                if (distKm > THRESHOLD_KM) {
                    // "253 mi NNE of Princeville, HA, US (manually entered)"
                    const dir = compassBearing(closest.lat, closest.lon, lat, lon);
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
            return `${lat.toFixed(3)}, ${lon.toFixed(3)} <span class="lp-loc-source">${sourceLabel}</span>`;
        }
        // Fallback — just coords
        return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    }

    /** Update the map preview in the dialog to show the given location. */
    function updateMapPreview(mapLat: number, mapLon: number) {
        // Show the status section, hide the no-location placeholder
        lpStatusSection.classList.add('visible');
        lpNoLocation.classList.add('hidden');

        // Globe always renders
        renderGlobe(lpGlobe, mapLat, mapLon);
        // OSM tiles require a Referer header, which file:// URLs can't provide
        if (isFileProtocol) {
            lpOsmContainer.style.display = 'none';
            lpOsmAttribution.style.display = 'none';
            // Enlarge globe when it's the only map
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
        // Update location name
        lpLocationName.innerHTML = buildLocationNameHTML();
    }

    /** Apply location to the watch AND update the map preview (dialog stays open). */
    function applyLocation(newLat: number, newLon: number, source: string, fullLabel: string, sourceType: typeof locationSourceType, writeToUrl: boolean, cityTz: string | null = null) {
        locationSource = source;
        locationFullLabel = fullLabel;
        locationSourceType = sourceType;
        // Resolve timezone for this location
        locationTimezone = resolveTimezone(newLat, newLon, cityTz);
        tzDeltaMs = computeTzDeltaMs(locationTimezone);
        rebuildAllForLocation(newLat, newLon);
        // Reschedule DST timer — location timezone may have changed
        scheduleDstRebuild();
        if (writeToUrl) {
            // Explicit non-browser location → clear any prior bloc intent.
            setState({ bloc: false, lat: newLat, lon: newLon, city: source || null, tz: locationTimezone || null });
        }
        // Update the map preview and show Done button
        updateMapPreview(newLat, newLon);
        lpDialogFooter.classList.add('visible');
        needsPrompt = false;
    }

    // "Use this location" button in prompt
    lpUseCoords.addEventListener('click', () => {
        const newLat = parseFloat(lpLatInput.value);
        const newLon = parseFloat(lpLonInput.value);
        if (isNaN(newLat) || isNaN(newLon)) return;
        applyLocation(newLat, newLon, '', '', 'manual', true);
    });

    // "Use browser location" button in prompt
    lpUseBrowser.addEventListener('click', async () => {
        lpUseBrowser.textContent = 'Requesting…';
        const result = await requestBrowserLocation();  // no timeout — wait indefinitely
        if (result.status === 'success') {
            lpUseBrowser.textContent = browserBtnLabel;
            applyLocation(result.lat, result.lon, '', '', 'browser', false, null);
            // Persist bloc intent *with* the fix as a seed, so a reload shows it
            // immediately (no 0,0 flash) and can skip the DB while stationary.
            const derived = isCityDataLoaded() ? (findClosestCity(result.lat, result.lon)?.shortLabel ?? null) : null;
            setState({ bloc: true, lat: result.lat, lon: result.lon, city: derived, tz: locationTimezone || null });
        } else if (result.status === 'denied') {
            // User denied — disable the button
            geoPermission = 'denied';
            const btn = lpUseBrowser as HTMLButtonElement;
            btn.disabled = true;
            btn.textContent = browserBtnLabel + ' (unavailable)';
            const isFileUrl = window.location.protocol === 'file:';
            btn.dataset.tooltip = isFileUrl
                ? 'Not all browsers support location access from file:// URLs'
                : 'Browser location was not granted — check your browser settings to allow it';
        } else {
            lpUseBrowser.textContent = browserBtnLabel;
        }
    });

    // "Set location" button on the location bar
    setLocationBtn.addEventListener('click', () => {
        showLocationPrompt(false);  // no blur when opened manually
    });

    // Close prompt when clicking backdrop
    locationPrompt.querySelector('.lp-backdrop')!.addEventListener('click', () => {
        // Only allow closing if we have a real location (not 0,0 from startup)
        if (!needsPrompt || (lat !== 0 || lon !== 0)) {
            dismissLocationPrompt();
        }
    });

    // Close any open modal dialog with Escape key (topmost first)
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;

        // 1. Reset confirm overlay (inside city dialog)
        const confirmOverlay = document.getElementById('tc-confirm-overlay');
        if (confirmOverlay && confirmOverlay.style.display !== 'none') {
            confirmOverlay.style.display = 'none';
            return;
        }

        // 2. Terra/Gaia city dialog
        const tcDialog = document.getElementById('terra-city-dialog');
        if (tcDialog && tcDialog.style.display !== 'none') {
            tcDialog.style.display = 'none';
            grid.classList.remove('blurred');
            return;
        }

        // 3. Info overlay
        const infoOverlay = document.getElementById('info-overlay');
        if (infoOverlay && infoOverlay.classList.contains('visible')) {
            infoOverlay.classList.remove('visible');
            return;
        }

        // 4. Location prompt
        if (locationPrompt.style.display !== 'none') {
            if (!needsPrompt || (lat !== 0 || lon !== 0)) {
                dismissLocationPrompt();
            }
            return;
        }

        // 5. Time popover
        if (timeUI?.isPopoverOpen()) {
            timeUI.hidePopover();
            return;
        }
    });

    // "Done" button in map footer
    lpDoneBtn.addEventListener('click', () => {
        dismissLocationPrompt();
    });

    // =========================================================================
    // City search autocomplete
    // =========================================================================

    let citySearchDebounce: ReturnType<typeof setTimeout> | null = null;
    let cityDataLoading = false;
    let selectedCityIndex = -1;

    function renderCityResults(results: CityResult[]) {
        lpCityResults.innerHTML = '';
        selectedCityIndex = -1;
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const div = document.createElement('div');
            div.className = 'lp-city-item';
            if (r.isAirport) {
                // "SFO  San Francisco airport" — split IATA from rest
                const parts = r.label.split('  ');
                div.innerHTML = `<span class="iata-tag">${parts[0]}</span>${parts.slice(1).join('  ')}`;
            } else {
                div.textContent = r.label;
            }
            div.addEventListener('click', () => {
                applyLocation(r.lat, r.lon, r.shortLabel, r.label, 'url-city', true, r.timezone);
                lpCityInput.value = '';
                lpCityResults.innerHTML = '';
                // Update lat/lon inputs to reflect selection
                lpLatInput.value = r.lat.toFixed(3);
                lpLonInput.value = r.lon.toFixed(3);
            });
            lpCityResults.appendChild(div);
        }
    }

    let cityDataFailed = false;

    async function onCityInput() {
        try {
            let query = lpCityInput.value.trim();
            if (query.length < 2) {
                lpCityResults.innerHTML = '';
                return;
            }

            // If a previous load failed, show the error
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
                    // Re-read value — user may have typed more while loading
                    query = lpCityInput.value.trim();
                    if (query.length < 2) {
                        lpCityResults.innerHTML = '';
                        return;
                    }
                } else {
                    return;  // still loading, keep "Loading…" message visible
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

    // Listen on multiple events for iOS compatibility.
    // iOS Safari may not fire 'input' during autocorrect/compose.
    lpCityInput.addEventListener('input', debounceCitySearch);
    lpCityInput.addEventListener('keyup', debounceCitySearch);
    lpCityInput.addEventListener('compositionend', debounceCitySearch);

    // On iOS, when the keyboard opens the viewport shrinks.
    // Scroll the input into view so the results below it stay visible.
    lpCityInput.addEventListener('focus', () => {
        setTimeout(() => {
            lpCityInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 300);  // delay lets iOS keyboard animation finish
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
    // Time Controller UI (shared module)
    // =========================================================================

    /**
     * Snap all in-flight animations to their settled values and freeze, across all
     * faces.
     *
     * `bakeNow` (default false): on the **freeze** paths that do *not* re-arm
     * schedules afterward (pause, scrub-end while stopped), pass `true` so on-beat
     * values snap to `A(current display time)` — a clock frozen between beats then
     * reads the exact stopped time. On paths that `resetAllSchedules()` afterward
     * (step, Now, transport-resume), leave it `false`: the subsequent stopped-frame
     * settle animates on-beat values to `A(now)` (so the transition flips smoothly).
     */
    function finishAllAnimations(bakeNow = false) {
        for (const face of faces) {
            face.updater.finish(bakeNow ? face.env : undefined);
            // finish() moves currentValues outside tick() (which reports changes
            // relative to its own start), so the gate can't see them — force a draw.
            face.renderDirty = true;
        }
    }

    /** Unfreeze all schedules on all faces after a pause. */
    function resetAllSchedules() {
        for (const face of faces) {
            face.updater.reset();
            // Conservative: reset paths (scrub start/end, step, resume) change what
            // the next eval sees; draw once even if values land unchanged.
            face.renderDirty = true;
        }
    }

    function ensureSchedulerRunning() {
        // Kick the scheduler if it's idle
        if (rafId === null && idleTimerId === null) {
            startScheduler();
        } else if (rafId === null && timeController.needsContinuousRender) {
            // Idle timer is set but we need continuous render now
            stopScheduler();
            startScheduler();
        }
    }

    /**
     * Persist the current time state (t/off/dir) via the shared layer.
     * Uses 'off' for 1× forward with offset (stays valid as real time advances),
     * and 't'+'dir' for all other modes (stopped, reverse, accelerated).
     */
    function writeTimeState() {
        flushTimeState(timeController);
    }

    const timeUI = initTimeControls({
        timeController,
        getTimezone: () => locationTimezone,
        getTzDeltaMs: () => tzDeltaMs,
        getLat: () => lat,
        getLon: () => lon,
        getSelectedBody: () => {
            // Read from Venezia's currentPlanetNumber env variable
            const bodyLabel = document.getElementById('tp-body-transit-label');
            return bodyLabel ? parseInt(bodyLabel.dataset.planet || '1', 10) : undefined;
        },
        onTimeStep: () => {
            finishAllAnimations();
            resetAllSchedules();
        },
        onScrubStart: () => {
            resetAllSchedules();
        },
        onScrubEnd: () => {
            // The shared UI has already called timeController.stop().
            rebuildEnvironments();
            // Freeze path when stopped: bake A(now) so on-beat hands read the exact
            // scrub-end time rather than a beat position.
            finishAllAnimations(timeController.isStopped);
            // While stopped, finishAllAnimations() has already snapped hands to
            // their final positions and frozen the schedules. Re-arming here
            // (resetAllSchedules) would defeat that freeze and make hands
            // re-evaluate every frame while stopped — see
            // planning/2026-06-03-stopped-clock-rendering.md.
            if (!timeController.isStopped) resetAllSchedules();
        },
        onNowClicked: () => {
            // The shared UI has already called timeController.reset().
            finishAllAnimations();
            resetAllSchedules();
            stopScheduler();
            startScheduler();
        },
        onTransportChange: () => {
            rebuildEnvironments();
            // Pausing (transition INTO stopped) is a freeze path: bake A(now) so
            // on-beat hands read the exact paused time, not a beat position.
            finishAllAnimations(timeController.isStopped);
            // Only re-arm schedules when resuming (play / direction change). When
            // transitioning INTO the stopped state, leave the freeze from
            // finishAllAnimations() in place so we don't re-evaluate while stopped.
            if (!timeController.isStopped) resetAllSchedules();
        },
        ensureSchedulerRunning,
        writeTimeState,
        onPopoverToggle: (open) => {
            if (open) {
                requestAnimationFrame(() => {
                    if (lastContainerW > 0) {
                        onGridResize(lastContainerW, lastContainerH);
                    }
                });
            } else {
                if (lastContainerW > 0) {
                    onGridResize(lastContainerW, lastContainerH);
                }
            }
        },
    });


    // --- Share button ---
    initShareButton({ getState });

    // --- Live cross-tab sync ---
    // When another tab/app changes the shared location or time, apply it here
    // without a reload (discrete updates; the storage event only fires on a
    // real cross-tab write, never for this tab's own writes).
    onSharedChange((s) => {
        let changed = false;
        if (s.lat !== null && s.lon !== null &&
            (s.lat !== lat || s.lon !== lon || (s.tz || undefined) !== (locationTimezone || undefined))) {
            locationSource = s.city || '';
            locationFullLabel = s.city || '';
            locationSourceType = s.city ? 'url-city' : 'manual';
            locationTimezone = resolveTimezone(s.lat, s.lon, s.tz || null);
            tzDeltaMs = computeTzDeltaMs(locationTimezone);
            rebuildAllForLocation(s.lat, s.lon);  // sets lat/lon, rebuilds, updates display, kicks scheduler
            scheduleDstRebuild();
            needsPrompt = false;
            changed = true;
        }
        // Time (setTime/setOffset/reset fire onTick → rebuildEnvironments).
        if (s.off !== null) { timeController.setOffset(s.off); changed = true; }
        else if (s.t !== null) {
            timeController.setTime(new Date(s.t));
            if (s.dir === 1) { timeController.setDirection(1); timeController.setRate(null); }
            else if (s.dir === -1) { timeController.setDirection(-1); timeController.setRate(null); }
            changed = true;
        } else if (!timeController.isRealTime) { timeController.reset(); changed = true; }
        if (changed) { stopScheduler(); startScheduler(); }
    });

    // --- Backstop timezone re-resolution ---
    // If startup fell back to the browser zone because the city DB wasn't loaded
    // (e.g. a shared link carrying lat/lon but no tz), correct it once the DB is
    // available. resolveTimezoneFromDb awaits the load and tolerates a racing
    // releaseCityData() from the location-name path (there is no refcount), then
    // we rebuild the env and persist only the corrected, DB-derived zone.
    if (tzNeedsResolution) {
        resolveTimezoneFromDb(lat, lon).then(resolved => {
            tzNeedsResolution = false;
            if (resolved && resolved !== locationTimezone) {
                locationTimezone = resolved;
                handleDstTransition();   // rebuild envs + refresh tz display + restart scheduler
                scheduleDstRebuild();
                if (isPersistentMode()) setState({ tz: locationTimezone });
            }
            if (!dialogOpen()) releaseCityData();  // drop the ~22 MB unless the dialog needs it
        });
    }

    // --- Info button & popup (shared wiring + face-specific fixups) ---
    initHelpPopover({
        app: 'chronometer',
        onFirstOpen: (helpContent) => {
            // Add thumbnail images to per-face help section summaries
            helpContent.querySelectorAll('.face-help-section[data-face]').forEach(el => {
                const face = (el as HTMLElement).dataset.face!;
                const summary = el.querySelector('summary');
                if (summary) {
                    const img = document.createElement('img');
                    img.src = `thumb-${face}.png`;
                    img.alt = '';
                    img.style.cssText = 'width:28px;height:28px;border-radius:50%;vertical-align:middle;margin:0 8px 0 4px;';
                    summary.prepend(img);
                }
            });
            // Reorder and filter per-face help sections to match display order
            const faceHelpSections = helpContent.querySelectorAll('.face-help-section[data-face]');
            if (faceHelpSections.length > 0) {
                // FaceData.name is a display name (e.g., "Mauna Kea"); data-face is a slug (e.g., "mauna-kea")
                const toSlug = (name: string) => name.toLowerCase().replace(/[āä]/g, 'a').replace(/\s+/g, '-');
                const activeSlugs = faceDataArray.map(f => toSlug(f.name));
                const slugSet = new Set(activeSlugs);
                const bySlug = new Map<string, Element>();
                faceHelpSections.forEach(el => {
                    const slug = (el as HTMLElement).dataset.face!;
                    if (isSelectedPage && !slugSet.has(slug)) {
                        (el as HTMLElement).style.display = 'none';
                    } else {
                        bySlug.set(slug, el);
                    }
                });
                // Re-append in display order (moves existing nodes)
                for (const slug of activeSlugs) {
                    const el = bySlug.get(slug);
                    if (el) helpContent.appendChild(el);
                }
            }
        },
    });

    // --- Cross-app navigation (header icons + i/o/c/a) and page hotkeys ---
    // Skipped in embed mode: the chrome is removed and hotkeys must not
    // navigate the host page's iframe. Key table: help.html#hotkeys.
    if (!isEmbedMode) {
        initAppNavLinks(writeTimeState);
        registerAppNavHotkeys(writeTimeState);
        registerHotkey('h', () => document.getElementById('info-btn')?.click());
        registerHotkey('?', () => openGeneralHelpTopic('#hotkeys'));
        registerHotkey('t', () => document.getElementById('time-bar-label')?.click());
        registerHotkey('n', () => document.getElementById('time-bar-now')?.click());
        registerHotkey('l', () => document.getElementById('set-location-btn')?.click());
    }

    // --- Fullscreen toggle button ---
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    if (fullscreenBtn) {
        const isFullscreenSupported = !!(
            document.fullscreenEnabled ||
            (document as any).webkitFullscreenEnabled ||
            (document as any).mozFullScreenEnabled ||
            (document as any).msFullscreenEnabled
        );
        if (!isFullscreenSupported) {
            fullscreenBtn.style.display = 'none';
        } else {
            fullscreenBtn.addEventListener('click', () => {
                const doc = document as any;
                const docEl = document.documentElement as any;
                const fullscreenElement = doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || doc.msFullscreenElement;

                if (fullscreenElement) {
                    if (doc.exitFullscreen) {
                        doc.exitFullscreen();
                    } else if (doc.webkitExitFullscreen) {
                        doc.webkitExitFullscreen();
                    } else if (doc.mozCancelFullScreen) {
                        doc.mozCancelFullScreen();
                    } else if (doc.msExitFullscreen) {
                        doc.msExitFullscreen();
                    }
                } else {
                    if (docEl.requestFullscreen) {
                        docEl.requestFullscreen();
                    } else if (docEl.webkitRequestFullscreen) {
                        docEl.webkitRequestFullscreen();
                    } else if (docEl.mozRequestFullScreen) {
                        docEl.mozRequestFullScreen();
                    } else if (docEl.msRequestFullscreen) {
                        docEl.msRequestFullscreen();
                    }
                }
            });
        }
    }


    // =========================================================================
    // Time bar clock — update at the top of each second
    // =========================================================================
    function tickTimeBarClock() {
        // Only update here when in real-time mode — when overridden,
        // the frame loop handles all time bar updates with properly
        // paired sim/real timestamps to avoid offset jitter.
        if (timeController.isRealTime) {
            timeUI?.updateTimeUI();
        }
        const msUntilNextSecond = 1000 - (Date.now() % 1000);
        setTimeout(tickTimeBarClock, msUntilNextSecond);
    }
    tickTimeBarClock();

    // Periodic URL time capture — every 60s when running at 1× or -1×
    setInterval(() => {
        if (!timeController.isRealTime && !timeController.isStopped && timeController.currentRate === null) {
            writeTimeState();
        }
    }, 60_000);

    // =========================================================================
    // Planet selector (for faces with planetSelector flag)
    // =========================================================================
    const isSingleFace = faceDataArray.length === 1;
    const planetSelectorFace = faces.find(f => f.watch.planetSelector);

    if (planetSelectorFace && isSingleFace) {
        const selectorEl = document.getElementById('planet-selector');
        const iconsContainer = document.getElementById('planet-icons');
        const nameLabel = document.getElementById('planet-name');
        const prevBtn = document.getElementById('planet-prev');
        const nextBtn = document.getElementById('planet-next');

        if (selectorEl && iconsContainer && nameLabel && prevBtn && nextBtn) {
            selectorEl.style.display = 'flex';

            const planetOrder = [
                { key: 'sun',     name: 'Sun',     param: 'sun' },
                { key: 'moon',    name: 'Moon',    param: 'moon' },
                { key: 'mercury', name: 'Mercury', param: 'mercury' },
                { key: 'venus',   name: 'Venus',   param: 'venus' },
                { key: 'mars',    name: 'Mars',    param: 'mars' },
                { key: 'jupiter', name: 'Jupiter', param: 'jupiter' },
                { key: 'saturn',  name: 'Saturn',  param: 'saturn' },
                { key: 'uranus',  name: 'Uranus',  param: 'uranus' },
                { key: 'neptune', name: 'Neptune', param: 'neptune' },
            ];

            // Determine current selection from persisted state or default
            const currentBody = (getState().body || 'jupiter').toLowerCase();
            let selectedIdx = planetOrder.findIndex(p => p.param === currentBody);
            if (selectedIdx < 0) selectedIdx = 5; // Jupiter

            // Build icon buttons
            const iconBtns: HTMLButtonElement[] = [];
            for (let i = 0; i < planetOrder.length; i++) {
                const p = planetOrder[i];
                const btn = document.createElement('button');
                btn.className = 'planet-icon-btn';
                btn.title = p.name;
                const imgUrl = planetIconDataUrls.get(p.key);
                if (imgUrl) {
                    const img = document.createElement('img');
                    img.src = imgUrl;
                    img.alt = p.name;
                    btn.appendChild(img);
                } else {
                    btn.textContent = p.name.charAt(0);
                }
                if (i === selectedIdx) btn.classList.add('selected');
                btn.addEventListener('click', () => selectPlanet(i));
                iconsContainer.appendChild(btn);
                iconBtns.push(btn);
            }

            nameLabel.textContent = planetOrder[selectedIdx].name;

            // ECPlanetNumber mapping for the planetOrder array
            // Sun=0, Moon=1, Mercury=2, Venus=3, Mars=5, Jupiter=6, Saturn=7, Uranus=8, Neptune=9
            const planetNumberForIdx = [0, 1, 2, 3, 5, 6, 7, 8, 9];

            // --- Body-transit row in astro panel ---
            // On single-face Venezia, replace Moon rows with body-aware rows
            const moonRiseRow = document.getElementById('tp-astro-moonrise');
            const bodyRiseRow = document.getElementById('tp-astro-body-rise');
            const bodyRiseLabel = document.getElementById('tp-body-rise-label');
            const moonSetRow = document.getElementById('tp-astro-moonset');
            const bodySetRow = document.getElementById('tp-astro-body-set');
            const bodySetLabel = document.getElementById('tp-body-set-label');
            const moonTransitRow = document.getElementById('tp-astro-moon-transit');
            const bodyTransitRow = document.getElementById('tp-astro-body-transit');
            const bodyTransitLabel = document.getElementById('tp-body-transit-label');

            // Swap moon rows for body rows
            if (moonRiseRow && bodyRiseRow) { moonRiseRow.style.display = 'none'; bodyRiseRow.style.display = ''; }
            if (moonSetRow && bodySetRow) { moonSetRow.style.display = 'none'; bodySetRow.style.display = ''; }
            if (moonTransitRow && bodyTransitRow) { moonTransitRow.style.display = 'none'; bodyTransitRow.style.display = ''; }

            // Helper to update all body labels
            function updateBodyLabels(name: string, planetNum: number) {
                const numStr = String(planetNum);
                if (bodyRiseLabel) { bodyRiseLabel.textContent = `${name} Rise`; bodyRiseLabel.dataset.planet = numStr; }
                if (bodySetLabel) { bodySetLabel.textContent = `${name} Set`; bodySetLabel.dataset.planet = numStr; }
                if (bodyTransitLabel) { bodyTransitLabel.textContent = `${name} Trans`; bodyTransitLabel.dataset.planet = numStr; }
            }

            // Set initial body labels
            updateBodyLabels(planetOrder[selectedIdx].name, planetNumberForIdx[selectedIdx]);

            function selectPlanet(idx: number) {
                selectedIdx = idx;
                const p = planetOrder[idx];

                // Update UI
                iconBtns.forEach((b, i) => b.classList.toggle('selected', i === idx));
                nameLabel!.textContent = p.name;

                // Update body labels in astro panel
                updateBodyLabels(p.name, planetNumberForIdx[idx]);

                // Persist the body selection (storage in storage mode, URL otherwise).
                setState({ body: p.param });

                // Keep navigation links in sync (carries the param in URL-fallback mode).
                updateNavigationLinks();

                // Rebuild face with new body — preserve hand states for smooth animation
                for (const face of faces) {
                    if (!face.enabled) continue;
                    // Rebuild environment (picks up new body URL param)
                    face.env = createWatchEnvironment(face.watch, lat, lon, makeGetNow(face.watch.beatsPerSecond, face.getNow), locationTimezone, face.terraSlotOverrides, face.globalLocationSlot);
                    restoreKyotoState(face);
                    // Update terminator leaf angles for the new planet's phase
                    // (keep existing leaves so the animation system can interpolate)
                    if (face.terminatorLeaves.length > 0) {
                        updateLeafAngles(face.terminatorLeaves, face.env);
                    }
                    // Rebuild static caches (background, marks, windows)
                    const { canvas, watch, env, images, scale } = face;
                    buildStaticBlockCaches(watch, env, canvas.width, canvas.height, scale, images, face.terminatorLeaves);
                    // Force all hands to re-evaluate immediately (reset update timers)
                    face.updater.reset();
                }
                // Kick the scheduler immediately so animations start without delay
                stopScheduler();
                startScheduler();
            }

            prevBtn.addEventListener('click', () => {
                selectPlanet((selectedIdx - 1 + planetOrder.length) % planetOrder.length);
            });
            nextBtn.addEventListener('click', () => {
                selectPlanet((selectedIdx + 1) % planetOrder.length);
            });
        }
    }

    // =========================================================================
    // Vienna noon-on-top toggle (single-face mode only)
    // =========================================================================
    const viennaFace = faces.find(f => f.watch.urlAbbrev === 'vi');
    if (viennaFace && isSingleFace) {
        const toggleContainer = document.getElementById('vienna-noon-toggle');
        if (toggleContainer) {
            toggleContainer.style.display = 'flex';
            const midnightPill = toggleContainer.querySelector('[data-mode="midnight"]') as HTMLButtonElement;
            const noonPill = toggleContainer.querySelector('[data-mode="noon"]') as HTMLButtonElement;



            function isNoonOnTop(): boolean {
                return (viennaFace!.env.variables.get('noonOnTop') ?? 0) !== 0;
            }

            function updatePillHighlight() {
                const noon = isNoonOnTop();
                midnightPill.classList.toggle('active', !noon);
                noonPill.classList.toggle('active', noon);
            }

            function setNoonOnTop(noonOnTop: boolean) {
                const val = noonOnTop ? 1 : 0;
                const targetFlip = noonOnTop ? Math.PI : 0;

                // 1. Update discrete state immediately
                viennaFace!.env.variables.set('noonOnTop', val);
                viennaFace!.env.variables.set('dialFlip', targetFlip);

                // 2. Rebuild static cache
                const { canvas, watch, env, images, scale } = viennaFace!;
                buildStaticBlockCaches(watch, env, canvas.width, canvas.height, scale, images, viennaFace!.terminatorLeaves);

                // 3. Re-evaluate all ObsValues (hands, dials, and the ring's
                //    masterOffset) against the new dialFlip; they animate to the
                //    flipped position via the Updater.
                viennaFace!.updater.reset();

                // 4. Reset terminator leaves for the new dialFlip
                if (viennaFace!.terminatorLeaves.length > 0) {
                    updateLeafAngles(viennaFace!.terminatorLeaves, viennaFace!.env);
                }


                // 7. Kick the scheduler so animations start immediately
                stopScheduler();
                startScheduler();

                // 8. Persist the noon-on-top choice (storage in storage mode, URL otherwise).
                setState({ vnoon: noonOnTop });
                updateNavigationLinks();

                // 9. Update pill highlight
                updatePillHighlight();
            }

            // Apply initial pill highlight from URL state (env already has the right value from watch-env.ts)
            updatePillHighlight();

            midnightPill.addEventListener('click', () => {
                if (!isNoonOnTop()) return; // already selected
                setNoonOnTop(false);
            });
            noonPill.addEventListener('click', () => {
                if (isNoonOnTop()) return; // already selected
                setNoonOnTop(true);
            });
        }
    }

    // =========================================================================
    // Kyoto toggles (Hand mode and Rate mode)
    // =========================================================================
    const kyotoFace = faces.find(f => f.watch.wadokei);
    if (kyotoFace && isSingleFace) {
        const handToggle = document.getElementById('kyoto-hand-toggle');
        const rateToggle = document.getElementById('kyoto-mode-toggle');
        // Use a getter instead of a captured const so we always access the
        // *current* environment even after createWatchEnvironment() replaces it
        // (e.g. during time-controller stepping or location changes).
        const getEnv = () => kyotoFace.env;

        const updateUI = () => {
            const env = getEnv();
            // Update Hand Mode pills
            if (handToggle) {
                const isFixed = (env.kyHandMode === 1);
                handToggle.querySelectorAll('.kyoto-pill').forEach(p => {
                    const btn = p as HTMLButtonElement;
                    btn.classList.toggle('active', (btn.dataset.mode === 'fixed') === isFixed);
                });

                // Update Rate Mode labels based on Hand Mode
                if (rateToggle) {
                    rateToggle.querySelectorAll('.kyoto-pill').forEach(p => {
                        const btn = p as HTMLButtonElement;
                        if (btn.dataset.mode === 'variable') {
                            btn.textContent = isFixed ? 'Variable dial rate' : 'Variable hand rate';
                        } else {
                            btn.textContent = isFixed ? 'Constant dial rate' : 'Constant hand rate';
                        }
                    });
                }
            }

            // Update Rate Mode pills
            if (rateToggle) {
                const isConstant = (env.variables.get('kyMode') || 0) === 0;
                rateToggle.querySelectorAll('.kyoto-pill').forEach(p => {
                    const btn = p as HTMLButtonElement;
                    btn.classList.toggle('active', (btn.dataset.mode === 'constant') === isConstant);
                });
            }
        };

        const setKyotoState = (handMode: number | null, rateMode: number | null) => {
            const env = getEnv();

            let changed = false;
            if (handMode !== null && env.kyHandMode !== handMode) {
                env.kyHandMode = handMode;
                setState({ kyhand: handMode === 1 ? '1' : null });
                changed = true;
            }
            if (rateMode !== null && (env.variables.get('kyMode') || 0) !== rateMode) {
                env.variables.set('kyMode', rateMode);
                setState({ kmode: rateMode === 1 ? '1' : null });
                changed = true;
            }

            if (changed) {
                // Snap all in-flight animations to their current targets, then
                // re-evaluate against the new mode and animate to the new
                // positions. finish() before reset() prevents interpolating the
                // wrong way when kyotoMasterRotation() jumps (masterOffset,
                // japan-hour spokes and wedges all settle then re-sweep together).
                kyotoFace.updater.finish();
                kyotoFace.updater.reset();

                updateUI();
                // Trigger re-draw
                stopScheduler();
                startScheduler();
            }
        };

        if (handToggle) {
            handToggle.style.display = 'flex';
            handToggle.querySelectorAll('.kyoto-pill').forEach(p => {
                p.addEventListener('click', () => {
                    const btn = p as HTMLButtonElement;
                    setKyotoState(btn.dataset.mode === 'fixed' ? 1 : 0, null);
                });
            });
        }

        if (rateToggle) {
            rateToggle.style.display = 'flex';
            rateToggle.querySelectorAll('.kyoto-pill').forEach(p => {
                p.addEventListener('click', () => {
                    const btn = p as HTMLButtonElement;
                    setKyotoState(null, btn.dataset.mode === 'constant' ? 0 : 1);
                });
            });
        }

        // Initialize from URL
        const kyState = getState();
        if (kyState.kyhand === '1') getEnv().kyHandMode = 1;
        if (kyState.kmode === '1') getEnv().variables.set('kyMode', 1);
        updateUI();
    }

    // =========================================================================
    // Terra city customization (for faces with worldTimeRing flag, single-face mode)
    // =========================================================================
    const terraFace = faces.find(f => f.watch.worldTimeRing);
    if (terraFace && isSingleFace) {
        const tcDialog = document.getElementById('terra-city-dialog');
        const tcCityInput = document.getElementById('tc-city-input') as HTMLInputElement | null;
        const tcCityResults = document.getElementById('tc-city-results');
        const tcSlotPicker = document.getElementById('tc-slot-picker');
        const tcSlotChoices = document.getElementById('tc-slot-choices');
        const tcMessage = document.getElementById('tc-message');
        const tcNoSelection = document.getElementById('tc-no-selection');
        const tcSelectedCity = document.getElementById('tc-selected-city');
        const tcCityName = document.getElementById('tc-city-name');
        const tcCityTz = document.getElementById('tc-city-tz');
        const tcResetBtn = document.getElementById('tc-reset');
        const tcCancelBtn = document.getElementById('tc-cancel');
        const tcDoneBtn = document.getElementById('tc-done');

        if (tcDialog && tcCityInput && tcCityResults && tcSlotPicker &&
            tcSlotChoices && tcMessage && tcDoneBtn && tcResetBtn) {

            // Add "Change cities" button below the watch grid
            const changeCitiesBtn = document.createElement('button');
            changeCitiesBtn.className = 'change-cities-btn';
            changeCitiesBtn.textContent = 'Change cities';
            changeCitiesBtn.id = 'change-cities-btn';
            const timeBarEl = document.getElementById('time-bar');
            if (timeBarEl) {
                timeBarEl.parentElement!.insertBefore(changeCitiesBtn, timeBarEl);
            }

            /** Get current effective slot data (defaults + overrides) */
            function getCurrentSlots(): Record<number, TerraSlot> {
                const slots: Record<number, TerraSlot> = {};
                for (const [k, v] of Object.entries(TERRA_RING_DEFAULTS)) {
                    slots[Number(k)] = { ...v };
                }
                if (terraFace!.terraSlotOverrides) {
                    for (const [k, v] of Object.entries(terraFace!.terraSlotOverrides)) {
                        slots[Number(k)] = { ...v };
                    }
                }
                return slots;
            }

            /** Persist Terra ring slot overrides via app-state. */
            function writeTerraOverridesToUrl() {
                const changes: Record<string, string | null> = {};
                // Clear all ring slot keys, then set the current overrides.
                for (let slot = 1; slot <= 24; slot++) {
                    changes[`r${slot}`] = null;
                    changes[`r${slot}tz`] = null;
                    changes[`r${slot}lat`] = null;
                    changes[`r${slot}lon`] = null;
                }
                if (terraFace!.terraSlotOverrides) {
                    for (const [slotStr, data] of Object.entries(terraFace!.terraSlotOverrides)) {
                        changes[`r${slotStr}`] = data.cityName;
                        changes[`r${slotStr}tz`] = data.olsonId;
                        changes[`r${slotStr}lat`] = data.lat.toFixed(3);
                        changes[`r${slotStr}lon`] = data.lon.toFixed(3);
                    }
                }
                setSlotOverrides(changes);
                updateNavigationLinks();
            }

            /** Rebuild the Terra face after a slot change */
            function rebuildTerraForSlotChange() {
                // Re-run buildSlotOverrides to re-inject the global location
                // override on top of whatever the user just changed.
                const slotResult = buildSlotOverrides(terraFace!.watch);
                if (slotResult) {
                    terraFace!.terraSlotOverrides = slotResult.overrides;
                    terraFace!.globalLocationSlot = slotResult.globalLocationSlot;
                }
                for (const face of faces) {
                    if (!face.enabled) continue;
                    face.env = createWatchEnvironment(face.watch, lat, lon, makeGetNow(face.watch.beatsPerSecond, face.getNow), locationTimezone, face.terraSlotOverrides, face.globalLocationSlot);
                    restoreKyotoState(face);
                    if (face.terminatorLeaves.length > 0) {
                        updateLeafAngles(face.terminatorLeaves, face.env);
                    }
                    (face.env as any)._terraCityKnockout = null;
                    const { canvas, watch, env, images, scale } = face;
                    buildStaticBlockCaches(watch, env, canvas.width, canvas.height, scale, images, face.terminatorLeaves);
                    face.updater.reset();
                }
                stopScheduler();
                startScheduler();
            }

            /** Assign a city to a slot */
            function assignCityToSlot(slot: number, city: CityResult) {
                const currentSlots = getCurrentSlots();
                const previousCity = currentSlots[slot]?.cityName || 'Unknown';
                // Check if this is the global-location slot BEFORE rebuild changes it
                const isGlobalSlot = slot === terraFace!.globalLocationSlot;
                if (!terraFace!.terraSlotOverrides) {
                    terraFace!.terraSlotOverrides = {};
                }
                terraFace!.terraSlotOverrides[slot] = {
                    cityName: city.shortLabel,
                    olsonId: city.timezone,
                    lat: city.lat,
                    lon: city.lon,
                };
                writeTerraOverridesToUrl();
                rebuildTerraForSlotChange();
                if (isGlobalSlot) {
                    showTcMessage(`${city.shortLabel} saved for ${formatSlotOffset(slot)}, but your location may override this slot`, 'warn');
                } else {
                    showTcMessage(`${city.shortLabel} replaces ${previousCity} (${formatSlotOffset(slot)})`, 'info');
                }
            }

            function showTcMessage(text: string, type: 'info' | 'warn' | 'error') {
                tcMessage!.textContent = text;
                tcMessage!.className = `tc-message tc-message-${type}`;
                tcMessage!.style.display = '';
            }

            function hideTcMessage() {
                tcMessage!.style.display = 'none';
            }

            function showCityStatus(city: CityResult) {
                if (tcNoSelection) tcNoSelection.style.display = 'none';
                if (tcSelectedCity) tcSelectedCity.style.display = '';
                if (tcCityName) tcCityName.textContent = city.shortLabel;
                if (tcCityTz) tcCityTz.textContent = city.timezone;
            }

            function resetCityStatus() {
                if (tcNoSelection) tcNoSelection.style.display = '';
                if (tcSelectedCity) tcSelectedCity.style.display = 'none';
            }

            function showTerraDialog() {
                tcDialog!.style.display = '';
                grid.classList.add('blurred');
                tcCityInput!.value = '';
                tcCityResults!.innerHTML = '';
                tcSlotPicker!.style.display = 'none';
                hideTcMessage();
                resetCityStatus();
                setTimeout(() => tcCityInput?.focus(), 50);
            }

            function hideTerraDialog() {
                tcDialog!.style.display = 'none';
                grid.classList.remove('blurred');
            }

            changeCitiesBtn.addEventListener('click', showTerraDialog);
            tcDoneBtn.addEventListener('click', hideTerraDialog);
            if (tcCancelBtn) tcCancelBtn.addEventListener('click', hideTerraDialog);
            tcDialog!.querySelector('.tc-backdrop')?.addEventListener('click', hideTerraDialog);

            tcResetBtn.addEventListener('click', () => {
                const overlay = document.getElementById('tc-confirm-overlay');
                if (overlay) overlay.style.display = '';
            });

            const confirmYes = document.getElementById('tc-confirm-yes');
            const confirmNo = document.getElementById('tc-confirm-no');
            const confirmOverlay = document.getElementById('tc-confirm-overlay');

            if (confirmYes && confirmNo && confirmOverlay) {
                confirmNo.addEventListener('click', () => {
                    confirmOverlay.style.display = 'none';
                });
                confirmYes.addEventListener('click', () => {
                    confirmOverlay.style.display = 'none';
                    terraFace!.terraSlotOverrides = undefined;
                    writeTerraOverridesToUrl();
                    rebuildTerraForSlotChange();
                    showTcMessage('All cities reset to defaults', 'info');
                    resetCityStatus();
                    tcSlotPicker!.style.display = 'none';
                });
            }

            // --- City search ---
            let tcSearchDebounce: ReturnType<typeof setTimeout> | null = null;

            function renderTcSearchResults(results: CityResult[]) {
                tcCityResults!.innerHTML = '';
                if (results.length === 0) {
                    tcCityResults!.innerHTML = '<div class="tc-city-loading">No results found</div>';
                    return;
                }
                const max = Math.min(results.length, 50);
                for (let i = 0; i < max; i++) {
                    const r = results[i];
                    const div = document.createElement('div');
                    div.className = 'tc-city-item';
                    if (r.isAirport) {
                        div.innerHTML = `<span class="iata-tag">${r.label.split(' ')[0]}</span>${r.label.split(' ').slice(1).join(' ')}`;
                    } else {
                        div.textContent = r.label;
                    }
                    div.addEventListener('click', () => {
                        tcCityInput!.value = '';
                        tcCityResults!.innerHTML = '';
                        onCitySelected(r);
                    });
                    tcCityResults!.appendChild(div);
                }
            }

            async function onTcCityInput() {
                const query = tcCityInput!.value.trim();
                if (query.length === 0) {
                    tcCityResults!.innerHTML = '';
                    return;
                }
                try {
                    if (!isCityDataLoaded()) {
                        if (loadError) {
                            tcCityResults!.innerHTML = `<div class="tc-city-loading">City search unavailable: ${loadError}</div>`;
                            return;
                        }
                        tcCityResults!.innerHTML = '<div class="tc-city-loading">Loading city database…</div>';
                        try {
                            await loadCityData();
                        } catch (err) {
                            tcCityResults!.innerHTML = `<div class="tc-city-loading">Failed to load: ${(err as Error).message}</div>`;
                            return;
                        }
                        const currentQuery = tcCityInput!.value.trim();
                        if (currentQuery.length === 0) {
                            tcCityResults!.innerHTML = '';
                            return;
                        }
                    }
                    const results = searchCities(query, 20);
                    renderTcSearchResults(results);
                } catch (err) {
                    tcCityResults!.innerHTML = `<div class="tc-city-loading">Error: ${(err as Error).message}</div>`;
                }
            }

            function debounceTcSearch() {
                if (tcSearchDebounce) clearTimeout(tcSearchDebounce);
                tcSearchDebounce = setTimeout(onTcCityInput, 150);
            }

            tcCityInput.addEventListener('input', debounceTcSearch);
            tcCityInput.addEventListener('keyup', debounceTcSearch);
            tcCityInput.addEventListener('compositionend', debounceTcSearch);

            tcCityInput.addEventListener('keydown', (e: KeyboardEvent) => {
                const items = tcCityResults!.querySelectorAll('.tc-city-item');
                if (items.length === 0) return;
                const current = tcCityResults!.querySelector('.tc-city-item.selected');
                const idx = current ? Array.from(items).indexOf(current) : -1;
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    const next = idx < items.length - 1 ? idx + 1 : 0;
                    current?.classList.remove('selected');
                    items[next].classList.add('selected');
                    items[next].scrollIntoView({ block: 'nearest' });
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    const prev = idx > 0 ? idx - 1 : items.length - 1;
                    current?.classList.remove('selected');
                    items[prev].classList.add('selected');
                    items[prev].scrollIntoView({ block: 'nearest' });
                } else if (e.key === 'Enter' && current) {
                    (current as HTMLElement).click();
                }
            });

            /** Handle a city selection from search results */
            function onCitySelected(city: CityResult) {
                showCityStatus(city);
                hideTcMessage();
                tcSlotPicker!.style.display = 'none';

                const validSlots = validSlotsForTz(city.timezone);

                if (validSlots.length === 0) {
                    showTcMessage(`${city.shortLabel}'s timezone (${city.timezone}) cannot fit on any ring slot.`, 'error');
                    return;
                }

                if (validSlots.length === 1) {
                    // If the only valid slot is the global-location slot, warn
                    if (validSlots[0] === terraFace!.globalLocationSlot) {
                        showTcMessage(`Note: this slot currently shows your location`, 'warn');
                    }
                    assignCityToSlot(validSlots[0], city);
                } else {
                    // Multiple valid slots — show slot picker
                    tcSlotPicker!.style.display = '';
                    tcSlotChoices!.innerHTML = '';
                    const currentSlots = getCurrentSlots();
                    for (const slot of validSlots) {
                        const currentCity = currentSlots[slot]?.cityName || 'Unknown';
                        const isGlobalSlot = slot === terraFace!.globalLocationSlot;
                        const btn = document.createElement('button');
                        btn.className = 'tc-slot-btn';
                        const label = isGlobalSlot ? `${currentCity} ★` : currentCity;
                        btn.innerHTML = `<span class="tc-slot-city">${label}</span><span class="tc-slot-offset">${formatSlotOffset(slot)}${isGlobalSlot ? ' (your location)' : ''}</span>`;
                        btn.addEventListener('click', () => {
                            tcSlotPicker!.style.display = 'none';
                            assignCityToSlot(slot, city);
                        });
                        tcSlotChoices!.appendChild(btn);
                    }
                }
            }
        }
    }

    // =========================================================================
    // Gaia subdial city customization (for faces with worldTimeSubdials, single-face)
    // =========================================================================
    const gaiaFace = faces.find(f => f.watch.worldTimeSubdials);
    if (gaiaFace && isSingleFace && !terraFace) {
        // Reuse the same terra-city-dialog HTML elements
        const tcDialog = document.getElementById('terra-city-dialog');
        const tcCityInput = document.getElementById('tc-city-input') as HTMLInputElement | null;
        const tcCityResults = document.getElementById('tc-city-results');
        const tcSlotPicker = document.getElementById('tc-slot-picker');
        const tcSlotChoices = document.getElementById('tc-slot-choices');
        const tcMessage = document.getElementById('tc-message');
        const tcNoSelection = document.getElementById('tc-no-selection');
        const tcSelectedCity = document.getElementById('tc-selected-city');
        const tcCityName = document.getElementById('tc-city-name');
        const tcCityTz = document.getElementById('tc-city-tz');
        const tcResetBtn = document.getElementById('tc-reset');
        const tcCancelBtn = document.getElementById('tc-cancel');
        const tcDoneBtn = document.getElementById('tc-done');
        const tcTitle = tcDialog?.querySelector('.tc-title');

        if (tcDialog && tcCityInput && tcCityResults && tcSlotPicker &&
            tcSlotChoices && tcMessage && tcDoneBtn && tcResetBtn) {

            // Customize the title for Gaia
            if (tcTitle) tcTitle.textContent = 'Change subdial cities';

            // Subdial slot labels
            const subdialLabels: Record<number, string> = { 2: 'Upper', 3: 'Right', 4: 'Lower' };

            // Add "Change cities" button
            const changeCitiesBtn = document.createElement('button');
            changeCitiesBtn.className = 'change-cities-btn';
            changeCitiesBtn.textContent = 'Change cities';
            changeCitiesBtn.id = 'change-cities-btn';
            const timeBarEl = document.getElementById('time-bar');
            if (timeBarEl) {
                timeBarEl.parentElement!.insertBefore(changeCitiesBtn, timeBarEl);
            }

            /** Persist Gaia subdial overrides via app-state. */
            function writeGaiaOverridesToUrl() {
                const nSubdials = gaiaFace!.watch.maxSeparateLoc || 4;
                const changes: Record<string, string | null> = {};
                for (let slot = 2; slot <= nSubdials; slot++) {
                    changes[`d${slot}`] = null;
                    changes[`d${slot}tz`] = null;
                    changes[`d${slot}lat`] = null;
                    changes[`d${slot}lon`] = null;
                }
                if (gaiaFace!.terraSlotOverrides) {
                    for (const [slotStr, data] of Object.entries(gaiaFace!.terraSlotOverrides)) {
                        const s = Number(slotStr);
                        if (s < 2) continue; // don't write observer slot
                        changes[`d${slotStr}`] = data.cityName;
                        changes[`d${slotStr}tz`] = data.olsonId;
                        changes[`d${slotStr}lat`] = data.lat.toFixed(3);
                        changes[`d${slotStr}lon`] = data.lon.toFixed(3);
                    }
                }
                setSlotOverrides(changes);
                updateNavigationLinks();
            }

            /** Rebuild Gaia after a slot change */
            function rebuildGaiaForSlotChange() {
                for (const face of faces) {
                    if (!face.enabled) continue;
                    face.env = createWatchEnvironment(face.watch, lat, lon, makeGetNow(face.watch.beatsPerSecond, face.getNow), locationTimezone, face.terraSlotOverrides, face.globalLocationSlot);
                    restoreKyotoState(face);
                    if (face.terminatorLeaves.length > 0) {
                        updateLeafAngles(face.terminatorLeaves, face.env);
                    }
                    const { canvas, watch, env, images, scale } = face;
                    buildStaticBlockCaches(watch, env, canvas.width, canvas.height, scale, images, face.terminatorLeaves);
                    face.updater.reset();
                }
                stopScheduler();
                startScheduler();
            }

            function assignCityToGaiaSlot(slot: number, city: CityResult) {
                const previousCity = gaiaFace!.terraSlotOverrides?.[slot]?.cityName || GAIA_SUBDIAL_DEFAULTS[slot]?.cityName || 'Unknown';
                if (!gaiaFace!.terraSlotOverrides) {
                    gaiaFace!.terraSlotOverrides = {};
                }
                gaiaFace!.terraSlotOverrides[slot] = {
                    cityName: city.shortLabel,
                    olsonId: city.timezone,
                    lat: city.lat,
                    lon: city.lon,
                };
                writeGaiaOverridesToUrl();
                rebuildGaiaForSlotChange();
                showGaiaMessage(`${city.shortLabel} replaces ${previousCity} (${subdialLabels[slot]} subdial)`, 'info');
            }

            function showGaiaMessage(text: string, type: 'info' | 'warn' | 'error') {
                tcMessage!.textContent = text;
                tcMessage!.className = `tc-message tc-message-${type}`;
                tcMessage!.style.display = '';
            }

            function hideGaiaMessage() {
                tcMessage!.style.display = 'none';
            }

            function showGaiaCityStatus(city: CityResult) {
                if (tcNoSelection) tcNoSelection.style.display = 'none';
                if (tcSelectedCity) tcSelectedCity.style.display = '';
                if (tcCityName) tcCityName.textContent = city.shortLabel;
                if (tcCityTz) tcCityTz.textContent = city.timezone;
            }

            function resetGaiaCityStatus() {
                if (tcNoSelection) tcNoSelection.style.display = '';
                if (tcSelectedCity) tcSelectedCity.style.display = 'none';
            }

            function showGaiaDialog() {
                tcDialog!.style.display = '';
                grid.classList.add('blurred');
                tcCityInput!.value = '';
                tcCityResults!.innerHTML = '';
                tcSlotPicker!.style.display = 'none';
                hideGaiaMessage();
                resetGaiaCityStatus();
                setTimeout(() => tcCityInput?.focus(), 50);
            }

            function hideGaiaDialog() {
                tcDialog!.style.display = 'none';
                grid.classList.remove('blurred');
            }

            changeCitiesBtn.addEventListener('click', showGaiaDialog);
            tcDoneBtn.addEventListener('click', hideGaiaDialog);
            if (tcCancelBtn) tcCancelBtn.addEventListener('click', hideGaiaDialog);
            tcDialog!.querySelector('.tc-backdrop')?.addEventListener('click', hideGaiaDialog);

            tcResetBtn.addEventListener('click', () => {
                const overlay = document.getElementById('tc-confirm-overlay');
                if (overlay) overlay.style.display = '';
            });

            const confirmYes = document.getElementById('tc-confirm-yes');
            const confirmNo = document.getElementById('tc-confirm-no');
            const confirmOverlay = document.getElementById('tc-confirm-overlay');

            if (confirmYes && confirmNo && confirmOverlay) {
                confirmNo.addEventListener('click', () => {
                    confirmOverlay.style.display = 'none';
                });
                confirmYes.addEventListener('click', () => {
                    confirmOverlay.style.display = 'none';
                    // Reset slots 2-4 to defaults, keep slot 1 (observer)
                    if (gaiaFace.terraSlotOverrides) {
                        const slot1 = gaiaFace.terraSlotOverrides[1];
                        gaiaFace.terraSlotOverrides = slot1 ? { 1: slot1 } : {};
                        for (const [k, v] of Object.entries(GAIA_SUBDIAL_DEFAULTS)) {
                            gaiaFace.terraSlotOverrides[Number(k)] = { ...v };
                        }
                    }
                    writeGaiaOverridesToUrl();
                    rebuildGaiaForSlotChange();
                    showGaiaMessage('All subdials reset to defaults', 'info');
                    resetGaiaCityStatus();
                    tcSlotPicker!.style.display = 'none';
                });
            }

            // --- City search ---
            let gaiaSearchDebounce: ReturnType<typeof setTimeout> | null = null;

            function renderGaiaSearchResults(results: CityResult[]) {
                tcCityResults!.innerHTML = '';
                if (results.length === 0) {
                    tcCityResults!.innerHTML = '<div class="tc-city-loading">No results found</div>';
                    return;
                }
                const max = Math.min(results.length, 50);
                for (let i = 0; i < max; i++) {
                    const r = results[i];
                    const div = document.createElement('div');
                    div.className = 'tc-city-item';
                    if (r.isAirport) {
                        div.innerHTML = `<span class="iata-tag">${r.label.split(' ')[0]}</span>${r.label.split(' ').slice(1).join(' ')}`;
                    } else {
                        div.textContent = r.label;
                    }
                    div.addEventListener('click', () => {
                        tcCityInput!.value = '';
                        tcCityResults!.innerHTML = '';
                        onGaiaCitySelected(r);
                    });
                    tcCityResults!.appendChild(div);
                }
            }

            async function onGaiaCityInput() {
                const query = tcCityInput!.value.trim();
                if (query.length === 0) {
                    tcCityResults!.innerHTML = '';
                    return;
                }
                try {
                    if (!isCityDataLoaded()) {
                        if (loadError) {
                            tcCityResults!.innerHTML = `<div class="tc-city-loading">City search unavailable: ${loadError}</div>`;
                            return;
                        }
                        tcCityResults!.innerHTML = '<div class="tc-city-loading">Loading city database…</div>';
                        try {
                            await loadCityData();
                        } catch (err) {
                            tcCityResults!.innerHTML = `<div class="tc-city-loading">Failed to load: ${(err as Error).message}</div>`;
                            return;
                        }
                        const currentQuery = tcCityInput!.value.trim();
                        if (currentQuery.length === 0) {
                            tcCityResults!.innerHTML = '';
                            return;
                        }
                    }
                    const results = searchCities(query, 20);
                    renderGaiaSearchResults(results);
                } catch (err) {
                    tcCityResults!.innerHTML = `<div class="tc-city-loading">Error: ${(err as Error).message}</div>`;
                }
            }

            function debounceGaiaSearch() {
                if (gaiaSearchDebounce) clearTimeout(gaiaSearchDebounce);
                gaiaSearchDebounce = setTimeout(onGaiaCityInput, 150);
            }

            tcCityInput.addEventListener('input', debounceGaiaSearch);
            tcCityInput.addEventListener('keyup', debounceGaiaSearch);
            tcCityInput.addEventListener('compositionend', debounceGaiaSearch);

            tcCityInput.addEventListener('keydown', (e: KeyboardEvent) => {
                const items = tcCityResults!.querySelectorAll('.tc-city-item');
                if (items.length === 0) return;
                const current = tcCityResults!.querySelector('.tc-city-item.selected');
                const idx = current ? Array.from(items).indexOf(current) : -1;
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    const next = idx < items.length - 1 ? idx + 1 : 0;
                    current?.classList.remove('selected');
                    items[next].classList.add('selected');
                    items[next].scrollIntoView({ block: 'nearest' });
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    const prev = idx > 0 ? idx - 1 : items.length - 1;
                    current?.classList.remove('selected');
                    items[prev].classList.add('selected');
                    items[prev].scrollIntoView({ block: 'nearest' });
                } else if (e.key === 'Enter' && current) {
                    (current as HTMLElement).click();
                }
            });

            /** Handle a city selection — always show subdial picker */
            function onGaiaCitySelected(city: CityResult) {
                showGaiaCityStatus(city);
                hideGaiaMessage();

                // Show subdial picker (slots 2-4)
                tcSlotPicker!.style.display = '';
                tcSlotChoices!.innerHTML = '';
                const slotLabel = tcSlotPicker!.querySelector('.tc-slot-label');
                if (slotLabel) slotLabel.textContent = 'Which subdial should this city replace?';

                const nSubdials = gaiaFace!.watch.maxSeparateLoc || 4;
                for (let slot = 2; slot <= nSubdials; slot++) {
                    const currentCity = gaiaFace!.terraSlotOverrides?.[slot]?.cityName
                        || GAIA_SUBDIAL_DEFAULTS[slot]?.cityName || 'Unknown';
                    const btn = document.createElement('button');
                    btn.className = 'tc-slot-btn';
                    btn.innerHTML = `<span class="tc-slot-city">${currentCity}</span><span class="tc-slot-offset">${subdialLabels[slot] || `Subdial ${slot}`}</span>`;
                    btn.addEventListener('click', () => {
                        tcSlotPicker!.style.display = 'none';
                        assignCityToGaiaSlot(slot, city);
                    });
                    tcSlotChoices!.appendChild(btn);
                }
            }
        }
    }

    // =========================================================================
    // Initial build
    // =========================================================================
    const initialRect = grid.getBoundingClientRect();
    if (initialRect.width > 0 && initialRect.height > 0) {
        onGridResize(initialRect.width, initialRect.height);
    }

    // In embed mode, remove all chrome DOM elements
    if (isEmbedMode) {
        const removeIds = [
            'location-panel', 'time-bar', 'back-link', 'all-faces-link',
            'selected-faces-link', 'info-btn', 'share-btn', 'fullscreen-btn', 'face-name', 'time-popover',
            'location-prompt', 'planet-selector', 'vienna-noon-toggle',
            'kyoto-hand-toggle', 'kyoto-mode-toggle',
            'change-cities-btn', 'edit-picks-link', 'info-overlay',
            'observatory-link', 'inspector-link',
        ];
        for (const id of removeIds) {
            document.getElementById(id)?.remove();
        }
    }

    // Apply initial time bar styling (red text if URL set a non-real-time state)
    if (!isEmbedMode) {
        timeUI?.updateTimeUI();
    }

    // Show time controller if URL says so
    if (!isEmbedMode && urlState.tc) {
        timeUI?.showPopover();
    }

    // Show location prompt if no location was available
    if (!isEmbedMode && needsPrompt) {
        showLocationPrompt(true);  // with blur
    }

    // Seeded bloc: the display already shows the stored last-known location.
    // Refresh geolocation quietly in the background and update only if we've
    // moved beyond the reuse threshold; a failed/denied refresh keeps the seed.
    if (needsBlocRefresh) {
        // Tint the location name yellow while the background fix is in flight; a
        // failed/denied refresh keeps the (valid) seed — genuine "no location" /
        // "DB unavailable" errors surface elsewhere.
        if (sourceLabel) sourceLabel.style.color = '#e6b800';
        requestBrowserLocation(10000).then(result => {
            if (result.status !== 'success') { notifyBlocRefreshFailed(); return; }
            if (haversineKm(lat, lon, result.lat, result.lon) <= 16) return;  // stationary
            applyLocation(result.lat, result.lon, '', '', 'browser', false, null);
            // Moved: reseed and clear the stale city so updateLocationDisplay
            // reverse-geocodes the new spot.
            if (isPersistentMode()) setState({ bloc: true, lat: result.lat, lon: result.lon, city: null, tz: locationTimezone || null });
            updateLocationDisplay();
        }).catch(() => notifyBlocRefreshFailed()).finally(() => {
            if (sourceLabel) sourceLabel.style.color = '';
        });
    }
}

// Expose the engine on the global window object
window.Chronometer = {
    start: main,
};

// Auto-start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => main().catch(console.error));
} else {
    main().catch(console.error);
}
