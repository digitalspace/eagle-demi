#!/usr/bin/env bash
# Post-deploy validation for DEMI. Read-only — probes only, changes nothing.
#
# Usage: API_URL=https://demi-apim-<env>.azure-api.net FRONTEND_URL=https://<afd-endpoint> \
#          ./scripts/validate-deploy.sh
#        (optionally FRONTEND_STORAGE_ACCOUNT=<account>)
#
# Every check names what a HEALTHY result is and what a FAULTED one looks like, and each is chosen
# so the two answers DIFFER. A probe whose healthy and faulted outcomes look the same proves
# nothing. `/api/config` returning 200 does NOT show a new build; the old build answers it too. So
# the discriminator is `/api/search/summary`: 404 on any build predating the summariser, 401 once
# it exists (the route sits behind authMiddleware).

set -uo pipefail

# No default, and the APIM gateway rather than the app host: direct `*.azurewebsites.net` access is
# platform-403'd since the APIM cutover, and a default naming one environment is how a prod run gets
# validated against test.
API="${API_URL:-}"

# The frontend has no hostname this script can compose any more. It is a Storage static website
# behind Front Door, and an AFD endpoint is `<name>-<hash>.z01.azurefd.net` with the hash assigned
# at deploy time — so pass the URL users actually hit. It must be the FRONT DOOR one: the security
# headers checked below are added by the AFD rule set and the $web endpoint cannot set them, which
# is exactly the difference this is here to catch.
FE="${FRONTEND_URL:-}"
# Optional. The storage account behind it, only used to prove static website hosting is switched on.
FE_STORAGE="${FRONTEND_STORAGE_ACCOUNT:-}"

PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
code(){ curl -s -o /dev/null -w "%{http_code}" --max-time 90 "$@"; }

echo "=== 1. Endpoints ==="
if [ -z "$API" ]; then
  no "API_URL unset — set it to the APIM gateway, e.g. https://demi-apim-test.azure-api.net"
else
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
fi

echo "=== 2. Frontend: static website on, Front Door headers applied, new build served ==="
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

echo "=== 3. Stability — intermittent 5xx would fail here ==="
if [ -n "$API" ]; then
  BAD=0
  for i in $(seq 1 8); do
    C=$(code "$API/api/search?dataset=Project&pageSize=500")
    [ "$C" != "200" ] && { BAD=$((BAD+1)); echo "    call $i -> $C"; }
  done
  [ "$BAD" = "0" ] && ok "8/8 consecutive calls 200" || no "$BAD of 8 non-200"
fi

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
