# Help System

The help system has two layers:

1. **General Help Topics** — Four topic pages (Complications, Accuracy, Eclipses, Physics) available from every page via an embedded iframe.
2. **Per-Face Help** — Face-specific help content injected into each page at build time.

Both are accessed through the ℹ info popup. When the user clicks the ℹ button, the popup shows:
- Generic project info (title, GitHub links)
- An expandable "Other Apps" section (cross-links to the other two apps)
- An expandable "General Help Topics" section (iframe)
- Per-face help content (details sections)

## Source Material

### Per-Face Help

The per-face help content was ported from the **Android (Wear OS) help files** stored in `/Users/spucci/aw/`. These are HTML files that were originally part of the Emerald Chronometer for Wear OS product pages.

#### Android Help Directory Structure

The Android help files use iOS-derived directory names, but the face names in the filenames are the same Android face names used in our app:

```
/Users/spucci/aw/
├── haleakala/
│   ├── haleakala_i.html    → Haleakalā face help
│   └── hana_i.html         → Hana face help
├── chandra/
│   ├── chandra_i.html      → Chandra face help
│   └── selene_i.html       → Selene face help
├── mauna_kea/
│   └── mauna_kea_i.html    → Mauna Kea face help
├── geneva/
│   ├── geneva_i.html       → Geneva face help
│   └── basel_i.html        → Basel face help
├── firenze/
│   └── firenze_i.html      → Firenze face help
├── miami/
│   ├── miami_i.html        → Miami face help
│   └── venezia_i.html      → Venezia face help
├── terra/
│   ├── terra_i.html        → Terra face help
│   └── gaia_i.html         → Gaia face help
├── babylon/
│   └── babylon_i.html      → Babylon face help
├── vienna/
│   └── vienna_i.html       → Vienna face help
└── product.css              → Legacy Android help stylesheet (not used)
```

#### Extraction Process

Each Android help file has a standard structure with boilerplate and content markers:

```html
<!-- boilerplate: nav, shutdown notice, banner, buy buttons -->
<!-- Boilerplate code above here -->

    <!-- ACTUAL HELP CONTENT - this is what we extract -->

<!-- Boilerplate code below here -->
<!-- boilerplate: face icon gallery, copyright -->
```

The help content was extracted manually (no automated script) with the following adaptations:

1. **Stripped**: All boilerplate (nav headers, shutdown notice, banner images, buy buttons, footer face gallery, copyright)
2. **Stripped**: Android/Wear OS-specific text — entire sentences or paragraphs referencing ambient mode, gear button, long press instructions
3. **Stripped**: Banner images (large Wear OS device screenshots, 200–450KB each)
4. **Stripped**: Links to `emeraldsequoia.com` product pages — text simplified (e.g., "Both are included in Emerald Chronometer" → "Terra and Gaia are world-time faces")
5. **Rewrote**: Cross-face help links to point to our pages (e.g., `../miami/venezia_i.html` → `venezia.html`)
6. **Rewrote**: Image `src` paths from relative Android paths to `help/images/<dir>/filename.png`
7. **Rewrote**: Android-specific settings instructions to reference our web app UI (e.g., "use the Change cities button below the face" instead of "long press on the center of the face, or tap the gear button")
8. **Kept**: All external educational links (Wikipedia, NIST, Montana solar, Baselworld) with `extlink.png` icons
9. **Kept**: All inline explanatory images (screenshots of watch details)
10. **Inlined**: Terra's `SlotRules.html` as a collapsible `<details>/<summary>` section (default collapsed)

#### Faces with Unported Counterparts

The Android help includes faces not yet in our web app. These are **not** included:

- Alexandria, Atlantis, Milano, Paris, McAlester, Mauna Loa, Padua

Cross-face links pointing to unported faces are rendered as plain text.

### General Help Topics

The general help content in `src/help.html` was ported from four sources:

| Section | Source | Adaptations |
|---------|--------|-------------|
| Complications | iOS XML `<!-- COMPLICATIONS -->` blocks via `.chronometer-ref/scripts/genHelp.pl` logic | Built table for 13 web faces; mapped iOS front/back sides to web face names |
| Astronomical Accuracy | `.chronometer-ref/Help/AstroAccuracy.html` | Removed iPhone-specific language; updated "Geneva" → "Basel" where appropriate |
| Predicting Eclipses | `.chronometer-ref/Help/Geneva/PredictingEclipses.html` | Changed all "Geneva" → "Basel"; replaced crown/pusher language with time controller |
| The Physics | `https://emeraldsequoia.com/h/mmm.html` | Inlined directly; no external dependency |

Eclipse prediction images (8 files) were copied from `.chronometer-ref/Help/Geneva/` to `src/help/images/basel/`.

### Keyboard Shortcuts section

`help.html` also contains a **Keyboard Shortcuts** section (`#hotkeys`) documenting the single-key hotkeys (`c a o i h ? t n l f`). It is app-neutral, so all app flavors (`app=observatory`, `app=inspector`, and the Chronometer default) show it. The runtime registry lives in `src/shared/hotkeys.ts` (one keydown listener, input-focus guard); the cross-app navigation keys are registered by `registerAppNavHotkeys()` in `src/shared/app-nav.ts`, and each entry script registers its page-local keys. **Keep help.html's table, the README table, and the registrations in sync.** The `?` hotkey calls `openGeneralHelpTopic('#hotkeys')` (help-popover.ts), which opens the popup, expands the General Help section, and routes the iframe to `#hotkeys` (help.html opens/scrolls on load and on `hashchange`).

## Architecture

### "Other Apps" popup section

`src/partials/other-apps.html` contains one entry per app (icon + title + lead paragraph), each tagged `data-app="chronometer|observatory|inspector"`. `build.sh` injects it via the `{{OTHER_APPS}}` placeholder into the four popups (index, face template, Observatory, Inspector) above the General Help Topics section. At runtime the current app's own entry is removed — the `app:` option to `initHelpPopover()` (face pages, Observatory, Inspector) or a line in `index-page.ts`. Styles live in `partials/help-subview.css` (`#other-apps-section`, `.other-app*`), which all four pages inject.

The entry links (and the header app icons on every page) carry class `app-nav-link` and are wired by `initAppNavLinks()` in `src/shared/app-nav.ts`: in persistent (localStorage) mode they navigate with a clean URL (state travels via the shared `ec:shared` namespace; only the URL-only `fps` param is carried), while the non-persistent fallbacks copy the full query string. Pending time state is flushed on pointerdown/focus before navigation.

### General Help — Standalone Page with Embed Mode

`src/help.html` is a standalone page with four collapsible `<details>` sections. It can be viewed directly or embedded in an iframe.

**Standalone mode** (`help.html`): Shows full page with navigation bar, title, and section links.

**Embed mode** (`help.html?embed=1`): When loaded with the `embed` query parameter:
- Navigation bar and title are hidden (redundant inside the info popup)
- Padding is reduced
- `postMessage({type: 'help-resize', height: scrollHeight})` is sent to the parent on load and whenever a section is toggled
- The parent listens for these messages and resizes the iframe to match the content height

This auto-resize approach avoids a fixed iframe height, so the General Help Topics section is compact when collapsed and grows naturally as sections expand.

**External link handling**: `<base target="_blank">` ensures all external links (Wikipedia, NASA, Amazon) open in new tabs. Internal anchor links use `target="_self"` to stay in the iframe. Face name links in the complications table use `target="_top"` to break out of the iframe.

**Face name linkification**: A runtime script in help.html scans the complications table and wraps face names (Mauna Kea, Basel, etc.) in links to their corresponding pages using `target="_top"`.

**Eclipse prediction link**: The "Eclipse prediction" row in the complications table links to `#eclipses`, which opens and scrolls to the Predicting Eclipses section.

### Per-Face Help — Build-Time Injection

Help HTML fragments live in `src/help/<face-slug>.html` (one per face). During build, `build.sh` injects each fragment into the page inside a `<template>` element:

```html
<template id="help-template">
    <!-- face-specific help HTML injected here by build.sh -->
</template>
```

The `<template>` element is **inert** — browsers do not render its content or load any images within it.

#### Single-Face Pages

Each single-face page (e.g., `basel.html`) receives its own help file via `inject_partials "$HELP_FILE"`. The `{{HELP_CONTENT}}` placeholder is replaced with the contents of `src/help/basel.html`.

#### Multi-Face Pages (all.html, selected.html)

The build generates a **combined help file** by looping through all faces and wrapping each help fragment in a `<details>` element:

```html
<details class="face-help-section" data-face="mauna-kea">
    <summary>Mauna Kea</summary>
    <!-- contents of src/help/mauna-kea.html -->
</details>
```

The `data-face` attribute stores the URL slug for runtime matching.

At runtime, `engine-entry.ts` post-processes the cloned help content:

1. **External links**: All `<a href="http...">` links get `target="_blank"` added
2. **Thumbnails**: Each per-face `<summary>` gets a 28px circular thumbnail prepended (using the existing `thumb-{face}.png` assets)
3. **Reordering**: Help sections are re-appended in `faceDataArray` order to match the display order
4. **Filtering** (selected.html only): Sections for faces not in the current selection are hidden with `display: none`

Note: `FaceData.name` uses display names (e.g., "Mauna Kea", "Haleakalā") while `data-face` uses URL slugs (e.g., "mauna-kea", "haleakala"). The runtime code converts display names to slugs for comparison using `name.toLowerCase().replace(/[āä]/g, 'a').replace(/\s+/g, '-')`.

### Runtime Lazy Cloning

On first ℹ click, `engine-entry.ts` clones the template content into the live DOM:

```typescript
const helpTemplate = document.getElementById('help-template') as HTMLTemplateElement;
helpContent.appendChild(helpTemplate.content.cloneNode(true));
```

This triggers image loading only when the user actually opens help. It also works correctly with `file://` URLs (unlike `fetch()`, which is blocked by CORS on `file://`).

### Help Images

Referenced images are stored in `src/help/images/`, organized by Android directory name:

```
src/help/images/
├── extlink.png               # External link indicator icon
├── haleakala/                 # Haleakala + Hana images
├── chandra/                   # Chandra + Selene images
├── mauna_kea/                 # Mauna Kea images
├── geneva/                    # Geneva + Basel images
├── basel/                     # Eclipse prediction images (8 files)
├── babylon/                   # Babylon images
├── terra/                     # Terra + Gaia images + SlotRules images
├── miami/                     # Miami images
└── firenze/                   # (empty — Firenze has no inline images)
```

During build, these are copied to `dist/help/images/`.

## File Inventory

| File | Purpose |
|------|---------|
| `src/help.html` | General help page (Complications, Accuracy, Eclipses, Astro Stepping, Physics, Keyboard Shortcuts) |
| `src/help/<face>.html` | Per-face help HTML fragments (13 files, one per face) |
| `src/help/images/` | Inline help images (55+ files across 9 subdirectories) |
| `src/face-template.html` | Contains Other Apps + General Help iframe, `#help-content` div, `<template>`, and help CSS |
| `src/index.html` | Contains Other Apps + General Help iframe (no per-face help) |
| `src/partials/other-apps.html` | "Other Apps" popup section (all three entries; current app removed at runtime) |
| `src/shared/help-popover.ts` | Shared popup wiring, `app:` filtering, `openGeneralHelpTopic()` for the `?` hotkey |
| `src/shared/app-nav.ts` | Cross-app link hrefs (clean in storage mode), `.app-nav-link` wiring, i/o/c/a hotkeys |
| `src/shared/hotkeys.ts` | Single-key hotkey registry (input-focus guard, no-modifier match) |
| `build.sh` | `get_help_file()`, `{{HELP_CONTENT}}`/`{{OTHER_APPS}}` injection, combined help generation |
| `src/engine-entry.ts` | Template cloning, external link targeting, thumbnail injection, reordering, filtering, iframe resize listener |

## Adding Help for a New Face

See [Face Porting Guide — Step 11](face-porting-guide.md#11-help-content).

When adding a new face, also:
- Update the complications table in `src/help.html` if the face has complications
- Add the face name and URL slug to the `faceUrls` map in `src/help.html`'s linkification script
- The combined help for all.html/selected.html will automatically include it (no manual step needed)

## Related Docs

- [Face Porting Guide](face-porting-guide.md) — Step-by-step porting procedure (includes help step)
- [Build System](build-system.md) — How the build injects help content
