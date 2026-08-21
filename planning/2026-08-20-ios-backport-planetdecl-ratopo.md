# iOS fix: planetDecl poisons the RA-topo cache slot

**Status**: proposed — **for a fresh session**. Read
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
which handles the same slot correctly. All line numbers below are as of the
topocentric commits (esastro `eb077b4`, Chronometer `f4c7128`).

## 1. The anomaly (mechanism verified 2026-08-20)

`topocentricParallax` returns a topocentric **hour angle** (`Hprime`) and
declination. A caller that wants the topocentric **RA** must convert:
`RA′ = lst − Hprime`, normalized to [0, 2π). The two writers of
`planetRATopoSlotIndex` disagree about this:

- `ESAstronomyManager::planetRA(int, bool)` (ESAstronomy.cpp:3794, cached
  variant): converts (:3846–3849) and caches the true topocentric RA
  (:3854–3856). **Correct.**
- `ESAstronomyManager::planetDecl(int, bool)` (:3906): passes
  `&planetTopoRightAscension` as the **Hprime out-param** (:3954–3955) — the
  variable receives a raw hour angle despite its name — and caches it into
  `planetRATopoSlotIndex` with no conversion (:3958–3960). **Wrong.** The
  declination it returns is fine; only the RA slot it writes as a side
  effect is poisoned.

The reader: `planetRA(…, correctForParallax=true)` returns the slot value
directly on a cache hit (:3803–3805). So if `planetDecl(n, true)` runs
before `planetRA(n, true)` **within one cache generation** (same
`currentFlag`; date within `ASTRO_SLOP` = 2 s, ESAstronomyCache.hpp:507),
the returned "RA" is actually the topocentric hour angle — a
plausible-looking angle that is wildly wrong and drifts with sidereal time.
If `planetRA(n, true)` runs first, it validates both topo slots itself and
`planetDecl` takes its cache-hit path, never reaching the buggy writer.

The ObjC duplicate has the identical pattern: `ECAstronomy.m`
`planetRA:correctForParallax:` (:3460, converts correctly) vs
`planetDecl:correctForParallax:` (:3531, caches the raw out-param at
:3577–3585).

## 2. Reachability — what is already known

Surveyed 2026-08-20 across all three repos:

- **Watch-face expression VM** (`Chronometer/ECVirtualMachineOps.m:1903,
  1925`): exposes only `correctForParallax:false`. Watch faces cannot hit
  this.
- **esastro internal callers** and **all Observatory callers**
  (EOHandView.mm, EOMoonAgeView.mm): every call passes `false`.
- **ECAstronomy.m internal**: no `correctForParallax:true` calls.
- **The only `true` call sites in shipping code**:
  `Chronometer/Classes/ECOptionsData.m` — three paired RA/Decl sites
  (:629/:633, :761/:765, :903/:907), the Data panel that displays planet
  RA and declination.

**Resolved 2026-08-20: `ECOptionsData` is dead code.** The main project
lists every source explicitly (1138 `PBXBuildFile` entries, no synced
groups; siblings like `ECOptions.m`/`ECBackgroundData.m` appear 16× each
across targets) and `ECOptionsData` appears **zero** times — in the main
project and in `test/VMTest.xcodeproj`. Nothing imports its header or
names the class. `git log -S ECOptionsData` on the pbxproj is empty across
the repo's entire GitHub history, and the file itself has only the initial
import commit — it arrived already orphaned. Provenance: created
Feb 2010 (Bill Arnett); `ECBackgroundData` was "Created … 4/13/2010 from
ECOptionsData" and superseded it (and calls no parallax-true variants).

**Conclusion: the poisoning is unreachable in the shipping apps — a latent
booby trap, not a live bug.** Note the trap lives in `planetDecl` itself
(both astronomy files), not in the dead caller: any *future*
parallax-corrected caller re-arms it, and deleting `ECOptionsData.{h,m}`
would remove today's only would-be trigger but not the trap. This drops
the priority to lowest; the commit message should say "latent".

## 3. The fix (the bug is genuine but latent — Steve decides if/when it is worth landing)

In `planetDecl`'s parallax branch, in **both** files, either:

1. **Mirror `planetRA`** (preferred — symmetric, keeps the slot warm):
   rename the local to `planetTopoHourAngle`, convert
   `planetTopoRightAscension = lst - planetTopoHourAngle` with the same
   `< 0 ? += 2π` normalization `planetRA` uses (:3846–3849 is the model),
   and cache the converted value. `lst` is already in scope.
2. **Minimal**: stop writing the RA-topo slot from `planetDecl` entirely
   (write only `planetDeclTopoSlotIndex`). Smaller diff, no duplicated
   conversion; costs one recompute if Decl is queried before RA.

Steve picks; option 1 matches the file's existing shape best. Everything
else — including the misleading variable name in the *correct* function's
`atTime` variant — stays untouched.

## 4. Order and scope

- Independent of the ΔT and horizon back-ports; land whenever.
- Repos touched: **esastro, Chronometer**. Observatory only consumes; no
  change there. **No web-side change** — the web engine has no such slot.
- Change nothing else: no renames beyond the one local, no cache
  refactoring.

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
new parallax-true caller has appeared since 2026-08-20).

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
