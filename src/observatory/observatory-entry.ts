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
import type { Environment } from '../expr/env.js';
import { getState, setState, initAppState, onSharedChange, isPersistentMode } from '../shared/app-state.js';
import { resolveTimezone } from '../shared/tz-resolve.js';
import { findClosestCity, findLargestCityNear, prefetchCityData, loadCityData, releaseCityData, isCityDataLoaded } from '../shared/city-search.js';
import { initLocationDialog, requestBrowserLocation } from '../shared/location-dialog.js';
import { showStorageWarning } from '../shared/incoming-settings-dialog.js';
import { TimeController } from '../shared/time-controller.js';
import { initTimeControls, flushTimeState } from '../shared/time-controls-ui.js';
import { initHelpPopover, openGeneralHelpTopic } from '../shared/help-popover.js';
import { registerHotkey } from '../shared/hotkeys.js';
import { initAppNavLinks, registerAppNavHotkeys } from '../shared/app-nav.js';
import { initShareButton } from '../shared/share-button.js';
import type { TimeControlsAPI } from '../shared/time-controls-ui.js';
import { updateDynamicCompositeIcon } from '../shared/composite-icon.js';
import { type LayoutParams } from './layout.js';
import { computeLayout, type ObsChrome } from './anchor-layout.js';
import { getBackgroundCache, invalidateBackgroundCache, waitForBackgroundImage } from './background.js';
import { getMainDialCache, invalidateMainDialCache, waitForImages } from './main-dial.js';
import { drawPlanetHands, waitForPlanetImages } from './planet-hands.js';
import { drawRiseSetRings, invalidateRingCache } from './ring-view.js';
import { drawClockHands, drawSubdialHands } from './hand-views.js';
import { initEarthView, drawEarthView, isInsideEarthMap, earthPixelToLatLon, drawDragCrosshair } from './earth-view.js';
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

/** Timezone the current `layout` was solved for, so a tz change re-solves it. */
let lastLayoutTz: string | undefined;

/** Last logged "W×H · mainR · anchor" signature, so we log only on change. */
let lastSizeSig = '';

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

// Yellow tint for the location name while a seeded-bloc geolocation refresh is
// in flight (a lightweight stand-in for a fuller "updating location" indicator).
const LOCATING_TINT = '#e6b800';

// A seeded-bloc refresh failure is not necessarily benign: the seed could be a
// stale last-known location (possibly months old). Tell the user once per
// session, via the shared dismissible toast, that we fell back to it.
let blocRefreshNoticeShown = false;
function notifyBlocRefreshFailed(): void {
    if (blocRefreshNoticeShown) return;
    blocRefreshNoticeShown = true;
    showStorageWarning('Could not retrieve location from browser — falling back to last known location.');
}

// Prefetch the city DB in the background (held as a ~7.5 MB compressed blob,
// parsed on demand) so opening the location dialog is instant even on flaky
// networks. Skipped when the user asked to conserve data. See
// planning/2026-06-14-observatory-cities-lazy-load.md.
if (!(navigator as any).connection?.saveData) prefetchCityData();

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
// Drag-to-explore state
// ============================================================================

/** Drag-to-explore state machine: idle → dragging → confirming → idle. */
let dragState: 'idle' | 'dragging' | 'confirming' = 'idle';
/** Saved location before drag started (restored on Revert). */
let savedLat = 0;
let savedLon = 0;
let savedTz: string | undefined;
let savedCity: string | null = null;
/** Current shift-key axis constraint during drag. */
let dragAxisLock: 'none' | 'lat' | 'lon' = 'none';
/** True when a drag moved the location and values need re-evaluation. */
let dragNeedsUpdate = false;
/** True when the timezone was locked during dragging. */
let dragWasTimezoneLocked = false;
/** Flag to suppress the synthetic click event after a drag. */
let suppressNextClick = false;

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
    // Suppress the synthetic click that fires after a drag-to-explore pointerup.
    if (suppressNextClick) { suppressNextClick = false; return; }
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
 * Height of the top chrome row (the iteration-3 header band: "Observatory" left,
 * ℹ + share right). Mirrored into --obs-header-h so the DOM band and the canvas
 * layout reserve the same strip. The layout designs in the safe rect *below*
 * this band (anchor-layout.ts §1).
 */
const HEADER_H = 32;

/**
 * Read the device safe-area insets (notch / home indicator) via a hidden probe
 * whose paddings are set to `env(safe-area-inset-*)`. Zero on desktop windows,
 * so the safe rect equals the window there. `viewport-fit=cover` (in
 * observatory.html) is what exposes these to CSS — see plan §5.
 */
let insetProbe: HTMLDivElement | null = null;
function readSafeInsets(): { insetTop: number; insetRight: number; insetBottom: number; insetLeft: number } {
    if (!insetProbe) {
        insetProbe = document.createElement('div');
        insetProbe.style.cssText =
            'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;'
            + 'padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);'
            + 'padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);';
        document.body.appendChild(insetProbe);
    }
    const cs = getComputedStyle(insetProbe);
    return {
        insetTop: parseFloat(cs.paddingTop) || 0,
        insetRight: parseFloat(cs.paddingRight) || 0,
        insetBottom: parseFloat(cs.paddingBottom) || 0,
        insetLeft: parseFloat(cs.paddingLeft) || 0,
    };
}

/** Chrome bands + safe-area insets for the layout (iteration 3). */
function chromeParams(): ObsChrome {
    // Iteration 3: the time-controller popover and the noon pill are on-demand
    // overlays that cost the static layout nothing (§6 C2), so no popover arms.
    return { footerH: FOOTER_H, headerH: HEADER_H, ...readSafeInsets() };
}

function resizeCanvas(): void {
    const dpr = devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    // Recompute layout. The date region of the extreme/landscape anchors is
    // sized from measured text, so we feed the live display time + location tz
    // and measure against the canvas context (see anchor-layout computeLayout).
    layout = computeLayout(w, h, chromeParams(), ctx, timeController.getDisplayTime(), locationTimezone);
    lastLayoutTz = locationTimezone;
    // CC2: when the chrome is dropped (the time controller can't fit), hide the
    // DOM header/footer too so they don't overlap the full-surface layout.
    document.body.classList.toggle('obs-chrome-dropped', !!layout.chromeDropped);
    positionNoonIcon();

    // Log the window size + mainR whenever either changes (startup + each resize
    // / anchor switch). Replaces the old on-canvas debug overlay.
    const sizeSig = `${w}×${h} · mainR=${layout.mainR.toFixed(1)} · ${layout.anchor ?? '?'}`;
    if (sizeSig !== lastSizeSig) {
        console.log(`[Observatory] viewport ${sizeSig}`);
        lastSizeSig = sizeSig;
    }

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
        // During drag or while confirming, pin the observer dot at the saved
        // (home) location and show the crosshair at the rendered position.
        if (dragState === 'dragging' || dragState === 'confirming') {
            drawEarthView(ctx, L, updater, lat, lon, getNow, savedLat, savedLon);
            // Crosshair at the rendered (temporary) location.
            drawDragCrosshair(ctx, L, lat, lon);
        } else {
            drawEarthView(ctx, L, updater, lat, lon, getNow);
        }
    }

    // Date display (Phase 7)
    drawDateView(ctx, L, now, locationTimezone);
    // FPS is shown via the shared DOM overlay (createFpsIndicator), bottom-left.
    // (The old top-left size/mainR overlay is gone — see the console log in
    // resizeCanvas, which prints the window size + mainR whenever they change.)

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
        if (dragState === 'dragging' || dragState === 'confirming') {
            if (dragNeedsUpdate) {
                // Location changed — re-evaluate all expressions with fixed 0.3s animation.
                updater.tickFixedDuration(env, perfNow, 300);
                dragNeedsUpdate = false;
            } else {
                // No location change — just interpolate existing animations.
                updater.animateOnly(perfNow);
            }
        } else {
            updater.tick(env, perfNow, getNow, withDisplayTime,
                timingContextForFrame(timeController));
        }
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
    fpsIndicator?.recordFrame(continuous, performance.now() - perfNow);
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
    const cityName = getState().city || null;
    if (cityName) {
        nameEl.textContent = cityName;
        return;
    }

    // No stored name for these coordinates. Show the nearest city if the DB is
    // already parsed; otherwise show coordinates and resolve in the background
    // (parsing on demand). Persist the derived name only in persistent mode, so
    // a future load skips the DB; never persist in session-only/in-memory mode.
    const applyClosest = (): boolean => {
        const closest = findClosestCity(lat, lon);
        if (!closest) return false;
        nameEl.textContent = closest.shortLabel;
        if (isPersistentMode() && !getState().city) setState({ city: closest.shortLabel });
        return true;
    };

    if (isCityDataLoaded() && applyClosest()) return;

    nameEl.textContent = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
    loadCityData().then(() => {
        if (getState().city) return;            // a named location was set meanwhile
        applyClosest();
        if (!dialogShown() && dragState === 'idle') releaseCityData();   // one-shot: drop unless dialog open or dragging
    }).catch(() => {});
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

function rebuildEnv(): void {
    tzDeltaMs = computeTzDeltaMs(locationTimezone);
    env = createAstroEnvironment(lat, lon, getNow, locationTimezone);
    // Preserve env variables across the re-created environment.
    env.variables.set('noonOnTop', noonOnTop ? 1 : 0);
    env.variables.set('dialPlanet', selectedPlanet);
    invalidateRingCache();
    needsStaticRedraw = true;
    // The date-region geometry of some anchors (A1/A5/A6/Awide) is sized in the
    // location's timezone, so a timezone change must re-solve the layout. Guard
    // on the tz so scrubbing (which fires rebuildEnv every tick) doesn't relayout
    // each frame — a same-tz day-boundary shift is left to the next resize.
    if (locationTimezone !== lastLayoutTz) {
        if (dragState === 'dragging') {
            // Defer layout recomputation and static cache invalidation during active drag
            // to keep the drag interaction smooth. The layout will be recomputed for the
            // final timezone upon release.
        } else {
            resizeCanvas();
            return;
        }
    }
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
                // Persist bloc intent *with* the fix, so a reload seeds the
                // display (no 0,0 flash) and can skip the DB while stationary.
                const derived = isCityDataLoaded() ? findClosestCity(info.lat, info.lon)?.shortLabel : null;
                setState({ bloc: true, lat: info.lat, lon: info.lon, city: derived ?? null, tz: info.timezone || null });
            } else {
                setState({ bloc: false, lat: info.lat, lon: info.lon, city: info.source || null, tz: info.timezone || null });
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
        setLocationBtn.addEventListener('click', () => {
            const s = getState();
            if (s.lat !== null && s.lon !== null) {
                const sourceType = s.bloc ? 'browser' : (s.city ? 'url-city' : 'manual');
                locationDialog.updateState(s.lat, s.lon, sourceType, s.city || '', s.city || '');
            }
            locationDialog.show();
        });

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
                        // Seed the fix so the next reload shows it immediately and
                        // can skip the DB while stationary (automatic write — gated
                        // on persistent mode; the city name is filled by
                        // updateLocationDisplay's reverse-geocode).
                        if (isPersistentMode()) setState({ bloc: true, lat, lon, tz });
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
        } else if (urlState.bloc && hasUrlLocation) {
            // Seeded bloc: the display already shows the stored last-known
            // location, so refresh quietly in the background — no "locating"
            // panel. Tint the location name yellow while the fix is in flight.
            // Only update if the new fix moved beyond the reuse threshold; a
            // failed/denied refresh keeps the seed and shows a one-time notice
            // (the seed may be stale), via notifyBlocRefreshFailed.
            const blocNameEl = document.getElementById('location-name');
            if (blocNameEl) blocNameEl.style.color = LOCATING_TINT;
            requestBrowserLocation(10000).then(result => {
                if (result.status !== 'success') { notifyBlocRefreshFailed(); return; }
                if (haversineKm(lat, lon, result.lat, result.lon) <= 16) return;  // stationary
                const tz = resolveTimezone(result.lat, result.lon, null);
                lat = result.lat;
                lon = result.lon;
                locationTimezone = tz;
                // Moved: the stored city name is stale — clear it so
                // updateLocationDisplay reverse-geocodes the new spot; reseed.
                if (isPersistentMode()) setState({ bloc: true, lat, lon, city: null, tz });
                locationDialog.updateState(lat, lon, 'browser', '', '');
                updater?.reset();
                rebuildEnv();
                updateLocationDisplay();
                timeUI?.updateTimezoneDisplay();
            }).catch(() => notifyBlocRefreshFailed()).finally(() => {
                if (blocNameEl) blocNameEl.style.color = '';
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
/**
 * Position the footer's noon-toggle icon. Normally centred; when the main dial
 * reaches into the footer row (e.g. A5), the centred icon would sit under the
 * dial, so it moves to the right of the time-controller button (and the red
 * offset label / Now button, when shown).
 */
function positionNoonIcon(): void {
    const icon = document.getElementById('noon-icon');
    if (!icon || !layout) return;
    const footerTop = window.innerHeight - readSafeInsets().insetBottom - FOOTER_H;
    const dialInFooter = layout.mainCY + layout.mainR > footerTop;
    if (dialInFooter) {
        // Rightmost edge of the time-bar's left-aligned contents (hidden
        // elements — e.g. the Now button at 1× real time — report zero width).
        let rightEdge = 0;
        for (const id of ['time-bar-label', 'time-bar-info', 'time-bar-now']) {
            const r = document.getElementById(id)?.getBoundingClientRect();
            if (r && r.width > 0) rightEdge = Math.max(rightEdge, r.right);
        }
        icon.style.left = `${rightEdge + 12}px`;
        icon.style.transform = 'none';
    } else {
        icon.style.left = '50%';
        icon.style.transform = 'translateX(-50%)';
    }
}

/**
 * Noon-on-top control (iteration 3, §6 C2): a small footer-centre icon that, on
 * tap, raises the Midnight/Noon pill as an on-demand overlay (which may overlap
 * the dial — rare — so it costs the static layout nothing). Replaces the
 * always-present wrapping pill row.
 */
function setupNoonToggle(): void {
    const toggle = document.getElementById('noon-toggle');
    const icon = document.getElementById('noon-icon');
    if (!toggle || !icon) return;
    const midnightPill = toggle.querySelector('[data-mode="midnight"]') as HTMLButtonElement;
    const noonPill = toggle.querySelector('[data-mode="noon"]') as HTMLButtonElement;

    const updateHighlight = () => {
        midnightPill.classList.toggle('active', !noonOnTop);
        noonPill.classList.toggle('active', noonOnTop);
        // Rotate the disc icon: dark half on top for midnight, light half on
        // top for noon (the .noon class flips it the extra 180°).
        icon.classList.toggle('noon', noonOnTop);
    };
    const closeOverlay = () => toggle.classList.remove('open');

    const setNoonOnTop = (value: boolean) => {
        closeOverlay();
        if (value === noonOnTop) return;
        noonOnTop = value;
        env.variables.set('noonOnTop', noonOnTop ? 1 : 0);
        setState({ onoon: noonOnTop });
        updater?.reset();
        updateHighlight();
        // The loop may be idle (stopped); the toggle must trigger a redraw.
        scheduleFrame();
    };

    icon.addEventListener('click', (e) => { e.stopPropagation(); toggle.classList.toggle('open'); });
    midnightPill.addEventListener('click', () => setNoonOnTop(false));
    noonPill.addEventListener('click', () => setNoonOnTop(true));
    // Dismiss the overlay on any click outside it (and outside the icon).
    document.addEventListener('click', (e) => {
        if (!toggle.classList.contains('open')) return;
        const t = e.target as Node;
        if (!toggle.contains(t) && !icon.contains(t)) closeOverlay();
    });
    updateHighlight();
    positionNoonIcon();
    // (Re-placement on time-bar content changes is driven by timeController.onTick
    // and the initial deferred call in init(), not a ResizeObserver here.)
}

// ============================================================================
// Drag-to-explore (earth map)
// ============================================================================

/**
 * Apply a temporary location without persisting to LocalStorage.
 * Rebuilds the astronomy environment and resets all ObsValue schedules
 * so the display immediately reflects the new position.
 */
function applyTemporaryLocation(newLat: number, newLon: number, lockTimezone?: boolean): void {
    lat = newLat;
    lon = newLon;
    const nameEl = document.getElementById('location-name');
    if (isCityDataLoaded()) {
        // Try the largest city within 1 CSS pixel of the cursor first.
        const radiusDeg = layout ? 360 / layout.earthW : 1;
        const nearby = findLargestCityNear(lat, lon, radiusDeg);
        if (nearby) {
            locationTimezone = lockTimezone ? savedTz : nearby.timezone;
            if (nameEl) nameEl.textContent = nearby.shortLabel;
        } else {
            // No city within 1 pixel — fall back to closest for both tz
            // and display (previews what accept will do).
            const closest = findClosestCity(lat, lon);
            locationTimezone = lockTimezone
                ? savedTz
                : (closest?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
            if (nameEl) nameEl.textContent = closest?.shortLabel
                ?? `${lat.toFixed(1)}°, ${lon.toFixed(1)}°`;
        }
    } else {
        // City DB not loaded yet — use longitude-based UTC offset as fallback.
        if (lockTimezone) {
            locationTimezone = savedTz;
        } else {
            const offsetHours = Math.round(lon / 15);
            locationTimezone = `Etc/GMT${offsetHours <= 0 ? '+' : '-'}${Math.abs(offsetHours)}`;
        }
        if (nameEl) nameEl.textContent = `${lat.toFixed(1)}°, ${lon.toFixed(1)}°`;
    }
    rebuildEnv();
    dragNeedsUpdate = true;
    updater?.reset();
    scheduleFrame();
}

/**
 * Set up pointer event listeners on the canvas for drag-to-explore.
 *
 * Press on the earth map to immediately switch the display to that location;
 * drag to explore in real time; on release, confirm (Keep) or revert.
 *
 * Shift-key axis lock: hold Shift to constrain to latitude-only or
 * longitude-only change from the saved position (whichever axis has the
 * larger delta). The lock is re-evaluated on every move — no sticky axis.
 */
function setupMapDrag(): void {
    canvas.addEventListener('pointerdown', (ev: PointerEvent) => {
        if (!layout) return;
        if (dragState !== 'idle') return;
        const rect = canvas.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const y = ev.clientY - rect.top;
        if (!isInsideEarthMap(x, y, layout)) return;

        // Ensure city DB is loaded for timezone resolution during drag.
        // The compressed blob is already prefetched; this just decompresses
        // + parses (~few ms from cache). The first pointerdown/move may use
        // the longitude-based fallback if the async load hasn't finished.
        if (!isCityDataLoaded()) {
            loadCityData().catch(() => {});
        }

        // Save the current location so we can revert.
        savedLat = lat;
        savedLon = lon;
        savedTz = locationTimezone;
        savedCity = getState().city;

        // Compute the clicked lat/lon and apply immediately.
        dragWasTimezoneLocked = ev.altKey;
        const { lat: newLat, lon: newLon } = computeDragLatLon(x, y, ev.shiftKey);
        applyTemporaryLocation(newLat, newLon, dragWasTimezoneLocked);

        dragState = 'dragging';
        canvas.setPointerCapture(ev.pointerId);
        ev.preventDefault();  // prevent text selection / default touch behavior
    });

    canvas.addEventListener('pointermove', (ev: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const y = ev.clientY - rect.top;

        if (dragState === 'dragging') {
            // Only update the location if the pointer is inside the map.
            if (isInsideEarthMap(x, y, layout)) {
                dragWasTimezoneLocked = ev.altKey;
                const { lat: newLat, lon: newLon } = computeDragLatLon(x, y, ev.shiftKey);
                applyTemporaryLocation(newLat, newLon, dragWasTimezoneLocked);
            }
            return;
        }

        // Cursor feedback: show crosshair when hovering over the earth map.
        if (dragState === 'idle' && layout) {
            canvas.style.cursor = isInsideEarthMap(x, y, layout) ? 'crosshair' : '';
        }
    });

    canvas.addEventListener('pointerup', (ev: PointerEvent) => {
        if (dragState !== 'dragging') return;
        canvas.releasePointerCapture(ev.pointerId);
        suppressNextClick = true;  // suppress the synthetic click after pointerup

        const tzLabel = document.getElementById('map-drag-tz-label');
        const tzCheckbox = document.getElementById('map-drag-tz-checkbox') as HTMLInputElement;

        // Check if Alt was held on pointerup OR if it was tracked during dragging.
        const dragEndedWithAlt = ev.altKey || dragWasTimezoneLocked;

        if (dragEndedWithAlt && tzLabel && tzCheckbox) {
            // Show checkbox and check it by default.
            tzLabel.style.display = 'flex';
            tzCheckbox.checked = true;
        } else {
            // Hide checkbox
            if (tzLabel) tzLabel.style.display = 'none';

            // Standard resolution (if dragging without Alt, timezone is already resolved at coordinates)
            locationTimezone = resolveTimezone(lat, lon, null);
            dragState = 'confirming';
            rebuildEnv();
            scheduleFrame();
        }

        dragState = 'confirming';
        showKeepLocationDialog();
    });
}

/**
 * Compute the drag target lat/lon, applying shift-key axis lock.
 * When Shift is held, constrains to whichever axis (lat or lon) has the
 * larger absolute delta from the saved position.
 */
function computeDragLatLon(
    cssX: number, cssY: number, shiftKey: boolean,
): { lat: number; lon: number } {
    const raw = earthPixelToLatLon(cssX, cssY, layout);
    if (!shiftKey) {
        dragAxisLock = 'none';
        return raw;
    }
    // Choose axis based on the larger delta from saved position.
    const dLat = Math.abs(raw.lat - savedLat);
    const dLon = Math.abs(raw.lon - savedLon);
    dragAxisLock = dLat >= dLon ? 'lat' : 'lon';
    if (dragAxisLock === 'lat') {
        return { lat: raw.lat, lon: savedLon };
    } else {
        return { lat: savedLat, lon: raw.lon };
    }
}

// ---- Confirmation overlay ----

function showKeepLocationDialog(): void {
    const overlay = document.getElementById('map-drag-confirm');
    if (!overlay) return;

    // The modal is centered by CSS flexbox — no position calculation needed.
    overlay.style.display = '';
    // Trigger reflow before adding visible class for transition.
    void overlay.offsetHeight;
    overlay.classList.add('visible');

    // Keyboard handler: Enter = Keep, Escape = Revert.
    const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter') { e.preventDefault(); dismissKeepDialog(true); }
        else if (e.key === 'Escape') { e.preventDefault(); dismissKeepDialog(false); }
    };
    document.addEventListener('keydown', onKey, { capture: true });
    // Store the handler so dismissKeepDialog can remove it.
    (overlay as any)._keyHandler = onKey;

    // Wire buttons (idempotent — only bind once via the data attribute guard).
    const keepBtn = document.getElementById('map-drag-keep');
    const revertBtn = document.getElementById('map-drag-revert');
    if (keepBtn && !keepBtn.dataset.bound) {
        keepBtn.dataset.bound = '1';
        keepBtn.addEventListener('click', () => dismissKeepDialog(true));
    }
    if (revertBtn && !revertBtn.dataset.bound) {
        revertBtn.dataset.bound = '1';
        revertBtn.addEventListener('click', () => dismissKeepDialog(false));
    }
}

function dismissKeepDialog(keep: boolean): void {
    const overlay = document.getElementById('map-drag-confirm');
    if (overlay) {
        overlay.classList.remove('visible');
        overlay.style.display = 'none';
        const handler = (overlay as any)._keyHandler;
        if (handler) {
            document.removeEventListener('keydown', handler, { capture: true } as EventListenerOptions);
            (overlay as any)._keyHandler = null;
        }
    }

    const tzLabel = document.getElementById('map-drag-tz-label');
    const tzCheckbox = document.getElementById('map-drag-tz-checkbox') as HTMLInputElement;

    if (keep) {
        // If the timezone checkbox was displayed, read its state.
        if (tzLabel && tzLabel.style.display !== 'none' && tzCheckbox) {
            if (tzCheckbox.checked) {
                locationTimezone = resolveTimezone(lat, lon, null);
            } else {
                locationTimezone = savedTz;
            }
        }
        // Persist the new location.
        setState({ lat, lon, city: null, tz: locationTimezone || null });
        updateLocationDisplay();
        timeUI?.updateTimezoneDisplay();
        // Transition values back to normal scheduling and trigger redraw
        // so crosshairs disappear and the dot moves to the new position.
        rebuildEnv();
        updater?.reset();
        scheduleFrame();
    } else {
        // Revert to the saved location.
        lat = savedLat;
        lon = savedLon;
        locationTimezone = savedTz;
        rebuildEnv();
        updater?.reset();
        scheduleFrame();
        // Restore the city name (setState may have cleared it on a previous Keep;
        // if the user never kept, savedCity is still correct).
        if (savedCity !== getState().city) {
            setState({ city: savedCity });
        }
        updateLocationDisplay();
        timeUI?.updateTimezoneDisplay();
    }

    dragState = 'idle';
    canvas.style.cursor = '';
}

// ============================================================================
// Initialization
// ============================================================================

function init(): void {
    // Keep the DOM chrome rows and the canvas layout's reserved bands in sync.
    document.documentElement.style.setProperty('--obs-footer-h', `${FOOTER_H}px`);
    document.documentElement.style.setProperty('--obs-header-h', `${HEADER_H}px`);
    if (urlState.fps) document.body.classList.add('has-fps');

    initCanvas();
    ro.observe(document.documentElement);
    updateDynamicCompositeIcon(['thumb-observatory.png'], '#000000');
    setupLocationDialog();
    setupNoonToggle();
    setupMapDrag();
    updateLocationDisplay();

    // Help ("ℹ") popover — shared wiring; the General Help iframe drops the
    // Chronometer-only sections via the app=observatory param (see help.html).
    initHelpPopover({ generalHelpUrl: 'help.html?embed=1&app=observatory', app: 'observatory' });
    initShareButton({ getState });

    // --- Cross-app navigation (header icons + i/o/c/a) and page hotkeys ---
    // Key table: help.html#hotkeys.
    const flushTime = () => flushTimeState(timeController);
    initAppNavLinks(flushTime);
    registerAppNavHotkeys(flushTime);
    registerHotkey('h', () => document.getElementById('info-btn')?.click());
    registerHotkey('?', () => openGeneralHelpTopic('#hotkeys'));
    registerHotkey('t', () => document.getElementById('time-bar-label')?.click());
    registerHotkey('n', () => document.getElementById('time-bar-now')?.click());
    registerHotkey('l', () => document.getElementById('set-location-btn')?.click());

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
            document.getElementById('noon-icon')?.classList.toggle('noon', noonOnTop);
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
    // Also re-place the footer noon icon: a transport change shows/hides the red
    // offset label + Now button, changing where the icon must sit when the dial
    // reaches into the footer (A5). onTick fires on every transition + tick.
    timeController.onTick = () => { rebuildEnv(); positionNoonIcon(); };

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
            // Iteration 3: the popover is a pure overlay (it no longer reshapes
            // the layout), so just make sure the idle loop redraws.
            scheduleFrame();
        },
    });

    // Show time controller if URL says so
    if (urlState.tc) {
        timeUI?.showPopover();
    }

    // Place the noon icon once the time bar has laid out its contents (the
    // offset label / Now button appear when ?t/?off seed an overridden time).
    requestAnimationFrame(() => positionNoonIcon());

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

    // Listen for Alt key transitions during active map dragging to dynamically
    // lock or unlock the timezone display in real-time.
    window.addEventListener('keydown', (ev: KeyboardEvent) => {
        if (dragState === 'dragging' && ev.key === 'Alt') {
            if (!dragWasTimezoneLocked) {
                dragWasTimezoneLocked = true;
                applyTemporaryLocation(lat, lon, true);
            }
        }
    });

    window.addEventListener('keyup', (ev: KeyboardEvent) => {
        if (dragState === 'dragging' && ev.key === 'Alt') {
            if (dragWasTimezoneLocked) {
                dragWasTimezoneLocked = false;
                applyTemporaryLocation(lat, lon, false);
            }
        }
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
