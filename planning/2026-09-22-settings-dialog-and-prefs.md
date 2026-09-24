# Plan: the Settings dialog, device preferences, and the ⚙ button

**Status**: IMPLEMENTED 2026-09-22 — Part 3 of
[2026-09-14-user-options-panel.md](2026-09-14-user-options-panel.md) (§4, §6
row 3, decisions §7), folding in Part 7 (the Low power toggle) now that the
pacer (Part 2) exists. Started from
[2026-09-22-options-panel-handoff.md](2026-09-22-options-panel-handoff.md).
**Created**: 2026-09-22
**Baseline**: 8dd7a8b (`Cap fps at smallest even fraction of vsync rate that is >=60fps`, build 2.0.142)
**Record**: [docs/preferences.md](../docs/preferences.md) is the living
description; this file is the plan and the implementation notes.

## 1. Scope (from the handoff, §2)

1. `src/shared/prefs.ts` — device preferences in their own `ec:prefs` blob,
   never in `UrlState`, share links or the incoming-settings comparison;
   query-string fallback for file:// without storage; cross-tab events.
2. A dedicated Settings dialog on the incoming-settings modal conventions:
   blur behind (no `backdrop-filter`), park the render loop, Esc, hotkey `,`.
   Rows on every page: Keep screen awake, Low power, Observatory noon-on-top,
   Forget my settings on this device (confirmed).
3. ⚙ next to ℹ on the face pages, Observatory, Inspector and index, in every
   collapse / fullscreen list; the ⋮ menu gets `Settings…` first.
4. The Got-it toast: every load until clicked; no auto-dismiss, no ×.
5. Observatory's footer noon disc + pill removed; `setNoonOnTop` the single
   setter.
6. Keep screen awake via the Wake Lock API.
7. Low power: `pacer.setTargetFps(LOW_POWER_FPS)`.
8. Docs, help, README, hotkey tables.

## 2. Design choices made while building

- **prefs.ts modes.** Decided like app-state's backend (`storageWorks()`,
  then protocol) but independently of it: in storage mode prefs go to
  storage even while a shared link is being prompted (app-state is
  temporarily on the URL backend then) — a preference is not a setting to
  "save or keep for the visit". Only `true` is stored; false deletes.
  `setPref` notifies this tab too (app-state's `onSharedChange` is
  cross-tab only), because the entries must hear their own dialog.
- **Got-it flag in `ec:meta`** (`optionsSeen`, beside `noticeSeen`), with
  the same url-mode fallback as the prefs (`optseen=1`). The notice yields
  to a toast already on screen (the paradigm notice on a first visit)
  rather than stacking, and returns on the next load.
- **Reading `onoon` from other apps.** `getState()` merges only `shared` and
  the running app's namespace, so the Chronometer / Inspector pages could
  write `onoon` (routing is by field) but not read it back. Added
  `getAnyAppField(field)` to app-state: the field from whichever namespace
  holds it. On the Observatory the row uses the live setter instead so the
  dial animates.
- **No park** (revised 2026-09-23, see §5). The first cut parked the loop
  like help; it now keeps running under the dialog. Opening still closes
  the help popover and the ⋮ menu first, so only one overlay is ever up.
  The Escape handler is captured on `window` and stopped so the face pages'
  Escape ladder (a document listener that closes the topmost dialog) does
  not fire as well.
- **Gear placement: outboard of ℹ** everywhere, so the buttons users know
  keep their places (memory: chrome buttons keep stable positions). Face
  pages: canonical order `fullscreen, info, face-name, settings, share, …`
  so the name keeps the top row when the row must shorten, and `rowOrder`
  puts the gear between ℹ and the name whenever both are rowed. The CSS
  defaults moved the name to `right: 172px`.
- **Blur rule in the shared modal CSS** rather than per page:
  `body.ec-settings-open > *:not(.ec-modal-backdrop):not(#app)` and
  `> #app > *` — the face pages wrap content in `#app`, whose fixed
  descendants a filter on `#app` itself would re-anchor (the same split the
  pages' `help-open` rules make).
- **Forget** confirms in a small modal of its own over the dialog (revised
  2026-09-23; the first cut was an inline swap), clears `ec:*` in both
  storages, then `location.replace(pathname)` — the clean URL also drops
  url-mode state and `?fps`.
- **Index page**: `closeHelpPopover()` used to return true without closing
  there (its popup is wired inline, no setter); it now clicks `#info-close`
  as the fallback.
- `LOW_POWER_FPS` = 10, the plan's lower bound; to be tuned natively.

## 3. Verification

- `npx tsc --noEmit` clean; vitest: new `prefs.test.ts` (modes, deletion of
  false flags, notifications, share-link exclusion, URL cleaning leaves the
  keys, forget), `wake-lock.test.ts` (acquire / release / re-acquire after
  hide, in-flight flip), `settings-dialog.test.ts` (rows and writes, park
  hooks, Esc capture, Forget flow, the notice's rules, the ⋮ row), and a
  Low power case in `frame-pacer.test.ts` (10 fps uniform on 120 and 60 Hz,
  back to 60 on the fly).
- Browser pane on the dist build (DOM state; the pane's compositor does not
  repaint after a resize): see the implementation record below.

## 4. Implementation record (2026-09-22, build 2.0.145)

Everything in §1 landed. `tsc` clean; 8829 tests pass (33 new). Verified in
the browser pane against the dist server (DOM state; the pane's tab is
`visibilityState: hidden`, so rAF is frozen and the pacing itself is covered
by the unit test, not the pane):

| Page | Size | Result |
|------|------|--------|
| terra.html | 1280×800 | top row from the corner: ⛶ (1220) ℹ (1168) ⚙ (1116) name (1052); share in the column below ⛶; notice up. `,` opens the dialog (focus on it; `#app > *` and the toast `blur(6px)`, backdrop unfiltered); rows Keep screen awake / Low power / Observatory noon + Forget; Low power → `ec:prefs {"lowpower":true}`; Esc closes and clears the blur without touching help; Got it → `ec:meta.optionsSeen`, toast gone; the ⚙ reopens it with Low power checked, Done closes; with help open, ⚙ closes help and opens Settings |
| terra.html | 440×956 | `chrome-collapsed`: name (264) ⋮ (328) ⛶ (380), ⚙ folded (`visibility: hidden`); menu rows Settings…, Home, All faces, Selected faces, Observatory, Inspector, Share this view, Set location, Show time controller, About & help (4 separators; the Settings row carries the gear svg); the row opens the dialog (408 px wide, rows 63 / 64 / 64 / 45 px); Esc closes |
| observatory.html | 1280×800 | header order chronometer, inspector, ⚙, ℹ, share, ⋮, ⛶; no `#noon-icon` / `#noon-toggle`; footer = time bar + location controls; notice carries the Midnight / Noon sentence; the noon row (unchecked) → checked writes `ec:observatory {"onoon":true}`; header blurred while open; Esc; Got it |
| observatory.html | 440×956 | `obs-chrome-collapsed`: ⚙ folded (`position: absolute; visibility: hidden`), ⋮ (332) ⛶ (384); menu Settings…, Chronometer, Inspector, Share this view, Set location, Show time controller, About & help; the row opens the dialog, Done closes |
| inspector.html | 1280×800 | share (1224) ℹ (1172) ⚙ (1120) Observatory (1068) Chronometer (1016); `,` opens, Done closes |
| index.html | 1280×800 | ℹ (1205) ⚙ (1153) Inspector (1101) Observatory (1049); with the help popup open, ⚙ closes it (the new `closeHelpPopover` fallback) and opens Settings with all three rows |

Refinement found while verifying: a CSS `filter` makes an element the
containing block of its `position: fixed` descendants. The shared blur rule
is therefore the generic `body > *` form, and the two pages that wrap their
content in `#app` override it beside their own help-open rules: the face
pages filter `#app > *` (as their help rule already did), and the Inspector
— whose `#app` is a centred 600 px column holding the fixed corner buttons
inside `.pinned-top` — filters `.pinned-top > *` and `.catalog`. Measured
in the pane on 2.0.144 before the fix: the Inspector's share button sat at
x = 884 instead of 1224 while the dialog was open (and, it turns out, had
always done so under the help popup, which the same override now fixes);
on 2.0.145 it stays at 1224 with either overlay up. The dialog container
also no longer shows a focus ring when opened from the keyboard (it takes
focus so Esc and Tab start inside it).

Real pixels (headless Chrome against the dist server, a scratch page
seeding storage and dispatching `,` into a 1280×800 iframe): the dialog with
its three switch rows, Forget and Done over the blurred face page with the
notice toast blurred beneath, and over the blurred Observatory dial.

For Steve natively: the dialog's look; Low power on the 120 Hz laptop
(`?fps` tail should read `p100 120Hz` at ~10 fps in steady state, the
display's rate while scrubbing) and whether 10 fps is the right cap; Keep
screen awake on the phone; the notice on first load of each app; the
Observatory without its footer disc.

## 5. Review round 1 (Steve, 2026-09-23; build 2.0.146)

Changed now:

- **Forget button centred**, with a top margin setting it off from the
  switches (`.ec-settings-action`).
- **Forget confirmation is its own modal** on top of the Settings dialog
  (`.ec-modal.ec-confirm`, own backdrop, Cancel / Esc / backdrop back out,
  focus returns to the button; closing Settings takes it along). Its text
  names today's scope explicitly: everything, for all three apps.
- **Noon-on-top animates again.** Cause of the snap: the dialog parked the
  loop like help does, so the toggle rendered one frame and
  `resyncAfterGap()` on close finished the sweep in a jump. The dialog no
  longer parks (rationale in §2 and docs/preferences.md): the sweep plays
  behind the blur, and Low power's cadence shows at once. The
  `onOpen / onClose` options are gone; `helpOverlayOpen` is help-only again.

Deferred to a plan of their own — no code changed for them:
[2026-09-23-settings-sections-and-forget-scope.md](2026-09-23-settings-sections-and-forget-scope.md)
(per-app sections with rules + titles, app rows only on that app's pages,
the exact scope of Forget, the notice's text and its unreadable ⚙ glyph).
Steve answered its questions the same day (Chronometer section omitted
while empty; Forget = everything; app-neutral notice text with the
Observatory sentence only there; miniature buttons for the icons) and added
one more item — retire the storage-paradigm notice, so a new user sees one
popup, not two. That plan was implemented 2026-09-23 (build 2.0.148) and
lands in the same commit as this part.

