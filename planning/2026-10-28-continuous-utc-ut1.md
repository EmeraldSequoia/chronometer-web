# Continuous UTC: ΔT becomes 69.184 s − (UT1−UTC)

**Status**: **commit 1 built, uncommitted** (rev 3, 2026-10-29) — see §10
for what landed and the one thing the tests caught. All four questions
answered by Steve 2026-10-29: Q1, Q2, Q4 as recommended; Q3 as recommended
except the build warning fires at **12 months**, not 18. Commit 2 (§6) not
started; Steve tests natively and commits first.
**Created**: 2026-10-28
**Baseline**: 007d31d
**Predecessor**: [2026-08-18-leap-second-deltat.md](2026-08-18-leap-second-deltat.md)
(leap-exact ΔT, commits 0513f2a + 906b7bf). This plan replaces its "after
the table expires, rejoin the Espenak polynomial" branch, which the CGPM
has just made wrong.

## 1. What changed in the world

The 28th CGPM adopted Resolution 5 on 2026-10-15
(https://www.bipm.org/en/cgpm-2026/resolution-5, French text official):

- **Continuous UTC from 2027-05-20.** No leap second will ever be inserted
  after that date. Bulletin C 72 (2026-07-06) already ruled out December
  2026, and the next slot (end of June 2027) is after the cutoff, so
  **TAI−UTC = 37 s is final now**, not just "until further notice".
- **|UT1−UTC| may grow to 3600 s.** UTC no longer tracks the Earth. The
  IERS keeps publishing UT1−UTC (Bulletin A daily values + one year of
  predictions, `finals.all`); Bulletin D's 0.1 s DUT1 and the WWV/MSF radio
  code are being retired (only Russia will implement the ITU-R's new code).
- Nothing changes for the system clock: JS `Date` is UTC and stays UTC.

Where UT1−UTC stands: Bulletin A of 2026-10-23 gives −0.044 s, and its
long-range line is `UT1−UTC = −0.1106 − 0.00040·(MJD − 61342) − (UT2−UT1)`,
i.e. UT1 currently losing 0.4 ms/day on UTC — DUT1 drifting about
**−0.15 s/yr**. (The 2020–2024 speed-up that raised the negative-leap-second
scare has eased; the decadal wobble goes either way, the secular tidal
braking only this way. See §3b.)

## 2. What that does to our ΔT

The engine has exactly one UT→TT conversion, `convertUTtoET`
([es-time.ts](../src/astronomy/es-time.ts)), fed a UTC date interval. It
currently treats ΔT as one number with three eras: Espenak polynomial
before 1972, `32.184 + (TAI−UTC)` from the leap table through
`kECLeapTableValidUntil` (2027-06-28), then the polynomial shifted to
rejoin. It ignores UT1−UTC entirely (|DUT1| < 0.9 s by construction — until
May 2027).

After continuous UTC "ΔT" splits into two quantities that used to be
interchangeable:

| quantity | before 2027-05-20 | after | who needs it |
|---|---|---|---|
| **TT − UTC** | 32.184 + TAI−UTC, exact; 69.184 since 2017 | **69.184 s, exact, forever** | every ephemeris (Sun, Moon, planets, eclipses): `julianCenturiesSince2000Epoch` |
| **UT1 − UTC** (DUT1) | within ±0.9 s, ignored | **unbounded**: −0.15 s/yr today, sign and rate not knowable decades out | Earth-rotation quantities only: GMST/GAST, hour angles, transit, rise/set, EOT, the terminator |
| **TT − UT1** (classical ΔT) | = TT−UTC − DUT1 | = 69.184 − DUT1 | same consumers as DUT1, via `tu` in `convertUTToGSTP03x` |

So the current code is wrong in two different ways after mid-2027:

1. **TT−UTC drifts away from 69.184.** The shifted polynomial reaches
   69.184 + 9.5 s by 2041 and + 17 s by 2050. TT is what the ephemerides
   consume, so every Moon position past the expiry carries the error
   (0.55″ per second of ΔT → ~5″ in 2041), and the eclipse table's stored
   TT instants display ~9 s late in UT. This one has a trivial, exact fix.
2. **GST uses UTC as if it were UT1.** Today that is a ≤13″ hour-angle
   error (≤0.9 s of rise/set time) and always was. From 2027 it grows with
   DUT1: 15″ of hour angle, and 1 s of transit/rise/set time, per second
   of DUT1. The §3b model puts it at 2 s by 2037, 5 s by 2050, 28 s by
   2100 and 67 s by 2150; the raw Espenak parabola says 4 min by 2150.
   This needs a model, and the model is the whole plan.

Nothing in the eclipse dataset changes: `eclipse-data.json` stores TT
(`tdMs`) and derives UT at render time, exactly so that ΔT could change
under it ([eclipse-table-page.ts:66](../src/eclipse-table-page.ts)).

## 3. The change

### 3a. TT − UTC: final value forever, no rejoin

In es-leap-second.ts / es-time.ts:

- Add `kECContinuousUTCStart` = 2027-05-20 00:00:00 UTC (Apple-epoch
  832464000) with the resolution cited.
- `taiMinusUTCForDateInterval` already returns the last entry for any later
  date. Make that the documented contract: the last row is final.
- `convertUTtoET` loses its third era. For `ut ≥ kECLeapEraStart` it is
  `ut + ttMinusUTCForDateInterval(ut)`, full stop. Delete
  `leapRejoinOffset`, `kECLeapTableValidUntil`'s role in es-time, and the
  two tests at es-astro.test.ts:188–205 (replace with: ΔT is exactly 69.184
  at 2027-06-29, 2040 and 2150).
- **Generator + build warning** (`scripts/update-leap-seconds.mjs`,
  build.sh:76–90): keep the generator (it is the provenance + SHA-1 check
  for the historical rows) but retire the expiry semantics. The `#@` line
  stays in the header as provenance only; the `LEAP-TABLE-EXPIRES` grep
  and warning come out of build.sh, with a one-line comment saying why
  (Q4 — see §7 for the alternative of leaving the warning until May 2027).
  Whatever IANA does to `leap-seconds.list` after the last Bulletin C
  (keep extending `#@`, freeze it, or stop) no longer affects correctness;
  the generator should accept any of those (don't die on an `#@` in the
  past).

### 3b. UT1 − UTC: a generated series + a far-future model

New generated file `src/astronomy/es-ut1-utc.ts` (sibling of
es-leap-second.ts, same house style) from a new
`scripts/update-ut1-utc.mjs`, run by hand once a year or so:

**Source**: `https://datacenter.iers.org/data/latestVersion/finals.all.iau2000.txt`
(mirror `https://maia.usno.navy.mil/ser7/finals.all`), live-verified
2026-10-28: fixed-column text, one line per day from 1973-01-02, UT1−UTC in
columns 59–68 (IERS Bulletin A/B values, flag `I`/`P` in column 58), with
**372 prediction rows** (`P`) running about a year past the issue date.
Plus `https://datacenter.iers.org/data/latestVersion/bulletinA.txt` for the
long-range line (regex on `UT1-UTC = a + b (MJD - m) - (UT2-UT1)`; take
`a`, `b`, `m`). Hard-fail on any format surprise, as the leap script does.

**What goes in the table** (Q1): one sample per month from 1972-01-01
through the end of the predictions, Apple-epoch instant + UT1−UTC in
integer milliseconds. 1972-01 to 1973-01 is before the file starts — fill
from the Bulletin B / EOP C04 series or just start the table at 1973-01 and
let the pre-1973 year use the first value (|DUT1| was < 0.9 s; nobody will
notice). ~660 rows ≈ 5 KB of source, ~2 KB gzipped. Monthly is enough:
the sub-monthly content of UT1−UTC (fortnightly zonal tides, weather) is
a few ms, far below the 0.55″/s and 15″/s levers above. Linear
interpolation between samples; before the first row clamp.

**Beyond the last sample** (Q2) — the Taylor model, in seconds with τ =
years past the last sample `t₀`:

    DUT1(t) = DUT1(t₀) + s·τ − ½·c·τ²

- `s` = the Bulletin A long-range slope (`b` × 365.25; today −0.146 s/yr):
  the IERS's own statement of the current decadal trend, and continuous in
  value and slope with the sampled series.
- `c` = the secular tidal/rebound acceleration of ΔT, 2 × 32 s/cy² =
  0.0064 s/yr² (the same constant as the Espenak/Morrison long-range
  parabola `−20 + 32·t²`). The parabola's curvature is the trustworthy
  part of the physics, as the August plan put it; its level and slope at
  any given decade are not, and this is where that argument lands now:
  take level and slope from the IERS, curvature from the physics.

With today's numbers (DUT1 −0.044 s at 2026.8, s = −0.146 s/yr) DUT1
falls monotonically: −1.9 s by 2037, −5 s by 2050, −28 s by 2100, −67 s by
2150 — versus −259 s by 2150 from the raw Espenak parabola, whose slope at
2027 (ΔT +0.62 s/yr) is four times the IERS's. That is a guess like any
other past 10–20 years out — the point is that it is continuous, bounded
by physics, and the error grows quadratically rather than stepping. It also makes staleness graceful: a table two years old
costs the app ≈ 0.3 s of DUT1 (≈ 5″ of hour angle), not a discontinuity.

**Pre-1972**: UT1−UTC is undefined before UTC existed; `convertUTtoET`
already uses the polynomial (which is TT−UT1) for that era, and the UT
handed in is treated as UT1. No change.

Generated exports: `ut1MinusUTCForDateInterval(ut)` (sample-cache +
binary search exactly as `taiMinusUTCForDateInterval`), the three model
constants, `kECUT1TableLastSampleISO`, and a `UT1-TABLE-ENDS <date>` line
for a build.sh warning when today is more than 12 months past the last
sample (warning, not failure — same philosophy as the leap warning was).

### 3c. Plumbing: Earth-rotation code sees UT1

`julianCenturiesSince2000EpochForDateInterval` keeps returning TT
centuries (now from the exact TT−UTC) and gains a `ut1MinusUTC` field;
`deltaT` becomes **TT − UT1** (= TT−UTC − DUT1) so that `tu` in
`convertUTToGSTP03x` is computed from UT1 as the formula intends. The
other input, `utSinceMidnightRadians`, must then also be UT1 since
midnight: `convertUTToGSTP03` and `GSTDifferenceForDate` add
`ut1MinusUTC` to the date interval before subtracting the prior midnight.
`convertGSTtoUT`/`convertGSTtoUTclosest` return UT1 and must subtract DUT1
to hand back a UTC instant (DUT1 changes < 2 ms/day, so subtracting the
value at the UT1 instant is already exact; no iteration). Cache slots: one
new `ut1MinusUTC` next to `tdtCenturiesDeltaT` in astro-cache.ts so a
tick evaluates it once.

That is the whole surface: every hour angle, transit, rise/set, EOT and
terminator calculation goes through these entry points
(es-riseset.ts, es-astro.ts:331/351). Ephemerides never see DUT1. Before
2027 the behavioral change is the ≤0.9 s correction we were previously
ignoring — now applied, with the sign the IERS says.

## 4. Why not just keep the parabola / why not fetch at runtime

- *Keep the shifted polynomial for everything*: wrong for TT by ≥ 9 s
  within fifteen years (§2 item 1), and it carries DUT1's sign backwards
  for the next two decades (the Earth is speeding up; the parabola says
  slowing).
- *Fetch `finals.all` at runtime*: 3.7 MB, no CORS on the IERS data
  centre, the apps are offline-capable, and the data changes by 0.15 s per
  year. A yearly regenerate is the right cadence, same as the leap table
  was.
- *Ignore DUT1 until it matters*: it matters at the seconds level already
  for the eclipse page (contact times to the second are hour-angle
  quantities), and silently sprouting a step when someone finally adds it
  is worse than carrying a smooth model from day one.

## 5. Blast radius

- **Goldens**: every regression date after 2027-06-28 moves (TT−UTC from
  parabola → 69.184: whole seconds), and every date from 1973 onward moves
  slightly in UT1-flavored fields (DUT1 now applied: up to 0.9 s of
  rise/set/transit, ≤13″ of hour angle; sub-millisecond in anything TT).
  Re-baseline with `npm run test:capture` and audit with the field-bucketed
  numeric diff from [golden-rebaseline-audit] — expect rise/set *time*
  hands to be the loud bucket, as before. The eclipse table's post-2027
  rows shift their UT labels by seconds; TT does not move.
- **Tests**: es-astro.test.ts:188–205 (rejoin + polynomial-rate tests)
  replaced; es-leap-second.test.ts:74–76 (expiry constant) dropped; new
  es-ut1-utc.test.ts auditing the table (monotone instants, |DUT1| < 1 s
  before 2027-05-20, continuity of value and slope at the model handover,
  DUT1(2050) within a second of the −5 s above).
- **Scrub perf**: one extra table lookup per tick, cached; nothing
  measurable (the lever is elsewhere, see [scrub-perf-lever-wedge-memo]).
- **Willmann-Bell / accuracy docs**: docs/accuracy.md and docs/astronomy.md
  describe ΔT as "leap-exact then polynomial" — update both to the
  two-quantity picture, and note that UT1 quantities are now good to the
  IERS prediction accuracy (ms) within a year of the table date and
  degrade ~0.15 s/yr thereafter.

## 6. Commit breakdown (Steve owns every commit; native test at each gate)

1. **Generator + table, no behavior change**: `scripts/update-ut1-utc.mjs`,
   generated `src/astronomy/es-ut1-utc.ts`, its unit test, build.sh
   staleness line. Nothing consumes it yet.
2. **TT−UTC final; UT1 plumbing**: §3a + §3c in one commit (they are one
   behavior change — "ΔT is two numbers now"), goldens recaptured and
   audited in the same commit, docs updated.
3. (Optional, later) retire `LEAP-TABLE-EXPIRES` handling once Steve is
   comfortable (Q4).

iOS parity: both iOS engines carry the same three-era scheme after the
August back-port, so they are wrong in the same two ways after May 2027.
A back-port doc like [2026-08-19-ios-backport-leap-deltat.md] follows once
the web lands; the Observatory side now goes as a GitHub-reviewed plan +
PR to the new maintainer ([ios-observatory-new-maintainer]).

## 7. Questions for Steve

- **Q1 — table span.** ✔ Monthly from 1973 (one uniform series, ~5 KB).
- **Q2 — far-future model.** ✔ Resolved 2026-10-29: IERS slope + secular
  curvature (§3b), on the evidence in §8.
- **Q3 — data cadence.** ✔ Build-time table regenerated by hand yearly;
  **build warning at 12 months** past the last sample (Steve: 12, not 18).
  Nothing touches the network at runtime.
- **Q4 — leap-table expiry machinery.** ✔ Remove now (TAI−UTC is already
  final by Bulletin C 72 + the cutoff).

## 8. External check of the §3b extrapolation (2026-10-29, Steve's question)

Nobody publishes "the" method for UT1−UTC decades ahead, because the
experts' position is that there isn't one. What the evidence supports:

- **The deterministic part is the parabola, and only the parabola.**
  Stephenson, Morrison & Hohenkerk 2016 (720 BC–AD 2015) fit
  ΔT = −320 + 32.5·u² s (u = centuries from 1825), lod +1.8 ms/cy observed
  average against +2.3 ms/cy tidal; the 2021 addendum revises the observed
  deceleration to −4.59×10⁻²² rad s⁻² = 31 s/cy² of ΔT curvature. That is
  the `c = 0.0064 s/yr²` in §3b (= 2 × 32 s/cy²). Both papers say the
  rest is "fluctuations about this trend on time scales of decades to
  centuries" and give no forward formula.
- **The decadal part is treated as noise by the people who do this for a
  living.** At the CCTF/IERS negative-leap-second workshop (March 2025):
  Bizouard (IERS Earth Orientation Centre) — "LOD/UT1 prediction is non
  conclusive"; physical modelling cannot predict core–mantle coupling;
  singular-spectrum analysis of UT1 since 1830 gives a ~65-yr term of 2 s,
  ~32/21-yr terms of 0.5 s, residuals < 0.2 s, and a parabola + 136-yr
  term of 25 s; multi-decadal swings up to 18 s peak-to-peak. Agnew
  (Scripps) — tidal friction + GIA + ice-melt barystatic taken as known,
  atmosphere and core as random, Monte-Carlo for the statistics. McCarthy
  (IAU) — options are "extend linear trend, regression model, geophysical
  correlations". The three disagreed on the sign of the next decade
  (Agnew: negative leap second by 2029; McCarthy: ~2033; Bizouard: positive
  ones 2027–2030). The current IERS trend (−0.15 s/yr) sides with Bizouard.
- **The one official multi-year product confirms the error envelope.**
  USNO `deltat.preds` (quarterly TT−UT1 predictions ~11 years ahead,
  "derived from finals.data", method undocumented) carries its own error
  column: 0.03 s at issue, 0.33 s at 4.5 yr, 0.77 s at 7.5 yr, 1.0 s at
  10 yr. The current file was issued in 2022 despite the readme's "updated
  about once per year", so it is not a usable second source — but its
  2033.75 value (ΔT 71.25 → DUT1 −2.1 s) and §3b's (−1.2 s) differ by less
  than its own 1 s bar. Treat ±1 s at 10 years, ±(several) s at 30 years,
  ±10–20 s per century as the honest uncertainty of *any* model.
- **What other software does.** Skyfield (`timelib.py`, `build_delta_t`):
  past the IERS table it takes the last value and the slope of the last
  year of data, and fits a cubic spline from there to the 2016 parabola at
  a round century ~800 years out, matching value and slope at both ends,
  then the pure parabola — i.e. the same first-order behaviour as §3b
  (IERS level + IERS slope, physics bending it afterwards), differing only
  in that Skyfield eventually rejoins the parabola's *absolute* level,
  which sits ~250 s below today's ΔT and is a millennial mean, not a
  forecast. Astropy clamps to the nearest table value beyond the IERS-A
  range (no model). NASA/Espenak's eclipse pages extrapolate with fitted
  polynomials plus a linear correction so the pieces join at 2150, and
  state only that uncertainty grows with distance. The IERS Bulletin A
  line is linear and meant for months, not decades.

**Verdict**: §3b is not an established formula, but it is the Taylor form
of what the field agrees on — level and slope from the IERS, curvature
from tidal/GIA physics, nothing else claimed — and it matches Skyfield's
near-term behaviour. The curvature term is worth ½·0.0064·τ²: 0.3 s at
10 years, 2.9 s at 30, 32 s per century — i.e. it is irrelevant inside the
window where anything is predictable and only keeps a linear trend from
running away over centuries. Adding Bizouard's 136-yr harmonic or Agnew's
climate terms would be modelling the noise. Alternatives considered and
rejected: Skyfield's rejoin to the absolute parabola (bends the wrong way
for a forecast), USNO `deltat.preds` as a data source (stale), clamping
(a step in rise/set the day the table ends).

## 9. Sources

- CGPM Resolution 5 (2026): https://www.bipm.org/en/cgpm-2026/resolution-5
- CCTF report on Draft Resolution C (dissemination survey, GNSS, radio):
  https://www.bipm.org/documents/20126/284836054/CCTF-report-on-Draft-Resolution-C.pdf/4fed2a72-9605-fad4-b2dd-90480455009b
- IERS Bulletin A (long-range formula, prediction accuracies):
  https://datacenter.iers.org/data/latestVersion/bulletinA.txt
- IERS finals.all (daily UT1−UTC + predictions):
  https://datacenter.iers.org/data/latestVersion/finals.all.iau2000.txt
- IERS Message 566 (2026-10-15, new prediction algorithm):
  https://datacenter.iers.org/data/2/message_566.txt
- Secular ΔT acceleration: Morrison & Stephenson's −20 + 32·t² (centuries
  from 1820), already in `espenakDeltaT`'s long-range branch.
- Stephenson, Morrison & Hohenkerk 2016, Proc. R. Soc. A 472:20160404
  (PMC5247521); Morrison, Stephenson, Hohenkerk & Zawilski 2021 addendum,
  Proc. R. Soc. A 477:20200776.
- CCTF/IERS workshop on the negative leap second, 13/27 March 2025 (slides
  by Bizouard, Agnew, McCarthy):
  https://www.bipm.org/en/committees/cc/cctf/wg/cctf-tgutc/2025-03-13
- USNO ΔT products (deltat.data monthly, deltat.preds quarterly
  predictions): https://maia.usno.navy.mil/products/deltaT
- Skyfield `build_delta_t`:
  https://github.com/skyfielders/python-skyfield/blob/master/skyfield/timelib.py
- Astropy IERS handling: https://docs.astropy.org/en/stable/utils/iers.html
- Agnew 2024, Nature 628:333, "A global timekeeping problem postponed by
  global warming".

## 10. Outcome of commit 1 (2026-10-29)

Landed, uncommitted, no behavior change (nothing imports the new module):

- `scripts/update-ut1-utc.mjs` — fetches `finals.all.iau2000.txt` (IERS
  datacenter, USNO mirror as fallback) and `bulletinA.txt`; parses the
  fixed columns per `readme.finals`, checks calendar columns against the
  MJD column, contiguity, flags, the ±0.95 s band before continuous UTC,
  and finds every leap second as the ±1 s jump between consecutive days,
  cross-checked date-for-date against es-leap-second.ts (both directions:
  no unexplained jump, no missing step). Bulletin A's long-range line is
  evaluated at the last finals row as a two-product consistency check
  (today: 24 ms apart, with the UT2−UT1 seasonal term applied).
- `src/astronomy/es-ut1-utc.ts` (generated, 17 KB source / 7.5 KB gzip) —
  659 samples 1973-01-02 … 2027-10-29 (observed through 2026-10-22), one
  line per year. **Design change from §3b**: the table stores the
  leap-step-free series `u = UT1−UTC − (TAI−UTC) + 37` and the accessor
  adds the exact TAI−UTC step back from es-leap-second.ts. Storing raw
  UT1−UTC would have smeared each of the 25 leap seconds since 1973 over
  the month before it (up to 1 s wrong for a month, 25 times); this way
  every leap second is an exact +1 s step and interpolation only ever sees
  a smooth curve (≤150 ms between monthly samples, enforced). Model past
  the last sample: anchor −0.208 s, slope −0.1461 s/yr from Bulletin A
  Vol. XXXIX No. 043, curvature 0.0064 s/yr².
- The tests caught one thing: holding the *smooth* series before 1973
  reconstructs −1.19 s for 1972 because TAI−UTC steps back through the
  two 1972 leap seconds. The hold is now on the final UT1−UTC value at
  the first sample (`kECUT1AtFirstSample` = 0.808 s). Commit 2 should not
  apply DUT1 before `kECLeapEraStart` at all (the polynomial era treats
  UT as UT1), so this only matters for 1972.
- build.sh: `STALE-AFTER` line (12 months after the last sample,
  2028-10-29) → warning, mirroring the leap block, which stays until
  commit 2 removes it (Q4).
- `src/astronomy/__tests__/es-ut1-utc.test.ts`: 11 tests — table shape,
  smoothness, ±0.9 s band walked daily through the leap era, all 25 leap
  seconds as exact +1 s steps, the 2017 known values (−0.407 → +0.591),
  interpolation, cache-vs-cold lookup, the pre-1973 hold, model handover
  continuity in value and slope, the τ² law (32 s per century).
