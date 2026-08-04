# extraction-host

Source for the off-platform extraction box. **Vendored, not deployed.** Nothing in this repository
installs or updates the host; this directory exists so the code stops living on exactly one machine.

## Why it is off-platform, and why that is not what this changes

Extraction runs on a GPU box outside Azure because serverless GPU was priced and rejected (see the
wiki's Extraction-Pipeline page). That decision stands. What was wrong was not *where* the code ran but that it
existed **only** there — plus scratch copies on the host that already differed in length from the
running version, so "the source" was ambiguous.

The host converts documents to markdown and POSTs them back:

```
POST /api/documents/:id/chunks     { markdown }  |  { error }
```

Header `X-Api-Key`, read from `DEMI_ADMIN_KEY` in the environment. The API chunks the markdown and
copies `read[]` from the live document, so this host cannot widen any document's visibility.

## What is here

| File | Lines | What it holds |
|---|---|---|
| `worker.py` | 1,193 | Extraction. pdfium's non-thread-safety (found after 468 failures in two minutes), the docling-parse SIGTRAP that `PYTHONFAULTHANDLER=1` does not cover, the tiling measurement table, the text/OCR routing thresholds, and the `CONVERTERS=3` OOM ceiling |
| `ingest.py` | 254 | Posts finished markdown back to the API, with the paging and retry behaviour |
| `test_poolfix.py` | 264 | Regression checks for the process-pool fix |
| `systemd/` | — | The three units as deployed: `gpu-extractor`, `gpu-ingest`, `doc-ocr-service` |

Secrets, run state and extracted output are **not** here, and `.gitignore` enforces that rather than
relying on care at commit time. In particular `gpu-extractor.env` holds a live `DEMI_ADMIN_KEY`.

## The one thing you can run from a laptop

```bash
python3 worker.py --selfcheck        # prints "selfcheck ok"
```

No network, no GPU, no docling — `worker.py` skips the key lookup entirely in this mode, which is
what makes it CI-runnable.

**Be accurate about what it covers.** It is **8 assertions in one function**, all on `decide()`, the
text-versus-OCR routing rule — the one piece of logic here that can be wrong without failing loudly.
(An earlier note in `TODO.md` claimed "~45 self-checks"; that was never true.) `test_poolfix.py` is
separate and is not wired into this mode.

## Keeping it in step

There is no automation. If the host changes, copy the file back into this directory in the same
commit as the reasoning — otherwise this becomes another stale copy, which is the problem it was
created to solve.
