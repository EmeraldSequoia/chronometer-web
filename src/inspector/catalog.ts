/**
 * Inspector ephemeris catalog — the declarative table of grouped astronomical /
 * time values shown in the scrolling catalog region.
 *
 * Each cell is an expression + a display **tag** + an update interval. The tag
 * determines both the ObsValue animation semantics (`linear` flag) and the
 * display format used by inspector-entry's tag formatters.
 *
 * See planning/2026-06-04-inspector-ephemeris-catalog.md.
 */

/** Display/animation tag for a catalog value. */
export type Tag =
    // Continuous (eval-ahead, smoothly animated):
    | 'A'      // full-circle angle: linear=false, shown 0–360°
    | 'NGAP'   // node–syzygy angle: linear=false, shown "N° from new/full moon"
    | 'Ldeg'   // bounded angle (decl/alt/lat): linear=true, signed degrees
    | 'Num'    // continuous fractional number: linear=true
    | 'SEC'    // seconds-of-minute (clock): linear=true, zero-padded "SS.sss"
               // (fixed width, so the wrapped Clock row doesn't re-wrap each minute)
    | 'DIST'   // distance in AU: linear=true, shown as AU + km
    | 'HMS'    // clock quantity in seconds: linear=true, "HH:MM:SS.sss"
    | 'MS'     // small signed duration (EOT): linear=true, "±MM:SS.sss"
    // Discrete (evaluate-at-now, snapped — interpolation is meaningless):
    | 'Int'    // integer count (year/hour): discrete
    | 'BOOL'   // 0/1 flag: discrete, shown "yes"/"no"
    | 'WD'     // weekday number (0-based): discrete, shown "0 (Sunday)"
    | 'MO'     // month number (0-based): discrete, shown "0 (January)"
    | 'DAY'    // day-of-month (0-based): discrete, shown "4 (5th)"
    | 'HM'     // signed clock offset in seconds: discrete, "±HH:MM"
    | 'LT'     // dateInterval (event time): discrete, local time/date
    | 'EK'     // eclipse kind (collapsed wheel value 0–7): discrete, Basel wheel text
    | 'ND';    // nearest lunar node (0/1): discrete, "Ascending"/"Descending"

/** True if a tag animates with angular (wrapping) semantics. */
export function tagIsAngular(tag: Tag): boolean {
    return tag === 'A' || tag === 'NGAP';
}

/** True if a tag is discrete (evaluate-at-now + snap, no interpolation). */
export function tagIsDiscrete(tag: Tag): boolean {
    return tag === 'Int' || tag === 'BOOL' || tag === 'WD' || tag === 'MO'
        || tag === 'DAY' || tag === 'HM' || tag === 'LT' || tag === 'EK'
        || tag === 'ND';
}

export interface CatalogCell {
    /** Per-cell label (may be '' for a single-value row that uses the row label). */
    label: string;
    expr: string;
    tag: Tag;
    /** Update interval in seconds (eval-ahead boundary). */
    updateInterval: number;
}

export interface CatalogRow {
    /** Optional subgroup label shown at the start of the row. */
    rowLabel?: string;
    /** 'pairs' (default): cells share the row width as aligned columns.
     *  'fields': compact content-sized cells on a line (Date/Clock numbers). */
    layout?: 'pairs' | 'fields';
    cells: CatalogCell[];
}

export interface CatalogGroup {
    name: string;
    rows: CatalogRow[];
}

// Update cadences (seconds).
const FAST = 0.1;    // continuously-advancing sub-second values
const NORMAL = 1;    // coordinates (change slowly; eval-ahead keeps them smooth)
const SLOW = 60;     // rise/set/transit, distance, near-constant values

// ============================================================================
// Time
// ============================================================================

const TIME_GROUP: CatalogGroup = {
    name: 'Time',
    rows: [
        {
            rowLabel: 'Date',
            layout: 'fields',
            cells: [
                { label: 'Year', expr: 'yearNumber()', tag: 'Int', updateInterval: NORMAL },
                { label: 'Month', expr: 'monthNumber()', tag: 'MO', updateInterval: NORMAL },
                { label: 'Day Index', expr: 'dayNumber()', tag: 'DAY', updateInterval: NORMAL },
            ],
        },
        {
            // Weekday on its own line, aligned under Year (empty label fills the
            // label column so the field starts at the same x).
            layout: 'fields',
            cells: [
                { label: 'Weekday', expr: 'weekdayNumber()', tag: 'WD', updateInterval: NORMAL },
            ],
        },
        {
            rowLabel: 'Clock',
            layout: 'fields',
            cells: [
                { label: 'Hour', expr: 'hour24Number()', tag: 'Int', updateInterval: NORMAL },
                { label: 'Minute', expr: 'minuteNumber()', tag: 'Int', updateInterval: NORMAL },
                { label: 'Second', expr: 'secondValue()', tag: 'SEC', updateInterval: FAST },
            ],
        },
        { rowLabel: 'Sidereal time', cells: [{ label: '', expr: 'lstValue()', tag: 'HMS', updateInterval: FAST }] },
        { rowLabel: 'Solar time', cells: [{ label: '', expr: 'solarTimeSec()', tag: 'HMS', updateInterval: FAST }] },
        { rowLabel: 'TZ offset', cells: [{ label: '', expr: 'tzOffset()', tag: 'HM', updateInterval: SLOW }] },
        {
            rowLabel: 'Equation of time',
            cells: [
                { label: 'Δt', expr: 'EOTSeconds()', tag: 'MS', updateInterval: SLOW },
                { label: 'angle', expr: 'EOTAngle()', tag: 'A', updateInterval: SLOW },
            ],
        },
    ],
};

// ============================================================================
// Sun
// ============================================================================

const SUN_GROUP: CatalogGroup = {
    name: 'Sun',
    rows: [
        { rowLabel: 'RA / Dec', cells: [
            { label: 'RA', expr: 'sunRA()', tag: 'A', updateInterval: NORMAL },
            { label: 'Dec', expr: 'declinationOfPlanet(0)', tag: 'Ldeg', updateInterval: NORMAL },
        ] },
        { rowLabel: 'Alt / Az', cells: [
            { label: 'Alt', expr: 'sunAltitude()', tag: 'Ldeg', updateInterval: NORMAL },
            { label: 'Az', expr: 'sunAzimuth()', tag: 'A', updateInterval: NORMAL },
            { label: 'Up?', expr: 'planetIsUp(0)', tag: 'BOOL', updateInterval: NORMAL },
        ] },
        { rowLabel: 'Ecliptic', cells: [
            { label: 'Lon', expr: 'ELongitudeOfPlanet(0)', tag: 'A', updateInterval: NORMAL },
        ] },
        { rowLabel: 'Sub-solar pt', cells: [
            { label: 'Lat', expr: 'subSolarLatitude()', tag: 'Ldeg', updateInterval: NORMAL },
            { label: 'Lon', expr: 'subSolarLongitude()', tag: 'A', updateInterval: NORMAL },
        ] },
        { rowLabel: 'Solar-noon angle', cells: [
            { label: '', expr: 'solarNoonAngle24h()', tag: 'A', updateInterval: NORMAL },
        ] },
        { rowLabel: 'Rise / Set / Transit', cells: [
            { label: 'Rise', expr: 'sunriseForDayTime()', tag: 'LT', updateInterval: SLOW },
            { label: 'Set', expr: 'sunsetForDayTime()', tag: 'LT', updateInterval: SLOW },
            { label: 'Transit', expr: 'sunTransitForDayTime()', tag: 'LT', updateInterval: SLOW },
        ] },
    ],
};

// ============================================================================
// Moon
// ============================================================================

const MOON_GROUP: CatalogGroup = {
    name: 'Moon',
    rows: [
        { rowLabel: 'RA / Dec', cells: [
            { label: 'RA', expr: 'moonRA()', tag: 'A', updateInterval: NORMAL },
            { label: 'Dec', expr: 'declinationOfPlanet(1)', tag: 'Ldeg', updateInterval: NORMAL },
        ] },
        { rowLabel: 'Alt / Az', cells: [
            { label: 'Alt', expr: 'moonAltitude()', tag: 'Ldeg', updateInterval: NORMAL },
            { label: 'Az', expr: 'moonAzimuth()', tag: 'A', updateInterval: NORMAL },
            { label: 'Up?', expr: 'planetIsUp(1)', tag: 'BOOL', updateInterval: NORMAL },
        ] },
        { rowLabel: 'Ecliptic', cells: [
            { label: 'Lon', expr: 'ELongitudeOfPlanet(1)', tag: 'A', updateInterval: NORMAL },
            { label: 'Lat', expr: 'ELatitudeOfPlanet(1)', tag: 'Ldeg', updateInterval: NORMAL },
        ] },
        { rowLabel: 'Phase', cells: [
            { label: 'Age', expr: 'moonAgeAngle()', tag: 'A', updateInterval: NORMAL },
            { label: 'Elongation', expr: 'moonElongation()', tag: 'A', updateInterval: NORMAL },
        ] },
        { rowLabel: 'Position', cells: [
            { label: 'Relative', expr: 'moonRelativeAngle()', tag: 'A', updateInterval: NORMAL },
            { label: 'Rel-position', expr: 'moonRelativePositionAngle()', tag: 'A', updateInterval: NORMAL },
        ] },
        { rowLabel: 'Asc. node', cells: [
            { label: 'Lon', expr: 'lunarAscendingNodeLongitude()', tag: 'A', updateInterval: NORMAL },
            { label: 'RA', expr: 'lunarAscendingNodeRA()', tag: 'A', updateInterval: NORMAL },
        ] },
        { rowLabel: 'Distance', cells: [
            { label: '', expr: 'distanceFromEarthOfPlanet(1)', tag: 'DIST', updateInterval: SLOW },
        ] },
        { rowLabel: 'Rise / Set / Transit', cells: [
            { label: 'Rise', expr: 'moonriseForDayTime()', tag: 'LT', updateInterval: SLOW },
            { label: 'Set', expr: 'moonsetForDayTime()', tag: 'LT', updateInterval: SLOW },
            { label: 'Transit', expr: 'moonTransitForDayTime()', tag: 'LT', updateInterval: SLOW },
        ] },
    ],
};

// ============================================================================
// Eclipse
// ============================================================================

// The eclipse story in row order: how close the Moon is to new/full (an
// eclipse needs a syzygy), whether the Moon is near the ecliptic (latitude
// ≈ 0 means it's near a node), how the node the Moon is closest to relates
// to where new/full moons currently occur, and finally Basel's verdict — the
// abstract separation level (<1 total, 1–2 partial, >2 none) and the kind
// wheel text.
const ECLIPSE_GROUP: CatalogGroup = {
    name: 'Eclipse',
    rows: [
        { rowLabel: 'Separation', cells: [
            { label: 'Δ Lon (geo)', expr: 'moonAgeAngle()', tag: 'A', updateInterval: NORMAL },
            { label: 'Elongation', expr: 'moonElongation()', tag: 'A', updateInterval: NORMAL },
        ] },
        { rowLabel: 'Moon ecl. lat (geo)', cells: [
            { label: '', expr: 'ELatitudeOfPlanet(1)', tag: 'Ldeg', updateInterval: NORMAL },
        ] },
        {
            rowLabel: 'Nearest node',
            // 'fields': the gap cell ("NN.NN° from full moon") is wider than a
            // pairs value column; content-sized cells wrap instead of truncating.
            layout: 'fields',
            cells: [
                { label: '', expr: 'lunarNearestNodeIsDescending()', tag: 'ND', updateInterval: NORMAL },
                { label: 'Lon (geo)', expr: 'lunarNearestNodeLongitude()', tag: 'A', updateInterval: NORMAL },
                { label: '', expr: 'lunarNearestNodeMinusSunLongitude()', tag: 'NGAP', updateInterval: NORMAL },
            ],
        },
        { rowLabel: 'Level', cells: [
            { label: '', expr: 'eclipseSeparation()', tag: 'Num', updateInterval: NORMAL },
            { label: 'Kind', expr: 'legacyEclipseKind()', tag: 'EK', updateInterval: NORMAL },
        ] },
    ],
};

// ============================================================================
// Planets (template × list, inner → outer)
// ============================================================================

const PLANETS: { name: string; n: number }[] = [
    { name: 'Mercury', n: 2 },
    { name: 'Venus', n: 3 },
    { name: 'Mars', n: 5 },
    { name: 'Jupiter', n: 6 },
    { name: 'Saturn', n: 7 },
    { name: 'Uranus', n: 8 },
    { name: 'Neptune', n: 9 },
];

function planetGroup(name: string, n: number): CatalogGroup {
    return {
        name,
        rows: [
            { rowLabel: 'RA / Dec', cells: [
                { label: 'RA', expr: `RAOfPlanet(${n})`, tag: 'A', updateInterval: NORMAL },
                { label: 'Dec', expr: `declinationOfPlanet(${n})`, tag: 'Ldeg', updateInterval: NORMAL },
            ] },
            { rowLabel: 'Alt / Az', cells: [
                { label: 'Alt', expr: `altitudeOfPlanet(${n})`, tag: 'Ldeg', updateInterval: NORMAL },
                { label: 'Az', expr: `azimuthOfPlanet(${n})`, tag: 'A', updateInterval: NORMAL },
                { label: 'Up?', expr: `planetIsUp(${n})`, tag: 'BOOL', updateInterval: NORMAL },
            ] },
            { rowLabel: 'Ecliptic (geo)', cells: [
                { label: 'Lon', expr: `ELongitudeOfPlanet(${n})`, tag: 'A', updateInterval: NORMAL },
                { label: 'Lat', expr: `ELatitudeOfPlanet(${n})`, tag: 'Ldeg', updateInterval: NORMAL },
            ] },
            { rowLabel: 'Ecliptic (helio)', cells: [
                { label: 'Lon', expr: `HLongitudeOfPlanet(${n})`, tag: 'A', updateInterval: NORMAL },
                { label: 'Lat', expr: `HLatitudeOfPlanet(${n})`, tag: 'Ldeg', updateInterval: NORMAL },
            ] },
            { rowLabel: 'Distance (geo)', cells: [
                { label: '', expr: `distanceFromEarthOfPlanet(${n})`, tag: 'DIST', updateInterval: SLOW },
            ] },
            { rowLabel: 'Distance (helio)', cells: [
                { label: '', expr: `distanceFromSunOfPlanet(${n})`, tag: 'DIST', updateInterval: SLOW },
            ] },
            { rowLabel: 'Rise / Set / Transit', cells: [
                { label: 'Rise', expr: `riseOfPlanetForDayTime(${n})`, tag: 'LT', updateInterval: SLOW },
                { label: 'Set', expr: `setOfPlanetForDayTime(${n})`, tag: 'LT', updateInterval: SLOW },
                { label: 'Transit', expr: `transitOfPlanetForDayTime(${n})`, tag: 'LT', updateInterval: SLOW },
            ] },
        ],
    };
}

// ============================================================================
// Full catalog
// ============================================================================

export const CATALOG: CatalogGroup[] = [
    TIME_GROUP,
    SUN_GROUP,
    MOON_GROUP,
    ECLIPSE_GROUP,
    ...PLANETS.map(p => planetGroup(p.name, p.n)),
];

/** Total number of value cells (for sanity checks / display). */
export function catalogCellCount(): number {
    let n = 0;
    for (const g of CATALOG) for (const r of g.rows) n += r.cells.length;
    return n;
}
