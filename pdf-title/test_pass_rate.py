"""`scripts/pdf-title-check/pass_rate.py`: its fact comparison, its tally, and a real run through check.js."""

import csv
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "pdf-title-check"))

import pass_rate  # noqa: E402
from test_titler import PDFA_XMP, _pdf, _xref_stream_pdf  # noqa: E402

FACTS = {"prev": 900, "size": 7, "root": [1, 0], "info": [4, 0], "metadata": [5, 0]}
PIKE = {"encrypted": False, "root": [1, 0], "info": [4, 0], "metadata": [5, 0], "size": 7, "max_object": 6}
VIEW = {"prev": 900, "size": 7, "root": [1, 0], "info": [4, 0]}


def test_facts_that_match_pikepdf_and_the_titler_have_no_differences():
    assert pass_rate.compare_facts(FACTS, PIKE, VIEW) == []


def test_each_field_that_differs_is_named_with_the_side_it_differs_from():
    facts = {**FACTS, "root": [2, 0], "prev": 100, "metadata": None}

    assert pass_rate.compare_facts(facts, PIKE, VIEW) == ["root", "metadata", "prev-vs-titler", "root-vs-titler"]


def test_size_is_checked_against_the_larger_of_trailer_size_and_highest_object():
    assert pass_rate.compare_facts(FACTS, {**PIKE, "size": 5, "max_object": 6}, VIEW) == []
    assert pass_rate.compare_facts(FACTS, {**PIKE, "size": 5, "max_object": 7}, VIEW) == ["size-vs-pikepdf"]


def test_a_file_pikepdf_finds_encrypted_is_encrypted_whatever_reason_the_titler_skipped_it():
    assert pass_rate.classify(["skip:signed", "skip:signed"], {**PIKE, "encrypted": True}) == "encrypted"


def _row(file, cls, reader="facts", tails=(), diff=()):
    return {"file": file, "class": cls, "reader": reader, "tails": list(tails), "facts_diff": list(diff)}


def test_tally_counts_outputs_refusals_facts_and_encrypted_files():
    rows = [_row("a", "writable", tails=[None, None]),
            _row("b", "writable", tails=[None, "tail-xref"], diff=["size-vs-pikepdf"]),
            _row("c", "encrypted", reader="original-encrypted"),
            _row("d", "titler-skip:signed", diff=["not-compared"])]

    summary, failing = pass_rate.tally(rows)

    assert dict(summary) == {
        "files": 4, "titler-writable": 2, "titled outputs checked": 4, "passes": 3,
        "refused: tail-xref": 1, "not writable: encrypted": 1, "not writable: titler-skip:signed": 1,
        "facts compared with pikepdf and titler": 2, "facts equal": 1, "facts differ: size-vs-pikepdf": 1,
        "encrypted": 1, "encrypted read as original-encrypted": 1, "reader exceptions": 0, "failing": 1}
    assert failing == 1


def test_a_reader_exception_fails_the_run_even_on_a_file_the_titler_skipped():
    rows = [_row("a", "writable", tails=[None]), _row("c", "encrypted", reader="exception: boom")]

    summary, failing = pass_rate.tally(rows)

    assert (dict(summary)["reader exceptions"], dict(summary)["encrypted read as original-encrypted"]) == (1, 0)
    assert failing == 1


def test_a_refusal_on_the_original_alone_fails_once_per_file():
    _, failing = pass_rate.tally([_row("a", "writable", reader="original-xref", tails=["original-xref"] * 2)])

    assert failing == 1


@pytest.fixture
def samples(tmp_path):
    folder = tmp_path / "samples"
    folder.mkdir()
    (folder / "classic.pdf").write_bytes(_pdf())
    (folder / "xref-stream-xmp.pdf").write_bytes(_xref_stream_pdf(xmp=PDFA_XMP))
    (folder / "encrypted.PDF").write_bytes(_pdf(encrypt="AES-256"))
    (folder / "notes.txt").write_text("not a sample")
    return folder


def _csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        return {r["file"]: r for r in csv.DictReader(f)}


def test_a_folder_of_good_samples_passes_through_the_api_reader_and_tail_check(samples, tmp_path, capsys):
    out = tmp_path / "results.csv"

    assert pass_rate.main([str(samples), "--csv", str(out)]) == 0

    table = dict(line.rsplit(None, 1) for line in capsys.readouterr().out.splitlines())
    assert {k: table[k] for k in ("files", "titler-writable", "titled outputs checked", "passes", "facts equal",
                                  "encrypted read as original-encrypted", "failing")} == {
        "files": "3", "titler-writable": "2", "titled outputs checked": "4", "passes": "4", "facts equal": "2",
        "encrypted read as original-encrypted": "1", "failing": "0"}
    rows = _csv(out)
    assert rows["classic.pdf"]["tails"] == "pass|pass"
    assert rows["xref-stream-xmp.pdf"]["facts_diff"] == ""
    assert (rows["encrypted.PDF"]["class"], rows["encrypted.PDF"]["reader"]) == ("encrypted", "original-encrypted")


def test_a_titled_output_the_api_would_refuse_fails_the_run(samples, tmp_path, monkeypatch):
    real = pass_rate.set_title

    def with_junk(data, title):
        res = real(data, title)
        if res.data is not None:
            res.data += b"1 0 obj\n<< >>\nendobj\n"
        return res

    monkeypatch.setattr(pass_rate, "set_title", with_junk)
    out = tmp_path / "results.csv"

    assert pass_rate.main([str(samples), "--csv", str(out)]) == 1
    assert all(t.startswith("tail-") for t in _csv(out)["classic.pdf"]["tails"].split("|"))


def test_a_node_side_that_fails_stops_the_run_with_exit_2(samples, capsys):
    with pytest.raises(SystemExit) as stop:
        pass_rate.main([str(samples), "--node", "false"])

    assert stop.value.code == 2
    assert "check.js exited 1" in capsys.readouterr().err
