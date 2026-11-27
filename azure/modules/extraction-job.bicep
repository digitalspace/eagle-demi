// Docling extraction job: one execution per `extract` queue message, chunks posted to the API.
// Own identity: it may only read its API key and work the extraction queues.

@description('Location for the job resources')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Resource id of snet-demi-extract-<env>: a /27 delegated to Microsoft.App/environments, used by nothing else.')
param extractSubnetId string

@description('Container image of the job, pinned by digest (ghcr.io/...@sha256:...)')
param image string

@description('API base the job calls: the Flex host directly, since a large chunk POST outlives the APIM timeout')
param demiApiUrl string

@description('Name of the vault holding the job\'s API key')
param keyVaultName string

@description('Vault secret holding the job\'s DEMI API key. Must exist before deploy: the job resolves it at create.')
param apiKeySecretName string

@description('Storage account holding the extraction queues (the API Flex host account)')
param queueAccountName string

@description('Queue the API sends extraction messages to')
param queueName string = 'extract'

@description('Queue the job moves a message to after its third dequeue')
param poisonQueueName string = 'extract-poison'

@description('Deploy the T4 GPU job. Needs gpuImage and the ocr queue in the queue account.')
param deployExtractionGpu bool = false

@description('Queue the CPU job forwards OCR-route messages to when the GPU job is deployed')
param ocrQueueName string = 'extract-ocr'

@description('CUDA image of the GPU job, pinned by digest. Used only with deployExtractionGpu.')
param gpuImage string = ''

@description('Resource id of the Log Analytics workspace the job logs to')
param logsWorkspaceId string

@description('Resource id of demi-alerts-<env>')
param actionGroupId string

@description('Application Insights connection string. Empty leaves the job logging to stdout only.')
param appInsightsConnectionString string = ''

var environmentResourceName = 'demi-extract-env-${environmentName}'
var identityName = 'demi-extract-identity-${environmentName}'
var replicaTimeoutSeconds = 7200
// Longer than a replica may run, so a message is never handed to a second execution mid-run.
var visibilityTimeoutSeconds = replicaTimeoutSeconds + 600
var gpuProfileName = 'gpu-t4'
var apiKeySecretRef = 'demi-api-key'

var queueDataContributorRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

var queueNames = concat([queueName, poisonQueueName], deployExtractionGpu ? [ocrQueueName] : [])

var cpuJob = {
  name: 'demi-extract-cpu-${environmentName}'
  workloadProfileName: 'Consumption'
  image: image
  cpu: 4
  memory: '8Gi'
  queue: queueName
  ocrQueue: deployExtractionGpu ? ocrQueueName : ''
}
var gpuJob = {
  name: 'demi-extract-gpu-${environmentName}'
  workloadProfileName: gpuProfileName
  image: gpuImage
  cpu: 8
  memory: '56Gi'
  queue: ocrQueueName
  ocrQueue: ''
}
var jobs = deployExtractionGpu ? [cpuJob, gpuJob] : [cpuJob]

resource jobIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

resource queueAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: queueAccountName
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' existing = {
  parent: queueAccount
  name: 'default'
}

resource queues 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' existing = [for q in queueNames: {
  parent: queueService
  name: q
}]

// Per queue, not the account: the account also holds sync-out and the API host's own queues.
resource queueDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (q, i) in queueNames: {
  scope: queues[i]
  name: guid(queues[i].id, jobIdentity.id, queueDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueDataContributorRoleId)
    principalId: jobIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}]

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource apiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: vault
  name: apiKeySecretName
}

resource apiKeySecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: apiKeySecret
  name: guid(apiKeySecret.id, jobIdentity.id, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: jobIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource extractEnvironment 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: environmentResourceName
  location: location
  tags: tags
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: extractSubnetId
      internal: true
    }
    workloadProfiles: concat([
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ], deployExtractionGpu ? [
      {
        name: gpuProfileName
        workloadProfileType: 'Consumption-GPU-NC8as-T4'
      }
    ] : [])
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
    publicNetworkAccess: 'Disabled'
    zoneRedundant: false
  }
}

// Console output lands here too, so a job that dies before its App Insights handler starts still leaves a trace.
resource environmentLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: extractEnvironment
  properties: {
    workspaceId: logsWorkspaceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
  }
}

resource extractJob 'Microsoft.App/jobs@2025-07-01' = [for j in jobs: {
  name: j.name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${jobIdentity.id}': {}
    }
  }
  properties: {
    environmentId: extractEnvironment.id
    workloadProfileName: j.workloadProfileName
    configuration: {
      triggerType: 'Event'
      replicaTimeout: replicaTimeoutSeconds
      // A failed run leaves its message on the queue; the queue, not a replica retry, decides the next try.
      replicaRetryLimit: 0
      secrets: [
        {
          name: apiKeySecretRef
          keyVaultUrl: '${vault.properties.vaultUri}secrets/${apiKeySecretName}'
          identity: jobIdentity.id
        }
      ]
      eventTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
        scale: {
          minExecutions: 0
          maxExecutions: 4
          pollingInterval: 60
          rules: [
            {
              name: 'queue'
              type: 'azure-queue'
              metadata: {
                accountName: queueAccountName
                queueName: j.queue
                queueLength: '1'
              }
              identity: jobIdentity.id
            }
          ]
        }
      }
    }
    template: {
      containers: [
        {
          name: 'extract'
          image: j.image
          resources: {
            cpu: j.cpu
            memory: j.memory
          }
          env: [
            {
              name: 'DEMI_API'
              value: demiApiUrl
            }
            {
              name: 'DEMI_ADMIN_KEY'
              secretRef: apiKeySecretRef
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: jobIdentity.properties.clientId
            }
            {
              name: 'EXTRACTION_QUEUE_ACCOUNT'
              value: queueAccountName
            }
            {
              name: 'EXTRACTION_QUEUE'
              value: j.queue
            }
            {
              name: 'EXTRACTION_POISON_QUEUE'
              value: poisonQueueName
            }
            {
              name: 'EXTRACTION_OCR_QUEUE'
              value: j.ocrQueue
            }
            {
              name: 'EXTRACTION_VISIBILITY_SECONDS'
              value: string(visibilityTimeoutSeconds)
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsightsConnectionString
            }
          ]
        }
      ]
    }
  }
  // The Key Vault reference and the queue scaler both fail until the grants exist.
  dependsOn: [
    apiKeySecretsUser
    queueDataContributor
  ]
}]

// The job logs this line once per message it gives up on, so one line is one document left unextracted.
resource poisonAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = {
  name: 'demi-extract-poison-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI extraction moved a message to poison'
    description: 'An extraction job execution failed three times on one document and moved its message to ${poisonQueueName} on ${queueAccountName}. The document stays without chunks until the message is requeued.'
    severity: 2
    enabled: true
    scopes: [ logsWorkspaceId ]
    evaluationFrequency: 'PT15M'
    // Same as the frequency, so one message is not counted twice.
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message contains "[extraction] poison"'
          timeAggregation: 'Count'
          operator: 'GreaterThanOrEqual'
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

output extractEnvironmentName string = extractEnvironment.name
output extractJobNames array = [for (j, i) in jobs: extractJob[i].name]
output extractIdentityPrincipalId string = jobIdentity.properties.principalId
