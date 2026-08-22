# Eclipse Table card on the index page — quick plan

**Status**: IMPLEMENTED and COMMITTED (2026-08-19) — landed as 3ec3638.
Card verified live third in the grid (desktop + 375 px,
no overflow); thumb centered on the Moon disc itself (disc center
(156,160), measured by edge-walking the dark disc; crop r=69 = the
maximum circle inside the photo's exposed region) so the disc lands in
the middle of the round crop with no square seams — the corona stays
asymmetric, that's the photograph; suite 8683 green. Follow-on to
[2026-08-19-eclipse-table-phase3.md](2026-08-19-eclipse-table-phase3.md);
supersedes the parent plan's §4 "explicitly not: … no links from
privacy/support/index cards" for the index card only (Steve asked for it).
Since 5825002 this same `thumb-eclipses.png` is also the Eclipse Table
page's favicon and apple-touch-icon (parent plan rev 6).
**Created**: 2026-08-19

## What

A `face-card` on index.html linking to eclipse-table.html, placed right
after the smart Selected/Pick card (`#pick-card`) and before the generated
`{{FACE_CARDS}}` — i.e. third in the grid. Static markup; no JS changes
(`updateLinks()` already rewrites every `a.face-card` href to carry the
current query string — harmless here, the table page ignores unknown
params and inherits nothing it shouldn't).

```html
<a class="face-card" href="eclipse-table.html">
  <img class="thumb" src="thumb-eclipses.png" alt="Eclipse Table" />
  <h2>Eclipse Table</h2>
  <p class="desc">Thirty years of solar and lunar eclipses</p>
</a>
```

- **Title** "Eclipse Table" — matches the page's own h1 and the help-nav
  label's wording.
- **Description** "Thirty years of solar and lunar eclipses" — matches the
  neighbors' tone and length ("View all watch faces together", "Live
  astronomy values from the shared engine"), and is evergreen: no
  hardcoded 2011/2041 to go stale on a re-scrape. Alternate if a verb is
  preferred: "Look up any eclipse, thirty years each way".
- **Round thumb** (default `.thumb`, not `thumb-square`) — the subject is
  a disc; the round crop reads like a telescope view, matching the
  Observatory card.

## Image

Reuse the repo's own totality photograph:
`src/shared/assets/totalEclipse.png` (316×316) — the Observatory eclipse
simulator's totality view, black disc + blue-white corona, and already the
visual reference for the table's total-solar icon. It's literally what the
card's destination links show at totality, and it needs no download or new
licensing.

It ships only as an esbuild data-URL inside the engine bundles, so the
card needs a real file: derive **`src/faces/thumb-eclipses.png`** from it —
center-crop (~230×230) so the corona fills the 180 px circle instead of
floating in black margin, eyeball the crop against the rendered card.
(If Steve would rather have a higher-res photographic corona, a NASA
public-domain photo is the alternative — needs a download approval and a
credit line; not the default.)

## Build + docs

- **build.sh**: add a copy stanza for `src/faces/thumb-eclipses.png` →
  `dist/`, mirroring the thumb-observatory.png one (hard error if
  missing).
- **docs/help-system.md**: the "links to the page from five places" list
  in the Eclipse Table section becomes six (add the index card).

## Verify

Rebuild; check the card renders third in the grid, navigates to the
table, thumb loads round and filled; 375 px mobile pass (cards stack, no
overflow); full suite + tsc (nothing should move — markup + one PNG +
build copy only).

## Sequencing

One small standalone commit. Cleanest landed *after* phase 3's two
prepared commits (the only file overlap is docs/help-system.md, which is
in both); if it should ride along instead, it can fold into commit 2.
