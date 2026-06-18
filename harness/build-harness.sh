#!/bin/bash
# Build the layout harness (Observatory layout iteration 3 tuning).
#
# Bundles the *committed* computeLayout from src/observatory/layout.ts into an
# ES module the harness page imports directly, so the harness reproduces today's
# layout logic exactly (no reimplementation). layout.ts has no runtime imports
# and no DOM usage, so this is a trivial single-file bundle.
#
# Usage: ./harness/build-harness.sh   (then serve harness/ and open layout-harness.html)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

npx --yes esbuild "$ROOT/src/observatory/layout.ts" \
  --bundle --format=esm --target=es2020 \
  --outfile="$DIR/layout.mjs"

# date-view.ts is rendered for real in the harness (its ink does not fill its
# box, unlike the outline-only elements), so bundle it too.
npx --yes esbuild "$ROOT/src/observatory/date-view.ts" \
  --bundle --format=esm --target=es2020 \
  --outfile="$DIR/date-view.mjs"

echo "  ✓ harness/layout.mjs + date-view.mjs built from src/observatory/"
