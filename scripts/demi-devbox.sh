#!/usr/bin/env bash
#
# Search drift check and apply for `demi-search-<env>`, driven from a workstation.
#
# WHAT PROBLEM THIS SOLVES. The search data plane is `publicNetworkAccess: Disabled`, so every
# definition read or write has to run on the devbox (`demi-devbox-<env>`) as the app's managed
# identity, and that identity only holds Search Index Data Contributor — definitions need a
# temporary Search Service Contributor grant, which can only be made from OUTSIDE the VM because a
# user-assigned identity cannot assign a role to itself. So the operation is always three machines
# deep: workstation grants, ARM run-command carries the command, devbox runs it. Three index
# changes have each assembled that by hand from `azure/search/README.md`, and on 2026-09-08 a prod
# `documents` index that was never widened took public Document search down for 65 minutes because
# nothing was running the check that would have caught it.
#
#   scripts/demi-devbox.sh drift --env prod
#   scripts/demi-devbox.sh apply --env prod --only documents
#   scripts/demi-devbox.sh apply --env test --only projects --yes
#
# `drift` is read-only and exits 1 when any committed field is missing from the live index. `apply`
# always dry-runs first, prints what it would do, and asks before writing.
#
# WHAT `apply` DOES, in the order `azure/search/README.md` says these have to happen:
#
#   1. `apply-search-definitions.js --live` — PUT the index, then the indexer.
#   2. `put-search-datasources.js` for the data sources whose committed `SELECT` differs from the
#      live one, and ONLY those. The apply script deliberately never writes a data source, so
#      without this step a widened index keeps being filled by the old column list, every new field
#      stays null, and nothing reports an error.
#   3. Reset and run each of those data sources' indexers, because the `_ts` high-water mark means a
#      schema-only change re-pulls nothing. The reset is refused while an execution is in progress:
#      a `PT5M` tick that was already running writes its old high-water mark back when it finishes
#      and silently undoes the clear (hit 2026-09-07).
#
# WHY THE SUBSCRIPTION IDS ARE THE ONLY HARDCODED VALUES. Everything else is looked up at runtime —
# the resource group comes from the search service, the VM's group from the VM, the tenant from the
# subscription, the indexer identity from the search service itself — so a resource that moved
# groups does not turn into a wrong-scope grant. A subscription id has nothing above it to be
# derived from: `az account list` names are not stable enough to match on. They are resource
# identifiers, not credentials.
#
# ENV VARS: `DEVBOX_RUNNER` (path to an external `run --env <env> -- <command>` wrapper; when unset
# this calls `az vm run-command invoke` itself), `DEVBOX_CHECKOUT` (default `/opt/eagle-demi`),
# `DS_RG` (Cosmos account's resource group, only needed when the subscription holds more than one
# account), `INDEXER_POLL_SLEEP`, `INDEXER_TIMEOUT`, `AZ` (the `az` seam the tests drive).
set -euo pipefail

AZ="${AZ:-az}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
WITH_SEARCH_ADMIN="${WITH_SEARCH_ADMIN:-${SCRIPT_DIR}/with-search-admin.sh}"

# An external wrapper is used only when the operator names one. A path baked in here would be a
# path on one person's machine, and this repo is public.
DEVBOX_RUNNER="${DEVBOX_RUNNER:-}"
# `/opt/eagle-demi` is a shallow git clone made at first boot, not a deploy — so the committed
# definitions, including `azure/search/datasources/`, are already there. That is why the deploy
# package does not have to carry them.
DEVBOX_CHECKOUT="${DEVBOX_CHECKOUT:-/opt/eagle-demi}"

# Not POLL_SLEEP: with-search-admin.sh reads that name for its own RBAC-replication poll, and this
# script runs inside it.
INDEXER_POLL_SLEEP="${INDEXER_POLL_SLEEP:-30}"
INDEXER_TIMEOUT="${INDEXER_TIMEOUT:-1800}"

ENV_NAME='test'
ONLY=''
ASSUME_YES=0
DATASOURCES=''

usage() {
  cat <<'EOF'
Usage: scripts/demi-devbox.sh <drift|apply> [--env test|prod] [--only <index,...>] [--yes]

  drift    read-only: run apply-search-definitions.js --check on the devbox and exit 1 when a
           committed field is missing from the live index. Run it after any deploy that touches
           azure/search/ or search code, and before a prod release.
  apply    dry-run, print, confirm, then PUT the indexes, PUT the data sources whose committed
           SELECT differs, and reset + run those indexers. --yes skips the prompt.

  --env    test (default) or prod
  --only   index or indexer names, comma separated: documents, projects, chunks
  --yes    do not prompt before the writing half of `apply`

Env    Subscription                            Search service      Devbox
test   7897ceb1-9a86-4639-87d7-7f9ff67142b3    demi-search-test    demi-devbox-test
prod   be5924ac-1083-4a1b-be92-7b444882cfd9    demi-search-prod    demi-devbox-prod

Resource groups, the tenant and the indexer identity are read with `az` at runtime.
Background: azure/search/README.md, docs/runbook-search-outage.md.
EOF
}

die() { echo "demi-devbox: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------------------------
# Environment table

resolve_env() {
  case "$ENV_NAME" in
    test) SUBSCRIPTION='7897ceb1-9a86-4639-87d7-7f9ff67142b3' ;;
    prod) SUBSCRIPTION='be5924ac-1083-4a1b-be92-7b444882cfd9' ;;
    *) die "unknown --env '${ENV_NAME}', want test|prod" ;;
  esac

  SERVICE="demi-search-${ENV_NAME}"
  IDENTITY="demi-identity-${ENV_NAME}"
  VM="demi-devbox-${ENV_NAME}"

  # The groups are NOT the same in both environments (`c4b0a8-test-rg` vs `rg-demi-prod`) and the
  # search service and the VM do not have to share one, so each is read from the resource itself.
  RG="$("$AZ" resource list --subscription "$SUBSCRIPTION" \
    --resource-type Microsoft.Search/searchServices \
    --query "[?name=='${SERVICE}'].resourceGroup | [0]" -o tsv)"
  [[ -n "$RG" ]] || die "no search service '${SERVICE}' in subscription ${SUBSCRIPTION}"

  VM_RG="$("$AZ" resource list --subscription "$SUBSCRIPTION" \
    --resource-type Microsoft.Compute/virtualMachines \
    --query "[?name=='${VM}'].resourceGroup | [0]" -o tsv)"
  [[ -n "$VM_RG" ]] || die "devbox VM '${VM}' not found in subscription ${SUBSCRIPTION} — every command here runs on it, so nothing can proceed without it"

  TENANT="$("$AZ" account show --subscription "$SUBSCRIPTION" --query tenantId -o tsv)"
  SCOPE="/subscriptions/${SUBSCRIPTION}/resourceGroups/${RG}/providers/Microsoft.Search/searchServices/${SERVICE}"

  echo "demi-devbox: env=${ENV_NAME} rg=${RG} service=${SERVICE} vm=${VM} (rg ${VM_RG})" >&2
}

# The grant is `az role assignment create`, which is a Graph-scoped call. An `az` session whose
# Graph refresh token has expired does not fail there: the create returns nothing useful,
# with-search-admin.sh prints "grant not readable after 20 tries", runs the command anyway, and the
# devbox answers 403 — an hour of looking at the wrong layer. One read first settles it.
preflight_rbac() {
  local err
  if err="$("$AZ" role assignment list --subscription "$SUBSCRIPTION" --scope "$SCOPE" \
      --query "[0].id" -o tsv 2>&1 >/dev/null)"; then
    return 0
  fi
  echo "demi-devbox: this az login cannot read role assignments at ${SCOPE}" >&2
  echo "demi-devbox: ${err}" >&2
  echo "demi-devbox: log in again with a Graph scope, then re-run:" >&2
  echo "  az login --tenant ${TENANT} --scope \"https://graph.microsoft.com//.default\"" >&2
  exit 1
}

# ---------------------------------------------------------------------------------------------
# Running a command on the devbox

# run-command drops the remote exit code — `value[].message` is stdout and stderr, nothing else —
# so every command carries its own status back in a line the caller greps for.
remote_script() {
  printf 'cd %s && { %s ; }; echo DEMI_EXIT=$?' "$DEVBOX_CHECKOUT" "$1"
}

remote_ok() { grep -q 'DEMI_EXIT=0' <<<"$1"; }

devbox_run() {
  local cmd="$1" out script
  script="$(remote_script "$cmd")"
  if [[ -n "$DEVBOX_RUNNER" ]]; then
    out="$("$DEVBOX_RUNNER" run --env "$ENV_NAME" -- "$script")" || return 1
  else
    # Idempotent, and it returns once the VM is running: the box is deallocated between sessions
    # and a schedule stops it at 19:00 Pacific.
    "$AZ" vm start --subscription "$SUBSCRIPTION" -g "$VM_RG" -n "$VM" >/dev/null
    local escaped="${script//\'/\'\\\'\'}"
    out="$("$AZ" vm run-command invoke --subscription "$SUBSCRIPTION" -g "$VM_RG" -n "$VM" \
      --command-id RunShellScript \
      --scripts "sudo -u demi /usr/local/bin/demi-run '${escaped}'" \
      --query "value[].message" -o tsv)" || return 1
  fi
  printf '%s\n' "$out"
}

# with-search-admin.sh grants Search Service Contributor at the service scope, runs what it is
# given, and revokes from a trap. Re-entering this script under it is what keeps ONE grant open
# across the whole apply — the indexer poll needs it too, because `status` is a definition read.
with_grant() {
  # `rg` copy: with-search-admin.sh reads RG, and this run also passes the same value on as DEMI_RG
  # for the re-entered process, so neither assignment may expand the other.
  local rg="$RG"
  DEMI_DEVBOX_INTERNAL=1 DEMI_RG="$rg" DEMI_VM_RG="$VM_RG" DEMI_TENANT="$TENANT" \
    SUBSCRIPTION="$SUBSCRIPTION" RG="$rg" SERVICE="$SERVICE" IDENTITY="$IDENTITY" \
    "$WITH_SEARCH_ADMIN" -- "$@"
}

# ---------------------------------------------------------------------------------------------
# Committed definitions, read from this checkout

# The indexer files are the only place that maps a data source to the indexer that reads it.
indexer_for_datasource() {
  local ds="$1" f
  for f in "${REPO_ROOT}"/azure/search/indexers/*.json; do
    if grep -qF "\"dataSourceName\": \"${ds}\"" "$f"; then
      sed -n 's/.*"name": "\([^"]*\)".*/\1/p' "$f" | head -1
      return 0
    fi
  done
  return 1
}

# The names a run touches, one per line — and ONE EMPTY LINE when the operator named none, which
# is what makes the caller's loop run exactly once with no `--only` flag. A bare `$(...)` in a for
# loop drops that empty word and the run silently does nothing, so callers read this with mapfile.
only_args() {
  local part
  local -a parts=()
  if [[ -z "$ONLY" ]]; then printf '%s\n' ''; return; fi
  IFS=',' read -r -a parts <<<"$ONLY"
  for part in "${parts[@]}"; do
    [[ -n "$part" ]] && printf '%s\n' "$part"
  done
}

# ---------------------------------------------------------------------------------------------
# drift

do_drift() {
  resolve_env
  preflight_rbac
  local out
  out="$(with_grant "$0" __drift-run --env "$ENV_NAME" ${ONLY:+--only "$ONLY"})" || true
  printf '%s\n' "$out"
  if ! remote_ok "$out"; then
    die "drift detected, or the check itself failed — see the output above"
  fi
  echo "demi-devbox: no drift on ${SERVICE}"
}

# Runs on this machine, inside the grant, one hop from the devbox.
internal_drift_run() {
  local only cmd out rc=0
  local -a onlies=()
  mapfile -t onlies < <(only_args)
  for only in "${onlies[@]}"; do
    cmd="git pull --ff-only && node src/scripts/apply-search-definitions.js --check${only:+ --only $only}"
    out="$(devbox_run "$cmd")" || rc=1
    printf '%s\n' "$out"
    remote_ok "$out" || rc=1
  done
  return "$rc"
}

# ---------------------------------------------------------------------------------------------
# apply

do_apply() {
  resolve_env
  preflight_rbac

  local dry_log
  dry_log="$(mktemp)"
  # The dry run reads the LIVE schema, which the app identity cannot do on its own, so even the
  # read-only half runs under a grant. It is a separate grant from the writing half below: the
  # prompt in between can sit unanswered for as long as the operator likes, and a grant should not
  # wait on a human.
  with_grant "$0" __dry-run --env "$ENV_NAME" ${ONLY:+--only "$ONLY"} | tee "$dry_log" || true
  local dry
  dry="$(cat "$dry_log")"
  rm -f "$dry_log"
  remote_ok "$dry" || die "the dry run failed — nothing was written"

  # The dry run names every data source whose live SELECT differs from the committed copy. Parsed
  # from its output rather than re-derived here: the comparison needs the LIVE query, and only the
  # devbox can read it.
  local differing
  # `|| true`: no match is the ordinary case, and under pipefail an empty grep would end the run.
  differing="$(grep -o 'data source [A-Za-z0-9-]* DIFFERS' <<<"$dry" | awk '{print $3}' | sort -u | paste -sd, - || true)"

  local resets=''
  if [[ -n "$differing" ]]; then
    local ds indexer
    for ds in ${differing//,/ }; do
      indexer="$(indexer_for_datasource "$ds")" \
        || die "no committed indexer reads data source ${ds}"
      resets="${resets:+${resets},}${indexer}"
    done
  fi

  echo ''
  echo "About to write to ${SERVICE} (${ENV_NAME}):"
  echo "  - PUT the committed indexes and indexers${ONLY:+ (--only ${ONLY})}"
  if [[ -n "$differing" ]]; then
    echo "  - PUT data source(s): ${differing}"
    echo "  - reset and run indexer(s): ${resets}"
    if [[ ",${resets}," == *",chunks-indexer,"* ]]; then
      echo "  !! chunks-indexer re-pulls ~1.1M rows and takes hours. --only documents or --only"
      echo "     projects if that is not what you meant."
    fi
  else
    echo "  - no data source differs, so no indexer reset"
  fi

  if [[ "$ASSUME_YES" -ne 1 ]]; then
    local answer=''
    read -r -p "Proceed? [y/N] " answer || answer=''
    [[ "$answer" == "y" || "$answer" == "Y" ]] || die "aborted — nothing was written"
  fi

  with_grant "$0" __apply-run --env "$ENV_NAME" ${ONLY:+--only "$ONLY"} --datasources "$differing"
}

internal_dry_run() {
  local only cmd out rc=0
  local -a onlies=()
  mapfile -t onlies < <(only_args)
  for only in "${onlies[@]}"; do
    cmd="git pull --ff-only && node src/scripts/apply-search-definitions.js${only:+ --only $only}"
    out="$(devbox_run "$cmd")" || rc=1
    printf '%s\n' "$out"
    remote_ok "$out" || rc=1
  done
  return "$rc"
}

# The Cosmos account's group and the identity the search service runs its indexers as. Read here
# rather than passed in, because put-search-datasources.js writes the literal string "undefined"
# into a data source when either is missing and the indexer then fails on its next run.
resolve_datasource_env() {
  local groups
  if [[ -n "${DS_RG:-}" ]]; then
    COSMOS_RG="$DS_RG"
  else
    mapfile -t groups < <("$AZ" resource list --subscription "$SUBSCRIPTION" \
      --resource-type Microsoft.DocumentDB/databaseAccounts --query "[].resourceGroup" -o tsv)
    [[ "${#groups[@]}" -eq 1 ]] \
      || die "found ${#groups[@]} Cosmos accounts in ${SUBSCRIPTION}; set DS_RG to the one COSMOS_ENDPOINT names"
    COSMOS_RG="${groups[0]}"
  fi

  DS_IDENTITY_ID="$("$AZ" resource show --subscription "$SUBSCRIPTION" -g "$RG" -n "$SERVICE" \
    --resource-type Microsoft.Search/searchServices \
    --query "keys(identity.userAssignedIdentities)[0]" -o tsv)"
  [[ -n "$DS_IDENTITY_ID" ]] \
    || die "${SERVICE} has no user-assigned identity; a data source PUT without one breaks the indexer"
}

put_datasources() {
  local list="$1" ds copies=''
  resolve_datasource_env
  # DS_DIR at a temp copy holding ONLY the files that differ. put-search-datasources.js PUTs
  # everything in the directory it is given, and `--only documents` must not rewrite the chunks
  # data source on the way past.
  for ds in ${list//,/ }; do
    copies="${copies} azure/search/datasources/${ds}.json"
  done
  local cmd out
  cmd="rm -rf /tmp/demi-ds && mkdir -p /tmp/demi-ds && cp${copies} /tmp/demi-ds/ && \
DS_SUB='${SUBSCRIPTION}' DS_RG='${COSMOS_RG}' DS_IDENTITY_ID='${DS_IDENTITY_ID}' DS_DIR=/tmp/demi-ds \
node src/scripts/put-search-datasources.js"
  out="$(devbox_run "$cmd")" || true
  printf '%s\n' "$out"
  remote_ok "$out" || die "the data source PUT failed — the indexes are widened but the columns are not projected"
}

indexer_status() {
  local name="$1" out
  # Read `executionHistory[0]`, never the top-level `status`: that reads `running` the whole time
  # the indexer is enabled on its schedule, reset or no reset.
  local js='const n=process.argv[1];
const ai=require("./src/search/ai-search");
const ep=(process.env.SEARCH_ENDPOINT||"").replace(/\/+$/,"");
ai.getToken().then(async (t)=>{
  const r=await fetch(ep+"/indexers/"+n+"/status?api-version=2024-07-01",{headers:{Authorization:"Bearer "+t}});
  if(r.status!==200){console.log("STATUS=http"+r.status);process.exit(1);}
  const j=await r.json();
  const e=(j.executionHistory||[])[0]||{};
  console.log("STATUS="+(e.status||"none")+" START="+(e.startTime||"-")+" ITEMS="+(e.itemsProcessed===undefined?"-":e.itemsProcessed)+" FAILED="+(e.itemsFailed===undefined?"-":e.itemsFailed));
}).catch((err)=>{console.log("STATUS=error");console.error(err.message);process.exit(1);});'
  out="$(devbox_run "node -e '${js}' -- '${name}'")" || true
  printf '%s\n' "$out"
}

field_of() { grep -o "$2=[^ ]*" <<<"$1" | tail -1 | cut -d= -f2-; }

reset_and_run_indexer() {
  local name="$1" out status start_before start_now deadline
  out="$(indexer_status "$name")"
  remote_ok "$out" || die "could not read ${name} status — refusing to reset blind"
  status="$(field_of "$out" STATUS)"
  start_before="$(field_of "$out" START)"
  echo "demi-devbox: ${name} last execution ${status} (${start_before})"
  [[ "$status" != "inProgress" ]] \
    || die "${name} is running now. A tick that finishes after a reset writes its old high-water mark back and undoes the clear. Wait for it, then re-run."

  # POST with an empty string body, not a bare POST: the REST API answers 411 without a
  # content-length, and passing `body: ""` is what makes undici send `content-length: 0`.
  local js='const n=process.argv[1];
const ai=require("./src/search/ai-search");
const ep=(process.env.SEARCH_ENDPOINT||"").replace(/\/+$/,"");
ai.getToken().then(async (t)=>{
  const h={Authorization:"Bearer "+t};
  const reset=await fetch(ep+"/indexers/"+n+"/reset?api-version=2024-07-01",{method:"POST",headers:h,body:""});
  console.log("RESET="+reset.status);
  if(reset.status>=300){console.error(await reset.text());process.exit(1);}
  const run=await fetch(ep+"/indexers/"+n+"/run?api-version=2024-07-01",{method:"POST",headers:h,body:""});
  console.log("RUN="+run.status);
  if(run.status>=300){console.error(await run.text());process.exit(1);}
}).catch((err)=>{console.error(err.message);process.exit(1);});'
  out="$(devbox_run "node -e '${js}' -- '${name}'")" || true
  printf '%s\n' "$out"
  remote_ok "$out" || die "reset/run of ${name} failed"

  deadline=$((SECONDS + INDEXER_TIMEOUT))
  while true; do
    sleep "$INDEXER_POLL_SLEEP"
    out="$(indexer_status "$name")"
    remote_ok "$out" || die "lost contact with ${name} while waiting for its run"
    status="$(field_of "$out" STATUS)"
    start_now="$(field_of "$out" START)"
    echo "demi-devbox: ${name} ${status} items=$(field_of "$out" ITEMS) failed=$(field_of "$out" FAILED)"
    # A new execution, not the one that was already there: the PT5M schedule keeps appending
    # steady-state ticks with itemsProcessed 0, so "success" alone proves nothing.
    if [[ "$start_now" != "$start_before" && "$status" == "success" ]]; then
      echo "demi-devbox: ${name} finished, $(field_of "$out" ITEMS) processed"
      return 0
    fi
    if [[ "$start_now" != "$start_before" && "$status" == *Failure* ]]; then
      die "${name} run ended ${status} — read its executionHistory[0].errors on the devbox"
    fi
    [[ "$SECONDS" -lt "$deadline" ]] \
      || die "${name} did not finish within ${INDEXER_TIMEOUT}s. It is still running; check its status before resetting again."
  done
}

internal_apply_run() {
  local only cmd out
  local -a onlies=()
  mapfile -t onlies < <(only_args)
  for only in "${onlies[@]}"; do
    cmd="git pull --ff-only && node src/scripts/apply-search-definitions.js --live${only:+ --only $only}"
    out="$(devbox_run "$cmd")" || true
    printf '%s\n' "$out"
    remote_ok "$out" || die "apply-search-definitions --live failed${only:+ for ${only}}"
  done

  [[ -n "$DATASOURCES" ]] || { echo "demi-devbox: no data source to write, no indexer to reset"; return 0; }

  put_datasources "$DATASOURCES"

  local ds indexer
  for ds in ${DATASOURCES//,/ }; do
    indexer="$(indexer_for_datasource "$ds")" || die "no committed indexer reads data source ${ds}"
    reset_and_run_indexer "$indexer"
  done
}

# ---------------------------------------------------------------------------------------------

ACTION="${1:-}"
[[ $# -gt 0 ]] && shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --datasources) DATASOURCES="${2:-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "demi-devbox: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

# The `__` actions are this script re-entering itself under with-search-admin.sh, never something
# to type: on their own they run without a grant and answer 403.
case "$ACTION" in
  drift) do_drift ;;
  apply) do_apply ;;
  __drift-run|__dry-run|__apply-run)
    [[ "${DEMI_DEVBOX_INTERNAL:-}" == '1' ]] || die "${ACTION} is internal; use drift or apply"
    RG="${DEMI_RG:?}"; VM_RG="${DEMI_VM_RG:?}"; TENANT="${DEMI_TENANT:?}"
    case "$ENV_NAME" in
      test) SUBSCRIPTION='7897ceb1-9a86-4639-87d7-7f9ff67142b3' ;;
      prod) SUBSCRIPTION='be5924ac-1083-4a1b-be92-7b444882cfd9' ;;
      *) die "unknown --env '${ENV_NAME}'" ;;
    esac
    SERVICE="demi-search-${ENV_NAME}"; IDENTITY="demi-identity-${ENV_NAME}"; VM="demi-devbox-${ENV_NAME}"
    case "$ACTION" in
      __drift-run) internal_drift_run ;;
      __dry-run) internal_dry_run ;;
      __apply-run) internal_apply_run ;;
    esac
    ;;
  -h|--help|'') usage; [[ -n "$ACTION" ]] || exit 1 ;;
  *) echo "demi-devbox: unknown action '${ACTION}'" >&2; usage >&2; exit 1 ;;
esac
