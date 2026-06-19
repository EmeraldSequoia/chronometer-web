/**
 * Observatory responsive layout engine (Phase 8 + 8B).
 *
 * Strategy (see planning/2026-06-06-observatory-phase-8-layout.md and
 * planning/2026-06-10-observatory-phase-8b-layout-refinement.md):
 *
 *   1. Pick a template by window aspect ratio, mirroring the iOS app's
 *      portrait/landscape flip (with a small hysteresis dead-band).
 *   2. Size the central dial *adaptively*: grow it toward 0.95 × the shorter
 *      window dimension whenever the longer dimension has slack to hold the
 *      other elements; fall back toward a 0.75 floor only near square.
 *      The dial may grow without bound with the window.
 *   3. Priority cascade: dial → map → moon → ext dials → date. The moon is
 *      never smaller than an ext dial (the dials yield to the moon). The date
 *      gets a real box and its text scales to fill it.
 *   4. The layout accounts for the bottom chrome row (time-controller button +
 *      location row, one fixed-height strip) and, when open, the L-shaped time
 *      controller popover: its vertical arm narrows the effective window width
 *      and its bottom arm sets a bottom limit for right-side elements, so the
 *      whole display stays visible while scrubbing.
 *
 * Everything *inside* the main dial (rings, planets, the three inner subdials,
 * fonts) still scales as a fixed multiple of `mainR` via `s = mainR / 365`,
 * exactly as the iOS reference draws it. Only the outer composition is new.
 *
 * The logo is intentionally dropped (the company is gone; no IP to protect).
 */

// iOS reference: the whole main dial was authored at mainR = 365.
const REF_MAIN_R = 365;

// --- Adaptive sizing knobs (tunable; see plan §5/§8) -----------------------
/** Max dial diameter as a fraction of the shorter window dimension. */
const DIAL_FRAC_MAX = 0.95;
/** Min dial diameter as a fraction of the shorter window dimension (floor). */
const DIAL_FRAC_MIN = 0.75;
/** Peripheral-dial radius cap, as a fraction of the main-dial radius. */
const EXT_R_CAP_FRAC = 0.45;
/** Map width target as a fraction of the dial diameter (iOS invariant, both orientations). */
const MAP_FRAC_OF_D = 0.41;
/** Moon radius target as a multiple of extR (iOS: 1.25 portrait, 1.5 landscape). */
const MOON_EXT_PORTRAIT = 1.25;
const MOON_EXT_LANDSCAPE = 1.5;

/** Gap rule (plan §5.1): grows with the ext dials, never below 6px. */
function gapFor(extR: number): number {
    return clamp(0.4 * extR, 6, 24);
}

// --- Template selection with hysteresis -----------------------------------
type Template = 'portrait' | 'landscape';
/** Aspect (W/H) at/above which we switch *into* landscape. */
const CROSS_UP = 1.15;
/** Aspect (W/H) at/below which we switch *back into* portrait. */
const CROSS_DOWN = 1.05;
/** Remembered template so the dead-band can apply (module-level state). */
let lastTemplate: Template = 'portrait';

function chooseTemplate(w: number, h: number): Template {
    const a = w / h;
    if (a >= CROSS_UP) lastTemplate = 'landscape';
    else if (a <= CROSS_DOWN) lastTemplate = 'portrait';
    // else: inside the dead-band — keep whatever we had.
    return lastTemplate;
}

// ---------------------------------------------------------------------------
// Chrome (DOM overlay) insets — plan §4
// ---------------------------------------------------------------------------

/** Time-controller popover arm sizes (the popover is an L: tp-upper + tp-lower). */
export interface PopoverArms {
    upperW: number;
    upperH: number;
    lowerW: number;
    lowerH: number;
}

export interface ChromeParams {
    /** Height of the bottom chrome row (time-controller button + location). */
    footerH: number;
    /** Popover arm rects when the time controller is open, else null. */
    popover: PopoverArms | null;
}

/** Bottom band occupied by the popover's lower arm (right-anchored). */
interface LowerBand {
    /** Left edge (x) of the band. */
    left: number;
    /** Top edge (y) of the band, in footer-excluded coordinates. */
    top: number;
}

// ---------------------------------------------------------------------------
// Layout result — consumed by all renderers
// ---------------------------------------------------------------------------

export type DateMode = 'stack' | 'row' | 'split';

export interface LayoutParams {
    viewW: number;
    viewH: number;
    dpr: number;

    // --- Main orrery dial ---
    mainCX: number;
    mainCY: number;
    mainR: number;
    subR: number;
    zR: number;
    zD: number;
    sunD: number;
    tickHeight: number;
    secLen: number;

    // Planet orbit ring
    plR: number;
    plR2: number;
    orbitInc: number;
    sunRingWidth: number;

    // Main hand lengths
    h24Len: number;
    h12Len: number;
    minLen: number;
    sunRiseSetLen: number;

    // Hand drawing dimensions
    h24Arrow: number;
    h24Wid: number;
    sunRiseSetArrow: number;
    len2: number;
    breH12Width: number;
    breH12CenterR: number;
    breMinWidth: number;
    breMinCenterR: number;
    secWidth: number;
    secBallR: number;

    // Font sizes (proportional to mainR)
    mainFontSize: number;
    subdialFontSize: number;
    zodiacFontSize: number;
    smallZodiacFontSize: number;

    // --- Inner subdials ---
    subOffset: number;
    utcCX: number;
    utcCY: number;
    solarCX: number;
    solarCY: number;
    sidCX: number;
    sidCY: number;

    // --- Header region ---
    moonCX: number;
    moonCY: number;
    moonR: number;

    earthCX: number;
    earthCY: number;
    earthW: number;
    earthH: number;

    // --- Peripheral dials ---
    altCX: number;
    altCY: number;
    altR: number;

    azCX: number;
    azCY: number;
    azR: number;

    eclipseCX: number;
    eclipseCY: number;
    eclipseR1: number;
    eclipseR2: number;

    eotCX: number;
    eotCY: number;
    eotR: number;

    // --- Date display (box centers; date-view scales text to fit) ---
    dateMode: DateMode;
    /** Block 1: the whole stack/row, or the weekday when split. */
    dateCX: number;
    dateCY: number;
    dateW: number;
    dateH: number;
    /** Block 2 (split mode only): month/day + year. Zero otherwise. */
    date2CX: number;
    date2CY: number;
    date2W: number;
    date2H: number;
    /**
     * Split mode: render block 2 as a single condensed "month-day · year · tz"
     * line (A2 `row` info-line style) instead of the stacked year-over-month-day.
     * Used by the most extreme landscape (A5, iPhone) where the bottom strip is
     * short; the wider iPad landscape (A4) leaves this unset and stacks. Optional;
     * production sets it per-anchor (iteration 3), computeLayout leaves it unset.
     */
    dateCondensed?: boolean;
    /**
     * With `dateCondensed`, vertically centre the differently-sized segments on
     * a common midline instead of sharing a baseline. Optional (default
     * baseline-aligned).
     */
    dateSegCenter?: boolean;
    /**
     * With `dateCondensed`, the content-space y at which the weekday's deepest
     * descender (max over Sun–Sat) should land — the weekday and the condensed
     * date2 line drop to a shared baseline derived from it. Set per-anchor (A5);
     * unset → the date sits in its box as usual.
     */
    dateBaselineBottom?: number;

    // --- Peripheral font sizes ---
    extFontSize: number;
    eclipseFontSize: number;
    eotFontSize: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Largest axis-aligned rectangle of the given aspect (w/h) anchored into a
 * window corner (inset by `g`), that stays `g` clear of the main circle.
 *
 * `signX/signY`: signs of (x, y) pointing away from center, i.e. TR = (+1, -1).
 */
function largestCornerRect(
    signX: number, signY: number,
    cx: number, cy: number, mainR: number,
    W: number, H: number, g: number, aspect: number,
): { w: number; h: number; cx: number; cy: number } {
    const maxW = W - 2 * g;
    const maxH = H - 2 * g;
    // Binary search the largest feasible width.
    let lo = 0, hi = Math.min(maxW, maxH * aspect);
    const feasible = (w: number): boolean => {
        const h = w / aspect;
        if (h > maxH) return false;
        // Rectangle anchored to the corner: the outer corner sits at the window
        // corner (inset g); the rectangle extends inward.
        const outerX = signX > 0 ? W - g : g;
        const outerY = signY > 0 ? H - g : g;
        const innerX = outerX - signX * w;
        const innerY = outerY - signY * h;
        // The inner corner (nearest the center) is the binding point.
        const dx = innerX - cx;
        const dy = innerY - cy;
        return Math.hypot(dx, dy) >= mainR + g;
    };
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (feasible(mid)) lo = mid; else hi = mid;
    }
    const w = lo;
    const h = w / aspect;
    const outerX = signX > 0 ? W - g : g;
    const outerY = signY > 0 ? H - g : g;
    return { w, h, cx: outerX - signX * w / 2, cy: outerY - signY * h / 2 };
}

// ---------------------------------------------------------------------------
// Internal main-dial geometry (all proportional to mainR via s) — unchanged
// from the original layout; these draw the rings/planets/subdials.
// ---------------------------------------------------------------------------

interface InnerDial {
    s: number;
    mainFontSize: number; tickHeight: number; zodiacFontSize: number;
    smallZodiacFontSize: number; subdialFontSize: number;
    plR: number; sunRingWidth: number; orbitInc: number; subR: number;
    subOffset: number; sunD: number; zD: number; zR: number; plR2: number;
    secLen: number; minLen: number; h12Len: number; h24Len: number;
    sunRiseSetLen: number; h24Arrow: number; h24Wid: number;
    sunRiseSetArrow: number; len2: number;
    breH12Width: number; breH12CenterR: number; breMinWidth: number;
    breMinCenterR: number; secWidth: number; secBallR: number;
}

function innerDialGeometry(mainR: number): InnerDial {
    const s = mainR / REF_MAIN_R;

    const mainFontSize = 32 * s;
    const tickHeight = mainFontSize / 2.5;
    const zodiacFontSize = 36 * s;
    const smallZodiacFontSize = 11 * s;
    const subdialFontSize = 10 * s;

    const plR = Math.max(100, 332 * s);
    const sunRingWidth = Math.max(16, 64 * s);
    const orbitInc = Math.max(10, 40 * s);
    const subR = Math.max(20, 73 * s);
    const subOffset = Math.max(40, 149 * s);
    const sunD = Math.max(24, 100 * s);
    const zD = Math.max(100, 526 * s);
    const zR = Math.max(80, 272 * s);
    const plR2 = Math.max(60, 254 * s);

    const secLen = (zR - zodiacFontSize / 2) * 1.05;
    const minLen = zR - zodiacFontSize / 2;
    const h12Len = minLen * 0.75;
    const h24Len = mainR - tickHeight * 0.37;
    const sunRiseSetLen = h24Len;

    const h24Arrow = 25 * s;
    const h24Wid = h24Arrow / 1.8 / Math.sqrt(3);
    const sunRiseSetArrow = 18 * s;
    const len2 = zR - 5 * s;

    const breH12Width = 30 * s;
    const breH12CenterR = 12 * s;
    const breMinWidth = 25 * s;
    const breMinCenterR = 8 * s;
    const secWidth = 2 * s;
    const secBallR = 6 * s;

    return {
        s, mainFontSize, tickHeight, zodiacFontSize, smallZodiacFontSize,
        subdialFontSize, plR, sunRingWidth, orbitInc, subR, subOffset, sunD,
        zD, zR, plR2, secLen, minLen, h12Len, h24Len, sunRiseSetLen, h24Arrow,
        h24Wid, sunRiseSetArrow, len2, breH12Width, breH12CenterR, breMinWidth,
        breMinCenterR, secWidth, secBallR,
    };
}

/** Inner-subdial centers (UTC top, Solar lower-left, Sidereal lower-right). */
function innerSubdials(mainCX: number, mainCY: number, subOffset: number) {
    const cos30 = Math.cos(Math.PI / 6);
    const sin30 = Math.sin(Math.PI / 6);
    return {
        utcCX: mainCX, utcCY: mainCY - subOffset,
        solarCX: mainCX - subOffset * cos30, solarCY: mainCY + subOffset * sin30,
        sidCX: mainCX + subOffset * cos30, sidCY: mainCY + subOffset * sin30,
    };
}

/** Eclipse annulus radii + peripheral font sizes, proportional to the ext dial. */
function extDerived(extR: number) {
    const es = extR / 60;            // iOS authored ext dials at R = 60
    return {
        eclipseR2: extR + 3 * es,
        eclipseR1: extR + 3 * es - 14 * es,
        extFontSize: 10 * es,
        eclipseFontSize: 10 * es,
        eotFontSize: 8 * es,
    };
}

// ---------------------------------------------------------------------------
// Compute layout from viewport
// ---------------------------------------------------------------------------

export function computeLayout(
    viewW: number,
    viewH: number,
    chrome?: ChromeParams,
): LayoutParams {
    const dpr = typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1;

    const footerH = chrome?.footerH ?? 0;
    const H = viewH - footerH;

    // Popover open: its vertical arm narrows the effective width; its bottom
    // arm becomes a right-anchored bottom band. If the popover is too large for
    // this window to absorb (tiny windows), fall back to plain overlay.
    let W = viewW;
    let lowerBand: LowerBand | null = null;
    const pop = chrome?.popover ?? null;
    if (pop && pop.upperW < 0.5 * viewW && pop.upperH + pop.lowerH < 0.9 * H) {
        W = viewW - pop.upperW - 8;
        lowerBand = { left: viewW - pop.lowerW - 8, top: H - pop.lowerH - 4 };
    }

    const template = chooseTemplate(W, H);
    const L = template === 'landscape'
        ? computeLandscape(W, H, lowerBand)
        : computePortrait(W, H, lowerBand);

    // Report the real viewport (debug overlay etc.), not the effective one.
    L.viewW = viewW;
    L.viewH = viewH;
    L.dpr = dpr;
    return L;
}

/**
 * Bottom limit for an element spanning [xl, xr]: the popover's lower arm
 * pushes right-side elements up; everything else may use the full height.
 */
function bottomLimitFor(xl: number, xr: number, H: number, band: LowerBand | null, g: number): number {
    if (band && xr > band.left - g) return band.top - g;
    return H;
}

// ---------------------------------------------------------------------------
// Portrait (tall / square): header on top, ext dials in the corner gaps
// ---------------------------------------------------------------------------

function computePortrait(W: number, H: number, lowerBand: LowerBand | null): LayoutParams {
    // Provisional sizes for the band-mode decision (refined per-branch below).
    const D0 = clamp(Math.min(DIAL_FRAC_MAX * W, 0.83 * H), DIAL_FRAC_MIN * W, DIAL_FRAC_MAX * W);
    const extR0 = clamp(0.165 * (D0 / 2), 22, 0.20 * (D0 / 2));
    const g0 = gapFor(extR0);
    const moonMin0 = MOON_EXT_PORTRAIT * extR0;
    const dateWMin = Math.max(0.26 * W, 140);

    // One header band (moon | map | date side by side) needs the width for all
    // three; otherwise fall to the two-band phone arrangement (plan §6.2).
    const oneBand = 2 * moonMin0 + MAP_FRAC_OF_D * D0 + dateWMin + 4 * g0 <= W;

    return oneBand
        ? portraitOneBand(W, H, lowerBand)
        : portraitTwoBand(W, H, lowerBand);
}

/** Shared portrait corner-dial + assembly plumbing. */
interface PortraitCommon {
    W: number; H: number;
    mainCX: number; mainCY: number; mainR: number;
    extR: number; g: number;
    /** Y of the header's bottom edge (corner dials must stay below it). */
    headerBottom: number;
    lowerBand: LowerBand | null;
}

/**
 * Fraction of extR the EOT dial needs below its center: it's a half-dial
 * (arc band + numbers in the upper half, only the title below), so it may
 * "scoot" lower than a full-circle dial when corner space is tight.
 */
const EOT_BOTTOM_FRAC = 0.55;

/**
 * Place the four corner dials. The window clamps can drag a corner dial up
 * the diagonal *into* the main circle (the reported az/eot overlap), so this
 * solves for fit: first the EOT dial may scoot down (half-dial allowance),
 * then extR shrinks until every corner dial clears the rim by ≥ g/2.
 * Returns the (possibly reduced) extR alongside the positions.
 */
function portraitCornerDials(p: PortraitCommon) {
    const { W, H, mainCX, mainCY, mainR, lowerBand, headerBottom } = p;
    const clear = (cx: number, cy: number, extR: number, g: number) =>
        Math.hypot(cx - mainCX, cy - mainCY) >= mainR + extR + g / 2;

    let extR = p.extR;
    for (let iter = 0; ; iter++) {
        const g = gapFor(extR);
        const offX = 0.835 * mainR;
        const offY = 0.954 * mainR;
        const cxL = clamp(mainCX - offX, g + extR, mainCX);
        const cxR = clamp(mainCX + offX, mainCX, W - g - extR);
        const cyHi = clamp(mainCY - offY, headerBottom + g + extR, mainCY);
        const loLimitL = Math.min(bottomLimitFor(cxL - extR, cxL + extR, H, lowerBand, g), H - g);
        const loLimitR = Math.min(bottomLimitFor(cxR - extR, cxR + extR, H, lowerBand, g), H - g);
        const azCY = clamp(mainCY + offY, mainCY, loLimitL - extR);
        // EOT stays aligned with az unless that would overlap the rim — then
        // it scoots down on its half-dial allowance before anything shrinks.
        let eotCY = clamp(mainCY + offY, mainCY, Math.min(loLimitR - extR, azCY));
        if (!clear(cxR, eotCY, extR, g)) {
            eotCY = clamp(mainCY + offY, mainCY, loLimitR - EOT_BOTTOM_FRAC * extR);
        }

        const fits =
            clear(cxL, cyHi, extR, g) && clear(cxR, cyHi, extR, g) &&
            clear(cxL, azCY, extR, g) && clear(cxR, eotCY, extR, g);
        if (fits || iter >= 6) {
            // alt UL, az LL, eclipse UR, eot LR (matching iOS portrait).
            return {
                extR,
                altCX: cxL, altCY: cyHi,
                azCX: cxL, azCY,
                eclipseCX: cxR, eclipseCY: cyHi,
                eotCX: cxR, eotCY,
            };
        }
        extR *= 0.92;
    }
}

// --- One-band portrait (iPad / squarish): moon | map | date across the top --
// Exported (alongside portraitTwoBand) so the iteration-3 harness can pin A3
// (iPad portrait) to the one-band arrangement across all sizes. Not used by
// production code.
export function portraitOneBand(W: number, H: number, lowerBand: LowerBand | null): LayoutParams {
    // Solve D with header coupling: headerH = mapH + 2g = 0.205·D + 2g,
    // contentH = headerH + g + D + g = 1.205·D + 4g ≤ H (trailing g keeps the
    // dial rim off the footer line).
    let extR = clamp(0.165 * (0.95 * W) / 2, 22, 0.20 * (0.95 * W) / 2);
    let g = gapFor(extR);
    const D = clamp(
        Math.min(DIAL_FRAC_MAX * W, (H - 4 * g) / (1 + MAP_FRAC_OF_D / 2)),
        DIAL_FRAC_MIN * W,
        DIAL_FRAC_MAX * W,
    );
    const mainR = D / 2;
    extR = clamp(0.165 * mainR, 22, 0.20 * mainR);
    g = gapFor(extR);

    const inner = innerDialGeometry(mainR);

    // Map: start at the iOS invariant 0.41·D; grow into any vertical surplus,
    // bounded so the moon and a minimum date box keep their width.
    const moonRTarget = MOON_EXT_PORTRAIT * extR;
    const dateWMin = Math.max(0.26 * W, 140);
    let mapW = MAP_FRAC_OF_D * D;
    {
        const surplus = H - (mapW / 2 + 2 * g) - g - D;
        const mapWMaxWidth = W - 4 * g - 2 * moonRTarget - dateWMin;
        const mapWMax = Math.min(0.55 * W, mapWMaxWidth);
        mapW = clamp(mapW + 2 * Math.max(0, surplus), mapW, Math.max(mapW, mapWMax));
    }
    const mapH = mapW / 2;

    const headerBand = mapH + 2 * g;
    const contentH = headerBand + g + D + g;
    let topPad = Math.max(0, (H - contentH) / 2);

    const mainCX = W / 2;
    // Keep the dial clear of the popover's lower arm when their x-spans meet.
    if (lowerBand && mainCX + mainR > lowerBand.left - g) {
        const maxBottom = lowerBand.top - g;
        const bottomAt = (pad: number) => pad + headerBand + g + D;
        if (bottomAt(topPad) > maxBottom) {
            topPad = Math.max(0, maxBottom - headerBand - g - D);
        }
    }
    const mainCY = topPad + headerBand + g + mainR;
    const headerBottom = topPad + g + mapH;

    // Moon: centered in the gap left of the map, vertically centered in the band.
    const moonR = clamp(moonRTarget, extR, mapH / 2);
    const leftGapCenter = (g + (W / 2 - mapW / 2)) / 2;
    const moonCX = Math.max(g + moonR, leftGapCenter);
    const moonCY = topPad + g + mapH / 2;

    // Date: fills the band right of the map (mode: stack).
    const dateLeft = W / 2 + mapW / 2 + g;
    const dateW = Math.max(60, W - g - dateLeft);
    const dateH = mapH;
    const dateCX = dateLeft + dateW / 2;
    const dateCY = topPad + g + mapH / 2;

    const { extR: extRFit, ...corners } = portraitCornerDials({
        W, H, mainCX, mainCY, mainR, extR, g, headerBottom, lowerBand,
    });
    const ext = extDerived(extRFit);

    return assemble({
        W, H, mainCX, mainCY, mainR, inner,
        moonCX, moonCY, moonR,
        earthCX: W / 2, earthCY: topPad + g + mapH / 2, earthW: mapW, earthH: mapH,
        ...corners,
        extR: extRFit, ext,
        dateMode: 'stack',
        dateCX, dateCY, dateW, dateH,
        date2CX: 0, date2CY: 0, date2W: 0, date2H: 0,
    });
}

// --- Two-band portrait (phones): moon+map band, date row, then the dial -----
// Exported so the iteration-3 layout harness can pin A2 (iPhone portrait) to the
// two-band phone arrangement across all sizes, bypassing the width-triggered
// one-band flip in computePortrait. Not used by production code.
export function portraitTwoBand(W: number, H: number, lowerBand: LowerBand | null): LayoutParams {
    // Dial first (width-bound on phones), then bands above it.
    const mapHMin = 60, dateHMin = 30;
    let extR = clamp(0.165 * (0.95 * W) / 2, 22, 0.20 * (0.95 * W) / 2);
    let g = gapFor(extR);
    const D = clamp(
        Math.min(DIAL_FRAC_MAX * W, H - mapHMin - dateHMin - 4 * g),
        DIAL_FRAC_MIN * W,
        DIAL_FRAC_MAX * W,
    );
    const mainR = D / 2;
    extR = clamp(0.165 * mainR, 22, 0.20 * mainR);
    g = gapFor(extR);

    const inner = innerDialGeometry(mainR);

    // Band 1: moon + map share the width; iterate the coupled sizes (the moon
    // tracks 0.4·mapH, bounded by the moon-≥-ext-dial rule and the map height).
    let moonR = Math.max(extR, 30);
    let mapW = 0, mapH = 0;
    for (let i = 0; i < 4; i++) {
        mapW = W - 3 * g - 2 * moonR;
        mapH = mapW / 2;
        // Cap the band height on shorter windows.
        const mapHCap = 0.32 * H;
        if (mapH > mapHCap) { mapH = mapHCap; mapW = mapH * 2; }
        moonR = clamp(0.4 * mapH, extR, mapH / 2);
    }

    // Band 2: the date row.
    const dateH = clamp(0.45 * mapH, dateHMin, 80);
    const dateW = W - 2 * g;

    // Distribute the leftover height as even padding around the bands
    // (4 slots: top, band1↔band2, band2↔dial, bottom).
    const contentH = mapH + g + dateH + g + D;
    let pad = Math.max(0, (H - contentH - 2 * g) / 4);

    const mainCX = W / 2;
    // Popover lower arm: lift the whole block if the dial would dip into it.
    if (lowerBand && mainCX + mainR > lowerBand.left - g) {
        const maxBottom = lowerBand.top - g;
        const bottomAt = (p: number) => p + mapH + g + p + dateH + g + p + D;
        if (bottomAt(pad) > maxBottom) {
            pad = Math.max(0, (maxBottom - contentH - 2 * g) / 3);
        }
    }

    const yTop = pad;
    const band2Top = yTop + mapH + g + pad;
    const dialTop = band2Top + dateH + g + pad;
    const mainCY = dialTop + mainR;

    // Moon left, map filling the rest of band 1.
    const moonCX = g + moonR;
    const moonCY = yTop + mapH / 2;
    const earthCX = 2 * g + 2 * moonR + mapW / 2;
    const earthCY = yTop + mapH / 2;

    const dateCX = W / 2;
    const dateCY = band2Top + dateH / 2;

    const { extR: extRFit, ...corners } = portraitCornerDials({
        W, H, mainCX, mainCY, mainR, extR, g,
        headerBottom: band2Top + dateH, lowerBand,
    });
    const ext = extDerived(extRFit);

    return assemble({
        W, H, mainCX, mainCY, mainR, inner,
        moonCX, moonCY, moonR,
        earthCX, earthCY, earthW: mapW, earthH: mapH,
        ...corners,
        extR: extRFit, ext,
        dateMode: 'row',
        dateCX, dateCY, dateW, dateH,
        date2CX: 0, date2CY: 0, date2W: 0, date2H: 0,
    });
}

// ---------------------------------------------------------------------------
// Landscape (wide): dial centered, side margins hold everything else
// ---------------------------------------------------------------------------

function computeLandscape(W: number, H: number, lowerBand: LowerBand | null): LayoutParams {
    // Reserve a minimum side band so the dial doesn't crowd out the peripherals.
    // Scales with height so near-square landscape windows yield dial size to
    // the margins (otherwise the moon/dials/date starve at e.g. 1451×1341);
    // wide windows are unaffected (their margins are already deeper than this).
    const minSideBand = Math.max(56, 0.16 * H);
    const g0 = 8;
    const D = clamp(
        Math.min(DIAL_FRAC_MAX * H, W - 2 * (minSideBand + g0)),
        DIAL_FRAC_MIN * H,
        DIAL_FRAC_MAX * H,
    );
    const mainR = D / 2;
    const mainCX = W / 2;
    const mainCY = H / 2;

    const inner = innerDialGeometry(mainR);
    const sideMargin = (W - D) / 2;

    // --- Ext-dial size: the moon rule (moonR = 1.5·extR) couples into two
    // candidate margin arrangements; take whichever yields bigger dials.
    const c = MOON_EXT_LANDSCAPE;
    const wkH = clamp(0.10 * H, 28, 110);         // weekday box height (split date)
    const solveExt = (g: number) => {
        // (a) side-by-side: moon column (2·moonR wide) beside the dial column
        //     (2·extR wide) within the margin; dials nestle against the circle.
        const sbs = Math.min(
            (sideMargin - 3 * g) / (2 * c + 2),   // horizontal fit
            (H - 3 * g) / 4,                      // two dials stacked vertically
            (H - wkH - 3 * g) / (2 * c),          // moon + weekday box vertically
        );
        // (b) stacked: moon, alt, az, weekday in one margin-wide column.
        const stk = Math.min(
            (sideMargin - 2 * g) / (2 * c),       // moon Ø fits margin width
            (sideMargin - 2 * g) / 2,             // dial Ø fits margin width
            (H - wkH - 5 * g) / (4 + 2 * c),      // full column height
        );
        return { sbs, stk };
    };
    let g = 10;
    let cand = solveExt(g);
    let extR = Math.max(cand.sbs, cand.stk);
    g = gapFor(extR);
    cand = solveExt(g);
    const sideBySide = cand.sbs >= cand.stk;
    extR = clamp(Math.max(cand.sbs, cand.stk), 18, EXT_R_CAP_FRAC * mainR);
    const ext = extDerived(extR);

    const moonR = clamp(c * extR, extR, Math.max(extR, (sideMargin - 2 * g) / 2));

    // Moon: top-left corner.
    const moonCX = g + moonR;
    const moonCY = g + moonR;

    // Map: largest 2:1 box in the top-right corner, clear of the dial; the
    // corner box may ride over the circle's shoulder, so it is not limited to
    // the margin width. Cap so it never rivals the dial itself.
    const mapBox = largestCornerRect(+1, -1, mainCX, mainCY, mainR, W, H, g, 2);
    let earthW = Math.min(mapBox.w, 0.9 * D);
    let earthH = earthW / 2;
    const earthCX = W - g - earthW / 2;
    const earthCY = g + earthH / 2;
    const mapBottom = g + earthH;

    // --- Dial columns ---
    let altCX: number, altCY: number, azCX: number, azCY: number;
    let eclipseCX: number, eclipseCY: number, eotCX: number, eotCY: number;
    let wkCX: number, wkCY: number, wkW: number;
    let d2CX: number, d2CY: number, d2W: number;
    const d2H = clamp(0.16 * H, 40, 170);         // date+year box height

    if (sideBySide) {
        // Dials nestle against the circle; moon/date boxes sit outside them
        // (the side-by-side solve guarantees the columns don't overlap in x,
        // so the left dials center on the dial rather than dodging the moon).
        const xOff = mainR + extR + g;
        const xL = mainCX - xOff, xR = mainCX + xOff;
        const upperLeftY = mainCY - extR - g / 2;
        const upperRightY = Math.max(mainCY - extR - g / 2, mapBottom + g + extR);
        altCX = xL; altCY = upperLeftY;
        azCX = xL; azCY = upperLeftY + 2 * extR + g;
        eclipseCX = xR; eclipseCY = upperRightY;
        eotCX = xR; eotCY = upperRightY + 2 * extR + g;

        // Weekday: bottom-left, in the outer column (left of the dial column).
        wkW = Math.max(2 * moonR, xL - extR - 2 * g);
        wkCX = g + wkW / 2;
        const wkBottom = bottomLimitFor(g, g + wkW, H, lowerBand, g);
        wkCY = wkBottom - g - wkH / 2;

        // Month/day + year: bottom-right, right of the dial column.
        const d2Left = xR + extR + g;
        d2W = Math.max(60, W - g - d2Left);
        d2CX = d2Left + d2W / 2;
        const d2Bottom = bottomLimitFor(d2Left, W - g, H, lowerBand, g);
        d2CY = d2Bottom - g - d2H / 2;
    } else {
        // Stacked columns centered in each margin. The corner anchors stay
        // pinned (moon / map at the top, date boxes at the bottom) and the two
        // dials distribute evenly through the free span between them, instead
        // of clumping under the top element.
        const xL = sideMargin / 2;
        const xR = W - sideMargin / 2;

        wkW = sideMargin - 2 * g;
        wkCX = g + wkW / 2;
        const wkBottom = bottomLimitFor(g, g + wkW, H, lowerBand, g);
        wkCY = wkBottom - g - wkH / 2;

        d2W = sideMargin - 2 * g;
        d2CX = W - sideMargin + g + d2W / 2;
        const d2Bottom = bottomLimitFor(W - sideMargin + g, W - g, H, lowerBand, g);
        d2CY = d2Bottom - g - d2H / 2;

        // Even distribution: centers at the thirds of the free span, kept
        // separated and inside the span when it gets tight.
        const distribute = (top: number, bottom: number): [number, number] => {
            const third = (bottom - top) / 3;
            let y1 = top + third;
            let y2 = top + 2 * third;
            const minSep = 2 * extR + g;
            if (y2 - y1 < minSep) {
                const mid = (y1 + y2) / 2;
                y1 = mid - minSep / 2;
                y2 = mid + minSep / 2;
            }
            y1 = Math.max(y1, top + extR);
            y2 = Math.min(y2, bottom - extR);
            return [y1, y2];
        };

        const [altY, azY] = distribute(2 * g + 2 * moonR, wkCY - wkH / 2 - g);
        altCX = xL; altCY = altY;
        azCX = xL; azCY = azY;
        const [eclY, eotY] = distribute(mapBottom + g, d2CY - d2H / 2 - g);
        eclipseCX = xR; eclipseCY = eclY;
        eotCX = xR; eotCY = eotY;
    }

    // Keep the right-column dials above the popover's lower arm.
    const eotBottomLimit = bottomLimitFor(eotCX - extR, eotCX + extR, H, lowerBand, g);
    if (eotCY + extR > eotBottomLimit) eotCY = eotBottomLimit - extR;
    // And the date2 box clear of the eot dial.
    if (Math.abs(d2CX - eotCX) < d2W / 2 + extR && d2CY - d2H / 2 < eotCY + extR + g) {
        d2CY = eotCY + extR + g + d2H / 2;
    }

    return assemble({
        W, H, mainCX, mainCY, mainR, inner,
        moonCX, moonCY, moonR,
        earthCX, earthCY, earthW, earthH,
        altCX, altCY, azCX, azCY, eclipseCX, eclipseCY, eotCX, eotCY,
        extR, ext,
        dateMode: 'split',
        dateCX: wkCX, dateCY: wkCY, dateW: wkW, dateH: wkH,
        date2CX: d2CX, date2CY: d2CY, date2W: d2W, date2H: d2H,
    });
}

// --- Assemble the flat LayoutParams from the computed pieces ---------------
interface AssembleArgs {
    W: number; H: number;
    mainCX: number; mainCY: number; mainR: number; inner: InnerDial;
    moonCX: number; moonCY: number; moonR: number;
    earthCX: number; earthCY: number; earthW: number; earthH: number;
    altCX: number; altCY: number; azCX: number; azCY: number;
    eclipseCX: number; eclipseCY: number; eotCX: number; eotCY: number;
    extR: number;
    ext: ReturnType<typeof extDerived>;
    dateMode: DateMode;
    dateCX: number; dateCY: number; dateW: number; dateH: number;
    date2CX: number; date2CY: number; date2W: number; date2H: number;
}

function assemble(a: AssembleArgs): LayoutParams {
    const i = a.inner;
    const subs = innerSubdials(a.mainCX, a.mainCY, i.subOffset);
    return {
        // viewW/viewH/dpr are overwritten by computeLayout with the real values.
        viewW: a.W, viewH: a.H, dpr: 1,
        mainCX: a.mainCX, mainCY: a.mainCY, mainR: a.mainR,
        subR: i.subR, zR: i.zR, zD: i.zD, sunD: i.sunD,
        tickHeight: i.tickHeight, secLen: i.secLen,
        plR: i.plR, plR2: i.plR2, orbitInc: i.orbitInc, sunRingWidth: i.sunRingWidth,
        h24Len: i.h24Len, h12Len: i.h12Len, minLen: i.minLen, sunRiseSetLen: i.sunRiseSetLen,
        h24Arrow: i.h24Arrow, h24Wid: i.h24Wid, sunRiseSetArrow: i.sunRiseSetArrow, len2: i.len2,
        breH12Width: i.breH12Width, breH12CenterR: i.breH12CenterR,
        breMinWidth: i.breMinWidth, breMinCenterR: i.breMinCenterR,
        secWidth: i.secWidth, secBallR: i.secBallR,
        mainFontSize: i.mainFontSize, subdialFontSize: i.subdialFontSize,
        zodiacFontSize: i.zodiacFontSize, smallZodiacFontSize: i.smallZodiacFontSize,
        subOffset: i.subOffset,
        utcCX: subs.utcCX, utcCY: subs.utcCY,
        solarCX: subs.solarCX, solarCY: subs.solarCY,
        sidCX: subs.sidCX, sidCY: subs.sidCY,
        moonCX: a.moonCX, moonCY: a.moonCY, moonR: a.moonR,
        earthCX: a.earthCX, earthCY: a.earthCY, earthW: a.earthW, earthH: a.earthH,
        altCX: a.altCX, altCY: a.altCY, altR: a.extR,
        azCX: a.azCX, azCY: a.azCY, azR: a.extR,
        eclipseCX: a.eclipseCX, eclipseCY: a.eclipseCY,
        eclipseR1: a.ext.eclipseR1, eclipseR2: a.ext.eclipseR2,
        eotCX: a.eotCX, eotCY: a.eotCY, eotR: a.extR,
        dateMode: a.dateMode,
        dateCX: a.dateCX, dateCY: a.dateCY, dateW: a.dateW, dateH: a.dateH,
        date2CX: a.date2CX, date2CY: a.date2CY, date2W: a.date2W, date2H: a.date2H,
        extFontSize: a.ext.extFontSize,
        eclipseFontSize: a.ext.eclipseFontSize,
        eotFontSize: a.ext.eotFontSize,
    };
}
