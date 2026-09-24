# Corner Chrome

The top corners of every app page carry the page's buttons: ℹ help, ⚙ settings
([preferences.md](preferences.md)), share,
fullscreen, the cross-app links, and on the face pages the navigation links
(home, all faces, selected faces, edit selection) and the face name. This doc
covers how they are sized, laid out, and folded away when they would cost
content. It is the implementation record of Part 1 of
[planning/2026-09-14-user-options-panel.md](../planning/2026-09-14-user-options-panel.md)
(plan: [planning/2026-09-17-chrome-targets-and-overflow-menu.md](../planning/2026-09-17-chrome-targets-and-overflow-menu.md)).

## Sizing

Every corner button is a **44 × 44 px** circle (the platform touch-target
minimum: Apple HIG 44 pt, Material 48 dp), on every page and every pointer
type; glyphs inside stay at their historical 16–18 px. Adjacent buttons sit at a
52 px pitch (`BTN_GAP` = 8 in `src/shared/chrome-layout.ts`), 16 px in from the
viewport edges (`EDGE_MARGIN`; the Inspector uses 12). The Observatory's header
band is 48 px (`HEADER_H` in `observatory-entry.ts`, mirrored into
`--obs-header-h`) so its buttons fit the band. If the 44 px circles ever prove
too heavy on desktop, the fallback is pointer-type sizing
(`@media (any-pointer: coarse)`), a one-line CSS change per page. (Judged in
the running app on 2026-09-17: fine on desktop, where 44 px is a small share of
the window; on phones the corner always collapses — see below.)

## The layout engine

`src/shared/chrome-layout.ts` is pure geometry shared by the face pages and the
Inspector: each corner's visible buttons form a group laid out as a row, a
column, or an L; the engine tries configurations in preference order against
the content the chrome must not cover (face circles on the face pages; the
header text and catalog on the Inspector) and reports the minimal downward
translate of the content that clears the best configuration. The face pages
compose it with the grid geometry in `src/watch/grid-layout.ts`
(`layoutGridWithChrome`): lay the grid out optimally, pick a chrome shape,
translate the grid down if needed (eating bottom padding), and shrink the faces
only as a last resort. `CornerGroup.rowOrder` keeps a button beside its usual
neighbours when it is pressed into the row, so reflows do not move buttons to
unexpected sides. The Observatory does not use the engine: its header is a
flex row.

## Collapse: the ⋮ overflow menu

The corner **collapses** to `[⋮] [fullscreen]` — on a single-face page
`[face name] [⋮] [fullscreen]`, the name staying beside the button — everything
else moving into the ⋮ menu, in two situations.

**1. Phone-sized viewports — always.** A short side of at most
`PHONE_SHORT_SIDE_PX` = 500 CSS px (`isPhoneSizedViewport` in
`chrome-layout.ts`) collapses every page, in portrait and landscape, whether or
not the buttons could be fitted: on a phone the icons are noise even when they
fit, including on the largest phones (Steve, 2026-09-17). The largest phones
are ~440–480 px on the short side and the smallest tablets ~600–744, so nothing
real sits near the threshold. The index page has only this rule.

**2. Larger viewports — when the buttons would cost content.** The rule is
per page, and each reads only the *full* set's result for the current viewport,
so it cannot oscillate between states:

| Page | Collapses when | Where |
|------|----------------|-------|
| Face pages | the full set would **shrink** the faces, or push the grid down by more than `CHROME_COLLAPSE_DY_PX` = 24 (`chromeShouldCollapse` in `grid-layout.ts`) | `onGridResize` in `engine-entry.ts`; `body.chrome-collapsed` |
| Inspector | the full set would push the header text down by more than the same 24 px | `layoutTopChrome` in `inspector-entry.ts`; `body.chrome-collapsed` |
| Observatory | title + buttons do not fit the viewport width, **or** CC2 dropped the chrome | `updateHeaderCollapse` in `observatory-entry.ts`; `body.obs-chrome-collapsed` |

On the face pages and the Inspector the folded buttons are hidden with
`visibility: hidden`, not `display: none`, so they keep measurable sizes for
the next full-set probe. The Observatory's buttons are flex items, so it hides
them with `display` and measures the full-set width once with both classes off.

**Observatory chrome-drop (CC2).** When the safe rect cannot fit the
time-controller panel (264 × 389, [time-controller.md](time-controller.md)) the layout drops the header and footer
bands. The footer is hidden, but the header now stays as a floating
`[⋮] [fullscreen]` over the dial's empty corner (the layout reserves no band for
it; presses fall through the transparent strip except on the two buttons, the
same pattern fullscreen uses). The ⋮ menu carries Set location and the time
controller, so the dropped footer's functions stay reachable — the footer
*row* itself stays displayed (a transparent strip) because the controller's
popover lives inside it; hiding the row had hidden the popover with it until
2026-09-23. Before this, a phone in landscape with a home-indicator inset
could lose every control.

**The menu** (`src/shared/overflow-menu.ts`; markup and appearance in
`src/partials/overflow-menu.{html,css}`, injected by build.sh as
`{{OVERFLOW_MENU}}` / `{{OVERFLOW_CSS}}`) builds its rows from the controls the
page has, in a fixed order: Settings… (the ⚙ dialog — on phones, where the
corner is always collapsed, this row is the way in), this app's pages (face
pages only, and only the
links the page's body class shows), the other apps, then the actions — Share
this view, Set location, Show / Hide time controller (label mirrored from the
time bar) — and last About & help. Each row carries the icon its corner button shows, cloned from that
button with its computed colour (svg, app thumbnail, or the ℹ glyph); the
text-only controls (Set location, time controller) keep an empty icon column
so labels align. Action rows `click()` the page's own hidden button, so each
dialog keeps one implementation; navigation rows are real anchors that mirror the page's own
link, poking that link's pre-navigation handler first so `app-nav.ts` flushes
the time state exactly as an icon hop would. 44 px rows; closes on a row,
outside pointer-down, or Esc (a resize re-positions it; the page closes it
when the corner un-collapses); no `backdrop-filter` (see
[performance.md](performance.md) on full-screen filters). Its height is
capped at the visible area below the button — `calc(100dvh − top − 8px −
env(safe-area-inset-bottom))`, `100vh` where `dvh` is unsupported — and it
scrolls inside itself beyond that: a single-face page's menu (~450 px) is
taller than any phone in landscape, and on iPhone Safari the toolbar comes
and goes. The apps themselves stay non-scrolling (a scrollable root would let
the view end up partly off-screen, which is why it was removed early on), so
the menu has to fit on its own. The ⋮ button is
collapse-only: it never appears on a wide layout, and `body.is-fullscreen`
hides it like the rest of the chrome — fullscreen keeps only the exit button.

The ⚙ Settings button sits outboard of ℹ on every page and folds with the
rest of the corner — see [preferences.md](preferences.md) for its placement
per page and the dialog it opens.

## Fullscreen

`body.is-fullscreen` (`src/shared/fullscreen.ts`; real API where available,
faux mode on iPhone) hides every corner control except the fullscreen button,
which holds the top-right corner. Overlays stay reachable by hotkey
(`h`, `t`, `l`, `,`).
