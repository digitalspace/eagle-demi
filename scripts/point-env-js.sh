#!/usr/bin/env bash
set -euo pipefail

# Rewrite the environment-dependent lines of env.js before a deploy build.
# Details: wiki CI-Workflows.

usage() {
  cat <<'EOF'
Usage: scripts/point-env-js.sh <dev|test|prod> [env.js path]

Rewrites the environment-dependent lines of env.js in place (default
frontend/public/env.js) and asserts each one afterwards. Fails if a line is
missing, so a renamed key stops the deploy instead of shipping the wrong realm.

Matches on the key name, never on the old value: the committed file may already
hold any environment's values.

Environment variables:
  APPINSIGHTS_CONNECTION_STRING  browser telemetry; empty (default) turns it off
  NOTIFY_API_LOCATION            eagle-notify base URL; required for prod, which
                                 has no notify host yet

configEndpoint is forced true: this script only prepares a DEPLOYED bundle, which
reads the rest of its config from /api/config.
EOF
}

case "${1:-}" in
  -h|--help|'') usage; exit 0 ;;
esac

ENV_NAME="$1"
ENV_JS="${2:-frontend/public/env.js}"

case "$ENV_NAME" in
  dev)  KEYCLOAK_URL='https://dev.loginproxy.gov.bc.ca/auth';  NOTIFY_DEFAULT='https://notify-api-test.azurewebsites.net' ;;
  test) KEYCLOAK_URL='https://test.loginproxy.gov.bc.ca/auth'; NOTIFY_DEFAULT='https://notify-api-test.azurewebsites.net' ;;
  prod) KEYCLOAK_URL='https://loginproxy.gov.bc.ca/auth';      NOTIFY_DEFAULT='' ;;
  *) echo "unknown environment '$ENV_NAME' — expected dev, test or prod" >&2; exit 1 ;;
esac

[ -f "$ENV_JS" ] || { echo "::error::$ENV_JS does not exist" >&2; exit 1; }

NOTIFY="${NOTIFY_API_LOCATION:-$NOTIFY_DEFAULT}"
[ -n "$NOTIFY" ] || { echo "::error::set NOTIFY_API_LOCATION — $ENV_NAME has no default notify host" >&2; exit 1; }

# `&`, `\` and the s||| delimiter, so a value carrying one cannot rewrite the command.
esc() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

# set_key <key> <javascript literal>
set_key() {
  local key="$1" value="$2"
  grep -q "window.__env.${key} = " "$ENV_JS" \
    || { echo "::error file=$ENV_JS::no 'window.__env.${key} =' line to rewrite" >&2; exit 1; }
  sed -i "s|\(window.__env.${key} = \)[^;]*;|\1$(esc "$value");|" "$ENV_JS"
  grep -qF "window.__env.${key} = ${value};" "$ENV_JS" \
    || { echo "::error file=$ENV_JS::${key} rewrite did not take" >&2; exit 1; }
}

set_key ENVIRONMENT "'${ENV_NAME}'"
set_key KEYCLOAK_URL "'${KEYCLOAK_URL}'"
set_key NOTIFY_API_LOCATION "'${NOTIFY}'"
set_key configEndpoint 'true'
set_key APPINSIGHTS_CONNECTION_STRING "'${APPINSIGHTS_CONNECTION_STRING:-}'"

echo "✓ $ENV_JS points at $ENV_NAME"
