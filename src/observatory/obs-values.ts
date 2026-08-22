/**
 * Observatory expression-driven value system (catalog).
 *
 * Defines the full set of Observatory ObsValues (clock hands, sun events,
 * subdials, planet hands/rings, sun ring, earth view) and builds them into a
 * name-keyed shared `Updater<ObsValueName>` for the renderers.
 *
 * The generic machinery lives in the shared layer:
 *   - `src/shared/obs-value.ts` — the `ObsValue` value type + `createObsValue`
 *   - `src/shared/updater.ts`   — the `Updater` collection + per-frame passes +
 *                                 the controller↔updater `TimingContext` seam
 *
 * This module is purely the Observatory-specific *catalog*: it names every value
 * (`ObsValueName`), builds the definitions, and registers them on an `Updater`.
 * Renderers read values by name via `updater.get(name)`.
 *
 * Architecture:
 *   1. **Build** — parse expression strings into ASTs, evaluate initial values,
 *      register on the `Updater`.
 *   2. **Update pass** — re-evaluate any ObsValue whose timer has expired.
 *   3. **Animate pass** — interpolate every AnimatingValue toward its target.
 *   4. **Draw pass** — renderers read `updater.get(name).currentValue`.
 */

import type { Environment } from '../expr/env.js';
import {
    EC_UPDATE_NEXT_SUNRISE,
    EC_UPDATE_NEXT_SUNSET,
    EC_UPDATE_NEXT_SUNRISE_OR_SUNSET,
    EC_UPDATE_NEXT_PLANET_RISE,
    EC_UPDATE_NEXT_PLANET_SET,
    EC_UPDATE_NEXT_SSLAT_CHANGE,
    EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION,
} from '../shared/animation.js';
import { SunAltitudeKind } from '../shared/astro-env.js';
import { type ObsValueDef, createObsValue } from '../shared/obs-value.js';
import { Updater } from '../shared/updater.js';

// Re-export the ObsValue type so renderers can import it from here.
export type { ObsValue } from '../shared/obs-value.js';

// ============================================================================
// Value names (the key space of the Observatory Updater)
// ============================================================================

/** Planet keys used to prefix the per-planet ring value names. */
export type RingPlanetKey = 'saturn' | 'jupiter' | 'mars' | 'venus' | 'mercury' | 'moon';

/** Ordered ring fields per planet: [rise, set, transit, riseValid, setValid, aboveHorizon]. */
export const RING_FIELDS = ['Rise', 'Set', 'Transit', 'RiseValid', 'SetValid', 'AboveHorizon'] as const;
export type RingField = (typeof RING_FIELDS)[number];

/** Ring value names, e.g. `saturnRise`, `moonAboveHorizon`. */
export type RingValueName = `${RingPlanetKey}${RingField}`;

/**
 * Bodies selectable on the altitude/azimuth peripheral dials, with their
 * `ECPlanetNumber`. Earth (4) is intentionally excluded (matches iOS cycle).
 * The cycle order (Sun→Moon→…→Saturn→Sun) is the click-to-advance order.
 */
export const DIAL_BODIES = [
    { key: 'sun', pn: 0 },
    { key: 'moon', pn: 1 },
    { key: 'mercury', pn: 2 },
    { key: 'venus', pn: 3 },
    { key: 'mars', pn: 5 },
    { key: 'jupiter', pn: 6 },
    { key: 'saturn', pn: 7 },
] as const;
export type DialBodyKey = (typeof DIAL_BODIES)[number]['key'];

/**
 * Sun-ring gradient stop names, in draw order (must stay aligned with
 * `SUN_RING_COLORS` in ring-view.ts). Morning side (night→day), then evening
 * side (day→night), then the noon/midnight anchors.
 */
export const SUN_RING_NAMES = [
    'ring18BelowMorn', 'ring9BelowMorn', 'ring1BelowMorn', 'ringHalfBelowMorn',
    'ring1AboveMorn', 'ring9AboveMorn', 'ring30AboveMorn',
    'ring30AboveEve', 'ring9AboveEve', 'ring1AboveEve', 'ringHalfBelowEve',
    'ring1BelowEve', 'ring9BelowEve', 'ring18BelowEve',
    'ringNoon', 'ringMidnight',
] as const;
export type SunRingName = (typeof SUN_RING_NAMES)[number];

/** Every name in the Observatory value catalog (the `Updater` key space). */
export type ObsValueName =
    // Main dial clock hands
    | 'h24' | 'h12' | 'minute' | 'second'
    // Sun event hands
    | 'sunrise' | 'sunset' | 'goldenMorning' | 'goldenEvening'
    | 'civilTwiMorning' | 'civilTwiEvening' | 'nautTwiMorning' | 'nautTwiEvening'
    | 'astroTwiMorning' | 'astroTwiEvening' | 'solarNoon' | 'solarMidnight'
    // UTC subdial
    | 'utcHour' | 'utcMinute' | 'utcSecond'
    // Solar subdial
    | 'solarHour' | 'solarMinute' | 'solarSecond'
    // Sidereal subdial
    | 'sidHour' | 'sidMinute' | 'sidSecond'
    // Planet hands
    | 'saturnHand' | 'jupiterHand' | 'marsHand' | 'earthHand'
    | 'venusHand' | 'mercuryHand' | 'moonOffset'
    // Planet rings (6 per planet)
    | RingValueName
    // Sun ring gradient stops
    | SunRingName
    // Earth view (sub-solar point)
    | 'earthSslat' | 'earthSslng'
    // Moon phase display
    | 'moonPhase' | 'moonRotation' | 'moonDistAU'
    // Peripheral dials: selected-body altitude/azimuth + EOT hand
    | 'dialAlt' | 'dialAz' | 'eotAngle'
    // Eclipse simulator: disc geometry (10) + ring-hand RA markers (3)
    | 'eclSeparation' | 'eclShadowSize' | 'eclKind'
    | 'eclSunAlt' | 'eclSunAz' | 'eclMoonAlt' | 'eclMoonAz'
    | 'eclSunDist' | 'eclMoonDist' | 'eclMoonRelAngle'
    | 'eclRingSunRA' | 'eclRingMoonRA' | 'eclRingNodeRA';

// ============================================================================
// Expression definitions
// ============================================================================

/**
 * Build the full catalog of ObsValue definitions as a single flat list.
 *
 * Expression strings reference functions registered in astro-env.ts.
 * The `noonOnTop` variable (0 or 1) is set in the environment.
 */
function buildValueDefs(): ObsValueDef[] {
    // SunAltitudeKind enum values for expression args
    const SK = SunAltitudeKind;

    // Planet numbers (matching ECPlanetNumber)
    const SATURN = 7, JUPITER = 6, MARS = 5, VENUS = 3, MERCURY = 2, MOON = 1;

    // Second hands sweep at exactly one revolution per 60 seconds.
    const SECOND_NATURAL_SPEED = 2 * Math.PI / 60;  // rad/s

    const clock: ObsValueDef[] = [
        { name: 'h24',    expr: 'hour24ValueAngle() + pi * noonOnTop', updateInterval: 15 },
        { name: 'h12',    expr: 'hour12ValueAngle()',                  updateInterval: 1 },
        { name: 'minute', expr: 'minuteValueAngle()',                  updateInterval: 1 },
        { name: 'second', expr: 'secondValueAngle()',                  updateInterval: 20, naturalSpeed: SECOND_NATURAL_SPEED },
    ];

    const sunEvents: ObsValueDef[] = [
        // Sunrise updates when time crosses sunset (and vice versa)
        // Morning events update at next sunset; evening events at next sunrise.
        // This matches iOS: sunriseForDay changes when time passes through
        // the point 180° from the observer.
        { name: 'sunrise',          expr: `sunSpecialAngle(${SK.SunRiseMorning}) + pi * noonOnTop`,          updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'sunset',           expr: `sunSpecialAngle(${SK.SunSetEvening}) + pi * noonOnTop`,           updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'goldenMorning',    expr: `sunSpecialAngle(${SK.SunGoldenHourMorning}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'goldenEvening',    expr: `sunSpecialAngle(${SK.SunGoldenHourEvening}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'civilTwiMorning',  expr: `sunSpecialAngle(${SK.SunCivilTwilightMorning}) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'civilTwiEvening',  expr: `sunSpecialAngle(${SK.SunCivilTwilightEvening}) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'nautTwiMorning',   expr: `sunSpecialAngle(${SK.SunNauticalTwilightMorning}) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'nautTwiEvening',   expr: `sunSpecialAngle(${SK.SunNauticalTwilightEvening}) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'astroTwiMorning',  expr: `sunSpecialAngle(${SK.SunAstroTwilightMorning}) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'astroTwiEvening',  expr: `sunSpecialAngle(${SK.SunAstroTwilightEvening}) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'solarNoon',        expr: 'solarNoonAngle24h() + pi * noonOnTop',     updateInterval: EC_UPDATE_NEXT_SUNRISE_OR_SUNSET },
        { name: 'solarMidnight',    expr: 'solarNoonAngle24h() + pi + pi * noonOnTop', updateInterval: EC_UPDATE_NEXT_SUNRISE_OR_SUNSET },
    ];

    const utc: ObsValueDef[] = [
        // UTC subdial is 24h
        { name: 'utcHour',   expr: 'fmod((hour24Value() - tzOffset() / 3600), 24) * 2 * pi / 24 + pi * noonOnTop', updateInterval: 60 },
        { name: 'utcMinute', expr: 'utcMinuteAngle()', updateInterval: 15 },
        { name: 'utcSecond', expr: 'utcSecondAngle()', updateInterval: 20, naturalSpeed: SECOND_NATURAL_SPEED },
    ];

    const solar: ObsValueDef[] = [
        // Solar subdial is 12h
        { name: 'solarHour',   expr: 'fmod(solarTimeSec() / 3600, 12) * 2 * pi / 12', updateInterval: 60 },
        { name: 'solarMinute', expr: 'fmod(solarTimeSec() / 60, 60) * 2 * pi / 60',   updateInterval: 15 },
        { name: 'solarSecond', expr: 'fmod(solarTimeSec(), 60) * 2 * pi / 60',         updateInterval: 20, naturalSpeed: SECOND_NATURAL_SPEED },
    ];

    const sidereal: ObsValueDef[] = [
        // Sidereal subdial is 24h
        { name: 'sidHour',   expr: 'fmod(lstValue() / 3600, 24) * 2 * pi / 24', updateInterval: 60 },
        { name: 'sidMinute', expr: 'fmod(lstValue() / 60, 60) * 2 * pi / 60',   updateInterval: 15 },
        { name: 'sidSecond', expr: 'fmod(lstValue(), 60) * 2 * pi / 60',         updateInterval: 20, naturalSpeed: SECOND_NATURAL_SPEED },
    ];

    const planets: ObsValueDef[] = [
        { name: 'saturnHand',  expr: `-HLongitudeOfPlanet(${SATURN})`,  updateInterval: 3600 },
        { name: 'jupiterHand', expr: `-HLongitudeOfPlanet(${JUPITER})`, updateInterval: 3600 },
        { name: 'marsHand',    expr: `-HLongitudeOfPlanet(${MARS})`,    updateInterval: 3600 },
        { name: 'earthHand',   expr: '-HLongitudeOfPlanet(4)',          updateInterval: 3600 },  // Earth = 4
        { name: 'venusHand',   expr: `-HLongitudeOfPlanet(${VENUS})`,   updateInterval: 3600 },
        { name: 'mercuryHand', expr: `-HLongitudeOfPlanet(${MERCURY})`, updateInterval: 3600 },
        { name: 'moonOffset',  expr: '-moonAgeAngle() + pi',            updateInterval: 3600 },
    ];

    // Planet rings: 6 values each (rise, set, transit, riseValid, setValid, aboveHorizon)
    const ringPlanets: { key: RingPlanetKey; pn: number }[] = [
        { key: 'saturn',  pn: SATURN },
        { key: 'jupiter', pn: JUPITER },
        { key: 'mars',    pn: MARS },
        { key: 'venus',   pn: VENUS },
        { key: 'mercury', pn: MERCURY },
        { key: 'moon',    pn: MOON },
    ];

    const rings: ObsValueDef[] = [];
    for (const { key, pn } of ringPlanets) {
        // Ring rise angle updates at next planet set (and vice versa)
        // Transit updates at whichever rise/set comes first
        // Validity/polar flags update at the same cadence as their corresponding angle
        rings.push(
            { name: `${key}Rise`,         expr: `dayNightLeafAngle(${pn}, 0, 0) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_PLANET_SET(pn) },
            { name: `${key}Set`,          expr: `dayNightLeafAngle(${pn}, 1, 0) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_PLANET_RISE(pn) },
            { name: `${key}Transit`,      expr: `planetTransitAngle(${pn}) + pi * noonOnTop`,      updateInterval: EC_UPDATE_NEXT_PLANET_SET(pn) },
            { name: `${key}RiseValid`,    expr: `dayNightLeafAngleIsRiseSet(${pn}, 0)`,             updateInterval: EC_UPDATE_NEXT_PLANET_SET(pn) },
            { name: `${key}SetValid`,     expr: `dayNightLeafAngleIsRiseSet(${pn}, 1)`,             updateInterval: EC_UPDATE_NEXT_PLANET_RISE(pn) },
            { name: `${key}AboveHorizon`, expr: `dayNightLeafAngleAboveHorizon(${pn}, 0)`,          updateInterval: EC_UPDATE_NEXT_PLANET_SET(pn) },
        );
    }

    // Sun ring gradient stops — angular positions for fixed-color stops.
    // Each stop represents where the sun crosses a specific altitude threshold.
    // Morning stops update at sunset; evening stops at sunrise (same as hands).
    // Noon/midnight anchors update at either event.
    //
    // Epsilon for the sunrise/sunset color-stop boundary.  Larger values
    // widen the sharp cyan→red transition band around the sunrise/sunset hand.
    // 0.001 rad ≈ 0.23 time-minutes (≈ 14 time-seconds).
    const SUNSET_EPSILON = 0.001;
    const sunRing: ObsValueDef[] = [
        // Morning side (night → day): update at next sunset
        { name: 'ring18BelowMorn',   expr: `sunSpecialAngle(${SK.SunRing18BelowMorning}) + pi * noonOnTop`,   updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ring9BelowMorn',    expr: `sunSpecialAngle(${SK.SunRing9BelowMorning}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ring1BelowMorn',    expr: `sunSpecialAngle(${SK.SunRiseMorning}) + pi * noonOnTop - ${SUNSET_EPSILON}`,  updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ringHalfBelowMorn', expr: `sunSpecialAngle(${SK.SunRiseMorning}) + pi * noonOnTop + ${SUNSET_EPSILON}`,  updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ring1AboveMorn',    expr: `sunSpecialAngle(${SK.SunRing1AboveMorning}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ring9AboveMorn',    expr: `sunSpecialAngle(${SK.SunRing9AboveMorning}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ring30AboveMorn',   expr: `sunSpecialAngle(${SK.SunRing30AboveMorning}) + pi * noonOnTop`,   updateInterval: EC_UPDATE_NEXT_SUNSET },
        // Evening side (day → night): update at next sunrise
        { name: 'ring30AboveEve',    expr: `sunSpecialAngle(${SK.SunRing30AboveEvening}) + pi * noonOnTop`,   updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ring9AboveEve',     expr: `sunSpecialAngle(${SK.SunRing9AboveEvening}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ring1AboveEve',     expr: `sunSpecialAngle(${SK.SunRing1AboveEvening}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ringHalfBelowEve',  expr: `sunSpecialAngle(${SK.SunSetEvening}) + pi * noonOnTop - ${SUNSET_EPSILON}`,   updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ring1BelowEve',     expr: `sunSpecialAngle(${SK.SunSetEvening}) + pi * noonOnTop + ${SUNSET_EPSILON}`,   updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ring9BelowEve',     expr: `sunSpecialAngle(${SK.SunRing9BelowEvening}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ring18BelowEve',    expr: `sunSpecialAngle(${SK.SunRing18BelowEvening}) + pi * noonOnTop`,   updateInterval: EC_UPDATE_NEXT_SUNRISE },
        // Anchor points: solar noon and midnight (positions always valid, colors computed at render time)
        { name: 'ringNoon',     expr: 'solarNoonAngle24h() + pi * noonOnTop',      updateInterval: EC_UPDATE_NEXT_SUNRISE_OR_SUNSET },
        { name: 'ringMidnight', expr: 'solarNoonAngle24h() + pi + pi * noonOnTop',  updateInterval: EC_UPDATE_NEXT_SUNRISE_OR_SUNSET },
    ];

    // Earth view defs use a different sentinel and are linear (radians) where
    // they don't wrap.
    const earth: ObsValueDef[] = [
        // subSolarLatitude changes slowly; the sentinel binary-searches for
        // when it changes by ≥0.1° (see nextSslatChange in animation.ts).
        { name: 'earthSslat', expr: 'subSolarLatitude()', updateInterval: EC_UPDATE_NEXT_SSLAT_CHANGE, linear: true },
        // subSolarLongitude changes ~1°/4min; update every 60s.
        // NOT linear — sslng is angular and wraps at ±π (dateline).
        { name: 'earthSslng', expr: 'subSolarLongitude()', updateInterval: 60 },
    ];

    // Moon phase display (big moon in the header — port of EOMoonView).
    const moon: ObsValueDef[] = [
        // Terminator phase angle (0=new … π=full). Wraps at 2π → NOT linear.
        { name: 'moonPhase',    expr: 'moonAgeAngle()',      updateInterval: 60 },
        // View rotation (sky orientation). Angular, wraps → NOT linear.
        { name: 'moonRotation', expr: 'moonRelativeAngle()', updateInterval: 60 },
        // Apparent-size driver: geocentric distance in AU. Slowly varying → linear.
        { name: 'moonDistAU',   expr: `distanceFromEarthOfPlanet(${MOON})`, updateInterval: 3600, linear: true },
    ];

    // Peripheral dials. The altitude/azimuth hands track a single selected body,
    // chosen via the `dialPlanet` env variable (set by the entry point, like
    // `noonOnTop`). Using one value per axis — rather than one per body — means a
    // planet switch *moves the target*, so `updater.reset()` animates the hand to
    // the new body (the same sweep used for a location change), instead of
    // snapping by swapping which value is read.
    const dials: ObsValueDef[] = [
        // Altitude ∈ [−π/2, +π/2]; iOS maps EOAltitude → planetAltitude − π/2.
        // `linear` so it isn't fmod-wrapped into [0, 2π).
        { name: 'dialAlt', expr: 'altitudeOfPlanet(dialPlanet) - pi/2', updateInterval: 60, linear: true },
        // Azimuth is angular (wraps at 2π → shortest-path animation).
        { name: 'dialAz',  expr: 'azimuthOfPlanet(dialPlanet)',         updateInterval: 60 },
        // EOT hand: 24·EOTAngle() matches the Mauna Kea/Vienna dial's π/30-per-minute scale.
        { name: 'eotAngle', expr: '24 * EOTAngle()', updateInterval: 3600 },
    ];

    // Eclipse simulator (Phase 7B). Every value shares the eclipse sentinel so
    // the whole disc re-evaluates on one tick → mutually consistent geometry.
    // The sentinel yields ~1 s cadence while the disc is drawn (separation < 10°)
    // and a capped (≤1 h) cadence while only the caption shows.
    const SUN = 0;
    const eclipse: ObsValueDef[] = [
        // Disc geometry (10)
        { name: 'eclSeparation',   expr: 'eclipseAngularSeparation()',          updateInterval: EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION, linear: true },
        { name: 'eclShadowSize',   expr: 'eclipseShadowAngularSize()',          updateInterval: EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION, linear: true },
        // Enum 0..8 — snap (discrete), read via Math.round.
        { name: 'eclKind',         expr: 'eclipseKindRaw()',                    updateInterval: EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION, linear: true, discrete: true },
        { name: 'eclSunAlt',       expr: `altitudeOfPlanet(${SUN})`,            updateInterval: EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION, linear: true },
        { name: 'eclSunAz',        expr: `azimuthOfPlanet(${SUN})`,             updateInterval: EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION },
        { name: 'eclMoonAlt',      expr: `altitudeOfPlanet(${MOON})`,           updateInterval: EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION, linear: true },
        { name: 'eclMoonAz',       expr: `azimuthOfPlanet(${MOON})`,            updateInterval: EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION },
        // Topocentric, not geocentric: these size the drawn discs, and the
        // Moon's is up to 1.7% larger overhead — enough to turn a total eclipse
        // into a drawn hairline annulus. Matches the classification in
        // calculateEclipse by construction. (Both vary on the diurnal
        // timescale, so they stay safe to interpolate `linear`.)
        { name: 'eclSunDist',      expr: `distanceFromObserverOfPlanet(${SUN})`,   updateInterval: EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION, linear: true },
        { name: 'eclMoonDist',     expr: `distanceFromObserverOfPlanet(${MOON})`,  updateInterval: EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION, linear: true },
        { name: 'eclMoonRelAngle', expr: 'moonRelativeAngle()',                 updateInterval: EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION },
        // Ring-hand RA markers (3) — angular (wrap at 2π)
        { name: 'eclRingSunRA',    expr: `RAOfPlanet(${SUN})`,                  updateInterval: EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION },
        { name: 'eclRingMoonRA',   expr: `RAOfPlanet(${MOON})`,                 updateInterval: EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION },
        { name: 'eclRingNodeRA',   expr: 'lunarAscendingNodeRA()',             updateInterval: EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION },
    ];

    return [
        ...clock, ...sunEvents, ...utc, ...solar, ...sidereal,
        ...planets, ...rings, ...sunRing, ...earth, ...moon, ...dials, ...eclipse,
    ];
}

// ============================================================================
// Build
// ============================================================================

/**
 * The complete set of expected value names, derived from the structured name
 * constants. Used as a startup assertion to guarantee every `ObsValueName` is
 * registered exactly once (catches typos / drift between the defs and the type).
 */
function expectedNames(): ObsValueName[] {
    const ringPlanets: RingPlanetKey[] = ['saturn', 'jupiter', 'mars', 'venus', 'mercury', 'moon'];
    const rings: RingValueName[] = [];
    for (const key of ringPlanets) {
        for (const field of RING_FIELDS) rings.push(`${key}${field}`);
    }
    return [
        'h24', 'h12', 'minute', 'second',
        'sunrise', 'sunset', 'goldenMorning', 'goldenEvening',
        'civilTwiMorning', 'civilTwiEvening', 'nautTwiMorning', 'nautTwiEvening',
        'astroTwiMorning', 'astroTwiEvening', 'solarNoon', 'solarMidnight',
        'utcHour', 'utcMinute', 'utcSecond',
        'solarHour', 'solarMinute', 'solarSecond',
        'sidHour', 'sidMinute', 'sidSecond',
        'saturnHand', 'jupiterHand', 'marsHand', 'earthHand',
        'venusHand', 'mercuryHand', 'moonOffset',
        ...rings,
        ...SUN_RING_NAMES,
        'earthSslat', 'earthSslng',
        'moonPhase', 'moonRotation', 'moonDistAU',
        'dialAlt', 'dialAz', 'eotAngle',
        'eclSeparation', 'eclShadowSize', 'eclKind',
        'eclSunAlt', 'eclSunAz', 'eclMoonAlt', 'eclMoonAz',
        'eclSunDist', 'eclMoonDist', 'eclMoonRelAngle',
        'eclRingSunRA', 'eclRingMoonRA', 'eclRingNodeRA',
    ];
}

/**
 * Build all Observatory dynamic values and register them on a name-keyed
 * `Updater`.
 *
 * Parses expression strings, evaluates initial values, sets up animation state
 * and scheduling for every value, and asserts the full `ObsValueName` catalog is
 * present exactly once.
 */
export function buildObsValues(
    env: Environment,
    perfNow: number,
    getNow: () => Date,
): Updater<ObsValueName> {
    const updater = new Updater<ObsValueName>();
    for (const def of buildValueDefs()) {
        updater.add(createObsValue(def, env, perfNow, getNow));
    }

    // Startup assertion: every expected name resolves, and nothing extra/missing.
    const expected = expectedNames();
    const seen = new Set<string>();
    for (const v of updater.all) {
        if (seen.has(v.name)) throw new Error(`[ObsValues] Duplicate value name: ${v.name}`);
        seen.add(v.name);
    }
    for (const name of expected) {
        if (!updater.has(name)) throw new Error(`[ObsValues] Missing value: ${name}`);
    }
    if (seen.size !== expected.length) {
        const expectedSet = new Set<string>(expected);
        const extra = [...seen].filter(n => !expectedSet.has(n));
        throw new Error(`[ObsValues] Unexpected value(s): ${extra.join(', ')}`);
    }

    return updater;
}
