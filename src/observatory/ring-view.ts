/**
 * Observatory rise/set ring rendering.
 *
 * Draws colored arc segments showing above-horizon time for each planet,
 * and the full sky-color ring for the Sun.
 *
 * Port of: EORingView.mm (EOClock.mm L2032–2044 for configuration)
 *
 * Ring layers (outer to inner, matching iOS):
 *   Sun    — widest ring (~64px iOS), altitude-color gradient for 24h
 *   Saturn — 8px, cyan day arc
 *   Jupiter — 8px, green day arc
 *   Mars   — 8px, pink day arc
 *   Venus  — 8px, white day arc
 *   Mercury — 8px, salmon day arc
 *   Moon   — 8px, blue day arc
 *
 * The Sun ring uses a conic gradient with fixed colors at animated angular
 * positions. Each position corresponds to a specific sun altitude threshold
 * (-18°, -9°, sunrise±ε, +1°, +9°, +30°) for both morning and evening
 * sides, plus noon/midnight anchors with computed colors. Positions are
 * ObsValues that animate smoothly and update at sunrise/sunset sentinels.
 *
 * Planet rings use rise/set angles via dayNightLeafAngle(planet, 0/1, 0)
 * (which IS the same underlying function as iOS planetrise24HourIndicatorAngle).
 */

import type { LayoutParams } from './layout.js';
import type { Environment } from '../expr/env.js';
import type { ObsValueName, RingPlanetKey } from './obs-values.js';
import { SUN_RING_NAMES } from './obs-values.js';
import type { Updater } from '../shared/updater.js';
import { ECPlanetNumber } from '../astronomy/astro-constants.js';
import { cachelessPlanetAlt } from '../astronomy/es-astro.js';
import { drawCircularText } from './draw-utils.js';

const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;

/** Linearly interpolate between two `rgba(r,g,b,a)` CSS color strings. */
function lerpColor(c1: string, c2: string, t: number): string {
    const parse = (s: string) => {
        const m = s.match(/rgba?\((\d+),(\d+),(\d+),?([\d.]*)\)/);
        return m ? [+m[1], +m[2], +m[3], m[4] !== '' ? +m[4] : 1] : [0, 0, 0, 1];
    };
    const a = parse(c1);
    const b = parse(c2);
    return `rgba(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)},${(a[3] + (b[3] - a[3]) * t).toFixed(3)})`;
}


// ---------------------------------------------------------------------------
// Sky-color gradient for Sun ring
// ---------------------------------------------------------------------------

/**
 * Altitude-based color gradient steps.
 * Port of: EORingView.mm L54–71 (gradientSteps[])
 */
interface GradientStep {
    alt: number;  // degrees
    r: number;
    g: number;
    b: number;
    a: number;
}

const GRADIENT_STEPS: GradientStep[] = [
    { alt: -90.01, r: 0.125, g: 0.125, b: 0.125, a: 0 },    // full night
    { alt: -30,    r: 0.125, g: 0.125, b: 0.125, a: 0 },
    { alt: -9,     r: 0.00,  g: 0.00,  b: 0.39,  a: 1 },
    { alt: -1,     r: 0.17,  g: 0.77,  b: 0.84,  a: 1 },
    { alt: -0.5,   r: 0.84,  g: 0.00,  b: 0.00,  a: 1 },
    { alt:  1,     r: 0.94,  g: 0.42,  b: 0.00,  a: 1 },
    { alt:  9,     r: 1.00,  g: 1.00,  b: 0.00,  a: 1 },
    { alt: 30,     r: 0.90,  g: 0.90,  b: 1.00,  a: 1 },
    { alt: 90.01,  r: 0.90,  g: 0.90,  b: 1.00,  a: 1 },
];

/**
 * Interpolate color from the altitude gradient.
 * Port of: EORingView.mm L73–100
 *
 * @param altRad  Altitude in radians
 * @returns CSS rgba color string
 */
function colorForAltitude(altRad: number): string {
    const altDeg = altRad * 180 / Math.PI;
    const alt = Math.max(-90, Math.min(90, altDeg));

    let i = 0;
    while (i < GRADIENT_STEPS.length - 1 && GRADIENT_STEPS[i].alt <= alt) {
        i++;
    }
    const j = Math.max(0, i - 1);

    const stepWidth = GRADIENT_STEPS[i].alt - GRADIENT_STEPS[j].alt;
    const fraction = stepWidth > 0 ? (alt - GRADIENT_STEPS[j].alt) / stepWidth : 0;

    const r = GRADIENT_STEPS[j].r + (GRADIENT_STEPS[i].r - GRADIENT_STEPS[j].r) * fraction;
    const g = GRADIENT_STEPS[j].g + (GRADIENT_STEPS[i].g - GRADIENT_STEPS[j].g) * fraction;
    const b = GRADIENT_STEPS[j].b + (GRADIENT_STEPS[i].b - GRADIENT_STEPS[j].b) * fraction;
    const a = GRADIENT_STEPS[j].a + (GRADIENT_STEPS[i].a - GRADIENT_STEPS[j].a) * fraction;

    return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a.toFixed(3)})`;
}

// ---------------------------------------------------------------------------
// Planet ring configuration
// ---------------------------------------------------------------------------

interface PlanetRingConfig {
    planet: ECPlanetNumber;
    outerOffset: number;  // iOS px from plR
    width: number;        // iOS px ring width
    dayColor: string;
    nightColor: string | null;
}

/**
 * Ring configuration matching iOS EOClock.mm L2032–2044.
 */
const PLANET_RINGS: PlanetRingConfig[] = [
    { planet: ECPlanetNumber.Saturn,  outerOffset: 2,  width: 8, dayColor: 'rgba(169,252,252,1)', nightColor: null },
    { planet: ECPlanetNumber.Jupiter, outerOffset: 12, width: 8, dayColor: 'rgba(169,252,169,1)', nightColor: null },
    { planet: ECPlanetNumber.Mars,    outerOffset: 22, width: 8, dayColor: 'rgba(252,169,252,1)', nightColor: null },
    { planet: ECPlanetNumber.Venus,   outerOffset: 32, width: 8, dayColor: 'rgba(255,255,255,1)', nightColor: null },
    { planet: ECPlanetNumber.Mercury, outerOffset: 42, width: 8, dayColor: 'rgba(252,169,169,1)', nightColor: null },
    { planet: ECPlanetNumber.Moon,    outerOffset: 52, width: 8, dayColor: 'rgba(169,169,252,1)', nightColor: null },
];

/**
 * Planet name strings for ring labels.
 * Port of: EORingView.mm L367-399 (switch statement)
 */
const PLANET_NAMES: Partial<Record<ECPlanetNumber, string>> = {
    [ECPlanetNumber.Moon]: 'Moon',
    [ECPlanetNumber.Mercury]: 'Mercury',
    [ECPlanetNumber.Venus]: 'Venus',
    [ECPlanetNumber.Mars]: 'Mars',
    [ECPlanetNumber.Jupiter]: 'Jupiter',
    [ECPlanetNumber.Saturn]: 'Saturn',
};

interface RingCacheEntry {
    riseAngle: number;
    setAngle: number;
    transitAngle: number;
    riseValid: boolean;
    setValid: boolean;
    aboveHorizon: boolean;
}

const ringCache = new Map<ECPlanetNumber, RingCacheEntry>();

// ---------------------------------------------------------------------------
// Sun ring rendering — conic gradient with animated color stops
// ---------------------------------------------------------------------------

/**
 * Fixed color for each sun ring altitude stop.
 * Index matches the order of sunRing ObsValues in obs-values.ts:
 *   [0..6] = morning side (-18°, -9°, -1°, -0.5°, +1°, +9°, +30°)
 *   [7..13] = evening side (+30°, +9°, +1°, -0.5°, -1°, -9°, -18°)
 *   [14] = noon (color computed at render time)
 *   [15] = midnight (color computed at render time)
 */
const SUN_RING_COLORS: (string | null)[] = [
    // Morning (night → day): indices 0–6
    'rgba(32,32,32,1)',       // -18°: end of astronomical twilight (full night)
    'rgba(0,0,100,1)',        // -9°: dark blue
    'rgba(43,196,214,1)',     // sunrise - ε: light cyan (night side)
    'rgba(214,0,0,1)',        // sunrise + ε: red (day side)
    'rgba(240,107,0,1)',      // +1°: orange
    'rgba(255,255,0,1)',      // +9°: yellow (golden hour)
    'rgba(230,230,255,1)',    // +30°: pale blue-white (full day)
    // Evening (day → night): indices 7–13
    'rgba(230,230,255,1)',    // +30°: pale blue-white
    'rgba(255,255,0,1)',      // +9°: yellow
    'rgba(240,107,0,1)',      // +1°: orange
    'rgba(214,0,0,1)',        // sunset - ε: red (day side)
    'rgba(43,196,214,1)',     // sunset + ε: light cyan (night side)
    'rgba(0,0,100,1)',        // -9°: dark blue
    'rgba(32,32,32,1)',       // -18°: end of astronomical twilight (full night)
    // Anchor points: colors computed at render time
    null,  // noon — computed
    null,  // midnight — computed
];

/**
 * Draw the sun ring using a conic gradient with animated color stop positions.
 *
 * Each color stop has a fixed color (from the gradient table) at an animated
 * angular position (from the ObsValue system). The conic gradient interpolates
 * smoothly between stops.
 *
 * Noon/midnight anchor points always exist; their colors are computed from
 * the actual sun altitude at those times (important for polar regions).
 *
 * @param ctx  Canvas 2D context
 * @param L    Layout parameters
 * @param u    Observatory value updater (sun ring stop angles)
 * @param noonOnTop  Whether noon is at the top of the dial (the stop angles
 *                   carry a +π offset that must be removed for anchor colors)
 * @param now  Current display time
 * @param lat  Observer latitude in degrees
 * @param lng  Observer longitude in degrees
 * @param tzOffsetSeconds  Timezone offset from UTC in seconds
 */
function drawSunRingGradient(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
    u: Updater<ObsValueName>,
    noonOnTop: boolean,
    now: Date,
    lat: number,
    lng: number,
    tzOffsetSeconds: number,
): void {
    const cx = L.mainCX;
    const cy = L.mainCY;
    const outerR = L.plR;
    const innerR = L.plR - L.sunRingWidth;
    const centerR = (outerR + innerR) / 2;
    const ringWidth = outerR - innerR;

    // Collect valid stops: (angle, color) pairs. SUN_RING_NAMES is in the same
    // order as SUN_RING_COLORS, so index `i` selects matching name + color.
    const stops: { angle: number; color: string }[] = [];

    for (let i = 0; i < SUN_RING_NAMES.length; i++) {
        const val = u.get(SUN_RING_NAMES[i]).currentValue;
        if (isNaN(val)) continue;  // skip invalid stops (polar regions)

        let color = SUN_RING_COLORS[i];
        if (color === null) {
            // Noon or midnight anchor — compute color from actual sun altitude.
            // Convert the ObsValue's dial angle back to a time, then compute altitude.
            // The time-of-day mapping is angle / (2π) * 24 = hours since midnight,
            // but val includes the `+ pi * noonOnTop` dial offset from the
            // expression — remove it first, or the altitude (and hence the
            // anchor color) is computed 12 hours off.
            const latRad = lat * Math.PI / 180;
            const lngRad = lng * Math.PI / 180;

            // Convert dial angle to seconds since midnight (local time)
            let angleNorm = (val - (noonOnTop ? Math.PI : 0)) % TWO_PI;
            if (angleNorm < 0) angleNorm += TWO_PI;
            const secSinceMidnight = (angleNorm / TWO_PI) * 86400;

            // Convert to Apple epoch time
            const unixNow = now.getTime() / 1000;
            const localNow = unixNow + tzOffsetSeconds;
            const localMidnight = Math.floor(localNow / 86400) * 86400;
            const targetUnix = localMidnight + secSinceMidnight - tzOffsetSeconds;
            const targetDI = targetUnix - 978307200;  // Unix to Apple epoch

            const alt = cachelessPlanetAlt(ECPlanetNumber.Sun, targetDI, latRad, lngRad);
            // Force alpha=1: the GRADIENT_STEPS table has alpha=0 for deep
            // night (original iOS made the ring transparent there), but our
            // conic gradient ring should always be fully opaque.
            color = colorForAltitude(alt).replace(/,[\d.]+\)$/, ',1)');
        }

        stops.push({ angle: val, color });
    }

    if (stops.length < 2) return;  // nothing to draw

    // Sort stops by angle (ascending)
    stops.sort((a, b) => a.angle - b.angle);

    // Build conic gradient.
    // createConicGradient startAngle is in canvas coordinates (0 = 3 o'clock).
    // Our angles are clock angles (0 = 12 o'clock = top).
    // Canvas angle = clockAngle - π/2.
    // Using startAngle = -π/2 means offset 0.0 maps to clock angle 0 (top).
    const grad = ctx.createConicGradient(-HALF_PI, cx, cy);

    // Helper to compute normalized offset from clock angle
    const angleToOffset = (angle: number): number => {
        let a = angle % TWO_PI;
        if (a < 0) a += TWO_PI;
        return a / TWO_PI;
    };

    for (const stop of stops) {
        grad.addColorStop(angleToOffset(stop.angle), stop.color);
    }

    // Canvas conic gradients clamp at the boundary: the region from the
    // last stop to offset 1.0 and from 0.0 to the first stop shows a
    // solid color (no interpolation). Bridge this gap by computing the
    // interpolated color at offset 0.0/1.0 between the last and first stops.
    const firstStop = stops[0];
    const lastStop = stops[stops.length - 1];
    const firstOffset = angleToOffset(firstStop.angle);
    const lastOffset = angleToOffset(lastStop.angle);
    const gapSize = (1 - lastOffset) + firstOffset;  // total gap across boundary
    if (gapSize > 0.001) {
        const frac = (1 - lastOffset) / gapSize;  // fraction at offset 0.0
        const boundaryColor = lerpColor(lastStop.color, firstStop.color, frac);
        grad.addColorStop(0, boundaryColor);
        grad.addColorStop(1, boundaryColor);
    }

    ctx.save();
    ctx.strokeStyle = grad;
    ctx.lineWidth = ringWidth;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(cx, cy, centerR, 0, TWO_PI);
    ctx.stroke();
    ctx.restore();
}

// ---------------------------------------------------------------------------
// Planet ring rendering
// ---------------------------------------------------------------------------

/**
 * Map from ring config index (aligned with PLANET_RINGS) to the ObsValue name
 * prefix for that planet's ring values (e.g. `saturn` → `saturnRise`, …).
 */
const RING_VALUE_KEYS: RingPlanetKey[] = [
    'saturn', 'jupiter', 'mars', 'venus', 'mercury', 'moon',
];

/**
 * Update the planet ring cache from ObsValues.
 *
 * Reads pre-computed rise/set/transit angles and validity flags from the Updater.
 * Validity flags come from the dayNightLeafAngleIsRiseSet and dayNightLeafAngleAboveHorizon
 * expression functions, which share the compute-once cache in astro-env.ts.
 */
function updateRingCache(env: Environment, u: Updater<ObsValueName>): void {
    for (let i = 0; i < PLANET_RINGS.length; i++) {
        const ring = PLANET_RINGS[i];
        const key = RING_VALUE_KEYS[i];

        const riseAngle = u.get(`${key}Rise`).currentValue;
        const setAngle = u.get(`${key}Set`).currentValue;
        const transitAngle = u.get(`${key}Transit`).currentValue;

        const riseValid = u.get(`${key}RiseValid`).currentValue > 0.5;   // dayNightLeafAngleIsRiseSet(pn, 0)
        const setValid = u.get(`${key}SetValid`).currentValue > 0.5;     // dayNightLeafAngleIsRiseSet(pn, 1)
        const aboveHorizon = u.get(`${key}AboveHorizon`).currentValue > 0.5; // dayNightLeafAngleAboveHorizon(pn, 0)

        ringCache.set(ring.planet, {
            riseAngle,
            setAngle,
            transitAngle,
            riseValid,
            setValid,
            aboveHorizon,
        });
    }
}

/**
 * Draw a single planet's rise/set arc ring.
 *
 * Port of: EORingView.mm L311–429 (planet ring drawRect, non-sun branch)
 *
 * iOS angle conversion:
 *   riseAngle = halfPi - riseAngle   (clock → CG)
 *   setAngle  = halfPi - setAngle
 *   CGContextAddArc(ctx, 0, 0, centerR, riseAngle, setAngle, 1)
 *
 * In iOS UIKit (Y-down), clockwise=1 draws **counterclockwise on screen**.
 * Canvas equivalent: anticlockwise=true.
 */
function drawPlanetRing(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
): void {
    const s = L.mainR / 365;
    const cx = L.mainCX;
    const cy = L.mainCY;

    for (const ring of PLANET_RINGS) {
        const outerR = L.plR - ring.outerOffset * s;
        const innerR = outerR - ring.width * s;
        const centerR = (outerR + innerR) / 2;
        const lineW = outerR - innerR;

        const cache = ringCache.get(ring.planet);
        if (!cache) continue;

        let riseAngle = cache.riseAngle;
        let setAngle = cache.setAngle;
        let drawLabelOnly = false;

        if (!cache.riseValid || !cache.setValid) {
            if (cache.aboveHorizon) {
                // Always above: draw complete loop
                // iOS: riseAngle = fmod(transitAngle - PI + 0.0001, 2π)
                //      setAngle  = fmod(transitAngle + PI - 0.0001, 2π)
                riseAngle = ((cache.transitAngle - Math.PI + 0.0001) % TWO_PI + TWO_PI) % TWO_PI;
                setAngle = ((cache.transitAngle + Math.PI - 0.0001) % TWO_PI + TWO_PI) % TWO_PI;
            } else {
                drawLabelOnly = true;
            }
        }

        ctx.save();
        ctx.lineWidth = lineW;
        ctx.lineCap = 'butt';

        if (!drawLabelOnly) {
            // Convert clock angles to Canvas arc angles.
            // iOS uses halfPi - clockAngle because CG angles are Y-up and UIKit
            // flips Y, making halfPi = TOP. Canvas Y-down has halfPi = BOTTOM,
            // so the correct conversion is clockAngle - HALF_PI.
            const canvasRise = riseAngle - HALF_PI;
            const canvasSet = setAngle - HALF_PI;

            // Day arc: from rise to set (clockwise on dial = CW in canvas)
            ctx.strokeStyle = ring.dayColor;
            ctx.beginPath();
            ctx.arc(cx, cy, centerR, canvasRise, canvasSet);
            ctx.stroke();

            // Night arc (if color specified)
            if (ring.nightColor) {
                ctx.strokeStyle = ring.nightColor;
                ctx.beginPath();
                ctx.arc(cx, cy, centerR, canvasSet, canvasRise);
                ctx.stroke();
            }

            // Transit diamond marker
            // iOS: EORingView.mm L415-428
            const canvasTransit = cache.transitAngle - HALF_PI;
            const dc = 9.0 / 20 * TWO_PI / 360;  // half-width in radians
            const midR = (outerR + innerR) / 2;
            const ct = Math.cos(canvasTransit);
            const st = Math.sin(canvasTransit);

            ctx.lineWidth = 0.33 * s;
            ctx.strokeStyle = `rgba(50,50,50,0.5)`;
            ctx.fillStyle = `rgba(50,50,50,0.5)`;
            ctx.beginPath();
            ctx.moveTo(cx + innerR * ct, cy + innerR * st);
            ctx.lineTo(cx + midR * Math.cos(canvasTransit - dc), cy + midR * Math.sin(canvasTransit - dc));
            ctx.lineTo(cx + outerR * ct, cy + outerR * st);
            ctx.lineTo(cx + midR * Math.cos(canvasTransit + dc), cy + midR * Math.sin(canvasTransit + dc));
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }

        // Planet name labels
        // Port of: EORingView.mm L367-412
        const pName = PLANET_NAMES[ring.planet];
        if (pName) {
            const labelFont = `${8 * s}px Arial, sans-serif`;
            const labelRadius = centerR;  // drawCircularText centers text visually at this radius

            if (drawLabelOnly) {
                // Planet below horizon: draw name at transit angle in day color
                drawCircularText(ctx, pName, cx, cy, labelRadius,
                    cache.transitAngle, 0, labelFont, ring.dayColor, true);
            } else {
                // Draw name at rise and set endpoints
                drawCircularText(ctx, pName, cx, cy, labelRadius,
                    cache.riseAngle, Math.PI / 40, labelFont, '#000000', true);
                drawCircularText(ctx, pName, cx, cy, labelRadius,
                    cache.setAngle, -Math.PI / 40, labelFont, '#000000', true);
            }
        }

        ctx.restore();
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Draw all rise/set rings on the orrery.
 *
 * @param ctx       Canvas 2D context (already at DPR scale)
 * @param L         Layout parameters
 * @param env       Astronomy environment (for aboveHorizon check in planet rings)
 * @param noonOnTop Whether noon is at the top of the dial
 * @param now       Current display time (for sun ring noon/midnight anchor colors)
 * @param lat       Observer latitude in degrees (for sun ring anchor altitude)
 * @param lon       Observer longitude in degrees (for sun ring anchor altitude)
 * @param tzOffsetSeconds  Timezone offset from UTC in seconds
 * @param u         Observatory value updater (planet ring and sun ring angles)
 */
export function drawRiseSetRings(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
    env: Environment,
    noonOnTop: boolean,
    now: Date,
    lat: number,
    lon: number,
    tzOffsetSeconds: number,
    u: Updater<ObsValueName>,
): void {
    // Update planet ring cache from ObsValues
    updateRingCache(env, u);

    // 1. Sun ring (conic gradient with animated color stop positions)
    drawSunRingGradient(ctx, L, u, noonOnTop, now, lat, lon, tzOffsetSeconds);

    // 2. Planet rings (simple rise/set arcs)
    drawPlanetRing(ctx, L);
}

/**
 * Force ring cache to recompute on next draw.
 * Call when location, timezone, or noonOnTop changes.
 */
export function invalidateRingCache(): void {
    // Planet ring cache is cleared implicitly by ObsValue reset.
    // No sun ring cache to clear (rendered from ObsValues each frame).
}
