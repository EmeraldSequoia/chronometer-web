# Eclipse engine verification + sub-degree greatest-eclipse positions

**Status**: executed 2026-08-18 — outcomes and plan amendments in §8;
commits pending Steve's review (§7). Originally rev 2 (2026-08-18), written
for a fresh session with all prerequisites landed.
Topocentric fix (2f756b8), horizon indicator (f5c7a75), and leap-exact ΔT
(0513f2a + 906b7bf) are committed; Eclipse Table phase 1 is committed
(5708e4b). §3b was reconciled 2026-08-18 with the table plan's §9a: store
`tdMs` + `nasaDeltaT`, drop `utcMs`, derive UT at run/test time — this
session owns that schema change, the data regeneration, and deleting the
`EPOCH_AMBIGUOUS` exemption (2032 May 09) from eclipse-data.test.ts.
Sequel to the Eclipse Table plan
([2026-08-16-eclipse-table-page.md](2026-08-16-eclipse-table-page.md)). All sources
below were **live-probed on 2026-08-17**, not surveyed from memory; raw
responses are archived under the session scratchpad `precision-probe/` and the
key numbers are reproduced here so this doc stands alone.
**Created**: 2026-08-17
**Baseline**: e2c7b43

## 1. Goal

Two related upgrades Steve wants before approving the Eclipse Table:

1. **Verify the engine** against an authority independent of Fred Espenak's
   predictions (everything we scrape — NASA GSFC, EclipseWise — is Espenak),
   quantifying topocentric Sun/Moon accuracy in arcseconds and recording it in
   docs/astronomy.md.
2. **Sub-degree greatest-eclipse (GE) positions** for the 27 solar rows the
   catalogs give only to whole degrees (26 partials + the non-central annular
   2014 Apr 29). 43 central rows already have 0.1′ positions from SEpath
   pages; the coarse rows are why partial-eclipse deep links land with the Sun
   a few tenths of a degree off the horizon.

## 2. What the probes established

### 2a. JPL Horizons — works as an arcsecond oracle (pilot ran)

Queried the real API (`https://ssd.jpl.nasa.gov/api/horizons.api`,
`EPHEM_TYPE=OBSERVER`, `CENTER='coord@399'`, `COORD_TYPE=GEODETIC`,
`SITE_COORD='lon,lat,0'`, `QUANTITIES='2,13,20'`, `ANG_FORMAT=DEG`,
`EXTRA_PREC=YES`, `APPARENT=AIRLESS`, `CSV_FORMAT=YES`) for Sun (`10`) and
Moon (`301`) at three of our rows. The `(a-app)` frame is topocentric
apparent-of-date, refraction off — exactly what the engine computes, and
differential aberration is common-mode in a Sun−Moon *separation* at
sub-arcminute scales. Results against the engine's (4-decimal-quantized)
numbers:

| row | Horizons sep | engine sep | Δ |
|---|---|---|---|
| 2024-04-08 total | 1.25″ | 1.44″ | −0.19″ (at the ±0.18″ quote floor) |
| 2026-08-12 total | 1.38″ | 2.88″ | **−1.50″ — the one outlier, see below** |
| 2014-04-29 annular | 16.44″ | 16.92″ | −0.48″ |

The precision-critical 2014 row: Horizons puts the annular-threshold miss at
**2.14″ vs our 2.5″** — independent confirmation, to half an arcsecond, that
the engine's "partial at NASA's whole-degree point" verdict is correct.

Semidiameters agree once radius conventions are normalized: Horizons uses
fixed R_moon = 1737.4 km / R_sun = 695 700 km (IAU 2015); an engine on
k = 0.272281 (1736.66 km) predicts the observed ~0.4″ moon-SD offset.
Compare distances (quantity 20) or normalize k; don't compare raw SDs.

**The 2026-08-12 outlier is probably a real finding, not noise.** −1.5″ at an
instant ~near minimum separation is what a **2–3 s ΔT difference** produces
(off-minimum slope ≈ 0.5″/s): the engine's Meeus ΔT polynomial vs Horizons'
measured/predicted EOP (their pilot runs used `eop.260817.p261113`). The
harness must dump engine separations at full float precision (the pilot only
had 1e-4-degree quotes) and compare engine ΔT against IERS per row. If the
Meeus extrapolation is a few seconds off in the 2020s, that's an engine
cleanliness item on its own — sub-arcsecond geometry, seconds-level clock.

Operational facts: ~0.3 s/call, official fair-use policy is *sequential
requests only*, no key, no hard rate cap; 70 rows × 2 bodies = 140 calls
≈ 3 minutes with pacing. Responses must be cached and the harness must NOT
be a CI dependency (availability is best-effort; format changes are flagged
by the `API VERSION` field, currently 1.2). CSV parsing: the data line
between `$$SOE/$$EOE` has two flag columns between date and RA — index
positionally. **Horizons has no global-eclipse product** — no Besselian
elements, no GE lat/lon — it is strictly a per-site geometry oracle.

### 2b. NASA `SEdata.php` — fills the 27-row gap, same permission grant

`https://eclipse.gsfc.nasa.gov/SEsearch/SEdata.php?Ecl=YYYYMMDD` (the page the
century catalog's gamma column links to) **exists for partials and the
non-central annular** and prints GE circumstances directly: instant in TDT
and UT to 1 s, lat/lon to **0.1°** (e.g. 2011 Jan 04: 08:50:35 UT, 64.7 N
20.8 E — vs the catalog's 65 N 21 E). It also publishes the full polynomial
Besselian elements (x, y, d, l1, l2, μ as cubics about t₀, tan f1, tan f2,
k1 = 0.272488, k2 = 0.272281, ΔT), sufficient for the standard Explanatory
Supplement GE reduction (minimize x²+y² in t, oblate-Earth transform via d
and μ, ΔT longitude correction) — **~30–50 lines**, upgrading those rows to
arcminute grade. Cross-check available: derived GE for 2024-04-08 must match
its SEpath page (18:17:18.3 UT, 25°17.2′N 104°08.3′W) — the probe confirmed
the printed values agree (TDT instants identical; the 3.4 s UT gap is purely
SEdata's canonical ΔT 74.0 s vs the path page's observed 70.6 s).

Same footer as the rest of the site: *"Permission is freely granted to
reproduce this data when accompanied by an acknowledgment: 'Eclipse
Predictions by Fred Espenak, NASA's GSFC'."*

Scraper caveats (all verified live): every page injects two PHP warnings
**mid-`<pre>`** (`Undefined variable $_5MCSE_besselian_d3`) and drops the d3
coefficient — strip the warning markup, treat d3 = 0 (its n=2 term is already
~1e-6); UT minutes are not zero-padded (`06:3:24`); decode `&deg;`-style
entities; validate coefficient counts per row rather than trusting layout.
No lunar equivalent exists (LEdata.php 404s) — lunar rows don't need one.

### 2c. Independent-of-Espenak sources (survey, all probed)

- **IMCCE OPALE** (`https://opale.imcce.fr/api/v1/phenomena/eclipses/10/YYYY-MM-DD`) —
  the headline find: open JSON, no auth, **INPOP19A** ephemeris (independent
  of both Espenak and JPL DE), returns kind, magnitude, and a `greatest`
  event with **lat/lon to 0.1″ including for partials**, plus topocentric
  Sun/Moon RA/Dec/alt/az at each event. Cross-check 2026-08-12: GE
  65.1954 N 25.2284 W 17:46:00 vs Espenak's 65.225 N 25.228 W 17:45:53.8 —
  lon exact, lat 0.03°, time ~6 s (ΔT conventions). Terms: free for private/
  educational use with source identified; **commercial/professional use needs
  LTE authorization** — fine as a verification fixture, needs a decision (or
  an email) before shipping their numbers in the app.
- **Skyfield + DE440** (python; MIT + public-domain NAIF kernels) — the best
  fully-controlled offline oracle (mas-level, unlimited queries); a DIY
  independent GE-by-optimization is a 1–2 day build. Fallback if we outgrow
  Horizons' one-call-at-a-time service.
- **EclipseWise** — carries a reproduction grant (credit + link), but is
  Espenak's own DE405 computation (corroboration, not independence), the
  live site is Cloudflare-blocked (Wayback works), and its *partial* prime
  pages print **no GE lat/lon** — so it adds nothing over SEdata.
- **Xavier Jubier's map pages** — plain-curl fetchable, GE to 7 decimals even
  for partials, but the elements match Espenak's to 1e-5 (same canon) and
  there is no numeric-data reproduction grant — manual spot-checks only.
- **astronomy-engine (npm)** — ±1 arcmin envelope (~24× our 2.5″
  discriminant), GE lat/lon explicitly undefined for partials, and its kind
  classifier contains a literal `// HACK: I added a tiny bias (14 meters) to
  match Espenak test data` — cannot adjudicate anything we care about.
- **HMNAO** (Crown copyright, no GE coords, live site 503), **USNO API**
  (public domain but local circumstances 2017–2024 only), **MICA** (dead
  desktop product) — not practical.

## 3. Recommended shape (two deliverables, one session)

### 3a. Verification harness — `scripts/verify-eclipse-horizons.mjs`

Node one-off in the house style (manual run, never in build/CI, `--cache`
like scrape-eclipses.mjs). For each of the 70 solar rows in
`src/help/eclipse-data.json`: two sequential Horizons calls (Sun, Moon) at
the row's instant/site → vector-formula separation → compare against the
engine's **full-precision** separation and (post-fix) topocentric sizes,
radius-convention normalized; flag |Δsep| > 0.5″. Optionally `--opale` to
cross-check a subset against INPOP19A — three independent computations
(Espenak, JPL, IMCCE) triangulating our engine. Also compare engine ΔT vs
Horizons' EOP-derived TT−UT per row. **Update 2026-08-18**: the outlier's
cause is confirmed — the engine's espenakDeltaT polynomial is +5.9 s off in
2026 — and Steve approved fixing it via the leap-second table:
[2026-08-18-leap-second-deltat.md](2026-08-18-leap-second-deltat.md), which
runs *before* this harness. The harness's job here narrows to demonstrating
the residual collapse (2026 row from −1.5″ into the ±0.5″ band).

Deliverable: a short "Measured accuracy" subsection in
[docs/astronomy.md](../docs/astronomy.md) with the distribution of deltas —
turning "we believe the port is faithful" into "engine agrees with JPL to
X″ across 70 eclipses 2011–2041."

### 3b. GE gap-fill — extend `scripts/scrape-eclipses.mjs` with SEdata

Fetch SEdata.php for the 27 coarse rows; implement the ~40-line Besselian GE
reduction; **validate it against all 43 SEpath GE positions first** (they are
known answers to 0.1′ — if the reduction reproduces them, trust it for the
27). Emit `coordSource: 'besselian'` for the upgraded rows; keep path-page
coordinate values where they exist (don't churn 43 good rows).

**Time base — re-anchor on TT (added 2026-08-18, Steve's question about
NASA's ΔT vintages).** NASA's published UT labels embed *frozen ΔT
predictions of three different vintages* — for the same 2024 eclipse we
measured ΔT = 74.0 s (SEdata, canonical 5MCSE), 70.6 s (SEpath page), and
the true realized 69.184 s — and the GSFC archive does not retroactively
re-convert (decade-page footers frozen ~2013). The eclipse *geometry* is
computed in TT and is immune to all of this, and **TT is recoverable for
every row**: the century catalogs' primary column is TD of greatest eclipse
(solar and lunar both), SEdata prints the TDT instant directly, and SEpath
pages state the ΔT they used (so TT = published UT + stated ΔT). Therefore
(**reconciled 2026-08-18 with the table plan's §9a — this wording is the
authoritative version of the scheme, and this session owns implementing
it**): the scraper stops trusting any NASA UT label and stores the
frame-independent instant itself — **`tdMs`** (the TT instant of greatest
eclipse) plus **`nasaDeltaT`** (their per-row ΔT, kept for provenance and
for recovering their published UT in diagnostics) — and **drops `utcMs`
from the JSON entirely**. No stored UT: a baked-in derived UT would go
stale exactly the way NASA's labels did, just against a different ΔT
vintage. Consumers derive UT where they need it, at run/test time, from
the engine's own leap-exact ΔT (already landed, 906b7bf):

- the page module builds `?t=` and the today-marker comparisons from
  `tdMs − ΔT` at render time — a one-step fixed-point inversion of
  `convertUTtoET` (ΔT drifts seconds per *year*, so one refinement is
  exact at ms precision), via a small shared helper the test imports too.
  Because the page bundle is rebuilt on every build, deep links
  self-correct whenever the leap table is updated, **without re-scraping**;
- `eclipse-data.test.ts` replays `calculateEclipse` at the same derived
  instant — the engine's internal TT then equals NASA's TT *exactly*, which
  **deletes the `EPOCH_AMBIGUOUS` exemption** (2032 May 09) and tightens
  the cross-check for all 115 rows;
- `meta.note` records the convention.

Expected effect vs the current file: every stored instant becomes a TT
value (~70–80 s later than the old `utcMs` numbers — a schema change, not a
drift); *derived* UT shifts vs NASA's labels by ~1–5 s for 2011–2026 rows
and up to ~16 s for 2041 rows (NASA's assumed ΔT out there is far along the
polynomial the engine no longer uses). Invisible at minute display
precision; decisive at the arcsecond margins the test now runs at.

**Longitude carries the same ΔT vintage bias (added 2026-08-18, Steve's
observation).** Greatest eclipse is TT-frame geometry — its instant and its
pierce point in inertial space are ΔT-independent, and by axisymmetry the
latitude is too — but the Earth-fixed *longitude* label slides at the
rotation rate: **15.04″ of longitude per second of ΔT** (~460 m/s at the
equator, × cos λ). So NASA's published GE longitudes embed their frozen ΔT
vintages: ~0.2–0.7 km for path-page rows, ~1.4–2.2 km for SEdata-canonical
values, up to ~7 km for the 2041 rows. Harmless for every use (umbral paths
are 20–300 km wide; even the marginal 2014 Apr 29 row, at cos 71° ≈ 0.33,
sees ~0.1″ of separation effect against its 2.5″ margin) — but it exceeds
the path pages' nominal 0.1′ resolution, and the Besselian reduction fixes
it for free since ΔT enters the reduction only in the μ→longitude step.
Scheme: (1) run the reduction with *NASA's stated* ΔT per row and require it
to reproduce their published GE to ≤0.5′ — proves the math; (2) emit
coordinates with *our leap-exact* ΔT — corrects the vintage. This upgrades
the reduction from gap-filler to **coordinate source for all 70 rows**
(path pages demoted to validation fixtures; `coordSource: 'besselian'`
across the board — one consistent ΔT convention for both time and
longitude). Built-in self-test: the longitude delta between runs (1) and
(2) must equal 15.04″/s × δΔT exactly.

Regenerate the JSON; update `eclipse-data.test.ts` (the "central rows carry
path precision" test becomes *every solar row is besselian-sourced*; the
EclipseWise URL date-proximity tolerance already accommodates the
second-level instant shifts).

Expected side effects, to check rather than assume: partial-eclipse deep
links stop landing with the Sun ~0.3° below the EO horizon convention (the
scatter was pure coordinate rounding); 2014 Apr 29's link moves to the true
grazing point — where annularity is *marginal by construction* (gamma
−1.0000, path width 0.0 km), so the row may classify either way by
sub-arcsecond margins. Keep its test exemption; narrow the wording again.

### Explicitly not proposed

- Shipping OPALE/Jubier/EclipseWise numbers in the table (license or
  redundancy); OPALE stays a verification fixture unless Steve emails LTE.
- astronomy-engine in any role.
- Skyfield oracle — recorded as the fallback if Horizons terms or uptime
  become a problem; not needed for v1.
- Any engine change beyond what the ΔT investigation may separately motivate.

## 4. Acceptance criteria

- Reduction check: Besselian-derived GE matches all 43 SEpath positions to
  ≤ 0.5′ and their TDT instants to ≤ 2 s.
- Harness: |engine − Horizons| separation ≤ 1″ for every row **after** the
  ΔT question is resolved (the pilot suggests ≤ 0.5″ is achievable); any row
  exceeding it gets a written explanation, not a widened tolerance.
- `eclipse-data.test.ts`: still 100% kind agreement post-topocentric-fix
  (114/115 strict + the one narrowed exemption); zero rows with
  `coordSource: 'catalog'` among solar rows.
- Full suite + `tsc --noEmit` green; scraper re-run byte-stable.

## 5. Risks

- SEdata pages are generated by visibly fragile PHP (live warnings in the
  output) — parser must hard-fail on unexpected coefficient shapes, same
  posture as the existing scraper gates.
- Horizons is best-effort with a strict sequential-request policy — cache
  every response; treat the harness as evidence-generating, not gating.
- Future-date rows use predicted EOP — decades-out rows carry extra
  seconds-level time uncertainty; irrelevant at our display precision.
- The ΔT investigation can open a rabbit hole (it touches every app
  computation). Timebox it: quantify the delta, document it, and let Steve
  decide whether ECMeeusDeltaT changes in a separate plan.

## 6. Verification

`node scripts/verify-eclipse-horizons.mjs --cache …` twice (byte-stable
report); the §4 criteria; existing headless recipes unaffected (no page
changes in this plan).

## 7. Commit breakdown (Steve owns every commit)

1. Full-precision engine dump + Horizons harness + cached fixtures +
   docs/astronomy.md accuracy subsection (+ optional `--opale` flag).
2. ΔT findings written up (docs note or follow-on plan; no code unless Steve
   approves separately).
3. SEdata scrape + Besselian reduction + regenerated eclipse-data.json +
   test updates.

## 8. Execution notes (2026-08-18 session — outcomes and plan amendments)

All three deliverables are in the working tree (commits are Steve's, §7).
Full suite (8659) and `tsc --noEmit` green; scraper and harness reports
byte-stable across re-runs.

**Findings that amend this plan:**

1. **§3b/§4's "reproduce their published GE to ≤0.5′" holds only for the 43
   central rows.** NASA's stored *partial*-row GE coordinates deviate from
   their own documented definition (SEcatkey: "point closest to the shadow
   cone axis… Sun's altitude is always 0°") by 3–8′ along the sunrise ring:
   the axis distance is quadratically flat along the ring near the limb
   tangency, so the argmin is ill-conditioned at km scale and any faithful
   implementation lands elsewhere in the same valley. Our exact-ellipsoid
   minimum matches the canon's *minimized distance* to ~1e-4 R⊕ and its
   printed greatest magnitudes to all four decimals (verified against
   Jubier's 7-decimal copies of the canon values for 2011 Jan 04 and
   2014 Apr 29). Partial rows therefore validate against SEdata's printed
   0.1° circumstances at 0.25°, and the scraper comment documents the
   valley. The emitted point is the documented definition computed exactly —
   geodetic Sun altitude 0 at the instant, which is precisely what the deep
   links need.
2. **Central validation:** 42/43 path fixtures agree to ≤0.48′ great-circle
   (median ~0.1′; the pierce point is computed by exact line–ellipsoid
   intersection, not the textbook unit-sphere scaling, which drifts past
   0.5′ at Antarctic latitudes). One keyed allowance: 2021 Dec 04 at 1.01′
   (gamma −0.9526 — near-limb ×3.4 error amplification, and the path pages
   were computed with ELP2000-85 against the published elements'
   ELP2000-82).
3. **Harness acceptance met.** Leap era (37 rows): |Δsep| ≤ 0.86″, median
   0.33″; engine ΔT within 2 ms of Horizons' EOP value on every row; the
   §2a outlier (2026-08-12, −1.50″) collapsed to +0.76″ — cause confirmed
   as pure ΔT. Predicted era (33 rows): Δsep up to 5.1″ **tracks
   0.56″/s × δΔT exactly**, where δΔT (≤10.2 s by 2041) is Horizons
   freezing TAI−UTC at the last announced leap second vs our rejoined
   polynomial — written explanation per §4, no tolerance widened. Moon
   distance ≤0.81 km, Sun ≤548 km (≤0.007″ of either disc).
4. **New SEdata quirk** beyond §2b's list: the elements page prints t0's
   clock against the eclipse's own date, so an eclipse at 23:53 TDT gets
   "0.000 TDT" meaning midnight at that date's *end* (2012 May 20); the
   parser day-snaps t0 to the printed TDT instant.
5. **OPALE** cross-check ran via `--opale`, all 70 rows: central leap-era
   circumstances agree to median 0.21′ / 0.7 s — three independent
   computations (Espenak canon, JPL DE, IMCCE INPOP19A) now triangulate the
   dataset. Partials spread to ~2′ (the same flat-valley GE-point
   convention, on their side) and predicted-era instants to ~16 s (ΔT
   vintages). Fixture only, per §"Explicitly not proposed".

## 9. Coordination

- Run **after** the topocentric-sizes session lands, **and after the
  leap-second ΔT session**
  ([2026-08-18-leap-second-deltat.md](2026-08-18-leap-second-deltat.md)) —
  the harness then verifies both engine fixes at once, and its ≤1″
  acceptance bar is only realistic post-ΔT. All three sessions touch
  `eclipse-data.test.ts`.
- Commit 3 edits `scripts/scrape-eclipses.mjs`, `src/help/eclipse-data.json`,
  and `src/__tests__/eclipse-data.test.ts` — the Eclipse Table phase-1 files.
  If phase 1 is still uncommitted by then, commit it first (it is inert;
  see the working-tree note in the topocentric plan).
- The Eclipse Table's phase 2 (page build) does not depend on this work and
  can proceed in parallel; only the final data regeneration should land
  before the table ships.
