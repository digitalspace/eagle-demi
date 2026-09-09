#!/usr/bin/env bash
set -euo pipefail

# Ask a RUNNING API whether the live AI Search indexes can answer the selects the COMMITTED index
# definitions describe. Details: docs/ci-search-guards.md.

usage() {
  cat <<'EOF'
Usage: scripts/search-schema-probe.sh <base-url> [indexes-dir]

Builds a probe body from azure/search/indexes/*.json — per index, every retrievable
field as `select` — and POSTs it to <base-url>/health/search-schema. The endpoint
runs that select, plus the orders it derives from the app's own query builder,
against the live index with `top: 0`, so the answer is about the LIVE schema, not
the committed JSON.

<indexes-dir> defaults to azure/search/indexes next to this script.

Run it against the app that is ALREADY DEPLOYED, with the index definitions of the
version about to be deployed: that is the pairing that catches a release selecting a
field the live index does not have (2026-09-08, `fileSize`, 65 minutes of 502s).

Exit codes:
  0  live indexes answer every select (200)
  1  drift (503), an unexpected status, a 404, bad usage, or the API was unreachable

A 404 means the running app has no /health/search-schema. That is a real failure —
the endpoint is expected to be there — except on the one deploy that first ships it.
Set SEARCH_SCHEMA_ALLOW_MISSING=1 to pass that deploy, once.

Non-retrievable fields are left out of `select`: AI Search rejects one, and a 400
from a legal-but-unusable field would read as drift. No `orderby` is sent, so the
orders checked are the ones the app can actually emit — restating that type gate
here would order by fields no query sorts on, and block a release over them.

DEMI_ENV (default prod) only names the environment in the "widen it with" hint.
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  # An empty base URL asked the live index nothing. Exiting 0 on it would read as a passing gate.
  '') echo "❌ no base URL — this gate would have checked nothing." >&2; usage >&2; exit 1 ;;
esac

[ $# -eq 1 ] || [ $# -eq 2 ] || { usage; exit 1; }

BASE_URL="${1%/}"
INDEX_DIR="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/azure/search/indexes}"

RUNBOOK='eagle-demi.wiki/Runbook-Search-Outage.md'
APPLY_CMD="scripts/demi-devbox.sh apply --env ${DEMI_ENV:-prod}"

BODY=$(node -e '
const fs = require("fs");
const path = require("path");
const dir = process.argv[1];
const indexes = {};
for (const file of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
  const def = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const fields = def.fields || [];
  if (!def.name || !fields.length) throw new Error(`${file} is not an index definition`);
  // No orderby key: the endpoint then derives the orders from buildOrderBy, the one authority on
  // what this app can sort by. The `sortable` flags do not answer that question.
  indexes[def.name] = { select: fields.filter((f) => f.retrievable !== false).map((f) => f.name) };
}
if (!Object.keys(indexes).length) throw new Error(`no index definitions under ${dir}`);
process.stdout.write(JSON.stringify({ indexes }));
' "$INDEX_DIR")

RESPONSE=$(mktemp)
trap 'rm -f "$RESPONSE"' EXIT

# No --retry: curl counts 503 as transient and would re-send the probe three times for the one
# answer this script exists to read. A connection failure is a failure here too.
STATUS=$(curl -sS --max-time 60 -o "$RESPONSE" -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' \
  --data-binary "$BODY" \
  "$BASE_URL/health/search-schema") || {
  echo "❌ could not reach $BASE_URL/health/search-schema" >&2
  exit 1
}

case "$STATUS" in
  200)
    echo "✓ live indexes at $BASE_URL answer every committed select"
    exit 0
    ;;
  404)
    # Passing a 404 unconditionally is how this gate would pass forever without ever asking the
    # live index anything. The one deploy that ships the endpoint is the only case that needs it.
    if [ "${SEARCH_SCHEMA_ALLOW_MISSING:-}" = "1" ]; then
      echo "⚠️ $BASE_URL has no /health/search-schema — passing because SEARCH_SCHEMA_ALLOW_MISSING=1."
      echo "   This deploy is ungated. The next one must not set it: a 404 then means the route"
      echo "   was not shipped, and nothing checked the live indexes."
      exit 0
    fi
    echo "❌ $BASE_URL has no /health/search-schema, so nothing checked the live indexes." >&2
    echo "   If this is the first deploy after the endpoint shipped, re-run with the" >&2
    echo "   allow_missing_schema_probe input (SEARCH_SCHEMA_ALLOW_MISSING=1 by hand)." >&2
    echo "   Otherwise the deployed app lost the route. Runbook: $RUNBOOK" >&2
    exit 1
    ;;
  503)
    echo "❌ live search indexes are narrower than the index definitions being deployed:" >&2
    node -e '
      const fs = require("fs");
      let body;
      try { body = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { body = null; }
      const indexes = (body && body.indexes) || {};
      const rows = Object.entries(indexes).filter(([, v]) => v && v.ok === false);
      if (!rows.length) {
        process.stderr.write(`  unparsed 503 body: ${fs.readFileSync(process.argv[1], "utf8")}\n`);
      }
      for (const [name, v] of rows) {
        process.stderr.write(`  ${name}: missing ${(v.missing || []).join(", ") || "(unnamed)"}\n`);
      }
    ' "$RESPONSE" >&2
    {
      echo ""
      echo "  Widen the live index BEFORE deploying:  $APPLY_CMD"
      echo "  Runbook: $RUNBOOK"
    } >&2
    exit 1
    ;;
  *)
    echo "❌ $BASE_URL/health/search-schema answered $STATUS" >&2
    head -c 2000 "$RESPONSE" >&2
    echo "" >&2
    echo "  Runbook: $RUNBOOK" >&2
    exit 1
    ;;
esac
