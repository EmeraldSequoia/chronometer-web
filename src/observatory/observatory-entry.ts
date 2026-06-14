/**
 * Observatory — astronomical clock web app.
 *
 * Entry point for the Observatory app. Imports ONLY from:
 *   - src/shared/   (astro-env, url-state, tz-resolve, city-search, location-dialog, time-controller)
 *   - src/expr/     (parser, evaluator)
 *   - src/astronomy/ (rise/set, time, astro-constants)
 *   - src/observatory/ (layout, draw-utils, and future view modules)
 *
 * Does NOT import from src/watch/ — keeps the bundle clean of
 * Chronometer-specific code (renderer, XML parser, Terra slots, etc.)
 */

import { createAstroEnvironment, computeTzDeltaMs } from '../shared/astro-env.js';
import type { Environment } from '../expr/evaluator.js';
import { getState, setState, initAppState, onSharedChange } from '../shared/app-state.js';
import { resolveTimezone } from '../shared/tz-resolve.js';
import { findClosestCity } from '../shared/city-search.js';
import { initLocationDialog, requestBrowserLocation } from '../shared/location-dialog.js';
import { TimeController } from '../shared/time-controller.js';
import { initTimeControls } from '../shared/time-controls-ui.js';
import { initHelpPopover } from '../shared/help-popover.js';
import { initShareButton } from '../shared/share-button.js';
import type { TimeControlsAPI } from '../shared/time-controls-ui.js';
import { computeLayout, type ChromeParams, type LayoutParams } from './layout.js';
import { getBackgroundCache, invalidateBackgroundCache, waitForBackgroundImage } from './background.js';
import { getMainDialCache, invalidateMainDialCache, waitForImages } from './main-dial.js';
import { drawPlanetHands, waitForPlanetImages } from './planet-hands.js';
import { drawRiseSetRings, invalidateRingCache } from './ring-view.js';
import { drawClockHands, drawSubdialHands } from './hand-views.js';
import { initEarthView, drawEarthView } from './earth-view.js';
import { initMoonView, drawMoonView } from './moon-view.js';
import { getPeripheralDialsCache, invalidatePeripheralDialsCache } from './peripheral-dials.js';
import { drawPeripheralHands, cycleSelectablePlanet } from './peripheral-hands.js';
import { drawDateView } from './date-view.js';
import { initEclipseView, drawEclipseView } from './eclipse-view.js';

import { type ObsValueName, buildObsValues } from './obs-values.js';
import { Updater, makeOverridableGetNow, timingContextForFrame } from '../shared/updater.js';
import { createFpsIndicator, type FpsIndicator } from '../shared/fps-indicator.js';

// ============================================================================
// State
// ============================================================================

/**
 * Noon-on-top toggle: when true, 12 is at top; when false, 24 is at top.
 * Initialized from the URL `onoon` param once urlState is read (below);
 * toggled at runtime by the footer pill control (setupNoonToggle).
 */
let noonOnTop = false;

/** RAF id for the render loop; null means the loop is idle (stopped + settled). */
let rafId: number | null = null;

/**
 * True while tick() is executing. scheduleFrame() must not queue a frame during
 * a tick — tick()'s own re-arm handles continuation. Without this guard, a
 * scheduleFrame() called synchronously from within a tick (e.g. timeController
 * `onTick` → rebuildEnv() during scrubbing) queues a duplicate rAF every frame,
 * compounding into hundreds of redundant ticks per frame.
 */
let inTick = false;
/** Set when scheduleFrame() is called during a tick, so the tick re-arms even if it would otherwise idle. */
let frameRequestedDuringTick = false;

/** Page-level FPS indicator overlay (created when the ?fps URL param is set). */
let fpsIndicator: FpsIndicator | null = null;

/** Current layout parameters (recomputed on resize) */
let layout: LayoutParams;

/** The canvas element */
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;

/** Time controller (shared with Chronometer for scrubbing/stepping) */
const timeController = new TimeController();

// --- Location state ---
initAppState({ app: 'observatory' });
const urlState = getState();
const hasUrlLocation = urlState.lat !== null && urlState.lon !== null;
let lat = urlState.lat ?? 0;
let lon = urlState.lon ?? 0;
let locationTimezone: string | undefined = urlState.tz || undefined;
let needsPrompt = !hasUrlLocation && !urlState.bloc;

// Restore time state from URL (so deep-links carry the time too — matching
// Chronometer and the Inspector's "open in <app>" links).
if (urlState.off !== null && !isNaN(urlState.off)) {
    timeController.setOffset(urlState.off);
} else if (urlState.t !== null && !isNaN(urlState.t)) {
    timeController.setTime(new Date(urlState.t));
    if (urlState.dir === 1) { timeController.setDirection(1); timeController.setRate(null); }
    else if (urlState.dir === -1) { timeController.setDirection(-1); timeController.setRate(null); }
    // dir === 0 stays stopped (setTime already stops)
}

// Restore the noon-on-top choice from the URL (?onoon=1).
noonOnTop = urlState.onoon;

// If no timezone in URL, resolve it from lat/lon (only if we have a location)
if (!locationTimezone && hasUrlLocation) {
    locationTimezone = resolveTimezone(lat, lon, null);
}

let tzDeltaMs = computeTzDeltaMs(locationTimezone);

// --- Astronomy environment ---
// makeOverridableGetNow lets the Updater's eval-ahead pass temporarily evaluate
// expressions at a *future* display time (via withDisplayTime) without disturbing
// the live time source. env captures this getNow, so every astro function reads
// through the same override seam.
const { getNow, withDisplayTime } = makeOverridableGetNow(() => timeController.getDisplayTime());
let env: Environment = createAstroEnvironment(lat, lon, getNow, locationTimezone);


let updater: Updater<ObsValueName> | null = null;

/** Time controller UI handle (null until DOM is ready) */
let timeUI: TimeControlsAPI | null = null;

/**
 * Body shown on the altitude/azimuth dials (ECPlanetNumber). Click either dial
 * to cycle; persisted in the URL `op` param. Invalid/absent → Sun (0).
 */
const SELECTABLE_PLANETS = new Set([0, 1, 2, 3, 5, 6, 7]);
let selectedPlanet: number =
    urlState.op !== null && SELECTABLE_PLANETS.has(urlState.op) ? urlState.op : 0;

// ============================================================================
// Canvas setup
// ============================================================================

function initCanvas(): void {
    canvas = document.getElementById('observatory-canvas') as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not get 2D context');
    ctx = context;

    // Click either the altitude or azimuth dial to cycle the displayed body.
    canvas.addEventListener('click', onCanvasClick);

    // Initial size
    resizeCanvas();
}

/** Cycle the alt/az body when the user clicks within either dial. */
function onCanvasClick(ev: MouseEvent): void {
    if (!layout) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const L = layout;
    const hit = (cx: number, cy: number, r: number) => Math.hypot(x - cx, y - cy) <= r;
    // iOS: the altitude dial cycles forward, the azimuth dial backward, so you
    // can "go back" by clicking the other dial (EOClock.mm:739-762).
    const onAlt = hit(L.altCX, L.altCY, L.altR);
    const onAz = hit(L.azCX, L.azCY, L.azR);
    if (onAlt || onAz) {
        selectedPlanet = cycleSelectablePlanet(selectedPlanet, onAlt ? 1 : -1);
        // Move the dial target, then reset so dialAlt/dialAz re-evaluate and
        // animate to the new body (same sweep as a location change).
        env.variables.set('dialPlanet', selectedPlanet);
        setState({ op: selectedPlanet });
        updater?.reset();
        scheduleFrame();
    }
}

/**
 * Height of the bottom chrome row (time-controller button + location).
 * Mirrored into the CSS variable --obs-footer-h at startup so the DOM row and
 * the canvas layout reserve the same band.
 */
const FOOTER_H = 32;

/**
 * True when the noon-on-top toggle doesn't fit in the footer row and has
 * wrapped onto a second row above it (CSS class `wrapped`). The canvas layout
 * then reserves a two-row bottom band so the dial isn't occluded.
 */
let noonToggleWrapped = false;

/** Minimum horizontal clearance between the noon toggle and its row neighbors. */
const NOON_TOGGLE_GAP = 16;

/**
 * Decide whether the centered noon toggle fits in the footer row between the
 * time-bar contents (left) and the location controls (right); wrap it onto a
 * second row above the footer when it doesn't. Returns true when the wrap
 * state changed — the caller must then re-solve the canvas layout, since
 * chromeParams() reserves an extra footer row while wrapped.
 */
function updateNoonToggleWrap(): boolean {
    const toggle = document.getElementById('noon-toggle');
    if (!toggle) return false;
    const w = window.innerWidth;
    const toggleW = toggle.getBoundingClientRect().width;
    // Rightmost extent of the time-bar's left-aligned contents (hidden
    // elements — e.g. the Now button at 1× real time — report zero width).
    let leftEdge = 0;
    for (const id of ['time-bar-label', 'time-bar-info', 'time-bar-now']) {
        const r = document.getElementById(id)?.getBoundingClientRect();
        if (r && r.width > 0) leftEdge = Math.max(leftEdge, r.right);
    }
    const controls = document.getElementById('observatory-controls')?.getBoundingClientRect();
    const rightEdge = controls && controls.width > 0 ? controls.left : w;
    const fits = (w - toggleW) / 2 >= leftEdge + NOON_TOGGLE_GAP
        && (w + toggleW) / 2 <= rightEdge - NOON_TOGGLE_GAP;
    const shouldWrap = !fits;
    if (shouldWrap === noonToggleWrapped) return false;
    noonToggleWrapped = shouldWrap;
    toggle.classList.toggle('wrapped', noonToggleWrapped);
    return true;
}

/** Chrome insets for the layout: footer row(s) + popover arms when open. */
function chromeParams(): ChromeParams {
    let popover: ChromeParams['popover'] = null;
    if (timeUI?.isPopoverOpen()) {
        const upper = document.getElementById('tp-upper')?.getBoundingClientRect();
        const lower = document.getElementById('tp-lower')?.getBoundingClientRect();
        if (upper && lower && upper.width > 0) {
            popover = {
                upperW: upper.width, upperH: upper.height,
                lowerW: lower.width, lowerH: lower.height,
            };
        }
    }
    // A wrapped noon toggle occupies a second row above the footer.
    return { footerH: FOOTER_H * (noonToggleWrapped ? 2 : 1), popover };
}

function resizeCanvas(): void {
    const dpr = devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    // Re-check whether the noon toggle still fits in the footer row at the new
    // size (chromeParams reserves a second row while it's wrapped).
    updateNoonToggleWrap();

    // Recompute layout (accounting for the footer row(s) + open popover)
    layout = computeLayout(w, h, chromeParams());

    // Invalidate static caches so they rebuild at new size
    invalidateBackgroundCache();
    invalidateMainDialCache();
    invalidateRingCache();
    invalidatePeripheralDialsCache();
    needsStaticRedraw = true;
    // The loop may be idle (stopped); a resize must trigger a redraw.
    scheduleFrame();
}

let needsStaticRedraw = true;

// Debounced resize handler
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
const ro = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        resizeCanvas();
    }, 100);
});

/**
 * Draw the current frame.
 * Phase 1: draws the main dial static cache + placeholder outlines for
 * peripheral elements not yet implemented.
 */
function drawFrame(): void {
    const dpr = devicePixelRatio || 1;
    const w = canvas.width;
    const h = canvas.height;

    // Clear to black
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);

    const L = layout;

    // ================================================================
    // 0. Starfield background (static, full-viewport cache) — the iOS
    //    EOBaseView base layer; everything else draws on top of it.
    // ================================================================
    const bgCache = getBackgroundCache(L);
    if (bgCache) {
        ctx.drawImage(bgCache, 0, 0);
    }

    // ================================================================
    // 1. Draw static main dial cache (composited at native resolution)
    // ================================================================
    const dialCache = getMainDialCache(L, noonOnTop);
    if (dialCache) {
        // Cache is already at DPR resolution — draw 1:1 into the canvas
        ctx.drawImage(dialCache, 0, 0);
    }

    // Peripheral dial backgrounds (static, DPR-resolution full-viewport cache).
    ctx.drawImage(getPeripheralDialsCache(L), 0, 0);

    // Scale for DPR for all remaining drawing
    ctx.save();
    ctx.scale(dpr, dpr);

    // ================================================================
    // 2. Rise/set rings (dynamic — recomputed hourly)
    //    Draw after static dial but before planet hands so arcs
    //    appear between the orbit circles and the planet icons.
    // ================================================================
    const now = getNow();
    const tzOffsetSec = env.tzOffsetSec ?? 0;
    if (updater) {
        drawRiseSetRings(ctx, L, env, noonOnTop, now, lat, lon, tzOffsetSec, updater);
    }

    // ================================================================
    // 3. Planet hands (dynamic — values update hourly via ObsValues)
    // ================================================================
    if (updater) {
        drawPlanetHands(ctx, L, updater);
    }

    // ================================================================
    // 3b. Subdial hands (UTC, Solar, Sidereal)
    //     Drawn before main clock hands so main hands appear on top.
    // ================================================================
    if (updater) {
        drawSubdialHands(ctx, L, updater);
    }

    // ================================================================
    // 3c. Clock hands (24h, 12h, minute, second, sun events)
    //     Drawn last so the three main hands (h, m, s) are on top of
    //     everything else, as they would be physically.
    // ================================================================
    if (updater) {
        drawClockHands(ctx, L, updater);
    }

    // ================================================================
    // 4. Peripheral dial hands + labels (backgrounds are in the static cache)
    // ================================================================
    if (updater) {
        drawPeripheralHands(ctx, L, updater, selectedPlanet);
        // Eclipse simulator: disc geometry + status labels + ring hands (7B).
        drawEclipseView(ctx, L, updater);
    }

    // ================================================================
    // 5. Header: moon, earth map, date display
    // ================================================================
    // Moon phase display (Phase 6)
    if (updater) {
        drawMoonView(ctx, L, updater);
    }

    // Earth map (Phase 5: day/night terminator)
    if (updater) {
        drawEarthView(ctx, L, updater, lat, lon, getNow);
    }

    // Date display (Phase 7)
    drawDateView(ctx, L, now, locationTimezone);

    // ================================================================
    // 6. Debug status overlay (top-left)
    // ================================================================
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const timeStr = now.toLocaleTimeString('en-US', {
        hour12: false,
        timeZone: locationTimezone,
    });
    ctx.fillText(`Observatory · ${timeStr}`, 10, 10);
    ctx.fillText(`${layout.viewW}×${layout.viewH} · mainR=${L.mainR.toFixed(0)}`, 10, 24);
    // FPS is shown via the shared DOM overlay (createFpsIndicator), bottom-left.

    ctx.restore();
}

/** Start the render loop if it is currently idle (no-op if already running). */
function scheduleFrame(): void {
    if (inTick) {
        // The running tick will decide whether to re-arm; just record the request.
        frameRequestedDuringTick = true;
        return;
    }
    if (rafId === null) rafId = requestAnimationFrame(tick);
}

function tick(): void {
    rafId = null;
    inTick = true;
    frameRequestedDuringTick = false;
    const perfNow = performance.now();

    // Check for quantized tick (time controller)
    timeController.checkTick(perfNow);

    // Begin frame snapshot (all parts see same time)
    timeController.beginFrame();

    let animating = false;

    // Pass 1 & 2: Update + animate Observatory values. The TimingContext (tick
    // rate, per-tick display delta, direction) is derived generically from the
    // controller — the shared updater seam, no hand-rolled glue here.
    if (updater) {
        updater.tick(env, perfNow, getNow, withDisplayTime,
            timingContextForFrame(timeController));
        animating = updater.anyAnimating();
    }

    drawFrame();

    // Update time controller UI display
    timeUI?.updateTimeUI();

    timeController.endFrame();

    // Keep rendering while running (the second-hand sweep needs it) or while an
    // animation is still settling; otherwise go fully idle. A stopped, settled
    // clock has nothing to re-render — display time is frozen. The loop is
    // restarted by scheduleFrame()/ensureSchedulerRunning() on the next change.
    const continuous = !timeController.isStopped || animating;
    fpsIndicator?.recordFrame(continuous);
    inTick = false;
    if (continuous || frameRequestedDuringTick) {
        rafId = requestAnimationFrame(tick);
    }
}

// ============================================================================
// Location dialog
// ============================================================================

function updateLocationDisplay(): void {
    const nameEl = document.getElementById('location-name');
    if (!nameEl) return;

    if (lat === 0 && lon === 0 && needsPrompt) {
        nameEl.textContent = 'No location set';
        return;
    }
    const cityName = urlState.city || null;
    if (cityName) {
        nameEl.textContent = cityName;
    } else {
        const closest = findClosestCity(lat, lon);
        nameEl.textContent = closest?.shortLabel ?? `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
    }
}

function rebuildEnv(): void {
    tzDeltaMs = computeTzDeltaMs(locationTimezone);
    env = createAstroEnvironment(lat, lon, getNow, locationTimezone);
    // Preserve env variables across the re-created environment.
    env.variables.set('noonOnTop', noonOnTop ? 1 : 0);
    env.variables.set('dialPlanet', selectedPlanet);
    invalidateRingCache();
    needsStaticRedraw = true;
    // The loop may be idle (stopped); env changes must trigger a redraw.
    scheduleFrame();
}

function setupLocationDialog(): void {
    const setLocationBtn = document.getElementById('set-location-btn');
    const locationDialog = initLocationDialog({
        initialLat: lat,
        initialLon: lon,
        needsPrompt,
        onLocationChange: (info) => {
            lat = info.lat;
            lon = info.lon;
            locationTimezone = info.timezone;
            needsPrompt = false;

            if (info.sourceType === 'browser') {
                setState({ bloc: true, lat: null, lon: null, city: null, tz: null });
            } else {
                setState({ lat: info.lat, lon: info.lon, city: info.source || null, tz: info.timezone || null });
            }

            // Re-evaluate all values at the new location: sentinel-scheduled
            // values (Sun ring, planet rings) hold a nextUpdateTime computed for
            // the old location and won't recompute otherwise. (The ring caches
            // clear implicitly via this reset — see ring-view.invalidateRingCache.)
            updater?.reset();
            rebuildEnv();
            updateLocationDisplay();
            timeUI?.updateTimezoneDisplay();
        },
    });

    if (locationDialog && setLocationBtn) {
        setLocationBtn.addEventListener('click', () => locationDialog.show());

        if (needsPrompt) {
            locationDialog.show();
        }

        // Handle bloc=1: request browser location on startup.
        //
        // Timing: only show the compact "locating…" panel if the request is still
        // pending after LOCATING_SHOW_DELAY_MS — a fast geolocation response should
        // never flash the panel. If we do show it, keep it up for at least
        // LOCATING_MIN_VISIBLE_MS so it doesn't vanish in a blink (the rings
        // animate behind it meanwhile).
        if (urlState.bloc && !hasUrlLocation) {
            const LOCATING_SHOW_DELAY_MS = 1000;
            const LOCATING_MIN_VISIBLE_MS = 2000;
            let shownAt: number | null = null;
            let showTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
                showTimer = null;
                locationDialog.showLocating();
                shownAt = performance.now();
            }, LOCATING_SHOW_DELAY_MS);

            // Run `apply` now if the panel was never shown, otherwise once it has
            // been visible for the minimum duration.
            const afterMinVisible = (apply: () => void) => {
                if (showTimer !== null) {
                    clearTimeout(showTimer);   // result beat the show delay — never show
                    showTimer = null;
                    apply();
                } else {
                    const remaining = LOCATING_MIN_VISIBLE_MS - (performance.now() - (shownAt ?? 0));
                    if (remaining > 0) setTimeout(apply, remaining);
                    else apply();
                }
            };

            requestBrowserLocation(10000).then(result => {
                if (result.status === 'success') {
                    afterMinVisible(() => {
                        // If we showed the panel and the user switched to manual
                        // entry, don't override their flow with the late result.
                        if (shownAt !== null && !locationDialog.isLocating()) return;
                        const tz = resolveTimezone(result.lat, result.lon, null);
                        lat = result.lat;
                        lon = result.lon;
                        locationTimezone = tz;
                        needsPrompt = false;
                        locationDialog.updateState(lat, lon, 'browser', '', '');
                        // Async location arrived after buildObsValues ran at the
                        // startup default — re-evaluate everything (esp. the
                        // sentinel-scheduled Sun/planet rings) at the real location.
                        updater?.reset();
                        rebuildEnv();
                        updateLocationDisplay();
                        locationDialog.dismiss();
                    });
                } else {
                    afterMinVisible(() => {
                        // Browser location failed/timed out — show the full dialog
                        // (non-dismissable until a location is chosen).
                        needsPrompt = true;
                        locationDialog.setNeedsPrompt(true);
                        if (result.status === 'denied') {
                            locationDialog.setGeoPermission('denied');
                        }
                        locationDialog.show();
                    });
                }
            });
        }
    }
}

// ============================================================================
// Noon-on-top toggle
// ============================================================================

/**
 * Wire the footer noon-on-top pill control (Vienna-style, see
 * face-template.html / engine-entry.ts for the Chronometer original).
 *
 * Toggling moves the `noonOnTop` env variable and resets the updater: every
 * expression with a `+ pi * noonOnTop` term (24h hand, sun-event hands, planet
 * rings, sun-ring gradient stops) re-evaluates against its new target, so all
 * moving parts *animate* to the flipped positions — the same sweep as a
 * location change. The main-dial static cache keys on noonOnTop and rebuilds
 * on the next frame.
 */
function setupNoonToggle(): void {
    const toggle = document.getElementById('noon-toggle');
    if (!toggle) return;
    const midnightPill = toggle.querySelector('[data-mode="midnight"]') as HTMLButtonElement;
    const noonPill = toggle.querySelector('[data-mode="noon"]') as HTMLButtonElement;

    const updateHighlight = () => {
        midnightPill.classList.toggle('active', !noonOnTop);
        noonPill.classList.toggle('active', noonOnTop);
    };

    const setNoonOnTop = (value: boolean) => {
        if (value === noonOnTop) return;
        noonOnTop = value;
        env.variables.set('noonOnTop', noonOnTop ? 1 : 0);
        setState({ onoon: noonOnTop });
        updater?.reset();
        updateHighlight();
        // The loop may be idle (stopped); the toggle must trigger a redraw.
        scheduleFrame();
    };

    midnightPill.addEventListener('click', () => setNoonOnTop(false));
    noonPill.addEventListener('click', () => setNoonOnTop(true));
    updateHighlight();

    // The footer's neighbors change size at runtime (the red offset label and
    // the Now button appear when time is overridden), which can change whether
    // the centered toggle fits in the row. Watch them and re-solve the canvas
    // layout when the wrap state flips. (Observing the toggle itself also
    // catches the font-load width change.)
    const footerRo = new ResizeObserver(() => {
        if (updateNoonToggleWrap()) resizeCanvas();
    });
    footerRo.observe(toggle);
    for (const id of ['time-bar-label', 'time-bar-info', 'time-bar-now', 'observatory-controls']) {
        const el = document.getElementById(id);
        if (el) footerRo.observe(el);
    }
}

// ============================================================================
// Initialization
// ============================================================================

function init(): void {
    // Keep the DOM footer row and the canvas layout's reserved band in sync.
    document.documentElement.style.setProperty('--obs-footer-h', `${FOOTER_H}px`);
    if (urlState.fps) document.body.classList.add('has-fps');

    initCanvas();
    ro.observe(document.documentElement);
    setupLocationDialog();
    setupNoonToggle();
    updateLocationDisplay();

    // Help ("ℹ") popover — shared wiring; the General Help iframe drops the
    // Chronometer-only sections via the app=observatory param (see help.html).
    initHelpPopover({ generalHelpUrl: 'help.html?embed=1&app=observatory' });
    initShareButton({ getState });

    // Live cross-tab sync: apply shared location/time and Observatory config
    // (selected planet, noon-on-top) when another tab/app changes them.
    onSharedChange((s) => {
        let changed = false;

        if (s.lat !== null && s.lon !== null &&
            (s.lat !== lat || s.lon !== lon || (s.tz || undefined) !== locationTimezone)) {
            lat = s.lat;
            lon = s.lon;
            locationTimezone = s.tz || resolveTimezone(lat, lon, null);
            needsPrompt = false;
            urlState.city = s.city;
            updateLocationDisplay();
            timeUI?.updateTimezoneDisplay();
            changed = true;
        }

        const op = (s.op !== null && SELECTABLE_PLANETS.has(s.op)) ? s.op : 0;
        if (op !== selectedPlanet) { selectedPlanet = op; changed = true; }

        if (s.onoon !== noonOnTop) {
            noonOnTop = s.onoon;
            const toggle = document.getElementById('noon-toggle');
            toggle?.querySelector('[data-mode="midnight"]')?.classList.toggle('active', !noonOnTop);
            toggle?.querySelector('[data-mode="noon"]')?.classList.toggle('active', noonOnTop);
            changed = true;
        }

        // Time (setTime/setOffset/reset fire onTick → rebuildEnv automatically).
        if (s.off !== null) { timeController.setOffset(s.off); changed = true; }
        else if (s.t !== null) {
            timeController.setTime(new Date(s.t));
            if (s.dir === 1) { timeController.setDirection(1); timeController.setRate(null); }
            else if (s.dir === -1) { timeController.setDirection(-1); timeController.setRate(null); }
            changed = true;
        } else if (!timeController.isRealTime) { timeController.reset(); changed = true; }

        if (changed) { updater?.reset(); rebuildEnv(); }
    });

    // Wire up time controller env rebuild on tick. The controller fires onTick on
    // every transition (reset/stop/setTime/setOffset/setRate/setDirection) as well
    // as on each quantized tick, so this keeps env (timezone offset, DST) fresh
    // across both continuous advance and discrete jumps — which is why the time
    // controls need no transition callbacks of their own (see below).
    timeController.onTick = () => rebuildEnv();

    // Initialize Observatory value system
    env.variables.set('noonOnTop', noonOnTop ? 1 : 0);
    env.variables.set('dialPlanet', selectedPlanet);
    updater = buildObsValues(env, performance.now(), getNow);

    // Initialize earth view (altitude table + Blue Marble images)
    initEarthView();

    // Initialize moon view (moon image)
    initMoonView();
    initEclipseView();

    // --- Wire time controller UI ---
    // No transition callbacks: handing the Updater to the shared controls means
    // every transport transition auto-resets the value schedules, and
    // `timeController.onTick → rebuildEnv()` (above) refreshes env. The default
    // writeTimeState persists the t/off/dir params, completing the deep-link
    // round-trip. ensureSchedulerRunning restarts the idle-parked render loop.
    timeUI = initTimeControls({
        timeController,
        updater,
        getTimezone: () => locationTimezone,
        getTzDeltaMs: () => tzDeltaMs,
        getLat: () => lat,
        getLon: () => lon,
        ensureSchedulerRunning: () => {
            // The loop idles when stopped + settled; restart it on transport changes.
            scheduleFrame();
        },
        onPopoverToggle: () => {
            // The open popover participates in the layout (its L-arms become
            // exclusion zones) — re-solve so the whole display stays visible.
            resizeCanvas();
        },
    });

    // Show time controller if URL says so
    if (urlState.tc) {
        timeUI?.showPopover();
    }

    console.log('[Observatory] Initialized — lat:', lat, 'lon:', lon, 'tz:', locationTimezone);

    // Page-level FPS overlay (enabled via ?fps) — shared with Chronometer.
    fpsIndicator = createFpsIndicator(urlState.fps);

    // Wait for images to load, then invalidate cache so first real draw occurs
    Promise.all([waitForImages(), waitForPlanetImages(), waitForBackgroundImage()]).then(() => {
        invalidateMainDialCache();
        // Image load can complete after the loop has idled — kick it so the
        // first real frame draws.
        scheduleFrame();
        console.log('[Observatory] All images loaded');
    });

    // Start render loop
    scheduleFrame();
}

// Boot when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
