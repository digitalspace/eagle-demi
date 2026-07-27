// Azure Static Web Apps Module for DEMI Angular Frontend UI (Serverless Host)
@description('Location for Azure Static Web App resources')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

var staticWebAppName = 'demi-frontend-swa-${environmentName}'

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: staticWebAppName
  location: location
  tags: tags
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    repositoryUrl: ''
    allowConfigFileUpdates: true
    provider: 'Custom'
    stagingEnvironmentPolicy: 'Enabled'
  }
}

output staticWebAppName string = staticWebApp.name
output staticWebAppDefaultHostname string = staticWebApp.properties.defaultHostname
output staticWebAppUrl string = 'https://${staticWebApp.properties.defaultHostname}'
