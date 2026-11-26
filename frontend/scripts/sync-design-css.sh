#!/usr/bin/env bash
# Copy eagle.css and components.css from eagle-design-kit into src/styles/vendor.
# --check compares instead of copying and exits 1 when they differ.
# vendor/demi-admin.css has no upstream any more: it is edited here, never synced.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: sync-design-css.sh [--check]

Copies eagle.css and components.css from the eagle-design-kit checkout into
src/styles/vendor/. With --check it only compares and exits 1 on a difference.

Environment:
  EAGLE_DESIGN_KIT   path to the eagle-design-kit checkout (default ../eagle-design-kit)
USAGE
}

check=false
case "${1:-}" in
  --check) check=true ;;
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) usage >&2; exit 2 ;;
esac

# frontend/ is a subdir of the eagle-demi repo, so siblings are two levels up, not one.
app="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app/.." && pwd)"
kit="${EAGLE_DESIGN_KIT:-$repo_root/../eagle-design-kit}"
dest="$app/src/styles/vendor"

# CI checks out only this repo, so siblings never exist there. --check is a
# local dev convenience in that case, not a gate: skip clean instead of
# failing a build that has no way to satisfy the check.
if $check && [ ! -d "$kit" ]; then
  echo "sibling repo not present (EAGLE_DESIGN_KIT) — skipping check"
  exit 0
fi

if [ ! -d "$kit" ]; then
  echo "design kit not found at $kit (set EAGLE_DESIGN_KIT)" >&2
  exit 1
fi

status=0
sync_one() {
  local src="$1" name="$2"
  if [ ! -f "$src" ]; then
    echo "missing $src" >&2
    exit 1
  fi
  if $check; then
    if ! diff -q "$src" "$dest/$name" >/dev/null 2>&1; then
      echo "out of date: src/styles/vendor/$name"
      status=1
    fi
  else
    mkdir -p "$dest"
    cp "$src" "$dest/$name"
    echo "copied $name"
  fi
}

sync_one "$kit/eagle.css" eagle.css
sync_one "$kit/components.css" components.css

$check && [ $status -eq 0 ] && echo "design css in sync"
exit $status
