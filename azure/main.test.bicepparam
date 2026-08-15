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

// TEST, not dev. src/seed/sources.js defaults to the eagle-DEV instance when this is unset, so
// leaving it out of the template does not merely lose a setting — it repoints staging's seed at
// dev data with nothing logged.
param eagleApiBase = 'https://eagle-test.apps.silver.devops.gov.bc.ca/api/public'

// ── TWO VALUES A HUMAN FILLS IN, both commented out because a wrong value is worse than none ──
//
// The browser origins allowed to call the API. BOTH are listed, and that is the point.
//
// `siteConfig.appSettings` is a whole-collection PUT, so whatever stands here is what CORS_ORIGIN
// becomes on the running demi-api-test. Naming only one frontend breaks the other, in whichever
// direction: dropping the App Service breaks the rollback target that is still serving staging,
// and naming only the App Service breaks the Front Door frontend that is now the real one.
//
// The second is not hypothetical. On 2026-08-15 the AFD frontend was published while this named
// only the App Service, and the deployed app loaded fine and then failed every request —
// /api/config and both /api/search calls blocked with "No 'Access-Control-Allow-Origin' header".
// Nothing in the deploy reported a problem, because nothing in the deploy was wrong.
//
// Drop the App Service entry when it is decommissioned, not before. The AFD hostname carries a
// deploy-time hash AND zone code, so it is read from the eagle-search deployment output, never
// composed.
param frontendHostNames = [
  'demi-frontend-test.azurewebsites.net'
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
