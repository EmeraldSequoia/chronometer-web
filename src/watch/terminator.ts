/**
 * Terminator leaf system — faithful port of the iOS leaf-based moon phase display.
 *
 * In iOS, a single <terminator> XML element is expanded into 4 × leavesPerQuadrant
 * individual leaf "hands" that each rotate independently based on the current moon
 * phase angle. This creates a mechanical approximation of the terminator line.
 *
 * Architecture (from iOS):
 *   Each leaf is an ECWatchHand with:
 *     - offsetRadius = radius + leafAnchorEdgeRadius (distance from moon center to anchor)
 *     - offsetAngleStream = "0 + (rotation)" for upper quadrants
 *                         = "pi + (rotation)" for lower quadrants
 *       → ALL upper leaves share one pole, ALL lower leaves share the opposite pole
 *     - angleStream = "terminatorAngle(phase, quad, idx, lpq, incr)" [+ pi for lower]
 *       → This rotates the leaf shape at its anchor point
 *
 * Ported from:
 *  - ECVirtualMachineOps.m terminatorAngle() (lines 4778-4901)
 *  - ECQView.m ECTerminatorLeaf drawAtZoomFactor (lines 1031-1110)
 *  - ECQView.m createTerminatorLeavesForRadius (lines 1157-1226)
 */

import type { TerminatorPart } from './types.js';
import type { Environment } from '../expr/env.js';
import { evalAttr } from '../shared/astro-env.js';

// ============================================================================
// Quadrant enum
// ============================================================================

export const enum TerminatorQuadrant {
    UpperLeft = 0,
    LowerLeft = 1,
    LowerRight = 2,
    UpperRight = 3,
}

function isLeft(q: TerminatorQuadrant): boolean {
    return q === TerminatorQuadrant.UpperLeft || q === TerminatorQuadrant.LowerLeft;
}

function isRight(q: TerminatorQuadrant): boolean {
    return q === TerminatorQuadrant.UpperRight || q === TerminatorQuadrant.LowerRight;
}

function isUpper(q: TerminatorQuadrant): boolean {
    return q === TerminatorQuadrant.UpperLeft || q === TerminatorQuadrant.UpperRight;
}

/**
 * The drawing order for leaves alternates even/odd index to interleave
 * the quadrants for proper overlapping.
 */
const EVEN_ORDER: TerminatorQuadrant[] = [
    TerminatorQuadrant.LowerLeft,
    TerminatorQuadrant.UpperLeft,
    TerminatorQuadrant.UpperRight,
    TerminatorQuadrant.LowerRight,
];
const ODD_ORDER: TerminatorQuadrant[] = [
    TerminatorQuadrant.UpperLeft,
    TerminatorQuadrant.LowerLeft,
    TerminatorQuadrant.LowerRight,
    TerminatorQuadrant.UpperRight,
];

function quadrantOrder(leafIndex: number, q: number): TerminatorQuadrant {
    return (leafIndex % 2 === 0) ? EVEN_ORDER[q] : ODD_ORDER[q];
}

// ============================================================================
// Phase angle helpers (from ECQView.m lines 871-895)
// ============================================================================

function phaseAngleForInnerEdge(
    forceLowerRight: boolean,
    quadrant: TerminatorQuadrant,
    indexWithinQuadrant: number,
    leavesPerQuadrant: number,
): number {
    if (!forceLowerRight && isLeft(quadrant)) {
        return Math.PI - ((indexWithinQuadrant + 1.0) / leavesPerQuadrant) * (Math.PI / 2);
    } else {
        return Math.PI + ((indexWithinQuadrant + 1.0) / leavesPerQuadrant) * (Math.PI / 2);
    }
}

function phaseAngleForOuterEdge(
    forceLowerRight: boolean,
    quadrant: TerminatorQuadrant,
    indexWithinQuadrant: number,
    leavesPerQuadrant: number,
): number {
    if (!forceLowerRight && isLeft(quadrant)) {
        return 2 * Math.PI - (indexWithinQuadrant / leavesPerQuadrant) * (Math.PI / 2);
    } else {
        return 0 + (indexWithinQuadrant / leavesPerQuadrant) * (Math.PI / 2);
    }
}

// ============================================================================
// terminatorAngle — the core leaf rotation math
// ============================================================================

/** Floating-point modulo that always returns non-negative. */
function fmod(a: number, b: number): number {
    return ((a % b) + b) % b;
}

/**
 * Calculate the rotation angle for a single terminator leaf.
 *
 * Direct port of ECVirtualMachineOps.m EBVM_OP5(terminatorAngle, ...) lines 4778-4901.
 *
 * @param phase - Current moon age angle in radians [0, 2π)
 * @param quad - Quadrant number (TerminatorQuadrant enum value)
 * @param indexWithinQuad - Leaf index within this quadrant (0-based, outside→inside)
 * @param leavesPerQuad - Total leaves per quadrant
 * @param incr - Whether to use incremental (smooth) transitions
 */
export function terminatorAngle(
    phase: number,
    quad: number,
    indexWithinQuad: number,
    leavesPerQuad: number,
    incr: number,
): number {
    const quadrant = quad as TerminatorQuadrant;
    const indexWithinQuadrant = indexWithinQuad;
    const leavesPerQuadrant = leavesPerQuad;
    const incremental = incr;

    // Adjust phase by half a leaf so the exact valid point is halfway through the active period
    phase = fmod(phase, Math.PI * 2);
    const halfLeafSpan = 0.5 / leavesPerQuadrant * (Math.PI / 2);
    if (phase > Math.PI) {
        phase -= halfLeafSpan;
        if (isLeft(quadrant) && phase < Math.PI) {
            phase = Math.PI + 0.01;
        }
    } else {
        phase += halfLeafSpan;
        if (isRight(quadrant) && phase > Math.PI) {
            phase = Math.PI - 0.01;
        }
    }

    // For left leaves, use the inverted phase
    if (isLeft(quadrant)) {
        phase = 2 * Math.PI - phase;
    }

    // Now compute as if we're on the lower right
    const innerPhase = phaseAngleForInnerEdge(true, quadrant, indexWithinQuadrant, leavesPerQuadrant);
    const outerPhase = phaseAngleForOuterEdge(true, quadrant, indexWithinQuadrant, leavesPerQuadrant);
    const outerEndPhase = innerPhase - Math.PI;
    const innerStartPhase = outerPhase + Math.PI;

    let returnAngle: number;
    if (phase < outerPhase) {
        return 0;
    } else if (phase < outerEndPhase) {
        // Rotate leaves inward
        const xOuterIntercept = Math.cos(outerPhase);
        const outerReferenceAngle = Math.atan(xOuterIntercept);

        const xInnerIntercept = Math.cos(outerEndPhase);
        const rOuter = Math.sqrt(xOuterIntercept * xOuterIntercept + 1.0);
        const innerReferenceAngle = Math.asin(xInnerIntercept / rOuter);

        if (incremental) {
            returnAngle = (phase - outerPhase) / (outerEndPhase - outerPhase)
                * (innerReferenceAngle - outerReferenceAngle);
        } else {
            return 0;
        }
    } else if (phase < innerStartPhase) {
        // Park angle
        returnAngle = Math.PI / 2 * (indexWithinQuadrant + 1.0) / leavesPerQuadrant;
    } else if (phase < innerPhase) {
        // Rotate leaves outward
        const xInnerIntercept = Math.cos(innerPhase);
        const innerReferenceAngle = Math.atan(xInnerIntercept);

        const xOuterIntercept = Math.cos(innerStartPhase);
        const rInner = Math.sqrt(xInnerIntercept * xInnerIntercept + 1.0);
        const outerReferenceAngle = Math.asin(xOuterIntercept / rInner);

        if (incremental) {
            returnAngle = -(phase - innerPhase) / (innerStartPhase - innerPhase)
                * (outerReferenceAngle - innerReferenceAngle);
        } else {
            return 0;
        }
    } else {
        return 0;
    }

    // Sign swap for UR and LL quadrants
    if (quadrant === TerminatorQuadrant.UpperRight || quadrant === TerminatorQuadrant.LowerLeft) {
        return -returnAngle;
    }

    return returnAngle;
}

// ============================================================================
// Leaf state — represents one expanded leaf
// ============================================================================

export interface TerminatorLeafState {
    quadrant: TerminatorQuadrant;
    indexWithinQuadrant: number;
    leavesPerQuadrant: number;
    radius: number;
    incremental: boolean;
    anchorEdgeRadius: number;
    leafFillColor: string;
    leafBorderColor: string;
    /** Terminator center X in XML coords */
    centerX: number;
    /** Terminator center Y in XML coords (positive up) */
    centerY: number;
    /** Base offset angle: 0 for upper quadrants, π for lower quadrants */
    baseOffsetAngle: number;
    /** Distance from leaf anchor to terminator center */
    offsetRadius: number;
    /** Current leaf angle (set by animation system: terminatorAngle result [+ π for lower]) */
    currentAngle: number;
    /** Current rotation (moonRelativePositionAngle — added to offset angle) */
    currentRotation: number;
    /** The phase angle expression string */
    phaseExpr: string | undefined;
    /** The rotation expression string */
    rotationExpr: string | undefined;
    /** Update interval in seconds (from XML update attr) */
    updateIntervalSec: number;
    /** Next time to re-evaluate expressions (performance.now()). */
    nextUpdateTime: number;
    /** Per-leaf angle ObsValue (driven by the per-face Updater; renderer reads
     *  `.currentValue`). */
    _obsAngle?: import('../shared/obs-value.js').ObsValue;
    /** Shared system-rotation ObsValue (same handle on every leaf of a terminator). */
    _obsRotation?: import('../shared/obs-value.js').ObsValue;
}

/**
 * Expand a TerminatorPart into individual leaf states.
 * Creates 4 × leavesPerQuadrant leaves.
 *
 * Mirrors createTerminatorLeavesForRadius (ECQView.m lines 1157-1226).
 */
export function expandTerminatorToLeaves(
    part: TerminatorPart,
    env: Environment,
): TerminatorLeafState[] {
    const radius = part.radius ? evalAttr(part.radius, env) : 20;
    const leavesPerQuadrant = part.leavesPerQuadrant ? Math.round(evalAttr(part.leavesPerQuadrant, env)) : 6;
    const incremental = part.incremental ? evalAttr(part.incremental, env) !== 0 : false;
    const anchorEdgeRadius = part.leafAnchorRadius ? evalAttr(part.leafAnchorRadius, env) : 0;
    const leafFillColor = part.leafFillColor ? hexToCSS(evalAttr(part.leafFillColor, env)) : '#080808';
    const leafBorderColor = part.leafBorderColor ? hexToCSS(evalAttr(part.leafBorderColor, env)) : '#383838';
    const centerX = part.x ? evalAttr(part.x, env) : 0;
    const centerY = part.y ? evalAttr(part.y, env) : 0;
    const offsetRadius = radius + anchorEdgeRadius;
    const updateIntervalSec = part.update ? evalAttr(part.update, env) : 60;

    const leaves: TerminatorLeafState[] = [];

    for (let i = 0; i < leavesPerQuadrant; i++) {
        for (let q = 0; q < 4; q++) {
            const quadrant = quadrantOrder(i, q);
            // iOS: offsetAngleStream = isUpper ? "0" : "pi"
            // (plus rotation expression, which is applied at draw time)
            const baseOffsetAngle = isUpper(quadrant) ? 0 : Math.PI;

            // Compute initial values for animation state
            const initialPhase = part.phaseAngle ? evalAttr(part.phaseAngle, env) : 0;
            const initialRotation = part.rotation ? evalAttr(part.rotation, env) : 0;
            let initialAngle = terminatorAngle(
                initialPhase, quadrant, i, leavesPerQuadrant,
                incremental ? 1 : 0,
            );
            if (!isUpper(quadrant)) initialAngle += Math.PI;

            leaves.push({
                quadrant,
                indexWithinQuadrant: i,
                leavesPerQuadrant,
                radius,
                incremental,
                anchorEdgeRadius,
                leafFillColor,
                leafBorderColor,
                centerX,
                centerY,
                baseOffsetAngle,
                offsetRadius,
                currentAngle: initialAngle,
                currentRotation: initialRotation,
                phaseExpr: part.phaseAngle,
                rotationExpr: part.rotation,
                updateIntervalSec,
                nextUpdateTime: 0,  // Force immediate evaluation on first frame
            });
        }
    }

    return leaves;
}

/**
 * Update all leaf angles based on current phase and rotation.
 * Legacy function — sets currentAngle/currentRotation directly
 * (no animation). Used by static cache building.
 */
export function updateLeafAngles(leaves: TerminatorLeafState[], env: Environment): void {
    if (leaves.length === 0) return;
    const phase = leaves[0].phaseExpr ? evalAttr(leaves[0].phaseExpr, env) : 0;
    const rotation = leaves[0].rotationExpr ? evalAttr(leaves[0].rotationExpr, env) : 0;

    for (const leaf of leaves) {
        let angle = terminatorAngle(
            phase,
            leaf.quadrant,
            leaf.indexWithinQuadrant,
            leaf.leavesPerQuadrant,
            leaf.incremental ? 1 : 0,
        );
        if (!isUpper(leaf.quadrant)) {
            angle += Math.PI;
        }
        leaf.currentAngle = angle;
        leaf.currentRotation = rotation;
    }
}


// ============================================================================
// Leaf drawing (Canvas 2D)
// ============================================================================

/**
 * Calculate a point on a terminator arc.
 * Port of calculateTerminatorArcPoint from ECQView.m lines 1006-1019.
 */
function terminatorArcPoint(
    i: number, n: number,
    xsign: number, ysign: number,
    xcenter: number, ycenter: number,
    radius: number, phase: number,
): [number, number] {
    const th = (Math.PI / 2) * (i / n);
    const x = xcenter + xsign * Math.abs(Math.cos(phase) * Math.cos(th) * radius);
    const y = ycenter + ysign * Math.sin(th) * radius;
    return [x, y];
}

/**
 * Draw a single terminator leaf on a Canvas 2D context.
 *
 * Port of ECTerminatorLeaf.drawAtZoomFactor (ECQView.m lines 1031-1110).
 *
 * The leaf is drawn relative to its anchor point (at the equator of the orb,
 * on the rim). The anchor point is already positioned by the caller via
 * translate/rotate.
 *
 * @param ctx - Canvas 2D context (already translated to anchor point)
 * @param leaf - The leaf state with current geometry
 */
export function drawTerminatorLeaf(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    leaf: TerminatorLeafState,
): void {
    const { quadrant, indexWithinQuadrant, leavesPerQuadrant, radius } = leaf;

    ctx.fillStyle = leaf.leafFillColor;
    ctx.strokeStyle = leaf.leafBorderColor;
    ctx.lineWidth = 0.5;

    let xsign: number;
    let ysign: number;
    const xcenter = 0;
    let ycenter: number;
    let clockwiseEndArc: boolean;

    switch (quadrant) {
        case TerminatorQuadrant.UpperLeft:
            xsign = -1; ysign = 1; ycenter = -radius; clockwiseEndArc = true;
            break;
        case TerminatorQuadrant.LowerLeft:
            xsign = -1; ysign = -1; ycenter = radius; clockwiseEndArc = false;
            break;
        case TerminatorQuadrant.UpperRight:
            xsign = 1; ysign = 1; ycenter = -radius; clockwiseEndArc = false;
            break;
        case TerminatorQuadrant.LowerRight:
            xsign = 1; ysign = -1; ycenter = radius; clockwiseEndArc = true;
            break;
    }

    const paInner = fmod(phaseAngleForInnerEdge(false, quadrant, indexWithinQuadrant, leavesPerQuadrant), 2 * Math.PI);
    const paOuter = fmod(phaseAngleForOuterEdge(false, quadrant, indexWithinQuadrant, leavesPerQuadrant), 2 * Math.PI);

    const n = 30;
    const overlap = leaf.incremental ? 1 : 0;

    ctx.beginPath();
    // Start at anchor point
    ctx.moveTo(xcenter, ycenter + ysign * radius);

    // Draw inner terminator arc, from anchor toward center
    let x: number, y: number;
    for (let i = n - 1; i >= -overlap; i--) {
        [x, y] = terminatorArcPoint(i, n, xsign, ysign, xcenter, ycenter, radius, paInner);
        ctx.lineTo(x, y);
    }

    // Draw end cap (semicircular arc connecting inner to outer)
    let [nextX, nextY] = terminatorArcPoint(-overlap, n, xsign, ysign, xcenter, ycenter, radius, paOuter);
    const midX = (x! + nextX) / 2;
    const midY = (y! + nextY) / 2;
    const deltaX = x! - nextX;
    const deltaY = y! - nextY;
    const endRadius = Math.sqrt(deltaX * deltaX + deltaY * deltaY) / 2.0;
    const startAngle = Math.atan2(y! - midY, x! - midX);
    const endAngle = Math.atan2(nextY - midY, nextX - midX);
    // We draw with scale(1, -1) to match CG Y-up convention.
    // With Y-flip, CG clockwise maps directly to Canvas counterclockwise
    // (same boolean value — the Y-flip re-inverts the winding).
    ctx.arc(midX, midY, endRadius, startAngle, endAngle, clockwiseEndArc);

    // Draw outer terminator arc, back toward anchor
    for (let i = -overlap; i <= n; i++) {
        [x, y] = terminatorArcPoint(i, n, xsign, ysign, xcenter, ycenter, radius, paOuter);
        ctx.lineTo(x, y);
    }

    ctx.closePath();
    ctx.fill();
    ctx.stroke();
}

/**
 * Draw the complete terminator (all leaves) onto the given context.
 *
 * iOS ECGLPart rendering pipeline (ECGLPart.m lines 1428-1464):
 *   offset = (offsetRadius * sin(offsetAngle), offsetRadius * cos(offsetAngle))  [CG Y-up]
 *   angleValue = offsetAngle + leafAngle
 *   Quad corners rotated by angleValue around anchor, then translated by offset.
 *
 * In Canvas (Y-down), we:
 *   1. Translate to terminator center
 *   2. Translate by offset (with Y negated for canvas)
 *   3. Rotate by -(offsetAngle + leafAngle) [negate because CG rotations are CW-positive while
 *      canvas is CCW-positive, AND Y is flipped]
 *   4. Draw the leaf shape
 *
 * @param ctx - Canvas 2D context (origin at watch face center)
 * @param leaves - Array of leaf states (from expandTerminatorToLeaves)
 * @param scale - XML→pixel scale factor
 */
type RenderContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawTerminator(
    ctx: RenderContext,
    leaves: TerminatorLeafState[],
    scale: number = 1,
): void {
    if (leaves.length === 0) return;

    for (const leaf of leaves) {
        // The per-face Updater drives these; fall back to the static-cache values
        // (set by updateLeafAngles) before the first tick.
        const rotation = leaf._obsRotation ? leaf._obsRotation.currentValue : leaf.currentRotation;
        const leafAngle = leaf._obsAngle ? leaf._obsAngle.currentValue : leaf.currentAngle;

        ctx.save();

        // 1. Translate to the terminator center (in scaled pixel coords)
        // Note: XML y is positive-up, canvas y is positive-down → negate Y
        ctx.translate(leaf.centerX * scale, -leaf.centerY * scale);

        // 2. Compute offset position (where the anchor point is)
        //    iOS: xoff = offsetRadius * cos(π/2 - offsetAngle) = offsetRadius * sin(offsetAngle)
        //    iOS: yoff = offsetRadius * sin(π/2 - offsetAngle) = offsetRadius * cos(offsetAngle)
        //    Canvas: yoff is negated (Y-down vs Y-up)
        const offsetAngle = leaf.baseOffsetAngle + rotation;
        const xoff = leaf.offsetRadius * Math.sin(offsetAngle) * scale;
        const yoff = -leaf.offsetRadius * Math.cos(offsetAngle) * scale; // negate for canvas Y-down
        ctx.translate(xoff, yoff);

        // 3. Rotate by full angleValue = offsetAngle + leafAngle
        //    In iOS (CG), positive angles are counterclockwise (standard math convention)
        //    In Canvas, positive angles are clockwise (Y is down)
        //    iOS rotates its quad by -angleValue (using calculateCorner with phi - theta)
        //    In Canvas with Y-down, the CG rotation -θ maps to Canvas rotation +θ
        //    → we need to just negate the iOS angle
        const angleValue = offsetAngle + leafAngle;
        ctx.rotate(angleValue);

        // 4. Scale for drawing (leaf geometry is in XML units)
        //    Also flip Y to match CG Y-up convention used by drawTerminatorLeaf.
        //    The leaf code is a direct port of iOS CoreGraphics which uses Y-up;
        //    scale(1, -1) restores that convention in our local coordinate system.
        ctx.scale(scale, -scale);

        // 5. Draw the leaf shape (in CG Y-up local coordinates)
        drawTerminatorLeaf(ctx, leaf);

        ctx.restore();
    }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a hex color value (as parsed from XML, e.g. 0xff383838) to a CSS color string.
 */
function hexToCSS(value: number): string {
    // Value is in 0xAARRGGBB format
    const v = value >>> 0; // force unsigned
    const a = ((v >> 24) & 0xFF) / 255;
    const r = (v >> 16) & 0xFF;
    const g = (v >> 8) & 0xFF;
    const b = v & 0xFF;
    if (a >= 0.999) {
        return `rgb(${r},${g},${b})`;
    }
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}
