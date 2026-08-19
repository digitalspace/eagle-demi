#!/usr/bin/env python3
"""Extract a document's text layer and post it to eagle-search.

WHAT THIS IS NOT. It is not a port of `extraction-host/worker.py`. That file is 1,193
lines because it drives a GPU: process pools, converter recycling, tiling, OOM ceilings, docling and
torch. None of that is needed here, because **the text path never touches a GPU** — `extract_text`
there is twenty lines of pypdfium2, and the routing probe is pypdfium2 too. Measured on this corpus,
that path covers **56% of documents (34,153)**.

So this covers the 56% with a small dependency (one wheel, no CUDA, no model download) and records
the other 44% as a countable backlog rather than pretending to handle it. The OCR half is `ocr.py`,
whose header carries the argument for running it on a CPU rather than reaching for a GPU again.

THE ROUTING RULE IS COPIED, NOT INVENTED. `decide()` and its thresholds come from
`extraction-host/worker.py:344` unchanged. They were tuned against this corpus, and re-deriving them
from intuition would silently change which documents get OCR'd.

Usage:
    python3 extract.py --document-id <id> [--dry-run]
    python3 extract.py --document-ids a,b,c
    echo '<id>' | python3 extract.py --stdin

Environment:
    EAGLE_API_BASE   default https://eagle-dev.apps.silver.devops.gov.bc.ca
    INGEST_URL       eagle-search base, e.g. https://eagle-search-api-dev.azurewebsites.net
    INGEST_KEY       shared key for /ingest/markdown
"""

import argparse
import json
import os
import statistics
import sys
import tempfile
import time
from pathlib import Path

import requests

import ocr

EAGLE_API_BASE = os.environ.get(
    "EAGLE_API_BASE", "https://eagle-dev.apps.silver.devops.gov.bc.ca"
).rstrip("/")
INGEST_URL = os.environ.get("INGEST_URL", "").rstrip("/")
INGEST_KEY = os.environ.get("INGEST_KEY", "")

# --- routing thresholds, copied verbatim from extraction-host/worker.py -----------------------
# A document is "text" when its pages already carry enough characters that OCR would find nothing
# more. Changing these changes the OCR bill and the extraction quality together, so they are pinned
# by tests rather than left to drift.
MIN_CHARS_PER_PAGE = int(os.environ.get("MIN_CHARS_PER_PAGE", "200"))
MIN_TEXT_FRACTION = float(os.environ.get("MIN_TEXT_FRACTION", "0.8"))
LOW_YIELD_MIN_BYTES = int(os.environ.get("LOW_YIELD_MIN_BYTES", "200000"))
LOW_YIELD_CHARS = int(os.environ.get("LOW_YIELD_CHARS", "500"))
PROBE_PAGES = int(os.environ.get("PROBE_PAGES", "20"))
MAX_FILE_MB = int(os.environ.get("MAX_FILE_MB", "300"))

# Types with no text layer to find. Sent straight to the OCR backlog rather than probed.
IMAGE_EXTS = {"jpg", "jpeg", "png", "tif", "tiff", "bmp", "gif"}
# Types pypdfium2 cannot open at all. docling handles these; this extractor does not.
DOCLING_EXTS = {"docx", "pptx", "xlsx", "htm", "html", "md"}


def log(msg):
    print(msg, flush=True)


def decide(counts, size):
    """Pure decision half of the routing. Copied from worker.py:344 — see `selfcheck`."""
    if not counts:
        return "ocr"
    median = statistics.median(counts)
    fraction = sum(1 for c in counts if c > 50) / len(counts)
    if median >= MIN_CHARS_PER_PAGE and fraction >= MIN_TEXT_FRACTION:
        return "text"
    # A tiny file with a little text is a short digital document, not a scan — OCR would find
    # nothing more. Only substantial files are worth the GPU.
    if size < LOW_YIELD_MIN_BYTES and median > 0:
        return "text"
    return "ocr"


def real_chars(md):
    """Characters that are actually text. Whitespace and docling's image markup are not."""
    if not md:
        return 0
    return len("".join(md.split()).replace("<!--image-->", ""))


def probe_pdf(path):
    """Characters already present on a sample of pages. Counts only; never extracts."""
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(path)
    try:
        total = len(doc)
        # A sample, not the whole document: the decision is about the document's character, and
        # opening 3,000 pages to learn it costs more than the extraction does.
        step = max(1, total // PROBE_PAGES)
        counts = []
        for i in range(0, total, step):
            page = doc[i]
            tp = page.get_textpage()
            counts.append(len(tp.get_text_range().strip()))
            tp.close()
            page.close()
        return counts
    finally:
        doc.close()


def extract_text(path):
    """Text layer straight out of the file. No GPU, no layout model, milliseconds.

    Pages are joined with a blank line because `chunker.js` splits on `/\\n{2,}/` — that is what
    gives it block boundaries to accumulate against. The page INDEX is dropped here, which is why
    `pageNumber` in the index is a passage sequence rather than a PDF page. Recovering it is a
    known follow-up: the per-page list exists right here, one line above the join.
    """
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(path)
    try:
        pages = []
        for i in range(len(doc)):
            page = doc[i]
            tp = page.get_textpage()
            pages.append(tp.get_text_range())
            tp.close()
            page.close()
        return "\n\n".join(p.strip() for p in pages if p.strip())
    finally:
        doc.close()


def download(document_id):
    """Fetch the document bytes from eagle-api's public endpoint.

    PUBLIC DOCUMENTS ONLY. Non-public ones need a credential this extractor does not hold, so they
    are reported as skipped rather than failed — their chunks would be stamped non-public anyway,
    so this is a coverage gap, not a disclosure risk.
    """
    url = f"{EAGLE_API_BASE}/api/public/document/{document_id}/download/document"
    r = requests.get(url, timeout=300, stream=True)
    if r.status_code == 404:
        raise FileNotFoundError(f"not available publicly (HTTP 404): {document_id}")
    r.raise_for_status()

    tmp = Path(tempfile.mkstemp(prefix="extract-", suffix=".bin")[1])
    size = 0
    with tmp.open("wb") as fh:
        for block in r.iter_content(chunk_size=1 << 20):
            size += len(block)
            if size > MAX_FILE_MB * 1024 * 1024:
                fh.close()
                tmp.unlink(missing_ok=True)
                raise ValueError(f"larger than MAX_FILE_MB={MAX_FILE_MB}")
            fh.write(block)
    return tmp, size


def post_markdown(document_id, markdown):
    if not INGEST_URL or not INGEST_KEY:
        raise RuntimeError("INGEST_URL and INGEST_KEY must both be set")
    r = requests.post(
        f"{INGEST_URL}/ingest/markdown",
        json={"documentId": document_id, "markdown": markdown},
        headers={"x-ingest-key": INGEST_KEY},
        timeout=300,
    )
    if r.status_code not in (200, 207):
        raise RuntimeError(f"ingest failed: HTTP {r.status_code} {r.text[:200]}")
    return r.json()


def ocr_or_backlog(path, info):
    """Read a text-poor document with OCR, or record it as backlog if OCR is off or finds nothing.

    Three outcomes, and the difference between the last two is what makes the tiling decision
    answerable later:

      `ocr`        — text was recovered and will be ingested.
      `ocr-empty`  — OCR ran and found nothing. This is the residue DEMI's 3x3 tiling exists for;
                     until it is counted here there is no evidence that tiling is worth building.
      `skip`       — nothing OCR could be pointed at: a Word file, a corrupt PDF, or OCR turned off.

    Keeping the last two apart is the whole point. Both produce no text, but one says the engine is
    inadequate and the other says it was never asked.
    """
    if not ocr.OCR_ENABLED:
        info["reason"] = f"{info.get('reason', 'text-poor')}; OCR disabled"
        return "skip", None, info

    markdown, ocr_info = ocr.ocr_file(path)
    info.update(ocr_info)
    if ocr_info.get("kind") is None or "could not open" in ocr_info.get("reason", ""):
        return "skip", None, info
    if real_chars(markdown) < 1:
        info["reason"] = f"{info.get('reason', 'text-poor')}; OCR found no text"
        return "ocr-empty", None, info
    return "ocr", markdown, info


def post_outcome(row):
    """Send the row to eagle-search, which logs it. Best effort — never fails the extraction.

    The extractor's own log line is not a reliable record. Measured on dev 2026-08-10: two ~1 s
    invocations on a cold Flex Consumption instance ran — the execution-count metric counted both —
    and emitted no application telemetry at all, while an 1,121 s OCR run on the same app logged
    normally. Short executions are torn down before the host flushes, and short executions are
    exactly the ones that produced nothing to ingest and so have no chunks to corroborate them.

    eagle-search is an always-on App Service and already holds the credential, so it keeps the
    record instead.
    """
    if not INGEST_URL or not INGEST_KEY:
        return
    try:
        requests.post(
            f"{INGEST_URL}/admin/extract-outcome",
            json=row,
            headers={"x-ingest-key": INGEST_KEY},
            timeout=30,
        )
    except Exception as e:  # noqa: BLE001
        log(f"outcome not recorded for {row.get('id')}: {e}")


def route_and_extract(path, size):
    """Probe a local file, decide, and extract if it is a text-layer document.

    Split out from `extract_one` so the routing and extraction can be exercised against a real PDF
    with no network — see `selfcheck_pdf`. Returns `(route, markdown_or_None, info)`.
    """
    info = {}
    try:
        counts = probe_pdf(path)
    except Exception as e:  # noqa: BLE001
        # An unreadable file is a reason to escalate to OCR, which opens far more than pdfium
        # will — never a reason to fail the document. Images land here too: pdfium cannot probe a
        # JPEG, and OCR is exactly what a JPEG needs.
        return ocr_or_backlog(path, {"reason": f"probe failed: {e}"})

    # `probedPages`, not `pages`: probe_pdf SAMPLES up to PROBE_PAGES pages rather than reading all
    # of them, so this is the size of the sample. The document's real length only appears when OCR
    # reads it, and calling both of them `pages` produced a row reading `pages: 21, pagesRead: 289`.
    info["probedPages"] = len(counts)
    info["median_chars"] = int(statistics.median(counts)) if counts else 0

    if decide(counts, size) == "ocr":
        info["reason"] = "probe says text-poor"
        return ocr_or_backlog(path, info)

    markdown = extract_text(path)

    # The probe said this file had text and it came back near-empty, so the probe was wrong. Hand it
    # to OCR rather than write a blank document — being biased toward OCR is only useful if this
    # case never silently succeeds.
    if real_chars(markdown) < LOW_YIELD_CHARS and size > LOW_YIELD_MIN_BYTES:
        info["reason"] = f"low yield ({real_chars(markdown)} chars from {size // 1024} KB)"
        return ocr_or_backlog(path, info)

    return "text", markdown, info


def extract_one(document_id, dry_run=False):
    """Route one document and, if it is a text-layer document, extract and post it.

    Returns a row describing what happened. `route` is `text`, `ocr`, `ocr-empty` or `skip`, and
    every document that produced no text is RECORDED rather than dropped — those counts are the only
    evidence base for what is still missing and whether tiling is worth building.
    """
    t0 = time.time()
    row = {"id": document_id, "route": None, "chunks": 0, "reason": None}

    try:
        path, size = download(document_id)
    except Exception as e:  # noqa: BLE001
        row.update(route="skip", reason=str(e))
        return row

    try:
        route, markdown, info = route_and_extract(path, size)
        row.update({k: v for k, v in info.items() if v is not None})
        row["route"] = route

        # No markdown means nothing to ingest: OCR is disabled, OCR found nothing, or the file is
        # not a type this extractor opens. The row is the record.
        if markdown is None:
            return row

        row["chars"] = len(markdown)
        if dry_run:
            row["reason"] = "dry run — nothing posted"
            return row

        result = post_markdown(document_id, markdown)
        row["chunks"] = result.get("chunks", 0)
        # `written` as well as `chunks`: the intake counts a chunk it could not stamp — one whose
        # parent document is not in the index yet — and returns it as received-but-unwritten. Without
        # this field a document that produced 139 chunks and wrote none reads as a success.
        row["written"] = result.get("written", 0)
        row["deleted"] = result.get("deleted", 0)
        return row
    finally:
        path.unlink(missing_ok=True)
        row["seconds"] = round(time.time() - t0, 1)


def selfcheck():
    """Pin the copied routing rule. `python3 extract.py --selfcheck` — no network, no PDF."""
    # Straight from worker.py's own selfcheck, so a divergence between the two shows up here.
    assert decide([], 1000) == "ocr", "no pages means nothing to read"
    assert decide([500] * 10, 10_000_000) == "text", "a good text layer is a text document"
    assert decide([0] * 10, 10_000_000) == "ocr", "a scan is a scan"
    # Median above the floor but too few pages carrying text: a mostly-scanned document with a
    # digital cover page must not be routed as text.
    assert decide([500, 500, 0, 0, 0, 0, 0, 0, 0, 0], 10_000_000) == "ocr"
    # A small file with a little text is a short digital document, not a scan.
    assert decide([50] * 5, 1000) == "text"
    # ...but the same weak text layer in a BIG file is a scan with stray characters on it.
    assert decide([50] * 5, 10_000_000) == "ocr"
    # The fraction rule is >=, so exactly 80% of pages carrying text still counts as text.
    assert decide([500] * 8 + [0, 0], 10_000_000) == "text"

    assert real_chars("  a b\tc\n") == 3
    assert real_chars(None) == 0
    print("extractor selfcheck OK")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--document-id")
    ap.add_argument("--document-ids", help="comma-separated")
    ap.add_argument("--stdin", action="store_true", help="read ids, one per line")
    ap.add_argument("--dry-run", action="store_true", help="route and extract, post nothing")
    ap.add_argument("--selfcheck", action="store_true")
    args = ap.parse_args()

    if args.selfcheck:
        selfcheck()
        return 0

    ids = []
    if args.document_id:
        ids.append(args.document_id)
    if args.document_ids:
        ids.extend(i.strip() for i in args.document_ids.split(",") if i.strip())
    if args.stdin:
        ids.extend(line.strip() for line in sys.stdin if line.strip())
    if not ids:
        ap.error("give --document-id, --document-ids or --stdin")

    totals = {"text": 0, "ocr": 0, "skip": 0, "chunks": 0}
    for document_id in ids:
        row = extract_one(document_id, dry_run=args.dry_run)
        totals[row["route"]] = totals.get(row["route"], 0) + 1
        totals["chunks"] += row.get("chunks", 0)
        log(json.dumps(row))
        if not args.dry_run:
            post_outcome(row)

    log(json.dumps({"totals": totals}))
    # The OCR count is the backlog. It is printed rather than silently skipped because "what would
    # OCR cost" is only answerable from a number that grows visibly.
    return 0


if __name__ == "__main__":
    sys.exit(main())
