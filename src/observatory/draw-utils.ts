/**
 * Observatory shared drawing utilities.
 *
 * Ported from EOClock class methods (EOClock.mm L1138–1374).
 * All functions draw into a Canvas 2D context.
 *
 * IMPORTANT: Text positioning uses textBaseline='alphabetic' with
 * textVisualCenterY() for cross-browser consistency.
 * Never use textBaseline='top' — Safari positions it differently.
 * See docs/development-rules.md §9.
 */

const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;

/**
 * Accept both on-screen and offscreen canvas contexts.
 * All draw-utils functions use this union type.
 */
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// ---------------------------------------------------------------------------
// Text positioning (cross-browser safe)
// ---------------------------------------------------------------------------

/**
 * Compute the Y offset for fillText() so that text is vertically centred
 * on the font's em box — replicating what textBaseline='middle' does, but
 * anchored to the more cross-browser-consistent 'alphabetic' baseline.
 *
 * Uses fontBoundingBox metrics (constant for a given font/size) and
 * caches the result per font string to avoid repeated measureText() calls.
 *
 * Requires ctx.textBaseline = 'alphabetic' and ctx.font already set.
 *
 * Ported from Chronometer's renderer.ts textVisualCenterY().
 */
const _fontCenterCache = new Map<string, number>();

export function textVisualCenterY(ctx: Ctx2D, _text: string): number {
    const font = ctx.font;
    let cached = _fontCenterCache.get(font);
    if (cached !== undefined) return cached;
    const m = ctx.measureText('X');  // any character works — fontBoundingBox is per-font
    cached = (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2;
    _fontCenterCache.set(font, cached);
    return cached;
}

/**
 * Compute the actual visual half-height of rendered text from font metrics.
 *
 * Unlike `fontSize / 2`, this accounts for the font bounding box being
 * larger than the declared font size (e.g., Times New Roman 32px has
 * bbox ≈ 39px). Used for precise radial text positioning.
 *
 * Requires ctx.font already set.
 */
const _fontHalfHeightCache = new Map<string, number>();

export function textVisualHalfHeight(ctx: Ctx2D): number {
    const font = ctx.font;
    let cached = _fontHalfHeightCache.get(font);
    if (cached !== undefined) return cached;
    const m = ctx.measureText('X');
    cached = (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) / 2;
    _fontHalfHeightCache.set(font, cached);
    return cached;
}

// ---------------------------------------------------------------------------
// drawTicks — Radial tick marks around a circle
// ---------------------------------------------------------------------------

/**
 * Draw radial tick marks around a center point.
 *
 * Port of: [EOClock drawTicks:context x:y:n:innerRadius:outerRadius:width:color:angle1:angle2:noFives:]
 *
 * @param ctx       Canvas 2D rendering context
 * @param cx        Center X
 * @param cy        Center Y
 * @param n         Total number of ticks around the full circle
 * @param innerR    Inner radius (tick starts here)
 * @param outerR    Outer radius (tick ends here)
 * @param lineWidth Stroke width
 * @param color     CSS color string
 * @param angle1    Start angle for partial arcs (0 for full circle)
 * @param angle2    End angle for partial arcs (2π for full circle)
 * @param noFives   If true, skip ticks at multiples of 5
 */
export function drawTicks(
    ctx: Ctx2D,
    cx: number, cy: number,
    n: number,
    innerR: number, outerR: number,
    lineWidth: number,
    color: string,
    angle1 = 0,
    angle2 = TWO_PI,
    noFives = false,
): void {
    ctx.save();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = color;
    ctx.beginPath();

    for (let i = 0; i < n; i++) {
        if (noFives && (i % 5) === 0) continue;

        const th = (i / n) * TWO_PI;
        if ((angle1 <= th && th <= angle2) || (th === 0 && angle2 === TWO_PI)) {
            // iOS convention: angles measured clockwise from 12 o'clock
            // Convert to canvas coordinate system (0 = 3 o'clock, CW positive)
            const canvasAngle = th - HALF_PI;
            const cosA = Math.cos(canvasAngle);
            const sinA = Math.sin(canvasAngle);
            ctx.moveTo(cx + outerR * cosA, cy + outerR * sinA);
            ctx.lineTo(cx + innerR * cosA, cy + innerR * sinA);
        }
    }

    ctx.stroke();
    ctx.restore();
}

// ---------------------------------------------------------------------------
// drawDialNumbersUpright — Numbers positioned around a circle, always upright
// ---------------------------------------------------------------------------

/**
 * Draw numbers around a circle with each number staying upright (not rotated).
 *
 * Port of: [EOClock drawDialNumbersUpright:context x:y:text:font:color:radius:]
 * Uses textBaseline='alphabetic' + textVisualCenterY for cross-browser consistency.
 *
 * @param ctx      Canvas 2D context
 * @param cx       Center X
 * @param cy       Center Y
 * @param labels   Array of label strings (evenly spaced around the circle)
 * @param font     CSS font string (e.g. "14px 'Inter'")
 * @param color    CSS color string
 * @param radius   Distance from center to label position
 */
export function drawDialNumbersUpright(
    ctx: Ctx2D,
    cx: number, cy: number,
    labels: string[],
    font: string,
    color: string,
    radius: number,
): void {
    const n = labels.length;
    if (n < 1) return;

    ctx.save();
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    for (let i = 0; i < n; i++) {
        const label = labels[i];
        if (!label || label === ' ') continue;

        const metrics = ctx.measureText(label);
        const textW = metrics.width;
        // Use fontSize approximation for text height (consistent across browsers)
        const textH = parseFloat(font);

        // Position: offset inward by half the text diagonal
        // iOS: h = radius - sqrt(w*w + h*h)/2
        const h = radius - Math.sqrt(textW * textW + textH * textH) / 2;
        // Angle: clockwise from top (12 o'clock), then convert to canvas coords
        // iOS: th = -(i/n)*2π + π/2; canvas Y-down: th = (i/n)*2π - π/2
        const th = (i / n) * TWO_PI - HALF_PI;
        const x = cx + h * Math.cos(th);
        const y = cy + h * Math.sin(th);

        ctx.save();
        ctx.translate(x, y);
        ctx.fillText(label, 0, textVisualCenterY(ctx, label));
        ctx.restore();
    }

    ctx.restore();
}

// ---------------------------------------------------------------------------
// drawDialNumbersDemiRadial — Numbers that point inward, flipping at bottom
// ---------------------------------------------------------------------------

/**
 * Draw numbers around a circle in "demi-radial" style: numbers in the
 * top half radiate outward, numbers in the bottom half are flipped
 * 180° so they remain readable.
 *
 * Port of: [EOClock drawDialNumbersDemiRadial:context x:y:text:font:color:radius:radius2:]
 * Cross-browser safe: uses textBaseline='alphabetic' + textVisualCenterY.
 * Follows the same pattern as Chronometer renderer.ts drawQDial demi orientation.
 *
 * @param ctx      Canvas 2D context
 * @param cx       Center X
 * @param cy       Center Y
 * @param labels   Array of label strings
 * @param font     CSS font string
 * @param color    CSS color string
 * @param radius   Outer radius (for top-half numbers)
 * @param radius2  Inner radius reference (for bottom-half numbers)
 */
export function drawDialNumbersDemiRadial(
    ctx: Ctx2D,
    cx: number, cy: number,
    labels: string[],
    font: string,
    color: string,
    radius: number,
    radius2: number,
): void {
    const n = labels.length;
    if (n <= 1) return;

    ctx.save();
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    // Use actual font bounding box half-height instead of fontSize/2.
    // The bounding box is larger than the declared font size (e.g., Times
    // New Roman 32px has bbox ≈ 39px), which would otherwise push text
    // ~1/8 font-height too far outward.
    const halfH = textVisualHalfHeight(ctx);

    for (let i = 0; i < n; i++) {
        const label = labels[i];
        if (!label || label === ' ') continue;

        // Angle in canvas coordinates: clockwise from 12 o'clock
        // canvas: th = (i/n)*2π - π/2
        const th = (i / n) * TWO_PI - HALF_PI;

        // Is this label in the bottom half? (between 3 o'clock and 9 o'clock positions)
        // iOS: i > n/4 && i < 3*n/4
        const isBottom = i > n / 4 && i < 3 * n / 4;

        ctx.save();

        if (isBottom) {
            // Anti-radial half: text flipped 180°
            // After the flip, the text's outer edge sits at textR + halfH.
            // To align with radius2, we need textR = radius2 - halfH.
            const textR = radius2 - halfH;
            const tx = textR * Math.cos(th);
            const ty = textR * Math.sin(th);
            ctx.translate(cx + tx, cy + ty);
            ctx.rotate(th + HALF_PI + Math.PI);  // radial + 180° flip
            ctx.fillText(label, 0, textVisualCenterY(ctx, label));
        } else {
            // Radial half: text upright along radius
            // Text center at textR, outer edge at textR + halfH = radius
            const textR = radius - halfH;
            const tx = textR * Math.cos(th);
            const ty = textR * Math.sin(th);
            ctx.translate(cx + tx, cy + ty);
            ctx.rotate(th + HALF_PI);  // point outward
            ctx.fillText(label, 0, textVisualCenterY(ctx, label));
        }

        ctx.restore();
    }

    ctx.restore();
}

// ---------------------------------------------------------------------------
// drawCircularText — Text laid out along a circular arc
// ---------------------------------------------------------------------------

/**
 * Draw text characters spaced along a circular arc.
 *
 * Port of: [EOClock drawCircularText:inRect:radius:angle:offset:withContext:withFont:color:demi:]
 *
 * @param ctx       Canvas 2D context
 * @param text      The string to render
 * @param cx        Center X
 * @param cy        Center Y
 * @param radius    Radius of the text arc
 * @param angle     Starting angle (radians, clockwise from 12 o'clock)
 * @param offset    Additional angular offset
 * @param font      CSS font string
 * @param color     CSS color string
 * @param demi      If true, text at the bottom of the circle is flipped
 */
export function drawCircularText(
    ctx: Ctx2D,
    text: string,
    cx: number, cy: number,
    radius: number,
    angle: number,
    offset: number,
    font: string,
    color: string,
    demi: boolean,
): void {
    const n = text.length;
    if (n < 1) return;

    ctx.save();
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.translate(cx, cy);

    // Measure actual text bounds for the specific string (not generic font bounds).
    // This allows per-label centering: "Moon" (no descender) vs "Jupiter" (has 'p','j').
    const textMetrics = ctx.measureText(text);
    const actualAsc = textMetrics.actualBoundingBoxAscent;
    const actualDesc = textMetrics.actualBoundingBoxDescent;
    // Offset from alphabetic baseline to the visual center of this text's glyphs
    const visualCenterOffset = (actualAsc - actualDesc) / 2;

    // Compute total angular span of the text
    let totalArc = 0;
    const charWidths: number[] = [];
    for (let i = 0; i < n; i++) {
        const w = ctx.measureText(text[i]).width;
        charWidths.push(w);
        totalArc += w / radius;
    }

    // Normalize angle to [0, 2π)
    const normAngle = ((angle % TWO_PI) + TWO_PI) % TWO_PI;

    // Determine if we need to flip (demi-radial: bottom half)
    const needFlip = demi && normAngle > Math.PI / 2 && normAngle < 3 * Math.PI / 2;

    // iOS demiTweak: radius -= 0.75 for flipped text (EOClock.mm L1186)
    let effectiveR = radius;
    if (needFlip) {
        effectiveR -= 0.75;
    }

    let currentAngle: number;
    if (needFlip) {
        currentAngle = normAngle + Math.PI + offset + totalArc / 2;
    } else {
        currentAngle = normAngle + offset - totalArc / 2;
    }

    for (let i = 0; i < n; i++) {
        const charArc = charWidths[i] / effectiveR;

        if (needFlip) {
            // Flipped text (rotated π extra): +y points outward.
            // We want the text's visual center at +effectiveR:
            //   baseline + (actualDesc - actualAsc)/2 = effectiveR
            //   baseline = effectiveR + visualCenterOffset
            currentAngle -= charArc / 2;
            ctx.save();
            ctx.rotate(currentAngle);
            ctx.fillText(text[i], 0, effectiveR + visualCenterOffset);
            ctx.restore();
            currentAngle -= charArc / 2;
        } else {
            // Normal text: -y points outward.
            // We want the text's visual center at -effectiveR:
            //   baseline + (actualDesc - actualAsc)/2 = -effectiveR
            //   baseline = -effectiveR + visualCenterOffset
            currentAngle += charArc / 2;
            ctx.save();
            ctx.rotate(currentAngle);
            ctx.fillText(text[i], 0, -effectiveR + visualCenterOffset);
            ctx.restore();
            currentAngle += charArc / 2;
        }
    }

    ctx.restore();
}

// ---------------------------------------------------------------------------
// drawText — Simple centered text in a rect
// ---------------------------------------------------------------------------

/**
 * Draw centered text, handling the Cocoa→Canvas text transform.
 * Uses textBaseline='alphabetic' + textVisualCenterY for cross-browser safety.
 *
 * Port of: [EOClock drawText:inRect:withContext:withFont:color:]
 */
export function drawText(
    ctx: Ctx2D,
    text: string,
    x: number, y: number,
    font: string,
    color: string,
): void {
    ctx.save();
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x, y + textVisualCenterY(ctx, text));
    ctx.restore();
}

// ---------------------------------------------------------------------------
// drawCircle — Stroke a circle outline
// ---------------------------------------------------------------------------

/**
 * Stroke a circle outline (used for planet orbit circles, dial outlines, etc.)
 */
export function drawCircle(
    ctx: Ctx2D,
    cx: number, cy: number,
    radius: number,
    lineWidth: number,
    color: string,
): void {
    ctx.save();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TWO_PI);
    ctx.stroke();
    ctx.restore();
}

// ---------------------------------------------------------------------------
// drawFilledCircle — Fill a circle
// ---------------------------------------------------------------------------

/**
 * Fill a circle (used for dial backgrounds).
 */
export function drawFilledCircle(
    ctx: Ctx2D,
    cx: number, cy: number,
    radius: number,
    color: string,
): void {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TWO_PI);
    ctx.fill();
    ctx.restore();
}

// ---------------------------------------------------------------------------
// drawArc — Draw a thick arc segment (for rise/set rings)
// ---------------------------------------------------------------------------

/**
 * Draw a thick arc segment between two angles, filled with a color.
 * Used for planet rise/set rings.
 *
 * @param ctx       Canvas 2D context
 * @param cx        Center X
 * @param cy        Center Y
 * @param outerR    Outer radius of the arc ring
 * @param innerR    Inner radius of the arc ring
 * @param startAngle Start angle (radians, clockwise from 12 o'clock)
 * @param endAngle   End angle (radians, clockwise from 12 o'clock)
 * @param color     Fill color
 */
export function drawArc(
    ctx: Ctx2D,
    cx: number, cy: number,
    outerR: number, innerR: number,
    startAngle: number, endAngle: number,
    color: string,
): void {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();

    // Convert from clock angles (0=top, clockwise) to canvas angles (0=right, CW)
    const canvasStart = startAngle - HALF_PI;
    const canvasEnd = endAngle - HALF_PI;

    ctx.arc(cx, cy, outerR, canvasStart, canvasEnd);
    ctx.arc(cx, cy, innerR, canvasEnd, canvasStart, true);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}
