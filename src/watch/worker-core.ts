/**
 * worker-core — the pure logic of the eval-ahead worker (Phase B), factored out of
 * the postMessage shim (`eval-worker.ts`) so it can be unit-tested in Node and
 * reused without a worker context.
 *
 * It mirrors the engine's per-face setup exactly: the same `createWatchEnvironment`
 * (now pure — B-1), the same beatsPerSecond quantizer (`quantizeGetNow`), and the
 * same overridable display-time seam (`makeOverridableGetNow` + `withDisplayTime`)
 * the Updater's eval-ahead uses. Because astronomy is deterministic in
 * (display time, location, mode), evaluating a value's expression here at a future
 * boundary yields the **same** target the main thread would compute — verified by
 * the determinism test (worker-core.test.ts).
 *
 * The worker holds its **own** `AstroCachePool` (created inside
 * `createWatchEnvironment`), so it works on future display times without thrashing
 * the main thread's `now`-pool.
 *
 * The DOM-free parser (`DOMParser`) is unavailable in a dedicated worker, so the
 * worker does **not** parse XML: it receives the already-parsed init ASTs and the
 * already-parsed per-value expression ASTs (plain objects → structured-cloneable).
 */

import type { ASTNode } from '../expr/parser.js';
import type { Environment } from '../expr/evaluator.js';
import { createWatchEnvironment, type WatchEnvOverrides } from './watch-env.js';
import { evalAttr } from '../shared/astro-env.js';
import { makeOverridableGetNow, type WithDisplayTime } from '../shared/updater.js';
import { quantizeGetNow } from '../shared/time-quantize.js';
import type { WorkerInitMsg, WorkerReqMsg, WorkerResMsg } from './worker-protocol.js';

/** One value the worker can evaluate, keyed by the ObsValue's `name`. */
export interface WorkerValueDef {
    /** ObsValue name (e.g. "Vienna.24HourHand.angle"). */
    id: string;
    /** Parsed expression AST (same node the main-thread ObsValue holds). */
    expr: ASTNode;
}

/**
 * Everything the worker needs to reproduce a face's env. All fields are plain data
 * (structured-cloneable) — no `Watch` parts tree, no functions.
 */
export interface WorkerFaceInit {
    /** Parsed init-block expressions (from the face's `Watch.initExprs`). */
    initExprs: ASTNode[];
    /**
     * Display-time instant (ms-since-epoch) at which the main thread built/mirrored
     * this env. The init blocks evaluate against this time, so it must match the
     * main thread's construction time or any init-captured time-dependent value
     * (calendar date, UT base, …) would diverge. A later main-thread env rebuild
     * bumps the generation and re-inits the worker at the new `nowMs`.
     */
    nowMs: number;
    /** Observer latitude in degrees (positive = north). */
    lat: number;
    /** Observer longitude in degrees (negative = west). */
    lon: number;
    /** IANA timezone override. */
    tz?: string;
    /** beatsPerSecond quantization for this face. */
    bps: number;
    /** Persisted UI overrides (body / noonOnTop / kyMode / kyHandMode). */
    overrides?: WatchEnvOverrides;
    /** The per-value expressions to evaluate. */
    values: WorkerValueDef[];
}

/** A built worker face: env + the overridable time seam + value expressions. */
export interface WorkerFace {
    env: Environment;
    withDisplayTime: WithDisplayTime;
    values: Map<string, ASTNode>;
}

/**
 * Build a worker face from mirrored state. Mirrors the engine's per-face seam:
 * an overridable base (so `withDisplayTime` can shift evaluation to a future
 * boundary), wrapped in the bps quantizer, captured by the env.
 */
export function initWorkerFace(init: WorkerFaceInit): WorkerFace {
    // Overridable base at the mirrored construction time (so init blocks see the
    // same instant the main thread did); the env captures the *quantized* wrapper,
    // exactly as the engine does (engine-entry makeOverridableGetNow + makeGetNow).
    const { getNow, withDisplayTime } = makeOverridableGetNow(() => new Date(init.nowMs));
    const faceGetNow = quantizeGetNow(getNow, init.bps);
    const env = createWatchEnvironment(
        { initExprs: init.initExprs },
        init.lat, init.lon, faceGetNow, init.tz,
        undefined, undefined, init.overrides,
    );
    const values = new Map<string, ASTNode>();
    for (const v of init.values) values.set(v.id, v.expr);
    return { env, withDisplayTime, values };
}

/**
 * Evaluate one value's target at a future display-time boundary (eval-ahead).
 * Returns `NaN` for an unknown id. The display-time override is scoped to this
 * single evaluation, so the env reverts to its base afterward.
 */
export function evalWorkerValue(face: WorkerFace, id: string, boundaryDisplayMs: number): number {
    const expr = face.values.get(id);
    if (!expr) return NaN;
    return face.withDisplayTime(boundaryDisplayMs, () => evalAttr(expr, face.env));
}

/**
 * Message dispatcher: owns the per-face worker state and turns protocol messages
 * into target computations. Pure (no `postMessage`) so it is unit-testable in Node;
 * `eval-worker.ts` is just the postMessage glue around one of these.
 *
 * Generation handling: each face stores the generation it was last `init`ed under.
 * A `req` whose generation doesn't match (stale — the main thread has since changed
 * env and re-`init`ed, or the face is unknown) is dropped (`handleReq` returns
 * `null`), so the main thread never files a stale-generation result.
 */
export class WorkerDispatcher {
    private faces = new Map<string, { face: WorkerFace; generation: number }>();

    /** Build/replace a face's env at the given generation. */
    handleInit(msg: WorkerInitMsg): void {
        const face = initWorkerFace({
            initExprs: msg.initExprs, nowMs: msg.nowMs,
            lat: msg.lat, lon: msg.lon, tz: msg.tz, bps: msg.bps,
            overrides: msg.overrides, values: msg.values,
        });
        this.faces.set(msg.faceId, { face, generation: msg.generation });
    }

    /** Evaluate a batch of requests; returns `null` for unknown/stale-generation. */
    handleReq(msg: WorkerReqMsg): WorkerResMsg | null {
        const entry = this.faces.get(msg.faceId);
        if (!entry || entry.generation !== msg.generation) return null;
        const results = msg.reqs.map(r => ({
            valueId: r.valueId,
            boundaryDisplayMs: r.boundaryDisplayMs,
            target: evalWorkerValue(entry.face, r.valueId, r.boundaryDisplayMs),
        }));
        return { type: 'res', faceId: msg.faceId, generation: msg.generation, results };
    }

    /** Forget a face (e.g. when it is disabled). */
    drop(faceId: string): void {
        this.faces.delete(faceId);
    }
}
