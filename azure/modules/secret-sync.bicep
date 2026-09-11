// The OpenShift secret sync: a second Flex Consumption Function app that copies mapped Key Vault
// secrets into OpenShift Secrets and rolls what reads them.
//
// A SEPARATE APP from demi-api-fc-<env> on purpose. It holds an OpenShift ServiceAccount token in
// memory for the length of a run, it scales to zero and runs a few times a day, and a bad deploy
// of it must not be able to take the API down. It shares the identity, the subnet and the vault,
// so it adds no network or policy surface — the same Flex pattern as api-function-flex.bicep.

@description('Location for the sync app resources')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Subnet for VNet integration. The SAME subnet as the API app: outbound to Key Vault goes through its private endpoint.')
param virtualNetworkSubnetId string

@description('Resource ID of demi-identity-<env>')
param identityId string

@description('Client ID of demi-identity-<env>. AZURE_CLIENT_ID, so DefaultAzureCredential picks it.')
param identityClientId string

@description('Principal ID of demi-identity-<env>. Granted the host roles on this app\'s own storage.')
param identityPrincipalId string

@description('Name of the vault this app reads. Used to hang the Event Grid system topic off it.')
param keyVaultName string

@description('Vault URI, e.g. https://demi-kv-test.vault.azure.net/')
param keyVaultUri string

@description('Comma list of OpenShift namespaces this app syncs, e.g. 6cdc9e-dev,6cdc9e-test. Empty is off.')
param syncNamespaces string = ''

@description('Kubernetes API server for the Silver cluster')
param openshiftApi string = 'https://api.silver.devops.gov.bc.ca:6443'

@description('Application Insights connection string. Empty leaves the app logging to stdout only.')
param appInsightsConnectionString string = ''

var syncAppName = 'demi-secret-sync-${environmentName}'
var appServicePlanName = 'demi-plan-ss-${environmentName}'
var storageAccountName = take('demiss${environmentName}${uniqueString(resourceGroup().id)}', 24)

// The name of the Event Grid trigger in src/secret-sync/index.js. A subscription pointed at a
// function name that does not exist is accepted at deploy and drops every event.
var eventGridFunctionName = 'secretSyncVaultEvent'

// Same three built-in data-plane roles the API app needs on its own storage, and for the same
// reason: AzureWebJobsStorage below is identity-based, so the host cannot start without them.
var blobDataOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var queueDataContributorRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var tableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

resource syncStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: syncStorage
  name: 'default'
}

// Flex Consumption publishes here rather than to a site filesystem — there is no Kudu wwwroot.
resource deployContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'deployment'
}

resource blobDataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: syncStorage
  name: guid(syncStorage.id, identityPrincipalId, blobDataOwnerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataOwnerRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource queueDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: syncStorage
  name: guid(syncStorage.id, identityPrincipalId, queueDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueDataContributorRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource tableDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: syncStorage
  name: guid(syncStorage.id, identityPrincipalId, tableDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributorRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// One app per plan: a Flex plan cannot be shared, so this app cannot join the API's.
resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  tags: tags
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true // Linux
  }
}

resource syncFunctionApp 'Microsoft.Web/sites@2024-11-01' = {
  name: syncAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    // The vault denies public network access, so every read goes through the private endpoint and
    // this app has to be inside the VNet to make one at all.
    virtualNetworkSubnetId: virtualNetworkSubnetId
    // The subnet must carry the landing-zone route table `openshift-public-endpoint`: hub BGP
    // advertises 142.34.0.0/16 and swallows OpenShift API (port 6443) traffic, and policy forbids
    // new route tables. This setting only forces all egress onto the VNet path so that route applies.
    outboundVnetRouting: {
      allTraffic: true
    }
    keyVaultReferenceIdentity: identityId
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${syncStorage.properties.primaryEndpoints.blob}${deployContainer.name}'
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: identityId
          }
        }
      }
      // Two instances is plenty for a job that runs on a vault event and once a day, and the cap
      // is what stops a burst of rotations from opening a burst of API-server sessions.
      scaleAndConcurrency: {
        maximumInstanceCount: 2
        instanceMemoryMB: 2048
        alwaysReady: []
      }
      runtime: {
        name: 'node'
        version: '22'
      }
    }
    siteConfig: {
      minTlsVersion: '1.2'
      // WHOLE-COLLECTION PUT, same as the API app: a setting that exists live but is absent here is
      // deleted by the next deploy, so everything the app reads is declared, empty included.
      appSettings: [
        {
          name: 'ENVIRONMENT'
          value: environmentName
        }
        {
          name: 'AzureWebJobsStorage__accountName'
          value: syncStorage.name
        }
        {
          name: 'AzureWebJobsStorage__credential'
          value: 'managedidentity'
        }
        {
          name: 'AzureWebJobsStorage__clientId'
          value: identityClientId
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsightsConnectionString
        }
        {
          name: 'APPLICATIONINSIGHTS_ENABLE_AGENT'
          value: 'false'
        }
        // DefaultAzureCredential has no way to choose between several user-assigned identities.
        {
          name: 'AZURE_CLIENT_ID'
          value: identityClientId
        }
        // Read directly with the Key Vault SDK, NOT as `@Microsoft.KeyVault(...)` references: the
        // names this app reads change with mapping.json, and app settings would have to be
        // redeployed for every secret added.
        {
          name: 'KEY_VAULT_URI'
          value: keyVaultUri
        }
        // Which namespaces of mapping.json this app owns. The nonprod app carries both nonprod
        // namespaces; prod carries only its own, and that separation is what keeps the nonprod
        // app's token out of production.
        {
          name: 'SYNC_NAMESPACES'
          value: syncNamespaces
        }
        {
          name: 'OPENSHIFT_API'
          value: openshiftApi
        }
        {
          name: 'AzureWebJobsFeatureFlags'
          value: 'EnableWorkerIndexing'
        }
        {
          name: 'WEBSITE_VNET_ROUTE_ALL'
          value: '1'
        }
        // THE LANDING ZONE'S resolver. With Azure's default the vault's privatelink name resolves
        // public and every read is refused by policy.
        {
          name: 'WEBSITE_DNS_SERVER'
          value: '10.53.244.4'
        }
      ]
    }
  }
}

resource syncScmBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: syncFunctionApp
  name: 'scm'
  properties: {
    allow: false
  }
}

resource syncFtpBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: syncFunctionApp
  name: 'ftp'
  properties: {
    allow: false
  }
}

// The vault this app watches. `existing` — key-vault.bicep owns it.
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// A system topic is how a vault's own events are subscribed to. One per vault; the name is derived
// so a redeploy re-uses it rather than creating a second.
resource vaultTopic 'Microsoft.EventGrid/systemTopics@2023-12-15-preview' = {
  name: 'evgt-${keyVaultName}'
  location: location
  tags: tags
  properties: {
    source: vault.id
    topicType: 'Microsoft.KeyVault.vaults'
  }
}

resource secretSyncSubscription 'Microsoft.EventGrid/systemTopics/eventSubscriptions@2023-12-15-preview' = {
  parent: vaultTopic
  name: 'secret-sync'
  properties: {
    destination: {
      endpointType: 'AzureFunction'
      properties: {
        resourceId: '${syncFunctionApp.id}/functions/${eventGridFunctionName}'
        // One event per invocation: the handler reconciles the whole mapping anyway, so batching
        // would only make several identical runs out of one.
        maxEventsPerBatch: 1
      }
    }
    filter: {
      // Only a new VERSION means the value changed. SecretNearExpiry and SecretExpired do not, and
      // the handler ignores them a second time in code.
      includedEventTypes: [
        'Microsoft.KeyVault.SecretNewVersionCreated'
      ]
    }
    retryPolicy: {
      maxDeliveryAttempts: 5
      eventTimeToLiveInMinutes: 60
    }
  }
}

output secretSyncAppName string = syncFunctionApp.name
output secretSyncStorageAccountName string = syncStorage.name
output secretSyncEventTopicName string = vaultTopic.name
