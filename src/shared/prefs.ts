/**
 * Device preferences — the settings behind the ⚙ button (docs/preferences.md;
 * Part 3 of planning/2026-09-14-user-options-panel.md).
 *
 * These are *device* preferences (keep the screen awake, low power) and the
 * "seen the Settings notice" flag: things about this browser on this device,
 * never about the view. They are deliberately kept **out of `UrlState`** and
 * out of app-state's backends, so that
 *
 *   - share links never carry them (`buildShareUrl` serializes UrlState only);
 *   - an incoming link is never compared against them (`SHAREABLE_FIELDS`);
 *   - the incoming-settings decision tree and the session-only re-prompt stay
 *     untouched — a preference edit is never a "setting" to be saved or
 *     kept for the visit.
 *
 * Three modes, decided the way app-state decides its backend:
 *   - storage — localStorage works: the `ec:prefs` blob (`ec:meta` for the
 *     notice flag). Cross-tab: `storage` events notify subscribers, like
 *     `onSharedChange`.
 *   - url — storage broken on a file:// page: the flags ride the query string
 *     (`?awake=1&lowpower=1&optseen=1`), which the navigation links already
 *     carry whole in that mode (`navSearch` in app-nav.ts,
 *     `updateNavigationLinks` in url-state.ts). The keys are unknown to
 *     url-state, so `writeUrlState` and `clearShareableParamsFromUrl` leave
 *     them in place.
 *   - memory — storage broken on http(s): this page's lifetime only (never
 *     the URL, which could reach server logs).
 *
 * Only `true` is stored; a false flag is deleted, and an empty blob is
 * removed, so a device that never touched Settings has no `ec:prefs` key.
 */

import { storageWorks } from './app-state.js';
import { updateNavigationLinks } from './url-state.js';

export interface Prefs {
    /** Hold a screen wake lock while a page is visible (wake-lock.ts). */
    keepAwake: boolean;
    /** Cap steady-state rendering at LOW_POWER_FPS instead of STEADY_STATE_FPS (frame-pacer.ts). */
    lowPower: boolean;
}

const STORAGE_PREFIX = 'ec:';
const PREFS_KEY = STORAGE_PREFIX + 'prefs';
const META_KEY = STORAGE_PREFIX + 'meta';
const SCHEMA_VERSION = 1;

/** Stored field name — also the URL query key in url mode — per preference. */
const PREF_FIELDS: Record<keyof Prefs, string> = { keepAwake: 'awake', lowPower: 'lowpower' };
const OPTIONS_SEEN_FIELD = 'optionsSeen';
const OPTIONS_SEEN_URL_KEY = 'optseen';

/** Query keys the url mode uses (exported for tests and docs). */
export const PREF_URL_KEYS: readonly string[] = [...Object.values(PREF_FIELDS), OPTIONS_SEEN_URL_KEY];

type Mode = 'storage' | 'url' | 'memory';
let mode: Mode | null = null;
/** The memory mode's state (also the landing place after a failed storage write). */
let memFlags: Record<string, boolean> = {};

function currentMode(): Mode {
    if (mode === null) {
        if (storageWorks()) mode = 'storage';
        else mode = (typeof window !== 'undefined' && window.location.protocol === 'file:') ? 'url' : 'memory';
    }
    return mode;
}

// ---------------------------------------------------------------------------
// Backing stores
// ---------------------------------------------------------------------------

function readBlob(key: string): Record<string, unknown> {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return {};
        const obj = JSON.parse(raw) as Record<string, unknown>;
        delete obj.v;
        return obj;
    } catch {
        return {};
    }
}

/** Merge boolean flags into a blob (false deletes); returns false when the write failed. */
function writeBlob(key: string, changes: Record<string, boolean>): boolean {
    const cur = readBlob(key);
    for (const [k, v] of Object.entries(changes)) {
        if (v) cur[k] = true; else delete cur[k];
    }
    try {
        if (Object.keys(cur).length === 0) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify({ ...cur, v: SCHEMA_VERSION }));
        return true;
    } catch {
        return false;
    }
}

function urlFlag(key: string): boolean {
    return new URLSearchParams(window.location.search).get(key) === '1';
}

function setUrlFlag(key: string, on: boolean): void {
    const params = new URLSearchParams(window.location.search);
    if (on) params.set(key, '1'); else params.delete(key);
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
    // The face-page navigation links copy the query string when built; the
    // cross-app links read it at click time (app-nav.ts) and need nothing.
    updateNavigationLinks();
}

/** One flag from whichever store the mode uses. `blobKey` is the storage-mode blob. */
function readFlag(blobKey: string, field: string, urlKey: string): boolean {
    switch (currentMode()) {
        case 'storage': return readBlob(blobKey)[field] === true;
        case 'url': return urlFlag(urlKey);
        case 'memory': return memFlags[field] === true;
    }
}

function writeFlag(blobKey: string, field: string, urlKey: string, value: boolean): void {
    switch (currentMode()) {
        case 'storage':
            if (!writeBlob(blobKey, { [field]: value })) {
                // Quota / revoked storage: keep going in memory, seeded with
                // what was stored, the same way app-state downgrades.
                memFlags = {};
                for (const key of [PREFS_KEY, META_KEY]) {
                    for (const [k, v] of Object.entries(readBlob(key))) if (v === true) memFlags[k] = true;
                }
                memFlags[field] = value;
                mode = 'memory';
            }
            return;
        case 'url': setUrlFlag(urlKey, value); return;
        case 'memory': memFlags[field] = value; return;
    }
}

// ---------------------------------------------------------------------------
// Change notification (this tab's writes and other tabs' storage events)
// ---------------------------------------------------------------------------

const prefsListeners = new Set<(prefs: Prefs) => void>();
const seenListeners = new Set<() => void>();
let storageListenerInstalled = false;

function notifyPrefs(): void {
    const prefs = getPrefs();
    for (const cb of [...prefsListeners]) {
        try { cb(prefs); } catch (err) { console.error('[prefs] listener failed:', err); }
    }
}

function notifySeen(): void {
    for (const cb of [...seenListeners]) {
        try { cb(); } catch (err) { console.error('[prefs] listener failed:', err); }
    }
}

function installStorageListener(): void {
    if (storageListenerInstalled || typeof window === 'undefined') return;
    storageListenerInstalled = true;
    window.addEventListener('storage', (e: StorageEvent) => {
        if (currentMode() !== 'storage') return;
        // e.key is null for localStorage.clear().
        if (e.key === null || e.key === PREFS_KEY) notifyPrefs();
        if ((e.key === null || e.key === META_KEY) && isOptionsSeen()) notifySeen();
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The current preferences (defaults: everything off). */
export function getPrefs(): Prefs {
    return {
        keepAwake: readFlag(PREFS_KEY, PREF_FIELDS.keepAwake, PREF_FIELDS.keepAwake),
        lowPower: readFlag(PREFS_KEY, PREF_FIELDS.lowPower, PREF_FIELDS.lowPower),
    };
}

/** Write one preference and notify this tab's subscribers (other tabs hear it through storage). */
export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
    writeFlag(PREFS_KEY, PREF_FIELDS[key], PREF_FIELDS[key], value);
    notifyPrefs();
}

/**
 * Subscribe to preference changes — this tab's `setPref` calls and, in
 * storage mode, other tabs' writes. Returns an unsubscribe function.
 */
export function onPrefsChange(callback: (prefs: Prefs) => void): () => void {
    installStorageListener();
    prefsListeners.add(callback);
    return () => { prefsListeners.delete(callback); };
}

/** True once the Settings notice's Got-it button has been clicked on this device. */
export function isOptionsSeen(): boolean {
    return readFlag(META_KEY, OPTIONS_SEEN_FIELD, OPTIONS_SEEN_URL_KEY);
}

/** Record the Got-it click (the notice then stops appearing on load). */
export function markOptionsSeen(): void {
    writeFlag(META_KEY, OPTIONS_SEEN_FIELD, OPTIONS_SEEN_URL_KEY, true);
    notifySeen();
}

/** Subscribe to the Got-it acknowledgement — from this tab or another. Returns an unsubscribe function. */
export function onOptionsSeen(callback: () => void): () => void {
    installStorageListener();
    seenListeners.add(callback);
    return () => { seenListeners.delete(callback); };
}

/**
 * "Forget all settings on this device" — everything, for all three apps:
 * remove every `ec:*` key from local and session storage (app-state's
 * namespaces, slots, meta, prefs, the last-Chronometer-page record) and
 * this module's memory state. The caller
 * reloads with a clean URL afterwards, which also drops url-mode state.
 */
export function forgetAllSettings(): void {
    for (const store of [localStorage, sessionStorage]) {
        try {
            const keys: string[] = [];
            for (let i = 0; i < store.length; i++) {
                const k = store.key(i);
                if (k && k.startsWith(STORAGE_PREFIX)) keys.push(k);
            }
            for (const k of keys) store.removeItem(k);
        } catch { /* storage unavailable — nothing of ours is in it */ }
    }
    memFlags = {};
}

// --- Internal exports for unit tests (not part of the public API) ---
export const __test__ = {
    PREFS_KEY,
    META_KEY,
    /** Forget the decided mode and memory state, and drop all subscribers. */
    reset(): void {
        mode = null;
        memFlags = {};
        prefsListeners.clear();
        seenListeners.clear();
    },
    currentMode,
    /** Pin the mode (jsdom cannot pretend to be file:// or break storage cleanly). */
    forceMode(m: Mode | null): void { mode = m; },
};
