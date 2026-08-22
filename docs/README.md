# Chronometer Web — Implementation Docs

Permanent reference documentation for the Chronometer Web codebase, organized by subsystem. These docs are distilled from the [planning archive](../planning/) and kept up to date as the codebase evolves.

> **First-time setup**: If you plan to port new watch faces or trace
> algorithms to the iOS source, run `scripts/clone-refs.sh` to clone the
> reference repositories. See [ios-reference.md](ios-reference.md) for details.

## Table of Contents

### Architecture & Design
- [**Architecture Overview**](architecture-overview.md) — Multi-app monorepo structure, source layout, import discipline, shared environment architecture, Chronometer-specific design decisions

### Core Systems
- [**Rendering**](rendering.md) — Canvas rendering pipeline, static caching, window cutouts, drawing order
- [**Animation**](animation.md) — Two-time-base system, update intervals, scrubbing, adaptive compression
- [**Expressions**](expressions.md) — Expression parser/evaluator pipeline, pre-parsed AST, `evalAttr` API
- [**XML Parsing**](xml-parsing.md) — Watch XML structure, part type taxonomy, asset resolution
- [**XML Syntax Reference**](xml-syntax.md) — Complete element and attribute reference for watch face XML

### Visual Effects
- [**Shadows**](shadows.md) — Window inner shadows, hand shadows, calendar wheel shadows
- [**Terminator**](terminator.md) — Moon phase leaf display system

### Feature Systems
- [**Observatory**](observatory.md) — Observatory orrery face: ObsValue system, animation, rise/set rings
- [**Inspector**](inspector.md) — Live astronomy data explorer
- [**Astronomy**](astronomy.md) — Ported astronomical routines, opcode tracing guide
- [**Calendar**](calendar.md) — Hybrid Julian/Gregorian calendar system, known correctness issues
- [**World-Time Slots**](world-time-slots.md) — Slot architecture for Terra/Gaia world-time features
- [**Location & Cities**](location-and-cities.md) — Location system, GeoNames city picker, `file://` limitations
- [**Timezone & DST**](timezone-and-dst.md) — Timezone offset model, DST transition detection, environment rebuilds
- [**Help System**](help-system.md) — Per-face help content, Android source extraction, lazy-loading architecture
- [**Eclipse Table**](eclipse-table.md) — Standalone eclipse list: NASA dataset, TT storage, deep links into both apps
- [**Face Picker**](face-picker.md) — Face selection/reordering, the `picks` setting, selected faces page
- [**Embedding**](embedding.md) — Embedding Terra in other websites via iframe

### Development
- [**Adding a New App**](adding-a-new-app.md) — How to add a new app to the monorepo (e.g., Observatory)
- [**Face Porting Guide**](face-porting-guide.md) — Step-by-step procedure for porting a new watch face
- [**Build System**](build-system.md) — Build pipeline, face registration, deployment
- [**Testing**](testing.md) — Test framework: unit tests, regression snapshots, astronomical boundary tests
- [**Performance**](performance.md) — Scrub-perf levers found, ideas rejected, guardrails when changing render/astro code, and hard fidelity constraints
- [**Perf Regression**](perf-regression.md) — Reported (not gated) per-face CPU tick-time check for "still correct, but slower" regressions
- [**iOS Reference**](ios-reference.md) — Guide to the iOS/Android reference repositories
- [**Development Rules**](development-rules.md) — Rules to follow when making changes to this project
