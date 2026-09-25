/**
 * Calendar fields of an instant in a zone, from the hybrid calendar
 * (docs/calendar.md): Gregorian from 15 Oct 1582, Julian before, proleptic
 * Julian before 1 BCE.
 *
 * For any *display* of a weekday, month, day or year. JavaScript's `Date`
 * getters and `Intl.DateTimeFormat` are proleptic Gregorian: they disagree
 * with the hybrid calendar for every date before the switchover (a Julian
 * 1 Sep 1582 reads as 11 Sep) and report BCE years without their era. The
 * zone's offset is looked up at the instant (DST then; LMT before the zone's
 * first rule), the same offset the astronomy env and the time controller use.
 */

import {
    localComponentsFromTimeInterval, weekdayFromTimeInterval, daysInMonth,
    kECJulianGregorianSwitchoverTimeInterval,
    type ESDateComponents,
} from '../astronomy/es-calendar.js';
import { dateToDateInterval } from '../astronomy/es-time.js';
import { tzOffsetSecondsAt } from './astro-env.js';

export const WEEKDAY_NAMES = [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;
export const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
] as const;
export const MONTH_SHORT = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

export interface HybridDateFields extends ESDateComponents {
    /** 0 = Sunday … 6 = Saturday, by epoch arithmetic (calendar-independent). */
    weekday: number;
    weekdayName: string;
    monthName: string;
    monthShort: string;
    /** "2026", or "2026 BCE". */
    yearLabel: string;
    /** Leap year under the calendar in force for the date (Julian rules before 1582). */
    leap: boolean;
    /**
     * The instant precedes the 15 Oct 1582 switchover, so the fields are Julian
     * (proleptic Julian in BCE — every BCE date is also `julian`).
     */
    julian: boolean;
    /** The zone's UTC offset at the instant, seconds east-positive. */
    tzOffsetSec: number;
}

/**
 * @param timezone  IANA zone; undefined → the browser's own zone at the instant.
 */
export function hybridDateFields(date: Date, timezone: string | undefined): HybridDateFields {
    const di = dateToDateInterval(date);
    const tzOffsetSec = timezone
        ? tzOffsetSecondsAt(timezone, date.getTime())
        : -date.getTimezoneOffset() * 60;
    const cs = localComponentsFromTimeInterval(di, tzOffsetSec);
    const weekday = weekdayFromTimeInterval(di, tzOffsetSec);
    return {
        ...cs,
        weekday,
        weekdayName: WEEKDAY_NAMES[weekday],
        monthName: MONTH_NAMES[cs.month - 1],
        monthShort: MONTH_SHORT[cs.month - 1],
        yearLabel: cs.era === 0 ? `${cs.year} BCE` : String(cs.year),
        leap: daysInMonth(cs.era, cs.year, 2) === 29,
        julian: di < kECJulianGregorianSwitchoverTimeInterval,
        tzOffsetSec,
    };
}
