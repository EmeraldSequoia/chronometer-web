# Observatory

Developer documentation for the Observatory watch face — a custom (non-XML-driven)
watch face that renders an astronomical orrery with clock hands, subdials, planet
hands, rise/set rings, and a sun altitude ring.

## Source Layout

```
src/observatory/
├── observatory-entry.ts   Main tick loop, init, draw orchestration
├── background.ts          Starfield background image (static cache)
├── main-dial.ts           Central orrery dial background (static cache)
├── obs-values.ts          Observatory ObsValue catalog (ObsValueName, defs, buildObsValues)
├── hand-views.ts          Clock hands + sun event hands + subdial hands
├── planet-hands.ts        Planet hands on the orrery
├── ring-view.ts           Rise/set rings (sun altitude ring + planet arcs)
├── earth-view.ts          Earth map with day/night terminator
├── moon-view.ts           Moon phase display (apparent size, terminator)
├── peripheral-dials.ts    Alt/Az/EOT/Eclipse dial backgrounds (static cache)
├── peripheral-hands.ts    Alt/Az/EOT hands + selected-body labels
├── eclipse-view.ts        Eclipse simulator disc + status labels + ring hands
├── date-view.ts           Header date display (weekday/date/year/leap/tz)
├── layout.ts              Base layout templates (radii, positions) + base builder
├── anchor-layout.ts       Adaptive layout: 9 aspect anchors + selector (iteration 3)
└── draw-utils.ts          Shared drawing utilities (circular text, etc.)
```

## Adaptive Layout (Aspect Anchors)

The outer composition (where the moon, map, date, main dial, and four outer
dials sit) is **adaptive by window aspect**, implemented in
[anchor-layout.ts](../src/observatory/anchor-layout.ts) — the production home of
the geometry tuned in `harness/layout-harness.html`. See
[planning/2026-06-15-observatory-layout-iter3.md](../planning/2026-06-15-observatory-layout-iter3.md)
for the full per-anchor rules.

`computeLayout(viewW, viewH, chrome, ctx, date, timezone)` runs this pipeline:

1. **Safe rect** — the design surface = the physical viewport minus the device
   safe-area insets (the entry reads `env(safe-area-inset-*)`, exposed by
   `viewport-fit=cover`; zero on desktop windows). All layout math is in the
   safe rect.
2. **Chrome-drop (CC2)** — if the safe rect can't fit the time-controller's
   default popover (200×368), the header + footer bands are dropped so the
   degenerate slivers (A1/A6) use the whole surface.
3. **Anchor selection** — one of **nine** aspect anchors is chosen by a hard
   snap at the §7 thresholds (no interpolation in v1): A1 extreme-portrait,
   A2 iPhone-portrait, A3m iPad-mini, A3 iPad-portrait, Asq square, A4
   iPad-landscape, A5 iPhone-landscape, Awide ultrawide, A6 extreme-landscape.
4. **Base + adjust** — a base template is built (A2 pins `portraitTwoBand`,
   A3/A3m pin `portraitOneBand`, the rest use `computeBaseLayout`) and that
   anchor's `applyXxx` adjustment runs, in content space (top = 0, below the
   header band). The date-driven anchors (A1/A5/A6/Awide) measure the date text
   against `ctx` so the region matches what the renderer draws.
5. **Offset** — every coordinate is shifted into the safe rect, below the
   header, so the returned `LayoutParams` are absolute canvas coordinates (the
   renderers and click hit-test are unchanged).

`extDerived` applies **CC1**: the eclipse marker ring's footprint is sized to
`extR` so all four outer dials read the same size.

**The harness imports the same `applyXxx` functions** (passing its live slider
values where production bakes the ship constants), so it can't drift from the
app — see the planning doc §9.6. After editing
`anchor-layout.ts`/`layout.ts`/`date-view.ts`, rerun `./harness/build-harness.sh`
and bump the `?v=N` query in `layout-harness.html`.

> **Layout recompute cadence:** the layout is re-solved on resize and on a
> timezone change (location switch). A same-timezone day-boundary shift that
> would re-measure the date region (A1/A5/A6/Awide only) is deferred to the next
> resize — the renderer always re-fits the date text to its box, so this is at
> most a slight box-size staleness at those anchors.

## ObsValue System

All dynamic elements on the Observatory dial are driven by **ObsValue** objects —
expression-driven values that are parsed once, evaluated on a schedule, and
smoothly animated between updates.

> **The ObsValue core is shared.** The generic value type + construction live in
> [src/shared/obs-value.ts](../src/shared/obs-value.ts); the per-frame
> update/animate passes (snap-to-target, two-phase `naturalSpeed` sweep, scrub
> compression, lag-free eval-ahead) and the **`Updater`** collection live in
> [src/shared/updater.ts](../src/shared/updater.ts) — the shared updater
> subsystem, also used by the Inspector. `obs-values.ts` is purely the
> Observatory **catalog**: it names every value (`ObsValueName`), builds the
> definitions, and `buildObsValues(env, perfNow, getNow)` registers them on an
> `Updater<ObsValueName>`, asserting at startup that the full catalog is present
> exactly once. Renderers read values by name via `updater.get(name)` —
> see [animation.md → TimingContext and the `Updater`](animation.md#timingcontext-and-the-updater).

### Architecture

```
tick()
 ├── updater.tick(env, perfNow, getNow, withDisplayTime, ctx)
 │      — re-eval expired expressions + animate all values toward targets,
 │        where ctx = timingContextForFrame(timeController)
 └── drawFrame()  — renderers read updater.get(name).currentValue
```

The whole controller→value path is the generic seam: `buildObsValues` constructs
the `Updater`, the entry hands it to `initTimeControls({ updater, … })` (so every
transport transition auto-re-arms the schedules), and `timeController.onTick →
rebuildEnv()` keeps the astro `env` fresh across both continuous advance and
discrete jumps. Observatory therefore passes **no** transition callbacks. The
default `writeTimeState` persists `t`/`off`/`dir` via `app-state` (LocalStorage,
shared with the other apps), so Observatory shares the time as well as the
location — and shared links round-trip both.

### Render loop idling

`tick()` re-requests `requestAnimationFrame` only while the loop is doing useful
work: `!timeController.isStopped || updater.anyAnimating()`. When the clock is
**stopped and all animations have settled**, the loop goes fully idle (no wasted
rendering on a frozen dial). In-flight animations are *not* snapped on stop — they
finish naturally (e.g. a sweep hand eases the remaining distance), then the loop
idles.

The loop is restarted via `scheduleFrame()` (a no-op if already running):
- The shared time-controls UI calls `ensureSchedulerRunning()` after every transport
  action (play / step / scrub / now).
- `rebuildEnv()` and the canvas resize handler call it directly, so location /
  timezone / `noonOnTop` changes redraw even when stopped.

This mirrors Chronometer's stopped-state behavior — see
[planning/2026-06-03-observatory-stop-and-fps.md](../planning/2026-06-03-observatory-stop-and-fps.md).

### FPS overlay (`?fps`)

The `?fps` URL parameter shows a compact page-level readout
(`<fps>fps <cpuFrame>% <cpu60>% <avg>avg`, e.g. `60fps 4% 4% 9avg`) via the shared
`src/shared/fps-indicator.ts` helper — the same overlay Chronometer uses. It is fed
`recordFrame(!isStopped || updater.anyAnimating(), workMs)` each frame: `fps` is the
vsync-bound rate while animating (`1000/median(Δ)`), `cpuFrame` is CPU's share of
that actual frame (`median(workMs)/median(Δ)`), `cpu60` is CPU's share of a nominal
60 fps frame (`median(workMs)/16.67`, can exceed 100%; the animating values dim when
idle), and `avg` is throughput including idle gaps.

### ObsValue Fields

| Field | Description |
|-------|-------------|
| `name` | Human-readable name for debugging |
| `expr` | Parsed AST (from expression parser) |
| `updateInterval` | Seconds (positive = epoch-aligned, negative = sentinel) |
| `animSpeed` | Catch-up animation speed in rad/s (default 2.0) |
| `naturalSpeed` | Steady-state sweep speed in rad/s (default 0 = snap-to-target) |
| `currentValue` | Current interpolated value (NaN = don't display) |
| `anim` | AnimatingValue state for smooth interpolation |
| `nextUpdateTime` | performance.now() of next scheduled re-evaluation |
| `pendingSweep` | Phase 2 sweep params (target + duration), or null |
| `linear` | If true, value is not an angle — skip fmod wrapping (see [Earth Map](#earth-map-with-terminator)) |
| `evalAhead` | If true, use lag-free eval-ahead updates (evaluate the next boundary, sweep there). Not used by Observatory values today; powers the Inspector |
| `discrete` | If true, evaluate at the current display time and snap (no interpolation) — for step values like event times / integers. Not used by Observatory today; powers the Inspector catalog |

### Update Scheduling

Values use two scheduling mechanisms:

**Epoch-aligned** (positive `updateInterval`):
- Value re-evaluates at fixed wall-clock boundaries
- Example: `updateInterval: 60` → evaluates at :00, :01, :02, etc.

**Sentinel-based** (negative `updateInterval`):
- Value re-evaluates at astronomical events
- Example: `EC_UPDATE_NEXT_SUNSET` → sunrise hand updates when time crosses sunset
- Planet sentinels use encoding: `EC_UPDATE_NEXT_PLANET_RISE(planet)` / `EC_UPDATE_NEXT_PLANET_SET(planet)`
- Two *adaptive* sentinels compute their next event from current geometry rather
  than a rise/set: `EC_UPDATE_NEXT_SSLAT_CHANGE` (binary-search on sun
  declination, for the earth map) and `EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION`
  (closing-rate bound on eclipse separation, for the eclipse simulator — see the
  Eclipse Simulator section)

### Animation Modes

The update pass dispatches to one of three modes:

**1. Snap-to-target** (`naturalSpeed === 0`, most values):
The expression is evaluated at time T and the value animates at `animSpeed`
(default 2.0 rad/s) to A(T). Used for hour/minute hands, sun events,
planet hands, ring stops — anything that just moves to a new position.

**2. Two-phase sweep** (`naturalSpeed > 0`, second hands):
For constant-velocity values that sweep between infrequent updates (e.g.,
second hands updating every 20s). Uses a two-phase algorithm:

- **Phase 1 (catch-up)**: If the hand is more than 0.002 rad from where it
  should be, animate at `animSpeed` (2.0 rad/s) to the point where the hand
  *should be when catch-up finishes* (the correct position advances at
  `naturalSpeed` during catch-up, so `catchUpTime = error / (animSpeed - naturalSpeed)`).
- **Phase 2 (sweep)**: From the catch-up target, sweep at `naturalSpeed` until
  the next update boundary. Phase 2 params are stored in `pendingSweep` and
  picked up by the animate pass when Phase 1 completes.

This handles tab-switch recovery gracefully: the hand catches up at 2 rad/s
then resumes smooth ticking.

**3. Scrub compression** (quantized mode, all values):
During hold-to-scrub, display time jumps by large units per tick. The
compression logic (the Updater's `updateObsValueScrub` branch, modeled on the
legacy watch-face tick loop):
- Compute ticks until next update boundary: `ceil(displayDelta / displayDeltaPerTick)`
- Real-time budget: `ticksUntilUpdate × TICK_INTERVAL_MS`
- If natural animation duration exceeds the budget, compress to fit

### Value Catalog

| Group | Values | Update | naturalSpeed |
|-------|--------|--------|--------------|
| Clock hands | h24, h12, minute, second | 1–20s | second: 2π/60 |
| Sun events | sunrise, sunset, golden×2, civil×2, nautical×2, astro×2, noon, midnight | Sentinel (rise↔set) | 0 |
| UTC subdial | hour, minute, second | 1–60s | second: 2π/60 |
| Solar subdial | hour, minute, second | 1–60s | second: 2π/60 |
| Sidereal subdial | hour, minute, second | 1–60s | second: 2π/60 |
| Planet hands | saturn, jupiter, mars, earth, venus, mercury, moonOffset | 3600s | 0 |
| Planet rings | 6 × (rise, set, transit, riseValid, setValid, aboveHorizon) | Sentinel (rise↔set) | 0 |
| Sun ring | 14 altitude stops + noon + midnight | Sentinel (rise↔set) | 0 |
| Earth map | earthSslat (linear), earthSslng | Sentinel / 60s | 0 |
| Moon | moonPhase, moonRotation, moonDistAU (linear) | 60s / 60s / 3600s | 0 |
| Dials | dialAlt (linear), dialAz, eotAngle | 60s / 60s / 3600s | 0 |
| Eclipse | eclSeparation/eclShadowSize/eclSunDist/eclMoonDist (linear), eclKind (discrete), eclSunAlt/eclMoonAlt (linear), eclSunAz/eclMoonAz/eclMoonRelAngle, eclRingSunRA/eclRingMoonRA/eclRingNodeRA | `EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION` | 0 |

### Planet Ring Validity Flags

Planet rings use explicit validity flags rather than `NaN` or `isFinite()` checks.
When a planet doesn't rise or set (polar regions), `dayNightLeafAngle` returns
the transit angle as a fallback — a finite value that would draw a phantom ring
if not gated. Each ring therefore carries three metadata ObsValues:

| ObsValue | Expression | Meaning |
|----------|------------|---------|
| `riseValid` | `dayNightLeafAngleIsRiseSet(pn, 0)` | 1 if planet actually rises, 0 if angle is a transit fallback |
| `setValid` | `dayNightLeafAngleIsRiseSet(pn, 1)` | 1 if planet actually sets, 0 if angle is a transit fallback |
| `aboveHorizon` | `dayNightLeafAngleAboveHorizon(pn, 0)` | 1 if planet is always above horizon (polar summer), 0 if always below |

The ring renderer uses these flags to decide:
- **Both valid**: draw the arc from rise to set (normal case)
- **Invalid + aboveHorizon**: draw a full-circle ring (planet never sets)
- **Invalid + !aboveHorizon**: draw only the planet label (planet never rises)

These values come from the iOS `isRiseSet` and `aboveHorizon` output parameters
of `dayNightLeafAngleForPlanetNumber`, propagated through a compute-once cache
in `astro-env.ts`. See [Astronomy — Planet Rise/Set Cache](astronomy.md#planet-riseset-cache).

### NaN Convention (Sun Ring and Hands)

`NaN` means "don't display this element." Sun event hands (e.g., sunrise in
polar regions) and sun ring altitude stops use NaN to suppress rendering.
Draw functions check `isNaN(value)` before drawing.

Sun ring altitude stops also use NaN — if the sun never reaches a given
altitude (e.g., -18° during polar summer), that gradient stop is skipped
and the conic gradient interpolates between adjacent valid stops.

## Sun Ring

The outermost ring on the Observatory dial shows a 24-hour sky-color gradient
based on sun altitude. It uses a **conic gradient with fixed colors at animated
positions** — a design that naturally supports smooth animation during
noonOnTop toggles, DST transitions, and location changes.

### Architecture

Instead of computing sun altitude at 200-400 points per frame (the old approach),
the sun ring defines a small set of **color stops** at specific altitude
thresholds. Each stop has:

- A **fixed color** from the gradient table (e.g., red at sunrise, dark blue at
  nautical twilight)
- An **animated angular position** (an ObsValue tracking where on the 24h dial
  the sun crosses that altitude)

The conic gradient API (`createConicGradient`) interpolates smoothly between
stops, producing the continuous color ring with a single draw call.

### Color Stops

| Index | Position | Color | Description |
|-------|----------|-------|-------------|
| 0, 13 | -18° altitude | Dark gray `(32,32,32)` | Astronomical twilight boundary (full night) |
| 1, 12 | -9° altitude | Dark blue `(0,0,100)` | Deep twilight |
| 2, 11 | sunrise/set − ε | Light cyan `(43,196,214)` | Night side of sunrise/sunset hand |
| 3, 10 | sunrise/set + ε | Red `(214,0,0)` | Day side of sunrise/sunset hand |
| 4, 9 | +1° altitude | Orange `(240,107,0)` | Just above horizon |
| 5, 8 | +9° altitude | Yellow `(255,255,0)` | Golden hour |
| 6, 7 | +30° altitude | Pale blue-white `(230,230,255)` | Full daylight |
| 14 | solar noon | *computed* | Color from altitude at solar noon |
| 15 | solar midnight | *computed* | Color from altitude at solar midnight |

Indices 0–6 are the morning side (night→day), 7–13 are the evening side
(day→night). Each morning/evening pair at the same position has the same
fixed color.

### Sunrise/Sunset Boundary

Stops 2/3 (morning) and 10/11 (evening) create an **abrupt color transition**
at the sunrise/sunset hand. Instead of computing positions from separate
altitude kinds, they use the actual sunrise/sunset angle ± ε radians, where
ε = 0.001 rad ≈ 0.23 time-minutes (≈ 14 time-seconds):

```
ring1BelowMorn:    sunSpecialAngle(SunRiseMorning) + pi * noonOnTop - ε
ringHalfBelowMorn: sunSpecialAngle(SunRiseMorning) + pi * noonOnTop + ε
```

This ensures the cyan→red boundary aligns closely with the sunrise/sunset
hand, producing a visible color marker. The constant `SUNSET_EPSILON` in
`obs-values.ts` controls this gap width.

### Noon/Midnight Anchors

The noon and midnight anchors always exist (their positions never become NaN).
Their colors are **computed at render time** from the actual sun altitude at
solar noon/midnight, with alpha forced to 1 (the original iOS gradient table
used alpha=0 for deep night, but the conic gradient ring is always opaque).

This is critical for polar regions:

- **Polar summer**: The midnight sun might be at +5° altitude → midnight anchor
  gets orange-yellow. The -18° and -9° stops are NaN (skipped), so the gradient
  smoothly transitions through the computed color at midnight.
- **Polar winter**: The noon sun might be at -15° altitude → noon anchor gets
  deep blue. The +30° and +9° stops are NaN (skipped).

### Conic Gradient Wrap

Canvas conic gradients clamp at the 0/1 offset boundary rather than wrapping.
Since the first and last stops straddle this boundary (both in the deep-night
region), the renderer computes an **interpolated boundary color** at offset
0.0 and 1.0 to create a seamless join:

```
gapSize = (1 - lastOffset) + firstOffset
frac = (1 - lastOffset) / gapSize
boundaryColor = lerp(lastStop.color, firstStop.color, frac)
```

### Update Schedule

All stops use sentinel-based scheduling, matching the existing twilight hands:

| Stops | Sentinel | Rationale |
|-------|----------|-----------|
| Morning (indices 0–6) | `EC_UPDATE_NEXT_SUNSET` | Morning values change when today's sunset passes |
| Evening (indices 7–13) | `EC_UPDATE_NEXT_SUNRISE` | Evening values change when today's sunrise passes |
| Noon, Midnight | `EC_UPDATE_NEXT_SUNRISE_OR_SUNSET` | Anchor colors change at either event |

### Performance

- **Per frame**: 1 conic gradient draw call (16 color stops, hardware-accelerated)
- **Per sentinel event**: 7 expression evaluations + 2 altitude computations
  (noon/midnight anchors) — runs once per sunrise/sunset
- **Old approach**: 200-400+ `cachelessPlanetAlt` calls per frame = eliminated

## Earth Map with Terminator

The earth map shows a Mercator-projection Blue Marble image with a day/night
terminator overlay. It displays the current month's day image, a static night
image (city lights), and a computed twilight mask.

### iOS/Android Reference

| Repo | Key files |
|------|-----------|
| `.esastro-ref/` | `src/ESSunAltitudeTable.cpp` — altitude table generation and interpolation |
| `.esgl-ref/` | `src/ESGLPartEarthMapNightMask.mm`, `src/ESGLPartMoverEarthMapDayImage.mm` — OpenGL rendering |

### Architecture

```
initEarthView()
 ├── loadAltitudeTable()    — decode altitude-table.bin (data URL → Int16 → Float32)
 └── load 12 monthly day images + 1 night image

drawEarthView()  [called per frame]
 ├── Select month image from getNow().getMonth()
 ├── regenerateNightMask()  — only when sslat changes
 │   └── For each pixel: interpolateRowData() → alpha from altitude bands
 └── Composite: night → (day − shifted mask) → observer dot
```

### Altitude Table

The altitude table is a precomputed 3D lookup indexed by:

| Dimension | Steps | Range | Description |
|-----------|-------|-------|-------------|
| Sub-solar latitude | 101 (0–100) | 0° to 24° | Only positive; negative sslat flips the latitude index |
| Map latitude | 150 (0–149) | −90° to +90° | Geographic latitude |
| Altitude offset | 23 (0–22) | 0° to −9° | Sun altitude thresholds (horizon → deep twilight) |

Each entry stores the **longitude offset from the sub-solar meridian** (in
radians) at which the sun reaches that altitude. Values are stored as **Int16
fixed-point** (`value × 32767 / π`) in `src/observatory/data/altitude-table.bin`
(681 KB), generated by `scripts/generate-altitude-table.ts`.

The table was verified against the iOS reference file
`SunAltitudeData-ss101-lat150-alt23-9.dat` — all differences are strictly within
Int16 quantization bounds (see `scripts/compare-altitude-tables.ts`).

### Latitude Flip Logic

The table only stores positive sub-solar latitudes (0° to 24°). For negative
sslat (September–March), the `interpolateRowData()` function:
1. Negates sslat to make it positive
2. Flips the latitude index: `latIdx = LAT_STEPS - mapLatitudeIndex`

This mirrors the iOS `getInterpolatedSSLatIndex()` / `interpolateRowData()`
logic exactly.

### Night Mask Generation

`regenerateNightMask()` creates an OffscreenCanvas where each pixel's alpha
represents night opacity (0 = day, 255 = full night, intermediate = twilight).
The mask is **centered at the sub-solar meridian** and shifted horizontally by
`sslng` during the draw pass.

**Boundary comparisons use strict `<`** (not `<=`). This prevents a 1-pixel
artifact at the sub-solar longitude for polar-night latitudes, where `row[0] = 0`
and `absOffset = 0` would incorrectly match `0 <= 0` → DAY.

### Mask Shift and Wrapping

The mask is drawn twice on the compositing canvas with `destination-out` to
remove day pixels where it's night:

```
dx = round(sslng / 2π × physW)          // integer shift, avoids sub-pixel seam
dx = ((dx % physW) + physW) % physW      // normalize to [0, physW) for overshoot
drawImage(mask, dx, 0)                   // main copy
drawImage(mask, dx - physW, 0)           // wrapped copy (fills left gap)
```

**Three wrapping pitfalls** were discovered during development:
1. **Sub-pixel anti-aliasing**: Fractional `dx` creates semi-transparent edges
   at the seam → fix: round to integer
2. **Animation overshoot**: Angular animation can produce `sslng > 2π` during
   wrap-around, making `dx > physW` → fix: modular normalization
3. **Polar-night center pixel**: `absOffset = 0` matching `row[0] = 0` with `<=`
   → fix: strict `<` comparison

### Linear vs Angular ObsValues

The earth view uses two ObsValues with different animation semantics:

| Value | Expression | `linear` | Why |
|-------|-----------|----------|-----|
| `earthSslat` | `subSolarLatitude()` | `true` | Sun declination is in [−0.41, +0.41] rad — must not be fmod'd to [0, 2π) |
| `earthSslng` | `subSolarLongitude()` | `false` | Longitude wraps at ±π (dateline) — angular animation handles this correctly |

The `linear` flag on ObsValue controls whether `startAnimationRaw()` applies
`fmod` normalization and angular unwrapping. Without it, a declination of
−0.41 rad (December) would become 5.88 rad (336.89°), which the altitude table
interprets as maximum summer.

### Blue Marble Assets

Day images (12 months) and night image are stored in
`src/shared/assets/blue-marble/` — shared between the earth view and the
location panel's mini-map globe (`src/shared/mini-map.ts`).

### Update Scheduling

| Value | Update | Rationale |
|-------|--------|-----------|
| `earthSslat` | Sentinel: `EC_UPDATE_NEXT_SSLAT_CHANGE` | Binary-search for when declination changes by ≥0.1° (slow near solstices, fast near equinoxes) |
| `earthSslng` | 60 seconds | Longitude changes ~1°/4min; 60s is sufficient |

The sslat sentinel (`nextSslatChange` in `animation.ts`) binary-searches within
a ±2 day window to find when the declination changes by more than 0.1° from
its current value. This avoids unnecessary mask regeneration during slow
solstice periods while staying responsive during fast equinox transitions.

## Moon Phase Display

The header shows a large photographic moon (`moon-view.ts`, port of
`EOMoonView.mm`): a full-moon image scaled to the Moon's current apparent size,
overlaid with a dark terminator tracing the phase, and rotated to its sky
orientation.

### Architecture

```
initMoonView()                — load moon300.png

drawMoonView()  [called per frame]
 ├── pixelRadius from moonDistAU (apparent angular size)
 ├── translate to (moonCX, moonCY); rotate by moonRotation
 ├── drawImage(moon, centered, 2·pixelRadius square)
 └── drawTerminator(pixelRadius, moonPhase)
```

### Animated Values

| Value | Expression | `linear` | Update | Role |
|-------|-----------|----------|--------|------|
| `moonPhase` | `moonAgeAngle()` | false | 60s | Terminator shape: 0 = new, π/2 = first quarter, π = full |
| `moonRotation` | `moonRelativeAngle()` | false | 60s | Rotates image + terminator to the sky position angle (iOS `EOChandra` view rotation) |
| `moonDistAU` | `distanceFromEarthOfPlanet(1)` | true | 3600s | Geocentric distance (AU); drives apparent size. Linear — it's a distance, not an angle |

The existing `moonOffset` value (`-moonAgeAngle()+pi`) is unrelated — it drives
the small moon **hand** on the Earth orbit (Phase 2), not this display.

### Apparent Size

The image radius scales with the Moon's true angular size, which grows at
perigee and shrinks at apogee (port of `EOMoonView.mm:82-89`):

```
angularRadiusAtPerigee = atan(lunarRadius / perigeeDistance)   // constant
angularRadiusNow       = atan(lunarRadius / (distAU · auKm))
pixelRadius            = L.moonR · angularRadiusNow / angularRadiusAtPerigee
```

`L.moonR` (= `75·s`, the iOS `ChandraR`) is the radius **at perigee** — i.e. the
maximum. Constants: `perigeeDistance = 355000 km`, `lunarRadius = 1737.10 km`,
`auKm = 149600000 km`.

### Terminator and Earthlight

`drawTerminator()` (port of `drawMoonPhaseAt:`) builds a closed path — a
half-circle along one limb plus a cosine-scaled ellipse for the terminator —
filled with near-black `rgba(20,20,23,α)`. The alpha
`α = 0.75 + |sin(pa)|/3` is below 1 near new moon, letting a little of the moon
image show through to simulate **earthlight**; it reaches full opacity at the
quarters.

### Coordinate Note (Y-up → Y-down)

iOS draws `EOMoonView` in a Y-up CTM (paired `scale(1,-1)` around the image);
Canvas 2D is Y-down. Porting the phase math literally drew the unlit limb arc
around the *wrong* side, so the terminator lune **added** to a half-disk instead
of subtracting from it — a near-full moon came out more than half dark. The fix
is to invert the `anticlockwise` flag on the limb arc (pass `sin(pa) < 0`, the
opposite of the literal CG port). With that flip the dark fraction matches the
expected `(1 + cos pa)/2` across all phases, verified against Selene: at
elongation ≈ 242° the moon shows the correct thin waning-gibbous crescent, and
the apparent diameter tracks the geocentric-distance readout.

### Asset

`moon300.png` lives in `src/shared/assets/` (copied from the reference repo,
which is never a build input) and is bundled as a data URL by esbuild.

## Peripheral Dials

The three corner dials — **Altitude**, **Azimuth**, **Equation of Time** —
live in `peripheral-dials.ts` (static backgrounds) and `peripheral-hands.ts`
(hands + labels). The eclipse-simulator slot (`eclipseCX/CY/R1/R2`) is
intentionally empty, deferred to its own future plan.

### Architecture

```
getPeripheralDialsCache(L)   — full-viewport OffscreenCanvas @ DPR, like main-dial
 ├── drawAltitudeDial   (port EOShuffleView.mm EOAltitudeDialShuffleView)
 ├── drawAzimuthDial    (port EOShuffleView.mm EOAzimuthDialShuffleView)
 └── drawEOTDial        (asymmetric real-range design, see below)
invalidatePeripheralDialsCache()  — called on resize

drawPeripheralHands(ctx, L, u, selectedPlanet)  [per frame]
 ├── altitude triangle hand  ({body}Alt)  + body name label
 ├── azimuth triangle hand   ({body}Az)   + body name label
 └── EOT triangle hand       (eotAngle)
```

### Hand angles (port of EOHandView.mm)

| Hand | Angle | Notes |
|------|-------|-------|
| Azimuth | `azimuthOfPlanet(p)` | 0 = North at top, CW |
| Altitude | `altitudeOfPlanet(p) − π/2` | left half-gauge; zenith up, horizon at 9 o'clock |
| EOT | `24 · EOTAngle()` | 0 at top, + to the right (π/30 per minute) |

### Planet selection (and its animation)

The alt/az dials share one selected body (`ECPlanetNumber`), skipping Earth.
Matching iOS (`EOClock.mm:739-762`), the two dials cycle in **opposite
directions** (via `cycleSelectablePlanet(current, dir)`): clicking the
**altitude** dial advances (Sun→Moon→…→Saturn→Sun) and clicking the **azimuth**
dial reverses (Sun→Saturn→…→Moon→Sun) — so you "go back" by clicking the other
dial. The choice persists as the `op` setting via `app-state` (observatory
namespace; 0 = Sun is the default and is omitted).

The hands track **one** value per axis — `dialAlt` / `dialAz` — whose expression
reads the selected body from the `dialPlanet` **env variable** (set alongside
`noonOnTop` in `init()` and `rebuildEnv()`), e.g. `altitudeOfPlanet(dialPlanet)`.
On a click the entry point updates `dialPlanet` and calls `updater.reset()`, so
the two values re-evaluate and **animate** to the new body — the same sweep used
when the location changes. (A per-body value scheme would instead *snap*, because
switching bodies would swap which value is read rather than move a target.)
`dialAz` is angular, so the animator takes the shortest-path wrap (e.g. a
Sun→Saturn switch crossing North).

### Asymmetric EOT dial

Unlike the symmetric ±15-minute iOS dial, the Observatory EOT dial adopts the
real-range design from the Mauna Kea / Vienna faces (`renderer.ts drawEotDial`),
rendered in the Observatory subdial style:

- Scale `radPerMin = π/30` (15 min = 90°), `0` at top, `+` right / `−` left.
- Real extremes `EOT_MAX_MIN = 16.5`, `EOT_MIN_MIN = -14.2` minutes.
- The solid band spans −14.2…+16.5. The unused **−14.2…−15** sliver (its arc,
  the −15 tick, the −15 number, and the "−" symbol) is drawn at reduced alpha
  (0.35), so the **left edge still reaches 9 o'clock** while the **right side
  runs longer** to +16.5 — honestly reflecting that positive EOT exceeds +15
  while negative EOT never reaches −15.
- Ticks every minute (major at 0/±5/±10/±15), numbers `0/5/10/15`, bold `+`/`−`
  symbols, "Equation of Time" title, center hub + vertical baseline.

## Noon-on-Top Toggle

A small **half-disc icon** (`#noon-icon`) sits centered in the bottom chrome
row, sharing it with the time-bar button (left) and the location controls
(right). Tapping it raises the Vienna-style pill control ("Midnight on top" /
"Noon on top") as an **on-demand overlay** above the footer — which may overlap
the dial (rare), so the pill costs the static layout nothing (iteration 3, §6
C2). In A5 (iPhone landscape) the big dial overlaps the footer centre, so the
icon shifts left toward the time-controller button (`positionNoonIcon()`). The
pill markup/CSS mirrors Chronometer's Vienna toggle (`face-template.html`); the
wiring lives in `setupNoonToggle()` in `observatory-entry.ts`. The choice
persists as the `onoon` setting via `app-state` (observatory namespace;
midnight-on-top is the default and is omitted).

> The earlier always-visible pill that *wrapped* onto a second row when it
> didn't fit (reserving a two-row footer band) was retired by iteration 3 — the
> footer is now a single row at every anchor.

Toggling sets the `noonOnTop` env variable (0/1) and calls `updater.reset()`:
every expression carrying a `+ pi * noonOnTop` term (24h hand, sun-event hands,
planet rings, sun-ring gradient stops) re-evaluates against its moved target, so
all moving parts **animate** half a turn to the flipped positions — the same
sweep as a location change. The main-dial static cache keys on `noonOnTop`
(`getMainDialCache(L, noonOnTop)`), so the dial numerals rebuild (snap) on the
next frame.

**Footer wrap:** when the centered toggle would collide with the time-bar
contents or the location controls (narrow windows, or when the red offset label
+ Now button appear), `updateNoonToggleWrap()` adds the `wrapped` CSS class —
lifting the toggle onto a second row above the footer — and `chromeParams()`
reserves `2 × FOOTER_H` so the canvas layout keeps the dial clear of it. The
check runs on every canvas resize, and a `ResizeObserver` on the footer
neighbors (offset label, Now button, location controls) re-solves the layout
when their sizes change at runtime.

## Help Popover

The "ℹ" button (in the header band, top right) opens the same info popover the Chronometer face
pages use: header + links (GitHub / Credits / Privacy / Support / Disclaimer),
the local-storage/sharing note, a lazy-loaded "General Help Topics" iframe, the
app-specific help body, and the version number — with the sliding sub-view
and animated popup height for the Privacy/Support/Disclaimer pages.

- **Shared wiring**: `src/shared/help-popover.ts` (`initHelpPopover`), used by
  both `engine-entry.ts` (which passes the face thumbnail/reorder pass as
  `onFirstOpen`) and `observatory-entry.ts`. The markup and CSS live in each
  page template (`face-template.html`, `observatory.html`); `index.html` keeps
  its own inline-script copy.
- **Help content**: `src/help/observatory.html` (images under
  `src/help/images/observatory/`), adapted from the original
  [emeraldsequoia.com/eo](https://emeraldsequoia.com/eo/index.html) help and
  the iOS app's help strings. Injected as `{{HELP_CONTENT}}` by `build.sh`.
- **General Help Topics**: the iframe loads `help.html?embed=1&app=observatory`;
  the `app=observatory` param makes `help.html` drop the Chronometer-only
  "Complications" and "The Physics of Emerald Chronometer" sections, swap
  "Emerald Chronometer" → "Emerald Observatory" in the remaining text, and
  resolve per-app passages: elements tagged `class="chrono-only"` /
  `class="obs-only"` are removed in the flavor where they don't apply (e.g.
  Basel's eclipse needle vs. Observatory's Eclipse Simulator animation).

## Date Display

`date-view.ts` renders the header date stack (port of the EOClock date labels,
`EOClock.mm:525-570`): weekday, month + day, year, a "leap"/"not leap" indicator
(Gregorian %4/%100/%400 rule), and the timezone abbreviation. All fields use
`Intl.DateTimeFormat` in the **location's** timezone (not the browser's), so the
display follows the selected location and the scrubbed time. Placement and mode
(`stack`/`row`/`split`) are set per aspect anchor by the adaptive layout (see
[Adaptive Layout](#adaptive-layout-aspect-anchors)); `extractDateFields` is
exported so the layout can measure exactly the strings the view renders.

## Eclipse Simulator

`eclipse-view.ts` (port of `EOEclipseView.mm`, plus the ring hands from
`EOHandView.mm:382-450`) fills the upper-right peripheral slot
(`eclipseCX/CY`, inner radius `eclipseR1`, outer `eclipseR2`). The static ring
annulus is drawn by `peripheral-dials.ts` (`drawEclipseDial`); the disc contents
and the five ring markers are drawn each frame.

### What it shows

A small "telescope view" of the current geometry, only when Sun and Moon (or
Earth-shadow and Moon) are within **10°** (`π/18`); otherwise an "Eclipse
Simulator" caption:

- **Solar side** (near new moon, `eclipseKindIsMoreSolarThanLunar`): the Sun
  disc (`sunEclipse.png`) with the Moon silhouette over it, or the totality
  image (`totalEclipse.png`) for a total solar eclipse.
- **Lunar side** (near full moon): the Moon (`moon300.png`, rotated by its sky
  orientation) with Earth's umbral shadow (`earthShadow.png`, *multiply* blend,
  clipped to the Moon) drawn over it, plus the shadow outline.

A translucent green overlay (`rgba(0,76,0,0.5)`) marks any below-horizon portion;
when the event is mostly below the horizon a "Below horizon" label replaces the
caption. Around the disc, five image markers ride the ring at RA-derived clock
angles: Sun, Moon, Earth-shadow (anti-solar), and the ascending/descending lunar
nodes. When the Sun and Moon markers coincide near a node, an eclipse is
imminent.

### Animation-friendly via shared-sentinel obs-values

The disc is driven **entirely by obs-values** — one scalar per quantity (no
monolithic snapshot) — so it inherits the standard animate/scrub machinery.
Geometric consistency is guaranteed by every component sharing **one** update
sentinel, `EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION`: all 13 values re-evaluate
on the same tick, so the derived pixel geometry stays coherent between samples.
`eclKind` is `discrete` (snaps; it's an enum read via `Math.round`); the rest are
`linear` where they must not wrap (separation, sizes, distances, altitudes) and
angular where they do (azimuths, RA markers, moon orientation).

The 13 values: `eclSeparation`, `eclShadowSize`, `eclKind`, `eclSunAlt`,
`eclSunAz`, `eclMoonAlt`, `eclMoonAz`, `eclSunDist`, `eclMoonDist`,
`eclMoonRelAngle` (disc), plus `eclRingSunRA`, `eclRingMoonRA`, `eclRingNodeRA`
(ring markers — the node marker reuses the existing `lunarAscendingNodeRA` expr).
The four physical disc quantities come from new thin expr wrappers over
`calculateEclipse`: `eclipseAngularSeparation`, `eclipseShadowAngularSize`,
`eclipseKindRaw` (the existing `eclipseSeparation`/`eclipseKind` return the
*abstract*/collapsed values the Basel wheel uses, not what the disc needs).

### The eclipse sentinel

`EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION` (`-1019`, resolver
`nextInterestingEclipseMotion` in `animation.ts`) gives a fast cadence while the
disc is drawn and a lazy one while only the caption shows:

- **Graphical mode** (`separation < 10°`): ~**1 s** between updates, for smooth
  animation while scrubbing.
- **Caption mode** (`separation ≥ 10°`): the *soonest* the separation could reach
  the threshold given a conservative upper bound on the closing rate
  (`MAX_CLOSING_RATE = 1°/h`; Moon ≈0.55°/h + Sun ≈0.04°/h), **capped at 1 hour**.

Implemented as a closing-rate bound — `clamp((sep − 10°) / maxRate, 1 s, 1 h)` —
rather than a binary search: eclipse separation is non-monotonic over a synodic
month (unlike sun declination, which `nextSslatChange` can bisect), so the
conservative rate bound is the robust analog. It never skips the crossing
(checking early is fine) and never waits more than an hour. The resolver honors
`timeDirection`, so reverse scrubbing works too.

### Pixel scale (port of EOEclipseView.mm:70-100)

`moonRadiusAtPerigee = 20 px × (eclipseR1 / 49)` (iOS reference `eclipseR1 ≈ 49`),
`ppar = moonRadiusAtPerigee / atan(lunarRadius/perigeeDistance)` (pixels per
angular radian), and each body's pixel radius is `ppar · atan(bodyRadius / dist)`.
The totality image is drawn at `moonPixelRadius / (68/316)` and the umbra image at
`ppar·shadowRadius / (118/120)` (the image feature fractions from
`EOClock.mm:2160-2161`).

### Coordinate note (Y-up → Y-down)

`EOEclipseView` is a plain (Y-down) `UIView`, so the iOS pixel formulas — which
already carry their "change in sign from view coordinate system" adjustments —
port literally into the Y-down canvas (unlike the main dial, which uses a flipped
Y-up CTM). The ring markers replicate the iOS layer transform
(`rotate(firstAngle) → translate(0, radius) → rotate(glyph)`) as
`rotate(−firstAngle) → translate(0, −radius) → rotate(−glyph)`, placing each
marker at `firstAngle` CCW from the top — the same screen position as iOS.

## Drag-to-Explore (Earth Map)

The earth map supports interactive location exploration via pointer events.
The user can click and drag on the map to temporarily switch the Observatory
display to any location, with all dials, rings, and hands animating in real time.

### State machine

```
idle → dragging → confirming → idle
```

- **idle**: normal rendering; pointer-move over the earth map shows a `crosshair`
  cursor as a hint.
- **dragging**: active drag in progress. `pointerdown` inside the earth map
  rectangle (hit-tested via `isInsideEarthMap()`) saves the current
  `lat`/`lon`/`tz`/`city`, then on every `pointermove` inside the map:
  1. Convert CSS-pixel position to lat/lon via `earthPixelToLatLon()` (inverse
     Mercator, clamped to [-90,90] / [-180,180]).
  2. Apply shift-key axis lock: if Shift is held, constrain to whichever of
     latitude or longitude has the larger absolute delta from the saved position.
     Re-evaluated per move (no sticky axis).
  3. Call `applyTemporaryLocation(lat, lon)` → `resolveTimezone()` → `rebuildEnv()`
     → `updater.reset()` → `scheduleFrame()`. No `setState()` (no persistence).
  4. The observer dot stays at the saved (home) location (via `dotOverrideLat`/
     `dotOverrideLon` on `drawEarthView`). A 1px red crosshair at 50% opacity
     (`drawDragCrosshair`) marks the rendered (temporary) location.
- **confirming**: pointer released. A compact "Keep this location?" overlay
  appears near the map. Enter or clicking Keep persists; Escape or clicking
  Revert restores the saved location.

### Coordinate conversion

The earth map uses equirectangular (plate carrée) projection:

```
Forward:  dotX = ex + (lon + 180) / 360 × earthW
          dotY = ey + (90 - lat) / 180 × earthH

Inverse:  lon = (cssX - ex) / earthW × 360 - 180
          lat = 90 - (cssY - ey) / earthH × 180
```

Both directions are implemented in `earth-view.ts`.

### Pointer capture

`canvas.setPointerCapture(ev.pointerId)` is called on `pointerdown` so that
`pointermove` and `pointerup` events continue to fire on the canvas even if the
pointer leaves it. This ensures the drag isn't silently dropped. Moves outside
the earth map rect are ignored (the location stays at the last in-map position).

### Performance

`resolveTimezone()` calls `findClosestCity()` which scans ~167K cities. This
runs on every `pointermove` during drag (no throttling) to keep the displayed
timezone fully in sync with lat/lon. Empirical testing shows this adds < 5 ms
per event. If performance becomes an issue, throttling to every N ms is a
straightforward follow-up.
