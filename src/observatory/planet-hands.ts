/**
 * Observatory planet hand rendering.
 *
 * Draws planet icon images rotated to their heliocentric longitude on the
 * concentric orbit circles of the orrery dial.
 *
 * Port of:
 *   EOHandImageView.mm  — image drawing
 *   EOHandView.mm L353–373 — angle computation per planet kind
 *   EOClock.mm L1983–1997 — planet configuration (radii, images)
 *
 * Planet hands are dynamic — they update hourly (planetUpdate=3600s).
 * The Moon is a sub-hand of Earth, offset from the Earth hand by its
 * moon age angle + π (matching iOS: angle = -moonAgeAngle() + π).
 *
 * Uses 'lighten' compositing for all planet images since the PNGs
 * have opaque black backgrounds (RGB, no alpha channel).
 */

import type { LayoutParams } from './layout.js';
import type { ObsValueName } from './obs-values.js';
import type { Updater } from '../shared/updater.js';
import { ECPlanetNumber } from '../astronomy/astro-constants.js';

// Image asset imports (bundled as data URLs by esbuild). The planet masters
// are 4× the iOS icons' 75×34 (NASA imagery, README.md#credits), so a 4K
// panel draws them without upscaling; they are drawn at the iOS size
// (REF_SCALE), not their natural size.
import saturnPng from '../shared/assets/planets/saturn300.png';
import jupiterPng from '../shared/assets/planets/jupiter300.png';
import marsPng from '../shared/assets/planets/mars300.png';
import earthPng from '../shared/assets/planets/earth300.png';
import venusPng from '../shared/assets/planets/venus300.png';
import mercuryPng from '../shared/assets/planets/mercury300.png';
import moonPng from '../shared/assets/planets/moon150.png';

/** Master px per iOS authoring px: 300×136 masters for 75×34 icons (the Moon
 *  dot is the iOS @2x asset); image px ÷ REF_SCALE = size at s = 1, so a
 *  master's box may differ from 300×136 without changing the drawn size. */
const REF_SCALE = 4;
const MOON_REF_SCALE = 2;

// ---------------------------------------------------------------------------
// Image loading
// ---------------------------------------------------------------------------

interface PlanetConfig {
    planet: ECPlanetNumber;
    /** Orbit index from outermost (0=Saturn at plR2, 1=Jupiter at plR2-orbitInc, ...) */
    orbitIndex: number;
    src: string;
    img: HTMLImageElement | null;
}

/**
 * Moon hand config — special: it orbits the Earth hand as a sub-view.
 * iOS: moonHand = initWithKind:EOMoon name:"moon75.png" x:earthHand.width/2 y:-earthHand.length/2 radius:22
 */
interface MoonConfig {
    src: string;
    img: HTMLImageElement | null;
    /** Radius from Earth center to Moon center (iOS: 22) */
    moonOrbitRadius: number;
}

const planets: PlanetConfig[] = [
    { planet: ECPlanetNumber.Saturn,  orbitIndex: 0, src: saturnPng,  img: null },
    { planet: ECPlanetNumber.Jupiter, orbitIndex: 1, src: jupiterPng, img: null },
    { planet: ECPlanetNumber.Mars,    orbitIndex: 2, src: marsPng,    img: null },
    { planet: ECPlanetNumber.Earth,   orbitIndex: 3, src: earthPng,   img: null },
    { planet: ECPlanetNumber.Venus,   orbitIndex: 4, src: venusPng,   img: null },
    { planet: ECPlanetNumber.Mercury, orbitIndex: 5, src: mercuryPng, img: null },
];

const moonConfig: MoonConfig = {
    src: moonPng,
    img: null,
    moonOrbitRadius: 22,
};

let imagesLoaded = false;

function loadPlanetImages(): Promise<void> {
    if (imagesLoaded) return Promise.resolve();

    const promises: Promise<void>[] = [];

    for (const p of planets) {
        p.img = new Image();
        const img = p.img;
        promises.push(new Promise<void>((resolve) => {
            img.onload = () => resolve();
            img.onerror = () => { console.warn(`[PlanetHands] Failed to load planet image: ${p.planet}`); resolve(); };
        }));
        p.img.src = p.src;
    }

    moonConfig.img = new Image();
    const moonImg = moonConfig.img;
    promises.push(new Promise<void>((resolve) => {
        moonImg.onload = () => resolve();
        moonImg.onerror = () => { console.warn('[PlanetHands] Failed to load moon150.png'); resolve(); };
    }));
    moonConfig.img.src = moonConfig.src;

    return Promise.all(promises).then(() => { imagesLoaded = true; });
}

// Start loading on import
const imageLoadPromise = loadPlanetImages();

/**
 * Returns a promise that resolves when planet images are loaded.
 */
export function waitForPlanetImages(): Promise<void> {
    return imageLoadPromise;
}



// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Map from ECPlanetNumber to ObsValue name. */
const planetValueMap: { planet: ECPlanetNumber; key: ObsValueName }[] = [
    { planet: ECPlanetNumber.Saturn,  key: 'saturnHand' },
    { planet: ECPlanetNumber.Jupiter, key: 'jupiterHand' },
    { planet: ECPlanetNumber.Mars,    key: 'marsHand' },
    { planet: ECPlanetNumber.Earth,   key: 'earthHand' },
    { planet: ECPlanetNumber.Venus,   key: 'venusHand' },
    { planet: ECPlanetNumber.Mercury, key: 'mercuryHand' },
];

export function drawPlanetHands(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
    u: Updater<ObsValueName>,
): void {
    if (!imagesLoaded) return;

    const cx = L.mainCX;
    const cy = L.mainCY;

    for (const p of planets) {
        const img = p.img;
        if (!img || !img.complete) continue;

        // Look up the pre-computed angle from the Updater
        const mapping = planetValueMap.find(m => m.planet === p.planet);
        const angle = mapping ? u.get(mapping.key).currentValue : 0;

        // Orbit radius: plR2 - orbitIndex * orbitInc (matching iOS L1983-1997)
        const orbitR = L.plR2 - p.orbitIndex * L.orbitInc;

        ctx.save();
        ctx.translate(cx, cy);

        // iOS: the view's layer transform is a rotation by `angle`,
        // and the image is drawn at y=+radius (downward from center in UIKit).
        // Since we draw at +orbitR (downward), we add π to keep the planet
        // at the same angular position on the dial while the image is right-side-up.
        ctx.rotate(angle + Math.PI);

        // Image size: the iOS authoring size (master ÷ REF_SCALE), scaled
        const s = L.mainR / 365;
        const imgW = img.naturalWidth / REF_SCALE * s;
        const imgH = img.naturalHeight / REF_SCALE * s;

        // iOS: [img drawInRect:CGRectMake(-width/2, radius-length/2, width, length)]
        // In UIKit Y-down, this draws the image centered at +radius (downward
        // from the rotation center). Canvas is also Y-down, so we draw at
        // +orbitR to match iOS exactly. The scale(-1,1) corrects for the
        // tangential mirror introduced by the π rotation offset.
        ctx.scale(-1, 1);
        ctx.globalCompositeOperation = 'lighten';
        ctx.drawImage(img, -imgW / 2, orbitR - imgH / 2, imgW, imgH);

        // Draw Moon sub-hand if this is Earth
        if (p.planet === ECPlanetNumber.Earth) {
            drawMoonSubHand(ctx, L, s, orbitR, u.get('moonOffset').currentValue);
        }

        // Reset compositing before restore
        ctx.globalCompositeOperation = 'source-over';
        ctx.restore();
    }
}

/**
 * Draw the Moon as a sub-hand of Earth.
 *
 * iOS: moonHand is a child view of earthHand, initialized with:
 *   kind=EOMoon, x=earthHand.width/2, y=-earthHand.length/2, radius=22
 * Moon angle = -moonAgeAngle() + π
 *
 * The Moon orbits the Earth icon at a small radius (22 iOS px).
 *
 * Context state when called: already translated to dial center,
 * rotated to the Earth's heliocentric longitude.
 */
function drawMoonSubHand(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
    s: number,
    earthOrbitR: number,
    moonAngle: number,
): void {
    const moonImg = moonConfig.img;
    if (!moonImg || !moonImg.complete) return;

    const moonR = moonConfig.moonOrbitRadius * s;
    const moonW = moonImg.naturalWidth / MOON_REF_SCALE * s;
    const moonH = moonImg.naturalHeight / MOON_REF_SCALE * s;

    ctx.save();

    // Move to the Earth position on its orbit (positive Y = downward, matching iOS)
    ctx.translate(0, earthOrbitR);

    // Rotate by the Moon's angle (relative to Earth).
    // Negated to compensate for the inherited scale(-1,1) from Earth's context,
    // which mirrors the rotation direction.
    ctx.rotate(-moonAngle);

    // Draw moon image at moonOrbitRadius offset (positive Y, matching iOS)
    // scale(-1,1) undoes the inherited X-flip from the Earth drawing context.
    ctx.scale(-1, 1);
    ctx.globalCompositeOperation = 'lighten';
    ctx.drawImage(moonImg, -moonW / 2, moonR - moonH / 2, moonW, moonH);

    ctx.restore();
}
