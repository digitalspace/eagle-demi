#!/usr/bin/env bash
set -euo pipefail

# Azure Deployment Script for DEMI (API and Frontend)
# Usage: ./scripts/deploy-azure.sh [all|api|frontend] [resource_group]
#
# There is deliberately no `job` target. It used to create a Container App Job running
# mcr.microsoft.com/azuredocs/aci-helloworld on a 2am cron, plus a SECOND Container Apps
# environment (demi-container-env-dev, not the real demi-ca-env-dev) — billable resources that
# did nothing. There is no nightly sync either: the `nightlySyncTimer` Functions timer went with
# the Mongo data layer, and the AI Search indexers pull on a PT5M schedule.
#
# ── HOW THIS DEPLOYS, AND WHY NOT THE OBVIOUS WAYS ────────────────────────────────────────────
#
# `POST /api/zipdeploy?isAsync=true` + polling the deployment record. Both halves matter.
#
# NOT `az ... deployment source config-zip`: it reports success from the CLI's exit code, which is
# not the same fact as the deployment succeeding. On 2026-08-05 an oversized package left Kudu at
# status 1 for over thirty minutes; the client was killed, the files had ALREADY extracted, and the
# deployment record stayed "in progress" while `wwwroot` held the new code. Azure then listed an
# older deployment as active — a mismatch that reverts the app on the next container recycle.
#
# NOT `POST /api/publish` (OneDeploy), under any circumstances. It forces an Oryx remote build that
# runs `yarn install` ON THE SERVER, and this app's VNet has no route to registry.yarnpkg.com:
#   error "https://registry.yarnpkg.com/@azure/cosmos/-/cosmos-4.10.0.tgz: ESOCKETTIMEDOUT"
# It ignores BOTH `SCM_DO_BUILD_DURING_DEPLOYMENT=false` and `ENABLE_ORYX_BUILD=false`, which are
# already set on this app. Its `clean=true` is silently dropped too (`CleanOutputPath False`) —
# the only reason that failure did not wipe wwwroot and take the API down.
#
# Kudu is called with an AAD bearer token, never publishing credentials. This was written when
# landing-zone policy had SCM basic auth disabled; measured 2026-08-05, both apps report
# `scm allow=True` and `ftp allow=True`, so that is no longer true and may flip back under policy
# remediation. Bearer is correct either way and stores no credential, so nothing here depends on
# which way the setting currently sits.

TARGET="${1:-all}"
RESOURCE_GROUP="${2:-c4b0a8-dev-rg}"
API_APP_NAME="${API_APP_NAME:-demi-api-dev}"
# No default. The static-website storage account name carries a uniqueString suffix, so there is
# nothing to guess; `main.bicep` outputs it and CI passes it in as a repository variable.
FRONTEND_STORAGE_ACCOUNT="${FRONTEND_STORAGE_ACCOUNT:-}"
export REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Kudu tokens are short-lived; fetch per call rather than caching one across a long deploy.
kudu_token() {
  az account get-access-token --resource https://management.core.windows.net/ \
    --query accessToken -o tsv
}

# This script carries NO credential. `az account get-access-token` returns a token for whoever the
# az CLI is currently signed in as: a human on a workstation, or — after `azure/login` — the
# federated service principal on a CI runner. Same code, different principal, nothing stored.
#
# Fail fast and say WHICH principal, for two reasons. Without a token every Kudu call gets a 401,
# the upload check only looks for 409, and wait_for_deployment then polls for twenty minutes before
# giving up — a confusing way to report "not logged in". And printing the principal is what makes
# it visible in a CI log that the deploy ran as the service principal and not as somebody's account.
preflight_identity() {
  local who type
  who=$(az account show --query user.name -o tsv 2>/dev/null || true)
  type=$(az account show --query user.type -o tsv 2>/dev/null || true)
  if [ -z "$who" ] || [ -z "$(kudu_token)" ]; then
    echo -e "${RED}✗ no Azure token. Run 'az login', or check the Azure Login step.${NC}" >&2
    exit 2
  fi
  echo -e "${BLUE}Authenticated as:${NC} ${who} (${type})"
  if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ "$type" != "servicePrincipal" ]; then
    echo -e "${RED}✗ CI must deploy as a service principal, not '${type}'.${NC}" >&2
    exit 2
  fi
}

kudu() { # kudu <app> <method> <path> [curl args...]
  local app="$1" method="$2" path="$3"; shift 3
  curl -sS --max-time 120 -X "$method" \
    -H "Authorization: Bearer $(kudu_token)" \
    "https://${app}.scm.azurewebsites.net${path}" "$@"
}

# Wait for the deployment RECORD to reach a terminal state.
#
# 4 = SUCCESS, 3 = FAILED. Anything else is still running. `complete: true` alone means nothing.
# A 504 on the upload is NORMAL for this app and is not failure — the record is the authority, so
# this must cover BOTH terminal states. A poller that only watches for success sits silent through
# a failure, which looks identical to "still deploying".
wait_for_deployment() {
  local app="$1" tries="${2:-80}" status=""
  for _ in $(seq 1 "$tries"); do
    status=$(kudu "$app" GET /api/deployments/latest \
      | python3 -c "import sys,json;print(json.load(sys.stdin).get('status'))" 2>/dev/null || true)
    case "$status" in
      4) echo -e "${GREEN}✓ deployment record: SUCCESS (status 4)${NC}"; return 0 ;;
      3) echo -e "${RED}✗ deployment record: FAILED (status 3)${NC}"
         echo -e "${YELLOW}  log: https://${app}.scm.azurewebsites.net/api/deployments/latest/log${NC}"
         return 1 ;;
    esac
    sleep 15
  done
  echo -e "${RED}✗ deployment did not reach a terminal state (last status: ${status:-unknown})${NC}"
  return 1
}

echo -e "${BLUE}====================================================${NC}"
echo -e "${BLUE} Azure Direct Deployment: ${YELLOW}${TARGET}${BLUE} -> ${YELLOW}${RESOURCE_GROUP}${NC}"
echo -e "${BLUE}====================================================${NC}"
preflight_identity

deploy_api() {
  # Unique per DEPLOY, not per commit, and set BEFORE packaging so package-api.py can stamp it in.
  #
  # `--dirty` matters: a local deploy of an uncommitted tree and CI's deploy of the same sha would
  # otherwise be indistinguishable — which is exactly the pair that collided on 2026-08-12. The
  # timestamp then separates two deploys of the identical tree, so a redeploy can never satisfy the
  # check with the value the previous one left behind.
  export BUILD_ID="$(git -C "$REPO_ROOT" describe --always --dirty 2>/dev/null || echo nogit)-$(date -u +%H%M%S)"

  echo -e "\n${BLUE}[1/4] Packaging API source code (BUILD_ID=${BUILD_ID})...${NC}"
  API_ZIP="/tmp/api-deploy.zip"
  rm -f "$API_ZIP"
  python3 "$REPO_ROOT/scripts/package-api.py" "$REPO_ROOT" "$API_ZIP"
  echo -e "${GREEN}✓ API package created: ${API_ZIP} ($(du -h "$API_ZIP" | cut -f1))${NC}"

  echo -e "\n${BLUE}[2/4] Uploading to ${YELLOW}${API_APP_NAME}${BLUE} via zipdeploy (async)...${NC}"
  # 202 = accepted. 504 = the gateway timed out while the server kept working; the poll below
  # decides. 409 = another deployment holds the lock (it carries a ~40 min TTL and self-expires).
  local code
  code=$(curl -sS -o /tmp/zipdeploy.out -w "%{http_code}" --max-time 600 \
    -X POST -H "Authorization: Bearer $(kudu_token)" -H "Content-Type: application/zip" \
    --data-binary @"$API_ZIP" \
    "https://${API_APP_NAME}.scm.azurewebsites.net/api/zipdeploy?isAsync=true")
  echo -e "  upload returned HTTP ${code}"
  if [ "$code" = "409" ]; then
    echo -e "${RED}✗ another deployment holds the lock. It expires on its own; retry shortly.${NC}"
    return 1
  fi

  echo -e "\n${BLUE}[3/4] Waiting for the deployment record...${NC}"
  wait_for_deployment "$API_APP_NAME" || return 1

  echo -e "\n${BLUE}[4/4] Verifying the NEW build is the one answering...${NC}"
  #
  # THE OLD CHECK HERE COULD NOT FAIL. It expected 401 from /api/search/summary, a route that
  # answers 401 on every build that has ever existed, so it passed while the previous code kept
  # serving and two deploys were reported as effective when they were not.
  #
  # The thing it missed is a BLUE/GREEN SWAP, not a bad package. `wait_for_deployment` returns
  # within seconds of the upload, but App Service keeps the OLD container serving 100% of traffic
  # for roughly another 2m15s until "Site started". Measured 2026-08-12: deployment record status 4
  # at 23:41, new code answering at 23:50.
  #
  # So the discriminator is BUILD_ID, stamped INTO the package by package-api.py and echoed by
  # /api/config. It has to be inside the package: an app setting would be read correctly by the old
  # container the moment it restarts, proving a restart rather than proving which code is running.
  #
  # And do NOT add a restart or a stop here. A stop issued while State is Starting cancels the
  # incoming container and hands traffic back to the previous one — that is what happened on
  # 2026-08-12, and it cost six minutes of believing a good deploy had failed.
  local url="https://${API_APP_NAME}.azurewebsites.net/api/config"
  local seen="" deadline=$((SECONDS + 600))
  while [ "$SECONDS" -lt "$deadline" ]; do
    # python3, not sed: `{"BUILD_ID": "x"}` with a space defeats a regex silently and would report
    # a good deploy as failed. Same parser as wait_for_deployment.
    seen=$(curl -s --max-time 30 "$url" \
      | python3 -c "import sys,json;print(json.load(sys.stdin).get('BUILD_ID',''))" 2>/dev/null || true)
    [ "$seen" = "$BUILD_ID" ] && break
    sleep 10
  done
  if [ "$seen" = "$BUILD_ID" ]; then
    echo -e "${GREEN}✓ /api/config reports BUILD_ID=${seen}: this build is the one answering${NC}"
  else
    echo -e "${RED}✗ /api/config reports BUILD_ID='${seen}', expected '${BUILD_ID}'${NC}"
    echo -e "${RED}  The package uploaded but the swap never completed within 10 minutes.${NC}"
    echo -e "${RED}  Check for a competing deploy: two landing close together means the second${NC}"
    echo -e "${RED}  container is never created. Do NOT trust anything measured against this app.${NC}"
    return 1
  fi
  echo -e "${GREEN}✓ API deployed: https://${API_APP_NAME}.azurewebsites.net${NC}"
}

# One upload-batch pass into $web.  blob_upload <cache-control> [glob]
#
# No glob means EVERY file. `$web` is single-quoted: it is a container name, not a variable.
blob_upload() {
  local cache="$1" pattern="${2:-}"
  # shellcheck disable=SC2016  # '$web' is the container's literal name, not an expansion
  local args=(
    --auth-mode login --output none --overwrite
    --account-name "$FRONTEND_STORAGE_ACCOUNT"
    --destination '$web'
    --source "$REPO_ROOT/frontend/dist"
    --content-cache "$cache"
  )
  [ -n "$pattern" ] && args+=(--pattern "$pattern")
  az storage blob upload-batch "${args[@]}"
}

# Publish the built bundle to the static website container.
#
# No App Service any more, so no zip, no Kudu, no blue/green swap to wait out: a blob PUT is live
# when it returns. What is gone with it is the ability to set a response header, which is why the
# security headers moved to the Front Door rule set — and why Cache-Control has to be stamped on
# each blob at upload time. The policy below is the one the old Node server applied per request
# (eagle-public/azure/server.js:125-131).
deploy_frontend() {
  : "${FRONTEND_STORAGE_ACCOUNT:?set FRONTEND_STORAGE_ACCOUNT — main.bicep output frontendStorageAccountName}"
  local nostore='no-cache, no-store, must-revalidate'
  local immutable='public, max-age=31536000, immutable'

  echo -e "\n${BLUE}[1/4] Enabling static website hosting on ${YELLOW}${FRONTEND_STORAGE_ACCOUNT}${BLUE}...${NC}"
  # NOTHING ELSE TURNS THIS ON. `staticWebsite` is a data-plane setting on the Blob service and the
  # ARM type has no property for it — bicep rejects it with BCP037 — so `azure/modules/static-site.
  # bicep` creates the account and stops there. On an account where this has never run there is no
  # `$web` container at all: the upload below fails, or (if a human made the container by hand) the
  # site endpoint 404s every request with nothing anywhere saying a data-plane step was skipped.
  #
  # Idempotent, so it runs on every deploy rather than being a one-time command someone has to
  # remember: re-applying the same three values is a no-op. It goes FIRST, before the build, so a
  # missing permission fails in seconds instead of after a two-minute Angular build.
  #
  # Both documents are index.html because this is an SPA with client-side routing — a deep link has
  # to come back with the app shell, not an error page.
  #
  # THIS IS A SERVICE-PROPERTIES WRITE, NOT A BLOB WRITE. Storage Blob Data Contributor — the role
  # static-site.bicep assigns for the upload — does not cover it; it carries no
  # `Microsoft.Storage/storageAccounts/blobServices/write`. The CI identity (demi-cicd-<env>) needs
  # Storage Account Contributor scoped to THIS ACCOUNT as well, or a custom role holding that single
  # action. Still nothing at resource-group scope.
  az storage blob service-properties update \
    --account-name "$FRONTEND_STORAGE_ACCOUNT" --auth-mode login --output none \
    --static-website --index-document index.html --404-document index.html \
    || { echo -e "${RED}✗ could not enable static website hosting on ${FRONTEND_STORAGE_ACCOUNT}${NC}" >&2
         echo -e "${RED}  403 here means the identity holds only Storage Blob Data Contributor.${NC}" >&2
         echo -e "${RED}  This call needs Microsoft.Storage/storageAccounts/blobServices/write —${NC}" >&2
         echo -e "${RED}  grant Storage Account Contributor on this account and re-run.${NC}" >&2
         return 1; }

  echo -e "\n${BLUE}[2/4] Building Angular frontend production bundle...${NC}"
  # env.js is rewritten in the SOURCE, before this build, by the workflow — see
  # .github/workflows/azure-deploy-staging-frontend.yaml for the incident that verification
  # records. It used to be patched here afterwards, on frontend/dist, gated on the app name.
  yarn --cwd "$REPO_ROOT/frontend" build

  # ...which means a deploy run BY HAND does no rewriting at all, and frontend/public/env.js is
  # committed pointing at dev. That is exactly the 2026-08-11 incident (staging serving a bundle
  # that called the DEV API and the DEV realm) with the guard moved out of reach. The script cannot
  # infer the environment from the storage account — the name is a uniqueString — but the resource
  # group argument carries it, so assert rather than rewrite: CI has already done the rewrite and
  # passes, a hand deploy stops here instead of shipping dev config to staging.
  local env="${RESOURCE_GROUP#*-}"; env="${env%-rg}"
  if ! grep -qF "https://demi-api-${env}.azurewebsites.net" "$REPO_ROOT/frontend/dist/env.js"; then
    echo -e "${RED}✗ dist/env.js does not point at demi-api-${env} — this bundle would call the wrong API${NC}" >&2
    echo -e "${RED}  Apply the rewrites from the 'Point env.js at the test environment' step in${NC}" >&2
    echo -e "${RED}  .github/workflows/azure-deploy-staging-frontend.yaml to frontend/public/env.js, then re-run.${NC}" >&2
    return 1
  fi
  echo -e "${GREEN}✓ env.js points at demi-api-${env}${NC}"

  echo -e "\n${BLUE}[3/4] Uploading to ${YELLOW}${FRONTEND_STORAGE_ACCOUNT}${BLUE}/\$web...${NC}"
  # PASS 1 IS UNFILTERED, DELIBERATELY. `--pattern` takes one fnmatch glob and there is no way to
  # spell "everything else", so a scheme built only from patterns ships whatever it forgot — the
  # .geojson boundary files and 3rdpartylicenses.txt in this bundle today — with NO Cache-Control
  # at all, and a browser left to guess is a browser that caches index.html. Uploading everything
  # conservatively first and re-uploading the hashed assets after costs one extra PUT per hashed
  # file and cannot miss a file.
  blob_upload "$nostore"

  # PASS 2: content-hashed filenames, where the bytes behind a URL can never change. Angular's
  # outputHashing is "all", so everything it emits carries a hash. One file caught by these
  # extensions does not — env.js, which matters; see pass 3.
  #
  # `ico` is deliberately NOT in this list. Nothing hashes favicon.ico: it is copied verbatim out of
  # `frontend/public`, so an immutable year would pin a stale icon in every reviewer's browser with
  # no way to bust it. Pass 1 already gave it no-store, which is where an unhashed file belongs.
  local ext
  for ext in js css png jpg jpeg gif svg woff woff2 ttf eot; do
    blob_upload "$immutable" "*.${ext}"
  done

  # PASS 3: env.js is the one .js in the bundle with no hash, so pass 2 just gave it a year of
  # immutable caching. Put it back. It carries the API base URL and the Keycloak realm, and a
  # stale copy points the browser at the wrong ENVIRONMENT with nothing logged anywhere.
  blob_upload "$nostore" 'env.js'

  # ponytail: no prune. Every deploy leaves the previous main-<hash>.js and styles-<hash>.css in
  # $web — 19 files / 5.6 MB accumulated on the old App Service before anyone noticed, which is
  # fractions of a cent per month of LRS and is linked from nothing. Upgrade path when that stops
  # being true: `az storage blob delete-batch -s '$web' --pattern '*-*.js'` filtered on
  # --if-unmodified-since, or delete the container and re-upload.
  echo -e "\n${BLUE}[4/4] Done${NC}"
  echo -e "${GREEN}✓ Frontend published to \$web on ${FRONTEND_STORAGE_ACCOUNT}${NC}"
  echo -e "${YELLOW}  Front Door caches in front of this. index.html is uploaded no-store so the${NC}"
  echo -e "${YELLOW}  edge re-reads it; hashed assets get new names, so neither needs a purge.${NC}"
}

case "$TARGET" in
  api)      deploy_api ;;
  frontend) deploy_frontend ;;
  all)      deploy_api && deploy_frontend ;;
  *)        echo -e "${RED}Invalid target '$TARGET'. Supported: all, api, frontend${NC}"; exit 1 ;;
esac

echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN} Deployment completed successfully!${NC}"
echo -e "${GREEN}====================================================${NC}"
