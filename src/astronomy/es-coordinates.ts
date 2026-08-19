/**
 * Coordinate transformations and precession.
 *
 * Ported from ESAstronomy.cpp: ecliptic↔equatorial, topocentric parallax,
 * Sun/Moon RA+Decl wrappers, P03 precession/obliquity.
 *
 * All angles in radians unless otherwise noted.
 */

import { fmod, ECPlanetNumber, ECWBPrecision, kECAUInKilometers, planetRadiiInAU, kECRefractionAtHorizonX } from './astro-constants';
import { AstroCache, CacheSlot } from './astro-cache';
import { julianCenturiesSince2000EpochForDateInterval } from './es-time';
import { WB_sunRAAndDecl, WB_sunLongitudeApparent, WB_sunRadius } from './wb-sun';
import { WB_MoonRAAndDecl, WB_MoonDistance } from './wb-moon';

const TWO_PI = Math.PI * 2;

// ============================================================================
// Ecliptic ↔ Equatorial
// ============================================================================

/**
 * Convert ecliptic coordinates to equatorial (RA, Decl), given obliquity directly.
 */
export function raAndDeclO(
    eclipticLatitude: number,
    eclipticLongitude: number,
    obliquity: number,
): { rightAscension: number; declination: number } {
    const sinDelta = Math.sin(eclipticLatitude) * Math.cos(obliquity) +
        Math.cos(eclipticLatitude) * Math.sin(obliquity) * Math.sin(eclipticLongitude);
    const declination = Math.asin(sinDelta);
    const y = Math.sin(eclipticLongitude) * Math.cos(obliquity) -
        Math.tan(eclipticLatitude) * Math.sin(obliquity);
    const x = Math.cos(eclipticLongitude);
    const rightAscension = Math.atan2(y, x);
    return { rightAscension, declination };
}

// ============================================================================
// Topocentric parallax
// ============================================================================

/**
 * Correct RA/Decl for topocentric parallax (observer on Earth's surface).
 * From Meeus, chapters 11 & 40.
 *
 * @param ra - Right ascension (radians)
 * @param decl - Declination (radians)
 * @param H - Hour angle (radians)
 * @param distInAU - Distance to object (AU)
 * @param observerLatitude - Observer geodetic latitude (radians)
 * @param observerAltitude - Observer altitude above sea level (meters)
 *
 * `distanceRatio` is Δ′/Δ, the topocentric distance over the geocentric one:
 * it falls out of the same A/B/C vector the declination correction uses. It is
 * ≈1 for a body on the horizon and 1 − sin(horizontal parallax) at the zenith
 * — for the Moon that is 0.9834, i.e. a disc 1.7% larger overhead than the
 * geocentric size.
 * Callers that compare angular diameters (solar eclipse thresholds, the EO
 * eclipse simulator) need it; the position-only callers ignore it.
 */
export function topocentricParallax(
    ra: number,
    decl: number,
    H: number,
    distInAU: number,
    observerLatitude: number,
    observerAltitude: number,
): { Hprime: number; declPrime: number; distanceRatio: number } {
    const bOverA = 0.99664719;
    const u = Math.atan(bOverA * Math.tan(observerLatitude));
    const delta = observerAltitude / 6378140;
    const rhoSinPhiPrime = bOverA * Math.sin(u) + delta * Math.sin(observerLatitude);
    const rhoCosPhiPrime = Math.cos(u) + delta * Math.cos(observerLatitude);
    const sinPi = Math.sin(8.794 / 3600 * Math.PI / 180) / distInAU;
    const A = Math.cos(decl) * Math.sin(H);
    const B = Math.cos(decl) * Math.cos(H) - rhoCosPhiPrime * sinPi;
    const C = Math.sin(decl) - rhoSinPhiPrime * sinPi;
    const q = Math.sqrt(A * A + B * B + C * C);
    let Hprime = Math.atan2(A, B);
    if (Hprime < 0) {
        Hprime += TWO_PI;
    }
    const declPrime = Math.asin(C / q);
    return { Hprime, declPrime, distanceRatio: q };
}

// ============================================================================
// P03 Precession and Obliquity
// ============================================================================

/**
 * General precession since J2000.0 using the P03 model.
 * Returns the accumulated precession in radians.
 */
export function generalPrecessionSinceJ2000(julianCenturiesSince2000Epoch: number): number {
    const t = julianCenturiesSince2000Epoch;
    const t2 = t * t;
    const t3 = t * t2;
    const t4 = t2 * t2;
    const t5 = t2 * t3;
    const arcSeconds = 5028.796195 * t + 1.1054348 * t2 + 0.00007964 * t3
        - 0.000023857 * t4 - 0.0000000383 * t5;
    return arcSeconds * Math.PI / (3600 * 180);
}

/**
 * General obliquity of the ecliptic using the P03 model.
 * Returns the obliquity in radians.
 */
export function generalObliquity(julianCenturiesSince2000Epoch: number): number {
    const t = julianCenturiesSince2000Epoch;
    const t2 = t * t;
    const t3 = t * t2;
    const t4 = t2 * t2;
    const t5 = t2 * t3;
    const e0 = 84381.406;
    const eA = e0 - 46.836769 * t - 0.0001831 * t2 + 0.00200340 * t3
        - 0.000000576 * t4 - 0.0000000434 * t5;
    return eA * Math.PI / (3600 * 180);
}

/**
 * General precession quantities (P03).
 * Returns all six precession parameters needed for precession matrix.
 */
export function generalPrecessionQuantities(julianCenturiesSince2000Epoch: number): {
    pA: number; eA: number; chiA: number; zetaA: number; zA: number; thetaA: number;
} {
    const t = julianCenturiesSince2000Epoch;
    const t2 = t * t;
    const t3 = t * t2;
    const t4 = t2 * t2;
    const t5 = t2 * t3;

    const toRad = Math.PI / (3600 * 180);

    const pA = (5028.796195 * t + 1.1054348 * t2 + 0.00007964 * t3
        - 0.000023857 * t4 - 0.0000000383 * t5) * toRad;

    const e0 = 84381.406;
    const eA = (e0 - 46.836769 * t - 0.0001831 * t2 + 0.00200340 * t3
        - 0.000000576 * t4 - 0.0000000434 * t5) * toRad;

    const chiA = (10.556403 * t - 2.3814292 * t2 - 0.00121197 * t3
        + 0.000170663 * t4 - 0.0000000560 * t5) * toRad;

    const zetaA = (2.650545 + 2306.083227 * t + 0.2988499 * t2 + 0.01801828 * t3
        - 0.000005971 * t4 - 0.0000003173 * t5) * toRad;

    const zA = (-2.650545 + 2306.077181 * t + 1.0927348 * t2 + 0.01826837 * t3
        - 0.000028596 * t4 - 0.0000002904 * t5) * toRad;

    const thetaA = (2004.19103 * t - 0.4294934 * t2 - 0.04182264 * t3
        - 0.000007089 * t4 - 0.0000001274 * t5) * toRad;

    return { pA, eA, chiA, zetaA, zA, thetaA };
}

// ============================================================================
// Precession conversion (J2000 ↔ of-date)
// ============================================================================

/**
 * Convert J2000 equatorial coordinates to of-date using P03 precession.
 */
export function convertJ2000ToOfDate(
    julianCenturiesSince2000Epoch: number,
    raJ2000: number,
    declJ2000: number,
): { raOfDate: number; declOfDate: number } {
    const { zetaA, zA, thetaA } = generalPrecessionQuantities(julianCenturiesSince2000Epoch);
    const cosDecl = Math.cos(declJ2000);
    const sinDecl = Math.sin(declJ2000);
    const cosTheta = Math.cos(thetaA);
    const sinTheta = Math.sin(thetaA);
    const term = cosDecl * Math.cos(raJ2000 + zetaA);
    const A = cosDecl * Math.sin(raJ2000 + zetaA);
    const B = cosTheta * term - sinTheta * sinDecl;
    const C = sinTheta * term + cosTheta * sinDecl;
    const raMinusZ = Math.atan2(A, B);
    let ra = fmod(raMinusZ + zA, TWO_PI);
    if (ra < 0) {
        ra += TWO_PI;
    }
    return { raOfDate: ra, declOfDate: Math.asin(C) };
}

/**
 * Convert of-date equatorial coordinates to J2000 using Meeus's formulae.
 * (P03 does not have formulae for the inverse; this uses Meeus approximation.)
 */
export function convertToJ2000FromOfDate(
    julianCenturiesSince2000Epoch: number,
    raOfDate: number,
    declOfDate: number,
): { raJ2000: number; declJ2000: number } {
    const T = julianCenturiesSince2000Epoch;
    const T2 = T * T;
    const t = -T;
    const t2 = t * t;
    const t3 = t2 * t;
    const toRad = Math.PI / (3600 * 180);

    const zetaA = ((2306.2181 + 1.39656 * T - 0.000139 * T2) * t
        + (0.30188 - 0.000344 * T) * t2 + 0.017998 * t3) * toRad;
    const zA = ((2306.2181 + 1.39656 * T - 0.000139 * T2) * t
        + (1.09468 + 0.000066 * T) * t2 + 0.018203 * t3) * toRad;
    const thetaA = ((2004.3109 - 0.85330 * T - 0.000217 * T2) * t
        - (0.42665 + 0.000217 * T) * t2 - 0.041833 * t3) * toRad;

    const cosDecl = Math.cos(declOfDate);
    const sinDecl = Math.sin(declOfDate);
    const cosTheta = Math.cos(thetaA);
    const sinTheta = Math.sin(thetaA);
    const term = cosDecl * Math.cos(raOfDate + zetaA);
    const A = cosDecl * Math.sin(raOfDate + zetaA);
    const B = cosTheta * term - sinTheta * sinDecl;
    const C = sinTheta * term + cosTheta * sinDecl;
    const raMinusZ = Math.atan2(A, B);
    let ra = fmod(raMinusZ + zA, TWO_PI);
    if (ra < 0) {
        ra += TWO_PI;
    }
    return { raJ2000: ra, declJ2000: Math.asin(C) };
}

/**
 * Refined conversion from of-date to J2000, using iterative round-trip refinement.
 * Gets accuracy to within ~0.01 arcsecond.
 */
export function refineConvertToJ2000FromOfDate(
    julianCenturiesSince2000Epoch: number,
    raOfDate: number,
    declOfDate: number,
): { raJ2000: number; declJ2000: number } {
    let { raJ2000: raTry, declJ2000: declTry } =
        convertToJ2000FromOfDate(julianCenturiesSince2000Epoch, raOfDate, declOfDate);

    // Two refinement iterations
    for (let i = 0; i < 2; i++) {
        const { raOfDate: raRT, declOfDate: declRT } =
            convertJ2000ToOfDate(julianCenturiesSince2000Epoch, raTry, declTry);
        const raOfDateTweak = raOfDate + (raOfDate - raRT);
        const declOfDateTweak = declOfDate + (declOfDate - declRT);
        ({ raJ2000: raTry, declJ2000: declTry } =
            convertToJ2000FromOfDate(julianCenturiesSince2000Epoch, raOfDateTweak, declOfDateTweak));
    }

    return { raJ2000: raTry, declJ2000: declTry };
}

// ============================================================================
// Sun RA/Decl wrapper (uses Willmann-Bell)
// ============================================================================

/**
 * Sun RA and Declination (of-date), with caching.
 */
export function sunRAandDecl(
    dateInterval: number,
    cache: AstroCache | null,
): { rightAscension: number; declination: number } {
    if (cache && cache.isValid(CacheSlot.sunRA)) {
        return {
            rightAscension: cache.get(CacheSlot.sunRA),
            declination: cache.get(CacheSlot.sunDecl),
        };
    }

    const { julianCenturiesSince2000Epoch } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);

    const result = WB_sunRAAndDecl(julianCenturiesSince2000Epoch / 100, cache ?? undefined);

    if (cache) {
        cache.set(CacheSlot.sunRA, result.rightAscension);
        cache.set(CacheSlot.sunDecl, result.declination);
    }

    return { rightAscension: result.rightAscension, declination: result.declination };
}

/**
 * Sun ecliptic longitude (apparent, of-date), with caching.
 */
export function sunEclipticLongitudeForDate(
    dateInterval: number,
    cache: AstroCache | null,
): number {
    if (cache && cache.isValid(CacheSlot.sunEclipticLongitude)) {
        return cache.get(CacheSlot.sunEclipticLongitude);
    }

    const { julianCenturiesSince2000Epoch } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);
    const eclipticLongitude = WB_sunLongitudeApparent(julianCenturiesSince2000Epoch / 100, cache ?? undefined);

    if (cache) {
        cache.set(CacheSlot.sunEclipticLongitude, eclipticLongitude);
    }

    return eclipticLongitude;
}

// ============================================================================
// Moon RA/Decl wrapper (uses Willmann-Bell)
// ============================================================================

/**
 * Moon RA, Declination, and ecliptic longitude (of-date), with caching.
 */
export function moonRAAndDecl(
    dateInterval: number,
    cache: AstroCache | null,
): { rightAscension: number; declination: number; moonEclipticLongitude: number } {
    if (cache && cache.isValid(CacheSlot.moonRA)) {
        return {
            rightAscension: cache.get(CacheSlot.moonRA),
            declination: cache.get(CacheSlot.moonDecl),
            moonEclipticLongitude: cache.get(CacheSlot.moonEclipticLongitude),
        };
    }

    const { julianCenturiesSince2000Epoch } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);

    const result = WB_MoonRAAndDecl(
        julianCenturiesSince2000Epoch,
        cache ?? undefined,
        ECWBPrecision.Full,
    );

    if (cache) {
        cache.set(CacheSlot.moonRA, result.rightAscension);
        cache.set(CacheSlot.moonDecl, result.declination);
        cache.set(CacheSlot.moonEclipticLongitude, result.longitude);
    }

    return {
        rightAscension: result.rightAscension,
        declination: result.declination,
        moonEclipticLongitude: result.longitude,
    };
}

// ============================================================================
// Planet angular size and parallax
// ============================================================================

/**
 * Calculate angular size and parallax for a planet at a given distance.
 */
export function planetSizeAndParallax(
    planetNumber: number,
    distanceInAU: number,
): { angularSize: number; parallax: number } {
    const radiusInAU = planetRadiiInAU[planetNumber];
    const angularSize = 2 * Math.atan(radiusInAU / distanceInAU);
    const parallax = Math.asin(Math.sin(8.794 / 3600 * Math.PI / 180) / distanceInAU);
    return { angularSize, parallax };
}

/**
 * Distance of a planet in AU.
 */
export function distanceOfPlanetInAU(
    planetNumber: number,
    julianCenturiesSince2000Epoch: number,
    cache: AstroCache | null,
    moonPrecision: ECWBPrecision = ECWBPrecision.Full,
): number {
    switch (planetNumber) {
        case ECPlanetNumber.Sun:
            return WB_sunRadius(julianCenturiesSince2000Epoch / 100, cache ?? undefined);
        case ECPlanetNumber.Moon:
            return WB_MoonDistance(julianCenturiesSince2000Epoch, cache ?? undefined, moonPrecision) / kECAUInKilometers;
        default:
            // For other planets, we'd call WB_planetApparentPosition
            // Skeleton: return 1 AU as placeholder
            return 1.0;
    }
}

/**
 * Meeus's h0: the altitude at rise/set for a planet.
 * Accounts for angular diameter, parallax, and refraction.
 */
export function altitudeAtRiseSet(
    julianCenturiesSince2000Epoch: number,
    planetNumber: number,
    wantGeocentricAltitude: boolean,
    cache: AstroCache | null,
    moonPrecision: ECWBPrecision = ECWBPrecision.Full,
): number {
    const dist = distanceOfPlanetInAU(planetNumber, julianCenturiesSince2000Epoch, cache, moonPrecision);
    const { angularSize: angularDiameter, parallax } = planetSizeAndParallax(planetNumber, dist);
    return (wantGeocentricAltitude ? parallax : 0) - kECRefractionAtHorizonX - angularDiameter / 2.0;
}
