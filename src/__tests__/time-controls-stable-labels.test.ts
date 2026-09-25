// @vitest-environment jsdom
/**
 * The time controller's per-frame `updateTimeUI` must not replace the text
 * nodes of clickable labels when their text is unchanged. WebKit dispatches
 * `click` to the common ancestor of the mousedown and mouseup hit-test nodes,
 * text nodes included: a node swapped out between press and release drops the
 * click, which is how the CE/BCE button and the rate label came to need
 * several clicks in Safari while the clock was running (Steve, 2026-09-25).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('../shared/astro-stepper.js', () => ({ computeAstroTarget: vi.fn() }));

import { TimeController } from '../shared/time-controller.js';
import { initTimeControls, type TimeControlsAPI } from '../shared/time-controls-ui.js';
import { initAppState } from '../shared/app-state.js';

const PARTIAL = readFileSync(join(process.cwd(), 'src', 'partials', 'time-controller.html'), 'utf-8');

let tc: TimeController;
let api: TimeControlsAPI;

const el = (id: string) => document.getElementById(id)!;
const bce = (y: number, m: number, d: number): Date => {
    const t = new Date(Date.UTC(2000, m - 1, d, 12));
    t.setUTCFullYear(1 - y);
    return t;
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    localStorage.clear();
    window.history.replaceState(null, '', '/');
    initAppState({ app: 'observatory' });
    document.body.innerHTML = PARTIAL;
    tc = new TimeController();
    const maybe = initTimeControls({
        timeController: tc,
        getTimezone: () => 'America/Los_Angeles',
        getTzDeltaMs: () => 0,
        getLat: () => 37.77,
        getLon: () => -122.42,
        ensureSchedulerRunning: () => {},
    });
    if (!maybe) throw new Error('initTimeControls returned null');
    api = maybe;
    api.showPopover();
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('per-frame label writes', () => {
    test('keep the CE/BCE button, rate, offset and date text nodes while unchanged', () => {
        tc.setTime(new Date('2026-09-25T19:00:00Z'));   // stopped: the rate/offset labels are live
        api.updateTimeUI();
        const ids = ['tp-bce', 'time-bar-rate', 'time-bar-offset', 'time-bar-date', 'tp-rate-label'];
        const nodes = ids.map((id) => el(id).firstChild);
        expect(el('tp-bce').textContent).toBe('CE');
        expect(el('time-bar-rate').textContent).toBe('Stopped');
        for (let i = 0; i < 5; i++) api.updateTimeUI();
        ids.forEach((id, i) => expect(el(id).firstChild, id).toBe(nodes[i]));
    });

    test('still follow the era and the transport when they change', () => {
        tc.setTime(bce(44, 3, 15));
        api.updateTimeUI();
        expect(el('tp-bce').textContent).toBe('BCE');
        expect(el('tp-bce').classList.contains('active')).toBe(true);
        expect(el('time-bar-date').textContent).toContain('44 BCE (Julian)');
        tc.setTime(new Date('2026-09-25T19:00:00Z'));
        api.updateTimeUI();
        expect(el('tp-bce').textContent).toBe('CE');
        expect(el('tp-bce').classList.contains('active')).toBe(false);
    });

    test('clicking the button flips the era on the first click', () => {
        tc.setTime(new Date('2026-09-25T19:00:00Z'));
        api.updateTimeUI();
        el('tp-bce').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        api.updateTimeUI();
        expect(el('tp-bce').textContent).toBe('BCE');
        expect(el('time-bar-date').textContent).toContain('2026 BCE (Julian)');
    });
});
