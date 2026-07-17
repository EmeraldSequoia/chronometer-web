import { describe, test, expect } from 'vitest';
import { buildBaseLayout, type AnchorId } from '../observatory/anchor-layout.js';

// Golden regression for the Observatory base-layout templates. Locks the full
// LayoutParams produced by every iteration-3 anchor across a representative
// size grid — the module had no coverage, which is how the popover-arm layout
// path rotted unnoticed for a month (removed 2026-07-17, verified
// byte-identical; see planning/2026-07-17-observatory-layout-popover-deadcode.md).
//
// If a layout change is INTENTIONAL, regenerate with `npx vitest run -u` and
// review the snapshot diff — it is the exact geometry shipped to every
// renderer.
//
// NOTE: chooseTemplate() has aspect hysteresis (module-level state), so the
// iteration order below is part of the fixture — keep it fixed.

const ANCHORS: AnchorId[] = ['A1', 'A2', 'A3m', 'A3', 'Asq', 'A4', 'A5', 'Awide', 'A6'];
const SIZES: Array<[number, number]> = [
    [320, 568],    // phone portrait
    [768, 1024],   // iPad portrait
    [900, 900],    // square
    [1280, 800],   // laptop landscape
    [1920, 1080],  // desktop
    [3440, 1440],  // ultrawide
];
const FOOTERS = [0, 44];

describe('buildBaseLayout golden geometry', () => {
    for (const anchor of ANCHORS) {
        test(`anchor ${anchor}`, () => {
            const results: Record<string, unknown> = {};
            for (const [w, h] of SIZES) {
                for (const f of FOOTERS) {
                    results[`${w}x${h}|f${f}`] = buildBaseLayout(anchor, w, h, f);
                }
            }
            expect(results).toMatchSnapshot();
        });
    }
});
