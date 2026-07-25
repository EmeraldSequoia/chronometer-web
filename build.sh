#!/bin/bash
# Build script for Chronometer distribution.
# Produces:
#   dist/chronometer-engine.js   — shared rendering engine
#   dist/face-{name}.js          — per-face XML + image data
#   dist/{name}.html             — per-face viewer
#   dist/all.html                — all faces in a grid
#   dist/index.html              — face selector with thumbnails
#   dist/index-page.js           — index page location dialog logic
#   dist/inspector-engine.js     — Inspector app engine (astronomy only, no watch code)
#   dist/inspector.html          — Inspector app page
#   dist/observatory-engine.js   — Observatory app engine (astronomy, no watch code)
#   dist/observatory.html        — Observatory app page
set -e

# Version handling
if [ -f "version.txt" ]; then
  CURRENT_VERSION=$(awk '/^[^# \t]/ {print; exit}' version.txt)
  MAJOR_MINOR=$(echo "$CURRENT_VERSION" | cut -d. -f1,2)
  BUILD_NUM=$(echo "$CURRENT_VERSION" | cut -d. -f3)
  BUILD_NUM=$((BUILD_NUM + 1))
  NEW_VERSION="${MAJOR_MINOR}.${BUILD_NUM}"
else
  echo "ERROR: version.txt is missing. It is required for the build." >&2
  exit 1
fi

# Update version in place, preserving comments and blank lines
awk -v new_ver="$NEW_VERSION" '/^#/ || /^[ \t]*$/ {print} /^[^# \t]/ {print new_ver; exit}' version.txt > version.tmp && mv version.tmp version.txt

ESBUILD="npx --yes esbuild"
DIST="dist"
SRC="src"
LOADER_FLAGS="--loader:.xml=text --loader:.png=dataurl --loader:.jpg=dataurl --loader:.bin=dataurl"
COMMON_FLAGS="--format=iife --target=es2020"

mkdir -p "$DIST"

echo "=== Checking required source files ==="
# These files are tracked by git and must be present.
# If missing, restore with: git checkout -- <file>
for required_file in \
    "$SRC/cities-data.js" \
    "$SRC/observatory/data/altitude-table.bin"; do
  if [ ! -f "$required_file" ]; then
    echo "ERROR: Required file missing: $required_file" >&2
    echo "This file should be present from git clone." >&2
    echo "Restore with: git checkout -- $required_file" >&2
    exit 1
  fi
done
echo "  ✓ All required source files present"

echo "=== Generating face data modules ==="
node scripts/generate-face-modules.js

FACES=($(grep -v '^#' faces.txt | grep -v '^$'))

echo "=== Checking URL abbreviation uniqueness ==="
ABBREVS=$(grep -roh "urlAbbrev='[^']*'" "$SRC"/watch/assets/*//*.xml | sed "s/urlAbbrev='//;s/'//" | sort)
DUPES=$(echo "$ABBREVS" | uniq -d)
if [ -n "$DUPES" ]; then
  echo "ERROR: Duplicate urlAbbrev values found: $DUPES" >&2
  exit 1
fi
echo "  ✓ All urlAbbrev values are unique ($(echo "$ABBREVS" | wc -l | tr -d ' ') faces)"

echo "=== Type-checking with tsc ==="
npx tsc --noEmit
echo "  ✓ No type errors"

echo "=== Building engine ==="
$ESBUILD "$SRC/engine-entry.ts" --bundle $LOADER_FLAGS $COMMON_FLAGS \
  --define:__BUILD_VERSION__="\"$NEW_VERSION\"" \
  --outfile="$DIST/chronometer-engine.js"

echo "=== Building face data modules ==="
for face in "${FACES[@]}"; do
  echo "  → face-$face.js"
  $ESBUILD "$SRC/faces/generated/face-$face.ts" --bundle $LOADER_FLAGS $COMMON_FLAGS \
    --outfile="$DIST/face-$face.js"
done

echo "=== Building index page script ==="
$ESBUILD "$SRC/index-page.ts" --bundle $COMMON_FLAGS \
  --outfile="$DIST/index-page.js"
echo "  → index-page.js"

echo "=== Building pick page script ==="
$ESBUILD "$SRC/pick-page.ts" --bundle $LOADER_FLAGS $COMMON_FLAGS \
  --outfile="$DIST/pick-page.js"
echo "  → pick-page.js"

echo "=== Building Inspector engine ==="
$ESBUILD "$SRC/inspector/inspector-entry.ts" --bundle $LOADER_FLAGS $COMMON_FLAGS \
  --outfile="$DIST/inspector-engine.js"
echo "  → inspector-engine.js"

echo "=== Building Observatory engine ==="
$ESBUILD "$SRC/observatory/observatory-entry.ts" --bundle $LOADER_FLAGS $COMMON_FLAGS \
  --outfile="$DIST/observatory-engine.js"
echo "  → observatory-engine.js"

echo "=== Generating HTML files ==="

# Helper: inject partial files into a template.
# Reads from stdin, writes to stdout.
# Replaces lines containing {{LOCATION_CSS}}, {{LOCATION_DIALOG}},
# {{TIME_CSS}}, {{TIME_CONTROLLER}}, {{OTHER_APPS}}, and terra city dialog
# placeholders.
inject_partials() {
    local HELP_FILE="${1:-}"
    local APP_NAME="${2:-Chronometer}"
    awk -v P="$SRC/partials" -v H="$HELP_FILE" -v VERSION="$NEW_VERSION" -v APP="$APP_NAME" '
    /\{\{ *LOCATION_CSS *\}\}/ { 
        s=$0; sub(/\{\{ *LOCATION_CSS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/location-dialog.css")) > 0) print line; close(P"/location-dialog.css");
        s=$0; sub(/.*\{\{ *LOCATION_CSS *\}\}/, "", s); print s; next
    }
    /\{\{ *FACE_CARDS *\}\}/ { 
        s=$0; sub(/\{\{ *FACE_CARDS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < "src/faces/generated/face-cards.html") > 0) print line; close("src/faces/generated/face-cards.html");
        s=$0; sub(/.*\{\{ *FACE_CARDS *\}\}/, "", s); print s; next
    }
    /\{\{ *INDEX_ORDER *\}\}/ { 
        s=$0; sub(/\{\{ *INDEX_ORDER *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < "src/faces/generated/index-order.json") > 0) printf "%s", line; close("src/faces/generated/index-order.json");
        s=$0; sub(/.*\{\{ *INDEX_ORDER *\}\}/, "", s); print s; next
    }
    /\{\{ *LOCATION_DIALOG *\}\}/ { 
        s=$0; sub(/\{\{ *LOCATION_DIALOG *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/location-dialog.html")) > 0) print line; close(P"/location-dialog.html");
        s=$0; sub(/.*\{\{ *LOCATION_DIALOG *\}\}/, "", s); print s; next
    }
    /\{\{ *OTHER_APPS *\}\}/ {
        s=$0; sub(/\{\{ *OTHER_APPS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/other-apps.html")) > 0) print line; close(P"/other-apps.html");
        s=$0; sub(/.*\{\{ *OTHER_APPS *\}\}/, "", s); print s; next
    }
    /\{\{ *TIME_CSS *\}\}/ {
        s=$0; sub(/\{\{ *TIME_CSS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/time-controller.css")) > 0) print line; close(P"/time-controller.css");
        s=$0; sub(/.*\{\{ *TIME_CSS *\}\}/, "", s); print s; next
    }
    /\{\{ *TIME_CONTROLLER *\}\}/ { 
        s=$0; sub(/\{\{ *TIME_CONTROLLER *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/time-controller.html")) > 0) print line; close(P"/time-controller.html");
        s=$0; sub(/.*\{\{ *TIME_CONTROLLER *\}\}/, "", s); print s; next
    }
    /\{\{ *TERRA_CITY_CSS *\}\}/ { next }
    /\{\{ *TERRA_CITY_DIALOG *\}\}/ { next }
    /\{\{ *HELP_CONTENT *\}\}/ { 
        s=$0; sub(/\{\{ *HELP_CONTENT *\}\}.*/, "", s); printf "%s", s;
        if (H != "") { while ((getline line < H) > 0) print line; close(H) };
        s=$0; sub(/.*\{\{ *HELP_CONTENT *\}\}/, "", s); print s; next
    }
    /\{\{ *PRIVACY_CONTENT *\}\}/ { 
        s=$0; sub(/\{\{ *PRIVACY_CONTENT *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/privacy-content.html")) > 0) { gsub(/\{\{ *APP_NAME *\}\}/, APP, line); print line }; close(P"/privacy-content.html");
        s=$0; sub(/.*\{\{ *PRIVACY_CONTENT *\}\}/, "", s); print s; next
    }
    /\{\{ *SUPPORT_CONTENT *\}\}/ { 
        s=$0; sub(/\{\{ *SUPPORT_CONTENT *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/support-content.html")) > 0) { gsub(/\{\{ *APP_NAME *\}\}/, APP, line); print line }; close(P"/support-content.html");
        s=$0; sub(/.*\{\{ *SUPPORT_CONTENT *\}\}/, "", s); print s; next
    }
    /\{\{ *DISCLAIMER_CONTENT *\}\}/ { 
        s=$0; sub(/\{\{ *DISCLAIMER_CONTENT *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/disclaimer-content.html")) > 0) { gsub(/\{\{ *APP_NAME *\}\}/, APP, line); print line }; close(P"/disclaimer-content.html");
        s=$0; sub(/.*\{\{ *DISCLAIMER_CONTENT *\}\}/, "", s); print s; next
    }
    /\{\{ *HELP_SUBVIEW_CSS *\}\}/ { 
        s=$0; sub(/\{\{ *HELP_SUBVIEW_CSS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/help-subview.css")) > 0) print line; close(P"/help-subview.css");
        s=$0; sub(/.*\{\{ *HELP_SUBVIEW_CSS *\}\}/, "", s); print s; next
    }
    /\{\{ *VERSION *\}\}/ { 
        gsub(/\{\{ *VERSION *\}\}/, VERSION); print; next
    }
    { print }
    '
}

# Same as inject_partials but includes terra city dialog content.
inject_partials_terra() {
    local HELP_FILE="${1:-}"
    local APP_NAME="${2:-Chronometer}"
    awk -v P="$SRC/partials" -v H="$HELP_FILE" -v VERSION="$NEW_VERSION" -v APP="$APP_NAME" '
    /\{\{ *LOCATION_CSS *\}\}/ { 
        s=$0; sub(/\{\{ *LOCATION_CSS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/location-dialog.css")) > 0) print line; close(P"/location-dialog.css");
        s=$0; sub(/.*\{\{ *LOCATION_CSS *\}\}/, "", s); print s; next
    }
    /\{\{ *LOCATION_DIALOG *\}\}/ { 
        s=$0; sub(/\{\{ *LOCATION_DIALOG *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/location-dialog.html")) > 0) print line; close(P"/location-dialog.html");
        s=$0; sub(/.*\{\{ *LOCATION_DIALOG *\}\}/, "", s); print s; next
    }
    /\{\{ *OTHER_APPS *\}\}/ {
        s=$0; sub(/\{\{ *OTHER_APPS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/other-apps.html")) > 0) print line; close(P"/other-apps.html");
        s=$0; sub(/.*\{\{ *OTHER_APPS *\}\}/, "", s); print s; next
    }
    /\{\{ *TIME_CSS *\}\}/ {
        s=$0; sub(/\{\{ *TIME_CSS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/time-controller.css")) > 0) print line; close(P"/time-controller.css");
        s=$0; sub(/.*\{\{ *TIME_CSS *\}\}/, "", s); print s; next
    }
    /\{\{ *TIME_CONTROLLER *\}\}/ { 
        s=$0; sub(/\{\{ *TIME_CONTROLLER *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/time-controller.html")) > 0) print line; close(P"/time-controller.html");
        s=$0; sub(/.*\{\{ *TIME_CONTROLLER *\}\}/, "", s); print s; next
    }
    /\{\{ *TERRA_CITY_CSS *\}\}/ { 
        s=$0; sub(/\{\{ *TERRA_CITY_CSS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/terra-city-dialog.css")) > 0) print line; close(P"/terra-city-dialog.css");
        s=$0; sub(/.*\{\{ *TERRA_CITY_CSS *\}\}/, "", s); print s; next
    }
    /\{\{ *TERRA_CITY_DIALOG *\}\}/ { 
        s=$0; sub(/\{\{ *TERRA_CITY_DIALOG *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/terra-city-dialog.html")) > 0) print line; close(P"/terra-city-dialog.html");
        s=$0; sub(/.*\{\{ *TERRA_CITY_DIALOG *\}\}/, "", s); print s; next
    }
    /\{\{ *HELP_CONTENT *\}\}/ { 
        s=$0; sub(/\{\{ *HELP_CONTENT *\}\}.*/, "", s); printf "%s", s;
        if (H != "") { while ((getline line < H) > 0) print line; close(H) };
        s=$0; sub(/.*\{\{ *HELP_CONTENT *\}\}/, "", s); print s; next
    }
    /\{\{ *PRIVACY_CONTENT *\}\}/ { 
        s=$0; sub(/\{\{ *PRIVACY_CONTENT *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/privacy-content.html")) > 0) { gsub(/\{\{ *APP_NAME *\}\}/, APP, line); print line }; close(P"/privacy-content.html");
        s=$0; sub(/.*\{\{ *PRIVACY_CONTENT *\}\}/, "", s); print s; next
    }
    /\{\{ *SUPPORT_CONTENT *\}\}/ { 
        s=$0; sub(/\{\{ *SUPPORT_CONTENT *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/support-content.html")) > 0) { gsub(/\{\{ *APP_NAME *\}\}/, APP, line); print line }; close(P"/support-content.html");
        s=$0; sub(/.*\{\{ *SUPPORT_CONTENT *\}\}/, "", s); print s; next
    }
    /\{\{ *DISCLAIMER_CONTENT *\}\}/ { 
        s=$0; sub(/\{\{ *DISCLAIMER_CONTENT *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/disclaimer-content.html")) > 0) { gsub(/\{\{ *APP_NAME *\}\}/, APP, line); print line }; close(P"/disclaimer-content.html");
        s=$0; sub(/.*\{\{ *DISCLAIMER_CONTENT *\}\}/, "", s); print s; next
    }
    /\{\{ *HELP_SUBVIEW_CSS *\}\}/ { 
        s=$0; sub(/\{\{ *HELP_SUBVIEW_CSS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/help-subview.css")) > 0) print line; close(P"/help-subview.css");
        s=$0; sub(/.*\{\{ *HELP_SUBVIEW_CSS *\}\}/, "", s); print s; next
    }
    /\{\{ *VERSION *\}\}/ { 
        gsub(/\{\{ *VERSION *\}\}/, VERSION); print; next
    }
    { print }
    '
}

# Helper to get display title for each face
get_title() {
  node -e "const fs = require('fs'); console.log(JSON.parse(fs.readFileSync('./src/faces/generated/metadata.json', 'utf8'))['$1'].displayName)"
}

# Helper to get help file path for each face
get_help_file() {
  local f="$SRC/help/$1.html"
  if [ -f "$f" ]; then
    echo "$f"
  fi
}

# Emit the per-page bundle manifest + the shared load-progress bootstrap
# partial (planning/2026-07-19-load-progress-bar.md). Prints to stdout.
#   Args: APP_LABEL  BUNDLE_FILE...   (bundle files in EXECUTION order:
#   faces first, engine last). Sizes are UNCOMPRESSED on-disk bytes — the
#   fetch-progress denominator must match the decompressed ReadableStream.
emit_loader_block() {
  local app="$1"; shift
  local files_json="" f bytes first=1
  for f in "$@"; do
    bytes=$(wc -c < "$DIST/$f" | tr -d ' ')
    if [ $first -eq 1 ]; then first=0; else files_json="${files_json},"; fi
    # ?v= cache-buster: ties each HTML to its exact matching bundles, so a
    # deploy can never pair new HTML with a stale cached engine (the cause of
    # the 2026-07-24 lingering-bar bug). The file:// path strips the query.
    files_json="${files_json}{\"src\":\"$f?v=$NEW_VERSION\",\"bytes\":$bytes}"
  done
  printf '<script>window.__BUNDLES__={"app":"%s","files":[%s]};</script>\n' "$app" "$files_json"
  cat "$SRC/partials/loader-bootstrap.html"
}

# Replace the (first) line containing the <!--LOADER--> marker in file $1 with
# the contents of block file $2. Leaves the file untouched if no marker.
splice_loader() {
  local target="$1" block="$2"
  awk -v B="$block" '
    index($0, "<!--LOADER-->") { while ((getline line < B) > 0) print line; close(B); next }
    { print }
  ' "$target" > "$target.tmp" && mv "$target.tmp" "$target"
}

# Per-face HTML. The <!--LOADER--> marker (in face-template.html) is replaced
# post-inject with the bundle manifest + load-progress bootstrap. Manifest order
# is EXECUTION order: the face module first (it pushes to window.ChronometerFaces),
# the engine last (its main() runs on execute and reads that array).
for face in "${FACES[@]}"; do
  TITLE=$(get_title "$face")
  ICON="thumb-${face}.png"
  # Use city-dialog partial injection for faces with city customization
  WORLD_TIME_RING=$(node -e "const fs = require('fs'); console.log(JSON.parse(fs.readFileSync('./src/faces/generated/metadata.json', 'utf8'))['$face'].worldTimeRing)")
  WORLD_TIME_SUBDIALS=$(node -e "const fs = require('fs'); console.log(JSON.parse(fs.readFileSync('./src/faces/generated/metadata.json', 'utf8'))['$face'].worldTimeSubdials)")
  if [ -n "$WORLD_TIME_RING" ] || [ -n "$WORLD_TIME_SUBDIALS" ]; then
    INJECTOR=inject_partials_terra
  else
    INJECTOR=inject_partials
  fi
  HELP_FILE=$(get_help_file "$face")
  sed -e "s|{{TITLE}}|$TITLE|g" \
      -e "s|{{ICON}}|$ICON|g" \
      "$SRC/face-template.html" | $INJECTOR "$HELP_FILE" > "$DIST/$face.html"
  emit_loader_block "chronometer" "face-$face.js" "chronometer-engine.js" > "$DIST/.loader.html"
  splice_loader "$DIST/$face.html" "$DIST/.loader.html"
  rm -f "$DIST/.loader.html"
  echo "  → $face.html"
done

# all.html / selected.html — loads all faces. Bundle list is EXECUTION order:
# every face module first, the engine last (see per-face note above).
ALL_BUNDLES=()
for face in "${FACES[@]}"; do ALL_BUNDLES+=("face-$face.js"); done
ALL_BUNDLES+=("chronometer-engine.js")

# Generate combined help file for multi-face pages
COMBINED_HELP="$DIST/.combined-help.html"
: > "$COMBINED_HELP"
for face in "${FACES[@]}"; do
  HELP_FILE=$(get_help_file "$face")
  if [ -n "$HELP_FILE" ]; then
    TITLE=$(get_title "$face")
    echo "<details class=\"face-help-section\" data-face=\"$face\"><summary>$TITLE</summary>" >> "$COMBINED_HELP"
    cat "$HELP_FILE" >> "$COMBINED_HELP"
    echo "</details>" >> "$COMBINED_HELP"
  fi
done

sed -e "s|{{TITLE}}|All Faces|g" \
    -e "s|{{ICON}}|thumb-all-faces.png|g" \
    "$SRC/face-template.html" | inject_partials "$COMBINED_HELP" > "$DIST/all.html"
emit_loader_block "chronometer" "${ALL_BUNDLES[@]}" > "$DIST/.loader.html"
splice_loader "$DIST/all.html" "$DIST/.loader.html"
rm -f "$DIST/.loader.html"
echo "  → all.html"

# selected.html — loads all faces; engine filters by picks param
sed -e "s|{{TITLE}}|Selected Faces|g" \
    -e "s|{{ICON}}|thumb-all-faces.png|g" \
    "$SRC/face-template.html" | inject_partials "$COMBINED_HELP" > "$DIST/selected.html"
emit_loader_block "chronometer" "${ALL_BUNDLES[@]}" > "$DIST/.loader.html"
splice_loader "$DIST/selected.html" "$DIST/.loader.html"
rm -f "$DIST/.loader.html"
echo "  → selected.html"

# index.html — process with partial injection (includes combined help)
inject_partials "$COMBINED_HELP" < "$SRC/index.html" > "$DIST/index.html"
echo "  → index.html"
rm -f "$COMBINED_HELP"

# pick.html — face picker page (simple copy, no partials needed)
cp "$SRC/pick.html" "$DIST/pick.html"
echo "  → pick.html"

# inspector.html — Inspector app page (with location dialog + help injection)
if [ ! -f "$SRC/help/inspector.html" ]; then
  echo "ERROR: missing $SRC/help/inspector.html" >&2
  exit 1
fi
inject_partials "$SRC/help/inspector.html" "Inspector" < "$SRC/inspector/inspector.html" > "$DIST/inspector.html"
emit_loader_block "inspector" "inspector-engine.js" > "$DIST/.loader.html"
splice_loader "$DIST/inspector.html" "$DIST/.loader.html"
rm -f "$DIST/.loader.html"
echo "  → inspector.html"

# observatory.html — Observatory app page (with location dialog + help injection)
if [ ! -f "$SRC/help/observatory.html" ]; then
  echo "ERROR: missing $SRC/help/observatory.html" >&2
  exit 1
fi
inject_partials "$SRC/help/observatory.html" "Observatory" < "$SRC/observatory/observatory.html" > "$DIST/observatory.html"
emit_loader_block "observatory" "observatory-engine.js" > "$DIST/.loader.html"
splice_loader "$DIST/observatory.html" "$DIST/.loader.html"
rm -f "$DIST/.loader.html"
echo "  → observatory.html"

# help.html — general help topics page (simple copy)
sed "s|</body>|<div style=\"text-align:center; margin-top: 24px; color: #667; font-size: 11px;\">v$NEW_VERSION</div></body>|" "$SRC/help.html" > "$DIST/help.html"
echo "  → help.html"

# privacy.html — privacy policy
inject_partials < "$SRC/privacy.html" > "$DIST/privacy.html"
echo "  → privacy.html"

# support.html — support info
inject_partials < "$SRC/support.html" > "$DIST/support.html"
echo "  → support.html"

# disclaimer.html — legal disclaimer
inject_partials < "$SRC/disclaimer.html" > "$DIST/disclaimer.html"
echo "  → disclaimer.html"

# cities-data.js — city database for location picker.
# file:// loads the <script> form; http(s) fetches the compressed JSON blob.
cp "$SRC/cities-data.js" "$DIST/cities-data.js"
echo "  → cities-data.js ($(du -h "$DIST/cities-data.js" | cut -f1))"
node scripts/make-cities-gz.mjs "$DIST"

# Copy thumbnail images — fail if any expected thumbnail is missing
for face in "${FACES[@]}"; do
  thumb="$SRC/faces/thumb-$face.png"
  if [ ! -f "$thumb" ]; then
    echo "ERROR: Missing thumbnail: $thumb" >&2
    exit 1
  fi
  cp "$thumb" "$DIST/" && echo "  → $(basename "$thumb")"
done
# Copy all-faces thumbnail
if [ ! -f "$SRC/faces/thumb-all-faces.png" ]; then
  echo "ERROR: Missing $SRC/faces/thumb-all-faces.png" >&2
  exit 1
fi
cp "$SRC/faces/thumb-all-faces.png" "$DIST/" && echo "  → thumb-all-faces.png"
# Copy observatory thumbnail
if [ ! -f "$SRC/faces/thumb-observatory.png" ]; then
  echo "ERROR: Missing $SRC/faces/thumb-observatory.png" >&2
  exit 1
fi
cp "$SRC/faces/thumb-observatory.png" "$DIST/" && echo "  → thumb-observatory.png"
# Copy app icon
if [ ! -f "$SRC/apple-touch-icon.png" ]; then
  echo "ERROR: Missing $SRC/apple-touch-icon.png" >&2
  exit 1
fi
cp "$SRC/apple-touch-icon.png" "$DIST/" && echo "  → apple-touch-icon.png"
# Copy web-app manifest (iOS home-screen scope — keeps cross-app navigation
# inside the installed standalone container)
cp "$SRC/app.webmanifest" "$DIST/" && echo "  → app.webmanifest"

# Copy help images to dist
if [ -d "$SRC/help/images" ]; then
  echo ""
  echo "=== Copying help images ==="
  mkdir -p "$DIST/help/images"
  cp -r "$SRC"/help/images/* "$DIST/help/images/"
  echo "  → help/images/ ($(find "$DIST/help/images" -type f | wc -l | tr -d ' ') files)"
fi

echo ""
echo "=== Build complete ==="
ls -lh "$DIST"/*.js "$DIST"/*.html
