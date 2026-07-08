# Eagle DEMI Instructions

Document Extraction & Machine Intelligence for EPIC.

## Configuration & Usage

- **Base Image**: Uses upstream `docling-serve-cpu` directly. No custom app code.
- **Port**: 5001 (ClusterIP only).
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
