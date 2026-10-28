/**
 * Procedural starfield (background.ts): the generator's contract — a fixed
 * virtual sky, deterministic for a given device-px window, with the count
 * following the area and a star keeping its place when the window grows.
 * The pixels need a real canvas; they were checked against the old image in
 * planning/2026-10-25-bitmap-upgrades/starfield-sheet-S.png.
 */
import { describe, it, expect } from 'vitest';
import { generateStars, mulberry32, STAR_DENSITY, SKY_PX } from '../background.js';
import { STAR_PROFILES } from '../starfield-profiles.js';

describe('procedural starfield', () => {
    it('reproduces the image\'s density: about 290 stars per device megapixel', () => {
        expect(STAR_PROFILES.length).toBe(356);
        expect(STAR_DENSITY * 1e6).toBeGreaterThan(270);
        expect(STAR_DENSITY * 1e6).toBeLessThan(310);
    });

    it('is deterministic for a given window', () => {
        const a = generateStars(1280, 800);
        const b = generateStars(1280, 800);
        expect(b).toEqual(a);
    });

    it('star count follows the window area (±15 %), 1280×800 → 4K', () => {
        const small = generateStars(1280, 800).length;
        const big = generateStars(3840, 2160).length;
        expect(small).toBeGreaterThan(300 * 0.85);
        expect(small).toBeLessThan(300 * 1.15);
        const expected = STAR_DENSITY * 3840 * 2160;
        expect(big).toBeGreaterThan(expected * 0.85);
        expect(big).toBeLessThan(expected * 1.15);
    });

    it('a star keeps its place when the window grows (the sky is fixed and centred)', () => {
        const small = generateStars(1280, 800);
        const big = generateStars(1920, 1200);
        const dx = (1920 - 1280) / 2, dy = (1200 - 800) / 2;
        for (const st of small) {
            if (st.x < 0 || st.y < 0 || st.x >= 1280 || st.y >= 800) continue;   // margin stars
            const twin = big.find(b => Math.abs(b.x - (st.x + dx)) < 1e-6 && Math.abs(b.y - (st.y + dy)) < 1e-6);
            expect(twin, `star at ${st.x},${st.y}`).toBeDefined();
            expect(twin!.sigma).toBe(st.sigma);
            expect(twin!.flux).toBe(st.flux);
        }
    });

    it('every star is inside the window (plus the draw margin) and has the image\'s profile ranges', () => {
        for (const st of generateStars(3840, 2160)) {
            expect(st.x).toBeGreaterThanOrEqual(-8);
            expect(st.y).toBeGreaterThanOrEqual(-8);
            expect(st.x).toBeLessThan(3840 + 8);
            expect(st.y).toBeLessThan(2160 + 8);
            // Reference scale 0.625: the table's sigma range in image px → device px, floored at 0.35.
            expect(st.sigma).toBeGreaterThanOrEqual(0.35);
            expect(st.sigma).toBeLessThanOrEqual(Math.max(...STAR_PROFILES.map(p => p[0])) * 0.625 + 1e-9);
            expect(st.flux).toBeGreaterThan(0);
            expect(st.red).toBeGreaterThan(0);
            expect(st.blue).toBeGreaterThan(0);
        }
        expect(SKY_PX).toBeGreaterThanOrEqual(7680);     // covers a 4K panel at 2×
    });

    it('mulberry32 draws in [0, 1) and repeats for the same seed', () => {
        const a = mulberry32(20261025), b = mulberry32(20261025);
        const seq = Array.from({ length: 1000 }, () => a());
        for (const v of seq) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
        expect(Array.from({ length: 1000 }, () => b())).toEqual(seq);
        expect(new Set(seq).size).toBeGreaterThan(990);
        const mean = seq.reduce((x, y) => x + y, 0) / seq.length;
        expect(Math.abs(mean - 0.5)).toBeLessThan(0.05);
    });
});
