#!/usr/bin/env bash
# Pins the image Verdynt/OS is built on (node:22-slim) to one exact version, by its digest (2026.11.11, review INF-9 and
# INF-14). A tag like node:22-slim moves whenever Docker publishes a new build; a digest never does, so every build
# uses exactly the base that was checked. Run from the unzipped folder in Cloud Shell (it has docker):
#   bash scripts/pin-base-image.sh           pins the Dockerfile to today's node:22-slim and prints the line
#   bash scripts/pin-base-image.sh --check   says whether the Dockerfile is pinned (deploy.sh runs this)
# To update the base later (a Node security release): run it again, deploy to staging, check, promote. Send the
# printed FROM line to whoever keeps the code, so the next release zip carries the same pin.
set -euo pipefail
cd "$(dirname "$0")/.."
TAG=node:22-slim
FROM_LINE="$(grep -m1 '^FROM ' Dockerfile)"
if [ "${1:-}" = --check ]; then
  case "$FROM_LINE" in *"@sha256:"*) echo "The base image is pinned: $FROM_LINE"; exit 0 ;; esac
  echo "The base image is not pinned ($FROM_LINE). Pin it with: bash scripts/pin-base-image.sh"; exit 1
fi
DIGEST="$(docker buildx imagetools inspect "$TAG" | awk '/^Digest:/{print $2; exit}')"
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "Could not read the digest of $TAG."; exit 1; }
sed -i "0,/^FROM .*/s##FROM $TAG@$DIGEST#" Dockerfile
echo "Pinned: $(grep -m1 '^FROM ' Dockerfile)"
