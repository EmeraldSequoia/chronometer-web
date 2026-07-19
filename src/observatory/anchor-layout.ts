/**
 * Observatory adaptive layout — iteration 3 (the nine aspect anchors).
 *
 * See planning/2026-06-15-observatory-layout-iter3.md. This module is the
 * production home of the per-anchor geometry that was tuned in
 * `harness/layout-harness.html`; per §9.6 the harness imports the SAME functions
 * (passing its live slider values where production passes the baked §9.4 ship
 * constants) so the reference and the app can never silently diverge.
 *
 * Pipeline (`computeLayout`, §9.3):
 *   1. Safe rect — the design surface (§1): physical viewport minus the device
 *      safe-area insets. The caller obtains the insets (via `viewport-fit=cover`
 *      + `env(safe-area-inset-*)`) and passes them in.
 *   2. CC2 chrome-drop — if the safe rect can't fit the time-controller's default
 *      popover (200×368) we drop the header + footer bands entirely.
 *   3. Pick the anchor from the safe-rect aspect (hard snap at the §7 thresholds).
 *   4. Build the base template (A2 → portraitTwoBand, A3/A3m → portraitOneBand,
 *      else → computeBaseLayout) and run that anchor's `applyXxx` adjustments.
 *   5. Offset the (content-space) result into the safe rect, below the header.
 *
 * Coordinates: each `applyXxx` works in *content space* — origin at the top-left
 * of the content rect (inside the safe rect, below the header band), so
 * `bounds.top = 0` and `bounds.bottom` is the footer top. `computeLayout` then
 * shifts every coordinate by `(insetLeft, insetTop + headerH)` so the returned
 * `LayoutParams` are absolute canvas (CSS-px) coordinates, exactly as the
 * renderers and the click hit-test already expect. The starfield/background
 * stays full-window (it reads `viewW/viewH`, which remain the physical size).
 */

import {
    type LayoutParams,
    type ChromeParams,
    computeBaseLayout,
    portraitTwoBand,
    portraitOneBand,
    rescaleMainDial,
} from './layout.js';
import {
    type DateFields,
    extractDateFields,
    condensedDateLayout,
    measureRowTexts,
} from './date-view.js';

// ---------------------------------------------------------------------------
// Anchor identity + selection (§7)
// ---------------------------------------------------------------------------

export type AnchorId = 'A1' | 'A2' | 'A3m' | 'A3' | 'Asq' | 'A4' | 'A5' | 'Awide' | 'A6';

/** Anchors sorted by aspect (W/H), narrowest → widest. */
export const ANCHORS_BY_ASPECT: readonly AnchorId[] = [
    'A1', 'A2', 'A3m', 'A3', 'Asq', 'A4', 'A5', 'Awide', 'A6',
];

/**
 * Shipping thresholds between adjacent anchors (§7). Most default to the log
 * midpoint √(Aₙ·Aₙ₊₁); three are chosen overrides (A1↔A2, A5↔Awide, Awide↔A6).
 * Aspect-sorted boundaries: A1·A2 · A2·A3m · A3m·A3 · A3·Asq · Asq·A4 · A4·A5 ·
 * A5·Awide · Awide·A6.
 */
export const SHIP_THRESHOLDS: readonly number[] = [
    0.177, 0.591, 0.704, 0.851, 1.204, 1.699, 2.595, 8.687,
];

/** Pick the anchor for a safe-rect aspect (hard snap). */
export function pickAnchor(aspect: number, thresholds: readonly number[] = SHIP_THRESHOLDS): AnchorId {
    for (let i = 0; i < thresholds.length; i++) {
        if (aspect < thresholds[i]) return ANCHORS_BY_ASPECT[i];
    }
    return ANCHORS_BY_ASPECT[ANCHORS_BY_ASPECT.length - 1];
}

/**
 * CC2 chrome-drop footprint: the time-controller's default-config popover (Date
 * tab, astro tab collapsed) measures 200×368 (tp-lower min-width drives W;
 * tp-upper+tp-lower stacked drive H). If the safe rect is narrower OR shorter
 * than this, the controller is unusable, so we drop both chrome bands.
 */
export const TC_POPOVER_W = 200;
export const TC_POPOVER_H = 368;

// ---------------------------------------------------------------------------
// Per-anchor tunables — defaults are the §9.4 ship constants. The harness
// overrides these with its live slider values.
// ---------------------------------------------------------------------------

export interface AnchorOptions {
    // A2
    a2Rules?: boolean;        // grow outer dials
    a2Reclaim?: boolean;      // reclaim ½ header→map gap
    a2Cluster?: boolean;      // shift cluster to clear the footer
    a2DateCenter?: boolean;   // centre date between map & dial
    dialK?: number;           // A2 outer-dial growth
    dateHFrac?: number;       // A2 date box height ÷ W
    mainDy?: number;          // A2 manual cluster nudge (− = up)
    dateDy?: number;          // A2 manual date nudge
    // A3 / A3m
    a3MoonCenter?: boolean;
    a3OuterAlign?: boolean;
    a3MapVCenter?: boolean;
    a3DisplayCenter?: boolean;
    a3DialK?: number;         // ext radius ÷ mainR
    a3DialGap?: number;       // ext rim gap ÷ mainR
    mapScale?: number;        // A3m map width ×
    // A4
    a4Sym?: boolean;
    // A5
    a5Row?: boolean;
    a5DateCenter?: boolean;   // centre-align condensed date segments
    // A6 / A1
    a6DialK?: number;         // outer ÷ main-R (A1 reuses this)
    a6FontK?: number;         // A6 font ÷ outer-dial ⌀
    // Asq
    asqMapK?: number;         // map width ÷ W
    asqOuterT?: number;       // outer-dial radial fraction
    // Awide
    awMoonK?: number;         // moon ÷ computed max
    awMapK?: number;          // map ÷ computed max
}

interface ResolvedOptions extends Required<AnchorOptions> {}

/** Apply the §9.4 ship defaults to a partial options object. */
function resolveOptions(o: AnchorOptions = {}): ResolvedOptions {
    return {
        a2Rules: o.a2Rules ?? true,
        a2Reclaim: o.a2Reclaim ?? true,
        a2Cluster: o.a2Cluster ?? true,
        a2DateCenter: o.a2DateCenter ?? true,
        dialK: o.dialK ?? 1.36,
        dateHFrac: o.dateHFrac ?? 0.144,
        mainDy: o.mainDy ?? 0,
        dateDy: o.dateDy ?? 0,
        a3MoonCenter: o.a3MoonCenter ?? true,
        a3OuterAlign: o.a3OuterAlign ?? true,
        a3MapVCenter: o.a3MapVCenter ?? true,
        a3DisplayCenter: o.a3DisplayCenter ?? true,
        a3DialK: o.a3DialK ?? 0.165,
        a3DialGap: o.a3DialGap ?? 0.04,
        mapScale: o.mapScale ?? 1.10,
        a4Sym: o.a4Sym ?? true,
        a5Row: o.a5Row ?? true,
        a5DateCenter: o.a5DateCenter ?? false,
        a6DialK: o.a6DialK ?? 0.65,
        a6FontK: o.a6FontK ?? 0.35,
        asqMapK: o.asqMapK ?? 0.37,
        asqOuterT: o.asqOuterT ?? 0.42,
        awMoonK: o.awMoonK ?? 1,
        awMapK: o.awMapK ?? 1,
    };
}

/** Content-rect bounds passed to each `applyXxx` (content space, top = 0). */
export interface Bounds {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

// ---------------------------------------------------------------------------
// Shared mutators (ported from the harness)
// ---------------------------------------------------------------------------

/**
 * Rescale + move the whole main-dial cluster (main + the three inner subdials),
 * preserving the internal geometry (everything inside is ∝ mainR about the
 * centre).
 */
export function rescaleMain(L: LayoutParams, cx: number, cy: number, r: number): void {
    // Delegate to the production helper, which rebuilds the dial's *full*
    // mainR-proportional geometry (rings/ticks/numbers/fonts), not just the
    // radius + subdials. (The old factor-scaling here left the 24-hour ring at
    // the base radius, drawing it outside a resized dial — the Asq bug.)
    rescaleMainDial(L, cx, cy, r);
}

function shiftMain(L: LayoutParams, d: number): void {
    L.mainCY += d; L.utcCY += d; L.solarCY += d; L.sidCY += d;
}
function shiftAll(L: LayoutParams, d: number): void {
    shiftMain(L, d);
    L.altCY += d; L.azCY += d; L.eotCY += d; L.eclipseCY += d;
}

// ===========================================================================
// A2 — iPhone portrait (aspect 0.512)
// ===========================================================================

/**
 * Size the A2 date box independently of the map (decoupled). Mode pinned to
 * 'row'; box height ∝ content width so the font scales with available size — no
 * map coupling, no size-triggered mode flip, no accidental 80px cap.
 */
function a2DateBox(L: LayoutParams, W: number, dateHFrac: number): void {
    L.dateMode = 'row';
    L.dateCX = W / 2;
    L.dateW = W - 32;                 // generous; fit is height-limited
    L.dateH = dateHFrac * W;          // ∝ content width (was 0.45·mapH)
}

/**
 * Grow the four outer dials by `k`, holding BOTH their distance to the main dial
 * (rim gap, measured from `origMain`) and their margin to the nearest *side*
 * edge. The dial therefore repositions angularly. The eclipse is a plain extR
 * dial (footprint = extR, per CC1).
 */
function a2OuterDials(
    L: LayoutParams, bounds: Bounds, k: number, origMain: { x: number; y: number },
): void {
    const R = L.mainR;
    const { left, right } = bounds;
    const extR0 = L.altR;
    const place = (exC: number, eyC: number, er: number) => {
        const onRight = exC >= origMain.x;
        const onTop = eyC <= origMain.y;
        const mS = onRight ? (right - (exC + er)) : ((exC - er) - left);
        const gap = Math.hypot(exC - origMain.x, eyC - origMain.y) - R - er;
        const er2 = er * k, rho = R + gap + er2;
        const cX = onRight ? (right - mS - er2) : (left + mS + er2);
        const under = rho * rho - (cX - L.mainCX) * (cX - L.mainCX);
        if (under >= 0) {
            const off = Math.sqrt(under);
            return { x: cX, y: onTop ? L.mainCY - off : L.mainCY + off, r: er2 };
        }
        const d = Math.hypot(exC - L.mainCX, eyC - L.mainCY) || 1;
        return { x: L.mainCX + (exC - L.mainCX) * rho / d, y: L.mainCY + (eyC - L.mainCY) * rho / d, r: er2 };
    };
    let m = place(L.altCX, L.altCY, L.altR); L.altCX = m.x; L.altCY = m.y; L.altR = m.r;
    m = place(L.azCX, L.azCY, L.azR); L.azCX = m.x; L.azCY = m.y; L.azR = m.r;
    m = place(L.eotCX, L.eotCY, L.eotR); L.eotCX = m.x; L.eotCY = m.y; L.eotR = m.r;
    m = place(L.eclipseCX, L.eclipseCY, extR0); L.eclipseCX = m.x; L.eclipseCY = m.y; // ECL draws at altR
}

function applyA2(L: LayoutParams, bounds: Bounds, o: ResolvedOptions): void {
    a2DateBox(L, bounds.right, o.dateHFrac);   // decouple the date from the map
    const FOOTER_MARGIN = 6;
    // 1. Halve the (mostly empty) border between the header row and the moon/map.
    if (o.a2Reclaim) {
        const up = Math.min(L.moonCY - L.moonR, L.earthCY - L.earthH / 2) * 0.5;
        L.moonCY -= up; L.earthCY -= up;
    }
    const origMain = { x: L.mainCX, y: L.mainCY };
    // 2. Grow + angularly reposition the outer dials.
    if (o.a2Rules) a2OuterDials(L, bounds, o.dialK, origMain);
    // 3. Move the whole dial cluster up so the bottom dials clear the footer row.
    if (o.a2Cluster) {
        const maxBottom = Math.max(L.azCY + L.azR, L.eotCY + L.eotR);
        const up = maxBottom - (bounds.bottom - FOOTER_MARGIN);
        if (up > 0) shiftAll(L, -up);
    }
    if (o.mainDy) shiftAll(L, o.mainDy);
    // 4. Date: plain-centre between the (moved) map bottom and the (shifted) dial top.
    if (o.a2DateCenter) {
        const mapBottom = L.earthCY + L.earthH / 2;
        const mainTop = L.mainCY - L.mainR;
        L.dateCY = (mapBottom + mainTop) / 2 + o.dateDy;
    }
}

// ===========================================================================
// A3 / A3m — iPad portrait (one-band) (aspect 0.725 / 0.683)
// ===========================================================================

/**
 * Explicit A3 outer-dial rule: radius = k·mainR, placed at a held rim-gap g in
 * each bottom corner, clamped to the side edges and so its TOP mirror clears the
 * header band; shrink k if clamping pushes it into the rim. Top dials mirror the
 * bottom across the main centre (one radius + gap for all four).
 */
function applyA3Dials(L: LayoutParams, bounds: Bounds, o: ResolvedOptions): void {
    const cx = L.mainCX, cy = L.mainCY, R = L.mainR;
    const k = o.a3DialK, g = o.a3DialGap * R;   // gap ∝ mainR
    const bandBottom = Math.max(L.moonCY + L.moonR, L.earthCY + L.earthH / 2, L.dateCY + L.dateH / 2);
    const dir = (exC: number, eyC: number) => {
        const dx = exC - cx, dy = eyC - cy, d = Math.hypot(dx, dy) || 1;
        return { ux: dx / d, uy: dy / d };
    };
    const dAz = dir(L.azCX, L.azCY), dEot = dir(L.eotCX, L.eotCY);
    let er = k * R;
    const place = (d: { ux: number; uy: number }, gap: number) => {
        const D = R + gap + er;
        let x = cx + d.ux * D, y = cy + d.uy * D;
        x = Math.max(er, Math.min(bounds.right - er, x));      // clear side edges
        y = Math.min(y, 2 * cy - bandBottom - er);             // mirror (top) clears the band
        y = Math.max(y, cy);                                   // stay in the bottom half
        return { x, y };
    };
    for (let i = 0; i < 40; i++) {
        const az = place(dAz, g), eot = place(dEot, g);
        const rimOk = (p: { x: number; y: number }) => Math.hypot(p.x - cx, p.y - cy) >= R + er + g / 2;
        if (rimOk(az) && rimOk(eot)) break;
        er *= 0.94; if (er < 8) { er = 8; break; }
    }
    // moon-proximity cap: pull all four dials inward until alt's moon-gap = main-gap.
    const altMoonGapAt = (gap: number) => {
        const D = R + gap + er, ax = cx + dAz.ux * D, ay = cy - dAz.uy * D;   // alt = az mirrored in y
        return Math.hypot(ax - L.moonCX, ay - L.moonCY) - er - L.moonR;
    };
    let gMain = g;
    if (altMoonGapAt(g) < g) {
        let lo = 0, hi = g;
        for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (altMoonGapAt(mid) - mid > 0) lo = mid; else hi = mid; }
        gMain = lo;
    }
    const az = place(dAz, gMain), eot = place(dEot, gMain);
    L.azCX = az.x; L.azCY = az.y; L.azR = er;
    L.eotCX = eot.x; L.eotCY = eot.y; L.eotR = er;
    L.altCX = az.x; L.altCY = 2 * cy - az.y; L.altR = er;       // mirror to the top
    L.eclipseCX = eot.x; L.eclipseCY = 2 * cy - eot.y;          // ECL draws at L.altR = er
}

/** Rules shared by all one-band iPad portraits (A3 and A3m). */
function applyA3Common(L: LayoutParams, bounds: Bounds, o: ResolvedOptions): void {
    if (o.a3MoonCenter) {
        L.moonCX = (L.earthCX - L.earthW / 2) / 2;
        L.dateCX = (L.earthCX + L.earthW / 2 + bounds.right) / 2;
    }
    if (o.a3MapVCenter) {
        const dy = ((bounds.top + (L.mainCY - L.mainR)) / 2) - L.earthCY;
        L.moonCY += dy; L.earthCY += dy; L.dateCY += dy;
    }
    if (o.a3OuterAlign) applyA3Dials(L, bounds, o);
    if (o.a3DisplayCenter) {
        const top = Math.min(L.moonCY - L.moonR, L.earthCY - L.earthH / 2, L.mainCY - L.mainR, L.altCY - L.altR, L.eclipseCY - L.altR);
        const bot = Math.max(L.azCY + L.azR, L.eotCY + L.eotR, L.mainCY + L.mainR);
        const dy = ((bounds.top + bounds.bottom) / 2) - (top + bot) / 2;
        const keys: (keyof LayoutParams)[] = ['moonCY', 'earthCY', 'dateCY', 'mainCY', 'utcCY', 'solarCY', 'sidCY', 'altCY', 'azCY', 'eclipseCY', 'eotCY'];
        for (const key of keys) (L[key] as number) += dy;
    }
}

/** iPad mini (0.683): expand + centre the map, shrink the date to fit. */
function applyA3Mini(L: LayoutParams, bounds: Bounds, o: ResolvedOptions): void {
    const s = o.mapScale;
    L.earthW *= s; L.earthH *= s;            // expand the map
    L.earthCX = bounds.right / 2;            // centre horizontally
    L.dateW *= 0.95; L.dateH *= 0.95;        // date −5% to compensate for the wider map
    applyA3Common(L, bounds, o);
}

// ===========================================================================
// A4 — iPad landscape (aspect 1.45)
// ===========================================================================

/** Make the four outer dials vertically symmetric (space alt/az evenly; mirror y to ecl/eot). */
function applyA4Dials(L: LayoutParams): void {
    const r = L.altR;                          // all four share this radius
    const top = L.moonCY + L.moonR;            // moon bottom
    const bot = L.dateCY - L.dateH / 2;        // weekday ("Thursday") top
    const gap = (bot - top - 4 * r) / 3;       // 3 equal gaps around 2 dials
    L.altCY = top + gap + r;                   // upper-left
    L.azCY = top + 2 * gap + 3 * r;            // lower-left
    L.eclipseCY = L.altCY;                     // right column mirrors the y's
    L.eotCY = L.azCY;
}

// ===========================================================================
// A5 — iPhone landscape (aspect 1.99)
// ===========================================================================

function applyA5(
    L: LayoutParams, ctx: CanvasRenderingContext2D, fields: DateFields,
    bounds: Bounds, headerH: number, footerH: number, o: ResolvedOptions,
): void {
    L.dateCondensed = true;                 // right box: one line "md year tz" (A4 sizes, no dots)
    L.dateSegCenter = o.a5DateCenter;

    const W = bounds.right;
    const H = bounds.bottom + headerH + footerH;   // full safe-rect height
    const halfPad = 0.0125 * W;
    const mainCX = W / 2, mainCY = H / 2 - headerH, mainR = 0.475 * H;
    rescaleMain(L, mainCX, mainCY, mainR);

    const topRow = halfPad;
    const mAspect = (L.earthW / L.earthH) || 2;

    // Map: right margin = halfPad, top = topRow, ~2:1. Grow until the lower-left
    // corner's radial gap to the main rim = halfPad.
    const cornerGap = (eW: number) => {
        const xc = W - halfPad - eW, yc = topRow + eW / mAspect;
        return Math.hypot(xc - mainCX, yc - mainCY) - mainR;
    };
    let lo = 40, hi = W;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (cornerGap(m) > halfPad) lo = m; else hi = m; }
    L.earthW = lo; L.earthH = lo / mAspect;
    L.earthCX = W - halfPad - L.earthW / 2;
    L.earthCY = topRow + L.earthH / 2;

    // Date drop: weekday & date2 share a baseline so the deepest weekday descender
    // sits halfPad above the footer top.
    const descBottom = bounds.bottom - halfPad;
    L.dateBaselineBottom = descBottom;
    const dateTop = condensedDateLayout(ctx, fields.weekday, L.dateW, L.dateH, descBottom).top;

    if (!o.a5Row) {
        L.moonR = 0.13 * H; L.moonCY = topRow + L.moonR; L.moonCX = halfPad + L.moonR; return;
    }

    // ecl/eot radius: all three right-side gaps = halfPad.
    const cyR = ((L.earthCY + L.earthH / 2) + dateTop) / 2;
    const dyR = cyR - mainCY;
    const gapR = (rr: number) => Math.hypot((W - 2 * halfPad - 3 * rr) - mainCX, dyR) - mainR - rr - halfPad;
    let rlo = 1, rhi = mainR;
    for (let i = 0; i < 50; i++) { const m = (rlo + rhi) / 2; if (gapR(m) > 0) rlo = m; else rhi = m; }
    const r = rlo;

    const rimL = mainCX - mainR;
    const altCX = halfPad + r;
    const azCX = (altCX + rimL + r) / 2;
    const moonCX = (altCX + azCX) / 2;                 // moon centred over the alt/az pair

    // Moon auto-size: grow until the smallest of four gaps = halfPad.
    const V = (dateTop - topRow) / 2;
    const dxMoonAlt = (azCX - altCX) / 2;
    const moonR1 = Math.hypot(dxMoonAlt, V) - r - halfPad;   // radial moon↔alt/az gap
    const moonR2 = V - r - halfPad;                          // alt/az bottom ↔ weekday top
    const moonR3 = moonCX - halfPad;                         // left edge at the halfPad margin
    const dialGap = (mr: number) => Math.hypot(moonCX - mainCX, (topRow + mr) - mainCY) - mainR - mr;
    let glo = 20, ghi = Math.max(20, moonR3);
    for (let i = 0; i < 40; i++) { const m = (glo + ghi) / 2; if (dialGap(m) > halfPad) glo = m; else ghi = m; }
    const moonR4 = glo;                                      // radial moon↔main-dial gap
    const moonR = Math.max(20, Math.min(moonR1, moonR2, moonR3, moonR4));
    L.moonR = moonR;
    L.moonCY = topRow + moonR;
    const cyL = ((L.moonCY + moonR) + dateTop) / 2;    // alt/az: moon↔date centre

    L.altR = L.azR = L.eotR = r;
    L.eotCX = W - halfPad - r; L.eotCY = cyR;
    L.eclipseCX = W - 2 * halfPad - 3 * r; L.eclipseCY = cyR;   // ECL draws at L.altR = r
    L.altCX = altCX; L.altCY = cyL;
    L.azCX = azCX; L.azCY = cyL;
    L.moonCX = moonCX;
}

// ===========================================================================
// Awide — Ultrawide landscape (aspect ~3.556 / 32:9)
// ===========================================================================

function applyAwide(
    L: LayoutParams, ctx: CanvasRenderingContext2D, fields: DateFields,
    bounds: Bounds, _headerH: number, _footerH: number, o: ResolvedOptions,
): void {
    const W = bounds.right, availV = bounds.bottom;
    const hp = 0.0125 * W, gap = 2 * hp;
    const cy = availV / 2;
    // Near-full height, with a little breathing room top & bottom so the dial's
    // rim isn't flattened against the screen edges (min(halfGap/4, 2) px).
    const edgeMargin = Math.min(hp / 4, 2);
    const mainR = Math.max(2, availV / 2 - edgeMargin);
    const er_v = L.altR;                                   // base outer-dial radius

    // DATE sizing (split, shared baseline).
    const UNIT_MAX = 72, REF = 100;
    const wkText = fields.weekday, md = fields.monthDay, yr = fields.year, tz = fields.tzAbbrev;
    const m100 = measureRowTexts(ctx, wkText, md, yr, tz, '', REF);
    // Size the shared date unit to the actual space it must fit, on both axes —
    // not a single nominal width capped at UNIT_MAX (which pinned the date at 72
    // px and overflowed the side columns on short/chrome-dropped Awide windows).
    // The MDYtz line fits the right (map) column and the weekday fits the left
    // (moon) column, both ≈ the map-column budget 0.25·W (W5); and the block
    // scales with the viewport height (availV/4) so it shrinks with everything
    // else when the window is short.
    const sideBudget = 0.25 * W;
    const u = Math.min(
        UNIT_MAX,
        REF * sideBudget / m100.dateW,        // MDYtz fits the right column
        REF * sideBudget / m100.weekdayW,     // weekday fits the left column
        availV / 4,                           // scale with the height
    );
    const rm = measureRowTexts(ctx, wkText, md, yr, tz, '', u);
    ctx.font = `${u}px Arial, sans-serif`;
    let maxDesc = 0;
    for (const n of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) {
        const dd = ctx.measureText(n).actualBoundingBoxDescent; if (dd > maxDesc) maxDesc = dd;
    }
    const descBottom = availV - hp, baselineY = descBottom - maxDesc;
    const wkInkTop = baselineY - ctx.measureText(wkText).actualBoundingBoxAscent;   // floors the moon
    const dateInkTop = baselineY - ctx.measureText(md).actualBoundingBoxAscent;     // floors the map
    // Longest weekday (day-stable collision checks): width + ascent.
    const wedW = ctx.measureText('Wednesday').width;
    const wkAsc = ctx.measureText('Wednesday').actualBoundingBoxAscent;

    // MOON & MAP vertical maxima (map width also capped at 25% of W).
    const moonR_v = Math.max(2, (wkInkTop - 2 * gap) / 2) * o.awMoonK;
    const moonCY = wkInkTop / 2;
    const mapH = Math.min(Math.max(1, dateInkTop - 2 * gap), 0.125 * W) * o.awMapK;
    const mapW = 2 * mapH, mapCY = dateInkTop / 2;

    const radH = (R: number, vo: number, gg: number, e: number) =>
        Math.sqrt(Math.max(0, (R + e + gg) ** 2 - vo ** 2));
    const solveSpan = (fn: (g: number) => number) => {
        let lo = -mainR, hi = W;
        for (let i = 0; i < 70; i++) { const m = (lo + hi) / 2; if (fn(m) < W) lo = m; else hi = m; }
        return (lo + hi) / 2;
    };
    const vAz = (D: number) => Math.abs(cy - moonCY - D);

    const spanA = (mR: number, D: number, e: number) => (gg: number) =>
        4 * gg + 2 * mR + 2 * e + 2 * mapH + 2 * radH(mainR, D, gg, e);
    const spanB = (mR: number, D: number, e: number) => (gg: number) =>
        3 * gg + mR + radH(mR, D, gg, e) + radH(mainR, vAz(D), gg, e) + radH(mainR, D, gg, e) + e + 2 * mapH;

    // Choose the regime & sizes.
    let regimeB = false, moonR = moonR_v, er = er_v, Dy = er_v + hp;
    const g0 = solveSpan(spanA(moonR_v, Dy, er_v));
    if (g0 < 0) {
        regimeB = true;
        const gB = solveSpan(spanB(moonR_v, er_v + hp, er_v));
        if (gB >= hp && moonCY - 2 * er_v - hp >= 0) { Dy = er_v + hp; }
        else {
            const fit = (mR: number) => {
                const e = er_v * Math.min(1, mR / moonR_v), D = e + hp;
                return 3 * hp + mR + radH(mR, D, hp, e) + radH(mainR, vAz(D), hp, e) + radH(mainR, D, hp, e) + e + 2 * mapH;
            };
            let lo = 2, hi = moonR_v;
            for (let i = 0; i < 70; i++) { const m = (lo + hi) / 2; if (fit(m) < W) lo = m; else hi = m; }
            moonR = (lo + hi) / 2;
            const erTop = (moonCY - hp) / 2;
            if (er_v * Math.min(1, moonR / moonR_v) > erTop) moonR = Math.max(2, erTop / er_v * moonR_v);
            er = er_v * Math.min(1, moonR / moonR_v);
            Dy = er + hp;
        }
    }

    // --- Side-by-side outer-dial flavor (wide Awide) ------------------------
    // Alternative to the stacked alt/az & ecl/eot pairs: lay all four outer dials
    // as their own columns on `cy` (moon · alt · az · MAIN · ecl · eot · map),
    // with even gaps. A single dial (not a stacked pair) can be larger because it
    // doesn't share its column's height — capped at 0.8·mainR. We size it from the
    // even-gap horizontal packing (gap floored at halfPad) and use this flavor
    // only when it beats the stacked outer-dial size (so narrow Awide, where the
    // columns wouldn't fit, keeps the stacked pairs). Moon/map/weekday/date are
    // unchanged (moon still over the weekday, map over the date).
    const SBS_CAP_FRAC = 0.8;
    const clearG = hp;
    const DATE_FLOOR = 0.6;   // smallest date scale before we shrink the dials instead
    const sbsHorizFit = (W - 8 * hp - 2 * moonR_v - 2 * mainR - 2 * mapH) / 8;
    const baseFit = sbsHorizFit + hp;   // = (W − 2·moonR − 2·mainR − 2·mapH)/8 = g + erSbs
    // Resolve any date↔dial collision "date first, then dials": keep the big
    // dials and shrink the date so the weekday (under the moon, left) / the MDYtz
    // (under the map, right) clears the adjacent dial column; only if the date
    // would have to shrink past DATE_FLOOR do we shrink the dials instead (and
    // let the stacked layout win below if that's larger). The even gap at a dial
    // size e is g = baseFit − e, so the largest date scale that clears is:
    const dateScaleAt = (e: number) => {
        const g = baseFit - e;
        const sL = wedW > 0 ? 2 * (moonR_v + g - clearG) / wedW : 1;
        const sR = rm.dateW > 0 ? 2 * (mapH + g - clearG) / rm.dateW : 1;
        return Math.min(1, sL, sR);
    };
    let erSbs = Math.min(SBS_CAP_FRAC * mainR, sbsHorizFit);
    let dateScaleSbs = dateScaleAt(erSbs);
    if (dateScaleSbs < DATE_FLOOR) {
        const erL = baseFit - (DATE_FLOOR * wedW / 2 + clearG - moonR_v);
        const erR = baseFit - (DATE_FLOOR * rm.dateW / 2 + clearG - mapH);
        erSbs = Math.min(erSbs, erL, erR);
        dateScaleSbs = DATE_FLOOR;
    }
    if (erSbs > er) {
        const g = (W - 2 * moonR_v - 8 * erSbs - 2 * mainR - 2 * mapH) / 8;   // even gap (≥ hp)
        const moonCXs = g + moonR_v;
        const altCXs = moonCXs + moonR_v + g + erSbs;
        const azCXs = altCXs + 2 * erSbs + g;
        const dialCXs = azCXs + erSbs + g + mainR;
        const eclCXs = dialCXs + mainR + g + erSbs;
        const eotCXs = eclCXs + 2 * erSbs + g;
        const mapCXs = eotCXs + erSbs + g + mapH;

        rescaleMain(L, dialCXs, cy, mainR);
        L.altR = L.azR = L.eotR = erSbs;
        L.altCX = altCXs; L.altCY = cy;
        L.azCX = azCXs; L.azCY = cy;
        L.eclipseCX = eclCXs; L.eclipseCY = cy;
        L.eotCX = eotCXs; L.eotCY = cy;
        L.moonR = moonR_v; L.moonCX = moonCXs; L.moonCY = moonCY;
        L.earthW = mapW; L.earthH = mapH; L.earthCX = mapCXs; L.earthCY = mapCY;

        L.dateMode = 'split'; L.dateCondensed = true; L.dateSegCenter = false; L.dateForceU = undefined;
        L.dateBaselineBottom = baselineY + maxDesc;
        L.dateW = rm.weekdayW * dateScaleSbs; L.dateH = 4 * u * dateScaleSbs; L.dateCX = moonCXs; L.dateCY = baselineY;
        L.date2CX = mapCXs; L.date2CY = baselineY; L.date2W = (rm.dateW + 4) * dateScaleSbs; L.date2H = 4 * u * dateScaleSbs;

        const rEdge = W - hp, lEdge = hp;
        if (L.date2CX + L.date2W / 2 > rEdge) L.date2CX = rEdge - L.date2W / 2;
        if (L.dateCX - L.dateW / 2 < lEdge) L.dateCX = lEdge + L.dateW / 2;
        return;
    }

    // Placement for the resolved sizes.
    const aCY = regimeB ? moonCY : cy;
    const layout = (mR: number, D: number, e: number, rb: boolean) => {
        const g = Math.max(rb ? hp : 0, solveSpan(rb ? spanB(mR, D, e) : spanA(mR, D, e)));
        const moonCX = g + mR;
        const altazX = rb ? moonCX + radH(mR, D, g, e)            // radial moon→alt/az
                          : moonCX + mR + g + e;                  // horizontal moon→alt/az
        const dialCX = altazX + radH(mainR, rb ? vAz(D) : D, g, e); // alt/az→dial
        const ecletX = dialCX + radH(mainR, D, g, e);              // dial→ecl/eot (on cy)
        const mapCX = ecletX + e + g + mapH;
        return { g, moonCX, altazX, dialCX, ecletX, mapCX };
    };

    // C2/C3: make room for the LONGEST weekday (Wednesday) at the bottom-left.
    // (wedW / wkAsc computed above.)
    const fitsWk = (pos: ReturnType<typeof layout>, D: number, baseY: number) => {
        const azCY = aCY + D, azBottom = azCY + er, azLeft = pos.altazX - er;
        const vOverlap = (baseY - wkAsc) < azBottom && baseY > azCY - er;
        const hOverlap = (pos.moonCX + wedW / 2) > azLeft;
        return !(vOverlap && hOverlap);
    };
    let pos = layout(moonR, Dy, er, regimeB), baseY = baselineY;
    if (regimeB && !fitsWk(pos, Dy, baseY)) {
        Dy = er + pos.g / 2;                                  // C2: reduce the pair gap
        pos = layout(moonR, Dy, er, regimeB);
        if (!fitsWk(pos, Dy, baseY)) {
            const azBottom = aCY + Dy + er;                   // C3: move the date down
            baseY = Math.max(baselineY, Math.min(azBottom + wkAsc, availV - maxDesc));
        }
    }

    // If the longest weekday still runs into the az dial (e.g. roomy regime A,
    // which the C2/C3 cascade doesn't cover), shrink the date font so the weekday
    // clears the dial horizontally — and shrink the MDYtz on the right to match.
    // Uses Wednesday (longest) so it's day-stable; bottom-aligned, so the smaller
    // date still hugs the baseline.
    let dateScale = 1;
    {
        const azLeft = pos.altazX - er;
        const targetHalf = azLeft - hp - pos.moonCX;     // weekday half-width that clears az
        if (targetHalf > 0 && wedW / 2 > targetHalf) dateScale = Math.max(0.45, (2 * targetHalf) / wedW);
    }

    // Commit.
    rescaleMain(L, pos.dialCX, cy, mainR);
    L.altR = er; L.azR = er; L.eotR = er;
    L.altCX = pos.altazX; L.altCY = aCY - Dy; L.azCX = pos.altazX; L.azCY = aCY + Dy;
    L.eclipseCX = pos.ecletX; L.eclipseCY = cy - Dy; L.eotCX = pos.ecletX; L.eotCY = cy + Dy;
    L.moonR = moonR; L.moonCX = pos.moonCX; L.moonCY = moonCY;
    L.earthW = mapW; L.earthH = mapH; L.earthCX = pos.mapCX; L.earthCY = mapCY;

    L.dateMode = 'split'; L.dateCondensed = true; L.dateSegCenter = false; L.dateForceU = undefined;
    L.dateBaselineBottom = baseY + maxDesc;
    L.dateW = rm.weekdayW * dateScale; L.dateH = 4 * u * dateScale; L.dateCX = pos.moonCX; L.dateCY = baseY;
    L.date2CX = pos.mapCX; L.date2CY = baseY; L.date2W = (rm.dateW + 4) * dateScale; L.date2H = 4 * u * dateScale;

    // Guard: keep both date boxes on-screen regardless of u — clamp the MDYtz
    // box's right edge and the weekday box's left edge to a halfPad window margin.
    const rightEdge = W - hp, leftEdge = hp;
    if (L.date2CX + L.date2W / 2 > rightEdge) L.date2CX = rightEdge - L.date2W / 2;
    if (L.dateCX - L.dateW / 2 < leftEdge) L.dateCX = leftEdge + L.dateW / 2;
}

// ===========================================================================
// Asq — Square (aspect 1.0)
// ===========================================================================

function applyAsq(L: LayoutParams, bounds: Bounds, _headerH: number, _footerH: number, o: ResolvedOptions): void {
    const W = bounds.right;
    const availV = bounds.bottom;
    const halfPad = 0.0125 * W;
    const gap = 2 * halfPad;
    const cx = W / 2;

    const mapW = o.asqMapK * W;
    const mapH = mapW / 2;

    const dialD = Math.max(2, availV - mapH - 3 * gap);
    const mainR = dialD / 2;

    const mapCY = gap + mapH / 2;                       // header · gap · MAP
    const dialCY = gap + mapH + gap + mainR;            // … gap · DIAL (centre)

    L.earthW = mapW; L.earthH = mapH; L.earthCX = cx; L.earthCY = mapCY;
    rescaleMain(L, cx, dialCY, mainR);

    const subR = L.subR;                                 // = 0.2·mainR after rescaleMain
    const t = o.asqOuterT;
    const vx = bounds.left - cx, vy = bounds.bottom - dialCY;   // centre → footer top-left corner
    const vlen = Math.hypot(vx, vy);
    const dist = mainR + t * (vlen - mainR);
    const azCX = cx + dist * vx / vlen, azCY = dialCY + dist * vy / vlen;
    L.altR = subR; L.azR = subR; L.eotR = subR;
    L.azCX = azCX; L.azCY = azCY;                                 // lower-left (anchor)
    L.eotCX = 2 * cx - azCX; L.eotCY = azCY;                      // lower-right (mirror x)
    L.altCX = azCX; L.altCY = 2 * dialCY - azCY;                  // upper-left (mirror y)
    L.eclipseCX = 2 * cx - azCX; L.eclipseCY = 2 * dialCY - azCY; // upper-right (mirror x+y)

    const mapLeft = cx - mapW / 2, mapRight = cx + mapW / 2;
    L.moonCX = mapLeft / 2; L.moonCY = mapCY;
    // Force a stacked date block centred in the right-of-map region.
    L.dateMode = 'stack'; L.dateForceU = undefined; L.dateCondensed = false;
    L.dateCX = (mapRight + W) / 2; L.dateCY = mapCY;
    L.dateW = Math.max(2, (W - mapRight) - 2 * halfPad); L.dateH = mapH;
}

// ===========================================================================
// A1 — Extreme portrait (aspect 0.10): one column, vertical mirror of A6
// ===========================================================================

function applyA1(
    L: LayoutParams, ctx: CanvasRenderingContext2D, fields: DateFields,
    bounds: Bounds, _headerH: number, _footerH: number, o: ResolvedOptions,
): void {
    const W = bounds.right;
    const H = bounds.bottom;                    // content height (full; chrome dropped)
    const cx = W / 2;
    const halfPad = 0.0125 * W;
    // Fills the column width, less a small edge margin so the rim isn't flattened
    // against the left/right screen edges (min(halfGap/4, 2) px).
    const R = Math.max(2, W / 2 - Math.min(halfPad / 4, 2));
    const outerR = o.a6DialK * R;
    const oc = 2 * outerR;

    const REL_BIG = 1.0, REL_YEAR = 0.42, REL_SMALL = 0.21;
    const LINE_SPACING = 1.18, LINE_PAD = 0.10, UNIT_MAX = 72, REF = 100;
    const wkText = fields.weekday, md = fields.monthDay, yr = fields.year, tzAbbr = fields.tzAbbrev;
    const w100 = (text: string, rel: number) => { ctx.font = `${rel * REF}px Arial, sans-serif`; return ctx.measureText(text).width; };
    const lines: { text: string; rel: number; prom: boolean }[] = [
        { text: wkText, rel: REL_BIG, prom: true },
        { text: md, rel: REL_BIG, prom: true },
        { text: yr, rel: REL_YEAR, prom: true },
    ];
    if (tzAbbr) lines.push({ text: tzAbbr, rel: REL_SMALL, prom: false });

    const dateBoxW = W - 2 * halfPad;
    let maxW = 0;
    for (const l of lines) { const lw = w100(l.text, l.rel); if (lw > maxW) maxW = lw; }
    const uDate = Math.min(UNIT_MAX, REF * dateBoxW / maxW);

    let blockH = (lines.length - 1) * LINE_PAD * uDate;
    for (const l of lines) blockH += l.rel * LINE_SPACING * uDate;
    let yb = -blockH / 2;
    const base: number[] = [];
    for (const l of lines) {
        const lineH = l.rel * uDate;
        yb += lineH * (LINE_SPACING + 1) / 2; base.push(yb);
        yb += lineH * (LINE_SPACING - 1) / 2 + LINE_PAD * uDate;
    }
    const asc: number[] = [], desc: number[] = [];
    for (const l of lines) {
        ctx.font = `${l.rel * uDate}px Arial, sans-serif`;
        const m = ctx.measureText(l.text); asc.push(m.actualBoundingBoxAscent); desc.push(m.actualBoundingBoxDescent);
    }
    let tp = Infinity, bp = -Infinity;               // prominent ink only (tz excluded)
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].prom) continue;
        tp = Math.min(tp, base[i] - asc[i]); bp = Math.max(bp, base[i] + desc[i]);
    }
    const shift = -(tp + bp) / 2;
    const last = lines.length - 1;
    const dateTopOffset = -(base[0] + shift - asc[0]);
    const dateBotOffset = base[last] + shift + desc[last];
    const dateH = dateTopOffset + dateBotOffset;

    const mapH = W / 2;
    const heights = [oc, oc, oc, 2 * R, oc, oc, dateH, mapH];  // moon alt az DIAL ecl eot date map
    const sumEl = heights.reduce((a, b) => a + b, 0);
    const N = heights.length, inner = N - 1;

    const need = sumEl + (inner + 2) * halfPad;
    let outerMargin: number, innerGap: number;
    if (H >= need) {
        outerMargin = halfPad; innerGap = halfPad + (H - need) / inner;
    } else {
        const deficit = need - H;
        if (deficit <= 2 * halfPad) { outerMargin = halfPad - deficit / 2; innerGap = halfPad; }
        else { outerMargin = 0; innerGap = halfPad - (deficit - 2 * halfPad) / inner; }
    }

    let y = outerMargin;
    const cyc: number[] = [];
    for (let i = 0; i < N; i++) {
        if (i > 0) y += innerGap;
        cyc.push(i === 6 ? y + dateTopOffset : y + heights[i] / 2);
        y += heights[i];
    }

    L.moonR = outerR; L.moonCX = cx; L.moonCY = cyc[0];
    L.altR = outerR; L.altCX = cx; L.altCY = cyc[1];   // ECL also draws at altR
    L.azR = outerR; L.azCX = cx; L.azCY = cyc[2];
    rescaleMain(L, cx, cyc[3], R);
    L.eclipseCX = cx; L.eclipseCY = cyc[4];
    L.eotR = outerR; L.eotCX = cx; L.eotCY = cyc[5];
    L.dateCX = cx; L.dateCY = cyc[6]; L.dateW = dateBoxW; L.dateH = dateH;
    L.earthW = W; L.earthH = mapH; L.earthCX = cx; L.earthCY = cyc[7];

    L.dateMode = 'stack'; L.dateCondensed = false; L.dateForceU = uDate;
}

// ===========================================================================
// A6 — Extreme landscape (aspect 10): one row of every element
// ===========================================================================

function applyA6(
    L: LayoutParams, ctx: CanvasRenderingContext2D, fields: DateFields,
    bounds: Bounds, _headerH: number, _footerH: number, o: ResolvedOptions,
): void {
    const W = bounds.right;
    const hr = bounds.bottom;                 // row height = content height
    const cy = hr / 2;
    const halfPad = 0.0125 * W;
    // Fills the row height, less a small edge margin so the rim isn't flattened
    // against the top/bottom screen edges (min(halfGap/4, 2) px).
    const R = Math.max(2, hr / 2 - Math.min(halfPad / 4, 2));
    const outerR = o.a6DialK * R;
    const u = o.a6FontK * (2 * outerR);         // primary font = ratio · outer-dial ⌀

    const wkText = fields.weekday, md = fields.monthDay, yr = fields.year, tzAbbr = fields.tzAbbrev;
    const { weekdayW, dateW } = measureRowTexts(ctx, wkText, md, yr, tzAbbr, '', u);
    const dialW = 2 * R, mapW = 2 * hr;

    const sumEl = 2 * outerR + weekdayW + 2 * outerR + 2 * outerR + dialW + 2 * outerR + 2 * outerR + dateW + mapW;
    const N = 9, inner = N - 1;

    const need = sumEl + (inner + 2) * halfPad;
    let outerGap: number, innerGap: number;
    if (W >= need) {
        outerGap = halfPad; innerGap = halfPad + (W - need) / inner;
    } else {
        const deficit = need - W;
        if (deficit <= 2 * halfPad) { outerGap = halfPad - deficit / 2; innerGap = halfPad; }
        else { outerGap = 0; innerGap = halfPad - (deficit - 2 * halfPad) / inner; }
    }

    let cx = outerGap;
    const place = (w: number) => { const c = cx + w / 2; cx += w + innerGap; return c; };

    L.moonR = outerR; L.moonCX = place(2 * outerR); L.moonCY = cy;
    L.dateCX = place(weekdayW); L.dateCY = cy; L.dateW = weekdayW + 4; L.dateH = hr;
    L.altR = outerR; L.altCX = place(2 * outerR); L.altCY = cy;
    L.azR = outerR; L.azCX = place(2 * outerR); L.azCY = cy;
    rescaleMain(L, place(dialW), cy, R);
    L.eclipseCX = place(2 * outerR); L.eclipseCY = cy;   // ECL draws at L.altR = outerR
    L.eotR = outerR; L.eotCX = place(2 * outerR); L.eotCY = cy;
    L.date2CX = place(dateW); L.date2CY = cy; L.date2W = dateW + 4; L.date2H = hr;
    L.earthW = mapW; L.earthH = hr; L.earthCX = place(mapW); L.earthCY = cy;

    L.dateMode = 'split'; L.dateCondensed = true; L.dateBaselineBottom = undefined; L.dateForceU = u;
}

// ===========================================================================
// Dispatch + orchestration
// ===========================================================================

/** Run the per-anchor adjustments on a base layout (content space). */
export function applyAnchor(
    L: LayoutParams, anchorId: AnchorId,
    ctx: CanvasRenderingContext2D, fields: DateFields,
    bounds: Bounds, headerH: number, footerH: number,
    options: AnchorOptions = {},
): void {
    const o = resolveOptions(options);
    switch (anchorId) {
        case 'A1': applyA1(L, ctx, fields, bounds, headerH, footerH, o); break;
        case 'A2': applyA2(L, bounds, o); break;
        case 'A3': applyA3Common(L, bounds, o); break;
        case 'A3m': applyA3Mini(L, bounds, o); break;
        case 'Asq': applyAsq(L, bounds, headerH, footerH, o); break;
        case 'A4': if (o.a4Sym) applyA4Dials(L); break;
        case 'A5': applyA5(L, ctx, fields, bounds, headerH, footerH, o); break;
        case 'Awide': applyAwide(L, ctx, fields, bounds, headerH, footerH, o); break;
        case 'A6': applyA6(L, ctx, fields, bounds, headerH, footerH, o); break;
    }

    // CC1: the eclipse reads as one of the four equal-size outer dials. The
    // anchors resize the outer dials via `altR` (= az/eot) but the eclipse is
    // rendered from its annulus radii, so re-derive those from the final
    // outer-dial radius — `eclipseR2` (the visible outer ring) = `altR`, with the
    // disc `eclipseR1` keeping the authored 49/63 proportion. (The harness draws
    // ECL directly at `altR`, so this keeps the real renderer in step with it.)
    L.eclipseR2 = L.altR;
    L.eclipseR1 = L.altR * (ECLIPSE_R1_RATIO);

    // Outer-dial label/number fonts (the alt/az tick labels, the EOT digits, and
    // the alt/az planet-name labels) also scale with the *final* dial radius. The
    // base `extDerived` values were computed from the un-grown radius, so they
    // didn't track an anchor that resizes the dials (e.g. A2's ×1.36 growth).
    // Same iOS proportions (10/60 for labels, 8/60 for the EOT numbers) — no
    // floor, no special case — now keyed off altR like the titles.
    const es = L.altR / 60;
    L.extFontSize = 10 * es;
    L.eclipseFontSize = 10 * es;
    L.eotFontSize = 8 * es;
}

/** Disc-to-ring proportion of the eclipse annulus (from `extDerived`: 49/63). */
const ECLIPSE_R1_RATIO = 49 / 63;

/**
 * Build the base layout for an anchor. A2 pins the two-band phone arrangement
 * and A3/A3m pin the one-band iPad arrangement (bypassing the width-triggered
 * row↔stack flip); every other anchor uses the default template-by-aspect body.
 * `W` is the content width (= safe width); `H` is the safe height minus the
 * header band; `footerH` is reserved at the bottom of the content rect.
 */
export function buildBaseLayout(anchorId: AnchorId, W: number, H: number, footerH: number): LayoutParams {
    if (anchorId === 'A2') return portraitTwoBand(W, H - footerH);
    if (anchorId === 'A3' || anchorId === 'A3m') return portraitOneBand(W, H - footerH);
    return computeBaseLayout(W, H, { footerH });
}

/** Every position field, so `shiftLayout` can offset content space → safe rect. */
const SHIFT_X: (keyof LayoutParams)[] = ['mainCX', 'utcCX', 'solarCX', 'sidCX', 'moonCX', 'earthCX', 'altCX', 'azCX', 'eclipseCX', 'eotCX', 'dateCX', 'date2CX'];
const SHIFT_Y: (keyof LayoutParams)[] = ['mainCY', 'utcCY', 'solarCY', 'sidCY', 'moonCY', 'earthCY', 'altCY', 'azCY', 'eclipseCY', 'eotCY', 'dateCY', 'date2CY'];

function shiftLayout(L: LayoutParams, dx: number, dy: number): void {
    if (dx) for (const k of SHIFT_X) (L[k] as number) += dx;
    if (dy) {
        for (const k of SHIFT_Y) (L[k] as number) += dy;
        if (L.dateBaselineBottom != null) L.dateBaselineBottom += dy;
    }
}

/** Chrome + safe-area insets for the iteration-3 layout. */
export interface ObsChrome {
    /** Reserved footer-row height (measured; grows when the row wraps to two
     *  lines on narrow phones; 0 when chrome is dropped). */
    footerH: number;
    /** Reserved header-row height (Observatory · ℹ · share). */
    headerH: number;
    /** Safe-area insets (device notch / home indicator), 0 on desktop windows. */
    insetTop?: number;
    insetRight?: number;
    insetBottom?: number;
    insetLeft?: number;
}

/**
 * Production layout entry. Picks one of the nine anchors from the safe-rect
 * aspect, builds + adjusts it, and returns absolute canvas coordinates. The
 * date `fields` are measured against `ctx` so the extreme/landscape anchors size
 * the date region from exactly the text the renderer draws (§9.3).
 */
export function computeLayout(
    viewW: number,
    viewH: number,
    chrome: ObsChrome,
    ctx: CanvasRenderingContext2D,
    date: Date,
    timezone: string | undefined,
): LayoutParams {
    const dpr = typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1;

    const insetTop = chrome.insetTop ?? 0;
    const insetRight = chrome.insetRight ?? 0;
    const insetBottom = chrome.insetBottom ?? 0;
    const insetLeft = chrome.insetLeft ?? 0;

    // 1. Safe rect = physical viewport − safe-area insets (§1).
    const safeW = Math.max(1, viewW - insetLeft - insetRight);
    const safeH = Math.max(1, viewH - insetTop - insetBottom);

    // 2. CC2 chrome-drop: drop both bands if the controller popover can't fit.
    const dropChrome = safeW < TC_POPOVER_W || safeH < TC_POPOVER_H;
    let headerH = chrome.headerH;
    let footerH = chrome.footerH;
    if (dropChrome) { headerH = 0; footerH = 0; }

    // 3. Pick the anchor (hard snap at the §7 thresholds).
    const anchorId = pickAnchor(safeW / safeH);

    // 4. Base template + per-anchor adjustment (content space, top = 0).
    const contentW = safeW;
    const baseH = safeH - headerH;
    const L = buildBaseLayout(anchorId, contentW, baseH, footerH);
    const bounds: Bounds = { left: 0, right: contentW, top: 0, bottom: baseH - footerH };
    const fields = extractDateFields(date, timezone);
    applyAnchor(L, anchorId, ctx, fields, bounds, headerH, footerH);

    // 5. Offset content space → the safe rect, below the header band.
    shiftLayout(L, insetLeft, insetTop + headerH);

    L.viewW = viewW;
    L.viewH = viewH;
    L.dpr = dpr;
    L.anchor = anchorId;
    L.chromeDropped = dropChrome;
    return L;
}

export type { ChromeParams };
