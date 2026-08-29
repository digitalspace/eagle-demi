#!/usr/bin/env bash
# Copy eagle.css, components.css and demi-admin's app.css into src/styles/vendor.
# --check compares instead of copying and exits 1 when they differ.
# Modelled on eagle-demi-admin/scripts/sync-design-kit.sh (extra source + rename, same shape).
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: sync-design-css.sh [--check]

Copies eagle.css and components.css from the eagle-design-kit checkout, and
app.css from the eagle-demi-admin checkout (as demi-admin.css), into
src/styles/vendor/. With --check it only compares and exits 1 on a difference.

Environment:
  EAGLE_DESIGN_KIT   path to the eagle-design-kit checkout (default ../eagle-design-kit)
  EAGLE_DEMI_ADMIN    path to the eagle-demi-admin checkout (default ../eagle-demi-admin)
USAGE
}

check=false
case "${1:-}" in
  --check) check=true ;;
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) usage >&2; exit 2 ;;
esac

# frontend/ is a subdir of the eagle-demi repo, unlike eagle-demi-admin where
# scripts/ sits at repo root — so siblings are two levels up, not one.
frontend="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$frontend/.." && pwd)"
kit="${EAGLE_DESIGN_KIT:-$repo_root/../eagle-design-kit}"
admin="${EAGLE_DEMI_ADMIN:-$repo_root/../eagle-demi-admin}"
dest="$frontend/src/styles/vendor"

# CI checks out only this repo, so siblings never exist there. --check is a
# local dev convenience in that case, not a gate: skip clean instead of
# failing a build that has no way to satisfy the check.
if $check && { [ ! -d "$kit" ] || [ ! -d "$admin" ]; }; then
  echo "sibling repos not present (EAGLE_DESIGN_KIT/EAGLE_DEMI_ADMIN) — skipping check"
  exit 0
fi

if [ ! -d "$kit" ]; then
  echo "design kit not found at $kit (set EAGLE_DESIGN_KIT)" >&2
  exit 1
fi
if [ ! -d "$admin" ]; then
  echo "demi-admin not found at $admin (set EAGLE_DEMI_ADMIN)" >&2
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
sync_one "$admin/src/styles/app.css" demi-admin.css

$check && [ $status -eq 0 ] && echo "design css in sync"
exit $status
