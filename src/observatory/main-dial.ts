/**
 * Observatory main orrery dial — static background layer.
 *
 * Renders the central 24-hour clock dial background into the merged static
 * cache (static-cache.ts), redrawn only on resize or noonOnTop change.
 *
 * Port of: EORingsAndPlanetsShuffleView.drawRect: (EOShuffleView.mm L103–256)
 * with parameters from EOClock.mm L1646–1674.
 *
 * Draws (back to front):
 *   1. Background circle (translucent white)
 *   2. 24-hour tick marks (3 tiers: heavy, medium, fine)
 *   3. 24-hour demi-radial numbers
 *   4. Zodiac symbol image
 *   5. 12-hour golden demi-radial markers
 *   6. Planet orbit circles (6 concentric)
 *   7. Second-hand tick marks (no-fives, outer + fine)
 *   8. Sun image at center
 *   9. Inner subdial backgrounds (UTC, Solar, Sidereal)
 */

import type { LayoutParams } from './layout.js';
import { drawTicks, drawCircle, drawFilledCircle, drawDialNumbersDemiRadial, drawDialNumbersUpright, drawText } from './draw-utils.js';

// Image asset imports (bundled as data URLs by esbuild)
import zodiacPng from '../../.observatory-ref/Resources/zodiac.png';
import sunPng from '../../.observatory-ref/Resources/sun.png';
import siderealConstellationPng from '../../.observatory-ref/EO-Sidereal-constellation-names-0-at-top@2x.png';

const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
// Image loading
// ---------------------------------------------------------------------------

let zodiacImg: HTMLImageElement | null = null;
let sunImg: HTMLImageElement | null = null;
let siderealConstellationImg: HTMLImageElement | null = null;
let imagesLoaded = false;

function loadImages(): Promise<void> {
    if (imagesLoaded) return Promise.resolve();

    const promises: Promise<void>[] = [];

    zodiacImg = new Image();
    promises.push(new Promise<void>((resolve, reject) => {
        zodiacImg!.onload = () => resolve();
        zodiacImg!.onerror = () => { console.warn('[MainDial] Failed to load zodiac.png'); resolve(); };
    }));
    zodiacImg.src = zodiacPng;

    sunImg = new Image();
    promises.push(new Promise<void>((resolve, reject) => {
        sunImg!.onload = () => resolve();
        sunImg!.onerror = () => { console.warn('[MainDial] Failed to load sun.png'); resolve(); };
    }));
    sunImg.src = sunPng;

    siderealConstellationImg = new Image();
    promises.push(new Promise<void>((resolve, reject) => {
        siderealConstellationImg!.onload = () => resolve();
        siderealConstellationImg!.onerror = () => { console.warn('[MainDial] Failed to load sidereal constellation image'); resolve(); };
    }));
    siderealConstellationImg.src = siderealConstellationPng;

    return Promise.all(promises).then(() => { imagesLoaded = true; });
}

// Start loading immediately on import
const imageLoadPromise = loadImages();

// ---------------------------------------------------------------------------
// Readiness (consulted by static-cache.ts before drawing this layer)
// ---------------------------------------------------------------------------

/** True once all three dial images have settled (loaded or errored). */
export function areDialImagesReady(): boolean {
    return imagesLoaded;
}

/**
 * Returns a promise that resolves when images are loaded.
 */
export function waitForImages(): Promise<void> {
    return imageLoadPromise;
}

// ---------------------------------------------------------------------------
// Main drawing function
// ---------------------------------------------------------------------------

export function drawMainDial(
    ctx: OffscreenCanvasRenderingContext2D,
    L: LayoutParams,
    noonOnTop: boolean,
): void {
    const cx = L.mainCX;
    const cy = L.mainCY;
    const mainR = L.mainR;

    // ====================================================================
    // 1. Background circle — translucent white fill + white stroke
    //    iOS: rgba(1,1,1,0.125) fill + stroke
    // ====================================================================
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.125)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 1.0)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.arc(cx, cy, mainR, 0, TWO_PI);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // ====================================================================
    // 2. 24-hour tick marks — 3 tiers
    //    iOS: n=48 heavy(2px), n=144 medium(1px), n=720 fine(1px)
    // ====================================================================
    const tickH = L.tickHeight;
    const lightGray = 'rgba(211, 211, 211, 1)';

    // Heavy ticks at every half-hour (48 divisions)
    drawTicks(ctx, cx, cy, 48, mainR - tickH, mainR, 2, lightGray);
    // Medium ticks at every 10 minutes (144 divisions)
    drawTicks(ctx, cx, cy, 144, mainR - tickH * 0.75, mainR, 1, lightGray);
    // Fine ticks at every 2 minutes (720 divisions)
    drawTicks(ctx, cx, cy, 720, mainR - tickH * 0.37, mainR, 0.5, lightGray);

    // Erase long ticks behind single-digit numbers (they overlap)
    // iOS: draws black ticks to "erase" the heavy ticks where single-digit numbers sit
    if (noonOnTop) {
        // noonOnTop: erase between 13 and 21 o'clock positions
        drawTicks(ctx, cx, cy, 24, mainR - tickH, mainR - tickH * 0.7, 2, '#000000',
            12.9 * TWO_PI / 24, 21 * TWO_PI / 24);
    } else {
        // midnight on top: erase between 0 and 9 o'clock positions
        drawTicks(ctx, cx, cy, 24, mainR - tickH, mainR - tickH * 0.7, 2, '#000000',
            0, 9 * TWO_PI / 24);
    }

    // ====================================================================
    // 3. 24-hour demi-radial numbers
    //    iOS: "Times New Roman" size mainFontSize, white alpha 0.8
    //    noonOnTop: "12,13,...,23,24,1,...,11"
    //    else: "0,1,2,...,23"
    // ====================================================================
    const numbers24NoonOnTop = '12,13,14,15,16,17,18,19,20,21,22,23,24,1,2,3,4,5,6,7,8,9,10,11'.split(',');
    const numbers24MidOnTop = '0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23'.split(',');
    const labels24 = noonOnTop ? numbers24NoonOnTop : numbers24MidOnTop;

    drawDialNumbersDemiRadial(
        ctx, cx, cy,
        labels24,
        `${L.mainFontSize}px 'Times New Roman', 'Georgia', serif`,
        'rgba(255, 255, 255, 0.8)',
        mainR,
        mainR,
    );

    // ====================================================================
    // 4. Zodiac symbol image — centered, half-alpha
    //    iOS: draws zodiac.png at (-zD/2-1, -zD/2+1) with alpha 0.5
    // ====================================================================
    if (zodiacImg && zodiacImg.complete) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        const zSize = L.zD;
        ctx.drawImage(zodiacImg, cx - zSize / 2, cy - zSize / 2, zSize, zSize);
        ctx.restore();
    }

    // ====================================================================
    // 5. 12-hour golden demi-radial markers
    //    iOS: "Arial" size mainFontSize/2, color #FAB700 (golden)
    //    labels: "12,1,2,...,11", radius zR-2 / zR
    // ====================================================================
    const labels12 = '12,1,2,3,4,5,6,7,8,9,10,11'.split(',');
    drawDialNumbersDemiRadial(
        ctx, cx, cy,
        labels12,
        `${L.mainFontSize / 2}px 'Arial', sans-serif`,
        'rgba(250, 183, 0, 1)',
        L.zR - 2,
        L.zR,
    );

    // ====================================================================
    // 6. Planet orbit circles — 6 concentric thin white circles
    //    iOS: lineWidth=0.18, white, at plR2, plR2-orbitInc, ..., plR2-5*orbitInc
    // ====================================================================
    for (let i = 0; i < 6; i++) {
        drawCircle(ctx, cx, cy, L.plR2 - i * L.orbitInc, 0.3, 'rgba(255, 255, 255, 0.8)');
    }

    // ====================================================================
    // 7. Second-hand tick marks — no-fives rings
    //    iOS: n=60 noFives inner=secLen-6, n=300 noFives inner=secLen-3
    // ====================================================================
    const s = L.mainR / 365;  // scale factor
    drawTicks(ctx, cx, cy, 60, L.secLen - 6 * s, L.secLen, 1, lightGray, 0, TWO_PI, true);
    drawTicks(ctx, cx, cy, 300, L.secLen - 3 * s, L.secLen, 0.5, lightGray, 0, TWO_PI, true);

    // ====================================================================
    // 8. Sun image at center
    //    iOS: sun.png drawn at center with alpha 0.75
    //    sun.png has no alpha channel (RGB, not RGBA), so the black
    //    background would show as a square. Use 'lighten' compositing
    //    so black pixels become transparent (lighten(black, X) = X).
    // ====================================================================
    if (sunImg && sunImg.complete) {
        ctx.save();
        ctx.globalAlpha = 0.75;
        ctx.globalCompositeOperation = 'lighten';
        const sunSize = L.sunD;
        ctx.drawImage(sunImg, cx - sunSize / 2, cy - sunSize / 2, sunSize, sunSize);
        ctx.restore();
    }

    // ====================================================================
    // 9. Inner subdial backgrounds (UTC, Solar, Sidereal)
    //    iOS: black fill + white stroke circles, with ticks and labels
    // ====================================================================
    drawSubdialBackground(ctx, L, L.utcCX, L.utcCY, 'UTC', noonOnTop);
    drawSubdialBackground(ctx, L, L.solarCX, L.solarCY, 'Solar', noonOnTop);
    drawSubdialBackground(ctx, L, L.sidCX, L.sidCY, 'Sidereal', noonOnTop);
}

// ---------------------------------------------------------------------------
// Subdial background helper
// ---------------------------------------------------------------------------

function drawSubdialBackground(
    ctx: OffscreenCanvasRenderingContext2D,
    L: LayoutParams,
    cx: number, cy: number,
    label: string,
    noonOnTop: boolean,
): void {
    const r = L.subR;
    const s = L.mainR / 365;

    // Translucent dark circle (not opaque black) so planet orbit arcs
    // show through the subdials
    drawFilledCircle(ctx, cx, cy, r, 'rgba(0, 0, 0, 0.65)');
    drawCircle(ctx, cx, cy, r, 0.5, 'rgba(255, 255, 255, 1)');
    // Inner ring
    drawCircle(ctx, cx, cy, r - 5 * s, 0.5, 'rgba(255, 255, 255, 1)');

    // Ticks
    const lightGray = 'rgba(211, 211, 211, 1)';
    drawTicks(ctx, cx, cy, 12, r - 5 * s, r, 1.5, lightGray);
    drawTicks(ctx, cx, cy, 60, r - 3 * s, r, 1.0, lightGray);

    // Labels depend on subdial type
    if (label === 'UTC') {
        // UTC: 24h upright, even numbers + dots
        const evenNumbers24NoonOnTop = '12,▪,14,▪,16,▪,18,▪,20,▪,22,▪,0,▪,2,▪,4,▪,6,▪,8,▪,10,▪'.split(',');
        const evenNumbers24MidOnTop = '0,▪,2,▪,4,▪,6,▪,8,▪,10,▪,12,▪,14,▪,16,▪,18,▪,20,▪,22,▪'.split(',');
        const labels = noonOnTop ? evenNumbers24NoonOnTop : evenNumbers24MidOnTop;
        drawDialNumbersUpright(ctx, cx, cy, labels,
            `${L.subdialFontSize}px 'Arial', sans-serif`, '#ffffff', r - 5 * s);
    } else if (label === 'Solar') {
        // Solar: 12h upright
        const labels12 = '12,1,2,3,4,5,6,7,8,9,10,11'.split(',');
        drawDialNumbersUpright(ctx, cx, cy, labels12,
            `${L.subdialFontSize}px 'Arial', sans-serif`, '#ffffff', r - 5 * s);
    } else {
        // Sidereal: 24h with only 0/6/12/18 + dots
        const fourNumbers = '0,,▪,,▪,,6,,▪,,▪,,12,,▪,,▪,,18,,▪,,▪,'.split(',');
        drawDialNumbersUpright(ctx, cx, cy, fourNumbers,
            `${L.subdialFontSize}px 'Arial', sans-serif`, '#ffffff', r - L.subdialFontSize - 5 * s);
        // Extra dots at intermediate positions
        const extraDots = ' ,▪, ,▪, ,▪, ,▪, ,▪, ,▪,  ,▪, ,▪, ,▪,  ,▪, ,▪, ,▪'.split(',');
        drawDialNumbersUpright(ctx, cx, cy, extraDots,
            `${L.subdialFontSize - 3 * s}px 'Arial', sans-serif`, '#ffffff', r - L.subdialFontSize - 7 * s);

        // Constellation names overlay image
        // Port of: EOShuffleView.mm L211-218
        if (siderealConstellationImg && siderealConstellationImg.complete) {
            const imgSize = 149 * s;
            ctx.drawImage(siderealConstellationImg,
                cx - imgSize / 2, cy - imgSize / 2, imgSize, imgSize);
        }
    }

    // Label text (at bottom of subdial, matching iOS)
    drawText(ctx, label, cx, cy + r / 2 - L.subdialFontSize / 2,
        `${L.subdialFontSize + 2 * s}px 'Arial', sans-serif`, '#ffffff');
}

