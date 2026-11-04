#!/usr/bin/env bash
# Deploy gate for a side Function app: writes found=true|false to $GITHUB_OUTPUT. Skips with a
# notice when the tag lacks <marker> or the app is absent; any other az error fails the job.
set -uo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/probe-function-app.sh <resource-group> <app-name> <absent-hint> [<marker-file>]

<absent-hint> says how to create the app. <marker-file> is a file in the tag checkout (release/...)
that only tags carrying the app have, so redeploying an older tag still publishes; staging, which
deploys its own checkout, passes none.
An absent site answers Forbidden (AuthorizationFailed) as well as NotFound: CI's Website
Contributor role is granted per site by hand.
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac
[ $# -eq 3 ] || [ $# -eq 4 ] || { usage >&2; exit 1; }
RG="$1"; APP="$2"; HINT="$3"; MARKER="${4:-}"

skip() {
  echo "found=false" >> "$GITHUB_OUTPUT"
  echo "::notice::$1"
  echo "⏭️ $1" >> "$GITHUB_STEP_SUMMARY"
}

if [[ -n "$MARKER" && ! -f "$MARKER" ]]; then
  skip "The tag has no ${MARKER#release/}. Skipping the $APP deploy."
elif err=$(az functionapp show -g "$RG" -n "$APP" --query name -o tsv 2>&1 >/dev/null); then
  echo "found=true" >> "$GITHUB_OUTPUT"
elif [[ "$err" == *ResourceNotFound* ]]; then
  skip "$APP does not exist yet. $HINT Skipping the deploy."
elif [[ "$err" == *AuthorizationFailed* ]]; then
  skip "$APP is absent, or CI lacks Website Contributor on it. $HINT Grant the role and rerun. Skipping the deploy."
else
  echo "::error::az functionapp show failed for $APP: $err"
  exit 1
fi
