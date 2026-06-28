/**
 * On-beat resume regression: after reset() while *running* (1×/-1×), an on-beat
 * value must respond instantly — settle to A(current display time) on the first
 * frame — rather than sitting at its now-stale position until its next beat.
 *
 * The pre-fix bug: onBeatStep went straight to onArrivalOnBeat on the first
 * post-reset frame, which evaluates the *next-boundary* target and sits at the
 * old position until `boundaryRealMs − d`. Boundary spacing is the value's
 * updateInterval, so slow hands (large intervals — e.g. planet hands, 3600 s)
 * stayed frozen at the pre-resume/scrubbed position for many seconds while fast
 * hands updated promptly. See updater.ts onBeatStep and
 * planning/2026-06-26-worker-eval-ahead-pipeline.md (§reset step 4).
 */
import { describe, test, expect, vi } from 'vitest';
import { createObsValue } from '../obs-value';
import { Updater, timingContextForFrame, makeOverridableGetNow } from '../updater';
import { TimeController } from '../time-controller';
import type { Environment } from '../../expr/env';

/**
 * Minimal environment whose single function `displayHours()` returns the display
 * time as an angle that advances 2π per hour — a stand-in for a slow hand. The
 * value reads the *current* getNow(), so A(now) tracks display time exactly.
 */
const REF_MS = new Date('2025-06-15T12:00:00.000Z').getTime();
function makeEnv(getNow: () => Date): Environment {
    const functions = new Map<string, (...a: number[]) => number>();
    // Hours of display time elapsed since REF — a linear stand-in for a hand
    // position that tracks display time. Small magnitudes keep the assertions
    // free of angular-wrap confounds (the value below is built `linear: true`),
    // and the slow per-hour rate keeps A(now) ~constant across the test window.
    functions.set('displayValue', () => (getNow().getTime() - REF_MS) / 3_600_000);
    return { functions, variables: new Map() } as unknown as Environment;
}

describe('on-beat resume responds instantly', () => {
    test('a slow-interval on-beat hand tracks A(now) on resume, not its old position', () => {
        let perfNow = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => perfNow);

        const tc = new TimeController();
        const base = () => tc.getDisplayTime();
        const { getNow, withDisplayTime } = makeOverridableGetNow(base);

        // Anchor display time at a fixed instant so A(now) is deterministic.
        const t0 = new Date('2025-06-15T12:00:00.000Z');
        tc.setTime(t0);            // stops the clock at t0
        tc.setOffset(t0.getTime() - Date.now());  // 1× forward, display == t0 now

        const env = makeEnv(getNow);
        // updateInterval 3600 s ⇒ next on-beat boundary up to an hour away: the
        // regime where the pre-fix sit was visible. animSpeed high so the instant
        // settle completes within the advance window.
        const v = createObsValue(
            { name: 'slow', expr: 'displayValue()', updateInterval: 3600, animSpeed: 50,
              linear: true, onBeat: true },
            env, perfNow,
        );
        const u = new Updater();
        u.add(v);

        // Simulate a scrub-end freeze far from "now": the hand is parked at an old
        // angle (as finish() would leave it after scrubbing elsewhere).
        const staleValue = v.evalFn(env) + 5.0;  // 5 units away from A(now)
        v.anim.currentValue = staleValue;
        v.anim.targetValue = staleValue;
        v.anim.animating = false;
        v.currentValue = staleValue;
        v.nextUpdateTime = Infinity;             // frozen, as finish() leaves it
        v.nextUpdateDisplayTime = Infinity;

        // Resume: reset() re-arms, then run frames at 1× forward.
        u.reset();
        const ctx = timingContextForFrame(tc);    // tickIntervalMs null, dir 1

        // First frame after resume: the value must be *animating* toward A(now)
        // (the instant settle), not sitting frozen. The next on-beat boundary is
        // ~3600 s away, so the pre-fix onArrivalOnBeat path would sit here
        // (anim.animating === false) at the stale position.
        perfNow += 16.7;
        u.tick(env, perfNow, getNow, withDisplayTime, ctx);
        expect(v.anim.animating).toBe(true);

        // Within a few hundred ms it reaches A(now) — well under the 3600 s beat
        // boundary the pre-fix code would have waited for. (A(now) is ~constant
        // over this window at the per-hour rate.)
        for (let i = 0; i < 30; i++) {
            perfNow += 16.7;
            u.tick(env, perfNow, getNow, withDisplayTime, ctx);
        }
        // Settled onto A(now) — and far from where it was parked (the pre-fix sit
        // would still read ~staleValue here).
        expect(v.currentValue).toBeCloseTo(v.evalFn(env), 2);
        expect(Math.abs(v.currentValue - staleValue)).toBeGreaterThan(1);

        vi.restoreAllMocks();
    });
});
