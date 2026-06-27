# Inspector

Developer documentation for the Inspector — a live astronomy data explorer and
expression debugger. The Inspector is a standalone app (separate from Chronometer
and Observatory) that provides a real-time view of all expression function
values, useful for debugging watch face expressions and verifying astronomy
calculations.

## Purpose

The Inspector serves two roles:

1. **Debugging tool**: Type any expression from a watch face XML or Observatory
   ObsValue and see its live value — as a number, angle (degrees), and date
   (interpreting the value as a dateInterval). The expression is fully
   re-evaluated 10×/s and **smoothly animated between updates** via the shared
   `ObsValue` system (see [Expression Evaluator](#expression-evaluator)).

2. **Reference**: The Reference panel lists all curated expression functions
   with descriptions and signatures, grouped by category. Clicking an entry
   inserts it into the expression input.

## Source Layout

```
src/inspector/
├── inspector-entry.ts    Main app: time display, expression evaluator, autocomplete, reference, catalog
├── inspector.html        HTML template with all UI elements
├── catalog.ts            Declarative ephemeris catalog (groups → rows → cells)
└── expr-metadata.ts      Curated function/constant metadata for autocomplete and reference
```

## Architecture

The Inspector imports only from `src/shared/`, `src/expr/`, and `src/astronomy/`.
It does **not** import from `src/watch/` — this keeps its bundle
(`inspector-engine.js`) free of Chronometer-specific code (renderer, XML parser,
Terra slots, etc.).

```
inspector-entry.ts
  ├── createAstroEnvironment()    ← src/shared/astro-env.ts
  ├── parse() / evaluate()        ← src/expr/
  ├── EXPR_METADATA               ← ./expr-metadata.ts
  └── planetaryRiseSetTimeRefined ← src/astronomy/ (for sunrise/sunset display)
```

The astronomy environment is created with the user's location and timezone,
identical to how Observatory and Chronometer create theirs. All ~160 expression
functions registered by `createAstroEnvironment()` are available for evaluation.

## Main Features

### Time Display

The top section shows the current time (to the millisecond — the subsecond
portion is dimmed), date, and timezone in the configured location. The displayed
time is the **time controller's** display time, so it reflects scrubbing /
offset / stopped state (not just `new Date()`).

### Time Controller

The Inspector uses the shared `TimeController` + `initTimeControls` transport bar
(`{{TIME_CONTROLLER}}` / `{{TIME_CSS}}` partials, pinned under the time display),
exactly like Chronometer and Observatory: play / pause, reverse, hold-to-scrub at
various rates, single-step, offset, and "Now". Time state round-trips through the
URL (`t` / `off` / `dir`), so a Chronometer view can deep-link to the Inspector at
the same instant and location.

Under the hood the catalog's values are owned by a shared **`Updater`** driven by
a **`TimingContext`** (built each frame from the controller). The Inspector hands
that `Updater` to `initTimeControls`, so the shared UI re-arms the catalog schedules
on every transition automatically; the Inspector's only transport callback rebuilds
the **expression box** (which lives outside the updater for error isolation) so it
re-evaluates against the new display time. An **idle scheduler** parks the render
loop when the clock is stopped and everything has settled, and restarts it on any
transport action or edit. Continuous catalog values track the scrubbed time via
mode-aware eval-ahead (lag-free at each tick); discrete values snap. See
[Animation — Eval-ahead](animation.md#eval-ahead-lag-free-tracking).

### Expression Evaluator

The expression input accepts any valid expression (same syntax as watch XML
attributes). The result is displayed three ways simultaneously:

| Format | Description | Semantics |
|--------|-------------|-----------|
| Number | Raw numeric value (integer or 10-digit precision) | linear |
| Angle | Value converted to degrees (× 180/π), wrapped to [0,360°) | angular |
| Date | Value interpreted as a dateInterval (seconds since 2001-01-01T00:00:00Z) | linear |

#### ObsValue-driven, eval-ahead

The result is driven by the shared **`ObsValue`** system
([src/shared/obs-value.ts](../src/shared/obs-value.ts) +
[src/shared/updater.ts](../src/shared/updater.ts)) rather than a bare per-frame
`evaluate()`. The expression text is parsed once (re-parsed only on change) into
**two** ObsValues sharing the AST:

- an **angle**-semantics value (`linear:false` — shortest-path wrap) feeding the
  Angle° readout, and
- a **linear**-semantics value (`linear:true` — straight-line) feeding the Number
  and Date readouts.

Both use **eval-ahead** (`evalAhead:true`, `updateInterval` 0.1 s): each 0.1 s
boundary the expression is evaluated *one interval into the future* and the value
sweeps there, arriving exactly as that boundary occurs. The readouts therefore
update only 10×/s but **animate smoothly at the full frame rate with no
perceptible lag** vs. wall-clock time. Changing the expression text or the
location **snaps** (rebuilds the ObsValues) rather than animating across
expressions. A per-frame evaluation error is caught and surfaced without
breaking the render loop.

The lag-free future-target idea generalizes Observatory's `naturalSpeed` sweep;
see [Animation — Eval-ahead](animation.md#eval-ahead-lag-free-tracking).

### FPS overlay (`?fps`)

The `?fps` URL parameter shows the same compact page-level readout
(`<fps>fps <cpuFrame>% <cpu60>% <avg>avg`, e.g. `60fps 4% 4% 9avg`) as Chronometer
and Observatory, via the shared
[src/shared/fps-indicator.ts](../src/shared/fps-indicator.ts). It is fed
`recordFrame(!timeController.isStopped || updater.anyAnimating(), workMs)` each
frame, where `workMs` is the frame's CPU time. `fps` is the vsync-bound rate while
animating (`1000/median(Δ)`); `cpuFrame` is CPU's share of that actual frame
(`median(workMs)/median(Δ)`); `cpu60` is CPU's share of a nominal 60 fps frame
(`median(workMs)/16.67`, can exceed 100%). The animating values are dimmed once the
clock is stopped and everything has settled; `avg` is throughput including idle.
Useful for confirming the readouts interpolate at the full frame rate while
expressions are fully re-evaluated only 10×/s.

### Autocomplete

Typing ≥2 characters shows a dropdown of matching functions/constants from the
curated metadata plus any additional entries from the environment. Matches are
ordered prefix-first, then substring. The dropdown supports keyboard navigation
(↑/↓/Enter/Tab/Escape) and mouse clicks.

Functions not in the curated metadata still appear in autocomplete (from the
live environment), but without descriptions — they show as category "Other".

### Reference Panel

The Reference button toggles a categorized list of all expression functions
and constants. Built lazily on first open from `EXPR_METADATA` merged with
the live environment. Categories are collapsible. Clicking an entry inserts
it into the expression input.

### Ephemeris Catalog

Below the expression evaluator, a scrolling **catalog** shows ~130 live
astronomical / time values grouped **Time → Sun → Moon → Planets (Mercury →
Neptune)**. Each value is one shared **`ObsValue`** (eval-ahead, lag-free):
fully re-evaluated on its cadence (seconds 0.1 s, coordinates 1 s,
rise/set/distance 60 s) and smoothly interpolated every frame — the
"evaluate rarely, interpolate often" pattern at ~130 values (see
[planning/2026-06-03-inspector-obsvalue-animation.md](../planning/2026-06-03-inspector-obsvalue-animation.md)
and [planning/2026-06-04-inspector-ephemeris-catalog.md](../planning/2026-06-04-inspector-ephemeris-catalog.md)).

The catalog is **defined declaratively** in
[`catalog.ts`](../src/inspector/catalog.ts) (groups → rows → cells, each cell an
expression + a display **tag** + an update interval). Coordinate rows use a
3-column grid (label + three value columns) so columns line up across rows — the
rightmost value (e.g. `Up?` on the Alt/Az row) aligns under `Transit`; the
Distance cell spans all three columns for its `AU` + `km` reading. Date/Clock
numbers use a compact "fields" row.

Each tag is either **continuous** (eval-ahead, smoothly interpolated) or
**discrete** — a value with no meaningful state between two of its samples
(today's sunrise, an integer hour, a floored TZ offset). Discrete values are
evaluated at the *current* display time and **snapped** (no eval-ahead, no
interpolation), because interpolating them is meaningless and eval-ahead would
cross their change-point early. Discreteness is determined by the tag
(`tagIsDiscrete`) and flows to the `ObsValue.discrete` flag.

| Tag | Kind | `linear` | Display |
|-----|------|----------|---------|
| `A` | continuous | `false` | full-circle angle, `0–360°` |
| `Ldeg` | continuous | `true` | bounded signed angle (declination, altitude, latitude) |
| `Num` | continuous | `true` | fractional number (minute, second — 3 decimals) |
| `DIST` | continuous | `true` | distance as `AU` + `km` (km grouped with a compressed apostrophe) |
| `HMS` | continuous | `true` | clock seconds → `HH:MM:SS.sss` (sidereal, solar time) |
| `MS` | continuous | `true` | small signed seconds → `±MM:SS.sss` (equation of time) |
| `Int` | **discrete** | `true` | integer (year/month/day/hour) |
| `BOOL` | **discrete** | `true` | 0/1 → `yes`/`no` (planet up?) |
| `WD` | **discrete** | `true` | weekday → `0 (Sunday)` |
| `HM` | **discrete** | `true` | signed clock offset → `±HH:MM` (TZ offset) |
| `LT` | **discrete** | `true` | dateInterval → local time, `—` for polar no-event (rise/set/transit) |

Per frame the Inspector runs `updateObsValues` + `animateObsValues` over the
catalog's `ObsValue[]` and writes each changed cell (a per-cell string compare
skips redundant DOM writes). Location changes call `resetObsValueSchedules` so
the catalog re-evaluates against the new environment.

## Expression Metadata (`expr-metadata.ts`)

The curated metadata table drives both autocomplete descriptions and the
reference panel. Each entry has:

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Function/constant name as used in expressions |
| `category` | `string` | Grouping for the reference panel |
| `desc` | `string` | One-line human-readable description |
| `kind` | `'fn' \| 'const'` | Whether to show parens in autocomplete |
| `sig` | `string?` | Parameter signature, e.g. `'(planet, leaf)'` |

`CATEGORY_ORDER` controls the display order of categories in the reference
panel. Categories not in this list appear at the end.

> [!IMPORTANT]
> This table must be updated whenever expression functions are added or changed.
> See [Development Rules §13](development-rules.md#13-keep-inspector-expression-metadata-in-sync).

### Current Categories

| Category | Contents |
|----------|----------|
| Sun Times | Next/prev/today sunrise, sunset, solar noon |
| Moon Times | Next/prev/today moonrise, moonset, moon transit |
| Planet Times | Next/prev/today rise, set, transit for any planet |
| Sun Position | Altitude, azimuth, RA, declination, ecliptic longitude |
| Moon Position | Altitude, azimuth, age angle, relative angle |
| Planet Position | RA/declination, alt/az, ecliptic & heliocentric lon/lat, distance, up |
| Clock | Hour, minute, second, day/month/year, timezone |
| Astronomical | Sidereal time, Julian day, equation of time, precession |
| Day/Night Ring | Rise/set angles, leaf angles, polar detection, transit angles |
| Planet Constants | Sun(0), Moon(1), Mercury(2), ..., Pluto(10) |
| Math Constants | pi, true, false |
| Math | sin, cos, atan2, sqrt, abs, floor, ceil, fmod, etc. |

## Location

The Inspector uses the same location system as Chronometer — shared state
(`lat`, `lon`, `tz`, `city`, `bloc`) via `app-state.ts` (LocalStorage by
default, URL for sharing/fallback) and the shared location dialog
(`src/shared/location-dialog.ts`). Location changes rebuild the astronomy
environment and refresh all displays, and live-sync across tabs via
`onSharedChange`.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/inspector/inspector-entry.ts` | Main app: tick loop, expression evaluator, autocomplete, reference, catalog |
| `src/inspector/inspector.html` | HTML template |
| `src/inspector/catalog.ts` | Declarative ephemeris catalog definition |
| `src/inspector/expr-metadata.ts` | Curated function/constant metadata |
| `src/shared/obs-value.ts` | ObsValue type + `createObsValue` (shared with Observatory) |
| `src/shared/updater.ts` | ObsValue update/animate passes + `makeOverridableGetNow` (eval-ahead) |
| `src/shared/astro-env.ts` | Astronomy environment factory (shared with Chronometer and Observatory) |
| `src/expr/parser.ts` | Expression parser |
| `src/expr/evaluator.ts` | Expression evaluator |

## Related Docs

- [Expressions](expressions.md) — Expression language syntax and pipeline
- [Astronomy](astronomy.md) — Astronomy functions available in the environment
- [Development Rules §13](development-rules.md#13-keep-inspector-expression-metadata-in-sync) — Keep metadata in sync
- [Architecture Overview](architecture-overview.md) — Import boundaries between apps
