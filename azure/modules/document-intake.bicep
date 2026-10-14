// Document intake staging account, scanned by Microsoft Defender for Storage on upload.
//
// The browser uploads to `incoming` with a user-delegation SAS. Defender scans each blob and writes the
// result as a blob index tag. `intakeScanSweep` in the API app reads that tag every 5 minutes, then
// moves the file on or copies it to `quarantine`. The ABAC condition on the API identity means a blob
// in `incoming` cannot be read until Defender has tagged it clean.
//
// No Event Grid topic: policy Deny-PublicPaaSEndpoints refuses a public custom topic, and Defender
// cannot deliver scan results to one without public network access.
//
// The only DEMI account with Defender on. Every other module opts out (see document-storage.bicep).

@description('Location for the intake resources')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Storage account name, 3-24 lowercase alphanumeric. main.bicep owns it because the API app settings need it in runs that skip this module.')
param storageAccountName string

@description('Principal id of demi-identity-<env>, the identity the API runs as')
param apiPrincipalId string

@description('Malware scanning cap in GB per month. Scanning stops for the rest of the month when it is reached.')
@minValue(1)
param capGBPerMonth int

@description('Browser origins allowed to PUT to the blob endpoint, host names without scheme')
param allowedOrigins array = []

@description('Resource id of the subnet for the private endpoint. Empty disables it.')
param peSubnetId string = ''

@description('Resource id of the Log Analytics workspace the API logs to')
param logsWorkspaceId string

@description('Resource id of demi-alerts-<env>')
param actionGroupId string

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
var scanResultTag = 'Malware scanning scan result'
var privateEndpointName = 'demi-intake-pe-${environmentName}'

var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var blobDataOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var blobDelegatorRoleId = 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'

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
      // The sweep and the ABAC condition below read this tag.
      blobScanResultsOptions: 'blobIndexTags'
    }
    sensitiveDataDiscovery: {
      isEnabled: false
    }
  }
}

// ── Identities and data-plane RBAC ──────────────────────────────────────────────────────────────

var blobsAction = 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs'
var containerNameAttr = '@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name]'

// Denies every way to set a blob index tag: Set Blob Tags, and a write or create carrying tag headers.
var tagWriteDeny = join([
  '('
  ' !(ActionMatches{\'${blobsAction}/write\'} AND SubOperationMatches{\'Blob.Write.WithTagHeaders\'})'
  ' AND'
  ' !(ActionMatches{\'${blobsAction}/add/action\'} AND SubOperationMatches{\'Blob.Write.WithTagHeaders\'})'
  ' AND'
  ' !(ActionMatches{\'${blobsAction}/tags/write\'})'
  ')'
], '\n')

// Reads scan-result tags and moves rejected files to quarantine. It can never write a tag, so a wrong
// sweep decision cannot mark a file clean. The API identity cannot write outside `incoming` or read an
// unscanned blob.
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
    condition: tagWriteDeny
    conditionVersion: '2.0'
  }
}

// Data Contributor lacks blobs/tags/read, which the sweep needs. Owner adds it, on `incoming` only
// (containers[0]); the same condition takes back the tag writes Owner would also grant.
resource intakeTagReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: containers[0]
  name: guid(containers[0].id, intakeIdentity.id, blobDataOwnerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataOwnerRoleId)
    principalId: intakeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    condition: tagWriteDeny
    conditionVersion: '2.0'
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
  tagWriteDeny
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

// ── Scan cap alerts ─────────────────────────────────────────────────────────────────────────────
// A log alert reads at most two days, so the sweep logs the month-to-date total from Cosmos and the
// cap it applies; the rule reads the newest line. Warning at 75%, error at 100%: scanning has stopped.
var capAlerts = [
  { percent: 75, severity: 2 }
  { percent: 100, severity: 1 }
]

resource capAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = [for a in capAlerts: {
  name: 'demi-intake-scan-cap-${a.percent}-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI intake malware scanning at ${a.percent}% of the monthly cap'
    description: 'Defender for Storage has scanned ${a.percent}% of the monthly cap on ${storageAccountName}. At 100% scanning stops until the month ends and the sweep rejects new uploads. Raise intakeCapGBPerMonth and rerun infra to recover.'
    severity: a.severity
    enabled: true
    scopes: [ logsWorkspaceId ]
    evaluationFrequency: 'PT1H'
    windowSize: 'P1D'
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message contains "[intake] month-to-date" | top 1 by TimeGenerated desc | extend scannedBytes = tolong(extract("scannedBytes=([0-9]+)", 1, Message)), capBytes = tolong(extract("capBytes=([0-9]+)", 1, Message)) | where capBytes > 0 and scannedBytes * 100 >= capBytes * ${a.percent}'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [ actionGroupId ]
    }
  }
}]

// The sweep logs the month-to-date line every 5 minutes. None for 2 hours means the sweep is dead,
// so no scan result is read, pending uploads are never timed out and the cap alerts above go silent.
// Not gated: it fires if the API code deploy lags this module by more than 2 hours.
resource sweepSilentAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = {
  name: 'demi-intake-sweep-silent-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI intake sweep has not run for 2 hours'
    description: 'No "[intake] month-to-date" line in 2 hours from intakeScanSweep in demi-api-fc-${environmentName}. Pending uploads are not being timed out and the scan cap alerts cannot fire. Check the function is registered and INTAKE_* settings are set.'
    severity: 1
    enabled: true
    scopes: [ logsWorkspaceId ]
    evaluationFrequency: 'PT30M'
    windowSize: 'PT2H'
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message contains "[intake] month-to-date scannedBytes="'
          timeAggregation: 'Count'
          operator: 'LessThan'
          threshold: 1
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [ actionGroupId ]
    }
  }
}

output storageAccountName string = intakeStorage.name
output incomingContainer string = incomingContainer
output quarantineContainer string = quarantineContainer
output deadletterContainer string = deadletterContainer
output intakeIdentityClientId string = intakeIdentity.properties.clientId
output intakeIdentityId string = intakeIdentity.id
