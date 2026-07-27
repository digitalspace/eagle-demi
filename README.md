# eagle-demi

DEMI (Document Extraction & Machine Intelligence) for EPIC on Azure Serverless. 

This repository houses:
1. **demi-api**: The central, authoritative REST API and geospatial search engine for projects, documents, and administrative boundaries running as an Azure Function App (`@azure/functions` v4).
2. **eagle-demi-worker**: Background worker calling `docling-serve` for PDF/DOCX page-level chunk extraction.
3. **demi-frontend**: Angular 19 document intake frontend deployed to Azure App Service / Web App.

---

## Central API Server (demi-api)

The Node.js server acts as the master directory of truth. It manages projects, documents, and administrative regions with native geospatial MongoDB / Cosmos DB queries.

### Setup and Local Execution

1. Install dependencies:
   ```bash
   yarn install
   ```

2. Start the API Server locally (runs on port `3000` by default):
   ```bash
   yarn start
   ```

3. Seed administrative boundaries and retroactively tag existing projects:
   ```bash
   node src/scripts/seed-boundaries.js
   ```

4. View Swagger API documentation:
   * **URL**: `http://localhost:3000/api-docs`

---

## Azure Deployment Quick Start

### Deploy via GitHub Actions Workflows

* **Dev Environment**: Automatic deployment on push to `main` via `.github/workflows/azure-deploy-dev.yaml`.
* **Test Environment**: Trigger manually via `.github/workflows/azure-deploy-test.yaml`.
* **Prod Environment**: Trigger manually via `.github/workflows/azure-deploy-prod.yaml`.

### Direct Deployment Script

Deploy directly from terminal using the Azure CLI:

```bash
# Deploy both API and Frontend to Dev
./scripts/deploy-azure.sh all c4b0a8-dev-rg

# Deploy API Function App only
./scripts/deploy-azure.sh api c4b0a8-dev-rg
```

---

## Azure Serverless Architecture

- **Runtime**: Azure App Service / Web App (Node.js 22 Express REST API).
- **Database**: Azure Cosmos DB (MongoDB API v7.0 in Serverless mode).
  - Configured with `COSMOSDB_URI` and `COSMOSDB_DATABASE`.
  - Configured with `publicNetworkAccess: 'Disabled'` to satisfy BC Gov management group policy (`Deny-PublicPaaSEndpoints`).
  - Auto-enforces `retryWrites=false` and TLS 1.2.
- **Search Engine**: Azure Container Apps hosting Typesense with embedded Change Stream sync.
- **Auth**: Dual-layered validation in `src/middleware/auth.js`. Supports `X-Api-Key` for system-to-system integration and Keycloak `Bearer` tokens.
- **Geospatial Order**: GeoJSON requires `[longitude, latitude]`. Downstream sync engines swap coordinates to `[latitude, longitude]` for search indexes.

---

## Document Intake Frontend (frontend)

The standalone Angular 19 application lives under `frontend/`. It compiles into static assets and is deployed to Azure Web App (`demi-frontend-{env}`).

### Key Features
* **Interactive Map Explorer**: View and query project coordinates.
* **Deep Text Search**: Query extracted document chunks powered by Typesense.
* **Document Ingestion**: Upload files with integrated, searchable project dropdowns.

---

## Related Repositories

- [eagle-api](https://github.com/bcgov/eagle-api) — Reads read-only cached project/document entries
- [eagle-typesense](https://github.com/digitalspace/eagle-typesense) — Syncs DocumentChunks from MongoDB to Typesense
