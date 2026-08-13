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

  # env.js ships in the bundle with dev URLs baked in, and the app bootstraps its /api/config
  # fetch FROM env.js — so a test deploy that skips this rewrite silently talks to the DEV API
  # (found live 2026-08-11). sed exits 0 on no match, hence the grep guards on both sides.
  if [[ "$FRONTEND_APP_NAME" == "demi-frontend-test" ]]; then
    ENV_JS="$REPO_ROOT/frontend/dist/env.js"
    grep -qF "https://demi-api-dev.azurewebsites.net" "$ENV_JS" || { echo "env.js rewrite guard: dev API URL not found"; exit 1; }
    sed -i \
      -e "s|https://demi-api-dev.azurewebsites.net|https://demi-api-test.azurewebsites.net|g" \
      -e "s|https://dev.loginproxy.gov.bc.ca|https://test.loginproxy.gov.bc.ca|g" \
      -e "s|window.__env.ENVIRONMENT = 'dev'|window.__env.ENVIRONMENT = 'test'|" \
      "$ENV_JS"
    grep -qF "https://demi-api-test.azurewebsites.net" "$ENV_JS" || { echo "env.js rewrite failed"; exit 1; }
    echo -e "${GREEN}✓ env.js repointed at demi-api-test / test loginproxy${NC}"
  fi

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
