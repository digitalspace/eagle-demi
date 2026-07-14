# Eagle DEMI Instructions

Document Extraction & Machine Intelligence for EPIC.

## Configuration & Usage

- **Base Image**: Uses upstream `docling-serve-cpu` directly. No custom app code.
- **Port**: 5000 (ClusterIP only).
- **Security**: Access restricted to `eagle-api` via `NetworkPolicy`. Requires `X-Api-Key` header.

## CRITICAL Mandates

- **Internal Only**: Never expose via Route or Ingress. It is a cluster-internal extraction service.
- **Timeout Chain**: Ensure timeouts are aligned across the stack: `docling-serve` (280s) < `eagle-api` (300s) < `rproxy` (330s) < `HAProxy` (360s).
- **Secrets**: `eagle-demi-api-key` must be created manually before first deployment and shared with `eagle-api`.

## Tuning & Architecture

- **OCR Engine**: RapidOCR is configured as the default engine (`DOCLING_SERVE_DEFAULT_OCR_ENGINE=rapidocr`) due to its balance of speed and accuracy on CPU compared to Tesseract.
- **Queueing & Batching**: Operates in RQ mode (`DOCLING_SERVE_ENG_KIND=rq`) with Redis. The `eagle-api` splits PDFs into 10-page batches and queues them to avoid `docling-serve` hanging on massive legacy documents.
- **Autoscaling**: KEDA (`ScaledObject`) is used to scale `eagle-demi-worker` pods based on the Redis queue length (`rq:queue:convert`), ensuring burst capacity during heavy ETL while scaling to zero when idle.
- **Resource Limits**: CPU limits on workers are set to burst (`3000m`), while requests are kept low (`250m`) to fit within namespace quotas, prioritizing processing speed when nodes have spare capacity.

## Decoupled Database Architecture

- **Standalone Setup**: DEMI hosts its own independent MongoDB StatefulSet (`eagle-demi-mongodb`) with a dedicated Persistent Volume Claim (`eagle-demi-mongodb-pvc`) mounted at `/data/db`.
- **Direct Connection Bypass**: Appended `MONGODB_DIRECT: "true"` to environment variables to ensure the Mongoose client connects directly without trying to resolve a replica-set primary.
- **Authentication Source**: Root-level admin user and credential initialization via community image defaults require `authSource=admin` appended to connection URIs.

## API Security & Search Gating

- **isPublished Root-level Flag**: Project and Document schemas explicitly store root-level, indexed `isPublished` boolean flags. These are populated from legacy `read` arrays during seeding (where presence of `"public"` equals `isPublished: true`). Track-only projects are defaulted to `isPublished: false`.
- **Read Controller Gating**: GET API routes (`getProjects`, `getProject`, `getDocuments`, `getDocument`) check for administrative credentials (`X-Api-Key`):
  - Requests without the key (public users) are dynamically filtered to return only `isPublished: true` projects and documents whose parent projects are published.
  - Authenticated administrative/internal requests bypass all publication filters.

## Self-Contained Search & Typesense Indexing Architecture

- **Standalone Search Service**: `eagle-demi` handles its own search independently of `eagle-api` or external indexing services.
- **Embedded Ingest Watcher**: The Typesense Change Stream indexer and full-sync engine are copied into `/src/typesense`.
- **Automatic Daemon Startup**: The Change Stream sync watcher is loaded on server startup in `src/server.js` and runs in the background. It is skipped when `NODE_ENV === 'test'` to prevent test suites from trying to connect to mock databases.
- **Direct Frontend Integration**: Frontend default `basePath` in `app.component.ts` points to `/api` (instead of `/api/demi`) so that it communicates natively on the same host (port 3000). No CORS configuration or complex proxy definitions are needed.
- **Zero Ecosystem Changes**: `eagle-api` and `eagle-typesense` are kept completely untouched and clean. All search, ingestion, indexing, and presentation code remains 100% inside `eagle-demi`.

## Dual Local Development Modes

Local development of the DEMI frontend can be run in two modes:

* **Direct Mode (Bypassing Local Backend & DB Port-Forward)**:
  * Configure `window.__env.API_PATH` in `env.js` to point to the remote Dev API: `https://eagle-demi-api-6cdc9e-dev.apps.silver.devops.gov.bc.ca/api`.
  * Start only the frontend with `cd frontend && yarn dev`.
  * No database port-forwarding or local Express server execution required. This matches the standard `eagle-admin` local development paradigm.
* **Full-Stack Mode (Local Backend + Database Tunnel)**:
  * Configure `window.__env.API_PATH` in `env.js` to point to `http://localhost:3000/api`.
  * Open a secure database tunnel with `oc port-forward pods/eagle-demi-mongodb-0 27017:27017`.
  * Run the local backend with `node src/server.js`.
  * Start the frontend with `cd frontend && yarn dev`.
  * Required only when testing backend schema, Express routing, or database connection modifications locally.

## Keycloak Session Persistence & Refresh Handling

To circumvent browser third-party cookie blocking on `localhost` during iframe silent SSO checks (`check-sso`), DEMI utilizes a `sessionStorage` fallback:
- **First-Time Page Load / New Tab**: `sessionStorage` does not contain `isLoggedIn`. Initializes Keycloak in `'check-sso'` mode. No unwanted automatic redirect loops or forced login prompts occur.
- **Button-Triggered Login**: Sets `sessionStorage.setItem('isLoggedIn', 'true')` upon successful authentication.
- **Page Refresh (Active Session)**: Reads `isLoggedIn` from `sessionStorage` and initializes Keycloak using `'login-required'`. Keycloak silently verifies the active top-level session via direct redirect and logs the user back in instantly, preserving authenticated state across refreshes.
- **Logout**: Clears `sessionStorage` and `localStorage`, returning the client to standard public access mode.
