"""`python3 -m pytest pdf-title/test_restore.py`. Titled inputs come from the titler and its fixtures."""

import hashlib

import pytest

from restore import Refused, main, restore
from test_titler import TITLE, WRITABLE, _pdf
from titler import set_title


def _titled(original, title=TITLE):
    result = set_title(original, title)
    assert result.status == "ready"
    return result


@pytest.mark.parametrize("build", WRITABLE.values(), ids=WRITABLE.keys())
def test_title_then_restore_gives_the_exact_original(build):
    original = build()
    result = _titled(original)

    restored = restore(result.data, result.source_length, result.source_sha256)

    assert restored == original


def test_restore_of_a_file_never_titled_returns_it_unchanged():
    original = _pdf()

    restored = restore(original, len(original), hashlib.sha256(original).hexdigest())

    assert restored == original


def test_uppercase_hash_in_the_record_is_accepted():
    result = _titled(_pdf())

    restored = restore(result.data, result.source_length, result.source_sha256.upper())

    assert len(restored) == result.source_length


def test_titled_twice_restores_to_the_first_original():
    original = _pdf()
    first = _titled(original)
    second = _titled(first.data, "Renamed document")

    restored = restore(second.data, first.source_length, first.source_sha256)

    assert restored == original


def test_rename_rebuilt_from_the_original_prefix_restores_to_the_original():
    original = _pdf()
    first = _titled(original)
    retitled = _titled(first.data[: first.source_length], "Renamed document")

    restored = restore(retitled.data, first.source_length, first.source_sha256)

    assert restored == original


def test_increment_cut_short_still_restores_because_the_prefix_is_whole():
    original = _pdf()
    result = _titled(original)

    restored = restore(result.data[: len(original) + 10], len(original), result.source_sha256)

    assert restored == original


@pytest.mark.parametrize("delta", [-1, 1], ids=["one-short", "one-long"])
def test_wrong_length_is_refused_by_the_hash(delta):
    result = _titled(_pdf())

    with pytest.raises(Refused, match="sha256 of the first"):
        restore(result.data, result.source_length + delta, result.source_sha256)


def test_wrong_hash_is_refused():
    result = _titled(_pdf())

    with pytest.raises(Refused, match="record says"):
        restore(result.data, result.source_length, hashlib.sha256(b"other").hexdigest())


def test_one_changed_byte_inside_the_original_is_refused():
    result = _titled(_pdf())
    damaged = bytearray(result.data)
    damaged[result.source_length // 2] ^= 0xFF

    with pytest.raises(Refused, match="sha256 of the first"):
        restore(bytes(damaged), result.source_length, result.source_sha256)


def test_length_beyond_the_file_is_refused():
    result = _titled(_pdf())

    with pytest.raises(Refused, match="shorter than originalLength"):
        restore(result.data, len(result.data) + 1, result.source_sha256)


def test_input_truncated_inside_the_original_is_refused():
    result = _titled(_pdf())

    with pytest.raises(Refused, match="shorter than originalLength"):
        restore(result.data[: result.source_length - 1], result.source_length, result.source_sha256)


def test_empty_input_is_refused():
    with pytest.raises(Refused, match="input is empty"):
        restore(b"", 100, "a" * 64)


@pytest.mark.parametrize("length, sha, reason", [
    (None, "a" * 64, "no originalLength"),
    (100, None, "no originalSha256"),
    (0, "a" * 64, "not a positive integer"),
    (-5, "a" * 64, "not a positive integer"),
    (True, "a" * 64, "not a positive integer"),
    ("100", "a" * 64, "not a positive integer"),
    (100, "a" * 63, "not a 64-character hex"),
    (100, "z" * 64, "not a 64-character hex"),
], ids=["no-length", "no-hash", "zero", "negative", "bool", "string", "short-hash", "non-hex"])
def test_missing_or_malformed_record_is_refused(length, sha, reason):
    with pytest.raises(Refused, match=reason):
        restore(b"%PDF-1.4 anything", length, sha)


def _cli(tmp_path, data, length, sha):
    src = tmp_path / "titled.pdf"
    src.write_bytes(data)
    out = tmp_path / "original.pdf"
    code = main(["--file", str(src), "--length", str(length), "--sha256", sha, "--out", str(out)])
    return code, out


def test_cli_writes_the_original_and_exits_zero(tmp_path):
    original = _pdf()
    result = _titled(original)

    code, out = _cli(tmp_path, result.data, result.source_length, result.source_sha256)

    assert code == 0
    assert out.read_bytes() == original


def test_cli_wrong_hash_exits_non_zero_and_writes_nothing(tmp_path, capsys):
    result = _titled(_pdf())

    code, out = _cli(tmp_path, result.data, result.source_length, "0" * 64)

    assert code == 1
    assert not out.exists()
    assert "refused:" in capsys.readouterr().err


def test_cli_length_beyond_the_file_exits_non_zero(tmp_path):
    result = _titled(_pdf())

    code, out = _cli(tmp_path, result.data, len(result.data) + 1, result.source_sha256)

    assert code == 1
    assert not out.exists()


def test_cli_never_overwrites_an_existing_output(tmp_path):
    result = _titled(_pdf())
    (tmp_path / "original.pdf").write_bytes(b"keep me")

    code, out = _cli(tmp_path, result.data, result.source_length, result.source_sha256)

    assert code == 1
    assert out.read_bytes() == b"keep me"
