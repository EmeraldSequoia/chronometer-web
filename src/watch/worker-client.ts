/**
 * Main-thread client for the eval-ahead worker (Phase B). Wraps the `Worker`
 * lifecycle + message plumbing so the engine can treat the worker as an optional
 * accelerator: if it can't be spawned (e.g. `file://` blocks `new Worker(url)`, or
 * the runtime has no workers), {@link WorkerEvalClient.available} is `false` and the
 * engine falls back to the Phase-A synchronous on-beat path.
 *
 * The worker is launched from the bundled `chronometer-worker.js`. On `file://`,
 * `new Worker(url)` is blocked, but a **Blob-URL worker** works if the bundle
 * source is provided inline (`inlineSource`) — it can't be `fetch()`ed on file://.
 * Callers pass `inlineSource` only when they have it (e.g. injected at build time);
 * otherwise the client simply reports unavailable on file://.
 */

import type { WorkerInitMsg, WorkerReqMsg, WorkerResMsg } from './worker-protocol.js';

export interface WorkerClientOptions {
    /** URL of the worker bundle (relative to the page), e.g. "chronometer-worker.js". */
    url: string;
    /**
     * The worker bundle source as a string, for the Blob-URL fallback (needed under
     * `file://`, where `new Worker(url)` is blocked and the source can't be fetched).
     */
    inlineSource?: string;
    /** Force-disable the worker (e.g. `?noworker` for A/B measurement). */
    disabled?: boolean;
}

export class WorkerEvalClient {
    private worker: Worker | null = null;
    private blobUrl: string | null = null;
    private broken = false;
    private onRes: ((res: WorkerResMsg) => void) | null = null;

    /** When unavailable, a human-readable reason (for logging); `null` if available. */
    unavailableReason: string | null = null;

    constructor(opts: WorkerClientOptions) {
        this.worker = this.spawn(opts);
        if (this.worker) {
            this.worker.onmessage = (e: MessageEvent): void => {
                this.onRes?.(e.data as WorkerResMsg);
            };
            // A runtime worker error (load failure, uncaught throw) disables the
            // worker so the engine falls back to the synchronous path.
            this.worker.onerror = (e: ErrorEvent): void => {
                this.broken = true;
                this.unavailableReason = `runtime error: ${e.message || 'unknown'}`;
            };
        }
    }

    /** Try `new Worker(url)`, then the Blob-URL fallback, then give up (→ null). */
    private spawn(opts: WorkerClientOptions): Worker | null {
        if (opts.disabled) {
            this.unavailableReason = 'force-disabled (?noworker)';
            return null;
        }
        if (typeof Worker === 'undefined') {
            this.unavailableReason = 'no Worker API in this runtime';
            return null;
        }
        try {
            return new Worker(opts.url);
        } catch (err) {
            // Likely file:// — new Worker(url) is blocked (origin "null"). Try a
            // Blob-URL worker if we have the source inline (can't fetch on file://).
            if (opts.inlineSource) {
                try {
                    const blob = new Blob([opts.inlineSource], { type: 'text/javascript' });
                    this.blobUrl = URL.createObjectURL(blob);
                    return new Worker(this.blobUrl);
                } catch (err2) {
                    if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
                    this.unavailableReason = `new Worker(url) and Blob-URL worker both failed (${String(err2)})`;
                    return null;
                }
            }
            this.unavailableReason = `new Worker("${opts.url}") blocked (likely file://) and no inline source provided (${String(err)})`;
            return null;
        }
    }

    /** True while the worker is usable; false ⇒ engine should use the sync path. */
    get available(): boolean {
        return this.worker !== null && !this.broken;
    }

    /** Register the handler for computed-target results. */
    setResultHandler(cb: (res: WorkerResMsg) => void): void {
        this.onRes = cb;
    }

    /** (Re)build a face's env on the worker at a generation. */
    init(msg: WorkerInitMsg): void {
        if (this.available) this.worker!.postMessage(msg);
    }

    /** Request target evaluations at future boundaries. */
    request(msg: WorkerReqMsg): void {
        if (this.available) this.worker!.postMessage(msg);
    }

    /** Tear down the worker and any Blob URL. */
    terminate(): void {
        this.worker?.terminate();
        this.worker = null;
        if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
    }
}
