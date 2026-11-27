#!/usr/bin/env python3
"""Converts fixtures/ through worker.py's threads and through job.py; exits 1 unless the markdown matches.

Run: OCR_DEVICE=cpu python3 parity_check.py   (needs docling; the API and queue are faked)
"""
import functools
import json
import os
import shutil
import sys
import tempfile
import threading
from pathlib import Path

os.environ.setdefault("DEMI_ADMIN_KEY", "parity-not-used")
import extract_core as core  # noqa: E402
import job  # noqa: E402
import worker  # noqa: E402
from test_job import Queue, Resp  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


def via_worker(files, tmp, pool):
    worker.OUT, worker.PROGRESS, worker._pool = tmp / "out", tmp / "progress.jsonl", pool
    worker.OUT.mkdir()
    for f in files:
        path = tmp / f.name
        shutil.copy(f, path)
        doc = {"id": f.stem, "ext": f.suffix[1:], "projectId": None}
        (worker.to_ocr if core.ocr_only(doc["ext"]) else worker.to_probe).put((doc, path))
    pdf, ocr = threading.Thread(target=worker.pdf_worker), threading.Thread(target=worker.ocr_worker)
    pdf.start(), ocr.start()
    worker.to_probe.put(None)
    pdf.join()
    worker.to_ocr.put(None)
    ocr.join()
    return {f.stem: (worker.OUT / f"{f.stem}.md").read_text() for f in files}


def via_job(files, pool):
    posts, converter = {}, functools.cache(core.build_converter)
    for f in files:
        core.api_get = lambda path, f=f: Resp(200, {"id": f.stem, "fileExt": f.suffix[1:]})
        core.download = lambda doc, dest, f=f: Path(shutil.copy(f, Path(dest) / f.name))
        core.post_chunks = lambda doc_id, body, stream=None: (posts.update({doc_id: body}), Resp(200))[1]
        q = Queue(content=json.dumps({"documentId": f.stem}))
        assert job.run_once(q, Queue(), pool, converter) == "ok", f.name
    return {k: v["markdown"] for k, v in posts.items()}


def main():
    files = sorted(FIXTURES.iterdir())
    pool = core.new_pool(2)
    with tempfile.TemporaryDirectory(prefix="parity-") as td:
        host = via_worker(files, Path(td), pool)
        azure = via_job(files, pool)
    pool.shutdown()
    same = True
    for f in files:
        ok = host[f.stem].encode() == azure[f.stem].encode()
        same &= ok and bool(host[f.stem].strip())
        print(f"{'identical' if ok else 'DIFFERENT'}  {f.name}  {len(host[f.stem])} chars")
    print("parity ok" if same else "parity FAILED")
    return 0 if same else 1


if __name__ == "__main__":
    sys.exit(main())
