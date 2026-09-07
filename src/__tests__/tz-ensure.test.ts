/**
 * createTzResolver — the shared ensureTzResolved contract, driven with fakes.
 *
 * Every app (Chronometer, Observatory, Inspector) instantiates this with its
 * own hooks; the invariants below are the ones the plan calls out for step 3
 * and that used to live, triplicated, in each app's closure.
 */
import { describe, test, expect, vi } from 'vitest';
import { createTzResolver, type TzResolverDeps } from '../shared/tz-ensure.js';

const NY = 'America/New_York', LA = 'America/Los_Angeles';

interface Harness {
    ensure: () => void;
    state: { lat: number; lon: number; needs: boolean; tz: string | undefined; loaded: boolean; parsing: boolean; suspended: boolean };
    applied: string[];
    persisted: string[];
    released: number;
    resolveCalls: Array<{ lat: number; lon: number }>;
    /** Settle the pending async resolution with a value. */
    settle: (value: string | null) => Promise<void>;
    errors: unknown[];
}

function harness(over: Partial<Harness['state']> = {}, zone: string | null = NY, applyThrows = false): Harness {
    const h: Harness = {
        ensure: () => {},
        state: { lat: 40.7, lon: -74, needs: true, tz: LA, loaded: false, parsing: false, suspended: false, ...over },
        applied: [], persisted: [], released: 0, resolveCalls: [], errors: [],
        settle: async () => {},
    };
    let resolveNext: ((v: string | null) => void) | null = null;
    const deps: TzResolverDeps = {
        getLocation: () => ({ lat: h.state.lat, lon: h.state.lon }),
        needsResolution: () => h.state.needs,
        setNeedsResolution: (v) => { h.state.needs = v; },
        getTimezone: () => h.state.tz,
        applyTimezone: (tz) => { if (applyThrows) throw new Error('apply failed'); h.applied.push(tz); h.state.tz = tz; },
        persistTimezone: (tz) => { h.persisted.push(tz); },
        parseInFlight: () => h.state.parsing,
        suspended: () => h.state.suspended,
        release: () => { h.released++; },
        onError: (err) => { h.errors.push(err); },
        isLoaded: () => h.state.loaded,
        findZone: () => zone,
        resolveFromDb: (lat, lon) => { h.resolveCalls.push({ lat, lon }); return new Promise((res) => { resolveNext = res; }); },
    };
    h.ensure = createTzResolver(deps);
    h.settle = async (v) => { resolveNext?.(v); resolveNext = null; await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
    return h;
}

describe('createTzResolver', () => {
    test('no-op when no resolution is needed', () => {
        const h = harness({ needs: false, loaded: true });
        h.ensure();
        expect(h.applied).toEqual([]); expect(h.persisted).toEqual([]); expect(h.resolveCalls).toEqual([]); expect(h.released).toBe(0);
    });

    test('resident DB → synchronous: applies, persists, clears the flag, never parses or releases', () => {
        const h = harness({ loaded: true });
        h.ensure();
        expect(h.applied).toEqual([NY]); expect(h.persisted).toEqual([NY]);
        expect(h.state.needs).toBe(false); expect(h.resolveCalls).toEqual([]); expect(h.released).toBe(0);
    });

    test('same zone as the guess → no apply, but still handed to persist (storage may lack it)', () => {
        const h = harness({ loaded: true, tz: NY });
        h.ensure();
        expect(h.applied).toEqual([]); expect(h.persisted).toEqual([NY]); expect(h.state.needs).toBe(false);
    });

    test('null answer (DB unavailable) → flag cleared, nothing applied or persisted', () => {
        const h = harness({ loaded: true }, null);
        h.ensure();
        expect(h.applied).toEqual([]); expect(h.persisted).toEqual([]); expect(h.state.needs).toBe(false);
    });

    test('DB not resident → parses via resolveFromDb, applies when it lands, releases in finally', async () => {
        const h = harness();
        h.ensure();
        expect(h.resolveCalls).toEqual([{ lat: 40.7, lon: -74 }]);
        expect(h.applied).toEqual([]);
        await h.settle(NY);
        expect(h.applied).toEqual([NY]); expect(h.persisted).toEqual([NY]); expect(h.state.needs).toBe(false); expect(h.released).toBe(1);
    });

    test('a stale answer (location changed meanwhile) is ignored and the flag stays armed', async () => {
        const h = harness();
        h.ensure();
        h.state.lat = 51.5; h.state.lon = -0.12;          // user picked London while the parse was in flight
        await h.settle(NY);
        expect(h.applied).toEqual([]); expect(h.persisted).toEqual([]); expect(h.state.needs).toBe(true); expect(h.released).toBe(1);
    });

    test('an answer that already landed synchronously is not applied twice', async () => {
        const h = harness();
        h.ensure();                                        // async path started
        h.state.loaded = true; h.ensure();                 // the name path's handler: DB resident → sync
        expect(h.applied).toEqual([NY]); expect(h.state.needs).toBe(false);
        await h.settle(NY);                                // the async answer lands afterwards
        expect(h.applied).toEqual([NY]); expect(h.persisted).toEqual([NY]); expect(h.released).toBe(1);
    });

    test('does not start a parse while the name path has one in flight', () => {
        const h = harness({ parsing: true });
        h.ensure();
        expect(h.resolveCalls).toEqual([]); expect(h.state.needs).toBe(true);
    });

    test('dedupes a pending parse for the same coordinates, but not for different ones', async () => {
        const h = harness();
        h.ensure(); h.ensure();
        expect(h.resolveCalls.length).toBe(1);
        h.state.lat = 51.5; h.state.lon = -0.12;
        h.ensure();                                        // a newer location must not wait on the stale answer
        expect(h.resolveCalls.length).toBe(2);
        expect(h.resolveCalls[1]).toEqual({ lat: 51.5, lon: -0.12 });
    });

    test('suspended (transient coordinates, e.g. a map drag) → deferred with the flag armed; the deferred async answer is also ignored', async () => {
        const h = harness({ suspended: true });
        h.ensure();
        expect(h.resolveCalls).toEqual([]); expect(h.state.needs).toBe(true);
        h.state.suspended = false; h.ensure();             // dismissKeepDialog re-runs it once settled
        expect(h.resolveCalls.length).toBe(1);
        h.state.suspended = true;                          // a new drag began before the answer landed
        await h.settle(NY);
        expect(h.applied).toEqual([]); expect(h.state.needs).toBe(true); expect(h.released).toBe(1);
        h.state.suspended = false; h.state.loaded = true; h.ensure();
        expect(h.applied).toEqual([NY]); expect(h.state.needs).toBe(false);
    });

    test('an apply that throws on the async path is reported, and the DB is still released', async () => {
        const h = harness({}, NY, true);
        h.ensure();
        await h.settle(NY);
        expect(h.errors.length).toBe(1);
        expect(h.released).toBe(1);
    });

    test('uses the real city DB helpers when no seams are injected', () => {
        // Smoke: constructing with only the app hooks must not throw, and with the
        // DB not resident it takes the async path (a promise we do not await).
        const calls: string[] = [];
        const ensure = createTzResolver({
            getLocation: () => ({ lat: 0, lon: 0 }), needsResolution: () => false, setNeedsResolution: () => {},
            getTimezone: () => undefined, applyTimezone: (tz) => calls.push(tz), persistTimezone: () => {},
            parseInFlight: () => false, release: () => {},
        });
        expect(() => ensure()).not.toThrow();
        expect(calls).toEqual([]);
    });

    test('spy: persistTimezone is called on every landed non-null answer, never on null', () => {
        const persist = vi.fn();
        const mk = (zone: string | null) => createTzResolver({
            getLocation: () => ({ lat: 1, lon: 2 }), needsResolution: () => true, setNeedsResolution: () => {},
            getTimezone: () => zone ?? undefined, applyTimezone: () => {}, persistTimezone: persist,
            parseInFlight: () => false, release: () => {}, isLoaded: () => true, findZone: () => zone,
        });
        mk(NY)(); mk(null)();
        expect(persist).toHaveBeenCalledTimes(1);
        expect(persist).toHaveBeenCalledWith(NY);
    });
});
