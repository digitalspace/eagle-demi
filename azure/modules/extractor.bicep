// Extraction: a storage queue of document ids, and a Function App that drains it.
//
// WHY A FUNCTION APP AND NOT CONTAINER APPS. The design called for a container app with a KEDA
// queue scaler, which was the right shape when extraction meant docling on a GPU. The text path
// needs one Python wheel and no GPU, and Container Apps would need a container registry and a
// Container Apps environment — neither exists in this resource group. A Function App scales to
// zero, bills per execution, deploys from a zip exactly like `demi-api` does, and has a
// queue trigger built in. It is the smaller thing that does the same job.
//
// FLEX CONSUMPTION (FC1), not the classic Y1 Consumption plan. Y1 fails here with
// `LinuxDynamicWorkersNotAllowedInResourceGroup`: this resource group already holds non-dynamic
// Linux plans (`demi-plan-dev`, `demi-frontend-plan-dev`), and Azure will not mix Linux dynamic
// workers with them. Flex Consumption is a different plan type without that restriction, still
// scales to zero, and is available in canadacentral.
//
// The OCR half, when it is built, WILL need Container Apps and a serverless GPU. That is a separate
// deployment with a separate cost, and nothing here has to change to accommodate it: it drains the
// same queue.
//
// NO VNET INTEGRATION, deliberately. The extractor talks to eagle-api over the public internet and
// to `eagle-search-api` over public HTTPS. Neither is inside the VNet, so joining it would add a
// subnet and a dependency for no reachability gain. The search service's private endpoint is the
// App Service's problem, not this one's.

// HOW IT IS DEPLOYED, and the traps that do not fail loudly. This module is NOT wired into
// `azure/main.bicep` — that template is the test estate's root and this is deployed on its own:
//
//   az deployment group create -g rg-demi-prod -f azure/modules/extractor.bicep \
//     -p location=canadacentral environmentName=prod \
//        ingestUrl=https://eagle-search-api-prod.azurewebsites.net \
//        eagleApiBase=https://projects.eao.gov.bc.ca appInsightsConnectionString=<conn>
//
// NEVER `ingestKey=<key>` on that command line — it puts a production WRITE credential into argv,
// /proc and shell history, from a public repo. It is `@secure()`, so pass it through a
// `.bicepparam` reading `readEnvironmentVariable(...)` — the shape
// eagle-search/azure/main.searchprod.bicepparam uses for the same key, as EAGLE_SEARCH_INGEST_KEY.
//
// KNOWN, AND DELIBERATE FOR PHASE 1: `INGEST_KEY` lands in plain app settings below, and Website
// Contributor — what `azure-deploy-prod.yaml` grants `demi-cicd-prod` on this app — carries
// `Microsoft.Web/sites/config/list/action`. So CI can READ that key, and the storage account key,
// from a public repo, gated by the `prod` environment's required reviewer. The workflow header's
// isolation claim is about ARM reach and is true as far as it goes; it does not mean CI holds no
// data credential. FOLLOW-UP: a Key Vault reference `@Microsoft.KeyVault(SecretUri=...)` with
// `Key Vault Secrets User` on this app's own identity removes both that read and the hand-run
// deployment's need to carry the secret at all.
//
// The code then goes up as a zip with `extractor/` AT THE ROOT — function_app.py, extract.py,
// ocr.py, requirements.txt, host.json. Two of the three traps live in that zip rather than here,
// and all three produce an app that starts, reports healthy, and drains nothing: the Flex
// Consumption plan above (never Y1/Dynamic), `host.json` declaring an `extensionBundle` or
// `queueTrigger` is never registered at all, and `messageEncoding: 'none'` because a 24-hex
// ObjectId is valid base64 and decodes silently to 18 bytes of garbage. `extractor/function_app.py`
// carries the last two in full; `extractor/test_extract.py` asserts them.
//
// THE RESOURCES ARE STILL NAMED `eagle-extractor-*`. The code moved repositories, the deployed test
// app did not — renaming here would orphan `eagle-extractor-test` instead of updating it.

@description('Azure region.')
param location string

@description('dev, test or prod. Suffixes every resource name.')
param environmentName string

param tags object = {}

@description('eagle-search base URL — where extracted markdown is posted.')
param ingestUrl string

@description('Shared key for /ingest/markdown. Compared with timingSafeEqual on the far side.')
@secure()
param ingestKey string

@description('eagle-api base URL — where document bytes are downloaded from.')
param eagleApiBase string

param appInsightsConnectionString string

// Storage account names are globally unique, lowercase, and capped at 24 characters, which is why
// this is a hash rather than a readable name.
var storageName = take('eaglextr${environmentName}${uniqueString(resourceGroup().id)}', 24)
var functionName = 'eagle-extractor-${environmentName}'
var planName = 'eagle-extractor-plan-${environmentName}'

// The queue lives in the same account the Function App uses for its own bookkeeping. A second
// account would double the cost and the naming for one queue.
// FOLLOW-UP, tracked rather than silent: this module authenticates to storage with ACCOUNT KEYS —
// `AzureWebJobsStorage` and `DEPLOYMENT_STORAGE_CONNECTION_STRING` below are both connection
// strings — in a repo whose every other service is keyless, and whose `ai-search.bicep` header
// argues for Basic over Free precisely because Free "supports neither a managed identity nor a
// shared private link". Flex Consumption supports identity for both. It came over from eagle-search
// unchanged and this was not the change to rewrite it in, but it must not become the prod pattern
// by default.
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    // TLS 1.2 and no anonymous blob access. The queue is reached with the account key held in app
    // settings, never anonymously.
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

// Document ids waiting to be extracted. One id per message.
resource queue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'extract'
}

// A poison queue is created automatically by the Functions runtime after `maxDequeueCount` failed
// attempts. Declaring it here means it exists from the start and can be alerted on, rather than
// appearing silently the first time a document fails five times.
resource poison 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'extract-poison'
}

// Flex Consumption: no instances when the queue is empty, billed per execution.
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  tags: tags
  kind: 'functionapp'
  sku: { name: 'FC1', tier: 'FlexConsumption' }
  properties: { reserved: true } // Linux
}

// Flex Consumption deploys from a blob container rather than from the site's own filesystem.
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource deployContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'deployment'
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deployContainer.name}'
          authentication: {
            type: 'StorageAccountConnectionString'
            storageAccountConnectionStringName: 'DEPLOYMENT_STORAGE_CONNECTION_STRING'
          }
        }
      }
      // One instance is plenty at the measured arrival rate (~3.6 documents/day). The ceiling is a
      // guard against a backlog drain turning into a surprise bill, not a throughput target.
      //
      // 4096 MB for the CPU, not the memory: Flex instance sizes bundle cores with memory, and 4096
      // is the only size that gets two of them. OCR is the only thing here that needs one — the
      // text path finishes a document in a second. Measured peak RSS on a 21-page scan is ~620 MB.
      scaleAndConcurrency: {
        // 8, not 40. The comment above is the reason: at ~3.6 documents/day one instance does
        // the work, and a ceiling is only a guard if it bounds something. 8 leaves room for a
        // burst — a publish sweep in eagle-admin enqueues one message per document — and still
        // bounds the bill. The 60K-document backfill is `extraction-host/`'s job, not this app's.
        maximumInstanceCount: 8
        instanceMemoryMB: 4096
      }
      runtime: {
        name: 'python'
        version: '3.11'
      }
    }
    siteConfig: {
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'AzureWebJobsStorage', value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}' }
        { name: 'DEPLOYMENT_STORAGE_CONNECTION_STRING', value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}' }
        { name: 'INGEST_URL', value: ingestUrl }
        { name: 'INGEST_KEY', value: ingestKey }
        { name: 'EAGLE_API_BASE', value: eagleApiBase }
        { name: 'EXTRACT_QUEUE', value: queue.name }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
      ]
    }
  }
}

output functionAppName string = functionApp.name
output storageAccountName string = storage.name
output queueName string = queue.name
