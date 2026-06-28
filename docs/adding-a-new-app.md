# Adding a New App to the Monorepo

This guide explains how to add a new app (e.g., Observatory) to the `chronometer-web` monorepo, using the shared astronomy and infrastructure layer established by Inspector.

## Prerequisites

Read these first:
- [Architecture Overview](architecture-overview.md) — Source layout, import discipline, shared environment architecture
- [Build System](build-system.md) — How bundles are produced

## Step-by-Step

### 1. Create the app directory

```
src/<app-name>/
├── <app-name>-entry.ts    # Entry point
├── <app-name>.html        # HTML page (self-contained or with partials)
└── ...                    # App-specific modules
```

Example for Observatory:
```
src/observatory/
├── observatory-entry.ts
├── observatory.html
└── ...
```

### 2. Write the entry point

The entry point is the TypeScript file that will be bundled into `<app-name>-engine.js`. It should import only from allowed sources:

**Allowed imports:**
```typescript
import { ... } from '../shared/astro-env.js';       // ✅ Shared infrastructure
import { ... } from '../shared/app-state.js';        // ✅ State (getState/setState/initAppState)
import { ... } from '../shared/url-state.js';        // ✅ URL serializer (for sharing/fallback)
import { ... } from '../shared/location-dialog.js';  // ✅
import { ... } from '../shared/time-controller.js';  // ✅
import { ... } from '../shared/city-search.js';      // ✅
import { ... } from '../expr/evaluator.js';          // ✅ Expression system
import { ... } from '../expr/parser.js';             // ✅
import { ... } from '../astronomy/es-astro.js';      // ✅ Astronomy
```

**Forbidden imports:**
```typescript
import { ... } from '../watch/watch-env.js';   // ❌ Chronometer-specific
import { ... } from '../watch/renderer.js';    // ❌
import { ... } from '../watch/xml-parser.js';  // ❌
import { ... } from '../engine-entry.js';      // ❌
```

### 3. Create the astronomy environment

Use `createAstroEnvironment()` from `src/shared/astro-env.ts` to get a ready-to-use expression environment with all ~159 astronomy/calendar/time functions:

```typescript
import { createAstroEnvironment } from '../shared/astro-env.js';
import type { Environment } from '../expr/evaluator.js';

// Create environment with location and timezone
const env: Environment = createAstroEnvironment(
    lat,              // latitude in degrees (N positive)
    lon,              // longitude in degrees (E positive)
    () => new Date(), // time source (Date supplier)
    locationTimezone, // Olson timezone string, e.g. 'America/Los_Angeles'
);
```

The environment will contain:
- **All astronomy functions**: `sunAltitude()`, `moonAgeAngle()`, `sunRA()`, etc.
- **All calendar/time functions**: `hour24Value()`, `dayOfMonthNumber()`, `yearNumber()`, etc.
- **Rise/set/transit time functions**: `nextSunrise()`, `prevMoonset()`, `sunriseForDayTime()`, `nextRiseOfPlanet(planet)`, etc.
- **Math functions**: `sin`, `cos`, `sqrt`, `abs`, etc.
- **Constants**: `pi`, `true`, `false`, plus planet constants (`Sun=0`, `Moon=1`, `Venus=3`, etc.)

If your app needs additional environment functions beyond what `astro-env.ts` provides, add them either:
- To `astro-env.ts` if they're generally useful across apps
- In your app's own entry point, by adding to the `env.functions` map after `createAstroEnvironment()` returns

### 4. Use the location system

The shared location dialog handles city search, geolocation, and the mini-map globe:

```typescript
import { initLocationDialog, requestBrowserLocation } from '../shared/location-dialog.js';
import { initAppState, getState, setState } from '../shared/app-state.js';
import { resolveTimezone } from '../shared/tz-resolve.js';
import { findClosestCity } from '../shared/city-search.js';

// Select the state backend (LocalStorage by default; URL/in-memory fallback).
// Pass the app name so per-app settings get their own namespace.
initAppState({ app: '<app-name>' });

// Read location from the active backend (storage in the normal case)
const urlState = getState();
let lat = urlState.lat ?? 0;
let lon = urlState.lon ?? 0;

// Initialize the location dialog with a callback for when location changes
initLocationDialog(document.body, (newLat, newLon, tz, cityName) => {
    lat = newLat;
    lon = newLon;
    // Rebuild environment, update display, persist...
    setState({ lat: newLat, lon: newLon, tz });
});

// If no location is stored, prompt for one:
// - Use requestBrowserLocation() for geolocation API
// - Or trigger the dialog to open
```

> Add the new app's name to the `AppName` union in `shared/app-state.ts` (and,
> if it has its own persisted settings, give it a namespace in `namespaceOf()` /
> `appNamespace()`). Location and time live in the shared namespace automatically.

### 5. Create the HTML page

Write a self-contained HTML page. The page should:
- Load fonts (Inter, JetBrains Mono) via `<link>` in `<head>`
- Include a `<script src="<app-name>-engine.js" type="module">` tag
- Have proper `<title>` and `<meta>` tags

See `src/inspector/inspector.html` as a complete example. Inspector's HTML contains all CSS inline in a `<style>` block and references `inspector-engine.js`.

### 6. Add to `build.sh`

Add two sections to `build.sh`:

**a) Bundle the entry point:**

After the existing engine bundling section, add:

```bash
echo "=== Bundling <app-name> engine ==="
npx esbuild src/<app-name>/<app-name>-entry.ts \
    --bundle \
    --format=esm \
    --outfile=dist/<app-name>-engine.js \
    --external:./cities-data.js
```

**b) Process the HTML page:**

After the face HTML generation section, add:

```bash
echo "=== Processing <app-name>.html ==="
cp src/<app-name>/<app-name>.html dist/<app-name>.html
```

If the HTML needs partial injection (e.g., the location dialog injects `cities-data.js`), add the appropriate `sed`/`awk` processing — see the existing Inspector section in `build.sh` for the pattern.

### 7. Verify bundle isolation

After building, confirm the bundle doesn't contain watch-specific code:

```bash
# Should output 0
grep -c 'watch/' dist/<app-name>-engine.js

# Compare bundle sizes — should be significantly smaller than chronometer-engine.js
ls -lh dist/chronometer-engine.js dist/<app-name>-engine.js
```

### 8. Add to the testing doc metrics

If you add regression tests for the new app, update the test metrics in [testing.md](testing.md).

---

## Reference: Inspector as a Template

Inspector (`src/inspector/`) is the minimal reference implementation of a non-Chronometer app. Study these files:

| File | What to learn from it |
|------|-----------------------|
| [inspector-entry.ts](../src/inspector/inspector-entry.ts) | How to create an `AstroEnvironment`, handle location, use the expression evaluator, and update the DOM on a timer |
| [inspector.html](../src/inspector/inspector.html) | Self-contained HTML page with inline CSS, font loading, and script tag |
| [expr-metadata.ts](../src/inspector/expr-metadata.ts) | How to provide curated metadata about available functions and constants |

Key patterns from Inspector:

1. **Environment lifecycle**: Module-level `let env: Environment` variable, recreated when location changes
2. **Location flow**: Read URL → resolve timezone → create environment. If no URL location, open dialog or use `bloc=1` for browser geolocation
3. **Timezone handling**: Use `Intl.DateTimeFormat` with the Olson timezone for formatting. Use `computeTzDeltaMs()` for offset calculations
4. **Live updates**: `setInterval` at 1s for clock updates; expression evaluator re-evaluates on each tick

---

## Shared Modules Quick Reference

| Module | What it provides | Key exports |
|--------|-----------------|-------------|
| `shared/astro-env.ts` | ~159 astronomy/calendar/time functions | `createAstroEnvironment()`, `registerAstroFunctions()`, `computeTzDeltaMs()`, `evalAttr()`, `evalColor()` |
| `shared/animation.ts` | Animation primitives + scheduling | `AnimatingValue`, `startAnimationRaw()`, `interpolateValue()`, `computeNextBoundary()` |
| `shared/obs-value.ts` / `shared/updater.ts` | Expression-driven animated values + per-frame `Updater` | `ObsValue`, `createObsValue()`, `Updater`, `makeOverridableGetNow()` |
| `shared/time-controller.ts` | Time scrubbing/stepping | `TimeController` class |
| `shared/location-dialog.ts` | Location picker UI | `initLocationDialog()`, `requestBrowserLocation()` |
| `shared/city-search.ts` | City name search | `findClosestCity()`, `searchCities()` |
| `shared/app-state.ts` | State persistence (LocalStorage/URL/in-memory) | `initAppState()`, `getState()`, `setState()`, `onSharedChange()` |
| `shared/url-state.ts` | URL serializer (sharing + URL fallback) | `readUrlState()`, `writeUrlState()`, `buildShareUrl()` |
| `shared/mini-map.ts` | Globe renderer | `MiniMap` class |
| `shared/tz-resolve.ts` | Timezone resolution | `resolveTimezone()` |
| `shared/dst-detect.ts` | DST detection | `findDSTTransitions()` |
| `expr/compile.ts` | Expression compilation | `compileExpr()`, `runInit()`, `referencedNames()` |
| `expr/env.ts` | Expression environment | `createDefaultEnvironment()`, `Environment`/`ExprFunction` types |

---

## Related Docs

- [Architecture Overview](architecture-overview.md) — Full source layout and import rules
- [Build System](build-system.md) — Bundle types and build pipeline
- [Development Rules](development-rules.md) — Import discipline enforcement (§7)
