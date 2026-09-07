/**
 * deriveObserverSlots — the one derivation of the Terra/Gaia observer slot
 * tables (startup and every in-session location / timezone change).
 *
 * Pins: (1) the Terra global slot follows the observer's timezone — a
 * timezone change MUST change the derived slots, which is why a corrected
 * timezone goes through the location rebuild rather than the DST path (B6);
 * (2) the documented name priority; (3) Gaia slot 1 follows the timezone;
 * (4) the multi-slot tie-break prefers a slot the user has not overridden;
 * (5) the persistence contract end-to-end: the display table carries the
 * injected observer, the user map does not, and a user override OF the
 * observer slot survives serialize → parse → re-derive (the 1b invariant).
 */
import { describe, test, expect } from 'vitest';

import { deriveObserverSlots, resolveObserverName, type ObserverSlotContext } from '../watch/observer-slots.js';
import { serializeTerraOverrides, parseTerraUserOverrides, validSlotsForTz } from '../watch/terra-slots.js';
import { TERRA_RING_DEFAULTS, GAIA_SUBDIAL_DEFAULTS, type TerraSlot } from '../watch/watch-env.js';

const TERRA = { worldTimeRing: true, worldTimeSubdials: false };
const GAIA = { worldTimeRing: false, worldTimeSubdials: true, maxSeparateLoc: 4 };
const LA = 'America/Los_Angeles', NY = 'America/New_York';
const CUPERTINO = { lat: 37.3349, lon: -122.009 };
const NEW_YORK = { lat: 40.7128, lon: -74.006 };

function ctx(over: Partial<ObserverSlotContext> = {}): ObserverSlotContext {
    return {
        lat: CUPERTINO.lat, lon: CUPERTINO.lon,
        locationTimezone: LA, locationSource: '',
        slotParams: {}, nearestCityName: () => null,
        ...over,
    };
}
const BOSTON: TerraSlot = { cityName: 'Boston', olsonId: NY, lat: 42.3601, lon: -71.0589 };
const DENVER: TerraSlot = { cityName: 'Denver', olsonId: 'America/Denver', lat: 39.73915, lon: -104.9847 };
const flat = (user: Record<number, TerraSlot>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(serializeTerraOverrides(user))) if (v !== null) out[k] = v;
    return out;
};

describe('Terra global slot follows the observer timezone', () => {
    test('Los Angeles → slot 4 (the ring\'s Los Angeles column), New York → slot 7', () => {
        expect(validSlotsForTz(LA)).toEqual([4]);
        expect(validSlotsForTz(NY)).toEqual([7]);
        const la = deriveObserverSlots(TERRA, ctx())!;
        expect(la.globalLocationSlot).toBe(4);
        expect(la.overrides[4]).toMatchObject({ olsonId: LA, ...CUPERTINO });
        const ny = deriveObserverSlots(TERRA, ctx({ ...NEW_YORK, locationTimezone: NY }))!;
        expect(ny.globalLocationSlot).toBe(7);
        expect(ny.overrides[7]).toMatchObject({ olsonId: NY, ...NEW_YORK });
        expect(ny.overrides[4]).toBeUndefined();          // the old sector is back to its default
    });

    test('same coordinates, different timezone → different slot (why a tz correction must re-derive)', () => {
        const guess = deriveObserverSlots(TERRA, ctx({ ...NEW_YORK, locationTimezone: LA }))!;   // browser-zone guess
        const fixed = deriveObserverSlots(TERRA, ctx({ ...NEW_YORK, locationTimezone: NY }))!;   // DB-corrected
        expect(guess.globalLocationSlot).toBe(4);
        expect(fixed.globalLocationSlot).toBe(7);
        expect(guess.overrides[4].olsonId).toBe(LA);
        expect(fixed.overrides[7].olsonId).toBe(NY);
    });

    test('no timezone or 0,0 → no observer slot injected', () => {
        expect(deriveObserverSlots(TERRA, ctx({ locationTimezone: undefined }))!.globalLocationSlot).toBeUndefined();
        expect(deriveObserverSlots(TERRA, ctx({ lat: 0, lon: 0 }))!.globalLocationSlot).toBeUndefined();
    });
});

describe('observer name priority: locationSource → nearest DB city → timezone city → Local', () => {
    test('each tier wins over the next', () => {
        expect(resolveObserverName(ctx({ locationSource: 'Cupertino', nearestCityName: () => 'Sunnyvale' }))).toBe('Cupertino');
        expect(resolveObserverName(ctx({ nearestCityName: () => 'Sunnyvale' }))).toBe('Sunnyvale');
        expect(resolveObserverName(ctx())).toBe('Los Angeles');
        expect(resolveObserverName(ctx({ locationTimezone: undefined }))).toBe('Local');
    });

    test('the nearest-city lookup is skipped at 0,0', () => {
        let asked = false;
        resolveObserverName(ctx({ lat: 0, lon: 0, nearestCityName: () => { asked = true; return 'Null Island'; } }));
        expect(asked).toBe(false);
    });

    test('Terra global slot and Gaia slot 1 use the same chain', () => {
        const c = ctx({ nearestCityName: () => 'Sunnyvale' });
        expect(deriveObserverSlots(TERRA, c)!.overrides[4].cityName).toBe('Sunnyvale');
        expect(deriveObserverSlots(GAIA, c)!.overrides[1].cityName).toBe('Sunnyvale');
        expect(deriveObserverSlots(GAIA, ctx())!.overrides[1].cityName).toBe('Los Angeles');
        expect(deriveObserverSlots(GAIA, ctx({ locationTimezone: undefined }))!.overrides[1].cityName).toBe('Local');
    });
});

describe('Gaia', () => {
    test('slot 1 follows the observer timezone and coordinates; 2–N default', () => {
        const r = deriveObserverSlots(GAIA, ctx({ ...NEW_YORK, locationTimezone: NY }))!;
        expect(r.overrides[1]).toEqual({ cityName: 'New York', olsonId: NY, ...NEW_YORK });
        for (const s of [2, 3, 4]) expect(r.overrides[s]).toEqual(GAIA_SUBDIAL_DEFAULTS[s]);
        expect(r.userOverrides).toBeUndefined();
        expect(r.globalLocationSlot).toBeUndefined();
    });

    test('slots 2–N come from the persisted d-keys', () => {
        const r = deriveObserverSlots(GAIA, ctx({ slotParams: { d3: 'Tokyo', d3tz: 'Asia/Tokyo', d3lat: '35.690', d3lon: '139.692' } }))!;
        expect(r.overrides[3]).toEqual({ cityName: 'Tokyo', olsonId: 'Asia/Tokyo', lat: 35.69, lon: 139.692 });
        expect(r.overrides[2]).toEqual(GAIA_SUBDIAL_DEFAULTS[2]);
    });
});

describe('multi-slot timezones (tie-break)', () => {
    // Adelaide (+9:30 / +10:30 DST) centres on +10:00, valid for both the +9 and +10 columns.
    const ADELAIDE = 'Australia/Adelaide';
    const valid = validSlotsForTz(ADELAIDE);

    test('precondition: two valid slots', () => {
        expect(valid).toEqual([21, 22]);
    });

    test('prefers the slot the user has NOT overridden', () => {
        const a = deriveObserverSlots(TERRA, ctx({ locationTimezone: ADELAIDE, slotParams: flat({ 21: BOSTON }) }))!;
        expect(a.globalLocationSlot).toBe(22);
        const b = deriveObserverSlots(TERRA, ctx({ locationTimezone: ADELAIDE, slotParams: flat({ 22: BOSTON }) }))!;
        expect(b.globalLocationSlot).toBe(21);
    });

    test('with no override on either, picks by standard-time offset (first on a tie)', () => {
        const r = deriveObserverSlots(TERRA, ctx({ locationTimezone: ADELAIDE }))!;
        expect(valid).toContain(r.globalLocationSlot);
        expect(r.globalLocationSlot).toBe(21);
        expect(r.overrides[22]).toBeUndefined();
        expect(TERRA_RING_DEFAULTS[22].cityName).toBe('Sydney');   // the other column keeps its default
    });
});

describe('persistence contract (1b): the injected observer never reaches storage', () => {
    test('display carries the observer; the user map does not; serialize → parse → re-derive round-trips', () => {
        const user = { 12: BOSTON };                                   // London's column overridden
        const r = deriveObserverSlots(TERRA, ctx({ ...NEW_YORK, locationTimezone: NY, slotParams: flat(user) }))!;
        expect(r.overrides[7].olsonId).toBe(NY);                       // observer injected for display
        expect(r.overrides[12]).toEqual({ ...BOSTON, lat: 42.36, lon: -71.059 });
        expect(r.userOverrides![7]).toBeUndefined();                   // not in the user map
        expect(r.userOverrides![12]).toBeDefined();
        const stored = serializeTerraOverrides(r.userOverrides);
        expect(stored.r7).toBeNull();                                  // nothing stored for the observer's sector
        expect(stored.r12).toBe('Boston');
        const again = deriveObserverSlots(TERRA, ctx({ ...NEW_YORK, locationTimezone: NY, slotParams: parseAsFlat(stored) }))!;
        expect(again.userOverrides).toEqual(r.userOverrides);
        expect(again.overrides).toEqual(r.overrides);
    });

    test("a user's override OF the observer slot: the observer still wins on screen, the override persists and reappears when the observer moves", () => {
        const user = { 7: DENVER };                                    // user put Denver in New York's column
        const home = deriveObserverSlots(TERRA, ctx({ ...NEW_YORK, locationTimezone: NY, slotParams: flat(user) }))!;
        expect(home.globalLocationSlot).toBe(7);
        expect(home.overrides[7].olsonId).toBe(NY);                    // injection wins the display…
        expect(home.userOverrides![7]).toMatchObject({ cityName: 'Denver' });   // …the user's choice is retained
        expect(serializeTerraOverrides(home.userOverrides).r7).toBe('Denver');
        // The old writer serialized the display table: the observer replaced Denver in storage.
        expect(serializeTerraOverrides(home.overrides).r7).toBe('New York');
        // Observer moves to Los Angeles: Denver shows again in column 7.
        const away = deriveObserverSlots(TERRA, ctx({ slotParams: flat(home.userOverrides!) }))!;
        expect(away.globalLocationSlot).toBe(4);
        expect(away.overrides[7]).toMatchObject({ cityName: 'Denver', olsonId: 'America/Denver' });
    });

    function parseAsFlat(changes: Record<string, string | null>): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(changes)) if (v !== null) out[k] = v;
        // parse → serialize is the round trip the engine performs on every rebuild
        return flat(parseTerraUserOverrides(out));
    }
});
