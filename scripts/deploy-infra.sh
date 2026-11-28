#!/usr/bin/env bash
set -euo pipefail

# Bicep infrastructure deployment for DEMI.
# Usage: ./scripts/deploy-infra.sh [test|prod] [--what-if|--live] [--foundation]
#
# --what-if (default) applies nothing. --live applies; prod also needs CONFIRM_PROD=yes exported.
#
# Without --foundation only the application layer deploys (function app, devbox, secret sync,
# availability test). --foundation deploys everything; a foundation module change is applied only
# by a --foundation run, and an application-only --live run refuses when one changed since the last.
#
# Secret values are never read or written here: demi-kv-<env> holds them, and the script checks that
# every secret NAME the app resolves exists. Lengths are printed, never values.
# Run by hand, not from CI: the CI identity has no resource-group scope.
#
# Env: DEVBOX_SSH_PUBLIC_KEY (required when deployDevbox is on; read from OpenShift if unset),
#      ADMIN_API_KEY (optional; enables the live Key Vault reference probe), OC_CONTEXT (optional).
# Never test the guards by passing a junk value at a live environment; use --what-if.
#
# Exit codes: 0 done (or what-if shown); 1 vault read or deployment failed;
#   2 bad argument or prod not confirmed; 3 precondition refused (missing secret name or devbox key,
#   stale foundation); 4 a credential was lost or the app was left stopped;
#   5 infrastructure applied but a function the app settings turn on is not registered.

ENVIRONMENT='test'
MODE='--what-if'
# Set only by --foundation, never inherited from the environment.
DEPLOY_FOUNDATION='false'
export REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

if [ "$#" -gt 0 ] && [ "${1#--}" = "$1" ]; then
  ENVIRONMENT="$1"
  shift
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --what-if) MODE='--what-if' ;;
    --live) MODE='--live' ;;
    --foundation) DEPLOY_FOUNDATION='true' ;;
    *)
      echo -e "${RED}✗ unknown argument '$1'. Use: [test|prod] [--what-if|--live] [--foundation]${NC}" >&2
      exit 2
      ;;
  esac
  shift
done

# The bicepparam reads this with readEnvironmentVariable: `az` refuses a second --parameters beside
# a .bicepparam file, so an environment variable is the only way to pass the switch.
export DEPLOY_FOUNDATION

# Set only by require_vault_secrets, never inherited: false when the vault lacks this key.
EXTRACTION_JOB_KEY='extraction-job-api-key'
DEPLOY_EXTRACTION_JOB='true'
export DEPLOY_EXTRACTION_JOB

# shellcheck source-path=SCRIPTDIR source=lib/azure-env.sh
source "${REPO_ROOT}/scripts/lib/azure-env.sh"
if ! demi_azure_env "$ENVIRONMENT"; then
  echo -e "${RED}✗ unknown environment '${ENVIRONMENT}'. Use: test | prod${NC}" >&2
  exit 2
fi
case "$ENVIRONMENT" in
  test)
    # Direct azurewebsites.net access is 403'd by the platform; probe the gateway.
    APIM_HOST="demi-apim-${ENVIRONMENT}.azure-api.net"
    ;;
  prod)
    # No prod write context on this box: this read-only ServiceAccount context only reads the
    # devbox public key from 6cdc9e-prod. Export OC_CONTEXT to override.
    OC_CONTEXT='6cdc9e-prod/api-silver-devops-gov-bc-ca:6443/system:serviceaccount:6cdc9e-tools:github-cicd'
    ;;
esac

OC_CONTEXT="${OC_CONTEXT:-epic-${ENVIRONMENT}}"

# Deliberately an environment variable rather than a prompt: it survives a terminal with no TTY, and
# a stray keystroke cannot answer it.
if [ "$ENVIRONMENT" = 'prod' ] && [ "$MODE" = '--live' ] && [ "${CONFIRM_PROD:-}" != 'yes' ]; then
  echo -e "${RED}✗ refusing to apply to prod. Export CONFIRM_PROD=yes if that is what you mean.${NC}" >&2
  exit 2
fi

PARAM_FILE="${REPO_ROOT}/azure/main.${ENVIRONMENT}.bicepparam"

API_APP="demi-api-fc-${ENVIRONMENT}"
# Policy denies public network access to the vault, so only a machine inside the VNet can read it.
VAULT="demi-kv-${ENVIRONMENT}"
DEVBOX="demi-devbox-${ENVIRONMENT}"
KEY_VAULT_MODULE="${REPO_ROOT}/azure/modules/key-vault.bicep"
PROBE_HOST="${APIM_HOST:-${API_APP}.azurewebsites.net}"

# The foundation modules. An edit to one of these is only applied by a `--foundation` run, so the
# list is also what require_foundation_current checks the git history of.
FOUNDATION_MODULES=(
  azure/modules/identity.bicep
  azure/modules/key-vault.bicep
  azure/modules/cosmos-nosql.bicep
  azure/modules/observability.bicep
  azure/modules/audit-logs.bicep
  azure/modules/foundry.bicep
  azure/modules/ai-search.bicep
  azure/modules/search-existing.bicep
  azure/modules/apim.bicep
  azure/modules/static-site.bicep
  azure/modules/document-storage.bicep
  azure/modules/document-intake.bicep
  azure/modules/cost-budget.bicep
)

# Inputs that may affect either layer, so require_foundation_current only warns about them and
# never refuses.
FOUNDATION_INPUTS=(
  azure/main.bicep
  azure/main.test.bicepparam
  azure/main.prod.bicepparam
)

# Application mode has one more step: the foundation-currency check.
STEP=0
TOTAL_STEPS=6
[ "$DEPLOY_FOUNDATION" = 'true' ] || TOTAL_STEPS=7
step() {
  STEP=$((STEP + 1))
  echo -e "${BLUE}[${STEP}/${TOTAL_STEPS}] ${1}${NC}"
}

# Never point this at the app's own settings: a corrupted value would be fed straight back in, and
# ARM keeps no copy of @secure() parameters to recover from.
os_secret() {
  [ -n "$1" ] || return 0
  oc --context "$OC_CONTEXT" get secret "$1" -n "6cdc9e-${ENVIRONMENT}" \
    -o "jsonpath={.data.${2}}" 2>/dev/null | base64 -d 2>/dev/null || true
}

# Names come from `requiredSecretNames` (key-vault.bicep) and `optionalSecretNames` (param file).
# Both stop at the first `]`, so a one-line `= []` yields nothing instead of eating the file.
expected_secret_names() {
  awk '/^var requiredSecretNames *= *\[/{f=1} f{print; if (/\]/) exit}' "$KEY_VAULT_MODULE"
  awk '/^param optionalSecretNames *= *\[/{f=1} f{print; if (/\]/) exit}' "$PARAM_FILE"
}

# NAMES only: run-command output comes back to this terminal. Runs in --what-if too, since a missing
# name is missing either way; it starts the devbox, which is deallocated between sessions.
require_vault_secrets() {
  step "Checking ${VAULT} holds the names the app resolves…"

  local -a expected=()
  local name
  while read -r name; do
    [ -n "$name" ] && expected+=("$name")
  done < <(expected_secret_names | grep -o "'[a-z0-9-]*'" | tr -d "'")

  if [ "${#expected[@]}" -eq 0 ]; then
    echo -e "${RED}  ✗ no secret names found in ${KEY_VAULT_MODULE} — the check cannot run${NC}" >&2
    exit 3
  fi

  # The devbox may sit in a different resource group than the deployment, so read it from the VM.
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
  # `if var=$(cmd)`: under `set -e` a failing bare `listed=$(cmd)` aborts before `status=$?` runs.
  if listed=$(az vm run-command invoke --subscription "$SUBSCRIPTION" -g "$vm_rg" -n "$DEVBOX" \
    --command-id RunShellScript --only-show-errors \
    --scripts "sudo -u demi /usr/local/bin/demi-run 'az keyvault secret list --vault-name ${VAULT} --query \"[].name\" -o tsv'" \
    --query 'value[].message' -o tsv 2>/dev/null); then
    status=0
  else
    status=$?
  fi

  # A failed read is not an empty vault: with no line into the VNet the result is
  # ForbiddenByConnection, so report a broken check, not every secret missing.
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
    elif [ "$name" = "$EXTRACTION_JOB_KEY" ]; then
      # Only the job module reads this key, so its absence skips the job rather than the deploy.
      DEPLOY_EXTRACTION_JOB='false'
      echo -e "${YELLOW}  ! ${name} is not in ${VAULT} — skipping the extraction job module; every other module still deploys.${NC}"
      echo -e "${YELLOW}    Set it from ${DEVBOX} (az keyvault secret set) and re-run to deploy the job.${NC}"
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

# `${VAR:-…}`: an already-exported value wins, so a fresh environment with no OpenShift secret works.
# The param file reads the key with no fallback, so a missing one fails the build (BCP427).
require_secrets() {
  step "Sourcing the remaining template parameters…"

  # Only where the param file switches the VM on. Elsewhere the parameter is never evaluated.
  if ! grep -Eq '^param deployDevbox *= *true' "$PARAM_FILE"; then
    echo -e "${GREEN}  ✓ nothing to source — deployDevbox is off in ${PARAM_FILE##*/}${NC}"
    return 0
  fi

  DEVBOX_SSH_PUBLIC_KEY="${DEVBOX_SSH_PUBLIC_KEY:-$(os_secret demi-app-secrets DEVBOX_SSH_PUBLIC_KEY)}"

  # Trim the ENDS only: stripping every space breaks `<algorithm> <base64> [comment]`. Trim first so
  # " " counts as empty; `[ -z ]` alone passes a single space.
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

# The last foundation deployment's name carries the commit it ran from, the only record of what the
# foundation holds; `demi-cicd-*` has no resource-group read, so this cannot be a CI check.
require_foundation_current() {
  step "Checking the foundation is current…"

  # what-if applies nothing, so a stale foundation is a warning there and a refusal on --live.
  refuse_or_warn() {
    if [ "$MODE" = '--live' ]; then
      echo -e "${RED}    Refusing to apply. Run: ./scripts/deploy-infra.sh ${ENVIRONMENT} --foundation --live${NC}" >&2
      exit 3
    fi
    echo -e "${YELLOW}    what-if only, so this is a warning — --live refuses here. Run --foundation first.${NC}" >&2
  }

  # `az` deploys the working tree, so uncommitted or untracked edits apply in a --foundation run and
  # are dropped by an application one; git log cannot see them, git status can.
  local dirty inputs_dirty inputs_changed=''
  dirty=$(git -C "$REPO_ROOT" status --porcelain -- "${FOUNDATION_MODULES[@]}" 2>/dev/null || true)
  inputs_dirty=$(git -C "$REPO_ROOT" status --porcelain -- "${FOUNDATION_INPUTS[@]}" 2>/dev/null || true)

  local last sha='' changed
  last=$(az deployment group list -g "$RESOURCE_GROUP" --subscription "$SUBSCRIPTION" --only-show-errors \
    --query "[?starts_with(name, 'infra-fnd-') && properties.provisioningState=='Succeeded'] | sort_by(@, &properties.timestamp) | [-1].name" \
    -o tsv 2>/dev/null || true)

  if [ -n "$last" ] && [ "$last" != 'None' ]; then
    # infra-fnd-<sha>-<hhmmss>
    sha="${last#infra-fnd-}"
    sha="${sha%-*}"
    if [ "$sha" = 'manual' ] || ! git -C "$REPO_ROOT" cat-file -e "${sha}^{commit}" 2>/dev/null; then
      sha=''
    fi
  fi

  # Advisory, both modes: these files change for application work too, so a refusal here would
  # block ordinary app deploys. The reader is the one who knows which half an edit touched.
  if [ -n "$sha" ]; then
    inputs_changed=$(git -C "$REPO_ROOT" log --oneline "${sha}..HEAD" -- "${FOUNDATION_INPUTS[@]}" 2>/dev/null || true)
  fi
  if [ -n "$inputs_dirty" ] || [ -n "$inputs_changed" ]; then
    echo -e "${YELLOW}  ? main.bicep or a .bicepparam changed:${NC}" >&2
    [ -n "$inputs_changed" ] && sed 's/^/      /' <<<"$inputs_changed" >&2
    [ -n "$inputs_dirty" ] && sed 's/^...//; s/^/      uncommitted /' <<<"$inputs_dirty" >&2
    echo -e "${YELLOW}    If any of these touched a foundation module call, gate or lookup, run --foundation first.${NC}" >&2
  fi

  if [ -n "$dirty" ]; then
    echo -e "${RED}  ✗ foundation modules have uncommitted changes — az deploys the working tree:${NC}" >&2
    sed 's/^...//; s/^/      /' <<<"$dirty" >&2
    refuse_or_warn
    return 0
  fi

  if [ -z "$last" ] || [ "$last" = 'None' ]; then
    echo -e "${RED}  ✗ ${RESOURCE_GROUP} holds no successful infra-fnd-* deployment${NC}" >&2
    echo -e "${YELLOW}    Nothing has deployed the foundation from this template yet.${NC}" >&2
    refuse_or_warn
    return 0
  fi

  if [ -z "$sha" ]; then
    echo -e "${YELLOW}  ? ${last} names a commit this checkout does not hold — nothing to compare against.${NC}" >&2
    echo -e "${YELLOW}    Fetch that commit, or run --foundation.${NC}" >&2
    return 0
  fi

  changed=$(git -C "$REPO_ROOT" log --oneline "${sha}..HEAD" -- "${FOUNDATION_MODULES[@]}" 2>/dev/null || true)
  if [ -n "$changed" ]; then
    echo -e "${RED}  ✗ foundation modules changed since ${last} (${sha}):${NC}" >&2
    sed 's/^/      /' <<<"$changed" >&2
    refuse_or_warn
    return 0
  fi

  echo -e "${GREEN}  ✓ no foundation module changed since ${last}${NC}"
}

# The layer is in the deployment NAME: require_foundation_current reads it back to find which
# commit the foundation was last deployed from.
run_deployment() {
  local prefix='infra-app-'
  [ "$DEPLOY_FOUNDATION" = 'true' ] && prefix='infra-fnd-'
  local name="${prefix}$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo manual)-$(date -u +%H%M%S)"

  if [ "$MODE" = '--what-if' ]; then
    step "what-if against ${RESOURCE_GROUP}…"
    echo -e "${YELLOW}  Reminder: @secure() values render as '*******' in both before and after.${NC}"
    echo -e "${YELLOW}  A blanked credential is INVISIBLE here. That is what step 4 is for.${NC}"
    az deployment group what-if -g "$RESOURCE_GROUP" --subscription "$SUBSCRIPTION" \
      -f "${REPO_ROOT}/azure/main.bicep" -p "$PARAM_FILE" --only-show-errors
    exit 0
  fi

  step "Deploying ${name}…"
  az deployment group create -g "$RESOURCE_GROUP" --subscription "$SUBSCRIPTION" \
    -f "${REPO_ROOT}/azure/main.bicep" -p "$PARAM_FILE" -n "$name" --no-wait --only-show-errors

  # Poll the record, not the CLI exit code: --no-wait returns once ARM accepts the request, which
  # says nothing about the deployment succeeding.
  step "Waiting…"
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

# Catches a deploy that reports success while having emptied a credential.
assert_secrets_survived() {
  step "Verifying live app settings…"
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

  # Check the SHAPE, not the length: an unresolved `@Microsoft.KeyVault(SecretUri=...)` reference is
  # ~70 chars too. Only the live ADMIN_API_KEY probe below proves a reference resolves.
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

  # ADMIN_API_KEY stands in for all of them (same identity, same private endpoint): one 200 means the
  # set resolved. Export it by hand to run the probe; without it the reference stays unverified.
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
    # the platform reports the reference Resolved; only a stop/start re-reads it.
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

check_api_functions() {
  step "Checking the functions the app settings turn on are registered…"
  if ! "${REPO_ROOT}/scripts/check-api-functions.sh" "$ENVIRONMENT"; then
    echo -e "${RED}✗ infrastructure is applied, but a function is not registered. Re-run the code deploy named above.${NC}" >&2
    exit 5
  fi
}

LAYER='application layer only'
[ "$DEPLOY_FOUNDATION" = 'true' ] && LAYER='foundation and application'
echo -e "${BLUE}DEMI infrastructure → ${ENVIRONMENT} (${RESOURCE_GROUP}) — ${LAYER}${NC}"
require_vault_secrets
require_secrets
[ "$DEPLOY_FOUNDATION" = 'true' ] || require_foundation_current
run_deployment
assert_secrets_survived
check_api_functions
echo -e "${GREEN}✓ infrastructure done. App code deploys through the API workflow.${NC}"
