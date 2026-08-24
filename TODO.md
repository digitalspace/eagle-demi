# TODO

**Goal: prod — eagle-public on Azure, served by demi-api, prod data Eagle + Track only.** Every
item below gates that or is explicitly parked. The demo frontend (`/map`, `/search`, `/summary`,
`/intake`) and its enrichment sources (wildfire, boundaries) are TEST-ONLY: supported there, never
deployed to prod. Inventory of every source and surface, one state each: wiki
[Sources-and-Status](https://github.com/digitalspace/eagle-demi/wiki/Sources-and-Status).

Open work only. Facts and history live in the [wiki](https://github.com/digitalspace/eagle-demi/wiki).
**Merging is deploying** — `main` is live on staging within minutes, and test search is already
served to eagle-public, so a test regression is user-facing. Append newly discovered work here
before doing it; strike a wrong line with a one-line reason. Reviewer takes a positional sha
(`review.sh --repo eagle-demi <sha>`). Condensed 2026-08-24 (twice); pre-condense narrative is
gone — nothing below points at an archive.

## Facts that supersede anything found elsewhere

1. **Corpus is frozen eagle-DEV, not prod** (per-year `datePosted` counts, 2026-08-24). Newest
   document 2026-06-15; 12 documents from 2026 vs prod's 899. Prod eagle-search is not a valid
   oracle for raw totals until the corpora share a source.
2. **`demi-cosmos-test` backup: Periodic, 240-min interval, 8-hour retention.** `chunks`
   (1,128,733 rows, ~3.95 GB) is the only extracted copy; the index is a derived copy with an
   untested restore path; ~1,496 source PDFs 404 in the object store. **Destructive ops on
   `chunks` are one-way.**
3. **Direction (2026-08-23): DEMI is EPIC's central store.** Track project id is master; eagle-api
   pushes to DEMI, authenticated; nothing writes back to Eagle Mongo; Eagle-only project retained
   and flagged; Track-only project NOT public (fail closed).
4. **Sources and surfaces (2026-08-24, measured against deployed bundle + live API):**
   - eagle-public consumes ONE route: `GET /api/search`, datasets `Project`/`Document`/
     `DocumentChunk` (`eagle-public/src/app/services/api.ts:52,198`). Demo frontend consumes
     `/config`, `/boundaries*`, `/search`, `/search/summary`, `/documents/:id/download`.
     `GET /projects`, `/projects/:id`, `/documents`, `/documents/:id` have **no consumer**.
   - `sources.*` on a project row is the only place non-Eagle/Track data touches a served row;
     `publicView` (`src/repositories/projects.js:168`) allowlists it to `wildfire`. No other
     surface reads `sources.*`.
   - Wildfire is write-only: sync writes `activeCountWithin50km`/`nearestDistanceKm`/
     `firesOfNoteNearby`/`lastCalculatedAt` (`sync-wildfires.js:135-140`); the deployed bundle
     reads `count`/`activeNearby`. All 348 anonymous projects stamped `2026-08-11T05:18Z` (one
     manual run). `/map` shows "0 active fires / Clear" everywhere.
   - `logs`, `leases`: zero code references, deleted 2026-08-24. `wildfires`:
     write-only. Old `demi-*` indexes: nothing in code or config names them.
   - Document parents: 60,060 of 60,560 anonymous documents paged; 59,833 under the 348 listed
     track projects, **227 under 6 Eagle-only published projects** (`sourceSystem: 'eagle'`,
     `trackProjectId: null`) that answer point reads and document search but are hidden from the
     project list by `sourceSystem eq 'track'`. Retained per fact 3, not leftovers. 0
     ProjectNotification-parented documents found — re-check under `systemAccess` before deleting
     the `search.js:88-95` branch.
   - Nonsense term `zqxjvwplk9` → 0 on all datasets: index path live, no Cosmos fallback.
5. **`az` tokens expire without warning** (revoked 2026-08-24 `AADSTS50173`, restored by
   interactive login the same day). `az account show` still prints a subscription from the cached
   profile — test with a real call. `ENRICHMENT_SOURCES=wildfire` set on `demi-api-test`
   2026-08-24. The live search service is private-endpoint only: index PUTs run from the app
   container over the App Service SSH tunnel.

## Gate table

| Gate | Items |
|---|---|
| Nothing — next PR | 3.1 wildfire shape + dead-container Bicep; 3.2 `ENRICHMENT_SOURCES`; 3.6 nrpti sweep |
| Daniel decides | 2.1 re-seed source; 2.2 budget; 2.3 proponentId; 2.4 anonymous surface; 3.4 old-index delete |
| Needs SSH tunnel | 3.3 index widening; 3.4; 3.5 |
| Someone else / long-lead | 1.1, 1.2 rotations at source; 4.1 prod role assignments; 4.4/4.5 eao-nginx + eagle-public prod tags; `demi.eao.gov.bc.ca` DNS; Track feed credential |
| After the re-seed (2.1) | 3.3 analyzer + `isFeatured`/`documentSource`; a fully green differ; 3.7(d) reconcile |

---

## 1. Credentials — do first

- [ ] **1.1 Rotate the MinIO key and OpenShift token at source.** Repo secrets deleted 2026-08-07;
      credentials still live at `nrs.objectstore.gov.bc.ca` and the token issuer. Oldest open item.
- [ ] **1.2 Rotate `RPROXY_EGUIDE_PASSWORD` — low priority, do NOT delete the route** (people use
      `/eguide`, gate holds nothing confidential). Repo secret on `bcgov/eao-nginx`,
      `deploy-to-prod.yaml:138-139`.
- [ ] **1.3 Rotate `ADMIN_API_KEY`** (value passed through the 2026-08-13 incident and every
      `probe-acl.js` run since). Three targets, rotate all before restarting anything or the
      extractor 401s: `demi-app-secrets` (6cdc9e-test, writable now), App Service (blocked, fact 5),
      `gpu-extractor.env` on the GPU box (`192.168.5.109` not answering 2026-08-24). Then restart
      `gpu-extractor` and `gpu-ingest`.
- ACL probe exists and passes: `ADMIN_API_KEY=… node src/scripts/probe-acl.js`, ~7 min, 26/26 on
  2026-08-24. Exit 0 pass, 1 missed prediction, 2 aborted, 3 inconclusive leg (not a pass). Leaves
  one revoked key record per run by design. Re-run after any re-seed; the
  `close-unpublished-track-projects.js` recipe (dry run then `--live`, exits 1 by design, close the
  4 skips through `updateProject`) may be needed again then.

## 2. Decisions — Daniel

- [ ] **2.1 Re-seed source — biggest item, precondition for a green differ and for 3.7.**
      `EAGLE_API_BASE=https://projects.eao.gov.bc.ca/api/public node src/scripts/seed-nosql.js --live`
      upserts ~61,606 documents. Prod (complete anonymous source, carries `isFeatured` 337 and
      `documentSource`) or eagle-test (55,845, newest 2026-07-21)? Chunks do NOT come with it —
      new documents arrive `contentExtracted: false` until the extractor drains them. Verify the 34
      closed track projects survive (`resolveProjectAcl` fails closed — reasoning, not measured).
      8-hour undo window, untested restore.
- [ ] **2.2 Raise `budgetAmount`.** 400 CAD vs ~451 CAD/month measured (Aug 16-22 mean 15.03/day).
      RG also bills eagle-search, eagle-notify, PostgreSQL (~12/month).
- [ ] **2.3 `proponent` facet needs an org id DEMI lacks.** Wait for the Eagle push (3.7) to carry
      `proponentId` + label, or backfill ~393 rows now. Never the name-valued shortcut (497 of 778
      dropdown options match zero projects).
- [ ] **2.4 Sign off the anonymous surface before prod.** Nine anonymous GETs; `GET /projects` and
      `/documents` allow `pageSize` 1000 (bulk enumeration) and have no consumer (fact 4) — narrow,
      auth, or accept. Stop serving `/api-docs` in prod (unauthenticated, advertises an unenforced
      auth scheme). Required reviewers on the `prod` environment. App registration `acb4198f`
      still carries federated credential `github-eagle-demi-main` from a PUBLIC repo — dormant
      while it holds no role; settle before the prod build.
- [x] ~~**2.5 Delete `logs`, `leases`, `syncState` containers by hand.**~~ Done 2026-08-24:
      `logs` and `leases` deleted, `show` answers NotFound. `syncState` never existed in the live
      account — the Bicep comment claiming it did was stale. Bicep declarations went in PR #152.

## 3. Test hardening

- [ ] **3.1 Wildfire panel — repair to the real shape, keep on-demand.** Frontend-owned, one PR:
      `map-explorer.component.html:577-578` reads `activeCountWithin50km` and
      `firesOfNoteNearby > 0`, renders `lastCalculatedAt` ("as of …"), hides the panel when
      `sources.wildfire` is absent (prod rows); delete the `rawMetadata.wildfireData` fallback (no
      writer); `registry.models.ts:27` declares the API shape; fixtures in
      `test/controllers/nosql-controllers.test.js:84` and `test/controllers/search.test.js:39` use
      the written shape; `audit-cud-coverage.test.js:274` asserts the four written keys. Bundle:
      drop `logs`/`leases` from `cosmos-nosql.bicep`, fix the false "nightly sync" comment
      (`:383`). **No scheduler** (nothing ran it since 2026-08-11, nothing asked). Never bundle 3.4.
      - Contract for any future enrichment source lives in wiki `Sources-and-Status` — a script
        writing `sources.<name>`, on-demand admin route, consumer renders the stamp and handles
        absence, one test that write shape == read shape. No adapter layer. NRPTI stays gone.
- [ ] **3.2 Prod purity: `ENRICHMENT_SOURCES` app setting** feeding the `publicView` allowlist
      (`src/repositories/projects.js:168`). Test `wildfire`, prod empty. One line; makes 4.2's corpus
      copy safe (stale wildfire stats stripped at read). **Merge order:** CI deploys code only, app
      settings are a hand PUT — set `ENRICHMENT_SOURCES=wildfire` on `demi-api-test` BEFORE merging
      the PR, or the deploy hides the test panel. Blocked on fact 5 (`az login`).
- [ ] **3.3 Index widening — one tunnel session, app LAST.** `eagle-query.js` reads field metadata
      from the committed `azure/search/indexes/*.json` at require time, so naming a field there
      before the live index has it turns every filtered query into a 400 answered as 502. Order:
      index PUT → datasource PUT by hand (`demi-documents-ds` `container.query` is an explicit
      column list) → backfill → indexer reset + run → app. Contents:
      - `isFeatured` (exists nowhere: add to `seed/transform.js`, index, drop the note at
        `eagle-query.js:17`), `documentSource` (written by `transform.js:126`, missing from index),
        `proponentId` (2.3). Data only arrives via 2.1 — pair with it.
      - Filename analyzer: `keywords=mine` returns 0 on demi, 1,686 on prod; `documents.json:53`
        uses `en.microsoft`, eagle-search a PatternTokenizer. Recreate + refill — pair with 2.1.
      - `content: retrievable: false` on `chunks` — one PUT, no rebuild, but trades away semantic
        ranking (`content` is the sole `prioritizedContentFields` entry; measured +0.064 recall@1,
        +0.074 MRR on 78 labels) and highlighting. Choose; today only the explicit `select` in
        `searchChunks` keeps chunk text out of responses.
      - Rebuild rule (`azure/search/README.md`): add field / `retrievable` = no rebuild; rename,
        type, `searchable`/`filterable`/`sortable`/`facetable`, analyzer = drop-and-refill.
- [ ] **3.4 Delete the old `demi-*` indexes + indexers — Daniel decides, recommended DELETE in the
      3.3 session.** Not blocked on a prod soak (none has a date or criterion). The `chunks`
      container is the real safety net; the index is refillable. Rollback value already rotted once
      (`demi-projects` 12 vs 20 fields, would have 502'd anonymous project search). Keeping costs 6
      indexers on `PT5M` (double Cosmos RU), ~8.5 of Basic's 15 GB, and every 3.3 change applied
      twice by hand.
- [ ] **3.5 Denormalised `projectIsPublished` on documents** — lossless design, covers cascade
      partial failure; #139 removed the urgency. Traps: datasource SELECT first; `filterFor` third
      arg opt-in (missing OData field = 400); predicate and cascade-removal in the SAME release.
      Backfill first, or ship `(NOT IS_DEFINED(c.projectIsPublished) OR c.projectIsPublished = true)`.
- [ ] **3.6 Small, bundle opportunistically:**
      - Sweep 9 leftover `nrpti` mentions (comments/fixtures: `repositories/projects.js:145`,
        `test/seed/seed-nosql.test.js:32`, `test/helpers/access-coverage.test.js:44`,
        `test/helpers/registry-key-auth.test.js:47,64`, `test/controllers/nosql-controllers.test.js:83,103`,
        `test/routes/db_auth.test.js:66,73`). Keep removed-route assertions.
      - Trim 15-25 line comment blocks on the way past — `src/controllers/search.js` worst. A
        comment is the non-obvious why in a line or two; anything longer is a wiki page.
      - `basicPublishingCredentialsPolicies allow=false` is declared (#146) not applied — takes a
        hand `deploy-infra.sh test`. Read truth off `az resource show`, never the template.
      - Unused Cosmos index paths (wildfires spatial, projects composite, five scalars): verified
        removable, do it only if a Bicep deploy happens for another reason.
      - Grant `demi-cicd-test` what-if at RG scope (role `b9331d33-8a36-4f8c-b097-4f54124fdb44`),
        record the baseline-noise list.
- [ ] **3.7 Eagle → DEMI push (registry work), in order.** DEMI side DONE and unused:
      `PUT /api/projects/<trackProjectId>` under `authMiddleware` + `requireWrite`; DEMI mints the key
      (wiki `Track-Feed-Request`). Greenfield is eagle-api: 14 write entry points
      (`api/controllers/project.js` ×8, `api/controllers/document.js` ×6), no outbound HTTP pattern
      to copy (`axios` installed, imported nowhere). Three decisions first: (1) fire-and-forget +
      reconcile, or sync — a DEMI outage must never fail an Eagle write; (2) the 60,578 existing
      rows only converge after 2.1 — one plan; (3) `findOneAndDelete` leaves no tombstone, so the
      delete push is the only signal. Then (d) nightly reconcile + drift alarm modelled on
      `eagle-search/worker/full-sync.js:120-164`. Track feed: still needs the credential and Track's
      direction; namespace not probeable (wildcard router, all 503).

## 4. Prod promotion — ordered gates

Deploy source is a tag verified on test. Assumes §1-3 landed and soaked.

- [ ] **4.1 Stand up the prod estate.** `rg-demi-prod` holds 3 resources (search service + PE +
      NIC). Needed: plan, Function App, UAMI, VNet integration, PEs, DNS, observability, prod
      Cosmos; blob storage only if downloads sign there (`Storage Blob Delegator`). No
      `main.prod.bicepparam`; `deploy-infra.sh` refuses prod by name. **Blocked on role
      assignments** (c4b0a8 ABAC: no assignable role carries `roleAssignments/write`). Prod
      declares `projects`, `documents`, `chunks`, `config`, `apikeys` only; `ENRICHMENT_SOURCES`
      empty; no demo frontend, no `boundaries`, no `wildfires`. Set `rateLimitMaxRequests`.
- [ ] **4.2 Copy the corpus into prod Cosmos BEFORE demi-api answers a prod query.** Cosmos is in
      the chunk search path — missing prod Cosmos = every chunk result withheld (empty 200).
      Reconcile counts first (index 1,128,576 vs container 1,128,733), record source + date. Copy
      the five containers in 4.1 only. Preserve `src/scripts/export-chunks-to-eagle.js` — the only
      tool that repopulates chunks anywhere.
- [ ] **4.3 Index names vs rollback.** `eagle-search-api-prod` (answering `/eagle-search` today)
      reads `eagle-*` indexes from `demi-search-prod`. Hold both sets through the soak (verify
      Basic 15 GB headroom; ~4.1-4.3 GB per set) or repoint its three settings in the same change.
      `eagle-search-prod` the service is idle, 39 MB — not a rollback target.
- [ ] **4.4 One eao-nginx prod tag carrying the demi block AND `nginx.epic.proxy.demi`.** Prod
      v2.7.14 predates the block; chart-only deploy renders the localhost sentinel and
      `/demi-search/*` 502s. Human approval gate; stale-`waiting`-run concurrency trap.
- [ ] **4.5 eagle-public prod tag containing #803** (two null guards) to pod chart AND AFD bundle.
- [ ] **4.6 Prod observability.** `c4b0a8-prod` empty; OTel starts only with
      `APPLICATIONINSIGHTS_CONNECTION_STRING`. Add a webtest on a real search URL, or accept the gap
      explicitly. rproxy's kubelet probe cannot see a moved Front Door address (DNS resolved once at
      config load) — the webtest is the check for that too; never probe `/` (401 on test).
- [ ] **4.7 Cost sign-off** — plan + Cosmos + observability + PEs + temporary second index set
      against a budget already exceeded (2.2).
- [ ] **4.8 Flip and soak.** One Mongo `Config` field, `SEARCH_API_PATH`; `/eagle-search` kept
      answering in parallel; cutover and rollback are the same one-field update. Soak with the
      browser console open (`EventService.getError()` has zero subscribers — defects are an empty
      table + console line). Chunk search has no public UI route — exercise the endpoint directly.
      Result links 404 for documents the target Mongo lacks until corpora align.

## 5. Needs a human in a browser

- Summariser (staff Keycloak login, `/summary` on the AFD host).
- Scoped tier end to end: `project:<id>` role on a test user, confirm the filter narrows.
- Boundary rendering at the client's three modes (server serves two).
- Server-side highlighting (windowed fragments joined by ellipses).
- `/map` wildfire panel after 3.1 — non-zero counts, "as of" date.

## 6. Deferred, with the reason

- `pageNumber` citations: nothing cites; needs host + wire + API + re-extraction; ~1,496 PDFs 404.
- Intake-cleaner backfill: intake-only by design; ride the next re-extraction.
- OnPush conversion: change-detection rewrite; lint rule stays off.
- Client-side highlighter: backs map-explorer; deletable only with the Cosmos fallback.
- Natural-language retrieval labels: need a real query log — first month of public logs.
- Tiled stratum 9 labels / no OCR stratum: no more renders without PDFs that mostly 404.
- eagle-public content pager ~10x too many pages: eagle-public fix (honour `countsPassages`).
- Chunk paging ceilings: inherent to stateless window grouping, pinned by tests.
- Edge/WAF: prod edge is the OpenShift router; rproxy `limit_req` on `$binary_remote_addr` IS the
  per-IP control. Revisit when the edge moves. Never key on leftmost-XFF.
- `demi.eao.gov.bc.ca` DNS: filed, long-lead, nothing waits on it. Exit plan (absolute
  `SEARCH_API_PATH`, CORS, delete nginx block, revert rate ceiling) must be re-derived.
- `GET /projects` payload narrowing: 786 KB anonymous, no consumer — folds into 2.4.
- NRPTI: removed `952f5de` 2026-08-07. Stays gone; prod is Eagle + Track only.
- Scheduler for wildfire sync: only if a consumer needs freshness.

## 7. Standing rules — do not re-derive

- **A probe that cannot fail proves nothing.** Every corpus row is public; only synthetic rows
  discriminate ACL behaviour. Take a BEFORE reading; use nonsense terms to detect fallback.
- **The predicate trap**: a predicate chosen from one code path and tested only there. Enumerate
  every shape the field takes first. A test that mocks the call site asserts a shape production
  cannot produce.
- **Index-change deploy order** (3.3) is not negotiable. App first = 400s served as 502s.
- **OData has no `false` literal** — null/empty filter is UNRESTRICTED; every search route honours
  the `empty` flag.
- **`_ts` advances on ANY write; indexers see no deletes** — datasource SELECT first;
  `deleteFromIndex`/`deleteChunksForDocument` are the app's job forever.
- **appSettings is a whole-collection PUT.** `demi-app-secrets` (OpenShift) is the source of truth
  for every deployed credential; never round-trip secrets out of the live app; never add `''`
  defaults to bicepparam.
- **App Service**: `restart` does not recycle the worker (stop/start, poll a discriminator); ~50 s
  cold start; chunked bodies dropped; 240 s timeout; verify deploys by Kudu VFS content, never
  mtime; zipdeploy async, status 3=FAILED 4=SUCCESS.
- **`/db/stats` counts three containers, not `chunks`**; discriminate by payload
  (`driver: azure-cosmos-nosql` / `database: demi`).
- **Temporary search-service grants**: Search Service Contributor at service scope, revoke at
  once, verify back to exactly Search Index Data Contributor. ABAC denies write AND delete only for
  the same six role GUIDs.
- **Where demi is deliberately STRICTER than eagle-search — do not "fix" toward eagle**: unknown
  params 400; `pageSize>500` refused; `read[]` withheld; keywordless chunk search returns 0; chunk
  paging loses 0 documents.
- **Decided, do not redo**: 4 `js/path-injection` alerts (multer's own paths); helmet CSP off;
  rate limiter proven (draft-7 monotonic decrement); facets computed over the filtered set, not the
  vocabulary; filter values stay List ObjectIds; chunk rows always grouped by document; eagle-public
  milestone/type/date chunk controls dropped (PR 805) rather than paging the resolver or
  denormalising onto 1.13M chunks.
- **Cost shape**: AI Search 41 %, Defender 28 % of RG spend — standing charges. Summariser
  ~0.0023 CAD/query; watch logged p95.

## Closed 2026-08-24 (one line each, so nobody re-opens them)

ACL data fix (34 projects + 18 documents, cascade verified) · scoped service keys + `probe-acl.js`
(#150) · eagle-public chunk controls + `pcp` facet dropped (PR 805) · semantic 402 latch resets at
month rollover (#145) · `projectState` single writer, 0 rows to migrate (#144, `v0.10.3`) · Track
feed ASK written (wiki `Track-Feed-Request`) · `sourceSystem: 'eagle'` flag + `unlinkedProjects`
count (#138) · `basicPublishingCredentialsPolicies` declared (#146) · `PREVIEW_GATE_PASSPHRASE` and
two preview branches deleted (tips `7187eac`, `0e98f13`) · `GET /api/boundaries` truncation header
(#147) · every Document list routed to the index, Cosmos list branch deleted (#148) · ACL writes
merged into the index on publish transitions, project cascade included (#149) · swagger + rebuild
rule (#151) · eao-nginx test deploy pinned to `inputs.version` (PR 43) · eagle-search sync liveness
probe already off in cluster · rproxy probe on `/` STRUCK (401 on test would CrashLoop) ·
`deploy-infra.sh` prod-branch hazard misstated (script refuses prod; real gap is an operator
exporting a wrong key at `main.searchprod.bicepparam:151`).

## Out of scope

`rg-epic-search` shares the billing group, not the ownership. The eagle-search fold is the one
deliberate reach into `eagle-search`, `eagle-public`, `eao-nginx` and `6cdc9e-test`/`-prod`; it
ends when eagle-search is archived.
