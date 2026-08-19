"""Queue-triggered wrapper around `extract.py`.

One message is one document id. The extraction logic lives in `extract.py` and is unchanged by
running here — this file is the trigger and nothing else, so the same code path is exercised by
`test_extract.py`, by a manual `python3 extract.py --document-id`, and in production.

RETRIES AND THE POISON QUEUE. The Functions runtime retries a message that raises, and after
`maxDequeueCount` attempts moves it to `extract-poison`. That is the behaviour worth having for a
failure that might be transient — eagle-api down, the ingest endpoint restarting — so those raise.

A document that produced no text does NOT raise:

  - `skip`       — the file is not publicly downloadable, so there is nothing to fetch.
  - `ocr-empty`  — OCR ran over every page and recognised nothing. This is the residue DEMI's
                   tiled re-OCR exists for; it is a countable outcome, not a failure.

Retrying either five times and then parking it in a poison queue would turn a known, expected
outcome into a false alarm, and would bury the real failures underneath it. They are logged and the
message is consumed.

TWO THINGS IN host.json THAT ARE NOT OPTIONAL, and neither fails loudly:

  - `extensionBundle`. Without it the host starts, reports "1 functions loaded", and then logs
    `The binding type(s) 'queueTrigger' are not registered` — the app runs and the queue never
    drains. Python function apps carry no compiled binding extensions of their own.
  - `messageEncoding: "none"`. Bundle v4 defaults queue messages to base64. A Mongo ObjectId is 24
    hex characters, which is both valid base64 and a multiple of four, so a plain-text id does not
    fail to decode — it decodes to 18 bytes of garbage and the document is "not found". The worker
    and any hand-drained backlog both enqueue plain ids, so the encoding is turned off rather than
    every producer taught to encode.
"""

import json
import logging
import os
import sys
from pathlib import Path

import azure.functions as func

sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract  # noqa: E402

app = func.FunctionApp()

QUEUE = os.environ.get("EXTRACT_QUEUE", "extract")


@app.function_name(name="extract_document")
@app.queue_trigger(arg_name="msg", queue_name=QUEUE, connection="AzureWebJobsStorage")
def extract_document(msg: func.QueueMessage) -> None:
    body = msg.get_body().decode("utf-8").strip()

    # Accept a bare id or `{"documentId": "..."}`. The worker sends the object form; a human
    # draining a backlog by hand sends ids, and rejecting those would be pedantry.
    try:
        document_id = json.loads(body).get("documentId") if body.startswith("{") else body
    except json.JSONDecodeError:
        document_id = body

    if not document_id:
        logging.error("empty message, dropping: %r", body[:200])
        return

    row = extract.extract_one(document_id)
    logging.info("extract %s", json.dumps(row))
    # ...and again somewhere that survives. See `extract.post_outcome`: this log line is lost on
    # short invocations, which are precisely the ones with no chunks to corroborate them.
    extract.post_outcome(row)

    # `route` is None only if extract_one returned before deciding, which means it raised somewhere
    # it should not have. Surface it rather than consuming the message.
    if row.get("route") is None:
        raise RuntimeError(f"extraction produced no route for {document_id}: {row}")
