# Preferences & the Settings Dialog

The ⚙ button on every app page opens a **Settings** dialog; where the corner
chrome is collapsed (every phone, and any window too small for the buttons —
[chrome.md](chrome.md)) the ⋮ menu's first row, **Settings…**, opens the same
dialog, as does the `,` hotkey (the desktop preferences convention). This doc
is the implementation record of Part 3 of
[planning/2026-09-14-user-options-panel.md](../planning/2026-09-14-user-options-panel.md)
(decisions in its §7; plan:
[planning/2026-09-22-settings-dialog-and-prefs.md](../planning/2026-09-22-settings-dialog-and-prefs.md)).

The panel is deliberately small. The project's rule (parent plan §1): a
setting is justified only when the right behaviour depends on something the
app cannot observe — user intent. Everything that could be derived (button
size, frame-rate cap, the magnifier) was derived instead.

## The rows

Rows are grouped in **sections by app** — a small-caps title over a rule —
and an app's rows appear only on that app's pages
([planning/2026-09-23-settings-sections-and-forget-scope.md](../planning/2026-09-23-settings-sections-and-forget-scope.md),
decision 1). A section renders only when it has at least one row, so no
page ever shows a bare title.

**General** — every page:

| Row | Kind | Lives in | Effect |
|-----|------|----------|--------|
| **Keep screen awake** | toggle, device | `ec:prefs` | holds a screen wake lock while a page is visible (`src/shared/wake-lock.ts`). Offered only where `navigator.wakeLock` exists (Chrome 84+, Safari 16.4+, Firefox 126+). |
| **Low power** | toggle, device | `ec:prefs` | lowers the steady-state frame cap from `STEADY_STATE_FPS` (60) to `LOW_POWER_FPS` (10) — `pacer.setTargetFps` in each entry ([performance.md](performance.md#idle-1-and-battery)). Scrubs, drags and the two-second bursts after a user change stay at the display's rate, so only the 1× second hands change: they step instead of sweeping. Not keyed on battery state — laptops, phones and tablets are on battery almost always, and the Battery API is absent on Safari, iOS and Firefox. |

**Observatory** — observatory.html only:

| Row | Kind | Lives in | Effect |
|-----|------|----------|--------|
| **Noon at the top of the 24-hour dial** | toggle, *view state* | `ec:observatory` (`onoon`) | the existing shareable setting; the row reads and writes Observatory's live state through the `noonOnTop` option of `initSettingsDialog` (`setNoonOnTop()` in `observatory-entry.ts`), so the dial animates half a turn. Built only when that option is supplied, so the section can never appear bare. Replaces Observatory's footer half-disc + pill (2026-09-22); Vienna's own noon pill stays beside its face. |

**Chronometer** — the face pages and the index page (which reads the
chronometer namespace and shows the face set): no row yet, so the section
is not rendered. Its (empty) entry stays in the section table in
`settings-dialog.ts` so a future row has a home.

Last, after the sections and set apart from them:

| Row | Kind | Lives in | Effect |
|-----|------|----------|--------|
| **Forget all settings on this device…** | action | — | a centred button; a small confirmation modal of its own (over the dialog, on its own backdrop; Esc / Cancel / backdrop back out) names the scope, then `forgetAllSettings()` removes every `ec:*` key from local and session storage and reloads with a clean URL. The scope is **everything, for all three apps**, whichever page the button is pressed on (decision 2): the location and time (`ec:shared`), watch-face choices and the Terra / Gaia cities (`ec:chronometer`, `ec:slots`), Observatory's choices (`ec:observatory`), the Inspector's (`ec:inspector`), the preferences and the notice flag (`ec:prefs`, `ec:meta`), and the last-Chronometer-page record. The label says so, so its place under an app's section cannot read as that app only. The honest counterpart of the privacy text that says settings live in local storage, and a support tool. The notice returns afterwards — a forgotten device is a new device. |

## Storage: `src/shared/prefs.ts`

Device preferences are kept **out of `UrlState`** and out of app-state's
backends (parent plan §4, "Storage"): `getPrefs() / setPref() /
onPrefsChange()` over their own blob, so that

- share links never carry them (`buildShareUrl` serializes `UrlState` only);
- an incoming link is never compared against them (`SHAREABLE_FIELDS`), and
  changing one never trips the session-only re-prompt;
- the incoming-settings decision tree is untouched.

Three modes, decided like app-state's backend (`storageWorks()`, then the
protocol):

| Mode | When | Where the flags live |
|------|------|----------------------|
| storage | localStorage works | `ec:prefs` = `{ awake?: true, lowpower?: true, v: 1 }`; the Got-it flag is `ec:meta.optionsSeen`. Only `true` is stored; a false flag is deleted and an empty blob removed, so an untouched device has no `ec:prefs` key. Cross-tab: `storage` events notify subscribers, as `onSharedChange` does for view state. A failed write downgrades the page to memory mode, seeded with what was stored. |
| url | storage broken on a `file://` page | `?awake=1&lowpower=1&optseen=1` on the current URL (`history.replaceState`). Navigation links already carry the whole query string in this mode (`navSearch()` in app-nav.ts; `updateNavigationLinks()` is re-run after each write for the face-page links), so the flags travel between pages. The keys are unknown to url-state, so `writeUrlState` and `clearShareableParamsFromUrl` leave them alone, and `hasShareableParamsInUrl` ignores them. |
| memory | storage broken on http(s) | this page's lifetime only — never the URL, which could reach server logs. The notice then shows on every load, as the plan accepts. |

`setPref` notifies this tab's subscribers as well as other tabs (app-state's
`onSharedChange` is cross-tab only; the entries need to hear their own
dialog's toggles). Subscribers in each entry re-target the frame pacer and
refresh the wake lock.

## The dialog: `src/shared/settings-dialog.ts`

Built on the incoming-settings dialog's modal conventions
(`ensureModalStyles`, `.ec-modal`, in `incoming-settings-dialog.ts`) rather
than the ℹ popup's slider — it must be *obviously* a settings page (Steve,
2026-09-16; a Settings section under ℹ was rejected as undiscoverable).

- **44 px rows** with switch controls; a Done button (phones have no Esc);
  Esc and a backdrop click also close it. Esc is captured on `window` and
  stopped, so the pages' own Escape ladders (which close the topmost dialog)
  do not fire as well; with the Forget confirmation up, Esc closes that
  first.
- **Blur behind, no `backdrop-filter`**: `body.ec-settings-open` applies a
  forward `filter: blur(6px)` to the page content (the face pages' `#app > *`,
  other pages' `body > *`), the same split the pages' `help-open` rules make
  and for the same reason — a full-screen `backdrop-filter` flashes
  ([performance.md](performance.md)).
- **The render loop keeps running underneath** — deliberately unlike the
  help popover, which parks it. The dialog is up for seconds, not minutes; a
  forward `filter` over a repainting layer is safe (the flash the pages guard
  against came from `backdrop-filter`'s destination readback, and the face
  pages' location dialog has always blurred a live grid this way); and the
  toggles are meant to be seen taking effect — the Observatory's noon-on-top
  sweep plays behind the blur, and Low power's slower cadence shows at once.
  (The first cut parked the loop like help, which rendered one frame of the
  sweep and finished the rest in a jump on close — Steve, 2026-09-23.)
  Opening closes the help popover and the ⋮ menu first, so only one overlay
  is ever up.
- Reachable in fullscreen by hotkey, like the other overlays, although the
  gear itself is hidden with the rest of the chrome.

## The ⚙ button and the ⋮ row

`src/partials/settings-button.html` (`{{SETTINGS_BUTTON}}` in build.sh) is a
44 px circle like ℹ, placed **outboard of ℹ** on every page so the buttons
users already know keep their places: face pages `[⛶] [ℹ] [⚙] [name]` along
the top edge (canonically after the name, so the name keeps the top row when
the row must shorten; `rowOrder` puts the gear beside ℹ whenever both are
rowed — `RIGHT_CHROME_IDS` in engine-entry.ts), Observatory's header row
`… [⚙] [ℹ] [share] [⋮] [⛶]`, the Inspector and index rows at the next
52 px pitch. It joins each page's collapse and fullscreen lists (folded with
`visibility: hidden`, or Observatory's `position: absolute`, so it stays
measurable and the menu builder still sees it). The ⋮ menu's first row,
`Settings…`, clicks it — on phones the corner is always collapsed, so that
row is the way in there.

## The notice

`showSettingsNotice` (incoming-settings-dialog.ts), shown from
`initSettingsDialog` on every page load until its **Got it** button is
clicked — **the only first-load toast** since the storage-paradigm notice
("Your settings now save in this browser instead of the URL…") was retired
on 2026-09-23: months after deployment nobody arrives from the URL era, and
a new user was getting two popups. One text for every app, since one Got it
silences all of them: "Settings for Chronometer, Observatory and the
Inspector — keep the screen awake, low power, and each app's own options —
are behind the [⚙] Settings button at the top right (on a phone, the first
row of the [⋮] menu)." On Observatory pages it adds "The Midnight / Noon
control now lives there too." The `[⚙]` and `[⋮]` are **miniatures of the
real buttons** (`miniButton`, beside `showSettingsNotice`): the live
button's svg cloned into a 26 px circle in the button's computed colours (so
the Inspector's greyer chrome comes out grey), `aria-hidden` so the words
carry the meaning for screen readers and copies; on a page without a button
the character stands in. The toast is sized to its text, up to 380 px or
the viewport less 16 px margins (a fixed box at `left: 50%` would otherwise
shrink to the right half of a phone's width). It has **no auto-dismiss and
no ×** (Steve,
2026-09-16); the click writes `ec:meta.optionsSeen` (`optseen=1` in url
mode). It yields to a toast already on screen (the storage warning of
in-memory mode) and simply returns on the next load, so the two never
stack; another tab's Got it removes this tab's copy.

## Files

| File | Role |
|------|------|
| `src/shared/prefs.ts` | storage / url / memory modes, change events, the Got-it flag, `forgetAllSettings` |
| `src/shared/settings-dialog.ts` | the dialog, its sections and rows, the notice's show rules |
| `src/shared/wake-lock.ts` | Keep screen awake |
| `src/shared/frame-pacer.ts` | `LOW_POWER_FPS`, `setTargetFps` |
| `src/shared/incoming-settings-dialog.ts` | shared modal / switch / section / toast CSS, `showSettingsNotice` and `miniButton`, the blur rule |
| `src/shared/overflow-menu.ts` | the `Settings…` row |
| `src/partials/settings-button.html` | the ⚙ markup |
| tests | `src/__tests__/prefs.test.ts`, `settings-dialog.test.ts`, `wake-lock.test.ts` |
