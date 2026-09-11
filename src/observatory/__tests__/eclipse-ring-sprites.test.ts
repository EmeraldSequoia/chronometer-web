/**
 * Eclipse ring-marker sprites (eclipse-ring-sprites.ts): the geometry that
 * keeps the new markers in the old iOS PNGs' boxes and layouts — which is what
 * keeps drawRingMarker's placement and orientation unchanged — and the sprite
 * cache. The pixels themselves need a real canvas; they were checked against
 * the old PNGs in a browser harness (planning/2026-09-11-eclipse-ring-icons.md).
 */
import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import {
    RING_BOX,
    SUN_CENTER, SUN_RAYS, SUN_TIP_R, SUN_VALLEY_R, sunStarOutline,
    NODE_LINE_X, NODE_LINE_W, NODE_ARROW_CY, NODE_ARROW_BASE, NODE_ARROW_DEPTH, nodeArrowOutline,
    spritePixelSize, getRingSprites,
} from '../eclipse-ring-sprites';

describe('Sun star', () => {
    test('centered 4 pt below the box center, so the flip lands it on the outer rim', () => {
        expect(SUN_CENTER[0]).toBe(RING_BOX.sun / 2);
        expect(SUN_CENTER[1] - RING_BOX.sun / 2).toBe(4);
    });

    test('8 equal rays on the axes and diagonals, valleys at half the ray length', () => {
        const pts = sunStarOutline();
        expect(pts).toHaveLength(2 * SUN_RAYS);
        expect(SUN_VALLEY_R).toBe(SUN_TIP_R / 2);
        pts.forEach(([x, y], i) => {
            // Clockwise from straight up in half-ray steps; tips on even indices.
            const r = i % 2 === 0 ? SUN_TIP_R : SUN_VALLEY_R;
            const a = i * Math.PI / SUN_RAYS;
            expect(x - SUN_CENTER[0]).toBeCloseTo(r * Math.sin(a), 12);
            expect(y - SUN_CENTER[1]).toBeCloseTo(-r * Math.cos(a), 12);
        });
    });

    test('fits inside its box', () => {
        for (const [x, y] of sunStarOutline()) {
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThanOrEqual(RING_BOX.sun);
            expect(y).toBeGreaterThanOrEqual(0);
            expect(y).toBeLessThanOrEqual(RING_BOX.sun);
        }
    });
});

describe('node markers', () => {
    test('line centered in the box; arrowhead ½ pt below the box center', () => {
        expect(RING_BOX.ascNode).toBe(RING_BOX.desNode);
        expect(NODE_LINE_X).toBe(RING_BOX.ascNode / 2);
        expect(NODE_ARROW_CY - RING_BOX.ascNode / 2).toBe(0.5);
    });

    test('ascending points left, descending right, as mirror images', () => {
        const asc = nodeArrowOutline(-1), des = nodeArrowOutline(1);
        const apex = asc.reduce((p, q) => (q[0] < p[0] ? q : p));
        expect(apex[0]).toBeCloseTo(NODE_LINE_X - NODE_LINE_W / 2 - NODE_ARROW_DEPTH, 12);
        expect(apex[1]).toBe(NODE_ARROW_CY);
        const ys = asc.map(p => p[1]);
        expect(Math.max(...ys) - Math.min(...ys)).toBe(NODE_ARROW_BASE);
        des.forEach(([x, y], i) => {
            expect(x).toBeCloseTo(2 * NODE_LINE_X - asc[i][0], 12);
            expect(y).toBe(asc[i][1]);
        });
    });
});

describe('sprite sizing', () => {
    test('ceil(box · pxPerPt), without float noise adding a pixel', () => {
        expect(spritePixelSize(20, 1)).toBe(20);
        expect(spritePixelSize(27, 2.2)).toBe(60);          // 59.4
        expect(spritePixelSize(15, 2.656 * 2)).toBe(80);    // 79.68 (6K)
        expect(spritePixelSize(20, 0.1 + 0.2)).toBe(6);     // 6.000000000000001
    });
});

describe('sprite cache', () => {
    // Node has no canvas: a stand-in whose 2D context accepts every call.
    class FakeOffscreenCanvas {
        constructor(public width: number, public height: number) {}
        getContext(): unknown {
            return new Proxy({} as Record<string | symbol, unknown>, {
                get: (t, k) => (k in t ? t[k] : () => {}),
                set: (t, k, v) => { t[k] = v; return true; },
            });
        }
    }
    beforeAll(() => { vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas); });
    afterAll(() => { vi.unstubAllGlobals(); });

    const fakeMoon = { naturalWidth: 300, naturalHeight: 300 } as unknown as HTMLImageElement;

    test('rebuilds only when the scale changes or the Moon texture arrives', () => {
        const a = getRingSprites(1.2345, null);
        expect(a.moon).toBeNull();
        expect(a.sun.width).toBe(spritePixelSize(RING_BOX.sun, 1.2345));
        expect(getRingSprites(1.2345, null)).toBe(a);

        const b = getRingSprites(1.2345, fakeMoon);
        expect(b).not.toBe(a);
        expect(b.moon?.width).toBe(spritePixelSize(RING_BOX.moon, 1.2345));
        expect(getRingSprites(1.2345, fakeMoon)).toBe(b);

        const c = getRingSprites(2.5, fakeMoon);
        expect(c).not.toBe(b);
        expect(c.ascNode.width).toBe(spritePixelSize(RING_BOX.ascNode, 2.5));
    });
});
