// Document blob storage for DEMI — keyless, per-environment container.
//
// WHY A SEPARATE ACCOUNT from the `demistg*` one in api-web-app.bicep: that account holds
// Function host state and its keys are listed by the runtime, so shared-key access cannot be
// switched off there. Documents are the system of record for 60,661 files and get the opposite
// treatment — no shared keys at all, soft delete, versioning. Storage accounts have no fixed
// cost, so separating them is free.
//
// WHY A CONTAINER PER ENVIRONMENT: today dev's MINIO_HOST is one env-var edit from pointing at
// prod storage, which is exactly how prod documents get deleted by accident. A container named
// for its environment, reachable only by that environment's identity, makes the mistake
// impossible rather than merely discouraged.
//
// Deletion is deliberately NOT granted away: no request path in the application deletes a blob
// (see MIGRATION.md). Soft delete and versioning here are the second line of defence for when
// that assumption eventually breaks.

@description('Location for the storage account')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Principal id of the user-assigned managed identity used by the API')
param apiPrincipalId string

@description('Optional principal id (user or group) granted read access for operators')
param readerPrincipalId string = ''

@description('Access tier. Documents are written once and read occasionally.')
@allowed(['Hot', 'Cool'])
param accessTier string = 'Cool'

@description('Days to retain soft-deleted blobs and previous versions')
@minValue(1)
@maxValue(365)
param retentionDays int = 30

@description('Resource id of the subnet for the private endpoint. Empty disables it.')
param peSubnetId string = ''

@description('Resource id of the VNet for private DNS linking. Empty disables it.')
param vnetId string = ''

// Storage account names are 3-24 chars, lowercase alphanumeric only.
var storageAccountName = take('demidocs${environmentName}${uniqueString(resourceGroup().id)}', 24)
var containerName = 'documents-${environmentName}'
var privateEndpointName = 'demi-docs-pe-${environmentName}'
var privateDnsZoneName = 'privatelink.blob${environment().suffixes.storage}'

// Built-in role definition ids. Data-plane roles for blob storage are NOT usable through the
// control plane, so they must be assigned here.
// Storage Blob Data Contributor — read/write blobs.
var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
// Storage Blob Data Reader — read only.
var blobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
// Storage Blob Delegator — REQUIRED to call getUserDelegationKey. Without it every download
// link fails to sign, because with shared-key access disabled a user delegation SAS is the only
// way to issue one. Easy to miss: it is not implied by Data Contributor.
var blobDelegatorRoleId = 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'

resource documentStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    // LRS is sufficient: these blobs are a copy of records that also exist in MinIO, and the
    // upstream sources can reproduce the metadata. Revisit if DEMI becomes the only copy.
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: accessTier
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    // No shared keys. Auth is Entra managed identity only, so there is no account key to leak
    // from a config file or rotate before go-live. This is what forces the user-delegation-SAS
    // path in src/storage/azureBlob.js.
    allowSharedKeyAccess: false
    publicNetworkAccess: empty(peSubnetId) ? 'Enabled' : 'Disabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: empty(peSubnetId) ? 'Allow' : 'Deny'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: documentStorage
  name: 'default'
  properties: {
    // A deleted blob is recoverable for `retentionDays`. The application never deletes one, so
    // anything this catches is either an operator mistake or a future bug.
    deleteRetentionPolicy: {
      enabled: true
      days: retentionDays
      allowPermanentDelete: false
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: retentionDays
    }
    // Versioning turns an overwrite into a new version rather than data loss. A re-seed writing
    // to an existing key is the realistic way that happens.
    isVersioningEnabled: true
    changeFeed: {
      enabled: false
    }
  }
}

resource documentsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: {
    // Never 'Blob' or 'Container': those make every document anonymously readable over the
    // internet, bypassing the read[] ACL entirely.
    publicAccess: 'None'
  }
}

// ── Data-plane RBAC ──────────────────────────────────────────────────────────
// Scoped to the CONTAINER, not the account, so a future analytics or export identity can be
// granted one container without reaching the others.

resource apiBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: documentsContainer
  name: guid(documentsContainer.id, apiPrincipalId, blobDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId
    )
    principalId: apiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Delegator is account-scoped by design: getUserDelegationKey is a service-level operation and
// cannot be scoped to a container.
resource apiBlobDelegator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: documentStorage
  name: guid(documentStorage.id, apiPrincipalId, blobDelegatorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions', blobDelegatorRoleId
    )
    principalId: apiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Without this the container is empty in the portal for every human once shared-key access is
// off — the same trap as Cosmos Data Explorer.
resource humanBlobReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(readerPrincipalId)) {
  scope: documentsContainer
  name: guid(documentsContainer.id, readerPrincipalId, blobDataReaderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions', blobDataReaderRoleId
    )
    principalId: readerPrincipalId
  }
}

// ── Private networking ───────────────────────────────────────────────────────
// groupIds is 'blob'. The DNS zone name is derived from environment().suffixes.storage rather
// than hardcoded, since it differs by cloud.

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
        name: '${privateEndpointName}-conn'
        properties: {
          privateLinkServiceId: documentStorage.id
          groupIds: ['blob']
        }
      }
    ]
  }
}

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (!empty(peSubnetId) && !empty(vnetId)) {
  name: privateDnsZoneName
  location: 'global'
  tags: tags
}

resource privateDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (!empty(peSubnetId) && !empty(vnetId)) {
  parent: privateDnsZone
  name: '${privateDnsZoneName}-link'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

resource privateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = if (!empty(peSubnetId) && !empty(vnetId)) {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob-config'
        properties: {
          privateDnsZoneId: privateDnsZone.id
        }
      }
    ]
  }
}

// No connection string or key output: there is no key to output, and emitting a secret across a
// module boundary is what the Cosmos module was corrected for.
output storageAccountName string = documentStorage.name
output containerName string = documentsContainer.name
output blobEndpoint string = documentStorage.properties.primaryEndpoints.blob
