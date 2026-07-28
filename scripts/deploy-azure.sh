#!/usr/bin/env bash
set -e

# Azure Deployment Script for DEMI (API, Frontend, and Container App Job)
# Usage: ./scripts/deploy-azure.sh [all|api|frontend|job] [resource_group]

TARGET="${1:-all}"
RESOURCE_GROUP="${2:-c4b0a8-dev-rg}"
API_APP_NAME="${API_APP_NAME:-demi-api-dev}"
FRONTEND_APP_NAME="${FRONTEND_APP_NAME:-demi-frontend-dev}"
JOB_NAME="${JOB_NAME:-demi-sync-job-dev}"
CONTAINER_ENV_NAME="${CONTAINER_ENV_NAME:-demi-container-env-dev}"
LOCATION="${LOCATION:-canadacentral}"
export REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}====================================================${NC}"
echo -e "${BLUE} Azure Direct Deployment: ${YELLOW}${TARGET}${BLUE} -> ${YELLOW}${RESOURCE_GROUP}${NC}"
echo -e "${BLUE}====================================================${NC}"

deploy_api() {
  echo -e "\n${BLUE}[1/2] Packaging API source code...${NC}"
  API_ZIP="/tmp/api-deploy.zip"
  rm -f "$API_ZIP"

  python3 "$REPO_ROOT/scripts/package-api.py" "$REPO_ROOT" "$API_ZIP"

  ZIP_SIZE=$(du -h "$API_ZIP" | cut -f1)
  echo -e "${GREEN}✓ API package created: ${API_ZIP} (${ZIP_SIZE})${NC}"

  echo -e "${BLUE}[2/2] Deploying API package to Function App ${YELLOW}${API_APP_NAME}${NC}..."
  az functionapp deployment source config-zip \
    --resource-group "$RESOURCE_GROUP" \
    --name "$API_APP_NAME" \
    --src "$API_ZIP"

  echo -e "${GREEN}✓ Backend API successfully deployed to https://${API_APP_NAME}.azurewebsites.net${NC}"
  
  echo -e "\n${BLUE}Verifying API health...${NC}"
  if curl -s -f "https://${API_APP_NAME}.azurewebsites.net/api/config" > /dev/null; then
    echo -e "${GREEN}✓ API endpoint verified online!${NC}"
  else
    echo -e "${YELLOW}! API deployment uploaded. (Health check endpoint returned non-200 or starting up)${NC}"
  fi
}

deploy_frontend() {
  echo -e "\n${BLUE}[1/2] Building Angular frontend production bundle...${NC}"
  yarn --cwd "$REPO_ROOT/frontend" build

  echo -e "\n${BLUE}[2/2] Deploying frontend static bundle to Azure Web App ${YELLOW}${FRONTEND_APP_NAME}${NC}..."
  FRONTEND_ZIP="/tmp/frontend-deploy.zip"
  rm -f "$FRONTEND_ZIP"
  
  python3 -c "
import zipfile, os
dist_dir = '$REPO_ROOT/frontend/dist'
zip_path = '$FRONTEND_ZIP'
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(dist_dir):
        for file in files:
            full_path = os.path.join(root, file)
            rel_path = os.path.relpath(full_path, dist_dir)
            z.write(full_path, rel_path)
"

  ZIP_SIZE=$(du -h "$FRONTEND_ZIP" | cut -f1)
  echo -e "${GREEN}✓ Frontend package created: ${FRONTEND_ZIP} (${ZIP_SIZE})${NC}"

  az webapp deployment source config-zip \
    --resource-group "$RESOURCE_GROUP" \
    --name "$FRONTEND_APP_NAME" \
    --src "$FRONTEND_ZIP"

  echo -e "${GREEN}✓ Frontend successfully deployed to https://${FRONTEND_APP_NAME}.azurewebsites.net${NC}"
}

deploy_job() {
  echo -e "\n${BLUE}[1/2] Checking Azure Container Apps Environment ${YELLOW}${CONTAINER_ENV_NAME}${NC}..."
  if ! az containerapp env show --name "$CONTAINER_ENV_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
    echo -e "${YELLOW}Creating Container App Environment ${CONTAINER_ENV_NAME}...${NC}"
    az containerapp env create \
      --name "$CONTAINER_ENV_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --location "$LOCATION"
  fi

  echo -e "\n${BLUE}[2/2] Deploying Container App Job ${YELLOW}${JOB_NAME}${NC} (Cron: '0 2 * * *' nightly scale-to-zero)..."
  if az containerapp job show --name "$JOB_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
    az containerapp job update \
      --name "$JOB_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --cron-expression "0 2 * * *"
  else
    az containerapp job create \
      --name "$JOB_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --environment "$CONTAINER_ENV_NAME" \
      --trigger-type "Schedule" \
      --cron-expression "0 2 * * *" \
      --replica-timeout 3600 \
      --replica-retry-limit 3 \
      --image "mcr.microsoft.com/azuredocs/aci-helloworld:latest" \
      --cpu "0.5" \
      --memory "1.0Gi"
  fi

  echo -e "${GREEN}✓ Container App Job ${JOB_NAME} successfully configured!${NC}"
}

case "$TARGET" in
  api)
    deploy_api
    ;;
  frontend)
    deploy_frontend
    ;;
  job)
    deploy_job
    ;;
  all)
    deploy_api
    deploy_frontend
    deploy_job
    ;;
  *)
    echo -e "${RED}Invalid target '$TARGET'. Supported targets: all, api, frontend, job${NC}"
    exit 1
    ;;
esac

echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN} Deployment completed successfully!${NC}"
echo -e "${GREEN}====================================================${NC}"
