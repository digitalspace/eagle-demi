#!/usr/bin/env bash
# Post-deploy validation for DEMI dev. Read-only — probes only, changes nothing.
#
# Usage: ./scripts/validate-deploy.sh
#
# Every check names what a HEALTHY result is and what a FAULTED one looks like, and each is chosen
# so the two answers DIFFER. A probe whose healthy and faulted outcomes look the same proves
# nothing — three of five checks written during the Phase 8 work had that defect. In particular:
#
#   - `/api/config` returning 200 does NOT show a new build; the old build answers it too.
#   - File mtimes do NOT show a new build; the zip carries source mtimes and zipdeploy merges.
#
# So the discriminator is `/api/search/summary`: 404 on any build predating the summariser,
# 401 once it exists (the route sits behind authMiddleware).

set -uo pipefail

API_APP="${API_APP_NAME:-demi-api-dev}"
FE_APP="${FRONTEND_APP_NAME:-demi-frontend-dev}"
API="https://${API_APP}.azurewebsites.net"
FE="https://${FE_APP}.azurewebsites.net"
SCM="https://${API_APP}.scm.azurewebsites.net"

TOK=$(az account get-access-token --resource https://management.core.windows.net/ --query accessToken -o tsv 2>/dev/null)
[ -z "$TOK" ] && { echo "ERROR: could not get an Azure token — run 'az login'"; exit 2; }

PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
code(){ curl -s -o /dev/null -w "%{http_code}" --max-time 90 "$@"; }
kcode(){ curl -s -o /dev/null -w "%{http_code}" --max-time 60 -H "Authorization: Bearer $TOK" "$@"; }

echo "=== 1. Deployment record: SUCCESS, and the record Azure considers active ==="
D=$(curl -s --max-time 60 -H "Authorization: Bearer $TOK" "$SCM/api/deployments/latest")
ST=$(echo "$D" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status'))" 2>/dev/null)
AC=$(echo "$D" | python3 -c "import sys,json;print(json.load(sys.stdin).get('active'))" 2>/dev/null)
ID=$(echo "$D" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
echo "  status=$ST (4=SUCCESS 3=FAILED 1=running)  active=$AC  id=${ID:0:12}"
[ "$ST" = "4" ] && ok "deployment status 4" || no "deployment status $ST, expected 4"
# `active: False` with working code is the silent-revert trap: wwwroot holds the new build but
# Azure will resync from a different deployment on the next recycle.
[ "$AC" = "True" ] && ok "record marked active" || no "record NOT active — a recycle may revert wwwroot"

echo "=== 2. No repo debris in the app ==="
for d in .claude .git test azure .github .vscode scripts; do
  C=$(kcode "$SCM/api/vfs/site/wwwroot/$d")
  [ "$C" = "404" ] && ok "wwwroot/$d absent" || no "wwwroot/$d present (HTTP $C)"
done

echo "=== 3. Runtime files present, by CONTENT not mtime ==="
for f in index.js api/index.js host.json src/ai/summarize.js src/scripts/sync-wildfires.js; do
  C=$(kcode "$SCM/api/vfs/site/wwwroot/$f")
  [ "$C" = "200" ] && ok "$f present" || no "$f MISSING (HTTP $C)"
done

echo "=== 4. Endpoints ==="
C=$(code "$API/api/config");            [ "$C" = "200" ] && ok "/api/config 200" || no "/api/config $C"
C=$(code "$API/api/search/summary?keywords=x")
case "$C" in
  401) ok "/api/search/summary 401 — new build, and privileged-only" ;;
  404) no "/api/search/summary 404 — OLD build is still serving" ;;
  200) no "/api/search/summary 200 — NOT GATED, anonymous access to the summariser" ;;
  *)   no "/api/search/summary $C — unexpected" ;;
esac
for ds in Project Document DocumentChunk; do
  C=$(code "$API/api/search?dataset=$ds&pageSize=50&keywords=pipeline&fuzzy=true")
  [ "$C" = "200" ] && ok "search dataset=$ds 200" || no "search dataset=$ds $C"
done

echo "=== 5. Frontend: new build, and no superseded bundles ==="
IDX=$(curl -s --max-time 60 "$FE/index.html")
REF=$(echo "$IDX" | grep -oE '(main|polyfills|styles|scripts)-[A-Z0-9]+\.(js|css)' | sort -u)
[ -n "$REF" ] && ok "index.html references $(echo "$REF" | wc -l) hashed asset(s)" || no "index.html references none"
BUNDLE=$(echo "$REF" | grep '^main-' | head -1)
if [ -n "$BUNDLE" ]; then
  J=$(curl -s --max-time 60 "$FE/$BUNDLE")
  echo "$J" | grep -q "AI Summary"      && ok "bundle has the AI Summary nav"    || no "bundle missing 'AI Summary'"
  echo "$J" | grep -q "Staff Login"     && ok "bundle has Staff Login"           || no "bundle missing 'Staff Login'"
  echo "$J" | grep -q "EPIC Staff View" && no "bundle still has the removed role switcher" \
                                        || ok "removed role switcher is gone"
fi
ALL=$(curl -s --max-time 60 -H "Authorization: Bearer $TOK" \
  "https://${FE_APP}.scm.azurewebsites.net/api/vfs/site/wwwroot/" \
  | python3 -c "import sys,json;[print(x['name']) for x in json.load(sys.stdin)]" 2>/dev/null \
  | grep -E '^(main|polyfills|styles|scripts)-' | sort -u)
STALE=$(comm -23 <(echo "$ALL") <(echo "$REF") | grep -c . || true)
[ "$STALE" = "0" ] && ok "no superseded bundles in wwwroot" || no "$STALE superseded bundle(s) still in wwwroot"

echo "=== 6. Stability — intermittent 5xx would fail here ==="
BAD=0
for i in $(seq 1 8); do
  C=$(code "$API/api/search?dataset=Project&pageSize=500")
  [ "$C" != "200" ] && { BAD=$((BAD+1)); echo "    call $i -> $C"; }
done
[ "$BAD" = "0" ] && ok "8/8 consecutive calls 200" || no "$BAD of 8 non-200"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
