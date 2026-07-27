// Azure App Service Module for DEMI Node.js REST API
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

@description('Typesense Host Endpoint URL')
param typesenseUrl string

@description('Typesense API Key')
@secure()
param typesenseApiKey string

var apiAppName = 'demi-api-${environmentName}'
var appServicePlanName = 'demi-plan-${environmentName}'
var storageAccountName = 'demistg${environmentName}${uniqueString(resourceGroup().id)}'

// Storage Account for API logs and temporary persistence
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

// App Service Plan (Basic B1 Linux)
resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  tags: tags
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  properties: {
    reserved: true // Linux worker
  }
}

// Azure Web App (Node.js 22 Express API)
resource apiWebApp 'Microsoft.Web/sites@2023-12-01' = {
  name: apiAppName
  location: location
  tags: tags
  kind: 'app,linux'
  properties: {
    serverFarmId: appServicePlan.id
    siteConfig: {
      linuxFxVersion: 'NODE|22'
      appCommandLine: 'node src/index.js'
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${apiStorage.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${apiStorage.listKeys().keys[0].value}'
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~22'
        }
        // MongoDB Connection
        {
          name: 'MONGODB_URI'
          value: mongodbConnectionString
        }
        {
          name: 'MONGODB_DATABASE'
          value: 'epic'
        }
        // OpenShift MinIO Connection
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
        // Typesense Search Connection
        {
          name: 'TYPESENSE_URL'
          value: typesenseUrl
        }
        {
          name: 'TYPESENSE_API_KEY'
          value: typesenseApiKey
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
          'https://demi-frontend-dev.azurewebsites.net'
          '*'
        ]
      }
    }
  }
}

output apiWebAppName string = apiWebApp.name
output apiWebAppHostName string = apiWebApp.properties.defaultHostName
