// @vitest-environment jsdom
/**
 * Device preferences (src/shared/prefs.ts, docs/preferences.md).
 *
 * Pinned here: the three modes and what each writes; that a false flag is
 * deleted rather than stored; that this tab's writes and other tabs' storage
 * events both notify; that prefs never reach a share link and that
 * app-state's URL cleaning leaves the url-mode keys alone; that Forget removes
 * every `ec:*` key and nothing else.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    getPrefs, setPref, onPrefsChange, isOptionsSeen, markOptionsSeen, onOptionsSeen,
    forgetAllSettings, PREF_URL_KEYS, __test__,
} from '../shared/prefs.js';
import { buildShareUrl } from '../shared/url-state.js';
import { initAppState, getState, __test__ as appState } from '../shared/app-state.js';

const { PREFS_KEY, META_KEY } = __test__;

function stored(key: string): Record<string, unknown> | null {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    __test__.reset();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('storage mode', () => {
    test('defaults are off and nothing is stored until a preference is turned on', () => {
        expect(__test__.currentMode()).toBe('storage');
        expect(getPrefs()).toEqual({ keepAwake: false, lowPower: false });
        expect(stored(PREFS_KEY)).toBeNull();
    });

    test('a true flag is stored with the schema stamp; false deletes it and an empty blob is removed', () => {
        setPref('lowPower', true);
        expect(stored(PREFS_KEY)).toEqual({ lowpower: true, v: 1 });
        expect(getPrefs().lowPower).toBe(true);
        setPref('keepAwake', true);
        expect(stored(PREFS_KEY)).toEqual({ lowpower: true, awake: true, v: 1 });
        setPref('lowPower', false);
        expect(stored(PREFS_KEY)).toEqual({ awake: true, v: 1 });
        setPref('keepAwake', false);
        expect(stored(PREFS_KEY)).toBeNull();
    });

    test('this tab\'s writes notify subscribers with the new preferences; unsubscribe works', () => {
        const seen: boolean[] = [];
        const off = onPrefsChange((p) => seen.push(p.lowPower));
        setPref('lowPower', true);
        setPref('lowPower', false);
        off();
        setPref('lowPower', true);
        expect(seen).toEqual([true, false]);
    });

    test('another tab\'s write arrives through the storage event', () => {
        const seen: boolean[] = [];
        onPrefsChange((p) => seen.push(p.keepAwake));
        localStorage.setItem(PREFS_KEY, JSON.stringify({ awake: true, v: 1 }));
        window.dispatchEvent(new StorageEvent('storage', { key: PREFS_KEY, newValue: localStorage.getItem(PREFS_KEY) }));
        expect(seen).toEqual([true]);
        // Unrelated keys are ignored; a clear (null key) is not.
        window.dispatchEvent(new StorageEvent('storage', { key: 'ec:shared', newValue: '{}' }));
        expect(seen).toEqual([true]);
        localStorage.clear();
        window.dispatchEvent(new StorageEvent('storage', { key: null }));
        expect(seen).toEqual([true, false]);
    });

    test('the Got-it flag merges into ec:meta beside a legacy key and notifies', () => {
        // noticeSeen: the retired storage-paradigm notice's flag (2026-09-23),
        // still present on older devices — a write must leave it alone.
        localStorage.setItem(META_KEY, JSON.stringify({ noticeSeen: true, v: 1 }));
        expect(isOptionsSeen()).toBe(false);
        const cb = vi.fn();
        onOptionsSeen(cb);
        markOptionsSeen();
        expect(isOptionsSeen()).toBe(true);
        expect(stored(META_KEY)).toEqual({ noticeSeen: true, optionsSeen: true, v: 1 });
        expect(cb).toHaveBeenCalledTimes(1);
        // Acknowledged in another tab.
        __test__.reset();
        const cb2 = vi.fn();
        onOptionsSeen(cb2);
        window.dispatchEvent(new StorageEvent('storage', { key: META_KEY, newValue: localStorage.getItem(META_KEY) }));
        expect(cb2).toHaveBeenCalledTimes(1);
    });

    test('preferences never reach a share link', () => {
        initAppState({ app: 'chronometer' });
        setPref('lowPower', true);
        setPref('keepAwake', true);
        markOptionsSeen();
        const url = new URL(buildShareUrl(getState()));
        for (const k of PREF_URL_KEYS) expect(url.searchParams.has(k)).toBe(false);
        expect(window.location.search).toBe('');
    });

    test('a failed write downgrades to memory for the rest of the page', () => {
        setPref('keepAwake', true);
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
        setPref('lowPower', true);
        expect(__test__.currentMode()).toBe('memory');
        // The change took, and what was stored before is still in view.
        expect(getPrefs()).toEqual({ keepAwake: true, lowPower: true });
    });
});

describe('url mode (file:// without storage)', () => {
    beforeEach(() => { __test__.forceMode('url'); });

    test('flags ride the query string and nothing is written to storage', () => {
        setPref('lowPower', true);
        expect(window.location.search).toBe('?lowpower=1');
        expect(getPrefs()).toEqual({ keepAwake: false, lowPower: true });
        setPref('keepAwake', true);
        setPref('lowPower', false);
        expect(window.location.search).toBe('?awake=1');
        expect(stored(PREFS_KEY)).toBeNull();
        markOptionsSeen();
        expect(window.location.search).toBe('?awake=1&optseen=1');
        expect(isOptionsSeen()).toBe(true);
    });

    test('the face-page navigation links pick the flags up (updateNavigationLinks)', () => {
        document.body.innerHTML = '<a id="back-link" href="index.html">Home</a>';
        setPref('lowPower', true);
        const href = (document.getElementById('back-link') as HTMLAnchorElement).href;
        expect(new URL(href).searchParams.get('lowpower')).toBe('1');
        document.body.innerHTML = '';
    });

    test('app-state\'s URL cleaning and incoming-link detection ignore the pref keys', () => {
        window.history.replaceState(null, '', '/?lowpower=1&awake=1&optseen=1');
        expect(appState.hasShareableParamsInUrl()).toBe(false);
        window.history.replaceState(null, '', '/?lat=37.7&lon=-122.4&lowpower=1');
        appState.clearShareableParamsFromUrl();
        expect(window.location.search).toBe('?lowpower=1');
    });
});

describe('memory mode (http without storage)', () => {
    test('flags live for the page only: no storage key, no URL', () => {
        __test__.forceMode('memory');
        setPref('lowPower', true);
        markOptionsSeen();
        expect(getPrefs().lowPower).toBe(true);
        expect(isOptionsSeen()).toBe(true);
        expect(stored(PREFS_KEY)).toBeNull();
        expect(window.location.search).toBe('');
        __test__.reset();
        __test__.forceMode('memory');
        expect(getPrefs().lowPower).toBe(false);
    });
});

describe('forgetAllSettings', () => {
    test('removes every ec:* key from local and session storage and nothing else', () => {
        localStorage.setItem('ec:shared', '{"lat":1,"v":1}');
        localStorage.setItem('ec:observatory', '{"onoon":true,"v":1}');
        localStorage.setItem(PREFS_KEY, '{"lowpower":true,"v":1}');
        localStorage.setItem(META_KEY, '{"noticeSeen":true,"optionsSeen":true,"v":1}');
        localStorage.setItem('unrelated', 'keep');
        sessionStorage.setItem('ec:lastChronoPage', 'terra.html');
        sessionStorage.setItem('other', 'keep');
        forgetAllSettings();
        expect(Object.keys(localStorage)).toEqual(['unrelated']);
        expect(Object.keys(sessionStorage)).toEqual(['other']);
        expect(getPrefs()).toEqual({ keepAwake: false, lowPower: false });
        expect(isOptionsSeen()).toBe(false);
    });
});
