# Accuracy of the Astronomical Algorithms

How accurate is the engine, really? This document collects the two
answers worth having:

1. **What the original astronomers promised**, transcribed from the back
   covers of the two Willmann-Bell books the engine's series come from —
   and what those same quantities measure today.
2. **What the engine actually delivers on eclipse timing**, the hardest
   thing the apps display, measured contact by contact for every eclipse
   in [the eclipse table](eclipse-table.md).

Everything here is reproducible offline: see [Reproducing](#reproducing).

> **Reference used throughout:** JPL Horizons observer tables generated
> from **DE441**, NASA/JPL's current long-span planetary and lunar
> ephemeris. Measurements were taken **2026-08-23**. DE441 is an
> authority fully independent of the 1986/1991 theories the engine
> implements, so a disagreement is a real disagreement — but note that
> for remote epochs it is *also* just a later, better model, which
> matters when reading the tables below.

## 1. What the original astronomers promised

The engine's positions come from two books, ported to C++ for the iOS
apps and then to TypeScript here (see [Astronomy](astronomy.md)):

- *Lunar Tables and Programs from 4000 B.C. to A.D. 8000* — Michelle
  Chapront-Touzé & Jean Chapront, 1991
- *Planetary Programs and Tables from −4000 to +2800* — Pierre Bretagnon
  & Jean-Louis Simon, 1986 (this one also supplies the Sun)

Each book prints an accuracy table on its **back cover**: the maximum
error in **the body's longitude, in degrees**, per epoch band. Those
tables are transcribed in `Sheet 1-Moon.csv` and
`Sheet 1-Sun & Planets.csv` at the repository root and reproduced below.
Blank cells are blank in print — the authors quote nothing there, and say
nothing about what happens if you use that precision tier for that span.

The **(measured)** figure beside each promise is the largest |Δlongitude|
this engine showed against DE441 over three sample epochs in that band
(at 15%, 50% and 85% of the span). It is a spot check, not an exhaustive
search for the worst case.

### The Moon

The lunar theory has three precision tiers, which are nested truncations
of the same amplitude-sorted series. **The engine uses full precision for
everything it displays** — see [Precision tiers](#precision-tiers-and-why-full-is-always-right).
Middle and low were measured only in the bands where the full row is
blank, since that is the only place the book's own promise for them is
the operative one.

| Period | Full precision | Middle precision | Low precision |
|---|---|---|---|
| −4000 to −2000 | — (1.11) | — | **0.8000** (1.112) ᵃ |
| −2000 to −500 | — (0.430) | — | **0.3700** (0.429) ᵃ |
| −500 to +500 | — (0.163) | **0.1360** (0.164) ᵃ | **0.1600** (0.162) ᵃ |
| +500 to +1500 | **0.0474** (0.0443) ✓ | — | — |
| +1500 to +1900 | **0.0054** (0.0050) ✓ | — | — |
| +1900 to +2100 | **0.0004** (0.00032) ✓ | — | — |
| +2100 to +2500 | **0.0054** (0.0060) ᵃ | — | — |
| +2500 to +3500 | **0.0474** (0.0436) ✓ | — | — |
| +3500 to +4500 | — (0.149) | **0.1360** (0.149) ᵃ | **0.1600** (0.143) ✓ |
| +4500 to +6000 | — (0.391) | — | **0.3700** (0.379) ᵃ |
| +6000 to +8000 | — (0.823) | — | **0.8000** (0.825) ᵃ |

Degrees. **Bold** = the book's promise; (parenthesised) = measured
2026-08-23; ✓ = inside the promise; ᵃ = outside it, but see footnote a.

> **ᵃ The lunar tidal-acceleration footnote.** Every cell marked ᵃ misses
> by 5–40%, and they all miss the *same way*: the residual is a clean
> signed quadratic in time, symmetric about J2000. Fitting the
> full-precision samples gives **Δλ ≈ 1.03″/cy² · t²**, which is the
> signature of a tidal secular acceleration difference of ≈ 2.1″/cy²
> between the 1991 theory (which adopted −23.9″/cy²) and DE441's modern
> value. Subtract that single constant and **every printed lunar cell
> falls inside its promise**, with residuals at 10–30% of the envelope.
> The authors promised fidelity to their theory as built; they could not
> promise about a tidal parameter measured better decades later. Near the
> present this term is negligible — under 0.2″ across the whole 2011–2041
> eclipse table.

### The Sun and planets

| Period | −4000 to −2000 | −2000 to 0 | 0 to +1600 | +1600 to +2800 | +2800 to +8000 |
|---|---|---|---|---|---|
| **Sun** | 0.0009 (0.0020) ᵇ | 0.0007 (0.00065) ✓ | 0.0006 (0.00039) ✓ | 0.0006 (0.00028) ✓ | 0.0009 (0.00057) ✓ |
| **Mercury** | 0.0038 (0.0034) ✓ | 0.0031 (0.0012) ✓ | 0.0027 (0.0021) ✓ | 0.0026 (0.0017) ✓ | 0.0038 (0.0020) ✓ |
| **Venus** | 0.0064 (0.0023) ✓ | 0.0042 (0.0013) ✓ | 0.0029 (0.0011) ✓ | 0.0025 (0.00036) ✓ | 0.0064 (0.00053) ✓ |
| **Mars** | 0.0104 (0.0010) ✓ | 0.0078 (0.0012) ✓ | 0.0063 (0.00045) ✓ | 0.0059 (0.00048) ✓ | 0.0104 (0.00097) ✓ |
| **Jupiter** | 0.0057 (0.0021) ✓ | 0.0033 (0.0012) ✓ | 0.0019 (0.00033) ✓ | 0.0015 (0.00031) ✓ | — |
| **Saturn** | 0.0100 (0.0017) ✓ | 0.0049 (0.0026) ✓ | 0.0019 (0.0017) ✓ | 0.0010 (0.0013) ᶜ | — |
| **Uranus** | — | — | — | 0.0007 (0.00076) ᶜ | — |
| **Neptune** | — | — | — | 0.0006 (0.0023) ᵈ | — |

Degrees; promise (measured 2026-08-23). Jupiter's and Saturn's tables end
at +2800, and Uranus/Neptune exist only for +1600 to +2800 — which is why
the app clamps its display range at 2800 CE (see
[Supported date range](astronomy.md#supported-date-range)).

> **ᵇ Sun at −4000.** Measured 7.2″ against a 3.2″ promise — but at that
> epoch the Sun, Mercury, Venus and Mars *all* show a common offset of
> about 8″, which is equinox realisation: the 1986 theory's precession
> model versus the modern one. Body-specific series error, after removing
> the common-mode, is under 1″. Not a series failure.
>
> **ᶜ Saturn and Uranus at +1600–2800.** Over by 28% and 8% — marginal,
> and consistent with the books having been fit against the DE200-era
> ephemerides of their day.
>
> **ᵈ Neptune is the one real miss:** 8.4″ against a 2.2″ promise, 3.9×
> over, and drifting secularly across the band (−1.8″ in 1780, +3.9″ in
> 2200, +8.4″ in 2620). The 1986 book predates Voyager 2's 1989 Neptune
> encounter, and one 165-year orbit of pre-encounter data could not pin
> the ephemeris across a 1200-year window. The engine reproduces the book
> faithfully; the book's Neptune promise is what does not survive contact
> with modern data. At ~8″ this is still far below anything the apps
> display — roughly a third of Neptune's own apparent disc.

### Precision tiers, and why full is always right

The lunar tiers are the book's own: `LEC` in the CD's `LUNEF1.FOR`
hard-codes 218/188/154 terms (longitude/latitude/distance) for full,
59/45/40 for middle, 29/14/18 for low, and the engine's
`lunar-tables.ts` arrays match those counts exactly. Because the tiers
are nested prefixes of one amplitude-sorted series, full precision is a
strict superset computation — never worse, only slower.

The engine selects a tier by **use case, never by epoch**: displayed
positions are always full precision, and the only non-full uses are
speed optimisations inside the rise/set and transit iteration loops,
which start the Moon at low precision and upgrade to full before the
result converges (polar latitudes force full throughout). Middle
precision has no production call site at all.

Measurement confirms this is the right policy even at the extremes where
the book's full-precision row goes blank: at −4000 the three tiers agree
with each other to within 60″ while all three sit ~4000″ from DE441. Far
from J2000 the error lives in the mean longitude and long-period terms
that every tier shares, so truncation is not the binding constraint and
there is nothing to gain by dropping down. The blank cells mean the
authors declined to quote precision that truncation could not deliver —
not that full precision misbehaves there.

## 2. Eclipse timing

Eclipse contacts are the most demanding thing the apps compute: they
depend on the Sun's and Moon's positions, both bodies' distances (for
disc sizes), the observer's parallax, and ΔT — and a timing error is
directly visible as a wrong number of seconds.

For every eclipse in [the eclipse table](eclipse-table.md) (115 rows,
2011–2041), the engine's defining interval was measured against DE441:
totality or annularity (C2..C3) at the greatest-eclipse site for central
solar eclipses, the whole partial eclipse (C1..C4) there for partial
solar, and the umbral phase (U2..U3 total, U1..U4 partial) geocentrically
for lunar. Both sides use *the engine's own* thresholds, disc radii and
shadow rule, so the comparison isolates the ephemeris rather than
convention differences.

| Kind | n | Start time, median / worst | Interval length, median / worst |
|---|---|---|---|
| Total solar | 9 | 1.05 s / 1.96 s | **0.01 s** / 0.03 s |
| Annular solar | 12 | 1.17 s / 2.91 s | **0.01 s** / 0.50 s |
| Hybrid solar | 2 | 0.21 s / 0.41 s | **0.04 s** / 0.05 s |
| Partial solar | 14 | 1.05 s / 4.37 s | 0.24 s / 6.34 s |
| Total lunar | 15 | 0.51 s / 3.55 s | 0.48 s / 7.93 s |
| Partial lunar | 8 | 0.43 s / 5.23 s | 1.25 s / 11.13 s |
| **All (2011 – mid-2027)** | **60** | **0.70 s / 5.23 s** | **0.15 s / 11.13 s** |

Absolute differences from DE441, in seconds, for eclipses inside the
leap-second era. Full per-eclipse listing: [Appendix](#appendix-every-eclipse-in-the-table).

The headline: **the length of totality or annularity is right to
hundredths of a second**, and the moment it starts is right to about a
second. For 2024-04-08 — the most-observed eclipse in the table — the
engine's contacts land 0.51 s from DE441 and the duration of totality
agrees to under 0.01 s.

Every outlier is a **low-rate geometry**, where the Moon closes on the
shadow edge at a shallow angle so the contact instant is intrinsically
ill-conditioned: 2013-04-25 (a 27-minute barely-umbral partial lunar,
closing at 0.071″/s against a typical 0.3″/s) accounts for the 11 s
worst-case interval error, and 2021-05-26 (a 15-minute barely-total
lunar) for the next. These are properties of the eclipse, not drift in
the engine — the same geometry makes published predictions disagree with
each other too.

### What limits the accuracy: the Sun, not the Moon

Attributing each contact shift to one component at a time gives a clear
and slightly counter-intuitive answer. In the modern era the engine's
**Sun** is the limiting body: its raw angular offset from DE441 runs
0.44″ median (1.30″ worst) versus the Moon's 0.25″ (0.53″ worst), and the
Sun's term is the larger one in 54 of 74 solar contacts. The elaborate
218-term Chapront lunar series is *more* faithful than the compact
Bretagnon & Simon solar series; since both errors are divided by the same
Sun–Moon closing rate to become seconds, the Sun's larger offset sets the
clock. Disc-size error contributes at most 0.17 s anywhere, via the lunar
umbral radius, and is negligible for solar eclipses (≤ 0.01 s).

If eclipse timing ever needed to be better, the lever is a longer *solar*
series — not a better lunar one.

### Beyond the current era

Two separate things degrade as you move away from the present, and it is
worth keeping them apart.

**Past 2027 — ΔT, not geometry.** The app's leap-second table is exact
through mid-2027. Beyond it, the engine extrapolates a polynomial for ΔT
while Horizons freezes TT−UTC at the last announced leap second; by 2041
those two conventions differ by 10.2 s. Eclipse *start times* therefore
diverge to a median 6.1 s (worst 18.8 s) — but the *interval lengths*
stay at a 0.25 s median, because a time-base disagreement cancels between
the two contacts. Nobody knows how fast the Earth will actually be
rotating in 2041; this is two honest predictions of an unknowable
quantity, not an error in either.

**Centuries and millennia out — the theories themselves.** The tables in
§1 are the answer here. Roughly: the Moon is good to a few arcseconds
near the present, a few arcminutes by ±2000 years, and about a degree at
the ends of its 4000 BCE – 8000 CE range; the Sun and planets stay within
a few arcminutes everywhere, with the caveats in the footnotes. The app
clamps its display range to **4000 BCE – 2800 CE**, the span of the
planetary tables. Practical consequence: at remote epochs the displays
remain qualitatively right — the right phase, the right season, the right
side of the sky — while the minute-level detail of a rise time or an
eclipse contact should not be trusted. ΔT is the larger uncertainty at
those epochs in any case: it is only known to within minutes for the
classical era, and each second of ΔT error moves the Moon 0.55″.

## 3. What the tables cost

The accuracy in §1 is bought with data. `lunar-tables.ts` and
`planet-tables.ts` are nothing but coefficients transcribed from the two
books, and they are by a wide margin the largest thing in the astronomy
engine — the price of needing no network connection to know where the
planets are.

### Download

| Module | Raw JS | gzip | brotli |
|---|---|---|---|
| `lunar-tables` | 94.0 KB | 28.4 KB | 20.2 KB |
| `planet-tables` | 904.0 KB | 265.9 KB | 198.1 KB |
| **Both** | **997.8 KB** | **294.9 KB** | **218.2 KB** |

Bundled the way `build.sh` bundles them (esbuild, `es2020`, not
minified). Inside the shipped `chronometer-engine.js` the two modules
account for **1011 KB of 1667 KB — 60.6% of the engine bundle**,
attributed with esbuild's own metafile rather than estimated. Any server
with compression enabled sends about 295 KB of it; a static host serving
raw files sends the megabyte.

The planetary tables are 10× the lunar ones despite the Moon being the
harder body, because they store *piecewise* rather than *analytic* data:
Jupiter and Saturn each carry 1,360 five-year blocks — 21 degree-6
polynomial coefficients per block, seven each for longitude, latitude and
radius — which is exactly what it takes to tile −4000 to +2800. Uranus
and Neptune have 240 blocks apiece, covering only +1600 to +2800. The
Moon, by contrast, is a few hundred periodic terms that evaluate at any
date, so its table does not grow with the span it covers.

### Memory

| What is being counted | Size | Detail |
|---|---|---|
| The numbers themselves | 626.2 KB | 80,152 distinct float64 values |
| As JavaScript objects and arrays | 2.0 MB | 3.3× the payload — 7,978 objects, 9,644 arrays |
| Heap growth on import | 4.3 MB | the above, plus compiled code and retained source |

Measured under V8 (Node, Chrome, Edge) with forced garbage collection
between readings; JavaScriptCore and SpiderMonkey lay these structures
out differently. The 626 KB of coefficients is the figure comparable to
the original C, which held the same values as packed structs — close to,
though somewhat above, the "about 500 kilobytes" the app's own help
quotes for the iOS version.

The 3.3× spread between the coefficients and their in-memory
representation is structural, not waste in the ordinary sense: the outer
planets are stored as 3,200 objects each holding three seven-element
arrays, and in JavaScript every one of those small arrays carries its own
header and backing store. Flattening them into a handful of
`Float64Array`s would recover most of the difference and shrink the
download too, at the cost of replacing readable table literals with
opaque binary blobs. Nothing in the app is short of memory, so this is
recorded as a fact rather than a plan — but it is the obvious lever if
that ever changes.

Everything is loaded eagerly, as part of the engine bundle: any
astronomical value needs the tables, so there is nothing to defer. Once
loaded, no further data is ever fetched — the tables *are* the ephemeris.

## Reproducing

Both harnesses are manual and evidence-generating — never part of the
build or CI, because JPL asks that Horizons be queried sequentially and
sparingly. Every response is cached (condensed) under
`scripts/horizons-cache/`, so re-runs are offline and byte-stable.

```bash
node scripts/verify-wb-envelopes.mjs
```

Samples each body's apparent longitude against Horizons inside every
epoch band of §1. Both sides are evaluated at the *same TT instant* and
rotated to the ecliptic with the *same* obliquity, so ΔT and frame
conventions cancel and the difference is the series error. `--only moon`
restricts to one body.

```bash
node scripts/verify-eclipse-intervals.mjs
```

Measures §2. Add `--decompose` for the per-contact attribution table,
`--only YYYY-MM-DD` or `--kind total-solar` to narrow it.

```bash
node --expose-gc scripts/measure-astro-tables.mjs
```

Measures §3 — bundle sizes under each compression scheme, the tables'
share of the engine bundle, and the heap cost of loading them. Needs no
network access.

Working notes, including the method traps that had to be fixed before the
numbers meant anything, are in
[`planning/2026-08-23-wb-envelope-mapping.md`](../planning/2026-08-23-wb-envelope-mapping.md)
and
[`planning/2026-08-23-eclipse-interval-timing.md`](../planning/2026-08-23-eclipse-interval-timing.md).

## Appendix: every eclipse in the table

Δ values are Horizons-implied minus engine, in seconds; a positive Δstart
means the engine begins the interval early. Rows marked **ᴾ** fall past
the leap-second table, where the ΔT convention gap dominates the start
time (but not the length) — see [Beyond the current era](#beyond-the-current-era).

| Date (TT) | Kind | Interval | Engine length | Δstart | Δend | Δlength |
|---|---|---|---|---|---|---|
| 2011-01-04 | Partial solar | C1..C4 | 156.79 m | +0.28 s | +0.82 s | +0.54 s |
| 2011-06-01 | Partial solar | C1..C4 | 98.13 m | -1.71 s | -2.23 s | -0.52 s |
| 2011-06-15 | Total lunar | U2..U3 | 100.27 m | -1.16 s | -0.77 s | +0.39 s |
| 2011-07-01 | Partial solar | C1..C4 | 63.01 m | -4.37 s | +1.97 s | +6.34 s |
| 2011-11-25 | Partial solar | C1..C4 | 96.49 m | +0.06 s | +0.10 s | +0.04 s |
| 2011-12-10 | Total lunar | U2..U3 | 51.24 m | -1.62 s | +1.41 s | +3.02 s |
| 2012-05-20 | Annular solar | C2..C3 | 5.67 m | -0.67 s | -0.66 s | +0.01 s |
| 2012-06-04 | Partial lunar | U1..U4 | 126.59 m | -0.45 s | -0.14 s | +0.31 s |
| 2012-11-13 | Total solar | C2..C3 | 4.11 m | -0.54 s | -0.52 s | +0.01 s |
| 2013-04-25 | Partial lunar | U1..U4 | 26.81 m | -5.23 s | +5.90 s | +11.13 s |
| 2013-05-10 | Annular solar | C2..C3 | 5.93 m | +1.45 s | +1.47 s | +0.02 s |
| 2013-11-03 | Hybrid solar | C2..C3 total | 1.76 m | -0.02 s | +0.03 s | +0.05 s |
| 2014-04-15 | Total lunar | U2..U3 | 77.90 m | -0.02 s | -0.18 s | -0.16 s |
| 2014-04-29 | Annular solar | C2..C3 | 0.71 m | -0.34 s | +0.16 s | +0.50 s |
| 2014-10-08 | Total lunar | U2..U3 | 58.93 m | -0.43 s | +0.10 s | +0.53 s |
| 2014-10-23 | Partial solar | C1..C4 | 139.79 m | +0.84 s | +0.82 s | -0.03 s |
| 2015-03-20 | Total solar | C2..C3 | 2.84 m | -0.22 s | -0.22 s | -0.00 s |
| 2015-04-04 | Total lunar | U2..U3 | 6.22 m | +1.09 s | +0.61 s | -0.48 s |
| 2015-09-13 | Partial solar | C1..C4 | 137.28 m | -0.02 s | -0.25 s | -0.23 s |
| 2015-09-28 | Total lunar | U2..U3 | 71.99 m | -1.02 s | -0.70 s | +0.32 s |
| 2016-03-09 | Total solar | C2..C3 | 4.25 m | -1.96 s | -1.96 s | +0.00 s |
| 2016-09-01 | Annular solar | C2..C3 | 2.98 m | +2.77 s | +2.76 s | -0.01 s |
| 2017-02-26 | Annular solar | C2..C3 | 0.64 m | -0.38 s | -0.33 s | +0.05 s |
| 2017-08-07 | Partial lunar | U1..U4 | 115.26 m | -0.96 s | -1.09 s | -0.14 s |
| 2017-08-21 | Total solar | C2..C3 | 2.75 m | -1.05 s | -1.04 s | +0.01 s |
| 2018-01-31 | Total lunar | U2..U3 | 76.15 m | +0.94 s | +1.47 s | +0.53 s |
| 2018-02-15 | Partial solar | C1..C4 | 110.19 m | -0.10 s | +0.10 s | +0.20 s |
| 2018-07-13 | Partial solar | C1..C4 | 95.75 m | -1.29 s | +0.81 s | +2.10 s |
| 2018-07-27 | Total lunar | U2..U3 | 103.03 m | -0.37 s | -0.33 s | +0.04 s |
| 2018-08-11 | Partial solar | C1..C4 | 93.84 m | +0.26 s | +0.21 s | -0.04 s |
| 2019-01-06 | Partial solar | C1..C4 | 161.46 m | -2.73 s | -1.83 s | +0.90 s |
| 2019-01-21 | Total lunar | U2..U3 | 62.12 m | +0.38 s | -1.58 s | -1.96 s |
| 2019-07-02 | Total solar | C2..C3 | 4.64 m | -1.93 s | -1.90 s | +0.03 s |
| 2019-07-16 | Partial lunar | U1..U4 | 177.99 m | +0.30 s | -1.16 s | -1.46 s |
| 2019-12-26 | Annular solar | C2..C3 | 3.54 m | -2.91 s | -2.91 s | +0.00 s |
| 2020-06-21 | Annular solar | C2..C3 | 0.53 m | -1.41 s | -1.41 s | -0.00 s |
| 2020-12-14 | Total solar | C2..C3 | 2.24 m | +1.33 s | +1.34 s | +0.02 s |
| 2021-05-26 | Total lunar | U2..U3 | 15.06 m | +3.55 s | -4.38 s | -7.93 s |
| 2021-06-10 | Annular solar | C2..C3 | 3.79 m | -0.94 s | -0.93 s | +0.01 s |
| 2021-11-19 | Partial lunar | U1..U4 | 208.42 m | -0.41 s | -1.46 s | -1.05 s |
| 2021-12-04 | Total solar | C2..C3 | 1.96 m | -0.73 s | -0.72 s | +0.01 s |
| 2022-04-30 | Partial solar | C1..C4 | 138.78 m | -1.40 s | -0.94 s | +0.46 s |
| 2022-05-16 | Total lunar | U2..U3 | 84.95 m | -0.06 s | +0.08 s | +0.14 s |
| 2022-10-25 | Partial solar | C1..C4 | 131.71 m | +1.27 s | +1.35 s | +0.09 s |
| 2022-11-08 | Total lunar | U2..U3 | 85.06 m | +0.17 s | +0.02 s | -0.15 s |
| 2023-04-20 | Hybrid solar | C2..C3 total | 1.36 m | +0.41 s | +0.43 s | +0.02 s |
| 2023-10-14 | Annular solar | C2..C3 | 5.18 m | -0.11 s | -0.09 s | +0.02 s |
| 2023-10-28 | Partial lunar | U1..U4 | 77.45 m | +2.07 s | -2.62 s | -4.70 s |
| 2024-04-08 | Total solar | C2..C3 | 4.54 m | -0.51 s | -0.51 s | -0.00 s |
| 2024-09-18 | Partial lunar | U1..U4 | 62.75 m | +0.25 s | +2.75 s | +2.50 s |
| 2024-10-02 | Annular solar | C2..C3 | 7.31 m | +2.43 s | +2.43 s | -0.00 s |
| 2025-03-14 | Total lunar | U2..U3 | 65.51 m | -0.11 s | +1.02 s | +1.13 s |
| 2025-03-29 | Partial solar | C1..C4 | 107.28 m | -0.36 s | -0.47 s | -0.11 s |
| 2025-09-07 | Total lunar | U2..U3 | 82.18 m | +0.51 s | +0.16 s | -0.35 s |
| 2025-09-21 | Partial solar | C1..C4 | 129.47 m | +2.05 s | +2.31 s | +0.26 s |
| 2026-02-17 | Annular solar | C2..C3 | 2.27 m | -1.63 s | -1.62 s | +0.01 s |
| 2026-03-03 | Total lunar | U2..U3 | 58.46 m | -0.56 s | -1.49 s | -0.94 s |
| 2026-08-12 | Total solar | C2..C3 | 2.36 m | +1.26 s | +1.27 s | +0.01 s |
| 2026-08-28 | Partial lunar | U1..U4 | 198.16 m | +0.42 s | -0.32 s | -0.73 s |
| 2027-02-06 | Annular solar | C2..C3 | 7.74 m | +0.41 s | +0.41 s | +0.01 s |
| 2027-08-02 ᴾ | Total solar | C2..C3 | 6.45 m | +1.31 s | +1.32 s | +0.01 s |
| 2028-01-12 ᴾ | Partial lunar | U1..U4 | 56.03 m | +1.61 s | +0.07 s | -1.54 s |
| 2028-01-26 ᴾ | Annular solar | C2..C3 | 10.32 m | +1.71 s | +1.70 s | -0.01 s |
| 2028-07-06 ᴾ | Partial lunar | U1..U4 | 141.53 m | +2.00 s | +0.76 s | -1.24 s |
| 2028-07-22 ᴾ | Total solar | C2..C3 | 5.25 m | +3.22 s | +3.25 s | +0.02 s |
| 2028-12-31 ᴾ | Total lunar | U2..U3 | 71.45 m | +2.99 s | +2.33 s | -0.67 s |
| 2029-01-14 ᴾ | Partial solar | C1..C4 | 153.91 m | +3.31 s | +3.84 s | +0.53 s |
| 2029-06-12 ᴾ | Partial solar | C1..C4 | 89.56 m | +0.70 s | +0.78 s | +0.08 s |
| 2029-06-26 ᴾ | Total lunar | U2..U3 | 101.96 m | +1.74 s | +1.76 s | +0.01 s |
| 2029-07-11 ᴾ | Partial solar | C1..C4 | 93.67 m | +1.55 s | +2.71 s | +1.15 s |
| 2029-12-05 ᴾ | Partial solar | C1..C4 | 95.13 m | +1.56 s | +1.72 s | +0.16 s |
| 2029-12-20 ᴾ | Total lunar | U2..U3 | 53.83 m | +3.04 s | +2.44 s | -0.61 s |
| 2030-06-01 ᴾ | Annular solar | C2..C3 | 5.26 m | +2.83 s | +2.86 s | +0.03 s |
| 2030-06-15 ᴾ | Partial lunar | U1..U4 | 144.38 m | +2.91 s | +2.90 s | -0.02 s |
| 2030-11-25 ᴾ | Total solar | C2..C3 | 3.80 m | +4.34 s | +4.37 s | +0.03 s |
| 2031-05-21 ᴾ | Annular solar | C2..C3 | 5.30 m | +6.08 s | +6.12 s | +0.04 s |
| 2031-11-14 ᴾ | Hybrid solar | C2..C3 total | 1.24 m | +6.50 s | +6.51 s | +0.01 s |
| 2032-04-25 ᴾ | Total lunar | U2..U3 | 65.65 m | +3.57 s | +3.34 s | -0.23 s |
| 2032-05-09 ᴾ | Annular solar | C2..C3 | 0.28 m | +8.85 s | +8.21 s | -0.64 s |
| 2032-10-18 ᴾ | Total lunar | U2..U3 | 47.22 m | +2.16 s | +3.91 s | +1.75 s |
| 2032-11-03 ᴾ | Partial solar | C1..C4 | 146.67 m | +3.93 s | +3.68 s | -0.25 s |
| 2033-03-30 ᴾ | Total solar | C2..C3 | 2.67 m | +4.21 s | +4.22 s | +0.02 s |
| 2033-04-14 ᴾ | Total lunar | U2..U3 | 49.34 m | +3.65 s | +5.50 s | +1.85 s |
| 2033-09-23 ᴾ | Partial solar | C1..C4 | 128.81 m | +6.09 s | +6.72 s | +0.63 s |
| 2033-10-08 ᴾ | Total lunar | U2..U3 | 78.89 m | +4.85 s | +4.61 s | -0.25 s |
| 2034-03-20 ᴾ | Total solar | C2..C3 | 4.24 m | +8.67 s | +8.65 s | -0.01 s |
| 2034-09-12 ᴾ | Annular solar | C2..C3 | 2.85 m | +10.53 s | +10.49 s | -0.04 s |
| 2034-09-28 ᴾ | Partial lunar | U1..U4 | 26.65 m | +3.93 s | +6.65 s | +2.72 s |
| 2035-03-09 ᴾ | Annular solar | C2..C3 | 0.70 m | +12.14 s | +12.00 s | -0.14 s |
| 2035-08-19 ᴾ | Partial lunar | U1..U4 | 76.50 m | +5.59 s | +7.99 s | +2.39 s |
| 2035-09-02 ᴾ | Total solar | C2..C3 | 2.99 m | +11.75 s | +11.71 s | -0.04 s |
| 2036-02-11 ᴾ | Total lunar | U2..U3 | 74.55 m | +4.98 s | +6.14 s | +1.16 s |
| 2036-02-27 ᴾ | Partial solar | C1..C4 | 115.45 m | +4.62 s | +4.31 s | -0.31 s |
| 2036-07-23 ᴾ | Partial solar | C1..C4 | 75.27 m | +6.34 s | +10.93 s | +4.59 s |
| 2036-08-07 ᴾ | Total lunar | U2..U3 | 95.39 m | +7.78 s | +8.66 s | +0.88 s |
| 2036-08-21 ᴾ | Partial solar | C1..C4 | 98.97 m | +8.45 s | +7.90 s | -0.55 s |
| 2037-01-16 ᴾ | Partial solar | C1..C4 | 157.79 m | +7.53 s | +8.52 s | +0.99 s |
| 2037-01-31 ᴾ | Total lunar | U2..U3 | 63.82 m | +7.48 s | +5.61 s | -1.87 s |
| 2037-07-13 ᴾ | Total solar | C2..C3 | 4.07 m | +10.02 s | +10.07 s | +0.05 s |
| 2037-07-27 ᴾ | Partial lunar | U1..U4 | 192.45 m | +5.96 s | +5.55 s | -0.41 s |
| 2038-01-05 ᴾ | Annular solar | C2..C3 | 3.19 m | +13.54 s | +13.53 s | -0.02 s |
| 2038-07-02 ᴾ | Annular solar | C2..C3 | 0.89 m | +14.77 s | +14.77 s | -0.00 s |
| 2038-12-26 ᴾ | Total solar | C2..C3 | 2.39 m | +12.13 s | +12.15 s | +0.02 s |
| 2039-06-06 ᴾ | Partial lunar | U1..U4 | 179.32 m | +9.39 s | +9.01 s | -0.39 s |
| 2039-06-21 ᴾ | Annular solar | C2..C3 | 4.01 m | +10.60 s | +10.62 s | +0.02 s |
| 2039-11-30 ᴾ | Partial lunar | U1..U4 | 206.03 m | +8.55 s | +8.49 s | -0.06 s |
| 2039-12-15 ᴾ | Total solar | C2..C3 | 1.91 m | +8.53 s | +8.55 s | +0.02 s |
| 2040-05-11 ᴾ | Partial solar | C1..C4 | 134.14 m | +11.77 s | +11.65 s | -0.12 s |
| 2040-05-26 ᴾ | Total lunar | U2..U3 | 92.33 m | +11.15 s | +10.51 s | -0.64 s |
| 2040-11-04 ᴾ | Partial solar | C1..C4 | 135.64 m | +11.39 s | +10.73 s | -0.66 s |
| 2040-11-18 ᴾ | Total lunar | U2..U3 | 87.93 m | +9.58 s | +9.38 s | -0.20 s |
| 2041-04-30 ᴾ | Total solar | C2..C3 | 1.93 m | +16.54 s | +16.25 s | -0.29 s |
| 2041-05-16 ᴾ | Partial lunar | U1..U4 | 58.70 m | +18.78 s | +5.86 s | -12.92 s |
| 2041-10-25 ᴾ | Annular solar | C2..C3 | 6.01 m | +17.16 s | +17.04 s | -0.12 s |
| 2041-11-08 ᴾ | Partial lunar | U1..U4 | 90.41 m | +11.94 s | +9.19 s | -2.74 s |

## Related Docs

- [Astronomy](astronomy.md) — how the routines are structured, and the
  deliberate divergences from the iOS original
- [Eclipse Table](eclipse-table.md) — the dataset measured here, and how
  its positions and instants were derived
- [Testing](testing.md) — the automated suites (these harnesses are not
  among them, by design)
