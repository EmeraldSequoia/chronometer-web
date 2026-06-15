# Cached Rendering Architecture & Window Cutouts

## Problem

Two related issues in the current renderer:

1. **Window cutouts not implemented.** `<window>` parts are supposed to cut transparent holes in the part that immediately follows them. Currently they only draw a border/shadow — they don't clip anything.

2. **No static caching.** Every call to `renderWatch` redraws the entire watch face from scratch. For 60fps hand animation, we need to separate static elements (dials, text, tick marks, images) from dynamic elements (hands) and cache the static layer.

## How Windows Work (Original iOS)

In the XML, a `<window>` element appears **before** the part it clips:

```xml
<!-- These 3 windows stash themselves, then apply to the next drawable part -->
<window name='month win'  x='...' y='...' w='42' h='16' border='2' ... />
<window name='day win'    x='...' y='...' w='24' h='16' border='2' ... />
<window name='wkday win'  x='...' y='...' w='74' h='13' border='2' ... />

<!-- This static block is the "next part" — all 3 windows are cut from it -->
<static name='front' modes='front'>
    <Image name='face' ... />
    <QDial name='az dial' ... />
    ...
    <!-- Windows inside the static also cut from the static's own rendering -->
    <window name='fr am/pm' x='0' y='-96' w='5' h='5' type='porthole' ... />
    <Image name='band' ... />
    <Image name='case' ... />
    ...
</static>
```

The original iOS implementation (`ECWatchDefinitionManager.m`):
- `parserDidWindowStart` stashes each window in a `winBin` array  
- When the next drawable view is created, `applyWindows` transfers all pending windows to that view
- At render time, the view's `clearHolesForBounds` method cuts transparent regions

## Architecture Overview

```
                       ┌──────────────────────────────┐
                       │        Static Cache           │
     Rebuilt when:     │   (OffscreenCanvas)           │
     - mode changes    │                               │
     - date changes    │  Dials, ticks, text, images,  │
     - env changes     │  QRects, wheels, windows      │
                       │  (with holes cut out)         │
                       └──────────────┬───────────────┘
                                      │ drawImage()
                       ┌──────────────▼───────────────┐
                       │        Main Canvas            │
     Every frame       │                               │
     (60fps via rAF)   │  1. Draw cached static layer  │
                       │  2. Draw dynamic hands on top  │
                       └──────────────────────────────┘
```

## Proposed Changes

### Part Classification

Each part type is classified as static or dynamic:

| Part Type | Classification | Notes |
|-----------|---------------|-------|
| QDial     | Static        | Fixed dials, tick marks, text |
| QRect     | Static        | Date window backgrounds |
| QText     | Static        | Labels |
| Image     | Static        | Face, band, case images |
| Window    | Static        | Clips the following part |
| Wheel     | Mostly static | Static between date changes; animated during transitions |
| Static    | Static        | Container of static parts |
| QHand     | **Dynamic**   | Moves per-frame |
| Button    | Dynamic       | Not drawn yet, but will need per-frame position |

---

### Renderer (`renderer.ts`)

#### [MODIFY] [renderer.ts](file:///Users/spucci/chronometer-web/src/watch/renderer.ts)

**1. Split `renderWatch` into `buildStaticCache` + `renderFrame`**

```typescript
// Called once (or when environment changes)
export function buildStaticCache(
    watch: Watch,
    env: Environment,
    canvasWidth: number,
    canvasHeight: number,
    scale: number,
): OffscreenCanvas { ... }

// Called at 60fps
export function renderFrame(
    ctx: CanvasRenderingContext2D,
    staticCache: OffscreenCanvas,  // pre-rendered background
    watch: Watch,                   // for dynamic hands
    env: Environment,
    scale: number,
): void { ... }
```

**2. Add window cutout logic to `buildStaticCache`**

The static rendering loop processes parts in document order:

```
pendingWindows = []

for each part in document order:
    if part is Window:
        pendingWindows.push(part)
    else if pendingWindows is not empty:
        // This part has windows — render to temp canvas, cut holes, composite
        tempCanvas = createOffscreen(canvasWidth, canvasHeight)
        drawPartToCanvas(tempCanvas, part)
        for each window in pendingWindows:
            cutHole(tempCanvas, window)  // destination-out
        compositeOnto(staticCache, tempCanvas)
        drawWindowBorders(staticCache, pendingWindows)
        pendingWindows = []
    else:
        // No windows — draw directly
        drawPart(staticCache.ctx, part)
```

**3. Window hole cutting via Canvas composite operations**

```typescript
function cutHole(canvas: OffscreenCanvas, window: WindowPart): void {
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    if (window.windowType === 'porthole') {
        // circular cutout
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
        ctx.fill();
    } else {
        // rectangular cutout
        ctx.fillRect(x, y, w, h);
    }
    ctx.restore();
}
```

**4. Per-frame rendering**

```typescript
function renderFrame(ctx, staticCache, watch, env, scale) {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(staticCache, 0, 0);  // one blit

    // Draw only dynamic parts (hands)
    ctx.save();
    ctx.translate(width/2, height/2);
    ctx.scale(scale, scale);
    for (const part of watch.parts) {
        if (part.type === 'QHand') {
            drawQHand(ctx, part, env);
        }
    }
    ctx.restore();
}
```

---

### Entry Points

#### [MODIFY] [standalone.ts](file:///Users/spucci/chronometer-web/src/standalone.ts)

- Call `buildStaticCache` once after parsing
- Start a `requestAnimationFrame` loop calling `renderFrame`
- Initially, env is static (stub functions), so the cache is built once
- Future: rebuild cache when date/timezone changes

#### [MODIFY] [main.ts](file:///Users/spucci/chronometer-web/src/main.ts)

- Same changes as standalone.ts

---

### Animation Loop (Future-Ready)

```typescript
let staticCache: OffscreenCanvas;

function init() {
    staticCache = buildStaticCache(watch, env, width, height, scale);
    requestAnimationFrame(animate);
}

function animate() {
    updateEnvironment(env);  // update time functions
    renderFrame(ctx, staticCache, watch, env, scale);
    requestAnimationFrame(animate);
}
```

## Key Design Decisions

### Windows inside `<static>` blocks

Windows inside a `<static>` block (like `fr am/pm` inside `<static name='front'>`) only clip within that static block's own render context. The static block itself is already rendered to an offscreen canvas (because it has outer windows applied), so inner windows naturally operate within that same buffer.

### Nested window accumulation

Multiple consecutive windows accumulate and ALL apply to the next non-window part. This matches the original behavior where `winBin` collects windows until they're consumed.

### Cache invalidation

The static cache should be rebuilt when:
- The watch mode changes (front/back/night)
- Date-dependent values change (month, day, weekday wheels)
- Environment slot changes (timezone, location)

For now (stub time functions), the cache is built once and never invalidated.

## Memory Budget

| Item | Size (at 2x) | Notes |
|------|-------------|-------|
| Static cache | ~6.5 MB | 1280×1280×4B, always allocated |
| Temp composite buffer | ~6.5 MB | Reused for each windowed part, freed after cache build |
| Main canvas | ~6.5 MB | The visible canvas |
| **Total** | **~19.5 MB** | Well within 100 MB budget |

At 1x (non-retina): ~5 MB total.

## Verification Plan

### Visual
- Compare rendered output before and after the change — all existing elements should be identical
- Windows should cut visible holes through the face image (once images are implemented)
- Window borders should appear at the correct positions with correct shadows

### Performance
- Measure frame time in `renderFrame` — should be <2ms at 60fps
- Measure `buildStaticCache` time — acceptable if <100ms (runs once)

### Manual
- Open dist/index.html, confirm all dials/text/ticks render correctly
- Confirm hands still animate smoothly (after animation loop is added)
