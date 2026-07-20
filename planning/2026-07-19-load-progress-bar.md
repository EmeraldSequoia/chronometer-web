# Plan: real download-progress bar during app load

> **Status: proposed; Steve's Q1–Q4 decisions incorporated 2026-07-19.** Not
> yet implemented. This is Tier 2 from the load-progress discussion — a
> *moving* bar tied to real bytes, not an indeterminate spinner. The
> motivating argument: a spinner only says "working"; a moving bar tells the
> user both that the download is *alive* and roughly *how much longer* — and,
> when it stalls, that it's *broken and worth abandoning*.
>
> Resolved (§12): `file://` is a **first-class** client, not a fallback (Q1);
> hold the bar through init with an **"Initializing…"** label via a one-line
> per-entry hook (Q2); **blob-URL** execution is the default (Q3); ship all
> pages before deploy, split into **three commits** by page complexity (Q4).
>
> **Steve owns every commit.** Claude implements each commit's work, then
> pauses for Steve's manual verification and lets Steve commit — Claude never
> runs `git commit`/`git add` and never starts the next commit unprompted
> (§8 Workflow).

## 1. Goal

On a slow network the heavy pages show a dark, empty screen for many seconds
while multi-megabyte JS bundles download, with no signal that anything is
happening. Replace that dead time with a **determinate progress bar** that:

- appears within the first ~132 KB (the HTML), long before the JS lands;
- advances in proportion to bytes actually downloaded;
- surfaces a clear **stalled / failed** state with a **Retry** so the user
  knows when to give up rather than waiting on a dead connection;
- adds **zero** behavior change on `file://` (not the target scenario, and
  `fetch()` of local files is blocked there anyway).

Non-goal: making the download *smaller*. That's the real fix for slow
networks (see §10) but is a separate project. This makes the wait *legible*,
not shorter.

## 2. Why this is feasible

The bundles are **not** inlined — the pages pull them via plain `<script src>`
tags at the very end of `<body>` (see
[face-template.html](../src/face-template.html) `{{SCRIPTS}}`,
[observatory.html](../src/observatory/observatory.html),
[inspector.html](../src/inspector/inspector.html)). The HTML itself is ~132 KB
and arrives first, so the browser has already parsed and can paint everything
above those tags while the JS downloads. The screen only *looks* dead because
`#watch-grid` is empty against a dark background. So a bar placed in the HTML
markup with inline CSS paints almost immediately; we just need something to
drive its width from real download progress.

Current initial-load payloads (uncompressed, on-disk = what's served):

| Page | Bundles | Total |
|------|---------|-------|
| `observatory.html` | `observatory-engine.js` | **5.8 MB** (1 file) |
| `inspector.html` | `inspector-engine.js` | **1.4 MB** (1 file) |
| single face (e.g. `terra.html`) | `chronometer-engine.js` + `face-terra.js` | **3.6 MB** (2 files) |
| `all.html` / `selected.html` | `chronometer-engine.js` + 16 `face-*.js` | **~17.8 MB** (17 files) |

The single-bundle pages (observatory, inspector) are the simplest and among
the highest-value; `all.html` is the messy multi-bundle case (§8 phases it
second).

## 3. The transport gate (the part Steve called out)

`fetch()` of local files is blocked on `file://`, and there's no network
latency to hide there anyway. We already have this exact gate for the city
database — [city-search.ts](../src/shared/city-search.ts) does:

```
const isFileProtocol = location.protocol === 'file:';
// http(s): fetch cities-data.json.gz (progress-trackable)
// file://: inject the <script> form; local reads have no latency to hide
```

The progress bootstrap mirrors it precisely:

- **`http:` / `https:`** → fetch each bundle with a streaming reader, drive the
  bar, then execute (§4).
- **`file:`** (or `fetch`/`ReadableStream` unavailable, or any bootstrap
  error) → **plain ordered `<script>` injection, no bar** (§4e). Identical
  end state to today.

One `canUseFetchPath()`-style predicate, same shape as city-search, is the
whole gate.

**`file://` is a first-class client, not a degraded fallback (Q1).** It's the
path that lets someone keep running the app indefinitely from a local copy —
offline, and even if the server is someday shut down. So the no-bar injection
path is a co-equal supported mode: on `file://` the manifest and bar are
simply absent and the app loads exactly as it does today. The one hard
requirement this imposes: removing the static `{{SCRIPTS}}` tags must not
weaken `file://` at all — the injection path has to be as bulletproof as the
tags it replaces (verified per §11 test matrix).

## 4. Mechanism

Everything runs from a small **inline** bootstrap (it must execute before the
bundles, so it can't itself be an external script). It's authored once as a
partial and injected into all three templates via the existing `awk`
partial-injection system (`{{LOADER_BOOTSTRAP}}`, alongside
`{{LOCATION_DIALOG}}` etc. in [build.sh](../build.sh)).

### 4a. Build-time size manifest — and why it must be *uncompressed* sizes

The bar needs a denominator (total bytes) up front to show an accurate
percentage from 0%. **We cannot use the `Content-Length` header for this**:

> If the server sends the JS gzip/brotli-compressed, `response.body`'s
> ReadableStream yields **decompressed** bytes while `Content-Length` is the
> **compressed** size. Dividing decompressed-received by compressed-total
> sends the bar shooting past 100%.

So `build.sh` emits a per-page manifest of **uncompressed** byte sizes (which
it has for free — it just built the files; `wc -c`/`stat`). The ReadableStream
counts decompressed bytes, matching the manifest regardless of whether
transfer compression is on. (✅ confirmed 2026-07-19: production serves the
bundles `content-encoding: br`, so this is not hypothetical — Content-Length
would be the brotli size.) The manifest is a tiny inline JSON in each HTML,
e.g.:

```html
<script>window.__BUNDLES__ = {
  app: "chronometer",           // which start() to call; see §5
  files: [                      // ORDER MATTERS: faces first, engine last (§5)
    { src: "face-terra.js",         bytes: 1892356 },
    { src: "chronometer-engine.js", bytes: 1697760 }
  ]
};</script>
```

`bytes` drives the denominator; the ordered `src` list is also the execution
order. (Decompressed-byte progress tracks wall-clock download progress well
because the inflate rate is ~proportional to the compressed-arrival rate.)

### 4b. The bar UI

Markup + inline CSS live in the template `<head>`/top-of-`<body>` so they paint
the instant the HTML parses (no dependency on the bootstrap). A fixed,
centered element:

- a determinate fill (`transform: scaleX(pct)` — cheap, compositor-only);
- a short label that moves through three states:
  - **"Loading… 43%"** while bytes download (fill tracks `received/total`);
  - **"Initializing…"** once download hits 100% but the app hasn't painted
    its first frame yet — fill stays full (Q2, see §4g);
  - a **stalled/failed** treatment (§4f).

The bootstrap owns the fill width and the label. It removes itself on the
first-frame signal (§4g), with a backstop timeout so it can never strand.

### 4c. Fetch + progress accounting

For each file in the manifest, `fetch(src)`, then read `response.body`'s
reader in a loop, adding each chunk's `.length` to a shared `received`
counter and repainting the bar as `received / total`. Fetch **in parallel**
(browser caps ~6/origin) for speed; the counter is shared across streams.

`all.html` wrinkle (§8 phase 2): 17 parallel multi-MB streams hold ~18 MB of
decompressed JS text in memory before execution — non-trivial on the phone
memory floor this project already tracks. Mitigations, in order of preference:
(a) execute-and-release each face as its stream finishes (faces are
order-independent, §5), holding only the engine back until all faces have run;
(b) cap concurrency (e.g. 6) so at most N bodies are resident at once. This is
`all.html`-only (commit 3, §8); the single/double-bundle pages sidestep it
entirely.

### 4d. Executing the fetched code

**Decided default (Q3): blob-URL `<script>` per bundle**, injected in manifest
order. For each downloaded body, `new Blob([text], {type:'text/javascript'})`
→ `URL.createObjectURL` → `<script src={blobUrl}>` appended and awaited
(`script.async = false`, appended sequentially, guarantees ordered
execution); `revokeObjectURL` on load. This is my recommendation because it
**guarantees a single download** — the property that matters most on the slow
networks this feature targets — needs no server cache cooperation, and, since
there are no CSP meta tags in any source HTML (verified), is not blocked
page-side. Its one real cost (V8 bytecode-cache loss on repeat visits, §10.3)
is minor next to the first-load download it protects.

The only thing that could force the warm-cache fallback (§9) instead is a
production `Content-Security-Policy` **header** that forbids `script-src
blob:` — a pre-deploy check, not a blocker (§10.2).

Why not the obvious alternatives:

- **Fetch-to-warm-cache, then inject real `<script src>`** (preserves V8
  bytecode cache, no `blob:`): rejected as the default because it makes a
  *second* request per bundle, and if the host sends `Cache-Control: no-store`
  that's a **full re-download** — doubling bytes on exactly the slow networks
  we're helping. Blob execution guarantees one download. (Kept as a fallback
  option if code-cache on repeat visits proves to matter — see §9.)
- **`eval` / `new Function`**: needs `unsafe-eval`, worse stack traces. No.
- **Service Worker streaming**: the SW isn't installed on the *first* visit —
  the slowest, most important one — so it can't show a bar then. No (§9).

### 4e. `file://` and error fallback

A single `injectPlain(files)` helper appends **all** `<script src>` elements at
once with `async = false` — no fetch, no bar. `async=false` on
dynamically-inserted scripts makes the browser fetch them in parallel and
execute them in insertion order (the "ordered async=false" rule), matching the
old static tags. (Do **not** chain on `onload` — that serializes the reads and
was a measurable `file://` slowdown on the 17-bundle all.html.) Used when
`canUseFetchPath()` is false **and** as the `catch` for any unexpected
bootstrap failure. This is the same
mechanism city-search already relies on for its `file://` data path, so it's
well-trodden. Note: because we're removing the static `{{SCRIPTS}}` tags, the
`file://` path now goes through injection too, so it must be tested (Steve
runs `file://`) — see §11/Q1.

### 4f. Stalled / failed / retry — the core UX

This is the feature's whole point, so it's not optional:

- **Fetch rejects** (network drop, DNS, 5xx) → bar turns red, label becomes
  "Download interrupted" with a **Retry** button that re-runs the bootstrap.
- **Stall detector**: if `received` doesn't advance for ~8 s, show "Connection
  may be stalled…" (bar stays where it is) so the user can decide to bail —
  without yet declaring failure.
- A bundle that 200s but is truncated will fail at execution → same failed
  state.

### 4g. First-frame handoff — "Initializing…" (Q2)

Download reaching 100% is **not** "app ready": the blob scripts still have to
execute, and for Chronometer that means decoding images, building caches, and
rendering the first frame. If the bar vanished at 100% we'd hand the user a
fresh blank screen for that beat — the exact anxiety we're removing, just
relocated. So the bar holds at full with an **"Initializing…"** label until
the app actually paints, then disappears.

**Complexity comment (Steve asked me to weigh in):** this is worth doing and
it is *not* much code. The clean, reliable way is an explicit hook — each
entry calls `window.__appReady?.()` right after its first successful render,
and the bootstrap resolves the bar-removal on that call. Cost:

- **~1 line in each of the 3 entries**, at a point each already has:
  Chronometer after the first `renderFrame` in `main()`
  ([engine-entry.ts](../src/engine-entry.ts)); Observatory after its first
  frame paints (its `init` ends in `scheduleFrame()`, so the call belongs in
  the first rAF tick, not at the end of `init()`
  — [observatory-entry.ts:1420](../src/observatory/observatory-entry.ts));
  Inspector after its first draw
  ([inspector-entry.ts](../src/inspector/inspector-entry.ts)).
- **A few lines in the bootstrap**: a promise the hook resolves, plus a
  **backstop** (remove the bar anyway ~10 s after 100%, or on first user
  interaction) so a missing/late `__appReady` can never leave the bar
  stranded over a working app.

I considered a zero-touch alternative — remove the bar after a double
`requestAnimationFrame` post-execution — but it's unreliable when init awaits
async image decode (rAF fires in the gaps, so the bar could clear *before* the
faces paint, reintroducing the flash). The explicit hook is only marginally
more code and is correct, so I recommend it. If you'd rather avoid touching the
entries at all, the fallback is: keep the bar to 100% only, accept the brief
post-download blank on big pages — smaller change, worse feel.

## 5. Boot-order analysis (why this works without rewriting the entries)

All three apps already **run on execute**, so dynamically injecting their
bundles (which necessarily happens after `DOMContentLoaded`, once fetches
resolve) is fine — *provided* face bundles execute before the engine:

- **Chronometer** — [engine-entry.ts](../src/engine-entry.ts) tail:
  `readyState === 'loading' ? on DOMContentLoaded : main()`. Injected
  post-DCL ⇒ `main()` runs synchronously at end of the engine script. It reads
  `window.ChronometerFaces`, which the face bundles *push* to (pure data, no
  self-run). ∴ **execute faces first, engine last** (the manifest order in
  §4a). This is a change from today's engine-first tag order, but produces
  correct behavior because faces only populate the array.
- **Observatory** — [observatory-entry.ts:1420](../src/observatory/observatory-entry.ts)
  has the same `readyState` guard → `init()` runs on execute. Single bundle,
  nothing to order.
- **Inspector** — [inspector-entry.ts](../src/inspector/inspector-entry.ts)
  initializes at **module top level** (no DOMContentLoaded listener at all) →
  runs on execute. Single bundle.

After the last bundle executes, the bootstrap calls
`window[__BUNDLES__.app].start?.()` **only if** the app exposes an explicit
start (Chronometer does: `window.Chronometer = { start: main }`). Observatory
and Inspector self-run, so `app` there is informational and the call is a
no-op/omitted. **No boot-logic rewrite is required** — the existing
`readyState`/top-level auto-run is left as-is. The *only* change inside the
entries is the one-line `window.__appReady?.()` first-frame hook from §4g,
which is orthogonal to how they boot.

Backward-compat: the harness ([layout-harness.html](../harness/layout-harness.html)
loads TS via `<script type="module">`, not the dist bundles) and any scratch
builds that use static tags are untouched — we're only changing the generated
dist templates, and the entries' existing auto-run still fires for static-tag
consumers (`readyState === 'loading'` during their parse).

## 6. Build & template changes

- **[build.sh](../build.sh)**: for each generated page, compute
  `wc -c` per bundle and emit the `window.__BUNDLES__` JSON; inject the
  `{{LOADER_BOOTSTRAP}}` partial where `{{SCRIPTS}}` is today; stop emitting
  the static `<script src>` tags (the manifest + bootstrap replace them). The
  per-face `SCRIPTS`, `ALL_SCRIPTS` machinery becomes manifest generation.
- **New partial** `src/partials/loader-bootstrap.html` (or `.js`): the inline
  bar markup + CSS + bootstrap logic (§4). Injected into
  [face-template.html](../src/face-template.html),
  [observatory.html](../src/observatory/observatory.html),
  [inspector.html](../src/inspector/inspector.html).
- **Templates**: add the bar overlay near top-of-body; replace `{{SCRIPTS}}`
  with `{{BUNDLE_MANIFEST}}` + `{{LOADER_BOOTSTRAP}}`.

## 7. Files touched

- [build.sh](../build.sh) — manifest emission, partial injection, drop static tags
- `src/partials/loader-bootstrap.html` — **new** (bar + bootstrap)
- [src/face-template.html](../src/face-template.html) — bar markup, placeholder swap
- [src/observatory/observatory.html](../src/observatory/observatory.html) — same
- [src/inspector/inspector.html](../src/inspector/inspector.html) — same
- [engine-entry.ts](../src/engine-entry.ts),
  [observatory-entry.ts](../src/observatory/observatory-entry.ts),
  [inspector-entry.ts](../src/inspector/inspector-entry.ts) — one-line
  `window.__appReady?.()` first-frame hook each (§4g). Boot logic otherwise
  untouched.

## 8. Commit breakdown (Q4)

All pages land **before deploy** — this isn't a staged rollout. The split is
purely for review and bisect hygiene: each commit is independently correct and
testable, and the riskiest piece is quarantined so it can be reviewed (or
reverted) without dragging the rest.

> **Workflow (do not deviate): Steve owns the commits.** At each commit point
> below, Claude stops with the change complete and working, hands off for
> **Steve's manual verification**, and **waits for Steve to make the commit**.
> Claude does not run `git commit` (or `git add`) and does not start the next
> commit's work until Steve says to proceed. Each pause includes a short "what
> to verify" note (the relevant slice of §11).

Revised seam (2026-07-19): the original commit 2/3 split fell along "face
pages vs all/selected," but those three share `face-template.html`, so the
page-conversion is really one unit. The real orthogonal seam is
page-conversion vs the many-bundle memory optimization (a bootstrap-only
change). So:

- **Commit 1 — mechanism + single-bundle pages (observatory, inspector).**
  ✅ **done (build 2.0.67).** Introduces the whole apparatus: the
  `loader-bootstrap` partial (bar UI, fetch/progress, blob execution,
  error/stall/retry, `file://` injection fallback), the `build.sh` manifest
  emission, the template placeholder swap, and the `__appReady` hook in the
  observatory + inspector entries. Banks the biggest single win (observatory,
  5.5 MB) up front.
- **Commit 2 — all engine-based pages** (`{face}.html`, `all.html`,
  `selected.html`) + the engine `__appReady` hook. ✅ **built (2.0.69).**
  Converts everything sharing `face-template.html`: the two-bundle
  "faces first, engine last" ordering (§5) and the 17-bundle `all.html`/
  `selected.html`, which the existing bootstrap already handles (parallel
  fetch, ordered execute). **Also folds in the `file://` parallel-injection
  fix** (§4e): `injectPlain` now appends all bundles at once with
  `async=false` instead of chaining on `onload`, so the `file://` path
  fetches in parallel and executes in order — matching the old static tags.
  Without it, commit 2 would regress `file://` all.html from ~parallel to
  serial 17-bundle loads (Steve caught this: 2–3 s vs 1 s). Kept in commit 2
  so the commit never ships the regression.
- **Commit 3 — bootstrap memory optimization.** Adds the execute-and-release /
  concurrency cap from §4c to `loader-bootstrap.html` — a pure bootstrap
  change, no page wiring — so the 17-bundle `all.html` doesn't hold ~18 MB of
  decompressed bodies resident before executing (http path only). Isolated and
  bisectable, which is the whole reason to keep it separate; lands before
  deploy so no user sees the un-optimized intermediate.

## 9. Rejected alternatives

- **Indeterminate spinner (Tier 1)**: simpler, but doesn't answer "how much
  longer" or "is it dead" — Steve's explicit reason for wanting Tier 2.
- **Fetch-warm-cache + real `<script src>`**: preserves bytecode cache and
  avoids `blob:`, but risks a full second download under `no-store`. Fallback
  candidate, not default (§4d).
- **Service Worker**: no coverage on first visit — the case we most need.
- **`eval`/`new Function`**: CSP + debuggability cost for no benefit over blob.

## 10. Risks & gotchas

1. **Compression/`Content-Length` mismatch** — handled by using uncompressed
   manifest sizes as the denominator (§4a). The one thing that *must* be right.
2. **Production CSP header** — ✅ **verified 2026-07-19**: `https://spucci.us/ecweb/`
   sends **no `Content-Security-Policy` header** (nginx) on the HTML or the JS
   bundle, so `script-src blob:` is not blocked — blob execution is safe in
   production. (If a CSP is ever added, allow `blob:` or switch to the
   warm-cache fallback, §9.)
3. **V8 bytecode cache** — blob scripts aren't keyed by a stable URL, so repeat
   visits lose code-cache reuse. Download dominates on the target slow
   networks, so this is an accepted minor cost; revisit only if repeat-visit
   parse time regresses.
4. **`all.html` memory** — 17 resident decompressed bodies; mitigated in §4c.
5. **`file://` regression** — static tags are gone; the injection fallback now
   carries `file://`. Must be verified (Q1).
6. **The bigger lever is payload size** — 5.8 MB / ~18 MB is mostly base64
   PNG data-URLs embedded in the bundles (base64 inflates ~33% and gzips
   poorly). A progress bar makes the wait legible; per-face code-splitting,
   real binary image assets loaded on demand, and confirmed brotli/gzip make
   it *shorter*. Out of scope here but noted as the real cure.

## 11. Verification / test matrix

Because we're removing the static `<script>` tags, both transports need
explicit coverage. (Per the dist-preview cache gotcha in project memory: use a
**fresh port** and confirm the `build N.N.N` stamp so a stale bundle can't
masquerade as a pass.)

**`http(s)` — the new path:**

- Each page group boots and paints: observatory (1 bundle), inspector (1),
  a single face (2), `all.html` (17). Bar appears → advances → 100% →
  "Initializing…" → app paints → bar removed; no console errors.
- **Throttled** (DevTools Slow 3G) so the bar visibly *moves* and the
  percentage tracks reality — the whole point.
- **Compression sanity**: with server gzip/brotli on, the bar must not exceed
  100% (confirms §4a's uncompressed-manifest denominator).
- **Stall/fail**: kill the network mid-download → red bar + "Retry"; Retry
  restarts cleanly. Stall detector fires after ~8 s of no bytes.
- **Repeat visit**: second load serves bundles from HTTP cache (Network panel:
  no second full download); bar zips to 100%.
- **`all.html` memory**: watch the `[mem]` ledger — 17 bundles must not blow
  the phone floor (validates the §4c execute-and-release / concurrency cap).

**`file://` — the first-class path (Q1), must equal today:**

- observatory, a single face, `all.html`, inspector each load with **no bar**,
  **no console errors**, and full functionality — identical to the current
  static-tag behavior. This is the gate that removing `{{SCRIPTS}}` mustn't
  regress.

## 12. Decisions (resolved 2026-07-19)

- **Q1 — `file://` is first-class.** Not a fallback: it's how users keep the
  app forever, offline, even if the server is retired. No bar there (plain
  injection, as today); the injection path must be as robust as the tags it
  replaces (§3, §11 gate). ✔
- **Q2 — hold through init with "Initializing…".** Worth the small cost:
  a one-line `window.__appReady?.()` hook per entry + a bootstrap backstop
  (§4g). Prevents a second blank flash after download completes. ✔
- **Q3 — blob-URL execution is the default.** Guarantees a single download
  (the property that matters on slow networks); warm-cache + real `<script>`
  kept only as the escape hatch if a production CSP *header* forbids `blob:`
  (§4d, §10.2). ✔
- **Q4 — all pages before deploy, three commits.** Split by page complexity
  (single-bundle → single-face → `all.html`) for review/bisect hygiene, not
  staged release (§8). ✔
