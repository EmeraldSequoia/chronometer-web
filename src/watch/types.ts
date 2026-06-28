/**
 * Type definitions for the Chronometer watch model.
 *
 * Each XML element type in a watch definition maps to a typed interface.
 * Numeric attribute values are stored as expression strings (not pre-evaluated)
 * so the rendering layer can re-evaluate dynamic attributes per-frame.
 */

// Expression-valued attributes are raw source strings (compiled on demand by
// the expr layer); `initExprs` are raw `<init>` block strings.

// ============================================================================
// Watch (top level)
// ============================================================================

export interface Watch {
    name: string;
    beatsPerSecond: number;
    /** Diameter of the watch face in XML coordinate units (from faceWidth attribute). */
    faceWidth: number;
    /** CSS color string for the surrounding bezel ring. Empty string means no bezel. */
    bezelColor: string;
    /** If true, draw a fine noon-indicator line at the top of the bezel. */
    bezelNoonMark: boolean;
    /** True if this face uses a world-time ring (Terra-style city ring). */
    worldTimeRing: boolean;
    /** True if this face uses world-time subdials (Gaia-style). */
    worldTimeSubdials: boolean;
    /** True if this face has a planet body selector (Venezia-style). */
    planetSelector: boolean;
    /** True if this face uses wadokei (Japanese temporal hours) with hand/rate mode toggles. */
    wadokei: boolean;
    /** Number of environment slots (from numEnvironments attribute). */
    numEnvironments: number;
    /** Maximum separate locations (from maxSeparateLoc attribute). */
    maxSeparateLoc: number;
    /** True if this face uses a calendar grid (Babylon-style). */
    calendarWeekStart: boolean;
    /** Two-letter URL abbreviation for compact picks parameter encoding. */
    urlAbbrev: string;
    /** All `<init expr="...">` blocks in document order. */
    initExprs: string[];
    /** All parts included for the selected mode, in document order. */
    parts: WatchPart[];
}

// ============================================================================
// Part union type
// ============================================================================

export type WatchPart =
    | QDialPart
    | QHandPart
    | WheelPart
    | QTextPart
    | ImagePart
    | ButtonPart
    | WindowPart
    | StaticPart
    | QRectPart
    | TerminatorPart
    | QWedgePart
    | QDayNightRingPart
    | CalendarRowCoverPart
    | CalendarHeaderPart
    | AnalemmaPart
    | EotDialPart;

// ============================================================================
// Shared base for all parts
// ============================================================================

/**
 * Runtime animation state, separate from parsed XML data.
 * Populated by the animation system; read by the renderer.
 */
export interface PartBase {
    name: string;
    x?: string;
    y?: string;
    modes?: string;
    special?: string;
    specialParam?: string;
    envSlot?: string;
    /** ObsValue handles for the animation values driven by the per-face Updater
     *  (the renderer reads `.currentValue` directly). Populated by buildHandValues,
     *  not by XML parsing. */
    _obsAngle?: import('../shared/obs-value.js').ObsValue;
    _obsOffsetAngle?: import('../shared/obs-value.js').ObsValue;
    _obsXMotion?: import('../shared/obs-value.js').ObsValue;
    _obsYMotion?: import('../shared/obs-value.js').ObsValue;
}

// ============================================================================
// QDial — circular dial with marks, text, tick marks
// ============================================================================

export interface QDialPart extends PartBase {
    type: 'QDial';
    radius?: string;
    radius2?: string;
    clipRadius?: string;
    orientation?: string;     // 'upright' | 'demi' | 'radial' etc.
    demiTweak?: string;
    text?: string;
    fontSize?: string;
    fontName?: string;
    bgColor?: string;
    strokeColor?: string;
    fillColor1?: string;
    fillColor2?: string;
    marks?: string;           // 'outer' | 'center' | 'tickOut' | 'dot' | 'none' etc.
    markWidth?: string;
    nMarks?: string;
    mSize?: string;
    angle?: string;
    angle0?: string;
    angle1?: string;
    angle2?: string;
    update?: string;
    updateOffset?: string;
    kind?: string;
    z?: string;
    thick?: string;
    animSpeed?: string;
}

// ============================================================================
// QHand — drawn hand (rect, tri, or default triangle)
// ============================================================================

export interface QHandPart extends PartBase {
    type: 'QHand';
    angle?: string;
    length?: string;
    length2?: string;
    width?: string;
    tail?: string;
    handType?: string;         // 'rect' | 'tri' (stored from XML `type` attr)
    strokeColor?: string;
    fillColor?: string;
    lineWidth?: string;
    kind?: string;             // 'hour12Kind' | 'minuteKind' | 'secondKind' etc.
    update?: string;
    updateOffset?: string;
    z?: string;
    thick?: string;
    animSpeed?: string;
    dragAnimationType?: string;
    // Arrow overlay attributes
    oLength?: string;
    oWidth?: string;
    oTail?: string;
    oLineWidth?: string;
    oStrokeColor?: string;
    oFillColor?: string;
    oCenter?: string;
    oRadius?: string;
    tFillColor?: string;
    tStrokeColor?: string;
    tLineWidth?: string;
    /** Image source path (for image-based `hand` elements). */
    src?: string;
    /** Image anchor X offset in XML coords. */
    xAnchor?: string;
    /** Image anchor Y offset in XML coords. */
    yAnchor?: string;
    /** Polar offset radius (e.g. moon orbiting 24-hr dial). */
    offsetRadius?: string;
    /** Polar offset angle expression. */
    offsetAngle?: string;
    /** Number of rays for 'sun' hand type. */
    nRays?: string;
    /** Text label (for 'spoke' hand type — e.g. AM/PM indicators). */
    text?: string;
    /** Font size for spoke text. */
    fontSize?: string;
    /** Font name for spoke text. */
    fontName?: string;
    /** X-axis linear motion expression (calendar day-indicator wires). */
    xMotion?: string;
    /** Y-axis linear motion expression (calendar day-indicator wires). */
    yMotion?: string;
    /** Alpha/opacity expression (0 = invisible, 1 = fully opaque). */
    alpha?: string;
    /** Text orientation (e.g. 'radial' for bottom-facing-center text). */
    orientation?: string;
    // --- Pre-rendered shadow cache (not from XML) ---
    /** Pre-rendered hand + shadow bitmap. Created at init/resize. */
    _shadowBitmap?: OffscreenCanvas;
    /** Anchor X within the bitmap in XML coords (rotation pivot point). */
    _shadowAnchorX?: number;
    /** Anchor Y within the bitmap in XML coords (rotation pivot point). */
    _shadowAnchorY?: number;
    /** Bitmap width in XML coordinate units. */
    _shadowBitmapW?: number;
    /** Bitmap height in XML coordinate units. */
    _shadowBitmapH?: number;
}

// ============================================================================
// Wheel — SWheel, QWheel, Swheel (rotating text wheel)
// ============================================================================

export interface WheelPart extends PartBase {
    type: 'Wheel';
    wheelVariant: 'SWheel' | 'QWheel' | 'TWheel';
    angle?: string;
    angle1?: string;
    angle2?: string;
    radius?: string;
    orientation?: string;     // 'three' | 'six' | 'nine' | 'twelve'
    text?: string;
    fontSize?: string;
    fontName?: string;
    strokeColor?: string;
    bgColor?: string;
    bgColor2?: string;       // TWheel: second background color (halfAndHalf mode)
    update?: string;
    updateOffset?: string;
    animSpeed?: string;
    dragAnimationType?: string;
    marks?: string;
    refName?: string;
    /** Separate text radius (QWheel only). */
    tradius?: string;
    /** Tick mark style (e.g. 'tick288', 'tick96'). */
    tick?: string;
    /** Kind indicator (e.g. 'reverseHour24Kind'). */
    kind?: string;
    /** If set, wheel is split into two halves with different background colors. */
    halfAndHalf?: string;
    /** Number of tick marks around the wheel. */
    ticks?: string;
    /** Width of tick marks. */
    tickWidth?: string;
    /** Calendar wheel type: 'calendarWheel3456' | 'calendarWheel012B' | 'calendarWheelOct1582'. */
    calendar?: string;
    /** Which weekday the calendar grid starts on (0=Sunday). */
    calendarStartDay?: string;
    /** Color for weekend day numbers in the calendar grid. */
    calendarWeekendColor?: string;
    /** Height above dial surface (for shadow casting). */
    z?: string;
}

// ============================================================================
// QText — static text label
// ============================================================================

export interface QTextPart extends PartBase {
    type: 'QText';
    text?: string;
    fontSize?: string;
    fontName?: string;
    strokeColor?: string;
    radius?: string;       // If set, text is drawn along a circular arc
    startAngle?: string;   // Center angle for curved text (radians, 0=top)
    orientation?: string;   // 'demi' = text along arc, tops inward
}

// ============================================================================
// Image — external PNG reference
// ============================================================================

export interface ImagePart extends PartBase {
    type: 'Image';
    src?: string;
    alpha?: string;
    scale?: string;
}

// ============================================================================
// Button — interactive element
// ============================================================================

export interface ButtonPart extends PartBase {
    type: 'Button';
    action?: string;
    enabled?: string;
    src?: string;
    motion?: string;
    xMotion?: string;
    yMotion?: string;
    w?: string;
    h?: string;
    opacity?: string;
    rotation?: string;
    expanded?: string;
    immediate?: string;
    repeatStrategy?: string;
    grabPrio?: string;
}

// ============================================================================
// Window — clipping region
// ============================================================================

export interface WindowPart extends PartBase {
    type: 'Window';
    w?: string;
    h?: string;
    windowType?: string;       // 'porthole' | 'rect' (stored from XML `type` attr)
    border?: string;
    strokeColor?: string;
    shadowOpacity?: string;
    shadowSigma?: string;
    shadowOffset?: string;
    shadowOffsetX?: string;
}

// ============================================================================
// Static — container for grouped static elements
// ============================================================================

export interface StaticPart extends PartBase {
    type: 'Static';
    children: WatchPart[];
    /** Pre-rendered cache (with all window cutouts baked in). Set at cache-build time. */
    cachedCanvas?: OffscreenCanvas;
    /** Windows that precede this static block in document order; consumed at cache-build time. */
    precedingWindows?: WindowPart[];
}

// ============================================================================
// QRect — simple colored rectangle
// ============================================================================

export interface QRectPart extends PartBase {
    type: 'QRect';
    w?: string;
    h?: string;
    bgColor?: string;
    panes?: string;
}

// ============================================================================
// Terminator — moon phase leaf display
// ============================================================================

export interface TerminatorPart extends PartBase {
    type: 'Terminator';
    radius?: string;
    leavesPerQuadrant?: string;
    incremental?: string;
    leafBorderColor?: string;
    leafFillColor?: string;
    leafAnchorRadius?: string;
    update?: string;
    updateOffset?: string;
    phaseAngle?: string;       // expression: moonAgeAngle()
    rotation?: string;         // expression: moonRelativePositionAngle()
}

// ============================================================================
// QWedge — annular sector (pie-slice of a ring)
// ============================================================================

export interface QWedgePart extends PartBase {
    type: 'QWedge';
    outerRadius?: string;
    innerRadius?: string;
    angleSpan?: string;
    angle?: string;
    strokeColor?: string;
    fillColor?: string;
    opaque?: number;
    update?: string;
    /** Polar offset radius (e.g. Terra date wedges orbiting the worldtime ring). */
    offsetRadius?: string;
    /** Polar offset angle expression. */
    offsetAngle?: string;
    animSpeed?: string;
    dragAnimationType?: string;
}

// ============================================================================
// QDayNightRing — colored wedges showing daylight hours on 24-hour dial
// ============================================================================

export interface QDayNightRingPart extends PartBase {
    type: 'QDayNightRing';
    outerRadius?: string;
    innerRadius?: string;
    numWedges?: string;
    planetNumber?: string;
    masterOffset?: string;
    strokeColor?: string;
    fillColor?: string;
    update?: string;
    timeBase?: string;         // 'LST' for Local Sidereal Time, omitted for local time
    envSlot?: string;         // env slot number — routes astronomy to slot's city lat/lon
    /** Optional override: raw sunset angle expression for slide-mode wedge positioning. */
    sunsetAngle?: string;
    /** Optional override: raw sunrise angle expression for slide-mode wedge positioning. */
    sunriseAngle?: string;
    /** Wadokei slide: distance (px) to translate hidden wedges inward past center. */
    slideDistance?: string;
    /** Wadokei slide: animation speed multiplier (default 1.0 = kECGLLinearAnimationSpeed). */
    slideAnimSpeed?: string;
    // --- ObsValue handles (driven by the per-face Updater; renderer reads .currentValue) ---
    /** masterOffset ObsValue (ring rotation; Vienna noon/midnight, Kyoto mode). */
    _obsMasterOffset?: import('../shared/obs-value.js').ObsValue;
    /** Per-wedge angle ObsValues (one per wedge). */
    _obsWedgeAngles?: import('../shared/obs-value.js').ObsValue[];
    /** Per-wedge slide ObsValues (wadokei only; one per wedge). */
    _obsWedgeSlides?: import('../shared/obs-value.js').ObsValue[];
}

// ============================================================================
// CalendarRowCover — covers partial weeks at top/bottom of calendar grid
// ============================================================================

export interface CalendarRowCoverPart extends PartBase {
    type: 'CalendarRowCover';
    /** Cover type: 'row1Left' | 'row1Right' | 'row6Left' | 'row56Right'. */
    coverType?: string;
    fontName?: string;
    fontSize?: string;
    fontColor?: string;
    bgColor?: string;
    calendarRadius?: string;
    update?: string;
    animSpeed?: string;
    z?: string;
}

// ============================================================================
// CalendarHeader — weekday abbreviation row (S M T W T F S)
// ============================================================================

export interface CalendarHeaderPart extends PartBase {
    type: 'CalendarHeader';
    /** Which weekday the header starts on (0=Sunday, 1=Monday, 6=Saturday). */
    weekdayStart?: string;
    weekdayColor?: string;
    weekendColor?: string;
    bodyFontSize?: string;
    bodyFontName?: string;
    fontSize?: string;
    fontName?: string;
    parkX?: string;
    parkY?: string;
}

// ============================================================================
// Analemma — Sun analemma figure-eight display
// ============================================================================

export interface AnalemmaPart extends PartBase {
    type: 'Analemma';
    /** Radius of the circular disc in XML units. */
    radius?: string;
    /** Radius of the Sun marker dot. */
    sunRadius?: string;
    /** Fill color for the Sun marker. */
    sunFillColor?: string;
    /** Stroke color for the Sun marker. */
    sunStrokeColor?: string;
    /** Color of the analemma path/channel line. */
    channelColor?: string;
    /** Width of the path/channel line. */
    channelWidth?: string;
    /** Image filename for the background disc (e.g. miniature of face image). */
    bgSrc?: string;
    /** 0 = background stays fixed while channel rotates; 1 = background rotates with channel. */
    bgRotates?: string;
    /** Update interval in seconds (default 300 = 5 minutes). */
    update?: string;
}

// ============================================================================
// EOT Dial — procedurally drawn Equation of Time dial
// ============================================================================

export interface EotDialPart extends PartBase {
    type: 'EotDial';
    /** Radius of the tick-mark arc in XML units. */
    radius?: string;
    /** Total arc span in radians (default 7π/6 ≈ 210°). */
    arcSpan?: string;
    /** Color for tick marks, arc, and labels. */
    strokeColor?: string;
    /** Font size for the +/- symbols and tick labels. */
    fontSize?: string;
    /** Font size for the title label (default: fontSize * 3). */
    titleFontSize?: string;
    /** Title label text (default "Equation of Time"). */
    labelText?: string;
    /** Y offset for the title label in XML units (positive = up). */
    titleYOffset?: string;
}
