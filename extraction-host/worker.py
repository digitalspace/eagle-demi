#!/usr/bin/env python3
"""Host extraction run: document -> markdown on local disk; ingest.py posts it later.

Writing to disk decouples a days-long GPU run from API restarts. The work list is snapshotted to
worklist.json; a document is done once a .md or .err exists in out/, sent/ or dead/.
"""

import json
import os
import queue
import signal
import sys
import threading
import time
from pathlib import Path

import extract_core
from extract_core import (
    API, TILE_GRID, UNSUPPORTED_EXTS, SourceMissing, api_get, build_converter, convert_ocr,
    decide, download, is_low_yield_text, is_runner_fault, log, new_pool, ocr_only, pdfium_job,
    provenance, real_chars, recycle_converter, stop, worklist_rows,
)

# A missing key fails here, not as a 401 an hour in; --selfcheck needs no network.
extract_core.set_key("" if "--selfcheck" in sys.argv else os.environ["DEMI_ADMIN_KEY"])
BASE = Path(os.environ.get("WORK_DIR", "/root/gpu-extractor"))
CACHE = BASE / "cache"
OUT = BASE / "out"
# ingest.py moves files here; already_done() must see them or the work repeats forever.
SENT = BASE / "sent"
DEAD = BASE / "dead"
WORKLIST = BASE / "worklist.json"
PROGRESS = BASE / "progress.jsonl"

LIMIT = int(os.environ.get("LIMIT", "0")) or None          # 0 = whole corpus
INFLIGHT = int(os.environ.get("INFLIGHT", "8"))
# Most documents take the CPU path, so the object store is the slowest link, not the GPU.
DOWNLOADERS = int(os.environ.get("DOWNLOADERS", "6"))
TEXT_WORKERS = int(os.environ.get("TEXT_WORKERS", "6"))
# Three converters OOM the 16 GiB box: docling RAM follows page count. Two plus the big-document
# lock stays under.
CONVERTERS = int(os.environ.get("CONVERTERS", "2"))
# Low: one large PDF is what grows a child, and a spawn is cheap next to OCR.
POOL_RECYCLE = int(os.environ.get("POOL_RECYCLE", "25"))
# Same idea for the docling converters in THIS process — see recycle_converter().
OCR_RECYCLE = int(os.environ.get("OCR_RECYCLE", "25"))
# Only one document this size converts at a time, whatever CONVERTERS says.
BIG_DOC_BYTES = int(os.environ.get("BIG_DOC_MB", "8")) * 1024 * 1024
# 1000 is the API's cap; smaller pages trip DEMI's 300/min rate limiter on the work-list build.
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "1000"))

# Consecutive runner faults before the run stops, rather than deferring the whole work list.
MAX_CONSECUTIVE_DEFERS = int(os.environ.get("MAX_CONSECUTIVE_DEFERS", "25"))


_plock = threading.Lock()
def record(**row):
    row["t"] = time.time()
    with _plock:
        with PROGRESS.open("a") as f:
            f.write(json.dumps(row) + "\n")


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
        r = api_get("/documents/scan", params=params)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        docs.extend(worklist_rows(batch))
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


# Serialises the memory-hungry documents without serialising the whole pipeline.
_big_doc = threading.Semaphore(1)


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


def ensure_pool():
    """Rebuild the process pool if it has broken: a broken ProcessPoolExecutor never recovers."""
    global _pool
    with _pool_lock:
        if not getattr(_pool, "_broken", None):
            return False
        log("process pool is broken — rebuilding")
        try:
            _pool.shutdown(wait=False)
        except Exception:                                         # noqa: BLE001 - already broken
            pass
        _pool = new_pool(TEXT_WORKERS, POOL_RECYCLE)
        return True


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
            path = download(doc, CACHE)
        except SourceMissing as e:
            log(f"  source missing {doc['id']}: {e}")
            missing(doc["id"], str(e))
            continue
        except Exception as e:                                    # noqa: BLE001 - report, never die
            log(f"  download failed {doc['id']}: {e}")
            fail(doc["id"], f"download failed: {e}")
            continue
        if ocr_only(doc["ext"]):
            bump("ocr")
            to_ocr.put((doc, path))
        else:
            to_probe.put((doc, path))


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
            # Without a rebuild every later document falls through to OCR.
            ensure_pool()
        if info.get("note"):
            log(f"  {doc_id}: {info['note']} — routing to OCR")

        if which == "text":
            size = path.stat().st_size
            if is_low_yield_text(md, size):
                log(f"  low yield {doc_id} ({real_chars(md)} real chars from {size // 1024} KB)"
                    " — re-routing to OCR")
                bump("rerouted")
                which = "ocr"

        if which == "ocr":
            bump("ocr")
            # Recorded so the OCR share can be traced to a threshold.
            record(id=doc_id, stage="probe", route="ocr", bytes=path.stat().st_size, **info)
            to_ocr.put((doc, path))
            continue

        bump("text")
        finish(doc_id, md, path, "text", t0, info=info)
        path.unlink(missing_ok=True)


def ocr_worker():
    conv = build_converter()
    log(f"docling converter ready ({extract_core.DEVICE})")
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
        big = path.stat().st_size >= BIG_DOC_BYTES
        if big:
            _big_doc.acquire()
        try:
            md, forced, tiled = convert_ocr(conv, path, doc["ext"], _pool, doc_id)
            if forced:
                bump("forced")
            if tiled:
                bump("tiled")
            finish(doc_id, md, path, "ocr", t0, forced=forced, tiled=tiled)
        except Exception as e:                                    # noqa: BLE001
            # Classify first: a broken pool raises on every later document, and recording each as
            # failed would drop good documents for good.
            if is_runner_fault(e):
                log(f"  runner fault on {doc_id}: {e} — deferring, document stays in the work list")
                defer(doc_id, f"runner fault: {e}", "ocr")
                ensure_pool()
                # A faulted CUDA context poisons every later conversion in this thread.
                conv = recycle_converter(conv)
            else:
                log(f"  convert failed {doc_id}: {e}")
                fail(doc_id, f"docling failed: {e}", "ocr")
        finally:
            if big:
                _big_doc.release()
            handled += 1
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
    """The routing decision and the work-list filter can be wrong without failing loudly, so they
    are the pieces with a check."""
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
    rows = worklist_rows([{"id": "a", "fileExt": ".PDF"}, {"id": "b", "isDeleted": True}])
    assert rows == [{"id": "a", "projectId": None, "ext": "pdf"}], "a deleted row must stay off the work list"
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

    global _pool
    _pool = new_pool(TEXT_WORKERS, POOL_RECYCLE)

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
