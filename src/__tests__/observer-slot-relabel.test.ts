/**
 * relabelTerraSlot — label-only update of a slot in a LIVE environment.
 *
 * createWatchEnvironment → registerTerraFunctions copies the caller's slot
 * overrides into the env's own table (env._terraSlots), which is the only thing
 * the renderer reads; the Terra ring additionally bakes those names into a
 * cached knockout (env._terraCityKnockout). The engine's on-demand
 * reverse-geocode (backfillObserverSlots) used to write the nearest-city name
 * only into the face-side override objects, so the on-screen "Observer" /
 * timezone-city placeholder never updated in-session. These tests pin the copy
 * semantics and the helper that closes the gap.
 */
import { describe, test, expect } from 'vitest';
import { JSDOM } from 'jsdom';

import { loadFaceXML } from './face-registry.js';
import { parseWatchXML } from '../watch/xml-parser.js';
import {
    createWatchEnvironment, relabelTerraSlot, GAIA_SUBDIAL_DEFAULTS, TERRA_RING_DEFAULTS, type TerraSlot,
} from '../watch/watch-env.js';

const dom = new JSDOM('', { contentType: 'text/html' });
const parser = new dom.window.DOMParser();
const getNow = () => new Date('2026-09-06T12:00:00Z');
const LA = 'America/Los_Angeles';
const CUPERTINO = { lat: 37.3349, lon: -122.0090 };

type Slots = Record<number, TerraSlot>;
const slotsOf = (env: unknown): Slots => (env as { _terraSlots: Slots })._terraSlots;
const knockoutOf = (env: unknown): unknown => (env as { _terraCityKnockout?: unknown })._terraCityKnockout;

function gaiaOverrides(observerName: string): Slots {
    const o: Slots = { 1: { cityName: observerName, olsonId: LA, lat: CUPERTINO.lat, lon: CUPERTINO.lon } };
    for (const [k, v] of Object.entries(GAIA_SUBDIAL_DEFAULTS)) o[Number(k)] = { ...v };
    return o;
}

function gaiaEnv(overrides: Slots) {
    const watch = parseWatchXML(loadFaceXML('Gaia'), 'front', parser);
    return createWatchEnvironment(watch, CUPERTINO.lat, CUPERTINO.lon, getNow, LA, overrides);
}

// Slot 4 is the America/Los_Angeles column of the ring (TERRA_RING_DEFAULTS).
const TERRA_GLOBAL_SLOT = 4;

function terraEnv(overrides: Slots) {
    const watch = parseWatchXML(loadFaceXML('Terra'), 'front', parser);
    return createWatchEnvironment(watch, CUPERTINO.lat, CUPERTINO.lon, getNow, LA, overrides, TERRA_GLOBAL_SLOT);
}

describe('env slot table is a copy of the overrides', () => {
    test('Gaia: a face-side edit alone never reaches env._terraSlots', () => {
        const overrides = gaiaOverrides('Los Angeles');
        const env = gaiaEnv(overrides);
        const slots = slotsOf(env);
        expect(slots[1].cityName).toBe('Los Angeles');
        expect(slots[1]).not.toBe(overrides[1]);
        overrides[1].cityName = 'Cupertino';           // what backfillObserverSlots used to do
        expect(slots[1].cityName).toBe('Los Angeles'); // ...and why it never showed
    });

    test('Terra: same for the global slot', () => {
        const overrides: Slots = { [TERRA_GLOBAL_SLOT]: { cityName: 'Los Angeles', olsonId: LA, ...CUPERTINO } };
        const env = terraEnv(overrides);
        overrides[TERRA_GLOBAL_SLOT].cityName = 'Cupertino';
        expect(slotsOf(env)[TERRA_GLOBAL_SLOT].cityName).toBe('Los Angeles');
    });
});

describe('relabelTerraSlot', () => {
    test('updates the live slot and drops the Terra knockout cache', () => {
        const overrides = gaiaOverrides('Los Angeles');
        const env = gaiaEnv(overrides);
        const sentinel = { fake: 'knockout' };
        (env as { _terraCityKnockout?: unknown })._terraCityKnockout = sentinel;

        expect(relabelTerraSlot(env, 1, 'Cupertino')).toBe(true);
        expect(slotsOf(env)[1].cityName).toBe('Cupertino');
        expect(knockoutOf(env)).toBeNull();
        // Only the label moves: zone and coordinates are untouched.
        expect(slotsOf(env)[1].olsonId).toBe(LA);
        expect(slotsOf(env)[1].lat).toBeCloseTo(CUPERTINO.lat, 6);
        // The caller's own object is not the helper's business.
        expect(overrides[1].cityName).toBe('Los Angeles');
        // Other slots untouched.
        expect(slotsOf(env)[2].cityName).toBe(GAIA_SUBDIAL_DEFAULTS[2].cityName);
    });

    test('is idempotent: same name → false and the knockout is left alone', () => {
        const env = gaiaEnv(gaiaOverrides('Cupertino'));
        const sentinel = { fake: 'knockout' };
        (env as { _terraCityKnockout?: unknown })._terraCityKnockout = sentinel;
        expect(relabelTerraSlot(env, 1, 'Cupertino')).toBe(false);
        expect(knockoutOf(env)).toBe(sentinel);
    });

    test('unknown slot → false, no throw, knockout left alone', () => {
        const env = gaiaEnv(gaiaOverrides('Los Angeles'));
        const sentinel = { fake: 'knockout' };
        (env as { _terraCityKnockout?: unknown })._terraCityKnockout = sentinel;
        expect(relabelTerraSlot(env, 99, 'Nowhere')).toBe(false);
        expect(knockoutOf(env)).toBe(sentinel);
    });

    test('engine contract: the face-side override must be written too, or a later env rebuild reverts the label', () => {
        // backfillObserverSlots writes BOTH face.terraSlotOverrides (what DST /
        // per-tick rebuilds re-copy from) AND the live env. Pin why: an env-only
        // relabel is undone by the next rebuild from the untouched overrides.
        const overrides = gaiaOverrides('Los Angeles');
        const env = gaiaEnv(overrides);
        expect(relabelTerraSlot(env, 1, 'Cupertino')).toBe(true);
        expect(slotsOf(gaiaEnv(overrides))[1].cityName).toBe('Los Angeles');   // env-only → reverts on rebuild
        overrides[1].cityName = 'Cupertino';                                   // the face-side half of the dual write
        expect(slotsOf(gaiaEnv(overrides))[1].cityName).toBe('Cupertino');     // rebuild now agrees with the relabel
    });

    test('Terra: relabels the global slot only; the other 23 ring cities stay at their defaults', () => {
        const env = terraEnv({ [TERRA_GLOBAL_SLOT]: { cityName: 'Los Angeles', olsonId: LA, ...CUPERTINO } });
        expect(relabelTerraSlot(env, TERRA_GLOBAL_SLOT, 'Cupertino')).toBe(true);
        const slots = slotsOf(env);
        expect(slots[TERRA_GLOBAL_SLOT].cityName).toBe('Cupertino');
        for (let s = 1; s <= 24; s++) {
            if (s === TERRA_GLOBAL_SLOT) continue;
            expect(slots[s].cityName).toBe(TERRA_RING_DEFAULTS[s].cityName);
        }
    });
});
