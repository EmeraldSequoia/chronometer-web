/**
 * Type definitions for the Chronometer watch model.
 *
 * Each XML element type in a watch definition maps to a typed interface.
 * Numeric attribute values are stored as expression strings (not pre-evaluated)
 * so the rendering layer can re-evaluate dynamic attributes per-frame.
 */

import type { ASTNode } from '../expr/parser.js';

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
    initExprs: ASTNode[];
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
    x?: ASTNode;
    y?: ASTNode;
    modes?: string;
    special?: string;
    specialParam?: ASTNode;
    envSlot?: ASTNode;
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
    radius?: ASTNode;
    radius2?: ASTNode;
    clipRadius?: ASTNode;
    orientation?: string;     // 'upright' | 'demi' | 'radial' etc.
    demiTweak?: ASTNode;
    text?: string;
    fontSize?: ASTNode;
    fontName?: string;
    bgColor?: ASTNode;
    strokeColor?: ASTNode;
    fillColor1?: ASTNode;
    fillColor2?: ASTNode;
    marks?: string;           // 'outer' | 'center' | 'tickOut' | 'dot' | 'none' etc.
    markWidth?: ASTNode;
    nMarks?: ASTNode;
    mSize?: ASTNode;
    angle?: ASTNode;
    angle0?: ASTNode;
    angle1?: ASTNode;
    angle2?: ASTNode;
    update?: ASTNode;
    updateOffset?: ASTNode;
    kind?: string;
    z?: ASTNode;
    thick?: ASTNode;
    animSpeed?: ASTNode;
}

// ============================================================================
// QHand — drawn hand (rect, tri, or default triangle)
// ============================================================================

export interface QHandPart extends PartBase {
    type: 'QHand';
    angle?: ASTNode;
    length?: ASTNode;
    length2?: ASTNode;
    width?: ASTNode;
    tail?: ASTNode;
    handType?: string;         // 'rect' | 'tri' (stored from XML `type` attr)
    strokeColor?: ASTNode;
    fillColor?: ASTNode;
    lineWidth?: ASTNode;
    kind?: string;             // 'hour12Kind' | 'minuteKind' | 'secondKind' etc.
    update?: ASTNode;
    updateOffset?: ASTNode;
    z?: ASTNode;
    thick?: ASTNode;
    animSpeed?: ASTNode;
    dragAnimationType?: string;
    // Arrow overlay attributes
    oLength?: ASTNode;
    oWidth?: ASTNode;
    oTail?: ASTNode;
    oLineWidth?: ASTNode;
    oStrokeColor?: ASTNode;
    oFillColor?: ASTNode;
    oCenter?: ASTNode;
    oRadius?: ASTNode;
    tFillColor?: ASTNode;
    tStrokeColor?: ASTNode;
    tLineWidth?: ASTNode;
    /** Image source path (for image-based `hand` elements). */
    src?: string;
    /** Image anchor X offset in XML coords. */
    xAnchor?: ASTNode;
    /** Image anchor Y offset in XML coords. */
    yAnchor?: ASTNode;
    /** Polar offset radius (e.g. moon orbiting 24-hr dial). */
    offsetRadius?: ASTNode;
    /** Polar offset angle expression. */
    offsetAngle?: ASTNode;
    /** Number of rays for 'sun' hand type. */
    nRays?: ASTNode;
    /** Text label (for 'spoke' hand type — e.g. AM/PM indicators). */
    text?: string;
    /** Font size for spoke text. */
    fontSize?: ASTNode;
    /** Font name for spoke text. */
    fontName?: string;
    /** X-axis linear motion expression (calendar day-indicator wires). */
    xMotion?: ASTNode;
    /** Y-axis linear motion expression (calendar day-indicator wires). */
    yMotion?: ASTNode;
    /** Alpha/opacity expression (0 = invisible, 1 = fully opaque). */
    alpha?: ASTNode;
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
    angle?: ASTNode;
    angle1?: ASTNode;
    angle2?: ASTNode;
    radius?: ASTNode;
    orientation?: string;     // 'three' | 'six' | 'nine' | 'twelve'
    text?: string;
    fontSize?: ASTNode;
    fontName?: string;
    strokeColor?: ASTNode;
    bgColor?: ASTNode;
    bgColor2?: ASTNode;       // TWheel: second background color (halfAndHalf mode)
    update?: ASTNode;
    updateOffset?: ASTNode;
    animSpeed?: ASTNode;
    dragAnimationType?: string;
    marks?: string;
    refName?: string;
    /** Separate text radius (QWheel only). */
    tradius?: ASTNode;
    /** Tick mark style (e.g. 'tick288', 'tick96'). */
    tick?: string;
    /** Kind indicator (e.g. 'reverseHour24Kind'). */
    kind?: string;
    /** If set, wheel is split into two halves with different background colors. */
    halfAndHalf?: ASTNode;
    /** Number of tick marks around the wheel. */
    ticks?: ASTNode;
    /** Width of tick marks. */
    tickWidth?: ASTNode;
    /** Calendar wheel type: 'calendarWheel3456' | 'calendarWheel012B' | 'calendarWheelOct1582'. */
    calendar?: string;
    /** Which weekday the calendar grid starts on (0=Sunday). */
    calendarStartDay?: string;
    /** Color for weekend day numbers in the calendar grid. */
    calendarWeekendColor?: ASTNode;
    /** Height above dial surface (for shadow casting). */
    z?: ASTNode;
}

// ============================================================================
// QText — static text label
// ============================================================================

export interface QTextPart extends PartBase {
    type: 'QText';
    text?: string;
    fontSize?: ASTNode;
    fontName?: string;
    strokeColor?: ASTNode;
    radius?: ASTNode;       // If set, text is drawn along a circular arc
    startAngle?: ASTNode;   // Center angle for curved text (radians, 0=top)
    orientation?: string;   // 'demi' = text along arc, tops inward
}

// ============================================================================
// Image — external PNG reference
// ============================================================================

export interface ImagePart extends PartBase {
    type: 'Image';
    src?: string;
    alpha?: ASTNode;
    scale?: ASTNode;
}

// ============================================================================
// Button — interactive element
// ============================================================================

export interface ButtonPart extends PartBase {
    type: 'Button';
    action?: string;
    enabled?: ASTNode;
    src?: string;
    motion?: ASTNode;
    xMotion?: ASTNode;
    yMotion?: ASTNode;
    w?: ASTNode;
    h?: ASTNode;
    opacity?: ASTNode;
    rotation?: ASTNode;
    expanded?: ASTNode;
    immediate?: string;
    repeatStrategy?: string;
    grabPrio?: string;
}

// ============================================================================
// Window — clipping region
// ============================================================================

export interface WindowPart extends PartBase {
    type: 'Window';
    w?: ASTNode;
    h?: ASTNode;
    windowType?: string;       // 'porthole' | 'rect' (stored from XML `type` attr)
    border?: ASTNode;
    strokeColor?: ASTNode;
    shadowOpacity?: ASTNode;
    shadowSigma?: ASTNode;
    shadowOffset?: ASTNode;
    shadowOffsetX?: ASTNode;
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
    w?: ASTNode;
    h?: ASTNode;
    bgColor?: ASTNode;
    panes?: ASTNode;
}

// ============================================================================
// Terminator — moon phase leaf display
// ============================================================================

export interface TerminatorPart extends PartBase {
    type: 'Terminator';
    radius?: ASTNode;
    leavesPerQuadrant?: ASTNode;
    incremental?: ASTNode;
    leafBorderColor?: ASTNode;
    leafFillColor?: ASTNode;
    leafAnchorRadius?: ASTNode;
    update?: ASTNode;
    updateOffset?: ASTNode;
    phaseAngle?: ASTNode;       // expression: moonAgeAngle()
    rotation?: ASTNode;         // expression: moonRelativePositionAngle()
}

// ============================================================================
// QWedge — annular sector (pie-slice of a ring)
// ============================================================================

export interface QWedgePart extends PartBase {
    type: 'QWedge';
    outerRadius?: ASTNode;
    innerRadius?: ASTNode;
    angleSpan?: ASTNode;
    angle?: ASTNode;
    strokeColor?: ASTNode;
    fillColor?: ASTNode;
    opaque?: number;
    update?: ASTNode;
    /** Polar offset radius (e.g. Terra date wedges orbiting the worldtime ring). */
    offsetRadius?: ASTNode;
    /** Polar offset angle expression. */
    offsetAngle?: ASTNode;
    animSpeed?: ASTNode;
    dragAnimationType?: string;
}

// ============================================================================
// QDayNightRing — colored wedges showing daylight hours on 24-hour dial
// ============================================================================

export interface QDayNightRingPart extends PartBase {
    type: 'QDayNightRing';
    outerRadius?: ASTNode;
    innerRadius?: ASTNode;
    numWedges?: ASTNode;
    planetNumber?: ASTNode;
    masterOffset?: ASTNode;
    strokeColor?: ASTNode;
    fillColor?: ASTNode;
    update?: ASTNode;
    timeBase?: string;         // 'LST' for Local Sidereal Time, omitted for local time
    envSlot?: ASTNode;         // env slot number — routes astronomy to slot's city lat/lon
    /** Optional override: raw sunset angle expression for slide-mode wedge positioning. */
    sunsetAngle?: ASTNode;
    /** Optional override: raw sunrise angle expression for slide-mode wedge positioning. */
    sunriseAngle?: ASTNode;
    /** Wadokei slide: distance (px) to translate hidden wedges inward past center. */
    slideDistance?: ASTNode;
    /** Wadokei slide: animation speed multiplier (default 1.0 = kECGLLinearAnimationSpeed). */
    slideAnimSpeed?: ASTNode;
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
    fontSize?: ASTNode;
    fontColor?: ASTNode;
    bgColor?: ASTNode;
    calendarRadius?: ASTNode;
    update?: ASTNode;
    animSpeed?: ASTNode;
    z?: ASTNode;
}

// ============================================================================
// CalendarHeader — weekday abbreviation row (S M T W T F S)
// ============================================================================

export interface CalendarHeaderPart extends PartBase {
    type: 'CalendarHeader';
    /** Which weekday the header starts on (0=Sunday, 1=Monday, 6=Saturday). */
    weekdayStart?: string;
    weekdayColor?: ASTNode;
    weekendColor?: ASTNode;
    bodyFontSize?: ASTNode;
    bodyFontName?: string;
    fontSize?: ASTNode;
    fontName?: string;
    parkX?: ASTNode;
    parkY?: ASTNode;
}

// ============================================================================
// Analemma — Sun analemma figure-eight display
// ============================================================================

export interface AnalemmaPart extends PartBase {
    type: 'Analemma';
    /** Radius of the circular disc in XML units. */
    radius?: ASTNode;
    /** Radius of the Sun marker dot. */
    sunRadius?: ASTNode;
    /** Fill color for the Sun marker. */
    sunFillColor?: ASTNode;
    /** Stroke color for the Sun marker. */
    sunStrokeColor?: ASTNode;
    /** Color of the analemma path/channel line. */
    channelColor?: ASTNode;
    /** Width of the path/channel line. */
    channelWidth?: ASTNode;
    /** Image filename for the background disc (e.g. miniature of face image). */
    bgSrc?: string;
    /** 0 = background stays fixed while channel rotates; 1 = background rotates with channel. */
    bgRotates?: ASTNode;
    /** Update interval in seconds (default 300 = 5 minutes). */
    update?: ASTNode;
}

// ============================================================================
// EOT Dial — procedurally drawn Equation of Time dial
// ============================================================================

export interface EotDialPart extends PartBase {
    type: 'EotDial';
    /** Radius of the tick-mark arc in XML units. */
    radius?: ASTNode;
    /** Total arc span in radians (default 7π/6 ≈ 210°). */
    arcSpan?: ASTNode;
    /** Color for tick marks, arc, and labels. */
    strokeColor?: ASTNode;
    /** Font size for the +/- symbols and tick labels. */
    fontSize?: ASTNode;
    /** Font size for the title label (default: fontSize * 3). */
    titleFontSize?: ASTNode;
    /** Title label text (default "Equation of Time"). */
    labelText?: string;
    /** Y offset for the title label in XML units (positive = up). */
    titleYOffset?: ASTNode;
}
