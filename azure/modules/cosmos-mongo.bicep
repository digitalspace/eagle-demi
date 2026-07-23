// Azure Cosmos DB (MongoDB API) Module for DEMI
@description('Location for Cosmos DB Account')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

var accountName = 'demi-mongo-${environmentName}-${uniqueString(resourceGroup().id)}'
var databaseName = 'demi-${environmentName}'

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2023-11-15' = {
  name: accountName
  location: location
  tags: tags
  kind: 'MongoDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    publicNetworkAccess: 'Disabled'
    apiProperties: {
      serverVersion: '7.0'
    }
    capabilities: [
      {
        name: 'EnableServerless' // Serverless mode ($0 when idle)
      }
    ]
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
  }
}

resource mongoDatabase 'Microsoft.DocumentDB/databaseAccounts/mongodbDatabases@2023-11-15' = {
  parent: cosmosAccount
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
  }
}

output connectionString string = cosmosAccount.listConnectionStrings().connectionStrings[0].connectionString
output mongoDatabaseName string = mongoDatabase.name
