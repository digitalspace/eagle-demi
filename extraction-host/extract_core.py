"""Routing, conversion, download and chunk posting shared by worker.py, ingest.py and job.py.

Importing this reads no credential; callers pass the key to set_key().
"""

import faulthandler
import gc
import json
import multiprocessing
import os
import random
import re
import signal
import statistics
import threading
import time
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from datetime import datetime, timezone
from pathlib import Path

import requests

# A native abort (SIGTRAP from docling-parse) leaves no traceback; this prints every thread's stack.
# SIGTRAP needs its own registration: enable() covers SEGV/BUS/FPE/ILL/ABRT only.
faulthandler.enable(all_threads=True)
faulthandler.register(signal.SIGTRAP, all_threads=True, chain=True)

API = os.environ.get("DEMI_API", "https://demi-api-dev.azurewebsites.net/api").rstrip("/")
# Mutated in place by set_key() so every importer sees the key.
HEADERS = {}
DEVICE = os.environ.get("OCR_DEVICE", "cuda").lower()

MAX_FILE_MB = int(os.environ.get("MAX_FILE_MB", "300"))
# Pages per docling call. This, not file size, is what bounds OCR memory.
OCR_BATCH_PAGES = int(os.environ.get("OCR_BATCH_PAGES", "25"))
# A substantial file that converts to almost nothing is a scan: forced OCR retry, or re-route to OCR.
LOW_YIELD_CHARS = int(os.environ.get("LOW_YIELD_CHARS", "500"))
LOW_YIELD_MIN_BYTES = int(os.environ.get("LOW_YIELD_MIN_BYTES", "200000"))

# Large-format sheets OCR to nothing whole because docling normalises the page image and small labels
# fall under RapidOCR's floor. Cutting the page into tiles is the only lever that recovers the text.
TILE_GRID = int(os.environ.get("TILE_GRID", "3"))
# Overlap keeps a label on a cut readable; the join drops the duplicate lines it causes.
TILE_OVERLAP = float(os.environ.get("TILE_OVERLAP", "0.06"))
TILE_RENDER_SCALE = float(os.environ.get("TILE_RENDER_SCALE", "6"))
# The render is held whole in RAM before it is cut, and scale times an E-size sheet is unbounded.
TILE_MAX_PIXELS = int(os.environ.get("TILE_MAX_PIXELS", "60000000"))
# Tiling costs TILE_GRID^2 OCR passes per page, so long documents are not worth it.
TILE_MAX_PAGES = int(os.environ.get("TILE_MAX_PAGES", "20"))
# Not zero: a drawing often yields a stray sheet number, which is empty for search.
TEXTLESS_CHARS = int(os.environ.get("TEXTLESS_CHARS", "32"))

# Digital PDFs score a median of 394-5632 chars per page and scans ~0. The fraction rule stops a
# scan with one digital cover page passing on the median alone.
MIN_CHARS_PER_PAGE = int(os.environ.get("MIN_CHARS_PER_PAGE", "200"))
MIN_TEXT_FRACTION = float(os.environ.get("MIN_TEXT_FRACTION", "0.8"))
PROBE_PAGES = int(os.environ.get("PROBE_PAGES", "20"))

try:
    from importlib.metadata import version as _pkg_version
    DOCLING_VERSION = _pkg_version("docling")
except Exception:                                                 # noqa: BLE001
    DOCLING_VERSION = "unknown"

IMAGE_EXTS = {"jpg", "jpeg", "png", "tif", "tiff", "bmp", "gif"}
DOCLING_EXTS = {"docx", "pptx", "xlsx", "htm", "html", "md"}
# docling has no reader for these; recorded as extraction errors without a download.
UNSUPPORTED_EXTS = {"msg", "zip", "rtf", "doc", "ppt", "xls", "eml", "exe", "dwg"}


def ocr_only(ext):
    """Extension alone settles these: an image has no text layer, office files need docling's readers."""
    return ext in IMAGE_EXTS or ext in DOCLING_EXTS

# Above this, markdown goes as NDJSON: the API's JSON body cap is 10 MB, so switch well before it.
STREAM_MIN_BYTES = int(os.environ.get("STREAM_MIN_BYTES", str(4 * 1024 * 1024)))

stop = threading.Event()

# Failures that are the RUNNER's fault, not the document's. Recording one as a document failure
# marks a good document extracted with zero chunks for good, so these must leave it untouched.
RETRYABLE_EXC = (BrokenProcessPool,)
RETRYABLE_TEXT = (
    "terminated abruptly", "process pool", "cannot schedule new futures",
    "cuda", "cublas", "cudnn", "out of memory", "device-side assert", "no kernel image",
    # docling-parse refusing pages pypdfium2 reads fine; kept for DOCLING_PDF_BACKEND=doclingparse.
    "failed to load page",
)


def is_runner_fault(exc):
    if isinstance(exc, RETRYABLE_EXC):
        return True
    text = str(exc).lower()
    return any(t in text for t in RETRYABLE_TEXT)


class SourceMissing(Exception):
    """No bytes to fetch: a 404 from the API or the object store. Neither a bad document nor a bad runner."""


def log(msg):
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def set_key(key):
    HEADERS["X-Api-Key"] = key


_local = threading.local()
def http():
    """One Session per thread — Sessions are not thread-safe."""
    if not hasattr(_local, "s"):
        _local.s = requests.Session()
    return _local.s


def api_get(path, **kw):
    """GET against DEMI, retrying transport errors, 429 and 5xx: the API restarts and cold-starts."""
    last = None
    for attempt in range(6):
        if stop.is_set():
            raise RuntimeError("stopping")
        try:
            r = http().get(f"{API}{path}", headers=HEADERS, timeout=120, **kw)
            if r.status_code != 429 and r.status_code < 500:
                return r
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            last = str(e)
        delay = min(2 ** attempt, 60) + random.uniform(0, 2)
        log(f"  api retry {path} in {delay:.0f}s ({last})")
        stop.wait(delay)
    raise RuntimeError(f"api unreachable after retries: {last}")


def worklist_rows(batch):
    """The rows worth extracting. A row Eagle deleted answers 404 on download, so it stays off."""
    return [{
        "id": d["id"],
        "projectId": d.get("projectId"),
        "ext": (d.get("fileExt") or "pdf").lower().lstrip("."),
    } for d in batch if d.get("isDeleted") is not True]


def new_pool(workers, recycle=None):
    """Spawn, not fork: the parent holds a CUDA context. Recycling children caps pdfium's leak."""
    return ProcessPoolExecutor(max_workers=workers, max_tasks_per_child=recycle,
                               mp_context=multiprocessing.get_context("spawn"))


# ---------------------------------------------------------------- routing

def decide(counts, size):
    """Pure decision half of the router, so it can be checked without a PDF."""
    if not counts:
        return "ocr"
    median = statistics.median(counts)
    fraction = sum(1 for c in counts if c > 50) / len(counts)
    if median >= MIN_CHARS_PER_PAGE and fraction >= MIN_TEXT_FRACTION:
        return "text"
    # A tiny file with a little text is a short digital document; OCR would find nothing more.
    if size < LOW_YIELD_MIN_BYTES and median > 0:
        return "text"
    return "ocr"


# PDFium is not thread-safe and silently corrupts under concurrent use, and docling's threads use it
# without our lock. So every pdfium call runs in a pool process; the docling parent never opens a PDF.


def probe_pdf(path):
    """Characters already present on a sample of pages. Pool process only."""
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
    """Split a PDF into <=batch_pages sub-files; returns ([paths], page count). Pool process only.

    docling holds page images for the whole input, so peak RAM follows page count, not bytes.
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
    """Probe, and extract when the text layer is good enough. Pool process only.

    Returns (route, markdown_or_None, info). Never raises: an unreadable file escalates to OCR.
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

# One marker between pages, none leading or trailing: the chunker counts pages off it. No newlines
# around it, or ingest's blank-line block split drops it as an empty block.
PAGE_BREAK = "\f"


def join_pages(pages):
    """Pages joined by PAGE_BREAK. An empty page keeps its place so later page numbers stay right."""
    return PAGE_BREAK.join(p.strip() for p in pages)


def text_len(md):
    """Length without page markers, so a scan of blank pages does not read as converted."""
    return len(md) - md.count(PAGE_BREAK)


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
        return join_pages(pages)
    finally:
        doc.close()


def is_low_yield_text(md, size):
    """The probe said text but a substantial file came back near-empty: the probe was wrong."""
    return real_chars(md) < LOW_YIELD_CHARS and size > LOW_YIELD_MIN_BYTES


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
    device = AcceleratorDevice.CPU if DEVICE == "cpu" else AcceleratorDevice.CUDA
    opts.accelerator_options = AcceleratorOptions(num_threads=8, device=device)
    return DocumentConverter(format_options={
        InputFormat.PDF: PdfFormatOption(pipeline_options=opts, backend=pdf_backend()),
    })


def pdf_backend():
    """pypdfium2 by default: docling-parse's native decoder aborts the process on some files.

    DOCLING_PDF_BACKEND=doclingparse restores docling's default, crashes included.
    """
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    if os.environ.get("DOCLING_PDF_BACKEND", "pypdfium").lower() == "doclingparse":
        from docling.backend.docling_parse_backend import DoclingParseDocumentBackend
        return DoclingParseDocumentBackend
    return PyPdfiumDocumentBackend


# One shared full-page-OCR converter behind a lock: few documents need it, and a copy per thread costs VRAM.
_force_conv = None
_force_lock = threading.Lock()


def doc_pages(doc):
    """Markdown per page in page order; "" for an empty page. Formats with no page map are one page."""
    pages = getattr(doc, "pages", None)
    if not pages:
        return [doc.export_to_markdown()]
    return [doc.export_to_markdown(page_no=n) for n in sorted(pages)]


def convert_forced_pages(path):
    global _force_conv
    with _force_lock:
        if _force_conv is None:
            log("building full-page-OCR converter (first low-yield document)")
            _force_conv = build_converter(force_ocr=True)
        return doc_pages(_force_conv.convert(str(path)).document)


def convert_forced(path):
    """One file, pages joined. Tiles come through here, and a tile is one page with no marker."""
    return join_pages(convert_forced_pages(path))


PLACEHOLDER_RE = re.compile(r"<!--\s*image\s*-->")


def real_chars(md):
    """Characters that are neither whitespace nor docling's `<!-- image -->` placeholder.

    A placeholder-only file is 14 characters, so len() reads it as converted fine.
    """
    return len(re.sub(r"\s+", "", PLACEHOLDER_RE.sub("", md)))


def tile_job(path_str, ext, outdir, grid, overlap, scale_cap, max_pixels, max_pages):
    """Render each page and cut it into overlapping PNG tiles in outdir. Pool process only.

    Returns (tile_paths, truncated). Paths, not images: one render is ~180 MB to pickle.
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


def convert_tiled(path, ext, pool, doc_id=""):
    """Re-OCR a document tile by tile; "" when nothing came back. Only after a textless conversion.

    Lines repeated across tile seams are dropped once, document-wide, so the index holds them once.
    """
    import tempfile
    seen, by_page = set(), {}
    with tempfile.TemporaryDirectory(prefix="tile-") as td:
        tiles, truncated = pool.submit(tile_job, str(path), ext, td, TILE_GRID, TILE_OVERLAP,
                                       TILE_RENDER_SCALE, TILE_MAX_PIXELS,
                                       TILE_MAX_PAGES).result()
        if truncated:
            log(f"  {doc_id}: over {TILE_MAX_PAGES} pages — tiling stopped at that bound")
        for tile in tiles:
            # Page number from tile_job's `p<page>_<gy><gx>.png`; an all-empty page keeps its entry.
            lines = by_page.setdefault(int(Path(tile).stem.split("_")[0][1:]), [])
            for line in convert_forced(Path(tile)).splitlines():
                s = line.strip()
                # Every tile emits the placeholder; keeping one would look like the empty conversion.
                if not s or PLACEHOLDER_RE.fullmatch(s) or s in seen:
                    continue
                seen.add(s)
                lines.append(s)
    return join_pages("\n\n".join(by_page[p]) for p in sorted(by_page))


def convert_ocr(conv, path, ext, pool, doc_id=""):
    """docling conversion with the forced-OCR and tiling retries. Returns (md, forced, tiled).

    A runner fault raises; the caller decides what that means for the document.
    """
    size = path.stat().st_size
    parts = []
    try:
        if ocr_only(ext):
            parts, pages = [str(path)], 1
        else:
            try:
                parts, pages = pool.submit(split_pdf, str(path), OCR_BATCH_PAGES).result()
            except Exception as e:                                # noqa: BLE001
                if is_runner_fault(e):
                    raise
                # A failed split is not an unreadable document: the whole file often converts.
                log(f"  {doc_id}: split failed ({e}) — converting whole file instead")
                parts, pages = [str(path)], 1
        if len(parts) > 1:
            log(f"  {doc_id}: {pages} pages -> {len(parts)} batches of {OCR_BATCH_PAGES}")

        md = join_pages(
            page for p in parts for page in doc_pages(conv.convert(p).document)
        )

        forced = False
        if text_len(md) < LOW_YIELD_CHARS and size > LOW_YIELD_MIN_BYTES:
            log(f"  low yield {doc_id} ({text_len(md)} chars from {size // 1024} KB)"
                " — forcing OCR")
            retry = join_pages(
                page for p in parts for page in convert_forced_pages(Path(p))
            )
            if text_len(retry) > text_len(md):
                md, forced = retry, True

        tiled = False
        if real_chars(md) < TEXTLESS_CHARS:
            log(f"  textless {doc_id} ({real_chars(md)} real chars) — re-OCR in "
                f"{TILE_GRID}x{TILE_GRID} tiles")
            try:
                retry = convert_tiled(path, ext, pool, doc_id)
            except Exception as e:                                # noqa: BLE001
                # Tiling is an enhancement: losing it must not drop a conversion that already exists.
                if is_runner_fault(e):
                    raise
                log(f"  {doc_id}: tiling failed ({e}) — keeping the untiled conversion")
                retry = ""
            if real_chars(retry) > real_chars(md):
                md, tiled = retry, True
                log(f"  tiling recovered {real_chars(md)} chars for {doc_id}")
        return md, forced, tiled
    finally:
        for p in parts:
            if p != str(path):
                Path(p).unlink(missing_ok=True)


def recycle_converter(conv):
    """Drop a docling converter and rebuild it: a reused converter grows the parent without bound."""
    del conv
    gc.collect()
    try:
        import torch
        torch.cuda.empty_cache()
    except Exception:                                             # noqa: BLE001
        pass
    return build_converter()


def provenance(route_name, forced, tiled=False):
    """What the API stores as `extraction`. The API keeps these five keys and drops any other."""
    if route_name == "ocr":
        engine = f"docling+rapidocr ({DEVICE})"
        if forced:
            engine += ", force_full_page_ocr"
        if tiled:
            engine += f", {TILE_GRID}x{TILE_GRID} tiles"
        return {"path": "ocr",
                "engine": engine,
                "doclingVersion": DOCLING_VERSION,
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


# ---------------------------------------------------------------- download and post

def download(doc, dest_dir):
    """Fetch the stored file through its presigned URL into dest_dir, named with the real extension."""
    doc_id = doc["id"]
    r = api_get(f"/documents/{doc_id}/download")
    if r.status_code == 404:
        raise SourceMissing(f"the API has no stored file for this document ({r.text[:120]})")
    r.raise_for_status()
    url = r.json()["url"]

    # docling picks its reader by extension.
    dest = Path(dest_dir) / f"{doc_id}.{doc['ext']}"
    limit = MAX_FILE_MB * 1024 * 1024
    with http().get(url, stream=True, timeout=600) as resp:
        # Never log the URL: it is presigned, a long signature that buries the journal.
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
    # A dropped connection ends iter_content without raising; a short PDF then looks corrupt.
    if declared and written != declared:
        dest.unlink(missing_ok=True)
        raise RuntimeError(f"truncated download: {written} of {declared} bytes")
    return dest


def ndjson_body(markdown, extraction):
    """Metadata line, then JSON blocks split like `src/chunker.js`, so both routes chunk the same.

    Bytes, not a generator: a chunked request body reaches the Function worker empty.
    """
    parts = [json.dumps({"extraction": extraction} if extraction else {})]
    parts += [json.dumps(b) for b in re.split(r"\n{2,}", markdown) if b.strip()]
    return ("\n".join(parts) + "\n").encode()


def post_chunks(doc_id, body, stream_markdown=None):
    """POST with retry on 429, 5xx and transport errors — the API cold-starts and restarts on deploy."""
    last = None
    for attempt in range(6):
        try:
            if stream_markdown is not None:
                r = http().post(
                    f"{API}/documents/{doc_id}/chunks",
                    headers={**HEADERS, "Content-Type": "application/x-ndjson"},
                    data=ndjson_body(stream_markdown, body.get("extraction")), timeout=900)
            else:
                r = http().post(f"{API}/documents/{doc_id}/chunks",
                                headers=HEADERS, json=body, timeout=300)
            if r.status_code != 429 and r.status_code < 500:
                return r
            last = f"HTTP {r.status_code} {r.text[:120]}"
        except requests.RequestException as e:
            last = str(e)
        delay = min(2 ** attempt, 60) + random.uniform(0, 2)
        log(f"  retry {doc_id} in {delay:.0f}s ({last})")
        time.sleep(delay)
    raise RuntimeError(f"unreachable after retries: {last}")


def post_markdown(doc_id, markdown, extraction=None):
    """Post converted markdown, as NDJSON by size: a 413 would cost a full upload first."""
    # pypdfium2 emits \r\n; the host's posts went through read_text(), which folds them to \n.
    markdown = markdown.replace("\r\n", "\n").replace("\r", "\n")
    body = {"extraction": extraction} if extraction else {}
    if len(markdown.encode()) >= STREAM_MIN_BYTES:
        log(f"  {doc_id}: {len(markdown) // (1024 * 1024)} MB — streaming as NDJSON")
        return post_chunks(doc_id, body, markdown)
    return post_chunks(doc_id, {"markdown": markdown, **body})


def error_body(reason):
    """A permanent extraction error: the API marks the document extracted with no chunks."""
    return {"error": reason[:500]}
