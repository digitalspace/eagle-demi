"""ingest.py's retry limit against a faked post. Run: pytest extraction-host/"""
import json
import os
import queue
import types

import pytest

os.environ.setdefault("DEMI_ADMIN_KEY", "test-not-used")
import ingest  # noqa: E402

DOC = "d1"


@pytest.fixture
def work_dir(tmp_path, monkeypatch):
    for name in ("OUT", "SENT", "DEAD"):
        d = tmp_path / name.lower()
        d.mkdir()
        monkeypatch.setattr(ingest, name, d)
    monkeypatch.setattr(ingest, "LEDGER", tmp_path / "ingest.jsonl")
    monkeypatch.setattr(ingest, "MAX_RUN_FAILURES", 3, raising=False)
    return tmp_path


def converted(work_dir):
    """Puts the document's markdown and sidecar in out/, as worker.py or --resend leaves them."""
    (work_dir / "out" / f"{DOC}.md").write_text("Text.")
    (work_dir / "out" / f"{DOC}.json").write_text(json.dumps({"path": "text"}))


def run(monkeypatch, post):
    """One ingest run, as a fresh process starts it: empty work queue, counts from the ledger only."""
    monkeypatch.setattr(ingest, "work", queue.Queue())
    monkeypatch.setattr(ingest, "counts", dict.fromkeys(ingest.counts, 0))
    monkeypatch.setattr(ingest, "failures", {}, raising=False)
    monkeypatch.setattr(ingest, "post_markdown", post)
    assert ingest.main() == 0


def unreachable(*a, **k):
    raise RuntimeError("unreachable after retries: HTTP 503")


def posted(*a, **k):
    return types.SimpleNamespace(status_code=200, text="", json=lambda: {"chunks": 1})


def gone(*a, **k):
    return types.SimpleNamespace(status_code=404, text="no such document")


def test_retryable_failure_moves_to_dead_on_the_third_run(work_dir, monkeypatch):
    converted(work_dir)
    run(monkeypatch, unreachable)
    run(monkeypatch, unreachable)
    assert (work_dir / "out" / f"{DOC}.md").exists()
    run(monkeypatch, unreachable)
    assert (work_dir / "dead" / f"{DOC}.md").exists()
    assert (work_dir / "dead" / f"{DOC}.json").exists(), "the sidecar must travel with the markdown"
    last = json.loads(ingest.LEDGER.read_text().splitlines()[-1])
    assert last["id"] == DOC and last["dead"] is True


def test_a_success_resets_the_count(work_dir, monkeypatch):
    converted(work_dir)
    run(monkeypatch, unreachable)
    run(monkeypatch, posted)
    converted(work_dir)
    run(monkeypatch, unreachable)
    run(monkeypatch, unreachable)
    assert (work_dir / "out" / f"{DOC}.md").exists(), "only failed runs in a row count"
    run(monkeypatch, unreachable)
    assert (work_dir / "dead" / f"{DOC}.md").exists()


def test_final_4xx_moves_to_dead_at_once_and_is_not_counted(work_dir, monkeypatch):
    converted(work_dir)
    run(monkeypatch, gone)
    assert (work_dir / "dead" / f"{DOC}.md").exists()
    (work_dir / "dead" / f"{DOC}.md").unlink()
    (work_dir / "dead" / f"{DOC}.json").unlink()
    converted(work_dir)
    run(monkeypatch, unreachable)
    run(monkeypatch, unreachable)
    assert (work_dir / "out" / f"{DOC}.md").exists(), "a 4xx is not a failed run"
