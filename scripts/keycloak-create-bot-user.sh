#!/usr/bin/env bash
set -euo pipefail

usage() {
  local out=1
  [[ "${1:-0}" -eq 0 ]] || out=2
  cat >&"$out" <<'EOF'
Create or reset a bot user in realm eao-epic on test Keycloak, for browser end-to-end tests.
Its generated password goes to OpenShift secret <username> in 6cdc9e-test, never to output.
eagle-demi-admin/scripts/e2e-smoke.mjs reads it from there.

  scripts/keycloak-create-bot-user.sh <username> <realm-role> [email]

  OC_CONTEXT       oc context that can read the admin secret in 6cdc9e-test
  KC_ADMIN_SECRET  admin credential secret (default demi-keycloak-admin)
  KC_URL_OVERRIDE  token host to use instead of the secret's KEYCLOAK_URL
EOF
  exit "${1:-0}"
}
[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && usage
[[ $# -ge 2 ]] || usage 1

BOT="$1"; ROLE="$2"; EMAIL="${3:-$BOT@eao-epic.test.invalid}"
ENV="${ENV:-test}"
REALM="eao-epic"
case "$ENV" in
  test) KC_BASE="https://test.loginproxy.gov.bc.ca/auth"; NS="6cdc9e-test" ;;
  *) echo "bot users are for test only" >&2; exit 1 ;;
esac
OC_CONTEXT="${OC_CONTEXT:-$NS/api-silver-devops-gov-bc-ca:6443/system:serviceaccount:6cdc9e-tools:github-cicd}"

# shellcheck source=lib/keycloak-admin.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/keycloak-admin.sh"
token=$(kc_admin_token "$OC_CONTEXT" "$NS")
auth=(-H "Authorization: Bearer $token" -H 'Content-Type: application/json')
api="$KC_BASE/admin/realms/$REALM"

uid=$(curl -fsS "${auth[@]}" "$api/users?username=$BOT&exact=true" | jq -r '.[0].id // empty') || { echo "step: list users (needs view-users)" >&2; exit 1; }
if [[ -z "$uid" ]]; then
  curl -fsS -X POST "${auth[@]}" "$api/users" -d "$(jq -n --arg u "$BOT" --arg e "$EMAIL" \
    '{username:$u, email:$e, emailVerified:true, enabled:true, firstName:"DEMI", lastName:"Bot"}')" \
    || { echo "step: create user (needs manage-users)" >&2; exit 1; }
  uid=$(curl -fsS "${auth[@]}" "$api/users?username=$BOT&exact=true" | jq -r '.[0].id')
  echo "created user $BOT ($uid)"
else
  echo "user $BOT exists ($uid); resetting password and role"
fi

# Password: generated here, stored in OpenShift, never echoed.
pw=$(openssl rand -base64 30 | tr -d '/+=' | cut -c1-32)
curl -fsS -X PUT "${auth[@]}" "$api/users/$uid/reset-password" \
  -d "$(jq -n --arg p "$pw" '{type:"password", value:$p, temporary:false}')" \
  || { echo "step: reset password (needs manage-users)" >&2; exit 1; }

role=$(curl -fsS "${auth[@]}" "$api/roles/$ROLE") || { echo "step: read role $ROLE (needs view-realm)" >&2; exit 1; }
curl -fsS -X POST "${auth[@]}" "$api/users/$uid/role-mappings/realm" -d "[$role]" \
  || { echo "step: grant role (needs manage-users)" >&2; exit 1; }

oc --context "$OC_CONTEXT" -n "$NS" create secret generic "$BOT" \
  --from-literal=username="$BOT" --from-literal=password="$pw" \
  --dry-run=client -o yaml | oc --context "$OC_CONTEXT" -n "$NS" apply -f - >/dev/null
echo "password stored in secret/$BOT (namespace $NS); role $ROLE granted"
