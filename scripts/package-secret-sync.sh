#!/usr/bin/env bash
#
# Build the deployment zip for demi-secret-sync-<env>.
#
# The zip mirrors the REPO LAYOUT rather than flattening src/secret-sync to its root: the sync
# reuses src/utils/logger.js, and a flattened layout would break that require. So host.json and
# package.json are taken from src/secret-sync and placed at the zip root — package.json's `main`
# points back down at src/secret-sync/index.js — and the sources keep their paths.
#
# Dependencies come from src/secret-sync/package.json, installed into the staging directory. The
# API's node_modules is not reused: this app needs five packages, the API's tree is an order of
# magnitude bigger, and Flex charges extract time per file.
#
# Usage: scripts/package-secret-sync.sh <repo-root> <output.zip>
set -euo pipefail

REPO_ROOT="$(cd "${1:?repo root required}" && pwd)"
OUTPUT="${2:?output zip path required}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/src"
cp "$REPO_ROOT/src/secret-sync/host.json" "$STAGE/host.json"
cp "$REPO_ROOT/src/secret-sync/package.json" "$STAGE/package.json"
cp -R "$REPO_ROOT/src/secret-sync" "$STAGE/src/secret-sync"
# The shared logger and the config it reads its level from. Nothing else of src/ is required.
cp -R "$REPO_ROOT/src/utils" "$STAGE/src/utils"
cp "$REPO_ROOT/src/config.js" "$STAGE/src/config.js"

# npm rather than yarn: this package has no lockfile of its own and is not a yarn workspace of the
# API. `--omit=dev` because there are no dev dependencies to begin with and the flag keeps it so.
npm install --omit=dev --prefix "$STAGE" --no-audit --no-fund --loglevel=error

rm -f "$OUTPUT"
(cd "$STAGE" && zip -qr "$OUTPUT" .)
unzip -l "$OUTPUT" | tail -n 1
