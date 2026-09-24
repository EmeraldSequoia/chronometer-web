// @vitest-environment jsdom
/**
 * Keep screen awake (src/shared/wake-lock.ts): the lock follows the
 * preference and the page's visibility, and re-acquires after the browser
 * releases it on hide. A fake navigator.wakeLock stands in for the API.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { setPref, __test__ as prefsTest } from '../shared/prefs.js';
import { initKeepAwake, isWakeLockSupported, refreshWakeLock, __test__ } from '../shared/wake-lock.js';

type Listener = () => void;
interface FakeSentinel { release: () => Promise<void>; addEventListener: (type: string, cb: Listener) => void; fire: () => void }

let requests = 0;
let sentinels: FakeSentinel[] = [];

function makeSentinel(): FakeSentinel {
    const listeners: Listener[] = [];
    const s: FakeSentinel = {
        release: vi.fn(async () => { for (const l of listeners) l(); }),
        addEventListener: (_type, cb) => { listeners.push(cb); },
        fire: () => { for (const l of listeners) l(); },
    };
    sentinels.push(s);
    return s;
}

function installFakeApi(): void {
    Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: { request: vi.fn(async () => { requests++; return makeSentinel(); }) },
    });
}

function setVisibility(state: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    localStorage.clear();
    prefsTest.reset();
    __test__.reset();
    requests = 0;
    sentinels = [];
    setVisibility('visible');
});

afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).wakeLock;
    vi.restoreAllMocks();
});

describe('wake lock', () => {
    test('without the API nothing is offered or attempted', () => {
        expect(isWakeLockSupported()).toBe(false);
        initKeepAwake();
        refreshWakeLock();
        expect(__test__.held()).toBe(false);
    });

    test('acquires when the preference is on, releases when it is turned off', async () => {
        installFakeApi();
        expect(isWakeLockSupported()).toBe(true);
        initKeepAwake();
        await flush();
        expect(requests).toBe(0);
        setPref('keepAwake', true);
        await flush();
        expect(requests).toBe(1);
        expect(__test__.held()).toBe(true);
        setPref('keepAwake', false);
        await flush();
        expect(sentinels[0].release).toHaveBeenCalledTimes(1);
        expect(__test__.held()).toBe(false);
    });

    test('re-acquires after the browser releases it on hide', async () => {
        installFakeApi();
        setPref('keepAwake', true);
        initKeepAwake();
        await flush();
        expect(requests).toBe(1);
        // Hidden: the platform releases the sentinel itself.
        setVisibility('hidden');
        sentinels[0].fire();
        await flush();
        expect(__test__.held()).toBe(false);
        setVisibility('visible');
        await flush();
        expect(requests).toBe(2);
        expect(__test__.held()).toBe(true);
    });

    test('a preference turned off while the request is in flight releases the new sentinel', async () => {
        installFakeApi();
        setPref('keepAwake', true);
        initKeepAwake();          // request pending (async)
        setPref('keepAwake', false);
        await flush();
        expect(requests).toBe(1);
        expect(sentinels[0].release).toHaveBeenCalled();
        expect(__test__.held()).toBe(false);
    });
});
