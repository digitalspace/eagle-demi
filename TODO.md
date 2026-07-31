# DEMI — TODO

**Updated 2026-07-31.** Actionable work only. Rationale in `MIGRATION.md`; agent rules in `CLAUDE.md`.

Status: **dev only, no test/prod.** Items = backlog, not incidents.

---

## State of play — start here

**Live now.** Azure AI Search `demi-search-dev` (Basic, keyless, private endpoint only) serve all three datasets — `demi-chunks` 80,354 rows, `demi-projects` 393, `demi-documents` 60,578 — indexers on `PT5M` schedule. **Typesense deleted**: Container App, both Container Apps environments, its storage account + file share, `src/typesense/`, dependency, sync scripts. `az containerapp list -g c4b0a8-dev-rg` return nothing.

Verified through API before cutover, per dataset: ACL gate anonymous **0** / privileged **1**, one-edit fuzzy, prefix search, nonsense → 0, snippets escaped with only `<mark>` surviving, project centroids still in British Columbia.

**Cost.** AI Search Basic fixed ~$75-81/mo whether queried or idle. `demi-budget-dev` window open **2026-08-01**, so first real post-Typesense reading arrive then — `currentSpend` read 0.0 until then.

### Next, in code

1. **Phase 8 — retire `demi-mongo-dev-*`.** Still on request path: `src/models/base.js` → `src/db/cosmos.js` (Mongo-API client), reached by four controllers wired unconditionally in `src/routes/api.js` — `search`, `db`, `log`, `wildfire`. Two keywordless list paths in `search.js` (`Project.find`, `Document.find`) become `projectsRepo.listVisible` / `documentsRepo.listVisible`, already exist + tested; `logs` and `wildfires` containers already exist NoSQL side; `/db/stats` should DROP its four legacy `countDocuments()` calls, not port them — that endpoint hang for minutes. Then account, `demi-mongo-pe` + its NIC.
2. **Extraction quality** — deferred deliberately, this order: slide decks extracting to nothing but `<!-- image -->` (indexed, unfindable by content) → retrieval scoring run → only then intake cleaner, scoped to stripping placeholders + separator-only chunks. **Not** OCR re-run: word-salad 0.23% of chunks.

### Needs a human, not code

- **AI Services Hub registration** — platform require AI service provisioning go through <https://bcgov.github.io/ai-hub-tracking/>; `demi-search-dev` created directly.
- **Provenance from LXC 109 (`doc-ocr-processor`)** — API accept `extraction` object now, but host must send it. Until then, no quality number splittable by OCR path vs text-layer path.
- **`rg-epic-search` (test subscription)** — not ours. Correcting this file's old claim: `Standard_E32-16ads_v5` VM **deallocated**, but `vm-postgresql-vector` (`Standard_D8s_v3`, GeneralPurpose) **running**, alongside three App Services, three plans, App Gateway WAF policy, Log Analytics, storage. Someone confirm owner + bill.

---

## Now — Deep Search backend

Cosmos full-text search **ruled out**. Fuzzy `distance` silent no-op even with `EnableNoSQLFullTextSearchPreviewFeatures` enrolled and container rebuilt after enrolment (`MIGRATION.md` §F trap 6). Fuzzy required — frontend send `fuzzy=true` on all three datasets. Replacement: **Azure AI Search Basic**, ~$75-81/mo.

### A. Clean up the Cosmos FTS dead end — ✅ done 2026-07-31, deployed

- [x] `src/repositories/chunks.js` — `CONTAINER` back to `'chunks'`, header comment rewritten.
- [x] `chunksFtsContainer` deleted from `azure/modules/cosmos-nosql.bicep`, live container dropped (verified 0 documents first, via control-plane `DocumentCount` metric — data plane behind private endpoint).
- [x] `'chunks_fts'` out of `INDEXED_CONTAINERS`, `src/controllers/db.js`.
- [x] `COSMOS_FTS_FUZZY` app setting removed, `stop`/`start` applied.
- [x] `git stash@{0}` dropped.
- [x] Pulled forward from B, since all dead moment container had no full-text policy: `searchText` / `tokenize` / `FUZZY_ENABLED` / `MAX_FUZZY_DISTANCE` in `chunks.js`, `buildSnippet` + `escapeHtml` in `search.js`, `queryRanked` / `drainRanked` + ranked timeouts in `src/db/cosmos-nosql.js`, and their tests.
- [x] `dataset=DocumentChunk` answer `200 [{"searchResults":[]}]` in one round trip, no query issued, warning ONCE per process. Not 503 — `fetchWithRetry` retry 5xx twice at 1s and frontend land on empty chunk list either way.

**Deep Search over chunk text was dark from this change until B's app wiring landed same day.** Project and Document datasets unaffected throughout (still Typesense).

### B. Build AI Search Tier 0

**Tier 0 infra spike done 2026-07-31.** `demi-search-dev` (Basic, keyless, private) index whole `chunks` container, every probe passed — details + traps in `MIGRATION.md` §G.

- [ ] **Governance gap — register with AI Services Hub.** Platform documents that *"Provisioning Azure AI services is managed through the AI Services Hub in the Landing Zones"*, requested via <https://bcgov.github.io/ai-hub-tracking/>. Service created directly, without that request. Nothing blocked it, nothing broken, but process skipped — submit request describing what being built, before this go past dev.

- [x] `azure/modules/ai-search.bicep` — Basic, canadacentral, `disableLocalAuth`, UAMI `demi-identity-dev`. **`publicNetworkAccess` MUST be `Disabled`** — landing-zone policy `Deny-PublicPaaSEndpoints` reject deployment otherwise. Inbound private endpoint added.
- [x] Shared private link, `groupId: Sql` → `demi-cosmos-dev`, approved Cosmos side.
- [x] `demi-chunks` index + `demi-chunks-ds` data source + `demi-chunks-indexer`, `_ts` high-water mark. First run: **80,355 items, 0 failed, 4m46s.** Index count matched Cosmos exactly.
- [x] Base64 key via indexer's built-in `base64Encode` field mapping; raw `a::p1::c0` id kept in separate `chunkId` field so hit resolve back to its Cosmos row.
- [x] Private DNS resolves. **Not a blocker — landing zone create `A-record` about ten minutes after private endpoint**, and check two minutes in return PUBLIC address, which look exactly like missing zone. Verified by hostname from inside VNet: `demi-search-dev.search.windows.net -> 10.46.51.10`, `HTTP 200`. App need no SNI trick, no gateway in front.
- [x] **App wired, deployed, verified through API 2026-07-31.** `src/helpers/access-odata.js` (OData twin of `access-sql.js`), `src/search/ai-search.js` (fetch + same UAMI Cosmos use — no new dependency), `DocumentChunk` branch of `src/controllers/search.js`, delete propagation in `deleteDocument`. Indexer on `PT5M` schedule; UAMI upgraded from Index Data Reader to **Index Data Contributor** (deleting from index is write).
- [x] `demi-projects` (393 rows) and `demi-documents` (60,578 rows) built, both 0 failed, both on `PT5M` schedule. Verified through API: ACL gate anonymous **0** / privileged **1** each, prefix search, nonsense → 0, project centroids still land in British Columbia.
- [x] Delete propagation on all three indexes. **Measured, not assumed:** deleting probe project + document left both rows searchable — `_ts` high-water mark cannot see deletes at all. `deleteFromIndex` now run in `deleteProject` and `deleteDocument`. Typesense used to remove deleted documents, so shipping without this = regression, not gap.
- [x] `src/helpers/access-odata.js`, sharing `TIER` / `rolesFor()` with `access-sql.js`. **OData has no `false` literal**, so fail-closed collapse is JS short-circuit returning `[]` without issuing request. Takes `partitionField`: projects scope on `id`, everything else on `projectId`.
- [x] All three `dataset` branches rewritten. Query shape `(term OR term~1)` per term, plus `term*` prefix on LAST term only — Typesense ran `prefix=true` and frontend search on debounced keystrokes, so without it results thin out mid-typing.
- [x] Snippets come from `@search.highlights` with `content` non-retrievable, escaped first, marked second, balanced per fragment.

### C. Verify — ACL gate first

Run against INDEX 2026-07-31, one throwaway `ZZ-` document with `read: [sysadmin, staff,
demi-admin]`, exact counts, one output file per probe. **Re-run all of it against rewritten `search.js`** — this pass proved index + filter syntax, not application.

- [x] ACL gate — anonymous (`read/any(r: r eq 'public')`) → **0** · privileged (no filter) → **1**.
- [x] `quokkafluxion` → 1 · `quokafluxion~1` (1 edit) → **1** · `zzqxwvfluxion` → **0** · stopwords (`the and of`) → **0** · `assess` against indexed "assessed" → **1**.
- [x] Highlights returned with `content` non-retrievable; response carried `chunkId` only, no chunk text.
- [x] Index count **80,355 = Cosmos `DocumentCount` 80,355**, then **80,354** after cleanup, **0** `ZZ-` rows left in either. Cosmos metric lag ~10 minutes — read both same moment or delta is artefact.
- [x] Same matrix through API, all three datasets.

### D. Delete Typesense — ✅ done 2026-07-31

- [x] Code: `src/typesense/` + its tests, `typesense` dependency, both `typesense:sync*` scripts, client calls in `deleteDocument`, nightly full-sync step — AI Search indexers PULL every five minutes, nothing left to push.
- [x] Infrastructure: Container App, `demi-ca-env-dev`, orphan `demi-container-env-dev`, `tsstgdevpcbd7cygyic52` storage account + its `typesense-data` share. `az containerapp list` now empty.
- [x] Templates: `container-apps.bicep` deleted, `typesenseApiKey` / `typesenseUrl` params + outputs removed from `main.bicep` and `api-web-app.bicep`, `TYPESENSE_*` app settings deleted.

**Rollback** = `git revert` plus redeploying `container-apps.bicep` from history; index rebuild from Cosmos by indexer run, not from backup.

#### The recall trap this nearly walked into

Typesense indexed `projectName` on every document and searched it. Cosmos document row has no `projectName` — resolved through lookup at sync time — and AI Search indexer read ONE container, so field could not come along. Measured against live Typesense index before writing replacement, hits with `projectName` in `query_by` versus without:

| term | with | without | lost |
|---|---|---|---|
| Ajax | 850 | 199 | **77%** |
| pipeline | 2,267 | 771 | **66%** |
| Coastal GasLink | 823 | 319 | **61%** |
| Site C | 2,158 | 1,570 | 27% |

So `searchDocuments` run SECOND leg: match projects by name, then pull their documents in by `projectId` under caller's own document ACL. Verified with probe document whose only link to query term is its project's name.

---

## Extraction quality — Phase 1 measured 2026-07-31

Numbers + caveats in `MIGRATION.md` §A. **OCR not the problem: word-salad 0.23% of chunks, 30 of 40 randomly sampled documents had zero bad chunks.** What broken is narrower.

- [x] `src/scripts/audit-chunk-quality.js` + fixtures, re-runnable for before/after comparison.
- [x] Optional `extraction` provenance on ingest contract (path, engine, version, options).
- [ ] **Send provenance from extraction host** (LXC 109 `doc-ocr-processor`, out of repo). Until then, no quality number attributable to OCR path versus text path — absent on all 400 documents audited.
- [ ] **Slide decks extract to nothing but `<!-- image -->`.** Eight of sampled documents in index, unfindable by content. Find out whether router sent them down text path on thin text layer, or whether OCR ran and returned nothing. Real defect; about coverage, not engine quality.
- [ ] Retrieval scoring on human-labelled phrases — verdict metric. Heuristics cannot see character-spacing damage (`Tum ble r Ridge` score clean), so only this close the question.
- [ ] Only then decide on intake cleaner. On current evidence job small: strip `<!-- image -->`, drop chunks that are pure separator furniture. **Not** OCR re-run.

---

## Open decisions

| # | Question | Default | Cost of reversing |
|---|---|---|---|
| 1 | ~~Index tier / `content` retrievable?~~ | **SETTLED 2026-07-31.** Basic, `content` `retrievable: false` — highlights still come back, nothing lost | Basic→S1 still need **new service + full reindex**; `retrievable` itself mutable field property |
| 2 | Delete propagation | Hard delete + immediate index delete | **Reverses 2026-07-30 decision** whose reasoning relied on nightly Typesense sync that D deletes. High-water mark seeing nothing now measured, not assumed |
| 3 | Backup mode `Continuous7Days` on dev | Not done | **One-way.** Gain 8h/support-ticket → 7-day self-service, free tier; lose Geo backup redundancy permanently |

---

## Backlog

- **Phase 8 — decommission Mongo.** Delete `demi-mongo-dev-*` after clean week. Boot-path order matters: `src/utils/logger.js` → `models/log` → `src/db/cosmos.js`, plus `controllers/{search,db,log,wildfire}.js` required unconditionally at `src/routes/api.js`. 17 files touch legacy layer. **Blocked until Deep Search on AI Search.**
- **Nothing in Azure extracts text.** Ingest exists (external host POST markdown to `POST /documents/:id/chunks`); `src/extract.js` run only under `require.main === module`. Deliberate — serverless GPU priced and rejected. Do not delete as dead code.
- **Extraction ~7% done** against 60,578 documents.
- **CI blocked.** `AZURE_CLIENT_ID` missing from repo secrets. Need Entra app registration + federated credential; creating one need Microsoft Graph, which conditional access blocks.
- **`azure-deploy-prod.yaml` / `-test.yaml` trigger on every push to `main`** — no tag, no approval. Inert today. **Gate before adding OIDC credential.**
- **`models/syncState.js` scheduled nowhere.**
- **`readFilter` legacy tier** for rows with no `read[]`: run `src/scripts/backfill-read-acl.js` inside network, then delete tier.
- **Phase 3b blob storage** — code + Bicep written, not deployed, nothing copied. Need `Storage Blob Delegator` or every download link fail to sign.
- **`rg-epic-search` (test sub)** — pgvector POC, `Standard_D8s_v3` Postgres + running `Standard_E32-16ads_v5` VM, two of three APIs stopped. Not ours; someone confirm cost and revive or decommission.

---

## Docs

`MIGRATION.md` source of truth · `CLAUDE.md` agent rules · `README.md` orientation · this file for what left to do. **Record finding once, in file that owns the topic.**

- [ ] Prune `MIGRATION.md` (1,423 lines). Cosmos migration completed at 2026-07-30 cutover; only Phase 8 open. Keep *Verified facts*, *Operational gotchas*, Phase 8 hazard, seed traps. §F now ruled-out record, not build plan.
- [ ] Verify every `README.md` claim against running system.