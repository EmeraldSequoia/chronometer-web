# iOS back-port: Observatory eclipse-simulator horizon indicator

**Status**: **implemented in the clones 2026-08-20** (§7 — Observatory
plus a small esastro header move Steve requested); committed by Steve
(Observatory `1f0bf05`, esastro `cec5f1c`) and pushed to the `transfer`
bare repos. Originally: proposed — **for
a fresh session**. Read
[docs/ios-backports.md](../docs/ios-backports.md) first (workflow: edit
`ios-backports/` clones only, never commit, Steve pushes outside the VM).
Independent of the other two back-ports (different repos); can run any
time.
**Created**: 2026-08-19
**Web spec**: commit **f5c7a75** ("[Observatory] Draw eclipse horizon at
apparent, fix caption") — `git show f5c7a75`. Design and the fixture table:
[2026-08-18-eclipse-horizon-indicator.md](2026-08-18-eclipse-horizon-indicator.md).

## 1. The bug (recap)

The eclipse simulator's green below-horizon wash sits at the *geometric*
horizon (no refraction), and the "Below horizon" caption appears whenever
the Sun/Moon midpoint's geometric altitude < 0. Consequences: a Sun at
−0.27° true altitude — actually fully visible, tangent on the horizon —
draws fully washed with the caption up, and the caption disagrees with the
eclipse-kind classification (Basel's convention, −(34′ refraction + SD))
across a 0.83° band that greatest-eclipse points hit constantly (partials
peak on the terminator by construction). Steve confirmed and the web fixed
it 2026-08-18.

## 2. The fix (two lines of substance, from the web)

1. **Wash position**: draw at the *apparent* horizon —
   `horizonPixelY = -(avgAlt + refractionAtHorizon) * pixelsPerAngularRadian`
   where `refractionAtHorizon` is the engine's existing 34′ constant
   (**not** an altitude-dependent formula — the web tried and rejected
   that: it disagrees with the engine's own rise/set convention by ~3′
   exactly at the caption-flip altitude, recreating sliver mismatches; see
   web plan §3a/§6).
2. **Caption**: show iff the eclipse kind is `SolarNotUp`/`LunarNotUp` —
   the same classification Basel renders — instead of `horizonPixelY > 0`.
   Exact cross-app agreement by construction; the wash keeps its
   independent life (it may cover part of a disc with no caption — that's
   the point).

Consistency at the flip is automatic: kind goes NotUp at true alt
−(34′+SD) ⇔ apparent center = −SD ⇔ the wash has just closed over the top
limb.

## 3. Where it lives on iOS (verified in the clones, 2026-08-19)

One target (the OpenGL-era variant is a historical artifact — no
back-ports to it, per Steve 2026-08-19; its clone was removed from
ios-backports/):

- `ios-backports/Observatory/Classes/EOEclipseView.mm` (GitHub `main`):
  `horizonPixelY = -avgAlt * …` assignments in the solar and lunar branches
  (there are two — both get the refraction term), and the fill/label block
  at ~:292–308 (`if (drawingSomething && horizonPixelY > -h/2) { …
  horizonPixelY > 0 → horizonLabel }`).

Find the iOS constant for horizon refraction (the web's
`kECRefractionAtHorizonX` = (34/60)·π/180 was ported *from* this code
family — grep esastro/Chronometer for the original name) and the in-view
eclipse-kind value (the view already branches on `ECEclipseTotalSolar` and
manages `statusLabel`/`horizonLabel`, so the kind is at hand). Match each
file's local style (tabs, C-style comments).

## 4. Validation inside the VM (no Xcode here)

- `clang -fsyntax-only` where includes resolve (ObjC++ — may need
  `-x objective-c++` and framework stubs; if it won't resolve, careful
  review against `git show f5c7a75` is the fallback, stated plainly).
- **Fixture table** (Sun SD ≈ 0.27°; verified on the web, unit-tested
  there):

  | true center alt | apparent | wash | caption |
  |---|---|---|---|
  | −0.202° | +0.365° | disc fully visible, ~0.1° gap below | off |
  | −0.274° | +0.293° | fully visible, bottom limb ~1′ above wash | off |
  | −0.567° | 0 | half covered | off |
  | −0.838° | −SD | wash just closes over top limb | flips on |
  | −1.5° | −0.93° | fully washed | on |

- On-device verification is Steve's (outside the VM): the 2011 Jan 04 and
  2014 Apr 29 rows of the web Eclipse Table are the canonical
  before/after cases (full green + caption before; visible Sun on the
  horizon, no caption after).

## 5. Explicitly not changing

- No altitude-dependent refraction; no changes to `calculateEclipse` or
  the kind thresholds (that's the topocentric/ΔT back-ports' territory);
  no layout/color changes to the wash or labels beyond position/gating.

## 6. Report format

Per docs/ios-backports.md: dirty tree + diff + verified/unverified list.
Steve commits, copies out, pushes to GitHub.

## 7. Implementation notes (2026-08-20)

Done in `ios-backports/Observatory/Classes/EOEclipseView.mm` plus, at
Steve's direction, a constant move in `ios-backports/esastro`; both trees
left dirty. The edits:

- **esastro**: `kECRefractionAtHorizonX` moved from its file-local
  `#define` in `ESAstronomy.cpp` (:37) into `ESAstronomy.hpp`, so view
  code shares the engine's convention instead of defining its own copy
  (the invariant: one copy per engine implementation, no consumer-side
  copies; `ECAstronomy.m`'s copy stays — deliberate parallel engine).
  Note `ECConstants.h` was considered and rejected as the home: the
  `ESAstroConstants.hpp` shim's `EC_CONSTANTS` guard skips it in any app
  (like Observatory) whose own `Constants.h` defined that guard first, so
  a constant there is invisible exactly where it's needed.
- **Observatory**: both `horizonPixelY` assignments (solar :150,
  lunar :210) lift `avgAlt` by the constant (which arrives via the
  existing `ESAstronomy.hpp` import).
- **Observatory**: the label if/else was pulled out of the fill block:
  fill keeps its pixel-position condition; caption is now
  `drawingSomething && (eclipseKind == ECEclipseSolarNotUp || eclipseKind
  == ECEclipseLunarNotUp)`. The old fill-else became the caption's else,
  so the not-drawing label states are unchanged.

**Verified in-VM**: the §4 fixture table replayed through the exact edited
expression, in a scratch harness compiled against the real
`ESAstronomy.hpp` (stubbing only the two esutil headers absent from the
clones, `ESUserString.hpp`/`ESPlatform.h`) — all five rows, the
wash-coverage geometry, the caption gate per kind, and the −0.838° flip
identity all pass. A second TU shaped exactly like EOEclipseView.mm's
(Observatory's own `Constants.h` first, then `ESAstronomy.hpp`, so the
`EC_CONSTANTS` guard skips esastro's `ECConstants.h`) compiles and
evaluates both edited expressions — proving the moved macro is visible in
the view's actual include context. Enum values (SolarNotUp=2,
LunarNotUp=6) match between esastro's `ECConstants.h` and Observatory's
own `Constants.h` copy; the edit site already used `ECEclipseTotalSolar`,
so the enum's availability is proven by the existing build. The engine's
own use at `ESAstronomy.cpp:1342` still resolves: the .cpp includes
`ESAstronomy.hpp` (line 13) ahead of it.

**Not verifiable in-VM**: full `clang -fsyntax-only` of the .mm (UIKit —
no iOS SDK here; fails at `#import <UIKit/UIKit.h>` before reaching the
edits) and any runtime rendering. Steve's Xcode build + the §4 on-device
cases (2011 Jan 04, 2014 Apr 29) are the closing gate.
