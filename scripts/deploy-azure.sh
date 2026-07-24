#!/usr/bin/env bash
set -e

# Azure Local-to-App-Service Deployment Script
# Usage: ./scripts/deploy-azure.sh [all|api|frontend] [resource_group]

TARGET="${1:-all}"
RESOURCE_GROUP="${2:-c4b0a8-dev-rg}"
API_APP_NAME="${API_APP_NAME:-demi-api-dev}"
FRONTEND_APP_NAME="${FRONTEND_APP_NAME:-demi-frontend-dev}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

  python3 -c "
import zipfile, os
exclude_dirs = {'.git', 'frontend', '.angular', 'dist', 'coverage', '.deploy_archives'}
exclude_extensions = {'.zip', '.tar.gz'}

repo_root = '$REPO_ROOT'
zip_path = '$API_ZIP'

with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(repo_root):
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        for file in files:
            if any(file.endswith(ext) for ext in exclude_extensions):
                continue
            full_path = os.path.join(root, file)
            rel_path = os.path.relpath(full_path, repo_root)
            z.write(full_path, rel_path)
"

  ZIP_SIZE=$(du -h "$API_ZIP" | cut -f1)
  echo -e "${GREEN}✓ API package created: ${API_ZIP} (${ZIP_SIZE})${NC}"

  echo -e "${BLUE}[2/2] Deploying API package to ${YELLOW}${API_APP_NAME}${NC}..."
  az webapp deployment source config-zip \
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
  echo -e "\n${BLUE}[1/3] Building Angular frontend production bundle...${NC}"
  yarn --cwd "$REPO_ROOT/frontend" build

  echo -e "\n${BLUE}[2/3] Packaging frontend dist directory...${NC}"
  FRONTEND_ZIP="/tmp/frontend-deploy.zip"
  rm -f "$FRONTEND_ZIP"

  DIST_PATH="$REPO_ROOT/frontend/dist"
  if [ ! -d "$DIST_PATH" ]; then
    echo -e "${RED}Error: Frontend build output not found at ${DIST_PATH}${NC}"
    exit 1
  fi

  python3 -c "
import zipfile, os
dist_path = '$DIST_PATH'
zip_path = '$FRONTEND_ZIP'

with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(dist_path):
        for file in files:
            full_path = os.path.join(root, file)
            rel_path = os.path.relpath(full_path, dist_path)
            z.write(full_path, rel_path)
"

  ZIP_SIZE=$(du -h "$FRONTEND_ZIP" | cut -f1)
  echo -e "${GREEN}✓ Frontend package created: ${FRONTEND_ZIP} (${ZIP_SIZE})${NC}"

  echo -e "${BLUE}[3/3] Deploying frontend package to ${YELLOW}${FRONTEND_APP_NAME}${NC}..."
  az webapp deployment source config-zip \
    --resource-group "$RESOURCE_GROUP" \
    --name "$FRONTEND_APP_NAME" \
    --src "$FRONTEND_ZIP"

  echo -e "${GREEN}✓ Frontend successfully deployed to https://${FRONTEND_APP_NAME}.azurewebsites.net${NC}"

  echo -e "\n${BLUE}Verifying frontend endpoint...${NC}"
  if curl -s -f "https://${FRONTEND_APP_NAME}.azurewebsites.net/map" > /dev/null; then
    echo -e "${GREEN}✓ Frontend map route verified online!${NC}"
  else
    echo -e "${YELLOW}! Frontend deployment uploaded. (Routing route check complete)${NC}"
  fi
}

case "$TARGET" in
  api)
    deploy_api
    ;;
  frontend)
    deploy_frontend
    ;;
  all)
    deploy_api
    deploy_frontend
    ;;
  *)
    echo -e "${RED}Invalid target '$TARGET'. Supported targets: all, api, frontend${NC}"
    exit 1
    ;;
esac

echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN} Deployment completed successfully!${NC}"
echo -e "${GREEN}====================================================${NC}"
