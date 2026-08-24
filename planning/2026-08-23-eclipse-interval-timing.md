# Eclipse interval timing vs Horizons (2026-08-23)

The end goal of the accuracy-mapping project (see
planning/2026-08-23-wb-envelope-mapping.md for the sanity floor): for
every eclipse in the app's table, how accurately does the engine time the
event's defining interval? This examines — and sharpens — the earlier
"C2 within 2 s of NASA" finding
(planning/2026-08-17-eclipse-precision-and-verification.md).

Harness: `scripts/verify-eclipse-intervals.mjs` (method in its header).
One interval per eclipse at the table's own point: totality / annularity
(C2..C3) at the greatest-eclipse site for central solar rows (hybrids get
whichever the engine's disc sizes give at GE — total, in both table
hybrids), C1..C4 for partial solar, umbral U2..U3 / U1..U4 geocentric for
lunar. Engine contacts are bisected on exactly the thresholds
`calculateEclipse` classifies with; the same metric — engine disc radii,
engine 1.01 umbral rule, engine size/parallax formulas — is applied to
Horizons' (DE441) apparent positions and its root found by Newton
iteration. Δ = Horizons-implied − engine, per contact; Δduration =
Δend − Δstart cancels ΔT and is the pure-geometry number.
`--decompose` additionally attributes each contact shift to Sun position,
Moon position, or either disc size, by swapping one component at a time.

## Method note: the sampling window has to be short

The first version sampled Horizons at contact ±300 s and took the
quadratic through the three points. That silently misfits any central
phase shorter than the window: the 32-second annularity of 2020-06-21
came out −14.8/−24.4 s (duration off by 9.6 s) when the truth is
−1.41/−1.41 s (duration off by 0.00 s). The tell was that the
one-component-at-a-time decomposition summed to −1.4 s while the
"measured" value said −14.8 s — a linear model and a root-find that
disagree by 10× mean the root-find is wrong. Fixed by sampling ±20 s and
re-querying around each new estimate until it moves < 0.05 s (typically
two iterations). The engine-side contact scan also needed a 5 s step for
central phases; a 30 s step can hide both contacts of a short annularity
inside one step.

## Results (run of 2026-08-23, 115 rows, no skips)

| Kind | n | leap-era \|Δstart\| med / max | \|Δduration\| med / max |
|---|---|---|---|
| total-solar | 9 | 1.05 / 1.96 s | 0.01 / 0.03 s |
| annular-solar | 12 | 1.17 / 2.91 s | 0.01 / 0.50 s |
| hybrid-solar | 2 | 0.21 / 0.41 s | 0.04 / 0.05 s |
| partial-solar | 14 | 1.05 / 4.37 s | 0.24 / 6.34 s |
| total-lunar | 15 | 0.51 / 3.55 s | 0.48 / 7.93 s |
| partial-lunar | 8 | 0.43 / 5.23 s | 1.25 / 11.13 s |

**Leap era overall (60 rows, 2011 – mid-2027): |Δstart| median 0.70 s,
max 5.23 s; |Δduration| median 0.15 s, max 11.13 s.** The "within 2–3 s"
claim holds with room to spare, and central-phase *durations* are two
orders of magnitude better than that — totality and annularity lengths
agree with DE441 to hundredths of a second (2024-04-08: contacts
−0.51/−0.51 s, duration Δ under 0.01 s).

The outliers are all **low-rate geometries**, where the contact metric
closes at a shallow angle and timing is intrinsically hypersensitive:
2013-04-25 (partial lunar, 0.071″/s vs a typical 0.3″/s → Δdur +11.1 s),
2021-05-26 (barely-total lunar, 0.089″/s → −7.9 s), 2011-07-01 (grazing
partial solar, 0.185″/s → +6.3 s). Sensitivity, not drift.

**Predicted era (55 rows, mid-2027 – 2041): |Δstart| median 6.09 s,
max 18.78 s — but |Δduration| median stays 0.25 s.** Past its leap table
the engine extrapolates the rejoined ΔT polynomial while Horizons freezes
TT−UTC at the last announced leap second (69.184 s); the gap (ΔΔT,
printed per row) grows to 10.2 s by 2041. Because durations stay clean,
this is a time-*label* disagreement, not a geometry failure.

## What actually limits the accuracy: the Sun, not the Moon

The decomposition is unambiguous, and mildly surprising:

| era | family | Sun-position term | Moon-position term | disc sizes | Sun-dominated |
|---|---|---|---|---|---|
| leap | solar | 0.90 s med | 0.54 s med | ≤ 0.01 s | 54 / 74 contacts |
| leap | lunar | 0.99 s med | 0.69 s med | ≤ 0.17 s | 29 / 46 contacts |
| predicted | solar | 1.02 s med | 7.20 s med | ≤ 0.01 s | 0 / 66 contacts |
| predicted | lunar | 0.91 s med | 6.63 s med | ≤ 0.16 s | 1 / 44 contacts |

In the leap era the engine's **Sun** is the limiting body: raw angular
offsets against DE441 run 0.44″ median / 1.30″ worst for the Sun versus
0.25″ / 0.53″ for the Moon. The elaborate 218-term Chapront lunar series
is *more* faithful than the compact Bretagnon & Simon solar series, and
since both errors divide by the same Sun−Moon closing rate, the Sun's
larger offset dominates the clock. Disc-size (distance) error is
negligible everywhere — at most 0.17 s, via the lunar umbral radius.

In the predicted era the Moon term swamps everything, but that is the
ΔT convention re-labelling the time base rather than a position error:
the Moon moves ~0.5″/s, so a ΔΔT of 6 s presents as ~3″ of apparent
lunar offset (measured median 2.9–3.3″). The Sun, moving 13× slower,
stays at ~1 s throughout.

## Verdict

For everything the app displays in the leap era, engine eclipse timing is
arcsecond-faithful: contacts typically well under a second from
DE441-derived truth, central-phase durations to hundredths of a second,
worst cases confined to intrinsically knife-edge geometries. Beyond the
leap table the dominant uncertainty is ΔT itself, which no ephemeris can
promise away. The clearest available improvement, if one were ever
wanted, would be a longer solar series — not a better lunar one.

## Incidental find: Horizons quantity 30 regression

Horizons' observer-table quantity 30 ("TDB-UT") broke server-side between
2026-08-18 and 2026-08-23: the byte-identical query that produced the
committed 69.185639 fixtures now returns a constant 1.867199 for every
epoch. This script therefore computes the frozen-ΔT convention itself.
Worth re-checking upstream later — `verify-eclipse-horizons.mjs` reads
the same quantity and would ingest the bad value on any cache-miss
re-run.
