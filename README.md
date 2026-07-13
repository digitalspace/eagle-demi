# eagle-demi

DEMI (Document Extraction & Machine Intelligence) for EPIC. 

This repository houses:
1. **demi-api**: The central, authoritative REST API and geospatial search engine for projects, documents, and administrative boundaries.
2. **eagle-demi-worker**: Background worker calling `docling-serve` (running as a cluster-internal PDF/DOCX extraction service) to parse page-level chunks.

---

## Central API Server (demi-api)

The Express server acts as the master directory of truth. It manages projects, documents, and administrative regions with native geospatial MongoDB queries.

### Setup and Local Execution

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the API Server locally (runs on port `5001` by default):
   ```bash
   npm start
   ```

3. View Swagger API documentation:
   * **URL**: `http://localhost:5001/api-docs`

---

## Quick Start (Extraction Service Deployment)

**Prerequisites:** Create the API key secret in each namespace before deploying:

```bash
oc create secret generic eagle-demi-api-key \
  --from-literal=DOCLING_SERVE_API_KEY=$(openssl rand -hex 32) \
  -n 6cdc9e-dev
```

**Deploy to dev:**

```bash
helm upgrade --install eagle-demi ./helm \
  --namespace 6cdc9e-dev \
  --values ./helm/values-dev.yaml \
  --wait --timeout=10m
```

**Deploy to test/prod:** Use the GitHub Actions `workflow_dispatch` workflows in `.github/workflows/`.

---

## Architecture

- **API Port**: `5001` (ClusterIP only — not exposed externally)
- **Auth**: `X-Api-Key` header verified against `eagle-demi-api-key` OpenShift Secret for mutations (POST, PUT, DELETE).
- **Geospatial Order**: MongoDB GeoJSON requires `[longitude, latitude]`. Downstream sync engines automatically swap coordinates to `[latitude, longitude]` when feeding search indexes like Typesense.
- **NetworkPolicy** restricts ingress to eagle-api pods (`role: api-eagle-epic`) only.

---

## Configuration

All tunable limits live in `helm/values.yaml` — override per environment in `helm/values-{env}.yaml`.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `config.maxFileSize` | `104857600` | Max upload size (bytes; 100 MB) |
| `config.maxDocumentTimeout` | `300` | Per-document timeout (seconds) |
| `config.maxNumPages` | `500` | Max pages per document |
| `config.numThreads` | `4` | Torch CPU threads |
| `config.numWorkers` | `2` | Engine worker processes |

---

## Document Intake Frontend (frontend)

The standalone Angular 19 application lives under `frontend/`. It compiles into static assets housed in `public/` and is served directly by `demi-api`.

### Key Features
* **Interactive Map Explorer**: View and query project coordinates.
* **Deep Text Search**: Query extracted document chunks powered by the Typesense search engine.
* **Document Ingestion**: Upload files with an integrated, searchable project dropdown menu (supports both production 24-character hexadecimal MongoDB ObjectIDs and local mock numeric IDs).

---

## Related Repositories

- [eagle-api](https://github.com/bcgov/eagle-api) — Reads read-only cached project/document entries
- [eagle-typesense](https://github.com/digitalspace/eagle-typesense) — Syncs DocumentChunks from MongoDB to Typesense
- [eagle-dev-guides.wiki](https://github.com/bcgov/eagle-dev-guides/wiki) — Architecture docs


