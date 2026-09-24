// @vitest-environment jsdom
/**
 * The unit-first time controller (src/shared/time-controls-ui.ts,
 * docs/time-controller.md): chips choose the unit, one ◀ ▶ pair steps or
 * scrubs by it, a ‹ › body row serves rise / set / transit.
 *
 * Pinned: the chip → pair-label mapping and the body row's visibility; the
 * pair stepping a stopped clock by the unit; hold-to-scrub at the unit's
 * rate (seconds included) and its release; astro taps searching with the
 * resolved body (stored `tb`, else the page's body, else the Moon; phase is
 * always the Moon) and flashing on a miss; persistence of `tu` and `tb`
 * through app-state, and the initial unit from it.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('../shared/astro-stepper.js', () => ({
    computeAstroTarget: vi.fn(),
}));

import { TimeController, RATE_OPTIONS } from '../shared/time-controller.js';
import { initTimeControls, UNITS, CONTROLLER_BODIES, astroStepLabel, type TimeControlsAPI } from '../shared/time-controls-ui.js';
import { computeAstroTarget } from '../shared/astro-stepper.js';
import { initAppState, getState } from '../shared/app-state.js';

const PARTIAL = readFileSync(join(process.cwd(), 'src', 'partials', 'time-controller.html'), 'utf-8');
const mockedTarget = vi.mocked(computeAstroTarget);

let tc: TimeController;
let api: TimeControlsAPI;
let pageBody: number | undefined;

const chip = (key: string) => document.querySelector(`.tp-chip[data-unit="${key}"]`) as HTMLElement;
const label = () => document.getElementById('tp-step-label')!.textContent;
const bodyRow = () => document.getElementById('tp-body-row') as HTMLElement;
const bodyName = () => document.getElementById('tp-body-name')!.textContent;
const fwd = () => document.getElementById('tp-step-fwd') as HTMLElement;
const back = () => document.getElementById('tp-step-back') as HTMLElement;
const down = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
const up = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
const tap = (el: HTMLElement) => { down(el); up(el); };
const stored = (ns: string) => JSON.parse(localStorage.getItem(`ec:${ns}`) ?? 'null');

function setup(opts: { withPageBody?: boolean } = {}): void {
    document.body.innerHTML = PARTIAL;
    tc = new TimeController();
    const maybe = initTimeControls({
        timeController: tc,
        getTimezone: () => undefined,
        getTzDeltaMs: () => 0,
        getLat: () => 37.77,
        getLon: () => -122.42,
        getSelectedBody: opts.withPageBody ? () => pageBody : undefined,
        ensureSchedulerRunning: () => {},
    });
    if (!maybe) throw new Error('initTimeControls returned null');
    api = maybe;
    api.showPopover();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T12:00:00Z'));
    localStorage.clear();
    window.history.replaceState(null, '', '/');
    mockedTarget.mockReset();
    pageBody = undefined;
    initAppState({ app: 'observatory' });
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('units', () => {
    test('day is the default; the chip is active and the pair says so', () => {
        setup();
        expect(api.getUnit()).toBe('day');
        expect(chip('day').classList.contains('active')).toBe(true);
        expect(chip('day').getAttribute('aria-pressed')).toBe('true');
        expect(label()).toBe('1 day');
        expect(bodyRow().hidden).toBe(true);
        // Nothing is written until the user chooses.
        expect(stored('observatory')).toBeNull();
    });

    test('every chip has a spec, in display order, and labels the pair', () => {
        setup();
        const keys = [...document.querySelectorAll('.tp-chip')].map((c) => (c as HTMLElement).dataset.unit);
        expect(keys).toEqual(UNITS.map((u) => u.key));
        for (const u of UNITS.filter((u) => u.time)) {
            chip(u.key).click();
            expect(label()).toBe(u.label);
            expect(bodyRow().hidden).toBe(true);
        }
    });

    test('choosing a unit persists it per app and the next init starts there', () => {
        setup();
        chip('hr').click();
        expect(getState().tu).toBe('hr');
        expect(stored('observatory')).toMatchObject({ tu: 'hr' });
        setup();
        expect(api.getUnit()).toBe('hr');
        expect(label()).toBe('1 hour');
    });

    test('rise / set / transit show the body row; phase hides it and is the Moon', () => {
        setup();
        chip('rise').click();
        expect(bodyRow().hidden).toBe(false);
        expect(label()).toBe('Moonrise');
        chip('set').click();
        expect(label()).toBe('Moonset');
        chip('transit').click();
        expect(label()).toBe('Moon transit');
        chip('phase').click();
        expect(bodyRow().hidden).toBe(true);
        expect(label()).toBe('Moon phase');
    });
});

describe('the pair', () => {
    test('a tap steps a stopped clock by the unit and leaves it stopped', () => {
        setup();
        tc.stop();
        const t0 = tc.getDisplayTime().getTime();
        tap(fwd());
        expect(tc.getDisplayTime().getTime()).toBe(t0 + 86_400_000);
        expect(tc.isStopped).toBe(true);
        chip('sec').click();
        tap(back());
        expect(tc.getDisplayTime().getTime()).toBe(t0 + 86_400_000 - 1000);
        expect(getState().t).toBe(t0 + 86_400_000 - 1000);
    });

    test('a hold scrubs at the unit\'s rate (seconds included) and release stops', () => {
        setup();
        chip('sec').click();
        down(fwd());
        expect(tc.currentRate).toBeNull();
        vi.advanceTimersByTime(300);
        expect(tc.currentRate).toBe(RATE_OPTIONS[0]);          // 10×
        expect(tc.currentDirection).toBe(1);
        expect(document.getElementById('time-popover')!.classList.contains('tp-hidden')).toBe(true);
        up(fwd());
        expect(tc.isStopped).toBe(true);
        expect(document.getElementById('time-popover')!.classList.contains('tp-hidden')).toBe(false);

        chip('yr').click();
        down(back());
        vi.advanceTimersByTime(300);
        expect(tc.currentRate).toBe(RATE_OPTIONS[5]);          // 10 yr/s
        expect(tc.currentDirection).toBe(-1);
        up(back());
    });

    test('a quick tap never starts a scrub', () => {
        setup();
        down(fwd());
        vi.advanceTimersByTime(100);
        up(fwd());
        vi.advanceTimersByTime(500);
        expect(tc.currentRate).toBeNull();
    });
});

describe('astro units and the body', () => {
    test('a tap searches with the Moon by default, jumps there, and stops', () => {
        setup();
        const target = new Date('2026-09-24T02:30:00Z');
        mockedTarget.mockReturnValue(target);
        chip('rise').click();
        tap(fwd());
        expect(mockedTarget).toHaveBeenCalledTimes(1);
        const [eventType, dir, , lat, lon, planet] = mockedTarget.mock.calls[0];
        expect(eventType).toBe('body-rise');
        expect(dir).toBe(1);
        expect(lat).toBeCloseTo(37.77 * Math.PI / 180, 9);
        expect(lon).toBeCloseTo(-122.42 * Math.PI / 180, 9);
        expect(planet).toBe(1);
        expect(tc.getDisplayTime().getTime()).toBe(target.getTime());
        expect(tc.isStopped).toBe(true);
        // A hold on an astro unit is a tap: no scrub.
        vi.advanceTimersByTime(400);
        expect(tc.currentRate).toBeNull();
    });

    test('the body row cycles the bodies, relabels the pair, and persists tb', () => {
        setup();
        chip('transit').click();
        (document.getElementById('tp-body-next') as HTMLElement).click();
        expect(bodyName()).toBe('Mercury');
        expect(label()).toBe('Mercury transit');
        expect(getState().tb).toBe('mercury');
        (document.getElementById('tp-body-prev') as HTMLElement).click();
        (document.getElementById('tp-body-prev') as HTMLElement).click();
        expect(bodyName()).toBe('Sun');
        expect(label()).toBe('Sun transit');
        chip('set').click();
        expect(label()).toBe('Sunset');
        mockedTarget.mockReturnValue(new Date('2026-09-23T19:00:00Z'));
        tap(back());
        expect(mockedTarget.mock.calls[0][0]).toBe('body-set');
        expect(mockedTarget.mock.calls[0][5]).toBe(0);
        // Wraps around the far end.
        for (let i = 0; i < CONTROLLER_BODIES.length; i++) (document.getElementById('tp-body-prev') as HTMLElement).click();
        expect(bodyName()).toBe('Sun');
    });

    test('the page\'s body is the default and is followed until the user picks one', () => {
        pageBody = 6;   // Jupiter (Venezia's default)
        setup({ withPageBody: true });
        chip('rise').click();
        expect(bodyName()).toBe('Jupiter');
        expect(label()).toBe('Jupiter rise');
        pageBody = 5;   // the face switches to Mars: the controller follows
        api.updateTimeUI();
        expect(label()).toBe('Mars rise');
        mockedTarget.mockReturnValue(new Date('2026-09-24T00:00:00Z'));
        tap(fwd());
        expect(mockedTarget.mock.calls[0][5]).toBe(5);
        // The user picks: decoupled from here on.
        (document.getElementById('tp-body-next') as HTMLElement).click();
        expect(bodyName()).toBe('Jupiter');
        pageBody = 0;
        api.updateTimeUI();
        expect(bodyName()).toBe('Jupiter');
        expect(getState().tb).toBe('jupiter');
    });

    test('a stored tb wins over the page body; phase still uses the Moon', () => {
        localStorage.setItem('ec:observatory', JSON.stringify({ tb: 'saturn', tu: 'transit', v: 1 }));
        pageBody = 0;
        setup({ withPageBody: true });
        expect(api.getUnit()).toBe('transit');
        expect(label()).toBe('Saturn transit');
        expect(api.getBody().planet).toBe(7);
        chip('phase').click();
        mockedTarget.mockReturnValue(new Date('2026-09-30T00:00:00Z'));
        tap(fwd());
        expect(mockedTarget.mock.calls[0][0]).toBe('moonphase');
    });

    test('no event flashes the button and leaves time alone', () => {
        setup();
        mockedTarget.mockReturnValue(null);
        chip('rise').click();
        tap(fwd());
        expect(fwd().classList.contains('flash-fail')).toBe(true);
        vi.advanceTimersByTime(300);
        expect(fwd().classList.contains('flash-fail')).toBe(false);
        // The clock was not touched: still live real time, not stopped.
        expect(tc.isStopped).toBe(false);
        expect(tc.isRealTime).toBe(true);
    });

    test('astroStepLabel spells the Sun and Moon events as one word', () => {
        const sun = CONTROLLER_BODIES[0], moon = CONTROLLER_BODIES[1], mars = CONTROLLER_BODIES[4];
        expect(astroStepLabel('rise', sun)).toBe('Sunrise');
        expect(astroStepLabel('set', moon)).toBe('Moonset');
        expect(astroStepLabel('transit', sun)).toBe('Sun transit');
        expect(astroStepLabel('rise', mars)).toBe('Mars rise');
        expect(astroStepLabel('phase', mars)).toBe('Moon phase');
    });
});
