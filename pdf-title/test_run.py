"""The runner against an in-process stand-in for the DEMI lease API and the object store; no network."""

import base64
import hashlib
import http.server
import json
import logging
import threading
import time
import types
import urllib.parse
import uuid
from datetime import datetime, timezone

import pytest

import restore as restore_cli
import run
from test_titler import TITLE, _pdf, _reopen
from titler import set_title

API = "https://demi.test/api"
STORE = "https://store.test/bucket/"
KEY = "test-key-not-a-real-credential"
CONTENT_TYPE = "application/octet-stream"


def _md5(data):
    return hashlib.md5(data).hexdigest()


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace("+00:00", "Z")


class World:
    """Fake DEMI API plus fake store. Follows the lease contract closely enough to judge the runner.

    `faults[label]` is a list consumed one per request before normal handling: a `run.Response` is
    returned as is, an exception is raised. Labels: pending, sweep, lease, commit, report, download,
    upload. `now` is the clock both sides read; the runner's `time` is patched to it.
    """

    def __init__(self):
        self.objects = {}
        self.docs = {}
        self.leases = {}
        self.links = {}
        self.faults = {}
        self.sent = []
        self.page_size = 500
        self.max_growth = 262144
        self.sweep_pages = [{"scanned": 0, "outcomes": {}, "failed": []}]
        self.now = time.time()
        self.lock = threading.Lock()

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.now += max(0.0, seconds)

    def add(self, doc_id, data, mode="title", title=TITLE, original=None, sealed=False):
        key = f"proj/{doc_id}.pdf"
        self.objects[key] = data
        self.docs[doc_id] = {"key": key, "mode": mode, "title": title, "original": original, "status": None,
                             "titled": original is not None, "sealed": sealed}
        return key

    def stored(self, doc_id):
        return self.objects[self.docs[doc_id]["key"]]

    def calls(self, label):
        return [s for s in self.sent if s["label"] == label]

    def __call__(self, method, url, headers, body, timeout):
        with self.lock:
            label = self._label(method, url)
            self.sent.append({"label": label, "method": method, "url": url, "headers": dict(headers),
                              "body": body, "timeout": timeout, "at": self.now})
            queue = self.faults.get(label)
            if queue:
                fault = queue.pop(0)
                if isinstance(fault, Exception):
                    raise fault
                return fault
            if url.startswith(STORE):
                return self._store(method, url, headers, body)
            parts = urllib.parse.urlsplit(url)
            query = {k: v[0] for k, v in urllib.parse.parse_qs(parts.query).items()}
            if label in ("pending", "sweep"):
                return getattr(self, f"_{label}")(query)
            doc_id = urllib.parse.unquote(parts.path.split("/")[-3 if label != "report" else -2])
            return getattr(self, f"_{label}")(doc_id, json.loads(body) if body else None, query, headers.get("X-Api-Key"))

    @staticmethod
    def _label(method, url):
        if url.startswith(STORE):
            return "download" if method == "GET" else "upload"
        path = urllib.parse.urlsplit(url).path
        for label in ("pending", "sweep", "lease", "commit"):
            if path.endswith(f"/{label}"):
                return label
        return "report"

    def _link(self, method, key, seconds):
        token = uuid.uuid4().hex
        self.links[token] = (method, key, self.now + seconds)
        return f"{STORE}{key}?X-Amz-Signature={token}"

    def _store(self, method, url, headers, body):
        parts = urllib.parse.urlsplit(url)
        key = parts.path[len("/bucket/"):]
        token = urllib.parse.parse_qs(parts.query)["X-Amz-Signature"][0]
        link = self.links.get(token)
        if not link or link[:2] != (method, key) or self.now > link[2]:
            return run.Response(403)
        if method == "GET":
            return run.Response(200, self.objects[key])
        if headers.get("Content-MD5") != base64.b64encode(hashlib.md5(body).digest()).decode():
            return run.Response(400)
        if headers.get("If-Match") != f'"{_md5(self.objects[key])}"':
            return run.Response(412)
        self.objects[key] = body
        return run.Response(200)

    def _pending(self, query):
        rows = [{"id": i, "projectId": "p1", "mode": d["mode"], "title": d["title"] if d["mode"] == "title" else None}
                for i, d in self.docs.items() if d["status"] is None and i not in self.leases]
        start = int(query.get("continuation", "0"))
        end = start + self.page_size
        return run.Response(200, json.dumps({
            "items": rows[start:end], "continuation": str(end) if end < len(rows) else None}).encode())

    def _sweep(self, query):
        before = "2026-10-05T00:00:00.000Z"
        if "continuation" in query and query.get("before") != before:
            return run.Response(400, b'{"reason":"a continuation needs its before"}')
        at = int(query.get("continuation", "0"))
        page = {**self.sweep_pages[at], "before": before,
                "continuation": str(at + 1) if at + 1 < len(self.sweep_pages) else None}
        return run.Response(200, json.dumps(page).encode())

    def _lease(self, doc_id, _body, query, key):
        doc = self.docs.get(doc_id)
        if doc is None:
            return run.Response(404, b'{"reason":"not-found"}')
        if doc_id in self.leases:
            return run.Response(409, b'{"reason":"lease-held"}')
        mode = doc["mode"]
        if "mode" in query:
            if query["mode"] != "restore":
                return run.Response(400, b'{"reason":"mode must be restore"}')
            refusal = "sealed" if doc["sealed"] else "no-original" if not doc["original"] else (
                "not-titled" if not doc["titled"] else None)
            if refusal:
                return run.Response(409, json.dumps({"reason": refusal}).encode())
            mode = "restore"
        source = self.objects[doc["key"]]
        backup_key = f"pdf-title-backup/{doc['key']}"
        self.objects[backup_key] = source
        original = doc["original"] or {}
        lease = {"leaseId": uuid.uuid4().hex, "mode": mode, "title": doc["title"] if mode == "title" else None,
                 "sourceSize": len(source), "sourceMd5": _md5(source), "backupKey": backup_key,
                 "inFlight": None, "key": key}
        self.leases[doc_id] = lease
        return run.Response(201, json.dumps({
            "leaseId": lease["leaseId"], "mode": mode, "expiresAt": _iso(self.now + 600),
            "title": lease["title"], "backupUrl": self._link("GET", backup_key, 300), "backupUrlExpiresIn": 300,
            "sourceSize": len(source), "contentType": CONTENT_TYPE, "maxGrowth": self.max_growth,
            "originalLength": original.get("length"), "originalSha256": original.get("sha256")}).encode())

    def _held(self, doc_id, body, key):
        lease = self.leases.get(doc_id)
        return lease if lease and lease["leaseId"] == body["leaseId"] and lease["key"] == key else None

    def _commit(self, doc_id, body, _query, key):
        doc, lease = self.docs[doc_id], self._held(doc_id, body, key)
        if not lease:
            return run.Response(409, b'{"reason":"no-lease"}')
        if _md5(self.objects[doc["key"]]) != lease["sourceMd5"]:
            self._end(doc_id)
            return run.Response(409, b'{"reason":"source-changed"}')
        if doc["original"] is None:
            backup = self.objects[lease["backupKey"]]
            if body.get("originalLength") != len(backup) or body.get("originalSha256") != _sha(backup):
                self._end(doc_id)
                return run.Response(409, b'{"reason":"original-mismatch"}')
            doc["original"] = {"length": len(backup), "sha256": _sha(backup)}
        if lease["mode"] == "restore" and (body["newLength"], body["newSha256"]) != (
                doc["original"]["length"], doc["original"]["sha256"]):
            return run.Response(400, b'{"reason":"a restore must write the recorded original"}')
        lease["inFlight"] = {**body, "putExpiresAt": self.now + 120}
        return run.Response(200, json.dumps({
            "uploadUrl": self._link("PUT", doc["key"], 120), "expiresIn": 120,
            "putExpiresAt": _iso(self.now + 120),
            "headers": {"Content-Type": CONTENT_TYPE, "Content-MD5": body["newMd5"],
                        "If-Match": f'"{lease["sourceMd5"]}"'}}).encode())

    def _report(self, doc_id, body, _query, key):
        doc, lease = self.docs[doc_id], self._held(doc_id, body, key)
        if not lease:
            return run.Response(409, b'{"reason":"no-lease"}')
        stored, in_flight = self.objects[doc["key"]], lease["inFlight"]
        if in_flight and self.now < in_flight["putExpiresAt"] + 30:
            return run.Response(409, json.dumps({"reason": "put-window-open",
                                                 "putExpiresAt": _iso(in_flight["putExpiresAt"])}).encode())
        if in_flight and _sha(stored) == in_flight["newSha256"] and _sha(stored[:doc["original"]["length"]]) == doc["original"]["sha256"]:
            outcome = "restored" if lease["mode"] == "restore" else "titled"
        elif _md5(stored) == lease["sourceMd5"]:
            outcome = "skipped" if body.get("skipped") else "released"
        else:
            self.objects[doc["key"]] = self.objects[lease["backupKey"]]
            outcome = "needs-review"
        doc["status"] = outcome if outcome != "released" else None
        self._end(doc_id)
        return run.Response(200, json.dumps({"outcome": outcome, "status": doc["status"], "reason": body.get("reason")}).encode())

    def _end(self, doc_id):
        lease = self.leases.pop(doc_id)
        self.objects.pop(lease["backupKey"], None)


@pytest.fixture
def world(monkeypatch):
    w = World()
    monkeypatch.setattr(run, "time", types.SimpleNamespace(time=w.time, sleep=w.sleep))
    return w


def _client(world, timeout=7):
    return run.Client(API, KEY, timeout=timeout, send=world)


def _titled(original, title=TITLE):
    result = set_title(original, title)
    assert result.status == "ready"
    return result


def test_title_mode_writes_original_plus_one_update_and_reports_titled(world):
    original = _pdf()
    world.add("d1", original)

    outcomes = run.run(_client(world), max_rows=10, live=True)

    stored = world.stored("d1")
    assert outcomes == {"titled": 1}
    assert stored.startswith(original) and len(stored) > len(original)
    assert _reopen(stored).metadata.title == TITLE
    commit = json.loads(world.calls("commit")[0]["body"])
    assert (commit["originalLength"], commit["originalSha256"]) == (len(original), _sha(original))
    assert (commit["newLength"], commit["newSha256"]) == (len(stored), _sha(stored))
    upload = world.calls("upload")[0]["headers"]
    assert upload == {"Content-Type": CONTENT_TYPE, "Content-MD5": commit["newMd5"],
                      "If-Match": f'"{_md5(original)}"'}
    assert json.loads(world.calls("report")[0]["body"]) == {"leaseId": commit["leaseId"]}
    assert not any(k.startswith("pdf-title-backup/") for k in world.objects)


def test_retitle_is_rebuilt_from_the_original_prefix_not_stacked(world):
    original = _pdf()
    first = _titled(original, "Old name")
    world.add("d1", first.data, title="New name",
              original={"length": len(original), "sha256": _sha(original)})

    run.run(_client(world), max_rows=10, live=True)

    stored = world.stored("d1")
    assert stored == _titled(original, "New name").data
    assert "originalLength" not in json.loads(world.calls("commit")[0]["body"])


def test_restore_mode_writes_back_the_exact_original(world):
    original = _pdf()
    world.add("d1", _titled(original).data, mode="restore",
              original={"length": len(original), "sha256": _sha(original)})

    outcomes = run.run(_client(world), max_rows=10, live=True)

    assert outcomes == {"restored": 1}
    assert world.stored("d1") == original
    commit = json.loads(world.calls("commit")[0]["body"])
    assert (commit["newLength"], commit["newSha256"]) == (len(original), _sha(original))


def test_titler_skip_is_reported_with_its_reason_and_nothing_is_written(world):
    encrypted = _pdf(encrypt="AES-256")
    world.add("d1", encrypted)

    outcomes = run.run(_client(world), max_rows=10, live=True)

    assert outcomes == {"skipped": 1}
    assert json.loads(world.calls("report")[0]["body"])["reason"] == "encrypted"
    assert world.calls("commit") == [] and world.calls("upload") == []
    assert world.stored("d1") == encrypted


def test_wrong_recorded_hash_on_restore_is_skipped_and_nothing_is_written(world):
    original = _pdf()
    titled = _titled(original).data
    world.add("d1", titled, mode="restore", original={"length": len(original), "sha256": "0" * 64})

    outcomes = run.run(_client(world), max_rows=10, live=True)

    report = json.loads(world.calls("report")[0]["body"])
    assert outcomes == {"skipped": 1}
    assert report["skipped"] is True and report["reason"].startswith("prefix-mismatch")
    assert world.calls("commit") == []
    assert world.stored("d1") == titled


def test_refused_lease_moves_on_to_the_next_row(world):
    world.add("d1", _pdf())
    world.add("d2", _pdf())
    world.faults["lease"] = [run.Response(409, b'{"reason":"lease-held"}')]

    outcomes = run.run(_client(world), max_rows=10, live=True, concurrency=1)

    assert outcomes == {"refused": 1, "titled": 1}
    assert len(world.calls("report")) == 1


def test_unreadable_lease_answer_moves_on_to_the_next_row(world):
    world.add("d1", _pdf())
    world.add("d2", _pdf())
    world.faults["lease"] = [run.Response(201, b"<html>gateway</html>")]

    outcomes = run.run(_client(world), max_rows=10, live=True, concurrency=1)

    assert outcomes == {"error": 1, "titled": 1}


def test_412_on_put_releases_without_a_skip_and_leaves_the_original(world):
    original = _pdf()
    world.add("d1", original)
    world.add("d2", _pdf())
    world.faults["upload"] = [run.Response(412)]

    outcomes = run.run(_client(world), max_rows=10, live=True, concurrency=1)

    assert outcomes == {"error": 1, "titled": 1}
    assert world.stored("d1") == original
    assert len(world.calls("upload")) == 2  # 412 is never retried; the second is d2's
    assert json.loads(world.calls("report")[0]["body"]) == {
        "leaseId": json.loads(world.calls("commit")[0]["body"])["leaseId"], "reason": "upload: HTTP 412"}


def test_row_lines_are_logged_on_the_main_thread(world, caplog):
    caplog.set_level(logging.INFO, logger="pdf-title")
    d1_key = world.add("d1", _pdf())
    world.add("d2", _pdf())

    def send(method, url, headers, body, timeout):
        if method == "PUT" and url.startswith(f"{STORE}{d1_key}?"):
            return run.Response(412)
        return world(method, url, headers, body, timeout)

    run.run(run.Client(API, KEY, timeout=7, send=send), max_rows=10, live=True, concurrency=2)

    rows = [r for r in caplog.records if r.getMessage().startswith("id=")]
    assert sorted(r.getMessage() for r in rows) == [
        "id=d1 mode=title result=error reason=upload: HTTP 412; lease released",
        "id=d2 mode=title result=titled reason=-",
    ]
    assert {r.thread for r in rows} == {threading.main_thread().ident}


def test_row_whose_worker_raises_is_logged_and_counted_as_an_error(world, caplog, monkeypatch):
    caplog.set_level(logging.INFO, logger="pdf-title")
    world.add("d1", _pdf())

    def boom(*_):
        raise RuntimeError("boom")
    monkeypatch.setattr(run, "start", boom)

    outcomes = run.run(_client(world), max_rows=10, live=True)

    assert outcomes == {"error": 1}
    assert "id=d1 mode=title result=error reason=RuntimeError: boom" in caplog.text


def test_put_that_dies_mid_body_leaves_the_original(world):
    original = _pdf()
    world.add("d1", original)
    world.faults["upload"] = [ConnectionResetError()] * run.ATTEMPTS

    outcomes = run.run(_client(world), max_rows=10, live=True)

    assert outcomes == {"error": 1}
    assert world.stored("d1") == original
    assert world.docs["d1"]["status"] is None  # released, not marked skipped


def test_timeout_on_download_releases_the_lease_and_passes_the_timeout(world):
    original = _pdf()
    world.add("d1", original)
    world.faults["download"] = [TimeoutError()] * run.ATTEMPTS

    outcomes = run.run(_client(world, timeout=7), max_rows=10, live=True)

    assert outcomes == {"error": 1}
    assert world.calls("commit") == []
    assert world.stored("d1") == original and world.leases == {}
    assert {s["timeout"] for s in world.sent} == {7}


def test_timed_out_post_is_not_retried(world):
    world.add("d1", _pdf())
    world.faults["lease"] = [TimeoutError()]

    outcomes = run.run(_client(world), max_rows=10, live=True)

    assert outcomes == {"error": 1}
    assert len(world.calls("lease")) == 1


def test_slow_down_from_the_store_is_retried(world):
    world.add("d1", _pdf())
    world.faults["download"] = [run.Response(503)]

    outcomes = run.run(_client(world), max_rows=10, live=True)

    assert outcomes == {"titled": 1}
    assert len(world.calls("download")) == 2


def test_source_changed_at_commit_writes_nothing(world):
    original = _pdf()
    world.add("d1", original)
    world.faults["commit"] = [run.Response(409, b'{"reason":"source-changed"}')]

    outcomes = run.run(_client(world), max_rows=10, live=True)

    assert outcomes == {"refused": 1}
    assert world.calls("upload") == [] and world.calls("report") == []
    assert world.stored("d1") == original


def test_dry_run_lists_rows_and_writes_nothing(world, caplog):
    caplog.set_level(logging.INFO, logger="pdf-title")
    original = _pdf()
    world.add("d1", original)

    outcomes = run.run(_client(world), max_rows=10)

    assert outcomes == {"dry-run": 1}
    assert {s["label"] for s in world.sent} == {"pending"}
    assert world.stored("d1") == original
    assert "id=d1 mode=title result=dry-run reason=would title" in caplog.text


def test_max_rows_bounds_the_work_and_follows_continuation(world):
    for i in range(5):
        world.add(f"d{i}", _pdf())
    world.page_size = 1

    outcomes = run.run(_client(world), max_rows=2, live=True)

    assert outcomes == {"titled": 2}
    assert len(world.calls("lease")) == 2
    assert len(world.calls("pending")) == 2


def test_key_goes_only_to_the_api_and_never_into_logs(world, caplog):
    caplog.set_level(logging.DEBUG)
    world.add("d1", _pdf())
    world.add("d2", _pdf())
    world.faults["upload"] = [run.Response(412)]

    run.run(_client(world), max_rows=10, live=True, concurrency=1)

    assert KEY not in caplog.text
    assert "X-Amz-Signature" not in caplog.text and STORE not in caplog.text
    for s in world.sent:
        assert ("X-Api-Key" in s["headers"]) == (not s["url"].startswith(STORE))


def test_main_needs_the_key_and_defaults_to_dry_run(world, monkeypatch):
    monkeypatch.setattr(run, "urllib_send", world)
    monkeypatch.setenv("DEMI_API_URL", API)
    monkeypatch.delenv("DEMI_API_KEY", raising=False)
    assert run.main([]) == 2

    monkeypatch.setenv("DEMI_API_KEY", KEY)
    world.add("d1", _pdf())
    assert run.main([]) == 0
    assert {s["label"] for s in world.sent} == {"pending"}


def _labels(world):
    return [s["label"] for s in world.sent]


def test_report_waits_until_the_put_link_is_dead(world):
    world.add("d1", _pdf())

    outcomes = run.run(_client(world), max_rows=10, live=True)

    assert outcomes == {"titled": 1}
    commit_at, = [s["at"] for s in world.calls("commit")]
    reports = world.calls("report")
    assert len(reports) == 1  # never sent into the window, so no 409 round trip
    assert reports[0]["at"] >= commit_at + 120 + run.PUT_SKEW_SECONDS


def test_rows_waiting_to_report_hold_no_worker(world):
    for i in range(3):
        world.add(f"d{i}", _pdf())

    outcomes = run.run(_client(world), max_rows=10, live=True, concurrency=1)

    assert outcomes == {"titled": 3}
    labels = _labels(world)
    last_upload = max(i for i, label in enumerate(labels) if label == "upload")
    assert labels.index("report") > last_upload


def test_window_still_open_at_the_time_bound_is_pending_not_failed(world):
    original = _pdf()
    world.add("d1", original)

    outcomes = run.run(_client(world), max_rows=10, live=True, deadline=world.now + 60)

    assert outcomes == {"pending": 1}
    assert not any(outcomes[name] for name in run.FAILED)
    assert world.calls("report") == [] and "d1" in world.leases


def test_no_row_starts_after_the_time_bound(world):
    world.add("d1", _pdf())

    outcomes = run.run(_client(world), max_rows=10, live=True, deadline=world.now - 1)

    assert outcomes == {"deferred": 1}
    assert world.calls("lease") == []


def test_report_answered_put_window_open_is_sent_once_more_after_the_new_expiry(world):
    world.add("d1", _pdf())
    later = _iso(world.now + 400)
    world.faults["report"] = [run.Response(409, json.dumps({"reason": "put-window-open", "putExpiresAt": later}).encode())]

    outcomes = run.run(_client(world), max_rows=10, live=True)

    reports = world.calls("report")
    assert outcomes == {"titled": 1}
    assert len(reports) == 2 and reports[1]["at"] >= world.now - 1 >= datetime.fromisoformat(
        later.replace("Z", "+00:00")).timestamp() + run.PUT_SKEW_SECONDS


def test_window_open_twice_is_left_to_the_sweep(world):
    world.add("d1", _pdf())
    window = run.Response(409, json.dumps({"reason": "put-window-open", "putExpiresAt": _iso(world.now + 400)}).encode())
    world.faults["report"] = [window, window]

    outcomes = run.run(_client(world), max_rows=10, live=True)

    assert outcomes == {"pending": 1}


def test_tail_refusal_from_the_api_fails_the_run(world, caplog):
    caplog.set_level(logging.INFO, logger="pdf-title")
    world.add("d1", _pdf())
    world.faults["report"] = [run.Response(200, b'{"outcome":"skipped","status":"skipped","reason":"tail-xref"}')]

    outcomes = run.run(_client(world), max_rows=10, live=True)

    assert outcomes == {"tail-refused": 1}
    assert "tail-refused" in run.FAILED
    assert "reason=tail-xref; the API undid the write" in caplog.text


def test_increment_over_max_growth_is_skipped_before_commit(world):
    original = _pdf()
    world.add("d1", original)
    world.max_growth = 10

    outcomes = run.run(_client(world), max_rows=10, live=True)

    report = json.loads(world.calls("report")[0]["body"])
    assert outcomes == {"skipped": 1}
    assert report["skipped"] is True and report["reason"].startswith("increment-too-large")
    assert world.calls("commit") == [] and world.stored("d1") == original


def test_lease_too_short_at_commit_is_released_by_a_plain_report(world):
    original = _pdf()
    world.add("d1", original)
    world.faults["commit"] = [run.Response(409, b'{"reason":"lease-too-short"}')]

    outcomes = run.run(_client(world), max_rows=10, live=True)

    assert outcomes == {"error": 1}
    assert world.calls("upload") == []
    assert json.loads(world.calls("report")[0]["body"]) == {
        "leaseId": json.loads(world.calls("commit")[0]["body"])["leaseId"], "reason": "commit: HTTP 409 lease-too-short"}
    assert world.leases == {} and world.stored("d1") == original


@pytest.mark.parametrize("reason", ["not-pdf-bytes", "key-changed", "record-mismatch", "original-no-startxref",
                                    "original-xref"])
def test_commit_refusal_that_released_the_lease_is_refused_and_not_reported(world, reason):
    world.add("d1", _pdf())
    world.faults["commit"] = [run.Response(409, json.dumps({"reason": reason}).encode())]

    outcomes = run.run(_client(world), max_rows=10, live=True)

    assert outcomes == {"refused": 1}
    assert world.calls("upload") == [] and world.calls("report") == []


@pytest.mark.parametrize("reason", ["not-from-eagle", "record-mismatch", "not-titled", "orphan-backup-differs"])
def test_new_lease_refusals_pass_through_as_row_results(world, caplog, reason):
    caplog.set_level(logging.INFO, logger="pdf-title")
    world.add("d1", _pdf())
    world.faults["lease"] = [run.Response(409, json.dumps({"reason": reason}).encode())]

    outcomes = run.run(_client(world), max_rows=10, live=True)

    assert outcomes == {"refused": 1}
    assert f"result=refused reason=lease: HTTP 409 {reason}" in caplog.text


def test_live_run_pages_the_sweep_with_its_cutoff_before_taking_work(world, caplog):
    caplog.set_level(logging.INFO, logger="pdf-title")
    world.add("d1", _pdf())
    world.sweep_pages = [
        {"scanned": 3, "outcomes": {"released": 2, "needs-review": 1}, "failed": []},
        {"scanned": 1, "outcomes": {"titled": 1}, "failed": ["d9"]},
    ]

    outcomes = run.run(_client(world), max_rows=10, live=True)

    sweeps = world.calls("sweep")
    assert _labels(world)[:3] == ["sweep", "sweep", "pending"]
    assert "before=" not in sweeps[0]["url"] and "before=2026-10-05" in sweeps[1]["url"]
    assert outcomes == {"titled": 1, "sweep-failed": 1, "sweep-needs-review": 1}
    assert "sweep: failed=1 needs-review=1 released=2 scanned=4 titled=1" in caplog.text


def test_failed_sweep_is_counted_and_the_work_still_runs(world):
    world.add("d1", _pdf())
    world.faults["sweep"] = [run.Response(500)] * run.ATTEMPTS

    outcomes = run.run(_client(world), max_rows=10, live=True)

    assert outcomes == {"sweep-failed": 1, "titled": 1}


def test_urllib_send_puts_the_commit_headers_on_the_wire_unchanged():
    seen = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_PUT(self):
            seen["headers"] = self.headers  # case-insensitive, as HTTP header names are
            seen["body"] = self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *_args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    headers = {"Content-Type": "application/pdf; charset=binary", "Content-MD5": "1B2M2Y8AsgTpgAmY7PhCfg==",
               "If-Match": '"d41d8cd98f00b204e9800998ecf8427e"'}
    try:
        r = run.urllib_send("PUT", f"http://127.0.0.1:{server.server_port}/k", headers, b"%PDF", 5)
    finally:
        thread.join(5)
        server.server_close()

    assert r.status == 200
    assert {k: seen["headers"][k] for k in headers} == headers
    assert seen["body"] == b"%PDF"


def _id_env(world, monkeypatch):
    monkeypatch.setattr(run, "urllib_send", world)
    monkeypatch.setenv("DEMI_API_URL", API)
    monkeypatch.setenv("DEMI_API_KEY", KEY)


def test_restore_by_id_writes_back_the_original(world, monkeypatch):
    _id_env(world, monkeypatch)
    original = _pdf()
    world.add("d1", _titled(original).data, mode="restore",
              original={"length": len(original), "sha256": _sha(original)})

    code = restore_cli.main(["--id", "d1", "--project", "p1", "--live"])

    assert code == 0
    assert world.stored("d1") == original
    assert "project=p1" in world.calls("lease")[0]["url"]


def test_restore_by_id_without_live_sends_nothing(world, monkeypatch):
    _id_env(world, monkeypatch)
    world.add("d1", _pdf(), mode="restore")

    assert restore_cli.main(["--id", "d1"]) == 0
    assert world.sent == []


@pytest.mark.parametrize("sealed, original, reason", [
    (True, {"length": 1, "sha256": "0" * 64}, "sealed"),
    (False, None, "no-original"),
], ids=["sealed", "never-titled"])
def test_restore_by_id_refused_exits_non_zero_and_writes_nothing(world, monkeypatch, caplog, sealed, original, reason):
    caplog.set_level(logging.INFO, logger="pdf-title")
    _id_env(world, monkeypatch)
    data = _pdf()
    world.add("d1", data, sealed=sealed, original=original)

    code = restore_cli.main(["--id", "d1", "--live"])

    assert code == 1
    assert "mode=restore" in world.calls("lease")[0]["url"]
    assert world.calls("download") == [] and world.calls("commit") == []
    assert world.stored("d1") == data
    assert f"result=refused reason=lease: HTTP 409 {reason}" in caplog.text


def test_restore_by_id_releases_a_lease_that_came_back_in_title_mode(world, monkeypatch):
    _id_env(world, monkeypatch)
    original = _pdf()
    world.add("d1", original)
    world.faults["lease"] = [run.Response(201, json.dumps({"leaseId": "x", "mode": "title"}).encode())]

    code = restore_cli.main(["--id", "d1", "--live"])

    assert code == 1
    assert world.calls("download") == [] and world.calls("commit") == []
    assert json.loads(world.calls("report")[0]["body"]) == {
        "leaseId": "x", "reason": "lease came back in title mode, wanted restore"}
    assert world.stored("d1") == original


def test_restore_needs_exactly_one_of_file_or_id():
    with pytest.raises(SystemExit):
        restore_cli.main([])
    with pytest.raises(SystemExit):
        restore_cli.main(["--id", "d1", "--file", "x.pdf"])
