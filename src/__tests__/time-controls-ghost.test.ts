// @vitest-environment jsdom
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TimeController } from '../shared/time-controller.js';
import { initTimeControls, type TimeControlsAPI } from '../shared/time-controls-ui.js';

// Tap-ghost lifecycle (phase 2 of the scrub-invisibility plan): any actuating
// tap adds .tp-ghost; a 1 s dwell restores it — except step taps, which wait
// for the app's animations to settle (bounded by a 4 s cap). Scrub holds use
// .tp-hidden, added at hold start and removed at release.

const PARTIAL = readFileSync(
    join(process.cwd(), 'src', 'partials', 'time-controller.html'),
    'utf-8',
);

let tc: TimeController;
let api: TimeControlsAPI;
let settled: boolean;
let pop: HTMLElement;

const ghost = () => pop.classList.contains('tp-ghost');
const hidden = () => pop.classList.contains('tp-hidden');
const stepBtn = () => document.querySelector('[data-step="+day"]') as HTMLElement;
const down = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
const up = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
const tap = (el: HTMLElement) => { down(el); up(el); };

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));
    localStorage.clear();
    window.history.replaceState(null, '', '/');
    document.body.innerHTML = PARTIAL;
    tc = new TimeController();
    settled = true;
    const maybeApi = initTimeControls({
        timeController: tc,
        getTimezone: () => undefined,
        getTzDeltaMs: () => 0,
        getLat: () => 0,
        getLon: () => 0,
        ensureSchedulerRunning: () => {},
        isSettled: () => settled,
    });
    if (!maybeApi) throw new Error('initTimeControls returned null');
    api = maybeApi;
    pop = document.getElementById('time-popover')!;
    api.showPopover();
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('tap ghost', () => {
    test('step tap ghosts immediately and restores after the dwell when settled', () => {
        tap(stepBtn());
        expect(ghost()).toBe(true);
        vi.advanceTimersByTime(999);
        expect(ghost()).toBe(true);
        vi.advanceTimersByTime(1);
        expect(ghost()).toBe(false);
    });

    test('step tap holds the ghost past the dwell until animations settle', () => {
        settled = false;
        tap(stepBtn());
        vi.advanceTimersByTime(1000);
        expect(ghost()).toBe(true);      // dwell expired but not settled
        vi.advanceTimersByTime(600);
        expect(ghost()).toBe(true);      // still polling
        settled = true;
        vi.advanceTimersByTime(200);     // next poll sees settled
        expect(ghost()).toBe(false);
    });

    test('a never-settling probe is bounded by the cap', () => {
        settled = false;
        tap(stepBtn());
        vi.advanceTimersByTime(3900);    // dwell + polls, still inside cap
        expect(ghost()).toBe(true);
        vi.advanceTimersByTime(400);     // past the 4 s deadline
        expect(ghost()).toBe(false);
    });

    test('repeated taps re-arm the dwell', () => {
        tap(stepBtn());
        vi.advanceTimersByTime(600);
        tap(stepBtn());
        vi.advanceTimersByTime(600);
        expect(ghost()).toBe(true);      // 1200 ms after first tap, re-armed
        vi.advanceTimersByTime(400);
        expect(ghost()).toBe(false);     // 1000 ms after second tap
    });

    test('transport tap uses the plain dwell even when unsettled', () => {
        settled = false;
        // Real-time running → transport renders the pause button only.
        const pause = [...document.querySelectorAll('#tp-transport .tp-btn')]
            .find(b => b.textContent?.trim() === '‖') as HTMLElement;
        expect(pause).toBeTruthy();
        pause.click();
        expect(ghost()).toBe(true);
        vi.advanceTimersByTime(1000);
        expect(ghost()).toBe(false);     // no settle wait on transport taps
    });

    test('tab switches and date-input changes do not ghost', () => {
        (document.querySelector('.tp-tab[data-tab="astro"]') as HTMLElement).click();
        expect(ghost()).toBe(false);
        const hour = document.getElementById('tp-hour') as HTMLInputElement;
        hour.value = '6';
        hour.dispatchEvent(new Event('change', { bubbles: true }));
        expect(ghost()).toBe(false);
    });
});

describe('scrub ghost composition', () => {
    test('hold engages .tp-hidden after the delay; release restores; tap ghost expires independently', () => {
        settled = false;
        down(stepBtn());
        expect(ghost()).toBe(true);
        expect(hidden()).toBe(false);
        vi.advanceTimersByTime(300);     // hold delay
        expect(hidden()).toBe(true);
        vi.advanceTimersByTime(3900);    // tap ghost hits its cap mid-hold
        expect(ghost()).toBe(false);
        expect(hidden()).toBe(true);     // scrub ghost persists
        up(stepBtn());
        expect(hidden()).toBe(false);
    });

    test('release restores immediately — the initiating tap ghost is cleared too', () => {
        settled = false;
        down(stepBtn());
        vi.advanceTimersByTime(600);     // hold engaged; tap ghost still active
        expect(ghost()).toBe(true);
        expect(hidden()).toBe(true);
        up(stepBtn());
        expect(ghost()).toBe(false);
        expect(hidden()).toBe(false);
        vi.advanceTimersByTime(5000);    // and no orphaned timer resurrects it
        expect(ghost()).toBe(false);
    });

    test('showPopover clears stale ghost classes', () => {
        pop.classList.add('tp-hidden', 'tp-ghost');
        api.hidePopover();
        api.showPopover();
        expect(hidden()).toBe(false);
        expect(ghost()).toBe(false);
    });
});
