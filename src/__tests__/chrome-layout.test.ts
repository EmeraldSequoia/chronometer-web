import { describe, test, expect } from 'vitest';
import {
    rectsClear, circleClearOfRect, minClearDy, splitOrder, placeGroup, layoutChrome,
    CHROME_GAP_PX, type ChromeItem, type CornerGroup, type Rect, type Circle,
    type AvoidTargets,
} from '../shared/chrome-layout.js';
import {
    optimizeGrid, computeFaceRects, layoutGridWithChrome, GAP_PX, PADDING_PX,
} from '../watch/grid-layout.js';

const EPS = 1e-6;
const BTN = 36;

const btn = (id: string): ChromeItem => ({ id, w: BTN, h: BTN });

/** Chronometer right group: fullscreen+info(+name) row arm, share+apps column
 *  arm; rowed items re-rank so share sits beside the corner. */
const RIGHT_ROW_ORDER = ['fullscreen-btn', 'share-btn', 'info-btn', 'face-name', 'observatory-link', 'inspector-link'];
function rightGroup(nameW: number | null): CornerGroup {
    const items = [btn('fullscreen-btn'), btn('info-btn')];
    if (nameW != null) items.push({ id: 'face-name', w: nameW, h: BTN });
    items.push(btn('share-btn'), btn('observatory-link'), btn('inspector-link'));
    return { corner: 'tr', items, defaultSplit: nameW != null ? 3 : 2, rowOrder: RIGHT_ROW_ORDER };
}

function leftGroup(ids: string[]): CornerGroup {
    return { corner: 'tl', items: ids.map(btn), defaultSplit: ids.length };
}

describe('clearance predicates', () => {
    const r: Rect = { left: 100, top: 100, right: 200, bottom: 150 };

    test('rectsClear honors the gap on every side', () => {
        expect(rectsClear({ left: 0, top: 0, right: 98, bottom: 300 }, r, 2)).toBe(true);
        expect(rectsClear({ left: 0, top: 0, right: 99, bottom: 300 }, r, 2)).toBe(false);
        expect(rectsClear({ left: 0, top: 152, right: 300, bottom: 200 }, r, 2)).toBe(true);
        expect(rectsClear({ left: 0, top: 151, right: 300, bottom: 200 }, r, 2)).toBe(false);
    });

    test('circleClearOfRect uses nearest-point distance', () => {
        // Corner approach: nearest point is (100,100).
        const far: Circle = { cx: 70, cy: 70, r: 40 };
        expect(circleClearOfRect(far, r, 2)).toBe(true);  // dist ~42.43 >= 42
        expect(circleClearOfRect({ ...far, r: 41 }, r, 2)).toBe(false); // 42.43 < 43
        // Directly above.
        expect(circleClearOfRect({ cx: 150, cy: 60, r: 38 }, r, 2)).toBe(true);
        expect(circleClearOfRect({ cx: 150, cy: 61, r: 38 }, r, 2)).toBe(false);
    });
});

describe('minClearDy', () => {
    test('already clear -> 0', () => {
        const avoid: AvoidTargets = { circles: [{ cx: 300, cy: 300, r: 50 }], rects: [] };
        expect(minClearDy(avoid, [{ left: 0, top: 0, right: 100, bottom: 40 }], 2)).toBe(0);
    });

    test('single blocking rect above a circle', () => {
        // Circle overlapping the rect from below-left is pushed straight down.
        const c: Circle = { cx: 100, cy: 50, r: 30 };
        const chrome: Rect = { left: 70, top: 0, right: 130, bottom: 40 };
        const dy = minClearDy({ circles: [c], rects: [] }, [chrome], 2);
        // Needs cy >= 40 + (30+2) => dy = 22 (dx = 0).
        expect(dy).toBeCloseTo(22, 6);
    });

    test('translating can push a circle into a rect it initially cleared (interval union)', () => {
        const c: Circle = { cx: 100, cy: 50, r: 30 };
        const upper: Rect = { left: 70, top: 0, right: 130, bottom: 40 };   // forces dy 22
        const lower: Rect = { left: 80, top: 90, right: 120, bottom: 126 }; // initially clear; blocks dy in (8,108)
        expect(minClearDy({ circles: [c], rects: [] }, [lower], 2)).toBe(0);
        const dy = minClearDy({ circles: [c], rects: [] }, [upper, lower], 2);
        // dy=22 lands inside the lower rect's blocked interval; must jump past it.
        expect(dy).toBeCloseTo(126 + 32 - 50, 6); // 108
    });

    test('rect target push-down', () => {
        const target: Rect = { left: 0, top: 20, right: 500, bottom: 60 };
        const chrome: Rect = { left: 400, top: 16, right: 480, bottom: 52 };
        const dy = minClearDy({ circles: [], rects: [target] }, [chrome], 2);
        expect(dy).toBeCloseTo(52 + 2 - 20, 6); // 34
    });

    test('matches brute force on a messy arrangement', () => {
        const avoid: AvoidTargets = {
            circles: [
                { cx: 120, cy: 80, r: 60 },
                { cx: 260, cy: 40, r: 25 },
            ],
            rects: [{ left: 30, top: 10, right: 90, bottom: 44 }],
        };
        const chrome: Rect[] = [
            { left: 16, top: 16, right: 180, bottom: 52 },
            { left: 300, top: 16, right: 336, bottom: 140 },
            { left: 100, top: 130, right: 200, bottom: 160 },
        ];
        const exact = minClearDy(avoid, chrome, 2);
        const clearAt = (dy: number) =>
            avoid.circles.every(c => chrome.every(r => circleClearOfRect({ ...c, cy: c.cy + dy }, r, 2)))
            && avoid.rects.every(t => chrome.every(r => rectsClear(
                { ...t, top: t.top + dy, bottom: t.bottom + dy }, r, 2)));
        let brute = 0;
        while (!clearAt(brute) && brute < 2000) brute += 0.25;
        expect(exact).toBeGreaterThanOrEqual(brute - 0.25);
        expect(exact).toBeLessThanOrEqual(brute + EPS);
        expect(clearAt(exact + EPS)).toBe(true);
    });
});

describe('splitOrder', () => {
    test('walks outward from the preferred split, larger side first', () => {
        expect(splitOrder(6, 3)).toEqual([3, 4, 2, 5, 1, 6, 0]);
        expect(splitOrder(3, 3)).toEqual([3, 2, 1, 0]);
        expect(splitOrder(4, 0)).toEqual([0, 1, 2, 3, 4]);
        expect(splitOrder(2, 5)).toEqual([2, 1, 0]);
    });
});

describe('placeGroup', () => {
    test('default Chronometer right L: fullscreen/info/name row, share/apps column', () => {
        const placed = placeGroup(rightGroup(130), 3, 1000, 8, 16);
        const byId = Object.fromEntries(placed.map(p => [p.id, p]));
        expect(byId['fullscreen-btn']).toMatchObject({ right: 16, top: 16 });
        expect(byId['info-btn']).toMatchObject({ right: 60, top: 16 });
        expect(byId['face-name']).toMatchObject({ right: 104, top: 16 });
        expect(byId['share-btn']).toMatchObject({ right: 16, top: 60 });
        expect(byId['observatory-link']).toMatchObject({ right: 16, top: 104 });
        expect(byId['inspector-link']).toMatchObject({ right: 16, top: 148 });
        // Viewport-space rect sanity for a right-anchored item.
        expect(byId['fullscreen-btn'].rect).toEqual({ left: 948, top: 16, right: 984, bottom: 52 });
    });

    test('hidden items leave no holes (all-faces page left row)', () => {
        const placed = placeGroup(leftGroup(['back-link', 'selected-faces-link']), 2, 1000, 8, 16);
        expect(placed.map(p => p.left)).toEqual([16, 60]);
    });

    test('pure column anchors its first item in the corner', () => {
        const placed = placeGroup(rightGroup(null), 0, 1000, 8, 16);
        expect(placed.map(p => p.top)).toEqual([16, 60, 104, 148, 192]);
        expect(placed.every(p => p.right === 16)).toBe(true);
    });

    test('share rowed under pressure slots between fullscreen and info', () => {
        // Split 4 with a name: share joins the row but by display rank sits
        // beside the corner, with the name outboard; the app links keep the
        // column under fullscreen.
        const placed = placeGroup(rightGroup(130), 4, 1000, 8, 16);
        const byId = Object.fromEntries(placed.map(p => [p.id, p]));
        expect(byId['fullscreen-btn']).toMatchObject({ right: 16, top: 16 });
        expect(byId['share-btn']).toMatchObject({ right: 60, top: 16 });
        expect(byId['info-btn']).toMatchObject({ right: 104, top: 16 });
        expect(byId['face-name']).toMatchObject({ right: 148, top: 16 });
        expect(byId['observatory-link']).toMatchObject({ right: 16, top: 60 });
        expect(byId['inspector-link']).toMatchObject({ right: 16, top: 104 });
    });

    test('pure row without a name keeps share beside the corner', () => {
        const placed = placeGroup(rightGroup(null), 5, 1000, 8, 16);
        const byId = Object.fromEntries(placed.map(p => [p.id, p]));
        expect(byId['fullscreen-btn'].right).toBe(16);
        expect(byId['share-btn'].right).toBe(60);
        expect(byId['info-btn'].right).toBe(104);
        expect(byId['observatory-link'].right).toBe(148);
        expect(byId['inspector-link'].right).toBe(192);
    });

    test('within-group arms never collide', () => {
        for (const nameW of [null, 130]) {
            const g = rightGroup(nameW);
            for (let split = 0; split <= g.items.length; split++) {
                const placed = placeGroup(g, split, 1000, 8, 16);
                for (let i = 0; i < placed.length; i++) {
                    for (let j = i + 1; j < placed.length; j++) {
                        expect(rectsClear(placed[i].rect, placed[j].rect, CHROME_GAP_PX)).toBe(true);
                    }
                }
            }
        }
    });
});

describe('layoutChrome selection', () => {
    const opts = { viewportW: 1000, maxDy: 200 };

    test('no chrome -> trivial result', () => {
        const res = layoutChrome([{ corner: 'tl', items: [], defaultSplit: 0 }],
            { circles: [], rects: [] }, opts);
        expect(res).toMatchObject({ dy: 0, feasible: true, comboKey: 'none', placed: [] });
    });

    test('nothing to avoid -> default combo at dy=0', () => {
        const res = layoutChrome([leftGroup(['a', 'b']), rightGroup(130)],
            { circles: [], rects: [] }, opts);
        expect(res.comboKey).toBe('tl2.tr3');
        expect(res.dy).toBe(0);
        expect(res.feasible).toBe(true);
    });

    test('first preference that clears in place wins over lower-dy alternatives', () => {
        // A circle parked under the second row-arm slot blocks split>=2 but
        // not split 1 (row arm of one item + column).
        const g: CornerGroup = { corner: 'tl', items: [btn('a'), btn('b')], defaultSplit: 2 };
        const blocker: Circle = { cx: 78, cy: 34, r: 12 }; // sits on item b's row slot (60..96 x 16..52)
        const res = layoutChrome([g], { circles: [blocker], rects: [] }, opts);
        expect(res.comboKey).toBe('tl1');
        expect(res.dy).toBe(0);
    });

    test('when no combo clears in place, minimal translate wins', () => {
        // A full-width band starting at y=40: every config overlaps it, and
        // the pure row (shallowest chrome, bottom 52) needs the least push.
        const g: CornerGroup = { corner: 'tr', items: [btn('a'), btn('b'), btn('c')], defaultSplit: 0 };
        const band: Rect = { left: 0, top: 40, right: 1000, bottom: 400 };
        const res = layoutChrome([g], { circles: [], rects: [band] }, { viewportW: 1000, maxDy: 500 });
        expect(res.feasible).toBe(true);
        expect(res.comboKey).toBe('tr3'); // despite defaultSplit 0
        expect(res.dy).toBeCloseTo(52 + CHROME_GAP_PX - 40, 6);
        // And the reported dy actually clears.
        const moved: Rect = { ...band, top: band.top + res.dy, bottom: band.bottom + res.dy };
        for (const p of res.placed) {
            expect(rectsClear(moved, p.rect, CHROME_GAP_PX)).toBe(true);
        }
    });

    test('infeasible when translate exceeds maxDy', () => {
        const g: CornerGroup = { corner: 'tr', items: [btn('a')], defaultSplit: 1 };
        const face: Circle = { cx: 900, cy: 200, r: 300 }; // reaches under the corner button
        const res = layoutChrome([g], { circles: [face], rects: [] }, { viewportW: 1000, maxDy: 5 });
        expect(res.feasible).toBe(false);
        expect(res.dy).toBeGreaterThan(5);
    });

    test('colliding corner groups are rejected in favor of compatible configs', () => {
        // 240px viewport: two 3-item rows (ending at x=148 from each edge) must collide.
        const res = layoutChrome(
            [leftGroup(['a', 'b', 'c']), { corner: 'tr', items: [btn('x'), btn('y'), btn('z')], defaultSplit: 3 }],
            { circles: [], rects: [] }, { viewportW: 240, maxDy: 100 });
        for (let i = 0; i < res.placed.length; i++) {
            for (let j = i + 1; j < res.placed.length; j++) {
                expect(rectsClear(res.placed[i].rect, res.placed[j].rect, CHROME_GAP_PX)).toBe(true);
            }
        }
        expect(res.comboKey).not.toBe('tl3.tr3');
    });

    test('absurdly narrow viewport falls back to columns and reports honestly', () => {
        const res = layoutChrome(
            [leftGroup(['a', 'b']), { corner: 'tr', items: [btn('x'), btn('y')], defaultSplit: 2 }],
            { circles: [], rects: [] }, { viewportW: 60, maxDy: 100 });
        expect(res.comboKey).toBe('tl0.tr0!');
        expect(res.placed).toHaveLength(4);
    });
});

describe('optimizeGrid', () => {
    test('historical behavior when uncapped', () => {
        expect(optimizeGrid(1, 800, 600, GAP_PX, PADDING_PX)).toEqual({ cols: 1, rows: 1, size: 576 });
        expect(optimizeGrid(0, 800, 600, GAP_PX, PADDING_PX)).toEqual({ cols: 1, rows: 1, size: 0 });
        const five = optimizeGrid(5, 1280, 800, GAP_PX, PADDING_PX);
        expect(five.cols * five.rows).toBeGreaterThanOrEqual(5);
        expect(five.size).toBeGreaterThan(0);
    });

    test('maxSize caps the result and re-ties toward balance', () => {
        const capped = optimizeGrid(1, 800, 600, GAP_PX, PADDING_PX, 300);
        expect(capped.size).toBe(300);
        const sweep = optimizeGrid(6, 2000, 500, GAP_PX, PADDING_PX, 100);
        expect(sweep.size).toBe(100);
        expect(sweep.cols + sweep.rows).toBeLessThanOrEqual(6 + 1);
    });
});

describe('computeFaceRects', () => {
    test('single face centers in the container', () => {
        const { cells, gridW, totalH } = computeFaceRects(1, 1, 1, 500, 800, 600, GAP_PX);
        expect(cells).toEqual([{ x: 150, y: 50, size: 500 }]);
        expect(gridW).toBe(500);
        expect(totalH).toBe(500);
    });

    test('short top row nestles when (cols - remainder) is odd', () => {
        // 5 faces in 3 cols: remainder 2, nestle applies.
        const size = 100;
        const { cells, totalH } = computeFaceRects(5, 3, 2, size, 800, 600, GAP_PX);
        const cellStep = size + GAP_PX;
        const nestled = cellStep * Math.sqrt(3) / 2;
        expect(totalH).toBeCloseTo(nestled + size, 6);
        // Rows: first 2 cells on top (centered), 3 below.
        expect(cells[0].y).toBeCloseTo(cells[1].y, 6);
        expect(cells[2].y - cells[0].y).toBeCloseTo(nestled, 6);
        // Short row is centered over the full row.
        expect(cells[0].x - cells[2].x).toBeCloseTo((cellStep) / 2, 6);
    });

    test('dy translates every cell down rigidly', () => {
        const a = computeFaceRects(5, 3, 2, 100, 800, 600, GAP_PX, 0);
        const b = computeFaceRects(5, 3, 2, 100, 800, 600, GAP_PX, 37);
        for (let i = 0; i < a.cells.length; i++) {
            expect(b.cells[i].x).toBe(a.cells[i].x);
            expect(b.cells[i].y).toBeCloseTo(a.cells[i].y + 37, 9);
        }
    });
});

describe('layoutGridWithChrome cascade', () => {
    // Chronometer page modes: [left group, name width]
    const MODES: Record<string, { left: string[]; nameW: number | null }> = {
        single: { left: ['back-link', 'all-faces-link', 'selected-faces-link'], nameW: 130 },
        all: { left: ['back-link', 'selected-faces-link'], nameW: null },
        selected: { left: ['back-link', 'all-faces-link', 'edit-picks-link'], nameW: null },
    };
    const SIZES: Array<[number, number]> = [
        [320, 568], [375, 812], [768, 1024], [900, 900],
        [1280, 800], [1920, 1080], [3440, 1440], [1280, 300], [500, 400], [420, 260],
    ];
    const BOTTOM_CHROME = 95; // typical time-bar + location-panel height

    function groupsFor(mode: keyof typeof MODES): CornerGroup[] {
        const m = MODES[mode];
        return [
            { corner: 'tl', items: m.left.map(btn), defaultSplit: m.left.length },
            rightGroup(m.nameW),
        ];
    }

    test('invariants across the sweep', () => {
        for (const [vw, vh] of SIZES) {
            for (const count of [1, 5, 12, 30]) {
                for (const mode of Object.keys(MODES) as Array<keyof typeof MODES>) {
                    if (count > 1 && mode === 'single') continue;
                    const H = vh - BOTTOM_CHROME;
                    const res = layoutGridWithChrome(count, vw, H, { x: 0, y: 0 }, groupsFor(mode), vw);
                    const label = `${mode} ${count} faces @ ${vw}x${vh}`;
                    if (!res) {
                        expect(H, label).toBeLessThan(2 * PADDING_PX + 1);
                        continue;
                    }
                    // Faces stay inside the grid area (chromeGap from the bottom).
                    for (const cell of res.cells) {
                        expect(cell.y + cell.size, label).toBeLessThanOrEqual(H - CHROME_GAP_PX + 0.5);
                        expect(cell.x, label).toBeGreaterThanOrEqual(0);
                        expect(cell.x + cell.size, label).toBeLessThanOrEqual(vw);
                    }
                    // Chrome clears every face when the result claims feasibility.
                    if (res.feasible) {
                        for (const cell of res.cells) {
                            const c: Circle = {
                                cx: cell.x + cell.size / 2, cy: cell.y + cell.size / 2, r: cell.size / 2,
                            };
                            for (const p of res.chrome.placed) {
                                expect(circleClearOfRect(c, p.rect, CHROME_GAP_PX - 1e-6), label).toBe(true);
                            }
                        }
                    }
                    // Untranslated, unshrunk results really needed no help.
                    if (res.dy === 0 && !res.shrunk) {
                        const base = optimizeGrid(count, vw, H, GAP_PX, PADDING_PX);
                        expect(res.size, label).toBe(base.size);
                    }
                    // Shrinking is a last resort: a shrunk result implies the
                    // full-size layout was infeasible even with translate.
                    if (res.shrunk) {
                        const full = optimizeGrid(count, vw, H, GAP_PX, PADDING_PX);
                        expect(res.size, label).toBeLessThan(full.size);
                    }
                }
            }
        }
    });

    test('roomy viewport: default configs, no translate', () => {
        const res = layoutGridWithChrome(1, 1920, 985, { x: 0, y: 0 }, groupsFor('single'), 1920)!;
        expect(res.chrome.comboKey).toBe('tl3.tr3');
        expect(res.dy).toBe(0);
        expect(res.shrunk).toBe(false);
        expect(res.feasible).toBe(true);
    });

    test('golden outcomes', () => {
        const table: Record<string, unknown> = {};
        for (const [vw, vh] of SIZES) {
            for (const [mode, count] of [['single', 1], ['all', 30], ['selected', 5]] as const) {
                const res = layoutGridWithChrome(count, vw, vh - BOTTOM_CHROME, { x: 0, y: 0 },
                    groupsFor(mode), vw);
                table[`${mode}${count}@${vw}x${vh}`] = res && {
                    combo: res.chrome.comboKey, size: res.size, cols: res.cols,
                    dy: Math.round(res.dy * 100) / 100, shrunk: res.shrunk, feasible: res.feasible,
                };
            }
        }
        expect(table).toMatchSnapshot();
    });
});
