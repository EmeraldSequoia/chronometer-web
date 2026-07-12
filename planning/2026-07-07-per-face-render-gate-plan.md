# Plan: per-face 1× render gate (idle battery)

> **Status: implemented 2026-07-10** (build 2.0.33). All triggers wired and
> exercised in-VM (~90 face-draws/s vs ~920 ungated at 60 Hz; DST crossing,
> location change, resize, scrub start/end, step-while-stopped all
> redraw; round-trip pixel-exact). `?drawstats` added for verification.
> Native results (2026-07-12): scrub confirmed unchanged (`[scrub-perf]`);
> **Safari energy −63%** (18.1 W → 6.6 W) — per-run table in
> [Native energy results](#native-energy-results-safari-2026-07-12) below.
> Outstanding: Chrome energy runs, Steve's eyeball pass.

**For a fresh session.** Battery is a nice-to-have, not a target (Steve,
2026-07-07). This is a small, fidelity-free change with one dominant risk
(missed invalidation = visibly stale face), so the trigger inventory below is
the substance of the work. Origin: by-product of the z-order layering
assessment — see "Z-order layered rendering … (2026-07-07)" in
[2026-07-03-scrub-render-perf-investigation.md](2026-07-03-scrub-render-perf-investigation.md)
and "Idle (1×) and battery" in [docs/performance.md](../docs/performance.md).

## Problem (verified in code, 2026-07-07)

At 1× the loop sleeps between beats, but when it wakes it redraws **all 16
faces**, and it wakes a lot:

- No per-face gate: the frame loop ([engine-entry.ts](../src/engine-entry.ts)
  ~1588–1673) runs `face.updater.tick(...)` and a full
  `renderFrame(face.ctx, ...)` for every enabled face on every frame that
  runs. `face.updater.anyAnimating()` is consulted only to decide whether the
  rAF loop continues (`willContinue`, ~1750), never to skip a face.
- `armIdle()` (~1760–1777) takes the **min** `nextWakeupTime()` across all
  faces — any face's beat wakes everyone. Firenze (10 s cadence) redraws at
  10 Hz because Geneva ticks.
- `SCHEDULER_LOOKAHEAD_MS = 50` ([animation.ts:30](../src/shared/animation.ts))
  wakes 50 ms early; within the window `armIdle` computes delay 0 → the loop
  free-runs display-rate frames, all values sitting → **byte-identical
  full-grid redraws**.
- all.html cadences: Geneva/Basel/Mauna Kea 10 Hz · Vienna/Terra/Gaia 8 Hz ·
  Milano/Kyoto 5 Hz · eight faces 1 Hz · Firenze 0.1 Hz. Epoch-aligned
  boundaries interleave (~16 wake events/s); merged awake windows ≈ **~85%
  duty cycle**, each awake frame = 16 face redraws. (architecture-overview.md's
  "2.5% duty cycle" claim predates the on-beat scheduler — fix it as part of
  this work.)

Expected effect of the gate: a typical 1× frame drops from 16 face redraws to
the 0–3 faces actually mid-snap (~10× less idle redraw work), and cheaper/fewer
produced frames let ProMotion-class displays drop refresh — the other half of
the battery win. Single-face pages win ~10× too (lookahead frames go to zero
draws). **Scrub is a strict no-op**: during scrub every face changes every
frame, so the gate never skips; scrub fps is unaffected by construction.

## Design

Skip a face's `renderFrame` when nothing that draws has changed since that
face's last draw:

- Add a per-face dirty flag, set by the updater whenever any ObsValue's
  `currentValue` changes (sweep step, snap step, discrete jump) — the updater
  already touches every value per tick ([updater.ts](../src/shared/updater.ts),
  `updateObsValues` ~777–788; on-beat path ~508–571). Cheapest correct form:
  have `tick()` return / record "any value moved this call", OR-ed into
  `face.renderDirty`.
- Frame loop: `if (face.renderDirty) { renderFrame(...); face.renderDirty =
  false; }` — tick still runs for every face (values must keep advancing;
  only the draw is skipped).
- The gate must be **conservative**: when in doubt, draw. A spurious draw
  costs microwatts; a missed draw is a user-visible stale face.

### Forced-redraw triggers (the real work — audit each)

Set `renderDirty = true` for all faces on anything that changes pixels without
moving an ObsValue:

1. Resize / dpr change (canvas backing realloc + static cache rebuild).
2. `rebuildEnvironments` (DST transition, location/tz change, slot edits).
3. Mode change (front/night), face enable/disable, picks changes.
4. Scrub start AND end (`timeController` state transitions; scrub-end
   must force one full redraw — same rule the investigation doc noted for any
   dirty scheme).
5. Static cache rebuilds (date rollover rebuilds date-dependent statics).
6. Time set/step from the controller UI (display time jumps discontinuously).
7. Anything that mutates appearance caches (hand/wheel/wedge cache
   invalidation paths — these all key on env/resize, covered by 1–2, but
   verify).
8. First frame after `cachesBuilt` flips true.

Audit method: grep every assignment/callsite that today relies on "the next
frame redraws everything anyway" — candidates: `ensureSchedulerRunning`
callers, `setState`/location-dialog apply paths, terra slot editors,
`buildStaticBlockCaches` callers.

### Non-goals

- Do NOT touch the scheduler/lookahead itself (the 50 ms early-wake frames
  become nearly free once they draw nothing; no scheduler surgery needed).
- Do NOT skip `updater.tick()` — values must advance and re-arm wakeups.
- No per-part granularity, no layers — that whole family is rejected (see the
  z-order assessment section; op-count model, memory, correctness).
- No change to scrub behavior at all.

## Verification

1. **Correctness (the main risk):** frozen-time pixel-diff style checks after
   each trigger in the list above — change location, cross a DST boundary,
   resize, scrub then stop, step time, toggle night mode; face must never be
   stale. The dirty-tracking failure mode is visual, so Steve should eyeball
   a session natively too.
2. **Behavior:** instrument temporarily — count face-redraws/s at 1× on
   all.html before/after (expect ~800/s → ~50–100/s on a 60 Hz display;
   exact numbers depend on display Hz).
3. **Energy (the point):** native before/after on Steve's machine, Safari and
   Chrome. No in-repo harness for this; it's a manual reading. VM cannot
   measure this.

   **Protocol (2026-07-10 — Activity Monitor Energy Impact is too noisy for
   this effect; its variance exceeded the A/B difference in practice):**
   - Setup: plugged in, fixed brightness, single frontmost tab, DevTools
     closed, no other apps, `caffeinate -dimsu`, hands off during windows,
     ~60 s warm-up after load. Same URL both builds, no `?drawstats` during
     measurement (use it only to confirm which build is loaded: the gated
     build logs, the old one ignores the flag).
   - Windows: `sudo powermetrics -i 300000 -n 1 --samplers
     cpu_power,gpu_power,tasks --show-process-energy --show-process-gpu -o
     run-<config>-<n>.txt` — one integrated 5-min sample per window, ≥4
     windows per browser in **ABBA order** (counterbalances drift).
   - Read per window: per-process **CPU ms/s + GPU ms/s** for the renderer,
     the browser GPU process, and **WindowServer** (the ProMotion refresh
     drop lands there, not in the browser's rows); package CPU/GPU mW;
     renderer wakeups/s (should be identical across builds — scheduler
     untouched; if not, the window is suspect).
   - Decide on means: real if the A/B gap exceeds within-config spread. If
     spreads overlap, lengthen windows to 10 min rather than adding windows
     (drift dominates, not sample count). Compare integrals, never minima.
4. **Scrub regression check:** one native `[scrub-perf]` baseline run to
   confirm scrub numbers unchanged (gate should be invisible there; check the
   `build N.N.N` stamp as always).
5. Update the stale "2.5% duty cycle" text in
   [docs/architecture-overview.md](../docs/architecture-overview.md) ~148 and
   add the gate to [docs/performance.md](../docs/performance.md)'s idle
   section as implemented.

## Native energy results (Safari, 2026-07-12)

Four 5-minute integrated `powermetrics` windows (protocol above), ABBA order,
one Safari session (same PIDs throughout), all.html idling at 1×. Machine:
Mac15,14, macOS 25F84. Raw output in `run-{dist,base}-{1,2}.txt` (repo root,
untracked); `dist` = gated build 2.0.33, `base` = pre-gate build.

| Metric | dist-1 (15:27) | base-1 (15:42) | base-2 (15:48) | dist-2 (15:54) |
|---|---:|---:|---:|---:|
| **Combined power (mW)** | **6,507** | **18,175** | **18,062** | **6,760** |
| GPU power (mW) | 4,077 | 12,192 | 12,087 | 4,292 |
| CPU power (mW) | 2,429 | 5,983 | 5,975 | 2,468 |
| com.apple.WebKit.GPU (CPU ms/s) | 430 | 1,066 | 1,069 | 429 |
| com.apple.WebKit.WebContent (CPU ms/s) | 183 | 189 | 190 | 186 |
| WindowServer (CPU ms/s) | 315 | 126 | 122 | 319 |
| Safari UI process (CPU ms/s) | 38 | 14 | 14 | 35 |

Reading: **−63% combined package power** (−11.5 W), every dist window beats
every base window ~2.7×, within-config spread ~4%. The win lands where the
design predicted — WebContent (where `tick()` runs) is unchanged (values still
advance every awake frame); the savings is all rendering/compositing (WebKit
GPU process −60% CPU, GPU hardware −65%). WindowServer + Safari UI rose
(~120→~317 and 14→~36 ms/s; more, cheaper commits — costs a couple hundred mW
against the 11.5 W saved), so the win is per-frame canvas work, not a
ProMotion refresh drop. Caveat: a third-party screensaver-as-wallpaper
(`legacyScreenSaver-x86_64`, ~180–310 ms/s) ran in all four windows — roughly
constant, slightly busier in the dist runs (understates the win); disable it
for the Chrome runs.

## Key references

- Frame loop / armIdle / lookahead: [engine-entry.ts](../src/engine-entry.ts)
  ~1588–1783; `SCHEDULER_LOOKAHEAD_MS` [animation.ts:30](../src/shared/animation.ts).
- Updater change-sources: [updater.ts](../src/shared/updater.ts) (`anyAnimating`
  ~946, `nextWakeupTime` ~999, on-beat arrival ~508–571, `updateObsValues`
  ~777–788).
- Idle-behavior findings (cadences per face, duty-cycle math):
  investigation doc, "Z-order layered rendering …" section, by-product note.
- Measurement discipline (native runs, build stamp): docs/performance.md
  "Measuring".
