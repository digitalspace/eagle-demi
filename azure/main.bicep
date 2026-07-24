// Root Bicep Orchestrator for DEMI Azure Infrastructure
targetScope = 'resourceGroup'

@description('Target Azure region')
param location string = 'canadacentral'

@description('Environment name (e.g. dev, test, prod)')
param environmentName string = 'dev'

@description('OpenShift MinIO Endpoint URL')
param minioHost string = 'minio-6cdc9e-dev.apps.silver.devops.gov.bc.ca'

@description('OpenShift MinIO Access Key')
@secure()
param minioAccessKey string

@description('OpenShift MinIO Secret Key')
@secure()
param minioSecretKey string

@description('Typesense Master API Key')
@secure()
param typesenseApiKey string

@description('Monthly Budget Limit in USD')
param budgetAmount int = 50

@description('Notification Email Addresses for Cost Alerts')
param contactEmails array = [
  'Daniel.T.Truong@gov.bc.ca'
]

// Mandatory Cost Management Tags applied across ALL resources
var defaultTags = {
  Project: 'DEMI'
  Application: 'eagle-demi'
  Environment: environmentName
  ManagedBy: 'Bicep'
  CostCenter: 'c4b0a8'
}

// 1. Angular Frontend (Azure Static Web Apps - Free Tier CDN)
module staticWebApp './modules/static-web-app.bicep' = {
  name: 'deploy-static-web-app'
  params: {
    location: 'centralus'
    environmentName: environmentName
    tags: defaultTags
  }
}


// 2. Database (Azure Cosmos DB for MongoDB Serverless)
module cosmosMongo './modules/cosmos-mongo.bicep' = {
  name: 'deploy-cosmos-mongo'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
  }
}

// 3. Search Engine (Azure Container Apps - Typesense)
module containerApps './modules/container-apps.bicep' = {
  name: 'deploy-container-apps'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    typesenseApiKey: typesenseApiKey
  }
}

// 4. REST API (Azure Functions Node.js)
module functionApp './modules/function-app.bicep' = {
  name: 'deploy-function-app'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    minioHost: minioHost
    minioAccessKey: minioAccessKey
    minioSecretKey: minioSecretKey
    mongodbConnectionString: cosmosMongo.outputs.connectionString
    typesenseUrl: containerApps.outputs.typesenseUrl
    typesenseApiKey: typesenseApiKey
  }
}

// 5. Cost Budget Alerts ($50/month threshold)
module costBudget './modules/cost-budget.bicep' = {
  name: 'deploy-cost-budget'
  params: {
    environmentName: environmentName
    budgetAmount: budgetAmount
    contactEmails: contactEmails
  }
}

// Outputs
output staticWebAppDefaultHostName string = staticWebApp.outputs.staticWebAppDefaultHostName
output functionAppHostName string = functionApp.outputs.functionAppHostName
output typesenseUrl string = containerApps.outputs.typesenseUrl
