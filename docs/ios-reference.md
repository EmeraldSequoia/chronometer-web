# iOS/Android Reference Repositories

The Chronometer Web codebase was ported from the original Emerald Chronometer iOS app and its supporting libraries. The original source code is available in five GitHub repositories that can be cloned locally for reference.

> **Setup**: Run `scripts/clone-refs.sh` from the project root to clone all five reference repos. They are cloned into dot-prefixed directories that are listed in `.gitignore`.
>
> Two additional refs exist locally but are **not** in the script or on
> GitHub — `.esgl-ref/` and `.observatory-opengl-ref/` (branch `OpenGL`)
> come from Steve's own git server (`ssh://127.0.0.1/…`) and cannot be
> re-cloned from origin inside the VM.
>
> These directories are **read-only reference snapshots**. To *modify* the
> original repos (back-porting fixes), use the mutable clones in
> `ios-backports/` instead — see [ios-backports.md](ios-backports.md).

## Reference Repositories

| Local path | GitHub repo | Purpose |
|-----------|-------------|---------|
| `.chronometer-ref/` | [EmeraldSequoia/Chronometer](https://github.com/EmeraldSequoia/Chronometer) | Main Chronometer app — watch rendering, VM ops, UI |
| `.esastro-ref/` | [EmeraldSequoia/esastro](https://github.com/EmeraldSequoia/esastro) | Astronomy library — sun/moon/planet calculations |
| `.eslocation-ref/` | [EmeraldSequoia/eslocation](https://github.com/EmeraldSequoia/eslocation) | Location services — city database, timezone lookup |
| `.estime-ref/` | [EmeraldSequoia/estime](https://github.com/EmeraldSequoia/estime) | Time library — NTP, calendar, date arithmetic |
| `.observatory-ref/` | [EmeraldSequoia/Observatory](https://github.com/EmeraldSequoia/Observatory) | Observatory (Emerald Observatory) app — orrery, rings, planet assets |

## Key Files in `.chronometer-ref/`

### Watch Definitions (XML)

- **`Watches/Builtin-Android/<Face> I/<Face> I.xml`** — Android-variant XML definitions. These are the source files used for the web port (one file per face, no front/back split).
- **`Watches/Builtin/<Face>/`** — iOS-variant watch definitions (split into `front.xml`, `back.xml`, etc.). Used for reference but the Android variants are preferred for porting.

### Rendering & Drawing

| File | Purpose |
|------|---------|
| `Classes/ECGLPart.m` | OpenGL part rendering — hand positioning, offset-radius mode, shadow offsets |
| `Classes/ECGLWatch.m` | Top-level watch rendering orchestration |
| `Classes/ECGLWatchLoader.m` | Archive loading and part initialization |
| `Classes/ECWatchController.m` | Watch lifecycle, shadow offset calculations (lines 335–336) |

### Virtual Machine & Expressions

| File | Purpose |
|------|---------|
| `ECVirtualMachineOps.m` | Maps opcode names to function calls — the Rosetta Stone for tracing what XML expressions do |
| `Parser/` | Henry's lex/yacc parser for C expressions |

### Shadow Generation

| File | Purpose |
|------|---------|
| `scripts/makeOneShadow.pl` | Perl script that generates shadow bitmaps via ImageMagick — contains the sigma/opacity/offset formulas |

### Terminator

| File | Purpose |
|------|---------|
| `Classes/ECGLWatch.m` → `createTerminatorLeavesForRadius` | Expands a `<terminator>` XML element into individual leaf hands |
| `Classes/ECTerminatorLeaf.m` | Draws a single terminator leaf shape |

## Key Files in `.esastro-ref/`

| File | Purpose |
|------|---------|
| `src/ECAstronomyManager.cpp` | High-level astronomy manager (rise/set, twilight) |
| `src/ECAstronomy.mm` / `src/ECAstronomy.m` | Astronomy method implementations (sunRA, moonAge, planetPositions) |
| `Willmann-Bell/ESWillmannBellManager.cpp` | Manages WB calculation instances |
| `Willmann-Bell/ESWillmannBellSun.cpp` | Sun position (Bretagnon & Simon series) |
| `Willmann-Bell/ESWillmannBellMoon.cpp` | Moon position (Chapront-Touzé tables) |
| `Willmann-Bell/ESWillmannBellPlanets.cpp` | Planetary positions |

## Key Files in `.estime-ref/`

| File | Purpose |
|------|---------|
| `src/ESTime.cpp` | Core time functions, NTP integration |
| `src/ESCalendar.cpp` | Calendar calculations (Julian day, day-of-year, etc.) |
| `src/ESWatchTime.mm` | Watch time functions (`secondValue`, `hour12ValueAngle`, etc.) — called by VM opcodes |

## Key Files in `.eslocation-ref/`

| File | Purpose |
|------|---------|
| `src/ESLocation.cpp` | Device location management |
| `data/` | City database source files |

## Key Files in `.observatory-ref/`

### Assets

| File | Purpose |
|------|---------|
| `Resources/saturn.png`, `jupiter.png`, etc. | Planet icons for the orrery hands |
| `Resources/zodiac.png` | Zodiac constellation dial image |
| `Resources/sun.png` | Sun icon for orrery |
| `EO-Sidereal-constellation-names-0-at-top@2x.png` | Sidereal constellation name ring (Retina) |

### Source (Objective-C)

| File | Purpose |
|------|---------|
| `Classes/EORingView.mm` | Rise/set ring rendering — planet arcs, sun altitude ring, gradient |
| `Classes/EOClock.mm` | Main clock rendering — hands, subdials, ring configuration |
| `Classes/EOHandView.mm` | Hand drawing — clock hands, sun event hands, planet hands |

## Tracing an Expression to Its Implementation

When the XML uses an expression function like `sunRA()`, trace it through the iOS code in this order:

1. **`ECVirtualMachineOps.m`** — Maps opcode names to astronomy calls  
   *Example*: `sunRA` → `[mainAstro sunRA]`

2. **`ECAstronomy.m`** (in `.esastro-ref/`) — Contains the astronomy method implementations  
   *Example*: `sunRA` calls `sunRAandDecl().rightAscension`

3. **`ECWatchTime.m`** (in `.estime-ref/`) — Contains time-related methods  
   *Example*: `year366IndicatorFraction`, `minuteValue`

4. **WB modules** (`ESWillmannBell*.cpp` in `.esastro-ref/Willmann-Bell/`) — Low-level Willmann-Bell astronomical calculations

## Related Docs

- [Astronomy](astronomy.md) — How the astronomical routines are structured in the web codebase
- [Face Porting Guide](face-porting-guide.md) — Step-by-step procedure for porting a new face
- [Development Rules](development-rules.md) — Critical rules including "never simplify iOS algorithms"
