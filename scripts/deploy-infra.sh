#!/usr/bin/env bash
set -euo pipefail

# Bicep infrastructure deployment for DEMI.
# Usage: ./scripts/deploy-infra.sh [test|dev|prod] [--what-if|--live]
#
# WHAT-IF IS THE DEFAULT. Nothing is applied without `--live`, and prod additionally refuses to
# apply unless CONFIRM_PROD=yes is exported. The old default was the deployment itself, which put
# the whole-collection appSettings PUT one typo away from every invocation.
#
# Separate from `deploy-azure.sh` on purpose. That script is zipdeploy-and-poll for application
# code and CI runs it on every push to main. Infrastructure is a different lifecycle, a different
# blast radius, and a credential CI deliberately does not hold — `demi-cicd-*` has Website
# Contributor on two App Services and nothing at resource-group scope, so it could not run an ARM
# deployment even if a job were added. This stays a deliberate, human-initiated command.
#
# ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────────────────────────
#
# `siteConfig.appSettings` in api-web-app.bicep is a WHOLE-COLLECTION PUT: every setting the
# template does not supply is deleted from the running app. Six of them are secrets the template
# cannot derive, so a deploy has to be told all six. That made the procedure a multi-command
# hand-export across two clouds, documented only in a comment, and getting it wrong overwrote the
# break-glass credential with an empty string.
#
# `what-if` could not warn about any of it: it masks @secure() values as "*******" in BOTH the
# before and the after, so a credential being blanked renders as no change at all.
#
# Two guards now exist ahead of this script — the .bicepparam files call readEnvironmentVariable
# with NO fallback, so a missing export fails the build rather than deploying an empty string.
# This script is the third: it fetches the values so nobody has to, and asserts afterwards that
# they survived.
#
# ── SECRETS ───────────────────────────────────────────────────────────────────────────────────
#
# Lengths are printed, values never. A credential in a terminal is a credential in a scrollback
# buffer, a CI log, and whatever is reading over your shoulder.
#
# ── TESTING THIS SCRIPT ───────────────────────────────────────────────────────────────────────
#
# Use `--what-if`, or an environment you are willing to lose. NEVER exercise the guard by passing a
# junk value at a live environment: on 2026-08-13 an `ADMIN_API_KEY=" "` abort-path test was let
# through by a `[ -z ]` check, ran a real deployment, and destroyed two live credentials that had
# no other copy. The guard is stricter now; the habit still matters more than the guard.

ENVIRONMENT="${1:-test}"
MODE="${2:---what-if}"
export REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

case "$ENVIRONMENT" in
  test)
    SUBSCRIPTION='7897ceb1-9a86-4639-87d7-7f9ff67142b3'
    RESOURCE_GROUP='c4b0a8-test-rg'
    ;;
  dev)
    SUBSCRIPTION='d2f8d048-2af3-44fd-81cc-858c040001f2'
    RESOURCE_GROUP='c4b0a8-dev-rg'
    ;;
  prod)
    SUBSCRIPTION='be5924ac-1083-4a1b-be92-7b444882cfd9'
    RESOURCE_GROUP='rg-demi-prod'
    # This box has NO prod write context. The name below is the read-only ServiceAccount context
    # from the workspace CLAUDE.md, used here to read the MinIO secret and demi-app-secrets
    # (ADMIN_API_KEY, DOCLING_API_KEY, TRACK_CLIENT_SECRET, ROLE_SYNC_CLIENT_SECRET) out of
    # 6cdc9e-prod. Export any of them by hand to override.
    OC_CONTEXT='6cdc9e-prod/api-silver-devops-gov-bc-ca:6443/system:serviceaccount:6cdc9e-tools:github-cicd'
    ;;
  *)
    echo -e "${RED}✗ unknown environment '${ENVIRONMENT}'. Use: test | dev | prod${NC}" >&2
    exit 2
    ;;
esac

# One name per environment because prod's is not "epic-prod" — there is no prod write context on
# this machine, only the read-only ServiceAccount one set above.
OC_CONTEXT="${OC_CONTEXT:-epic-${ENVIRONMENT}}"

# The object-store credential is in a DIFFERENT secret with DIFFERENT keys in prod. Same values,
# same exported names — only where they are read from changes.
if [ "$ENVIRONMENT" = 'prod' ]; then
  MINIO_SECRET_NAME='nr-object-store-credential'
  MINIO_ACCESS_KEY_FIELD='user_account'
  MINIO_SECRET_KEY_FIELD='password'
else
  MINIO_SECRET_NAME='eagle-api-minio-keys'
  MINIO_ACCESS_KEY_FIELD='MINIO_ACCESS_KEY'
  MINIO_SECRET_KEY_FIELD='MINIO_SECRET_KEY'
fi

case "$MODE" in
  --what-if|--live) ;;
  *)
    echo -e "${RED}✗ unknown mode '${MODE}'. Use: --what-if (default) | --live${NC}" >&2
    exit 2
    ;;
esac

# The applied-in-prod guard. Deliberately an environment variable rather than a prompt: it survives
# a terminal with no TTY, and it cannot be answered by a stray keystroke.
if [ "$ENVIRONMENT" = 'prod' ] && [ "$MODE" = '--live' ] && [ "${CONFIRM_PROD:-}" != 'yes' ]; then
  echo -e "${RED}✗ refusing to apply to prod. Export CONFIRM_PROD=yes if that is what you mean.${NC}" >&2
  exit 2
fi

PARAM_FILE="${REPO_ROOT}/azure/main.${ENVIRONMENT}.bicepparam"
# test and prod use main.<env>.bicepparam; dev is the unsuffixed one, matching the repo's naming.
[ "$ENVIRONMENT" = 'dev' ] && PARAM_FILE="${REPO_ROOT}/azure/main.bicepparam"

# Verify the app this deployment actually writes: with the legacy module off, only the Flex app
# received the settings, and probing (or stop/starting) the untouched legacy app would be wrong.
if grep -Eq '^param deployLegacyApi *= *false' "$PARAM_FILE"; then
  API_APP="demi-api-fc-${ENVIRONMENT}"
else
  API_APP="demi-api-${ENVIRONMENT}"
fi

# Read one key out of an OpenShift secret. OpenShift is the source of truth for every credential
# this template deploys — NOT the app settings.
#
# That distinction is the whole reason this function looks like it does. An earlier version
# round-tripped ADMIN_API_KEY and DOCLING_API_KEY out of the live app settings, which sounds
# idempotent and is actually a loop: a deploy that reads the app's own settings will happily feed a
# corrupted value straight back into it, and there is then nothing left to recover from. That is
# not hypothetical — on 2026-08-13 a bad value reached the app that way and both credentials were
# permanently lost, because ARM does not retain @secure() parameters either. MinIO survived the
# same incident purely because OpenShift held an authoritative copy.
#
# `|| true` so a missing secret is reported by the length check below with a useful message, rather
# than killing the script under `set -e` with an oc error.
os_secret() {
  oc --context "$OC_CONTEXT" get secret "$1" -n "6cdc9e-${ENVIRONMENT}" \
    -o "jsonpath={.data.${2}}" 2>/dev/null | base64 -d 2>/dev/null || true
}

# `${VAR:-…}` and not a bare assignment, deliberately: an already-exported value always wins. That
# is what makes a FRESH environment work, where the OpenShift secrets do not exist yet and the
# operator supplies the values instead.
require_secrets() {
  echo -e "${BLUE}[1/4] Sourcing secrets from OpenShift (6cdc9e-${ENVIRONMENT})…${NC}"

  MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-$(os_secret "$MINIO_SECRET_NAME" "$MINIO_ACCESS_KEY_FIELD")}"
  MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-$(os_secret "$MINIO_SECRET_NAME" "$MINIO_SECRET_KEY_FIELD")}"
  ADMIN_API_KEY="${ADMIN_API_KEY:-$(os_secret demi-app-secrets ADMIN_API_KEY)}"
  DOCLING_API_KEY="${DOCLING_API_KEY:-$(os_secret demi-app-secrets DOCLING_API_KEY)}"
  TRACK_CLIENT_SECRET="${TRACK_CLIENT_SECRET:-$(os_secret demi-app-secrets TRACK_CLIENT_SECRET)}"
  ROLE_SYNC_CLIENT_SECRET="${ROLE_SYNC_CLIENT_SECRET:-$(os_secret demi-app-secrets ROLE_SYNC_CLIENT_SECRET)}"

  export MINIO_ACCESS_KEY MINIO_SECRET_KEY ADMIN_API_KEY DOCLING_API_KEY
  export TRACK_CLIENT_SECRET ROLE_SYNC_CLIENT_SECRET

  local -a required=(MINIO_ACCESS_KEY MINIO_SECRET_KEY ADMIN_API_KEY DOCLING_API_KEY
    TRACK_CLIENT_SECRET ROLE_SYNC_CLIENT_SECRET)

  # The devbox SSH key. A public key, not a credential — but the param file reads it with no
  # fallback like the six above, so a missing one fails the build, and the same guard is what turns
  # that into a message. Only where the param file switches the VM on: prod deploys no devbox, and
  # there is no demi-app-secrets in 6cdc9e-prod to read it from either.
  if grep -Eq '^param deployDevbox *= *true' "$PARAM_FILE"; then
    DEVBOX_SSH_PUBLIC_KEY="${DEVBOX_SSH_PUBLIC_KEY:-$(os_secret demi-app-secrets DEVBOX_SSH_PUBLIC_KEY)}"
    export DEVBOX_SSH_PUBLIC_KEY
    required+=(DEVBOX_SSH_PUBLIC_KEY)
  fi

  # `val` via indirect expansion, then ${#val}. There is no ${#!name} form — bash rejects it as a
  # bad substitution, and `bash -n` does not catch it because it is a runtime expansion error.
  #
  # MIN_LEN rather than a bare emptiness check. `[ -z ]` passes a single space, which is exactly how
  # a throwaway test value reached a real deployment and destroyed two live credentials. Nothing
  # here is legitimately shorter than 8 characters — the real ones are 11, 40, 48 and 64.
  local missing=0 val
  local -r MIN_LEN=8
  for name in "${required[@]}"; do
    # Trim surrounding whitespace before judging it, so " " is empty and not a one-character secret.
    val="$(printf '%s' "${!name}" | tr -d '[:space:]')"
    if [ -z "$val" ]; then
      echo -e "${RED}  ✗ ${name} is empty${NC}" >&2
      missing=1
    elif [ "${#val}" -lt "$MIN_LEN" ]; then
      echo -e "${RED}  ✗ ${name} is ${#val} chars — under the ${MIN_LEN}-char floor, refusing${NC}" >&2
      missing=1
    else
      # Re-export the trimmed value: a trailing newline from `oc` would be deployed verbatim.
      printf -v "$name" '%s' "$val"
      export "${name?}"
      echo -e "${GREEN}  ✓ ${name}${NC} (${#val} chars)"
    fi
  done

  if [ "$missing" -ne 0 ]; then
    cat >&2 <<EOF

Refusing to deploy. Deploying an empty or junk value would overwrite the live credential, and
there is no rollback — ARM does not retain @secure() parameter values.

  MINIO_ACCESS_KEY / MINIO_SECRET_KEY      OpenShift secret ${MINIO_SECRET_NAME} in 6cdc9e-${ENVIRONMENT}
                                           (keys ${MINIO_ACCESS_KEY_FIELD} / ${MINIO_SECRET_KEY_FIELD})
  ADMIN_API_KEY / DOCLING_API_KEY          OpenShift secret demi-app-secrets in 6cdc9e-${ENVIRONMENT}
  TRACK_CLIENT_SECRET / ROLE_SYNC_CLIENT_SECRET  OpenShift secret demi-app-secrets in 6cdc9e-${ENVIRONMENT}
  DEVBOX_SSH_PUBLIC_KEY                    OpenShift secret demi-app-secrets in 6cdc9e-${ENVIRONMENT}
                                           (a PUBLIC key — 'ssh-keygen -t ed25519' and store the .pub,
                                           or export it; only asked for when deployDevbox = true)

There is no demi-app-secrets in 6cdc9e-prod — export all six by hand for a prod run.

Check 'oc --context ${OC_CONTEXT}' works, or export the missing value and re-run.
EOF
    exit 3
  fi
}

run_deployment() {
  local name="infra-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo manual)-$(date -u +%H%M%S)"

  if [ "$MODE" = '--what-if' ]; then
    echo -e "${BLUE}[2/4] what-if against ${RESOURCE_GROUP}…${NC}"
    echo -e "${YELLOW}  Reminder: @secure() values render as '*******' in both before and after.${NC}"
    echo -e "${YELLOW}  A blanked credential is INVISIBLE here. That is what step 4 is for.${NC}"
    az deployment group what-if -g "$RESOURCE_GROUP" --subscription "$SUBSCRIPTION" \
      -f "${REPO_ROOT}/azure/main.bicep" -p "$PARAM_FILE" --only-show-errors
    exit 0
  fi

  echo -e "${BLUE}[2/4] Deploying ${name}…${NC}"
  az deployment group create -g "$RESOURCE_GROUP" --subscription "$SUBSCRIPTION" \
    -f "${REPO_ROOT}/azure/main.bicep" -p "$PARAM_FILE" -n "$name" --no-wait --only-show-errors

  # Poll the record rather than trusting the CLI's exit code, for the same reason deploy-azure.sh
  # does: --no-wait returns as soon as ARM accepts the request, which is not the same fact as the
  # deployment succeeding.
  echo -e "${BLUE}[3/4] Waiting…${NC}"
  local state
  if ! az deployment group wait -g "$RESOURCE_GROUP" --subscription "$SUBSCRIPTION" \
        -n "$name" --created --timeout 1800 --only-show-errors; then
    state=$(az deployment group show -g "$RESOURCE_GROUP" --subscription "$SUBSCRIPTION" \
      -n "$name" --query properties.provisioningState -o tsv --only-show-errors 2>/dev/null || echo Unknown)
    echo -e "${RED}✗ deployment ${name}: ${state}${NC}" >&2
    az deployment group show -g "$RESOURCE_GROUP" --subscription "$SUBSCRIPTION" \
      -n "$name" --query "properties.error.details[].target" -o tsv --only-show-errors >&2 || true
    echo -e "${YELLOW}  Which module failed:${NC}" >&2
    echo "  az deployment operation group list -g ${RESOURCE_GROUP} -n <module> --query \"[?properties.provisioningState=='Failed']\"" >&2
    # Still assert, even on failure: a partial apply can have reached the app settings.
    assert_secrets_survived
    exit 1
  fi
  echo -e "${GREEN}✓ deployment ${name}: Succeeded${NC}"
}

# The check the whole script is for. Everything above it is convenience; this is the part that
# catches the failure that started all of this — a deploy that reports success while having
# emptied a credential.
assert_secrets_survived() {
  echo -e "${BLUE}[4/4] Verifying live app settings…${NC}"
  local failed=0 len
  for name in DOCLING_API_KEY MINIO_ACCESS_KEY MINIO_SECRET_KEY EAGLE_API_BASE; do
    len=$(az webapp config appsettings list -n "$API_APP" -g "$RESOURCE_GROUP" \
      --subscription "$SUBSCRIPTION" --only-show-errors \
      --query "[?name=='${name}'] | [0].value | length(@)" -o tsv 2>/dev/null || echo 0)
    if [ -z "$len" ] || [ "$len" = '0' ] || [ "$len" = 'None' ]; then
      echo -e "${RED}  ✗ ${name} is EMPTY or ABSENT on ${API_APP}${NC}" >&2
      failed=1
    else
      echo -e "${GREEN}  ✓ ${name}${NC} (${len} chars)"
    fi
  done

  # ADMIN_API_KEY is not length-checked above: the app setting is always the literal
  # `@Microsoft.KeyVault(SecretUri=...)` reference (~70 chars) whether or not it resolves, so the
  # length check the other four use would pass on a dead reference. Probe the key live instead.
  local code attempt
  local recycled=0
  probe_admin_key() {
    curl -s -o /dev/null -w '%{http_code}' --max-time 60 \
      -H "X-Api-Key: ${ADMIN_API_KEY}" \
      "https://${API_APP}.azurewebsites.net/api/db/stats" 2>/dev/null || echo 000
  }
  for attempt in 1 2 3; do
    code=$(probe_admin_key)
    [ "$code" = '200' ] && break
    [ "$attempt" -lt 3 ] && sleep 30
  done
  if [ "$code" = '401' ]; then
    # A worker that started mid-deploy keeps the unresolved @Microsoft.KeyVault literal even after
    # the platform reports the reference Resolved; only a stop/start re-reads it (seen 2026-08-28).
    echo -e "${YELLOW}  ADMIN_API_KEY probe 401 — stop/start ${API_APP} to re-read the Key Vault reference${NC}"
    if az functionapp stop -g "$RESOURCE_GROUP" -n "$API_APP" --subscription "$SUBSCRIPTION" -o none; then
      # Between stop and start the app is down; an interrupt here must still start it.
      trap 'az functionapp start -g "$RESOURCE_GROUP" -n "$API_APP" --subscription "$SUBSCRIPTION" -o none' EXIT
      sleep 10
      if az functionapp start -g "$RESOURCE_GROUP" -n "$API_APP" --subscription "$SUBSCRIPTION" -o none; then
        trap - EXIT
        recycled=1
        for attempt in 1 2 3 4 5 6; do
          sleep 15; code=$(probe_admin_key); [ "$code" = '200' ] && break
        done
      else
        echo -e "${RED}  ✗ ${API_APP} is STOPPED and 'az functionapp start' failed — start it by hand now.${NC}" >&2
        exit 4
      fi
    fi
  fi
  if [ "$code" = '200' ]; then
    echo -e "${GREEN}  ✓ ADMIN_API_KEY${NC} (live probe: 200)"
  else
    echo -e "${RED}  ✗ ADMIN_API_KEY live probe returned ${code} on ${API_APP}${NC}" >&2
    echo -e "${YELLOW}    401 means the Key Vault reference did not resolve.${NC}" >&2
    [ "$recycled" = 1 ] && echo -e "${YELLOW}    Retried 3x, then stop/started the app once; still not 200.${NC}" >&2
    [ "$recycled" = 0 ] && echo -e "${YELLOW}    Retried 3x, 30s apart. A fresh private endpoint A-record can take ~10 min to appear.${NC}" >&2
    failed=1
  fi

  if [ "$failed" -ne 0 ]; then
    echo -e "${RED}✗ a live credential was lost. Restore it before anything else.${NC}" >&2
    exit 4
  fi
}

echo -e "${BLUE}DEMI infrastructure → ${ENVIRONMENT} (${RESOURCE_GROUP})${NC}"
require_secrets
run_deployment
assert_secrets_survived
echo -e "${GREEN}✓ done. App code deploys separately — see scripts/deploy-azure.sh.${NC}"
