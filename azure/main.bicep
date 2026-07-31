// Root Bicep Orchestrator for DEMI Azure Infrastructure (Serverless Architecture)
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

@description('Monthly Budget Limit in USD')
param budgetAmount int = 100

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

// 1. Virtual Network (VNet Integration & Private Endpoints Subnets)
module vnet './modules/vnet.bicep' = {
  name: 'deploy-vnet'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
  }
}

// 2. Key Vault (Secrets Management)
module keyVault './modules/key-vault.bicep' = {
  name: 'deploy-key-vault'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
  }
}

// 3. Angular Frontend (Azure Static Web Apps - Serverless SPA Host)
module staticWebApp './modules/static-web-app.bicep' = {
  name: 'deploy-static-web-app'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
  }
}

// 4. Database (Azure Cosmos DB Serverless + Private Endpoint)
module cosmosDb './modules/cosmos-db.bicep' = {
  name: 'deploy-cosmos-db'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    peSubnetId: vnet.outputs.peSubnetId
  }
}

// 6. REST API (Azure Function App Serverless Consumption + VNet Integration)
module apiWebApp './modules/api-web-app.bicep' = {
  name: 'deploy-api-web-app'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    minioHost: minioHost
    minioAccessKey: minioAccessKey
    minioSecretKey: minioSecretKey
    mongodbConnectionString: cosmosDb.outputs.connectionString
    apiSubnetId: vnet.outputs.apiSubnetId
  }
}

// 7. Cost Budget Alerts ($50/month threshold)
module costBudget './modules/cost-budget.bicep' = {
  name: 'deploy-cost-budget'
  params: {
    environmentName: environmentName
    budgetAmount: budgetAmount
    contactEmails: contactEmails
  }
}

// Outputs
output staticWebAppDefaultHostname string = staticWebApp.outputs.staticWebAppDefaultHostname
output apiWebAppHostName string = apiWebApp.outputs.apiWebAppHostName
output keyVaultName string = keyVault.outputs.keyVaultName
