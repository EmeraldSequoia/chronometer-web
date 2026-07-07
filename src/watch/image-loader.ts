/**
 * Image loader for watch face assets.
 *
 * Maps XML `src` paths to actual image URLs. For standalone builds,
 * images are embedded as base64 data URLs via esbuild. For Vite dev
 * mode, they're served as regular URLs.
 *
 * All images are loaded asynchronously; the renderer receives a
 * Map<string, ImageBitmap> to draw from.
 */

// Import images — esbuild bundles these as base64 with --loader:.png=dataurl
// Vite similarly handles ?url imports
import faceUrl from './assets/haleakala/Haleakala-face-android.png';
import backFaceUrl from './assets/hana/Haleakala-back.png';
import logoUrl from './assets/haleakala/logos-black-4x.png';
import bandUrl from './assets/haleakala/band-front-4x.png';
import caseUrl from './assets/haleakala/case-front-4x.png';
import moonESUrl from './assets/chandra/moonES-4x.png';
import whiteLogoUrl from './assets/chandra/logos-white-4x.png';
import redStarUrl from './assets/chandra/redStar.png';
import blueStarUrl from './assets/chandra/blueStar.png';
// Selene assets
import seleneFaceUrl from './assets/selene/face-white-trim-4x.png';
import seleneMoonUrl from './assets/selene/moonES72-4x.png';
import phaseNUrl from './assets/selene/phaseN.png';
import phase1Url from './assets/selene/phase1.png';
import phase3Url from './assets/selene/phase3.png';
import phaseFUrl from './assets/selene/phaseF.png';

/**
 * Map from XML src paths to their imported URLs and scale factors.
 * The scale factor converts from image pixels to 1x coordinate units.
 * For 4x images, scale = 0.25 (draw at 1/4 size); for 1x, scale = 1.
 */
const IMAGE_MAP: Record<string, { url: string; scale: number }> = {
    // Builtin-Android Haleakala I face image (1x scale — same coordinate space as XML)
    'Haleakala-face.png':                                { url: faceUrl, scale: 1 },
    // Hana I face background — a light gray moon face
    'Haleakala-back.png':                                { url: backFaceUrl, scale: 1 },
    '../partsBin/logos/black.png':                        { url: logoUrl, scale: 0.25 },
    '../partsBin/HD/brown/front/straight/narrow/band.png': { url: bandUrl, scale: 0.25 },
    '../partsBin/HD/yellow/front/narrow/case.png':        { url: caseUrl, scale: 0.25 },
    // Chandra assets
    '../partsBin/moonES.png':                             { url: moonESUrl, scale: 0.25 },
    '../partsBin/logos/white.png':                         { url: whiteLogoUrl, scale: 0.25 },
    'redStar.png':                                        { url: redStarUrl, scale: 1 },
    'blueStar.png':                                       { url: blueStarUrl, scale: 1 },
    // Selene assets (4x images)
    'face-white-trim.png':                                { url: seleneFaceUrl, scale: 0.25 },
    '../partsBin/moonES72.png':                           { url: seleneMoonUrl, scale: 0.25 },
    'phaseN.png':                                         { url: phaseNUrl, scale: 1 },
    'phase1.png':                                         { url: phase1Url, scale: 1 },
    'phase3.png':                                         { url: phase3Url, scale: 1 },
    'phaseF.png':                                         { url: phaseFUrl, scale: 1 },
};

/** Loaded image with its scale factor */
export interface LoadedImage {
    bitmap: ImageBitmap;
    /** Scale from decoded-bitmap pixels to 1x XML coordinate units.
     *  Rewritten by {@link decodeLoadedImageForScale} on each re-decode so that
     *  `bitmap.width * scale` (the XML draw size) stays invariant. */
    scale: number;
    /** Retained compressed source + intrinsics enabling a display-size re-decode
     *  on resize. Present for chronometer face images; images without it keep
     *  their as-loaded bitmap. */
    source?: ImageSource;
}

/** Compressed source retained for on-demand re-decode (see the memory/phone-floor plan). */
export interface ImageSource {
    /** The encoded image bytes (PNG/JPEG), kept so the bitmap can be re-decoded
     *  at a new display size without re-fetching. */
    blob: Blob;
    /** Intrinsic source pixel dimensions. */
    srcW: number;
    srcH: number;
    /** Original source-pixel → XML-unit scale (from the face data / IMAGE_MAP). */
    baseScale: number;
}

/**
 * Load all images for the Haleakala watch face.
 * Returns a Map keyed by the XML `src` path.
 */
export async function loadWatchImages(): Promise<Map<string, LoadedImage>> {
    const result = new Map<string, LoadedImage>();

    const entries = Object.entries(IMAGE_MAP);
    const loadPromises = entries.map(async ([src, { url, scale }]) => {
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);
            result.set(src, { bitmap, scale });
        } catch (e) {
            console.warn(`Failed to load image: ${src}`, e);
        }
    });

    await Promise.all(loadPromises);
    return result;
}

// ============================================================================
// Display-size decode (memory / phone-floor lever)
//
// Face artwork ships as -4x retina assets (~1120 px). Decoding them at full
// source resolution costs the same on a phone (faces ~200 px) as on a 4K
// monitor (~1070 px) — ~82 MB of oversized ImageBitmaps that is almost entirely
// waste on small layouts. Instead we retain the compressed blob and decode each
// bitmap to the physical pixels it actually occupies (1:1), re-decoding on
// relayout. See planning/2026-07-06-memory-phone-floor-plan.md.
// ============================================================================

/** Shared 1x1 stand-in held by a re-decodable image until its first real,
 *  display-sized decode (which happens in the resize path, once layout is known).
 *  Never drawn: nothing paints before the first cache build, which the decode
 *  precedes. */
let sharedPlaceholder: ImageBitmap | null = null;

async function getPlaceholderBitmap(): Promise<ImageBitmap> {
    if (!sharedPlaceholder) sharedPlaceholder = await createImageBitmap(new ImageData(1, 1));
    return sharedPlaceholder;
}

/** Read a PNG's intrinsic dimensions from its IHDR header without decoding the
 *  pixels — avoids a full-resolution decode spike on the memory-constrained phone
 *  floor. Returns null for non-PNG input. */
async function getPngDimensions(blob: Blob): Promise<{ w: number; h: number } | null> {
    if (blob.size < 24) return null;
    const buf = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // The first chunk is IHDR; its data begins at byte 16 with width, then height
    // (both big-endian uint32).
    return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

/** Build a re-decodable LoadedImage: retain the compressed blob + intrinsics and
 *  defer the real decode to {@link decodeLoadedImageForScale} (run in the resize
 *  path once the on-screen size is known). PNG dimensions come from the header; a
 *  non-PNG falls back to one full decode (also used as its initial bitmap). */
export async function makeReDecodableImage(blob: Blob, baseScale: number): Promise<LoadedImage> {
    const dims = await getPngDimensions(blob);
    if (!dims) {
        const full = await createImageBitmap(blob);
        return {
            bitmap: full,
            scale: baseScale,
            source: { blob, srcW: full.width, srcH: full.height, baseScale },
        };
    }
    return {
        bitmap: await getPlaceholderBitmap(),
        scale: baseScale,
        source: { blob, srcW: dims.w, srcH: dims.h, baseScale },
    };
}

/** Re-decode a retained image to the pixels it occupies on screen at `faceScale`
 *  (1:1), never upscaling past the source. Rewrites `scale` so the XML draw size
 *  `bitmap.width * scale` is preserved, and closes the previous bitmap. No-op for
 *  images without a retained source. */
export async function decodeLoadedImageForScale(
    loaded: LoadedImage,
    faceScale: number,
): Promise<void> {
    const src = loaded.source;
    if (!src) return;

    // On-screen px = (srcW * baseScale) * faceScale; decode to that, capped at the
    // source (upscaling past it buys no sharpness, only memory).
    const ratio = Math.min(1, src.baseScale * faceScale);
    const targetW = Math.max(1, Math.round(src.srcW * ratio));
    const targetH = Math.max(1, Math.round(src.srcH * ratio));

    // Skip if the current bitmap is already at this size (repeat resize at an
    // unchanged scale). The placeholder (1x1) never short-circuits a first decode.
    if (loaded.bitmap !== sharedPlaceholder
        && loaded.bitmap.width === targetW && loaded.bitmap.height === targetH) {
        return;
    }

    const bitmap = await createImageBitmap(src.blob, {
        resizeWidth: targetW,
        resizeHeight: targetH,
        resizeQuality: 'high',
    });
    const old = loaded.bitmap;
    loaded.bitmap = bitmap;
    // Hold `bitmap.width * scale === srcW * baseScale` (the XML draw size).
    loaded.scale = (src.srcW * src.baseScale) / bitmap.width;
    if (old && old !== sharedPlaceholder) old.close();
}
