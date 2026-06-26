/**
 * hand-values.ts — the Chronometer bridge between the watch part model and the
 * shared ObsValue / Updater system (planning/2026-06-15-chronometer-obsvalue-port.md).
 *
 * `buildHandValues` walks a watch's part tree (the same traversal as the legacy
 * `collectDynamicParts`) and, for each dynamic part, creates the appropriate
 * ObsValue(s) on a per-face `Updater`, storing a direct ObsValue handle on the
 * part for O(1) renderer access (`part._obsAngle.currentValue`, etc.). It replaces
 * the legacy `initHandStates` / `HandState` construction.
 *
 * Naming convention for ObsValue keys: `<faceName>.<partName>.<property>`.
 *
 * Animation policy:
 *   - `discrete: false`; eval-ahead is off (see {@link EVAL_AHEAD}) so hands tick
 *     and snap at `animSpeed` like the legacy `tickAnimations`.
 *   - Angles wrap at 2π; linear motions (xMotion/yMotion, calendar covers, wadokei
 *     slides) are `linear: true` (no wrap).
 *   - `animSpeed` is carried over from the part's XML `animSpeed` (default 1),
 *     scaled to the ObsValue's units/s: 2·xml for angles (kECGLAngleAnimationSpeed),
 *     60·xml for linear (kECGLLinearAnimationSpeed).
 */

import type {
    Watch, WatchPart, QHandPart, WheelPart, QWedgePart, QDialPart,
    CalendarRowCoverPart, QDayNightRingPart,
} from './types.js';
import type { ASTNode } from '../expr/parser.js';
import type { Environment } from '../expr/evaluator.js';
import { evalAttr } from '../shared/astro-env.js';
import { CALENDAR_COVER_CODES } from './watch-env.js';
import type { TerminatorLeafState } from './terminator.js';
import type { AnalemmaState } from './analemma.js';
import { PATH_SAMPLE_COUNT } from './analemma.js';
import { Updater } from '../shared/updater.js';
import {
    type ObsValue, createObsValue, createObsValueFromAST,
} from '../shared/obs-value.js';

/** Base angular animation speed (rad/s) — must match kECGLAngleAnimationSpeed. */
const ANGLE_BASE_SPEED = 2.0;
/** Base linear animation speed (px/s) — must match kECGLLinearAnimationSpeed. */
const LINEAR_BASE_SPEED = 60.0;

/**
 * Whether Chronometer hand values use lag-free eval-ahead.
 *
 * **Off.** Eval-ahead evaluates each value's target at the *next boundary* and
 * sweeps over the whole interval. For watch hands that breaks the mechanical
 * model: a 1-bps hand (update=1s) sweeps the entire second instead of *ticking*,
 * the 1× loop never goes idle (the hand is always mid-sweep), and each scrub
 * frame evaluates astronomy at a *future* time while the env/terminator/analemma
 * evaluate at *now* — thrashing the single astro cache. The non-eval-ahead
 * branches (snap-at-boundary / scrub-compression) are modeled on the legacy
 * `tickAnimations` and reproduce the committed behavior (ticks, 1× idle, single
 * astro time). See planning/2026-06-15-chronometer-obsvalue-port.md.
 */
const EVAL_AHEAD = false;

/**
 * Build the per-face `Updater` and wire ObsValue handles onto every dynamic part.
 * Mirrors the part selection of the legacy `collectDynamicParts`.
 *
 * `lightweight` (default false) skips the per-wedge day/night-ring ObsValues
 * (keeping only the ring's masterOffset). The headless regression bench uses it:
 * the bench only snapshots hand/dial/cover/masterOffset values, so building the
 * (24–75 × 2) wedge ObsValues per ring would be pure cost with no coverage. Wedge
 * values are independent of the hands, so omitting them never changes a hand
 * snapshot. The engine always builds the full set (lightweight = false).
 */
export function buildHandValues(
    faceName: string,
    watch: Watch,
    env: Environment,
    perfNow: number,
    lightweight = false,
): Updater {
    const updater = new Updater();
    collectValues(watch.parts, faceName, env, perfNow, updater, lightweight);
    return updater;
}

function collectValues(
    parts: WatchPart[],
    faceName: string,
    env: Environment,
    perfNow: number,
    updater: Updater,
    lightweight: boolean,
): void {
    for (const part of parts) {
        if (part.type === 'QHand' || part.type === 'Wheel' || part.type === 'QWedge') {
            buildHandPart(part, faceName, env, perfNow, updater);
        } else if (part.type === 'QDial' && part.animSpeed) {
            // QDials with animSpeed participate in the animation system
            // (e.g. Vienna 24-hour number dial with angle='dialFlip').
            buildDialPart(part, faceName, env, perfNow, updater);
        } else if (part.type === 'QDayNightRing') {
            buildDayNightRing(part, faceName, env, perfNow, updater, lightweight);
        } else if (part.type === 'CalendarRowCover') {
            buildCalendarCover(part, faceName, env, perfNow, updater);
        } else if (part.type === 'Static') {
            collectValues(part.children, faceName, env, perfNow, updater, lightweight);
        }
    }
}

/** XML `animSpeed` attribute (default 1.0). */
function xmlAnimSpeed(part: { animSpeed?: ASTNode }, env: Environment): number {
    return part.animSpeed ? evalAttr(part.animSpeed, env) : 1.0;
}

/** Update interval (seconds) from the part's `update` attribute, or a default. */
function updateIntervalSec(part: { update?: ASTNode }, env: Environment, def: number): number {
    return part.update ? evalAttr(part.update, env) : def;
}

/** Create an angle ObsValue (period 2π) from a pre-parsed AST, register it, return it. */
function addAngleValue(
    updater: Updater, name: string, expr: ASTNode, env: Environment, perfNow: number,
    updateInterval: number, animSpeedRadPerSec: number,
): ObsValue {
    return updater.add(createObsValueFromAST({
        name, expr, updateInterval,
        animSpeed: animSpeedRadPerSec,
        evalAhead: EVAL_AHEAD,
    }, env, perfNow));
}

/** Create a linear ObsValue (no wrap) from a pre-parsed AST, register it, return it. */
function addLinearValue(
    updater: Updater, name: string, expr: ASTNode, env: Environment, perfNow: number,
    updateInterval: number, animSpeedPxPerSec: number,
): ObsValue {
    return updater.add(createObsValueFromAST({
        name, expr, updateInterval, linear: true,
        animSpeed: animSpeedPxPerSec,
        evalAhead: EVAL_AHEAD,
    }, env, perfNow));
}

function buildHandPart(
    part: QHandPart | WheelPart | QWedgePart,
    faceName: string, env: Environment, perfNow: number, updater: Updater,
): void {
    const key = (prop: string) => `${faceName}.${part.name}.${prop}`;
    const animS = xmlAnimSpeed(part, env);
    const interval = updateIntervalSec(part, env, 1);

    if (part.angle) {
        part._obsAngle = addAngleValue(
            updater, key('angle'), part.angle, env, perfNow, interval, ANGLE_BASE_SPEED * animS);
    }

    // offsetAngle (offset-orbit hands: Moon, Kyoto japan-hour spokes, Terra date wedges)
    const offsetAngle = (part.type === 'QHand' || part.type === 'QWedge') ? part.offsetAngle : undefined;
    if (offsetAngle) {
        part._obsOffsetAngle = addAngleValue(
            updater, key('offsetAngle'), offsetAngle, env, perfNow, interval, ANGLE_BASE_SPEED * animS);
    }

    // xMotion / yMotion (calendar day-indicator wires) — linear
    if (part.type === 'QHand') {
        if (part.xMotion) {
            part._obsXMotion = addLinearValue(
                updater, key('xMotion'), part.xMotion, env, perfNow, interval, LINEAR_BASE_SPEED * animS);
        }
        if (part.yMotion) {
            part._obsYMotion = addLinearValue(
                updater, key('yMotion'), part.yMotion, env, perfNow, interval, LINEAR_BASE_SPEED * animS);
        }
    }
}

function buildDialPart(
    part: QDialPart, faceName: string, env: Environment, perfNow: number, updater: Updater,
): void {
    if (!part.angle) return;
    const animS = xmlAnimSpeed(part, env);
    const interval = updateIntervalSec(part, env, 1);
    part._obsAngle = addAngleValue(
        updater, `${faceName}.${part.name}.angle`, part.angle, env, perfNow,
        interval, ANGLE_BASE_SPEED * animS);
}

function buildCalendarCover(
    part: CalendarRowCoverPart, faceName: string, env: Environment, perfNow: number, updater: Updater,
): void {
    const animS = xmlAnimSpeed(part, env);
    const interval = updateIntervalSec(part, env, 3600);
    const code = CALENDAR_COVER_CODES[part.coverType ?? ''] ?? 0;
    // Slides smoothly via the calendarCoverOffset env function (linear, not discrete).
    part._obsXMotion = updater.add(createObsValue({
        name: `${faceName}.${part.name}.xMotion`,
        expr: `calendarCoverOffset(${code})`,
        updateInterval: interval,
        linear: true,
        animSpeed: LINEAR_BASE_SPEED * animS,
        evalAhead: EVAL_AHEAD,
    }, env, perfNow));
}

function buildDayNightRing(
    part: QDayNightRingPart, faceName: string, env: Environment, perfNow: number, updater: Updater,
    lightweight: boolean,
): void {
    const key = (prop: string) => `${faceName}.${part.name}.${prop}`;
    const interval = updateIntervalSec(part, env, 5);
    const ringAnimS = 1.0;   // QDayNightRing has no animSpeed attr (default 1.0)

    // masterOffset (ring rotation): Vienna noon/midnight (dialFlip), Kyoto mode.
    // Deliberately NOT eval-ahead: it changes mainly on UI toggles, and must flip
    // at a *constant* animSpeed so the ring stays coherent with the dialFlip dials
    // (which use update='0' ⇒ constant-speed flip). Eval-ahead would tie the flip
    // duration to the ring's update interval (≤5s on Vienna), desyncing them.
    if (part.masterOffset) {
        part._obsMasterOffset = updater.add(createObsValueFromAST({
            name: key('masterOffset'), expr: part.masterOffset, updateInterval: interval,
            animSpeed: ANGLE_BASE_SPEED * ringAnimS,
            evalAhead: false,
        }, env, perfNow));
    }

    // Bench fast-path: skip the (numWedges × 2) per-wedge ObsValues — they don't
    // affect the hand snapshots the regression suite captures.
    if (lightweight) return;

    const numWedges = Math.round(evalAttr(part.numWedges, env)) || 24;
    const planet = Math.round(evalAttr(part.planetNumber, env));
    const slideDistance = part.slideDistance ? evalAttr(part.slideDistance, env) : 0;
    const slideAnimS = part.slideAnimSpeed ? evalAttr(part.slideAnimSpeed, env) : 1.0;

    // Leaf-angle function selection (mirrors drawQDayNightRing): slot routing,
    // LST time base, or plain observer-local.
    const slot = part.envSlot ? evalAttr(part.envSlot, env) : NaN;
    const useSlot = !isNaN(slot);
    const leafFnCall = (i: number): string => {
        if (useSlot) return `dayNightLeafAngleForSlot(${planet}, ${i}, ${numWedges}, ${slot})`;
        if (part.timeBase === 'LST') return `dayNightLeafAngleLST(${planet}, ${i}, ${numWedges})`;
        return `dayNightLeafAngle(${planet}, ${i}, ${numWedges})`;
    };

    const angles: ObsValue[] = [];
    const slides: ObsValue[] = [];
    for (let i = 0; i < numWedges; i++) {
        let angleExpr: string;
        if (slideDistance > 0) {
            // Wadokei slide mode (Kyoto): collective distribution lives in the env
            // function; each wedge reads its own index (no value cache).
            angleExpr = `dayNightWedgeSlideAngle(${planet}, ${i}, ${numWedges}, ${slideDistance})`;
            slides.push(updater.add(createObsValue({
                name: key(`wedgeSlide.${i}`),
                expr: `dayNightWedgeSlideOffset(${i}, ${numWedges}, ${slideDistance})`,
                updateInterval: interval, linear: true,
                animSpeed: LINEAR_BASE_SPEED * slideAnimS,
                evalAhead: EVAL_AHEAD,
            }, env, perfNow)));
        } else {
            angleExpr = leafFnCall(i);
        }
        angles.push(updater.add(createObsValue({
            name: key(`wedgeAngle.${i}`),
            expr: angleExpr,
            updateInterval: interval,
            animSpeed: ANGLE_BASE_SPEED * ringAnimS,
            evalAhead: EVAL_AHEAD,
        }, env, perfNow)));
    }
    part._obsWedgeAngles = angles;
    if (slideDistance > 0) part._obsWedgeSlides = slides;
}

/** A NumberLiteral AST node for the given constant. */
function lit(value: number): ASTNode {
    return { kind: 'NumberLiteral', value };
}

/**
 * Register ObsValues for a face's expanded terminator leaves on the given Updater
 * (Phase 7). Each leaf gets an `angle` ObsValue whose expression composes the
 * part's shared phase expression with the per-leaf terminator math, via the
 * `terminatorLeafAngle(phase, quad, idx, lpq, incr)` env function — so each leaf
 * animates its own angle exactly as the legacy `tickLeafAnimations` did. All
 * leaves of a terminator share one `rotation` ObsValue (the system rotation).
 *
 * Call after `buildHandValues`, once the leaves have been expanded.
 */
export function buildTerminatorValues(
    updater: Updater,
    faceName: string,
    leaves: TerminatorLeafState[],
    env: Environment,
    perfNow: number,
): void {
    if (leaves.length === 0) return;

    // Shared system-rotation ObsValue (same expression for every leaf, matching
    // the legacy code which evaluated rotation once from leaves[0]).
    const rotExpr = leaves[0].rotationExpr;
    const interval = leaves[0].updateIntervalSec;
    let rotation: ObsValue | undefined;
    if (rotExpr) {
        rotation = updater.add(createObsValueFromAST({
            name: `${faceName}.terminator.rotation`, expr: rotExpr,
            updateInterval: interval, animSpeed: ANGLE_BASE_SPEED, evalAhead: EVAL_AHEAD,
        }, env, perfNow));
    }

    leaves.forEach((leaf, i) => {
        const angleExpr: ASTNode = {
            kind: 'FunctionCall',
            name: 'terminatorLeafAngle',
            args: [
                leaf.phaseExpr ?? lit(0),
                lit(leaf.quadrant),
                lit(leaf.indexWithinQuadrant),
                lit(leaf.leavesPerQuadrant),
                lit(leaf.incremental ? 1 : 0),
            ],
        };
        leaf._obsAngle = updater.add(createObsValueFromAST({
            name: `${faceName}.termLeaf.${i}.angle`, expr: angleExpr,
            updateInterval: leaf.updateIntervalSec,
            animSpeed: ANGLE_BASE_SPEED, evalAhead: EVAL_AHEAD,
        }, env, perfNow));
        leaf._obsRotation = rotation;
    });
}

/**
 * Register ObsValues for a face's analemma on the given Updater (Phase 8): the
 * Sun's parametric position along the figure-eight (`pathParam`, a cyclic value
 * with period PATH_SAMPLE_COUNT — so animating across the year-rollover takes the
 * short way) and the disc `rotation` (an angle). The renderer reads
 * `.currentValue` and maps pathParam → (x, y). Mirrors the env functions
 * `analemmaPathParameter()` / `analemmaRotation()`.
 */
export function buildAnalemmaValues(
    updater: Updater,
    faceName: string,
    state: AnalemmaState,
    env: Environment,
    perfNow: number,
): void {
    state._obsPathParam = updater.add(createObsValue({
        name: `${faceName}.analemma.pathParam`,
        expr: 'analemmaPathParameter()',
        updateInterval: state.updateIntervalSec,
        period: PATH_SAMPLE_COUNT,
        animSpeed: ANGLE_BASE_SPEED,
        evalAhead: EVAL_AHEAD,
    }, env, perfNow));
    state._obsRotation = updater.add(createObsValue({
        name: `${faceName}.analemma.rotation`,
        expr: 'analemmaRotation()',
        updateInterval: state.updateIntervalSec,
        animSpeed: ANGLE_BASE_SPEED,
        evalAhead: EVAL_AHEAD,
    }, env, perfNow));
}
