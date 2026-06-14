# LocalStorage-backed state with URL sharing

Status: **planning / awaiting review** — 2026-06-13

## Goal

Switch the default persistence mechanism for the three apps (Chronometer,
Inspector, Observatory) from **URL query parameters** to **browser
LocalStorage**, while keeping URLs as an explicit, on-demand way to *share*
a time + location + configuration with another user or device.

### Rationale

The original reason for URL parameters was to avoid the perceived privacy cost
of LocalStorage. That reasoning is backwards: URL parameters are *less* private
than LocalStorage — they appear in browser history and, over http(s), in the
hosting provider's access logs. LocalStorage stays on the device and is never
sent to a server.

URL parameters still have real value, which we keep:

- Share a particular time + location with another user.
- Carry a configured setup (e.g. a Terra with chosen cities) to another device
  or browser.

## Desired behavior (requirements)

1. State currently stored in URL parameters is stored in LocalStorage instead.
2. When a URL **with** parameters is opened, ask the user whether to:
   - **Use for this browser session only** — keep the URL params, proceed as
     today. On the user's **first edit** during the session, **re-prompt**
     (save as default vs. stay session-only).
   - **Incorporate into local default config** — use the params, store them to
     LocalStorage, and **clear the URL parameters**.
3. When a URL **without** parameters is opened (the common case going forward),
   behave exactly as today but source values from LocalStorage.
4. Shared configuration (time, location) is used across **all three apps**:
   opening any app with no parameters shows the same shared time + location.
5. A **Share button** near the info button (top-right) of all three apps
   produces a copyable URL encoding the current state.
6. Inform users of the **paradigm change** (one-time notice).
7. **Fallback when LocalStorage is unavailable or unreliable.** `file://` URLs
   are first-class clients. Run a smoke test (write a probe value, read it back,
   delete it); if it fails for any reason, fall back to URL parameters with
   today's behavior. This applies to mid-session write failures too.
8. Update documentation: the Privacy doc and the help text that mentions
   "saved in the URL".

## Decisions (resolved with stakeholder)

- **Time persists** like location — a faithful 1:1 replacement of today's URL
  behavior. Note a *running* clock stores no frozen instant (`t`/`off` are
  null), so reopening shows live time; only stopped/offset times persist.
- **Live-sync everything** across tabs via `storage` events: when one app
  changes shared state, other open same-origin tabs update their location *and*
  time. Updates are discrete (one per write).
- **Session-only → re-prompt on first edit.**
- **Smoke test + full URL fallback**, `file://` first-class.

### Explicitly future (out of scope today)

- **Simultaneous live scrubbing across multiple windows** (e.g. three apps
  visible at once, all scrubbing together in real time). This needs more than
  LocalStorage syncing — a `BroadcastChannel` and/or rAF-driven cursor — and is
  deferred. Today's `storage`-event sync gives discrete updates only.

## Parameter taxonomy

Current params live in `src/shared/url-state.ts` (`UrlState`). They split into:

| Category | Params | Persistence |
|---|---|---|
| Shared location | `lat, lon, city, tz, bloc` | LocalStorage `ec:shared`, all apps |
| Shared time | `t, off, dir` | LocalStorage `ec:shared`, all apps |
| Chronometer-only | `picks, kyhand, kmode, tp` | LocalStorage `ec:chronometer` |
| Observatory-only | `op, onoon, tp` | LocalStorage `ec:observatory` |
| Inspector-only | `tp` | LocalStorage `ec:inspector` |
| Ephemeral / URL-only | `embed, fps` | never persisted |
| Transient UI | `tc` (popover visibility) | not persisted |

### `bloc` semantics — CHANGED in this work

`bloc` is the intent "resolve my location from the browser Geolocation API on
each load" (`engine-entry.ts:332`).

**Old behavior:** choosing browser location set `bloc=1` and *cleared*
`lat/lon/city/tz`, so before the fresh fix arrived the app showed 0,0.

**New behavior (adopted here):** `bloc: true` is stored *alongside* the
last-known `lat/lon/city/tz`, not instead of them. This:

- shows reasonable values behind the "fetching location" UI instead of 0,0
  (almost always wrong);
- lets us skip re-reverse-geocoding the city name when the fresh fix is within
  a small threshold of the stored coords (the dialog already computes a ~16 km
  `haversineKm` threshold, `location-dialog.ts:235`);
- preloads the location dialog's lat/lon fields with the last-known location.

On load we still re-request geolocation; we only reuse the stored city name if
the new fix is close to the stored coords. Denied/timeout falls back to the
location prompt (as today).

## Storage model

LocalStorage, versioned JSON blobs:

| Key | Contents |
|---|---|
| `ec:shared` | `{ v, lat, lon, city, tz, bloc, t, off, dir }` |
| `ec:chronometer` | `{ v, picks, kyhand, kmode, tp }` |
| `ec:observatory` | `{ v, op, onoon, tp }` |
| `ec:inspector` | `{ v, tp }` |
| `ec:meta` | `{ v, noticeSeen: boolean }` |

A `v` (schema version) field allows future migrations. A static param→namespace
map routes each field to the correct key.

## Two-backend abstraction — new `src/shared/app-state.ts`

A single API, shaped like the existing `UrlState` so consumers change minimally:

```
getState(): UrlState          // merged view of all relevant keys
setState(changes): void       // routes each field to its namespace
onSharedChange(cb): void      // storage-event subscription (live sync)
```

Backed by one of three implementations, chosen at startup (and the in-memory one
can be entered mid-session — see "Storage-failure behavior"):

- **LocalStorageBackend** (default) — reads/writes the namespaced keys; keeps the
  address bar clean.
- **UrlBackend** — exactly today's `readUrlState`/`writeUrlState` behavior over
  the URL. Used **only as the `file://` fallback** (provably leak-free there).
- **InMemoryBackend** — holds state in JS only; never writes the URL, never
  persists. Used as the **http(s) fallback** so location can't escape to history
  or server logs. Shows a one-time "settings won't be saved" warning.

`src/shared/url-state.ts` is retained as the URL **serializer**, used by the
share feature and the UrlBackend.

### Smoke test

```
function storageWorks(): boolean {
  try {
    const k = '__ec_probe__';
    localStorage.setItem(k, '1');
    const ok = localStorage.getItem(k) === '1';
    localStorage.removeItem(k);
    return ok;
  } catch { return false; }
}
```

Run once at startup. The response to failure is **protocol-aware** — see the
next section.

### Storage-failure behavior (protocol-aware) — leakage analysis

The concern: if storage fails and we fall back to URL params, the user's
location can escape into browser history and server access logs. We avoid that
by branching on protocol.

**Verified facts:**
- On `file://` the location dialog never fetches OSM tiles
  (`location-dialog.ts:261` guards `loadOSMTile` behind `isFileProtocol`), there
  is no server (no access logs), and `file://` pages send no `Referer`. Browser
  history is local to the device. → **URL params on `file://` have zero external
  leakage surface.**
- On `http(s)`, putting `lat/lon` in the URL is logged by the host's access logs
  (SiteGround logs the full query string). It is **not** leaked to OSM by
  default: modern browsers default to `Referrer-Policy:
  strict-origin-when-cross-origin`, which sends only the origin (not path/query)
  on cross-origin requests. We harden this by setting `referrerpolicy="origin"`
  on the OSM tile `<img>` requests — OSM's tile usage policy *requires* a valid
  `Referer`, so `no-referrer` would risk being blocked; `origin` sends only
  `https://host/` (no path/query), satisfying OSM while guaranteeing the query
  string never leaves the browser on any request.
- `localStorage` on `http(s)` is very reliable but **not infallible**:
  Safari "Block All Cookies" blocks it, some locked-down/embedded contexts
  disable it, and quota can (rarely) be exhausted. The 19 MB cities DB lives in
  JS module memory, **not** localStorage, so this app doesn't fill the quota
  itself. Private mode is *not* a failure on modern Chrome/Firefox/Safari.

**Behavior on storage failure:**

| Protocol | Startup smoke test fails | Mid-session write throws |
|---|---|---|
| `file://` | **UrlBackend** (today's behavior). Show dim `(URL)` indicator. Leak-free. | (won't happen — `file://` that passed the smoke test keeps working; if a write throws, treat as http(s) row: in-memory + warn.) |
| `http(s)` | **InMemoryBackend**: state in memory only, **never** written to URL. One-time non-blocking warning "settings can't be saved and won't persist after reload." | Same: keep authoritative state in memory, stop persisting, **never** write URL, warn **once**. |

This makes the app *more* private than today in the common case (clean URLs →
nothing logged). Inherent caveat: a shared `http(s)` link already carries its
params in the URL on first load (already in history/logs the moment it opens);
we only control not *adding* params, and we clear the address bar when the user
saves as default.

## Startup decision tree (one shared helper, used by all 3 entries)

```
read URL params
├─ embed mode            → URL-only; no storage, no prompt, no notice   [unchanged]
├─ smoke test fails:
│   ├─ file://  → UrlBackend (today's behavior); dim "(URL)" indicator; no notice
│   └─ http(s)  → InMemoryBackend; one-time "won't be saved" warning; no notice
└─ storage available:
   ├─ URL has shareable params:
   │   ├─ equal to stored defaults → clean URL, use stored (bookmark-of-own-default)
   │   └─ differ → "Incoming settings" dialog:
   │        • Save as my default → write storage, CLEAR url, proceed
   │        • Use this session only → keep URL, run URL-mode, arm re-prompt-on-first-edit
   └─ no shareable params → load from storage (empty → existing first-run location prompt)
   └─ show one-time paradigm notice if unseen
```

"Shareable params" = any of `lat, lon, city, tz, bloc, t, off, dir, picks,
kyhand, kmode, op, onoon, tp`. A URL carrying only `fps`/`embed` is **not**
shareable — no prompt; those are always read from the URL.

## Session-only mode + re-prompt on first edit

When the user chooses "session only," the app runs URL-authoritative (like the
fallback) with a `pendingFirstEditPrompt` flag. The first **location/config**
edit shows a dialog:

- **Save these as my default** → switch to LocalStorageBackend, write the full
  current state to storage, clear the URL.
- **Keep this session-only** → stay in URL mode, disarm the prompt; subsequent
  edits just update the URL.

**Time is excluded from the re-prompt.** A pure time change (scrub/step) does
*not* trigger the prompt and is *not* persisted — only location/config edits do.
Time is treated as best-effort throughout these edge cases.

## Share button

- A control near the info button (top-right) in all three apps.
- New `buildShareUrl(state)` in `url-state.ts` produces an absolute URL.
- Copies via `navigator.clipboard.writeText`, with a manual-copy popover
  fallback (shows the URL + Copy) and a confirmation toast.

### Share URL contents — "if it's in the URL today, include it," with exceptions

| Param | In share URL? | Note |
|---|---|---|
| lat, lon, city, tz | yes | the location being shared |
| t, off, dir | yes, **only when "interesting"** | include frozen/offset time; omit when clock just runs live |
| picks, kyhand, kmode, op, onoon, tp | yes | the configured setup |
| **bloc** | **yes** | included; recipient's session/save-as-default choice resolves the user stories (A/B/C below). |
| **fps** | **no** | diagnostic overlay |
| **embed** | **no** | iframe/deployment context, not user config |
| **tc** | **no** | transient popover state |

Rule of thumb: **"if it's in the URL today, include it in the share URL,"** with
the three exclusions above (`fps`, `embed`, `tc`) and time included only when the
clock is stopped/offset.

#### Why `bloc` is included (user stories)

- **A — sharing an explicit location that isn't mine** (eclipse path, a city of
  mutual interest): `bloc` is almost never part of that session, so it's moot.
- **B — sharing an explicit time using my own location:**
  - *B1, location-independent event* (e.g. a lunar eclipse the recipient should
    see at *their* location): recipient declines "save as default," so their
    location is not overridden.
  - *B2, a bug reproducible at my location+time*: recipient accepts "save as
    default," adopting my location — desired.
- **C — porting my config to another device/browser**: recipient accepts
  "save as default." If `bloc` was my original intent they'll likely want it on
  the new device too; if not, the location dialog flips it trivially.

## Live cross-tab sync

Each app adds a `storage` event listener. On `ec:shared` change it re-reads and
applies location (rebuild astro environment, update displays) and time (update
the TimeController) live. Self-writes don't fire same-tab `storage` events, so
no feedback loop. Per-app keys are applied similarly if changed by another tab
of the same app.

## Navigation links

`updateNavigationLinks` / `initNavigationLinks` in `url-state.ts` currently copy
the query string onto every internal link so state survives page navigation
(home → face → all → pick → selected). With LocalStorage shared across
same-origin pages this is unnecessary; links become clean in storage mode. The
functions become **mode-aware**: clean links under LocalStorageBackend; keep the
query-copying behavior under UrlBackend. They still route `pick.html` vs
`selected.html` based on whether picks exist (now read from storage). `picks`
also flows between `pick-page.ts` and the face pages via storage instead of URL.

## Fallback-mode indicator "(URL)"

In `file://` URL-fallback mode, append a small, dim `(URL)` to the **location
detail line** (Inspector `locationDetail`, Observatory footer, Chronometer
location display). Always visible, never prominent. **Scope: fallback-only** —
not shown during session-only mode, which is transient and already shows the
params in the address bar.

## Paradigm-change notice

A dismissible first-run banner/toast shown once in storage mode (not embed, not
fallback). Sets `ec:meta.noticeSeen`. Also a short Help blurb + the Privacy
rewrite below.

Draft wording (to refine): *"Session storage is now persisted with browser
local storage rather than URL parameters. LocalStorage can be cleared with
history in browser settings if desired."* — likely paired with a line pointing
to the Share button for creating a link.

## Documentation changes

- `src/partials/privacy-content.html` — rewrite the "URL Parameters" section
  (lines ~77–87) into "Local Storage & Sharing": state is stored in the
  browser's LocalStorage on this device, never sent to a server; URLs carry
  parameters only when you use Share or open a shared link; `file://` uses the
  URL fallback. Update the access-log bullet (query params now rarely present).
- `src/help.html:1021`, `src/help/observatory.html:327`, `src/help/vienna.html:23`
  — reword "saved in the URL so it persists when you bookmark" →
  "saved on this device"; add a sharing note.
- Add a short Help section describing Share and the session-vs-default choice.

## Files touched (anticipated)

- New: `src/shared/app-state.ts` — three backends (LocalStorage / Url / InMemory),
  smoke test, protocol-aware fallback, namespace map (+ vitest tests)
- New: incoming-settings dialog (partial HTML/CSS + wiring), share button +
  toast, paradigm notice, "(URL)" indicator, in-memory "won't be saved" warning
- Modify: `src/shared/url-state.ts` (serializer + `buildShareUrl`, mode-aware
  nav links), `src/shared/time-controls-ui.ts`, `src/engine-entry.ts`,
  `src/inspector/inspector-entry.ts`, `src/observatory/observatory-entry.ts`,
  `src/index-page.ts` (drop duplicate reader/writer), `src/pick-page.ts`
- Docs: `src/partials/privacy-content.html`, `src/help.html`,
  `src/help/observatory.html`, `src/help/vienna.html`
- Build/HTML: add the share button + dialog/notice partials to the relevant
  app HTML via `build.sh` partial injection

## Edge cases

- `bloc` persists as intent *with* last-known coords retained (new behavior);
  reload re-asks geolocation and reuses the stored city name when the fix is
  close (denied/timeout → location prompt, as today).
- URL with only `fps`/`embed` → not shareable; no prompt; read from URL.
- Incoming params equal to stored defaults → silent; just clean the URL.
- Smoke test passes but a later write throws → **http(s): switch to in-memory +
  warn once, never write URL.** (file:// that passed the smoke test keeps
  working; a later throw there is treated the same as the http(s) case.)
- Time writes never trigger the session-only re-prompt or the storage-failure
  warning; time is best-effort.
- Embed mode is entirely unaffected (URL-only, no storage, no prompt/notice).
- Add `referrerpolicy="origin"` to OSM tile `<img>` requests (hardening; OSM
  requires a Referer, so origin-only rather than no-referrer).

## Sequencing

1. `app-state.ts` abstraction + smoke test + namespace map + unit tests.
2. Rewire all consumers to `app-state` (behavior-preserving).
3. Incoming-settings dialog + session-only / re-prompt-on-first-edit.
4. Share button + `buildShareUrl` + clipboard/toast.
5. Live-sync `storage` listeners.
6. Mode-aware navigation links.
7. Paradigm notice.
8. Docs.
9. Build via `build.sh` + dist server; verify storage mode, both incoming
   choices, session re-prompt, share+copy, cross-tab sync, and `file://`
   fallback.
