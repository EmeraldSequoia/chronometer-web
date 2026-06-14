/**
 * App State — the single front door for reading and writing persisted
 * application state (location, time, and per-app configuration).
 *
 * Historically all state lived in URL query parameters (see url-state.ts).
 * This module introduces a storage abstraction so the *default* persistence
 * mechanism can move to browser LocalStorage, while URL parameters remain the
 * mechanism for *sharing* a setup with another user or device.
 *
 * Three backends:
 *   - LocalStorageBackend — namespaced JSON in localStorage; keeps the URL clean.
 *   - UrlBackend          — today's behavior; used as the file:// fallback.
 *   - InMemoryBackend     — no persistence; used as the http(s) fallback so a
 *                           user's location can't leak into history/server logs.
 *
 * Phase 1-2 status: this module is wired in and all consumers go through
 * getState()/setState(), but the active backend is forced to UrlBackend
 * (LOCALSTORAGE_ENABLED = false) so behavior is identical to before. Phase 3
 * flips the flag and adds the startup decision tree + incoming-settings dialog.
 *
 * See planning/2026-06-13-localstorage-state-and-sharing.md.
 */

import { readUrlState, writeUrlState, type UrlState } from './url-state.js';
import { showIncomingSettingsDialog, showStorageWarning } from './incoming-settings-dialog.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Master switch for the LocalStorage migration. While false, initAppState()
 * always selects UrlBackend and behavior is identical to the URL-only era.
 */
const LOCALSTORAGE_ENABLED = true;

/** Schema version stamped into each stored blob, for future migrations. */
const SCHEMA_VERSION = 1;

/** Identifies which app (and thus which per-app storage namespace) is running. */
export type AppName = 'chronometer' | 'observatory' | 'inspector' | 'index' | 'pick';

/** LocalStorage namespace keys. */
type Namespace = 'shared' | 'chronometer' | 'observatory' | 'inspector';

const STORAGE_KEY_PREFIX = 'ec:';

// ============================================================================
// Field → namespace routing
// ============================================================================

/**
 * Location + time fields shared across all three apps. Stored in `ec:shared`
 * so opening any app with no URL params shows the same time and location.
 */
const SHARED_FIELDS: ReadonlySet<keyof UrlState> = new Set([
    'lat', 'lon', 'city', 'tz', 'bloc', 't', 'off', 'dir',
]);

/**
 * URL-only fields. These are never persisted to storage; they are always read
 * from the URL (e.g. ?embed=1 for an iframe, ?fps for the diagnostic readout)
 * and `tc` (time-controller popover visibility) is transient.
 *
 * `picks` is here transitionally: face selection still flows via URL navigation
 * (pick.html → selected.html) until Phase 6 reworks that flow to use storage.
 * Treating it as URL-only keeps that navigation working and prevents an
 * internal `?picks=...` link from triggering the incoming-settings dialog.
 */
const URL_ONLY_FIELDS: ReadonlySet<keyof UrlState> = new Set([
    'embed', 'fps', 'tc', 'picks',
]);

/**
 * Resolve the storage namespace for a field. App-specific fields route to a
 * fixed app namespace except `tp` (the time-panel tab), which is per-app and
 * therefore routes to whichever app is currently running.
 *
 * Returns null for URL-only fields (which are never persisted).
 */
function namespaceOf(field: keyof UrlState, app: AppName): Namespace | null {
    if (URL_ONLY_FIELDS.has(field)) return null;
    if (SHARED_FIELDS.has(field)) return 'shared';
    switch (field) {
        case 'kyhand':
        case 'kmode':
            return 'chronometer';
        case 'op':
        case 'onoon':
            return 'observatory';
        case 'tp':
            // Per-app: chronometer/observatory/inspector each keep their own tab.
            return (app === 'index' || app === 'pick') ? null : app;
        default:
            return null;
    }
}

// ============================================================================
// Defaults — mirror readUrlState()'s default values
// ============================================================================

function defaultState(): UrlState {
    return {
        lat: null, lon: null, city: null, bloc: false, tc: false,
        t: null, off: null, dir: 1, tz: null, picks: null, tp: 'd',
        embed: false, fps: false, kyhand: null, kmode: null, op: null, onoon: false,
    };
}

/**
 * A field is "default" when readUrlState() would omit it from the URL. Such
 * values are deleted from storage rather than written, keeping blobs minimal
 * and round-tripping cleanly back to the same UrlState.
 */
function isDefaultValue(field: keyof UrlState, value: unknown): boolean {
    if (value === null || value === undefined) return true;
    switch (field) {
        case 'dir': return value === 1;
        case 'tp': return value === 'd';
        case 'bloc':
        case 'tc':
        case 'embed':
        case 'fps':
        case 'onoon':
            return value === false;
        case 'op': return value === 0;
        default: return false;
    }
}

// ============================================================================
// Backend interface
// ============================================================================

interface StateBackend {
    read(): UrlState;
    write(changes: Partial<UrlState>): void;
}

// ----------------------------------------------------------------------------
// UrlBackend — exactly today's behavior (file:// fallback / Phase 1-2 default)
// ----------------------------------------------------------------------------

class UrlBackend implements StateBackend {
    read(): UrlState {
        return readUrlState();
    }
    write(changes: Partial<UrlState>): void {
        writeUrlState(changes);
    }
}

// ----------------------------------------------------------------------------
// LocalStorageBackend — namespaced JSON; keeps the URL clean
// ----------------------------------------------------------------------------

class LocalStorageBackend implements StateBackend {
    constructor(private readonly app: AppName) {}

    read(): UrlState {
        const state = defaultState();
        // Shared location/time, then this app's own namespace, override defaults.
        Object.assign(state, readNamespace('shared'));
        const appNs = appNamespace(this.app);
        if (appNs) Object.assign(state, readNamespace(appNs));
        // URL-only fields are always sourced from the URL, even in storage mode.
        // (Applied last so they win over anything stored.)
        const url = readUrlState();
        for (const field of URL_ONLY_FIELDS) {
            (state as unknown as Record<string, unknown>)[field] = url[field];
        }
        return state;
    }

    write(changes: Partial<UrlState>): void {
        const buckets = new Map<Namespace, Partial<UrlState>>();
        for (const key of Object.keys(changes) as (keyof UrlState)[]) {
            const ns = namespaceOf(key, this.app);
            if (!ns) continue; // URL-only / not persisted
            let bucket = buckets.get(ns);
            if (!bucket) { bucket = {}; buckets.set(ns, bucket); }
            (bucket as Record<string, unknown>)[key] = changes[key];
        }
        for (const [ns, bucket] of buckets) {
            mergeNamespace(ns, bucket);
        }
    }
}

/** The own-namespace an app reads in addition to `shared`. */
function appNamespace(app: AppName): Namespace | null {
    switch (app) {
        case 'chronometer': return 'chronometer';
        case 'observatory': return 'observatory';
        case 'inspector': return 'inspector';
        // pick-page reads the chronometer picks; index reads shared only.
        case 'pick': return 'chronometer';
        case 'index': return null;
    }
}

function readNamespace(ns: Namespace): Partial<UrlState> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_PREFIX + ns);
        if (!raw) return {};
        const obj = JSON.parse(raw) as Record<string, unknown>;
        delete obj.v;
        return obj as Partial<UrlState>;
    } catch {
        return {};
    }
}

function mergeNamespace(ns: Namespace, changes: Partial<UrlState>): void {
    const key = STORAGE_KEY_PREFIX + ns;
    let current: Record<string, unknown>;
    try {
        current = JSON.parse(localStorage.getItem(key) || '{}');
    } catch {
        current = {};
    }
    for (const field of Object.keys(changes) as (keyof UrlState)[]) {
        const value = changes[field];
        if (isDefaultValue(field, value)) {
            delete current[field];
        } else {
            current[field] = value as unknown;
        }
    }
    // Drop the version stamp when deciding whether any real data remains.
    delete current.v;
    if (Object.keys(current).length === 0) {
        localStorage.removeItem(key);
    } else {
        current.v = SCHEMA_VERSION;
        // setItem may throw (quota / revoked storage); the error propagates to
        // setState(), which downgrades to the InMemoryBackend and warns once.
        localStorage.setItem(key, JSON.stringify(current));
    }
}

// ----------------------------------------------------------------------------
// InMemoryBackend — http(s) fallback; no persistence, never touches the URL
// ----------------------------------------------------------------------------

class InMemoryBackend implements StateBackend {
    private state: UrlState;

    constructor(seed?: Partial<UrlState>) {
        this.state = { ...defaultState(), ...(seed || {}) };
    }

    read(): UrlState {
        // URL-only fields still come from the URL (e.g. ?embed, ?fps, ?picks).
        const url = readUrlState();
        const state = { ...this.state };
        for (const field of URL_ONLY_FIELDS) {
            (state as Record<string, unknown>)[field] = url[field];
        }
        return state;
    }

    write(changes: Partial<UrlState>): void {
        for (const key of Object.keys(changes) as (keyof UrlState)[]) {
            if (URL_ONLY_FIELDS.has(key)) continue;
            (this.state as unknown as Record<string, unknown>)[key] = changes[key];
        }
    }
}

// ============================================================================
// Smoke test
// ============================================================================

/**
 * Probe whether localStorage actually works: write a value, read it back,
 * delete it. Returns false on any exception (SecurityError, QuotaExceeded,
 * disabled storage) or value mismatch.
 */
export function storageWorks(): boolean {
    try {
        const k = STORAGE_KEY_PREFIX + '__probe__';
        localStorage.setItem(k, '1');
        const ok = localStorage.getItem(k) === '1';
        localStorage.removeItem(k);
        return ok;
    } catch {
        return false;
    }
}

// ============================================================================
// Shareable-parameter sets (for the incoming-settings decision tree)
// ============================================================================

/** Time-state fields. Changes to these never trigger the session re-prompt. */
const TIME_FIELDS: ReadonlySet<keyof UrlState> = new Set(['t', 'off', 'dir']);

/**
 * UrlState fields that constitute a "shareable setting" — used to decide
 * whether incoming URL params differ from the stored defaults. Excludes
 * URL-only fields (embed/fps/tc/picks).
 */
const SHAREABLE_FIELDS: readonly (keyof UrlState)[] = [
    'lat', 'lon', 'city', 'tz', 'bloc', 't', 'off', 'dir',
    'kyhand', 'kmode', 'op', 'onoon', 'tp',
];

/**
 * Raw URL query keys considered "shareable". Presence of any of these triggers
 * the incoming-settings flow. Excludes `picks` (internal pick-page navigation,
 * Phase 6), `tc` (transient), and `embed`/`fps` (URL-only flags).
 */
const SHAREABLE_URL_KEYS: readonly string[] = [
    'lat', 'lon', 'long', 'city', 'loc', 'tz', 'bloc',
    't', 'off', 'dir', 'kyhand', 'kmode', 'op', 'onoon', 'tp',
];

/** Query keys cleared from the URL when settings are adopted into storage. */
const CLEARED_URL_KEYS: readonly string[] = [...SHAREABLE_URL_KEYS, 'tc'];

function hasShareableParamsInUrl(): boolean {
    const params = new URLSearchParams(window.location.search);
    return SHAREABLE_URL_KEYS.some((k) => params.has(k));
}

/** True when the URL's shareable values match what's already stored. */
function shareableUrlEqualsStored(ls: LocalStorageBackend): boolean {
    const url = readUrlState();
    const stored = ls.read();
    return SHAREABLE_FIELDS.every((f) => url[f] === stored[f]);
}

/** Remove shareable params from the URL, preserving fps/embed/picks/unknowns. */
function clearShareableParamsFromUrl(): void {
    const params = new URLSearchParams(window.location.search);
    for (const k of CLEARED_URL_KEYS) params.delete(k);
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
}

// ============================================================================
// Module state + public API
// ============================================================================

let activeBackend: StateBackend | null = null;
let appName: AppName = 'index';
/** Armed in session-only mode; the first non-time edit re-prompts to save. */
let sessionRePromptArmed = false;
/** Ensures the "settings won't be saved" warning shows at most once. */
let warnedNoPersistence = false;

export interface InitAppStateOptions {
    /** Which app is running (selects the per-app storage namespace). */
    app: AppName;
}

/**
 * Initialize the state backend for this app. Must be called once at startup,
 * before the first getState()/setState().
 *
 * Runs the protocol-aware decision tree:
 *   - embed mode → URL-only.
 *   - storage broken → file:// falls back to URL params (leak-free); http(s)
 *     keeps state in memory only and warns once (never writes the URL).
 *   - storage OK → read from storage; if the URL carries shareable params that
 *     differ from storage, prompt the user (save-as-default vs session-only).
 */
export function initAppState(options: InitAppStateOptions): void {
    appName = options.app;

    if (!LOCALSTORAGE_ENABLED) {
        activeBackend = new UrlBackend();
        return;
    }

    if (readUrlState().embed) {
        activeBackend = new UrlBackend();
        return;
    }

    if (!storageWorks()) {
        if (window.location.protocol === 'file:') {
            // file:// has no server logs and never calls OSM — URL params are leak-free.
            activeBackend = new UrlBackend();
        } else {
            // http(s): never write the URL; keep state in memory only, warn once.
            activeBackend = new InMemoryBackend(readUrlState());
            warnNoPersistence();
        }
        return;
    }

    const ls = new LocalStorageBackend(appName);

    if (!hasShareableParamsInUrl()) {
        // Common case going forward: clean URL, read from storage.
        activeBackend = ls;
        return;
    }

    // The URL carries shareable params (a shared link or a legacy bookmark).
    if (shareableUrlEqualsStored(ls)) {
        // Identical to stored defaults — silently adopt and clean the URL.
        clearShareableParamsFromUrl();
        activeBackend = ls;
        return;
    }

    // Differ: show the shared values immediately (URL backend) and ask the user
    // asynchronously whether to keep them as defaults or just for this visit.
    activeBackend = new UrlBackend();
    void promptIncomingSettings(ls);
}

async function promptIncomingSettings(ls: LocalStorageBackend): Promise<void> {
    const choice = await showIncomingSettingsDialog({ mode: 'incoming' });
    if (choice === 'save') {
        adoptCurrentStateAsDefault(ls);
    } else {
        // Session-only: keep the URL params; re-prompt on the first non-time edit.
        sessionRePromptArmed = true;
    }
}

/** Persist the current effective state to storage, then clean the URL. */
function adoptCurrentStateAsDefault(ls: LocalStorageBackend): void {
    ls.write(getState());
    clearShareableParamsFromUrl();
    activeBackend = ls;
    sessionRePromptArmed = false;
}

function warnNoPersistence(): void {
    if (warnedNoPersistence) return;
    warnedNoPersistence = true;
    showStorageWarning("Your settings can't be saved in this browser and won't persist after you reload.");
}

/** Downgrade to in-memory state after a failed persist (e.g. quota exhausted). */
function downgradeToInMemory(): void {
    if (activeBackend instanceof InMemoryBackend) return;
    const seed = activeBackend ? activeBackend.read() : undefined;
    activeBackend = new InMemoryBackend(seed);
    warnNoPersistence();
}

function backend(): StateBackend {
    // Lazy default keeps call order forgiving if a consumer reads before init.
    if (!activeBackend) activeBackend = new UrlBackend();
    return activeBackend;
}

/** True when `changes` includes a persistable, non-time field. */
function hasNonTimePersistableChange(changes: Partial<UrlState>): boolean {
    return (Object.keys(changes) as (keyof UrlState)[]).some(
        (k) => !TIME_FIELDS.has(k) && namespaceOf(k, appName) !== null,
    );
}

/** Read the full merged application state. */
export function getState(): UrlState {
    return backend().read();
}

/** Write a partial set of state changes, routed to the active backend. */
export function setState(changes: Partial<UrlState>): void {
    try {
        backend().write(changes);
    } catch {
        // Persist failed mid-session — keep going in memory and replay the change.
        downgradeToInMemory();
        backend().write(changes);
    }

    // Session-only mode: the first edit that changes a non-time setting offers
    // to save the current state as the default (re-prompt on first edit).
    if (sessionRePromptArmed && hasNonTimePersistableChange(changes)) {
        sessionRePromptArmed = false;
        void promptSessionReprompt();
    }
}

async function promptSessionReprompt(): Promise<void> {
    const choice = await showIncomingSettingsDialog({ mode: 'reprompt' });
    if (choice === 'save') {
        adoptCurrentStateAsDefault(new LocalStorageBackend(appName));
    }
}

/**
 * Subscribe to cross-tab shared-state changes (Phase 5). No-op for the
 * URL/in-memory backends. Returns an unsubscribe function.
 */
export function onSharedChange(_callback: (state: UrlState) => void): () => void {
    // Implemented in Phase 5 (storage-event live sync).
    return () => {};
}

// Re-export the type so consumers can import everything state-related from here.
export type { UrlState };

// --- Internal exports for unit tests (not part of the public API) ---
export const __test__ = {
    namespaceOf,
    isDefaultValue,
    LocalStorageBackend,
    InMemoryBackend,
    UrlBackend,
    defaultState,
    STORAGE_KEY_PREFIX,
    hasShareableParamsInUrl,
    shareableUrlEqualsStored,
    clearShareableParamsFromUrl,
};
