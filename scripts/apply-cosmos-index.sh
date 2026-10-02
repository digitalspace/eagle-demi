#!/usr/bin/env bash
set -euo pipefail

# Apply one Cosmos container's indexing policy from azure/modules/cosmos-nosql.bicep, without a
# `deploy-infra.sh <env> --foundation --live` run (about 32 min on prod) for a one-field index change.

usage() {
  cat <<'EOF'
Usage: scripts/apply-cosmos-index.sh <test|prod> <container> [--live]
       scripts/apply-cosmos-index.sh extract <container>

Compiles azure/modules/cosmos-nosql.bicep, compares the indexing policy declared
for <container> with the live one on demi-cosmos-<env>/demi and prints a unified
diff. Dry run by default: applies nothing. --live applies the declared policy,
then re-reads the live one and checks it matches.

--live refuses while cosmos-nosql.bicep has uncommitted changes. Prod --live also
needs CONFIRM_PROD=yes, a successful fetch of origin/main, and cosmos-nosql.bicep
identical to origin/main. A prod dry run needs none of these.

extract prints the declared policy, normalised, and needs no Azure login.

Prints a WARNING, dry run or not, when the declared policy drops indexing:
removes an included path, a composite or spatial index, adds an excluded path,
or sets indexingMode none. --live refuses a container that sets
analyticalStorageTtl or computedProperties, which the update would drop.

Exit codes: 0 no drift, or applied and confirmed; 1 failure, including a diff
error and a live policy that still differs after --live; 2 bad usage or refused;
3 dry run found drift.

Throughput is never touched. Cosmos rebuilds the index in the background after
the update; queries on a newly added path can scan until it finishes.
EOF
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BICEP_REL='azure/modules/cosmos-nosql.bicep'
BICEP="${REPO_ROOT}/${BICEP_REL}"
DATABASE='demi'
CONTAINER_TYPE='Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers'

# Drop the nulls and empty arrays the service adds, and sort what carries no order. Paths inside
# one composite index keep their order; jq `sort` compares objects by sorted keys, so key order is moot.
NORMALISE=$(cat <<'JQ'
walk(if type == "object" then with_entries(select(.value != null and .value != [])) else . end)
| reduce ("includedPaths", "excludedPaths", "spatialIndexes", "fullTextIndexes", "vectorIndexes") as $k
    (.; if (.[$k] | type) == "array" then .[$k] |= sort_by(.path) else . end)
| if (.spatialIndexes | type) == "array"
  then .spatialIndexes |= map(if (.types | type) == "array" then .types |= sort else . end) else . end
| if (.compositeIndexes | type) == "array" then .compositeIndexes |= sort else . end
JQ
)

# Containers match on properties.resource.id, else on the last segment of the name, which the
# compiler writes as a literal path or as [format(..., '<container>')]. `..` also finds nested ones.
EXTRACT=$(cat <<'JQ'
def fail($msg): "\($msg)\n" | halt_error(1);
def last_name_segment:
  if startswith("[") then ((capture("'(?<n>[^']*)'\\)\\]$") | .n) // "") else split("/") | last end;
.variables as $vars
| [ .. | objects
    | select((.type? // "") as $t | $t == $type or $t == "containers")
    | select(.properties.resource.id? == $c or ((.name // "") | last_name_segment) == $c) ]
| if length == 0 then fail("container '\($c)' not found in cosmos-nosql.bicep")
  elif length > 1 then fail("container '\($c)' declared \(length) times in cosmos-nosql.bicep")
  else .[0].properties.resource.indexingPolicy end
| if . == null then fail("container '\($c)' declares no indexingPolicy") else . end
| walk(if type == "string" and test("^\\[variables\\('[^']+'\\)\\]$")
       then (capture("^\\[variables\\('(?<v>[^']+)'\\)\\]$") | .v) as $v
            | if ($vars | has($v)) then $vars[$v] else . end
       else . end)
| [.. | strings | select(startswith("["))] as $unresolved
| if ($unresolved | length) > 0
  then fail("indexingPolicy of '\($c)' holds unresolved ARM expressions: \($unresolved | unique | join(", "))")
  else . end
JQ
)

# Print the declared policy for one container, normalised. The test calls this through `extract`.
declared_policy() {
  local container="$1" compiled
  compiled=$(az bicep build --file "$BICEP" --stdout --only-show-errors)
  jq --arg c "$container" --arg type "$CONTAINER_TYPE" "$EXTRACT" <<<"$compiled" | jq -S "$NORMALISE"
}

# Write the live container resource to $1 and print its policy, normalised.
live_policy() {
  local out="$1" err="${WORK}/show.err"
  if ! az cosmosdb sql container show --subscription "$SUBSCRIPTION" -g "$RESOURCE_GROUP" \
    -a "$ACCOUNT" -d "$DATABASE" -n "$CONTAINER" --query resource -o json \
    --only-show-errors >"$out" 2>"$err"; then
    cat "$err" >&2
    if grep -Eqi 'not ?found' "$err"; then
      echo "✗ container ${CONTAINER} not found on ${ACCOUNT} (it may be conditional in bicep)" >&2
    else
      echo "✗ could not read container ${CONTAINER} on ${ACCOUNT}; see the az error above" >&2
    fi
    exit 1
  fi
  jq -S ".indexingPolicy | ${NORMALISE}" "$out"
}

# One line per change that drops indexing the live policy has. Normalised policies come in as
# $live and $decl (--slurpfile).
INDEX_LOSS=$(cat <<'JQ'
def paths($k): [(.[$k] // [])[] | .path];
$live[0] as $l | $decl[0] as $d
| ((($l | paths("includedPaths")) - ($d | paths("includedPaths")))[] | "removes included path \(.)"),
  ((($d | paths("excludedPaths")) - ($l | paths("excludedPaths")))[] | "adds excluded path \(.)"),
  ((($l | paths("spatialIndexes")) - ($d | paths("spatialIndexes")))[] | "removes spatial index \(.)"),
  ((($l.compositeIndexes // []) - ($d.compositeIndexes // []))[]
    | "removes composite index \(map(.path) | join(", "))"),
  (if $d.indexingMode == "none" and $l.indexingMode != "none" then "sets indexingMode none" else empty end)
JQ
)

# Diff a live policy against the declared one into $WORK/diff.txt: 0 same, 1 differs, else exit 1.
diff_policy() {
  local live_label="$1" live_file="$2" rc=0
  diff -u --label "$live_label" --label "declared cosmos-nosql.bicep" \
    "$live_file" "${WORK}/declared.json" >"${WORK}/diff.txt" || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "✗ diff failed (exit ${rc}) comparing the live and declared policies" >&2
    exit 1
  fi
  return "$rc"
}

for arg in "$@"; do
  case "$arg" in -h|--help) usage; exit 0 ;; esac
done

if [ "${1:-}" = 'extract' ]; then
  [ "$#" -eq 2 ] || { usage >&2; exit 2; }
  declared_policy "$2"
  exit 0
fi

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then usage >&2; exit 2; fi
ENVIRONMENT="$1"
CONTAINER="$2"
LIVE='false'
if [ "$#" -eq 3 ]; then
  [ "$3" = '--live' ] || { echo "✗ unknown argument '$3'" >&2; usage >&2; exit 2; }
  LIVE='true'
fi

# shellcheck source-path=SCRIPTDIR source=lib/azure-env.sh
source "${REPO_ROOT}/scripts/lib/azure-env.sh"
if ! demi_azure_env "$ENVIRONMENT"; then
  echo "✗ unknown environment '${ENVIRONMENT}'. Use: test | prod" >&2
  exit 2
fi
ACCOUNT="demi-cosmos-${ENVIRONMENT}"

if [ "$LIVE" = 'true' ]; then
  if [ "$ENVIRONMENT" = 'prod' ] && [ "${CONFIRM_PROD:-}" != 'yes' ]; then
    echo "✗ refusing to apply to prod. Export CONFIRM_PROD=yes if that is what you mean." >&2
    exit 2
  fi
  # A git error must refuse, not read as a clean tree.
  rc=0
  porcelain=$(git -C "$REPO_ROOT" status --porcelain -- "$BICEP_REL") || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "✗ refusing --live: git status failed (exit ${rc}) for ${BICEP_REL}" >&2
    exit 2
  fi
  if [ -n "$porcelain" ]; then
    echo "✗ refusing --live: ${BICEP_REL} has uncommitted changes. Commit them first." >&2
    exit 2
  fi
  if [ "$ENVIRONMENT" = 'prod' ]; then
    if ! git -C "$REPO_ROOT" fetch -q origin main; then
      echo "✗ refusing prod --live: git fetch origin main failed; cannot compare with origin/main" >&2
      exit 2
    fi
    # Compare content, not ancestry: an old checkout of main is an ancestor too, and would drop
    # indexes prod already has.
    rc=0
    git -C "$REPO_ROOT" diff --quiet origin/main -- "$BICEP_REL" || rc=$?
    if [ "$rc" -eq 1 ]; then
      echo "✗ refusing prod --live: cosmos-nosql.bicep differs from origin/main; merge or check out main first" >&2
      exit 2
    elif [ "$rc" -ne 0 ]; then
      echo "✗ refusing prod --live: git diff against origin/main failed (exit ${rc})" >&2
      exit 2
    fi
  fi
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

declared_policy "$CONTAINER" >"${WORK}/declared.json"
live_policy "${WORK}/live-resource.json" >"${WORK}/live.json"

TARGET="${ACCOUNT}/${DATABASE}/${CONTAINER}"
if diff_policy "live ${TARGET}" "${WORK}/live.json"; then
  echo "no change: ${TARGET} already matches cosmos-nosql.bicep"
  exit 0
fi
cat "${WORK}/diff.txt"

jq -n -r --slurpfile live "${WORK}/live.json" --slurpfile decl "${WORK}/declared.json" "$INDEX_LOSS" \
  | while IFS= read -r loss; do echo "WARNING: drops indexing: ${loss}" >&2; done

if [ "$LIVE" != 'true' ]; then
  echo
  echo "dry run: would apply the declared policy to ${TARGET}; rerun with --live"
  exit 3
fi

# The update rebuilds the container from a GET and does not carry these two over.
dropped=$(jq -r '[if .analyticalStorageTtl != null then "analyticalStorageTtl" else empty end,
  if (.computedProperties // []) != [] then "computedProperties" else empty end] | join(", ")' \
  "${WORK}/live-resource.json")
if [ -n "$dropped" ]; then
  echo "✗ refusing --live: ${TARGET} sets ${dropped}, which az cosmosdb sql container update drops" >&2
  exit 2
fi

echo
echo "applying to ${TARGET}"
az cosmosdb sql container update --subscription "$SUBSCRIPTION" -g "$RESOURCE_GROUP" \
  -a "$ACCOUNT" -d "$DATABASE" -n "$CONTAINER" --idx "@${WORK}/declared.json" -o none --only-show-errors

live_policy "${WORK}/after-resource.json" >"${WORK}/after.json"
if ! diff_policy "live ${TARGET} after update" "${WORK}/after.json"; then
  cat "${WORK}/diff.txt"
  echo "✗ live policy still differs from cosmos-nosql.bicep after the update" >&2
  exit 1
fi
echo "applied: ${TARGET} now matches cosmos-nosql.bicep; the index rebuilds in the background"
