#!/bin/bash
set -e
cd /Users/spucci/chronometer-web
X="$1"
ESBUILD="npx --yes esbuild"
DIST="$X"
SRC="src"
NEW_VERSION="scratch-$(date +%H%M%S)"
LOADER_FLAGS="--loader:.xml=text --loader:.png=dataurl --loader:.jpg=dataurl --loader:.bin=dataurl"
COMMON_FLAGS="--format=iife --target=es2020 --log-level=warning"
# Function definitions only (inject_partials, inject_partials_terra, get_title, get_help_file, emit_loader_block, splice_loader)
source "/private/tmp/claude-501/-Users-spucci-chronometer-web/f9d251b6-219b-4549-849c-6db754369666/scratchpad/build-helpers.sh"
$ESBUILD "$SRC/engine-entry.ts" --bundle $LOADER_FLAGS $COMMON_FLAGS --define:__BUILD_VERSION__="\"$NEW_VERSION\"" --outfile="$DIST/chronometer-engine.js"
for face in gaia terra; do
  $ESBUILD "$SRC/faces/generated/face-$face.ts" --bundle $LOADER_FLAGS $COMMON_FLAGS --outfile="$DIST/face-$face.js"
  TITLE=$(get_title "$face"); ICON="thumb-${face}.png"; HELP_FILE=$(get_help_file "$face")
  sed -e "s|{{TITLE}}|$TITLE|g" -e "s|{{ICON}}|$ICON|g" "$SRC/face-template.html" | inject_partials_terra "$HELP_FILE" > "$DIST/$face.html"
  emit_loader_block "chronometer" "face-$face.js" "chronometer-engine.js" > "$DIST/.loader.html"
  splice_loader "$DIST/$face.html" "$DIST/.loader.html"; rm -f "$DIST/.loader.html"
done
$ESBUILD "$SRC/observatory/observatory-entry.ts" --bundle $LOADER_FLAGS $COMMON_FLAGS --define:__BUILD_VERSION__="\"$NEW_VERSION\"" --outfile="$DIST/observatory-engine.js"
inject_partials "$SRC/help/observatory.html" "Observatory" < "$SRC/observatory/observatory.html" > "$DIST/observatory.html"
emit_loader_block "observatory" "observatory-engine.js" > "$DIST/.loader.html"
splice_loader "$DIST/observatory.html" "$DIST/.loader.html"; rm -f "$DIST/.loader.html"
$ESBUILD "$SRC/inspector/inspector-entry.ts" --bundle $LOADER_FLAGS $COMMON_FLAGS --outfile="$DIST/inspector-engine.js"
inject_partials "$SRC/help/inspector.html" "Inspector" < "$SRC/inspector/inspector.html" > "$DIST/inspector.html"
emit_loader_block "inspector" "inspector-engine.js" > "$DIST/.loader.html"
splice_loader "$DIST/inspector.html" "$DIST/.loader.html"; rm -f "$DIST/.loader.html"
cp "$SRC/cities-data.js" "$DIST/cities-data.js"
node scripts/make-cities-gz.mjs "$DIST" >/dev/null
cp "$SRC"/faces/thumb-*.png "$DIST/" 2>/dev/null || true
echo "built $NEW_VERSION"; ls -la "$DIST" | head -20
# --- index + pick pages (for the adoption / nav-link checks) ---
$ESBUILD "$SRC/index-page.ts" --bundle $COMMON_FLAGS --outfile="$DIST/index-page.js"
$ESBUILD "$SRC/pick-page.ts" --bundle $LOADER_FLAGS $COMMON_FLAGS --outfile="$DIST/pick-page.js"
inject_partials "$SRC/help/general.html" "Chronometer" < "$SRC/index.html" > "$DIST/index.html"
cp "$SRC/pick.html" "$DIST/pick.html"
echo "built index+pick"
