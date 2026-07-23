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
        external: true
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
            '--enable-cors'
          ]
          env: [
            {
              name: 'TYPESENSE_API_KEY'
              secretRef: 'typesense-api-key'
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
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
        minReplicas: 0 // Scale to 0 when idle ($0 cost)
        maxReplicas: 1
      }
    }
  }
}

output typesenseFqdn string = typesenseContainerApp.properties.configuration.ingress.fqdn
output typesenseUrl string = 'https://${typesenseContainerApp.properties.configuration.ingress.fqdn}'
