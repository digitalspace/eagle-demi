#!/usr/bin/env python3
"""One Azure Container Apps job execution: one message off the extract queue, one document.

Settings are listed in README.md.
"""

import functools
import json
import logging
import os
import sys
import tempfile
from pathlib import Path

import extract_core as core

log = logging.getLogger("extraction-job")

# Longer than replicaTimeout (7200 s), so a running conversion never sees its message reappear.
VISIBILITY_SECONDS = int(os.environ.get("EXTRACTION_VISIBILITY_SECONDS", "7800"))
POISON_AT = 3


def convert(path, ext, pool, converter, doc_id):
    """Route and convert like the host: (markdown, route, forced, tiled). A runner fault raises."""
    which, md, rerouted = "ocr", None, None
    if not core.ocr_only(ext):
        try:
            which, md, info = pool.submit(core.pdfium_job, str(path), ext).result()
        except Exception as e:                                    # noqa: BLE001
            # The crash broke this pool, so OCR runs on a new one, as the host's ensure_pool() does.
            log.warning("pdfium worker died on %s: %s, routing to OCR on a new pool", doc_id, e)
            with core.new_pool(1) as fresh:
                md, forced, tiled = core.convert_ocr(converter(), path, ext, fresh, doc_id)
            return md, "ocr", forced, tiled
        if info.get("note"):
            log.info("%s: %s, routing to OCR", doc_id, info["note"])
        if which == "text" and core.is_low_yield_text(md, path.stat().st_size, ext):
            log.info("low yield %s, re-routing to OCR", doc_id)
            which, rerouted = "ocr", md
    if which == "text":
        return md, "text", False, False
    conv = converter()
    try:
        md, forced, tiled = core.convert_ocr(conv, path, ext, pool, doc_id)
    except Exception as e:                                        # noqa: BLE001
        if core.is_runner_fault(e) or not core.text_beats_ocr(rerouted, None):
            raise
        log.warning("OCR failed on %s after a re-route, keeping the text result: %s", doc_id, e)
        return rerouted, "text", False, False
    if core.text_beats_ocr(rerouted, md):
        log.info("OCR found less on %s, keeping the text result", doc_id)
        return rerouted, "text", False, False
    return md, "ocr", forced, tiled


def post_error(doc_id, reason):
    log.warning("extraction error %s: %s", doc_id, reason[:300])
    return settle(doc_id, core.post_chunks(doc_id, core.error_body(reason)), "failed")


def settle(doc_id, r, outcome):
    if r.status_code >= 400:
        # Terminal for this document (deleted, too large, malformed); a retry cannot change it.
        log.error("chunks post refused %s: HTTP %s %s", doc_id, r.status_code, r.text[:200])
        return "refused"
    return outcome


def handle(doc_id, pool, converter):
    """Extract one document. Returns the outcome; a runner fault raises and leaves the message."""
    r = core.api_get(f"/documents/{doc_id}")
    if r.status_code == 404:
        log.info("skip %s: no such document", doc_id)
        return "gone"
    r.raise_for_status()
    row = r.json()
    rows = core.worklist_rows([row])
    if row.get("contentExtracted") is True or row.get("documentSource") == "UPDATE" or not rows:
        log.info("skip %s: extracted, deleted or an Update image", doc_id)
        return "skipped"
    doc = rows[0]
    if doc["ext"] in core.UNSUPPORTED_EXTS:
        return post_error(doc_id, f"unsupported format: {doc['ext']}")

    with tempfile.TemporaryDirectory(prefix="extract-") as td:
        try:
            path = core.download(doc, Path(td))
        except core.SourceMissing as e:
            # Nothing posted: the backlog sweep queues it again once the file can exist.
            log.warning("source missing %s: %s", doc_id, e)
            return "missing"
        except Exception as e:                                    # noqa: BLE001
            return post_error(doc_id, f"download failed: {e}")
        try:
            md, route, forced, tiled = convert(path, doc["ext"], pool, converter, doc_id)
        except Exception as e:                                    # noqa: BLE001
            if core.is_runner_fault(e):
                raise
            return post_error(doc_id, f"docling failed: {e}")
    log.info("%s %s: %d chars%s%s", route, doc_id, len(md),
             ", forced OCR" if forced else "", ", tiled" if tiled else "")
    return settle(doc_id, core.post_markdown(doc_id, md, core.provenance(route, forced, tiled)), "ok")


def run_once(queue, poison, pool, converter):
    """Take one message and settle it. Returns the outcome, "empty" when the queue had none."""
    msg = queue.receive_message(visibility_timeout=VISIBILITY_SECONDS)
    if msg is None:
        log.info("queue empty")
        return "empty"
    try:
        doc_id = json.loads(msg.content)["documentId"]
    except (ValueError, KeyError, TypeError):
        doc_id = None
    if doc_id is None or msg.dequeue_count >= POISON_AT:
        poison.send_message(msg.content)
        queue.delete_message(msg)
        log.error("[extraction] poison %s after %d dequeues", doc_id or msg.content[:200],
                  msg.dequeue_count)
        return "poison"
    outcome = handle(doc_id, pool, converter)
    queue.delete_message(msg)
    log.info("settled %s: %s", doc_id, outcome)
    return outcome


def queues_from_env():
    from azure.identity import ManagedIdentityCredential
    from azure.storage.queue import QueueClient

    url = f"https://{os.environ['EXTRACTION_QUEUE_ACCOUNT']}.queue.core.windows.net"
    name = os.environ.get("EXTRACTION_QUEUE", "extract")
    poison = os.environ.get("EXTRACTION_POISON_QUEUE", f"{name}-poison")
    credential = ManagedIdentityCredential(client_id=os.environ.get("AZURE_CLIENT_ID"))
    return (QueueClient(url, name, credential=credential),
            QueueClient(url, poison, credential=credential))


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING"):
        # The poison alert reads AppTraces, so job logs must reach App Insights, not only stdout.
        from azure.monitor.opentelemetry import configure_azure_monitor
        configure_azure_monitor(logger_name=log.name)
    missing = [n for n in ("DEMI_API", "DEMI_ADMIN_KEY", "EXTRACTION_QUEUE_ACCOUNT") if not os.environ.get(n)]
    if missing:
        log.error("not set: %s", ", ".join(missing))
        return 2
    core.set_key(os.environ["DEMI_ADMIN_KEY"])
    queue, poison = queues_from_env()
    pool = core.new_pool(1)
    try:
        run_once(queue, poison, pool, functools.cache(core.build_converter))
    except Exception as e:                                        # noqa: BLE001
        # The message stays; it reappears after the visibility timeout and poisons at POISON_AT.
        log.error("runner fault: %s", e, exc_info=True)
        return 1
    finally:
        pool.shutdown(wait=True)
    return 0


# Required: the pool spawns, and each child re-imports this module as __mp_main__.
if __name__ == "__main__":
    sys.exit(main())
