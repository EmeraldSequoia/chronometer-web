/**
 * Message protocol for the eval-ahead worker (Phase B). Shared by the worker entry
 * (`eval-worker.ts`), its pure dispatcher (`worker-core.ts`), and the main-thread
 * client (`worker-client.ts`).
 *
 * All payloads are plain data (structured-cloneable): expression `ASTNode`s are
 * plain objects, and there are no functions/Maps/class instances on the wire.
 *
 * **Generation counter.** Every message carries the `generation` the main thread
 * was on when it sent it. The worker stamps each result with the generation it was
 * computed under; the main thread discards stale-generation results. Any env change
 * (location/mode/rate/direction/DST/step/Now) bumps the generation and re-`init`s
 * the affected face, invalidating in-flight requests.
 *
 * **Value ids are unique per face** — NOT the ObsValue name, which collides across
 * `refName` parts (see worker-core determinism findings). The main thread assigns
 * the unique id (e.g. the ObsValue's index) and maps results back.
 */

import type { ASTNode } from '../expr/parser.js';
import type { WatchEnvOverrides } from './watch-env.js';

/** Build/replace a face's env on the worker. */
export interface WorkerInitMsg {
    type: 'init';
    faceId: string;
    generation: number;
    /** Parsed init-block expressions (face's `Watch.initExprs`). */
    initExprs: ASTNode[];
    /** Display instant the main thread built this env at (init blocks see it). */
    nowMs: number;
    lat: number;
    lon: number;
    tz?: string;
    bps: number;
    overrides?: WatchEnvOverrides;
    /** The per-value expressions, keyed by unique id. */
    values: { id: string; expr: ASTNode }[];
}

/** Ask the worker to evaluate values at future boundary display times. */
export interface WorkerReqMsg {
    type: 'req';
    faceId: string;
    generation: number;
    reqs: { valueId: string; boundaryDisplayMs: number }[];
}

export type WorkerInbound = WorkerInitMsg | WorkerReqMsg;

/** Computed targets for a face, stamped with the generation they were computed under. */
export interface WorkerResMsg {
    type: 'res';
    faceId: string;
    generation: number;
    results: { valueId: string; boundaryDisplayMs: number; target: number }[];
}

export type WorkerOutbound = WorkerResMsg;
