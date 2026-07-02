# Inspector

Developer documentation for the Inspector — a live astronomy data explorer. The
Inspector is a standalone app (separate from Chronometer and Observatory) that
provides a real-time view of the shared astronomy engine's values — rise/set
times, planetary positions, calendar and clock values — useful for verifying
astronomy calculations at any time and location.

> The Inspector originally also had a free-form **expression evaluator** (with
> autocomplete and a reference panel). It was removed after the expression
> system migrated to plain JavaScript via `new Function`
> (`planning/2026-06-15-eval-vs-custom-parser.md`) — a "type an expression, see
> its value" box that just runs JS is redundant with devtools, and its metadata
> tables were dead weight in the bundle.

## Source Layout

```
src/inspector/
├── inspector-entry.ts    Main app: time display, time controller, ephemeris catalog
├── inspector.html        HTML template with all UI elements
└── catalog.ts            Declarative ephemeris catalog (groups → rows → cells)
```

## Architecture

The Inspector imports only from `src/shared/`, `src/expr/`, and `src/astronomy/`.
It does **not** import from `src/watch/` — this keeps its bundle
(`inspector-engine.js`) free of Chronometer-specific code (renderer, XML parser,
Terra slots, etc.).

```
inspector-entry.ts
  ├── createAstroEnvironment()    ← src/shared/astro-env.ts
  ├── createObsValue()            ← src/shared/obs-value.ts (compiles catalog expressions)
  └── planetaryRiseSetTimeRefined ← src/astronomy/ (for sunrise/sunset display)
```

The astronomy environment is created with the user's location and timezone,
identical to how Observatory and Chronometer create theirs. The catalog's cells
are expressions evaluated against the ~160 functions registered by
`createAstroEnvironment()`.

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
various rates, single-step, offset, and "Now". Time state (`t` / `off` / `dir`)
persists through the shared app-state layer (the `ec:shared` localStorage
namespace in storage mode, the URL in the fallbacks), so hopping between apps —
or opening a shared deep link — lands at the same instant and location.

### Cross-App Navigation

The fixed top-right row holds Chronometer and Observatory icon links (plus ℹ
help and Share). Their hrefs and the pre-navigation time-state flush are wired
by `initAppNavLinks()` (`src/shared/app-nav.ts`) — clean URLs in storage mode,
so mid-scrub time survives the hop via storage rather than query params. The
`i`/`o`/`c`/`a` hotkeys navigate the same way; `h`/`?` open the help popover,
and `t`/`n`/`l` drive the time controller and location dialog
(`src/shared/hotkeys.ts`; key table in help.html's Keyboard Shortcuts section).

### Help Popover

The ℹ button opens the shared help popover (`src/shared/help-popover.ts`, same
wiring as Observatory): the Inspector's own help content
(`src/help/inspector.html`, injected at build time via `{{HELP_CONTENT}}`) plus
the Privacy/Support/Disclaimer sub-views, the Other Apps section, and the
General Help iframe (`help.html?embed=1&app=inspector` — the inspector flavor
drops the Complications, Physics, and Eclipses topics). The Inspector's help
includes the **precision-vs-accuracy disclaimer**: unlike Chronometer and
Observatory, the Inspector deliberately displays more digits than the astronomy
engine's accuracy supports, so the motion of the trailing digits shows how fast
(and in which direction) each value is changing. help.html's accuracy topic
carries the matching qualification.

Under the hood the catalog's values are owned by a shared **`Updater`** driven by
a **`TimingContext`** (built each frame from the controller). The Inspector hands
that `Updater` to `initTimeControls`, so the shared UI re-arms the catalog schedules
on every transition automatically — the Inspector needs no custom transition
callbacks (like Observatory). An **idle scheduler** parks the render
loop when the clock is stopped and everything has settled, and restarts it on any
transport action. Continuous catalog values track the scrubbed time via
mode-aware eval-ahead (lag-free at each tick); discrete values snap. See
[Animation — Eval-ahead](animation.md#eval-ahead-lag-free-tracking).

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
expressions are fully re-evaluated only on their cadence.

### Ephemeris Catalog

Below the location card, a scrolling **catalog** shows ~130 live
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

Per frame the Inspector runs `updater.tick(...)` over the catalog's ObsValues
and writes each changed cell (a per-cell string compare skips redundant DOM
writes). Location changes call `updater.reset()` so the catalog re-evaluates
against the new environment.

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
| `src/inspector/inspector-entry.ts` | Main app: tick loop, time display, catalog |
| `src/inspector/inspector.html` | HTML template |
| `src/inspector/catalog.ts` | Declarative ephemeris catalog definition |
| `src/help/inspector.html` | Help popover content (incl. the precision-vs-accuracy disclaimer) |
| `src/shared/obs-value.ts` | ObsValue type + `createObsValue` (shared with Observatory) |
| `src/shared/updater.ts` | ObsValue update/animate passes + `makeOverridableGetNow` (eval-ahead) |
| `src/shared/astro-env.ts` | Astronomy environment factory (shared with Chronometer and Observatory) |
| `src/expr/compile.ts` | Expression compiler (`new Function`) + `runInit` |
| `src/expr/env.ts` | Expression environment + `createDefaultEnvironment` |

## Related Docs

- [Expressions](expressions.md) — Expression language syntax and pipeline
- [Astronomy](astronomy.md) — Astronomy functions available in the environment
- [Architecture Overview](architecture-overview.md) — Import boundaries between apps
