# XML Syntax Reference

Complete reference for Chronometer watch face XML definitions. For porting procedures see [Face Porting Guide](face-porting-guide.md); for expression syntax see [Expressions](expressions.md).

## Coordinate System

All positions and sizes are in **XML coordinate units**. The origin `(0, 0)` is at the center of the watch face. **Y is upward** in XML (the renderer negates Y for Canvas).

The `faceWidth` attribute on `<watch>` defines the diameter; coordinates typically range from `-faceWidth/2` to `+faceWidth/2`.

## Attribute Value Types

| Notation | Meaning | Examples |
|----------|---------|---------|
| *expr* | C-style expression, parsed to AST at load time | `'mainR-3'`, `'hour12ValueAngle()'`, `'0xff000010'` |
| *string* | Literal string, not parsed | `'Arial'`, `'front'` |
| *color-expr* | Expression that evaluates to a color | `'black'`, `'0xAARRGGBB'`, `'clear'`, variable name |
| *enum* | One of a fixed set of values | `'rect'`, `'tri'`, `'twelve'` |

Colors can be: named (`black`, `white`, `clear`, `red`, etc.), hex `0xAARRGGBB` or `#RRGGBB`, `rgb(r,g,b)`, `rgba(r,g,b,a)`, or a variable name set in `<init>`.

---

## Common Part Attributes

Most watch parts (such as dials, hands, wheels, text, images, windows, etc.) support a set of common attributes:

| Attribute | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique identifier for the part. |
| `refName` | string | Alternative identifier; parsed as `name` if `name` is omitted. |
| `x`, `y` | expr | Position offset in XML units (origin `0,0` is at the center of the watch face). Note that Y is upward. Defaults to 0. |
| `modes` | string | Mode filter indicating when the part is visible (e.g., `'front'`, `'back'`, `'front\|back'`, or `'all'`). Defaults to `'front'` if omitted. |

---

## `<watch>` — Root Element


```xml
<watch name='Haleakala I' beatsPerSecond='1' faceWidth='266' bezelColor='rgb(218,201,162)'>
```

| Attribute | Type | Description |
|-----------|------|-------------|
| `name` | string | Internal name of the watch face |
| `displayName` | string | **[Build-Time Required]** User-facing display name of the watch face (e.g. `Haleakalā`), used in selectors and index lists |
| `description` | string | **[Build-Time Required]** Short user-facing description of the watch face's features and layout |
| `faceWidth` | number | Diameter of the face in XML units. Determines the coordinate scale |
| `beatsPerSecond` | string | Tick frequency for the second hand (1 = once/sec, 4 = quartz sweep) |
| `bezelColor` | color | CSS color for the surrounding bezel ring. Empty = no bezel |
| `bezelNoonMark` | `'true'` | If present, draws a fine noon-indicator line at bezel top |
| `worldTimeRing` | `'1'` | Enables supporting controller/environment logic for a Terra-style 24-city ring. Does not render the ring itself |
| `worldTimeSubdials` | `'1'` | Enables supporting controller/environment logic for Gaia-style separate subdials. Does not render the subdials |
| `planetSelector` | `'1'` | Enables/shows the Venezia-style user-switchable planet selector UI. Does not render the dials/planets |
| `wadokei` | `'1'` | Enables Kyoto-style temporal hour toggles and environment rate calculations. Does not render the Wadokei face components |
| `numEnvironments` | number | Number of environment slots (for multi-city faces) |
| `maxSeparateLoc` | number | Max distinct location slots |
| `calendarWeekStart` | `'1'` | Babylon-style calendar grid |
| `urlAbbrev` | string | Two-letter URL abbreviation for compact parameter encoding |

> [!IMPORTANT]
> **Feature Flag Attributes** (such as `worldTimeRing`, `worldTimeSubdials`, `planetSelector`, and `wadokei`) do not procedurally generate or render the visual elements themselves. They act as declarative flags that instruct the Chronometer engine to initialize required background states, show corresponding UI controls (such as the planet/wadokei mode toggle panels), and enable specific environment variables or calculations. The actual rendering of dials, hands, text, or maps for these features must still be defined by appropriate elements (like `<QDial>`, `<QHand>`, and `<Image>`) within the rest of the XML document.

---

## `<init>` — Variable Initialization

```xml
<init expr='mainR=118, altR=79, riseX=-40, setX=-riseX' />
```

| Attribute | Type | Description |
|-----------|------|-------------|
| `expr` | expr | Comma-separated assignments. Variables become available to all subsequent expressions |

Init blocks run in document order. Later blocks can reference variables from earlier blocks. All init blocks run regardless of mode.

---

## `<static>` — Container for Cached Parts

```xml
<static name='front' x='0' y='0' modes='front'>
    <Image name='face' src='face.png' />
    <QDial name='main dial' ... />
</static>
```

Groups parts that are pre-rendered once to an OffscreenCanvas and blitted per-frame. Window cutouts are applied to the entire block. Supports common attributes including `x`, `y` offsets.

| Attribute | Type | Description |
|-----------|------|-------------|
| `name` | string | Identifier |
| `x`, `y` | expr | Center offset in XML units |
| `modes` | enum | Mode filter (see [Modes](#modes)) |

Children can be any part type. Nesting `<static>` blocks is not supported.

---

## `<QDial>` — Circular Dial

Draws circular dials: filled backgrounds, tick marks, and text labels arranged around a circle.

```xml
<QDial name='main dial' x='0' y='0' radius='mainR' bgColor='0xfffffff4'
       strokeColor='black' marks='outer' nMarks='60' markWidth='.5' mSize='5' />
```

### Position & Size

| Attribute | Type | Description |
|-----------|------|-------------|
| `x`, `y` | expr | Center position in XML coords |
| `radius` | expr | Outer radius of the dial |
| `radius2` | expr | If set, tick marks span from `radius2` (inner) to `radius` (outer) |
| `clipRadius` | expr | If negative, clips to exclude the inner circle (for guilloche patterns) |

### Appearance

| Attribute | Type | Description |
|-----------|------|-------------|
| `bgColor` | color-expr | Fill color of the circular area. `clear` = transparent |
| `strokeColor` | color-expr | Color for tick marks and border |
| `fillColor1` | color-expr | Alternating fill color for certain mark types |
| `fillColor2` | color-expr | Second alternating fill color |

### Tick Marks

| Attribute | Type | Description |
|-----------|------|-------------|
| `marks` | enum | Mark style (see below). Can be `\|`-combined |
| `nMarks` | expr | Number of marks around the circle |
| `markWidth` | expr | Width of each mark in XML units |
| `mSize` | expr | Length (size) of each mark |

**Mark types**: `outer` (ticks from edge inward), `center` (ticks centered on radius), `tickOut` (ticks from inner outward), `dot` (circular dots), `arc` (short arc segments), `line` (radial lines), `rose` (compass rose pattern), `none` / `0` (no marks).

Combinable: `'outer|tickOut'`, `'tickOut|no5s'` (skip every 5th mark).

### Text Labels

| Attribute | Type | Description |
|-----------|------|-------------|
| `text` | string | Comma-separated labels placed evenly around the dial |
| `fontSize` | expr | Font size in XML units |
| `fontName` | string | Font family name |
| `orientation` | enum | How text is oriented (see [Orientations](#text-orientations)) |
| `demiTweak` | expr | Fine-tuning offset for `demi` orientation text |

### Angular Range

| Attribute | Type | Description |
|-----------|------|-------------|
| `angle` | expr | Rotation of the entire dial |
| `angle0` | expr | Start angle for partial arcs |
| `angle1` | expr | End angle for partial arcs |
| `angle2` | expr | Additional angular parameter |

### Animation

| Attribute | Type | Description |
|-----------|------|-------------|
| `update` | expr | Update interval in seconds, or a sentinel function name |
| `updateOffset` | expr | Offset from update boundary |
| `kind` | string | Animation kind (see [Kinds](#animation-kinds)) |
| `animSpeed` | expr | Animation speed multiplier. When set, the QDial participates in the `HandState` animation system, enabling smooth interpolation of its `angle` attribute (e.g. `angle='dialFlip' animSpeed='1'` for Vienna's noon/midnight toggle) |

### Shadows

| Attribute | Type | Description |
|-----------|------|-------------|
| `z` | expr | Height above dial surface. If > 0, casts a shadow |
| `thick` | expr | Visual thickness for shadow tuning (default 3) |

---

## `<QHand>` / `<hand>` — Watch Hand

The primary dynamic element. `<QHand>` draws geometric shapes; `<hand>` is typically image-based (with `src`). Both parse to `QHandPart`.

```xml
<QHand name='hour' x='0' y='0' z='4' thick='4.0'
       type='rect' length='55' width='4' tail='12'
       angle='hour12ValueAngle()' update='60'
       strokeColor='black' fillColor='0xffe8e0d0' />
```

### Position & Angle

| Attribute | Type | Description |
|-----------|------|-------------|
| `x`, `y` | expr | Pivot (rotation center) position |
| `angle` | expr | Rotation angle in radians. Typically a time function like `hour12ValueAngle()` |

### Geometry

| Attribute | Type | Description |
|-----------|------|-------------|
| `length` | expr | Distance from pivot to tip |
| `length2` | expr | Secondary length — for `tri`: widest point; for `wire`: start point |
| `width` | expr | Width at widest point |
| `tail` | expr | Distance from pivot extending in the opposite direction of the tip |
| `type` | enum | Shape type (see below) |
| `lineWidth` | expr | Stroke width (default 0.5) |

**Hand types**:

| Type | Description |
|------|-------------|
| `tri` | Default. Diamond/triangle: tapers from `width` at base to a point at tip |
| `rect` | Rectangle from tail to tip |
| `wire` | Single-pixel line (stroke only, no fill) |
| `quad` | Bezier curves forming a bulging body with triangular tip |
| `breguet` | Breguet pomme: hub circle, narrow arm, crescent ring, pointed tip |
| `sun` | Sun symbol: circular body with triangular rays |
| `spoke` | Text label at polar offset (e.g., AM/PM indicator) — not a geometric hand |

### Colors

| Attribute | Type | Description |
|-----------|------|-------------|
| `strokeColor` | color-expr | Outline color |
| `fillColor` | color-expr | Interior fill color. `clear` = transparent |

### Ornament (Arrow/Diamond overlay)

For `tri` and `rect` hands, an ornament (arrowhead/diamond) can be overlaid at the tip:

| Attribute | Type | Description |
|-----------|------|-------------|
| `oLength` | expr | Ornament length beyond the hand tip. If > 0, ornament is drawn |
| `oWidth` | expr | Width of the ornament diamond |
| `oTail` | expr | How far back from the tip the ornament body starts |
| `oLineWidth` | expr | Stroke width for ornament |
| `oStrokeColor` | color-expr | Ornament outline color |
| `oFillColor` | color-expr | Ornament fill color |

### Center Dot & Tail Circle

| Attribute | Type | Description |
|-----------|------|-------------|
| `oCenter` | expr | Radius of a filled dot at the pivot point |
| `oRadius` | expr | Radius of a circle drawn at the tail end |
| `tStrokeColor` | color-expr | Tail circle stroke color |
| `tFillColor` | color-expr | Tail circle fill color |
| `tLineWidth` | expr | Tail circle stroke width |

### Image-Based Hands (`<hand>`)

| Attribute | Type | Description |
|-----------|------|-------------|
| `src` | string | Image filename (e.g., `'MoonImage.png'`) |
| `xAnchor` | expr | X offset of rotation pivot within the image |
| `yAnchor` | expr | Y offset of rotation pivot (from bottom, iOS convention) |
| `offsetRadius` | expr | Polar orbit radius (places hand at a distance from center) |
| `offsetAngle` | expr | Polar orbit angle |
| `alpha` | expr | Opacity (0–1). Default 1 |

### Spoke Type (Text Labels)

| Attribute | Type | Description |
|-----------|------|-------------|
| `text` | string | Text to display (e.g., `'AM'`) |
| `fontSize` | expr | Font size |
| `fontName` | string | Font family |
| `offsetRadius` | expr | Distance from pivot to text position |
| `offsetAngle` | expr | Angular position of text |
| `orientation` | string | Text orientation; `'radial'` to orient text radially (bottom towards center), otherwise stays upright |

### Sun Type

| Attribute | Type | Description |
|-----------|------|-------------|
| `nRays` | expr | Number of sun rays (default 8) |

### Animation & Shadows

| Attribute | Type | Description |
|-----------|------|-------------|
| `update` | expr | Update interval in seconds, or a sentinel function name |
| `updateOffset` | expr | Offset from update boundary |
| `kind` | string | Animation kind — determines the time function mapping |
| `animSpeed` | expr | Animation interpolation speed (higher = faster snap) |
| `dragAnimationType` | enum | `dragAnimationAlways` \| `dragAnimationNever` \| `dragAnimationHack1` \| `dragAnimationHack2` |
| `z` | expr | Height for shadow casting. 0 = no shadow |
| `thick` | expr | Shadow tuning parameter (default 3) |

### Linear Motion (Calendar Wires)

| Attribute | Type | Description |
|-----------|------|-------------|
| `xMotion` | expr | Horizontal translation (for sliding parts like Babylon day wires) |
| `yMotion` | expr | Vertical translation |

### Special Custom Hand Features (Terra & Gaia World Clock)

Hands can define custom drawing behaviors for world-clock subdials and maps:

| Attribute | Type | Description |
|-----------|------|-------------|
| `special` | string | Special drawing mode. Value can be `'specialWorldtime'` (Terra world-time ring with city knockouts and channel lines) or `'specialSubdial'` (Gaia world clock subdials). |
| `specialParam` | expr | Parameter for special modes (e.g., Gaia subdial ID 0–3: 0=Local, 1=N, 2=E, 3=S). |
| `envSlot` | expr | Environment slot containing the location/timezone data (e.g. `'subdial0Slot'`). |

---

## `<SWheel>` / `<QWheel>` / `<TWheel>` — Rotating Text Wheel

Displays text labels arranged around a circle, rotated to show the current value through a window.

```xml
<SWheel name='months' x='-50' y='-50' radius='65' orientation='three'
        update='1 * days()' angle='monthNumber() * 2*pi/12'
        fontSize='15' fontName='Arial' text='JAN,FEB,MAR,...,DEC' />
```

**Variants**: `SWheel` (sliding/standard), `QWheel` (quad-style with separate text radius), `TWheel` (two-tone with `halfAndHalf` split).

### Position & Size

| Attribute | Type | Description |
|-----------|------|-------------|
| `x`, `y` | expr | Center position |
| `radius` | expr | Radius of the wheel circle |
| `tradius` | expr | Separate text radius (QWheel only — positions text independently of background) |

### Text & Appearance

| Attribute | Type | Description |
|-----------|------|-------------|
| `text` | string | Comma-separated labels distributed evenly around the wheel |
| `fontSize` | expr | Font size |
| `fontName` | string | Font family |
| `orientation` | enum | Text orientation: `three`, `six`, `nine`, `twelve` (clock positions where text reads normally) |
| `strokeColor` | color-expr | Text color |
| `bgColor` | color-expr | Background color of each text segment |
| `bgColor2` | color-expr | Second background color (TWheel `halfAndHalf` mode) |
| `halfAndHalf` | expr | If set, wheel is split into two halves with `bgColor` / `bgColor2` |

### Marks & Ticks

| Attribute | Type | Description |
|-----------|------|-------------|
| `marks` | string | Mark style around wheel edge. `'0'` = no marks |
| `ticks` | expr | Number of tick marks |
| `tickWidth` | expr | Width of tick marks |
| `tick` | string | Named tick style (e.g., `'tick288'`) |

### Animation

| Attribute | Type | Description |
|-----------|------|-------------|
| `angle` | expr | Current rotation angle |
| `angle1`, `angle2` | expr | Secondary angles (for calendar wheel quadrant modes) |
| `update` | expr | Update interval |
| `updateOffset` | expr | Offset from update boundary |
| `animSpeed` | expr | Interpolation speed |
| `dragAnimationType` | enum | Animation behavior |
| `kind` | string | Animation kind |

### Calendar Wheel Mode

| Attribute | Type | Description |
|-----------|------|-------------|
| `calendar` | enum | `calendarWheel012B` (rows 0–2 + bottom), `calendarWheel3456` (rows 3–6), `calendarWheelOct1582` (special October 1582 layout) |
| `calendarStartDay` | string | Weekday index for grid start (0=Sunday) |
| `calendarWeekendColor` | color-expr | Color for Saturday/Sunday day numbers |

### Shadows

| Attribute | Type | Description |
|-----------|------|-------------|
| `z` | expr | Height above surface (for shadow casting) |

---

## `<QText>` — Static Text Label

```xml
<QText name='N label' x='0' y='130' fontSize='12' fontName='Times New Roman'
       text='N' strokeColor='black' />
```

| Attribute | Type | Description |
|-----------|------|-------------|
| `x`, `y` | expr | Position |
| `text` | string | Text content |
| `fontSize` | expr | Font size |
| `fontName` | string | Font family |
| `strokeColor` | color-expr | Text color |
| `radius` | expr | If set, text is drawn along a circular arc at this radius |
| `startAngle` | expr | Center angle for curved text (radians) |
| `orientation` | enum | `demi` = text along arc with tops inward |

---

## `<Image>` — PNG Image

```xml
<Image name='face' x='0' y='0' src='Haleakala-face.png' alpha='1' />
```

| Attribute | Type | Description |
|-----------|------|-------------|
| `x`, `y` | expr | Center position |
| `src` | string | Image filename (resolved from the face's asset directory or parts-bin) |
| `alpha` | expr | Opacity (0–1). Default 1 |
| `scale` | expr | Render scale multiplier (e.g., `0.25` for 4x assets) |
| `special` | string | Special drawing mode, e.g., `'specialDotsMap'` to draw Terra city dots |
| `specialParam` | expr | Parameter for special modes |
| `envSlot` | expr | Environment slot containing the location/timezone data |

---

## `<QRect>` — Colored Rectangle

```xml
<QRect name='day back' x='-12' y='-58' w='24' h='16' bgColor='0xfffffff0' />
```

| Attribute | Type | Description |
|-----------|------|-------------|
| `x`, `y` | expr | Top-left corner position (in XML Y-up coords) |
| `w`, `h` | expr | Width and height |
| `bgColor` | color-expr | Fill color |
| `panes` | expr | If set, draws multiple equal vertical panes side by side |

---

## `<window>` — Clipping Region

Windows cut transparent holes through the **next** part (or `<static>` block) in document order. Multiple consecutive windows accumulate.

```xml
<window name='month win' x='-50' y='-58' w='42' h='16'
        border='2' strokeColor='0x7f202020'
        shadowOpacity='0.4' shadowSigma='1.5' shadowOffset='0' />
<static name='front' modes='front'>
    <!-- This static block gets holes cut by the window above -->
</static>
```

| Attribute | Type | Description |
|-----------|------|-------------|
| `x`, `y` | expr | Position |
| `w`, `h` | expr | Width and height (for rectangular windows) |
| `type` | enum | `porthole` (circular) or omitted (rectangular, default) |
| `border` | expr | Border stroke width |
| `strokeColor` | color-expr | Border color |
| `shadowOpacity` | expr | Inner shadow max darkness (0–1) |
| `shadowSigma` | expr | Inner shadow blur radius |
| `shadowOffset` | expr | Vertical shadow offset (positive = light from above) |
| `shadowOffsetX` | expr | Horizontal shadow offset |

---

## `<QWedge>` — Annular Sector

A filled arc segment of a ring (pie-slice shape). Used for DST indicators, planet rise/set arcs, etc.

```xml
<QWedge name='DST wedge' x='0' y='0' outerRadius='120' innerRadius='115'
        angle='dstAngle()' angleSpan='pi/12'
        fillColor='0x80ff0000' strokeColor='clear' />
```

| Attribute | Type | Description |
|-----------|------|-------------|
| `x`, `y` | expr | Center position |
| `outerRadius` | expr | Outer radius of the ring |
| `innerRadius` | expr | Inner radius of the ring |
| `angle` | expr | Center angle of the wedge |
| `angleSpan` | expr | Angular width of the wedge |
| `strokeColor` | color-expr | Outline color |
| `fillColor` | color-expr | Fill color |
| `opaque` | number | If set, wedge uses `copy` composite operation (punches through) |
| `offsetRadius` | expr | Polar orbit radius |
| `offsetAngle` | expr | Polar orbit angle |
| `update` | expr | Update interval |
| `animSpeed` | expr | Animation speed |
| `dragAnimationType` | enum | Animation behavior |

---

## `<QDayNightRing>` — Day/Night Ring

Colored wedges showing daylight hours on a 24-hour dial. Computes sunrise/sunset astronomically.

```xml
<QDayNightRing name='day/night' x='0' y='0'
               outerRadius='mainR-1' innerRadius='mainR-10'
               numWedges='48' planetNumber='0' fillColor='0x40ffff00'
               strokeColor='0x400000ff' update='3600' />
```

| Attribute | Type | Description |
|-----------|------|-------------|
| `x`, `y` | expr | Center position |
| `outerRadius` | expr | Outer radius |
| `innerRadius` | expr | Inner radius |
| `numWedges` | expr | Number of wedges around the ring (higher = smoother boundary) |
| `planetNumber` | expr | Which body to compute rise/set for (0 = Sun) |
| `masterOffset` | expr | Angular offset for the ring |
| `strokeColor` | color-expr | Night wedge color |
| `fillColor` | color-expr | Day wedge color |
| `update` | expr | Recomputation interval |
| `timeBase` | string | `'LST'` for Local Sidereal Time; omitted for local time |
| `envSlot` | expr | Environment slot number (routes astronomy to that slot's location) |
| `sunsetAngle` | expr | Optional override: raw sunset angle expression (used for Kyoto) |
| `sunriseAngle` | expr | Optional override: raw sunrise angle expression (used for Kyoto) |
| `slideDistance` | expr | Wadokei slide: distance (px) to translate hidden wedges inward (used for Kyoto) |
| `slideAnimSpeed` | expr | Wadokei slide: animation speed multiplier (used for Kyoto) |

Each wedge is its own **ObsValue** on the face `Updater` (built by `buildHandValues` → `buildDayNightRing` in `hand-values.ts`): a `wedgeAngle.<i>` per wedge, plus a `wedgeSlide.<i>` for wadokei slide mode, plus the ring's `masterOffset`. The renderer reads `part._obsWedgeAngles[i].currentValue` (and adds `masterOffset` at draw time). There is no per-frame angle cache — each wedge's expression is independently computable from astro-cached scalars (`dayNightLeafAngle` / the `dayNightWedgeSlide*` env functions), and re-evaluation is governed by the ObsValue's `update` interval and re-armed by `face.updater.reset()` on environment changes.

---

## `<terminator>` — Moon Phase Display

Leaf-shaped elements that compose a moon phase disc.

```xml
<terminator name='moon phase' x='0' y='54' radius='10'
            leavesPerQuadrant='6' phaseAngle='moonAgeAngle()'
            rotation='moonRelativePositionAngle()'
            leafFillColor='0xffffd700' leafBorderColor='0x40000000' />
```

| Attribute | Type | Description |
|-----------|------|-------------|
| `x`, `y` | expr | Center position |
| `radius` | expr | Disc radius |
| `leavesPerQuadrant` | expr | Number of leaf shapes per quadrant (higher = smoother edge) |
| `incremental` | expr | If set, partial leaf rendering |
| `leafFillColor` | color-expr | Illuminated face color |
| `leafBorderColor` | color-expr | Leaf edge color |
| `leafAnchorRadius` | expr | Anchor point for leaf curves |
| `phaseAngle` | expr | Moon phase angle (typically `moonAgeAngle()`) |
| `rotation` | expr | Disc rotation (typically `moonRelativePositionAngle()`) |
| `update` | expr | Update interval |
| `updateOffset` | expr | Update offset |

---

## `<analemma>` — Sun Analemma Display (Vienna)

Displays the Sun's [analemma](https://en.wikipedia.org/wiki/Analemma) — the figure-eight path traced by the Sun's sky position when observed at the same time each day over a year. The path is pre-computed at init time for a reference location (45°N, 0°E, noon UT), then rotated at runtime to match the observer's actual sky orientation.

A Sun marker glyph shows today's position along the path. Colored tick marks at the equinoxes and solstices are drawn outside the channel. The entire display is rendered within a circular disc clipped from the face image.

**Not from the iOS app.** This element was created for the web port; it has no iOS/Android counterpart.

```xml
<analemma name='analemma'
          x='0' y='-48' modes='front'
          radius='40' sunRadius='3.75'
          sunFillColor='0xfff2e407' sunStrokeColor='0xff8b814b'
          channelColor='0xff000000' channelWidth='0.8'
          bgSrc='face.png' bgRotates='0' update='300' />
```

| Attribute | Type | Description |
|-----------|------|-------------|
| `x`, `y` | expr | Disc center position |
| `modes` | string | Rendering mode (`front`, `back`) |
| `radius` | expr | Disc radius in XML units |
| `sunRadius` | expr | Sun glyph radius (default 2.5) |
| `sunFillColor` | color-expr | Sun glyph fill color |
| `sunStrokeColor` | color-expr | Sun glyph stroke color (unused when stroke removed) |
| `channelColor` | color-expr | Analemma channel (path) stroke color |
| `channelWidth` | expr | Channel stroke width |
| `bgSrc` | string | Source image for the circular background clip |
| `bgRotates` | expr | If 1, the background rotates with the analemma; if 0, stays fixed |
| `update` | expr | Recompute interval in seconds (default 300 = 5 min) |

### Azimuth Foreshortening

The raw path from `computeAnalemmaPath()` produces delta-azimuth and delta-altitude values in radians. On the sky, a degree of azimuth subtends **less** angular distance than a degree of altitude — by a factor of `cos(altitude)`. Without correction, the analemma appears too wide ("fat").

Each point's `deltaAz` is multiplied by `cos(refAlt + deltaAlt)`, applying the correct foreshortening at that point's actual altitude. This varies from `cos(~22°) ≈ 0.93` at winter solstice to `cos(~68°) ≈ 0.37` at summer solstice, producing the physically accurate narrow figure-eight shape that matches photographs. The same correction is applied to the runtime Sun position.

### Rendering Architecture

- **State**: `AnalemmaState` (in `analemma.ts`) holds the 365-point path (with azimuth foreshortening applied), pre-computed bounding-box centering offset, and three pre-rendered `OffscreenCanvas` bitmaps: background disc (with border baked in), channel path + season ticks + dark overlay, and Sun glyph with drop shadow.
- **Drive**: the Sun's parametric position along the figure-eight (`pathParam`, a cyclic value with period `PATH_SAMPLE_COUNT`) and the disc `rotation` are two **ObsValues** on the face `Updater` (built by `buildAnalemmaValues` in `hand-values.ts`, expressions `analemmaPathParameter()` / `analemmaRotation()`); `drawAnalemma()` reads `state._obsPathParam`/`state._obsRotation` and maps the path parameter to (x, y).
- **Draw**: `drawAnalemma()` is pure blitting — three `drawImage()` calls plus one `arc()` clip: background bitmap → clip to disc → rotated channel bitmap → rotated Sun bitmap. No canvas drawing primitives (path strokes, fills, etc.) are executed per-frame.
- **Sun glyph**: Rays and central disc are drawn as a single combined path to ensure uniform fill color. Pre-rendered with drop shadow onto an `OffscreenCanvas` at init.

---

## `<eotDial>` — Equation of Time Subdial (Vienna)

A procedurally rendered subdial showing the [Equation of Time](https://en.wikipedia.org/wiki/Equation_of_time) scale from −15 to +15 minutes. Drawn as a 210° arc with major/minor tick marks, numeric labels, "−"/"+" symbols, a title label, and a center axle dot.

**Not from the iOS app.** Replaces a bitmap (`EOT.png`) used in the original app with a fully procedural renderer.

```xml
<eotDial name='eot dial' x='0' y='ly+6' modes='front' radius='43'
         strokeColor='fgColor' fontSize='5' />
```

| Attribute | Type | Description |
|-----------|------|-------------|
| `x`, `y` | expr | Dial center position |
| `modes` | string | Rendering mode |
| `radius` | expr | Dial arc radius (also sets the EOT hand length) |
| `strokeColor` | color-expr | Color for ticks, labels, and arc |
| `fontSize` | expr | Base font size for tick labels and +/− symbols |
| `titleFontSize` | expr | Font size for the title label (default: `fontSize × 3`) |
| `arcSpan` | expr | Total arc span in radians (default: `7*pi/6` ≈ 210°) |
| `labelText` | string | Title label text (default: `'Equation of Time'`) |
| `titleYOffset` | expr | Y offset for the title label in XML units (positive is upward) |

### Rendering Details

Rendered into the static cache via `drawEotDial()` in `renderer.ts`. The arc spans 210° (±105° from 12 o'clock), with:
- **Major ticks** at every 5 minutes, **minor ticks** at every minute
- **Numeric labels** at 5, 10, 15 on both sides (scaled to `1.92 × fontSize`)
- **"0"** label at 12 o'clock
- **"−" / "+"** symbols aligned with the ±15-minute marks
- **"Equation of Time"** title below the arc (Arial Narrow font)
- A small black **axle dot** at the center

Paired with a standard `<QHand>` using `angle='24 * EOTAngle()'` for the indicator needle.

---

## Vienna Noon/Midnight Toggle

Vienna is a 24-hour watch face that supports switching between **midnight on top** (default) and **noon on top** dial orientations. This is controlled by the `noonOnTop` init variable.

### XML init variables

```xml
<init expr='noonOnTop=0' />
<init expr='dialFlip = noonOnTop ? pi : 0' />
```

- `noonOnTop=0` (default): midnight at 12 o'clock, dial text `'24,1,...,23'`, `dialFlip=0`
- `noonOnTop=1`: noon at 12 o'clock, dial text `'12,13,...,11'`, `dialFlip=pi`

`dialFlip` is used in the hour hand (`+dialFlip`), UT hand (`+dialFlip`), and day/night ring (`masterOffset='dialFlip'`) angle expressions to rotate all 24-hour elements by 180°.

### 24-hour number dial

The 24-hour number dial (`QDial '24 nums'`) is placed **outside** the `<static>` block so the renderer can animate it per-frame. It uses:
- `orientation='radial'` — all labels have their tops pointing outward, keeping them readable in both dial orientations
- `angle='dialFlip'` — rotation is driven by the `dialFlip` env variable
- `animSpeed='1'` — enables smooth animation via the standard `HandState` system (same as QHands and Wheels)

Because `radial` positions text tops at `radius × 0.92`, the radius is set to `(hrDialR+0.5)/0.92-0.5` to match the visual position of the original `demi` layout.

No text swapping is needed: when `dialFlip=π`, the 180° rotation moves "12" from the bottom (where it's unreadable in radial) to the top (where it's readable).

### Persistence

The `vnoon` setting (persisted via `app-state`, in the `chronometer` namespace) overrides `noonOnTop` after init block evaluation in `watch-env.ts` (read via `getState()`), following the same pattern as `body` for Venezia. Unset = midnight on top.

### UI

A pill toggle ("Midnight ↑ | Noon ↑") in `#vienna-noon-toggle` is shown below the face in single-face mode. On toggle, the engine:
1. Updates `noonOnTop` and `dialFlip` in `env.variables`
2. Rebuilds the static cache and resets hand/dial schedules
3. The 24-hour number dial animates automatically via its `HandState` (driven by `angle='dialFlip'`)
4. Writes `vnoon=1` to the URL (or removes it)

---

## Kyoto Wadokei Toggles

Kyoto is a Japanese temporal hour face that supports two independent toggles controlled by the `wadokei='1'` feature flag on `<watch>`.

### Feature flag

The engine detects wadokei faces via `face.watch.wadokei` (parsed from the XML attribute), **not** by face name. This means any face declaring `wadokei='1'` automatically gets the toggle UI and state management — no engine changes needed.

### Hand mode toggle (Moving hand / Fixed hand)

| Variable | Values | Effect |
|----------|--------|--------|
| `env.kyHandMode` | `0` (default) | Hand moves, dial is stationary |
| | `1` | Hand locks at 12 o'clock, entire dial rotates |

The environment function `kyotoHandMode()` returns the current value.  The companion function `kyotoMasterRotation()` returns the hand's angle when `kyHandMode=1` (and 0 when `kyHandMode=0`).  All dial elements (kanji, ticks, 24-hour labels) include `- kyotoMasterRotation()` in their `angle` or `offsetAngle` expressions so they counter-rotate in fixed-hand mode.

The face background image (`face.png`) is a `<hand>` element (not in `<static>`) with `angle='0 - kyotoMasterRotation()'` so it rotates with the dial in fixed mode and stays still in moving mode.

### Rate mode toggle (Variable hand rate / Constant hand rate)

| Variable | Values | Effect |
|----------|--------|--------|
| `kyMode` | `0` (default) | Variable hand rate — hand speeds up/slows down for unequal hours |
| | `1` | Constant hand rate — dial markings shift position, hand moves steadily |

`kyMode` is set in the XML via `<init expr='kyMode=0' />` and overridden at runtime.

### Persistence

- `kyhand=1` → fixed hand mode (unset → moving hand)
- `kmode=1` → constant hand rate (unset → variable hand rate)

These persist via `app-state` (chronometer namespace) and are applied after init block evaluation in `watch-env.ts` / `restoreKyotoState()` (same pattern as `body` and `vnoon`).

### State restoration across environment rebuilds

Because `createWatchEnvironment()` produces a fresh `Environment` with default values, the function `restoreKyotoState(face)` in `engine-entry.ts` re-reads `kyhand` and `kmode` from the URL and injects them into the new environment. This is called at **every** `createWatchEnvironment()` call site (6 locations) — time stepping, location changes, timezone changes, etc.

### Animation on mode change

When the user toggles either mode, the engine calls `finishAnimations()` on all Kyoto hand states before applying the new values and resetting schedules. This snaps in-flight animations to their current targets so the animation system doesn't interpolate through the wrong direction when `kyotoMasterRotation()` jumps.

### UI

Two pill toggles in `#kyoto-hand-toggle` and `#kyoto-mode-toggle` are shown below the face in single-face mode. The toggle labels update dynamically: in fixed-hand mode, the rate toggle reads "Variable dial rate" / "Constant dial rate" instead of "Variable hand rate" / "Constant hand rate".

---

## `<CalendarRowCover>` — Calendar Grid Covers (Babylon)

Sliding covers that reveal/hide partial-week rows in the Babylon calendar grid.

```xml
<CalendarRowCover name='row6 cover' coverType='row6Left'
                  bgColor='calBg' fontColor='black' fontSize='10' fontName='Arial'
                  calendarRadius='calR' z='calRowCoverZ' animSpeed='2' />
```

| Attribute | Type | Description |
|-----------|------|-------------|
| `coverType` | enum | `row1Left`, `row1Right` (top underlays), `row6Left`, `row56Right` (bottom covers) |
| `bgColor` | color-expr | Background color of the cover |
| `fontColor` | color-expr | Text color for month/year labels |
| `fontSize` | expr | Font size |
| `fontName` | string | Font family |
| `calendarRadius` | expr | Radius of the parent calendar wheel (for positioning) |
| `update` | expr | Update interval |
| `animSpeed` | expr | Slide animation speed |
| `z` | expr | Height for shadow casting. Top covers (`row1*`) are underlays and don't cast shadows |

---

## `<CalendarHeader>` — Weekday Header Row (Babylon)

Draws the "S M T W T F S" header row above the calendar grid.

```xml
<CalendarHeader name='cal header' weekdayStart='0'
                weekdayColor='black' weekendColor='red'
                fontSize='9' fontName='Arial' bodyFontSize='10' bodyFontName='Arial'
                parkX='200' parkY='200' />
```

| Attribute | Type | Description |
|-----------|------|-------------|
| `weekdayStart` | string | Which weekday to start the week (0=Sunday, 1=Monday) |
| `weekdayColor` | color-expr | Color for weekday names (Mon–Fri) |
| `weekendColor` | color-expr | Color for weekend names (Sat, Sun) |
| `fontSize` | expr | Header font size |
| `fontName` | string | Header font family |
| `bodyFontSize` | expr | Calendar body font size (used for sizing calculations) |
| `bodyFontName` | string | Calendar body font family |
| `parkX`, `parkY` | expr | Off-screen "parked" position when header is hidden |

---

## `<Button>` — Interactive Element

Buttons are parsed but rendering is not yet fully implemented in the web app.

| Attribute | Type | Description |
|-----------|------|-------------|
| `action` | string | Action identifier |
| `enabled` | expr | Whether the button is active |
| `src` | string | Button image filename |
| `w`, `h` | expr | Hit area dimensions |
| `motion` | expr | Motion expression |
| `xMotion`, `yMotion` | expr | Position translation expressions |
| `opacity` | expr | Button opacity |
| `rotation` | expr | Button rotation |
| `expanded` | expr | Expanded state |
| `immediate` | string | If set, action fires on touch-down |
| `repeatStrategy` | string | Auto-repeat behavior |
| `grabPrio` | string | Touch grab priority |

---

## Common Concepts

### Modes

The `modes` attribute filters which parts appear in which view:

| Value | Meaning |
|-------|---------|
| `'front'` | Front face (default if `modes` is omitted) |
| `'back'` | Back face |
| `'night'` | Night mode (not used in web app — strip these parts when porting) |
| `'front\|back'` | Both front and back |
| `'all'` | All modes |

### Text Orientations

| Value | Description |
|-------|-------------|
| `upright` | Text stays horizontal (readable) regardless of position (default) |
| `radial` | Each label is rotated so its top points outward from center. Text top edge is placed at `radius × 0.92`. When switching from `demi` to `radial`, increase `radius` by dividing by `0.92` to maintain the same visual position |
| `demi` | Top half radial (tops outward), bottom half anti-radial (tops outward). All labels are readable. `demiTweak` adjusts the anti-radial half's radius |
| `rotated` | Each label's right side points outward (text reads tangentially clockwise) |
| `three` | Text reads normally at the 3 o'clock position |
| `six` | Text reads normally at 6 o'clock |
| `nine` | Text reads normally at 9 o'clock |
| `twelve` | Text reads normally at 12 o'clock |

### Animation Kinds

The `kind` attribute maps a hand/wheel to a specific time function. Common values:

| Kind | Time function |
|------|--------------|
| `secondKind` | Seconds within the minute |
| `minuteKind` | Minutes within the hour |
| `hour12Kind` | Hours on a 12-hour dial |
| `hour24Kind` | Hours on a 24-hour dial |
| `reverseHour24Kind` | 24-hour, reversed direction |
| `dayKind` | Day of month |
| `weekDayKind` | Day of week |
| `monthKind` | Month of year |
| `moonDayKind` | Lunar day |
| `moonRAKind` | Moon right ascension |
| `sunRAKind` | Sun right ascension |
| `nodalKind` | Lunar nodal period |
| `earthYearKind` | Earth orbital period |
| `marsYearKind` / `jupiterYearKind` / etc. | Planetary orbital periods |

When `kind` is set, the animation system uses it to determine the target angle. When absent, the `angle` expression is evaluated directly.

### Update Intervals

The `update` attribute controls how often a part recomputes its angle. It can be a numeric expression (in seconds) or a named sentinel function for astronomy-driven scheduling:

| Pattern | Meaning |
|---------|---------|
| `1` | Every second |
| `60` | Every minute |
| `3600` | Every hour |
| `1 * days()` | Once per day |
| `updateAtNextSunrise` | At the next sunrise |
| `updateAtNextSunset` | At the next sunset |
| `updateAtNextMoonrise` | At the next moonrise |
| `updateAtNextMoonset` | At the next moonset |
| `updateAtNextSunriseOrMidnight` | At next sunrise or midnight, whichever first |
| `updateAtNextSunsetOrMidnight` | At next sunset or midnight, whichever first |
| `updateAtNextMoonriseOrMidnight` | At next moonrise or midnight, whichever first |
| `updateAtNextMoonsetOrMidnight` | At next moonset or midnight, whichever first |
| `updateAtNextSunriseOrSunset` | At whichever comes first: sunrise or sunset |
| `updateAtNextMoonriseOrMoonset` | At whichever comes first: moonrise or moonset |
| `updateAtEnvChangeOnly` | Only when location/timezone changes |

Sentinel functions compute the true next astronomical event time in display time and schedule the part to re-evaluate at that boundary. The `OrMidnight` variants clamp to midnight. All sentinels work correctly in forward, backward (-1×), and quantized (scrubbing) modes.

`updateOffset` shifts the update boundary (e.g., `updateOffset='0.5'` updates at :30 instead of :00).

---

## Key Source Files

| File | Purpose |
|------|---------|
| [xml-parser.ts](../src/watch/xml-parser.ts) | Parses XML into `Watch` model |
| [types.ts](../src/watch/types.ts) | TypeScript interfaces for all part types |
| [renderer.ts](../src/watch/renderer.ts) | Draws each part type to canvas (including `drawEotDial()`) |
| [analemma.ts](../src/watch/analemma.ts) | Analemma state, path computation, Sun position, and rendering |
| [watch-env.ts](../src/watch/watch-env.ts) | Expression evaluator with time/astronomy functions |
| [animation.ts](../src/shared/animation.ts) | Hand state machine, kind→angle mapping |

## Related Docs

- [Expressions](expressions.md) — C expression syntax and available functions
- [Face Porting Guide](face-porting-guide.md) — Step-by-step procedure for adding a face
- [XML Parsing](xml-parsing.md) — Parser internals and conventions
- [Rendering](rendering.md) — How parts are drawn
- [Shadows](shadows.md) — Shadow system details
- [Calendar](calendar.md) — Calendar wheel and grid specifics
