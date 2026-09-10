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

// The rproxy egress addresses as APIM reports them (`callerIp` on the App Insights request row
// for a request made through projects.eao.gov.bc.ca/demi-search; measured 2026-09-07). With these
// trusted, the anonymous bulk-download quota keys on the browser hop instead of putting every
// eagle-public visitor on one shared key.
// An address missing here only puts that proxy's visitors back on one shared key.
param trustedProxyIps = '142.34.194.121,142.34.194.122,142.34.194.123,142.34.194.124'

// The secret the eagle-edge rule set stamps on origin requests. It comes from OpenShift
// `demi-app-secrets` through deploy-infra.sh, never from this file. The `''` fallback is
// deliberate, like notifyApiKey below: an environment with no Front Door in front of it writes no
// secret and ignores the header, rather than failing the build on a value it does not use.
param edgeSecret = readEnvironmentVariable('EDGE_SECRET', '')

// The browser origins allowed to call the API. `siteConfig.appSettings` is a whole-collection PUT,
// so this list IS CORS_ORIGIN on demi-api-fc-prod. eagle-public needs no entry — it reaches the API
// same-origin through rproxy. The one entry is the DEMI admin console's Front Door endpoint on
// eagle-edge-prod, read from eagle-edge's edgeEndpointHostNames output, never composed. main.bicep
// also filters this list down to demi-admin hosts for the analytics allowlist.
param frontendHostNames = [
  // DEMI admin console prod endpoint on eagle-edge-prod, created 2026-09-08.
  'demi-admin-prod-hfgebphjbucqd5bt.a01.azurefd.net'
]

// ── Compute ───────────────────────────────────────────────────────────────────────────────────
param deployApim = true

// ── eagle-analytics ───────────────────────────────────────────────────────────────────────────
// Filled in from the eagle-analytics deployment's outputs in `rg-eagle-public-prod`; none is
// composed — a Function App host name can carry a regional suffix, and the DCR endpoint and
// immutable ID are Azure-generated:
//   analyticsBackendUrl          <- apiHostName, prefixed https://
//   analyticsDcrEndpoint         <- eventsDcrEndpoint
//   analyticsDcrImmutableId      <- eventsDcrImmutableId
//   analyticsWorkspaceCustomerId <- analyticsWorkspaceCustomerId
param analyticsBackendUrl = 'https://analytics-api-fc-prod.azurewebsites.net'
param analyticsDcrEndpoint = 'https://analytics-dcr-prod-625z-canadacentral.logs.z1.ingest.monitor.azure.com'
param analyticsDcrImmutableId = 'dcr-1805b5a943b34c8d83f13bb4225b8319'
param analyticsWorkspaceCustomerId = '2a0751d4-6666-40f1-b9a6-846030078467'
// The '' fallback keeps `az bicep build` green without the GitHub environment secret exported;
// deploy-infra.sh refuses a prod apply unless this and analyticsAuditHeaderValue below are both set.
param analyticsSharedHeaderValue = readEnvironmentVariable('APIM_SHARED_HEADER_VALUE', '')
// The second credential, demanded on POST /audit alone and deployed there as
// AUDIT_SHARED_HEADER_VALUE. Same home and same handling as the one above.
param analyticsAuditHeaderValue = readEnvironmentVariable('AUDIT_SHARED_HEADER_VALUE', '')

// Live budget period, read from demi-budget-prod 2026-09-01 (az rest: 2026-08-01T00:00:00Z) —
// an existing budget rejects startDate changes.
param budgetStartDate = '2026-08-01'

// ── Network ───────────────────────────────────────────────────────────────────────────────────
// Landing-zone subnets in c4b0a8-prod-networking; private DNS is attached by policy from a central
// subscription this one cannot read, so no zone is named here.
param privateEndpointSubnetId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/c4b0a8-prod-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-prod-vwan-spoke/subnets/c4b0a8-prod-cond-ext-pe-subnet'

// The Flex app's own subnet, delegated to `Microsoft.App/environments` with an NSG attached (both
// demanded by policy). The private-endpoint subnet above cannot host it.
param apiFlexSubnetId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/c4b0a8-prod-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-prod-vwan-spoke/subnets/snet-demi-func-fc1-prod'

// ── Monitoring ────────────────────────────────────────────────────────────────────────────────
// THE PUBLIC PATH THROUGH rproxy, which is what eagle-public calls and the only address that fails
// when the Front Door address moves — rproxy resolves it once at config load. Aiming this at
// demi-api-fc-prod.azurewebsites.net instead would stay green through exactly that outage.
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

// ── Bulk download ─────────────────────────────────────────────────────────────────────────────
// OFF UNTIL TEST HAS RUN IT. The queue and the Cosmos container deploy either way; an empty queue
// name registers no worker, so prod carries the infrastructure and none of the behaviour. Caps
// take the defaults in main.bicep.
param bulkDownloadsQueue = ''
param bulkCleanupSchedule = ''
param deployBulkDownloadPoisonAlert = false

// ── Cost ──────────────────────────────────────────────────────────────────────────────────────
// account and no second search service, but does carry a plan, Cosmos and the private endpoints.
param budgetAmount = 400

param contactEmails = [
  'daniel@digitalspace.ca'
  'Daniel.T.Truong@gov.bc.ca'
]

// ── Track team sync ───────────────────────────────────────────────────────────────────────────
// Same job as test. Secrets come from OpenShift `demi-app-secrets` through deploy-infra.sh.
param trackApiBase = 'https://epictrack-api-c8b80a-prod.apps.gold.devops.gov.bc.ca'
param trackClientId = 'demi-track-reader'
param roleSyncClientId = 'demi-role-sync'
param trackClientSecret = readEnvironmentVariable('TRACK_CLIENT_SECRET')
param roleSyncClientSecret = readEnvironmentVariable('ROLE_SYNC_CLIENT_SECRET')

// ── eagle-notify ──────────────────────────────────────────────────────────────────────────────
// Empty until eagle-notify is deployed in prod: the push stays dark and no notification claim is
// taken, so wiring it later still announces every published Update.
param notifyApiBase = ''
param notifyApiKey = readEnvironmentVariable('NOTIFY_API_KEY', '')

// ── Public site access curtain ─────────────────────────────────────────────────────────────────
// The password POST /api/gate accepts. From OpenShift `demi-app-secrets` through deploy-infra.sh,
// never from this file. The `''` fallback is deliberate, like notifyApiKey: an environment that
// runs no curtain writes no secret, and the route 404s. Whether the SITE shows the gate is the
// boolean ACCESS_GATE in the `public` config document, which eagle-api owns — set both or neither.
param accessGatePassword = readEnvironmentVariable('ACCESS_GATE_PASSWORD', '')

// Nightly 11:00 UTC, an hour after reconcile. Armed 2026-09-05 after Track prod shipped
// /api/v1/projects/team-members.
param syncTeamsSchedule = '0 0 11 * * *'

// ── Devbox ────────────────────────────────────────────────────────────────────────────────────
// Same shape as test: dev-access VM on `snet-servers`, a plain landing-zone subnet with its own
// NSG. Public key only, never committed; deploy-infra.sh sources it, no fallback on purpose.
// Keypair lives in demi-kv-prod (`devbox-ssh-public-key` / `devbox-ssh-private-key`).
param deployDevbox = true
param devboxSubnetId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/c4b0a8-prod-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-prod-vwan-spoke/subnets/snet-servers'
param devboxSshPublicKey = readEnvironmentVariable('DEVBOX_SSH_PUBLIC_KEY')
