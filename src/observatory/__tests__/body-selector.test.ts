/**
 * The Observatory body selector's geometry (body-selector.ts; plan
 * planning/2026-09-23-observatory-body-chevrons.md, treatment c):
 *
 *  (a) dialHalfAt — the left half is back, the right forward, each half at
 *      least 44 px wide and the pair at least 44 px tall whatever the dial's
 *      size; outside is nothing.
 *  (b) layoutBodyLabel — chevrons 0.3 em from the name; the group nudges
 *      right by exactly the deficit when the ‹ would cross the clearance
 *      line, and not at all otherwise.
 *  (c) slideProgress — 0 at the start, 1 at SLIDE_MS, clamped, eased out.
 *  (d) cycleSelectablePlanet — ±1 through the seven bodies, wrapping.
 *  (e) demiRadialTextCenter — the numeral centre the nudge rule reads is the
 *      drawing code's own (radial half at radius − halfH, bottom half at
 *      radius2 − halfH, flipped).
 *  (f) flashLevel — the tap wash is 1 at the tap, 0 at FLASH_MS, clamped,
 *      eased out; and the hands module keeps the loop awake for it.
 */
import { describe, test, expect, afterEach } from 'vitest';
import {
    dialHalfAt, layoutBodyLabel, slideProgress, flashLevel, MIN_TARGET_PX, SLIDE_MS, FLASH_MS, CHEVRON_GAP_EM,
} from '../body-selector.js';
import {
    cycleSelectablePlanet, beginBodyTapFlash, beginBodyLabelSlide, bodySelectorAnimating, resetBodySelectorAnimation,
} from '../peripheral-hands.js';
import { demiRadialTextCenter } from '../draw-utils.js';

describe('dialHalfAt', () => {
    test('a large dial: its left half is back, its right half forward, outside is null', () => {
        const cx = 200, cy = 300, r = 80;
        expect(dialHalfAt(cx - 10, cy, cx, cy, r)).toBe('back');
        expect(dialHalfAt(cx + 10, cy, cx, cy, r)).toBe('forward');
        expect(dialHalfAt(cx, cy, cx, cy, r)).toBe('forward');            // the centre line is forward
        expect(dialHalfAt(cx - 79, cy + 79, cx, cy, r)).toBe('back');      // the bounding square counts
        expect(dialHalfAt(cx - 81, cy, cx, cy, r)).toBeNull();
        expect(dialHalfAt(cx, cy - 81, cx, cy, r)).toBeNull();
        expect(dialHalfAt(cx + 81, cy, cx, cy, r)).toBeNull();
    });

    test('a phone-sized dial gets 44 px slop in both dimensions', () => {
        const cx = 60, cy = 400, r = 30;                                   // 60 px across: each half is 30 wide
        expect(dialHalfAt(cx - 43, cy, cx, cy, r)).toBe('back');          // beyond the rim, inside the 44 px half
        expect(dialHalfAt(cx - 45, cy, cx, cy, r)).toBeNull();
        expect(dialHalfAt(cx + 43, cy, cx, cy, r)).toBe('forward');
        expect(dialHalfAt(cx, cy - 30, cx, cy, r)).toBe('forward');       // the pair is 2r = 60 ≥ 44 tall here
        const tiny = 15;                                                   // 30 px across: the pair must grow to 44 tall
        expect(dialHalfAt(cx - 1, cy + 21, cx, cy, tiny)).toBe('back');
        expect(dialHalfAt(cx - 1, cy + 23, cx, cy, tiny)).toBeNull();
        expect(MIN_TARGET_PX).toBe(44);
    });
});

describe('layoutBodyLabel', () => {
    test('centres the name and puts the chevrons 0.3 em outside it', () => {
        const em = 10, nameW = 40, chevW = 4;
        const lay = layoutBodyLabel(100, em, nameW, chevW);
        expect(lay.nudge).toBe(0);
        expect(lay.nameX).toBe(100);
        expect(lay.backX).toBeCloseTo(100 - 20 - 3 - 2, 9);
        expect(lay.forwardX).toBeCloseTo(100 + 20 + 3 + 2, 9);
        expect(lay.zoneHalfW).toBeCloseTo(20 + CHEVRON_GAP_EM * em, 9);
    });

    test('a short name never moves; a long one nudges right by exactly the deficit', () => {
        const em = 10, chevW = 4;
        // The ‹ left edge sits at cx − nameW/2 − 3 − 4. Clearance line at cx − 20.
        const clear = 100 - 20;
        const short = layoutBodyLabel(100, em, 20, chevW, clear);          // left edge 100 − 17 = 83 ≥ 80
        expect(short.nudge).toBe(0);
        const long = layoutBodyLabel(100, em, 40, chevW, clear);           // left edge 100 − 27 = 73 < 80
        expect(long.nudge).toBeCloseTo(7, 9);
        expect(long.nameX).toBeCloseTo(107, 9);
        expect(long.backX).toBeCloseTo(107 - 20 - 3 - 2, 9);
        // After the nudge the ‹ left edge sits exactly on the line.
        expect(long.backX - chevW / 2).toBeCloseTo(clear, 9);
    });
});

describe('slideProgress', () => {
    test('runs 0 → 1 over SLIDE_MS, clamped, eased out', () => {
        const slide = { from: 'Sun', to: 'Moon', dir: 1 as const, startMs: 1000 };
        expect(slideProgress(slide, 900)).toBe(0);
        expect(slideProgress(slide, 1000)).toBe(0);
        const half = slideProgress(slide, 1000 + SLIDE_MS / 2);
        expect(half).toBeGreaterThan(0.5);                                 // ease-out: past halfway at half time
        expect(half).toBeLessThan(1);
        expect(slideProgress(slide, 1000 + SLIDE_MS)).toBe(1);
        expect(slideProgress(slide, 5000)).toBe(1);
    });
});

describe('flashLevel', () => {
    test('is 1 at the tap, decays to 0 at FLASH_MS, clamped, eased out', () => {
        const flash = { dial: 'alt' as const, half: 'forward' as const, startMs: 1000 };
        expect(flashLevel(flash, 900)).toBe(1);
        expect(flashLevel(flash, 1000)).toBe(1);
        const half = flashLevel(flash, 1000 + FLASH_MS / 2);
        expect(half).toBeGreaterThan(0);
        expect(half).toBeLessThan(0.5);                                    // ease-out: most of the drop is early
        expect(flashLevel(flash, 1000 + FLASH_MS)).toBe(0);
        expect(flashLevel(flash, 5000)).toBe(0);
    });
});

describe('bodySelectorAnimating', () => {
    afterEach(() => resetBodySelectorAnimation());

    test('a tap wash keeps the loop awake until it has faded, on its own', () => {
        expect(bodySelectorAnimating(1000)).toBe(false);
        beginBodyTapFlash('az', 'back', 1000);
        expect(bodySelectorAnimating(1000)).toBe(true);
        expect(bodySelectorAnimating(1000 + FLASH_MS - 1)).toBe(true);
        expect(bodySelectorAnimating(1000 + FLASH_MS)).toBe(false);
    });

    test('the wash outlives the slide, so the loop runs to the later of the two', () => {
        beginBodyLabelSlide(0, 1, 1, 1000);
        beginBodyTapFlash('alt', 'forward', 1000);
        expect(bodySelectorAnimating(1000 + SLIDE_MS)).toBe(FLASH_MS > SLIDE_MS);
        expect(bodySelectorAnimating(1000 + Math.max(SLIDE_MS, FLASH_MS))).toBe(false);
    });
});

describe('cycleSelectablePlanet', () => {
    test('steps ±1 through Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn and wraps', () => {
        expect(cycleSelectablePlanet(0, 1)).toBe(1);
        expect(cycleSelectablePlanet(3, 1)).toBe(5);                       // skips Earth (4)
        expect(cycleSelectablePlanet(7, 1)).toBe(0);
        expect(cycleSelectablePlanet(0, -1)).toBe(7);
        expect(cycleSelectablePlanet(5, -1)).toBe(3);
        expect(cycleSelectablePlanet(4, 1)).toBe(1);                       // an unselectable input counts as Sun
    });
});

describe('demiRadialTextCenter', () => {
    test('places the radial half at radius − halfH and the bottom half, flipped, at radius2 − halfH', () => {
        const cx = 0, cy = 0, n = 12;
        const top = demiRadialTextCenter(cx, cy, 0, n, 50, 51, 4);          // slot 0 = 12 o'clock
        expect(top.bottom).toBe(false);
        expect(top.x).toBeCloseTo(0, 9);
        expect(top.y).toBeCloseTo(-46, 9);
        const thirty = demiRadialTextCenter(cx, cy, 10, n, 50, 51, 4);      // the altitude dial's "30": upper left
        expect(thirty.bottom).toBe(false);
        expect(thirty.x).toBeCloseTo(-46 * Math.cos(Math.PI / 6), 9);
        expect(thirty.y).toBeCloseTo(-46 * Math.sin(Math.PI / 6), 9);
        const six = demiRadialTextCenter(cx, cy, 6, n, 50, 51, 4);          // 6 o'clock: flipped, from radius2
        expect(six.bottom).toBe(true);
        expect(six.x).toBeCloseTo(0, 9);
        expect(six.y).toBeCloseTo(47, 9);
    });
});
