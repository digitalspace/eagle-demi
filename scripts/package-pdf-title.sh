#!/usr/bin/env bash
# Usage: scripts/package-pdf-title.sh <repo-root> <output.zip>, for demi-pdf-title-<env>. An explicit
# list keeps test_* and __pycache__ out of the build; 0644 staging stops a local umask or exec bit shipping.
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
