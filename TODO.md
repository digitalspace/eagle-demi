# DEMI — TODO

**Updated 2026-08-04.** Actionable work only. Rationale + measured facts in `MIGRATION.md`; agent
rules in `CLAUDE.md`. **Record finding once, in file that owns topic.**

Status: **dev only, no test/prod.** Items = backlog, not incidents.

---

## State of play

**Live.** Azure AI Search `demi-search-dev` (Basic, keyless, private endpoint only) serve all three
datasets — `demi-chunks`, `demi-projects`, `demi-documents` — indexers on `PT5M`. Typesense deleted
2026-07-31, code and infrastructure both; `az containerapp list -g c4b0a8-dev-rg` return nothing.
`demi-chunks` held 80,354 rows on 2026-08-01, against **995,316** chunks in Cosmos after the
2026-08-02 run plus ~133K more from the 2026-08-03 oversize ingest. **Re-read 2026-08-04 and
closed: `demi-chunks` now holds 1,128,736 rows**, i.e. the `PT5M` indexer kept up and the old
number was simply older than the corpus. Read it with `searchChunks({matchAll: true})` — the
`matchAll` path already existed and no caller used it, and it is the only match-all route, since
`keywords` is required, `*` is escaped by the query builder and `the`/`a` are stopwords. Coverage is
**not** a candidate explanation for the recall numbers, now measured rather than argued.

Cosmos counts read live 2026-08-02: **projects 2,248** (the 393 figure predate the NRPTI sync),
documents 60,578, records 48,086, boundaries 281.

**Extraction, as of 2026-08-03.** Work list **7,298 outstanding** = 1,496 whose source 404s in the
dev object store + 5,802 whose false failure flags were cleared. `.err` on the host down to **106**,
the genuinely unextractable. **166 documents extract to nothing** — accepted as a floor 2026-08-03
(0.27%). Ingest handles any document size via the NDJSON path — `MIGRATION.md` §A for all of it.

**Retrieval measured 2026-08-03: recall@10 ≈ 0.5. As of 2026-08-04 the misses are SEARCH-side, not
extraction-side.** The chunk-presence probe reads each labelled document's chunks out of Cosmos:
**25 of 32 misses (78%) have the phrase sitting verbatim in a stored chunk**, 16 of 17 on the `text`
strata. Word-joining is **3 of 32 misses (9%)**, all OCR. Seam-straddling is **0 of 74**. Five
candidates are dead — label length, page furniture, index coverage, the strict ` AND ` join, and
extraction damage as the main term. **One cause found and fixed 2026-08-04:** on terms
`en.microsoft` removes (`from`, `mine`, `that`, `with`, `those`, reflexive pronouns) the unanalyzed
`~1` variant is the only matchable half of its clause, so it acts as a near-random *mandatory*
filter. Proved on a document whose chunk holds the phrase verbatim and is indexed: **0 hits with
fuzzy on, 1 with it off**. Pooled recall@10 **0.549 → 0.592**, 3 miss→hit, 0 hit→miss, control still
0. §3 and `MIGRATION.md` §A.

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

**Cost — first post-Typesense reading taken 2026-08-04, and the budget will be exceeded.**
`demi-budget-dev` is **100 CAD/month**; Cost Management reports **26.08 CAD** month-to-date over
Aug 1–4 (the budget API's own `currentSpend` says 24.56 — same story, it lags). That is roughly
**6.5 CAD/day, i.e. ~200 CAD/month, about 2× the budget.** Breakdown, MTD:

| Service | MTD (CAD) | ~/month | Note |
|---|---|---|---|
| Azure Cognitive Search | 9.55 | ~74 | Basic, fixed whether queried or idle. Confirms the ~$75-81 estimate |
| **Microsoft Defender for Cloud** | **6.29** | **~48** | **Was not recorded anywhere. Second-largest line** |
| Azure Cosmos DB | 4.67 | ~36 | Serverless RU + storage on ~1.13M chunks |
| Virtual Network | 3.80 | ~29 | **Three** private endpoints, not one |
| Azure App Service | 1.70 | ~13 | B1 Basic |
| Storage | 0.07 | ~0.5 | |

Two corrections to what this file used to say:

- **Defender for Cloud is ~24% of the bill and nobody had counted it.** 14 plans sit on `Standard`
  (`VirtualMachines`, `SqlServers`, `AppServices`, `StorageAccounts`, `SqlServerVirtualMachines`,
  `KeyVaults`, `Arm`, `OpenSourceRelationalDatabases`, `CosmosDbs`, `Containers`, `CloudPosture`,
  `AI`, `Discovery`, `FoundationalCspm`) on a dev subscription holding one App Service, one Cosmos
  account and one storage account. **Do not turn these off.** This is a BC Gov landing zone and
  Defender tiers are almost certainly set by platform/security policy, not by this team — ask before
  touching, and treat it as a question for the platform team rather than a saving to take.
- **"The private endpoint is the only flat recurring charge (~$7/mo)" is wrong.** `c4b0a8-dev-rg`
  holds **three**: `demi-mongo-pe` (MongoDB), `pe-cosmos-nosql-dev` (Sql) and `pe-demi-search-dev`
  (searchService). The ~29 CAD/mo is split across all three, so the Phase 8 teardown removes roughly
  a third of it — around 10 CAD/mo, not the whole line. The other two are load-bearing.

Read it with `az rest --method post .../Microsoft.CostManagement/query?api-version=2023-03-01`
grouping on `ServiceName`. **`az consumption usage list` does not work here** — it returns
`pretaxCost` as the literal string `"None"` on this subscription.

---

## Open work

### 1. Phase 8 Azure teardown — COMPLETE 2026-08-04

**The clean week to 2026-08-08 was ended early, deliberately.** Its purpose was to let a latent
regression surface under real traffic before the rollback was burned — and there is no traffic:
DEMI is dev-only, nobody uses it, and it is under active development. Seven idle days prove what
three idle days already proved. Two measurements replaced the calendar:

- **The account was already idle.** `TotalRequests` over the 48 hours to 2026-08-04 had exactly one
  non-zero hour (62 requests, 2026-08-03 15:00). Aug 4 total, before and after the change: **0**.
- **The wait was not buying recoverability anyway.** Backup is **Periodic with 8-hour retention**
  (240-min interval, Geo). Once the account is deleted, a support-ticket restore is possible for
  eight hours and then not at all. The calendar never protected the data — the un-deleted account
  did.

- [x] **Bicep, done 2026-08-01.** `cosmosDb` module + `mongodbConnectionString` wiring out of
      `main.bicep`; `azure/modules/cosmos-db.bicep` deleted; `api-web-app.bicep` param and all four
      settings it fed deleted; stale `azure/main.json` deleted.
- [x] **App settings, done 2026-08-04. THE ROLLBACK IS NOW BURNED.** `MONGODB_URI` and
      `MONGODB_DATABASE` removed from `demi-api-dev`, and the two documented drifts fixed in the
      same restart rather than earning three: `COSMOS_NOSQL_DATABASE=demi` and
      `STORAGE_BACKEND=minio` are now explicit instead of being carried by code defaults. Settings
      count unchanged at 33 — exactly two out, exactly two in, nothing else touched. `stop`/`start`,
      not `restart`. Verified after: `/projects` and `/documents` return 200 with the same `_etag`s
      as before the change, and `/search` returns the same `count: 29392`.
- [x] **`demi-mongo-pe` + its NIC deleted 2026-08-04.** The NIC goes with the endpoint; no orphan
      left. `pe-cosmos-nosql-dev` and `pe-demi-search-dev` remain and are load-bearing. App verified
      healthy after deletion. **Reversible**: recreate with `az network private-endpoint create`
      against subnet `c4b0a8-dev-networking/.../c4b0a8-dev-vwan-spoke/subnets/c4b0a8-dev-cond-ext-pe-subnet`,
      group `MongoDB`, connection name `demi-mongo-pe-conn`, `canadacentral`.
- [x] **Account `demi-mongo-dev-pcbd7cygyic52` DELETED 2026-08-04.** The one-way step, taken after
      `TotalRequests` was re-confirmed at **0 across the preceding 24 hours**. Its configuration was
      captured first (`kind: MongoDB`, `EnableServerless`, Canada Central, Periodic/240-min/8-hour
      /Geo backup, `publicNetworkAccess: Disabled`), so the *shape* is recoverable even though the
      data is not. Three databases went with it: `demi-dev`, `test`, `epic` — and the orphaned
      `syncState` container inside them. Verified after: `/projects` and `/documents` 200,
      `/search?dataset=DocumentChunk` still `count: 29392`, `az cosmosdb list -g c4b0a8-dev-rg`
      returns only `demi-cosmos-dev`, and no orphan private endpoint or NIC is left —
      `pe-cosmos-nosql-dev` and `pe-demi-search-dev` remain and are load-bearing.

**Phase 8 is closed.** Nothing in the repo or the resource group speaks Mongo any more.

Checked already, so nobody re-check:

- **`main.bicepparam` + three workflows need NO change.** `mongodbConnectionString` is an internal
  module param wired from a module output, never top-level, so the `typesenseApiKey` failure cannot
  repeat here.
- **`COSMOS_ENDPOINT` safe** — point at `demi-cosmos-dev`, the NoSQL account, not Mongo.
- **`main.bicep` is not what run** — no VNet in the RG, and it never instantiate the four modules
  that build current architecture. Settings came off with `az`, not a template deploy. The workflow
  can no longer deploy it at all (validate-only since 2026-08-04).

### 2. Extraction — landed, reconciled, cleared

No open items. The full-corpus run finished 2026-08-02, the reconciliation balanced exactly, and
the 5,802 false 404s were cleared 2026-08-03. Everything measured about it — the reconciliation,
the docling-parse SIGTRAP that forced the `PyPdfiumDocumentBackend` switch, the `missing()` outcome
class, the 2026-07-30 pool cascade, the oversize streaming ingest and its four ceilings — is in
`MIGRATION.md` §A. It was duplicated here and has been removed rather than left to drift.

Current position: work list **7,298** = 1,496 source-missing + 5,802 requeued after the purge;
`.err` on the host **106**, the genuinely unextractable; **166 documents extract to nothing**
(§3). Both host services are `systemctl enable`d and work is resumable from disk.

### 3. Extraction quality

Numbers + caveats in `MIGRATION.md` §A. OCR *word-salad* is still 0.23% of chunks and 30 of 40
sampled documents had zero bad chunks. The 2026-08-03 scorecard found a defect the heuristics cannot
see — **word-JOINING** (`tovoicemyopposition`), 23–29× more frequent on the OCR path, pronounceable
and so scoring clean. **Sized 2026-08-04: it costs 3 of 32 retrieval misses.** "OCR is not the
problem" turns out to have been roughly right after all, for the wrong reason — the extraction is
imperfect and the retrieval loss is mostly elsewhere.

**Ordering rule, added 2026-08-04: nothing expensive runs before the cheap experiment that could
invalidate it.** It paid for itself twice in one day. The ` AND ` join was the leading explanation
and a cheap experiment killed it; the chunk-presence probe then showed **78% of misses have the
phrase intact in the chunk**, which retired extraction damage as the main term and made the GPU
re-run unjustifiable. Word-joining, the thing that looked like the answer for two days, is 9%. What
is left is search-side and free to test. In this order:

- [x] **Large-format sheets extracting to nothing — FIXED 2026-08-02/03 by 3x3 tiling.** 2,039
      documents re-run, 0 failed, **1,855 (91%) now hold real text**. Full account in
      `MIGRATION.md` §A. One thing to carry forward when reading anything below: **`tiled: true`
      means tiling beat the empty pass, NOT that the text is usable** — 83 residue documents
      carry it.
- [x] **The 166 residue — ACCEPTED AS A FLOOR 2026-08-03.** 166 of 60,578 = **0.27%**. Tiling was
      the last tool available and the 2026-08-03 pass showed the margin is already thin: 18
      recovered, about six of them useful. Not worth a new instrument. Count independently
      reproduced from `sent/*.md` at `real_chars < 32`. Reopen only if the corpus grows a much
      larger population of the same shape.
- [x] **Retrieval scoring — RAN 2026-08-03.** Numbers, method and both findings in `MIGRATION.md`
      §A. Headline: **recall@10 ≈ 0.5** across all three main strata, negative control clean at 0.
      Labels came from independent readers (`pdftotext`, page renders read by eye) rather than
      waiting on a human — see §A for why that satisfies the discipline. **At n≈15 the strata are
      statistically indistinguishable; do not rank them.**
- [x] **The ` OR ` join — RAN 2026-08-04, and the conjunction is REJECTED as the cause.** Both arms
      paired in one session, 71 labels plus control. **recall@10 0.549 → 0.577, one SE ≈ 0.059** —
      half a standard error, on 4 miss→hit against 2 hit→miss. The `text` stratum, the
      discriminating one, did not move at all (0.533 → 0.533). All four pre-stated guards hold: the
      AND arm reproduced the 2026-08-03 baseline exactly, the textless control stayed at 0 in both
      arms, and median `matchingChunks` went ~20 → ~660,000, so the knob demonstrably reached the
      wire. **recall@1 and MRR got worse** on the largest set (0.360 → 0.280, MRR 0.480 → 0.433), so
      flipping the default would cost precision and buy nothing. Full numbers, guards and the
      mechanism bucket in `MIGRATION.md` §A. The join stays ` AND `, and the temporary `anyTerms`
      knob was removed with the answer. **Label sets are now committed** (`src/scripts/retrieval-labels-{A-text,B-ocr-legacy,
      C-ocr-pdfium,D-ocr-tiled,E-control-textless}.jsonl`) — they had existed only on one host, so
      no §A number was reproducible from a checkout.
- [x] **Word-joining — SIZED 2026-08-04, and it is NOT the main term. No GPU run is justified.**
      The chunk-presence probe isolated it exactly as this item asked: word-joining explains
      **3 of 32 retrieval misses (9%)**, all on OCR strata, all `joined` rather than `split`. The
      23–29× token-rate figure stands as a measure of the *text*; it does not transfer to
      *retrieval*, where 78% of misses have the phrase intact. RapidOCR tuning, index-time
      decompounding and a different OCR engine are all still available and all still expensive —
      revisit only after the search-side lead below is closed, and expect a ceiling of about 9 points.
- [x] **The fuzzy `~1` variant on analyzer-removed terms — FOUND, FIXED and re-scored 2026-08-04.**
      `en.microsoft` removes `from`, `mine`, `that`, `with`, `those` and the reflexive pronouns at
      query time. For those, the analyzed side of `(term OR term~1)` contributes nothing, so the
      **unanalyzed `~1` side becomes the only thing the clause can match** — by edit distance,
      against unrelated tokens — turning it into a near-random *mandatory* filter that discards the
      right answer. Proved on one document: a chunk holding
      *"Sediments from the proposed Lodgepole mine will move downstream and accumulate"* verbatim and
      indexed returned **0 with fuzzy on and 1 with fuzzy off**. Fix: `ANALYZER_STOPWORDS` in
      `ai-search.js` — no `~1` (and no `*`) on those terms, the plain term stays and analyzes away
      harmlessly. **Pooled recall@10 0.549 → 0.592, 3 miss→hit and 0 hit→miss, recovered at ranks
      2/1/2, no stratum worse, control still 0.** The 20-term list is measured, not guessed, and a
      sweep of all 360 distinct ≥4-char terms in the label corpus found no others. Full account,
      including the two false leads it cost, in `MIGRATION.md` §A.
- [ ] **Residue: blanket `--no-fuzzy` still scores 2 labels higher (44 vs 42).** Not more stopwords —
      the vocabulary sweep came back clean. It is fuzzy diluting BM25 on ordinary terms, i.e. a
      ranking effect rather than a zeroing one. Worth one experiment before anyone trades typo
      tolerance away for it: score with `~1` kept but down-weighted (`term~1^0.5`) so the fuzzy arm
      stops competing with the exact arm on score.
- [x] **`text`-stratum misses — ANSWERED 2026-08-04: the text is there, the search does not return
      it.** 16 of 17 `text`-stratum misses have the phrase verbatim in a stored chunk, and
      `retrieval-labels-text` classified **25 of 25 `exact`**. Six hypotheses tested; the surviving
      one is the fuzzy interaction above. Correction for anyone re-reading the older entries:
      `content` is `retrievable: false`, so it can **not** be read with a data-plane query either —
      the search service returns highlight fragments only, and Cosmos is the sole source of chunk
      text. `src/scripts/probe-phrase-presence.js` is the instrument.
- [ ] **Chunk overlap never fires on the common path — measured 2026-08-04.** `emit()` calls
      `splitText()`, which returns any block under `MAX_CHUNK_SIZE` (4000) unchanged, and blocks are
      emitted at `TARGET_CHUNK_SIZE` (2500). Measured on real `chunkMarkdown` output: **0 of 4
      consecutive pairs overlap**; the oversized-single-block branch overlaps 2 of 2. Consecutive
      chunks are strictly disjoint, so a seam-straddling phrase satisfies no conjunctive query.
      Fix in `emit()`, not `splitText()`. `test/chunker.test.js`'s "…split, with overlap" never
      asserts overlap — that is why it survived. **Its retrieval cost is now MEASURED at zero:
      0 of 74 labels were present only across a seam** (`straddle-*`, chunk-presence probe
      2026-08-04). The old "~3–4% of phrases" was an estimate and it was high. Still a real chunker
      defect worth fixing on its own terms — but it buys no recall, so it rides the `pageNumber`
      re-ingest rather than justifying one.
- [ ] **`pageNumber` is fabricated, and the text path already holds the real value.** 34,153
      documents (56% of the corpus) go through `extract_text`, which iterates pages and discards the
      index. No page citations are possible today, for search results or for any summariser built on
      these chunks. Host emits `[{page, markdown}]` on the text path; OCR path keeps sequence
      numbers. **Land this and the overlap fix in ONE re-ingest** — chunk ids derive from the split,
      so each change orphans the previous chunks. Re-ingest needs no GPU if `sent/*.md` is still
      retained corpus-wide; verify that first.
- [ ] **`src/scripts/retrieval-labels-ocr.jsonl` — 25 CANDIDATES, not labels.** Seeded from document
      titles, which are metadata and not verified to be on the page; 12 marked STARVED. Scoring them
      as-is measures the title, not the extraction. Open each scan, confirm the words appear, edit or
      delete the line — then it becomes a second OCR stratum worth running.
- [ ] **The `tiled` stratum is barely scored — 2 labels, not 10.** The other 8 need an eye on a
      rendered map sheet, which is the one stratum where a wrong reading is indistinguishable from a
      retrieval miss. Renders are at `/root/demi-tiled-review/`; drop phrases into
      `D-ocr-tiled.jsonl` and re-run. Until then the tiled row in the scorecard means nothing.
- [ ] **Intake cleaner — still open, but the case for it got WEAKER.** Stripping `<!-- image -->`
      and dropping separator chunks does nothing about word-joining, which is the defect actually
      costing retrieval. Worth doing as tidying; do not expect it to move recall. **Not** an OCR
      re-run.

### 4. `eagle-api`'s hardcoded API key on the DEMI sync route — CLOSED 2026-08-04

Resolved by `bcgov/eagle-api#836`, squash-merged to `develop` as `6567071`. The route was **deleted**
rather than hardened: `api/controllers/demi.js` (with its
`process.env.DOCLING_API_KEY || 'eagle-demi-api-key'` fallback and its `!==` comparison), the
`/document/sync` swagger path, the Helm `DOCLING_API_KEY` env block and both `secrets.demi` values
entries all went. Nothing in eagle-api trusts a DEMI credential now, and there is no sync route to
harden — eagle-api and DEMI stay decoupled until a real integration is designed.

Left behind there, non-blocking and not ours to land: four now-unread `Document` schema fields
(`demiReviewStatus`, `contentExtracted`, `contentPageCount`, `contentExtractionError` —
`extractionMethod` and `contentExtractedAt` are still read by eagle-admin), the orphaned
`eagle-demi-api-key` secret in `6cdc9e-dev`, and workspace docs still advertising
`POST /api/document/sync`.

### 5. Needs a human, not code

- **AI Services Hub registration.** Platform documents that *"Provisioning Azure AI services is
  managed through the AI Services Hub in the Landing Zones"*, requested via
  <https://bcgov.github.io/ai-hub-tracking/>. `demi-search-dev` created directly, without that
  request. Nothing blocked it, nothing broken, but process skipped — submit before this go past dev.
- **`rg-epic-search` is NOT OUR PROJECT. Do not investigate it, cost it, or track it here.** It
  shares the `c4b0a8` billing group, so it surfaces in any subscription-wide cost query — sharing a
  bill is not owning a system. The previous inventory of its VMs, App Service plans, Cognitive
  Services accounts and Postgres server has been removed from this file: it was work on somebody
  else's estate and it kept inviting more. Scope stays `c4b0a8-dev-rg` and the DEMI resources
  (`demi-api-dev`, `demi-cosmos-dev`, `demi-search-dev`, the frontend web app). If something ever
  genuinely couples DEMI to it, raise that specific coupling — do not reopen the area.

---

## Backlog

- ~~**The extraction host's code is unversioned.**~~ — **done 2026-08-04.** `worker.py` (1,193
  lines), `ingest.py`, `test_poolfix.py`, `HANDOFF.md` and the three systemd units now live under
  `extraction-host/`, with a `.gitignore` excluding the env file, every `.bak`/`.pre-poolfix` scratch
  copy and ~44 GB of run state. Verified on the staged bytes: no literal key material, no private
  addresses — the repo is public. Keeping the GPU box off-platform stays settled; only the source
  moved. **The "~45 self-checks" claim was wrong**: it is 8 assertions in one `selfcheck()`, all on
  `decide()`, the text-vs-OCR routing rule. `python3 extraction-host/worker.py --selfcheck` runs with
  no network, no GPU and no docling.
- **`gpu-extractor.env` permissions — CHECKED 2026-08-04, the exposure does not reproduce and no
  rotation is needed.** The file is `600 root:root` inside a `700 /root`, as is its `.bak`. Grepping
  the literal 48-char value across `/tmp`, `/var/tmp`, `/var/log`, `/home`, `/srv`, `/opt` and
  `/root` returns those two files and nothing else; it is absent from `.bash_history` and
  `.python_history`. Every consumer reads `os.environ["DEMI_ADMIN_KEY"]` — `worker.py:80`, the ten
  `scratch/*.py` probes, `ingest.py` — and the one world-readable file that names it,
  `/tmp/trap_probe2.py`, does `os.environ.setdefault("DEMI_ADMIN_KEY", "test")`. The `644` on the
  scratch scripts is real but harmless: they hold no value, and `/root` is not traversable. Do not
  re-check this. The env file is excluded from `extraction-host/` by `.gitignore`.
- ~~**No RU observability on a serverless account.**~~ — **baseline landed 2026-08-04.**
  `bulkVerified` now sums `requestCharge` across every attempt (a throttled operation is billed on
  each one) and the chunk-ingest path logs it per document — `document.js:638`, `[chunk-ingest]`.
  That covers writes, which is where the volume is. **Reads are still unmeasured**: `query()` has
  returned `requestCharge` all along and nothing on the read path reads it. Related: `bulkVerified`
  explicitly ignores
  `retryAfterInMs` in favour of linear backoff, and `bulk()` discards results from earlier 100-op
  sub-requests when a later one throws, so the retry re-sends the whole pending set — correct,
  because upserts are idempotent, but the RU is paid twice.
- ~~**Typesense references outlive Typesense**~~ — **swept 2026-08-04.** `chunker.js`, `config.js`,
  `chunker.test.js`, `chunks.js` (the `transform-nosql.js` citation pointed at a file that never
  existed), `server.js`, `access-sql.js`, `merge/project.js`. Comments that explain Typesense as
  *history* were left alone; only present-tense claims were rewritten. Three were load-bearing
  rather than cosmetic:
  - `document.js` and `purge-extraction.js` justified best-effort index deletes with "a nightly full
    sync reconciles whatever this misses". **Nothing reconciles** — no full sync, no alias swap, and
    no deletion-detection policy configured. The code was already right; its stated reason was false.
    A failed index delete leaves searchable text until someone re-runs it.
  - `access-sql.js` credited Typesense with enforcing visibility via scoped search keys. It is
    `access-odata.js`, at query time, that does so — worth stating exactly, since it is what makes a
    privileged read safe.
  - `merge/project.js` said the sync swaps to `[lat, lng]`. Nothing swaps any more, so a wrong
    coordinate order now reaches the map instead of being masked.
  **`TARGET_CHUNK_SIZE = 2500` is recorded as inherited, not re-derived.** Its Typesense RAM argument
  is void; the real lever is retrieval (chunk = the unit a conjunctive query must match within), and
  that can only be settled by re-chunking at several sizes and scoring. Handed to the re-ingest.
- ~~**`src/extract.js` should lose its Mongo writer.**~~ — **done 2026-08-04, and it went further.**
  Dropping only the write half would have left a script that cannot run in either direction: the
  whole driver loop was Mongo-driven and the account is unreachable since the teardown, so its one
  possible outcome was the "no database configured" guard erroring. Reduced to what the deferral was
  actually protecting — `extractWithDocling` and `splitAndExtract`, the docling client and the
  10-page batching. Deleted: the query loop, `replaceChunks` (the `deleteMany`→`insertMany` window),
  `markDocument`, `main()` and its guard, and the three `yarn extract*` scripts.
  **`mongodb` is out of `package.json`** — extract.js was its last user — along with the dead
  `mongoUri`/`cosmosDbUri` builders in `config.js`, which nothing read and which defaulted to
  `localhost:27017`. Nothing in the repo speaks Mongo now.
  `splitAndExtract` got its first test, which caught a real bug: `getPageCount()` sat outside the
  try meant to make an unparseable PDF fall back to a whole-file send, so a PDF that loads with a
  broken page tree threw instead of degrading. Extraction-inside-Azure stays deferred, not
  cancelled; reviving it means a new driver against Cosmos NoSQL, not restoring the old one.
- ~~**Four purge tests fell through to the LIVE search client.**~~ — **fixed 2026-08-04.** `purge()`
  reads `opts.index`; four tests passed `typesense:`, a key left behind when Typesense was replaced,
  so they exercised the real `ai-search` module. Harmless only because `deleteChunksForDocument`
  returns 0 when `SEARCH_ENDPOINT` is unset — but `server.js` loads `dotenv`, so on a machine with a
  populated `.env` the suite would have issued live deletes against the dev index. Renamed the fake
  to `fakeIndex` and asserted `state.deleted` in the live tests, so the next rename fails in the
  suite rather than in Azure.
- **Two test gaps, one narrowed.** `cosmos.bulk()`'s >100-op chunking is still untested, including
  the discard-on-throw behaviour above. On the chunker side, the overlap tests added 2026-08-04 read
  `MAX` and `OVERLAP` from `src/config.js`, so those two knobs are now genuinely asserted to reach
  the chunker — but `TARGET` and `MIN` are still only checked against literals (`>= 2000`, `> 100`),
  so a silent env change to either still orphans every chunk already written without failing a test.
- ~~**Chunk overlap never fires.**~~ — **fixed 2026-08-04, code only.** `emit()` called
  `splitText()`, which returns any block under `MAX_CHUNK_SIZE` (4000) unchanged — and blocks are
  emitted at `TARGET_CHUNK_SIZE` (2500), so on the common path it was a no-op and consecutive chunks
  shared nothing. `splitText` did overlap pieces *within* one oversized block, which is why this
  looked fine. Fixed in `emit()`: the tail of the previous chunk is prepended to the next block,
  joined with `\n\n` because that is exactly how the two blocks sat in the source, so a phrase that
  spanned the boundary is now contiguous. Two traps handled: the `MIN_CHUNK_SIZE` floor measures the
  block's OWN text, or 200 characters of overlap would rescue every sliver into a chunk of almost
  entirely duplicated text; and a chunk may now run to `MAX + OVERLAP`, still bounded.
  **THE DEPLOYED CORPUS IS UNCHANGED.** This fixes future writes only — every chunk in Cosmos and
  AI Search stays disjoint until some re-ingest, and none is planned. **It buys no recall**: the
  measured cost of the bug was zero, 0 of 74 labels sat only across a seam. It is a correctness fix
  so the code does what it claims. When it does eventually land, it is not free — ~200 duplicated
  characters against ~1.13M chunks is roughly 226 MB of extra indexed text, and RU to write.
  The old test passed because it asserted only `length > 1` and the size ceiling; the new one fails
  against the old chunker, which was verified rather than assumed.
- **`pageNumber` is a citation feature, and nothing cites. DO NOT BUILD IT YET.** It is a sequence
  number, not a PDF page, and the whole chain would have to change to make it real:
  `extraction-host/worker.py:471` `extract_text` builds a per-page list then returns
  `"\n\n".join(...)`, discarding the index **and dropping blank pages**, so it cannot be recovered by
  counting separators; the OCR path is 25-page batch granular (`OCR_BATCH_PAGES`), one
  `export_to_markdown()` per batch; the ingest payload carries paragraphs, not pages; and
  `createChunkAccumulator` invents the value. So it needs host + wire-protocol + API changes **and**
  re-extraction — it is not a re-chunk, which is what an earlier plan assumed.
  Its value is jumping to the source, and there is nothing to jump with: no PDF viewer and no
  `#page=` anchor anywhere in the frontend, which renders it honestly as `Passage {{ pageNumber }}`.
  **If citations are ever wanted**, the cheap slice is the text path — 56% of the corpus, pypdfium2,
  no GPU — but it still needs source PDFs (~1,496 already 404 in the dev object store). `#page=N` is
  a client-side fragment so it survives a presigned URL unmodified; whether the browser honours it
  depends on the object being served inline rather than as an attachment, which is **unverified**.
- **Search has no result paging at all.** `searchChunks` sends only `top` (default 20, hard cap 250)
  and **never sends `$skip`**; the controller has no offset and the frontend has no load-more. You
  get one slab and the list ends. Unrelated to `pageNumber` — a different axis. If it is ever wanted:
  `$skip` caps at 100,000 and deep skips degrade, and score-ordered paging is unstable across
  requests, so infinite scroll needs a deterministic tiebreak in `$orderby` rather than score alone.
  `@odata.count` is already requested, so a total is free. Left alone deliberately: nobody uses DEMI
  yet, and this is a decision for whoever owns the search UI.
- ~~**`wwwroot` debris.**~~ — **swept 2026-08-04** through Kudu VFS, and it was wider than the twelve
  probe scripts recorded here. Also removed: stale `helm/` (the old OpenShift chart, deleted from the
  repo but still deployed — checked first, it holds secret *references* only, no credential values),
  and empty `openshift/`, `scratch/`, `tmp/`, `.claude/`, `.vscode/`, `src/models/`. Deleted in three
  groups with a health check between each. **`public/` deliberately untouched** — it is the live
  frontend, not debris. After: `/projects` and `/documents` 200, `/search?dataset=DocumentChunk`
  still `count: 29392`, `public/` intact with its main bundle. `config-zip` merges rather than
  replaces, which is why any of this persisted.
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
- ~~**`azure-deploy-dev.yaml` would deploy `main.bicep`** on any push to `main` touching
  `azure/**`.~~ — **defused 2026-08-04.** The `deploy-infra` job is now `validate-infra`: it runs
  `az bicep build` and nothing else. The `az group create`, `arm-deploy` and Azure login steps are
  gone, so the job cannot deploy even once a credential exists — it is validation-only by
  construction, not by lack of auth. Both app-deploy jobs still gate on it, so a broken template
  still blocks a release. `main.bicep` **still does not describe dev** (never instantiates
  `cosmos-nosql.bicep`, `ai-search.bicep`, `identity.bicep`, `document-storage.bicep` or
  `frontend-web-app.bicep`; no VNet in the RG) — rewriting it is still open, it just is no longer a
  loaded gun pointed at the CI credential. Infrastructure changes go through `az` by hand meanwhile.

---

## Open decisions

| # | Question | Default | Cost of reversing |
|---|---|---|---|
| 1 | Backup mode `Continuous7Days` on dev | Not done | **One-way.** Gain 8h/support-ticket → 7-day self-service, free tier; lose Geo backup redundancy permanently |

Settled, kept only because reversing them is expensive: **index tier** (Basic, `content`
`retrievable: false` — Basic→S1 need a **new service + full reindex**) and **delete propagation**
(hard delete + immediate index delete; the `_ts` high-water mark seeing no deletes is measured, not
assumed).
