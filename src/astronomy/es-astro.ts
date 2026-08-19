/**
* Core astronomy functions for Haleakala: Sun/Moon altitude/azimuth, Moon age, EOT.
*
* Ported from ESAstronomy.cpp. All functions are stateless (pure functions
* taking a cache parameter), following the same pattern as the WB modules.
*
* Angles in radians, times in Apple epoch seconds.
*/

import {
    fmod,
    ECPlanetNumber,
    ECWBPrecision,
    kECAUInKilometers,
    kECUnixToAppleEpochOffset,
    kECLimitingAzimuthLatitude,
    kECRefractionAtHorizonX,
} from './astro-constants';
import { AstroCache, CacheSlot, AstroCachePool } from './astro-cache';
import { julianCenturiesSince2000EpochForDateInterval } from './es-time';
import { convertUTToGSTP03, convertGSTtoLST, convertGSTtoUTclosest } from './es-sidereal';
import {
    sunRAandDecl,
    moonRAAndDecl,
    sunEclipticLongitudeForDate,
    topocentricParallax,
    distanceOfPlanetInAU,
    planetSizeAndParallax,
    altitudeAtRiseSet,
    generalObliquity,
} from './es-coordinates';
import { WB_sunLongitudeApparent, WB_sunRAAndDecl } from './wb-sun';
import { WB_MoonDistance, WB_MoonAscendingNodeLongitude } from './wb-moon';
import { WB_planetApparentPosition } from './willmann-bell';

const TWO_PI = Math.PI * 2;

// ============================================================================
// Planet altitude / azimuth (general function)
// ============================================================================

/**
 * Calculate altitude or azimuth for a planet (including Sun and Moon).
 *
 * @param planetNumber - ECPlanetNumber value
 * @param calculationDateInterval - Apple epoch seconds
 * @param observerLatitude - Observer latitude in radians
 * @param observerLongitude - Observer longitude in radians (east positive)
 * @param correctForParallax - Whether to apply topocentric parallax correction
 * @param altNotAz - true for altitude, false for azimuth
 * @param cache - AstroCache or null
 */
export function planetAltAz(
    planetNumber: number,
    calculationDateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    correctForParallax: boolean,
    altNotAz: boolean,
    cache: AstroCache | null,
): number {
    const altSlotBase = CacheSlot.planetAltitude;
    const azSlotBase = CacheSlot.planetAzimuth;
    const slotBase = altNotAz ? altSlotBase : azSlotBase;

    if (cache && cache.isValid(slotBase + planetNumber)) {
        return cache.get(slotBase + planetNumber);
    }

    // Clamp latitude to avoid singularity at poles
    if (observerLatitude > kECLimitingAzimuthLatitude) {
        observerLatitude = kECLimitingAzimuthLatitude;
    } else if (observerLatitude < -kECLimitingAzimuthLatitude) {
        observerLatitude = -kECLimitingAzimuthLatitude;
    }

    let planetRightAscension: number;
    let planetDeclination: number;
    let planetGeocentricDistance: number;

    // Get planet RA/Decl
    if (planetNumber === ECPlanetNumber.Sun) {
        const sunResult = sunRAandDecl(calculationDateInterval, cache);
        planetRightAscension = sunResult.rightAscension;
        planetDeclination = sunResult.declination;
        const { julianCenturiesSince2000Epoch } =
            julianCenturiesSince2000EpochForDateInterval(calculationDateInterval, cache);
        planetGeocentricDistance = distanceOfPlanetInAU(
            ECPlanetNumber.Sun, julianCenturiesSince2000Epoch, cache,
        );
    } else if (planetNumber === ECPlanetNumber.Moon) {
        const moonResult = moonRAAndDecl(calculationDateInterval, cache);
        planetRightAscension = moonResult.rightAscension;
        planetDeclination = moonResult.declination;
        const { julianCenturiesSince2000Epoch } =
            julianCenturiesSince2000EpochForDateInterval(calculationDateInterval, cache);
        planetGeocentricDistance = distanceOfPlanetInAU(
            ECPlanetNumber.Moon, julianCenturiesSince2000Epoch, cache,
        );
    } else {
        // For other planets, use the cached RA/Decl if available
        if (cache && cache.isValid(CacheSlot.planetRA + planetNumber)) {
            planetRightAscension = cache.get(CacheSlot.planetRA + planetNumber);
            planetDeclination = cache.get(CacheSlot.planetDecl + planetNumber);
            planetGeocentricDistance = cache.get(CacheSlot.planetGeocentricDistance + planetNumber);
        } else {
            // Compute RA/Decl for planets Mercury–Neptune via WB_planetApparentPosition
            const { julianCenturiesSince2000Epoch } =
                julianCenturiesSince2000EpochForDateInterval(calculationDateInterval, cache);
            const U = julianCenturiesSince2000Epoch / 100;
            const pos = WB_planetApparentPosition(planetNumber as ECPlanetNumber, U);
            planetRightAscension = pos.apparentRightAscension;
            planetDeclination = pos.apparentDeclination;
            planetGeocentricDistance = distanceOfPlanetInAU(
                planetNumber as ECPlanetNumber, julianCenturiesSince2000Epoch, cache,
            );
            if (cache) {
                cache.set(CacheSlot.planetRA + planetNumber, planetRightAscension);
                cache.set(CacheSlot.planetDecl + planetNumber, planetDeclination);
                cache.set(CacheSlot.planetGeocentricDistance + planetNumber, planetGeocentricDistance);
            }
        }
    }

    // Compute hour angle
    const gst = convertUTToGSTP03(calculationDateInterval, cache);
    const lst = convertGSTtoLST(gst, observerLongitude);
    let planetHourAngle = lst - planetRightAscension;

    // Apply topocentric parallax if requested
    if (correctForParallax) {
        const { Hprime, declPrime } = topocentricParallax(
            planetRightAscension, planetDeclination, planetHourAngle,
            planetGeocentricDistance, observerLatitude, 0,
        );
        planetDeclination = declPrime;
        planetHourAngle = Hprime;
    }

    // Compute altitude and azimuth
    const sinAlt = Math.sin(planetDeclination) * Math.sin(observerLatitude)
        + Math.cos(planetDeclination) * Math.cos(observerLatitude) * Math.cos(planetHourAngle);
    const planetAzimuth = Math.atan2(
        -Math.cos(planetDeclination) * Math.cos(observerLatitude) * Math.sin(planetHourAngle),
        Math.sin(planetDeclination) - Math.sin(observerLatitude) * sinAlt,
    );
    const planetAltitude = Math.asin(sinAlt);

    // Cache both values
    if (cache) {
        cache.set(CacheSlot.planetAltitude + planetNumber, planetAltitude);
        cache.set(CacheSlot.planetAzimuth + planetNumber, planetAzimuth);
    }

    return altNotAz ? planetAltitude : planetAzimuth;
}

// ============================================================================
// Cacheless planet altitude (for iterative computations)
// ============================================================================

/**
 * Compute planet altitude at an arbitrary time without using any cache.
 *
 * Port of: cachelessPlanetAlt(planetNumber, dateInterval, lat, lng)
 * from ESAstronomy.cpp L1190–1222.
 *
 * Uses WB_planetApparentPosition to get RA/Dec, then computes altitude
 * from hour angle, declination, and observer latitude. No parallax
 * correction is applied (the original iOS code has a commented-out
 * parallax section noting the difference for the Sun is ~4e-5 radians).
 *
 * Designed for iterative computations (e.g., Sun altitude ring) where
 * each call is at a different time, making caching unhelpful.
 *
 * @param planetNumber  ECPlanetNumber enum value
 * @param dateInterval  Apple epoch time interval
 * @param observerLatitude   Observer latitude in radians
 * @param observerLongitude  Observer longitude in radians (east positive)
 * @returns Altitude in radians
 */
export function cachelessPlanetAlt(
    planetNumber: number,
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
): number {
    const { julianCenturiesSince2000Epoch } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, null);
    const tau = julianCenturiesSince2000Epoch / 100;  // Julian millennia

    const pos = WB_planetApparentPosition(planetNumber as ECPlanetNumber, tau);
    const planetRA = pos.apparentRightAscension;
    const planetDecl = pos.apparentDeclination;

    const gst = convertUTToGSTP03(dateInterval, null);
    const lst = convertGSTtoLST(gst, observerLongitude);
    const hourAngle = lst - planetRA;

    const sinAlt = Math.sin(planetDecl) * Math.sin(observerLatitude)
                 + Math.cos(planetDecl) * Math.cos(observerLatitude) * Math.cos(hourAngle);
    return Math.asin(sinAlt);
}

// ============================================================================
// Convenience functions for Sun/Moon
// ============================================================================

/** Sun altitude (radians). */
export function sunAltitude(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cache: AstroCache | null,
): number {
    return planetAltAz(ECPlanetNumber.Sun, dateInterval, observerLatitude, observerLongitude, false, true, cache);
}

/** Sun azimuth (radians). */
export function sunAzimuth(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cache: AstroCache | null,
): number {
    return planetAltAz(ECPlanetNumber.Sun, dateInterval, observerLatitude, observerLongitude, false, false, cache);
}

/** Moon altitude (radians, with topocentric correction). */
export function moonAltitude(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cache: AstroCache | null,
): number {
    return planetAltAz(ECPlanetNumber.Moon, dateInterval, observerLatitude, observerLongitude, true, true, cache);
}

/** Moon azimuth (radians, with topocentric correction). */
export function moonAzimuth(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cache: AstroCache | null,
): number {
    return planetAltAz(ECPlanetNumber.Moon, dateInterval, observerLatitude, observerLongitude, true, false, cache);
}

// ============================================================================
// Moon age (phase angle)
// ============================================================================

/**
 * Moon age angle: the difference in ecliptic longitude between Moon and Sun.
 * Range [0, 2π). At 0 = new moon, π = full moon.
 *
 * Also returns the "phase" value (1-cos(age))/2 for backward compat,
 * although the original code notes this isn't really correct.
 */
export function moonAge(
    dateInterval: number,
    cache: AstroCache | null,
): { age: number; phase: number } {
    if (cache && cache.isValid(CacheSlot.moonAge)) {
        return {
            age: cache.get(CacheSlot.moonAge),
            phase: cache.get(CacheSlot.moonPhase),
        };
    }

    const { moonEclipticLongitude } = moonRAAndDecl(dateInterval, cache);
    const { julianCenturiesSince2000Epoch } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);
    const sunEclipticLong = WB_sunLongitudeApparent(julianCenturiesSince2000Epoch / 100, cache ?? undefined);

    let age = moonEclipticLongitude - sunEclipticLong;
    if (age < 0) {
        age += TWO_PI;
    }

    const phase = (1 - Math.cos(age)) / 2;

    if (cache) {
        cache.set(CacheSlot.moonAge, age);
        cache.set(CacheSlot.moonPhase, phase);
    }

    return { age, phase };
}

// ============================================================================
// Equation of Time
// ============================================================================

/**
 * Equation of Time in seconds.
 * EOT = apparent solar time - mean solar time.
 * Ported from iOS ECAstronomy.m: EOT() function.
 */
export function EOTSeconds(
    dateInterval: number,
    cache: AstroCache | null,
): number {
    if (cache && cache.isValid(CacheSlot.eotForDay)) {
        return cache.get(CacheSlot.eotForDay);
    }

    // iOS algorithm:
    // 1. Find UT noon for this date
    // 2. Compute longitude of mean sun from time offset
    // 3. Use sun RA to get apparent sidereal time
    // 4. Convert back to UT; difference is the EOT

    // Noon UT: round to nearest day boundary + 12h
    const noonD = Math.floor(dateInterval / 86400) * 86400 + 43200;
    // If noonD is more than 12h in the future, use previous day's noon
    const noonUT = (noonD - dateInterval > 43200) ? noonD - 86400 : noonD;

    const secondsFromNoon = dateInterval - noonUT;
    // Longitude of mean sun: if 1h after noon, sun is 15° west
    const longitudeOfMeanSun = -secondsFromNoon * Math.PI / (12 * 3600);

    // Get the actual sun RA
    const { rightAscension: sunRA } = sunRAandDecl(dateInterval, cache);

    // GAST = sunRA - longitudeOfMeanSun
    // (the sidereal time at Greenwich when the sun is at this mean position)
    const gast = sunRA - longitudeOfMeanSun;

    // Convert this GAST back to UT
    const utDate = convertGSTtoUTclosest(gast, dateInterval, null);

    // EOT in seconds = difference between actual time and the time
    // when sun would transit if it moved at mean speed
    const eotAsSeconds = dateInterval - utDate;

    if (cache) {
        cache.set(CacheSlot.eotForDay, eotAsSeconds);
    }

    return eotAsSeconds;
}

// ============================================================================
// Local Sidereal Time
// ============================================================================

/**
 * Local Sidereal Time in radians.
 */
export function localSiderealTime(
    dateInterval: number,
    observerLongitude: number,
    cache: AstroCache | null,
): number {
    if (cache && cache.isValid(CacheSlot.lst)) {
        return cache.get(CacheSlot.lst);
    }

    const gst = convertUTToGSTP03(dateInterval, cache);
    const lst = convertGSTtoLST(gst, observerLongitude);

    if (cache) {
        cache.set(CacheSlot.lst, lst);
    }

    return lst;
}

// ============================================================================
// Moon relative position angle (terminator rotation as seen in sky)
// ============================================================================

/**
 * Position angle between the Sun and an object (Moon).
 * Standard astronomical position angle — the angle at the object
 * between the great circle to the Sun and the great circle to the
 * north celestial pole, measured eastward.
 *
 * Ported from ECAstronomy.m positionAngle().
 */
export function positionAngle(
    sunRA: number, sunDecl: number,
    objRA: number, objDecl: number,
): number {
    return Math.atan2(
        Math.cos(sunDecl) * Math.sin(sunRA - objRA),
        Math.cos(objDecl) * Math.sin(sunDecl) - Math.sin(objDecl) * Math.cos(sunDecl) * Math.cos(sunRA - objRA),
    );
}

/**
 * Great circle initial course from (lat1, lon1) to (lat2, lon2).
 * Ported from ECAstronomy.m greatCircleCourse().
 */
export function greatCircleCourse(
    lat1: number, lon1: number,
    lat2: number, lon2: number,
): number {
    return Math.atan2(
        Math.sin(lon1 - lon2) * Math.cos(lat2),
        Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon1 - lon2),
    );
}

/**
 * The angle from an object to the celestial north pole as seen by an observer.
 * Uses the great circle course on a sphere whose north is at the zenith,
 * where the celestial north pole is at (observerLatitude, 0) and
 * the object is at (altitude, azimuth).
 *
 * Ported from ECAstronomy.m northAngleForObject().
 */
export function northAngleForObject(
    altitude: number,
    azimuth: number,
    observerLatitude: number,
): number {
    return greatCircleCourse(altitude, azimuth, observerLatitude, 0);
}

/**
 * Rotation of the terminator as it appears in the sky.
 *
 * Combines the Sun–Moon position angle with the observer's
 * sky orientation (via northAngleForObject) to give the angle
 * the terminator should be drawn at for a sky-aligned display.
 *
 * Ported from ECAstronomy.m moonRelativePositionAngle (lines 3153-3196).
 *
 * @param dateInterval - Apple epoch seconds
 * @param observerLatitude - Observer latitude in radians
 * @param observerLongitude - Observer longitude in radians (east positive)
 * @param cache - AstroCache or null
 * @returns angle in [0, 2π)
 */
export function moonRelativePositionAngle(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cache: AstroCache | null,
): number {
    // Sun RA/Decl
    const sunResult = sunRAandDecl(dateInterval, cache);
    const sunRA = sunResult.rightAscension;
    const sunDecl = sunResult.declination;

    // Moon RA/Decl
    const moonResult = moonRAAndDecl(dateInterval, cache);
    const moonRA = moonResult.rightAscension;
    const moonDecl = moonResult.declination;

    // Position angle Sun→Moon
    let posAngle = positionAngle(sunRA, sunDecl, moonRA, moonDecl);

    // Moon age — if waning (age > π), bright limb is on the left,
    // so the sense of posAngle is reversed by 180°
    const { age: moonAgeAngle } = moonAge(dateInterval, cache);
    if (moonAgeAngle > Math.PI) {
        if (posAngle > Math.PI) {
            posAngle -= Math.PI;
        } else {
            posAngle += Math.PI;
        }
    }

    // Moon's local hour angle, altitude, azimuth
    const gst = convertUTToGSTP03(dateInterval, cache);
    const lst = convertGSTtoLST(gst, observerLongitude);
    const moonHourAngle = lst - moonRA;
    const sinAlt = Math.sin(moonDecl) * Math.sin(observerLatitude)
        + Math.cos(moonDecl) * Math.cos(observerLatitude) * Math.cos(moonHourAngle);
    const moonAz = Math.atan2(
        -Math.cos(moonDecl) * Math.cos(observerLatitude) * Math.sin(moonHourAngle),
        Math.sin(moonDecl) - Math.sin(observerLatitude) * sinAlt,
    );
    const moonAlt = Math.asin(sinAlt);

    // North angle for the Moon
    const northAngle = northAngleForObject(moonAlt, moonAz, observerLatitude);

    // Combine into final angle
    let angle = -northAngle - posAngle - Math.PI / 2;
    if (angle < 0) {
        angle += TWO_PI;
    } else if (angle > TWO_PI) {
        angle -= TWO_PI;
    }

    return angle;
}

// ============================================================================
// Moon relative angle (rotation of the Moon IMAGE as seen in the sky)
// ============================================================================

// Moon equator–ecliptic inclination (~1.5427°)
const kECsinMoonEquatorEclipticAngle = 0.026917056028711;
const kECcosMoonEquatorEclipticAngle = 0.999637670406006;

/**
 * Rotation of the Moon *image* as it appears in the sky.
 *
 * Uses Meeus p373 "Position Angle of Axis" to determine the
 * angle of the Moon's north pole projected onto the sky plane,
 * combined with the observer's sky orientation (north angle).
 *
 * This is different from moonRelativePositionAngle, which gives
 * the terminator rotation (Sun–Moon position angle).
 *
 * Ported from iOS ESAstronomy.cpp moonRelativeAngle() (line 3503).
 */
export function moonRelativeAngle(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cache: AstroCache | null,
): number {
    // Moon RA/Decl
    const moonResult = moonRAAndDecl(dateInterval, cache);
    const moonRA = moonResult.rightAscension;
    const moonDecl = moonResult.declination;

    // Moon local hour angle, altitude, azimuth
    const gst = convertUTToGSTP03(dateInterval, cache);
    const lst = convertGSTtoLST(gst, observerLongitude);
    const moonHourAngle = lst - moonRA;
    const sinAlt = Math.sin(moonDecl) * Math.sin(observerLatitude)
        + Math.cos(moonDecl) * Math.cos(observerLatitude) * Math.cos(moonHourAngle);
    const moonAz = Math.atan2(
        -Math.cos(moonDecl) * Math.cos(observerLatitude) * Math.sin(moonHourAngle),
        Math.sin(moonDecl) - Math.sin(observerLatitude) * sinAlt,
    );
    const moonAlt = Math.asin(sinAlt);
    const northAngle = northAngleForObject(moonAlt, moonAz, observerLatitude);

    // Approximate geocentric longitude/latitude
    const apparentGeocentricLongitude = moonRA - gst;
    const apparentGeocentricLatitude = moonDecl;

    // Meeus p373, "Position Angle of Axis"
    const { julianCenturiesSince2000Epoch } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);
    const eclipticTrueObliquity = generalObliquity(julianCenturiesSince2000Epoch);
    const longitudeOfAscendingNode = WB_MoonAscendingNodeLongitude(julianCenturiesSince2000Epoch, cache ?? undefined);

    const W = apparentGeocentricLongitude - longitudeOfAscendingNode;
    const b = Math.asin(
        -Math.sin(W) * Math.cos(apparentGeocentricLatitude) * kECsinMoonEquatorEclipticAngle
        - Math.sin(apparentGeocentricLatitude) * kECcosMoonEquatorEclipticAngle,
    );
    // Ignore physical librations (Meeus p373, rho and sigma)
    const V = longitudeOfAscendingNode;
    const X = kECsinMoonEquatorEclipticAngle * Math.sin(V);
    const Y = kECsinMoonEquatorEclipticAngle * Math.cos(V) * Math.cos(eclipticTrueObliquity)
        - kECcosMoonEquatorEclipticAngle * Math.sin(eclipticTrueObliquity);
    const omega = Math.atan2(X, Y);
    const sinP = Math.sqrt(X * X + Y * Y) * Math.cos(moonRA - omega) / Math.cos(b);
    const posAngle = Math.asin(sinP);

    let angle = -northAngle - posAngle;
    if (angle < 0) {
        angle += TWO_PI;
    } else if (angle > TWO_PI) {
        angle -= TWO_PI;
    }

    return angle;
}

// ============================================================================
// Sun sky orientation angle (analemma rotation as seen in the sky)
// ============================================================================

/**
 * Rotation angle for the analemma display at the Sun's current sky position.
 *
 * Computes the angle from celestial north as projected on the observer's
 * sky plane at the Sun's position, using northAngleForObject(). This tells
 * us how to rotate the analemma figure so that "up" in the analemma
 * (increasing altitude / declination) aligns with celestial north's
 * direction at the Sun's current position in the sky.
 *
 * Analogous to moonRelativeAngle() but without the Moon-specific
 * position-angle-of-axis (Meeus p373) term.
 *
 * @returns angle in [0, 2π)
 */
export function sunSkyOrientationAngle(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cache: AstroCache | null,
): number {
    // Sun RA/Decl
    const sunResult = sunRAandDecl(dateInterval, cache);
    const sunRA = sunResult.rightAscension;
    const sunDecl = sunResult.declination;

    // Sun local hour angle, altitude, azimuth
    const gst = convertUTToGSTP03(dateInterval, cache);
    const lst = convertGSTtoLST(gst, observerLongitude);
    const sunHourAngle = lst - sunRA;
    const sinAlt = Math.sin(sunDecl) * Math.sin(observerLatitude)
        + Math.cos(sunDecl) * Math.cos(observerLatitude) * Math.cos(sunHourAngle);
    const sunAz = Math.atan2(
        -Math.cos(sunDecl) * Math.cos(observerLatitude) * Math.sin(sunHourAngle),
        Math.sin(sunDecl) - Math.sin(observerLatitude) * sinAlt,
    );
    const sunAlt = Math.asin(sinAlt);

    // North angle for the Sun — the angle from the Sun to celestial north
    // as projected on the observer's sky plane.
    const northAngle = northAngleForObject(sunAlt, sunAz, observerLatitude);

    // For the analemma, "up" in the path = increasing altitude ≈ celestial
    // north direction. northAngle tells us where celestial north is from
    // the Sun's position on the sky plane. We negate to convert from
    // "north is at this angle" to "rotate the figure by this much."
    //
    // The constant offset aligns the reference frame if needed.
    // Start with 0 and tune empirically.
    const kAnalemmaOrientationOffset = 0;
    let angle = -northAngle + kAnalemmaOrientationOffset;

    // Normalize to [0, 2π)
    if (angle < 0) angle += TWO_PI;
    else if (angle > TWO_PI) angle -= TWO_PI;

    return angle;
}

// ============================================================================
// Eclipse calculation — ported from iOS ESAstronomy.cpp
// ============================================================================

/** Eclipse type classification (iOS ECEclipseKind) */
export enum EclipseKind {
    NoneSolar = 0,
    NoneLunar,       // iOS: 1 (adjacent to NoneSolar so both collapse to 0 via value--)
    SolarNotUp,      // iOS: 2
    PartialSolar,    // iOS: 3
    AnnularSolar,    // iOS: 4
    TotalSolar,      // iOS: 5
    LunarNotUp,      // iOS: 6
    PartialLunar,    // iOS: 7
    TotalLunar,      // iOS: 8
}

/**
 * Angular separation between two celestial objects using the Vincenty formula.
 * Works well for small separations (unlike acos-based formulas).
 * iOS: angularSeparation() at line 4555.
 */
function angularSeparation(
    ra1: number, decl1: number,
    ra2: number, decl2: number,
): number {
    const sinDecl1 = Math.sin(decl1);
    const cosDecl1 = Math.cos(decl1);
    const sinDecl2 = Math.sin(decl2);
    const cosDecl2 = Math.cos(decl2);
    const sinRADelta = Math.sin(ra2 - ra1);
    const cosRADelta = Math.cos(ra2 - ra1);
    const x = cosDecl1 * sinDecl2 - sinDecl1 * cosDecl2 * cosRADelta;
    const y = cosDecl2 * sinRADelta;
    const z = sinDecl1 * sinDecl2 + cosDecl1 * cosDecl2 * cosRADelta;
    return Math.atan2(Math.sqrt(x * x + y * y), z);
}

/**
 * Umbral angular radius of Earth's shadow at the Moon's distance.
 * iOS: umbralAngularRadius() at line 4547.
 */
function umbralAngularRadius(
    moonParallax: number,
    sunAngularRadius: number,
    sunParallax: number,
): number {
    return 1.01 * moonParallax - sunAngularRadius + sunParallax;
}

/** Result of calculateEclipse */
export interface EclipseResult {
    abstractSeparation: number;   // Normalized separation (0-3 scale)
    angularSeparation: number;    // Physical angular separation (radians)
    shadowAngularSize: number;    // Angular size of Earth's shadow (radians, lunar only)
    eclipseKind: EclipseKind;
}

/**
 * Calculate eclipse parameters for the current time and observer.
 * 
 * When Sun and Moon are close in RA (raDelta < π/2, near new moon):
 *   Uses topocentric coordinates for maximum accuracy near solar eclipses.
 * When far apart (raDelta ≥ π/2, near full moon):
 *   Uses Earth shadow position for lunar eclipse detection.
 * 
 * Ported from iOS calculateEclipse() at line 4600.
 */
export function calculateEclipse(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cache: AstroCache | null,
): EclipseResult {
    // Memoized in the location-dependent eclipse slots (like CacheSlot.lst,
    // valid because a cache is only ever reused with one observer).
    if (cache && cache.isValid(CacheSlot.eclipseSeparation)) {
        return {
            abstractSeparation: cache.get(CacheSlot.eclipseSeparation),
            angularSeparation: cache.get(CacheSlot.eclipseAngularSeparation),
            shadowAngularSize: cache.get(CacheSlot.eclipseShadowAngularSize),
            eclipseKind: cache.get(CacheSlot.eclipseKind) as EclipseKind,
        };
    }

    const gst = convertUTToGSTP03(dateInterval, cache);
    const lst = convertGSTtoLST(gst, observerLongitude);
    const { julianCenturiesSince2000Epoch } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);

    // Sun position and size
    const sunResult = sunRAandDecl(dateInterval, cache);
    const sunRA = sunResult.rightAscension;
    const sunDecl = sunResult.declination;
    const sunDistAU = distanceOfPlanetInAU(ECPlanetNumber.Sun, julianCenturiesSince2000Epoch, cache);
    const sunSizeParallax = planetSizeAndParallax(ECPlanetNumber.Sun, sunDistAU);
    const sunAngularSize = sunSizeParallax.angularSize;
    const sunParallax = sunSizeParallax.parallax;

    // Moon position and size
    const moonResult = moonRAAndDecl(dateInterval, cache);
    const moonRA = moonResult.rightAscension;
    const moonDecl = moonResult.declination;
    const moonDistAU = distanceOfPlanetInAU(ECPlanetNumber.Moon, julianCenturiesSince2000Epoch, cache);
    const moonSizeParallax = planetSizeAndParallax(ECPlanetNumber.Moon, moonDistAU);
    const moonAngularSize = moonSizeParallax.angularSize;
    const moonParallax = moonSizeParallax.parallax;

    // Quick check: RA delta to determine solar vs lunar proximity
    // iOS: EC_fmod(fabs(moonRA - sunRA), 2π), result in [0, 2π)
    // Near new moon: raDelta < π/2 → solar branch
    // Near full moon or in between: raDelta >= π/2 → lunar branch
    const raDelta = fmod(Math.abs(moonRA - sunRA), TWO_PI);

    let physicalSeparation: number;
    let separationAtPartialEclipse: number;
    let separationAtTotalEclipse: number;
    let eclipseKind: EclipseKind;
    let solarNotLunar: boolean;
    let shadowAngularSize = 0;

    if (raDelta < Math.PI / 2) {
        // Near new moon — possible solar eclipse
        // Use topocentric positions for accuracy
        const sunH = lst - sunRA;
        const sunTopo = topocentricParallax(sunRA, sunDecl, sunH, sunDistAU, observerLatitude, 0);
        const sunTopoRA = lst - sunTopo.Hprime;

        const moonH = lst - moonRA;
        const moonTopo = topocentricParallax(moonRA, moonDecl, moonH, moonDistAU, observerLatitude, 0);
        const moonTopoRA = lst - moonTopo.Hprime;

        // Size the discs at the *topocentric* distances: the separation above is
        // topocentric, so the radii it is compared against must be too. The
        // Moon's disc is up to 1.7% larger overhead than seen from the Earth's
        // centre — precisely the margin that separates a total eclipse from an
        // annular one, and geocentric radii misclassify hybrids as partial.
        // (Diverges from iOS ECAstronomy.m:4227–4260; see docs/astronomy.md.)
        const sunTopoDist = sunDistAU * sunTopo.distanceRatio;
        const moonTopoDist = moonDistAU * moonTopo.distanceRatio;
        const sunAngularSizeTopo = planetSizeAndParallax(ECPlanetNumber.Sun, sunTopoDist).angularSize;
        const moonAngularSizeTopo = planetSizeAndParallax(ECPlanetNumber.Moon, moonTopoDist).angularSize;

        physicalSeparation = angularSeparation(sunTopoRA, sunTopo.declPrime, moonTopoRA, moonTopo.declPrime);
        separationAtPartialEclipse = sunAngularSizeTopo / 2 + moonAngularSizeTopo / 2;
        separationAtTotalEclipse = moonAngularSizeTopo / 2 - sunAngularSizeTopo / 2;
        const separationAtAnnularEclipse = sunAngularSizeTopo / 2 - moonAngularSizeTopo / 2;

        // Check if Sun is above horizon
        const sunAlt = planetAltAz(ECPlanetNumber.Sun, dateInterval, observerLatitude, observerLongitude, true, true, cache);
        const altAtRS = altitudeAtRiseSet(julianCenturiesSince2000Epoch, ECPlanetNumber.Sun, false, cache);

        if (sunAlt < altAtRS) {
            eclipseKind = EclipseKind.SolarNotUp;
        } else if (physicalSeparation > separationAtPartialEclipse) {
            eclipseKind = EclipseKind.NoneSolar;
        } else if (physicalSeparation < separationAtAnnularEclipse) {
            eclipseKind = EclipseKind.AnnularSolar;
        } else if (physicalSeparation > separationAtTotalEclipse) {
            eclipseKind = EclipseKind.PartialSolar;
        } else {
            eclipseKind = EclipseKind.TotalSolar;
        }
        solarNotLunar = true;
    } else {
        // Near full moon — possible lunar eclipse
        // Use Earth's shadow position (anti-sun)
        shadowAngularSize = 2 * umbralAngularRadius(moonParallax, sunAngularSize / 2, sunParallax);
        let shadowRA = sunRA + Math.PI;
        if (shadowRA > TWO_PI) shadowRA -= TWO_PI;
        const shadowDecl = -sunDecl;

        physicalSeparation = angularSeparation(shadowRA, shadowDecl, moonRA, moonDecl);
        separationAtPartialEclipse = moonAngularSize / 2 + shadowAngularSize / 2;
        separationAtTotalEclipse = shadowAngularSize / 2 - moonAngularSize / 2;

        // Check if Moon is above horizon
        const moonAlt = planetAltAz(ECPlanetNumber.Moon, dateInterval, observerLatitude, observerLongitude, true, true, cache);
        const altAtRS = altitudeAtRiseSet(julianCenturiesSince2000Epoch, ECPlanetNumber.Moon, false, cache);

        if (moonAlt < altAtRS) {
            eclipseKind = EclipseKind.LunarNotUp;
        } else if (physicalSeparation > separationAtPartialEclipse) {
            eclipseKind = EclipseKind.NoneLunar;
        } else if (physicalSeparation > separationAtTotalEclipse) {
            eclipseKind = EclipseKind.PartialLunar;
        } else {
            eclipseKind = EclipseKind.TotalLunar;
        }
        solarNotLunar = false;
    }

    // Normalized abstract separation (0-3 scale)
    let abstractSeparation = 1 + (physicalSeparation - separationAtTotalEclipse)
        / (separationAtPartialEclipse - separationAtTotalEclipse);
    if (abstractSeparation < 0) {
        abstractSeparation = 0;
    } else if (abstractSeparation > 3) {
        abstractSeparation = 3;
        eclipseKind = solarNotLunar ? EclipseKind.NoneSolar : EclipseKind.NoneLunar;
    }

    if (cache) {
        cache.set(CacheSlot.eclipseSeparation, abstractSeparation);
        cache.set(CacheSlot.eclipseAngularSeparation, physicalSeparation);
        cache.set(CacheSlot.eclipseShadowAngularSize, shadowAngularSize);
        cache.set(CacheSlot.eclipseKind, eclipseKind);
    }

    return {
        abstractSeparation,
        angularSeparation: physicalSeparation,
        shadowAngularSize,
        eclipseKind,
    };
}

/**
 * Whether an eclipse kind is more solar than lunar (i.e. near new moon).
 * iOS: eclipseKindIsMoreSolarThanLunar() at line 4796.
 */
export function eclipseKindIsMoreSolarThanLunar(kind: EclipseKind): boolean {
    switch (kind) {
        case EclipseKind.NoneSolar:
        case EclipseKind.SolarNotUp:
        case EclipseKind.PartialSolar:
        case EclipseKind.AnnularSolar:
        case EclipseKind.TotalSolar:
            return true;
        default:
            return false;
    }
}

// ============================================================================
// Moon elongation — uses eclipse calculation for accuracy
// ============================================================================

/**
 * Moon elongation — angular separation between Sun and Moon.
 * Range [0, π]. 0 = new moon (conjunction), π = full moon (opposition).
 * 
 * Uses eclipse calculation for accuracy:
 * - Near new moon (solar side): returns eclipseAngularSeparation directly
 * - Near full moon (lunar side): returns π - eclipseAngularSeparation
 * 
 * iOS implementation from Selene virtual machine.
 */
export function moonElongation(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cache: AstroCache | null,
): number {
    const eclipse = calculateEclipse(dateInterval, observerLatitude, observerLongitude, cache);
    if (eclipseKindIsMoreSolarThanLunar(eclipse.eclipseKind)) {
        return eclipse.angularSeparation;
    } else {
        return Math.PI - eclipse.angularSeparation;
    }
}

// ============================================================================
// Closest lunar phase quarter — iOS-faithful iterative refinement
// ============================================================================

/** Mean synodic month in seconds (iOS: kECLunarCycleInSeconds) */
const LUNAR_CYCLE_SECONDS = 29.530589 * 86400;

/**
 * One step of iterative refinement: compute moon age at tryDate,
 * find the delta to targetAge, and adjust proportionally using
 * the synodic month period.
 * 
 * Follows iOS stepRefineMoonAgeTargetForDate() exactly.
 */
function stepRefineMoonAgeTarget(
    dateInterval: number,
    targetAge: number,
    cache: AstroCache | null,
): number {
    const { age } = moonAge(dateInterval, cache);
    let deltaAge = targetAge - age;
    if (deltaAge > Math.PI) {
        deltaAge -= TWO_PI;
    } else if (deltaAge < -Math.PI) {
        deltaAge += TWO_PI;
    }
    return dateInterval + deltaAge / TWO_PI * LUNAR_CYCLE_SECONDS;
}

/**
 * Iteratively refine a guess date to find the exact time when
 * moon age equals targetAge, converging to within 0.1 seconds.
 * 
 * Follows iOS refineMoonAgeTargetForDate(): up to 5 iterations.
 * 
 * @param dateInterval - Initial guess (Apple epoch seconds)
 * @param targetAge - Target moon age angle (radians)
 * @returns Refined dateInterval when moon age ≈ targetAge
 */
export function refineMoonAgeTargetForDate(
    dateInterval: number,
    targetAge: number,
): number {
    let tryDate = dateInterval;
    for (let i = 0; i < 5; i++) {
        const newDate = stepRefineMoonAgeTarget(tryDate, targetAge, null);
        if (Math.abs(newDate - tryDate) < 0.1) {
            return newDate;
        }
        tryDate = newDate;
    }
    return tryDate;
}

/**
 * Find the exact time (Apple epoch seconds) of the closest occurrence
 * of a given lunar phase quarter.
 * 
 * Follows iOS closestQuarterAngle() exactly:
 * 1. Compute current moon age
 * 2. Find angular distance since the target quarter
 * 3. Determine if closest occurrence is backward or forward in time
 * 4. Estimate a guess date using synodic month ratio
 * 5. Refine iteratively to sub-second accuracy
 * 
 * @param quarterAngle - Phase angle: 0=new, π/2=first quarter, π=full, 3π/2=third quarter
 * @param dateInterval - Current time in Apple epoch seconds
 * @returns Apple epoch seconds of the closest phase occurrence
 */
export function closestQuarterPhaseTime(
    quarterAngle: number,
    dateInterval: number,
): number {
    const { age } = moonAge(dateInterval, null);
    const ageSinceQuarter = fmod(age - quarterAngle, TWO_PI);
    // iOS: closestIsBack when not running backward and ageSinceQuarter < π - 0.01
    // We never run backward, so simplify:
    const closestIsBack = ageSinceQuarter < Math.PI - 0.01;
    const guessDate = closestIsBack
        ? dateInterval - LUNAR_CYCLE_SECONDS * ageSinceQuarter / TWO_PI
        : dateInterval + LUNAR_CYCLE_SECONDS * (TWO_PI - ageSinceQuarter) / TWO_PI;
    return refineMoonAgeTargetForDate(guessDate, quarterAngle);
}

/**
 * Find the day-of-month (1-based) of the closest occurrence of a given
 * lunar phase quarter in the user's local timezone.
 * 
 * @param targetPhase - Phase angle: 0=new, π/2=first quarter, π=full, 3π/2=third quarter
 * @param dateInterval - Current time in Apple epoch seconds
 * @returns Day-of-month (1-based) when the phase occurs
 */
export function closestPhaseDayNumber(
    targetPhase: number,
    dateInterval: number,
): number {
    const phaseTime = closestQuarterPhaseTime(targetPhase, dateInterval);
    // Convert Apple epoch seconds → JS Date (user's local timezone)
    const phaseDate = new Date((phaseTime + kECUnixToAppleEpochOffset) * 1000);
    return phaseDate.getDate();
}

// ============================================================================
// Planetary ecliptic coordinates (for ELatitudeOfPlanet, ELongitudeOfPlanet, etc.)
// ============================================================================


/**
 * Get geocentric apparent ecliptic longitude of a planet (radians).
 */
export function planetEclipticLongitude(
    planetNumber: ECPlanetNumber,
    dateInterval: number,
    cache: AstroCache | null,
): number {
    const { julianCenturiesSince2000Epoch } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);
    const U = julianCenturiesSince2000Epoch / 100;
    const pos = WB_planetApparentPosition(planetNumber, U, cache ?? undefined);
    return pos.geocentricApparentLongitude;
}

/**
 * Get geocentric apparent ecliptic latitude of a planet (radians).
 */
export function planetEclipticLatitude(
    planetNumber: ECPlanetNumber,
    dateInterval: number,
    cache: AstroCache | null,
): number {
    const { julianCenturiesSince2000Epoch } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);
    const U = julianCenturiesSince2000Epoch / 100;
    const pos = WB_planetApparentPosition(planetNumber, U, cache ?? undefined);
    return pos.geocentricApparentLatitude;
}

/**
 * Get geocentric distance of a planet in AU.
 */
export function planetGeocentricDistance(
    planetNumber: ECPlanetNumber,
    dateInterval: number,
    cache: AstroCache | null,
): number {
    const { julianCenturiesSince2000Epoch } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);
    const U = julianCenturiesSince2000Epoch / 100;
    const pos = WB_planetApparentPosition(planetNumber, U, cache ?? undefined);
    return pos.geocentricDistance;
}

/**
 * Get topocentric distance of a planet in AU — the distance from the observer
 * rather than from the Earth's centre.
 *
 * Only meaningful for the Moon (up to 1.7% nearer overhead, i.e. a disc that
 * much larger); for the Sun it is a 0.004% correction and for the planets it
 * is nil. Use it where an *apparent size* is being drawn or compared against
 * another apparent size — the eclipse simulator's discs, whose classification
 * (calculateEclipse) is topocentric for the same reason.
 */
export function planetTopocentricDistance(
    planetNumber: ECPlanetNumber,
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cache: AstroCache | null,
): number {
    const { julianCenturiesSince2000Epoch } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);
    const U = julianCenturiesSince2000Epoch / 100;
    const pos = WB_planetApparentPosition(planetNumber, U, cache ?? undefined);
    const gst = convertUTToGSTP03(dateInterval, cache);
    const lst = convertGSTtoLST(gst, observerLongitude);
    const { distanceRatio } = topocentricParallax(
        pos.apparentRightAscension, pos.apparentDeclination,
        lst - pos.apparentRightAscension,
        pos.geocentricDistance, observerLatitude, 0,
    );
    return pos.geocentricDistance * distanceRatio;
}

// ============================================================================
// Lunar ascending node longitude
// ============================================================================

/**
 * Mean longitude of the lunar ascending node (Ω).
 * Uses the standard Meeus formula.
 *
 * @param dateInterval - Apple epoch seconds
 * @param cache - AstroCache or null
 * @returns longitude in radians [0, 2π)
 */
export function lunarAscendingNodeLongitude(
    dateInterval: number,
    cache: AstroCache | null,
): number {
    const { julianCenturiesSince2000Epoch: T } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);

    // Mean longitude of ascending node (Meeus, Table 47.a)
    // Ω = 125.0445479° − 1934.1362891°T + 0.0020754°T² + T³/467441 − T⁴/60616000
    const omegaDeg = 125.0445479
        - 1934.1362891 * T
        + 0.0020754 * T * T
        + T * T * T / 467441
        - T * T * T * T / 60616000;

    return fmod(omegaDeg * Math.PI / 180, TWO_PI);
}

// ============================================================================
// Solar longitude crossings (equinoxes / solstices) and seasonal phase
// ============================================================================

/**
 * Mean tropical year in seconds. Used only to seed root-finds and bracket
 * searches — never as an exact year length in any returned value.
 */
const MEAN_TROPICAL_YEAR_SECONDS = 365.2421897 * 86400;

/**
 * Sun's apparent ecliptic longitude (radians, [0, 2π)) at a given instant.
 * Stateless helper for root-finding: evaluates many distinct instants, so it
 * deliberately uses no per-date cache.
 */
function sunApparentLongitudeAt(dateInterval: number): number {
    const { julianCenturiesSince2000Epoch } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, null);
    return WB_sunLongitudeApparent(julianCenturiesSince2000Epoch / 100);
}

/**
 * Date interval at which the Sun's apparent ecliptic longitude equals
 * targetLongitudeRad, nearest to approxDateInterval.
 *
 * Newton iteration on the signed angular distance to the target. The Sun's
 * apparent longitude advances ~0.9856°/day (varying ±1.7% over the year due to
 * orbital eccentricity), wrapping at 2π; seeding the step from the mean motion
 * is a contraction, so this converges to sub-second in a handful of iterations.
 * Equinoxes/solstices are the targets 0, π/2, π, 3π/2.
 *
 * The cache argument is accepted for signature consistency with the rest of the
 * library but is not used for the per-instant longitude evaluations.
 */
export function solarLongitudeCrossingTime(
    targetLongitudeRad: number,
    approxDateInterval: number,
    _cache: AstroCache | null,
): number {
    const meanMotion = TWO_PI / MEAN_TROPICAL_YEAR_SECONDS;  // rad/sec
    let di = approxDateInterval;
    for (let iter = 0; iter < 12; iter++) {
        const lon = sunApparentLongitudeAt(di);
        let diff = (lon - targetLongitudeRad) % TWO_PI;
        if (diff > Math.PI) diff -= TWO_PI;
        if (diff < -Math.PI) diff += TWO_PI;
        const step = diff / meanMotion;   // seconds the Sun is "ahead" of the target
        di -= step;
        if (Math.abs(step) < 0.5) break;  // sub-second convergence
    }
    return di;
}

/**
 * Vernal equinox (apparent λ☉ = 0) on or before the given instant.
 *
 * When the first crossing lands after `dateInterval`, the correction re-seeds a
 * year back from *that crossing* rather than from `dateInterval`. Seeding from
 * `dateInterval` is ambiguous when it falls near the autumnal equinox — λ☉ ≈ π
 * is equidistant from the bracketing λ☉ = 0 crossings, so the search picks one
 * arbitrarily and can skip a whole year.
 */
export function vernalEquinoxOnOrBefore(
    dateInterval: number,
    cache: AstroCache | null,
): number {
    let ve = solarLongitudeCrossingTime(0, dateInterval, cache);
    if (ve > dateInterval) {
        ve = solarLongitudeCrossingTime(0, ve - MEAN_TROPICAL_YEAR_SECONDS, cache);
    }
    return ve;
}

/**
 * Vernal equinox (apparent λ☉ = 0) strictly after the given instant.
 * Re-seeds from the found crossing, not from `dateInterval` — see
 * `vernalEquinoxOnOrBefore` for why.
 */
export function vernalEquinoxAfter(
    dateInterval: number,
    cache: AstroCache | null,
): number {
    let ve = solarLongitudeCrossingTime(0, dateInterval, cache);
    if (ve <= dateInterval) {
        ve = solarLongitudeCrossingTime(0, ve + MEAN_TROPICAL_YEAR_SECONDS, cache);
    }
    return ve;
}

/**
 * Fraction [0, 1) of the way through the current vernal-equinox year:
 *   (t − VE_prev) / (VE_next − VE_prev),
 * where VE_prev / VE_next are the vernal equinoxes bracketing t.
 *
 * Because it is anchored to the *actual* bracketing equinoxes, it is exact at
 * any epoch — independent of any fixed (365 / 365.2422) year-length assumption,
 * and absorbing the year-to-year variation in the equinox-to-equinox interval.
 */
export function fractionOfVernalEquinoxYear(
    dateInterval: number,
    cache: AstroCache | null,
): number {
    const prev = vernalEquinoxOnOrBefore(dateInterval, cache);
    const next = vernalEquinoxAfter(dateInterval, cache);
    return (dateInterval - prev) / (next - prev);
}

