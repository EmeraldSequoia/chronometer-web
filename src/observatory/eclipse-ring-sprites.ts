/**
 * Eclipse Simulator ring-marker sprites: the Sun, Moon, Earth-shadow and
 * lunar-node markers, drawn in code at the exact device-pixel size
 * (planning/2026-09-11-eclipse-ring-icons.md).
 *
 * They replace the iOS @1x PNGs (eclipseRing*.png, 27/20/20/15/15 px), which
 * every device upsampled 1.3–5.3×. All geometry is in iOS points (= pixels of
 * those PNGs) and was fitted to them. Each sprite keeps its old PNG's box and
 * "PNG-up" layout — the Sun's star 4 pt below the box center, the Moon's lit
 * half on top, the node arrowheads ½ pt low — because drawRingMarker
 * (eclipse-view.ts) draws every marker through a Y flip that those layouts were
 * authored against; keeping them keeps placement and orientation unchanged.
 *
 * A sprite is ceil(box · pxPerPt) px square, where pxPerPt is the marker scale
 * times the device scale, and the set is cached until pxPerPt changes (resize,
 * rotation, a display with a different DPR, browser zoom) or the Moon texture
 * arrives. Backing store is ≈40 KB on a phone and ≈220 KB on a 6K display —
 * too small to be worth a line in the [mem] ledger.
 */

type Ctx2D = OffscreenCanvasRenderingContext2D;
export type Pt = readonly [number, number];

/** Marker boxes in iOS points — the old PNG sizes (drawRingMarker draws each into box · s). */
export const RING_BOX = {
    sun: 27,
    moon: 20,
    earthShadow: 20,
    ascNode: 15,
    desNode: 15,
} as const;

// ============================================================================
// Geometry (iOS points, PNG coordinates: y down, origin at the box's top-left)
// ============================================================================

// --- Sun: an 8-ray star built like the watch renderer's `sun` hand (iOS
// ECQHandSun, which also drew Firenze's center star) — valleys at half the ray
// length — but with all rays equal, as on the old ring icon.

/** Star center: 4 pt below the box center, so the flip lands it on the outer rim R2. */
export const SUN_CENTER: Pt = [13.5, 17.5];
export const SUN_RAYS = 8;
export const SUN_TIP_R = 8;
export const SUN_VALLEY_R = 4;
const SUN_FILL = '#f2e407';      // Firenze sunColor
const SUN_STROKE = '#120400';    // Firenze sunStrokeColor
const SUN_STROKE_W = 0.5;

// --- Moon and Earth shadow: a 16-pt disc. The dark parts — all of the shadow,
// the Moon's dark half — get a mid-gray border, inset so the silhouette stays
// 16 pt across; the Moon's lit half has none. (This replaces the iOS art's
// faint white rim and halo.)

export const DISC_CENTER = 10;
export const DISC_R = 8;
const DARK_BORDER_W = 0.75;
const DARK_BORDER_COLOR = '#808080';
const SHADOW_FILL = 'rgba(0,0,0,0.66)';

/** How the Moon's lit half is cut from moon300.png. */
export interface MoonStyle {
    /** Which half of the photo is shown lit: its outward direction, degrees clockwise from the photo's north. */
    litHalfDeg: number;
    /** Brightness gain on the lit half (1 = the photo as-is; at most 2). */
    gain: number;
}

/** North-northeast half (Imbrium, Serenitatis, Crisium): about half maria, half highlands. */
export const MOON_STYLE: MoonStyle = { litHalfDeg: 15, gain: 1.5 };

// --- Lunar nodes: a 1-pt radial line across the ring with a small arrowhead,
// left (ascending) or right (descending) in PNG coords.

export const NODE_LINE_X = 7.5;
export const NODE_LINE_W = 1;
const NODE_LINE_ALPHA = 0.94;
/** Arrowhead center: ½ pt below the box center. */
export const NODE_ARROW_CY = 8;
export const NODE_ARROW_BASE = 5;
export const NODE_ARROW_DEPTH = 2.5;
const NODE_RGB = '182,0,0';

/** Sun outline: 2·SUN_RAYS vertices alternating tip and valley, starting with the tip straight up. */
export function sunStarOutline(): Pt[] {
    const [cx, cy] = SUN_CENTER;
    const pts: Pt[] = [];
    for (let i = 0; i < 2 * SUN_RAYS; i++) {
        const r = i % 2 === 0 ? SUN_TIP_R : SUN_VALLEY_R;
        const a = i * Math.PI / SUN_RAYS;
        pts.push([cx + r * Math.sin(a), cy - r * Math.cos(a)]);
    }
    return pts;
}

/**
 * Node arrowhead plus the stretch of line it sits on (drawn opaque over the
 * 94 % line, as in the old PNGs). side −1 = left (ascending), +1 = right
 * (descending).
 */
export function nodeArrowOutline(side: -1 | 1): Pt[] {
    const near = NODE_LINE_X + side * NODE_LINE_W / 2;
    const far = NODE_LINE_X - side * NODE_LINE_W / 2;
    const top = NODE_ARROW_CY - NODE_ARROW_BASE / 2;
    const bottom = NODE_ARROW_CY + NODE_ARROW_BASE / 2;
    return [
        [far, top], [near, top],
        [near + side * NODE_ARROW_DEPTH, NODE_ARROW_CY],
        [near, bottom], [far, bottom],
    ];
}

/** Sprite side in device pixels (the epsilon keeps float noise from adding a pixel). */
export function spritePixelSize(box: number, pxPerPt: number): number {
    return Math.max(1, Math.ceil(box * pxPerPt - 1e-9));
}

// ============================================================================
// Rendering
// ============================================================================

export interface RingSprites {
    sun: OffscreenCanvas;
    /** Null until the Moon texture has decoded. */
    moon: OffscreenCanvas | null;
    earthShadow: OffscreenCanvas;
    ascNode: OffscreenCanvas;
    desNode: OffscreenCanvas;
}

/** A blank sprite whose context draws in points. */
function newSprite(box: number, pxPerPt: number): { canvas: OffscreenCanvas; ctx: Ctx2D } {
    const n = spritePixelSize(box, pxPerPt);
    const canvas = new OffscreenCanvas(n, n);
    const ctx = canvas.getContext('2d')!;
    // n/box ≥ pxPerPt; drawRingMarker maps the n px back onto box · pxPerPt.
    ctx.scale(n / box, n / box);
    return { canvas, ctx };
}

function tracePolygon(ctx: Ctx2D, pts: readonly Pt[]): void {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
}

function traceDisc(ctx: Ctx2D, r: number): void {
    ctx.beginPath();
    ctx.arc(DISC_CENTER, DISC_CENTER, r, 0, 2 * Math.PI);
}

/**
 * The mid-gray border along the disc edge from startAngle to endAngle (canvas
 * angles), inset so it stays inside the 16-pt silhouette. Butt caps end it
 * square at the Moon's terminator.
 */
function strokeDarkBorder(ctx: Ctx2D, startAngle: number, endAngle: number): void {
    ctx.beginPath();
    ctx.arc(DISC_CENTER, DISC_CENTER, DISC_R - DARK_BORDER_W / 2, startAngle, endAngle);
    ctx.lineWidth = DARK_BORDER_W;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = DARK_BORDER_COLOR;
    ctx.stroke();
}

function drawSunSprite(pxPerPt: number): OffscreenCanvas {
    const { canvas, ctx } = newSprite(RING_BOX.sun, pxPerPt);
    tracePolygon(ctx, sunStarOutline());
    ctx.fillStyle = SUN_FILL;
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = SUN_STROKE;
    ctx.lineWidth = SUN_STROKE_W;
    ctx.stroke();
    return canvas;
}

function drawEarthShadowSprite(pxPerPt: number): OffscreenCanvas {
    const { canvas, ctx } = newSprite(RING_BOX.earthShadow, pxPerPt);
    traceDisc(ctx, DISC_R);
    ctx.fillStyle = SHADOW_FILL;
    ctx.fill();
    strokeDarkBorder(ctx, 0, 2 * Math.PI);
    return canvas;
}

/**
 * `img` shrunk by successive halving until it is at most twice `targetPx`
 * across, so the final (rotated) draw is at most a 2× bilinear reduction —
 * clean in every browser, whatever it does with imageSmoothingQuality.
 * Assumes a square image (moon300.png is).
 */
function halvedTo(img: HTMLImageElement, targetPx: number): CanvasImageSource {
    let src: CanvasImageSource = img;
    let size = img.naturalWidth;
    while (size > 2 * targetPx) {
        const next = Math.ceil(size / 2);
        const c = new OffscreenCanvas(next, next);
        const cctx = c.getContext('2d')!;
        cctx.imageSmoothingQuality = 'high';
        cctx.drawImage(src, 0, 0, next, next);
        src = c;
        size = next;
    }
    return src;
}

function drawMoonSprite(pxPerPt: number, texture: HTMLImageElement, style: MoonStyle): OffscreenCanvas {
    const { canvas, ctx } = newSprite(RING_BOX.moon, pxPerPt);
    const c = DISC_CENTER, r = DISC_R;
    // Opaque black disc: the dark half, and the backing for the lit half.
    traceDisc(ctx, r);
    ctx.fillStyle = '#000';
    ctx.fill();

    // Lit half = the PNG-top half (it ends up facing the Sun marker).
    const src = halvedTo(texture, 2 * r * canvas.width / RING_BOX.moon);
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, r, Math.PI, 2 * Math.PI);
    ctx.closePath();
    ctx.clip();
    ctx.translate(c, c);
    // Cancel drawRingMarker's flip in advance, so the photo isn't mirrored on screen.
    ctx.scale(1, -1);
    // Turn the chosen half of the photo toward the lit side.
    ctx.rotate((180 - style.litHalfDeg) * Math.PI / 180);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, -r, -r, 2 * r, 2 * r);
    if (style.gain > 1) {
        // Add (gain − 1) more of the photo: brightness × gain, clamped at white.
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, style.gain - 1);
        ctx.drawImage(src, -r, -r, 2 * r, 2 * r);
    }
    ctx.restore();

    // Border on the dark half only: the PNG-bottom arc, canvas angles 0 → π.
    strokeDarkBorder(ctx, 0, Math.PI);
    return canvas;
}

function drawNodeSprite(pxPerPt: number, side: -1 | 1): OffscreenCanvas {
    const { canvas, ctx } = newSprite(RING_BOX.ascNode, pxPerPt);
    ctx.fillStyle = `rgba(${NODE_RGB},${NODE_LINE_ALPHA})`;
    ctx.fillRect(NODE_LINE_X - NODE_LINE_W / 2, 0, NODE_LINE_W, RING_BOX.ascNode);
    tracePolygon(ctx, nodeArrowOutline(side));
    ctx.fillStyle = `rgb(${NODE_RGB})`;
    ctx.fill();
    return canvas;
}

/** Render a fresh sprite set (uncached — getRingSprites is the cached entry point). */
export function buildRingSprites(
    pxPerPt: number,
    moonTexture: HTMLImageElement | null,
    moonStyle: MoonStyle = MOON_STYLE,
): RingSprites {
    return {
        sun: drawSunSprite(pxPerPt),
        moon: moonTexture ? drawMoonSprite(pxPerPt, moonTexture, moonStyle) : null,
        earthShadow: drawEarthShadowSprite(pxPerPt),
        ascNode: drawNodeSprite(pxPerPt, -1),
        desNode: drawNodeSprite(pxPerPt, 1),
    };
}

let cache: { pxPerPt: number; moonReady: boolean; sprites: RingSprites } | null = null;

/**
 * The sprite set for `pxPerPt` device pixels per marker point, rebuilt only
 * when that changes or the Moon texture first becomes available.
 */
export function getRingSprites(pxPerPt: number, moonTexture: HTMLImageElement | null): RingSprites {
    const moonReady = moonTexture !== null;
    if (!cache || cache.pxPerPt !== pxPerPt || cache.moonReady !== moonReady) {
        cache = { pxPerPt, moonReady, sprites: buildRingSprites(pxPerPt, moonTexture) };
    }
    return cache.sprites;
}
