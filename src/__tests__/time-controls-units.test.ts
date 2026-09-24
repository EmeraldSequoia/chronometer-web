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
 *
 * Also pinned (planning/2026-09-24-time-controller-two-stories.md): the panel
 * fades only while a scrub runs, never on a tap; a release at the display's
 * edge keeps the scrub running hands-free until the next press anywhere,
 * which is swallowed, with the padlock shown while the held pointer is in
 * that zone and kept up afterwards; Escape stops a hands-free scrub, and closes
 * the popover last — only when the page's `escapeYields` says nothing else is
 * up; hiding the popover mid-scrub stops the scrub.
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
const pop = () => document.getElementById('time-popover') as HTMLElement;
const faded = () => pop().classList.contains('tp-hidden');
const inZone = () => pop().classList.contains('tp-lock-zone');
const locked = () => pop().classList.contains('tp-locked');

/** The pair's buttons on jsdom's 1024×768 viewport: ▶ at the bottom-right, 12 px from the edge (the Observatory's placement). */
function placeButtons(): void {
    const rect = (l: number, t: number) => () =>
        ({ left: l, top: t, right: l + 56, bottom: t + 56, width: 56, height: 56, x: l, y: t, toJSON: () => ({}) }) as DOMRect;
    fwd().getBoundingClientRect = rect(956, 600);
    back().getBoundingClientRect = rect(760, 600);
}
const centre = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
const ptr = (type: string, el: HTMLElement, x: number, y: number, pointerId = 1) => {
    const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, clientX: x, clientY: y });
    el.dispatchEvent(e);
    return e;
};
/** Press / release at the button's centre unless a point is given. */
const down = (el: HTMLElement, x?: number, y?: number) => { const c = centre(el); return ptr('pointerdown', el, x ?? c.x, y ?? c.y); };
const up = (el: HTMLElement, x?: number, y?: number) => { const c = centre(el); return ptr('pointerup', el, x ?? c.x, y ?? c.y); };
const tap = (el: HTMLElement) => { down(el); up(el); };
const key = (k: string) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    return e;
};
const stored = (ns: string) => JSON.parse(localStorage.getItem(`ec:${ns}`) ?? 'null');

function setup(opts: { withPageBody?: boolean; escapeYields?: () => boolean } = {}): void {
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
        escapeYields: opts.escapeYields,
    });
    if (!maybe) throw new Error('initTimeControls returned null');
    api = maybe;
    api.showPopover();
    placeButtons();
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
    // A test may end with a hands-free scrub running, whose stop listener sits
    // on the document: press once to release it (and let its click swallower
    // disarm) so it cannot swallow the next test's first press.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 9 }));
    vi.advanceTimersByTime(1000);
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

// ---------------------------------------------------------------------------
// The scrub fade and hands-free scrubbing
// ---------------------------------------------------------------------------

describe('the scrub fade: only while a scrub runs', () => {
    test('taps never fade the panel: step, astro jump, transport, Now, chips', () => {
        setup();
        tap(fwd());                                    // a step
        expect(faded()).toBe(false);
        vi.advanceTimersByTime(300);
        expect(faded()).toBe(false);                   // and no hold from a tap
        chip('rise').click();
        mockedTarget.mockReturnValue(new Date('2026-09-24T06:00:00Z'));
        tap(fwd());                                    // an astro jump
        expect(faded()).toBe(false);
        chip('day').click();
        expect(faded()).toBe(false);
        // Transport: the clock is stopped, so ◀ ▶ render; press ▶ (1×), then Now.
        const transport = () => [...document.querySelectorAll('#tp-transport .tp-btn')] as HTMLElement[];
        const play = transport().find((b) => b.textContent?.trim() === '▶')!;
        play.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        expect(tc.isStopped).toBe(false);
        expect(faded()).toBe(false);
        const now = transport().find((b) => b.textContent?.startsWith('Now'))!;
        now.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        expect(tc.isRealTime).toBe(true);
        expect(faded()).toBe(false);
        expect(locked()).toBe(false);
    });

    test('a hold fades the panel when it engages, not at the press; a release on the button restores', () => {
        setup();
        down(fwd());
        expect(faded()).toBe(false);
        vi.advanceTimersByTime(299);
        expect(faded()).toBe(false);
        vi.advanceTimersByTime(1);
        expect(faded()).toBe(true);
        expect(fwd().classList.contains('holding')).toBe(true);
        up(fwd());
        expect(faded()).toBe(false);
        expect(tc.isStopped).toBe(true);
        expect(fwd().classList.contains('holding')).toBe(false);
    });

    test('a release off the button but on the display stops the scrub', () => {
        setup();
        down(fwd());
        vi.advanceTimersByTime(300);
        up(fwd(), 500, 300);
        expect(tc.isStopped).toBe(true);
        expect(faded()).toBe(false);
        expect(locked()).toBe(false);
    });

    test('hiding the popover mid-hold stops the scrub and leaves nothing faded', () => {
        setup();
        down(fwd());
        vi.advanceTimersByTime(300);
        expect(tc.currentRate).toBe(RATE_OPTIONS[3]);
        api.hidePopover();
        expect(tc.isStopped).toBe(true);
        expect(faded()).toBe(false);
        up(fwd());                                     // the late release changes nothing
        expect(tc.isStopped).toBe(true);
        api.showPopover();
        expect(faded()).toBe(false);
    });

    test('a second pointer while one is down is ignored', () => {
        setup();
        down(fwd());
        ptr('pointerdown', back(), 788, 628, 2);
        vi.advanceTimersByTime(300);
        expect(tc.currentDirection).toBe(1);
        expect(back().classList.contains('holding')).toBe(false);
        ptr('pointerup', back(), 788, 628, 2);
        expect(tc.isStopped).toBe(false);              // the second finger's lift is not the release
        up(fwd());
        expect(tc.isStopped).toBe(true);
    });

    test('a cancelled pointer after the hold engaged stops', () => {
        setup();
        down(fwd());
        vi.advanceTimersByTime(300);
        ptr('pointercancel', fwd(), 984, 628);
        expect(tc.isStopped).toBe(true);
        expect(faded()).toBe(false);
    });
});

describe('hands-free scrubbing: a release at the display edge', () => {
    /** Press ▶, let the hold engage, slide to the right edge and lift there. */
    function lockForward(): void {
        down(fwd());
        vi.advanceTimersByTime(300);
        up(fwd(), 1022, 640);
    }
    const pressElsewhere = () => {
        const e = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 3, clientX: 300, clientY: 300 });
        document.body.dispatchEvent(e);
        return e;
    };

    test('the lock zone shows while the held pointer is where a release would lock, and clears when it leaves', () => {
        setup();
        down(fwd());
        ptr('pointermove', fwd(), 1022, 640);              // at the edge before the hold engages: nothing yet
        expect(inZone()).toBe(false);
        vi.advanceTimersByTime(300);
        expect(inZone()).toBe(true);                       // the hold engaged with the pointer already there
        ptr('pointermove', fwd(), 500, 300);               // back onto the display
        expect(inZone()).toBe(false);
        expect(faded()).toBe(true);
        ptr('pointermove', fwd(), -20, 300);               // out of the window (a mouse)
        expect(inZone()).toBe(true);
        ptr('pointermove', fwd(), 984, 628);               // back on the button
        expect(inZone()).toBe(false);
        up(fwd());
        expect(tc.isStopped).toBe(true);
        expect(inZone()).toBe(false);
        expect(locked()).toBe(false);
    });

    test('keeps the scrub running, keeps the padlock up at the scrub level, and drops the holding highlight', () => {
        setup();
        down(fwd());
        vi.advanceTimersByTime(300);
        ptr('pointermove', fwd(), 1022, 640);
        expect(inZone()).toBe(true);
        up(fwd(), 1022, 640);
        expect(tc.isStopped).toBe(false);
        expect(tc.currentRate).toBe(RATE_OPTIONS[3]);
        expect(faded()).toBe(true);                        // the scrub level again …
        expect(inZone()).toBe(false);
        expect(locked()).toBe(true);                       // … with the padlock still showing
        expect(fwd().classList.contains('holding')).toBe(false);
    });

    test('a release past the window edge (a mouse dragged out) locks too; a lift on the button never does', () => {
        setup();
        down(fwd());
        vi.advanceTimersByTime(300);
        up(fwd(), -40, 300);
        expect(tc.isStopped).toBe(false);
        expect(tc.currentRate).toBe(RATE_OPTIONS[3]);
        expect(locked()).toBe(true);
        pressElsewhere();
        expect(tc.isStopped).toBe(true);
        down(fwd());
        vi.advanceTimersByTime(300);
        up(fwd(), 1011, 655);                          // on the button, 13 px from the edge
        expect(tc.isStopped).toBe(true);
        expect(locked()).toBe(false);
    });

    test('the next press anywhere stops it and is swallowed, with the click that follows', () => {
        setup();
        lockForward();
        const reached = vi.fn();
        document.body.addEventListener('pointerdown', reached);
        document.body.addEventListener('click', reached);
        const press = pressElsewhere();
        expect(tc.isStopped).toBe(true);
        expect(press.defaultPrevented).toBe(true);
        expect(faded()).toBe(false);
        expect(locked()).toBe(false);
        expect(api.isPopoverOpen()).toBe(true);
        expect(getState().dir).toBe(0);                // state written at the stop
        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        document.body.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(true);
        expect(reached).not.toHaveBeenCalled();
        // The swallower is one-shot: the click after that goes through.
        const next = new MouseEvent('click', { bubbles: true, cancelable: true });
        document.body.dispatchEvent(next);
        expect(next.defaultPrevented).toBe(false);
        expect(reached).toHaveBeenCalledTimes(1);
    });

    test('a swallower that sees no click disarms itself', () => {
        setup();
        lockForward();
        pressElsewhere();
        vi.advanceTimersByTime(500);
        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        document.body.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(false);
    });

    test('Escape stops it and keeps the panel; a hidden tab stops it too', () => {
        setup({ escapeYields: () => false });
        lockForward();
        const esc = key('Escape');
        expect(tc.isStopped).toBe(true);
        expect(esc.defaultPrevented).toBe(true);
        expect(api.isPopoverOpen()).toBe(true);
        lockForward();
        expect(tc.isStopped).toBe(false);
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        try {
            document.dispatchEvent(new Event('visibilitychange'));
            expect(tc.isStopped).toBe(true);
        } finally {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        }
    });
});

describe('Escape closes the popover last', () => {
    test('closes when nothing else is up, yields while something is, and is inert once closed', () => {
        let busy = false;
        setup({ escapeYields: () => busy });
        busy = true;
        let esc = key('Escape');
        expect(api.isPopoverOpen()).toBe(true);
        expect(esc.defaultPrevented).toBe(false);
        busy = false;
        esc = key('Escape');
        expect(api.isPopoverOpen()).toBe(false);
        expect(esc.defaultPrevented).toBe(true);
        esc = key('Escape');
        expect(api.isPopoverOpen()).toBe(false);
        expect(esc.defaultPrevented).toBe(false);
    });

    test('a focused date input gives up focus first; the next Escape closes', () => {
        setup({ escapeYields: () => false });
        const hour = document.getElementById('tp-hour') as HTMLInputElement;
        hour.focus();
        expect(document.activeElement).toBe(hour);
        key('Escape');
        expect(document.activeElement).not.toBe(hour);
        expect(api.isPopoverOpen()).toBe(true);
        key('Escape');
        expect(api.isPopoverOpen()).toBe(false);
    });

    test('without the hook, Escape leaves the popover alone (the page runs its own ladder)', () => {
        setup();
        const esc = key('Escape');
        expect(api.isPopoverOpen()).toBe(true);
        expect(esc.defaultPrevented).toBe(false);
    });
});
