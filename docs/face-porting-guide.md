# Face Porting Guide

Step-by-step procedure for porting a watch face from the iOS/Android Chronometer app to this TypeScript web application.

> **Prerequisites**: Run `scripts/clone-refs.sh` to clone the reference repos. See [ios-reference.md](ios-reference.md).

> **Rules**: Before starting, read [Development Rules](development-rules.md) — especially §2 (never simplify iOS algorithms) and §9 (if blocked, ask).

## 1. Locate the Source XML

- **Standard location**: `.chronometer-ref/Watches/Builtin-Android/<Face> I/<Face> I.xml`
- **Naming**: Face "Foo" → directory `Foo I/` with file `Foo I.xml`
- **Variant II**: Some faces use `Foo II/Foo II.xml`. We never use "II" names in the web app. If you're porting a "II" face and the user hasn't specified a web app name, **stop and ask**.

## 2. Copy and Clean the XML

1. **Copy** the Android XML file to `src/watch/assets/<face_name>/`
2. **Remove night mode**: Delete any parts with `modes='night'`, night-mode terminators, or night-specific QWheels. Night mode is not implemented.
3. **Add `bezelColor`**: Always add a `bezelColor` attribute to the `<watch>` tag. If there's a "case" image, use its bezel color and delete/skip the image part. Example: `bezelColor='rgb(160,160,160)'`

## 3. Set Up Image Assets

- Use **`4x` or `2x`** high-resolution assets where available (e.g., `faceFront-4x.png`)
- Apply scaling in the face setup file: `scale: 1/4` for 4x images
- **Check `parts-bin/` first** — common images shared across faces live in `src/watch/assets/parts-bin/`. Only add to per-face directory if the asset is unique to this face.

## 4. Port C++ Logic to TypeScript

When the XML uses expression functions not yet in the web app:

1. **Trace the function** through the iOS code (see [iOS Reference — Tracing](ios-reference.md#tracing-an-expression-to-its-implementation))
2. **Define the function** in `watch-env.ts` or a related module, strictly following the C++ implementation
3. **Never simplify** — see [Development Rules §2](development-rules.md#2-never-simplify-ios-algorithms)
4. **If blocked, ask** — see [Development Rules §9](development-rules.md#9-if-blocked-ask)

Remember that `watch-env.ts` is bundled into `chronometer-engine.js` (the shared engine). Adding new environment functions requires a full `bash build.sh` rebuild.

## 5. Declare XML Metadata & Asset References

The web app build process resolves and generates the face registration code dynamically. You must define the required metadata attributes on the root `<watch>` tag of the copy of the XML file:
- `displayName`: The formatted name of the face (e.g. `displayName="Basel"`).
- `description`: A short description of the face's main features (e.g. `description="Sidereal time with zodiac dial and eclipse indicator"`).
- `urlAbbrev`: A unique 2-letter abbreviation code (e.g. `urlAbbrev="bs"`).

> [!IMPORTANT]
> The build will fail if either `displayName` or `description` is missing on the `<watch>` element.

All image files referenced in the XML elements (e.g., `faceFront.png`) must be placed either in the face's local asset directory (`src/watch/assets/<face_name>/`) or in the shared parts bin (`src/watch/assets/parts-bin/`). The build-time generator automatically finds them, determines their scaling (e.g., `0.25` for `-4x.png`), and sets up their dynamic import.

## 6. Update the Build System

Register the new face by adding its folder/slug name (e.g., `<face_name>`) on a new line in [faces.txt](file:///Users/spucci/chronometer-web/faces.txt).

The build system will automatically:
1. Compile the face TypeScript module under `src/faces/generated/`.
2. Generate its viewer HTML page (e.g. `dist/<face_name>.html`).
3. Construct the home page index card and append it in the correct order.
4. Update the picker configuration list and multi-face view templates.

See [Build System](build-system.md) for full details.

## 7. Verify Rendering

Build the project:
```bash
bash build.sh
```

Open the face directly via `file://` URL with location parameters:
```
file:///path/to/dist/<face-name>.html?lat=37.33182&lon=-122.03118
```

Check:
- All dials, text, and ticks render correctly
- No overlapping artifacts or orphaned windows
- No text misalignments
- Browser console is free of rendering errors or unimplemented function errors
- Drawing order matches the iOS app (parts layer correctly)

## 8. Offset-Radius Hands

If the face has hands with `offsetRadius > 0` (e.g., moon orbit, subdial hands), verify the polar-offset rendering matches iOS behavior. See [Rendering — Offset-Radius](rendering.md#offset-radius-hand-rendering).

## 9. Thumbnails

- **Thumbnail**: rendered, not screenshotted. With the face in `faces.txt` and a dist server running, `PW_DIR=<dir with playwright installed> node scripts/render-thumbs.mjs <port> <slug>` renders the face at the house capture instant (10:09:30 on 2026-10-16, Cupertino, frozen; see the script for the per-face exceptions) and writes two files: `src/faces/masters/thumb-<slug>.png`, a 1024×1024 master with transparent corners, and `src/faces/thumb-<slug>.png`, the same at 400×400. The 400 one is what the cards and favicons use and what the generated face module inlines into the face bundle (so it must stay small); the build flattens the master onto the page background for the 1024 px `dist/icon-<slug>.png` the web-app manifest (macOS Add to Dock) uses.
  > [!IMPORTANT]
  > **Transparency Requirement**: both files **must** have transparent corners (every pixel outside the circular dial — radius ~198 px of the 400 box, ~506 px of the 1024 master — transparent). Do not bake the dark blue `#1a1a2e` background or any other solid color into the corners. This is crucial for:
  > - Allowing browser tab favicons to render with clean transparent circular borders.
  > - Preventing dark blue square corner outlines from showing up when the apple-touch-icon background is generated dynamically with a custom bezel-matched color.
  > - The opaque Dock icon is derived from it at build time, never the other way round.
  
  The homepage and picker page will automatically display this thumbnail.
- **Index card**: The index card is generated automatically at build time based on the `displayName` and `description` attributes defined in your watch XML file.

## 10. Interactive Features

If the face has interactive features (body selector, city picker), see [Development Rules §7–§8](development-rules.md#7-interactive-controller-patterns) for the URL parameter and animation-preserving patterns.

## 11. Help Content

Each face should have a help file that describes what the face displays. Help content is sourced from the Android (Wear OS) help files.

1. **Find the source**: Locate the Android help file in `/Users/spucci/aw/<dir>/<face>_i.html` (see [Help System](help-system.md) for the directory mapping)
2. **Extract the body**: Copy only the content between the `<!-- Boilerplate code above here -->` and `<!-- Boilerplate code below here -->` markers
3. **Adapt the content**:
   - Strip Android-specific text (ambient mode, gear button, long press instructions)
   - Strip the banner image and any buy/download links
   - Rewrite cross-face links to point to our pages (e.g., `../miami/venezia_i.html` → `venezia.html`)
   - Rewrite image `src` paths to `help/images/<dir>/imagename.png`
   - Remove or rewrite links to `emeraldsequoia.com`
   - Keep Wikipedia and other educational external links (with `extlink.png` icon)
4. **Save as fragment**: Write the adapted HTML (no `<html>`/`<head>`/`<body>` tags) to `src/help/<face-slug>.html`
5. **Copy images**: Copy any referenced inline images from the Android directory to `src/help/images/<dir>/`
6. **Verify**: Run `bash build.sh`, open the face page, click ℹ, and confirm the help content appears correctly below the separator

See [Help System](help-system.md) for the full architecture and extraction rules.

## Related Docs

- [XML Parsing](xml-parsing.md) — Part type taxonomy and attribute conventions
- [Rendering](rendering.md) — How parts are drawn
- [Animation](animation.md) — Update intervals, animation speed
- [iOS Reference](ios-reference.md) — Navigating the reference repos
- [Build System](build-system.md) — Dynamic faces.txt workflow
- [Development Rules](development-rules.md) — Critical invariants
- [Help System](help-system.md) — Help content architecture and source material
