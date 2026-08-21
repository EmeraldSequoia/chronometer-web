# iOS fix: planetDecl poisons the RA-topo cache slot

**Status**: **done — committed and pushed to `transfer` 2026-08-21**
(§7 — fix option 1 in both engines plus the `ECOptionsData.m` comment
flags; validated including a live cache-interleaving before/after test).
Steve committed esastro `0a6023b` and Chronometer `beed32a`, both at
`transfer` main; awaiting only the batched outside GitHub push and
on-device testing. Originally: proposed — for a fresh session. Read
[docs/ios-backports.md](../docs/ios-backports.md) first; it defines the
workflow (edit `ios-backports/` clones only, never commit, Steve pushes from
outside the VM).
**Created**: 2026-08-20
**Origin**: noticed in passing during the topocentric back-port's
adversarial review
([2026-08-19-ios-backport-topocentric.md](2026-08-19-ios-backport-topocentric.md)),
deliberately left untouched there. **This is not a web port**: chronometer-web
restructured this code and has no RA-topo cache slot at all (verified —
`es-astro.ts` is unaffected). The spec is the sibling function `planetRA`,
which handles the same slot correctly. All line numbers below were
re-verified 2026-08-21 against the current clone HEADs (esastro
`cec5f1c`, Chronometer `22c11fc`); if more commits have landed since,
re-grep rather than trusting them.

## 1. The anomaly (mechanism verified 2026-08-20, re-verified 2026-08-21)

`topocentricParallax` (ESAstronomy.cpp:585–612; ECAstronomy.m:656–683)
returns a topocentric **hour angle** (`Hprime`, already normalized to
[0, 2π)) and declination. A caller that wants the topocentric **RA** must
convert: `RA′ = lst − Hprime`, normalized to [0, 2π). The two writers of
`planetRATopoSlotIndex` disagree about this:

- `ESAstronomyManager::planetRA(int, bool)` (ESAstronomy.cpp:3843, cached
  variant): declares all three locals (`planetTopoRightAscension`,
  `planetTopoDeclination`, `planetTopoHourAngle`, :3891–3893), aims the
  Hprime out-param at the hour-angle local (:3894–3895), converts
  (:3896–3899) and caches the true topocentric RA (:3902–3907).
  **Correct.**
- `ESAstronomyManager::planetDecl(int, bool)` (:3956): declares **no
  hour-angle local at all** — it passes `&planetTopoRightAscension` as the
  **Hprime out-param** (:4004–4005), so the variable receives a raw
  topocentric hour angle despite its name, and caches it into
  `planetRATopoSlotIndex` with no conversion (:4006–4011). **Wrong.** The
  declination it returns is fine; only the RA slot it writes as a side
  effect is poisoned.

To be precise about what the poisoned value *is* (a 2026-08-21 question
from Steve): it is not geocentric RA under another name — it is the
topocentric hour angle, a genuinely different quantity that happens to
have angle-like magnitude. And the RA-topo slot is not vestigial: it is
declared (ESAstronomyCache.hpp:449–458; ECAstronomyCache.h:339–348) and
`planetRA` both reads it on cache hit and writes it correctly. The sense
in which "the slot is never used" *is* true: no shipping code ever
reaches the parallax-true path of either reader (§2), so the entire
topo-slot machinery — both slots, both writers — is exercised only by
dead code.

The reader: `planetRA(…, correctForParallax=true)` returns the slot value
directly on a cache hit (:3853–3855). So if `planetDecl(n, true)` runs
before `planetRA(n, true)` **within one cache generation** (same
`currentFlag`; date within `ASTRO_SLOP` = 2 s for the main cache,
ESAstronomyCache.hpp:507–508),
the returned "RA" is actually the topocentric hour angle — a
plausible-looking angle that is wildly wrong and drifts with sidereal time.
The cache-hit return also bypasses `planetRA`'s own `ESAssert` (:3887,
miss-path only), so even debug builds would not catch it.
If `planetRA(n, true)` runs first, it validates both topo slots itself and
`planetDecl` takes its cache-hit path, never reaching the buggy writer.

The ObjC duplicate has the identical pattern: `ECAstronomy.m`
`planetRA:correctForParallax:` (:3577, converts at :3628–3631, caches at
:3634–3639) vs `planetDecl:correctForParallax:` (:3648, no hour-angle
local, caches the raw out-param at :3697–3702).

Nothing else shares the bug (checked 2026-08-21): the C++ `planetRA`
`atTime` variant (:3916–3953) is correctly named, converts, and **does not
cache** (it only pushes the refinement cache around
`WB_planetApparentPosition`); there is no `planetDecl` `atTime` variant in
either language, and ObjC has no `planetRA` `atTime` variant at all. The
static `planetAltAz` helper in both engines handles Hprime correctly and
never touches the topo RA/Decl slots.

### Provenance (git archaeology, 2026-08-21)

Both clones' histories begin with the 2023 GitHub bulk imports (esastro
`255e988`, 2023-11-18; Chronometer `ef862e5`, 2023-12-03). In those very
first snapshots `planetRA` already converts and `planetDecl` already
caches the raw hour angle; no later commit ever touched the asymmetry.
(The topocentric back-port came closest: `f4c7128` appended a `NULL`
`distanceRatio` argument to the two ObjC calls without changing which
variable receives Hprime, and `eb077b4` left the C++ `planetRA`/
`planetDecl` calls entirely untouched — C++ defaults the new parameter.)
`git log -S
'correctForParallax'` shows no call site was ever added or removed after
the imports, and `ECOptionsData.m` has only its import commit. So within
available history the branch was **born wrong** — there is no
"fix-that-missed-planetDecl" commit to point to. Whether such an event
happened in the pre-GitHub VCS is unknowable from these clones; only
Steve's older repositories could say, and the answer wouldn't change the
fix.

## 2. Reachability — what is already known

Surveyed 2026-08-20, re-verified 2026-08-21, across all repos in
`ios-backports/`:

- **Watch-face expression VM** (`Chronometer/ECVirtualMachineOps.m:1903,
  1925` — repo root, not `Classes/`): exposes only
  `correctForParallax:false`. Watch faces cannot hit this.
- **esastro internal callers** (ESAstronomy.cpp:3444–3445, :3455–3456)
  and **all Observatory callers** (EOHandView.mm, EOMoonAgeView.mm):
  every call passes `false`.
- **ECAstronomy.m internal**: no `correctForParallax:true` calls (its
  only planetRA:/planetDecl: sites, :3211–3222, pass `false`).
- **The only `true` call sites in shipping code**:
  `Chronometer/Classes/ECOptionsData.m` — three paired RA/Decl sites
  (:629/:633, :761/:765, :903/:907), the Data panel that displays planet
  RA and declination.

Grep hazard for whoever re-checks: both engines contain many
`true/*correctForParallax*/` hits (e.g. ESAstronomy.cpp:3752–3808,
ECAstronomy.m:3506–3546) — those are calls to the **static `planetAltAz`
helper**, a separate, correctly implemented path that never touches the
topo RA/Decl slots. Only `planetRA`/`planetDecl` calls with the flag
matter here. (Spelling note: the flag literals are lowercase
`true`/`false` everywhere, never `YES`/`NO` — `-S 'correctForParallax:YES'`
finds nothing for that reason alone.)

**Resolved 2026-08-20: `ECOptionsData` is dead code.** The main project
lists every source explicitly (1136 `PBXBuildFile` entries, no synced
groups; siblings like `ECOptions.m`/`ECBackgroundData.m` appear 16× each
across targets) and `ECOptionsData` appears **zero** times — in the main
project and in `test/VMTest.xcodeproj`. Nothing imports its header or
names the class. `git log -S ECOptionsData` on the pbxproj is empty across
the repo's entire GitHub history, and the file itself has only the initial
import commit — it arrived already orphaned. Provenance: created
Feb 2010 (Bill Arnett); `ECBackgroundData` was "Created … 4/13/2010 from
ECOptionsData" and superseded it (and calls no parallax-true variants).

**Intent resolved 2026-08-21** (a question from Steve: could the
hour-angle caching have been intended?): No. `ECOptionsData` is the
in-app "Astro Data" reference panels (per-body table views on a 1 s
refresh timer); all three paired sites feed `cell.detailTextLabel` rows
labeled literally **"Right Ascension"** / **"Declination"**, formatted by
`formatRA:` (:222, sexagesimal hours, `assert(radians >= 0)` at :223) and
`formatAngle:` (degrees). No row anywhere in the file wants an hour
angle, and nothing ever subtracts the value from LST. The successor
`ECBackgroundData.m` contains **zero** astronomy calls — the April 2010
rewrite dropped the per-body astro panels wholesale rather than
simplifying them, which is how the only parallax-true consumers went
dead. Had the panels shipped: within one top-to-bottom render the RA row
(lower index) computes first and seeds the slot correctly, but any
render where the Decl row hit a fresh cache generation before the RA row
(RA row scrolled off-screen, or out-of-order cell building) would have
displayed an hour angle as "Right Ascension" — **silently**, since
`topocentricParallax` pre-normalizes Hprime to [0, 2π), so even
`formatRA:`'s assert would pass. A bug, not a feature — and one that
live use would likely have surfaced quickly.

**Conclusion: the poisoning is unreachable in the shipping apps — a latent
booby trap, not a live bug.** Note the trap lives in `planetDecl` itself
(both astronomy files), not in the dead caller: any *future*
parallax-corrected caller re-arms it, and deleting `ECOptionsData.{h,m}`
would remove today's only would-be trigger but not the trap. This drops
the priority to lowest; the commit message should say "latent".

## 3. The fix (the bug is genuine but latent — Steve decides if/when it is worth landing)

In `planetDecl`'s parallax branch, in **both** files, either:

1. **Mirror `planetRA`** (preferred — symmetric, keeps the slot warm):
   declare the same three locals `planetRA` uses (add the missing
   `planetTopoHourAngle`, aim the Hprime out-param at it), convert
   `planetTopoRightAscension = lst - planetTopoHourAngle` with the same
   `< 0 ? += 2π` normalization (ESAstronomy.cpp:3891–3899 /
   ECAstronomy.m:3623–3631 are the models), and cache the converted
   value. `lst` is already in scope.
2. **Minimal**: stop writing the RA-topo slot from `planetDecl` entirely
   (write only `planetDeclTopoSlotIndex`). Smaller diff, no duplicated
   conversion; costs one recompute if Decl is queried before RA.

Steve picks; option 1 matches the file's existing shape best. The
provenance finding (§1) cuts both ways here: there is no historical
"correct planetDecl" to restore, so neither option is more faithful to
an original — option 1 is preferred purely because it makes the two
writers of the slot agree. Everything else stays untouched (the earlier
draft of this plan claimed a misleading variable name in `planetRA`'s
`atTime` variant — re-verification found no such thing; that variant is
correctly named, non-caching, and C++-only, §1).

**Additionally (Steve, 2026-08-21): flag the calls in `ECOptionsData.m`.**
The file is untested dead code that a future reader might revive or use
as a model. Add a short comment block after the file's header comment,
written for the world where the fix has long since shipped — it does
**not** mention the bug (Steve's call, 2026-08-21: the flag's lasting
value is the dead-code/never-tested warning; his question was only
whether the file wanted something other than what was supplied, and it
didn't, §2). State: (a) the file is in **no target** — orphaned since
the April 2010 `ECBackgroundData` rewrite; (b) its six
`correctForParallax:true` calls are the only ones in the app and have
**never run in a shipping build** — treat them as untested. Then a
one-line pointer to that block at each of the three paired sites
(:629/:633, :761/:765, :903/:907). Chronometer only; match the file's
comment style; change no code in that file.

## 4. Order and scope

- Independent of the ΔT and horizon back-ports; land whenever.
- Repos touched: **esastro, Chronometer** (Chronometer twice over: the
  `ECAstronomy.m` fix and the §3 `ECOptionsData.m` comment flags).
  Observatory only consumes; no change there. **No web-side change** —
  the web engine has no such slot.
- Change nothing else: no renames or declarations beyond §3 option 1's
  locals, no cache refactoring; the only non-engine edit is the §3
  comment block in `ECOptionsData.m`.

## 5. Validation inside the VM (no Xcode here)

- The strongest available checks are inspection plus compile: the
  topocentric session's host-side harness compiles the real
  `ESAstronomy.cpp` end-to-end (recipe in the appendix), and
  `ECAstronomy.m` passes a host `clang -fsyntax-only` with
  `-include Foundation/Foundation.h` and `-I` paths for Classes, esastro
  src, Calendar, Parser, and Willmann-Bell.
- A numeric check of the conversion itself is easy in that harness TU
  (`lst − Hprime` vs the static `topocentricParallax` outputs). The *cache
  interleaving* needs a live `ESAstronomyManager` + cache pool; that
  *might* be feasible host-side — `ESTimeLocAstroEnvironment.cpp` is in
  esastro, and its ESWatchTime/ESLocation dependencies are real sources in
  the estime/eslocation clones — but expect a fight with platform code;
  try it, and fall back to inspection + compile without guilt.
- There is **no live UI test**: the only caller is dead code (§2), so no
  screen in the shipping apps exercises the parallax-true path. A
  before/after on-device check would require temporarily wiring
  `ECOptionsData` (or a scratch caller) into a target — Steve's call
  whether that is worth it for a latent fix; the interleaving unit test
  above is the honest substitute.

## 6. Report format

Per docs/ios-backports.md: leave working trees dirty, show
`git -C ios-backports/<repo> diff` per repo, state which fix option (§3)
was taken and what was verified (§5), and re-confirm §2 still holds (no
new parallax-true caller has appeared since the 2026-08-21 re-check).

Also print a **suggested commit message for each repo touched** (esastro
and Chronometer may share one), written for Steve to use when he commits.
It should describe the mechanism in one or two sentences (hour angle
cached where topocentric RA belongs), name the fix option taken, mention
the `ECOptionsData.m` comment flags in the Chronometer message (§3), and
say **"latent"** — no shipping caller reaches the parallax-true path
(§2).
Printing the message is where the session stops: it does **not** run
`git commit` (or push) anywhere — Steve owns every commit
(docs/ios-backports.md).

## 7. Implementation report (2026-08-21)

Fix **option 1** (§3) taken in both engines, plus the §3
`ECOptionsData.m` comment flags. Working trees left dirty: esastro
`src/ESAstronomy.cpp` (+6/−1), Chronometer `Classes/ECAstronomy.m`
(+6/−1) and `Classes/ECOptionsData.m` (comments only). The fixed
`planetDecl` block is textually identical to `planetRA`'s model block
except the pre-existing `0/*observerAltitude*/` vs
`0/*_observerAltitude*/` comment-spelling difference (left as found).

Validated (§5):

- **Compile gate**: the appendix harness compiles and links the edited
  `ESAstronomy.cpp` end-to-end with zero warnings (two recipe
  amendments were needed; recorded in the appendix).
- **Conversion numerics**: 11-case spot-check of `RA′ = lst − Hprime`
  via the TU statics, including the +2π branch — RA′ always in
  [0, 2π), decl untouched, RA shifts within horizontal-parallax bounds
  (~1.2e-2 rad at Moon distance, ~7e-6 rad at 1.5 AU).
- **Cache interleaving, live manager** (§5's "real prize" — no
  fallback needed): a `#define private public` harness constructed a
  real `ESAstronomyManager` + cache pool (recipe in the appendix).
  Pre-fix binary (from `git show HEAD:`): decl-then-RA in one
  generation returned the hour angle — equal to `lst − RA′` within
  4.4e-16 — off from a fresh RA by 1.8–3.5 rad (Moon, Mercury, Mars).
  Post-fix binary: decl-then-RA **bit-identical** (diff 0.0) to fresh
  `planetRA`. Decl identical across orderings in both binaries — the
  fix changes only the miscached RA slot.
- **ObjC**: `clang -fsyntax-only -include Foundation/Foundation.h` on
  the edited `ECAstronomy.m` (with `-I` Classes, esastro src, Calendar,
  Parser, and Chronometer's own `Willmann-Bell/` — note: *not*
  esastro's, `ECWillmannBell.h` lives in the Chronometer repo) passes
  with only the four pre-existing warnings. `ECOptionsData.m` imports
  UIKit, so no host syntax check is possible (no iOS SDK in-VM); its
  diff is comment lines only.
- **§2 re-confirmed**: `pull --ff-only` was a no-op in both repos and
  the 2026-08-21 sweep found no new parallax-true caller.

**Committed by Steve 2026-08-21** — esastro `0a6023b`, Chronometer
`beed32a`, both pushed to their `transfer` bare repos — using the
suggested messages below verbatim (kept here as the record):

esastro:

```
Fix latent planetDecl cache poisoning of the topocentric-RA slot

planetDecl(planetNumber, correctForParallax = true) passed its
planetTopoRightAscension local as topocentricParallax's Hprime
out-param and cached the resulting raw topocentric hour angle into
planetRATopoSlotIndex, so a later planetRA(..., true) in the same
cache generation returned an hour angle as the RA.  Mirror planetRA:
receive Hprime into planetTopoHourAngle, convert
RA' = lst - Hprime (normalized to [0, 2pi)), and cache that.

Latent, not live: nothing in the shipping apps calls these with
correctForParallax = true.  Verified with a host-side harness: with
decl computed before RA in one cache generation, the returned "RA"
formerly equaled the hour angle (lst - RA' to 4e-16) and now matches
a fresh computation bit-for-bit.
```

Chronometer:

```
Fix latent planetDecl cache poisoning of the topocentric-RA slot

[planetDecl:... correctForParallax:true] passed its
planetTopoRightAscension local as topocentricParallax's Hprime
out-param and cached the resulting raw topocentric hour angle into
planetRATopoSlotIndex, so a later [planetRA:... :true] in the same
cache generation returned an hour angle as the RA.  Mirror planetRA:
receive Hprime into planetTopoHourAngle, convert
RA' = lst - Hprime (normalized to [0, 2pi)), and cache that.

Latent, not live: nothing that ships calls these with
correctForParallax:true; the only caller ever written,
ECOptionsData.m, has been in no target since April 2010.  Also add
comments there noting the file is orphaned and its parallax-true
paths have never run in a shipping build.  Same fix as esastro's
ESAstronomy.cpp, where a host-side harness verified the before/after
cache behavior.
```

## Appendix: host-side esastro harness recipe (from the topocentric session)

Reusable for any esastro numeric validation (the ΔT back-port will want
it). The esutil repo is absent in-VM, so stub what it provides; everything
else is real code.

- A scratch `main.cpp` does `#include ASTRO_CPP` (the real
  `src/ESAstronomy.cpp`, path via `-D`), making the file's statics
  (`calculateEclipse`, `topocentricParallax`, …) directly callable in one
  TU.
- Stub headers in a scratch `stub/` dir, listed **last** in the include
  path so real headers win: `ESPlatform.h` (`ES_OPAQUE_OBJC(name)` typedef
  macro), `ESUtil.hpp` (`ESUtil::fmod` = positive fmod
  `a - floor(a/b)*b`, byte-identical to the real esutil implementation;
  `nansEqual`; `stringWithFormat` declaration), `ESErrorReporter.hpp`
  (`ESAssert` + no-op `logInfo`/`logError`), `ESUserString.hpp` (thin
  `std::string` wrapper + `ESLocalizedString` macro), `ESThread.hpp`
  (`inMainThread()` → true).
- Compile and link:
  `clang++ -std=gnu++14 -O1 -DASTRO_CPP='"…/esastro/src/ESAstronomy.cpp"'
  -I esastro/src -I esastro/Willmann-Bell -I estime/src -I eslocation/src
  -I stub main.cpp Willmann-Bell/ESWillmannBell.cpp
  src/ESAstronomyCache.cpp estime/src/ESCalendar.cpp
  -Wl,-undefined,dynamic_lookup` — the last flag leaves never-called
  manager dependencies (ESWatchTime, ESLocation, …) unresolved instead of
  stubbing dozens of symbols.
- Call `calculateEclipse(t, lat, lon, …, NULL /*cache*/)` with
  `ESTimeInterval` = Apple-epoch seconds (Unix ms/1000 − 978307200).
- To replay NASA catalog instants (stored as TT): derive UT through the
  engine's **own** ΔT so its internal TT equals NASA's exactly —
  fixed-point iterate `ut = tt − deltaT(ut)` using
  `julianCenturiesSince2000EpochForDateInterval`'s deltaT out-param — the
  same trick as the web's `eclipse-data.test.ts`. Event data:
  chronometer-web `src/help/eclipse-data.json` (115 rows, 2011–2041).
- Before/after comparison: build a second binary from
  `git show HEAD:src/ESAstronomy.cpp` written to a scratch tree with a
  `Willmann-Bell` symlink beside it (the file includes
  `../Willmann-Bell/…`).
- **Amendments from the planetDecl session (2026-08-21)**: add
  `-include ESErrorReporter.hpp` (ESCalendar.cpp uses
  `ESAssert`/`logInfo` without declaring them) and, whenever the
  post-ΔT-backport deltaT path will actually run, link
  `estime/src/ESLeapSecond.cpp` too (`cumulativeLeapSecondsForUTC` is
  called at runtime; its table is compiled in). Also: a **live
  `ESAstronomyManager` is attainable** — `#define private public`
  before the includes in the harness TU (std headers pre-included
  first), construct `ESAstronomyManager(NULL, NULL)` (that ctor only
  zeroes fields), hand-set the private observer/time/cache members,
  and push a real generation with `pushECAstroCacheInPool` on a
  self-owned zeroed `ECAstroCachePool`. Used successfully for the
  planetDecl cache-interleaving test (§7).
