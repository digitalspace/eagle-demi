#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/reseed-test.sh <step> [--run ID] [--live] [--approved A1,..] [--checkout PATH]
                              [--max-surplus N] [--past-shutdown-ok] [--max-wait SECONDS]
                              [--kind updates|comment-periods --ids FILE]

Re-seeds test DEMI from the prod public API, one runbook step at a time. Every remote call
goes through scripts/demi-devbox.sh run --env test. Prod is only read. There is no --env flag.

Steps, in runbook order:
  scripts/reseed-test.sh update        S0  git pull --ff-only in the devbox checkout, then
                                           yarn install --immutable when yarn.lock changed
  scripts/reseed-test.sh preflight     S0  local az, jq, curl; on the VM (read only): checkout
                                           HEAD, seed flags, the 3 secrets (lengths only), run
                                           dir writable. Creates the run id. Prints the minutes
                                           left before the 19:00 Pacific auto-shutdown
  scripts/reseed-test.sh baseline      S1  container counts, public snapshot, drift
  scripts/reseed-test.sh seed          S2  starts the detached seed; --live is S3
  scripts/reseed-test.sh public-reads  S4  starts the detached public reads
  scripts/reseed-test.sh objects       S5  starts the detached object dry scan (dry only)
  scripts/reseed-test.sh wait <step>       waits for seed, public-reads or objects, saves the
                                           summary, prints the gate verdict; non-zero on a
                                           failed gate
  scripts/reseed-test.sh logs <step>       prints the tail of a step's log on the VM
  scripts/reseed-test.sh residue       S6  lists test-only rows; --live deletes on the test site
  scripts/reseed-test.sh verify        S8  counts, public checks, probes, drift, checklist
  scripts/reseed-test.sh stop              deallocates the VM; refuses while a step runs
  scripts/reseed-test.sh manual            prints the A3 (objects live) and A6 (S7) commands

Every step is dry unless --live. --live needs, in the same run:
  seed          --approved A1,A4,A7,A9 (plus A2 with --max-surplus) and a passing dry run
  public-reads  a passing seed --live and a passing dry run
  residue       --approved A5, STAFF_TOKEN in the environment, --kind, --ids and a passing
                dry run
A passing dry run counts for 24 hours. seed and public-reads refuse --live when fewer than
90 or 30 minutes remain before 19:00 Pacific, unless --past-shutdown-ok. Accepted live
steps are appended to approvals.log in the local run dir.

A7: this tool reads Track test through the API only. For the 2026-08-31 snapshot or prod
Track, use https://github.com/digitalspace/eagle-demi/wiki/Runbook-Test-Reseed-Manual-Commands

Options:
  --run ID            run id; default: the run preflight last created
  --checkout PATH     devbox checkout (default /opt/eagle-demi); preflight records it per run
  --max-surplus N     seed: raise the reconcile ceiling (needs A2 for --live)
  --max-wait SECONDS  wait: give up after this long (default 7200)

Run dirs: /home/demi/reseed/<run>/ on the VM, ${RESEED_STATE:-$XDG_STATE_HOME/demi-reseed}/<run>/
here. Exit codes: 0 ok, 1 failed step or gate, 2 usage error or a refused --live.

Test seams: DEMI_DEVBOX, PUBLIC_CHECK, AZ, RESEED_STATE, RESEED_NOW (epoch), RESEED_PAUSE
(seconds between remote calls, default 120), RESEED_VM_ROOT, RESEED_KEYCLOAK_URL.
EOF
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AZ="${AZ:-az}"
DEMI_DEVBOX="${DEMI_DEVBOX:-${SCRIPT_DIR}/demi-devbox.sh}"
PUBLIC_CHECK="${PUBLIC_CHECK:-}"
STATE_ROOT="${RESEED_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/demi-reseed}"
VM_ROOT="${RESEED_VM_ROOT:-/home/demi/reseed}"
PAUSE="${RESEED_PAUSE:-120}"
KEEP_IDS_FILE="${SCRIPT_DIR}/reseed-keep-ids.txt"
MANUAL_PAGE='https://github.com/digitalspace/eagle-demi/wiki/Runbook-Test-Reseed-Manual-Commands'
VM='demi-devbox-test'
DEFAULT_CHECKOUT='/opt/eagle-demi'
# devbox_ready gives up after 1200 s and a second run-command gets 409, so a longer hold would
# kill another operator's call.
REMOTE_WAIT=900

# Payload env, one source each.
KEYCLOAK_URL="${RESEED_KEYCLOAK_URL:-https://test.loginproxy.gov.bc.ca/auth}" # azure/modules/api-function-flex.bicep keycloakUrl
KEYCLOAK_REALM='eao-epic'                                       # azure/modules/api-function-flex.bicep keycloakRealm
EAGLE_API_BASE='https://projects.eao.gov.bc.ca/api/public'      # azure/main.prod.bicepparam eagleApiBase (read only)
TRACK_API_BASE='https://epictrack-api-c8b80a-test.apps.gold.devops.gov.bc.ca' # azure/main.test.bicepparam trackApiBase
TRACK_CLIENT_ID='demi-track-reader'                             # azure/main.test.bicepparam trackClientId
MINIO_HOST='nrs.objectstore.gov.bc.ca'                          # azure/main.test.bicepparam minioHost
MINIO_PORT='443'                                                # azure/modules/api-function-flex.bicep MINIO_PORT
MINIO_USE_SSL='true'                                            # azure/modules/api-function-flex.bicep MINIO_USE_SSL
MINIO_BUCKET_NAME='zdspnb'                                      # azure/main.test.bicepparam minioBucketName
MINIO_KEY_PREFIX=''                                             # azure/main.test.bicepparam minioKeyPrefix
TEST_API='https://demi-api-fc-test.azurewebsites.net'
TEST_SEARCH='https://test.projects.eao.gov.bc.ca/demi-search'

STEP=''
TARGET=''
RUN=''
LIVE=0
APPROVED=''
CHECKOUT=''
MAX_SURPLUS=''
PAST_SHUTDOWN_OK=0
MAX_WAIT=7200
KIND=''
IDS=''
LAST_REMOTE=''
REMOTE_OUT=''
VM_RG=''

die() { echo "reseed-test: $*" >&2; exit 1; }
usage_error() { echo "reseed-test: $*" >&2; echo "Run scripts/reseed-test.sh --help" >&2; exit 2; }
refuse() { echo "reseed-test: refused: $*. Nothing was sent to the devbox." >&2; exit 2; }
note() { echo "reseed-test: $*" >&2; }

now() { echo "${RESEED_NOW:-$(date +%s)}"; }
utc() { date -u -d "@$(now)" +%Y-%m-%dT%H:%M:%SZ; }

minutes_to_shutdown() {
  local h m
  read -r h m < <(TZ=America/Vancouver date -d "@$(now)" '+%H %M')
  echo $(( (19 * 60 - (10#$h * 60 + 10#$m) + 1440) % 1440 ))
}

public_check() {
  if [[ -n "$PUBLIC_CHECK" ]]; then "$PUBLIC_CHECK" "$@"; else node "${SCRIPT_DIR}/reseed-public-check.js" "$@"; fi
}

# ---------------------------------------------------------------------------------------------
# Run dirs

local_dir() { echo "${STATE_ROOT}/${RUN}"; }
vm_dir() { echo "${VM_ROOT}/${RUN}"; }

use_run() {
  if [[ -z "$RUN" ]]; then
    [[ -f "${STATE_ROOT}/current" ]] || die "no run yet; start with scripts/reseed-test.sh preflight"
    RUN="$(cat "${STATE_ROOT}/current")"
  fi
  [[ -d "$(local_dir)" ]] || die "no local run dir $(local_dir); run preflight --run ${RUN} first"
  if [[ -z "$CHECKOUT" ]]; then
    CHECKOUT="$(cat "$(local_dir)/checkout" 2>/dev/null || echo "$DEFAULT_CHECKOUT")"
  fi
}

# Ids go into a shell payload, so only plain id characters pass.
keep_ids() {
  local ids
  ids="$(sed 's/#.*//' "$KEEP_IDS_FILE" | tr -d ' \t\r' | grep -v '^$' || true)"
  [[ -n "$ids" ]] || die "${KEEP_IDS_FILE} lists no id"
  grep -qvE '^[A-Za-z0-9_-]+$' <<<"$ids" && die "${KEEP_IDS_FILE} holds an id with characters outside [A-Za-z0-9_-]"
  tr '\n' ' ' <<<"$ids"
}

# ---------------------------------------------------------------------------------------------
# Remote calls

# Leaves the call's output in REMOTE_OUT and returns the payload's exit code, or 255 when no
# DEMI_EXIT came back (409, or output lost), which callers treat as "did not run".
remote() {
  if [[ -n "$LAST_REMOTE" && "$PAUSE" -gt 0 ]]; then
    note "pausing ${PAUSE}s so other devbox callers find a gap"
    sleep "$PAUSE"
  fi
  LAST_REMOTE=1
  local code
  REMOTE_OUT="$(DEVBOX_KEEP_RUNNING=1 DEVBOX_CHECKOUT="$CHECKOUT" "$DEMI_DEVBOX" run --env test -- "$1" 2>&1)" || true
  code="$(grep -o 'DEMI_EXIT=[0-9][0-9]*' <<<"$REMOTE_OUT" | tail -1 | cut -d= -f2 || true)"
  [[ -n "$code" ]] || return 255
  return "$code"
}

# One subshell, so a guard's `exit` still reaches the DEMI_EXIT line demi-devbox.sh appends.
payload() { printf '(\n%s\n)' "$1"; }

# Ends in `;`, not a newline: `$(env_exports)` strips the newline and glues on the next statement.
# %q output needs bash: demi-run on the VM runs the payload with `bash -lc`.
env_exports() {
  printf 'export KEYCLOAK_URL=%q KEYCLOAK_REALM=%q EAGLE_API_BASE=%q TRACK_API_BASE=%q TRACK_CLIENT_ID=%q MINIO_HOST=%q MINIO_PORT=%q MINIO_USE_SSL=%q MINIO_BUCKET_NAME=%q MINIO_KEY_PREFIX=%q;' \
    "$KEYCLOAK_URL" "$KEYCLOAK_REALM" "$EAGLE_API_BASE" "$TRACK_API_BASE" "$TRACK_CLIENT_ID" \
    "$MINIO_HOST" "$MINIO_PORT" "$MINIO_USE_SSL" "$MINIO_BUCKET_NAME" "$MINIO_KEY_PREFIX"
}

# `$1` variable, `$2` Key Vault secret name. Read on the VM by its identity; never echoed.
secret_read() {
  printf '%s=$(az keyvault secret show --vault-name demi-kv-test -n %s --query value -o tsv)\n[ -n "$%s" ] || exit 3\nexport %s\n' \
    "$1" "$2" "$1" "$1"
}

boot_id_cmd='cat /proc/sys/kernel/random/boot_id'

# Exit 4 when a pid file of this step names a live process from this boot.
busy_guard() {
  printf 'for p in %s/%s-*.pid; do [ -f "$p" ] || continue; pid=$(sed -n 1p "$p"); boot=$(sed -n 2p "$p"); if [ "$boot" = "$(%s)" ] && kill -0 "$pid" 2>/dev/null; then echo "RESEED_BUSY $p pid $pid"; exit 4; fi; done\n' \
    "$(vm_dir)" "$1" "$boot_id_cmd"
}

# Read only: prints RESEED_ALIVE for every pid file of any run naming a live process.
alive_scan() {
  printf 'for p in %s/*/*.pid; do [ -f "$p" ] || continue; pid=$(sed -n 1p "$p"); boot=$(sed -n 2p "$p"); if [ "$boot" = "$(%s)" ] && kill -0 "$pid" 2>/dev/null; then echo "RESEED_ALIVE $p pid $pid"; fi; done\n' \
    "$VM_ROOT" "$boot_id_cmd"
}

vm_rg() {
  [[ -z "$VM_RG" ]] || return 0
  # shellcheck source-path=SCRIPTDIR source=lib/azure-env.sh
  source "${SCRIPT_DIR}/lib/azure-env.sh"
  demi_azure_env test
  VM_RG="$("$AZ" resource list --subscription "$SUBSCRIPTION" \
    --resource-type Microsoft.Compute/virtualMachines \
    --query "[?name=='${VM}'].resourceGroup | [0]" -o tsv)" || die "could not look up ${VM}; see the az error above"
  [[ -n "$VM_RG" ]] || die "devbox VM ${VM} not found in subscription ${SUBSCRIPTION}"
}

power_state() {
  "$AZ" vm get-instance-view --subscription "$SUBSCRIPTION" -g "$VM_RG" -n "$VM" \
    --query "instanceView.statuses[?starts_with(code,'PowerState/')].code | [0]" -o tsv \
    | sed 's|^PowerState/||'
}

# wait and logs must not start a deallocated VM: demi-devbox.sh run would.
require_running() {
  vm_rg
  local p
  p="$(power_state)" || die "could not read the power state of ${VM}"
  [[ "$p" == 'running' ]] || die "${VM} is ${p:-in an unknown state}; not starting it. A step started before the VM stopped is gone: start the step again"
}

# ---------------------------------------------------------------------------------------------
# Live gates

check_live() {
  local step="$1" min_left="$2"; shift 2
  local need missing=()
  for need in "$@"; do
    [[ ",${APPROVED}," == *",${need},"* ]] || missing+=("$need")
  done
  ((${#missing[@]} == 0)) || refuse "${step} --live needs --approved covering ${*}; missing ${missing[*]}"
  local pass
  pass="$(local_dir)/${step}.dry-pass"
  [[ -f "$pass" ]] || refuse "${step} --live needs a passing dry run of ${step} in run ${RUN} (scripts/reseed-test.sh ${step}, then wait ${step})"
  (( $(now) - $(cat "$pass") <= 86400 )) || refuse "the passing dry run of ${step} in run ${RUN} is older than 24 hours; run it again"
  local left=''
  if [[ -n "$min_left" ]]; then
    left="$(minutes_to_shutdown)"
    if (( left < min_left )); then
      ((PAST_SHUTDOWN_OK)) || refuse "${left} minutes remain before the 19:00 Pacific auto-shutdown and ${step} needs about ${min_left}; pass --past-shutdown-ok to start anyway"
    fi
  fi
  local line
  line="$(utc) ${USER:-$(id -un)} step=${step} approved=${APPROVED:-none}"
  if [[ -n "$left" ]] && (( left < min_left )); then line+=" past-shutdown-ok minutes-left=${left}"; fi
  echo "$line" >> "$(local_dir)/approvals.log"
}

# ---------------------------------------------------------------------------------------------
# Detached steps

# `$1` step, `$2` setup lines (exports, secret reads), `$3` the node command, without redirects.
start_detached() {
  local step="$1" setup="$2" cmd="$3" mode='dry' d f rc=0
  ((LIVE)) && mode='live'
  d="$(vm_dir)"; f="${d}/${step}-${mode}"
  local ids
  ids="$(keep_ids)"
  remote "$(payload "$(busy_guard "$step")
mkdir -p ${d}
printf '%s\n' ${ids} > ${d}/keep-ids.txt
${setup}
rm -f ${f}.rc ${f}.summary.json
setsid nohup bash -c '${cmd}; echo \$? > ${f}.rc' > ${f}.log 2>&1 < /dev/null &
echo \$! > ${f}.pid
${boot_id_cmd} >> ${f}.pid
echo RESEED_STARTED ${step} ${mode} pid \$!")" || rc=$?
  printf '%s\n' "$REMOTE_OUT"
  case "$rc" in
    0) ;;
    3) die "a Key Vault secret read empty on the VM; ${step} did not start" ;;
    4) die "${step} is still running in run ${RUN}; wait for it (scripts/reseed-test.sh wait ${step})" ;;
    255) die "${step} may not have started (no DEMI_EXIT came back); check with scripts/reseed-test.sh logs ${step} before starting again" ;;
    *) die "${step} did not start: exit ${rc}" ;;
  esac
  local l
  l="$(local_dir)"
  rm -f "${l}/${step}-${mode}.summary.json" "${l}/${step}-${mode}.rc" "${l}/${step}.${mode}-pass"
  echo "$mode" > "${l}/${step}.mode"
  echo "${step} ${mode} started in run ${RUN}. Next: scripts/reseed-test.sh wait ${step} --run ${RUN}"
}

step_seed() {
  echo "A7: Track test API only. Snapshot or prod Track: ${MANUAL_PAGE}"
  if ((LIVE)); then
    local need=(A1 A4 A7 A9)
    [[ -z "$MAX_SURPLUS" ]] || need+=(A2)
    check_live seed 90 "${need[@]}"
  fi
  local d mode='dry' args
  ((LIVE)) && mode='live'
  d="$(vm_dir)"
  args="--reconcile --keep-ids ${d}/keep-ids.txt --summary ${d}/seed-${mode}.summary.json"
  ((LIVE)) && args+=' --live'
  [[ -z "$MAX_SURPLUS" ]] || args+=" --max-surplus ${MAX_SURPLUS}"
  start_detached seed "$(env_exports)export RECONCILE_LOG=${d}/reconcile-seed-${mode}.ndjson
$(secret_read TRACK_CLIENT_SECRET track-client-secret)" \
    "node src/scripts/seed-nosql.js ${args}"
}

step_public_reads() {
  if ((LIVE)); then
    [[ -f "$(local_dir)/seed.live-pass" ]] || refuse "public-reads --live needs a passing seed --live in run ${RUN}"
    check_live public-reads 30
  fi
  local d mode='dry' args
  ((LIVE)) && mode='live'
  d="$(vm_dir)"
  args="--state ${d}/public-reads-${mode}.state.json --summary ${d}/public-reads-${mode}.summary.json"
  ((LIVE)) && args+=' --live'
  start_detached public-reads "export EAGLE_API_BASE=${EAGLE_API_BASE}" \
    "node src/scripts/seed-public-reads.js ${args}"
}

step_objects() {
  ((LIVE)) && refuse "objects --live is A3 and stays manual; see scripts/reseed-test.sh manual"
  start_detached objects "$(env_exports)$(secret_read MINIO_ACCESS_KEY minio-access-key)
$(secret_read MINIO_SECRET_KEY minio-secret-key)" "node src/scripts/backfill-objects.js"
}

# ---------------------------------------------------------------------------------------------
# wait and its gates

SEED_GATE='
def n: if type == "array" then length elif type == "number" then . else 0 end;
(.failures // [] | .[] | "FAIL seed failure: \(.)"),
(if (.track.source // "missing") != "api"
  then "FAIL track.source is \(.track.source // "missing"), not api: the Track secret or exports did not reach the run" else empty end),
(.keep // [] | .[] | select(.trackProjectId != null)
  | "FAIL keep id \(.id) matches Track project \(.trackProjectId): stop for A9"),
(.keep // [] | .[] | select(.surplus == true and .kept != true) | "FAIL keep id \(.id) is listed for delete"),
(.keep // [] | .[] | select(.rowId == null) | "NOTE keep id \(.id) has no row in test DEMI"),
(if .reconcile != null and ([.failures // [] | .[] | tostring
    | select(test("^--reconcile refused .* exceeds the ceiling "))] | length) > 0
  then "NEED --max-surplus \([.reconcile.documents, .reconcile.projects | select(. != null)
    | ((.wouldDelete | n) + (.wouldKeep | n))] | max) (wouldDelete + wouldKeep of the larger container; needs A2)"
  else empty end)'

# A dry run drops every comment of a period not mirrored yet, so a drop is a NOTE there; in --live
# the parents were mirrored first, so a drop means a parent is missing from DEMI and FAILs.
PUBLIC_READS_GATE='
. as $sum
| ($sum.stages // {} | to_entries[] | select((.value.errors // 0) > 0)
  | "FAIL stage \(.key) errors=\(.value.errors)"),
  ($sum.unfinished // [] | .[] | select(. as $s | ($sum.stages // {}) | has($s) | not)
  | "FAIL stage unfinished: \(.) (it threw before reporting counts)"),
  ($sum.unfinished // [] | .[] | . as $s | select(($sum.stages // {}) | has($s))
  | select(($sum.stages[$s].errors // 0) == 0 and ($sum.stages[$s].dropped // 0) == 0)
  | "FAIL stage \(.) unfinished, reason unknown"),
  ($sum.stages // {} | to_entries[] | select((.value.errors // 0) == 0 and (.value.dropped // 0) > 0)
  | if $sum.live == true
    then "FAIL \(.key) dropped=\(.value.dropped) in --live (rows whose parent is missing from DEMI)"
    else "NOTE \(.key) dropped=\(.value.dropped) (rows whose parent is not in DEMI)" end)'

# `$1` step; reads the saved summary, prints verdict lines, returns 1 on any FAIL.
gate() {
  local step="$1" rc="$2" sum="$3" lines=''
  [[ "$rc" == '0' ]] || lines+="FAIL ${step} exited ${rc}"$'\n'
  case "$step" in
    seed|public-reads)
      local prog="$SEED_GATE"
      [[ "$step" == 'seed' ]] || prog="$PUBLIC_READS_GATE"
      if [[ -s "$sum" ]] && jq -e 'type == "object"' "$sum" >/dev/null 2>&1; then
        lines+="$(jq -r "$prog" "$sum" 2>&1 || echo "FAIL the ${step} summary does not have the expected shape")"$'\n'
      else
        lines+="FAIL no readable summary from ${step}"$'\n'
      fi ;;
    objects)
      local failed planned
      failed="$(grep -o 'failed=[0-9]*' "$sum" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
      planned="$(grep -o 'planned=[0-9]*' "$sum" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
      if [[ -z "$failed" ]]; then lines+="FAIL no summary line from objects"$'\n'
      elif ((failed > 0)); then lines+="FAIL objects failed=${failed}"$'\n'; fi
      if [[ -n "$planned" ]] && ((planned > 0)); then
        lines+="NOTE planned=${planned} objects are missing: A3 decides the live copy"$'\n'
        print_a3
      fi ;;
  esac
  lines="$(grep -v '^$' <<<"$lines" || true)"
  [[ -z "$lines" ]] || echo "$lines"
  ! grep -q '^FAIL' <<<"$lines"
}

step_wait() {
  case "$TARGET" in
    seed|public-reads|objects) ;;
    *) usage_error "wait takes seed, public-reads or objects" ;;
  esac
  local l mode f
  l="$(local_dir)"
  [[ -f "${l}/${TARGET}.mode" ]] || die "${TARGET} was not started in run ${RUN}"
  mode="$(cat "${l}/${TARGET}.mode")"
  f="$(vm_dir)/${TARGET}-${mode}"
  local summary_cmd="head -c 3500 ${f}.summary.json"
  [[ "$TARGET" != 'objects' ]] || summary_cmd="grep -o 'mode=[a-z-]* transfer=.*failed=[0-9]*' ${f}.log | tail -1"
  local body
  body="[ -f ${f}.pid ] || { echo RESEED_STATE=missing; exit 0; }
pid=\$(sed -n 1p ${f}.pid); boot=\$(sed -n 2p ${f}.pid)
timeout ${REMOTE_WAIT} bash -c \"until [ -s ${f}.rc ]; do [ \\\"\\\$(${boot_id_cmd})\\\" = \\\"\$boot\\\" ] && kill -0 \$pid 2>/dev/null || exit 0; sleep 30; done\"
if [ -s ${f}.rc ]; then echo RESEED_RC=\$(cat ${f}.rc); echo RESEED_SUMMARY_BEGIN; ${summary_cmd}; echo; echo RESEED_SUMMARY_END
elif [ \"\$(${boot_id_cmd})\" != \"\$boot\" ]; then echo RESEED_STATE=rebooted
elif ! kill -0 \$pid 2>/dev/null; then echo RESEED_STATE=died
else echo RESEED_STATE=running; fi"
  local start=$SECONDS out rc
  while :; do
    require_running
    rc=0
    remote "$(payload "$body")" || rc=$?
    out="$REMOTE_OUT"
    if ((rc == 255)); then
      note "the wait call did not run (409 or no DEMI_EXIT); retrying"
    elif ((rc != 0)); then
      printf '%s\n' "$out" | tail -n 20
      die "the wait call failed on the VM with exit ${rc}"
    elif grep -q '^RESEED_RC=' <<<"$out"; then
      local code sum="${l}/${TARGET}-${mode}.summary.json"
      code="$(grep -o '^RESEED_RC=[0-9]*' <<<"$out" | tail -1 | cut -d= -f2)"
      echo "$code" > "${l}/${TARGET}-${mode}.rc"
      sed -n '/^RESEED_SUMMARY_BEGIN$/,/^RESEED_SUMMARY_END$/p' <<<"$out" | sed '1d;$d' | grep -v '^$' > "$sum" || true
      echo "${TARGET} ${mode} finished with exit ${code}; summary ${sum}"
      if gate "$TARGET" "$code" "$sum"; then
        now > "${l}/${TARGET}.${mode}-pass"
        echo "PASS ${TARGET} ${mode}"
        echo "When no other step is running: scripts/reseed-test.sh stop"
        return 0
      fi
      echo "When no other step is running: scripts/reseed-test.sh stop"
      die "${TARGET} ${mode} failed its gate"
    elif grep -q '^RESEED_STATE=running' <<<"$out"; then
      note "${TARGET} ${mode} still running after $((SECONDS - start))s"
    else
      local state
      state="$(grep -o '^RESEED_STATE=[a-z]*' <<<"$out" | tail -1 | cut -d= -f2 || true)"
      case "$state" in
        rebooted) die "the VM rebooted since ${TARGET} started; the run is gone, start it again" ;;
        died) die "${TARGET} died without writing an exit code; read scripts/reseed-test.sh logs ${TARGET}" ;;
        missing) die "no pid file for ${TARGET} ${mode} on the VM" ;;
        *) printf '%s\n' "$out" | tail -n 20; die "unreadable answer from the wait call" ;;
      esac
    fi
    ((SECONDS - start < MAX_WAIT)) || die "${TARGET} not finished after --max-wait ${MAX_WAIT}s; run wait again"
  done
}

step_logs() {
  case "$TARGET" in
    seed|public-reads|objects) ;;
    *) usage_error "logs takes seed, public-reads or objects" ;;
  esac
  local mode
  mode="$(cat "$(local_dir)/${TARGET}.mode" 2>/dev/null)" || die "${TARGET} was not started in run ${RUN}"
  require_running
  local rc=0
  remote "$(payload "tail -n 30 $(vm_dir)/${TARGET}-${mode}.log | cut -c1-120")" || rc=$?
  printf '%s\n' "$REMOTE_OUT"
  ((rc == 0)) || die "logs call failed (exit ${rc})"
}

# ---------------------------------------------------------------------------------------------
# Other steps

step_update() {
  CHECKOUT="${CHECKOUT:-$DEFAULT_CHECKOUT}"
  local rc=0
  remote "$(payload 'old=$(git rev-parse HEAD)
git pull --ff-only || exit $?
new=$(git rev-parse HEAD)
echo "checkout $old -> $new"
if ! git diff --quiet "$old" "$new" -- yarn.lock; then yarn install --immutable || exit $?; fi')" || rc=$?
  printf '%s\n' "$REMOTE_OUT"
  ((rc == 0)) || die "update failed on the VM (exit ${rc})"
}

step_preflight() {
  "$AZ" account show -o none || die "az is not logged in: az login"
  command -v jq >/dev/null || die "needs jq"
  command -v curl >/dev/null || die "needs curl"
  RUN="${RUN:-$(date -u -d "@$(now)" +%Y%m%dT%H%M%SZ)}"
  CHECKOUT="${CHECKOUT:-$DEFAULT_CHECKOUT}"
  mkdir -p "$(local_dir)"
  echo "$CHECKOUT" > "$(local_dir)/checkout"
  echo "$RUN" > "${STATE_ROOT}/current"
  local rc=0
  remote "$(payload "echo \"checkout $CHECKOUT at \$(git rev-parse --short HEAD) \$(git log -1 --format=%cs)\"
grep -q -- '--keep-ids' src/scripts/seed-nosql.js && grep -q -- '--summary' src/scripts/seed-nosql.js || { echo 'RESEED_FAIL seed-nosql.js lacks --keep-ids or --summary: run update after A10'; exit 1; }
[ -f src/scripts/count-containers.js ] || { echo 'RESEED_FAIL src/scripts/count-containers.js missing: run update after A10'; exit 1; }
[ -w ${VM_ROOT} ] || [ -w \$(dirname ${VM_ROOT}) ] || { echo 'RESEED_FAIL ${VM_ROOT} not writable'; exit 1; }
$(secret_read TRACK_CLIENT_SECRET track-client-secret)
$(secret_read MINIO_ACCESS_KEY minio-access-key)
$(secret_read MINIO_SECRET_KEY minio-secret-key)
echo \"secret lengths: track-client-secret \${#TRACK_CLIENT_SECRET}, minio-access-key \${#MINIO_ACCESS_KEY}, minio-secret-key \${#MINIO_SECRET_KEY}\"")" || rc=$?
  printf '%s\n' "$REMOTE_OUT"
  echo "run ${RUN}; local dir $(local_dir)"
  echo "$(minutes_to_shutdown) minutes left before the 19:00 Pacific auto-shutdown (seed needs about 90, public-reads 30)"
  ((rc == 0)) || die "preflight failed (exit ${rc})"
  echo "preflight passed"
}

# Prints the counts JSON line from count-containers into `$1`.
remote_counts() {
  local rc=0 d
  d="$(vm_dir)"
  remote "$(payload "mkdir -p ${d}
printf '%s\n' $(keep_ids) > ${d}/keep-ids.txt
timeout ${REMOTE_WAIT} node src/scripts/count-containers.js --keep-ids ${d}/keep-ids.txt")" || rc=$?
  grep '^{' <<<"$REMOTE_OUT" | tail -1 > "$1" || true
  ((rc == 0)) && [[ -s "$1" ]] || { tail -n 20 <<<"$REMOTE_OUT"; return 1; }
}

# drift pulls /opt/eagle-demi and takes a search role grant, so only that checkout runs it.
run_drift() {
  local out_file="$1" rc=0
  if [[ "$CHECKOUT" != "$DEFAULT_CHECKOUT" ]]; then
    note "WARN drift skipped: checkout is ${CHECKOUT}, not ${DEFAULT_CHECKOUT}"
    return 0
  fi
  [[ -z "$LAST_REMOTE" || "$PAUSE" -eq 0 ]] || sleep "$PAUSE"
  LAST_REMOTE=1
  DEVBOX_KEEP_RUNNING=1 "$DEMI_DEVBOX" drift --env test > "$out_file" 2>&1 || rc=$?
  tail -n 5 "$out_file"
  if ((rc != 0)) && grep -q 'cannot read role assignments' "$out_file"; then
    note "WARN drift skipped: the az Graph token has expired (see ${out_file})"
    return 0
  fi
  return "$rc"
}

step_baseline() {
  local b fails=0
  b="$(local_dir)/baseline"; mkdir -p "$b"
  remote_counts "${b}/counts.json" || { note "FAIL count-containers"; fails=1; }
  public_check snapshot --out "$b" --keep-ids "$KEEP_IDS_FILE" || { note "FAIL public snapshot"; fails=1; }
  local probe_rc=0
  "${SCRIPT_DIR}/search-data-probe.sh" "$TEST_API" > "${b}/data-probe.txt" 2>&1 || probe_rc=$?
  echo "$probe_rc" > "${b}/data-probe.rc"
  ((probe_rc == 0)) || note "NOTE data probe failed at baseline (recorded; verify flags only new failures)"
  run_drift "${b}/drift.txt" || { note "FAIL drift"; fails=1; }
  ((fails == 0)) || die "baseline incomplete; saved what ran to ${b}"
  echo "baseline saved to ${b}"
}

step_residue() {
  local r
  r="$(local_dir)/residue"
  if ((LIVE)); then
    [[ -n "${STAFF_TOKEN:-}" ]] || refuse "residue --live needs STAFF_TOKEN, minted by the operator"
    [[ "$KIND" == 'updates' || "$KIND" == 'comment-periods' ]] || refuse "residue --live needs --kind updates|comment-periods"
    [[ -n "$IDS" && -f "$IDS" ]] || refuse "residue --live needs --ids FILE"
    check_live residue '' A5
    mkdir -p "$r"
    public_check residue --live --kind "$KIND" --ids "$IDS" --out "$r" --keep-ids "$KEEP_IDS_FILE" \
      || die "residue delete failed"
    return 0
  fi
  mkdir -p "$r"
  public_check residue --out "$r" --keep-ids "$KEEP_IDS_FILE" || die "residue listing failed"
  now > "$(local_dir)/residue.dry-pass"
  echo "residue lists saved to ${r}. A5 decides which ids residue --live deletes (--ids ${r}/ids-updates.txt or ids-comment-periods.txt)."
}

step_verify() {
  local v l fails=0
  l="$(local_dir)"; v="${l}/verify"; mkdir -p "$v"
  if remote_counts "${v}/counts.json"; then
    local behind
    behind="$(jq -r '.indexProgress // {} | to_entries[] | select((.value | type) == "number" and .value < 100) | "\(.key) \(.value)"' "${v}/counts.json")"
    [[ -z "$behind" ]] || { note "FAIL index progress below 100: ${behind//$'\n'/, }; run verify again later"; fails=1; }
  else
    note "FAIL count-containers"; fails=1
  fi
  local seed_sum=()
  [[ ! -f "${l}/seed-live.summary.json" ]] || seed_sum=(--seed-summary "${l}/seed-live.summary.json")
  public_check verify --out "$v" --baseline "${l}/baseline" "${seed_sum[@]}" || { note "FAIL public checks"; fails=1; }
  "${SCRIPT_DIR}/search-schema-probe.sh" "$TEST_API" || { note "FAIL schema probe"; fails=1; }
  if ! "${SCRIPT_DIR}/search-data-probe.sh" "$TEST_API"; then
    if [[ "$(cat "${l}/baseline/data-probe.rc" 2>/dev/null || echo 0)" != '0' ]]; then
      note "NOTE data probe fails as it did at baseline; compare with ${l}/baseline/data-probe.txt"
    else
      note "FAIL data probe (passed at baseline)"; fails=1
    fi
  fi
  "${SCRIPT_DIR}/search-smoke.sh" "$TEST_SEARCH" || { note "FAIL search smoke"; fails=1; }
  run_drift "${v}/drift.txt" || { note "FAIL drift"; fails=1; }
  ((fails == 0)) || die "verify failed; results in ${v}"
  echo "verify passed; results in ${v}"
}

step_stop() {
  vm_rg
  local p
  p="$(power_state)" || die "could not read the power state of ${VM}"
  case "$p" in
    deallocated|stopped) echo "${VM} is already ${p}"; return 0 ;;
    running) ;;
    *) die "${VM} is ${p:-in an unknown state}; run stop again once it settles" ;;
  esac
  CHECKOUT="${CHECKOUT:-$DEFAULT_CHECKOUT}"
  local out rc=0
  remote "$(payload "$(alive_scan)")" || rc=$?
  out="$REMOTE_OUT"
  ((rc == 0)) || { printf '%s\n' "$out" | tail -n 20; die "could not check for running steps; not stopping"; }
  if grep -q '^RESEED_ALIVE' <<<"$out"; then
    grep '^RESEED_ALIVE' <<<"$out"
    die "a step is still running; not stopping ${VM}"
  fi
  "$AZ" vm deallocate --subscription "$SUBSCRIPTION" -g "$VM_RG" -n "$VM" -o none \
    || die "deallocate failed; see the az error above"
  echo "${VM} deallocated"
}

print_a3() {
  cat <<'EOF'
A3, objects live copy, by hand on the devbox. Stage the prod key from secret
nr-object-store-credential (6cdc9e-prod) into /home/demi/.minio-env, then:
  sudo -u demi /usr/local/bin/demi-run 'cd /opt/eagle-demi && set -a && . /home/demi/.minio-env && set +a && node src/scripts/backfill-objects.js --probe'
  sudo -u demi /usr/local/bin/demi-run 'cd /opt/eagle-demi && set -a && . /home/demi/.minio-env && set +a && node src/scripts/backfill-objects.js --since 1970-01-01 --live'
Run the live copy detached with a log, expect failed=0, then delete /home/demi/.minio-env.
EOF
}

step_manual() {
  print_a3
  cat <<'EOF'

A6, S7 enrichment, by hand from the EPIC workspace scripts folder:
  python3 epic-backfill-projects.py --missing 2>&1 | tail -n 60
  python3 epic-backfill-projects.py --apply <id> [<id> ...]
Then from the test eagle-api pod:
  node scripts/demi-repush.js --kinds project --concurrency 1 --ids-file <file> --live
EOF
  echo "A7 snapshot or prod Track: ${MANUAL_PAGE}"
}

# ---------------------------------------------------------------------------------------------

[[ $# -gt 0 ]] || { usage >&2; exit 2; }
case "$1" in
  -h|--help) usage; exit 0 ;;
esac
STEP="$1"; shift
if [[ "$STEP" == 'wait' || "$STEP" == 'logs' ]]; then
  [[ $# -gt 0 && "$1" != --* ]] || usage_error "${STEP} needs a step: seed, public-reads or objects"
  TARGET="$1"; shift
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run) RUN="${2:-}"; shift 2 || usage_error "--run needs an id" ;;
    --live) LIVE=1; shift ;;
    --approved) APPROVED="${2:-}"; shift 2 || usage_error "--approved needs a list" ;;
    --checkout) CHECKOUT="${2:-}"; shift 2 || usage_error "--checkout needs a path" ;;
    --max-surplus) MAX_SURPLUS="${2:-}"; shift 2 || usage_error "--max-surplus needs a number" ;;
    --past-shutdown-ok) PAST_SHUTDOWN_OK=1; shift ;;
    --max-wait) MAX_WAIT="${2:-}"; shift 2 || usage_error "--max-wait needs seconds" ;;
    --kind) KIND="${2:-}"; shift 2 || usage_error "--kind needs a value" ;;
    --ids) IDS="${2:-}"; shift 2 || usage_error "--ids needs a file" ;;
    -h|--help) usage; exit 0 ;;
    *) usage_error "unknown argument '$1'" ;;
  esac
done

[[ -z "$RUN" || "$RUN" =~ ^[A-Za-z0-9._-]+$ ]] || usage_error "--run takes letters, digits, '.', '_' and '-'"
[[ -z "$CHECKOUT" || "$CHECKOUT" =~ ^/[A-Za-z0-9._/-]+$ ]] || usage_error "--checkout takes an absolute path"
[[ "$VM_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] || usage_error "RESEED_VM_ROOT must be an absolute path"
[[ -z "$APPROVED" || "$APPROVED" =~ ^A[0-9]+(,A[0-9]+)*$ ]] || usage_error "--approved takes A1,A4,..."
[[ -z "$MAX_SURPLUS" || "$MAX_SURPLUS" =~ ^[1-9][0-9]*$ ]] || usage_error "--max-surplus takes a positive whole number"
[[ "$MAX_WAIT" =~ ^[0-9]+$ ]] || usage_error "--max-wait takes seconds"
[[ "$PAUSE" =~ ^[0-9]+$ ]] || usage_error "RESEED_PAUSE takes seconds"
[[ -z "$MAX_SURPLUS" || "$STEP" == 'seed' ]] || usage_error "--max-surplus belongs to seed"
((LIVE == 0)) || [[ "$STEP" =~ ^(seed|public-reads|objects|residue)$ ]] || usage_error "--live belongs to seed, public-reads or residue"
command -v jq >/dev/null || die "needs jq"

case "$STEP" in
  update) step_update ;;
  preflight) step_preflight ;;
  stop) step_stop ;;
  manual) step_manual ;;
  baseline|seed|public-reads|objects|wait|logs|residue|verify)
    use_run
    case "$STEP" in
      baseline) step_baseline ;;
      seed) step_seed ;;
      public-reads) step_public_reads ;;
      objects) step_objects ;;
      wait) step_wait ;;
      logs) step_logs ;;
      residue) step_residue ;;
      verify) step_verify ;;
    esac ;;
  *) usage_error "unknown step '${STEP}'" ;;
esac
