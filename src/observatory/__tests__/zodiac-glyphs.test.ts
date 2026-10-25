import { describe, it, expect, beforeAll } from 'vitest';
import { ZODIAC_GLYPHS, ZODIAC_RING_R, drawZodiacRing } from '../zodiac-glyphs.js';

/** Absolute-command subset the glyphs are written in: M/L/C/Q with number pairs, Z. */
const NUM = '-?\\d+(?:\\.\\d+)?';
const PAIR = `${NUM} ${NUM}`;
const CMD = `(?:M ${PAIR}|L ${PAIR}|Q ${PAIR} ${PAIR}|C ${PAIR} ${PAIR} ${PAIR}|Z)`;
const PATH = new RegExp(`^M ${PAIR}(?: ${CMD})*$`);

function coords(d: string): Array<[number, number]> {
    const nums = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const out: Array<[number, number]> = [];
    for (let i = 0; i < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
    return out;
}

describe('zodiac glyphs', () => {
    it('has the twelve signs in the ring order, clockwise from the top', () => {
        expect(ZODIAC_GLYPHS.map(g => g.symbol).join('')).toBe('♓♒♑♐♏♎♍♌♋♊♉♈');
        expect(ZODIAC_RING_R).toBe(237);
    });

    it('every path parses and starts with a moveto', () => {
        for (const g of ZODIAC_GLYPHS) {
            expect(g.strokes.length).toBeGreaterThan(0);
            for (const d of [...g.strokes, ...(g.fills ?? [])]) {
                expect(d, `${g.name}: ${d}`).toMatch(PATH);
                expect(d.match(/-?\d+(?:\.\d+)?/g)!.length % 2).toBe(0);
            }
            if (g.fills) for (const d of g.fills) expect(d.endsWith('Z'), `${g.name} fill closed`).toBe(true);
        }
    });

    it('glyphs sit where the PNG ink did: outer edge 8–18 units above the slot centre, inside ±20', () => {
        for (const g of ZODIAC_GLYPHS) {
            const pts = [...g.strokes, ...(g.fills ?? [])].flatMap(coords);
            const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
            expect(Math.min(...ys), `${g.name} outer edge`).toBeGreaterThan(-18);
            expect(Math.min(...ys), `${g.name} outer edge`).toBeLessThan(-8);   // Aquarius is the squat one
            expect(Math.max(...ys), `${g.name} inner edge`).toBeLessThan(16);
            expect(Math.max(...xs.map(Math.abs)), `${g.name} width`).toBeLessThan(20);
            expect(g.width).toBeGreaterThan(1);
            expect(g.width).toBeLessThan(4);
        }
    });
});

describe('drawZodiacRing', () => {
    beforeAll(() => {
        // jsdom has no Path2D; the module only needs a constructible stand-in.
        if (typeof (globalThis as any).Path2D === 'undefined') {
            (globalThis as any).Path2D = class { constructor(public d: string) {} };
        }
    });

    it('strokes every path once per slot, filling the closed shapes too, and restores state', () => {
        const calls: string[] = [];
        let depth = 0;
        const ctx = {
            save: () => { depth++; }, restore: () => { depth--; },
            translate: () => {}, rotate: () => {}, scale: () => {},
            stroke: () => { calls.push('stroke'); }, fill: () => { calls.push('fill'); },
            lineWidth: 0, lineCap: '', lineJoin: '', strokeStyle: '', fillStyle: '',
        } as unknown as CanvasRenderingContext2D;
        drawZodiacRing(ctx, 100, 100, 1.5);
        const strokes = ZODIAC_GLYPHS.reduce((n, g) => n + g.strokes.length + (g.fills?.length ?? 0), 0);
        const fills = ZODIAC_GLYPHS.reduce((n, g) => n + (g.fills?.length ?? 0), 0);
        expect(calls.filter(c => c === 'stroke').length).toBe(strokes);
        expect(calls.filter(c => c === 'fill').length).toBe(fills);
        expect(depth).toBe(0);
        expect(ctx.lineCap).toBe('round');
    });
});
