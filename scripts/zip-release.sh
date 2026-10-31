#!/usr/bin/env bash
# Makes the release zip that Dan unzips in Cloud Shell: bash scripts/zip-release.sh
# It stamps the build (scripts/stamp-build.js), then zips what git tracks plus src/release/build.json, and leaves out
# the tests (test/) and any package or archive file. deploy.sh and promote.sh need nothing from test/.
# Writes ../summitops-<version>.zip next to this folder and prints its size.
# Options: --no-stamp keeps the build.json that is already there. ZIP_OUT_DIR=<folder> writes the zip there instead.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" != "--no-stamp" ]; then node scripts/stamp-build.js; fi
if [ ! -f src/release/build.json ]; then echo "src/release/build.json is missing. Run without --no-stamp."; exit 1; fi

VERSION="$(node -p "require('./package.json').version")"
OUT="$(cd "${ZIP_OUT_DIR:-..}" && pwd)/summitops-${VERSION}.zip"
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT

# What goes in: tracked files that still exist, minus test/ and packages or archives, plus the build stamp.
git ls-files | grep -v '^test/' | grep -viE '\.(whl|zip|tar\.gz|tgz)$' | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done > "$LIST"
echo "src/release/build.json" >> "$LIST"

rm -f "$OUT"
zip -q -X "$OUT" -@ < "$LIST"
COUNT="$(wc -l < "$LIST" | tr -d ' ')"
SIZE="$(du -h "$OUT" | cut -f1)"
echo "Wrote $OUT: $COUNT files, $SIZE"
