/**
 * Worker-core determinism test (Phase B-2(ii)).
 *
 * The eval-ahead worker only buys correctness if it reproduces the main thread's
 * targets *exactly* from mirrored state. This test builds, for every face:
 *   - a **main-thread reference** env + eval-ahead seam (mirroring engine-entry:
 *     overridable base → bps quantizer → `createWatchEnvironment`), and
 *   - a **worker** face via `worker-core` from the same mirrored inputs,
 * then evaluates every ObsValue expression at a spread of future display-time
 * boundaries and asserts the worker's target is **bit-identical** to the main
 * thread's (NaN ⇒ NaN). A mismatch means the mirror dropped state or the worker's
 * seam/quantizer wiring diverged.
 */

import { describe, test, expect } from 'vitest';
import { JSDOM } from 'jsdom';

import { parseWatchXML } from '../watch/xml-parser.js';
import { FACE_CONFIGS, TEST_LOCATIONS, loadFaceXML, allFaceNames } from './face-registry.js';
import type { Watch } from '../watch/types.js';
import { createWatchEnvironment } from '../watch/watch-env.js';
import { buildHandValues } from '../watch/hand-values.js';
import { makeOverridableGetNow } from '../shared/updater.js';
import { quantizeGetNow } from '../shared/time-quantize.js';
import { evalAttr } from '../shared/astro-env.js';
import { initWorkerFace, evalWorkerValue, WorkerDispatcher, type WorkerValueDef } from '../watch/worker-core.js';
import type { WorkerInitMsg, WorkerReqMsg } from '../watch/worker-protocol.js';

function parseFace(faceName: string): Watch {
    const xml = loadFaceXML(faceName);
    const dom = new JSDOM('', { contentType: 'text/html' });
    const domParser = new dom.window.DOMParser();
    return parseWatchXML(xml, 'front', domParser);
}

const BASE_MS = Date.UTC(2026, 5, 27, 12, 0, 0);

// Future display-time offsets spanning a sub-second beat up to ~year scale, so we
// exercise per-second hands, daily astro boundaries, and slow rings/analemma.
const PROBE_OFFSETS_MS = [
    0, 250, 1000, 30_000, 60_000, 3_600_000,
    43_200_000, 86_400_000, 7 * 86_400_000, 90 * 86_400_000, 300 * 86_400_000,
];

describe('worker-core determinism vs main-thread eval-ahead', () => {
    // Cupertino: mid-latitude, exercises normal rise/set (not polar edge cases).
    const loc = TEST_LOCATIONS[0];

    for (const faceName of allFaceNames()) {
        test(`${faceName}: worker targets match main thread`, () => {
            const bps = FACE_CONFIGS[faceName].beatsPerSecond;
            const watch = parseFace(faceName);

            // --- Main-thread reference (mirrors engine-entry's per-face seam) ---
            const mainSeam = makeOverridableGetNow(() => new Date(BASE_MS));
            const mainGetNow = quantizeGetNow(mainSeam.getNow, bps);
            const mainEnv = createWatchEnvironment(
                watch, loc.lat, loc.lon, mainGetNow, loc.olsonTimezone,
            );
            // The real ObsValue set (parsed exprs), incl. day/night wedges. NOTE:
            // ObsValue *names* are not unique (refName parts share a name — e.g.
            // Babylon's four `year` digit wheels are all "Babylon.year.angle"), so
            // the worker protocol must key by a unique id, not the name. We use the
            // array index here.
            const updater = buildHandValues(faceName, watch, mainEnv, 1000, false);
            const valueDefs: WorkerValueDef[] = updater.all.map((v, i) => ({ id: String(i), expr: v.expr }));

            // --- Worker face from mirrored state ---
            const wf = initWorkerFace({
                initExprs: watch.initExprs, nowMs: BASE_MS,
                lat: loc.lat, lon: loc.lon, tz: loc.olsonTimezone, bps,
                values: valueDefs,
            });

            let compared = 0;
            for (const v of valueDefs) {
                for (const dt of PROBE_OFFSETS_MS) {
                    const T = BASE_MS + dt;
                    const mainTarget = mainSeam.withDisplayTime(T, () => evalAttr(v.expr, mainEnv));
                    const workerTarget = evalWorkerValue(wf, v.id, T);
                    if (Number.isNaN(mainTarget)) {
                        expect.soft(Number.isNaN(workerTarget), `${v.id} @+${dt}ms (main NaN)`).toBe(true);
                    } else {
                        expect.soft(workerTarget, `${v.id} @+${dt}ms`).toBe(mainTarget);
                    }
                    compared++;
                }
            }
            expect(compared).toBeGreaterThan(0);
        });
    }
});

describe('worker protocol (dispatcher) — clone-safe + generation-gated', () => {
    const loc = TEST_LOCATIONS[0];

    test('Mauna Kea: dispatcher results match main thread through structured clone', () => {
        const faceName = 'Mauna Kea';
        const bps = FACE_CONFIGS[faceName].beatsPerSecond;
        const watch = parseFace(faceName);

        const mainSeam = makeOverridableGetNow(() => new Date(BASE_MS));
        const mainEnv = createWatchEnvironment(
            watch, loc.lat, loc.lon, quantizeGetNow(mainSeam.getNow, bps), loc.olsonTimezone,
        );
        const updater = buildHandValues(faceName, watch, mainEnv, 1000, false);
        const valueDefs: WorkerValueDef[] = updater.all.map((v, i) => ({ id: String(i), expr: v.expr }));

        const GEN = 7;
        const initMsg: WorkerInitMsg = {
            type: 'init', faceId: 'f', generation: GEN,
            initExprs: watch.initExprs, nowMs: BASE_MS,
            lat: loc.lat, lon: loc.lon, tz: loc.olsonTimezone, bps,
            values: valueDefs,
        };
        // structuredClone catches anything non-cloneable on the wire (functions,
        // class instances, …) — i.e. proves the protocol payload is postMessage-safe.
        const dispatcher = new WorkerDispatcher();
        dispatcher.handleInit(structuredClone(initMsg));

        const probe = BASE_MS + 3 * 86_400_000;  // 3 days ahead
        const reqMsg: WorkerReqMsg = {
            type: 'req', faceId: 'f', generation: GEN,
            reqs: valueDefs.map(v => ({ valueId: v.id, boundaryDisplayMs: probe })),
        };
        const res = dispatcher.handleReq(structuredClone(reqMsg));
        expect(res).not.toBeNull();
        expect(res!.generation).toBe(GEN);

        for (const r of res!.results) {
            const def = valueDefs.find(v => v.id === r.valueId)!;
            const main = mainSeam.withDisplayTime(probe, () => evalAttr(def.expr, mainEnv));
            if (Number.isNaN(main)) expect.soft(Number.isNaN(r.target), r.valueId).toBe(true);
            else expect.soft(r.target, r.valueId).toBe(main);
        }
    });

    test('stale-generation requests are dropped', () => {
        const faceName = 'Geneva';
        const bps = FACE_CONFIGS[faceName].beatsPerSecond;
        const watch = parseFace(faceName);
        const dispatcher = new WorkerDispatcher();
        dispatcher.handleInit({
            type: 'init', faceId: 'f', generation: 1,
            initExprs: watch.initExprs, nowMs: BASE_MS,
            lat: loc.lat, lon: loc.lon, tz: loc.olsonTimezone, bps,
            values: [{ id: '0', expr: watch.initExprs.length ? watch.initExprs[0] : { kind: 'NumberLiteral', value: 0 } }],
        });
        // Same face, newer generation request → dropped (main thread re-inited since).
        expect(dispatcher.handleReq({ type: 'req', faceId: 'f', generation: 2, reqs: [{ valueId: '0', boundaryDisplayMs: BASE_MS }] })).toBeNull();
        // Unknown face → dropped.
        expect(dispatcher.handleReq({ type: 'req', faceId: 'zzz', generation: 1, reqs: [] })).toBeNull();
        // Matching generation → served.
        expect(dispatcher.handleReq({ type: 'req', faceId: 'f', generation: 1, reqs: [] })).not.toBeNull();
    });
});
