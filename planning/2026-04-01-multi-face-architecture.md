# Multi-Face Architecture Plan

Four concerns addressed in parallel below.

---

## 1. Energy-Efficient Rendering

**The problem**: A naive `requestAnimationFrame` loop fires at 60–240fps regardless of whether anything is moving, wasting CPU/GPU and draining battery.

**Strategy**: Use `rAF` only for active animation; use `setTimeout` to wake up just before each update boundary when idle.

**States a face can be in:**
| State | What's happening | Render behavior |
|---|---|---|
| **Idle** | All hands at rest, no update due | `setTimeout` to next boundary; zero drawing |
| **Animating** | One or more hands sweeping | `requestAnimationFrame` at full monitor rate (up to 240fps) |
| **Updating** | An update interval fires | Re-evaluate angle; if delta > threshold enter Animating, else snap and go Idle |

**Key rules:**
- **Update timing** is governed by the `update` XML attribute on each hand (epoch-aligned, e.g. every 1s, 60s, or at next sunrise/midnight). Use `setTimeout` for this.
- **Animation timing** uses `requestAnimationFrame` so the browser delivers frames at whatever rate the monitor/GPU supports.
- A shared scheduler tracks `min(handState.nextUpdateTime)` across all active faces and arms a single `setTimeout`.

**Implication for "display-on-desk" use case**: Outside animation windows (~250ms per second-hand tick), the tab is completely idle — roughly 2.5% CPU duty cycle vs. 100%.

---

## 2. Shadow Hand Pre-rendering

**Background**: In the iOS app, Henry generates shadow bitmaps at build time using ImageMagick (`convert`) and stores them in the texture archive. The shell scripts in `.chronometer-ref/scripts` show exactly how these are invoked. The web app currently references these bitmaps by filename (e.g. `pm-window-border-shadow.png`); they must be synthesized at startup instead.

**Approach**: At startup, for each `Image` part whose `src` matches a known shadow filename, synthesize the bitmap on an `OffscreenCanvas` and store it on the `ImagePart`:

```
prerenderedBitmap?: ImageBitmap;
```

The renderer checks `prerenderedBitmap` first; if present, blits it directly without any `src`-based load.

**Accuracy**: Does not need to be pixel-perfect, but **must match the general dimensions and parameters from the XML attributes** — these were hand-tuned against ImageMagick's `convert` output. The synthesis algorithm should read the same XML parameters (`shadowOpacity`, `shadowSigma`, `shadowOffset`, etc.) that `convert` used.

**Shadow types**:
- **Window border shadows**: Blurred, semi-transparent outline of the window border shape (rect or porthole). Geometry from the `<window>` part's `w`, `h`, `border` attributes.
- **Hand shadows**: Shadow hands **track their parent hand** — they animate in sync, offset by XML-specified amounts. They are dynamic parts (like `QHand`), not static images. The offset attributes in the XML control their displacement from the parent.

**Naming convention**: The XML `src` strings act as a key to select the correct synthesizer (`shadowSynthesizers` lookup table).

---

## 3. Multi-Face Grid Display (20–25 Faces)

**Sources**: One XML file per face, from `Watches/Builtin-Android` (one file per face, no front/back split).

**Layout**: A fixed CSS grid that fills the browser window. Column/row count is determined by the number of active faces using a `ceil(sqrt(N))` heuristic. **No scrolling.** The user can select which watches appear in the grid.

**Grid layouts**: For each count of active watches, provide a fixed layout that looks aesthetically pleasing. Exact arrangements are TBD.

**Per-face data model**:
- Each face is a `FaceInstance` with its own `Environment`, `OffscreenCanvas` (StaticCache), and `HandState[]`.
- The parsed `Watch` model is not shared (each face appears at most once in the grid).
- `ResizeObserver` on the grid container triggers debounced StaticCache rebuilds when the window changes size.

**Shared scheduler**: One scheduler aggregates `nextWakeupTime` across all active faces and fires a single `setTimeout`/`rAF` cycle.

**Canvas sizing**: Each canvas is sized to exactly fill its grid cell at device pixel ratio, so the internal draw resolution scales automatically. The total canvas diameter in XML units is `faceWidth + 2 × bezelThickness`.

**Bezel ring**: Each watch face is surrounded by a solid circular ring whose color is specified by the `bezelColor` attribute on the `<watch>` element. If absent, no ring is drawn.

- **Thickness**: Uniform across all faces — `BEZEL_THICKNESS_XML = 10` XML units. Computed as `⌊2/3 × gap⌋` where `gap = faceWidth/2 − mainR`. For Haleakala: `faceWidth/2 = 133`, `mainR = 118`, `gap = 15`, `bezel = 10`.
- **Rendering**: Drawn as a filled annulus (even-odd fill rule) in `buildStaticCache`, after all other parts, in the already-scaled coordinate system. Inner radius = `faceWidth/2`, outer radius = `faceWidth/2 + bezelThickness`.
- **Scale effect**: The canvas scale denominator becomes `faceWidth + 2 × bezelThickness` (286 for Haleakala), so the ring is always fully visible without clipping.

---

## 4. Memory Budget (100MB for 20–25 Faces)

### Budget breakdown (rough estimate, 25 faces)

| Component | Per face | 25 faces total |
|---|---|---|
| StaticCache OffscreenCanvas (280×280 @ RGBA) | 0.31 MB | 7.8 MB |
| Shadow bitmaps (avg 10 per face × 64×64 @ RGBA) | 0.16 MB | 4.0 MB |
| Watch AST / model objects | ~0.1 MB | 2.5 MB |
| Watch `Environment` | ~0.05 MB | 1.25 MB |
| JS heap, GPU textures, fonts, etc. | — | ~20 MB |
| **Estimated total** | | **~36 MB** |

At 2× device pixel ratio, static caches double to ~15.6 MB (total ~43 MB) — still within 100 MB.

### Memory management rules
1. **Release `StaticCache`** for disabled (not currently shown) faces; rebuild on re-enable.
2. **No scrolling** — "off-screen" means the face is disabled by the user, not scrolled.
3. **Downscale shadow bitmaps** aggressively at small grid sizes.
4. **Avoid double-buffering** — write directly to each face's visible canvas.

### Initialization
Build static caches **sequentially** via `setTimeout(fn, 0)` chaining. It is acceptable for faces to appear one by one over a few seconds during startup.
