/**
 * Earth map view with day/night terminator for Observatory.
 *
 * Architecture:
 *   1. Altitude table (Int16 binary, 681 KB) loaded at startup via data URL.
 *   2. Blue Marble day images (12 months) + night image loaded from .observatory-ref.
 *   3. Night mask generated as OffscreenCanvas when sslat changes.
 *   4. Per-frame: night → day → shifted mask → observer dot.
 *
 * Port of ESGLPartEarthMapNightMask / ESGLPartMoverEarthMapNightMask / ESGLPartMoverEarthMapDayImage
 * from .esgl-ref/src/.
 */

// @ts-ignore — esbuild resolves .bin as data URL via --loader:.bin=dataurl
import altitudeTableDataUrl from './data/altitude-table.bin';

// Blue Marble monthly day images (@2x) — shared assets for both
// Observatory earth view and mini-map globe
// @ts-ignore
import month01 from '../shared/assets/blue-marble/01@2x.png';
// @ts-ignore
import month02 from '../shared/assets/blue-marble/02@2x.png';
// @ts-ignore
import month03 from '../shared/assets/blue-marble/03@2x.png';
// @ts-ignore
import month04 from '../shared/assets/blue-marble/04@2x.png';
// @ts-ignore
import month05 from '../shared/assets/blue-marble/05@2x.png';
// @ts-ignore
import month06 from '../shared/assets/blue-marble/06@2x.png';
// @ts-ignore
import month07 from '../shared/assets/blue-marble/07@2x.png';
// @ts-ignore
import month08 from '../shared/assets/blue-marble/08@2x.png';
// @ts-ignore
import month09 from '../shared/assets/blue-marble/09@2x.png';
// @ts-ignore
import month10 from '../shared/assets/blue-marble/10@2x.png';
// @ts-ignore
import month11 from '../shared/assets/blue-marble/11@2x.png';
// @ts-ignore
import month12 from '../shared/assets/blue-marble/12@2x.png';
// @ts-ignore
import nightDataUrl from '../shared/assets/blue-marble/night@4x.jpg';

import type { LayoutParams } from './layout.js';
import type { ObsValueName } from './obs-values.js';
import type { Updater } from '../shared/updater.js';

// ============================================================================
// Table constants — must match generate-altitude-table.ts
// ============================================================================

const SS_STEPS = 100;
const SS_SLOTS = SS_STEPS + 1;   // 101

const LAT_STEPS = 149;
const LAT_SLOTS = LAT_STEPS + 1; // 150

const ALT_STEPS = 22;
const ALT_SLOTS = ALT_STEPS + 1; // 23

const SS_MAX = 24 * Math.PI / 180;
const SS_MIN = 0;
const SS_RANGE = SS_MAX - SS_MIN;

const INT16_DECODE = Math.PI / 32767;

// ============================================================================
// Module state
// ============================================================================

/** The altitude lookup table, decoded from Int16 to Float32. */
let table: Float32Array | null = null;

/** Per-month day images. Index 0 = January, 11 = December. */
const dayImages: HTMLImageElement[] = [];
let nightImage: HTMLImageElement | null = null;

/** Currently displayed month (0-based). */
let currentMonth = -1;
let currentDayImage: HTMLImageElement | null = null;

/** Night mask state — regenerated when sslat or dimensions change. */
let maskCanvas: OffscreenCanvas | null = null;
let maskCtx: OffscreenCanvasRenderingContext2D | null = null;
let lastMaskSslat = NaN;
let lastMaskWidth = 0;
let lastMaskHeight = 0;

/**
 * Scratch canvas for compositing the day image with the shifted night mask.
 * Reused across frames (resized only when dimensions change) to avoid
 * allocating a fresh OffscreenCanvas every frame.
 */
let dayMaskCanvas: OffscreenCanvas | null = null;
let dayMaskCtx: OffscreenCanvasRenderingContext2D | null = null;

/** Flag for images loaded. */
let imagesReady = false;
let tableReady = false;

// ============================================================================
// Initialization
// ============================================================================

/** Load the altitude table from its data URL. */
function loadAltitudeTable(): void {
    // Decode data URL to ArrayBuffer
    const base64 = (altitudeTableDataUrl as string).split(',')[1];
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }
    const int16 = new Int16Array(bytes.buffer);

    // Decode Int16 → Float32
    table = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
        table[i] = int16[i] * INT16_DECODE;
    }
    tableReady = true;
}

/** Load a single image from a data URL. */
function loadImage(dataUrl: string): HTMLImageElement {
    const img = new Image();
    img.src = dataUrl;
    return img;
}

/** Initialize all images and the altitude table. */
export function initEarthView(): void {
    loadAltitudeTable();

    const monthUrls = [
        month01, month02, month03, month04, month05, month06,
        month07, month08, month09, month10, month11, month12,
    ] as string[];

    for (const url of monthUrls) {
        dayImages.push(loadImage(url));
    }
    nightImage = loadImage(nightDataUrl as string);

    // Mark ready once all images decode
    const allImgs = [...dayImages, nightImage];
    Promise.all(allImgs.map(img =>
        img.decode ? img.decode().catch(() => {}) : Promise.resolve()
    )).then(() => {
        imagesReady = true;
    });
}

// ============================================================================
// Altitude table lookup — port of ESSunAltitudeTable::interpolateRowData()
// ============================================================================

/**
 * Temporary buffer for one row of altitude data (23 longitude offsets).
 * Reused across calls to avoid allocation.
 */
const rowBuffer = new Float32Array(ALT_SLOTS);

/**
 * Port of ESSunAltitudeTable::interpolateRowData().
 * Returns 23 longitude offsets for a given subsolar latitude and latitude index.
 *
 * When sslat < 0, flips the latitude index (the table only stores positive sslat).
 */
function interpolateRowData(
    subsolarLatitude: number,
    mapLatitudeIndex: number,
): Float32Array {
    if (!table) return rowBuffer;

    let flipLatitude = false;
    let sslat = subsolarLatitude;
    if (sslat < 0) {
        flipLatitude = true;
        sslat = -sslat;
    }

    // Compute the two bracketing subsolar indices
    const ssLatIndexD = (sslat - SS_MIN) * SS_STEPS / SS_RANGE;
    const beforeIndex = Math.floor(ssLatIndexD);
    const afterIndex = Math.ceil(ssLatIndexD);

    // Clamp to valid range
    const bi = Math.max(0, Math.min(SS_STEPS, beforeIndex));
    const ai = Math.max(0, Math.min(SS_STEPS, afterIndex));

    // When sslat is negative, flip the latitude index
    let latIdx = mapLatitudeIndex;
    if (flipLatitude) {
        latIdx = LAT_STEPS - mapLatitudeIndex;
    }

    // Compute offsets into the flat table
    const beforeOffset = bi * LAT_SLOTS * ALT_SLOTS + latIdx * ALT_SLOTS;
    const afterOffset = ai * LAT_SLOTS * ALT_SLOTS + latIdx * ALT_SLOTS;

    // Average the two bracketing pages (simple linear interpolation at midpoint)
    for (let i = 0; i < ALT_SLOTS; i++) {
        rowBuffer[i] = (table[beforeOffset + i] + table[afterOffset + i]) / 2;
    }

    return rowBuffer;
}

// ============================================================================
// Night mask generation
// ============================================================================

/**
 * Generate the night mask bitmap for a given sub-solar latitude.
 *
 * The mask is centered at the sub-solar meridian (x = width/2).
 * Each pixel's alpha channel represents the nighttime opacity:
 *   - 0 = fully day (transparent)
 *   - 255 = fully night (opaque black)
 *   - Intermediate = twilight gradient
 *
 * The mask is later shifted horizontally by sslng during the draw pass.
 */
function regenerateNightMask(sslat: number, w: number, h: number): void {
    if (!table) return;

    // Create/resize the offscreen canvas
    if (!maskCanvas || lastMaskWidth !== w || lastMaskHeight !== h) {
        maskCanvas = new OffscreenCanvas(w, h);
        maskCtx = maskCanvas.getContext('2d')!;
    }

    const imgData = maskCtx!.createImageData(w, h);
    const data = imgData.data;

    for (let py = 0; py < h; py++) {
        // Map pixel y to latitude index
        // py=0 → north pole (+90°), py=h-1 → south pole (-90°)
        const latFrac = py / (h - 1);  // 0 at top (north), 1 at bottom (south)
        const latIndexF = (1 - latFrac) * LAT_STEPS;  // LAT_STEPS at top, 0 at bottom
        const latIndex = Math.round(latIndexF);

        // Get the row data (23 longitude offsets) for this latitude
        const row = interpolateRowData(sslat, latIndex);

        for (let px = 0; px < w; px++) {
            // Map pixel x to longitude offset from center
            // Center of mask = sub-solar meridian
            const xFrac = px / (w - 1);         // 0 at left, 1 at right
            const lngOffset = (xFrac - 0.5) * 2 * Math.PI;  // [-π, π]
            const absOffset = Math.abs(lngOffset);

            // Determine alpha from the altitude bands
            let alpha: number;

            if (absOffset < row[0]) {
                // Full day (sun above horizon)
                alpha = 0;
            } else if (absOffset >= row[ALT_SLOTS - 1]) {
                // Full night (sun below all altitude thresholds)
                alpha = 255;
            } else {
                // Find which band we're in and interpolate
                let band = 0;
                for (let i = 1; i < ALT_SLOTS; i++) {
                    if (absOffset < row[i]) {
                        band = i;
                        break;
                    }
                }

                // Interpolate within the band
                const lo = row[band - 1];
                const hi = row[band];
                const t = (hi > lo) ? (absOffset - lo) / (hi - lo) : 0;
                // Band 0→1 maps to first opacity step, etc.
                // Scale to [0, 255] across all bands
                const alphaFrac = (band - 1 + t) / ALT_STEPS;
                alpha = Math.round(alphaFrac * 255);
            }

            const idx = (py * w + px) * 4;
            data[idx] = 0;       // R
            data[idx + 1] = 0;   // G
            data[idx + 2] = 0;   // B
            data[idx + 3] = alpha;
        }
    }

    maskCtx!.putImageData(imgData, 0, 0);
    lastMaskSslat = sslat;
    lastMaskWidth = w;
    lastMaskHeight = h;
}

// ============================================================================
// Hit testing and coordinate conversion
// ============================================================================

/** Test whether CSS-pixel coordinates fall inside the earth map rectangle. */
export function isInsideEarthMap(cssX: number, cssY: number, L: LayoutParams): boolean {
    const ex = L.earthCX - L.earthW / 2;
    const ey = L.earthCY - L.earthH / 2;
    return cssX >= ex && cssX <= ex + L.earthW
        && cssY >= ey && cssY <= ey + L.earthH;
}

/**
 * Convert CSS-pixel coordinates on the canvas to geographic lat/lon.
 * Inverse of the observer-dot Mercator formula used in drawEarthView.
 * Clamped to valid ranges.
 */
export function earthPixelToLatLon(
    cssX: number, cssY: number, L: LayoutParams,
): { lat: number; lon: number } {
    const ex = L.earthCX - L.earthW / 2;
    const ey = L.earthCY - L.earthH / 2;
    const lon = Math.max(-180, Math.min(180, (cssX - ex) / L.earthW * 360 - 180));
    const lat = Math.max(-90, Math.min(90, 90 - (cssY - ey) / L.earthH * 180));
    return { lat, lon };
}

// ============================================================================
// Drag crosshair
// ============================================================================

/**
 * Draw a 1px crosshair at the given lat/lon on the earth map.
 * Used during drag-to-explore to show the rendered (temporary) location.
 * Clipped to the earth map rectangle.
 */
export function drawDragCrosshair(
    ctx: CanvasRenderingContext2D, L: LayoutParams,
    renderLat: number, renderLon: number,
): void {
    const ex = L.earthCX - L.earthW / 2;
    const ey = L.earthCY - L.earthH / 2;
    // Forward Mercator (same as observer dot)
    const crossX = ex + (renderLon + 180) / 360 * L.earthW;
    const crossY = ey + (90 - renderLat) / 180 * L.earthH;
    ctx.save();
    ctx.beginPath();
    ctx.rect(ex, ey, L.earthW, L.earthH);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
    ctx.lineWidth = 1 / (L.dpr || 1);  // 1 CSS pixel
    ctx.beginPath();
    ctx.moveTo(ex, crossY); ctx.lineTo(ex + L.earthW, crossY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(crossX, ey); ctx.lineTo(crossX, ey + L.earthH);
    ctx.stroke();
    ctx.restore();
}

// ============================================================================
// Drawing
// ============================================================================

/**
 * Draw the earth view into the main canvas.
 *
 * Called from observatory-entry.ts drawFrame().
 * Reads animated values from the Updater for smooth scrubbing.
 *
 * @param ctx             Main canvas 2D context
 * @param L               Layout params (earthCX, earthCY, earthW, earthH, dpr)
 * @param u               Observatory animated value updater
 * @param observerLat     Observer latitude in degrees (north positive)
 * @param observerLon     Observer longitude in degrees (west negative)
 * @param getNow          Time source (for month selection)
 * @param dotOverrideLat  If provided, draw the observer dot at this lat instead of observerLat
 * @param dotOverrideLon  If provided, draw the observer dot at this lon instead of observerLon
 */
export function drawEarthView(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
    u: Updater<ObsValueName>,
    observerLat: number,
    observerLon: number,
    getNow: () => Date,
    dotOverrideLat?: number,
    dotOverrideLon?: number,
): void {
    if (!imagesReady || !tableReady) return;

    const sslat = u.get('earthSslat').currentValue;
    const sslng = u.get('earthSslng').currentValue;

    // Physical pixel dimensions (accounting for device pixel ratio)
    const physW = Math.round(L.earthW * L.dpr);
    const physH = Math.round(L.earthH * L.dpr);

    if (physW <= 0 || physH <= 0) return;

    // ── 1. Select month image ──
    const now = getNow();
    const month = now.getMonth();  // 0-based
    if (month !== currentMonth || !currentDayImage) {
        currentMonth = month;
        currentDayImage = dayImages[month] || dayImages[0];
    }

    // ── 2. Regenerate mask if needed ──
    if (sslat !== lastMaskSslat || physW !== lastMaskWidth || physH !== lastMaskHeight) {
        regenerateNightMask(sslat, physW, physH);
    }

    // ── 3. Draw into the earth region ──
    const ex = L.earthCX - L.earthW / 2;
    const ey = L.earthCY - L.earthH / 2;

    ctx.save();

    // Clip to the earth rectangle
    ctx.beginPath();
    ctx.rect(ex, ey, L.earthW, L.earthH);
    ctx.clip();

    // 3a. Draw night image (fills entire rectangle)
    if (nightImage && nightImage.complete) {
        ctx.drawImage(nightImage, ex, ey, L.earthW, L.earthH);
    } else {
        // Fallback: dark background
        ctx.fillStyle = '#0a0a14';
        ctx.fillRect(ex, ey, L.earthW, L.earthH);
    }

    // 3b. Draw day image (will be revealed through the mask)
    // We need to composite: day image visible where mask is transparent.
    // Strategy: draw day image on a scratch canvas, apply mask, then draw to main.
    // The scratch canvas is reused across frames (recreated only on resize).
    if (!dayMaskCanvas || dayMaskCanvas.width !== physW || dayMaskCanvas.height !== physH) {
        dayMaskCanvas = new OffscreenCanvas(physW, physH);
        dayMaskCtx = dayMaskCanvas.getContext('2d')!;
    }

    // Clear any content from the previous frame before recompositing.
    dayMaskCtx!.clearRect(0, 0, physW, physH);

    // Draw day image scaled to fill
    if (currentDayImage && currentDayImage.complete) {
        dayMaskCtx!.drawImage(currentDayImage, 0, 0, physW, physH);
    }

    // Apply the shifted mask: punch out the night regions
    // The mask has day=transparent, night=opaque black.
    // We use 'destination-out' to remove pixels where the mask is opaque.
    // This means the day image remains where it's day, and is removed where it's night.
    if (maskCanvas) {
        dayMaskCtx!.globalCompositeOperation = 'destination-out';

        // Compute pixel shift from sslng
        // sslng = longitude where sun is overhead, in [-π, π]
        // The mask has its bright center at x=width/2 (longitude 0, Greenwich).
        // We need to shift the mask so that its center aligns with sslng:
        //   sslng = 0 → no shift (sun at Greenwich, mask center at image center)
        //   sslng > 0 → shift right (sun east of Greenwich)
        //   sslng < 0 → shift left (sun west of Greenwich)
        const shiftFrac = sslng / (2 * Math.PI);
        // Round to integer to avoid sub-pixel anti-aliasing at the seam
        // where the two wrapped mask copies meet.
        // Normalize to [0, physW) to handle animation overshoot past 2π.
        let dx = Math.round(shiftFrac * physW);
        dx = ((dx % physW) + physW) % physW;

        // Draw mask with wrapping (two drawImage calls)
        dayMaskCtx!.drawImage(maskCanvas, dx, 0);
        if (dx > 0) {
            dayMaskCtx!.drawImage(maskCanvas, dx - physW, 0);
        } else {
            dayMaskCtx!.drawImage(maskCanvas, dx + physW, 0);
        }

        dayMaskCtx!.globalCompositeOperation = 'source-over';
    }

    // Draw the composited day-with-mask onto the main canvas (over the night)
    ctx.drawImage(dayMaskCanvas!, ex, ey, L.earthW, L.earthH);

    // ── 4. Observer dot ──
    // During drag-to-explore the dot stays at the saved (home) location,
    // passed via dotOverrideLat/Lon; otherwise it tracks the observer.
    const dotLat = dotOverrideLat ?? observerLat;
    const dotLon = dotOverrideLon ?? observerLon;
    const dotX = ex + (dotLon + 180) / 360 * L.earthW;
    const dotY = ey + (90 - dotLat) / 180 * L.earthH;

    ctx.fillStyle = '#ff3333';
    ctx.beginPath();
    const dotR = Math.max(2, L.earthW * 0.008);
    ctx.arc(dotX, dotY, dotR, 0, 2 * Math.PI);
    ctx.fill();

    // Subtle white outline for visibility
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();
}
