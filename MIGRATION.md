# DEMI → Cosmos DB for NoSQL — migration record

> **Living document.** `TODO.md` owns what is left to do; this file owns architecture, measured
> facts and the traps. Full design rationale: wiki `ADR-004-Read-ACL-Authorization-Model` and
> `Environment-Reality-and-Operational-Gotchas`.

**Last updated:** 2026-08-01 · **State:** migration complete. Dev runs on Cosmos DB for NoSQL with
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

#### Quality — measured 2026-07-31. OCR is not the problem

`src/scripts/audit-chunk-quality.js` scored **1,299 chunks across 400 extracted documents**:

| | |
|---|---|
| Chunks scoring clean | **71.8%** |
| Marginal | 12.4% |
| Garbage | **15.8% — an UPPER bound** |
| Documents in the random stratum with **zero** bad chunks | **30 of 40** |
| **OCR word-salad** (`vowelless-tokens`, e.g. `Cnstum dlld`) | **3 chunks — 0.23%** |
| Documents whose text is nothing but `<!-- image -->` | 8 of 77 sampled, all **presentation decks** |

**OCR debris is 0.23% of chunks.** The dominant real defect is different — slide-deck PDFs extract
to **nothing but image placeholders**. Those documents are in the index and unfindable by content,
which is worse than noisy text and is a routing/OCR-coverage question, not an engine-quality one.

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
`DoclingParseDocumentBackend`, everything after by `PyPdfiumDocumentBackend` (see the SIGTRAP note
in `TODO.md` §2). Sidecars record `extraction.options.pdf_backend`. Split any quality measurement
on it.

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

**Code done, deployed and verified live 2026-08-01. Azure resources still standing; clean week runs
to 2026-08-08.**

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

**`mongodb` stays in `package.json`.** `src/extract.js:26` is its only remaining user, and that file
is deferred-not-dead. Deleting the account breaks its configured `MONGODB_URI`; nothing live
regresses, because extraction runs on LXC 109 through the API. A guard in `main()` throws when no
Mongo URI env is configured, so a post-teardown run errors instead of silently connecting to
localhost and reporting zero documents.

**Left to do** — exact resource list and the checked hazards in `TODO.md` item 1. In short:
`azure/main.bicep:69` + `:89`, `azure/modules/cosmos-db.bicep`, `api-web-app.bicep:22-24` and
`:113-129`, the stale compiled `azure/main.json`, then the account `demi-mongo-dev-pcbd7cygyic52`,
`demi-mongo-pe` and its NIC. **The private endpoint is the only flat recurring charge (~$7/mo).**
Not before the clean week ends.

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
mid-typing.

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
| `STORAGE_BACKEND` | unset (defaults to `minio`) — blobs are not copied yet |
| `MINIO_*` | **keep** — still the live object store |
| `MONGODB_URI`, `MONGODB_DATABASE` | **keep until teardown** — they are the rollback path |
| `WEBSITE_VNET_ROUTE_ALL`, `WEBSITE_DNS_SERVER` | required for private-endpoint DNS |
| `ENABLE_ORYX_BUILD` | must stay `false` |

**Rollback is `git revert` + redeploy**, and only while `MONGODB_URI` / `MONGODB_DATABASE` and the
account still stand — that is what the clean week to 2026-08-08 buys. Deleting the account is the
one-way step.

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
