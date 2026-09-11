#!/usr/bin/env bash
set -euo pipefail

# Bicep infrastructure deployment for DEMI.
# Usage: ./scripts/deploy-infra.sh [test|prod] [--what-if|--live]
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
# `siteConfig.appSettings` in api-function-flex.bicep is a WHOLE-COLLECTION PUT: every setting the
# template does not supply is deleted from the running app. Some of them are secrets the template
# cannot derive, so a deploy has to be told them. That made the procedure a multi-command
# hand-export across two clouds, documented only in a comment, and getting it wrong overwrote the
# break-glass credential with an empty string.
#
# `what-if` could not warn about any of it: it masks @secure() values as "*******" in BOTH the
# before and the after, so a credential being blanked renders as no change at all.
#
# ── WHERE THE VALUES LIVE NOW ─────────────────────────────────────────────────────────────────
#
# `demi-kv-<env>` is the source of truth for every credential the app resolves by reference:
# admin-api-key, track-client-secret, role-sync-client-secret, docling-api-key, minio-access-key,
# minio-secret-key, the two analytics header values APIM stamps, and per environment notify-api-key
# and edge-secret. NOTHING here reads or writes those values. They are set once by hand from the
# devbox (`az keyvault secret set`), so an infrastructure deploy cannot blank one — the template
# has no parameter to blank. What this script does instead is check, before deploying, that the
# vault holds every NAME the app will ask for; a missing name is an app setting that silently never
# resolves.
#
# One guard remains for what is still a parameter — the devbox public key, which is not a
# credential. The .bicepparam file calls readEnvironmentVariable with NO fallback, so a missing
# export fails the build rather than deploying an empty string.
#
# ── SECRETS ───────────────────────────────────────────────────────────────────────────────────
#
# Lengths are printed, values never — and secret VALUES never leave the vault. The devbox check
# below lists NAMES only, because run-command output comes back to this terminal.
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
    # Direct azurewebsites.net access is platform-403'd since the APIM cutover; probe the gateway.
    APIM_HOST="demi-apim-${ENVIRONMENT}.azure-api.net"
    ;;
  prod)
    SUBSCRIPTION='be5924ac-1083-4a1b-be92-7b444882cfd9'
    RESOURCE_GROUP='rg-demi-prod'
    # This box has NO prod write context. The name below is the read-only ServiceAccount context
    # for this workspace, used here only to read the devbox public key out of 6cdc9e-prod. Export
    # it by hand to override.
    OC_CONTEXT='6cdc9e-prod/api-silver-devops-gov-bc-ca:6443/system:serviceaccount:6cdc9e-tools:github-cicd'
    ;;
  *)
    echo -e "${RED}✗ unknown environment '${ENVIRONMENT}'. Use: test | prod${NC}" >&2
    exit 2
    ;;
esac

# One name per environment because prod's is not "epic-prod" — there is no prod write context on
# this machine, only the read-only ServiceAccount one set above.
OC_CONTEXT="${OC_CONTEXT:-epic-${ENVIRONMENT}}"

# The object-store credentials are no longer read here. Prod's authoritative copy is still the
# platform team's `nr-object-store-credential` in 6cdc9e-prod (user_account / password), but it is
# copied into demi-kv-prod as minio-access-key / minio-secret-key once, and the app resolves the
# vault. Non-prod used to read `eagle-api-minio-keys`, an eagle-api secret DEMI had no claim on;
# nothing reads it here now either.

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

# The app this deployment writes: the Flex app is the only API app in every environment.
API_APP="demi-api-fc-${ENVIRONMENT}"
# The vault the app resolves its credentials from, and the only machine that can read it: policy
# denies public network access, so every caller has to sit inside the VNet.
VAULT="demi-kv-${ENVIRONMENT}"
DEVBOX="demi-devbox-${ENVIRONMENT}"
KEY_VAULT_MODULE="${REPO_ROOT}/azure/modules/key-vault.bicep"
PROBE_HOST="${APIM_HOST:-${API_APP}.azurewebsites.net}"

# Read one key out of an OpenShift secret. One caller is left: the devbox PUBLIC key, which is not
# a credential. Every credential this template used to carry now comes from the vault instead.
#
# Never point this at the app's own settings. An earlier version round-tripped ADMIN_API_KEY and
# DOCLING_API_KEY out of the live app settings, which sounds idempotent and is actually a loop: a
# deploy that reads the app's own settings will happily feed a corrupted value straight back into
# it, and there is then nothing left to recover from. That is not hypothetical — on 2026-08-13 a
# bad value reached the app that way and both credentials were permanently lost, because ARM does
# not retain @secure() parameters either.
#
# `|| true` so a missing secret is reported by the length check below with a useful message, rather
# than killing the script under `set -e` with an oc error.
os_secret() {
  [ -n "$1" ] || return 0
  oc --context "$OC_CONTEXT" get secret "$1" -n "6cdc9e-${ENVIRONMENT}" \
    -o "jsonpath={.data.${2}}" 2>/dev/null | base64 -d 2>/dev/null || true
}

# The names the app will resolve from the vault, read out of the templates rather than repeated
# here: the required set is the `requiredSecretNames` var in key-vault.bicep, the per-environment
# additions are `optionalSecretNames` in the param file. Both stop at the first `]`, so a `= []`
# on one line yields nothing instead of eating the rest of the file.
expected_secret_names() {
  awk '/^var requiredSecretNames *= *\[/{f=1} f{print; if (/\]/) exit}' "$KEY_VAULT_MODULE"
  awk '/^param optionalSecretNames *= *\[/{f=1} f{print; if (/\]/) exit}' "$PARAM_FILE"
}

# NAMES only, never values. run-command hands its output back to this terminal, and a secret in a
# terminal is a secret in a scrollback buffer.
#
# Runs in --what-if mode too: it is the gate, not a convenience, and a name that is missing is
# missing whether or not this run applies anything. It does start the devbox, which is deallocated
# between sessions.
require_vault_secrets() {
  echo -e "${BLUE}[1/5] Checking ${VAULT} holds the names the app resolves…${NC}"

  local -a expected=()
  local name
  while read -r name; do
    [ -n "$name" ] && expected+=("$name")
  done < <(expected_secret_names | grep -o "'[a-z0-9-]*'" | tr -d "'")

  if [ "${#expected[@]}" -eq 0 ]; then
    echo -e "${RED}  ✗ no secret names found in ${KEY_VAULT_MODULE} — the check cannot run${NC}" >&2
    exit 3
  fi

  # The devbox and the vault do not have to share the deployment's resource group, so the VM's
  # group is read from the VM rather than assumed.
  local vm_rg
  vm_rg=$(az resource list -n "$DEVBOX" --resource-type Microsoft.Compute/virtualMachines \
    --subscription "$SUBSCRIPTION" --query '[0].resourceGroup' -o tsv --only-show-errors 2>/dev/null || true)
  if [ -z "$vm_rg" ]; then
    echo -e "${RED}  ✗ ${DEVBOX} not found in subscription ${SUBSCRIPTION}${NC}" >&2
    echo -e "${YELLOW}    ${VAULT} denies public network access, so the check has to run inside the VNet.${NC}" >&2
    echo -e "${YELLOW}    Deploy the devbox (deployDevbox = true in ${PARAM_FILE##*/}) or run the list by hand from one.${NC}" >&2
    exit 3
  fi

  # Idempotent, and it returns once the VM is running: a schedule stops the box at 19:00 Pacific.
  az vm start --subscription "$SUBSCRIPTION" -g "$vm_rg" -n "$DEVBOX" -o none

  local listed status bad_line
  # `if var=$(cmd)` rather than a bare assignment: under `set -e` a bare `listed=$(cmd)` that fails
  # would abort the script before `status=$?` ever ran, which is the same swallow this replaces.
  if listed=$(az vm run-command invoke --subscription "$SUBSCRIPTION" -g "$vm_rg" -n "$DEVBOX" \
    --command-id RunShellScript --only-show-errors \
    --scripts "sudo -u demi /usr/local/bin/demi-run 'az keyvault secret list --vault-name ${VAULT} --query \"[].name\" -o tsv'" \
    --query 'value[].message' -o tsv 2>/dev/null); then
    status=0
  else
    status=$?
  fi

  # A failed read must never be read as an empty vault: an owner with no line into the VNet gets
  # ForbiddenByConnection, not an empty list, and that has to be reported as a broken check, not as
  # every secret missing.
  bad_line=$(grep -m1 -E 'ForbiddenByConnection|AuthorizationFailed|ERROR' <<<"$listed" || true)
  if [ "$status" -ne 0 ] || [ -n "$bad_line" ]; then
    echo -e "${RED}  ✗ reading ${VAULT} from ${DEVBOX} failed${NC}" >&2
    [ -n "$bad_line" ] && echo -e "${RED}    ${bad_line}${NC}" >&2
    echo -e "${YELLOW}    That read has to run inside the VNet — this is not a missing-secret result.${NC}" >&2
    exit 1
  fi

  local -a absent=()
  for name in "${expected[@]}"; do
    if grep -qx -- "$name" <<<"$listed"; then
      echo -e "${GREEN}  ✓ ${name}${NC}"
    else
      absent+=("$name")
    fi
  done

  if [ "${#absent[@]}" -ne 0 ]; then
    for name in "${absent[@]}"; do
      echo -e "${RED}  ✗ ${name} is not in ${VAULT}${NC}" >&2
    done
    cat >&2 <<EOF

Refusing to deploy. The app resolves each of those names as
@Microsoft.KeyVault(SecretUri=...); one that is not in the vault leaves the app setting unresolved,
which reads as an empty credential at runtime and reports no error at deploy time.

Set the missing values ONCE, by hand, from ${DEVBOX} — never through git, a workflow input or a
template parameter:

  az vm run-command invoke -g ${vm_rg} -n ${DEVBOX} --command-id RunShellScript \\
    --scripts "sudo -u demi /usr/local/bin/demi-run 'az keyvault secret set --vault-name ${VAULT} --name <name> --value <value>'"

Or SSH to the box and run the \`az keyvault secret set\` directly, which keeps the value out of this
terminal. Rotation is the same command: a new version, then recycle the app.
EOF
    exit 3
  fi
}

# `${VAR:-…}` and not a bare assignment, deliberately: an already-exported value always wins. That
# is what makes a FRESH environment work, where the OpenShift secret does not exist yet and the
# operator supplies the value instead.
#
# ONE parameter is left to source. Every credential the app reads now comes from the vault, checked
# by name in step 1; what remains is the devbox PUBLIC key, which the param file reads with no
# fallback, so a missing one fails the bicep build with BCP427 rather than deploying a blank.
require_secrets() {
  echo -e "${BLUE}[2/5] Sourcing the remaining template parameters…${NC}"

  # Only where the param file switches the VM on. Elsewhere the parameter is never evaluated.
  if ! grep -Eq '^param deployDevbox *= *true' "$PARAM_FILE"; then
    echo -e "${GREEN}  ✓ nothing to source — deployDevbox is off in ${PARAM_FILE##*/}${NC}"
    return 0
  fi

  DEVBOX_SSH_PUBLIC_KEY="${DEVBOX_SSH_PUBLIC_KEY:-$(os_secret demi-app-secrets DEVBOX_SSH_PUBLIC_KEY)}"

  # Trim the ENDS only: the key is `<algorithm> <base64> [comment]`, and stripping every space
  # hands Compute a one-field string ARM rejects. Trimming first makes " " empty rather than a
  # one-character value — `[ -z ]` alone passes a single space, which is how a throwaway test value
  # once reached a real deployment.
  DEVBOX_SSH_PUBLIC_KEY="$(printf '%s' "$DEVBOX_SSH_PUBLIC_KEY" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  export DEVBOX_SSH_PUBLIC_KEY

  local ok=1
  if [ -z "$DEVBOX_SSH_PUBLIC_KEY" ]; then
    echo -e "${RED}  ✗ DEVBOX_SSH_PUBLIC_KEY is empty${NC}" >&2
    ok=0
  elif ! printf '%s' "$DEVBOX_SSH_PUBLIC_KEY" | grep -Eq '^ssh-(ed25519|rsa) '; then
    # A private key, a path, or a mangled value all fail at ARM instead; say so here.
    echo -e "${RED}  ✗ DEVBOX_SSH_PUBLIC_KEY is not an OpenSSH public key — expected 'ssh-ed25519 …' or 'ssh-rsa …'${NC}" >&2
    ok=0
  fi

  if [ "$ok" -ne 1 ]; then
    cat >&2 <<EOF

Refusing to deploy: deployDevbox is on and the key the VM is built with is missing or malformed.

  DEVBOX_SSH_PUBLIC_KEY                    OpenShift secret demi-app-secrets in 6cdc9e-${ENVIRONMENT}
                                           (a PUBLIC key — 'ssh-keygen -t ed25519' and store the
                                           .pub, or export it by hand)

Check 'oc --context ${OC_CONTEXT}' works, or export the value and re-run.
EOF
    exit 3
  fi

  echo -e "${GREEN}  ✓ DEVBOX_SSH_PUBLIC_KEY${NC} (${#DEVBOX_SSH_PUBLIC_KEY} chars)"
}

run_deployment() {
  local name="infra-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo manual)-$(date -u +%H%M%S)"

  if [ "$MODE" = '--what-if' ]; then
    echo -e "${BLUE}[3/5] what-if against ${RESOURCE_GROUP}…${NC}"
    echo -e "${YELLOW}  Reminder: @secure() values render as '*******' in both before and after.${NC}"
    echo -e "${YELLOW}  A blanked credential is INVISIBLE here. That is what step 4 is for.${NC}"
    az deployment group what-if -g "$RESOURCE_GROUP" --subscription "$SUBSCRIPTION" \
      -f "${REPO_ROOT}/azure/main.bicep" -p "$PARAM_FILE" --only-show-errors
    exit 0
  fi

  echo -e "${BLUE}[3/5] Deploying ${name}…${NC}"
  az deployment group create -g "$RESOURCE_GROUP" --subscription "$SUBSCRIPTION" \
    -f "${REPO_ROOT}/azure/main.bicep" -p "$PARAM_FILE" -n "$name" --no-wait --only-show-errors

  # Poll the record rather than trusting the CLI's exit code, for the same reason deploy-azure.sh
  # does: --no-wait returns as soon as ARM accepts the request, which is not the same fact as the
  # deployment succeeding.
  echo -e "${BLUE}[4/5] Waiting…${NC}"
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
  echo -e "${BLUE}[5/5] Verifying live app settings…${NC}"
  local failed=0 len value
  # The one plain setting worth asserting: absent, src/seed/sources.js silently repoints this
  # environment's seed at eagle-DEV.
  len=$(az webapp config appsettings list -n "$API_APP" -g "$RESOURCE_GROUP" \
    --subscription "$SUBSCRIPTION" --only-show-errors \
    --query "[?name=='EAGLE_API_BASE'] | [0].value | length(@)" -o tsv 2>/dev/null || echo 0)
  if [ -z "$len" ] || [ "$len" = '0' ] || [ "$len" = 'None' ]; then
    echo -e "${RED}  ✗ EAGLE_API_BASE is EMPTY or ABSENT on ${API_APP}${NC}" >&2
    failed=1
  else
    echo -e "${GREEN}  ✓ EAGLE_API_BASE${NC} (${len} chars)"
  fi

  # The credential settings are not length-checked: each one is the literal
  # `@Microsoft.KeyVault(SecretUri=...)` reference (~70 chars) whether or not it resolves, so a
  # length check passes on a dead reference. Assert the SHAPE instead — that catches a template
  # regression writing a literal or a blank back over one — and prove that a reference actually
  # resolves with the live ADMIN_API_KEY probe below, which is the only check that can.
  for name in ADMIN_API_KEY DOCLING_API_KEY MINIO_ACCESS_KEY MINIO_SECRET_KEY TRACK_CLIENT_SECRET KEYCLOAK_ADMIN_CLIENT_SECRET; do
    value=$(az webapp config appsettings list -n "$API_APP" -g "$RESOURCE_GROUP" \
      --subscription "$SUBSCRIPTION" --only-show-errors \
      --query "[?name=='${name}'] | [0].value" -o tsv 2>/dev/null || echo '')
    case "$value" in
      '@Microsoft.KeyVault(SecretUri='*)
        echo -e "${GREEN}  ✓ ${name}${NC} (Key Vault reference)" ;;
      *)
        echo -e "${RED}  ✗ ${name} on ${API_APP} is not a Key Vault reference${NC}" >&2
        failed=1 ;;
    esac
  done

  # ADMIN_API_KEY stands in for all of them in the probe: they resolve through the same identity
  # over the same private endpoint, so one 200 says the whole set resolved.
  #
  # The value is no longer sourced for you — it lives in the vault and nothing here reads it. Export
  # ADMIN_API_KEY by hand to run the probe. Without it the deploy still succeeds and the reference
  # is still unverified, which is worth saying out loud rather than passing silently.
  if [ -z "${ADMIN_API_KEY:-}" ]; then
    echo -e "${YELLOW}  ADMIN_API_KEY not exported — skipping the live probe.${NC}"
    echo -e "${YELLOW}    Nothing has checked that the Key Vault reference resolves. Read the value${NC}"
    echo -e "${YELLOW}    from ${DEVBOX} (az keyvault secret show --vault-name ${VAULT} --name admin-api-key),${NC}"
    echo -e "${YELLOW}    export it, and re-run to close that gap.${NC}"
    if [ "$failed" -ne 0 ]; then
      echo -e "${RED}✗ a live credential was lost. Restore it before anything else.${NC}" >&2
      exit 4
    fi
    return 0
  fi

  local code attempt
  local recycled=0
  probe_admin_key() {
    curl -s -o /dev/null -w '%{http_code}' --max-time 60 \
      -H "X-Api-Key: ${ADMIN_API_KEY}" \
      "https://${PROBE_HOST}/api/db/stats" 2>/dev/null || echo 000
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
require_vault_secrets
require_secrets
run_deployment
assert_secrets_survived
echo -e "${GREEN}✓ done. App code deploys separately — see scripts/deploy-azure.sh.${NC}"
