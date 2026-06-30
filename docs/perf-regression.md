# Perf Regression Check

A **reported, not gated** measurement of per-face CPU tick time, to catch "still correct, but slower"
regressions that the bit-identical [test suite](testing.md) can't see. Wall-clock time is too
machine-dependent to make a pass/fail gate, so instead the harness measures every face, diffs against a
committed benchmark, and prints a summary plus an instruction for whoever (human or agent) is running
the regression to **surface notable deltas**.

> Design rationale and the rejected alternatives (op-count goldens, hard timing thresholds) are in
> [planning/2026-06-30-perf-regression-harness.md](../planning/2026-06-30-perf-regression-harness.md).

## Files

| path | role |
|---|---|
| `src/__tests__/perf/profile-core.ts` | `measureFaceTickMs` / `medianFaceTickMs` + `ALL_FACES` — the reusable warm-tick measurement (1-day/tick scrub, Gaia city slots, warm-up, timed ticks). |
| `src/__tests__/perf/perf-regression.ts` | the runner — compare-vs-baseline (default) or `--capture` (re-baseline). |
| `src/__tests__/perf/perf-baseline.json` | the benchmark: per-face median ms + metadata (date, machine, node, code-state note, methodology, calibration constant). |

It is **not** a Vitest test (Vitest runs only `*.test.ts`), so it never gates the suite — it's a script
you run and read.

## Running a full regression

```bash
npx vitest run                                  # 1. correctness / bit-identical — the HARD gate (catches crashes)
npx tsx src/__tests__/perf/perf-regression.ts   # 2. perf — SOFT; read the summary and surface deltas
#   --runs=3   fewer runs/face (faster, noisier)
#   --capture  RE-BASELINE — only on a known-good tree (see below)
```

Then **surface to the user**: the TOTAL Δ (with the machine-speed factor) and any face flagged
`⚠ slower` / `✓ faster`, following the directive the script prints at the end.

## Reading the output

- **Per-face Δ%**, plus a TOTAL. A face is flagged only if `|Δ%| ≥ 15%` **and** `|Δ ms| ≥ 0.01` (so
  sub-ms faces don't trip on rounding).
- **Localized vs uniform.** One face up while others are flat ⇒ likely a real regression — flag it. A
  roughly-uniform shift across all faces ⇒ usually a different/loaded machine — say so.
- **Machine-speed calibration.** The runner times a fixed arithmetic loop and reports `this / baseline`
  as a factor. ≈1.0 ⇒ comparable machines; far from 1.0 ⇒ discount a uniform shift of about that size.
- **Crashes** show as `🔴 CRASH` for a face whose tick threw — that's a correctness regression the
  Vitest suite should also catch.
- Report **speedups** too: they confirm an optimization, or hint that work was skipped.

## Re-baselining (`--capture`)

Treat it exactly like regenerating golden files (see [development rules §12](development-rules.md)): do
it **deliberately, after an _intended_ perf change, on a quiet machine** — never to silence a warning.
`--capture` refuses if any face crashed (a baseline must come from a known-good tree). Fill in the
`machine` / `note` fields by hand, or set `PERF_MACHINE=…`.

## When to run it

Per [development rules §18](development-rules.md): any change that could plausibly affect scrub/tick
performance — astronomy, the cache pool, the updater/animation tick, expression evaluation, or
per-eval work like timezone conversion — warrants a perf-regression run alongside the correctness
suite, with the result surfaced to the user.
