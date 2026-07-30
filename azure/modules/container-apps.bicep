// Azure Container Apps Module for Typesense Search Engine
@description('Location for Azure Container Apps')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Typesense Master API Key')
@secure()
param typesenseApiKey string

var storageAccountName = take('tsstg${environmentName}${uniqueString(resourceGroup().id)}', 24)
var fileShareName = 'typesense-data'
var containerAppEnvName = 'demi-ca-env-${environmentName}'
var containerAppName = 'demi-typesense-${environmentName}'

// Storage Account for Typesense persistent index data
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
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
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

// File Share for Typesense /data directory
resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  name: '${storageAccount.name}/default/${fileShareName}'
}

// Container Apps Environment
resource caEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: containerAppEnvName
  location: location
  tags: tags
  properties: {
    zoneRedundant: false
  }
}

// Environment Storage Link (Azure Files -> Container Apps Env)
resource caEnvStorage 'Microsoft.App/managedEnvironments/storages@2023-05-01' = {
  parent: caEnvironment
  name: 'typesense-volume'
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: fileShareName
      accessMode: 'ReadWrite'
    }
  }
}

// Typesense Container App
resource typesenseContainerApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: containerAppName
  location: location
  tags: tags
  dependsOn: [
    caEnvStorage
  ]
  properties: {
    managedEnvironmentId: caEnvironment.id
    configuration: {
      ingress: {
        external: false
        targetPort: 8108
        transport: 'auto'
      }
      secrets: [
        {
          name: 'typesense-api-key'
          value: typesenseApiKey
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'typesense'
          image: 'typesense/typesense:27.1'
          args: [
            '--data-dir'
            '/data'
            '--api-key'
            '$(TYPESENSE_API_KEY)'
          ]
          env: [
            {
              name: 'TYPESENSE_API_KEY'
              secretRef: 'typesense-api-key'
            }
          ]
          // Typesense holds its entire index in RAM, so this is sized by row count, not by load.
          // The chunk corpus is ~1.9M rows on the accumulating chunker (~4.7 G characters at
          // TARGET_CHUNK_SIZE 2500), which does not fit the 2 GiB this template used to declare —
          // and the live container had already been raised to 2/4 by hand, so deploying the old
          // values would have SHRUNK it.
          //
          // 4 vCPU / 8 GiB is the ceiling on a Consumption environment: the CPU:memory ratio is
          // locked at 1:2 and `demi-ca-env-dev` has no workload profiles. If the index outgrows
          // this, the lever is TARGET_CHUNK_SIZE (2500 -> 4000 takes ~1.9M rows to ~1.2M), not
          // more memory. Measure `typesense_memory_used_bytes` before assuming.
          resources: {
            cpu: json('4.0')
            memory: '8.0Gi'
          }
          volumeMounts: [
            {
              volumeName: 'typesense-storage'
              mountPath: '/data'
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'typesense-storage'
          storageType: 'AzureFile'
          storageName: 'typesense-volume'
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output typesenseFqdn string = typesenseContainerApp.properties.configuration.ingress.fqdn
output typesenseUrl string = 'https://${typesenseContainerApp.properties.configuration.ingress.fqdn}'
