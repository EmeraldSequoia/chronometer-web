/**
 * Analemma part — Sun analemma figure-eight display.
 *
 * Displays the Sun's analemma path (the figure-eight traced by the Sun's
 * position over a year at a fixed time/location) on a circular disc,
 * rotated to match the observer's current sky orientation.
 *
 * Architecture follows the terminator pattern: a single <analemma> XML
 * element is parsed into an AnalemmaState at init time, with dedicated
 * tick/draw functions called from the animation and render loops.
 *
 * Path coordinates: altitude/azimuth deltas from a reference configuration
 * (lon=0°, lat=45°N, 12:00 UT civil time, vernal equinox).
 *
 * Rotation: uses northAngleForObject(sunAlt, sunAz, observerLat) to orient
 * the analemma correctly in the observer's sky.
 */

import type { AnalemmaPart } from './types.js';
import type { Environment } from '../expr/env.js';
import { evalAttr, evalColor } from '../shared/astro-env.js';
import type { LoadedImage } from './image-loader.js';
import { dateToDateInterval } from '../astronomy/es-time.js';
import {
    sunSkyOrientationAngle,
    EOTSeconds,
    solarLongitudeCrossingTime,
    vernalEquinoxOnOrBefore,
    vernalEquinoxAfter,
    fractionOfVernalEquinoxYear,
} from '../astronomy/es-astro.js';
import { sunRAandDecl } from '../astronomy/es-coordinates.js';

// ============================================================================
// Constants
// ============================================================================

/** Reference latitude for path generation: 45°N */
const REF_LAT_RAD = 45 * Math.PI / 180;

// Reference longitude is 0° (Greenwich): the (EOT, declination) decomposition in
// analemmaPointFromEotDecl reconstructs the Sun's position at *mean noon*, which
// occurs at 12:00 UT on the Greenwich meridian.

/**
 * Reference date: vernal equinox 2024 (March 20, 2024 at 12:00 UT).
 * In Apple epoch seconds (seconds since 2001-01-01 00:00:00 UTC).
 * 2024-03-20 12:00 UT = 2024-03-20T12:00:00Z
 */
const REF_EPOCH_SECONDS = (() => {
    const d = new Date(Date.UTC(2024, 2, 20, 12, 0, 0));  // March 20, 2024 12:00 UT
    return (d.getTime() / 1000) - 978307200;  // Convert to Apple epoch
})();

/**
 * Number of points in the rendered analemma path. This is a pure resolution
 * knob — the path parameter runs [0, PATH_SAMPLE_COUNT) over one equinox year —
 * with no astronomical meaning. Points are genuinely sampled (not upsampled) via
 * the (EOT, declination) decomposition, so a high count smooths the figure's
 * sharp solstice turns at no correctness cost.
 */
export const PATH_SAMPLE_COUNT = 1000;

/** Default update interval in seconds (5 minutes). */
const DEFAULT_UPDATE_SEC = 300;

/** Padding factor: fraction of disc radius reserved as margin around the path. */
const PATH_MARGIN_FRACTION = 0.15;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Normalize an angle difference to [-π, π].
 * Critical for azimuth deltas near due south (π / -π boundary).
 */
function normalizeAngleDelta(delta: number): number {
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    return delta;
}

// ============================================================================
// Path generation
// ============================================================================

interface AnalemmaPathPoint {
    deltaAz: number;   // radians, normalized to [-π, π]
    deltaAlt: number;   // radians
}

/**
 * Sun's "mean-noon" altitude/azimuth at instant `di` for latitude `phi`
 * (reference longitude 0), reconstructed from the (equation-of-time,
 * declination) decomposition.
 *
 * Unlike raw `sunAltitude`/`sunAzimuth`, this places the Sun at the hour angle
 * it has at *mean noon* (H = EOT) rather than its actual hour angle at `di`, so
 * the result is a continuous function of time suitable for sub-day sampling of
 * the analemma — raw alt/az would fold in the Sun's diurnal motion and smear the
 * figure. At 12:00 UT (mean noon at Greenwich) H equals the actual hour angle,
 * so this reproduces `sunAltitude`/`sunAzimuth` at integer-day noons (verified to
 * sub-arcsecond in altitude / arcseconds in azimuth).
 */
function analemmaPointFromEotDecl(di: number, phi: number): { alt: number; az: number } {
    const dec = sunRAandDecl(di, null).declination;
    const H = EOTSeconds(di, null) * (2 * Math.PI / 86400);
    const sinAlt = Math.sin(dec) * Math.sin(phi) + Math.cos(dec) * Math.cos(phi) * Math.cos(H);
    const alt = Math.asin(sinAlt);
    const az = Math.atan2(
        -Math.cos(dec) * Math.cos(phi) * Math.sin(H),
        Math.sin(dec) - Math.sin(phi) * sinAlt,
    );
    return { alt, az };
}

/**
 * Pre-compute the analemma path as `PATH_SAMPLE_COUNT` alt/az-delta points.
 *
 * Sampling is anchored to the true vernal equinox (sample 0) and spread evenly
 * across the actual equinox-to-equinox year, so sample index `d` corresponds to
 * fraction `d / PATH_SAMPLE_COUNT` of the year — exactly how the runtime path
 * parameter indexes it. Each point is genuinely computed via the (EOT,
 * declination) decomposition (see `analemmaPointFromEotDecl`), so the high
 * sample count yields a smooth figure-eight (no spline upsampling).
 *
 * The equation of time creates the figure-eight's horizontal extent; the
 * changing declination creates the vertical extent.
 */
function computeAnalemmaPath(): {
    path: AnalemmaPathPoint[];
    refAlt: number;
    refAz: number;
    veRef: number;
} {
    const veRef = vernalEquinoxOnOrBefore(REF_EPOCH_SECONDS, null);
    const yearLen = vernalEquinoxAfter(veRef, null) - veRef;

    const ref = analemmaPointFromEotDecl(veRef, REF_LAT_RAD);
    const refAlt = ref.alt;
    const refAz = ref.az;

    const path: AnalemmaPathPoint[] = [];
    for (let d = 0; d < PATH_SAMPLE_COUNT; d++) {
        const di = veRef + (d / PATH_SAMPLE_COUNT) * yearLen;
        const { alt, az } = analemmaPointFromEotDecl(di, REF_LAT_RAD);
        path.push({
            deltaAz: normalizeAngleDelta(az - refAz),
            deltaAlt: alt - refAlt,
        });
    }

    return { path, refAlt, refAz, veRef };
}

/**
 * Map a path parameter (fraction-of-year × PATH_SAMPLE_COUNT, range
 * [0, PATH_SAMPLE_COUNT)) to an (x, y) point in XML coords by linearly
 * interpolating between adjacent points of the closed-loop `pathScaled` array.
 * `pathScaled` is already offset-corrected, so no further offset is applied.
 */
function pathParamToXY(
    pathScaled: [number, number][],
    pathParameter: number,
): [number, number] {
    const n = pathScaled.length;
    if (n === 0) return [0, 0];
    let t = pathParameter % n;
    if (!Number.isFinite(t)) t = 0;
    if (t < 0) t += n;
    const i0 = Math.floor(t);
    const i1 = (i0 + 1) % n;            // wraps last sample → 0 (closed loop)
    const frac = t - i0;
    const [x0, y0] = pathScaled[i0];
    const [x1, y1] = pathScaled[i1];
    return [x0 + (x1 - x0) * frac, y0 + (y1 - y0) * frac];
}

// ============================================================================
// Runtime state
// ============================================================================

export interface AnalemmaState {
    // Geometry (computed once at init)
    path: AnalemmaPathPoint[];
    pathScaled: [number, number][];  // path in XML coords (x, y)
    scaleFactor: number;              // radians → XML coord scaling
    pathOffsetX: number;              // bounding box centering offset (XML coords)
    pathOffsetY: number;
    refAlt: number;
    refAz: number;
    centerX: number;
    centerY: number;
    radius: number;

    // Appearance
    sunRadius: number;
    sunFillColor: string;
    sunStrokeColor: string;
    channelColor: string;
    channelWidth: number;
    bgRotates: boolean;

    // Current state (recomputed each frame from the display time, no interpolation)
    currentPathParameter: number;   // fraction-of-year × PATH_SAMPLE_COUNT, [0, PATH_SAMPLE_COUNT)
    currentRotation: number;

    // ObsValue handles (driven by the per-face Updater; drawAnalemma reads
    // `.currentValue`). Supersede the currentPathParameter/currentRotation path.
    _obsPathParam?: import('../shared/obs-value.js').ObsValue;
    _obsRotation?: import('../shared/obs-value.js').ObsValue;

    // Pre-computed season-tick path indices (fractional), from real crossings
    seasonTicks: { index: number; color: string }[];

    // Scheduling
    updateIntervalSec: number;
    nextUpdateTime: number;  // performance.now() ms

    // Cached rendering
    channelBitmap: OffscreenCanvas | null;  // channel + ticks + overlay, pre-rendered
    bgBitmap: OffscreenCanvas | null;

    // Pre-rendered Sun glyph with shadow (bitmap cache)
    sunBitmap: OffscreenCanvas | null;
    sunBitmapAnchorX: number;  // pivot offset within bitmap (XML coords)
    sunBitmapAnchorY: number;
    sunBitmapW: number;        // bitmap dimensions in XML coords
    sunBitmapH: number;

    // Per-frame scratch for the clipped channel+sun compose (see drawAnalemma)
    _scratchCanvas?: OffscreenCanvas;
}

// ============================================================================
// State expansion (init)
// ============================================================================

/**
 * Expand an AnalemmaPart into runtime state.
 * Called once at init (after XML parsing).
 *
 * Pre-computes the 365-point path, scales it to fit within the disc radius,
 * caches a Path2D for the channel, creates a circular clip of the face
 * background image, and computes initial Sun position and rotation.
 */
export function expandAnalemma(
    part: AnalemmaPart,
    env: Environment,
    images: Map<string, LoadedImage>,
): AnalemmaState {
    const centerX = evalAttr(part.x, env);
    const centerY = evalAttr(part.y, env);
    const radius = evalAttr(part.radius, env) || 40;
    const sunRadius = evalAttr(part.sunRadius, env) || 2.5;
    const sunFillColor = part.sunFillColor ? evalColor(part.sunFillColor, env) : 'rgba(242,228,7,1)';
    const sunStrokeColor = part.sunStrokeColor ? evalColor(part.sunStrokeColor, env) : 'rgba(139,129,75,1)';
    const channelColor = part.channelColor ? evalColor(part.channelColor, env) : 'rgba(0,0,0,1)';
    const channelWidth = evalAttr(part.channelWidth, env) || 0.8;
    const bgRotates = (evalAttr(part.bgRotates, env) || 0) !== 0;
    const updateIntervalSec = evalAttr(part.update, env) || DEFAULT_UPDATE_SEC;

    // Generate the path
    const { path, refAlt, refAz, veRef } = computeAnalemmaPath();

    // Scale the path to fit within the disc.
    // Azimuth is foreshortened by cos(altitude) — a degree of azimuth
    // subtends less sky angle at higher altitudes.  Apply per-point.
    const usableRadius = radius * (1 - PATH_MARGIN_FRACTION);
    let maxAbsX = 0;
    let maxAbsY = 0;
    for (const pt of path) {
        const correctedAz = pt.deltaAz * Math.cos(refAlt + pt.deltaAlt);
        const absX = Math.abs(correctedAz);
        const absY = Math.abs(pt.deltaAlt);
        if (absX > maxAbsX) maxAbsX = absX;
        if (absY > maxAbsY) maxAbsY = absY;
    }
    // Use the same scale for both axes to maintain aspect ratio.
    const maxExtent = Math.max(maxAbsX, maxAbsY);
    const scaleFactor = maxExtent > 0 ? usableRadius / maxExtent : 1;

    // Scale path to XML coords: corrected deltaAz → x, deltaAlt → y
    const pathScaled: [number, number][] = path.map(pt => [
        pt.deltaAz * Math.cos(refAlt + pt.deltaAlt) * scaleFactor,
        pt.deltaAlt * scaleFactor,
    ]);

    // Center the figure-eight within the disc by shifting to bounding box midpoint
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [px, py] of pathScaled) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
    }
    const pathOffsetX = (minX + maxX) / 2;
    const pathOffsetY = (minY + maxY) / 2;
    for (let i = 0; i < pathScaled.length; i++) {
        pathScaled[i][0] -= pathOffsetX;
        pathScaled[i][1] -= pathOffsetY;
    }

    // Build background disc from face image (includes disc border)
    let bgBitmap: OffscreenCanvas | null = null;
    if (part.bgSrc) {
        const loaded = images.get(part.bgSrc);
        if (loaded) {
            bgBitmap = createDiscBackground(loaded.bitmap, loaded.scale, radius);
        }
    }
    if (!bgBitmap) {
        // No background image — create a simple dark disc with border
        bgBitmap = createFallbackDiscBackground(radius);
    }

    // Build pre-rendered Sun glyph + shadow bitmap
    const { bitmap: sunBitmap, anchorX: sunAnchorX, anchorY: sunAnchorY, w: sunW, h: sunH } =
        buildSunBitmap(sunRadius, sunFillColor, sunStrokeColor);

    // Season-tick path indices from the real solstice/equinox crossings
    const seasonTicks = computeSeasonTicks(veRef);

    // Build pre-rendered channel + season ticks + dark overlay bitmap
    const channelBitmap = buildChannelBitmap(
        pathScaled, radius, channelColor, channelWidth, seasonTicks,
    );

    const state: AnalemmaState = {
        path,
        pathScaled,
        scaleFactor,
        pathOffsetX,
        pathOffsetY,
        refAlt,
        refAz,
        centerX,
        centerY,
        radius,
        sunRadius,
        sunFillColor,
        sunStrokeColor,
        channelColor,
        channelWidth,
        bgRotates,
        currentPathParameter: 0,
        currentRotation: 0,
        seasonTicks,
        updateIntervalSec,
        nextUpdateTime: 0,
        channelBitmap,
        bgBitmap,
        sunBitmap,
        sunBitmapAnchorX: sunAnchorX,
        sunBitmapAnchorY: sunAnchorY,
        sunBitmapW: sunW,
        sunBitmapH: sunH,
    };

    // Compute initial position
    updateAnalemmaValues(state, env);

    return state;
}

/**
 * Build a Path2D from the scaled path points.
 * The path is drawn as a closed loop (day 0 → day 364 → back to day 0).
 */
function buildChannelPath2D(pathScaled: [number, number][]): Path2D {
    const p = new Path2D();
    if (pathScaled.length === 0) return p;
    p.moveTo(pathScaled[0][0], -pathScaled[0][1]);  // negate Y for canvas
    for (let i = 1; i < pathScaled.length; i++) {
        p.lineTo(pathScaled[i][0], -pathScaled[i][1]);
    }
    p.closePath();
    return p;
}

/**
 * Pre-render the channel path + season ticks + dark overlay onto a single
 * OffscreenCanvas. This bitmap is blitted rotated per-frame, avoiding
 * per-frame Path2D stroking and fillRect calls.
 *
 * The bitmap covers a 2*radius square centered at (0,0) in XML coords.
 */
function buildChannelBitmap(
    pathScaled: [number, number][],
    radius: number,
    channelColor: string,
    channelWidth: number,
    seasonTicks: { index: number; color: string }[],
): OffscreenCanvas {
    const scale = 4;  // 4x resolution for quality
    const size = radius * 2;
    const pxSize = Math.ceil(size * scale);
    const canvas = new OffscreenCanvas(pxSize, pxSize);
    const ctx = canvas.getContext('2d')!;

    ctx.scale(scale, scale);
    // Origin at center of the bitmap
    ctx.translate(radius, radius);

    // --- Dark overlay ---
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.09)';
    ctx.fill();

    // --- Channel path ---
    const channelPath = buildChannelPath2D(pathScaled);
    ctx.strokeStyle = channelColor;
    ctx.lineWidth = channelWidth;
    ctx.lineJoin = 'round';
    ctx.stroke(channelPath);

    // --- Season ticks ---
    const tickLen = 2;
    const tickAlong = 0.5;
    const gap = channelWidth / 2;

    for (const { index, color } of seasonTicks) {
        const idx = ((Math.round(index) % pathScaled.length) + pathScaled.length) % pathScaled.length;
        const [px, py] = pathScaled[idx];

        const prev = (idx - 1 + pathScaled.length) % pathScaled.length;
        const next = (idx + 1) % pathScaled.length;
        const dx = pathScaled[next][0] - pathScaled[prev][0];
        const dy = pathScaled[next][1] - pathScaled[prev][1];
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) continue;

        const tx = dx / len;
        const ty = dy / len;
        const nx = -ty;
        const ny = tx;

        ctx.fillStyle = color;

        for (const side of [1, -1]) {
            const innerX = px + side * nx * gap;
            const innerY = py + side * ny * gap;
            const outerX = px + side * nx * (gap + tickLen);
            const outerY = py + side * ny * (gap + tickLen);
            const midX = (innerX + outerX) / 2;
            const midY = (innerY + outerY) / 2;

            ctx.save();
            ctx.translate(midX, -midY);
            ctx.rotate(-Math.atan2(ty, tx));
            ctx.fillRect(-tickAlong, -tickLen / 2, tickAlong * 2, tickLen);
            ctx.restore();
        }
    }

    return canvas;
}

/**
 * Pre-render the Sun glyph with a drop shadow onto an OffscreenCanvas.
 * Returns the bitmap and layout info for blitting at runtime.
 * The bitmap is at a fixed 8x resolution for quality.
 */
function buildSunBitmap(
    sunRadius: number,
    fillColor: string,
    strokeColor: string,
): { bitmap: OffscreenCanvas; anchorX: number; anchorY: number; w: number; h: number } {
    // Shadow parameters (in XML coords)
    const shadowBlur = 1.5;
    const shadowOffsetX = 0.5;
    const shadowOffsetY = 0.5;
    const shadowPad = shadowBlur * 3 + Math.max(Math.abs(shadowOffsetX), Math.abs(shadowOffsetY));

    // Total extent in XML coords: Sun radius + stroke + shadow padding
    const extent = sunRadius + 0.5 + shadowPad;
    const w = extent * 2;
    const h = extent * 2;

    // Bitmap at 8x resolution
    const scale = 8;
    const pxW = Math.ceil(w * scale);
    const pxH = Math.ceil(h * scale);
    const canvas = new OffscreenCanvas(pxW, pxH);
    const ctx = canvas.getContext('2d')!;

    ctx.scale(scale, scale);

    // Set up shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = shadowBlur * scale;  // shadowBlur is in pixel space
    ctx.shadowOffsetX = shadowOffsetX * scale;
    ctx.shadowOffsetY = shadowOffsetY * scale;

    // Draw Sun glyph centered in the bitmap
    drawSunGlyph(ctx, extent, extent, sunRadius, fillColor, strokeColor);

    return {
        bitmap: canvas,
        anchorX: extent,   // pivot is at center
        anchorY: extent,
        w,
        h,
    };
}

/**
 * Create a circular clip of the face background image, scaled to fit
 * within the analemma disc radius.
 */
function createDiscBackground(
    faceImage: ImageBitmap,
    faceImageScale: number,
    discRadius: number,
): OffscreenCanvas {
    // The face image covers the full face; we want a circular clip centered
    // at the disc position. For simplicity, we scale the entire face image
    // down to fit within 2*discRadius and clip to a circle.
    const size = Math.ceil(discRadius * 2);
    // Use a reasonable pixel resolution
    const pxSize = Math.ceil(size * 4);  // 4x for quality
    const canvas = new OffscreenCanvas(pxSize, pxSize);
    const ctx = canvas.getContext('2d')!;

    // Clip to circle
    ctx.beginPath();
    ctx.arc(pxSize / 2, pxSize / 2, pxSize / 2, 0, Math.PI * 2);
    ctx.clip();

    // Scale the face image to fit — the face image covers faceWidth which is
    // typically ~280 XML units. We want to show the portion corresponding
    // to our disc within the face.
    const imgW = faceImage.width * faceImageScale;
    const imgH = faceImage.height * faceImageScale;
    const drawScale = pxSize / (discRadius * 2);

    // Draw the face image centered: the face center maps to the disc center.
    // The face image center is at (imgW/2, imgH/2) in image coords.
    ctx.save();
    ctx.translate(pxSize / 2, pxSize / 2);
    ctx.scale(drawScale, drawScale);
    // Draw at (-imgW/2, -imgH/2) so the center of the face image is at the center
    ctx.drawImage(faceImage, -imgW / 2, -imgH / 2, imgW, imgH);
    ctx.restore();

    // Draw disc border on top (non-rotating, so baked into the background)
    ctx.beginPath();
    ctx.arc(pxSize / 2, pxSize / 2, pxSize / 2 - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 2;  // in pixel space (4x scale)
    ctx.stroke();

    return canvas;
}

/**
 * Create a simple fallback disc background (dark tinted circle with border)
 * when no face image is available.
 */
function createFallbackDiscBackground(discRadius: number): OffscreenCanvas {
    const size = Math.ceil(discRadius * 2);
    const pxSize = Math.ceil(size * 4);
    const canvas = new OffscreenCanvas(pxSize, pxSize);
    const ctx = canvas.getContext('2d')!;

    // Dark fill
    ctx.beginPath();
    ctx.arc(pxSize / 2, pxSize / 2, pxSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fill();

    // Border
    ctx.beginPath();
    ctx.arc(pxSize / 2, pxSize / 2, pxSize / 2 - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();

    return canvas;
}

// ============================================================================
// Update (no animation — direct value setting)
// ============================================================================

/**
 * Recompute the Sun's position and rotation from the current environment.
 * Called when the update interval expires.
 */
function updateAnalemmaValues(state: AnalemmaState, env: Environment): void {
    const getNow = env.getNow;
    if (!getNow) return;

    const now = getNow();
    const di = dateToDateInterval(now);

    // --- Sun position within the analemma (parametric) ---
    // The path parameter is the fraction through the current vernal-equinox year
    // (anchored to the real bracketing equinoxes, so exact at any epoch), scaled
    // to the path's sample domain. It is a continuous function of the display
    // instant `di`, so the marker advances smoothly along the figure as time
    // changes — which is what lets the Phase 8 ObsValue animate it. The marker
    // (x, y) is derived from this parameter at draw time.
    state.currentPathParameter = fractionOfVernalEquinoxYear(di, null) * PATH_SAMPLE_COUNT;

    // --- Rotation (at observer's actual location/time) ---
    const obsLat = env.observerLatRad ?? 0;
    const obsLon = env.observerLonRad ?? 0;
    state.currentRotation = sunSkyOrientationAngle(di, obsLat, obsLon, null);
}

// ============================================================================
// Drawing
// ============================================================================

/**
 * Draw a sun glyph (disc + triangular rays), matching the 'sun' hand type
 * rendering used by Mauna Kea and other faces.
 *
 * @param ctx - Canvas context, already positioned at the sun's center
 * @param radius - Overall radius of the sun glyph (tips of rays)
 * @param fillColor - Fill color for both disc and rays
 * @param strokeColor - Stroke color
 * @param nRays - Number of rays (default 8)
 */
function drawSunGlyph(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    fillColor: string,
    strokeColor: string,
    nRays: number = 8,
): void {
    const innerRadius = radius * 0.5;   // central disc radius
    const rayTip = radius;               // tip of rays

    ctx.fillStyle = fillColor;

    // Draw rays + central disc as a single path to avoid double-fill overlap
    ctx.beginPath();
    for (let i = 0; i < nRays; i++) {
        const theta = 2 * Math.PI * i / nRays;
        const tipX = cx + rayTip * Math.cos(theta);
        const tipY = cy + rayTip * Math.sin(theta);
        const cwX = cx + innerRadius * Math.cos(theta + Math.PI / nRays);
        const cwY = cy + innerRadius * Math.sin(theta + Math.PI / nRays);
        const ccwX = cx + innerRadius * Math.cos(theta - Math.PI / nRays);
        const ccwY = cy + innerRadius * Math.sin(theta - Math.PI / nRays);

        ctx.moveTo(tipX, tipY);
        ctx.lineTo(cwX, cwY);
        ctx.lineTo(ccwX, ccwY);
        ctx.closePath();
    }
    ctx.arc(cx, cy, innerRadius, 0, 2 * Math.PI);
    ctx.fill();
}

/** Mean tropical year in seconds — only to seed the season-tick crossing search. */
const MEAN_TROPICAL_YEAR_SECONDS = 365.2421897 * 86400;

/**
 * Season markers: apparent ecliptic longitude of the Sun (radians) and color
 * for each equinox/solstice. Their path positions are computed from the real
 * crossing times (seasons are unequal lengths), not assumed quarter-points.
 */
const SEASON_TARGETS: { longitude: number; color: string }[] = [
    { longitude: 0,              color: '#22aa22' },  // Vernal equinox — green
    { longitude: Math.PI / 2,    color: '#ddcc00' },  // Summer solstice — yellow
    { longitude: Math.PI,        color: '#ee7722' },  // Autumnal equinox — orange
    { longitude: 3 * Math.PI / 2, color: '#2266cc' }, // Winter solstice — blue
];

/**
 * Compute the (fractional) path index of each season marker from the real
 * solstice/equinox crossing times in the reference year `[veRef, veRef+yearLen)`.
 * `tickParam = PATH_SAMPLE_COUNT × fractionOfVernalEquinoxYear(crossing)`.
 */
function computeSeasonTicks(veRef: number): { index: number; color: string }[] {
    return SEASON_TARGETS.map(({ longitude, color }) => {
        // Seed the crossing search near the expected fraction of the year.
        const approx = veRef + (longitude / (2 * Math.PI)) * MEAN_TROPICAL_YEAR_SECONDS;
        const crossing = solarLongitudeCrossingTime(longitude, approx, null);
        const frac = fractionOfVernalEquinoxYear(crossing, null);
        return { index: frac * PATH_SAMPLE_COUNT, color };
    });
}

/**
 * Draw the analemma onto the canvas.
 *
 * All static elements (background, dark overlay, channel path, season ticks,
 * disc border) are pre-rendered into bitmaps at init time. Per-frame work is
 * just three drawImage() calls plus one arc stroke:
 *
 * 1. Background disc bitmap (optionally non-rotating)
 * 2. Channel+ticks bitmap (rotated)
 * 3. Sun marker bitmap (rotated)
 * 4. Disc border stroke
 */
export function drawAnalemma(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    state: AnalemmaState,
): void {
    const { centerX, centerY, radius, bgRotates } = state;
    // The per-face Updater drives these; fall back to the directly-computed values
    // (updateAnalemmaValues) before the first tick / on the static path.
    const currentRotation = state._obsRotation ? state._obsRotation.currentValue : state.currentRotation;
    const pathParameter = state._obsPathParam ? state._obsPathParam.currentValue : state.currentPathParameter;

    ctx.save();

    // Translate to disc center (negate Y for canvas coords)
    ctx.translate(centerX, -centerY);

    // --- Background disc (includes border) ---
    if (state.bgBitmap) {
        if (bgRotates) {
            ctx.save();
            ctx.rotate(currentRotation);
            drawBackground(ctx, state);
            ctx.restore();
        } else {
            drawBackground(ctx, state);
        }
    }

    // --- Clipped channel + sun compose ---
    // Composed in a small disc-sized scratch canvas and blitted once, instead
    // of clip()ing the destination: keeps the destination's op stream short
    // and makes the arc-clip cost independent of the destination canvas
    // (relevant to the ?ablate=onecanvas shared-canvas prototype).
    const m = ctx.getTransform();
    const devScale = Math.hypot(m.a, m.b) || 1;
    const pxSize = Math.max(2, Math.ceil(radius * 2 * devScale));
    let scratch = state._scratchCanvas;
    if (!scratch || scratch.width !== pxSize || scratch.height !== pxSize) {
        scratch = new OffscreenCanvas(pxSize, pxSize);
        state._scratchCanvas = scratch;
    }
    const sctx = scratch.getContext('2d')!;
    sctx.resetTransform();
    sctx.clearRect(0, 0, pxSize, pxSize);
    sctx.save();
    sctx.translate(pxSize / 2, pxSize / 2);
    sctx.scale(devScale, devScale);
    sctx.beginPath();
    sctx.arc(0, 0, radius, 0, Math.PI * 2);
    sctx.clip();

    // --- Pre-rendered channel + ticks + overlay (rotated) ---
    sctx.rotate(currentRotation);
    if (state.channelBitmap) {
        sctx.drawImage(state.channelBitmap, -radius, -radius, radius * 2, radius * 2);
    }

    // --- Sun marker (pre-rendered bitmap with shadow) ---
    if (state.sunBitmap) {
        const [sunX, sunY] = pathParamToXY(state.pathScaled, pathParameter);
        sctx.drawImage(
            state.sunBitmap,
            sunX - state.sunBitmapAnchorX,
            -sunY - state.sunBitmapAnchorY,
            state.sunBitmapW,
            state.sunBitmapH,
        );
    }
    sctx.restore();

    ctx.drawImage(scratch, -radius, -radius, radius * 2, radius * 2);

    ctx.restore();  // undo translate
}

/** Draw the clipped background image at the disc center. */
function drawBackground(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    state: AnalemmaState,
): void {
    if (!state.bgBitmap) return;
    const { radius } = state;
    const bmp = state.bgBitmap;
    // Draw the cached circular background centered at (0, 0)
    ctx.drawImage(bmp, -radius, -radius, radius * 2, radius * 2);
}
