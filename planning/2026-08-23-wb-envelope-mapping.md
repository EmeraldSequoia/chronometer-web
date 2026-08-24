# Willmann-Bell back-cover envelope mapping (2026-08-23)

Measures the engine's geocentric apparent longitudes against JPL Horizons
(DE441) inside each epoch band of the two Willmann-Bell books' back-cover
accuracy tables, transcribed as `Sheet 1-Moon.csv` and
`Sheet 1-Sun & Planets.csv` at the repo root. The back covers promise a
maximum error of "the longitude in degrees" per body per period; blank
cells are blank in print, and the books say nothing about tier behavior
outside a tier's quoted bands. This experiment is the sanity floor for the
eclipse-interval timing study (next phase); the ultimate question is how
the engine's real-world accuracy decomposes across series truncation,
theory-era model gaps, and ΔT.

Harness: `scripts/verify-wb-envelopes.mjs` (see its header for method
detail). Key design points:

- Both sides evaluated at the **same TT instant** (`TIME_TYPE=TT`), so ΔT
  never enters the comparison.
- Both sides' apparent RA/Dec (true equator & equinox of date, the same
  airless `(a-app)` frame `verify-eclipse-horizons.mjs` validated) rotated
  to ecliptic-of-date by the **same** rotation, so obliquity conventions
  cancel. Pipeline self-check: Horizons' ObsEcLon column is reproduced
  from Horizons' own RA/Dec to ≤ 0.57″ over 123 samples.
- 3 samples per band (15/50/85%), a sanity check, not a max-error search:
  a sample under the envelope is expected, a sample over one needs an
  explanation.
- Tier policy (Steve): Moon runs Full everywhere (production always uses
  Full); Mid/Low measured only in bands whose Full cell is blank.
- Mars→Neptune queried as system **barycenters** (planet-center
  ephemerides start at 1600 CE; barycenter offset ≤ 0.05″ as seen from
  Earth).
- Horizons responses cached (condensed) in `scripts/horizons-cache/`;
  re-runs are offline and byte-stable.

## Provenance (verified against the books' CD FORTRAN)

The engine's three lunar tiers are byte-identical to the book's own
truncations: `LEC` in `LUNEF1.FOR` hard-codes
`NC/218,188,154, 59,45,40, 29,14,18/` (Full/Mid/Low × lon/lat/dist) and
`KN/13,2,1/` for nutation, matching `lunar-tables.ts:1476–1500` exactly.
Units come from the FORTRAN's own comments: "UNITS: DEGREE FOR ALONG AND
ALAT, KM FOR R". The CD FORTRAN (`LUNEF1/2.FOR`, `SUMER.FOR`) lives in
`/Users/spucci/Willmann-Bell.zip`; it was removed from the esastro repo
before it was pushed to GitHub.

Tier selection in the engine is by use-case, never by epoch: displayed
positions are always Full; `planetaryRiseSetTimeRefined` and
`planettransitTimeRefined` start the Moon at Low for early iterations and
upgrade to Full before convergence (polar latitudes force Full
throughout); Mid has no production call site; nutation always runs at
Full regardless of the requested tier (`wb-moon.ts:194`).

## Results (run of 2026-08-23; full output reproducible offline)

**Pipeline validation.** Moon 1900–2100 Full: 0.29″/0.13″/1.14″ against a
1.44″ (0.0004°) envelope — sub-arcsecond agreement with DE441 where the
theory is at its best.

**Moon.** Raw Δλ grows quadratically and symmetrically away from J2000
and marginally exceeds several printed cells (worst raw: 1.112° vs 0.8°
at −4000..−2000). Fitting the signed Full-tier samples to a·t² gives
**a = 1.03″/cy²**, i.e. a lunar mean-motion secular-acceleration
difference of ≈ 2.1″/cy² between the 1991 theory (ELP2000-85 adopted
−23.895″/cy² tidal acceleration) and DE441's modern value (≈ −25.9″/cy²).
After removing that single quadratic, **every printed Moon cell is within
its envelope** (residuals run 10–30% of the envelope). The books promised
fidelity to the theory as built; the acceleration gap is a model-era
absolute offset they could not have promised about.

**Sun & planets.** All cells within envelope raw, except:

- Sun −4000..−2000: 7.15″ vs 3.24″ promised — but the common-mode Δλ
  across Sun/Mercury/Venus/Mars at that epoch is ~8″ (equinox/frame
  realization, precession-model era), and the Sun sits on it. Series
  error after removing common-mode is ≲ 1″: not a series failure.
- Saturn 1600..2800: 4.61″ vs 3.6″ (year-2620 sample, 28% over) and
  Uranus 1600..2800: 2.74″ vs 2.52″ (8% over) — marginal, consistent
  with the books' reference ephemerides (DE200 era) differing from DE441
  at the arcsecond level for the outer planets.
- **Neptune 1600..2800: 8.35″ vs 2.16″ promised (3.9×)** — the one real
  break. Samples drift secularly (−1.8″ @1780, +3.9″ @2200, +8.4″ @2620):
  the 1986 book was fit to a pre-Voyager Neptune ephemeris; Neptune's
  165-year period means 1980s data could not pin the orbit over the full
  1600–2800 window. The engine faithfully reproduces the book; the book's
  Neptune promise simply does not hold against modern truth away from its
  fit era.

**Tier question (blank hi cells at remote epochs).** Full/Mid/Low agree
with each other to <60″ at epochs where the total error is 1500–4000″ —
tier choice is immaterial far from J2000 because the dominant error
(mean-longitude drift + long-period terms) lives in every tier. The tiers
are nested prefixes of the same amplitude-sorted series, so Full is a
strict superset computation; using Full everywhere is correct, and the
blank hi cells just mean the authors saw no point quoting extra precision
where theory-level error swamps truncation gains.

## Implications for the eclipse-timing phase

Over the app's 30-year eclipse table (|t| ≤ 0.5 cy): tidal-gap drift
≤ 0.26″, Sun/Moon series error ≈ 0.3–1.4″, and frame terms cancel in the
Sun−Moon differential. At the Moon's 0.55″/s relative motion, engine-side
geometry contributes ~1–2 s to contact-time error — consistent with the
earlier finding that engine C2 lands within 2 s of NASA
(planning/2026-08-17-eclipse-precision-and-verification.md). ΔT
conventions, not geometry, will dominate the eclipse-interval comparison.

**Confirmed** by planning/2026-08-23-eclipse-interval-timing.md: leap-era
contacts land 0.70 s from DE441 (median), interval lengths 0.15 s, and
the decomposition there shows the *Sun's* series — not the Moon's — is
the binding constraint, exactly as the Sun-vs-Moon figures above would
predict. Both results are distilled into docs/accuracy.md.
