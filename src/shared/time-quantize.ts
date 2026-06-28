/**
 * beatsPerSecond display-time quantizer — the single source of truth shared by the
 * engine (per-face env `getNow`) and the eval-ahead worker (worker-core), so the
 * two threads quantize display time *identically* and the worker's targets match
 * the main thread's bit-for-bit.
 *
 * `bps <= 0` ⇒ no quantization (smooth/continuous). Otherwise display time is
 * snapped to the nearest 1/bps second (e.g. bps=1 ⇒ whole seconds, bps=4 ⇒ quarter
 * seconds), matching the legacy iOS beat quantization.
 */
export function quantizeGetNow(base: () => Date, bps: number): () => Date {
    if (bps <= 0) return base;
    return () => {
        const ms = base().getTime();
        return new Date(Math.round(ms / 1000 * bps) / bps * 1000);
    };
}
