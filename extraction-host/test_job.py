"""job.py against a faked API, queue and pool. Run: pytest extraction-host/"""
import json
import os
import types
from concurrent.futures.process import BrokenProcessPool

import pytest

os.environ.setdefault("DEMI_ADMIN_KEY", "test-not-used")
import extract_core as core  # noqa: E402
import job  # noqa: E402
import worker  # noqa: E402

DOC = "d1"
ROW = {"id": DOC, "projectId": "p1", "fileExt": "pdf", "documentSource": "PROJECT",
       "contentExtracted": False}


class Resp:
    def __init__(self, code, body=None):
        self.status_code, self._body, self.text, self.headers = code, body, json.dumps(body), {}

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class Queue:
    def __init__(self, dequeue_count=1, content=None):
        self.msg = types.SimpleNamespace(
            content=content or json.dumps({"documentId": DOC, "projectId": "p1", "reason": "intake"}),
            dequeue_count=dequeue_count)
        self.deleted, self.sent = [], []

    def receive_message(self, visibility_timeout):
        assert visibility_timeout > 7200, "a message must not reappear while its replica can still run"
        return self.msg

    def delete_message(self, msg):
        self.deleted.append(msg)

    def send_message(self, content):
        self.sent.append(content)


class Pool:
    """Answers the pdfium probe in-process with a fixed route."""
    def __init__(self, route=("text", "Digital text. " * 100, {})):
        self.route = route

    def submit(self, fn, *args):
        assert fn is core.pdfium_job
        return types.SimpleNamespace(result=lambda: self.route)


@pytest.fixture
def api(monkeypatch):
    """Fakes every DEMI call. `api.row` and `api.download` set what GET returns; posts are recorded."""
    state = types.SimpleNamespace(row=dict(ROW), download=200, posts=[])

    def api_get(path, **kw):
        if path == f"/documents/{DOC}":
            return Resp(200, state.row) if state.row else Resp(404, {})
        if path == f"/documents/{DOC}/download":
            return Resp(state.download, {"url": "https://objects.invalid/x"})
        raise AssertionError(path)

    def http():
        body = b"%PDF-1.4 fixture"
        resp = types.SimpleNamespace(
            status_code=200, headers={"content-length": str(len(body))},
            raise_for_status=lambda: None, iter_content=lambda n: [body])
        return types.SimpleNamespace(get=lambda *a, **k: _Ctx(resp))

    monkeypatch.setattr(core, "api_get", api_get)
    monkeypatch.setattr(core, "http", http)
    monkeypatch.setattr(core, "post_chunks",
                        lambda doc_id, body, stream=None: (state.posts.append(body), Resp(200, {}))[1])
    return state


class _Ctx:
    def __init__(self, resp):
        self.resp = resp

    def __enter__(self):
        return self.resp

    def __exit__(self, *a):
        return False


def run(queue, pool=None):
    return job.run_once(queue, Queue(), pool or Pool(), lambda: object())


def test_extracted_row_is_skipped_and_its_message_deleted(api):
    api.row["contentExtracted"] = True
    q = Queue()
    assert run(q) == "skipped"
    assert q.deleted == [q.msg] and api.posts == []


def test_update_image_is_skipped(api):
    api.row["documentSource"] = "UPDATE"
    q = Queue()
    assert run(q) == "skipped"
    assert api.posts == []


def test_missing_source_deletes_the_message_and_posts_nothing(api):
    api.download = 404
    q = Queue()
    assert run(q) == "missing"
    assert q.deleted == [q.msg] and api.posts == []


def test_conversion_error_posts_error(api, monkeypatch):
    api.row["fileExt"] = "png"

    def broken(*a, **k):
        raise ValueError("Data format error")
    monkeypatch.setattr(core, "convert_ocr", broken)
    q = Queue()
    assert run(q) == "failed"
    assert api.posts == [{"error": "docling failed: Data format error"}]
    assert q.deleted == [q.msg]


def test_runner_fault_leaves_the_message(api, monkeypatch):
    api.row["fileExt"] = "png"

    def crash(*a, **k):
        raise BrokenProcessPool("A child process terminated abruptly")
    monkeypatch.setattr(core, "convert_ocr", crash)
    q = Queue()
    with pytest.raises(BrokenProcessPool):
        run(q)
    assert q.deleted == [] and api.posts == []


def test_third_dequeue_moves_the_message_to_poison(api):
    q, poison = Queue(dequeue_count=3), Queue()
    assert job.run_once(q, poison, Pool(), lambda: object()) == "poison"
    assert poison.sent == [q.msg.content] and q.deleted == [q.msg]
    assert api.posts == [], "a poisoned message must not be processed"


def test_unreadable_message_goes_to_poison_at_once(api):
    q, poison = Queue(content="not json"), Queue()
    assert job.run_once(q, poison, Pool(), lambda: object()) == "poison"
    assert poison.sent == ["not json"]


@pytest.mark.parametrize("route", ["text", "ocr"])
def test_provenance_keys_match_the_host(api, monkeypatch, route):
    if route == "ocr":
        api.row["fileExt"] = "png"
        monkeypatch.setattr(core, "convert_ocr", lambda *a, **k: ("Scanned text.", False, False))
    assert run(Queue()) == "ok"
    sent = api.posts[0]["extraction"]
    host = worker.provenance(route, False)
    assert set(sent) == set(host)
    assert set(sent["options"]) == set(host["options"])
    assert sent["path"] == route
