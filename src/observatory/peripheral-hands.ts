/**
 * Observatory peripheral dial hands + planet labels — dynamic layer.
 *
 * Draws the Altitude, Azimuth and Equation-of-Time triangle hands each frame,
 * plus the selected-body name label on the alt/az dials.
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
import { drawTriangleHand } from './hand-views.js';
import { drawText } from './draw-utils.js';

const HAND_STROKE = 'rgba(200,200,200,1)';
const HAND_FILL = 'rgba(170,170,170,1)';
const LABEL_COLOR = 'rgba(255,255,255,0.85)';

/** Planet number → dial body key (e.g. 0 → 'sun'). Earth (4) has no entry. */
const PN_TO_BODY = new Map<number, string>(DIAL_BODIES.map((b) => [b.pn, b.key]));

/** Display name for a body key. */
function bodyName(key: string): string {
    return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Draw the alt/az/EOT hands and the selected-body labels.
 *
 * @param selectedPlanet ECPlanetNumber of the body shown on the alt/az dials.
 *                       Falls back to Sun (0) if not a selectable body.
 */
export function drawPeripheralHands(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
    u: Updater<ObsValueName>,
    selectedPlanet: number,
): void {
    const key = PN_TO_BODY.get(selectedPlanet) ?? 'sun';
    const s = L.altR / 60;
    const width = 3 * s;
    const name = bodyName(key);
    // The body-name label is the counterpart to the dial *title* ("Altitude" /
    // "Azimuth"), so it uses the same title-font rule (OUTER_DIAL_TITLE_RATIO · R),
    // not the smaller numeric-label font.
    const labelFont = `${OUTER_DIAL_TITLE_RATIO * L.altR}px Arial, sans-serif`;

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

    const altAngle = u.get('dialAlt').currentValue;
    drawTriangleHand(ctx, L.altCX, L.altCY, altAngle, L.altR * 0.90, width, HAND_STROKE, HAND_FILL);
    drawText(ctx, name, L.altCX, L.altCY - altLabelR, labelFont, LABEL_COLOR);

    const azAngle = u.get('dialAz').currentValue;
    drawTriangleHand(ctx, L.azCX, L.azCY, azAngle, L.azR * 0.90, width, HAND_STROKE, HAND_FILL);
    drawText(ctx, name, L.azCX, L.azCY - azLabelR, labelFont, LABEL_COLOR);

    // EOT hand.
    const eotAngle = u.get('eotAngle').currentValue;
    drawTriangleHand(ctx, L.eotCX, L.eotCY, eotAngle, L.eotR * 0.90, width, HAND_STROKE, HAND_FILL);
}

/**
 * Step the selected body through the cycle (skipping Earth, wrapping at the ends),
 * matching iOS EOClock.mm:739-762.
 *
 * iOS gives the two dials opposite directions: the **altitude** dial advances
 * (`+1`, Sun→Moon→…→Saturn→Sun) and the **azimuth** dial reverses (`−1`,
 * Sun→Saturn→…→Moon→Sun) — so you "go back" by clicking the other dial.
 *
 * @param dir +1 = forward (altitude dial), −1 = backward (azimuth dial).
 */
export function cycleSelectablePlanet(current: number, dir: 1 | -1): number {
    const order: number[] = DIAL_BODIES.map((b) => b.pn);
    const n = order.length;
    const idx = order.indexOf(current);
    const base = idx < 0 ? 0 : idx;
    return order[(base + dir + n) % n];
}
