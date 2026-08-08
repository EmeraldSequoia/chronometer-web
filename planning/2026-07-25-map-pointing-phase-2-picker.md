# Map Pointing Phase 2 — Fine Location Picker

**Status**: SHELVED (2026-07-25, same day as drafting) — retained as a
historical artifact; do not implement as written. Reasons: (a) Mercator was
subsequently **rejected** (poles must be representable — users legitimately
ask "what's it like at the poles"; see architecture doc decision A6), so the
projection this plan assumes is off the table; (b) on reflection, neither the
OSM nor the Blue Marble backend actually serves the core story of pinpointing
a location *not* near a city; (c) a possible replacement approach is a
**location descriptor field** (paste a Google Maps URL / coordinates / kmz and
parse out lat/lon) — recorded in the architecture doc, not yet planned.
The tile math below (~60–120 tiles per typical session, zoom/precision
tables) remains valid reference material if a tile-based surface is ever
revisited.
**Created**: 2026-07-25
**Last Updated**: 2026-07-25 (rev 2 — shelved)

## Goal

A pan/zoom location picker with a fixed center crosshair, available from the
location dialog in all three apps, designed primarily for pinpointing places
*not* near a city. Full-screen sheet on phones, large modal on desktop.
Online it renders OSM raster tiles; on `file://`/offline it renders a mid-res
Blue Marble base with self-drawn overlays. Applies the location once, on
confirm (unlike explore's continuous apply).

## Interaction Model

- **Grammar**: crosshair fixed at viewport center; gestures move the map.
  Pick = whatever is under the crosshair when the user confirms.
- **Gestures**: one-finger drag pans; pinch zooms (about the pinch center);
  desktop: drag pans, wheel/trackpad zooms, double-click zooms in. The picker
  surface takes `touch-action: none`, `user-select: none`,
  `-webkit-touch-callout: none` and preventDefaults its touches — no native
  text gestures wanted here, and this is a DOM/canvas surface fully owned by
  the picker.
- **Readout bar** (always visible): lat/lon of the crosshair + "34 km NNE of
  Ukiah" nearest-city distance/bearing — reuses `haversineKm` /
  `compassBearing` (currently module-private in
  `src/shared/location-dialog.ts`; move/export into the pointing kit). This
  readout is the primary wilderness-pinpointing aid offline.
- **Buttons**: "Use this location" (applies via the existing
  `applyLocation(..., 'map')` path, then closes the picker back to the
  dialog) and Cancel. Optional snap affordance: tapping a city label centers
  the crosshair on it.
- **Entry points**: a "Pick on map" button in the location dialog's status
  section (all apps); phase 2 also adds **Fine-tune…** to Observatory's
  Keep/Revert pill, opening the picker centered on the dropped point (picker
  is its own overlay component so the pill can invoke it without the dialog).
- **Initial view**: centered on the current location at a mid zoom (~z8);
  world view is two pinches away rather than the default, since refining near
  the current location is the common case.

## Projection (sign-off P1)

Web Mercator, clamped at the standard ±85.051129°. Well-formed everywhere
inside the clamp; the poles themselves are unrepresentable. Alert (82.5°N,
northernmost settlement) is in range; the South Pole station is the one real
exclusion and remains reachable via manual coordinates or city search. The
pointing kit takes the projection as an input, so the explore band stays
equirectangular untouched.

## Online Backend — OSM Tiles

Tiles drawn into the picker canvas as the kit's base layer (not `<img>`
stacking — keeps overlays and base in one draw path).

### Fetch policy

- Fetch **only on gesture settle** (~200 ms debounce after pan/zoom ends);
  never fetch intermediate zoom levels mid-pinch. During gestures, rescale
  already-cached tiles.
- Viewport tiles only — no prefetch ring.
- Concurrency cap ~4; in-memory LRU cache capped by bytes (see memory note).
- Zoom ceiling **z13** (sign-off P2); floor z2.

### The math (sign-off P2 backing)

Scale and coverage (equator; ground resolution improves by cos(lat) at higher
latitudes):

| Zoom | m/px | Tile ground span | Crosshair precision at 1 px |
|------|------|------------------|------------------------------|
| z10  | 153  | 39 km            | ±150 m |
| z12  | 38   | 9.8 km           | ±40 m |
| z13  | 19   | 4.9 km           | ±20 m |

Astronomy sensitivity is ≲1 km, so z13 is already generous; the ceiling exists
for traffic and etiquette, not need.

Tiles per settled view = `(ceil(w/256)+1) × (ceil(h/256)+1)`:

| Surface | Viewport | Tiles/view |
|---------|----------|------------|
| Phone sheet | ~390×740 | 3×4 = 12 |
| Desktop modal | ~900×640 | 5×4 = 20 |

Per pick session (fetch-on-settle, cache hits free):

| Scenario | Settles | Tiles |
|----------|---------|-------|
| Typical: open → 2–3 zoom steps → 2–3 pans → confirm | 5–7 | **~60–120** |
| Heavy wander (continent browsing at several zooms) | 15–25 | ~250–400 |
| Today's dialog preview, for comparison | 1 | 4 |

Sessions are rare events (location changes), so this is well inside "light
use" for the OSM public tile server, which the app already uses for the
preview. Still: keep the existing attribution, rely on the browser's normal
Referer, and hold the settle-only/no-prefetch policy. **Contingency** (no code
now): if usage or policy ever becomes a concern, the base layer is one URL
template away from an alternate raster provider (OpenFreeMap, Protomaps,
Carto).

## Offline Backend — Mid-res Blue Marble (sign-off P3)

Trigger: `file://` (same detection the dialog already uses) or tile fetch
failure (the existing "(offline)" case).

- **Asset**: Blue Marble Next Generation (NASA, public domain) at 2048×1024,
  JPEG q≈70 → ~200–400 KB file, ~270–530 KB as a base64 lazy chunk
  (`blue-marble-hd.js`), loaded via the same `<script>`-injection pattern as
  `cities-data.js` (proven on `file://`). Never in the main bundle; fetched
  only when the picker opens offline. The existing 360×180 `BLUE_MARBLE`
  stays as-is for the globe/magnifier.
- **Memory**: decode on open (~8.4 MB RGBA). Reprojection to Mercator: v1
  reprojects once into an offscreen canvas (~2048×2048, ~16.8 MB) at open —
  simplest correct thing; dropped on close; reported in the `[mem]` ledger
  while alive. If ledger pressure objects, the alternative is per-draw
  scanline warping (no extra canvas, ~1 ms per redraw) — decide during
  implementation.
- **Honest zoom ceiling**: 2048 px/360° ≈ 5.7 px/°; the imagery carries to
  ~z5–6 and is a blur wash beyond. Zooming past that stays *allowed* (up to
  the same z13): past z6, position information comes from the overlays —
  graticule, city dots/labels (city DB works on `file://`), the lat/lon
  readout, and the distance/bearing line. That combination is the designed
  offline experience, not a degraded accident.
- Optional later upgrade (explicitly deferred): small vector coastline
  (Natural Earth 110m class) for crisp edges at any zoom.

## Memory Budget (while picker open; all released on close)

| Item | Bytes |
|------|-------|
| Tile LRU cache (online), cap 60 tiles as ImageBitmaps | ~16 MB |
| BM-HD decoded + Mercator reprojection (offline) | ~25 MB |
| Picker canvas (phone, dpr 3: 1170×2220×4) | ~10 MB |

Online and offline assets are mutually exclusive; worst case ≈ 26 MB transient
on top of the app baseline — acceptable against the phone floor given
open-picker is a brief, user-initiated state, but it must show in the `[mem]`
ledger to stay honest.

## Consistency With Explore

Same kit, same crosshair visual, same city dot/label styling, same readout
formatting as the phase-1 magnifier. Confirm patterns rhyme: explore =
Keep/Fine-tune…/Revert on release; picker = Use this location/Cancel.

## Known Costs / Risks

- **Two dialog implementations**: the shared `location-dialog.ts` and
  engine-entry's parallel copy both need the "Pick on map" entry point. Either
  we wire it twice, or this is the excuse to converge the watch app onto the
  shared dialog first. Decide at implementation start; convergence is
  preferred if it isn't a rabbit hole.
- **Gesture edge cases** on iOS (pinch vs page zoom, rubber-banding inside a
  full-screen sheet) — the surface owns its touches via `touch-action: none`,
  but this needs real-device time in verification.
- **Tile licensing/etiquette drift** — revisit the OSM policy text once at
  implementation time; contingency provider noted above.
- **Label density tuning** shared with phase 1 (same kit knobs).

## Verification

- Headless: picker open/close leaves no retained canvases (ledger delta zero);
  crosshair pick accuracy round-trips (`pxToLatLon(latLonToPx(x)) ≈ x`,
  including at the ±85° clamp and the antimeridian); settle-debounce produces
  the predicted tile counts for scripted gesture sequences (count network
  requests in the pane).
- On device: pinch/pan feel, pick SF vs SJ vs specific neighborhoods, offline
  mode via `file://` build (labels + readout carry past z6), Fine-tune… flow
  from a coarse explore drop to a ≤100 m pick.
- Cross-app: picker reachable and consistent from Observatory, Inspector, and
  the watch app dialogs.
