# DEMI — TODO

**Updated 2026-08-02.** Actionable work only. Rationale + measured facts in `MIGRATION.md`; agent
rules in `CLAUDE.md`. **Record finding once, in file that owns topic.**

Status: **dev only, no test/prod.** Items = backlog, not incidents.

---

## State of play

**Live.** Azure AI Search `demi-search-dev` (Basic, keyless, private endpoint only) serve all three
datasets — `demi-chunks`, `demi-projects`, `demi-documents` — indexers on `PT5M`. Typesense deleted
2026-07-31, code and infrastructure both; `az containerapp list -g c4b0a8-dev-rg` return nothing.
`demi-chunks` held 80,354 rows on 2026-08-01; Cosmos now holds **995,316** chunks after the
2026-08-02 run, and the index count has not been re-read (see below).

Cosmos counts read live 2026-08-02: **projects 2,248** (the 393 figure predate the NRPTI sync),
documents 60,578, records 48,086, boundaries 281.

**`indexProgress` in `/db/stats` and `/admin/index-progress` is COSMOS index-build percent, not
Azure AI Search.** `src/controllers/db.js:22-37` calls `cosmosNoSql.indexProgress`. `chunks: 100`
means the Cosmos container finished indexing itself and says NOTHING about whether the `PT5M`
indexer has pulled anything. The data plane is private-endpoint-only, so the only AI Search number
observable from outside is now `count` on `GET /search?dataset=DocumentChunk` — `searchChunks()`
always computed it and the controller used to discard it.

**That count is per-query, not an index total, and there is no match-all path to one.** `keywords`
is required (empty short-circuits to `[]`), `*` is escaped by the query builder, and `the`/`a` are
stopwords under the `en.microsoft` analyzer — all three return 0 hits. It is also evaluated under
the CALLER's ACL, so an unauthenticated count covers public rows only. A true index total still
needs a data-plane query from inside the VNet.

**Paging: `continuationToken` is a QUERY PARAMETER.** The API returns the token in the
`x-continuation-token` RESPONSE header but only reads it from the query string
(`src/controllers/nosql/document.js:45-67`). Passing it back as a request header silently re-serves
page 1 forever — a count taken that way read 21,000 when the answer was 1,511.

**Phase 8 deployed + verified live 2026-08-01.** Mongo-API layer gone from app. Clean week run to
**2026-08-08**; only Azure teardown left. Evidence in `MIGRATION.md` §B.

**Cost.** AI Search Basic fixed ~$75-81/mo whether queried or idle. `demi-budget-dev` window open
2026-08-01, so first real post-Typesense reading arrive then.

---

## Open work

### 1. Phase 8 Azure teardown — earliest 2026-08-08

Code and template both done. Only `az` mutations left, and none run before the clean week end.
Rollback until then is `git revert` plus the app settings still on `demi-api-dev` — **the template
edits did not touch either**, so rollback is intact.

- [x] **Bicep, done 2026-08-01.** `cosmosDb` module + `mongodbConnectionString` wiring out of
      `main.bicep`; `azure/modules/cosmos-db.bicep` deleted; `api-web-app.bicep` param and all four
      settings it fed (`COSMOSDB_URI`, `COSMOSDB_DATABASE`, `MONGODB_URI`, `MONGODB_DATABASE` — TODO
      named two, they shared one param) deleted; stale `azure/main.json` deleted. `az bicep build`
      clean on all three touched files. Deployed nothing: `main.bicep` is not what run and CI cannot
      auth.
- [ ] App settings `MONGODB_URI`, `MONGODB_DATABASE` off `demi-api-dev`, then `stop`/`start`. **This
      burn the rollback.** Confirmed still present 2026-08-01.
- [ ] Account `demi-mongo-dev-pcbd7cygyic52`, then `demi-mongo-pe` + its NIC. **The private endpoint
      is the only flat recurring charge (~$7/mo).**

Checked already, so nobody re-check:

- **`main.bicepparam` + three workflows need NO change.** `mongodbConnectionString` is an internal
  module param wired from a module output, never top-level, so the `typesenseApiKey` failure cannot
  repeat here.
- **`COSMOS_ENDPOINT` safe** — point at `demi-cosmos-dev`, the NoSQL account, not Mongo.
- **`main.bicep` is not what run** — no VNet in the RG, and it never instantiate the four modules
  that build current architecture. Settings come off with `az`, not a template deploy. Bicep edit
  keep the template honest for whenever IaC unblock.
- **`src/extract.js` still speak Mongo** and is deferred-not-dead. Guard added 2026-08-01: `main()`
  throw when no Mongo URI env configured, so a post-teardown run error instead of silently reading
  localhost and reporting zero documents.

### 2. Extraction LANDED 2026-08-02 13:05 — corpus reconciled

Full-corpus run finished: `DONE in 1.34 h — 2321 ok, 6 failed, 1496 source missing, 0 deferred,
56755 skipped`. Zero SIGTRAPs, zero restarts after the backend switch (below). Ingest fully
drained, `out/` empty.

**Reconciled 2026-08-02** — API page-walk of `extracted=true/false` against the host's own disk.
Balances exactly, no unexplained remainder:

| | | |
|---|---|---|
| Corpus | **60,578** | `GET /db/stats` |
| Extracted **with chunks** | **53,109** | `contentPageCount > 0` — real coverage, 87.7% |
| Flagged extracted, **zero chunks** | 5,958 | a recorded failure sets `contentExtracted` too |
| Unextracted (`extracted=false`) | 1,511 | ≈ the run's own 1,496 source-missing |
| Chunks in Cosmos | **995,316** | Σ `contentPageCount`, vs 80,355 first-run baseline |

Zero-chunk documents by cause: **5,802 `download failed: 404`**, 73 `unsupported format`, 50 no
error at all, 17 `PDFium data format error`, 10 other download, 5 other, 1 cascade leftover. So
**genuinely unextractable is ~106 documents, 0.18%.**

**The 5,802 404s are FALSE failures and the dev object store is why.** Docling never read those
documents; there were no bytes to fetch. Measured: 4,003 of the 5,802 sit under an object-store
prefix that ALSO holds successfully-downloaded objects, with structurally identical keys
(`<prefix>/<32-hex>.<ext>`), so the key scheme is right and those specific objects are simply
absent. Dev is a partial copy of prod. 111 prefixes affected, 47 of them missing entirely.
- [x] **CLEARED 2026-08-03** with `purge-extraction.js --error-like "download failed: 404"` (added
      2026-08-02 for exactly this — `--errors-only` alone would also have requeued the 106 genuine
      failures and burned GPU time re-failing them). Run via `_purgewrap.js` inside the app
      container over the App Service SSH tunnel, because Cosmos is private and keyless.

      ```
      PURGE_RESULT {"mode":"live","errorsOnly":true,"scanned":59082,"documents":5802,
                    "chunksRemoved":0,"indexEntriesRemoved":0,"failures":[]}
      ```

      **5,802 exactly** — the dry run matched the reconciliation's independently-measured count,
      which was the gate for proceeding. `chunksRemoved: 0` because these documents never held
      chunks: the run only reset false flags and deleted nothing.

      **Host side, and it is half the job** — `already_done()` treats a local `.err` as settled no
      matter what Cosmos says. The `.err` files partition exactly, which is the cross-check that
      the classification is right:

      | Bucket | Count | Action |
      |---|---|---|
      | 404-class | 5,802 | quarantined to `purge-backup/` |
      | Superseded (an `.err` beside a `.md`) | 840 | quarantined — Cosmos was already clean |
      | Genuine failures | **106** | KEPT, and this matches the independently-derived unextractable count |

      `worklist.json` deleted so it rebuilds. Verified: **7,298 documents = 1,496 source-missing +
      5,802 purged**, all 5,802 present. Documents attempted after the rebuild now record through
      `missing()` — no `.err`, so they stay honestly in the work list instead of being falsely
      marked failed, which was the whole point.

**Two silent gaps found by the reconciliation, neither previously visible:**
- [x] **15 documents too big to ingest — FIXED 2026-08-03, all 15 landed, 132,787 chunks.** Their
      markdown is 13–60 MB against `express.json({ limit: '10mb' })` (`src/app.js:75`), so every
      POST was a 413 and they were the ONLY documents with markdown on disk and nothing in Cosmos.
      12 of 15 now retrieve themselves from AI Search; the 3 misses are near-identical review-table
      text across sibling documents, so their own chunk ranks below `pageSize` — bad labels, not
      missing content.

      **Why the markdown is 60 MB** (this entry used to ask): docling renders them as one enormous
      markdown table, the largest 2,198 lines averaging 28,817 characters. Nothing is malformed.

      **The fix is a streaming NDJSON path**, not a bigger limit — a 60 MB JSON body parses to a
      60 MB JS string plus parser buffer on B1 Basic (1.75 GB, single worker) and the ceiling only
      moves to the next document, against a roadmap of ~300K. `Content-Type: application/x-ndjson`
      on the same route: line 1 provenance, lines 2..n JSON-encoded markdown blocks. `express.json`
      only parses `application/json`, so the body arrives unconsumed and no route change was
      needed. Both paths share `createChunkAccumulator`, so a document chunks identically whichever
      door it came through — asserted in the tests and re-checked live.

      **FOUR separate ceilings, only the first of which was designed for.** Each one surfaced from
      real documents, never from a test:

      | Ceiling | Symptom | Fix |
      |---|---|---|
      | Memory, 10 MB body | 413 | NDJSON streaming path |
      | **Transport** | `400 empty stream` | App Service drops CHUNKED request bodies — see `CLAUDE.md`. Send `Content-Length` |
      | **Time, 240 s** | 504 GatewayTimeout | `UPLOADERS=1`; a 31 MB document went 240 s+ → 111 s |
      | **Throughput** | Cosmos 429 | The SDK THROWS a request-level 429 instead of returning per-operation statuses, so `bulkVerified` never retried it. Fixed in the shared function |

      **And one bug of my own, which killed the worker six times.** The batch bound was checked
      between markdown BLOCKS rather than between chunks, so peak memory followed block size — and
      `5cd1bf58f8f32d0024119fb9` is 30 MB across 2,247 lines with only FIVE blank ones, i.e. ~6
      blocks of ~5 MB each emitting well over a thousand chunks per call. The existing batch test
      used 900 separate blocks and passed throughout. **A single huge block is the shape that
      distinguishes correct from broken**, and there is now a test for exactly it.

      Ingest of this class is verified at `UPLOADERS=1` only. Whether 4 still fits inside 240 s now
      that batching is bounded is untested — do not assume it does.
- [x] **50 documents extracted clean, no error, zero chunks — RESOLVED 2026-08-02.** They were a
      subset of the 2,039 placeholder-only population and went through the tiling re-run with it.

**Backend switched to `PyPdfiumDocumentBackend` 2026-08-02 11:44.** `DoclingParseDocumentBackend`'s
native page decoder ABORTS THE PROCESS on some corpus documents — 83 restarts in five hours, all
`status=5/TRAP`, and with `faulthandler.register(signal.SIGTRAP)` (which `PYTHONFAULTHANDLER=1`
does NOT cover, hence five hours of silent crashes) 4 of 4 captured traps had an identical top
frame: `docling_parse/pdf_parser.py:757 _ensure_page_decoder`. A native abort cannot be caught, so
`fail()`/`defer()`/`missing()` never ran, nothing was recorded, the feeder requeued the same work
and the run stalled to zero documents in 90 seconds. After the switch: 0 traps, 0 restarts,
~1,400 docs/hr, and three previously-unextractable documents converted on the first attempt.
**The corpus is now mixed-provenance** — sidecars record `pdf_backend`, and any quality comparison
has to split on it.

**A third outcome class exists now: `missing()`.** A source 404 is neither a document defect nor a
runner fault. It writes no `.err`, so the document stays in the work list for whenever the file
appears, and it does not trip the circuit breaker. Before this, 5,445 unfetchable documents were
recorded as extraction errors and dropped from the work list permanently. `1,511 unextracted` is
that class working, not a bug.

Both services are `systemctl enable`d, so a host reboot resumes. Work is resumable from disk —
`already_done()` reads `out/`, `sent/`, `dead/`, and `ingest.py` reruns every 5 minutes doing only
outstanding work.

**Root cause, confirmed by reproduction.** `ocr_worker` submitted `split_pdf` into a shared
`ProcessPoolExecutor`. A `ProcessPoolExecutor` never recovers — once a child dies badly, `_broken`
is set and every later submit raises. That raise hit a generic `except` which called `fail()`,
writing a `.err`, which `ingest.py` posts as `{"error": ...}`, which marks the document extracted
with zero chunks and removes it from the work list permanently. **One crash, 855 documents silently
absent from search.** Reproduced on the host's own Python 3.13: a killed pool child sets `_broken`
to the exact corpus string `A child process terminated abruptly, the process pool is not usable
anymore`.

**The count was wrong.** "~1,712" counted `.err` FILES across two directories, double-counting ids.
Deduplicated against what was actually posted: **855** documents recorded as errors.

| | | |
|---|---|---|
| Had good markdown already on disk | **842** | **recovered 2026-08-01** — 863 markdown files posted, 43,003 chunks, 0 failed, 2.2 min, zero GPU time |
| Crash victims with no markdown | **3** | 5 originally; 2 re-extracted in the 2026-08-01 smoke test |
| Genuinely unsupported (`msg`, `doc`) | **8** | correctly flagged, leave them |

**The remaining 3 need `purge-extraction.js --errors-only`** *if the host's `worklist.json` cache is
ever deleted*. `build_worklist` asks the API for `extracted=false`, so a document still flagged
extracted-with-error never appears in a REBUILD — but the cached list predates the flags and still
carries them, which is how the smoke test picked two up. Everything else the host requeues itself:
`ingestChunks` has no `contentExtracted` guard and a plain re-POST clears the error.

**Fixed host-side 2026-08-01** (out of repo, `worker.py`): runner faults are now classified apart
from document faults and `defer()`ed — no `.err`, so the document stays in the work list; the pool
is rebuilt in place; 25 consecutive runner faults stop the run rather than walking the corpus. The
circuit breaker exits **cleanly**, so `Restart=on-failure` deliberately does not restart it — it
stops and waits for a human instead of grinding through the corpus. The host now also sends
`extraction` provenance, which nothing ever had.

Sample for context, read live off the first 1,000 extracted documents in Cosmos scan order (783
carried an error, 777 of them the cascade string). `pageSize` caps at 1000 and the endpoint returns
a bare array with no continuation token, so that is **a page, not a total** — the signature was the
finding, not the 78% rate.

### 3. Extraction quality

Numbers + caveats in `MIGRATION.md` §A. **OCR not the problem: word-salad 0.23% of chunks, 30 of 40
randomly sampled documents had zero bad chunks.** In this order:

- [x] **Large-format sheets extract to nothing but `<!-- image -->` — docling starves OCR on them.**
      **FIXED AND RE-RUN 2026-08-02.** Result first, diagnosis kept below because it is what any
      future starvation case gets compared against.

      2,039 documents reprocessed: **0 failed, 0 deferred, 0 source-missing.** **1,855 (91%) now
      hold real text** where they held a 14-character placeholder.

      | Real characters after tiling | |
      |---|---|
      | min / p10 / p25 | 0 / 38 / 124 |
      | **median** | **299** |
      | p75 / p90 / max | 552 / 1,017 / 104,190 |

      Cosmos: all 2,039 `contentExtracted`, **zero `contentExtractionError`**. Search round-trip
      **9 of 10** sampled documents retrieve themselves; the miss was a label matching 3,210 chunks
      corpus-wide, not an index fault.

      **`contentPageCount` is the wrong lens on this population** — 1,874 still read "1 chunk", but
      that chunk now holds ~300 real characters instead of a 14-character placeholder. Only the
      markdown, or a round-trip query, distinguishes them.

      **Residue: 184 documents (9%) tiling cannot reach** — 101 where tiling found nothing beyond
      the empty pass, 83 where it found a scrap under 32 characters (72 are literally zero). Split
      161 `ocr` / **23 `text`**, the latter blocked by the `LOW_YIELD_MIN_BYTES=200000` reroute gate
      and pending a separate small run. **`tiled: true` in provenance means "beat the empty pass",
      NOT "the text is usable"** — 83 of the residue carry it. Do not count the flag as recovery.

      **Diagnosis, 2026-08-02**, kept because it is what any future starvation case is compared
      against. It is not what this entry used to say: they are not slide decks (they are figures,
      maps, cross-sections and title-block engineering drawings), the router did not misroute them
      (**2,011 of 2,039 carried `extraction.path: ocr`**), and the population was far larger than
      the eight originally sampled.

      **2,039 documents, 3.8% of everything extracted, held no text at all** before this fix — 1,908
      PDF + 131 image. **1,989 of them were IN the index holding one chunk of nothing** — findable
      by title, matching no content, which is worse than being absent. The other 50 produced zero
      chunks. That shape is the thing to grep for: a document can be extracted, error-free, indexed
      and still empty.

      Measured on one page, same converter, same settings each time:

      | Input | Real chars |
      |---|---|
      | Whole page, normal OCR | 0 |
      | Whole page, `force_full_page_ocr=True` | 0 |
      | Whole page rendered at scale 2 / 4 / 6, upright or rotated 90° | 0 in all six |
      | **Same page cut into a 3×3 grid, tiles OCR'd separately** | **1,018** |
      | Positive control (letter-size scan, same converter) | 1,840 |

      So OCR works, the page has real text, and **docling normalises the page image to a fixed size
      before OCR** — on a D-size sheet that puts 6-point map labels below RapidOCR's detection
      floor. Render scale and rotation cannot move it; only tiling can. The host's existing
      low-yield retry (`LOW_YIELD_CHARS=500`, `LOW_YIELD_MIN_BYTES=200000`) is useless here: it
      fires — median source is 822 KB — and forced full-page OCR returns byte-identical output.

      **Fixed host-side 2026-08-02** (out of repo, `worker.py`). A conversion that comes back with
      fewer than `TEXTLESS_CHARS` REAL characters — placeholders and whitespace stripped, because
      `<!-- image -->` is 14 characters and sailed past every `len()` gate in the file — is re-OCR'd
      by cutting each page into a `TILE_GRID`×`TILE_GRID` grid with 6% overlap, joined with
      duplicate lines dropped so the seam does not index the same sentence twice. Bounded: 20 pages
      per document, page render capped at 60 MP. Provenance records `tiled` and the grid.
      Measured on five known-bad documents: 14→3,197, 0→943, 0→1,104, 17→241, 6→1,649 characters.
      The same `real_chars` test replaced the text path's `len(md)`, where 600 characters of
      whitespace also read as a good extraction.

      Recovered text is ROUGH where map lettering sits at an angle (`Barrowsources`, `Offsite
      constnk source Of`). Findable beats invisible for a lexical index, but do not expect prose,
      and weigh it when reading the retrieval scorecard below.
- [x] **Re-ran the 2,039 — 2.49 h, results above.** Required clearing those documents'
      `.md`/`.json` out of `sent/` first, or `already_done()` skips every one. OOM-killed once at
      the cgroup's `MemoryMax=48G` and resumed from disk with zero lost work, which is that
      containment behaving as designed.

      Note `<!-- image -->` is exactly 14 characters, which is what a placeholder-only markdown
      file measures. Handy when grepping.
- [x] **The 23 `text`-route residue documents — RUN 2026-08-03. 23 ok, 0 failed, all 23 re-routed
      to OCR.** They had never reached `ocr_worker`, so they had never reached tiling: the text
      path's reroute is gated on `size > LOW_YIELD_MIN_BYTES` and all 23 measure under 200 KB
      (5,631 … 193,210 bytes). Run on a 23-id work list with `LOW_YIELD_MIN_BYTES=0`, which also
      removes `decide()`'s small-file escape. **That override breaks `worker.py --selfcheck`**
      (`assert decide([120] * 5, small) == "text"`, "a tiny file must not be sent to the GPU") — a
      correct invariant for the general corpus, which is why it belonged on a 23-document list and
      never on a corpus run. Env restored afterwards; selfcheck passes again.

      22 of 23 improved, 18 now clear `TEXTLESS_CHARS`. Read the distribution, not the headline:

      ```
      22 25 25 28 30 | 47 60 68 75 84 183 | 781 1055 1193 1275 1283 1387 1518 1616 2030 2034 3216 3405
      ```

      Twelve are real page-worth recoveries, six clear the bar without being useful, five are still
      textless. **Corpus residue 184 → 166.**

**THE TILING FIX FAILED 552 OF 623 DOCUMENTS ON ITS FIRST ATTEMPT. Read this before touching
`worker.py`'s render path.** Every failure was `PDFium: Data format error` / `pypdfium could not
load` on files that are not damaged — the same documents converted cleanly minutes later.

Cause: `convert_tiled` rendered pages by opening the PDF with pypdfium2 **in the parent process**.
`worker.py` already carries a comment above `probe_pdf` saying exactly why that is forbidden —
docling uses pypdfium2 too, its converter threads live in the parent, and they touch the same
global state without taking any lock of ours. It silently corrupts rather than crashing. The
comment even records the previous incident (468 failures in two minutes). It was reintroduced
anyway.

**Why the tests did not catch it, which is the transferable part:**
- The 45 host self-checks monkeypatched the render with a PIL fixture, so no test ever opened a
  real PDF.
- The 5-document verification probe ran serially. The bug needs docling's threads and the render
  running **concurrently**, so a serial probe is structurally incapable of showing it.
- A single-path test passing is not evidence when the failure mode IS the interaction.

Fixed by moving the render into the existing `ProcessPoolExecutor` as `tile_job`, matching
`pdfium_job` / `split_pdf`. There is now a regression check that asserts the render is *submitted
to the pool* rather than asserting on output — the output looked fine either way. Blast radius was
contained because `gpu-ingest` was stopped in time: 615 false `.err` files never posted, and the
305 that did post self-healed on re-ingest (`ingestChunks` has no `contentExtracted` guard, so a
successful markdown POST clears the error).
- [ ] **Retrieval scoring** on human-labelled phrases — the verdict metric. Heuristics cannot see
      character-spacing damage (`Tum ble r Ridge` score clean), so only this close the question.
      **Harness written 2026-08-01**: `src/scripts/score-retrieval.js`, read-only, queries through
      `searchChunks()` so it score path API actually serve. Report recall@1/@5/@10 + MRR; MRR there
      because recall@1 cannot tell "ranked second" from "absent". Refuse to run when
      `SEARCH_ENDPOINT` unset — unconfigured search return `[]`, which would print as `recall@1: 0`
      and read as unfindable corpus. **Two human steps left**: write labels (format +
      discipline in `src/scripts/retrieval-labels.example.jsonl`; phrase must come from SOURCE
      document, not extracted markdown, else it retrieve itself and measure nothing), then run it
      **after the extraction run land** — growing corpus make two scorecards incomparable. **The
      run landed 2026-08-02, so that condition is clear.** Split the scorecard by
      `extraction.pdf_backend` too: the corpus is mixed-provenance now.
- [ ] Only then decide on an intake cleaner. On current evidence job small: strip `<!-- image -->`,
      drop chunks that are pure separator furniture. **Not** an OCR re-run.

### 4. Needs a human, not code

- **AI Services Hub registration.** Platform documents that *"Provisioning Azure AI services is
  managed through the AI Services Hub in the Landing Zones"*, requested via
  <https://bcgov.github.io/ai-hub-tracking/>. `demi-search-dev` created directly, without that
  request. Nothing blocked it, nothing broken, but process skipped — submit before this go past dev.
  `rg-epic-search` below hold three Cognitive Services accounts too — same question, different team,
  not ours to file.
- **`rg-epic-search` (test sub `7897ceb1-…`)** — not ours. Inventoried live 2026-08-01; earlier
  entry was wrong on two counts and missed the expensive part.

  | Resource | Reality |
  |---|---|
  | `vm-epic-search-embedder` | `Standard_E32-16ads_v5`, **deallocated**. Compute not billing; OS disk is |
  | `vm-postgresql-vector` | **NOT a VM** — `Microsoft.DBforPostgreSQL/flexibleServers`. Name mislead. SKU/state **unverified** |
  | `epic-search-poc` | App Service, **Running**, `Premium0V3` |
  | `epic-poc-api` | App Service, **Stopped** 2026-08-01, `PremiumV3` |
  | `epic-poc-vector-api` | App Service, **Stopped** 2026-08-01, `PremiumMV3` |
  | `ASP-ui`, `ASP-ui-api`, `asp-vector-api` | Three plans. **Plans bill whether app run or not** — stopping the two apps saved nothing |
  | `ai-di-epic-search`, `ai-cv-epic-search`, `ai-epic-poc-east` | **Three Cognitive Services accounts, not previously recorded.** Doc Intelligence + Computer Vision + one in `canadaeast` |
  | `kv-epic-search`, `saepicstoragelogs`, `law-epic-search`, `gw-epic-search-waf-policy` | Key Vault, storage, Log Analytics, WAF policy |
  | ~8 private endpoints + NICs, 14 `Microsoft.Web/connections` (`office365`/`azurevm` ×7 each) | Logic App connectors. Alert `Failure Anomalies - la-epic-logic-apps` reference Logic Apps **that no longer exist** |

  **Owner is on the resources.** VM carry `account_coding: 1152990370037633129L0122`,
  `billing_group: c4b0a8`, `ministry_name: EAO` — chase that coding rather than asking around. Two
  App Services stopped 2026-08-01, so somebody is still active in there; ask before touching.
  Three Premium-V3 plans, three Cognitive Services accounts and a Postgres flexible server are the
  bill, not the deallocated VM the old entry led with.

---

## Backlog

- **`wwwroot` debris.** Twelve ad-hoc probe scripts at the root of the deployed app —
  `_auditwrap.js`, `_copy.js`, `_copy.log`, `_derive.js`, `_fetch.js`, `_fts.js`, `_idx.js`,
  `_isolate.js`, `_meta.js`, `_param.js`, `_purgewrap.js`, `_syncwrap.js` — plus an empty
  `src/models/`. None in the repo, none reachable as routes, but `config-zip` merge never remove
  them. Clean out through Kudu VFS.
- **Nothing in Azure extracts text.** Ingest exists (external host POST markdown to
  `POST /documents/:id/chunks`); `src/extract.js` run only under `require.main === module`.
  Deliberate — serverless GPU priced and rejected. **Do not delete as dead code.**
- **CI blocked.** `AZURE_CLIENT_ID` missing from repo secrets. Need Entra app registration +
  federated credential; creating one need Microsoft Graph, which conditional access block.
- ~~**`azure-deploy-prod.yaml` / `-test.yaml` trigger on every push to `main`**~~ — **done
  2026-08-01.** Both are `workflow_dispatch` only now; dev keeps its push trigger. Done while CI
  was still dead, so the edit deployed nothing — including the prod workflow's own file, which is
  listed in its own trigger paths. Comments in both files say not to restore it.
- **Phase 3b blob storage** — code + Bicep written, not deployed, nothing copied. Need
  `Storage Blob Delegator` or every download link fail to sign.
- ~~**`syncState` container** exist in `cosmos-nosql.bicep`, unwritten by anything.~~ — **removed
  from template 2026-08-01.** Container still exist in the live account; template not deployed, so
  nothing deleted. Sweep it up with the account teardown. `leases` kept, comment corrected — its
  stated reason (Typesense change-feed sync) died 2026-07-31, but a change-feed trigger stay the
  only route to automatic delete propagation.
- ~~[ ] Verify every `README.md` claim against the running system.~~ — **done 2026-08-01**, live and
  read-only. Confirmed: B1 Basic + `NODE|22`, AI Search `basic` / `disableLocalAuth` /
  `publicNetworkAccess: Disabled`, Cosmos serverless + keyless + private, `ENABLE_ORYX_BUILD=false`,
  no Container Apps, no `nightlySyncTimer`, no `src/models` / `src/db/cosmos.js` /
  `src/helpers/access.js`, test+prod workflows `workflow_dispatch` only. **Two drifts found, both
  need an app-setting write, so both wait for the run to land:**
  - **`COSMOS_NOSQL_DATABASE` not set** on `demi-api-dev`. Right database reached only via the
    `|| 'demi'` default in `src/db/cosmos-nosql.js:37`. The explicit setting IS the guard against
    the repoint that once served `[]` with HTTP 200.
  - **`STORAGE_BACKEND` not set.** `src/config.js:69` default to `minio`, which is right for dev, so
    nothing broken — but the "never a side effect" rule is being carried by a default.
- **`azure-deploy-dev.yaml` would deploy `main.bicep`** on any push to `main` touching `azure/**`,
  and redeploy the API in the same run. `main.bicep` never instantiate `cosmos-nosql.bicep`,
  `ai-search.bicep`, `identity.bicep`, `document-storage.bicep` or `frontend-web-app.bicep`, and
  there is no VNet in the RG — so it does not describe dev. Inert only because CI cannot auth.
  **Fix the template before fixing the credential.**

---

## Open decisions

| # | Question | Default | Cost of reversing |
|---|---|---|---|
| 1 | Backup mode `Continuous7Days` on dev | Not done | **One-way.** Gain 8h/support-ticket → 7-day self-service, free tier; lose Geo backup redundancy permanently |

Settled, kept only because reversing them is expensive: **index tier** (Basic, `content`
`retrievable: false` — Basic→S1 need a **new service + full reindex**) and **delete propagation**
(hard delete + immediate index delete; the `_ts` high-water mark seeing no deletes is measured, not
assumed).
