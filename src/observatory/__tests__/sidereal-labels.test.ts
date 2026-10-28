/**
 * Sidereal subdial constellation names (main-dial.ts): drawn as text in the
 * old overlay image's slots, order, colour and radius, instead of from
 * EO-Sidereal-constellation-names-0-at-top.png.
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';

interface Call { name: string; args: unknown[]; font: string; fillStyle: unknown; transform: number[][] }

/** A 2D context that records fillText calls with the state and transform in force. */
function recordingContext(): { ctx: OffscreenCanvasRenderingContext2D; texts: Call[] } {
    const texts: Call[] = [];
    const state: Record<string, unknown> = { font: '10px sans-serif', fillStyle: '#000' };
    const stack: number[][][] = [];
    let m = [[1, 0, 0], [0, 1, 0]];
    const mul = (a: number[][], b: number[][]) => [
        [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1], a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]],
        [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1], a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]],
    ];
    const ctx = new Proxy({}, {
        get(_t, prop: string) {
            if (prop in state) return state[prop];
            switch (prop) {
                case 'measureText': return () => ({ width: 10, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 1 });
                case 'save': return () => { stack.push(m.map(r => [...r])); };
                case 'restore': return () => { m = stack.pop() ?? m; };
                case 'translate': return (x: number, y: number) => { m = mul(m, [[1, 0, x], [0, 1, y]]); };
                case 'rotate': return (a: number) => { m = mul(m, [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0]]); };
                case 'scale': return (x: number, y: number) => { m = mul(m, [[x, 0, 0], [0, y, 0]]); };
                case 'setTransform': return (a: number, b: number, c: number, d: number, e: number, f: number) => { m = [[a, c, e], [b, d, f]]; };
                case 'fillText': return (...args: unknown[]) => { texts.push({ name: prop, args, font: state.font as string, fillStyle: state.fillStyle, transform: m.map(r => [...r]) }); };
                case 'createLinearGradient': case 'createRadialGradient': return () => ({ addColorStop() {} });
                default: return () => undefined;
            }
        },
        set(_t, prop: string, v) { state[prop] = v; return true; },
    }) as unknown as OffscreenCanvasRenderingContext2D;
    return { ctx, texts };
}

beforeAll(() => {
    // jsdom has no Path2D (the zodiac ring strokes one).
    (globalThis as unknown as { Path2D: unknown }).Path2D = class { constructor(_d?: string) {} };
});

describe('sidereal constellation labels', () => {
    it('are the twelve names at the odd slots of a 24-slot ring, in the image\'s colour and font', async () => {
        const { drawMainDial, SIDEREAL_CONSTELLATION_LABELS, SIDEREAL_CONSTELLATION_COLOR } = await import('../main-dial.js');
        const { portraitOneBand } = await import('../layout.js');
        const L = portraitOneBand(800, 1200);
        const { ctx, texts } = recordingContext();
        drawMainDial(ctx, L, false);

        expect(SIDEREAL_CONSTELLATION_LABELS.length).toBe(24);
        const names = ['Psc', 'Ari', 'Tau', 'Gem', 'Can', 'Leo', 'Vir', 'Lib', 'Sco', 'Sag', 'Cap', 'Aqr'];   // RA order, Pisces at 0–2h
        expect(SIDEREAL_CONSTELLATION_LABELS.filter(Boolean)).toEqual(names);
        for (let i = 0; i < 24; i++) expect(SIDEREAL_CONSTELLATION_LABELS[i]).toBe(i % 2 ? names[(i - 1) / 2] : '');

        const calls = texts.filter(c => names.includes(c.args[0] as string));
        expect(calls.map(c => c.args[0])).toEqual(names);
        for (const c of calls) {
            expect(c.fillStyle).toBe(SIDEREAL_CONSTELLATION_COLOR);
            expect(c.fillStyle).toBe('rgb(224, 224, 224)');
            expect(c.font).toContain('Helvetica Neue');
            expect(c.font).toContain(`${L.subdialFontSize}px`);
        }

        // Each label's baseline point, in dial coordinates: on the sidereal
        // subdial, at 15° + 30°·k clockwise from the top, within the subdial.
        const s = L.mainR / 365;
        const r = L.subR;
        calls.forEach((c, k) => {
            const [, x, y] = c.args as [string, number, number];
            const px = c.transform[0][0] * x + c.transform[0][1] * y + c.transform[0][2];
            const py = c.transform[1][0] * x + c.transform[1][1] * y + c.transform[1][2];
            const dx = px - L.sidCX, dy = py - L.sidCY;
            const ang = ((Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360;   // clockwise from the top
            expect(Math.abs(ang - (15 + 30 * k)), `${c.args[0]} angle ${ang.toFixed(1)}`).toBeLessThan(1);
            const rad = Math.hypot(dx, dy);
            expect(rad, `${c.args[0]} radius`).toBeLessThan(r - 5 * s);
            expect(rad, `${c.args[0]} radius`).toBeGreaterThan(r - 5 * s - 2 * L.subdialFontSize);
        });
    });
});
