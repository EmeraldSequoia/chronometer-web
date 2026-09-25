/**
 * Observatory peripheral dial hands + planet labels — dynamic layer.
 *
 * Draws the Altitude, Azimuth and Equation-of-Time triangle hands each frame,
 * plus the selected-body name on the alt/az dials with its ‹ › chevrons — the
 * visible body selector (body-selector.ts; docs/observatory.md § Planet
 * selection). On a body change the name slides out in the tapped direction
 * and the new one slides in from the other side (250 ms, clipped to the
 * label zone) while the hands sweep to the new body, and the tapped half-disc
 * lights up and fades (the tap wash, 600 ms) with its chevron at full white.
 *
 * Hand angle conventions (port of EOHandView.mm):
 *   - Azimuth  : planetAzimuth(p)            → 0 = North at top, CW
 *   - Altitude : planetAltitude(p) − π/2     → left half-gauge (zenith up)
 *   - EOT      : 24 · EOTAngle()             → 0 at top, + to the right
 */

import type { LayoutParams } from './layout.js';
import { OUTER_DIAL_TITLE_RATIO } from './layout.js';
import type { ObsValueName } from './obs-values.js';
import { DIAL_BODIES } from './obs-values.js';
import type { Updater } from '../shared/updater.js';
import { isReducedMotion } from '../shared/updater.js';
import { drawTriangleHand } from './hand-views.js';
import { drawText, demiRadialTextCenter, textVisualHalfHeight } from './draw-utils.js';
import {
    layoutBodyLabel, slideProgress, flashLevel,
    CHEVRON_FONT_RATIO, CHEVRON_ALPHA, CHEVRON_HOVER_ALPHA, CHEVRON_CLEARANCE_EM,
    CHEVRON_BACK, CHEVRON_FORWARD, FLASH_PEAK_ALPHA,
    type BodySlide, type BodyFlash, type DialHalf,
} from './body-selector.js';

const HAND_STROKE = 'rgba(200,200,200,1)';
const HAND_FILL = 'rgba(170,170,170,1)';
const LABEL_COLOR = 'rgba(255,255,255,1)';   // match the dial titles (full white)
const FLASH_COLOR = 'rgba(255,255,255,1)';   // the tap wash, at FLASH_PEAK_ALPHA · level
const HALF_PI = Math.PI / 2;

/** Planet number → dial body key (e.g. 0 → 'sun'). Earth (4) has no entry. */
const PN_TO_BODY = new Map<number, string>(DIAL_BODIES.map((b) => [b.pn, b.key]));

/** Display name for a body key. */
function bodyName(key: string): string {
    return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Display name for a planet number (Sun for anything unselectable). */
export function bodyNameForPlanet(planet: number): string {
    return bodyName(PN_TO_BODY.get(planet) ?? 'sun');
}

/** The chevron under the mouse, if any (observatory-entry tracks it). */
export interface BodySelectorHover {
    dial: 'alt' | 'az';
    half: DialHalf;
}

export interface BodySelectorUi {
    hover: BodySelectorHover | null;
    nowMs: number;
}

// --- The label slide (one for both dials) ---
let slide: BodySlide | null = null;

/**
 * Start the name slide for a body change made by a tap: the outgoing name
 * leaves in the tapped chevron's direction. A no-op under reduced motion, and
 * not called for cross-tab or share-link changes, which snap.
 */
export function beginBodyLabelSlide(fromPlanet: number, toPlanet: number, dir: 1 | -1, nowMs: number): void {
    if (isReducedMotion() || fromPlanet === toPlanet) { slide = null; return; }
    slide = { from: bodyNameForPlanet(fromPlanet), to: bodyNameForPlanet(toPlanet), dir, startMs: nowMs };
}

/** True while a slide is running. */
export function bodyLabelSliding(nowMs: number): boolean {
    return slide !== null && slideProgress(slide, nowMs) < 1;
}

// --- The tap wash (one at a time; a new tap restarts it on its own half) ---
let flash: BodyFlash | null = null;

/**
 * Light the half-disc an accepted tap hit. Not gated on reduced motion: it
 * is an opacity fade with no movement, and under reduced motion (where the
 * name snaps) it is the only sign that the tap landed.
 */
export function beginBodyTapFlash(dial: 'alt' | 'az', half: DialHalf, nowMs: number): void {
    flash = { dial, half, startMs: nowMs };
}

/** True while the tap wash is still visible. */
export function bodyTapFlashing(nowMs: number): boolean {
    return flash !== null && flashLevel(flash, nowMs) > 0;
}

/** True while the slide or the wash needs frames (the render loop keeps producing them). */
export function bodySelectorAnimating(nowMs: number): boolean {
    return bodyLabelSliding(nowMs) || bodyTapFlashing(nowMs);
}

/** Tests: drop any slide or wash in flight. */
export function resetBodySelectorAnimation(): void {
    slide = null;
    flash = null;
}

/** The wash's level on `dial` (0 when none is in flight or it is elsewhere). */
function flashLevelOn(dial: 'alt' | 'az', nowMs: number): number {
    return flash && flash.dial === dial ? flashLevel(flash, nowMs) : 0;
}

/**
 * The tap wash: a flat white fill over the tapped half of the dial's disc —
 * the chord is the vertical diameter, so the straight edge says "half" and
 * the arc completes the altitude gauge's missing right side when that is hit.
 */
function drawTapFlash(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, half: DialHalf, alpha: number): void {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = FLASH_COLOR;
    ctx.beginPath();
    // Canvas angles: the left half runs from the bottom (π/2) through the
    // left (π) to the top (3π/2); the right half from the top (−π/2) through
    // the right (0) to the bottom (π/2).
    if (half === 'back') ctx.arc(cx, cy, R, HALF_PI, 3 * HALF_PI);
    else ctx.arc(cx, cy, R, -HALF_PI, HALF_PI);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

/**
 * Draw one dial's body label: the name (or the slide's two names) between the
 * ‹ › chevrons, the group nudged right of `clearLeftOf` when given.
 */
function drawBodyLabel(
    ctx: CanvasRenderingContext2D,
    cx: number, y: number, em: number, name: string,
    dial: 'alt' | 'az', ui: BodySelectorUi | undefined, clearLeftOf?: number,
): void {
    const labelFont = `${em}px Arial, sans-serif`;
    const chevFont = `${CHEVRON_FONT_RATIO * em}px Arial, sans-serif`;
    ctx.save();
    ctx.font = labelFont;
    // The layout follows the incoming name during a slide (its final place).
    const nameW = ctx.measureText(name).width;
    ctx.font = chevFont;
    const chevW = ctx.measureText(CHEVRON_BACK).width;
    ctx.restore();
    const lay = layoutBodyLabel(cx, em, nameW, chevW, clearLeftOf);

    const now = ui?.nowMs ?? performance.now();
    // A chevron is full white under the mouse, and the tapped one goes to
    // full white with the wash and fades back with it (touch has no hover).
    const hoverHalf = ui?.hover && ui.hover.dial === dial ? ui.hover.half : null;
    const pressed = flashLevelOn(dial, now);
    const chevAlpha = (half: DialHalf): number => {
        if (hoverHalf === half) return CHEVRON_HOVER_ALPHA;
        const lift = flash?.half === half ? pressed : 0;
        return CHEVRON_ALPHA + (CHEVRON_HOVER_ALPHA - CHEVRON_ALPHA) * lift;
    };
    ctx.save();
    ctx.globalAlpha = chevAlpha('back');
    drawText(ctx, CHEVRON_BACK, lay.backX, y, chevFont, LABEL_COLOR);
    ctx.globalAlpha = chevAlpha('forward');
    drawText(ctx, CHEVRON_FORWARD, lay.forwardX, y, chevFont, LABEL_COLOR);
    ctx.restore();

    if (slide && slide.to === name && slideProgress(slide, now) < 1) {
        const t = slideProgress(slide, now);
        const zoneW = 2 * lay.zoneHalfW;
        ctx.save();
        ctx.beginPath();
        ctx.rect(lay.nameX - lay.zoneHalfW, y - em, zoneW, 2 * em);
        ctx.clip();
        ctx.globalAlpha = 1 - t;
        drawText(ctx, slide.from, lay.nameX + slide.dir * t * zoneW, y, labelFont, LABEL_COLOR);
        ctx.globalAlpha = t;
        drawText(ctx, slide.to, lay.nameX - slide.dir * (1 - t) * zoneW, y, labelFont, LABEL_COLOR);
        ctx.restore();
    } else {
        drawText(ctx, name, lay.nameX, y, labelFont, LABEL_COLOR);
    }
}

/**
 * Draw the alt/az/EOT hands and the selected-body labels.
 *
 * @param selectedPlanet ECPlanetNumber of the body shown on the alt/az dials.
 *                       Falls back to Sun (0) if not a selectable body.
 * @param ui             Hover state and the frame's time (for the slide and the wash).
 */
export function drawPeripheralHands(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
    u: Updater<ObsValueName>,
    selectedPlanet: number,
    ui?: BodySelectorUi,
): void {
    const s = L.altR / 60;
    const width = 3 * s;
    const name = bodyNameForPlanet(selectedPlanet);
    // The body-name label is the counterpart to the dial *title* ("Altitude" /
    // "Azimuth"), so it uses the same title-font rule (OUTER_DIAL_TITLE_RATIO · R),
    // not the smaller numeric-label font.
    const em = OUTER_DIAL_TITLE_RATIO * L.altR;

    // Both hands track the selected body via the shared dialAlt/dialAz values,
    // which animate (rather than snap) when the selection changes — see
    // obs-values.ts and the dialPlanet env variable.
    // Body name sits on top, centered in the radial gap between the top number
    // (N / 90) and the central hub; the dial-type label ("Altitude"/"Azimuth")
    // is the matching lower label, drawn in the static background
    // (peripheral-dials.ts). Gap center = ((R−f) inner edge + hub edge) / 2.
    const f = L.extFontSize;
    const altLabelR = (L.altR - f - 1) / 2;
    const azLabelR = (L.azR - f - 1) / 2;

    // The altitude half-dial's "30" numeral (slot 10 of 12 in
    // peripheral-dials.ts, demi-radial at R − f) sits at the label's height
    // to its left; the ‹ chevron keeps CHEVRON_CLEARANCE_EM from the glyph's
    // bounding circle, nudging the group right when a long name (Mercury)
    // would otherwise collide (treatment c).
    ctx.save();
    ctx.font = `${f}px Arial, sans-serif`;
    const numHalfH = textVisualHalfHeight(ctx);
    const numHalfW = ctx.measureText('30').width / 2;
    ctx.restore();
    const c30 = demiRadialTextCenter(L.altCX, L.altCY, 10, 12, L.altR - f, L.altR - f + 1, numHalfH);
    const clearLeftOf = c30.x + Math.hypot(numHalfW, numHalfH) + CHEVRON_CLEARANCE_EM * em;

    // The tap wash goes under the hand and the label, over the static dial.
    const now = ui?.nowMs ?? performance.now();
    const altFlash = flashLevelOn('alt', now);
    if (altFlash > 0 && flash) drawTapFlash(ctx, L.altCX, L.altCY, L.altR, flash.half, FLASH_PEAK_ALPHA * altFlash);
    const altAngle = u.get('dialAlt').currentValue;
    drawTriangleHand(ctx, L.altCX, L.altCY, altAngle, L.altR * 0.90, width, HAND_STROKE, HAND_FILL);
    drawBodyLabel(ctx, L.altCX, L.altCY - altLabelR, em, name, 'alt', ui, clearLeftOf);

    const azFlash = flashLevelOn('az', now);
    if (azFlash > 0 && flash) drawTapFlash(ctx, L.azCX, L.azCY, L.azR, flash.half, FLASH_PEAK_ALPHA * azFlash);
    const azAngle = u.get('dialAz').currentValue;
    drawTriangleHand(ctx, L.azCX, L.azCY, azAngle, L.azR * 0.90, width, HAND_STROKE, HAND_FILL);
    drawBodyLabel(ctx, L.azCX, L.azCY - azLabelR, em, name, 'az', ui);

    // EOT hand.
    const eotAngle = u.get('eotAngle').currentValue;
    drawTriangleHand(ctx, L.eotCX, L.eotCY, eotAngle, L.eotR * 0.90, width, HAND_STROKE, HAND_FILL);
}

/**
 * Step the selected body through the cycle (skipping Earth, wrapping at the
 * ends). `dir` +1 = forward (the › chevron / a dial's right half), −1 = back
 * (‹ / the left half) — the same rule on both dials.
 */
export function cycleSelectablePlanet(current: number, dir: 1 | -1): number {
    const order: number[] = DIAL_BODIES.map((b) => b.pn);
    const n = order.length;
    const idx = order.indexOf(current);
    const base = idx < 0 ? 0 : idx;
    return order[(base + dir + n) % n];
}
