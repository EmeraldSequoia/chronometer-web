/**
 * Observatory starfield background — static base layer.
 *
 * Port of: EOBaseView.drawRect: (EOBaseView.mm L20–51), which draws
 * background.png (a 768×1024-pt starfield) under the whole clock, rotating
 * it 90° in landscape so the image's long axis follows the viewport's.
 *
 * The iOS app has exactly two fixed layouts, so it can draw the image 1:1 at
 * the origin. The web layout is responsive (arbitrary viewport sizes), so the
 * adaptation here is aspect-fill: scale the image uniformly to cover the
 * viewport and center-crop the overflow, keeping the iOS rotate-in-landscape
 * behavior so the (portrait) image needs the least scaling in either
 * orientation.
 *
 * Drawn into the merged static cache (static-cache.ts) at DPR resolution;
 * rebuilt only on resize / image arrival.
 */

import type { LayoutParams } from './layout.js';

// Image asset import (bundled as a data URL by esbuild)
import backgroundPng from '../../.observatory-ref/Resources/background@2x.png';

// ---------------------------------------------------------------------------
// Image loading
// ---------------------------------------------------------------------------

let backgroundImg: HTMLImageElement | null = null;
let imageLoaded = false;

function loadImage(): Promise<void> {
    if (imageLoaded) return Promise.resolve();

    backgroundImg = new Image();
    const promise = new Promise<void>((resolve) => {
        backgroundImg!.onload = () => resolve();
        backgroundImg!.onerror = () => { console.warn('[Background] Failed to load background.png'); resolve(); };
    });
    backgroundImg.src = backgroundPng;

    return promise.then(() => { imageLoaded = true; });
}

// Start loading immediately on import
const imageLoadPromise = loadImage();

// ---------------------------------------------------------------------------
// Drawing (into the merged static cache — see static-cache.ts)
// ---------------------------------------------------------------------------

/** True once the starfield image is usable (loaded with real pixels). */
export function isBackgroundReady(): boolean {
    return imageLoaded && !!backgroundImg && backgroundImg.naturalWidth > 0;
}

/**
 * Draw the cover-scaled starfield over the full viewport.
 * Draws in raw device pixels — the caller must NOT have applied a dpr scale.
 * The caller gates on isBackgroundReady().
 */
export function drawBackground(ctx: OffscreenCanvasRenderingContext2D, L: LayoutParams): void {
    const dpr = L.dpr;
    const w = L.viewW * dpr;
    const h = L.viewH * dpr;

    // Black base, as on iOS (the image itself is opaque black, but cover
    // rounding can leave sub-pixel slivers at the edges).
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);

    // iOS rotates the portrait image 90° for landscape (EOBaseView.mm L34–40).
    const landscape = w > h;
    // Viewport dimensions in the image's (pre-rotation) frame.
    const targetW = landscape ? h : w;
    const targetH = landscape ? w : h;

    const imgW = backgroundImg!.naturalWidth;
    const imgH = backgroundImg!.naturalHeight;
    const scale = Math.max(targetW / imgW, targetH / imgH);
    const drawW = imgW * scale;
    const drawH = imgH * scale;

    ctx.save();
    if (landscape) {
        ctx.translate(w / 2, h / 2);
        ctx.rotate(Math.PI / 2);
        ctx.translate(-h / 2, -w / 2);
    }
    // Center-crop the cover overflow.
    ctx.drawImage(backgroundImg!, (targetW - drawW) / 2, (targetH - drawH) / 2, drawW, drawH);
    ctx.restore();
}

/**
 * Returns a promise that resolves when the background image is loaded.
 */
export function waitForBackgroundImage(): Promise<void> {
    return imageLoadPromise;
}
