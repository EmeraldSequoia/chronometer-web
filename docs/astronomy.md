# Astronomy

The astronomy module provides high-precision calculations for sun, moon, and planet positions, rise/set times, twilight boundaries, and lunar phase. These are ported from the iOS `esastro` library, which implements the Willmann-Bell series calculations.

## iOS/Android Reference

> **Prerequisites**: Run `scripts/clone-refs.sh` to clone the reference repos. See [ios-reference.md](ios-reference.md).

| Repo | Key files |
|------|-----------|
| `.esastro-ref/` | `src/ECAstronomy.mm` (high-level methods), `Willmann-Bell/ESWillmannBell*.cpp` (series calculations) |
| `.chronometer-ref/` | `ECVirtualMachineOps.m` (opcode → method mapping), `Classes/ECWatchTime.mm` (time methods) |
| `.estime-ref/` | `src/ESWatchTime.mm` (`secondValue`, `hour12ValueAngle`, etc.) |

## Tracing an Expression Function

When the XML uses a function like `sunRA()`, trace it through the iOS code:

1. **`ECVirtualMachineOps.m`** — Find the opcode name, see what method it calls  
   *Example*: `sunRA` → `[mainAstro sunRA]`

2. **`ECAstronomy.m`** (in `.esastro-ref/`) — Find the method implementation  
   *Example*: `sunRA` → `sunRAandDecl().rightAscension`

3. **`ECWatchTime.m`** (in `.estime-ref/`) — For time methods  
   *Example*: `year366IndicatorFraction`, `minuteValue`

4. **WB modules** (`ESWillmannBell*.cpp`) — Low-level series calculations

See [iOS Reference](ios-reference.md) for a complete file listing.

## Web Module Map

| File | Purpose | iOS equivalent |
|------|---------|---------------|
| `src/astronomy/es-astro.ts` | High-level sun/moon astronomy (RA, declination, age, position angle) | `ECAstronomy.m` |
| `src/astronomy/es-coordinates.ts` | Coordinate transforms (ecliptic ↔ equatorial ↔ horizontal) | `ECAstronomy.m` helpers |
| `src/astronomy/es-riseset.ts` | Rise/set/transit calculations for sun and moon | `ECAstronomyManager.cpp` |
| `src/astronomy/es-sidereal.ts` | Sidereal time (GMST, LST) | `ECAstronomy.m` |
| `src/astronomy/es-time.ts` | Julian date, ΔT, date interval conversions | `ESTime.cpp`, `ESCalendar.cpp` |
| `src/astronomy/es-leap-second.ts` | TAI−UTC table behind exact ΔT — **generated**, see `scripts/update-leap-seconds.mjs` | `ESLeapSecond.cpp` |
| `src/astronomy/es-calendar.ts` | Calendar utilities (day of year, leap year, month lengths) | `ESCalendar.cpp` |
| `src/astronomy/wb-sun.ts` | Willmann-Bell sun position (Bretagnon & Simon series) | `ESWillmannBellSun.cpp` |
| `src/astronomy/wb-moon.ts` | Willmann-Bell moon position (Chapront-Touzé tables) | `ESWillmannBellMoon.cpp` |
| `src/astronomy/wb-planets.ts` | Willmann-Bell planetary positions | `ESWillmannBellPlanets.cpp` |
| `src/astronomy/willmann-bell.ts` | WB manager and shared utilities | `ESWillmannBellManager.cpp` |
| `src/astronomy/astro-cache.ts` | Per-frame astronomy result caching | No direct equivalent |
| `src/astronomy/astro-constants.ts` | Shared constants | Various |
| `src/astronomy/lunar-tables.ts` | Chapront-Touzé lunar series coefficients | Data tables in WB Moon |
| `src/astronomy/planet-tables.ts` | Bretagnon & Simon planetary series coefficients | Data tables in WB Planets |

## Key Algorithms

### Moon Relative Position Angle

`moonRelativePositionAngle` determines the tilt of the moon's terminator as seen from the observer's location:

1. Compute Sun RA/Decl and Moon RA/Decl
2. Compute `positionAngle(sunRA, sunDecl, moonRA, moonDecl)` — `atan2` formula
3. Adjust for waning phase (`moonAgeAngle > π` → flip by 180°)
4. Compute Moon's hour angle, altitude, azimuth
5. Compute `northAngleForObject` (great circle course to celestial north pole)
6. Final angle = `−northAngle − posAngle − π/2`, normalized to [0, 2π)

### Solar Eclipse Thresholds Are Topocentric (deliberate iOS divergence)

**2026-08-16.** `calculateEclipse`'s solar branch sizes the Sun and Moon discs
at their **topocentric** distances — the geocentric distance times the Δ′/Δ
ratio `topocentricParallax` now returns — and builds the
partial/total/annular thresholds from those. The Observatory's eclipse
simulator does the same, via the `distanceFromObserverOfPlanet` expression
function behind `eclSunDist` / `eclMoonDist`.

iOS `ECAstronomy.m:4227–4260` uses **geocentric** sizes there and needs the
mirror change. This is not a port simplification (see
[Development Rules §2](development-rules.md#2-never-simplify-ios-algorithms)):
it is a correction to the shared algorithm, made here first.

Why: the separation the thresholds are compared against was already
topocentric, so the radii had to be too. The Moon's disc is up to 1.7% larger
overhead than from the Earth's centre, which is exactly the margin between a
total eclipse and an annular one — geocentrically the hybrid eclipses of
2013 Nov 03 and 2023 Apr 20 classified as *partial*, and the simulator could
draw a Moon too small to cover the Sun at an eclipse it had labelled total.
`src/__tests__/eclipse-data.test.ts` replays 115 NASA eclipses (2011–2041) and
now reproduces 114 exactly, hybrids asserted strictly; that test is the guard.

Explicitly unchanged: the **lunar** branch (`umbralAngularRadius` is the
classical geocentric shadow construction and reproduces all 45 NASA lunar
eclipses) and `altitudeAtRiseSet` (geocentric diameter and parallax are
correct for what it computes). See
[planning/2026-08-16-topocentric-eclipse-sizes.md](../planning/2026-08-16-topocentric-eclipse-sizes.md).

### ΔT Is Exact From 1972 Onward (deliberate iOS divergence)

**2026-08-18.** `convertUTtoET` (es-time.ts) no longer asks the Espenak
polynomial for modern dates. From 1972-01-01 through the leap-second table's
published expiry it computes ΔT as

```
TT − UTC = 32.184 s + (TAI − UTC)
```

which is exact by definition — `TAI − UTC` is the integer maintained by the
IERS, tabulated in the generated `src/astronomy/es-leap-second.ts`. Outside
that window nothing changed: before 1972 the polynomial is still
authoritative, and past the expiry it resumes with the constant offset that
makes it continuous at the handover.

iOS `ECAstronomy.m:185–199` still uses the Meeus table/polynomial and needs the
mirror change. `ESLeapSecond` is already linked into the iOS products —
this is the wiring that was always intended there and never happened. Like
the topocentric note above, this is a correction to the shared algorithm, not
a port simplification (see
[Development Rules §2](development-rules.md#2-never-simplify-ios-algorithms)).

Why: the polynomial assumed the Earth would keep decelerating. Instead it sped
up — no leap second since 2017 — so the 2005–2050 branch reads 75.07 s for
2026 against the true 69.184 s. The Moon moves 0.55″ per second of ΔT, so
every lunar position was ~3″ off and growing by ~0.5 s/yr. The evidence the
fix works: replaying NASA's published instants of greatest eclipse, every row
inside the leap era moved *closer* to concentric (2013 Nov 03: 0.74″ → 0.32″;
2016 Sep 01: 1.70″ → 0.88″; 2017 Feb 26: 1.03″ → 0.58″; 2020 Jun 21:
0.89″ → 0.47″; 2023 Apr 20: 1.57″ → 0.76″).

Two things the table deliberately does not fix. It is UTC, not UT1, so
GST and hour angles still carry the |UT1 − UTC| < 0.9 s ambiguity they always
did. And past `kECLeapTableValidUntilISO` nobody — including NASA — knows ΔT:
the IERS announces leap seconds only about six months ahead, which is why the
source file carries an expiry and build.sh warns once it passes. Our
post-expiry extrapolation is deliberately lower than the raw polynomial NASA's
eclipse catalogs assume (72.4 s vs 79 s for 2032) — which is why
`src/help/eclipse-data.json` stores the ΔT-independent TT instant (`tdMs`)
rather than anyone's UT label, and consumers derive UT at run time through
`convertETtoUT` (es-time.ts). See
[planning/2026-08-18-leap-second-deltat.md](../planning/2026-08-18-leap-second-deltat.md)
and [planning/2026-08-17-eclipse-precision-and-verification.md](../planning/2026-08-17-eclipse-precision-and-verification.md) §3b.

### Measured Accuracy: Engine vs JPL Horizons

> **See [Accuracy of the Astronomical Algorithms](accuracy.md)** for the
> full picture: the two Willmann-Bell books' published error envelopes
> annotated with what the engine measures against DE441 today, and
> eclipse contact/interval timing across the whole eclipse table. The
> section below is the earlier, narrower measurement of solar-eclipse
> geometry that came first.

**2026-08-18.** `scripts/verify-eclipse-horizons.mjs` (manual, never in
build/CI — JPL asks for strictly sequential requests) measures the engine's
topocentric Sun/Moon geometry against JPL Horizons at all 70 solar
greatest-eclipse rows of `src/help/eclipse-data.json`: apparent-of-date,
airless, at each row's site and derived-UT instant — the same frame
`calculateEclipse` computes. Responses are cached in `scripts/horizons-cache/`
(committed), so re-runs are offline and the report is byte-stable. Horizons is
an authority independent of the Espenak/NASA canon the dataset is scraped
from; the optional `--opale` flag adds IMCCE's INPOP19A as a third,
independent-of-both computation.

Measured, across 2011–2041:

- **Sun−Moon separation** (the number the partial/annular/total thresholds
  cut): inside the leap era (37 rows, 2011–2026) median |Δ| = 0.33″,
  worst 0.86″ — the engine agrees with JPL to better than an arcsecond on
  every row. At the stored TT instants and reduced coordinates, Horizons
  itself sees the discs within 0.15″ of concentric for every leap-era
  central row — independent confirmation of the dataset's positions and
  instants.
- **ΔT**: within the leap era the engine matches Horizons' EOP-derived
  TDB−UT to **≤ 2 ms** on all 37 rows. The pilot's one outlier
  (2026-08-12, −1.5″) was diagnosed as the old polynomial ΔT being +5.9 s
  in 2026; with the leap-exact ΔT it collapsed to +0.76″, inside the band.
- **Disc sizes**, compared through topocentric distances
  (radius-convention-free — Horizons uses IAU 2015 nominal radii, the
  engine 695 500/1737.10 km): Moon distance within 0.81 km (≤ 0.004″ of
  disc diameter), Sun distance within 548 km (≤ 0.007″) — the truncation
  level of the Willmann-Bell series.
- **Past the leap table's expiry** (33 rows, 2027+) separations diverge up
  to 5.1″ by 2041 — entirely the ΔT conventions: Horizons freezes TAI−UTC
  at the last announced leap second while the engine extrapolates the
  rejoined polynomial (+10.2 s difference by 2041), and the deltas track
  the Moon's 0.56″/s angular rate times that difference. This is two
  self-consistent predictions of an unknowable quantity, not a geometry
  error; the leap-era rows are the geometry measurement.
- **`--opale` triangulation** (IMCCE, INPOP19A — independent of Espenak
  *and* JPL): the central leap-era rows' greatest-eclipse circumstances
  agree with ours to median 0.21′ in position and 0.7 s in instant. Partial
  rows spread to ~2′ (their GE point lives in the same flat valley the
  scraper documents — see `greatestEclipseFromElements`) and predicted-era
  instants to ~16 s (ΔT vintages again). Verification fixture only: OPALE's
  terms require an LTE authorization before any number of theirs ships in
  the app.

### Astronomy Caching

`astro-cache.ts` provides per-frame caching to avoid redundant calculations. Multiple hands that reference the same astronomy function (e.g., `sunAltitude()`) within one frame reuse the cached result.

## Key Pitfalls

### `julianCenturiesSince2000EpochForDateInterval` returns an object

This function returns `{ julianCenturiesSince2000Epoch: number, deltaT: number }`, **not** a bare number. Always destructure:

```typescript
const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, cache);
```

### NaN guards for table lookups

During initial hand state collection, expression functions may be called before all variables are resolved, producing `NaN` inputs. Functions that do table lookups must guard at the top:

```typescript
if (isNaN(U)) return null;
```

`NaN` defeats range checks (`NaN < x` and `NaN > x` are both `false`), causing index calculations to produce `NaN` and crash on array access.

### Never simplify iOS algorithms

See [Development Rules §2](development-rules.md#2-never-simplify-ios-algorithms). The astronomical calculations contain steps that look algebraically reducible but handle numerical stability at extreme date ranges.

### Rise/Set Two-Step Search (`nextPrevRiseSetInternal`)

Finding the next/previous rise or set event uses the iOS `nextPrevRiseSetInternalWithFudgeInterval` algorithm (a faithful port in `astro-env.ts`):

1. **Fudge**: Offset `calcDate` by a small fudge factor (5 seconds) in the search direction
2. **First try**: Call `planetaryRiseSetTimeRefined(fudgeDate, ...)` which returns both `riseSetTime` and `transitTime`
3. **Transit validation**: Check if `transitTime` is in the correct temporal direction (iOS lines 2335-2337). This catches cases where the solver converges on an event in the wrong direction
4. **Retry**: If transit validation fails, retry from `fudgeDate ± 13.2 hours` (the lookahead)

The `planetaryRiseSetTimeRefined` function returns a `RiseSetResult` with both `riseSetTime` and `transitTime` fields, matching the iOS `riseSetOrTransit` output parameter pattern.

### `planetIsUp` Check

Determining whether a planet is currently above the horizon must use the same altitude threshold as the rise/set algorithm. iOS (`ECAstronomy.m` line 3427-3430) compares the planet's altitude against `altitudeAtRiseSet()` — a negative value accounting for atmospheric refraction and body semidiameter (~-0.8° to -1.0° for the Moon) — **not** against zero. Using `alt > 0` creates a several-minute gap near rise/set where the altitude check and the algorithm disagree, causing the day/night ring to briefly show tomorrow's event instead of today's.

## Supported Date Range

The Willmann-Bell series tables have finite validity:

- **Planetary/Sun tables** (Bretagnon & Simon): 4000 BCE – 2800 CE
- **Lunar tables** (Chapront-Touzé): 4000 BCE – 8000 CE

The limiting factor is the planetary/sun tables: **4000 BCE to 2800 CE**. Outside this range, inner-planet polynomial series and sun position functions produce incorrect results.

For how accurate the series are *inside* that range — which degrades steadily as you move away from the present — see [Accuracy of the Astronomical Algorithms](accuracy.md).

The `TimeController.clampDisplayTime()` method enforces this range, mirroring the iOS `ESWatchTime::checkAndConstrainAbsoluteTime()` function. When the display time reaches a boundary:

- If time is running (any rate), the clock stops automatically
- If time is stopped, the frozen value is clamped to the boundary

The limit constants are defined in `es-time.ts`:

- `ES_MIN_ASTRO_DATE = -189344476800.0` — Jan 1, 4000 BCE (Apple epoch seconds)
- `ES_MAX_ASTRO_DATE = 25245561600.0` — Jan 1, 2801 CE (Apple epoch seconds)

The time bar displays "⚠ earliest" or "⚠ latest" when at the boundary.

### Planet Rise/Set Cache

`computeDayNightLeafAngle` returns a structured result (`DayNightLeafAngleResult`) containing the angle plus two iOS output parameters: `isRiseSet` and `aboveHorizon`. These metadata values are needed by the Observatory ring renderer to distinguish "planet actually rises/sets" from "angle is a transit fallback."

Since the expression evaluator can only return a single number, the metadata is exposed through a **compute-once cache** pattern that mirrors iOS `ESAstronomy.cpp` L5032-5096:

1. **`computeAndCachePlanetRiseSet(planet, calcDate, ...)`** performs the expensive double `nextPrevRiseSetInternal` search and caches all results (angles, validity flags, above-horizon flags) in a `PlanetRiseSetCache` keyed by `(planet, observerLat, observerLon, tzOffset)`.

2. **`getPlanetRiseSetCache(planet, getNow, ...)`** returns the cached data if the `calcDate` matches, otherwise calls `computeAndCachePlanetRiseSet`.

3. **Three expression functions** consume the cache independently:
   - `dayNightLeafAngle(pn, leaf, 0)` → returns the angle (rise or set)
   - `dayNightLeafAngleIsRiseSet(pn, leaf)` → returns 1 if the planet actually rises/sets, 0 if the angle is a transit fallback
   - `dayNightLeafAngleAboveHorizon(pn, leaf)` → returns 1 if the planet is always above horizon, 0 if always below

Since all three functions hit the same cache, the expensive rise/set search runs at most once per planet per `calcDate`. There is no ordering dependency between the functions — any one can trigger the cache computation.

The `MidnightSun` pseudo-planet (used for inverted day/night rings) is transparently substituted to `Sun` in both cache functions.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/astronomy/es-astro.ts` | Main astronomy API |
| `src/astronomy/astro-cache.ts` | Per-frame result caching |
| `src/astronomy/es-time.ts` | Date range constants (`ES_MIN_ASTRO_DATE`, `ES_MAX_ASTRO_DATE`) |
| `src/watch/astro-stepper.ts` | Astronomical event stepping (rise/set, moon phase, transit search) |
| `src/shared/astro-env.ts` | Wires astronomy functions into the expression environment; planet rise/set cache |

## Related Docs

- [Expressions](expressions.md) — How astronomy functions are called from XML expressions
- [iOS Reference](ios-reference.md) — Full tracing guide for opcodes
- [Terminator](terminator.md) — Moon phase display using `moonAgeAngle` and `moonRelativePositionAngle`
- [Animation](animation.md) — Astro Step Mode: how event stepping integrates with the animation engine
- [Development Rules](development-rules.md) — Never-simplify rule, NaN guards, date range constraint
