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
| `worker.py` | 1,256 | Extraction. pdfium's non-thread-safety (found after 468 failures in two minutes), the docling-parse SIGTRAP that `PYTHONFAULTHANDLER=1` does not cover, the tiling measurement table, the text/OCR routing thresholds, and the `CONVERTERS=3` OOM ceiling |
| `ingest.py` | 254 | Posts finished markdown back to the API, with the paging and retry behaviour |
| `test_poolfix.py` | 264 | Regression checks for the process-pool fix |
| `systemd/` | — | The three units as deployed: `gpu-extractor`, `gpu-ingest`, `doc-ocr-service` |

Secrets, run state and extracted output are **not** here, and `.gitignore` enforces that rather than
relying on care at commit time. In particular `gpu-extractor.env` holds a live `DEMI_ADMIN_KEY`.

That file is also **a second authoritative copy of DEMI's `ADMIN_API_KEY`**, and on 2026-08-13 it
was the only reason that credential was recoverable after the Azure copy was destroyed. Treat it as
a backup, not just as this host's config: if you rotate the key, change it here *and* in the
`demi-app-secrets` OpenShift secret in `6cdc9e-test`, not only on the App Service.

## Page markers

The host still posts one markdown string per document. Consecutive pages are separated by a form
feed (`\f`): never one at the start, never one at the end, and a page that converted to nothing
still gets its marker, so the page count stays right. The API's chunker splits on it and stamps each
chunk with the page it came off, which is what turns `pageNumber` from a passage sequence into a
page a reader can quote.

Both routes emit it. The text route joins pypdfium2's per-page list. The OCR route asks docling for
one page at a time, `export_to_markdown(page_no=...)`, which returns an empty string for a page it
found nothing on; page batches are converted separately and their page lists concatenate in order.

The marker carries no newlines around it on purpose. `ingest.py` splits a large document into blocks
on blank lines and drops any block that is whitespace only, so a marker sitting on its own line
would be thrown away on that route.

`extractor/ocr.py` holds the same constant for the Azure-side extractor, and
`extractor/test_extract.py` lifts this file's copy by source to check the two still agree.

## The one thing you can run from a laptop

```bash
python3 worker.py --selfcheck        # prints "selfcheck ok"
```

No network, no GPU, no docling — `worker.py` skips the key lookup entirely in this mode, which is
what makes it CI-runnable.

**Be accurate about what it covers.** It is **8 assertions in one function**, all on `decide()`, the
text-versus-OCR routing rule — the one piece of logic here that can be wrong without failing loudly.
`test_poolfix.py` is separate and is not wired into this mode.

## Keeping it in step

There is no automation. If the host changes, copy the file back into this directory in the same
commit as the reasoning — otherwise this becomes another stale copy, which is the problem it was
created to solve.
