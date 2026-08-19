# Eclipse Table Page — plan

**Status**: rev 3 (2026-08-16) — **commit 1 (scraper + data + tests) IMPLEMENTED,
uncommitted, awaiting Steve**; commits 2–3 not started. Q1–Q8 resolved as
recommended (§15); presentation redesigned per Steve's 0.1–0.4 questions (cards
in per-year `<details>`, single JSON source, near-now emphasis). Phase-1
implementation changed two things the plan had specified — both recorded in §3:
central-eclipse positions are refined from NASA **path pages** (the catalogs'
whole-degree coordinates miss narrow umbral paths), and EclipseWise links are
**not** HEAD-verified (the site bot-blocks automation; the URL rule was
validated against 96 of mreclipse's own published links instead). 115 eclipses
generated for 2011–2041; 17 tests; full suite 8606 passing.
**⚠ New for commits 2–3 (2026-08-18)**: the leap-second ΔT change landed and
introduced a *stale-epoch* problem in this page's data and deep links — §9a
below, and §14. Read it before building the cards.
**Created**: 2026-08-16
**Last Updated**: 2026-08-18 (rev 3 + §9a, the ΔT epoch note)
**Baseline**: e2c7b43

## 1. Goal

A new help page ("Eclipse Table" by name, a grouped list by construction)
covering every solar and lunar eclipse from 15 years before to 15 years after
the present (2011–2041 at generation time; ~72 solar + ~53 lunar after
dropping penumbral), one entry per eclipse: custom-drawn kind icon,
plain-language description, UTC date/time of maximum, lat/lon of maximum,
deep links opening that moment in the Observatory and in a Chronometer
selected-faces view (Basel, Venezia, Selene), and a per-eclipse external
detail link. Intro paragraphs, icon legend with Wikipedia links, source note,
and a dynamically positioned "today" marker. Data comes from a scraper script
re-run every few years; the range drifts asymmetric with time, which is fine.

## 2. Data source (Q1 ✔)

Recon killed the original "scrape mreclipse.com" premise:

- mreclipse.com has exactly two eclipse tables ([SEnext](https://mreclipse.com/Special/SEnext.html),
  [LEnext](https://mreclipse.com/Special/LEnext.html)) covering **2021–2040
  only**, with no lat/lon of greatest eclipse.
- mreclipse.com **per-eclipse pages don't exist** for most eclipses — photo
  galleries only for events Espenak photographed (four in our range). Its own
  table rows link out to **eclipsewise.com** "prime" pages.
- NASA GSFC (same author, Fred Espenak) has everything in two static century
  catalogs — [SE2001-2100](https://eclipse.gsfc.nasa.gov/SEcat5/SE2001-2100.html),
  [LE2001-2100](https://eclipse.gsfc.nasa.gov/LEcat5/LE2001-2100.html):
  date, TD of greatest eclipse, ΔT (TD→UT conversion), type + subtype
  letters, gamma, magnitude, **lat/lon of greatest eclipse** — plus decade
  tables (SEdecade2011…2041, LEdecade2011…2041; endpoints verified) with the
  human-readable **Geographic Region** text for descriptions. Footer grants
  free reproduction with the acknowledgment "Eclipse Predictions by Fred
  Espenak, NASA's GSFC".

**Resolved (Q1 ✔)**: scrape NASA GSFC (century catalogs joined with decade
tables by date); per-eclipse "details" links go to EclipseWise prime pages
(pattern `SE2024Apr08Tprime.html` — the links mreclipse itself uses); source
note credits Espenak / NASA GSFC / MrEclipse.com with links to all three.
Scraper converts TD→UT via the per-row ΔT (minute precision). Penumbral
lunar eclipses are dropped at scrape time (Q2 ✔) — near-invisible in the sky
and invisible to the app's umbra-only eclipse model, so their deep links
would show "no eclipse"; the intro says so in one sentence.

## 3. Scraper — `scripts/scrape-eclipses.mjs`

Node ESM one-off, house style per [build-cities.js](../scripts/build-cities.js)
(shebang, doc-comment header with usage + source URLs, run manually — never
part of the build). Node ≥22 global `fetch`; jsdom already a devDependency.
No new dependencies.

- Args `--start YYYY --end YYYY`, default `currentYear ± 15` inclusive, plus
  `--cache DIR` (re-runs while developing the parser don't re-hit NASA) and
  `--out PATH`.
- Fetches 2 century catalogs + covering decade pages; parses the fixed-width
  `<pre>` rows; joins region text by calendar date; normalizes type codes
  (solar P/A/T/H + subtype suffixes like `Am`/`H3`/`Pb`; lunar P/T with `+`/`-`
  suffixes; N dropped). Decade pages are real `<table>` markup, parsed with
  jsdom; catalogs are text, parsed by line.
- **Position precision (added during implementation, not in rev 2).** The
  catalogs round the greatest-eclipse point to whole degrees — up to ~78 km.
  Umbral paths in range get as narrow as 21 km (2020 Jun 21) and 49 km
  (2023 Apr 20), so a catalog-coordinate deep link would land the viewer
  *outside* totality and the app would draw a partial on a row labelled
  "total". Central solar rows therefore take their position and UT time from
  the per-eclipse **NASA path page** linked in the catalog row itself
  (0.1-arcminute ≈ 200 m). 43 of 44 central eclipses in range have one; the
  exception is the non-central annular of 2014 Apr 29, which keeps catalog
  coordinates harmlessly. Partial solar and all lunar rows keep catalog
  coordinates too — a partial eclipse has no umbra to miss, and a lunar
  eclipse looks the same across the whole night hemisphere.
- **Fails loudly** on format surprises rather than emitting suspect data.
  Four gates, each verified by mutating cached pages and re-running:
  unparsable catalog row or decade row that isn't exactly 7 columns → die;
  **reverse join** — every non-penumbral eclipse the decade tables list in
  range must appear in the century catalog (catches a single hidden row,
  which a per-year count cannot); per-year count outside 2–7 (independently
  verified as the true range across all of 2001–2100); more than 3 central
  eclipses missing a path link (the century has exactly 3 genuinely
  path-less ones, so more means the link markup moved).
- Resolves each row's IANA timezone from the nearest city at scrape time
  using the repo's own committed [cities-data.js](../src/cities-data.js)
  (Q6 ✔ — loaded with the `new Function('window', js)` sandbox idiom from
  [make-cities-gz.mjs](../scripts/make-cities-gz.mjs)). Greatest eclipse
  usually falls at sea, where no city's civil time means anything, so beyond
  500 km it falls back to the nautical zone for that longitude (`Etc/GMT±n`,
  IANA's inverted sign). 75 distinct zones in the current data, 20 nautical.
- **EclipseWise URLs are built, not verified** (rev 2 said HEAD-verify).
  eclipsewise.com serves HTTP 403 to automation and sits behind a
  bot-protection interstitial — it loads fine in a real browser, so the links
  are good for users, but a scraper cannot check them. Instead the
  construction rule (`SE{YYYY}{Mon}{DD}{first letter of type}prime.html`) was
  validated against **96 of the 115** URLs appearing verbatim in mreclipse's
  own SEnext/LEnext tables, spanning all six kinds; the other 19 are years
  those tables don't cover.
- Emits **one committed artifact**: `src/help/eclipse-data.json` (38 KB) —
  a `meta` object (generator, generated date, covered range, source URLs,
  acknowledgment, a note recording which fields are normalized, counts) plus
  one record per eclipse: `{ utcMs, kind, region, pathRegion, lat, lon,
  coordSource, tz, url }`. (`pathRegion` = the decade table's bracketed
  central-path description, non-null exactly for central solar eclipses;
  `coordSource` = `path` | `catalog`, honest provenance for the precision
  above. Rev 2 also listed `saros`; dropped, nothing displays it.)
  Field-per-line so a re-scrape diffs readably. The scraper asserts the
  serialized file contains no `</script` or `<!--` sequences (it will be
  inlined into HTML; structurally absent, but assert anyway). Re-running
  reproduces the file byte-for-byte.
- Region prose is NASA's own, with two safe normalizations: lowercase compass
  abbreviations spelled out (`c US` → `central US`, `n. China` → `northern
  China`, `w & s Africa` → `western & southern Africa`) and stray punctuation
  tidied (the source has `Africa,, Asia`). Capitalised forms are deliberately
  **not** touched — `S. Africa` is the country, not a direction, and NASA
  uses both forms in a single row. `meta.note` records this.
- **Pending amendment (2026-08-18)**: the time base will be re-anchored on
  NASA's TT instants with UTC derived via the leap-second-exact conversion,
  eliminating NASA's frozen ΔT vintages as an error source — spec and
  rationale in the precision plan
  ([2026-08-17 §3b](2026-08-17-eclipse-precision-and-verification.md)),
  prerequisite [2026-08-18-leap-second-deltat.md](2026-08-18-leap-second-deltat.md).
  Second-level `utcMs` shifts only; no page or schema impact.

## 4. Presentation — cards in per-year groups (0.1, 0.2, 0.4)

Steve's worry is right: a 5-column table at 375 px either cramps or scrolls
sideways. Rev 2 drops the `<table>` for the thing the stacked-links column
was already becoming — **a card per eclipse**, whose innards reflow with
flex-wrap: on desktop a card reads as one wide row (date — description —
where — links), at phone width it wraps to ~3 short lines. No horizontal
scroll at any width, no breakpoints, no second layout to maintain (0.1).

This is not a new paradigm — it's the existing help model (0.2): cards are
grouped into per-year `<details class="help-section">` blocks, the exact
disclosure idiom of [help.html](../src/help.html)'s six sections and the
combined face help. Each `<summary>` shows "**2028** · 4 eclipses" plus a row
of tiny kind icons, so a collapsed year still telegraphs what's in it. The
page keeps help.html's palette, back-link nav, and typography.

The year groups also answer 0.4 (~125 entries, but the useful ones cluster
around now): the groups containing and adjacent to the today marker
(previous/current/next — 2–3 groups, ~12–15 cards) render **open**; the other
~28 years render collapsed, one tap away. The page auto-scrolls to the today
marker on load (§8). So the first paint shows exactly the recent-past and
near-future eclipses, with 31 years reachable but not in the way.

Considered and rejected for 0.4: upcoming-first reordering (breaks the
chronological mental model and complicates the marker), decade tabs and
filter chrome (new paradigm, overkill for ~125 entries). A solar/lunar filter
toggle stays in §16 as a future idea if the list feels long in practice.

## 5. Single source of truth — JSON in, rendered page out (0.3)

Yes — and it's cleaner than rev 1's generated-rows partial, which had facts
living in two shapes (scraper output HTML + data-attributes). Rev 2 pipeline:

1. `src/help/eclipse-data.json` (§3) is the **only** generated artifact.
2. build.sh injects it verbatim into the page between
   `<script type="application/json" id="eclipse-data">` tags via the existing
   awk token mechanism (`{{ECLIPSE_DATA}}` on its own line). Verified against
   the actual awk: injected lines are printed verbatim, never re-scanned —
   braces/backslashes/single-line 28 KB JSON all pass intact; arbitrary
   source paths are in-pattern (FACE_CARDS/INDEX_ORDER hardcode
   `src/faces/generated/…` paths; [index.html:585](../src/index.html) already
   injects JSON into a script block this way).
3. A small **bundled page module**, `src/eclipse-table-page.ts` (esbuild
   entry, exact precedent: the `index-page.ts` stanza at build.sh:84–87),
   parses the block (`JSON.parse(el.textContent)`, wrapped in try/catch that
   surfaces a visible error line rather than a blank page) and renders
   everything: year groups, cards, icons (via `<symbol>`/`<use>` refs to defs
   in the static shell), the today marker, and the **deep-link URLs built
   from the raw facts** — `picks`/`body`/`dir` literals are presentation and
   live here, not in the data.
4. The same module exports its renderer + URL builder, so the vitest
   **imports and tests the real shipped code** (§10) — the decisive reason
   for a bundled module over an inline script, which would have made link
   construction an untestable dead zone.

file://-safe (no fetch — the block is inline; the only degraded file://
features in this repo are OSM tiles and geolocation per
[file-url-limitations.md](file-url-limitations.md)). ~125 cards ≈ 1 K DOM
nodes rendered once, no rAF loop — no conflict with the perf/memory culture.
Coverage dates in the intro/source note are rendered from `meta` into
placeholder spans, so re-scrapes can't leave stale hand-written years behind.

One real regression vs. the rest of help (every existing help surface is
static content + enhancement scripts): this page's *list* is blank without
JS. Accepted: the static shell (title, intro, legend, source note) still
renders, plus a `<noscript>` note where the list goes — first `<noscript>` in
src/, called out here so it's a decision, not an accident.

## 6. Card fields

Same facts as rev 1's columns, recomposed:

- **Line 1**: kind icon (`<use>`, with `title`/`aria-label`) · **bold date**
  `2028 Jul 22` · `02:56 UTC` — date leads so a scanning eye falls down a date
  column even in card form. **Round to the nearest minute**, don't truncate:
  the data carries seconds, and rounding is what reproduces the times NASA
  and everyone else publish (2017 Aug 21 is 18:25:32 → "18:26").
- **Line 2**: kind + region. For central solar eclipses prefer `pathRegion`
  (the path itself — "Mexico, central US, eastern Canada") and fall back to
  `region` for partials and lunar eclipses ("Americas, Europe, Africa");
  this is what gets closest to Steve's "total solar eclipse crossing
  Australia". Region strings are third-party text — render via `textContent`,
  never innerHTML.
- **Line 3** (wraps up beside line 2 on wide screens): `15.6°S 126.7°E`
  (for lunar rows the zenith point — the intro explains the whole night side
  sees a lunar eclipse) · links: **Observatory · Chronometer · Details**
  (Details = EclipseWise, marked with the house `img.extlink` icon —
  `help/images/extlink.png` is already copied to dist).

## 7. Icons — inline SVG symbols (Q3 ✔)

As rev 1, now as `<symbol>` defs in the static shell referenced by `<use>`
(same-document refs work on file:// and inherit `currentColor`). House
conventions: hand-written 24×24, geometry in `currentColor`, hex accents only
where color carries meaning (precedents: chrome buttons in
[face-template.html:806](../src/face-template.html), noon-on-top half-disc at
[observatory.html:891](../src/observatory/observatory.html)). Set: partial
solar (sun with Moon bite), annular (bright ring, dark center), total solar
(dark disc, corona ticks), **hybrid** (diagonal annular/total split — Q3 ✔;
2013 Nov 3, 2023 Apr 20, 2031 Nov 14 in range), total lunar (disc filled
`#B00000` — the existing red accent, and the right color for a blood moon),
partial lunar (partially shadowed disc). Legend line links each kind name to
Wikipedia ([Solar eclipse](https://en.wikipedia.org/wiki/Solar_eclipse) type
anchors, [Lunar eclipse](https://en.wikipedia.org/wiki/Lunar_eclipse)).
Dark-only (#1e1e32 ground); no light theme exists anywhere in src/.
Mini icons also appear in year summaries (§4); the summary keeps its default
display so the native disclosure triangle survives (`display: flex` on
`<summary>` kills `list-item` markers) — inner spans do the layout.

## 8. Today marker, auto-open, auto-scroll (Q4 ✔ context)

All computed at render time by the page module (Date + DOM only):

- Marker element between the last past and first future card — id `today`,
  accent border, "— Today · ⟨date⟩ —" — inserted inside its year group, or
  between two groups when the boundary falls there (both neighbors are open,
  so it's visible either way).
- **Open set**: the year groups containing/adjacent to the marker
  (previous · current · next), derived from the marker position, not the
  calendar — which makes Dec/Jan behavior automatic. All others collapsed.
- **Auto-scroll** to the marker after the synchronous render — plain
  `scrollIntoView`, **not** rAF-wrapped (help.html's rAF-wrapped scroll
  precedent would break under the browser pane's frozen-rAF sessions; cards
  have no images/fonts so layout is already stable). Skipped when the URL
  carries a hash or the navigation is a reload (`history.scrollRestoration`
  respected). "Jump to today" + "Show all years" links sit above the list —
  the latter because **Safari's find-in-page does not auto-expand collapsed
  `<details>`** (Chrome/Firefox do), so Cmd-F "2034" needs an expand-all
  escape hatch on Steve's primary platform.
- Past cards get a dimmed class (opacity ≈ 0.75).
- Edge cases: **all rows past** → marker + a visible "this table has run
  out — regenerate (see the source note)" line rendered *outside/after* the
  groups and the last group force-opened (a marker inside a collapsed group
  has no layout box; scrollIntoView would silently no-op). All future →
  marker above the first group, first group open.
- **Staleness nudge**: if today is within ~1 year of `meta` coverage end, a
  one-line "coverage ends ⟨date⟩; re-run scripts/scrape-eclipses.mjs" note
  under the intro.

## 9. Deep links (Q4 ✔, Q5 ✔, Q6 ✔)

Unchanged from rev 1 in substance — both apps already support everything; no
app code changes. Built by the page module (§5); parameters parsed centrally
in [url-state.ts](../src/shared/url-state.ts) (doc block at :7).

- **Observatory**: `observatory.html?lat=…&lon=…&tz=…&t=⟨unixMs⟩&dir=0` —
  lat/lon skips the location prompt
  ([observatory-entry.ts:98](../src/observatory/observatory-entry.ts));
  `dir=0` arrives **frozen** at maximum (Q4 ✔ — `?t=` alone resumes 1×;
  applied at observatory-entry.ts:136); eclipse simulator activates from
  time + geometry, no param needed.
- **Chronometer**: `selected.html?picks=bsvzsl&body=⟨sun|moon⟩&lat=…&lon=…&tz=…&t=…&dir=0`
  — Basel `bs`, Venezia `vz`, Selene `sl` in display order (re-verify against
  generated [faces-list.ts](../src/faces/generated/faces-list.ts); the
  face-picker.md table is stale); `body=sun` on solar rows, **`body=moon` on
  lunar rows** (Q5 ✔) — the override reaches Venezia even on the
  selected-faces page ([watch-env.ts:230](../src/watch/watch-env.ts)).
- **`tz`** (Q6 ✔): explicit nearest-city zone in every link — the
  Chronometer resolves bare lat/lon zones from the city DB asynchronously
  ([engine-entry.ts:2883](../src/engine-entry.ts)) but the Observatory's
  startup path uses the synchronous resolver
  ([observatory-entry.ts:150](../src/observatory/observatory-entry.ts)),
  which falls back to the browser zone before the DB is parsed; explicit
  `tz` makes both deterministic, including on file://.
- **Percent-encode every parameter value** (found while building commit 1's
  manual-test harness, before it could reach the real page). An unencoded `+`
  in a query string decodes to a *space*, so `tz=Etc/GMT+5` arrives as the
  invalid zone `"Etc/GMT 5"`; `Intl.DateTimeFormat` rejects it with a
  RangeError and [`tzFormatter`](../src/shared/astro-env.ts) (astro-env.ts:99)
  has no try/catch, so this is a thrown error rather than a merely wrong
  clock. **26 of the 115 rows** carry a nautical `Etc/GMT+n` zone. Build links
  with `URLSearchParams`/`encodeURIComponent`, never string concatenation, and
  assert in the renderer test that every generated URL round-trips its `tz`
  through `new URLSearchParams(...).get('tz')` unchanged.
- Plain relative hrefs (flat dist siblings). **No `<base target="_blank">`
  on this page** — it would hijack the internal `#today`/expand-all anchors
  (help.html needs per-link `target="_self"` workarounds for exactly this);
  external links individually get `target="_blank"` + the extlink icon.
- Expected, not a bug: arriving with shareable params differing from stored
  state pops the standard incoming-settings dialog (save vs session-only;
  [app-state.ts:318,497](../src/shared/app-state.ts)); values display
  immediately either way. No special-casing.

**Verified during commit 1** against the existing 2.0.91 dist build (no page
needed — the deep-link contract is entirely existing app behaviour). Opening
`observatory.html?lat=25.2867&lon=-104.1383&tz=America/Monterrey&t=1712600238000&dir=0`
(the generated 2024 Apr 08 row): the location prompt is skipped, the app names
the location **Nazas** — the Durango town at that eclipse's greatest point —
adopts **America/Monterrey (CST) UTC−6:00** from `tz`, freezes the clock at
−2y 4mo 8d, and the incoming-settings dialog appears as predicted (choosing
"use for this visit only" left `ec:shared` untouched). Pixels were not
verified: the browser pane reported `visibilityState: hidden` and never fired
a single rAF, so the canvas stayed black — the known frozen-rAF pane
limitation. Visual confirmation moves to commit 2's headless pass (in a
session where rAF runs) or Steve's on-device flow.

### 9a. Deep-link epochs are stale for post-2027 rows (2026-08-18)

**Read this before building the cards.** `utcMs` in eclipse-data.json is
NASA's UT of greatest eclipse, which they formed as `TD − ΔT` using the
Espenak polynomial. As of
[planning/2026-08-18-leap-second-deltat.md](2026-08-18-leap-second-deltat.md)
the engine no longer uses that polynomial for modern dates: from 1972 through
the IERS leap-second table's expiry ΔT is exact, and past the expiry it
rejoins the polynomial with a continuity offset. Consequences for this page:

- **Rows through 2027 got better.** Exact ΔT moved every leap-era row closer
  to NASA's own maximum (2013 Nov 03 0.74″ → 0.32″ of disc separation;
  2020 Jun 21 0.89″ → 0.47″). Nothing to do.
- **Rows after the expiry are replayed a few seconds off maximum**, because
  NASA's ΔT prediction and ours deliberately differ — 79 s vs 72.4 s for
  2032, i.e. ~6.8 s, about 2.5″ at the rate the discs close. Following such a
  deep link lands the app slightly before greatest eclipse.
- **One row is already over the line**: 2032 May 09, a 22-second annular
  (NASA magnitude 0.9957, 44 km path) with only 3.17″ of annular margin. The
  app now draws a **partial** eclipse on a card labelled *annular*.
  `src/__tests__/eclipse-data.test.ts` carries a narrow, date-keyed exemption
  for it (`EPOCH_AMBIGUOUS`, with a rot guard) so the suite is green — that
  exemption is a marker for this work, not a resolution.

**The fix, when commits 2–3 touch the scraper anyway**: have
`scripts/update-leap-seconds.mjs`'s sibling `scrape-eclipses.mjs` keep NASA's
per-row ΔT — the century catalogs print it in their own `ΔT` column, already
parsed — and store `tdMs` (or `deltaTSeconds`) alongside `utcMs`. Then both
consumers can work in TD, which is the frame-independent quantity:

- the page builds `?t=` from `TD − ourΔT`, so the link lands on *our* maximum;
- the test replays at the same instant, which lets the 2032 exemption be
  deleted and makes the cross-check stronger for all 115 rows, not weaker.

Until then the coarse-margin rows are fine (15–30″ of slack); only the two
narrowest annulars in the set are sensitive, and both are documented.

## 10. Tests — data cross-check + the real renderer

New vitest (house style: `readFileSync` + `JSON.parse` — tsconfig has no
`resolveJsonModule`, and build.sh:69 runs `tsc --noEmit` over `src/**/*`, so
a JSON import would fail the build's type gate; precedent
[snapshot-utils.ts:77](../src/__tests__/snapshot-utils.ts)):

**Landed as [eclipse-data.test.ts](../src/__tests__/eclipse-data.test.ts) —
17 tests.** Each assertion below was checked to actually fail by mutating the
data and re-running (time shifted 30 min, hemisphere flipped, kind swapped,
tz corrupted, URL century changed, prose swapped, a year dropped, hybrids
dropped, the range truncated, path precision coarsened — all caught).

- **Data shape**: strictly increasing and inside the covered range; lat/lon
  ranges; kinds from the closed set; tz strings the platform's `Intl`
  accepts; EclipseWise URL section/prefix/type-letter agree with the row and
  its date is within a day of `utcMs` (TD − ΔT can roll back across
  midnight); serialized file free of `</script` / `<!--`.
- **Completeness**: per-year count 2–7 for *every* year (an average over the
  window hides a missing decade), both edge years present, and every one of
  the six kinds present — hybrids are the rare kind a type-mapping slip
  would silently drop.
- **Prose integrity**: `pathRegion` non-null for exactly the central solar
  eclipses. Region text is free-form, so nothing else can tell right prose
  from wrong; this invariant is what catches a column shift in the decade
  tables.
- **Engine cross-check**: for each row, `calculateEclipse`
  ([es-astro.ts:701](../src/astronomy/es-astro.ts)) at the row's moment and
  location agrees on kind. Conversions per the existing eclipse test
  ([eclipse.test.ts:25–38](../src/observatory/__tests__/eclipse.test.ts)):
  Apple-epoch **seconds** via `appleEpoch()`, **radians** via `toRad()`, and
  `cache=null` (location-keyed cache slots go stale across scans).
  **Result: 112 of 115 rows reproduce their published kind exactly.** The
  three that don't are the genuinely ambiguous ones and assert the geometry
  instead — both hybrids (whose discs are the same apparent size, i.e. the
  annular/total boundary itself) and the 2014 non-central annular (whose
  shadow axis misses the Earth) must show the discs concentric to within
  0.02°, a tighter claim about the ephemeris than any kind label. The rule is
  structural (`kind === 'hybrid-solar'`, or annular on catalog coordinates),
  so it survives a re-scrape over different years.
- Also spot-checked against independently known values: 2017 Aug 21, 2019
  Jul 02, 2024 Apr 08, 2026 Aug 12 and 2027 Aug 02 all match published
  greatest-eclipse times and positions to the minute.
- **Renderer/URLs**: import the exported builder from
  `eclipse-table-page.ts` and assert over the full dataset — `picks=bsvzsl`,
  `dir=0`, `t` equals the record's `utcMs`, `body` matches kind, tz/lat/lon
  round-trip; card markup contains the expected pieces (icon ref, UTC
  string, region as text). This keeps the coverage rev 1 had via static rows
  — without it, client rendering would be an untested dead zone.

## 11. Build & help-system wiring (Q8 ✔)

- **build.sh**:
  - Add `src/help/eclipse-data.json` to the preflight required-files check
    (build.sh:42) — awk's `getline` on a missing file silently injects
    nothing and exits 0 (verified empirically), which would ship a blank
    page.
  - New esbuild entry for `eclipse-table-page.ts` (index-page.ts stanza
    precedent, build.sh:84–87).
  - New static-page stanza (privacy/support pattern, build.sh:396–405):
    pipe `src/eclipse-table.html` through `inject_partials` with a new
    `{{ECLIPSE_DATA}}` token (path hardcoded like FACE_CARDS/INDEX_ORDER;
    `{{VERSION}}` is already handled inside inject_partials). Only
    `inject_partials` needs the token, but its `inject_partials_terra` twin
    must keep parsing.
- **Links in** (general help = the single help.html iframed into every app's
  ℹ popover, so one edit covers all apps):
  - [help.html](../src/help.html) `#eclipses` section: short pointer
    paragraph at the top of the section body (app-neutral wording — the
    `app=` script text-swaps product names). help.html's own
    `<base target="_blank">` makes it open a new tab from the popover and
    standalone. Known consequence: `app=inspector` drops `#eclipses`, so
    the Inspector's general help omits it — acceptable (dev tool).
  - help.html `.help-nav` (standalone only): "Eclipse table" entry.
  - Face/app fragments with **explicit `target="_blank"`** (in the popover
    only `http…` links are retargeted —
    [help-popover.ts:57](../src/shared/help-popover.ts) — a bare relative
    link would navigate the running app away):
    [basel.html](../src/help/basel.html) (~line 89, next to its existing
    help.html#eclipses link), [observatory.html](../src/help/observatory.html)
    (~line 272, by the 5-eclipses figure), and one-liners in
    [selene.html](../src/help/selene.html) and
    [chandra.html](../src/help/chandra.html) (Q8 ✔).
- **Docs**: page + regeneration procedure in
  [docs/help-system.md](../docs/help-system.md). file-categories.json needs
  no entry (committed generated file → git-tracked fallback category, same
  as cities-data.js).

## 12. Explicitly not changing

- No app code: deep links use only existing params; no eclipse-view forcing
  param, no astro-events-tab entries.
- No new npm dependencies (jsdom + node global fetch suffice).
- No light theme, no embed mode for the new page, no popover-iframe changes,
  no reorganization of help.html's existing sections.
- The scraper never runs inside build.sh (committed artifact verified by
  preflight, same as cities-data.js / altitude-table.bin).

## 13. Rejected alternatives

- **Scraping mreclipse.com** — coverage/columns/per-eclipse pages all
  insufficient (§2).
- **Computing the table with the in-repo engine** — event times/kinds
  feasible, but greatest-eclipse lat/lon + magnitudes need Besselian
  elements (absent), penumbral events are invisible to the umbra-only model,
  hybrid classification by brute force is fragile. The engine cross-checks
  instead (§10).
- **Pure `<table>`** (rev 1) — cramps or side-scrolls at phone widths;
  superseded by cards (0.1). Also rejected: dual table-desktop/cards-phone
  CSS (two layouts to maintain; cards work at every width).
- **Generated rows-HTML partial** (rev 1) — facts in two shapes and link
  construction outside test reach; superseded by JSON + bundled renderer
  (0.3).
- **Runtime-fetched JSON** — `fetch()` breaks on file://; the inline JSON
  block is the sanctioned offline pattern (index.html already injects JSON
  into a script block).
- **Table as a `<details>` section inside help.html** — popover iframe far
  too narrow; a pointer link gives the same reachability.
- **Upcoming-first reordering / decade tabs / filter chrome** for 0.4 —
  breaks chronology or adds paradigm; year groups + auto-open + auto-scroll
  achieve the near-now emphasis inside the existing idiom.
- **EclipseWise as scrape source** — actively maintained but no blanket
  reproduction grant and no verified single-page catalog; linked per-eclipse
  instead.

## 14. Risks & gotchas

Adversarial-review findings already folded into the design above: build
preflight for the JSON (§11), renderer as importable module (§5/§10),
`readFileSync` not JSON-import (§10), Apple-epoch/radians conversions (§10),
all-past scroll dead-zone (§8), no `<base target="_blank">` (§9), static
shell + `<noscript>` (§5), meta-driven coverage text (§5), Safari
find-in-page vs collapsed groups → "Show all years" (§8), synchronous
scroll not rAF (§8), `textContent` for region strings (§6), summary
display/list-item (§7), `</script` assertion (§3). Remaining:

- **Catalog markup detail unverified**: century pages are fixed-width text
  (sample row confirmed) but `<pre>`-vs-`<table>` structure and exact
  headers need eyeballing when writing the parser — hence the hard-fail
  posture. Decade pages 2021/2031 not individually fetched (endpoints
  verified); spot-check all eight URLs first.
- **EclipseWise per-eclipse coverage** inferred from linking patterns;
  spot-check a borderline hybrid before hardcoding the URL builder (the
  scraper HEAD-verifies every link anyway).
- **NASA pages are a frozen archive** (footers ~2013) — ideal for one-shot
  scraping; a re-run 5–10 years out may find them moved. Scraper header
  records URLs + the EclipseWise fallback idea.
- **Region text is coarse** ("Asia, Australia, Pacific") — descriptions
  inherit it; we compose "⟨Kind⟩ — ⟨region⟩" rather than synthesizing prose.
- **Hybrid/subtype normalization** needs explicit tables (Tn, A+, …).
- **Incoming-settings dialog** greets deep-link arrivals (§9) — expected;
  see it once on device before blessing the UX.
- Test builds auto-bump version.txt; use the fresh-port dist server +
  build-stamp check for verification runs.
- **Post-2027 deep links point a few seconds off maximum** since the
  leap-second ΔT change (2026-08-18) — harmless for all but the narrowest
  annulars, one of which (2032 May 09) already mislabels. Cause, blast
  radius and the fix are in §9a; the test exemption guarding it is
  `EPOCH_AMBIGUOUS` in `src/__tests__/eclipse-data.test.ts`.

## 15. Decisions (resolved 2026-08-16)

- **Q1** NASA GSFC scrape source + EclipseWise per-eclipse links + MrEclipse
  credited ✔
- **Q2** Penumbral lunar eclipses dropped, one intro sentence says why ✔
- **Q3** Hybrids get their own icon + Wikipedia-linked label ✔
- **Q4** Deep links arrive frozen (`dir=0`) ✔
- **Q5** `body=moon` on lunar rows, `body=sun` on solar ✔
- **Q6** Explicit `tz` from nearest city at scrape time ✔
- **Q7** One combined links line ✔ (subsumed by the card layout)
- **Q8** Also linked from Selene & Chandra help ✔
- **0.1/0.2** Cards with flex-wrap replace the table; per-year `<details>`
  groups keep it inside the existing help idiom — no new paradigm ✔
- **0.3** Single JSON artifact injected inline + bundled renderer module =
  one source of truth, testable links, file://-safe ✔
- **0.4** Near-now emphasis via marker-adjacent year groups auto-open +
  auto-scroll to today; distant years collapsed one tap away ✔

## 16. Future ideas (recorded, not proposed)

- Observatory astro-events tab has no eclipse entries; `eclipse-data.json`
  is now shaped to feed a next/previous-eclipse stepper later.
- Solar/lunar filter toggle if the list feels long in practice.
- Sticky year summaries while scrolling within an open group (pure CSS
  polish; only if it earns its keep visually).

## 17. Verification

Unit (vitest): §10 — data shape, engine cross-check, renderer/URL assertions
over the full dataset.

Headless (Browser pane, house recipes — build.sh, dist server on a fresh
port, verify the `build N.N.N` stamp; render + scroll are synchronous, so
frozen-rAF sessions don't matter):

- Page renders from the injected JSON; corrupting the JSON block in a scratch
  copy shows the visible error line, not a blank page.
- Year groups: correct open set around the marker; "Show all years" expands
  everything; summaries show year + count + mini icons.
- Today marker between the correct two cards; past cards dimmed; `#today`
  jump works; auto-scroll lands on it on a fresh load.
- Observatory link: location prompt skipped, display time == the row's `t`
  and frozen, incoming-settings dialog present (expected), eclipse simulator
  active for a solar row.
- Chronometer link: exactly Basel, Venezia, Selene in order; Venezia shows
  Sun for a solar row and Moon for a lunar row.
- Basel/Observatory/Selene/Chandra popovers show the new links opening in a
  new tab; general-help iframe's `#eclipses` shows the pointer;
  `app=inspector` help still renders (link absent, no errors).
- Phone-width pass in the pane (375 px): cards wrap, no horizontal scroll.

On device (Steve, dist.zip flow): card feel at phone width, tap targets,
deep-link round trips from the help popover, Safari find-in-page +
"Show all years", incoming-settings dialog UX.

## 18. Commit breakdown (Steve owns every commit)

1. **Scraper + data + data tests** ✅ done (uncommitted — Steve owns commits):
   `scripts/scrape-eclipses.mjs`, committed `src/help/eclipse-data.json`
   (115 eclipses, 2011–2041), `src/__tests__/eclipse-data.test.ts` (17 tests).
   `tsc --noEmit` clean, full suite 8606 passing, re-running the scraper
   reproduces the artifact byte-for-byte. No `file-categories.json` entry
   needed — a committed generated file falls to the git-tracked default,
   same as `cities-data.js`. Nothing else in the repo is touched, so this
   commit is inert until commit 2 wires the page.
2. **Page + build**: `src/eclipse-table.html` shell,
   `src/eclipse-table-page.ts` module, build.sh changes (preflight, esbuild
   entry, page stanza + token), renderer/URL vitest. Page reachable by URL
   but unlinked.
3. **Wiring + docs**: pointer links (help.html section + nav, basel,
   observatory, selene, chandra fragments), docs/help-system.md update.
