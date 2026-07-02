/**
 * DST-crossing scrub under the per-tick rebuild guard.
 *
 * rebuildEnvironments() (engine-entry.ts) no longer rebuilds every face env on
 * every scrub tick; it skips the rebuild when the env's captured state is fresh
 * (envTzStateStale + env.captureStale) and just invalidates the astro cache
 * pool. These tests replicate the engine's exact per-tick sequence — checkTick,
 * then the guard, then evaluation at the new display time — and scrub a Geneva
 * env across the US 2026 DST transitions in 1-day ticks, verifying the
 * behaviors from Carl LaCombe's DST bug reports (#7–#9) survive the guard:
 *
 *  - #7  Geneva DST indicator: DSTNumber() must flip exactly at the transition.
 *  - #8  Wall-clock hands: hour24Value() must jump by the transition hour
 *        (12:00 PST → 13:00 PDT for the same 20:00 UTC display time).
 *  - #9  Rise/set: sunrise/sunset indicator angles must match a from-scratch
 *        environment at every tick (a fresh env is by definition what the
 *        engine built on every tick before the guard existed).
 *  - #10 (location tz persistence on page load) is a page-load path — the guard
 *        only affects the per-tick onTick path, and location changes still go
 *        through the unconditional rebuildAllForLocation — out of scope here.
 *
 * Each test also asserts env object identity per tick: kept (skip) on
 * non-crossing ticks, replaced (rebuild) exactly on the crossing tick. This
 * proves the assertions exercise the guard's skip path — if the guard rebuilt
 * every tick, the fresh-env equivalence checks would pass vacuously.
 *
 * (The TestBench isn't used here: its scrubTick snapshots the frame before
 * checkTick, so bench evaluation runs one snapshot behind the engine's order.
 * The golden regression suite covers the bench wiring; this file covers the
 * engine-order guard semantics.)
 */
import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { JSDOM } from 'jsdom';

import { loadFaceXML, TEST_LOCATIONS } from './face-registry.js';
import { parseWatchXML } from '../watch/xml-parser.js';
import { createWatchEnvironment } from '../watch/watch-env.js';
import { buildHandValues } from '../watch/hand-values.js';
import { envTzStateStale } from '../shared/astro-env.js';
import {
    type Updater, type WithDisplayTime, makeOverridableGetNow, timingContextForFrame,
} from '../shared/updater.js';
import type { Environment } from '../expr/env.js';
import type { Watch } from '../watch/types.js';
import { TimeController, RATE_OPTIONS, TICK_INTERVAL_MS, type TimeUnit } from '../shared/time-controller.js';

const CUPERTINO = TEST_LOCATIONS[0];  // America/Los_Angeles

/** Env functions compared tick-by-tick against a fresh environment. */
const COMPARED_FNS: Array<{ name: string; args: number[] }> = [
    { name: 'DSTNumber', args: [] },                              // #7
    { name: 'hour24Value', args: [] },                            // #8
    { name: 'minuteValueAngle', args: [] },                       // #8
    { name: 'tzOffset', args: [] },                               // the captured offset itself
    { name: 'dayNumber', args: [] },                              // calendar via captured offset
    { name: 'sunrise24HourIndicatorAngle', args: [] },            // #9
    { name: 'sunset24HourIndicatorAngle', args: [] },             // #9
    { name: 'moonDeltaEclipticLongitudeAtDeltaDay', args: [0] },  // tzDeltaMs consumer
];

function callFn(env: Environment, name: string, args: number[]): number {
    const fn = env.functions.get(name);
    expect(fn, `env function "${name}" must exist`).toBeDefined();
    return fn!(...args);
}

/** Engine-order scrub driver: checkTick → guard → evaluate at the new time. */
class GuardedScrub {
    readonly watch: Watch;
    readonly tc = new TimeController();
    env: Environment;
    /** Set by useUpdater(): the face's real ObsValue updater, ticked like the engine. */
    updater: Updater | null = null;
    private readonly getNow: () => Date;
    private readonly withDisplayTime: WithDisplayTime;
    private perfMs = 0;

    constructor(faceName: string, start: Date) {
        const dom = new JSDOM('', { contentType: 'text/html' });
        this.watch = parseWatchXML(loadFaceXML(faceName), 'front', new dom.window.DOMParser());
        this.tc.setTime(start);
        const seam = makeOverridableGetNow(() => this.tc.getDisplayTime());
        this.getNow = seam.getNow;
        this.withDisplayTime = seam.withDisplayTime;
        this.env = this.buildEnv();
    }

    private buildEnv(): Environment {
        return createWatchEnvironment(
            this.watch, CUPERTINO.lat, CUPERTINO.lon,
            this.getNow, CUPERTINO.olsonTimezone,
        );
    }

    /** Build the face's real hand ObsValues (engine's buildHandValues wiring). */
    useUpdater(): void {
        this.updater = buildHandValues(this.watch.name, this.watch, this.env, this.perfMs);
    }

    /** Run one engine-style animation frame (no tick check): updater only. */
    frame(deltaMs = 17): void {
        this.perfMs += deltaMs;
        this.tc.beginFrame();
        this.updater!.tick(this.env, this.perfMs, this.getNow, this.withDisplayTime,
            timingContextForFrame(this.tc));
        this.tc.endFrame();
    }

    start(unit: TimeUnit, direction: 1 | -1): void {
        this.tc.setDirection(direction);
        this.tc.setRate(RATE_OPTIONS.find(r => r.unit === unit)!);
        // Drive checkTick's clock with integers. setRate seeds lastTickRealMs from
        // the real performance.now(); adding 100 to that float can compare as
        // `(x+100) - x >= 100` → false for some bit patterns of x, silently losing
        // a tick (nondeterministically across runs). Integer arithmetic is exact.
        this.tc.lastTickRealMs = 0;
        this.perfMs = 0;
    }

    /**
     * One scrub tick with the engine's guard (rebuildEnvironments semantics),
     * including the engine's schedule reset when the tz offset changed at the
     * crossing. When useUpdater() was called, also runs the frame's updater tick
     * (engine order: checkTick → rebuild/reset → beginFrame → updater.tick).
     * Returns true if the env was rebuilt, false if the guard skipped.
     */
    tick(): boolean {
        this.perfMs += TICK_INTERVAL_MS;
        this.tc.checkTick(this.perfMs);
        let rebuilt = false;
        if (envTzStateStale(this.env, CUPERTINO.olsonTimezone) || this.env.captureStale?.()) {
            const oldTzOffset = this.env.tzOffsetSec;
            this.env = this.buildEnv();
            rebuilt = true;
            // Engine parity (rebuildEnvironments): a tz-offset change resets all
            // value schedules so hands re-evaluate immediately at the new offset.
            if (this.updater && this.env.tzOffsetSec !== oldTzOffset) {
                this.updater.reset();
            }
        } else {
            this.env.invalidateAstroCaches?.();
        }
        if (this.updater) {
            this.tc.beginFrame();
            this.updater.tick(this.env, this.perfMs, this.getNow, this.withDisplayTime,
                timingContextForFrame(this.tc));
            this.tc.endFrame();
        }
        return rebuilt;
    }

    /** A from-scratch env at the current display time — the pre-guard behavior. */
    freshEnv(): Environment {
        const displayMs = this.tc.getDisplayTime().getTime();
        return createWatchEnvironment(
            this.watch, CUPERTINO.lat, CUPERTINO.lon,
            () => new Date(displayMs), CUPERTINO.olsonTimezone,
        );
    }
}

/** Scrub `ticks` ticks; record rebuilds, compare vs fresh env, sample values. */
function scrubAndCheck(scrub: GuardedScrub, unit: TimeUnit, direction: 1 | -1, ticks: number) {
    const rebuilt: boolean[] = [];
    const samples: Record<string, number[]> = {};
    for (const { name } of COMPARED_FNS) samples[name] = [];

    scrub.start(unit, direction);
    for (let i = 0; i < ticks; i++) {
        rebuilt.push(scrub.tick());
        const fresh = scrub.freshEnv();
        for (const { name, args } of COMPARED_FNS) {
            const guarded = callFn(scrub.env, name, args);
            const reference = callFn(fresh, name, args);
            expect(guarded, `tick ${i + 1}: ${name} (guarded env vs fresh env)`)
                .toBeCloseTo(reference, 9);
            samples[name].push(guarded);
        }
    }
    return { rebuilt, samples };
}

describe('DST-crossing scrub with the rebuild guard (Carl LaCombe bugs #7–#9)', () => {
    // Pin Date.now: TimeController's reverse-1× anchor (_setupReverseOneX, used
    // transiently by setDirection(-1) before setRate) reads the REAL clock, and a
    // millisecond elapsing between its two Date.now() calls would put a …59.999
    // fraction on every backward-scrub display time — nondeterministic input to
    // tzOffsetSecondsAt. A constant clock makes all display times exact.
    beforeAll(() => { vi.spyOn(Date, 'now').mockReturnValue(1_750_000_000_000); });
    afterAll(() => { vi.restoreAllMocks(); });

    test('spring forward (2026-03-08, PST→PDT): rebuild fires exactly at the crossing; indicator, hands, rise/set stay correct', () => {
        // 20:00 UTC = 12:00 PST. Ticks land on Mar 6, 7, 8, 9, 10 at 20:00 UTC;
        // the transition is Mar 8 02:00 PST = 10:00 UTC, so the Mar 8 tick is the
        // first one on the PDT side.
        const scrub = new GuardedScrub('Geneva', new Date('2026-03-05T20:00:00Z'));
        const { rebuilt, samples } = scrubAndCheck(scrub, 'day', 1, 5);

        // Guard behavior: skip, skip, rebuild (crossing), skip, skip.
        expect(rebuilt).toEqual([false, false, true, false, false]);

        // #7 — DST indicator flips exactly at the transition.
        expect(samples['DSTNumber']).toEqual([0, 0, 1, 1, 1]);

        // #8 — wall-clock hour jumps with the offset (12:00 PST → 13:00 PDT).
        expect(samples['hour24Value']).toEqual([12, 12, 13, 13, 13]);

        // The captured offset itself: -8h standard, -7h daylight.
        expect(samples['tzOffset']).toEqual([-28800, -28800, -25200, -25200, -25200]);
    });

    test('fall back (2026-11-01, PDT→PST): rebuild fires exactly at the crossing; indicator, hands, rise/set stay correct', () => {
        // 19:00 UTC = 12:00 PDT. Ticks land on Oct 30, 31, Nov 1, 2, 3 at 19:00 UTC;
        // the transition is Nov 1 02:00 PDT = 09:00 UTC, so the Nov 1 tick is the
        // first one on the PST side.
        const scrub = new GuardedScrub('Geneva', new Date('2026-10-29T19:00:00Z'));
        const { rebuilt, samples } = scrubAndCheck(scrub, 'day', 1, 5);

        expect(rebuilt).toEqual([false, false, true, false, false]);
        expect(samples['DSTNumber']).toEqual([1, 1, 0, 0, 0]);
        // 12:00 PDT → 11:00 PST at the same 19:00 UTC.
        expect(samples['hour24Value']).toEqual([12, 12, 11, 11, 11]);
        expect(samples['tzOffset']).toEqual([-25200, -25200, -28800, -28800, -28800]);
    });

    test('backward scrub across spring forward (PDT→PST): rebuild fires exactly at the crossing', () => {
        // Start Mar 10 20:00 UTC (13:00 PDT) and scrub backward by days:
        // Mar 9 (PDT), Mar 8 20:00Z (still PDT — after the 10:00Z transition),
        // Mar 7 (PST — crossing), Mar 6 (PST).
        const scrub = new GuardedScrub('Geneva', new Date('2026-03-10T20:00:00Z'));
        const { rebuilt, samples } = scrubAndCheck(scrub, 'day', -1, 4);

        expect(rebuilt).toEqual([false, false, true, false]);
        expect(samples['DSTNumber']).toEqual([1, 1, 0, 0]);
        expect(samples['hour24Value']).toEqual([13, 13, 12, 12]);
    });

    test('DST indicator hand (updateAtEnvChangeOnly) re-evaluates DURING the scrub at the crossing, not on release', () => {
        // Regression for the frozen-indicator bug: env-change-only on-beat values
        // have an Infinity boundary, so the crossing-tick reset() used to be
        // swallowed by onBeatStep's scrub exclusion — the Geneva DST hand stayed
        // put until mouse-up. Angle expr: `DSTNumber() ? pi*7/4 : pi/4`.
        const scrub = new GuardedScrub('Geneva', new Date('2026-03-05T20:00:00Z'));
        scrub.useUpdater();
        const dstHand = scrub.updater!.all.find(v => v.name.includes('DST hand'))!;
        expect(dstHand, 'DST hand ObsValue must exist').toBeDefined();

        const TWO_PI = 2 * Math.PI;
        const norm = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

        scrub.start('day', 1);
        const targets: number[] = [];
        for (let i = 0; i < 5; i++) {
            scrub.tick();
            // A few animation frames after the tick, as the engine would render.
            scrub.frame(); scrub.frame(); scrub.frame();
            targets.push(norm(dstHand.anim.targetValue));
        }

        // Ticks land Mar 6, 7 (standard: π/4), then Mar 8, 9, 10 (DST: 7π/4).
        // The flip must happen AT the crossing tick, while still scrubbing.
        const QUARTER = Math.PI / 4, SEVEN_QUARTER = 7 * Math.PI / 4;
        expect(targets[0]).toBeCloseTo(QUARTER, 9);
        expect(targets[1]).toBeCloseTo(QUARTER, 9);
        expect(targets[2]).toBeCloseTo(SEVEN_QUARTER, 9);
        expect(targets[3]).toBeCloseTo(SEVEN_QUARTER, 9);
        expect(targets[4]).toBeCloseTo(SEVEN_QUARTER, 9);

        // And the hand physically arrives at the DST position while the scrub is
        // still running (animSpeed 3 → 6 rad/s; π distance ≈ 0.5 s of frames).
        for (let f = 0; f < 40; f++) scrub.frame();
        expect(norm(dstHand.currentValue)).toBeCloseTo(SEVEN_QUARTER, 6);
    });

    test('hour-rate scrub through the spring-forward instant: offset flips within the day', () => {
        // 1-hour ticks from 07:00 UTC on Mar 8 2026: 08:00, 09:00 (PST, 00:00/01:00
        // local), 10:00 (the transition instant — PDT begins), 11:00, 12:00.
        const scrub = new GuardedScrub('Geneva', new Date('2026-03-08T07:00:00Z'));
        const { rebuilt, samples } = scrubAndCheck(scrub, 'hour', 1, 5);

        expect(rebuilt).toEqual([false, false, true, false, false]);
        expect(samples['DSTNumber']).toEqual([0, 0, 1, 1, 1]);
        // Local wall clock: 00:00, 01:00, then the skipped hour lands on 03:00, 04:00, 05:00.
        expect(samples['hour24Value']).toEqual([0, 1, 3, 4, 5]);
    });
});
