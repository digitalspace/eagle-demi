#!/usr/bin/env bash
#
# Run a command with the app identity temporarily holding Search Service Contributor, then revoke.
#
# WHY THE GRANT IS TEMPORARY, since the obvious question is why not just leave it. The search data
# plane is private-endpoint-only, so the only thing that can reach it is code running inside the app
# container, and that code authenticates as `demi-identity-test` — the identity the INTERNET-FACING
# API runs as. A standing grant would let a bug or a compromise in the public API delete an index.
# That matters more here than it normally would: `chunks` is ~1.13M rows / ~3.95 GB, it is the only
# extracted copy, the backup is Periodic on an 8-HOUR retention, and the restore has never been
# tested. Granting a human's own account instead does not help — a laptop cannot reach the data
# plane at all.
#
# WHAT THIS FIXES is the hand-work, not the posture: three separate index changes have each done
# `az role assignment create` … work … `az role assignment delete` by hand, and the failure that
# costs something is a grant left standing because the middle step errored. The revoke runs from a
# trap, so it also fires on a failure, on Ctrl-C, and on a run-command call that dies mid-run.
#
# The app identity permanently holds **Search Index Data Contributor**, which covers DOCUMENTS and
# not DEFINITIONS. Creating or widening an index or an indexer needs **Search Service Contributor**
# (7ca78c08-252a-4471-8644-bb5ff32d4ba0). It is granted at the SERVICE scope, never the resource
# group. Revocability is not assumed: the `c4b0a8` ABAC condition restricts roleAssignments write
# and delete to six role GUIDs and this is on neither list, proven by a grant/revoke cycle.
#
# Usage — the command runs on THIS machine, so the usual shape is a run-command call onto the devbox:
#
#   scripts/with-search-admin.sh -- \
#     az vm run-command invoke -g c4b0a8-test-rg -n demi-devbox-test --command-id RunShellScript \
#     --scripts "sudo -u demi /usr/local/bin/demi-run 'cd /opt/eagle-demi && node src/scripts/apply-search-definitions.js --live --only projects'"
#
#   RG=c4b0a8-test-rg SERVICE=demi-search-test IDENTITY=demi-identity-test \
#     scripts/with-search-admin.sh -- <command>
#
# Usage 2 — `apply`, the same grant and revoke around the Function app's own apply route. No VM, and
# no ARM round trip per step, so the window is minutes rather than the better part of an hour:
#
#   ADMIN_API_KEY=... scripts/with-search-admin.sh apply --env test --only projects \
#     --datasources demi-projects-ds --live
#
# The route is POST /admin/search-definitions/apply through the APIM `/machine` path, which answers
# 202 with a job id; this polls the job until it stops moving, then revokes. ADMIN_API_KEY is the
# same admin key the rest of the tooling uses (deploy-infra.sh) and is never printed or put on a
# command line — it is handed to curl in a config file, because argv is readable by anything on
# the box. `/machine` also wants a subscription key: export APIM_SUBSCRIPTION_KEY when the gateway
# is enforcing one.
#
set -euo pipefail

# The `az` seam exists so the revoke-on-failure path is testable without touching a real tenant.
# A trap nobody can exercise is a trap nobody knows works.
AZ="${AZ:-az}"
# Same seam for the API half: `apply` is HTTP, and a test that cannot fake the calls cannot prove
# the revoke fires when the job fails.
CURL="${CURL:-curl}"

# Search Service Contributor. The built-in GUID is stable across clouds and tenants.
ROLE_ID='7ca78c08-252a-4471-8644-bb5ff32d4ba0'

MODE='command'
ENV_NAME='test'
ONLY=''
DATASOURCES=''
LIVE='false'
CHECK='false'

if [[ "${1:-}" == "apply" ]]; then
  MODE='apply'
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --env)         ENV_NAME="${2:-}"; shift 2 ;;
      # Repeatable or comma-separated, because both spellings are already in the operator's fingers
      # from apply-search-definitions.js and demi-devbox.sh.
      --only)        ONLY="${ONLY:+${ONLY},}${2:-}"; shift 2 ;;
      --datasources) DATASOURCES="${DATASOURCES:+${DATASOURCES},}${2:-}"; shift 2 ;;
      --live)        LIVE='true'; shift ;;
      --check)       CHECK='true'; shift ;;
      *) echo "with-search-admin: unknown apply option '$1'" >&2; exit 2 ;;
    esac
  done
  case "$ENV_NAME" in
    test|prod) ;;
    *) echo "with-search-admin: unknown --env '${ENV_NAME}', want test|prod" >&2; exit 2 ;;
  esac
else
  if [[ "${1:-}" == "--" ]]; then shift; fi
  if [[ $# -eq 0 ]]; then
    echo "usage: $0 -- <command...>" >&2
    echo "       $0 apply --env <test|prod> [--only a,b] [--datasources x,y] [--live] [--check]" >&2
    exit 2
  fi
fi

# Defaults are the test environment's, kept for the devbox flow, which has always been invoked with
# these exported by demi-devbox.sh. `apply --env prod` names the prod ones instead.
if [[ "$ENV_NAME" == 'prod' ]]; then
  SUBSCRIPTION="${SUBSCRIPTION:-be5924ac-1083-4a1b-be92-7b444882cfd9}"
  # The resource groups differ by environment (`c4b0a8-test-rg` vs `rg-demi-prod`), so the group is
  # read off the service rather than guessed. demi-devbox.sh resolves it the same way.
  RG="${RG:-$("$AZ" resource list --subscription "$SUBSCRIPTION" \
    --resource-type Microsoft.Search/searchServices \
    --query "[?name=='demi-search-prod'].resourceGroup | [0]" -o tsv)}"
else
  SUBSCRIPTION="${SUBSCRIPTION:-7897ceb1-9a86-4639-87d7-7f9ff67142b3}"
  RG="${RG:-c4b0a8-test-rg}"
fi
SERVICE="${SERVICE:-demi-search-${ENV_NAME}}"
IDENTITY="${IDENTITY:-demi-identity-${ENV_NAME}}"

if [[ -z "$RG" ]]; then
  echo "with-search-admin: could not resolve the resource group for ${SERVICE}" >&2
  exit 1
fi

# The gateway, not the app: direct azurewebsites.net access is platform-403'd since the APIM
# cutover, and the key is only accepted on the `/machine` path — `/api` is the anonymous one.
APIM_HOST="${APIM_HOST:-demi-apim-${ENV_NAME}.azure-api.net}"
API_BASE_URL="${API_BASE_URL:-https://${APIM_HOST}/machine}"
API_BASE_URL="${API_BASE_URL%/}"

# Check the key before granting. A window opened for a call that cannot authenticate is the worst
# of both: no work done, and the role standing for the length of the mistake.
if [[ "$MODE" == 'apply' && -z "${ADMIN_API_KEY:-}" ]]; then
  echo "with-search-admin: ADMIN_API_KEY is not exported — not granting anything." >&2
  echo "with-search-admin: read it from the vault on the devbox:" >&2
  echo "  az keyvault secret show --vault-name <vault> --name admin-api-key --query value -o tsv" >&2
  exit 2
fi

SCOPE="/subscriptions/${SUBSCRIPTION}/resourceGroups/${RG}/providers/Microsoft.Search/searchServices/${SERVICE}"

# `--subscription` explicitly: the scope string below names SUBSCRIPTION, and without this the
# identity is resolved in whatever subscription `az` happens to default to. Overriding SUBSCRIPTION
# alone would then grant on one subscription's scope to a same-named identity from another.
PRINCIPAL_ID="$("$AZ" identity show --subscription "$SUBSCRIPTION" -g "$RG" -n "$IDENTITY" \
  --query principalId -o tsv)"
if [[ -z "$PRINCIPAL_ID" ]]; then
  echo "with-search-admin: could not resolve principalId for $IDENTITY in $RG" >&2
  exit 1
fi

ASSIGNMENT_ID=''

# Revoke from a trap, so it runs on success, on failure, and on Ctrl-C. A grant left standing
# because the middle step died is the failure this script exists to prevent, and it is exactly the
# case a plain three-command sequence gets wrong.
#
# EXIT alone, not `EXIT INT TERM` — measured on bash 5.2.15: the EXIT trap runs on SIGTERM and on
# SIGINT too, so listing the signals adds nothing and makes the handler fire TWICE (once for the
# signal, once on the way out), which prints a spurious REVOKE FAILED on the second,
# already-deleted assignment. Adding them and then needing a `trap -` to undo the double-fire is a
# net loss.
revoke() {
  local status=$?
  rm -f "${CURL_CONFIG:-}"
  if [[ -n "$ASSIGNMENT_ID" ]]; then
    echo "with-search-admin: revoking" >&2
    # `|| true`: a failed revoke must not mask the command's own exit status, and it must still be
    # reported loudly rather than swallowed.
    "$AZ" role assignment delete --ids "$ASSIGNMENT_ID" >/dev/null 2>&1 || {
      echo "with-search-admin: REVOKE FAILED — remove it by hand:" >&2
      echo "  az role assignment delete --ids $ASSIGNMENT_ID" >&2
    }
  fi
  exit "$status"
}
trap revoke EXIT

echo "with-search-admin: granting Search Service Contributor on $SERVICE to $IDENTITY" >&2

# NO ID MEANS STOP, not "nothing to revoke". The trap keys on a non-empty ASSIGNMENT_ID, so a create
# that fails — or that exits 0 with empty stdout — would otherwise run the command and exit cleanly
# with the revoke a silent no-op, which is precisely the failure this script exists to prevent. And
# the grant may exist server-side even when the CLI errored (a write that lands, then the response
# is lost), so this cannot assume there is nothing to clean up: it says so and hands over the query.
if ! ASSIGNMENT_ID="$("$AZ" role assignment create \
  --role "$ROLE_ID" \
  --assignee-object-id "$PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --scope "$SCOPE" \
  --query id -o tsv)" || [[ -z "$ASSIGNMENT_ID" ]]; then
  ASSIGNMENT_ID=''
  echo "with-search-admin: the grant returned no assignment id — NOT running the command." >&2
  echo "with-search-admin: it may still have been created. Check, and remove it by hand:" >&2
  echo "  az role assignment list --scope $SCOPE \\" >&2
  echo "    --query \"[?roleDefinitionName=='Search Service Contributor'].id\" -o tsv" >&2
  exit 1
fi

# The grant is not readable the instant it is created. Poll rather than sleeping a guessed interval:
# a fixed sleep is either too short (the command 403s) or wastes time on every run.
readable=''
for _ in $(seq 1 "${POLL_TRIES:-20}"); do
  if "$AZ" role assignment list --scope "$SCOPE" --query "[?id=='${ASSIGNMENT_ID}'].id" -o tsv \
     2>/dev/null | grep -q .; then
    readable=1
    break
  fi
  sleep "${POLL_SLEEP:-3}"
done

# Say so rather than falling through silently. The command still runs — the grant exists, it is
# only unconfirmed, and refusing here would strand work behind a read that RBAC replication is
# often just slow about. But without this line the operator gets 60s of silence followed by a 403
# from the real command and no hint as to why.
if [[ -z "$readable" ]]; then
  echo "with-search-admin: grant not readable after ${POLL_TRIES:-20} tries — running anyway; a 403 below means" >&2
  echo "with-search-admin: RBAC has not replicated yet, not that the command is wrong." >&2
fi

if [[ "$MODE" != 'apply' ]]; then
  "$@"
  exit $?
fi

# ---------------------------------------------------------------------------------------------
# The apply route
#
# The app does the work the devbox used to do: it already holds SEARCH_ENDPOINT, it is inside the
# VNet, and with the grant above it can write definitions. What is left here is enqueue, wait,
# revoke. The wait matters — the role has to stay until the job stops, and go the moment it does.

# The key is handed over in a config file, never on the command line: argv shows up in /proc for
# every process on the box, and this key is long-lived.
CURL_CONFIG="$(mktemp)"
chmod 600 "$CURL_CONFIG"
{
  printf 'header = "X-Api-Key: %s"\n' "$ADMIN_API_KEY"
  # APIM stamps a subscription on the /machine path. Optional here: the gateway is not enforcing
  # one in every environment yet, and an empty header would be worse than none.
  if [[ -n "${APIM_SUBSCRIPTION_KEY:-}" ]]; then
    printf 'header = "Ocp-Apim-Subscription-Key: %s"\n' "$APIM_SUBSCRIPTION_KEY"
  fi
} > "$CURL_CONFIG"

# One field out of a JSON body. node, not jq: jq is not installed everywhere this runs, and the
# rest of scripts/ already reads JSON this way.
json_field() {
  node -e '
    let doc = {};
    try { doc = JSON.parse(process.argv[1]); } catch { doc = {}; }
    const value = doc[process.argv[2]];
    process.stdout.write(value == null ? "" : String(value));
  ' "$1" "$2"
}

# `-w` puts the status code on its own last line, so one call carries both halves and a 500 with a
# JSON error body is still readable.
http_json() {
  "$CURL" -sS --config "$CURL_CONFIG" -w '\n%{http_code}' \
    --max-time "${APPLY_HTTP_TIMEOUT:-120}" "$@"
}

BODY="$(ONLY="$ONLY" DATASOURCES="$DATASOURCES" LIVE="$LIVE" CHECK="$CHECK" node -e '
  const list = (value) => (value || "").split(",").map((v) => v.trim()).filter(Boolean);
  process.stdout.write(JSON.stringify({
    only: list(process.env.ONLY),
    datasources: list(process.env.DATASOURCES),
    live: process.env.LIVE === "true",
    check: process.env.CHECK === "true"
  }));
')"

echo "with-search-admin: POST ${API_BASE_URL}/admin/search-definitions/apply ${BODY}" >&2

RESPONSE="$(http_json -X POST -H 'Content-Type: application/json' --data "$BODY" \
  "${API_BASE_URL}/admin/search-definitions/apply")" || {
  echo "with-search-admin: the apply request did not complete" >&2
  exit 1
}
CODE="${RESPONSE##*$'\n'}"
RESPONSE="${RESPONSE%$'\n'*}"

if [[ "$CODE" != '202' && "$CODE" != '200' ]]; then
  echo "with-search-admin: the apply was refused (HTTP ${CODE})" >&2
  echo "  ${RESPONSE}" >&2
  exit 1
fi

JOB_ID="$(json_field "$RESPONSE" jobId)"
if [[ -z "$JOB_ID" ]]; then
  # Same reasoning as the empty assignment id above: an accepted request with no id cannot be
  # followed, so the only honest thing is to stop rather than revoke under a job that is running.
  echo "with-search-admin: the apply was accepted but named no job — it may still be running:" >&2
  echo "  ${RESPONSE}" >&2
  exit 1
fi

JOB_URL="${API_BASE_URL}/admin/search-definitions/jobs/${JOB_ID}"
echo "with-search-admin: job ${JOB_ID} — ${JOB_URL}" >&2

DEADLINE=$(( $(date +%s) + ${APPLY_TIMEOUT:-3600} ))
STATUS=''
while true; do
  POLL="$(http_json "$JOB_URL")" || {
    echo "with-search-admin: could not read ${JOB_URL} — the job may still be running." >&2
    exit 1
  }
  POLL_CODE="${POLL##*$'\n'}"
  POLL="${POLL%$'\n'*}"
  if [[ "$POLL_CODE" != '200' ]]; then
    echo "with-search-admin: job status returned HTTP ${POLL_CODE} — the job may still be running." >&2
    echo "  ${POLL}" >&2
    exit 1
  fi

  STATUS="$(json_field "$POLL" status)"
  case "$STATUS" in
    queued|running|pending|inProgress) ;;
    *) break ;;
  esac

  # Checked after the poll, so a job that finishes on the last tick is still read as finished.
  if (( $(date +%s) >= DEADLINE )); then
    echo "with-search-admin: job ${JOB_ID} is still ${STATUS} after ${APPLY_TIMEOUT:-3600}s — giving up and revoking." >&2
    echo "with-search-admin: it keeps running WITHOUT the role, so it will fail on its next write. Follow it:" >&2
    echo "  curl -H \"X-Api-Key: \$ADMIN_API_KEY\" ${JOB_URL}" >&2
    exit 1
  fi
  sleep "${APPLY_POLL_SLEEP:-15}"
done

case "$STATUS" in
  ready|succeeded|success|complete|completed|done)
    echo "with-search-admin: job ${JOB_ID} ${STATUS}" >&2
    ;;
  *)
    ERROR="$(json_field "$POLL" error)"
    echo "with-search-admin: job ${JOB_ID} ended ${STATUS}${ERROR:+ — ${ERROR}}" >&2
    exit 1
    ;;
esac
