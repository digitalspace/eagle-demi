#!/usr/bin/env bash
set -euo pipefail

# Wait for a function to be registered on a Function App after a Flex publish.
# Details: wiki CI-Workflows.

usage() {
  cat <<'EOF'
Usage: scripts/wait-for-function.sh <resource-group> <app-name> <function-name>

Polls `az functionapp function list` every 20s, up to 10 times, until the named
function appears. Exits 1 on timeout.

A deploy reporting success is not the same fact as the function being registered:
the host loads an app that registers nothing and every route then 404s. Trigger
sync is asynchronous after a Flex publish, hence the poll.

`az` errors are printed, not swallowed — an auth failure must not read as "not
registered yet".
EOF
}

case "${1:-}" in
  -h|--help|'') usage; exit 0 ;;
esac

[ $# -eq 3 ] || { usage; exit 1; }
RG="$1"; APP="$2"; FN="$3"

for i in $(seq 1 10); do
  # Names come back as `<app>/<function>` on some API versions, bare on others.
  if az functionapp function list -g "$RG" -n "$APP" --query "[].name" -o tsv \
       | sed 's#.*/##' | grep -qx "$FN"; then
    echo "✓ $FN is registered on $APP"
    exit 0
  fi
  echo "Attempt $i: $FN not registered yet, waiting..."
  sleep 20
done

echo "❌ $FN never appeared on $APP. The app is deployed and will not serve." >&2
exit 1
