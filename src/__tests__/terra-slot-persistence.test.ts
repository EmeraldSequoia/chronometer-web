/**
 * Terra ring slot persistence — the pure parse/serialize contract behind
 * "only the user's overrides are stored".
 *
 * buildSlotOverrides (engine-entry) builds the DISPLAY table as the user's
 * overrides plus the auto-injected observer slot (the ring sector matching the
 * current timezone, carrying the observer's name/zone/coords). The Terra city
 * dialog used to serialize that display table, so any slot edit persisted the
 * injected observer as if the user had chosen it: once the observer moved to
 * another zone the old sector kept a ghost "user override", and a genuine
 * user override of that sector was silently replaced. The dialog now keeps the
 * user's overrides in their own map (face.terraUserOverrides) and serializes
 * only that.
 *
 * Scope: these tests pin parseTerraUserOverrides / serializeTerraOverrides and
 * demonstrate the ghost mechanism on data. The dialog wiring itself (which map
 * the writer is handed, the dual write in assignCityToSlot, the reset) lives in
 * closures inside engine-entry's main() and cannot be booted under jsdom; it
 * is covered by the manual checks in the plan until the deriveObserverSlots
 * extraction (planning/2026-09-05, §5 step 2.3) gives it a seam.
 */
import { describe, test, expect } from 'vitest';

import {
    parseTerraUserOverrides, serializeTerraOverrides, TERRA_RING_SLOT_COUNT,
} from '../watch/terra-slots.js';
import type { TerraSlot } from '../watch/watch-env.js';

const BOSTON: TerraSlot = { cityName: 'Boston', olsonId: 'America/New_York', lat: 42.3601, lon: -71.0589 };
const DENVER: TerraSlot = { cityName: 'Denver', olsonId: 'America/Denver', lat: 39.73915, lon: -104.9847 };

const allKeys = (): string[] => {
    const keys: string[] = [];
    for (let s = 1; s <= TERRA_RING_SLOT_COUNT; s++) keys.push(`r${s}`, `r${s}tz`, `r${s}lat`, `r${s}lon`);
    return keys;
};

describe('parseTerraUserOverrides', () => {
    test('reads name/tz/lat/lon per slot; a name without a timezone is ignored; missing coords read as 0', () => {
        const parsed = parseTerraUserOverrides({
            r5: 'Denver', r5tz: 'America/Denver', r5lat: '39.739', r5lon: '-104.985',
            r7: 'Boston',                       // no r7tz → not an override
            r12: 'London', r12tz: 'Europe/London',
        });
        expect(Object.keys(parsed).map(Number).sort((a, b) => a - b)).toEqual([5, 12]);
        expect(parsed[5]).toEqual({ cityName: 'Denver', olsonId: 'America/Denver', lat: 39.739, lon: -104.985 });
        expect(parsed[12]).toEqual({ cityName: 'London', olsonId: 'Europe/London', lat: 0, lon: 0 });
    });

    test('ignores keys outside the ring range', () => {
        expect(parseTerraUserOverrides({ r0: 'X', r0tz: 'Etc/UTC', r25: 'Y', r25tz: 'Etc/UTC' })).toEqual({});
    });
});

describe('serializeTerraOverrides', () => {
    test('clears every ring key when there are no user overrides', () => {
        for (const input of [undefined, {}]) {
            const changes = serializeTerraOverrides(input);
            expect(Object.keys(changes).sort()).toEqual(allKeys().sort());
            expect(Object.values(changes).every((v) => v === null)).toBe(true);
        }
    });

    test('sets the given slots (coords to 3 dp) and clears all others', () => {
        const changes = serializeTerraOverrides({ 7: BOSTON });
        expect(changes.r7).toBe('Boston');
        expect(changes.r7tz).toBe('America/New_York');
        expect(changes.r7lat).toBe('42.360');
        expect(changes.r7lon).toBe('-71.059');
        expect(changes.r5).toBeNull();
        expect(Object.keys(changes).length).toBe(TERRA_RING_SLOT_COUNT * 4);
    });

    test('round-trips through the flat map (coords rounded to 3 dp)', () => {
        const user = { 5: DENVER, 7: BOSTON };
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(serializeTerraOverrides(user))) if (v !== null) flat[k] = v;
        const back = parseTerraUserOverrides(flat);
        expect(back[5]).toEqual({ ...DENVER, lat: 39.739, lon: -104.985 });
        expect(back[7]).toEqual({ ...BOSTON, lat: 42.36, lon: -71.059 });
    });
});

describe('serializing the user map (not the display table) excludes the injected observer slot', () => {
    // Mirrors buildSlotOverrides: display = { ...user, [globalSlot]: observer }.
    const OBSERVER: TerraSlot = { cityName: 'Cupertino', olsonId: 'America/Los_Angeles', lat: 37.3349, lon: -122.009 };
    const GLOBAL_SLOT = 4;

    test('with no user override of the observer slot, its keys stay cleared', () => {
        const user = { 7: BOSTON };
        const display = { ...user, [GLOBAL_SLOT]: OBSERVER };
        expect(display[GLOBAL_SLOT].cityName).toBe('Cupertino');       // what the ring shows
        const changes = serializeTerraOverrides(user);
        expect(changes[`r${GLOBAL_SLOT}`]).toBeNull();                  // what is stored
        expect(changes.r7).toBe('Boston');
        // The old writer serialized the display table — the ghost:
        expect(serializeTerraOverrides(display)[`r${GLOBAL_SLOT}`]).toBe('Cupertino');
    });

    test("a user's override OF the observer slot survives, even though the display shows the observer there", () => {
        const user = { [GLOBAL_SLOT]: DENVER, 7: BOSTON };
        const display = { ...user, [GLOBAL_SLOT]: OBSERVER };           // injection wins on screen
        expect(display[GLOBAL_SLOT].cityName).toBe('Cupertino');
        const changes = serializeTerraOverrides(user);
        expect(changes[`r${GLOBAL_SLOT}`]).toBe('Denver');              // ...but Denver is what persists
        expect(changes[`r${GLOBAL_SLOT}tz`]).toBe('America/Denver');
        // and the old writer would have replaced it with the observer:
        expect(serializeTerraOverrides(display)[`r${GLOBAL_SLOT}`]).toBe('Cupertino');
    });
});
