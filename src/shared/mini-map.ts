// mini-map.ts — Blue Marble globe renderer and OSM tile loader

import { BLUE_MARBLE } from '../blue-marble-data.js';

// ---------------------------------------------------------------------------
// Blue Marble texture
// ---------------------------------------------------------------------------

let textureImg: HTMLImageElement | null = null;
let textureCanvas: HTMLCanvasElement | null = null;
let textureCtx: CanvasRenderingContext2D | null = null;
let textureLoaded = false;

/** Estimated backing-store bytes of the sampling texture — for the [mem] ledger. */
export function miniMapTextureSizeBytes(): number {
    return textureCanvas ? textureCanvas.width * textureCanvas.height * 4 : 0;
}

/** Load the Blue Marble texture (only once). */
function ensureTexture(): Promise<void> {
    if (textureLoaded) return Promise.resolve();
    if (textureImg) return new Promise(r => { textureImg!.onload = () => r(); });

    return new Promise((resolve) => {
        textureImg = new Image();
        textureImg.onload = () => {
            // Draw texture to an offscreen canvas for pixel sampling
            textureCanvas = document.createElement('canvas');
            textureCanvas.width = textureImg!.width;
            textureCanvas.height = textureImg!.height;
            textureCtx = textureCanvas.getContext('2d', { willReadFrequently: true })!;
            textureCtx.drawImage(textureImg!, 0, 0);
            textureLoaded = true;
            resolve();
        };
        textureImg.src = BLUE_MARBLE;
    });
}

// ---------------------------------------------------------------------------
// Globe renderer using orthographic projection + Blue Marble texture
// ---------------------------------------------------------------------------

/** Render a mini orthographic globe centered on the given location. */
export async function renderGlobe(canvas: HTMLCanvasElement, lat: number, lon: number): Promise<void> {
    await ensureTexture();

    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(cx, cy) - 2;

    ctx.clearRect(0, 0, w, h);

    const tw = textureCanvas!.width;
    const th = textureCanvas!.height;
    const texData = textureCtx!.getImageData(0, 0, tw, th).data;

    // Create image data for the globe
    const imgData = ctx.createImageData(w, h);
    const pixels = imgData.data;

    const φ0 = lat * Math.PI / 180;
    const λ0 = lon * Math.PI / 180;
    const sinφ0 = Math.sin(φ0);
    const cosφ0 = Math.cos(φ0);

    for (let sy = 0; sy < h; sy++) {
        for (let sx = 0; sx < w; sx++) {
            const nx = (sx - cx) / r;
            const ny = (cy - sy) / r;
            const ρ2 = nx * nx + ny * ny;
            if (ρ2 > 1) continue; // outside globe

            const ρ = Math.sqrt(ρ2);
            const c = Math.asin(ρ);
            const sinC = Math.sin(c);
            const cosC = Math.cos(c);

            // Inverse orthographic projection → lat/lon
            let φ: number, λ: number;
            if (ρ === 0) {
                φ = φ0;
                λ = λ0;
            } else {
                φ = Math.asin(cosC * sinφ0 + ny * sinC * cosφ0 / ρ);
                λ = λ0 + Math.atan2(nx * sinC, ρ * cosφ0 * cosC - ny * sinφ0 * sinC);
            }

            // Map to texture coordinates
            const latDeg = φ * 180 / Math.PI;
            const lonDeg = λ * 180 / Math.PI;

            // Equirectangular: x = (lon + 180) / 360 * width, y = (90 - lat) / 180 * height
            let tx = ((lonDeg + 180) % 360) / 360 * tw;
            let ty = (90 - latDeg) / 180 * th;

            // Clamp
            tx = Math.max(0, Math.min(tw - 1, Math.floor(tx)));
            ty = Math.max(0, Math.min(th - 1, Math.floor(ty)));

            const ti = (ty * tw + tx) * 4;
            const pi = (sy * w + sx) * 4;

            // Apply slight darkening at edges for 3D sphere effect
            const edgeFactor = 1 - ρ2 * 0.3;
            pixels[pi]     = texData[ti]     * edgeFactor;
            pixels[pi + 1] = texData[ti + 1] * edgeFactor;
            pixels[pi + 2] = texData[ti + 2] * edgeFactor;
            pixels[pi + 3] = 255;
        }
    }

    ctx.putImageData(imgData, 0, 0);

    // Marker dot at center (globe is centered on the location)
    ctx.fillStyle = '#ff4444';
    ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);

    // Subtle edge ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(100, 160, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();
}

// ---------------------------------------------------------------------------
// OSM tile loader — loads 2x2 grid for full coverage
// ---------------------------------------------------------------------------

/** Convert lat/lon to OSM tile x/y and pixel offset within that tile. */
function latLonToTile(lat: number, lon: number, zoom: number) {
    const n = 2 ** zoom;
    const xf = (lon + 180) / 360 * n;
    const latRad = lat * Math.PI / 180;
    const yf = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;

    const tileX = Math.floor(xf);
    const tileY = Math.floor(yf);
    const px = (xf - tileX) * 256;
    const py = (yf - tileY) * 256;

    return { tileX, tileY, px, py };
}

/**
 * Load OSM tiles centered on the given location, filling the container.
 * Uses a 2x2 tile grid to ensure full coverage around the marker.
 * Returns true if at least one tile loaded, false if fully offline.
 */
export function loadOSMTile(
    container: HTMLElement,
    _img: HTMLImageElement,  // legacy param, we now create our own images
    markerEl: HTMLElement,
    lat: number,
    lon: number,
    zoom: number = 8
): Promise<boolean> {
    const { tileX, tileY, px, py } = latLonToTile(lat, lon, zoom);

    // Determine which 2x2 grid surrounds the marker best
    const startX = px >= 128 ? tileX : tileX - 1;
    const startY = py >= 128 ? tileY : tileY - 1;
    // Marker position within the 512x512 combined area
    const markerX = px + (tileX - startX) * 256;
    const markerY = py + (tileY - startY) * 256;

    const cw = container.clientWidth;
    const ch = container.clientHeight;

    // Remove old tile images (except the marker and offline label)
    container.querySelectorAll('.osm-tile-img').forEach(el => el.remove());

    // Offset so marker is centered in container
    const offsetX = Math.round(cw / 2 - markerX);
    const offsetY = Math.round(ch / 2 - markerY);

    // Marker always at center of container
    markerEl.style.left = `${Math.round(cw / 2)}px`;
    markerEl.style.top  = `${Math.round(ch / 2)}px`;

    // Load 2x2 tiles
    const promises: Promise<boolean>[] = [];
    for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
            const tx = startX + dx;
            const ty = startY + dy;
            const url = `https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`;

            const img = document.createElement('img');
            img.className = 'osm-tile-img';
            img.style.position = 'absolute';
            img.style.width = '256px';
            img.style.height = '256px';
            img.style.left = `${offsetX + dx * 256}px`;
            img.style.top  = `${offsetY + dy * 256}px`;
            img.alt = '';
            container.insertBefore(img, markerEl);

            promises.push(new Promise(resolve => {
                img.onload = () => resolve(true);
                img.onerror = () => { img.remove(); resolve(false); };
                img.src = url;
            }));
        }
    }

    // Hide the original img element
    _img.style.display = 'none';

    return Promise.all(promises).then(results => results.some(ok => ok));
}
