# DEMI OCR Scalability Plan (CPU-only, RapidOCR)

**Status:** prototype / dev. **OCR engine decision: RapidOCR (locked).** GPU explicitly out of scope.

## Related: DEMI Document Intake (implemented in eagle-api)

The single-upload-point intake lives in **eagle-api**, not here. `POST /api/demi/extract` uploads to MinIO, creates a staff-only `Document`, and runs the same 10-page-batch + RapidOCR extraction this plan defines, writing `DocumentChunks` for Typesense. See `eagle-api/CLAUDE.md` → "DEMI Document Intake". End-state pipeline (future, not built): upload → docling (OCR scans) → auto-tag vs EAO label set with confidence → manual-review gate (`demiReviewStatus`) → store → content search. Chunk-writing is duplicated in `eagle-api/api/helpers/documentChunker.js` (port of `src/extract.js` + `src/chunker.js`) — **keep the `DocumentChunk` shape in sync across both repos.**

## Background & Motivation
OCR extraction of large legacy **scanned** documents (e.g. the 11.4MB Mount Polley Copper PDF) fails in dev. `docling-serve` processes whole files at once → memory spikes + timeouts. Goal: an architecture that scales predictably on **CPU-only** OpenShift without unbounded pod resources or GPU, and proves the OCR prototype on real EIA volumes.

## Goals / Non-Goals
- **Goal:** bounded, constant worker memory regardless of document size.
- **Goal:** fastest viable CPU OCR with no custom Docker image (config-only engine selection).
- **Goal:** per-env isolation; horizontal worker scaling.
- **Non-goal:** GPU inference. Whole platform is CPU-only on OpenShift Silver. GPU-class models (granite-docling VLM) are parked — see *Future Work*.

## Architecture Decision Record

### ADR-1: Keep the control-plane / data-plane split (RQ engine)
Reference patterns (IBM Code Engine serverless fleets; arxiv "Operationalizing Document AI") converge on: **lightweight control plane + stateless heavy workers, joined by a queue + object storage.** Already half-built:

| Pattern role | Existing piece |
|--------------|----------------|
| Control plane (CPU-cheap API) | `docling-serve` API pod (RQ mode, no models loaded) |
| Queue | `eagle-demi-redis` (RQ) |
| Data plane (stateless OCR worker) | `docling-serve` rq-worker (loads models, runs inference) |
| Object storage | MinIO (extract.js source files) |

**Decision:** stay on RQ; finish the pattern (KEDA autoscale), don't rebuild.

### ADR-2: OCR engine = RapidOCR (locked)
docling runs OCR **only** on scanned/image regions (text PDFs → embedded text extracted directly). The failing case (Mount Polley) is degraded legacy scans. Engines evaluated:

| Engine | CPU verdict |
|--------|-------------|
| granite-docling-258M (VLM) | ✗ GPU model — 35–40s/page on CPU raw; unusable |
| EasyOCR | ✗ PyTorch backend, slow on CPU; weights not even pre-cached in image |
| PaddleOCR | ✗ requires heavy PaddlePaddle framework; **not a docling-native engine** (needs custom image); its PP-Structure tables/layout are redundant — docling has its own layout + TableFormer |
| Tesseract 4.1.1 | ~ bundled; good on clean scans, weaker on degraded; old (5.x is current) |
| **RapidOCR 3.8.1** | ✅ **bundled; ONNX Runtime only (~50–80MB, no framework); docling-native; runs PaddleOCR's PP-OCR weights** |

**Key fact:** RapidOCR *is* PaddleOCR's models converted to ONNX — same accuracy, none of the PaddlePaddle weight, and it's the docling-supported engine name. Verified bundled in the running image: `rapidocr` 3.8.1 + 16M ONNX weights (`ch_PP-OCRv4_det/rec` + `cls`). Config-only switch — **no custom image** (preserves CLAUDE.md rule).

### ADR-3: Namespace topology = per-env (NOT shared, NOT `-tools`)
Each environment runs its own docling stack (`6cdc9e-dev`, `-test`, `-prod`). Rejected:
- **One shared OCR across envs** — prod restricted docs (staff-only `read` arrays) would transit a pod exposed to lower-env access (data governance breach); one bad doc OOMs all envs (blast radius); fights BC Gov per-env network isolation.
- **Move runtime to `6cdc9e-tools`** — `-tools` is the **build** namespace (BuildConfigs/ImageStreams; `requests.cpu` hard = 2). Not a runtime home.

Cost objection (3× idle model RAM) is removed by **KEDA scale-to-zero** — idle workers = 0 pods.

## OCR Engine Configuration (RapidOCR specifics)

**Selection mechanism:** server-wide default via env `DOCLING_SERVE_DEFAULT_OCR_ENGINE=rapidocr`.

**Helm wiring (requires a template edit — not values-only):** `worker-deployment.yaml` maps env from `.Values.config.*` explicitly. Add:
- `helm/values.yaml` → `config.defaultOcrEngine: "rapidocr"`
- `helm/templates/worker-deployment.yaml` → new env entry:
  ```yaml
  - name: DOCLING_SERVE_DEFAULT_OCR_ENGINE
    value: {{ .Values.config.defaultOcrEngine | quote }}
  ```
- `helm/templates/deployment.yaml` (API pod) → same env, for non-RQ fallback consistency. (In RQ mode the **worker** loads/runs OCR, so the worker env is the one that matters.)

**Bundled weights nuance:** RapidOCR 3.x ships **PP-OCRv4 Chinese** det/rec models. PP-OCR handles Latin/English adequately, but for best English accuracy on degraded scans, English-specific models can be swapped in later (would add a small HF-cache PVC). Start with bundled models; only swap if accuracy is poor.

**⚠️ Verification caveat:** docling-serve [issue #567](https://github.com/docling-project/docling-serve/issues/567) reports `ocr_engine` ignored on `/v1/convert/file` in some versions (the v1.21.0 range in use). After deploy, **confirm the selected engine actually loads** by grepping worker logs during a job (look for the rapidocr model load line). Re-check for each A/B arm below.

**Fallback engine:** Tesseract (`tesseract`, in-process `tesserocr` 2.10.0 + `eng`/`osd` data, also bundled). Kept as the A/B comparator and degraded-scan fallback. Switch by setting `defaultOcrEngine: "tesseract"`.

## PDF Pre-split Design (pdf-lib, "chunk at the source")
1. **Pre-split** large PDFs with pure-JS `pdf-lib` into 10-page batches before reaching the Python ML service. Caps peak per-batch tensor RAM — the actual OOM cause.
2. **Sequential inference:** send each 10-page batch to docling-serve's synchronous API one at a time → constant memory regardless of document size.
3. **Reassembly:** concatenate batch markdown, then chunk for Typesense as usual.
4. Non-PDF inputs (DOCX/PPTX/XLSX) bypass splitting — sent whole.
5. `try/catch` fallback: if `pdf-lib` fails to parse, send the entire file.

## Resource Sizing (per environment)

**Two distinct levels — don't conflate:**
- **Per-pod** `requests`/`limits` → set by us in Helm (table below).
- **Namespace `ResourceQuota`** → ceiling on the **sum** of all pods' requests in the env; owned by the BC Gov platform team. The binding constraint is `requests.cpu` (dev/test hard = 2000m, prod = 8000m). Memory (32Gi) and pods (100) have headroom.

**Strategy:** low CPU **request** (fits namespace quota) + high CPU **limit** (bursts on spare node CPU). Limits don't count against `requests.cpu` quota.

| Component | CPU req | CPU limit | RAM req | RAM limit | Storage |
|-----------|---------|-----------|---------|-----------|---------|
| docling-serve API (control plane) | 50m | 500m | 256Mi | 512Mi | none |
| redis (queue) | 50m | 200m | 128Mi | 256Mi | emptyDir |
| **rq-worker (OCR data plane)** | **250–500m** | **dev/test 3000m · prod 4000m** | **5Gi** | **6Gi** | emptyDir 2Gi `/tmp` |
| extract.js CronJob | 100m | 1000m | 256Mi | 512Mi | none (in-mem) |

**Per-env CPU request fit (live quota):** dev ~720m free (req 500m OK) · test ~340m free ⚠️ (req ≤250m or quota bump) · prod ~1580m free (2 KEDA workers × 500m = 1000m OK).

**RAM:** models ~4.4GB resident during a job; req 5Gi (scheduling), limit 6Gi (RapidOCR ONNX lighter than EasyOCR torch; +~200Mi for in-mem PDF buffer / pdf-lib split). Scale-to-zero → idle workers reserve nothing.

**Storage:** no PVCs for the prototype. RapidOCR (16M) + docling models ship in the image → RAM. `/tmp` scratch + redis use emptyDir. Add a 2–5Gi RWX cache PVC **only** if English RapidOCR models are downloaded from HF later.

## Phased Implementation Plan

### Phase 1 — Dependencies
- `eagle-api/` (branch `develop`): `yarn add pdf-lib`.
- `eagle-demi/` (branch `main`): `npm install pdf-lib` → add to `package.json` dependencies.

### Phase 2 — Refactor extraction logic
- **`eagle-api/api/helpers/jobQueue.js`** (`demi-extract` job): replace the async-submit + poll loop with **sequential synchronous** batch calls.
  - Load buffer: `PDFDocument.load(fileBuffer, { ignoreEncryption: true })`.
  - `pageCount <= 10` → single POST `/v1/convert/file` (sync response has `document.md_content` directly — no `task_id`/polling).
  - `pageCount > 10` → loop batches of 10: new `PDFDocument`, copy pages, save buffer, POST, concat markdown.
  - Update `job.attrs.data.progress` per batch (`{ batch, totalBatches }`).
  - `try/catch` fallback: whole-file send if pdf-lib fails.
  - ⚠️ Removes the async polling path entirely — a larger change than a simple wrap.
- **`eagle-demi/src/extract.js`** (`extractWithDocling` / `processDocument`): identical 10-page batching; non-PDF bypass; `try/catch` whole-file fallback.

### Phase 3 — Helm changes (`eagle-demi/helm`)
1. **OCR engine (RapidOCR):**
   - `values.yaml` → add `config.defaultOcrEngine: "rapidocr"`.
   - `templates/worker-deployment.yaml` + `templates/deployment.yaml` → add the `DOCLING_SERVE_DEFAULT_OCR_ENGINE` env entry (see *OCR Engine Configuration*).
2. **Unbounded server paging** (Node now bounds chunk size): `values.yaml` → `config.maxNumPages: "500"` → `"0"`.
3. **Per-env resources:** apply the sizing table in `values-dev.yaml` / `values-test.yaml` / `values-prod.yaml` (worker CPU req/limit, 5Gi/6Gi RAM); `/tmp` emptyDir sizeLimit 2Gi.
4. **KEDA autoscale (rq-worker):** add a `ScaledObject` on redis queue length (`rq:queue:convert`), `minReplicaCount: 0`, `maxReplicaCount: 2` (prod) / `1` (dev/test). Replaces fixed `rq.worker.replicas`.

### Phase 4 — Rebuild eagle-demi worker image
`Dockerfile.worker` runs `npm install` at build. After Phase 1+2:
```bash
docker build -f Dockerfile.worker -t ghcr.io/digitalspace/eagle-demi-worker:latest .
docker push ghcr.io/digitalspace/eagle-demi-worker:latest
oc rollout restart deployment/eagle-demi-worker -n 6cdc9e-dev
```
(values-dev uses `pullPolicy: Always`, `tag: latest` → restart pulls the new image.)

### Phase 5 — Deploy (dev first)
```bash
helm upgrade --install eagle-demi ./helm -n 6cdc9e-dev \
  --values ./helm/values-dev.yaml --wait --timeout=10m
```

## Verification
1. **Confirm RapidOCR actually loads** (issue #567 guard): trigger one extraction, grep worker logs for the RapidOCR model-load line. If Tesseract/EasyOCR loads instead, the env was ignored → fall back to per-request `ocr_engine` in the convert options.
2. **OCR engine A/B on Mount Polley Copper:** run the same scanned doc with `defaultOcrEngine: rapidocr` then `tesseract`. Compare wall-time (`oc adm top pod`) + eyeball markdown accuracy across page-batch boundaries. Lock the winner (expected: RapidOCR on degraded scans).
3. **Memory bound:** confirm peak worker RAM stays under the 6Gi limit throughout.
4. **Coherence:** markdown is continuous across 10-page batch seams (no dropped/duplicated content at boundaries).

## Resource Request (namespace-level, for BC Gov platform team)
Request increases to the **namespace `compute-long-running` `requests.cpu` quota** (not per-pod). Memory/pods unchanged.

| Env | `requests.cpu`: from → to | Drives | Needed when |
|-----|---------------------------|--------|-------------|
| test | 2000m → **2500m** | single worker req fits (only ~340m free today) | Path A (prototype) |
| dev | 2000m → **4000m** | 1 guaranteed worker @ 2 CPU | Path B (throughput) |
| test | 2000m → **4000m** | 1 guaranteed worker @ 2 CPU | Path B |
| prod | 8000m → **12000m** | KEDA 0→2 workers @ 2 CPU each | Path B |

**Path A (bursty / prototype):** low worker request + high limit; only the small **test** bump is required. **Path B (guaranteed throughput / scaling):** the full table; set worker request=2000m/limit=4000m. **Verify with platform:** `limits.cpu`/`limits.memory` quota headroom too — Path A bursts worker limits to 3–4 cores even with low requests.

## Future Work (GPU-gated / later)
- **granite-docling-258M VLM** — single-model OCR+layout+tables+equations+charts; superior on complex structure. Needs GPU (vLLM ~0.35s/page on A100; ~35–40s/page CPU raw). Adopt only when GPU is available. GGUF/llama.cpp CPU build exists for benchmarking but not production.
- **RapidOCR accuracy upgrade without leaving CPU/ONNX:** swap newer **PP-OCRv5/v6** ONNX models into RapidOCR and enable the **OpenVINO** backend (~5.2× CPU speedup on PP-OCRv6) — no PaddlePaddle, no custom framework. Path stays inside RapidOCR.
- **English RapidOCR models** from HF (`SWHL/RapidOCR`) if bundled Chinese-default PP-OCRv4 underperforms on English scans — adds a small HF-cache PVC.

## Migration & Rollback
- **Rollback:** revert `jobQueue.js`, `extract.js`, Helm values + template env edits; redeploy previous worker image tag. No DB schema changes.
- **Quota:** if scaling workers beyond request budget (esp. test, ~340m free), file the namespace `requests.cpu` increase before rollout.
