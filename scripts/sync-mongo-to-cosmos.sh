#!/usr/bin/env bash
# ==============================================================================
# Repeatable Data Sync Script: OpenShift MongoDB -> Azure Cosmos DB
# ==============================================================================

set -euo pipefail

NAMESPACE="${OPENSHIFT_NAMESPACE:-6cdc9e-dev}"
RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-c4b0a8-dev-rg}"
COSMOS_ACCOUNT_NAME="${COSMOS_ACCOUNT_NAME:-demi-mongo-dev-pcbd7cygyic52}"
DUMP_DIR="./tmp/mongo-sync-dump"

echo "=== 1. Checking Prerequisites ==="
command -v oc >/dev/null 2>&1 || { echo "Error: 'oc' CLI is required."; exit 1; }
command -v az >/dev/null 2>&1 || { echo "Error: 'az' CLI is required."; exit 1; }
command -v mongodump >/dev/null 2>&1 || { echo "Error: 'mongodump' is required."; exit 1; }
command -v mongorestore >/dev/null 2>&1 || { echo "Error: 'mongorestore' is required."; exit 1; }

echo "=== 2. Discovering OpenShift MongoDB Pod ==="
MONGO_POD=$(oc get pods -n "$NAMESPACE" -l app=mongodb -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

if [ -z "$MONGO_POD" ]; then
  echo "Error: No active MongoDB pod found in OpenShift namespace '$NAMESPACE'."
  exit 1
fi
echo "Found OpenShift MongoDB Pod: $MONGO_POD"

echo "=== 3. Retrieving Azure Cosmos DB Connection String ==="
COSMOS_URI=$(az cosmosdb keys list \
  --name "$COSMOS_ACCOUNT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --type connection-strings \
  --query "connectionStrings[0].connectionString" \
  -o tsv)

if [ -z "$COSMOS_URI" ]; then
  echo "Error: Failed to retrieve connection string for $COSMOS_ACCOUNT_NAME."
  exit 1
fi

echo "=== 4. Dumping OpenShift MongoDB Data ==="
rm -rf "$DUMP_DIR"
mkdir -p "$DUMP_DIR"

oc exec -n "$NAMESPACE" "$MONGO_POD" -- mongodump --db=demi --archive=/tmp/demi_backup.archive
oc cp "$NAMESPACE/$MONGO_POD:/tmp/demi_backup.archive" "$DUMP_DIR/demi_backup.archive"
oc exec -n "$NAMESPACE" "$MONGO_POD" -- rm /tmp/demi_backup.archive

echo "=== 5. Restoring to Azure Cosmos DB ==="
mongorestore \
  --uri="$COSMOS_URI" \
  --archive="$DUMP_DIR/demi_backup.archive" \
  --nsInclude="demi.*" \
  --drop \
  --ssl

echo "=== 6. Cleanup Local Temp Dump ==="
rm -rf "$DUMP_DIR"

echo "=== SUCCESS: OpenShift MongoDB successfully synced to Azure Cosmos DB! ==="
