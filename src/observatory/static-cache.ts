/**
 * Observatory merged static layer — one full-viewport OffscreenCanvas holding
 * everything that changes only on resize / noonOnTop flip / image arrival:
 *
 *   1. Starfield background  (background.ts — drawn in raw device pixels)
 *   2. Main orrery dial      (main-dial.ts — drawn in CSS px under a dpr scale)
 *   3. Peripheral dial bgs   (peripheral-dials.ts — same)
 *
 * Replaces the three per-module caches those files used to keep, halving
 * full-viewport canvas memory (4 surfaces → 2, counting the screen canvas) and
 * cutting per-frame static work from clear + 3 blits to 1 blit. See
 * planning/2026-08-26-observatory-merge-static-caches.md.
 *
 * Contract: getStaticCache() never returns null and the returned canvas is
 * fully opaque edge-to-edge (the black base below), which is what lets
 * drawFrame skip its per-frame clear. Layers whose images haven't arrived yet
 * are simply absent from a build; the image-load handler in
 * observatory-entry.ts calls invalidateStaticCache() once all images settle,
 * which paints them in on the next frame.
 */

import type { LayoutParams } from './layout.js';
import { drawBackground, isBackgroundReady } from './background.js';
import { drawMainDial, areDialImagesReady } from './main-dial.js';
import { drawPeripheralDials } from './peripheral-dials.js';

let cache: OffscreenCanvas | null = null;
let cacheKey = '';

// Union of the three old per-module keys (plus dpr, which two of them
// omitted). altR alone stands in for all the peripheral-dial geometry: azR and
// eotR always equal it, and eclipseR1/R2 + the ext/eot font sizes are derived
// from it in applyAnchor's unconditional tail (guard comments at those sites
// in layout.ts / anchor-layout.ts point back here). Real geometry changes are
// still primarily covered by the explicit invalidateStaticCache() call in
// resizeCanvas(); this key is the defensive check.
function layoutKey(L: LayoutParams, noonOnTop: boolean): string {
    return `${L.viewW}x${L.viewH}:${L.dpr}:${L.mainR.toFixed(1)}:${L.altR.toFixed(1)}:${noonOnTop}`;
}

/** Build/return the merged static background canvas. Never null; fully opaque. */
export function getStaticCache(L: LayoutParams, noonOnTop: boolean): OffscreenCanvas {
    const key = layoutKey(L, noonOnTop);
    if (cache && key === cacheKey) return cache;

    const dpr = L.dpr;
    const w = L.viewW * dpr;
    const h = L.viewH * dpr;
    if (!cache) {
        cache = new OffscreenCanvas(w, h);
    } else if (cache.width !== w || cache.height !== h) {
        // Resize in place rather than reallocating, so we never hold two
        // full-viewport canvases at once (126.6 MiB each at 8K).
        cache.width = w;
        cache.height = h;
    }
    cacheKey = key;

    const ctx = cache.getContext('2d')!;
    // The canvas is reused across rebuilds, so context state persists between
    // builds; start from identity rather than trusting every draw below to
    // have kept its save/restore pairs balanced on the previous build.
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Opaque black base — the always-there bottom layer that makes the
    // "never null ⇒ fully opaque" contract unconditional. (drawBackground
    // repaints it when the image is ready; harmless.)
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);

    // 1. Starfield — raw device pixels, no dpr scale.
    if (isBackgroundReady()) drawBackground(ctx, L);

    ctx.save();
    ctx.scale(dpr, dpr);
    // 2. Main orrery dial (needs its three images).
    if (areDialImagesReady()) {
        drawMainDial(ctx, L, noonOnTop);
        fixUpSunRegion(ctx, L, noonOnTop, dpr);
    }
    // 3. Peripheral dial backgrounds — pure vector, always ready.
    drawPeripheralDials(ctx, L);
    ctx.restore();

    return cache;
}

/**
 * The sun is drawn with globalCompositeOperation 'lighten' — the one
 * destination-dependent op in the static stack. Drawn straight into the merged
 * canvas it would blend against the starfield too, where the old per-layer
 * pipeline blended it against the dial layer's own (transparent-backed)
 * content and only then composited the result over the stars. Reproduce that
 * exactly: render the dial layer alone into a small scratch covering the
 * sun's bounding box, then splice it into the merged canvas over a repainted
 * background patch. The scratch's device-pixel grid is aligned with the
 * merged canvas's, so the splice is a 1:1 integer blit with no resampling.
 */
function fixUpSunRegion(
    ctx: OffscreenCanvasRenderingContext2D,
    L: LayoutParams,
    noonOnTop: boolean,
    dpr: number,
): void {
    const pad = 2;                                   // css px of AA slack
    const bx = L.mainCX - L.sunD / 2 - pad;
    const by = L.mainCY - L.sunD / 2 - pad;
    const bs = L.sunD + 2 * pad;
    // Snap the box to whole device pixels.
    const dx = Math.floor(bx * dpr);
    const dy = Math.floor(by * dpr);
    const dw = Math.ceil((bx + bs) * dpr) - dx;
    const dh = Math.ceil((by + bs) * dpr) - dy;

    // Transparent-backed dial layer, exactly as the old main-dial cache was,
    // raster-clipped to the box by the scratch's own bounds.
    const scratch = new OffscreenCanvas(dw, dh);
    const sctx = scratch.getContext('2d')!;
    sctx.setTransform(dpr, 0, 0, dpr, -dx, -dy);
    drawMainDial(sctx, L, noonOnTop);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);              // device space
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    // Repaint the background patch beneath the layer…
    ctx.fillStyle = '#000000';
    ctx.fillRect(dx, dy, dw, dh);
    if (isBackgroundReady()) drawBackground(ctx, L);
    // …then the layer-local sun composite over it.
    ctx.drawImage(scratch, dx, dy);
    ctx.restore();
}

/** Force a rebuild on next call (resize, image arrival). Keeps the allocation. */
export function invalidateStaticCache(): void {
    cacheKey = '';
}

/** Estimated backing-store bytes (w×h×4) — for the [mem] ledger log. */
export function staticCacheSizeBytes(): number {
    return cache ? cache.width * cache.height * 4 : 0;
}
