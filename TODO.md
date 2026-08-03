# DEMI — TODO

**Updated 2026-08-03.** Actionable work only. Rationale + measured facts in `MIGRATION.md`; agent
rules in `CLAUDE.md`. **Record finding once, in file that owns topic.**

Status: **dev only, no test/prod.** Items = backlog, not incidents.

---

## State of play

**Live.** Azure AI Search `demi-search-dev` (Basic, keyless, private endpoint only) serve all three
datasets — `demi-chunks`, `demi-projects`, `demi-documents` — indexers on `PT5M`. Typesense deleted
2026-07-31, code and infrastructure both; `az containerapp list -g c4b0a8-dev-rg` return nothing.
`demi-chunks` held 80,354 rows on 2026-08-01; Cosmos held **995,316** chunks after the 2026-08-02
run, plus ~133K more from the 2026-08-03 oversize ingest. The index count has not been re-read (see
below).

Cosmos counts read live 2026-08-02: **projects 2,248** (the 393 figure predate the NRPTI sync),
documents 60,578, records 48,086, boundaries 281.

**Extraction, as of 2026-08-03.** Work list **7,298 outstanding** = 1,496 whose source 404s in the
dev object store + 5,802 whose false failure flags were cleared. `.err` on the host down to **106**,
the genuinely unextractable. **166 documents extract to nothing** — accepted as a floor 2026-08-03
(0.27%). Ingest handles any document size via the NDJSON path — `MIGRATION.md` §A for all of it.

**Retrieval measured 2026-08-03, first real run of the scorecard: recall@10 ≈ 0.5.** The cause is
word-joining on the OCR path, not index coverage — a self-phrase probe confirmed 14 of 22 missed
documents are indexed. Same run found a public 400 on any query containing a standalone `AND`/`OR`/
`NOT`; fixed. §3 and `MIGRATION.md` §A.

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
is pronounceable, so it scores clean and still costs the search. In this order:

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
- [ ] **Word-joining on the OCR path — the finding that needs a decision.** The extraction holds
      `tovoicemyopposition`, `ENVIRONMENTALASSESSMENT`, `OfficeofthePremier`: **23–29× more glued
      tokens on the OCR path than the text path** (measured, 400 docs/stratum). Heuristics score it
      clean because every fragment is pronounceable. It is the confirmed cause of retrieval misses
      on OCR-path documents. Options, none cheap: RapidOCR detection/merge tuning, a decompounding
      step at index time, or a different OCR engine. **Decide before any re-extraction run.**
- [ ] **`text`-stratum misses are unexplained.** Those documents are indexed and barely joined, yet
      7 of 15 labels missed. Label length does not predict it. A second cause exists and has not
      been found; a larger label set on that stratum is the next instrument.
- [ ] **The `tiled` stratum is barely scored — 2 labels, not 10.** The other 8 need an eye on a
      rendered map sheet, which is the one stratum where a wrong reading is indistinguishable from a
      retrieval miss. Renders are at `/root/demi-tiled-review/`; drop phrases into
      `D-ocr-tiled.jsonl` and re-run. Until then the tiled row in the scorecard means nothing.
- [ ] **Intake cleaner — still open, but the case for it got WEAKER.** Stripping `<!-- image -->`
      and dropping separator chunks does nothing about word-joining, which is the defect actually
      costing retrieval. Worth doing as tidying; do not expect it to move recall. **Not** an OCR
      re-run.

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
