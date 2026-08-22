# Calendar System

The Chronometer app uses a **hybrid Julian/Gregorian calendar** for all dates. This is not the proleptic Gregorian calendar that JavaScript's `Date` object uses. Understanding this distinction is critical when writing or reviewing any code that deals with dates, day-of-week, month length, or calendar grids.

## The Convention

From the iOS help file:

> Emerald Chronometer uses the Gregorian calendar for future dates and for past dates back to 1582, and the Julian calendar from 1 BCE to 1582 CE. Prior to 1 BCE it uses a proleptic Julian calendar, with leap years on 1 BCE, 5 BCE, etc, back every four years.

| Date range | Calendar system |
|---|---|
| Oct 15, 1582 CE → future | **Gregorian** |
| 1 BCE → Oct 4, 1582 CE | **Julian** |
| Before 1 BCE | **Proleptic Julian** (leap years: 1 BCE, 5 BCE, 9 BCE, …) |

The switchover date is **October 15, 1582**. Days October 5–14, 1582 **do not exist** in this hybrid calendar. This gap is handled explicitly in the Babylon calendar grid (`calendarWheelOct1582`), with a **7-slot blank row** inserted between day 4 and day 15 to keep weekday columns aligned while providing a visible gap.

## Why This Matters

JavaScript's `Date` object always uses the **proleptic Gregorian calendar** — it retroactively applies Gregorian rules (including the century leap year exceptions) to all dates, even those before 1582. This produces **different results** from the hybrid calendar for any date before Oct 15, 1582:

- **Different day-of-week**: `new Date(1582, 9, 4).getDay()` returns the *Gregorian* weekday for Oct 4, 1582, which differs from the Julian weekday by several days.
- **Different month lengths**: February in a year like 1500 CE has 29 days in the Julian calendar (divisible by 4) but only 28 in the Gregorian calendar (century exception).
- **Different leap year rules**: The Julian calendar has a simple every-4-years rule. The Gregorian adds the 100/400 exceptions.
- **Missing dates**: Oct 5–14, 1582 don't exist in the hybrid calendar but do exist in JavaScript's proleptic Gregorian.

## Implementation

### Core module: `es-calendar.ts`

[es-calendar.ts](../src/astronomy/es-calendar.ts) is a faithful port of `ESCalendar.cpp` from the iOS `estime` library. It provides:

| Function | Purpose |
|---|---|
| `utcComponentsFromTimeInterval()` | Decompose an `ESTimeInterval` into hybrid calendar components (UTC) |
| `localComponentsFromTimeInterval()` | Same, but with timezone offset applied |
| `timeIntervalFromUTCComponents()` | Convert hybrid calendar components back to `ESTimeInterval` |
| `timeIntervalFromLocalComponents()` | Same, from local time with timezone correction |
| `daysInMonth()` | Number of days in a month, respecting the hybrid calendar's leap year rules |
| `weekdayFromTimeInterval()` | Weekday via epoch arithmetic — correct for all dates |
| `addMonthsToTimeInterval()` | Calendar-aware month addition/subtraction with day clamping |
| `addYearsToTimeInterval()` | Calendar-aware year addition/subtraction with day clamping |
| `gregorianToHybrid()` | Convert a Gregorian date to the hybrid calendar |
| `hybridToGregorian()` | Convert a hybrid calendar date to Gregorian |

All date interval ↔ component conversions automatically choose Julian or Gregorian arithmetic based on whether the time falls before or after the switchover.

### Calendar functions in `watch-env.ts`

The expression environment registers calendar functions that the XML watch definitions use. These **must** use `es-calendar.ts` for date decomposition, not JavaScript `Date` methods:

| Function | Correct implementation |
|---|---|
| `dayNumber`, `dayNumberAngle` | ✅ Uses `getLocalComponents()` → `es-calendar.ts` |
| `monthNumber`, `monthNumberAngle` | ✅ Uses `getLocalComponents()` → `es-calendar.ts` |
| `yearNumber` | ✅ **Always positive** — returns `cs.year` for both CE and BCE |
| `eraNumber` | ✅ Returns 0 for BCE, 1 for CE |
| `weekdayNumber`, `weekdayNumberAngle` | ✅ Uses `weekdayFromTimeInterval()` (epoch arithmetic) |
| `monthLen` | ✅ Uses `calendarDaysInMonth()` from `es-calendar.ts` |
| `leapYearIndicatorAngle` | ✅ Uses `getLocalComponents()` with correct Julian/Gregorian logic |
| `calendarRow` | ✅ Uses `getLocalComponents()` with Oct 1582 handling |

### Weekday computation

The iOS code computes weekday using **epoch arithmetic** on the continuous `ESTimeInterval`, not via a calendar API:

```cpp
// From ESCalendar.cpp
ESTimeInterval localNow = timeInterval + tzOffset;
double localNowDays = localNow / (24 * 3600);
double weekday = fmod(localNowDays + 1, 7);
return (int)floor(weekday);
```

This works because `ESTimeInterval` is a continuous count of seconds since a known epoch, so dividing by 86400 and taking mod 7 directly gives the day-of-week without needing to know which calendar system is in effect. The `+1` constant aligns the epoch (Jan 1, 2001, which was a Monday) so that 0=Sunday.

The web code uses `weekdayFromTimeInterval()` in `es-calendar.ts` — a faithful port of this iOS function.

> [!WARNING]
> Using `Date.getDay()` produces **incorrect weekday values** for dates before Oct 15, 1582 because JavaScript's `Date` uses the proleptic Gregorian calendar, not the hybrid Julian/Gregorian calendar. Any code computing weekday for arbitrary dates must use epoch arithmetic or `es-calendar.ts`.

### Time bar display

The time bar at the bottom of each face page uses hybrid calendar decomposition:

- **`formatSimTime`** decomposes dates via `localComponentsFromTimeInterval`:
  - Shows `"BCE"` suffix for era 0 (e.g., `"Mar 15, 44 BCE  12:00:00"`)
  - Shows `"(Julian)"` suffix for dates before the Oct 15, 1582 switchover
- **`updateTimeUI`** populates the date picker inputs from hybrid calendar components
- **`formatOffset`** uses hybrid calendar year/month differencing
- **Date input "Apply"** constructs dates via `timeIntervalFromLocalComponents`
- **BCE toggle** in the time controller popover switches between CE and BCE eras

> [!IMPORTANT]
> The timezone offset passed to `localComponentsFromTimeInterval` must be the **actual UTC offset** of the target timezone (east-positive, in seconds), not `tzDeltaMs`. The helper `targetTzOffsetSec(d)` computes this as `-d.getTimezoneOffset() * 60 + tzDeltaMs / 1000`.

## Notes on Remaining JS `Date` Usage

> [!NOTE]
> The following uses of JavaScript `Date` methods are **intentional** and correct:

- **`DSTNumber`** (`watch-env.ts`): Uses `getFullYear()` to probe the system's DST offset at Jan/Jul. DST is a modern concept, so proleptic Gregorian is fine here.
- **`moonDeltaEclipticLongitudeAtDeltaDay`** (`watch-env.ts`): Uses JS `Date` to find midnight ± n days. This is an astronomy offset calculation, not calendar display.
- **`delOnDayTintColor` family** (`watch-env.ts`): Uses `getNow().getTime() + tzOffsetMs` for parity-based color alternation — adding the full UTC-to-target offset shifts the epoch day boundary to local midnight.
- **`second`/`minute`/`hour`/`day` stepping** (`time-controller.ts`): Uses JS `Date.setSeconds()` etc. — these are continuous timestamp operations that don't involve calendar decomposition.

## Rules for New Code

1. **Never use `Date.getDay()`** for weekday if the date might be before Oct 15, 1582. Use `weekdayFromTimeInterval()` from `es-calendar.ts`.

2. **Never use `new Date(year, month, 0).getDate()`** for month length. Use `daysInMonth()` from `es-calendar.ts`.

3. **Never construct `new Date(year, month, day)`** to determine day-of-week for calendar grids. Use `timeIntervalFromUTCComponents()` → `weekdayFromTimeInterval()`.

4. **For month/year stepping**, use `addMonthsToTimeInterval()` / `addYearsToTimeInterval()` from `es-calendar.ts`.

5. **Test with scrubbed dates** in the Julian era (e.g., year 1200 CE) and across the 1582 switchover to verify calendar correctness.

6. **`yearNumber()` is always positive.** It matches iOS's `yearNumberUsingEnv:` which returns `cs.year` regardless of era. Use `eraNumber()` separately for BCE detection. The negative-year variant is `yearNumberCEMonotonic()` (era 1 → positive, era 0 → negative).

7. **After setting a new time** via `timeController.setTime()`, call `finishAllAnimations()` + `resetAllSchedules()` + `stopScheduler()` + `startScheduler()` to force a re-render. Just calling `ensureSchedulerRunning()` is insufficient when the scheduler is already in idle mode.

## October 1582 Implementation Details

The Babylon calendar wheel and associated components require special handling for the Julian-Gregorian switchover month:

### Calendar Wheel (`renderer.ts`)

The `calendarWheelOct1582` quadrant uses a **slot-based** drawing approach. After drawing day 4, it:
1. Advances the day counter from 5 to 15 (skipping the non-existent days)
2. Advances the slot counter by 7 (inserting one full blank row)

This creates a visible gap while keeping weekday columns aligned and making Oct 31 line up with the November next-month slider.

### Calendar Row Bar (`watch-env.ts`)

The `calendarRow` function subtracts **3** (not 10) from `dayNumber` for Oct 1582 days 15+. The math: 10 skipped days minus the 7 gap slots = 3. This ensures the red row indicator jumps correctly over the blank gap row.

### Hidden Wheel Rotation (`watch-env.ts`)

The `rotationForCalendarWheel012B` and `rotationForCalendarWheel3456` functions return **stable cutout angles** for all of October 1582, bypassing `columnOfFirstOfMonth()`. Without this, `columnOfFirstOfMonth()` returns different (bogus) values for Oct 4 vs Oct 15, causing a visible animation glitch as the hidden wheels rotate through non-blank quadrants during transitions.

> [!NOTE]
> `columnOfFirstOfMonth()` cannot correctly compute the first-of-month column for Oct 15+ 1582 because it unwinds from the current day position, but the unwind arithmetic doesn't account for the 10-day gap. This is only a problem for the hidden wheel angles; all other Oct 1582 handling uses explicit special cases.

## Key Source Files

| File | Purpose |
|---|---|
| [es-calendar.ts](../src/astronomy/es-calendar.ts) | Core hybrid calendar: decomposition, recomposition, julian↔gregorian conversion |
| [watch-env.ts](../src/watch/watch-env.ts) | Registers calendar functions for XML expressions |
| [animation.ts](../src/shared/animation.ts) | Calendar cover offset computation (Babylon) |
| [renderer.ts](../src/watch/renderer.ts) | Calendar wheel rendering (Babylon grid, Oct 1582 handling) |
| [time-controller.ts](../src/shared/time-controller.ts) | Time scrubbing with month/year steps |
| [engine-entry.ts](../src/engine-entry.ts) | Time bar display (`formatSimTime`), date input, offset formatting |

## iOS Reference

| File | Purpose |
|---|---|
| `.estime-ref/src/ESCalendar.cpp` | Original hybrid calendar C++ implementation |
| `.estime-ref/src/ESWatchTime.cpp` | `weekdayNumberUsingEnv`, `weekdayValueUsingEnv`, calendar column functions |

## Related Docs

- [Astronomy](astronomy.md) — Julian dates, ΔT, and the calendar module's role in astronomical calculations
- [Development Rules](development-rules.md) — Never-simplify rule applies to calendar algorithms
- [iOS Reference](ios-reference.md) — How to trace calendar functions through the iOS code
