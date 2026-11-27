#!/usr/bin/env python3
"""Host phase 2: post out/*.md and .err to the API, then move them to sent/ (or dead/ on a 4xx).

Re-posting is a no-op, so a rerun is a valid recovery. --resend replays everything.
"""

import json
import os
import queue
import sys
import threading
import time
from pathlib import Path

import extract_core
from extract_core import API, error_body, log, post_chunks, post_markdown

extract_core.set_key(os.environ["DEMI_ADMIN_KEY"])
BASE = Path(os.environ.get("WORK_DIR", "/root/gpu-extractor"))
OUT = BASE / "out"
SENT = BASE / "sent"
DEAD = BASE / "dead"
LEDGER = BASE / "ingest.jsonl"

UPLOADERS = int(os.environ.get("UPLOADERS", "4"))
LIMIT = int(os.environ.get("INGEST_LIMIT", "0")) or None
RESEND = "--resend" in sys.argv

counts = {"ok": 0, "failed": 0, "chunks": 0, "errors_recorded": 0}
_lock = threading.Lock()
_llock = threading.Lock()


def record(**row):
    row["t"] = time.time()
    with _llock:
        with LEDGER.open("a") as f:
            f.write(json.dumps(row) + "\n")


def park(path, dest):
    """Move a posted file out of out/ with its sidecar, or --resend replays it without provenance."""
    path.rename(dest / path.name)
    sidecar = path.with_suffix(".json")
    if sidecar.exists():
        sidecar.rename(dest / sidecar.name)


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
        extraction = None
        # Optional: files converted before worker.py wrote the sidecar post with no `extraction`.
        prov = path.with_suffix(".json")
        if prov.exists():
            try:
                extraction = json.loads(prov.read_text())
            except (OSError, ValueError) as e:
                log(f"  {doc_id}: unreadable provenance sidecar ({e}) — posting without it")
        try:
            if is_error:
                body = error_body(text)
                if extraction:
                    body["extraction"] = extraction
                r = post_chunks(doc_id, body)
            else:
                r = post_markdown(doc_id, text, extraction)
            if r.status_code >= 400:
                # 404, 413 and 400 are terminal: park in dead/ so reruns stop retrying it.
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
