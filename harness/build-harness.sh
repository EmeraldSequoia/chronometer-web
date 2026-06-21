#!/bin/bash
# Build the layout harness (Observatory layout iteration 3).
#
# Bundles the *committed* iteration-3 layout logic into ES modules the harness
# page imports directly, so the harness reproduces the shipping layout exactly
# (no reimplementation — §9.6). anchor-layout.ts holds the per-anchor rules +
# the orchestrator and the base-template builder; esbuild inlines its imports
# (layout.ts, date-view.ts), so this single bundle carries the base templates
# too. date-view.ts is bundled separately because the harness renders real date
# text (its ink does not fill its box, unlike the outline elements).
#
# After any change to src/observatory/{anchor-layout,layout,date-view}.ts,
# rerun this and bump the ?v=N query on the imports in layout-harness.html.
#
# Usage: ./harness/build-harness.sh   (then serve harness/ and open layout-harness.html)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

npx --yes esbuild "$ROOT/src/observatory/anchor-layout.ts" \
  --bundle --format=esm --target=es2020 \
  --outfile="$DIR/anchor-layout.mjs"

npx --yes esbuild "$ROOT/src/observatory/date-view.ts" \
  --bundle --format=esm --target=es2020 \
  --outfile="$DIR/date-view.mjs"

echo "  ✓ harness/anchor-layout.mjs + date-view.mjs built from src/observatory/"
