/**
 * prefers-reduced-motion: transitions jump, content motion still sweeps.
 * (updater.ts setReducedMotion / transitionMultiplier)
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { createObsValue } from '../obs-value';
import { Updater, makeOverridableGetNow, setReducedMotion, type TimingContext } from '../updater';
import type { Environment } from '../../expr/env';

function makeEnv(getNow: () => Date): Environment {
    const functions = new Map<string, (...a: number[]) => number>();
    // A "second hand": one revolution per 60 s of display time.
    functions.set('secAngle', () => (getNow().getTime() / 1000 % 60) * 2 * Math.PI / 60);
    // A slow hand: 1 rad per hour, linear.
    functions.set('slow', () => (getNow().getTime() / 3_600_000) % 1);
    return { functions, variables: new Map() } as unknown as Environment;
}

afterEach(() => { setReducedMotion(false); vi.restoreAllMocks(); });

describe('reduced motion', () => {
    test('a settle when stopped jumps under reduced motion and sweeps otherwise', () => {
        for (const reduced of [false, true]) {
            setReducedMotion(reduced);
            let perfNow = 1000;
            vi.spyOn(performance, 'now').mockImplementation(() => perfNow);
            const base = () => new Date('2025-06-15T12:00:00.000Z');
            const { getNow, withDisplayTime } = makeOverridableGetNow(base);
            const env = makeEnv(getNow);
            const v = createObsValue({ name: 'slow', expr: 'slow()', updateInterval: 60, linear: true }, env, perfNow);
            // Put the hand far from its target, then settle with time stopped.
            v.anim.currentValue = 0.9; v.anim.targetValue = 0.9; v.anim.animating = false;
            const u = new Updater();
            u.add(v);
            const ctx: TimingContext = { tickIntervalMs: null, displayDeltaSec: 0, direction: 0 };
            u.tick(env, perfNow, getNow, withDisplayTime, ctx);
            const target = env.functions.get('slow')!();
            if (reduced) {
                expect(v.anim.animating).toBe(false);
                expect(v.currentValue).toBeCloseTo(target, 9);
            } else {
                expect(v.anim.animating).toBe(true);
                expect(v.currentValue).not.toBeCloseTo(target, 3);
            }
            vi.restoreAllMocks();
        }
    });

    test('a natural-speed hand still sweeps under reduced motion', () => {
        setReducedMotion(true);
        let perfNow = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => perfNow);
        let ms = new Date('2025-06-15T12:00:00.000Z').getTime();
        const { getNow, withDisplayTime } = makeOverridableGetNow(() => new Date(ms));
        const env = makeEnv(getNow);
        const v = createObsValue({ name: 'sec', expr: 'secAngle()', updateInterval: 20, naturalSpeed: 2 * Math.PI / 60 }, env, perfNow);
        const u = new Updater();
        u.add(v);
        const ctx: TimingContext = { tickIntervalMs: null, displayDeltaSec: 0, direction: 1 };
        u.tick(env, perfNow, getNow, withDisplayTime, ctx);
        const a0 = v.currentValue;
        // Half a second later (real and display time), still before the 20 s boundary.
        perfNow += 500; ms += 500;
        u.tick(env, perfNow, getNow, withDisplayTime, ctx);
        expect(v.currentValue).not.toBe(a0);       // it moved…
        expect(u.anyAnimating()).toBe(true);        // …by sweeping, not jumping
    });
});
