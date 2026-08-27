#!/usr/bin/env bash
#
# Add a redirect URI to the eagle-admin-console Keycloak client in realm eao-epic.
#
# The client is configured outside every repo, and the admin API replaces whole arrays on PUT.
# So this reads the client, appends to redirectUris in place, and PUTs the entire object back.
# A hand-written list would silently drop the other entries.
#
# Credentials come from the demi-keycloak-admin secret in OpenShift 6cdc9e-<env>. Run it
# yourself with `!` from a session that can read that secret.
#
#   scripts/keycloak-add-redirect.sh https://demi-admin-test-xxxx.a02.azurefd.net
#   ENV=test scripts/keycloak-add-redirect.sh <origin>       # default env: test
#   scripts/keycloak-add-redirect.sh --dry-run <origin>       # show the change, no PUT
set -euo pipefail

usage() { sed -n '2,15p' "$0"; exit "${1:-0}"; }

ENV="${ENV:-test}"
CLIENT_ID="eagle-admin-console"
REALM="eao-epic"
DRY_RUN=0
[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && usage
[[ "${1:-}" == "--dry-run" ]] && { DRY_RUN=1; shift; }
ORIGIN="${1:-}"
[[ -z "$ORIGIN" ]] && usage 1
[[ "$ORIGIN" =~ ^https://[^/]+$ ]] || { echo "origin must be https://host with no path: $ORIGIN" >&2; exit 1; }

case "$ENV" in
  test) KC_BASE="https://test.loginproxy.gov.bc.ca/auth"; NS="6cdc9e-test" ;;
  prod) KC_BASE="https://loginproxy.gov.bc.ca/auth"; NS="6cdc9e-prod" ;;
  *) echo "ENV must be test or prod" >&2; exit 1 ;;
esac
# The user login context expires; the github-cicd service-account context does not.
OC_CONTEXT="${OC_CONTEXT:-$NS/api-silver-devops-gov-bc-ca:6443/system:serviceaccount:6cdc9e-tools:github-cicd}"

# The secret holds an admin USERNAME/PASSWORD plus the KEYCLOAK_URL and KEYCLOAK_REALM to
# authenticate against (a realm admin user, password grant on admin-cli).
eval "$(oc --context "$OC_CONTEXT" get secret demi-keycloak-admin -n "$NS" -o json \
  | jq -r '.data | to_entries[] | "export \(.key)=\(.value|@base64d|@sh)"')"
for v in USERNAME PASSWORD KEYCLOAK_URL KEYCLOAK_REALM; do
  [[ -n "${!v:-}" ]] || { echo "secret is missing $v" >&2; exit 1; }
done

token=$(curl -fsS -X POST "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=admin-cli \
  --data-urlencode "username=$USERNAME" --data-urlencode "password=$PASSWORD" \
  | jq -r .access_token)
[[ -n "$token" && "$token" != "null" ]] || { echo "token request failed" >&2; exit 1; }
auth=(-H "Authorization: Bearer $token")
api="$KC_BASE/admin/realms/$REALM"

client=$(curl -fsS "${auth[@]}" "$api/clients?clientId=$CLIENT_ID" | jq '.[0]')
uuid=$(jq -r .id <<<"$client")
[[ "$uuid" == "null" ]] && { echo "client $CLIENT_ID not found in $REALM" >&2; exit 1; }

uri="$ORIGIN/*"
if jq -e --arg u "$uri" '.redirectUris | index($u)' <<<"$client" >/dev/null; then
  echo "already present: $uri"
  exit 0
fi

updated=$(jq --arg u "$uri" '.redirectUris += [$u]' <<<"$client")
echo "redirectUris after change:"
jq -r '.redirectUris[]' <<<"$updated" | sed 's/^/  /'
[[ $DRY_RUN -eq 1 ]] && { echo "(dry run, not written)"; exit 0; }

curl -fsS -X PUT "${auth[@]}" -H 'Content-Type: application/json' "$api/clients/$uuid" -d "$updated"
echo "added $uri to $CLIENT_ID ($REALM, $ENV)"
