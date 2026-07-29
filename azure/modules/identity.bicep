// User-assigned managed identity for DEMI.
//
// Deliberately created BEFORE the Cosmos and App Service modules and passed into both.
// Granting Cosmos data-plane roles to the App Service's own system-assigned principal would
// make cosmos-db depend on api-web-app while api-web-app depends on cosmos-db for its
// settings — a Bicep module cycle. A user-assigned identity breaks that, and is the better
// model anyway: it outlives the app, survives an app recreate, and the same identity can be
// granted to the Function App, a future container job, and operator scripts.

@description('Location for the managed identity')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

resource demiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'demi-identity-${environmentName}'
  location: location
  tags: tags
}

output identityId string = demiIdentity.id
output principalId string = demiIdentity.properties.principalId
output clientId string = demiIdentity.properties.clientId
output identityName string = demiIdentity.name
