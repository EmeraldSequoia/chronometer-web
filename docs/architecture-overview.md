# Architecture Overview

This repository is a monorepo containing multiple web apps that share a common astronomy and infrastructure layer. All apps are pure client-side — they contact no backend servers and run entirely in the browser (or from `file://` URLs).

## Apps

| App | Entry point | Bundle | Purpose |
|-----|-------------|--------|---------|
| **Chronometer** | `src/engine-entry.ts` | `chronometer-engine.js` | Canvas-rendered watch faces from XML definitions |
| **Inspector** | `src/inspector/inspector-entry.ts` | `inspector-engine.js` | Text-based astronomy data explorer with expression evaluator |
| **Observatory** | `src/observatory/observatory-entry.ts` | `observatory-engine.js` | Port of Emerald Observatory — astronomical clock with orrery, moon phase, earth map |

## Source Directory Layout

```
src/
├── astronomy/           # Shared: astronomical computations (WB series, rise/set, etc.)
├── expr/                # Shared: expression tokenizer, parser, evaluator
├── shared/              # Shared: infrastructure modules used by multiple apps
│   ├── astro-env.ts         # Astronomy function registry + createAstroEnvironment() factory
│   ├── animation.ts         # Animation primitives (AnimatingValue, startAnimationRaw, interpolateValue) + update-interval sentinel scheduling
│   ├── obs-value.ts         # ObsValue: general expression-driven animated value (type + createObsValue)
│   ├── updater.ts           # Shared updater: name-keyed Updater<K> + ObsValue update/animate passes + eval-ahead/TimingContext seam
│   ├── time-controller.ts   # Time scrubbing, stepping, play/pause
│   ├── time-controls-ui.ts  # Shared transport bar/popover; generic controller↔updater seam (auto reset + time-state persistence)
│   ├── city-search.ts       # City name lookup against GeoNames database
│   ├── location-dialog.ts   # Self-contained location picker (DOM, search, mini-map)
│   ├── mini-map.ts          # Blue Marble globe renderer
│   ├── app-state.ts         # State front door: LocalStorage by default, URL for sharing/fallback (getState/setState)
│   ├── incoming-settings-dialog.ts # Shared-link prompt, storage warning, paradigm notice, (URL) badge
│   ├── share-button.ts      # "Share this view" button → buildShareUrl + copy
│   ├── url-state.ts         # URL serializer (UrlState, readUrlState/writeUrlState, buildShareUrl) used by sharing + the URL fallback
│   ├── dst-detect.ts        # DST transition detection
│   └── tz-resolve.ts        # Lat/lon → Olson timezone resolution
├── watch/               # Chronometer-only: XML parsing, rendering, watch-specific env
│   ├── watch-env.ts         # Imports astro-env, adds Terra/Kyoto/Venezia specifics + wedge/terminator/analemma/calendar env functions
│   ├── hand-values.ts       # Chronometer↔Updater bridge: buildHandValues / buildTerminatorValues / buildAnalemmaValues (parts → ObsValues)
│   ├── renderer.ts          # Canvas rendering of watch parts (reads each part's _obs* ObsValue)
│   ├── xml-parser.ts        # Watch XML → part model
│   └── ...
├── inspector/           # Inspector app
│   ├── inspector-entry.ts   # Entry point (imports only shared/, expr/, astronomy/)
│   ├── inspector.html       # Self-contained HTML page
│   └── expr-metadata.ts     # Curated function/constant descriptions for autocomplete
├── observatory/         # Observatory app (Emerald Observatory port)
│   ├── observatory-entry.ts # Entry point (imports only shared/, expr/, astronomy/)
│   ├── observatory.html     # Full-viewport canvas page
│   ├── layout.ts            # Responsive layout engine (computes all positions from viewport)
│   └── draw-utils.ts        # Shared Canvas 2D drawing primitives (ticks, circular text, etc.)
├── faces/               # Per-face entry points (XML + image assets)
├── engine-entry.ts      # Chronometer entry point
└── ...
```

## Import Discipline

Apps must follow strict import boundaries to ensure bundle isolation:

| Module | May import from |
|--------|----------------|
| `src/astronomy/` | Standard library only |
| `src/expr/` | Standard library only |
| `src/shared/` | `src/astronomy/`, `src/expr/` |
| `src/watch/` | `src/shared/`, `src/astronomy/`, `src/expr/` |
| `src/inspector/` | `src/shared/`, `src/astronomy/`, `src/expr/` — **never** `src/watch/` |
| `src/observatory/` | `src/shared/`, `src/astronomy/`, `src/expr/` — **never** `src/watch/` |

This ensures that `inspector-engine.js` does not pull in Chronometer-specific code (XML parser, renderer, face assets). Verify with: `grep -c 'watch/' dist/inspector-engine.js` (should be 0).

## Shared Environment Architecture

The expression evaluation environment is built in two layers:

1. **`astro-env.ts`** (`src/shared/`): Registers ~159 astronomy, calendar, and time functions into an `Environment`. Provides `createAstroEnvironment()` — a factory that creates a ready-to-use environment from lat/lon/timezone, with no dependency on the watch model. Used directly by Inspector and future apps.

2. **`watch-env.ts`** (`src/watch/`): Imports `registerAstroFunctions()` from astro-env and adds Chronometer-specific functions: Terra/Gaia world-time slot system, Kyoto wadokei master rotation, Venezia body selector, and the `evalAttr`/`evalColor` helpers. Creates environments from parsed `Watch` models.

---

## Chronometer: Design Decisions

### XML-to-Canvas

The original iOS app used a two-part architecture:
1. **Henry** (preprocessor): reads XML watch definitions, parses C expressions, renders pixel assets into texture atlases, and creates binary archive files
2. **Chronometer** (runtime): reads Henry's artifacts and renders using OpenGL 1.x

The web app chose **direct XML-to-Canvas rendering**, eliminating Henry entirely:

- The Cocoa drawing primitives used by Henry map directly to Canvas 2D APIs
- C expressions are simple enough to parse and evaluate at runtime in TypeScript
- No iOS SDK / Xcode dependency for watch face changes — just edit the XML
- The binary archive format was an optimization for 128MB iPhones and early OpenGL, neither of which applies to modern browsers

### Cocoa → Canvas 2D Mapping

| Cocoa API | Canvas 2D equivalent |
|-----------|---------------------|
| `CGContextAddArc` | `ctx.arc()` |
| `CGContextAddLineToPoint` | `ctx.lineTo()` |
| `CGContextMoveToPoint` | `ctx.moveTo()` |
| `CGContextFillPath` / `CGContextStrokePath` | `ctx.fill()` / `ctx.stroke()` |
| `CGContextDrawImage` | `ctx.drawImage()` |
| `CGContextSetAlpha` | `ctx.globalAlpha` |
| `CGContextSaveGState` / `CGContextRestoreGState` | `ctx.save()` / `ctx.restore()` |
| `CGContextScaleCTM` / `CGContextTranslateCTM` | `ctx.scale()` / `ctx.translate()` |
| `CGContextEOClip` | `ctx.clip()` with `evenodd` |
| Text drawing | `ctx.fillText()` / `ctx.strokeText()` |

## Part Classification

Each XML part type is classified as static (drawn once, cached) or dynamic (redrawn per frame):

| Part Type | Classification | Notes |
|-----------|---------------|-------|
| QDial | Static | Fixed dials, tick marks, text |
| QRect | Static | Date window backgrounds |
| QText | Static | Labels |
| Image | Static | Face, band, case images |
| Window | Static | Clips the following part |
| Wheel | Mostly static | Static between date changes; animated during transitions |
| Static | Static | Container of static parts |
| QHand | **Dynamic** | Moves per-frame |
| QWedge | **Dynamic** | Moves per-frame (filled arc segments) |
| Terminator | **Dynamic** | Moon phase leaves animate |
| Analemma | **Dynamic** | Pure blitting: 3 pre-rendered bitmaps (bg+border, channel+ticks, Sun+shadow) |
| EotDial | Static | Procedural EOT subdial (arc, ticks, labels) drawn once into cache |
| CalendarRowCover | **Dynamic** | Slides during month transitions |
| Button | Dynamic | Not drawn yet, but will need per-frame position |

## Multi-Face Grid Architecture

The app displays 20–25 watch faces simultaneously in a CSS grid:

- Column/row count determined by `ceil(sqrt(N))` heuristic
- Each face is a `FaceInstance` with its own `Environment`, `OffscreenCanvas` (static cache), and per-face `Updater` (ObsValues; built by `buildHandValues`)
- `ResizeObserver` triggers debounced static cache rebuilds when the window resizes
- Each canvas is sized to fill its grid cell at device pixel ratio

## Energy-Efficient Rendering

The renderer uses a two-state system to minimize CPU usage:

| State | What's happening | Render behavior |
|-------|-----------------|-----------------| 
| **Idle** | All hands at rest | `setTimeout` to next boundary; zero drawing |
| **Animating** | Hands sweeping | `requestAnimationFrame` at full monitor rate (up to 240fps) |

A shared scheduler tracks `min(handState.nextUpdateTime)` across all active faces and arms a single `setTimeout`. Outside animation windows (~250ms per second-hand tick), the tab is completely idle — roughly 2.5% CPU duty cycle vs. 100%.

## Memory Budget (25 Faces at 2× DPR)

| Component | Per face | 25 faces total |
|-----------|---------|----------------|
| Static cache OffscreenCanvas | ~1.2 MB | ~31 MB |
| Shadow bitmap caches | ~0.8 MB | ~20 MB |
| Watch AST / model objects | ~0.1 MB | ~2.5 MB |
| Watch Environment | ~0.05 MB | ~1.25 MB |
| JS heap, GPU textures, fonts | — | ~20 MB |
| **Estimated total** | | **~75 MB** |

Well within the 100 MB budget target.

## Related Docs

- [Rendering](rendering.md) — Static cache and window cutout details
- [Animation](animation.md) — Two-time-base system and scrubbing
- [Timezone & DST](timezone-and-dst.md) — DST transition detection and timezone offset handling
- [Build System](build-system.md) — How face bundles are built
- [Adding a New App](adding-a-new-app.md) — How to add a new app to the monorepo
