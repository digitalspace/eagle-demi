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
#   scripts/demi-devbox.sh apply --env prod --datasources demi-updates-ds,demi-notifications-ds
#
# `drift` is read-only and exits 1 when any committed field is missing from the live index. `apply`
# asks before every write: data sources named by `--datasources` are written first, behind their own
# prompt, then the dry run, then the plan for the rest and its prompt.
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
# Each phase is ONE run command, and each one costs 20-45 s of ARM and agent round trips. That is
# why the per-index steps are a loop inside one payload and why the indexer wait runs on the VM
# (`src/scripts/reset-and-run-indexers.js`) instead of a poll per tick from here: an apply is 3-4
# calls, a drift is 1. `--no-wait` stops after the run is posted, which is the workable mode for
# chunks-indexer: it takes hours.
#
# A data source named by `--datasources` is PUT BEFORE step 1: step 2 only covers data sources that
# already exist and differ, and a new indexer's dry run refuses while its data source is missing.
# That early PUT also makes it equal to the committed copy, so step 2 can no longer see it — the
# names go into step 3 directly instead, or a pre-created data source would keep its old high-water
# mark and fill every new field with nulls.
#
# WHY THE SUBSCRIPTION IDS ARE THE ONLY HARDCODED VALUES. Everything else is looked up at runtime —
# the resource group comes from the search service, the VM's group from the VM, the tenant from the
# subscription, the indexer identity from the search service itself — so a resource that moved
# groups does not turn into a wrong-scope grant. A subscription id has nothing above it to be
# derived from: `az account list` names are not stable enough to match on. They are resource
# identifiers, not credentials.
#
# ENV VARS: `DEVBOX_RUNNER` (path to an external `run --env <env> -- <command>` wrapper; when unset
# this starts the VM and runs the command itself), `DEVBOX_RUN_MODE` (`invoke`, the default:
# `az vm run-command invoke`, 4 KB output, 90 minute cap; or `managed`: output to blob, needs
# Storage Blob Data Contributor on the output account), `DEVBOX_READY_TIMEOUT` (seconds to wait
# for the VM agent, default 1200), `DEVBOX_READY_SLEEPS` (back-off between agent checks, default
# `5 15 60`), `DEVBOX_START_GRACE` (seconds a posted start may leave the VM stopped, default 180),
# `DEVBOX_RUN_TIMEOUT` (managed script timeout on the VM: default 5400 under a search role grant,
# so the grant stays as short as an invoke run; 14400 for `run`), `DEVBOX_QUEUE_TIMEOUT` (seconds
# a managed run may wait in the agent's queue before it starts, default 3600),
# `DEVBOX_RUN_POLL_SLEEP` (default 10), `DEVBOX_OUTPUT_ACCOUNT` (managed output account, default
# the `demifc*` account in the VM's group), `DEVBOX_CHECKOUT` (default `/opt/eagle-demi`), `DS_RG`
# (Cosmos account's resource group, only needed when the subscription holds more than one
# account), `INDEXER_POLL_SLEEP`, `INDEXER_TIMEOUT`, `INDEXER_TIMEOUT_LONG`, `AZ` (the `az` seam
# the tests drive).
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
DEVBOX_RUN_MODE="${DEVBOX_RUN_MODE:-invoke}"
DEVBOX_READY_TIMEOUT="${DEVBOX_READY_TIMEOUT:-1200}"
DEVBOX_READY_SLEEPS="${DEVBOX_READY_SLEEPS-5 15 60}"
DEVBOX_START_GRACE="${DEVBOX_START_GRACE:-180}"
DEVBOX_RUN_TIMEOUT="${DEVBOX_RUN_TIMEOUT:-}"
DEVBOX_QUEUE_TIMEOUT="${DEVBOX_QUEUE_TIMEOUT:-3600}"
DEVBOX_RUN_POLL_SLEEP="${DEVBOX_RUN_POLL_SLEEP:-10}"
DEVBOX_OUTPUT_ACCOUNT="${DEVBOX_OUTPUT_ACCOUNT:-}"
OUT_CONTAINER='devbox-run-output'
RUN_NAME=''
RUN_SAS_EXPIRY=''
RUN_FILES=()

# Not POLL_SLEEP: with-search-admin.sh reads that name for its own RBAC-replication poll, and this
# script runs inside it.
INDEXER_POLL_SLEEP="${INDEXER_POLL_SLEEP:-30}"
INDEXER_TIMEOUT="${INDEXER_TIMEOUT:-1800}"
# chunks-indexer re-pulls ~1.1M rows. 80 minutes fits under the 90 minute cap of an `invoke` run
# and the default 90 minute managed timeout under a grant. Longer goes through `--no-wait` + `watch`.
INDEXER_TIMEOUT_LONG="${INDEXER_TIMEOUT_LONG:-4800}"

ENV_NAME='test'
ONLY=''
ASSUME_YES=0
DATASOURCES=''
NO_WAIT=0
RUN_CMD=''
HAS_CMD=''

usage() {
  cat <<'EOF'
Usage: scripts/demi-devbox.sh <drift|apply|watch> [--env test|prod] [--only <index,...>]
                              [--datasources <name,...>] [--yes] [--no-wait]
       scripts/demi-devbox.sh run [--env test|prod] -- <command>

  drift    read-only: run apply-search-definitions.js --check on the devbox and exit 1 when a
           committed field is missing from the live index. Run it after any deploy that touches
           azure/search/ or search code, and before a prod release.
  apply    dry-run, print, confirm, then PUT the indexes, PUT the data sources whose committed
           SELECT differs, and reset + run those indexers. --yes skips the prompt.
  watch    read-only: wait for the current execution of the indexers that read --datasources.
           What to run after an `apply --no-wait`.
  run      run one command in the devbox checkout as the app identity, print its full output and
           exit with its exit code. No search role grant.

  --env    test (default) or prod
  --only   index or indexer names, comma separated: documents, projects, chunks
  --yes    do not prompt before the writing half of `apply`
  --no-wait
           post the indexer reset and run, then stop without waiting. Use it for chunks: that run
           takes hours, and holding the role grant open for them is the wider risk. Follow with
           `watch`.
  --datasources
           data source names to PUT before the dry run, comma separated. Needed when adding an
           indexer whose data source does not exist yet: its dry run refuses on the missing name.
           Written first, behind their own prompt, and their indexers are reset with the rest.
           Also names the indexers `watch` follows.

Env    Subscription                            Search service      Devbox
test   7897ceb1-9a86-4639-87d7-7f9ff67142b3    demi-search-test    demi-devbox-test
prod   be5924ac-1083-4a1b-be92-7b444882cfd9    demi-search-prod    demi-devbox-prod

Resource groups, the tenant and the indexer identity are read with `az` at runtime.
Background: azure/search/README.md, docs/runbook-search-outage.md.
EOF
}

die() { echo "demi-devbox: $*" >&2; exit 1; }
usage_error() { echo "demi-devbox: $*" >&2; usage >&2; exit 2; }

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
# so every command carries its own status back in a line the caller greps for. The newlines keep a
# trailing `&` or a `#` comment in the command from swallowing the closing brace.
remote_script() {
  printf 'cd %s && {\n%s\n}; echo DEMI_EXIT=$?' "$DEVBOX_CHECKOUT" "$1"
}

# The LAST DEMI_EXIT code on stdin, from ONE call's output. Never hand this the output of several
# calls joined together: every exit line lands in the same text, so a grep for DEMI_EXIT=0 lets a
# clean step hide a failing one.
#
# Within one call a multi-step payload keeps its own `rc` across the loop and ends on
# `[ $rc -eq 0 ]`, so this single line is already every step's code and-ed together: a `--only a,b`
# run whose second index is clean cannot pass for the first. The DEMI_STEP lines are for the
# operator reading the output, not for the verdict.
remote_exit() { grep -o 'DEMI_EXIT=[0-9][0-9]*' | tail -1 | cut -d= -f2 || true; }
remote_ok() { [[ "$(remote_exit <<<"$1")" == '0' ]]; }

# Instance view to `power|agent|busy|failed|agent message`. Extensions and handlers both count.
# Failed and NotReady ones are reported, never waited on: a stuck handler does not settle.
READY_JQ='
def code: (. // "") | ascii_downcase;
. as $iv
| ([($iv.extensions // [])[] | {n: .name, c: ((.statuses // [])[0].code | code)}]
   + [($iv.vmAgent.extensionHandlers // [])[] | {n: .type, c: (.status.code | code)}]) as $items
| [ ([($iv.statuses // [])[].code | code | select(startswith("powerstate/"))][0]
      // "powerstate/unknown" | ltrimstr("powerstate/")),
    ($iv.vmAgent.statuses[0].displayStatus // "none"),
    ([$items[] | select(.c | test("^provisioningstate/(transitioning|creating|updating|deleting)")) | .n]
      | unique | join(",")),
    ([$items[] | select(.c | test("^provisioningstate/(failed|notready)")) | .n] | unique | join(",")),
    ($iv.vmAgent.statuses[0].message // "")
  ] | join("|")'

# Run-command is one more agent goal state, so it queues behind any extension the agent is still
# working through. Called before the first remote call of each stretch with no prompt in it.
# `$1`: what a give-up message says has already happened.
devbox_ready() {
  [[ -z "$DEVBOX_RUNNER" ]] || return 0
  local done_note="${1:-Nothing was run.}" t0=$SECONDS posted='' iv parsed power agent busy failed msg shown='' nap i=0
  local -a naps
  read -r -a naps <<<"$DEVBOX_READY_SLEEPS"
  while :; do
    iv="$("$AZ" vm get-instance-view --subscription "$SUBSCRIPTION" -g "$VM_RG" -n "$VM" \
      --query instanceView -o json)" || die "could not read the instance view of ${VM}; see the az error above"
    parsed="$(jq -r "$READY_JQ" <<<"$iv")" || die "could not parse the instance view of ${VM}"
    IFS='|' read -r power agent busy failed msg <<<"$parsed"
    if [[ -n "$failed" && "$failed" != "$shown" ]]; then
      echo "demi-devbox: ignoring failed or NotReady on ${VM}: ${failed}" >&2
      shown="$failed"
    fi
    if [[ "$power" == 'running' && "${agent,,}" == 'ready' && -z "$busy" ]]; then
      echo "demi-devbox: ${VM} ready after $((SECONDS - t0))s" >&2
      return 0
    fi
    # Only from a settled stop: `starting` is someone's start already in flight. Two runs can still
    # both post; the second may be refused, so the power state read after it is the verdict.
    if [[ "$power" == 'deallocated' || "$power" == 'stopped' ]]; then
      if [[ -z "$posted" ]]; then
        posted=$SECONDS
        if "$AZ" vm start --subscription "$SUBSCRIPTION" -g "$VM_RG" -n "$VM" --no-wait >/dev/null; then
          echo "demi-devbox: ${VM} was ${power}; start posted" >&2
        else
          echo "demi-devbox: the start of ${VM} was refused (az error above); waiting up to ${DEVBOX_START_GRACE}s in case another run's start is in flight" >&2
        fi
      elif (( SECONDS - posted >= DEVBOX_START_GRACE )); then
        die "${VM} is still ${power} ${DEVBOX_START_GRACE}s after the start was posted: the start did not take. ${done_note}"
      fi
    fi
    local status="power=${power} agent=${agent} (${msg}) extensions busy: ${busy:-none}"
    if (( SECONDS - t0 >= DEVBOX_READY_TIMEOUT )); then
      die "${VM} not ready after ${DEVBOX_READY_TIMEOUT}s: ${status}. ${done_note}"
    fi
    echo "demi-devbox: waiting for ${VM}: ${status}" >&2
    nap="${naps[i]:-${naps[-1]}}"
    (( i < ${#naps[@]} - 1 )) && i=$((i + 1))
    sleep "$nap"
  done
}

# Managed mode only. Resolved once per invocation and exported, so re-entered phases reuse it.
prepare_output() {
  [[ "$DEVBOX_RUN_MODE" == 'managed' && -z "$DEVBOX_RUNNER" ]] || return 0
  DEVBOX_OUTPUT_ACCOUNT="${DEVBOX_OUTPUT_ACCOUNT:-$("$AZ" storage account list --subscription "$SUBSCRIPTION" \
    -g "$VM_RG" --query "[?starts_with(name,'demifc')].name | [0]" -o tsv)}"
  [[ -n "$DEVBOX_OUTPUT_ACCOUNT" ]] \
    || die "no demifc* storage account in ${VM_RG} for run-command output; set DEVBOX_OUTPUT_ACCOUNT, or DEVBOX_RUN_MODE=invoke"
  "$AZ" storage container create --subscription "$SUBSCRIPTION" --auth-mode login \
    --account-name "$DEVBOX_OUTPUT_ACCOUNT" -n "$OUT_CONTAINER" -o none \
    || die "could not create container ${OUT_CONTAINER} on ${DEVBOX_OUTPUT_ACCOUNT}: this az login needs Storage Blob Data Contributor there, or use DEVBOX_RUN_MODE=invoke. Nothing was run."
  export DEVBOX_OUTPUT_ACCOUNT
}

# A user-delegation SAS for one blob, written to a mktemp (0600) file so it never reaches argv or
# the terminal; prints the file path for az's `@file` syntax. `acw`: the download uses the login,
# not the SAS.
sas_file() {
  local blob="$1" exp="$2" f
  f="$(mktemp)"
  "$AZ" storage blob generate-sas --subscription "$SUBSCRIPTION" --auth-mode login --as-user \
    --account-name "$DEVBOX_OUTPUT_ACCOUNT" -c "$OUT_CONTAINER" -n "$blob" --permissions acw \
    --https-only --expiry "$exp" --full-uri -o tsv | tr -d '\r\n' >"$f" || { rm -f "$f"; return 1; }
  echo "$f"
}

# The status and error code of an Azure error on stdin, never the raw text: storage and run-command
# errors can echo the blob URI, SAS included.
error_code() {
  local text
  text="$(cat)"
  grep -oE 'StatusCode=[0-9]+, ErrorCode=[A-Za-z]+' <<<"$text" | head -1 \
    || grep -oE '\([A-Z][A-Za-z]{2,}\)' <<<"$text" | head -1 || true
}

# Removes what one managed run left behind. `finished`: the run is over. `live`: it may still be going
# (deadline, interrupt, error), so its SAS can re-create blobs after this. `keep`: blobs stay.
managed_cleanup() {
  local mode="${1:-live}" err
  # Ignored, not reset: a second Ctrl-C would otherwise kill the deletes below. az inherits it too.
  trap - EXIT; trap '' INT TERM
  if [[ -n "${RUN_NAME:-}" ]]; then
    # At most 25 managed run commands per VM, so every one is removed. NotFound: it was never made.
    if ! err="$("$AZ" vm run-command delete --subscription "$SUBSCRIPTION" -g "$VM_RG" --vm-name "$VM" \
        --name "$RUN_NAME" --yes --no-wait -o none 2>&1)"; then
      grep -qiE 'NotFound|404' <<<"$err" || echo "demi-devbox: could not delete run-command ${RUN_NAME}" >&2
    fi
    if [[ "$mode" != 'keep' ]]; then
      "$AZ" storage blob delete-batch --subscription "$SUBSCRIPTION" --auth-mode login \
        --account-name "$DEVBOX_OUTPUT_ACCOUNT" -s "$OUT_CONTAINER" --pattern "${RUN_NAME}/*" -o none \
        >/dev/null 2>&1 || echo "demi-devbox: could not delete blobs ${OUT_CONTAINER}/${RUN_NAME}/" >&2
    fi
    if [[ "$mode" == 'live' && -n "${RUN_SAS_EXPIRY:-}" ]]; then
      echo "demi-devbox: blobs under ${DEVBOX_OUTPUT_ACCOUNT}/${OUT_CONTAINER}/${RUN_NAME}/ may reappear until ${RUN_SAS_EXPIRY}: the script on ${VM} can still write through its SAS." >&2
    fi
  fi
  RUN_NAME=''; RUN_SAS_EXPIRY=''
  rm -f "${RUN_FILES[@]+"${RUN_FILES[@]}"}"
  RUN_FILES=()
  trap - INT TERM
}

# A managed run command: output to blob, no 4 KB cap, and the client polls on its own bounds
# instead of holding one ARM call open: DEVBOX_QUEUE_TIMEOUT until the script starts, then
# DEVBOX_RUN_TIMEOUT (the VM's own limit) plus three polls. Prints stdout, then stderr to stderr.
managed_run() {
  local wrapped="$1" t0=$SECONDS started='' state='' grace out_sas err_sas out err reason dl_err secs epoch
  RUN_FILES=()
  RUN_NAME="demi-run-$(date -u +%Y%m%d%H%M%S)-$$-${RANDOM}"
  # Best effort in the handlers: a closed terminal must not stop the cleanup at its first echo.
  trap 'set +e; managed_cleanup live' EXIT
  trap 'trap "" PIPE; set +e; managed_cleanup live; exit 130' INT
  trap 'trap "" PIPE; set +e; managed_cleanup live; exit 143' TERM
  grace=$((3 * DEVBOX_RUN_POLL_SLEEP))
  # User-delegation SAS lifetime is capped at 7 days.
  secs=$((DEVBOX_QUEUE_TIMEOUT + DEVBOX_RUN_TIMEOUT + grace + 600))
  (( secs <= 604800 )) || secs=604800
  epoch=$(( $(date -u +%s) + secs ))
  RUN_SAS_EXPIRY="$(date -u -d "@${epoch}" +%Y-%m-%dT%H:%MZ 2>/dev/null || date -u -r "$epoch" +%Y-%m-%dT%H:%MZ 2>/dev/null)" \
    || die "cannot compute the SAS expiry: needs GNU date (date -d) or BSD date (date -r)"
  if ! { out_sas="$(sas_file "${RUN_NAME}/stdout" "$RUN_SAS_EXPIRY")" && RUN_FILES+=("$out_sas") \
      && err_sas="$(sas_file "${RUN_NAME}/stderr" "$RUN_SAS_EXPIRY")" && RUN_FILES+=("$err_sas"); }; then
    echo "demi-devbox: could not mint the output SAS on ${DEVBOX_OUTPUT_ACCOUNT}" >&2
    managed_cleanup finished
    return 1
  fi
  # -o none and a filtered stderr: the create response and its errors can echo the SAS.
  if ! err="$("$AZ" vm run-command create --subscription "$SUBSCRIPTION" -g "$VM_RG" --vm-name "$VM" \
      --name "$RUN_NAME" --script "$wrapped" --async-execution true \
      --timeout-in-seconds "$DEVBOX_RUN_TIMEOUT" \
      --output-blob-uri "@${out_sas}" --error-blob-uri "@${err_sas}" --no-wait -o none 2>&1)"; then
    echo "demi-devbox: run-command create failed ($(error_code <<<"$err"))" >&2
    managed_cleanup live
    return 1
  fi
  rm -f "$out_sas" "$err_sas"

  while :; do
    state="$("$AZ" vm run-command show --subscription "$SUBSCRIPTION" -g "$VM_RG" --vm-name "$VM" \
      --name "$RUN_NAME" --instance-view -o tsv \
      --query "join(' ', [to_string(provisioningState), to_string(instanceView.executionState)])" || true)"
    state="${state,,}"
    case "$state" in
      *' succeeded'|*' failed'|*' timedout'|*' canceled'|'failed '*|'canceled '*) break ;;
      *' running') [[ -n "$started" ]] || started=$SECONDS ;;
    esac
    if [[ -z "$started" ]] && (( SECONDS - t0 >= DEVBOX_QUEUE_TIMEOUT )); then
      echo "demi-devbox: run-command ${RUN_NAME} never started: still '${state}' after ${DEVBOX_QUEUE_TIMEOUT}s in the VM agent's queue; deleting it." >&2
      managed_cleanup live
      return 1
    fi
    if [[ -n "$started" ]] && (( SECONDS - started >= DEVBOX_RUN_TIMEOUT + grace )); then
      echo "demi-devbox: run-command ${RUN_NAME} still running $((SECONDS - started))s after it started; deleting it. The script on ${VM} may keep running until its own ${DEVBOX_RUN_TIMEOUT}s timeout." >&2
      managed_cleanup live
      return 1
    fi
    sleep "$DEVBOX_RUN_POLL_SLEEP"
  done
  echo "demi-devbox: run-command ${RUN_NAME} ${state#* } after $((SECONDS - t0))s" >&2

  out="$(mktemp)"; err="$(mktemp)"
  RUN_FILES+=("$out" "$err")
  if dl_err="$("$AZ" storage blob download --subscription "$SUBSCRIPTION" --auth-mode login \
      --account-name "$DEVBOX_OUTPUT_ACCOUNT" -c "$OUT_CONTAINER" -n "${RUN_NAME}/stdout" -f "$out" \
      -o none 2>&1 >/dev/null)"; then
    cat "$out"
  elif grep -q 'BlobNotFound' <<<"$dl_err"; then
    reason="$("$AZ" vm run-command show --subscription "$SUBSCRIPTION" -g "$VM_RG" --vm-name "$VM" \
      --name "$RUN_NAME" --instance-view --query "instanceView.executionMessage" -o tsv | error_code || true)"
    echo "demi-devbox: no output blob for ${RUN_NAME} (${reason:-no storage error reported})" >&2
    if [[ "$reason" == StatusCode=403* ]]; then
      echo "demi-devbox: the VM writes through a user-delegation SAS, which carries only the blob roles of this az login: it needs Storage Blob Data Contributor on ${DEVBOX_OUTPUT_ACCOUNT}. DEVBOX_RUN_MODE=invoke needs no storage." >&2
    fi
  else
    # The login download carries no SAS, so its error is safe to show. The output may be there.
    echo "demi-devbox: could not download ${DEVBOX_OUTPUT_ACCOUNT}/${OUT_CONTAINER}/${RUN_NAME}/stdout; the blobs are kept. az said:" >&2
    head -n 5 <<<"$dl_err" >&2
    managed_cleanup keep
    return 1
  fi
  if "$AZ" storage blob download --subscription "$SUBSCRIPTION" --auth-mode login \
      --account-name "$DEVBOX_OUTPUT_ACCOUNT" -c "$OUT_CONTAINER" -n "${RUN_NAME}/stderr" -f "$err" \
      -o none >/dev/null 2>&1; then
    cat "$err" >&2
  fi
  managed_cleanup finished
  [[ "$state" == *' succeeded' ]]
}

devbox_run() {
  local script out rc=0
  script="$(remote_script "$1")"
  if [[ -n "$DEVBOX_RUNNER" ]]; then
    out="$("$DEVBOX_RUNNER" run --env "$ENV_NAME" -- "$script")" || rc=$?
    printf '%s\n' "$out"
    [[ "$rc" -eq 0 ]] || { echo "demi-devbox: DEVBOX_RUNNER exited ${rc}" >&2; return 1; }
    return 0
  fi
  local wrapped="sudo -u demi /usr/local/bin/demi-run '${script//\'/\'\\\'\'}'"
  if [[ "$DEVBOX_RUN_MODE" == 'managed' ]]; then
    managed_run "$wrapped"
    return
  fi
  out="$("$AZ" vm run-command invoke --subscription "$SUBSCRIPTION" -g "$VM_RG" -n "$VM" \
    --command-id RunShellScript --scripts "$wrapped" \
    --query "value[].message" -o tsv)" || return 1
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

# The same names as one space-separated list for the remote loop. A run that named none carries the
# label `all`, so every step still reports under a name in the output.
only_labels() {
  local n out=''
  local -a onlies=()
  mapfile -t onlies < <(only_args)
  for n in "${onlies[@]}"; do out="${out:+${out} }${n:-all}"; done
  printf '%s' "$out"
}

# One payload for every `--only` name. A call per index used to be most of an apply's wall time:
# each `az vm run-command invoke` is a 20-45 s ARM long poll whatever it carries.
multi_only_cmd() {
  local flag="$1"
  printf 'git pull --ff-only && { rc=0; for n in %s; do if [ "$n" = all ]; then o=""; else o="--only $n"; fi; node src/scripts/apply-search-definitions.js %s$o; s=$?; echo "DEMI_STEP $n $s"; [ $s -eq 0 ] || rc=$s; done; [ $rc -eq 0 ]; }' \
    "$(only_labels)" "${flag:+${flag} }"
}

# The indexers that read the named data sources, one per name, in the order given.
resets_for() {
  local ds indexer out=''
  for ds in ${1//,/ }; do
    indexer="$(indexer_for_datasource "$ds")" || die "no committed indexer reads data source ${ds}"
    out="${out:+${out},}${indexer}"
  done
  printf '%s' "$out"
}

# chunks-indexer re-pulls ~1.1M rows and takes hours; everything else is minutes.
has_long_indexer() { [[ ",${1}," == *",chunks-indexer,"* ]]; }

# ---------------------------------------------------------------------------------------------
# drift

do_drift() {
  resolve_env
  preflight_rbac
  devbox_ready
  prepare_output
  local out rc=0
  # The verdict is the re-entered run's exit status, not a grep of its output: it checks each index
  # separately and already fails on any one of them, and the output holds every index's exit line.
  out="$(with_grant "$0" __drift-run --env "$ENV_NAME" ${ONLY:+--only "$ONLY"})" || rc=$?
  printf '%s\n' "$out"
  if [[ "$rc" -ne 0 ]]; then
    die "drift detected, or the check itself failed — see the output above"
  fi
  echo "demi-devbox: no drift on ${SERVICE}"
}

# Runs on this machine, inside the grant, one hop from the devbox.
internal_drift_run() {
  local out rc=0
  out="$(devbox_run "$(multi_only_cmd --check)")" || rc=1
  printf '%s\n' "$out"
  remote_ok "$out" || rc=1
  return "$rc"
}

# ---------------------------------------------------------------------------------------------
# apply

do_apply() {
  resolve_env
  preflight_rbac

  # A new indexer names a data source that does not exist yet, and the dry run refuses on that name
  # before anything can be written — so no run could ever create it. `--datasources` is the operator
  # naming the ones to PUT first. Its own grant, ahead of the dry run's: a data source no committed
  # indexer reads yet cannot change what the service is serving.
  #
  # Its own prompt, because this write lands before the one below: a `[y/N]` answered after the
  # data sources are already on the service cannot still mean "nothing was written".
  if [[ -n "$DATASOURCES" && "$ASSUME_YES" -ne 1 ]]; then
    local pre_answer=''
    # The notice is its own echo: `read -p` prints nothing when stdin is not a terminal, and this
    # line is the record of what the answer was about.
    echo "demi-devbox: will PUT data source(s) ${DATASOURCES} before the dry run." >&2
    read -r -p "Proceed? [y/N] " pre_answer || pre_answer=''
    [[ "$pre_answer" == "y" || "$pre_answer" == "Y" ]] || die "aborted — nothing was written"
  fi
  devbox_ready
  prepare_output
  if [[ -n "$DATASOURCES" ]]; then
    with_grant "$0" __put-datasources --env "$ENV_NAME" --datasources "$DATASOURCES"
    echo "demi-devbox: pre-created data source(s): ${DATASOURCES}"
  fi

  local dry_log
  dry_log="$(mktemp)"
  # The dry run reads the LIVE schema, which the app identity cannot do on its own, so even the
  # read-only half runs under a grant. It is a separate grant from the writing half below: the
  # prompt in between can sit unanswered for as long as the operator likes, and a grant should not
  # wait on a human.
  local dry_rc=0
  with_grant "$0" __dry-run --env "$ENV_NAME" ${ONLY:+--only "$ONLY"} | tee "$dry_log" || dry_rc=$?
  local dry
  dry="$(cat "$dry_log")"
  rm -f "$dry_log"
  # Same reason as `drift`: one index's clean dry run must not stand in for the whole gate, or the
  # other index gets PUT live after its dry run failed.
  [[ "$dry_rc" -eq 0 ]] || die "the dry run failed — nothing was written"

  # The dry run names every data source whose live SELECT differs from the committed copy. Parsed
  # from its output rather than re-derived here: the comparison needs the LIVE query, and only the
  # devbox can read it.
  local differing
  # `|| true`: no match is the ordinary case, and under pipefail an empty grep would end the run.
  differing="$(grep -o 'data source [A-Za-z0-9-]* DIFFERS' <<<"$dry" | awk '{print $3}' | sort -u | paste -sd, - || true)"

  # A pre-created data source now matches the committed copy, so the dry run never calls it
  # DIFFERS — and without it here its indexer would keep the high-water mark it had before the
  # columns changed. Every name the operator passed gets the same reset as one that differs.
  local ds write_ds=''
  for ds in ${DATASOURCES//,/ } ${differing//,/ }; do
    if [[ ",${write_ds}," != *",${ds},"* ]]; then
      write_ds="${write_ds:+${write_ds},}${ds}"
    fi
  done

  local resets=''
  if [[ -n "$write_ds" ]]; then
    resets="$(resets_for "$write_ds")"
  fi

  echo ''
  echo "About to write to ${SERVICE} (${ENV_NAME}):"
  echo "  - PUT the committed indexes and indexers${ONLY:+ (--only ${ONLY})}"
  if [[ -n "$write_ds" ]]; then
    echo "  - PUT data source(s): ${write_ds}"
    echo "  - reset and run indexer(s): ${resets}"
    if has_long_indexer "$resets"; then
      echo "  !! chunks-indexer re-pulls ~1.1M rows and takes hours. --only documents or --only"
      echo "     projects if that is not what you meant, and --no-wait if it is: the wait gives"
      echo "     up after $((INDEXER_TIMEOUT_LONG / 60)) minutes and the role grant stays open until it does."
    fi
  else
    echo "  - no data source differs, so no indexer reset"
  fi

  if [[ "$ASSUME_YES" -ne 1 ]]; then
    local answer=''
    read -r -p "Proceed? [y/N] " answer || answer=''
    [[ "$answer" == "y" || "$answer" == "Y" ]] || die "aborted — nothing was written"
    local written='Nothing was written.'
    [[ -z "$DATASOURCES" ]] || written="Only data source(s) ${DATASOURCES} were written, before the dry run."
    devbox_ready "$written"
  fi

  local -a wait_flag=()
  if [[ "$NO_WAIT" -eq 1 ]]; then wait_flag=(--no-wait); fi
  with_grant "$0" __apply-run --env "$ENV_NAME" ${ONLY:+--only "$ONLY"} --datasources "$write_ds" \
    "${wait_flag[@]+"${wait_flag[@]}"}"
}

# Read-only: no reset, no run, just the wait. What to run after `apply --no-wait`.
do_watch() {
  resolve_env
  preflight_rbac
  [[ -n "$DATASOURCES" ]] \
    || die "watch needs --datasources: the indexers it follows are the ones that read them"
  devbox_ready
  prepare_output
  with_grant "$0" __watch-run --env "$ENV_NAME" --datasources "$DATASOURCES"
}

do_run() {
  resolve_env
  devbox_ready
  prepare_output
  local out code rc=0
  out="$(mktemp)"
  devbox_run "$RUN_CMD" >"$out" || rc=$?
  cat "$out"
  code="$(remote_exit <"$out")"
  rm -f "$out"
  if [[ -z "$code" ]]; then
    # A refused call (409 while another run command is going) never ran; the error above says which.
    [[ "$rc" -eq 0 ]] || die "the call to ${VM} failed and no DEMI_EXIT line came back; see the error above"
    die "no DEMI_EXIT line came back from ${VM}: the command may have run, but its output was lost"
  fi
  exit "$code"
}

internal_dry_run() {
  local out rc=0
  out="$(devbox_run "$(multi_only_cmd '')")" || rc=1
  printf '%s\n' "$out"
  remote_ok "$out" || rc=1
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

# The remote half of a data source PUT, so it can be appended to the live apply instead of costing
# its own run-command call. DS_DIR at a temp copy holding ONLY the named files:
# put-search-datasources.js PUTs everything in the directory it is given, and `--only documents`
# must not rewrite the chunks data source on the way past.
datasource_cmd() {
  local list="$1" ds copies=''
  for ds in ${list//,/ }; do
    copies="${copies} azure/search/datasources/${ds}.json"
  done
  printf '{ rm -rf /tmp/demi-ds && mkdir -p /tmp/demi-ds && cp%s /tmp/demi-ds/ && DS_SUB=%s DS_RG=%s DS_IDENTITY_ID=%s DS_DIR=/tmp/demi-ds node src/scripts/put-search-datasources.js; s=$?; echo "DEMI_STEP datasources $s"; [ $s -eq 0 ]; }' \
    "$copies" "'${SUBSCRIPTION}'" "'${COSMOS_RG}'" "'${DS_IDENTITY_ID}'"
}

put_datasources() {
  local out
  resolve_datasource_env
  # `git pull` here as well as in the apply: the pre-create step runs BEFORE the dry run, and a
  # data source added in this commit is not in the devbox checkout until something pulls it.
  out="$(devbox_run "git pull --ff-only && $(datasource_cmd "$1")")" || true
  printf '%s\n' "$out"
  remote_ok "$out" || die "the data source PUT failed — the indexes are widened but the columns are not projected"
}

field_of() { grep -o "$2=[^ ]*" <<<"$1" | tail -1 | cut -d= -f2-; }

# Reset, run and wait for every indexer in ONE call. The wait itself runs on the VM
# (src/scripts/reset-and-run-indexers.js): a poll from here costs a 20-45 s ARM round trip per
# tick, which is how a 360-row index used to take an hour and then miss its own deadline.
run_indexers_remote() {
  local list="$1" mode="${2:-reset}" out line timeout="$INDEXER_TIMEOUT" busy
  if has_long_indexer "$list"; then timeout="$INDEXER_TIMEOUT_LONG"; fi
  out="$(devbox_run "git pull --ff-only && \
DEMI_MODE='${mode}' DEMI_POLL_SLEEP='${INDEXER_POLL_SLEEP}' DEMI_TIMEOUT='${timeout}' \
DEMI_NO_WAIT='${NO_WAIT}' node src/scripts/reset-and-run-indexers.js ${list//,/ }")" || true
  printf '%s\n' "$out"

  if ! remote_ok "$out"; then
    busy="$(grep -o 'DEMI_BUSY [A-Za-z0-9_-]*' <<<"$out" | head -1 | awk '{print $2}' || true)"
    if [[ -n "$busy" ]]; then
      die "${busy} is running now. A tick that finishes after a reset writes its old high-water mark back and undoes the clear. Wait for it, then re-run."
    fi
    if grep -q 'DEMI_RESET_NOT_APPLIED' <<<"$out"; then
      die "the reset did not take — the execution kept its old high-water mark, so nothing was re-pulled"
    fi
    die "reset and run of ${list} failed — see the output above"
  fi

  while read -r line; do
    echo "demi-devbox: $(field_of "$line" name) finished, $(field_of "$line" items) processed"
  done < <(grep '^DEMI_RESULT ' <<<"$out" || true)

  # Still running at the deadline is not a failure: the run was posted and the indexer is working.
  while read -r line; do
    echo "demi-devbox: ${line#DEMI_WARN }"
  done < <(grep '^DEMI_WARN ' <<<"$out" || true)

  if [[ "$NO_WAIT" -eq 1 && "$mode" == 'reset' ]]; then
    echo "demi-devbox: reset and run posted for ${list}; not waiting. Follow it with:"
    echo "  scripts/demi-devbox.sh watch --env ${ENV_NAME} --datasources ${DATASOURCES}"
  fi
}

internal_put_datasources() {
  [[ -n "$DATASOURCES" ]] || die "__put-datasources needs --datasources"
  put_datasources "$DATASOURCES"
}

internal_apply_run() {
  local cmd out resets
  cmd="$(multi_only_cmd --live)"
  # One payload, so the ordering azure/search/README.md asks for — indexes first, then the data
  # sources — is the `&&` inside it. A failed index PUT short-circuits before the columns change.
  if [[ -n "$DATASOURCES" ]]; then
    resolve_datasource_env
    cmd="${cmd} && $(datasource_cmd "$DATASOURCES")"
  fi
  out="$(devbox_run "$cmd")" || true
  printf '%s\n' "$out"
  remote_ok "$out" || die "the write failed — see the output above"

  [[ -n "$DATASOURCES" ]] || { echo "demi-devbox: no data source to write, no indexer to reset"; return 0; }

  resets="$(resets_for "$DATASOURCES")"
  run_indexers_remote "$resets"
}

internal_watch_run() {
  local resets
  resets="$(resets_for "$DATASOURCES")"
  run_indexers_remote "$resets" watch
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
    --no-wait) NO_WAIT=1; shift ;;
    # One argument is a shell command line; several are argv, quoted one by one.
    --) shift; HAS_CMD=1
      if [[ $# -eq 1 ]]; then RUN_CMD="$1"; elif [[ $# -gt 1 ]]; then RUN_CMD="$(printf '%q ' "$@")"; RUN_CMD="${RUN_CMD% }"; fi
      break ;;
    -h|--help) usage; exit 0 ;;
    *) usage_error "unknown argument '$1'" ;;
  esac
done

if [[ "$ACTION" == 'run' ]]; then
  [[ -n "$RUN_CMD" ]] || usage_error "run needs a command after --"
  [[ -z "$ONLY$DATASOURCES" && "$ASSUME_YES" -eq 0 && "$NO_WAIT" -eq 0 ]] \
    || usage_error "run takes only --env and -- <command>"
elif [[ -n "$HAS_CMD" ]]; then
  usage_error "-- <command> belongs to run, not ${ACTION:-no action}"
fi

DEVBOX_RUN_TIMEOUT="${DEVBOX_RUN_TIMEOUT:-$([[ "$ACTION" == 'run' ]] && echo 14400 || echo 5400)}"
for v in DEVBOX_READY_TIMEOUT DEVBOX_START_GRACE DEVBOX_RUN_TIMEOUT DEVBOX_QUEUE_TIMEOUT DEVBOX_RUN_POLL_SLEEP; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || usage_error "${v} must be a whole number of seconds, got '${!v}'"
done
[[ "$DEVBOX_READY_SLEEPS" =~ ^[0-9]+( [0-9]+)*$ ]] \
  || usage_error "DEVBOX_READY_SLEEPS must be seconds separated by spaces, got '${DEVBOX_READY_SLEEPS}'"
[[ "$DEVBOX_RUN_MODE" == 'invoke' || "$DEVBOX_RUN_MODE" == 'managed' ]] \
  || usage_error "unknown DEVBOX_RUN_MODE '${DEVBOX_RUN_MODE}', want invoke|managed"
if [[ -n "$DEVBOX_RUNNER" && "$(readlink -f -- "$DEVBOX_RUNNER" || true)" == "$(readlink -f -- "$0")" ]]; then
  usage_error "DEVBOX_RUNNER points at this script, which would call itself without end"
fi
case "$ACTION" in
  drift|apply|watch|run)
    [[ -n "$DEVBOX_RUNNER" ]] || command -v jq >/dev/null \
      || die "needs jq to read the VM agent's state; install it, or set DEVBOX_RUNNER. Nothing was run." ;;
esac

# The `__` actions are this script re-entering itself under with-search-admin.sh, never something
# to type: on their own they run without a grant and answer 403.
case "$ACTION" in
  drift) do_drift ;;
  apply) do_apply ;;
  watch) do_watch ;;
  run) do_run ;;
  __drift-run|__dry-run|__apply-run|__put-datasources|__watch-run)
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
      __put-datasources) internal_put_datasources ;;
      __watch-run) internal_watch_run ;;
    esac
    ;;
  -h|--help|'') usage; [[ -n "$ACTION" ]] || exit 1 ;;
  *) echo "demi-devbox: unknown action '${ACTION}'" >&2; usage >&2; exit 1 ;;
esac
