/**
 * Corner-chrome layout engine, shared by the Chronometer face pages and the
 * Inspector.
 *
 * The top buttons live in the top-left and top-right viewport corners. Each
 * corner's visible buttons form a group laid out in one of several
 * configurations: a pure row (extending inward from the corner), a pure
 * column (extending down the edge), or an L (a row arm plus a column arm
 * hanging below the corner cell). This module enumerates those
 * configurations, tests them against content the chrome must not cover
 * (face circles for the Chronometer, text/panel rects for the Inspector),
 * and picks the first configuration — in a caller-declared preference
 * order — that keeps at least CHROME_GAP_PX of clearance. When no
 * configuration clears at dy=0, it reports the minimal downward translate
 * of the content that would clear the best configuration, so the caller
 * can move (and, failing that, shrink) the content.
 *
 * Pure geometry: no DOM access. Callers measure elements and apply results.
 * Lineage: the overlap predicates descend from the time-controller
 * exclusion-rect machinery removed in d1e382b (recoverable at b57f1ac);
 * see planning/2026-07-17-time-controller-scrub-invisibility.md §3.
 */

/** Minimum clearance between chrome and content, in CSS px (the tunable N). */
export const CHROME_GAP_PX = 2;
/** Gap between adjacent chrome items (36px buttons at the historical 44px pitch). */
export const BTN_GAP = 8;
/** Inset of a corner cluster from the viewport edges. */
export const EDGE_MARGIN = 16;

export interface Rect { left: number; top: number; right: number; bottom: number }
export interface Circle { cx: number; cy: number; r: number }

/** One chrome element, pre-measured by the caller. Hidden elements are simply omitted. */
export interface ChromeItem { id: string; w: number; h: number }

export interface CornerGroup {
    corner: 'tl' | 'tr';
    /** Visible items only, in canonical order. The first item anchors the corner. */
    items: ChromeItem[];
    /**
     * Preferred row-arm length (in items). Other splits are tried outward
     * from this value, so the preferred shape wins whenever it fits.
     */
    defaultSplit: number;
    /**
     * Optional display order (item ids, corner-first) for row-arm members.
     * The canonical `items` order decides WHO joins the row as the split
     * grows; this decides WHERE a rowed item sits. Lets a button that
     * normally lives in the column (e.g. share) slot in next to the corner
     * when rowed, instead of landing outboard, so it stays easy to find.
     * Items not listed keep their canonical order after the listed ones.
     */
    rowOrder?: string[];
}

/** Content the chrome must keep CHROME_GAP_PX clear of, in viewport coords. */
export interface AvoidTargets { circles: Circle[]; rects: Rect[] }

export interface PlacedItem {
    id: string;
    top: number;
    /** CSS offset from the anchoring edge: left for 'tl' groups, right for 'tr'. */
    left?: number;
    right?: number;
    rect: Rect;
}

export interface ChromeLayoutResult {
    placed: PlacedItem[];
    /** Minimal downward content translate needed to clear the chosen config (0 = clears in place). */
    dy: number;
    /** True when dy <= maxDy and inter-group clearance is satisfied. */
    feasible: boolean;
    /** Stable id of the chosen configuration, for callers' change-detection keys. */
    comboKey: string;
}

export interface ChromeLayoutOpts {
    viewportW: number;
    /** How far the content may translate down before the caller must shrink it instead. */
    maxDy: number;
    gap?: number;
    btnGap?: number;
    edgeMargin?: number;
}

/** True when the two rects keep at least `gap` px of clearance. */
export function rectsClear(a: Rect, b: Rect, gap: number): boolean {
    return a.right + gap <= b.left || b.right + gap <= a.left
        || a.bottom + gap <= b.top || b.bottom + gap <= a.top;
}

/** True when the circle keeps at least `gap` px of clearance from the rect (nearest-point test). */
export function circleClearOfRect(c: Circle, rect: Rect, gap: number): boolean {
    const nearX = Math.max(rect.left, Math.min(c.cx, rect.right));
    const nearY = Math.max(rect.top, Math.min(c.cy, rect.bottom));
    const dx = c.cx - nearX;
    const dy = c.cy - nearY;
    const min = c.r + gap;
    return dx * dx + dy * dy >= min * min;
}

/**
 * Half-open interval (lo, hi) of downward translates dy for which the target
 * would violate clearance against one chrome rect; null when no dy does.
 * Intervals — rather than a per-pair minimum — matter because a target that
 * starts ABOVE a chrome rect can be pushed INTO it by a translate that some
 * other pair demands; the interval union captures that exactly.
 */
function blockedDyCircle(c: Circle, rect: Rect, gap: number): [number, number] | null {
    const R = c.r + gap;
    const dx = Math.max(rect.left - c.cx, c.cx - rect.right, 0);
    if (dx >= R) return null;
    const vy = Math.sqrt(R * R - dx * dx);
    return [rect.top - vy - c.cy, rect.bottom + vy - c.cy];
}

function blockedDyRect(target: Rect, chrome: Rect, gap: number): [number, number] | null {
    if (target.left - gap >= chrome.right || target.right + gap <= chrome.left) return null;
    return [chrome.top - gap - target.bottom, chrome.bottom + gap - target.top];
}

/**
 * Smallest dy >= 0 such that every avoid-target, rigidly translated down by
 * dy, keeps `gap` clearance from every chrome rect. 0 means already clear.
 */
export function minClearDy(avoid: AvoidTargets, chrome: Rect[], gap: number): number {
    const blocked: Array<[number, number]> = [];
    for (const r of chrome) {
        for (const c of avoid.circles) {
            const iv = blockedDyCircle(c, r, gap);
            if (iv && iv[1] > 0) blocked.push(iv);
        }
        for (const t of avoid.rects) {
            const iv = blockedDyRect(t, r, gap);
            if (iv && iv[1] > 0) blocked.push(iv);
        }
    }
    blocked.sort((a, b) => a[0] - b[0]);
    let dy = 0;
    for (const [lo, hi] of blocked) {
        if (lo <= dy && dy < hi) dy = hi;
    }
    return dy;
}

/**
 * Row-arm lengths to try, nearest the preferred split first (larger side
 * first on ties, biasing toward rows, which sit in usually-empty top
 * corners). E.g. n=6, preferred 3 -> [3, 4, 2, 5, 1, 6, 0].
 */
export function splitOrder(n: number, preferred: number): number[] {
    const p = Math.max(0, Math.min(n, preferred));
    const order: number[] = [p];
    for (let d = 1; d <= n; d++) {
        if (p + d <= n) order.push(p + d);
        if (p - d >= 0) order.push(p - d);
    }
    return order;
}

/** Lay one group out with `split` items in the row arm, the rest in the column arm. */
export function placeGroup(
    group: CornerGroup, split: number,
    viewportW: number, btnGap: number, edgeMargin: number,
): PlacedItem[] {
    const placed: PlacedItem[] = [];
    const rowArm = group.items.slice(0, split);
    const colArm = group.items.slice(split);
    if (group.rowOrder) {
        const rank = new Map(group.rowOrder.map((id, i) => [id, i]));
        rowArm.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    }

    const toPlaced = (it: ChromeItem, edgeOffset: number, top: number): PlacedItem => {
        if (group.corner === 'tl') {
            return {
                id: it.id, top, left: edgeOffset,
                rect: { left: edgeOffset, top, right: edgeOffset + it.w, bottom: top + it.h },
            };
        }
        const right = viewportW - edgeOffset;
        return {
            id: it.id, top, right: edgeOffset,
            rect: { left: right - it.w, top, right, bottom: top + it.h },
        };
    };

    let inset = edgeMargin;
    for (const it of rowArm) {
        placed.push(toPlaced(it, Math.round(inset), edgeMargin));
        inset += it.w + btnGap;
    }
    // The column arm hangs below the corner cell (below the row arm's first
    // item when there is one, else starting at the top margin).
    let top = edgeMargin + (rowArm.length > 0 ? rowArm[0].h + btnGap : 0);
    for (const it of colArm) {
        placed.push(toPlaced(it, edgeMargin, Math.round(top)));
        top += it.h + btnGap;
    }
    return placed;
}

interface Candidate {
    placed: PlacedItem[];
    dy: number;
    comboKey: string;
    prefRank: number;
}

/**
 * Choose configurations for all groups. Selection: the first combination in
 * preference order that clears the content in place (dy=0); else the
 * feasible combination (dy <= maxDy) with the smallest dy; else — so the
 * caller can shrink content and retry — the smallest-dy combination overall,
 * flagged infeasible. Combinations whose groups collide with each other are
 * skipped (unless nothing survives that test, when both groups fall back to
 * pure columns, which cannot mutually collide at any plausible width).
 */
export function layoutChrome(
    groups: CornerGroup[], avoid: AvoidTargets, opts: ChromeLayoutOpts,
): ChromeLayoutResult {
    const gap = opts.gap ?? CHROME_GAP_PX;
    const btnGap = opts.btnGap ?? BTN_GAP;
    const edgeMargin = opts.edgeMargin ?? EDGE_MARGIN;

    if (groups.every(g => g.items.length === 0)) {
        return { placed: [], dy: 0, feasible: true, comboKey: 'none' };
    }

    // All (splitA, splitB, ...) combinations, ranked by summed per-group
    // preference (ties: worst single group, then first group).
    const orders = groups.map(g => splitOrder(g.items.length, g.defaultSplit));
    let combos: number[][] = [[]];
    for (const ord of orders) {
        combos = combos.flatMap(prefix => ord.map((_, i) => [...prefix, i]));
    }
    combos.sort((a, b) => {
        const sum = (x: number[]) => x.reduce((s, v) => s + v, 0);
        const d = sum(a) - sum(b);
        if (d !== 0) return d;
        const m = Math.max(...a) - Math.max(...b);
        if (m !== 0) return m;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
        return 0;
    });

    const evaluate = (splits: number[]): Omit<Candidate, 'prefRank'> | null => {
        const perGroup = groups.map((g, gi) => placeGroup(g, splits[gi], opts.viewportW, btnGap, edgeMargin));
        // Reject combos where the corner groups run into each other.
        for (let i = 0; i < perGroup.length; i++) {
            for (let j = i + 1; j < perGroup.length; j++) {
                for (const a of perGroup[i]) {
                    for (const b of perGroup[j]) {
                        if (!rectsClear(a.rect, b.rect, gap)) return null;
                    }
                }
            }
        }
        const placed = perGroup.flat();
        const dy = minClearDy(avoid, placed.map(p => p.rect), gap);
        const comboKey = groups.map((g, gi) => `${g.corner}${splits[gi]}`).join('.');
        return { placed, dy, comboKey };
    };

    let best: Candidate | null = null;
    for (let rank = 0; rank < combos.length; rank++) {
        const splits = combos[rank].map((oi, gi) => orders[gi][oi]);
        const cand = evaluate(splits);
        if (!cand) continue;
        if (cand.dy === 0) {
            return { placed: cand.placed, dy: 0, feasible: true, comboKey: cand.comboKey };
        }
        if (!best || cand.dy < best.dy) best = { ...cand, prefRank: rank };
    }

    if (!best) {
        // Even pure columns collide only when the viewport is narrower than
        // the two corner cells; place them anyway and report the overlap.
        const perGroup = groups.map(g => placeGroup(g, 0, opts.viewportW, btnGap, edgeMargin));
        const placed = perGroup.flat();
        const dy = minClearDy(avoid, placed.map(p => p.rect), gap);
        const comboKey = groups.map(g => `${g.corner}0`).join('.') + '!';
        return { placed, dy, feasible: dy <= opts.maxDy, comboKey };
    }

    return {
        placed: best.placed, dy: best.dy,
        feasible: best.dy <= opts.maxDy, comboKey: best.comboKey,
    };
}
