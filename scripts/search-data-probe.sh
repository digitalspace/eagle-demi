#!/usr/bin/env bash
set -euo pipefail

# Ask a RUNNING API whether the rows in the live AI Search indexes carry values, not just fields.
# The twin of scripts/search-schema-probe.sh. Details: azure/search/README.md, "Data checks".

usage() {
  cat <<'EOF'
Usage: scripts/search-data-probe.sh <base-url>

GETs <base-url>/health/search-data and prints one line per committed check:

  projects currentPhaseNameId 0/0 ok

The checks live in azure/search/data-checks.json and run on the API, not here: each
is one `top: 0, count: true` query against the live index, counting the rows that
must not be there. The endpoint answers 200 when every count is within its maximum
and 503 when any is over.

This is the half the schema probe cannot see: it proves a field exists, not that
anything is in it. Background: docs/runbook-search-outage.md, "Fields null on
every row".

Exit codes:
  0  every check within its maximum (200)
  1  a check over its maximum (503), a 200 whose body carries no checks, an
     unexpected status, a 404, bad usage, or the API was unreachable

A 404 means the running app has no /health/search-data. That is a real failure —
the endpoint is expected to be there — except on the one deploy that first ships it.
Set SEARCH_DATA_ALLOW_MISSING=1 to pass that deploy, once.
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  # An empty base URL counted nothing. Exiting 0 on it would read as a passing gate.
  '') echo "❌ no base URL — this gate would have checked nothing." >&2; usage >&2; exit 1 ;;
esac

[ $# -eq 1 ] || { usage; exit 1; }

BASE_URL="${1%/}"
RUNBOOK='docs/runbook-search-outage.md'

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
RESPONSE="$WORK/response"

# No --retry: curl counts 503 as transient and would re-send the check three times for the one
# answer this script exists to read. A connection failure is a failure here too.
STATUS=$(curl -sS --max-time 60 -o "$RESPONSE" -w '%{http_code}' \
  "$BASE_URL/health/search-data") || {
  echo "❌ could not reach $BASE_URL/health/search-data" >&2
  exit 1
}

# One line per check, in the order the committed file lists them. Written to the stream the caller
# is reading: stdout on a pass, stderr on a failure, so a red step's log carries the reason.
#
# Exits NON-ZERO when the body carried no checks. An empty committed list, an error payload and a
# proxy page all land there, and none of them counted anything — so a 200 with an unreadable body
# must not reach the success line below.
print_checks() {
  node -e '
    const fs = require("fs");
    const raw = fs.readFileSync(process.argv[1], "utf8");
    let body;
    try { body = JSON.parse(raw); } catch { body = null; }
    const checks = (body && Array.isArray(body.checks)) ? body.checks : [];
    if (!checks.length) {
      process.stdout.write(`  unparsed body: ${raw.slice(0, 2000)}\n`);
      process.exit(1);
    }
    for (const c of checks) {
      const count = c.error ? c.error : `${c.count}/${c.max}`;
      process.stdout.write(`${c.index} ${c.field} ${count} ${c.ok ? "ok" : "FAIL"}\n`);
    }
  ' "$RESPONSE"
}

case "$STATUS" in
  200)
    if ! print_checks; then
      echo "❌ $BASE_URL answered 200 with no readable checks, so nothing was counted." >&2
      echo "   Runbook: $RUNBOOK" >&2
      exit 1
    fi
    echo "✓ every committed data check at $BASE_URL is within its maximum"
    exit 0
    ;;
  404)
    # Passing a 404 unconditionally is how this gate would pass forever without ever counting
    # anything. The one deploy that ships the endpoint is the only case that needs it.
    if [ "${SEARCH_DATA_ALLOW_MISSING:-}" = "1" ]; then
      echo "⚠️ $BASE_URL has no /health/search-data — passing because SEARCH_DATA_ALLOW_MISSING=1."
      echo "   This deploy is ungated. The next one must not set it: a 404 then means the route"
      echo "   was not shipped, and nothing checked the values in the live indexes."
      exit 0
    fi
    echo "❌ $BASE_URL has no /health/search-data, so nothing checked the values in the live indexes." >&2
    echo "   If this is the first deploy after the endpoint shipped, re-run with the" >&2
    echo "   allow_missing_schema_probe input (SEARCH_DATA_ALLOW_MISSING=1 by hand)." >&2
    echo "   Otherwise the deployed app lost the route. Runbook: $RUNBOOK" >&2
    exit 1
    ;;
  503)
    echo "❌ live index rows at $BASE_URL do not carry the values the site reads:" >&2
    # `|| true`: an unreadable 503 body still exits 1 below, and swallowing the hint would be worse.
    print_checks >&2 || true
    {
      echo ""
      echo "  Rows with unresolved fields usually mean eagle-api pushed before its List refs were"
      echo "  resolved. Re-push from the eagle-api pod:"
      echo ""
      echo "    LOG_LEVEL=info node scripts/demi-repush.js --kind project --live --concurrency 1"
      echo ""
      echo "  then wait one indexer tick (PT5M)."
      echo "  Runbook: $RUNBOOK"
    } >&2
    exit 1
    ;;
  *)
    echo "❌ $BASE_URL/health/search-data answered $STATUS" >&2
    head -c 2000 "$RESPONSE" >&2
    echo "" >&2
    echo "  Runbook: $RUNBOOK" >&2
    exit 1
    ;;
esac
