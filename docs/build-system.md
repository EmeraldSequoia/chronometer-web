# Build System

The build uses a bash script (`build.sh`) that invokes `esbuild` to bundle TypeScript into browser-ready JavaScript. No development server is needed — the output runs directly from `file://` URLs. The build produces bundles for all apps in the monorepo (Chronometer and Inspector).

## Prerequisites

- **Node.js** v18+ (specifically `npx` for invoking esbuild)
- **Bash** and **zip** (pre-installed on macOS and most Linux)

Build command:
```bash
bash build.sh
```

This can also be run with:
```bash
PATH="/usr/local/bin:$PATH" bash build.sh
```

## Build Architecture

### Three Bundle Types

1. **`chronometer-engine.js`** (shared Chronometer engine) — Contains the core systems shared by all watch faces:
   - Expression parser and evaluator
   - XML parser
   - Renderer
   - Animation system
   - Astronomy library
   - Watch environment (`watch-env.ts`)
   - Time controller
   - City search
   - State management (`app-state.ts` — LocalStorage/URL/in-memory — and `url-state.ts`)

2. **`face-<name>.js`** (per-face bundles) — Each face gets its own bundle containing:
   - The face's XML definition (imported as text)
   - Image assets (imported as data URLs or file references)
   - Face registration call

3. **`inspector-engine.js`** (Inspector app) — A separate bundle containing:
   - Astronomy library
   - Expression parser and evaluator
   - Shared modules (`astro-env.ts`, `location-dialog.ts`, `url-state.ts`, etc.)
   - Inspector-specific code (`inspector-entry.ts`, `expr-metadata.ts`)
   - **Does not include** watch-specific code (XML parser, renderer, watch-env)

   The Inspector bundle is built from `src/inspector/inspector-entry.ts` by esbuild. It shares the same source modules as `chronometer-engine.js` but tree-shakes out all watch-specific code.

### HTML Generation

Each face gets its own HTML file generated from `src/face-template.html`. The template includes:
- The shared engine script
- The face-specific script
- Location panel, time controls, city picker UI
- Navigation elements

The all-faces page (`index.html`) includes all face scripts.

## Adding a New Face

Adding a new watch face requires zero manual changes to the build scripts or templates. The list of active faces is governed entirely by `faces.txt` at the root of the repository, and metadata is declared directly inside the watch XML files.

Follow these steps to add a new face:

### 1. Register in `faces.txt`
Add the face's folder/slug name (e.g. `basel-clone`) on a new line in [faces.txt](file:///Users/spucci/chronometer-web/faces.txt). The order of lines in this file determines the display order on the homepage, the picker, and multi-face viewer pages.

### 2. Define XML Metadata
On the root `<watch>` tag of the watch face's XML file, you must define the following attributes:
- `displayName`: The formatted name displayed on index cards, the picker page, and window titles (e.g., `displayName="Haleakalā"`).
- `description`: A short description of the face's main features (e.g., `description="Sunrise &amp; sunset times with alt/az"`).
- `urlAbbrev`: A unique 2-letter abbreviation code (e.g., `urlAbbrev="bs"`).

> [!IMPORTANT]
> The build process will strictly validate that both `displayName` and `description` are present in the XML. The build will fail if either attribute is missing.

### 3. Add Thumbnail Image
Add a thumbnail image for the new face named `thumb-<slug>.png` inside the `src/faces/` directory. See [Face Porting Guide §9 (Thumbnails)](face-porting-guide.md#9-thumbnails) for the critical transparency requirements.

### 4. Help Content (if applicable)
If the new face has a help file, place the HTML fragment in `src/help/<slug>.html`. The build system will automatically find and inject it by convention. See [Help System](help-system.md) for details on creating help files.

## Engine Bundling Implications

Since `watch-env.ts` is bundled into the shared engine:
- Adding new environment functions (astronomy, time, etc.) requires a full `bash build.sh` rebuild
- Changes to `watch-env.ts` affect **all** faces
- Per-face changes (XML, images, registration) only require rebuilding that face's bundle

## Versioning

The build system automatically tracks and increments the build number. This is driven by a `version.txt` file in the repository root.

- **`version.txt`**: A required file containing the current version string in `<major>.<minor>.<build>` format (e.g., `1.4.1`), along with instructional comments. Blank lines and comment lines (starting with `#`) are preserved.
- **Auto-increment**: Each time `build.sh` is run, it reads `version.txt`, increments the `<build>` component by 1, and updates `version.txt` in place without destroying the comments.
- **HTML Injection**: The computed version is injected via a `{{VERSION}}` placeholder into the HTML templates, making it visible at the bottom of the help modals and the general `help.html` page.

If you need to bump the major or minor version (e.g., from `1.4.x` to `1.5.1`), manually edit the version number inside `version.txt` before running the build script.

## Output Structure

```
dist/
├── index.html                    # All-faces grid page
├── mauna-kea.html               # Individual face pages
├── hana.html
├── ...
├── inspector.html               # Inspector app page
├── chronometer-engine.js         # Shared Chronometer engine bundle
├── inspector-engine.js           # Inspector app bundle
├── face-mauna-kea.js            # Per-face bundles
├── face-hana.js
├── ...
├── cities-data.js               # City database
├── help/
│   └── images/                  # Help content images (copied from src/help/images/)
│       ├── extlink.png
│       ├── geneva/
│       ├── terra/
│       └── ...
├── apple-touch-icon.png         # PWA icon
└── *.png                        # Thumbnail images
```

Note: Help HTML fragments are injected directly into each face's HTML file at build time (inside a `<template>` element), so they do not appear as separate files in `dist/`.

## `file://` Deployment

The app is designed to work from `file://` URLs:
- No web server required
- Users can download `dist/` and double-click `index.html`
- Settings persist in LocalStorage; where it's unavailable on `file://`, the app
  falls back to keeping settings in the URL (bookmark to preserve them)
- See [Location & Cities — file:// Limitations](location-and-cities.md#file-url-limitations) for the few features that don't work without a server

## Verification

After building, open directly in the browser:
```bash
open dist/index.html
# or with location:
open "dist/mauna-kea.html?lat=37.33182&lon=-122.03118"
```

TypeScript type checking runs automatically as the first step of `build.sh` (via `npx tsc --noEmit`). The build will abort on any type error. To run it standalone:
```bash
npx tsc --noEmit
```

Test suite:
```bash
npx vitest
```

## Key Source Files

| File | Purpose |
|------|---------|
| `build.sh` | Main build script |
| `faces.txt` | Root configuration file containing active face slug order |
| `scripts/generate-face-modules.js` | Build-time Node.js script that compiles face TypeScript modules, cards, and manifests |
| `src/face-template.html` | HTML template for individual face pages |
| `src/index.html` | All-faces grid page source |
| `src/inspector/inspector.html` | Inspector app HTML (processed with partial injection) |
| `src/inspector/inspector-entry.ts` | Inspector app entry point (bundled → `inspector-engine.js`) |
| `src/faces/generated/` | Output directory for auto-generated face configuration modules (gitignored) |
| `src/help/*.html` | Per-face help content fragments (injected at build time) |
| `src/help/images/` | Help content images (copied to `dist/help/images/`) |
| `version.txt` | Current build version, read and updated by `build.sh` |
| `tsconfig.json` | TypeScript configuration |
| `package.json` | Dependencies (esbuild) |
| `file-categories.json` | Canonical file categorization registry |
| `scripts/file-manager.sh` | File categorization, archival, and restoration CLI tool |

## File Categories and Archival

Every file in the project directory belongs to exactly one of five categories:

| Cat | Label | Description | Archived? |
|-----|-------|-------------|-----------|
| 1 | **Ephemeral** | Intermediate build output regenerated every build | No |
| 2 | **Rebuildable (offline)** | Can be rebuilt without Internet but rarely changes | Yes (golden) |
| 3 | **Git-tracked** | Committed to the GitHub repository | No (git handles) |
| 4 | **Reference** | iOS/Android reference repos; not build sources | No |
| 5 | **Internet-downloaded** | Must be downloaded from the Internet | Yes (main) |

The canonical registry of categorization rules lives in [`file-categories.json`](../file-categories.json) at the project root. Rules are evaluated in order; first match wins. Files tracked by `git ls-files` that don't match any explicit rule default to category 3.

### `file-manager.sh` CLI Tool

The tool at [`scripts/file-manager.sh`](../scripts/file-manager.sh) provides five subcommands:

```bash
# List all files by category (subtrees collapsed)
bash scripts/file-manager.sh list

# Archive category-5 files (excl. node_modules) to a destination
bash scripts/file-manager.sh archive /path/to/dest

# Restore archived files into a clean checkout
bash scripts/file-manager.sh restore /path/to/source

# Archive test golden files (category 2) separately
bash scripts/file-manager.sh archive-golden /path/to/dest

# Restore test golden files
bash scripts/file-manager.sh restore-golden /path/to/source
```

**Archive rules:**
- Destination must be specified (no default) and must NOT be inside the project tree
- Archives include a `MANIFEST.sha256` for checksum verification
- `restore` refuses to overwrite existing files — stops with a detailed error listing conflicts

### Fresh Checkout Workflow

To set up a complete working directory from a clean `git clone`:

```bash
git clone <repo-url>
cd chronometer-web
npm install                                          # category 5: node_modules
bash scripts/file-manager.sh restore /path/to/archive  # category 5: geonames data
bash scripts/file-manager.sh restore-golden /path/to/golden  # category 2: test snapshots
bash build.sh                                        # generates category 1 files + dist
```

### `dist/` Special Case

`dist/` is committed to git (category 3) even though it contains build output. This is intentional — it allows deploy tooling outside the VM to access built files and lets GitHub repo browsers see the output structure. The `list` command flags it as "git-tracked build output".

## Related Docs

- [Face Porting Guide](face-porting-guide.md) — How to add a new face (includes build steps)
- [Architecture Overview](architecture-overview.md) — Overall app structure
- [Help System](help-system.md) — Help content architecture
- [Development Rules](development-rules.md) — Critical invariants including build hygiene rules
