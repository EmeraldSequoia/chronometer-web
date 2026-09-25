/**
 * Zone labels for display: the abbreviation ("HST", "PDT", "LMT") and the
 * "UTC-10:31:26" offset string, both from Intl at a given instant.
 *
 * Intl has no abbreviation for an instant before a zone's first rule: it
 * extrapolates the zone's local mean time and hands back the offset itself,
 * with seconds ("GMT-10:31:26" for Honolulu before 1896, "GMT-7:52:58" for
 * Los Angeles before 1883). That is the state tzdata abbreviates as LMT, so
 * `tzAbbreviationAt` returns "LMT" for any offset-with-seconds abbreviation
 * and passes everything else through: "GMT-10:30" for 1900 Honolulu is real
 * standard time, and "GMT+2" is ICU's English name for present-day Vienna
 * (en-US has no CET/CEST abbreviation). A handful of historical *standard*
 * offsets also carried seconds (Dublin Mean Time, -0:25:21 until 1916) and
 * read LMT too — the same mean-time offset adopted as legal time.
 *
 * See docs/timezone-and-dst.md and
 * planning/2026-09-24-julian-indicator-and-lmt-label.md.
 */

/** An Intl "abbreviation" that is really an offset with a seconds field. */
const OFFSET_WITH_SECONDS = /^(?:GMT|UTC)[+-]\d{1,2}:\d{2}:\d{2}$/;

function tzNamePart(
    timeZone: string | undefined, style: 'short' | 'longOffset', date: Date,
): string {
    try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: style })
            .formatToParts(date);
        return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    } catch {
        return '';
    }
}

/** True for the abbreviation forms that are offsets ("GMT+2", "UTC-10:30"), not names. */
export function isOffsetAbbreviation(abbr: string): boolean {
    return /^(?:GMT|UTC)(?:[+-]\d|$)/.test(abbr);
}

/**
 * The zone's abbreviation at the instant — "HST", "PDT", "GMT+2" — or "LMT"
 * when Intl reports local mean time as an offset with seconds. `timezone`
 * undefined → the browser's own zone. '' if Intl rejects the zone.
 */
export function tzAbbreviationAt(timezone: string | undefined, date: Date): string {
    const abbr = tzNamePart(timezone, 'short', date);
    return OFFSET_WITH_SECONDS.test(abbr) ? 'LMT' : abbr;
}

/**
 * The zone's UTC offset at the instant as "UTC-7:00", "UTC+5:30",
 * "UTC-10:31:26" or "UTC": Intl's longOffset with the leading zero dropped.
 * '' if Intl rejects the zone.
 */
export function utcOffsetLabelAt(timezone: string | undefined, date: Date): string {
    const off = tzNamePart(timezone, 'longOffset', date);
    return off.replace('GMT', 'UTC').replace(/([+-])0(\d)/, '$1$2');
}

/**
 * The zone line under a face and in the time-controller / location popovers:
 * "America/Los_Angeles (PDT) UTC-7:00" (non-breaking spaces), or without the
 * zone name, "(PDT) UTC-7:00". '' without a zone; if Intl rejects the zone,
 * the bare id (with the name) or '' (without).
 */
export function formatZoneLine(olsonId: string | undefined, ref: Date, withName: boolean): string {
    if (!olsonId) return '';
    const abbr = tzAbbreviationAt(olsonId, ref);
    const utc = utcOffsetLabelAt(olsonId, ref);
    if (!abbr && !utc) return withName ? olsonId : '';
    return (withName ? `${olsonId} ` : '') + `(${abbr}) ${utc}`;
}
