/**
 * Regression harness for the drag-time "second-hand dance".
 *
 * Drives the real Updater + Observatory values through the app's exact
 * drag frame sequence (map drag with display time held): per move frame a
 * fresh env + reset() + tickFixedDuration(env, perfNow, 300); interleaved
 * hold frames run animateOnly(). Time-driven hands (civil/UTC second,
 * civil minute) must not move at all — their eval is a pure function of
 * the held display time.
 *
 * History: the dance had two causes. (1) tzOffsetSecondsAt returned the
 * offset 1s low when the queried instant's ms fraction exceeded 500ms, and
 * the per-tz window memo served the poisoned value to later queries — so
 * zones first queried at unlucky fractions disagreed with clean zones by a
 * second, and every civil hand hopped at timezone crossings (the
 * absolute-truth test below fails on that code). (2) With that fixed,
 * civil targets are constant, and constant targets start no animation.
 */
import { describe, test, expect } from 'vitest';
import { createAstroEnvironment } from '../shared/astro-env';
import { makeOverridableGetNow } from '../shared/updater';
import { buildObsValues } from '../observatory/obs-values';

const FRAME_MS = 1000 / 240;  // 240Hz frames, like the native machine

function span(track: number[]): number {
    return Math.max(...track) - Math.min(...track);
}

/** Count direction reversals beyond a small epsilon (the "dance" metric). */
function reversals(track: number[], eps = 1e-9): number {
    let dir = 0, count = 0;
    for (let i = 1; i < track.length; i++) {
        const d = track[i] - track[i - 1];
        if (Math.abs(d) < eps) continue;
        const s = Math.sign(d);
        if (dir !== 0 && s !== dir) count++;
        dir = s;
    }
    return count;
}

/**
 * Run the app's drag sequence and return per-hand value + target tracks.
 * Pre-drag runs 1s of normal ticks with real advancing time, then time is
 * held (the map-drag display hold) and the drag begins: a pointer move
 * every other 240Hz frame, longitude wiggling across ~30°, tz alternating
 * between two whole-hour zones (city-hopping).
 *
 * Callers pass timezones not used elsewhere in this file: the tz offset
 * memo is module-global, and the regression being guarded is sensitive to
 * the ms fraction of the FIRST query a zone ever sees.
 */
function runDrag(held: Date, tzA: string, tzB: string) {
    let liveMs = held.getTime() - 1000;
    let heldMs: number | null = null;
    const { getNow, withDisplayTime } = makeOverridableGetNow(
        () => new Date(heldMs ?? liveMs));
    let perfNow = 100_000;

    let env = createAstroEnvironment(40.7, -74.0, getNow, tzA);
    const updater = buildObsValues(env, perfNow, getNow);

    // Pre-drag: normal running with advancing time.
    const ctx1x = { tickIntervalMs: null, displayDeltaSec: 0, direction: 1 as const };
    for (let i = 0; i < 240; i++) {
        perfNow += FRAME_MS;
        liveMs += FRAME_MS;
        updater.tick(env, perfNow, getNow, withDisplayTime, ctx1x);
    }

    heldMs = liveMs;  // pointerdown: display hold begins

    const watch = ['second', 'minute', 'utcSecond',
                   'solarSecond', 'solarMinute', 'sidSecond'] as const;
    const tracks: Record<string, number[]> = {};
    const targets: Record<string, number[]> = {};
    for (const n of watch) { tracks[n] = []; targets[n] = []; }

    for (let i = 0; i < 480; i++) {
        perfNow += FRAME_MS;
        liveMs += FRAME_MS;  // real time flows beneath the hold
        if (i % 2 === 0) {
            const lon = -74.0 + 15 * Math.sin(i / 40);
            const tz = i % 4 === 0 ? tzA : tzB;
            env = createAstroEnvironment(40.7, lon, getNow, tz);
            updater.reset();
            updater.tickFixedDuration(env, perfNow, 300);
            for (const n of watch) targets[n].push(updater.get(n).evalFn(env));
        } else {
            updater.animateOnly(perfNow);
        }
        for (const n of watch) tracks[n].push(updater.get(n).currentValue);
    }
    return { tracks, targets, heldMs };
}

const radPerSec = 2 * Math.PI / 60;   // second-hand radians per time-second

describe('map drag with held display time', () => {
    test('civil/UTC hands stay put; solar hands may track longitude', () => {
        const { tracks } = runDrag(new Date('2026-07-15T18:20:33.400Z'),
            'America/New_York', 'America/Chicago');

        // Civil + UTC second hands: dead still (their eval is location-free).
        // Allow the one-time sub-second settle from the pre-drag beat position.
        for (const n of ['second', 'utcSecond'] as const) {
            const settled = tracks[n].slice(120);
            const moveSec = span(settled) / radPerSec;
            expect(moveSec, `${n} moved ${moveSec.toFixed(3)}s, reversals=${reversals(settled)}`)
                .toBeLessThan(0.05);
        }
        // Civil minute: whole-hour tz hops leave it unchanged too.
        expect(span(tracks['minute'].slice(120)) / radPerSec).toBeLessThan(0.05);

        // Sanity: the harness is live — solar hands DO respond to longitude.
        expect(span(tracks['solarMinute'])).toBeGreaterThan(0.01);
    });

    test.each([
        // [held ms fraction, tz pair] — .7 poisoned the tz offset memo before
        // the rawTzOffsetSecondsAt truncation fix; .4 was always clean.
        [new Date('2026-07-15T18:20:33.400Z'), 'America/Denver', 'America/Toronto'],
        [new Date('2026-07-15T18:20:33.700Z'), 'Europe/Madrid', 'Europe/Rome'],
    ])('civil second target equals the held instant exactly (held=%s)', (held, tzA, tzB) => {
        const { targets } = runDrag(held, tzA, tzB);
        // All tz offsets are whole minutes, so the local seconds equal the
        // held instant's UTC seconds — for every move, in both zones.
        const truthSec = held.getUTCSeconds() + held.getUTCMilliseconds() / 1000;
        for (const t of targets['second']) {
            expect(Math.abs(t / radPerSec - truthSec)).toBeLessThan(1e-6);
        }
    });
});
