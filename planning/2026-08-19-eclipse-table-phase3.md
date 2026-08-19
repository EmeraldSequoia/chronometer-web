# Eclipse Table phase 3 — wiring + "Predicting" → "Understanding"

**Status**: IMPLEMENTED (2026-08-19) — both commits' content is in the
working tree awaiting Steve: commit 1 (links/wiring + docs) is staged in
the git index; commit 2 (section revision, five regenerated screenshots at
2041 Apr 30 / 2040 Nov 18, seven retired PNGs) is unstaged on top. All §7
verification passed (flavor voices, links, anchor, images, 8683 tests,
tsc). Q1–Q5 resolved (Steve, 2026-08-19; §6). Child of
[2026-08-16-eclipse-table-page.md](2026-08-16-eclipse-table-page.md) §11
(re-scoped 2026-08-19: the standalone page is the primary, bookmarkable
entry; the help system points at it and never hosts the content). Phases 1–2
are implemented and in the working tree awaiting commit.
**Created**: 2026-08-19
**Baseline**: ed35394 + uncommitted phase 2

## 0. For a fresh session

- **Working tree**: Eclipse Table phases 1–2 may be committed by the time
  you start, or still sitting as untracked/modified files
  (src/eclipse-table.html, src/eclipse-table-page.ts, its test, build.sh,
  dist/eclipse-table.*) — either way they are finished work: build on them,
  never revert or fold them into your commits uninvited. Steve owns every
  commit.
- **Screenshot capture spec** (commit 2). The two example rows, verbatim
  from src/help/eclipse-data.json:
  - solar `2041 Apr 30`: tdMs 2250935540791, lat −9.6195, lon 12.1608,
    tz Africa/Luanda (total-solar)
  - lunar `2040 Nov 18`: tdMs 2236878280000, lat 20, lon 70,
    tz Asia/Kolkata (total-lunar)
  Load Basel exactly the way a reader will: build dist, open the page's own
  Chronometer deep link for each row (or compute it with
  `chronometerUrl()` from src/eclipse-table-page.ts — do not hand-assemble
  URLs). Capture five crops mirroring the retiring set and sizes: solar →
  node view (~79×76, cf. EclipseNode2012Nov13.png) + needle view (~78×77);
  lunar → node-Sun (~60×57) + node-Moon (~62×55) + needle (~72×74). All in
  `src/help/images/basel/`, named `EclipseNode2041Apr30.png` etc.; retire
  the five 2010/2012 files. (Also present but referenced nowhere:
  `EclipseNode2009Jul22.png` / `EclipseNeedle2009Jul22.png` — grep confirms
  zero uses; retire them in the same commit unless Steve says otherwise.)
- **Rendering without a live browser**: the browser pane's rAF can be
  frozen; the project has established recipes — see the memory files
  `canvas-verify-without-raf.md` (one-shot draw harness renders any face
  view headlessly and POSTs the PNG out) and `scratch-inspector-build.md`.
  Steve capturing on-device is the fallback.
- When done, flip this plan's Status and the parent's
  ([2026-08-16-eclipse-table-page.md](2026-08-16-eclipse-table-page.md))
  to IMPLEMENTED — the whole Eclipse Table effort closes with this phase.

## 1. Goal

Wire `eclipse-table.html` into the help system, and revise help.html's
`#eclipses` section for the world where "when is the next eclipse?" is a
lookup, not a skill — keeping the parts that teach *why* eclipses happen and
*how the apps show them*, and cutting the parts that taught users to be a
worse version of the new table.

## 2. What's in the section today (content inventory)

`src/help.html` `#eclipses` (lines ~715–984), summary "Predicting Eclipses
with Emerald Chronometer", ported from iOS Geneva's PredictingEclipses.html.
Every passage is dual-voiced with `.chrono-only`/`.obs-only` spans (Basel's
node hands + eclipse needle vs the Observatory's Eclipse Simulator);
`app=inspector` drops the whole section. Para-by-para:

| lines | content | verdict |
|---|---|---|
| 720–743 | **Background**: node hands/lines, "Sun and Moon must be near a node" | **Keep** — this is the understanding core |
| 745–769 | How the eclipse needle (chrono) / simulator animation (obs) behaves | **Keep**, one wording touch-up (Q4: the obs text predates the apparent-horizon fix) |
| 771–779 | Solar visibility is local, lunar is hemispheric | **Keep** verbatim — it's also why the table's lat/lon column matters |
| 781–793 | **Correlating with known dates**: set the time controller by hand; convert published UT to local; check against the UT hand/subdial | **Replace** — this is the manual labor the table's deep links eliminate. Condense to one sentence for people typing in a time from elsewhere |
| 794–848 | Worked example: 2012 Nov 13 total solar, Basel node image + set lat −39.95 lon −161.33 by hand → needle image | **Rewrite**: keep the pedagogy, replace the manual steps with "open it from the Eclipse Table". (Superseded in part by Q1 ✔: the example moves to 2041 Apr 30 and its images regenerate — 2012 Nov 13 is itself at the past edge) |
| 850–902 | Worked example: 2010 Dec 21 total lunar, four Basel images | **Q1** — the date is *outside the table* (coverage starts 2011). Options below |
| 904–926 | "Use this same technique with historical eclipses" + 3 external lists (NASA history, mreclipse SEnext, NASA lunar) | **Rewrite**: the Eclipse Table replaces two of the three lists for 2011–2041; NASA's historical list stays (genuinely outside our window). mreclipse's SEnext link drops (2021–2040 only — the recon finding that started all this) |
| 928–956 | **Discovering dates with no external knowledge**: scrub until Sun nears a node, align the Moon, hunt the maximum | **Keep, reframed** — retitle to make clear it's the self-reliant sport, not the recommended path; add one pointer sentence to the table |
| 958–971 | Node-distance physics (5° inclination, ±10° window) | **Keep** verbatim |
| 973–982 | "Don't plan your once-in-a-lifetime photo on this app" caveat | **Keep**, refresh the pointer (NASA sites + the table's per-eclipse Details links to EclipseWise) |

Net: roughly 60% of the prose survives untouched; the middle third inverts
from "how to get there" to "what you're looking at once the table takes you
there."

## 3. Proposed new structure (drafted where it changes)

**Summary/title (Q2)**: `Understanding Eclipses` — drops both the
"Predicting" framing and the product name (which the `app=` flavor script
text-swaps today; a nameless title sidesteps that entirely). The anchor
**stays `id="eclipses"`** — basel.html and the complications table link to
it. The `.help-nav` label becomes "Eclipses".

**New opening paragraph** (before Background, app-neutral — drafted):

> The <a href="eclipse-table.html">Eclipse Table</a> page lists every solar
> and lunar eclipse from 15 years back to 15 years ahead, each with links
> that open the moment and place of maximum eclipse right here. This
> section explains what you'll see when you follow one: why eclipses happen
> where and when they do, and how the displays show them.

⚠ **Flavor-swap trap** (why the draft above names no product): help.html's
`app=` script rewrites every "Emerald Chronometer" text node to "Emerald
Observatory" — a sentence naming *both* products would render as "Emerald
Observatory and Emerald Observatory" in the Observatory's popover. All new
prose must be app-neutral or `.chrono-only`/`.obs-only` gated; never name
both products in one unggated text node.

**Background** — unchanged apart from Q4's horizon-wording touch-up.

**"Correlating with known dates" → "Watching a known eclipse"** (drafted
replacement for 781–793):

> The easiest way to load an eclipse is from the
> <a href="eclipse-table.html">Eclipse Table</a>: each row's links open the
> apps at the instant and place of maximum eclipse, with time stopped —
> press play and watch. (If you're typing in a time published elsewhere,
> note it's usually UT; the time controller uses the local time of the
> current location, and the local date can differ from the UT date.)

Then the solar example — **2041 Apr 30 per Q1 ✔** — rewired: "Open the
Eclipse Table and follow the **2041 Apr 30** row's Chronometer/Observatory
link…" with freshly captured node and needle images presented as "the
display should look like this". **Deliberately no hardcoded deep-link URLs inside help.html** — the
table page is the single generator of those links (same single-source rule
as the JSON); prose names the row, the table provides the link.

**Q1 — the lunar example (2010 Dec 21)**, three options *(kept for the
record; resolved in §6 with a better fourth option: BOTH examples move to
the future edge — 2041 Apr 30 solar, 2040 Nov 18 lunar)*:

- **(a) Recapture on an in-table lunar eclipse** — recommended. The 2025
  Mar 14 total lunar (Americas-centered, a table row) replaces 2010 Dec 21;
  regenerate the four Basel screenshots with the established headless
  canvas harness (project memory: the one-shot draw harness renders any
  face view at any time without rAF), or Steve captures on device. Keeps
  every example one tap away, at the cost of four new PNGs (the old
  geneva-era images retire).
- (b) Keep 2010 Dec 21 with a sentence noting it predates the table window
  ("for eclipses from 2011 on, the table gets you there in one tap") —
  zero image work, slightly undercuts the story.
- (c) Keep the 2010 images but re-key the prose to "any total lunar row" —
  images and text drift apart; not recommended.

**External-lists paragraph** (drafted replacement for 904–926):

> For eclipses within the table's window, the
> <a href="eclipse-table.html">Eclipse Table</a> is the quickest path, and
> each row's Details link opens Fred Espenak's page for that eclipse. For
> deeper history, NASA maintains a
> <a href="…SEhistory…">list of notable historical solar eclipses</a> you
> can dial in with the time controller.

**"Discovering dates with no external knowledge" → keep title** (it names
the point better than any replacement) with one added closer (drafted):

> …or skip the hunt entirely: the Eclipse Table lists every result of this
> technique for thirty years around today. The fun of finding one by hand,
> of course, is knowing you could have done it from a desert island.

Final caveat paragraph: keep; "(you can start at the NASA sites linked
above)" → "(start from the table's Details links, or the NASA sites
above)".

## 4. Link wiring (unchanged from parent §11, made concrete)

- **help.html**: the new opening paragraph above is the `#eclipses` pointer;
  `.help-nav` gains `<a href="eclipse-table.html" target="_self">Eclipse
  table</a>` (standalone mode only — nav is removed in embed mode, which is
  fine: the popover reaches the table via the section paragraph, opening a
  new tab through `<base target="_blank">`).
- **Complications table** row "Eclipse prediction" (links `#eclipses`):
  rename the row text to "Eclipse indicator" (it describes Basel's
  complication, not a prediction workflow); link unchanged.
- **Fragments**, each one sentence with explicit `target="_blank"` (the
  popover retargets only `http…` links; a bare relative link would navigate
  the running app away — help-popover.ts:57):
  - [basel.html](../src/help/basel.html) ~89, after the existing
    help.html#eclipses sentence: *"For a table of every eclipse from 2011
    through 2041 — with links that open each one on Basel — see the
    <a href="eclipse-table.html" target="_blank">Eclipse Table</a>."*
  - [observatory.html](../src/help/observatory.html) ~272 (by the
    5-eclipses figure): same sentence, "…open each one in the Observatory…".
  - [selene.html](../src/help/selene.html) and
    [chandra.html](../src/help/chandra.html): *"Lunar eclipses (and solar
    ones) for thirty years around today are listed in the
    <a href="eclipse-table.html" target="_blank">Eclipse Table</a>."*
- **Explicitly not**: no table content embedded anywhere; no new `<details>`
  section; no links from privacy/support/index cards.

## 5. Docs

[docs/help-system.md](../docs/help-system.md): add eclipse-table.html to the
file inventory and build flow (esbuild entry + `{{ECLIPSE_DATA}}` token +
static stanza), describe the page as the primary/bookmarkable entry, note
the scraper regeneration procedure pointer, and fix the now-stale "four
topic pages" line while in there (there are six sections; Q5 whether to do
that cleanup in this commit or leave it).

## 6. Decisions (resolved 2026-08-19, Steve)

- **Q1 ✔ (improved by Steve)** — replace **both** worked examples with
  eclipses near the **future edge** of the range: the old solar example
  (2012 Nov 13) is itself barely in range at the past edge and would fall
  out on the next re-scrape. Picks, from the data:
  - Solar: **2041 Apr 30 total** — the table's last total solar (greatest
    9.62°S 12.16°E, Angola→Kenya path); total, so the needle-reaches-Total
    demonstration survives.
  - Lunar: **2040 Nov 18 total** — the last *total* lunar (the 2041 lunars
    are magnitude-0.06/0.17 partials, useless as examples); zenith
    20°N 70°E.
  With ±15-year coverage on each re-scrape, both examples stay in-range
  until a rebuild after ~2055 — decades of validity. All five Basel
  screenshots regenerate (solar: node view + needle view; lunar: node-Sun +
  node-Moon + needle views), preferably via the established headless
  one-shot draw harness at the rows' exact instants/locations; the five
  2010/2012 images retire from `src/help/images/basel/` (the other
  geneva-era images in that directory are untouched). Obs-only prose picks
  up the new dates; per Q3 no coordinates are hand-copied into prose beyond
  what the display discussion needs.
- **Q2 ✔** — title becomes **"Understanding Eclipses"**; anchor stays
  `#eclipses`; `.help-nav` label "Eclipses".
- **Q3 ✔** — worked examples reference table rows; zero deep-link URLs
  hardcoded in help.html.
- **Q4 ✔** — the obs-only overlay paragraph is updated to match the
  apparent-horizon behavior (wash at the refracted horizon; caption once
  the body has fully set, matching Basel's wheel).
- **Q5 ✔** — the docs/help-system.md staleness fixes ("four topic pages",
  file counts) fold into this work rather than waiting for a docs pass.

## 7. Verification

- Headless (dist server, fresh port, build stamp): `#eclipses` renders in
  default and `app=observatory` flavors with the right span voices and no
  orphaned text-swap artifacts; `app=inspector` still drops it silently;
  every new link resolves (eclipse-table.html reachable from help.html
  standalone + embed, and from all four fragments' popovers, each opening a
  new tab); `.help-nav` entry present standalone, absent embedded; anchor
  `help.html#eclipses` still opens/scrolls (basel.html's existing link).
- Images: whichever Q1 path — confirm the four lunar images referenced all
  exist and render (build copies `src/help/images/**`).
- Full suite + `tsc --noEmit` (content-only changes; nothing should move).
- On device (Steve): popover reading pass in both apps — the dual-voice
  spans are easy to break invisibly in an editor.

## 8. Commit breakdown (Steve owns every commit)

1. **Links only** (mechanical, low-risk): fragments' four sentences,
   help.html opening paragraph + `.help-nav` entry + complications-row
   rename, docs/help-system.md. Page becomes reachable everywhere; old
   prose untouched.
2. **Section revision** (the Q1–Q4 content work): retitle, replace/rewrite
   per §3; regenerate the five Basel screenshots for 2041 Apr 30 (solar)
   and 2040 Nov 18 (lunar) and retire the 2010/2012 ones.

Two commits so the wiring can ship even if the prose revision iterates.
