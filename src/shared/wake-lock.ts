/**
 * Keep screen awake — the Wake Lock API behind the Settings row of that name
 * (docs/preferences.md). A clock that lets the phone sleep is not a clock;
 * the preference is pure intent, so it is the one genuine device setting.
 *
 * `navigator.wakeLock.request('screen')` needs no permission prompt (Chrome
 * 84+, Safari 16.4+, Firefox 126+) but the browser releases the lock on its
 * own whenever the page is hidden, so the lock is (re-)acquired on every
 * `visibilitychange` → visible while the preference is on, and released the
 * moment it is turned off. Offered in Settings only when the API exists
 * (`isWakeLockSupported`). A rejected request (permissions policy in an
 * iframe, a low battery on some platforms) is logged once and otherwise
 * ignored — there is nothing the app can do about it.
 */

import { getPrefs, onPrefsChange } from './prefs.js';

export function isWakeLockSupported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

let sentinel: WakeLockSentinel | null = null;
let requesting = false;
let installed = false;
let warned = false;

async function acquire(): Promise<void> {
    if (sentinel || requesting) return;
    requesting = true;
    try {
        const s = await navigator.wakeLock.request('screen');
        s.addEventListener('release', () => { if (sentinel === s) sentinel = null; });
        // The preference may have been turned off, or the page hidden, while
        // the request was in flight.
        if (getPrefs().keepAwake && document.visibilityState === 'visible') sentinel = s;
        else await s.release();
    } catch (err) {
        if (!warned) {
            warned = true;
            console.warn('[wake-lock] screen wake lock request failed:', err);
        }
    } finally {
        requesting = false;
    }
}

function release(): void {
    const s = sentinel;
    sentinel = null;
    void s?.release();
}

/** Bring the lock in line with the preference and the page's visibility. */
export function refreshWakeLock(): void {
    if (!isWakeLockSupported()) return;
    if (getPrefs().keepAwake && document.visibilityState === 'visible') void acquire();
    else release();
}

/**
 * Install the keep-awake behaviour for this page: acquire now if the
 * preference is on, and follow the preference and visibility from here on.
 * No-op where the API is missing. Idempotent.
 */
export function initKeepAwake(): void {
    if (installed || !isWakeLockSupported()) return;
    installed = true;
    document.addEventListener('visibilitychange', refreshWakeLock);
    onPrefsChange(refreshWakeLock);
    refreshWakeLock();
}

// --- Internal exports for unit tests (not part of the public API) ---
export const __test__ = {
    /** True while a lock is held. */
    held: () => sentinel !== null,
    reset(): void { sentinel = null; requesting = false; installed = false; warned = false; },
};
