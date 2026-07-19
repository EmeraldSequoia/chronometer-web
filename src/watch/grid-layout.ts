/**
 * Pure geometry for the Chronometer's watch-face grid: optimal grid sizing,
 * cell placement (centered, short-top-row, hex-nestled), and the composition
 * with the corner-chrome engine — pick a chrome configuration, translate the
 * grid down when needed, shrink it as a last resort.
 *
 * Extracted from engine-entry.ts so the exact placement math used live is
 * also the math the avoidance search and the tests run against (the old
 * time-controller machinery kept a private copy of this geometry, which
 * rotted; see planning/2026-07-17-time-controller-cleanup.md §3).
 */

import {
    layoutChrome, type ChromeLayoutResult, type Circle, type CornerGroup,
    CHROME_GAP_PX, BTN_GAP, EDGE_MARGIN,
} from '../shared/chrome-layout.js';

export const GAP_PX = 12;
export const PADDING_PX = 12;

/**
 * Pick the column/row count maximizing face size for `count` square cells in
 * a container, ties broken toward balanced grids. `maxSize` caps the cell
 * size (used by the shrink search); Infinity reproduces the historical
 * behavior exactly.
 */
export function optimizeGrid(
    count: number,
    containerW: number, containerH: number,
    gap: number, padding: number,
    maxSize = Infinity,
): { cols: number; rows: number; size: number } {
    if (count <= 0) return { cols: 1, rows: 1, size: 0 };

    let bestCols = 1, bestRows = count, bestSize = 0;

    for (let c = 1; c <= count; c++) {
        const r = Math.ceil(count / c);
        const usableW = containerW - 2 * padding - gap * (c - 1);
        const usableH = containerH - 2 * padding - gap * (r - 1);
        const size = Math.min(Math.floor(Math.min(usableW / c, usableH / r)), maxSize);
        // Prefer larger size; break ties with smaller rows+cols (more balanced)
        const isBetter = size > bestSize;
        const isTie = size === bestSize && (c + r) < (bestCols + bestRows);
        if (isBetter || isTie) {
            bestSize = size;
            bestCols = c;
            bestRows = r;
        }
    }

    return { cols: bestCols, rows: bestRows, size: bestSize };
}

export interface FaceCell { x: number; y: number; size: number }

export interface GridPlacement {
    cells: FaceCell[];
    gridW: number;
    /** Height of the grid block (nestled first gap accounted for). */
    totalH: number;
}

/**
 * Cell positions for the centered grid layout: the incomplete row goes on
 * top; when (cols - remainder) is odd the round faces nestle into the gaps
 * of the short row, shrinking the first vertical step to cellStep*sqrt(3)/2.
 * `dy` translates the whole grid down from its centered position.
 */
export function computeFaceRects(
    count: number, cols: number, rows: number, size: number,
    W: number, H: number, gap: number, dy = 0,
): GridPlacement {
    const cellStep = size + gap; // center-to-center distance
    const remainder = count - cols * (rows - 1); // items in short top row

    const canNestle = rows > 1 && remainder !== cols && (cols - remainder) % 2 === 1;
    const nestledStep = canNestle ? cellStep * Math.sqrt(3) / 2 : cellStep;

    const gridW = cols * size + (cols - 1) * gap;
    // Row 0 at y=0, row 1 at y=nestledStep, row k>1 at y=nestledStep+(k-1)*cellStep
    const lastRowY = rows === 1 ? 0 : nestledStep + (rows - 2) * cellStep;
    const totalH = lastRowY + size;

    const offsetX = (W - gridW) / 2;
    const offsetY = (H - totalH) / 2 + dy;

    const cells: FaceCell[] = [];
    for (let i = 0; i < count; i++) {
        let row: number, colIdx: number, itemsInRow: number;

        if (i < remainder) {
            row = 0;
            colIdx = i;
            itemsInRow = remainder;
        } else {
            const j = i - remainder;
            row = 1 + Math.floor(j / cols);
            colIdx = j % cols;
            itemsInRow = cols;
        }

        // Center incomplete rows: extra offset for short rows
        const rowW = itemsInRow * size + (itemsInRow - 1) * gap;
        const rowOffsetX = (gridW - rowW) / 2;

        const x = offsetX + rowOffsetX + colIdx * cellStep;
        const rowY = row === 0 ? 0 : nestledStep + (row - 1) * cellStep;
        const y = offsetY + rowY;

        cells.push({ x, y, size });
    }
    return { cells, gridW, totalH };
}

export interface GridChromeResult {
    size: number;
    cols: number;
    rows: number;
    /** Final cell positions, translate included. */
    cells: FaceCell[];
    /** Downward translate applied to the grid. */
    dy: number;
    chrome: ChromeLayoutResult;
    /** True when the faces had to be resized below their optimal size. */
    shrunk: boolean;
    /** False only in the pathological case where even shrinking cannot clear. */
    feasible: boolean;
}

export interface GridChromeOpts {
    gap?: number;
    padding?: number;
    chromeGap?: number;
    btnGap?: number;
    edgeMargin?: number;
}

/**
 * The full cascade: lay the grid out optimally as if there were no chrome,
 * pick the best chrome configuration, and if none clears the faces translate
 * the grid down by the minimum that does (bounded by the bottom of the grid
 * area less the chrome gap — the area's bottom edge is the top of the bottom
 * chrome); as a last resort binary-search the largest face size that fits.
 *
 * `gridOrigin` is the grid container's viewport offset, so face circles and
 * chrome rects (viewport space) are comparable. Returns null when count<=0
 * or the container is too small for any face.
 */
export function layoutGridWithChrome(
    count: number,
    W: number, H: number,
    gridOrigin: { x: number; y: number },
    groups: CornerGroup[],
    viewportW: number,
    opts: GridChromeOpts = {},
): GridChromeResult | null {
    const gap = opts.gap ?? GAP_PX;
    const padding = opts.padding ?? PADDING_PX;
    const chromeGap = opts.chromeGap ?? CHROME_GAP_PX;

    interface Probe {
        cols: number; rows: number; size: number;
        maxDy: number;
        chrome: ChromeLayoutResult;
    }

    const evaluate = (sizeCap: number): Probe | null => {
        const og = optimizeGrid(count, W, H, gap, padding, sizeCap);
        if (og.size <= 0) return null;
        const placement = computeFaceRects(count, og.cols, og.rows, og.size, W, H, gap, 0);
        // The grid may slide down until it is chromeGap px above the grid
        // area's bottom edge (eating the aesthetic bottom padding, which is
        // preferable to shrinking the faces).
        const maxDy = Math.max(0, (H - placement.totalH) / 2 - chromeGap);
        const circles: Circle[] = placement.cells.map(c => ({
            cx: gridOrigin.x + c.x + c.size / 2,
            cy: gridOrigin.y + c.y + c.size / 2,
            r: c.size / 2,
        }));
        const chrome = layoutChrome(groups, { circles, rects: [] }, {
            viewportW, maxDy, gap: chromeGap,
            btnGap: opts.btnGap ?? BTN_GAP,
            edgeMargin: opts.edgeMargin ?? EDGE_MARGIN,
        });
        return { cols: og.cols, rows: og.rows, size: og.size, maxDy, chrome };
    };

    const finish = (p: Probe, shrunk: boolean): GridChromeResult => {
        const dy = Math.min(p.chrome.dy, p.maxDy);
        const placement = computeFaceRects(count, p.cols, p.rows, p.size, W, H, gap, dy);
        return {
            size: p.size, cols: p.cols, rows: p.rows,
            cells: placement.cells, dy,
            chrome: p.chrome, shrunk, feasible: p.chrome.feasible,
        };
    };

    const base = evaluate(Infinity);
    if (!base) return null;
    if (base.chrome.feasible) return finish(base, false);

    // Largest face size whose best configuration fits (translate included).
    let lo = 1, hi = base.size - 1;
    let best: Probe | null = null;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const probe = evaluate(mid);
        if (probe && probe.chrome.feasible) {
            best = probe;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (best) return finish(best, true);

    // Nothing clears even tiny faces (pathological container). Keep the
    // optimal layout, slide down as far as allowed, and accept the overlap.
    return finish(base, false);
}
