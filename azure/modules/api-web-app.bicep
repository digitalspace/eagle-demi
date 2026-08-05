// Azure App Service Module for DEMI Node.js REST API (Serverless Azure Function)
@description('Location for Azure Web App resources')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('OpenShift MinIO Endpoint URL')
param minioHost string

@description('OpenShift MinIO Access Key')
@secure()
param minioAccessKey string

@description('OpenShift MinIO Secret Key')
@secure()
param minioSecretKey string

@description('Azure AI Search endpoint, e.g. https://demi-search-dev.search.windows.net. Empty disables chunk search rather than failing it.')
param searchEndpoint string = ''

@description('Azure AI Search index holding document chunks')
param searchIndex string = 'demi-chunks'

@description('Foundry account endpoint for the AI summariser. Empty leaves the summary panel off rather than failing search.')
param foundryEndpoint string = ''

@description('Foundry model deployment name for the AI summariser')
param foundryDeployment string = ''

@description('Master switch for the AI summariser. Off by default — the endpoint does not exist until the Foundry account is provisioned, and a half-working summariser is worse than an absent one.')
param summaryEnabled bool = false

@description('Subnet ID for Virtual Network Integration')
param apiSubnetId string = ''

@description('Resource ID of the user-assigned managed identity the app runs as')
param identityId string

@description('Client ID of that identity. DefaultAzureCredential cannot pick between several, so AZURE_CLIENT_ID names the one to use.')
param identityClientId string

@description('Cosmos DB for NoSQL document endpoint. Keyless — the identity above is the credential.')
param cosmosEndpoint string = ''

@description('Cosmos database holding the DEMI containers')
param cosmosDatabase string = 'demi'

@description('Object storage the API reads documents from. minio in dev; azure once Phase 3b lands.')
@allowed([ 'minio', 'azure' ])
param storageBackend string = 'minio'

@description('MinIO bucket holding the document corpus')
param minioBucketName string = 'eagle-demi'

@description('Key prefix within that bucket')
param minioKeyPrefix string = ''

@description('Admin credential for the ingest and maintenance endpoints')
@secure()
param adminApiKey string = ''

@description('Credential the extraction host presents when posting chunks')
@secure()
param doclingApiKey string = ''

@description('Keycloak base URL for this environment (dev/test/prod loginproxy)')
param keycloakUrl string = environmentName == 'prod'
  ? 'https://loginproxy.gov.bc.ca/auth'
  : (environmentName == 'test' ? 'https://test.loginproxy.gov.bc.ca/auth' : 'https://dev.loginproxy.gov.bc.ca/auth')

@description('Keycloak realm')
param keycloakRealm string = 'eao-epic'

@description('Application Insights connection string. Empty disables telemetry, which is the local-development case.')
param appInsightsConnectionString string = ''

var apiAppName = 'demi-api-${environmentName}'
var appServicePlanName = 'demi-plan-${environmentName}'
var storageAccountName = take('demistg${environmentName}${uniqueString(resourceGroup().id)}', 24)

// Storage Account for API logs and Function host persistence
resource apiStorage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

// App Service Plan (Consumption Y1 Serverless Plan for auto-scaling & $0 idle cost)
resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  tags: tags
  // B1, not Y1/Dynamic. Consumption cannot hold a warm worker or integrate with a VNet the way
  // this app needs, and every operational note in the repo — the 224 MB heap ceiling the scripts
  // run under, the warm worker that serves a stale build until the app is stopped and started —
  // describes a B1 instance. The live plan has always been B1; this said Dynamic.
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  properties: {
    reserved: true // Linux worker
  }
}

// Azure Function App (Node.js 22 Express API via @azure/functions in Serverless Consumption mode)
resource apiWebApp 'Microsoft.Web/sites@2023-12-01' = {
  name: apiAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  // USER-assigned, not system-assigned. The identity outlives the app, so a redeploy does not
  // invalidate its Cosmos, Search and Storage role assignments — and it can be granted access
  // BEFORE the app exists, which a system-assigned principal cannot. This block said
  // 'SystemAssigned' while the live app has always run as demi-identity-dev, and the comment on
  // SEARCH_ENDPOINT below already described it correctly.
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    serverFarmId: appServicePlan.id
    virtualNetworkSubnetId: !empty(apiSubnetId) ? apiSubnetId : null
    siteConfig: {
      linuxFxVersion: 'NODE|22'
      vnetRouteAllEnabled: !empty(apiSubnetId)
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${apiStorage.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${apiStorage.listKeys().keys[0].value}'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~22'
        }
        {
          name: 'WEBSITE_RUN_FROM_PACKAGE'
          value: '1'
        }
        // Azure Monitor. The Functions host reads this to emit request, dependency and exception
        // telemetry with no code involved; `api/index.js` reads the same variable to decide whether
        // to start the OpenTelemetry distro that carries the winston lines.
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsightsConnectionString
        }
        // The distro in application code owns instrumentation. Leaving the platform agent on as
        // well means two SDKs instrumenting the same process, which double-counts telemetry.
        {
          name: 'APPLICATIONINSIGHTS_ENABLE_AGENT'
          value: 'false'
        }
        // The identity above, named. DefaultAzureCredential has no way to choose between several
        // user-assigned identities on one app, so without this it fails to authenticate at all.
        {
          name: 'AZURE_CLIENT_ID'
          value: identityClientId
        }
        // Cosmos DB for NoSQL. Keyless, so there is no connection string — just where it is and
        // which database. COSMOS_DATABASE is the older name and is still read as a fallback.
        {
          name: 'COSMOS_ENDPOINT'
          value: cosmosEndpoint
        }
        {
          name: 'COSMOS_NOSQL_DATABASE'
          value: cosmosDatabase
        }
        {
          name: 'COSMOS_DATABASE'
          value: cosmosDatabase
        }
        // No Cosmos DB for MongoDB API settings. COSMOSDB_URI, COSMOSDB_DATABASE, MONGODB_URI and
        // MONGODB_DATABASE all carried the same connection string and the same 'epic' database, and
        // all four went with the Mongo data layer at Phase 8. The NoSQL account is keyless, so its
        // settings are COSMOS_ENDPOINT plus COSMOS_NOSQL_DATABASE and there is no secret to wire.
        // MinIO Storage Connection
        {
          name: 'MINIO_HOST'
          value: minioHost
        }
        {
          name: 'MINIO_ACCESS_KEY'
          value: minioAccessKey
        }
        {
          name: 'MINIO_SECRET_KEY'
          value: minioSecretKey
        }
        {
          name: 'MINIO_BUCKET_NAME'
          value: minioBucketName
        }
        {
          name: 'MINIO_KEY_PREFIX'
          value: minioKeyPrefix
        }
        {
          name: 'MINIO_PORT'
          value: '443'
        }
        {
          name: 'MINIO_USE_SSL'
          value: 'true'
        }
        // Which object store the API reads. Flipping this to 'azure' is the Phase 3b cutover and
        // needs the blob account deployed and the corpus copied first.
        {
          name: 'STORAGE_BACKEND'
          value: storageBackend
        }
        // Credentials for the write paths. Empty here on purpose: these are set out of band rather
        // than committed, and a template that carried real values would put them in deployment
        // history. ADMIN_API_KEY -- not DOCLING_API_KEY -- is what the admin endpoints check.
        {
          name: 'ADMIN_API_KEY'
          value: adminApiKey
        }
        {
          name: 'DOCLING_API_KEY'
          value: doclingApiKey
        }
        // Azure AI Search — Deep Search over extracted document text. No key: the service has
        // disableLocalAuth, so the app authenticates with the same user-assigned identity it uses
        // for Cosmos. When SEARCH_ENDPOINT is absent the chunk dataset degrades to empty results
        // and says so once, rather than failing the whole search endpoint.
        {
          name: 'SEARCH_ENDPOINT'
          value: searchEndpoint
        }
        {
          name: 'SEARCH_INDEX'
          value: searchIndex
        }
        // AI summariser — step 5 of the search pipeline, privileged-only. No key here either: the
        // Foundry account has disableLocalAuth and the app calls it with the same user-assigned
        // identity. Retrieval is unaffected by all three of these; with SUMMARY_ENABLED false the
        // summary endpoint returns `{summary: null}` and the results columns are untouched.
        {
          name: 'SUMMARY_ENABLED'
          value: string(summaryEnabled)
        }
        {
          name: 'FOUNDRY_ENDPOINT'
          value: foundryEndpoint
        }
        {
          name: 'FOUNDRY_DEPLOYMENT'
          value: foundryDeployment
        }
        // Keycloak / SSO — MUST be pinned per environment. Without these the API falls
        // back to src/config.js defaults, which point at the DEV realm, so a dev-realm
        // token would be accepted as admin in test and prod.
        {
          name: 'KEYCLOAK_URL'
          value: keycloakUrl
        }
        {
          name: 'KEYCLOAK_REALM'
          value: keycloakRealm
        }
        {
          name: 'KEYCLOAK_ENABLED'
          value: 'true'
        }
        {
          name: 'SSO_ISSUER'
          value: '${keycloakUrl}/realms/${keycloakRealm}'
        }
        {
          name: 'SSO_JWKSURI'
          value: '${keycloakUrl}/realms/${keycloakRealm}/protocol/openid-connect/certs'
        }
        // Browser CORS allowlist — unset previously meant "reflect any origin".
        {
          name: 'CORS_ORIGIN'
          value: 'https://demi-frontend-${environmentName}.azurewebsites.net'
        }
        // Build & Deployment Configuration
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'false'
        }
        {
          name: 'WEBSITE_HTTPLOGGING_RETENTION_DAYS'
          value: '3'
        }
        // Oryx must not build on deploy: the zip already carries node_modules, and letting the
        // platform rebuild it both slows the deploy and can resolve different versions.
        {
          name: 'ENABLE_ORYX_BUILD'
          value: 'false'
        }
        // Route ALL outbound traffic through the integrated subnet, and resolve DNS through Azure
        // — without both, the private endpoints for Cosmos and Search resolve to public IPs the
        // app cannot reach.
        {
          name: 'WEBSITE_VNET_ROUTE_ALL'
          value: '1'
        }
        {
          name: 'WEBSITE_DNS_SERVER'
          value: '168.63.129.16'
        }
        {
          name: 'AzureWebJobsFeatureFlags'
          value: 'EnableWorkerIndexing'
        }
      ]
      cors: {
        allowedOrigins: [
          'https://portal.azure.com'
          'https://demi-frontend-${environmentName}.azurewebsites.net'
          'https://demi-frontend-swa-${environmentName}.azurestaticapps.net'
        ]
      }
    }
  }
}

output apiWebAppName string = apiWebApp.name
output apiWebAppHostName string = apiWebApp.properties.defaultHostName
// The app has no principal of its own any more — it runs as the user-assigned identity, whose
// principal the caller already has from `identity.bicep`.
