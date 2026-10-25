/**
 * Observatory zodiac ring — the twelve sign glyphs as vector strokes.
 *
 * Replaces `zodiac.png` (526×526, glyphs ~25 px tall), which the main dial
 * upscaled by `s·dpr` and so went fuzzy at 4K. Each glyph is a few open
 * monoline strokes (round caps and joins) hand-authored against that artwork
 * (planning/2026-10-23-zodiac-glyphs/), so the look is unchanged but the ink
 * rasterises at device resolution at any dial size.
 *
 * Coordinate frame (units = reference px at mainR = 365, i.e. s = 1):
 *   origin  — the slot centre, at radius ZODIAC_RING_R from the dial centre
 *   +x      — tangential, clockwise when the glyph sits at 12 o'clock
 *   +y      — radially inward (toward the dial centre)
 * Glyphs are demi-radial like the numerals: slots 0–3 and 9–11 read
 * outward-up, slots 4–8 (the bottom half) are flipped 180° so they read
 * upright on screen. Slot order is clockwise from the top, matching the PNG
 * and the iOS text string "♓,♒,♑,♐,♏,♎,♍,♌,♋,♊,♉,♈".
 */

export interface ZodiacGlyph {
    /** Latin name, for tests and debugging. */
    readonly name: string;
    /** The Unicode sign, for tests and debugging. */
    readonly symbol: string;
    /** Stroke width in frame units — the artwork's weight varies per sign. */
    readonly width: number;
    /** Open strokes, SVG path syntax (absolute M/L/C/Q/Z only). */
    readonly strokes: readonly string[];
    /** Closed shapes to fill as well as stroke (Scorpius' arrowhead). */
    readonly fills?: readonly string[];
}

/** Slot centre radius at s = 1 (glyph ink spans ≈ 221–253, as the PNG did). */
export const ZODIAC_RING_R = 237;

/**
 * 50 % white over the dial's own fill (12.5 % white on black → grey 32) comes
 * to grey 144. Drawn opaque so self-crossing strokes (Virgo's bowl, the
 * Scorpius tail) don't double up the way a translucent stroke would.
 */
export const ZODIAC_COLOR = 'rgb(144, 144, 144)';

export const ZODIAC_GLYPHS: readonly ZodiacGlyph[] = [
    {
        name: 'Pisces', symbol: '♓', width: 2.0,
        strokes: [
            'M -10.05 -16.38 C -5.79 -10.38 -3.63 -6.88 -3.63 -3.13 C -3.63 0.63 -5.79 5.80 -9.55 10.72',
            'M 9.30 -15.97 C 5.21 -10.80 3.21 -6.88 3.21 -3.13 C 3.21 0.63 4.96 5.80 9.13 10.72',
            'M -9.38 -2.37 L 9.21 -2.37',
        ],
    },
    {
        name: 'Aquarius', symbol: '♒', width: 2.36,
        strokes: [
            'M -12.17 -4.86 C -10.82 -6.54 -9.55 -8.31 -6.61 -8.31 C -4.50 -8.31 -4.50 -6.37 -2.98 -6.37 C -1.38 -6.37 -1.38 -8.31 0.64 -8.31 C 2.66 -8.31 2.66 -6.37 4.01 -6.37 C 5.52 -6.37 5.52 -8.31 7.63 -8.31 C 9.40 -8.31 10.66 -6.54 11.42 -4.86',
            'M -12.17 3.57 C -10.82 1.88 -9.55 0.11 -6.61 0.11 C -4.50 0.11 -4.50 2.05 -2.98 2.05 C -1.38 2.05 -1.38 0.11 0.64 0.11 C 2.66 0.11 2.66 2.05 4.01 2.05 C 5.52 2.05 5.52 0.11 7.63 0.11 C 9.40 0.11 10.66 1.88 11.42 3.57',
        ],
    },
    {
        name: 'Capricorn', symbol: '♑', width: 1.81,
        strokes: [
            'M -12.32 -14.03 C -9.77 -11.55 -8.37 -8.26 -7.30 -5.38 C -6.88 -4.14 -7.05 -2.49 -7.21 -1.26',
            'M -6.55 -5.62 C -5.65 -8.26 -4.41 -11.55 -2.77 -13.04 C -1.53 -13.61 -0.71 -11.55 -0.38 -9.08 C 0.04 -5.79 0.36 -3.32 0.61 -1.26 C 0.94 0.80 1.93 1.63 2.09 2.45 C 1.77 4.10 0.94 5.75 -0.21 7.80 C -1.12 9.45 -2.77 10.52 -4.74 10.28',
            'M 2.34 0.80 C 3.82 -1.67 6.30 -3.32 7.94 -3.07 C 10.00 -2.74 11.24 -0.43 11.16 1.63 C 11.07 3.69 9.59 5.42 7.12 5.42 C 4.65 5.42 3.00 4.10 2.42 2.86',
        ],
    },
    {
        name: 'Sagittarius', symbol: '♐', width: 2.72,
        strokes: [
            'M 9.85 -13.68 L -13.09 9.26',
            'M -0.13 -14.18 L 10.51 -14.18 L 10.51 -1.88',
            'M -8.97 -7.08 L 3.33 -7.08 L 3.33 5.38',
        ],
    },
    {
        name: 'Scorpius', symbol: '♏', width: 2.06,
        strokes: [
            'M -13.36 -15.23 C -12.04 -13.42 -10.89 -11.53 -10.65 -9.47 L -10.65 9.20',
            'M -10.65 -9.47 C -10.32 -12.35 -7.85 -14.99 -4.97 -14.99 C -3.33 -14.99 -2.59 -12.76 -2.59 -9.89 L -2.59 9.20',
            'M -2.59 -9.89 C -2.26 -12.76 0.79 -15.15 3.50 -15.15 C 4.90 -15.15 5.23 -12.76 5.23 -9.89 L 5.23 7.80 C 5.23 9.03 6.13 10.35 7.78 10.35 L 11.07 10.35',
        ],
        fills: [
            'M 11.15 8.29 L 14.11 10.35 L 11.15 12.40 Z',
        ],
    },
    {
        name: 'Libra', symbol: '♎', width: 2.4,
        strokes: [
            'M -5.08 -0.72 L -5.41 -2.46 C -6.57 -5.36 -6.32 -9.49 -3.43 -11.81 C -1.77 -13.13 2.36 -13.13 4.02 -11.81 C 6.91 -9.49 6.99 -5.36 5.83 -2.46 L 5.42 -0.72',
            'M -11.95 -0.72 L -5.08 -0.72',
            'M 5.42 -0.72 L 13.20 -0.72',
            'M -11.95 6.64 L 13.20 6.64',
        ],
    },
    {
        name: 'Virgo', symbol: '♍', width: 2.1,
        strokes: [
            'M -11.7 -14.8 C -11 -13.5 -10.5 -12 -10.4 -10 L -10.4 7.8',
            'M -10.4 -10 C -10 -13 -7.5 -15.7 -4.5 -15.7 C -2.8 -15.7 -2.1 -13.5 -2.0 -11 L -2.0 8.5',
            'M -2.0 -11 C -1.2 -13.5 1.5 -15.7 4.1 -15.7 C 5.5 -15.7 5.6 -13.5 5.6 -11 L 5.6 8.5 C 5.8 10 6 11 6.2 11.6 C 6.6 12.8 7 13.8 7.5 14.8',
            'M 5.6 -6.0 C 6.1 -8.5 7.6 -9.6 9.4 -9.5 C 11.8 -9.4 13 -6 12.9 -2.5 C 12.9 1 12 4 10.1 6.5 C 9 8 7.5 8.8 5.8 8.6',
            'M 6.2 11.6 C 5 12 3 12.4 1.5 12.9 C 0.7 13.3 0 13.8 -0.6 14.5',
        ],
    },
    {
        name: 'Leo', symbol: '♌', width: 1.49,
        strokes: [
            'M -2.16 -0.35 C -2.16 -3.17 -3.23 -6.48 -3.90 -9.79 C -4.97 -14.35 -1.16 -16.75 1.98 -16.42 C 5.46 -16.17 8.36 -13.10 8.03 -9.79 C 7.78 -5.65 5.46 -0.68 3.80 2.63 C 2.98 4.28 2.98 5.94 3.22 6.77 C 3.56 8.01 4.63 8.92 6.29 8.84 C 7.53 8.75 8.36 8.42 8.77 7.76',
            'M -2.12 -0.35 C -2.12 -2.67 -3.98 -4.58 -6.34 -4.58 C -8.70 -4.58 -10.60 -2.67 -10.60 -0.35 C -10.60 1.97 -8.70 3.87 -6.34 3.87 C -3.98 3.87 -2.12 1.97 -2.12 -0.35 Z',
        ],
    },
    {
        name: 'Cancer', symbol: '♋', width: 1.79,
        strokes: [
            'M -1.72 -7.76 C -1.72 -10.57 -4.02 -12.86 -6.82 -12.86 C -9.63 -12.86 -11.92 -10.57 -11.92 -7.76 C -11.92 -4.96 -9.63 -2.66 -6.82 -2.66 C -4.02 -2.66 -1.72 -4.96 -1.72 -7.76 Z',
            'M -6.82 -12.86 C -3.34 -13.97 3.46 -13.97 7.71 -13.46 C 9.41 -13.29 10.43 -12.78 10.94 -12.10',
            'M 10.26 1.59 C 10.26 -1.22 7.97 -3.56 5.12 -3.56 C 2.27 -3.56 -0.02 -1.22 -0.02 1.59 C -0.02 4.39 2.27 6.73 5.12 6.73 C 7.97 6.73 10.26 4.39 10.26 1.59 Z',
            'M 5.12 6.73 C 1.76 7.79 -5.04 7.79 -9.29 7.28 C -11.16 7.11 -12.18 6.77 -12.86 6.26',
        ],
    },
    {
        name: 'Gemini', symbol: '♊', width: 2.23,
        strokes: [
            'M -11.46 -13.22 Q 0.75 -11.32 12.80 -13.22',
            'M -11.46 10.71 Q 0.75 8.16 12.80 10.71',
            'M -4.70 -11.90 L -4.70 8.73',
            'M 6.03 -11.90 L 6.03 8.73',
        ],
    },
    {
        name: 'Taurus', symbol: '♉', width: 2.16,
        strokes: [
            'M 8.25 2.48 C 8.25 -1.67 4.85 -5.07 0.71 -5.07 C -3.44 -5.07 -6.84 -1.67 -6.84 2.48 C -6.84 6.63 -3.44 10.03 0.71 10.03 C 4.85 10.03 8.25 6.63 8.25 2.48 Z',
            'M -2.69 -4.48 C -4.35 -6.14 -6.01 -8.63 -7.42 -10.70 C -8.33 -12.11 -9.99 -13.61 -11.40 -13.61',
            'M 4.27 -4.48 C 5.93 -6.14 7.59 -8.63 8.84 -10.70 C 9.75 -12.11 11.32 -13.61 12.65 -13.61',
        ],
    },
    {
        name: 'Aries', symbol: '♈', width: 2.0,
        strokes: [
            'M 0.50 0.96 C -0.25 -1.12 -1.09 -3.63 -1.92 -5.71 C -2.75 -8.22 -4.01 -11.14 -5.67 -12.81 C -6.93 -14.31 -8.34 -14.73 -9.68 -14.06 C -11.52 -13.14 -12.93 -11.14 -12.93 -9.05 C -12.77 -7.38 -12.35 -5.71 -11.52 -4.63',
            'M 0.50 0.96 C 1.25 -1.12 2.09 -3.63 2.92 -5.71 C 3.75 -8.22 5.01 -11.14 6.68 -12.81 C 7.93 -14.31 9.35 -14.73 10.68 -14.06 C 12.52 -13.14 14.02 -11.14 14.02 -9.05 C 13.85 -7.38 13.35 -5.71 12.35 -4.63',
            'M 0.50 0.96 L 0.50 10.56',
        ],
    },
];

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

interface CompiledGlyph { strokes: Path2D[]; fills: Path2D[]; width: number }
let compiled: CompiledGlyph[] | null = null;

function compile(): CompiledGlyph[] {
    if (!compiled) {
        compiled = ZODIAC_GLYPHS.map(g => ({
            width: g.width,
            strokes: g.strokes.map(d => new Path2D(d)),
            fills: (g.fills ?? []).map(d => new Path2D(d)),
        }));
    }
    return compiled;
}

/**
 * Draw the ring of twelve glyphs centred at (cx, cy) with dial scale `s`
 * (= mainR / 365). The context's current transform is honoured, so under the
 * static cache's dpr scale the strokes land on device pixels.
 */
export function drawZodiacRing(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    cx: number, cy: number, s: number,
    color: string = ZODIAC_COLOR,
): void {
    const glyphs = compile();
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    for (let i = 0; i < glyphs.length; i++) {
        const g = glyphs[i];
        const bottom = i > 3 && i < 9;                 // same rule as demiRadialTextCenter
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(i * Math.PI / 6);                  // slot i, clockwise from the top
        ctx.translate(0, -ZODIAC_RING_R * s);
        if (bottom) ctx.rotate(Math.PI);
        ctx.scale(s, s);
        ctx.lineWidth = g.width;
        for (const p of g.strokes) ctx.stroke(p);
        for (const p of g.fills) { ctx.fill(p); ctx.stroke(p); }
        ctx.restore();
    }
    ctx.restore();
}
