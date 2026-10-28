/**
 * Observatory starfield background — static base layer.
 *
 * Port of: EOBaseView.drawRect: (EOBaseView.mm L20–51), which draws
 * background.png (a 768×1024-pt starfield) under the whole clock, rotating
 * it 90° in landscape so the image's long axis follows the viewport's.
 *
 * The web version draws the starfield procedurally instead of from the image
 * (which decoded to 12.6 MB and was 2–4× upscaled on a 4K panel): a fixed
 * virtual sky, SKY_PX square in device pixels and centred on the window, is
 * populated at the image's star density by one pseudo-random sequence, and
 * each star is drawn as a pixel-integrated Gaussian whose width, brightness
 * and tint are sampled from the image's own measured stars
 * (starfield-profiles.ts) at the size they had on a 1280×800 screen. So:
 *
 *   - stars are the same pixel size on every screen (never upscaled);
 *   - the count follows the window's area (≈ 290 per megapixel: 300 on a
 *     1280×800 window, 2400 on a 4K panel) — a bigger window shows more of
 *     the same sky, and a star keeps its place when the window resizes;
 *   - the output is a pure function of (viewW·dpr, viewH·dpr), which
 *     static-cache.ts relies on when fixUpSunRegion repaints the patch under
 *     the sun.
 *
 * Nothing is stored for stars outside the window: the sequence is run in
 * full (≈ 19 000 draws, well under a millisecond) and off-window stars are
 * skipped. Drawn into the merged static cache (static-cache.ts) at DPR
 * resolution; rebuilt only on resize.
 */

import type { LayoutParams } from './layout.js';
import { STAR_PROFILES, STAR_IMAGE_W, STAR_IMAGE_H } from './starfield-profiles.js';

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/** Side of the virtual sky, device px. Covers a 4K panel at 2× (7680×4320). */
export const SKY_PX = 8192;
/** Fixed seed: the same sky every load. */
const SKY_SEED = 20261025;
/**
 * The cover scale the image had on a 1280×800 window (max(800/1536,
 * 1280/2048)): star sizes and density are frozen at that reference, in
 * device px, for every window.
 */
const REF_K = 0.625;
/** Stars per device px²: the image's density, at the reference scale. */
export const STAR_DENSITY = STAR_PROFILES.length / (STAR_IMAGE_W * STAR_IMAGE_H) / (REF_K * REF_K);
/** Stars in the whole virtual sky. */
const SKY_STAR_COUNT = Math.round(STAR_DENSITY * SKY_PX * SKY_PX);
/** Margin (device px) beyond the window inside which a star still gets drawn. */
const EDGE_MARGIN = 8;
/** Narrowest Gaussian drawn (device px); the image's smallest stars are ~0.3. */
const MIN_SIGMA = 0.35;

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/** mulberry32: a small, fast 32-bit PRNG with a decent spectrum. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export interface Star {
    /** Device px within the window (sub-pixel). */
    x: number;
    y: number;
    /** Gaussian width, device px. */
    sigma: number;
    /** Integrated luminance, 8-bit units. */
    flux: number;
    /** Red and blue as a fraction of luminance. */
    red: number;
    blue: number;
}

/**
 * The stars that fall inside a w×h device-px window centred on the virtual
 * sky. Deterministic: the same (w, h) always yields the same list, and a
 * star visible in a smaller window is at the same place, shifted by half
 * the size difference, in a larger one.
 */
export function generateStars(w: number, h: number): Star[] {
    const rnd = mulberry32(SKY_SEED);
    const ox = w / 2 - SKY_PX / 2;
    const oy = h / 2 - SKY_PX / 2;
    const n = STAR_PROFILES.length;
    const stars: Star[] = [];
    for (let i = 0; i < SKY_STAR_COUNT; i++) {
        const u = rnd();
        const v = rnd();
        const j = Math.floor(rnd() * n);
        const x = u * SKY_PX + ox;
        const y = v * SKY_PX + oy;
        if (x < -EDGE_MARGIN || y < -EDGE_MARGIN || x >= w + EDGE_MARGIN || y >= h + EDGE_MARGIN) continue;
        const p = STAR_PROFILES[j];
        stars.push({
            x, y,
            sigma: Math.max(p[0] * REF_K, MIN_SIGMA),
            flux: p[1] * REF_K * REF_K,
            red: p[2],
            blue: p[3],
        });
    }
    return stars;
}

// ---------------------------------------------------------------------------
// Rasteriser
// ---------------------------------------------------------------------------

/** erf, Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7). */
function erf(x: number): number {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return sign * y;
}

/** Largest star patch: 2·ceil(4·σmax) + 1 for the widest profile in the table. */
const PATCH = 2 * Math.ceil(4 * Math.max(...STAR_PROFILES.map(p => p[0])) * REF_K) + 1;
let patchCanvas: OffscreenCanvas | null = null;
let patchCtx: OffscreenCanvasRenderingContext2D | null = null;
let patchData: ImageData | null = null;
const fx = new Float64Array(PATCH);
const fy = new Float64Array(PATCH);

/**
 * Draw one star: a pixel-integrated (separable erf) Gaussian so a star's
 * flux is exact at any width, rendered into a small opaque-black patch and
 * added to the canvas with 'lighter' (black adds nothing; overlapping stars
 * sum and clamp, as in the image).
 */
function drawStar(ctx: OffscreenCanvasRenderingContext2D, st: Star): void {
    const rad = Math.ceil(4 * st.sigma);
    const size = 2 * rad + 1;
    const x0 = Math.trunc(st.x) - rad;
    const y0 = Math.trunc(st.y) - rad;
    const s2 = st.sigma * Math.SQRT2;
    for (let i = 0; i < size; i++) {
        const xx = x0 + i, yy = y0 + i;
        fx[i] = 0.5 * (erf((xx + 1 - st.x) / s2) - erf((xx - st.x) / s2));
        fy[i] = 0.5 * (erf((yy + 1 - st.y) / s2) - erf((yy - st.y) / s2));
    }
    // Per-pixel colour: r = L·red, b = L·blue, g from the luminance identity.
    const gl = Math.max(0, (1 - 0.299 * st.red - 0.114 * st.blue) / 0.587);
    const d = patchData!.data;
    d.fill(0);
    for (let j = 0; j < size; j++) {
        if (fy[j] < 1e-4) continue;
        for (let i = 0; i < size; i++) {
            const L = st.flux * fx[i] * fy[j];
            if (L < 0.3) continue;
            const o = (j * PATCH + i) * 4;
            d[o]     = Math.min(255, Math.trunc(L * st.red));
            d[o + 1] = Math.min(255, Math.trunc(L * gl));
            d[o + 2] = Math.min(255, Math.trunc(L * st.blue));
        }
    }
    // Opaque black backing so the patch adds exactly its star colour.
    for (let o = 3; o < d.length; o += 4) d[o] = 255;
    patchCtx!.putImageData(patchData!, 0, 0);
    ctx.drawImage(patchCanvas!, 0, 0, size, size, x0, y0, size, size);
}

// ---------------------------------------------------------------------------
// Drawing (into the merged static cache — see static-cache.ts)
// ---------------------------------------------------------------------------

/**
 * Draw the starfield over the full viewport.
 * Draws in raw device pixels — the caller must NOT have applied a dpr scale.
 * Always ready (no image to wait for).
 */
export function drawBackground(ctx: OffscreenCanvasRenderingContext2D, L: LayoutParams): void {
    const dpr = L.dpr;
    const w = Math.round(L.viewW * dpr);
    const h = Math.round(L.viewH * dpr);

    // Black base, as on iOS.
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);

    if (!patchCanvas) {
        patchCanvas = new OffscreenCanvas(PATCH, PATCH);
        patchCtx = patchCanvas.getContext('2d')!;
        patchData = patchCtx.createImageData(PATCH, PATCH);
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const st of generateStars(w, h)) drawStar(ctx, st);
    ctx.restore();
}
