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
# Each phase is ONE `az vm run-command invoke`, and each invoke is a 20-45 s ARM long poll. That is
# why the per-index steps are a loop inside one payload and why the indexer wait runs on the VM
# (`src/scripts/reset-and-run-indexers.js`) instead of a poll per tick from here: an apply is 3-4
# calls, a drift is 1. `--no-wait` stops after the run is posted, which is the only workable mode
# for chunks-indexer — run-command itself gives up after 90 minutes.
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
# this calls `az vm run-command invoke` itself), `DEVBOX_CHECKOUT` (default `/opt/eagle-demi`),
# `DS_RG` (Cosmos account's resource group, only needed when the subscription holds more than one
# account), `INDEXER_POLL_SLEEP`, `INDEXER_TIMEOUT`, `INDEXER_TIMEOUT_LONG`, `AZ` (the `az` seam the
# tests drive).
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
# chunks-indexer re-pulls ~1.1M rows. 80 minutes is as long as one wait can be: run-command stops
# at 90. Anything longer than that has to go through `--no-wait` plus `watch`.
INDEXER_TIMEOUT_LONG="${INDEXER_TIMEOUT_LONG:-4800}"

ENV_NAME='test'
ONLY=''
ASSUME_YES=0
DATASOURCES=''
NO_WAIT=0

usage() {
  cat <<'EOF'
Usage: scripts/demi-devbox.sh <drift|apply|watch> [--env test|prod] [--only <index,...>]
                              [--datasources <name,...>] [--yes] [--no-wait]

  drift    read-only: run apply-search-definitions.js --check on the devbox and exit 1 when a
           committed field is missing from the live index. Run it after any deploy that touches
           azure/search/ or search code, and before a prod release.
  apply    dry-run, print, confirm, then PUT the indexes, PUT the data sources whose committed
           SELECT differs, and reset + run those indexers. --yes skips the prompt.
  watch    read-only: wait for the current execution of the indexers that read --datasources.
           What to run after an `apply --no-wait`.

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

# The LAST DEMI_EXIT line of ONE call's output. Never hand this the output of several calls joined
# together: every exit line lands in the same text, so a grep for DEMI_EXIT=0 lets a clean step
# hide a failing one.
#
# Within one call a multi-step payload keeps its own `rc` across the loop and ends on
# `[ $rc -eq 0 ]`, so this single line is already every step's code and-ed together: a `--only a,b`
# run whose second index is clean cannot pass for the first. The DEMI_STEP lines are for the
# operator reading the output, not for the verdict.
remote_ok() {
  local last
  last="$(grep -o 'DEMI_EXIT=[0-9][0-9]*' <<<"$1" | tail -1 || true)"
  [[ "$last" == 'DEMI_EXIT=0' ]]
}

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
  if [[ -n "$DATASOURCES" ]]; then
    # Its own prompt, because this write lands before the one below: a `[y/N]` answered after the
    # data sources are already on the service cannot still mean "nothing was written".
    if [[ "$ASSUME_YES" -ne 1 ]]; then
      local pre_answer=''
      # The notice is its own echo: `read -p` prints nothing when stdin is not a terminal, and this
      # line is the record of what the answer was about.
      echo "demi-devbox: will PUT data source(s) ${DATASOURCES} before the dry run." >&2
      read -r -p "Proceed? [y/N] " pre_answer || pre_answer=''
      [[ "$pre_answer" == "y" || "$pre_answer" == "Y" ]] || die "aborted — nothing was written"
    fi
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
      echo "     projects if that is not what you meant, and --no-wait if it is: run-command gives"
      echo "     up after 90 minutes and the role grant stays open until it does."
    fi
  else
    echo "  - no data source differs, so no indexer reset"
  fi

  if [[ "$ASSUME_YES" -ne 1 ]]; then
    local answer=''
    read -r -p "Proceed? [y/N] " answer || answer=''
    [[ "$answer" == "y" || "$answer" == "Y" ]] || die "aborted — nothing was written"
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
  with_grant "$0" __watch-run --env "$ENV_NAME" --datasources "$DATASOURCES"
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
    -h|--help) usage; exit 0 ;;
    *) echo "demi-devbox: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

# The `__` actions are this script re-entering itself under with-search-admin.sh, never something
# to type: on their own they run without a grant and answer 403.
case "$ACTION" in
  drift) do_drift ;;
  apply) do_apply ;;
  watch) do_watch ;;
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
