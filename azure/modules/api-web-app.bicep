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

@description('Cosmos DB Connection String')
@secure()
param mongodbConnectionString string

@description('Azure AI Search endpoint, e.g. https://demi-search-dev.search.windows.net. Empty disables chunk search rather than failing it.')
param searchEndpoint string = ''

@description('Azure AI Search index holding document chunks')
param searchIndex string = 'demi-chunks'

@description('Subnet ID for Virtual Network Integration')
param apiSubnetId string = ''

@description('Keycloak base URL for this environment (dev/test/prod loginproxy)')
param keycloakUrl string = environmentName == 'prod'
  ? 'https://loginproxy.gov.bc.ca/auth'
  : (environmentName == 'test' ? 'https://test.loginproxy.gov.bc.ca/auth' : 'https://dev.loginproxy.gov.bc.ca/auth')

@description('Keycloak realm')
param keycloakRealm string = 'eao-epic'

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
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
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
  identity: {
    type: 'SystemAssigned'
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
        // Azure Cosmos DB Connection
        {
          name: 'COSMOSDB_URI'
          value: mongodbConnectionString
        }
        {
          name: 'COSMOSDB_DATABASE'
          value: 'epic'
        }
        {
          name: 'MONGODB_URI'
          value: mongodbConnectionString
        }
        {
          name: 'MONGODB_DATABASE'
          value: 'epic'
        }
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
output apiPrincipalId string = apiWebApp.identity.principalId
