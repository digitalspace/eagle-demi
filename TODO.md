# TODO

**Goal: prod — eagle-public on Azure, served by demi-api, prod data Eagle + Track only.**
Test is done and verified (2026-08-25). Everything below is open work toward prod, or parked with
a reason. Unscheduled ideas: `docs/FUTURE.md`. History: `git log`, wiki. **Merging is deploying**
on test — `main` is live on staging within minutes and test search is user-facing.

Rules: append newly found work here before doing it; strike a wrong line with a one-line reason;
pin every claim to a measurement with a date; reviewer takes a positional sha
(`review.sh --repo eagle-demi <sha>`); prod deploys only from a tag verified on test.

## Facts — verified 2026-08-26 unless dated otherwise

1. **Test corpus = prod eagle-api** (re-seed 2026-08-25): 393 projects / 61,587 documents /
   1,128,576 chunks, index 61,587, anonymous Project 348 — counts measured 2026-08-26 by the
   `copy-to-env.js` count probe (§4.2), which supersedes the 392 / 1,128,733 read taken at re-seed.
   `search-diff.js` 68 PASS / 3 DIFF (the 3 = chunk metadata filters, controls dropped in
   eagle-public). `chunks` is the only extracted copy; backup Periodic 240-min / 8-hour retention,
   restore untested; ~1,496 source PDFs 404.
2. **Prod is a separate subscription**: `c4b0a8-prod - EPIC.AI` = `be5924ac-1083-4a1b-be92-7b444882cfd9`
   (test = `7897ceb1-…`). RGs: `rg-demi-prod` holds the whole DEMI backend — 20 resources measured
   2026-08-26 (`group_resource_list`): `demi-cosmos-prod` + `pe-cosmos-nosql-prod`, `demi-api-prod`
   (B3 on `plan-eagle-search-prod`, shared with `eagle-search-api-prod`), `demi-search-prod` Basic
   1 partition + `pe-demi-search-prod`, `demi-identity-prod`, storage `demistgproduvtikwlcqtpga`
   + its Event Grid system topic, `demi-logs-prod`, `demi-insights-prod`, `demi-audit-prod` +
   `demi-audit-dcr-prod`, `demi-alerts-prod`, 2 scheduled query rules, the Failure Anomalies rule,
   webtest + metric alert `demi-search-availability-prod`, 2 private-endpoint NICs;
   `rg-eagle-search-prod` (`eagle-search-api-prod`, `eagle-search-prod`,
   plan, PE, LAW, App Insights; worker in `6cdc9e-prod`), `rg-eagle-public-prod` (AFD
   `eagle-edge-prod` endpoint `eagle-public-prod-aafug4ahavgzbvh9.a01.azurefd.net`, storage
   `eaglepubprodrhj3zycszo6j`, UAMI `eagle-public-cicd-prod`, LAW, App Insights, live webtest
   `eagle-public-availability-prod` on `projects.eao.gov.bc.ca/`), `rg-condition-extractor-prod`.
3. **Prod search today**: `SEARCH_API_PATH=/eagle-search` in prod Mongo `Config`; `/eagle-search/search`
   200; `eagle-search-api-prod` reads `eagle-projects`/`eagle-documents`/`eagle-chunks` on
   `demi-search-prod` (three app settings). Rollback and roll-forward are that one Mongo field.
4. **Direction (2026-08-23)**: DEMI is EPIC's central store; Track id is master; eagle-api pushes
   to DEMI (live in test since 2026-08-25, `PUT /api/eagle/{projects,documents}/:eagleId`);
   Eagle-only projects retained as `eagle-<id>`; Track-only not public.
5. **ABAC (`c4b0a8`)** denies `roleAssignments/write` and `/delete` only for six role GUIDs (Owner,
   Contributor, UAA, RBAC Admin, two custom). The template's eight assignments (Blob
   Contributor/Delegator, Search Index Data Contributor, Cosmos data, Foundry, DCR) are grantable
   by any principal holding `roleAssignments/write`. Search Service Contributor grant/revoke proven.
6. **Access**: `az` works after interactive login (tokens revoke without warning — test with a real
   call). `oc` prod reads via the `github-cicd` SA context; never write through it. Search data
   planes are private-endpoint only — index PUTs run in the app container over the SSH tunnel
   (`scripts/with-search-admin.sh`; export `COSMOS_*`, identity vars AND `SEARCH_*`).
7. **Spend**: `demi-budget-test` 400 CAD/month, current 205.15 CAD on day 26 (~7.9 CAD/day,
   ~237 projected); eagle-search test estate deleted 2026-08-25 so it falls further. Sub tripwire
   2,000 CAD, spend 1,278.

## Gate table

| Gate | Items |
|---|---|
| Daniel decides | 2.1 anonymous surface; 2.2 proponentId; 2.3 Keycloak prod client; 2.4 eagle-edge prod home; 2.5 CORS; 5.1 eagle-public OpenShift dev/test; 5.2 dev DEMI stack |
| Needs a prod-capable principal (role assignments, GitHub env) | 4.1, 4.6 |
| Needs the SSH tunnel | 4.2 count reconcile; 4.3 storage headroom |
| Someone else / long-lead | 1.1, 1.2 rotations at source; `demi.eao.gov.bc.ca` DNS |
| Nothing — do it | §3 |

## 1. Credentials

- [ ] **1.1 Rotate the MinIO key and OpenShift token at source.** `eagle-api-minio-keys` in
      `6cdc9e-test` created 2021-02-25, never rotated; repo secrets already deleted. Needs the
      owners of `nrs.objectstore.gov.bc.ca` and the token issuer.
- [x] ~~**1.2 Rotate `RPROXY_EGUIDE_PASSWORD`**~~ Decided 2026-08-26 (Daniel): not rotated — it is the
      front-facing basic-auth password on `/eguide`, issued to users; changing it is a business
      re-issue, not hygiene. `TYPESENSE_SEARCH_KEY` deleted 2026-08-26.
- [ ] **1.3 Eagle push key**: `demi-service-write` role landed (PR); prod key + secret +
      eagle-api tag remain. The role reads like staff, writes every data route, and is refused on
      `/api/admin/*` (`requireAdmin`), so a machine writer stops holding `demi-admin`. The test key
      (registry id `b319b93a1bf35206`, `demi-admin`, expires ~2026-11-23, in `demi-push-secret` in
      `6cdc9e-test`) still needs reissuing on the new role. ADR-007: Keycloak client before prod.

## 2. Decisions — Daniel

- [x] ~~**2.1 Anonymous surface — decided 2026-08-26, PR #162 in review.**~~ Done: #162 merged `d676664`; verified on prod 2026-08-26 (`/api-docs` 404, `pageSize=1000` 400).
- [x] ~~**2.2 `proponentId`.**~~ Moot for the cutover: eagle-public's search UI (`src/app/search/*`, filter template) never reads `proponentId` (grep 2026-08-26, zero hits); the Eagle push can carry it later.
- [x] ~~**2.3 Keycloak for prod demi-api.**~~ Done: existing `eagle-admin-console` on `loginproxy.gov.bc.ca`; `KEYCLOAK_CLIENT_ID` explicit in the template (#163); prod `/api/config` confirms.
- [x] ~~**2.4 Home for `eagle-edge-prod`.**~~ Done 2026-08-26: eagle-edge #1 — prod what-if zero
      create/delete, test identical; codified `og-eagle-backend` + `api-passthrough`. Follow-up:
      delete the prod Bicep copy from bcgov/eagle-public. Was: The prod Front Door (profile, endpoint, origin groups
      `og-eagle-public` + `og-eagle-backend`, routes `default` + `api-passthrough`, UAMI, storage)
      exists in `rg-eagle-public-prod`, but `digitalspace/eagle-edge` has only `main.test.bicepparam`
      and bcgov/eagle-public carries the prod Bicep. Move it into eagle-edge (decided 2026-08-25 for
      test) before any prod edge change, or accept two owners.
- [x] ~~**2.5 CORS in prod.~~ Done: `main.prod.bicepparam` already states it (`frontendHostNames` empty, same-origin via rproxy, fail closed).
## 3. Small, do opportunistically

- [x] ~~#162 minors~~ Done in PR #169 (`2136e39`).
- [x] ~~Review minors still real~~ Done in PR #169.
- [x] ~~`_sql.fetchAll` still passes `maxItemCount`,~~ Done in PR #169: `maxItemCount` dropped; rows appended without spread.
- [ ] `projects.js:128` filters `isDefinedAndNotNull('centroid')` but `/centroid/?` is not an included
      index path — that filter scans. Add the path (Bicep) or drop the filter; found 2026-08-26.
- [ ] Nightly reconcile + drift alarm for the Eagle push: the only thing that catches a
      hard-deleted document (`findOneAndDelete`, no tombstone). Script #171, seed's own admission
      rule #175, nightly run + alert #177 (deployed: infra `infra-bdca13b-211420`, app `v0.18.0-211917`,
      `reconcileEagle` registered 2026-08-26 21:25 UTC) — `RECONCILE_SCHEDULE`
      (`0 0 10 * * *`, PROD ONLY: test's corpus came from prod Eagle but its `EAGLE_API_BASE` is
      eagle-test, so a nightly diff there is meaningless) registers a Functions timer in the API
      app, and `demi-reconcile-drift-prod` mails the DEMI action group when `drift=` is over 0.
      Prod's one-row gap was closed and the report read drift=0 on `demi-api-prod` 2026-08-26.
      **The one thing left: watch the first SCHEDULED run in prod (2026-08-27 10:00 UTC).** Read
      the line in demi-logs-prod:
      `AppTraces | where Message contains "[reconcile] projects"`. One line a night with `drift=0`
      is clean; NO line means the timer never fired, and nothing alerts on that.
- [x] ~~Unused Cosmos index paths (`wildfires` spatial, projects composite, five scalars): verified
      removable; only with a Bicep deploy that happens for another reason.~~ Done in PR: dropped
      `projects` `/trackProjectId/?` + `/updatedAt/?` + the `[isPublished, name]` composite,
      `documents` `/fileExt/?` + `/displayName/?` + `/updatedAt/?`, `boundaries` `/code/?`, and the
      `wildfires` `/location/*` spatial index. **NOT applied yet** — it takes effect on the next
      hand-run `deploy-infra.sh --live`. What-if against both environments shows `~ Modify` on
      `indexingPolicy` for `boundaries`, `documents` and `projects` (plus `wildfires` in test only,
      which prod does not declare) and nothing else beyond the pre-existing baseline noise.
- [x] ~~eao-nginx `values-prod.yaml` stale pre-cutover prose~~ Done: PR #45 (default-branch
      warning) and #47 (gate narrative), comments only, helm render identical.

## HANDOFF 2026-08-26 ~08:40 UTC (session ended mid-Phase 2/4; read this first)

Prod state, all verified: `demi-cosmos-prod` + `demi-api-prod` live (unrouted from eagle-public);
`demi-search-prod` has `chunks`/`projects`/`documents` + indexers (PT5M); prod rproxy `v2.7.17`
routes `/demi-search/search` to demi-api-prod; eagle-public prod = `v2.7.29` (bundle
`main-KVREIOJN.js`, pod 3/3). Site search still `/eagle-search` (Mongo `Config.SEARCH_API_PATH`).

DECISION (Daniel, 08:25 UTC): the "Document Content" tab (`/search/content`, `SEARCH_TABS` in
eagle-public `src/app/search/search.config.ts`) MUST NOT surface in prod yet; API side in prod is
fine. No rollback. Fix = eagle-public PR #808 (`feat/content-search-flag`, `5889f107`, pushed 08:45 UTC, review
launched): tab + route gated on `/api/config` `CONTENT_SEARCH: true`. Review FINDINGS: MAJOR = eagle-api
`/api/config` whitelists keys (`api/helpers/models/config.js` + `api/controllers/config.js`), so
`CONTENT_SEARCH` is never served — hidden everywhere until an eagle-api PR adds the key (do that
before anyone wants the tab on; NOT needed to hide it). Merged #808 (`4c2fd7b`). Tag `v2.7.30` cut, Deploy to Test green (pod); Azure staging publish
dispatched (`--ref v2.7.30`); verify on `https://eagle-public-test-dbg8ghh8gjd0bscx.a02.azurefd.net/search`
— VERIFIED 08:48 UTC (one tab, redirect, bundle `main-STCWWWBG.js`). Prod: pod v2.7.30 + Azure publish
(run 32950007437) done; `projects.eao.gov.bc.ca` serves `main-STCWWWBG.js` since 08:54 UTC, tab
hidden, `/search/content` redirects — VERIFIED in a browser. eagle-public prod = v2.7.30. Follow-up PR #809 (`26e7bb5`, review PASS): no tab bar at all
when the flag is off (a lone Documents tab was pointless). Tag `v2.7.31` verified on test AFD
(`main-BTVKQ45Y.js`, zero tab bars); prod pod + Azure publish done; `projects.eao.gov.bc.ca` serves
`main-BTVKQ45Y.js` since 09:25 UTC, `/search` renders zero tab bars, 10 result rows — VERIFIED in a
browser. eagle-public prod = v2.7.31. Then: wait Deploy to Dev, `deploy-to-test.yaml`
`version=v2.7.30`, verify tab hidden on test, `deploy-to-prod.yaml` v2.7.30 (pod) and
`deploy-azure-prod.yaml` dispatched `--ref v2.7.30 -f version=v2.7.30` (env `azure-prod` allows
tags `v*`; approve via `POST …/actions/runs/<id>/pending_deployments`), confirm bundle + tab gone.

Chunk copy test→prod: `copy-to-env.js --live` runs DETACHED inside the `demi-api-test` container
(`/home/copy-prod.pid`, log `/home/copy-prod.log`, checkpoint `/home/copy-prod-checkpoint.json`),
independent of this box. Resumed 07:12 UTC from 388,200 / 1,128,576 (~83 rows/s). Any merge to
eagle-demi `main` restarts that container and kills it — rerun the same command (README recipe;
checkpoint resumes). Check: tunnel `az webapp create-remote-connection -g c4b0a8-test-rg -n demi-api-test --port 50123`,
then `ssh -p 50123` and `kill -0 $(cat /home/copy-prod.pid)`. When done: `copy-to-env.js` without
`--live` prints both sides' counts; chunks index count must reach the container count; purge
`eagle-6a5920eaf0b65c54e12eb20a` on prod (test-only project); revoke the temporary Cosmos Data
Contributor (`…0002`) for `demi-identity-test` (388ed601-3565-4932-a5b8-4d7b543e35a3) on
`demi-cosmos-prod`; delete `pe-demi-cosmos-prod-copy` in `c4b0a8-test-rg`; rerun `search-diff.js`
(`DEMI_DIFF_URL=https://demi-api-prod.azurewebsites.net/api/search`) — 12 DocumentChunk DIFFs at
08:00 were the unfilled index.

COPY DONE 12:42 UTC: projects 393 / documents 61,587 / chunks 1,128,576 on both sides
(`copy-to-env.js` count probe). Temp Cosmos role for `demi-identity-test` revoked; PE
`pe-demi-cosmos-prod-copy` deleted. `search-diff.js` vs prod eagle-search: 59 PASS /
12 DIFF, all `DocumentChunk` — prod answers 502 "Deep Search is unavailable" because
`demi-search-prod` has `semanticSearch: disabled` (test: `free`) and `chunks.json` carries the
`chunks-semantic` config. Semantic enabled `free` via ARM PATCH 17:10 UTC (CLI `az search service update` fails
`MissingIdentityIds`), but the real cause was DNS: deleting `pe-demi-cosmos-prod-copy` removed the
hub-zone A record for `demi-cosmos-prod`, so the prod container resolved the PUBLIC IP and Cosmos
rejected every query (point reads had worked before 12:55). I then deleted the PE's
`deployedByPolicy` dns-zone-group (recreate fails: hub subscription not addressable) and tagged the
PE to re-trigger the landing-zone DINE policy — background task waits for the zone group, private
resolution (10.46.50.39/.40), then retests `dataset=DocumentChunk`. RESOLVED 17:16 UTC: policy re-created the zone group, container resolves
10.46.50.39/.40, `dataset=DocumentChunk` answered, then flapped again (SDK had cached the public endpoint);
`az webapp stop`/`start` on demi-api-prod 17:35 UTC cleared it — 12/12 chunk searches 200 after.
search-diff 17:45 UTC: 68 PASS / 3 DIFF (cases 40-42 = the known DIFFs). Phase 2.4 COMPLETE.
Phase 5 next: rehearsal per `docs/prod-flip-runbook.md` (Daniel runs the two `updateOne`s). Test-only project
`eagle-6a5920eaf0b65c54e12eb20a` purged from prod 12:55 UTC (`DELETE /api/projects/<id>`, 404 after).
#166 merged `42f7436`; prod infra applied (`infra-42f7436-163123` Succeeded): webtest
`demi-search-availability-prod` enabled, every 300 s, on the public `/demi-search/search`
Document query (plan 3.2 done). Its results are meaningful only once semantic search is enabled
(the probe is a Document query, not a chunk query, so it is green already).
Done this session, not yet recorded elsewhere: 2.4 checks on demi-api-prod — `/api-docs` 404,
`pageSize=1000` 400, nonsense keyword 0, `probe-acl.js` 26/26 (prod admin key from `6cdc9e-prod`
`demi-app-secrets`); canary 114/114 all 200 across the eao-nginx + eagle-public prod deploys.
Uncommitted on this box: `eagle-demi.wiki` holds a 24-file rewrite (ADRs, Architecture, …) of
unknown origin — another session's work in progress; my prod-estate edits to `Azure-Environments`,
`Environment-Reality-and-Operational-Gotchas`, `Search-and-Retrieval` are inside it. Do not commit
blindly; whoever owns the rewrite reads and commits. `eagle-dev-guides.wiki` is clean (rewrite
`9e283da` deleted `Search-Cutover`; the flip recipe is on `Eagle-Search` and in
`docs/prod-flip-runbook.md`).

## 4. Prod promotion — ordered gates

Each step: verified on test first, deployed from a tag, measured after, rollback named.
Phase 0 (test-only PRs) started 2026-08-26: prod IaC + `deploy-infra.sh prod`, app hardening
(`/api-docs` off in prod, anonymous `pageSize` ≤ 100), eagle-edge prod params, eao-nginx `demi:`
value, eagle-public `v2.7.29` (has #803, #805) to test.

- [x] ~~**4.1 Stand up the prod estate in `rg-demi-prod`.**~~ DONE 2026-08-26 04:42-05:05 UTC.
      `deploy-infra.sh prod --live` (deployment `infra-ef4379f-044256`, Succeeded): what-if 33 create /
      0 modify / 0 delete; created `demi-cosmos-prod` (+ `projects documents chunks config apikeys
      boundaries`), `demi-api-prod` on `plan-eagle-search-prod` (scaled B1→B3 first, no observed
      `/eagle-search` downtime), `demi-identity-prod`, `pe-cosmos-nosql-prod`, `demi-logs/insights/
      audit-prod`, action group + 2 query rules, budgets 400 CAD + 50k ceiling, role assignments,
      shared private link `demi-cosmos-prod-link` (approved on the Cosmos side by hand). All five
      secrets verified live. Canary on `projects.eao.gov.bc.ca/` + `/eagle-search` every 20 s during the apply
      (40 min): 116/116 samples 200/200. `demi-api-prod` has no code yet (404) — Phase 3.
- [x] ~~**4.2 Copy the corpus into prod Cosmos — IN PROGRESS 2026-08-26 05:16 UTC.**~~ Done 2026-08-26 12:42 UTC: 393 / 61,587 / 1,128,576 both sides; temp role + PE removed; test-only project purged. Details in HANDOFF.
- [x] ~~**4.1b eao-nginx prod `demi:` value**~~ Done: folded into 4.4 (v2.7.17 on prod).
- [x] ~~**3.1 App code on `demi-api-prod`**~~ (plan Phase 3.1, moved before the index work because
      the prod container is where index PUTs run): hand zipdeploy 2026-08-26 05:16 UTC of `main`
      `ef4379f`, `BUILD_ID v0.15.0-dirty-051600` ("dirty" = local TODO.md edits, not code),
      `/api/config` → `ENVIRONMENT prod`, `KEYCLOAK_URL loginproxy.gov.bc.ca`, client
      `eagle-admin-console`. Unrouted; nothing points at it.
- [x] ~~**4.3 Index names vs rollback on `demi-search-prod`.**~~ Done: both sets coexist (`eagle-*` + `chunks`/`projects`/`documents`), 8.6 GB of 15; datasources/indexers live; semantic `free` enabled. Rollback = nothing to undo until 4.9.
- [x] ~~**4.4 eao-nginx prod tag with the demi block AND `nginx.epic.proxy.demi`**~~ DONE
      2026-08-26 07:00 UTC: PR #46 (`9ed9e1f`, review PASS) → tag `v2.7.17` cut by Deploy to Test
      (first run failed on a runner→OpenShift API timeout, rerun green) → Deploy to Prod succeeded,
      rproxy 2/2 on the test-verified image. Canary every 20 s on `/`, `/api/config`,
      `/eagle-search/search`, `/admin/`: all 200 throughout. `projects.eao.gov.bc.ca/demi-search/search`
      answers from `demi-api-prod` (Project 348 / Document 61,587). Site still on `/eagle-search`.
      Rollback: redeploy `v2.7.14`, or `oc set env deploy/rproxy NGINX__EPIC__PROXY__DEMI=http://localhost:9999 -n 6cdc9e-prod`.
- [x] ~~**4.5 eagle-public prod tag containing #803**~~ Done: prod = v2.7.31 (bundle `main-BTVKQ45Y.js`), includes #803/#805/#808/#809.
- [x] ~~**4.6 Prod observability for demi-api.**~~ `rg-demi-prod` had no LAW/App Insights before the 4.1 apply; the
      template wires `APPLICATIONINSIGHTS_CONNECTION_STRING` from the observability module, so 4.1
      covers the resource. Webtest `demi-search-availability-prod` added in
      `azure/modules/availability.bicep`, modelled on `eagle-public-availability-prod`, probing
      `https://projects.eao.gov.bc.ca/demi-search/search?dataset=Document&keywords=assessment&pageSize=1`
      — the public path through rproxy, so it sees a moved Front Door address, and `dataset=Document`
      so every probe goes through AI Search rather than the Cosmos project list. Deploys only where
      `availabilityUrl` is set; probes carry `X-Synthetic-Probe` and are not counted as usage.
- [x] ~~**4.7 Cost sign-off.**~~ Signed off by Daniel 2026-08-26. Billing currency CAD (verified on
      the subscription's usage details). `demi-budget-prod` 400 CAD/month (80 %, 100 %, forecast
      100 %); the absolute cap is ONE budget for everything EPIC owns: `epic-ceiling` 50,000 CAD/year at
      management group `c4b0a8` (dev, test, tools, prod subscriptions; 50 %, 80 %, forecast 90 %,
      actual 100 %; Bicep in `digitalspace/eagle-edge` `azure/budget-mg.bicep`). The two RG-scoped
      `demi-ceiling-*` budgets are deleted. Azure budgets notify; they do not stop spend — a hard stop would need an
      automation on the action group (`docs/FUTURE.md` if ever wanted). Spend 24 CAD by 2026-08-26.
- [ ] **4.8 Flip and soak.** FLIPPED 2026-08-26 21:30:47 UTC (rehearsal 21:28:01–21:29:40, both
      directions, `/api/config` byte-identical after revert). `SEARCH_API_PATH: /demi-search` in prod
      Mongo; `/api/config` served it 1 s later; browser: search calls go to `/demi-search`, none to
      `/eagle-search`, lists still eagle-api. Rollback = `updateOne` back to `/eagle-search` (proven
      19 s). Watch: `demi-search-availability-prod` webtest, `demi-reconcile-drift-prod`, App
      Insights 5xx on demi-api-prod; 1-h canary after the flip in the session log. Soak length is
      Daniel's call; it gates only 4.9.
      Was: PREREQ (2026-08-26): prod DEMI is 1 document behind prod Eagle
      (24 more sit under unpublished parents and are not drift) (reconcile report, §3). Close it
      first: in the `demi-api-prod` container, `seed-nosql.js` dry run then `--live` (additive
      upsert, carries extraction state; NO `--reconcile`), then the reconcile report against prod
      must show documents eagleOnly=0. Daniel's go, then rehearsal per `docs/prod-flip-runbook.md`.
      Dry run in prod 2026-08-26 19:10 UTC: fetched 61,612, built 61,588, `droppedUnresolvable` 24
      (parents unpublished in Eagle — the double gate hides them anyway), preserved 61,587 → 1
      genuinely new document; projects built 392. `--live --only projects,documents` (boundaries
      never in prod) run by Daniel 2026-08-26 ~19:30 UTC; gate = reconcile `drift=0` — PASSED 19:41 UTC on `demi-api-prod` (`v0.17.2-192020`):
      projects 0/0, documents 0/0, `unresolvedParent=24`. PREREQ DONE; the flip is now yours.
      Set prod `SEARCH_API_PATH` to `/demi-search` (one Mongo field, no
      deploy); keep `/eagle-search` answering. Define the soak criterion here before flipping
      (proposed: 14 days, zero 5xx on `/demi-search`, differ green against the frozen eagle-search).
      Soak with the browser console open (`EventService.getError()` has no subscribers — defects are
      an empty table + console line); chunk search has no public UI, exercise the endpoint.
      Rollback = set the field back.
- [ ] **4.9 After the soak.** Retire `eagle-search-prod` search service (idle, ~100 CAD/mo),
      `eagle-search-api-prod`, the `eagle-*` indexes on `demi-search-prod`, `deploy/eagle-search-sync`
      + `cronjob/eagle-search-reindex` in `6cdc9e-prod`, `deploy-prod-worker.yaml` (repo archived).
      Then the eagle-public prod pods once the AFD rollback is no longer wanted.

## 5. OpenShift retirement — Daniel says when (costs nothing)

- [ ] **5.1 eagle-public dev/test pods.** Test: `deploy/eagle-public` 2/2 (AFD rollback target),
      `eagle-public-feat-azure-hosting-mainline` 1/1 (branch preview). Dev: site IS the pod
      (`ROOT=http://eagle-public:8080`), plus the orphan `eagle-{admin,api,public}-dev` trio
      (ArgoCD ids, no Application). Retire dev whole or repoint `ROOT` at the test AFD host.
      Keep `Route/eagle-public` (Keycloak host).
- [ ] **5.2 DEMI OpenShift stack in `6cdc9e-dev`** — `eagle-demi`, `eagle-demi-api`,
      `eagle-demi-frontend`, `eagle-demi-redis`, `eagle-demi-worker` (34-82 days old). Nothing
      routes to them; DEMI is Azure-only. Delete on go.

## 6. Standing rules — do not re-derive

- **A probe that cannot fail proves nothing.** Take a BEFORE reading; nonsense terms detect
  fallback; synthetic rows for ACLs (`src/scripts/probe-acl.js`, 26 cells).
- **The predicate trap**: enumerate every shape a field takes before choosing a predicate; a test
  that mocks the call site asserts a shape production cannot produce.
- **Index-change deploy order is not negotiable** (`azure/search/README.md`): index PUT → datasource
  PUT by hand → backfill → indexer reset + run → app last. The committed `indexes/*.json` is the
  app's field metadata, so merging it IS the app change.
- **OData has no `false` literal** — null/empty filter is UNRESTRICTED; routes honour the `empty` flag.
- **`_ts` advances on any write; indexers see no deletes** — `helpers/purge.js` is the only delete.
- **appSettings is a whole-collection PUT**; `demi-app-secrets` (OpenShift) is the source of truth
  for every deployed credential; never round-trip secrets out of the live app.
- **App Service**: `restart` does not recycle the worker (stop/start, poll a discriminator); ~50 s
  cold start; chunked bodies dropped; 240 s timeout; verify deploys by content; zipdeploy status
  3=FAILED 4=SUCCESS; a merge-deploy kills the SSH tunnel mid-run.
- **eagle-api `Deploy to Test` tags from `ci-latest`** — wait for `Deploy to Dev` on the merge sha
  first or the version tag gets the previous image (v2.10.66 burned).
- **Where demi is deliberately STRICTER than eagle-search — do not "fix" toward eagle**: unknown
  params 400; `pageSize>500` refused; `read[]` withheld; keywordless chunk search returns 0.
- **Decided, do not redo**: helmet CSP off; rate limiter proven; facets over the filtered set;
  filter values stay List ObjectIds; chunk rows grouped by document; eagle-public chunk
  metadata controls dropped (PR 805); no `projectIsPublished` denorm (seed invariant instead);
  no adapter layer while one enrichment source exists; `content` stays retrievable (semantic gain).
- **Comments**: non-obvious why, one or two lines; anything longer is a wiki page.

## Out of scope

`rg-epic-search` shares the billing group, not the ownership. `rg-condition-extractor-prod` is
not ours.
