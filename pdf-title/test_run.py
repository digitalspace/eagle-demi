"""The runner against an in-process stand-in for the DEMI lease API and the object store; no network."""

import base64
import hashlib
import json
import logging
import threading
import urllib.parse
import uuid

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


class World:
    """Fake DEMI API plus fake store. Follows the lease contract closely enough to judge the runner.

    `faults[label]` is a list consumed one per request before normal handling: a `run.Response` is
    returned as is, an exception is raised. Labels: pending, lease, commit, report, download, upload.
    """

    def __init__(self):
        self.objects = {}
        self.docs = {}
        self.leases = {}
        self.links = {}
        self.faults = {}
        self.sent = []
        self.page_size = 500
        self.lock = threading.Lock()

    def add(self, doc_id, data, mode="title", title=TITLE, original=None):
        key = f"proj/{doc_id}.pdf"
        self.objects[key] = data
        self.docs[doc_id] = {"key": key, "mode": mode, "title": title, "original": original, "status": None}
        return key

    def stored(self, doc_id):
        return self.objects[self.docs[doc_id]["key"]]

    def calls(self, label):
        return [s for s in self.sent if s["label"] == label]

    def __call__(self, method, url, headers, body, timeout):
        with self.lock:
            label = self._label(method, url)
            self.sent.append({"label": label, "method": method, "url": url, "headers": dict(headers),
                              "body": body, "timeout": timeout})
            queue = self.faults.get(label)
            if queue:
                fault = queue.pop(0)
                if isinstance(fault, Exception):
                    raise fault
                return fault
            if url.startswith(STORE):
                return self._store(method, url, headers, body)
            assert headers.get("X-Api-Key") == KEY
            return self._api(label, url, json.loads(body) if body else None)

    @staticmethod
    def _label(method, url):
        if url.startswith(STORE):
            return "download" if method == "GET" else "upload"
        path = urllib.parse.urlsplit(url).path
        if path.endswith("/pending"):
            return "pending"
        if path.endswith("/lease"):
            return "lease"
        if path.endswith("/commit"):
            return "commit"
        return "report"

    def _link(self, method, key):
        token = uuid.uuid4().hex
        self.links[token] = (method, key)
        return f"{STORE}{key}?X-Amz-Signature={token}"

    def _store(self, method, url, headers, body):
        parts = urllib.parse.urlsplit(url)
        key = parts.path[len("/bucket/"):]
        token = urllib.parse.parse_qs(parts.query)["X-Amz-Signature"][0]
        if self.links.get(token) != (method, key):
            return run.Response(403)
        if method == "GET":
            return run.Response(200, self.objects[key])
        if headers.get("Content-MD5") != base64.b64encode(hashlib.md5(body).digest()).decode():
            return run.Response(400)
        if headers.get("If-Match") != f'"{_md5(self.objects[key])}"':
            return run.Response(412)
        self.objects[key] = body
        return run.Response(200)

    def _api(self, label, url, body):
        parts = urllib.parse.urlsplit(url)
        if label == "pending":
            return self._pending(urllib.parse.parse_qs(parts.query))
        doc_id = urllib.parse.unquote(parts.path.split("/")[-3 if label != "report" else -2])
        return getattr(self, f"_{label}")(doc_id, body)

    def _pending(self, query):
        rows = [{"id": i, "projectId": "p1", "mode": d["mode"], "title": d["title"] if d["mode"] == "title" else None}
                for i, d in self.docs.items() if d["status"] is None and i not in self.leases]
        start = int(query.get("continuation", ["0"])[0])
        end = start + self.page_size
        return run.Response(200, json.dumps({
            "items": rows[start:end], "continuation": str(end) if end < len(rows) else None, "swept": 0}).encode())

    def _lease(self, doc_id, _body):
        doc = self.docs.get(doc_id)
        if doc is None:
            return run.Response(404, b'{"reason":"not-found"}')
        if doc_id in self.leases:
            return run.Response(409, b'{"reason":"lease-held"}')
        source = self.objects[doc["key"]]
        backup_key = f"pdf-title-backup/{doc['key']}"
        self.objects[backup_key] = source
        original = doc["original"] or {}
        lease = {"leaseId": uuid.uuid4().hex, "mode": doc["mode"], "title": doc["title"] if doc["mode"] == "title" else None,
                 "sourceSize": len(source), "sourceMd5": _md5(source), "backupKey": backup_key, "inFlight": None}
        self.leases[doc_id] = lease
        return run.Response(201, json.dumps({
            "leaseId": lease["leaseId"], "mode": lease["mode"], "expiresAt": "2026-10-05T00:10:00Z",
            "title": lease["title"], "backupUrl": self._link("GET", backup_key), "backupUrlExpiresIn": 300,
            "sourceSize": len(source), "contentType": CONTENT_TYPE,
            "originalLength": original.get("length"), "originalSha256": original.get("sha256")}).encode())

    def _commit(self, doc_id, body):
        doc, lease = self.docs[doc_id], self.leases.get(doc_id)
        if not lease or lease["leaseId"] != body["leaseId"]:
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
        if doc["mode"] == "restore" and (body["newLength"], body["newSha256"]) != (
                doc["original"]["length"], doc["original"]["sha256"]):
            return run.Response(400, b'{"reason":"a restore must write the recorded original"}')
        lease["inFlight"] = body
        return run.Response(200, json.dumps({
            "uploadUrl": self._link("PUT", doc["key"]), "expiresIn": 120,
            "headers": {"Content-Type": CONTENT_TYPE, "Content-MD5": body["newMd5"],
                        "If-Match": f'"{lease["sourceMd5"]}"'}}).encode())

    def _report(self, doc_id, body):
        doc, lease = self.docs[doc_id], self.leases.get(doc_id)
        if not lease or lease["leaseId"] != body["leaseId"]:
            return run.Response(409, b'{"reason":"no-lease"}')
        stored, in_flight = self.objects[doc["key"]], lease["inFlight"]
        if in_flight and _sha(stored) == in_flight["newSha256"] and _sha(stored[:doc["original"]["length"]]) == doc["original"]["sha256"]:
            outcome = "restored" if doc["mode"] == "restore" else "titled"
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


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(run.time, "sleep", lambda _s: None)


@pytest.fixture
def world():
    return World()


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
    assert json.loads(world.calls("report")[0]["body"]) == {"leaseId": json.loads(world.calls("commit")[0]["body"])["leaseId"]}


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

    assert outcomes == {"error": 1}
    assert world.calls("upload") == []
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


def test_restore_by_id_releases_a_lease_that_came_back_in_title_mode(world, monkeypatch):
    _id_env(world, monkeypatch)
    original = _pdf()
    world.add("d1", original, mode="title")

    code = restore_cli.main(["--id", "d1", "--live"])

    assert code == 1
    assert world.calls("download") == [] and world.calls("commit") == []
    assert world.stored("d1") == original and world.leases == {}
    assert world.docs["d1"]["status"] is None


def test_restore_needs_exactly_one_of_file_or_id():
    with pytest.raises(SystemExit):
        restore_cli.main([])
    with pytest.raises(SystemExit):
        restore_cli.main(["--id", "d1", "--file", "x.pdf"])
