// @vitest-environment jsdom
import { describe, test, expect, beforeEach } from 'vitest';
import { storageWorks, __test__ } from '../shared/app-state.js';
import { buildShareUrl } from '../shared/url-state.js';

const {
    namespaceOf, isDefaultValue, LocalStorageBackend, InMemoryBackend, STORAGE_KEY_PREFIX,
    hasShareableParamsInUrl, shareableUrlEqualsStored, clearShareableParamsFromUrl,
} = __test__;

function clearStorage() {
    localStorage.clear();
    // Reset the URL so URL-only fields default cleanly.
    window.history.replaceState(null, '', '/');
}

beforeEach(clearStorage);

describe('namespaceOf', () => {
    test('shared location/time fields route to shared', () => {
        for (const f of ['lat', 'lon', 'city', 'tz', 'bloc', 't', 'off', 'dir'] as const) {
            expect(namespaceOf(f, 'chronometer')).toBe('shared');
            expect(namespaceOf(f, 'observatory')).toBe('shared');
            expect(namespaceOf(f, 'inspector')).toBe('shared');
        }
    });

    test('app-specific fields route to their fixed namespace', () => {
        expect(namespaceOf('kyhand', 'inspector')).toBe('chronometer');
        expect(namespaceOf('kmode', 'chronometer')).toBe('chronometer');
        expect(namespaceOf('op', 'chronometer')).toBe('observatory');
        expect(namespaceOf('onoon', 'inspector')).toBe('observatory');
    });

    test('tp is per-app', () => {
        expect(namespaceOf('tp', 'chronometer')).toBe('chronometer');
        expect(namespaceOf('tp', 'observatory')).toBe('observatory');
        expect(namespaceOf('tp', 'inspector')).toBe('inspector');
        expect(namespaceOf('tp', 'index')).toBeNull();
    });

    test('URL-only fields are never persisted', () => {
        expect(namespaceOf('embed', 'chronometer')).toBeNull();
        expect(namespaceOf('fps', 'observatory')).toBeNull();
        expect(namespaceOf('tc', 'inspector')).toBeNull();
        // picks flows via URL navigation (Phase 6 will migrate it to storage).
        expect(namespaceOf('picks', 'chronometer')).toBeNull();
    });
});

describe('isDefaultValue', () => {
    test('null/undefined are default', () => {
        expect(isDefaultValue('lat', null)).toBe(true);
        expect(isDefaultValue('city', undefined)).toBe(true);
    });
    test('field-specific defaults', () => {
        expect(isDefaultValue('dir', 1)).toBe(true);
        expect(isDefaultValue('dir', -1)).toBe(false);
        expect(isDefaultValue('tp', 'd')).toBe(true);
        expect(isDefaultValue('tp', 'a')).toBe(false);
        expect(isDefaultValue('bloc', false)).toBe(true);
        expect(isDefaultValue('bloc', true)).toBe(false);
        expect(isDefaultValue('op', 0)).toBe(true);
        expect(isDefaultValue('op', 3)).toBe(false);
        expect(isDefaultValue('onoon', false)).toBe(true);
    });
    test('non-default scalar values are kept', () => {
        expect(isDefaultValue('lat', 37.7)).toBe(false);
        expect(isDefaultValue('t', 123456)).toBe(false);
    });
});

describe('smoke test', () => {
    test('returns true when localStorage works', () => {
        expect(storageWorks()).toBe(true);
        // Probe key must be cleaned up afterward.
        expect(localStorage.getItem(STORAGE_KEY_PREFIX + '__probe__')).toBeNull();
    });
});

describe('LocalStorageBackend', () => {
    test('write routes fields to the correct namespaces', () => {
        const be = new LocalStorageBackend('chronometer');
        be.write({ lat: 37.7, lon: -122.4, city: 'San Francisco', kyhand: '1', tp: 'a' });

        const shared = JSON.parse(localStorage.getItem(STORAGE_KEY_PREFIX + 'shared')!);
        expect(shared.lat).toBe(37.7);
        expect(shared.lon).toBe(-122.4);
        expect(shared.city).toBe('San Francisco');
        expect('kyhand' in shared).toBe(false);

        const chrono = JSON.parse(localStorage.getItem(STORAGE_KEY_PREFIX + 'chronometer')!);
        expect(chrono.kyhand).toBe('1');
        expect(chrono.tp).toBe('a');
    });

    test('picks is not persisted — it stays URL-driven (transitional)', () => {
        const be = new LocalStorageBackend('chronometer');
        be.write({ picks: 'bbmk' });
        expect(localStorage.getItem(STORAGE_KEY_PREFIX + 'chronometer')).toBeNull();
        // Read sources picks from the URL, not storage.
        window.history.replaceState(null, '', '/?picks=mktr');
        expect(be.read().picks).toBe('mktr');
    });

    test('read merges shared + app namespaces over defaults', () => {
        const be = new LocalStorageBackend('observatory');
        be.write({ lat: 10, lon: 20, op: 3, onoon: true });
        const state = be.read();
        expect(state.lat).toBe(10);
        expect(state.lon).toBe(20);
        expect(state.op).toBe(3);
        expect(state.onoon).toBe(true);
        // Untouched fields keep their defaults.
        expect(state.dir).toBe(1);
        expect(state.tp).toBe('d');
        expect(state.city).toBeNull();
    });

    test('observatory does not see chronometer-namespaced fields', () => {
        new LocalStorageBackend('chronometer').write({ kyhand: '1', kmode: '1' });
        const obs = new LocalStorageBackend('observatory').read();
        expect(obs.kyhand).toBeNull();
        expect(obs.kmode).toBeNull();
    });

    test('default values are omitted / removed from storage', () => {
        const be = new LocalStorageBackend('observatory');
        be.write({ op: 3 });
        expect(localStorage.getItem(STORAGE_KEY_PREFIX + 'observatory')).not.toBeNull();
        // Setting back to the default (Sun = 0) removes the now-empty namespace.
        be.write({ op: 0 });
        expect(localStorage.getItem(STORAGE_KEY_PREFIX + 'observatory')).toBeNull();
    });

    test('round-trips a representative state', () => {
        const be = new LocalStorageBackend('chronometer');
        be.write({ lat: 51.5, lon: -0.13, city: 'London', tz: 'Europe/London', t: 1700000000000, dir: -1, kyhand: '1' });
        const s = be.read();
        expect(s.lat).toBe(51.5);
        expect(s.lon).toBe(-0.13);
        expect(s.city).toBe('London');
        expect(s.tz).toBe('Europe/London');
        expect(s.t).toBe(1700000000000);
        expect(s.dir).toBe(-1);
        expect(s.kyhand).toBe('1');
    });

    test('URL-only fields come from the URL, not storage', () => {
        window.history.replaceState(null, '', '/?fps&embed=1&picks=bbmk');
        const s = new LocalStorageBackend('chronometer').read();
        expect(s.fps).toBe(true);
        expect(s.embed).toBe(true);
        expect(s.picks).toBe('bbmk');
    });
});

describe('incoming-settings detection', () => {
    test('hasShareableParamsInUrl detects shareable keys, ignores fps/embed/picks', () => {
        window.history.replaceState(null, '', '/?fps&embed=1&picks=bbmk');
        expect(hasShareableParamsInUrl()).toBe(false);
        window.history.replaceState(null, '', '/?lat=10&lon=20');
        expect(hasShareableParamsInUrl()).toBe(true);
        window.history.replaceState(null, '', '/?tp=a');
        expect(hasShareableParamsInUrl()).toBe(true);
    });

    test('shareableUrlEqualsStored is true only when URL matches storage', () => {
        const ls = new LocalStorageBackend('observatory');
        ls.write({ lat: 10, lon: 20, op: 3 });
        window.history.replaceState(null, '', '/?lat=10&lon=20&op=3');
        expect(shareableUrlEqualsStored(ls)).toBe(true);
        window.history.replaceState(null, '', '/?lat=10&lon=20&op=5');
        expect(shareableUrlEqualsStored(ls)).toBe(false);
    });

    test('clearShareableParamsFromUrl strips shareable params, keeps fps/picks', () => {
        window.history.replaceState(null, '', '/?lat=10&lon=20&op=3&fps&picks=bbmk');
        clearShareableParamsFromUrl();
        const p = new URLSearchParams(window.location.search);
        expect(p.has('lat')).toBe(false);
        expect(p.has('op')).toBe(false);
        expect(p.has('fps')).toBe(true);
        expect(p.has('picks')).toBe(true);
    });
});

describe('buildShareUrl', () => {
    const base = 'https://example.com/observatory.html';
    const defaults = __test__.defaultState();

    test('includes location and rounds lat/lon to 3 dp', () => {
        const u = new URL(buildShareUrl({ ...defaults, lat: 48.8566, lon: 2.3522, city: 'Paris' }, base));
        expect(u.searchParams.get('lat')).toBe('48.857');
        expect(u.searchParams.get('lon')).toBe('2.352');
        expect(u.searchParams.get('city')).toBe('Paris');
    });

    test('omits time for a live real-time clock', () => {
        const u = new URL(buildShareUrl({ ...defaults, lat: 1, lon: 2 }, base));
        expect(u.searchParams.has('t')).toBe(false);
        expect(u.searchParams.has('off')).toBe(false);
        expect(u.searchParams.has('dir')).toBe(false);
    });

    test('includes time when stopped/offset/reversed', () => {
        const stopped = new URL(buildShareUrl({ ...defaults, t: 1700000000000, dir: 0 }, base));
        expect(stopped.searchParams.get('t')).toBe('1700000000000');
        expect(stopped.searchParams.get('dir')).toBe('0');
        const offset = new URL(buildShareUrl({ ...defaults, off: 3600000 }, base));
        expect(offset.searchParams.get('off')).toBe('3600000');
    });

    test('includes bloc and app config, excludes fps/embed/tc', () => {
        const u = new URL(buildShareUrl({
            ...defaults, bloc: true, op: 3, onoon: true, tp: 'a', picks: 'bbmk',
            kyhand: '1', fps: true, embed: true, tc: true,
        }, base));
        expect(u.searchParams.get('bloc')).toBe('1');
        expect(u.searchParams.get('op')).toBe('3');
        expect(u.searchParams.get('onoon')).toBe('1');
        expect(u.searchParams.get('tp')).toBe('a');
        expect(u.searchParams.get('picks')).toBe('bbmk');
        expect(u.searchParams.get('kyhand')).toBe('1');
        expect(u.searchParams.has('fps')).toBe(false);
        expect(u.searchParams.has('embed')).toBe(false);
        expect(u.searchParams.has('tc')).toBe(false);
    });

    test('omits default op (Sun=0)', () => {
        const u = new URL(buildShareUrl({ ...defaults, op: 0 }, base));
        expect(u.searchParams.has('op')).toBe(false);
    });
});

describe('InMemoryBackend', () => {
    test('holds state in memory and never writes localStorage', () => {
        const be = new InMemoryBackend();
        be.write({ lat: 1, lon: 2, op: 5 });
        const s = be.read();
        expect(s.lat).toBe(1);
        expect(s.lon).toBe(2);
        expect(s.op).toBe(5);
        // Nothing persisted.
        expect(localStorage.length).toBe(0);
    });

    test('ignores URL-only fields on write but reflects them from the URL', () => {
        window.history.replaceState(null, '', '/?fps');
        const be = new InMemoryBackend();
        be.write({ embed: true });
        const s = be.read();
        expect(s.fps).toBe(true); // from URL
    });
});
