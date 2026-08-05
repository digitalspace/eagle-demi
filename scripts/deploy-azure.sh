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
# SCM basic auth is DISABLED by landing-zone policy, so Kudu needs an AAD bearer token.

TARGET="${1:-all}"
RESOURCE_GROUP="${2:-c4b0a8-dev-rg}"
API_APP_NAME="${API_APP_NAME:-demi-api-dev}"
FRONTEND_APP_NAME="${FRONTEND_APP_NAME:-demi-frontend-dev}"
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

deploy_api() {
  echo -e "\n${BLUE}[1/4] Packaging API source code...${NC}"
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
  # A discriminator, not a health check. 404 = the old build is still serving (route absent);
  # 401 = the new build, with /api/search/summary behind authMiddleware. A plain 200 on /api/config
  # would pass against either build and prove nothing.
  local url="https://${API_APP_NAME}.azurewebsites.net/api/search/summary"
  local http=""
  for _ in $(seq 1 20); do   # first request after a recycle is a ~50-75s cold start
    http=$(curl -s -o /dev/null -w "%{http_code}" --max-time 90 "$url" || true)
    [ "$http" = "401" ] && break
    sleep 10
  done
  if [ "$http" = "401" ]; then
    echo -e "${GREEN}✓ /api/search/summary -> 401: new build is serving, and the route is gated${NC}"
  else
    echo -e "${RED}✗ /api/search/summary -> ${http} (expected 401; 404 means the OLD build answers)${NC}"
    return 1
  fi
  echo -e "${GREEN}✓ API deployed: https://${API_APP_NAME}.azurewebsites.net${NC}"
}

# Delete hashed build assets that the live index.html does not reference.
#
# zipdeploy MERGES into wwwroot, so every deploy adds a new main-<hash>.js and leaves the old one.
# By 2026-08-05 that was 19 hashed assets, 5.6 MB, of which exactly 3 were referenced. Pruning here
# rather than clean-deploying keeps the site up throughout and avoids OneDeploy entirely.
prune_frontend() {
  echo -e "\n${BLUE}Pruning superseded bundles from ${YELLOW}${FRONTEND_APP_NAME}${NC}..."
  local referenced
  referenced=$(curl -sS --max-time 60 "https://${FRONTEND_APP_NAME}.azurewebsites.net/index.html" \
    | grep -oE '(main|polyfills|styles|scripts)-[A-Z0-9]+\.(js|css)' | sort -u || true)

  # If index.html could not be read or references nothing, EVERY asset looks superseded. Abort —
  # a prune that cannot see what is in use would delete the running site.
  if [ -z "$referenced" ]; then
    echo -e "${RED}✗ index.html referenced no hashed assets; refusing to prune${NC}"
    return 1
  fi
  echo -e "  in use: $(echo "$referenced" | tr '\n' ' ')"

  local listing
  listing=$(kudu "$FRONTEND_APP_NAME" GET /api/vfs/site/wwwroot/ \
    | python3 -c "import sys,json;[print(x['name']) for x in json.load(sys.stdin)]")

  local pruned=0
  while read -r name; do
    [ -z "$name" ] && continue
    case "$name" in main-*|polyfills-*|styles-*|scripts-*) ;; *) continue ;; esac
    if ! echo "$referenced" | grep -qx "$name"; then
      kudu "$FRONTEND_APP_NAME" DELETE "/api/vfs/site/wwwroot/${name}" -H "If-Match: *" -o /dev/null
      echo -e "  ${YELLOW}removed${NC} $name"
      pruned=$((pruned + 1))
    fi
  done <<< "$listing"
  echo -e "${GREEN}✓ pruned ${pruned} superseded asset(s)${NC}"
}

deploy_frontend() {
  echo -e "\n${BLUE}[1/3] Building Angular frontend production bundle...${NC}"
  yarn --cwd "$REPO_ROOT/frontend" build

  echo -e "\n${BLUE}[2/3] Deploying static bundle to ${YELLOW}${FRONTEND_APP_NAME}${NC}..."
  FRONTEND_ZIP="/tmp/frontend-deploy.zip"
  rm -f "$FRONTEND_ZIP"
  python3 -c "
import zipfile, os
dist_dir = '$REPO_ROOT/frontend/dist'
with zipfile.ZipFile('$FRONTEND_ZIP', 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(dist_dir):
        for file in files:
            full = os.path.join(root, file)
            z.write(full, os.path.relpath(full, dist_dir))
"
  echo -e "${GREEN}✓ Frontend package created ($(du -h "$FRONTEND_ZIP" | cut -f1))${NC}"

  az webapp deployment source config-zip \
    --resource-group "$RESOURCE_GROUP" \
    --name "$FRONTEND_APP_NAME" \
    --src "$FRONTEND_ZIP"

  echo -e "\n${BLUE}[3/3] Post-deploy prune${NC}"
  prune_frontend

  echo -e "${GREEN}✓ Frontend deployed: https://${FRONTEND_APP_NAME}.azurewebsites.net${NC}"
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
