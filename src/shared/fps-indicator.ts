/**
 * Shared page-level FPS indicator overlay.
 *
 * Used by both Chronometer (`engine-entry.ts`) and Observatory
 * (`observatory-entry.ts`). Lives in `src/shared/` so neither app pulls in the
 * other's code (import boundary — see Architecture Overview).
 *
 * Shows two numbers, "<active> fps · <avg> avg":
 *   - active: the fps sustained *while continuously animating* — the
 *     capability/responsiveness metric. Measured as an EWMA over consecutive
 *     continuous-render frames, so an idle gap is never counted as a slow
 *     frame. Dimmed (held, not live) whenever the app is idle.
 *   - avg: throughput — frames per wall-clock second over the last watchdog
 *     window, *including* idle gaps. ~0 when idle, ~1 when only once-per-second
 *     housekeeping fires, high only when work is genuinely happening.
 *
 * The 1s watchdog (not the caller) owns the on-screen text, so the readout
 * refreshes on its own cadence even when the render loop has gone idle.
 *
 * Enable via the `fps` URL parameter (see url-state.ts).
 */

import { updateNavigationLinks } from './url-state.js';

/** Throughput window + display refresh interval, in ms. */
const FPS_WATCHDOG_MS = 1000;

export interface FpsIndicator {
    /**
     * Record one rendered frame.
     * @param continuous true if the render loop is in continuous-animation mode
     *   this frame (vs. an idle/heartbeat wakeup). Drives the "active" metric
     *   and the dim-when-idle behavior.
     */
    recordFrame(continuous: boolean): void;
}

/**
 * Create the FPS overlay and return a handle, or `null` when `enabled` is false
 * (so callers can simply `_fps?.recordFrame(...)`).
 */
export function createFpsIndicator(enabled: boolean): FpsIndicator | null {
    if (typeof document === 'undefined') return null;

    let active = 0;             // EWMA of fps across continuous-render frames
    let activeLastTime = 0;     // previous frame timestamp (for the frame-to-frame delta)
    let wasContinuous = false;  // was the previous recorded frame continuous?
    let continuousFrames = 0;   // # of continuous frames since the last watchdog tick
    let frameCount = 0;         // all frames since the last watchdog tick (throughput)
    let windowStart = performance.now();

    const el = document.createElement('div');
    el.id = 'fps-indicator';
    el.title =
        'left: render rate while animating (dimmed when idle) · ' +
        'right: average fps over the last second (low = idle / little work)';
    el.style.cssText =
        'position:fixed;bottom:8px;left:8px;z-index:9999;pointer-events:none;' +
        'font:11px "JetBrains Mono",monospace;color:rgba(255,255,255,0.5);' +
        'background:rgba(0,0,0,0.35);padding:2px 6px;border-radius:4px;';
    const activeEl = document.createElement('span');
    const thruEl = document.createElement('span');
    const sep = document.createElement('span');
    sep.textContent = ' · ';
    sep.style.opacity = '0.5';
    activeEl.textContent = '– fps';
    activeEl.style.opacity = '0.4';
    thruEl.textContent = '0 avg';
    el.append(activeEl, sep, thruEl);
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
        frameCount = 0;
        windowStart = nowW;

        // "active" is live while the loop was genuinely in continuous-render mode
        // (scrubbing or animating), regardless of how high the achieved frame rate
        // is — a heavy multi-face scrub can run well under any fps threshold yet is
        // clearly active. Gate on whether any continuous frames occurred this window.
        const isActive = continuousFrames > 0;
        continuousFrames = 0;
        activeEl.style.opacity = isActive ? '1' : '0.4';
        activeEl.textContent = `${active.toFixed(0)} fps`;
        thruEl.textContent = `${throughput.toFixed(0)} avg`;
    }, FPS_WATCHDOG_MS);

    return {
        recordFrame(continuous: boolean): void {
            const now = performance.now();
            frameCount++;
            // Count the frame-to-frame delta toward the active EWMA only between
            // consecutive continuous frames, so an idle gap is never mis-measured
            // as one slow frame.
            if (wasContinuous && activeLastTime > 0) {
                const delta = now - activeLastTime;
                if (delta > 0) {
                    const instantFps = 1000 / delta;
                    active = active === 0 ? instantFps : active * 0.9 + instantFps * 0.1;
                }
            }
            activeLastTime = now;
            if (continuous) continuousFrames++;
            wasContinuous = continuous;
        },
    };
}
