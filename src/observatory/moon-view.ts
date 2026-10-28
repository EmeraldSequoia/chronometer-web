/**
 * Moon phase display for Observatory.
 *
 * Port of EOMoonView.mm (.observatory-ref/Classes/EOMoonView.mm):
 *   - Draws a photographic full-moon image (moon300.png, or moon768.png when
 *     the disc is large on screen — moon-texture.ts) scaled by the Moon's
 *     apparent angular size, which varies with its geocentric distance.
 *   - Overlays a dark terminator tracing the current phase, with a slight
 *     translucency near new moon to simulate earthlight.
 *   - Rotates the whole display (image + terminator) by moonRelativeAngle() to
 *     match the Moon's orientation in the sky (the iOS EOChandra view rotation).
 *
 * Animated values come from the shared Updater so the moon scrubs/animates with
 * the rest of the clock:
 *   moonPhase    — moonAgeAngle()      (0=new … π=full)
 *   moonRotation — moonRelativeAngle() (sky orientation)
 *   moonDistAU   — distance in AU      (drives apparent size)
 */

import { initMoonTexture, getMoonTexture } from '../shared/moon-texture.js';

import type { LayoutParams } from './layout.js';
import type { ObsValueName } from './obs-values.js';
import type { Updater } from '../shared/updater.js';

// ============================================================================
// Apparent-size constants (port of EOMoonView.mm:82-89)
// ============================================================================

const PERIGEE_DISTANCE_KM = 355000.0;     // km
const AU_KM = 149600000.0;                // km; units of distanceFromEarthOfPlanet
const LUNAR_RADIUS_KM = 1737.10;          // km

const ANGULAR_RADIUS_AT_PERIGEE = Math.atan(LUNAR_RADIUS_KM / PERIGEE_DISTANCE_KM);

// ============================================================================
// Module state
// ============================================================================


// ============================================================================
// Initialization
// ============================================================================

/** Start loading the Moon texture (the small one; the large follows on demand). */
export function initMoonView(): void {
    initMoonTexture();
}

// ============================================================================
// Terminator
// ============================================================================

/**
 * Draw the dark terminator overlay onto the moon (port of drawMoonPhaseAt:,
 * EOMoonView.mm:42-71). Called in a context already translated to the moon
 * center and rotated by moonRelativeAngle().
 *
 * @param ctx     Main canvas 2D context (origin at moon center)
 * @param radius  Apparent pixel radius of the moon disc
 * @param pa      Phase angle: 0 = new moon, π/2 = first quarter, π = full
 */
function drawTerminator(ctx: CanvasRenderingContext2D, radius: number, pa: number): void {
    // Not fully opaque near new moon → simulate earthlight.
    const alpha = 0.75 + Math.abs(Math.sin(pa)) / 3;
    ctx.fillStyle = `rgba(20, 20, 23, ${alpha})`;   // (.08,.08,.09)·255
    ctx.strokeStyle = `rgba(20, 20, 23, ${alpha})`;
    ctx.lineWidth = 0.2;

    const r = radius + 1;

    ctx.beginPath();
    // Start at the south pole.
    ctx.moveTo(0, r);
    // Half circle (the unlit limb) from south pole to north pole.
    // iOS: CGContextAddArc(...M_PI/2, -M_PI/2, sin(pa) >= 0 ? 0 : 1) in a y-up CTM.
    // Porting to canvas y-down, the arc must sweep the OTHER limb so the
    // terminator lune subtracts from (rather than adds to) the half-disk:
    // dark fraction = (1 + cos pa)/2, so a near-full moon shows a thin crescent.
    ctx.arc(0, 0, r, Math.PI / 2, -Math.PI / 2, Math.sin(pa) < 0);

    // Terminator ellipse from north pole back to south pole, in 2n steps.
    const n = 10;
    const xSign = Math.sin(pa) < 0 ? -1 : 1;
    for (let i = -n; i < n; i++) {
        const th = (Math.PI / 2) * (i / n);
        ctx.lineTo(xSign * Math.cos(pa) * Math.cos(th) * r, Math.sin(th) * r);
    }

    ctx.closePath();
    ctx.fill();
    ctx.stroke();
}

// ============================================================================
// Drawing
// ============================================================================

/**
 * Draw the moon phase display into the main canvas.
 *
 * Called from observatory-entry.ts drawFrame(). Reads animated values from the
 * Updater for smooth scrubbing.
 *
 * @param ctx Main canvas 2D context (layout/CSS-pixel space)
 * @param L   Layout params (moonCX, moonCY, moonR)
 * @param u   Observatory animated value updater
 */
export function drawMoonView(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
    u: Updater<ObsValueName>,
): void {
    const pa = u.get('moonPhase').currentValue;
    const rotation = u.get('moonRotation').currentValue;
    const distAU = u.get('moonDistAU').currentValue;

    // Apparent size: scale L.moonR (radius at perigee) by the ratio of the
    // current angular radius to the angular radius at perigee.
    const angularRadiusNow = Math.atan(LUNAR_RADIUS_KM / (distAU * AU_KM));
    const pixelRadius = L.moonR * angularRadiusNow / ANGULAR_RADIUS_AT_PERIGEE;
    if (pixelRadius <= 0) return;

    // The 300 or 768 texture, by the disc's size in device px (moon-texture.ts).
    const moonImg = getMoonTexture(2 * pixelRadius * L.dpr);
    if (!moonImg) return;

    ctx.save();
    ctx.translate(L.moonCX, L.moonCY);
    ctx.rotate(rotation);

    // Full moon image, centered.
    ctx.drawImage(moonImg, -pixelRadius, -pixelRadius, pixelRadius * 2, pixelRadius * 2);

    // Phase terminator.
    drawTerminator(ctx, pixelRadius, pa);

    ctx.restore();
}
