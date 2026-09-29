#!/usr/bin/env bash
set -euo pipefail

# Apply one Cosmos container's indexing policy from azure/modules/cosmos-nosql.bicep, without a
# `deploy-infra.sh <env> --foundation --live` run (about 32 min on prod) for a one-field index change.

usage() {
  cat <<'EOF'
Usage: scripts/apply-cosmos-index.sh <test|prod> <container> [--live]
       scripts/apply-cosmos-index.sh extract <container>

Compares the indexing policy declared for <container> in
azure/modules/cosmos-nosql.bicep with the live one on demi-cosmos-<env>/demi and
prints a unified diff. Dry run by default: prints the update command, runs
nothing. --live runs it, then re-reads the live policy and checks it matches.
Prod --live also needs CONFIRM_PROD=yes.

extract prints the declared policy, normalised, and needs no Azure login.

Throughput is never touched. Cosmos rebuilds the index in the background after
the update; queries on a newly added path can scan until it finishes.
EOF
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BICEP="${REPO_ROOT}/azure/modules/cosmos-nosql.bicep"
DATABASE='demi'
CONTAINER_TYPE='Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers'

# Same shape for both sides, so a diff shows only real differences: the service returns nulls and
# empty arrays the template never declares, and path order carries no meaning. compositeIndexes
# keeps its order, because the path order inside a composite index does.
NORMALISE=$(cat <<'JQ'
walk(if type == "object" then with_entries(select(.value != null and .value != [])) else . end)
| reduce ("includedPaths", "excludedPaths", "spatialIndexes", "fullTextIndexes", "vectorIndexes") as $k
    (.; if (.[$k] | type) == "array" then .[$k] |= sort_by(.path) else . end)
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

live_policy() {
  az cosmosdb sql container show --subscription "$SUBSCRIPTION" -g "$RESOURCE_GROUP" \
    -a "$ACCOUNT" -d "$DATABASE" -n "$CONTAINER" --query resource.indexingPolicy -o json \
    --only-show-errors | jq -S "$NORMALISE"
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

# Same values as scripts/deploy-infra.sh.
case "$ENVIRONMENT" in
  test)
    SUBSCRIPTION='7897ceb1-9a86-4639-87d7-7f9ff67142b3'
    RESOURCE_GROUP='c4b0a8-test-rg'
    ;;
  prod)
    SUBSCRIPTION='be5924ac-1083-4a1b-be92-7b444882cfd9'
    RESOURCE_GROUP='rg-demi-prod'
    ;;
  *)
    echo "✗ unknown environment '${ENVIRONMENT}'. Use: test | prod" >&2
    exit 2
    ;;
esac
ACCOUNT="demi-cosmos-${ENVIRONMENT}"

if [ "$ENVIRONMENT" = 'prod' ] && [ "$LIVE" = 'true' ] && [ "${CONFIRM_PROD:-}" != 'yes' ]; then
  echo "✗ refusing to apply to prod. Export CONFIRM_PROD=yes if that is what you mean." >&2
  exit 2
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

declared_policy "$CONTAINER" >"${WORK}/declared.json"
live_policy >"${WORK}/live.json"

TARGET="${ACCOUNT}/${DATABASE}/${CONTAINER}"
if diff -u --label "live ${TARGET}" --label "declared cosmos-nosql.bicep" \
  "${WORK}/live.json" "${WORK}/declared.json"; then
  echo "no change: ${TARGET} already matches cosmos-nosql.bicep"
  exit 0
fi

UPDATE=(az cosmosdb sql container update --subscription "$SUBSCRIPTION" -g "$RESOURCE_GROUP"
  -a "$ACCOUNT" -d "$DATABASE" -n "$CONTAINER" --idx "@${WORK}/declared.json" -o none --only-show-errors)

if [ "$LIVE" != 'true' ]; then
  echo
  echo "dry run, nothing applied. --live would run, with the declared side of the diff as the file:"
  echo "  ${UPDATE[*]}"
  exit 0
fi

echo
echo "applying to ${TARGET}"
"${UPDATE[@]}"

live_policy >"${WORK}/after.json"
if ! diff -u --label "live ${TARGET} after update" --label "declared cosmos-nosql.bicep" \
  "${WORK}/after.json" "${WORK}/declared.json"; then
  echo "✗ live policy still differs from cosmos-nosql.bicep after the update" >&2
  exit 1
fi
echo "applied: ${TARGET} now matches cosmos-nosql.bicep; the index rebuilds in the background"
