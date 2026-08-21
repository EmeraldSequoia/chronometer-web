# iOS back-port: three one-line Chronometer fixes (MK EOT cadence, MK sunrise anchor, Babylon BCE 1582)

**Status**: **committed and pushed to `transfer` 2026-08-21** — Steve
squashed all three fixes into Chronometer `43e6a8b` (implementation
details §7); the working tree is clean. Remaining, all Steve's, all
outside the VM: copy the Chronometer bare repo out (earlier copies
predate this commit), push to GitHub, run the Henry archive
regeneration for the two XML fixes (the regenerated archives ride in a
follow-on commit, per the commit message — the Babylon code fix is
complete as-is), and test on device. No open questions. Originally:
proposed, reviewed and approved by Steve 2026-08-21 with the §0
questions resolved as noted below.
Read [docs/ios-backports.md](../docs/ios-backports.md) first (workflow: edit
`ios-backports/` clones only, never commit, Steve pushes outside the VM).
All three fixes touch the **Chronometer repo only** — no esastro/estime/
Observatory involvement. Independent of everything else; can run any time.
**Created**: 2026-08-21
**Web specs**: commits **a810ae9** (EOT 30-min updates), **ed0894f**
(sunrise-hand anchor), **409b610** (Babylon BCE 1582) — `git show <sha>`
in chronometer-web.

## 0. Scope questions — resolved by Steve 2026-08-21

1. **Android XML twins**: **include**. Not in production, but they serve
   as models for the web port and may be used again. (`Watches/
   Builtin-Android/Mauna Kea I/Mauna Kea I.xml`; Mauna Loa I has neither
   hand; Android Vienna has no EOT hand.)
2. **Dusk companion nudge**: **include** (Steve had forgotten it was part
   of the web fix). Web values: dusk front 42 → 42.5; the web left
   `dusk n` at 42 — see §7 for the one remaining question.
3. **Archive regeneration**: confirmed — Steve handles the Henry pass
   outside the VM (§4).

## 1. Fix A — MK EOT hand updates every 30 minutes (XML only)

**Bug**: the Mauna Kea EOT hand declares `update='1*days()'`. Near the
solstices (especially winter) EOT changes ~30 s across a day, a visible
jump on large displays when the hand only redraws daily. Web fixed
2026-05-13 (a810ae9).

**iOS edit** — `ios-backports/Chronometer/Watches/Builtin/Mauna Kea/Mauna
Kea.xml:58`, the `Qhand name='EOT'`:

```
update='1*days()'  →  update='30 * minutes()'
```

- `minutes()` is a real iOS VM op (`EBVM_OP0(minutes)`,
  `ECVirtualMachineOps.m:63`) already used by builtin faces (AtlantisIV,
  Geneva), so the expression parses today. The web's update scheduler was
  ported *from* this code, so half-hour-boundary semantics match.
- The web commit also fixed Vienna's EOT hand, but **iOS Vienna.xml has no
  EOT hand** (it was a web-side addition) — verified by grep; nothing to
  do there.
- Not touching the `Qwheel name='dial 24'` (:72), which also uses
  `1 * days()` — the web didn't either.
- Android twin (if in scope, Q1): `Builtin-Android/Mauna Kea I/Mauna Kea
  I.xml:59`, identical edit.

## 2. Fix B — MK sunrise ("dawn") hand anchor (same XML file)

**Bug**: the dawn hand image's `xAnchor='39'` is off by ~1.15 px, so the
indicated sunrise time reads slightly wrong against the 24-hour dial. Web
fixed 2026-04-30 (ed0894f: "Correct minor positioning issue with sunrise
hand"), settling on 37.85; current web XML still carries 37.85 (no later
re-tune).

**iOS edit** — same file, `:65`, the `hand name='dawn'`:

```
xAnchor= '39'  →  xAnchor= '37.85'
```

- iOS has **no night-mode dawn/dusk variants** (web-only addition), so
  this is genuinely one line.
- Explicitly **not** changing dusk (`:67`, 42 → web's 42.5) per scope
  question Q2, and not touching `yAnchor` (web left it at −105).
- Android twin (if in scope, Q1): `Mauna Kea I.xml:64`, identical edit.

## 3. Fix C — Babylon's October 1582 wheel appears in BCE 1582 (code)

**Bug**: `rotationForCalendarWheelOct1582DesignedForWeekdayStart:`
(`ios-backports/Chronometer/Classes/ECGLWatch.m:2484`) rotates the
special 21-day October 1582 wheel into place whenever `year == 1582 &&
month == 9` — with no era check, so it also fires in **BCE** 1582
October. The web called this a "decade+ old bug" and fixed it 2026-04-21
(409b610) by requiring era == CE.

**iOS edit** — `ECGLWatch.m:2490`:

```objc
if (year == 1582 && month == 9) {
```
becomes
```objc
if (year == 1582 && month == 9 && [mainTime eraNumberUsingEnv:mainEnv] == 1) {
```

- `eraNumberUsingEnv:` with the `== 1` (CE) convention is already used
  ~15 lines below in `calendarRow` — which **already had** the era guard;
  the iOS bug lives only in the rotation function, exactly the state the
  web inherited and then fixed.
- One code fix covers all three iOS Babylon wheels (weekday starts
  0/1/6) and the Android Babylon XML variants, since every XML routes
  through the same VM op (`EBVM_OP1(rotationForCalendarWheelOct1582)`,
  `ECVirtualMachineOps.m:668`). The **Android app's own code** (separate
  repo, not cloned here) would need its own equivalent fix — out of
  scope per "Chronometer only".
- `ECQView.m:2038–2070`'s October-1582 code is wheel-**texture**
  construction (day-number layout, the 4→15 jump), not date-dependent —
  untouched.

## 4. Build reality: XML is compiled into archives

The shipping app never parses watch XML at runtime. A special "Henry"
build (`EC_HENRY`) loads the XML and writes
`archiveHD/<watch>/archive.dat` (+ `variable-names.txt`, atlas PNGs),
all **tracked in git**; the app loads those. Consequences:

- Fixes A and B are one-line *source* edits, but taking effect on device
  requires Steve to **re-run the Henry target in Xcode (outside the VM)
  for Mauna Kea** and commit the regenerated archive files. Both changed
  attributes (update expression, anchor geometry) live in `archive.dat`.
- Fix C is plain ObjC — a normal app rebuild, no archive regeneration.
- The Android XML twins (Q1) would likewise need the "Henry for Android"
  generation pass, wherever that pipeline lives today.

The session leaves only the XML/ObjC source edits; archive regeneration
is Steve's step, alongside commit/push.

## 5. Validation

**In-VM** (stated per docs/ios-backports.md rules):
- A/B: XML well-formedness check on the edited files; field-by-field diff
  against the web spec commits (the web XML is a direct descendant of
  this file, so the lines correspond 1:1).
- C: `ECGLWatch.m` cannot compile in-VM (UIKit; no iOS SDK) — careful
  review against 409b610 is the fallback. The era convention (CE == 1)
  is proven by the adjacent `calendarRow` usage in the same file.

**On-device (Steve, outside VM)**:
- A: the EOT hand now redraws on half-hour boundaries; around a solstice
  the daily ~30 s jump becomes 48 small steps.
- B: indicated sunrise time on the 24-hour ring matches the computed
  sunrise (the web-side before/after is the reference).
- C: time-travel to October 1582 **CE** → special wheel (Oct 4 → 15);
  October 1582 **BCE** → the normal cutout wheel with all 31 days.

## 6. Report format

Per docs/ios-backports.md: leave the Chronometer tree dirty, show
`git -C ios-backports/Chronometer diff`, and print suggested commit
messages. Proposed as **three separate commits** mirroring the three web
spec commits (Steve may squash):

1. `Update Mauna Kea EOT hand every 30 minutes rather than daily.`
   (body: solstice-time EOT moves ~30 s/day; daily updates jump visibly)
2. `Correct minor positioning issue with Mauna Kea sunrise hand`
3. `Fix decade+ old bug showing October 1582 calendar wheel in BCE 1582 on Babylon`

After implementation, add this plan to the docs/ios-backports.md table
and status section (that doc edit rides with the status update, as with
the previous four back-ports).

## 7. Implementation notes (2026-08-21)

All edits landed in `ios-backports/Chronometer` (freshened first —
`pull --ff-only`, already up to date); tree left dirty per workflow.
Nine changed lines across three files:

- `Watches/Builtin/Mauna Kea/Mauna Kea.xml` — EOT `update` →
  `30 * minutes()` (:58); dawn `xAnchor` 39 → 37.85 (:65); dusk
  `xAnchor` 42 → 42.5 (:67).
- `Watches/Builtin-Android/Mauna Kea I/Mauna Kea I.xml` — same three,
  **plus the night-mode variants the iOS file doesn't have**: `EOTn`
  also → `30 * minutes()` (:60) and `dawn n` also → 37.85 (:68). Both
  follow the web precedent directly — the web spec commits changed
  every EOT hand and both dawn hands they could see (ed0894f changed
  the web's then-extant `dawn n`; the web's night variants were later
  removed entirely, which is why the current web XML shows none).
- `Classes/ECGLWatch.m:2490` — the era guard, exactly as specced.

**Android `dusk n` (:70) also moved to 42.5** — resolved by Steve
2026-08-21. The web fix had moved dusk *front* to 42.5 but not dusk
*night* in the same commit that did change `dawn n`; that asymmetry was
an oversight, not a decision (Steve confirms — the web's night hands
were slated for removal anyway, since back/night-only hands don't apply
on the web, and today's web XML indeed has none left). Supporting
evidence: the evening images are pixel-identical in size
(`eveningHD.png` and `eveningHD-sunonly.png` both 79×30 — same canvas ⇒
same anchor), while the morning pair *differ* (76×29 vs 75×29) yet
deliberately share 37.85. Nothing to change web-side: the stale value
survives only in dead history.

**Verified in-VM**: `xmllint --noout` passes on both XMLs; every changed
attribute value diff-checked against the web spec commits (a810ae9,
ed0894f) and current web XML (still 37.85/42.5 — no later re-tune);
`minutes()` confirmed a registered VM op (`EBVM_OP0(minutes)`,
`ECVirtualMachineOps.m:63`) already used by AtlantisIV/Geneva builtin
faces; `eraNumberUsingEnv: == 1` convention confirmed against the
existing guard in `calendarRow` fifteen lines below the edit.

**Not verifiable in-VM**: compiling `ECGLWatch.m` (UIKit; no iOS SDK),
the Henry archive regeneration, and on-device rendering — all Steve's,
per §4/§5.

**Suggested commit messages** (three commits mirroring the web history;
squash at will — note commits 1 and 2 each touch both XML files):

1. `Update EOT hands every 30 minutes rather than daily.`
   Body: At the solstices (particularly the winter solstice), the value
   of EOT can change by half a minute during a day, which is a
   quite-visible jump on large displays if only updated daily. Mauna
   Kea (iOS) and Mauna Kea I (Android, front and night hands).
2. `Correct minor positioning issues with Mauna Kea sunrise and sunset hands`
   Body: dawn xAnchor 39 → 37.85 and dusk xAnchor 42 → 42.5 (front and
   Android night hands), matching the corrected values from the web
   port (plus fixing the dusk night hand the web fix overlooked).
3. `Fix decade+ old bug in BCE 1582 in Babylon`
   Body: The special October 1582 calendar wheel also rotated into
   place in BCE 1582; require era == CE, as calendarRow already does.

**Committed 2026-08-21**: Steve squashed all three into a single commit,
Chronometer `43e6a8b` ("Three minor fixes back-ported from the web
version of Chronometer"), whose body carries the three messages above
plus a note that the regenerated archives for fixes 1–2 follow in a
later commit. Pushed to `transfer` (verified at `43e6a8b`); tree clean.
