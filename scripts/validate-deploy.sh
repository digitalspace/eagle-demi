#!/usr/bin/env bash
# Post-deploy validation for DEMI dev. Read-only — probes only, changes nothing.
#
# Usage: FRONTEND_URL=https://<afd-endpoint> ./scripts/validate-deploy.sh
#        (optionally FRONTEND_STORAGE_ACCOUNT=<account>, API_APP_NAME=<app>)
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
API="https://${API_APP}.azurewebsites.net"
SCM="https://${API_APP}.scm.azurewebsites.net"

# The frontend has no hostname this script can compose any more. It is a Storage static website
# behind Front Door, and an AFD endpoint is `<name>-<hash>.z01.azurefd.net` with the hash assigned
# at deploy time — so pass the URL users actually hit. It must be the FRONT DOOR one: the security
# headers checked below are added by the AFD rule set and the $web endpoint cannot set them, which
# is exactly the difference this is here to catch.
FE="${FRONTEND_URL:-}"
# Optional. The storage account behind it, only used to prove static website hosting is switched on.
FE_STORAGE="${FRONTEND_STORAGE_ACCOUNT:-}"

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

echo "=== 5. Frontend: static website on, Front Door headers applied, new build served ==="
#
# Superseded bundles are NOT checked any more. Blob upload does not merge into a previous deploy
# the way zipdeploy did, so an orphaned main-<hash>.js is inert rather than a symptom, and
# deploy-azure.sh deliberately leaves it (see the ponytail note there).

# ARM has no property for static website hosting, so `deploy-azure.sh frontend` switches it on as
# its first step instead — and the way a skipped one shows up is every blob present and the site
# 404ing. Still checked here: this reads the account, the deploy reads the script.
if [ -n "$FE_STORAGE" ]; then
  SW=$(az storage blob service-properties show --account-name "$FE_STORAGE" --auth-mode login \
    --query staticWebsite.enabled -o tsv 2>/dev/null || true)
  [ "$SW" = "true" ] && ok "static website enabled on $FE_STORAGE" \
    || no "static website NOT enabled on $FE_STORAGE (got '${SW:-unreadable}') — re-run ./scripts/deploy-azure.sh frontend; 'unreadable' usually means this identity lacks blobServices/read"
fi

if [ -z "$FE" ]; then
  no "FRONTEND_URL unset — set it to the Front Door endpoint, e.g. https://demi-frontend-<hash>.z01.azurefd.net"
else
  # One output file per probe. A curl that times out does NOT rewrite its -o file, so a shared one
  # silently re-reads the previous probe's answer — a mistake already made twice in this repo.
  IHDR=/tmp/validate-fe-index.headers; IBODY=/tmp/validate-fe-index.html
  rm -f "$IHDR" "$IBODY"
  curl -s -D "$IHDR" -o "$IBODY" --max-time 60 "$FE/index.html" || true
  C=$(awk 'NR==1{print $2}' "$IHDR" 2>/dev/null)
  [ "$C" = "200" ] && ok "index.html 200" \
    || no "index.html ${C:-no response} — static website hosting may never have been enabled"

  # A cached index.html pins every returning visitor to a bundle that no longer exists.
  grep -qi '^cache-control:.*no-store' "$IHDR" && ok "index.html is no-store" \
    || no "index.html Cache-Control: '$(grep -i '^cache-control:' "$IHDR" | tr -d '\r')' — expected no-store"

  # $web cannot set a response header at all, so each of these proves the AFD rule set is attached
  # to this route. Missing means the request either bypassed Front Door or the rule set did not
  # bind — both look perfectly healthy from the browser until something goes wrong.
  for h in strict-transport-security x-content-type-options x-frame-options referrer-policy permissions-policy; do
    grep -qi "^${h}:" "$IHDR" && ok "header $h" || no "header $h missing — Front Door rule set not applied"
  done
  # DEMI ships no CSP today, so it goes out in report-only first; either name counts here.
  grep -qiE '^content-security-policy(-report-only)?:' "$IHDR" && ok "header content-security-policy" \
    || no "no CSP header, in either enforcing or report-only form"

  BUNDLE=$(grep -oE 'main-[A-Z0-9]+\.js' "$IBODY" | head -1)
  if [ -z "$BUNDLE" ]; then
    no "index.html references no hashed main bundle — that is not a production Angular build"
  else
    ok "index.html references $BUNDLE"
    BHDR=/tmp/validate-fe-bundle.headers; BBODY=/tmp/validate-fe-bundle.js
    rm -f "$BHDR" "$BBODY"
    curl -s -D "$BHDR" -o "$BBODY" --max-time 60 "$FE/$BUNDLE" || true
    # Hashed name, so the bytes can never change: anything short of immutable re-downloads the
    # bundle on every visit and is a Cache-Control pass in deploy-azure.sh that did not land.
    grep -qi '^cache-control:.*immutable' "$BHDR" && ok "$BUNDLE is immutable" \
      || no "$BUNDLE Cache-Control: '$(grep -i '^cache-control:' "$BHDR" | tr -d '\r')' — expected immutable"
    grep -q "AI Summary"      "$BBODY" && ok "bundle has the AI Summary nav" || no "bundle missing 'AI Summary'"
    grep -q "Staff Login"     "$BBODY" && ok "bundle has Staff Login"        || no "bundle missing 'Staff Login'"
    grep -q "EPIC Staff View" "$BBODY" && no "bundle still has the removed role switcher" \
                                       || ok "removed role switcher is gone"
  fi
fi

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
