/**
 * Shared page-level FPS indicator overlay.
 *
 * Used by Chronometer (`engine-entry.ts`), Observatory (`observatory-entry.ts`),
 * and the Inspector (`inspector-entry.ts`). Lives in `src/shared/` so no app pulls
 * in another's code (import boundary — see Architecture Overview).
 *
 * Compact, power-user readout: "<fps>fps <cpuFrame>% <cpu60>% <avg>avg", e.g.
 * `30fps 20% 40% 2avg`:
 *
 *   - **`<fps>fps`** — actual wallclock rate while animating: `1000 / median(inter-frame
 *     wall Δ)` over consecutive continuous-render frames (idle gaps not counted),
 *     vsync-bound. What the user actually sees during animation.
 *   - **`<cpuFrame>%`** — CPU's share of *that* actual frame: `100 × median(workMs) /
 *     median(Δ)`. "Is CPU pacing the current frame?" — ~100% ⇒ yes (CPU is the
 *     bottleneck right now); low ⇒ the frame is mostly waiting on vsync/GPU.
 *   - **`<cpu60>%`** — CPU's share of a nominal **60 fps** frame: `100 × median(workMs)
 *     / 16.67`. "How does CPU compare to the 60 fps target?" — can exceed 100%
 *     ("400%" ⇒ CPU work is 4× a 60 fps frame; needs ~4× faster to hit 60). Fixed
 *     denominator, so it tracks CPU cost across A/B optimizations rather than wobbling
 *     with the frame rate. (For a 240 fps scrub target, multiply by 4.)
 *   - **`<avg>avg`** — throughput: frames per wallclock second over the last watchdog
 *     window, *including* idle gaps. ~0 idle, ~1 when only housekeeping fires.
 *
 * Reading both percentages together answers "would optimizing CPU help?": if `cpuFrame`
 * is low the frame isn't CPU-paced (so CPU work isn't your fps ceiling), while `cpu60`
 * says how far CPU is from the 60 fps budget in absolute terms.
 *
 * `fps` and the `%`s use a **median** (not a mean of reciprocals), which avoids the
 * Jensen-inequality inflation that made an EWMA reading balloon on jittery/bursty frames.
 * `workMs` is CPU time *issuing* the frame — canvas draws rasterize on the GPU afterward,
 * so it under-counts on GPU-bound work (use the scrub instrumentation's forced readback
 * for that).
 *
 * The 1s watchdog (not the caller) owns the on-screen text, so the readout refreshes on
 * its own cadence even when the render loop has gone idle.
 *
 * Enable via the `fps` URL parameter (see url-state.ts).
 */

import { updateNavigationLinks } from './url-state.js';

/** Throughput window + display refresh interval, in ms. */
const FPS_WATCHDOG_MS = 1000;

/** Nominal target frame budget (ms) the `cpu60` percentage is measured against. */
const TARGET_FRAME_MS = 1000 / 60;

/** Median of a numeric array (0 for empty). Sorts a copy; arrays are tiny (~60). */
function median(xs: number[]): number {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface FpsIndicator {
    /**
     * Record one rendered frame.
     * @param continuous true if the render loop is in continuous-animation mode
     *   this frame (vs. an idle/heartbeat wakeup). Drives the `fps`/`cpuFrame`
     *   metrics and the dim-when-idle behavior.
     * @param workMs CPU time spent producing this frame (measure
     *   `performance.now()` around the frame body). Drives the CPU-% metrics. Pass
     *   0 if not measured.
     */
    recordFrame(continuous: boolean, workMs: number): void;
}

/**
 * Create the FPS overlay and return a handle, or `null` when `enabled` is false
 * (so callers can simply `_fps?.recordFrame(...)`).
 */
export function createFpsIndicator(enabled: boolean): FpsIndicator | null {
    if (typeof document === 'undefined') return null;

    let lastFrameTime = 0;       // previous frame timestamp (for the inter-frame delta)
    let wasContinuous = false;   // was the previous recorded frame continuous?
    let continuousFrames = 0;    // # of continuous frames since the last watchdog tick
    let frameCount = 0;          // all frames since the last watchdog tick (throughput)
    let windowStart = performance.now();
    const workSamples: number[] = [];   // per-frame work-ms collected this window
    const deltaSamples: number[] = [];  // inter-frame Δ between consecutive continuous frames

    // Held readings, so an idle window keeps showing the last live values (dimmed).
    let fpsHeld = 0;
    let cpuFrameHeld = 0;  // % of the actual frame
    let cpu60Held = 0;     // % of a nominal 60 fps frame

    const el = document.createElement('div');
    el.id = 'fps-indicator';
    el.title =
        'fps: wallclock rate while animating (vsync-bound) · ' +
        '1st %: CPU share of that actual frame (~100% = CPU-paced) · ' +
        '2nd %: CPU share of a 60 fps (16.7ms) frame, can exceed 100% (×4 for 240 fps) · ' +
        'avg: frames/sec over the last second, incl. idle';
    el.style.cssText =
        'position:fixed;bottom:8px;left:8px;z-index:9999;pointer-events:none;' +
        'font:11px "JetBrains Mono",monospace;color:rgba(255,255,255,0.5);' +
        'background:rgba(0,0,0,0.35);padding:2px 6px;border-radius:4px;';
    const animEl = document.createElement('span');  // "<fps>fps <cpuFrame>% <cpu60>%"
    const thruEl = document.createElement('span');   // "<avg>avg"
    const sep = document.createElement('span');
    sep.textContent = ' ';
    animEl.textContent = '–fps';
    animEl.style.opacity = '0.4';
    thruEl.textContent = '0avg';
    el.append(animEl, sep, thruEl);
    document.body.appendChild(el);

    if (enabled) {
        document.body.classList.add('has-fps');
    } else {
        el.style.display = 'none';
    }

    window.addEventListener('keydown', (ev: KeyboardEvent) => {
        const target = ev.target as HTMLElement;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            return;
        }
        if (ev.key.toLowerCase() === 'f' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
            const params = new URLSearchParams(window.location.search);
            const isVisible = el.style.display !== 'none';
            if (isVisible) {
                el.style.display = 'none';
                document.body.classList.remove('has-fps');
                params.delete('fps');
            } else {
                el.style.display = '';
                document.body.classList.add('has-fps');
                params.set('fps', '1');
            }
            const qs = params.toString();
            const newUrl = window.location.pathname + (qs ? '?' + qs : '');
            window.history.replaceState(null, '', newUrl);
            updateNavigationLinks();
        }
    });

    setInterval(() => {
        const nowW = performance.now();
        const elapsedSec = (nowW - windowStart) / 1000;
        const throughput = elapsedSec > 0 ? frameCount / elapsedSec : 0;

        // Hold the previous value when a window produced no samples (e.g. idle).
        const mWork = median(workSamples);
        const mDelta = median(deltaSamples);
        if (mDelta > 0) fpsHeld = 1000 / mDelta;
        if (mWork > 0 && mDelta > 0) cpuFrameHeld = (mWork / mDelta) * 100;
        if (mWork > 0) cpu60Held = (mWork / TARGET_FRAME_MS) * 100;

        // "active" (animating) gates dimming, regardless of how high the achieved
        // rate is — a heavy multi-face scrub is clearly active.
        const isActive = continuousFrames > 0;

        frameCount = 0;
        windowStart = nowW;
        continuousFrames = 0;
        workSamples.length = 0;
        deltaSamples.length = 0;

        animEl.style.opacity = isActive ? '1' : '0.4';
        animEl.textContent =
            `${fpsHeld.toFixed(0)}fps ${cpuFrameHeld.toFixed(0)}% ${cpu60Held.toFixed(0)}%`;
        thruEl.textContent = `${throughput.toFixed(0)}avg`;
    }, FPS_WATCHDOG_MS);

    return {
        recordFrame(continuous: boolean, workMs: number): void {
            const now = performance.now();
            frameCount++;
            if (workMs > 0) workSamples.push(workMs);
            // Count the inter-frame delta toward fps/cpuFrame only between consecutive
            // continuous frames, so an idle gap is never mis-measured as one slow frame.
            if (continuous && wasContinuous && lastFrameTime > 0) {
                const delta = now - lastFrameTime;
                if (delta > 0) deltaSamples.push(delta);
            }
            lastFrameTime = now;
            if (continuous) continuousFrames++;
            wasContinuous = continuous;
        },
    };
}
