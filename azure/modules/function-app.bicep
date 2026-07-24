// Azure Functions Module for DEMI Node.js REST API
@description('Location for Azure Function App resources')
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

var functionAppName = 'demi-api-${environmentName}'
var appServicePlanName = 'demi-plan-${environmentName}'
var storageAccountName = 'demistg${environmentName}${uniqueString(resourceGroup().id)}'

// Storage Account required by Azure Functions runtime
resource functionStorage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
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

// Consumption App Service Plan ($0 when idle)
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

// Azure Function App (Node.js 20)
resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  properties: {
    serverFarmId: appServicePlan.id
    siteConfig: {
      linuxFxVersion: 'NODE|20'
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${functionStorage.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${functionStorage.listKeys().keys[0].value}'
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~20'
        }
        // MongoDB Connection
        {
          name: 'MONGODB_URI'
          value: mongodbConnectionString
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
      ]
      cors: {
        allowedOrigins: [
          'https://portal.azure.com'
          '*'
        ]
      }
    }
  }
}

output functionAppName string = functionApp.name
output functionAppHostName string = functionApp.properties.defaultHostName
