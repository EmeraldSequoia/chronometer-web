/**
 * Eval-ahead worker entry (Phase B of the worker-threaded eval-ahead pipeline — see
 * planning/2026-06-26-worker-eval-ahead-pipeline.md).
 *
 * Bundled separately into `dist/chronometer-worker.js` and spawned by the engine to
 * run the **pure** env builder + astronomy off the main thread. Astronomy is a
 * deterministic function of (display time, location, mode), so the worker
 * reproduces the main thread's targets exactly (verified by worker-core.test.ts) —
 * with its **own** `AstroCachePool` per face, working on future display times while
 * the main thread interpolates + renders.
 *
 * This file is just the `postMessage` glue: it owns one {@link WorkerDispatcher}
 * (the testable logic lives in worker-core.ts) and forwards messages. A dedicated
 * worker has no DOM, so this entry — and everything it imports — must be worker-safe
 * (no `window`/`document`/`getState`); `createWatchEnvironment` is pure (B-1).
 */

import { WorkerDispatcher } from './worker-core.js';
import type { WorkerInbound, WorkerOutbound } from './worker-protocol.js';

/** Dedicated-worker global scope (typed minimally; `lib` here is ES2020 only). */
const workerScope = globalThis as unknown as {
    onmessage: ((e: { data: WorkerInbound }) => void) | null;
    postMessage(msg: WorkerOutbound): void;
};

const dispatcher = new WorkerDispatcher();

workerScope.onmessage = (e): void => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'init') {
        dispatcher.handleInit(msg);
    } else if (msg.type === 'req') {
        const res = dispatcher.handleReq(msg);
        if (res) workerScope.postMessage(res);
    }
};
