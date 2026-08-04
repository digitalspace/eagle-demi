#!/usr/bin/env python3
"""
Phase 1 of the DEMI corpus backfill: document -> markdown, entirely on local disk.

This host is a disposable one-off tool, not part of DEMI's architecture. Delete this directory
when the corpus is done.

WHY THIS WRITES TO DISK INSTEAD OF POSTING
    Extraction takes days; ingest takes hours. Posting each document as it converted welded the
    two together, so every API deploy, restart or Typesense resize interrupted the GPU run. Now
    conversion only ever writes out/<id>.md, and ingest.py replays that directory whenever Azure
    is ready. Either side can be restarted without costing the other any work.

    The one thing that still needs the API is the download URL: it is presigned with a 300s TTL,
    so it cannot be fetched ahead of time, and fetching the bytes directly would mean putting
    object-store credentials on this box. That call retries with backoff, so an API restart costs
    seconds rather than a document.

ROUTING — the reason this finishes in hours instead of days
    Every PDF used to go through docling with do_ocr=True, so a digital PDF with a perfectly good
    text layer was still pushed through RapidOCR. Measured over 403 probed documents, 89% carry a
    usable text layer and 11% are scans, and the two populations separate cleanly: the text side
    has a median 2,590 characters per page, the OCR side a median of 0. So each document is ROUTED
    first:

        route()        cheap pdfium probe: how much text does the file already contain?
        extract_text() pdfium, CPU only, milliseconds, in a process pool
        extract_ocr()  docling on CUDA, seconds to minutes, CONVERTERS at a time, page-batched

    The router is deliberately biased toward OCR. Mis-routing a scan to the text path silently
    drops the document out of a lexical index, which is far worse than spending GPU time on a
    digital PDF — so it demands BOTH a healthy median AND that most sampled pages carry text, and
    anything it cannot open or is unsure about goes to OCR. A text-path result that comes back
    suspiciously empty is re-queued for OCR rather than accepted.

    These three functions are the part worth keeping: moving this pipeline into Azure later is
    re-hosting them, not rewriting the logic.

RESUMABILITY
    The work list is snapshotted once to worklist.json. A document is "done" when a .md or .err
    exists for it in out/, sent/ or dead/ — no network call needed to work out where to resume.
    All three matter: ingest.py MOVES files to sent/, so checking only out/ silently re-queued
    everything already delivered. Kill it any time.
"""

import faulthandler
import gc
import json
import multiprocessing
import os
import queue
import random
import re
import signal
import statistics
import sys
import threading
import time
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from datetime import datetime, timezone
from pathlib import Path

import requests

# 2026-08-02: 83 restarts in five hours, every one `code=killed, status=5/TRAP`, every one with no
# traceback and no stderr — a native abort leaves nothing for an `except` to catch and nothing for
# the operator to read. faulthandler prints every thread's Python stack from the signal handler, so
# the next trap names the converter thread and the docling call that was running.
#
# SIGTRAP has to be registered explicitly: PYTHONFAULTHANDLER=1 and faulthandler.enable() cover
# SEGV/BUS/FPE/ILL/ABRT and nothing else, which is precisely why those 83 crashes were silent.
# chain=True re-raises to the default handler afterwards, so the process still dies as before.
faulthandler.enable(all_threads=True)
faulthandler.register(signal.SIGTRAP, all_threads=True, chain=True)

API = os.environ.get("DEMI_API", "https://demi-api-dev.azurewebsites.net/api").rstrip("/")
# Required for any real run — a missing key must fail here, not as a puzzling 401 an hour in.
# --selfcheck touches no network, so it is the one mode that does not need it.
KEY = "" if "--selfcheck" in sys.argv else os.environ["DEMI_ADMIN_KEY"]
BASE = Path(os.environ.get("WORK_DIR", "/root/gpu-extractor"))
CACHE = BASE / "cache"
OUT = BASE / "out"
# ingest.py moves files here; already_done() must see them or the work repeats forever.
SENT = BASE / "sent"
DEAD = BASE / "dead"
WORKLIST = BASE / "worklist.json"
PROGRESS = BASE / "progress.jsonl"

LIMIT = int(os.environ.get("LIMIT", "0")) or None          # 0 = whole corpus
MAX_FILE_MB = int(os.environ.get("MAX_FILE_MB", "300"))
INFLIGHT = int(os.environ.get("INFLIGHT", "8"))
# With ~98% of documents on the CPU path, the object store is now the slowest link (161.8 GB of
# it), not the GPU. More downloaders, not more converters.
DOWNLOADERS = int(os.environ.get("DOWNLOADERS", "6"))
TEXT_WORKERS = int(os.environ.get("TEXT_WORKERS", "6"))
# Three docling converters OOM-killed this 16 GiB box (15.9 GB peak): docling holds page images
# for the whole document, so RAM scales with page count, and three large PDFs at once is the worst
# case. Two, plus the big-document lock below, stays under.
CONVERTERS = int(os.environ.get("CONVERTERS", "2"))
# Documents a pool child handles before it is replaced. Low, because a single large PDF is what
# grows a child, not the count — and a spawn is cheap next to OCR.
POOL_RECYCLE = int(os.environ.get("POOL_RECYCLE", "25"))
# Same idea for the docling converters in THIS process — see recycle_converter().
OCR_RECYCLE = int(os.environ.get("OCR_RECYCLE", "25"))
# Pages per docling call. This, not file size, is what bounds OCR memory — see split_pdf().
OCR_BATCH_PAGES = int(os.environ.get("OCR_BATCH_PAGES", "25"))
# Only one document this size converts at a time regardless of CONVERTERS. A 24 MB PDF took
# 167 s and 200k characters on its own; several concurrently is what exhausted memory.
BIG_DOC_BYTES = int(os.environ.get("BIG_DOC_MB", "8")) * 1024 * 1024
# 1000 is the API's effective cap (pageOptions clamps maxItemCount). At 100 the work-list
# build made 606 requests and tripped DEMI's own 300/min rate limiter.
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "1000"))
# A document that converts to almost nothing from a substantial file is a scan, not an empty
# document. On the OCR path that earns a forced full-page retry; on the text path it means the
# router was wrong and the document is re-queued for OCR.
LOW_YIELD_CHARS = int(os.environ.get("LOW_YIELD_CHARS", "500"))
LOW_YIELD_MIN_BYTES = int(os.environ.get("LOW_YIELD_MIN_BYTES", "200000"))

# --- tiling, for large-format sheets ------------------------------------------------------------
# Measured 2026-08-02: 2,039 documents (3.8% of everything extracted) came out holding NOTHING but
# docling's `<!-- image -->` placeholder — figures, maps, cross-sections and title-block engineering
# drawings, 2,011 of them down the OCR path. On one such page, same converter and same settings
# every time:
#
#     whole page, normal OCR ......................  0 real characters
#     whole page, force_full_page_ocr=True ........  0
#     rendered at scale 2 / 4 / 6, upright or 90° .  0 in all six
#     the SAME page cut into a 3x3 grid ...........  1,018
#     positive control (letter-size scan) .........  1,840
#
# So OCR works and the page has text: docling normalises the page image to a fixed size before OCR,
# which on a D-size sheet puts 6-point map labels under RapidOCR's detection floor. Render scale
# cannot move it — docling re-normalises whatever it is handed, which is why feeding it a 7344px
# PNG changed nothing. Cutting the page up is the only lever, because each tile is normalised on
# its own and the text survives at a readable size.
#
# The existing low-yield retry does not help and never could: it fires (median source is 822 KB,
# well over LOW_YIELD_MIN_BYTES) and forced full-page OCR returns byte-identical output.
TILE_GRID = int(os.environ.get("TILE_GRID", "3"))
# Tiles overlap so a label straddling a cut is not sliced into two unreadable halves. Duplicate
# lines from the overlap are dropped when the tiles are joined.
TILE_OVERLAP = float(os.environ.get("TILE_OVERLAP", "0.06"))
# Render scale before cutting. 6 is what the measurement above used.
TILE_RENDER_SCALE = float(os.environ.get("TILE_RENDER_SCALE", "6"))
# Hard ceiling on the rendered page, since scale x an E-size sheet is unbounded. The render is held
# whole in RAM before it is cut, and this box has been OOM-killed before.
TILE_MAX_PIXELS = int(os.environ.get("TILE_MAX_PIXELS", "60000000"))
# Tiling costs TILE_GRID^2 OCR passes per page, so it is bounded to documents small enough for that
# to be worth it. 1,775 of the 2,039 affected documents are a single page and 1,874 are two or
# fewer; a 200-page scan that comes out empty is a different problem and should not silently cost
# 1,800 OCR passes.
TILE_MAX_PAGES = int(os.environ.get("TILE_MAX_PAGES", "20"))
# Below this many real characters a conversion counts as having produced no text at all. Not zero:
# a drawing often yields a sheet number or a stray registration mark, and a document whose entire
# text is "3" is empty in every sense that matters to search.
TEXTLESS_CHARS = int(os.environ.get("TEXTLESS_CHARS", "32"))

# Router thresholds. Measured on 13 real corpus PDFs: every one scored a median of 394-5632
# characters per page, so 200 sits an order of magnitude below the digital population while a
# scanned page yields ~0. MIN_TEXT_FRACTION is what stops a scan with one digital cover page from
# passing on the median alone.
MIN_CHARS_PER_PAGE = int(os.environ.get("MIN_CHARS_PER_PAGE", "200"))
MIN_TEXT_FRACTION = float(os.environ.get("MIN_TEXT_FRACTION", "0.8"))
PROBE_PAGES = int(os.environ.get("PROBE_PAGES", "20"))

# docling picks its reader by file extension, so the cached file must carry the real one.
# Reported to the API as extraction provenance. Resolved once, here, so a version bump shows up in
# the data rather than in nobody's memory.
try:
    from importlib.metadata import version as _pkg_version
    DOCLING_VERSION = _pkg_version("docling")
except Exception:                                                 # noqa: BLE001
    DOCLING_VERSION = "unknown"

IMAGE_EXTS = {"jpg", "jpeg", "png", "tif", "tiff", "bmp", "gif"}
DOCLING_EXTS = {"docx", "pptx", "xlsx", "htm", "html", "md"}
# No reader exists for these in docling, and no amount of retrying changes that. Recorded as
# extraction errors without spending a download on them.
UNSUPPORTED_EXTS = {"msg", "zip", "rtf", "doc", "ppt", "xls", "eml", "exe", "dwg"}

# Consecutive runner faults before the run gives up. A crash that cannot be recovered would
# otherwise walk the whole work list deferring every document — cheap per document, but it burns
# the corpus and reports "0 failed" while converting nothing.
MAX_CONSECUTIVE_DEFERS = int(os.environ.get("MAX_CONSECUTIVE_DEFERS", "25"))

HEADERS = {"X-Api-Key": KEY}
stop = threading.Event()

# Failures that are the RUNNER's fault, not the document's.
#
# This distinction is the entire lesson of 2026-07-30. A ProcessPoolExecutor that breaks stays
# broken, so every later submit raised; the generic `except` in ocr_worker caught it and called
# fail(), which writes a .err, which ingest.py posts as an extraction error, which marks the
# document extracted with zero chunks and removes it from the work list FOREVER. One crash turned
# 855 perfectly good documents into permanent silent absences from search — 842 of them had good
# markdown sitting on disk the whole time.
#
# A document is at fault only if docling actually read it and could not convert it. Anything else
# is this process's problem and must leave the document untouched, so a rerun picks it up.
RETRYABLE_EXC = (BrokenProcessPool,)
RETRYABLE_TEXT = (
    "terminated abruptly", "process pool", "cannot schedule new futures",
    "cuda", "cublas", "cudnn", "out of memory", "device-side assert", "no kernel image",
    # docling's own backend refusing pages that pypdfium2 reads without complaint. Measured
    # 2026-08-01 on 5886ac2eeed3c0016f855f65 — a valid 24-page 1.4 MB PDF, full byte count, which
    # pypdfium2 parses every time and docling_parse_backend fails every time.
    #
    # NOT memory pressure, though it first appeared seconds before the cgroup OOM killer fired and
    # was recorded here as such. It reproduced at ~1-2 GiB immediately after a restart, which
    # refutes that. The cause is a backend incompatibility, and it is REPRODUCIBLE, not transient.
    #
    # RESOLVED 2026-08-02 by switching the default backend to pypdfium2 — see pdf_backend(). Both
    # documents that had deferred on every run extracted on the first attempt afterwards. The same
    # native component was also aborting the process outright, which is what forced the change.
    #
    # This entry stays because DOCLING_PDF_BACKEND=doclingparse can put the old backend back, and
    # because a deferred document is still the right handling if the error ever reappears.
    #
    # Risk accepted: a GENUINELY broken page tree defers instead of being recorded, so it is
    # retried once per run rather than never. That is the cheaper mistake — a retry costs one
    # conversion, a false permanent failure costs the document.
    "failed to load page",
)


def is_runner_fault(exc):
    if isinstance(exc, RETRYABLE_EXC):
        return True
    text = str(exc).lower()
    return any(t in text for t in RETRYABLE_TEXT)


class SourceMissing(Exception):
    """There are no bytes to fetch — a third case beside "the document is bad" and "this process
    is bad". Raised only for a 404, from the API or from the object store; every other download
    problem (oversize, 5xx, short read) keeps its existing handling. See missing()."""


def log(msg):
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


_plock = threading.Lock()
def record(**row):
    row["t"] = time.time()
    with _plock:
        with PROGRESS.open("a") as f:
            f.write(json.dumps(row) + "\n")


_local = threading.local()
def http():
    """One Session per thread — Sessions are not thread-safe."""
    if not hasattr(_local, "s"):
        _local.s = requests.Session()
    return _local.s


def api_get(path, **kw):
    """GET against DEMI, retrying transport errors and 5xx.

    The API is a Function App that restarts on deploy and cold-starts after idle. Treating that as
    a document failure would burn GPU work for an outage measured in seconds.
    """
    last = None
    for attempt in range(6):
        if stop.is_set():
            raise RuntimeError("stopping")
        try:
            r = http().get(f"{API}{path}", headers=HEADERS, timeout=120, **kw)
            # 429 is DEMI's own limiter (300/min per IP) and is always worth waiting out.
            if r.status_code != 429 and r.status_code < 500:
                return r
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            last = str(e)
        delay = min(2 ** attempt, 60) + random.uniform(0, 2)
        log(f"  api retry {path} in {delay:.0f}s ({last})")
        stop.wait(delay)
    raise RuntimeError(f"api unreachable after retries: {last}")


# ---------------------------------------------------------------- work list

def build_worklist():
    """Snapshot every unextracted document once, then work purely from disk.

    Paged with the continuation token rather than re-reading page 1: nothing flips
    contentExtracted during phase 1 any more, so the result set is stable while we walk it.
    """
    if WORKLIST.exists():
        docs = json.loads(WORKLIST.read_text())
        # A work list built before routing existed carries no extension, and every non-PDF in it
        # would be cached as .pdf and fail. Rebuild rather than run a knowingly broken pass.
        if docs and "ext" in docs[0]:
            log(f"work list: {len(docs)} documents (cached — delete {WORKLIST.name} to rebuild)")
            return docs
        log("work list predates routing (no fileExt) — rebuilding")

    log("building work list...")
    docs, token, page = [], None, 0
    while True:
        params = {"extracted": "false", "pageSize": PAGE_SIZE}
        if token:
            params["continuationToken"] = token
        r = api_get("/documents", params=params)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        docs.extend({
            "id": d["id"],
            "projectId": d.get("projectId"),
            "ext": (d.get("fileExt") or "pdf").lower().lstrip("."),
        } for d in batch)
        page += 1
        if page % 20 == 0:
            log(f"  ...{len(docs)} so far")
        token = r.headers.get("x-continuation-token")
        if not token or len(batch) < PAGE_SIZE:
            break

    WORKLIST.write_text(json.dumps(docs))
    log(f"work list: {len(docs)} documents -> {WORKLIST}")
    return docs


def already_done(doc_id):
    """Has this document already been converted, anywhere in the pipeline?

    ingest.py MOVES a file out of out/ into sent/ once Azure has it, so checking only out/ made
    every ingested document look unconverted: 4,635 conversions for 1,732 documents, 1,064 of them
    posted twice, and a run that could never finish because the work kept coming back. Conversion
    is the expensive half, so this check has to see the whole pipeline, not just the inbox.
    """
    return any((d / f"{doc_id}{ext}").exists()
               for d in (OUT, SENT, DEAD)
               for ext in (".md", ".err"))


# ---------------------------------------------------------------- routing

def decide(counts, size):
    """Pure decision half of route(), so it can be checked without a PDF. See selfcheck()."""
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


# PDFium keeps global state and is NOT thread-safe. Concurrent use does not crash — it silently
# corrupts, and perfectly valid PDFs come back as "Data format error" or the nonsensical
# "PDFium: Success", which reads like a corrupt source document rather than a bug here.
#
# A lock around OUR calls is not enough, and that cost a run: docling uses pypdfium2 too, so its
# converter threads hit the same global state without ever taking our lock. It passed every
# single-path test and only broke when both paths ran together — 468 failures in two minutes.
# So every pdfium call happens in a SEPARATE PROCESS (see pdfium_job), and the parent process,
# where docling lives, never touches pdfium at all.


def probe_pdf(path):
    """Characters already present on a sample of pages. Cheap: counts, never extracts.

    Runs in a pool worker process — never call this from the parent.
    """
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(path)
    try:
        n = len(doc)
        if n == 0:
            return []
        idx = (range(n) if n <= PROBE_PAGES
               else [round(i * (n - 1) / (PROBE_PAGES - 1)) for i in range(PROBE_PAGES)])
        counts = []
        for i in idx:
            page = doc[i]
            tp = page.get_textpage()
            counts.append(tp.count_chars())
            tp.close()
            page.close()
        return counts
    finally:
        doc.close()


def split_pdf(path_str, batch_pages):
    """Split a PDF into <=batch_pages sub-files and return their paths.

    RUNS IN A POOL WORKER PROCESS, like everything else that touches pdfium.

    This is what bounds OCR memory. docling holds page images for the whole document it is given,
    so peak RAM tracks PAGE COUNT, and the byte-size semaphore was the wrong proxy — a 5 MB PDF can
    carry a thousand pages. Measured before this existed: the parent process climbed ~1 GB/minute
    and was OOM-killed. `src/extract.js` reached the same conclusion independently and batches at
    10 pages; this is the same trick with a larger batch, because a docling call has fixed startup
    cost and 10 is smaller than it needs to be.

    Returns [original] when the document is already small enough, so the caller has one code path.
    """
    import pypdfium2 as pdfium

    path = Path(path_str)
    src = pdfium.PdfDocument(path)
    try:
        n = len(src)
        if n <= batch_pages:
            return [str(path)], n
        parts = []
        for start in range(0, n, batch_pages):
            pages = list(range(start, min(start + batch_pages, n)))
            out = path.with_name(f"{path.stem}-b{start // batch_pages}{path.suffix}")
            dst = pdfium.PdfDocument.new()
            try:
                dst.import_pages(src, pages)
                dst.save(str(out))
            finally:
                dst.close()
            parts.append(str(out))
        return parts, n
    finally:
        src.close()


def pdfium_job(path_str, ext):
    """Probe, and extract too if the probe says the text layer is good enough.

    THIS RUNS IN A POOL WORKER PROCESS. It is the only code that touches pdfium, which is what
    keeps pdfium's global state away from docling's copy of it in the parent. Probe and extract
    are one call so a text-path document costs a single IPC round trip.

    Returns (route, markdown_or_None, info). `info` carries the probe numbers so the thresholds
    can be tuned from recorded data instead of guessed at — the OCR share is the single biggest
    lever on how long the corpus takes, and it is invisible without this.

    It never raises: an unreadable file is a reason to escalate to OCR, which opens far more than
    pdfium will, never to fail the document.
    """
    path = Path(path_str)
    if ext == "txt":
        return "text", path.read_text(errors="replace"), {}
    try:
        counts = probe_pdf(path)
    except Exception as e:                                        # noqa: BLE001
        return "ocr", None, {"note": f"probe failed: {e}"}
    info = {
        "pages": len(counts),
        "med": int(statistics.median(counts)) if counts else 0,
        "frac": round(sum(1 for c in counts if c > 50) / len(counts), 2) if counts else 0.0,
    }
    if decide(counts, path.stat().st_size) == "ocr":
        return "ocr", None, info
    try:
        return "text", extract_text(path, ext), info
    except Exception as e:                                        # noqa: BLE001
        info["note"] = f"text extract failed: {e}"
        return "ocr", None, info


# ---------------------------------------------------------------- extractors

def extract_text(path, ext):
    """Text layer straight out of the file. No GPU, no layout model, milliseconds."""
    if ext == "txt":
        return path.read_text(errors="replace")

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
        # Blank line between pages: src/chunker.js splits on /\n{2,}/, so this is what gives it
        # block boundaries to accumulate against.
        return "\n\n".join(p.strip() for p in pages if p.strip())
    finally:
        doc.close()


def build_converter(force_ocr=False):
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import (
        PdfPipelineOptions, AcceleratorOptions, AcceleratorDevice,
    )

    opts = PdfPipelineOptions()
    opts.do_ocr = True
    opts.do_table_structure = False     # we index text for search; table geometry is not worth the time
    if force_ocr:
        opts.ocr_options.force_full_page_ocr = True
    opts.accelerator_options = AcceleratorOptions(num_threads=8, device=AcceleratorDevice.CUDA)
    return DocumentConverter(format_options={
        InputFormat.PDF: PdfFormatOption(pipeline_options=opts, backend=pdf_backend()),
    })


def pdf_backend():
    """Which library reads the page tree.

    docling's default is DoclingParseDocumentBackend, whose native decoder ABORTS THE PROCESS on
    some documents in this corpus. Measured 2026-08-02: 83 restarts in five hours, all
    `status=5/TRAP`, and once faulthandler was registered for SIGTRAP, 4 of 4 captured traps had
    the identical top frame — docling_parse/pdf_parser.py:757 `_ensure_page_decoder`, at the
    `self._parser.get_page_decoder(...)` call into the C++ binding.

    A native abort cannot be caught. fail(), defer() and missing() all need the process to survive
    long enough to write something, so nothing was recorded, the feeder queued the same work again
    on restart, and the run stalled completely — zero documents in 90 seconds by the end.

    Same component is behind the `Failed to load page` errors, where it fails loudly instead of
    aborting. pypdfium2 reads those same files every time, and it is already trusted here: the
    whole text route and the page probe run on it.

    Env knob because this is the one variable worth bisecting if extraction quality regresses;
    DOCLING_PDF_BACKEND=doclingparse restores the old behaviour, crashes included."""
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    if os.environ.get("DOCLING_PDF_BACKEND", "pypdfium").lower() == "doclingparse":
        from docling.backend.docling_parse_backend import DoclingParseDocumentBackend
        return DoclingParseDocumentBackend
    return PyPdfiumDocumentBackend


# One shared full-page-OCR converter behind a lock. It handles a few percent of documents, so it
# does not need to run in parallel, and a per-thread copy would cost VRAM for almost no throughput.
_force_conv = None
_force_lock = threading.Lock()

# Serialises the memory-hungry documents without serialising the whole pipeline.
_big_doc = threading.Semaphore(1)


def convert_forced(path):
    global _force_conv
    with _force_lock:
        if _force_conv is None:
            log("building full-page-OCR converter (first low-yield document)")
            _force_conv = build_converter(force_ocr=True)
        return _force_conv.convert(str(path)).document.export_to_markdown()


PLACEHOLDER_RE = re.compile(r"<!--\s*image\s*-->")


def real_chars(md):
    """Characters that are neither whitespace nor docling's image placeholder.

    `<!-- image -->` is docling's own marker and `image_export_mode` cannot switch it off — it
    admits only placeholder/embedded/referenced. Its presence is normal; markdown that is NOTHING
    else is the defect. Note it is exactly 14 characters, which is what a placeholder-only file
    measures, so a raw len() reads as "converted fine"."""
    return len(re.sub(r"\s+", "", PLACEHOLDER_RE.sub("", md)))


def tile_job(path_str, ext, outdir, grid, overlap, scale_cap, max_pixels, max_pages):
    """Render each page and cut it into a grid x grid mesh of overlapping PNG tiles.

    THIS RUNS IN A POOL WORKER PROCESS, for the reason spelled out above pdfium_job. Rendering in
    the parent instead is not a style preference: it failed 552 of 623 documents in ten minutes on
    2026-08-02, every one of them "PDFium: Data format error" on a file that is not damaged, which
    is the same signature as the 468-in-two-minutes incident that put pdfium in a subprocess in the
    first place. docling's converter threads live in the parent and touch pdfium's global state
    without taking any lock of ours, so the parent must never open a PDF.

    Returns (tile_paths, truncated). Tiles are written to a caller-owned directory rather than
    returned as images: one 60-megapixel render is ~180 MB and would have to be pickled across the
    IPC boundary.

    Rendering here rather than letting docling do it is the whole point — docling only ever hands
    its OCR model a page-sized image, and this needs the page in pieces.
    """
    from PIL import Image
    tiles = []

    def cut(img, pageno):
        W, H = img.size
        tw, th = W / grid, H / grid
        ox, oy = tw * overlap, th * overlap
        for gy in range(grid):
            for gx in range(grid):
                box = (max(int(gx * tw - ox), 0), max(int(gy * th - oy), 0),
                       min(int((gx + 1) * tw + ox), W), min(int((gy + 1) * th + oy), H))
                p = Path(outdir) / f"p{pageno}_{gy}{gx}.png"
                img.crop(box).save(p)
                tiles.append(str(p))

    if ext in IMAGE_EXTS:
        with Image.open(path_str) as src:
            rgb = src.convert("RGB")
            try:
                cut(rgb, 0)
            finally:
                rgb.close()
        return tiles, False

    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(path_str)
    truncated = False
    try:
        for pageno in range(len(pdf)):
            if pageno >= max_pages:
                truncated = True
                break
            page = pdf[pageno]
            try:
                w, h = page.get_size()
                # Bounded by area, not by a fixed scale: an E-size sheet at scale 6 is ~300 MP, and
                # this render is held whole in RAM before it is cut.
                scale = min(scale_cap, (max_pixels / max(w * h, 1)) ** 0.5)
                img = page.render(scale=max(scale, 1.0)).to_pil().convert("RGB")
                try:
                    cut(img, pageno)
                finally:
                    img.close()
            finally:
                page.close()
    finally:
        pdf.close()
    return tiles, truncated


def convert_tiled(path, ext, doc_id=""):
    """Re-OCR a document by cutting each page into a TILE_GRID x TILE_GRID grid.

    Returns markdown, or "" when the document is too long to be worth the passes. Costs
    TILE_GRID^2 OCR calls per page, so callers must only reach it after a normal conversion has
    already come back textless.

    Tiles are joined with duplicate lines removed. The overlap that stops a label being cut in
    half also makes neighbouring tiles repeat whatever sits in the seam, and posting that twice
    would put the same sentence in the index twice.

    The rendering half runs in the pool, never here — see tile_job. This function only feeds the
    resulting PNGs to docling, which is what the parent process is allowed to do."""
    import tempfile
    seen, lines = set(), []
    with tempfile.TemporaryDirectory(prefix="tile-") as td:
        tiles, truncated = _pool.submit(tile_job, str(path), ext, td, TILE_GRID, TILE_OVERLAP,
                                        TILE_RENDER_SCALE, TILE_MAX_PIXELS,
                                        TILE_MAX_PAGES).result()
        if truncated:
            log(f"  {doc_id}: over {TILE_MAX_PAGES} pages — tiling stopped at that bound")
        for tile in tiles:
            for line in convert_forced(Path(tile)).splitlines():
                s = line.strip()
                # The placeholder is dropped rather than deduped: every one of the 9 tiles emits
                # it, and keeping one would leave the output looking identical to the empty
                # conversion this is trying to replace.
                if not s or PLACEHOLDER_RE.fullmatch(s) or s in seen:
                    continue
                seen.add(s)
                lines.append(s)
    return "\n\n".join(lines)


# ---------------------------------------------------------------- threads

to_download = queue.Queue(maxsize=INFLIGHT)
to_probe = queue.Queue(maxsize=INFLIGHT)
to_ocr = queue.Queue(maxsize=INFLIGHT)
_pool = None                              # ProcessPoolExecutor, built in main()
counts = {"ok": 0, "failed": 0, "deferred": 0, "missing": 0, "skipped": 0, "forced": 0, "chars": 0,
          "text": 0, "ocr": 0, "unsupported": 0, "rerouted": 0, "tiled": 0}
_clock = threading.Lock()
_pool_lock = threading.Lock()
_streak = {"defers": 0}       # consecutive runner faults, reset by any success


def bump(key, n=1):
    with _clock:
        counts[key] += n


def new_pool():
    return ProcessPoolExecutor(max_workers=TEXT_WORKERS,
                               max_tasks_per_child=POOL_RECYCLE,
                               mp_context=multiprocessing.get_context("spawn"))


def ensure_pool():
    """Rebuild the process pool if it has broken.

    A ProcessPoolExecutor never recovers on its own — once a child dies badly, `_broken` is set and
    every future submit raises for the remaining life of the run. Without this the first crash
    silently disables the text path for 57,000 documents, which is exactly what happened.
    """
    global _pool
    with _pool_lock:
        if not getattr(_pool, "_broken", None):
            return False
        log("process pool is broken — rebuilding")
        try:
            _pool.shutdown(wait=False)
        except Exception:                                         # noqa: BLE001 - already broken
            pass
        _pool = new_pool()
        return True


def provenance(route_name, forced, tiled=False):
    """What the API stores as `extraction`. Nothing has ever sent this, which is the only reason
    corpus quality cannot be split by OCR path vs text-layer path."""
    if route_name == "ocr":
        engine = "docling+rapidocr (cuda)"
        if forced:
            engine += ", force_full_page_ocr"
        if tiled:
            engine += f", {TILE_GRID}x{TILE_GRID} tiles"
        return {"path": "ocr",
                "engine": engine,
                "doclingVersion": DOCLING_VERSION,
                # Recorded from 2026-08-02: the corpus now has documents read by two different PDF
                # backends, and without this there is no way to tell which produced a given file.
                # `tiled` is the same argument — text recovered by tiling is worth being able to
                # find later, not least to check it against the empty version it replaced.
                "options": {"force_ocr": forced, "batch_pages": OCR_BATCH_PAGES,
                            "pdf_backend": pdf_backend().__name__, "tiled": tiled},
                "at": datetime.now(timezone.utc).isoformat()}
    return {"path": "text",
            "engine": "pypdfium2",
            "doclingVersion": DOCLING_VERSION,
            "options": {"probe_pages": PROBE_PAGES,
                        "min_chars_per_page": MIN_CHARS_PER_PAGE,
                        "min_text_fraction": MIN_TEXT_FRACTION},
            "at": datetime.now(timezone.utc).isoformat()}


def finish(doc_id, md, path, route_name, t0, forced=False, info=None, tiled=False):
    (OUT / f"{doc_id}.md").write_text(md)
    # Sidecar rather than a header inside the markdown: the markdown is posted verbatim and the
    # server chunks it, so anything embedded would become indexed text. ingest.py picks this up.
    (OUT / f"{doc_id}.json").write_text(json.dumps(provenance(route_name, forced, tiled)))
    with _clock:
        _streak["defers"] = 0
    bump("ok")
    bump("chars", len(md))
    secs = time.time() - t0
    size = path.stat().st_size if path.exists() else 0
    log(f"  {route_name} {doc_id} in {secs:.1f}s ({len(md)} chars, {size // 1024} KB"
        f"{', forced OCR' if forced else ''}{f', {TILE_GRID}x{TILE_GRID} tiled' if tiled else ''})")
    record(id=doc_id, stage="convert", route=route_name, seconds=round(secs, 2),
           chars=len(md), bytes=size, forced=forced, tiled=tiled, **(info or {}))


def fail(doc_id, reason, route_name=None):
    """The DOCUMENT is at fault — docling read it and could not convert it. Writing a .err is what
    makes that permanent: ingest.py posts it, the API marks the document extracted-with-error, and
    it leaves the work list for good. Only call this when retrying could not possibly help."""
    (OUT / f"{doc_id}.err").write_text(reason[:2000])
    bump("failed")
    record(id=doc_id, stage="convert", route=route_name, error=reason[:300])


def missing(doc_id, reason):
    """The SOURCE is at fault — there are no bytes to read. Writes no .err, like defer(), so the
    document stays in the work list and a later run picks it up once the file exists.

    Recording this as an extraction error claims docling read the document and could not convert
    it, which is false, and removes it from the work list for good. That is what happened to 5,445
    documents on 2026-08-02: the dev object store is a partial copy of prod, every miss was written
    as a .err, and the API marked all of them extracted-with-error holding zero chunks.

    No streak and no circuit breaker, unlike defer(): thousands of these means the object store is
    populated differently from Mongo, which is a thing to go fix, not a reason to abandon the
    50,000 documents whose files are present."""
    bump("missing")
    record(id=doc_id, stage="download", missing=reason[:300])


def defer(doc_id, reason, route_name=None):
    """THIS PROCESS is at fault. Writes no .err, so the document keeps no record at all and the
    next run picks it up again — already_done() only counts a .md or .err on disk.

    Deliberately not a retry-in-place: whatever broke the pool or the CUDA context usually breaks
    the next document too, so the useful behaviour is to leave the work undone and let a rerun,
    after the operator has looked at it, do it properly."""
    bump("deferred")
    record(id=doc_id, stage="convert", route=route_name, deferred=reason[:300])
    with _clock:
        _streak["defers"] += 1
        streak = _streak["defers"]
    if streak >= MAX_CONSECUTIVE_DEFERS:
        log(f"  {streak} consecutive runner faults — stopping the run rather than deferring the "
            f"rest of the corpus. Fix the cause and rerun; nothing has been lost.")
        stop.set()


def downloader():
    while True:
        doc = to_download.get()
        if doc is None or stop.is_set():
            return
        try:
            path = download(doc)
        except SourceMissing as e:
            log(f"  source missing {doc['id']}: {e}")
            missing(doc["id"], str(e))
            continue
        except Exception as e:                                    # noqa: BLE001 - report, never die
            log(f"  download failed {doc['id']}: {e}")
            fail(doc["id"], f"download failed: {e}")
            continue
        # Extension alone settles the non-PDFs: an image has no text layer by definition, and the
        # office formats need docling's readers rather than a probe. Only PDFs are worth probing.
        if doc["ext"] in IMAGE_EXTS or doc["ext"] in DOCLING_EXTS:
            bump("ocr")
            to_ocr.put((doc, path))
        else:
            to_probe.put((doc, path))


def download(doc):
    doc_id = doc["id"]
    r = api_get(f"/documents/{doc_id}/download")
    if r.status_code == 404:
        raise SourceMissing(f"the API has no stored file for this document ({r.text[:120]})")
    r.raise_for_status()
    url = r.json()["url"]

    dest = CACHE / f"{doc_id}.{doc['ext']}"
    limit = MAX_FILE_MB * 1024 * 1024
    with http().get(url, stream=True, timeout=600) as resp:
        # Checked before raise_for_status() so a 404 becomes SourceMissing rather than a generic
        # HTTPError. Deliberately not logged with the URL attached: it is presigned, so the message
        # would be a 700-character signature that buries every other line in the journal.
        if resp.status_code == 404:
            raise SourceMissing("the object store has no object at the presigned key")
        resp.raise_for_status()
        declared = int(resp.headers.get("content-length") or 0)
        if declared > limit:
            raise RuntimeError(f"file is {declared // 1048576} MB, over MAX_FILE_MB={MAX_FILE_MB}")
        written = 0
        with dest.open("wb") as f:
            for chunk in resp.iter_content(1 << 20):
                f.write(chunk)
                written += len(chunk)
                if written > limit:
                    break
        if written > limit:
            dest.unlink(missing_ok=True)
            raise RuntimeError(f"file exceeded MAX_FILE_MB={MAX_FILE_MB} mid-stream")
    # A dropped connection ends iter_content early without raising, and a short PDF is not a
    # readable PDF — it fails downstream as "Data format error", which looks like a corrupt
    # source document rather than a bad download. Verify the length we were promised.
    if declared and written != declared:
        dest.unlink(missing_ok=True)
        raise RuntimeError(f"truncated download: {written} of {declared} bytes")
    return dest


def pdf_worker():
    """Route and text-extract, both inside a pool process. Blocks on the result, so there is one
    of these threads per pool process."""
    while True:
        item = to_probe.get()
        if item is None:
            return
        doc, path = item
        doc_id = doc["id"]
        t0 = time.time()
        try:
            which, md, info = _pool.submit(pdfium_job, str(path), doc["ext"]).result()
        except Exception as e:                                    # noqa: BLE001
            # A pool process that dies takes its task with it; the document is not at fault.
            log(f"  pdfium worker died on {doc_id}: {e} — routing to OCR")
            which, md, info = "ocr", None, {}
            # Rebuild before the next document. Without this the pool stays broken and EVERY
            # remaining document falls through to the GPU — the run still completes, at OCR speed
            # for a corpus that is 98% digital PDFs.
            ensure_pool()
        if info.get("note"):
            log(f"  {doc_id}: {info['note']} — routing to OCR")

        if which == "text":
            size = path.stat().st_size
            # The probe said this file had text and it came back near-empty, so the probe was
            # wrong. Hand it to OCR rather than write a blank document — the whole point of being
            # biased toward OCR is that this case never silently succeeds.
            # real_chars, not len: whitespace and image placeholders are not text, and a document
            # that extracts to 600 blank characters passes a raw length test while being exactly
            # the blank document this branch exists to catch.
            if real_chars(md) < LOW_YIELD_CHARS and size > LOW_YIELD_MIN_BYTES:
                log(f"  low yield {doc_id} ({real_chars(md)} real chars from {size // 1024} KB)"
                    " — re-routing to OCR")
                bump("rerouted")
                which = "ocr"

        if which == "ocr":
            bump("ocr")
            # Recorded even though no markdown was produced: this row is how the OCR share gets
            # attributed to a threshold rather than assumed.
            record(id=doc_id, stage="probe", route="ocr", bytes=path.stat().st_size, **info)
            to_ocr.put((doc, path))
            continue

        bump("text")
        finish(doc_id, md, path, "text", t0, info=info)
        path.unlink(missing_ok=True)


def recycle_converter(conv):
    """Drop a docling converter and rebuild it.

    The pdfium pool fixed the CHILDREN; the parent kept growing anyway, because docling is here.
    Measured: the parent process reached 10 GB RSS while every pool child sat at 11-46 MB, and an
    earlier run was OOM-killed outright. A converter is reused for every document it handles, so
    whatever it retains per conversion accumulates for the life of the run.

    Rebuilding costs a model reload (~10 s) against an OCR path already averaging tens of seconds
    per document, so amortised over OCR_RECYCLE documents it is noise.
    """
    del conv
    gc.collect()
    try:
        import torch
        torch.cuda.empty_cache()
    except Exception:                                             # noqa: BLE001
        pass
    return build_converter()


def ocr_worker():
    conv = build_converter()
    log("docling converter ready (CUDA)")
    handled = 0
    while True:
        item = to_ocr.get()
        if item is None:
            return
        if handled and handled % OCR_RECYCLE == 0:
            conv = recycle_converter(conv)
        doc, path = item
        doc_id = doc["id"]
        t0 = time.time()
        size = path.stat().st_size
        big = size >= BIG_DOC_BYTES
        if big:
            _big_doc.acquire()
        parts = []
        try:
            # Split before converting: peak RAM follows page count, and a single long document is
            # what OOM-killed this box. Non-PDFs pass straight through — docling's office and image
            # readers do not carry the page-image cost that makes this necessary.
            if doc["ext"] in IMAGE_EXTS or doc["ext"] in DOCLING_EXTS:
                parts, pages = [str(path)], 1
            else:
                try:
                    parts, pages = _pool.submit(split_pdf, str(path), OCR_BATCH_PAGES).result()
                except Exception as e:                            # noqa: BLE001
                    # A runner fault belongs to the outer handler, which defers the document.
                    if is_runner_fault(e):
                        raise
                    # Otherwise the SPLIT failed, which is not the same as the document being
                    # unreadable. Measured 2026-08-01: a 133-page report that pdfium refused to
                    # split ("Failed to import pages") parsed perfectly on its own moments later,
                    # and had been recorded as a permanent failure — a good document dropped out
                    # of the corpus. Fall back to converting the whole file, exactly as
                    # src/extract.js does on a load failure. Costs memory on a big document;
                    # cheaper than losing it.
                    log(f"  {doc_id}: split failed ({e}) — converting whole file instead")
                    parts, pages = [str(path)], 1
            if len(parts) > 1:
                log(f"  {doc_id}: {pages} pages -> {len(parts)} batches of {OCR_BATCH_PAGES}")

            md = "\n\n".join(
                conv.convert(p).document.export_to_markdown() for p in parts
            )

            # A big file that converts to almost nothing is a scan docling found no text regions
            # in — not an empty document. Retrying with full-page OCR is the difference between
            # the document being searchable and being silently absent from Deep Search. Forced OCR
            # is far heavier per page, so it batches too.
            forced = False
            if len(md) < LOW_YIELD_CHARS and size > LOW_YIELD_MIN_BYTES:
                log(f"  low yield {doc_id} ({len(md)} chars from {size // 1024} KB) — forcing OCR")
                retry = "\n\n".join(convert_forced(Path(p)) for p in parts)
                if len(retry) > len(md):
                    md, forced = retry, True
                    bump("forced")

            # Last resort, and the only one that works on a large-format sheet. Gated on REAL
            # characters, not len(md): a placeholder-only conversion is 14 characters long and
            # sails past every length test in this function. See TILE_GRID.
            tiled = False
            if real_chars(md) < TEXTLESS_CHARS:
                log(f"  textless {doc_id} ({real_chars(md)} real chars) — re-OCR in "
                    f"{TILE_GRID}x{TILE_GRID} tiles")
                try:
                    retry = convert_tiled(path, doc["ext"], doc_id)
                except Exception as e:                            # noqa: BLE001
                    # A runner fault still belongs to the outer handler, which defers the document
                    # and rebuilds the pool. Anything else is the ENHANCEMENT failing on a document
                    # that already converted, and dropping a good conversion because the extra pass
                    # broke would be worse than shipping it textless. Same shape as the split_pdf
                    # fallback above.
                    if is_runner_fault(e):
                        raise
                    log(f"  {doc_id}: tiling failed ({e}) — keeping the untiled conversion")
                    retry = ""
                if real_chars(retry) > real_chars(md):
                    md, tiled = retry, True
                    bump("tiled")
                    log(f"  tiling recovered {real_chars(md)} chars for {doc_id}")

            finish(doc_id, md, path, "ocr", t0, forced=forced, tiled=tiled)
        except Exception as e:                                    # noqa: BLE001
            # THE 2026-07-30 CASCADE LIVED HERE. `split_pdf` runs in the shared pool, so a broken
            # pool raised on every subsequent OCR document and this branch recorded each one as a
            # failed DOCUMENT. Classify first: a runner fault leaves the document alone.
            if is_runner_fault(e):
                log(f"  runner fault on {doc_id}: {e} — deferring, document stays in the work list")
                defer(doc_id, f"runner fault: {e}", "ocr")
                ensure_pool()
                # The converter is rebuilt too: a CUDA context that has faulted poisons every
                # later conversion in this thread, and the failure would look like bad documents.
                conv = recycle_converter(conv)
            else:
                log(f"  convert failed {doc_id}: {e}")
                fail(doc_id, f"docling failed: {e}", "ocr")
        finally:
            if big:
                _big_doc.release()
            handled += 1
            for p in parts:
                if p != str(path):
                    Path(p).unlink(missing_ok=True)
            path.unlink(missing_ok=True)


def feeder(docs):
    queued = 0
    for doc in docs:
        if stop.is_set() or (LIMIT and queued >= LIMIT):
            break
        doc_id = doc["id"]
        if already_done(doc_id):
            bump("skipped")
            continue
        # Recorded without a download: nothing on this box can read these, so spending bandwidth
        # on them only to fail is pure waste. ingest.py posts the .err so the API marks them
        # extracted-with-error and they leave the work list for good.
        if doc["ext"] in UNSUPPORTED_EXTS:
            fail(doc_id, f"unsupported format: {doc['ext']}", "unsupported")
            bump("unsupported")
            continue
        to_download.put(doc)
        queued += 1
    for _ in range(DOWNLOADERS):
        to_download.put(None)
    log(f"feeder done — {queued} queued, {counts['skipped']} already on disk, "
        f"{counts['unsupported']} unsupported")


def selfcheck():
    """The routing decision is the one piece of logic here that can be wrong without failing
    loudly, so it is the one piece with a check."""
    big, small = 10 * 1024 * 1024, 1000
    assert decide([2000] * 20, big) == "text", "a digital document must not go to the GPU"
    assert decide([0] * 20, big) == "ocr", "a scan must go to OCR"
    assert decide([], big) == "ocr", "an unreadable probe must escalate"
    # One digital cover page in front of a scan: the median alone would pass it.
    assert decide([3000] + [0] * 19, big) == "ocr", "the fraction rule must catch a scanned body"
    assert decide([2000] * 16 + [0] * 4, big) == "text", "80% text is still a digital document"
    assert decide([2000] * 15 + [0] * 5, big) == "ocr", "75% text is not enough"
    # A small file with little text is a short document, not a scan worth GPU time.
    assert decide([120] * 5, small) == "text", "a tiny file must not be sent to the GPU"
    assert decide([120] * 5, big) == "ocr", "a big file with thin text is a scan"
    print("selfcheck ok")


def main():
    if "--selfcheck" in sys.argv:
        selfcheck()
        return 0

    for d in (CACHE, OUT):
        d.mkdir(parents=True, exist_ok=True)
    for f in CACHE.iterdir():            # a killed run leaves partial downloads behind
        f.unlink(missing_ok=True)

    def bye(*_):
        log("signal received — draining")
        stop.set()
    signal.signal(signal.SIGTERM, bye)
    signal.signal(signal.SIGINT, bye)

    docs = build_worklist()
    log(f"API={API} LIMIT={LIMIT or 'all'} INFLIGHT={INFLIGHT} DOWNLOADERS={DOWNLOADERS} "
        f"TEXT_WORKERS={TEXT_WORKERS} CONVERTERS={CONVERTERS}")
    started = time.time()

    # "spawn", not the default fork: the parent loads torch and CUDA for docling, and forking a
    # process with a live CUDA context is undefined behaviour. Spawned children re-import this
    # module and nothing else.
    #
    # max_tasks_per_child is load-bearing, not tidiness. Without it the box was OOM-killed after
    # ~520 documents: throughput decayed 7,660 -> 818 docs/hr over 35 minutes as the children grew,
    # then the kernel took the whole unit (status=9/KILL, result 'oom-kill'). pdfium holds on to
    # memory across documents, and a pool worker lives for the entire run, so the leak is unbounded
    # by default. Recycling caps it at one document's worth per child.
    global _pool
    _pool = new_pool()

    feed = threading.Thread(target=feeder, args=(docs,), name="feeder", daemon=True)
    downloaders = [threading.Thread(target=downloader, name=f"dl{i}", daemon=True)
                   for i in range(DOWNLOADERS)]
    pdfers = [threading.Thread(target=pdf_worker, name=f"pdf{i}", daemon=True)
              for i in range(TEXT_WORKERS)]
    ocrers = [threading.Thread(target=ocr_worker, name=f"gpu{i}", daemon=True)
              for i in range(CONVERTERS)]
    for t in [feed, *downloaders, *pdfers, *ocrers]:
        t.start()

    finished = threading.Event()

    def monitor():
        last = 0
        while not finished.is_set():
            finished.wait(60)
            # counts["missing"] belongs in done: it is a settled outcome for this run, and leaving
            # it out froze `remaining` and made the ETA meaningless once 5,445 documents had no
            # fetchable file.
            done = counts["ok"] + counts["failed"] + counts["missing"]
            if done != last:
                rate = done / max(time.time() - started, 1)
                remaining = max(len(docs) - counts["skipped"] - done, 0)
                eta_h = remaining / max(rate * 3600, 1e-9) if rate else 0
                log(f"progress: {counts['ok']} ok, {counts['failed']} failed, "
                    f"{counts['missing']} source missing, {counts['deferred']} deferred, "
                    f"{counts['text']} text / {counts['ocr']} ocr "
                    f"({counts['rerouted']} re-routed, {counts['forced']} forced), "
                    f"{rate * 3600:.0f} docs/hr, {remaining} left (~{eta_h:.1f} h)")
                last = done

    threading.Thread(target=monitor, name="monitor", daemon=True).start()

    # Shutdown order matters and is the reason no sentinel is broadcast up front: a pdf worker can
    # hand a document to the OCR queue, so the OCR pool must not be told to stop until every pdf
    # worker has exited. Each stage is closed only once the stage that feeds it is done.
    for t in downloaders:
        t.join()
    for _ in pdfers:
        to_probe.put(None)
    for t in pdfers:
        t.join()
    for _ in ocrers:
        to_ocr.put(None)
    for t in ocrers:
        t.join()
    # After the OCR workers, not before: they submit split_pdf into the same pool, so shutting it
    # down at the end of the pdf stage killed the last document with "cannot schedule new futures
    # after shutdown".
    _pool.shutdown(wait=True)
    finished.set()

    elapsed = time.time() - started
    done = counts["ok"] + counts["failed"] + counts["missing"]
    log(f"DONE in {elapsed / 3600:.2f} h — {counts['ok']} ok, {counts['failed']} failed, "
        f"{counts['missing']} source missing, {counts['deferred']} deferred, "
        f"{counts['skipped']} skipped, {counts['text']} text / {counts['ocr']} ocr, "
        f"{counts['rerouted']} re-routed, {counts['forced']} forced-OCR, "
        f"{counts['unsupported']} unsupported")
    if counts["missing"]:
        log(f"  {counts['missing']} document(s) had no fetchable source file — NOT recorded as "
            f"failures, no .err written, still in the work list. If that is a large fraction, the "
            f"object store is missing files that Mongo references; fix that and rerun.")
    if counts["deferred"]:
        log(f"  {counts['deferred']} document(s) deferred by runner faults — NOT recorded as "
            f"failures, no .err written. Rerun picks them up. Check the log for the cause.")
    if counts["ok"]:
        log(f"  {elapsed / max(done, 1):.1f} s/document, "
            f"{counts['chars'] / counts['ok'] / 1000:.1f}K chars/document")
    log(f"  markdown is in {OUT} — run ingest.py to push it to Azure")
    return 0


if __name__ == "__main__":
    sys.exit(main())
