#!/usr/bin/env bash
#
# Build the deployment zip for demi-pdf-title-<env>: pdf-title/ at the zip root, the same shape as
# the extractor zip. The list is explicit so test_* and __pycache__ never reach the remote build;
# files are staged at 0644 so a local umask or exec bit does not ship.
#
# Usage: scripts/package-pdf-title.sh <repo-root> <output.zip>
set -euo pipefail

REPO_ROOT="$(cd "${1:?repo root required}" && pwd)"
OUTPUT="${2:?output zip path required}"
OUTPUT="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"
FILES=(function_app.py run.py titler.py restore.py requirements.txt host.json)

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

for f in "${FILES[@]}"; do
  install -m 0644 "$REPO_ROOT/pdf-title/$f" "$STAGE/$f"
done

rm -f "$OUTPUT"
(cd "$STAGE" && zip -qX "$OUTPUT" "${FILES[@]}")
unzip -l "$OUTPUT"
