# Eagle DEMI Instructions

Document Extraction & Machine Intelligence for EPIC on Azure Serverless.

## Configuration & Architecture

- **Runtime**: Azure Functions v4 (Node.js 22) wrapping Express API routes on `Y1` Consumption Plan.
- **Native Stream Adapter (`api/index.js`)**: Custom Node `Readable` stream adapter bridging Azure Functions `HttpRequest` to Express without third-party socket/proxy adapter overhead.
- **Rate Limiter (`src/middleware/rate-limiter.js`)**: Dynamic `inlineCleanup` when `isServerless` is true (avoids background `setInterval` timers).
- **Package Deployment**: Requires `WEBSITE_RUN_FROM_PACKAGE=1` for atomic zip package mounting at `/home/site/wwwroot/`.
- **Infrastructure as Code**: Bicep modules in `azure/main.bicep` and `azure/modules/`.
- **Port**: 3000 (local Express) / 443 (Azure Function App HTTPS).
- **Security**: Access restricted via API key (`X-Api-Key` header) and Keycloak JWT Bearer authentication.

## CRITICAL Mandates

- **Timeout Chain**: Ensure timeouts are aligned across the stack: `docling-serve` (280s) < `eagle-api` (300s) < Azure Function App (330s).
- **Secrets**: App secrets managed via Azure Key Vault / App Settings in Bicep IaC.

## Tuning & Extraction Architecture

- **OCR Engine**: RapidOCR is configured as default engine (`DOCLING_SERVE_DEFAULT_OCR_ENGINE=rapidocr`) for balanced CPU speed and accuracy.
- **Queueing & Batching**: Operates in RQ mode (`DOCLING_SERVE_ENG_KIND=rq`) with Redis. `eagle-api` splits PDFs into 10-page batches and queues them to avoid `docling-serve` hanging on massive legacy documents.
- **Container Apps Processing**: Typesense and worker tasks run in Azure Container Apps (`demi-typesense-{env}`) scaled dynamically.

## Decoupled Database Architecture

- **Azure Cosmos DB for MongoDB**: DEMI uses serverless Azure Cosmos DB for MongoDB (`demi-mongo-{env}`).
- **Direct Connection Bypass**: Connection string uses direct serverless cluster endpoint.
- **Multi-Source Project Model (`sources.*`)**:
  - `sources.track`: Master EAO attributes from EPIC.track.
  - `sources.eagle`: Legacy EAGLE portal project attributes.
  - `sources.nrpti`: Public compliance & enforcement record metrics.
- **NRPTI Project Auto-Seeding & Reconciliation**:
  - `src/scripts/sync-nrpti.js` matches C&E records against existing projects via `_epicProjectId`, exact name, or fuzzy normalized name (`normalizeProjectName`).
  - Unmatched C&E records **auto-seed new `Project` documents** with `sources.nrpti` metrics and `sources.track: null`.
  - When TRACK syncs EAO projects, it reconciles against existing documents, populating `sources.track` and root EAO metadata without breaking existing NRPTI record links.

## API Security & Search Gating

- **isPublished Root-level Flag**: Project and Document schemas store root-level, indexed `isPublished` boolean flags. Populated from legacy `read` arrays during seeding (presence of `"public"` = `isPublished: true`). Track-only projects default to `isPublished: false`.
- **Read Controller Gating**: GET API routes check for administrative credentials (`X-Api-Key`):
  - Requests without key (public users) are dynamically filtered to return only `isPublished: true` projects/documents.
  - Authenticated administrative/internal requests bypass all publication filters.

## Self-Contained Search & Typesense Indexing Architecture

- **Standalone Search Service**: `eagle-demi` handles search independently.
- **Embedded Ingest Watcher**: Typesense Change Stream indexer lives in `/src/typesense`.
- **Automatic Daemon Startup**: Loaded on server startup in `src/server.js` and background function execution. Skipped when `NODE_ENV === 'test'`.
- **Direct Frontend Integration**: Frontend `basePath` points to `/api` so that it communicates natively on same host. No complex proxy definitions needed.

## Local Development Modes

Local development of the DEMI frontend can be run in two modes:

* **Direct Mode (Remote Dev API)**:
  * Configure `window.__env.API_PATH` in `env.js` to point to `https://demi-api-dev.azurewebsites.net/api`.
  * Start only the frontend with `cd frontend && yarn dev`.
* **Full-Stack Mode (Local Backend + Local/Remote DB)**:
  * Configure `window.__env.API_PATH` in `env.js` to point to `http://localhost:3000/api`.
  * Run backend with `node src/server.js`.
  * Start frontend with `cd frontend && yarn dev`.

## Keycloak Session Persistence & Refresh Handling

To circumvent browser third-party cookie blocking on `localhost` during iframe silent SSO checks (`check-sso`), DEMI utilizes a `sessionStorage` fallback:
- **First-Time Page Load / New Tab**: `sessionStorage` does not contain `isLoggedIn`. Initializes Keycloak in `'check-sso'` mode. No unwanted automatic redirect loops or forced login prompts occur.
- **Button-Triggered Login**: Sets `sessionStorage.setItem('isLoggedIn', 'true')` upon successful authentication.
- **Page Refresh (Active Session)**: Reads `isLoggedIn` from `sessionStorage` and initializes Keycloak using `'login-required'`. Keycloak silently verifies the active top-level session via direct redirect and logs the user back in instantly, preserving authenticated state across refreshes.
- **Logout**: Clears `sessionStorage` and `localStorage`, returning the client to standard public access mode.

## GIS Map & Topological Boundary Assets Architecture

- **Static Asset Serving**: Pre-processed GeoJSON boundary files (`regional_districts.geojson`, `municipalities.geojson`, `electoral_districts.geojson`) are served directly from `frontend/public/assets/geojson/`.
- **Topological Arc Simplification**: Boundaries are built using `node scripts/export-topological-boundaries.js` which executes Mapshaper Visvalingam-Whyatt arc simplification (`-clean -simplify visvalingam keep-shapes`). Shared borders between neighboring polygons are simplified as shared arcs, guaranteeing **zero overlaps or sliver gaps**.
- **Default Layer & Zoom Rules**:
  - `activeBoundaryLayers` defaults to `['regions']` (Environmental Regions ON by default).
  - Zoom-gating was removed so that all administrative boundary layers (including municipalities) render regardless of Leaflet zoom level.

## Azure Environments (`c4b0a8: EPIC.AI`)

Account: `Daniel.T.Truong@gov.bc.ca` | Tenant: `Government of BC` (`6fdb5200-3d0d-4a8a-b036-d3685e359adc`)

| Environment | Subscription Name | Subscription ID |
|---|---|---|
| **dev** | `c4b0a8-dev - EPIC.AI` | `d2f8d048-2af3-44fd-81cc-858c040001f2` |
| **test** | `c4b0a8-test - EPIC.AI` | `7897ceb1-9a86-4639-87d7-7f9ff67142b3` |
| **tools** | `c4b0a8-tools - EPIC.AI` | `82efd4f0-7548-4fe6-8741-9e6c3297092f` |
| **prod** | `c4b0a8-prod - EPIC.AI` | `be5924ac-1083-4a1b-be92-7b444882cfd9` |

Switch active subscription: `az account set --subscription "<subscription_id>"`.

