"""Checks for the runner-fault fix. Every one of these fails if the 2026-07-30 cascade could recur.

Run: DEMI_ADMIN_KEY=x python3 test_poolfix.py
"""
import multiprocessing
import os
import shutil
import signal
import sys
import tempfile
import time
import types
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path

import requests

sys.argv = ["test"]
os.environ.setdefault("DEMI_ADMIN_KEY", "test-not-used")
import worker  # noqa: E402


def kill_self():
    os.kill(os.getpid(), signal.SIGKILL)


def check(label, cond):
    print(f"  {'ok  ' if cond else 'FAIL'} {label}")
    if not cond:
        raise SystemExit(f"FAILED: {label}")


def main():
    print("classification — a runner fault must never be recorded as a document failure")
    check("BrokenProcessPool is a runner fault",
          worker.is_runner_fault(BrokenProcessPool("A child process terminated abruptly")))
    check("the exact corpus error string is a runner fault",
          worker.is_runner_fault(RuntimeError(
              "A child process terminated abruptly, the process pool is not usable anymore")))
    check("CUDA OOM is a runner fault", worker.is_runner_fault(RuntimeError("CUDA out of memory")))
    check("pdfium page-load failure is a runner fault (measured false positive)",
          worker.is_runner_fault(RuntimeError(
              "Conversion failed for: x.pdf with status: failure. Errors: Failed to load page.; Failed to load page.")))
    check("shutdown race is a runner fault",
          worker.is_runner_fault(RuntimeError("cannot schedule new futures after shutdown")))
    # The other side matters just as much: a genuinely broken PDF must still be recorded, or the
    # work list never drains and every rerun retries the same unreadable file forever.
    check("a corrupt PDF is NOT a runner fault", not worker.is_runner_fault(RuntimeError("Data format error")))
    check("an unsupported format is NOT a runner fault",
          not worker.is_runner_fault(RuntimeError("unsupported format: msg")))

    print("pool rebuild — a broken pool must not disable the text path for the rest of the run")
    worker._pool = worker.new_pool()
    check("healthy pool is not rebuilt", worker.ensure_pool() is False)
    try:
        worker._pool.submit(kill_self).result()
    except Exception:
        pass
    time.sleep(0.5)
    check("pool reports broken after a child dies", bool(getattr(worker._pool, "_broken", None)))
    check("ensure_pool rebuilds it", worker.ensure_pool() is True)
    check("the rebuilt pool actually works", worker._pool.submit(abs, -7).result() == 7)
    worker._pool.shutdown(wait=False)

    print("defer — writes no .err, so the document stays in the work list")
    before = set(worker.OUT.glob("*.err"))
    worker.defer("test-doc-id", "runner fault: simulated")
    check("no .err written", set(worker.OUT.glob("*.err")) == before)
    check("counted as deferred, not failed",
          worker.counts["deferred"] >= 1 and worker.counts["failed"] == 0)

    print("circuit breaker — a permanent fault must stop the run, not walk the whole corpus")
    worker.stop.clear()
    worker._streak["defers"] = 0
    for i in range(worker.MAX_CONSECUTIVE_DEFERS - 2):
        worker.defer(f"d{i}", "simulated")
    check("not stopped below the threshold", not worker.stop.is_set())
    worker.defer("last", "simulated")
    worker.defer("past", "simulated")
    check("stopped at the threshold", worker.stop.is_set())
    worker.stop.clear()

    # 2026-08-02: 5,445 documents were marked extracted-with-error and dropped out of the work list
    # because the object store had no file for them. An unfetchable file is a third thing, neither
    # a bad document nor a broken runner, and these checks pin that down.
    print("source missing — an unfetchable file is not a document defect")
    # Own directory per fixture. Sharing one output path is how an earlier harness reported three
    # false failures and several false passes at once.
    tmp = Path(tempfile.mkdtemp(prefix="poolfix-missing-"))
    real_out = worker.OUT
    worker.OUT = tmp
    try:
        worker.counts["missing"] = 0
        worker.counts["failed"] = 0
        worker._streak["defers"] = 0
        worker.missing("m-first", "the object store has no object at the presigned key")
        check("no .err written", list(tmp.glob("*.err")) == [])
        check("counted as missing, not failed",
              worker.counts["missing"] == 1 and worker.counts["failed"] == 0)
        check("does not touch the runner-fault streak", worker._streak["defers"] == 0)

        # The whole reason missing() is not defer(): a partially-populated object store must not
        # abandon the documents whose files ARE present.
        worker.stop.clear()
        for i in range(worker.MAX_CONSECUTIVE_DEFERS + 5):
            worker.missing(f"m-{i}", "simulated")
        check("thousands of missing files do NOT stop the run", not worker.stop.is_set())

        # The other half of the distinction, or the work list never drains.
        worker.fail("f-real", "unsupported format: zip")
        check("a real document failure still writes a .err", (tmp / "f-real.err").exists())
        check("and is counted as failed", worker.counts["failed"] == 1)
    finally:
        worker.OUT = real_out
        shutil.rmtree(tmp, ignore_errors=True)

    print("download classification — only a 404 is 'source missing'")

    class Resp:
        def __init__(self, code):
            self.status_code, self.text, self.headers = code, "{}", {}

        def raise_for_status(self):
            if self.status_code >= 400:
                raise requests.HTTPError(f"{self.status_code} Server Error")

        def json(self):
            return {"url": "https://example.invalid/object"}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    real_api_get, real_http = worker.api_get, worker.http

    def attempt(api_code, obj_code):
        """Returns the exception download() raised, with no network touched."""
        worker.api_get = lambda p, **k: Resp(api_code)
        worker.http = lambda: types.SimpleNamespace(get=lambda *a, **k: Resp(obj_code))
        try:
            worker.download({"id": "probe", "ext": "pdf"})
        except Exception as e:                                    # noqa: BLE001 - that is the check
            return e
        return None

    try:
        check("a 404 from the API is SourceMissing",
              isinstance(attempt(404, 200), worker.SourceMissing))
        check("a 404 from the object store is SourceMissing",
              isinstance(attempt(200, 404), worker.SourceMissing))
        # Everything else keeps its old handling — these still become recorded failures, and a 5xx
        # that silently became "missing" would hide a real outage as a data gap.
        check("a 500 from the object store is NOT SourceMissing",
              not isinstance(attempt(200, 500), worker.SourceMissing))
        check("a 500 from the API is NOT SourceMissing",
              not isinstance(attempt(500, 200), worker.SourceMissing))
        check("the SourceMissing message carries no presigned URL",
              "X-Amz" not in str(attempt(200, 404)))
    finally:
        worker.api_get, worker.http = real_api_get, real_http

    print("provenance — the field nothing has ever sent")
    ocr = worker.provenance("ocr", forced=True)
    txt = worker.provenance("text", forced=False)
    check("ocr path is 'ocr'", ocr["path"] == "ocr")
    check("text path is 'text'", txt["path"] == "text")
    check("forced OCR is recorded in options", ocr["options"]["force_ocr"] is True)
    check("carries a docling version", isinstance(ocr["doclingVersion"], str) and ocr["doclingVersion"])
    check("timestamp is ISO-8601 UTC", ocr["at"].endswith("+00:00"))
    # The API whitelists exactly these and drops the rest; a typo here is silently discarded.
    check("only whitelisted keys", set(ocr) == {"path", "engine", "doclingVersion", "options", "at"})
    tiled_prov = worker.provenance("ocr", forced=False, tiled=True)
    check("tiling is recorded in options", tiled_prov["options"]["tiled"] is True)
    check("and named in the engine string", "tiles" in tiled_prov["engine"])
    check("a normal conversion is not marked tiled", ocr["options"]["tiled"] is False)

    # 2026-08-02: 2,039 documents converted to nothing but docling's `<!-- image -->` placeholder.
    # Every length test in ocr_worker read those as a successful conversion, because the
    # placeholder is 14 characters of markdown.
    print("textless detection — a placeholder is not text")
    check("placeholder-only markdown has no real characters",
          worker.real_chars("<!-- image -->") == 0)
    check("several placeholders and blank lines still none",
          worker.real_chars("<!-- image -->\n\n<!-- image -->\n   \n") == 0)
    check("real text counts", worker.real_chars("<!-- image -->\nToba Inlet\n") == 9)
    # THE bug this replaced: len() on a placeholder-only file is 14, so it passes any threshold
    # below that and the document is filed as converted.
    check("len() cannot see the difference and real_chars can",
          len("<!-- image -->") == 14 and worker.real_chars("<!-- image -->") < worker.TEXTLESS_CHARS)
    check("a real page is above the threshold",
          worker.real_chars("Proposed Powerhouse Site. Scale 1:120,000. See Figure 2.") >= worker.TEXTLESS_CHARS)

    print("tiling — the render stays in the pool, and the seam does not duplicate text")
    tmp = Path(tempfile.mkdtemp(prefix="poolfix-tile-"))
    real_forced, real_pool = worker.convert_forced, worker._pool
    G = worker.TILE_GRID
    try:
        from PIL import Image

        # tile_job is exercised on REAL files, not through a stand-in. It is the half that touches
        # pdfium, and a fixture standing in for it is exactly how a parent-process render shipped
        # and failed 552 documents.
        a, b = tmp / "a", tmp / "b"
        a.mkdir(); b.mkdir()
        png = tmp / "sheet.png"
        Image.new("RGB", (900, 900), "white").save(png)
        tiles, truncated = worker.tile_job(str(png), "png", str(a), G, 0.06, 6, 60_000_000, 20)
        check("an image is cut into a full grid of tiles", len(tiles) == G ** 2)
        check("and every tile is written to disk", all(Path(t).exists() for t in tiles))
        check("a single-page image is never truncated", truncated is False)
        with Image.open(tiles[0]) as t0:
            check("tiles overlap rather than abut", t0.size[0] > 900 // G)

        # The page bound is the cost control: TILE_GRID^2 OCR passes PER PAGE.
        pdf = tmp / "many.pdf"
        pg = Image.new("RGB", (600, 600), "white")
        pg.save(pdf, save_all=True, append_images=[pg] * (worker.TILE_MAX_PAGES + 4))
        tiles, truncated = worker.tile_job(str(pdf), "pdf", str(b), G, 0.06, 6, 60_000_000,
                                           worker.TILE_MAX_PAGES)
        check("a long PDF stops at TILE_MAX_PAGES", len(tiles) == worker.TILE_MAX_PAGES * G ** 2)
        check("and reports the truncation instead of hiding it", truncated is True)

        # THE REGRESSION CHECK. Opening the PDF in the parent corrupts pdfium's global state, which
        # docling's converter threads share: 552 of 623 documents failed with "PDFium: Data format
        # error" on 2026-08-02 because convert_tiled rendered inline. The fix IS the pool submit,
        # so that is the thing asserted — not the output, which looked fine either way.
        submitted = []

        class FakePool:
            def submit(self, fn, *args, **kwargs):
                submitted.append(fn)
                class Fut:
                    def result(self_):
                        return ([str(png)] * (G ** 2), False)
                return Fut()

        worker._pool = FakePool()
        # Every tile returns the SAME two lines, which is what the overlap really produces. If the
        # join does not dedupe, this comes back G^2 times over.
        worker.convert_forced = lambda p: "<!-- image -->\nToba Inlet\nScale 1:120,000\n"
        md = worker.convert_tiled(tmp / "x.pdf", "pdf", "t1")
        check("the render is submitted to the pool, never run in the parent",
              submitted == [worker.tile_job])
        check("the placeholder never survives into tiled output", "<!-- image -->" not in md)
        check("text from the tiles is kept", "Toba Inlet" in md and "Scale 1:120,000" in md)
        check("duplicate lines across tiles are dropped once", md.count("Toba Inlet") == 1)

        calls = []
        worker.convert_forced = lambda p: (calls.append(p), "line %d" % len(calls))[1]
        worker.convert_tiled(tmp / "x.pdf", "pdf", "t2")
        check("one OCR pass per tile the job returned", len(calls) == G ** 2)
    finally:
        worker.convert_forced, worker._pool = real_forced, real_pool
        shutil.rmtree(tmp, ignore_errors=True)

    print("\nall checks passed")


# Guard is mandatory, not style: the pool uses "spawn", so every child re-imports this
# module as __main__. Without it the whole test body re-runs inside each worker.
if __name__ == "__main__":
    main()
