using './main.bicep'

// Production: rg-demi-prod in c4b0a8-prod (be5924ac-1083-4a1b-be92-7b444882cfd9). Hand-run only —
// there is no CI path to production infrastructure and deliberately will not be one:
//   MINIO_BUCKET_NAME=… MINIO_ACCESS_KEY=… MINIO_SECRET_KEY=… ADMIN_API_KEY=… DOCLING_API_KEY=… \
//     ./scripts/deploy-infra.sh prod --what-if
// The group already holds demi-search-prod and its private endpoint; everything else is new.

param environmentName = 'prod'
param location = 'canadacentral'

// ── Object store ──────────────────────────────────────────────────────────────────────────────
// The NRS store, shared with eagle-api and outliving any Azure environment. Prod's objects sit at
// the root of bucket `ozwdez` with no prefix — which is the same path test reaches as
// asnpnn/ozwdez/, because the test bucket holds a nested copy of prod one segment deeper.
// Credentials come from the 6cdc9e-prod secret `nr-object-store-credential` (user_account /
// password), NOT eagle-api-minio-keys; deploy-infra.sh knows which secret to read per environment.
param minioHost = 'nrs.objectstore.gov.bc.ca'
param minioBucketName = 'ozwdez'
param minioKeyPrefix = ''

// No second argument to readEnvironmentVariable anywhere below, for the reason spelled out in
// main.test.bicepparam:22-25 — appSettings is a whole-collection PUT, what-if masks @secure()
// values in BOTH before and after, so an empty fallback destroys a live credential invisibly.
param minioAccessKey = readEnvironmentVariable('MINIO_ACCESS_KEY')
param minioSecretKey = readEnvironmentVariable('MINIO_SECRET_KEY')
param adminApiKey = readEnvironmentVariable('ADMIN_API_KEY')
param doclingApiKey = readEnvironmentVariable('DOCLING_API_KEY')

// ── Data ──────────────────────────────────────────────────────────────────────────────────────
// The seed loader's upstream. PROD eagle-api, reached at its public hostname.
param eagleApiBase = 'https://projects.eao.gov.bc.ca/api/public'

// Prod publishes no enrichment, so neither the API surface nor the wildfires container behind it
// exists. `boundaries` is declared regardless — it is reference data every environment serves, and
// an empty container is what `GET /boundaries` and `GET /db/stats` need to answer at all.
param enrichmentSources = ''
param deployEnrichment = false

// ── Search ────────────────────────────────────────────────────────────────────────────────────
// demi-search-prod is already standing, deployed from azure/ai-search.prod.bicepparam, and it also
// serves eagle-search-api-prod's eagle-* indexes. This template is not its owner: false grants the
// DEMI identity Search Index Data Contributor on it and touches nothing else.
param deploySearch = false
param existingSearchEndpoint = 'https://demi-search-prod.search.windows.net'

// demi-search-prod runs its indexers as eagle-search-identity-prod (azure/ai-search.prod.bicepparam),
// not the DEMI identity, so the shared private link alone leaves them at 403 on demi-cosmos-prod.
// This grants that principal Cosmos Data Reader. `az identity show -g rg-eagle-search-prod
// -n eagle-search-identity-prod --query principalId`.
param existingSearchIndexerPrincipalId = '20211fb1-1d7c-43ab-ae57-fbcd6a5034e7'

// ── Off in prod ───────────────────────────────────────────────────────────────────────────────
// The summariser is demo-only. deployFoundry=false is the resource, summaryEnabled=false is the
// app; deployFoundryPrivateEndpoint is then moot but stated so a future flip of deployFoundry does
// not silently create a PE as well.
param deployFoundry = false
param summaryEnabled = false
param deployFoundryPrivateEndpoint = false

// Phase 3b, never deployed anywhere. Prod reads MinIO like every other environment.
param deployDocumentStorage = false

// DEMI has no frontend in prod — eagle-public is the consumer — so there is no `$web` origin to
// create and nothing would ever publish into it.
param deployStaticSite = false

// ── Transport ─────────────────────────────────────────────────────────────────────────────────
// 6000, the same value and for the same reason as test: prod is reached same-origin through
// rproxy's /demi-search, rproxy sets no `X-Forwarded-For`, so `callerIp` is rproxy's egress address
// on every request and this is ONE GLOBAL BUCKET, not a per-caller limit
// (src/middleware/rate-limiter.js:44-73). At the 300 default that is 5 r/s for the entire public
// site while rproxy itself admits 10 r/s per IP (limit_req zone=api_search, burst 20) — one
// search-as-you-type client can 429 everyone. The 300 default stays right for a directly exposed
// deployment; revert here when `demi.eao.gov.bc.ca` replaces the proxy hop.
param rateLimitMaxRequests = 6000

// Empty, deliberately. There is no DEMI frontend in prod — eagle-public is the consumer and it
// reaches this API same-origin through rproxy, so no browser origin needs allowing. Empty leaves
// CORS_ORIGIN unset and src/app.js falls back to localhost only: fail closed, not open.
param frontendHostNames = []

// ── Compute ───────────────────────────────────────────────────────────────────────────────────
// Join eagle-search's plan rather than creating demi-plan-prod: B1 Basic, kind linux, one worker —
// compatible with `functionapp,linux`, and it is the plan already integrated into snet-app-service,
// which is what makes DEMI's VNet integration into that subnet possible at all.
// Scaled to B3 before the prod apply (decided 2026-08-26) so two apps do not share one B1 worker.
// Shared with eagle-search-api-prod until that app retires (TODO 4.9), then it is DEMI's.
param existingServerFarmId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/rg-eagle-search-prod/providers/Microsoft.Web/serverfarms/plan-eagle-search-prod'

// ── Network ───────────────────────────────────────────────────────────────────────────────────
// Landing-zone subnets in c4b0a8-prod-networking; private DNS is attached by policy from a central
// subscription this one cannot read, so no zone is named here.
//
// snet-app-service carries plan-eagle-search-prod's service-association link (allowDelete: false),
// which is exactly the plan set above — same plan, same delegated subnet, so no second integration
// is being asked for. The other Microsoft.Web-delegated subnet, c4b0a8-prod-cond-ext-webapp-subnet,
// is claimed by asp-condition-extractor-prod and is not available.
param privateEndpointSubnetId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/c4b0a8-prod-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-prod-vwan-spoke/subnets/c4b0a8-prod-cond-ext-pe-subnet'
param appServiceSubnetId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/c4b0a8-prod-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-prod-vwan-spoke/subnets/snet-app-service'

// ── Monitoring ────────────────────────────────────────────────────────────────────────────────
// THE PUBLIC PATH THROUGH rproxy, which is what eagle-public calls and the only address that fails
// when the Front Door address moves — rproxy resolves it once at config load. Aiming this at
// demi-api-prod.azurewebsites.net instead would stay green through exactly that outage.
//
// `dataset=Document` is what forces the request through AI Search: `hasCriteria` is false for a
// bare project list, and the Project branch then answers from Cosmos, so an AI Search outage would
// not move this test. See src/controllers/search.js — every document read goes to the index.
param availabilityUrl = 'https://projects.eao.gov.bc.ca/demi-search/search?dataset=Document&keywords=assessment&pageSize=1'

// ── Reconcile ─────────────────────────────────────────────────────────────────────────────────
// The nightly Eagle drift report, a Functions timer in the API app, plus the alert on its one
// output line. It is the only thing that notices a hard-deleted Eagle document — that delete
// carries no tombstone, so the push cannot report it and nothing else looks.
//
// NCRONTAB: the leading 0 is SECONDS. 10:00 UTC (03:00 PDT, 02:00 PST), an hour after test, so the
// two never read eagle-api at once.
param reconcileSchedule = '0 0 10 * * *'
param deployReconcileDriftAlert = true

// ── Cost ──────────────────────────────────────────────────────────────────────────────────────
// rg-demi-prod has no budget at all today. 400 CAD matches the test guard; prod carries no Foundry
// account and no second search service, but does carry a plan, Cosmos and the private endpoints.
param budgetAmount = 400

param contactEmails = [
  'daniel@digitalspace.ca'
  'Daniel.T.Truong@gov.bc.ca'
]
