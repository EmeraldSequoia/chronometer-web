# Map Pointing Architecture — Explore Magnifier (+ shelved Picker)

**Status**: ACTIVE for phase 1 only. Phase 2 (zoomable picker) SHELVED
2026-07-25 pending a rethink — its plan doc is retained as a historical
artifact. Revised same day it was drafted, after further discussion.
**Created**: 2026-07-25
**Last Updated**: 2026-07-25 (rev 3 — A8: magnifier confined to band bounds)

Companion docs:

- `2026-07-25-map-pointing-phase-1-magnifier.md` — ACTIVE plan: Observatory
  explore magnifier + immediate fixes
- `2026-07-25-map-pointing-phase-2-picker.md` — SHELVED; historical artifact

## Background

On iPhone, tap-and-hold on the Observatory earth map produced a magnifier
bubble that was useful for drag-to-explore. Investigation (2026-07-25) showed
it is the iOS *text-selection loupe* firing by accident: the canvas has default
`user-select`, so a long-press starts a WebKit text-interaction gesture. The
same mechanism causes the two observed bugs: the loupe dies unrecoverably when
the finger drifts off the map band in 3 of 4 directions (closed-source UIKit
heuristics reacting to a silent DOM selection WebKit maintains during the
gesture), and on lift WebKit commits a word-selection that lands in the
Keep/Revert pill's text (the pill's full-screen overlay is already visible at
gesture end, and its text is the only selectable text on screen).

Steve's on-device tests (directional drift; whole-display block selection on a
left-half long-press) confirmed the mechanism and closed the question:
**we do not build on the native loupe.** We replace it with designed UI.

## Committed Scope (Phase 1)

Explore (Observatory earth band): while dragging, show clearly where the
finger/cursor is pointing — reliably, on all platforms, without the OS loupe.
Explore's purpose is watching location *differences* play out on the dial, so
it stays in-place (never full-screen) and coarse. Plus the zero-cost fixes:
cursor hiding during drag, selection hygiene, native-loupe retirement.

This is the clear win: it eliminates the visual oddities in the shipping app
(loupe death at borders, selected pill text, cursor covering map pixels) and
stands alone — nothing in phase 1 is designed for reuse by a future picker.

## Decisions Log

Agreed 2026-07-25 (discussion, on-device tests):

| # | Decision |
|---|----------|
| A1 | Native loupe abandoned; replace with app-drawn magnifier (UI label: "magnifier" — plain words, no jargon). |
| A2 | Explore stays in-place and pixel-coarse (1 band px ≈ 70 km on a 16" laptop, ~2× coarser on phones — measured: one pixel jumped San Jose → San Francisco). The magnifier shows *which* pixel; it does not pretend to add input precision. Hairlines-only was evaluated and rejected on this measurement. |
| A3 | **Magnifier content mirrors the live band** — not a hardcoded day image. The band composites 12 monthly Blue Marble day images (600×300 @2x) with a night image and the terminator per tick; the magnifier must show whatever the band currently shows (simplest faithful mechanism: blit the band's already-rendered pixels, draw crisp overlays on top — see phase 1 doc). |
| A4 | Free win: hide the mouse cursor while drag crosshairs are visible (redundant with crosshair; covers map pixels). |
| A5 | Hygiene patches: `user-select: none` on the Keep/Revert pill + deferred `removeAllRanges()` on show; canvas `-webkit-user-select: none` + `-webkit-touch-callout: none` land in the same release as the magnifier (never earlier — they kill the loupe with no replacement). |
| A6 | **Mercator rejected** for any location-picking surface: users can legitimately ask "what's it like at the poles" without planning to go there, and Web Mercator cannot represent ±90° at all (standard clamp is ±85.05°). Any future picker must use a pole-capable presentation (equirectangular, azimuthal insets, or similar). |
| A7 | **Phase 2 (zoomable picker) shelved.** On reflection, neither an OSM tile backend nor a Blue Marble backend actually serves the core story — pinpointing a location that is *not* near a city (BM lacks the detail; OSM detail doesn't identify wilderness points either). The phase 2 doc is kept as a historical artifact; no shared infrastructure between phases is assumed. |
| A8 | The magnifier bubble stays **entirely within the map band bounds** — it never covers other parts of the display. Placement is a continuous offset toward the band center (no flip states, no jumps); on phones this caps the bubble at ~band height. |

## Alternative Under Consideration (not planned)

Instead of a zoomable map picker: a **location descriptor field** — paste a
Google Maps URL, bare coordinates in common formats, a kmz/geo link, etc., and
the app parses out lat/lon. Users who need a precise off-city location have
usually already found it in a tool built for that job; accepting its output
may beat rebuilding a worse version of that tool. To be explored separately if
the need returns; recorded here so the idea isn't lost.

## Cross-cutting Constraints (from project conventions)

- Full update rate during drag is a hard constraint (no quiescent-layer
  buffering); the magnifier rides the existing per-tick render.
- Phone memory floor: no new persistent canvases/bitmaps for the magnifier.
- UI labels use plain words ("Magnifier" — never "loupe").
- Chrome buttons keep stable positions.
