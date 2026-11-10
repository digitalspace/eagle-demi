# shellcheck shell=bash
# Sourced, not run. kc_admin_token <oc-context> <namespace> prints an admin access token, using
# secret $KC_ADMIN_SECRET (default demi-keycloak-admin). Used by scripts/keycloak-*.sh.
kc_admin_token() {
  local ctx="$1" ns="$2" secret="${KC_ADMIN_SECRET:-demi-keycloak-admin}" json v token url
  # Declared empty so a USERNAME or similar from the caller's shell never stands in for the secret.
  local USERNAME='' PASSWORD='' KEYCLOAK_CLIENT_ID='' KEYCLOAK_CLIENT_SECRET='' KEYCLOAK_URL='' KEYCLOAK_REALM=''
  json=$(oc --context "$ctx" get secret "$secret" -n "$ns" -o json) \
    || { echo "cannot read secret $secret in $ns via $ctx" >&2; return 1; }
  # Only these keys: any other key would be eval'd too and could clobber PATH or echo a value.
  eval "$(jq -r '.data | with_entries(select(.key | IN("USERNAME", "PASSWORD", "KEYCLOAK_CLIENT_ID",
    "KEYCLOAK_CLIENT_SECRET", "KEYCLOAK_URL", "KEYCLOAK_REALM"))) | to_entries[]
    | "\(.key)=\(.value | @base64d | @sh)"' <<<"$json")"
  for v in KEYCLOAK_URL KEYCLOAK_REALM; do
    [[ -n "${!v}" ]] || { echo "secret is missing $v" >&2; return 1; }
  done
  # Older secrets still name the retired oidc.gov.bc.ca host; the realm lives on loginproxy now.
  url="${KC_URL_OVERRIDE:-$KEYCLOAK_URL}/realms/$KEYCLOAK_REALM/protocol/openid-connect/token"
  # Two credential shapes exist: a confidential client (client credentials) and an admin user
  # (password grant on admin-cli). Secrets go through /dev/fd so they never show in ps.
  if [[ -n "$KEYCLOAK_CLIENT_SECRET" ]]; then
    token=$(curl -fsS -X POST "$url" -d grant_type=client_credentials \
      --data-urlencode "client_id=$KEYCLOAK_CLIENT_ID" \
      --data-urlencode "client_secret@"<(printf %s "$KEYCLOAK_CLIENT_SECRET") | jq -r .access_token)
  elif [[ -n "$USERNAME" ]]; then
    token=$(curl -fsS -X POST "$url" -d grant_type=password -d client_id=admin-cli \
      --data-urlencode "username=$USERNAME" \
      --data-urlencode "password@"<(printf %s "$PASSWORD") | jq -r .access_token)
  else
    echo "secret has neither USERNAME/PASSWORD nor KEYCLOAK_CLIENT_ID/_SECRET" >&2; return 1
  fi
  [[ -n "$token" && "$token" != "null" ]] || { echo "token request failed" >&2; return 1; }
  printf '%s\n' "$token"
}
