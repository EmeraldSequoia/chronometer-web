# Hybrid eclipses: why the table's links show "total", never "annular"

**Status**: IMPLEMENTED and COMMITTED (2026-08-19) — landed as c50fd6c
(the table page's hybrid paragraph + the help section's).
**Created**: 2026-08-19
**Baseline**: 3ec3638 (eclipse table page complete; topocentric fix 2f756b8 and
apparent-horizon fix f5c7a75 already in).

## The question

Steve's field report: on the 2013 Nov 03 **hybrid** row, EclipseWise describes
the eclipse as starting annular and becoming total, but Basel's wheel switches
directly Partial → Total at ~12:45:36 UT — no annular state in between. Theory:
the linked point of greatest eclipse never *has* an annular phase; you would
have to stand somewhere else on the path to see one.

## Findings — the theory is correct

**Taxonomy.** A hybrid's annular/total character is a property of **position
along the path**, not of time at one location. NASA's Five Millennium Catalog
key: the umbral vertex pierces Earth's surface along the middle of the path
(total) and falls short near the ends, where Earth's curvature puts the surface
farther from the Moon (annular). Every fixed observer sees exactly one central
kind; observers exactly at a transition point see a degenerate "beaded" ring
(Baily's beads around the full circumference), not two kinds. Catalog codes:
**H** = annular at both ends, total in the middle; **H2** = begins total, ends
annular; **H3** = begins annular, ends total.

**2013 Nov 03 is H3**, and its annular segment is extreme: per NASA OH2013, a
**4-second annular at sunrise** (11:05 UT, path 4 km wide, ~1000 km east of
Jacksonville FL), turning total "within the first 15 seconds of the shadow's
trajectory"; total for the rest of the track through greatest eclipse (12:46:29
UT at 3.49°N 11.70°W, 99.55 s) to sunset in Somalia. EclipseWise's
"starts annular, moves to total" describes that 3.4-hour sweep, not any
observer's experience.

**Engine agreement.** Replaying EclipseWise's central-line rows through
`calculateEclipse` (post-2f756b8):

- Minimum topocentric separation is **0.1–0.4 arcsec** at every row tested —
  the engine tracks the published centerline essentially exactly.
- At the greatest-eclipse point the engine flips Partial → Total at
  **12:45:37 UT** (Steve observed ~12:45:36; published C2 ≈ 12:45:39 derived
  from EclipseWise's duration). Total → Partial at 12:47:22 (105 s vs
  published 99.55 s — the small excess is threshold-margin, not alignment).
- **2013's annular start point does NOT reproduce in-app**: at the exact
  sunrise point the engine shows a hairline *Partial* (NASA's diameter ratio
  there is 0.999 — a ~1 arcsec annular window, inside the sub-arcsecond regime
  the topocentric plan deliberately left unchased). So for this eclipse no
  location shows Annular in the apps.
- **2023 Apr 20 (plain H) does reproduce**: both published path-end points
  classify **AnnularSolar** (begins 02:37:07 UT at 48.450°S 63.625°E; ends
  05:56:36 UT at 2.930°N 178.807°W; min separation 0.1–0.2 arcsec).

**Adjacent fix already in**: f5c7a75 moved EO's below-horizon wash/caption to
the apparent horizon and gated it on the eclipse kind, so the path-end sunrise
demo renders consistently with Basel's wheel.

## Decision

No engine or dial changes. `EclipseKind` having no Hybrid member is **correct
by design** — the classifier reports what a fixed observer sees, and no
observer sees "hybrid". Basel's wheel and the Inspector's kind list stay as
they are. This is purely a communication gap: nothing user-facing explained
that a hybrid row's links land mid-path and therefore read "Total Solar".

## The wording (implemented)

1. **Eclipse Table page** (src/eclipse-table.html, end of the links
   paragraph): "A **hybrid solar** eclipse is total along the middle of its
   path and annular only briefly where the path begins or ends; the point of
   greatest eclipse lies in the middle, so its links show a total eclipse.
   Stand near an end of the path instead and the same eclipse appears as a
   thin ring."
2. **Main help, Understanding Eclipses** (src/help.html, after the
   greatest-eclipse paragraph): the same explanation with the physical cause
   in plain words, app-gated wheel/simulator phrasing, plus a concrete demo
   pinned to the eclipse where the engine actually reproduces annularity:
   the **2023 Apr 20** row, location 48.45°S 63.63°E, time 02:37 UT — the
   same eclipse arrives there at sunrise as a thin ring.

## Explicitly not done

- No demo pointing at 2013's annular segment — the engine (defensibly) calls
  it a hairline partial, and pointing users at a 4 s, 4 km event our model
  can't reproduce would manufacture a bug report.
- No `title=` tooltips (no such mechanism on the page; touch-unfriendly) and
  no per-card label change ("Hybrid solar (total here)" — too clever).
- No new deep links; the demo is one sentence with manual coordinates,
  matching the existing Observatory-help pattern for off-path exploration.
- No Hybrid member in `EclipseKind`, ever (see Decision).

## Sources

- eclipse.gsfc.nasa.gov/SEcat5/catkey.html (taxonomy, H/H2/H3 codes)
- eclipse.gsfc.nasa.gov/OH/OH2013.html (2013 narrative, 4 s annular)
- eclipsewise.com SE2013Nov03Hprime + SE2013Nov03Hpath (circumstances, path table)
- eclipsewise.com SE2023Apr20Hprime (2023 path ends)
