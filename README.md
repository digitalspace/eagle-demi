# eagle-demi

DEMI (Document Extraction & Machine Intelligence) for EPIC. Deploys `docling-serve` as a cluster-internal PDF/DOCX extraction endpoint. Called by eagle-api on document upload; no custom application code — pure Helm deployment of the official upstream image.

## Quick Start

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

## Architecture

- Image: `ghcr.io/docling-project/docling-serve-cpu:v1.21.0`
- Port: `5001` (ClusterIP only — not exposed externally)
- Auth: `X-Api-Key` header from `eagle-demi-api-key` OpenShift Secret
- NetworkPolicy restricts ingress to eagle-api pods (`role: api-eagle-epic`) only

eagle-api calls `http://eagle-demi:5001/v1/convert/file` on document upload, stores extracted text as `DocumentChunk` records in MongoDB, and eagle-typesense syncs those to the `document_chunks` Typesense collection.

## Configuration

All tunable limits live in `helm/values.yaml` — override per environment in `helm/values-{env}.yaml`.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `config.maxFileSize` | `104857600` | Max upload size (bytes; 100 MB) |
| `config.maxDocumentTimeout` | `300` | Per-document timeout (seconds) |
| `config.maxNumPages` | `500` | Max pages per document |
| `config.numThreads` | `4` | Torch CPU threads |
| `config.numWorkers` | `2` | Engine worker processes |

## Related Repositories

- [eagle-api](https://github.com/bcgov/eagle-api) — Calls eagle-demi on upload
- [eagle-typesense](https://github.com/digitalspace/eagle-typesense) — Syncs DocumentChunks to Typesense
- [eagle-dev-guides.wiki](https://github.com/bcgov/eagle-dev-guides/wiki) — Architecture docs

