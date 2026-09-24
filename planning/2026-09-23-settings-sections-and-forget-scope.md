# Plan: Settings sections per app, "Forget" scope, the notice — and retiring the storage notice

**Status**: IMPLEMENTED 2026-09-23, build 2.0.148 — §2 sections (General on
every page; Observatory on observatory.html; the Chronometer section left
empty and skipped), §3 the Forget label, §4 the notice with `miniButton`
miniatures, §5 the paradigm notice retired, §6 tests (22 in
settings-dialog.test.ts), §7 docs and help. Decisions in §0 (Steve). The
uncommitted Part 3 work and this land as one commit; the miniatures'
readability (§4.2) is Steve's to judge natively. One addition found in the
pane: the longer text made the toast's phone-width defect visible (a fixed
box at `left: 50%` shrinks to fit the right half of the viewport — 220 px
wide and twelve lines tall at 440 px), so `.ec-toast.ec-notice` is now
`width: max-content; max-width: min(380px, calc(100vw - 32px))`.
**Follows**: Part 3 of
[2026-09-14-user-options-panel.md](2026-09-14-user-options-panel.md)
([2026-09-22-settings-dialog-and-prefs.md](2026-09-22-settings-dialog-and-prefs.md),
review round 1 in its §5); living description
[docs/preferences.md](../docs/preferences.md).
**Baseline**: build 2.0.146, the uncommitted working tree of 2026-09-23.

## 0. Decisions (Steve, 2026-09-23)

1. **Sections.** General preferences and app-specific ones are separated in
   the dialog by a section title and an hrule. App-specific rows appear
   **only on that app's pages** (Observatory rows on observatory.html;
   Chronometer rows on every Chronometer page). The Chronometer section is
   **empty today and is not rendered** (Q1: omit). The Inspector shows
   General only.
2. **Forget scope: everything** (Q2 = §3 option A): the location and time,
   watch-face choices and Terra / Gaia cities, Observatory's choices, the
   preferences and the notice flags — for all three apps, whichever page
   the button is pressed on. Said plainly in the label and the confirmation.
3. **Notice text**: the app-neutral text of §4.1, with the Midnight / Noon
   sentence appended **on Observatory pages only** (Q3).
4. **Notice icons**: miniatures of the real ⚙ and ⋮ buttons (§4.3 b).
   Steve is unsure they will read at that size and will judge natively
   once built (Q4).
5. **Retire the storage-paradigm notice** ("Your settings now save in this
   browser instead of the URL…", `maybeShowParadigmNotice` in
   app-state.ts). It is months since the deployed app kept state in URL
   parameters, and a new user getting two popups is confusing. The Settings
   notice becomes the only first-load toast.

## 1. Context for the implementing session

### 1.1 State of the tree

- The main checkout holds **uncommitted** work: Part 3 (+7) of the
  options-panel project and its review round 1 — 37 files on build
  2.0.146. `git status` lists them; do not stash or revert, build on top.
  What it is: [2026-09-22-settings-dialog-and-prefs.md](2026-09-22-settings-dialog-and-prefs.md)
  §4 (verification table) and §5 (the review round); what it does:
  [docs/preferences.md](../docs/preferences.md). Read those two and this
  file first; the parent plan's §7 decisions are all settled, and its §4
  line "show all rows on every page" is superseded by decision 1 above.
- `bash build.sh` bumps `version.txt` (tracked) — expected in the commit.
- `dist/` is untracked build output. `.claude/launch.json` has many
  `dist-freshNN` preview entries; `dist-fresh52` (port 8857) was used on
  2026-09-22/23 — add a new entry on an unused port (e.g. `dist-fresh53`,
  8859) so the browser pane's HTTP cache cannot serve stale pages, or use
  `?nc=N` query strings on navigations.

### 1.2 Files and the shapes in them

| File | What is there now |
|------|-------------------|
| `src/shared/settings-dialog.ts` (~300 lines) | `initSettingsDialog({ app, noonOnTop?, notice? })` wires `#settings-btn` and shows the notice; `openSettingsDialog()` builds the DOM on every open: `.ec-modal-backdrop > .ec-modal.ec-settings` → `h2.ec-modal-title`, `div.ec-settings-rows` holding rows from `switchRow(label, hint, checked, onChange)` (= `label.ec-settings-row > span.ec-settings-text(label + hint) + input.ec-switch[role=switch]`), the Forget row `div.ec-settings-row.ec-settings-action > button.ec-settings-forget` (opens `openForgetConfirm()`, a second `.ec-modal-backdrop.ec-confirm-backdrop > .ec-modal.ec-confirm` with `.ec-settings-forget-confirm` / `.ec-settings-forget-cancel`), then `.ec-modal-buttons > button.ec-settings-done`. The rows today: Keep screen awake (only if `isWakeLockSupported()`), Low power, "Observatory: noon at the top of the 24-hour dial" (uses `options.noonOnTop` on Observatory, else `getAnyAppField('onoon')` / `setState({ onoon })`). Esc is captured on `window` (confirm closes first). `maybeShowNotice(app)` yields if any `.ec-toast` is on screen, else `showSettingsNotice(...)`; `onOptionsSeen` removes the toast when another tab acknowledges. `__test__` has `setReload`, `isForgetConfirmOpen`, `reset`. |
| `src/shared/incoming-settings-dialog.ts` | The shared CSS string in `ensureModalStyles()` — `.ec-modal*`, `.ec-toast`, `.ec-toast.ec-notice` (z-index 999), `.ec-toast-btn`, `.ec-settings-*`, `.ec-switch`, `.ec-settings-action` (centred Forget row), `.ec-modal.ec-confirm`, the `body.ec-settings-open` blur rule. `showSettingsNotice({ observatory, onGotIt })` builds `div.ec-toast.ec-notice[role=status] > span(text) + button.ec-toast-btn("Got it")` and returns the toast. `showParadigmNotice()` (to delete, decision 5), `showStorageWarning()` (keeps `.ec-toast-close`), `showUrlModeBadge()`, `showIncomingSettingsDialog()`. |
| `src/shared/app-state.ts` | `maybeShowParadigmNotice()` (~line 591) and its two calls in `initAppState` (the clean-URL path and the identical-to-stored path, ~lines 511 and 523); the `showParadigmNotice` import (line 25). `getAnyAppField()` (after `getState`), added only for the cross-app noon read — unused once the noon row is Observatory-only. |
| `src/shared/prefs.ts` | `isOptionsSeen / markOptionsSeen / onOptionsSeen` (`ec:meta.optionsSeen`; `optseen=1` in url mode), `forgetAllSettings()` (every `ec:*` key in local and session storage). Header comment line 18 mentions app-state's `noticeSeen`. |
| Entries | `initSettingsDialog({ app: 'chronometer' })` in engine-entry.ts (inside `if (!isEmbedMode)`), `{ app: 'observatory', noonOnTop: { get: () => noonOnTop, set: setNoonOnTop } }` in observatory-entry.ts `init()`, `{ app: 'inspector' }` in inspector-entry.ts, `{ app: 'index' }` in index-page.ts. The `,` hotkey and `initKeepAwake()` sit beside each. |
| The buttons the miniatures copy | `#settings-btn` — `src/partials/settings-button.html`: a 44 px circle with an 18 px svg gear; `#more-btn` — `src/partials/overflow-menu.html`: a 44 px circle with a 20 px svg of three dots. Colours per page: face pages, index and Observatory `background: rgba(255,255,255,0.08); color: #889`; Inspector `rgba(255,255,255,0.06); color: #6b7280`. Read them from the live button's computed style rather than hard-coding (a folded button is `visibility: hidden` but its computed colours resolve; so do a `display: none` one's). |
| Tests | `src/__tests__/settings-dialog.test.ts` (16 tests): a `PAGE` fixture with `#app > #settings-btn, #info-btn, #more-btn, #more-menu, #info-overlay`; `beforeEach` seeds `ec:meta {noticeSeen}` (so `initAppState` shows no paradigm toast) then `initAppState({ app: 'chronometer' })`; helpers `modal()`, `rowLabels()`, `switchFor(label)`, `flip(input, on)`. `src/__tests__/prefs.test.ts` (uses `noticeSeen` only as a neighbouring key in the ec:meta merge test), `src/__tests__/adoption.test.ts` (seeds `noticeSeen` at ~line 61 "to keep the paradigm notice quiet"), `src/__tests__/app-state.test.ts`. |
| Docs & help | docs/preferences.md (rows table, storage-mode row mentioning `noticeSeen`, "The notice" section); docs/architecture-overview.md line 30 ("paradigm notice" in the file tree); src/help.html § Screen Controls, the Settings paragraph (~lines 1162–1174, lists the rows incl. "Observatory: noon…" and "Forget my settings on this device"); src/help/observatory.html § Noon on Top (~lines 333–343, names the row "Observatory: noon at the top of the 24-hour dial"); planning/2026-06-13-localstorage-state-and-sharing.md (the notice's origin — add a retirement note to its status line). |

### 1.3 Verification recipes (all worked on 2026-09-22/23)

- **Build & serve**: `npx tsc --noEmit`; `npx vitest run` (~15 s wall, 8830
  tests); `bash build.sh`; `preview_start` with a fresh `dist-freshNN`;
  confirm the build via the `v2.0.NNN` text in `#info-main-view`. Stop the
  server when done.
- **Seed** on the served origin, then navigate:
  `localStorage.setItem('ec:shared', JSON.stringify({lat:37.77, lon:-122.42,
  city:'San Francisco', tz:'America/Los_Angeles', lsrc:'city', v:1}))`. Do
  **not** seed `ec:meta` when the notice is under test (after decision 5
  nothing else needs it); seed `{optionsSeen:true, v:1}` to silence it.
- **The pane**: its tab is `visibilityState: hidden`, so rAF is frozen and
  the compositor does not repaint after `resize_window`; verify with
  `javascript_tool` reads (rects, computed styles, `elementFromPoint`,
  class lists). `resize_window` **before** `navigate` gives a correct
  initial layout at phone sizes (440×956 collapses every page). `computer
  key ","` drives the hotkey; `key "Escape"` the closes. A render loop can
  be run for a proof by reloading the page through `document.write` with a
  setTimeout-based `requestAnimationFrame` shim prepended to `<head>` (the
  `?fps` readout then updates; see the Part 3 plan §5).
- **Real pixels** (for the notice's miniatures): headless Chrome against
  the dist server, loading a scratch `dist/__shot.html` that seeds storage
  and opens the page in a 1280×800 iframe (delete the scratch page after):
  `perl -e 'alarm shift; exec @ARGV' 40 "/Applications/Google
  Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-first-run
  --user-data-dir=$S/prof --window-size=1280,800 --hide-scrollbars
  --virtual-time-budget=30000 --screenshot=out.png
  http://localhost:PORT/__shot.html`, then `pkill -f "$S/prof"` (Chrome
  never exits; every run burns the alarm). To open the dialog in the shot,
  the scratch page dispatches `new KeyboardEvent('keydown', {key: ','})`
  on the iframe's window after a 6 s timeout.

## 2. Sections (decision 1)

### 2.1 Layout

```
Settings
GENERAL ───────────────────────────────
Keep screen awake                    [ ]   (only where the Wake Lock API exists)
Low power                            [ ]
OBSERVATORY ─────────────────────────      (observatory.html only)
Noon at the top of the 24-hour dial  [ ]
      [ Forget all settings on this device… ]
                 [ Done ]
```

- A section is a title over an hrule: `div.ec-settings-section` with the
  title text and a `::after` line. CSS (in the shared string):
  ```css
  .ec-settings-section {
      display: flex; align-items: center; gap: 10px; margin: 14px 0 2px;
      font-size: 11px; letter-spacing: 1.2px; text-transform: uppercase; color: #889;
  }
  .ec-settings-section:first-child { margin-top: 0; }
  .ec-settings-section::after { content: ''; flex: 1 1 auto; height: 1px; background: #3a3a5e; }
  .ec-settings-section + .ec-settings-row { border-top: none; }
  ```
  (`.ec-settings-row` has `border-top: 1px solid #2e2e4a` with
  `:first-child` exempt; the last rule keeps the row under a title clean.)
- **A section renders only when it has at least one row.** Build the rows
  per section, skip empty sections, so no page ever shows a bare title.
- Row tables, decided by `options.app` (which `initSettingsDialog` already
  receives): *General* on every page — Keep screen awake (if supported),
  Low power. *Observatory* when `app === 'observatory'` — the noon row.
  *Chronometer* when `app === 'chronometer' || app === 'index'` — no rows
  today; leave the table in place, empty, with a comment pointing here, so
  a future row has a home (`index` counts as a Chronometer page: it reads
  the chronometer namespace and shows the face set).
- Suggested shape:
  ```ts
  const sections: Array<{ title: string; rows: Array<() => HTMLElement | null> }> = [
      { title: 'General', rows: [awakeRow, lowPowerRow] },
      { title: 'Observatory', rows: options.app === 'observatory' ? [noonRow] : [] },
      { title: 'Chronometer', rows: [] },   // no Chronometer-only preference yet (decision 1)
  ];
  for (const s of sections) {
      const built = s.rows.map((b) => b()).filter((r): r is HTMLElement => r !== null);
      if (built.length === 0) continue;
      rows.append(sectionTitle(s.title), ...built);
  }
  ```
  where `awakeRow` returns null when `!isWakeLockSupported()`.
- **The noon row** loses its prefix: label **Noon at the top of the
  24-hour dial**, hint *Otherwise midnight is at the top.* It is only ever
  built on the Observatory, where `options.noonOnTop` is supplied, so:
  make `noonOnTop` the row's only path (no `getAnyAppField` / `setState`
  fallback), and delete `getAnyAppField` from app-state.ts.
- **The Forget row** stays where it is — after the last section, centred,
  with its top margin — so the destructive action is last and visibly apart
  from any section. Its new label (§3) states the scope, so its position
  below the Observatory section cannot read as "Observatory only".

### 2.2 Not doing

Vienna's noon pill stays beside its face (parent decision 6); Kyoto's
toggles, Venezia's body and the Terra / Gaia cities stay in place. No
per-app reset rows (decision 2).

## 3. Forget — everything, said plainly (decision 2)

- Label: **Forget all settings on this device…** (was "Forget my settings
  on this device…"). Class names unchanged (`.ec-settings-forget`).
- The confirmation modal's copy, already accurate, stands: title *Forget
  your settings?*, text *This clears everything saved in this browser for
  all three apps — the location and time, watch-face choices and Terra /
  Gaia cities, Observatory's choices, and these preferences — and reloads
  the page.* Buttons Forget (danger) / Cancel (focused).
- Behaviour unchanged: `forgetAllSettings()` removes every `ec:*` key from
  localStorage and sessionStorage (`ec:shared`, `ec:chronometer`,
  `ec:slots`, `ec:observatory`, `ec:inspector`, `ec:prefs`, `ec:meta`,
  `ec:lastChronoPage`) and `location.replace(location.pathname)` reloads
  with a clean URL — which in url mode *is* the forget, and in in-memory
  mode discards the page's state. The Settings notice returns afterwards
  (a forgotten device is a new device); with decision 5 it is the only one.
- Help copy (help.html) and docs/preferences.md name the scope the same
  way.

## 4. The notice (decisions 3 and 4)

### 4.1 Text — one popup for all apps

`optionsSeen` is already device-wide (one Got it silences every app); only
the text changes, so it reads right on whichever page shows it first:

> Settings for Chronometer, Observatory and the Inspector — keep the screen
> awake, low power, and each app's own options — are behind the
> [⚙] Settings button at the top right (on a phone, the first row of the
> [⋮] menu).

On Observatory pages only, append: *The Midnight / Noon control now lives
there too.* (`showSettingsNotice({ observatory })` already carries the
flag.)

### 4.2 The miniatures

`[⚙]` and `[⋮]` are **miniatures of the real buttons**, not characters:

```ts
/** A small replica of a corner button — its svg cloned, its computed colours — for prose that points at it. */
function miniButton(id: string, fallback: string): HTMLElement {
    const box = document.createElement('span');
    box.className = 'ec-mini-btn';
    box.setAttribute('aria-hidden', 'true');
    const src = document.getElementById(id);
    const svg = src?.querySelector('svg');
    if (src && svg) {
        const cs = getComputedStyle(src);
        box.style.background = cs.backgroundColor;
        box.style.color = cs.color;
        box.appendChild(svg.cloneNode(true));
    } else {
        box.textContent = fallback;   // a page without the button (should not happen on the four app pages)
    }
    return box;
}
```
```css
.ec-mini-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; border-radius: 50%; vertical-align: middle; margin: 0 2px;
}
.ec-mini-btn svg { width: 15px; height: 15px; fill: currentColor; }
.ec-toast.ec-notice { line-height: 1.6; }   /* room for the 26 px miniatures in the line */
```
- Build the toast's text as a sequence of text nodes and the two
  miniatures (`span.append('…behind the ', miniButton('settings-btn', '⚙'),
  ' Settings button at the top right (on a phone, the first row of the ',
  miniButton('more-btn', '⋮'), ' menu).')`), so the words carry the meaning
  for screen readers and copies; the miniatures are `aria-hidden`.
- The glyph inside a 26 px circle is 15 px — larger than the 12.5 px ⚙
  character it replaces and drawn with the button's own teeth, but Steve
  expects to judge it in situ. If it still does not read: try 30 / 17 px
  (the toast grows a little), or drop the circle and keep the 17 px gear
  alone (§4.3 option a of the earlier draft).
- `showSettingsNotice` is called after the entries have wired the buttons
  (`initSettingsDialog` runs at the end of each entry's init), so both
  buttons exist in the DOM; on phones they are folded (`visibility:
  hidden`), which does not affect the clone or the computed colours.

### 4.3 Where the miniatures come from, for reference

The ⋮ menu already clones button icons this way (`iconFor` in
`src/shared/overflow-menu.ts`: `svg, img` cloned, `currentColor` resolved
from the button's computed colour). Keep `miniButton` in
incoming-settings-dialog.ts beside `showSettingsNotice`; do not import
overflow-menu.ts there.

## 5. Retire the storage-paradigm notice (decision 5)

1. `src/shared/app-state.ts`: delete `maybeShowParadigmNotice()` and its
   two calls in `initAppState` (both `return` paths keep everything else —
   `activeBackend = ls`, and on the identical-to-stored path
   `clearShareableParamsFromUrl()`); drop `showParadigmNotice` from the
   import on line 25. Nothing else reads `noticeSeen`; values already on
   devices are harmless (and Forget removes `ec:meta` anyway).
2. `src/shared/incoming-settings-dialog.ts`: delete `showParadigmNotice()`
   (keep `.ec-toast-close` CSS — `showStorageWarning` uses it). Update the
   comment on `showSettingsNotice` ("Unlike the paradigm notice…") to
   describe it on its own terms: no auto-dismiss, no ×, Got it records it.
3. `src/shared/settings-dialog.ts`: keep the "yield to a toast already on
   screen" rule — `showStorageWarning`'s toast (in-memory mode) is also an
   `.ec-toast` and the two should not stack — but reword its two comments
   (header ~lines 29–33, `maybeShowNotice` ~line 83), which name the
   paradigm notice.
4. `src/shared/prefs.ts` header (line ~18): "beside app-state's
   `noticeSeen`" → just "in `ec:meta`".
5. Tests: remove the `noticeSeen` seed and its comment from
   `settings-dialog.test.ts` `beforeEach` and from `adoption.test.ts`
   (~line 60–61); in `prefs.test.ts` the ec:meta merge test may keep a
   neighbouring key but call it a legacy key. Grep `aradigm|noticeSeen`
   under `src/` afterwards: only prefs' legacy-key test (if kept) should
   remain.
6. Docs: docs/architecture-overview.md line 30 (drop "paradigm notice"
   from the file's description); docs/preferences.md (storage-mode row:
   the Got-it flag is `ec:meta.optionsSeen`, full stop; "The notice"
   section: it is the only first-load toast; it still yields to the
   storage warning); planning/2026-06-13-localstorage-state-and-sharing.md:
   one line on its status — the paradigm notice was retired on 2026-09-23
   (this plan, decision 5). Grep `docs/` for "now save in this browser" /
   "paradigm" for anything else.

## 6. Tests to write or change (`src/__tests__/settings-dialog.test.ts`)

- Sections: on `app: 'observatory'` (with a `noonOnTop` stub) the dialog
  has section titles `General`, `Observatory` and the noon row labelled
  "Noon at the top of the 24-hour dial"; on `'chronometer'`, `'index'` and
  `'inspector'` only `General` and no noon row; no `Chronometer` title
  anywhere today. A section title is never rendered without rows (e.g.
  with the Wake Lock API absent General still has Low power — assert the
  count of `.ec-settings-section` equals the number of non-empty sections).
- Replace "the noon row on a Chronometer page reads and writes the
  observatory namespace" (and its `getAnyAppField` / `setState`
  assertions) with the above; keep "on Observatory the row goes through
  the live setter" (label updated).
- Forget: the label is "Forget all settings on this device…"; the rest of
  the flow test is unchanged.
- Notice: text contains "Chronometer, Observatory and the Inspector" and
  "Settings button"; two `.ec-mini-btn` spans, the first holding a clone of
  `#settings-btn`'s svg and the second of `#more-btn`'s (the `PAGE`
  fixture's buttons need an `<svg>` child each for this); the Observatory
  sentence only for `app: 'observatory'`; `aria-hidden` on the
  miniatures; without the buttons the fallback characters appear.
- `initAppState` no longer shows any toast on a clean load (a test in
  `app-state.test.ts` or the settings-dialog file: after
  `initAppState({ app: 'chronometer' })` with empty storage,
  `document.querySelectorAll('.ec-toast').length === 0`).
- Remove the `getAnyAppField` assertions; `tsc` will flag the import once
  the function is gone.

## 7. Docs and help

- docs/preferences.md: the rows table becomes per-section (General;
  Observatory — observatory.html only; a note that Chronometer has no row
  yet and the section is skipped); the noon row's new label; the Forget
  label and scope; the notice's text and miniatures; the paradigm-notice
  mentions (§5.6).
- src/help.html § Screen Controls, the Settings paragraph: describe the
  sections ("General settings on every page; Observatory's noon-on-top
  choice on Observatory pages"), the new noon label, and "Forget all
  settings on this device" with its scope in a clause. Keep the
  hand-formatted style; do not run prettier over help.html (it reflows
  unrelated text).
- src/help/observatory.html § Noon on Top: the row is now *Noon at the top
  of the 24-hour dial* under the Observatory heading of Settings.
- docs/architecture-overview.md line 30; the 2026-06-13 plan's status
  line (§5.6).
- [2026-09-22-settings-dialog-and-prefs.md](2026-09-22-settings-dialog-and-prefs.md)
  §5 and the parent plan's status line: note this plan implemented, with
  the build number.

## 8. Steps, in order

1. §5 first (smallest, independent): retire the paradigm notice; run the
   suite.
2. §2: sections + the noon row's label and its Observatory-only path;
   delete `getAnyAppField`; CSS.
3. §3: the Forget label.
4. §4: notice text + miniatures + CSS.
5. §6 tests; `npx tsc --noEmit`; `npx vitest run`.
6. §7 docs and help.
7. `bash build.sh`; pane checks (§9); headless shots of the notice on a
   face page, Observatory and the Inspector (its colours differ) for Steve
   to look at, sent with the report.

## 9. Verification checklist (pane, DOM reads)

| Page | Check |
|------|-------|
| terra.html 1280×800, no `ec:meta` | notice up; two `.ec-mini-btn` with svg children and the page's button colours; no second toast. `,` → dialog: section titles = [General]; rows Keep screen awake (Chrome has the API), Low power; no noon row; Forget label; Done |
| observatory.html | notice ends with the Midnight / Noon sentence; dialog sections = [General, Observatory]; noon row labelled without the prefix; toggling it writes `ec:observatory {"onoon":true}` (and, per the Part 3 review, the loop keeps running underneath — the `?fps` readout keeps ticking under the rAF shim) |
| inspector.html | sections = [General]; miniatures use the Inspector's `rgba(255,255,255,0.06)` / `#6b7280` |
| index.html | sections = [General]; no Chronometer title |
| any page 440×956 (resize before navigate) | `.ec-mini-btn` still filled (buttons folded but present); ⋮ menu's first row still opens the dialog |
| clean load with empty storage | exactly one toast (the Settings notice); `ec:meta` gains only `optionsSeen` on Got it |
| Forget | confirmation copy; after Forget all `ec:*` keys gone (the pane's `localStorage` after the reload) and the notice is back |
