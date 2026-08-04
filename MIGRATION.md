# DEMI → Cosmos DB for NoSQL — migration record

> **Living document.** `TODO.md` owns what is left to do; this file owns architecture, measured
> facts and the traps. Full design rationale: wiki `ADR-004-Read-ACL-Authorization-Model` and
> `Environment-Reality-and-Operational-Gotchas`.

**Last updated:** 2026-08-04 · **State:** migration complete. Dev runs on Cosmos DB for NoSQL with
Azure AI Search. Only Phase 8's Azure teardown is open.

---

## Goal

DEMI is the EAO's central store for **Projects** and **Documents**, holding a *merged* model across
`epic.track` (authoritative for projects), `eagle` (richer EA-process data), NRPTI (external
compliance data) and eventually `epic.submit`.

The move off Cosmos DB's **MongoDB API** to its **NoSQL API** with `@azure/cosmos` is done.
`DEMI_PLAN.md` claimed for months this had already happened; it had not, and the half-finished
attempt produced the SQL-string-over-mongo-driver shim whose dropped predicates disabled all access
control (ADR-004).

**Built clean and re-seeded from source — the data was not migrated.** Everything is reproducible
from upstream, and the old database carried Mongoose legacy, 3,382 synthetic project rows, and
`contentExtracted: true` flags with no chunks behind them.

---

## Phase status

| Phase | State |
|---|---|
| **0 — Delete unreachable code** | ✅ `99889e6` — −1,536 lines, 5 latent bugs fixed |
| **1 — Infrastructure** | ✅ `demi-identity-dev`, `demi-cosmos-dev` (10 containers), private endpoint + policy DNS |
| **2 — Data access + authorization** | ✅ Client, repositories, controllers |
| **2b/2c — Delete semantics, object key** | ✅ Hard delete + index removal; downloads verified end to end |
| **3 — Merge engine** | ✅ `src/merge/project.js` + 41 tests on the real 382-record Track dataset |
| **3b — Blob storage** | ⏸ code + Bicep written, **not deployed, nothing copied** |
| **4 — Seed** | ✅ run live — 393 projects · 60,578 documents · 281 boundaries |
| **5 — Cut over** | ✅ 2026-07-30 |
| **6 — Typesense** | ✅ then **deleted entirely 2026-07-31** — replaced by Azure AI Search |
| **F — Cosmos full-text search** | ❌ **ABANDONED 2026-07-31.** Base FTS works and is fast, but fuzzy `distance` is a silent no-op and fuzzy is a requirement. See §F |
| **F2 — Azure AI Search** | ✅ **live 2026-07-31.** Basic, 3 indexes, `_ts` indexers on `PT5M`, OData ACL filter. See §G |
| **7 — Change feed** | ⬜ deferred by design. Indexers pull every 5 min; add when sub-5-minute staleness matters |
| **8 — Decommission Mongo** | 🔶 **code deployed + verified live 2026-08-01**; Azure teardown open, earliest **2026-08-08**. See §B |

### Cutover verified 2026-07-30

| Verified | Result |
|---|---|
| projects / documents / boundaries in Cosmos | **393 / 60,578 / 281** — exactly the dry-run figures |
| `PUT /documents/:id/published` | **401** — the NoSQL-only route is live |
| anonymous project list | **382 of 393**; the 11 hidden are Eagle-only projects whose upstream ACL excludes `public` |
| `isPublished` vs `read[]` drift | **0** |
| forged `x-demi-roles: sysadmin` header | identical results — cannot promote |
| document download | **HTTP 200, `application/pdf`, 84,031 bytes** |

**Project membership comes from Keycloak, via role names** (closed 2026-07-30). Scope arrives as
roles prefixed `project:` — `project:207` scopes the caller to project 207. The prefix is required:
given a bare `ajax`, nothing distinguishes "scoped to the Ajax project" from a role type like
`staff`, and guessing would be a security bug either way.

### How the seed had to run — the plan was wrong

"Run it inside the network via Kudu" **does not work**. Kudu's `/api/command` executes in the **SCM
container**, which has no managed-identity endpoint (`IDENTITY_ENDPOINT`, `IDENTITY_HEADER`,
`MSI_ENDPOINT` all MISSING), and the account is `disableLocalAuth: true`, so there is no key to fall
back on. Opening the firewall is impossible — Azure Policy denies it at the landing-zone level
(`RequestDisallowedByPolicy`, "Azure Cosmos DB should disable public network access").

The **app container** is the only place with both network access and MSI. Reach it over the App
Service SSH tunnel:

```bash
az webapp create-remote-connection -g c4b0a8-dev-rg -n demi-api-dev --port 50123 &
sshpass -p 'Docker!' ssh -c aes256-cbc -m hmac-sha1 -p 50123 root@127.0.0.1
```

`-c aes256-cbc` is **required**: App Service offers only legacy CBC ciphers, which OpenSSH 9+
disables by default (`no matching cipher found`).

Two more things the SSH route needs, both handled by the `_seedwrap.js` pattern:

1. **App settings are injected into the app PROCESS, not the SSH shell** — read them from
   `/proc/1/environ`.
2. **`globalThis.crypto` must be shimmed.** `src/app.js` does it for the web app; a standalone
   script never loads `app.js`, and the Azure SDKs need it on Node 22.

Run with **`--max-old-space-size=224`**: the container has ~1.85 GB with ~330 MB free, and Node's
default heap (~1.5 GB) gets the process OOM-killed with **no error in the log** — it simply vanishes.

### Bugs found during cutover

- **`COSMOS_DATABASE` collision** — both data layers read it, needing `epic` vs `demi`. Setting it
  for the NoSQL client repointed the LIVE legacy app at the empty database; every endpoint returned
  `[]` with HTTP 200 because `queryContainer` swallows the error. Fixed: `COSMOS_NOSQL_DATABASE`.
- **Bulk writes counted as sent, not landed.** First seed reported 60,578 written when 56,317
  existed. `bulkVerified` retries and confirms; the re-run's histogram proved it exactly —
  `{200: 56317, 201: 4261, 429: 105}`.
- **`isPublished` derived from Track's `is_active`**, which is orthogonal to publication. 23 public
  projects read `isPublished: false`, which also 409'd any attempt to publish a document under them.
  It now mirrors `read[]`.
- **Boundary GeoJSON never shipped** — it lives under `frontend/`, which the packager excludes.
  Failed only in Azure, never locally.
- **Oryx ran `yarn install` inside the VNet**, which has no route to `registry.yarnpkg.com`. Set
  `ENABLE_ORYX_BUILD=false`; the zip already ships `node_modules`.
- **Every POST/PUT/PATCH returned HTTP 500 with an empty body.** `api/index.js` hands Express a
  hand-built `req`; Express reparents it onto `http.IncomingMessage.prototype`, whose `_destroy()`
  calls `this.socket.destroy()`. With `socket` a plain `{remoteAddress}` object, reaching EOF threw
  `TypeError: this.socket.destroy is not a function` **from a microtask** — past every try/catch —
  killing the Node worker, which the Functions host silently respawned. GET hid it completely.
  Fixed with `autoDestroy: false` plus a real EventEmitter socket stub; regression test in
  `test/routes/functions-adapter.test.js`.

---

## Remaining work

### A. Extraction

`TODO.md` owns the actionable plan. This section keeps the measurements behind it.

**Shape.** An extraction host posts MARKDOWN to `POST /documents/:id/chunks`; the server chunks it
(`src/chunker.js` is the only chunking implementation) and copies `read[]` from the **live**
document, so an extraction host can never widen a document's visibility. Chunk ids are deterministic
(`<documentId>::p<page>::c<index>`) and `chunks.replaceForDocument` reconciles, so the route is
idempotent and a killed backfill just restarts.

**The backfill runs off-platform on a one-off GPU host** — an ordinary API client using the same
public endpoints and admin key any client would. `GET /documents/:id/download` returns a presigned
URL, so document bytes go straight from the object store and never transit Azure. No repo file,
template or app setting references the host.

**Re-POSTing a failed document clears the failure. There is no guard on `contentExtracted`.**
`ingestChunks` replaces the chunks and patches `contentExtractionError: null` whatever state the
document was in. So a host holding its own done-list requeues by simply posting again — no flag
reset, no admin script, no SSH tunnel. `purge-extraction.js --errors-only` exists for the one case
that cannot fix itself: a document still flagged extracted-with-error is invisible to the host's
`build_worklist`, which asks for `extracted=false`. Without that flag the only lever was a blanket
purge that deleted every good chunk to requeue the failures, because **a recorded failure sets
`contentExtracted: true` exactly like a success**.

#### The 2026-07-30 cascade — one crash, 855 documents, recovered 2026-08-01

**Measured, and reproduced.** The extraction host submitted PDF page-splitting into a shared
`ProcessPoolExecutor`. That class never recovers: once a child dies badly `_broken` is set and every
later submit raises. The raise hit a generic `except` that recorded a DOCUMENT failure, so every
subsequent document was marked extracted with zero chunks and left the work list for good.
Reproduced on the host's Python 3.13 — killing a pool child sets `_broken` to exactly the string
seen across the corpus, `A child process terminated abruptly, the process pool is not usable
anymore`.

The lesson generalises past this host: **an infrastructure failure must never be recorded as a data
failure.** The recording is what made it permanent and silent — 855 documents absent from search
while 842 of them had good markdown sitting on disk the whole time.

| | |
|---|---|
| Recorded as errors in Cosmos | **855** (not the "~1,712" previously stated, which counted `.err` FILES across two directories and double-counted ids) |
| Recovered by re-POST alone | **842** — 863 markdown files posted, **43,003 chunks, 0 failed, 2.2 minutes, zero GPU time** |
| Crash victims with no markdown | 3 — 5 originally, 2 re-extracted in the 2026-08-01 smoke test |
| Genuinely unsupported (`msg`/`doc`) | 8 — correctly flagged |

Throughput of the recovery ingest: ~23,900 documents/hour at `UPLOADERS=4`, 49.5 chunks/document.
Cosmos serverless returned `Request rate is too large` intermittently; the poster's exponential
backoff absorbed it with zero terminal failures.

**What is local and what is not.** Extraction — GPU, OCR, docling, page batching — is entirely
off-platform and free. The only thing crossing to Azure is one JSON POST of markdown per document.
It has to cross because Cosmos is the system of record and AI Search indexes it on `PT5M`; Typesense
was deleted 2026-07-31, code and infrastructure, so there is no local index left to write to.
Cosmos-side maintenance is the one job that must execute INSIDE the VNet, because the account is
private-endpoint-only and keyless — not a preference, a landing-zone policy.

**`extraction` provenance now arrives — first documents carrying it landed 2026-08-01.** The route
had accepted it since `4bddede` and nothing sent it, which is why every quality number below is
unattributable to a path. Verified live on Cosmos:

```json
{"path": "ocr", "engine": "docling+rapidocr (cuda)", "doclingVersion": "2.116.0",
 "options": "{\"force_ocr\":false,\"batch_pages\":25}", "at": "2026-08-01T05:09:15.741294+00:00"}
```

Note `options` comes back as a STRING — `sanitizeExtraction` flattens it with `JSON.stringify` and
caps it at 500 characters, so nesting cannot smuggle in depth. Anything outside the five-key
whitelist is dropped silently, so a typo in the sender is invisible rather than an error.

**How Azure extracts documents for NEW projects is deliberately deferred.** `src/extract.js` stays
for that reason — it is the only in-repo docling client and PDF page-batching code. **Do not delete
it as dead code.** Priced 2026-07-30 and rejected for now: Container Apps serverless GPU in
canadacentral is T4 $0.317/hr, A100 $2.29/hr, and a GPU needs a whole new workload-profiles
environment.

#### Quality — measured 2026-07-31. "OCR is not the problem" — HEADLINE RETRACTED 2026-08-03

**The numbers below stand; the verdict they were read as does not.** The retrieval run found a
defect these heuristics are structurally unable to see (word-joining — every glued fragment is
pronounceable, so it scores clean). Read this section as "the heuristics found little", not as
"the extraction is fine". The scorecard below is the verdict metric.

`src/scripts/audit-chunk-quality.js` scored **1,299 chunks across 400 extracted documents**:

| | |
|---|---|
| Chunks scoring clean | **71.8%** |
| Marginal | 12.4% |
| Garbage | **15.8% — an UPPER bound** |
| Documents in the random stratum with **zero** bad chunks | **30 of 40** |
| **OCR word-salad** (`vowelless-tokens`, e.g. `Cnstum dlld`) | **3 chunks — 0.23%** |
| Documents whose text is nothing but `<!-- image -->` | 8 of 77 sampled, all **presentation decks** |

**OCR debris is 0.23% of chunks.** The dominant defect *visible to these heuristics* was different —
PDFs extracting to **nothing but image placeholders**, in the index and unfindable by content, which
is worse than noisy text. **That one is fixed**: the tiling run recovered 1,855 of 2,039 and the
residue is 166 documents (0.27%), accepted as a floor. See the tiling section below.

**Caveats that belong with the number.** The 15.8% still counts table-of-contents pages as garbage,
so real damage is lower. The 400 documents were taken in Cosmos scan order, which skews heavily
toward Site C hearing exhibits — a sample of that cluster, not of the corpus. And **provenance was
absent on all 400**, so none of it is attributable to the OCR path versus the text-layer path.

Two artefact classes are *text-layer* damage rather than OCR, and matter for where a fix belongs:
`Tum ble r Ridge` / `Ge orge` (character spacing) and `<!-- image -->` (docling's own placeholder,
which `image_export_mode` cannot switch off — it admits only `placeholder`, `embedded`,
`referenced`). The spacing artefact scores CLEAN on every cheap metric, which is why the verdict
metric is retrieval rather than heuristics.

**Three things the instrument got wrong first**, each of which would have sent the fix at the wrong
target:

- **29.1% garbage, first run.** Dominated by `repeated-character-run`, which fired on the dot leaders
  of a table of contents inside a perfectly clean report. Condemning a chunk for the LENGTH of a
  separator run is wrong; the share of the chunk that is furniture is the measure.
- **A hydrology data table scored identically to OCR debris** (vowelless 0.27 vs 0.24) until
  identifiers like `PH12-3-3` and `3E-06` were excluded. Cheap metrics cannot separate the two on
  any single signal.
- **A table of earthquake records** was flagged because tabular detection only understood pipe
  tables. Whitespace columns are still columns.

#### Some "PDFs" in the corpus are saved 404 pages — not an extraction defect

Measured 2026-08-01. `PDFium: Data format error` on a document is worth one check before assuming a
corrupt PDF: fetch the object and look at the first five bytes. At least one document
(`Vol 8 - Map P7 Mineral Titles and Reserves`) stores a **268-byte HTML error page**, captured when
the ORIGINAL ETL fetched the legacy EPIC system, got a 404, and wrote the error body to disk as if
it were the file:

```
fileExt: pdf | mimeType: application/pdf | fileSize: 268
<!DOCTYPE HTML ...><title>404 Not Found</title>
The requested URL /appsdata/epic/documents/p18/d16424/1076007686213_....pdf was not found.
```

The metadata still claims `application/pdf`. The real file is gone from the source system, so
recording an extraction error is CORRECT — there is nothing to extract, and no re-run or engine
change recovers it. **Rate: 2 of 9,034 documents downloaded (~0.02%)**, so on the order of a dozen
corpus-wide. `fileSize` under ~1 KB on a `pdf` is the cheap detector.

Consequence worth stating once: the 60,578 document count slightly overstates retrievable content.

#### Conversion — measured on the landed full-corpus run (2026-08-02)

The 2026-07-30 table further down is superseded. It was taken before the host added its `pypdfium2`
router, when `do_ocr=True` ran on every PDF; routing, not GPU throughput, was the bottleneck.

The corpus is now **mixed-provenance**: everything before 2026-08-02 11:44 was read by
`DoclingParseDocumentBackend`, everything after by `PyPdfiumDocumentBackend` (SIGTRAP note below).
Sidecars record `extraction.options.pdf_backend`. Split any quality measurement on it.

**Why the backend was switched.** `DoclingParseDocumentBackend`'s native page decoder ABORTS THE
PROCESS on some corpus documents — 83 restarts in five hours, all `status=5/TRAP`. With
`faulthandler.register(signal.SIGTRAP)` (which `PYTHONFAULTHANDLER=1` does NOT cover, hence five
hours of silent crashes) 4 of 4 captured traps had an identical top frame:
`docling_parse/pdf_parser.py:757 _ensure_page_decoder`. **A native abort cannot be caught**, so
`fail()` / `defer()` / `missing()` never ran, nothing was recorded, the feeder requeued the same
work, and the run stalled to zero documents in 90 seconds. After the switch: 0 traps, 0 restarts,
~1,400 docs/hr, and three previously-unextractable documents converted first try.

**A third outcome class exists: `missing()`.** A source 404 is neither a document defect nor a
runner fault. It writes no `.err`, so the document stays in the work list for whenever the file
appears, and it does not trip the circuit breaker. Before this, 5,445 unfetchable documents were
recorded as extraction errors and dropped from the work list permanently. A large `unextracted`
count is that class working, not a bug.

| | |
|---|---|
| Throughput after the backend switch | **~1,400 docs/hr** at `CONVERTERS=4` / `TEXT_WORKERS=8`, 64 GB / 16 vCPU |
| Path split, whole corpus | **34,153 text / 17,286 OCR**; 7,628 carry no provenance (extracted before the host sent it, or recorded as an error) |
| Documents with chunks | **53,109 of 60,578** (87.7%) |
| Chunks in Cosmos | **995,316** — 18.7 chunks/document, against 48.1 measured under the pre-accumulation chunker |
| Genuinely unextractable | **~106** (0.18%) — `unsupported format`, `PDFium data format error` |
| Not extractable here at all | **5,802** whose source 404s: the dev object store is a partial copy of prod, not an extraction defect |
| Extracted but textless | **2,039** large-format sheets, `<!-- image -->` only — recovered 2026-08-02, below |

Chunks/document fell from 48.1 to 18.7 because the earlier figure was measured through the
pre-accumulation chunker, which split per paragraph at ~514 characters against a 2,500 target. Not
a regression — the same text in fewer, larger chunks.

**Zero-chunk documents by cause, 2026-08-02** (5,958 flagged extracted holding nothing): 5,802
`download failed: 404` · 73 `unsupported format` · 50 no error at all · 17 `PDFium data format
error` · 10 other download · 5 other · 1 cascade leftover. The 404s were false failures — docling
never read those documents because there were no bytes to fetch. Measured: 4,003 of the 5,802 sit
under an object-store prefix that ALSO holds successfully-downloaded objects with structurally
identical keys (`<prefix>/<32-hex>.<ext>`), so the key scheme is right and those specific objects
are simply absent. 111 prefixes affected, 47 missing entirely. Cleared 2026-08-03, below.

**A recorded failure sets `contentExtracted: true`**, so that flag alone is never evidence of
chunks. The meaningful pair is `(contentPageCount, contentExtractionError)`.

#### Tiling recovery run (2026-08-02 20:47–23:03)

The 2,039 textless documents re-OCR'd by cutting each page into a 3×3 grid with 6% overlap, because
docling normalises a page image to a fixed size before OCR and that puts 6-point labels on a D-size
sheet under RapidOCR's detection floor. Diagnosis table in `TODO.md` §3.

| | |
|---|---|
| Processed | **2,039** in 2.49 h — 0 failed, 0 deferred, 0 source-missing |
| Now holding real text | **1,855 (91%)** — median **299** real characters, p75 552, p90 1,017, max 104,190 |
| Residue | **184 (9%)** — 101 unimproved, 83 under 32 characters. 161 `ocr` / 23 `text` |
| Cosmos | all 2,039 `contentExtracted`, **zero** `contentExtractionError` |
| Search round-trip | **9 of 10** sampled documents retrieve themselves |

**A third provenance class exists now.** Sidecars record `extraction.options.tiled`. Tiled text is
ROUGH where map lettering sits at an angle (`Barrowsources`, `Offsite constnk source Of`), so any
quality measurement splits on `tiled` as well as on `pdf_backend`. And the flag means "tiling beat
the empty pass", **not** "the text is usable" — 83 of the 184 residue documents carry it.

**`contentPageCount` cannot see this recovery.** 1,874 of the 2,039 still read exactly 1 chunk,
because ~300 characters is one chunk either way; what changed is that the chunk now holds text
instead of a 14-character placeholder. Measure the markdown or run a query — not the count.

**The 23 `text`-route residue documents ran 2026-08-03** with `LOW_YIELD_MIN_BYTES=0`, which removes
`decide()`'s small-file escape so they reach `ocr_worker` and therefore tiling. All 23 re-routed to
OCR, 22 improved, 18 clear `TEXTLESS_CHARS`. **Residue 184 → 166.** Read the distribution, not the
headline — six clear the bar without being useful:

```
22 25 25 28 30 | 47 60 68 75 84 183 | 781 1055 1193 1275 1283 1387 1518 1616 2030 2034 3216 3405
```

That override BREAKS `worker.py --selfcheck` (`assert decide([120] * 5, small) == "text"`, "a tiny
file must not be sent to the GPU"), which is a correct invariant for the general corpus. It belongs
on a hand-built work list of the affected documents, never on a corpus run.

#### The tiling fix failed 552 of 623 documents on its first attempt (2026-08-02)

Every failure was `PDFium: Data format error` or `pypdfium could not load` on files that are not
damaged — the same documents converted cleanly minutes later. Cause: `convert_tiled` rendered pages
by opening the PDF with pypdfium2 **in the parent process**. `worker.py` already carried a comment
above `probe_pdf` saying exactly why that is forbidden — docling uses pypdfium2 too, its converter
threads live in the parent, and they touch the same global state without taking any lock of ours.
It corrupts silently rather than crashing. The comment even recorded the prior incident (468
failures in two minutes). It was reintroduced anyway.

**Why the tests missed it, which is the transferable part.** The host's 45 self-checks monkeypatched
the render with a PIL fixture, so no test ever opened a real PDF. The five-document verification
probe ran serially, and the bug needs docling's threads and the render running CONCURRENTLY — a
serial probe is structurally incapable of showing it. A single-path test passing is not evidence
when the failure mode IS the interaction.

Fixed by moving the render into the existing `ProcessPoolExecutor` as `tile_job`, matching
`pdfium_job` / `split_pdf`. The regression check asserts the render is *submitted to the pool*
rather than asserting on output — the output looked fine either way. Blast radius was contained
because `gpu-ingest` was stopped in time: 615 false `.err` files never posted, and the 305 that did
self-healed on re-ingest, since `ingestChunks` has no `contentExtracted` guard.

#### Oversize documents: streaming ingest, and FOUR ceilings (2026-08-03)

15 documents held 13–60 MB of markdown against `express.json({ limit: '10mb' })` (`src/app.js:75`),
so every POST was a 413. They were the only documents with markdown on disk and nothing in Cosmos.
**All 15 now landed: 132,787 chunks, 12/15 retrieve themselves** (the 3 misses are near-identical
review-table text across sibling documents, so their own chunk ranks below `pageSize` — bad labels,
not missing content).

**Why the markdown is 60 MB:** docling renders them as one enormous markdown table, the largest
2,198 lines averaging 28,817 characters. Nothing is malformed; they are genuinely that big.

**Raising the limit is the wrong knob** — a 60 MB body parses to a 60 MB JS string plus parser
buffer on B1 Basic, and the ceiling only moves to the next document, against a roadmap of ~300K.
The fix is `Content-Type: application/x-ndjson` on the same route: line 1 provenance, lines 2..n
JSON-encoded markdown blocks. `express.json` only parses `application/json`, so the body arrives
unconsumed and no route change was needed. Both paths share `createChunkAccumulator`, so a document
chunks identically whichever door it came through.

Only the first ceiling was designed for. **Each of the others surfaced from a real document, never
from a test:**

| Ceiling | Symptom | Resolution |
|---|---|---|
| Memory, 10 MB body | 413 | NDJSON streaming path |
| Transport | `400 empty stream` | App Service drops CHUNKED bodies — send `Content-Length`. See infrastructure traps |
| Time, 240 s | 504 GatewayTimeout | `UPLOADERS=1`; a 31 MB document went 240 s+ → 111 s |
| Throughput | Cosmos 429 | The SDK THROWS a request-level 429 instead of returning per-operation statuses, so `bulkVerified` never retried it. Fixed in the shared function |

**And one bug of our own, which killed the worker six times.** The batch bound was checked between
markdown BLOCKS rather than between chunks, so peak memory followed block size. One 30 MB document
is 2,247 lines with only FIVE blank ones — ~6 blocks of ~5 MB, each emitting well over a thousand
chunks per call. The existing batch test used 900 separate blocks and passed throughout. **A single
huge block is the shape that distinguishes correct from broken.**

Verified at `UPLOADERS=1` only. Whether 4 still fits inside 240 s now that batching is bounded is
untested — do not assume it does.

#### The 5,802 false 404s, cleared 2026-08-03

```
PURGE_RESULT {"mode":"live","errorsOnly":true,"scanned":59082,"documents":5802,
              "chunksRemoved":0,"indexEntriesRemoved":0,"failures":[]}
```

The dry run matched the reconciliation's independently-measured 5,802 exactly, which was the gate
for proceeding. `chunksRemoved: 0` because these documents never held chunks — the run reset false
flags and deleted nothing. Executed via `_purgewrap.js` inside the app container over the App
Service SSH tunnel, because Cosmos is private and keyless.

**The host side is half the job**: `already_done()` treats a local `.err` as settled no matter what
Cosmos says. The `.err` files partition exactly, which is the cross-check that the classification is
right — 5,802 404-class + 840 superseded (an `.err` beside a `.md`) + **106 genuine** = 6,748, and
that 106 matches the independently derived unextractable count. The first two were quarantined;
`worklist.json` was deleted so it rebuilds.

Rebuild verified: **7,298 = 1,496 source-missing + 5,802 purged.** Documents attempted afterwards
record through `missing()` — no `.err`, so they stay honestly in the work list instead of being
falsely marked failed, which was the entire point.

#### Conversion, measured on 326 documents (2026-07-30) — superseded, kept for the memory ceiling

The sample's byte distribution matches the corpus (mean 2.65 MB vs 2.68 MB), so scaling by the mean
holds.

| | |
|---|---|
| Conversion time | median **4.7 s**, mean **21.1 s**, max **227 s** |
| Full corpus at that rate | **354 converter-hours → ~7.4 days** at `CONVERTERS=2` |
| Concurrency | **`CONVERTERS=3` OOM-killed the 16 GiB host at 15.9 GB peak** — docling holds page images for the whole document, so RAM scales with page count. Settled at **2**, plus a semaphore serialising documents over 8 MB |
| Work list | **60,391 documents / 161.8 GB** — 59,752 PDF (98.9%), 639 other |
| Document sizes | median **0.29 MB**, p90 **6.4 MB**, p99 **37 MB**, max **1.26 GB** |
| Corpus, measured through the accumulating chunker | **2.92M chunks / 8.61 GB indexed text** (48.1 chunks/doc, 2,951 chars/chunk, 142 KB/document) |

**GPU throughput is not the bottleneck — routing is.** The converter ran `do_ocr=True` on every PDF,
so digital PDFs with a good text layer were pushed through RapidOCR anyway. The extraction host now
routes first: a `pypdfium2` text-layer probe sends digital PDFs down a CPU-only path, and only image
formats and text-poor PDFs reach the GPU. The router is deliberately biased toward OCR —
mis-routing a scan silently drops the document out of a lexical index, far worse than spending GPU
time on a digital PDF. `msg`/`zip`/`rtf`/legacy `doc` (65 documents) have no docling reader and are
recorded as extraction errors without being downloaded.

**Do not change `TARGET_CHUNK_SIZE`, `MAX_CHUNK_SIZE` or `OVERLAP_SIZE` while ingest is running.**
Chunk ids derive from the split, so a mid-run change orphans every chunk already written instead of
reconciling with it.

#### The retrieval scorecard, first real run (2026-08-03)

`src/scripts/score-retrieval.js` had never executed against live data. It has now, and it earned its
keep: it found a public-facing 400 and named the dominant corpus defect, neither of which any
heuristic had seen.

**Labels came from an INDEPENDENT reader, not from a human, and that is legitimate.** The script's
header says labels cannot be automated. The real requirement is narrower — the phrase must be
independent of *the pipeline under measurement*, because a phrase lifted from docling's own markdown
retrieves itself by construction. Two readers satisfy that and share no code with docling: poppler's
`pdftotext` where a text layer exists, and a `pdftoppm` page render read by eye where it does not.
47 labels, four provenance strata plus a negative control.

**Strata are what the sidecars can PROVE.** `pdf_backend` is recorded on only 2,755 of 51,460
sidecars and the field started being written at **18:45 on 2026-08-02, seven hours after the 11:44
backend switch** — so timestamp alone does not separate the backends. The 11:44–18:45 window is
unattributable and was excluded rather than guessed at.

| Stratum | n | recall@1 | recall@10 | MRR |
|---|---|---|---|---|
| `text` / pypdfium2 | 15 | 0.27 | **0.53** | 0.331 |
| `ocr`, pre-switch (docling-parse) | 15 | 0.20 | **0.53** | 0.258 |
| `ocr`, PyPdfium, not tiled | 14 | 0.14 | **0.50** | 0.233 |
| `ocr`, tiled | 2 | 0.50 | 0.50 | 0.500 |
| **control — textless documents** | 2 | **0** | **0** | **0** |

**Precision: at n≈15 one standard error is ~13 points, so a 95% interval spans roughly ±25.** The
three main strata are statistically indistinguishable from each other. This is a smoke test with a
denominator, not a measurement fine enough to rank strata — do not read the 0.53/0.53/0.50 ordering
as real.

**The control is what makes the rest meaningful.** Both textless documents scored `rank: 0` while
their queries returned 9 and 1,386 matching chunks — the instrument finds documents and correctly
fails to find these. Without it a uniform ~0.5 could not be distinguished from a broken harness.

##### Half the misses are not a corpus problem, and a self-phrase probe proved which half

A uniform ~0.5 across unrelated strata looks like index coverage, not text quality — `demi-chunks`
held 80,354 rows on 2026-08-01 against 995,316 chunks in Cosmos. **That juxtaposition is not
evidence of a gap and should stop being repeated as one**: §G records the first chunk index run at
**80,355 items, count equal to Cosmos `DocumentCount` exactly**, and the 995,316 postdates it — the
corpus grew on 2026-08-02, the index number is simply older than the corpus number. Re-reading it is
still worth doing (it confirms the `PT5M` indexer kept up), but it is a confirmation, not a mystery.
So each of the 22 missed documents
was re-queried with a phrase taken from **its own extracted markdown**. That deliberately violates
the independence rule, which is the point: a self-phrase MUST retrieve its own document if that
document is indexed at all, so the two hypotheses predict different answers.

**14 of 22 came back** — those documents are in the index, so their human-label miss is a genuine
retrieval failure. The other 8 used generic or numeric self-phrases (`REPORT Prepared for: BC Hydro`,
`6070000 6075000 …`) matching 68–6,759 chunks each and were outranked at `top: 10`. **That is a weak
probe, not evidence of absence from the index** — it says nothing either way.

**What this probe does NOT establish, added 2026-08-04.** It proves the documents are indexed. It
cannot identify *why* the human label missed, because a self-phrase is contiguous within one chunk
and composed of tokens that survived extraction **by construction** — so it is predicted to succeed
by the word-joining hypothesis and by the query-shape hypothesis below equally. Per this repo's own
rule, a probe that cannot fail proves nothing about the question it is being used to answer. It
answered "are they indexed" (yes) and was then read as answering "so the cause is word-joining",
which it cannot.

##### The dominant EXTRACTION defect is word-JOINING, and it is OCR-path-specific

*(Heading narrowed 2026-08-04. The 23–29× measurement is solid and is the dominant defect in the
extracted text. That it is the dominant cause of the retrieval misses is a separate claim, and it
has not been established — see "the query is a strict conjunction" below.)*

The self-phrases showed it directly, because they are quoted from the extraction:

```
Laren: Iwant tovoicemyopposition to theKitimat-Summit
linkto aMoFRwebsiteconcerning engineering topicsinre
IN THE MATTER OF ENVIRONMENTALASSESSMENT CERTIFICATE
CommentfromEAoiNFo    4S4 Ph0ae: 1250 723-4656 Fux:
```

This is the **inverse** of the `Tum ble r Ridge` spacing artefact the 2026-07-31 audit predicted, and
it defeats heuristics for the same reason: every glued fragment is alphabetic and pronounceable. A
user searching the words they can see on the page gets nothing, because the index holds one token
where the page has four.

Measured across 400 documents per stratum, rate per 1,000 word tokens:

| Stratum | alphabetic token ≥16 chars | internal lower→Upper | example |
|---|---|---|---|
| `text` | **0.44** | **2.70** | `characterization` |
| `ocr` pre-switch | 10.23 | 17.45 | `tovoicemyopposition` |
| `ocr` PyPdfium | 12.37 | 18.05 | `OfficeofthePremier` |
| `ocr` tiled | 12.76 | **37.57** | `FLOWFROMNORTHWEST` |

**23–29× more frequent on the OCR path.** The `text` figure is the detector's false-positive floor,
not real joining — its own worst example is a legitimate English word. The backend switch did not
help (10.2 → 12.4), and tiling roughly doubles the camel rate, consistent with map lettering.

Two consequences that change the plan:

- **The intake cleaner as specced does not touch this.** Stripping `<!-- image -->` and dropping
  separator chunks is unrelated to a missing space inside a token. This is RapidOCR losing
  inter-word spacing; the fix belongs in extraction or in a decompounding step at index time, and
  either is a new component rather than a filter.
- **`text`-stratum misses remain UNEXPLAINED.** Those documents are indexed and barely joined, yet
  7 of 15 labels still missed. Label length does not predict it (0.75 / 0.43 / 0.53 by word count at
  n=46 — noise). Whatever is happening there is a second, separate cause and has not been found.
  Re-measured at n=39 below; it is not sampling noise.

##### The text stratum re-scored at n=39, and ~0.6 holds

`src/scripts/retrieval-labels-text.jsonl` (25 labels, written 2026-08-01, phrases read from each
source PDF's own text layer with **pypdf**) was sitting unmerged on `demi-todo-corrections` and had
never been run. Cherry-picked to `main` and scored. **Zero document overlap** with the 15 built
2026-08-03, so the two sets pool cleanly.

| Set | n | recall@1 | recall@10 | MRR |
|---|---|---|---|---|
| 2026-08-03, page 1–3, `pdftotext` | 15 | 0.27 | 0.53 | 0.331 |
| 2026-08-01, deeper pages, `pypdf` | 24 | 0.375 | 0.625 | 0.500 |
| **pooled** | **39** | **0.333** | **0.590** | **0.435** |

At n=39 one standard error is ~8 points rather than ~13. **The text path genuinely loses about 40%
of labels at top 10** — that is now a measurement, not a small-sample artefact, and it is the more
important half of the picture because word-joining does not explain it.

**One hypothesis tested and rejected**: that misses cluster on structured page furniture (numbered
headings, table captions, all-caps map annotations) rather than running prose. Measured 0.50 (n=10)
against 0.62 (n=29) — well inside noise at those sizes. Recorded so nobody re-runs it.

##### The query is a strict conjunction — tested 2026-08-04, and it is NOT the cause

`buildQuery` joins every term with **` AND `** (`src/search/ai-search.js:178-193`). Under
`queryType: 'full'` that makes every term mandatory: a chunk is a candidate only if it contains
**all** of them, and BM25 ranks only within what survives that filter. Recall@10 is therefore capped
by `P(all N terms co-occur in one ~2500-character chunk)`, and no ranking work recovers a document
the conjunction already excluded. §G described the per-term shape `(term OR term~1)` and never
recorded the join between terms; this is that omission.

**Measured locally, not inferred** — `tokenize` splits on `[^\p{L}\p{N}]+`, so the real label
`Table 5.1 Expected Case Concentrations (mg/L) of Key Parameters in Morrison Lake` becomes 14
mandatory conjuncts:

```
Table 5 1 Expected Case Concentrations mg L of Key Parameters in Morrison Lake
        ^ ^                            ^  ^                                     under MIN_FUZZY_LENGTH
```

Seven are shorter than four characters, so they get **no fuzzy expansion** and must match exactly.
`5.1` is one token on the index side under `en.microsoft`; the query demands standalone `5` **and**
standalone `1`. If those do not match, the conjunction fails on a document whose text is perfect.
An EA corpus is dense in `5.1`, `Table 3-2`, `mg/L`, `PH12-3-3` — and the text-stratum labels are
drawn from exactly those pages.

**What is measured and what is not.** The tokenization above is measured. That the index side fails
to match `5`/`1` against `5.1` is the untested step, and it needs the service to settle.

**Why it was the leading candidate.** It predicted a ~40% loss independent of extraction path, which
is what the strata show; word-joining does not explain a stratum that barely joins; and both
previously tested hypotheses (label length, page furniture) were properties of the *label*, while
this is a property of the *query builder* and had never been examined.

**The discriminating experiment, and its answer.** The prediction table written before the run:

| | OR-join lifts `ocr` | OR-join lifts `text` |
|---|---|---|
| word-joining dominates | yes, modestly | **no** |
| the conjunction dominates | yes | **yes, sharply** |

Run 2026-08-04, both arms paired in one session against one index state, `--top 10`, fuzzy on,
changing **only** the outer join in `buildQuery` (`src/search/ai-search.js`). The `text` row is the
discriminating one, and it did not move:

| stratum | n | AND r@1 / r@5 / r@10 / MRR | OR r@1 / r@5 / r@10 / MRR | miss→hit | hit→miss |
|---|---|---|---|---|---|
| `A-text` | 15 | 0.267 / 0.400 / **0.533** / 0.331 | 0.267 / 0.467 / **0.533** / 0.356 | 1 | 1 |
| `retrieval-labels-text` (pypdf) | 25 | 0.360 / 0.600 / **0.600** / 0.480 | 0.280 / 0.600 / **0.640** / 0.433 | 1 | 0 |
| `B-ocr-legacy` | 15 | 0.200 / 0.333 / **0.533** / 0.258 | 0.267 / 0.400 / **0.467** / 0.306 | 0 | 1 |
| `C-ocr-pdfium` | 14 | 0.143 / 0.429 / **0.500** / 0.233 | 0.214 / 0.357 / **0.643** / 0.293 | 2 | 0 |
| `D-ocr-tiled` | 2 | 0.500 / 0.500 / 0.500 / 0.500 | 0.500 / 0.500 / 0.500 / 0.500 | 0 | 0 |
| **control — textless** | 3 | **0 / 0 / 0 / 0** | **0 / 0 / 0 / 0** | 0 | 0 |

**Pooled, control excluded: n=71, recall@10 0.549 → 0.577. One SE ≈ 0.059.** The move is half a
standard error. Discordant pairs — the only statistic a paired run at this n earns — are **4
miss→hit against 2 hit→miss**, which is not a lopsided split and carries no significance.

**The four guards, stated before the run:**

1. **The AND arm reproduced the 2026-08-03 baseline exactly** — `A-text` 0.5333/0.3306,
   `B-ocr-legacy` 0.5333/0.2580, `C-ocr-pdfium` 0.5000/0.2328, `D` 0.5, control 0. The index did not
   move under the experiment, so the pairing is valid. The one difference is explained, not drift:
   the pypdf set reads 0.600 at n=25 where the baseline read 0.625 at n=24, because `ff2616a` fixed
   the standalone-`AND` 400 that had errored one label out of the old denominator. The same 15
   documents were found.
2. **The negative control stayed at 0 in both arms.** An OR join is exactly the change that could
   make textless documents start scoring by coincidence; it did not.
3. **recall@1 and MRR did not survive.** On the largest set the OR arm went 0.360 → 0.280 at rank 1
   and 0.480 → 0.433 MRR. OR admits candidates; it does not place them.
4. **The knob demonstrably reached the wire.** Median `matchingChunks` per label went from ~15–21
   under AND to **525,000–775,000** under OR — four to five orders of magnitude, i.e. essentially
   corpus-wide candidate sets. The null result is a real measurement, not an unthreaded flag.

**Verdict: the conjunction is rejected as the cause of the ~0.5 recall.** The observed cell is the
top row of the prediction table (`text` unmoved), and even the `ocr` half is equivocal —
`C-ocr-pdfium` gained two labels while `B-ocr-legacy` lost one.

**The mechanism check refutes it a second time, independently.** Bucketing labels by "contains a
token `tokenize` splits on punctuation" (`5.1`, `mg/L`, `PH12-3-3`) — the free companion analysis —
puts the entire nominal lift in the **wrong** bucket: punctuation-split phrases went 0.611 → 0.583
(n=36, *down*), plain phrases 0.486 → 0.571 (n=35). If manufactured conjuncts were the mechanism,
the lift would land on the split bucket. It lands on the other one, which is what noise looks like.

**What this buys, beyond closing a hypothesis.** Under the OR arm the candidate set is effectively
the whole corpus and BM25 alone chooses the top 10 — and the missed documents *stayed* missed. A
document that is excluded by a filter reappears when the filter is removed; these did not. That is
positive evidence that the misses are not a candidate-selection problem at all, and points back at
whether the phrase is in the extracted text in a matchable form. It does **not** single out
word-joining, which remains uncontrolled.

It also weakens the seam-straddling case below on the same logic: a phrase split across two disjoint
chunks satisfies no *conjunctive* query but would match both halves under a disjunctive one, so it
should have surfaced here. Recall barely moved.

**Reproducing this.** The label sets are now committed (`src/scripts/retrieval-labels-{A-text,
B-ocr-legacy,C-ocr-pdfium,D-ocr-tiled,E-control-textless}.jsonl`) — until 2026-08-04 they existed
only on one host, and no number in this section was reproducible from a checkout.
`score-retrieval.js --labels <file> --top 10`, run inside the app container over the SSH tunnel
(§ "How the seed had to run"), gives the AND arm. The OR arm was produced by changing the join in
`buildQuery` — `.join(' AND ')` → `.join(' OR ')`, one line — and re-running the same command;
write the two reports to different `--out` files, because two reports off one labels file are
otherwise indistinguishable.

**The knob is not in the code.** The experiment ran behind a temporary `anyTerms` parameter, which
was removed once it answered: the arm is rejected, no controller would ever pass it, and a live
search parameter that exists only to be false is a thing to maintain rather than a finding. Flipping
the join permanently would trade rank-1 precision for nothing.

**`MAX_TERMS = 16`'s stated rationale is backwards.** `ai-search.js:41` reads *"beyond this the query
grows without adding recall; BM25 is already dominated by the rest."* Under a conjunction each extra
term is a **filter**, not a ranking contribution — it can only *reduce* recall. The cap is currently
protecting recall by accident, and the comment as written would justify removing it.

##### The phrase is in the chunk — the misses are search-side (measured 2026-08-04)

The probe every earlier hypothesis was missing. All four rejected explanations were about the
*query*; nobody had checked the link in the middle. `src/scripts/probe-phrase-presence.js` reads each
labelled document's chunks **from Cosmos** and finds the strictest rung at which the phrase is
present: `exact` → `whitespace` (collapse+lowercase) → `punct` (NFKD, all `\p{P}\p{S}` to space) →
`despaced` (all spaces deleted, both sides).

It must read Cosmos. `content` is `retrievable: false`, so the search service cannot return chunk
text on **any** plane — a data-plane query returns highlight fragments only. An earlier note in
`TODO.md` said otherwise and was wrong.

**Result, 71 labels plus the 3-label textless control:**

| | phrase present (`exact`/`whitespace`/`punct`) | `despaced` | `straddle-*` | not contiguous |
|---|---|---|---|---|
| **retrieval hit** (n=39) | 32 | 2 | 0 | 5 |
| **retrieval miss** (n=32) | **25** | **3** | **0** | 4 |

**78% of the misses have the phrase sitting verbatim in a stored chunk.** On the `text` strata it is
16 of 17. Extraction is not what is costing recall.

**Word-joining is 3 of 32 misses — 9%, all OCR strata, all `joined`.** It is real, it is measured,
and it is an order of magnitude smaller than the 23–29× token-rate figure implies for *retrieval*.
The rung is symmetric (`Tum ble r Ridge` matches it too), so the script reports `joined` vs `split`
from the space-count delta; every case found was `joined`.

**`straddle-*` is ZERO.** Not one label in 74 was present only across a chunk seam. The overlap
defect below is real as a chunker bug and costs approximately nothing in retrieval — the ~3–4%
estimate was never measured, and the measurement is 0/74.

**The guard fired, and the answer is that the guard was wrong.** Five retrieval *hits* classified as
non-contiguous, which the pre-stated guard called "instrument broken, stop". Checked before reading
anything else: all five have `coverage: 1` and no missing tokens, and the chunk for
`5887df83f64627133ae5abd6` reads *"the proposed CCS Sunrise Secure Landfill Project **(proposed
Project)** and the section 10 Order"* against a label that dropped the parenthetical. The instrument
is right and the guard's premise was wrong: **the ladder tests contiguity, while search tests token
co-occurrence within a chunk.** Under the ` AND ` join a document ranks when one chunk holds all the
terms in any order — contiguity was never required. `absent` in this report means "not contiguous",
and `coverage` is what says whether the words are there at all.

##### So where do the misses go? Not coverage, not ranking — the fuzzy term (2026-08-04)

Follow-ups, same session:

- **Re-scored at `--top 50`.** Of the 25 misses whose phrase is verbatim in a chunk, only 4 appear at
  rank 11–50. **21 are not in the top 50 at all**, and two return `matchingChunks: 0` — a query whose
  exact phrase is in Cosmos matching *nothing corpus-wide*. That is not a ranking problem.
- **Index coverage is ruled out, properly this time.** `searchChunks({matchAll: true})` — the
  `matchAll` path already existed and no caller used it — reports **1,128,736 rows in `demi-chunks`**
  against ~1.13M chunks in Cosmos. The `PT5M` indexer kept up. The open "re-read it to confirm" in
  `TODO.md` is now closed. Spot-checked per document too: both sampled miss documents have 2 chunks
  in Cosmos and 2 indexed.

That leaves the query analyzer, and `buildQuery` has a mechanism sitting in plain sight. It emits
`(term OR term~1)`, and — as `ai-search.js:170-176` already says — **a fuzzy term bypasses the query
analyzer**. So `~1` demands a literal against an index side that is lemmatised and stopword-stripped
under `en.microsoft`. A phrase like *"Sediments **from** the proposed Lodgepole mine **will** move"*
carries several stopwords; each contributes a clause that can match nothing, and under the ` AND `
join one such clause zeroes the entire query. That is exactly the `matchingChunks: 0` signature.

**Tested by re-scoring with `--no-fuzzy`, paired on the same labels:**

| stratum | n | fuzzy r@1 / r@10 / MRR | **no-fuzzy** r@1 / r@10 / MRR | miss→hit | hit→miss |
|---|---|---|---|---|---|
| `A-text` | 15 | 0.267 / 0.533 / 0.331 | 0.200 / **0.667** / 0.361 | 2 | 0 |
| `retrieval-labels-text` | 25 | 0.360 / 0.600 / 0.480 | **0.440** / **0.640** / 0.527 | 1 | 0 |
| `B-ocr-legacy` | 15 | 0.200 / 0.533 / 0.258 | 0.200 / 0.533 / 0.293 | 0 | 0 |
| `C-ocr-pdfium` | 14 | 0.143 / 0.500 / 0.233 | 0.143 / **0.643** / 0.277 | 3 | 1 |
| `D-ocr-tiled` | 2 | 0.500 / 0.500 / 0.500 | 0.500 / 0.500 / 0.500 | 0 | 0 |

**Pooled recall@10 0.549 → 0.620 (+0.070, ~1.2 SE), on 6 miss→hit against 1 hit→miss.** Unlike the
OR-join arm, **MRR improved in every stratum** and no stratum got worse — recall and ranking moved
together, which is what a real fix looks like rather than a candidate-set dilution.

**Not shipped as a blanket change** — turning fuzzy off wholesale would cost the typo tolerance it
was added for. The fix below targets the interaction instead.

##### The fix: no unanalyzed variant on a term the analyzer removes (2026-08-04)

**Confirmed on one document, which is what turned this from a story into a cause.** Label
*"Sediments from the proposed Lodgepole mine will move downstream and accumulate"*, document
`5887d059ff41b812b1cfce46`, one chunk, holding that sentence **verbatim** and **indexed** (Cosmos 1
chunk, index 1 row; individual words from the chunk match under a `documentId` filter). Querying the
full phrase restricted to that document:

| | count |
|---|---|
| `fuzzy: true` (production) | **0** |
| `fuzzy: false` | **1** |

**Mechanism, stated precisely.** `en.microsoft` removes some words at query time — measured by
single-term search with fuzzy off, which returns 0 for `from`, `mine`, `that`, `with`, `those` and
the reflexive pronouns. For such a term the analyzed side of `(term OR term~1)` contributes nothing,
so **the unanalyzed `~1` side becomes the only thing the clause can match** — and it matches by edit
distance against whatever unrelated tokens happen to sit within distance 1. The clause is then a
near-random *mandatory* filter: `from` matches 81,731 chunks corpus-wide but **0** inside the target
document, so the conjunction discards the one right answer. Without fuzzy the term analyzes away and
is dropped harmlessly, which is why `--no-fuzzy` found it.

Two things that look like the cause and are not, both measured and both worth not re-testing:

- **Short stopwords are innocent.** `the`, `of`, `and`, `d` return 0 as single-term queries, which
  looks damning, but adding them to a real query changes its hit count by nothing (9132 → 9132,
  126 → 126). They are under `MIN_FUZZY_LENGTH`, so they never get a variant, and the analyzer drops
  them. A single-term probe cannot tell "analyzer removed it" from "matches nothing" — that
  conflation sent this investigation down a wrong path for an hour.
- **Index coverage, again.** All three zero-match documents have every Cosmos chunk present in the
  index.

**The list is measured, not guessed** (`ANALYZER_STOPWORDS`, `ai-search.js`): 20 terms of
≥ `MIN_FUZZY_LENGTH`. Sweeping all **360** distinct ≥4-char terms in the label corpus found exactly
6 analyzer-removed words, 5 already listed; the sixth was `monirose`, OCR garbage that returns 0
because it is genuinely absent, **not** because it is a stopword — and a rare misspelling is exactly
the case fuzzy exists to rescue, so it must stay out of the list. Regenerate with
`searchChunks({keywords: word, fuzzy: false})`; the Analyze API is a 403 for the app identity.

**Result, paired, both arms in one session:**

| stratum | n | before r@10 / MRR | after r@10 / MRR |
|---|---|---|---|
| `A-text` | 15 | 0.533 / 0.331 | **0.600** / 0.364 |
| `C-ocr-pdfium` | 14 | 0.500 / 0.233 | **0.643** / 0.340 |
| `B-ocr-legacy` | 15 | 0.533 / 0.258 | 0.533 / 0.258 |
| `D-ocr-tiled` | 2 | 0.500 / 0.500 | 0.500 / 0.500 |
| `retrieval-labels-text` | 25 | 0.600 / 0.480 | 0.600 / 0.480 |
| **control — textless** | 3 | **0** | **0** |

**Pooled recall@10 0.549 → 0.592, on 3 miss→hit and 0 hit→miss.** No stratum regressed and the
control held. The three recovered documents come back at ranks **2, 1, 2** — near the top, which is
what removing a blocking clause should look like when the chunk holds the phrase verbatim, and each
of the three contains a listed stopword.

**Honest limits.** n=71 with 3 discordant pairs is McNemar p = 0.25; the case rests on the
single-document proof and on the change being non-harmful by construction (it only ever deletes an
unsatisfiable clause), not on the aggregate. Blanket `--no-fuzzy` still scores 2 labels higher
(44 vs 42) — that residue is **not** more stopwords, since the vocabulary sweep came back clean. It
is fuzzy diluting BM25 on ordinary terms, a ranking effect rather than a zeroing one, and worth its
own experiment before anyone trades away typo tolerance for it.

#### The fuzzy down-weight — RAN 2026-08-04, and it is ACCEPTED

That residue experiment. If the fuzzy arm competes with the exact arm on BM25 score, a document
matching only by edit distance can outrank one holding the term verbatim — so keep `~1` but score it
lower: `(term OR term~1^0.5)`.

Paired, both arms in one session, same 71 labels plus the textless control, run inside the app
container over the SSH tunnel (the data plane is private and keyless, so there is nowhere else):

| stratum | n | r@10 before / after | MRR before / after |
|---|---|---|---|
| `A-text` | 15 | 0.600 / 0.600 | 0.364 / **0.375** |
| `B-ocr-legacy` | 15 | 0.533 / **0.600** | 0.258 / **0.268** |
| `C-ocr-pdfium` | 14 | 0.643 / 0.643 | 0.340 / 0.340 |
| `D-ocr-tiled` | 2 | 0.500 / 0.500 | 0.500 / 0.500 |
| `retrieval-labels-text` | 25 | 0.600 / **0.640** | 0.480 / **0.528** |
| **control — textless** | 3 | **0** / **0** | — |

**Pooled recall@10 0.592 → 0.620 (42 → 44 of 71). recall@1 0.282 → 0.310. MRR 0.382 → 0.403.
2 miss→hit, 0 hit→miss, no stratum regressed.**

**Why this ships where `anyTerms` did not.** The rule was stated before the run: ship only if
recall@10 improves *and* neither recall@1 nor MRR regresses. `anyTerms` failed exactly that test —
it bought recall@10 and cost precision. Here all three move the same way, and the change lands on
**the same 44 labels blanket `--no-fuzzy` reaches**, so it recovers the residue without giving up
typo tolerance. That was the whole point of trying it.

Eight of 71 ranks moved: five improved (3→2, 6→4, 2→1, 2→1, and one 0→5), two slipped slightly but
stayed on the page (9→10, 7→8), and one miss came back at 10. The two slips are the mechanism
working as intended — those were fuzzy-only matches being demoted beneath exact ones.

**Honest limit: 2 discordant pairs is not significant.** One SE is ≈0.059 on this label set and the
move is half of that. This is *not* a demonstration that the corpus got better; it is a consistent
directional result with zero regressions on a mechanism with a clear story. Treat 0.620 as the same
number as 0.592 until the label debt is paid and n is larger.

Shipped as a constant, `FUZZY_BOOST` in `ai-search.js`, not a knob — the experiment's `--fuzzy-boost`
plumbing was removed in the same PR that recorded the answer, which is the lesson `anyTerms` taught.
**§3's `--no-fuzzy` residue item is closed.**

##### Chunk overlap is not applied on the common path — measured 2026-08-04

`chunker.js` documents itself as "paragraph/section-aware with overlap" and `OVERLAP_SIZE=200` is
configured, but `emit()` calls `splitText()`, which returns the block **unchanged** when it is under
`MAX_CHUNK_SIZE` (4000). Blocks are emitted once they pass `TARGET_CHUNK_SIZE` (2500), so the
typical chunk is 2500–4000 characters and never reaches the overlapping branch.

Measured by running the real `chunkMarkdown` over 40 × 300-character paragraphs:

```
chunk lengths          2743, 2751, 2752, 2752, 1222
consecutive pairs sharing an OVERLAP_SIZE boundary    0 of 4
a phrase spanning a seam, found in any single chunk   no
oversized-single-block path (10,000 chars)            2 of 2 pairs DO overlap
```

**Overlap works only in the branch where it is rare and is absent in the branch that produces nearly
every chunk.** Consecutive chunks are strictly disjoint, so a phrase crossing a seam cannot satisfy a
conjunctive query from any single chunk — it compounds the finding above rather than standing alone
(seam-straddling is on the order of 3–4% of phrases at these sizes, not 40%). The fix belongs in
`emit()`, not `splitText()`. `test/chunker.test.js`'s "a single oversized paragraph is split, with
overlap" asserts only `length <= 4000` and never asserts overlap, which is why this survived.

Note the constraint below — chunk ids derive from the split, so this and any other chunker change
must land in ONE re-ingest, not two.

##### `pageNumber` is a sequence number, and the text path already has the real one

`chunker.js:57-58` explains the field as a sequence number because "docling returns one markdown
string with no page boundaries". True for the OCR path. **Not true for the text path**, which is
34,153 documents — 56% of the corpus: `extract_text` iterates pages explicitly and joins them with
`\n\n`, discarding the page index at the moment it holds it.

Consequence: search results cannot cite a page, and a summariser built on these chunks cannot
produce a verifiable citation. The field is already in the schema, already selected by
`searchChunks`, and already returned to callers — carrying a meaningless number. Cheapest correct
version is for the host to emit `[{page, markdown}]` on the text path and thread it through
`createChunkAccumulator`; the OCR path keeps sequence numbers. Group it with the overlap fix into
the same single re-ingest.

**Re-ingest does not need the GPU** — the extracted markdown is retained on the host in `sent/`
(the 166-residue count was independently reproduced from `sent/*.md`), and the ingest path moved
43,003 chunks in 2.2 minutes during the cascade recovery. Verify retention across the full corpus
before planning on it.

**The AND/OR/NOT 400 was hit independently by both label sets** — `EAST TOBA AND MONIROSE …` and
`TERRESTRIAL ECOSYSTEM MAPPING (TEM) POLYGONS AND FIELD PLOT LOCATIONS`. 2 of 72 labels across two
sets built a day apart by different means, so the real-world exposure is on the order of a few
percent of natural queries, not a curiosity.

**`retrieval-labels-ocr.jsonl` was cherry-picked but deliberately NOT scored.** Its own header says
the 25 lines are CANDIDATES seeded from document titles, which are metadata and not verified to be
on the page — scoring them would measure the title, not the extraction. They need an eye on each
scan first.

##### A standalone AND / OR / NOT in any public query returned HTTP 400

Found on the control label `EAST TOBA AND MONIROSE HYDROELECTRIC PROJECT`:
`Failed to parse query string at line 1, column 42`. Column 42 is exactly where the bare `AND`
lands in `(EAST OR EAST~1) AND (TOBA OR TOBA~1) AND AND AND …`.

`tokenize` splits on non-alphanumerics, so it strips operator *punctuation* but cannot strip a
*word*; `AND`/`OR`/`NOT` are case-sensitive Lucene booleans under `queryType: 'full'` and reached
`buildQuery` as ordinary terms. A test asserted the safe-looking half of this (`tokenize` returns
them as words) with a comment claiming a user typing `OR` "searches for that word" — it does not,
it gets a 400. **An assumption written into a test but never put to the service.**

Fixed in `buildQuery` by lowercasing the three reserved words: the operators are case-sensitive and
the index side is lowercased by `en.microsoft`, so the term still matches. One place, all datasets.

#### Secret rotation

`/home/site/wwwroot/.env` shipped in every deploy from 2026-07-24 until `639269b`, mode `rwxrwxrwx`.
`scripts/package-api.py` had no `.env` exclusion; the CI workflows did, but CI is dead on the
missing `AZURE_CLIENT_ID`, so the script was the only live path. **Never committed** (`.gitignore:5`,
confirmed across all history) — a packaging leak, not a repo one — and no entrypoint loads `dotenv`,
so the file was inert on disk.

| Key | When | Why |
|---|---|---|
| `DOCLING_API_KEY` | **now** | It was a live *inbound* sysadmin credential until `4bddede` split `ADMIN_API_KEY` out. The extraction host does not use it |
| `MINIO_SECRET_KEY` | **hold until extraction finishes** | It signs the presigned download URLs the extraction host fetches document bytes with |
| `MONGODB_PASSWORD` | whenever | Legacy layer only; goes away with the account |

**`DOCLING_API_KEY` was DEMI's only admin credential.** `src/helpers/auth.js` had it in `validKeys`,
so the secret DEMI sends OUTBOUND to docling was simultaneously an INBOUND sysadmin credential — a
logged request header or a compromised extraction host was full admin. Split out to
`ADMIN_API_KEY`; the old key now 401s.

### B. Phase 8 — decommission the MongoDB-API account

**Code done, deployed and verified live 2026-08-01. App settings and the private endpoint removed
2026-08-04 — the rollback is burned. The account itself still stands.**

**The clean week was ended early on purpose, and the reasoning is worth keeping.** A soak window
measures latent regressions under real traffic; DEMI has none — dev-only, no users, active
development. What replaced it was two measurements. First, the account was already idle: exactly one
non-zero hour of `TotalRequests` in the 48 hours to 2026-08-04 (62 requests), and zero on the day
itself, before and after the change. Second, waiting was not buying recoverability — backup is
**Periodic, 8-hour retention**, so after deletion there is a support-ticket restore for eight hours
and then nothing. The window protected *reachability*, not the data, and reachability is worth
little when nothing is reaching for it.

**Generalise it:** a soak period is an instrument, and an instrument with no signal on its input
measures nothing. Check whether traffic exists before spending days waiting on it.

Live evidence, five probes, one output file each:

| Probe | Result |
|---|---|
| `GET /db/stats` | `driver: azure-cosmos-nosql`, `database: demi`, **393 / 60,578 / 281**, ~0.7 s |
| ACL gate | search path (OData) anonymous **0** / privileged **1** on a throwaway non-public project; point read, index-free, anonymous **404** / privileged **200**. Probe deleted, `removedFromSearch: 1`, index hits **0** immediately |
| Fault fallback | `SEARCH_ENDPOINT` at a bad host + nonsense term → **10** on Document and Project (fallback fired; healthy is 0). `DocumentChunk` 0 both — no fallback by design |
| Patch-not-replace | wildfire sync (815 wildfires, 392 projects), then NRPTI sync. All 393 track projects read individually: `sources.track` byte-identical **393/393**, `sources.wildfire` byte-identical **393/393**, `sources.eagle` intact, embedded `nrptiRecords[]` **0** |
| Removed routes | `GET /admin/logs`, `GET /wildfires` → **404** anonymous and privileged; `X-Request-ID` still present |

**Three of the five probes as originally written could not fail** — see *Measuring* below, which is
the durable lesson. The traps hit while running them are in *Operational gotchas*.

Side effect worth knowing: the NRPTI sync grew projects **393 → 2,248** and records **0 → 48,086**.
`trackOnly` keeps them out of default search. It may be **incomplete** — the sync outlived its 504
and was still running when the app-setting restart landed on it; counts are static, but
finished-versus-killed is not distinguishable from outside. Re-run with `?async=true` if a complete
record set matters.

The blocker was never the file list — it was that deleting `src/models/*` broke **boot**, not a
route:

```
src/app.js  ->  src/utils/logger.js:6  ->  require('../models/log')  ->  src/db/cosmos.js
```

`src/utils/logger.js` is loaded by `src/app.js`, `src/server.js`, `src/middleware/request-id.js` and
`src/middleware/http-logger.js` — core boot path, none of it legacy. It was done first, by DROPPING
the Cosmos log transport rather than porting it: App Service already ships stdout to Log Analytics.
`GET /admin/logs` went with it.

Six more files read through the Mongo layer while being required **unconditionally** by
`routes/api.js`. All ported to `src/repositories/*` and `access-sql.js`:

| File | Was | Now |
|---|---|---|
| `src/utils/logger.js` | `models/log` transport | console only |
| `src/controllers/search.js` | `models/{project,document}`, `helpers/access` | `projectsRepo` / `documentsRepo` `listVisible` |
| `src/controllers/db.js` | four `countDocuments()` | `countVisible` under `systemAccess()`; seed handlers deleted |
| `src/controllers/log.js` | `models/log` | deleted |
| `src/controllers/wildfire.js` | `models/wildfire` | read route deleted; admin sync kept |
| `src/scripts/sync-nrpti.js` | `models/{record,project}` | `recordsRepo` + `patchNrptiStats` |
| `src/scripts/sync-wildfires.js` | `models/{wildfire,project}` | `repositories/wildfires` + `patchWildfireStats` |

Three things the port had to CHANGE rather than carry, each a live defect in the Mongo original:

1. **`sync-nrpti` embedded every record object into its project**, twice — `nrptiRecords` and
   `sources.nrpti.records`, each with the raw upstream payload. ~250 records exceeded the 2 MB
   Cosmos item cap; Mongo's 16 MB limit hid it. Now the bounded aggregate via `patchNrptiStats`.
2. **Both syncs wrote whole items back** (`Project.upsert(proj)`), which silently discards whatever
   another sync wrote in between. Both now patch a single path.
3. **`sync-nrpti` wrote `project` and `nrptiSchemaName`.** The container partitions on `/projectId`,
   and `nrptiSchemaName` was only ever a Typesense index field — every Cosmos query filtering on it
   matched nothing. Now `projectId` and `dataset`.

Also deleted: `src/scripts/{seed-and-merge,sync_from_openshift,nightly-sync,backfill-read-acl}.js`
and the `/db/seed`, `/sync`, `/admin/sync`, `/admin/seed-track` routes that drove them —
`seed-nosql.js` reproduces all of it and runs inside the network, past any request timeout.
`readFilter` tier 3 went with `helpers/access.js`; `readClause` in `access-sql.js` never had that
tier, because every seeder writes `read[]` explicitly.

**`mongodb` is GONE from `package.json`** (2026-08-04). It stayed for a while because
`src/extract.js` was its only user and that file is deferred-not-dead — with a `main()` guard that
threw when no Mongo URI was configured, so a post-teardown run errored instead of silently
connecting to localhost and reporting zero documents.

That guard is gone too, because what it guarded is gone: once the account was unreachable, the
Mongo-driven half of `extract.js` could not run in either direction, so keeping it meant keeping a
script whose only possible outcome was that error. The file was reduced to what the deferral was
actually protecting — `extractWithDocling` and `splitAndExtract`, the docling client and the
10-page PDF batching — and the query loop, `replaceChunks` (a `deleteMany`→`insertMany` that left a
window with zero chunks for a live document), `markDocument` and the `yarn extract*` scripts were
deleted with it. The dead `mongoUri`/`cosmosDbUri` builders in `src/config.js` went at the same
time; nothing read them, and they defaulted to `localhost:27017`.

`splitAndExtract` got its first test in the process, which caught a real bug: `getPageCount()` sat
outside the try that was supposed to make an unparseable PDF fall back to a whole-file send, so a
PDF that loads but has a broken page tree threw instead of degrading.

**Nothing left to do — Phase 8 closed 2026-08-04.** The Bicep edits landed 2026-08-01; the app
settings came off and `demi-mongo-pe` plus its NIC went earlier on 08-04; and the account
`demi-mongo-dev-pcbd7cygyic52` was deleted last, after `TotalRequests` was re-confirmed at **0
across the preceding 24 hours**.

Its configuration was captured before deletion — `kind: MongoDB`, `EnableServerless`, Canada
Central, Periodic backup on a 240-minute interval with **8-hour** retention, Geo redundancy,
`publicNetworkAccess: Disabled` — so the shape is reproducible even though the data is not. Three
databases went with it (`demi-dev`, `test`, `epic`), taking the orphaned `syncState` container that
had already been removed from the template but still existed in the account.

Verified immediately after: `/projects` and `/documents` returned 200, `/search?dataset=DocumentChunk`
still reported `count: 29392`, `az cosmosdb list -g c4b0a8-dev-rg` returned only `demi-cosmos-dev`,
and no orphan private endpoint or NIC remained — `pe-cosmos-nosql-dev` and `pe-demi-search-dev` are
both load-bearing and untouched.

Correcting a figure this document carried for a while: **the private endpoint was never "the only
flat recurring charge (~$7/mo)"**. The resource group held three, and the ~29 CAD/month Virtual
Network line was split across them, so removing `demi-mongo-pe` took roughly a third of it — about
10 CAD/month, not the whole line.

### C. Phase 3b — document storage on Azure Blob (optional)

Code and Bicep written and validated; **nothing deployed or copied**. Not urgent: the dev MinIO
bucket already has 100% blob coverage for all 60,578 documents. ~200 GB Cool LRS is ~$2.20/mo plus
~$0.35 one-time. The argument for doing it is per-environment isolation, not cost. Detail below
under *Object storage*.

### D. Verification not yet exercised live

- **Scoped and fragment access tiers** — unit-tested only; no scoped Keycloak role exists yet.
  Create a `project:<id>` role on a test user to exercise it end to end.
- **Boundary rendering at all three frontend fidelities** — the API contract is verified
  (`/boundaries` and `/boundaries/<name>` both 200), the visual result is not.

---

## §F. Cosmos full-text search — RULED OUT 2026-07-31

**Record of a dead end. Nothing here is work.** Kept so nobody re-attempts it; re-deriving it costs
a session several hours.

Base FTS works and is fast (0.3-0.9 s, ~25 RU per ranked query, ~$8-9/mo — by far the cheapest
option costed). **It was still rejected, because fuzzy is a hard requirement and Cosmos cannot serve
it.** The backfill never ran; `chunks_fts` held 0 rows and is deleted, along with `COSMOS_FTS_FUZZY`,
`searchText`, `queryRanked`/`drainRanked` and `buildSnippet`.

### Six silent-failure traps — none errors, all return zero

**None documented by Microsoft. Each cost real time.** Traps 1-5 are properties of the Cosmos SDK
and apply to any ranked query, so they outlive the decision.

1. **`fetchNext()` returns empty early pages for ranked queries.** Measured: `fetchAll` → 5 hits /
   24.72 RU; one `fetchNext` → **0 hits / 4.83 RU with `hasMoreResults: true`**; draining 3 pages →
   5 hits. `src/db/cosmos-nosql.js:query()` runs exactly one `fetchNext()` whenever `maxItemCount` is
   set, so every repository method built on it returns nothing for a ranked query. This produced
   three wrong diagnoses during the spike.
2. **Index lag after a bulk load.** Ranked queries return 0 until
   `x-ms-documentdb-collection-index-transformation-progress` (container read with
   `populateQuotaInfo`) reaches **100**. `FULLTEXTCONTAINS` masks it by scanning; `ORDER BY RANK`
   cannot. **Poll it before any cutover.**
3. **`distance: 3` returns 0 rows and does not error.** The documented max is 2.
4. **`ORDER BY RANK` without a `WHERE` returns everything**, ranked but unfiltered.
5. **A ranked query matching ZERO rows against a POPULATED container blocks the Node event loop.**
   The worst of the six. `FULLTEXTCONTAINSALL` + `ORDER BY RANK` that matches nothing spins
   **synchronously** inside the SDK's client-side merge: the whole app stops answering —
   `/api/config` included — for minutes, with no error, no crash, no container restart, nothing in
   any log. It then recovers on its own, which makes it look like a network fault. Verified at index
   progress **100**, and it reproduces with `fuzzy=false`, so it is GA surface, not preview.
   **No client-side timeout can defend against it** — `AbortSignal.timeout()` and elapsed-time checks
   between pages are both timers, and a blocked event loop runs no timers. Two fixes built on that
   premise were deployed and failed. The only defence is to not issue the query: run a COUNT with the
   **identical** predicate and no `ORDER BY RANK` first, and return empty on zero.
6. **Fuzzy `{term, distance}` is a NO-OP on this account.** `demi-cosmos-dev` carries
   `EnableNoSQLFullTextSearchPreviewFeatures`, the enrolment Microsoft's docs require. **It made no
   difference.** The syntax parses, the `term` matches, `distance` does nothing:

   | query | fuzzy | hits |
   |---|---|---|
   | `quokkafluxion` | true | 1 — exact still matches |
   | `quokafluxion` (1 deletion) | true | **0** |
   | `riparia` / `riparians` | true | 1 — that is the stemmer, not fuzzy |

   The decisive case is a nonsense token one edit from an indexed one, which no stemmer can bridge.
   Eliminated by measurement, in order: not enrolment; not the app flag; not parameter binding
   (rewritten as an inline SQL literal, verified in `wwwroot`, identical); not query shape; **not a
   stale index** — the container was deleted and recreated from scratch after enrolment and behaved
   identically. What remains is server-side: region gating (`canadacentral`) or the preview not
   honouring `distance` yet.

### Why the original spike said fuzzy worked

The first spike reported `Fuzzy on real typos (rivver, propnent, climat) → all 20 hits`. **20 was
the TOP cap**, and three different typos all returning exactly the cap is the signature of trap 4 —
a ranked query whose full-text predicate matched nothing returns the whole container, ranked but
unfiltered. That reads as "fuzzy works brilliantly" and is in fact "the predicate did nothing".

**A fuzzy probe must use a rare or nonsense term and assert an exact expected count, never a capped
one.** This is the single most expensive lesson in this file.

### Backends costed against the corpus (Azure retail pricing API, canadacentral, 2026-07-30)

| Option | Cost/mo | Fuzzy | Verdict |
|---|---|---|---|
| Cosmos DB FTS | ~$9 | **no — silent no-op** | ruled out |
| **Azure AI Search Basic** | **~$75-81** | yes, GA | **chosen.** Also gives highlighting, faceting and synonyms natively |
| Typesense Dedicated D8 | ~$700 | yes, GA | corpus needs 17-26 GB RAM vs the 8 GiB Container Apps Consumption ceiling |

**Why Typesense could not stay.** Indexed fields are RAM-only, with no on-disk mode; clustering is
replication, not sharding (a 3-node cluster is 3× the RAM, not a third each); and its own sizing rule
is 2-3× RAM against searched-field size → **17-26 GB** against an 8 GiB ceiling. A bigger container
was not a lever.

### Durable Cosmos facts from the spike

- **Container creation is control-plane.** The app's managed identity gets
  `403 ... cannot be authorized by AAD token in data plane`. Containers come from ARM/Bicep only.
- **A full-text policy is immutable** — enabling FTS means a *new* container plus a copy. Vector
  policies are narrower than they read: adding one to an existing but EMPTY container succeeded in
  place. What cannot change is an existing embedding's dimensions or metric.
- **`CONTAINS` matches mid-word.** Query `env` returned "G**renv**ille to Kincolith Road". Typesense
  `prefix=true` is a *token* prefix; `STARTSWITH` is *field* start; neither is a drop-in. Token
  behaviour needs `STARTSWITH(f,q) OR CONTAINS(f,' '+q)`.
- **Ranked queries cannot page by continuation token** → chunk search is TOP-N, no pagination.
- **Metadata search on live containers with no FTS policy** (pure `STARTSWITH`/`CONTAINS`): 393
  projects 3-6.5 RU / 61-70 ms; 60,578 documents `STARTSWITH` 9.23 RU / 75 ms, `CONTAINS` 67.7 RU /
  81 ms, multi-field OR + ACL 39.3 RU / 62 ms, project-scoped 15.1 RU / **34 ms**.
- **Chunks are durable in Cosmos regardless of backend** — `src/controllers/nosql/document.js`
  writes the full `content` into the `chunks` container. The search backend is a query layer over it.

---

## §G. Azure AI Search — live since 2026-07-31

`demi-search-dev`, Basic, canadacentral, keyless, private endpoint only. Three indexes —
`demi-chunks`, `demi-projects`, `demi-documents` — with native Cosmos NoSQL indexers on a `PT5M`
schedule using an `_ts` high-water mark. Classic lexical BM25: no vector fields, no semantic ranker.
First chunk index run: **80,355 items, 0 failed, 4m46s**, count equal to Cosmos `DocumentCount`
exactly.

Reads compose `src/helpers/access-odata.js` — `filterFor(access, partitionField)`. Projects scope on
`id`, everything else on `projectId`. **OData has no `false` literal**, so "matches nothing" is an
`empty` flag and the caller issues NO request; a null or empty filter is UNRESTRICTED.

### Infrastructure traps

- **`publicNetworkAccess` MUST be `Disabled`.** The landing-zone policy set `Deny-PublicPaaSEndpoints`
  rejects the deployment outright otherwise — `RequestDisallowedByPolicy`, before the service
  exists. There is no "start public, lock down later" path.
- **A new private endpoint is not usable the moment ARM returns, and the two ways it is unready look
  like different bugs.** *Routing*: the first TCP connect to the private IP timed out; the next
  attempt ~45 s later connected in 10 ms. *DNS*: the landing zone writes the `A-record` into the
  central Private DNS Zone **about ten minutes** after the endpoint is created. Before that, the name
  resolves to the service's PUBLIC address — which policy has disabled — so it fails as a connection
  timeout that reads exactly like a missing DNS zone. **It is not.** Waiting is the fix. Confirmed
  from inside the VNet: `demi-search-dev.search.windows.net -> 10.46.51.10`, `HTTP 200`.
- **Do not create your own Private DNS Zone and link it to the VNet.** Every DNS query is routed
  through the central Private DNS Resolver, so a zone linked to the spoke is never consulted. A
  genuinely missing zone is a support request to the Public Cloud team, not a self-service fix.
- **The data-source `identity` property is rejected on api-version `2024-07-01`.** A user-assigned
  identity needs `2024-11-01-preview`. Index and query calls stay on the GA version.
- **The indexer needs ARM read on the Cosmos account, not just data-plane access.** The UAMI held
  Cosmos Data Contributor and still failed with *"Unable to retrieve account endpoint"* — which
  points at the connection string, not at RBAC. The fix is `Cosmos DB Account Reader Role`.
- **Deleting from the index is a write.** The UAMI needs Index Data **Contributor**, not Reader.
- **App Service does NOT forward a CHUNKED request body to the Node worker.** A body sent with
  `Transfer-Encoding: chunked` arrives as an EMPTY stream: the app reads zero bytes and answers 400,
  which reads like a malformed payload rather than a transport problem. Measured 2026-08-03 on the
  NDJSON ingest route, identical bytes both ways: chunked → `400 empty stream`, `Content-Length` →
  `200`. Any streaming client must set `Content-Length` — in Python `requests`, pass bytes, never a
  generator. **This does not defeat server-side streaming**: Content-Length is metadata, Node still
  reads the socket incrementally, and peak memory still follows batch size rather than body size.
- **App Service's 240 s request timeout applies to a streaming write too.** Four concurrent 30 MB
  ingests on one B1 vCPU pushed past it and returned 504; serialising to one uploader took the same
  document to 111 s. Long synchronous writes need either serialisation or a resumable protocol —
  the same ceiling already documented for `POST /admin/sync/nrpti`.

### What the Typesense migration taught, both measured

- **`projectName` was doing more work than it looked.** Typesense indexed it on every document; a
  Cosmos document row does not carry it, and an indexer reads one container. Dropping it would have
  cost **77% of hits for "Ajax"** and 66% for "pipeline" — silently. `searchDocuments` recovers it
  with a second leg through the projects index, under the caller's own document ACL.
- **The Cosmos fallback was hiding failures.** A keyword query that matched nothing fell through to
  the keywordless list, so an anonymous search for a nonsense term returned 50 unrelated rows — and
  that same path masked a 400 (`$select` naming a field the index lacked) which had broken project
  search outright. A keyword search that matches nothing now answers with nothing.

### Two behaviours found only once the APPLICATION drove the index

- **Fuzzy expansion of short words returns garbage, and the frontend sends `fuzzy=true` on every
  search.** The stopword-only query "the and of" came back with a full page of OCR debris — `the~1`
  matched a scanned fragment reading "th" — while the same query with fuzzy off returned 0. A fuzzy
  term bypasses the analyzer, so stopword removal never happens either. Terms shorter than four
  characters are no longer fuzzed (`MIN_FUZZY_LENGTH`).
- **A highlight fragment can be cut INSIDE a highlight.** One came back carrying a closing sentinel
  whose opener had been trimmed off, rendering as a stray `</mark>` in an `[innerHTML]` binding.
  Fragments are now balanced individually before they are joined.

Both were invisible to the spike because its probes read counts, not rendered output. **A probe that
only counts rows cannot see a malformed row.**

### Two design facts settled by measurement

- **`retrievable: false` does not disable highlighting.** `@search.highlights` returns marked
  fragments while the response carries no chunk text at all.
- **The `_ts` high-water mark cannot see deletes.** After hard-deleting the probe document, a re-run
  processed **0 items** and the row stayed searchable until deleted from the index explicitly.
  Delete propagation is application work, not indexer configuration — `aiSearch.deleteFromIndex` in
  `deleteProject`/`deleteDocument`, and `deleteChunksForDocument` for chunk text.

Query shape: `(term OR term~1)` per term, plus `term*` prefix on the LAST term only — Typesense ran
`prefix=true` and the frontend searches on debounced keystrokes, so without it results thin out
mid-typing. **The per-term groups are then joined with ` AND `, which this section omitted until
2026-08-04.** That join is the whole query semantics: every term is mandatory, so recall is capped
before BM25 ever ranks anything. It is the leading untested explanation for the text-stratum
retrieval misses — see §A, "the query is a strict conjunction".

---

## Verified facts (measured — do not re-derive)

### Sources

| Source | Content |
|---|---|
| **Track** (`src/data/track_projects_enriched.json`, checked in) | **382 projects.** `track_project_id` is authoritative identity. **354 carry `epic_guid`** = the Eagle project `_id` |
| **Eagle** (`eagle-dev…/api/public/search`) | **359 projects** with 60+ fields Track lacks. **60,661 documents.** Carries no Track id — the join is one-directional |
| **NRPTI** (`nrpti-api…/api/public/search`) | **99,430** across 5 datasets. `_epicProjectId` links to an Eagle project **when present — but it usually is not** |
| **epic.submit** | No integration exists. Future work |

**Join:** 348 of 354 Track `epic_guid`s match an Eagle project · 28 Track-only · 6 dangle · ~10
Eagle-only → **~392 real projects** (vs 4,123 rows in the old database). `buildRegistry` asserts
exactly these counts against the checked-in Track dataset, so upstream drift fails a test.

**Track coordinate defects** (found by the Phase 3 tests, not by inspection): 7 of 382 records carry
a **positive longitude** — a dropped minus sign. BC longitude is always negative, so
`validCoordinates` negates and re-validates against a BC bounding box, recovering 6. The 7th,
`Sparwood Wells #04` (id 358, lat 45.861 lng 53.354), is unrecoverable — both values are wrong. It
gets **no centroid** rather than an invented one. Without the sign repair, Zincton plots in
Uzbekistan.

### Documents — no copy needed (measured 2026-07-30)

| Environment | Document records | Bucket |
|---|---|---|
| eagle **dev** | **60,661** | `asnpnn` |
| eagle test | 55,845 | `zdspnb` |
| eagle prod | 61,428 | `ozwdez` |

Dev has **more** documents than test, contrary to assumption — 99% of prod. The dev bucket `asnpnn`
holds **92,809 objects / 242.6 GB**, of which **92,472 sit under a prefix named `ozwdez`** (a full
prod copy — hence `minioKeyPrefix`). A blob-coverage check on 100 dev documents found **100%
present, 0 missing**. So DEMI can be tested against the full corpus today with no copy, and Phase 3b
is an architecture choice rather than a prerequisite.

### The old database (replaced)

4,123 projects (**3,382 NRPTI-synthetic**), 18,969 documents (a third of Eagle's), 4,045 records
(**0 unlinked** → `/projectId` is safe), 244 boundaries. **No chunk collection at all.**

Item sizes: boundaries max **1.58 MB** (Peace River RD; 9 over 1 MB), everything else ≤6 KB. Cosmos
NoSQL caps items at **2 MB** — the 16 MB allowance is MongoDB-API-only, which is what had been
masking this.

---

## Target design

### Containers

| Container | Partition key | Why |
|---|---|---|
| `projects` | `/id` (Track id) | Point reads or full lists; no grouping dimension exists |
| `project_fragments` | `/projectId` | Independently ACL'd slices (e.g. NRPTI aggregates) |
| `documents` | `/projectId` | `?project=X` is the dominant list → single-partition |
| `records` | `/projectId` | 0 unlinked, so no hot empty-string partition |
| `chunks` | `/documentId` | delete-then-reinsert stays single-partition |
| `boundaries` | `/type` | Only filter that exists; 244 items |
| `logs` | `/id` | + 14 d TTL |
| `wildfires` | `/id` | + spatial index, 7 d TTL |
| `syncState`, `leases` | `/id` | high-water marks; change-feed leases. **Both unwritten by anything today** |

Indexing **excludes `/*`**, includes only filtered paths. `/read/[]/?` must be indexed or every ACL
read is a full scan; `/name` must be indexed or `ORDER BY` fails outright.

### Identity & merge

**Implemented in `src/merge/project.js`.** Pure functions, no I/O — merge bugs are silent, so every
rule is data and tested as data.

`id` = `String(track_project_id)`. Cross-refs on every project: `trackProjectId`, `eagleId`,
`sourceSystem`. **Track wins, Eagle fills gaps** — `TRACK_PRECEDENCE`, an explicit
`[target, trackField, eagleField]` map. It is a map rather than `{...eagle, ...track}` precisely
because a spread overwrites with `undefined` and would silently erase data: 12 real Track records
have no `abbreviation`, 1 no `description`, 1 no `address`, 1 no `project_state_name`.

`buildProjectIndex(projects).resolve(ref)` returning **null** is load-bearing: an unresolvable NRPTI
record is **dropped**, never given a fabricated parent. That is what replaces fuzzy name matching.

Raw payloads are retained under `sources.track` / `sources.eagle` (unindexed) so a re-merge never
re-fetches upstream and any field is traceable to its origin. Never read by the API.

**Do not create projects from NRPTI.** Only ingest records whose `_epicProjectId` resolves to a
project already in the registry.

> **Verified 2026-07-30 — the 3,382 NRPTI-seeded "projects" were junk.** 0 had Track provenance, 0
> had Eagle provenance, all carried synthetic ids ≥ 8,000,000 from `8000000 + hash % 1e6`, and
> **851 shared a duplicate name**. Their names were cities and watercourses, not EA projects. The
> auto-seeder turned every unmatched NRPTI `location`/`projectName` string into a project. **They
> were not re-seeded.**
>
> Consequence: the registry is **~392 real projects**, all published — so in practice **there are no
> hidden projects**. The ACL stays because it still governs documents and future Track drafts.

### The seed

`src/seed/sources.js` (all I/O) + `src/seed/transform.js` (pure) + `src/scripts/seed-nosql.js`
(orchestrator). **Dry run by default**; `--live` required to write. The gates run in *both* modes, so
a dry run is a real pre-flight check and works from outside the private endpoint.

```
node src/scripts/seed-nosql.js [--live] [--only projects,documents,records,boundaries]
                               [--limit-documents N]
```

Order is forced: projects first, because every other container partitions by a canonical project id
only the merged registry can supply. `--only` still *builds* the registry even when projects are not
written — a stale index would misfile documents into the wrong partition.

Live dry run against real sources, 2026-07-30:

```
projects    382 Track + 359 Eagle → 348 matched · 28 no epic_guid · 6 dangling · 11 Eagle-only = 393
documents   60,661 fetched → 60,578 built across 357 projects · 83 dropped · 0 without an object key
boundaries  281: Regional District 28 · Municipality 160 · Electoral District 93
```

The `60,661` fetched matches the upstream `searchResultsTotal` exactly, which is what the truncation
guard checks.

#### Source facts that changed the transform (measured, 2,961-document sample)

| Finding | Consequence |
|---|---|
| **`s3Key` is null on 100% of Eagle documents; `internalURL` holds the key** | Reading `s3Key` would seed 60,661 records with no downloadable file |
| **`isPublished` is true on only 66% of documents that are unambiguously public by `read[]`** | `isPublished` is **derived** from `read[]`, never copied. Copying it would hide a third of the corpus |
| `internalSize` is a number OR a numeric string (261 of 2,961 were strings) | coerced via `toNumber` |
| `contentExtracted` is true on 99% upstream, but DEMI has no chunk data | **reset to false** |
| ~**0.1%** of documents reference a project absent from the public 359 | dropped **and counted** — a silent drop looks like a complete corpus |
| `pageSize` is **capped at 100** regardless of what is requested | asking for 1000 silently reads a tenth of the data while appearing to work |
| Eagle `type`/`milestone`/`projectPhase` are ObjectId refs into a 213-item `List` | resolved to labels at seed time; an unresolvable ref keeps its raw value rather than becoming null |
| NRPTI uses a **different role vocabulary** (`admin:nrced`, `admin:lng`, `admin:bcmi`) | `read[]` preserved verbatim — these are still role types |

#### Streaming, because the accumulating version did not fit the host

The first implementation held all 60,661 raw payloads **plus** their transformed forms: peak RSS
**252 MB by document 45,000 and still climbing**. Documents and records now stream —
`fetchAllPages({accumulate: false})` never builds the array, and the orchestrator buffers per project
and flushes at `FLUSH_THRESHOLD = 100` (the Cosmos bulk limit, so a full buffer is exactly one
request). Measured peak: **123 MB, flat**, with identical output.

- **The NRPTI aggregate is folded incrementally** (`emptySummary` + `accumulateRecord`), because it
  needs every record but the records are no longer retained. A test asserts incremental ==
  whole-list.
- **The page handler is awaited.** Without that the flush-per-page backpressure disappears and memory
  grows unbounded anyway. Asserted by test.

Progress is reported **per page, not per dataset**. Inspection alone is 673 pages, and a per-dataset
callback emitted nothing for ~20 minutes — indistinguishable from a hung process.

#### Safety properties

- **`fetchAllPages` throws on a short count.** A mid-run upstream hiccup returning a partial page
  would otherwise read as end-of-data and quietly seed 40k fewer documents — and the result would
  look complete.
- **An unexpected response envelope throws** rather than reading as zero results and seeding an
  empty database.
- **Gates fail the run with a non-zero exit**: synthetic `trackProjectId >= 8,000,000`, >20 duplicate
  names, duplicate ids, any item with no `read[]`, any item with no partition key, and any item whose
  `isPublished` has drifted from `read[]`.
- **`items.bulk` is chunked at 100 inside `cosmos-nosql.js`**, not at the call sites. Cosmos rejects
  more, and a caller that forgot would fail only on the large projects — i.e. in production, not in a
  test.
- The NRPTI aggregate is written to **`project_fragments`** as its own item. That is simultaneously
  the 2 MB fix and the fragment-ACL mechanism.

**NRPTI records are not in the default seed.** `DEFAULT_STAGES` is `projects, documents, boundaries`.
Only **2,238 of 99,430 (2.25%)** resolve to a project in the registry, because NRPTI covers all BC
natural-resource compliance rather than only projects that went through an EA. The stage costs ~40
minutes of upstream fetching per seed. Their `documents: [...]` references are unreachable through
NRPTI's public API (`dataset=Document` does not respond, `RecordDocument` returns empty,
`/api/public/document/<id>` returns 404).

### Authorization

Two **orthogonal** dimensions — this is the scaling decision:

- **`read[]` holds role *types* only** (`public`, `sysadmin`, `staff`, `project-team`…). Bounded,
  indexed. Putting project identity here would mean a user in 50 projects carrying 150 roles and
  every read becoming a cross-partition ACL scan.
- **Project scope rides the partition key.** It is already the partition boundary, so it costs
  nothing extra.

```
project:207        -> scoped to project 207 (a canonical project id = the partition key)
staff, compliance  -> role TYPES, matched against read[]
```

`rolesFor()` strips `project:*` from the role list so a project id can never land in the `read[]`
`IN` clause. No project role at all means **not scoped** (public tier), distinct from an explicit
`projectScope: []` meaning **scoped to nothing** (`scopeClause` → `false`). Privileged roles ignore
scope entirely. Scope values are ids, not names, which keeps `resolveAccess` synchronous and
lookup-free on every request.

`readClause(roles)` is the only place a visibility predicate is built:

```sql
(EXISTS(SELECT VALUE r FROM r IN c.read WHERE r IN (@role0, @role1))
 OR ((NOT IS_DEFINED(c.read) OR ARRAY_LENGTH(c.read) = 0) AND c.isPublished = true))
```

`EXISTS`-with-subquery, **not `ARRAY_CONTAINS_ANY`** (that one does not use the index).

**`systemAccess()`** is the one context that reads every item regardless of ACL. It is built from the
normal privileged tier and resolves to `true` **through `readClause`** — not a bypass flag, because a
"skip the predicate" path is exactly what disabled access control here before, and it would not be
covered by the SQL-asserting tests. It takes **no arguments**, so it can never be derived from a
request.

Fragment-level control = **make the fragment its own item**, so the same `readClause` applies
unchanged and an unreadable fragment is never fetched.

**Rejected: database-level ACLs driven by Keycloak.** Cosmos NoSQL data-plane RBAC is Entra-only and
its finest scope is a *container* — no item, partition or predicate scoping, and no row-level
security. Resource tokens can scope to a partition key but are key-derived (incompatible with
`disableLocalAuth`), expire in 1–5 h, and cannot express role types or fragments. The browser never
touches Cosmos, so the API is already the trust boundary. **Keycloak stays for user identity; Entra
managed identity is only for app→Cosmos.**

### Data access

**No Mongo→SQL translator.** One that handles 90% of operators fails *open* on the rest, and the
operators where the two disagree (`$ne`, `$exists`, `$size`) are exactly what `readFilter` was built
from — this repo has shipped that bug once already. There are only ~12 distinct query shapes in the
whole application.

`query(name, spec, opts)` throws unless the spec is `{query: string, parameters: array}`. Parameters
only, never interpolation.

Repository design notes:

- **No generic `find(filter)`.** Each method owns its SQL and cannot emit an unfiltered read.
- **`countWhere` shares `selectWhere`**, so a count can never drift from its list predicate — a count
  built from a different filter leaks the size of a set the caller cannot read.
- **`boundaries` deliberately has no ACL predicate.** It is public reference data with no `read[]`;
  applying the standard clause would match nothing and blank the map.
- **`fragments.put()` refuses an empty `read[]`.** A fragment with no ACL would fall back to the
  `isPublished` mirror and could become publicly readable.
- Paging uses **continuation tokens**, not skip/take: Cosmos has no efficient offset.
- `patch()` is capped at 10 ops by Cosmos and guarded. Use it for partial updates; `upsert()`
  REPLACES the whole item and will erase fields written by another path.
- **Point reads bypass the query predicate, so `canRead()` is mandatory after `readItem()`.**

Controller notes:

- A hidden project returns **404, not 403** — a 403 would confirm the id exists.
- Update paths refuse to reassign a partition key (`id` on projects, `projectId` on documents, `type`
  on boundaries): in Cosmos that is a delete-and-reinsert, not an update.
- `resolveDocumentAcl()` is used by **both** document write paths. The Mongo version had it in
  `createDocument` only, so an intake upload could be published under a private project.

### Deletion semantics

| Action | What it does |
|---|---|
| **Unpublish** (`PUT /documents/:id/published`) | Hides from public and proponents: `isPublished: false` and `read[]` loses `public`. **This is the hide mechanism.** |
| **Hard delete** (`DELETE /documents/:id`) | Permanently removes the Cosmos item **and** the search-index entry |
| **The stored blob** | **Never deleted by any request path.** Orphans are reclaimed by a separate audited job |

The index entry is removed **explicitly** rather than via the change feed (which emits no deletes in
latest-version mode) — doing it directly is what makes a soft-delete marker unnecessary at all.

Index removal is **best-effort**: the record is already gone from Cosmos, so an index failure must
not turn a successful delete into a 500. The response reports the outcome explicitly.

Publishing a document under an **unpublished project returns 409** — a document may never out-rank
its parent.

### Object storage (Phase 3b — code written, nothing deployed or copied)

`src/storage/` is the single entry point. **Four operations**, because that is all the application
does with stored files:

```
getBuffer(key)                  -> Buffer            (extraction)
getDownloadUrl(key, opts)       -> short-lived URL   (download endpoint)
putFile(key, filePath, ctype)   -> stored key        (upload)
describe()                      -> non-secret info   (logs, health)
```

No bucket, container, or client escapes the module. Backend is chosen by an **explicit**
`STORAGE_BACKEND` (`minio` | `azure`); an unknown value **throws at load**. Not inferred from
whichever credentials are present — that is how `COSMOS_ENDPOINT` silently activated the wrong data
layer on deploy.

**A real bug this fixed.** `extract.js` read `doc.s3Key` **raw**, with no environment key prefix, so
every extraction in dev fetched a key that 404s. Meanwhile both HTTP controllers were importing the
*batch extraction script* purely to borrow its MinIO client. One cause: no single owner of the
storage path. The prefix now lives inside the MinIO backend, where no caller can forget it.

| | MinIO | Azure Blob |
|---|---|---|
| Auth | access key + secret | **Entra managed identity, no keys** (`allowSharedKeyAccess: false`) |
| Environment isolation | one bucket, nested `ozwdez/` prefix | **one container per environment** |
| Download URL | presigned GET | **user delegation SAS**, `sp=r`, https-only |
| Container creation | on demand | **never** — comes from Bicep |

Per-environment containers are the actual safety win. Dev's `MINIO_HOST` is one env-var edit from
prod storage today; a container reachable only by that environment's identity makes the mistake
impossible rather than discouraged.

**Three gotchas worth not rediscovering:**

- **`Storage Blob Delegator` is required** and is *not* implied by `Storage Blob Data Contributor`.
  Without it `getUserDelegationKey` fails, and with shared-key access disabled a user delegation SAS
  is the only way to sign a download link — so every download breaks.
- **The delegation key's `signedStartsOn`/`signedExpiresOn` must be `Date` objects.** The generated
  mapper types them as `String`, but `generateBlobSASQueryParameters` calls `toISOString()` on them.
- **The delegation key is cached for 30 min** (valid up to 7 days). Uncached, every download adds a
  round trip; cached too long, it silently produces SAS URLs that fail authentication.

`src/scripts/copy-blobs-to-azure.js` is **dry run by default**; `--live` is required. Resumable: a
destination blob of matching size is skipped, a truncated one is recopied, and a short write throws
rather than reporting success. The MinIO **write** operation is not imported at all, and a test greps
the source to keep it that way.

---

## Environment reality

**`demi-plan-dev` is B1 Basic — 1 vCPU / 1.75 GB, a SINGLE worker — not Y1 Consumption.**
`az appservice plan list` confirms it. Two consequences: the 10-minute timeout is `host.json`
configuration, **not** a platform ceiling, so it can be raised; and one vCPU with one worker means a
single blocked request takes down *every* endpoint, which is exactly what the ranked-query defect
did. Treat "Y1 Consumption" in any older document as wrong.

**The network is not what `azure/main.bicep` describes.** There is **no VNet in the resource group**;
`azure/modules/vnet.bicep` was never deployed. `main.bicep` also never instantiates `cosmos-nosql`,
`ai-search`, `document-storage` or `identity` — the four modules that build the current
architecture. The real subnet is the platform vWAN spoke:

```
/subscriptions/…/resourceGroups/c4b0a8-dev-networking/providers/Microsoft.Network/
  virtualNetworks/c4b0a8-dev-vwan-spoke/subnets/c4b0a8-dev-cond-ext-pe-subnet
```

Pass that as `peSubnetId`. Do not deploy `main.bicep` expecting it to build networking, and do not
expect it to be how live app settings change.

**Private DNS is attached by Azure Policy, not by this repo.** The existing `demi-mongo-pe` carries a
zone group named **`deployedByPolicy`** whose zone lives in a *different subscription*
(`bcgov-managed-lz-live-dns`). Our own version would have (a) failed on `virtualNetworkLinks`, since
the VNet is in `c4b0a8-dev-networking` which this identity cannot even list, (b) created a second
zone competing with the platform's, and (c) been redundant. **Create the endpoint only and let policy
wire DNS.**

### App settings on `demi-api-dev`

| Setting | State |
|---|---|
| `COSMOS_ENDPOINT` | `https://demi-cosmos-dev.documents.azure.com:443/` — the **NoSQL** account. It once pointed at Mongo; it no longer does, so deleting the Mongo account cannot break NoSQL reads |
| `COSMOS_NOSQL_DATABASE` | `demi`. **Not** `COSMOS_DATABASE`, which is inert and goes with the Mongo account |
| `AZURE_CLIENT_ID` | the UAMI client id, selects the identity |
| `SEARCH_ENDPOINT`, `SEARCH_INDEX` | AI Search. `SEARCH_INDEX_PROJECTS` / `_DOCUMENTS` default to `demi-projects` / `demi-documents` |
| `USE_COSMOS_NOSQL` | **deleted 2026-08-01** — Phase 8 removed the switch and the layer it chose against |
| `AzureWebJobs.nightlySyncTimer.Disabled` | **deleted 2026-08-01** with the timer itself |
| `STORAGE_BACKEND` | **set explicitly to `minio` 2026-08-04.** Was unset and carried by the default in `src/config.js`; the "never a side effect" rule should not rest on a default |
| `MINIO_*` | **keep** — still the live object store |
| `MONGODB_URI`, `MONGODB_DATABASE` | **deleted 2026-08-04**, with the account. There is no rollback path any more, by design |
| `WEBSITE_VNET_ROUTE_ALL`, `WEBSITE_DNS_SERVER` | required for private-endpoint DNS |
| `ENABLE_ORYX_BUILD` | must stay `false` |

**There is no rollback any more.** It used to be `git revert` + redeploy, and only while
`MONGODB_URI` / `MONGODB_DATABASE` and the account still stood. The settings came off and the
account was deleted on 2026-08-04, so a revert now restores code that points at nothing. Anything
built from here forward targets Cosmos NoSQL; there is no Mongo to fall back to.

---

## Measuring — three mistakes made twice here

1. **A probe harness that reuses one output file lies.** A timed-out `curl` does not rewrite its `-o`
   file, so every probe re-reads the previous probe's JSON. That produced a table of identical hit
   counts, which reads as "the results are wrong" when the truth was "the app is hung". **One output
   file per probe, always.** Abort the whole run on the first unhealthy probe.
2. **Deploying on a hypothesis without an instrument** cost most of two days across two sessions.
   Four fixes shipped on plausible causes and all four failed. Both turning points were adding a
   measurement (`indexProgress`, then `fuzzyEnabled`). **Instrument first.**
3. **A probe that cannot fail proves nothing.** Four separate instances now:
   - `keywords=<exact term>&fuzzy=true` returns 1 whether fuzzy is on or off. The probe that settled
     it was a nonsense token one edit from an indexed one — unreachable by stemming.
   - **A probe returning the `top` cap proves nothing**: an ineffective full-text predicate returns
     the whole container ranked, which is why the Cosmos spike concluded fuzzy worked when it did not.
   - **A latency claim needs a BEFORE reading.** "`/db/stats` answers in seconds, not minutes" was
     offered as proof Phase 8 landed; the legacy build answered in 2.2 s too. The payload
     discriminates, not the timing.
   - **A capped list hides an ACL difference.** Comparing anonymous and privileged result counts
     proves nothing when the page caps at 10 and every row is public. Use a throwaway record with a
     non-public `read[]` and assert 0 vs 1.

---

## Operational gotchas (each cost real time)

- **`az functionapp restart` does NOT recycle the Node worker.** Use `stop` then `start`. Confirmed
  twice. **And `stop`/`start` still does not prove new code or a new app setting is live** — a warm
  worker served the OLD build after both, for minutes past the ~50 s cold start. Poll a discriminator
  until it flips.
- **`config-zip` merges rather than clean-deploys.** A file deleted from the repo will **not**
  disappear from `wwwroot`. Verify by content, never mtime — the zip carries source mtimes.
- **SCM basic auth is disabled** (landing-zone policy). Kudu returns 401 to publishing credentials;
  use an AAD bearer (`az account get-access-token --resource https://management.core.windows.net/`).
- **`az webapp deploy` 502s** on a ~27 MB package. `POST /api/zipdeploy?isAsync=true` accepts it in
  ~1.6 s. Kudu status **3 = FAILED, 4 = SUCCESS**; `complete: true` alone means nothing.
- **Cosmos is private-endpoint only AND keyless** — unreachable from a laptop. **Kudu `/api/command`
  cannot reach it either, but not for the obvious reason**: measured 2026-07-31, the SCM container
  *does* have the VNet data path. What it lacks is a **managed identity** (`IDENTITY_ENDPOINT`
  unset), and with local auth disabled there is no key to fall back on. For the same reason **app
  settings cannot be read back from the SCM container**. So Kudu is usable wherever a token can be
  supplied from outside — that is exactly how the AI Search spike drove the data plane: **auth minted
  outside, network from inside**. For Cosmos the route is the App Service SSH tunnel into the *app*
  container. Kudu is still correct for **deploying** and for **reading `wwwroot` via the VFS API**.
- **Prefer an API endpoint over out-of-band DB access.** `GET /admin/index-progress` issues no
  container query at all, so it answers when `/db/stats` counts are timing out.
- **`POST /admin/sync/nrpti` 504s at 240 s** on the App Service request timeout and **keeps running
  server-side regardless.** Use `?async=true` and watch `/db/stats` records until stable.
- **`pageSize` caps at 1000** on list reads whatever you ask for. Never answer a data-loss question
  from a list response — read the ids individually.
- **Deploy zip trap:** pruning `dist` by name at every depth also strips `node_modules/**/dist` (e.g.
  `@mongodb-js/saslprep`), shipping an app that 500s on every request. Prune at the repo root only.
- **Never ship `.env`** in the deploy package.
- **Cosmos rejects `cursor.sort()` on unindexed fields** and the query layer swallows it into `[]` —
  a silently blank page.
- **`_id` is mixed:** EPIC imports carry real ObjectIds, DEMI-created rows use strings.
- **Object store** is `nrs.objectstore.gov.bc.ca` bucket `asnpnn` (creds in OpenShift secret
  `eagle-api-minio-keys`, ns `6cdc9e-dev`). Needs port 443 + SSL + a **pinned region**, or presign
  hangs ~135 s. There is no MinIO in OpenShift.
- **The OpenShift `eagle-demi-api` pod crash-loops on its own unpaginated `/documents`.** Seed
  documents from `eagle-api` directly.
- **CI is blocked:** `AZURE_CLIENT_ID` missing from repo secrets. Creating the Entra app needs Graph,
  blocked by conditional access.
- `azure-deploy-prod.yaml` and `-test.yaml` trigger on **every push to main**, no tag, no approval.
  Inert today; gate before adding the OIDC credential.

---

## Verification gates

Every phase: `npm test` and `cd frontend && yarn lint && yarn test && yarn build`.

The highest-consequence surface is **authorization**:

- anonymous → only `public` items; a `read:['sysadmin']` document is invisible
- `sysadmin` → everything including unpublished
- **scoped** → items in its projects only; a project outside scope unreachable **by id as well as by
  list**
- **fragment** → project visible, fragment absent and never fetched
- counts use the *identical* WHERE fragment as the read
- **zero rows without `read[]`**
