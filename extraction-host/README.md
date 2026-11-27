# extraction-host

This directory holds the document extraction code: the off-platform GPU host and the Azure Container Apps job. Both convert a document to markdown and post it back to DEMI. The host is vendored, not deployed: nothing in this repository installs or updates it.

Both callers post to the same route:

```
POST /api/documents/:id/chunks     { markdown }  |  { error }
```

The header is `X-Api-Key`. The API chunks the markdown and copies `read[]` from the live document, so neither caller can widen a document's visibility.

## What is here

| File | What it holds |
|---|---|
| `extract_core.py` | Routing, conversion, provenance, download and chunk posting. The host and the job both import it, so they produce the same markdown. |
| `worker.py` | The host's extraction run: snapshots the work list, converts on threads, writes `out/<id>.md` |
| `ingest.py` | The host's second phase: posts the finished markdown from `out/` to the API |
| `job.py` | One job execution: one message off the `extract` queue, one document, posted directly |
| `Dockerfile`, `requirements-job.txt` | The CPU job image. Models are fetched at build time. |
| `test_poolfix.py`, `test_job.py`, `test_ingest.py` | Regression checks for the process pool, the job's message outcomes and ingest's retry limit |
| `parity_check.py`, `fixtures/` | Converts a digital PDF, a scan and a `.docx` through the host's threads and through the job and compares the markdown byte for byte |
| `systemd/` | The three host units as deployed: `gpu-extractor`, `gpu-ingest`, `doc-ocr-service` |

Secrets, run state and extracted output are **not** here, and `.gitignore` enforces that rather than relying on care at commit time. In particular `gpu-extractor.env` holds a live `DEMI_ADMIN_KEY`.

That file is also **a second authoritative copy of DEMI's `ADMIN_API_KEY`**. Treat it as a backup, not just as this host's config. If you rotate the key, change it here *and* in the `demi-app-secrets` OpenShift secret in `6cdc9e-test`.

## The job

DEMI queues `{documentId, projectId, reason, enqueuedAt}` on the `extract` queue. Each job execution takes one message and handles it as follows.

| Case | What the job does with the message | What it posts |
|---|---|---|
| Row extracted, deleted, an `UPDATE` image, or gone | Deletes it | Nothing |
| Source file answers 404 | Deletes it; the backlog sweep queues the row again after 7 days | Nothing |
| Unsupported format, failed download or failed conversion | Deletes it | `{error}`, which is permanent |
| Converted | Deletes it | `{markdown, extraction}`, NDJSON at 4 MB or more |
| Runner fault (broken pool, out of memory) | Leaves it to reappear after 7800 s | Nothing |
| Third dequeue, or a body without `documentId` | Moves it to `extract-poison` and logs `[extraction] poison` | Nothing |

Settings:

| Variable | Value |
|---|---|
| `DEMI_API` | The Function host's `/api` base, called directly because a large chunk post outlives the APIM timeout |
| `DEMI_ADMIN_KEY` | The `extraction-job` registry key, from vault secret `extraction-job-api-key`. Same name as on the host. |
| `EXTRACTION_QUEUE_ACCOUNT` | Storage account holding the queues |
| `EXTRACTION_QUEUE` | Queue name, default `extract` |
| `EXTRACTION_POISON_QUEUE` | Poison queue name, default `<EXTRACTION_QUEUE>-poison` |
| `EXTRACTION_VISIBILITY_SECONDS` | Visibility timeout of a received message, default 7800; keep it above the replica timeout |
| `AZURE_CLIENT_ID` | Client id of the job's managed identity, used for the queues |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Sends the job's logs to App Insights, where the poison alert reads `AppTraces` |
| `OCR_DEVICE` | `cpu` in the image, `cuda` on the host (default). It is named in the provenance engine string. |

The other tuning variables (`MAX_FILE_MB`, `OCR_BATCH_PAGES`, the router and tiling thresholds) live in `extract_core.py` and mean the same on both.

## Page markers

Each document is posted as one markdown string. Consecutive pages are separated by a form feed (`\f`), never one at the start or the end. A page that converted to nothing still gets its marker, so the page count stays right.

The API's chunker splits on the marker and stamps each chunk with its page. That turns `pageNumber` into a page a reader can quote.

Both routes emit it. The text route joins pypdfium2's per-page list. The OCR route asks docling for one page at a time with `export_to_markdown(page_no=...)`, which returns an empty string for an empty page.

Page batches are converted separately, and their page lists concatenate in order. The marker carries no newlines around it on purpose. The NDJSON route splits on blank lines and drops whitespace-only blocks, so a marker on its own line would be lost.

## Checks

```bash
python3 worker.py --selfcheck                          # prints "selfcheck ok"; no network, GPU or docling
DEMI_ADMIN_KEY=x WORK_DIR=<scratch dir> python3 test_poolfix.py
pytest extraction-host/                                # test_job.py and test_ingest.py, API and queue faked
OCR_DEVICE=cpu python3 parity_check.py                 # needs docling; prints "parity ok"
```

`--selfcheck` covers `decide()`, the text-versus-OCR routing rule, and the work-list filter. It does not run `test_poolfix.py`.

## Keeping it in step

The host has no automation. If the host changes, copy the file back into this directory in the same commit as the reasoning, so this directory does not become another stale copy.
