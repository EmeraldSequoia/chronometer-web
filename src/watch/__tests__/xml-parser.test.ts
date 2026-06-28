/**
 * Tests for the watch XML parser.
 *
 * Uses the actual Haleakala.xml fixture file parsed with jsdom's DOMParser.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import { parseWatchXML } from '../xml-parser.js';
import type {
    QDialPart,
    QHandPart,
    WheelPart,
    QTextPart,
    ImagePart,
    ButtonPart,
    WindowPart,
    StaticPart,
    QRectPart,
    WatchPart,
} from '../types.js';

// ============================================================================
// Setup
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const haleakalaXML = readFileSync(
    join(__dirname, 'fixtures', 'Haleakala.xml'),
    'utf-8',
);

// Create a jsdom-backed DOMParser for Node.js testing
function makeDOMParser() {
    const jsdom = new JSDOM('');
    return new jsdom.window.DOMParser();
}

/**
 * Assert that a parsed attribute expression (now the raw source string) matches
 * the expected expression, ignoring insignificant whitespace.
 */
function expectExpr(node: string | undefined, exprStr: string) {
    expect(node).toBeDefined();
    expect(node!.replace(/\s+/g, '')).toBe(exprStr.replace(/\s+/g, ''));
}

/**
 * Assert that an attribute expression string references the given function name.
 */
function expectExprContains(node: string | undefined, funcName: string) {
    expect(node).toBeDefined();
    expect(node!).toContain(funcName);
}

// ============================================================================
// Helper: count parts of a specific type, including inside Static children
// ============================================================================

function countParts(parts: WatchPart[], type: string): number {
    let count = 0;
    for (const p of parts) {
        if (p.type === type) count++;
        if (p.type === 'Static') {
            count += countParts((p as StaticPart).children, type);
        }
    }
    return count;
}

function findParts<T extends WatchPart>(parts: WatchPart[], type: string): T[] {
    const result: T[] = [];
    for (const p of parts) {
        if (p.type === type) result.push(p as T);
        if (p.type === 'Static') {
            result.push(...findParts<T>((p as StaticPart).children, type));
        }
    }
    return result;
}

function findPartByName<T extends WatchPart>(parts: WatchPart[], name: string): T | undefined {
    for (const p of parts) {
        if (p.name === name) return p as T;
        if (p.type === 'Static') {
            const found = findPartByName<T>((p as StaticPart).children, name);
            if (found) return found;
        }
    }
    return undefined;
}

// ============================================================================
// Tests
// ============================================================================

describe('parseWatchXML: Haleakala front side', () => {
    let watch: ReturnType<typeof parseWatchXML>;

    beforeAll(() => {
        watch = parseWatchXML(haleakalaXML, 'front', makeDOMParser());
    });

    // --- Top-level ---

    test('parses watch name and beatsPerSecond', () => {
        expect(watch.name).toBe('Haleakala');
        expect(watch.beatsPerSecond).toBe(1);
    });

    test('collects all init expressions', () => {
        // There are 7 <init> blocks in Haleakala.xml (6 near the top + 1 before hands)
        expect(watch.initExprs.length).toBe(7);
        // initExprs are now raw source strings — check they contain the expected assignments.
        expect(watch.initExprs[0]).toContain('hairline=0.25');
        expect(watch.initExprs[1]).toContain('azR=130');
        expect(watch.initExprs[6]).toContain('handStrokeColor=black');
    });

    // --- Mode filtering ---

    test('excludes night-only parts', () => {
        const nightOnlyNames = ['stemn', 'F/Rn', 'adv day butn', 'adv hr  butn',
                                'saz handn', 'salt handn', 'hrn', 'minn', 'secn'];
        for (const name of nightOnlyNames) {
            expect(findPartByName(watch.parts, name)).toBeUndefined();
        }
    });

    test('excludes back-only parts', () => {
        const backOnlyNames = ['Reset b', 'am/pmb', 'nxt mrs hr', 'maz hand',
                               'malt hand', 'mrise but', 'mset but'];
        for (const name of backOnlyNames) {
            expect(findPartByName(watch.parts, name)).toBeUndefined();
        }
    });

    test('includes front|back parts', () => {
        // These have modes='front|back' and should be included
        expect(findPartByName(watch.parts, 'stem')).toBeDefined();
        expect(findPartByName(watch.parts, 'F/R')).toBeDefined();
        expect(findPartByName(watch.parts, 'hr')).toBeDefined();
        expect(findPartByName(watch.parts, 'min')).toBeDefined();
    });

    test('includes front-only parts', () => {
        expect(findPartByName(watch.parts, 'am/pm')).toBeDefined();
        expect(findPartByName(watch.parts, 'saz hand')).toBeDefined();
        expect(findPartByName(watch.parts, 'salt hand')).toBeDefined();
    });

    test('includes front|night parts', () => {
        expect(findPartByName(watch.parts, 'Reset')).toBeDefined();
        expect(findPartByName(watch.parts, 'nxt rs hr')).toBeDefined();
        expect(findPartByName(watch.parts, 'set hr')).toBeDefined();
    });

    // --- Static container ---

    test('includes front static group with children', () => {
        const frontStatic = watch.parts.find(
            p => p.type === 'Static' && p.name === 'front',
        ) as StaticPart | undefined;
        expect(frontStatic).toBeDefined();
        expect(frontStatic!.children.length).toBeGreaterThan(0);
    });

    test('excludes night static group', () => {
        const nightStatic = watch.parts.find(
            p => p.type === 'Static' && p.name === 'night',
        );
        expect(nightStatic).toBeUndefined();
    });

    test('excludes back static group', () => {
        const backStatic = watch.parts.find(
            p => p.type === 'Static' && p.name === 'back',
        );
        expect(backStatic).toBeUndefined();
    });

    // --- QDial ---

    test('parses QDial parts with correct attributes', () => {
        const azDial = findPartByName<QDialPart>(watch.parts, 'az dial');
        expect(azDial).toBeDefined();
        expect(azDial!.type).toBe('QDial');
        expectExpr(azDial!.radius, 'azR+16');
        expect(azDial!.orientation).toBe('upright');
        expect(azDial!.text).toBe('N,E,S,W');
        expectExpr(azDial!.fontSize, '12');
        expect(azDial!.fontName).toBe('Times New Roman');
        expectExpr(azDial!.bgColor, 'clear');
        expectExpr(azDial!.strokeColor, 'black');
        expect(azDial!.marks).toBe('center');
        expectExpr(azDial!.markWidth, '4');
    });

    test('parses QDial with tick marks', () => {
        const dial = findPartByName<QDialPart>(watch.parts, 'main dial2');
        expect(dial).toBeDefined();
        expect(dial!.marks).toBe('tickOut');
        expectExpr(dial!.nMarks, '60');
        expectExpr(dial!.mSize, '6');
    });

    test('parses QDial with angle range', () => {
        const dial = findPartByName<QDialPart>(watch.parts, 'alt dial');
        expect(dial).toBeDefined();
        expectExpr(dial!.angle1, '42*pi/36');
        expectExpr(dial!.angle2, '63*pi/36');
    });

    test('parses QDial with demiTweak', () => {
        const dial = findPartByName<QDialPart>(watch.parts, 'az dial2');
        expect(dial).toBeDefined();
        expect(dial!.orientation).toBe('demi');
        expectExpr(dial!.demiTweak, '-1.0');
    });

    // --- QHand ---

    test('parses QHand with arrow overlay attributes', () => {
        const hr = findPartByName<QHandPart>(watch.parts, 'hr');
        expect(hr).toBeDefined();
        expect(hr!.type).toBe('QHand');
        expect(hr!.handType).toBe('rect');
        expect(hr!.kind).toBe('hour12Kind');
        expectExpr(hr!.angle, 'hour12ValueAngle()');
        expectExpr(hr!.length, 'hrLen-hrArrow');
        expectExpr(hr!.oLength, 'hrArrow');
        expectExpr(hr!.oWidth, '8');
        expectExpr(hr!.oTail, 'hrTail');
        expectExpr(hr!.oLineWidth, 'arrowWidth');
        expectExpr(hr!.oStrokeColor, 'handStrokeColor');
        expectExpr(hr!.oFillColor, 'arrowClr');
        expectExpr(hr!.z, '5');
    });

    test('parses QHand with tri type', () => {
        const sec = findPartByName<QHandPart>(watch.parts, 'sec');
        expect(sec).toBeDefined();
        expect(sec!.handType).toBe('tri');
        expect(sec!.kind).toBe('secondKind');
        expectExpr(sec!.angle, 'secondValueAngle()');
    });

    test('parses sun azimuth hand', () => {
        const hand = findPartByName<QHandPart>(watch.parts, 'saz hand');
        expect(hand).toBeDefined();
        expectExpr(hand!.angle, 'sunAzimuth()');
        expectExpr(hand!.strokeColor, 'azColor');
        expectExpr(hand!.length, 'azR-5');
    });

    // --- Wheels ---

    test('parses SWheel parts', () => {
        const day1s = findPartByName<WheelPart>(watch.parts, 'day1s');
        expect(day1s).toBeDefined();
        expect(day1s!.type).toBe('Wheel');
        expect(day1s!.wheelVariant).toBe('SWheel');
        expect(day1s!.orientation).toBe('three');
        expect(day1s!.text).toBe('0,1,2,3,4,5,6,7,8,9');
        expectExprContains(day1s!.angle, 'fmod');
    });

    test('parses SWheel with refName', () => {
        // The second SWheel uses refName='day1s' — it should be included
        const wheels = findParts<WheelPart>(watch.parts, 'Wheel');
        const refWheel = wheels.find(w => w.refName === 'day1s');
        expect(refWheel).toBeDefined();
        expectExpr(refWheel!.x, 'firstDateX');
    });

    test('parses QWheel parts', () => {
        const ampm = findPartByName<WheelPart>(watch.parts, 'am/pm');
        expect(ampm).toBeDefined();
        expect(ampm!.wheelVariant).toBe('QWheel');
        expectExpr(ampm!.animSpeed, '5.0');
        expect(ampm!.marks).toBe('0');
    });

    // --- QText ---

    test('parses QText parts', () => {
        const rise = findPartByName<QTextPart>(watch.parts, 'next rise');
        expect(rise).toBeDefined();
        expect(rise!.type).toBe('QText');
        expect(rise!.text).toBe('Sunrise');
        expectExpr(rise!.fontSize, '10');
        expect(rise!.fontName).toBe('Verdana');
    });

    // --- Image ---

    test('parses Image parts', () => {
        const face = findPartByName<ImagePart>(watch.parts, 'face');
        expect(face).toBeDefined();
        expect(face!.type).toBe('Image');
        expect(face!.src).toBe('Haleakala-face.png');
        expectExpr(face!.alpha, '1');
    });

    // --- Button ---

    test('parses Button parts with all attributes', () => {
        const stem = findPartByName<ButtonPart>(watch.parts, 'stem');
        expect(stem).toBeDefined();
        expect(stem!.type).toBe('Button');
        expectExpr(stem!.x, 'r-4');
        expectExpr(stem!.y, '0');
        expect(stem!.src).toBe('../partsBin/HD/yellow/front/stem.png');
        // action is still a raw string, not parsed
        expect(stem!.action).toContain('manualSet()');
        expectExpr(stem!.motion, 'manualSet() ? 1 : 0');
        expectExpr(stem!.expanded, '1');
    });

    test('parses invisible (hit-area-only) button', () => {
        const riseBut = findPartByName<ButtonPart>(watch.parts, 'rise but');
        expect(riseBut).toBeDefined();
        expectExpr(riseBut!.w, 'riseSetRadius*2');
        expectExpr(riseBut!.h, 'riseSetRadius*2');
        expect(riseBut!.action).toBe('advanceToSunriseForDay()');
        expect(riseBut!.src).toBeUndefined(); // no image
    });

    // --- Window ---

    test('parses Window parts', () => {
        const monthWin = findPartByName<WindowPart>(watch.parts, 'month win');
        expect(monthWin).toBeDefined();
        expect(monthWin!.type).toBe('Window');
        expectExpr(monthWin!.w, '42');
        expectExpr(monthWin!.h, '16');
        expectExpr(monthWin!.border, '2');
        expectExpr(monthWin!.shadowOpacity, '0.4');
    });

    test('parses porthole window', () => {
        const ampmWin = findPartByName<WindowPart>(watch.parts, 'fr am/pm');
        expect(ampmWin).toBeDefined();
        expect(ampmWin!.windowType).toBe('porthole');
    });

    // --- QRect ---

    test('parses QRect parts', () => {
        const dayBack = findPartByName<QRectPart>(watch.parts, 'day back');
        expect(dayBack).toBeDefined();
        expect(dayBack!.type).toBe('QRect');
        expectExpr(dayBack!.w, '24');
        expectExpr(dayBack!.h, '16');
        expectExpr(dayBack!.panes, '2');
    });
});

// ============================================================================
// Mode filtering: back side
// ============================================================================

describe('parseWatchXML: mode filtering', () => {
    test('back mode includes back-only parts', () => {
        const watch = parseWatchXML(haleakalaXML, 'back', makeDOMParser());
        expect(findPartByName(watch.parts, 'Reset b')).toBeDefined();
        expect(findPartByName(watch.parts, 'maz hand')).toBeDefined();
    });

    test('back mode excludes front-only parts', () => {
        const watch = parseWatchXML(haleakalaXML, 'back', makeDOMParser());
        expect(findPartByName(watch.parts, 'saz hand')).toBeUndefined();
        expect(findPartByName(watch.parts, 'salt hand')).toBeUndefined();
        expect(findPartByName(watch.parts, 'am/pm')).toBeUndefined();
    });

    test('night mode includes night-only parts', () => {
        const watch = parseWatchXML(haleakalaXML, 'night', makeDOMParser());
        expect(findPartByName(watch.parts, 'stemn')).toBeDefined();
        expect(findPartByName(watch.parts, 'F/Rn')).toBeDefined();
    });
});

// ============================================================================
// Small XML parsing
// ============================================================================

describe('parseWatchXML: small examples', () => {
    test('parses minimal watch', () => {
        const xml = `<?xml version="1.0"?>
        <watch name='Test' beatsPerSecond='10'>
          <init expr='r=100' />
          <QDial name='d1' x='0' y='0' radius='r' modes='front' />
        </watch>`;
        const watch = parseWatchXML(xml, 'front', makeDOMParser());
        expect(watch.name).toBe('Test');
        // initExprs are now raw source strings
        expect(watch.initExprs.length).toBe(1);
        expect(watch.initExprs[0]).toBe('r=100');
        expect(watch.parts.length).toBe(1);
        expect(watch.parts[0].type).toBe('QDial');
    });

    test('defaults-to-front when no modes specified', () => {
        const xml = `<?xml version="1.0"?>
        <watch name='Test' beatsPerSecond='1'>
          <QDial name='d1' x='0' y='0' radius='10' />
        </watch>`;
        const front = parseWatchXML(xml, 'front', makeDOMParser());
        expect(front.parts.length).toBe(1);

        const back = parseWatchXML(xml, 'back', makeDOMParser());
        expect(back.parts.length).toBe(0);
    });

    test('throws on missing watch element', () => {
        const xml = `<?xml version="1.0"?><root/>`;
        expect(() => parseWatchXML(xml, 'front', makeDOMParser())).toThrow('No <watch> element');
    });
});
