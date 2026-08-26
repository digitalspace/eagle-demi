using './main.bicep'

// Test-subscription (staging) environment: c4b0a8-test-rg in c4b0a8-test
// (7897ceb1-9a86-4639-87d7-7f9ff67142b3). Deploy by hand:
//   MINIO_ACCESS_KEY=… MINIO_SECRET_KEY=… az deployment group create \
//     -g c4b0a8-test-rg --subscription 7897ceb1-9a86-4639-87d7-7f9ff67142b3 \
//     -f azure/main.bicep -p azure/main.test.bicepparam
// Credentials come from the 6cdc9e-test secret `nr-object-store-credential`
// (user_account / password) — never committed; this repo is public.

param environmentName = 'test'
param location = 'canadacentral'

// Direct-to-NRS object store. asnpnn/ozwdez, NOT the "test bucket" zdspnb: the corpus (92,472
// objects, 257 GB) exists ONLY under asnpnn/ozwdez/, zdspnb holds zero objects under any DEMI
// prefix, and eagle-api on OpenShift TEST reads asnpnn too (its eagle-api-minio-keys secret).
// Measured 2026-08-11 before the dev teardown; the store is NRS-owned and outlives any Azure
// environment. Credentials come from the 6cdc9e-test secret `eagle-api-minio-keys`.
param minioHost = 'nrs.objectstore.gov.bc.ca'
param minioBucketName = 'asnpnn'
param minioKeyPrefix = 'ozwdez'
// No second argument to readEnvironmentVariable, deliberately. With a `''` fallback a forgotten
// export resolves to empty and the deploy writes that over the live credential — silently, because
// the app settings collection is a whole-collection PUT and what-if masks @secure() values as
// "*******" in BOTH before and after. Without the fallback bicep fails the build instead.
param minioAccessKey = readEnvironmentVariable('MINIO_ACCESS_KEY')
param minioSecretKey = readEnvironmentVariable('MINIO_SECRET_KEY')

// Same rule, and use ./scripts/deploy-infra.sh rather than exporting these by hand — it sources
// all four from OpenShift, which is the source of truth for every credential here.
//
// NOT from the live app settings. Reading the app you are about to deploy feeds a corrupted value
// straight back into itself, and there is no rollback: ARM does not retain @secure() parameters.
// That is not hypothetical — on 2026-08-13 both keys below were destroyed exactly that way, and
// only MinIO survived, because OpenShift held an authoritative copy of it.
//
// ADMIN_API_KEY is the break-glass sysadmin credential the extraction host presents;
// DOCLING_API_KEY is outbound to docling-serve. Blanking either fails closed.
param adminApiKey = readEnvironmentVariable('ADMIN_API_KEY')
param doclingApiKey = readEnvironmentVariable('DOCLING_API_KEY')

// The map explorer renders the wildfire aggregate. Prod publishes no enrichment.
param enrichmentSources = 'wildfire'

// TEST, not dev. src/seed/sources.js defaults to the eagle-DEV instance when this is unset, so
// leaving it out of the template does not merely lose a setting — it repoints staging's seed at
// dev data with nothing logged.
param eagleApiBase = 'https://eagle-test.apps.silver.devops.gov.bc.ca/api/public'

// The nightly Eagle drift report and the alert that reads its one output line. Both, or neither:
// the schedule is what writes the line, the bool is what watches for it. NCRONTAB, six fields —
// the leading 0 is SECONDS, which is what separates it from a five-field crontab.
//
// 09:00 UTC is the middle of the night in Pacific time (02:00 PDT, 01:00 PST) and an hour ahead of
// prod, so the two environments never run the same report against the same upstream at once — test
// reads PROD eagle-api, because its corpus was seeded from prod.
param reconcileSchedule = '0 0 9 * * *'
param deployReconcileDriftAlert = true

// ── TWO VALUES A HUMAN FILLS IN, both commented out because a wrong value is worse than none ──
//
// The browser origins allowed to call the API.
//
// `siteConfig.appSettings` is a whole-collection PUT, so whatever stands here is what CORS_ORIGIN
// becomes on the running demi-api-test. An origin missing from this list is an origin whose every
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
// — including deploy-api-web-app, which never runs because it consumes foundry's outputs.
param deployFoundryPrivateEndpoint = false

// Landing-zone subnets in c4b0a8-test-networking. The PE subnet mirrors dev's. App Service VNet
// integration uses snet-app-service, NOT c4b0a8-test-cond-ext-webapp-subnet — that one is claimed
// by asp-condition-extractor through a service-association link (allowDelete: false), and a
// delegated subnet carries one plan's integration at a time.
param privateEndpointSubnetId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-test-vwan-spoke/subnets/c4b0a8-test-cond-ext-pe-subnet'
param appServiceSubnetId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-test-vwan-spoke/subnets/snet-app-service'

// Both, deliberately. These carry the audit-drop and ingestion-quota alerts, and a gap in the
// audit trail reaching exactly one mailbox is a single point of failure. Replace with a team
// destination when there is one.
param contactEmails = [
  'daniel@digitalspace.ca'
  'Daniel.T.Truong@gov.bc.ca'
]

// EVERY VISITOR SHARES THIS ONE BUCKET IN TEST, so it is a circuit breaker rather than a per-caller
// limit. eagle-public reaches demi-api through rproxy (the interim same-origin transport), rproxy
// sets no `X-Forwarded-For` at all, and App Service appends the connecting address — so
// `callerIp` is rproxy's egress address on every request. At the 300 default that is 5 requests per
// second for the whole site, and eagle-public searches as you type.
//
// The real per-IP control is rproxy's own `limit_req zone=api_search` (10 r/s sustained, burst 20),
// which keys on the client address and is correct. REVERT THIS TO THE DEFAULT when the direct
// `demi.eao.gov.bc.ca` transport replaces the proxy hop and this API stops being reached through a
// proxy at all.
//
// WHAT IT ALSO DOES, said plainly: this is ONE setting serving TWO paths. DEMI's own frontend calls
// this API directly, cross-origin, at the `azurewebsites.net` host — inbound is public, there are no
// `ipSecurityRestrictions`, and for those callers `callerIp` resolves to the real client address.
// So the same raise loosens the per-IP ceiling on the direct path 20x, from 300/min to 6000/min,
// with no proxy in front of it. Accepted for TEST because the value is a circuit breaker and the
// direct path there serves one internal frontend; it is NOT a value to carry to prod. The durable
// fix is NOT a smarter limiter — it is moving the enforcement point. Front Door's WAF rate limit
// keys on the SOCKET IP and offers no header-based key (`groupBy` accepts SocketAddr, GeoLocation,
// None, Asn, Ja4 — `ClientAddr` is the Application Gateway flavour, and `RemoteAddr` is a match
// variable that cannot be a key), so it sees real visitors only once Front Door is what the browser
// connects to. Today the OpenShift router terminates the client's TLS and Front Door sits behind
// rproxy, so a WAF rule there would limit rproxy's egress — this same defect, one layer out.
//
// DO NOT "FIX" THIS BY READING THE LEFTMOST X-Forwarded-For ENTRY. It fails whichever way App
// Service behaves: if it appends, the leftmost is caller-supplied and the key becomes
// attacker-controlled on the still-public direct path; if it overwrites, the change does nothing.
// The variant that works needs `X-Real-IP $remote_addr` from the proxy AND the direct path closed —
// and the direct path cannot be closed while DEMI's frontend calls this host from the browser.
param rateLimitMaxRequests = 6000
