# DEMI — TODO

**Updated 2026-08-01.** Actionable work only. Rationale in `MIGRATION.md`; agent rules in `CLAUDE.md`.

Status: **dev only, no test/prod.** Items = backlog, not incidents.

---

## State of play — start here

**Live now.** Azure AI Search `demi-search-dev` (Basic, keyless, private endpoint only) serve all three datasets — `demi-chunks` 80,354 rows, `demi-projects` 393, `demi-documents` 60,578 — indexers on `PT5M` schedule. **Typesense deleted**: Container App, both Container Apps environments, its storage account + file share, `src/typesense/`, dependency, sync scripts. `az containerapp list -g c4b0a8-dev-rg` return nothing.

Verified through API before cutover, per dataset: ACL gate anonymous **0** / privileged **1**, one-edit fuzzy, prefix search, nonsense → 0, snippets escaped with only `<mark>` surviving, project centroids still in British Columbia.

**Cost.** AI Search Basic fixed ~$75-81/mo whether queried or idle. `demi-budget-dev` window open **2026-08-01**, so first real post-Typesense reading arrive then — `currentSpend` read 0.0 until then.

### Next, in code

1. **Phase 8 — DEPLOYED + VERIFIED LIVE 2026-08-01. Azure teardown left, earliest 2026-08-08.** Mongo-API layer cut out of the app: `src/models/`, `src/db/cosmos.js`, `src/helpers/access.js`, legacy controllers, `sync_from_openshift` / `seed-and-merge` / `nightly-sync`, `backfill-read-acl`, and the `USE_COSMOS_NOSQL` switch all deleted. `grep -rn "models/\|db/cosmos'" src/` return only `src/extract.js`. What changed beyond a straight port:
   - Log DB writes DROPPED, not ported. `CosmosLogTransport` was the deepest boot-path edge (`app.js` → `logger` → `models/log`). Console only; App Service ship stdout to Log Analytics. `GET /admin/logs` gone.
   - `GET /wildfires` gone — no consumer, frontend read DataBC WFS direct. Sync KEPT, now on `src/repositories/wildfires.js` + `projectsRepo.patchWildfireStats` (was whole-item `Project.upsert`, which would erase Track/NRPTI writes).
   - `sync-nrpti` stop embedding full record objects into projects (`nrptiRecords` + `sources.nrpti.records`) — that the 2 MB item-cap bug `repositories/records.js` header describes. Bounded aggregate via `patchNrptiStats` only. Records now write `projectId` (partition key) and `dataset`, not `project` / `nrptiSchemaName`.
   - Seed/sync ROUTES deleted (`/db/seed`, `/sync`, `/admin/sync`, `/admin/seed-track`) — `seed-nosql.js` replace them and run inside network, past any request timeout. `/admin/sync/nrpti` + `/admin/sync/wildfires` stay.
   - **`src/extract.js` still `require('mongodb')`** and read `MONGODB_URI`. Deleting the account break it. Deferred-not-dead (Azure extraction path); extraction run on LXC 109 through API, so nothing live regress. `mongodb` dependency kept for it alone. **Guard added 2026-08-01**: `main()` throw when none of `COSMOSDB_URI`/`MONGODB_URI`/`COSMOSDB_HOST`/`MONGODB_HOST` set. `src/config.js:15-41` otherwise default to `mongodb://localhost:27017/epic`, so post-teardown run would report zero documents — silent no-op dressed as clean run. Explicit localhost still allowed.
   - **Missed by the cut, removed 2026-08-01**: `api/index.js` still registered `app.timer('nightlySyncTimer')` whose handler `require('../src/scripts/nightly-sync')` — file deleted. Lazy require inside `catch`, and `AzureWebJobs.nightlySyncTimer.Disabled=true` live, so it failed silently once a night instead of at boot. AI Search indexers pull on `PT5M`; nothing left for a nightly push. Delete that app setting too.

   **DEPLOYED + VERIFIED LIVE 2026-08-01.** Kudu deployment `status 4`. All five probes pass, one output file each. **Clean week start 2026-08-01** — teardown earliest 2026-08-08.

   - [x] **`GET /db/stats`** — `driver: azure-cosmos-nosql`, `database: demi`, `projects 393 / documents 60,578 / boundaries 281`, ~0.7 s.
     **The stated proof was wrong.** Pre-deploy baseline answered in **2.2 s**, not minutes, so latency discriminate nothing. PAYLOAD is the proof: old build return `driver: azure-cosmos-sdk`, `database: epic`, legacy counts `4412 / 18,969 / 28,559`. Take the baseline BEFORE deploying or this probe cannot fail.
   - [x] **ACL gate.** `GET /search?dataset=Project` with no keywords **cannot fail either** — page size cap 10, and every one of the 393 projects carry `public`, so anonymous and `X-Api-Key` legitimately return the same rows. Needed the §C method: throwaway project `read: [sysadmin, staff, demi-admin]`, unique token. Search path (OData) anonymous **0** / privileged **1**. Point read, index-free, `canRead()`: anonymous **404** / privileged **200**. Probe deleted, `removedFromSearch: 1`, index hits **0** immediately.
   - [x] **Fault fallback** — `SEARCH_ENDPOINT` (not `AI_SEARCH_ENDPOINT`; that name exist only in stale `azure/main.json`) at bad host. Nonsense term `zzqxwvfluxion`: healthy **0**, broken **10** on Document AND Project — fallback fired. `DocumentChunk` **0** both, no fallback by design (`search.js:312-319`). `keywords=pipeline` prove nothing, rows come back either way. Restored, matrix match pre-break baseline exactly.
   - [x] **Patch-not-replace** — wildfire sync: 815 wildfires, 392 projects updated. Then NRPTI sync. Checked all 393 track projects INDIVIDUALLY: `sources.track` byte-identical **393/393**, `sources.wildfire` byte-identical **393/393** (survive the later NRPTI sync — the strong form), `sources.eagle` intact, embedded `nrptiRecords[]` **0**, no item over 1.5 MB.
   - [x] **`GET /admin/logs`, `GET /wildfires`** → **404** both, anonymous and privileged. `X-Request-ID` present on responses.
   - [x] Inert app settings deleted: `USE_COSMOS_NOSQL`, `AzureWebJobs.nightlySyncTimer.Disabled`. `MONGODB_URI` + `MONGODB_DATABASE` KEPT — they are the rollback path until teardown.

   **Traps this pass hit — all of them "probe cannot fail" in a new costume:**
   - **A restart does not mean the new code is answering.** First request after `stop`/`start` served the OLD build from a still-warm worker: `/db/stats` return the legacy payload while `wwwroot` already held the new file. Same again on app-setting changes — first fault-fallback run reported healthy numbers because `SEARCH_ENDPOINT` had not reached the worker. **Poll on a discriminator until it flips before trusting any post-restart probe.** Propagation ran to several minutes, well past the ~50 s cold start.
   - **`config-zip` merge leave deletions behind.** `src/db/cosmos.js`, `src/helpers/access.js`, `src/typesense/`, `src/scripts/nightly-sync.js` all 404 in `wwwroot`, but `src/models/` survive as an EMPTY directory. Verify by content through Kudu VFS; SCM basic auth is disabled, use an AAD bearer (`az account get-access-token --resource https://management.core.windows.net/`).
   - **`pageSize=5000` silently cap at 1000.** First patch-not-replace pass read that truncation as 201 projects losing `sources.track`. Per-id reads, not a list, when the question is data loss.
   - **`POST /admin/sync/nrpti` 504 at 240 s** on App Service request timeout — the sync keep running server-side regardless. Use `?async=true`, and watch `/db/stats` records until stable.
   - **Side effect:** NRPTI sync grew projects **393 → 2,248** and records **0 → 48,086**. `trackOnly` default keep them out of search. Expected, but that is what the count now mean. **Possibly INCOMPLETE** — the sync outlive its 504 and kept running, then the `stop`/`start` for the app-setting deletion landed on top of it. Counts static at 48,086 after, but finished-vs-killed is not distinguishable from the outside. Re-run `POST /admin/sync/nrpti?async=true` if a complete record set matter; patch-not-replace was proven either way.

   **Left:** `azure/main.bicep:69` `cosmosDb` module + `:89` `mongodbConnectionString` wiring (its ONLY consumer), `azure/modules/cosmos-db.bicep`, `api-web-app.bicep:22-24` param + `:113-129` settings block, stale compiled `azure/main.json`, then account `demi-mongo-dev-pcbd7cygyic52`, `demi-mongo-pe` + its NIC. After a clean week — code rollback is `git revert`, no redeploy.

   Checked before planning teardown, all three worth knowing:
   - **`main.bicep` is not what run.** No VNet in the RG, and it never instantiate `cosmos-nosql`, `ai-search`, `document-storage`, `identity` — the four modules that build current architecture. So live app hold only **`MONGODB_URI` + `MONGODB_DATABASE`** (the inert `USE_COSMOS_NOSQL` deleted 2026-08-01), not the four the template declare. Settings come off with `az webapp config appsettings delete`, then `stop`/`start`. Bicep edit keep template honest for whenever IaC unblock; it delete nothing by itself.
   - **`main.bicepparam` + three workflows need NO change.** `mongodbConnectionString` is an internal module param wired from a module output, never top-level, so the `typesenseApiKey` failure below cannot repeat here.
   - **`COSMOS_ENDPOINT` safe** — live value `https://demi-cosmos-dev.documents.azure.com:443/`, the NoSQL account. `MIGRATION.md:897-908` record it once pointed at Mongo. It no longer do, so deleting Mongo cannot break NoSQL reads.
2. **Extraction STOPPED since 2026-07-30 14:08.** External extraction host halted mid-run; ~4% of 60,578 documents ingested. A crash cascade also parked **~1,712 valid PDFs as permanent failures** — the host treats a recorded error as done, so they never retry and are silently absent from the index. Needs crash recovery + a requeue of the false failures before the run restarts. Host-side, out of repo.
3. **Extraction quality** — deferred deliberately, this order: slide decks extracting to nothing but `<!-- image -->` (indexed, unfindable by content) → retrieval scoring run → only then intake cleaner, scoped to stripping placeholders + separator-only chunks. **Not** OCR re-run: word-salad 0.23% of chunks.

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
- [x] **Param CONSUMERS, missed in that pass and fixed 2026-07-31.** `azure/main.bicepparam` and all three `azure-deploy-*.yaml` still passed `typesenseApiKey` to a template that no longer declare it — every IaC deployment would fail to compile. Latent only because CI blocked on `AZURE_CLIENT_ID`; a hand-run `az deployment group create --parameters azure/main.bicepparam` hit it. Same file also pinned `budgetAmount = 50`, quietly undoing the raise to 100 in `main.bicep`; line deleted so template default is the only source.

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

- **Phase 8 Azure teardown.** Delete `demi-mongo-dev-pcbd7cygyic52` after clean week (**earliest 2026-08-08**) — see item 1 for the exact resource list. Code side done, deployed, verified live.
- **`wwwroot` debris.** Twelve ad-hoc probe scripts sit at the root of the deployed app — `_auditwrap.js`, `_copy.js`, `_copy.log`, `_derive.js`, `_fetch.js`, `_fts.js`, `_idx.js`, `_isolate.js`, `_meta.js`, `_param.js`, `_purgewrap.js`, `_syncwrap.js` — plus an empty `src/models/`. None in the repo, none reachable as routes, but `config-zip` merge never remove them. Clean out through Kudu VFS.
- **Nothing in Azure extracts text.** Ingest exists (external host POST markdown to `POST /documents/:id/chunks`); `src/extract.js` run only under `require.main === module`. Deliberate — serverless GPU priced and rejected. Do not delete as dead code.
- **Extraction ~4% done** against 60,578 documents, and STALLED — see item 2. The earlier "~7%" counted documents flagged `contentExtracted`, not documents with chunks behind them.
- **CI blocked.** `AZURE_CLIENT_ID` missing from repo secrets. Need Entra app registration + federated credential; creating one need Microsoft Graph, which conditional access blocks.
- **`azure-deploy-prod.yaml` / `-test.yaml` trigger on every push to `main`** — no tag, no approval. Inert today. **Gate before adding OIDC credential.**
- ~~`models/syncState.js` scheduled nowhere~~ — deleted with `src/models/`. The `syncState` CONTAINER still exist in `cosmos-nosql.bicep`, unwritten by anything.
- ~~`readFilter` legacy tier + `backfill-read-acl.js`~~ — both gone. `readClause` in `access-sql.js` never had the pre-ACL tier (every seeder write `read[]` explicitly), and the backfill only ever targeted the Mongo account.
- **Phase 3b blob storage** — code + Bicep written, not deployed, nothing copied. Need `Storage Blob Delegator` or every download link fail to sign.

---

## Docs

`MIGRATION.md` source of truth · `CLAUDE.md` agent rules · `README.md` orientation · this file for what left to do. **Record finding once, in file that owns the topic.**

- [ ] Prune `MIGRATION.md` (1,423 lines). Cosmos migration completed at 2026-07-30 cutover; only Phase 8 open. Keep *Verified facts*, *Operational gotchas*, Phase 8 hazard, seed traps. §F now ruled-out record, not build plan.
- [ ] Verify every `README.md` claim against running system.