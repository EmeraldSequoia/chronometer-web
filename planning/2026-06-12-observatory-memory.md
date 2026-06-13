# Observatory memory usage — measurements and reduction ideas

Measured 2026-06-12 on the dist build, viewport 393×851 @ devicePixelRatio 2
(representative of an inexpensive phone). Budget goal: **stay within ~100 MB
total on inexpensive phone browsers.**

## Measured baseline

| Component | Size | Notes |
|---|---|---|
| JS heap, steady state | **~65 MB** | `performance.memory.usedJSHeapSize` after GC settles (~8 s after load) |
| JS heap, peak during load | ~98 MB | parse-time garbage; recovered by GC |
| Canvas backing stores | **~22 MB** | see breakdown below; scales with dpr² |
| Resident decoded images | ~1.5 MB typical | only current-month + night image drawn per frame; browser evicts the rest (worst case ~24 MB if all decoded at once) |
| **Total steady state** | **~90 MB** | ~110 MB on a DPR-3 phone (canvas buffers grow) |

### JS heap breakdown (~65 MB)

- **~45 MB: cities/airports database** (`cities-data.js`, 19 MB source).
  Parses into `window.ChronometerCities` — `CITIES` is 167,617 records
  (array-of-arrays incl. long alternate-name transliteration strings,
  ~15 MB of raw JSON, 2–3× that as live JS objects), plus `AIRPORTS`
  (21,080), `TZ`, `CC`, `AD`. **This is the dominant consumer.**
- **~10 MB: observatory-engine.js** (5.4 MB source kept as module code,
  plus all image assets inlined as base64 data-URL strings that stay alive
  in module scope forever — esbuild `--loader:.png=dataurl` in build.sh).
- ~10 MB: normal runtime/DOM.

### Canvas backing stores (~22 MB at DPR 2; each is viewW×viewH×dpr²×4 bytes)

- Main canvas (`observatory-canvas`): 786×1702 = 5.1 MB at the test size
- `background.ts` staticCache (full viewport): 5.1 MB
- `main-dial.ts` staticCache (full viewport): 5.1 MB
- `peripheral-dials.ts` staticCache (full viewport): 5.1 MB
- Night mask (`earth-view.ts`, earth-area sized): ~1 MB
- Transient: `earth-view.ts` `drawEarthView` allocates a fresh earth-area
  `OffscreenCanvas` (`dayMaskCanvas`) **every frame** — GC churn, not
  steady-state, but contributes to the load spike.

On a DPR-3 phone (1080×2400 — common on cheap Androids) the four
full-viewport buffers are ~10 MB *each* (~41 MB total): dpr² is what makes
cheap-but-high-res phones expensive.

## Reduction ideas, roughly in impact order

1. **Lazy-load the cities DB (~45 MB).** Load `cities-data.js` only when
   the location dialog opens (most sessions arrive with `?lat=&lon=` from a
   bookmark and never open it). Optionally release after the dialog closes.
2. **Keep the cities DB compact instead of as live objects.** The ~3×
   blow-up from 15 MB of JSON to ~45 MB of heap is per-object overhead:
   167k small arrays, each holding several short JS strings. Two ways to
   avoid materializing them:
   - *String-scan form:* keep the data as one big newline-delimited string
     (~15 MB as a single heap allocation). City search runs
     `indexOf`/regex over the string and `JSON.parse`s only the handful of
     matched lines into objects. Search this way over 15 MB is tens of
     milliseconds — fine for a typeahead.
   - *Columnar form:* build-time-pack lat/lon/population/tz-index into
     `Float32Array`/`Uint32Array` columns, and concatenate all names into
     one string with an offsets array. Same idea, faster search, more
     build tooling.
   Either combines with idea 1 (lazy load), and the win is independent:
   lazy-loading helps sessions that never search; compact form caps the
   cost for sessions that do. Also: alternate-name transliterations are
   the bulk of the chars and only needed for matching, never display —
   they could live in a separate lazily-fetched blob, or be trimmed at
   build time.
3. **Cap effective DPR for the full-viewport caches.** Rendering the three
   static caches (and possibly the main canvas) at min(dpr, 2) saves ~23 MB
   on DPR-3 phones at modest sharpness cost; dial artwork is mostly smooth
   curves and may tolerate it. Could cap only when the device looks
   memory-constrained (`navigator.deviceMemory`).
4. **Shrink the three static caches to their used area.** Background must be
   full-viewport, but main dial and peripheral dials could be cached at
   their bounding boxes instead of full viewport (peripheral dials overlap
   the whole frame, so this may only help the main dial: dial diameter vs
   full viewport).
5. **Reuse the per-frame `dayMaskCanvas`** in `earth-view.ts` (module-level
   like `maskCanvas`) — removes per-frame allocation churn and trims the
   load-time peak. Easy win, small steady-state effect.
6. **Don't inline rarely-used images as base64 in the engine bundle.**
   Inlined data-URL strings (~4 MB across assets) live in the JS heap
   forever; separate files are fetched, decoded, and the compressed copy
   can be evicted. Trade-off: build.sh currently ships single-file engines
   on purpose.

## Methodology notes (to reproduce)

- Build with `./build.sh`, serve dist (launch.json "dist", port 8741),
  open `/observatory.html?lat=37.77&lon=-122.42` (URL params skip the
  location dialog).
- JS heap: `performance.memory.usedJSHeapSize` in Chrome; wait ~8 s after
  load for GC before reading steady state.
- Canvas memory: enumerate the buffers in code (the three staticCaches +
  main canvas + earth-view masks) and compute w×h×4; they are not visible
  to `performance.memory`.
- Decoded-image cost is width×height×4 regardless of file format; file
  format only affects download and the base64 string size in the bundle.

## Related context

- The night image was upgraded to `night@4x.jpg` (1200×600, +2.2 MB decoded
  vs the old 600×300) on 2026-06-12 — already included in the baseline math
  above (+2.2 MB puts steady state at ~92 MB).
- The map area renders at ~25% of viewport width in desktop landscape
  (~960 physical px on a fullscreen 4K monitor), which is why 1200-wide was
  chosen over 2400-wide for the night image.
