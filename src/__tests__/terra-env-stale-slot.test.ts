/**
 * Characterization: a watch environment never corrects stale observer-slot
 * data. Terra's observer clock reads the slot table (hour12ValueAngleN /
 * minuteValueAngleN via terraIDeviceSlot), not `olsonTimezone`. So an env
 * built from slot data derived under a provisional browser-zone guess keeps
 * showing that zone even when createWatchEnvironment is later given the
 * corrected timezone — the slot table must be re-derived first. This is why
 * the engine's timezone correction goes through applyResolvedTimezone →
 * rebuildAllForLocation (re-derives slots) and never the DST rebuild path.
 */
import { describe, test, expect } from 'vitest';
import { JSDOM } from 'jsdom';

import { loadFaceXML } from './face-registry.js';
import { parseWatchXML } from '../watch/xml-parser.js';
import { createWatchEnvironment, type TerraSlot } from '../watch/watch-env.js';
import { deriveObserverSlots } from '../watch/observer-slots.js';
import type { Environment } from '../expr/env.js';

const dom = new JSDOM('', { contentType: 'text/html' });
const parser = new dom.window.DOMParser();
// 20:00 UTC = 13:00 PDT (Los Angeles) = 16:00 EDT (New York): three hours apart.
const getNow = () => new Date('2026-09-06T20:00:00Z');
const LA = 'America/Los_Angeles', NY = 'America/New_York';
const NEW_YORK = { lat: 40.7128, lon: -74.006 };

function fn(env: Environment, name: string, ...args: number[]): number {
    const f = env.functions.get(name);
    expect(f, `env function "${name}" must exist`).toBeDefined();
    return f!(...args);
}
/** Wrap an angle difference into (-π, π]. */
const wrap = (a: number) => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

const watch = parseWatchXML(loadFaceXML('Terra'), 'front', parser);
const derive = (tz: string) => deriveObserverSlots(
    { worldTimeRing: true, worldTimeSubdials: false },
    { ...NEW_YORK, locationTimezone: tz, locationSource: '', slotParams: {}, nearestCityName: () => null },
)!;

describe('Terra env with stale observer-slot data', () => {
    test('slots derived under the browser-zone guess keep the observer clock on that zone, whatever tz the env is given', () => {
        const guess = derive(LA);                                     // what startup derives before the DB parses
        const stale = createWatchEnvironment(watch, NEW_YORK.lat, NEW_YORK.lon, getNow, NY, guess.overrides, guess.globalLocationSlot);
        expect(fn(stale, 'terraIDeviceSlot')).toBe(4);               // still the Los Angeles column…
        const staleHour = fn(stale, 'hour12ValueAngleN', fn(stale, 'terraIDeviceSlot'));

        const fixed = derive(NY);                                     // re-derived after the correction
        const good = createWatchEnvironment(watch, NEW_YORK.lat, NEW_YORK.lon, getNow, NY, fixed.overrides, fixed.globalLocationSlot);
        expect(fn(good, 'terraIDeviceSlot')).toBe(7);                // …versus the New York column
        const goodHour = fn(good, 'hour12ValueAngleN', fn(good, 'terraIDeviceSlot'));

        // Same instant, three hours apart on the 12-hour dial (π/2), because the
        // stale env's observer slot still carries olsonId = America/Los_Angeles.
        expect(Math.abs(wrap(goodHour - staleHour))).toBeCloseTo(Math.PI / 2, 6);
    });

    test('the correction is a slot re-derivation, not an env parameter', () => {
        const guess = derive(LA);
        // Rebuilding with the corrected tz but the OLD slot table changes nothing on the observer clock.
        const a = createWatchEnvironment(watch, NEW_YORK.lat, NEW_YORK.lon, getNow, LA, guess.overrides, guess.globalLocationSlot);
        const b = createWatchEnvironment(watch, NEW_YORK.lat, NEW_YORK.lon, getNow, NY, guess.overrides, guess.globalLocationSlot);
        expect(fn(a, 'terraIDeviceSlot')).toBe(fn(b, 'terraIDeviceSlot'));
        expect(fn(a, 'hour12ValueAngleN', 4)).toBeCloseTo(fn(b, 'hour12ValueAngleN', 4), 9);
        const slots = (b as unknown as { _terraSlots: Record<number, TerraSlot> })._terraSlots;
        expect(slots[4].olsonId).toBe(LA);
    });
});
