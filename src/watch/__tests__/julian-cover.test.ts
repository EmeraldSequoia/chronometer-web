/**
 * The year-window calendar covers (docs/calendar.md § Calendar indicators):
 * every face with a red `bce cover` also has a green `julian cover` right
 * after it, with the same geometry, that lies across the window (pi/2) for
 * CE dates before the 15 Oct 1582 switchover and is parked under the face
 * (0) otherwise — and in BCE the red cover shows alone.
 */
import { describe, test, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { parseWatchXML } from '../xml-parser';
import { createWatchEnvironment } from '../watch-env';
import { compileExpr } from '../../expr/compile';
import { loadFaceXML, allFaceNames } from '../../__tests__/face-registry';
import type { WatchPart, StaticPart, QHandPart } from '../types';

function findAll(parts: WatchPart[], pred: (p: WatchPart) => boolean, out: WatchPart[] = []): WatchPart[] {
    for (const p of parts) {
        if (pred(p)) out.push(p);
        if (p.type === 'Static') findAll((p as StaticPart).children, pred, out);
    }
    return out;
}

const utc = (y: number, m: number, d: number): Date => {
    const t = new Date(Date.UTC(2000, m - 1, d, 12));
    t.setUTCFullYear(y);
    return t;
};

const domParser = new (new JSDOM().window.DOMParser)();
const faces = allFaceNames().filter((n) => loadFaceXML(n).includes("name='julian cover'"));

describe('julian cover', () => {
    test('six faces carry it', () => {
        expect(faces.sort()).toEqual(['Babylon', 'Basel', 'Firenze', 'Mauna Kea', 'Venezia', 'Vienna']);
    });

    for (const face of faces) {
        describe(face, () => {
            const watch = parseWatchXML(loadFaceXML(face), 'front', domParser);
            const bce = findAll(watch.parts, (p) => /^bce cover2?$/.test(p.name ?? '')) as QHandPart[];
            const jul = findAll(watch.parts, (p) => /^julian cover2?$/.test(p.name ?? '')) as QHandPart[];

            test('one green cover per red one, same geometry, daily update', () => {
                expect(jul.length).toBe(bce.length);
                expect(jul.length).toBeGreaterThan(0);
                for (let i = 0; i < bce.length; i++) {
                    for (const k of ['x', 'y', 'length', 'width', 'tail', 'modes'] as const) {
                        expect((jul[i] as unknown as Record<string, unknown>)[k])
                            .toEqual((bce[i] as unknown as Record<string, unknown>)[k]);
                    }
                    expect(jul[i].fillColor).toBe('0x6000ff00');
                    expect(jul[i].strokeColor).toBe('0x6000ff00');
                    expect(jul[i].update).toBe('1 * days()');
                }
            });

            test.each([
                ['2026-06-18 (Gregorian)', utc(2026, 6, 18), 0, 0],
                ['1582-10-15 (first Gregorian day)', utc(1582, 10, 15), 0, 0],
                ['1582-10-04 (last Julian day)', utc(1582, 10, 4), 0, Math.PI / 2],
                ['1500-06-01 (Julian CE)', utc(1500, 6, 1), 0, Math.PI / 2],
                ['44 BCE (red alone)', utc(-43, 3, 15), Math.PI / 2, 0],
            ])('%s → bce %f, julian %f', (_label, date, bceAngle, julAngle) => {
                const env = createWatchEnvironment(watch, 48.2, 16.4, () => date, 'Europe/Vienna');
                for (let i = 0; i < bce.length; i++) {
                    expect(compileExpr(bce[i].angle!)(env)).toBeCloseTo(bceAngle, 12);
                    expect(compileExpr(jul[i].angle!)(env)).toBeCloseTo(julAngle, 12);
                }
            });
        });
    }
});
