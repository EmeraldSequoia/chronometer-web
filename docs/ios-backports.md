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
   push target is his own git server, not GitHub.)

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
every directory there, so new clones are picked up automatically). The
bare repo then leaves the VM as a zip in its shared folder — the
chronometer-web precedent is `/Users/spucci/git-repositories/`
`export-bare-repo-to-shared.sh` plus its host-side verify-and-publish
counterpart; that script is hardcoded to chronometer-web today and needs
parameterizing (or a copy) for these repos. Outside, note the bare repo's
recorded `origin` is the in-VM clone path, which won't resolve there:
fetch from the copied `<repo>.git` into an outside checkout, or push
straight from it with an explicit URL
(`git -C <repo>.git push git@github.com:EmeraldSequoia/<repo>.git main`).

If a clone or bare repo is ever recreated, re-pair them with:

```sh
git clone --bare ios-backports/<repo> /Users/spucci/git-repositories/<repo>.git
git -C ios-backports/<repo> remote add transfer /Users/spucci/git-repositories/<repo>.git
```

## How a session does a single fix

1. **Find the spec.** For the planned eclipse-family back-ports, read the
   planning doc (`planning/2026-08-19-ios-backport-*.md`). For any other
   bug fixed on the web side first: the chronometer-web commit **is the
   spec** — find it with `git log`, read it with `git show`, and port the
   *semantic* change, not the TypeScript.
2. **Freshen** (GitHub repos only): `git -C ios-backports/<repo> pull
   --ff-only`. If the pull fails or the tree is already dirty from an
   unpushed earlier fix, stop and ask Steve — never stash or reset someone
   else's pending work.
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
   stop. Steve takes it from there (workflow above).
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
(esastro eb077b4, Chronometer f4c7128, Observatory 8ba1206; details in its
planning doc) and the bare `transfer` repos carry it, awaiting the outside
push. The ΔT, horizon, and planetDecl-RA-topo back-ports are not started.
