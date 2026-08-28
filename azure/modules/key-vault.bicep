// Key Vault holding ADMIN_API_KEY, so the break-glass credential stops being a literal app setting.
//
// The value still enters ARM as a @secure() parameter (deploy-infra.sh sources it from OpenShift
// `demi-app-secrets`, which stays the source of truth). What changes is where the App Service reads
// it from: a Key Vault reference instead of a stored setting, so rotating the secret does not need
// an infrastructure deploy and the running value is auditable at the vault.

@description('Location for the vault')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Principal ID of the identity the API runs as. Granted Key Vault Secrets User below.')
param identityPrincipalId string

@description('Subnet ID for the inbound private endpoint. Required in this landing zone — public network access is denied by policy.')
param peSubnetId string = ''

@description('Break-glass admin credential. Written as the admin-api-key secret; the app reads it by reference.')
@secure()
param adminApiKey string

@description('Client secret of the Track service account DEMI reads project team members with. Same handling as adminApiKey.')
@secure()
param trackClientSecret string

@description('Client secret of the Keycloak service account the team sync grants roles with. Same handling as adminApiKey.')
@secure()
param roleSyncClientSecret string

// 3-24 characters, alphanumeric and hyphens, must start with a letter. `demi-kv-prod` is 12.
var vaultName = 'demi-kv-${environmentName}'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    // RBAC, not access policies. Every other data plane here is Entra RBAC, and access policies
    // cannot be granted to a principal that does not exist yet.
    enableRbacAuthorization: true
    // Both demanded explicitly by the `Enforce recommended guardrails for Azure Key Vault`
    // assignment — omitting either is RequestDisallowedByPolicy, not a default. Purge protection is
    // IRREVERSIBLE: once on, a deleted vault and its name are held for the retention window and
    // cannot be purged early, so `demi-kv-test` is a name this subscription keeps.
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    // Same landing-zone policy set (`Deny-PublicPaaSEndpoints`) that forces this on AI Search and
    // Cosmos: anything but 'Disabled' is denied before the vault is created.
    publicNetworkAccess: 'Disabled'
  }
}

resource adminApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'admin-api-key'
  properties: {
    value: adminApiKey
  }
}

resource trackClientSecretSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'track-client-secret'
  properties: {
    value: trackClientSecret
  }
}

resource roleSyncClientSecretSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'role-sync-client-secret'
  properties: {
    value: roleSyncClientSecret
  }
}

// Key Vault Secrets User — read of secret VALUES, nothing else. Not Secrets Officer: the app never
// writes a secret, and rotation happens at the vault, not through the app.
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

resource secretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, identityPrincipalId, keyVaultSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUser)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// No DNS zone group here, same as the Cosmos and AI Search endpoints: this landing zone attaches
// one by policy (`deployedByPolicy`) pointing at privatelink.vaultcore.azure.net in a central DNS
// subscription this one cannot read. Declaring our own would create a competing record set.
resource vaultPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (!empty(peSubnetId)) {
  name: 'pe-${vaultName}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: peSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'plsc-${vaultName}'
        properties: {
          privateLinkServiceId: vault.id
          groupIds: [
            'vault'
          ]
        }
      }
    ]
  }
}

output vaultName string = vault.name
// VERSIONLESS on purpose (`secretUri`, not `secretUriWithVersion`): App Service re-reads a
// versionless reference on its own, so a rotation is a new secret version plus a restart rather
// than an infrastructure deploy.
output adminApiKeySecretUri string = adminApiKeySecret.properties.secretUri
output trackClientSecretUri string = trackClientSecretSecret.properties.secretUri
output roleSyncClientSecretUri string = roleSyncClientSecretSecret.properties.secretUri
