/**
 * Observatory date display.
 *
 * Port of the EOClock date labels (EOClock.mm:525-570, L1941-1947) with the
 * iOS font hierarchy: the full weekday name and the month/day are the big
 * elements (iOS 48 pt), the year is 0.42× (20 pt), and the leap indicator /
 * timezone abbreviation are 0.21× (10 pt). The weekday is prominent by design:
 * a stated UX goal is knowing the weekday at a glance.
 *
 * The layout hands us a target box (dateCX/CY/W/H, mode) and we scale the text
 * block uniformly to fill it. Three modes (plan §5.5):
 *   - 'stack' — weekday / month-day / year(+leap) / tz, one centered column
 *   - 'row'   — weekday over a single condensed info line (phone portrait)
 *   - 'split' — weekday alone in box 1, month-day + year(+leap+tz) in box 2
 *                (iOS landscape precedent: weekday bottom-left, date bottom-right)
 *
 * "leap" is shown only in leap years; non-leap years show nothing (per review,
 * "not leap" is dropped).
 *
 * All fields use Intl.DateTimeFormat in the location's timezone so the display
 * follows the selected location and scrubbed time, not the browser's locale tz.
 */

import type { LayoutParams } from './layout.js';

const COLOR = 'rgba(255,255,255,0.9)';
const COLOR_DIM = 'rgba(255,255,255,0.55)';

// Relative sizes from iOS (48 / 48 / 20 / 10).
const REL_BIG = 1.0;
const REL_YEAR = 0.42;
const REL_SMALL = 0.21;

/** Absolute cap on the unit size so huge windows don't produce absurd text. */
const UNIT_MAX = 72;

/** Gregorian leap-year test (port of EOClock.mm:541-547). */
function isLeapYear(year: number): boolean {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

interface DateFields {
    weekday: string;
    monthDay: string;
    year: string;
    leap: boolean;
    tzAbbrev: string;
}

function extractFields(date: Date, timezone: string | undefined): DateFields {
    const tz = timezone || undefined;
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'long',
        month: 'short',          // iOS bigDate uses "MMM dd"
        day: 'numeric',
        year: 'numeric',
    }).formatToParts(date);

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const weekday = get('weekday');
    const month = get('month');
    const day = get('day');
    const year = get('year');

    let tzAbbrev = '';
    try {
        const tzParts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            timeZoneName: 'short',
        }).formatToParts(date);
        tzAbbrev = tzParts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    } catch {
        tzAbbrev = '';
    }

    return {
        weekday,
        monthDay: `${month} ${day}`,
        year,
        leap: isLeapYear(parseInt(year, 10)),
        tzAbbrev,
    };
}

// ---------------------------------------------------------------------------
// Text-block engine: lines of mixed-size segments, scaled to fit a box.
// ---------------------------------------------------------------------------

interface Segment {
    text: string;
    rel: number;
    color: string;
}
type Line = Segment[];

// Gap between segments, in units of the LARGER neighbor's size — small
// segments (tz/leap) beside big ones (year) need real air, not 0.25 of their
// own tiny em.
const SEG_GAP_EM = 0.35;
const LINE_SPACING = 1.18;   // line height in units of the line's tallest rel
const LINE_PAD = 0.10;       // extra padding between lines, in block units

// Ink-tight inter-line gap (in block units) used by the landscape split date
// block. Placed between one line's ink bottom and the next line's ink top, so
// it scales with the font. Tuned to the iOS landscape spacing, where the year
// centre sits ~0.72× the big font above the month/day centre (EOClock.mm
// landscape `bdY3 = bdY + 34.5`, big font 48). See `drawBlock({ tight })`.
const TIGHT_LINE_GAP = 0.2;

function fontFor(px: number): string {
    return `${px}px Arial, sans-serif`;
}

/** Gap before segment i (relative to the larger neighbor's size). */
function segGap(line: Line, i: number, u: number): number {
    if (i === 0) return 0;
    return SEG_GAP_EM * Math.max(line[i - 1].rel, line[i].rel) * u;
}

/**
 * Real glyph-ink ascent/descent of a line at unit size `u`, from the canvas's
 * `actualBoundingBox*` metrics (not the nominal em-box). Used to center the
 * block on visible ink — e.g. an all-caps weekday with no descenders should not
 * sit low in its box just because the em-box reserves descender space.
 * (Observatory layout iteration 3, §6.0 cross-cutting renderer rule.)
 */
function lineInk(
    ctx: CanvasRenderingContext2D, line: Line, u: number, prominentOnly = false,
): { asc: number; desc: number; has: boolean } {
    let asc = 0;
    let desc = 0;
    let has = false;
    for (const seg of line) {
        if (!seg.text) continue;
        // For vertical centering, skip the faint *and* small secondary fields
        // (timezone, "leap"): they don't read as part of the date's visual mass,
        // so counting them makes the prominent content look shifted up.
        if (prominentOnly && seg.color === COLOR_DIM && seg.rel <= REL_SMALL) continue;
        ctx.font = fontFor(seg.rel * u);
        const m = ctx.measureText(seg.text);
        if (m.actualBoundingBoxAscent > asc) asc = m.actualBoundingBoxAscent;
        if (m.actualBoundingBoxDescent > desc) desc = m.actualBoundingBoxDescent;
        has = true;
    }
    return { asc, desc, has };
}

/** Measure a line's width and height at unit size u. */
function measureLine(ctx: CanvasRenderingContext2D, line: Line, u: number): { w: number; h: number } {
    let w = 0;
    let maxRel = 0;
    let drawn = 0;
    for (let i = 0; i < line.length; i++) {
        const seg = line[i];
        if (!seg.text) continue;
        ctx.font = fontFor(seg.rel * u);
        w += ctx.measureText(seg.text).width;
        if (drawn > 0) w += segGap(line, i, u);
        drawn++;
        if (seg.rel > maxRel) maxRel = seg.rel;
    }
    return { w, h: maxRel * u };
}

/** The largest unit size (≤ UNIT_MAX) at which `live` lines fit the box. */
function fitUnit(ctx: CanvasRenderingContext2D, live: Line[], boxW: number, boxH: number): number {
    const REF = 100;
    let maxW = 0;
    let totH = (live.length - 1) * LINE_PAD * REF;
    for (const l of live) {
        const d = measureLine(ctx, l, REF);
        if (d.w > maxW) maxW = d.w;
        totH += d.h * LINE_SPACING;
    }
    return Math.min(UNIT_MAX, REF * Math.min(boxW / maxW, boxH / totH));
}

/** All weekday long-names, for a descender depth that doesn't depend on the day. */
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Geometry of the A5 condensed date's weekday, shared by the renderer and the
 * layout harness so dial placement and rendering agree. The weekday is sized to
 * fit its box (`boxW`×`boxH`); its baseline is then placed so the *deepest*
 * weekday descender (max over Sun–Sat, so it doesn't jump when the day changes)
 * lands `descenderBottomY`. Returns the unit, that baseline, and the ink top.
 */
export function condensedDateLayout(
    ctx: CanvasRenderingContext2D, weekdayText: string,
    boxW: number, boxH: number, descenderBottomY: number,
): { u: number; baselineY: number; top: number } {
    const u = fitUnit(ctx, [[{ text: weekdayText, rel: REL_BIG, color: COLOR }]], boxW, boxH);
    ctx.font = fontFor(REL_BIG * u);
    let desc = 0;
    for (const n of WEEKDAY_NAMES) {
        const d = ctx.measureText(n).actualBoundingBoxDescent;
        if (d > desc) desc = d;
    }
    const asc = ctx.measureText(weekdayText).actualBoundingBoxAscent;
    const baselineY = descenderBottomY - desc;
    return { u, baselineY, top: baselineY - asc };
}

/**
 * Draw a block of lines centered in the box, choosing the largest unit size
 * that fits (≤ UNIT_MAX). Segments within a line share a baseline.
 *
 * Returns the chosen unit size and the bottom line's baseline (content coords),
 * so a caller can render a second block at the *same* scale and baseline (e.g.
 * the A5 split date matches "Jun 18 …" to the weekday's size and baseline).
 * `opts.forceU` overrides the fitted unit; `opts.baselineY` pins the bottom
 * line's baseline (bypassing the ink re-centering).
 */
function drawBlock(
    ctx: CanvasRenderingContext2D,
    lines: Line[],
    cx: number, cy: number, boxW: number, boxH: number,
    opts: { tight?: boolean; segCenter?: boolean; forceU?: number; baselineY?: number } = {},
): { u: number; baselineY: number } {
    const live = lines.filter((l) => l.some((s) => s.text));
    if (live.length === 0 || boxW <= 0 || boxH <= 0) return { u: 0, baselineY: cy };

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // Fit: measure at a reference unit, scale.
    const REF = 100;
    let maxW = 0;
    let totH = (live.length - 1) * LINE_PAD * REF;
    const refDims = live.map((l) => {
        const d = measureLine(ctx, l, REF);
        if (d.w > maxW) maxW = d.w;
        totH += d.h * LINE_SPACING;
        return d;
    });
    const u = opts.forceU != null
        ? opts.forceU
        : Math.min(UNIT_MAX, REF * Math.min(boxW / maxW, boxH / totH));

    // Lay the baselines out, collecting them first so we can re-center on real
    // ink below. Two spacing models:
    const baselines: number[] = [];
    if (opts.tight) {
        // Ink-tight: place each line just below the previous on real ink
        // (actualBoundingBox) plus a proportional pad. The em-box advance below
        // reserves the *big* line's full ascent above its baseline, which shoves
        // a small line sitting above it far away — visible in the landscape
        // split block as "2026 PDT" floating high over "Jun 18". This matches
        // the tight iOS spacing and scales with the font (∝ u). The absolute
        // origin doesn't matter; the re-center pass below pins it to `cy`.
        let cursor = 0;
        for (let li = 0; li < live.length; li++) {
            const m = lineInk(ctx, live[li], u);
            cursor += m.asc;
            baselines.push(cursor);
            cursor += m.desc;
            if (li < live.length - 1) cursor += TIGHT_LINE_GAP * u;
        }
    } else {
        // Em-box advance (gives consistent line spacing for the multi-line
        // stack/row modes).
        const blockH = (totH / REF) * u;
        let y = cy - blockH / 2;
        for (let li = 0; li < live.length; li++) {
            const lineH = (refDims[li].h / REF) * u;
            y += lineH * (LINE_SPACING + 1) / 2;   // advance to this line's baseline
            baselines.push(y);
            y += lineH * (LINE_SPACING - 1) / 2 + LINE_PAD * u;
        }
    }

    if (opts.baselineY != null) {
        // Pin the bottom line's baseline to a caller-supplied y (e.g. align the
        // A5 date with the weekday's baseline). Skip the ink re-centering.
        const shift = opts.baselineY - baselines[baselines.length - 1];
        for (let li = 0; li < baselines.length; li++) baselines[li] += shift;
    } else {
        // Re-center on the real glyph ink rather than the em-box: shift every
        // baseline so the visible ink's midpoint lands on `cy`. This makes the
        // layout's date box a faithful proxy for the rendered ink in every mode
        // (§6.0). Spacing is still expressed in em-box units above (stable).
        let inkTop = Infinity;
        let inkBot = -Infinity;
        for (let li = 0; li < live.length; li++) {
            const m = lineInk(ctx, live[li], u, /* prominentOnly */ true);
            if (!m.has) continue;   // a faint-only line (lone tz) doesn't anchor the center
            inkTop = Math.min(inkTop, baselines[li] - m.asc);
            inkBot = Math.max(inkBot, baselines[li] + m.desc);
        }
        if (inkTop <= inkBot) {
            const shift = cy - (inkTop + inkBot) / 2;
            for (let li = 0; li < baselines.length; li++) baselines[li] += shift;
        }
    }

    // Draw.
    for (let li = 0; li < live.length; li++) {
        const line = live[li];
        const lineW = (refDims[li].w / REF) * u;
        const y = baselines[li];
        // For mixed-size segments, `segCenter` vertically centers each segment's
        // ink on the line's midline (instead of sharing the baseline). The
        // midline is the line's overall ink centre at this baseline.
        let midline = 0;
        if (opts.segCenter) {
            const m = lineInk(ctx, line, u);
            midline = y - (m.asc - m.desc) / 2;
        }
        let x = cx - lineW / 2;
        let drawn = 0;
        for (let si = 0; si < line.length; si++) {
            const seg = line[si];
            if (!seg.text) continue;
            const px = seg.rel * u;
            ctx.font = fontFor(px);
            ctx.fillStyle = seg.color;
            if (drawn > 0) x += segGap(line, si, u);
            drawn++;
            let drawY = y;
            if (opts.segCenter) {
                const mm = ctx.measureText(seg.text);
                drawY = midline + (mm.actualBoundingBoxAscent - mm.actualBoundingBoxDescent) / 2;
            }
            ctx.fillText(seg.text, x, drawY);
            x += ctx.measureText(seg.text).width;
        }
    }

    ctx.restore();
    return { u, baselineY: baselines[baselines.length - 1] };
}

// ---------------------------------------------------------------------------
// Public draw
// ---------------------------------------------------------------------------

/**
 * Draw the date display into the layout's date box(es).
 *
 * @param date      The display-time Date (already the scrubbed/current instant).
 * @param timezone  IANA timezone for the location (undefined → browser local).
 */
export function drawDateView(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
    date: Date,
    timezone: string | undefined,
): void {
    const f = extractFields(date, timezone);
    const wk: Segment = { text: f.weekday, rel: REL_BIG, color: COLOR };
    const md: Segment = { text: f.monthDay, rel: REL_BIG, color: COLOR };
    const yr: Segment = { text: f.year, rel: REL_YEAR, color: COLOR };
    const leap: Segment = { text: f.leap ? 'leap' : '', rel: REL_SMALL, color: COLOR_DIM };
    const tz: Segment = { text: f.tzAbbrev, rel: REL_SMALL, color: COLOR_DIM };

    switch (L.dateMode) {
        case 'stack':
            drawBlock(ctx, [[wk], [md], [yr, leap], [tz]],
                L.dateCX, L.dateCY, L.dateW, L.dateH);
            break;
        case 'row': {
            // Condensed info line under the weekday (phone portrait band).
            const small = (text: string): Segment => ({ text, rel: 0.45, color: COLOR });
            const info: Line = [small(f.monthDay), small('·'), small(f.year)];
            if (f.tzAbbrev) info.push(small('·'), { text: f.tzAbbrev, rel: 0.45, color: COLOR_DIM });
            if (f.leap) info.push(small('·'), { text: 'leap', rel: 0.45, color: COLOR_DIM });
            drawBlock(ctx, [[wk], info], L.dateCX, L.dateCY, L.dateW, L.dateH);
            break;
        }
        case 'split': {
            if (L.dateCondensed) {
                // A5 (iPhone landscape): weekday left, and block 2 a single line
                // "month-day year tz" — same per-element font sizes as the
                // stacked A4 (month-day big, year medium, tz/leap faint small),
                // no separators. Both are rendered at the weekday's unit so
                // "month-day" matches "Thursday", and both drop to a shared
                // baseline placed so the deepest weekday descender sits a fixed
                // gap (`dateBaselineBottom`) above the footer — stable across
                // days. Segments share a baseline unless `dateSegCenter`.
                const descBottom = L.dateBaselineBottom ?? L.dateCY;
                const dl = condensedDateLayout(ctx, f.weekday, L.dateW, L.dateH, descBottom);
                drawBlock(ctx, [[wk]], L.dateCX, L.dateCY, L.dateW, L.dateH,
                    { forceU: dl.u, baselineY: dl.baselineY });
                const info: Line = [md, yr];
                if (f.tzAbbrev) info.push(tz);
                if (f.leap) info.push(leap);
                drawBlock(ctx, [info], L.date2CX, L.date2CY, L.date2W, L.date2H,
                    { forceU: dl.u, baselineY: dl.baselineY, segCenter: L.dateSegCenter });
            } else {
                drawBlock(ctx, [[wk]], L.dateCX, L.dateCY, L.dateW, L.dateH);
                // Year + tz on top, month-day on the bottom line so the prominent
                // month-day sits at the same height as the weekday on the left
                // (iteration 3: landscape bottom date). Element rendering is
                // unchanged — only the two lines' vertical order is swapped.
                // `tight` pulls the year/tz line close to the month-day (iOS).
                drawBlock(ctx, [[yr, tz, leap], [md]],
                    L.date2CX, L.date2CY, L.date2W, L.date2H, { tight: true });
            }
            break;
        }
    }
}
