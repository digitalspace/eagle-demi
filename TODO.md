# DEMI — TODO

**Updated 2026-08-04.** Actionable work only. Rationale + measured facts in `MIGRATION.md`; agent
rules in `CLAUDE.md`. **Record finding once, in file that owns topic.**

Status: **dev only, no test/prod.** Items = backlog, not incidents.

---

## State of play

**Live.** Azure AI Search `demi-search-dev` (Basic, keyless, private endpoint only) serve all three
datasets — `demi-chunks`, `demi-projects`, `demi-documents` — indexers on `PT5M`. Typesense deleted
2026-07-31, code and infrastructure both; `az containerapp list -g c4b0a8-dev-rg` return nothing.
`demi-chunks` held 80,354 rows on 2026-08-01; Cosmos held **995,316** chunks after the 2026-08-02
run, plus ~133K more from the 2026-08-03 oversize ingest. **Not a coverage gap** — the first index
run matched Cosmos `DocumentCount` exactly (`MIGRATION.md` §G), so the index number is simply older
than the corpus. Re-read it to confirm the `PT5M` indexer kept up; that is a confirmation, not a
mystery, and it stopped being a candidate explanation for the recall numbers.

Cosmos counts read live 2026-08-02: **projects 2,248** (the 393 figure predate the NRPTI sync),
documents 60,578, records 48,086, boundaries 281.

**Extraction, as of 2026-08-03.** Work list **7,298 outstanding** = 1,496 whose source 404s in the
dev object store + 5,802 whose false failure flags were cleared. `.err` on the host down to **106**,
the genuinely unextractable. **166 documents extract to nothing** — accepted as a floor 2026-08-03
(0.27%). Ingest handles any document size via the NDJSON path — `MIGRATION.md` §A for all of it.

**Retrieval measured 2026-08-03, first real run of the scorecard: recall@10 ≈ 0.5.** Index coverage
is ruled out — a self-phrase probe confirmed 14 of 22 missed documents are indexed. **The cause is
still not settled, and one candidate is now dead.** Word-joining on the OCR path is measured and
real (23–29×) but does not explain the `text` stratum, which loses ~40% at n=39. The **strict
` AND ` join** was the leading explanation; it was **tested 2026-08-04 and rejected** — pooled
recall@10 0.549 → 0.577 at n=71, half a standard error, `text` stratum unmoved, and the nominal lift
lands in the wrong bucket. Same run found a public 400 on any query containing a standalone
`AND`/`OR`/`NOT`; fixed. §3 and `MIGRATION.md` §A.

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
sampled documents had zero bad chunks — but **"OCR is not the problem" no longer survives the
retrieval run.** The 2026-08-03 scorecard found a different OCR defect the heuristics cannot see:
**word-JOINING** (`tovoicemyopposition`), 23–29× more frequent on the OCR path. Every glued fragment
is pronounceable, so it scores clean and still costs the search.

**Ordering rule, added 2026-08-04: nothing expensive runs before the cheap experiment that could
invalidate it.** It earned its keep on the first try — the ` AND ` join was the leading explanation
and the cheap experiment killed it, for the price of an afternoon and no GPU. The remaining
search-side candidate is chunk overlap that never fires on the common path; its mechanism is
measured, its effect on recall is not, and the OR-join result argues against it too. Still settle
what is free before spending GPU hours re-extracting 60k documents. In this order:

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
      mechanism bucket in `MIGRATION.md` §A. `anyTerms` stays default-false and unreachable over
      HTTP. **Label sets are now committed** (`src/scripts/retrieval-labels-{A-text,B-ocr-legacy,
      C-ocr-pdfium,D-ocr-tiled,E-control-textless}.jsonl`) — they had existed only on one host, so
      no §A number was reproducible from a checkout.
- [ ] **Word-joining on the OCR path — the gate cleared, and it is back to being the leading
      explanation. Still not confirmed.** The extraction holds `tovoicemyopposition`,
      `ENVIRONMENTALASSESSMENT`, `OfficeofthePremier`: **23–29× more glued tokens on the OCR path
      than the text path** (measured, 400 docs/stratum). Heuristics score it clean because every
      fragment is pronounceable. Real, and the dominant defect in the extracted text. The OR-join
      run raises the prior without testing it: with the conjunction removed the candidate set was
      effectively the whole corpus and BM25 alone chose, **and the missed documents stayed missed** —
      a filter problem reappears when the filter is lifted, and these did not. That points at the
      text not being in matchable form, which is what word-joining does. It does not single it out:
      it is equally consistent with any defect that leaves the phrase unmatchable, and **word-joining
      still cannot explain the `text` stratum**, which barely joins and lost the same ~40%.
      Options, none cheap: RapidOCR detection/merge tuning, a decompounding step at index time, or a
      different OCR engine. **Before committing GPU hours, find a cheap probe that isolates it** —
      e.g. score a set of OCR-stratum labels whose phrases are known to be glued in the extraction
      against a matched set that is not. Same discipline that just saved a re-extraction run.
- [ ] **`text`-stratum misses — back to having NO candidate explanation. This is now the sharpest
      open question in retrieval.** Re-scored at **n=39** (pooling the 2026-08-01 pypdf labels with
      the 2026-08-03 set; zero document overlap): **recall@10 = 0.590**, one SE ~8 points. The text
      path loses ~40% of labels, word-joining does not explain it (that stratum barely joins), and
      as of 2026-08-04 **four** hypotheses have been tested and rejected: label length, structured
      page furniture vs prose, index coverage, and the strict ` AND ` join — the last was the
      leading one and moved the stratum by zero. These labels were read out of each source PDF's own
      text layer by an independent extractor, so the words are demonstrably on the page. Next probe
      should attack the remaining link nobody has instrumented: whether the phrase survives into the
      **chunk** as indexed. Pull the actual `content` for a handful of missed documents from inside
      the VNet and read it — `content` is `retrievable: false`, so this needs a data-plane query,
      not the public API.
- [ ] **Chunk overlap never fires on the common path — measured 2026-08-04.** `emit()` calls
      `splitText()`, which returns any block under `MAX_CHUNK_SIZE` (4000) unchanged, and blocks are
      emitted at `TARGET_CHUNK_SIZE` (2500). Measured on real `chunkMarkdown` output: **0 of 4
      consecutive pairs overlap**; the oversized-single-block branch overlaps 2 of 2. Consecutive
      chunks are strictly disjoint, so a seam-straddling phrase satisfies no conjunctive query.
      Smaller than the item above (~3–4% of phrases, not 40%). Fix in `emit()`, not `splitText()`.
      `test/chunker.test.js`'s "…split, with overlap" never asserts overlap — that is why it
      survived. **Demoted 2026-08-04: the OR-join run argues against this being a retrieval cause.**
      A seam-straddling phrase satisfies no conjunctive query but matches both halves under a
      disjunctive one, so it should have surfaced when the join was lifted; recall barely moved.
      Still a real chunker defect worth fixing on its own terms — just not a recall fix, and it
      still has to ride the same re-ingest as `pageNumber`.
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

### 4. `eagle-api` accepts a hardcoded API key on the DEMI sync route — found 2026-08-04

Not this repo, but DEMI is the counterparty and nobody else is looking at it.
`eagle-api/api/controllers/demi.js:22-23`:

```js
const expectedKey = process.env.DOCLING_API_KEY || 'eagle-demi-api-key';
if (!apiKey || apiKey !== expectedKey) {
```

Three problems in two lines, all of which DEMI already fixed on its own side and eagle-api did not:

- **Hardcoded fallback.** Unset the env var and `syncDocumentFromDemi` authenticates against a
  literal committed to a public repository.
- **`!==` instead of `crypto.timingSafeEqual`** — the rule is in `CLAUDE.md` and `src/helpers/auth.js`
  follows it.
- **Outbound credential reused as an inbound secret.** This is the same conflation recorded under
  "Secret rotation" in `MIGRATION.md`: `DOCLING_API_KEY` was DEMI's only admin credential until
  `4bddede` split `ADMIN_API_KEY` out. DEMI removed it from `validKeys`; eagle-api still trusts it.

Fix: distinct `DEMI_SYNC_KEY`, no default, fail closed when unset, `timingSafeEqual`.

### 5. Needs a human, not code

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

- **The extraction host's code is unversioned.** Keeping the GPU box itself off-platform is settled
  and correct (`MIGRATION.md` §A) — this is about the source, which is separable. `worker.py` is
  ~1,200 lines holding essentially every hard-won fact the project owns: pdfium's non-thread-safety
  (found after 468 failures in two minutes), the docling-parse SIGTRAP that `PYTHONFAULTHANDLER=1`
  does not cover, the tiling measurement table, routing thresholds, the `CONVERTERS=3` OOM ceiling.
  The rationale survives in `MIGRATION.md`; the code implementing it exists only on the host and in
  scratch copies that already differ in length. Committing it under `extraction-host/` with host,
  env and keys excluded costs one commit, changes no deployment, and makes its ~45 self-checks
  CI-runnable. **Also check `gpu-extractor.env` permissions** — a live `DEMI_ADMIN_KEY` was reported
  sitting in a world-readable scratch path; if confirmed, rotate rather than just move it.
- **No RU observability on a serverless account.** `query()` returns `requestCharge` and **no caller
  in `src/` reads it**, against ~1.13M chunks with indexers pulling every 5 minutes. One log line on
  the ingest path establishes a baseline. Related: `bulkVerified` explicitly ignores
  `retryAfterInMs` in favour of linear backoff, and `bulk()` discards results from earlier 100-op
  sub-requests when a later one throws, so the retry re-sends the whole pending set — correct,
  because upserts are idempotent, but the RU is paid twice.
- **Typesense references outlive Typesense** (deleted 2026-07-31): `chunker.js:4`, `config.js:81`,
  `chunker.test.js:4-8`, and `chunks.js:39-40`, which cites `transform-nosql.js` — a file that does
  not exist. More than a naming tidy: `TARGET_CHUNK_SIZE = 2500` was derived from a Typesense
  in-memory-index RAM argument, and chunk size is a direct input to the conjunction problem in §3.
  Re-derive it against AI Search rather than relabelling it.
- **Nothing in Azure extracts text, and `src/extract.js` should lose its Mongo writer.** Ingest
  exists (external host POSTs markdown to `POST /documents/:id/chunks`); `src/extract.js` runs only
  under `require.main === module`. Deliberate — serverless GPU priced and rejected. **Do not delete
  as dead code**: that covers the docling client and the 10-page batching, which is the whole point
  of keeping the file. It does **not** cover the Mongo write path, which does `deleteMany` then
  `insertMany` — leaving a window where a live document has zero chunks, exactly what
  `replaceForDocument` was written to avoid. Exported, exposed as `yarn extract`, no test file at
  all. Drop that half.
- **Two test gaps worth closing.** Nothing asserts the config knobs reach the chunker — the chunker
  tests assert loose bounds against literals, while a silent env change to `TARGET`/`MAX`/`OVERLAP`
  orphans every chunk already written. And `cosmos.bulk()`'s >100-op chunking is untested, including
  the discard-on-throw behaviour above.
- **`wwwroot` debris.** Twelve ad-hoc probe scripts at the root of the deployed app —
  `_auditwrap.js`, `_copy.js`, `_copy.log`, `_derive.js`, `_fetch.js`, `_fts.js`, `_idx.js`,
  `_isolate.js`, `_meta.js`, `_param.js`, `_purgewrap.js`, `_syncwrap.js` — plus an empty
  `src/models/`. None in the repo, none reachable as routes, but `config-zip` merge never remove
  them. Clean out through Kudu VFS.
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
