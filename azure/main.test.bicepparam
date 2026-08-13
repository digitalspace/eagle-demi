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
param minioAccessKey = readEnvironmentVariable('MINIO_ACCESS_KEY', '')
param minioSecretKey = readEnvironmentVariable('MINIO_SECRET_KEY', '')

// Landing-zone subnets in c4b0a8-test-networking. The PE subnet mirrors dev's. App Service VNet
// integration uses snet-app-service, NOT c4b0a8-test-cond-ext-webapp-subnet — that one is claimed
// by asp-condition-extractor through a service-association link (allowDelete: false), and a
// delegated subnet carries one plan's integration at a time.
param privateEndpointSubnetId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-test-vwan-spoke/subnets/c4b0a8-test-cond-ext-pe-subnet'
param appServiceSubnetId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-test-vwan-spoke/subnets/snet-app-service'

param contactEmails = [
  'daniel@digitalspace.ca'
]
