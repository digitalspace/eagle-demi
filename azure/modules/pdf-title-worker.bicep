// The PDF title worker: a timer-triggered Python Flex app that runs `pdf-title/run.py` against the
// API. Its own identity, not demi-identity: that one reads every vault secret and writes Cosmos,
// and this app needs only its host storage and one secret.

@description('Location for the worker resources')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Subnet for VNet integration. The API app\'s subnet: the vault is reached only through its private endpoint.')
param virtualNetworkSubnetId string

@description('Name of the vault holding the worker\'s API key')
param keyVaultName string

@description('Vault secret holding the worker\'s DEMI API key')
param apiKeySecretName string

@description('API base the worker calls, e.g. https://<api host>/api')
param demiApiUrl string

@description('NCRONTAB schedule of the timer, e.g. 0 */10 * * * *')
param schedule string

@description('True lets the worker write; false lists the work and writes nothing')
param live bool

@description('Rows taken from the work list per run')
param maxRows int

@description('Minutes after which a run starts no new row')
param maxMinutes int

@description('Application Insights connection string. Empty leaves the app logging to stdout only.')
param appInsightsConnectionString string = ''

var appName = 'demi-pdf-title-${environmentName}'
var appServicePlanName = 'demi-plan-pt-${environmentName}'
var identityName = 'demi-pdf-title-identity-${environmentName}'
var storageAccountName = take('demipt${environmentName}${uniqueString(resourceGroup().id)}', 24)

var blobDataOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var queueDataContributorRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var tableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

resource workerStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
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
  parent: workerStorage
  name: 'default'
}

resource deployContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'deployment'
}

// AzureWebJobsStorage is identity-based, so the host cannot start without all three.
resource blobDataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: workerStorage
  name: guid(workerStorage.id, workerIdentity.id, blobDataOwnerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataOwnerRoleId)
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource queueDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: workerStorage
  name: guid(workerStorage.id, workerIdentity.id, queueDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueDataContributorRoleId)
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource tableDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: workerStorage
  name: guid(workerStorage.id, workerIdentity.id, tableDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributorRoleId)
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// The secret is set by hand before deploy (deploy-infra.sh checks), so this scope exists.
resource apiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: vault
  name: apiKeySecretName
}

resource apiKeySecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: apiKeySecret
  name: guid(apiKeySecret.id, workerIdentity.id, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

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

resource workerApp 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${workerIdentity.id}': {}
    }
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    virtualNetworkSubnetId: virtualNetworkSubnetId
    keyVaultReferenceIdentity: workerIdentity.id
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${workerStorage.properties.primaryEndpoints.blob}${deployContainer.name}'
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: workerIdentity.id
          }
        }
      }
      // A timer runs on one instance anyway; the cap keeps this app to one address of the shared subnet.
      scaleAndConcurrency: {
        maximumInstanceCount: 1
        instanceMemoryMB: 2048
        alwaysReady: []
      }
      runtime: {
        name: 'python'
        version: '3.11'
      }
    }
    siteConfig: {
      minTlsVersion: '1.2'
      // Whole-collection PUT: a setting absent here is deleted by the next deploy.
      appSettings: [
        {
          name: 'AzureWebJobsStorage__accountName'
          value: workerStorage.name
        }
        {
          name: 'AzureWebJobsStorage__credential'
          value: 'managedidentity'
        }
        {
          name: 'AzureWebJobsStorage__clientId'
          value: workerIdentity.properties.clientId
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsightsConnectionString
        }
        {
          name: 'DEMI_API_URL'
          value: demiApiUrl
        }
        // VaultName/SecretName: the secret is created out of band, so no module outputs its URI.
        {
          name: 'DEMI_API_KEY'
          value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=${apiKeySecretName})'
        }
        {
          name: 'PDF_TITLE_SCHEDULE'
          value: schedule
        }
        {
          name: 'PDF_TITLE_LIVE'
          // Not string(live): ARM renders a bool as 'True'.
          value: live ? 'true' : 'false'
        }
        {
          name: 'PDF_TITLE_MAX_ROWS'
          value: string(maxRows)
        }
        {
          name: 'PDF_TITLE_MAX_MINUTES'
          value: string(maxMinutes)
        }
        {
          name: 'PDF_TITLE_CONCURRENCY'
          value: '4'
        }
        {
          name: 'WEBSITE_VNET_ROUTE_ALL'
          value: '1'
        }
        // The landing zone's resolver; Azure's default resolves the vault's privatelink name public.
        {
          name: 'WEBSITE_DNS_SERVER'
          value: '10.53.244.4'
        }
      ]
    }
  }
  // The host and the Key Vault reference both fail until the grants exist.
  dependsOn: [
    blobDataOwner
    queueDataContributor
    tableDataContributor
    apiKeySecretsUser
  ]
}

resource workerScmBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: workerApp
  name: 'scm'
  properties: {
    allow: false
  }
}

resource workerFtpBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: workerApp
  name: 'ftp'
  properties: {
    allow: false
  }
}

output pdfTitleWorkerAppName string = workerApp.name
output pdfTitleWorkerStorageAccountName string = workerStorage.name
