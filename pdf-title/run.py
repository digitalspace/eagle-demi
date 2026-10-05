#!/usr/bin/env python3
"""One pass over DEMI's PDF title work list: write each title into the stored PDF, or take it out.

Holds no storage credential. For each row it leases the document from the DEMI API, reads the
frozen backup through the GET link it is given, builds the new bytes, commits their length and
hashes, writes them with one PUT through the link and headers the commit returns, then reports
once the PUT link is dead (the API holds every report until then). The API checks the store and
decides the outcome. Rows waiting to report hold no worker. The work list is the resume point, so a stopped
run just runs again.

Dry run is the default: it lists the rows and writes nothing. `--live` writes.

    python3 pdf-title/run.py [--live] [--max-rows N] [--max-minutes M] [--timeout S] [--concurrency N]

A live run first pages the API's sweep, which settles expired leases.

Environment:
    DEMI_API_URL   the API base that `/documents` hangs off, e.g. https://<host>/api
    DEMI_API_KEY   DEMI key with the write role, sent as X-Api-Key to the API only
"""

import argparse
import base64
import hashlib
import heapq
import http.client
import itertools
import json
import logging
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime

import titler
from restore import Refused, restore

log = logging.getLogger("pdf-title")

# 503 covers the object store's SlowDown.
RETRY_STATUS = {429, 500, 502, 503, 504}
# A POST that timed out may have landed; a retry would only meet the lease it already took.
POST_RETRY_STATUS = {429, 503}
ATTEMPTS = 4
PAGE_LIMIT = 500
SWEEP_LIMIT = 20
# The API keeps a lease open this long past `putExpiresAt`, for clock skew.
PUT_SKEW_SECONDS = 30
# Our clock may run behind the API's; a report a little late costs nothing, an early one a 409.
CLOCK_MARGIN_SECONDS = 5
# `tail-refused`: the API undid our own titler's output, so the two disagree on what is allowed.
FAILED = {"error", "needs-review", "tail-refused", "sweep-failed", "sweep-needs-review"}


class Failed(Exception):
    """A request failed. The message is logged and reported, so it never holds a URL or the key."""


class Released(Exception):
    """The API refused the commit and released the lease itself, so there is nothing to report."""


class Skipped(Exception):
    """This file will not be written. The message is the reason recorded on the row."""


@dataclass
class Response:
    status: int
    body: bytes = b""

    def json(self):
        return json.loads(self.body or b"null")

    def reason(self):
        try:
            return (self.json() or {}).get("reason") or ""
        except (ValueError, AttributeError):
            return ""


def urllib_send(method, url, headers, body, timeout):
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as r:
            return Response(r.status, r.read())
    except urllib.error.HTTPError as err:
        return Response(err.code, err.read())


class Client:
    def __init__(self, api, key, timeout=60, send=None):
        self.api_url = api.rstrip("/")
        self.key = key
        self.timeout = timeout
        self.send = send or urllib_send

    def _send(self, method, url, label, headers, body):
        retry = POST_RETRY_STATUS if method == "POST" else RETRY_STATUS
        last = None
        for attempt in range(ATTEMPTS):
            try:
                r = self.send(method, url, headers, body, self.timeout)
                if r.status not in retry:
                    return r
                last = f"HTTP {r.status}"
            except (OSError, http.client.HTTPException) as exc:
                last = type(exc).__name__
                if method == "POST":
                    break
            if attempt + 1 < ATTEMPTS:
                delay = min(2 ** attempt, 30) + random.uniform(0, 1)
                log.warning("retry %s in %.0fs (%s)", label, delay, last)
                time.sleep(delay)
        raise Failed(f"{label}: {last}")

    def api(self, method, path, query=None, payload=None):
        url = self.api_url + path + (f"?{urllib.parse.urlencode(query)}" if query else "")
        headers = {"X-Api-Key": self.key, "Accept": "application/json"}
        body = None
        if payload is not None:
            body = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        return self._send(method, url, f"{method} {path}", headers, body)

    def download(self, url):
        r = self._send("GET", url, "download", {}, None)
        if r.status != 200:
            raise Failed(f"download: HTTP {r.status}")
        return r.body

    def upload(self, url, headers, data):
        # Exactly the commit's headers: Content-MD5 is signed into the link and If-Match guards the key.
        r = self._send("PUT", url, "upload", dict(headers), data)
        if not 200 <= r.status < 300:
            raise Failed(f"upload: HTTP {r.status}")

    def pending(self, max_rows):
        rows, token = [], None
        while len(rows) < max_rows:
            query = {"limit": PAGE_LIMIT, **({"continuation": token} if token else {})}
            r = self.api("GET", "/documents/pdf-title/pending", query)
            if r.status != 200:
                raise Failed(f"work list: HTTP {r.status} {r.reason()}".strip())
            page = r.json()
            rows.extend(page["items"])
            token = page.get("continuation")
            if not token:
                break
        return rows[:max_rows]

    def sweep(self):
        """Settle every expired lease, page by page. Returns outcome totals plus `failed`."""
        totals, token, before = Counter(), None, None
        while True:
            # Every page after the first names the first page's cutoff, so all pages read one query.
            query = {"limit": SWEEP_LIMIT, **({"continuation": token, "before": before} if token else {})}
            r = self.api("POST", "/documents/pdf-title/sweep", query, {})
            if r.status != 200:
                raise Failed(f"sweep: HTTP {r.status} {r.reason()}".strip())
            page = r.json()
            totals.update({k: v for k, v in page.get("outcomes", {}).items() if v})
            totals["scanned"] += page.get("scanned", 0)
            totals["failed"] += len(page.get("failed") or [])
            token, before = page.get("continuation"), page.get("before")
            if not token:
                return totals


def _new_bytes(lease, backup):
    """The bytes to write and any extra commit fields, or raise Skipped."""
    if len(backup) != lease["sourceSize"]:
        raise Skipped(f"backup is {len(backup)} bytes, lease says {lease['sourceSize']}")
    original_length, original_sha256 = lease.get("originalLength"), lease.get("originalSha256")
    base = backup
    if original_length is not None or lease["mode"] == "restore":
        # A re-title is rebuilt from the original prefix, so the file stays original plus one update.
        try:
            base = restore(backup, original_length, original_sha256)
        except Refused as refused:
            raise Skipped(f"prefix-mismatch: {refused}") from None
    if lease["mode"] == "restore":
        return base, {}
    result = titler.set_title(base, lease["title"])
    if result.status != "ready":
        raise Skipped(result.reason)
    growth, cap = len(result.data) - len(base), lease.get("maxGrowth")
    if cap is not None and growth > cap:
        raise Skipped(f"increment-too-large: {growth} bytes, cap {cap}")
    if original_length is not None:
        return result.data, {}
    return result.data, {"originalLength": result.source_length, "originalSha256": result.source_sha256}


def _write(client, path, query, lease):
    """Build, commit and PUT. Returns (report due time, PUT failure or None); raises before commit."""
    data, extra = _new_bytes(lease, client.download(lease["backupUrl"]))
    r = client.api("POST", f"{path}/commit", query, {
        "leaseId": lease["leaseId"],
        "newLength": len(data),
        "newSha256": hashlib.sha256(data).hexdigest(),
        "newMd5": base64.b64encode(hashlib.md5(data).digest()).decode(),
        **extra,
    })
    if r.status == 409 and r.reason() != "lease-too-short":
        raise Released(f"commit: HTTP 409 {r.reason()}".strip())
    if r.status != 200:
        raise Failed(f"commit: HTTP {r.status} {r.reason()}".strip())
    signed = r.json()
    expires = _epoch(signed.get("putExpiresAt")) or time.time() + signed.get("expiresIn", 120)
    due = expires + PUT_SKEW_SECONDS + CLOCK_MARGIN_SECONDS
    try:
        client.upload(signed["uploadUrl"], signed["headers"], data)
    except Failed as exc:
        return due, str(exc)
    return due, None


def log_row(doc_id, mode, result, reason=None):
    log.info("id=%s mode=%s result=%s reason=%s", doc_id, mode, result, reason or "-")
    return result


def _epoch(iso):
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except (AttributeError, TypeError, ValueError):
        return None


@dataclass
class Waiting:
    """A leased row whose report is held until `due`: the API answers 409 while its PUT link lives."""
    doc_id: str
    mode: str
    path: str
    query: dict
    report: dict
    failure: str
    due: float
    rescheduled: bool = False

    def line(self, result, *parts):
        return log_row(self.doc_id, self.mode, result, "; ".join(filter(None, [self.failure, *parts])))


def start(client, row, want=None):
    """Lease and write one row. Returns a result, or a Waiting to report later. Never raises."""
    doc_id, mode = row["id"], row.get("mode")
    path = f"/documents/{urllib.parse.quote(str(doc_id), safe='')}/pdf-title"
    query = {"project": row["projectId"]} if row.get("projectId") is not None else {}
    try:
        r = client.api("POST", f"{path}/lease", {**query, **({"mode": want} if want else {})}, {})
    except Failed as exc:
        return log_row(doc_id, mode, "error", str(exc))
    if r.status != 201:
        return log_row(doc_id, mode, "refused", f"lease: HTTP {r.status} {r.reason()}".strip())
    try:
        lease = r.json()
        mode, lease_id = lease["mode"], lease["leaseId"]
    except (ValueError, KeyError, TypeError) as exc:
        return log_row(doc_id, mode, "error", f"lease: unreadable answer ({type(exc).__name__})")

    report, failure, due = {"leaseId": lease_id}, None, time.time()
    try:
        if want and mode != want:
            raise Failed(f"lease came back in {mode} mode, wanted {want}")
        due, failure = _write(client, path, query, lease)
    except Skipped as skip:
        report = {"leaseId": lease_id, "skipped": True, "reason": str(skip)[:200]}
    except Released as exc:
        return log_row(doc_id, mode, "refused", str(exc))
    except Exception as exc:
        # The plain report has no skip flag: a passing failure must not mark the file skipped.
        failure = str(exc) if isinstance(exc, Failed) else f"{type(exc).__name__}: {exc}"
    return Waiting(doc_id, mode, path, query, report, failure, due)


def finish(client, waiting):
    """Report a row. Returns its result, or the Waiting once more if the API still holds the PUT window."""
    try:
        r = client.api("PUT", waiting.path, waiting.query, waiting.report)
    except Failed as exc:
        return waiting.line("error", f"{exc}, the sweep settles it")
    if r.status == 409 and r.reason() == "put-window-open":
        expires = _epoch((r.json() or {}).get("putExpiresAt"))
        if waiting.rescheduled or expires is None:
            return waiting.line("pending", "PUT window still open; the sweep settles it")
        waiting.due, waiting.rescheduled = expires + PUT_SKEW_SECONDS + CLOCK_MARGIN_SECONDS, True
        return waiting
    if r.status != 200:
        return waiting.line("error", f"report: HTTP {r.status} {r.reason()}".strip())
    try:
        settled = r.json() or {}
    except ValueError:
        settled = {}
    outcome, reason = settled.get("outcome"), settled.get("reason") or waiting.report.get("reason")
    if outcome == "skipped" and str(reason or "").startswith("tail-"):
        return waiting.line("tail-refused", f"{reason}; the API undid the write")
    if waiting.failure:
        return waiting.line("error", f"lease {outcome}")
    return waiting.line(outcome, reason)


def _past(due, deadline):
    return deadline is not None and due > deadline


def process(client, row, want=None, deadline=None):
    """Lease, write, wait out the PUT window and report one row. Never raises."""
    result = start(client, row, want)
    while isinstance(result, Waiting):
        if _past(result.due, deadline):
            return result.line("pending", "run time bound reached inside the PUT window; the sweep settles it")
        time.sleep(max(0.0, result.due - time.time()))
        result = finish(client, result)
    return result


def _sweep(client):
    """Settle expired leases before taking work. Returns the run outcomes the sweep adds."""
    try:
        totals = client.sweep()
    except Failed as exc:
        log.error("%s", exc)
        return Counter({"sweep-failed": 1})
    log.info("sweep: %s", " ".join(f"{k}={v}" for k, v in sorted(totals.items())) or "nothing expired")
    return Counter({"sweep-failed": totals["failed"], "sweep-needs-review": totals["needs-review"]})


def _drive(client, rows, concurrency, deadline):
    """Run rows `concurrency` at a time. A row waiting out its PUT window holds no worker."""
    outcomes, held, order = Counter(), [], itertools.count()
    rows = iter(rows)
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        # At most `concurrency` rows start at once, so a report that is due never queues behind them.
        running, starting = set(), set()
        while True:
            while held and held[0][0] <= time.time():
                running.add(pool.submit(finish, client, heapq.heappop(held)[2]))
            starting &= running
            while len(starting) < concurrency:
                if deadline is not None and time.time() >= deadline:
                    left = sum(1 for _ in rows)
                    if left:
                        log.info("run time bound reached; %d rows left on the work list", left)
                        outcomes["deferred"] += left
                    break
                row = next(rows, None)
                if row is None:
                    break
                future = pool.submit(start, client, row)
                running.add(future)
                starting.add(future)
            if not running and not held:
                return outcomes
            if not running:
                time.sleep(max(0.0, held[0][0] - time.time()))
                continue
            timeout = max(0.0, held[0][0] - time.time()) if held else None
            done, running = wait(running, timeout=timeout, return_when=FIRST_COMPLETED)
            for future in done:
                result = future.result()
                if not isinstance(result, Waiting):
                    outcomes[result] += 1
                elif _past(result.due, deadline):
                    outcomes[result.line("pending", "run time bound reached inside the PUT window; "
                                                    "the sweep settles it")] += 1
                else:
                    heapq.heappush(held, (result.due, next(order), result))


def run(client, max_rows, live=False, concurrency=4, deadline=None):
    # The sweep writes (it settles leases), so a dry run never calls it.
    outcomes = _sweep(client) if live else Counter()
    rows = client.pending(max_rows)
    log.info("work list: %d rows%s", len(rows), "" if live else " (dry run, nothing written)")
    if not live:
        return Counter(log_row(row["id"], row["mode"], "dry-run", f"would {row['mode']}") for row in rows)
    outcomes = outcomes + _drive(client, rows, concurrency, deadline)
    log.info("done: %s", " ".join(f"{k}={v}" for k, v in sorted(outcomes.items())))
    return outcomes


def configure_logging():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def client_from_env(timeout):
    """A Client from DEMI_API_URL and DEMI_API_KEY, or None after logging what is missing."""
    missing = [name for name in ("DEMI_API_URL", "DEMI_API_KEY") if not os.environ.get(name)]
    if missing:
        log.error("not set: %s", ", ".join(missing))
        return None
    return Client(os.environ["DEMI_API_URL"], os.environ["DEMI_API_KEY"], timeout=timeout)


def positive_int(text):
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError("must be 1 or more")
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description="Write PDF titles from DEMI's work list.")
    parser.add_argument("--live", action="store_true", help="write; without it, list and write nothing")
    parser.add_argument("--max-rows", type=positive_int, default=20, help="rows taken from the work list (default 20)")
    parser.add_argument("--timeout", type=positive_int, default=60, help="seconds per request (default 60)")
    parser.add_argument("--concurrency", type=positive_int, default=4, help="documents in flight (default 4)")
    parser.add_argument("--max-minutes", type=positive_int, default=30,
                        help="no new row starts after this; rows left stay on the work list (default 30)")
    args = parser.parse_args(argv)
    configure_logging()
    client = client_from_env(args.timeout)
    if client is None:
        return 2
    try:
        outcomes = run(client, args.max_rows, live=args.live, concurrency=args.concurrency,
                       deadline=time.time() + args.max_minutes * 60)
    except Failed as exc:
        log.error("%s", exc)
        return 1
    # Non-zero so a scheduler surfaces failures; the rows stay on the work list for the next pass.
    return 1 if any(outcomes[name] for name in FAILED) else 0


if __name__ == "__main__":
    sys.exit(main())
