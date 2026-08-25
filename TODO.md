# TODO

**Goal: prod — eagle-public on Azure, served by demi-api, prod data Eagle + Track only — and
eagle-search + eagle-public OpenShift dev/test decommissioned (§5; prod kept as switch-back).** Every
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

1. **Corpus is PROD eagle-api as of 2026-08-25 19:14 UTC** (re-seed, §2.1): 392 projects /
   61,587 documents in Cosmos, index 61,587. ~~frozen eagle-DEV~~ — superseded. Prod eagle-search
   is now a valid oracle: `search-diff.js` 68 PASS / 3 DIFF, the 3 being the documented
   chunk-metadata-filter difference (controls dropped in eagle-public, 2.2). New prod documents
   (1,059) arrive `contentExtracted:false` for the GPU box (`192.168.5.99`).
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
| Nothing — do it | 2.1 re-seed phases 0-2 (decided, in progress); 3.6 small items; 5.6 disable the two eagle-public test workflows |
| Daniel decides | 2.2 budget; 2.3 proponentId; 2.4 anonymous surface; 5.6 retire dev whole or keep pod, and when the eagle-public AFD rollback pod can go; 5.7 `eagle-search-prod` search service delete (~100 CAD/mo, condition already met) |
| Needs SSH tunnel | nothing open |
| Someone else / long-lead | 1.1, 1.2 rotations at source; 4.1 prod role assignments; 4.4/4.5 eao-nginx + eagle-public prod tags; `demi.eao.gov.bc.ca` DNS; Track feed credential |
| Unblocked by 2.1 | — |

---

## 1. Credentials — do first

- [ ] **1.1 Rotate the MinIO key and OpenShift token at source.** Repo secrets deleted 2026-08-07;
      credentials still live at `nrs.objectstore.gov.bc.ca` and the token issuer. Oldest open item.
- [ ] **1.2 Rotate `RPROXY_EGUIDE_PASSWORD` — low priority, do NOT delete the route** (people use
      `/eguide`, gate holds nothing confidential). Repo secret on `bcgov/eao-nginx`,
      `deploy-to-prod.yaml:138-139`.
- [x] ~~**1.3 Rotate `ADMIN_API_KEY`.**~~ Done 2026-08-25: OpenShift `demi-app-secrets` (source of
      truth — nothing mounts it, only `deploy-infra.sh` reads it, so skipping it would revert the
      key on the next infra deploy) → GPU box `/root/gpu-extractor/gpu-extractor.env`
      (`DEMI_ADMIN_KEY`; also `DEMI_API` repointed from the dead `demi-api-dev` host to test) → App
      Service. App Service needed stop/start before the new key answered 200 (warm worker). Auth
      accepts one key only, so a window is structural; the only client (`gpu-ingest`) was idle.
- ACL probe exists and passes: `ADMIN_API_KEY=… node src/scripts/probe-acl.js`, ~7 min, 26/26 on
  2026-08-24. Exit 0 pass, 1 missed prediction, 2 aborted, 3 inconclusive leg (not a pass). Leaves
  one revoked key record per run by design. Re-run after any re-seed; the
  `close-unpublished-track-projects.js` recipe (dry run then `--live`, exits 1 by design, close the
  4 skips through `updateProject`) may be needed again then.

## 2. Decisions — Daniel

- [x] ~~**2.1 Re-seed from PROD eagle-api.**~~ **DONE 2026-08-25.** Record kept below. Source = prod
      (358 projects / 61,611 documents anonymous, `isFeatured` 337, `documentSource`); eagle-dev-only
      leftovers DELETED with chunks + index rows. Plan `/root/.claude/plans/curried-chasing-eich.md`.
      - **Cannot run as-is, measured 2026-08-25:** `seed/transform.js:139-145` resets
        `contentExtracted` on every row and Cosmos upsert replaces (`db/cosmos-nosql.js:230`) — a raw
        run sends ~60k extracted docs back through the GPU (~200 GB, 1,496 PDFs 404). No delete
        pass exists, so dev-only rows would linger in Cosmos and the index. Chunks untouched by the
        seed. `sources.wildfire` wiped (re-run the manual sync after). Document id = Eagle `_id`
        verbatim, so idempotent only if dev ids match prod ids — pre-flight measures it.
      - [x] Phase 0 pre-flight, 2026-08-25, **GO**: demi ∩ prod 60,552; demi − prod 8 (each
        re-checked absent from prod by `dataset=Item`); prod − demi 1,059 (2026: 895) = extractor
        backlog; 50-id sample 50/50 on `displayName` + `datePosted`. Prod `isFeatured` 331;
        `documentSource` PROJECT 60,589 / COMMENT 956 / PROJECT-NOTIFICATION 63 / DROPZONE 3. 4 new
        Eagle-only projects (Dawson Creek Water Supply, Lawyers-Ranch, Baptiste Nickel, m.ah a
        temEEwuh Solar) will arrive as `eagle-<id>` rows. Id files kept in the session scratchpad
        `preflight/`. Public-visible deltas only.
      - [x] Phase 1 #153 merged 2026-08-25, reviewer PASS after three rounds (two MAJORs each
        about the reconcile deleting on a consistent-but-wrong fetch): extraction fields preserved
        per partition; `--reconcile` deletes via the shared `helpers/purge.js`, refused unless
        Project + Document + ProjectNotification totals all verify, `droppedUnresolvable` = 0, and
        surplus ≤ max(50, 2%) (`--max-surplus <n>` overrides); every surplus id to
        `/home/reconcile-<ts>.ndjson`; live deletes audited. `isFeatured` in Cosmos only.
      - Dry runs 2026-08-25 (build `cc5523e`, `d229388`): `preserved 60,570`, `built 61,587`,
        `droppedUnresolvable 24` (6 unpublished prod projects, none of the 24 in Cosmos — gate
        relaxed in #155). Snapshot `/home/backup-pre-reseed.ndjson` (393 + 60,578 rows, md5
        `be517963…`, local copy in the session scratchpad). **Dry run 2 lied:** `listSeededIds`
        returned 1,000 of 60,578 (cross-partition + ORDER BY drops the continuation token — the
        same SDK trap as the old boundaries/documents lists), so surplus read 0 not 8; fixing with
        a COUNT guard before any live run. Projects surplus is 3, not 0: eagle-dev test junk
        `eagle-69d68d…` "test", `eagle-69fcde…` "ABC test project", `eagle-6a5923…`
        "testtesttest" — delete is correct.
      - [x] Phase 2 LIVE 2026-08-25 19:06-19:14 UTC (build `4436410`): written 392 projects /
        61,587 documents / 281 boundaries, `writeFailed 0`, `preserved 60,570`, deleted 8 documents
        + 3 projects (log `/home/reconcile-2026-08-25T19:06:39.222Z.ndjson`). After: `/db/stats`
        392/61,587; `close-unpublished-track-projects.js` dry run `matched 0`; wildfire sync 391
        projects; `probe-acl.js` 26/26; chunks intact (caribou 27,932). **Trap hit:** the README
        tunnel recipe exports only `COSMOS_*` + identity vars, so `SEARCH_ENDPOINT` was unset and
        every purge's index delete was a silent no-op (11 rows lingered in the index; replayed by
        hand with `SEARCH_*` exported, +157 chunk entries). Fix the recipe: export `SEARCH_*` too,
        and make `--reconcile --live` refuse when ai-search is unconfigured.
      - Was: Phase 2 run over the tunnel: `alwaysOn` on; dry run `--reconcile` must match Phase 0;
        `--live --reconcile` under nohup; then counts (Project ≈ 358−closed, Document ≈ 61.6k, not
        61k+60k), `/admin/index-progress`, `close-unpublished-track-projects.js` dry run `matched 0`,
        `POST /admin/sync/wildfires`, `search-diff.js` green, `probe-acl.js` 26/26,
        `GET /documents?extracted=false` = |prod − demi| for the GPU box; `alwaysOn` off.
      - Rollback = re-run the seed against eagle-dev (`projects`/`documents` regenerable); the 8-hour
        Cosmos restore is a support ticket, untested.
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

- [x] ~~**3.1 Wildfire panel — repair to the real shape, keep on-demand.**~~ #152, merged
      2026-08-24 (`a3e30cf`), reviewer PASS. Kept for the contract note below. Frontend-owned, one PR:
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
- [x] ~~**3.2 Prod purity: `ENRICHMENT_SOURCES` app setting**~~ #152; setting live on
      `demi-api-test` 2026-08-24, wildfire still served through it. Prod: leave unset. feeding the `publicView` allowlist
      (`src/repositories/projects.js:168`). Test `wildfire`, prod empty. One line; makes 4.2's corpus
      copy safe (stale wildfire stats stripped at read). **Merge order:** CI deploys code only, app
      settings are a hand PUT — set `ENRICHMENT_SOURCES=wildfire` on `demi-api-test` BEFORE merging
      the PR, or the deploy hides the test panel. Blocked on fact 5 (`az login`).
- [x] ~~**3.3 Index widening.**~~ DONE 2026-08-25 (#158 `d27718d`). AFTER: `mine` 1,686 (= prod),
      `and[isFeatured]=true` 330 (prod 331), `documentSource=COMMENT` 954 (prod 956), sort honoured.
      Additive only after design review: `isFeatured` (sortable — eagle-public sorts its ★ column),
      `documentSource`, and `fileNameTokens` (new field with eagle-search's PatternTokenizer
      `filename` analyzer) instead of re-analyzing `documentFileName`, which is a rebuild; chunk
      sortability and `content: retrievable:false` (§3.9) rejected — no consumer, and retrievable
      trades away measured semantic gains. Live: PUT index (`allowIndexDowntime=true` needed for
      the analyzer; `stored:false` rejected on 2024-07-01), PUT `demi-documents-ds`, indexer reset →
      61,587 / 0 failed, grant revoked. BEFORE: `mine` 0, `and[isFeatured]=true` 61,587 dropped.
      After #158 deploys expect `isFeatured` ≈ 331, `documentSource=COMMENT` ≈ 956, `mine` ≫ 0.
      `proponentId` waits for 3.7 (empty filterable field = silent zero-row 200).
- [x] ~~**3.4 Delete the old `demi-*` indexes + indexers.**~~ Done 2026-08-24 over the tunnel:
      grant Search Service Contributor at service scope, `DELETE` 3 indexers then 3 indexes, revoke,
      verify identity back to exactly Search Index Data Contributor. `demi-*-ds` data sources kept.
      Live search re-probed: 3 datasets answer. Rollback is now refill-from-Cosmos
      (`azure/search/README.md`). Two traps: the App Service redeploy on merge kills the SSH tunnel
      mid-run, and `pkill -f ssh` on this box kills the caller's own shell.
- [x] ~~**3.5 Denormalised `projectIsPublished`**~~ — STRUCK 2026-08-25; replacement shipped in #159
      (`f7e9884`, reviewer PASS): seed invariant + `constrainToProject` at transform, 409 on null
      parent, partial cascade writes what landed. Record: Design review: the flag would ride the same bulk PATCH that fails mid-cascade
      (`repositories/documents.js:262-290`), so "covers partial failure" was false; every other
      sequence is closed (#139, #149, `PUT /documents/:id/published` 409). The one real gap: the
      seed preserves Eagle `read[]` per document with no cross-entity check, so a public document
      under a non-public project seeds silently (it did — the 2026-08-24 "34 projects + 18
      documents" fix). Do instead: pre-write invariant in `seed-nosql.js` `verifyItems` (public doc
      whose project is not public → failure, dry run catches it), fix = `constrainToProject` at
      `transform.js:~104`; plus two one-liners — `document.js:~378` drop `&& parentProject` (null
      parent must 409, not publish), `project.js:~235` write the succeeded cascade rows' ACLs before
      returning 500. Correct wiki `Sync-Architecture.md:90-103` (still says both cascade defects open).
- [ ] **3.6 Small, bundle opportunistically:**
      - [x] ~~Trim 15-25 line comment blocks — `src/controllers/search.js` worst.~~ #154 (`ebdd3a0`):
        search.js 775→282 comment lines, eagle-query.js 372→205, code byte-identical; narrative in
        wiki `Search-and-Retrieval#Search-controller-decisions`. Reviewer BLOCKED on a harness bug
        (diff too large for argv) — verified by comment-stripped hash instead.
      - [x] ~~`basicPublishingCredentialsPolicies allow=false` declared, not applied.~~ Applied
        2026-08-25 by `az resource update` on `scm` + `ftp` (both `false` live), not a full Bicep
        deploy: `deploy-infra.sh test --what-if` showed 27 modifies, only this one functional, plus
        two unprovable re-PUT risks (shared private link status, `wildfires` spatial index types).
        Output in the session scratchpad `whatif.txt`. `create-remote-connection` still works (AAD).
      - Unused Cosmos index paths (wildfires spatial, projects composite, five scalars): verified
        removable, do it only if a Bicep deploy happens for another reason.
      - #161 review minors (flatten): see report `eagle-demi-724a97b7.md` — three small ones on
        `merge/project.js:83-86` and the swagger 400 wording.
      - #158 review minors: the two new Document response fields (`search.js:~488`) have no test;
        `ai-search.test.js:~461` lost its pin on leg-one `searchFields`; datasource-columns test
        should assert the `filename` analyzer is defined, not just referenced.
      - ~~Seed leftovers~~ #157 (`71d59b4`). One minor left: the production default
        `searchReady = aiSearch.config().configured` (`seed-nosql.js:~284`) has no test — every
        test injects `deps.searchReady`.
      - `_sql.fetchAll` still passes `maxItemCount`, so any future cross-partition + ORDER BY caller
        silently truncates at 1,000 (SDK `LegacyFetchImplementation` drops `x-ms-continuation`);
        only the reconcile sites carry a COUNT guard. Decide: drop `maxItemCount` in `fetchAll`
        (SDK's own `fetchAll()` is immune) vs keep the unbounded-read protection.
      - ~~Grant `demi-cicd-test` what-if at RG scope (role `b9331d33-…`).~~ **GUID was wrong** —
        `b9331d33-8a36-4f8c-b097-4f54124fdb44` is Managed Application Publisher Operator (granted
        and reverted 2026-08-25). No general built-in role carries `deployments/whatIf/action`; it
        needs a custom role, which c4b0a8 ABAC leaves to a human. Park; baseline-noise list is in
        the session `whatif.txt` (27 modifies, all ARM noise except the two flagged re-PUT risks).
- [ ] **3.7 Eagle → DEMI push — (c) DONE 2026-08-25, (d) reconcile open.** Decisions: fire-and-forget
      from eagle-api after its own write (never fails the Eagle write), nightly reconcile (d) is the
      backstop, deletes NOT pushed (reconcile catches them; project delete is a soft delete anyway),
      history converges via the seed. Design (Opus, verified): eagle-api has no shared save funnel
      (`Utils.recordAction` never sees the doc, 113 call sites), so one helper
      `api/helpers/demiPush.js` (global `fetch`, not the unused `axios`; 10 s timeout, 2 attempts,
      no retry on 4xx, never throws) + **14** unawaited call sites — 7 project (`protectedPost/Put/
      Publish/UnPublish`, three `protectedExtension*` which need a re-read after `updateOne`), 7
      document (incl. `feature/unfeatureDocument`, missed by the old count of 14 that included the
      two deletes). Body = raw Eagle doc (+ `List` labels for documents), so DEMI's `merge/project.js`
      + `seed/transform.js` stay the only mapper. DEMI grows `PUT /api/eagle/projects/:eagleId` and
      `PUT /api/eagle/documents/:eagleId` (authMiddleware + requireWrite): resolve by `eagleId`
      (`projects.getByEagleId` exists), merge/transform with `existing` (else extraction resets and
      `sources.wildfire` is wiped — same traps as the seed), `constrainToProject`, cascade extracted
      from `updateProject` (never copied), `writeAcls` only on an `isPublished` transition, missing
      parent → 404. Key: `POST /admin/api-keys {roles:['demi-admin'], allowWrite:true}` — no
      `demi-service-write` role exists; interim, 90-day expiry, Keycloak client before prod.
      - [x] (c1) eagle-api #851 merged 2026-08-25 (`aa307ff`, 663/663, reviewer PASS after two
        rounds — List lookup scoped to `_schemaName: 'List'`, dark unless both env vars set, every
        call site tested; also fixes the pre-existing `projId.value` guard that 400ed every
        `protectedExtensionAdd/Delete`). Review minors left: parameterise the secret name in the
        chart, test the `doc && doc._id` guard. — helper + 14
        sites + tests + Helm (`DEMI_API_BASE` in `values-test.yaml`, `DEMI_API_KEY` from secret
        `demi-push-secret`, optional). In review; dark until the test deploy is dispatched.
      - [x] (c2) DEMI #160 merged 2026-08-25 (reviewer PASS; minors fixed: `ownRead` kept on push,
        old-partition row deleted on a project move). Two routes, cascade extracted to
        `cascadeProjectVisibility`, swagger, wiki `Connecting-an-Application-to-DEMI` section.
      - [x] (c3) DONE 2026-08-25. Key minted (registry id `b319b93a1bf35206`, `demi-admin`, write,
        90-day expiry — diarise) into OpenShift secret `demi-push-secret` in `6cdc9e-test`;
        eagle-api `v2.10.67` on test (`v2.10.66` burned by the ci-latest race, see memory). Proof:
        `PUT /api/project/6a5920eaf0b65c54e12eb20a` (eagle-test "Test Test Test", via the
        `SMOKE_API_KEY` internal-service path) → DEMI row `eagle-6a5920…` `updatedAt` 21:21:03 →
        21:31:50 with the pushed description, no `[demiPush]` log lines; reverted the same way.
        Discriminators: no key → 401, push key + mismatched id → 400. **Defect surfaced:** the
        pushed row lost `name`/`description` — eagle-api's Mongo project nests content under
        `legislation_<year>` (+ `currentLegislationYear`) and only the public search flattens it,
        so the raw-doc push needs flattening in DEMI's handler (fix PR `fix/eagle-push-flatten`).
        Fixed in #161 (`3cfd408`, reviewer PASS after one MAJOR round); re-push verified 23:45 UTC —
        row carries `name`, `description`, `region`, `sourceSystem: 'eagle'`.
      - [ ] (d) nightly reconcile + drift alarm modelled on `eagle-search/worker/full-sync.js:120-164`
        (archived repo, readable locally) — the only thing that catches a hard-deleted document.
      - Egress verified 2026-08-25: `deploy/eagle-api` in `6cdc9e-test` reaches
        `demi-api-test.azurewebsites.net/api/config` (200).

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

## 5. Archive `digitalspace/eagle-search`; retire eagle-public OpenShift dev/test

Goal added 2026-08-24, reframed 2026-08-25: eagle-search is an **Azure** app (`eagle-search-api-*`
App Service + `eagle-search-*` AI Search) with only its sync worker in OpenShift. Target: archive the
repo. An archived repo is read-only but hand-deployable, so **prod stays frozen on it**: prod
search is SERVED by eagle-search today (`SEARCH_API_PATH=/eagle-search`, `eagle-search-api-prod` →
`eagle-*` indexes on `demi-search-prod`, worker in `6cdc9e-prod`) and becomes the switch-back once
§4.8 flips prod to demi-api. Archive condition = nothing outside the repo needs it to change again. Record: eagle-dev-guides wiki `Eagle-Search-Archive`.

Measured 2026-08-24: test `SEARCH_API_PATH=/demi-search`, rproxy `ROOT` = AFD
`eagle-public-test-dbg8ghh8gjd0bscx.a02.azurefd.net`; `eagle-search-api-test` serves zero traffic,
fed only by `deploy/eagle-search-sync` + `CronJob/eagle-search-reindex`; `eagle-extractor-test`
(Function, `INGEST_URL` = eagle-search-api-test, queues empty) is search-only. Dev has no
eagle-search at all and still serves its site from the OpenShift `eagle-public` pod.

- [x] ~~**5.1 New repo `digitalspace/eagle-edge` owns the shared edge**~~ Done 2026-08-25 (`6fd2a19`, what-if zero drift). Kept for the record: (decided 2026-08-25: one Front
      Door profile per env, no second base fee; eagle-admin and later frontends join as `sites[]`
      entries; eao-nginx retires too so cannot be the home). Moves from `eagle-search/azure/`:
      `modules/front-door.bicep` (profile `eagle-edge-test`, endpoints `eagle-public-test`,
      `demi-frontend-test`, rule sets), `static-site.bicep` (`eaglepubtestvymaysch2agd` `$web`),
      `identity.bicep` (UAMI `eagle-search-identity-test`, misnamed, keep), `observability.bicep`,
      `scripts/deploy-infra.sh`. Gate: `what-if` from eagle-edge against `c4b0a8-test-rg` shows zero
      changes before the eagle-search copy is deleted. Later: `eagle-edge-prod` + UAMI
      `eagle-search-identity-prod` (referenced by `eagle-demi/azure/ai-search.prod.bicepparam:29`)
      move in from `bcgov/eagle-public`.
- [x] ~~**5.2 Docs out of the repo.**~~ Done 2026-08-25 (wiki `09654c6`, `94d1f16`). Wiki `Eagle-Search-Archive` (eagle-dev-guides): rollback recipe,
      index schema decisions, propagation lags, INGEST_KEY whole-collection-PUT hazard, 2026-08-20
      cutover record. Fix `Search-Cutover.md` citations of `check-acl.js`/`check-frontend.py`/
      `deploy-infra.sh` (DEMI's `probe-acl.js` is the gate now) and the dead
      `docs/azure-test-migration.md` link in `eagle-demi.wiki/Azure-Environments.md:30`.
- [x] ~~**5.3 Last eagle-search PR**~~ #25 merged 2026-08-25 (`4597aa6`), reviewer minors fixed; also fails the bicep gate on `Warning BCP`.: delete the moved modules + `deploy-staging-api.yaml` +
      `deploy-staging-worker.yaml`, README pointer to the wiki page and eagle-edge. Drop local
      branch `fix/disable-sync-liveness-probe-in-test` (cluster already has the probe off).
- [x] ~~**5.4 Retire the test estate.**~~ Done 2026-08-25. OpenShift: helm uninstall, BC/IS/secret/CMs, dev secret — 0 `eagle-search` objects remain. eao-nginx #44 (`3064b3a`, sentinel, lands on next test deploy). Azure: `eagle-search-api-test`, `eagle-search-test` + PE, `eagle-extractor-test` + plan, `eaglextrtestvymaysch2agd` + EventGrid topic, UAMI `eagle-search-cicd-test` deleted; kept `eagle-search-identity-test`, `-logs-test`, `-insights-test` (eagle-edge owns them). After: eagle-public AFD 200, DEMI `/map` 200, demi-api search 3 hits. Was: OpenShift `6cdc9e-test`: `helm uninstall eagle-search`,
      `BuildConfig/eagle-search`, `ImageStream/eagle-search`, `secret/eagle-search-ingest`, the 9
      `eagle-search-{7,8,9}-*` ConfigMaps + build pods; dev `secret/eagle-search-extract-queue`.
      Azure: `eagle-search-api-test`, `eagle-search-test` + `pe-eagle-search-test`,
      `eagle-extractor-test` + `eagle-extractor-plan-test` + `eaglextrtestvymaysch2agd`. eao-nginx
      `values-test.yaml:32` `search:` → `localhost:9999` sentinel (prod upstream and the
      `server.conf.tmpl` block stay). Verify after: `/demi-search/search` 200 via eagle-test,
      DEMI `/map` and eagle-public AFD host 200.
- [x] ~~**5.5 Archive the repo**~~ Archived 2026-08-25 (`gh repo archive`, isArchived true). Remote branch `fix/disable-sync-liveness-probe-in-test` left behind, harmless. Prod worker keeps running from `6cdc9e-tools/eagle-search:prod`; rollback needs no
      redeploy.
- [ ] **5.6 eagle-public OpenShift dev/test — git side DONE 2026-08-25, cluster side WAITS.**
      Daniel 2026-08-25: nothing more deleted in OpenShift until he says so (flat-rate, only
      rollback options lost). Azure workflows are on `develop` (#804 admin-merged; dispatch-only,
      `deploy-to-test.yaml` stays as the tag/release factory it needs); preview workflows retired
      (#806). Test: ~~delete the three preview releases~~
      `-feat-typesense-angular21`, `-hotfix-pcp-engage` and stale `Service/epic-public` deleted
      2026-08-25; `eagle-public-feat-azure-hosting-mainline` (2 days old, the Azure branch) kept —
      Daniel decides. The main `eagle-public` (Helm rev 70,
      the AFD rollback target) and `NGINX__EPIC__PROXY__PUBLIC` go when the rollback can go — Daniel
      decides. Keep `Route/eagle-public` (Keycloak host). Disable `deploy-to-test.yaml` +
      `preview-branch-in-test.yaml`. Dev: site IS the pod — retire dev whole (with the orphan
      `eagle-{admin,api,public}-dev` trio, 37d, ArgoCD ids with no Application) or repoint rproxy
      `ROOT` at the test AFD host — Daniel decides. eagle-public's Azure workflows live only on
      `feat/azure-hosting-mainline`, not `develop` — land them first.
- [ ] **5.7 Prod, later**: `eagle-search-prod` search service (idle, 39 MB, ~100 CAD/mo — its own
      note says delete after two weeks of non-empty prod `SEARCH_API_PATH`, already met),
      `eagle-search-api-prod`, `eagle-*` indexes on `demi-search-prod`, prod worker, once §4.8's
      soak is signed off. eagle-public prod pods (3 replicas) stay as the AFD rollback until then.

## 6. Needs a human in a browser

- Summariser (staff Keycloak login, `/summary` on the AFD host).
- Scoped tier end to end: `project:<id>` role on a test user, confirm the filter narrows.
- Boundary rendering at the client's three modes (server serves two).
- Server-side highlighting (windowed fragments joined by ellipses).
- `/map` wildfire panel after 3.1 — non-zero counts, "as of" date.

## 7. Deferred, with the reason

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

## 8. Standing rules — do not re-derive

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
