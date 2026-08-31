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

param linkBaseUrl = 'https://projects.eao.gov.bc.ca'

// azp values: frontend client id + eagle-admin-console; measured against realm eao-epic.
// One entry, because this file sets no keycloakClientId and takes main.bicep's default, which is
// the same id. Prod's other callers are eagle-api's push (API key) and eagle-public (anonymous).
param allowedClients = 'eagle-admin-console'

// set after measuring aud on a live token
param ssoAudience = ''

// Empty, deliberately. There is no DEMI frontend in prod — eagle-public is the consumer and it
// reaches this API same-origin through rproxy, so no browser origin needs allowing. Empty leaves
// CORS_ORIGIN unset and src/app.js falls back to localhost only: fail closed, not open.
param frontendHostNames = []

// ── Compute ───────────────────────────────────────────────────────────────────────────────────
// No `existingServerFarmId`: a Flex plan cannot be shared, so demi-api-fc-prod owns one. The B1 app
// in api-web-app.bicep consequently CREATES demi-plan-prod if it is applied from here, and its
// integration into snet-app-service then collides with plan-eagle-search-prod's service-association
// link. Read what-if before any prod apply while both apps stand.

// ── Network ───────────────────────────────────────────────────────────────────────────────────
// Landing-zone subnets in c4b0a8-prod-networking; private DNS is attached by policy from a central
// subscription this one cannot read, so no zone is named here.
//
// snet-app-service carries plan-eagle-search-prod's service-association link (allowDelete: false),
// and a delegated subnet carries one plan's integration at a time. The other Microsoft.Web-delegated
// subnet, c4b0a8-prod-cond-ext-webapp-subnet, is claimed by asp-condition-extractor-prod and is not
// available.
param privateEndpointSubnetId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/c4b0a8-prod-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-prod-vwan-spoke/subnets/c4b0a8-prod-cond-ext-pe-subnet'
param appServiceSubnetId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/c4b0a8-prod-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-prod-vwan-spoke/subnets/snet-app-service'

// The Flex app's own subnet, delegated to `Microsoft.App/environments` with an NSG attached (both
// demanded by policy). A Microsoft.Web-delegated subnet cannot host it, so this is a second subnet
// rather than the one above.
param apiFlexSubnetId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/c4b0a8-prod-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-prod-vwan-spoke/subnets/snet-demi-func-fc1-prod'

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
// PROD IS THE ONLY ENVIRONMENT THAT RUNS THIS. Test's corpus came from prod Eagle and its
// `eagleApiBase` is eagle-test, so a nightly diff there compares two unrelated corpora.
//
// NCRONTAB: the leading 0 is SECONDS. 10:00 UTC is 03:00 PDT, 02:00 PST.
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

// ── Track team sync ───────────────────────────────────────────────────────────────────────────
// Same job as test. Secrets come from OpenShift `demi-app-secrets` through deploy-infra.sh.
param trackApiBase = 'https://epictrack-api-c72cba-prod.apps.gold.devops.gov.bc.ca'
param trackClientId = 'demi-track-reader'
param roleSyncClientId = 'demi-role-sync'
param trackClientSecret = readEnvironmentVariable('TRACK_CLIENT_SECRET')
param roleSyncClientSecret = readEnvironmentVariable('ROLE_SYNC_CLIENT_SECRET')

// Empty until both realm clients exist in the prod realm.
param syncTeamsSchedule = ''
