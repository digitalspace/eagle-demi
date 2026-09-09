#!/usr/bin/env bash
set -euo pipefail

# Post-deploy check that the deployed API still ANSWERS a search, not merely that it started.
# Details: docs/ci-search-guards.md.

usage() {
  cat <<'EOF'
Usage: scripts/search-smoke.sh <base-url> [project-id]

Runs three real queries against a deployed API and fails on the first bad answer:

  1. search?dataset=Document&pageNum=0&pageSize=1        200 and searchResultsTotal > 0
  2. search?dataset=Project&pageNum=0&pageSize=1         200 and searchResultsTotal > 0
  3. the same Document query with &and[project]=<id>     200 only

The third is a filter path — the project id is translated from an Eagle ObjectId and
then applied as an index filter — so a legitimately empty result is possible and zero
rows are accepted. The status is not: a 5xx there is the same broken query pipeline.

<project-id> defaults to 5e31dc4462cdea0021d974b4 (Fording River Extension, Castle;
src/data/track_projects_enriched.json). Override it if that project is ever unpublished.

`/health` says the host loaded the app. It says nothing about the search backend, which
is how a release selecting a field the live index lacked served 502s for 65 minutes
(2026-09-08) behind a green deploy.

Exit codes: 0 all three answered, 1 bad usage, any status other than 200, or a zero
total on 1 or 2.
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  # An empty base URL asked the deployed app nothing. Exiting 0 on it would read as a passing gate.
  '') echo "❌ no base URL — this check would have asked the deploy nothing." >&2; usage >&2; exit 1 ;;
esac

[ $# -eq 1 ] || [ $# -eq 2 ] || { usage; exit 1; }

BASE_URL="${1%/}"
PROJECT_ID="${2:-5e31dc4462cdea0021d974b4}"

RUNBOOK='eagle-demi.wiki/Runbook-Search-Outage.md'

RESPONSE=$(mktemp)
trap 'rm -f "$RESPONSE"' EXIT

FAILURES=0

# $1 label, $2 query string, $3 `rows` when a zero total is a failure
probe() {
  local label="$1" query="$2" rows="${3:-}"
  local status total

  # One file, three probes: bound it to this probe's bytes.
  : > "$RESPONSE"

  # No --retry: curl counts 502, 503 and 504 as transient and would re-ask the exact answer this
  # check exists to report. --max-time covers a cold start; the wait-for-function step ran first.
  status=$(curl -sS --max-time 60 -o "$RESPONSE" -w '%{http_code}' "$BASE_URL/search?$query") \
    || status=000

  if [ "$status" != "200" ]; then
    if [ "$status" = "000" ]; then
      echo "❌ $label: no response — the request did not complete (refused, DNS, TLS or timeout)" >&2
    else
      echo "❌ $label: HTTP $status" >&2
      head -c 1000 "$RESPONSE" >&2
      echo "" >&2
    fi
    FAILURES=$((FAILURES + 1))
    return
  fi

  total=$(node -e '
    const fs = require("fs");
    let body;
    try { body = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { body = null; }
    const first = Array.isArray(body) ? body[0] : null;
    const meta = first && Array.isArray(first.meta) ? first.meta[0] : null;
    // Absent is NOT zero: the API omits the total when it was never measured, and a page length
    // is not a total (src/controllers/search.js).
    const t = meta && Number.isFinite(meta.searchResultsTotal) ? meta.searchResultsTotal : "";
    process.stdout.write(String(t));
  ' "$RESPONSE")

  if [ "$rows" = "rows" ] && { [ -z "$total" ] || [ "$total" -le 0 ]; }; then
    echo "❌ $label: 200 with searchResultsTotal=${total:-none} — the index answers nothing" >&2
    FAILURES=$((FAILURES + 1))
    return
  fi

  echo "✓ $label: 200, searchResultsTotal=${total:-none}"
}

probe 'Document search' 'dataset=Document&pageNum=0&pageSize=1' rows
probe 'Project search' 'dataset=Project&pageNum=0&pageSize=1' rows
probe "Document search filtered by project $PROJECT_ID" \
  "dataset=Document&pageNum=0&pageSize=1&and%5Bproject%5D=$PROJECT_ID"

if [ "$FAILURES" -ne 0 ]; then
  echo "" >&2
  echo "❌ $FAILURES of 3 search smoke checks failed against $BASE_URL" >&2
  echo "   Runbook: $RUNBOOK" >&2
  exit 1
fi

echo "✓ search smoke passed against $BASE_URL"
