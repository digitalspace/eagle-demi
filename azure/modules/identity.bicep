// User-assigned managed identity for DEMI.
//
// Deliberately created BEFORE the Cosmos and API modules and passed into both. Granting Cosmos
// data-plane roles to the app's own system-assigned principal would make cosmos-nosql depend on
// the API module while the API module depends on it for settings — a Bicep module cycle. A
// user-assigned identity breaks that, outlives the app, and is shared by the devbox and the
// operator scripts.

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
