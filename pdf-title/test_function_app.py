"""The timer wrapper: app settings to `run.main` argv, and a failed pass raising. `run.main` is stubbed."""

import types

import pytest

import function_app
import run

TIMER = types.SimpleNamespace(past_due=False)


@pytest.fixture
def main_calls(monkeypatch):
    calls = []
    monkeypatch.setattr(run, "main", lambda argv: calls.append(argv) or 0)
    return calls


def _settings(monkeypatch, **values):
    for name, _ in function_app.NUMERIC_FLAGS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("PDF_TITLE_LIVE", raising=False)
    for name, value in values.items():
        monkeypatch.setenv(name, value)


def test_without_live_setting_the_run_is_dry(monkeypatch, main_calls):
    _settings(monkeypatch, PDF_TITLE_MAX_MINUTES="5")

    function_app.pdf_title_run(TIMER)

    assert "--live" not in main_calls[0]


def test_max_rows_setting_becomes_the_flag(monkeypatch, main_calls):
    _settings(monkeypatch, PDF_TITLE_MAX_MINUTES="5", PDF_TITLE_MAX_ROWS="50")

    function_app.pdf_title_run(TIMER)

    argv = main_calls[0]
    assert argv[argv.index("--max-rows") + 1] == "50"


def test_non_zero_exit_raises(monkeypatch):
    _settings(monkeypatch, PDF_TITLE_MAX_MINUTES="5")
    monkeypatch.setattr(run, "main", lambda argv: 1)

    with pytest.raises(RuntimeError, match="exited 1"):
        function_app.pdf_title_run(TIMER)


@pytest.mark.parametrize("minutes", ["15", None], ids=["at-limit", "unset-defaults-to-30"])
def test_max_minutes_that_outlive_the_host_timeout_are_refused(monkeypatch, main_calls, minutes):
    _settings(monkeypatch, **({"PDF_TITLE_MAX_MINUTES": minutes} if minutes else {}))

    with pytest.raises(ValueError, match="PDF_TITLE_MAX_MINUTES"):
        function_app.pdf_title_run(TIMER)

    assert main_calls == []
