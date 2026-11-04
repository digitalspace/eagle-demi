// Hourly timer (`secretRotatorHourly`) that rotates the self-minted secrets and renews the rest. Own
// identity, not demi-identity: it holds Secrets Officer on the vault, and nothing else may run as it.

@description('Location for the rotator resources')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Subnet for VNet integration. The SAME subnet as the API app: the vault is reached through its private endpoint.')
param virtualNetworkSubnetId string

@description('Name of the vault this app rotates')
param keyVaultName string

@description('Vault URI, e.g. https://demi-kv-test.vault.azure.net/')
param keyVaultUri string

@description('ROTATED_SECRETS: comma list of name:stamper:probe. Empty, with renew off, is the kill switch.')
param rotationTargets string = ''

@description('RENEW: extend the expiry of every other enabled secret before it lapses.')
param renew bool = false

@description('EDGE_RULE_IDS: comma list of the Front Door stampedgesecret rule ids the frontdoor stamper rewrites.')
param edgeRuleIds string = ''

@description('PROBE_DEMI_URL: the DEMI /health/trust URL, reached through Front Door.')
param probeDemiUrl string = ''

@description('PROBE_ANALYTICS_URL: the analytics /events URL, reached through Front Door.')
param probeAnalyticsUrl string = ''

@description('ISSUER_EXPIRY: comma list of name=YYYY-MM-DD for secrets whose issuer sets the real expiry.')
param issuerExpiry string = ''

@description('Resource id of the Log Analytics workspace the app logs to')
param logsWorkspaceId string

@description('Resource id of demi-alerts-<env>')
param actionGroupId string

@description('Application Insights connection string. Empty leaves the app logging to stdout only.')
param appInsightsConnectionString string = ''

var appName = 'demi-secret-rotator-${environmentName}'
var appServicePlanName = 'demi-plan-sr-${environmentName}'
var identityName = 'demi-rotator-identity-${environmentName}'
var storageAccountName = take('demisr${environmentName}${uniqueString(resourceGroup().id)}', 24)

var blobDataOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var queueDataContributorRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var tableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
// Vault scope: renew touches almost every name, and the -standby names do not exist before the first mint.
var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource rotatorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

resource rotatorStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
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

// Opt out: new accounts inherit the subscription Defender for Storage plan (about 0.63 CAD a day each). Set isEnabled true to turn it back on for this account.
resource defenderForStorage 'Microsoft.Security/defenderForStorageSettings@2025-06-01' = {
  name: 'current'
  scope: rotatorStorage
  properties: {
    isEnabled: false
    overrideSubscriptionLevelSettings: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: rotatorStorage
  name: 'default'
}

resource deployContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'deployment'
}

resource blobDataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: rotatorStorage
  name: guid(rotatorStorage.id, rotatorIdentity.id, blobDataOwnerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataOwnerRoleId)
    principalId: rotatorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource queueDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: rotatorStorage
  name: guid(rotatorStorage.id, rotatorIdentity.id, queueDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueDataContributorRoleId)
    principalId: rotatorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource tableDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: rotatorStorage
  name: guid(rotatorStorage.id, rotatorIdentity.id, tableDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributorRoleId)
    principalId: rotatorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource secretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, rotatorIdentity.id, keyVaultSecretsOfficerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsOfficerRoleId)
    principalId: rotatorIdentity.properties.principalId
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

resource rotatorApp 'Microsoft.Web/sites@2024-11-01' = {
  name: appName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${rotatorIdentity.id}': {}
    }
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    virtualNetworkSubnetId: virtualNetworkSubnetId
    outboundVnetRouting: {
      allTraffic: true
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${rotatorStorage.properties.primaryEndpoints.blob}${deployContainer.name}'
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: rotatorIdentity.id
          }
        }
      }
      // One instance: two runs at once would both read the same stage tag and both write the next version.
      scaleAndConcurrency: {
        maximumInstanceCount: 1
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
      // Whole-collection PUT: a setting absent here is deleted by the next deploy.
      appSettings: [
        {
          name: 'ENVIRONMENT'
          value: environmentName
        }
        {
          name: 'AzureWebJobsStorage__accountName'
          value: rotatorStorage.name
        }
        {
          name: 'AzureWebJobsStorage__credential'
          value: 'managedidentity'
        }
        {
          name: 'AzureWebJobsStorage__clientId'
          value: rotatorIdentity.properties.clientId
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsightsConnectionString
        }
        {
          name: 'APPLICATIONINSIGHTS_ENABLE_AGENT'
          value: 'false'
        }
        {
          name: 'AZURE_CLIENT_ID'
          value: rotatorIdentity.properties.clientId
        }
        {
          name: 'KEY_VAULT_URI'
          value: keyVaultUri
        }
        {
          name: 'ROTATED_SECRETS'
          value: rotationTargets
        }
        {
          name: 'RENEW'
          // Empty, not 'false': the app reads only 'true' as on.
          value: renew ? 'true' : ''
        }
        {
          name: 'EDGE_RULE_IDS'
          value: edgeRuleIds
        }
        {
          name: 'PROBE_DEMI_URL'
          value: probeDemiUrl
        }
        {
          name: 'PROBE_ANALYTICS_URL'
          value: probeAnalyticsUrl
        }
        {
          name: 'ISSUER_EXPIRY'
          value: issuerExpiry
        }
        {
          name: 'AzureWebJobsFeatureFlags'
          value: 'EnableWorkerIndexing'
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
  // The host cannot start until it can reach its own storage.
  dependsOn: [
    blobDataOwner
    queueDataContributor
    tableDataContributor
  ]
}

resource rotatorScmBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: rotatorApp
  name: 'scm'
  properties: {
    allow: false
  }
}

resource rotatorFtpBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: rotatorApp
  name: 'ftp'
  properties: {
    allow: false
  }
}

// A secret stuck in stage failed logs FAILED every run; autoMitigate keeps that to one mail until it clears.
resource failedAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = {
  name: 'demi-secret-rotator-failed-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI secret rotator failed, or an issuer expiry is near'
    description: 'secretRotatorHourly in ${appName} logged "[secret-rotator] FAILED" (a rotation step failed; both values stay accepted) or "[secret-rotator] issuer-expiry" (an issuer-owned secret in ISSUER_EXPIRY expires within 30 days and needs a new value by hand). Read the AppTraces line for the secret name.'
    severity: 1
    enabled: true
    scopes: [ logsWorkspaceId ]
    evaluationFrequency: 'PT1H'
    windowSize: 'PT1H'
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message contains "[secret-rotator] FAILED" or Message contains "[secret-rotator] issuer-expiry"'
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
}

// 26 h, so one missed hourly run or a slow cold start does not page. A window is not 26 h, so the
// query narrows a 2-day window itself. Not gated: it fires if the code deploy lags this module.
resource silentAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = {
  name: 'demi-secret-rotator-silent-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI secret rotator has not finished a run for 26 hours'
    description: 'No "[secret-rotator] run finished" line in 26 hours from secretRotatorHourly in ${appName}. Nothing is being rotated or renewed, and the FAILED alert cannot fire. Check the function is registered and KEY_VAULT_URI is set.'
    severity: 1
    enabled: true
    scopes: [ logsWorkspaceId ]
    evaluationFrequency: 'PT1H'
    windowSize: 'P2D'
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where TimeGenerated > ago(26h) | where Message contains "[secret-rotator] run finished"'
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

output secretRotatorAppName string = rotatorApp.name
output principalId string = rotatorIdentity.properties.principalId
