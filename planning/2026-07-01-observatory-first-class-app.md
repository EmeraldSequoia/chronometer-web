# Observatory as a First-Class App — cross-app navigation, hotkeys, docs

**Date:** 2026-07-01 (rev 2 — Steve's decisions folded in, nav design corrected to
storage-first)
**Status:** Implemented 2026-07-01 (same session). All phases including docs and
README; verified in the dist preview (clean cross-app hrefs in storage mode,
mid-scrub time carried via `ec:shared`, hotkey matrix incl. input-focus guard,
Other Apps popups/cards, help.html `#hotkeys` in both flavors). One naming
deviation: `writeTimeStateToUrl` became `flushTimeState` (not `writeTimeState`)
to avoid colliding with the `TimeControlsConfig.writeTimeState` option in the
destructuring default.
**Goal:** Promote Observatory (and, as a lesser peer, Inspector) to fully-supported
apps: cross-linked from every page's help popup and header chrome, listed on the
index page, covered by a codified hotkey set documented in General Help, and
described in the top-level README as a peer of the Chronometer faces.

---

## 0. Decisions (Steve, 2026-07-01)

1. **No URL parameters for app switching.** All three apps share the `ec:shared`
   localStorage namespace; carrying shareable params would (in session/edge modes)
   trigger the incoming-settings dialog for nothing. See §2.0 for the design.
2. **Same-tab** navigation for the header app-nav icons (changes Inspector's
   current new-tab footer behavior).
3. Chronometer icon/hotkey `c` target: **index.html** (`a` covers all.html).
4. **pick.html: hotkeys only**, no header icons.
5. Observatory index-card art: **reuse `thumb-observatory.png`**. The round icon
   has represented EO since 2010 and the ring is central to the app — no new
   capture. **Delete the unused repo-root `observatory.png`** (3580×3580).
6. `h` on Inspector: **documented no-op** until Inspector help exists.
7. README title: **"Emerald Chronometer & Observatory — Web Edition"**.
8. Inspector description copy (§2.1): **approved**.
9. Observatory credits order: **Bill Arnett & Steve Pucci**.
10. Suggestions §4: all adopted **except** the wide Observatory screen capture
    (dropped — the round icon is canonical).

---

## 1. Current-state inventory (what this change touches)

### State architecture: app-state.ts vs url-state.ts

**`url-state.ts` is not obsolete, but it is no longer the front door.**
`shared/app-state.ts` (`initAppState`/`getState`/`setState`) is the single entry
point; it selects a backend at startup (`app-state.ts:448`):

- **LocalStorageBackend** — the normal case. State lives in namespaced
  localStorage (`ec:shared` for lat/lon/city/tz/bloc/t/off/dir — shared by all
  three apps; per-app namespaces for the rest). **The URL stays clean.**
- **UrlBackend** — delegates to url-state.ts. Used for: `?embed=1`, the
  **file:// fallback** (storage unavailable; URL params are the only state
  carrier), and **session-only mode** (user opened a shared link and declined
  saving).
- **InMemoryBackend** — http(s) with broken storage; never writes the URL.

url-state.ts's remaining jobs: the UrlBackend implementation, share-link
parsing/serialization, the URL-only params (`fps`/`tc`/`embed` —
`app-state.ts:66`), and `updateNavigationLinks`. The incoming-settings dialog
fires only when the URL carries **shareable** keys (`SHAREABLE_URL_KEYS`,
`app-state.ts:318`) that differ from storage; `fps` is explicitly excluded, so
carrying `?fps` across pages never prompts.

`isPersistentMode()` (`app-state.ts:604`) tells you whether the active backend is
localStorage — the exact gate cross-app links need.

### The Inspector footer buttons — half-migrated, comments stale

`wireAppLink` (`inspector-entry.ts:1156–1166`) sets
`href = page + window.location.search` and "flushes the URL" via
`writeTimeStateToUrl` on pointerdown. Post-migration reality:

- In storage mode the search is clean, so the links carry nothing — **already
  dialog-safe** — and `writeTimeStateToUrl` is a **misnomer**: it calls
  `setState` (`time-controls-ui.ts:133`), which writes `ec:shared`, which is
  exactly how time survives the hop. The mechanism works; the comment block
  ("Carry the current location + time state … The URL is flushed") describes the
  pre-storage era.
- They open in a new tab (decision: same-tab now) and live at the bottom
  (moving to the header).

Cleanups while replacing them: rename `writeTimeStateToUrl` →
`writeTimeState` (or re-document it), and fix the stale comments.

### Info popups (the "Help pages")

Three near-identical copies of the info popup markup exist; Inspector has none:

| Page | Popup markup | General Help `<details>` | Lead paragraph |
|------|--------------|--------------------------|----------------|
| index.html | `src/index.html:284` (inline script wiring) | `src/index.html:369` | `:291` — links emeraldsequoia.com **and** iOS GitHub |
| Face pages / all / selected | `src/face-template.html:725` (wired by `shared/help-popover.ts`) | `:791` | `:731` — links **only** iOS GitHub (drifted from index copy) |
| Observatory | `src/observatory/observatory.html:632` (wired by `shared/help-popover.ts`) | `:703` | `:638` — "A web port of Emerald Observatory (GitHub), an astronomical clock app originally built for iPad." |
| Inspector | — none — | — | — |

`help.html` is shared by both apps; `?app=observatory` drops Chronometer-only
sections and swaps app names (`src/help.html:1136`). Passages can be tagged
`.chrono-only` / `.obs-only` (`:1163`).

### Header chrome

- **Face pages** (`src/face-template.html:687–724`): left = home / all-faces /
  selected / edit-picks icon links; right = face name, ℹ, share, fullscreen.
- **Observatory** (`observatory.html:618`): `#obs-header-actions` = ℹ, share, fullscreen.
- **Inspector** (`inspector.html:661`): title + share only; footer links per above.
- **Index**: only the fixed top-right ℹ (`index.html:283`).

Existing nav links (`#back-link`, `#all-faces-link`, …, `a.face-card`) are
rewritten by `updateNavigationLinks` (`url-state.ts:316`) to carry
`window.location.search` — which is clean in storage mode, so they already
behave correctly in both modes. `index-page.ts:38` has its own `a.face-card`
updater with the same semantics.

### Hotkeys today

- Only **`f`** exists — fps toggle in `shared/fps-indicator.ts:117–139`. Its guard
  (skip when focus is in input/textarea/contenteditable; require no Ctrl/Meta/Alt)
  is the model for the new module. It updates the URL-only `?fps` param and calls
  `updateNavigationLinks()`.
- `createFpsIndicator` runs on face pages, Observatory, Inspector
  (`engine-entry.ts:940`, `observatory-entry.ts:1233`, `inspector-entry.ts:1076`)
  — **not** index/pick, so those pages currently have no hotkey infrastructure.
- Other key handlers are all contextual and non-conflicting: Escape (dialogs),
  Alt (Observatory map drag), arrows/Enter/Tab (autocomplete inputs). None of
  `i o c a h t l n ?` collide.

### Feature availability matrix (drives per-page hotkey wiring)

| Page | Time controller (`t`, `n`) | Location dialog (`l`) | Info popup (`h`, `?`) | fps (`f`) |
|---------------|------|------|------|------|
| Face pages | ✓ | ✓ | ✓ | ✓ |
| Observatory | ✓ | ✓ | ✓ | ✓ |
| Inspector | ✓ | ✓ | ✗ (no popup yet) | ✓ |
| index.html | ✗ | ✓ (`{{LOCATION_DIALOG}}`) | ✓ | ✗ |
| pick.html | ✗ | ✗ | ✗ | ✗ |

Time controller toggle = `#time-bar-label` button (`partials/time-controller.html:2`,
wired in `shared/time-controls-ui.ts:165`; `TimeControlsAPI` also exposes
`showPopover`/`hidePopover`/`isPopoverOpen`). Location dialog =
`LocationDialogAPI.show()` (`shared/location-dialog.ts:83`).

### Art / icons

- `src/faces/thumb-observatory.png` — 400×400, already copied to dist
  (`build.sh:375`), used for Observatory's dynamic favicon. **The** EO identity
  image (in use since 2010).
- `observatory.png` — 3580×3580 at repo root, referenced by nothing → delete.
- `thumb-all-faces.png` — 400×400, the natural "Chronometer" identity image.
- Inspector has **no icon and no favicon**.

### README / docs

- `README.md` never mentions Observatory or Inspector at all.
- Developer docs: `docs/README.md` TOC, `docs/help-system.md`,
  `docs/adding-a-new-app.md`, `docs/inspector.md`, `docs/observatory.md`.

---

## 2. Design

### 2.0 Cross-app state carriage — clean URLs, storage does the work

The rule for every cross-app link and navigation hotkey, implemented once in a
new `src/shared/app-nav.ts`:

- **Persistent mode** (`isPersistentMode()` true — the normal case): href is the
  bare target page (`observatory.html`, `index.html`, …) **plus `?fps` only if
  currently set** (URL-only diagnostic, deliberately carried by the existing `f`
  toggle, never triggers the dialog). No shareable params → no incoming-settings
  dialog. Location and time travel via `ec:shared`.
- **Time-state flush:** on pointerdown/focus (icons) or keydown (hotkeys), call
  the shared time-state writer *then* recompute the href — same order as today's
  `wireAppLink`. In storage mode `setState` writes `ec:shared`, so even a
  mid-scrub frozen time is what the target app opens with.
- **Non-persistent modes** (file:// UrlBackend, session-only UrlBackend,
  InMemory): copy the full `window.location.search`, exactly like
  `updateNavigationLinks` does — on file:// the URL is the *only* state carrier,
  so clean links there would lose state. Known accepted edge: in **session-only**
  mode the carried params re-prompt on the target app; optional later refinement
  — a sessionStorage "session-only chosen" flag (same-tab navigation preserves
  sessionStorage) could suppress the re-prompt. Not in scope now.
- Rename `writeTimeStateToUrl` → `writeTimeState` (it writes the *active
  backend*, not the URL) and fix the stale `wireAppLink` comment block as part of
  the replacement.

### 2.1 "Other Apps" section in the info popups

A new `<details id="other-apps-section">` placed **above** `#general-help-section`,
styled identically to it, in all three popups (index, face-template, observatory).
When expanded it shows one entry per *other* app: icon (left, ~48px), app title,
and the lead paragraph — the same lead the target app uses about itself, with the
iOS app name linked to its iOS GitHub page:

- **Chronometer** — thumb-all-faces.png — "A web port of
  [Emerald Chronometer](https://github.com/EmeraldSequoia/Chronometer), an
  astronomical watch-face app originally built for iPhone and iPad."
- **Observatory** — thumb-observatory.png — "A web port of
  [Emerald Observatory](https://github.com/EmeraldSequoia/Observatory), an
  astronomical clock app originally built for iPad."
- **Inspector** — magnifying-glass SVG — approved copy: *"A live data explorer for
  the astronomy engine shared by Chronometer and Observatory — rise/set times,
  planetary positions, and an evaluator for the expressions that drive the watch
  faces, at any time and location."* (No iOS counterpart, so no iOS link.)

Each entry's title links to the app page per §2.0 (clean href in storage mode).

**Implementation:** one new partial `src/partials/other-apps.html` containing all
three entries, each tagged `data-app="chronometer|observatory|inspector"`.
`build.sh` injects it via a `{{OTHER_APPS}}` placeholder into the three popups.
At runtime the current app's own entry is removed — a one-line `app:` option to
`initHelpPopover()` for face pages/Observatory, one line in index.html's inline
script. (Runtime filtering keeps `build.sh` free of per-page awk surgery, and the
partial stays a single source of truth.)

### 2.2 Header app-nav icons (all app pages)

Two icon buttons in the top-right of every app page, linking to the other two
apps:

- **Chronometer icon:** the colored app icon (`apple-touch-icon.png`, the
  index page's favicon), cropped round.
- **Observatory icon:** the colored round EO dial (`thumb-observatory.png`,
  Observatory's favicon image).
- **Inspector icon:** monochrome magnifying glass SVG, matching the existing
  button style.

*(Revised same day: the first cut used monochrome SVG glyphs for all three,
but the watch-face and orrery glyphs were hard to tell apart. Steve: use the
colored favicon images at the same size — they have different functionality
(switching apps) and should stand out for discoverability, so deliberately
breaking the monochrome chrome style is fine.)*

Placement:

- **Face pages:** in the right cluster before ℹ → `[obs] [insp] ℹ share fullscreen`.
- **Observatory:** in `#obs-header-actions` before ℹ → `[chrono] [insp] ℹ share fs`.
- **Inspector:** new header-actions cluster top-right → `[chrono] [obs] share`;
  **delete the bottom `.app-footer`**, its CSS, and the `wireAppLink` call sites.
- **Index:** fixed cluster next to the existing ℹ → `[obs] [insp] ℹ`.
- **pick.html:** no icons (decision #4).

Behavior: **same-tab**, Chronometer target = **index.html**, hrefs and time-state
flush per §2.0 (`app-nav.ts`).

### 2.3 Index page "Other Apps" section

Below `{{FACE_CARDS}}`: a divider, an "Other Apps" heading, and a second grid with
two `face-card` entries (class reuse buys the existing hover styling and the
`index-page.ts:38` link updater — correct in both storage and fallback modes):

- **Observatory** — `thumb-observatory.png` (decision #5); desc: "Astronomical
  clock — planets, Moon, rise/set, eclipses".
- **Inspector** — SVG-in-div card in the style of the existing pick-card
  (`index.html:403`); desc: "Live astronomy values and expression evaluator".

Also in this phase: `git rm` the repo-root `observatory.png`.

### 2.4 Codified hotkeys

New shared module `src/shared/hotkeys.ts`:

- Single `keydown` listener + registry: `registerHotkey(key, description, handler)`.
- Guard copied from `fps-indicator.ts:118–122`: ignore when focus is in
  input/textarea/contenteditable; require no Ctrl/Meta/Alt.
- The `f` handler moves into the registry (fps-indicator registers itself), so
  there is exactly one hotkey path.

| Key | Action | Availability |
|-----|--------|--------------|
| `f` | Toggle fps indicator | face pages, Observatory, Inspector |
| `i` | Go to Inspector | everywhere |
| `o` | Go to Observatory | everywhere |
| `c` | Go to Chronometer index page | everywhere |
| `a` | Go to Chronometer all-faces page | everywhere |
| `h` | Open help (ℹ popup) for the current app | face pages, Observatory, index — documented no-op on Inspector (decision #6) |
| `t` | Toggle the time controller | face pages, Observatory, Inspector |
| `n` | Reset to now (time bar's Now) | face pages, Observatory, Inspector |
| `l` | Open the location dialog | face pages, Observatory, Inspector, index |
| `?` | Open help directly to Keyboard Shortcuts | wherever `h` works |

- Navigation keys: no-op if already on the target page; otherwise flush time
  state and navigate **same tab** with a §2.0 href.
- `h` = programmatic `#info-btn` click; `t` = `#time-bar-label` click (persists via
  the existing URL-only `tc` param); `n` = `#time-bar-now` click; `l` = the page's
  `LocationDialogAPI.show()`, passed in by each entry point; `?` = `h` + expand
  and scroll to the `#hotkeys` section.
- Wire into all five entry scripts: `engine-entry.ts`, `observatory-entry.ts`,
  `inspector-entry.ts`, `index-page.ts`, `pick-page.ts` (nav keys only on pick).

**Documentation:** new `<details id="hotkeys">` "Keyboard Shortcuts" section in
`help.html`, added to `.help-nav` — app-neutral so both flavors show it (a
`t`/`n`/`l` footnote: "on pages that have that control"). This table is the
codified source of truth.

### 2.5 README

**One top-level README** stays the single user-facing front door (developer depth
stays in `docs/`; per-app user depth lives in in-app help).

Changes:

- **Title:** "Emerald Chronometer & Observatory — Web Edition" (decision #7).
- **First sentence** covers both: web ports of Emerald Chronometer *and* Emerald
  Observatory (both iOS names linked to their GitHub repos), re-implemented in
  TypeScript on HTML Canvas, no backend.
- New **"The apps"** section near the top: three short subsections (Chronometer
  faces, Observatory, Inspector) with entry-page filenames (`index.html`,
  `observatory.html`, `inspector.html`). A screenshot for Chronometer (all-faces
  capture) is welcome; Observatory is represented by its round thumb.
- "How to Run" reworded app-neutrally ("open `index.html` … or `observatory.html`").
- **URL parameters** table: reframe as the *sharing* mechanism (settings normally
  persist in local storage); note which params are app-specific (`op`, `onoon`, …).
- **Architecture** section: add `src/observatory/`, `src/inspector/`, `src/shared/`
  bullets.
- **Credits:** add Emerald Observatory — created by **Bill Arnett & Steve Pucci**
  of Emerald Sequoia LLC (decision #9) — alongside the Chronometer credit.
- New short **Keyboard shortcuts** table (or a pointer to the in-app help section).

### 2.6 Developer-doc updates

- `docs/help-system.md` — Other Apps partial, hotkeys section, updated file inventory.
- `docs/adding-a-new-app.md` — extend the checklist: add an entry to
  `partials/other-apps.html`, header nav icons, hotkey, index card.
- `docs/inspector.md` — footer links → header icons.
- `planning/README.md` — freshen the "March–April 2026" framing.

---

## 3. Work plan (phases)

1. **Shared infrastructure** — `src/shared/app-nav.ts` (per §2.0: `isPersistentMode()`
   gate, fps carry, time-state flush ordering, the three SVG icons),
   `src/shared/hotkeys.ts`, move `f` into the registry, rename
   `writeTimeStateToUrl` → `writeTimeState` + fix stale comments.
   *(No visible change yet; tsc + vitest clean.)*
2. **Other Apps popup section** — `src/partials/other-apps.html`, `{{OTHER_APPS}}`
   injection in `build.sh`, placeholder in the three popups, current-app filtering
   in `help-popover.ts` + index inline script. Normalize the three Chronometer
   lead paragraphs while touching them.
3. **Header icons** — face-template, observatory.html, index.html; Inspector:
   add header cluster, remove `.app-footer` + CSS + `wireAppLink`.
4. **Index "Other Apps" cards** — divider + heading + two cards; delete repo-root
   `observatory.png`.
5. **Hotkeys** — wire all five entry points; add the Keyboard Shortcuts section to
   `help.html`.
6. **Polish (adopted suggestions)** — Inspector favicon (magnifying glass via
   `composite-icon.ts` or static SVG), index.html meta description mentioning
   Observatory.
7. **README** rewrite per §2.5.
8. **Docs** — §2.6.
9. **Verify & ship** — `npx tsc --noEmit`, `npx vitest run`, `./build.sh`; serve
   `dist/` on a **fresh** http.server port (stale-bundle gotcha) with `?lat=&lon=`;
   click-test the matrix: every page × both icons — **hrefs must be clean** (no
   shareable params, no incoming-settings dialog) with location/tz/frozen time
   surviving the hop via storage, including mid-scrub; repeat one hop under
   file:// to confirm the URL-fallback carries search; hotkey matrix per §2.4
   including the input-focus guard (typing "o" in the city search must not
   navigate); popup Other Apps section on all three popup flavors; help.html both
   flavors; rebuild `dist` in the same commit series per repo convention.

Phases 1–6 are one coherent code change; 7–8 are prose and can trail in the same
branch.

---

## 4. Adopted suggestions (from rev 1 review)

1. **Normalize the Chronometer lead paragraph** across the three popups (phase 2).
2. **Inspector favicon** — magnifying glass (phase 6).
3. **index.html meta description** mentioning Observatory (phase 6).
4. **`n` hotkey → Now** (phase 5).
5. **`?` hotkey → Keyboard Shortcuts help** (phase 5).
6. ~~Wide Observatory screen capture~~ — **dropped** (decision #10: the round
   icon is canonical since 2010).
7. **planning/README.md freshen** (phase 8).
