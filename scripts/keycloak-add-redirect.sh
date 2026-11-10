#!/usr/bin/env bash
# The admin API replaces whole arrays on PUT, so the client is read and PUT back with entries
# appended; a hand-written list would drop the others.
set -euo pipefail

usage() {
  cat <<'EOF'
Add <origin>/* to redirectUris and <origin> to webOrigins on a client in realm eao-epic.

  scripts/keycloak-add-redirect.sh [--dry-run] <origin>

  CLIENT_ID   client to change (default eagle-admin-console)
  ENV         test or prod Keycloak (default test)
  OC_CONTEXT  oc context that can read secret demi-keycloak-admin in 6cdc9e-<env>
EOF
  exit "${1:-0}"
}

ENV="${ENV:-test}"
CLIENT_ID="${CLIENT_ID:-eagle-admin-console}"
REALM="eao-epic"
DRY_RUN=0
args=()
for a in "$@"; do
  case "$a" in
    -h|--help) usage ;;
    --dry-run) DRY_RUN=1 ;;
    -*) echo "unknown flag: $a" >&2; usage 1 ;;
    *) args+=("$a") ;;
  esac
done
[[ ${#args[@]} -eq 1 ]] || usage 1
ORIGIN="${args[0]}"
[[ "$ORIGIN" =~ ^https://[^/]+$ || "$ORIGIN" =~ ^http://localhost(:[0-9]+)?$ ]] || { echo "origin must be https://host (or http://localhost[:port]) with no path: $ORIGIN" >&2; exit 1; }

case "$ENV" in
  test) KC_BASE="https://test.loginproxy.gov.bc.ca/auth"; NS="6cdc9e-test" ;;
  prod) KC_BASE="https://loginproxy.gov.bc.ca/auth"; NS="6cdc9e-prod" ;;
  *) echo "ENV must be test or prod" >&2; exit 1 ;;
esac
# The user login context expires; the github-cicd service-account context does not.
OC_CONTEXT="${OC_CONTEXT:-$NS/api-silver-devops-gov-bc-ca:6443/system:serviceaccount:6cdc9e-tools:github-cicd}"

# shellcheck source=lib/keycloak-admin.sh
source "${BASH_SOURCE[0]%/*}/lib/keycloak-admin.sh"
token=$(kc_admin_token "$OC_CONTEXT" "$NS")
# Header and body go through /dev/fd and stdin: the token and client JSON never show in ps.
auth_header() { printf 'Authorization: Bearer %s\n' "$token"; }
api="$KC_BASE/admin/realms/$REALM"

client=$(curl -fsS -H @<(auth_header) "$api/clients?clientId=$CLIENT_ID" | jq '.[0]')
uuid=$(jq -r .id <<<"$client")
[[ "$uuid" == "null" ]] && { echo "client $CLIENT_ID not found in $REALM" >&2; exit 1; }

uri="$ORIGIN/*"
updated=$(jq --arg u "$uri" --arg o "$ORIGIN" '
  .redirectUris = ((.redirectUris // []) | if index($u) then . else . + [$u] end)
  | .webOrigins = ((.webOrigins // []) | if index($o) then . else . + [$o] end)' <<<"$client")
added=$(printf '%s\n%s\n' "$client" "$updated" | jq -rs '. as [$a, $b]
  | [("redirectUris", "webOrigins") as $k | ($b[$k] - ($a[$k] // []))[] as $v | "\($k) \($v)"]
  | join(", ")')

echo "client=$CLIENT_ID realm=$REALM env=$ENV"
if [[ -z "$added" ]]; then
  echo "already present: redirectUris $uri, webOrigins $ORIGIN"
  exit 0
fi
for k in redirectUris webOrigins; do
  echo "$k after change:"
  jq -r --arg k "$k" '.[$k][]' <<<"$updated" | sed 's/^/  /'
done
[[ $DRY_RUN -eq 1 ]] && { echo "(dry run, not written)"; exit 0; }

curl -fsS -X PUT -H @<(auth_header) -H 'Content-Type: application/json' \
  "$api/clients/$uuid" --data-binary @- <<<"$updated"
echo "added $added"
