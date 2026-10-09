# Mac Dock icons for "Add to Dock" web apps — plan (2026-10-09, rev 5 — implemented)

## Status (2026-10-09, build 2.1.22, uncommitted)

Implemented, green (tsc, 8992 vitest tests), verified on the dist server:
every page links its own `app-<x>.webmanifest` (served as
`application/manifest+json` by python's http.server), each manifest names
an opaque `icon-<x>.png` that resolves, and the small thumbs are what the
pages load.

- `scripts/render-thumbs.mjs` (Playwright + Chrome channel + ImageMagick;
  `PW_DIR` points at a scratch `npm i playwright`): 16 faces + Observatory
  rendered at the instants below, 1024 masters in `src/faces/masters/`,
  400 thumbs in `src/faces/`, all-faces 2×2, and the Chronometer icon.
- **Masters live outside `src/faces/` on purpose**: the generated face
  modules `import thumbImg from '../thumb-<slug>.png'` and esbuild inlines
  it as a data URL into every face bundle and pick-page.js. The first build
  with 1024 thumbs in place took pick-page.js from 3.3 MB to 18 MB.
- build.sh: `emit_manifest`, `make_icon` (magick, warns + copies if absent),
  per-page `{{MANIFEST}}`; `src/app.webmanifest` and
  `src/apple-touch-icon.png` removed; `src/icon-chronometer.png` and
  `src/icon-inspector.png` added (1024 opaque, shrunk to `thumb-*.png`
  for favicons / apple-touch-icons / corner links).
- dist: 58 → 74 MB (the 13 MB of 1024 icons). 512-px icons would be ~3 MB
  if that matters for dist.zip.

Still to do, Steve only:
1. Safari → File → Add to Dock on a face page, Observatory, Inspector,
   the eclipse table and the index: bare icon, no plate / glass tile.
2. `curl -I <live host>/app-chronometer.webmanifest` must say
   `application/manifest+json` (the web app's live path wasn't findable
   from the repo — emeraldsequoia.com/eo/ is a different page).
3. iPhone: home-screen icon for index/pick/help is now the sharper HD crop.
4. Commit.

## Why the plate appears today

- `src/app.webmanifest` is one shared static file with only `display` and
  `scope`. No `icons`, no `name`. Face pages, index, pick, help, Observatory
  and Inspector link it; the eclipse table does not.
- With no manifest icon, Safari on macOS falls back to the page favicon.
  On face pages that is `thumb-<face>.png`: 400×400, transparent corners
  (clipped circle, per face-porting-guide §9). Transparent margins = shrunk
  onto the white/grey plate. Observatory: same (`thumb-observatory.png`).
  Inspector: an inline SVG magnifier favicon, no PNG at all. Eclipse table:
  `thumb-eclipses.png`, 400×400, already opaque.
- `apple-touch-icon.png` (152×152) is ignored by macOS Add to Dock.
- pick/selected swap in a dynamic data-URL composite at runtime
  (`composite-icon.ts`): transparent for `rel=icon`, bezel-tinted opaque for
  `apple-touch-icon`.

## Where the thumbs came from

- Face thumbs: Steve-supplied screenshots, `sips -z 400 400`, corners made
  transparent by hand (face-porting-guide §9). No script exists.
- Observatory: a crop of the colored round dial (commit e250b96).
- Eclipses: center-crop of `src/shared/assets/totalEclipse.png` (316×316) —
  cannot be upscaled; keep, or a NASA public-domain corona (needs approval).
- Inspector: vector SVG, free to rasterize at any size.

## Steps

### 1. Re-render the face and Observatory thumbs at 1024 (new script)

`scripts/render-thumbs.sh` using the headless-Chrome recipe already proven
on this repo (memory: headless-dist-page-screenshots):

- Serve dist; seed a Chrome profile per instant via `dist/__seed.html`
  writing `ec:shared {lat,lon,city,tz,lsrc,t,dir:0,v:1}` and `ec:meta` so no
  location dialog / toast, with the instant frozen (`dir:0`).
- **Capture instants (Steve, 2026-10-09).** The house convention: the
  "standard" 10:10 hands, an interesting Moon phase, second hand at 30.
  Location = the docs' Cupertino test point (37.33182, -122.03118,
  America/Los_Angeles); all times below are local there, PDT.

  | Faces                       | Local time              | `t` (epoch ms)  |
  |-----------------------------|-------------------------|-----------------|
  | all faces except the four   | 2026-10-16 10:09:30     | 1792170570000   |
  | Selene                      | 2026-10-28 10:10:00     | 1793207400000   |
  | Vienna                      | 2026-10-09 20:10:00     | 1791601800000   |
  | Basel                       | 2026-10-09 21:00:30     | 1791604830000   |
  | Milano                      | 2026-10-09 10:10:00     | 1791565800000   |

  Observatory: the default instant (2026-10-16 10:09:30) unless its dial
  looks better elsewhere. Five seeded profiles, copied per shot.
- Per face: `Chrome --headless=new --window-size=1200,1200
  --force-device-scale-factor=2 --virtual-time-budget=30000 --screenshot`
  of `<face>.html` (alarmed, 5 in parallel per batch). The dial will be
  ~2000 px across — plenty for a 1024 crop.
- Crop: a head-injected script reads the engine's dial centre/radius and
  stashes it in `document.title` (read back with `--dump-dom` to a file);
  fallback is a locating shot + eyeball. Then
  `magick shot.png -crop WxH+X+Y -resize 1024x1024 \( +clone -fill black
  -colorize 100 -fill white -draw 'circle 512,512 512,8' \) -alpha off
  -compose CopyOpacity -composite thumb-<face>.png` → 1024×1024 with
  transparent corners, exactly the §9 contract at the new size.
- Observatory: same shot of `observatory.html`, crop its dial.
- all-faces (`thumb-all-faces.png`, the index card and all.html favicon):
  composite from the per-face renders (reuse the 2×2 layout from
  `composite-icon.ts`, or a 4×4 of all 16) rather than screenshotting
  all.html, which is flaky under virtual time. It stays a card/favicon
  image only — the Chronometer *app* identity is the iOS icon (§2).
- Caveat (memory): small face pages sometimes screenshot pre-layout under
  virtual time; re-shoot stragglers. Nothing in the app assumes 400 px —
  cards size via CSS, `composite-icon.ts` draws into its own canvas.
- **Size cost:** thumbs are 2.8 MB today at 400 px; 1024 is ~6× the pixels
  → roughly +12–15 MB in a 58 MB dist (dist.zip for file:// users). 512
  would be ~+2 MB. Decide before committing; 1024 is what macOS wants.

### 2. Chronometer identity = the ChronoHD icon (Mauna Kea, upper-left crop)

Non-face Chronometer pages (index, pick, help, all, selected) use the
Chronometer HD app icon, so the Mac Dock matches the iPad app. Verified:
`src/apple-touch-icon.png` is byte-identical to
`.chronometer-ref/ChronometerHD/Images.xcassets/AppIcon.appiconset/ECHD-Icon-152x152.png`
— a tight crop of the upper-left of the Mauna Kea dial (gold case edge,
Equation of Time subdial, date window, "HD" badge). That is the framing to
keep; the problem is only that 152 px is far too small for the Dock.

The ChronoHD icon set is inconsistent: its 1024 marketing icon
(`1024HD.png`) is the *whole* watch at a different instant (2008 JUL 11),
not the crop, so it is not a drop-in source. Two ways to get the crop at
1024:

- **Preferred — from the re-render.** Step 1 already produces Mauna Kea
  at ~2000 px at the house instant. Crop it to the same framing as the
  152 icon (upper-left of the dial: EoT subdial and date window in the
  lower-right of the crop, case edge in the top-left corner), resize to
  1024, opaque. Crisp, same pipeline as everything else. No "HD" badge —
  it means iPad there and nothing on the web. (ChronoAll's skeleton icon
  is a different product; not used.)
- **Fallback — crop `1024HD.png`** to the matching region (~560 px →
  1024, soft, carries the HD badge and the 2008 date). Only if the
  re-rendered dial's case/bezel doesn't match the iOS look well enough.

Decision (Steve, 2026-10-09): the 152 framing of Mauna Kea's *current*
look, without the HD badge, everywhere — the Mac manifest icon **and** the
iOS apple-touch-icon. Ship as `src/icon-chronometer.png` →
`dist/icon-chronometer.png` and retire `src/apple-touch-icon.png`:
index/pick/help/privacy/support/disclaimer `apple-touch-icon` and
`rel=icon`, and the eclipse-table footer `<img>`, all point at the new
file (one asset; iOS home screen and Mac Dock agree).

No iOS back-port (Steve, 2026-10-09): the web icon stands on its own.

### 3. Opaque per-app icons at build time (build.sh)

Next to the thumb copies, for every face plus observatory / eclipses /
inspector (chronometer is already opaque — copied as-is):
`magick src/faces/thumb-<x>.png -background black -alpha remove -alpha off dist/icon-<x>.png`
(optionally `-gravity center -extent 112%` first so the dial has the ~8%
margin iOS's own icons have). Inspector: rasterize its magnifier SVG
(`magick -background '#111827' -density … in.svg -resize 1024x1024`), and
give inspector.html a real PNG `apple-touch-icon` while at it.

### 4. Per-page manifests — one icon per app

build.sh emits `app-<x>.webmanifest` from a template: existing
`display`/`scope`, plus `name`, `short_name`, and
`"icons":[{"src":"icon-<x>.png","sizes":"1024x1024","type":"image/png","purpose":"any"}]`.

| Page(s)                               | manifest / icon          | name          |
|---------------------------------------|--------------------------|---------------|
| `<face>.html`                         | per face                 | "<Face> (Chronometer)" |
| index, all, selected, pick, help      | chronometer (HD crop)    | "Chronometer" |
| observatory.html                      | observatory              | "Observatory" |
| inspector.html                        | inspector (new PNG)      | "Inspector"   |
| eclipse-table.html (add manifest link)| eclipses                 | "Eclipses"    |

face-template.html gets a `{{MANIFEST}}` token next to `{{ICON}}`; the
static pages are edited by hand. No `start_url`/`id`, so each page stays
its own installable app exactly as now; `scope: ./` unchanged, so iOS
cross-app navigation inside the container is unaffected.

### 5. Pick / selected page

The runtime composite can't be a static manifest icon. Mac gets the
Chronometer HD-crop icon;
iOS keeps the dynamic `apple-touch-icon`. Later experiment: a `blob:`
manifest URL built at runtime (Chrome supports it; Safari unverified).

### 6. Server MIME check

`curl -I` the live host for a `.webmanifest`: must be
`application/manifest+json`, or Safari may ignore the manifest.

### 7. Verify

Build, serve dist, Safari → File → Add to Dock on a face page, Observatory,
Inspector and the eclipse table: each dialog thumbnail is its own bare icon,
no plate (this Mac is Tahoe — also confirm the glass tile is gone). iPhone:
home-screen icon for index/pick/help is the same crop as before, sharper; face pages'
icons and scope unchanged. Index/pick cards still look right with the
1024 thumbs.
