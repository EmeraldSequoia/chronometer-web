/**
 * Eclipse simulator for Observatory (Phase 7B).
 *
 * Port of EOEclipseView.mm (.observatory-ref/Classes/EOEclipseView.mm) plus the
 * five ring-indicator hands (EOHandView.mm:382-450, EOClock.mm:2176-2200).
 *
 * The disc is a small "telescope view" of the current geometry:
 *   - Solar side (near new moon): Sun disc with the Moon silhouette over it, or
 *     the totality image for a total solar eclipse.
 *   - Lunar side (near full moon): the Moon with Earth's umbral shadow drawn
 *     over it (multiply blend), plus the shadow outline.
 * It only draws when Sun and Moon (or shadow and Moon) are within 10°; otherwise
 * an "Eclipse Simulator" caption shows. A green overlay marks any below-horizon
 * portion — the *apparent* (refracted) horizon, anchored to the drawn eclipsed
 * body — and a "Below horizon" caption appears exactly when the wash has fully
 * closed over that body; see horizonOverlayState.
 *
 * Around the disc, five image markers ride an annular ring showing the
 * right-ascensions of the Sun, Moon, Earth-shadow (anti-solar), and the
 * ascending/descending lunar nodes; when the Sun and Moon markers coincide near
 * a node, an eclipse is imminent.
 *
 * All geometry is driven by obs-values that share ONE update sentinel
 * (EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION) so the disc stays mutually
 * consistent frame to frame and animates smoothly while scrubbing.
 *
 * Coordinate note: EOEclipseView is a plain (Y-down) UIView, so the iOS pixel
 * formulas — which already carry their "change in sign from view coordinate
 * system" adjustments — port literally into the Y-down canvas.
 */

// @ts-ignore — esbuild resolves .png as a data URL via --loader:.png=dataurl
import moonPng from '../shared/assets/moon300.png';
// @ts-ignore
import sunEclipsePng from '../shared/assets/sunEclipse.png';
// @ts-ignore
import totalEclipsePng from '../shared/assets/totalEclipse.png';
// @ts-ignore
import earthShadowPng from '../shared/assets/earthShadow.png';
// @ts-ignore
import ringSunPng from '../shared/assets/eclipseRingSun.png';
// @ts-ignore
import ringMoonPng from '../shared/assets/eclipseRingMoon.png';
// @ts-ignore
import ringEarthShadowPng from '../shared/assets/eclipseRingEarthShadow.png';
// @ts-ignore
import ringAscNodePng from '../shared/assets/eclipseRingAscNode.png';
// @ts-ignore
import ringDesNodePng from '../shared/assets/eclipseRingDesNode.png';

import type { LayoutParams } from './layout.js';
import type { ObsValueName } from './obs-values.js';
import type { Updater } from '../shared/updater.js';
import { EclipseKind, eclipseKindIsMoreSolarThanLunar } from '../astronomy/es-astro.js';
import { kECRefractionAtHorizonX } from '../astronomy/astro-constants.js';
import { drawText } from './draw-utils.js';
import { OUTER_DIAL_TITLE_RATIO } from './layout.js';

/**
 * "Eclipse Simulator" caption, on two lines so it fits the small disc, at the
 * shared outer-dial title size (OUTER_DIAL_TITLE_RATIO · the eclipse footprint).
 */
function drawEclipseCaption(
    ctx: CanvasRenderingContext2D, cx: number, cy: number, fontPx: number, color: string,
): void {
    const font = `${fontPx}px Arial, sans-serif`;
    // Line spacing: the line-height plus roughly the cap-height of the "E" in
    // "Eclipse", so the two lines breathe a bit.
    ctx.save();
    ctx.font = font;
    const capE = ctx.measureText('E').actualBoundingBoxAscent || fontPx * 0.72;
    ctx.restore();
    const lh = fontPx * 1.05 + capE;
    drawText(ctx, 'Eclipse', cx, cy - lh / 2, font, color);
    drawText(ctx, 'Simulator', cx, cy + lh / 2, font, color);
}

// ============================================================================
// Pixel-scale constants (port of EOEclipseView.mm:70-77)
// ============================================================================

const PERIGEE_DISTANCE_KM = 355000.0;
const AU_KM = 149600000.0;
const LUNAR_RADIUS_KM = 1737.10;
const SOLAR_RADIUS_KM = 695500;

const MOON_ANGULAR_RADIUS_AT_PERIGEE = Math.atan(LUNAR_RADIUS_KM / PERIGEE_DISTANCE_KM);

// iOS: moonRadiusAtPerigee = 20 px at reference eclipseR1 ≈ 49 px.
const IOS_REF_ECLIPSE_R1 = 49;
const IOS_MOON_RADIUS_AT_PERIGEE = 20;

// Image feature fractions (EOClock.mm:2160-2161).
const SUN_RADIUS_FRACTION = 68.0 / 316.0;        // totalEclipse.png: sun disc within image
const EARTH_SHADOW_RADIUS_FRACTION = 118.0 / 120.0; // earthShadow.png: umbra within image (1-px border)

const ECLIPSE_THRESHOLD = Math.PI / 18;          // 10°

// Natural (iOS @1x point) sizes of the ring marker images.
const RING_SIZE = {
    sun: 27,
    moon: 20,
    earthShadow: 20,
    ascNode: 15,
    desNode: 15,
};

// ============================================================================
// Module state
// ============================================================================

interface Img { el: HTMLImageElement; ready: boolean; }

function loadImg(src: string, name: string): Img {
    const rec: Img = { el: new Image(), ready: false };
    rec.el.onload = () => { rec.ready = true; };
    rec.el.onerror = () => { console.warn(`[EclipseView] Failed to load ${name}`); };
    rec.el.src = src;
    return rec;
}

let moonImg: Img, sunImg: Img, totalImg: Img, shadowImg: Img;
let ringSun: Img, ringMoon: Img, ringEarthShadow: Img, ringAscNode: Img, ringDesNode: Img;
let initialized = false;

/** Load the eight eclipse images (the Moon disc reuses moon300.png). */
export function initEclipseView(): void {
    if (initialized) return;
    moonImg = loadImg(moonPng as string, 'moon300.png');
    sunImg = loadImg(sunEclipsePng as string, 'sunEclipse.png');
    totalImg = loadImg(totalEclipsePng as string, 'totalEclipse.png');
    shadowImg = loadImg(earthShadowPng as string, 'earthShadow.png');
    ringSun = loadImg(ringSunPng as string, 'eclipseRingSun.png');
    ringMoon = loadImg(ringMoonPng as string, 'eclipseRingMoon.png');
    ringEarthShadow = loadImg(ringEarthShadowPng as string, 'eclipseRingEarthShadow.png');
    ringAscNode = loadImg(ringAscNodePng as string, 'eclipseRingAscNode.png');
    ringDesNode = loadImg(ringDesNodePng as string, 'eclipseRingDesNode.png');
    initialized = true;
}

// ============================================================================
// Helpers
// ============================================================================

function fmod(value: number, modulus: number): number {
    const r = value % modulus;
    return r < 0 ? r + modulus : r;
}

const TWO_PI = 2 * Math.PI;

/** Draw an image centered at (x, y) with the given pixel radius. */
function drawCentered(
    ctx: CanvasRenderingContext2D, img: HTMLImageElement,
    x: number, y: number, r: number,
): void {
    ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
}

/**
 * Place a ring-indicator image marker.
 *
 * iOS layer transform (EOHandView.mm:463-465): rotate(firstAngle) →
 * translate(0, radius) → rotate(glyph). UIKit layer coordinates are Y-down
 * with positive rotation clockwise on screen — the same convention as the
 * canvas — so the chain ports verbatim: the marker sits at `firstAngle`
 * clockwise from the bottom (firstAngle includes a +π for most markers,
 * putting RA = 0 at the top).
 *
 * The image itself is drawn with a Y flip: iOS renders the marker PNG through
 * setupContextForZeroOffsetAndScale, whose CGContextScaleCTM(scale, −scale)
 * flips the context, so UIImage drawInRect leaves the PNG vertically mirrored
 * within the marker view. This matters radially: the star in
 * eclipseRingSun.png sits ~4 px below the image center, and only the flipped
 * orientation puts its visible center on the outer rim (R2) as on iOS,
 * rather than 4 px outside it.
 */
function drawRingMarker(
    ctx: CanvasRenderingContext2D, marker: Img,
    cx: number, cy: number, radius: number,
    firstAngle: number, glyphAngle: number, size: number,
): void {
    if (!marker.ready) return;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(firstAngle);
    ctx.translate(0, radius);
    ctx.rotate(glyphAngle);
    ctx.scale(1, -1);
    ctx.drawImage(marker.el, -size / 2, -size / 2, size, size);
    ctx.restore();
}

// ============================================================================
// Drawing
// ============================================================================

/**
 * The two decisions the below-horizon overlay makes, as a pure function so the
 * fixture arithmetic is unit-testable (no canvas).
 *
 * **Overlay position.** The wash line is anchored to the *drawn primary body*:
 * the call site places the line at
 * `horizonPixelY = −apparentBodyAlt·ppar − bodyPixelY`, declaring that
 * wherever the composition drew the body IS its true altitude. What we *see*
 * near the horizon is the refracted image, so the body's altitude is lifted by
 * the engine's horizon-refraction constant (34′) — `kECRefractionAtHorizonX`
 * rather than an altitude-dependent formula, deliberately: it is the
 * refraction convention the rest of the engine lives by (`altitudeAtRiseSet`,
 * and hence `calculateEclipse`'s "not up" test). The lift is unconditional;
 * away from the horizon the line is clamped off-disc anyway.
 *
 * Body-anchoring (2026-08-30, plan §12) replaced anchoring at the scene
 * midpoint's altitude: the lunar composition centers the *action* (the Moon
 * sits at `sinθ·(sep − shadowR)·ppar/2`, offset `sinθ·shadowR/2` from the
 * altitude map), so a midpoint-anchored line let a drawn sliver of Moon peek
 * above the wash while the caption below was already up. With the body as the
 * anchor, `bodyPixelY` cancels out of the closure test and the drawn top limb
 * meets the line exactly when `bodyAlt + 34′ + bodyAngularRadius = 0` — the
 * caption predicate — so wash, caption, and the engine's rise/set instant
 * agree pixel-exactly in both branches. The umbra outline (a geometric
 * construct, not a visible sky object) absorbs the composition offset
 * instead; the Moon silhouette absorbs a sub-pixel one in the solar branch.
 *
 * **Caption.** "Below horizon" shows exactly when the wash has fully closed
 * over the *primary* body — the Sun in the solar branch, the Moon in the lunar
 * one. In angle space that closure is `bodyAlt + 34′ + bodyAngularRadius ≤ 0`,
 * which is precisely the engine's topocentric rise/set altitude
 * (`altitudeAtRiseSet(…, wantGeocentricAltitude=false)`), so the caption flips
 * at the body's rise/set instant. It is deliberately NOT gated on the eclipse
 * kind (as it was 2026-08-18..28): `EclipseKind` is a Basel-wheel display
 * value, and `calculateEclipse`'s needle-pegging override rewrites
 * `SolarNotUp`/`LunarNotUp` to `None…` whenever the separation pegs the
 * wheel's needle at the top of its 0–3 scale (the high end only; the low-end
 * clamp leaves the kind alone) — a band the disc keeps drawing in, which left
 * fully-green discs uncaptioned for hours (planning/2026-08-28-eclipse-below-
 * horizon-caption.md). The wash keeps its own life: it can cover part of a
 * disc with no caption — that is the point of it.
 *
 * @param bodyAlt True topocentric altitude of the primary (eclipsed) body.
 * @param bodyAngularRadius The primary body's topocentric angular radius (rad).
 */
export function horizonOverlayState(
    bodyAlt: number, bodyAngularRadius: number,
): {
    apparentBodyAlt: number;
    showLabel: boolean;
} {
    return {
        apparentBodyAlt: bodyAlt + kECRefractionAtHorizonX,
        showLabel: bodyAlt + kECRefractionAtHorizonX + bodyAngularRadius <= 0,
    };
}

/**
 * Draw the eclipse simulator disc, caption/horizon labels, and ring hands.
 *
 * @param ctx Main canvas 2D context (layout/CSS-pixel space)
 * @param L   Layout params (eclipseCX/CY/R1/R2, eclipseFontSize)
 * @param u   Observatory animated value updater
 */
export function drawEclipseView(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
    u: Updater<ObsValueName>,
): void {
    if (!initialized) return;

    const cx = L.eclipseCX, cy = L.eclipseCY;
    const viewR = L.eclipseR1;
    const s = viewR / IOS_REF_ECLIPSE_R1;
    // Caption font tracks the eclipse footprint (eclipseR2 = the outer-dial
    // radius), same rule as the other dial titles.
    const captionFontPx = OUTER_DIAL_TITLE_RATIO * L.eclipseR2;
    const captionColor = 'rgba(255,255,255,1)';   // match the dial titles (full white)

    // Always draw the ring markers (they track even when no eclipse is near).
    drawRingHands(ctx, L, u, s);

    const separation = u.get('eclSeparation').currentValue;

    // Gate: nothing to draw in the disc unless within 10°.
    if (separation >= ECLIPSE_THRESHOLD) {
        drawEclipseCaption(ctx, cx, cy, captionFontPx, captionColor);
        return;
    }

    // --- Pixel scale ---
    const moonRadiusAtPerigee = IOS_MOON_RADIUS_AT_PERIGEE * s;
    const ppar = moonRadiusAtPerigee / MOON_ANGULAR_RADIUS_AT_PERIGEE;
    const moonDist = u.get('eclMoonDist').currentValue;
    const sunDist = u.get('eclSunDist').currentValue;
    const moonAngularRadius = Math.atan(LUNAR_RADIUS_KM / (moonDist * AU_KM));
    const sunAngularRadius = Math.atan(SOLAR_RADIUS_KM / (sunDist * AU_KM));
    const moonPixelRadius = ppar * moonAngularRadius;
    const sunPixelRadius = ppar * sunAngularRadius;

    const kind = Math.round(u.get('eclKind').currentValue) as EclipseKind;
    const solarNotLunar = eclipseKindIsMoreSolarThanLunar(kind);

    const sunAlt = u.get('eclSunAlt').currentValue;
    const moonAlt = u.get('eclMoonAlt').currentValue;
    const sunAz = u.get('eclSunAz').currentValue;
    const moonAz = fmod(u.get('eclMoonAz').currentValue, TWO_PI);

    let horizonPixelY = 0;
    let washClosedOverBody = false;
    let drawingSomething = false;

    ctx.save();
    // Clip to the disc circle, origin at the disc center.
    ctx.beginPath();
    ctx.arc(cx, cy, viewR, 0, TWO_PI);
    ctx.clip();
    ctx.translate(cx, cy);

    if (solarNotLunar) {
        const sunAzM = fmod(sunAz, TWO_PI);
        let azDelta = fmod(moonAz - sunAzM, TWO_PI);
        if (azDelta > Math.PI) azDelta -= TWO_PI;
        const altDelta = moonAlt - sunAlt;
        const avgAlt = (moonAlt + sunAlt) / 2;
        const azFudge = Math.max(0.01, Math.abs(Math.cos(avgAlt)));
        const theta = Math.atan2(altDelta, azDelta * azFudge);

        const cosTheta = Math.cos(theta), sinTheta = Math.sin(theta);
        const moonPixelX = cosTheta * separation * ppar / 2;
        const sunPixelX = -moonPixelX;
        const moonPixelY = -sinTheta * separation * ppar / 2;
        const sunPixelY = -moonPixelY;
        // Wash line anchored to the drawn Sun (see horizonOverlayState).
        const horizon = horizonOverlayState(sunAlt, sunAngularRadius);
        horizonPixelY = -horizon.apparentBodyAlt * ppar - sunPixelY;
        washClosedOverBody = horizon.showLabel;

        if (kind === EclipseKind.TotalSolar) {
            const totalR = moonPixelRadius / SUN_RADIUS_FRACTION;
            if (totalImg.ready) drawCentered(ctx, totalImg.el, moonPixelX, moonPixelY, totalR);
            drawingSomething = true;
        } else {
            const distMoon = Math.hypot(moonPixelX, moonPixelY);
            const distSun = distMoon; // opposite points
            drawingSomething = (distMoon - moonPixelRadius < viewR) || (distSun - sunPixelRadius < viewR);

            if (sunImg.ready) drawCentered(ctx, sunImg.el, sunPixelX, sunPixelY, sunPixelRadius);
            // Moon silhouette over the Sun.
            ctx.beginPath();
            ctx.ellipse(moonPixelX, moonPixelY, moonPixelRadius, moonPixelRadius, 0, 0, TWO_PI);
            ctx.fillStyle = 'rgba(20,20,23,1)';     // (.08,.08,.09)
            ctx.strokeStyle = 'rgba(255,255,255,0.15)';
            ctx.lineWidth = 0.5 * s;
            ctx.fill();
            ctx.stroke();
        }
    } else {
        const earthShadowAlt = -sunAlt;
        const earthShadowAz = fmod(sunAz + Math.PI, TWO_PI);
        const shadowR = u.get('eclShadowSize').currentValue / 2;

        let azDelta = fmod(earthShadowAz - moonAz, TWO_PI);
        if (azDelta > Math.PI) azDelta -= TWO_PI;
        const altDelta = earthShadowAlt - moonAlt;
        const avgAlt = (earthShadowAlt + moonAlt) / 2;

        let moonPixelX: number, moonPixelY: number;
        let earthShadowPixelX: number, earthShadowPixelY: number;
        if (separation > shadowR) {
            const azFudge = Math.max(0.01, Math.abs(Math.cos(avgAlt)));
            const theta = Math.atan2(altDelta, azDelta * azFudge);
            const cosTheta = Math.cos(theta), sinTheta = Math.sin(theta);
            moonPixelX = -cosTheta * (separation - shadowR) * ppar / 2;
            earthShadowPixelX = cosTheta * (separation + shadowR) * ppar / 2;
            moonPixelY = sinTheta * (separation - shadowR) * ppar / 2;
            earthShadowPixelY = -sinTheta * (separation + shadowR) * ppar / 2;
        } else {
            const azFudge = Math.max(0.01, Math.abs(Math.cos(moonAlt)));
            const theta = Math.atan2(altDelta, azDelta * azFudge);
            const cosTheta = Math.cos(theta), sinTheta = Math.sin(theta);
            moonPixelX = 0;
            moonPixelY = 0;
            earthShadowPixelX = cosTheta * separation * ppar;
            earthShadowPixelY = -sinTheta * separation * ppar;
        }

        // Wash line anchored to the drawn Moon (see horizonOverlayState).
        const horizon = horizonOverlayState(moonAlt, moonAngularRadius);
        horizonPixelY = -horizon.apparentBodyAlt * ppar - moonPixelY;
        washClosedOverBody = horizon.showLabel;

        // 1. Earth-shadow outline (true shadow radius), filled dark.
        const shadowPixelRadius = ppar * shadowR;
        ctx.beginPath();
        ctx.ellipse(earthShadowPixelX, earthShadowPixelY, shadowPixelRadius, shadowPixelRadius, 0, 0, TWO_PI);
        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 0.5 * s;
        ctx.fill();
        ctx.stroke();

        // 2. The Moon, rotated to its sky orientation.
        if (moonImg.ready) {
            const moonRel = u.get('eclMoonRelAngle').currentValue;
            ctx.save();
            ctx.translate(moonPixelX, moonPixelY);
            ctx.rotate(moonRel);
            drawCentered(ctx, moonImg.el, 0, 0, moonPixelRadius);
            ctx.restore();
        }

        // 3. Shadow over the Moon, clipped to the Moon, multiply blend.
        const shadowImageRadius = ppar * shadowR / EARTH_SHADOW_RADIUS_FRACTION;
        if (shadowImg.ready) {
            ctx.save();
            ctx.beginPath();
            ctx.ellipse(moonPixelX, moonPixelY, moonPixelRadius, moonPixelRadius, 0, 0, TWO_PI);
            ctx.clip();
            ctx.globalCompositeOperation = 'multiply';
            drawCentered(ctx, shadowImg.el, earthShadowPixelX, earthShadowPixelY, shadowImageRadius);
            ctx.restore();
        }

        const distMoon = Math.hypot(moonPixelX, moonPixelY);
        const distShadow = Math.hypot(earthShadowPixelX, earthShadowPixelY);
        drawingSomething = (distMoon - moonPixelRadius < viewR) || (distShadow - shadowImageRadius < viewR);
    }

    // --- Below-horizon green overlay (port L291-308, with the refraction lift
    // and the closure-gated caption; see horizonOverlayState) ---
    const showHorizonLabel = drawingSomething && washClosedOverBody;
    if (drawingSomething && horizonPixelY > -viewR) {
        if (horizonPixelY > viewR) horizonPixelY = viewR;
        ctx.fillStyle = 'rgba(0,76,0,0.5)';   // (0, 0.3, 0, 0.5)
        // Fill the below-horizon region. iOS: CGRectMake(-w/2, -horizonPixelY, w, h)
        // — the fill origin is −horizonPixelY (the height h = 2·viewR then covers
        // the whole disc when the bodies are fully below the horizon).
        ctx.fillRect(-viewR, -horizonPixelY, viewR * 2, viewR * 2);
    }

    ctx.restore();   // remove clip + translate

    // Labels (drawn on top, in screen space).
    if (showHorizonLabel) {
        drawText(ctx, 'Below horizon', cx, cy, `${captionFontPx}px Arial, sans-serif`, captionColor);
    } else if (!drawingSomething) {
        drawEclipseCaption(ctx, cx, cy, captionFontPx, captionColor);
    }
}

/** Draw the five ring-indicator image markers (port EOHandView.mm:382-450). */
function drawRingHands(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
    u: Updater<ObsValueName>,
    s: number,
): void {
    const cx = L.eclipseCX, cy = L.eclipseCY;
    const R1 = L.eclipseR1, R2 = L.eclipseR2;
    const mid = (R1 + R2) / 2;

    const sunRA = u.get('eclRingSunRA').currentValue;
    const moonRA = u.get('eclRingMoonRA').currentValue;
    const nodeRA = u.get('eclRingNodeRA').currentValue;

    // Sun marker — outside the ring.
    drawRingMarker(ctx, ringSun, cx, cy, R2 + 4 * s, Math.PI + sunRA, 0, RING_SIZE.sun * s);
    // Moon marker — inside the ring; glyph spun by RA(Sun)−RA(Moon) (iOS).
    drawRingMarker(ctx, ringMoon, cx, cy, R1 - 1 * s, Math.PI + moonRA, sunRA - moonRA, RING_SIZE.moon * s);
    // Earth shadow — anti-solar (no +π), inside the ring.
    drawRingMarker(ctx, ringEarthShadow, cx, cy, R1 - 1 * s, sunRA, 0, RING_SIZE.earthShadow * s);
    // Ascending node (+π) and descending node, mid-ring.
    drawRingMarker(ctx, ringAscNode, cx, cy, mid, Math.PI + nodeRA, 0, RING_SIZE.ascNode * s);
    drawRingMarker(ctx, ringDesNode, cx, cy, mid, nodeRA, 0, RING_SIZE.desNode * s);
}
