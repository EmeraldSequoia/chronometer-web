/**
 * The condensed date line never overflows (date-view.ts `drawBlock`, forced
 * units): a line wider than its box is pushed inside its allowed span, and one
 * wider than the span is shrunk to fit — while a line that fits its box is
 * drawn exactly where it always was. Fake canvas context: advance width
 * 0.55 em per character, cap height 0.72 em, descenders 0.21 em.
 * (planning/2026-09-25-a5-condensed-date-overflow.md)
 */
import { describe, test, expect } from 'vitest';
import { drawDateView, extractDateFields } from '../date-view';
import type { LayoutParams } from '../layout';

interface Call { text: string; x: number; px: number; w: number }

function fakeCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
    const calls: Call[] = [];
    let font = '10px Arial';
    const px = (): number => parseFloat(font);
    const width = (t: string): number => 0.55 * px() * t.length;
    const ctx = {
        get font() { return font; }, set font(f: string) { font = f; },
        textAlign: 'left', textBaseline: 'alphabetic', fillStyle: '',
        save() {}, restore() {},
        measureText(t: string) {
            const p = px();
            return { width: width(t), actualBoundingBoxAscent: 0.72 * p, actualBoundingBoxDescent: /[gjpqy]/.test(t) ? 0.21 * p : 0 };
        },
        fillText(t: string, x: number) { calls.push({ text: t, x, px: px(), w: width(t) }); },
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

/** A5-like split/condensed layout: weekday box left, date2 box right (content px). */
function a5(over: Partial<LayoutParams>): LayoutParams {
    return {
        dateMode: 'split', dateCondensed: true, dateSegCenter: false, dateBaselineBottom: 900,
        dateCX: 250, dateCY: 850, dateW: 800, dateH: 200,
        date2CX: 1510, date2CY: 850, date2W: 410, date2H: 200,
        ...over,
    } as unknown as LayoutParams;
}

const HNL = 'Pacific/Honolulu';
/** Julian 25 Sep 1401 BCE: the longest line — "Sep 25  1401 BCE  Julian  LMT  leap". */
const DATE = new Date(Date.UTC(-1400, 8, 13, 20));
const U = 72;   // the weekday fits its 800×200 box at UNIT_MAX
// Segment widths at the fake metrics (REL 1 / 0.42 / 0.21, gaps 0.35 × the larger rel).
const LINE_W = 0.55 * U * 6 + 0.35 * U
    + 0.55 * 0.42 * U * 8 + 0.35 * 0.42 * U
    + 0.55 * 0.21 * U * 6 + 0.35 * 0.21 * U
    + 0.55 * 0.21 * U * 3 + 0.35 * 0.21 * U
    + 0.55 * 0.21 * U * 4;

function drawLine(L: LayoutParams): { calls: Call[]; left: number; right: number; px: number } {
    const { ctx, calls } = fakeCtx();
    drawDateView(ctx, L, DATE, HNL);
    const f = extractDateFields(DATE, HNL);
    const line = calls.filter((c) => c.text !== f.weekday);
    expect(line.map((c) => c.text)).toEqual(['Sep 25', '1401 BCE', 'Julian', 'LMT', 'leap']);
    const left = line[0].x, right = line[line.length - 1].x + line[line.length - 1].w;
    return { calls: line, left, right, px: line[0].px };
}

describe('condensed date line width guard', () => {
    test('the fixture is the longest line', () => {
        const f = extractDateFields(DATE, HNL);
        expect(f).toMatchObject({ monthDay: 'Sep 25', year: '1401 BCE', julian: true, tzAbbrev: 'LMT', leap: true });
        expect(LINE_W).toBeGreaterThan(410);
    });

    test('a line that fits its box is centred in it at the weekday unit, as before', () => {
        const r = drawLine(a5({ date2W: 600 }));
        expect(r.px).toBeCloseTo(U, 6);
        expect(r.left).toBeCloseTo(1510 - LINE_W / 2, 6);
        expect(r.right).toBeCloseTo(1510 + LINE_W / 2, 6);
    });

    test('wider than the box but not the span: pushed left to the span end, not shrunk', () => {
        const r = drawLine(a5({ date2W: 410, date2SpanMin: 1162, date2SpanMax: 1706 }));
        expect(r.px).toBeCloseTo(U, 6);                  // full size
        expect(r.right).toBeCloseTo(1706, 6);            // right edge at the margin
        expect(r.left).toBeCloseTo(1706 - LINE_W, 6);
        expect(r.left).toBeGreaterThanOrEqual(1162);
    });

    test('wider than the span: shrunk uniformly to the span', () => {
        const r = drawLine(a5({ date2W: 410, date2SpanMin: 1300, date2SpanMax: 1706 }));
        const span = 406;
        expect(r.px).toBeCloseTo(U * span / LINE_W, 6);
        expect(r.left).toBeCloseTo(1300, 6);
        expect(r.right).toBeCloseTo(1706, 6);
        // uniform: every segment scaled by the same factor
        for (const c of r.calls) expect(c.px / U).toBeCloseTo(span / LINE_W * (c.text === 'Sep 25' ? 1 : c.text === '1401 BCE' ? 0.42 : 0.21), 6);
    });

    test('no span given (A6-style box): the box itself is the limit', () => {
        const r = drawLine(a5({ date2W: 410 }));
        expect(r.px).toBeCloseTo(U * 410 / LINE_W, 6);
        expect(r.left).toBeCloseTo(1510 - 205, 6);
        expect(r.right).toBeCloseTo(1510 + 205, 6);
    });
});
