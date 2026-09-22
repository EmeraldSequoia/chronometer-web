# Plan: 44 px corner chrome, the ⋮ overflow menu, and Observatory chrome-drop → collapse

**Status**: IMPLEMENTED 2026-09-17 (build 2.0.133, uncommitted), including the phone-size rule from Steve's in-app review (§6) — Part 1 of
[2026-09-14-user-options-panel.md](2026-09-14-user-options-panel.md) (§3.1, §6).
**Created**: 2026-09-17
**Baseline**: c5ff2e3 (`Update with new owner for iPad Observatory app`)
**Decisions this implements** (parent §7): 1 (gear when there is room, ⋮
menu otherwise; collapsed corner = [⋮] [fullscreen]; fullscreen mode keeps
only the exit button; ⋮ is collapse-only) and 2 (44 px everywhere first,
glyphs unchanged, judge in situ). The gear itself and the Settings dialog
are Part 3; this part leaves the menu with a slot for them.

## 1. Scope

1. Every corner button on every app page gets a **44 × 44 px hit area and
   visible circle**; glyphs keep today's size. Pitch stays `BTN_GAP` = 8 px,
   so buttons sit 52 px apart.
2. A **shared ⋮ overflow menu** (button + dropdown), present on the face
   pages, Observatory and the Inspector, shown only when the corner is
   collapsed.
3. A **collapse rule per page**, latched per viewport size:
   - face pages — collapse when the full chrome set would force the grid to
     *shrink* (translating the grid is fine; shrinking faces is not);
   - Inspector — collapse when the full set cannot clear the header text in
     place (`dy > 0`);
   - Observatory — collapse when the header row (title + buttons) does not
     fit the viewport width.
4. **Observatory CC2 chrome-drop keeps a minimal floating [⋮] [fullscreen]**
   instead of hiding every control; the ⋮ menu carries Location and Time
   controller so the dropped footer's functions stay reachable.
5. index.html: sizes only. Its three buttons fit any phone; no menu until the
   gear (Part 3) makes it four, which still fits.

Out of scope: the gear button, the Settings dialog, the Got-it toast (Part
3); pointer-type sizing (kept as the fallback if desktop looks heavy).

## 2. Design

### 2.1 Sizing

| Page | Today | Now |
|------|-------|-----|
| Face pages | 36 px circles, 44 px pitch | 44 px circles, 52 px pitch (CSS defaults; the runtime engine re-derives positions from measured sizes + `BTN_GAP`) |
| Observatory header | 26 px circles in a 32 px band | 44 px circles; `HEADER_H` 32 → 48 (band = 44 + 4). Costs 16 px of dial height on height-bound layouts — part of the in-situ judgement |
| Inspector | 34 px | 44 px |
| index.html | 36 px | 44 px |

Glyph sizes (svg 16–18 px, ℹ 18 px) are untouched.

### 2.2 The ⋮ menu (`src/shared/overflow-menu.ts`, partials `overflow-menu.{html,css}`)

- Markup: `#more-btn` (three stacked dots, 44 px, same circle style as ℹ)
  and `#more-menu` (`role="menu"`, hidden). Injected by build.sh via
  `{{OVERFLOW_MENU}}` / `{{OVERFLOW_CSS}}` like the time controller.
- `initOverflowMenu({ app })` builds the rows from what the page has, in
  this order: *(Settings — Part 3)*, Share this view, Set location, Show /
  Hide time controller (label mirrors `#time-bar-label`), then this app's
  pages (face pages: Home, All faces, Selected faces, Edit selection —
  only the ones the page's body class shows), then the other apps, then
  About & help. Action rows `click()` the existing hidden button; page rows
  are `a.app-nav-link` anchors so `initAppNavLinks` wires them like every
  other cross-app link (the entry must call `initOverflowMenu` first).
- 44 px rows, dark panel (`rgba(26,26,46,0.96)`, no `backdrop-filter`),
  anchored under the button at the right edge. Closes on a row, outside
  pointer-down, or Esc. `aria-expanded` on the button.
- Visibility: `#more-btn` is `visibility: hidden` unless
  `body.chrome-collapsed` (face pages / Inspector) or
  `body.obs-chrome-collapsed` (Observatory); `body.is-fullscreen` hides it
  like the rest of the chrome. The menu closes when the corner un-collapses.

### 2.3 Collapse — face pages (engine-entry.ts `onGridResize`)

Today: `layoutGridWithChrome` returns `shrunk: true` when no chrome shape
fits even after translating. New: run it with the full set; if `shrunk`,
set `body.chrome-collapsed` and run it again with the collapsed group
(`[fullscreen-btn, more-btn]`, one `tr` group, `defaultSplit: 2`), then
apply. The decision depends only on the full set's result for this
viewport, so it cannot oscillate; the layout key gains the collapsed flag.
Folded items are hidden with `visibility: hidden` (not `display: none`) so
they keep measurable sizes for the full-set probe on the next resize.

### 2.4 Collapse — Inspector (`layoutTopChrome`)

Run the engine with the full set; if `result.dy > 0`, set
`body.chrome-collapsed` and re-run with `[more-btn]` alone (the Inspector
has no fullscreen button). Otherwise clear the class.

### 2.5 Collapse and chrome-drop — Observatory

- `updateHeaderCollapse()` (called from `resizeCanvas`): collapsed when
  `#obs-title` width + actions width + paddings > viewport width. Sets
  `body.obs-chrome-collapsed`; CSS hides the other actions (visibility)
  and shows `#more-btn`.
- CC2 dropped: `body.obs-chrome-dropped` no longer hides `#obs-header`; it
  keeps the header displayed with `pointer-events: none`, hides the title
  and every action but `#more-btn` / `#fullscreen-btn` (which get
  `pointer-events: auto`), exactly the pattern `is-fullscreen` uses today.
  The layout still reserves no header band (chromeParams is unchanged), so
  the two buttons float over the dial's empty corner. The entry sets
  `obs-chrome-collapsed` whenever `chromeDropped` is true.

## 3. Steps

1. Partials + build.sh injection (both `inject_partials` variants), and
   the two placeholders in face-template / observatory / inspector HTML.
2. `overflow-menu.ts`.
3. Face pages: CSS sizes, collapsed-state rules, engine-entry collapse
   logic, `initOverflowMenu` before `initAppNavLinks`, more-btn in
   `clearChromePositions`.
4. Inspector: CSS sizes, collapse in `layoutTopChrome`, init call.
5. Observatory: CSS sizes, `HEADER_H`, header collapse, chrome-drop rules,
   init call.
6. index.html sizes.
7. Tests: `chrome-layout.test.ts` gains a collapse-decision case on
   `layoutGridWithChrome` (full set shrinks → collapsed set doesn't).
8. Docs: new `docs/chrome.md` (corner chrome, engine, collapse rules, the
   menu), indexed in `docs/README.md`; `docs/inspector.md` cross-app
   navigation; `docs/observatory.md` CC2 step; help.html gets a short
   "Screen controls" section; `file-categories.json` for the new partials.
9. `tsc`, vitest, `bash build.sh`, browser-pane check at desktop and phone
   sizes on all.html, a single face, Observatory (portrait, landscape with
   insets → dropped), Inspector.

## 4. Implementation record (2026-09-17)

Everything in §3 landed as planned, with two refinements found while
verifying:

- **Collapse tolerance.** "Collapse only on shrink" was too lax: the engine's
  L shape clears a single phone face in place, but other cases would have slid
  the grid a long way down instead of folding. The face pages and the
  Inspector now share `CHROME_COLLAPSE_DY_PX` = 24 (chrome-layout.ts): the
  content may be nudged that far; more, or any shrink, collapses
  (`chromeShouldCollapse` in grid-layout.ts, unit-tested at 375×812 single
  face → no collapse, 320×568 single face → collapse, 375×812 all-faces →
  collapse, 1920×1080 → no collapse).
- **Observatory folding.** Folding the header buttons with `display: none`
  made the menu builder think the page lacked them (it treats `display: none`
  as "not on this page", which is how all.html's own link is excluded). They
  now fold with `visibility: hidden; position: absolute` — out of the flex
  row, still measurable, still "present".

Verified in the browser pane (DOM state; the pane's compositor does not
repaint after a viewport change, so pixels came from headless Chrome against
the dist server with a seeded profile):

| Page | Size | Result |
|------|------|--------|
| all.html | 1024×768 | full set, 44 px circles, no collapse |
| all.html | 375×812 | collapsed: [⋮] [⛶] at (263,16)/(315,16); menu = Share, Set location, Show time controller, Home, Selected faces, Observatory, Inspector, About & help; Esc closes |
| terra.html | 375×812 | full set kept (L shape clears the face at dy = 0) |
| terra.html | 320×568 | collapsed; face 296 px (not shrunk) |
| observatory.html | 1280×800 | full header, 48 px band |
| observatory.html | 375×812 (fresh load) | collapsed: title + [⋮] [⛶]; menu has all six rows |
| observatory.html | 600×300 (CC2 dropped) | header floats [⋮] [⛶] with pointer-events off elsewhere; title and footer hidden; menu carries Set location + time controller |
| inspector.html | 375×812 | collapsed to [⋮]; menu = Share, Set location, Show time controller, Chronometer, Observatory, About & help |

`tsc` clean; 8776 tests pass (34 in chrome-layout.test.ts, four new).

## 5. In-situ judgement (Steve)

- Are 44 px circles too heavy on desktop? If so: pointer-type sizing
  (`any-pointer: coarse`), a one-line CSS change per page.
- Observatory: is the 16 px taller header band acceptable on landscape
  layouts?
- Does the face-page collapse fire where expected (phones: yes; desktop
  windows: only when very short)?

## 6. Revision after Steve's in-app review (2026-09-17, build 2.0.133)

Steve's verdict on §5: **desktop is fine** — 44 px is a small share of a
desktop window, so no pointer-type fallback; **Observatory's taller header is
fine**; but **on a phone the icons are noise even when they fit**, including
on an iPhone 18 Pro Max. Decision: *every phone-sized viewport collapses to
the ⋮ menu*, a general rule rather than an engine outcome.

- `PHONE_SHORT_SIDE_PX` = 500 and `isPhoneSizedViewport(w, h)` in
  `chrome-layout.ts`: short side ≤ 500 CSS px, so portrait and landscape
  alike. The largest phones are ~440–480 on the short side, the smallest
  tablets ~600–744; nothing real sits near the threshold, which therefore
  only matters for small desktop windows (where collapsing is also right).
- Applied as the first collapse condition on the face pages, the Inspector
  and Observatory; the engine / width rules of §2.3–2.5 remain for larger
  viewports.
- **index.html now has the menu too** (the rule is general): its three
  corner buttons fold on phones; the phone rule is its only collapse rule.
  Menu there = Observatory, Inspector, About & help (the index has no visible
  location control to mirror; the `l` hotkey is unchanged).
- A collapsed single-face page keeps the **face name beside the ⋮**
  (Steve, 2026-09-22 — a first cut put it in the menu as a header row; that
  is gone). The collapsed corner is `[⛶] [⋮] [name]`, one row from the
  corner inward; the engine already treats the name as a chrome item.
- **Menu rows carry icons** (Steve, 2026-09-22; build 2.0.135): each row
  clones its corner button's icon — svg, app thumbnail, or the ℹ glyph — with
  the button's computed colour, into a 24 px icon column; Set location and
  the time controller, whose corner controls are text buttons, keep an empty
  column so the labels align.
- **Row order** (Steve, 2026-09-22; build 2.0.136): this app's pages, the
  other apps, then Share / Set location / time controller, then About & help
  — the actions sit at the bottom just above help on every app.
- Tests: two more cases in `chrome-layout.test.ts` (phones in both
  orientations, iPad mini and desktops excluded, inclusive threshold on the
  short side only). 8781 tests pass; `tsc` clean.
- Verified in the pane on build 2.0.133: terra.html full set at 1024×768,
  collapsed at 440×956 (face 416 px, unshrunk; menu headed "Terra") and at
  956×440; index.html collapsed at 440×956 (About & help opens the popup and
  closes the menu) and full at 1024×768; Observatory and Inspector collapsed
  at 440×956.

## 7. The menu in landscape on iPhone Safari (analysis 2026-09-22; decision and fix below)

**Report (Steve).** In landscape on an iPhone, Safari's bottom tab row stays
visible on Observatory and the Chronometer pages and the open ⋮ menu runs off
the bottom (About & help partly off-screen). On the Inspector, Safari's tab
row is *not* shown unless the user pulls down at the bottom — the behaviour
Steve prefers.

**Why the Inspector differs.** Safari minimizes its toolbars only when the
root document can scroll. The face pages and Observatory pin the document:
`html, body { height: 100%; overflow: hidden }` (face-template.html:17–24,
observatory.html:19–24), so the page is never scrollable and Safari keeps its
chrome. The Inspector's `html, body` are `height: 100%` **without**
`overflow: hidden` (inspector.html:19–28), while `#app` is `height: 100vh`
(inspector.html:33–40) — and on iOS `100vh` is the *large* viewport, the one
with the toolbars minimized. So while the toolbar is showing, `#app` is
taller than the body by exactly the toolbar height, the document overflows by
that much, and Safari treats it as a scrollable page: it collapses its chrome
and only restores it when the user drags the page back down. That is the
"pull down to reveal" Steve sees. Nothing in the Inspector asks for it; it is
a side effect of `100vh` vs `100%`.

**Two separate problems.**

1. *The menu can be taller than any landscape viewport.* A single-face
   Chronometer menu is nine 44 px rows plus separators ≈ 470 px; an iPhone in
   landscape is 375–440 px tall before Safari takes anything. Observatory's
   six rows (≈ 330 px plus the 66 px top offset) fit only when Safari's bars
   are hidden. So the menu needs to fit on its own, independent of Safari.
2. *Safari's chrome on non-scrolling pages.* Whether the face pages and
   Observatory should behave like the Inspector.

**Suggestion for 1 (do this regardless):** cap the dropdown at the *visual*
viewport and let it scroll inside: `#more-menu { max-height: calc(100dvh -
<top> - 8px); overflow-y: auto; overscroll-behavior: contain }`, with the
top computed as now (`100dvh` tracks Safari's dynamic toolbar, iOS 15.4+;
fall back to `100vh`). Cheaper than a two-column landscape layout, and it
keeps the 44 px rows. Optionally raise the menu's top in landscape (overlap
the ⋮ button) to recover ~50 px.

**Suggestion for 2 (needs an on-device feel pass):** give the face pages and
Observatory the same overflow the Inspector has by accident, deliberately —
size the app to the large viewport (`100lvh`, or `100vh` on iOS) while the
body stays at the small one, so the document can scroll by exactly the
toolbar height and Safari collapses its chrome. Two cautions: (a) the root
becomes scrollable, so a drag on anything *not* covered by `touch-action:
none` / pointer capture (the header, footer, time bar) will scroll the page
by that amount instead of being inert — the Observatory canvas is already
`touch-action: none` with pointer capture, so map drags and scrubs are safe,
but the footer controls would move; (b) layout math that reads the viewport
height (Observatory `computeLayout`, the face grid's ResizeObserver) must
keep using the *visual* height or the dial will be sized for a viewport that
is partly under Safari's bars. Do this after 1, and only if the on-device
feel is right; the Inspector's behaviour is a good sign but it was never
designed.

**Also worth saying in help:** a page added to the home screen runs
standalone (the manifest already declares it) with no Safari chrome in any
orientation — the only way to get a fully clean landscape on iPhone, since
element fullscreen does not exist there.

**Decision (Steve, 2026-09-22):** keep the apps non-scrolling — early on they
scrolled and the view could end up partly off-screen, which was worse than
Safari's toolbar. So suggestion 2 is dropped; suggestion 1 is implemented
(build 2.0.137): the menu is capped at the visible area below the button
(`100dvh`, `100vh` fallback, bottom safe-area inset subtracted) and scrolls
inside itself; a resize re-positions an open menu instead of closing it (the
pages close it on un-collapse). The general help's Screen Controls section
now also tells phone users that adding the page to the home screen gives the
app the whole screen with no browser controls in either orientation.

**Bug (Steve, 2026-09-22, iPhone landscape): a tap on a menu row opened the
map's Keep/Revert popup.** Cause: in the CC2-dropped state `#obs-header` is
`pointer-events: none` so presses fall through to the dial, with only the ⋮
and fullscreen buttons opted back in — and `#more-menu` is inside that header,
so its rows inherited the pass-through and the tap reached the map band
directly beneath (the landscape layout puts the map under the header
buttons). Fix (build 2.0.138): `#more-menu { pointer-events: auto }` in the
shared menu CSS, so the menu is hit-testable whatever its ancestors do.
Verified in the pane at 600×300 (dropped): `elementFromPoint` on a row hits
the row, and a real click on a row opens its target with no Keep/Revert.
