// Never carries a secret value: names only, values are set by hand or by secret-rotator.bicep.
// Secret URIs are composed from the vault URI because the secrets are created out of band.

@description('Location for the vault')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Principal ID of the identity the API runs as. Granted Key Vault Secrets User below.')
param identityPrincipalId string

// No default: a vault without a private endpoint answers ForbiddenByConnection to everyone and,
// under purge protection, still holds its name.
@description('Subnet ID for the inbound private endpoint. REQUIRED — public network access is denied by policy, so a vault without one is unreachable.')
param peSubnetId string

@description('Action group the secret near-expiry alert mails.')
param actionGroupId string

// Name a secret here only once it is set on that vault: a reference to a missing secret leaves
// the app setting unresolved. deploy-infra.sh checks the list.
@description('Optional secret names this environment\'s vault holds, e.g. notify-api-key, edge-secret. Empty leaves those app settings blank.')
param optionalSecretNames array = []

// The names the API cannot start without. deploy-infra.sh reads this list out of this file, so it
// is the one place the set is written down.
var requiredSecretNames = [
  'admin-api-key'
  'track-client-secret'
  'role-sync-client-secret'
  'docling-api-key'
  'minio-access-key'
  'minio-secret-key'
  // Read by APIM for the analytics gateway headers; unresolved, the backend 401s every request.
  'analytics-shared-header'
  'analytics-audit-header'
]

// OpenShift sync tokens go in optionalSecretNames: deploy-infra.sh reads the list above as
// literal strings and would skip an interpolated name.

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
    // Key Vault guardrails policy demands both explicitly. Purge protection cannot be undone: a
    // deleted vault keeps its name for the retention window.
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    // Same landing-zone policy set (`Deny-PublicPaaSEndpoints`) that forces this on AI Search and
    // Cosmos: anything but 'Disabled' is denied before the vault is created.
    publicNetworkAccess: 'Disabled'
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

// No DNS zone group: landing-zone policy attaches one in a central DNS subscription, and our own
// would compete with it.
resource vaultPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = {
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

// One system topic per vault, shared with the secret sync's subscription in secret-sync.bicep.
resource vaultTopic 'Microsoft.EventGrid/systemTopics@2025-02-15' = {
  name: 'evgt-${vaultName}'
  location: location
  tags: tags
  properties: {
    source: vault.id
    topicType: 'Microsoft.KeyVault.vaults'
  }
}

// Key Vault raises SecretNearExpiry 30 days before a secret's exp. The MonitorAlert destination
// accepts only the CloudEvents schema.
resource secretNearExpiryAlert 'Microsoft.EventGrid/systemTopics/eventSubscriptions@2025-02-15' = {
  parent: vaultTopic
  name: 'secret-near-expiry'
  properties: {
    eventDeliverySchema: 'CloudEventSchemaV1_0'
    destination: {
      endpointType: 'MonitorAlert'
      properties: {
        severity: 'Sev2'
        actionGroups: [ actionGroupId ]
        description: 'A secret in ${vaultName} expires within 30 days. Set a new version with a later exp.'
      }
    }
    filter: {
      includedEventTypes: [
        'Microsoft.KeyVault.SecretNearExpiry'
      ]
    }
  }
}

output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri

// One place composes a secret identifier, so a stray missing slash cannot differ between names.
var secretUriBase = '${vault.properties.vaultUri}secrets/'

// deploy-infra.sh checks the live vault against this list, since a missing name never resolves.
output secretNames array = union(requiredSecretNames, optionalSecretNames)

// VERSIONLESS on purpose (no `/<version>` suffix), so a new version needs no infrastructure deploy.
// The four rotated names are also read from the vault by their checkers. `vaultUri` ends in a slash.
output adminApiKeySecretUri string = '${secretUriBase}admin-api-key'
output trackClientSecretUri string = '${secretUriBase}track-client-secret'
output roleSyncClientSecretUri string = '${secretUriBase}role-sync-client-secret'
output doclingApiKeySecretUri string = '${secretUriBase}docling-api-key'
output minioAccessKeySecretUri string = '${secretUriBase}minio-access-key'
output minioSecretKeySecretUri string = '${secretUriBase}minio-secret-key'
// Consumed by apim.bicep as Key Vault-backed named values, so APIM stops being a second store for
// values eagle-analytics also holds.
output analyticsSharedHeaderSecretUri string = '${secretUriBase}analytics-shared-header'
output analyticsAuditHeaderSecretUri string = '${secretUriBase}analytics-audit-header'
// Empty where the environment did not name the secret — the app then gets an empty NOTIFY_API_KEY
// and stays dark, rather than a Key Vault reference to a secret nobody set.
output notifyApiKeySecretUri string = contains(optionalSecretNames, 'notify-api-key') ? '${secretUriBase}notify-api-key' : ''
// Same rule: empty means X-Edge-Secret is ignored, which is what an environment with no Front Door
// in front of it wants.
output edgeSecretUri string = contains(optionalSecretNames, 'edge-secret') ? '${secretUriBase}edge-secret' : ''
// Empty on prod, which runs ungated. Not named ...PasswordSecretUri: the linter reads "password"
// in an output name as a secret value.
output accessGateSecretUri string = contains(optionalSecretNames, 'access-gate-password') ? '${secretUriBase}access-gate-password' : ''
