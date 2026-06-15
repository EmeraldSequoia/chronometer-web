# QWheel Dot Positioning — Debugging Notes

**Date**: 2026-04-07  
**Faces affected**: Selene (AM/PM dot window above lower-left clock subdial)

## Problem

The `●` (bullet) character in the Selene AM/PM QWheel appears too high relative to its window cutout. White space is visible at the bottom of the 4×4 square window. Other faces (Haleakala, Hana) with similar AM/PM dot wheels render correctly.

## Root Cause

Our `drawWheel` function computes label Y-position as `-(tradius - maxH/2)` with `textBaseline='middle'`, where **maxH = fontSize**. iOS uses **measured text height** (`sizeWithAttributes`) instead of `fontSize`.

For Selene's AM/PM wheel:
- `radius=16, fontSize=19` → offset = `-(16 - 9.5)` = `-6.5`
- Actual `●` glyph height ≈ 13px → iOS offset ≈ `-(16 - 6.5)` = `-9.5`

The 3px difference (6.5 vs 9.5) pushes the dot noticeably toward center.

For Haleakala's AM/PM wheel, `radius=13, fontSize=14` — the ratio is tighter, so the error is smaller and less visible.

## Attempted Fix: Use Measured Text Height

Replaced `maxH = fontSize` with `maxH = min(measuredHeight, fontSize)` using `actualBoundingBoxAscent + actualBoundingBoxDescent`. 

**Result**: Broke all dot wheels — the measured height was correct for `●` but pushed dots too far toward the wheel edge, placing them outside the window cutout area. The window's Y was designed around the `fontSize`-based positioning.

## Applied Fix

Targeted XML-only fix in `Selene-I.xml`: shifted the QWheel's Y coordinate by `-1` (Y-up → moves wheel down on screen) so the dot sits centered within the window. The window position was left unchanged.

```diff
-  y='timeBackY+timeBackRad+ampmWheelTweak'
+  y='timeBackY+timeBackRad+ampmWheelTweak-1'
```

## Future Consideration

If many faces exhibit this problem, a proper renderer-level fix would:
1. Use measured text height (like iOS does with `sizeWithAttributes`)
2. **Also** adjust window Y-offsets in the XML to match, since they were authored relative to iOS's measured-height positioning
3. Alternative: compute a per-wheel correction factor based on `fontSize/radius` ratio

The core issue is that our positioning formula and iOS's differ by `(fontSize - measuredHeight) / 2` pixels. For standard alphabetic text this delta is small; for compact glyphs like `●` it's significant.
