# Emerald Chronometer — Web Edition

A web port of [Emerald Chronometer](https://github.com/EmeraldSequoia/Chronometer), an astronomical watch-face app originally built for iPhone and iPad in Objective-C, C++, and C. This project re-implements the app entirely in TypeScript, rendering animated watch faces to HTML Canvas. Like the original iOS app, it requires **no backend server** — it runs completely in the browser using only the device's clock and location (while the location is being set a map will be displayed using OpenStreetMap if the internet is available, but it is not required for any functionality).

The original Emerald Chronometer was developed by Steve Pucci and Bill Arnett of [Emerald Sequoia LLC](https://emeraldsequoia.com) and was one of the first 500 apps in the App Store in 2008. The iOS app has **a new owner** and can be found [here](https://www.scapaflowllc.com/new-page-1).

This project (the web version here) is under very active development as of May 2026.

## How to Run

### Option 1: Run from a server that serves the static files needed:
* https://spucci.us/ecweb/
* Add your server here! We're looking for volunteers to host mirror sites to host the static files. All we need is a directory on your server to host the files in dist/ and serve them over https. (See option 3 for details on how to do this).

### Option 2: Download and open locally

1. Download the `dist/` directory from this repository. The easiest way is to download the `dist.zip` archive from the [latest release](https://github.com/emeraldsequoia/chronometer-web/releases), or clone the repo and use the `dist/` directory directly.
2. Unzip (if needed) and double-click **`index.html`** to open it in your browser, or open any of the individual face HTML files (e.g. `mauna-kea.html`). Your location and other settings are saved in the browser's local storage on your device, so you only set them once. (On `file://` pages where local storage is unavailable, the app falls back to keeping settings in the URL — bookmark the page to keep them.)

Almost everything works when opened via `file://` URLs. The exceptions are:

- **No detailed map in the location picker** — OpenStreetMap tiles require an HTTP `Referer` header that `file://` URLs cannot provide. A Blue Marble globe is shown instead.
- **Browser geolocation may not work** — some browsers restrict the Geolocation API to secure contexts (`https://` and `localhost`). You can still search for a city/airport by name or enter coordinates manually.

See [file-url-limitations.md](planning/file-url-limitations.md) for full details.

### Option 3: Run from your own local web server

Serve all files in the `dist/` directory from any static web server. To support browser-based location detection, the files must be served over **`https:`**.

### Building from source

The build requires **Node.js ≥ 22** (pinned in `package.json` `engines` and `.nvmrc`; run `nvm use` to select it) — specifically `npx`, which invokes [esbuild](https://esbuild.github.io/) to bundle TypeScript into browser-ready JavaScript. Older versions (e.g. Node 20.12) fail because a test/build dependency requires `require(ESM)` support, available only in Node ≥ 22 (or ≥ 20.17). **Bash** and **zip** are also needed (both are pre-installed on macOS and most Linux distributions).

```bash
./build.sh
```

This produces the `dist/` directory containing all HTML, JS, and image assets, as well as a `dist.zip` archive.

### URL parameters

Settings normally live in the browser's local storage and the address bar stays
clean. The **Share** button builds a URL that encodes the current view for
sending to another person or device; opening such a link lets you use the
settings just for that visit or save them as your defaults. You can also pass
these parameters by hand to control the observer location:

| Parameter | Description |
|-----------|-------------|
| `lat` | Observer latitude in degrees (negative = south) |
| `lon` | Observer longitude in degrees (negative = west) |
| `city` | Display label for the location (URL-encoded) |
| `bloc` | Set to `1` to always request the browser's location on startup |

If `lat` and `lon` are present, they are used directly. If only `bloc=1` is set, the app asks the browser for its location (which may trigger a permission prompt). If none of these are set, the app opens the location settings panel.

For example:

```
file:///path/to/dist/mauna-kea.html?lat=37.335&lon=-122.009
file:///path/to/dist/index.html?bloc=1
```

## Development

There is no need to run a development server. After building, simply open `dist/index.html` (or the specific watch face HTML file you are working on) directly in your browser. To skip the location prompt, add `?lat=…&lon=…` URL parameters as described above.

Other useful commands:

| Command | Description |
|---------|-------------|
| `npx tsc --noEmit` | Run the TypeScript compiler in check-only mode |
| `npx vitest` | Run the test suite |

### Reference repositories

The iOS/Android source code can be cloned locally for reference during development:

```bash
./scripts/clone-refs.sh
```

This clones the four reference repos (`.chronometer-ref`, `.esastro-ref`, `.eslocation-ref`, `.estime-ref`). They are not required for building or running the web app, but are essential for porting new faces or tracing algorithm implementations. See [docs/ios-reference.md](docs/ios-reference.md) for a guide to navigating these repos.

### Implementation docs

The [`docs/`](docs/) directory contains permanent, subsystem-focused reference documentation covering rendering, animation, astronomy, shadows, expressions, and more. Start with [docs/README.md](docs/README.md) for a table of contents.

## Architecture

The app is structured as a pure client-side renderer:

- **`src/watch/`** — Core rendering engine: parses watch-face XML, evaluates dynamic expressions, composites layers onto Canvas.
- **`src/expr/`** — Expression tokenizer and parser for the arithmetic expressions embedded in watch-face definitions.
- **`src/astronomy/`** — Ported astronomical routines (sun/moon positions, rise/set times, twilight, lunar phase).
- **`src/faces/`** — Per-face entry points that bundle the XML definition and image assets for each watch face.

## Credits

**Emerald Chronometer** (the iOS app)was created by **Steve Pucci** and **Bill Arnett** of [Emerald Sequoia LLC](https://emeraldsequoia.com). This web version was ported to TypeScript from the [web app source](https://github.com/EmeraldSequoia/Chronometer) by [Steve Pucci](https://github.com/slpucci) with AI assistance, mostly from Claude, and much invaluable advice from Bill Arnett.

### Astronomical algorithms

The algorithms employed in Emerald Chronometer are very high-precision series calculations originally developed by astronomers at the Bureau des Longitudes in Paris in the 1980s and 1990s. They are particularly well-suited to run in a browser tab because the data tables they are based on can fit in about 500 kilobytes of memory (this includes data for most planets for the same period), and yet still produce accuracy of less than a degree for the next 100 years. No Internet connection is required for any astronomical calculation.

Specifically, the tables employed are from [*Lunar Tables and Programs from 4000 B.C. to A.D. 8000*](https://www.amazon.com/exec/obidos/ASIN/0943396336), by Michelle Chapront-Touzé & Jean Chapront, copyright 1991, and [*Planetary Programs and Tables from -4000 to +2800*](https://www.amazon.com/exec/obidos/ASIN/0943396085), by Pierre Bretagnon & Jean-Louis Simon, copyright 1986, both published by Willmann-Bell, Inc. (the latter includes the Sun motion tables).

### Location data

City and airport search data is derived from [GeoNames](https://www.geonames.org/) (CC BY 4.0).

### Map tiles

Map tiles in the location picker are provided by [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL).


## License

MIT
