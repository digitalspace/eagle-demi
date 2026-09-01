#!/usr/bin/env bash
set -euo pipefail

# Azure frontend deployment script for DEMI.
# Usage: ./scripts/deploy-azure.sh [frontend] [resource_group]
#
# THE API IS NOT DEPLOYED FROM HERE. It runs on Flex Consumption, which has no Kudu wwwroot to
# POST a zip into — it publishes to the deployment blob container declared in
# `azure/modules/api-function-flex.bicep`, through `az functionapp deployment source config-zip`.
# See `.github/workflows/azure-deploy-staging-api.yaml`.

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

# This script carries NO credential. `az` is signed in as a human on a workstation or — after
# `azure/login` — as the federated service principal on a CI runner. Same code, different
# principal, nothing stored.
#
# Fail fast and say WHICH principal. `az account show` reads local config and answers even with an
# expired session, so the token fetch is what actually proves a usable login; and printing the
# principal is what makes it visible in a CI log that the deploy ran as the service principal.
preflight_identity() {
  local who type
  who=$(az account show --query user.name -o tsv 2>/dev/null || true)
  type=$(az account show --query user.type -o tsv 2>/dev/null || true)
  if [ -z "$who" ] || [ -z "$(az account get-access-token --query accessToken -o tsv 2>/dev/null)" ]; then
    echo -e "${RED}✗ no Azure token. Run 'az login', or check the Azure Login step.${NC}" >&2
    exit 2
  fi
  echo -e "${BLUE}Authenticated as:${NC} ${who} (${type})"
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
  # Stored, but revalidated before every use. For unhashed files whose bytes CAN change: a changed
  # asset is picked up on the next navigation, and an unchanged one costs a 304 rather than the whole
  # font. `no-store` would be wrong here — it forbids keeping the response at all, so there is
  # nothing to revalidate against and every image and font is refetched in full, every time.
  local revalidate='no-cache'

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
  # Two resource-group shapes in this estate, and the environment is the LAST field in both:
  # `c4b0a8-test-rg` (subscription prefix, `-rg` suffix) and `rg-demi-prod` (prod, no suffix).
  # Dropping the FIRST field instead — what this did until 2026-08-19 — yields `demi-prod` on
  # prod and then asserts against `demi-api-demi-prod`, an app that cannot exist.
  local env="${RESOURCE_GROUP%-rg}"; env="${env##*-}"
  # The deployed bundle calls same-origin /api (Front Door -> APIM) and reads the rest of its
  # config from /api/config; a bundle with local-dev values would call the wrong API entirely.
  if ! grep -qF "window.__env.API_LOCATION = ''" "$REPO_ROOT/frontend/dist/env.js" \
     || ! grep -qF "window.__env.configEndpoint = true" "$REPO_ROOT/frontend/dist/env.js"; then
    echo -e "${RED}✗ dist/env.js is not deploy-ready: it must keep API_LOCATION empty (same-origin /api) and configEndpoint true${NC}" >&2
    echo -e "${RED}  Apply the rewrites from the 'Point env.js at the test environment' step in${NC}" >&2
    echo -e "${RED}  .github/workflows/azure-deploy-staging-frontend.yaml to frontend/public/env.js, then re-run.${NC}" >&2
    return 1
  fi
  echo -e "${GREEN}✓ env.js is deploy-ready (same-origin /api, configEndpoint on)${NC}"

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
  #
  # Images and fonts are out for the same reason: `outputHashing: all` hashes only what Angular
  # EMITS, which is the .js and .css. Assets are copied through under their source names, so an
  # immutable year on them means a changed logo or font never reaches a browser that saw the old one.
  local ext
  for ext in js css; do
    blob_upload "$immutable" "*.${ext}"
  done

  # PASS 2b: unhashed assets. They cannot be immutable (the URL outlives the bytes) but leaving them
  # on pass 1's `no-store` overcorrects — that forbids caching outright, so every font and image is
  # refetched in full on every navigation with no 304 available. `no-cache` keeps the copy and
  # revalidates it, which is the behaviour an unhashed-but-cacheable file wants.
  #
  # favicon.ico stays on pass 1: it is one small file, requested once, and the comment above is the
  # standing argument for that. Fonts are not that.
  for ext in png jpg jpeg gif svg woff woff2 ttf eot; do
    blob_upload "$revalidate" "*.${ext}"
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
  frontend) deploy_frontend ;;
  *)        echo -e "${RED}Invalid target '$TARGET'. Supported: frontend${NC}"; exit 1 ;;
esac

echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN} Deployment completed successfully!${NC}"
echo -e "${GREEN}====================================================${NC}"
