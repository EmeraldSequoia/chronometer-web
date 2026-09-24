# Handoff: options-panel project — resuming at Part 3

**Outcome**: Part 3 (with Part 7 folded in) was built from this handoff on
2026-09-22 — see [2026-09-22-settings-dialog-and-prefs.md](2026-09-22-settings-dialog-and-prefs.md)
and [docs/preferences.md](../docs/preferences.md). §2 below is the brief it
was built to; §3's recipes still hold. Next: Parts 4, 5, 6 (parent §6).

**Created**: 2026-09-22, at the end of the session that built Parts 1 and 2.
**Parent plan**: [2026-09-14-user-options-panel.md](2026-09-14-user-options-panel.md)
(§4 = what the panel holds, §6 = the parts, §7 = every decision Steve took).
**Part plans**: [Part 1](2026-09-17-chrome-targets-and-overflow-menu.md) (44 px
chrome, ⋮ menu, phone collapse), [Part 2](2026-09-22-steady-state-frame-pacer.md)
(frame pacer, reduced motion). Read the parent plan's §4 and §7 and this file;
the rest is reference.

## 1. State of the tree

- **Part 1 is committed** (7a36f08 "Make top buttons 44px to improve
  usability"). Everything Part 1 later gained in review (phone rule, face name
  beside ⋮, icons, row order, menu scroll cap, pointer-events fix) is in that
  commit or the working tree — check `git log -1 --stat` and `git status`.
- **Part 2 is committed** (8dd7a8b "Cap fps at smallest even fraction of
  vsync rate that is >=60fps", build 2.0.142): `src/shared/frame-pacer.ts`
  + tests, the reduced-motion seam in `updater.ts`, the three entries, the
  `fps-indicator.ts` readout tail `p<share> <Hz>`, docs. Steve verified
  2.0.140 on his 120 Hz laptop; 2.0.141/142 added the probe / snapping /
  floor rule and paced Chronometer's idle wakes (Part 2 plan §5–§6). 8796
  tests pass, `tsc` clean. Only this handoff and the parent plan's status
  line were left uncommitted.
- `dist/` is untracked build output; `bash build.sh` bumps `version.txt`
  (tracked) — that bump is expected in every commit that rebuilds.

## 2. Part 3 — what to build (parent §4, §6 row 3, decisions §7)

1. **`src/shared/prefs.ts`** — device preferences in their own storage blob
   `ec:prefs` (prefix `STORAGE_KEY_PREFIX` = `'ec:'` in app-state.ts).
   Never in share links (`buildShareUrl`, url-state.ts) and never part of the
   incoming-settings comparison (`SHAREABLE_FIELDS`, app-state.ts); in the
   non-persistent (file://) fallback they must ride the query string, which
   navigation links already carry whole (`navSearch()` in app-nav.ts) — so
   prefs need a URL encoding for that mode only. Cross-tab: listen to
   `storage` events like `onSharedChange` (app-state.ts). Keep prefs **out
   of `UrlState`** (decided): a small module with `getPrefs / setPref /
   onPrefsChange`.
2. **Settings dialog** — a dedicated overlay (decided over a section in ℹ).
   Reuse `ensureModalStyles` / `.ec-modal` from
   `src/shared/incoming-settings-dialog.ts`; blur the content behind, never
   `backdrop-filter` (memory + docs/performance.md); park the render loop
   while it is up (the help popover's `onOpen/onClose` pattern in each
   entry); Esc closes; hotkey **`,`** (register per entry like `h`/`t`/`l`;
   add to help.html's Keyboard Shortcuts table and the README's). Rows, all
   pages: **Keep screen awake** (toggle), **Low power** (toggle),
   **Observatory: noon at the top of the 24-hour dial** (toggle — writes
   the existing `onoon` state, observatory namespace; label plain words),
   **Forget my settings on this device** (action: remove every `ec:*` key
   and reload; confirm first).
3. **⚙ gear button** on wide layouts, next to ℹ, on face pages / Observatory
   / Inspector / index. Add it to each page's chrome lists so the layout
   engine and the collapse rules see it: face pages `RIGHT_CHROME_IDS` +
   `rowOrder` (engine-entry.ts, keep it beside ℹ — memory
   chrome-buttons-stable-positions), the `body.chrome-collapsed` and
   `body.is-fullscreen` visibility lists in face-template.html;
   Observatory `#obs-header-actions` (and its collapsed / dropped CSS in
   observatory.html — folded buttons use `visibility: hidden; position:
   absolute`, and `#more-menu` must keep `pointer-events: auto`); Inspector
   `CHROME_IDS`; index.html's collapsed list. On phones everything
   collapses (`isPhoneSizedViewport`, chrome-layout.ts), so the gear is
   never visible there: **the ⋮ menu gets a Settings row first** — add
   `{ label: 'Settings…', kind: 'click', id: 'settings-btn' }` at the top of
   `ROW_SPECS` in `src/shared/overflow-menu.ts` (icon: the gear's svg is
   cloned automatically).
4. **Got-it toast** — the paradigm-notice pattern (`showParadigmNotice` in
   incoming-settings-dialog.ts, `maybeShowParadigmNotice` in app-state.ts)
   but **no auto-dismiss and no ×**: it shows on every load until Got it is
   clicked; the click writes `ec:meta.optionsSeen` (URL-mode: ride the query
   string). Text: settings are behind ⚙ (or ⋮); on Observatory pages add
   that the Midnight / Noon control now lives there.
5. **Noon-on-top moves** (Observatory only; Vienna's pill stays): remove
   the footer disc `#noon-icon` / pill `#noon-toggle` and `positionNoonIcon`
   (observatory-entry.ts, ~line 1026 + its callers), the A5 dodge, and the
   `obs-chrome-dropped` / `is-fullscreen` rules for them; `setNoonOnTop`
   stays as the single setter the Settings row calls. docs/observatory.md
   § Noon-on-Top Toggle describes the current mechanism.
6. **Keep screen awake**: `navigator.wakeLock.request('screen')` when the
   pref is on and the page is visible; re-acquire on `visibilitychange` →
   visible (`src/shared/wake-triggers.ts` is the neighbour); release when
   off; offer the row only when `'wakeLock' in navigator`.
7. **Low power** (Part 7, fold into Part 3 now that the pacer exists): each
   entry holds its pacer (`const pacer = createFramePacer()`: inside `main`
   in engine-entry.ts, module-level in the other two). On init and on pref
   change: `pacer.setTargetFps(lowPower ? LOW_POWER_FPS : STEADY_STATE_FPS)`.
   Cap value to tune (parent §3.4: 10–12; the rule is "every k-th vsync,
   k = ⌊display ÷ target⌋", so 10 on 120 Hz = every 12th). Exempt scrub /
   drag / bursts already.
8. **Docs & help** (development rule 1): docs/chrome.md (gear, Settings
   row), docs/performance.md (low power), a new docs section or doc for
   prefs, help.html "Screen Controls" (+ a Settings paragraph), hotkey
   tables (help.html + README; the README also still says `f` toggles fps —
   parent §8), docs/observatory.md (noon control moved). Format help HTML
   with `npx -y prettier --write` — but check the diff; help.html was not
   prettier-clean and formatting it reflowed unrelated text (we hand-formatted
   the last section instead).

## 3. How this session verified things (recipes that worked)

- **Build & serve**: `bash build.sh`; `.claude/launch.json` has many
  `dist-freshNN` entries — use `preview_start` with one not used recently
  (a new port defeats the pane's HTTP cache) and confirm the build with the
  `v2.0.NNN` text in `#info-main-view`. Stop the server when done.
- **Seed a location** so no dialog blocks: on the served origin run
  `localStorage.setItem('ec:shared', JSON.stringify({lat:37.77, lon:-122.42,
  city:'San Francisco', tz:'America/Los_Angeles', lsrc:'city'}))` and
  `localStorage.setItem('ec:meta', JSON.stringify({noticeSeen:true, v:1}))`,
  then navigate. (Part 3's toast will need `optionsSeen` too.)
- **The pane**: `resize_window` changes the viewport but the compositor
  does not repaint — verify with `javascript_tool` reads (body classes,
  `getBoundingClientRect`, computed styles, `elementFromPoint`), not
  screenshots. rAF is often dead in a tab; to run a loop, reload the page
  through `document.write` with a rAF shim prepended (fetch the HTML, prepend
  `<script>` replacing `requestAnimationFrame` with a timer on a vsync grid,
  `document.open(); document.write(); document.close()`). all.html's
  16-bundle loader does not survive that rewrite; single faces, Observatory
  and Inspector do. Real pixels: headless Chrome against the dist server with
  a seeded profile — memory note `headless-dist-page-screenshots`.
- **Tests**: `npx tsc --noEmit`, `npx vitest run` (~60 s, 8796 tests). For
  updater / tick changes also `npx tsx src/__tests__/perf/perf-regression.ts`
  — it reports large deltas right after the suite on a hot machine; confirm
  with an interleaved A/B (stash the change, run, pop, run) before believing
  one (docs/perf-regression.md).
- **Steve tests natively** on a 120 Hz laptop (Chrome, and Safari with its
  >60 fps flag) and an iPhone 18 Pro Max; the `?fps` readout's tail
  `p<share> <Hz>` says whether frames were paced and what the pacer measured.

## 4. Decisions to remember while building Part 3 (all in parent §7)

Gear only where there is room; ⋮ menu holds everything on phones (short
side ≤ 500 px) with Settings first; collapsed corner keeps [⋮] [⛶] (+ face
name); fullscreen keeps only the exit button; 44 px targets everywhere;
toast repeats until Got it; hotkey `,`; noon-on-top moves for Observatory
only; low power is a plain toggle, not keyed on battery; keep screen awake
and Forget settings are in; the apps stay non-scrolling (a scrollable root
let the view end up off-screen once — don't reintroduce it).
