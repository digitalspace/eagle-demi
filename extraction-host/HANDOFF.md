> **SUPERSEDED 2026-08-01.** The recovery in §2 HAS BEEN RUN — 842 documents recovered, 43,003
> chunks, 0 failed. The root cause in §3 has been fixed in `worker.py` (runner faults are now
> deferred, never recorded as document failures; the pool rebuilds itself; a 25-fault streak stops
> the run). Provenance is being sent. The full-corpus run restarted and is in flight.
>
> `recover_false_failures.py` has since been corrected: as originally written it left 130 `.err`
> files in `out/`, which `ingest.py` would have posted as fresh failures. Do not follow the old
> two-step recipe below without reading the script.
>
> Kept as the record of what the state WAS. Live state: `systemctl status gpu-extractor`.

# Handoff — DEMI corpus backfill, state as of 2026-08-01

Written from a session on the eagle-demi side (LXC with the repo + Azure CLI), which can reach this
host over SSH but cannot see the GPU, the logs, or docling itself. Everything below was **measured**
against this host's files and the live API, not assumed. Where a number is a sample rather than a
total, it says so.

**Read this before running `ingest.py`.** There is a live footgun in `out/` — see §2.

---

## 1. Where the backfill actually is

Extraction halted 2026-07-30 14:08 mid-run. Of 60,578 documents in Azure:

| | |
|---|---|
| Posted with real chunks | **1,718** |
| Posted as an ERROR (flagged extracted, zero chunks) | **855** |
| Markdown on disk here | 1,720 files, median 32 KB |
| Never attempted | ~57,000 |

The error records are dominated by one string, confirmed live on three sampled documents:

```
docling failed: A child process terminated abruptly, the process pool is not usable anymore
```

That is a Python `BrokenProcessPool`. Once the pool died, every subsequent document recorded it
instantly and was marked done. **The cascade is one crash, not 855 bad documents.**

Genuine failures, which must NOT be requeued: `unsupported format: msg` (5) and
`unsupported format: doc` (1). There is no docling reader for them.

## 2. The cheap win: 842 documents need no GPU time at all

**842 of the 855 documents Azure has flagged as failed already have good markdown on this disk.**
They were converted successfully either before or after the `.err` was written; the error post
simply landed last. Verified on the API: `contentExtracted: true`, `contentPageCount: 0`,
crash-cascade error — and `contentPageCount: 0` means the error post was last, so there are **no
orphan chunks**. A plain re-POST is a clean fix.

Only **13** of the 855 genuinely lack markdown, 6 of which are the unsupported formats above.

The footgun: `out/` currently holds **866 `.err` files, of which 736 are superseded** — a good `.md`
for that document exists. `ingest.py` posts `.err` files as `{"error": ...}`, and `main()` globs
`*.md` and `*.err` together. **Running it as-is re-records 736 failures.** With `UPLOADERS=4` the
ordering within a stem is racy, so this is not reliably self-correcting.

Recovery, in order:

```bash
cd /root/gpu-extractor
python3 recover_false_failures.py            # dry run, writes nothing
python3 recover_false_failures.py --live     # parks 736 stale .err, moves 834 .md back to out/
DEMI_ADMIN_KEY=... python3 ingest.py         # NOT --resend
```

`--resend` would replay all 3,216 files including every `.err`, which is the opposite of the goal.

Expected after: 842 documents flip to real chunk counts, `contentExtractionError` cleared. The route
is idempotent — chunk ids are deterministic and `replaceForDocument` reconciles — so a re-run is a
no-op rather than a duplicate.

## 3. Before restarting extraction

**Fix the pool crash first, or the cascade recurs.** The specific behaviour to change: a dead worker
must leave the document RETRYABLE, not record an error and mark it done. Recording a failure is what
takes a document out of the work list with nothing behind it — silently absent from search, which is
the exact failure mode the router was built to avoid.

First thing to check: OOM. `MIGRATION.md` records `CONVERTERS=3` OOM-killing a 16 GiB host at
15.9 GB peak, because docling holds page images for the whole document. Settled at `CONVERTERS=2`
plus a semaphore serialising documents over 8 MB. If the pool died on a large document, that is the
likely cause and the fix is admission control, not retry logic.

**Send `extraction` provenance.** The API has accepted it since `4bddede` and nothing has ever sent
it — confirmed live: 0 of 217 clean documents in a sampled page carry the field. It is the only
reason no quality number can be split by OCR path vs text-layer path, and it is what would answer
the open slide-deck question without a separate investigation.

```json
{ "markdown": "...",
  "extraction": { "path": "ocr" | "text", "engine": "rapidocr", "doclingVersion": "...",
                  "options": {"force_ocr": false}, "at": "2026-08-01T12:00:00Z" } }
```

Sanitised server-side to exactly those keys; `options` is flattened to a ≤500-char JSON string;
anything else is dropped. `path` outside `ocr|text` becomes `unknown` rather than being rejected.

## 4. The ingest contract, as the server actually behaves

`POST /api/documents/:id/chunks`, header `X-Api-Key`. Body is `{markdown}` or `{error}`, plus
optional `extraction`.

- **`read[]` is copied from the LIVE document. A caller-supplied `read` is ignored** — this host
  cannot widen a document's visibility, by design. Markdown extracted days ago lands with today's ACL.
- **No `contentExtracted` guard.** Re-POSTing a failed document replaces its chunks and clears
  `contentExtractionError`. That is what makes §2 work, and it means requeuing never needs an admin
  script or a tunnel into Azure.
- **413** — body cap 10 MB. **500** — partial chunk write, retry the whole document. Both are
  recorded as extraction errors server-side.
- **Empty markdown returns 200 and records a SUCCESSFUL extraction of nothing** (`contentPageCount:
  0`). This is how placeholder-only slide decks became invisible. If a conversion produces nothing
  usable, post it as `{error}`, not as empty markdown.
- **Do not change chunk sizing.** `TARGET/MAX/OVERLAP` are 2500/4000/200 server-side; chunk ids
  derive from the split, so a change mid-run orphans every chunk already written instead of
  reconciling.
- Chunking, ACLs and ids are all server-side. Never hand-roll chunk objects.

## 5. What is local and what is not

Extraction — GPU, OCR, docling, page batching — is entirely off-platform and free. The only thing
crossing to Azure is one HTTPS POST of markdown per document. It has to cross because Cosmos is the
system of record and Azure AI Search indexes it on a 5-minute pull; Typesense was deleted
2026-07-31, code and infrastructure, so there is no local index left to write to.

**Nothing on this host belongs in the eagle-demi repo.** No repo file, template or app setting
references it, and that separation is deliberate — the repo describes a permanent platform, this
host is temporary hardware. The repo is PUBLIC (`github.com/digitalspace/eagle-demi`); never commit
`DEMI_ADMIN_KEY` or anything from `gpu-extractor.env`.

Repo files worth reading, if this host can clone: `MIGRATION.md` §A (extraction measurements,
ingest contract, quality numbers) and `TODO.md` §2 (this cascade, the error signature).

## 6. Numbers that are samples, not totals

- The 78% error rate I first measured came from **one page of 1,000 documents in Cosmos scan order**.
  `pageSize` caps at 1000 and `/api/documents` returns a bare array with no continuation token, so
  no total is obtainable from outside. The signature is the finding; the rate is not.
- The 855 / 842 / 13 split comes from **this host's `ingest.jsonl`**, which covers only what this
  host posted. Earlier runs or a second poster would not appear in it.
- `MIGRATION.md` and `TODO.md` said "~1,712 parked failures". That figure counted `.err` FILES
  across `sent/` and `out/` including duplicates of the same document id. Deduplicated against what
  was actually posted, the real number is **855**, of which **842 are recoverable without
  re-extraction**. The repo has not been corrected yet — do that once §2 is confirmed run.
