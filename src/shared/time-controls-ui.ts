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
 * Used by Chronometer (engine-entry.ts), Observatory (observatory-entry.ts)
 * and the Inspector (inspector-entry.ts).
 *
 * The panel (docs/time-controller.md; partials/time-controller.html): unit
 * first, then one pair. A row of chips chooses what a step means — a calendar
 * unit (yr … sec) or an astronomical event (rise / set / transit of a chosen
 * body, or the Moon's quarter phase) — and one big ◀ ▶ pair steps (tap) or
 * scrubs (hold) by it. The pair's label always names the unit, so the mode
 * is never hidden. The controller's body is decoupled from the page's
 * (parent plan §7.3): it defaults to the page's body where the page has one
 * (`getSelectedBody`), else the Moon, until the user steps it. The unit
 * (`tu`) and body (`tb`) persist per app through app-state.
 *
 * The panel fades only while a scrub runs — never on a tap (the two stories,
 * docs/time-controller.md): stepping to a target takes several taps and each
 * needs the panel where it was. A scrub whose release lands off the button at
 * the display's edge keeps running hands-free until the next press anywhere.
 */

import { TimeController, TimeUnit, RATE_OPTIONS } from './time-controller.js';
import { computeAstroTarget } from './astro-stepper.js';
import type { AstroEventType } from './astro-stepper.js';
import { tzOffsetSecondsAt } from './astro-env.js';
import {
    localComponentsFromTimeInterval, timeIntervalFromLocalComponents,
    kECJulianGregorianSwitchoverTimeInterval,
} from '../astronomy/es-calendar.js';
import {
    dateToDateInterval, dateIntervalToDate,
    MIN_DISPLAY_DATE_MS, MAX_DISPLAY_DATE_MS,
} from '../astronomy/es-time.js';
import { getState, setState } from './app-state.js';
import type { TimeStepUnit, ControllerBody } from './url-state.js';

// ---------------------------------------------------------------------------
// Units and bodies
// ---------------------------------------------------------------------------

/** An astronomical-event step kind (the astro chips). */
export type AstroStepKind = 'rise' | 'set' | 'transit' | 'phase';

export interface UnitSpec {
    key: TimeStepUnit;
    /** The pair's label for calendar units ("1 day"); astro labels are built from the body. */
    label: string;
    /** Calendar units: the TimeController unit and the RATE_OPTIONS index hold-to-scrub uses. */
    time?: TimeUnit;
    rateIndex?: number;
    /** Astro units: the event kind (tap only — each jump is a search). */
    astro?: AstroStepKind;
}

/** The chips, in display order (two rows of five; docs/time-controller.md). */
export const UNITS: readonly UnitSpec[] = [
    { key: 'yr',  label: '1 year',   time: 'year',   rateIndex: 5 },
    { key: 'mo',  label: '1 month',  time: 'month',  rateIndex: 4 },
    { key: 'day', label: '1 day',    time: 'day',    rateIndex: 3 },
    { key: 'hr',  label: '1 hour',   time: 'hour',   rateIndex: 2 },
    { key: 'min', label: '1 minute', time: 'minute', rateIndex: 1 },
    { key: 'sec', label: '1 second', time: 'second', rateIndex: 0 },
    { key: 'rise',    label: 'rise',       astro: 'rise' },
    { key: 'set',     label: 'set',        astro: 'set' },
    { key: 'transit', label: 'transit',    astro: 'transit' },
    { key: 'phase',   label: 'Moon phase', astro: 'phase' },
];

export interface BodySpec {
    key: ControllerBody;
    name: string;
    /** ECPlanetNumber. */
    planet: number;
}

/** The bodies the stepper cycles, in Venezia's order. */
export const CONTROLLER_BODIES: readonly BodySpec[] = [
    { key: 'sun',     name: 'Sun',     planet: 0 },
    { key: 'moon',    name: 'Moon',    planet: 1 },
    { key: 'mercury', name: 'Mercury', planet: 2 },
    { key: 'venus',   name: 'Venus',   planet: 3 },
    { key: 'mars',    name: 'Mars',    planet: 5 },
    { key: 'jupiter', name: 'Jupiter', planet: 6 },
    { key: 'saturn',  name: 'Saturn',  planet: 7 },
    { key: 'uranus',  name: 'Uranus',  planet: 8 },
    { key: 'neptune', name: 'Neptune', planet: 9 },
];
const MOON = CONTROLLER_BODIES[1];

/** The pair's label for an astro unit: "Sunrise", "Moon transit", "Jupiter set", "Moon phase". */
export function astroStepLabel(kind: AstroStepKind, body: BodySpec): string {
    if (kind === 'phase') return 'Moon phase';
    if (kind === 'transit') return `${body.name} transit`;
    if (body.key === 'sun' || body.key === 'moon') return body.name + kind;   // Sunrise, Moonset
    return `${body.name} ${kind}`;
}

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
    /**
     * The *page's* body as an ECPlanetNumber (Venezia's face body, the
     * Observatory's dial body) — the controller body's default until the
     * user steps the ‹ › body row; omit where the page has none (the Moon).
     */
    getSelectedBody?: () => number | undefined;

    /**
     * The app's value updater. When supplied, the UI calls `updater.reset()`
     * after **every** time transition (scrub / step / now / transport) so the
     * app's values re-evaluate at the new time — the generic controller→updater
     * coupling. Apps driving values by hand (Chronometer's `HandState`) omit this
     * and do their own work in the callbacks below.
     */
    updater?: { reset: () => void };

    /**
     * Escape closes the popover, last in the page's overlay hierarchy. When
     * supplied, the UI installs a window capture-phase Escape listener that
     * closes the popover only while this returns false — no other overlay
     * (dialog, menu, fullscreen) is up to take the key first. Capture phase,
     * because the other overlays close themselves on the same keydown without
     * stopping it, so the decision must be made on the pre-close state. Pages
     * that run their own Escape ladder (Chronometer) omit it. Independent of
     * this, Escape always stops a hands-free scrub.
     */
    escapeYields?: () => boolean;

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
    /** The selected step unit (the chip). */
    getUnit: () => TimeStepUnit;
    /** The controller's body for rise / set / transit (stored, or the page's, or the Moon). */
    getBody: () => BodySpec;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

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
        escapeYields,
    } = config;

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
    const _tpUnits = document.getElementById('tp-units');
    const _tpBodyRow = document.getElementById('tp-body-row');
    const _tpBodyName = document.getElementById('tp-body-name');
    const _tpStepLabel = document.getElementById('tp-step-label');

    if (!_timeBar || !_timeBarLabel || !_timeBarDate || !_timeBarOffset ||
        !_timeBarRate || !_timeBarNow || !_timePopover || !_tpRateLabel ||
        !_tpTransport || !_tpClose || !_tpUnits || !_tpBodyRow || !_tpBodyName || !_tpStepLabel) {
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
    const tpUnits = _tpUnits;
    const tpBodyRow = _tpBodyRow;
    const tpBodyName = _tpBodyName;
    const tpStepLabel = _tpStepLabel;

    // ---- Optional DOM elements for timezone display ----
    const locationTzLabel = document.getElementById('location-tz');
    const lpLocationTz = document.getElementById('lp-location-tz');

    // ---- State ----
    let popoverOpen = false;

    /** The selected chip; from the per-app `tu` setting (default day). */
    let unit: UnitSpec = UNITS.find((u) => u.key === getState().tu) ?? UNITS[2];
    /** The user's body choice (`tb`), or null = follow the page's body, else the Moon. */
    let bodyKey: ControllerBody | null = getState().tb;

    function bodyByKey(key: ControllerBody | null): BodySpec | undefined {
        return key ? CONTROLLER_BODIES.find((b) => b.key === key) : undefined;
    }

    /** The controller's body: stored, else the page's (getSelectedBody), else the Moon. */
    function currentBody(): BodySpec {
        const stored = bodyByKey(bodyKey);
        if (stored) return stored;
        const page = getSelectedBody?.();
        return CONTROLLER_BODIES.find((b) => b.planet === page) ?? MOON;
    }

    /** The pair's label and the body row follow the unit (and the body, which the page can change). */
    function refreshStepLabels(): void {
        const body = currentBody();
        const label = unit.astro ? astroStepLabel(unit.astro, body) : unit.label;
        if (tpStepLabel.textContent !== label) tpStepLabel.textContent = label;
        if (tpBodyName.textContent !== body.name) tpBodyName.textContent = body.name;
    }

    /** Choose a unit: chips, the body row (rise / set / transit only), the pair's label, persistence. */
    function selectUnit(key: TimeStepUnit, persist = true): void {
        const next = UNITS.find((u) => u.key === key);
        if (!next) return;
        unit = next;
        tpUnits.querySelectorAll<HTMLElement>('.tp-chip').forEach((chip) => {
            const on = chip.dataset.unit === unit.key;
            chip.classList.toggle('active', on);
            chip.setAttribute('aria-pressed', String(on));
        });
        tpBodyRow.hidden = !(unit.astro === 'rise' || unit.astro === 'set' || unit.astro === 'transit');
        refreshStepLabels();
        if (persist) setState({ tu: unit.key });
    }

    /** Step the body row: ‹ / ›, cycling CONTROLLER_BODIES; from then on the body is the user's. */
    function stepBody(dir: 1 | -1): void {
        const n = CONTROLLER_BODIES.length;
        const idx = CONTROLLER_BODIES.indexOf(currentBody());
        bodyKey = CONTROLLER_BODIES[(idx + dir + n) % n].key;
        refreshStepLabels();
        setState({ tb: bodyKey });
    }

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
     * The target timezone's actual UTC offset (east-positive, in seconds) AT a
     * given instant — what localComponentsFromTimeInterval expects. Exact per
     * instant from the zone's own rules when a zone is known
     * (tzOffsetSecondsAt: DST at that instant; LMT before the zone's first
     * rule — the same offset the astronomy env uses), so composing a typed
     * time and displaying the result agree to the second whatever instant the
     * app last computed its tzDeltaMs at. Without a zone, the browser's own
     * offset at the instant plus the app's delta.
     */
    function targetTzOffsetSec(d: Date): number {
        const tz = getTimezone();
        if (tz) return tzOffsetSecondsAt(tz, d.getTime());
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

        // One row: Now ▶ (when overridden), then ‖ while running or ◀ ▶ when
        // stopped. The buttons act on PRESS (pointerdown), like the step pair:
        // a stop lands the instant the finger touches rather than on release
        // (Steve, 2026-09-23). preventDefault keeps the press from focusing
        // or selecting; nothing listens for the click that follows.
        const onPress = (b: HTMLButtonElement, action: () => void): void => {
            b.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                action();
            });
        };
        const transportBtn = (html: string, className: string, action: () => void): HTMLButtonElement => {
            const b = document.createElement('button');
            b.className = className;
            b.innerHTML = html;
            onPress(b, () => {
                action();
                updater?.reset();
                onTransportChange();
                updateTimeUI();
                ensureSchedulerRunning();
                writeTimeState();
            });
            return b;
        };

        if (!isReal) {
            const nowBtn = document.createElement('button');
            nowBtn.className = 'tp-btn';
            nowBtn.innerHTML = 'Now\u2009<span style="position:relative;top:1px">▶</span>';
            onPress(nowBtn, nowClicked);
            tpTransport.appendChild(nowBtn);
        }

        if (!isStopped) {
            tpTransport.appendChild(transportBtn('‖', 'tp-btn active', () => timeController.stop()));
        } else {
            tpTransport.appendChild(transportBtn('◀', 'tp-btn', () => {
                timeController.setDirection(-1);
                timeController.setRate(null);
            }));
            tpTransport.appendChild(transportBtn('▶', 'tp-btn', () => {
                timeController.setDirection(1);
                timeController.setRate(null);
            }));
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

        // The pair's label / body name follow the page's body while no body is stored.
        refreshStepLabels();

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
        // Stale-fade guard: hidePopover() ends any scrub, so nothing should be
        // left behind — belt and braces against a future close path that skips it.
        timePopover.classList.remove('tp-hidden', 'tp-lock-zone', 'tp-locked');
        timeBarLabel.textContent = '⏱ Hide time controller';
        timeBarLabel.classList.add('active');
        updateTimeUI();
        setState({ tc: true });
        onPopoverToggle?.(true);
    }

    function hidePopover() {
        // A close mid-scrub (Escape, the ⋮ menu item, the `t` key) stops the
        // scrub first: display:none would strand a held button's release, and
        // a hands-free scrub would run on with the panel gone.
        endHold();
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
        timeController.reset();    // generic controller action (was delegated to clients)
        updater?.reset();
        onNowClicked();
        updateTimeUI();
        ensureSchedulerRunning();  // restart an idle render loop (e.g. Inspector/Observatory)
        writeTimeState();
    }

    // ===================================================================
    // Hold-to-scrub
    //
    // A press steps once; after HOLD_DELAY_MS the clock runs at the unit's
    // rate until release. Pointer Events with capture, so the release reaches
    // the button wherever the pointer went by then, with its coordinates. A
    // release that lands OFF the button AND at the display's edge (or outside
    // the window — a mouse dragged out of it) is the native app's
    // finger-off-the-screen gesture: the scrub keeps running hands-free until
    // the next press anywhere (docs/time-controller.md). Any other release
    // stops it, on the button or off it.
    // ===================================================================

    const HOLD_DELAY_MS = 300;
    /** A release within this many px of a visual-viewport edge counts as off the display. */
    const EDGE_PX = 8;
    /** How long the click swallower armed by a hands-free stop press stays armed. */
    const STOP_CLICK_SWALLOW_MS = 500;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let holdingBtn: HTMLElement | null = null;
    /** The pointer that pressed the pair — one press at a time; a second finger is ignored. */
    let holdPointerId: number | null = null;
    /** True while a scrub runs hands-free: on until the next press. */
    let scrubLocked = false;
    /** The held pointer's last known position (viewport coordinates). */
    let lastPointer: { x: number; y: number } | null = null;

    function startHold(btn: HTMLElement, rateIndex: number, dir: 1 | -1) {
        holdingBtn = btn;
        btn.classList.add('holding');
        // Fade the popover so the app is visible while scrubbing. Opacity-only
        // (see .tp-hidden in the CSS): the held button must keep hit-testing.
        timePopover.classList.add('tp-hidden');
        updateLockZone();

        // Set direction and start the unit's rate (10 units per second).
        timeController.setDirection(dir);
        timeController.setRate(RATE_OPTIONS[rateIndex]);
        updater?.reset();
        onScrubStart();
        updateTimeUI();
        ensureSchedulerRunning();
    }

    /** Stop a running scrub, held or hands-free; a pending hold that never engaged is just cancelled. */
    function endHold() {
        if (holdTimer !== null) {
            clearTimeout(holdTimer);
            holdTimer = null;
        }
        const wasScrubbing = holdingBtn !== null || scrubLocked;
        if (holdingBtn) {
            holdingBtn.classList.remove('holding');
            holdingBtn = null;
        }
        if (scrubLocked) unlockScrub();
        if (!wasScrubbing) return;

        // Release restores immediately: scrubbing = faded, stopped = restored.
        timePopover.classList.remove('tp-hidden', 'tp-lock-zone', 'tp-locked');

        // Stop at the current position (generic — was delegated to clients),
        // then let the app run any custom snap/finish logic.
        timeController.stop();
        updater?.reset();
        onScrubEnd();
        updateTimeUI();
        ensureSchedulerRunning();
        writeTimeState();
    }

    /**
     * Did a release leave the display? Off the button's own rect (a lift on
     * the button is a stop wherever on it) and within EDGE_PX of a visual
     * viewport edge, or past one. Both halves matter: excluding the button is
     * what lets EDGE_PX be generous — the Observatory's ▶ is 12 px from the
     * right edge — without a normal lift ever qualifying.
     */
    function releaseLeavesDisplay(btn: HTMLElement, x: number, y: number): boolean {
        const r = btn.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return false;
        const vv = window.visualViewport;
        const left = vv?.offsetLeft ?? 0;
        const top = vv?.offsetTop ?? 0;
        const w = vv?.width ?? window.innerWidth;
        const h = vv?.height ?? window.innerHeight;
        return x <= left + EDGE_PX || x >= left + w - EDGE_PX ||
               y <= top + EDGE_PX || y >= top + h - EDGE_PX;
    }

    /**
     * Lock-zone feedback while a scrub is held: when the pointer is where a
     * release would keep the scrub running, the panel comes back to full
     * opacity with the padlock over it (.tp-lock-zone), so the outcome of
     * letting go is visible before it happens — the only way a mouse user
     * could predict it.
     */
    function updateLockZone() {
        const inZone = holdingBtn !== null && lastPointer !== null &&
            releaseLeavesDisplay(holdingBtn, lastPointer.x, lastPointer.y);
        timePopover.classList.toggle('tp-lock-zone', inZone);
    }

    /** The scrub outlives the press: "on until release" becomes "on until the next press". */
    function lockScrub() {
        scrubLocked = true;
        if (holdingBtn) {
            holdingBtn.classList.remove('holding');   // no finger there; the bar shows the rate
            holdingBtn = null;
        }
        // The padlock stays; the panel drops back to the scrub level with it.
        timePopover.classList.remove('tp-lock-zone');
        timePopover.classList.add('tp-locked');
        document.addEventListener('pointerdown', onLockedPress, true);
    }

    function unlockScrub() {
        scrubLocked = false;
        document.removeEventListener('pointerdown', onLockedPress, true);
    }

    /**
     * The next press anywhere stops a hands-free scrub and does nothing else:
     * swallowed in the capture phase (no map drag, no menu, no chip), along
     * with the click the browser synthesises from it — which preventDefault
     * on pointerdown does not cancel — for as long as that click can take.
     */
    function onLockedPress(e: PointerEvent) {
        e.stopPropagation();
        e.preventDefault();
        let timer: ReturnType<typeof setTimeout> | null = null;
        const disarm = () => {
            document.removeEventListener('click', swallow, true);
            if (timer !== null) clearTimeout(timer);
        };
        const swallow = (ce: Event) => {
            ce.stopPropagation();
            ce.preventDefault();
            disarm();
        };
        document.addEventListener('click', swallow, true);
        timer = setTimeout(disarm, STOP_CLICK_SWALLOW_MS);
        endHold();
    }

    // A hidden tab must not run time away hands-free (a web tab, unlike the
    // native app, can sit in the background for hours).
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && scrubLocked) endHold();
    });

    // ===================================================================
    // The ◀ ▶ pair: tap = one step of the selected unit (astro units: one
    // jump); hold (calendar units only) = scrub at the unit's rate.
    // ===================================================================

    function stepPress(e: Event, dir: 1 | -1, el: HTMLElement) {
        e.preventDefault();
        e.stopPropagation();
        if (unit.astro) {
            handleAstroStep(unit.astro, dir, el);
            return;
        }
        // Stop time and snap in-flight animations before stepping
        timeController.stop();
        timeController.step(unit.time!, dir);
        updater?.reset();
        onTimeStep();
        updateTimeUI();
        ensureSchedulerRunning();
        // Start hold timer
        const rateIndex = unit.rateIndex!;
        holdTimer = setTimeout(() => {
            holdTimer = null;
            startHold(el, rateIndex, dir);
        }, HOLD_DELAY_MS);
    }

    function stepRelease(e: Event, el: HTMLElement, x: number, y: number) {
        e.stopPropagation();
        if (holdingBtn && releaseLeavesDisplay(el, x, y)) {
            lockScrub();
            return;
        }
        endHold();
        writeTimeState();
    }

    timePopover.querySelectorAll<HTMLElement>('.tp-step-btn').forEach((el) => {
        const dir = parseInt(el.dataset.dir || '1', 10) as 1 | -1;
        el.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (holdPointerId !== null) return;   // one press at a time
            holdPointerId = e.pointerId;
            lastPointer = { x: e.clientX, y: e.clientY };
            // Capture: the release reaches this button wherever the pointer is
            // by then (off the button, off the window), with its coordinates —
            // and so do the moves, which drive the lock-zone feedback.
            try { el.setPointerCapture(e.pointerId); } catch { /* unsupported (jsdom) */ }
            stepPress(e, dir, el);
        });
        el.addEventListener('pointermove', (e: PointerEvent) => {
            if (e.pointerId !== holdPointerId) return;
            lastPointer = { x: e.clientX, y: e.clientY };
            updateLockZone();
        });
        el.addEventListener('pointerup', (e: PointerEvent) => {
            if (e.pointerId !== holdPointerId) return;
            holdPointerId = null;
            lastPointer = null;
            stepRelease(e, el, e.clientX, e.clientY);
        });
        // A cancelled or lost pointer is an unknown state: stop. (After a
        // normal release the id is already cleared, so the implicit capture
        // loss that follows is a no-op.)
        const cancel = (e: PointerEvent) => {
            if (e.pointerId !== holdPointerId) return;
            holdPointerId = null;
            lastPointer = null;
            endHold();
        };
        el.addEventListener('pointercancel', cancel);
        el.addEventListener('lostpointercapture', cancel);
    });

    // ===================================================================
    // Unit chips and the body stepper
    // ===================================================================

    tpUnits.querySelectorAll<HTMLElement>('.tp-chip').forEach((chip) => {
        chip.addEventListener('click', (e) => {
            e.stopPropagation();
            selectUnit(chip.dataset.unit as TimeStepUnit);
        });
    });
    document.getElementById('tp-body-prev')?.addEventListener('click', (e) => { e.stopPropagation(); stepBody(-1); });
    document.getElementById('tp-body-next')?.addEventListener('click', (e) => { e.stopPropagation(); stepBody(1); });

    // The initial unit (from the per-app setting) — no write-back.
    selectUnit(unit.key, false);

    // ===================================================================
    // Astronomical event stepper
    // ===================================================================

    function handleAstroStep(kind: AstroStepKind, dir: 1 | -1, btnEl: HTMLElement) {
        const body = currentBody();
        const eventType: AstroEventType =
            kind === 'phase' ? 'moonphase'
            : kind === 'rise' ? 'body-rise'
            : kind === 'set' ? 'body-set'
            : 'body-transit';

        const targetDate = computeAstroTarget(
            eventType, dir, timeController.getDisplayTime(),
            getLat() * Math.PI / 180, getLon() * Math.PI / 180, body.planet,
        );

        if (!targetDate || isNaN(targetDate.getTime())) {
            // No event found (a polar day / night, a body that never rises or
            // sets here) — flash the button.
            btnEl.classList.add('flash-fail');
            setTimeout(() => btnEl.classList.remove('flash-fail'), 300);
            return;
        }

        // Same as single-tap time step:
        timeController.stop();
        timeController.setTime(targetDate);
        updater?.reset();
        onTimeStep();
        updateTimeUI();
        ensureSchedulerRunning();
        writeTimeState();
    }

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

        // Use the hybrid calendar to construct the time interval — in two
        // passes: the zone's offset at the target instant can differ from the
        // current one (a DST edge; LMT once the era flips), and the typed wall
        // time must win. Compose with the current offset, look the offset up
        // at the result, and recompose if it moved (the same two-pass idea
        // timeIntervalFromLocalComponents documents).
        const compose = (tzOff: number): Date =>
            dateIntervalToDate(timeIntervalFromLocalComponents(tzOff, era, yr, mo, dy, hr, mn, 0));
        const tzOffNow = targetTzOffsetSec(timeController.getDisplayTime());
        let d = compose(tzOffNow);
        const tzOffThere = targetTzOffsetSec(d);
        if (tzOffThere !== tzOffNow) d = compose(tzOffThere);
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

    // Escape. A hands-free scrub stops first (the panel stays open; the next
    // Escape closes). Otherwise, on pages that supply `escapeYields`, the
    // popover closes when no other overlay is up to take the key — decided in
    // the capture phase on the pre-close state (see the config doc). A date
    // input with focus gives it up first; the pending edit applies on change,
    // as it would on clicking away.
    window.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Escape' || !timePopover.isConnected) return;
        if (scrubLocked) {
            e.preventDefault();
            e.stopPropagation();
            endHold();
            return;
        }
        if (!escapeYields || !popoverOpen || escapeYields()) return;
        const active = document.activeElement;
        if (active instanceof HTMLInputElement && timePopover.contains(active)) {
            e.preventDefault();
            active.blur();
            return;
        }
        e.preventDefault();
        hidePopover();
    }, true);

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
        getUnit: () => unit.key,
        getBody: currentBody,
    };
}
