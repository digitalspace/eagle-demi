// Document intake staging account, scanned by Microsoft Defender for Storage on upload.
//
// The browser uploads to `incoming` with a user-delegation SAS. Defender scans each blob, writes the
// result as a blob index tag and publishes it to the topic below; `intakeScanResult` in the API app
// then moves the file on or copies it to `quarantine`. The ABAC condition on the API identity means a
// blob in `incoming` cannot be read until Defender has tagged it clean.
//
// The only DEMI account with Defender on. Every other module opts out (see document-storage.bicep).

@description('Location for the intake resources. The topic must share the storage account region.')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Storage account name, 3-24 lowercase alphanumeric. main.bicep owns it because the API app settings need it in runs that skip this module.')
param storageAccountName string

@description('Principal id of demi-identity-<env>, the identity the API runs as')
param apiPrincipalId string

@description('Name of the Flex API app whose `intakeScanResult` function receives scan results')
param apiAppName string

@description('Create the Event Grid subscription. False on the first pass: the subscription cannot be created before the function exists.')
param deploySubscription bool = true

@description('Malware scanning cap in GB per month. Scanning stops for the rest of the month when it is reached.')
@minValue(1)
param capGBPerMonth int

// Tenant-specific object id, so it cannot be derived here. Candidate: the per-subscription managed
// identity of `/subscriptions/<sub>/providers/Microsoft.Security/dataScanners/storageDataScanner`
// (`az ad sp list --filter "startswith(displayName,'StorageDataScanner')"`, match alternativeNames).
@description('Object id of the Defender for Storage principal that publishes scan results. Empty grants nothing: the topic has local auth off, so Defender cannot publish until this is set.')
param defenderPrincipalId string = ''

@description('Browser origins allowed to PUT to the blob endpoint, host names without scheme')
param allowedOrigins array = []

@description('Resource id of the subnet for the private endpoint. Empty disables it.')
param peSubnetId string = ''

@description('Days to retain soft-deleted blobs')
@minValue(1)
@maxValue(365)
param retentionDays int = 7

// Exported so main.bicep can name them in the API app settings on runs that skip this module.
@export()
var intakeContainers = {
  incoming: 'incoming'
  quarantine: 'quarantine'
  deadletter: 'deadletter'
}
var incomingContainer = intakeContainers.incoming
var quarantineContainer = intakeContainers.quarantine
var deadletterContainer = intakeContainers.deadletter
var scanResultTag = 'Malware Scanning scan result'
var privateEndpointName = 'demi-intake-pe-${environmentName}'
// The Event Grid trigger in api/index.js. A subscription pointed at a missing function is accepted and drops every event.
var scanResultFunctionName = 'intakeScanResult'

var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var blobDelegatorRoleId = 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'
var eventGridDataSenderRoleId = 'd5a91429-5739-47e2-a06b-3470a27159e7'

resource intakeStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    // Policy Deny-Storage-Shared-Key; uploads use a user-delegation SAS, which needs no key.
    allowSharedKeyAccess: false
    // The browser reaches the public blob endpoint; the API app reaches the private endpoint.
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: intakeStorage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: retentionDays
      allowPermanentDelete: false
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: retentionDays
    }
    cors: {
      corsRules: empty(allowedOrigins) ? [] : [
        {
          allowedOrigins: map(allowedOrigins, h => 'https://${h}')
          allowedMethods: [ 'PUT', 'OPTIONS' ]
          allowedHeaders: [ 'content-type', 'x-ms-blob-type', 'x-ms-version', 'x-ms-client-request-id', 'x-ms-blob-content-type' ]
          exposedHeaders: [ 'x-ms-request-id', 'etag' ]
          maxAgeInSeconds: 3600
        }
      ]
    }
  }
}

resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for name in [incomingContainer, quarantineContainer, deadletterContainer]: {
  parent: blobService
  name: name
  properties: {
    publicAccess: 'None'
  }
}]

resource scanResultsTopic 'Microsoft.EventGrid/topics@2025-02-15' = {
  name: 'demi-intake-${environmentName}'
  location: location
  tags: tags
  properties: {
    inputSchema: 'EventGridSchema'
    // Defender publishes from outside the VNet and cannot reach a private-only topic.
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
  }
}

resource defenderPublishes 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(defenderPrincipalId)) {
  scope: scanResultsTopic
  name: guid(scanResultsTopic.id, defenderPrincipalId, eventGridDataSenderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', eventGridDataSenderRoleId)
    principalId: defenderPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Exactly the table in the intake plan. A container name with no `/` excludes the whole container.
resource defenderForStorage 'Microsoft.Security/defenderForStorageSettings@2025-06-01' = {
  name: 'current'
  scope: intakeStorage
  properties: {
    isEnabled: true
    overrideSubscriptionLevelSettings: true
    malwareScanning: {
      onUpload: {
        isEnabled: true
        capGBPerMonth: capGBPerMonth
        filters: {
          excludeBlobsWithPrefix: [ quarantineContainer, deadletterContainer ]
          // 2 GB. Larger files are not scanned, so the sweep rejects them.
          excludeBlobsLargerThan: 2147483648
        }
      }
      // The ABAC condition below reads this tag.
      blobScanResultsOptions: 'blobIndexTags'
      scanResultsEventGridTopicResourceId: scanResultsTopic.id
    }
    sensitiveDataDiscovery: {
      isEnabled: false
    }
  }
}

resource scanResultSubscription 'Microsoft.EventGrid/topics/eventSubscriptions@2025-02-15' = if (deploySubscription) {
  parent: scanResultsTopic
  name: 'intake-scan-result'
  properties: {
    destination: {
      endpointType: 'AzureFunction'
      properties: {
        resourceId: '${resourceId('Microsoft.Web/sites', apiAppName)}/functions/${scanResultFunctionName}'
        maxEventsPerBatch: 1
      }
    }
    filter: {
      includedEventTypes: [
        'Microsoft.Security.MalwareScanningResult'
      ]
    }
    retryPolicy: {
      maxDeliveryAttempts: 5
      eventTimeToLiveInMinutes: 60
    }
  }
}

// ── Identities and data-plane RBAC ──────────────────────────────────────────────────────────────

// Moves rejected files to quarantine. The API identity cannot write outside `incoming` or read an unscanned blob.
resource intakeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'demi-intake-${environmentName}'
  location: location
  tags: tags
}

resource intakeBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: intakeStorage
  name: guid(intakeStorage.id, intakeIdentity.id, blobDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
    principalId: intakeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// The quarantine copy reads its source through a user-delegation SAS.
resource intakeBlobDelegator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: intakeStorage
  name: guid(intakeStorage.id, intakeIdentity.id, blobDelegatorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDelegatorRoleId)
    principalId: intakeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Three clauses, all must hold for the API identity:
// 1. a blob read (not a list) is allowed only in `incoming` and only once Defender tagged it clean;
// 2. writes and deletes are allowed only in `incoming`;
// 3. no write may set the scan-result tag, or an upload SAS with tag rights could pre-mark a file clean.
var blobsAction = 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs'
var containerNameAttr = '@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name]'
var apiCondition = join([
  '('
  ' ('
  '  !(ActionMatches{\'${blobsAction}/read\'} AND NOT SubOperationMatches{\'Blob.List\'})'
  ' )'
  ' OR'
  ' ('
  '  ${containerNameAttr} StringEquals \'${incomingContainer}\''
  '  AND'
  '  @Resource[${blobsAction}/tags:${scanResultTag}<$key_case_sensitive$>] StringEquals \'No threats found\''
  ' )'
  ')'
  'AND'
  '('
  ' ('
  '  !(ActionMatches{\'${blobsAction}/write\'})'
  '  AND'
  '  !(ActionMatches{\'${blobsAction}/add/action\'})'
  '  AND'
  '  !(ActionMatches{\'${blobsAction}/delete\'})'
  ' )'
  ' OR'
  ' ('
  '  ${containerNameAttr} StringEquals \'${incomingContainer}\''
  ' )'
  ')'
  'AND'
  '('
  ' ('
  '  !(ActionMatches{\'${blobsAction}/write\'} AND SubOperationMatches{\'Blob.Write.WithTagHeaders\'})'
  '  AND'
  '  !(ActionMatches{\'${blobsAction}/add/action\'} AND SubOperationMatches{\'Blob.Write.WithTagHeaders\'})'
  '  AND'
  '  !(ActionMatches{\'${blobsAction}/tags/write\'})'
  ' )'
  ' OR'
  ' ('
  '  @Request[${blobsAction}/tags&$keys$&] ForAllOfAllValues:StringNotEquals {\'${scanResultTag}\'}'
  ' )'
  ')'
], '\n')

resource apiBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: intakeStorage
  name: guid(intakeStorage.id, apiPrincipalId, blobDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
    principalId: apiPrincipalId
    principalType: 'ServicePrincipal'
    condition: apiCondition
    conditionVersion: '2.0'
  }
}

// getUserDelegationKey is account-level and not implied by Data Contributor; without it no upload link signs.
resource apiBlobDelegator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: intakeStorage
  name: guid(intakeStorage.id, apiPrincipalId, blobDelegatorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDelegatorRoleId)
    principalId: apiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ── Private networking ──────────────────────────────────────────────────────────────────────────
// No DNS zone group: landing-zone policy attaches it, as for document-storage.bicep.

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
          privateLinkServiceId: intakeStorage.id
          groupIds: ['blob']
        }
      }
    ]
  }
}

output storageAccountName string = intakeStorage.name
output incomingContainer string = incomingContainer
output quarantineContainer string = quarantineContainer
output deadletterContainer string = deadletterContainer
output topicId string = scanResultsTopic.id
output intakeIdentityClientId string = intakeIdentity.properties.clientId
output intakeIdentityId string = intakeIdentity.id
