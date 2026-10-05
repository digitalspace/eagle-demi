// One-time archive backup of every stored original, taken before the PDF title job rewrites any.
// Holds unpublished and sealed documents, so access is tighter than document-storage.bicep.
// Deployed by hand per environment, not from main.bicep:
//   az deployment group create -g <rg> -f azure/modules/document-backup.bicep -p azure/document-backup.<env>.bicepparam

@description('Location for the storage account')
param location string = resourceGroup().location

@description('Environment name (test, prod)')
@allowed(['test', 'prod'])
param environmentName string

@description('Resource id of the private-endpoint subnet. The account has no public network path.')
param peSubnetId string

@description('Time-based retention on originals and manifests, in days. The policy stays unlocked.')
@minValue(1)
@maxValue(146000)
param retentionDays int

@description('Grant the writer identity Data Contributor for a copy run. Setting it back to false does not remove the grant; see the comment on writerGrants.')
param grantWriter bool = false

// Same tag set main.bicep applies; that var is not exported, so it cannot be imported here.
var tags = {
  Project: 'DEMI'
  Application: 'eagle-demi'
  Environment: environmentName
  ManagedBy: 'Bicep'
  CostCenter: 'c4b0a8'
}

var storageAccountName = take('eaglebak${environmentName}${uniqueString(resourceGroup().id)}', 24)
var privateEndpointName = 'eagle-backup-pe-${environmentName}'
var softDeleteDays = 30
var restoreExpiryDays = 30
var writerContainers = ['originals', 'manifests', 'restore']

var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var blobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

// Foundation resources from main.bicep, same resource group, read by the names it gives them.
resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'demi-identity-${environmentName}'
}

resource auditWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: 'demi-audit-${environmentName}'
}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' existing = {
  name: 'demi-alerts-${environmentName}'
}

resource backupStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_GRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Cool'
    isHnsEnabled: false
    isSftpEnabled: false
    // Local users are a second credential path beside Entra; shared keys alone would not close it.
    isLocalUserEnabled: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    allowCrossTenantReplication: false
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Deny'
    }
  }
}

resource backupLock 'Microsoft.Authorization/locks@2020-05-01' = {
  scope: backupStorage
  name: 'eagle-backup-nodelete'
  properties: {
    level: 'CanNotDelete'
    notes: 'Archive backup of document originals. Also blocks deleting role assignments under the account; remove the lock first.'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: backupStorage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: softDeleteDays
      allowPermanentDelete: false
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: softDeleteDays
    }
    // Off on purpose: with versioning on, an overwrite under a retention policy succeeds as a new
    // version, so the backup blob could be replaced instead of refused.
    isVersioningEnabled: false
  }
}

resource originalsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'originals'
  properties: {
    publicAccess: 'None'
  }
}

resource manifestsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'manifests'
  properties: {
    publicAccess: 'None'
  }
}

resource restoreContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'restore'
  properties: {
    publicAccess: 'None'
  }
}

// Unlocked: a locked policy cannot be shortened or removed, which would also block destroying a
// document EAO must delete. Locking is the separate `lock` action, never done here.
resource originalsRetention 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies@2023-05-01' = {
  parent: originalsContainer
  name: 'default'
  properties: {
    immutabilityPeriodSinceCreationInDays: retentionDays
    allowProtectedAppendWrites: false
  }
}

resource manifestsRetention 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies@2023-05-01' = {
  parent: manifestsContainer
  name: 'default'
  properties: {
    immutabilityPeriodSinceCreationInDays: retentionDays
    allowProtectedAppendWrites: false
  }
}

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: backupStorage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'restore-expiry'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['${restoreContainer.name}/']
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterCreationGreaterThan: restoreExpiryDays
                }
              }
            }
          }
        }
      ]
    }
  }
}

resource writerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'eagle-backup-writer-${environmentName}'
  location: location
  tags: tags
}

// `restore` is included because the restore drill copies into it with the same identity.
// Turning the grant off is not a redeploy: incremental mode leaves the assignment in place, and the
// account lock blocks deleting it. Off = delete the lock, delete the ids in `writerGrantIds`, redeploy
// with grantWriter=false (which puts the lock back).
resource writerScopes 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = [
  for name in writerContainers: {
    parent: blobService
    name: name
  }
]

resource writerGrants 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (name, i) in writerContainers: if (grantWriter) {
    scope: writerScopes[i]
    name: guid(writerScopes[i].id, writerIdentity.id, blobDataContributorRoleId)
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
      principalId: writerIdentity.properties.principalId
      principalType: 'ServicePrincipal'
    }
    dependsOn: [originalsContainer, manifestsContainer, restoreContainer]
  }
]

// The title job's gate reads blob properties only; an archived blob's content is not readable.
resource apiReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: originalsContainer
  name: guid(originalsContainer.id, apiIdentity.id, blobDataReaderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataReaderRoleId)
    principalId: apiIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// DNS is left to the landing-zone policy, as in document-storage.bicep.
resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = {
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
          privateLinkServiceId: backupStorage.id
          groupIds: ['blob']
        }
      }
    ]
  }
}

// Distinct name from the landing zone's `setByPolicy-*` setting so the two do not overwrite each other.
resource blobAudit 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: blobService
  name: 'eagle-backup-audit'
  properties: {
    workspaceId: auditWorkspace.id
    logs: [
      { category: 'StorageRead', enabled: true }
      { category: 'StorageWrite', enabled: true }
      { category: 'StorageDelete', enabled: true }
    ]
  }
}

// Every Administrative event under the account once it has finished (Succeeded or Failed), not the
// Started and Accepted events: settings (shared keys, network), role assignments,
// immutability policy changes, lock removal, key listing.
resource changeAlert 'Microsoft.Insights/activityLogAlerts@2020-10-01' = {
  name: 'eagle-backup-changes-${environmentName}'
  location: 'Global'
  tags: tags
  properties: {
    enabled: true
    description: 'Control-plane change on the document backup account ${backupStorage.name}.'
    scopes: [backupStorage.id]
    condition: {
      allOf: [
        {
          field: 'category'
          equals: 'Administrative'
        }
        {
          anyOf: [
            {
              field: 'status'
              equals: 'Succeeded'
            }
            {
              field: 'status'
              equals: 'Failed'
            }
          ]
        }
      ]
    }
    actions: {
      actionGroups: [
        {
          actionGroupId: actionGroup.id
        }
      ]
    }
  }
}

output storageAccountName string = backupStorage.name
output blobEndpoint string = backupStorage.properties.primaryEndpoints.blob
output writerIdentityId string = writerIdentity.id
output writerClientId string = writerIdentity.properties.clientId
output writerPrincipalId string = writerIdentity.properties.principalId
output writerGrantIds array = [for (name, i) in writerContainers: grantWriter ? writerGrants[i].id : '']
