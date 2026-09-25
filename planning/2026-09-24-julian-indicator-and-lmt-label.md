# Julian-calendar indicator (Observatory + Chronometer) and the LMT zone label

Status: APPROVED 2026-09-24 — Steve took every recommendation below (see
"Decisions"); implementation in progress.

## Problem

1. Neither app says when the date on screen is a Julian-calendar date
   (docs/calendar.md: Julian before 15 Oct 1582, proleptic Julian before
   1 CE). Observatory's header shows "1500" exactly as it shows "2026"; the
   only hint anywhere is the time-controller popover's " (Julian)" suffix
   (`src/shared/time-controls-ui.ts:381`). Chronometer tints the year window
   red for BCE (the `bce cover` rect hand in six faces) but has nothing for
   CE Julian years.
2. Before a zone's first rule Intl has no abbreviation and hands back the
   offset itself, with seconds: Honolulu reads `GMT-10:31:26`, Los Angeles
   `GMT-7:52:58`, Vienna `GMT+1:05:21`. That lands in the header's small
   timezone slot — 12 characters where "HST" sits today — and, duplicated,
   in the time-controller / Inspector / Chronometer-footer zone lines
   ("Pacific/Honolulu (GMT-10:31:26) UTC-10:31:26").

Both bite in the same era, so they are one change: every pre-1582 instant is
also pre-standard-time, i.e. LMT.

## Design

### Observatory header: the word "Julian", small and dim, after the year

Recommendation: not a year-sized "J" with a popup, but the word **Julian** in
the existing secondary style (REL_SMALL 0.21, COLOR_DIM — the style of "leap"
and the zone abbreviation), placed immediately after the year in every
composition:

| mode                  | today                        | proposed                              |
|-----------------------|------------------------------|---------------------------------------|
| stack (A1/A3/A4)      | `1582` `leap` / `GMT-10:31:26` | `1582` `Julian` `leap` / `LMT`      |
| row (A2 phone)        | `Sep 1 · 1582 · GMT-10:31:26 · leap` | `Sep 1 · 1582 · Julian · LMT · leap` |
| split condensed (A5/A6) | `Sep 1  1582  GMT-10:31:26  leap` | `Sep 1  1582  Julian  LMT  leap`  |
| split landscape       | `1582  GMT-10:31:26  leap` / `Sep 1` | `1582  Julian  LMT  leap` / `Sep 1` |

Why the word and not "J":
- Self-explanatory on every device; no popup needed for it to be understood,
  so the touch problem disappears (touch has no hover anyway).
- No J/JUL/July ambiguity; "leap" already establishes "a small dim word
  beside the year is a calendar qualifier".
- Real estate: it only appears before 15 Oct 1582, and in that era the zone
  slot shrinks from `GMT-10:31:26` (12 chars) to `LMT` (3). Net, every
  Julian-era line gets *shorter* than it is today, in every mode.
- Shown for CE Julian dates only (1 CE – 4 Oct 1582). BCE dates already say
  "BCE" at year size, and BCE is always (proleptic) Julian; the BCE line is
  the tightest one ("4000 BCE") so it stays as is. Help says BCE implies
  Julian.

Fallback if Steve prefers minimal: `J` at REL_SMALL after the year, same
placement; everything else in this plan unchanged. (A `J` at year size is
~0.3u wide vs ~0.6u for "Julian" at small size — both are dwarfed by the
~1.1u the LMT change saves.)

### Zone slot: "LMT" when Intl has no abbreviation

New shared helper `tzAbbreviationAt(tz, date)`: Intl `timeZoneName:'short'`,
and when the result is an offset *with a seconds field*
(`/^(GMT|UTC)[+-]\d{1,2}:\d{2}:\d{2}$/`) return `LMT` — tzdata's own
abbreviation for local mean time, the state Intl is extrapolating. Everything
else passes through unchanged (`HST`, `PDT`, `GMT-10:30` for 1900 Honolulu,
`GMT+2` for present-day Vienna).

Verified with node's ICU (matches the browsers):

| zone / date          | short name     | → label |
|----------------------|----------------|---------|
| Honolulu 2026        | HST            | HST     |
| Honolulu 1900        | GMT-10:30      | GMT-10:30 (real standard time) |
| Honolulu 1800, 44 BCE | GMT-10:31:26  | LMT     |
| Los Angeles 1800     | GMT-7:52:58    | LMT     |
| Vienna 2026          | GMT+2          | GMT+2   |
| Kolkata 1900         | GMT+5:21:10    | LMT     |

Caveat: a handful of historical *standard* offsets also had seconds (Dublin
Mean Time −0:25:21 to 1916 is the same number as Dublin's LMT), so those read
LMT too. Acceptable — it is the same mean-time offset adopted as legal time.

The exact offset is not lost: the wide zone lines keep it —
`Pacific/Honolulu (LMT) UTC-10:31:26` — and the Observatory hover (below)
spells it out. Alternative considered: `UTC-10:31` (drop the seconds) in the
header; rejected — still 9 chars, and it reads as a zone the user could look
up, which LMT is not.

Out of scope, mention only: present-day `GMT+2` for Vienna (ICU has no
English abbreviation for CET/CEST). Could become `UTC+2` for consistency
with the offset lines; not part of this change unless wanted.

### Hover detail (mouse only, zero real estate)

Over the date box(es), set `canvas.title` to a one-line explanation and clear
it elsewhere; the browser's native tooltip does the rest. E.g.

- `Wednesday 1 September 1582 · Julian calendar · leap year · LMT = local mean time, UTC−10:31:26`
- `Friday 15 March 44 BCE · Before Common Era, proleptic Julian calendar · LMT = local mean time, UTC−7:52:58`
- `Thursday 18 June 2026 · HST, UTC−10:00`

Only rewritten when the string changes (a running clock must not re-trigger
the tooltip every frame). No touch affordance: the label itself is the
explanation, and Help covers the rest. This step is separable — drop it if
the native tooltip's delay/styling is not wanted.

### Chronometer: green Julian cover beside the red BCE cover

Mirror the `bce cover` mechanism: a second `Qhand type='rect'` per year
window, same x/y/length/width/tail, green `0x6000ff00` (37% alpha; tune by
eye — `0x6000c000` if pure green reads too neon over the white wheel), angle
`eraNumber() == 1 ? (GregorianEra() ? 0 : pi/2) : 0` (as built: a nested
ternary rather than `&&` — a raw `&` is not well-formed inside an XML
attribute and no face XML uses one). CE-only, like the Observatory word: in
BCE the red shows alone (red + green would blend to a muddy brown).
`GregorianEra()` already exists in the env (`src/shared/astro-env.ts:572`,
used by Geneva's leap covers).

Faces (7 hands in 6 files, each placed right after its `bce cover` so it stays
under the static front layer and shows only through the year window):

| file | line | notes |
|------|------|-------|
| src/watch/assets/vienna/Vienna-I.xml | 48 | |
| src/watch/assets/babylon/Babylon-I.xml | 100 | |
| src/watch/assets/firenze/Firenze-I.xml | 49 | |
| src/watch/assets/mauna-kea/MaunaKea-I.xml | 32 | |
| src/watch/assets/venezia/Venezia-I.xml | 62 | |
| src/watch/assets/basel/Basel-I.xml | 80, 81 | two windows; bce covers use `update='1 * years()'` — the Julian cover needs `days()` because the boundary is mid-year (4→15 Oct) |

One-instant nit fixed on the way: `GregorianEra()` tests `di > switchover`;
es-calendar treats `t < switchover` as Julian, so the switchover instant
itself is Gregorian. Change to `>=`.

Faces that show no year (Terra, Gaia, Selene, …) get nothing. Geneva uses
`yearNumber` only for its leap covers and has no BCE cover — nothing there.

## Steps

1. **Shared helpers**
   - `src/shared/hybrid-date.ts`: `HybridDateFields.julian: boolean` =
     `di < kECJulianGregorianSwitchoverTimeInterval`.
   - `src/shared/tz-label.ts` (new; as built — the zone label is not a
     calendar field, so it got its own module): `tzAbbreviationAt` (rule
     above), `utcOffsetLabelAt` ("UTC-10:31:26"), `formatZoneLine` (the
     shared "Zone (ABBR) UTC±h:mm" line of step 5), `isOffsetAbbreviation`.
   - Tests (`src/__tests__/tz-label.test.ts`): julian flag at 1582-10-04 /
     10-15 / 44 BCE; LMT mapping table above; passthrough cases; zone lines.
2. **Observatory date view** — `src/observatory/date-view.ts`
   - `DateFields` gains `julian: boolean` (CE-and-Julian); `tzAbbrev` from
     `tzAbbreviationAt`.
   - `drawDateView`: a `Julian` segment (REL_SMALL, COLOR_DIM) right after the
     year in all four compositions (lines 371–427).
   - Measurement must match rendering: `measureRowTexts` (l.222) takes the
     julian text; callers in `src/observatory/anchor-layout.ts` (A-wide l.469/484,
     A6 l.830) pass it; A1's per-line width list (l.735–742) adds the segment
     to the year line. (The layout is computed on resize with the date of
     that moment, so like "leap" the word is not reserved across a scrub —
     but the unreserved excess drops from 9 chars today to 6.)
3. **Hover** — `src/observatory/observatory-entry.ts` pointermove (l.1237–1247)
   and pointerleave: date-box hit test on `L.dateCX/CY/W/H` (+ `date2*` in
   split modes) → `canvas.title`; mouse pointers only.
4. **Chronometer covers** — the six XML files above + `GregorianEra` `>=`.
   - Goldens: `assertScenarioMatch` asserts the part *count*, so the 18
     snapshot files for these six faces must be recaptured (`CAPTURE=1`),
     then diffed against the old files by part *name* (the new hand shifts
     indices) with the field-bucketed numeric diff from the re-baseline
     audit, to prove the only change is the added part.
5. **Zone lines** — `formatTimezoneDisplay` (`src/shared/time-controls-ui.ts:481`)
   and `formatTimezoneInfo` (`src/inspector/inspector-entry.ts:166`) are
   near-identical; fold into one shared formatter using `tzAbbreviationAt`
   → `Pacific/Honolulu (LMT) UTC-10:31:26`. Chronometer's footer `#location-tz`
   comes along for free (same function).
6. **Help & docs**
   - `src/help/observatory.html` Day/date (l.83–88): the sentence "The year is
     shown in red for BCE dates" is stale for the web app (it says "BCE" after
     the year); rewrite to cover BCE, Julian, leap, the zone abbreviation and
     LMT, and the hover.
   - `src/help.html` calendar paragraph (~l.700–710): red/green year-window
     tints on the six faces.
   - `docs/observatory.md` (l.755–758), `docs/calendar.md` display section
     (l.93–100), `docs/timezone-and-dst.md` (LMT label rule next to the
     first-rule paragraph, l.21).
7. **Verify**
   - `npm test` (new tests + recaptured goldens green).
   - Observatory headless screenshots (memory: headless-dist-page-screenshots)
     at Honolulu with `?t=` seeded to 1500-06-01, 1582-10-04, 44 BCE and
     today, in the A1 stack, A2 row and A5 condensed anchors: word placement,
     "LMT", no overflow.
   - Chronometer: Vienna and Basel at 1500 CE (green), 44 BCE (red only),
     2026 (clear).
   - No version bump in this change (Steve bumps separately).

## Decisions (Steve, 2026-09-24)

1. "Julian" as a small dim word — not a "J".
2. ~~CE-only~~ — superseded mid-implementation: Steve's later thought was to
   show BCE as "J-BCE", expanding to "Julian BCE" where there is room, i.e.
   the BCE line should say it is Julian too. Built as the same small dim
   "Julian" qualifier on BCE dates ("44 BCE  Julian"): one word with one
   meaning everywhere, no layout-dependent expansion (measurement and
   rendering stay identical), no hyphenated token to learn, and the
   Inspector's date line (which shares `yearLabel`) is untouched. Width on
   the tightest line (phone-portrait row, "4000 BCE"): with "LMT" replacing
   "GMT-10:31:26", exactly today's width. If "J-BCE" is still preferred it
   is `yearLabel` in `src/shared/hybrid-date.ts` plus dropping the word for
   era 0 in `date-view.ts`.
3. "LMT" in the header slot; the exact offset stays on the wide zone lines
   and in the hover.
4. Keep the native-tooltip hover step.
5. Chronometer cover green `0x6000ff00`.
6. `GMT+2` → `UTC+2` stays out of this change.

Also from Steve: **Geneva I already indicates the calendar** — its leap
indicator has covers for the Gregorian 100- and 400-year rule positions
(`coverleap` wedges driven by `GregorianEra()`, `src/watch/assets/geneva/Geneva-I.xml:154-159`);
when those positions are covered the face is in the Julian era. No new
part for Geneva, but the Chronometer help and docs/calendar.md must say so.

## Follow-up (not in this change)

- Native pass: the green cover is a pure XML addition and ports to the iOS
  face files as-is; the LMT rule and the header word are web-only code.
