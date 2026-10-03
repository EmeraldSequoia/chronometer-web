# iOS Back-Ports (`ios-backports/`)

Chronometer Web development keeps finding and fixing bugs that also exist in
the original iOS/Android codebases (which still ship). `ios-backports/` holds
**mutable working clones** of those repositories so a session can port a fix
back to the original source. The directory is **gitignored** — nothing in it
is ever part of a chronometer-web commit.

Contrast with the dot-prefixed `.*-ref/` directories
([ios-reference.md](ios-reference.md)): those are **read-only reference
snapshots** used for porting research. Never edit the refs; edit the
`ios-backports/` clones.

## The VM workflow (why this exists)

This development environment sits inside a VM with no GitHub credentials.
The flow for every back-port:

1. A session **pulls** the target repo (GitHub-origin repos only, see table)
   and **makes the fix** in `ios-backports/<repo>/`, leaving the working
   tree dirty — sessions never commit in these clones.
2. **Steve commits** in the clone (he owns every commit).
3. Steve **pushes to the clone's local `transfer` remote** — a bare
   repository in `/Users/spucci/git-repositories/<repo>.git` (see below) —
   copies that bare repo out of the VM, and pushes from outside, where
   credentials live. (For the one local-origin repo, esgl, the outside
   push target is his own git server, not GitHub.) The outside push goes
   to `main` for a repo Steve maintains himself, or to a **feature branch**
   that becomes a pull request for a repo with a maintainer of its own
   (see "Maintained repositories: pull requests" below). Every push to
   GitHub, to any branch, needs credentials, so the VM never makes one.

## The clones

Created 2026-08-19 as full clones (never shallow — you cannot push from a
shallow clone). HEADs at creation matched the `.*-ref` snapshots exactly.

| Directory | Origin | Branch | Notes |
|---|---|---|---|
| `Chronometer/` | github.com/EmeraldSequoia/Chronometer | main | 1.2 GB (media assets) — do not re-clone casually |
| `esastro/` | github.com/EmeraldSequoia/esastro | main | C++ astronomy library; the web's `es-astro.ts` was ported from `src/ESAstronomy.cpp` |
| `estime/` | github.com/EmeraldSequoia/estime | main | Time/NTP/calendar; `src/ESLeapSecond.{hpp,cpp}` |
| `eslocation/` | github.com/EmeraldSequoia/eslocation | main | |
| `Observatory/` | github.com/EmeraldSequoia/Observatory | main | Links `libesastro.a` (esastro.xcodeproj reference) |
| `esgl/` | ssh://127.0.0.1/…/libs/esgl.git | master | **Local-origin**: unreachable in-VM; cloned from `.esgl-ref`; cannot `git pull` here |

**Deliberately absent — not forgotten**: `.observatory-opengl-ref/` (the
OpenGL-era Observatory variant, branch `OpenGL`, local-origin) is a
**historical artifact only** — nothing back-ports to it (Steve,
2026-08-19). A clone was created here initially and then removed to avoid
confusion; the read-only ref snapshot remains for archaeology.

## The `transfer` remotes (added 2026-08-20)

Each clone has a second remote, `transfer`, pointing at a bare repository
`/Users/spucci/git-repositories/<repo>.git` (Steve's existing bare-repo
collection). It is the **outbound** half of the loop; `origin` stays the
inbound half (the freshen pull in "How a session does a single fix" step 2).
Bare repos carry committed history only — a dirty working tree transfers
nothing, so the commit comes first.

After committing a fix (Steve's step, like the commit itself):

```sh
git -C ios-backports/<repo> push transfer HEAD
```

`HEAD` sidesteps esgl's `master` vs the others' `main`, and pushing an
unchanged repo is a harmless no-op, so pushing all six at once is fine —
`ios-backports/push-to-transfer.sh` does exactly that (it iterates over
every directory there, so new clones are picked up automatically). Its
inbound counterpart, `ios-backports/pull-all.sh`, runs
`git pull origin main` in every clone **except `esgl/`**, which is
local-origin (not on GitHub, unreachable in-VM) and on `master`. The
bare repo then leaves the VM as a zip in its shared folder — the
chronometer-web precedent is `/Users/spucci/git-repositories/`
`export-bare-repo-to-shared.sh` plus its host-side verify-and-publish
counterpart; that script is hardcoded to chronometer-web today and needs
parameterizing (or a copy) for these repos. Outside, note the bare repo's
recorded `origin` is the in-VM clone path, which won't resolve there:
fetch from the copied `<repo>.git` into an outside checkout, or push
straight from it with an explicit URL
(`git -C <repo>.git push git@github.com:EmeraldSequoia/<repo>.git main`,
or `… steve/time-controller` for a feature branch: the same command
creates the branch on GitHub the first time, when git prints the link that
opens its pull request, and updates it afterwards). The bare repo holds
`main` and every feature branch pushed to it, and leaves the VM again for
each batch of commits.

If a clone or bare repo is ever recreated, re-pair them with:

```sh
git clone --bare ios-backports/<repo> /Users/spucci/git-repositories/<repo>.git
git -C ios-backports/<repo> remote add transfer /Users/spucci/git-repositories/<repo>.git
```

## Maintained repositories: pull requests (added 2026-10-03)

Observatory — and with it esastro, estime, eslocation and esutil — now has
a maintainer of its own who pushes to GitHub `main` (see
[planning/2026-09-25-ios-backport-observatory-time-controller.md](../planning/2026-09-25-ios-backport-observatory-time-controller.md)
§10). Work there reaches GitHub as a **pull request** for him to merge, not
as a push to `main`. A pull request is attached to a branch, not to a
commit: its content is every commit on the branch that `main` lacks,
GitHub shows them combined ("Files changed") and one by one ("Commits"),
and every later push to the branch updates the PR. So a multi-step change
is one branch, one commit per step, one PR:

1. In the clone, before committing the first step, create the branch
   (uncommitted changes come along): `git -C ios-backports/<repo> switch
   -c steve/<topic>`. The maintainer's own branches are `bjorn/<topic>`; a
   branch name is just a label. The identity GitHub shows is the commit's
   author email — the clones stamp `spucci@emeraldsequoia.com`, as the
   August commits were.
2. Commit each step on the branch; `main` in the clone stays at the
   maintainer's head. `push-to-transfer.sh` pushes `HEAD`, so it carries
   the branch, and the outside push names it (previous section).
3. Open the PR on github.com from the branch into `main` as a **draft**
   after the first push, linking the plan; later pushes flow into it; mark
   it "Ready for review" after the last step. Whether the per-step commits
   survive into `main` is the maintainer's merge choice (a regular merge
   keeps them, "squash and merge" collapses them) — ask for a regular
   merge in the description if the history matters.
4. Never rewrite pushed commits (amend, squash, rebase all need a
   force-push) once the maintainer has started reviewing.
5. When `main` moves meanwhile (the maintainer's work touches the same
   files), **merge** `origin/main` into the branch — `git fetch origin &&
   git merge origin/main`, resolve, commit the merge, push — rather than
   rebasing a public branch; GitHub's "Update branch" button does the same
   merge. This is Steve's step, not a session's: on a feature branch the
   session's freshen ("How a session does a single fix" step 2) no longer
   applies, and a session works on the branch it finds checked out.
6. A fix in another repository (esastro's `prevPlanettransit`, Chronometer's
   twin) is a separate PR in that repository; the dependent PR's description
   says so.

## How a session does a single fix

1. **Find the spec.** For the planned eclipse-family back-ports, read the
   planning doc (`planning/2026-08-19-ios-backport-*.md`). For any other
   bug fixed on the web side first: the chronometer-web commit **is the
   spec** — find it with `git log`, read it with `git show`, and port the
   *semantic* change, not the TypeScript.
2. **Freshen** (GitHub repos only): `git -C ios-backports/<repo> pull
   --ff-only`. If the pull fails or the tree is already dirty from an
   unpushed earlier fix, stop and ask Steve — never stash or reset someone
   else's pending work. On a **feature branch** (a pull request in
   progress, "Maintained repositories" above) there is nothing to pull:
   `git fetch origin` and report whether `origin/main` has moved; merging
   it in is Steve's step.
3. **Make the change**, matching that repo's local style exactly (tabs,
   brace placement, ObjC vs C++ idiom). The "never simplify iOS algorithms"
   rule runs both directions: port the correction faithfully, change
   nothing else.
4. **Duplicated code is the norm, not an accident**: Chronometer's
   `Classes/ECAstronomy.m` and esastro's `src/ESAstronomy.cpp` are parallel
   implementations of the same astronomy — a fix usually lands in **both**
   (and the per-fix plan says where).
5. **Validate what the VM allows.** There is no Xcode/iOS SDK here; full
   builds happen outside. Available in-VM:
   - `clang -fsyntax-only` (Apple clang is installed) on the touched file
     where its includes resolve;
   - UIKit files too, since 2026-10-03: the macOS SDK ships Mac Catalyst
     headers, so `clang -fsyntax-only -x objective-c++ -fno-objc-arc
     -DES_IOS=1 -D__FP__ -target arm64-apple-ios18.0-macabi -isysroot $SDK
     -iframework $SDK/System/iOSSupport/System/Library/Frameworks -isystem
     $SDK/System/iOSSupport/usr/include` (`SDK=$(xcrun --sdk macosx
     --show-sdk-path)`, plus `-I` for Classes, EC and the four library
     `src` dirs, esutil from a scratch clone) type-checks Observatory's
     `.mm` files; `-D__FP__` sidesteps a macOS-only Carbon header whose
     `pi` collides with `Constants.h`. A Foundation-only file needs none of
     the Catalyst flags. In zsh, word-split flag variables as `${=FLAGS}`;
   - numeric cross-checks against chronometer-web, whose engine is the
     verified reference (independently checked against JPL Horizons —
     `docs/astronomy.md` "Measured Accuracy"); the per-fix plans list the
     gold numbers;
   - `ESAstronomy.cpp` has a dormant `testConversion()` debug harness
     (`#if 0` near line 325) that a session may temporarily enable in a
     scratch copy for host-side spot checks.
   State plainly in your report what was and wasn't verifiable.
6. **Do not commit, do not push (not even to `transfer`), do not touch
   `.*-ref/`.** Report the diff (`git -C ios-backports/<repo> diff`) and
   print a **suggested commit message for each repo touched** — written in
   that repo's terms, ready for Steve to use verbatim or edit. Suggesting
   the message is where a session stops: it never runs `git commit` (or
   push) in any repo. Steve owns every commit and takes it from there
   (workflow above).
7. The only chronometer-web files a back-port session may touch are its own
   planning doc (status updates) — and never anything that references
   `ios-backports/` paths from tracked code.

## Planned back-ports (2026-08-19)

Three fixes made on the web side during the Eclipse Table work, each with
its own planning doc and intended for its own session:

| Plan | Web spec commit(s) | iOS repos touched |
|---|---|---|
| [ios-backport-topocentric](../planning/2026-08-19-ios-backport-topocentric.md) | 2f756b8 | esastro, Chronometer, (Observatory drawing path) |
| [ios-backport-leap-deltat](../planning/2026-08-19-ios-backport-leap-deltat.md) | 0513f2a + 906b7bf | esastro, Chronometer, estime |
| [ios-backport-horizon](../planning/2026-08-19-ios-backport-horizon.md) | f5c7a75 | Observatory |
| [ios-backport-planetdecl-ratopo](../planning/2026-08-20-ios-backport-planetdecl-ratopo.md) | — (iOS-only; spec is the sibling `planetRA`) | esastro, Chronometer |

Suggested order within each repo: topocentric before ΔT (matches the web's
commit history, so diffs stay comparable). The horizon fix is independent.

**Status**: the topocentric back-port landed in the clones 2026-08-20
(esastro eb077b4, Chronometer f4c7128, Observatory 8ba1206) and the ΔT
back-port followed the same day (esastro 0f877ab, estime 0a5fbeb,
Chronometer 22c11fc); details in their planning docs. Both are committed,
pushed to the `transfer` bare repos, and copied out of the VM. The
horizon back-port also landed 2026-08-20 (Observatory 1f0bf05, plus a
companion esastro header move cec5f1c exporting the horizon-refraction
constant); both commits are pushed to `transfer` (note esastro's bare
repo now needs re-copying out of the VM — its earlier copy predates
cec5f1c). The planetDecl-RA-topo back-port landed 2026-08-21 (fix
option 1 plus ECOptionsData comment flags; validated with a live
cache-interleaving before/after harness, planning doc §7); Steve
committed esastro 0a6023b and Chronometer beed32a, both pushed to
`transfer`.
**All four planned back-ports have now landed** in the clones and the
`transfer` bare repos, so the batched outside GitHub push and on-device
testing (deferred by decision of 2026-08-20) are unblocked.
*2026-08-28 caveat*: the caption half of the horizon back-port is now
superseded — the web replaced the kind-gated "Below horizon" caption with
a wash-closure gate
([planning/2026-08-28-eclipse-below-horizon-caption.md](../planning/2026-08-28-eclipse-below-horizon-caption.md)),
so Observatory `1f0bf05` carries the kind-gate bug and needs a follow-up
mirror; 2026-08-30 the wash anchor also moved (scene midpoint → drawn
primary body, plan §12), so the follow-up mirrors both halves. Remaining
steps, all Steve's, all outside the VM: re-copy the esastro,
Chronometer, and Observatory bare repos out (their earlier copies
predate their latest commits; estime's copy is current, eslocation has
nothing to push), push to GitHub, and test on device. All working trees
are clean; commits ahead of origin remain the expected state until that
push.

## Back-port batch 2 (2026-08-21)

Three one-line Chronometer-only fixes — Mauna Kea EOT hand cadence
(30-minute updates), Mauna Kea sunrise/sunset hand anchors, and Babylon's
October 1582 wheel wrongly appearing in BCE 1582:

| Plan | Web spec commit(s) | iOS repos touched |
|---|---|---|
| [ios-backport-mk-babylon-oneliners](../planning/2026-08-21-ios-backport-mk-babylon-oneliners.md) | a810ae9 + ed0894f + 409b610 | Chronometer only |

**Status**: **committed and pushed to `transfer` 2026-08-21** — Steve
squashed all three fixes into Chronometer `43e6a8b`; the working tree is
clean. Scope included the `Builtin-Android/Mauna Kea I` XML twins with
their night-mode hands, plus the Android `dusk n` anchor (a web-fix
oversight caught and resolved during review; plan §7). Remaining, all
Steve's, all outside the VM: copy the Chronometer bare repo out (its
earlier copies predate `43e6a8b`), push to GitHub, run the Henry archive
regeneration for the two XML fixes (`archiveHD/…/archive.dat` is
generated from the XML and tracked; the regenerated archives ride in a
follow-on commit — the Babylon code fix is complete as-is), and test on
device.

## Back-port batch 3 (2026-09-25): the time controller, Observatory only

A feature rather than a fix — the web's time-controller panel (unit chips,
one ◀ ▶ pair, hold-to-scrub, astro jumps, typed dates, a transport row)
replacing Observatory's "Set" row of fourteen stepper buttons, rebuilt
from UIKit primitives on the app's own `ESWatchTime` /
`ESAstronomyManager`. Chronometer iOS is deliberately excluded (its
hand-dragging and date windows cover the same ground).

| Plan | Web spec commit(s) | iOS repos touched |
|---|---|---|
| [ios-backport-observatory-time-controller](../planning/2026-09-25-ios-backport-observatory-time-controller.md) | e6c349a … 4cb0b74 — the panel as documented in [time-controller.md](time-controller.md) (build 2.0.164) | Observatory; esastro + Chronometer (a one-character `prevPlanettransit` fix, plan §6.7) |

**Status**: **decided, not started** — the plan was committed 2026-09-25
(`92d4d92`) and the Observatory maintainer answered its ten design
questions on 2026-10-03 (plan §9). That repo now has an owner of its own
who pushes to GitHub `main` (v1.6.1 shipped with a UIScene life cycle and
merged the batch-1 Observatory commits), so the outbound half of the
workflow above changes shape for it: the clones fast-forward with
`git pull --ff-only` (every earlier back-port is upstream), and the
finished work reaches GitHub as a pull request for him to merge, not a
push to `main` (plan §10).
