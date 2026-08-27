#!/usr/bin/env bash
#
# Create (or reset) a realm-local bot user in eao-epic for browser end-to-end tests.
#
# The user gets a generated password, non-temporary, and the realm role given. The
# password is written to the OpenShift secret `<username>` in 6cdc9e-<env> and never
# printed. Test code reads it from there; see eagle-demi-admin/scripts/e2e-smoke.mjs.
#
# Credentials to talk to Keycloak come from the demi-keycloak-admin secret, as in
# keycloak-add-redirect.sh. Run it yourself with `!`.
#
#   scripts/keycloak-create-bot-user.sh demi-admin-bot demi-admin
#   ENV=test scripts/keycloak-create-bot-user.sh <username> <realm-role> [email]
set -euo pipefail

usage() { sed -n '2,13p' "$0"; exit "${1:-0}"; }
[[ "${1:-}" == "--help" || "${1:-}" == "-h" || $# -lt 2 ]] && usage 1

BOT="$1"; ROLE="$2"; EMAIL="${3:-$BOT@eao-epic.test.invalid}"
ENV="${ENV:-test}"
REALM="eao-epic"
case "$ENV" in
  test) KC_BASE="https://test.loginproxy.gov.bc.ca/auth"; NS="6cdc9e-test" ;;
  *) echo "bot users are for test only" >&2; exit 1 ;;
esac
OC_CONTEXT="${OC_CONTEXT:-$NS/api-silver-devops-gov-bc-ca:6443/system:serviceaccount:6cdc9e-tools:github-cicd}"

eval "$(oc --context "$OC_CONTEXT" get secret demi-keycloak-admin -n "$NS" -o json \
  | jq -r '.data | to_entries[] | "export \(.key)=\(.value|@base64d|@sh)"')"
token=$(curl -fsS -X POST "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=admin-cli \
  --data-urlencode "username=$USERNAME" --data-urlencode "password=$PASSWORD" | jq -r .access_token)
[[ -n "$token" && "$token" != "null" ]] || { echo "token request failed" >&2; exit 1; }
auth=(-H "Authorization: Bearer $token" -H 'Content-Type: application/json')
api="$KC_BASE/admin/realms/$REALM"

# Find or create the user.
uid=$(curl -fsS "${auth[@]}" "$api/users?username=$BOT&exact=true" | jq -r '.[0].id // empty')
if [[ -z "$uid" ]]; then
  curl -fsS -X POST "${auth[@]}" "$api/users" -d "$(jq -n --arg u "$BOT" --arg e "$EMAIL" \
    '{username:$u, email:$e, emailVerified:true, enabled:true, firstName:"DEMI", lastName:"Bot"}')"
  uid=$(curl -fsS "${auth[@]}" "$api/users?username=$BOT&exact=true" | jq -r '.[0].id')
  echo "created user $BOT ($uid)"
else
  echo "user $BOT exists ($uid); resetting password and role"
fi

# Password: generated here, stored in OpenShift, never echoed.
pw=$(openssl rand -base64 30 | tr -d '/+=' | cut -c1-32)
curl -fsS -X PUT "${auth[@]}" "$api/users/$uid/reset-password" \
  -d "$(jq -n --arg p "$pw" '{type:"password", value:$p, temporary:false}')"

# Realm role.
role=$(curl -fsS "${auth[@]}" "$api/roles/$ROLE")
curl -fsS -X POST "${auth[@]}" "$api/users/$uid/role-mappings/realm" -d "[$role]"

oc --context "$OC_CONTEXT" -n "$NS" create secret generic "$BOT" \
  --from-literal=username="$BOT" --from-literal=password="$pw" \
  --dry-run=client -o yaml | oc --context "$OC_CONTEXT" -n "$NS" apply -f - >/dev/null
echo "password stored in secret/$BOT (namespace $NS); role $ROLE granted"
