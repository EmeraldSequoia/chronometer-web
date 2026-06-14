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

// ============================================================================
// Configuration
// ============================================================================

/**
 * Master switch for the LocalStorage migration. While false, initAppState()
 * always selects UrlBackend and behavior is identical to the URL-only era.
 * Phase 3 sets this true and introduces the incoming-settings dialog.
 */
const LOCALSTORAGE_ENABLED = false;

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
 */
const URL_ONLY_FIELDS: ReadonlySet<keyof UrlState> = new Set([
    'embed', 'fps', 'tc',
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
        case 'picks':
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
        // URL-only fields are always sourced from the URL, even in storage mode.
        const url = readUrlState();
        state.embed = url.embed;
        state.fps = url.fps;
        state.tc = url.tc;
        // Shared location/time, then this app's own namespace, override defaults.
        Object.assign(state, readNamespace('shared'));
        const appNs = appNamespace(this.app);
        if (appNs) Object.assign(state, readNamespace(appNs));
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
    try {
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
            localStorage.setItem(key, JSON.stringify(current));
        }
    } catch (err) {
        // Quota exhausted or storage revoked mid-session. Phase 3 will switch to
        // the InMemoryBackend and warn the user once; for now, surface to console.
        handleWriteFailure(err);
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
        // URL-only fields still come from the URL (e.g. ?embed, ?fps).
        const url = readUrlState();
        return { ...this.state, embed: url.embed, fps: url.fps, tc: url.tc };
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
// Module state + public API
// ============================================================================

let activeBackend: StateBackend | null = null;
let writeFailureHandler: ((err: unknown) => void) | null = null;

function handleWriteFailure(err: unknown): void {
    if (writeFailureHandler) writeFailureHandler(err);
    else console.warn('[app-state] persist failed:', err);
}

/**
 * Register a callback invoked (at most meaningfully once, by the caller's
 * contract) when a LocalStorage write fails mid-session. Phase 3 uses this to
 * switch to the InMemoryBackend and show a one-time "settings won't be saved"
 * warning.
 */
export function setWriteFailureHandler(fn: (err: unknown) => void): void {
    writeFailureHandler = fn;
}

export interface InitAppStateOptions {
    /** Which app is running (selects the per-app storage namespace). */
    app: AppName;
}

/**
 * Initialize the state backend for this app. Must be called once at startup,
 * before the first getState()/setState().
 *
 * Phase 1-2: always selects UrlBackend (LOCALSTORAGE_ENABLED is false), so
 * behavior is identical to the URL-only era. Phase 3 will run the protocol-aware
 * decision tree here.
 */
export function initAppState(options: InitAppStateOptions): void {
    if (!LOCALSTORAGE_ENABLED) {
        activeBackend = new UrlBackend();
        return;
    }
    // --- Phase 3+ (not yet active): protocol-aware backend selection ---
    if (storageWorks()) {
        activeBackend = new LocalStorageBackend(options.app);
    } else if (window.location.protocol === 'file:') {
        // file:// has no server logs and never calls OSM — URL params are leak-free.
        activeBackend = new UrlBackend();
    } else {
        // http(s): never write the URL; keep state in memory only, warn once.
        activeBackend = new InMemoryBackend();
    }
}

function backend(): StateBackend {
    // Lazy default keeps call order forgiving if a consumer reads before init.
    if (!activeBackend) activeBackend = new UrlBackend();
    return activeBackend;
}

/** Read the full merged application state. */
export function getState(): UrlState {
    return backend().read();
}

/** Write a partial set of state changes, routed to the active backend. */
export function setState(changes: Partial<UrlState>): void {
    backend().write(changes);
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
};
