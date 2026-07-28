# eagle-demi

DEMI (Document Extraction & Machine Intelligence) for EPIC on Azure Serverless. 

This repository houses:
1. **demi-api**: Central, authoritative REST API and geospatial search engine for projects, documents, and administrative boundaries running as an Azure Function App (`@azure/functions` v4 on Node.js 22).
2. **eagle-demi-worker**: Background worker calling `docling-serve` for PDF/DOCX page-level chunk extraction.
3. **demi-frontend**: Angular 19 document intake frontend deployed to Azure App Service / Static Web App.

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

4. Run NRPTI Compliance & Enforcement sync (merges with existing projects or auto-seeds new ones):
   ```bash
   NODE_PATH=node_modules node -r dotenv/config src/scripts/sync-nrpti.js
   ```

5. View Swagger API documentation:
   * **URL**: `http://localhost:3000/api-docs`

---

## Multi-Source Project Integration & Auto-Seeding

DEMI uses a multi-source hybrid project model (`sources.*` namespace):
* **`sources.track`**: Master EAO project attributes from EPIC.track (`epictrack-api`).
* **`sources.eagle`**: Legacy EAGLE portal project records.
* **`sources.nrpti`**: Public compliance & enforcement records from NRPTI API (`Order`, `Inspection`, `Ticket`, etc.).

### NRPTI Reconciliation Workflow (`src/scripts/sync-nrpti.js`)
1. **Matching**: NRPTI records match existing projects via `_epicProjectId`, exact name, or fuzzy normalized name (`normalizeProjectName`).
2. **Auto-Seeding**: When an NRPTI record refers to a project not yet in DEMI, a new `Project` document is **auto-seeded** with `sources.nrpti` metrics and `sources.track: null`.
3. **TRACK Reconciliation**: When TRACK syncs EAO metadata, it enriches any existing NRPTI-seeded project documents with `sources.track` attributes, completing the composite record while preserving all C&E record links.

---

## Azure Serverless Architecture

- **Runtime**: Azure Functions v4 (`@azure/functions` v4 on Node.js 22, `Y1` Consumption Plan).
- **Native Stream Adapter (`api/index.js`)**: Converts Azure Functions v4 `HttpRequest` objects into Node.js `Readable` streams and bridges them directly into Express route handlers without external socket or proxy adapter overhead.
- **Serverless-Safe Rate Limiter (`src/middleware/rate-limiter.js`)**: Dynamically switches to `inlineCleanup` mode when `isServerless` is true, avoiding background `setInterval` timers that lock process state or leak memory during execution freeze cycles.
- **Atomic Deployment (`WEBSITE_RUN_FROM_PACKAGE=1`)**: Packages the API into a read-only zip archive mounted directly at `/home/site/wwwroot/` for zero-downtime, instant cold starts.
- **Database**: Azure Cosmos DB (Native `@azure/cosmos` SQL SDK).
  - Configured with `COSMOSDB_URI`, `COSMOSDB_DATABASE`, and `COSMOSDB_KEY`.
  - Native repository models (`src/db/cosmos.js` and `src/models/*.js`) handle all CRUD operations with `/id` partition keys.
  - Legacy `mongoose` and `mongodb` dependencies have been completely removed.
- **Incremental Delta Sync Engine**: Azure Container App Job (`demi-sync-job-{env}`) scheduled nightly (`0 2 * * *`), utilizing `sync_state` high-water mark timestamps (`lastSyncedAt`) to perform efficient delta ingestion across NRPTI, Wildfires, and Track sources.
- **Search Engine**: Azure Container Apps hosting Typesense (`demi-typesense-{env}`).
- **Auth**: Dual-layered validation in `src/middleware/auth.js`. Supports `X-Api-Key` for system-to-system integration and Keycloak `Bearer` tokens.
- **Geospatial Order**: GeoJSON requires `[longitude, latitude]`. Downstream sync engines swap coordinates to `[latitude, longitude]` for search indexes.

---

## IaC & Deployment Workflows

Infrastructure is defined via Bicep (`azure/main.bicep` and `azure/modules/`).

### Direct Deployment Script

Deploy directly from terminal using the Azure CLI script:

```bash
# Deploy both API and Frontend to Dev
./scripts/deploy-azure.sh all c4b0a8-dev-rg

# Deploy API Function App only
./scripts/deploy-azure.sh api c4b0a8-dev-rg

# Deploy Frontend Web App only
./scripts/deploy-azure.sh frontend c4b0a8-dev-rg
```

### GitHub Actions Workflows

* **Dev Environment**: Automatic deployment on push to `main` via `.github/workflows/azure-deploy-dev.yaml`.
* **Test Environment**: Trigger manually via `.github/workflows/azure-deploy-test.yaml`.
* **Prod Environment**: Trigger manually via `.github/workflows/azure-deploy-prod.yaml`.

---

## Document Intake Frontend (frontend)

The standalone Angular 19 application lives under `frontend/`. It compiles into static assets and is deployed to Azure Web App (`demi-frontend-{env}`).

### Key Features & GIS Architecture
* **Interactive Map Explorer**: View and query project coordinates and administrative overlays.
* **Topological GIS Static Assets**: Pre-generated GeoJSON assets (`regional_districts.geojson`, `municipalities.geojson`, `electoral_districts.geojson`) located in `frontend/public/assets/geojson/`.
  * Generated via `node scripts/export-topological-boundaries.js` using Mapshaper (`-clean -simplify visvalingam keep-shapes`).
  * Uses Visvalingam-Whyatt arc topology simplification to ensure zero boundary overlaps or sliver gaps between adjacent areas.
  * Static file sizes are optimized to ~550 KB - 1.3 MB, providing instant < 30ms map load speeds.
* **Default Map Overlays**: Environmental Regions (`'regions'`) are enabled by default on initial page load.
* **Zoom-Independent Polygon Rendering**: All administrative boundary layers (including municipalities) render seamlessly across all zoom levels without artificial zoom gating.
* **Deep Text Search**: Query extracted document chunks powered by Typesense.
* **Document Ingestion**: Upload files with integrated, searchable project dropdowns.

---

## Related Repositories

- [eagle-api](https://github.com/bcgov/eagle-api) — Reads read-only cached project/document entries
- [eagle-typesense](https://github.com/digitalspace/eagle-typesense) — Syncs DocumentChunks from MongoDB to Typesense

