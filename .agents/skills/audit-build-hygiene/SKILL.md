---
name: audit-build-hygiene
description: >
  Review the build process (build.sh and all scripts/) for two violations:
  (1) use of category-4 reference files in the build, and (2) conditional-on-existence
  logic that skips build steps when output files already exist.
---

# Audit Build Hygiene

This skill reviews the entire build process for two classes of violations that
compromise build hermeticity and reproducibility.

## When to Use

Run this skill when:
- Build scripts have been modified
- New scripts have been added to `scripts/`
- Before a release to verify build integrity
- After modifying `file-categories.json` to verify no category-4 files are used

## Violation 1: Use of Category-4 Files in the Build

Category-4 files (the `.XXX-ref/` reference directories) are for developer/agent
reference only. They must NEVER be used as inputs to the build process or to any
script whose output feeds into the build.

### How to Check

1. **Scan build scripts for references to reference directories**:
   ```bash
   grep -rn '\.chronometer-ref\|\.esastro-ref\|\.esgl-ref\|\.eslocation-ref\|\.estime-ref\|\.observatory-ref\|\.observatory-opengl-ref' \
       build.sh scripts/
   ```

2. **Scan TypeScript source files for imports from reference dirs**:
   ```bash
   grep -rn '\.chronometer-ref\|\.esastro-ref\|\.esgl-ref\|\.eslocation-ref\|\.estime-ref\|\.observatory-ref\|\.observatory-opengl-ref' \
       src/ --include='*.ts' --include='*.js'
   ```

3. **Classify each hit**:
   - **Violation**: A build script or source file imports/reads from a category-4 directory
   - **Acceptable**: A diagnostic/comparison script (like `compare-altitude-tables.ts`) references
     category-4 files — these are not part of the build pipeline
   - **Acceptable**: Comments or documentation mentioning reference directories

### Known Exceptions

- Everything under `scripts/historical/` is retired tooling that the build never invokes
  (see `docs/build-system.md`). Hits there are acceptable; the two below are the known ones.
- `scripts/historical/compare-altitude-tables.ts` reads from `.esastro-ref/` for diagnostic
  comparison. This is acceptable because it is not part of the build pipeline.
- `scripts/clone-refs.sh` clones reference repos. This is a setup script, not a build script.
- `scripts/historical/convert-tables.mjs` downloads from GitHub URLs (not from local ref dirs).
  The URLs happen to point to the same repos, but no local ref directory is used. This is
  acceptable.

## Violation 2: Conditional-on-Existence Logic

The build must never behave differently based on whether an *output* file already exists.
This rule prevents stale outputs from being silently reused and ensures reproducibility.

### Prohibited Patterns

1. **Skip-if-output-exists**:
   ```bash
   # BAD: Skips generation if output already exists
   if [ ! -f "output.js" ]; then
     generate_output
   fi
   ```

2. **Use-stale-if-input-missing**:
   ```bash
   # BAD: Uses stale output when input is missing
   if [ -f "input.txt" ]; then
     build output.js from input.txt
   else
     echo "Using existing output.js"
   fi
   ```

3. **Silent skip on glob miss**:
   ```bash
   # BAD: Silently skips if file doesn't exist
   [ -f "$f" ] && cp "$f" dest/
   ```

### Acceptable Patterns

1. **Guard-and-fail**: Check that a required *input* exists, fail if not:
   ```bash
   # GOOD: Validates input exists, fails fast
   if [ ! -f "required-input.txt" ]; then
     echo "ERROR: missing required-input.txt" >&2
     exit 1
   fi
   ```

2. **mkdir -p**: Creating output directories is fine.

3. **Conditional feature inclusion** based on metadata (not file existence):
   ```bash
   # GOOD: Decision based on XML metadata, not file existence
   if [ -n "$WORLD_TIME_RING" ]; then
     INJECTOR=inject_partials_terra
   fi
   ```

### How to Check

1. **Scan for file-existence conditionals in build scripts**:
   ```bash
   grep -n '\[ -f \|\[ ! -f \|test -f\|\[ -e \|\[ ! -e ' build.sh scripts/*.sh scripts/*.js scripts/*.mjs
   ```

2. **Scan for fs.existsSync in Node scripts used by the build**:
   ```bash
   grep -n 'existsSync\|fs\.exists' scripts/generate-face-modules.js scripts/build-cities.js
   ```

3. **For each hit, classify as acceptable or problematic** using the patterns above.

4. **Check the help images copy** in `build.sh`:
   ```bash
   grep -n 'if \[ -d.*help/images' build.sh
   ```
   This checks for a directory (input), which is acceptable — but consider whether the
   directory should always be required to exist.

## Output

Create a report artifact with:
- A table of all file-existence checks found, with file, line number, pattern, and classification
- Summary of violations found (if any)
- Recommended fixes for each violation

## Related Documentation

- [Development Rules §14](docs/development-rules.md) — The build hygiene rule
- [Build System](docs/build-system.md) — Build architecture and file categories
- [file-categories.json](file-categories.json) — Category definitions
