using './main.bicep'

// Test-subscription (staging) environment: c4b0a8-test-rg in c4b0a8-test
// (7897ceb1-9a86-4639-87d7-7f9ff67142b3). Deploy by hand:
//   ./scripts/deploy-infra.sh test --what-if
// No credential is exported first: every one of them lives in `demi-kv-test` and the app resolves
// it by reference — never committed; this repo is public.

param environmentName = 'test'
param location = 'canadacentral'

// Direct-to-NRS object store. asnpnn/ozwdez, NOT the "test bucket" zdspnb: the corpus (92,472
// objects, 257 GB) exists ONLY under asnpnn/ozwdez/, zdspnb holds zero objects under any DEMI
// prefix, and eagle-api on OpenShift TEST reads asnpnn too (its eagle-api-minio-keys secret).
// Measured 2026-08-11 before the dev teardown; the store is NRS-owned and outlives any Azure
// environment. Only the coordinates are here — the credentials are `minio-access-key` and
// `minio-secret-key` in `demi-kv-test`, and no parameter carries either value.
param minioHost = 'nrs.objectstore.gov.bc.ca'
param minioBucketName = 'asnpnn'
param minioKeyPrefix = 'ozwdez'

// The vault holds admin-api-key, track-client-secret, role-sync-client-secret, docling-api-key,
// minio-access-key, minio-secret-key, analytics-shared-header and analytics-audit-header, plus the
// two named here. No value for any of them passes through this file: they are set once by hand from
// the devbox with `az keyvault secret set` and the app resolves them by reference. Naming one here
// says it has been set — deploy-infra.sh checks the live vault against this list before deploying.
param optionalSecretNames = [
  'notify-api-key'
  'edge-secret'
  // The password POST /api/gate accepts. Optional because prod runs ungated; named here because
  // test does, and an unnamed one leaves the route answering 404 for everyone.
  'access-gate-password'
  // The secret sync's ServiceAccount tokens. Two, because demi-kv-test is the nonprod vault and
  // serves 6cdc9e-dev as well as 6cdc9e-test — same `dev-` prefix as every dev entry in
  // src/secret-sync/mapping.json.
  'openshift-token-test'
  'dev-openshift-token'
]

// The namespaces demi-secret-sync-test owns. Both nonprod namespaces, and prod is deliberately not
// one of them: the app can only reach what its token opens, and it holds no prod token.
param syncNamespaces = '6cdc9e-dev,6cdc9e-test'

// The map explorer renders the wildfire aggregate. Prod publishes no enrichment.
param enrichmentSources = 'wildfire'

// TEST, not dev. src/seed/sources.js defaults to the eagle-DEV instance when this is unset, so
// leaving it out of the template does not merely lose a setting — it repoints staging's seed at
// dev data with nothing logged.
param eagleApiBase = 'https://eagle-test.apps.silver.devops.gov.bc.ca/api/public'

// OFF IN TEST, both halves. `eagleApiBase` above is eagle-TEST while this environment's corpus was
// seeded from PROD Eagle, so a nightly diff would report the difference between two unrelated
// corpora and alert every night on it. Run it by hand here with EAGLE_API_BASE overridden — see
// README "Reconcile". Prod runs both, where the two sides are the same Eagle.
param reconcileSchedule = ''
param deployReconcileDriftAlert = false

// ── Bulk download ─────────────────────────────────────────────────────────────────────────────
// Test runs it first. The caps (documents, bytes, pending jobs, per day, retention) take the
// defaults in main.bicep — set one here only to override it, so one place holds each number. Naming
// the queue also turns the nightly zip sweep on: api-function-flex.bicep supplies its schedule, so
// bulkCleanupSchedule is set here only to move the hour.
param bulkDownloadsQueue = 'bulk-downloads'
param deployBulkDownloadPoisonAlert = true
// Left at the default. The 2026-09-08 A/B on test (docs/bulk-download-performance.md) showed no
// gain from concurrent fetches — the archive stream backpressures on the single-connection upload,
// so extra read buffers only fill and wait. Stays at 1 until the upload path is parallel.
param bulkFetchConcurrency = 1

// ── Chunk parent-field re-stamping ────────────────────────────────────────────────────────────
// On here. This is the environment eagle-api pushes into, and it is where the inline walk timed
// the 10-second push out on large documents and earned a duplicate push.
param chunkRestampQueue = 'chunk-restamp'

// ── TWO VALUES A HUMAN FILLS IN, both commented out because a wrong value is worse than none ──
//
// The browser origins allowed to call the API.
//
// `siteConfig.appSettings` is a whole-collection PUT, so whatever stands here is what CORS_ORIGIN
// becomes on the running demi-api-fc-test. An origin missing from this list is an origin whose every
// request fails — and it fails in the browser, not in the deploy. On 2026-08-15 the Front Door
// frontend was published while this named only the old App Service: the app loaded fine and then
// failed /api/config and both /api/search calls with "No 'Access-Control-Allow-Origin' header".
// Nothing in the deploy reported a problem, because nothing in the deploy was wrong.
//
// An ARRAY because a cutover has two frontends at once. It held both from step 5 until step 8; the
// old App Service entry came out when that app was decommissioned. The AFD hostname carries a
// deploy-time hash AND zone code, so it is read from the eagle-search deployment output, never
// composed.
param frontendHostNames = [
  'demi-frontend-test-eaa9cyfydsb0ejet.a02.azurefd.net'
  // eagle-demi-admin's Front Door endpoint, read from eagle-edge's edgeEndpointHostNames output.
  'demi-admin-test-hbf7cfh7ggfhf4gf.a02.azurefd.net'
]
//
// Object id (not app id) of the demi-cicd-test user-assigned identity. Without it the identity gets
// no role on the new storage account: `az storage blob upload-batch` 403s, and the static-website
// enable fails before that. Website Contributor covered the App Service publish and covers nothing
// here. Read from `az identity show -g c4b0a8-test-rg -n demi-cicd-test --query principalId`;
// clientId is f24611b4-9592-4547-93d8-0b15dfd4f2c2, which is NOT this value.
param frontendUploaderPrincipalId = '39682a03-8b4c-4b05-84c6-b8e06c0a21a4'

// pe-demi-foundry-test already exists, connection plsc-demi-foundry-test, state Approved. Leaving
// this true re-PUTs it, which loses a race against the account PUT and fails the whole deployment
// — including deploy-api-function-flex, which never runs because it consumes foundry's outputs.
param deployFoundryPrivateEndpoint = false

// Landing-zone subnet in c4b0a8-test-networking, carrying the inbound private endpoints.
param privateEndpointSubnetId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-test-vwan-spoke/subnets/c4b0a8-test-cond-ext-pe-subnet'

// The Flex app's own subnet, delegated to `Microsoft.App/environments` with an NSG attached (both
// demanded by policy). The private-endpoint subnet above cannot host it.
param apiFlexSubnetId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-test-vwan-spoke/subnets/snet-demi-func-fc1-test'

// Both, deliberately. These carry the audit-drop and ingestion-quota alerts, and a gap in the
// audit trail reaching exactly one mailbox is a single point of failure. Replace with a team
// destination when there is one.
param contactEmails = [
  'daniel@digitalspace.ca'
  'Daniel.T.Truong@gov.bc.ca'
]

param linkBaseUrl = 'https://test.projects.eao.gov.bc.ca'

// azp values: frontend client id + eagle-admin-console; measured against realm eao-epic.
// One entry, because both are the same client — this file sets no keycloakClientId, so the API
// takes main.bicep's 'eagle-admin-console' default, and frontend/public/env.js names the same id.
param allowedClients = 'eagle-admin-console'

// Measured 2026-08-28 on a test-realm user token: aud contains 'account'. Prod not measured.
param ssoAudience = 'account'

// The rproxy egress addresses as APIM reports them (`callerIp` on the App Insights request row
// for a request made through eagle-test.apps.silver.devops.gov.bc.ca/demi-search; measured
// 2026-09-02; .122 seen 2026-09-05 through test.projects.eao.gov.bc.ca). With these trusted, the
// anonymous bulk-download quota keys on the browser hop.
// An address missing here only puts that proxy's visitors back on one shared key.
param trustedProxyIps = '142.34.194.121,142.34.194.122,142.34.194.123,142.34.194.124'

// The secret the eagle-edge rule set stamps on origin requests is the vault's `edge-secret`, named
// in optionalSecretNames above. Both sides read the SAME value — rotate it in eagle-edge and in the
// vault together, or callers fall back to the shared anonymous quota key for a while.

// ── Track team sync ───────────────────────────────────────────────────────────────────────────
// The nightly job that mints `project:<id>` realm roles from Track's team-members endpoint.
// Both client secrets are vault-only (`track-client-secret`, `role-sync-client-secret`).
param trackApiBase = 'https://epictrack-api-c8b80a-test.apps.gold.devops.gov.bc.ca'
param trackClientId = 'demi-track-reader'
param roleSyncClientId = 'demi-role-sync'

// ── eagle-notify ──────────────────────────────────────────────────────────────────────────────
// Where a published Update is announced. The key is the vault's `notify-api-key`, named in
// optionalSecretNames above.
param notifyApiBase = 'https://notify-api-test.azurewebsites.net'

// ── Public site access curtain ─────────────────────────────────────────────────────────────────
// The password POST /api/gate accepts is the vault's `access-gate-password`, named in
// optionalSecretNames above. Whether the SITE shows the gate is the boolean ACCESS_GATE in the
// `public` config document, which eagle-api owns — set both or neither.

// Nightly 10:00 UTC. Armed 2026-09-02 after the first live run against epictrack-api-c8b80a-test.
param syncTeamsSchedule = '0 0 10 * * *'

// APIM Consumption in front of demi-api-fc-test. Test only — prod stays off until this proves out.
// The gateway secret is created out of band before this deploy, through the ARM control plane —
// the data plane is Forbidden on this private-endpoint-only vault, and policy demands
// contentType/expiry on a data-plane write:
//   az rest --method PUT --url "https://management.azure.com/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/<vault>/secrets/apim-gateway-secret?api-version=2023-07-01" --body '{"properties":{"value":"<random>"}}'
param deployApim = true

// ── eagle-analytics ───────────────────────────────────────────────────────────────────────────
// Filled in from the eagle-analytics deployment's outputs; none is composed — a Function App host
// name can carry a regional suffix, and the DCR endpoint and immutable ID are Azure-generated:
//   analyticsBackendUrl          <- apiHostName, prefixed https://
//   analyticsDcrEndpoint         <- eventsDcrEndpoint
//   analyticsDcrImmutableId      <- eventsDcrImmutableId
//   analyticsWorkspaceCustomerId <- analyticsWorkspaceCustomerId
// The first publishes /analytics on demi-apim-test; the DCR pair moves audit rows to EagleAudit_CL;
// the workspace GUID makes GET /admin/audit read those rows beside the old DemiAudit_CL ones.
param analyticsBackendUrl = 'https://analytics-api-fc-test.azurewebsites.net'
param analyticsDcrEndpoint = 'https://analytics-dcr-test-akm7-canadacentral.logs.z1.ingest.monitor.azure.com'
param analyticsDcrImmutableId = 'dcr-f14d018cfbcf4b59945cbfeb0ce09a2e'
param analyticsWorkspaceCustomerId = '3d9b7393-bec2-4f06-bb5f-87887b72c4ef'
// The two header values are not parameters: APIM reads them from `demi-kv-test` as
// analytics-shared-header and analytics-audit-header. eagle-analytics reads the same two secrets as
// APIM_SHARED_HEADER_VALUE and AUDIT_SHARED_HEADER_VALUE, so a rotation is one new secret version
// and a recycle on each side rather than a redeploy of two repositories.

// The dev-access VM, on `snet-servers` — a plain landing-zone subnet with its own NSG, not one of
// the delegated ones above. The key is a PUBLIC key and never committed; nothing SSHes in, so a
// throwaway is fine. No fallback, same rule as the six above: an empty value here would reach
// Microsoft.Compute, which refuses a Linux VM with `disablePasswordAuthentication` and no key —
// failing the whole infra apply midway instead of failing the build. deploy-infra.sh sources it.
param deployDevbox = true
param devboxSubnetId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-test-vwan-spoke/subnets/snet-servers'
param devboxSshPublicKey = readEnvironmentVariable('DEVBOX_SSH_PUBLIC_KEY')

// Pinned to the live budget period — an existing budget rejects startDate updates.
param budgetStartDate = '2026-08-01'

// Same probe as prod, test-shaped: monitors the real user path and its executions keep one
// Flex instance warm — cheaper than alwaysReady and doubles as monitoring.
param availabilityUrl = 'https://eagle-test.apps.silver.devops.gov.bc.ca/demi-search/search?dataset=Document&keywords=assessment&pageSize=1'
