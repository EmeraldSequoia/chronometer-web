/**
 * Frame pacer: a simulated display (vsync every `period` ms) with fake
 * timers. The startup probe must measure the display; paced frames must then
 * land on every k-th vsync, k = ⌊display ÷ 60⌋, uniformly: 60 fps on 120 and
 * 240 Hz, 72 on 144, 82.5 on 165, the display's rate on 60 and 90. Unpaced
 * frames, bursts and an uncapped target run at the display rate.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    createFramePacer, snapDisplayPeriod, probeDisplayPeriod, getDisplayPeriodMs, setDisplayPeriodMs,
    STEADY_STATE_FPS, BURST_MS, type FramePacer,
} from '../frame-pacer';

let period = 1000 / 120;
let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextRaf = 1;

/** Advance fake time in 0.25 ms steps, firing timers and, on each vsync, pending rAFs. */
function simulate(ms: number): void {
    const step = 0.25;
    for (let i = 0; i < ms / step; i++) {
        const before = Date.now();
        vi.advanceTimersByTime(step);
        const t = Date.now();
        if (Math.floor(t / period) !== Math.floor(before / period)) {
            const vsync = Math.floor(t / period) * period;
            const q = rafQueue; rafQueue = [];
            for (const { cb } of q) cb(vsync);
        }
    }
}

/** Set the simulated display and start a probe (the page-level probe installs once per module). */
function display(hz: number): void { period = 1000 / hz; probeDisplayPeriod(); }

/** A loop like the apps': draw, then ask for the next frame. Returns the frame times. */
function runLoop(p: FramePacer, paced: () => boolean, ms: number): number[] {
    const frames: number[] = [];
    const cb = (t: number) => { frames.push(t); p.request(cb, paced()); };
    p.request(cb, false);
    simulate(ms);
    return frames;
}

function rate(frames: number[], fromMs: number): number {
    const f = frames.filter((t) => t >= fromMs);
    return f.length < 2 ? 0 : (f.length - 1) * 1000 / (f[f.length - 1] - f[0]);
}

function gaps(frames: number[], fromMs: number): number[] {
    const f = frames.filter((t) => t >= fromMs);
    return f.slice(1).map((t, i) => t - f[i]);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    rafQueue = []; nextRaf = 1;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = nextRaf++; rafQueue.push({ id, cb }); return id; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { rafQueue = rafQueue.filter((r) => r.id !== id); });
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    setDisplayPeriodMs(null);
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('display probe and snapping', () => {
    test('snapping lands on the nearest plausible rate within tolerance, else keeps the measurement', () => {
        expect(1000 / snapDisplayPeriod(8.0)).toBeCloseTo(120, 6);    // 125 measured → 120
        expect(1000 / snapDisplayPeriod(8.4)).toBeCloseTo(120, 6);    // 119 → 120
        expect(1000 / snapDisplayPeriod(6.9)).toBeCloseTo(144, 6);
        expect(1000 / snapDisplayPeriod(4.2)).toBeCloseTo(240, 6);
        expect(1000 / snapDisplayPeriod(11.0)).toBeCloseTo(90, 6);
        expect(snapDisplayPeriod(12.5)).toBe(12.5);                    // 80 Hz: nothing within 6%
    });

    test('the probe measures the simulated display and snaps it', () => {
        display(120);
        simulate(200);
        expect(getDisplayPeriodMs()).toBeCloseTo(1000 / 120, 6);
    });
});

describe('frame pacer', () => {
    test('unpaced frames run at the display rate', () => {
        display(120);
        const p = createFramePacer();
        const frames = runLoop(p, () => false, 500);
        expect(rate(frames, 1100)).toBeCloseTo(120, 0);
        expect(p.lastMode).toBe('unpaced');
        expect(p.vsyncMs).toBeCloseTo(period, 6);   // the probe ran alongside
    });

    for (const [hz, expected] of [[60, 60], [90, 90], [120, 60], [144, 72], [165, 82.5], [240, 60]] as const) {
        test(`${hz} Hz display: paced at ${expected} fps, uniform`, () => {
            display(hz);
            const p = createFramePacer(STEADY_STATE_FPS);
            let paced = false;
            const frames = runLoop(p, () => paced, 300);   // the probe completes in here
            paced = true;
            simulate(2000);
            expect(rate(frames, 1500)).toBeCloseTo(expected, 1);
            for (const g of gaps(frames, 1500)) expect(g).toBeCloseTo(1000 / expected, 3);
            expect(p.lastMode).toBe('paced');
        });
    }

    test('unmeasured display: paced requests are plain rAF', () => {
        display(120);
        const p = createFramePacer();
        setDisplayPeriodMs(null);
        // Keep it unmeasured by pinning it after the probe would have run.
        let paced = true;
        const frames: number[] = [];
        const cb = (t: number) => { frames.push(t); setDisplayPeriodMs(null); p.request(cb, paced); };
        p.request(cb, false);
        simulate(500);
        expect(rate(frames, 1200)).toBeCloseTo(120, 0);
    });

    test('a burst runs at the display rate for its window, then pacing resumes', () => {
        display(120);
        const p = createFramePacer();
        let paced = false;
        const frames = runLoop(p, () => paced, 300);
        paced = true;
        simulate(500);
        p.burst();
        const burstStart = Date.now();
        simulate(BURST_MS - 100);
        expect(rate(frames.filter((t) => t >= burstStart + 50), burstStart + 50)).toBeCloseTo(120, 0);
        expect(p.lastMode).toBe('burst');
        simulate(1000);
        const after = frames.filter((t) => t >= burstStart + BURST_MS + 200);
        expect(rate(after, 0)).toBeCloseTo(60, 0);
        expect(p.lastMode).toBe('paced');
    });

    test('request replaces a pending request; cancel clears it', () => {
        display(120);
        const p = createFramePacer();
        const a = vi.fn(), b = vi.fn();
        runLoop(p, () => false, 200);
        p.request(a, true);                         // timer pending
        expect(p.pending).toBe(true);
        p.request(b, false);                        // replaces with immediate rAF
        simulate(50);
        expect(a).not.toHaveBeenCalled();
        expect(b).toHaveBeenCalledTimes(1);
        p.request(a, true);
        p.cancel();
        expect(p.pending).toBe(false);
        simulate(100);
        expect(a).not.toHaveBeenCalled();
    });

    test('a null target is uncapped; a lower target uses the same rule (10 fps on 120 Hz = every 12th vsync)', () => {
        display(120);
        const p = createFramePacer(null);
        let paced = false;
        const frames = runLoop(p, () => paced, 300);
        paced = true;
        simulate(500);
        expect(rate(frames, 1400)).toBeCloseTo(120, 0);
        p.setTargetFps(10);
        const from = Date.now() + 300;
        simulate(2300);
        expect(rate(frames.filter((t) => t >= from), from)).toBeCloseTo(10, 1);
        for (const g of gaps(frames, from)) expect(g).toBeCloseTo(100, 3);
    });
});
