# Perf-Regression Harness — design + how to run

**Date:** 2026-06-30
**Status:** Implemented (`src/__tests__/perf/profile-core.ts`, `src/__tests__/perf/perf-regression.ts`,
`src/__tests__/perf/perf-baseline.json`). Validated — it caught the geneva crash and the kyoto +41% slowdown
introduced by the per-instant tz-conversion change (see
[2026-06-30-tz-conversion-crash-and-regression.md](2026-06-30-tz-conversion-crash-and-regression.md)).
**Not committed** per Steve; left in the working tree for the other session.

---

## Motivation

The CPU-tick work (Levers D + A) cut the all-faces warm tick from ~21 ms to ~8.4 ms. Future changes —
including unrelated correctness fixes — can silently give some of that back. The `vitest` regression
suite is bit-identical/correctness only: it catches **crashes** (e.g. a `RangeError` thrown during a
geneva scrub case) but **not** "still correct, just slower." We want eyes on tick time during a full
regression without making timing a flaky pass/fail gate.

## Two rejected shapes, and why

- **Per-function op-count goldens** (count `formatToParts` / rise-set searches / lunar-series calls per
  tick, assert against a golden). *Rejected (Steve):* too specific unless exhaustive — it only catches
  the regressions we enumerated, and is blind to a function that gets slower *internally* (same call
  count, more time per call). Holistic wall-clock time is the genuinely complete signal.
- **A hard `tick < X ms` vitest assertion.** *Rejected:* wall-clock time is machine- and load-dependent,
  so a fixed threshold is flaky in CI and noisy locally. Timing must inform, not gate.

## The shape we built: measure, diff, and instruct the agent to surface

Timing is **reported, never gated**. A full regression runs two things:

1. **Hard gate (unchanged): `npx vitest run`** — correctness / bit-identical. Catches crashes.
2. **Soft, reported: `npx tsx src/__tests__/perf/perf-regression.ts`** — measures every face's warm tick, diffs
   against a committed benchmark, prints a per-face + total summary, and ends with an **explicit
   instruction for the agent** running the regression to surface notable deltas to the user.

Because full regressions are increasingly run *by an agent*, the script's tail is addressed to that
agent (what to surface, and how to tell a real regression from a slow machine). A human reading the
same output gets the same guidance.

## Pieces

| file | role |
|---|---|
| `src/__tests__/perf/profile-core.ts` | `measureFaceTickMs(face)` / `medianFaceTickMs(face, runs)` + `ALL_FACES`. The reusable measurement core (env setup w/ Gaia city slots, 1-day/tick scrub, warm-up, timed ticks). `step0-tick-profile.ts` predates this and could be refactored onto it. |
| `src/__tests__/perf/perf-regression.ts` | The runner: compare-vs-baseline (default) or `--capture` (re-baseline). Prints the table + agent directive. |
| `src/__tests__/perf/perf-baseline.json` | The benchmark: per-face median ms + metadata (date, machine, node, code-state note, methodology, calibration constant). |

## Machine-variance handling (so "slower" ≠ "slow machine")

Two layers let the agent distinguish a real regression from a different/loaded host:

1. **Per-face pattern.** The table is per-face, not just a total. A **localized spike** (one face up,
   others flat) is a likely regression; a **roughly-uniform shift** across all faces is usually the
   machine. The agent is told to read it this way.
2. **A calibration control.** The runner times a fixed pure-arithmetic loop and reports
   `this / baseline` as a **machine-speed factor**. ≈1.0 ⇒ comparable machines; far from 1.0 ⇒ discount
   a uniform shift of about that magnitude. (`calibrationMs` is stored in the baseline.)

Plus a **noise floor**: a face is only surfaced if `|Δ%| ≥ 15%` **and** `|Δ ms| ≥ 0.01` — so sub-ms
faces (milano 0.003→0.002) don't flag on rounding.

> **Correction (2026-06-30, after using it on the tz fix):** point 1 above is weaker than written.
> Same-machine, same-VM, a single face's median swings **~±10% run-to-run** (run ordering, thermal
> state, JIT/GC) — *not* just across machines. So a "localized spike" is often noise, and the calibration
> factor (which only handles *uniform* shifts) doesn't catch it. A single-shot per-face Δ under
> ~10–15% is not evidence of a regression, even against a same-machine baseline. **Confirm a suspected
> per-face regression with an interleaved same-machine A/B** (stash vs. apply, measured alternately over
> several rounds, so drift cancels) — only a gap that survives swapping which side runs first is real.
> The operational guidance in [docs/perf-regression.md § Stability](../docs/perf-regression.md) and
> [development rules §18](../docs/development-rules.md) now reflects this.

## Re-baseline discipline (perf analog of golden capture)

`--capture` rewrites `perf-baseline.json`. Treat it like `CAPTURE=1` for the golden files: do it
**deliberately, after an *intended* perf change, on a quiet machine** — never to "make the warning go
away." `--capture` **refuses if any face crashed** (a baseline must come from a known-good tree). Fill
in the `machine` and `note` fields by hand (or `PERF_MACHINE=… --capture`).

> The current `perf-baseline.json` was **hand-entered** from this session's scoreboard medians (post
> Lever A/D, pre tz-fix), because the working tree currently crashes geneva and can't be cleanly
> captured. Re-`--capture` it on a clean tree once the tz crash is fixed.

## How to run (the full-regression checklist)

```bash
npx vitest run                              # 1. correctness (hard gate; catches crashes)
npx tsx src/__tests__/perf/perf-regression.ts         # 2. perf (soft; read the summary, surface deltas)
#   --runs=3   fewer runs/face (faster, noisier)   --capture   re-baseline (known-good tree only)
```
Then **surface to the user**: the TOTAL Δ (with the machine-speed factor) and any face flagged
`⚠ slower` / `✓ faster`, following the directive the script prints.

## Validation (2026-06-30)

Run against the working tree carrying the per-instant tz change, it produced exactly the right signal:
`geneva` → **CRASH (Invalid time value)**; `kyoto` **+41%**, `haleakala` **+38%**, `hana` **+17%**
flagged `⚠ slower`; the rest flat; TOTAL +3.7% at a 0.93× machine factor. That's the regression report
we'd want a future agent to surface automatically.

> **Follow-up (2026-06-30, later):** the **crash** signal was the genuinely valuable one, and the perf
> flags correctly prompted a look. But the flagged **percentages were mostly artifact.** After the
> crash guard + offset-window memo removed the `formatToParts` cost, an *interleaved same-machine* A/B
> (see the Correction above) put the real deltas at **~+1.5% (kyoto) down to noise** — several faces
> even flipped sign with measurement order. The headline `+41%/+38%/+17%` combined the real
> `formatToParts` cost *with* a cross-machine hand-entered baseline *and* run-ordering drift. Lesson:
> trust the harness to say "look here," not "it's N% slower."

## Canonical docs

This file is the **design record** (rationale + rejected alternatives + validation). The **permanent,
operational how-to** lives in [docs/perf-regression.md](../docs/perf-regression.md), and the reminder
to run it is **[development rules §18](../docs/development-rules.md)**. The harness code moved out of
`planning/` into `src/__tests__/perf/` (it's a permanent tool, not an in-progress artifact).

## Follow-ups (not done)

- Refactor `step0-tick-profile.ts` to import `src/__tests__/perf/profile-core.ts` (DRY) — left alone
  for now to avoid churning a file the other session may be using.
- Optional: dump the full per-function call-count table on request (`--detail`) as a *diagnosis* aid
  once a regression is flagged — not a gate, just to localize which calls grew.
- ~~Wire the two-step checklist into the docs~~ — **DONE**: `docs/perf-regression.md` + dev-rule §18.
