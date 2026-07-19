/**
 * Sleep/wake & tab-return catch-up triggers.
 *
 * The platform has no system suspend/resume notification (Page Lifecycle
 * freeze/resume is hidden-tab freezing only; visibilitychange at sleep onset
 * is implementation-defined and unreliable), so "wake" is synthesized from
 * two triggers, both funneling into the app's catch-up kick:
 *
 *   - visibilitychange→visible / pageshow(persisted): owns everything that
 *     happened while the tab was hidden (rAF parked, timers throttled or
 *     frozen). Fires on return regardless of how long the gap was.
 *   - a 1s wake watchdog: owns gaps while the tab stayed visible (system
 *     sleep, clock steps, multi-second stalls). Its primary signal is CLOCK
 *     DRIFT — wall-clock advance minus perf-clock advance since the last
 *     firing. Jank and timer throttling delay both clocks equally (drift
 *     ≈ 0); system suspend freezes performance.now() on macOS/iOS/Linux
 *     while Date.now() keeps counting, so drift ≈ the sleep duration. Clock
 *     steps (NTP, manual set) appear as drift of either sign — display time
 *     is Date-based, so those need a resync too. Gated on visible: hidden
 *     tabs are throttled (gaps are routine) and are caught up by the
 *     visibilitychange trigger on return instead.
 *
 * Catch-up must be an explicit external kick rather than per-beat staleness
 * detection inside the updater: on the perf-frozen platforms (macOS/iOS/
 * Linux — performance.now() excludes suspend time), a sleep leaves every
 * on-beat schedule still comfortably "in the future" in perf terms while
 * Date-based display time has jumped hours — the state machine cannot see
 * that anything was missed. Each on-beat arrival re-anchors perf↔wall, so an
 * *undetected* gap self-corrects within one update interval and the residual
 * error is bounded by the gap length; the thresholds only need to catch gaps
 * long enough to outlive that.
 *
 * WAKE_DRIFT_MS sits above the clock-discipline band (read quantization
 * ≤ ~2ms/sample, NTP slew ≤ ~0.5ms/s, ntpd-family steps ≥ 128ms — sub-beat
 * corrections the next arrival absorbs) and below any human-scale sleep.
 * WAKE_GAP_MS is the absolute-lateness backstop for Windows, where the perf
 * clock counts suspend time (QPC) and drift stays ≈ 0 across a sleep; short
 * Windows sleeps behave exactly like a same-length rAF stall and need no
 * catch-up. A visible tab's 1s timer only fires seconds late under
 * main-thread stalls, and after a multi-second stall a resync is the right
 * response anyway.
 */

const WAKE_DRIFT_MS = 500;
const WAKE_GAP_MS = 5000;
// Returning to a hidden tab can fire both triggers (visibilitychange, then
// the watchdog seeing the throttled-away interval) — one catch-up suffices.
const CATCH_UP_DEBOUNCE_MS = 2000;

export interface WakeTriggerOptions {
    /**
     * Whether a catch-up would do anything right now. Return false for states
     * with nothing to resync — e.g. stopped (display frozen), quantized
     * playback (self-anchored: display advances per rendered tick, so a gap
     * merely pauses it), or a held-display interaction whose release path
     * already resets.
     */
    isEligible: () => boolean;
    /**
     * App-specific resync kick: rebuild time-derived environment state,
     * settle/reset value schedules, and kick the render loop.
     */
    catchUp: () => void;
}

/** Install the two wake triggers (idempotent per call site; call once at init). */
export function installWakeTriggers(opts: WakeTriggerOptions): void {
    let lastCatchUpPerfMs = -Infinity;
    let lastWallMs = Date.now();
    let lastPerfMs = performance.now();

    function fire(reason: string): void {
        if (!opts.isEligible()) return;
        if (performance.now() - lastCatchUpPerfMs < CATCH_UP_DEBOUNCE_MS) return;
        lastCatchUpPerfMs = performance.now();
        console.log(`[wake] catch-up (${reason})`);
        opts.catchUp();
    }

    setInterval(() => {
        const wallMs = Date.now();
        const perfMs = performance.now();
        const wallDelta = wallMs - lastWallMs;
        const drift = wallDelta - (perfMs - lastPerfMs);
        lastWallMs = wallMs;
        lastPerfMs = perfMs;
        if (document.visibilityState === 'visible'
            && (Math.abs(drift) > WAKE_DRIFT_MS || wallDelta > WAKE_GAP_MS)) {
            fire(`clock gap: ${Math.round(wallDelta)}ms wall, ${Math.round(drift)}ms drift`);
        }
    }, 1000);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') fire('tab became visible');
    });
    window.addEventListener('pageshow', (e: PageTransitionEvent) => {
        if (e.persisted) fire('bfcache restore');
    });
}
