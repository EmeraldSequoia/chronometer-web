# Leap-second-exact ΔT (TT−UT) from 1972 onward

**Status**: **IMPLEMENTED 2026-08-18**, committed as 0513f2a (table
generator, no behavior change) + 906b7bf (ΔT switchover) — see §10 for what
landed and the one place §5's prediction was wrong.
Previously: proposed, rev 2 (2026-08-18) — Q1 resolved (leap-seconds.list
updater + file-native expiry + build-time warning; Inspector :59/:60
declined). **For a fresh session**, sequenced after the
topocentric-sizes fix ([2026-08-16-topocentric-eclipse-sizes.md](2026-08-16-topocentric-eclipse-sizes.md))
and before the Horizons verification harness
([2026-08-17-eclipse-precision-and-verification.md](2026-08-17-eclipse-precision-and-verification.md)),
whose 2026 outlier this plan should resolve. Requested by Steve 2026-08-18
("I had intended to use [the leap-second adjuster] for TT-UT conversions as
well, but it's quite possible I never got to it").
**Created**: 2026-08-18
**Baseline**: e2c7b43

## 1. Confirmation: it was never wired up, on either platform

- **Web**: ΔT has exactly one choke point —
  [`convertUTtoET`](../src/astronomy/es-time.ts) (es-time.ts:217), called only
  from `julianCenturiesSince2000EpochForDateInterval` (:330, the central
  UT→TDT conversion everything downstream uses). It adds
  `espenakDeltaT(yearValue)` — the Five Millennium Canon polynomials. A grep
  of src/ for leap-second machinery finds nothing (only leap-*year* calendar
  code). `ECMeeusDeltaT` also exists (es-time.ts:98) but is used only by
  tests.
- **iOS**: `.chronometer-ref/Classes/ECAstronomy.m:185–199` has the same
  Meeus table/polynomial scheme; `ESLeapSecond` is never referenced there.
  So the intended wiring never happened on iOS either — this is new work in
  both places, not a port.
- **The adjuster exists and is ready to port**:
  `.estime-ref/src/ESLeapSecond.{hpp,cpp}` — a 27-entry table (1972 Jul 01 →
  2017 Jan 01) of `{beginningOfChange (Apple-epoch UTC s), leapSeconds,
  cumulativeLeapSeconds}` with `cumulativeLeapSecondsForUTC(utc)` (binary
  search + one-entry cache). The web port needs only that one accessor —
  none of the intra-leap-second display machinery
  (`.estime-ref/specs/leapSeconds.txt`) applies here.

## 2. The size of the error being fixed

For t ≥ 1972-01-01, TT−UTC is *exact by definition*:
`TT − UTC = 32.184 + (TAI−UTC) = 42.184 + cumulativeLeapSeconds(t)`
(TAI−UTC was exactly 10 s at 1972-01-01; 27 leap seconds since → 37 s today,
so TT−UTC = 69.184 s from 2017 on). Against that, the engine's current
`espenakDeltaT` (2005–2050 branch: `62.92 + 0.32217t + 0.005589t²`):

| year | espenak | leap-exact | error |
|---|---|---|---|
| 2000 | 63.86 | 64.184 | −0.32 s |
| 2012 | 67.59 | 66.2–67.2 | ~+0.8 s |
| 2020 | 71.60 | 69.184 | +2.4 s |
| 2026 | 75.07 | 69.184 | **+5.9 s** |
| 2041 | 85.32 | 69.184 + future | +16 s and growing |

The polynomial assumed the Earth's rotation would keep decelerating; instead
it sped up (no leap second since 2017, DUT1 currently positive). The error
grows ~0.5 s/yr indefinitely. Effect on the sky: the Moon moves 0.55″ per
second of ΔT, so lunar positions are currently ~3″ off (and the eclipse
table's 2041 rows ~9″), which is exactly the signature the Horizons pilot
flagged as its 2026 outlier (−1.5″ separation residual, consistent with a
few-second epoch offset near an eclipse minimum). Post-fix, ΔT error in
1972→present collapses to the DUT1 ambiguity (|UT1−UTC| < 0.9 s by
construction), and even that affects only UT1-flavored quantities (GST/hour
angles) which carry it today anyway — the TT instant handed to the
ephemerides becomes exact.

## 3. The change

New `src/astronomy/es-leap-second.ts` — the table (ported from
`.estime-ref/src/ESLeapSecond.cpp:16–44` but re-derived from the canonical
IERS list rather than trusting the 2016 Wikipedia scrape; they should match
exactly — 27 entries, cumulative 37 by 2017-01-01) plus
`cumulativeLeapSecondsForUTC(dateInterval)`. Then in es-time.ts:

```ts
function convertUTtoET(ut: number, yearValue: number): number {
    if (ut >= kECLeapEraStart) {           // 1972-01-01 = −915235200 Apple
        return ut + 42.184 + cumulativeLeapSecondsForUTC(ut);
    }
    return ut + espenakDeltaT(yearValue);  // pre-1972: unchanged
}
```

- `ut` is already the Apple-epoch date interval — no signature change.
- **1972 boundary**: espenakDeltaT(1972.0) ≈ 42.25 vs leap-exact 42.184 — a
  0.07 s step, far below the polynomial's own error band. Document, don't
  blend.
- **Table representation**: store TAI−UTC per entry directly (10 s at
  1972-01-01 … 37 s at 2017-01-01), as the source file does;
  `TT − UTC = 32.184 + taiMinusUtc(t)`. Slightly simpler than the
  cumulative-since-1972 form in ESLeapSecond.cpp.
- **Future boundary (Q1 ✔, resolved 2026-08-18)**: flat leap-exact value
  through `kECLeapTableValidUntil`, then rejoin the Espenak polynomial with
  a constant offset for continuity:
  `espenakDeltaT(y) − (espenakDeltaT(VU) − leapExact(VU))` — the far-future
  parabola's curvature is the trustworthy part of the physics (§4a), the
  offset absorbs the unpredictable decadal part. `kECLeapTableValidUntil`
  is not hand-set: it comes from the source file's own expiry (§3a).

### 3a. Table updater — `scripts/update-leap-seconds.mjs` (in scope, Q1 ✔)

Steve's original `getLeapSeconds.pl` (referenced in ESLeapSecond.cpp:13) is
not in `.estime-ref`, and Wikipedia is no longer the right source anyway.
The canonical machine-readable list is **`leap-seconds.list`** (IERS-derived;
IANA mirror `https://data.iana.org/time-zones/data/leap-seconds.list`,
authoritative origin `https://hpiers.obspm.fr/iers/bul/bulc/ntp/leap-seconds.list`),
**live-verified 2026-08-18**: NTP-epoch timestamps + TAI−UTC per line, a
last-update line (`#$`), an integrity hash (`#h`), and — the feature that
answers Q1 exactly — an **expiration line `#@ 4023129600` = 2027-06-28**,
maintained on a semi-annual Bulletin C cadence. So:

- The updater (house style per scrape-eclipses.mjs: manual run, `--cache`,
  hard-fail on format surprises) fetches IANA with the IERS origin as
  fallback, parses entries (NTP epoch 1900 → Apple epoch: −2 208 988 800 −
  978 307 200), and regenerates `src/astronomy/es-leap-second.ts` — table +
  `kECLeapTableValidUntil` from `#@` + provenance header with both URLs and
  the file's `#$` stamp. Verifying the `#h` SHA-1 is a nice-to-have.
- **Build-time staleness warning (not failure)**: the generated file embeds
  the expiry as an ISO date on a greppable line; the build.sh preflight
  (the same block that checks required files, build.sh:42) compares it to
  today and prints a loud warning once past — "leap-second table expired
  ⟨date⟩; run scripts/update-leap-seconds.mjs". Build proceeds: an expired
  table is at worst 1 s wrong, and only if a leap second was actually
  announced.
- Maintenance loop: re-run the updater every year or two (or when the
  warning fires); nothing else to remember. If leap seconds are formally
  retired (CGPM 2022 says ≤2035), the file's expiry mechanism reports
  whatever the IERS does next — the scheme needs no change.

### 4a. How much do we trust "the Earth will slow down again"? (Steve's question)

Split by timescale, because the physics splits that way:

- **Secular (centuries+) — high confidence.** Tidal braking transfers
  angular momentum to the Moon's orbit at a measured rate (lunar laser
  ranging: the Moon recedes 3.8 cm/yr) → LOD grows ~+2.3 ms/day per
  century, offset by ~−0.6 from post-glacial rebound → net ~+1.7 ms/cy,
  confirmed by 2,700 years of historical eclipse timings (Stephenson &
  Morrison — the same literature our ΔT polynomials come from). This is
  what makes ΔT parabolic in the long run; its curvature is about as solid
  as geophysics gets.
- **Decadal — no confidence, by anyone.** Core–mantle angular-momentum
  exchange produces ±3–4 ms/day LOD swings on 10–70-year timescales that
  are not predictable from physics; the post-2016 speedup (record-short
  days 2020–2024) is mostly that. It is also not unprecedented: **our own
  ΔT table records the last such episode** — es-time.ts:79–80 has ΔT going
  *negative* through the 1870s–1890s (−5.5 s at 1880, −6.0 at 1890), a
  fast-Earth spell that subsequently reverted. The IERS itself predicts
  UT1 only months ahead — which is exactly why Bulletin C and the file
  expiry exist.

So: reversion is near-certain on the century scale and unknowable on the
decade scale — which is precisely the Q1 design: exact table with an
authoritative short-horizon expiry where prediction is impossible, parabola
(continuity-offset) where the physics is trustworthy.

## 4. Explicitly not changing

- **No intra-leap-second display** (the :59/:60/:00 machinery in
  `.estime-ref/specs/leapSeconds.txt`) — considered for the Inspector and
  **declined (Steve, 2026-08-18)**, because it cannot be made robust in a
  browser:
  - *Live* display of a leap second requires knowing true UTC while the
    device clock is, by design, lying: the default NTP pools most devices
    sync to (Google, Apple, Cloudflare, AWS) *smear* the leap second over
    up to 24 h, and a browser has no way to detect smear vs step. Making it
    honest would need our own unsmeared time reference (the role iOS's
    TSTime NTP stack played) — a whole subsystem for an event last seen in
    2016 and likely retired by ≤2035.
  - The one variant that *is* robust — showing 23:59:60 while **scrubbed to
    a historical leap second** (deterministic from the table, no NTP
    involved) — founders on the time model instead: the entire pipeline is
    Unix-time-based, and Unix time cannot represent :60. That's the
    leap-aware timeline arithmetic (`intervalBetweenUTCValues`) — real
    plumbing for museum value. Recorded as a future novelty, not scoped.
  - Cheap alternative if the Inspector ever wants the educational value:
    a static readout of current TAI−UTC / ΔT / table expiry once
    es-leap-second.ts exists — data, not transition theater. Optional,
    not scoped here.
- **No leap-aware UTC interval arithmetic** — serves Timestamp-style apps
  that aren't in the web port. Scope here is ΔT only, per Steve.
- **No UT1/DUT1 modeling** — GST continues to take the displayed (UTC) time
  as UT1; the <0.9 s ambiguity is inherent and pre-existing.
- **Pre-1972 ΔT** — espenakDeltaT stays authoritative there (that's what
  it's for). `ECMeeusDeltaT` stays as-is (test-covered historical
  reference).
- The scraped `eclipse-data.json` — its UT instants come from NASA, not from
  our ΔT; data does not regenerate for this change.

## 5. Blast radius — expected test movement (this time there IS some)

Unlike the topocentric fix, this changes *every* astronomical output at
modern display times, so:

- **Golden regressions** (546/face × 16 faces): reference times are
  2024–2025 and 2000 (scenarios.ts:40–46). At 2024/2025 refs ΔT moves
  −4.7 to −5.3 s → Moon-derived angles shift ~2.5–3″ (~1.3e-5 rad), Sun
  ~1″; at the 2000 ref only −0.32 s. Civil-time hands don't move at all (ΔT
  never touches displayed time). Expect a broad, *uniformly microscopic*
  re-baseline: eyeball the diff distribution first (every delta should be
  ≲1e-4 rad; anything larger means a real bug), then `CAPTURE=1` re-capture.
  No reference time sits near an eclipse-kind or rise/set boundary flip
  (checked against the 2024–2025 eclipse dates).
- **willmann-bell.test.ts** — unaffected by construction: its book-value
  cases build TDT directly with a local ΔT copy (willmann-bell.test.ts:49,
  91–94).
- **es-astro.test.ts** ΔT-function tests — unaffected (they pin
  `ECMeeusDeltaT`/`espenakDeltaT` themselves, which don't change).
- **eclipse-data.test.ts** (115-row cross-check) — margins move ≤3″. The
  tightest post-topocentric-fix margin (2020 Jun 21 annular, ~4.7″) moves by
  ~1.3″ (2020's ΔT error is only 2.4 s). Everything should hold; a kind flip
  here means the implementation is wrong, not the data.
- **eclipse.test.ts** (2026 events, 10° thresholds) — trivially safe.

## 6. Acceptance criteria

- `deltaT` (the value cached in `tdtCenturiesDeltaT`) equals exactly 69.184 s
  for any 2017–present instant; 42.184 s for 1972-01-02; the 27-entry table
  sums to 37 − 10.
- **Mid-table epochs (Steve, 2026-08-18)** — dates with nonzero but
  non-final leap counts, pinned as exact equalities:
  1976-06-15 → TAI−UTC = 15, ΔT = **47.184 s**; 1995-06-15 → TAI−UTC = 29,
  ΔT = **61.184 s**. (Sanity context, not asserted: espenakDeltaT gives
  60.80 s for 1995 — the ≤1 s agreement pre-2005 confirms the epoch
  conversion isn't off by a leap-count.)
- **Cross-validation of the iOS table itself**: diff the generated table
  entry-for-entry (transition instants *and* cumulative values, converted to
  a common representation) against
  `.estime-ref/src/ESLeapSecond.cpp:16–44` — the 2016 Wikipedia-scraped
  table shipping in the iOS products. Expected: identical. Any mismatch is
  a *finding to report to Steve* (the canonical IERS list wins, and iOS
  would need the correction too); this criterion exists as much to audit
  the shipped iOS data as the new port.
- Continuity: no jump larger than 0.1 s anywhere except the single leap-step
  seconds themselves; the Q1 rejoin is continuous at `kECLeapTableValidUntil`.
- Full suite green after the golden re-baseline; the re-baseline diff
  audited as uniformly microscopic (§5).
- **The real proof**: re-run the Horizons pilot rows (precision plan §2a) —
  the 2026-08-12 separation residual should collapse from −1.5″ to the
  ±0.5″ band the other rows already show. The full harness then formally
  documents it.

## 7. iOS parity

Same posture as the topocentric plan §6: this deliberately diverges from
`ECAstronomy.m` until Steve mirrors it (using `ESLeapSecond`, which iOS
already links — the wiring he originally intended). Note in
docs/astronomy.md alongside the topocentric divergence note, and flag
`ECAstronomy.m:199` in the commit message.

## 8. Coordination & sequencing

1. Topocentric-sizes session lands (in flight).
2. **This plan** (fresh session). Goldens re-baseline happens here, so
   attribution stays clean — do not interleave with other engine work.
3. Horizons harness session — now doubles as independent verification of
   both engine fixes; its ≤1″ acceptance bar becomes realistic.
4. Eclipse Table phase 2–3 + final data regeneration.

Working-tree note: Eclipse Table phase 1 (4 untracked files) and the
planning docs may still be uncommitted — same rule as the topocentric plan's
note: leave them, don't fold them into this work.
`src/__tests__/eclipse-data.test.ts` is again the safety net; it must pass
unmodified before and after this change.

## 9. Commit breakdown (Steve owns every commit)

1. `scripts/update-leap-seconds.mjs` + generated `es-leap-second.ts`
   (table + accessor + unit test: table integrity vs known epochs — 10 s at
   1972, 37 s at 2017 —, boundary values, expiry constant parses) + the
   build.sh preflight warning — no behavior change yet, suite untouched.
2. `convertUTtoET` switchover + Q1 rejoin policy + docs/astronomy.md note +
   golden re-baseline (audited) — the behavior commit.
3. (with the harness session, not here) Horizons re-run demonstrating the
   2026 residual collapse.

## 10. Outcome (2026-08-18)

Implemented as planned, with one deviation from §5/§8 recorded below.

**Confirmed by construction**
- ΔT is exactly 69.184 s for any 2017-present instant; 42.184 s at
  1972-01-02; 47.184 s at 1976-06-15 and 61.184 s at 1995-06-15 (the
  mid-table epochs). Continuity swept at 6-hour steps from 1970 to 2400:
  exactly 27 one-second steps, nothing else above 0.1 s, and the rejoin at
  `kECLeapTableValidUntil` (2027-06-28, from the source file's `#@`) is
  continuous.
- **iOS cross-check clean.** The generated table matches
  `.estime-ref/src/ESLeapSecond.cpp` on all 27 transitions — instants,
  per-step and cumulative counts. The 2016 Wikipedia scrape was right;
  nothing to report against the shipped iOS data. (The updater re-runs this
  check automatically whenever `.estime-ref` is present.)
- The `#h` SHA-1 in leap-seconds.list is verified at generation time, not
  just noted — it covers every number in the file, so a match proves the
  parse is complete and untranscribed.

**Golden re-baseline, audited (§5)** — 45 snapshot files, 3.3 M numeric
leaves, no structural changes. The distribution is *not* uniformly ≲1e-4 rad
as §5 predicted, and the reason is benign: every part exceeding that is a
rise/set **time** hand, where a few seconds of event time is amplified by the
dial. Max angle delta 6.98e-3 rad = 24.00 arcmin exactly = 4 s on a
60-minute dial (`set min`, `mset min`, `nxt rs mn`, `nxt mrs mn`), with the
matching hour hands at exactly 1/12 of that. All 51 other part names —
every position angle, sun, moon, planets, terminator — stay under 1e-4 rad,
as predicted. 153 `angleAnimating` flips are float-equality artifacts at the
1e-10 level. No delta ≥ 1e-2 anywhere.

**Independent evidence the fix is right**, without waiting for Horizons:
replaying NASA's own published instants of greatest eclipse, every row inside
the leap era moved *closer* to concentric — 2013 Nov 03 0.74″→0.32″,
2016 Sep 01 1.70″→0.88″, 2017 Feb 26 1.03″→0.58″, 2020 Jun 21 0.89″→0.47″,
2023 Apr 20 1.57″→0.76″.

**Deviation from §8 — eclipse-data.test.ts did not pass unmodified.** §5
expected margins to move ≤3″ and hold; one row flipped, and the cause is not
an implementation error:

- 2032 May 09 is the narrowest annular in the 115-row set — NASA magnitude
  0.9957, 44 km path, annularity lasting **22 seconds** — leaving the
  `separation < sunRadius − moonRadius` test just 3.17″ of room (next
  tightest 4.75″, typical 15–30″).
- Its published UT is `TD − 79 s` (NASA's Espenak ΔT). Past the table's
  expiry ours is 72.4 s, so we sample 6.8 s before maximum ≈ 2.5″ at the
  ~0.37″/s the discs close at. 0.32″ + 2.5″ = 3.28″, i.e. 0.11″ over.
  The discs and the threshold are unchanged by ΔT; only the phase along the
  track is.
- Resolution (Steve, 2026-08-18): a narrow date-keyed exemption
  (`EPOCH_AMBIGUOUS`) asserting concentricity, with a rot guard so a stale
  key fails rather than silently excusing a row. The real fix — carry NASA's
  per-row ΔT in eclipse-data.json and replay at `TD − ourΔT`, which *deletes*
  the exemption and strengthens the test — is recorded for the Eclipse Table
  session in
  [2026-08-16-eclipse-table-page.md §9a](2026-08-16-eclipse-table-page.md),
  its §14 risks, and the scrape-eclipses.mjs header. The same staleness
  affects that page's post-2027 **deep links**.

**Not done here**: §6's Horizons re-run, which belongs to the harness session
([2026-08-17-eclipse-precision-and-verification.md](2026-08-17-eclipse-precision-and-verification.md)).
