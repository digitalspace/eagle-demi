// Key Vault for the DEMI application secrets, plus its private endpoint and the read grants.
//
// THIS TEMPLATE NEVER CARRIES A SECRET VALUE. It creates the vault and says which names the app
// expects; the values are set once by hand from the devbox with `az keyvault secret set`, and
// rotation is a new version at the vault plus an app recycle. Nothing about a value passes through
// git, a workflow input, or an ARM parameter, so there is no @secure() parameter that can blank a
// live credential and nothing for `what-if` to mask.
//
// The app reads each name as `@Microsoft.KeyVault(SecretUri=<vaultUri>secrets/<name>)`. That URI is
// composed from the vault URI below, not read off a secret resource, because the secret is created
// out of band and this deployment cannot see it.

@description('Location for the vault')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Principal ID of the identity the API runs as. Granted Key Vault Secrets User below.')
param identityPrincipalId string

// REQUIRED, no default. The landing-zone policy `Deny-PublicPaaSEndpoints` forces
// `publicNetworkAccess: Disabled` on every vault, so a vault with no private endpoint answers
// `ForbiddenByConnection` to every caller including its owner — an unreachable vault that still
// reserves its name for good under purge protection. An empty value used to be accepted here and
// produced exactly that.
@description('Subnet ID for the inbound private endpoint. REQUIRED — public network access is denied by policy, so a vault without one is unreachable.')
param peSubnetId string

// Optional secrets are named per environment rather than assumed: a Key Vault reference to a
// secret nobody has set leaves the app setting unresolved. Naming one here is the statement that
// it has been set on that environment's vault. Whatever a later phase moves in goes in the same
// list and is then verified by deploy-infra.sh.
@description('Optional secret names this environment\'s vault holds, e.g. notify-api-key, edge-secret. Empty leaves those app settings blank.')
param optionalSecretNames array = []

// Readers beyond the API identity: the analytics Flex Function identity and the APIM managed
// identity, which arrive in a later phase and are principals this template does not create.
@description('Extra principal IDs to grant Key Vault Secrets User, beyond identityPrincipalId.')
param additionalSecretReaderPrincipalIds array = []

// The names the API cannot start without. deploy-infra.sh reads this list out of this file, so it
// is the one place the set is written down.
var requiredSecretNames = [
  'admin-api-key'
  'track-client-secret'
  'role-sync-client-secret'
  'docling-api-key'
  'minio-access-key'
  'minio-secret-key'
  // Read by APIM, not by the API app: the two headers the analytics gateway stamps. Required
  // rather than optional because both environments that deploy this vault publish the analytics
  // API, and a gateway stamping an unresolved named value is a backend that 401s what it forwards.
  'analytics-shared-header'
  'analytics-audit-header'
]

// The OpenShift secret sync's own credentials — `openshift-token-<env>`, plus `dev-openshift-token`
// on the nonprod vault, which serves 6cdc9e-dev as well — are named in each environment's
// `optionalSecretNames` rather than here. They are per-environment names, and deploy-infra.sh reads
// this list as literal strings, so a `${environmentName}` here would be skipped by its check
// silently. Optional in the template, required for the sync: an environment that names no token
// deploys no sync app either (`syncNamespaces` in the param file).

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

// Same name derivation as the grant above, so a principal that is already in the list re-deploys
// as a no-op rather than a second assignment.
resource additionalSecretsUsers 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for readerPrincipalId in additionalSecretReaderPrincipalIds: {
  scope: vault
  name: guid(vault.id, readerPrincipalId, keyVaultSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUser)
    principalId: readerPrincipalId
    principalType: 'ServicePrincipal'
  }
}]

// No DNS zone group here, same as the Cosmos and AI Search endpoints: this landing zone attaches
// one by policy (`deployedByPolicy`) pointing at privatelink.vaultcore.azure.net in a central DNS
// subscription this one cannot read. Declaring our own would create a competing record set.
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

output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri

// One place composes a secret identifier, so a stray missing slash cannot differ between names.
var secretUriBase = '${vault.properties.vaultUri}secrets/'

// Every name this environment's vault is expected to hold. deploy-infra.sh checks the live vault
// against it from the devbox before deploying, because a missing name is an app setting that
// silently never resolves.
output secretNames array = union(requiredSecretNames, optionalSecretNames)

// VERSIONLESS on purpose (no `/<version>` suffix): App Service re-reads a versionless reference on
// its own, so a rotation is a new secret version plus a recycle rather than an infrastructure
// deploy. `vaultUri` already ends in a slash.
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
