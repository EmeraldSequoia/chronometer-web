/**
 * Tests for the generalized `period` shortest-path in startAnimationRaw
 * (planning/2026-06-15-chronometer-obsvalue-port.md, "Cyclic values").
 *
 *  - period = 2π  → angle: short way across the 0/2π seam (the former
 *                   `linear:false` behavior, must be bit-identical).
 *  - period = P   → cyclic non-angle (e.g. analemma path param): short way
 *                   across the 0/P seam.
 *  - period = ∞   → linear: no wrap, straight line (former `linear:true`).
 */
import { describe, test, expect } from 'vitest';
import { startAnimationRaw, interpolateValue, makeAnimatingValue } from '../animation';

const TWO_PI = 2 * Math.PI;
function fmod(x: number, p: number): number { return ((x % p) + p) % p; }

describe('startAnimationRaw period (cyclic shortest-path)', () => {
    test('angle (period 2π) takes the short way forward across the 0/2π seam', () => {
        // currentValue ≈ 343°, target ≈ 11° — short way is +28° forward across 360°.
        const val = makeAnimatingValue(6.0, 0);
        startAnimationRaw(val, 0.2, 0, 1.0, 1000, TWO_PI);

        // currentValue is unwrapped to within half a period of the target.
        expect(Math.abs(val.currentValue - val.targetValue)).toBeLessThanOrEqual(Math.PI);
        // Specifically unwrapped below zero (6.0 − 2π), not left at 6.0.
        expect(val.currentValue).toBeCloseTo(0.2 - 0.483, 2);
        expect(val.animating).toBe(true);

        // Midpoint sits in the forward arc near 0°, not the backward arc near 180°.
        const mid = interpolateValue(val, 500);
        expect(Math.cos(mid)).toBeGreaterThan(0.9);   // near 0°, i.e. went the short way
    });

    test('default period (omitted) equals explicit 2π (angle bit-identity)', () => {
        const a = makeAnimatingValue(6.0, 0);
        const b = makeAnimatingValue(6.0, 0);
        startAnimationRaw(a, 0.2, 0, 1.0, 1000);          // default period
        startAnimationRaw(b, 0.2, 0, 1.0, 1000, TWO_PI);  // explicit 2π
        expect(a.currentValue).toBe(b.currentValue);
        expect(a.targetValue).toBe(b.targetValue);
    });

    test('cyclic non-angle (period 1000) wraps the short way across 0/1000', () => {
        // currentValue 999, target 1 — short way is +2 forward across 1000.
        const P = 1000;
        const val = makeAnimatingValue(999, 0);
        startAnimationRaw(val, 1, 0, 1.0, 1000, P);

        // Unwrapped to −1 so the gap to target (1) is 2, not 998.
        expect(val.currentValue).toBeCloseTo(-1, 6);
        expect(Math.abs(val.currentValue - val.targetValue)).toBeLessThanOrEqual(P / 2);

        // Midpoint maps to 0 (mod P), inside the short forward arc 999→0→1.
        const mid = interpolateValue(val, 500);
        expect(fmod(mid, P)).toBeCloseTo(0, 6);
    });

    test('linear (period ∞) does not wrap — straight line, target not normalized', () => {
        const val = makeAnimatingValue(999, 0);
        startAnimationRaw(val, 1, 0, 1.0, 1000, Infinity);
        // No unwrap: currentValue stays 999, target stays 1 (no fmod).
        expect(val.currentValue).toBe(999);
        expect(val.targetValue).toBe(1);
        // Sweeps straight down through the midpoint 500.
        const mid = interpolateValue(val, 500);
        expect(mid).toBeCloseTo(500, 6);
    });
});
