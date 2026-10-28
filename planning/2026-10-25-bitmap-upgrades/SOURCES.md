# Image sources, credits and crop recipes (2026-10-26)

All NASA imagery: not copyrighted (NASA media usage guidelines); credit the
source, imply no endorsement. Crops are made by `composite.py` in this folder
from the downloaded originals (kept out of the repo).

| Asset (repo) | Source | Credit | Recipe |
|---|---|---|---|
| `sun400.png` (orrery sun) | SDO AIA 304 Å "latest" 4096² frame, 2026-10-26 10:35 UT — https://sdo.gsfc.nasa.gov/assets/img/latest/latest_4096_0304.jpg | Courtesy of NASA/SDO and the AIA, EVE, and HMI science teams | caption stamp masked (black corner); limb radius fitted on equatorial rows; square crop with the disc at 0.77 of the half-width (as `sun.png`); re-toned from SDO's red palette toward the old orange (G = 0.7·G + 0.46·R; R gamma 0.66 ×1.25, matching the old asset's mean disc luminance); 400² |
| `sunEclipse160.png` (eclipse-sim sun) | same frame | same | disc-only circular cutout at 0.975 of the equatorial radius (the 304 Å polar limb sits inside it), 160² |
| `totalEclipse450.png` | NASA 2017 total solar eclipse, Madras OR, NHQ201708210100 (`~large.jpg`, 1919×1522) — https://images.nasa.gov/details/NHQ201708210100 | NASA/Aubrey Gemignani | centred on the dark disc (r = 310 px); framed so the disc is 68/316 of the width as in the old asset (black padding, last 15 % of the photo's field faded) so `SUN_RADIUS_FRACTION` stays 0.215 and the disc draws at the Moon's size; brightness ×0.75; corona tinted to a toned-down version of the old blue (R:G:B 0.81:1.01:1.44, easing to white above L 90); 450² |
| `saturn300.png` | Voyager 2, 4 Aug 1981, PIA01364 (TIFF 1200×1500) — https://science.nasa.gov/photojournal/saturn-taken-from-voyager-2 | NASA/JPL | `candidates2.py`: largest connected blob (drops the moons and mosaic seams), rotated 58.5° so the ring axis is level (principal axis of the ring mask), ring span 292 px, luminance-keyed alpha (0 below 10, 1 above 30), outermost 2 px desaturated (Voyager filter fringes). Replaced Cassini PIA21046 (2016, 300×176) on 2026-10-27: its globe had a third in night; the Voyager approach view is fully lit |
| `jupiter300.png` | Cassini, PIA02873 ("high-resolution globe of Jupiter") | NASA/JPL/University of Arizona | disc cutout Ø136, radius ×0.99, saturation ×1.35 |
| `mars300.png` | Viking Orbiter global colour view, PIA00407 | NASA/JPL/USGS | disc cutout Ø100 |
| `earth300.png` | Suomi NPP "Blue Marble 2012", PIA18033 | NASA/NOAA/GSFC/Suomi NPP/VIIRS/Norman Kuring | disc cutout Ø114 |
| `venus300.png` | Pioneer Venus Orbiter, 5 Feb 1979, ultraviolet (1244×1280) — https://science.nasa.gov/image-detail/amf-82ef2ba2-6cb9-4ce7-853a-4494d8fa7974/ | NASA | `candidates2.py`: circle fitted on a smoothed copy (noisy scan background), disc cutout Ø96 at 0.985 r; retoned — luminance of the UV frame with its contrast eased to 0.6, tinted to the old iOS icon's cream (252,249,215) at the old icon's mean luminance. Replaced Mariner 10 PIA23791 on 2026-10-27: its right limb was a terminator; the Pioneer frame is a full disc |
| `mercury300.png` | MESSENGER global mosaic PIA15063 (equirectangular 6132×3066) | NASA/Johns Hopkins University APL/Carnegie Institution of Washington | orthographic render, sub-observer lon 20°, mild limb darkening, brightness ×2.4; Ø80 |
| `moon768.png` | iOS Observatory asset `moon384@2x.png` (same photograph as `moon300.png`) | (as today) | copy |
| `planets/moon150.png` | iOS Observatory asset `moon75@2x.png` (orrery Moon dot) | (as today) | copy; drawn at the 75×34 authoring size |

Rejected full-disc alternatives (2026-10-27): Hubble UV Venus PIA01544 (~300 px), Galileo PIA00072 (high-pass, blue tint), Magellan radar globes (surface, not clouds), Hubble Saturn portraits (NASA/ESA credit). Voyager 1 PIA02225 (1980) was the runner-up for Saturn; the contact sheet is `contact-fulldisc.png`, candidate masters in `candidates/`.

Icon disc diameters are 4× the old 75×34 icons' (Jupiter 34, Earth 28.5, Mars 25,
Venus 24, Mercury 20 px at s = 1; Saturn's rings 73 px wide). Masters live in
`src/shared/assets/` (`planets/` for the icons); `planet-hands.ts` draws every
icon at natural ÷ 4 (Moon dot ÷ 2), so a master's box may differ from 300×136.
