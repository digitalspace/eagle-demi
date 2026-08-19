"""OCR for documents with no usable text layer.

`decide()` in `extract.py` routes roughly 44% of documents here — scans, photographed pages, and
anything whose text layer is too thin to be worth trusting. Until this existed those documents
reached the index with searchable metadata and no searchable text.

WHY RapidOCR ON CPU AND NOT A GPU. `extraction-host/worker.py` runs the same OCR engine
(docling's default is RapidOCR) on CUDA, because it had 60,000 documents to clear. This pipeline
handles net-new arrivals: ~3.6 documents a day, of which the probe routes 1-2 to OCR. A serverless
GPU, its workload-profiles environment and a quota case, for two documents a day, is machinery
without a load. RapidOCR is ONNX Runtime and pure wheels — no torch, no CUDA, no new Azure resource
— and it is the *same engine* that produced the 1.13M chunks already in the index, so the index
keeps one OCR regime rather than two.

WHY THIS IS 100 LINES AND worker.py's OCR PATH IS NOT. Nearly all of that file's complexity —
`OCR_BATCH_PAGES`, converter recycling, `MemoryMax=48G`, the ~330 MB-per-document leak — exists
because docling holds page images for the whole document it is handed. Rendering and discarding one
page at a time removes the failure mode instead of reproducing its workarounds. Measured peak RSS is
~840 MB on a 289-page scan — flat in page count, and a third of a 4096 MB instance.

MEASURED, on the 289-page scan dev serves as `6a3071f45f8420490f8cfe64`, at two ONNX threads (what
a 4096 MB Flex instance has): **4.2 s per page** (median 4.2, p90 6.1, max 7.1), 1,686 characters
recovered per page, zero empty pages. That is ~20 minutes for the whole document, which is why the
limiter below is a time budget rather than a page count: page cost varies by 70% with density, and
the thing that actually breaks is exceeding the queue's visibility timeout — at which point a second
instance starts the same document and five rounds of that park it in the poison queue.

NOT IMPLEMENTED, deliberately: DEMI's 3×3 tiled re-OCR of pages that come back empty. It recovered
real text from 91% of the 2,039 documents that OCR'd to nothing (3.8% of their corpus), so it works
and it is worth having — but it is worth having *once the residue here is measured*. `emptyPages` in
the returned info is that measurement.

Environment:
    OCR_ENABLED        `false` disables OCR without a redeploy; documents fall back to backlog rows
    OCR_RENDER_SCALE   pypdfium2 render scale, default 2.0 (~150 DPI on letter)
    OCR_THREADS        ONNX Runtime intra-op threads, default 2 — a 4096 MB Flex instance has 2 cores
    OCR_BUDGET_SECONDS default 2400 (40 min), against a queue visibility timeout of 60
    MAX_OCR_PAGES      hard ceiling, default 2000; the budget is normally what stops the loop
"""

import os
import time

# Magic bytes rather than a file extension: `download()` writes every document to a `.bin`, and the
# extractor is given an id, not a filename — `internalExt` lives in Mongo and is never sent here.
MAGIC = {
    b"%PDF": "pdf",
    b"\xff\xd8\xff": "image",
    b"\x89PNG": "image",
    b"II*\x00": "image",
    b"MM\x00*": "image",
    b"BM": "image",
    b"GIF8": "image",
}

OCR_ENABLED = os.environ.get("OCR_ENABLED", "true").lower() not in ("false", "0", "no")
OCR_RENDER_SCALE = float(os.environ.get("OCR_RENDER_SCALE", "2.0"))
OCR_THREADS = int(os.environ.get("OCR_THREADS", "2"))
OCR_BUDGET_SECONDS = float(os.environ.get("OCR_BUDGET_SECONDS", "2400"))
MAX_OCR_PAGES = int(os.environ.get("MAX_OCR_PAGES", "2000"))

_engine = None


def sniff(path):
    """`pdf`, `image`, or None for something this module cannot read."""
    with open(path, "rb") as fh:
        head = fh.read(8)
    for magic, kind in MAGIC.items():
        if head.startswith(magic):
            return kind
    return None


def engine():
    """One RapidOCR per process. Loading the models costs ~0.2 s and they are ~15 MB resident."""
    global _engine
    if _engine is None:
        from rapidocr_onnxruntime import RapidOCR

        _engine = RapidOCR(intra_op_num_threads=OCR_THREADS)
    return _engine


def _text(image):
    """Recognised lines, in reading order as RapidOCR returns them. `None` means nothing found."""
    result, _ = engine()(image)
    return "\n".join(r[1] for r in (result or []))


def ocr_file(path, max_pages=None):
    """OCR a whole document. Returns `(markdown, info)`; markdown is `''` when nothing was read.

    Pages are joined with a blank line because `chunker.js` splits on `/\\n{2,}/` — the same
    contract the text path honours. The page index is available here and dropped in the join, for
    the same reason it is dropped there: `pageNumber` in the index is a passage sequence, and
    threading real pages down one path only would leave two regimes with nothing to tell them apart.
    """
    import numpy as np
    import pypdfium2 as pdfium

    cap = max_pages if max_pages is not None else MAX_OCR_PAGES
    kind = sniff(path)
    if kind is None:
        return "", {"kind": None, "reason": "not a PDF or image this extractor can open"}

    if kind == "image":
        from PIL import Image

        with Image.open(path) as im:
            text = _text(np.asarray(im.convert("RGB")))
        return text, {"kind": kind, "pagesRead": 1, "emptyPages": 0 if text else 1}

    try:
        doc = pdfium.PdfDocument(path)
    except Exception as e:  # noqa: BLE001
        # A file that claims to be a PDF and will not open is truncated or corrupt. Raising would
        # retry it five times and park it in the poison queue beside real failures; it is a
        # permanent property of the bytes, so it is recorded and consumed.
        return "", {"kind": kind, "reason": f"could not open: {e}"}
    try:
        total = len(doc)
        started = time.monotonic()
        pages, empty, read = [], 0, 0
        for i in range(min(total, cap)):
            if i and time.monotonic() - started > OCR_BUDGET_SECONDS:
                break
            page = doc[i]
            try:
                # Render and OCR one page, then let both go. This is the whole memory strategy.
                image = np.asarray(page.render(scale=OCR_RENDER_SCALE).to_pil().convert("RGB"))
                text = _text(image)
            finally:
                page.close()
            read += 1
            if text:
                pages.append(text)
            else:
                empty += 1

        info = {"kind": kind, "pagesRead": read, "emptyPages": empty}
        # Short of the end the document is ingested anyway rather than dropped: partially searchable
        # beats invisible. It has to be countable, though, or a document that stopped at page 400 of
        # 900 is indistinguishable from one that was read to the end.
        if read < total:
            info["truncatedAtPage"] = read
            info["pages"] = total
        return "\n\n".join(pages), info
    finally:
        doc.close()
