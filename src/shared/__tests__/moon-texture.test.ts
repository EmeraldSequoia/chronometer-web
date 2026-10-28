/**
 * Moon texture selector (moon-texture.ts): small texture always; the large
 * one requested only past the threshold, and the small one served until it
 * has loaded.
 */
import { describe, it, expect } from 'vitest';
import { MoonTextureSelector, LARGE_THRESHOLD_PX, type TextureImage } from '../moon-texture.js';

class FakeImage implements TextureImage {
    src = '';
    onload: TextureImage['onload'] = null;
    onerror: TextureImage['onerror'] = null;
    load(): void { this.onload?.call(null as unknown as GlobalEventHandlers, new Event('load')); }
    fail(): void { (this.onerror as (e: string) => void)?.('error'); }
}

function make(): { sel: MoonTextureSelector<FakeImage>; images: FakeImage[] } {
    const images: FakeImage[] = [];
    const sel = new MoonTextureSelector<FakeImage>('small.png', 'large.png', () => {
        const img = new FakeImage();
        images.push(img);
        return img;
    });
    return { sel, images };
}

describe('MoonTextureSelector', () => {
    it('returns null until the small texture has loaded, then the small one', async () => {
        const { sel, images } = make();
        sel.init();
        expect(images.length).toBe(1);
        expect(images[0].src).toBe('small.png');
        expect(sel.get(100)).toBeNull();
        images[0].load();
        await sel.whenReady();
        expect(sel.get(100)).toBe(images[0]);
        expect(sel.largeRequested).toBe(false);
    });

    it('never requests the large texture at or below the threshold', () => {
        const { sel, images } = make();
        sel.init(); images[0].load();
        expect(sel.get(LARGE_THRESHOLD_PX)).toBe(images[0]);
        expect(sel.get(260)).toBe(images[0]);
        expect(images.length).toBe(1);
    });

    it('requests the large texture past the threshold and serves the small one until it loads', () => {
        const { sel, images } = make();
        sel.init(); images[0].load();
        expect(sel.get(LARGE_THRESHOLD_PX + 1)).toBe(images[0]);   // small, while the large decodes
        expect(images.length).toBe(2);
        expect(images[1].src).toBe('large.png');
        expect(sel.get(700)).toBe(images[0]);
        expect(images.length).toBe(2);                              // requested once
        images[1].load();
        expect(sel.get(700)).toBe(images[1]);
        expect(sel.get(200)).toBe(images[0]);                       // a small disc still gets the small one
    });

    it('falls back to the small texture for good if the large one fails', () => {
        const { sel, images } = make();
        sel.init(); images[0].load();
        sel.get(700);
        images[1].fail();
        expect(sel.get(700)).toBe(images[0]);
        expect(images.length).toBe(2);
    });

    it('threshold is 1.2× the small texture', () => {
        expect(LARGE_THRESHOLD_PX).toBe(360);
    });
});
