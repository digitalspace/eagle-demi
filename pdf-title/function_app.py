"""Timer-triggered wrapper around `run.py`: one pass over the PDF title work list per tick.

The work is `run.main`, unchanged; this file only turns app settings into its argv and raises on a
non-zero exit, so a failed pass shows as a failed invocation. Rows left over stay on the work list.

`extensionBundle` in host.json is required for the trigger to register (see extractor/function_app.py).
"""

import logging
import os
import sys
from pathlib import Path

import azure.functions as func

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run  # noqa: E402

app = func.FunctionApp()

# host.json `functionTimeout` is 20 minutes. `--max-minutes` only stops new rows starting, so rows
# already in flight need the rest of the window.
MAX_MINUTES_LIMIT = 15

NUMERIC_FLAGS = (
    ("PDF_TITLE_MAX_ROWS", "--max-rows"),
    ("PDF_TITLE_MAX_MINUTES", "--max-minutes"),
    ("PDF_TITLE_CONCURRENCY", "--concurrency"),
    ("PDF_TITLE_TIMEOUT", "--timeout"),
)


def build_argv(env):
    """argv for `run.main` from app settings; raises ValueError on a setting the host cannot honour."""
    argv = ["--live"] if env.get("PDF_TITLE_LIVE", "").strip().lower() == "true" else []
    for name, flag in NUMERIC_FLAGS:
        value = env.get(name, "").strip()
        if value:
            # Checked here because argparse would raise SystemExit inside the worker.
            argv += [flag, str(run.positive_int(value))]
    minutes = env.get("PDF_TITLE_MAX_MINUTES", "").strip()
    # Unset falls back to run.py's 30-minute default, which outlives the host timeout.
    if not minutes or int(minutes) >= MAX_MINUTES_LIMIT:
        raise ValueError(f"PDF_TITLE_MAX_MINUTES must be set and below {MAX_MINUTES_LIMIT}")
    return argv


@app.function_name(name="pdf_title_run")
@app.timer_trigger(arg_name="timer", schedule="%PDF_TITLE_SCHEDULE%")
def pdf_title_run(timer: func.TimerRequest) -> None:
    if timer.past_due:
        logging.warning("pdf_title_run: timer is past due")
    code = run.main(build_argv(os.environ))
    if code != 0:
        raise RuntimeError(f"pdf-title run exited {code}")
