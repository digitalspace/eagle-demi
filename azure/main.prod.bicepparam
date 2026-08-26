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

// Prod publishes no enrichment, so neither the API surface nor the containers behind it exist.
param enrichmentSources = ''
param deployEnrichment = false

// ── Search ────────────────────────────────────────────────────────────────────────────────────
// demi-search-prod is already standing, deployed from azure/ai-search.prod.bicepparam, and it also
// serves eagle-search-api-prod's eagle-* indexes. This template is not its owner: false grants the
// DEMI identity Search Index Data Contributor on it and touches nothing else.
param deploySearch = false
param existingSearchEndpoint = 'https://demi-search-prod.search.windows.net'

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
// The DEFAULT, unlike test's 6000. Prod is reached same-origin through rproxy's /demi-search, and
// rproxy already enforces the real per-client limit (limit_req zone=api_search, 10 r/s burst 20).
// Test raised this only because its direct browser path serves an internal frontend; prod has no
// such frontend, so the value that was "not one to carry to prod" is not carried.
param rateLimitMaxRequests = 300

// Empty, deliberately. There is no DEMI frontend in prod — eagle-public is the consumer and it
// reaches this API same-origin through rproxy, so no browser origin needs allowing. Empty leaves
// CORS_ORIGIN unset and src/app.js falls back to localhost only: fail closed, not open.
param frontendHostNames = []

// ── Compute ───────────────────────────────────────────────────────────────────────────────────
// Join eagle-search's plan rather than creating demi-plan-prod: B1 Basic, kind linux, one worker —
// compatible with `functionapp,linux`, and it is the plan already integrated into snet-app-service,
// Scaled to B3 before the prod apply (decided 2026-08-26) so two apps do not share one B1 worker.
// which is what makes DEMI's VNet integration into that subnet possible at all.
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

// ── Cost ──────────────────────────────────────────────────────────────────────────────────────
// rg-demi-prod has no budget at all today. 400 CAD matches the test guard; prod carries no Foundry
// account and no second search service, but does carry a plan, Cosmos and the private endpoints.
param budgetAmount = 400

param contactEmails = [
  'daniel@digitalspace.ca'
  'Daniel.T.Truong@gov.bc.ca'
]
