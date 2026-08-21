# iOS back-port: topocentric disc sizes in calculateEclipse

**Status**: **IMPLEMENTED 2026-08-19** (working trees left dirty for Steve per
the workflow — nothing committed). All three sites landed: esastro
(`topocentricParallax` distanceRatio out-param, `calculateEclipse` topocentric
solar thresholds, new `ESAstronomyManager::planetTopocentricDistance` + hpp
declaration), Chronometer (`ECAstronomy.m` mirror, explicit `NULL` at the three
unrelated call sites — C has no default arguments), Observatory
(`EOEclipseView.mm` §2 answer: the drawn discs do **not** flow from
`calculateEclipse` — the view sizes them itself from planet distances, so both
disc sites switched to the new accessor). Gold validation (§4): a host-side
harness compiled the real `ESAstronomy.cpp` and replayed all 115 NASA
eclipses (TT-equalized like the web suite) — before 112/115, after **115/115**,
kind changes confined to the three hybrids (2013/2023/2031 → Total; before-fix
kinds were Partial/Annular/Annular — the plan predicted Partial for 2023);
moon SD topo 0.2731°/0.2690° at the two named hybrids (geo 0.2686°/0.2648°).
`ECAstronomy.m` passed a host `clang -fsyntax-only` (0 errors); it and the
Observatory path have no in-VM runtime coverage — Steve's Xcode build is the
closing gate. Adversarially reviewed (5-lens + critic workflow): no blockers.
Original plan follows.
**Original status**: proposed — **for a fresh session**. Read
[docs/ios-backports.md](../docs/ios-backports.md) first; it defines the
workflow (edit `ios-backports/` clones only, never commit, Steve pushes from
outside the VM).
**Created**: 2026-08-19
**Web spec**: commit **2f756b8** ("Use topocentric apparent diameter when
calculating eclipses") — `git show 2f756b8` is the authoritative diff.
Rationale, evidence, and acceptance:
[2026-08-16-topocentric-eclipse-sizes.md](2026-08-16-topocentric-eclipse-sizes.md).

## 1. The bug (recap)

`calculateEclipse` compares a **topocentric** Sun–Moon separation against
disc radii computed from **geocentric** distances. An observer under the
Moon sees it up to 1.7% larger than geocentric — exactly the margin that
separates total from annular. Both 2013 Nov 03 and 2023 Apr 20 (hybrids,
total at greatest eclipse) classify as Partial on iOS today. Steve (the
original author) confirmed this is a genuine algorithm bug, fixed on the web
2026-08-18.

## 2. Where it lives on iOS (verified in the clones, 2026-08-19)

The astronomy exists in **two parallel implementations**; fix both:

1. `ios-backports/esastro/src/ESAstronomy.cpp` — the C++ library
   (Observatory links `libesastro.a`; the web port's direct ancestor):
   - `topocentricParallax` (static, :535) — computes
     `q = sqrt(A²+B²+C²)` internally and discards it; add an out-param
     (or sibling accessor) returning the Δ′/Δ distance ratio, mirroring the
     web's `distanceRatio` return.
   - `calculateEclipse` (:4601) — solar branch calls
     `planetSizeAndParallax(…, sunGeocentricDistance/moonGeocentricDistance,
     …)` and builds `separationAtPartial/Total/AnnularEclipse` from those;
     switch the *threshold* sizes to topocentric distances
     (geocentric × ratio). Keep geocentric `moonParallax`/`sunParallax` for
     the lunar-branch umbra formula — **do not touch the lunar branch** (it
     is 45-for-45 against NASA).
2. `ios-backports/Chronometer/Classes/ECAstronomy.m` — the ObjC duplicate:
   same shape, `calculateEclipse` at :4202, `topocentricParallax` nearby.
   Identical semantic change, in that file's (tab-indented, ObjC) style.

**Observatory drawing path (investigate, likely a third site)**: the web fix
also had to correct the *drawn* discs (web §4c — obs-values switched to
`distanceFromObserverOfPlanet`), or a hybrid classifies Total while the
simulator still draws a hairline annulus. Find where
`Observatory/Classes/EOEclipseView.mm` gets
its sun/moon angular sizes or distances (`pixelsPerAngularRadian`-scaled
radii, ~lines 100–260) and whether those come from geocentric distance; if
so, mirror the correction there or in the astro accessor it calls. If the
sizes already flow from `calculateEclipse`'s outputs, nothing extra is
needed — say which in the report.

## 3. Order and scope

- Land this **before** the ΔT back-port in each repo (matches web history;
  keeps diffs comparable).
- Change nothing else: no reformatting, no modernization, no lunar-branch
  symmetry "fixes".

## 4. Validation inside the VM (no Xcode here)

- `clang -fsyntax-only` on the touched files where includes resolve.
- **Numeric parity targets** (from the web work; the web engine is
  Horizons-verified): at NASA's greatest-eclipse instants/points —
  - 2013 Nov 03 12:46:28 UT @ 3.49°N 11.70°W: kind flips Partial → Total;
  - 2023 Apr 20 04:16:45 UT @ 9.60°S 125.78°E: Partial → Total;
  - topocentric moon semidiameters ≈ 0.2731° / 0.2689° respectively
    (geocentric 0.2686° / 0.2648°) — the ratio is the whole fix;
  - every non-hybrid kind unchanged; tightest surviving annular margin is
    2020 Jun 21 (~4.7″ topocentric).
  If a host-side spot-check harness is feasible (the library is plain C++
  with the WB tables in-repo), a scratch `main()` calling
  `calculateEclipse` at those two instants is the gold validation; if not
  feasible, line-by-line comparison against `git show 2f756b8` plus
  syntax-only compile, and say so.
- The full web test suite equivalent (115-row cross-check) exists only on
  the web side — Steve's outside-VM Xcode build is the final gate.

## 5. Report format

Per docs/ios-backports.md: leave working trees dirty, show
`git -C ios-backports/<repo> diff` per repo, list what was/wasn't verified,
flag anything in the iOS code that did not match the expectations above
(e.g. a structural difference from the web ancestor). Steve commits, copies
out, pushes.
