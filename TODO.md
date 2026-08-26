# TODO

**Goal: prod — eagle-public on Azure, served by demi-api, prod data Eagle + Track only.**
Test is done and verified (2026-08-25). Everything below is open work toward prod, or parked with
a reason. Unscheduled ideas: `docs/FUTURE.md`. History: `git log`, wiki. **Merging is deploying**
on test — `main` is live on staging within minutes and test search is user-facing.

Rules: append newly found work here before doing it; strike a wrong line with a one-line reason;
pin every claim to a measurement with a date; reviewer takes a positional sha
(`review.sh --repo eagle-demi <sha>`); prod deploys only from a tag verified on test.

## Facts — verified 2026-08-26 unless dated otherwise

1. **Test corpus = prod eagle-api** (re-seed 2026-08-25): 392 projects / 61,587 documents, index
   61,587, anonymous Project 348. `search-diff.js` 68 PASS / 3 DIFF (the 3 = chunk metadata
   filters, controls dropped in eagle-public). `chunks` 1,128,733 rows is the only extracted copy;
   backup Periodic 240-min / 8-hour retention, restore untested; ~1,496 source PDFs 404.
2. **Prod is a separate subscription**: `c4b0a8-prod - EPIC.AI` = `be5924ac-1083-4a1b-be92-7b444882cfd9`
   (test = `7897ceb1-…`). RGs: `rg-demi-prod` (3 resources: `demi-search-prod` Basic 1 partition,
   `pe-demi-search-prod`, NIC), `rg-eagle-search-prod` (`eagle-search-api-prod`, `eagle-search-prod`,
   plan, PE, LAW, App Insights; worker in `6cdc9e-prod`), `rg-eagle-public-prod` (AFD
   `eagle-edge-prod` endpoint `eagle-public-prod-aafug4ahavgzbvh9.a01.azurefd.net`, storage
   `eaglepubprodrhj3zycszo6j`, UAMI `eagle-public-cicd-prod`, LAW, App Insights, live webtest
   `eagle-public-availability-prod` on `projects.eao.gov.bc.ca/`), `rg-condition-extractor-prod`.
   **No Cosmos account exists in prod.**
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
- [ ] **1.2 Rotate `RPROXY_EGUIDE_PASSWORD`** (bcgov/eao-nginx secret, last set 2026-02-20, used in
      `deploy-to-prod.yaml:139`); keep the `/eguide` route. Delete the dead `TYPESENSE_SEARCH_KEY`
      secret on the same repo (2026-05-12) in the same pass.
- [ ] **1.3 Eagle push key**: registry id `b319b93a1bf35206`, `demi-admin`, 90-day expiry
      (~2026-11-23), in `demi-push-secret` (`6cdc9e-test`). Prod needs its own, and a
      `demi-service-write` role so a machine writer stops holding `demi-admin` (ADR-007: Keycloak
      client before prod).

## 2. Decisions — Daniel

- [ ] **2.1 Anonymous surface before prod.** 13 anonymous GETs; `GET /projects` (786 KB) and
      `/documents` allow `pageSize` 1000 and have no consumer (eagle-public uses `/api/search` only).
      Narrow, auth, or accept. `/api-docs` is mounted unconditionally (`src/app.js:146-152`) — gate
      it off in prod. Choose; nothing has to close.
- [ ] **2.2 `proponentId`.** Prod `/eagle-search` returns it; demi does not hold it (no org id in
      Cosmos), so the cutover loses the facet until the Eagle push carries `proponentId` + label.
      Wait for that, or backfill ~392 rows. Never the name-valued shortcut (497 of 778 options match
      zero projects).
- [ ] **2.3 Keycloak for prod demi-api.** `api-web-app.bicep` sets `KEYCLOAK_URL`/`REALM`/`ENABLED`
      but never `KEYCLOAK_CLIENT_ID`; `src/config.js:157,159` defaults are DEV Keycloak and
      `eagle-admin-console`; test serves those defaults. A prod deploy without explicit values
      validates staff tokens against dev. Decide the prod client (existing `eagle-admin-console` on
      `loginproxy.gov.bc.ca`, or a DEMI client) and add `KEYCLOAK_CLIENT_ID` to the template.
- [ ] **2.4 Home for `eagle-edge-prod`.** The prod Front Door (profile, endpoint, origin groups
      `og-eagle-public` + `og-eagle-backend`, routes `default` + `api-passthrough`, UAMI, storage)
      exists in `rg-eagle-public-prod`, but `digitalspace/eagle-edge` has only `main.test.bicepparam`
      and bcgov/eagle-public carries the prod Bicep. Move it into eagle-edge (decided 2026-08-25 for
      test) before any prod edge change, or accept two owners.
- [ ] **2.5 CORS in prod.** `src/app.js:70-80` falls back to `localhost:4200` when `CORS_ORIGIN` is
      unset; `api-web-app.bicep:455` derives it from `frontendHostNames`, which prod lacks (no demo
      frontend). Same-origin via rproxy `/demi-search` makes it moot — say so in the prod params, or
      set the AFD host.

## 3. Small, do opportunistically

- [ ] Review minors still real: Document response fields `isFeatured`/`documentSource`
      (`search.js:~487`) untested; `searchReady` production default (`seed-nosql.js:~284`) untested;
      `merge/project.js:83-86` nested ternary, and the refusal checks that the legislation key
      resolves, not that the block has content; swagger 400 wording for that refusal.
- [ ] `_sql.fetchAll` still passes `maxItemCount`, so a future cross-partition + ORDER BY caller
      truncates at 1,000 silently (SDK drops `x-ms-continuation`); only the reconcile sites carry a
      COUNT guard. Decide: drop `maxItemCount` in `fetchAll` vs keep the unbounded-read protection.
- [ ] Nightly reconcile + drift alarm for the Eagle push: the only thing that catches a
      hard-deleted document (`findOneAndDelete`, no tombstone). Model on
      `eagle-search/worker/full-sync.js:120-164` (archived, readable locally). Test first.
- [ ] Unused Cosmos index paths (`wildfires` spatial, projects composite, five scalars): verified
      removable; only with a Bicep deploy that happens for another reason.
- [ ] eao-nginx `values-prod.yaml:141-147` still warns prod renders from the default branch;
      `deploy-to-prod.yaml:103-105` pins `ref: inputs.version` — stale prose, delete.

## 4. Prod promotion — ordered gates

Each step: verified on test first, deployed from a tag, measured after, rollback named.

- [ ] **4.1 Stand up the prod estate in `rg-demi-prod` (`c4b0a8-prod`).** Needed: `main.prod.bicepparam`
      (none exists; `deploy-infra.sh` exits 2 on prod by design — extend it, never fork), plan,
      Function App, UAMI, VNet integration + PEs (`snet-app-service` exists in
      `c4b0a8-prod-networking`), Cosmos account, observability (LAW + App Insights — none in
      `rg-demi-prod`). Foundry/summariser is demo-only: skip. **Template change first:**
      `cosmos-nosql.bicep` declares all 8 containers unconditionally — prod must declare
      `projects`, `documents`, `chunks`, `config`, `apikeys` only, so add a `deployEnrichment`
      switch. `ENRICHMENT_SOURCES` empty. `rateLimitMaxRequests` per transport (test 6000, default
      300). Role assignments need a deploying principal with `roleAssignments/write` (fact 5); a
      `prod` GitHub environment + `demi-cicd-prod` federated credential do not exist — hand deploy
      with Daniel's login, or create them. Blob delegator only if downloads sign from prod.
- [ ] **4.2 Copy the corpus into prod Cosmos BEFORE demi-api answers a prod query.** Cosmos is in
      the chunk path — no prod Cosmos = every chunk result withheld (empty 200). Reconcile counts
      over the tunnel first (index 1,128,576 vs container 1,128,733, unverified since 2026-08-24).
      Copy the five 4.1 containers; the seed (`seed-nosql.js --reconcile`, prod source) can rebuild
      `projects`/`documents` but nothing rebuilds `chunks` except `export-chunks-to-eagle.js` +
      re-import. `ENRICHMENT_SOURCES` empty strips any copied wildfire stats at read.
- [ ] **4.3 Index names vs rollback on `demi-search-prod`.** It holds `eagle-*` (served by
      `eagle-search-api-prod`); demi wants `chunks`/`projects`/`documents`. Basic = 15 GB, one
      partition; two sets ≈ 8.5 GB measured on test — verify used storage over the tunnel before
      creating the second set. Either hold both through the soak or repoint `eagle-search-api-prod`'s
      three settings in the same change. Apply the widened definitions (`fileNameTokens` needs
      `allowIndexDowntime=true`; `stored:false` rejected). Order: index PUT → datasource PUT by hand
      → indexer run → app last.
- [ ] **4.4 eao-nginx prod tag with the demi block AND `nginx.epic.proxy.demi`.** The block is in
      v2.7.15/v2.7.16; prod runs v2.7.14 (same image as v2.7.13). `values-prod.yaml` has no `demi:`
      key and prod rproxy has no `NGINX__EPIC__PROXY__DEMI` — a chart-only deploy renders the
      `localhost:9999` sentinel. One PR (`demi:` value), one tag, one deploy; human approval gate;
      stale-`waiting`-run concurrency trap. Verify: `/demi-search/search?dataset=Project&pageSize=1`
      200 on `projects.eao.gov.bc.ca`.
- [ ] **4.5 eagle-public prod tag containing #803** (`e3f3c3c4`, three envelope null guards; in no
      tag yet; prod runs v2.7.28 = `65b1a1a`). Cut from `develop`, verify on test (pod + AFD, same
      tag), deploy to both the pod chart and the AFD bundle. Without it a malformed envelope bounces
      visitors off `/projects`.
- [ ] **4.6 Prod observability for demi-api.** `rg-demi-prod` has no LAW/App Insights; the template
      wires `APPLICATIONINSIGHTS_CONNECTION_STRING` from the observability module, so 4.1 covers the
      resource. Add a webtest on a real search URL (`/demi-search/search?…` via
      `projects.eao.gov.bc.ca`) modelled on `eagle-public-availability-prod` — the only check that
      sees a moved Front Door address (rproxy resolves DNS once at config load).
- [ ] **4.7 Cost sign-off.** Prod plan + Cosmos + PEs + observability + a temporary second index set.
      Create a `rg-demi-prod` budget before 4.1 (test RG projects ~237 CAD/month, fact 7).
- [ ] **4.8 Flip and soak.** Set prod `SEARCH_API_PATH` to `/demi-search` (one Mongo field, no
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
