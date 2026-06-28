/**
 * XML parser for Chronometer watch definition files.
 *
 * Parses watch XML into the typed model defined in types.ts.
 * Filters parts by mode (front, back, night) at parse time.
 */

import type {
    Watch,
    WatchPart,
    QDialPart,
    QHandPart,
    WheelPart,
    QTextPart,
    ImagePart,
    ButtonPart,
    WindowPart,
    StaticPart,
    QRectPart,
    TerminatorPart,
    QWedgePart,
    QDayNightRingPart,
    CalendarRowCoverPart,
    CalendarHeaderPart,
    AnalemmaPart,
    EotDialPart,
} from './types.js';

// ============================================================================
// Public API
// ============================================================================

export type ModeFilter = 'front' | 'back' | 'night';

/**
 * Parse a watch XML string, returning only parts matching the given mode.
 *
 * @param xmlText   The raw XML string
 * @param mode      Which mode to filter for ('front', 'back', 'night')
 * @param domParser Optional DOMParser instance (for Node.js testing with jsdom)
 */
export function parseWatchXML(
    xmlText: string,
    mode: ModeFilter,
    domParser?: { parseFromString(text: string, type: string): Document },
): Watch {
    const parser = domParser ?? new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');

    const watchEl = doc.querySelector('watch');
    if (!watchEl) {
        throw new Error('No <watch> element found in XML');
    }

    const watch: Watch = {
        name: attr(watchEl, 'name') ?? 'unknown',
        beatsPerSecond: parseInt(attr(watchEl, 'beatsPerSecond') ?? '0', 10),
        faceWidth: parseFloat(attr(watchEl, 'faceWidth') ?? '290'),
        bezelColor: attr(watchEl, 'bezelColor') ?? '',
        bezelNoonMark: (attr(watchEl, 'bezelNoonMark') ?? '') === 'true',
        worldTimeRing: (attr(watchEl, 'worldTimeRing') ?? '') === '1',
        worldTimeSubdials: (attr(watchEl, 'worldTimeSubdials') ?? '') === '1',
        planetSelector: (attr(watchEl, 'planetSelector') ?? '') === '1',
        wadokei: (attr(watchEl, 'wadokei') ?? '') === '1',
        numEnvironments: parseInt(attr(watchEl, 'numEnvironments') ?? '1', 10),
        maxSeparateLoc: parseInt(attr(watchEl, 'maxSeparateLoc') ?? '1', 10),
        calendarWeekStart: (attr(watchEl, 'calendarWeekStart') ?? '') === '1',
        urlAbbrev: attr(watchEl, 'urlAbbrev') ?? '',
        initExprs: [],
        parts: [],
    };

    // Walk children of <watch>
    for (const child of Array.from(watchEl.children)) {
        processElement(child, mode, watch.initExprs, watch.parts);
    }

    return watch;
}

// ============================================================================
// Element processing
// ============================================================================

function processElement(
    el: Element,
    mode: ModeFilter,
    initExprs: string[],
    parts: WatchPart[],
): void {
    const tag = el.tagName.toLowerCase();

    switch (tag) {
        case 'init':
            // Always collect init blocks (they define variables needed by all modes)
            {
                const exprStr = attr(el, 'expr');
                if (exprStr) {
                    initExprs.push(exprStr);
                }
            }
            break;

        case 'atlas':
            // Stored on the watch if needed, but not a renderable part
            break;

        case 'static':
            processStatic(el, mode, initExprs, parts);
            break;

        case 'qdial':
            if (matchesMode(el, mode)) {
                parts.push(parseQDial(el));
            }
            break;

        case 'qhand':
        case 'hand':
            if (matchesMode(el, mode)) {
                parts.push(parseQHand(el));
            }
            break;

        case 'swheel':
        case 'qwheel':
        case 'twheel':
            if (matchesMode(el, mode)) {
                const wv = tag === 'qwheel' ? 'QWheel' : tag === 'twheel' ? 'TWheel' : 'SWheel';
                parts.push(parseWheel(el, wv as 'SWheel' | 'QWheel' | 'TWheel'));
            }
            break;

        case 'qtext':
            if (matchesMode(el, mode)) {
                parts.push(parseQText(el));
            }
            break;

        case 'image':
            if (matchesMode(el, mode)) {
                parts.push(parseImage(el));
            }
            break;

        case 'qwedge':
            if (matchesMode(el, mode)) {
                parts.push(parseQWedge(el));
            }
            break;

        case 'button':
            if (matchesMode(el, mode)) {
                parts.push(parseButton(el));
            }
            break;

        case 'window':
            if (matchesMode(el, mode)) {
                parts.push(parseWindow(el));
            }
            break;

        case 'qrect':
            if (matchesMode(el, mode)) {
                parts.push(parseQRect(el));
            }
            break;

        case 'terminator':
            if (matchesMode(el, mode)) {
                parts.push(parseTerminator(el));
            }
            break;

        case 'qdaynightring':
            if (matchesMode(el, mode)) {
                parts.push(parseQDayNightRing(el));
            }
            break;

        case 'calendarrowcover':
            if (matchesMode(el, mode)) {
                parts.push(parseCalendarRowCover(el));
            }
            break;

        case 'calendarheader':
            if (matchesMode(el, mode)) {
                parts.push(parseCalendarHeader(el));
            }
            break;

        case 'tick':
            // Skipped for now
            break;

        case 'analemma':
            if (matchesMode(el, mode)) {
                parts.push(parseAnalemma(el));
            }
            break;

        case 'eotdial':
            if (matchesMode(el, mode)) {
                parts.push(parseEotDial(el));
            }
            break;

        default:
            // Unknown element — skip silently
            break;
    }
}

// ============================================================================
// Static container
// ============================================================================

function processStatic(
    el: Element,
    mode: ModeFilter,
    initExprs: string[],
    parts: WatchPart[],
): void {
    // If the static element itself doesn't match the mode, skip entirely
    if (!matchesMode(el, mode)) {
        // Still collect init blocks from inside even if static is filtered out?
        // No — in the original code, static groups are mode-filtered as a unit.
        return;
    }

    const staticPart: StaticPart = {
        type: 'Static',
        name: attr(el, 'name') ?? '',
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        children: [],
    };

    for (const child of Array.from(el.children)) {
        processElement(child, mode, initExprs, staticPart.children);
    }

    parts.push(staticPart);
}

// ============================================================================
// Individual element parsers
// ============================================================================

function parseQDial(el: Element): QDialPart {
    return {
        type: 'QDial',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        radius: attrExpr(el, 'radius'),
        radius2: attrExpr(el, 'radius2'),
        clipRadius: attrExpr(el, 'clipRadius'),
        orientation: attr(el, 'orientation'),
        demiTweak: attrExpr(el, 'demiTweak'),
        text: attr(el, 'text'),
        fontSize: attrExpr(el, 'fontSize'),
        fontName: attr(el, 'fontName'),
        bgColor: attrExpr(el, 'bgColor'),
        strokeColor: attrExpr(el, 'strokeColor'),
        fillColor1: attrExpr(el, 'fillColor1'),
        fillColor2: attrExpr(el, 'fillColor2'),
        marks: attr(el, 'marks'),
        markWidth: attrExpr(el, 'markWidth'),
        nMarks: attrExpr(el, 'nMarks'),
        mSize: attrExpr(el, 'mSize'),
        angle: attrExpr(el, 'angle'),
        angle0: attrExpr(el, 'angle0'),
        angle1: attrExpr(el, 'angle1'),
        angle2: attrExpr(el, 'angle2'),
        update: attrExpr(el, 'update'),
        updateOffset: attrExpr(el, 'updateOffset'),
        kind: attr(el, 'kind'),
        z: attrExpr(el, 'z'),
        thick: attrExpr(el, 'thick'),
        animSpeed: attrExpr(el, 'animSpeed'),
    };
}

function parseQHand(el: Element): QHandPart {
    return {
        type: 'QHand',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        angle: attrExpr(el, 'angle'),
        length: attrExpr(el, 'length'),
        length2: attrExpr(el, 'length2'),
        width: attrExpr(el, 'width'),
        tail: attrExpr(el, 'tail'),
        handType: attr(el, 'type'),
        strokeColor: attrExpr(el, 'strokeColor'),
        fillColor: attrExpr(el, 'fillColor'),
        lineWidth: attrExpr(el, 'lineWidth'),
        kind: attr(el, 'kind'),
        update: attrExpr(el, 'update'),
        updateOffset: attrExpr(el, 'updateOffset'),
        z: attrExpr(el, 'z'),
        thick: attrExpr(el, 'thick'),
        animSpeed: attrExpr(el, 'animSpeed'),
        dragAnimationType: attr(el, 'dragAnimationType'),
        oLength: attrExpr(el, 'oLength'),
        oWidth: attrExpr(el, 'oWidth'),
        oTail: attrExpr(el, 'oTail'),
        oLineWidth: attrExpr(el, 'oLineWidth'),
        oStrokeColor: attrExpr(el, 'oStrokeColor'),
        oFillColor: attrExpr(el, 'oFillColor'),
        oCenter: attrExpr(el, 'oCenter'),
        oRadius: attrExpr(el, 'oRadius'),
        tFillColor: attrExpr(el, 'tFillColor'),
        tStrokeColor: attrExpr(el, 'tStrokeColor'),
        tLineWidth: attrExpr(el, 'tLineWidth'),
        src: attr(el, 'src'),
        xAnchor: attrExpr(el, 'xAnchor'),
        yAnchor: attrExpr(el, 'yAnchor'),
        offsetRadius: attrExpr(el, 'offsetRadius'),
        offsetAngle: attrExpr(el, 'offsetAngle'),
        nRays: attrExpr(el, 'nRays'),
        text: attr(el, 'text'),
        fontSize: attrExpr(el, 'fontSize'),
        fontName: attr(el, 'fontName'),
        xMotion: attrExpr(el, 'xMotion'),
        yMotion: attrExpr(el, 'yMotion'),
        alpha: attrExpr(el, 'alpha'),
        orientation: attr(el, 'orientation'),
        special: attr(el, 'special'),
        specialParam: attrExpr(el, 'specialParam'),
        envSlot: attrExpr(el, 'envSlot'),
    };
}

function parseWheel(el: Element, variant: 'SWheel' | 'QWheel' | 'TWheel'): WheelPart {
    return {
        type: 'Wheel',
        wheelVariant: variant,
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        angle: attrExpr(el, 'angle'),
        angle1: attrExpr(el, 'angle1'),
        angle2: attrExpr(el, 'angle2'),
        radius: attrExpr(el, 'radius'),
        orientation: attr(el, 'orientation'),
        text: attr(el, 'text'),
        fontSize: attrExpr(el, 'fontSize'),
        fontName: attr(el, 'fontName'),
        strokeColor: attrExpr(el, 'strokeColor'),
        bgColor: attrExpr(el, 'bgColor'),
        bgColor2: attrExpr(el, 'bgColor2'),
        update: attrExpr(el, 'update'),
        updateOffset: attrExpr(el, 'updateOffset'),
        animSpeed: attrExpr(el, 'animSpeed'),
        dragAnimationType: attr(el, 'dragAnimationType'),
        marks: attr(el, 'marks'),
        refName: attr(el, 'refName'),
        tradius: attrExpr(el, 'tradius'),
        tick: attr(el, 'tick'),
        kind: attr(el, 'kind'),
        halfAndHalf: attrExpr(el, 'halfAndHalf'),
        ticks: attrExpr(el, 'ticks'),
        tickWidth: attrExpr(el, 'tickWidth'),
        calendar: attr(el, 'calendar'),
        calendarStartDay: attr(el, 'calendarStartDay'),
        calendarWeekendColor: attrExpr(el, 'calendarWeekendColor'),
        z: attrExpr(el, 'z'),
    };
}

function parseQText(el: Element): QTextPart {
    return {
        type: 'QText',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        text: attr(el, 'text'),
        fontSize: attrExpr(el, 'fontSize'),
        fontName: attr(el, 'fontName'),
        strokeColor: attrExpr(el, 'strokeColor'),
        radius: attrExpr(el, 'radius'),
        startAngle: attrExpr(el, 'startAngle'),
        orientation: attr(el, 'orientation'),
    };
}

function parseImage(el: Element): ImagePart {
    return {
        type: 'Image',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        src: attr(el, 'src'),
        alpha: attrExpr(el, 'alpha'),
        scale: attrExpr(el, 'scale'),
        special: attr(el, 'special'),
        specialParam: attrExpr(el, 'specialParam'),
        envSlot: attrExpr(el, 'envSlot'),
    };
}

function parseButton(el: Element): ButtonPart {
    return {
        type: 'Button',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        action: attr(el, 'action'),
        enabled: attrExpr(el, 'enabled'),
        src: attr(el, 'src'),
        motion: attrExpr(el, 'motion'),
        xMotion: attrExpr(el, 'xMotion'),
        yMotion: attrExpr(el, 'yMotion'),
        w: attrExpr(el, 'w'),
        h: attrExpr(el, 'h'),
        opacity: attrExpr(el, 'opacity'),
        rotation: attrExpr(el, 'rotation'),
        expanded: attrExpr(el, 'expanded'),
        immediate: attr(el, 'immediate'),
        repeatStrategy: attr(el, 'repeatStrategy'),
        grabPrio: attr(el, 'grabPrio'),
    };
}

function parseWindow(el: Element): WindowPart {
    return {
        type: 'Window',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        w: attrExpr(el, 'w'),
        h: attrExpr(el, 'h'),
        windowType: attr(el, 'type'),
        border: attrExpr(el, 'border'),
        strokeColor: attrExpr(el, 'strokeColor'),
        shadowOpacity: attrExpr(el, 'shadowOpacity'),
        shadowSigma: attrExpr(el, 'shadowSigma'),
        shadowOffset: attrExpr(el, 'shadowOffset'),
        shadowOffsetX: attrExpr(el, 'shadowOffsetX'),
    };
}

function parseQRect(el: Element): QRectPart {
    return {
        type: 'QRect',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        w: attrExpr(el, 'w'),
        h: attrExpr(el, 'h'),
        bgColor: attrExpr(el, 'bgColor'),
        panes: attrExpr(el, 'panes'),
    };
}

function parseTerminator(el: Element): TerminatorPart {
    return {
        type: 'Terminator',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        radius: attrExpr(el, 'radius'),
        leavesPerQuadrant: attrExpr(el, 'leavesPerQuadrant'),
        incremental: attrExpr(el, 'incremental'),
        leafBorderColor: attrExpr(el, 'leafBorderColor'),
        leafFillColor: attrExpr(el, 'leafFillColor'),
        leafAnchorRadius: attrExpr(el, 'leafAnchorRadius'),
        update: attrExpr(el, 'update'),
        updateOffset: attrExpr(el, 'updateOffset'),
        phaseAngle: attrExpr(el, 'phaseAngle'),
        rotation: attrExpr(el, 'rotation'),
    };
}

function parseAnalemma(el: Element): AnalemmaPart {
    return {
        type: 'Analemma',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        radius: attrExpr(el, 'radius'),
        sunRadius: attrExpr(el, 'sunRadius'),
        sunFillColor: attrExpr(el, 'sunFillColor'),
        sunStrokeColor: attrExpr(el, 'sunStrokeColor'),
        channelColor: attrExpr(el, 'channelColor'),
        channelWidth: attrExpr(el, 'channelWidth'),
        bgSrc: attr(el, 'bgSrc'),
        bgRotates: attrExpr(el, 'bgRotates'),
        update: attrExpr(el, 'update'),
    };
}

function parseEotDial(el: Element): EotDialPart {
    return {
        type: 'EotDial',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        radius: attrExpr(el, 'radius'),
        arcSpan: attrExpr(el, 'arcSpan'),
        strokeColor: attrExpr(el, 'strokeColor'),
        fontSize: attrExpr(el, 'fontSize'),
        titleFontSize: attrExpr(el, 'titleFontSize'),
        labelText: attr(el, 'labelText'),
        titleYOffset: attrExpr(el, 'titleYOffset'),
    };
}

function parseQWedge(el: Element): QWedgePart {
    return {
        type: 'QWedge',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        outerRadius: attrExpr(el, 'outerRadius'),
        innerRadius: attrExpr(el, 'innerRadius'),
        angleSpan: attrExpr(el, 'angleSpan'),
        angle: attrExpr(el, 'angle'),
        strokeColor: attrExpr(el, 'strokeColor'),
        fillColor: attrExpr(el, 'fillColor'),
        opaque: el.getAttribute('opaque') ? Number(el.getAttribute('opaque')) : undefined,
        update: attrExpr(el, 'update'),
        offsetRadius: attrExpr(el, 'offsetRadius'),
        offsetAngle: attrExpr(el, 'offsetAngle'),
        animSpeed: attrExpr(el, 'animSpeed'),
        dragAnimationType: attr(el, 'dragAnimationType'),
    };
}

function parseQDayNightRing(el: Element): QDayNightRingPart {
    return {
        type: 'QDayNightRing',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        outerRadius: attrExpr(el, 'outerRadius'),
        innerRadius: attrExpr(el, 'innerRadius'),
        numWedges: attrExpr(el, 'numWedges'),
        planetNumber: attrExpr(el, 'planetNumber'),
        masterOffset: attrExpr(el, 'masterOffset'),
        strokeColor: attrExpr(el, 'strokeColor'),
        fillColor: attrExpr(el, 'fillColor'),
        update: attrExpr(el, 'update'),
        timeBase: attr(el, 'timeBase'),
        envSlot: attrExpr(el, 'envSlot'),
        sunsetAngle: attrExpr(el, 'sunsetAngle'),
        sunriseAngle: attrExpr(el, 'sunriseAngle'),
        slideDistance: attrExpr(el, 'slideDistance'),
        slideAnimSpeed: attrExpr(el, 'slideAnimSpeed'),
    };
}

function parseCalendarRowCover(el: Element): CalendarRowCoverPart {
    return {
        type: 'CalendarRowCover',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        coverType: attr(el, 'coverType'),
        fontName: attr(el, 'fontName'),
        fontSize: attrExpr(el, 'fontSize'),
        fontColor: attrExpr(el, 'fontColor'),
        bgColor: attrExpr(el, 'bgColor'),
        calendarRadius: attrExpr(el, 'calendarRadius'),
        update: attrExpr(el, 'update'),
        animSpeed: attrExpr(el, 'animSpeed'),
        z: attrExpr(el, 'z'),
    };
}

function parseCalendarHeader(el: Element): CalendarHeaderPart {
    return {
        type: 'CalendarHeader',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        weekdayStart: attr(el, 'weekdayStart'),
        weekdayColor: attrExpr(el, 'weekdayColor'),
        weekendColor: attrExpr(el, 'weekendColor'),
        bodyFontSize: attrExpr(el, 'bodyFontSize'),
        bodyFontName: attr(el, 'bodyFontName'),
        fontSize: attrExpr(el, 'fontSize'),
        fontName: attr(el, 'fontName'),
        parkX: attrExpr(el, 'parkX'),
        parkY: attrExpr(el, 'parkY'),
    };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get an attribute value, returning undefined if not present.
 */
function attr(el: Element, name: string): string | undefined {
    const val = el.getAttribute(name);
    return val !== null ? val.trim() : undefined;
}

/**
 * Get an attribute as a raw expression string (compiled on demand by the expr
 * layer). Returns undefined when the attribute is absent or empty.
 */
function attrExpr(el: Element, name: string): string | undefined {
    return attr(el, name) || undefined;
}

/**
 * Get the part name — uses `name` or `refName`, whichever is present.
 */
function partName(el: Element): string {
    return attr(el, 'name') ?? attr(el, 'refName') ?? '';
}

/**
 * Check whether an element's modes include the desired mode.
 *
 * Matching rules:
 * - No `modes` attr → matches 'front' only (default)
 * - `modes` contains 'all' → matches everything
 * - `modes` is a '|'-separated list → matches if the desired mode is in the list
 */
function matchesMode(el: Element, desiredMode: ModeFilter): boolean {
    const modesAttr = attr(el, 'modes');

    // No modes attribute — default to 'front' only (matching the original behavior
    // where frontMask is the default in ECWatchDefinitionManager)
    if (modesAttr === undefined) {
        return desiredMode === 'front';
    }

    const lower = modesAttr.toLowerCase();
    if (lower === 'all') return true;
    return lower.split('|').some(m => m.trim() === desiredMode);
}
