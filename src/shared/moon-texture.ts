/**
 * Resolution-selected Moon texture.
 *
 * Two copies of the same photograph: moon300.png (always loaded, 0.36 MB
 * decoded) and moon768.png, decoded only once a caller needs more than
 * LARGE_THRESHOLD_PX device px across — a 1280×800 @1× window (Moon ≈ 260
 * px) and phones (≈ 300) never pay for it; a @2× laptop and every 4K case
 * do. The large image is never released (a 4K window stays 4K). Until it has
 * loaded, the small one is returned, so there is never a blank frame.
 *
 * The eclipse simulator and the eclipse ring sprites keep their own small
 * texture: their Moon is tens of pixels.
 */

// @ts-ignore — esbuild resolves .png as a data URL via --loader:.png=dataurl
import moon300Png from './assets/moon300.png';
// @ts-ignore
import moon768Png from './assets/moon768.png';

/** Device px across the drawn disc above which the 768 texture is used (300 × 1.2). */
export const LARGE_THRESHOLD_PX = 360;

/** The subset of HTMLImageElement the selector needs (tests pass fakes). */
export interface TextureImage {
    src: string;
    onload: ((this: GlobalEventHandlers, ev: Event) => unknown) | null;
    onerror: OnErrorEventHandler;
}

export class MoonTextureSelector<I extends TextureImage = HTMLImageElement> {
    private small: I | null = null;
    private smallReady = false;
    private large: I | null = null;
    private largeReady = false;
    private largeFailed = false;
    private readonly smallLoaded: Promise<void>;
    private resolveSmall!: () => void;

    constructor(
        private readonly smallSrc: string,
        private readonly largeSrc: string,
        private readonly makeImage: () => I,
        private readonly threshold = LARGE_THRESHOLD_PX,
    ) {
        this.smallLoaded = new Promise<void>((resolve) => { this.resolveSmall = resolve; });
    }

    /** Start loading the small texture (idempotent). */
    init(): void {
        if (this.small) return;
        const img = this.makeImage();
        img.onload = () => { this.smallReady = true; this.resolveSmall(); };
        img.onerror = () => { console.warn('[MoonTexture] Failed to load moon300.png'); this.resolveSmall(); };
        img.src = this.smallSrc;
        this.small = img;
    }

    /** Resolves once the small texture has settled (loaded or failed). */
    whenReady(): Promise<void> {
        this.init();
        return this.smallLoaded;
    }

    /**
     * The texture to draw for a disc `neededDevicePx` across, or null until
     * the small one has loaded. Asking for more than the threshold starts
     * the large decode; the small texture is returned until it arrives.
     */
    get(neededDevicePx: number): I | null {
        if (!this.smallReady) return null;
        if (neededDevicePx > this.threshold && !this.largeFailed) {
            if (!this.large) {
                const img = this.makeImage();
                img.onload = () => { this.largeReady = true; };
                img.onerror = () => { console.warn('[MoonTexture] Failed to load moon768.png'); this.largeFailed = true; };
                img.src = this.largeSrc;
                this.large = img;
            }
            if (this.largeReady) return this.large;
        }
        return this.small;
    }

    /** Whether the large texture has been requested (for the memory ledger / tests). */
    get largeRequested(): boolean { return this.large !== null; }
}

const selector = new MoonTextureSelector<HTMLImageElement>(
    moon300Png as string, moon768Png as string, () => new Image());

/** Start loading the small Moon texture. */
export function initMoonTexture(): void { selector.init(); }

/** Resolves once the small texture has settled. */
export function waitForMoonTexture(): Promise<void> { return selector.whenReady(); }

/** See MoonTextureSelector.get. */
export function getMoonTexture(neededDevicePx: number): HTMLImageElement | null {
    return selector.get(neededDevicePx);
}
