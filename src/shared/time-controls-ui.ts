/**
 * Shared time controller UI module.
 *
 * Provides the glue between the time controller DOM (time-bar, time-popover)
 * and the app's animation system.  Follows the initLocationDialog() pattern:
 *   - Finds DOM elements by ID (injected via HTML partial)
 *   - Wires up all event handlers
 *   - Calls callbacks for app-specific actions
 *   - Returns an API for the consumer to update each frame
 *
 * Used by both Chronometer (engine-entry.ts) and Observatory (observatory-entry.ts).
 */

import { TimeController, TimeUnit, RATE_OPTIONS } from './time-controller.js';
import { computeAstroTarget } from './astro-stepper.js';
import type { AstroEventType } from './astro-stepper.js';
import {
    localComponentsFromTimeInterval, timeIntervalFromLocalComponents,
    kECJulianGregorianSwitchoverTimeInterval,
} from '../astronomy/es-calendar.js';
import {
    dateToDateInterval, dateIntervalToDate,
    MIN_DISPLAY_DATE_MS, MAX_DISPLAY_DATE_MS,
} from '../astronomy/es-time.js';
import { setState } from './app-state.js';

// ---------------------------------------------------------------------------
// Config & API interfaces
// ---------------------------------------------------------------------------

export interface TimeControlsConfig {
    timeController: TimeController;
    /** Current timezone Olson ID (may change on location change). */
    getTimezone: () => string | undefined;
    /** tzDeltaMs = delta between target tz and browser tz (milliseconds). */
    getTzDeltaMs: () => number;
    /** Observer latitude in degrees. */
    getLat: () => number;
    /** Observer longitude in degrees. */
    getLon: () => number;
    /** Currently selected body planet number (for body-* astro events). */
    getSelectedBody?: () => number | undefined;

    /**
     * The app's value updater. When supplied, the UI calls `updater.reset()`
     * after **every** time transition (scrub / step / now / transport) so the
     * app's values re-evaluate at the new time — the generic controller→updater
     * coupling. Apps driving values by hand (Chronometer's `HandState`) omit this
     * and do their own work in the callbacks below. When the updater also
     * exposes `anyAnimating()` (the shared Updater does), it doubles as the
     * default settle probe for the tap ghost — see `isSettled`.
     */
    updater?: { reset: () => void; anyAnimating?: () => boolean };

    /**
     * "Step animations have settled" probe for the tap ghost. After a step or
     * astro jump the ghosted popover is restored at the LATER of the dwell
     * and this returning true (bounded by a cap), so the change finishes
     * landing on screen before the popover re-covers it. Only consulted after
     * taps that stop the clock — a running 1× clock animates forever, so
     * transport/Now taps always use the plain dwell. Defaults to
     * `!updater.anyAnimating()` when `updater` provides it; omit both and the
     * ghost restores on the fixed dwell.
     */
    isSettled?: () => boolean;

    // ---- App-specific callbacks (all optional — for *custom* work only) ----
    // The generic parts (the controller action, `updater.reset()`,
    // `ensureSchedulerRunning`, `writeTimeState`) are handled by the UI; these
    // fire afterwards only when the app has extra logic to run.

    /** Called after a single step (button tap, date input, astro jump). */
    onTimeStep?: () => void;
    /** Called when hold-to-scrub starts. */
    onScrubStart?: () => void;
    /** Called when hold-to-scrub ends (UI has already stopped the clock). */
    onScrubEnd?: () => void;
    /** Called when "Now" resets to real time (UI has already reset the clock). */
    onNowClicked?: () => void;
    /** Called when play/pause/direction transport changes. */
    onTransportChange?: () => void;
    /** Kick the app's (idle) render loop. Required — the rAF loop is app-owned. */
    ensureSchedulerRunning: () => void;
    /**
     * Persist current time state. Optional — defaults to the shared
     * `flushTimeState(timeController)` (the `t`/`off`/`dir` fields, identical
     * across apps). Pass to override.
     */
    writeTimeState?: () => void;

    /**
     * Optional callback fired after show/hide so the consumer can relayout.
     * Called with the new popover open state.
     */
    onPopoverToggle?: (open: boolean) => void;
}

export interface TimeControlsAPI {
    /** Call every frame to update displayed time, rate, and transport. */
    updateTimeUI: () => void;
    showPopover: () => void;
    hidePopover: () => void;
    isPopoverOpen: () => boolean;
    /** Update timezone display (call after location change). */
    updateTimezoneDisplay: () => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Map step unit names to RATE_OPTIONS indices for hold-to-scrub. */
const unitToRateIndex: Record<string, number> = {
    'minute': 1,   // 10 min/s
    'hour':   2,   // 10 hr/s
    'day':    3,   // 10 day/s
    'month':  4,   // 10 mo/s
    'year':   5,   // 10 yr/s
};

/** Map data-step attributes to [unit, direction]. */
const stepMap: Record<string, [TimeUnit, 1 | -1]> = {
    '-year':   ['year',   -1],
    '-month':  ['month',  -1],
    '-day':    ['day',    -1],
    '-hour':   ['hour',   -1],
    '-minute': ['minute', -1],
    '+minute': ['minute',  1],
    '+hour':   ['hour',    1],
    '+day':    ['day',     1],
    '+month':  ['month',   1],
    '+year':   ['year',    1],
};

/**
 * Initialize the shared time controller UI.
 *
 * Looks up DOM elements by ID (must already exist) and wires all handlers.
 * Returns an API for the consumer, or null if required DOM elements are missing.
 */
/**
 * Default time-state persistence: writes the `t` / `off` / `dir` fields from
 * the controller state to the **active backend** via `setState` — localStorage
 * (`ec:shared`) in persistent mode, the URL only in the file:///session
 * fallbacks. Identical across apps, so it's the default `writeTimeState` —
 * the time fields are the controller's domain (broader state is each app's
 * own business). Exported for reuse / testing.
 */
export function flushTimeState(tc: TimeController): void {
    if (tc.isRealTime) {
        setState({ t: null, off: null, dir: 1 });
    } else if (!tc.isStopped && tc.currentRate === null && tc.currentDirection === 1) {
        setState({ off: tc.timeOffset, t: null, dir: 1 });
    } else {
        const dir = tc.isStopped ? 0 : tc.currentDirection;
        setState({ t: tc.getDisplayTime().getTime(), off: null, dir: dir as 0 | 1 | -1 });
    }
}

export function initTimeControls(config: TimeControlsConfig): TimeControlsAPI | null {
    const {
        timeController,
        getTimezone,
        getTzDeltaMs,
        getLat,
        getLon,
        getSelectedBody,
        updater,
        onTimeStep = () => {},
        onScrubStart = () => {},
        onScrubEnd = () => {},
        onNowClicked = () => {},
        onTransportChange = () => {},
        ensureSchedulerRunning,
        writeTimeState = () => flushTimeState(timeController),
        onPopoverToggle,
    } = config;

    // Settle probe for the tap ghost: explicit config wins, else derive from
    // the updater's anyAnimating() (arrow wrapper preserves `this`).
    const settledProbe = config.isSettled ??
        (updater?.anyAnimating ? () => !updater.anyAnimating!() : undefined);

    // ---- Required DOM elements ----
    const _timeBar = document.getElementById('time-bar');
    const _timeBarLabel = document.getElementById('time-bar-label');
    const _timeBarDate = document.getElementById('time-bar-date');
    const _timeBarOffset = document.getElementById('time-bar-offset');
    const _timeBarRate = document.getElementById('time-bar-rate');
    const _timeBarNow = document.getElementById('time-bar-now');
    const _timePopover = document.getElementById('time-popover');
    const _tpRateLabel = document.getElementById('tp-rate-label');
    const _tpTransport = document.getElementById('tp-transport');
    const _tpClose = document.getElementById('tp-close');

    if (!_timeBar || !_timeBarLabel || !_timeBarDate || !_timeBarOffset ||
        !_timeBarRate || !_timeBarNow || !_timePopover || !_tpRateLabel ||
        !_tpTransport || !_tpClose) {
        console.warn('[TimeControlsUI] Required DOM elements not found');
        return null;
    }

    // Re-bind with narrowed types (TS closures don't narrow from the combined guard above)
    const timeBar = _timeBar;
    const timeBarLabel = _timeBarLabel;
    const timeBarDate = _timeBarDate;
    const timeBarOffset = _timeBarOffset;
    const timeBarRate = _timeBarRate;
    const timeBarNow = _timeBarNow;
    const timePopover = _timePopover;
    const tpRateLabel = _tpRateLabel;
    const tpTransport = _tpTransport;
    const tpClose = _tpClose;

    // ---- Optional DOM elements for timezone display ----
    const locationTzLabel = document.getElementById('location-tz');
    const lpLocationTz = document.getElementById('lp-location-tz');

    // ---- State ----
    let popoverOpen = false;

    // ===================================================================
    // Formatting helpers
    // ===================================================================

    /** Shift a Date to the target timezone for display purposes. */
    function toTzDate(d: Date): Date {
        const delta = getTzDeltaMs();
        return delta !== 0 ? new Date(d.getTime() + delta) : d;
    }

    /** Convert a Date entered in target-timezone values back to a real UTC instant. */
    function fromTzDate(d: Date): Date {
        const delta = getTzDeltaMs();
        return delta !== 0 ? new Date(d.getTime() - delta) : d;
    }

    /**
     * Get the actual UTC offset (east-positive, in seconds) of the target timezone
     * at a given instant.  This is what localComponentsFromTimeInterval expects.
     */
    function targetTzOffsetSec(d: Date): number {
        return -d.getTimezoneOffset() * 60 + getTzDeltaMs() / 1000;
    }

    function formatSimTime(d: Date): string {
        const di = dateToDateInterval(d);
        const cs = localComponentsFromTimeInterval(di, targetTzOffsetSec(d));
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const mo = months[cs.month - 1] || 'Jan';
        const h = cs.hour.toString().padStart(2, '0');
        const m = cs.minute.toString().padStart(2, '0');
        const s = Math.floor(cs.seconds).toString().padStart(2, '0');
        let suffix = '';
        if (cs.era === 0) {
            suffix = ' BCE';
        }
        if (di < kECJulianGregorianSwitchoverTimeInterval) {
            suffix += ' (Julian)';
        }
        const ms = d.getTime();
        if (ms <= MIN_DISPLAY_DATE_MS) {
            suffix += ' — AT LIMIT';
        } else if (ms >= MAX_DISPLAY_DATE_MS) {
            suffix += ' — AT LIMIT';
        }
        return `${mo} ${cs.day}, ${cs.year}${suffix}  ${h}:${m}:${s}`;
    }

    /** Format the difference between sim and real time as a human-readable string.
     *  Uses calendar-based differencing for years and months. */
    function formatOffset(sim: Date, real: Date): string {
        const ms = sim.getTime() - real.getTime();
        const sign = ms < 0 ? '-' : '+';
        if (Math.abs(ms) < 2000) return '';

        // Use hybrid calendar decomposition for year/month differencing
        const fromMs = (ms < 0 ? sim : real).getTime();
        const toMs   = (ms < 0 ? real : sim).getTime();
        const from = new Date(Math.floor(fromMs / 1000) * 1000);
        const to   = new Date(Math.floor(toMs / 1000) * 1000);

        const fromDI = dateToDateInterval(from);
        const toDI = dateToDateInterval(to);
        const fromCs = localComponentsFromTimeInterval(fromDI, 0);
        const toCs = localComponentsFromTimeInterval(toDI, 0);

        // Calendar difference: years, months
        const fromSigned = fromCs.era === 0 ? -fromCs.year : fromCs.year;
        const toSigned = toCs.era === 0 ? -toCs.year : toCs.year;
        let years = toSigned - fromSigned;
        let months = toCs.month - fromCs.month;
        if (months < 0) { years--; months += 12; }

        // Estimate cursor after year+month offset, then compute remaining seconds
        let cursorDI = fromDI;
        if (years > 0 || months > 0) {
            let cursorSigned = fromSigned + years;
            let cursorMonth = fromCs.month + months;
            if (cursorMonth > 12) { cursorSigned++; cursorMonth -= 12; }
            const cursorEra = cursorSigned <= 0 ? 0 : 1;
            const cursorYear = cursorSigned <= 0 ? 1 - cursorSigned : cursorSigned;
            cursorDI = timeIntervalFromLocalComponents(
                0, cursorEra, cursorYear, cursorMonth, fromCs.day,
                fromCs.hour, fromCs.minute, fromCs.seconds,
            );
            if (cursorDI > toDI) {
                months--;
                if (months < 0) { years--; months += 12; }
                cursorSigned = fromSigned + years;
                cursorMonth = fromCs.month + months;
                if (cursorMonth > 12) { cursorSigned++; cursorMonth -= 12; }
                if (cursorMonth < 1) { cursorSigned--; cursorMonth += 12; }
                const ce = cursorSigned <= 0 ? 0 : 1;
                const cy = cursorSigned <= 0 ? 1 - cursorSigned : cursorSigned;
                cursorDI = timeIntervalFromLocalComponents(
                    0, ce, cy, cursorMonth, fromCs.day,
                    fromCs.hour, fromCs.minute, fromCs.seconds,
                );
            }
        }

        let remainSec = Math.round(toDI - cursorDI);

        let days: number, hrs: number, mins: number, sec: number;
        if (years > 0 || months > 0) {
            remainSec = Math.round(remainSec / 3600) * 3600;
            days = Math.floor(remainSec / 86400); remainSec %= 86400;
            hrs  = Math.floor(remainSec / 3600);
            mins = 0; sec = 0;
        } else if (remainSec >= 86400) {
            remainSec = Math.round(remainSec / 60) * 60;
            days = Math.floor(remainSec / 86400); remainSec %= 86400;
            hrs  = Math.floor(remainSec / 3600);  remainSec %= 3600;
            mins = Math.floor(remainSec / 60);
            sec  = 0;
        } else {
            days = 0;
            hrs  = Math.floor(remainSec / 3600);  remainSec %= 3600;
            mins = Math.floor(remainSec / 60);     remainSec %= 60;
            sec  = remainSec;
        }

        if (hrs >= 24) { days += Math.floor(hrs / 24); hrs %= 24; }

        const parts = [];
        if (years > 0)  parts.push(`${years}y`);
        if (months > 0) parts.push(`${months}mo`);
        if (days > 0)   parts.push(`${days}d`);
        if (hrs > 0)    parts.push(`${hrs}h`);
        if (mins > 0)   parts.push(`${mins}m`);
        if (sec > 0)    parts.push(`${sec}s`);
        return parts.length > 0 ? `(${sign}${parts.join(' ')})` : '';
    }

    /** Format the current timezone for display.
     *  Output: "America/Los_Angeles\u00a0(PDT)\u00a0UTC-7:00" */
    function formatTimezoneDisplay(olsonId: string | undefined, referenceDate?: Date): string {
        if (!olsonId) return '';
        try {
            const ref = referenceDate || new Date();
            const shortFmt = new Intl.DateTimeFormat('en-US', {
                timeZone: olsonId,
                timeZoneName: 'short',
            });
            const shortParts = shortFmt.formatToParts(ref);
            const abbr = shortParts.find(p => p.type === 'timeZoneName')?.value || '';

            const longFmt = new Intl.DateTimeFormat('en-US', {
                timeZone: olsonId,
                timeZoneName: 'longOffset',
            });
            const longParts = longFmt.formatToParts(ref);
            const offsetStr = longParts.find(p => p.type === 'timeZoneName')?.value || '';
            let utcStr = offsetStr.replace('GMT', 'UTC');
            utcStr = utcStr.replace(/([+-])0(\d)/, '$1$2');

            return `${olsonId}\u00a0(${abbr})\u00a0${utcStr}`;
        } catch {
            return olsonId;
        }
    }

    // ===================================================================
    // Transport (play/pause/direction buttons)
    // ===================================================================

    // Track transport state to avoid rebuilding buttons every frame
    // (rebuilding destroys event listeners, causing click events to be lost).
    // Initialized to null (not the real-time defaults) so the FIRST render always
    // builds the buttons — otherwise the initial 1×-forward state (isReal=true,
    // isStopped=false) matches the cache and the pause button is never created.
    let _lastTransportReal: boolean | null = null;
    let _lastTransportStopped: boolean | null = null;

    function renderTransport() {
        const isReal = timeController.isRealTime;
        const isStopped = timeController.isStopped;

        // Skip rebuild if the button configuration hasn't changed
        if (isReal === _lastTransportReal && isStopped === _lastTransportStopped) {
            return;
        }
        _lastTransportReal = isReal;
        _lastTransportStopped = isStopped;

        tpTransport.innerHTML = '';

        // Top row: Now▶ (when overridden) and/or ‖ (when running)
        const topRow = document.createElement('div');
        topRow.className = 'tp-transport-row';

        if (!timeController.isRealTime) {
            const nowBtn = document.createElement('button');
            nowBtn.className = 'tp-btn';
            nowBtn.innerHTML = 'Now\u2009<span style="position:relative;top:1px">▶</span>';
            nowBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                nowClicked();
            });
            topRow.appendChild(nowBtn);
        }

        if (!isStopped) {
            const pauseBtn = document.createElement('button');
            pauseBtn.className = 'tp-btn active';
            pauseBtn.textContent = '‖';
            pauseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                ghostTap();
                timeController.stop();
                updater?.reset();
                onTransportChange();
                updateTimeUI();
                ensureSchedulerRunning();
                writeTimeState();
            });
            topRow.appendChild(pauseBtn);
        }

        if (topRow.childNodes.length > 0) {
            tpTransport.appendChild(topRow);
        }

        // Bottom row: ◀ ▶ direction buttons (only when stopped)
        if (isStopped) {
            const bottomRow = document.createElement('div');
            bottomRow.className = 'tp-transport-row';

            const revBtn = document.createElement('button');
            revBtn.className = 'tp-btn';
            revBtn.textContent = '◀';
            revBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                ghostTap();
                timeController.setDirection(-1);
                timeController.setRate(null);
                updater?.reset();
                onTransportChange();
                updateTimeUI();
                ensureSchedulerRunning();
                writeTimeState();
            });

            const fwdBtn = document.createElement('button');
            fwdBtn.className = 'tp-btn';
            fwdBtn.textContent = '▶';
            fwdBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                ghostTap();
                timeController.setDirection(1);
                timeController.setRate(null);
                updater?.reset();
                onTransportChange();
                updateTimeUI();
                ensureSchedulerRunning();
                writeTimeState();
            });

            bottomRow.appendChild(revBtn);
            bottomRow.appendChild(fwdBtn);
            tpTransport.appendChild(bottomRow);
        }
    }

    // ===================================================================
    // Update UI
    // ===================================================================

    function updateTimeUI() {
        const isReal = timeController.isRealTime;

        // Toggle overridden class to show/hide offset, rate, "Now" button
        timeBar.classList.toggle('overridden', !isReal);

        // Always update the displayed time
        const sim = timeController.getDisplayTime();
        timeBarDate.textContent = formatSimTime(sim);

        // Toggle at-limit class for boundary indicator
        const simMs = sim.getTime();
        const atLimit = simMs <= MIN_DISPLAY_DATE_MS || simMs >= MAX_DISPLAY_DATE_MS;
        timeBar.classList.toggle('at-limit', atLimit);

        if (!isReal) {
            timeBarRate.textContent = timeController.statusLabel;
            // During a map-drag display hold the sim time is frozen while real
            // time flows, so the live offset would drift; explain instead.
            timeBarOffset.textContent = timeController.isHeld
                ? 'Hold for location change'
                : formatOffset(sim, new Date());
        }
        tpRateLabel.textContent = timeController.statusLabel;

        // Rebuild transport bar
        renderTransport();

        // Update timezone display in case DST state changed
        updateTimezoneDisplay();

        // Populate date inputs with current sim time (hybrid calendar)
        const simDI = dateToDateInterval(sim);
        const simCs = localComponentsFromTimeInterval(simDI, targetTzOffsetSec(sim));
        const yearEl = document.getElementById('tp-year') as HTMLInputElement | null;
        const monthEl = document.getElementById('tp-month') as HTMLInputElement | null;
        const dayEl = document.getElementById('tp-day') as HTMLInputElement | null;
        const hourEl = document.getElementById('tp-hour') as HTMLInputElement | null;
        const minuteEl = document.getElementById('tp-minute') as HTMLInputElement | null;
        // Don't clobber the field the user is currently editing — otherwise a
        // running clock (which calls updateTimeUI every frame) overwrites each
        // keystroke. The auto-apply listeners keep the time in sync as they type.
        const active = document.activeElement;
        if (yearEl && active !== yearEl) yearEl.value = simCs.year.toString();
        if (monthEl && active !== monthEl) monthEl.value = simCs.month.toString();
        if (dayEl && active !== dayEl) dayEl.value = simCs.day.toString();
        if (hourEl && active !== hourEl) hourEl.value = simCs.hour.toString();
        if (minuteEl && active !== minuteEl) minuteEl.value = simCs.minute.toString();

        // Update BCE toggle state
        const bceBtn = document.getElementById('tp-bce');
        if (bceBtn) {
            const isBCE = simCs.era === 0;
            bceBtn.textContent = isBCE ? 'BCE' : 'CE';
            bceBtn.classList.toggle('active', isBCE);
        }
    }

    function updateTimezoneDisplay() {
        const formatted = formatTimezoneDisplay(
            getTimezone(),
            timeController.getDisplayTime(),
        );
        if (locationTzLabel) locationTzLabel.innerHTML = formatted;
        if (lpLocationTz) lpLocationTz.innerHTML = formatted;
    }

    // ===================================================================
    // Popover show/hide
    // ===================================================================

    function showPopover() {
        popoverOpen = true;
        timePopover.style.display = '';
        // Stale-ghost guard: a force-close mid-hold (e.g. Escape) can skip
        // endHold(), leaving the scrub ghost class behind; a close within the
        // tap-ghost dwell similarly strands .tp-ghost until its timer fires.
        timePopover.classList.remove('tp-hidden', 'tp-ghost');
        timeBarLabel.textContent = '⏱ Hide time controller';
        timeBarLabel.classList.add('active');
        updateTimeUI();
        setState({ tc: true });
        onPopoverToggle?.(true);
    }

    function hidePopover() {
        popoverOpen = false;
        timePopover.style.display = 'none';
        timeBarLabel.textContent = '⏱ Show time controller';
        timeBarLabel.classList.remove('active');
        updateTimeUI();
        setState({ tc: false });
        onPopoverToggle?.(false);
    }

    // ===================================================================
    // Now clicked (shared by time-bar "Now" button + transport "Now▶")
    // ===================================================================

    function nowClicked() {
        ghostTap();
        timeController.reset();    // generic controller action (was delegated to clients)
        updater?.reset();
        onNowClicked();
        updateTimeUI();
        ensureSchedulerRunning();  // restart an idle render loop (e.g. Inspector/Observatory)
        writeTimeState();
    }

    // ===================================================================
    // Hold-to-scrub
    // ===================================================================

    const HOLD_DELAY_MS = 300;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let holdingBtn: HTMLElement | null = null;

    function startHold(btn: HTMLElement, unit: string, dir: 1 | -1) {
        holdingBtn = btn;
        btn.classList.add('holding');
        // Ghost the popover so the app is visible while scrubbing. Opacity-only
        // (see .tp-hidden in the CSS): the held button must keep hit-testing.
        timePopover.classList.add('tp-hidden');

        // Set direction and start the corresponding rate
        timeController.setDirection(dir);
        const rateIdx = unitToRateIndex[unit];
        if (rateIdx !== undefined) {
            timeController.setRate(RATE_OPTIONS[rateIdx]);
        }
        updater?.reset();
        onScrubStart();
        updateTimeUI();
        ensureSchedulerRunning();
    }

    function endHold() {
        if (holdTimer !== null) {
            clearTimeout(holdTimer);
            holdTimer = null;
        }
        if (holdingBtn) {
            holdingBtn.classList.remove('holding');
            holdingBtn = null;
            // Release always restores immediately (hold = ghosted, release =
            // restored): clear the initiating tap's ghost too — its settle-wait
            // would otherwise keep short holds ghosted after release.
            timePopover.classList.remove('tp-hidden', 'tp-ghost');
            if (ghostTimer !== null) {
                clearTimeout(ghostTimer);
                ghostTimer = null;
            }

            // Stop at the current position (generic — was delegated to clients),
            // then let the app run any custom snap/finish logic.
            timeController.stop();
            updater?.reset();
            onScrubEnd();
            updateTimeUI();
            ensureSchedulerRunning();
            writeTimeState();
        }
    }

    // ===================================================================
    // Tap ghosting
    // ===================================================================

    const GHOST_DWELL_MS = 1000;
    const GHOST_SETTLE_POLL_MS = 200;
    const GHOST_SETTLE_CAP_MS = 4000;
    let ghostTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Ghost the popover briefly after an actuating tap (step / astro jump /
     * transport / Now) so the app is visible while the change lands. The
     * dwell timer restarts on every tap, so repeated taps keep it ghosted.
     * With `waitSettle` (step/astro taps — the clock is stopped afterwards),
     * restore waits for the app's animations to finish landing: the later of
     * the dwell and the settle probe, bounded by a cap so a stuck probe can't
     * strand the ghost. Opacity-only, same constraint as the scrub ghost.
     */
    function ghostTap(waitSettle = false) {
        if (!popoverOpen) return;
        timePopover.classList.add('tp-ghost');
        if (ghostTimer !== null) clearTimeout(ghostTimer);
        const deadline = Date.now() + GHOST_SETTLE_CAP_MS;
        const expire = () => {
            if (waitSettle && settledProbe && !settledProbe() &&
                Date.now() < deadline) {
                ghostTimer = setTimeout(expire, GHOST_SETTLE_POLL_MS);
                return;
            }
            ghostTimer = null;
            timePopover.classList.remove('tp-ghost');
        };
        ghostTimer = setTimeout(expire, GHOST_DWELL_MS);
    }

    // ===================================================================
    // Step button wiring
    // ===================================================================

    timePopover.querySelectorAll('[data-step]').forEach(btn => {
        const el = btn as HTMLElement;
        const stepKey = el.dataset.step!;
        const entry = stepMap[stepKey];
        if (!entry) return;
        const [unit, dir] = entry;
        const unitName = el.dataset.unit || unit;

        function doStep(e: Event) {
            e.preventDefault();
            e.stopPropagation();
            ghostTap(true);
            // Stop time and snap in-flight animations before stepping
            timeController.stop();
            timeController.step(unit, dir);
            updater?.reset();
            onTimeStep();
            updateTimeUI();
            ensureSchedulerRunning();
            // Start hold timer
            holdTimer = setTimeout(() => {
                holdTimer = null;
                startHold(el, unitName, dir);
            }, HOLD_DELAY_MS);
        }

        function doRelease(e: Event) {
            e.stopPropagation();
            endHold();
            writeTimeState();
        }

        // Mouse events
        el.addEventListener('mousedown', doStep);
        el.addEventListener('mouseup', doRelease);
        el.addEventListener('mouseleave', () => endHold());

        // Touch events
        el.addEventListener('touchstart', doStep);
        el.addEventListener('touchend', doRelease);
        el.addEventListener('touchcancel', () => endHold());
    });

    // ===================================================================
    // Tab switching: Date / Astro
    // ===================================================================

    const tpTabDate = document.getElementById('tp-tab-date');
    const tpTabAstro = document.getElementById('tp-tab-astro');
    const tpTabs = timePopover.querySelectorAll('.tp-tab');

    function switchTab(tabName: 'd' | 'a') {
        if (tpTabDate && tpTabAstro) {
            const hiding = tabName === 'a' ? tpTabDate : tpTabAstro;
            const showing = tabName === 'a' ? tpTabAstro : tpTabDate;

            // Collapse the outgoing pane instantly (no transition)
            hiding.style.transition = 'none';
            hiding.classList.add('tp-pane-hidden');
            // Force reflow so the instant collapse takes effect
            void hiding.offsetHeight;
            hiding.style.transition = '';

            // Animate the incoming pane open
            showing.classList.remove('tp-pane-hidden');
        }
        tpTabs.forEach(btn => {
            const el = btn as HTMLElement;
            el.classList.toggle('active', el.dataset.tab === (tabName === 'a' ? 'astro' : 'date'));
        });
        setState({ tp: tabName });
    }

    // Initialize tab from URL state
    const urlTp = new URLSearchParams(window.location.search).get('tp');
    if (urlTp === 'a') {
        switchTab('a');
    }

    tpTabs.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const el = btn as HTMLElement;
            switchTab(el.dataset.tab === 'astro' ? 'a' : 'd');
        });
    });

    // ===================================================================
    // Astronomical event stepper
    // ===================================================================

    function handleAstroStep(eventType: AstroEventType, dir: 1 | -1, btnEl: HTMLElement) {
        // Determine the body planet number for body-* events
        let bodyPlanetNumber: number | undefined;
        if (eventType === 'body-transit' || eventType === 'body-rise' || eventType === 'body-set') {
            bodyPlanetNumber = getSelectedBody?.();
            // Fall back to label data attribute if no callback
            if (bodyPlanetNumber === undefined) {
                const bodyLabel = document.getElementById('tp-body-transit-label');
                bodyPlanetNumber = bodyLabel ? parseInt(bodyLabel.dataset.planet || '1', 10) : undefined;
            }
        }

        const targetDate = computeAstroTarget(
            eventType, dir, timeController.getDisplayTime(),
            getLat() * Math.PI / 180, getLon() * Math.PI / 180, bodyPlanetNumber,
        );

        if (!targetDate || isNaN(targetDate.getTime())) {
            // No event found — flash the button. Deliberately no ghostTap():
            // the flash is on the popover and must stay readable.
            btnEl.classList.add('flash-fail');
            setTimeout(() => btnEl.classList.remove('flash-fail'), 300);
            return;
        }

        // Same as single-tap time step:
        ghostTap(true);
        timeController.stop();
        timeController.setTime(targetDate);
        updater?.reset();
        onTimeStep();
        updateTimeUI();
        ensureSchedulerRunning();
        writeTimeState();
    }

    timePopover.querySelectorAll('[data-astro]').forEach(btn => {
        const el = btn as HTMLElement;
        const eventType = el.dataset.astro as AstroEventType;
        const dir = parseInt(el.dataset.dir || '1', 10) as 1 | -1;

        // Mouse events (no hold timer — tap only)
        el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleAstroStep(eventType, dir, el);
        });

        // Touch events
        el.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleAstroStep(eventType, dir, el);
        });
    });

    // ===================================================================
    // Date inputs + BCE toggle
    // ===================================================================

    function applyDateInputs() {
        const yr = parseInt((document.getElementById('tp-year') as HTMLInputElement).value, 10);
        const mo = parseInt((document.getElementById('tp-month') as HTMLInputElement).value, 10);
        const dy = parseInt((document.getElementById('tp-day') as HTMLInputElement).value, 10);
        const hr = parseInt((document.getElementById('tp-hour') as HTMLInputElement).value, 10);
        const mn = parseInt((document.getElementById('tp-minute') as HTMLInputElement).value, 10);
        if (isNaN(yr) || isNaN(mo) || isNaN(dy) || isNaN(hr) || isNaN(mn)) return;

        // Read BCE toggle state
        const bceBtn = document.getElementById('tp-bce');
        const isBCE = bceBtn?.classList.contains('active') ?? false;
        const era = isBCE ? 0 : 1;

        // Use hybrid calendar to construct the time interval
        const refDate = timeController.getDisplayTime();
        const tzOff = targetTzOffsetSec(refDate);
        const di = timeIntervalFromLocalComponents(tzOff, era, yr, mo, dy, hr, mn, 0);
        const d = dateIntervalToDate(di);
        // Clamp to supported astronomical range (4000 BCE – 2800 CE)
        const clampedMs = Math.max(MIN_DISPLAY_DATE_MS,
                                   Math.min(MAX_DISPLAY_DATE_MS, d.getTime()));
        timeController.setTime(clampedMs !== d.getTime() ? new Date(clampedMs) : d);
        updater?.reset();
        onTimeStep();
        updateTimeUI();
        ensureSchedulerRunning();  // restart an idle render loop (e.g. Inspector/Observatory)
        writeTimeState();
    }

    // Auto-apply when any date/time input changes
    ['tp-year', 'tp-month', 'tp-day', 'tp-hour', 'tp-minute'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', () => applyDateInputs());
        }
    });

    // BCE toggle
    const tpBce = document.getElementById('tp-bce');
    if (tpBce) {
        tpBce.addEventListener('click', (e) => {
            e.stopPropagation();
            const isActive = tpBce.classList.toggle('active');
            tpBce.textContent = isActive ? 'BCE' : 'CE';
            applyDateInputs();
        });
    }

    // ===================================================================
    // Button wiring
    // ===================================================================

    // "Show/Hide time controller" label
    timeBarLabel.addEventListener('click', (e) => {
        e.stopPropagation();
        if (popoverOpen) {
            hidePopover();
        } else {
            showPopover();
        }
    });

    // Rate label click (opens popover when overridden)
    timeBarRate.addEventListener('click', (e) => {
        e.stopPropagation();
        if (popoverOpen) {
            hidePopover();
        } else {
            showPopover();
        }
    });

    // "Now" reset button (time-bar version)
    timeBarNow.addEventListener('click', (e) => {
        e.stopPropagation();
        nowClicked();
    });

    // Close button in popover
    tpClose.addEventListener('click', (e) => {
        e.stopPropagation();
        hidePopover();
    });

    // ===================================================================
    // Initial state
    // ===================================================================

    updateTimezoneDisplay();
    updateTimeUI();

    // ===================================================================
    // Return API
    // ===================================================================

    return {
        updateTimeUI,
        showPopover,
        hidePopover,
        isPopoverOpen: () => popoverOpen,
        updateTimezoneDisplay,
    };
}
