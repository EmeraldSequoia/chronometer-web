# Plan: corner chrome (ℹ + app-nav buttons) on the Eclipse Table page

**Status**: IMPLEMENTED 2026-09-25 (build 2.1.18, uncommitted) per Steve's
answers to the review questions (§7): ℹ **included** ("the goal is really to
provide the toolbar there, including the help button"); floating icons on
tablets; order as shown; one bundle. One deviation from the approved text,
found in the browser: the popup shell must precede `.help-page`, not follow
it (§3.5). Verification per §5 all green (§8).
**Created**: 2026-09-25
**Baseline**: 92d4d92 (`[iOS Backport only] Proposal for backporting the time controller…`)
**Trigger**: user report that `eclipse-table.html` lacks the "usual" set of
navigation buttons at the top. Follows ff2d69e (the Eclipses app icon on every
other page — [docs/chrome.md](../docs/chrome.md), [docs/eclipse-table.md](../docs/eclipse-table.md)).

## 1. Problem

The Eclipse Table is now reachable from every page's corner chrome, the ⋮ menu,
the ℹ popup's "Other Apps" section and the `e` key — but it is the only
reachable page with **no corner chrome of its own**. Once there, the only ways
out are the browser's back button and the per-card deep links, which carry a
frozen instant and a place (the wrong tool for "take me back to Observatory"),
and there is no ℹ to reach the general help, Privacy, Support or the version.

## 2. Scope — what "usual" means on this page

**In**

1. **ℹ About & help** — the same popup shell every other page has, wired by
   `shared/help-popover.ts`: About text, GitHub · Credits · Privacy · Support ·
   Disclaimer, the "Other Apps" section (own entry removed), the General Help
   iframe, and the version stamp. No per-page help fragment: the table
   explains itself at the top of the page. A link in the About text routes the
   iframe straight to the "Understanding Eclipses" topic.
2. The three cross-app links — Chronometer, Observatory, Inspector — as 44 px
   circles at the 52 px pitch, fixed in the top-right corner, styled exactly
   like the index page's row (`#observatory-link` / `#inspector-link` rules in
   `src/index.html`, plus the Chronometer icon the Observatory and Inspector
   pages use, `apple-touch-icon.png`).
3. The **phone-size collapse** into the shared ⋮ menu
   (`partials/overflow-menu.{html,css}`, `shared/overflow-menu.ts`), so the
   controls stay reachable on phones without four icons floating over the
   cards. The menu carries Chronometer / Observatory / Inspector / About & help.
4. Hotkeys: `h` (help), `?` (help → Keyboard Shortcuts), and `i` / `o` / `c` /
   `a` via `registerAppNavHotkeys()` (`e` is a no-op on its own page, as
   `go()` already handles).

**Out**, deliberately (each is a corner button elsewhere, none applies here):

| Button | Why not |
|---|---|
| ⚙ Settings | The dialog holds keep-awake, low-power and per-app options; this page has no render loop, no location, no app options. |
| Share | The page has no state; its URL *is* the share. |
| Fullscreen | A scrolling document. |
| Eclipses' own icon | The current-app rule (every page omits itself). |

## 3. Design

### 3.1 Placement and order

Fixed top-right row, from the corner outward: **ℹ** (right 16 px),
**Inspector** (68 px), **Observatory** (120 px), **Chronometer** (172 px). ℹ
takes the corner as on every page without ⚙/share/fullscreen; the app icons
keep the convention the other pages already follow — Inspector nearest the
corner where it appears (index), Chronometer outermost where it appears
(Observatory, Inspector) — so the icons sit where a user coming from any other
page expects. `z-index` above the page content, as on the index.

**Why fixed, not a static header row.** The page deliberately lands scrolled
to today's marker (`armTodayRecenter`), so a header that scrolls with the intro
would be off-screen on arrival — exactly when a visitor arriving from an app
wants the way back. A **sticky band** was considered and rejected: it costs
60 px of every phone viewport permanently, and the ⋮ collapse solves the phone
case already.

**Trade-off accepted (Steve, 2026-09-25).** The content column is 720 px wide
and centred; the row is 216 px wide. On viewports narrower than ~1150 px the
row floats over the column's top-right corner (y 16–60) and cards scroll under
that 44 px band, briefly covering a card's Observatory / Chronometer / Details
links as it passes. This is the same behaviour the index page's fixed row has
over its face grid. Nothing at the top of the column collides: the `h1`
("Eclipse Table", ~140 px, left-aligned) is clear at every width down to the
phone threshold, and the intro paragraph begins below y ≈ 80.

### 3.2 Collapse rule

Identical to the index page (docs/chrome.md: the phone rule only):
`isPhoneSizedViewport()` → `body.chrome-collapsed` hides ℹ and the three links
with `visibility: hidden` and shows `#more-btn` at the corner; wider viewports
never collapse (there is no content-avoidance engine to drive a second rule,
and §3.1 accepts the float). The ⋮ menu builds its rows from the controls
present, so it carries exactly Chronometer / Observatory / Inspector and About
& help — the other `ROW_SPECS` entries (Settings, Share, Set location, time
controller) find no element and are skipped.

### 3.3 Link behaviour and state mode

- `initAppNavLinks()` wires the hrefs. **No `markChronometerPage()`** here:
  this is not a Chronometer-family page, so `appNavHref('index.html')`
  substitutes the tab's last-viewed Chronometer page (sessionStorage record) —
  a visitor who came from Geneva returns to Geneva.
- **The page does not call `initAppState()`.** `navSearch()` asks
  `isPersistentMode()`, which reads `backend()`; that accessor lazily defaults
  to the URL backend when no app initialised state ("keeps call order
  forgiving", app-state.ts:599), so the links copy the page's own query
  string. On a clean arrival (every storage-mode hop is clean) that string is
  empty, so the outgoing links are clean too; in the file:// URL-state
  fallback the params ride along, which is the correct behaviour there; the
  `fps` diagnostic propagates either way. Calling `initAppState` instead
  would drag in the picks provider and the incoming-settings prompt for a page
  with no state — not wanted. A comment at the call site records this.
- Hotkeys: the page has no text inputs, so the registry's focus guard is moot;
  `#ek-expand` is an anchor.

### 3.4 The ℹ popup

- **Markup** mirrors the Inspector's (`src/inspector/inspector.html`, the
  `#info-overlay` block and the three `<template>`s), minus the per-page help
  fragment (`#help-content` / `help-template`) and the "your settings are
  saved" paragraph, neither of which applies. `initHelpPopover` tolerates both
  omissions (`helpTemplate?.content`).
- **About text**: what the table is, and a link
  `<a id="ek-help-eclipses" href="help.html#eclipses">Understanding
  Eclipses</a>` that `initChrome` intercepts to call
  `openGeneralHelpTopic('#eclipses')` — the popup's own iframe opens on the
  topic; without JS the link still reaches the standalone help page.
- **General help flavor**: the default (`help.html?embed=1`, as the index
  uses). The page is app-neutral — its links go to both apps — so the full
  general help is right; the Observatory/Inspector flavors drop sections and
  rename the app.
- **Sub-views**: Privacy / Support / Disclaimer through the shared
  `{{PRIVACY_CONTENT}}` etc. partials, with `{{APP_NAME}}` = **"Eclipses"** so
  their subtitles read "Emerald Eclipses for the Web", matching the page
  `<title>`. `build.sh` passes it (the one build change: line 491 gains
  `"" "Eclipses"`).
- **Frosted backdrop**: `body.help-open > *:not(#info-overlay) { filter:
  blur(6px) }` — the forward-filter pattern, never a `backdrop-filter`
  (docs/performance.md; the full account is on `#info-overlay` in
  `index.html`). The fixed corner controls are direct body children, so the
  filter never becomes a containing block for them (the Inspector's `#app`
  pitfall does not arise).
- `initHelpPopover({ app: 'eclipses' })` removes the page's own Other Apps
  entry; the `app` union in `help-popover.ts` gains `'eclipses'`. No
  `onOpen`/`onClose`: nothing to park.

### 3.5 Markup and build

`src/eclipse-table.html`:
- `{{OVERFLOW_CSS}}` and `{{HELP_SUBVIEW_CSS}}` inside `<style>`; the ℹ and
  link rules, the popup rules, the `body.chrome-collapsed` rules and
  `#more-btn { position: fixed; top: 16px; right: 16px }` (each page positions
  the button itself).
- At the top of `<body>`, outside `.help-page`: `#info-btn`, the three
  `a.app-nav-link` anchors (ids `inspector-link`, `observatory-link`,
  `chronometer-link`, `data-page` set) and `{{OVERFLOW_MENU}}`.
- Right after `{{OVERFLOW_MENU}}`, still before `.help-page`: the popup
  shell (§3.4) and the three templates. *Not* at the end of the body as on
  the other pages: this page's `<script>` sits inside `.help-page` and runs
  synchronously while the parser is still there, so `initHelpPopover` found
  no overlay when the shell followed it — the ℹ button did nothing and the
  page's own Other Apps entry survived (caught in §5.3, fixed by moving the
  markup; an HTML comment records why).

`build.sh`: line 491 passes the app name (§3.4); the page already runs through
`inject_partials`, which expands every placeholder used.

### 3.6 Script

Add `initChrome()` to `src/eclipse-table-page.ts`, called from the existing
bootstrap line beside `initPage()`, and returning early when
`#chronometer-link` is absent (the jsdom tests build their own fragments and
have no such element, so it stays a no-op there). Body: `initAppNavLinks()`,
`registerAppNavHotkeys()`, `initHelpPopover({ app: 'eclipses' })`, the `h` /
`?` hotkeys, the Understanding-Eclipses link handler,
`initOverflowMenu({ app: 'eclipses' })`, and the index page's
`updateChromeCollapse` (phone check on load and on `resize`,
`closeOverflowMenu()` when un-collapsing).

New imports: `shared/app-nav.js`, `shared/hotkeys.js`,
`shared/overflow-menu.js`, `shared/chrome-layout.js`,
`shared/help-popover.js`. None has import-time side effects (module-level
constants only; `hotkeys.ts` guards `window`), so the pure-logic tests are
unaffected. `app-nav` pulls `app-state` → `url-state` +
`incoming-settings-dialog` (~63 KB of source that this page never calls);
expect the 39 KB bundle to roughly double, still negligible beside the 1.4–5.9
MB engines. Measured after the build (§5). None of these modules reference
`__BUILD_VERSION__`, so the page's esbuild line needs no `--define`.

`shared/overflow-menu.ts`: widen `OverflowMenuOptions.app` with `'eclipses'`
(type-only; the option is unused at runtime).

*Alternative considered*: a separate `eclipse-table-chrome.ts` entry and
second `<script>`, keeping `eclipse-table-page.ts` renderer-only as its header
comment describes. Rejected (Steve, Q4): not worth a second bundle and build
step; the header comment gets one sentence about `initChrome` instead.

### 3.7 Styling detail

Copy the index page's rules verbatim (fixed, 44 × 44, `border-radius: 50%`,
`object-fit: cover` for the two `img` icons; the Inspector's gradient circle
and `#5ca0d3` glyph; the ℹ glyph in serif italic bold on the monochrome
circle), adjusting only the `right` offsets. Hover: the same `filter:
brightness(1.35)` / lighter circle.

## 4. Documentation

- `docs/chrome.md`: the intro names the Eclipse Table's reduced set; the
  phone-rule paragraph ("the index page has only this rule") gains the Eclipse
  Table; a row in the collapse table.
- `docs/eclipse-table.md`: the "not part of the help system" framing softened
  (the help pages still never host its content; the page's own ℹ popup embeds
  the general help like every page); a "Corner chrome" section; the File
  Inventory row for `eclipse-table-page.ts` mentions `initChrome`.
- `docs/help-system.md`: the Eclipse Table paragraph; "four popups" → five;
  a row for `src/eclipse-table.html`.
- Comments in `partials/overflow-menu.html` and `partials/other-apps.html`
  list the pages they are injected into — add the Eclipse Table.

## 5. Verification

1. `npm run typecheck`, `npx vitest run` — green. Extend the shell tests in
   `eclipse-table-page.test.ts` (they already read `src/eclipse-table.html`)
   with one assertion: the shell carries `#info-btn`, the three `app-nav-link`
   anchors with the right `data-page`s, no `#eclipses-link`, every placeholder
   the build expands, and the popup ids `help-popover.ts` looks up.
2. `bash build.sh`; note the new `eclipse-table-page.js` size; confirm the
   sub-view subtitles say "Emerald Eclipses for the Web".
3. Browser (dist server): desktop → four buttons at right 16/68/120/172, none
   over the `h1`; `h` opens the popup with Other Apps = Chronometer /
   Observatory / Inspector, the Understanding-Eclipses link opens the topic in
   the iframe, `?` lands on Keyboard Shortcuts, Esc closes; ~800 px → icons
   float over the column's top-right as accepted in §3.1; 375 × 812 →
   `body.chrome-collapsed`, ⋮ opens a four-row menu with the cloned icons and
   About & help works from it; `o` navigates to Observatory; after visiting
   `geneva.html` first, the Chronometer icon returns to Geneva, not the index.

## 6. Steps

1. Markup + CSS in `eclipse-table.html` (§3.4, §3.5, §3.7).
2. `initChrome()` in `eclipse-table-page.ts`; the `'eclipses'` union members
   in `overflow-menu.ts` and `help-popover.ts` (§3.6); `build.sh` app name.
3. Docs and partial comments (§4).
4. Build, tests, browser check (§5).
5. One commit.

## 7. Review decisions (Steve, 2026-09-25)

1. **ℹ button** — yes; the goal is the whole toolbar including help. Designed
   in §3.4.
2. **Float or band on tablets** — float, matching the index (§3.1).
3. **Order** — ℹ, Inspector, Observatory, Chronometer from the corner (§3.1).
4. **Single bundle** with `initChrome()` in the page module (§3.6).

## 8. Verification record (2026-09-25, build 2.1.18)

- `tsc --noEmit` clean; vitest 66 files / 8992 tests green (the shell test
  gained the corner-chrome assertion).
- `eclipse-table-page.js` 38.5 → 64.4 KB (§3.6 estimate held). Built page:
  every placeholder expanded; sub-view subtitles read "Emerald Eclipses for
  the Web".
- Browser, fresh dist server, 1000 × 800: ℹ / Inspector / Observatory /
  Chronometer at right 16 / 68 / 120 / 172, all visible, icons loaded, no
  `#eclipses-link`, page version and popup version both v2.1.18. `h` opens
  the popup: Other Apps = Chronometer / Observatory / Inspector; `.help-page`
  blurred, overlay not; the Understanding-Eclipses link keeps the page and
  routes the iframe to `#eclipses` with the section open; Esc closes; `?`
  (a real `key: '?'` event — the pane's `shift+slash` arrives as `/`) opens
  the iframe at `#hotkeys`.
- 375 × 812: `body.chrome-collapsed`, ℹ and links hidden, ⋮ visible; menu
  rows Chronometer / Observatory / Inspector / About & help with the cloned
  icons; About & help opens the popup from the menu.
- After visiting `geneva.html`, the Chronometer icon's href is `geneva.html`
  (last-face-page substitution); `o` navigates to Observatory.
