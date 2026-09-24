/**
 * Frame pacer — the steady-state frame-rate cap shared by the three render
 * loops (docs/performance.md § Idle (1×) and battery; plan:
 * planning/2026-09-22-steady-state-frame-pacer.md).
 *
 * Each loop asks for its next frame through `request(cb, paced)`. Unpaced
 * requests are plain `requestAnimationFrame` — the display's rate. Paced
 * requests are what the loop asks for in *steady state* (clock running at
 * 1× / −1× / offset; no scrub, no map drag): the frame is drawn on every
 * k-th vsync, k = ⌊display rate ÷ cap⌋ — the highest rate at or above the
 * cap that divides the display's evenly, so intervals are uniform (Steve's
 * rule, 2026-09-22): 60 fps on 120 and 240 Hz, 72 on 144, 82.5 on 165, and
 * the display's own rate on 60, 75 and 90 Hz. The loop sleeps between
 * frames: a `setTimeout` wakes it half a period before the slot, a
 * `requestAnimationFrame` lands on the vsync, and a frame whose timestamp is
 * still ahead of the slot is skipped and re-armed (browsers may run a
 * timer-requested rAF inside the frame already in progress, whose timestamp
 * is older; pacing from that alone gave ~90 fps on 120 Hz).
 *
 * The display rate comes from a shared 12-frame rAF probe run at page load,
 * again whenever the tab becomes visible, and once a minute (a window can
 * move to another monitor, and macOS Low Power Mode caps ProMotion at 60 Hz,
 * without any event). The measured period is snapped to the nearest
 * plausible display rate: the common rates sit exactly on the integer
 * boundaries of the k rule (120 Hz is 2.000 × the 60 fps interval), so an
 * estimate a few percent long would otherwise floor k to 1 and switch the
 * cap off. Until measured, paced requests are plain rAF.
 *
 * Nothing moves visibly faster than the cap in steady state — a 6°/s second
 * hand moves a tenth of a degree per 60 Hz frame — so the cap costs nothing
 * anyone can see and saves the 2–4× work a fast display would otherwise do.
 *
 * Two escapes keep motion smooth where it matters:
 *   - the caller passes `paced = false` for scrubbing and dragging;
 *   - `burst()` lifts the cap for a couple of seconds after a user-driven
 *     change (a step tap, Now, a location / body / noon change), so the
 *     hands' sweep to their new targets renders at the display's rate. The
 *     loops call it from their explicit-wake entry points.
 *
 * `setTargetFps` serves the Low power preference (docs/preferences.md): the
 * entries set LOW_POWER_FPS instead, same rule (10 fps on 120 Hz = every
 * 12th vsync). The `?fps` readout shows the paced share and the display rate.
 */

/** Steady-state cap, frames per second. */
export const STEADY_STATE_FPS = 60;
/**
 * Steady-state cap under the Low power preference. Scrubs, drags and bursts
 * are exempt as ever; at 1× the second hands visibly step instead of
 * sweeping, which is what the preference means. Tunable: the plan's range is
 * 10–12 (planning/2026-09-14-user-options-panel.md §3.4), to be settled by
 * measurement on the native machines.
 */
export const LOW_POWER_FPS = 10;
/** How long a user-driven change keeps the loop uncapped. */
export const BURST_MS = 2000;
/** Frames in one display-rate probe (the first gap is discarded). */
export const PROBE_FRAMES = 12;
/** How often the display rate is re-probed while the page is visible. */
export const REPROBE_MS = 60_000;
/** Display rates a measurement is snapped to when within SNAP_TOLERANCE. */
export const PLAUSIBLE_HZ: readonly number[] = [60, 72, 75, 90, 100, 120, 144, 165, 240, 360];
/** Relative tolerance for snapping: a 120 Hz panel has read as high as 125 (Steve's laptop). */
const SNAP_TOLERANCE = 0.06;

/** How the last delivered frame was armed. */
export type FrameMode = 'unpaced' | 'burst' | 'paced';

export interface FramePacer {
    /**
     * Arm the next frame, replacing any pending request. `paced` = steady
     * state: honour the cap (unless a burst is running). Otherwise raw rAF.
     */
    request(cb: (now: number) => void, paced: boolean): void;
    /** Drop the pending request, if any. */
    cancel(): void;
    /** True while a frame is armed (timer or rAF). */
    readonly pending: boolean;
    /** Lift the cap for `ms` (default BURST_MS) from now. */
    burst(ms?: number): void;
    /** True while a burst is running. */
    inBurst(now?: number): boolean;
    /** Steady-state cap in frames per second; null = uncapped. */
    setTargetFps(fps: number | null): void;
    getTargetFps(): number | null;
    /** How the last delivered frame was armed. */
    readonly lastMode: FrameMode;
    /** Measured (snapped) display period in ms, or null until probed. */
    readonly vsyncMs: number | null;
}

function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Snap a measured frame period (ms) to the nearest plausible display rate, if within tolerance. */
export function snapDisplayPeriod(ms: number): number {
    const hz = 1000 / ms;
    let best = ms;
    let bestErr = SNAP_TOLERANCE;
    for (const p of PLAUSIBLE_HZ) {
        const err = Math.abs(hz - p) / p;
        if (err < bestErr) { bestErr = err; best = 1000 / p; }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Shared display-rate probe (one per page)
// ---------------------------------------------------------------------------

let displayPeriodMs: number | null = null;
let probing = false;
let probeInstalled = false;

/**
 * Measure the display period: PROBE_FRAMES consecutive rAF callbacks, the
 * median gap (first gap discarded — it carries the request's scheduling
 * latency), snapped. No-op while a probe is running or without rAF.
 */
export function probeDisplayPeriod(): void {
    if (probing || typeof requestAnimationFrame !== 'function') return;
    probing = true;
    const stamps: number[] = [];
    const step = (t: number): void => {
        stamps.push(t);
        if (stamps.length < PROBE_FRAMES + 1) {
            requestAnimationFrame(step);
            return;
        }
        probing = false;
        const gaps: number[] = [];
        for (let i = 2; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1]);
        const med = median(gaps);
        if (med >= 2 && med <= 40) displayPeriodMs = snapDisplayPeriod(med);
    };
    requestAnimationFrame(step);
}

/** The measured display period (ms), or null until a probe has completed. */
export function getDisplayPeriodMs(): number | null {
    return displayPeriodMs;
}

/** Tests: force the display period (null = unmeasured) and clear a probe in flight. */
export function setDisplayPeriodMs(ms: number | null): void {
    displayPeriodMs = ms;
    probing = false;
}

function installDisplayProbe(): void {
    if (probeInstalled) return;
    probeInstalled = true;
    probeDisplayPeriod();
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') probeDisplayPeriod();
        });
    }
    setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') probeDisplayPeriod();
    }, REPROBE_MS);
}

// ---------------------------------------------------------------------------
// Pacer
// ---------------------------------------------------------------------------

export function createFramePacer(targetFps: number | null = STEADY_STATE_FPS): FramePacer {
    installDisplayProbe();
    let target = targetFps;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let rafId: number | null = null;
    /** rAF timestamp of the last delivered frame. */
    let lastFrameAt = -Infinity;
    let lastMode: FrameMode = 'unpaced';
    let burstUntil = -Infinity;

    const now = () => performance.now();

    function cancel(): void {
        if (timerId !== null) { clearTimeout(timerId); timerId = null; }
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    }

    function inBurst(t = now()): boolean {
        return t < burstUntil;
    }

    /** rAF; with a `slot` and `period`, frames whose timestamp is still ahead of the slot are skipped. */
    function armRaf(cb: (now: number) => void, mode: FrameMode, slot: number | null, period: number): void {
        rafId = requestAnimationFrame((t) => {
            rafId = null;
            if (slot !== null && t < slot - period / 2) {
                armRaf(cb, mode, slot, period);
                return;
            }
            lastFrameAt = t;
            lastMode = mode;
            cb(t);
        });
    }

    function request(cb: (now: number) => void, paced: boolean): void {
        cancel();
        const t = now();
        if (!paced || target === null || inBurst(t)) {
            armRaf(cb, paced ? 'burst' : 'unpaced', null, 0);
            return;
        }
        const period = displayPeriodMs;
        // Unmeasured display, or one at or below the cap already: plain rAF.
        const k = period === null ? 1 : Math.max(1, Math.floor(1000 / target / period + 1e-3));
        if (period === null || k === 1 || !isFinite(lastFrameAt)) {
            armRaf(cb, 'paced', null, 0);
            return;
        }
        // Every k-th vsync from the last drawn frame. Wake half a period
        // early: the next vsync is then the slot; the skip rule in armRaf
        // covers an early wake or a stale timestamp.
        const slot = lastFrameAt + k * period;
        const wait = slot - period / 2 - 1 - t;
        if (wait <= 0) {
            armRaf(cb, 'paced', slot, period);
        } else {
            timerId = setTimeout(() => {
                timerId = null;
                armRaf(cb, 'paced', slot, period);
            }, wait);
        }
    }

    return {
        request,
        cancel,
        get pending() { return timerId !== null || rafId !== null; },
        burst(ms = BURST_MS) { burstUntil = Math.max(burstUntil, now() + ms); },
        inBurst,
        setTargetFps(fps) { target = fps; },
        getTargetFps() { return target; },
        get lastMode() { return lastMode; },
        get vsyncMs() { return displayPeriodMs; },
    };
}
