#!/usr/bin/env python3
"""
Phase 2 of the DEMI corpus backfill: replay out/*.md into Azure.

Completely separate from extraction. Run it whenever the API is up — during, after, or repeatedly.
Nothing here touches the GPU, so extraction is never blocked by an Azure deploy or a Typesense
resize, and nothing is lost if this is interrupted.

The server does the chunking and copies read[] from the LIVE document, so markdown extracted days
ago still lands with today's ACL. Chunk ids are deterministic and the route reconciles, so
re-posting the same file is a no-op — which is what makes "just run it again" a valid recovery.

Sent files move to sent/ so a rerun only does outstanding work. --resend replays everything.
"""

import json
import os
import queue
import random
import re
import sys
import threading
import time
from pathlib import Path

import requests

API = os.environ.get("DEMI_API", "https://demi-api-dev.azurewebsites.net/api").rstrip("/")
KEY = os.environ["DEMI_ADMIN_KEY"]
BASE = Path(os.environ.get("WORK_DIR", "/root/gpu-extractor"))
OUT = BASE / "out"
SENT = BASE / "sent"
DEAD = BASE / "dead"
LEDGER = BASE / "ingest.jsonl"

# Above this, markdown is streamed as NDJSON instead of posted as one JSON body. The API caps
# `express.json` at 10 MB and cannot raise it — a 63 MB body parses to a 63 MB JS string plus
# parser buffer on a B1 Basic instance with 1.75 GB and ONE worker. 15 documents in this corpus
# already exceed the cap (docling renders them as one huge table; the largest is 2,198 lines
# averaging 28,817 chars) and the roadmap is ~300K documents, so this is a class, not an outlier.
# Set well under the cap so the switch happens before the cliff, not at it.
STREAM_MIN_BYTES = int(os.environ.get("STREAM_MIN_BYTES", str(4 * 1024 * 1024)))

UPLOADERS = int(os.environ.get("UPLOADERS", "4"))
LIMIT = int(os.environ.get("INGEST_LIMIT", "0")) or None
RESEND = "--resend" in sys.argv

HEADERS = {"X-Api-Key": KEY}
counts = {"ok": 0, "failed": 0, "chunks": 0, "errors_recorded": 0}
_lock = threading.Lock()
_llock = threading.Lock()


def log(msg):
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def record(**row):
    row["t"] = time.time()
    with _llock:
        with LEDGER.open("a") as f:
            f.write(json.dumps(row) + "\n")


_local = threading.local()
def http():
    if not hasattr(_local, "s"):
        _local.s = requests.Session()
    return _local.s


def park(path, dest):
    """Move a posted file out of out/, taking its provenance sidecar with it.

    The sidecar has to travel with the markdown or it is orphaned in out/ — harmless to a normal
    run, which only globs .md and .err, but --resend would then move the markdown back without it
    and the document would silently lose its provenance on the replay."""
    path.rename(dest / path.name)
    sidecar = path.with_suffix(".json")
    if sidecar.exists():
        sidecar.rename(dest / sidecar.name)


def ndjson_body(markdown, extraction):
    """NDJSON for the streaming ingest route: metadata line, then JSON-encoded markdown blocks.

    Split with the SAME `\n{2,}` regex `src/chunker.js` uses, so a document chunks identically
    whichever route it came through — the API asserts that equivalence in its own tests and this
    is the other half of it. Blocks are JSON-encoded because a markdown paragraph contains
    newlines and an NDJSON line cannot.

    RETURNS BYTES, NOT A GENERATOR, and that is load-bearing. A generator makes `requests` use
    `Transfer-Encoding: chunked`, and **Azure App Service does not forward a chunked request body
    to the Node worker** — the app sees an EMPTY stream and answers 400, which reads exactly like
    a malformed payload. Measured 2026-08-03: identical bytes, chunked -> 400 "empty stream",
    Content-Length -> 200. Materialising costs this box ~60 MB of RAM out of 64 GB.

    This does NOT undo the streaming. Content-Length is metadata; Node still receives the body
    incrementally off the socket and the API still chunks and flushes as it arrives, so its peak
    memory is still one batch rather than the whole document. The 1.75 GB side is what mattered.
    """
    parts = [json.dumps({"extraction": extraction} if extraction else {})]
    parts += [json.dumps(b) for b in re.split(r"\n{2,}", markdown) if b.strip()]
    return ("\n".join(parts) + "\n").encode()


def post_chunks(doc_id, body, stream_markdown=None):
    """POST with retry on 5xx and transport errors — the API cold-starts and restarts on deploy."""
    last = None
    for attempt in range(6):
        try:
            if stream_markdown is not None:
                # Longer timeout than the JSON path: these are the biggest documents in the corpus
                # and the server is chunking and writing to Cosmos as the body arrives.
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


work = queue.Queue()


def uploader():
    while True:
        path = work.get()
        if path is None:
            work.put(None)
            return
        doc_id = path.stem
        is_error = path.suffix == ".err"
        text = path.read_text()
        body = {"error": text[:500]} if is_error else {"markdown": text}
        # Provenance sidecar written by worker.py. Optional by design: files converted before
        # worker.py emitted it still post, they just carry no `extraction` — which is honest, the
        # path really is unknown for them. The API sanitises this to a fixed whitelist.
        prov = path.with_suffix(".json")
        if prov.exists():
            try:
                body["extraction"] = json.loads(prov.read_text())
            except (OSError, ValueError) as e:
                log(f"  {doc_id}: unreadable provenance sidecar ({e}) — posting without it")
        # Streaming is chosen by SIZE, not by trying JSON first and falling back: a 413 costs a
        # full upload of a body the API was never going to accept, and at 300K documents this
        # class is common enough that paying that twice is not a rare cost.
        stream_markdown = None
        if not is_error and len(text.encode()) >= STREAM_MIN_BYTES:
            stream_markdown = text
            body.pop("markdown", None)
            log(f"  {doc_id}: {len(text) // (1024 * 1024)} MB — streaming as NDJSON")
        try:
            r = post_chunks(doc_id, body, stream_markdown)
            if r.status_code >= 400:
                # Terminal for this document — 404 (deleted since extraction), 413 (markdown over
                # the body limit), 400 (malformed). Retrying cannot change any of them, so park the
                # file in dead/ instead of leaving it to be retried by every future rerun.
                with _lock:
                    counts["failed"] += 1
                log(f"  {doc_id}: HTTP {r.status_code} {r.text[:120]}")
                record(id=doc_id, status=r.status_code, error=r.text[:200])
                park(path, DEAD)
            else:
                res = r.json()
                with _lock:
                    counts["ok"] += 1
                    counts["chunks"] += res.get("chunks", 0)
                    if is_error:
                        counts["errors_recorded"] += 1
                record(id=doc_id, chunks=res.get("chunks", 0), recorded_error=is_error)
                park(path, SENT)
        except Exception as e:                                    # noqa: BLE001
            # Left in out/ deliberately: this is the retryable class, so a rerun picks it up.
            with _lock:
                counts["failed"] += 1
            log(f"  {doc_id} failed: {e}")
            record(id=doc_id, error=str(e)[:200])


def main():
    for d in (SENT, DEAD):
        d.mkdir(parents=True, exist_ok=True)
    if not OUT.exists():
        log(f"nothing to do — {OUT} does not exist")
        return 0

    if RESEND:
        moved = 0
        for src in (SENT, DEAD):
            for p in src.iterdir():
                p.rename(OUT / p.name)
                moved += 1
        log(f"--resend: moved {moved} files back into out/")

    files = sorted([*OUT.glob("*.md"), *OUT.glob("*.err")])
    if LIMIT:
        files = files[:LIMIT]
    if not files:
        log("nothing to ingest — out/ is empty")
        return 0

    log(f"ingesting {len(files)} files to {API} with {UPLOADERS} uploaders")
    started = time.time()
    for f in files:
        work.put(f)
    work.put(None)

    threads = [threading.Thread(target=uploader, name=f"up{i}", daemon=True)
               for i in range(UPLOADERS)]
    for t in threads:
        t.start()

    finished = threading.Event()

    def monitor():
        last = 0
        while not finished.is_set():
            finished.wait(30)
            done = counts["ok"] + counts["failed"]
            if done != last:
                rate = done / max(time.time() - started, 1)
                log(f"progress: {counts['ok']} ok, {counts['failed']} failed, "
                    f"{counts['chunks']} chunks, {rate * 3600:.0f} docs/hr, "
                    f"{len(files) - done} left")
                last = done

    threading.Thread(target=monitor, daemon=True).start()
    for t in threads:
        t.join()
    finished.set()

    elapsed = time.time() - started
    log(f"DONE in {elapsed / 60:.1f} min — {counts['ok']} ok ({counts['errors_recorded']} were "
        f"recorded extraction errors), {counts['failed']} failed, {counts['chunks']} chunks")
    if counts["ok"]:
        log(f"  {counts['chunks'] / counts['ok']:.1f} chunks/document")
    if counts["failed"]:
        log("  failures stay in out/ — rerun to retry them")
    return 0


if __name__ == "__main__":
    sys.exit(main())
