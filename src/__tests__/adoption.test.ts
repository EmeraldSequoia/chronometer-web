// @vitest-environment jsdom
/**
 * Adopting an incoming link as the default ("Save as my default").
 *
 * Two rules are pinned here:
 *
 *  1. **The location group.** `lat/lon/city/tz/bloc/lsrc` describe one place.
 *     Merging them field by field — which is right for slots, picks and time —
 *     is what left a hand-typed `?lat&lon` link wearing the *previous*
 *     location's city name, timezone and follow-the-device flag after a Save.
 *     A link that carries coordinates now carries the whole location.
 *  2. **Adoption is observable.** Everything the apps derive automatically is
 *     gated on `isPersistentMode()`, so a session that only *becomes*
 *     persistent has to be told; `onAdoptedAsDefault` is that signal, and it
 *     also re-syncs links built from the now-cleared query string.
 *
 * Style follows app-state.test.ts: seed localStorage, `history.replaceState`,
 * `initAppState`, click the modal, flush.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
    initAppState, getState, setState, isPersistentMode,
    onAdoptedAsDefault, setSlotOverrides, getSlotOverrides,
} from '../shared/app-state.js';

const SHARED_KEY = 'ec:shared';

/** Let promptIncomingSettings run and the modal render / resolve. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function storedShared(): Record<string, unknown> | null {
    const raw = localStorage.getItem(SHARED_KEY);
    return raw === null ? null : JSON.parse(raw);
}

function seedShared(fields: Record<string, unknown>): void {
    localStorage.setItem(SHARED_KEY, JSON.stringify({ ...fields, v: 1 }));
}

function modalButton(choice: 'save' | 'session'): HTMLElement | null {
    const sel = choice === 'save' ? '.ec-modal-btn.ec-primary' : '.ec-modal-btn:not(.ec-primary)';
    return document.querySelector(sel);
}

/** Open `url` and answer the incoming-settings prompt. */
async function open(url: string, choice: 'save' | 'session' = 'save'): Promise<void> {
    window.history.replaceState(null, '', url);
    initAppState({ app: 'chronometer' });
    await flush();
    const btn = modalButton(choice);
    expect(btn, 'the incoming-settings prompt should be showing').not.toBeNull();
    btn!.click();
    await flush();
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    window.history.replaceState(null, '', '/');
    // The paradigm notice is a one-shot on the clean-URL path; keep it quiet.
    localStorage.setItem('ec:meta', JSON.stringify({ noticeSeen: true, v: 1 }));
});

// ============================================================================
// 1. The location group
// ============================================================================

describe('adoption — the location group replaces, it does not merge', () => {
    test('a lat/lon-only link drops the old city, timezone and bloc', async () => {
        seedShared({ lat: 37.335, lon: -122.009, city: 'Cupertino', tz: 'America/Los_Angeles', lsrc: 'city', bloc: true });
        await open('/terra.html?lat=40.7&lon=-74.0');

        // city/tz are null and bloc false, which mergeNamespace deletes: the next
        // load re-derives both through each app's backstops.
        expect(storedShared()).toEqual({ lat: 40.7, lon: -74, lsrc: 'manual', v: 1 });
        expect(new URLSearchParams(window.location.search).has('lat')).toBe(false);
        expect(isPersistentMode()).toBe(true);
    });

    test('a full Share link adopts exactly the fields it carries', async () => {
        seedShared({ lat: 37.335, lon: -122.009, city: 'Cupertino', tz: 'America/Los_Angeles', lsrc: 'city' });
        await open('/terra.html?lat=51.5&lon=-0.12&city=Lambeth&tz=Europe%2FLondon&lsrc=map');

        expect(storedShared()).toEqual({
            lat: 51.5, lon: -0.12, city: 'Lambeth', tz: 'Europe/London', lsrc: 'map', v: 1,
        });
    });

    test('a bloc link keeps follow-the-device and records lsrc:browser', async () => {
        seedShared({ lat: 37.335, lon: -122.009, city: 'Cupertino', lsrc: 'city' });
        await open('/terra.html?lat=40.7&lon=-74.0&bloc=1');

        expect(storedShared()).toEqual({ lat: 40.7, lon: -74, bloc: true, lsrc: 'browser', v: 1 });
    });

    test('an eclipse-table deep link keeps its timezone and records lsrc:manual', async () => {
        // eclipse-table-page emits lat/lon/tz/t/dir and no city/lsrc.
        seedShared({ lat: 37.335, lon: -122.009, city: 'Cupertino', lsrc: 'city' });
        await open('/terra.html?lat=-33.9&lon=18.4&tz=Africa%2FJohannesburg&dir=0');

        const s = storedShared()!;
        expect(s.lat).toBe(-33.9);
        expect(s.tz).toBe('Africa/Johannesburg');
        expect(s.lsrc).toBe('manual');
        expect(s.city).toBeUndefined();   // backfilled from the DB on the next load
    });

    test('lsrc is written explicitly, so a later backfilled city is not read as a city pick', async () => {
        await open('/terra.html?lat=40.7&lon=-74.0');
        // The reverse-geocode adds a name for display; provenance must stay 'manual'.
        setState({ city: 'Brooklyn Heights' });
        expect(storedShared()!.lsrc).toBe('manual');
    });

    test('a lon-only link clears the whole location rather than pairing a new lon with the old lat', async () => {
        seedShared({ lat: 37.335, lon: -122.009, city: 'Cupertino', lsrc: 'city' });
        await open('/terra.html?lon=-74.0');

        const s = storedShared()!;
        expect(s.lat).toBeUndefined();
        expect(s.lon).toBe(-74);
        expect(s.city).toBeUndefined();
    });
});

describe('adoption — non-location links still merge', () => {
    test('a slots-only link leaves the stored location untouched', async () => {
        seedShared({ lat: 37.335, lon: -122.009, city: 'Cupertino', tz: 'America/Los_Angeles', lsrc: 'city' });
        await open('/terra.html?r5=Denver&r5tz=America%2FDenver');

        expect(storedShared()).toEqual({
            lat: 37.335, lon: -122.009, city: 'Cupertino', tz: 'America/Los_Angeles', lsrc: 'city', v: 1,
        });
        expect(getSlotOverrides().r5).toBe('Denver');
    });

    test('a picks-only link leaves the stored location untouched', async () => {
        seedShared({ lat: 37.335, lon: -122.009, city: 'Cupertino', lsrc: 'city' });
        await open('/index.html?picks=bbmk');

        expect(storedShared()).toEqual({ lat: 37.335, lon: -122.009, city: 'Cupertino', lsrc: 'city', v: 1 });
        expect(getState().picks).toBe('bbmk');   // picks live in the chronometer namespace
    });

    test('a time-only link leaves the stored location untouched', async () => {
        seedShared({ lat: 37.335, lon: -122.009, city: 'Cupertino', lsrc: 'city' });
        await open('/terra.html?t=1700000000000');

        const s = storedShared()!;
        expect(s.city).toBe('Cupertino');
        expect(s.t).toBe(1700000000000);
    });
});

// ============================================================================
// 2. The adoption hook
// ============================================================================

describe('onAdoptedAsDefault', () => {
    test('fires once, after storage is written and the URL cleaned', async () => {
        const seen: Array<{ persistent: boolean; lat: number | null; urlHasLat: boolean }> = [];
        const off = onAdoptedAsDefault(() => {
            seen.push({
                persistent: isPersistentMode(),
                lat: getState().lat,
                urlHasLat: new URLSearchParams(window.location.search).has('lat'),
            });
        });
        await open('/terra.html?lat=40.7&lon=-74.0');
        off();

        expect(seen).toEqual([{ persistent: true, lat: 40.7, urlHasLat: false }]);
    });

    test('unsubscribing stops the callbacks', async () => {
        const cb = vi.fn();
        onAdoptedAsDefault(cb)();
        await open('/terra.html?lat=40.7&lon=-74.0');
        expect(cb).not.toHaveBeenCalled();
    });

    test('one listener throwing does not stop the others', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const later = vi.fn();
        const offA = onAdoptedAsDefault(() => { throw new Error('boom'); });
        const offB = onAdoptedAsDefault(later);
        await open('/terra.html?lat=40.7&lon=-74.0');
        offA(); offB();

        expect(later).toHaveBeenCalledTimes(1);
        expect(err).toHaveBeenCalled();
        err.mockRestore();
    });

    test('the first-edit re-prompt fires it too', async () => {
        const cb = vi.fn();
        const off = onAdoptedAsDefault(cb);
        await open('/terra.html?lat=40.7&lon=-74.0', 'session');
        expect(cb).not.toHaveBeenCalled();
        expect(isPersistentMode()).toBe(false);

        setState({ kmode: 'x' });              // first non-time edit → re-prompt
        await flush();
        modalButton('save')!.click();
        await flush();
        off();

        expect(cb).toHaveBeenCalledTimes(1);
        expect(isPersistentMode()).toBe(true);
    });

    test('a session-only visit never fires it', async () => {
        const cb = vi.fn();
        const off = onAdoptedAsDefault(cb);
        await open('/terra.html?lat=40.7&lon=-74.0', 'session');
        off();
        expect(cb).not.toHaveBeenCalled();
    });
});

describe('adoption re-syncs navigation links', () => {
    test('back-link and face cards lose the params that were just saved', async () => {
        document.body.innerHTML = `
            <a id="back-link" href="index.html?lat=40.7&lon=-74.0">Home</a>
            <a class="face-card" href="terra.html?lat=40.7&lon=-74.0">Terra</a>
            <a class="face-card" href="gaia.html?lat=40.7&lon=-74.0">Gaia</a>`;
        await open('/index.html?lat=40.7&lon=-74.0');

        const hrefs = [...document.querySelectorAll<HTMLAnchorElement>('#back-link, a.face-card')].map(a => a.href);
        expect(hrefs).toHaveLength(3);
        for (const href of hrefs) expect(href).not.toContain('lat=');
        expect(hrefs[1]).toContain('terra.html');
        expect(hrefs[2]).toContain('gaia.html');
    });
});

// ============================================================================
// 3. Slot edits re-prompt like any other edit
// ============================================================================

describe('session-only slot edits', () => {
    test('a Terra/Gaia city pick offers to save, like every other setting', async () => {
        await open('/terra.html?lat=40.7&lon=-74.0', 'session');
        expect(modalButton('save')).toBeNull();

        setSlotOverrides({ r5: 'Denver' });
        await flush();
        expect(modalButton('save'), 'the first slot edit should re-prompt').not.toBeNull();

        modalButton('save')!.click();
        await flush();
        expect(isPersistentMode()).toBe(true);
        // The pick was made against the URL, so it travels with the adoption.
        expect(getSlotOverrides().r5).toBe('Denver');
    });

    test('it re-prompts only once', async () => {
        await open('/terra.html?lat=40.7&lon=-74.0', 'session');
        setSlotOverrides({ r5: 'Denver' });
        await flush();
        modalButton('session')!.click();       // decline
        await flush();

        setSlotOverrides({ r7: 'Boston' });
        await flush();
        expect(modalButton('save')).toBeNull();
    });
});
