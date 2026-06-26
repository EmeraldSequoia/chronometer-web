/**
 * Smoke test for the calendarCoverOffset env function (Phase 1 of the ObsValue
 * port). Confirms it is registered and returns sane, finite offsets for a real
 * calendar face (Babylon) across a month boundary. Exact-equivalence to the
 * legacy computeCalendarCoverOffset is covered by the per-face regression suite
 * once the CalendarRowCover ObsValues are wired (Phase 2-4).
 */
import { describe, test, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { parseWatchXML } from '../xml-parser';
import { createWatchEnvironment, CALENDAR_COVER_CODES } from '../watch-env';
import { loadFaceXML } from '../../__tests__/face-registry';

describe('calendarCoverOffset env function', () => {
    const xml = loadFaceXML('Babylon');
    const domParser = new (new JSDOM().window.DOMParser)();
    const watch = parseWatchXML(xml, 'front', domParser);

    function offsetsAt(date: Date): Record<string, number> {
        const getNow = () => date;
        const env = createWatchEnvironment(watch, 37.33, -122.0, getNow, 'America/Los_Angeles');
        const fn = env.functions.get('calendarCoverOffset')!;
        const out: Record<string, number> = {};
        for (const [name, code] of Object.entries(CALENDAR_COVER_CODES)) {
            out[name] = fn(code);
        }
        return out;
    }

    test('is registered and returns finite offsets for every coverType', () => {
        const o = offsetsAt(new Date('2025-03-15T12:00:00Z'));
        expect(Object.keys(o).sort()).toEqual(['row1Left', 'row1Right', 'row56Right', 'row6Left']);
        for (const v of Object.values(o)) {
            expect(Number.isFinite(v)).toBe(true);
        }
    });

    test('offsets change across a month boundary (covers slide)', () => {
        const feb = offsetsAt(new Date('2025-02-15T12:00:00Z'));
        const mar = offsetsAt(new Date('2025-03-15T12:00:00Z'));
        // At least one cover must move when the month changes (different start col).
        const moved = Object.keys(feb).some(k => feb[k] !== mar[k]);
        expect(moved).toBe(true);
    });
});
