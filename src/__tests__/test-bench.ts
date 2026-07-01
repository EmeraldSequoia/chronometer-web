/**
 * TestBench — Core test driver for watch face regression testing.
 *
 * Wraps TimeController + createWatchEnvironment + buildHandValues +
 * Updater.tick into a single class that can set mock times, simulate user
 * interactions (step, scrub, play/pause), and capture snapshots of all
 * dynamic part values for comparison against golden baselines.
 *
 * Mirrors the engine's animation path (the ObsValue/Updater system): a per-bench
 * overridable getNow seam with beatsPerSecond quantization layered on top, exactly
 * as engine-entry.ts wires it.
 *
 * Usage:
 *   const bench = new TestBench({ faceName: 'Babylon', location: TEST_LOCATIONS[0] });
 *   bench.setTime(new Date('2025-06-15T12:00:00Z'));
 *   bench.tick();  // run one animation frame
 *   const snap = bench.snapshot();
 */

import { vi, describe, test, beforeAll, afterAll } from 'vitest';
import { JSDOM } from 'jsdom';

import { type FaceConfig, type TestLocation, FACE_CONFIGS, TEST_LOCATIONS, loadFaceXML } from './face-registry.js';
import {
    type GoldenData, type ScenarioSnapshot, type PartValueSnapshot,
    isCaptureMode, loadGolden, saveGolden, assertScenarioMatch,
} from './snapshot-utils.js';

import { parseWatchXML } from '../watch/xml-parser.js';
import { createWatchEnvironment } from '../watch/watch-env.js';
import { envTzStateStale } from '../shared/astro-env.js';
import type { Watch, WatchPart, QDialPart } from '../watch/types.js';
import type { Environment } from '../expr/env.js';
import {
    Updater, makeOverridableGetNow, type WithDisplayTime, type TimingContext,
} from '../shared/updater.js';
import { buildHandValues } from '../watch/hand-values.js';
import { TimeController, type TimeUnit, RATE_OPTIONS, TICK_INTERVAL_MS, displaySecondsPerTick } from '../shared/time-controller.js';

// ============================================================================
// TestBench
// ============================================================================

export interface TestBenchOptions {
    faceName: string;
    location: TestLocation;
}

export class TestBench {
    readonly faceName: string;
    readonly faceConfig: FaceConfig;
    readonly location: TestLocation;

    // Parsed watch definition (immutable after construction)
    readonly watch: Watch;

    // Mutable state
    env!: Environment;
    updater!: Updater;
    timeController!: TimeController;

    /** Overridable (unquantized) display-time source — the base of the env's
     *  quantized getNow and of the Updater's getNow/withDisplayTime. */
    private getNow!: () => Date;
    private withDisplayTime!: WithDisplayTime;

    /** Mocked performance.now() value (ms). */
    perfNow: number = 1000; // Start at 1s to avoid edge cases at 0

    /**
     * Simulated play direction. When non-null, advanceRealTime() advances
     * display time by deltaMs × playDirection in addition to perfNow.
     * This avoids using TimeController's 1×/-1× mode (which relies on Date.now()).
     */
    private playDirection: 1 | -1 | null = null;

    /** The vitest spy on performance.now. Stored so we can restore it. */
    private perfNowSpy: ReturnType<typeof vi.spyOn> | null = null;

    constructor(options: TestBenchOptions) {
        this.faceName = options.faceName;
        this.faceConfig = FACE_CONFIGS[options.faceName];
        if (!this.faceConfig) {
            throw new Error(`Unknown face: "${options.faceName}"`);
        }
        this.location = options.location;

        // Parse the XML using jsdom's DOMParser
        const xmlText = loadFaceXML(options.faceName);
        const dom = new JSDOM('', { contentType: 'text/html' });
        const domParser = new dom.window.DOMParser();
        this.watch = parseWatchXML(xmlText, 'front', domParser);

        // Mock performance.now() so all internal calls use our controlled value
        this.perfNowSpy = vi.spyOn(performance, 'now').mockImplementation(() => this.perfNow);

        // Initialize with a default time
        this.timeController = new TimeController();
    }

    /** beatsPerSecond quantizer over a base time source (mirrors engine makeGetNow). */
    private makeGetNow(bps: number, base: () => Date): () => Date {
        if (bps <= 0) return base;
        return () => {
            const ms = base().getTime();
            return new Date(Math.round(ms / 1000 * bps) / bps * 1000);
        };
    }

    /** Rebuild the environment for the current time, reusing the persistent
     *  overridable getNow seam (only the quantizing closure is re-created). */
    private buildEnv(): Environment {
        const faceGetNow = this.makeGetNow(this.watch.beatsPerSecond, this.getNow);
        return createWatchEnvironment(
            this.watch, this.location.lat, this.location.lon, faceGetNow, this.location.olsonTimezone,
        );
    }

    /**
     * Set the mock display time and (re)initialize all animation state.
     * This is the primary way to set up a scenario.
     */
    setTime(date: Date): void {
        // Set display time via TimeController (stops the clock)
        this.timeController.setTime(date);

        // Per-bench overridable getNow seam (unquantized base = display time).
        const rawGetNow = () => this.timeController.getDisplayTime();
        const seam = makeOverridableGetNow(rawGetNow);
        this.getNow = seam.getNow;
        this.withDisplayTime = seam.withDisplayTime;

        this.env = this.buildEnv();

        // Build the per-face Updater in lightweight mode: hands/wheels/dials/covers
        // + the day/night ring's masterOffset, but NOT the per-wedge ObsValues,
        // terminator leaves, or analemma — none of which the snapshot captures (and
        // analemma's expandAnalemma needs OffscreenCanvas, absent in node). This
        // matches the legacy HandState bench's scope and keeps the suite fast.
        this.updater = buildHandValues(this.watch.name, this.watch, this.env, this.perfNow, true);
    }

    /**
     * Rebuild the environment without changing the time. Used after TimeController
     * mutations (step, setRate, etc.) to refresh time-dependent bindings. The
     * Updater + leaves persist (they re-evaluate against this.env on the next tick).
     */
    rebuildEnv(): void {
        this.env = this.buildEnv();
    }

    /**
     * Mirror of the engine's rebuildEnvironments guard (engine-entry.ts): rebuild
     * only when the env's captured timezone state (target offset + browser→target
     * delta) is stale for the current display time — a DST crossing in either the
     * target or the browser zone. Otherwise skip the rebuild and invalidate the
     * env's astro cache pool, so this tick's astronomy starts from the same
     * all-invalid state a fresh pool would have.
     *
     * The golden baselines were captured with an unconditional rebuild, so if this
     * guard ever changes observable behavior, the regression suite catches it.
     */
    private guardedRebuildEnv(): void {
        if (envTzStateStale(this.env, this.location.olsonTimezone) || this.env.captureStale?.()) {
            this.rebuildEnv();
        } else {
            this.env.invalidateAstroCaches?.();
        }
    }

    /**
     * Advance the mocked performance.now() by deltaMs and run one animation frame.
     * When playing, also advances display time by deltaMs in the play direction.
     */
    advanceRealTime(deltaMs: number): void {
        this.perfNow += deltaMs;

        if (this.playDirection !== null) {
            const currentMs = this.timeController.getDisplayTime().getTime();
            const newMs = currentMs + deltaMs * this.playDirection;
            this.timeController.setTime(new Date(newMs));
            this.rebuildEnv();
        }

        // Not playing ⇒ the clock is stopped; tick with direction 0 so on-beat
        // values settle to the exact time (matches the engine's stopped frames).
        const dir = this.playDirection ?? (this.timeController.isStopped ? 0 : 1);
        this._tickAll(null, 0, dir);
    }

    /** Run one animation frame at the current perfNow (quantized-mode params optional).
     *  Default direction follows the controller: 0 when stopped (the engine's
     *  stopped-frame behavior), else forward. */
    tick(
        tickIntervalMs: number | null = null,
        displayDeltaPerTickSec: number = 0,
        direction?: 0 | 1 | -1,
    ): void {
        const dir = direction ?? (this.timeController.isStopped ? 0 : 1);
        this._tickAll(tickIntervalMs, displayDeltaPerTickSec, dir);
    }

    /**
     * Simulate a single-step tap. Mirrors engine-entry's onTimeStep
     * (finishAllAnimations → resetAllSchedules) plus the controller step.
     */
    singleStep(unit: TimeUnit, direction: 1 | -1): void {
        this.timeController.stop();
        this.updater.finish();

        this.timeController.step(unit, direction);
        // Engine parity: step() fires onTick → the guarded rebuildEnvironments.
        this.guardedRebuildEnv();

        // One-shot re-evaluation: reset schedules, then evaluate at the new time.
        // The clock is stopped (step() above), so the engine ticks with direction 0;
        // match that here so on-beat values settle to the exact stepped time (rather
        // than running the live sit/sweep cadence against a frozen clock).
        this.timeController.beginFrame();
        this.updater.reset();
        this._tick(null, 0, 0);
        this.timeController.endFrame();
    }

    /** Start a hold-to-scrub simulation (quantized rate mode at the given unit). */
    startScrub(unit: TimeUnit, direction: 1 | -1): void {
        this.timeController.setDirection(direction);
        const rateIdx = RATE_OPTIONS.findIndex(r => r.unit === unit);
        if (rateIdx >= 0) {
            this.timeController.setRate(RATE_OPTIONS[rateIdx]);
        }
        // Engine parity: setDirection/setRate fire onTick → the guarded rebuild.
        this.guardedRebuildEnv();
        this.updater.reset();
    }

    /** Advance one scrub tick (100ms real time + one calendar unit). */
    scrubTick(): void {
        this.perfNow += TICK_INTERVAL_MS;

        this.timeController.beginFrame();
        this.timeController.checkTick(this.perfNow);
        this.guardedRebuildEnv();

        const rate = this.timeController.currentRate;
        const displayDelta = rate ? displaySecondsPerTick(rate.unit) : 0;
        const dir = this.timeController.currentDirection;
        this._tick(TICK_INTERVAL_MS, displayDelta, dir);
        this.timeController.endFrame();
    }

    /** End a scrub simulation — stop and snap all animations (freeze path: bake
     *  A(now) so on-beat hands read the exact scrub-end time). */
    endScrub(): void {
        this.timeController.stop();
        this.updater.finish(this.env);
    }

    /**
     * Simulate play at 1× in the given direction. Keeps the clock stopped and
     * tracks the play direction; advanceRealTime() advances display time.
     */
    play(direction: 1 | -1): void {
        this.playDirection = direction;
        this.updater.reset();
    }

    /** Simulate pause — stop and snap animations (freeze path: bake A(now) so
     *  on-beat hands read the exact paused time, not a beat position). */
    pause(): void {
        this.playDirection = null;
        this.timeController.stop();
        this.updater.finish(this.env);
    }

    /**
     * Run animation frames until all animations complete (or 5s of sim time),
     * then snap. Advances perfNow in 16.7ms (60fps) increments.
     */
    finishAllAnimations(): void {
        const maxIterations = 300; // 5s at 60fps
        const stopped = this.timeController.isStopped;
        const dir: 0 | 1 | -1 = stopped ? 0 : this.timeController.currentDirection;
        for (let i = 0; i < maxIterations; i++) {
            if (!this.updater.anyAnimating()) break;
            this.perfNow += 16.7;
            this._tickAll(null, 0, dir);
        }
        // Freeze path when stopped: bake A(now) so on-beat hands settle exactly.
        this.updater.finish(stopped ? this.env : undefined);
    }

    /**
     * Capture a snapshot of all dynamic part values (same part set as the legacy
     * collectDynamicParts), read from the parts' ObsValue handles.
     */
    snapshot(): PartValueSnapshot[] {
        const dyn: WatchPart[] = [];
        this.collectDynamic(this.watch.parts, dyn);

        return dyn.map((part): PartValueSnapshot => {
            // For a day/night ring the legacy "angle" was its masterOffset.
            const angleObs = part.type === 'QDayNightRing' ? part._obsMasterOffset : part._obsAngle;
            const offsetObs = part._obsOffsetAngle;
            const xObs = part._obsXMotion;
            const yObs = part._obsYMotion;
            const schedObs = angleObs ?? xObs ?? offsetObs;

            const snap: PartValueSnapshot = {
                partName: part.name,
                partType: part.type,
                angle: angleObs ? angleObs.currentValue : 0,
                angleAnimating: angleObs ? angleObs.anim.animating : false,
                angleTarget: angleObs ? angleObs.anim.targetValue : 0,
                nextUpdateDisplayTime: schedObs ? schedObs.nextUpdateDisplayTime : Infinity,
                updateIntervalMs: schedObs ? schedObs.updateInterval * 1000 : 0,
            };
            if (offsetObs) {
                snap.offsetAngle = offsetObs.currentValue;
                snap.offsetAngleAnimating = offsetObs.anim.animating;
                snap.offsetAngleTarget = offsetObs.anim.targetValue;
            }
            if (xObs) {
                snap.xMotion = xObs.currentValue;
                snap.xMotionAnimating = xObs.anim.animating;
            }
            if (yObs) {
                snap.yMotion = yObs.currentValue;
                snap.yMotionAnimating = yObs.anim.animating;
            }
            return snap;
        });
    }

    /** Clean up vitest mocks. */
    dispose(): void {
        if (this.perfNowSpy) {
            this.perfNowSpy.mockRestore();
            this.perfNowSpy = null;
        }
    }

    // ========================================================================
    // Internal helpers
    // ========================================================================

    private _tick(tickIntervalMs: number | null, displayDeltaPerTickSec: number, direction: 0 | 1 | -1): void {
        const ctx: TimingContext = {
            tickIntervalMs,
            displayDeltaSec: displayDeltaPerTickSec,
            direction,
        };
        this.updater.tick(this.env, this.perfNow, this.getNow, this.withDisplayTime, ctx);
    }

    private _tickAll(
        tickIntervalMs: number | null,
        displayDeltaPerTickSec: number,
        direction: 0 | 1 | -1,
    ): void {
        this.timeController.beginFrame();
        this._tick(tickIntervalMs, displayDeltaPerTickSec, direction);
        this.timeController.endFrame();
    }

    /** Walk the part tree collecting the dynamic parts (matches collectDynamicParts). */
    private collectDynamic(parts: WatchPart[], out: WatchPart[]): void {
        for (const part of parts) {
            if (part.type === 'QHand' || part.type === 'Wheel' || part.type === 'QWedge') {
                out.push(part);
            } else if (part.type === 'QDial' && (part as QDialPart).animSpeed) {
                out.push(part);
            } else if (part.type === 'QDayNightRing') {
                out.push(part);
            } else if (part.type === 'CalendarRowCover') {
                out.push(part);
            } else if (part.type === 'Static') {
                this.collectDynamic(part.children, out);
            }
        }
    }

}

// ============================================================================
// High-level test runner
// ============================================================================

import { type ScenarioDefinition, type ScenarioAction, buildAllScenarios } from './scenarios.js';

/**
 * Execute a single scenario definition against a TestBench.
 * Returns an array of ScenarioSnapshots, one per 'capture' action.
 */
function executeScenario(bench: TestBench, scenario: ScenarioDefinition): ScenarioSnapshot[] {
    const snapshots: ScenarioSnapshot[] = [];

    for (const action of scenario.actions) {
        executeAction(bench, action, scenario.name, snapshots);
    }

    return snapshots;
}

/**
 * Execute a single action within a scenario.
 */
function executeAction(
    bench: TestBench,
    action: ScenarioAction,
    scenarioName: string,
    snapshots: ScenarioSnapshot[],
): void {
    switch (action.type) {
        case 'setTime':
            bench.perfNow = 1000; // Reset for determinism
            bench.setTime(action.date);
            break;
        case 'tick':
            bench.tick();
            break;
        case 'singleStep':
            bench.singleStep(action.unit, action.direction);
            break;
        case 'advanceRealTime':
            bench.advanceRealTime(action.deltaMs);
            break;
        case 'finishAnimations':
            bench.finishAllAnimations();
            break;
        case 'startScrub':
            bench.startScrub(action.unit, action.direction);
            break;
        case 'scrubTick':
            bench.scrubTick();
            break;
        case 'endScrub':
            bench.endScrub();
            break;
        case 'play':
            bench.play(action.direction);
            break;
        case 'pause':
            bench.pause();
            break;
        case 'capture':
            snapshots.push({
                name: `${scenarioName}:${action.label}`,
                parts: bench.snapshot(),
            });
            break;
    }
}

/**
 * Run the full regression suite for a single face across all locations.
 * This is the function called by each per-face test file.
 *
 * Builds all scenario definitions (idle, step, scrub, play/pause)
 * and runs each as an individual vitest test. In capture mode,
 * records results to golden files; in verify mode, compares against them.
 */
export function runFaceRegressionSuite(faceName: string): void {
    const captureMode = isCaptureMode();
    const allScenarios = buildAllScenarios();

    for (const location of TEST_LOCATIONS) {
        describe(`${faceName} @ ${location.name}`, () => {
            let bench: TestBench;
            let golden: GoldenData | null;
            const capturedScenarios: ScenarioSnapshot[] = [];

            beforeAll(() => {
                bench = new TestBench({ faceName, location });
                golden = captureMode ? null : loadGolden(faceName, location.name);
            });

            afterAll(() => {
                if (captureMode) {
                    const data: GoldenData = {
                        face: faceName,
                        location: {
                            name: location.name,
                            lat: location.lat,
                            lon: location.lon,
                            tz: location.olsonTimezone,
                        },
                        generatedAt: new Date().toISOString(),
                        scenarios: capturedScenarios,
                    };
                    saveGolden(data, faceName, location.name);
                }
                bench.dispose();
            });

            for (const scenario of allScenarios) {
                test(scenario.name, () => {
                    const results = executeScenario(bench, scenario);

                    if (captureMode) {
                        capturedScenarios.push(...results);
                    } else {
                        // Verify each capture checkpoint against golden data
                        for (const actual of results) {
                            const expected = golden?.scenarios.find(s => s.name === actual.name);
                            if (!expected) {
                                throw new Error(
                                    `No golden data for scenario "${actual.name}" in ${faceName}-${location.name}.snap.json. ` +
                                    'Run with CAPTURE=1 to generate baselines.',
                                );
                            }
                            assertScenarioMatch(actual, expected);
                        }
                    }
                });
            }
        });
    }
}
