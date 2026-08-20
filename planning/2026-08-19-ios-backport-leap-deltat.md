# iOS back-port: leap-second-exact ΔT from 1972 onward

**Status**: proposed — **for a fresh session**. Read
[docs/ios-backports.md](../docs/ios-backports.md) first (workflow: edit
`ios-backports/` clones only, never commit, Steve pushes outside the VPN).
Sequence **after** the topocentric back-port in each repo
([2026-08-19-ios-backport-topocentric.md](2026-08-19-ios-backport-topocentric.md)),
matching the web's commit order.
**Created**: 2026-08-19
**Web spec**: commits **0513f2a** (IERS table generation, no behavior
change) + **906b7bf** (ΔT switchover) — `git show` both. Design, physics,
and outcome: [2026-08-18-leap-second-deltat.md](2026-08-18-leap-second-deltat.md)
(read §10: the golden-audit story and the 2032 May 09 epoch nuance).

## 1. The bug (recap)

Both iOS astronomy implementations convert UT→ET with the Espenak/Meeus ΔT
polynomials for *all* dates. For 1972 onward, TT−UTC is exact by definition
(32.184 s + TAI−UTC from the leap-second table); the polynomial is +5.9 s
off in 2026 and drifts ~0.5 s/yr worse — ~3″ of lunar position today. Steve
originally intended `ESLeapSecond` to feed ΔT and never wired it (confirmed
2026-08-18); the web now does it, iOS should match.

## 2. Where it lives on iOS (verified in the clones, 2026-08-19)

- `ios-backports/esastro/src/ESAstronomy.cpp`:
  - ΔT block :177–330: `deltaTTable` (Meeus), `ECMeeusDeltaT` (:191),
    `espenakDeltaT` (:217), `static bool useMeeusDeltaT = false` (:313),
    `convertUTtoET` (:315–322) choosing between them.
  - The change mirrors the web's `convertUTtoET`: for
    `ut >= 1972-01-01` (in that code's epoch — check what `ut` is:
    the web/iOS interval is **Apple-epoch seconds**, so the constant is
    −915148800… verify against the code, the web used −915235200 for
    1972-01-01T00:00:00Z; derive it in-code from a documented expression
    rather than pasting a magic number), return
    `ut + 32.184 + taiMinusUtc(ut)`; past the table's validity, rejoin
    `espenakDeltaT` with the continuity offset (web es-time.ts, commit
    906b7bf, incl. `leapRejoinOffset`). Keep the `useMeeusDeltaT` debug
    switch semantics for pre-1972/fallback paths or consciously note its
    reduced role.
- `ios-backports/estime/src/ESLeapSecond.{hpp,cpp}`:
  - The table (27 entries through 2017-01-01) is **already correct** — the
    web session diffed it entry-for-entry against the canonical IERS
    leap-seconds.list: identical. No new leap seconds exist. What's
    missing for the rejoin design is a **validity horizon**: add a
    constant for the leap-seconds.list expiry (2027-06-28 as of the
    2026-08-18 fetch; see the web's generated
    `src/astronomy/es-leap-second.ts` header for provenance) or derive the
    equivalent from `ESLastLeapSecondTransition` + a documented policy.
    Smallest-change option: put the expiry constant in ESAstronomy.cpp
    alongside the rejoin code and leave estime untouched — decide with an
    eye to where Steve would rather maintain it, and say why.
  - `cumulativeLeapSecondsForUTC(utc)` already exists and is the accessor
    to call. **Key build question to answer early**: does esastro link
    estime (it references `ESTimeLocAstroEnvironment`, so almost
    certainly yes — verify in esastro's project/Makefile)? 
- `ios-backports/Chronometer/Classes/ECAstronomy.m`:
  - Same ΔT block (`espenakDeltaT` :225, `useMeeusDeltaT` :321,
    `convertUTtoET` :323–330). **The hard question**: does the Chronometer
    app link estime's `ESLeapSecond`? Its tree carries the older `ntp/`
    TSTime stack, so possibly not. If not, options: (a) vendor the
    27-entry TAI−UTC table + a ~15-line lookup directly into
    ECAstronomy.m (self-contained, duplicates data that never changes
    retroactively), or (b) add the estime dependency. **(a) is the
    recommendation** — smallest blast radius in a legacy app — but flag it
    prominently for Steve's call before he commits.

## 3. Validation inside the VPN (no Xcode here)

- `clang -fsyntax-only` on touched files where includes resolve.
- **Exact-value targets** (all verified on the web; ΔT here = ET−UT):
  - any 2017–present instant → **69.184 s** exactly;
  - 1972-01-02 → 42.184; 1976-06-15 → 47.184; 1995-06-15 → 61.184
    (mid-table epochs, Steve's own acceptance criteria);
  - continuity: 27 one-second steps and nothing else >0.1 s from 1970 to
    the rejoin, which must itself be continuous;
  - pre-1972 unchanged (espenakDeltaT).
- `ESAstronomy.cpp` contains a dormant `testConversion()` harness
  (`#ifndef NDEBUG` / `#if 0`, ~:325) that prints ΔT sweeps — temporarily
  enabling it in a scratch copy (host-side, if the file compiles with the
  repo's headers) is the cheapest real numeric check. Do not leave it
  enabled in the diff.
- Downstream effect Steve should expect on-device (not verifiable in-VM):
  modern-era Moon-position-derived displays shift ~2–3″; rise/set *times*
  by a few seconds. The web's golden audit (plan §10) characterizes it.

## 4. Explicitly not changing

- The leap-second *table contents* (verified correct; nothing new since
  2017). No Wikipedia scraper port — if iOS ever needs regeneration, the
  web's `scripts/update-leap-seconds.mjs` reads the canonical
  leap-seconds.list and could gain a `--cpp` emitter then.
- No intra-leap-second display work, no UTC-interval arithmetic changes
  (estime's existing machinery stays as-is).
- Pre-1972 and far-past behavior.

## 5. Report format

Per docs/ios-backports.md: dirty trees + per-repo diffs + explicit
verified/unverified list + the Chronometer-dependency recommendation (§2)
called out for Steve's decision before he commits.
