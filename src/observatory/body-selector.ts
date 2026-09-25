/**
 * Observatory body selector — the ‹ › chevrons on the alt/az dials and their
 * touch targets, as pure geometry (no canvas), unit-tested. Drawing is in
 * peripheral-hands.ts; taps and hover in observatory-entry.ts. Design:
 * planning/2026-09-23-observatory-body-chevrons.md (treatment c of the
 * parent plan's §3.3.1); docs/observatory.md § Planet selection.
 *
 * Targets: the dial's left half is "back" and its right half "forward", each
 * at least 44 px in both dimensions whatever the dial's size (Steve,
 * 2026-09-17 — the chevrons are ~7 px on a phone dial and two 44 px squares
 * around them would overlap each other and the hub). The chevrons sit inside
 * their halves as the visual hint. Both dials use the same split; the iOS
 * "altitude forward, azimuth back" rule is gone.
 *
 * Feedback on an accepted tap (Steve, 2026-09-24): the tapped half-disc
 * lights up at once — a flat white wash, the iOS cell-highlight idiom on the
 * dial's own geometry — and fades out over FLASH_MS, its chevron going to
 * full white with it. The wash is the whole target (the half-disc), so the
 * altitude dial's empty right half shows itself when hit.
 */

/** Minimum touch target, CSS px (Apple HIG 44 pt). */
export const MIN_TARGET_PX = 44;
/** Chevron font size as a fraction of the label font. */
export const CHEVRON_FONT_RATIO = 0.8;
/**
 * Chevron alpha at rest and under the mouse. The mock's 45 % / 90 % got lost
 * in the starfield on a real display; 65 % / 100 % are Steve's starting
 * points (2026-09-24).
 */
export const CHEVRON_ALPHA = 0.65;
export const CHEVRON_HOVER_ALPHA = 1;
/** Gap between the name and each chevron, in label-font ems. */
export const CHEVRON_GAP_EM = 0.3;
/** Clearance the left chevron keeps from the altitude dial's "30", in ems. */
export const CHEVRON_CLEARANCE_EM = 0.35;
/** The label slide's duration on a body change. */
export const SLIDE_MS = 250;
/** The tap wash's fade-out duration. */
export const FLASH_MS = 600;
/** The tap wash's peak alpha (white over the tapped half-disc). */
export const FLASH_PEAK_ALPHA = 0.20;

export const CHEVRON_BACK = '‹';     // ‹
export const CHEVRON_FORWARD = '›';  // ›

export type DialHalf = 'back' | 'forward';

/**
 * Which target of a dial centred at (cx, cy) with radius r the point hits:
 * the left half is back, the right half forward, each half `max(r, 44)` wide
 * and the pair `max(2r, 44)` tall (slop beyond a small dial's rim).
 */
export function dialHalfAt(x: number, y: number, cx: number, cy: number, r: number): DialHalf | null {
    const halfW = Math.max(r, MIN_TARGET_PX);
    const halfH = Math.max(r, MIN_TARGET_PX / 2);
    if (Math.abs(y - cy) > halfH) return null;
    const dx = x - cx;
    if (dx < -halfW || dx > halfW) return null;
    return dx < 0 ? 'back' : 'forward';
}

export interface BodyLabelLayout {
    /** Centre x of the name (the dial's centre plus any nudge). */
    nameX: number;
    /** Centre x of the ‹ and › glyphs. */
    backX: number;
    forwardX: number;
    /** How far the group moved right to clear the numeral (0 for short names). */
    nudge: number;
    /** Half width of the label zone (name plus the gaps) — the slide's clip. */
    zoneHalfW: number;
}

/**
 * Lay the name and its chevrons out around `cx`: each chevron `CHEVRON_GAP_EM`
 * from the name's end. `clearLeftOf` is the x the left chevron's left edge may
 * not pass (the "30" numeral's extent plus clearance, altitude dial only);
 * when it would, the whole group shifts right by exactly the deficit, so a
 * short name never moves and a long one moves as little as possible.
 */
export function layoutBodyLabel(
    cx: number, em: number, nameW: number, chevW: number, clearLeftOf?: number,
): BodyLabelLayout {
    const gap = CHEVRON_GAP_EM * em;
    const leftEdge = cx - nameW / 2 - gap - chevW;
    const nudge = clearLeftOf !== undefined && leftEdge < clearLeftOf ? clearLeftOf - leftEdge : 0;
    const nameX = cx + nudge;
    return {
        nameX,
        backX: nameX - nameW / 2 - gap - chevW / 2,
        forwardX: nameX + nameW / 2 + gap + chevW / 2,
        nudge,
        zoneHalfW: nameW / 2 + gap,
    };
}

/** A body-name slide in flight: the outgoing name leaves in `dir`'s direction. */
export interface BodySlide {
    from: string;
    to: string;
    dir: 1 | -1;
    startMs: number;
}

/** Progress of a slide, 0…1, eased out. */
export function slideProgress(slide: BodySlide, nowMs: number): number {
    const t = Math.min(1, Math.max(0, (nowMs - slide.startMs) / SLIDE_MS));
    return t * (2 - t);
}

/** A tap wash in flight: the half-disc that was hit, lit at `startMs`. */
export interface BodyFlash {
    dial: 'alt' | 'az';
    half: DialHalf;
    startMs: number;
}

/**
 * Level of a tap wash, 1 at the tap decaying to 0 at FLASH_MS: quadratic
 * ease-out, so it drops fast (the tap registered) and dies with a soft tail.
 */
export function flashLevel(flash: BodyFlash, nowMs: number): number {
    const t = Math.min(1, Math.max(0, (nowMs - flash.startMs) / FLASH_MS));
    return (1 - t) * (1 - t);
}
