#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/check-api-functions.sh <test|prod>

Checks that every function an app setting turns on is registered on
demi-api-fc-<env>. Read only: it lists setting NAMES (never values) and the
registered functions, and changes nothing.

api/index.js registers these functions only when their setting is not empty, and
the host reads that at startup. A setting added by an infra deploy shows up
only after the next API code deploy, so this check names the re-run to do.

Exits 0 when nothing is missing, 1 when a function is missing, 2 on a bad
argument. An az error is printed and ends the run non-zero.
EOF
}

case "${1:-}" in
  -h|--help|'') usage; exit 0 ;;
esac
[ $# -eq 1 ] || { usage >&2; exit 2; }

ENVIRONMENT="$1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/azure-env.sh
source "${REPO_ROOT}/scripts/lib/azure-env.sh"
if ! demi_azure_env "$ENVIRONMENT"; then
  echo "✗ unknown environment '${ENVIRONMENT}'. Use: test | prod" >&2
  exit 2
fi
APP="demi-api-fc-${ENVIRONMENT}"

# Setting=function, one row per guarded registration in api/index.js.
# test/scripts/check-api-functions.test.js compares this table with the code.
GUARDED=(
  RECONCILE_SCHEDULE=reconcileEagle
  RECONCILE_ENGAGE_SCHEDULE=reconcileEngage
  SYNC_TEAMS_SCHEDULE=syncTrackTeams
  SYNC_PROJECTS_SCHEDULE=syncTrackProjects
  NRPTI_SYNC_SCHEDULE=syncNrpti
  BULK_DOWNLOADS_QUEUE=bulkDownloadWorker
  CHUNK_RESTAMP_QUEUE=restampChunksWorker
  SEARCH_DEFINITIONS_QUEUE=searchDefinitionsWorker
  SYNC_OUT_QUEUE=syncOutWorker
  BULK_CLEANUP_SCHEDULE=cleanupBulkDownloads
  ANNOUNCE_UPDATES_SCHEDULE=announceUpdates
  EDGE_BAN_MODE=edgeBan
  INTAKE_STORAGE_ACCOUNT=intakeScanSweep
)

# The settings change restarts the host; wait until it serves again before reading what it registered.
"${REPO_ROOT}/scripts/wait-for-function.sh" "$RESOURCE_GROUP" "$APP" api "$SUBSCRIPTION"

# Names of non-empty settings only: bicep deploys a switched-off schedule as '', and the list keeps it.
SETTINGS="$(az functionapp config appsettings list -g "$RESOURCE_GROUP" -n "$APP" \
  --subscription "$SUBSCRIPTION" --query "[?value].name" -o tsv)"
REGISTERED="$(az functionapp function list -g "$RESOURCE_GROUP" -n "$APP" \
  --subscription "$SUBSCRIPTION" --query "[].name" -o tsv | sed 's#.*/##')"

echo "Registered on ${APP}:"
sed 's/^/  /' <<<"$REGISTERED"

MISSING=()
for row in "${GUARDED[@]}"; do
  setting="${row%%=*}"
  fn="${row#*=}"
  if grep -qx "$setting" <<<"$SETTINGS" && ! grep -qx "$fn" <<<"$REGISTERED"; then
    MISSING+=("$fn (turned on by ${setting})")
  fi
done

if [ "${#MISSING[@]}" -eq 0 ]; then
  echo "✓ every function turned on by a setting is registered on ${APP}"
  exit 0
fi

echo "✗ not registered on ${APP}:" >&2
printf '  %s\n' "${MISSING[@]}" >&2
case "$ENVIRONMENT" in
  test)
    echo "Re-run the API code deploy: workflow azure-deploy-staging-api.yaml on main." >&2
    ;;
  prod)
    echo "Re-run the API code deploy: workflow azure-deploy-prod.yaml with version set to the live tag." >&2
    echo "That is a prod deploy and needs the usual release approval (wiki Release-Process)." >&2
    ;;
esac
echo "If the live code is older than the function, a re-run cannot add it: deploy a newer tag." >&2
exit 1
