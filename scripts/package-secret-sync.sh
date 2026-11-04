#!/usr/bin/env bash
# Zip for demi-<app>-<env> in repo layout (package.json `main` points at src/<app>), deps from npm.
# Usage: scripts/package-secret-sync.sh [--stage] <repo-root> <output.zip|empty-dir> [secret-sync|secret-rotator]
set -euo pipefail

STAGE_ONLY=false
if [[ "${1:-}" == --stage ]]; then STAGE_ONLY=true; shift; fi

REPO_ROOT="$(cd "${1:?repo root required}" && pwd)"
OUTPUT="${2:?output path required}"
APP="${3:-secret-sync}"

# Only src/<app> and these: src/config.js throws under these apps' settings, so nothing reaching it
# (src/utils/logger.js does) may be copied. The package-loads tests stage with --stage and check.
case "$APP" in
  secret-sync) SHARED=(src/utils/azure-credential.js) ;;
  secret-rotator) SHARED=(src/secret-sync/logger.js src/utils/azure-credential.js) ;;
  *) echo "unknown app '$APP': expected secret-sync or secret-rotator" >&2; exit 1 ;;
esac

stage() {
  local dir="$1" file
  mkdir -p "$dir/src"
  cp "$REPO_ROOT/src/$APP/host.json" "$dir/host.json"
  cp "$REPO_ROOT/src/$APP/package.json" "$dir/package.json"
  cp -R "$REPO_ROOT/src/$APP" "$dir/src/$APP"
  for file in "${SHARED[@]}"; do
    mkdir -p "$dir/$(dirname "$file")"
    cp "$REPO_ROOT/$file" "$dir/$file"
  done
}

if $STAGE_ONLY; then
  stage "$OUTPUT"
  exit 0
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
stage "$STAGE"

# npm, not the API's yarn tree: no lockfile here, and Flex charges extract time per file, so only
# the app's own five packages go in.
npm install --omit=dev --prefix "$STAGE" --no-audit --no-fund --loglevel=error

rm -f "$OUTPUT"
(cd "$STAGE" && zip -qr "$OUTPUT" .)
unzip -l "$OUTPUT" | tail -n 1
