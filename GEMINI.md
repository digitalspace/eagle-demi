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

## Tuning

- Adjust `DOCLING_SERVE_MAX_FILE_SIZE` and `DOCLING_NUM_THREADS` in Helm values based on environment load.
