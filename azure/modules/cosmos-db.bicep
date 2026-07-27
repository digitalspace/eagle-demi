// Azure Cosmos DB Account Module for DEMI (Serverless Mode)
@description('Location for Cosmos DB Account')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Subnet ID for Private Endpoint (optional)')
param peSubnetId string = ''

var accountName = 'demi-cosmos-${environmentName}-${uniqueString(resourceGroup().id)}'
var databaseName = 'demi-${environmentName}'
var privateEndpointName = 'pe-cosmos-${environmentName}'

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2023-11-15' = {
  name: accountName
  location: location
  tags: tags
  kind: 'MongoDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    publicNetworkAccess: !empty(peSubnetId) ? 'Disabled' : 'Enabled'
    disableKeyBasedMetadataWriteAccess: true
    minimalTlsVersion: 'Tls12'
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

resource cosmosDatabase 'Microsoft.DocumentDB/databaseAccounts/mongodbDatabases@2023-11-15' = {
  parent: cosmosAccount
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
  }
}

// Private Endpoint for Cosmos DB when peSubnetId is supplied
resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (!empty(peSubnetId)) {
  name: privateEndpointName
  location: location
  tags: tags
  properties: {
    subnet: {
      id: peSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: privateEndpointName
        properties: {
          privateLinkServiceId: cosmosAccount.id
          groupIds: [
            'MongoDB'
          ]
        }
      }
    ]
  }
}

@secure()
output connectionString string = cosmosAccount.listConnectionStrings().connectionStrings[0].connectionString
output databaseName string = cosmosDatabase.name
output cosmosAccountId string = cosmosAccount.id
