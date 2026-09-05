#!/usr/bin/env bash
set -euo pipefail

# Azure frontend deployment for DEMI. Usage: ./scripts/deploy-azure.sh [frontend] [resource_group]
# The API is NOT deployed from here — Flex Consumption has no Kudu wwwroot. Details: wiki CI-Workflows.

TARGET="${1:-frontend}"
RESOURCE_GROUP="${2:-c4b0a8-test-rg}"
# No default. The static-website storage account name carries a uniqueString suffix, so there is
# nothing to guess; `main.bicep` outputs it and CI passes it in as a repository variable.
FRONTEND_STORAGE_ACCOUNT="${FRONTEND_STORAGE_ACCOUNT:-}"
export REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# This script carries NO credential: `az` is signed in as a human, or as the federated service
# principal after `azure/login`. The principal TYPE is printed, never the name — CI logs are public.
preflight_identity() {
  local type
  if ! type=$(az account show --query user.type -o tsv); then
    echo -e "${RED}✗ not signed in to Azure. Run 'az login', or check the Azure Login step.${NC}" >&2
    exit 2
  fi
  echo -e "${BLUE}Authenticated as:${NC} ${type}"
  if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ "$type" != "servicePrincipal" ]; then
    echo -e "${RED}✗ CI must deploy as a service principal, not '${type}'.${NC}" >&2
    exit 2
  fi
}

echo -e "${BLUE}====================================================${NC}"
echo -e "${BLUE} Azure Direct Deployment: ${YELLOW}${TARGET}${BLUE} -> ${YELLOW}${RESOURCE_GROUP}${NC}"
echo -e "${BLUE}====================================================${NC}"
preflight_identity

# One upload-batch pass into $web.  blob_upload <cache-control> [glob]
# No glob means EVERY file. `$web` is single-quoted: a container name, not a variable.
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

# Publish the built bundle to the static website container. `$web` cannot set a response header,
# so Cache-Control is stamped per blob at upload time; security headers live in the Front Door rules.
deploy_frontend() {
  : "${FRONTEND_STORAGE_ACCOUNT:?set FRONTEND_STORAGE_ACCOUNT — main.bicep output frontendStorageAccountName}"
  local nostore='no-cache, no-store, must-revalidate'
  local immutable='public, max-age=31536000, immutable'
  # For unhashed files whose bytes CAN change: `no-store` forbids keeping the response at all, so
  # every font and image would be refetched in full with no 304 available.
  local revalidate='no-cache'

  echo -e "\n${BLUE}[1/4] Enabling static website hosting on ${YELLOW}${FRONTEND_STORAGE_ACCOUNT}${BLUE}...${NC}"
  # NOTHING ELSE TURNS THIS ON: the ARM type has no property for it (BCP037), so bicep stops at
  # creating the account. Idempotent, and first, so a missing permission fails before the build.
  az storage blob service-properties update \
    --account-name "$FRONTEND_STORAGE_ACCOUNT" --auth-mode login --output none \
    --static-website --index-document index.html --404-document index.html \
    || { echo -e "${RED}✗ could not enable static website hosting on ${FRONTEND_STORAGE_ACCOUNT}${NC}" >&2
         echo -e "${RED}  403 here means the identity holds only Storage Blob Data Contributor.${NC}" >&2
         echo -e "${RED}  This call needs Microsoft.Storage/storageAccounts/blobServices/write —${NC}" >&2
         echo -e "${RED}  grant Storage Account Contributor on this account and re-run.${NC}" >&2
         return 1; }

  echo -e "\n${BLUE}[2/4] Building Angular frontend production bundle...${NC}"
  # env.js is rewritten in the SOURCE by scripts/point-env-js.sh, before this build, so `yarn build`
  # copies the corrected file.
  yarn --cwd "$REPO_ROOT/frontend" build

  # The environment is the LAST field of both resource-group shapes here — `c4b0a8-test-rg` and
  # `rg-demi-prod`. Dropping the FIRST field instead yields `demi-prod` on prod.
  local env="${RESOURCE_GROUP%-rg}"; env="${env##*-}"
  local dist_env_js="$REPO_ROOT/frontend/dist/env.js"
  # Assert, never rewrite: a hand deploy that skipped point-env-js.sh must stop here rather than
  # ship one environment's config to another (2026-08-11). ENVIRONMENT is what pins the target.
  if ! grep -qF "window.__env.API_LOCATION = ''" "$dist_env_js" \
     || ! grep -qF "window.__env.configEndpoint = true" "$dist_env_js" \
     || ! grep -qF "window.__env.ENVIRONMENT = '$env'" "$dist_env_js"; then
    echo -e "${RED}✗ dist/env.js is not deploy-ready for '${env}': it must keep API_LOCATION empty,${NC}" >&2
    echo -e "${RED}  configEndpoint true and ENVIRONMENT '${env}'.${NC}" >&2
    echo -e "${RED}  Run ./scripts/point-env-js.sh ${env} first, then re-run this script.${NC}" >&2
    return 1
  fi
  echo -e "${GREEN}✓ env.js is deploy-ready for ${env}${NC}"

  # Source maps hand the public bundle's original TypeScript back to anyone who asks for them.
  find "$REPO_ROOT/frontend/dist" -name '*.map' -delete

  echo -e "\n${BLUE}[3/4] Uploading to ${YELLOW}${FRONTEND_STORAGE_ACCOUNT}${BLUE}/\$web...${NC}"
  # PASS 1 IS UNFILTERED, DELIBERATELY: `--pattern` takes one fnmatch glob and cannot spell
  # "everything else", so a pattern-only scheme ships whatever it forgot with no Cache-Control.
  blob_upload "$nostore"

  # PASS 2: content-hashed filenames only. `outputHashing: all` hashes what Angular EMITS — the .js
  # and .css — so assets, favicon.ico and env.js are copied through unhashed and must stay out.
  local ext
  for ext in js css; do
    blob_upload "$immutable" "*.${ext}"
  done

  # PASS 2b: unhashed assets. The URL outlives the bytes, so not immutable — but `no-cache` keeps
  # the copy and revalidates it, which is what an unhashed-but-cacheable file wants.
  for ext in png jpg jpeg gif svg woff woff2 ttf eot; do
    blob_upload "$revalidate" "*.${ext}"
  done

  # PASS 3: env.js is the one unhashed .js, so pass 2 just gave it a year of immutable caching. A
  # stale copy points the browser at the wrong environment with nothing logged anywhere.
  blob_upload "$nostore" 'env.js'

  # ponytail: no prune — old hashed bundles accumulate in $web at fractions of a cent a month.
  # Upgrade path: `az storage blob delete-batch -s '$web'` filtered on --if-unmodified-since.
  echo -e "\n${BLUE}[4/4] Done${NC}"
  echo -e "${GREEN}✓ Frontend published to \$web on ${FRONTEND_STORAGE_ACCOUNT}${NC}"
  echo -e "${YELLOW}  Front Door caches in front of this. index.html is uploaded no-store so the${NC}"
  echo -e "${YELLOW}  edge re-reads it; hashed assets get new names, so neither needs a purge.${NC}"
}

case "$TARGET" in
  frontend) deploy_frontend ;;
  *)        echo -e "${RED}Invalid target '$TARGET'. Supported: frontend${NC}"; exit 1 ;;
esac

echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN} Deployment completed successfully!${NC}"
echo -e "${GREEN}====================================================${NC}"
