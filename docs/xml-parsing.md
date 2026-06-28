# XML Parsing

The XML parser reads watch-face definition files and produces an in-memory `Watch` model containing typed parts, pre-parsed expression attributes, and metadata.

## XML Source Locations

- **Standard location**: `.chronometer-ref/Watches/Builtin-Android/<Face> I/<Face> I.xml`
- **Naming convention**: Face "Foo" → directory `Foo I/` with file `Foo I.xml`
- **Variant II**: Some faces use `Foo II/Foo II.xml`. The "II" name is never used in the web app — the user chooses the display name. If unsure, **stop and ask**.

When copying an XML file for porting, it goes to `src/watch/assets/<face_name>/`.

## Night-Mode Stripping

After copying an XML file, **delete any parts that only apply to "night" mode** (e.g., `modes='night'`, terminators or QWheels specific to night mode). Night mode is not implemented in the web app and these parts will clash with front-mode rendering.

## `bezelColor` Attribute

**Always add a `bezelColor` attribute** to the `<watch>` tag when porting a face. If the XML defines a "case" image (e.g., `<Image name='case' .../>`), delete it or skip using it. Instead, pick a `bezelColor` value matching the typical color of the bezel within that image (e.g., `bezelColor='rgb(160,160,160)'`).

## Part Type Taxonomy

| XML Tag | TypeScript Type | Category | Notes |
|---------|----------------|----------|-------|
| `QDial` | `QDialPart` | Static | Circles, arcs, marks, text around a dial |
| `QHand` / `hand` | `QHandPart` | Dynamic | Hands drawn at computed angles |
| `QWheel` | `WheelPart` | Mostly static | Rotating wheels with text segments |
| `SWheel` | `WheelPart` | Mostly static | Sliding wheels (variant of QWheel) |
| `QWedge` | `QWedgePart` | Dynamic | Filled arc/wedge shapes |
| `QRect` | `QRectPart` | Static | Rectangles (date window backgrounds) |
| `Qtext` | `QTextPart` | Static | Text labels |
| `Image` | `ImagePart` | Static | PNG image assets |
| `window` | `WindowPart` | Static | Clips the following part |
| `static` | Container | Static | Groups non-animated children |
| `terminator` | `TerminatorPart` | Dynamic | Moon phase leaf display |
| `CalendarRowCover` | `CalendarRowCoverPart` | Dynamic | Sliding covers for Babylon calendar |
| `Button` | `ButtonPart` | Dynamic | Interactive buttons (rendering not yet implemented) |

## Feature Flag Attributes

The `<watch>` root element can declare feature flags:

| Attribute | Description |
|-----------|-------------|
| `worldTimeRing` | 24-city ring around dial (Terra-style) |
| `worldTimeSubdials` | Separate subdials for cities (Gaia-style) |
| `planetSelector` | User-switchable planet display (Venezia-style) |
| `maxSeparateLoc` | Number of subdial slots (for `worldTimeSubdials`) |

These are parsed into the `Watch` interface and used to gate feature-specific logic.

## High-Resolution Assets

- Use `4x` or `2x` image assets where available (e.g., `faceFront-4x.png`)
- Apply the appropriate scaling factor in the face setup file: `scale: 1/4` for 4x images
- This ensures bounding boxes and rendering align with standard coordinates

### Parts-Bin vs Per-Face Assets

- **`src/watch/assets/parts-bin/`** — Common images shared across multiple faces. Check here first to avoid duplicating assets.
- **`src/watch/assets/<face_name>/`** — Face-specific images. Assets unique to this face go here.

## Parser Implementation

### `attrExpr()` Helper

The parser uses an `attrExpr(element, name)` helper that returns the raw expression string (compiled on demand later by the expr layer; see [Expressions](expressions.md)):

```typescript
function attrExpr(el: Element, name: string): string | undefined {
    return attr(el, name) || undefined;
}
```

All numeric/expression attributes use `attrExpr` instead of raw `getAttribute`.

### Window Parsing

Windows are accumulated and applied to the next non-window part, mirroring the iOS behavior where `parserDidWindowStart` stashes each window in a `winBin` array.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/watch/xml-parser.ts` | XML parsing → `Watch` model |
| `src/watch/types.ts` | All part type interfaces |
| `src/watch/assets/` | XML definitions and image assets per face |

## Related Docs

- [Expressions](expressions.md) — How `attrExpr` connects to the expression parser
- [Rendering](rendering.md) — How parsed parts are drawn
- [Face Porting Guide](face-porting-guide.md) — Step-by-step procedure using these conventions
